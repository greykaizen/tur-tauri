use crate::engines::adapter::{Engine, AdapterStartInput};
use crate::engines::tur_adapter::TurAdapter;
use crate::engines::aria2c_adapter::Aria2cAdapter;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tur_rs::DownloadUpdate;

pub struct TaskManager {
    engines: HashMap<String, Engine>,
    // Maps download ID to the engine ID managing it
    active_tasks: HashMap<String, String>,
}

impl TaskManager {
    pub async fn new(update_tx: mpsc::Sender<(String, DownloadUpdate)>) -> Result<Self, String> {
        let mut engines = HashMap::new();
        
        // Initialize tur adapter
        let tur_adapter = TurAdapter::new(update_tx.clone()).await?;
        engines.insert("tur".to_string(), Engine::Tur(tur_adapter));

        // Initialize aria2c adapter
        let aria2c_adapter = Aria2cAdapter::new(update_tx.clone());
        engines.insert("aria2c".to_string(), Engine::Aria2c(aria2c_adapter));

        Ok(Self {
            engines,
            active_tasks: HashMap::new(),
        })
    }

    pub async fn start(&mut self, engine_id: &str, input: AdapterStartInput) -> Result<(), String> {
        let engine = self.engines.get_mut(engine_id).ok_or_else(|| "Engine not found".to_string())?;
        engine.start(input.clone()).await?;
        self.active_tasks.insert(input.id, engine_id.to_string());
        Ok(())
    }

    pub async fn pause(&self, id: &str) -> Result<(), String> {
        let engine_id = self.active_tasks.get(id).ok_or_else(|| "Task not found".to_string())?;
        let engine = self.engines.get(engine_id).unwrap();
        engine.pause(id).await
    }

    pub async fn resume(&self, id: &str) -> Result<(), String> {
        let engine_id = self.active_tasks.get(id).ok_or_else(|| "Task not found".to_string())?;
        let engine = self.engines.get(engine_id).unwrap();
        engine.resume(id).await
    }

    pub async fn cancel(&mut self, id: &str) -> Result<(), String> {
        let engine_id = self.active_tasks.remove(id).ok_or_else(|| "Task not found".to_string())?;
        let engine = self.engines.get_mut(&engine_id).unwrap();
        engine.cancel(id).await
    }

    pub async fn remove(&mut self, id: &str) -> Result<(), String> {
        if let Some(engine_id) = self.active_tasks.remove(id) {
            if let Some(engine) = self.engines.get_mut(&engine_id) {
                let _ = engine.cancel(id).await;
            }
        }
        Ok(())
    }

    pub fn get_engine_for_task(&self, id: &str) -> Option<String> {
        self.active_tasks.get(id).cloned()
    }

    pub fn poll_updates(&mut self) {
        for engine in self.engines.values_mut() {
            match engine {
                Engine::Tur(adapter) => adapter.poll_updates(),
                Engine::Aria2c(_) => {} // Not implemented
            }
        }
    }
}
