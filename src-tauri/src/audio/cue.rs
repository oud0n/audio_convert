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
    fn chapters_from_ffmetadata() {
        let meta = ";FFMETADATA1\ntitle=Book\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=61500\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/44100\nSTART=2712150\nEND=4410000\ntitle=A \\= B\n";
        let t = parse_chapters(meta, Path::new("/x/book.m4b"));
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].start, t[0].end, t[0].title.as_str()), (0.0, Some(61.5), "Intro"));
        assert_eq!((t[1].start, t[1].end, t[1].title.as_str()), (61.5, None, "A = B"));
    }
}
