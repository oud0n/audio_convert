use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct QualityVerificationDetails {
    #[serde(rename = "verifiedAt")]
    pub verified_at: String,
    #[serde(rename = "isLosslessPair")]
    pub is_lossless_pair: bool,
    #[serde(rename = "exactMatch")]
    pub exact_match: bool,
    #[serde(rename = "originalHash")]
    pub original_hash: Option<String>,
    #[serde(rename = "convertedHash")]
    pub converted_hash: Option<String>,
    #[serde(rename = "snrDb")]
    pub snr_db: Option<f64>,
    #[serde(rename = "maxDiffDb")]
    pub max_diff_db: Option<f64>,
    #[serde(rename = "correlationPercent")]
    pub correlation_percent: Option<f64>,
    #[serde(rename = "hasHighFreqCutoff")]
    pub has_high_freq_cutoff: bool,
    #[serde(rename = "cutoffFreqHz")]
    pub cutoff_freq_hz: Option<f64>,
    pub status: String,
    #[serde(rename = "summaryMessage")]
    pub summary_message: String,
    pub details: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct VerifyQualityResponse {
    pub success: bool,
    pub result: Option<QualityVerificationDetails>,
    pub error: Option<String>,
}

/// FFmpeg to use, in order: $FFMPEG_PATH, the sidecar bundled next to the app
/// executable, the npm ffmpeg-static binary (development), then `ffmpeg` on PATH.
pub fn get_ffmpeg_executable() -> PathBuf {
    if let Some(p) = std::env::var_os("FFMPEG_PATH").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let exe = if cfg!(windows) { ".exe" } else { "" };
    // Tauri installs the sidecar next to the app executable without the target triple.
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let sidecar = dir.join(format!("audio-convert-ffmpeg{exe}"));
        if sidecar.is_file() {
            return sidecar;
        }
    }
    let name = format!("ffmpeg{exe}");
    for base in ["node_modules", "../node_modules"] {
        let local = Path::new(base).join("ffmpeg-static").join(&name);
        if local.is_file() {
            return local;
        }
    }
    PathBuf::from("ffmpeg")
}

/// Error text used when a job was cancelled while FFmpeg ran.
pub const CANCELLED: &str = "Cancelled";

/// Waits for `child`, killing it as soon as `cancelled()` returns true.
pub fn wait_or_kill(
    child: &mut std::process::Child,
    cancelled: &dyn Fn() -> bool,
) -> Result<std::process::ExitStatus, Box<dyn std::error::Error + Send + Sync>> {
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

pub fn decode_to_temp_wav(
    file_path: &str,
    sample_rate: Option<u32>,
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    decode_to_temp_wav_with(file_path, sample_rate, 2, None, cancelled)
}

/// Like `decode_to_temp_wav`, with a channel count and an optional length limit (seconds).
pub fn decode_to_temp_wav_with(
    file_path: &str,
    sample_rate: Option<u32>,
    channels: u32,
    max_seconds: Option<f64>,
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let tmp_dir = std::env::temp_dir();
    let temp_name = format!(
        "preview_{}_{}.wav",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
        uuid::Uuid::new_v4().simple()
    );
    let output_path = tmp_dir.join(temp_name);

    let ffmpeg = get_ffmpeg_executable();
    let mut cmd = crate::audio::convert::hidden_command(&ffmpeg);
    cmd.args(["-y", "-i", file_path, "-map", "0:a:0", "-acodec", "pcm_s16le", "-ac", &channels.to_string()]);
    if let Some(sr) = sample_rate {
        cmd.args(["-ar", &sr.to_string()]);
    }
    if let Some(t) = max_seconds {
        cmd.args(["-t", &format!("{t:.3}")]);
    }
    cmd.args(["-map_metadata", "-1"]);
    cmd.arg(&output_path);

    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let status = match cmd.spawn().map_err(|e| e.into()).and_then(|mut child| wait_or_kill(&mut child, cancelled)) {
        Ok(status) => status,
        Err(e) => {
            let _ = std::fs::remove_file(&output_path);
            return Err(e);
        }
    };
    if !status.success() {
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("FFmpeg failed with exit code: {:?}", status.code()).into());
    }

    Ok(output_path)
}

pub fn compute_pcm_fingerprint(
    file_path: &str,
) -> Result<(String, usize), Box<dyn std::error::Error + Send + Sync>> {
    compute_pcm_fingerprint_cancellable(file_path, &|| false)
}

pub fn compute_pcm_fingerprint_cancellable(
    file_path: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<(String, usize), Box<dyn std::error::Error + Send + Sync>> {
    let ffmpeg = get_ffmpeg_executable();
    let mut child = crate::audio::convert::hidden_command(&ffmpeg)
        .args([
            "-v",
            "error",
            "-i",
            file_path,
            "-map",
            "0:a:0",
            "-c:a",
            "pcm_f64le",
            "-f",
            "f64le",
            "-",
        ])
        .stdout(std::process::Stdio::piped())
        .spawn()?;

    let mut stdout = child.stdout.take().ok_or("Failed to open stdout")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 32768];
    let mut total_bytes = 0;

    loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.into());
        }
        let read_bytes = stdout.read(&mut buffer)?;
        if read_bytes == 0 {
            break;
        }
        total_bytes += read_bytes;
        hasher.update(&buffer[..read_bytes]);
    }

    let status = child.wait()?;
    if !status.success() || total_bytes == 0 {
        return Err("PCM decoding produced empty or failed output".into());
    }

    let hash = format!("{:x}", hasher.finalize());
    Ok((hash, total_bytes))
}

fn extract_pcm_samples_from_wav(path: &Path) -> Result<Vec<i16>, Box<dyn std::error::Error + Send + Sync>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let samples: Vec<i16> = match spec.sample_format {
        hound::SampleFormat::Int => {
            if spec.bits_per_sample == 16 {
                reader.samples::<i16>().filter_map(Result::ok).collect()
            } else if spec.bits_per_sample == 24 || spec.bits_per_sample == 32 {
                reader
                    .samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|s| (s >> (spec.bits_per_sample - 16)) as i16)
                    .collect()
            } else {
                reader
                    .samples::<i32>()
                    .filter_map(Result::ok)
                    .map(|s| (s as f32 / (1 << (spec.bits_per_sample - 1)) as f32 * 32767.0) as i16)
                    .collect()
            }
        }
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .filter_map(Result::ok)
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect(),
    };
    Ok(samples)
}

struct DiffMetrics {
    max_diff_db: f64,
    snr_db: f64,
    correlation_percent: f64,
}

fn compare_pcm_samples(pcm1: &[i16], pcm2: &[i16]) -> Result<DiffMetrics, Box<dyn std::error::Error + Send + Sync>> {
    let min_len = pcm1.len().min(pcm2.len());
    if min_len == 0 {
        return Err("Cannot compare empty audio".into());
    }

    let mut max_diff: f64 = 0.0;
    let mut sum_sq_diff: f64 = 0.0;
    let mut sum_sq1: f64 = 0.0;
    let mut sum_sq2: f64 = 0.0;
    let mut dot_prod: f64 = 0.0;

    let start_sample = 250.min(min_len * 5 / 1000);
    let step = 1.max((min_len - start_sample) / 500000);
    let mut count: f64 = 0.0;

    for i in (start_sample..min_len).step_by(step) {
        let s1 = pcm1[i] as f64;
        let s2 = pcm2[i] as f64;
        let diff = (s1 - s2).abs();

        if diff > max_diff {
            max_diff = diff;
        }
        sum_sq_diff += diff * diff;
        sum_sq1 += s1 * s1;
        sum_sq2 += s2 * s2;
        dot_prod += s1 * s2;
        count += 1.0;
    }

    let mse = sum_sq_diff / count;
    let sig_pow1 = sum_sq1 / count;
    let sig_pow2 = sum_sq2 / count;

    let mut snr_db = 100.0;
    if mse > 0.0 && sig_pow1 > 0.0 {
        snr_db = ((10.0 * (sig_pow1 / mse).log10()) * 10.0).round() / 10.0;
    } else if sig_pow1 == 0.0 && mse > 0.0 {
        snr_db = -100.0;
    }

    let mut max_diff_db = -100.0;
    if max_diff > 0.0 {
        max_diff_db = ((20.0 * (max_diff / 32768.0).log10()) * 10.0).round() / 10.0;
    }

    let denom = (sig_pow1 * sig_pow2).sqrt();
    let mut correlation = 0.0;
    if sig_pow1 == 0.0 && sig_pow2 == 0.0 {
        correlation = 1.0;
        snr_db = 100.0;
    } else if sig_pow1 == 0.0 || sig_pow2 == 0.0 {
        correlation = 0.0;
        snr_db = -100.0;
    } else if denom > 0.0 {
        correlation = (dot_prod / count) / denom;
    }

    let correlation_percent = ((correlation * 10000.0).round() / 100.0).clamp(0.0, 100.0);

    Ok(DiffMetrics {
        max_diff_db,
        snr_db,
        correlation_percent,
    })
}

/// Verifies a conversion. With a job id, it stops (and FFmpeg is killed) when that job
/// is cancelled; without one (a manual re-check), it runs to the end.
#[tauri::command]
pub async fn verify_audio_quality(
    app: tauri::AppHandle,
    original_path: String,
    converted_path: String,
    is_lossless_pair: bool,
    job_id: Option<String>,
) -> VerifyQualityResponse {
    use tauri::Manager;
    let jobs = app.state::<crate::audio::convert::ActiveJobs>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = crate::audio::convert::job_cancelled_fn(jobs, job_id);
        verify_quality_blocking(&original_path, &converted_path, is_lossless_pair, &cancelled)
    })
    .await
    .unwrap_or_else(|e| VerifyQualityResponse { success: false, result: None, error: Some(e.to_string()) })
}

fn failure(error: String) -> VerifyQualityResponse {
    VerifyQualityResponse { success: false, result: None, error: Some(error) }
}

pub fn verify_quality_blocking(
    original_path: &str,
    converted_path: &str,
    is_lossless_pair: bool,
    cancelled: &dyn Fn() -> bool,
) -> VerifyQualityResponse {
    let (original_path, converted_path) = (original_path.to_string(), converted_path.to_string());
    let now = chrono::Local::now().format("%H:%M:%S").to_string();

    if !Path::new(&original_path).exists() || !Path::new(&converted_path).exists() {
        return VerifyQualityResponse {
            success: false,
            result: None,
            error: Some("Original or converted file path is invalid or missing.".to_string()),
        };
    }

    // 1. Bit-exact SHA-256 Fingerprint check
    let orig_hash = compute_pcm_fingerprint_cancellable(&original_path, cancelled);
    if cancelled() {
        return failure(CANCELLED.into());
    }
    let conv_hash = compute_pcm_fingerprint_cancellable(&converted_path, cancelled);
    if cancelled() {
        return failure(CANCELLED.into());
    }

    if let (Ok((hash1, bytes1)), Ok((hash2, bytes2))) = (&orig_hash, &conv_hash) {
        if hash1 == hash2 && bytes1 == bytes2 {
            return VerifyQualityResponse {
                success: true,
                result: Some(QualityVerificationDetails {
                    verified_at: now,
                    is_lossless_pair: true,
                    exact_match: true,
                    original_hash: Some(hash1.clone()),
                    converted_hash: Some(hash2.clone()),
                    snr_db: Some(100.0),
                    max_diff_db: Some(-100.0),
                    correlation_percent: Some(100.0),
                    has_high_freq_cutoff: false,
                    cutoff_freq_hz: None,
                    status: "perfect".to_string(),
                    summary_message: "PCM完全一致 (サンプル値・音声構成が一致)".to_string(),
                    details: vec![
                        format!("元のPCM SHA-256: {}", hash1),
                        format!("変換後PCM SHA-256: {}", hash2),
                        "ハッシュ比較結果: 完全に一致 (Bit-exact match)".to_string(),
                        "元の精度を保持したPCMサンプル値と音声構成が一致しています。".to_string(),
                    ],
                }),
                error: None,
            };
        }
    }

    // 2. Waveform Difference Analysis
    // Compare at the output's sample rate: a resampled output (e.g. a 96 kHz limit on
    // a 192 kHz source) would otherwise be compared sample by sample at different rates.
    let converted_rate = crate::audio::convert::probe_source(&get_ffmpeg_executable(), Path::new(&converted_path))
        .ok()
        .and_then(|info| info.sample_rate);
    let temp_orig = match decode_to_temp_wav(&original_path, converted_rate, cancelled) {
        Ok(p) => p,
        Err(e) => {
            return VerifyQualityResponse {
                success: false,
                result: None,
                error: Some(if cancelled() { CANCELLED.to_string() } else { format!("Failed to decode original: {}", e) }),
            }
        }
    };

    let temp_conv = match decode_to_temp_wav(&converted_path, None, cancelled) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&temp_orig);
            return VerifyQualityResponse {
                success: false,
                result: None,
                error: Some(if cancelled() { CANCELLED.to_string() } else { format!("Failed to decode converted: {}", e) }),
            }
        }
    };

    let analysis_result = (|| -> Result<DiffMetrics, Box<dyn std::error::Error + Send + Sync>> {
        let pcm1 = extract_pcm_samples_from_wav(&temp_orig)?;
        let pcm2 = extract_pcm_samples_from_wav(&temp_conv)?;
        compare_pcm_samples(&pcm1, &pcm2)
    })();

    let _ = std::fs::remove_file(&temp_orig);
    let _ = std::fs::remove_file(&temp_conv);

    let metrics = match analysis_result {
        Ok(m) => m,
        Err(e) => {
            return VerifyQualityResponse {
                success: false,
                result: None,
                error: Some(format!("Quality comparison failed: {}", e)),
            }
        }
    };

    let (status, summary) = if metrics.correlation_percent >= 99.0 && metrics.snr_db >= 30.0 {
        if is_lossless_pair {
            (
                "warning".to_string(),
                format!(
                    "波形は類似していますがPCMは一致しません (波形類似度 {}%)",
                    metrics.correlation_percent
                ),
            )
        } else {
            (
                "passed".to_string(),
                format!("品質良好 (波形類似度: {}%)", metrics.correlation_percent),
            )
        }
    } else if metrics.correlation_percent >= 90.0 {
        (
            "warning".to_string(),
            format!(
                "音質変化あり (波形類似度: {}%, S/N比: {}dB)",
                metrics.correlation_percent, metrics.snr_db
            ),
        )
    } else {
        (
            "degraded".to_string(),
            format!(
                "大幅な音質変化/データ欠損の可能性 (波形類似度: {}%)",
                metrics.correlation_percent
            ),
        )
    };

    let h1 = orig_hash.as_ref().map(|(h, _)| h.clone()).unwrap_or_else(|_| "N/A".to_string());
    let h2 = conv_hash.as_ref().map(|(h, _)| h.clone()).unwrap_or_else(|_| "N/A".to_string());

    let details = vec![
        format!("元のPCM SHA-256: {}", h1),
        format!("変換後PCM SHA-256: {}", h2),
        format!("波形類似度 (相関率): {}%", metrics.correlation_percent),
        format!("S/N比 (Signal-to-Noise Ratio): {} dB", metrics.snr_db),
        format!("最大波形差分ピーク: {} dB", metrics.max_diff_db),
        "高周波カットオフ: 未測定".to_string(),
    ];

    VerifyQualityResponse {
        success: true,
        result: Some(QualityVerificationDetails {
            verified_at: now,
            is_lossless_pair,
            exact_match: false,
            original_hash: Some(h1),
            converted_hash: Some(h2),
            snr_db: Some(metrics.snr_db),
            max_diff_db: Some(metrics.max_diff_db),
            correlation_percent: Some(metrics.correlation_percent),
            has_high_freq_cutoff: false,
            cutoff_freq_hz: None,
            status,
            summary_message: summary,
            details,
        }),
        error: None,
    }
}
