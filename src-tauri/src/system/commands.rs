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

#[derive(Serialize, Debug, PartialEq)]
pub struct DroppedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

/// Expands dropped paths: files are kept if their extension is in `extensions`,
/// folders are searched recursively (hidden entries and symlinked folders are skipped).
/// Files in a folder come in name order; at most 10000 files are returned.
pub fn expand_paths_blocking(paths: &[PathBuf], extensions: &[String]) -> Vec<DroppedFile> {
    const MAX_FILES: usize = 10_000;
    const MAX_DEPTH: usize = 32;
    let wanted = |p: &Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
    };
    fn walk(dir: &Path, depth: usize, wanted: &dyn Fn(&Path) -> bool, out: &mut Vec<DroppedFile>) {
        if depth > MAX_DEPTH || out.len() >= MAX_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        for entry in entries {
            if out.len() >= MAX_FILES {
                return;
            }
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                walk(&path, depth + 1, wanted, out);
            } else if (kind.is_file() || kind.is_symlink()) && path.is_file() && wanted(&path) {
                push(&path, out);
            }
        }
    }
    fn push(path: &Path, out: &mut Vec<DroppedFile>) {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        out.push(DroppedFile { path: path.to_string_lossy().into_owned(), name, size });
    }
    let mut out = Vec::new();
    for p in paths {
        if out.len() >= MAX_FILES {
            break;
        }
        // A dropped folder itself may be a link; only its contents are not followed further.
        if p.is_dir() {
            walk(p, 0, &wanted, &mut out);
        } else if p.is_file() && wanted(p) {
            push(p, &mut out);
        }
    }
    out
}

#[tauri::command]
pub async fn expand_dropped_paths(paths: Vec<String>, extensions: Vec<String>) -> Vec<DroppedFile> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || expand_paths_blocking(&paths, &extensions))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_folders_are_expanded_in_name_order() {
        let root = std::env::temp_dir().join(format!("ac-drop-{}", uuid::Uuid::new_v4().simple()));
        let album = root.join("Album");
        std::fs::create_dir_all(album.join("CD2")).unwrap();
        std::fs::create_dir_all(album.join(".hidden")).unwrap();
        for f in ["02.flac", "01.FLAC", "cover.jpg", "CD2/01.wav", ".hidden/x.flac", ".skip.flac"] {
            std::fs::write(album.join(f), b"data").unwrap();
        }
        std::fs::write(root.join("single.mp3"), b"abc").unwrap();
        let exts = vec!["flac".to_string(), "wav".to_string(), "mp3".to_string()];
        let got = expand_paths_blocking(&[album.clone(), root.join("single.mp3"), root.join("missing.flac")], &exts);
        let names: Vec<_> = got.iter().map(|f| f.path.strip_prefix(root.to_str().unwrap()).unwrap().replace('\\', "/")).collect();
        assert_eq!(names, ["/Album/01.FLAC", "/Album/02.flac", "/Album/CD2/01.wav", "/single.mp3"]);
        assert_eq!(got[3].size, 3);
        assert_eq!(got[3].name, "single.mp3");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
