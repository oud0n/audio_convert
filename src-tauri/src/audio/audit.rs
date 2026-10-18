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
    // Development builds and tests: the FFmpeg prepared for bundling (the one users get),
    // before the npm ffmpeg-static (an older FFmpeg that behaves differently).
    #[cfg(debug_assertions)]
    {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        if let Ok(entries) = std::fs::read_dir(&dir) {
            let mut found: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    name.starts_with(&format!("audio-convert-ffmpeg-{}", std::env::consts::ARCH)) && (exe.is_empty() || name.ends_with(exe)) && !name.ends_with(".txt")
                })
                .collect();
            found.sort();
            if let Some(p) = found.into_iter().next() {
                return p;
            }
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
    decode_to_temp_wav_with(file_path, sample_rate, 2, None, None, cancelled)
}

/// Like `decode_to_temp_wav`, with a channel count, an optional start (seconds, for a
/// track of an album image) and an optional length limit (seconds).
pub fn decode_to_temp_wav_with(
    file_path: &str,
    sample_rate: Option<u32>,
    channels: u32,
    start_seconds: Option<f64>,
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
    cmd.arg("-y");
    if let Some(s) = start_seconds.filter(|s| *s > 0.0) {
        cmd.args(["-ss", &format!("{s:.6}")]);
    }
    cmd.args(["-i", file_path, "-map", "0:a:0", "-acodec", "pcm_s16le", "-ac", &channels.to_string()]);
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
    compute_pcm_fingerprint_part(file_path, None, None, cancelled)
}

/// Range of a track inside an album image, in seconds (None = the whole file).
pub type Range = Option<(f64, Option<f64>)>;

/// Filters that pick a part of a file: a track range and / or one channel.
fn part_filters(range: Range, channel: Option<u32>, rate: Option<u32>) -> Vec<String> {
    let mut f: Vec<String> = range.map(|r| crate::audio::convert::trim_filter(r, rate)).into_iter().collect();
    if let Some(c) = channel {
        f.push(format!("pan=mono|c0=c{c}"));
    }
    f
}

fn part_filter(file_path: &str, range: Range, channel: Option<u32>) -> Option<String> {
    if range.is_none() && channel.is_none() {
        return None;
    }
    let rate = crate::audio::convert::probe_source(&get_ffmpeg_executable(), Path::new(file_path)).ok().and_then(|i| i.sample_rate);
    Some(part_filters(range, channel, rate).join(","))
}

/// SHA-256 of the decoded samples (only `range` of them for an image track).
pub fn compute_pcm_fingerprint_range(
    file_path: &str,
    range: Range,
    cancelled: &dyn Fn() -> bool,
) -> Result<(String, usize), Box<dyn std::error::Error + Send + Sync>> {
    compute_pcm_fingerprint_part(file_path, range, None, cancelled)
}

/// SHA-256 of the decoded samples of a part of the file (range and / or one channel).
pub fn compute_pcm_fingerprint_part(
    file_path: &str,
    range: Range,
    channel: Option<u32>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(String, usize), Box<dyn std::error::Error + Send + Sync>> {
    let ffmpeg = get_ffmpeg_executable();
    let mut cmd = crate::audio::convert::hidden_command(&ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i", file_path, "-map", "0:a:0"]);
    if let Some(trim) = part_filter(file_path, range, channel) {
        cmd.args(["-af", &trim]);
    }
    let mut child = cmd
        .args(["-c:a", "pcm_f64le", "-f", "f64le", "-"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
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

struct DiffMetrics {
    max_diff_db: f64,
    snr_db: f64,
    correlation_percent: f64,
    /// How much longer or shorter the converted audio is, in seconds.
    length_diff_seconds: f64,
}

/// Running sums for the waveform comparison, over 32-bit float samples (full scale 1.0)
/// at the output's own rate and channel count, so 24-bit and multichannel differences
/// are visible.
#[derive(Default)]
pub(crate) struct DiffAccumulator {
    max_diff: f64,
    sum_sq_diff: f64,
    sum_sq1: f64,
    sum_sq2: f64,
    dot: f64,
    count: f64,
}

impl DiffAccumulator {
    pub(crate) fn push(&mut self, s1: f64, s2: f64) {
        let diff = (s1 - s2).abs();
        self.max_diff = self.max_diff.max(diff);
        self.sum_sq_diff += diff * diff;
        self.sum_sq1 += s1 * s1;
        self.sum_sq2 += s2 * s2;
        self.dot += s1 * s2;
        self.count += 1.0;
    }

    fn finish(&self) -> Result<DiffMetrics, Box<dyn std::error::Error + Send + Sync>> {
        if self.count == 0.0 {
            return Err("Cannot compare empty audio".into());
        }
        let mse = self.sum_sq_diff / self.count;
        let p1 = self.sum_sq1 / self.count;
        let p2 = self.sum_sq2 / self.count;
        let mut snr_db = if mse > 0.0 && p1 > 0.0 { ((10.0 * (p1 / mse).log10()) * 10.0).round() / 10.0 } else { 100.0 };
        let max_diff_db = if self.max_diff > 0.0 { ((20.0 * self.max_diff.log10()) * 10.0).round() / 10.0 } else { -100.0 };
        let correlation = if p1 == 0.0 && p2 == 0.0 {
            snr_db = 100.0;
            1.0
        } else if p1 == 0.0 || p2 == 0.0 {
            snr_db = -100.0;
            0.0
        } else {
            (self.dot / self.count) / (p1 * p2).sqrt()
        };
        let correlation_percent = ((correlation * 10000.0).round() / 100.0).clamp(0.0, 100.0);
        Ok(DiffMetrics { max_diff_db, snr_db, correlation_percent, length_diff_seconds: 0.0 })
    }
}

/// FFmpeg decoding `path` to interleaved f32 on stdout, optionally remixed / resampled.
fn spawn_f32_decoder(
    path: &str,
    channels: Option<u32>,
    rate: Option<u32>,
    trim: Option<String>,
) -> Result<std::process::Child, Box<dyn std::error::Error + Send + Sync>> {
    let mut cmd = crate::audio::convert::hidden_command(&get_ffmpeg_executable());
    cmd.args(["-v", "error", "-nostdin", "-i", path, "-map", "0:a:0"]);
    if let Some(ch) = channels {
        cmd.args(["-ac", &ch.to_string()]);
    }
    let filters: Vec<String> = trim.into_iter().chain(rate.map(crate::audio::convert::resample_filter)).collect();
    if !filters.is_empty() {
        cmd.args(["-af", &filters.join(",")]);
    }
    cmd.args(["-c:a", "pcm_f32le", "-f", "f32le", "-"]);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    Ok(cmd.spawn()?)
}

/// Fills `buf` as far as the stream allows; returns the bytes read (short only at the end).
fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

/// Streams both files (the original remixed / resampled to the converted file's channel
/// count and rate) and compares them sample by sample. The first 250 frames are left
/// out when there is more (encoder start-up), as before.
fn compare_files(
    original: &str,
    converted: &str,
    range: Range,
    channel: Option<u32>,
    cancelled: &dyn Fn() -> bool,
) -> Result<DiffMetrics, Box<dyn std::error::Error + Send + Sync>> {
    let out = crate::audio::convert::probe_source(&get_ffmpeg_executable(), Path::new(converted)).map_err(|e| e.to_string())?;
    let src = crate::audio::convert::probe_source(&get_ffmpeg_executable(), Path::new(original)).map_err(|e| e.to_string())?;
    let channels = out.channels.unwrap_or(2).max(1) as usize;
    let src_channels = if channel.is_some() { Some(1) } else { src.channels };
    let remix = out.channels.filter(|c| src_channels != Some(*c));
    let resample = out.sample_rate.filter(|r| src.sample_rate != Some(*r));
    let trim = Some(part_filters(range, channel, src.sample_rate).join(",")).filter(|f| !f.is_empty());
    let mut a = spawn_f32_decoder(original, remix, resample, trim)?;
    let mut b = match spawn_f32_decoder(converted, None, None, None) {
        Ok(b) => b,
        Err(e) => {
            let _ = a.kill();
            let _ = a.wait();
            return Err(e);
        }
    };
    let result = (|| -> Result<DiffMetrics, Box<dyn std::error::Error + Send + Sync>> {
        let mut ra = a.stdout.take().ok_or("Failed to open stdout")?;
        let mut rb = b.stdout.take().ok_or("Failed to open stdout")?;
        let frame = 4 * channels;
        let mut ba = vec![0u8; frame * 8192];
        let mut bb = vec![0u8; frame * 8192];
        let (mut all, mut body) = (DiffAccumulator::default(), DiffAccumulator::default());
        let mut index = 0usize;
        let (mut total_a, mut total_b) = (0u64, 0u64);
        loop {
            if cancelled() {
                return Err(CANCELLED.into());
            }
            let na = read_full(&mut ra, &mut ba)?;
            let nb = read_full(&mut rb, &mut bb)?;
            total_a += na as u64;
            total_b += nb as u64;
            let n = na.min(nb) / 4 * 4;
            for (x, y) in ba[..n].chunks_exact(4).zip(bb[..n].chunks_exact(4)) {
                let s1 = f64::from(f32::from_le_bytes([x[0], x[1], x[2], x[3]]));
                let s2 = f64::from(f32::from_le_bytes([y[0], y[1], y[2], y[3]]));
                all.push(s1, s2);
                if index / channels >= 250 {
                    body.push(s1, s2);
                }
                index += 1;
            }
            if na < ba.len() || nb < bb.len() {
                break;
            }
        }
        // The rest of the longer stream: a cut-off output must not pass on its prefix.
        total_a += std::io::copy(&mut ra, &mut std::io::sink())?;
        total_b += std::io::copy(&mut rb, &mut std::io::sink())?;
        let mut metrics = if body.count > 0.0 { body.finish() } else { all.finish() }?;
        let rate = f64::from(out.sample_rate.unwrap_or(48000).max(1));
        metrics.length_diff_seconds = (total_b as f64 - total_a as f64) / frame as f64 / rate;
        Ok(metrics)
    })();
    for child in [&mut a, &mut b] {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
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
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
    channel: Option<u32>,
) -> VerifyQualityResponse {
    use tauri::Manager;
    let jobs = app.state::<crate::audio::convert::ActiveJobs>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = crate::audio::convert::job_cancelled_fn(jobs, job_id);
        let range = start_seconds.filter(|s| s.is_finite() && *s >= 0.0).map(|s| (s, end_seconds.filter(|e| e.is_finite() && *e > s)));
        verify_quality_part(&original_path, &converted_path, is_lossless_pair, range, channel, &cancelled)
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
    verify_quality_range(original_path, converted_path, is_lossless_pair, None, cancelled)
}

/// Like `verify_quality_blocking`; with `range`, the converted file is a track cut from
/// that range of the original.
pub fn verify_quality_range(
    original_path: &str,
    converted_path: &str,
    is_lossless_pair: bool,
    range: Range,
    cancelled: &dyn Fn() -> bool,
) -> VerifyQualityResponse {
    verify_quality_part(original_path, converted_path, is_lossless_pair, range, None, cancelled)
}

/// Like `verify_quality_range`; with `channel`, the converted file is that one channel.
pub fn verify_quality_part(
    original_path: &str,
    converted_path: &str,
    is_lossless_pair: bool,
    range: Range,
    channel: Option<u32>,
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

    // 0. DoP output of a DSD source: the DSD bits must come back unchanged.
    if range.is_none() && channel.is_none() {
        if let Ok(Some(same)) = crate::audio::convert::dsd::dop_matches(Path::new(&original_path), Path::new(&converted_path), cancelled) {
            if cancelled() {
                return failure(CANCELLED.into());
            }
            let (status, summary) = if same {
                ("perfect", "DoP: DSD ビット列が完全一致")
            } else {
                ("degraded", "DoP: DSD ビット列が一致しません")
            };
            return VerifyQualityResponse {
                success: true,
                result: Some(QualityVerificationDetails {
                    verified_at: now,
                    is_lossless_pair: true,
                    exact_match: same,
                    original_hash: None,
                    converted_hash: None,
                    snr_db: None,
                    max_diff_db: None,
                    correlation_percent: None,
                    has_high_freq_cutoff: false,
                    cutoff_freq_hz: None,
                    status: status.to_string(),
                    summary_message: summary.to_string(),
                    details: vec!["DoP (DSD over PCM) の 0x05 / 0xFA マーカーと 16 ビットずつの DSD データを元ファイルと比較しました。".to_string()],
                }),
                error: None,
            };
        }
    }

    // 1. Bit-exact SHA-256 Fingerprint check
    let orig_hash = compute_pcm_fingerprint_part(&original_path, range, channel, cancelled);
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
    // Compared at the output's rate and channel count (a 96 kHz limit on a 192 kHz
    // source, or a downmix, would otherwise be compared sample by sample at different
    // shapes), in 32-bit float so 24-bit and multichannel differences show.
    let analysis_result = compare_files(&original_path, &converted_path, range, channel, cancelled);
    if cancelled() {
        return failure(CANCELLED.into());
    }

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

    // Encoder delay and padding change the length by a few milliseconds at most.
    let (status, summary) = if metrics.length_diff_seconds.abs() > 0.1 {
        (
            "degraded".to_string(),
            format!("長さが元ファイルと {:+.2} 秒違います（出力が途中で切れている可能性）", metrics.length_diff_seconds),
        )
    } else if metrics.correlation_percent >= 99.0 && metrics.snr_db >= 30.0 {
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
        format!("長さの差: {:+.3} 秒", metrics.length_diff_seconds),
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
