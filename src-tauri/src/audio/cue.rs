//! Album images split into tracks: CUE sheets (separate `.cue` files or a CUESHEET tag
//! embedded in the audio file) and chapters (M4A / M4B / MKV), like xrecode's
//! "use CUE" and "use chapters". INDEX 00 (the pregap) is ignored, so each track starts
//! at its INDEX 01 and the pregap stays at the end of the previous track.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::audio::audit::get_ffmpeg_executable;
use crate::audio::convert::{hidden_command, simplify_verbatim_path};

/// One track of an image: the audio file and its range in seconds.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct ImageTrack {
    #[serde(rename = "audioPath")]
    pub audio_path: String,
    pub number: u32,
    /// Start in seconds (CUE frames are 1/75 s).
    pub start: f64,
    /// End in seconds; None = to the end of the audio file.
    pub end: Option<f64>,
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(rename = "albumArtist")]
    pub album_artist: String,
    pub year: String,
    pub genre: String,
    pub comment: String,
    pub disc: String,
    #[serde(rename = "totalTracks")]
    pub total_tracks: String,
}

#[derive(Serialize, Debug, Default)]
pub struct ImageTracksResponse {
    pub success: bool,
    pub tracks: Vec<ImageTrack>,
    /// Audio files a CUE sheet names but that were not found.
    pub missing: Vec<String>,
    pub error: Option<String>,
}

/// Text of a CUE file: UTF-8 (with or without BOM), UTF-16 with BOM, else Shift_JIS
/// (common for Japanese rips), else Windows-1252.
pub fn decode_cue_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if bytes.starts_with(b"\xFF\xFE") {
        return encoding_rs::UTF_16LE.decode(bytes).0.into_owned();
    }
    if bytes.starts_with(b"\xFE\xFF") {
        return encoding_rs::UTF_16BE.decode(bytes).0.into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    let (text, _, had_errors) = encoding_rs::SHIFT_JIS.decode(bytes);
    if !had_errors {
        return text.into_owned();
    }
    encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned()
}

/// Splits a CUE line into words; double quotes group words ("A B" -> A B).
fn words(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// "mm:ss:ff" (75 frames per second) -> seconds.
fn msf(text: &str) -> Option<f64> {
    let mut it = text.split(':').map(|p| p.trim().parse::<u64>());
    let (m, s, f) = (it.next()?.ok()?, it.next()?.ok()?, it.next()?.ok()?);
    if it.next().is_some() || s >= 60 || f >= 75 {
        return None;
    }
    Some(((m * 60 + s) * 75 + f) as f64 / 75.0)
}

/// The audio file a FILE line names, relative to the CUE's folder. Rips are often
/// re-encoded after the CUE was written ("x.wav" became "x.flac"), so a file with the
/// same stem and another audio extension is accepted too.
fn resolve_audio(dir: &Path, name: &str) -> Option<PathBuf> {
    let direct = dir.join(name.replace('\\', std::path::MAIN_SEPARATOR_STR));
    if direct.is_file() {
        return Some(direct);
    }
    let stem = Path::new(&name.replace('\\', "/")).file_stem()?.to_string_lossy().into_owned();
    let entries = std::fs::read_dir(dir).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.file_stem().is_some_and(|s| s.to_string_lossy() == stem))
        .filter(|p| {
            let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            crate::audio::convert::IMAGE_AUDIO_EXTENSIONS.contains(&ext.as_str())
        })
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

/// Parses a CUE sheet. `dir` is where FILE names are looked up; `embedded` is the audio
/// file an embedded CUESHEET belongs to (its FILE lines are ignored).
pub fn parse_cue(text: &str, dir: &Path, embedded: Option<&Path>) -> (Vec<ImageTrack>, Vec<String>) {
    #[derive(Default)]
    struct Album {
        title: String,
        performer: String,
        date: String,
        genre: String,
        comment: String,
        disc: String,
    }
    let mut album = Album::default();
    let mut tracks: Vec<ImageTrack> = Vec::new();
    let mut missing = Vec::new();
    let mut file: Option<PathBuf> = embedded.map(Path::to_path_buf);
    let mut current: Option<ImageTrack> = None;
    let mut has_start = false;

    let finish = |t: Option<ImageTrack>, has_start: bool, tracks: &mut Vec<ImageTrack>| {
        if let Some(t) = t.filter(|_| has_start) {
            tracks.push(t);
        }
    };

    for raw in text.lines() {
        let w = words(raw.trim());
        let Some(cmd) = w.first().map(|c| c.to_ascii_uppercase()) else { continue };
        let arg = |i: usize| w.get(i).cloned().unwrap_or_default();
        match cmd.as_str() {
            "FILE" => {
                finish(current.take(), has_start, &mut tracks);
                has_start = false;
                if embedded.is_none() {
                    let name = arg(1);
                    file = resolve_audio(dir, &name);
                    if file.is_none() && !name.is_empty() {
                        missing.push(name);
                    }
                }
            }
            "TRACK" => {
                finish(current.take(), has_start, &mut tracks);
                has_start = false;
                let audio = arg(2).eq_ignore_ascii_case("AUDIO");
                current = match (&file, audio) {
                    (Some(f), true) => Some(ImageTrack {
                        audio_path: simplify_verbatim_path(std::fs::canonicalize(f).unwrap_or_else(|_| f.clone()))
                            .to_string_lossy()
                            .into_owned(),
                        number: arg(1).parse().unwrap_or(tracks.len() as u32 + 1),
                        ..Default::default()
                    }),
                    _ => None,
                };
            }
            "TITLE" => match &mut current {
                Some(t) => t.title = arg(1),
                None => album.title = arg(1),
            },
            "PERFORMER" => match &mut current {
                Some(t) => {
                    t.artist = arg(1);
                }
                None => album.performer = arg(1),
            },
            "REM" => {
                let key = arg(1).to_ascii_uppercase();
                let value = w.get(2..).map(|v| v.join(" ")).unwrap_or_default();
                if current.is_none() {
                    match key.as_str() {
                        "DATE" => album.date = value,
                        "GENRE" => album.genre = value,
                        "COMMENT" => album.comment = value,
                        "DISCNUMBER" => album.disc = value,
                        _ => {}
                    }
                }
            }
            "INDEX" => {
                if let (Some(t), Ok(1)) = (&mut current, arg(1).parse::<u32>()) {
                    if let Some(s) = msf(&arg(2)) {
                        t.start = s;
                        has_start = true;
                    }
                }
            }
            _ => {}
        }
    }
    finish(current.take(), has_start, &mut tracks);

    // A track ends where the next track of the same file starts.
    let total = tracks.len().to_string();
    for i in 0..tracks.len() {
        let next = tracks.get(i + 1).filter(|n| n.audio_path == tracks[i].audio_path).map(|n| n.start);
        let t = &mut tracks[i];
        t.end = next;
        t.album = album.title.clone();
        t.album_artist = album.performer.clone();
        if t.artist.is_empty() {
            t.artist = album.performer.clone();
        }
        t.year = album.date.clone();
        t.genre = album.genre.clone();
        t.comment = album.comment.clone();
        t.disc = album.disc.clone();
        t.total_tracks = total.clone();
    }
    (tracks, missing)
}

/// Chapters from FFmpeg's ffmetadata output ([CHAPTER] sections).
pub fn parse_chapters(ffmetadata: &str, audio: &Path) -> Vec<ImageTrack> {
    let mut out: Vec<ImageTrack> = Vec::new();
    let mut in_chapter = false;
    let (mut base, mut start, mut end, mut title) = ((1u64, 1000u64), None::<i64>, None::<i64>, String::new());
    let push = |out: &mut Vec<ImageTrack>, base: (u64, u64), start: Option<i64>, end: Option<i64>, title: &str| {
        if let Some(s) = start {
            let secs = |v: i64| v as f64 * base.0 as f64 / base.1 as f64;
            out.push(ImageTrack {
                audio_path: audio.to_string_lossy().into_owned(),
                number: out.len() as u32 + 1,
                start: secs(s).max(0.0),
                end: end.map(secs),
                title: title.to_string(),
                ..Default::default()
            });
        }
    };
    for line in ffmetadata.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            if in_chapter {
                push(&mut out, base, start, end, &title);
            }
            in_chapter = line.eq_ignore_ascii_case("[CHAPTER]");
            (base, start, end, title) = ((1, 1000), None, None, String::new());
            continue;
        }
        if !in_chapter {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        match k.to_ascii_uppercase().as_str() {
            "TIMEBASE" => {
                if let Some((n, d)) = v.split_once('/') {
                    if let (Ok(n), Ok(d)) = (n.parse(), d.parse()) {
                        if d > 0 {
                            base = (n, d);
                        }
                    }
                }
            }
            "START" => start = v.parse().ok(),
            "END" => end = v.parse().ok(),
            "TITLE" => title = v.replace("\\=", "=").replace("\\;", ";").replace("\\#", "#").replace("\\\\", "\\"),
            _ => {}
        }
    }
    if in_chapter {
        push(&mut out, base, start, end, &title);
    }
    // The last chapter runs to the end of the file.
    if let Some(last) = out.last_mut() {
        last.end = None;
    }
    let total = out.len().to_string();
    for t in &mut out {
        t.total_tracks = total.clone();
    }
    out
}

fn ffmetadata_text(path: &Path) -> Option<String> {
    let output = hidden_command(&get_ffmpeg_executable())
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-f", "ffmetadata", "-"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Tracks of `path`: a `.cue` file's tracks, or the tracks of an audio file with an
/// embedded CUESHEET tag or at least two chapters. Empty for an ordinary audio file.
pub fn read_image_tracks(path: &Path) -> ImageTracksResponse {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ext == "cue" {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => return ImageTracksResponse { error: Some(format!("Cannot read the CUE sheet: {e}")), ..Default::default() },
        };
        let dir = path.parent().unwrap_or(Path::new("."));
        let (tracks, missing) = parse_cue(&decode_cue_text(&bytes), dir, None);
        let error = tracks.is_empty().then(|| {
            if missing.is_empty() { "The CUE sheet has no audio tracks".to_string() } else { format!("Audio file not found: {}", missing.join(", ")) }
        });
        return ImageTracksResponse { success: error.is_none(), tracks, missing, error };
    }
    let Some(meta) = ffmetadata_text(path) else { return ImageTracksResponse { success: true, ..Default::default() } };
    let tags = crate::audio::convert::parse_ffmetadata(&meta);
    if let Some((_, sheet)) = tags.iter().find(|(k, _)| k.eq_ignore_ascii_case("cuesheet")) {
        let (tracks, _) = parse_cue(sheet, path.parent().unwrap_or(Path::new(".")), Some(path));
        if tracks.len() >= 2 {
            return ImageTracksResponse { success: true, tracks, ..Default::default() };
        }
    }
    let chapters = parse_chapters(&meta, path);
    let tracks = if chapters.len() >= 2 { chapters } else { Vec::new() };
    ImageTracksResponse { success: true, tracks, ..Default::default() }
}

#[tauri::command]
pub async fn read_image_tracks_command(path: String) -> ImageTracksResponse {
    tauri::async_runtime::spawn_blocking(move || read_image_tracks(Path::new(&path)))
        .await
        .unwrap_or_else(|e| ImageTracksResponse { error: Some(e.to_string()), ..Default::default() })
}

#[derive(serde::Deserialize, Debug, Clone)]
pub struct SplitRequest {
    pub path: String,
    /// "time" or "silence".
    pub mode: String,
    /// "time": length of each part in seconds.
    pub seconds: Option<f64>,
    /// "silence": level below which audio counts as silence (dB), minimum silence
    /// length, minimum part length (shorter parts join the next one), and whether the
    /// silence stays (split in its middle) or is dropped.
    #[serde(rename = "thresholdDb")]
    pub threshold_db: Option<f64>,
    #[serde(rename = "minSilence")]
    pub min_silence: Option<f64>,
    #[serde(rename = "minLength")]
    pub min_length: Option<f64>,
    #[serde(rename = "preservePauses")]
    pub preserve_pauses: Option<bool>,
}

/// "silence_start: 12.3" / "silence_end: 14.1 | silence_duration: 1.8" from silencedetect.
pub fn parse_silences(log: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut start = None;
    for line in log.lines() {
        if let Some(v) = line.split("silence_start: ").nth(1) {
            start = v.split_whitespace().next().and_then(|t| t.parse::<f64>().ok());
        } else if let Some(v) = line.split("silence_end: ").nth(1) {
            if let (Some(s), Some(e)) = (start.take(), v.split_whitespace().next().and_then(|t| t.parse::<f64>().ok())) {
                out.push((s.max(0.0), e));
            }
        }
    }
    out
}

/// Parts of a file of `duration` seconds between `silences` (start, end): each part
/// ends where a silence starts and the next begins where it ends (or both at its middle
/// with `preserve`). Parts shorter than `min_length` join the next part.
pub fn parts_from_silences(duration: f64, silences: &[(f64, f64)], min_length: f64, preserve: bool) -> Vec<(f64, Option<f64>)> {
    let mut cuts: Vec<(f64, f64)> = Vec::new(); // (end of a part, start of the next)
    for &(s, e) in silences {
        // Silence at the very start or end is not a split.
        if s <= 0.01 || e >= duration - 0.01 {
            continue;
        }
        cuts.push(if preserve { ((s + e) / 2.0, (s + e) / 2.0) } else { (s, e) });
    }
    let mut parts = Vec::new();
    let mut start = 0.0;
    for (end, next) in cuts {
        if end - start < min_length {
            continue; // too short: keep going until the next cut
        }
        parts.push((start, Some(end)));
        start = next;
    }
    // A short last part joins the previous one.
    if let Some(last) = parts.last_mut() {
        if duration - start < min_length {
            last.1 = None;
            return parts;
        }
    }
    parts.push((start, None));
    parts
}

pub fn split_tracks(request: &SplitRequest) -> Result<Vec<ImageTrack>, String> {
    let path = Path::new(&request.path);
    let ffmpeg = get_ffmpeg_executable();
    let info = crate::audio::convert::probe_source(&ffmpeg, path)?;
    let duration = info.duration;
    if duration <= 0.0 {
        return Err("Unknown length".into());
    }
    let parts: Vec<(f64, Option<f64>)> = match request.mode.as_str() {
        "time" => {
            let step = request.seconds.unwrap_or(60.0).max(1.0);
            let mut v = Vec::new();
            let mut t = 0.0;
            while t < duration - 0.01 {
                let end = t + step;
                v.push((t, (end < duration - 0.01).then_some(end)));
                t = end;
            }
            v
        }
        "silence" => {
            let db = request.threshold_db.unwrap_or(-50.0);
            let min_silence = request.min_silence.unwrap_or(1.5).max(0.05);
            let output = hidden_command(&ffmpeg)
                .args(["-nostdin", "-hide_banner", "-nostats", "-i"])
                .arg(path)
                .args(["-map", "0:a:0", "-af", &format!("silencedetect=n={db}dB:d={min_silence}"), "-f", "null", "-"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .output()
                .map_err(|e| e.to_string())?;
            let silences = parse_silences(&String::from_utf8_lossy(&output.stderr));
            parts_from_silences(duration, &silences, request.min_length.unwrap_or(30.0).max(0.0), request.preserve_pauses.unwrap_or(false))
        }
        other => return Err(format!("Unknown split mode: {other}")),
    };
    let total = parts.len().to_string();
    Ok(parts
        .into_iter()
        .enumerate()
        .map(|(i, (start, end))| ImageTrack {
            audio_path: request.path.clone(),
            number: i as u32 + 1,
            start,
            end,
            total_tracks: total.clone(),
            ..Default::default()
        })
        .collect())
}

#[tauri::command]
pub async fn split_points(request: SplitRequest) -> ImageTracksResponse {
    tauri::async_runtime::spawn_blocking(move || split_tracks(&request))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
        .map_or_else(|e| ImageTracksResponse { error: Some(e), ..Default::default() }, |tracks| ImageTracksResponse { success: true, tracks, ..Default::default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_tracks_start_at_index_01_and_end_at_the_next_track() {
        let d = std::env::temp_dir().join(format!("cue-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        // The sheet names a WAV; the rip is a FLAC now.
        std::fs::write(d.join("Album.flac"), b"x").unwrap();
        let sheet = "REM GENRE Rock\r\nREM DATE 1999\r\nPERFORMER \"The Band\"\r\nTITLE \"Best Of\"\r\nFILE \"Album.wav\" WAVE\r\n  TRACK 01 AUDIO\r\n    TITLE \"One\"\r\n    INDEX 01 00:00:00\r\n  TRACK 02 AUDIO\r\n    TITLE \"Two\"\r\n    PERFORMER \"Guest\"\r\n    INDEX 00 03:58:00\r\n    INDEX 01 04:00:37\r\n  TRACK 03 AUDIO\r\n    TITLE \"Three\"\r\n    INDEX 01 08:00:00\r\n";
        let (t, missing) = parse_cue(sheet, &d, None);
        assert!(missing.is_empty());
        assert_eq!(t.len(), 3);
        assert_eq!((t[0].start, t[0].end), (0.0, Some(240.0 + 37.0 / 75.0)), "pregap stays in track 1");
        assert_eq!(t[1].start, 240.0 + 37.0 / 75.0);
        assert_eq!(t[2].end, None);
        assert_eq!((t[1].title.as_str(), t[1].artist.as_str(), t[0].artist.as_str()), ("Two", "Guest", "The Band"));
        assert_eq!((t[0].album.as_str(), t[0].album_artist.as_str(), t[0].year.as_str(), t[0].genre.as_str()), ("Best Of", "The Band", "1999", "Rock"));
        assert_eq!(t[2].total_tracks, "3");
        assert!(t[0].audio_path.ends_with("Album.flac"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_audio_and_encodings() {
        let (t, missing) = parse_cue("FILE \"nope.wav\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n", Path::new("/nonexistent"), None);
        assert!(t.is_empty());
        assert_eq!(missing, ["nope.wav"]);
        // "曲" in Shift_JIS.
        assert_eq!(decode_cue_text(&[0x8B, 0xC8]), "曲");
        assert_eq!(decode_cue_text("\u{feff}曲".as_bytes()), "曲");
        assert_eq!(msf("01:02:74"), Some(62.0 + 74.0 / 75.0));
        assert_eq!(msf("01:60:00"), None);
    }

    #[test]
    fn silence_parts() {
        let log = "[silencedetect @ 0x1] silence_start: 59.5\n[silencedetect @ 0x1] silence_end: 61.5 | silence_duration: 2\n[silencedetect @ 0x1] silence_start: 100\n[silencedetect @ 0x1] silence_end: 101.6 | silence_duration: 1.6\n[silencedetect @ 0x1] silence_start: 178\n[silencedetect @ 0x1] silence_end: 180 | silence_duration: 2\n";
        let s = parse_silences(log);
        assert_eq!(s, [(59.5, 61.5), (100.0, 101.6), (178.0, 180.0)]);
        // The trailing silence is not a split; 61.5..100 is long enough.
        assert_eq!(parts_from_silences(180.0, &s, 30.0, false), [(0.0, Some(59.5)), (61.5, Some(100.0)), (101.6, None)]);
        assert_eq!(parts_from_silences(180.0, &s, 30.0, true), [(0.0, Some(60.5)), (60.5, Some(100.8)), (100.8, None)]);
        // 61.5..100 is under 60 s: it joins the next part.
        assert_eq!(parts_from_silences(180.0, &s, 60.0, false), [(0.0, Some(100.0)), (101.6, None)]);
        // A short last part joins the previous one.
        assert_eq!(parts_from_silences(120.0, &[(100.0, 101.0)], 30.0, false), [(0.0, None)]);
        assert_eq!(parts_from_silences(50.0, &[], 30.0, false), [(0.0, None)]);
    }

    #[test]
    fn chapters_from_ffmetadata() {
        let meta = ";FFMETADATA1\ntitle=Book\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=61500\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/44100\nSTART=2712150\nEND=4410000\ntitle=A \\= B\n";
        let t = parse_chapters(meta, Path::new("/x/book.m4b"));
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].start, t[0].end, t[0].title.as_str()), (0.0, Some(61.5), "Intro"));
        assert_eq!((t[1].start, t[1].end, t[1].title.as_str()), (61.5, None, "A = B"));
    }
}
