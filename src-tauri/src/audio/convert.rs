use crate::audio::audit::{decode_to_temp_wav, get_ffmpeg_executable};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Jobs that may run. A job that is no longer in the map has been cancelled.
/// (The value is unused; kept for the command signatures.)
pub type ActiveJobs = Arc<Mutex<HashMap<String, u32>>>;

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

impl ConvertResponse {
    fn failure(error: String) -> Self {
        Self { success: false, path: None, file_name: None, error: Some(error) }
    }
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const STEM_LIMIT_CHARS: usize = 180;

/// Makes a single path component safe on Windows, macOS and Linux.
pub fn safe_file_name(name: &str) -> String {
    let mut clean: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\x1f' => '_',
            _ => c,
        })
        .collect();

    // Count characters, not bytes, so multi-byte names are never split mid-character.
    if clean.chars().count() > STEM_LIMIT_CHARS {
        clean = clean.chars().take(STEM_LIMIT_CHARS).collect();
    }
    while clean.ends_with(' ') || clean.ends_with('.') {
        clean.pop();
    }
    if clean.is_empty() {
        clean = "audio".to_string();
    }

    // Windows reserved device names, with or without an extension ("CON", "nul.txt", "COM1 .x").
    let base = clean.split('.').next().unwrap_or("").trim_end().to_ascii_lowercase();
    let reserved = matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        || ((base.starts_with("com") || base.starts_with("lpt"))
            && base.len() == 4
            && base.as_bytes()[3].is_ascii_digit()
            && base.as_bytes()[3] != b'0');
    if reserved {
        clean.insert(0, '_');
        // Stay within the limit so a second pass gives the same name.
        if clean.chars().count() > STEM_LIMIT_CHARS {
            clean = clean.chars().take(STEM_LIMIT_CHARS).collect();
            while clean.ends_with(' ') || clean.ends_with('.') {
                clean.pop();
            }
        }
    }
    clean
}

/// Output stem from the requested file name: its extension is dropped because the
/// output format decides the extension.
pub fn output_stem(requested: &str, input_path: &Path) -> String {
    let requested = requested.trim();
    let stem = if requested.is_empty() {
        input_path.file_stem().and_then(|s| s.to_str()).unwrap_or("audio").to_string()
    } else {
        match requested.rfind('.') {
            Some(i) if i > 0 => requested[..i].to_string(),
            _ => requested.to_string(),
        }
    };
    safe_file_name(&stem)
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutFormat {
    Wav,
    Aiff,
    Flac,
    Alac,
    WavPack,
    Mp3,
    M4a,
    Ogg,
    Opus,
    Ac3,
    Wma,
}

impl OutFormat {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.to_ascii_uppercase().as_str() {
            "WAV" => Self::Wav,
            "AIFF" => Self::Aiff,
            "FLAC" => Self::Flac,
            "ALAC" => Self::Alac,
            "WAVPACK" => Self::WavPack,
            "MP3" => Self::Mp3,
            "M4A" => Self::M4a,
            "OGG" => Self::Ogg,
            "OPUS" => Self::Opus,
            "AC3" => Self::Ac3,
            "WMA" => Self::Wma,
            _ => return None,
        })
    }

    pub fn ext(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Aiff => "aiff",
            Self::Flac => "flac",
            Self::Alac | Self::M4a => "m4a",
            Self::WavPack => "wv",
            Self::Mp3 => "mp3",
            Self::Ogg => "ogg",
            Self::Opus => "opus",
            Self::Ac3 => "ac3",
            Self::Wma => "wma",
        }
    }

    pub fn is_lossless(self) -> bool {
        matches!(self, Self::Wav | Self::Aiff | Self::Flac | Self::Alac | Self::WavPack)
    }

    fn supports_cover(self) -> bool {
        matches!(self, Self::Mp3 | Self::Flac | Self::M4a | Self::Alac)
    }
}

// ---------------------------------------------------------------------------
// Source probing
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceInfo {
    pub duration: f64,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub bits_per_sample: Option<u32>,
    pub is_float: bool,
    /// None when the codec is unknown.
    pub lossless: Option<bool>,
    /// Absolute stream index of an embedded JPEG/PNG cover ("attached pic").
    pub cover_stream: Option<u32>,
    /// The channel layout is not a named one (FFmpeg prints "2 channels (FL+FC)").
    pub custom_layout: bool,
    pub codec: Option<String>,
}

impl SourceInfo {
    pub fn has_art(&self) -> bool {
        self.cover_stream.is_some()
    }
}

const LOSSLESS_CODECS: &[&str] = &["flac", "alac", "wavpack", "ape", "tta", "tak", "mlp", "truehd", "shorten", "als"];
const LOSSY_CODECS: &[&str] = &[
    "mp3", "mp3float", "mp2", "mp2float", "aac", "aac_latm", "vorbis", "opus", "ac3", "eac3", "dts", "wmav1",
    "wmav2", "wmapro", "wmavoice", "musepack7", "musepack8", "amrnb", "amrwb", "atrac3", "atrac3p", "speex",
    "ra_144", "ra_288", "cook", "nellymoser", "gsm", "qdm2", "adpcm_ima_wav", "adpcm_ms",
];

pub fn codec_is_lossless(codec: &str) -> Option<bool> {
    let codec = codec.to_ascii_lowercase();
    if codec.starts_with("pcm_") {
        // A-law / mu-law are companded (lossy) PCM.
        return Some(!matches!(codec.as_str(), "pcm_alaw" | "pcm_mulaw"));
    }
    if codec.starts_with("dsd_") {
        return Some(false); // DSD -> PCM is never bit-exact
    }
    if LOSSLESS_CODECS.contains(&codec.as_str()) {
        return Some(true);
    }
    if LOSSY_CODECS.contains(&codec.as_str()) || codec.starts_with("adpcm_") {
        return Some(false);
    }
    None
}

/// `#0:3` / `#0:3[0x1](eng)` / `#0:3(eng)` -> 3
fn stream_index(line: &str) -> Option<u32> {
    let rest = line.split("Stream #").nth(1)?;
    let after_colon = rest.split(':').nth(1)?;
    let digits: String = after_colon.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Parses `ffmpeg -i <file>` stderr. Only the first audio stream is described.
/// Only lines with FFmpeg's own indentation are read, so tag values cannot be mistaken
/// for stream lines (FFmpeg prints continuation lines of multi-line tags as "    : ...").
pub fn parse_ffmpeg_probe(stderr: &str) -> SourceInfo {
    let mut info = SourceInfo::default();
    let mut audio_seen = false;
    for raw in stderr.lines() {
        if let Some(rest) = raw.strip_prefix("  Duration: ") {
            if let Some(time) = rest.split(',').next() {
                info.duration = parse_hms(time.trim()).unwrap_or(0.0);
            }
            continue;
        }
        let indent = raw.len() - raw.trim_start().len();
        let line = raw.trim();
        if !(indent == 2 || indent == 4) || !line.starts_with("Stream #") {
            continue;
        }
        if line.contains("Video: ") {
            if line.contains("(attached pic)") && info.cover_stream.is_none() {
                let codec = line.split("Video: ").nth(1).and_then(|d| d.split([' ', ',']).next()).unwrap_or("");
                // JPEG and PNG are the only cover formats every target container accepts.
                if matches!(codec, "mjpeg" | "png") {
                    info.cover_stream = stream_index(line);
                }
            }
            continue;
        }
        if audio_seen {
            continue;
        }
        let Some(idx) = line.find("Audio: ") else { continue };
        audio_seen = true;
        let desc = &line[idx + 7..];
        let codec = desc.split([' ', ',']).next().unwrap_or("").to_string();
        let parts: Vec<&str> = desc.split(", ").map(str::trim).collect();
        let mut hz_index = None;
        for (i, part) in parts.iter().enumerate() {
            if let Some(hz) = part.strip_suffix(" Hz") {
                info.sample_rate = hz.trim().parse().ok();
                hz_index = Some(i);
                break;
            }
        }
        // "<codec>, <rate> Hz, <layout>, <sample format>[ (<bits> bit)], ..."
        let layout = hz_index.and_then(|i| parts.get(i + 1));
        let fmt = hz_index.and_then(|i| parts.get(i + 2));
        if let Some(layout) = layout {
            info.channels = channels_from_layout(layout);
            info.custom_layout = layout.split_whitespace().nth(1).is_some_and(|w| w.starts_with("channels"));
        }
        info.lossless = codec_is_lossless(&codec);
        if let Some(fmt) = fmt {
            let fmt_name = fmt.split_whitespace().next().unwrap_or("");
            info.is_float = matches!(fmt_name, "flt" | "fltp" | "dbl" | "dblp");
            if let Some(start) = fmt.find('(') {
                if let Some(bits) = fmt[start + 1..].strip_suffix(" bit)") {
                    info.bits_per_sample = bits.trim().parse().ok();
                }
            }
            if info.bits_per_sample.is_none() && info.lossless == Some(true) {
                info.bits_per_sample = match fmt_name {
                    "u8" | "u8p" => Some(8),
                    "s16" | "s16p" => Some(16),
                    "s32" | "s32p" | "flt" | "fltp" => Some(pcm_bits(&codec).unwrap_or(32)),
                    "s64" | "s64p" | "dbl" | "dblp" => Some(64),
                    _ => pcm_bits(&codec),
                };
            }
        }
        // Lossy decoders output float samples; that is not the source's precision.
        if codec.starts_with("pcm_f") {
            info.is_float = true;
        } else if info.lossless != Some(true) {
            info.is_float = false;
        }
        info.codec = Some(codec);
    }
    info
}

fn pcm_bits(codec: &str) -> Option<u32> {
    if !codec.starts_with("pcm_") {
        return None;
    }
    let digits: String = codec
        .trim_start_matches("pcm_")
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn channels_from_layout(layout: &str) -> Option<u32> {
    // "6 channels", "2 channels (FL+FC)", "24 channels (...)"
    let mut words = layout.split_whitespace();
    if let (Some(n), Some(w)) = (words.next(), words.next()) {
        if w.starts_with("channels") {
            return n.parse().ok();
        }
    }
    let name = layout.split_whitespace().next().unwrap_or(layout);
    let base = name.split('(').next().unwrap_or(name);
    Some(match base {
        "mono" => 1,
        "stereo" | "downmix" => 2,
        "2.1" | "3.0" => 3,
        "4.0" | "quad" | "3.1" => 4,
        "5.0" | "4.1" => 5,
        "5.1" | "6.0" | "hexagonal" | "3.1.2" => 6,
        "6.1" | "7.0" => 7,
        "7.1" | "octagonal" | "5.1.2" | "cube" => 8,
        "5.1.4" | "7.1.2" => 10,
        "7.1.4" | "7.2.3" => 12,
        "hexadecagonal" => 16,
        "22.2" => 24,
        _ => return None,
    })
}

fn parse_hms(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let sec: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// A command that never opens a console window on Windows.
pub(crate) fn hidden_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub fn probe_source(ffmpeg: &Path, input: &Path) -> Result<SourceInfo, String> {
    let output = hidden_command(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-i"])
        .arg(input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut info = parse_ffmpeg_probe(&stderr);
    if info.codec.is_none() {
        return Err("No audio stream found in the input file".to_string());
    }

    // lofty knows the real bit depth of containers where FFmpeg only reports the
    // decoder sample format (e.g. 24-bit ALAC decodes to s32p).
    if let Ok(tagged) = lofty::probe::Probe::open(input).and_then(|p| p.read()) {
        let props = lofty::file::AudioFile::properties(&tagged);
        if let Some(bits) = props.bit_depth() {
            if info.lossless == Some(true) {
                info.bits_per_sample = Some(bits as u32);
            }
        }
        if info.sample_rate.is_none() {
            info.sample_rate = props.sample_rate();
        }
        if info.channels.is_none() {
            info.channels = props.channels().map(u32::from);
        }
        if info.duration <= 0.0 {
            info.duration = props.duration().as_secs_f64();
        }
    }
    Ok(info)
}

// ---------------------------------------------------------------------------
// FFmpeg arguments
// ---------------------------------------------------------------------------

/// Sample rates each lossy encoder accepts (None = any rate).
fn lossy_rates(format: OutFormat) -> Option<&'static [u32]> {
    match format {
        OutFormat::Mp3 => Some(&[8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]),
        OutFormat::Opus => Some(&[48000]),
        OutFormat::Ac3 => Some(&[32000, 44100, 48000]),
        OutFormat::Wma => Some(&[8000, 11025, 16000, 22050, 32000, 44100, 48000]),
        OutFormat::M4a => Some(&[8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000]),
        OutFormat::Ogg => Some(&[8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000]),
        _ => None,
    }
}

/// The rate to encode at: the requested one if the encoder accepts it, else the
/// highest accepted rate below it, preferring whole-number ratios (88.2k -> 44.1k).
pub fn pick_rate(format: OutFormat, wanted: u32) -> u32 {
    let Some(rates) = lossy_rates(format) else { return wanted };
    if rates.contains(&wanted) {
        return wanted;
    }
    let below: Vec<u32> = rates.iter().copied().filter(|&r| r <= wanted).collect();
    if let Some(r) = below.iter().copied().filter(|&r| wanted % r == 0).max() {
        return r;
    }
    below.into_iter().max().unwrap_or(rates[0])
}

fn max_channels(format: OutFormat) -> u32 {
    match format {
        OutFormat::Mp3 | OutFormat::Wma => 2,
        OutFormat::Ac3 => 6,
        OutFormat::Ogg | OutFormat::Opus | OutFormat::M4a => 8,
        _ => u32::MAX,
    }
}

/// Vorbis quality (-q:a) roughly matching a stereo bitrate. Vorbis's bitrate mode
/// fails for many rate/channel combinations; quality mode works everywhere.
fn vorbis_quality(kbps: u32) -> f64 {
    const POINTS: [(u32, f64); 10] =
        [(48, -1.0), (64, 0.0), (96, 2.0), (112, 3.0), (128, 4.0), (160, 5.0), (192, 6.0), (224, 7.0), (256, 8.0), (320, 9.0)];
    if kbps <= POINTS[0].0 {
        return POINTS[0].1;
    }
    for w in POINTS.windows(2) {
        let ((b0, q0), (b1, q1)) = (w[0], w[1]);
        if kbps <= b1 {
            return q0 + (q1 - q0) * f64::from(kbps - b0) / f64::from(b1 - b0);
        }
    }
    10.0f64.min(9.0 + f64::from(kbps - 320) / 180.0)
}

pub struct EncodePlan {
    pub args: Vec<String>,
    /// Bit depth the output must have (lossless outputs only).
    pub expected_bits: Option<u32>,
}

fn same_as_source(settings: &ConverterSettings) -> bool {
    settings.same_as_source.unwrap_or(true)
}

/// FFmpeg layout for a channel count (the layouts Opus and most players expect).
fn layout_name(channels: u32) -> String {
    match channels {
        1 => "mono".into(),
        2 => "stereo".into(),
        3 => "3.0".into(),
        4 => "quad".into(),
        5 => "5.0".into(),
        6 => "5.1".into(),
        7 => "6.1".into(),
        8 => "7.1".into(),
        n => format!("{n}c"),
    }
}

/// Output sample rate and channel count.
pub fn target_shape(format: OutFormat, settings: &ConverterSettings, source: &SourceInfo) -> (Option<u32>, Option<u32>) {
    let (rate, channels) = if same_as_source(settings) {
        (source.sample_rate, source.channels)
    } else {
        (settings.sample_rate.or(source.sample_rate), settings.channels.or(source.channels))
    };
    if format.is_lossless() {
        return (rate, channels);
    }
    (rate.map(|r| pick_rate(format, r)), channels.map(|c| c.min(max_channels(format))))
}

/// Filters applied before any gain: silence trimming (explicit mode only), then the
/// sample rate / channel layout conversion. Normalization measures the signal after
/// these, because a channel remix changes the level (e.g. mono -> stereo is -3 dB).
///
/// Channel changes are done here with an explicit layout and never with `-ac`: `-ac`
/// appends FFmpeg's default layout for the count (3 -> 2.1, 4 -> 4.0), which Opus
/// rejects and which reorders 3.0 / quad sources.
pub fn pre_gain_filters(format: OutFormat, settings: &ConverterSettings, source: &SourceInfo) -> Vec<String> {
    let mut filters = Vec::new();
    if !same_as_source(settings) && settings.trim_silence.unwrap_or(false) {
        let db = settings.trim_silence_threshold_db.unwrap_or(-50.0);
        let trim = format!("silenceremove=start_periods=1:start_duration=0:start_threshold={db}dB:detection=peak:window=0.001");
        filters.extend([trim.clone(), "areverse".into(), trim, "areverse".into()]);
    }
    let (rate, channels) = target_shape(format, settings, source);
    // FFmpeg's resampler cannot convert from unnamed layouts (e.g. FL+FC). Relabel the
    // channels in their existing order with the standard layout for that count first.
    let remix = channels.is_some_and(|ch| !format.is_lossless() || Some(ch) != source.channels);
    if source.custom_layout && remix {
        if let Some(n) = source.channels {
            filters.push(format!("channelmap=channel_layout={}", layout_name(n)));
        }
    }
    let mut constraints = Vec::new();
    if let Some(sr) = rate.filter(|&sr| Some(sr) != source.sample_rate) {
        constraints.push(format!("sample_rates={sr}"));
    }
    // Lossy encoders only accept standard layouts, so always name one for them. Lossless
    // outputs keep the source layout untouched unless the channel count changes.
    if let Some(ch) = channels.filter(|&ch| !format.is_lossless() || Some(ch) != source.channels) {
        constraints.push(format!("channel_layouts={}", layout_name(ch)));
    }
    if !constraints.is_empty() {
        filters.push(format!("aformat={}", constraints.join(":")));
    }
    filters
}

/// Builds the FFmpeg command for the main encode. `gain_db` is the volume change to
/// apply (from normalization or the manual boost); it is ignored in "same as source" mode.
pub fn build_encode_args(
    format: OutFormat,
    input: &Path,
    output: &Path,
    settings: &ConverterSettings,
    source: &SourceInfo,
    tags: &TagMap,
    gain_db: Option<f64>,
) -> Result<EncodePlan, String> {
    let keep = same_as_source(settings);
    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), input.to_string_lossy().into_owned(), "-map".into(), "0:a:0".into()];

    // Tags are always written explicitly from `tags` (source + edits): containers keep
    // them in different places (Ogg in the stream, MP3/FLAC/MP4 globally) and some
    // muxers write FFmpeg key names verbatim (APEv2), so a blind copy is unreliable.
    args.extend(["-map_metadata".into(), "-1".into()]);

    if format.supports_cover() {
        if let Some(index) = source.cover_stream {
            args.extend(["-map".into(), format!("0:{index}"), "-c:v".into(), "copy".into(), "-disposition:v:0".into(), "attached_pic".into()]);
        }
    }

    // Bit depth. In explicit mode the UI's "32-bit" means 32-bit float.
    let (depth, float_out): (Option<u32>, bool) = if keep {
        (source.bits_per_sample.or(if source.lossless == Some(false) { Some(24) } else { None }), source.is_float)
    } else {
        let d: u32 = settings.bit_depth.as_deref().unwrap_or("16").parse().map_err(|_| "Invalid bit depth setting".to_string())?;
        (Some(d), d == 32)
    };
    if format.is_lossless() {
        match depth {
            Some(8 | 16 | 24 | 32 | 64) => {}
            _ => return Err("Cannot determine a supported source bit depth".into()),
        }
    }
    let d = depth.unwrap_or(16);
    let float_out = float_out && format.is_lossless();
    let name = format.ext().to_uppercase();
    if float_out && matches!(format, OutFormat::Flac | OutFormat::Alac) {
        return Err(format!("{name} cannot store floating-point audio; choose WAV, AIFF or WavPack, or 24-bit"));
    }
    if (matches!(format, OutFormat::Flac | OutFormat::Alac) && d > 24)
        || (format == OutFormat::WavPack && d > 32)
        || (format == OutFormat::Aiff && d > 32 && !float_out)
    {
        return Err(format!("{name} cannot store {d}-bit audio without losing precision; choose WAV, or 24-bit"));
    }
    // 8-bit is stored as 16-bit in FLAC/ALAC/WavPack: same sample values, still lossless.
    let stored_bits = if d == 8 && matches!(format, OutFormat::Flac | OutFormat::Alac | OutFormat::WavPack) { 16 } else { d };

    let mut filters = pre_gain_filters(format, settings, source);
    let gain = if keep { None } else { gain_db.filter(|g| g.is_finite() && *g != 0.0) };
    if let Some(g) = gain {
        filters.push(format!("volume={g:.4}dB"));
    }

    let (rate, channels) = target_shape(format, settings, source);
    if let Some(sr) = rate {
        args.extend(["-ar".into(), sr.to_string()]);
    }
    if !filters.is_empty() {
        args.extend(["-af".into(), filters.join(",")]);
    }

    let be = format == OutFormat::Aiff;
    let pcm = if float_out {
        format!("pcm_f{}{}", if d == 64 { 64 } else { 32 }, if be { "be" } else { "le" })
    } else if d == 8 {
        if be { "pcm_s8".to_string() } else { "pcm_u8".to_string() }
    } else {
        format!("pcm_s{}{}", d, if be { "be" } else { "le" })
    };
    let codec = match format {
        OutFormat::Wav | OutFormat::Aiff => pcm.as_str(),
        OutFormat::Flac => "flac",
        OutFormat::Alac => "alac",
        OutFormat::WavPack => "wavpack",
        OutFormat::Mp3 => "libmp3lame",
        OutFormat::M4a => "aac",
        OutFormat::Ogg => "libvorbis",
        OutFormat::Opus => "libopus",
        OutFormat::Ac3 => "ac3",
        OutFormat::Wma => "wmav2",
    };
    let threads = settings.thread_pool_size.unwrap_or(1).clamp(1, 16);
    args.extend(["-c:a".into(), codec.into(), "-threads".into(), threads.to_string()]);

    if matches!(format, OutFormat::Flac | OutFormat::Alac | OutFormat::WavPack) {
        let planar = matches!(format, OutFormat::Alac | OutFormat::WavPack);
        let sample_fmt = if format == OutFormat::WavPack && float_out {
            "fltp".to_string()
        } else {
            format!("{}{}", if stored_bits > 16 { "s32" } else { "s16" }, if planar { "p" } else { "" })
        };
        args.extend(["-sample_fmt".into(), sample_fmt, "-bits_per_raw_sample".into(), stored_bits.to_string()]);
    }

    if !format.is_lossless() {
        let kbps: u32 = settings.bitrate.as_deref().unwrap_or("192").trim().parse().unwrap_or(192).clamp(8, 640);
        let ch = channels.unwrap_or(2).max(1);
        match format {
            OutFormat::Ogg => args.extend(["-q:a".into(), format!("{:.1}", vorbis_quality(kbps))]),
            OutFormat::Opus => args.extend(["-b:a".into(), format!("{}k", kbps.min(256 * ch).min(510))]),
            OutFormat::Mp3 => args.extend(["-b:a".into(), format!("{}k", kbps.min(320))]),
            _ => args.extend(["-b:a".into(), format!("{kbps}k")]),
        }
    }

    if format == OutFormat::Aiff {
        args.extend(["-write_id3v2".into(), "1".into()]);
    }
    let gain_applied = gain.is_some();
    match format {
        OutFormat::Wav => {} // written as an ID3 chunk after encoding
        OutFormat::Ogg | OutFormat::Opus => {
            for (key, value) in split_totals_for_vorbis(tags_for_output(tags, gain_applied)) {
                args.extend(["-metadata:s:a:0".into(), format!("{key}={value}")]);
            }
        }
        OutFormat::Flac => {
            for (key, value) in split_totals_for_vorbis(tags_for_output(tags, gain_applied)) {
                args.extend(["-metadata".into(), format!("{key}={value}")]);
            }
        }
        OutFormat::WavPack => {
            for (key, value) in tags_for_output(tags, gain_applied) {
                args.extend(["-metadata".into(), format!("{}={value}", ape_key(&key))]);
            }
        }
        _ => {
            for (key, value) in tags_for_output(tags, gain_applied) {
                args.extend(["-metadata".into(), format!("{key}={value}")]);
            }
        }
    }

    args.extend(["-progress".into(), "pipe:1".into(), "-nostats".into(), output.to_string_lossy().into_owned()]);
    Ok(EncodePlan { args, expected_bits: if format.is_lossless() { Some(stored_bits) } else { None } })
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/// Tag list with FFmpeg's generic lower-case key names ("title", "album_artist", "date", ...).
pub type TagMap = Vec<(String, String)>;

/// Keys that describe the old file or encoder, not the music. Never copied.
const DROPPED_KEYS: &[&str] = &[
    "encoder", "encoded_by_ffmpeg", "major_brand", "minor_version", "compatible_brands", "creation_time",
    "itunsmpb", "itunnorm", "tlen", "handler_name", "vendor_id", "duration",
];

fn is_replaygain_key(key: &str) -> bool {
    key.starts_with("replaygain_") || key.starts_with("r128_")
}

/// Tags to write: drops encoder/container keys, and loudness tags when the volume changed.
fn tags_for_output(tags: &TagMap, gain_applied: bool) -> Vec<(String, String)> {
    tags.iter()
        .filter(|(k, v)| {
            !k.is_empty()
                && !k.contains('=')
                && !v.is_empty()
                && !DROPPED_KEYS.contains(&k.as_str())
                && !(gain_applied && is_replaygain_key(k))
        })
        .cloned()
        .collect()
}

/// APEv2 item names used by WavPack (FFmpeg's APE writer stores key names verbatim).
fn ape_key(key: &str) -> String {
    match key {
        "title" => "Title",
        "artist" => "Artist",
        "album" => "Album",
        "album_artist" => "Album Artist",
        "track" => "Track",
        "disc" => "Disc",
        "date" => "Year",
        "genre" => "Genre",
        "comment" => "Comment",
        "composer" => "Composer",
        "copyright" => "Copyright",
        "lyrics" => "Lyrics",
        other => return other.to_string(),
    }
    .to_string()
}

/// Edited tags from the request, as FFmpeg keys. "" means "remove this tag".
pub fn edit_pairs(t: &InputTags) -> Vec<(&'static str, String)> {
    let fields: [(&'static str, &Option<String>); 9] = [
        ("title", &t.title),
        ("artist", &t.artist),
        ("album", &t.album),
        ("album_artist", &t.album_artist),
        ("track", &t.track),
        ("disc", &t.disc),
        ("date", &t.year),
        ("genre", &t.genre),
        ("comment", &t.comment),
    ];
    fields.into_iter().filter_map(|(k, v)| v.clone().map(|v| (k, v))).collect()
}

/// Source tags with the request's edits applied. Keys are compared case-insensitively.
pub fn merge_tags(source: &TagMap, edits: Option<&InputTags>) -> TagMap {
    let mut merged: TagMap = Vec::new();
    for (k, v) in source {
        let k = k.to_ascii_lowercase();
        if let Some(existing) = merged.iter_mut().find(|(ek, _)| *ek == k) {
            existing.1 = v.clone(); // last value wins, like FFmpeg
        } else {
            merged.push((k, v.clone()));
        }
    }
    if let Some(e) = edits {
        for (k, mut v) in edit_pairs(e) {
            // Editing "3" over a source "3/12" keeps the total.
            if matches!(k, "track" | "disc") && !v.is_empty() && !v.contains('/') {
                let total = merged.iter().find(|(ek, _)| ek == k).and_then(|(_, sv)| sv.split_once('/')).map(|(_, t)| t.trim().to_string());
                if let Some(total) = total.filter(|t| !t.is_empty()) {
                    v = format!("{}/{total}", v.trim());
                }
            }
            merged.retain(|(ek, _)| ek != k);
            if !v.is_empty() {
                merged.push((k.to_string(), v));
            }
        }
    }
    merged
}

/// Parses FFmpeg's `ffmetadata` output (global section only).
pub fn parse_ffmetadata(text: &str) -> TagMap {
    let mut out = Vec::new();
    let mut lines = text.lines();
    let mut pending: Option<String> = None;
    loop {
        let line = match (pending.take(), lines.next()) {
            (Some(p), _) => p,
            (None, Some(l)) => l.to_string(),
            (None, None) => break,
        };
        if line.starts_with('[') {
            break; // [STREAM] / [CHAPTER] sections
        }
        if line.starts_with(';') || line.starts_with('#') || line.is_empty() {
            continue;
        }
        // A trailing unescaped backslash continues the value on the next line.
        let mut raw = line;
        while raw.chars().rev().take_while(|&c| c == '\\').count() % 2 == 1 {
            raw.pop();
            raw.push('\n');
            match lines.next() {
                Some(next) => raw.push_str(next),
                None => break,
            }
        }
        let mut key = String::new();
        let mut value = String::new();
        let mut in_value = false;
        let mut chars = raw.chars();
        while let Some(c) = chars.next() {
            let target = if in_value { &mut value } else { &mut key };
            match c {
                '\\' => {
                    if let Some(n) = chars.next() {
                        target.push(n);
                    }
                }
                '=' if !in_value => in_value = true,
                _ => target.push(c),
            }
        }
        if in_value && !key.is_empty() {
            out.push((key.to_ascii_lowercase(), value));
        }
    }
    out
}

fn read_ffmetadata(ffmpeg: &Path, input: &Path, from: &str) -> Result<TagMap, String> {
    let output = hidden_command(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
        .args(["-map_metadata", from, "-f", "ffmetadata", "-"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    if !output.status.success() {
        return Err("Could not read the source tags".into());
    }
    Ok(parse_ffmetadata(&String::from_utf8_lossy(&output.stdout)))
}

/// Maps container-specific key names to FFmpeg's generic ones and folds separate
/// totals into "n/total" (APEv2 "Album Artist"/"Year", Vorbis TRACKTOTAL/DISCTOTAL...).
pub fn normalize_tags(tags: TagMap) -> TagMap {
    let mut out: TagMap = Vec::new();
    let mut totals: Vec<(&'static str, String)> = Vec::new();
    for (k, v) in tags {
        let k = k.to_ascii_lowercase();
        let key = match k.as_str() {
            "album artist" | "albumartist" | "album_artist" => "album_artist".to_string(),
            "year" | "date" => "date".to_string(),
            "tracknumber" | "track" => "track".to_string(),
            "discnumber" | "disc" | "disk" => "disc".to_string(),
            "tracktotal" | "totaltracks" => {
                totals.push(("track", v));
                continue;
            }
            "disctotal" | "totaldiscs" => {
                totals.push(("disc", v));
                continue;
            }
            _ => k,
        };
        if let Some(existing) = out.iter_mut().find(|(ek, _)| *ek == key) {
            if existing.1.is_empty() {
                existing.1 = v;
            }
        } else {
            out.push((key, v));
        }
    }
    for (key, total) in totals {
        let total = total.trim().to_string();
        if total.is_empty() {
            continue;
        }
        if let Some(entry) = out.iter_mut().find(|(ek, _)| ek == key) {
            if !entry.1.contains('/') && !entry.1.trim().is_empty() {
                entry.1 = format!("{}/{total}", entry.1.trim());
            }
        }
    }
    out
}

/// Vorbis comments (FLAC, Ogg, Opus) keep totals in separate fields.
fn split_totals_for_vorbis(tags: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (k, v) in tags {
        match (k.as_str(), v.split_once('/')) {
            ("track" | "disc", Some((n, total))) => {
                let total_key = if k == "track" { "tracktotal" } else { "disctotal" };
                out.push((k.clone(), n.trim().to_string()));
                if !total.trim().is_empty() {
                    out.push((total_key.to_string(), total.trim().to_string()));
                }
            }
            _ => out.push((k, v)),
        }
    }
    out
}

/// Reads the source's tags from wherever the container keeps them: globally
/// (MP3, FLAC, MP4, WAV...) or in the audio stream (Ogg Vorbis/Opus). Both are read
/// and combined; a global value wins over a stream value with the same key.
pub fn read_source_tags(ffmpeg: &Path, input: &Path) -> Result<TagMap, String> {
    let mut tags = normalize_tags(read_ffmetadata(ffmpeg, input, "0")?);
    if let Ok(stream) = read_ffmetadata(ffmpeg, input, "0:s:a:0") {
        for (k, v) in normalize_tags(stream) {
            if !tags.iter().any(|(gk, _)| *gk == k) {
                tags.push((k, v));
            }
        }
    }
    Ok(tags)
}

// ---------------------------------------------------------------------------
// WAV ID3 tags
// ---------------------------------------------------------------------------

fn id3_size(n: usize) -> [u8; 4] {
    [((n >> 21) & 0x7f) as u8, ((n >> 14) & 0x7f) as u8, ((n >> 7) & 0x7f) as u8, (n & 0x7f) as u8]
}

fn utf16_bom(s: &str) -> Vec<u8> {
    let mut v = vec![0xff, 0xfe];
    for u in s.encode_utf16() {
        v.extend_from_slice(&u.to_le_bytes());
    }
    v
}

/// ID3v2.3 tag with UTF-16 text frames (WAV `id3 ` chunk payload). None when there is nothing to write.
pub fn build_id3v23(tags: &TagMap) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    let mut push_frame = |id: &[u8; 4], payload: Vec<u8>| {
        body.extend_from_slice(id);
        body.extend_from_slice(&(payload.len() as u32).to_be_bytes()); // v2.3: plain 32-bit size
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(&payload);
    };
    for (key, value) in tags {
        if value.is_empty() {
            continue;
        }
        let id: &[u8; 4] = match key.as_str() {
            "title" => b"TIT2",
            "artist" => b"TPE1",
            "album" => b"TALB",
            "album_artist" => b"TPE2",
            "track" => b"TRCK",
            "disc" => b"TPOS",
            "genre" => b"TCON",
            "composer" => b"TCOM",
            "copyright" => b"TCOP",
            "publisher" => b"TPUB",
            "date" => {
                // v2.3 TYER holds exactly four digits.
                let year: String = value.chars().take(4).collect();
                if year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()) {
                    let mut payload = vec![1];
                    payload.extend(utf16_bom(&year));
                    push_frame(b"TYER", payload);
                }
                continue;
            }
            "comment" => {
                let mut payload = vec![1];
                payload.extend_from_slice(b"eng");
                payload.extend(utf16_bom("")); // empty description
                payload.extend_from_slice(&[0, 0]);
                payload.extend(utf16_bom(value));
                push_frame(b"COMM", payload);
                continue;
            }
            _ => continue,
        };
        let mut payload = vec![1];
        payload.extend(utf16_bom(value));
        push_frame(id, payload);
    }
    if body.is_empty() {
        return None;
    }
    let mut tag = vec![b'I', b'D', b'3', 3, 0, 0];
    tag.extend_from_slice(&id3_size(body.len()));
    tag.extend(body);
    Some(tag)
}

pub fn append_wav_tags(file: &Path, tags: &TagMap) -> Result<(), String> {
    let Some(id3) = build_id3v23(tags) else { return Ok(()) };
    let mut f = OpenOptions::new().read(true).write(true).open(file).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut chunk = Vec::with_capacity(id3.len() + 10);
    if size % 2 == 1 {
        chunk.push(0); // pad the previous chunk to a word boundary
    }
    chunk.extend_from_slice(b"id3 ");
    chunk.extend_from_slice(&(id3.len() as u32).to_le_bytes());
    chunk.extend_from_slice(&id3);
    if id3.len() % 2 == 1 {
        chunk.push(0);
    }
    // RIFF chunks are word aligned; FFmpeg's output always has an even size.
    let new_riff = size + chunk.len() as u64 - 8;
    if new_riff > u32::MAX as u64 {
        return Err("WAV exceeds the 4 GB RIFF size limit".into());
    }
    let mut head = [0u8; 12];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" {
        return Err("Output is not a RIFF/WAVE file".into());
    }
    f.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    f.write_all(&chunk).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
    f.write_all(&(new_riff as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Running FFmpeg with progress and cancellation
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct JobCtx {
    app: Option<AppHandle>,
    jobs: ActiveJobs,
    job_id: Option<String>,
}

impl JobCtx {
    fn cancelled(&self) -> bool {
        match &self.job_id {
            Some(id) => self.jobs.lock().map(|j| !j.contains_key(id)).unwrap_or(true),
            None => false,
        }
    }

    fn check(&self) -> Result<(), String> {
        if self.cancelled() { Err("Conversion cancelled".into()) } else { Ok(()) }
    }

    fn emit(&self, phase: &str, progress: f64) {
        if let Some(app) = &self.app {
            let _ = app.emit(
                "conversion-progress",
                ProgressPayload { job_id: self.job_id.clone().unwrap_or_default(), phase: phase.into(), progress },
            );
        }
    }
}

/// Runs FFmpeg, reporting `out_time_us` as a percentage of `duration`. Returns stderr.
fn run_ffmpeg(ctx: &JobCtx, ffmpeg: &Path, args: &[String], duration: f64, phase: &str) -> Result<String, String> {
    ctx.check()?;
    let mut child = hidden_command(ffmpeg)
        .args(["-nostdin", "-hide_banner"])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;

    let stdout = child.stdout.take();
    let progress_ctx = ctx.clone();
    let phase_name = phase.to_string();
    let reader = std::thread::spawn(move || {
        let Some(out) = stdout else { return };
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = us.trim().parse::<f64>() {
                    if duration > 0.0 {
                        let pct = (us / 1_000_000.0 / duration * 100.0).clamp(0.0, 99.0);
                        progress_ctx.emit(&phase_name, pct);
                    }
                }
            }
        }
    });

    // Drain stderr concurrently so FFmpeg never blocks on a full pipe. Keep the tail only.
    let stderr = child.stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut tail: Vec<u8> = Vec::new();
        if let Some(mut err) = stderr {
            let mut buf = [0u8; 8192];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buf[..n]);
                if tail.len() > 65536 {
                    tail.drain(..tail.len() - 32768);
                }
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });

    // Poll instead of blocking so a cancel can stop FFmpeg through the owned handle.
    // Killing by handle (not by PID) cannot hit an unrelated process that reused the PID.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                if ctx.cancelled() {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err("Conversion cancelled".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("FFmpeg did not finish: {e}"));
            }
        }
    };
    let _ = reader.join();
    let stderr_text = err_reader.join().unwrap_or_default();
    let status = status?;
    ctx.check()?;
    if !status.success() {
        let tail: String = stderr_text.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(format!("FFmpeg failed ({status}): {tail}"));
    }
    Ok(stderr_text)
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/// Places `staging` at `destination` without ever replacing an existing file.
/// Returns `AlreadyExists` if the destination is taken.
fn publish_output(staging: &Path, destination: &Path) -> std::io::Result<()> {
    match fs::hard_link(staging, destination) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => {} // FAT/exFAT, network shares, etc.: fall back to an exclusive copy
    }
    let mut writer = OpenOptions::new().write(true).create_new(true).open(destination)?;
    let result = (|| {
        let mut reader = File::open(staging)?;
        std::io::copy(&mut reader, &mut writer)?;
        writer.sync_all()
    })();
    if result.is_err() {
        drop(writer);
        let _ = fs::remove_file(destination);
    }
    result
}

fn publish_unique(staging: &Path, dir: &Path, stem: &str, ext: &str, ctx: &JobCtx) -> Result<PathBuf, String> {
    for i in 0..10000 {
        ctx.check()?;
        let name = if i == 0 { format!("{stem}.{ext}") } else { format!("{stem} ({i}).{ext}") };
        let destination = dir.join(name);
        match publish_output(staging, &destination) {
            Ok(()) => return Ok(destination),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to save output file: {e}")),
        }
    }
    Err("Too many output file name collisions".into())
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// "~" and "~/x" -> the user's home folder (the UI's default paths use this form).
pub fn expand_home(p: &str) -> PathBuf {
    let rest = if p == "~" {
        Some("")
    } else {
        p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\"))
    };
    match (rest, dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

fn target_dir(request: &ConvertRequest, input: &Path) -> Result<PathBuf, String> {
    if request.settings.save_in_source_folder.unwrap_or(false) {
        return Ok(input.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(".")));
    }
    match request.settings.local_save_path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => {
            let path = expand_home(p);
            if path.is_absolute() {
                Ok(path)
            } else {
                Err(format!("The output folder must be an absolute path: {p}"))
            }
        }
        _ => Err("No output folder is set".into()),
    }
}

fn convert_blocking(ctx: &JobCtx, request: &ConvertRequest) -> Result<(PathBuf, String), String> {
    // Absolute, resolved input path: FFmpeg reads relative names like "concat:a|b"
    // or "-x" as protocols/options.
    let input = fs::canonicalize(&request.input_file_path).map_err(|_| "Input file does not exist".to_string())?;
    if !input.is_file() {
        return Err("Input file does not exist".into());
    }
    let format = OutFormat::parse(&request.output_format)
        .ok_or_else(|| format!("Unsupported output format: {}", request.output_format))?;
    let ext = format.ext();
    let dir = target_dir(request, &input)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create output folder {}: {e}", dir.display()))?;
    let stem = output_stem(&request.file_name, &input);

    let ffmpeg = get_ffmpeg_executable();
    let source = probe_source(&ffmpeg, &input)?;
    ctx.check()?;

    let work = TempDir(std::env::temp_dir().join(format!("audio-convert-{}", uuid::Uuid::new_v4().simple())));
    fs::create_dir_all(&work.0).map_err(|e| e.to_string())?;
    let temp_output = work.0.join(format!("output.{ext}"));

    let settings = &request.settings;
    let mut gain_db = None;
    if !same_as_source(settings) {
        if settings.normalize.unwrap_or(false) {
            ctx.emit("normalizing", 0.0);
            let mut filters = pre_gain_filters(format, settings, &source);
            filters.push("volumedetect".into());
            let args: Vec<String> = vec![
                "-i".into(),
                input.to_string_lossy().into_owned(),
                "-map".into(),
                "0:a:0".into(),
                "-af".into(),
                filters.join(","),
                "-progress".into(),
                "pipe:1".into(),
                "-nostats".into(),
                "-f".into(),
                "null".into(),
                "-".into(),
            ];
            let log = run_ffmpeg(ctx, &ffmpeg, &args, source.duration, "normalizing")?;
            let peak = parse_max_volume(&log).ok_or("Peak analysis for normalization failed")?;
            if peak.is_finite() {
                gain_db = Some(settings.normalization_target_db.unwrap_or(-1.0) - peak);
            }
        } else {
            gain_db = settings.volume_boost_db;
        }
    }

    let tags = merge_tags(&read_source_tags(&ffmpeg, &input).unwrap_or_default(), request.tags.as_ref());
    let plan = build_encode_args(format, &input, &temp_output, settings, &source, &tags, gain_db)?;
    ctx.emit("converting", 0.0);
    run_ffmpeg(ctx, &ffmpeg, &plan.args, source.duration, "converting")?;
    ctx.check()?;

    let size = fs::metadata(&temp_output).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Err("FFmpeg produced an empty file".into());
    }
    if format == OutFormat::Wav {
        append_wav_tags(&temp_output, &tags)?;
    }

    // In "same as source" mode a lossless output must keep rate, channels and bit depth.
    if same_as_source(settings) && format.is_lossless() {
        let out = probe_source(&ffmpeg, &temp_output)?;
        let mismatch = (source.sample_rate.is_some() && out.sample_rate != source.sample_rate)
            || (source.channels.is_some() && out.channels != source.channels)
            || (plan.expected_bits.is_some() && out.bits_per_sample.is_some() && out.bits_per_sample != plan.expected_bits);
        if mismatch {
            return Err(format!(
                "Output does not keep the source format (source {:?} Hz / {:?} ch / {:?} bit, output {:?} Hz / {:?} ch / {:?} bit)",
                source.sample_rate, source.channels, source.bits_per_sample, out.sample_rate, out.channels, out.bits_per_sample
            ));
        }
    }

    ctx.check()?;
    // Stage inside the target folder so the final step is a same-volume link or copy.
    let staging = dir.join(format!(".audio-convert-{}.tmp", uuid::Uuid::new_v4().simple()));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    {
        let mut out = OpenOptions::new().write(true).create_new(true).open(&staging).map_err(|e| format!("Cannot write to output folder: {e}"))?;
        let _guard = Cleanup(staging.clone());
        let copied = (|| {
            let mut src = File::open(&temp_output)?;
            std::io::copy(&mut src, &mut out)?;
            out.sync_all()
        })();
        drop(out);
        copied.map_err(|e| format!("Cannot write to output folder: {e}"))?;
        let destination = publish_unique(&staging, &dir, &stem, ext, ctx)?;
        let name = destination.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        Ok((destination, name))
    }
}

pub fn parse_max_volume(log: &str) -> Option<f64> {
    let line = log.lines().rev().find(|l| l.contains("max_volume:"))?;
    let value = line.split("max_volume:").nth(1)?.trim().trim_end_matches("dB").trim();
    match value {
        "-inf" => Some(f64::NEG_INFINITY),
        v => v.parse().ok(),
    }
}

#[tauri::command]
pub async fn start_conversion_job(state: tauri::State<'_, ActiveJobs>, job_id: String) -> Result<(), String> {
    let mut jobs = state.lock().map_err(|e| e.to_string())?;
    jobs.insert(job_id, 0);
    Ok(())
}

#[tauri::command]
pub async fn cancel_conversion_job(state: tauri::State<'_, ActiveJobs>, job_id: String) -> Result<(), String> {
    // Removing the job is the cancel signal: the conversion thread sees it within
    // ~50 ms, kills its own FFmpeg process and publishes nothing.
    let mut jobs = state.lock().map_err(|e| e.to_string())?;
    jobs.remove(&job_id);
    Ok(())
}

#[tauri::command]
pub async fn finish_conversion_job(state: tauri::State<'_, ActiveJobs>, job_id: String) -> Result<(), String> {
    let mut jobs = state.lock().map_err(|e| e.to_string())?;
    jobs.remove(&job_id);
    Ok(())
}

#[tauri::command]
pub async fn decode_audio_to_wav(file_path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let temp = decode_to_temp_wav(&file_path, None).map_err(|e| e.to_string())?;
        let data = fs::read(&temp).map_err(|e| e.to_string());
        let _ = fs::remove_file(&temp);
        data
    })
    .await
    .map_err(|e| e.to_string())?
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
    let ctx = JobCtx { app: Some(app), jobs: state.inner().clone(), job_id: request.job_id.clone() };
    let result = tauri::async_runtime::spawn_blocking(move || convert_blocking(&ctx, &request))
        .await
        .map_err(|e| e.to_string())?;
    Ok(match result {
        Ok((path, name)) => ConvertResponse {
            success: true,
            path: Some(path.to_string_lossy().into_owned()),
            file_name: Some(name),
            error: None,
        },
        Err(e) => ConvertResponse::failure(e),
    })
}

#[cfg(test)]
mod tests;
