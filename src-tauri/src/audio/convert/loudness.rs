//! ReplayGain 2.0 tags from an EBU R128 measurement (xrecode `useebur128`,
//! `saveintags`): the audio is not changed, only the gain a player should apply is
//! stored. The reference is -18 LUFS; Opus gets R128_* gains (Q7.8, relative to
//! -23 LUFS) as its specification asks.

use super::*;
use lofty::config::WriteOptions;
use lofty::file::{FileType, TaggedFileExt};
use lofty::tag::{ItemKey, Tag, TagExt as _, TagType};

const RG_REFERENCE_LUFS: f64 = -18.0;
const R128_REFERENCE_LUFS: f64 = -23.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub integrated: f64,
    /// Sample peak, linear (1.0 = full scale).
    pub peak: f64,
}

/// Reads the summary FFmpeg's `ebur128` filter prints at the end.
pub fn parse_ebur128_summary(log: &str) -> Option<Loudness> {
    let summary = &log[log.rfind("Summary:")?..];
    let value = |label: &str| -> Option<f64> {
        let at = summary.find(label)? + label.len();
        summary[at..].split_whitespace().next()?.parse().ok()
    };
    let integrated = value("I:")?;
    let peak_db = value("Peak:")?;
    let peak = if peak_db.is_finite() { 10f64.powf(peak_db / 20.0) } else { 0.0 };
    integrated.is_finite().then_some(Loudness { integrated, peak })
}

fn measure(ctx: &JobCtx, ffmpeg: &Path, inputs: &[PathBuf], duration: f64) -> Result<Loudness, String> {
    let mut args: Vec<String> = Vec::new();
    for p in inputs {
        args.extend(["-i".into(), p.to_string_lossy().into_owned()]);
    }
    // Several files (an album) are measured as one programme, at the first one's shape.
    let filter = if inputs.len() == 1 {
        "[0:a:0]ebur128=peak=sample[out]".to_string()
    } else {
        let first = probe_source(ffmpeg, &inputs[0])?;
        let rate = first.sample_rate.unwrap_or(48000);
        let layout = layout_name(first.channels.unwrap_or(2));
        let mut f = String::new();
        for i in 0..inputs.len() {
            f.push_str(&format!("[{i}:a:0]aresample={rate},aformat=sample_fmts=flt:channel_layouts={layout}[a{i}];"));
        }
        for i in 0..inputs.len() {
            f.push_str(&format!("[a{i}]"));
        }
        f.push_str(&format!("concat=n={}:v=0:a=1,ebur128=peak=sample[out]", inputs.len()));
        f
    };
    args.extend([
        "-filter_complex".into(), filter, "-map".into(), "[out]".into(),
        "-progress".into(), "pipe:1".into(), "-nostats".into(), "-f".into(), "null".into(), "-".into(),
    ]);
    let log = run_ffmpeg(ctx, ffmpeg, &args, duration, "analyzing")?;
    parse_ebur128_summary(&log).ok_or_else(|| "Loudness measurement failed (silent audio?)".to_string())
}

fn gain_text(db: f64) -> String {
    format!("{db:+.2} dB")
}

/// The tags to write for a track (and optionally its album).
pub fn loudness_tags(format: OutFormat, track: Loudness, album: Option<Loudness>) -> Vec<(String, String)> {
    if format == OutFormat::Opus {
        let q78 = |l: Loudness| (((R128_REFERENCE_LUFS - l.integrated) * 256.0).round() as i64).clamp(-32768, 32767).to_string();
        let mut out = vec![("R128_TRACK_GAIN".to_string(), q78(track))];
        if let Some(a) = album {
            out.push(("R128_ALBUM_GAIN".into(), q78(a)));
        }
        return out;
    }
    let mut out = vec![
        ("REPLAYGAIN_TRACK_GAIN".to_string(), gain_text(RG_REFERENCE_LUFS - track.integrated)),
        ("REPLAYGAIN_TRACK_PEAK".to_string(), format!("{:.6}", track.peak)),
    ];
    if let Some(a) = album {
        out.push(("REPLAYGAIN_ALBUM_GAIN".into(), gain_text(RG_REFERENCE_LUFS - a.integrated)));
        out.push(("REPLAYGAIN_ALBUM_PEAK".into(), format!("{:.6}", a.peak)));
    }
    out
}

fn item_key(key: &str) -> ItemKey {
    match key {
        "REPLAYGAIN_TRACK_GAIN" => ItemKey::ReplayGainTrackGain,
        "REPLAYGAIN_TRACK_PEAK" => ItemKey::ReplayGainTrackPeak,
        "REPLAYGAIN_ALBUM_GAIN" => ItemKey::ReplayGainAlbumGain,
        "REPLAYGAIN_ALBUM_PEAK" => ItemKey::ReplayGainAlbumPeak,
        // The app's edit keys (see `edit_pairs`).
        "title" => ItemKey::TrackTitle,
        "artist" => ItemKey::TrackArtist,
        "album" => ItemKey::AlbumTitle,
        "album_artist" => ItemKey::AlbumArtist,
        "track" => ItemKey::TrackNumber,
        "tracktotal" => ItemKey::TrackTotal,
        "disc" => ItemKey::DiscNumber,
        "disctotal" => ItemKey::DiscTotal,
        "date" => ItemKey::RecordingDate,
        "genre" => ItemKey::Genre,
        "comment" => ItemKey::Comment,
        other => ItemKey::Unknown(other.to_string()),
    }
}

/// Writes `tags` into `path`, keeping everything else (and the file's protection as
/// this session's output: its identity changes with its size and time).
/// Writes `tags` (an empty value removes the tag). "n/total" track and disc numbers
/// are stored as number and total.
pub(super) fn write_tags(path: &Path, tags: &[(String, String)]) -> Result<(), String> {
    let mut expanded: Vec<(String, String)> = Vec::new();
    for (k, v) in tags {
        match (k.as_str(), v.split_once('/')) {
            ("track" | "disc", Some((n, total))) => {
                expanded.push((k.clone(), n.trim().to_string()));
                expanded.push((format!("{k}total"), total.trim().to_string()));
            }
            _ => expanded.push((k.clone(), v.clone())),
        }
    }
    let tags = &expanded;
    let old_key = output_key(path);
    let mut file = lofty::probe::Probe::open(path).and_then(|p| p.read()).map_err(|e| format!("Cannot read tags: {e}"))?;
    // WAV / AIFF: the ID3v2 chunk this app writes (RIFF INFO cannot hold these keys).
    let tag_type = if matches!(file.file_type(), FileType::Wav | FileType::Aiff) { TagType::Id3v2 } else { file.primary_tag_type() };
    if file.tag(tag_type).is_none() {
        file.insert_tag(Tag::new(tag_type));
    }
    let tag = file.tag_mut(tag_type).ok_or("No tag can be written to this format")?;
    for (key, value) in tags {
        let k = item_key(key);
        tag.remove_key(&k);
        if value.is_empty() {
            continue;
        }
        if matches!(k, ItemKey::Unknown(_)) {
            // Free-form keys (R128_*): Vorbis comments store any name.
            if tag_type != TagType::VorbisComments {
                return Err(format!("This format cannot store {key}"));
            }
            tag.insert_unchecked(lofty::tag::TagItem::new(k, lofty::tag::ItemValue::Text(value.clone())));
        } else if !tag.insert_text(k, value.clone()) {
            return Err(format!("This format cannot store {key}"));
        }
    }
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| format!("Cannot write tags: {e}"))?;
    if let (Some(old), Some(new)) = (old_key, output_key(path)) {
        let mut guard = SESSION_OUTPUTS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = guard.as_mut() {
            if let Some(source) = map.remove(&old) {
                map.insert(new, source);
            }
        }
    }
    Ok(())
}

#[derive(Deserialize, Debug, Clone)]
pub struct LoudnessRequest {
    /// Output files; with `album`, they are one album.
    pub paths: Vec<String>,
    pub album: bool,
    #[serde(rename = "jobId")]
    pub job_id: Option<String>,
}

#[derive(Serialize, Debug, Default)]
pub struct LoudnessResponse {
    pub success: bool,
    /// Per file: the track gain written (dB), or the error.
    pub results: Vec<LoudnessFileResult>,
    #[serde(rename = "albumGainDb")]
    pub album_gain_db: Option<f64>,
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct LoudnessFileResult {
    pub path: String,
    #[serde(rename = "gainDb")]
    pub gain_db: Option<f64>,
    pub error: Option<String>,
}

pub(super) fn write_loudness_blocking(ctx: &JobCtx, request: &LoudnessRequest) -> LoudnessResponse {
    let ffmpeg = get_ffmpeg_executable();
    let paths: Vec<PathBuf> = request.paths.iter().map(PathBuf::from).collect();
    let mut measured = Vec::new();
    for p in &paths {
        let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        // Only Opus is tagged differently; ALAC and AAC (.m4a) are tagged alike.
        let format = match ext.as_str() {
            "m4a" => Some(OutFormat::M4a),
            "wv" => Some(OutFormat::WavPack),
            "aif" => Some(OutFormat::Aiff),
            other => OutFormat::parse(other),
        };
        let result = format
            .filter(|f| !matches!(f, OutFormat::Ac3 | OutFormat::Wma))
            .ok_or_else(|| "This format cannot store ReplayGain tags".to_string())
            .and_then(|f| {
                let info = probe_source(&ffmpeg, p)?;
                Ok((f, info.duration, measure(ctx, &ffmpeg, std::slice::from_ref(p), info.duration)?))
            });
        if ctx.cancelled() {
            return LoudnessResponse { error: Some("Conversion cancelled".into()), ..Default::default() };
        }
        measured.push(result);
    }
    let album = if request.album && paths.len() > 1 && measured.iter().all(|m| m.is_ok()) {
        let total: f64 = measured.iter().filter_map(|m| m.as_ref().ok().map(|(_, d, _)| *d)).sum();
        match measure(ctx, &ffmpeg, &paths, total) {
            Ok(mut l) => {
                l.peak = measured.iter().filter_map(|m| m.as_ref().ok().map(|(_, _, t)| t.peak)).fold(l.peak, f64::max);
                Some(l)
            }
            Err(e) => return LoudnessResponse { error: Some(e), ..Default::default() },
        }
    } else {
        None
    };
    let mut results = Vec::new();
    for (p, m) in paths.iter().zip(measured) {
        let path = p.to_string_lossy().into_owned();
        match m.and_then(|(format, _, track)| write_tags(p, &loudness_tags(format, track, album)).map(|_| track)) {
            Ok(track) => results.push(LoudnessFileResult { path, gain_db: Some(RG_REFERENCE_LUFS - track.integrated), error: None }),
            Err(e) => results.push(LoudnessFileResult { path, gain_db: None, error: Some(e) }),
        }
    }
    let success = results.iter().all(|r| r.error.is_none());
    LoudnessResponse { success, results, album_gain_db: album.map(|a| RG_REFERENCE_LUFS - a.integrated), error: None }
}

#[tauri::command]
pub async fn write_loudness_tags(app: AppHandle, state: tauri::State<'_, ActiveJobs>, request: LoudnessRequest) -> Result<LoudnessResponse, String> {
    let ctx = JobCtx { app: Some(app), jobs: state.inner().clone(), job_id: request.job_id.clone() };
    tauri::async_runtime::spawn_blocking(move || write_loudness_blocking(&ctx, &request)).await.map_err(|e| e.to_string())
}
