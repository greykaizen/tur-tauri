use crate::engines::adapter::AdapterStartInput;
use tokio::sync::mpsc;
use tur_rs::DownloadUpdate;

pub struct Aria2cAdapter {
    update_tx: mpsc::Sender<(String, DownloadUpdate)>,
}

impl Aria2cAdapter {
    pub fn new(update_tx: mpsc::Sender<(String, DownloadUpdate)>) -> Self {
        Self { update_tx }
    }

    pub async fn start(&mut self, _input: AdapterStartInput) -> Result<(), String> {
        Err("Not implemented yet".into())
    }

    pub async fn pause(&self, _id: &str) -> Result<(), String> {
        Err("Not implemented yet".into())
    }

    pub async fn resume(&self, _id: &str) -> Result<(), String> {
        Err("Not implemented yet".into())
    }

    pub async fn cancel(&mut self, _id: &str) -> Result<(), String> {
        Err("Not implemented yet".into())
    }
}
