use std::process::Command;

pub struct YtDlpPlugin;

impl YtDlpPlugin {
    pub fn is_available() -> bool {
        Command::new("yt-dlp").arg("--version").output().is_ok()
    }

    pub fn get_stream_urls(url: &str) -> Result<(String, String), String> {
        let output = Command::new("yt-dlp")
            .args(["-f", "bestvideo,bestaudio", "-g", url])
            .output()
            .map_err(|e| format!("Failed to run yt-dlp: {e}"))?;

        if !output.status.success() {
            return Err("yt-dlp failed to extract links".into());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut lines = stdout.lines().filter(|l| !l.trim().is_empty());

        let video_url = lines.next().ok_or("No video URL found")?.to_string();
        let audio_url = lines.next().unwrap_or(&video_url).to_string();

        Ok((video_url, audio_url))
    }
}
