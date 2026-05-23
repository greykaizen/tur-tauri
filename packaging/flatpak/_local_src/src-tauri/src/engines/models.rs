use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum EngineId {
    Tur,
    Aria2c,
    Wget2,
    Curl,
    Axel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum PluginId {
    YtDlp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum EngineKind {
    Transfer,
    Extractor,
    Hybrid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineCapabilities {
    pub segmented_download: bool,
    pub http1_2_3: bool,
    pub auth_headers: bool,
    pub cookie_file: bool,
    pub resume: bool,
    pub torrent_metalink: bool,
    pub media_extraction: bool,
    pub batch_input: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EngineAvailability {
    Installed(String), // e.g. Installed version string
    Missing,
    UnsupportedOnPlatform,
    BrokenVersion(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineInfo {
    pub id: EngineId,
    pub name: String,
    pub kind: EngineKind,
    pub capabilities: EngineCapabilities,
    pub availability: EngineAvailability,
}
