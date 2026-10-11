use crate::audio::audit::{decode_to_temp_wav, get_ffmpeg_executable};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub type ActiveJobs = Arc<Mutex<HashMap<String, u32>>>; // jobId -> process ID

#[derive(Serialize, Clone, Debug)]
pub struct ProgressPayload {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub phase: String,
    pub progress: f64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ConverterSettings {
    #[serde(rename = "outputFormat")]
    pub output_format: String,
    pub bitrate: Option<String>,
    #[serde(rename = "sampleRate")]
    pub sample_rate: Option<u32>,
    #[serde(rename = "bitDepth")]
    pub bit_depth: Option<String>,
    pub channels: Option<u32>,
    pub normalize: Option<bool>,
    #[serde(rename = "normalizationTargetDb")]
    pub normalization_target_db: Option<f64>,
    #[serde(rename = "volumeBoostDb")]
    pub volume_boost_db: Option<f64>,
    #[serde(rename = "trimSilence")]
    pub trim_silence: Option<bool>,
    #[serde(rename = "trimSilenceThresholdDb")]
    pub trim_silence_threshold_db: Option<f64>,
    #[serde(rename = "threadPoolSize")]
    pub thread_pool_size: Option<u32>,
    #[serde(rename = "sameAsSource")]
    pub same_as_source: Option<bool>,
    #[serde(rename = "saveInSourceFolder")]
    pub save_in_source_folder: Option<bool>,
    #[serde(rename = "localSavePath")]
    pub local_save_path: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct InputTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    #[serde(rename = "albumArtist")]
    pub album_artist: Option<String>,
    pub disc: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub track: Option<String>,
    pub comment: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ConvertRequest {
    #[serde(rename = "inputFilePath")]
    pub input_file_path: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "outputFormat")]
    pub output_format: String,
    #[serde(rename = "jobId")]
    pub job_id: Option<String>,
    pub settings: ConverterSettings,
    pub tags: Option<InputTags>,
}

#[derive(Serialize, Debug)]
pub struct ConvertResponse {
    pub success: bool,
    pub path: Option<String>,
    #[serde(rename = "fileName")]
    pub file_name: Option<String>,
    pub error: Option<String>,
}

pub fn safe_file_name(name: &str) -> String {
    let mut clean: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\x1f' => '_',
            _ => c,
        })
        .collect();

    while clean.ends_with(' ') || clean.ends_with('.') {
        clean.pop();
    }

    if clean.is_empty() {
        clean = "audio".to_string();
    }

    let stem_limit = 180;
    if clean.len() > stem_limit {
        clean.truncate(stem_limit);
    }

    clean
}

fn publish_output(staging: &Path, destination: &Path) -> Result<(), std::io::Error> {
    if let Ok(()) = fs::hard_link(staging, destination) {
        return Ok(());
    }

    let mut reader = File::open(staging)?;
    let mut writer = File::create(destination)?;
    let mut buf = [0u8; 1024 * 1024];

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
    }

    writer.sync_all()?;
    Ok(())
}

#[tauri::command]
pub async fn start_conversion_job(
    state: tauri::State<'_, ActiveJobs>,
    job_id: String,
) -> Result<(), String> {
    let mut jobs = state.lock().map_err(|e| e.to_string())?;
    jobs.insert(job_id, 0);
    Ok(())
}

#[tauri::command]
pub async fn cancel_conversion_job(
    state: tauri::State<'_, ActiveJobs>,
    job_id: String,
) -> Result<(), String> {
    let mut jobs = state.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = jobs.remove(&job_id) {
        if pid > 0 {
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/F", "/PID", &pid.to_string()])
                    .status();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn finish_conversion_job(
    state: tauri::State<'_, ActiveJobs>,
    job_id: String,
) -> Result<(), String> {
    let mut jobs = state.lock().map_err(|e| e.to_string())?;
    jobs.remove(&job_id);
    Ok(())
}

#[tauri::command]
pub async fn decode_audio_to_wav(file_path: String) -> Result<Vec<u8>, String> {
    let temp = decode_to_temp_wav(&file_path, None).map_err(|e| e.to_string())?;
    let data = fs::read(&temp).map_err(|e| e.to_string());
    let _ = fs::remove_file(&temp);
    data
}

#[tauri::command]
pub async fn read_output_preview(file_path: String, _job_id: Option<String>) -> Result<Vec<u8>, String> {
    decode_audio_to_wav(file_path).await
}

#[tauri::command]
pub async fn convert_audio(
    app: AppHandle,
    state: tauri::State<'_, ActiveJobs>,
    request: ConvertRequest,
) -> Result<ConvertResponse, String> {
    let input_path = PathBuf::from(&request.input_file_path);
    if !input_path.exists() {
        return Ok(ConvertResponse {
            success: false,
            path: None,
            file_name: None,
            error: Some("Input file does not exist".to_string()),
        });
    }

    let format_upper = request.output_format.to_uppercase();
    let ext = match format_upper.as_str() {
        "WAV" => "wav",
        "AIFF" => "aiff",
        "FLAC" => "flac",
        "ALAC" => "m4a",
        "M4A" => "m4a",
        "MP3" => "mp3",
        "OGG" => "ogg",
        "OPUS" => "opus",
        "AC3" => "ac3",
        "WMA" => "wma",
        "WAVPACK" => "wv",
        _ => {
            return Ok(ConvertResponse {
                success: false,
                path: None,
                file_name: None,
                error: Some(format!("Unsupported output format: {}", format_upper)),
            });
        }
    };

    let target_dir = if request.settings.save_in_source_folder.unwrap_or(false) {
        input_path.parent().unwrap_or(Path::new(".")).to_path_buf()
    } else if let Some(ref p) = request.settings.local_save_path {
        PathBuf::from(p)
    } else {
        PathBuf::from(".")
    };

    let _ = fs::create_dir_all(&target_dir);

    let clean_stem = safe_file_name(
        input_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio"),
    );
    let output_name = format!("{}.{}", clean_stem, ext);

    let temp_work_dir = std::env::temp_dir().join(format!("audio-convert-{}", uuid::Uuid::new_v4().simple()));
    let _ = fs::create_dir_all(&temp_work_dir);
    let temp_output = temp_work_dir.join(format!("output.{}", ext));

    let ffmpeg = get_ffmpeg_executable();
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-y", "-i", &request.input_file_path, "-map", "0:a:0"]);

    // Codec args
    let codec = match format_upper.as_str() {
        "WAV" => "pcm_s16le",
        "AIFF" => "pcm_s16be",
        "FLAC" => "flac",
        "ALAC" => "alac",
        "WAVPACK" => "wavpack",
        "MP3" => "libmp3lame",
        "M4A" => "aac",
        "OGG" => "libvorbis",
        "OPUS" => "libopus",
        "AC3" => "ac3",
        "WMA" => "wmav2",
        _ => "copy",
    };
    cmd.args(["-c:a", codec]);

    if let Some(bitrate) = &request.settings.bitrate {
        if matches!(format_upper.as_str(), "MP3" | "M4A" | "OGG" | "OPUS" | "AC3" | "WMA") {
            cmd.args(["-b:a", &format!("{}k", bitrate)]);
        }
    }

    if let Some(sr) = request.settings.sample_rate {
        if !request.settings.same_as_source.unwrap_or(false) {
            cmd.args(["-ar", &sr.to_string()]);
        }
    }

    if let Some(ch) = request.settings.channels {
        if !request.settings.same_as_source.unwrap_or(false) {
            cmd.args(["-ac", &ch.to_string()]);
        }
    }

    // Tag embedding
    if let Some(tags) = &request.tags {
        if let Some(title) = &tags.title {
            cmd.args(["-metadata", &format!("title={}", title)]);
        }
        if let Some(artist) = &tags.artist {
            cmd.args(["-metadata", &format!("artist={}", artist)]);
        }
        if let Some(album) = &tags.album {
            cmd.args(["-metadata", &format!("album={}", album)]);
        }
    }

    cmd.args(["-progress", "pipe:1", "-nostats"]);
    cmd.arg(&temp_output);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_work_dir);
            return Ok(ConvertResponse {
                success: false,
                path: None,
                file_name: None,
                error: Some(format!("Failed to start FFmpeg: {}", e)),
            });
        }
    };

    let pid = child.id();
    if let Some(job_id) = &request.job_id {
        if let Ok(mut jobs) = state.lock() {
            jobs.insert(job_id.clone(), pid);
        }
    }

    // Read progress in background
    let app_handle = app.clone();
    let job_id_clone = request.job_id.clone().unwrap_or_default();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().filter_map(Result::ok) {
                if line.starts_with("out_time_us=") {
                    if let Ok(micros) = line[12..].parse::<f64>() {
                        let secs = micros / 1_000_000.0;
                        let _ = app_handle.emit(
                            "conversion-progress",
                            ProgressPayload {
                                job_id: job_id_clone.clone(),
                                phase: "converting".to_string(),
                                progress: secs.min(99.0),
                            },
                        );
                    }
                }
            }
        });
    }

    let status = match child.wait() {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_dir_all(&temp_work_dir);
            return Ok(ConvertResponse {
                success: false,
                path: None,
                file_name: None,
                error: Some(format!("Conversion process failed: {}", e)),
            });
        }
    };

    if !status.success() || !temp_output.exists() {
        let _ = fs::remove_dir_all(&temp_work_dir);
        return Ok(ConvertResponse {
            success: false,
            path: None,
            file_name: None,
            error: Some("FFmpeg failed to produce output file".to_string()),
        });
    }

    // Publish file safely
    let mut final_destination = target_dir.join(&output_name);
    let mut collision_index = 1;
    while final_destination.exists() && collision_index < 10000 {
        final_destination = target_dir.join(format!("{} ({}).{}", clean_stem, collision_index, ext));
        collision_index += 1;
    }

    let staging_path = target_dir.join(format!(".audio-convert-{}.tmp", uuid::Uuid::new_v4().simple()));
    let _ = fs::copy(&temp_output, &staging_path);
    let publish_res = publish_output(&staging_path, &final_destination);
    let _ = fs::remove_file(&staging_path);
    let _ = fs::remove_dir_all(&temp_work_dir);

    if let Err(e) = publish_res {
        return Ok(ConvertResponse {
            success: false,
            path: None,
            file_name: None,
            error: Some(format!("Failed to save output file: {}", e)),
        });
    }

    let final_name = final_destination
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&output_name)
        .to_string();

    Ok(ConvertResponse {
        success: true,
        path: Some(final_destination.to_string_lossy().to_string()),
        file_name: Some(final_name),
        error: None,
    })
}
