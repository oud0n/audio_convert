use lofty::file::TaggedFileExt;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::ItemKey;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug, Default)]
pub struct FormatInfo {
    pub duration: f64,
    #[serde(rename = "sampleRate")]
    pub sample_rate: u32,
    #[serde(rename = "numberOfChannels")]
    pub number_of_channels: u32,
    pub bitrate: u32,
    #[serde(rename = "bitDepth")]
    pub bit_depth: Option<u32>,
    pub lossless: bool,
    /// FFmpeg codec name of the first audio stream (e.g. "alac", "aac").
    pub codec: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct TagInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(rename = "albumArtist")]
    pub album_artist: String,
    pub disc: String,
    pub year: String,
    pub genre: String,
    pub track: String,
    pub comment: String,
    #[serde(rename = "totalTracks")]
    pub total_tracks: String,
    #[serde(rename = "totalDiscs")]
    pub total_discs: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ReadMetadataResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<FormatInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<TagInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn read_audio_metadata(path: String) -> ReadMetadataResponse {
    let result = tauri::async_runtime::spawn_blocking(move || read_metadata_internal(&path)).await;
    let result = match result {
        Ok(r) => r,
        Err(e) => Err(e.to_string().into()),
    };
    match result {
        Ok((format, tags)) => ReadMetadataResponse {
            success: true,
            format: Some(format),
            tags: Some(tags),
            error: None,
        },
        Err(err) => ReadMetadataResponse {
            success: false,
            format: None,
            tags: None,
            error: Some(err.to_string()),
        },
    }
}

pub fn read_metadata_internal(file_path: &str) -> Result<(FormatInfo, TagInfo), Box<dyn std::error::Error + Send + Sync>> {
    let path = Path::new(file_path);
    let ffmpeg = crate::audio::audit::get_ffmpeg_executable();
    // FFmpeg decides the codec (.m4a can be ALAC or AAC) and reads every format we accept.
    // lofty adds exact bit depth and tags for the formats it knows.
    let probe = crate::audio::convert::probe_source(&ffmpeg, path).ok();
    let tagged_file = Probe::open(path).and_then(|p| p.read());
    if probe.is_none() {
        if let Err(e) = tagged_file {
            return Err(e.into());
        }
    }

    let codec = probe.as_ref().and_then(|p| p.codec.clone());
    let lossless = probe.as_ref().and_then(|p| p.lossless).unwrap_or(false);
    let mut format_info = FormatInfo {
        duration: probe.as_ref().map(|p| p.duration).unwrap_or(0.0),
        sample_rate: probe.as_ref().and_then(|p| p.sample_rate).unwrap_or(0),
        number_of_channels: probe.as_ref().and_then(|p| p.channels).unwrap_or(0),
        bitrate: 0,
        bit_depth: probe.as_ref().filter(|p| p.lossless == Some(true)).and_then(|p| p.bits_per_sample),
        lossless,
        codec,
    };

    // Missing values stay empty so file name patterns can tell "no tag" from "track 1".
    let mut tag_info = TagInfo::default();

    if let Ok(tagged_file) = &tagged_file {
        let props = tagged_file.properties();
        if props.duration().as_secs_f64() > 0.0 {
            format_info.duration = props.duration().as_secs_f64();
        }
        if let Some(sr) = props.sample_rate() {
            format_info.sample_rate = sr;
        }
        if let Some(ch) = props.channels() {
            format_info.number_of_channels = ch as u32;
        }
        format_info.bitrate = props.audio_bitrate().unwrap_or(0) * 1000;
        if lossless {
            if let Some(d) = props.bit_depth() {
                format_info.bit_depth = Some(d as u32);
            }
        }

        if let Some(tag) = tagged_file.primary_tag().or_else(|| tagged_file.first_tag()) {
            if let Some(val) = tag.title() {
                tag_info.title = val.to_string();
            }
            if let Some(val) = tag.artist() {
                tag_info.artist = val.to_string();
            }
            if let Some(val) = tag.album() {
                tag_info.album = val.to_string();
            }
            if let Some(val) = tag.get_string(&ItemKey::AlbumArtist) {
                tag_info.album_artist = val.to_string();
            }
            if let Some(val) = tag.genre() {
                tag_info.genre = val.to_string();
            }
            if let Some(val) = tag.comment() {
                tag_info.comment = val.to_string();
            }
            if let Some(track) = tag.track() {
                tag_info.track = format!("{:02}", track);
            }
            if let Some(disk) = tag.disk() {
                tag_info.disc = disk.to_string();
            }
            if let Some(total) = tag.track_total() {
                tag_info.total_tracks = total.to_string();
            }
            if let Some(total) = tag.disk_total() {
                tag_info.total_discs = total.to_string();
            }
            if let Some(year) = tag.year() {
                tag_info.year = year.to_string();
            }
        }
    }

    // FFmpeg reads every format we accept and sees fields lofty files under other keys
    // (e.g. FFmpeg writes comments as Vorbis DESCRIPTION / ID3 TXXX:comment). Fill each
    // field lofty left empty from FFmpeg's view of the tags.
    if let Ok(tags) = crate::audio::convert::read_source_tags(&ffmpeg, path) {
        let ff = tag_info_from_ffmpeg(&tags);
        let fill = |mine: &mut String, theirs: String| {
            if mine.is_empty() {
                *mine = theirs;
            }
        };
        fill(&mut tag_info.title, ff.title);
        fill(&mut tag_info.artist, ff.artist);
        fill(&mut tag_info.album, ff.album);
        fill(&mut tag_info.album_artist, ff.album_artist);
        fill(&mut tag_info.disc, ff.disc);
        fill(&mut tag_info.year, ff.year);
        fill(&mut tag_info.genre, ff.genre);
        fill(&mut tag_info.track, ff.track);
        fill(&mut tag_info.comment, ff.comment);
        fill(&mut tag_info.total_tracks, ff.total_tracks);
        fill(&mut tag_info.total_discs, ff.total_discs);
    }

    Ok((format_info, tag_info))
}

fn split_number(value: &str) -> (String, String) {
    match value.split_once('/') {
        Some((n, t)) => (n.trim().to_string(), t.trim().to_string()),
        None => (value.trim().to_string(), String::new()),
    }
}

pub fn tag_info_from_ffmpeg(tags: &[(String, String)]) -> TagInfo {
    let get = |k: &str| tags.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone()).unwrap_or_default();
    let (track, total_tracks) = split_number(&get("track"));
    let (disc, total_discs) = split_number(&get("disc"));
    let date = get("date");
    let year: String = date.chars().take(4).collect();
    TagInfo {
        title: get("title"),
        artist: get("artist"),
        album: get("album"),
        album_artist: get("album_artist"),
        disc,
        year: if year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()) { year } else { date },
        genre: get("genre"),
        track,
        comment: get("comment"),
        total_tracks,
        total_discs,
    }
}
