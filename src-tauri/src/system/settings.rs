use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn get_settings_file_path() -> PathBuf {
    let mut dir = dirs::data_dir()
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    dir.push("audio_convert");
    let _ = fs::create_dir_all(&dir);
    dir.push("settings.json");
    dir
}

#[tauri::command]
pub async fn load_settings() -> Option<Value> {
    let user_path = get_settings_file_path();
    if user_path.exists() {
        if let Ok(content) = fs::read_to_string(&user_path) {
            if let Ok(val) = serde_json::from_str(&content) {
                return Some(val);
            }
        }
    }

    let cwd_path = PathBuf::from("settings.json");
    if cwd_path.exists() {
        if let Ok(content) = fs::read_to_string(&cwd_path) {
            if let Ok(val) = serde_json::from_str(&content) {
                return Some(val);
            }
        }
    }

    None
}

#[derive(serde::Serialize)]
pub struct SaveSettingsResponse {
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn save_settings(settings: Value) -> SaveSettingsResponse {
    let target = get_settings_file_path();
    match serde_json::to_string_pretty(&settings) {
        Ok(json) => match fs::write(&target, json) {
            Ok(_) => SaveSettingsResponse {
                success: true,
                error: None,
            },
            Err(e) => SaveSettingsResponse {
                success: false,
                error: Some(e.to_string()),
            },
        },
        Err(e) => SaveSettingsResponse {
            success: false,
            error: Some(e.to_string()),
        },
    }
}
