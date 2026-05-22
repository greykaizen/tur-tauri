use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tokio::runtime::Builder;
use tokio::sync::oneshot;
use tokio::task::LocalSet;
use tauri_plugin_autostart::MacosLauncher;
use tur_rs::{
    CookieEntry, DownloadRequest, DownloadStatus, DownloadUpdate, RequestContext, WorkerSnapshot
};

mod db;
mod engines;
mod plugins;
mod task_manager;

const DOWNLOAD_EVENT: &str = "download-update";

const SNAPSHOT_FILE_NAME: &str = "downloads-state.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub directory: String,
    pub engine_id: String, // e.g. "tur", "aria2c"
    pub plugins: Vec<String>, // e.g. ["yt-dlp"]
    pub downloaded_bytes: u64,
    pub total_size: u64,
    pub speed_bps: f64,
    pub progress: f64,
    pub status: String,
    pub protocol: String,
    pub error_message: Option<String>,
    pub created_at_ms: u64,
    pub worker_snapshots: Vec<WorkerSnapshot>,
}

impl DownloadItem {
    pub fn new(id: String, url: String, filename: String, directory: String, engine_id: String, plugins: Vec<String>) -> Self {
        Self {
            id,
            url,
            filename,
            directory,
            engine_id,
            plugins,
            downloaded_bytes: 0,
            total_size: 0,
            speed_bps: 0.0,
            progress: 0.0,
            status: "queued".into(),
            protocol: "auto".into(),
            error_message: None,
            created_at_ms: now_ms(),
            worker_snapshots: Vec::new(),
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
            DownloadUpdate::Workers(workers) => {
                self.worker_snapshots = workers.clone();
            }
            DownloadUpdate::Protocol(info) => {
                self.protocol = info.display_label();
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
    engine_id: Option<String>,
    plugins: Option<Vec<String>>,
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
    Remove {
        id: String,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
    Retry {
        id: String,
        response_tx: oneshot::Sender<Result<(), String>>,
    },
}

#[derive(Clone)]
struct AppState {
    command_tx: mpsc::Sender<ServiceCommand>,
    snapshots: Arc<Mutex<HashMap<String, DownloadItem>>>,
    db: Arc<db::Db>,
}

impl AppState {
    fn new(app: AppHandle) -> Result<Self, String> {
        let db_path = db_store_path(&app)?;
        let db = Arc::new(db::Db::new(db_path).map_err(|e| format!("DB init failed: {e}"))?);
        let items = db.load_all_downloads().unwrap_or_default();
        let mut map = HashMap::new();
        for item in items {
            map.insert(item.id.clone(), item);
        }
        let snapshots = Arc::new(Mutex::new(map));
        let (command_tx, command_rx) = mpsc::channel::<ServiceCommand>();
        let (startup_tx, startup_rx) = mpsc::channel::<Result<(), String>>();
        let thread_snapshots = snapshots.clone();
        let thread_db = db.clone();

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
                    let (update_tx, update_rx) = tokio::sync::mpsc::channel(100);
                    let task_manager = match task_manager::TaskManager::new(update_tx).await {
                        Ok(manager) => {
                            let _ = startup_tx.send(Ok(()));
                            manager
                        }
                        Err(err) => {
                            let _ = startup_tx.send(Err(format!(
                                "failed to start task manager: {err}"
                            )));
                            return;
                        }
                    };
                    run_service_loop(
                        task_manager,
                        command_rx,
                        update_rx,
                        thread_snapshots,
                        thread_db,
                        app,
                    )
                    .await;
                }));
            })
            .map_err(|err| format!("failed to spawn service thread: {err}"))?;

        startup_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "timed out while starting download service".to_string())??;

        Ok(Self {
            command_tx,
            snapshots,
            db,
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
async fn remove_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (tx, rx) = oneshot::channel();
    state
        .command_tx
        .send(ServiceCommand::Remove {
            id: id.clone(),
            response_tx: tx,
        })
        .map_err(|_| "failed to send command".to_string())?;
    rx.await.map_err(|_| "failed to receive response".to_string())??;
    Ok(())
}

#[tauri::command]
async fn retry_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    control_download(&state.command_tx, ServiceCommandKind::Retry, id).await
}

#[tauri::command]
async fn clear_completed(state: State<'_, AppState>) -> Result<(), String> {
    let mut keys = Vec::new();
    {
        let snapshots = state
            .snapshots
            .lock()
            .map_err(|_| "download state is poisoned".to_string())?;
        for (k, v) in snapshots.iter() {
            if matches!(v.status.as_str(), "completed" | "error" | "stopped") {
                keys.push(k.clone());
            }
        }
    }
    {
        let mut snapshots = state
            .snapshots
            .lock()
            .map_err(|_| "download state is poisoned".to_string())?;
        for id in &keys {
            snapshots.remove(id);
            let _ = state.db.delete_download(id);
        }
    }
    Ok(())
}

#[tauri::command]
async fn open_download_folder(path: String) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        return Err(format!("path does not exist: {}", path));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("failed to open folder: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("failed to open folder: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("failed to open folder: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn open_download_file(directory: String, filename: String) -> Result<(), String> {
    let path = std::path::Path::new(&directory).join(&filename);
    let file = path.as_path();
    if !file.exists() {
        return Err(format!("file does not exist: {}", file.display()));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(file)
            .spawn()
            .map_err(|e| format!("failed to open file: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(file)
            .spawn()
            .map_err(|e| format!("failed to open file: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path.display().to_string()])
            .spawn()
            .map_err(|e| format!("failed to open file: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn get_download(state: State<'_, AppState>, id: String) -> Result<DownloadItem, String> {
    let snapshots = state
        .snapshots
        .lock()
        .map_err(|_| "download state is poisoned".to_string())?;
    snapshots
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("download {id} was not found"))
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
async fn open_instance_window(app: AppHandle, state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    let label = format!("download-instance:{task_id}");

    // If window already exists, show and focus it
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| format!("failed to show window: {e}"))?;
        window.set_focus().map_err(|e| format!("failed to focus window: {e}"))?;
        return Ok(());
    }

    // Get task info for window title
    let task_title = {
        let snapshots = state
            .snapshots
            .lock()
            .map_err(|_| "download state is poisoned".to_string())?;
        snapshots
            .get(&task_id)
            .map(|item| item.filename.clone())
            .unwrap_or_else(|| "Download".to_string())
    };

    // Create a new instance window
    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App("index.html".into()),
    )
    .title(format!("Tur — {task_title}"))
    .inner_size(728.0, 478.0)
    .min_inner_size(600.0, 250.0)
    .resizable(true)
    .decorations(false)
    .build()
    .map_err(|e| format!("failed to create download window: {e}"))?;

    Ok(())
}

#[tauri::command]
fn resize_instance_window(window: tauri::Window, width: f64, height: f64) {
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_confirmation_window(app: tauri::AppHandle, id: Option<String>) -> Result<(), String> {
    let window_id = id.unwrap_or_else(|| {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis().to_string()
    });
    let label = format!("download-confirmation:{window_id}");
    
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Tur — Download File Info")
        .inner_size(500.0, 400.0)
        .min_inner_size(400.0, 280.0)
        .resizable(false)
        .decorations(false)
        .build()
        .map_err(|e| format!("failed to create confirmation window: {e}"))?;
        
    Ok(())
}

#[tauri::command]
fn open_completion_window(app: tauri::AppHandle, task_id: String) -> Result<(), String> {
    let label = format!("download-completion:{task_id}");
    
    // Prevent spawning multiple completion windows for the same task
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Tur — Download complete")
        .inner_size(400.0, 310.0)
        .min_inner_size(400.0, 310.0)
        .resizable(false)
        .decorations(false)
        .build()
        .map_err(|e| format!("failed to create completion window: {e}"))?;
        
    Ok(())
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
    Remove,
    Retry,
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
        ServiceCommandKind::Remove => ServiceCommand::Remove { id, response_tx },
        ServiceCommandKind::Retry => ServiceCommand::Retry { id, response_tx },
    };
    command_tx
        .send(command)
        .map_err(|_| "download service is unavailable".to_string())?;
    response_rx
        .await
        .map_err(|_| "download service did not respond".to_string())?
}

async fn run_service_loop(
    mut task_manager: task_manager::TaskManager,
    mut command_rx: mpsc::Receiver<ServiceCommand>,
    mut update_rx: tokio::sync::mpsc::Receiver<(String, DownloadUpdate)>,
    snapshots: Arc<Mutex<HashMap<String, DownloadItem>>>,
    db: Arc<db::Db>,
    app: AppHandle,
) {
    let mut ticker = tokio::time::interval(Duration::from_millis(150));
    let mut disconnected = false;

    loop {
        loop {
            match command_rx.try_recv() {
                Ok(command) => {
                    handle_service_command(
                        command,
                        &mut task_manager,
                        &snapshots,
                        &db,
                        &app,
                    )
                    .await;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }

        if disconnected {
            break;
        }

        task_manager.poll_updates();
        poll_updates(&mut update_rx, &snapshots, &db, &app);
        ticker.tick().await;
    }
}

async fn handle_service_command(
    command: ServiceCommand,
    task_manager: &mut task_manager::TaskManager,
    snapshots: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    db: &Arc<db::Db>,
    app: &AppHandle,
) {
    match command {
        ServiceCommand::Start { input, response_tx } => {
            let result =
                start_download_inner(task_manager, snapshots, db, app, input)
                    .await;
            let _ = response_tx.send(result);
        }
        ServiceCommand::Pause { id, response_tx } => {
            let result = task_manager.pause(&id).await;
            let _ = response_tx.send(result);
        }
        ServiceCommand::Resume { id, response_tx } => {
            let result = task_manager.resume(&id).await;
            let _ = response_tx.send(result);
        }
        ServiceCommand::Cancel { id, response_tx } => {
            let result = task_manager.cancel(&id).await;
            let _ = response_tx.send(result);
        }
        ServiceCommand::Remove { id, response_tx } => {
            let _ = task_manager.remove(&id).await;
            if let Ok(mut guard) = snapshots.lock() {
                guard.remove(&id);
                let _ = db.delete_download(&id);
            }
            let _ = response_tx.send(Ok(()));
        }
        ServiceCommand::Retry { id, response_tx } => {
            // Need to fetch original url and directory to restart
            let (url, directory, engine_id, plugins) = {
                snapshots.lock().ok().and_then(|g| {
                    g.get(&id).map(|item| {
                        (item.url.clone(), item.directory.clone(), item.engine_id.clone(), item.plugins.clone())
                    })
                }).unwrap_or_default()
            };
            let result = if !url.is_empty() {
                let start_input = engines::adapter::AdapterStartInput {
                    id: uuid::Uuid::now_v7().to_string(),
                    url,
                    directory: PathBuf::from(directory),
                    filename: String::new(),
                };
                match task_manager.start(&engine_id, start_input.clone()).await {
                    Ok(_) => {
                        if let Ok(mut guard) = snapshots.lock() {
                            guard.remove(&id);
                            let _ = db.delete_download(&id);
                        }
                        Ok(())
                    }
                    Err(e) => Err(format!("failed to retry download: {e}")),
                }
            } else {
                Err(format!("download {id} was not found"))
            };
            let _ = response_tx.send(result);
        }
    }
}

async fn start_download_inner(
    task_manager: &mut task_manager::TaskManager,
    snapshots: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    db: &Arc<db::Db>,
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
        ..
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
        let default_url = urls.first().map(String::as_str);
        let cookie_entries = parse_cookie_file(&path, default_url)
            .map_err(|err| format!("failed to parse cookie file: {err}"))?;
        if !cookie_entries.is_empty() {
            context = context.cookies(cookie_entries);
            has_context = true;
        }
    }

    let mut started = Vec::with_capacity(urls.len());

    for url in urls {
        let id = uuid::Uuid::now_v7().to_string();
        let name = filename
            .clone()
            .filter(|value| !value.trim().is_empty() && single_url)
            .unwrap_or_else(|| derive_filename(&url));
            
        let start_input = engines::adapter::AdapterStartInput {
            id: id.clone(),
            url: url.clone(),
            directory: PathBuf::from(&directory),
            filename: name.clone(),
        };

        let engine_id = input.engine_id.clone().unwrap_or_else(|| "tur".to_string());
        
        task_manager.start(&engine_id, start_input)
            .await
            .map_err(|err| format!("failed to start download: {err}"))?;

        let row = DownloadItem::new(
            id.clone(),
            url.clone(),
            name,
            directory.clone(),
            engine_id,
            input.plugins.clone().unwrap_or_default(),
        );

        let mut guard = snapshots
            .lock()
            .map_err(|_| "download state is poisoned".to_string())?;
        guard.insert(id.clone(), row.clone());
        let _ = db.save_download(&row);
        let _ = app.emit(DOWNLOAD_EVENT, row.clone());
        started.push(row);
    }

    Ok(started)
}

fn poll_updates(
    update_rx: &mut tokio::sync::mpsc::Receiver<(String, DownloadUpdate)>,
    snapshots: &Arc<Mutex<HashMap<String, DownloadItem>>>,
    db: &Arc<db::Db>,
    app: &AppHandle,
) {
    loop {
        match update_rx.try_recv() {
            Ok((id, update)) => {
                let mut should_persist = false;
                if let Ok(mut guard) = snapshots.lock() {
                    if let Some(row) = guard.get_mut(&id) {
                        row.apply_update(&update);
                        let snapshot = row.clone();
                        should_persist = matches!(
                            update,
                            DownloadUpdate::StatusChanged(_)
                                | DownloadUpdate::TotalSize(_)
                                | DownloadUpdate::Progress { .. }
                        );
                        let _ = app.emit(DOWNLOAD_EVENT, &snapshot);
                        
                        if should_persist {
                            let _ = db.save_download(&snapshot);
                        }
                    }
                }
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
        }
    }
}

fn db_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    if !path.exists() {
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    path.push("tur.db");
    Ok(path)
}

fn normalize_restored_download(mut item: DownloadItem) -> DownloadItem {
    item.speed_bps = 0.0;
    item.worker_snapshots.clear();
    match item.status.as_str() {
        "downloading" | "queued" => {
            item.status = "stopped".into();
            if item.error_message.is_none() {
                item.error_message = Some("Restored after app restart".into());
            }
        }
        "paused" | "stopped" | "completed" | "error" => {}
        _ => {
            item.status = "stopped".into();
        }
    }
    if item.total_size > 0 {
        item.progress = (item.downloaded_bytes as f64 / item.total_size as f64).clamp(0.0, 1.0);
    }
    item
}



fn derive_filename(url: &str) -> String {
    url.split('/')
        .next_back()
        .map(|s| s.split('?').next().unwrap_or(s))
        .map(|s| s.split('#').next().unwrap_or(s))
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


fn parse_cookie_file(path: &PathBuf, default_url: Option<&str>) -> Result<Vec<CookieEntry>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read cookie file: {e}"))?;

    let default_domain = default_url
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_default();

    let mut cookies = Vec::new();

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("#") || line.starts_with("//") {
            continue;
        }

        let parts: Vec<&str> = line.split("\t").collect();
        if parts.len() >= 7 {
            // Netscape cookie file format
            let domain = parts[0].strip_prefix(".").unwrap_or(parts[0]);
            let path = parts[2];
            let secure = parts[3] == "TRUE";
            let expires = parts[4];
            let name = parts[5];
            let value = parts[6];
            let mut entry = CookieEntry::new(name, value, domain);
            entry.path = path.to_string();
            entry.secure = secure;
            if !expires.is_empty() && expires != "0" {
                entry.expires = Some(expires.to_string());
            }
            cookies.push(entry);
        } else if let Some(eq_pos) = line.find("=") {
            // Simple name=value format
            let name = line[..eq_pos].trim();
            let value = line[eq_pos + 1..].trim();
            if !name.is_empty() {
                cookies.push(CookieEntry::new(name, value, default_domain.as_str()));
            }
        }
    }

    Ok(cookies)
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

            // Build tray icon with menu
            let show = MenuItem::with_id(app, "show", "Show Tur", true, None::<&str>)
                .map_err(|e| Box::<dyn std::error::Error>::from(
                    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                ))?;
            let new_download = MenuItem::with_id(app, "new_download", "New Download", true, None::<&str>)
                .map_err(|e| Box::<dyn std::error::Error>::from(
                    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                ))?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
                .map_err(|e| Box::<dyn std::error::Error>::from(
                    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                ))?;
            let menu = Menu::with_items(app, &[&show, &new_download, &quit])
                .map_err(|e| Box::<dyn std::error::Error>::from(
                    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                ))?;

            let mut tray_builder = TrayIconBuilder::with_id("com.kaizen.tur")
                .tooltip("Tur Download Manager")
                .menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder
                .on_menu_event(|app_handle: &tauri::AppHandle, event: tauri::menu::MenuEvent| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                            if let Some(tray) = app_handle.tray_by_id("com.kaizen.tur") {
                                let _ = tray.set_visible(false);
                            }
                        }
                        "new_download" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = app_handle.emit("focus-add-download", ());
                            }
                            if let Some(tray) = app_handle.tray_by_id("com.kaizen.tur") {
                                let _ = tray.set_visible(false);
                            }
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)
                .map_err(|e| Box::<dyn std::error::Error>::from(
                    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                ))?;

            let _ = _tray.set_visible(false);

            // Close-to-tray: hide main window instead of quitting
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                        if let Some(tray) = window_clone.app_handle().tray_by_id("com.kaizen.tur") {
                            let _ = tray.set_visible(true);
                        }
                    }
                });
            }

            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                if let Some(tray) = window.app_handle().tray_by_id("com.kaizen.tur") {
                    let _ = tray.set_visible(false);
                }
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
            remove_download,
            retry_download,
            clear_completed,
            open_download_folder,
            open_download_file,
            get_download,
            list_downloads,
            open_instance_window,
            resize_instance_window,
            quit_app,
            open_confirmation_window,
            open_completion_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
