use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::runtime::Builder;
use tokio::sync::oneshot;
use tokio::task::LocalSet;
use tauri_plugin_autostart::MacosLauncher;
use tur_rs::{
    DownloadHandle, DownloadRequest, DownloadStatus, DownloadUpdate, RequestContext,
    ServiceConfig, TurService,
};

const DOWNLOAD_EVENT: &str = "download-update";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadItem {
    id: String,
    url: String,
    filename: String,
    directory: String,
    downloaded_bytes: u64,
    total_size: u64,
    speed_bps: f64,
    progress: f64,
    status: String,
    error_message: Option<String>,
    created_at_ms: u64,
}

impl DownloadItem {
    fn new(id: String, url: String, filename: String, directory: String) -> Self {
        Self {
            id,
            url,
            filename,
            directory,
            downloaded_bytes: 0,
            total_size: 0,
            speed_bps: 0.0,
            progress: 0.0,
            status: "queued".into(),
            error_message: None,
            created_at_ms: now_ms(),
        }
    }

    fn apply_update(&mut self, update: &DownloadUpdate) {
        match update {
            DownloadUpdate::Progress {
                downloaded_bytes,
                speed_bps,
            } => {
                self.downloaded_bytes = *downloaded_bytes;
                self.speed_bps = *speed_bps;
                self.status = "downloading".into();
                if self.total_size > 0 {
                    self.progress =
                        (*downloaded_bytes as f64 / self.total_size as f64).clamp(0.0, 1.0);
                }
            }
            DownloadUpdate::TotalSize(size) => {
                self.total_size = *size;
                if self.total_size > 0 {
                    self.progress =
                        (self.downloaded_bytes as f64 / self.total_size as f64).clamp(0.0, 1.0);
                }
            }
            DownloadUpdate::StatusChanged(status) => {
                let (label, message) = status_parts(status);
                self.status = label.into();
                self.error_message = message;
                if matches!(status, DownloadStatus::Completed) {
                    self.progress = 1.0;
                    self.speed_bps = 0.0;
                }
                if matches!(
                    status,
                    DownloadStatus::Paused | DownloadStatus::Stopped | DownloadStatus::Error(_)
                ) {
                    self.speed_bps = 0.0;
                }
            }
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeaderFieldInput {
    name: String,
    value: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartDownloadInput {
    urls: Vec<String>,
    directory: String,
    filename: Option<String>,
    referer: Option<String>,
    bearer_token: Option<String>,
    cookie_file: Option<String>,
    headers: Option<Vec<HeaderFieldInput>>,
}

enum ServiceCommand {
    Start {
        input: StartDownloadInput,
        response_tx: oneshot::Sender<Result<Vec<DownloadItem>, String>>,
    },
    Pause {
        id: String,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    Resume {
        id: String,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        id: String,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Clone)]
struct AppState {
    command_tx: mpsc::Sender<ServiceCommand>,
    snapshots: Arc<Mutex<HashMap<String, DownloadItem>>>,
}

impl AppState {
    fn new(app: AppHandle) -> Result<Self, String> {
        let snapshots = Arc::new(Mutex::new(HashMap::<String, DownloadItem>::new()));
        let (command_tx, command_rx) = mpsc::channel::<ServiceCommand>();
        let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();
        let thread_snapshots = snapshots.clone();

        thread::Builder::new()
            .name("tur-service-thread".into())
            .spawn(move || {
                let runtime = match Builder::new_current_thread().enable_all().build() {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        let _ = startup_tx.send(Err(format!("failed to create runtime: {err}")));
                        return;
                    }
                };
                let local = LocalSet::new();
                runtime.block_on(local.run_until(async move {
                    let service = match TurService::new(ServiceConfig::default()).await {
                        Ok(service) => {
                            let _ = startup_tx.send(Ok(()));
                            service
                        }
                        Err(err) => {
                            let _ = startup_tx.send(Err(format!(
                                "failed to start download service: {err}"
                            )));
                            return;
                        }
                    };
                    run_service_loop(service, command_rx, thread_snapshots, app).await;
                }));
            })
            .map_err(|err| format!("failed to spawn service thread: {err}"))?;

        startup_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "timed out while starting download service".to_string())??;

        Ok(Self {
            command_tx,
            snapshots,
        })
    }
}

#[tauri::command]
async fn start_download(
    state: State<'_, AppState>,
    input: StartDownloadInput,
) -> Result<Vec<DownloadItem>, String> {
    let (response_tx, response_rx) = oneshot::channel();
    state
        .command_tx
        .send(ServiceCommand::Start { input, response_tx })
        .map_err(|_| "download service is unavailable".to_string())?;
    response_rx
        .await
        .map_err(|_| "download service did not respond".to_string())?
}

#[tauri::command]
async fn pause_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    control_download(&state.command_tx, ServiceCommandKind::Pause, id).await
}

#[tauri::command]
async fn resume_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    control_download(&state.command_tx, ServiceCommandKind::Resume, id).await
}

#[tauri::command]
async fn cancel_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    control_download(&state.command_tx, ServiceCommandKind::Cancel, id).await
}

#[tauri::command]
fn list_downloads(state: State<'_, AppState>) -> Result<Vec<DownloadItem>, String> {
    let snapshots = state
        .snapshots
        .lock()
        .map_err(|_| "download state is poisoned".to_string())?;
    let mut rows = snapshots.values().cloned().collect::<Vec<_>>();
    rows.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(rows)
}

#[tauri::command]
fn import_download_links(path: String) -> Result<Vec<String>, String> {
    let contents =
        std::fs::read_to_string(&path).map_err(|err| format!("failed to read link file: {err}"))?;
    Ok(parse_download_links(&contents))
}

#[derive(Clone, Copy)]
enum ServiceCommandKind {
    Pause,
    Resume,
    Cancel,
}

async fn control_download(
    command_tx: &mpsc::Sender<ServiceCommand>,
    kind: ServiceCommandKind,
    id: String,
) -> Result<(), String> {
    let (response_tx, response_rx) = oneshot::channel();
    let command = match kind {
        ServiceCommandKind::Pause => ServiceCommand::Pause { id, response_tx },
        ServiceCommandKind::Resume => ServiceCommand::Resume { id, response_tx },
        ServiceCommandKind::Cancel => ServiceCommand::Cancel { id, response_tx },
    };
    command_tx
        .send(command)
        .map_err(|_| "download service is unavailable".to_string())?;
    response_rx
        .await
        .map_err(|_| "download service did not respond".to_string())?
}

async fn run_service_loop(
    service: TurService,
    command_rx: mpsc::Receiver<ServiceCommand>,
    snapshots: Arc<Mutex<HashMap<String, DownloadItem>>>,
    app: AppHandle,
) {
    let mut handles = HashMap::<String, DownloadHandle>::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(150));
    let mut disconnected = false;

    loop {
        loop {
            match command_rx.try_recv() {
                Ok(command) => {
                    handle_service_command(command, &service, &mut handles, &snapshots, &app).await;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        if disconnected {
            break;
        }

        poll_updates(&mut handles, &snapshots, &app);
        ticker.tick().await;
    }

    service.shutdown().await;
}

async fn handle_service_command(
    command: ServiceCommand,
    service: &TurService,
    handles: &mut HashMap<String, DownloadHandle>,
    snapshots: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    app: &AppHandle,
) {
    match command {
        ServiceCommand::Start { input, response_tx } => {
            let result = start_download_inner(service, handles, snapshots, app, input).await;
            let _ = response_tx.send(result);
        }
        ServiceCommand::Pause { id, response_tx } => {
            let result = if let Some(handle) = handles.get(&id) {
                handle.pause().await;
                Ok(())
            } else {
                Err(format!("download {id} was not found"))
            };
            let _ = response_tx.send(result);
        }
        ServiceCommand::Resume { id, response_tx } => {
            let result = if let Some(handle) = handles.get(&id) {
                handle.resume().await;
                Ok(())
            } else {
                Err(format!("download {id} was not found"))
            };
            let _ = response_tx.send(result);
        }
        ServiceCommand::Cancel { id, response_tx } => {
            let result = if let Some(handle) = handles.get(&id) {
                handle.cancel().await;
                Ok(())
            } else {
                Err(format!("download {id} was not found"))
            };
            let _ = response_tx.send(result);
        }
    }
}

async fn start_download_inner(
    service: &TurService,
    handles: &mut HashMap<String, DownloadHandle>,
    snapshots: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    app: &AppHandle,
    input: StartDownloadInput,
) -> Result<Vec<DownloadItem>, String> {
    let StartDownloadInput {
        urls,
        directory,
        filename,
        referer,
        bearer_token,
        cookie_file,
        headers,
    } = input;

    let urls = urls
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return Err("provide at least one valid URL".into());
    }
    let single_url = urls.len() == 1;

    let mut context = RequestContext::new();
    let mut has_context = false;

    if let Some(value) = referer.filter(|value| !value.trim().is_empty()) {
        context = context.referer(value);
        has_context = true;
    }
    if let Some(token) = bearer_token.filter(|value| !value.trim().is_empty()) {
        context = context.auth(format!("Bearer {token}"));
        has_context = true;
    }
    if let Some(header_list) = headers {
        for header in header_list {
            if !header.name.trim().is_empty() && !header.value.trim().is_empty() {
                context = context.header(header.name, header.value);
                has_context = true;
            }
        }
    }

    if let Some(path) = cookie_file
        .map(PathBuf::from)
        .filter(|value| !value.as_os_str().is_empty())
    {
        service
            .import_cookie_file(&path)
            .await
            .map_err(|err| format!("failed to import cookie file: {err}"))?;
    }

    let mut started = Vec::with_capacity(urls.len());

    for url in urls {
        let mut request = DownloadRequest::new(url.clone()).dir(PathBuf::from(&directory));
        if let Some(name) = filename
            .clone()
            .filter(|value| !value.trim().is_empty() && single_url)
        {
            request = request.filename(name);
        }
        if has_context {
            request = request.context(context.clone());
        }

        let handle = service
            .add_download(request)
            .await
            .map_err(|err| format!("failed to start download: {err}"))?;

        let id = handle.id.to_string();
        let row = DownloadItem::new(
            id.clone(),
            url.clone(),
            filename
                .clone()
                .filter(|value| !value.trim().is_empty() && single_url)
                .unwrap_or_else(|| derive_filename(&url)),
            directory.clone(),
        );

        handles.insert(id.clone(), handle);
        snapshots
            .lock()
            .map_err(|_| "download state is poisoned".to_string())?
            .insert(id.clone(), row.clone());
        let _ = app.emit(DOWNLOAD_EVENT, row.clone());
        started.push(row);
    }

    Ok(started)
}

fn poll_updates(
    handles: &mut HashMap<String, DownloadHandle>,
    snapshots: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    app: &AppHandle,
) {
    let mut finished = Vec::new();
    let keys = handles.keys().cloned().collect::<Vec<_>>();

    for id in keys {
        let Some(handle) = handles.get_mut(&id) else {
            continue;
        };
        loop {
            match handle.try_recv() {
                Ok(update) => {
                    let mut should_drop_handle = false;
                    if let Ok(mut guard) = snapshots.lock() {
                        if let Some(row) = guard.get_mut(&id) {
                            row.apply_update(&update);
                            let snapshot = row.clone();
                            if matches!(
                                update,
                                DownloadUpdate::StatusChanged(DownloadStatus::Completed)
                                    | DownloadUpdate::StatusChanged(DownloadStatus::Error(_))
                            ) {
                                should_drop_handle = true;
                            }
                            let _ = app.emit(DOWNLOAD_EVENT, snapshot);
                        }
                    }
                    if should_drop_handle {
                        finished.push(id.clone());
                        break;
                    }
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    finished.push(id.clone());
                    break;
                }
            }
        }
    }

    for id in finished {
        handles.remove(&id);
    }
}

fn derive_filename(url: &str) -> String {
    url.split('/')
        .next_back()
        .filter(|segment| !segment.is_empty())
        .unwrap_or("download.bin")
        .to_string()
}

fn parse_download_links(contents: &str) -> Vec<String> {
    contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("//"))
        .map(ToOwned::to_owned)
        .collect()
}

fn status_parts(status: &DownloadStatus) -> (&'static str, Option<String>) {
    match status {
        DownloadStatus::Queued => ("queued", None),
        DownloadStatus::Downloading => ("downloading", None),
        DownloadStatus::Paused => ("paused", None),
        DownloadStatus::Stopped => ("stopped", None),
        DownloadStatus::Completed => ("completed", None),
        DownloadStatus::Error(message) => ("error", Some(message.clone())),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = AppState::new(app.handle().clone()).map_err(|err| {
                let io_err = std::io::Error::new(std::io::ErrorKind::Other, err);
                Box::<dyn std::error::Error>::from(io_err)
            })?;
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&'static str>>,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            start_download,
            import_download_links,
            pause_download,
            resume_download,
            cancel_download,
            list_downloads
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
