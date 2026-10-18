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

pub const MAX_DROPPED_FILES: usize = 10_000;

#[derive(Serialize, Debug, PartialEq)]
pub struct DroppedPaths {
    pub files: Vec<DroppedFile>,
    /// More files were found than `MAX_DROPPED_FILES`; the rest were left out.
    pub truncated: bool,
}

/// Expands dropped paths: files are kept if their extension is in `extensions`,
/// folders are searched recursively (hidden entries and symlinked folders are skipped).
/// Files in a folder come in name order; a file reached twice (a folder and a file in
/// it, or the same folder twice) is listed once; at most `MAX_DROPPED_FILES` are returned.
pub fn expand_paths_blocking(paths: &[PathBuf], extensions: &[String]) -> DroppedPaths {
    const MAX_DEPTH: usize = 32;
    struct Walk<'a> {
        extensions: &'a [String],
        seen: std::collections::HashSet<PathBuf>,
        out: Vec<DroppedFile>,
        truncated: bool,
    }
    impl Walk<'_> {
        fn wanted(&self, p: &Path) -> bool {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| self.extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
        }
        fn push(&mut self, path: &Path) {
            let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            if self.seen.contains(&key) {
                return;
            }
            if self.out.len() >= MAX_DROPPED_FILES {
                self.truncated = true;
                return;
            }
            self.seen.insert(key);
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            self.out.push(DroppedFile { path: path.to_string_lossy().into_owned(), name, size });
        }
        fn walk(&mut self, dir: &Path, depth: usize) {
            if depth > MAX_DEPTH || self.truncated {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
            entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
            for entry in entries {
                if self.truncated {
                    return;
                }
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                let Ok(kind) = entry.file_type() else { continue };
                let path = entry.path();
                if kind.is_dir() {
                    self.walk(&path, depth + 1);
                } else if (kind.is_file() || kind.is_symlink()) && path.is_file() && self.wanted(&path) {
                    self.push(&path);
                }
            }
        }
    }
    let mut w = Walk { extensions, seen: Default::default(), out: Vec::new(), truncated: false };
    for p in paths {
        if w.truncated {
            break;
        }
        // A dropped folder itself may be a link; only its contents are not followed further.
        if p.is_dir() {
            w.walk(p, 0);
        } else if p.is_file() && w.wanted(p) {
            w.push(p);
        }
    }
    DroppedPaths { files: w.out, truncated: w.truncated }
}

#[tauri::command]
pub async fn expand_dropped_paths(paths: Vec<String>, extensions: Vec<String>) -> DroppedPaths {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tauri::async_runtime::spawn_blocking(move || expand_paths_blocking(&paths, &extensions))
        .await
        .unwrap_or(DroppedPaths { files: Vec::new(), truncated: false })
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
        let got = expand_paths_blocking(
            &[album.clone(), root.join("single.mp3"), album.join("02.flac"), root.join("missing.flac"), album.clone()],
            &exts,
        );
        assert!(!got.truncated);
        let got = got.files;
        let names: Vec<_> = got.iter().map(|f| f.path.strip_prefix(root.to_str().unwrap()).unwrap().replace('\\', "/")).collect();
        assert_eq!(names, ["/Album/01.FLAC", "/Album/02.flac", "/Album/CD2/01.wav", "/single.mp3"]);
        assert_eq!(got[3].size, 3);
        assert_eq!(got[3].name, "single.mp3");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
