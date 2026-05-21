use rusqlite::{params, Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn new(db_path: PathBuf) -> SqlResult<Self> {
        let conn = Connection::open(db_path)?;
        let db = Self { conn: Mutex::new(conn) };
        db.init()?;
        Ok(db)
    }

    fn init(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        
        conn.execute(
            "CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                engine_id TEXT NOT NULL,
                source_url TEXT NOT NULL,
                save_dir TEXT NOT NULL,
                filename TEXT NOT NULL,
                category TEXT NOT NULL,
                status TEXT NOT NULL,
                downloaded_bytes INTEGER NOT NULL,
                total_size INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                error_message TEXT,
                engine_payload_json TEXT
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS download_request_meta (
                download_id TEXT PRIMARY KEY,
                referer TEXT,
                headers_json TEXT,
                cookie_file TEXT,
                auth_profile_id TEXT,
                notes TEXT,
                FOREIGN KEY(download_id) REFERENCES downloads(id)
            )",
            [],
        )?;

        Ok(())
    }

    pub fn save_download(&self, item: &crate::DownloadItem) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let plugins_json = serde_json::to_string(&item.plugins).unwrap_or_else(|_| "[]".into());
        let engine_payload_json = serde_json::to_string(&item.worker_snapshots).unwrap_or_else(|_| "[]".into());

        conn.execute(
            "INSERT INTO downloads (
                id, engine_id, source_url, save_dir, filename, category, status,
                downloaded_bytes, total_size, created_at, updated_at, error_message, engine_payload_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                downloaded_bytes = excluded.downloaded_bytes,
                total_size = excluded.total_size,
                updated_at = excluded.updated_at,
                error_message = excluded.error_message,
                engine_payload_json = excluded.engine_payload_json",
            params![
                item.id,
                item.engine_id,
                item.url,
                item.directory,
                item.filename,
                "General", // Default category for now
                item.status,
                item.downloaded_bytes as i64,
                item.total_size as i64,
                item.created_at_ms as i64,
                item.created_at_ms as i64, // updated_at
                item.error_message,
                engine_payload_json
            ],
        )?;

        // Update plugins in download_request_meta
        conn.execute(
            "INSERT INTO download_request_meta (download_id, notes) VALUES (?1, ?2)
             ON CONFLICT(download_id) DO UPDATE SET notes = excluded.notes",
            params![item.id, plugins_json],
        )?;

        Ok(())
    }

    pub fn load_all_downloads(&self) -> SqlResult<Vec<crate::DownloadItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT d.id, d.engine_id, d.source_url, d.save_dir, d.filename, d.status,
                    d.downloaded_bytes, d.total_size, d.created_at, d.error_message, d.engine_payload_json,
                    m.notes
             FROM downloads d
             LEFT JOIN download_request_meta m ON d.id = m.download_id"
        )?;

        let download_iter = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let engine_id: String = row.get(1)?;
            let url: String = row.get(2)?;
            let directory: String = row.get(3)?;
            let filename: String = row.get(4)?;
            let status: String = row.get(5)?;
            let downloaded_bytes_i64: i64 = row.get(6)?;
            let total_size_i64: i64 = row.get(7)?;
            let created_at_ms_i64: i64 = row.get(8)?;
            let error_message: Option<String> = row.get(9)?;
            let engine_payload_json: String = row.get(10)?;
            let plugins_json: Option<String> = row.get(11)?;

            let downloaded_bytes = downloaded_bytes_i64 as u64;
            let total_size = total_size_i64 as u64;
            let created_at_ms = created_at_ms_i64 as u64;

            let worker_snapshots = serde_json::from_str(&engine_payload_json).unwrap_or_else(|_| Vec::new());
            let plugins = plugins_json.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or_else(|| Vec::new());

            let progress = if total_size > 0 {
                (downloaded_bytes as f64 / total_size as f64).clamp(0.0, 1.0)
            } else {
                0.0
            };

            Ok(crate::DownloadItem {
                id,
                url,
                filename,
                directory,
                engine_id,
                plugins,
                downloaded_bytes,
                total_size,
                speed_bps: 0.0,
                progress,
                status,
                protocol: "auto".into(),
                error_message,
                created_at_ms,
                worker_snapshots,
            })
        })?;

        let mut items = Vec::new();
        for item in download_iter {
            items.push(item?);
        }
        Ok(items)
    }

    pub fn delete_download(&self, id: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM download_request_meta WHERE download_id = ?1", params![id])?;
        conn.execute("DELETE FROM downloads WHERE id = ?1", params![id])?;
        Ok(())
    }
}
