use super::*;
use crate::audio::audit::compute_pcm_fingerprint;

fn settings(keep: bool) -> ConverterSettings {
    ConverterSettings {
        output_format: "FLAC".into(),
        bitrate: Some("192".into()),
        sample_rate: Some(44100),
        bit_depth: Some("16".into()),
        channels: Some(2),
        normalize: Some(false),
        normalization_target_db: Some(-1.0),
        volume_boost_db: Some(0.0),
        trim_silence: Some(false),
        trim_silence_threshold_db: Some(-50.0),
        thread_pool_size: Some(2),
        same_as_source: Some(keep),
        save_in_source_folder: Some(false),
        local_save_path: None,
        max_sample_rate: None,
        flac_compression_level: None,
        flac_uncompressed: None,
        on_existing: None,
        keep_folder_levels: None,
        keep_folder_from: None,
        bitrate_mode: None,
        vbr_quality: None,
        cover_external: None,
        cover_resize: None,
        cover_max_width: None,
        cover_max_height: None,
        cover_format: None,
        save_cover_file: None,
        dop: None,
        tempo_enabled: None,
        tempo_from: None,
        tempo_to: None,
        fade_enabled: None,
        fade_in_seconds: None,
        fade_out_seconds: None,
        pad_start_seconds: None,
        pad_end_seconds: None,
        action_mode: None,
    }
}

fn no_tags() -> TagMap {
    Vec::new()
}

fn tm(pairs: &[(&str, &str)]) -> TagMap {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
}

// ---------------------------------------------------------------- unit tests

#[test]
fn safe_file_name_cleans_reserved_and_long_names() {
    assert_eq!(safe_file_name("a/b:c*?.\u{1}"), "a_b_c__._");
    assert_eq!(safe_file_name("name. . "), "name");
    assert_eq!(safe_file_name(""), "audio");
    assert_eq!(safe_file_name("CON"), "_CON");
    assert_eq!(safe_file_name("com1.track"), "_com1.track");
    assert_eq!(safe_file_name("com0"), "com0");
    assert_eq!(safe_file_name("console"), "console");
    let long = "あ".repeat(300);
    let cleaned = safe_file_name(&long);
    assert_eq!(cleaned.chars().count(), STEM_LIMIT_CHARS);
}

#[test]
fn output_stem_uses_requested_name_without_its_extension() {
    let input = Path::new("/music/source track.flac");
    assert_eq!(output_stem("01-02 Title.m4a", input), "01-02 Title");
    assert_eq!(output_stem("AC_DC - T.N.T.flac", input), "AC_DC - T.N.T");
    assert_eq!(output_stem("", input), "source track");
    assert_eq!(output_stem(".hidden", input), ".hidden");
}

#[test]
fn name_parts_make_safe_subfolders() {
    let input = Path::new("/music/source track.flac");
    let parts = |n: &str| output_name_parts(n, input);
    assert_eq!(parts("Artist/Album\\01 T.m4a"), (vec!["Artist".to_string(), "Album".to_string()], "01 T".to_string()));
    assert_eq!(parts("../../x"), (vec!["audio".to_string(), "audio".to_string()], "x".to_string()));
    assert_eq!(parts("/abs/C:/x"), (vec!["abs".to_string(), "C_".to_string()], "x".to_string()));
    assert_eq!(parts("dir/"), (vec![], "dir".to_string()));
    assert_eq!(parts(""), (vec![], "source track".to_string()));
}

#[test]
fn kept_source_folders_take_first_or_last_levels() {
    let input = Path::new("/Music/Artist/Album/CD1/01.flac");
    assert_eq!(kept_source_folders(input, 2, false), ["Album", "CD1"]);
    assert_eq!(kept_source_folders(input, 2, true), ["Music", "Artist"]);
    assert_eq!(kept_source_folders(input, 0, false), Vec::<String>::new());
    assert_eq!(kept_source_folders(input, 9, false), ["Music", "Artist", "Album", "CD1"]);
    // "First" counts below the home folder or the volume, not from the root.
    let home = dirs::home_dir().unwrap();
    assert_eq!(kept_source_folders(&home.join("Music/Rock/Queen/x.flac"), 2, true), ["Music", "Rock"]);
    assert_eq!(kept_source_folders(Path::new("/Volumes/USB/Music/Rock/x.flac"), 1, true), ["Music"]);
    assert_eq!(kept_source_folders(Path::new("/media/al/Disk/A/B/x.flac"), 2, true), ["A", "B"]);
}

#[test]
fn probe_parses_lossless_and_lossy_streams() {
    let flac = "Input #0, flac, from 'a.flac':\n  Duration: 00:03:21.50, start: 0.000000, bitrate: 2000 kb/s\n  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)\n  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500, 90k tbr, 90k tbn (attached pic)\n";
    let info = parse_ffmpeg_probe(flac);
    assert_eq!(info.codec.as_deref(), Some("flac"));
    assert_eq!(info.sample_rate, Some(96000));
    assert_eq!(info.channels, Some(2));
    assert_eq!(info.bits_per_sample, Some(24));
    assert_eq!(info.lossless, Some(true));
    assert!(info.has_art());
    assert!(!info.is_float);
    assert!((info.duration - 201.5).abs() < 1e-9);

    let mp3 = "  Duration: 00:00:10.00, start: 0.025057, bitrate: 320 kb/s\n  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s\n";
    let info = parse_ffmpeg_probe(mp3);
    assert_eq!(info.lossless, Some(false));
    assert!(!info.is_float, "a lossy decoder's float output is not a float source");
    assert!(!info.has_art());

    let alac = "  Stream #0:0[0x1](und): Audio: alac (alac / 0x63616C61), 44100 Hz, stereo, s16p, 1411 kb/s (default)\n";
    let info = parse_ffmpeg_probe(alac);
    assert_eq!(info.codec.as_deref(), Some("alac"));
    assert_eq!(info.lossless, Some(true));

    let wav = "  Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, 6 channels, flt, 9216 kb/s\n";
    let info = parse_ffmpeg_probe(wav);
    assert!(info.is_float);
    assert_eq!(info.bits_per_sample, Some(32));
    assert_eq!(info.channels, Some(6));

    let s24 = "  Stream #0:0: Audio: pcm_s24le ([1][0][0][0] / 0x0001), 48000 Hz, 5.1, s32 (24 bit), 6912 kb/s\n";
    let info = parse_ffmpeg_probe(s24);
    assert_eq!(info.bits_per_sample, Some(24));
    assert_eq!(info.channels, Some(6));
    assert!(!info.is_float);
}

#[test]
fn codec_classification() {
    assert_eq!(codec_is_lossless("pcm_s16le"), Some(true));
    assert_eq!(codec_is_lossless("pcm_mulaw"), Some(false));
    assert_eq!(codec_is_lossless("ape"), Some(true));
    assert_eq!(codec_is_lossless("dsd_lsbf"), Some(false));
    assert_eq!(codec_is_lossless("aac"), Some(false));
    assert_eq!(codec_is_lossless("something_new"), None);
}

fn src(bits: u32, rate: u32, ch: u32, lossless: bool, float: bool) -> SourceInfo {
    SourceInfo {
        duration: 10.0,
        sample_rate: Some(rate),
        channels: Some(ch),
        bits_per_sample: Some(bits),
        is_float: float,
        lossless: Some(lossless),
        cover_stream: Some(1),
        custom_layout: false,
        codec: Some(if lossless { "flac".into() } else { "mp3".into() }),
        range: None,
        external_cover: None,
        cover_is_png: false,
        layout: None,
        channel: None,
    }
}

#[test]
fn keep_mode_preserves_24_bit_for_wav_aiff_flac_alac() {
    let s = src(24, 96000, 2, true, false);
    let (i, o) = (Path::new("in.flac"), Path::new("out"));
    let wav = build_encode_args(OutFormat::Wav, i, o, &settings(true), &s, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&wav.args, "-c:a"), Some("pcm_s24le"));
    assert_eq!(arg_after(&wav.args, "-ar"), Some("96000"));
    assert_eq!(arg_after(&wav.args, "-map_metadata"), Some("-1"));
    let aiff = build_encode_args(OutFormat::Aiff, i, o, &settings(true), &s, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&aiff.args, "-c:a"), Some("pcm_s24be"));
    let flac = build_encode_args(OutFormat::Flac, i, o, &settings(true), &s, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&flac.args, "-sample_fmt"), Some("s32"));
    assert_eq!(arg_after(&flac.args, "-bits_per_raw_sample"), Some("24"));
    assert!(flac.args.iter().any(|a| a == "attached_pic"), "cover must be kept");
    let alac = build_encode_args(OutFormat::Alac, i, o, &settings(true), &s, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&alac.args, "-sample_fmt"), Some("s32p"));
    assert_eq!(alac.expected_bits, Some(24));
}

#[test]
fn keep_mode_rejects_formats_that_cannot_hold_the_source() {
    let (i, o) = (Path::new("in.wav"), Path::new("out"));
    let float = src(32, 48000, 2, true, true);
    assert!(build_encode_args(OutFormat::Flac, i, o, &settings(true), &float, &no_tags(), None).is_err());
    assert!(build_encode_args(OutFormat::Alac, i, o, &settings(true), &float, &no_tags(), None).is_err());
    let wav = build_encode_args(OutFormat::Wav, i, o, &settings(true), &float, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&wav.args, "-c:a"), Some("pcm_f32le"));
    let s32 = src(32, 48000, 2, true, false);
    assert!(build_encode_args(OutFormat::Alac, i, o, &settings(true), &s32, &no_tags(), None).is_err());
    let unknown = SourceInfo { bits_per_sample: None, ..src(16, 44100, 2, true, false) };
    assert!(build_encode_args(OutFormat::Flac, i, o, &settings(true), &unknown, &no_tags(), None).is_err());
}

#[test]
fn lossy_outputs_get_rates_channels_and_bitrates_the_encoder_accepts() {
    let (i, o) = (Path::new("in.flac"), Path::new("out"));
    let hi = src(24, 96000, 6, true, false);
    let mp3 = build_encode_args(OutFormat::Mp3, i, o, &settings(true), &hi, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&mp3.args, "-ar"), Some("48000"));
    assert_eq!(arg_after(&mp3.args, "-ac"), None, "channels are changed by a filter, never -ac");
    assert_eq!(arg_after(&mp3.args, "-af"), Some(format!("{},aformat=channel_layouts=stereo", resample_filter(48000)).as_str()));
    assert_eq!(arg_after(&mp3.args, "-b:a"), Some("192k"));
    let wma = build_encode_args(OutFormat::Wma, i, o, &settings(true), &hi, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&wma.args, "-ar"), Some("48000"));
    assert!(arg_after(&wma.args, "-af").unwrap().contains("channel_layouts=stereo"));
    let cd = src(16, 44100, 2, true, false);
    let opus = build_encode_args(OutFormat::Opus, i, o, &settings(true), &cd, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&opus.args, "-ar"), Some("48000"), "Opus has no 44.1 kHz mode");
    let ogg = build_encode_args(OutFormat::Ogg, i, o, &settings(true), &cd, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&ogg.args, "-b:a"), None, "Vorbis uses quality mode");
    assert_eq!(arg_after(&ogg.args, "-q:a"), Some("6.0"));
    let mut st = settings(true);
    st.bitrate = Some("320".into());
    let mono = src(16, 44100, 1, true, false);
    let opus = build_encode_args(OutFormat::Opus, i, o, &st, &mono, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&opus.args, "-b:a"), Some("256k"), "Opus allows at most 256 kbps per channel");
    // Explicit 5.1 to MP3 is reduced to stereo instead of failing.
    let mut st = settings(false);
    st.channels = Some(6);
    let mp3 = build_encode_args(OutFormat::Mp3, i, o, &st, &hi, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&mp3.args, "-ac"), None);
    assert!(arg_after(&mp3.args, "-af").unwrap().contains("channel_layouts=stereo"));
}

#[test]
fn rate_picking_prefers_whole_ratios() {
    assert_eq!(pick_rate(OutFormat::Mp3, 88200), 44100);
    assert_eq!(pick_rate(OutFormat::Mp3, 96000), 48000);
    assert_eq!(pick_rate(OutFormat::Mp3, 176400), 44100);
    assert_eq!(pick_rate(OutFormat::Ac3, 22050), 32000);
    assert_eq!(pick_rate(OutFormat::M4a, 192000), 96000);
    assert_eq!(pick_rate(OutFormat::Flac, 192000), 192000);
}

#[test]
fn bit_depth_edge_cases() {
    let (i, o) = (Path::new("in"), Path::new("out"));
    let u8src = src(8, 44100, 2, true, false);
    let flac = build_encode_args(OutFormat::Flac, i, o, &settings(true), &u8src, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&flac.args, "-bits_per_raw_sample"), Some("16"), "8-bit is stored as 16-bit");
    assert_eq!(flac.expected_bits, Some(16));
    let wav = build_encode_args(OutFormat::Wav, i, o, &settings(true), &u8src, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&wav.args, "-c:a"), Some("pcm_u8"));
    let s32 = src(32, 48000, 2, true, false);
    assert!(build_encode_args(OutFormat::Flac, i, o, &settings(true), &s32, &no_tags(), None).is_err(), "FFmpeg FLAC stops at 24-bit");
    // Explicit "32-bit" is float.
    let mut st = settings(false);
    st.bit_depth = Some("32".into());
    let cd = src(16, 44100, 2, true, false);
    let wav = build_encode_args(OutFormat::Wav, i, o, &st, &cd, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&wav.args, "-c:a"), Some("pcm_f32le"));
    let wv = build_encode_args(OutFormat::WavPack, i, o, &st, &cd, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&wv.args, "-sample_fmt"), Some("fltp"));
    let err = build_encode_args(OutFormat::Alac, i, o, &st, &cd, &no_tags(), None).err().unwrap();
    assert!(err.contains("floating-point") && !err.contains("same as source"), "{err}");
}

#[test]
fn cover_is_mapped_by_stream_index() {
    let probe = "  Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080\n  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp\n  Stream #0:2: Video: png, rgba(pc), 300x300, 90k tbr, 90k tbn (attached pic)\n";
    let info = parse_ffmpeg_probe(probe);
    assert_eq!(info.cover_stream, Some(2));
    let plan = build_encode_args(OutFormat::Alac, Path::new("i"), Path::new("o"), &settings(true), &SourceInfo { bits_per_sample: Some(16), lossless: Some(true), ..info.clone() }, &no_tags(), None).unwrap();
    assert!(plan.args.windows(2).any(|w| w[0] == "-map" && w[1] == "0:2"));
    let tiff = parse_ffmpeg_probe("  Stream #0:1: Video: tiff, rgb24, 300x300 (attached pic)\n  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16\n");
    assert_eq!(tiff.cover_stream, None, "only JPEG/PNG covers are copied");
    assert_eq!(tiff.bits_per_sample, Some(16), "lossless s16 without '(16 bit)'");
}

#[test]
fn probe_ignores_tag_text_that_looks_like_stream_lines() {
    let probe = "  Metadata:\n    comment         : first\n                    : Stream #0:0: Audio: mp3, 8000 Hz, mono, fltp\n  Duration: 00:00:02.00, start: 0.0\n  Stream #0:0: Audio: flac, 44100 Hz, 2 channels (FL+FC), s16\n";
    let info = parse_ffmpeg_probe(probe);
    assert_eq!(info.codec.as_deref(), Some("flac"));
    assert_eq!(info.channels, Some(2));
    assert!((info.duration - 2.0).abs() < 1e-9);
}

#[test]
fn track_totals_survive_edits_and_home_is_expanded() {
    let source = tm(&[("track", "3/12"), ("disc", "1/2")]);
    let edits = InputTags { track: Some("04".into()), disc: Some("2/3".into()), ..Default::default() };
    assert_eq!(merge_tags(&source, Some(&edits)), tm(&[("track", "04/12"), ("disc", "2/3")]));
    let home = dirs::home_dir().unwrap();
    assert_eq!(expand_home("~/Music/x"), home.join("Music/x"));
    assert_eq!(expand_home("/abs"), PathBuf::from("/abs"));
}

#[test]
fn lossy_source_to_lossless_uses_24_bit() {
    let mp3 = SourceInfo { bits_per_sample: None, ..src(0, 44100, 2, false, false) };
    let plan = build_encode_args(OutFormat::Flac, Path::new("a.mp3"), Path::new("o"), &settings(true), &mp3, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&plan.args, "-bits_per_raw_sample"), Some("24"));
}

#[test]
fn explicit_mode_applies_depth_rate_gain_and_trim() {
    let mut st = settings(false);
    st.bit_depth = Some("24".into());
    st.sample_rate = Some(48000);
    st.trim_silence = Some(true);
    let s = src(16, 44100, 2, true, false);
    let plan = build_encode_args(OutFormat::Wav, Path::new("i"), Path::new("o"), &st, &s, &no_tags(), Some(-3.5)).unwrap();
    assert_eq!(arg_after(&plan.args, "-c:a"), Some("pcm_s24le"));
    assert_eq!(arg_after(&plan.args, "-ar"), Some("48000"));
    let af = arg_after(&plan.args, "-af").unwrap();
    assert!(af.contains("silenceremove") && af.contains("aresample=48000:") && !af.contains("channel_layouts") && af.ends_with("volume=-3.5000dB"), "{af}");
    // Gain is ignored in keep mode.
    let keep = build_encode_args(OutFormat::Wav, Path::new("i"), Path::new("o"), &settings(true), &s, &no_tags(), Some(6.0)).unwrap();
    assert_eq!(arg_after(&keep.args, "-af"), None);
}

#[test]
fn edits_override_source_tags_and_empty_edits_remove_them() {
    let source = tm(&[("TITLE", "Old"), ("artist", "A"), ("genre", "Rock"), ("encoder", "Lavf"), ("track", "3/12")]);
    let edits = InputTags { title: Some("New".into()), genre: Some("".into()), album_artist: Some("AA".into()), ..Default::default() };
    let merged = merge_tags(&source, Some(&edits));
    assert_eq!(merged, tm(&[("artist", "A"), ("encoder", "Lavf"), ("track", "3/12"), ("title", "New"), ("album_artist", "AA")]));
}

#[test]
fn tags_are_written_per_container() {
    let tags = tm(&[("title", "T"), ("album_artist", "AA"), ("date", "1999"), ("encoder", "Lavf"), ("replaygain_track_gain", "-3 dB")]);
    let s = src(16, 44100, 2, true, false);
    let meta = |plan: &EncodePlan, flag: &str| -> Vec<String> {
        plan.args.windows(2).filter(|w| w[0] == flag).map(|w| w[1].clone()).collect()
    };
    let flac = build_encode_args(OutFormat::Flac, Path::new("i"), Path::new("o"), &settings(true), &s, &tags, None).unwrap();
    assert_eq!(arg_after(&flac.args, "-map_metadata"), Some("-1"));
    assert_eq!(meta(&flac, "-metadata"), ["title=T", "album_artist=AA", "date=1999", "replaygain_track_gain=-3 dB"]);
    let ogg = build_encode_args(OutFormat::Ogg, Path::new("i"), Path::new("o"), &settings(true), &s, &tags, None).unwrap();
    assert!(meta(&ogg, "-metadata").is_empty());
    assert_eq!(meta(&ogg, "-metadata:s:a:0").len(), 4, "Ogg keeps tags in the stream");
    let wv = build_encode_args(OutFormat::WavPack, Path::new("i"), Path::new("o"), &settings(true), &s, &tags, None).unwrap();
    assert_eq!(meta(&wv, "-metadata"), ["Title=T", "Album Artist=AA", "Year=1999", "replaygain_track_gain=-3 dB"]);
    let wav = build_encode_args(OutFormat::Wav, Path::new("i"), Path::new("o"), &settings(true), &s, &tags, None).unwrap();
    assert!(meta(&wav, "-metadata").is_empty());
    // Loudness tags are wrong once the volume changes.
    let gained = build_encode_args(OutFormat::Flac, Path::new("i"), Path::new("o"), &settings(false), &s, &tags, Some(3.0)).unwrap();
    assert!(!meta(&gained, "-metadata").iter().any(|m| m.starts_with("replaygain")));
}

#[test]
fn ffmetadata_is_parsed_with_escapes() {
    let text = ";FFMETADATA1\ntitle=a\\=b\\;c\nARTIST=x\ncomment=line1\\\nline2\npath=C:\\\\dir\\\\\\\nnext\nencoder=Lavf\n[CHAPTER]\ntitle=chap\n";
    assert_eq!(
        parse_ffmetadata(text),
        tm(&[("title", "a=b;c"), ("artist", "x"), ("comment", "line1\nline2"), ("path", "C:\\dir\\\nnext"), ("encoder", "Lavf")])
    );
}

#[test]
fn id3_frames_are_utf16_and_sized() {
    let tags = tm(&[("title", "曲"), ("comment", "c"), ("date", "1999-05-01"), ("track", "3/12")]);
    let id3 = build_id3v23(&tags).unwrap();
    assert_eq!(&id3[0..5], b"ID3\x03\x00");
    let size = ((id3[6] as usize) << 21) | ((id3[7] as usize) << 14) | ((id3[8] as usize) << 7) | id3[9] as usize;
    assert_eq!(size, id3.len() - 10);
    assert_eq!(&id3[10..14], b"TIT2");
    assert!(id3.windows(4).any(|w| w == b"TYER"));
    assert!(build_id3v23(&no_tags()).is_none());
    assert!(build_id3v23(&tm(&[("date", "unknown")])).is_none(), "TYER needs four digits");
}

#[test]
fn max_volume_is_parsed() {
    assert_eq!(parse_max_volume("[Parsed_volumedetect_0 @ 0x1] max_volume: -6.2 dB\n"), Some(-6.2));
    assert_eq!(parse_max_volume("max_volume: -inf dB"), Some(f64::NEG_INFINITY));
    assert_eq!(parse_max_volume("nothing"), None);
}

// ------------------------------------------------- integration tests (FFmpeg)

/// Integration tests skip when FFmpeg is missing, except when REQUIRE_FFMPEG is set
/// (CI), where a missing FFmpeg must fail instead of passing silently.
fn ffmpeg_available() -> bool {
    let ok = hidden_command(&get_ffmpeg_executable()).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if !ok && std::env::var_os("REQUIRE_FFMPEG").is_some() {
        panic!("FFmpeg is required but {} does not run", get_ffmpeg_executable().display());
    }
    ok
}

fn ffmpeg(args: &[&str]) {
    let st = hidden_command(&get_ffmpeg_executable()).args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]).args(args).status().unwrap();
    assert!(st.success(), "ffmpeg {args:?}");
}

struct Dir(PathBuf);
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn temp_dir() -> Dir {
    let d = std::env::temp_dir().join(format!("ac-test-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&d).unwrap();
    Dir(d)
}

fn ctx() -> JobCtx {
    JobCtx { app: None, jobs: Arc::new(Mutex::new(HashMap::new())), job_id: None }
}

fn request(input: &Path, out_dir: &Path, format: &str, file_name: &str) -> ConvertRequest {
    let mut st = settings(true);
    st.local_save_path = Some(out_dir.to_string_lossy().into_owned());
    ConvertRequest {
        input_file_path: input.to_string_lossy().into_owned(),
        file_name: file_name.into(),
        output_format: format.into(),
        job_id: None,
        settings: st,
        tags: None,
        start_seconds: None,
        end_seconds: None,
        channel: None,
    }
}

/// 24-bit / 96 kHz stereo FLAC with an embedded cover and a title tag.
fn make_source(dir: &Path) -> PathBuf {
    let cover = dir.join("cover.png");
    ffmpeg(&["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", cover.to_str().unwrap()]);
    let src = dir.join("source.flac");
    ffmpeg(&[
        "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=96000:duration=1", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=96000:duration=1", "-i", cover.to_str().unwrap(), "-filter_complex",
        "[0:a][1:a]amerge=inputs=2[a]", "-map", "[a]", "-map", "2:v", "-c:a", "flac", "-sample_fmt", "s32",
        "-bits_per_raw_sample", "24", "-c:v", "copy", "-disposition:v", "attached_pic", "-metadata", "title=Source",
        src.to_str().unwrap(),
    ]);
    src
}

#[test]
fn converts_24_bit_losslessly_with_requested_name_cover_and_tags() {
    if !ffmpeg_available() {
        eprintln!("skipped: ffmpeg not found");
        return;
    }
    let d = temp_dir();
    let src = make_source(&d.0);
    let out = d.0.join("out");
    let src_hash = compute_pcm_fingerprint(src.to_str().unwrap()).unwrap().0;
    let ff = get_ffmpeg_executable();

    for (format, ext) in [("ALAC", "m4a"), ("FLAC", "flac"), ("WAV", "wav"), ("AIFF", "aiff")] {
        let mut req = request(&src, &out, format, "01-02 Renamed.flac");
        req.tags = Some(InputTags { artist: Some("Artist".into()), track: Some("02".into()), disc: Some("1".into()), ..Default::default() });
        let (path, name) = convert_blocking(&ctx(), &req).unwrap_or_else(|e| panic!("{format}: {e}"));
        assert_eq!(name, format!("01-02 Renamed.{ext}"), "{format}");
        let info = probe_source(&ff, &path).unwrap();
        assert_eq!((info.sample_rate, info.channels, info.bits_per_sample), (Some(96000), Some(2), Some(24)), "{format}");
        let out_hash = compute_pcm_fingerprint(path.to_str().unwrap()).unwrap().0;
        assert_eq!(out_hash, src_hash, "{format} must be bit-exact");
        if matches!(format, "ALAC" | "FLAC") {
            assert!(info.has_art(), "{format} must keep the cover");
        }
        let tagged = lofty::probe::Probe::open(&path).unwrap().read().unwrap();
        let tag = lofty::file::TaggedFileExt::primary_tag(&tagged).or_else(|| lofty::file::TaggedFileExt::first_tag(&tagged)).unwrap_or_else(|| panic!("{format}: no tag"));
        use lofty::tag::Accessor;
        assert_eq!(tag.artist().as_deref(), Some("Artist"), "{format}");
        assert_eq!(tag.track(), Some(2), "{format}");
        assert_eq!(tag.title().as_deref(), Some("Source"), "{format}: source tags are kept");
    }

    // Same name again: a numbered copy, the first file is untouched.
    let (_, name) = convert_blocking(&ctx(), &request(&src, &out, "FLAC", "01-02 Renamed")).unwrap();
    assert_eq!(name, "01-02 Renamed_2.flac");
    let leftovers: Vec<_> = fs::read_dir(&out).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
    assert!(leftovers.is_empty(), "staging files must be removed");
}

#[test]
fn output_keeps_source_folders_and_pattern_subfolders() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let album = d.0.join("Artist").join("Album");
    fs::create_dir_all(&album).unwrap();
    let src = album.join("a.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.3", src.to_str().unwrap()]);
    let out = d.0.join("out");
    let mut req = request(&src, &out, "FLAC", "Disc 1/01 Song");
    req.settings.keep_folder_levels = Some(2);
    let (path, name) = convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(path, out.join("Artist").join("Album").join("Disc 1").join("01 Song.flac"));
    assert_eq!(name, "01 Song.flac");

    // In the source folder, only the pattern's subfolders are added.
    req.settings.save_in_source_folder = Some(true);
    let (path, _) = convert_blocking(&ctx(), &req).unwrap();
    let album = simplify_verbatim_path(fs::canonicalize(&album).unwrap());
    assert_eq!(path, album.join("Disc 1").join("01 Song.flac"));
}

#[test]
fn cue_tracks_are_cut_sample_exact_and_verified() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    // 3 s at 44.1 kHz; the CUE (naming the WAV it was ripped to) splits at 1 s and 2.2 s.
    let image = d.0.join("image.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-ac", "2", "-c:a", "flac", "-metadata", "title=Whole image", "-metadata", "cuesheet=x", image.to_str().unwrap()]);
    let cue = d.0.join("image.cue");
    fs::write(&cue, "PERFORMER \"Band\"\nTITLE \"Album\"\nFILE \"image.wav\" WAVE\n  TRACK 01 AUDIO\n    TITLE \"One\"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE \"Two\"\n    INDEX 00 00:00:70\n    INDEX 01 00:01:00\n  TRACK 03 AUDIO\n    TITLE \"Three\"\n    INDEX 01 00:02:15\n").unwrap();
    let tracks = crate::audio::cue::read_image_tracks(&cue);
    assert!(tracks.success, "{:?}", tracks.error);
    let t = &tracks.tracks[1];
    let mut req = request(Path::new(&t.audio_path), &d.0.join("out"), "FLAC", "02 Two");
    req.start_seconds = Some(t.start);
    req.end_seconds = t.end;
    req.tags = Some(InputTags { title: Some("Two".into()), track: Some("2/3".into()), ..Default::default() });
    let (path, _) = convert_blocking(&ctx(), &req).unwrap();
    let ff = get_ffmpeg_executable();
    let (_, bytes) = compute_pcm_fingerprint(path.to_str().unwrap()).unwrap();
    assert_eq!(bytes, (2.2f64 * 44100.0 - 44100.0).round() as usize * 2 * 8, "1.2 s exactly (f64 stereo)");
    let r = crate::audio::audit::verify_quality_range(&t.audio_path, &path.to_string_lossy(), true, Some((t.start, t.end)), &|| false);
    assert_eq!(r.result.unwrap().status, "perfect");
    let tags = read_source_tags(&ff, &path).unwrap();
    assert!(tags.iter().any(|(k, v)| k == "title" && v == "Two"));
    assert!(!tags.iter().any(|(k, _)| k == "cuesheet"), "the image's sheet is not copied: {tags:?}");

    // The last track runs to the end; the same pattern name gets a new name, never
    // overwriting the other track even with "overwrite".
    let last = &tracks.tracks[2];
    let mut req = request(Path::new(&last.audio_path), &d.0.join("out"), "FLAC", "02 Two");
    req.settings.on_existing = Some("overwrite".into());
    req.start_seconds = Some(last.start);
    let (path3, name) = convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(name, "02 Two_2.flac");
    assert!((probe_source(&ff, &path3).unwrap().duration - 0.8).abs() < 0.01);
    assert!(path.exists());
}

#[test]
fn chapters_split_an_audio_file() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let meta = d.0.join("meta.txt");
    fs::write(&meta, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=A\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=500\nEND=1000\ntitle=B\n").unwrap();
    let book = d.0.join("book.m4a");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=1", "-i", meta.to_str().unwrap(), "-map_metadata", "1", "-map_chapters", "1", "-c:a", "aac", book.to_str().unwrap()]);
    let r = crate::audio::cue::read_image_tracks(&book);
    assert_eq!(r.tracks.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["A", "B"]);
    assert_eq!(r.tracks[1].start, 0.5);
    let plain = d.0.join("plain.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.2", plain.to_str().unwrap()]);
    assert!(crate::audio::cue::read_image_tracks(&plain).tracks.is_empty());
}

#[test]
fn merge_joins_sources_and_writes_a_cue_sheet() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let first = make_source(&d.0); // 96 kHz 24-bit stereo with a cover, 1 s
    let second = d.0.join("second.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=2", "-c:a", "pcm_s16le", second.to_str().unwrap()]);
    let mut st = settings(true);
    st.local_save_path = Some(d.0.join("out").to_string_lossy().into_owned());
    let req = merge::MergeRequest {
        inputs: vec![
            merge::MergeInput { path: first.to_string_lossy().into_owned(), start_seconds: None, end_seconds: None, title: "One".into(), artist: "A".into() },
            // Only 0.5 s .. 1.5 s of the second file (a track of an image).
            merge::MergeInput { path: second.to_string_lossy().into_owned(), start_seconds: Some(0.5), end_seconds: Some(1.5), title: "Two \"x\"".into(), artist: String::new() },
        ],
        file_name: "Album".into(),
        output_format: "FLAC".into(),
        job_id: None,
        settings: st,
        tags: Some(InputTags { album: Some("Album".into()), album_artist: Some("A".into()), ..Default::default() }),
        create_cue: Some(true),
        verify: Some(true),
        join_channels: false,
    };
    let m = merge::merge_blocking(&ctx(), &req).unwrap();
    // The second part was resampled (44.1 -> 96 kHz): no bit-exact claim.
    assert_eq!(m.verified.as_ref().map(|v| v.0), Some(false));
    let ff = get_ffmpeg_executable();
    let info = probe_source(&ff, &m.converted.path).unwrap();
    assert_eq!((info.sample_rate, info.channels, info.bits_per_sample), (Some(96000), Some(2), Some(24)));
    assert!((info.duration - 2.0).abs() < 0.01, "{}", info.duration);
    assert!(info.has_art(), "the first source's cover is kept");
    let cue = fs::read_to_string(m.cue.as_ref().unwrap()).unwrap();
    assert!(cue.contains("FILE \"Album.flac\" WAVE"), "{cue}");
    assert!(cue.contains("TRACK 02 AUDIO\r\n    TITLE \"Two 'x'\"\r\n    INDEX 01 00:01:00"), "{cue}");
    // The sheet reads back as the two tracks.
    let back = crate::audio::cue::read_image_tracks(m.cue.as_ref().unwrap());
    assert_eq!(back.tracks.len(), 2);
    assert_eq!(back.tracks[1].start, 1.0);
    // The first second is the first source, bit for bit.
    let (h1, _) = crate::audio::audit::compute_pcm_fingerprint_range(&first.to_string_lossy(), None, &|| false).unwrap();
    let (h2, _) = crate::audio::audit::compute_pcm_fingerprint_range(&m.converted.path.to_string_lossy(), Some((0.0, Some(1.0))), &|| false).unwrap();
    assert_eq!(h1, h2);
    assert_eq!(merge::cue_time(44100 * 61 + 588, 44100), "01:01:01");

    // Same-format parts verify as bit-exact.
    let third = d.0.join("third.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=700:sample_rate=96000:duration=0.7", "-ac", "2", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", third.to_str().unwrap()]);
    let mut req2 = req.clone();
    req2.inputs[1] = merge::MergeInput { path: third.to_string_lossy().into_owned(), start_seconds: None, end_seconds: None, title: "Three".into(), artist: String::new() };
    let m2 = merge::merge_blocking(&ctx(), &req2).unwrap();
    assert_eq!(m2.verified, Some((true, "All 2 parts are bit-exact with their sources".to_string())));
    assert!(m2.cue.unwrap().ends_with("Album_2.cue"));
}

#[test]
fn ebur128_summary_is_parsed() {
    let log = "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -20.5 LUFS\n    Threshold: -30.6 LUFS\n\n  Sample peak:\n    Peak:       -6.0 dBFS\n";
    let l = loudness::parse_ebur128_summary(log).unwrap();
    assert_eq!(l.integrated, -20.5);
    assert!((l.peak - 0.501187).abs() < 1e-5);
    let tags = loudness::loudness_tags(OutFormat::Flac, l, Some(loudness::Loudness { integrated: -19.0, peak: 0.9 }));
    assert_eq!(tags[0], ("REPLAYGAIN_TRACK_GAIN".to_string(), "+2.50 dB".to_string()));
    assert_eq!(tags[2], ("REPLAYGAIN_ALBUM_GAIN".to_string(), "+1.00 dB".to_string()));
    assert_eq!(loudness::loudness_tags(OutFormat::Opus, l, None), [("R128_TRACK_GAIN".to_string(), "-640".to_string())]);
}

#[test]
fn replaygain_tags_are_written_without_touching_the_audio() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = make_source(&d.0);
    let ff = get_ffmpeg_executable();
    let mut paths = Vec::new();
    for format in ["FLAC", "ALAC", "M4A", "MP3", "OGG", "OPUS", "WAV", "AIFF", "WAVPACK"] {
        let (path, _) = convert_blocking(&ctx(), &request(&src, &d.0.join("out"), format, format)).unwrap_or_else(|e| panic!("{format}: {e}"));
        paths.push(path);
    }
    let before: Vec<_> = paths.iter().map(|p| compute_pcm_fingerprint(p.to_str().unwrap()).unwrap()).collect();
    let req = loudness::LoudnessRequest { paths: paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(), album: true, job_id: None };
    let res = loudness::write_loudness_blocking(&ctx(), &req);
    assert!(res.success, "{:?}", res.results.iter().filter(|r| r.error.is_some()).collect::<Vec<_>>());
    assert!(res.album_gain_db.is_some());
    for (p, h) in paths.iter().zip(&before) {
        assert_eq!(&compute_pcm_fingerprint(p.to_str().unwrap()).unwrap(), h, "{}: audio unchanged", p.display());
        let tags = read_source_tags(&ff, p).unwrap();
        let key = if p.extension().unwrap() == "opus" { "r128_album_gain" } else { "replaygain_album_gain" };
        assert!(tags.iter().any(|(k, _)| k == key), "{}: {tags:?}", p.display());
        assert!(tags.iter().any(|(k, v)| k == "title" && v == "Source"), "{}: other tags kept", p.display());
        // Still this session's output of `src`: another source must not overwrite it.
        assert!(written_from_other_source(p, &d.0.join("cover.png"), ""), "{}", p.display());
    }
    assert!(probe_source(&ff, &paths[0]).unwrap().has_art(), "FLAC keeps its cover");
}

#[test]
fn external_covers_are_embedded_resized_and_saved() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let album = d.0.join("album");
    fs::create_dir_all(&album).unwrap();
    let src = album.join("a.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", src.to_str().unwrap()]);
    ffmpeg(&["-f", "lavfi", "-i", "color=c=blue:s=900x600:d=1", "-frames:v", "1", album.join("Folder.PNG").to_str().unwrap()]);
    let out = d.0.join("out");
    let ff = get_ffmpeg_executable();

    let (plain, _) = convert_blocking(&ctx(), &request(&src, &out, "FLAC", "plain")).unwrap();
    let info = probe_source(&ff, &plain).unwrap();
    assert!(info.has_art() && info.cover_is_png, "the external PNG is embedded as is");

    let mut req = request(&src, &out, "M4A", "small");
    req.settings.cover_resize = Some(true);
    req.settings.cover_format = Some("jpeg".into());
    req.settings.save_cover_file = Some(true);
    let (small, _) = convert_blocking(&ctx(), &req).unwrap();
    let info = probe_source(&ff, &small).unwrap();
    assert!(info.has_art() && !info.cover_is_png, "converted to JPEG");
    let probe = String::from_utf8_lossy(&hidden_command(&ff).arg("-i").arg(&small).output().unwrap().stderr).into_owned();
    assert!(probe.contains("400x266"), "shrunk to fit 400x400: {probe}");
    let saved = out.join("folder.jpg");
    assert!(saved.is_file(), "folder.jpg saved");
    let before = fs::read(&saved).unwrap();
    convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(fs::read(&saved).unwrap(), before, "an existing folder.jpg is kept");

    let mut off = request(&src, &out, "FLAC", "none");
    off.settings.cover_external = Some(false);
    let (none, _) = convert_blocking(&ctx(), &off).unwrap();
    assert!(!probe_source(&ff, &none).unwrap().has_art());
}

fn dsd_bits(path: &Path) -> (u32, u32, Vec<Vec<u8>>) {
    let mut r = dsd::DsdReader::open(path).unwrap();
    let mut all = vec![Vec::new(); r.channels as usize];
    while let Some(chunk) = r.next_chunk().unwrap() {
        for (a, c) in all.iter_mut().zip(chunk) {
            a.extend(c);
        }
    }
    (r.channels, r.rate, all)
}

#[test]
fn dsd_sources_convert_to_pcm_dsf_and_dop() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let dsf = d.0.join("tone.dsf");
    dsd::test_util::write_test_dsf(&dsf, 0.5, 2);
    let ff = get_ffmpeg_executable();
    let src = probe_source(&ff, &dsf).unwrap();
    assert!(dsd::is_dsd_codec(src.codec.as_deref()), "{:?}", src.codec);
    let out = d.0.join("out");

    // PCM: 24-bit integer FLAC at the decoder's rate, or capped.
    let (pcm, _) = convert_blocking(&ctx(), &request(&dsf, &out, "FLAC", "pcm")).unwrap();
    let info = probe_source(&ff, &pcm).unwrap();
    assert_eq!((info.sample_rate, info.bits_per_sample), (src.sample_rate, Some(24)));
    let mut capped = request(&dsf, &out, "FLAC", "pcm96");
    capped.settings.max_sample_rate = Some(96000);
    let (pcm96, _) = convert_blocking(&ctx(), &capped).unwrap();
    assert_eq!(probe_source(&ff, &pcm96).unwrap().sample_rate, Some(88200));

    // DSF -> DSF keeps every bit and the tags.
    let (copy, _) = convert_blocking(&ctx(), &request(&dsf, &out, "DSF", "copy")).unwrap();
    assert_eq!(dsd_bits(&copy), dsd_bits(&dsf));
    assert!(read_source_tags(&ff, &copy).unwrap().iter().any(|(k, v)| k == "title" && v == "DSD Test"));

    // DFF -> DSF too.
    let (ch, rate, bits) = dsd_bits(&dsf);
    let dff = d.0.join("tone.dff");
    dsd::test_util::write_test_dff(&dff, rate, &bits, 0);
    assert_eq!(dsd_bits(&dff), (ch, rate, bits.clone()));
    let (from_dff, _) = convert_blocking(&ctx(), &request(&dff, &out, "DSF", "fromdff")).unwrap();
    assert_eq!(dsd_bits(&from_dff).2, bits);

    // DoP: 24-bit PCM at 1/16 of the DSD rate carrying the same bits; verified as such.
    for format in ["FLAC", "WAV", "AIFF"] {
        let mut req = request(&dsf, &out, format, "dop");
        req.settings.dop = Some(true);
        let (dop, _) = convert_blocking(&ctx(), &req).unwrap_or_else(|e| panic!("{format}: {e}"));
        let info = probe_source(&ff, &dop).unwrap();
        assert_eq!(info.sample_rate, Some(176400), "{format}");
        assert_eq!(dsd::dop_matches(&dsf, &dop, &|| false).unwrap(), Some(true), "{format}");
        let r = crate::audio::audit::verify_quality_blocking(&dsf.to_string_lossy(), &dop.to_string_lossy(), true, &|| false).result.unwrap();
        assert_eq!(r.status, "perfect", "{format}");
    }
    assert_eq!(dsd::dop_matches(&dsf, &pcm, &|| false).unwrap(), None, "plain PCM is not DoP");
    // DoP of a longer recording with the same start is not a match (trailing audio).
    let longer = d.0.join("longer.dsf");
    dsd::test_util::write_test_dsf(&longer, 0.6, 2);
    let mut req = request(&longer, &out, "FLAC", "dop_long");
    req.settings.dop = Some(true);
    let (dop_long, _) = convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(dsd::dop_matches(&dsf, &dop_long, &|| false).unwrap(), Some(false));
    // An odd number of DSD bytes: the last byte is checked too.
    let (_, rate, mut odd) = dsd_bits(&dsf);
    for c in odd.iter_mut() {
        c.truncate(c.len() - 1 - (c.len() % 2));
    }
    let odd_dff = d.0.join("odd.dff");
    dsd::test_util::write_test_dff(&odd_dff, rate, &odd, 0);
    let mut req = request(&odd_dff, &out, "FLAC", "dop_odd");
    req.settings.dop = Some(true);
    let (dop_odd, _) = convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(dsd::dop_matches(&odd_dff, &dop_odd, &|| false).unwrap(), Some(true));
    assert_eq!(dsd::dop_matches(&dsf, &dop_odd, &|| false).unwrap(), Some(false), "the source has more bits");

    // PCM sources cannot become DSD.
    let wav = d.0.join("a.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.2", wav.to_str().unwrap()]);
    let err = convert_blocking(&ctx(), &request(&wav, &out, "DSF", "no")).unwrap_err();
    assert!(err.contains("DSD source"), "{err}");
}

#[test]
fn tempo_fade_and_padding() {
    assert_eq!(atempo_chain(23.976 / 25.0), ["atempo=0.959040000"]);
    assert_eq!(atempo_chain(5.0), ["atempo=2.0", "atempo=2.0", "atempo=1.250000000"]);
    assert!(atempo_chain(1.0).is_empty());
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("a.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2", "-c:a", "pcm_s16le", src.to_str().unwrap()]);
    let mut req = request(&src, &d.0.join("out"), "WAV", "fx");
    let st = &mut req.settings;
    st.same_as_source = Some(false);
    st.sample_rate = Some(48000);
    st.channels = Some(1);
    st.tempo_enabled = Some(true);
    st.tempo_from = Some(25.0);
    st.tempo_to = Some(23.976);
    st.fade_enabled = Some(true);
    st.fade_in_seconds = Some(0.5);
    st.fade_out_seconds = Some(0.5);
    st.pad_start_seconds = Some(0.25);
    st.pad_end_seconds = Some(0.5);
    let (out, _) = convert_blocking(&ctx(), &req).unwrap();
    let ff = get_ffmpeg_executable();
    let dur = probe_source(&ff, &out).unwrap().duration;
    let expected = 2.0 * 25.0 / 23.976 + 0.75;
    assert!((dur - expected).abs() < 0.02, "{dur} vs {expected}");
    // The first 0.25 s is silent and the faded start is quieter than the middle.
    let level = |start: f64, len: f64| {
        let o = hidden_command(&ff).args(["-ss", &start.to_string(), "-t", &len.to_string(), "-i"]).arg(&out).args(["-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
        parse_max_volume(&String::from_utf8_lossy(&o.stderr)).unwrap()
    };
    assert!(level(0.0, 0.2) < -80.0);
    assert!(level(0.26, 0.05) < level(1.2, 0.05) - 10.0, "fade in");
    assert!(level(expected - 0.45, 0.2) < -80.0, "padded end is silent");
    // In "same as source" none of this applies.
    req.settings.same_as_source = Some(true);
    let (keep, _) = convert_blocking(&ctx(), &req).unwrap();
    assert!((probe_source(&ff, &keep).unwrap().duration - 2.0).abs() < 0.01);
}

#[test]
fn split_by_silence_and_time_finds_the_parts() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("two.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=3", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2", "-f", "lavfi", "-i", "sine=duration=3",
        "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", src.to_str().unwrap()]);
    let req = |mode: &str| crate::audio::cue::SplitRequest {
        path: src.to_string_lossy().into_owned(), mode: mode.into(), seconds: Some(3.0), threshold_db: Some(-50.0),
        min_silence: Some(1.0), min_length: Some(1.0), preserve_pauses: Some(false),
    };
    let t = crate::audio::cue::split_tracks(&req("silence")).unwrap();
    assert_eq!(t.len(), 2, "{t:?}");
    assert!((t[0].end.unwrap() - 3.0).abs() < 0.05 && (t[1].start - 5.0).abs() < 0.05, "{t:?}");
    let t = crate::audio::cue::split_tracks(&req("time")).unwrap();
    assert_eq!(t.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(), [(0.0, Some(3.0)), (3.0, Some(6.0)), (6.0, None)]);
}

#[test]
fn channels_split_into_mono_files_and_join_back() {
    assert_eq!(layout_channel_names("5.1(side)", 6), ["FL", "FR", "FC", "LFE", "SL", "SR"]);
    assert_eq!(layout_channel_names("2 channels (FL+FC)", 2), ["FL", "FC"]);
    assert_eq!(layout_channel_names("weird", 3), ["c1", "c2", "c3"]);
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let six = d.0.join("six.wav");
    ffmpeg(&["-f", "lavfi", "-i", "aevalsrc=sin(300*2*PI*t)|sin(400*2*PI*t)|sin(500*2*PI*t)|0.1*sin(50*2*PI*t)|sin(600*2*PI*t)|sin(700*2*PI*t):s=48000:d=0.5",
        "-af", "aformat=channel_layouts=5.1", "-c:a", "pcm_s24le", six.to_str().unwrap()]);
    let ff = get_ffmpeg_executable();
    assert_eq!(probe_source(&ff, &six).unwrap().layout.as_deref(), Some("5.1"));
    let out = d.0.join("out");
    let mut monos = Vec::new();
    for c in 0..6u32 {
        let mut req = request(&six, &out, "FLAC", &format!("0{}_ch", c + 1));
        req.channel = Some(c);
        let (path, _) = convert_blocking(&ctx(), &req).unwrap();
        let info = probe_source(&ff, &path).unwrap();
        assert_eq!((info.channels, info.bits_per_sample), (Some(1), Some(24)));
        let r = crate::audio::audit::verify_quality_part(&six.to_string_lossy(), &path.to_string_lossy(), true, None, Some(c), &|| false).result.unwrap();
        assert_eq!(r.status, "perfect", "channel {c}");
        monos.push(path);
    }
    let mut req = request(&six, &out, "FLAC", "x");
    req.channel = Some(6);
    assert!(convert_blocking(&ctx(), &req).unwrap_err().contains("no channel 7"));

    let mut st = settings(true);
    st.local_save_path = Some(out.to_string_lossy().into_owned());
    let join = merge::MergeRequest {
        inputs: monos.iter().map(|p| merge::MergeInput { path: p.to_string_lossy().into_owned(), start_seconds: None, end_seconds: None, title: String::new(), artist: String::new() }).collect(),
        file_name: "joined".into(), output_format: "FLAC".into(), job_id: None, settings: st, tags: None, create_cue: Some(true), verify: Some(true), join_channels: true,
    };
    let m = merge::merge_blocking(&ctx(), &join).unwrap();
    assert!(m.cue.is_none());
    assert_eq!(m.verified.as_ref().map(|v| v.0), Some(true), "{:?}", m.verified);
    let info = probe_source(&ff, &m.converted.path).unwrap();
    assert_eq!((info.channels, info.layout.as_deref()), (Some(6), Some("5.1")));
    assert_eq!(compute_pcm_fingerprint(m.converted.path.to_str().unwrap()).unwrap(), compute_pcm_fingerprint(six.to_str().unwrap()).unwrap(), "joined = original");
}

#[test]
fn extract_and_copy_keep_the_stream() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let ff = get_ffmpeg_executable();
    let mkv = d.0.join("video.mkv");
    ffmpeg(&["-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.5", "-f", "lavfi", "-i", "sine=duration=0.5", "-c:v", "mjpeg", "-c:a", "libopus", mkv.to_str().unwrap()]);
    let out = d.0.join("out");
    let mut req = request(&mkv, &out, "FLAC", "audio");
    req.settings.action_mode = Some("extract".into());
    let (path, name) = convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(name, "audio.opus");
    let info = probe_source(&ff, &path).unwrap();
    assert_eq!(info.codec.as_deref(), Some("opus"));
    // Same packets; Matroska and Ogg trim Opus's start-up samples differently, so only
    // the length is compared here.
    assert!((info.duration - 0.5).abs() < 0.05, "{}", info.duration);

    let src = make_source(&d.0);
    let mut req = request(&src, &out, "MP3", "copied");
    req.settings.action_mode = Some("copy".into());
    let (copy, name) = convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(name, "copied.flac");
    assert_eq!(fs::read(&copy).unwrap(), fs::read(&src).unwrap(), "byte-identical copy");
    req.tags = Some(InputTags { title: Some("New".into()), ..Default::default() });
    let (tagged, _) = convert_blocking(&ctx(), &req).unwrap();
    assert!(read_source_tags(&ff, &tagged).unwrap().iter().any(|(k, v)| k == "title" && v == "New"));
    assert!(probe_source(&ff, &tagged).unwrap().has_art());
    assert_eq!(compute_pcm_fingerprint(tagged.to_str().unwrap()).unwrap(), compute_pcm_fingerprint(src.to_str().unwrap()).unwrap());
    // Tag edits reach Ogg / Opus (stream tags) for both copy and extract.
    let ogg = d.0.join("v.ogg");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "libvorbis", "-metadata:s:a:0", "title=Old", ogg.to_str().unwrap()]);
    for mode in ["copy", "extract"] {
        let mut req = request(&ogg, &out, "MP3", &format!("ogg_{mode}"));
        req.settings.action_mode = Some(mode.into());
        req.tags = Some(InputTags { title: Some("New".into()), track: Some("3/9".into()), ..Default::default() });
        let (p, _) = convert_blocking(&ctx(), &req).unwrap_or_else(|e| panic!("{mode}: {e}"));
        let tags = read_source_tags(&ff, &p).unwrap();
        assert!(tags.iter().any(|(k, v)| k == "title" && v == "New"), "{mode}: {tags:?}");
    }
    // DSD: extract writes DSF; copy with an edit writes the tag through lofty.
    let dsf = d.0.join("t.dsf");
    dsd::test_util::write_test_dsf(&dsf, 0.2, 2);
    let mut req = request(&dsf, &out, "FLAC", "dsd_x");
    req.settings.action_mode = Some("extract".into());
    let (p, name) = convert_blocking(&ctx(), &req).unwrap();
    assert_eq!(name, "dsd_x.dsf");
    assert_eq!(dsd_bits(&p), dsd_bits(&dsf));
    req.settings.action_mode = Some("copy".into());
    req.tags = Some(InputTags { title: Some("Edited".into()), ..Default::default() });
    let (p, _) = convert_blocking(&ctx(), &req).unwrap();
    assert!(read_source_tags(&ff, &p).unwrap().iter().any(|(k, v)| k == "title" && v == "Edited"));
    assert_eq!(dsd_bits(&p), dsd_bits(&dsf));
    assert_eq!(extract_container(Some("pcm_s24be")), "aiff");
    assert_eq!(extract_container(Some("something")), "mka");
}

#[test]
fn join_keeps_every_channel_for_any_count_and_length() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let ff = get_ffmpeg_executable();
    let tone = |name: &str, f: u32, dur: &str, ch: &str| {
        let p = d.0.join(name);
        ffmpeg(&["-f", "lavfi", "-i", &format!("sine=frequency={f}:sample_rate=48000:duration={dur}"), "-af", &format!("aformat=channel_layouts={ch}"), "-c:a", "pcm_s16le", p.to_str().unwrap()]);
        p
    };
    let out = d.0.join("out");
    let join = |inputs: Vec<PathBuf>, name: &str, explicit: bool| {
        let mut st = settings(!explicit);
        st.local_save_path = Some(out.to_string_lossy().into_owned());
        st.channels = Some(2);
        st.sample_rate = Some(48000);
        st.bit_depth = Some("16".into());
        let req = merge::MergeRequest {
            inputs: inputs.iter().map(|p| merge::MergeInput { path: p.to_string_lossy().into_owned(), start_seconds: None, end_seconds: None, title: String::new(), artist: String::new() }).collect(),
            file_name: name.into(), output_format: "FLAC".into(), job_id: None, settings: st, tags: None, create_cue: None, verify: Some(true), join_channels: true,
        };
        merge::merge_blocking(&ctx(), &req).unwrap()
    };
    let a = tone("a.wav", 300, "0.5", "mono");
    let b = tone("b.wav", 400, "0.5", "mono");
    let c = tone("c.wav", 500, "0.5", "mono");
    let e = tone("e.wav", 600, "0.5", "mono");
    for (inputs, total) in [(vec![a.clone(), b.clone(), c.clone()], 3), (vec![a.clone(), b.clone(), c.clone(), e.clone()], 4)] {
        let m = join(inputs.clone(), &format!("j{total}"), false);
        assert_eq!(m.verified.as_ref().map(|v| v.0), Some(true), "{total}: {:?}", m.verified);
        assert_eq!(probe_source(&ff, &m.converted.path).unwrap().channels, Some(total));
    }
    // Mono + stereo keeps the input order; an explicit 2-channel setting does not downmix.
    let st = tone("st.wav", 700, "0.5", "stereo");
    let m = join(vec![a.clone(), st], "ms", true);
    assert_eq!(probe_source(&ff, &m.converted.path).unwrap().channels, Some(3));
    // A longer input is not cut.
    let long = tone("long.wav", 800, "1.0049", "mono");
    let m = join(vec![a.clone(), long.clone()], "len", false);
    let (_, bytes) = compute_pcm_fingerprint(m.converted.path.to_str().unwrap()).unwrap();
    let (_, long_bytes) = compute_pcm_fingerprint(long.to_str().unwrap()).unwrap();
    assert_eq!(bytes, long_bytes * 2, "every sample of the longest input");
}

#[test]
fn hi_res_source_to_mp3_and_opus_succeeds() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = make_source(&d.0);
    for format in ["MP3", "OPUS", "M4A"] {
        convert_blocking(&ctx(), &request(&src, &d.0.join("out"), format, "x")).unwrap_or_else(|e| panic!("{format}: {e}"));
    }
}

#[test]
fn vbr_maps_lame_quality_to_each_encoder() {
    let mut st = settings(true);
    assert!(vbr_args(OutFormat::Mp3, &st, false).is_none(), "CBR unless asked");
    st.bitrate_mode = Some("vbr".into());
    assert_eq!(vbr_args(OutFormat::Mp3, &st, false).unwrap(), ("libmp3lame", vec!["-q:a".to_string(), "2.0".to_string()]));
    assert_eq!(vbr_args(OutFormat::M4a, &st, true).unwrap().1, ["-aac_at_mode", "vbr", "-q:a", "4"], "V2 = TVBR 91");
    assert_eq!(vbr_args(OutFormat::M4a, &st, false).unwrap(), ("aac", vec!["-q:a".to_string(), "1.62".to_string()]));
    assert_eq!(vbr_args(OutFormat::Ogg, &st, false).unwrap().1, ["-q:a", "8.0"]);
    assert!(vbr_args(OutFormat::Opus, &st, false).is_none());
    st.vbr_quality = Some(99.0);
    assert_eq!(vbr_args(OutFormat::M4a, &st, true).unwrap().1[3], "14");
}

#[test]
fn vbr_encodes_hi_res_and_multichannel_sources() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let stereo = make_source(&d.0);
    let surround = d.0.join("51.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=0.5", "-af", "aformat=channel_layouts=5.1", "-c:a", "pcm_s24le", surround.to_str().unwrap()]);
    let ff = get_ffmpeg_executable();
    for src in [&stereo, &surround] {
        for format in ["MP3", "M4A", "OGG"] {
            let mut req = request(src, &d.0.join("out"), format, "vbr");
            req.settings.bitrate_mode = Some("vbr".into());
            let (path, _) = convert_blocking(&ctx(), &req).unwrap_or_else(|e| panic!("{format} {}: {e}", src.display()));
            let info = probe_source(&ff, &path).unwrap();
            assert!(info.duration > 0.4, "{format}");
            if format == "M4A" && aac_at_available() {
                assert!(info.sample_rate.unwrap() <= 48000, "AudioToolbox AAC is capped at 48 kHz");
            }
        }
    }
}

#[test]
fn float_wav_to_flac_is_refused_in_keep_mode_and_nothing_is_left_behind() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("float.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.2", "-c:a", "pcm_f32le", src.to_str().unwrap()]);
    let out = d.0.join("out");
    let err = convert_blocking(&ctx(), &request(&src, &out, "FLAC", "x")).unwrap_err();
    assert!(err.contains("cannot store"), "{err}");
    let (path, _) = convert_blocking(&ctx(), &request(&src, &out, "WAV", "x")).unwrap();
    let info = probe_source(&get_ffmpeg_executable(), &path).unwrap();
    assert!(info.is_float);
    assert_eq!(fs::read_dir(&out).unwrap().count(), 1);
}

#[test]
fn normalization_reaches_the_target_peak() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("quiet.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.5", "-af", "volume=-20dB", "-c:a", "pcm_s16le", src.to_str().unwrap()]);
    let mut req = request(&src, &d.0.join("out"), "WAV", "n");
    req.settings.same_as_source = Some(false);
    req.settings.normalize = Some(true);
    req.settings.normalization_target_db = Some(-1.0);
    let done = convert_blocking_ex(&ctx(), &req).unwrap();
    // The gain is measured after the pre-gain filters (channel conversion etc.).
    let gain = done.gain_db.expect("applied gain is reported");
    assert!(gain > 30.0 && gain < 45.0, "gain {gain}");
    let path = done.path;
    let out = hidden_command(&get_ffmpeg_executable())
        .args(["-nostdin", "-hide_banner", "-i", path.to_str().unwrap(), "-af", "volumedetect", "-f", "null", "-"])
        .output()
        .unwrap();
    let peak = parse_max_volume(&String::from_utf8_lossy(&out.stderr)).unwrap();
    assert!((peak + 1.0).abs() < 0.3, "peak {peak}");
}

#[test]
fn cancelled_job_publishes_nothing() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = make_source(&d.0);
    let jobs: ActiveJobs = Arc::new(Mutex::new(HashMap::new())); // job never started = cancelled
    let c = JobCtx { app: None, jobs, job_id: Some("j".into()) };
    let out = d.0.join("out");
    let err = convert_blocking(&c, &request(&src, &out, "FLAC", "x")).unwrap_err();
    assert!(err.contains("cancelled"), "{err}");
    assert!(fs::read_dir(&out).map(|r| r.count()).unwrap_or(0) == 0);
}

#[test]
fn tags_survive_between_containers() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let out = d.0.join("out");
    let read = |p: &Path| read_source_tags(&get_ffmpeg_executable(), p).unwrap();
    let get = |t: &TagMap, k: &str| t.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());

    // Opus (Ogg) keeps tags in the stream; they must reach a FLAC output.
    let opus = d.0.join("src.opus");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "libopus", "-metadata", "title=OpusT", "-metadata", "artist=OpusA", opus.to_str().unwrap()]);
    let (flac, _) = convert_blocking(&ctx(), &request(&opus, &out, "FLAC", "from-opus")).unwrap();
    let t = read(&flac);
    assert_eq!(get(&t, "title").as_deref(), Some("OpusT"));
    assert_eq!(get(&t, "artist").as_deref(), Some("OpusA"));

    // Edits reach an Ogg-family output.
    let mut req = request(&flac, &out, "OPUS", "edited");
    req.tags = Some(InputTags { title: Some("NewT".into()), ..Default::default() });
    let (opus2, _) = convert_blocking(&ctx(), &req).unwrap();
    let t = read(&opus2);
    assert_eq!(get(&t, "title").as_deref(), Some("NewT"));
    assert_eq!(get(&t, "artist").as_deref(), Some("OpusA"));

    // WavPack gets standard APEv2 names that tag readers understand.
    let src = d.0.join("tagged.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "flac", "-metadata", "album_artist=AA", "-metadata", "date=1999", "-metadata", "track=3/12", src.to_str().unwrap()]);
    let (wv, _) = convert_blocking(&ctx(), &request(&src, &out, "WAVPACK", "wv")).unwrap();
    let tagged = lofty::probe::Probe::open(&wv).unwrap().read().unwrap();
    let tag = lofty::file::TaggedFileExt::first_tag(&tagged).expect("APE tag");
    use lofty::tag::Accessor;
    assert_eq!(tag.get_string(&lofty::tag::ItemKey::AlbumArtist), Some("AA"));
    assert_eq!(tag.year(), Some(1999));

    // WAV keeps the track total.
    let (wav, _) = convert_blocking(&ctx(), &request(&src, &out, "WAV", "wav")).unwrap();
    let tagged = lofty::probe::Probe::open(&wav).unwrap().read().unwrap();
    let tag = lofty::file::TaggedFileExt::primary_tag(&tagged).or_else(|| lofty::file::TaggedFileExt::first_tag(&tagged)).expect("ID3 tag");
    assert_eq!((tag.track(), tag.track_total()), (Some(3), Some(12)));
    assert_eq!(tag.get_string(&lofty::tag::ItemKey::AlbumArtist), Some("AA"));
}

#[test]
fn awkward_sources_convert_to_every_lossy_format() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let out = d.0.join("out");
    let hi = make_source(&d.0); // 96 kHz stereo 24-bit
    let mono = d.0.join("mono.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-ac", "1", "-c:a", "pcm_s16le", mono.to_str().unwrap()]);
    let six = d.0.join("six.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-ac", "6", "-c:a", "pcm_s16le", six.to_str().unwrap()]);
    let has = |name: &str| {
        hidden_command(&get_ffmpeg_executable()).args(["-hide_banner", "-encoders"]).output().map(|o| String::from_utf8_lossy(&o.stdout).contains(name)).unwrap_or(false)
    };
    for src in [&hi, &mono, &six] {
        for format in ["MP3", "M4A", "OGG", "OPUS", "AC3", "WMA"] {
            if format == "OGG" && !has("libvorbis") {
                continue;
            }
            let mut req = request(src, &out, format, "x");
            req.settings.bitrate = Some("320".into());
            convert_blocking(&ctx(), &req).unwrap_or_else(|e| panic!("{} -> {format}: {e}", src.display()));
        }
    }
}

#[test]
fn eight_bit_wav_to_flac_is_bit_exact() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("u8.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-c:a", "pcm_u8", src.to_str().unwrap()]);
    let (flac, _) = convert_blocking(&ctx(), &request(&src, &d.0.join("out"), "FLAC", "x")).unwrap();
    assert_eq!(compute_pcm_fingerprint(src.to_str().unwrap()).unwrap().0, compute_pcm_fingerprint(flac.to_str().unwrap()).unwrap().0);
}

#[test]
fn cancelling_a_running_conversion_stops_it_quickly() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("long.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=180:sample_rate=192000", "-ac", "2", "-c:a", "pcm_s24le", src.to_str().unwrap()]);
    let jobs: ActiveJobs = Arc::new(Mutex::new(HashMap::new()));
    jobs.lock().unwrap().insert("j".into(), 0);
    let c = JobCtx { app: None, jobs: jobs.clone(), job_id: Some("j".into()) };
    let out = d.0.join("out");
    let mut req = request(&src, &out, "FLAC", "x");
    req.settings.thread_pool_size = Some(1);
    let started = std::time::Instant::now();
    let handle = std::thread::spawn(move || convert_blocking(&c, &req));
    std::thread::sleep(std::time::Duration::from_millis(400));
    jobs.lock().unwrap().remove("j");
    let err = handle.join().unwrap().unwrap_err();
    assert!(err.contains("cancelled"), "{err}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
    assert_eq!(fs::read_dir(&out).map(|r| r.count()).unwrap_or(0), 0, "nothing published");
}

#[test]
fn round3_unit_regressions() {
    // File names: truncation happens before the empty / reserved checks.
    assert_eq!(safe_file_name(&format!("{}a", " ".repeat(180))), "audio");
    assert_eq!(safe_file_name(&format!("CON{}a", " ".repeat(177))), "_CON");
    assert_eq!(safe_file_name("COM1 .txt"), "_COM1 .txt");
    // Tag keys from APEv2 / Vorbis are normalized and totals folded.
    let t = normalize_tags(tm(&[("album artist", "AA"), ("year", "2025"), ("track", "3"), ("tracktotal", "12"), ("disc", "1"), ("totaldiscs", "2")]));
    assert_eq!(t, tm(&[("album_artist", "AA"), ("date", "2025"), ("track", "3/12"), ("disc", "1/2")]));
    // 64-bit integer cannot go to AIFF.
    let s64 = src(64, 48000, 2, true, false);
    assert!(build_encode_args(OutFormat::Aiff, Path::new("i"), Path::new("o"), &settings(true), &s64, &no_tags(), None).is_err());
    // Unchanged channel count: no -ac (keeps 3.0 / quad layouts intact).
    let quad = src(16, 48000, 4, true, false);
    let flac = build_encode_args(OutFormat::Flac, Path::new("i"), Path::new("o"), &settings(true), &quad, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&flac.args, "-ac"), None);
    let opus = build_encode_args(OutFormat::Opus, Path::new("i"), Path::new("o"), &settings(true), &quad, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&opus.args, "-af"), Some("aformat=channel_layouts=quad"));
    // FLAC/Vorbis outputs get separate totals.
    let tags = tm(&[("track", "3/12")]);
    let flac = build_encode_args(OutFormat::Flac, Path::new("i"), Path::new("o"), &settings(true), &src(16, 44100, 2, true, false), &tags, None).unwrap();
    let meta: Vec<&str> = flac.args.windows(2).filter(|w| w[0] == "-metadata").map(|w| w[1].as_str()).collect();
    assert_eq!(meta, ["track=3", "tracktotal=12"]);
}

#[test]
fn multichannel_layouts_and_tag_names_survive_real_conversions() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let out = d.0.join("out");
    let read = |p: &Path| read_source_tags(&get_ffmpeg_executable(), p).unwrap();
    let get = |t: &TagMap, k: &str| t.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());

    for layout in ["3.0", "quad", "2.1"] {
        let src = d.0.join(format!("{layout}.wav"));
        ffmpeg(&["-f", "lavfi", "-i", &format!("aevalsrc=sin(440*2*PI*t)|sin(550*2*PI*t)|sin(660*2*PI*t)|sin(770*2*PI*t):d=0.3:channel_layout=quad"), "-af", &format!("aformat=channel_layouts={layout}"), "-c:a", "pcm_s16le", src.to_str().unwrap()]);
        let (flac, _) = convert_blocking(&ctx(), &request(&src, &out, "FLAC", layout)).unwrap_or_else(|e| panic!("{layout} FLAC: {e}"));
        assert_eq!(compute_pcm_fingerprint(src.to_str().unwrap()).unwrap().0, compute_pcm_fingerprint(flac.to_str().unwrap()).unwrap().0, "{layout} must stay bit-exact");
        convert_blocking(&ctx(), &request(&src, &out, "OPUS", layout)).unwrap_or_else(|e| panic!("{layout} OPUS: {e}"));
    }

    // FLAC with Vorbis TRACKTOTAL -> WavPack -> M4A keeps album artist, year and totals.
    let flac = d.0.join("vorbis.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.2", "-metadata", "album_artist=AA", "-metadata", "date=2025", "-metadata", "track=3", "-metadata", "tracktotal=12", flac.to_str().unwrap()]);
    let (wv, _) = convert_blocking(&ctx(), &request(&flac, &out, "WAVPACK", "chain")).unwrap();
    let (m4a, _) = convert_blocking(&ctx(), &request(&wv, &out, "M4A", "chain")).unwrap();
    let t = read(&m4a);
    assert_eq!(get(&t, "album_artist").as_deref(), Some("AA"));
    assert_eq!(get(&t, "date").as_deref(), Some("2025"));
    assert_eq!(get(&t, "track").as_deref(), Some("3/12"));
    let (wav, _) = convert_blocking(&ctx(), &request(&flac, &out, "WAV", "totals")).unwrap();
    assert_eq!(get(&read(&wav), "track").as_deref(), Some("3/12"));
    let (flac2, _) = convert_blocking(&ctx(), &request(&m4a, &out, "FLAC", "back")).unwrap();
    let tagged = lofty::probe::Probe::open(&flac2).unwrap().read().unwrap();
    let tag = lofty::file::TaggedFileExt::primary_tag(&tagged).unwrap();
    use lofty::tag::Accessor;
    assert_eq!((tag.track(), tag.track_total()), (Some(3), Some(12)));
}

#[test]
fn explicit_channel_changes_use_standard_layouts() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let out = d.0.join("out");
    let stereo = d.0.join("stereo.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-ac", "2", "-c:a", "pcm_s16le", stereo.to_str().unwrap()]);
    let odd = d.0.join("flfc.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3", "-af", "pan=FL+FC|c0=c0|c1=c0", "-c:a", "pcm_s16le", odd.to_str().unwrap()]);
    for ch in [3u32, 4] {
        for format in ["OPUS", "FLAC"] {
            let mut req = request(&stereo, &out, format, &format!("ch{ch}"));
            req.settings.same_as_source = Some(false);
            req.settings.channels = Some(ch);
            req.settings.bit_depth = Some("16".into());
            let (path, _) = convert_blocking(&ctx(), &req).unwrap_or_else(|e| panic!("{ch}ch {format}: {e}"));
            assert_eq!(probe_source(&get_ffmpeg_executable(), &path).unwrap().channels, Some(ch));
        }
    }
    for format in ["MP3", "M4A", "OPUS", "AC3"] {
        convert_blocking(&ctx(), &request(&odd, &out, format, "odd")).unwrap_or_else(|e| panic!("FL+FC -> {format}: {e}"));
    }
}

#[test]
fn safe_file_name_is_idempotent_at_the_limit() {
    let name = format!("CON.{}a", " ".repeat(175));
    let once = safe_file_name(&name);
    assert_eq!(safe_file_name(&once), once);
    assert!(once.chars().count() <= STEM_LIMIT_CHARS);
}

#[test]
fn verbatim_windows_paths_are_simplified() {
    assert_eq!(simplify_verbatim_path(PathBuf::from(r"\\?\C:\Music\a.flac")), PathBuf::from(r"C:\Music\a.flac"));
    assert_eq!(simplify_verbatim_path(PathBuf::from(r"\\?\UNC\nas\share\a.flac")), PathBuf::from(r"\\nas\share\a.flac"));
    assert_eq!(simplify_verbatim_path(PathBuf::from("/Users/a/b.flac")), PathBuf::from("/Users/a/b.flac"));
}

#[test]
fn sample_rate_cap_prefers_whole_ratios() {
    assert_eq!(cap_rate(192000, 96000), 96000);
    assert_eq!(cap_rate(176400, 96000), 88200);
    assert_eq!(cap_rate(352800, 96000), 88200);
    assert_eq!(cap_rate(44100, 96000), 44100);
    assert_eq!(cap_rate(96000, 0), 96000);
    assert_eq!(cap_rate(96000, 50000), 48000);
    let mut st = settings(true);
    st.max_sample_rate = Some(96000);
    st.flac_compression_level = Some(0);
    let hi = src(24, 192000, 2, true, false);
    let plan = build_encode_args(OutFormat::Flac, Path::new("i"), Path::new("o"), &st, &hi, &no_tags(), None).unwrap();
    assert_eq!(arg_after(&plan.args, "-ar"), Some("96000"));
    assert!(arg_after(&plan.args, "-af").unwrap().starts_with("aresample=96000"));
    assert_eq!(arg_after(&plan.args, "-compression_level"), Some("0"));
    assert_eq!(arg_after(&plan.args, "-bits_per_raw_sample"), Some("24"));
}

#[test]
fn max_rate_and_existing_file_policies_work_end_to_end() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("hires.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=0.3:sample_rate=192000", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", src.to_str().unwrap()]);
    let out = d.0.join("out");

    // Same-as-source + 96 kHz limit: 24-bit / 96 kHz ALAC.
    let mut req = request(&src, &out, "ALAC", "capped");
    req.settings.max_sample_rate = Some(96000);
    let (path, _) = convert_blocking(&ctx(), &req).unwrap();
    let info = probe_source(&get_ffmpeg_executable(), &path).unwrap();
    assert_eq!((info.sample_rate, info.bits_per_sample), (Some(96000), Some(24)));

    // Skip: nothing is encoded, the existing file is reported.
    let before = fs::read(&path).unwrap();
    let mut req = request(&src, &out, "ALAC", "capped");
    req.settings.on_existing = Some("skip".into());
    let done = convert_blocking_ex(&ctx(), &req).unwrap();
    assert!(done.skipped);
    assert_eq!(done.path, path);
    assert_eq!(fs::read(&path).unwrap(), before);

    // Overwrite: same name, new content (no limit -> 192 kHz).
    let mut req = request(&src, &out, "ALAC", "capped");
    req.settings.on_existing = Some("overwrite".into());
    let done = convert_blocking_ex(&ctx(), &req).unwrap();
    assert_eq!(done.path, path);
    assert_eq!(probe_source(&get_ffmpeg_executable(), &path).unwrap().sample_rate, Some(192000));
    assert_eq!(fs::read_dir(&out).unwrap().count(), 1);

    // Overwrite never replaces the source itself.
    let mut req = request(&src, &d.0, "FLAC", "hires");
    req.settings.on_existing = Some("overwrite".into());
    let source_before = fs::read(&src).unwrap();
    let done = convert_blocking_ex(&ctx(), &req).unwrap();
    assert_eq!(done.name, "hires_2.flac");
    assert_eq!(fs::read(&src).unwrap(), source_before);
    let src_canon = fs::canonicalize(&src).unwrap();
    assert_eq!(done.replaces.as_deref().map(fs::canonicalize).map(Result::unwrap), Some(src_canon));
    // While the source is still there, it cannot be replaced.
    assert!(move_into_place(&done.path, &src).is_err());
    assert!(done.path.is_file());
    // After the source went away (trash), the output takes its name.
    fs::remove_file(&src).unwrap();
    move_into_place(&done.path, &src).unwrap();
    assert!(src.is_file() && !done.path.exists());

    // Skip does not count the source itself as an existing output.
    let mut req = request(&src, &d.0, "FLAC", "hires");
    req.settings.on_existing = Some("skip".into());
    let done = convert_blocking_ex(&ctx(), &req).unwrap();
    assert!(!done.skipped);
    assert_eq!(done.name, "hires_2.flac");
    assert!(done.replaces.is_none());

    // A folder with the planned name is skipped over, not an error.
    fs::create_dir(d.0.join("folder.flac")).unwrap();
    let mut req = request(&src, &d.0, "FLAC", "folder");
    req.settings.on_existing = Some("overwrite".into());
    let done = convert_blocking_ex(&ctx(), &req).unwrap();
    assert_eq!(done.name, "folder_2.flac");
}

#[test]
fn verification_compares_resampled_output_at_its_own_rate() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("hires.flac");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=1000:duration=1:sample_rate=192000", "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", src.to_str().unwrap()]);
    let mut req = request(&src, &d.0.join("out"), "FLAC", "capped");
    req.settings.max_sample_rate = Some(96000);
    let (out, _) = convert_blocking(&ctx(), &req).unwrap();
    let res = crate::audio::audit::verify_quality_blocking(&src.to_string_lossy(), &out.to_string_lossy(), false, &|| false);
    let r = res.result.expect("verification result");
    assert!(r.correlation_percent.unwrap_or(0.0) > 99.0, "correlation {:?} status {}", r.correlation_percent, r.status);
    assert_ne!(r.status, "degraded");
}

#[test]
fn verification_sees_24_bit_and_multichannel_differences() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    // 24-bit source, 16-bit output: the old 16-bit comparison reported 100 dB.
    let src = d.0.join("quiet24.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=1000:duration=0.5:sample_rate=48000", "-af", "volume=-60dB", "-c:a", "pcm_s24le", src.to_str().unwrap()]);
    let mut req = request(&src, &d.0.join("out"), "WAV", "16bit");
    req.settings.same_as_source = Some(false);
    req.settings.bit_depth = Some("16".into());
    req.settings.sample_rate = Some(48000);
    let (out, _) = convert_blocking(&ctx(), &req).unwrap();
    let r = crate::audio::audit::verify_quality_blocking(&src.to_string_lossy(), &out.to_string_lossy(), false, &|| false).result.unwrap();
    assert!(r.snr_db.unwrap() < 60.0, "16-bit rounding of a -60 dB signal must show: {:?}", r.snr_db);

    // One silent channel of six in the output is a real difference.
    let six = d.0.join("six.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=500:duration=0.5", "-af", "aformat=channel_layouts=5.1", "-c:a", "pcm_s16le", six.to_str().unwrap()]);
    let broken = d.0.join("broken.wav");
    ffmpeg(&["-i", six.to_str().unwrap(), "-af", "pan=5.1|FL=FL|FR=FR|FC=FC|LFE=LFE|BL=BL|BR=0*BR", "-c:a", "pcm_s16le", broken.to_str().unwrap()]);
    let r = crate::audio::audit::verify_quality_blocking(&six.to_string_lossy(), &broken.to_string_lossy(), false, &|| false).result.unwrap();
    assert_ne!(r.status, "passed", "a lost channel must not pass (correlation {:?})", r.correlation_percent);

    // 5.1 to stereo MP3 is compared against the downmixed source.
    let (mp3, _) = convert_blocking(&ctx(), &request(&six, &d.0.join("out"), "MP3", "down")).unwrap();
    let r = crate::audio::audit::verify_quality_blocking(&six.to_string_lossy(), &mp3.to_string_lossy(), false, &|| false).result.unwrap();
    assert!(r.correlation_percent.unwrap() > 95.0, "{:?}", r.correlation_percent);
}

#[test]
fn a_cut_off_output_does_not_pass_verification() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let src = d.0.join("long.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=duration=5", src.to_str().unwrap()]);
    let cut = d.0.join("cut.mp3");
    ffmpeg(&["-i", src.to_str().unwrap(), "-t", "1", cut.to_str().unwrap()]);
    let r = crate::audio::audit::verify_quality_blocking(&src.to_string_lossy(), &cut.to_string_lossy(), false, &|| false).result.unwrap();
    assert_eq!(r.status, "degraded", "{}", r.summary_message);
    let full = d.0.join("full.mp3");
    ffmpeg(&["-i", src.to_str().unwrap(), full.to_str().unwrap()]);
    let r = crate::audio::audit::verify_quality_blocking(&src.to_string_lossy(), &full.to_string_lossy(), false, &|| false).result.unwrap();
    assert_ne!(r.status, "degraded", "a complete output is not flagged for its length: {}", r.summary_message);
}

#[test]
fn uncompressed_flac_is_verbatim_bit_exact_and_keeps_tags_and_cover() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let ff = get_ffmpeg_executable();
    // 24-bit stereo with a cover, and an odd-length 16-bit mono file (short last frame).
    let hi = make_source(&d.0);
    let mono = d.0.join("mono.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=300:sample_rate=44100:duration=0.3", "-af", "atrim=end_sample=10001", "-c:a", "pcm_s16le", mono.to_str().unwrap()]);

    for (src, bits, channels, frames) in [(&hi, 24u32, 2u32, 96000u64), (&mono, 16, 1, 10001)] {
        let mut req = request(src, &d.0.join("out"), "FLAC", "plain");
        req.settings.flac_uncompressed = Some(true);
        req.tags = Some(InputTags { artist: Some("Artist".into()), ..Default::default() });
        let done = convert_blocking_ex(&ctx(), &req).unwrap();
        let path = done.path;

        assert!(flac_verbatim::first_frame_is_verbatim(&path).unwrap(), "{bits} bit: subframes must be VERBATIM");
        let raw = frames * channels as u64 * bits as u64 / 8;
        let size = fs::metadata(&path).unwrap().len();
        assert!(size >= raw, "{bits} bit: {size} bytes is smaller than the raw audio ({raw})");
        assert_eq!(
            compute_pcm_fingerprint(path.to_str().unwrap()).unwrap().0,
            compute_pcm_fingerprint(src.to_str().unwrap()).unwrap().0,
            "{bits} bit: audio must be bit-exact"
        );
        // FFmpeg verifies every frame CRC and the MD5 of the decoded audio.
        let st = hidden_command(&ff)
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-err_detect", "crccheck+bitstream+explode", "-i"])
            .arg(&path)
            .args(["-f", "null", "-"])
            .output()
            .unwrap();
        assert!(st.status.success() && st.stderr.is_empty(), "{bits} bit: decode errors: {}", String::from_utf8_lossy(&st.stderr));
        let info = probe_source(&ff, &path).unwrap();
        assert_eq!((info.channels, info.bits_per_sample), (Some(channels), Some(bits)));
        let tags = read_source_tags(&ff, &path).unwrap();
        assert!(tags.iter().any(|(k, v)| k == "artist" && v == "Artist"), "tags must be kept: {tags:?}");
        if channels == 2 {
            assert!(info.has_art(), "cover must be kept");
        }
        fs::remove_dir_all(d.0.join("out")).unwrap();
    }
}

#[test]
fn verification_and_preview_decoding_stop_when_cancelled() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let long = d.0.join("long.flac");
    ffmpeg(&["-f", "lavfi", "-i", "anoisesrc=d=600:r=96000", "-c:a", "flac", "-compression_level", "0", long.to_str().unwrap()]);
    let path = long.to_string_lossy().into_owned();

    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    let is_cancelled = || cancel.load(std::sync::atomic::Ordering::SeqCst);
    let res = crate::audio::audit::verify_quality_blocking(&path, &path, true, &is_cancelled);
    assert_eq!(res.error.as_deref(), Some(crate::audio::audit::CANCELLED), "{:?}", res.result.map(|r| r.status));
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());

    let started = std::time::Instant::now();
    let err = crate::audio::audit::decode_to_temp_wav(&path, None, &|| started.elapsed() > std::time::Duration::from_millis(100)).unwrap_err();
    assert_eq!(err.to_string(), crate::audio::audit::CANCELLED);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn uncompressed_flac_writes_uncommon_rates_into_the_frame_header() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    for rate in [11025u32, 352800, 12000] {
        let src = d.0.join(format!("r{rate}.wav"));
        ffmpeg(&["-f", "lavfi", "-i", &format!("sine=frequency=500:sample_rate={rate}:duration=0.2"), "-c:a", "pcm_s24le", src.to_str().unwrap()]);
        let mut req = request(&src, &d.0.join("out"), "FLAC", &format!("r{rate}"));
        req.settings.flac_uncompressed = Some(true);
        let path = convert_blocking_ex(&ctx(), &req).unwrap().path;
        let bytes = fs::read(&path).unwrap();
        let audio = {
            let mut pos = 4;
            loop {
                let last = bytes[pos] & 0x80 != 0;
                pos += 4 + u32::from_be_bytes([0, bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]]) as usize;
                if last {
                    break pos;
                }
            }
        };
        assert_ne!(bytes[audio + 2] & 0x0f, 0, "{rate}: frame header must carry the rate");
        assert!(flac_verbatim::first_frame_is_verbatim(&path).unwrap(), "{rate}");
        assert_eq!(probe_source(&get_ffmpeg_executable(), &path).unwrap().sample_rate, Some(rate));
        assert_eq!(
            compute_pcm_fingerprint(path.to_str().unwrap()).unwrap().0,
            compute_pcm_fingerprint(src.to_str().unwrap()).unwrap().0,
            "{rate}: bit-exact"
        );
    }
}

#[test]
fn multichannel_hi_res_flac_uses_small_blocks_and_reads_back() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    // 6 channels of noise at 352.8 kHz: FFmpeg's default 32768-sample blocks give frames
    // its own FLAC reader drops, so the output would decode to nothing.
    let src = d.0.join("dxd51.wav");
    let ex = (0..6).map(|i| format!("0.5*sin(2*PI*{}*t)+0.3*(2*random({i})-1)", 440 + i * 100)).collect::<Vec<_>>().join("|");
    ffmpeg(&["-f", "lavfi", "-i", &format!("aevalsrc=exprs={ex}:s=352800:d=0.5"), "-c:a", "pcm_s24le", src.to_str().unwrap()]);
    for uncompressed in [false, true] {
        let mut req = request(&src, &d.0.join("out"), "FLAC", &format!("u{uncompressed}"));
        req.settings.flac_uncompressed = Some(uncompressed);
        let path = convert_blocking_ex(&ctx(), &req).unwrap().path;
        let bytes = fs::read(&path).unwrap();
        assert_eq!(u16::from_be_bytes([bytes[10], bytes[11]]), 4096, "max block size");
        assert_eq!(
            compute_pcm_fingerprint(path.to_str().unwrap()).unwrap().0,
            compute_pcm_fingerprint(src.to_str().unwrap()).unwrap().0,
            "uncompressed={uncompressed}: bit-exact"
        );
    }
}

#[test]
fn sources_without_decodable_audio_fail_and_publish_nothing() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    // A WAV header with zero samples: readable metadata, no audio.
    let src = d.0.join("zero.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=sample_rate=44100", "-frames:a", "0", "-c:a", "pcm_s24le", src.to_str().unwrap()]);
    let out = d.0.join("out");
    for format in ["FLAC", "MP3", "WAV", "OGG", "OPUS", "M4A", "ALAC", "AIFF", "WAVPACK", "WMA", "AC3"] {
        let err = convert_blocking(&ctx(), &request(&src, &out, format, "z")).unwrap_err();
        assert!(err.contains("No audio") || err.contains("empty file"), "{format}: {err}");
    }
    assert!(!out.exists() || fs::read_dir(&out).unwrap().next().is_none(), "nothing published");
    // A 20 ms file is short (the probe reports under 0.05 s) but has audio.
    let tiny = d.0.join("tiny.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=sample_rate=48000", "-af", "atrim=end_sample=960", "-c:a", "pcm_s16le", tiny.to_str().unwrap()]);
    assert!(probe_source(&get_ffmpeg_executable(), &tiny).unwrap().duration < 0.05);
    for format in ["FLAC", "MP3", "WAV"] {
        convert_blocking(&ctx(), &request(&tiny, &out, format, "t")).unwrap();
    }
}

#[test]
fn preview_plan_keeps_previews_small() {
    // Short files: stereo, high rates reduced to 44.1/48 kHz.
    assert_eq!(preview_plan(Some(44_100), 300.0).0, None);
    assert_eq!(preview_plan(Some(44_100), 300.0).1, 2);
    assert_eq!(preview_plan(Some(352_800), 300.0).0, Some(44_100));
    assert_eq!(preview_plan(Some(96_000), 300.0).0, Some(48_000));
    // Unknown duration: mono, and the length limit still applies.
    let (_, ch, limit) = preview_plan(Some(48_000), 0.0);
    assert_eq!(ch, 1);
    assert!(limit * 48_000.0 <= PREVIEW_BUDGET * 1.001);
    for rate in [4_000u32, 8_000, 11_025, 22_050, 44_100, 48_000, 88_200, 96_000, 192_000, 384_000] {
        for secs in [0.0, 1.0, 600.0, 1500.0, 3000.0, 7200.0, 36_000.0, 90_000.0] {
            let (r, ch, limit) = preview_plan(Some(rate), secs);
            let r = r.unwrap_or(rate);
            // Whatever the real length, the limit keeps the preview within the budget.
            assert!(limit * f64::from(r) * f64::from(ch) <= PREVIEW_BUDGET * 1.001, "{rate} {secs}");
            assert!(r <= rate.max(1).min(48_000).max(rate.min(48_000)), "{rate} {secs}: never above the source");
            assert!(r <= rate, "{rate} {secs}: {r} is above the source rate");
        }
    }
    // A long 8 kHz recording keeps its rate (no upsampling) and is cut at the budget.
    let (r, ch, limit) = preview_plan(Some(8_000), 6.0 * 3600.0);
    assert_eq!((r, ch), (None, 1));
    assert!((limit - PREVIEW_BUDGET / 8_000.0).abs() < 1.0);
}

#[test]
fn preview_cancel_stops_only_its_own_request() {
    let base = 1u64 << 40;
    let a = start_preview(base);
    let b = start_preview(base + 1);
    cancel_preview(base);
    assert!(a.load(std::sync::atomic::Ordering::SeqCst));
    assert!(!b.load(std::sync::atomic::Ordering::SeqCst));
    finish_preview(base);
    finish_preview(base + 1);
    // A cancel that arrives before its decode starts still applies.
    cancel_preview(base + 2);
    assert!(start_preview(base + 2).load(std::sync::atomic::Ordering::SeqCst));
    finish_preview(base + 2);
    assert!(!start_preview(base + 3).load(std::sync::atomic::Ordering::SeqCst));
    finish_preview(base + 3);
}

#[test]
fn outputs_of_other_sources_are_never_overwritten_or_skipped() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let a = d.0.join("a.wav");
    let b = d.0.join("b.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=500:duration=0.2", "-c:a", "pcm_s16le", a.to_str().unwrap()]);
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=900:duration=0.2", "-c:a", "pcm_s16le", b.to_str().unwrap()]);
    let out = d.0.join("out");
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("same.flac"), b"old").unwrap();
    let req = |src: &Path, mode: &str| {
        let mut r = request(src, &out, "FLAC", "same");
        r.settings.on_existing = Some(mode.into());
        r
    };
    // A file that was there before is replaced; another source's output is not.
    assert_eq!(convert_blocking(&ctx(), &req(&a, "overwrite")).unwrap().1, "same.flac");
    assert_eq!(convert_blocking(&ctx(), &req(&b, "overwrite")).unwrap().1, "same_2.flac");
    // Converting the same source again may replace its own earlier output.
    assert_eq!(convert_blocking(&ctx(), &req(&a, "overwrite")).unwrap().1, "same.flac");
    // "Skip" does not treat another source's output as already done.
    let skipped = convert_blocking_ex(&ctx(), &req(&b, "skip")).unwrap();
    assert!(!skipped.skipped);
    assert_eq!(skipped.name, "same_3.flac");
}

#[test]
fn overwrite_never_replaces_a_queued_source() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let x_flac = d.0.join("x.flac");
    let x_wav = d.0.join("x.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=500:duration=0.2", "-c:a", "flac", x_flac.to_str().unwrap()]);
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=900:duration=0.2", "-c:a", "pcm_s16le", x_wav.to_str().unwrap()]);
    let wav_audio = compute_pcm_fingerprint(x_wav.to_str().unwrap()).unwrap().0;
    set_queued_sources_blocking(&[x_flac.clone(), x_wav.clone()]);
    let mut r = request(&x_flac, &d.0, "WAV", "x");
    r.settings.on_existing = Some("overwrite".into());
    r.settings.save_in_source_folder = Some(true);
    let done = convert_blocking_ex(&ctx(), &r).unwrap();
    set_queued_sources_blocking(&[]);
    assert_eq!(done.name, "x_2.wav");
    assert_eq!(compute_pcm_fingerprint(x_wav.to_str().unwrap()).unwrap().0, wav_audio, "the queued source is untouched");
}

#[test]
fn an_output_moved_into_its_source_name_is_protected() {
    if !ffmpeg_available() {
        return;
    }
    let d = temp_dir();
    let song_flac = d.0.join("song.flac");
    let song_wav = d.0.join("song.wav");
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=500:duration=0.2", "-c:a", "flac", song_flac.to_str().unwrap()]);
    ffmpeg(&["-f", "lavfi", "-i", "sine=frequency=900:duration=0.2", "-c:a", "pcm_s16le", song_wav.to_str().unwrap()]);
    let req = |src: &Path| {
        let mut r = request(src, &d.0, "FLAC", "song");
        r.settings.on_existing = Some("overwrite".into());
        r.settings.save_in_source_folder = Some(true);
        r
    };
    let first = convert_blocking_ex(&ctx(), &req(&song_flac)).unwrap();
    let target = first.replaces.clone().expect("the source's own name is reserved");
    // The UI trashes the source, then moves the output into its name.
    let source_audio = compute_pcm_fingerprint(song_flac.to_str().unwrap()).unwrap().0;
    fs::remove_file(&song_flac).unwrap();
    move_into_place(&first.path, &target).unwrap();
    let second = convert_blocking_ex(&ctx(), &req(&song_wav)).unwrap();
    assert_eq!(second.name, "song_2.flac");
    assert_eq!(compute_pcm_fingerprint(song_flac.to_str().unwrap()).unwrap().0, source_audio);
}
