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
    match read_metadata_internal(&path) {
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

fn read_metadata_internal(file_path: &str) -> Result<(FormatInfo, TagInfo), Box<dyn std::error::Error + Send + Sync>> {
    let path = Path::new(file_path);
    let tagged_file = Probe::open(path)?.read()?;

    let props = tagged_file.properties();
    let duration = props.duration().as_secs_f64();
    let sample_rate = props.sample_rate().unwrap_or(44100);
    let number_of_channels = props.channels().unwrap_or(2) as u32;
    let bitrate = props.audio_bitrate().unwrap_or(128) * 1000;
    let bit_depth = props.bit_depth().map(|d| d as u32);

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let lossless = matches!(ext.as_str(), "wav" | "flac" | "aiff" | "alac");

    let format_info = FormatInfo {
        duration,
        sample_rate,
        number_of_channels,
        bitrate,
        bit_depth,
        lossless,
    };

    let mut tag_info = TagInfo {
        disc: "1".to_string(),
        track: "01".to_string(),
        ..Default::default()
    };

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
        if let Some(year) = tag.year() {
            tag_info.year = year.to_string();
        }
    }

    Ok((format_info, tag_info))
}
