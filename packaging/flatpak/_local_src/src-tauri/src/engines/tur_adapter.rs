use std::collections::HashMap;
use std::rc::Rc;
use std::cell::RefCell;
use tur_rs::{DownloadHandle, DownloadRequest, ServiceConfig, TurService};
use crate::engines::adapter::AdapterStartInput;
use tokio::sync::mpsc;
use tur_rs::DownloadUpdate;

pub struct TurAdapter {
    service: TurService,
    // Keep a map of our active handles
    handles: Rc<RefCell<HashMap<String, DownloadHandle>>>,
    // Channel to push updates to the TaskManager
    update_tx: mpsc::Sender<(String, DownloadUpdate)>,
}

impl TurAdapter {
    pub async fn new(update_tx: mpsc::Sender<(String, DownloadUpdate)>) -> Result<Self, String> {
        let service = TurService::new(ServiceConfig::default())
            .await
            .map_err(|e| format!("Failed to start TurService: {e}"))?;
            
        Ok(Self {
            service,
            handles: Rc::new(RefCell::new(HashMap::new())),
            update_tx,
        })
    }

    pub async fn start(&mut self, input: AdapterStartInput) -> Result<(), String> {
        let req = DownloadRequest::new(input.url).dir(input.directory);
        let handle = self.service.add_download(req).await
            .map_err(|e| format!("Failed to start download: {e}"))?;
            
        self.handles.borrow_mut().insert(input.id, handle);
        Ok(())
    }

    pub fn poll_updates(&self) {
        let mut finished = Vec::new();
        let mut handles = self.handles.borrow_mut();
        let keys: Vec<String> = handles.keys().cloned().collect();
        for id in keys {
            if let Some(handle) = handles.get_mut(&id) {
                loop {
                    match handle.try_recv() {
                        Ok(update) => {
                            if matches!(update, DownloadUpdate::StatusChanged(tur_rs::DownloadStatus::Completed) | DownloadUpdate::StatusChanged(tur_rs::DownloadStatus::Error(_))) {
                                finished.push(id.clone());
                            }
                            let _ = self.update_tx.try_send((id.clone(), update));
                        }
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                            finished.push(id.clone());
                            break;
                        }
                    }
                }
            }
        }
        for id in finished {
            handles.remove(&id);
        }
    }

    pub async fn pause(&self, id: &str) -> Result<(), String> {
        if let Some(handle) = self.handles.borrow().get(id) {
            handle.pause().await;
            Ok(())
        } else {
            Err("Not found".into())
        }
    }

    pub async fn resume(&self, id: &str) -> Result<(), String> {
        if let Some(handle) = self.handles.borrow().get(id) {
            handle.resume().await;
            Ok(())
        } else {
            Err("Not found".into())
        }
    }

    pub async fn cancel(&mut self, id: &str) -> Result<(), String> {
        if let Some(handle) = self.handles.borrow_mut().remove(id) {
            handle.cancel().await;
            Ok(())
        } else {
            Err("Not found".into())
        }
    }
}
