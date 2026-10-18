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
    assert_eq!(output_stem("AC/DC - T.N.T.flac", input), "AC_DC - T.N.T");
    assert_eq!(output_stem("", input), "source track");
    assert_eq!(output_stem(".hidden", input), ".hidden");
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
