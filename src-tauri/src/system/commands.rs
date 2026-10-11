use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct SimpleResult {
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn trash_file(file_path: String, _job_id: Option<String>) -> SimpleResult {
    let path = Path::new(&file_path);
    if !path.exists() {
        return SimpleResult {
            success: false,
            error: Some("File does not exist".to_string()),
        };
    }

    match trash::delete(path) {
        Ok(_) => SimpleResult {
            success: true,
            error: None,
        },
        Err(e) => SimpleResult {
            success: false,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn get_default_save_path() -> String {
    let mut path = dirs::audio_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Music")))
        .unwrap_or_else(|| PathBuf::from("."));
    path.push("Audio-Convert-Outputs");
    path.to_string_lossy().to_string()
}

#[tauri::command]
pub async fn log_debug(message: String) {
    eprintln!("[DEBUG] {}", message);
}
