use std::path::PathBuf;
use crate::engines::tur_adapter::TurAdapter;
use crate::engines::aria2c_adapter::Aria2cAdapter;

#[derive(Debug, Clone)]
pub struct AdapterStartInput {
    pub id: String,
    pub url: String,
    pub directory: PathBuf,
    pub filename: String,
}

pub enum Engine {
    Tur(TurAdapter),
    Aria2c(Aria2cAdapter),
}

impl Engine {
    pub async fn start(&mut self, input: AdapterStartInput) -> Result<(), String> {
        match self {
            Engine::Tur(adapter) => adapter.start(input).await,
            Engine::Aria2c(adapter) => adapter.start(input).await,
        }
    }

    pub async fn pause(&self, id: &str) -> Result<(), String> {
        match self {
            Engine::Tur(adapter) => adapter.pause(id).await,
            Engine::Aria2c(adapter) => adapter.pause(id).await,
        }
    }

    pub async fn resume(&self, id: &str) -> Result<(), String> {
        match self {
            Engine::Tur(adapter) => adapter.resume(id).await,
            Engine::Aria2c(adapter) => adapter.resume(id).await,
        }
    }

    pub async fn cancel(&mut self, id: &str) -> Result<(), String> {
        match self {
            Engine::Tur(adapter) => adapter.cancel(id).await,
            Engine::Aria2c(adapter) => adapter.cancel(id).await,
        }
    }
}
