//! Merging several sources into one output (xrecode "many to one"), with a CUE sheet
//! that marks where each source starts (`merge.createcue`).
//!
//! Every source is decoded (its track range only, for an image track) to one PCM
//! stream at the first source's rate and channel count; that intermediate file then
//! goes through the normal conversion, so naming, tags, "existing file" handling and
//! the output checks are the same as for a single file.

use super::*;

#[derive(Deserialize, Debug, Clone)]
pub struct MergeInput {
    pub path: String,
    #[serde(rename = "startSeconds")]
    pub start_seconds: Option<f64>,
    #[serde(rename = "endSeconds")]
    pub end_seconds: Option<f64>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MergeRequest {
    pub inputs: Vec<MergeInput>,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "outputFormat")]
    pub output_format: String,
    #[serde(rename = "jobId")]
    pub job_id: Option<String>,
    pub settings: ConverterSettings,
    /// Tags of the merged file (album-level).
    pub tags: Option<InputTags>,
    /// Write `<output stem>.cue` next to the output.
    #[serde(rename = "createCue")]
    pub create_cue: Option<bool>,
    /// Check that every part of the output is bit-exact with its source.
    pub verify: Option<bool>,
    /// Put the inputs side by side as the channels of one file (xrecode "encode to a
    /// multi-channel file") instead of one after another.
    #[serde(rename = "joinChannels", default)]
    pub join_channels: bool,
}

#[derive(Serialize, Debug)]
pub struct MergeResponse {
    pub success: bool,
    pub path: Option<String>,
    #[serde(rename = "fileName")]
    pub file_name: Option<String>,
    #[serde(rename = "cuePath")]
    pub cue_path: Option<String>,
    pub skipped: bool,
    /// With `verify`: true when every part is bit-exact with its source.
    pub verified: Option<bool>,
    #[serde(rename = "verifyNote")]
    pub verify_note: Option<String>,
    pub error: Option<String>,
}

fn input_range(i: &MergeInput) -> Option<(f64, Option<f64>)> {
    track_range(i.start_seconds, i.end_seconds)
}

/// "mm:ss:ff" for a position in samples.
pub fn cue_time(samples: u64, rate: u32) -> String {
    let frames = ((samples as u128 * 75 + u128::from(rate) / 2) / u128::from(rate)) as u64;
    format!("{:02}:{:02}:{:02}", frames / 75 / 60, frames / 75 % 60, frames % 75)
}

fn cue_text(value: &str) -> String {
    value.replace('"', "'").replace(['\r', '\n'], " ")
}

/// The CUE sheet for a merged file: one TRACK per source, starting at its offset.
pub fn build_cue(audio_name: &str, format: OutFormat, tags: Option<&InputTags>, tracks: &[(String, String, u64)], rate: u32) -> String {
    let kind = match format {
        OutFormat::Mp3 => "MP3",
        OutFormat::Aiff => "AIFF",
        _ => "WAVE",
    };
    let mut out = String::new();
    if let Some(t) = tags {
        if let Some(g) = t.genre.as_deref().filter(|v| !v.is_empty()) {
            out.push_str(&format!("REM GENRE \"{}\"\r\n", cue_text(g)));
        }
        if let Some(y) = t.year.as_deref().filter(|v| !v.is_empty()) {
            out.push_str(&format!("REM DATE {}\r\n", cue_text(y)));
        }
        if let Some(p) = t.album_artist.as_deref().or(t.artist.as_deref()).filter(|v| !v.is_empty()) {
            out.push_str(&format!("PERFORMER \"{}\"\r\n", cue_text(p)));
        }
        if let Some(a) = t.album.as_deref().filter(|v| !v.is_empty()) {
            out.push_str(&format!("TITLE \"{}\"\r\n", cue_text(a)));
        }
    }
    out.push_str(&format!("FILE \"{}\" {kind}\r\n", cue_text(audio_name)));
    for (n, (title, artist, start)) in tracks.iter().enumerate() {
        out.push_str(&format!("  TRACK {:02} AUDIO\r\n", n + 1));
        if !title.is_empty() {
            out.push_str(&format!("    TITLE \"{}\"\r\n", cue_text(title)));
        }
        if !artist.is_empty() {
            out.push_str(&format!("    PERFORMER \"{}\"\r\n", cue_text(artist)));
        }
        out.push_str(&format!("    INDEX 01 {}\r\n", cue_time(*start, rate)));
    }
    out
}

pub struct Merged {
    pub converted: Converted,
    pub cue: Option<PathBuf>,
    pub verified: Option<(bool, String)>,
}

/// Compares each part of the merged output with its source, sample for sample.
fn verify_parts(ctx: &JobCtx, request: &MergeRequest, sources: &[(PathBuf, SourceInfo)], starts: &[u64], rate: u32, output: &Path) -> Result<(bool, String), String> {
    let out = probe_source(&get_ffmpeg_executable(), output)?;
    if out.lossless != Some(true) || out.sample_rate != Some(rate) {
        return Ok((false, "The output is not a lossless copy at the sources' rate, so it cannot be compared bit for bit".into()));
    }
    for (n, ((path, info), input)) in sources.iter().zip(&request.inputs).enumerate() {
        ctx.check()?;
        if info.sample_rate != Some(rate) || info.channels != out.channels || info.is_float != out.is_float {
            return Ok((false, format!("Part {} was resampled or remixed, so it cannot be compared bit for bit", n + 1)));
        }
        let start = starts[n] as f64 / f64::from(rate);
        let end = starts.get(n + 1).map(|s| *s as f64 / f64::from(rate));
        let cancelled = || ctx.cancelled();
        let a = crate::audio::audit::compute_pcm_fingerprint_range(&path.to_string_lossy(), input_range(input), &cancelled).map_err(|e| e.to_string())?;
        let b = crate::audio::audit::compute_pcm_fingerprint_range(&output.to_string_lossy(), Some((start, end)), &cancelled).map_err(|e| e.to_string())?;
        if a != b {
            return Ok((false, format!("Part {} differs from its source", n + 1)));
        }
    }
    Ok((true, format!("All {} parts are bit-exact with their sources", sources.len())))
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

/// Samples per channel `path` decodes to through `filters`.
fn count_samples(ffmpeg: &Path, path: &Path, filters: &str) -> Result<u64, String> {
    let mut child = hidden_command(ffmpeg)
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-af", &format!("{filters},pan=mono|c0=c0,aformat=sample_fmts=s16"), "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    let mut out = child.stdout.take().ok_or("no output")?;
    let bytes = std::io::copy(&mut out, &mut std::io::sink()).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Cannot decode {}", path.display()));
    }
    Ok(bytes / 2)
}

/// Joins the inputs as channels: input 1 gives the first channel(s), and so on; the
/// result has the standard layout for the channel count. Shorter inputs end in silence.
fn join_blocking(ctx: &JobCtx, request: &MergeRequest) -> Result<Merged, String> {
    let ffmpeg = get_ffmpeg_executable();
    let mut sources = Vec::new();
    for i in &request.inputs {
        let path = fs::canonicalize(&i.path).map(simplify_verbatim_path).map_err(|_| format!("Input file does not exist: {}", i.path))?;
        let mut info = probe_source(&ffmpeg, &path)?;
        if let Some((start, end)) = input_range(i) {
            info.duration = (end.unwrap_or(info.duration).min(info.duration) - start).max(0.0);
        }
        sources.push((path, info));
    }
    let rate = sources[0].1.sample_rate.ok_or("Cannot read the sample rate of the first file")?;
    let total: u32 = sources.iter().map(|(_, s)| s.channels.unwrap_or(1).max(1)).sum();
    if total > 8 {
        return Err(format!("{total} channels in all; at most 8 can be joined"));
    }
    let float = sources.iter().any(|(_, s)| s.is_float);
    let bits = sources.iter().map(|(_, s)| s.bits_per_sample.unwrap_or(if s.lossless == Some(false) { 24 } else { 16 })).max().unwrap_or(16);
    let (sample_fmt, codec, ext) = if float || bits > 24 { (if float { "flt" } else { "s32" }, if float { "pcm_f32le" } else { "pcm_s32le" }, "wav") } else if bits > 16 { ("s32", "flac", "flac") } else { ("s16", "flac", "flac") };
    let longest = sources.iter().map(|(_, s)| s.duration).fold(0.0, f64::max);

    let work = TempDir(std::env::temp_dir().join(format!("audio-convert-join-{}", uuid::Uuid::new_v4().simple())));
    fs::create_dir_all(&work.0).map_err(|e| e.to_string())?;
    let joined = work.0.join(format!("joined.{ext}"));
    // Each input's filters (cut, relabel, resample), and its exact length in samples
    // after them: shorter inputs are padded to the longest, sample for sample.
    let mut chains = Vec::new();
    for ((_, info), input) in sources.iter().zip(&request.inputs) {
        let mut f = Vec::new();
        if let Some(range) = input_range(input) {
            f.push(trim_filter(range, info.sample_rate));
        }
        if info.custom_layout {
            if let Some(c) = info.channels {
                f.push(format!("channelmap=channel_layout={}", layout_name(c)));
            }
        }
        if info.sample_rate != Some(rate) {
            f.push(resample_filter(rate));
        }
        f.push(format!("aformat=sample_fmts={sample_fmt}"));
        chains.push(f);
    }
    let mut lengths = Vec::new();
    for ((path, _), f) in sources.iter().zip(&chains) {
        ctx.check()?;
        lengths.push(count_samples(&ffmpeg, path, &f.join(","))?);
    }
    let longest_samples = lengths.iter().copied().max().unwrap_or(0);
    // Each input is decoded on its own and the channels are put side by side here, in
    // input order (FFmpeg's join filter dropped the last frames under load). The result
    // is only relabelled with the standard layout for the count, never remixed.
    let (raw, size) = match sample_fmt {
        "s16" => ("s16le", 2usize),
        "flt" => ("f32le", 4),
        _ => ("s32le", 4),
    };
    let mut writer_args: Vec<String> = vec![
        "-nostdin".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into(),
        "-f".into(), raw.into(), "-ar".into(), rate.to_string(), "-ch_layout".into(), layout_name(total), "-i".into(), "pipe:0".into(),
        "-c:a".into(), codec.into(),
    ];
    if codec == "flac" {
        writer_args.extend(["-compression_level".into(), "0".into(), "-frame_size".into(), "4096".into(), "-bits_per_raw_sample".into(), (if bits > 16 { 24 } else { 16 }).to_string()]);
    } else {
        writer_args.extend(["-rf64".into(), "auto".into()]);
    }
    writer_args.push(joined.to_string_lossy().into_owned());
    let mut writer = hidden_command(&ffmpeg)
        .args(&writer_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    let mut sink = writer.stdin.take().ok_or("Failed to open FFmpeg's input")?;
    let mut readers = Vec::new();
    for ((path, _), f) in sources.iter().zip(&chains) {
        let spawned = hidden_command(&ffmpeg)
            .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args(["-map", "0:a:0", "-af", &f.join(","), "-f", raw, "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        match spawned {
            Ok(child) => readers.push(child),
            Err(e) => {
                for r in readers.iter_mut() {
                    let _ = r.kill();
                    let _ = r.wait();
                }
                let _ = writer.kill();
                let _ = writer.wait();
                return Err(format!("Failed to start FFmpeg: {e}"));
            }
        }
    }
    let widths: Vec<usize> = sources.iter().map(|(_, s)| s.channels.unwrap_or(1).max(1) as usize).collect();
    let result = (|| -> Result<(), String> {
        const FRAMES: usize = 4096;
        let mut outs: Vec<_> = readers.iter_mut().map(|r| r.stdout.take()).collect();
        let mut bufs: Vec<Vec<u8>> = widths.iter().map(|w| vec![0u8; FRAMES * w * size]).collect();
        let frame_out = total as usize * size;
        let mut block = vec![0u8; FRAMES * frame_out];
        let mut done: u64 = 0;
        while done < longest_samples {
            ctx.check()?;
            let n = ((longest_samples - done) as usize).min(FRAMES);
            for ((out, buf), w) in outs.iter_mut().zip(bufs.iter_mut()).zip(&widths) {
                let want = n * w * size;
                let got = match out.as_mut() {
                    Some(o) => read_full(o, &mut buf[..want]).map_err(|e| e.to_string())?,
                    None => 0,
                };
                // Past an input's end: silence (zero is silence in every raw format here).
                buf[got..want].fill(0);
            }
            let mut at = 0;
            for f in 0..n {
                for (buf, w) in bufs.iter().zip(&widths) {
                    let bytes = w * size;
                    block[at..at + bytes].copy_from_slice(&buf[f * bytes..(f + 1) * bytes]);
                    at += bytes;
                }
            }
            sink.write_all(&block[..n * frame_out]).map_err(|e| format!("Cannot write the joined audio: {e}"))?;
            done += n as u64;
            if longest > 0.0 {
                ctx.emit("decoding", (done as f64 / longest_samples.max(1) as f64 * 100.0).min(99.0));
            }
        }
        Ok(())
    })();
    drop(sink);
    for r in readers.iter_mut() {
        let _ = r.kill();
        let _ = r.wait();
    }
    if result.is_err() {
        let _ = writer.kill();
    }
    let output = writer.wait_with_output().map_err(|e| e.to_string())?;
    result?;
    if !output.status.success() {
        return Err(format!("Cannot write the joined audio: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    ctx.check()?;

    // The joined channels are the point: an explicit channel setting does not apply.
    let mut join_settings = request.settings.clone();
    join_settings.channels = Some(total);
    let convert = ConvertRequest {
        input_file_path: joined.to_string_lossy().into_owned(),
        file_name: request.file_name.clone(),
        output_format: request.output_format.clone(),
        job_id: request.job_id.clone(),
        settings: join_settings,
        tags: request.tags.clone(),
        start_seconds: None,
        end_seconds: None,
        channel: None,
    };
    let converted = convert_core(ctx, &convert, Some(&sources[0].0))?;
    if converted.skipped || !request.verify.unwrap_or(false) {
        return Ok(Merged { converted, cue: None, verified: None });
    }
    ctx.emit("verifying", 0.0);
    // Each input against its channel(s) of the output, sample for sample.
    let out = probe_source(&ffmpeg, &converted.path)?;
    let verified = if out.lossless != Some(true) || out.sample_rate != Some(rate) {
        (false, "The output is not a lossless copy at the inputs' rate, so it cannot be compared bit for bit".to_string())
    } else {
        let mut result = (true, format!("All {} inputs are bit-exact in their channels", sources.len()));
        let mut first_channel = 0;
        let cancelled = || ctx.cancelled();
        for (n, ((path, info), input)) in sources.iter().zip(&request.inputs).enumerate() {
            let count = info.channels.unwrap_or(1).max(1);
            let same_shape = info.sample_rate == Some(rate) && lengths[n] == longest_samples && info.is_float == out.is_float;
            if !same_shape {
                result = (false, format!("Input {} was resampled or padded, so it cannot be compared bit for bit", n + 1));
                break;
            }
            for c in 0..count {
                let one = (count > 1).then_some(c);
                let a = crate::audio::audit::compute_pcm_fingerprint_part(&path.to_string_lossy(), input_range(input), one, &cancelled).map_err(|e| e.to_string())?;
                let b = crate::audio::audit::compute_pcm_fingerprint_part(&converted.path.to_string_lossy(), None, Some(first_channel + c), &cancelled).map_err(|e| e.to_string())?;
                if a != b {
                    result = (false, format!("Input {} differs from its channel", n + 1));
                    break;
                }
            }
            if !result.0 {
                break;
            }
            first_channel += count;
        }
        result
    };
    Ok(Merged { converted, cue: None, verified: Some(verified) })
}

pub(super) fn merge_blocking(ctx: &JobCtx, request: &MergeRequest) -> Result<Merged, String> {
    if request.inputs.len() < 2 {
        return Err("Merging needs at least two files".into());
    }
    if request.join_channels {
        return join_blocking(ctx, request);
    }
    let ffmpeg = get_ffmpeg_executable();
    let mut sources = Vec::new();
    for i in &request.inputs {
        let path = fs::canonicalize(&i.path).map(simplify_verbatim_path).map_err(|_| format!("Input file does not exist: {}", i.path))?;
        let mut info = probe_source(&ffmpeg, &path)?;
        if let Some((start, end)) = input_range(i) {
            info.duration = (end.unwrap_or(info.duration).min(info.duration) - start).max(0.0);
        }
        sources.push((path, info));
    }
    let first = &sources[0].1;
    let rate = first.sample_rate.ok_or("Cannot read the sample rate of the first file")?;
    let channels = first.channels.unwrap_or(2).max(1);
    // Keep the precision of the most precise source: float, 24-bit or 16-bit.
    let float = sources.iter().any(|(_, s)| s.is_float);
    let bits = sources.iter().map(|(_, s)| s.bits_per_sample.unwrap_or(if s.lossless == Some(false) { 24 } else { 16 })).max().unwrap_or(16);
    // The intermediate file: FLAC (lossless, keeps the cover, no 4 GB limit) for
    // integer audio up to 24 bits; WAV (RF64 when large, no cover) for float or 32-bit.
    let (raw, codec, size, ext) = if float {
        ("f32le", "pcm_f32le", 4u64, "wav")
    } else if bits > 24 {
        ("s32le", "pcm_s32le", 4, "wav")
    } else if bits > 16 {
        ("s32le", "flac", 4, "flac")
    } else {
        ("s16le", "flac", 2, "flac")
    };
    let sample_fmt = if float { "flt" } else if bits > 16 { "s32" } else { "s16" };
    let layout = layout_name(channels);
    let total: f64 = sources.iter().map(|(_, s)| s.duration).sum();

    let work = TempDir(std::env::temp_dir().join(format!("audio-convert-merge-{}", uuid::Uuid::new_v4().simple())));
    fs::create_dir_all(&work.0).map_err(|e| e.to_string())?;
    let joined = work.0.join(format!("merged.{ext}"));

    // The writer: raw PCM on stdin (+ the first source's cover).
    let mut writer_args: Vec<String> = vec![
        "-nostdin".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into(),
        "-f".into(), raw.into(), "-ar".into(), rate.to_string(), "-ch_layout".into(), layout.clone(), "-i".into(), "pipe:0".into(),
    ];
    let cover = first.cover_stream.filter(|_| codec == "flac");
    if cover.is_some() {
        writer_args.extend(["-i".into(), sources[0].0.to_string_lossy().into_owned()]);
    }
    writer_args.extend(["-map".into(), "0:a".into()]);
    if let Some(index) = cover {
        writer_args.extend(["-map".into(), format!("1:{index}"), "-c:v".into(), "copy".into(), "-disposition:v:0".into(), "attached_pic".into()]);
    }
    writer_args.extend(["-c:a".into(), codec.into()]);
    if codec == "flac" {
        let bits = if bits > 16 { 24 } else { 16 };
        writer_args.extend(["-compression_level".into(), "0".into(), "-frame_size".into(), "4096".into(), "-bits_per_raw_sample".into(), bits.to_string()]);
    } else {
        writer_args.extend(["-rf64".into(), "auto".into()]);
    }
    writer_args.push(joined.to_string_lossy().into_owned());
    let mut writer = hidden_command(&ffmpeg)
        .args(&writer_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    let mut sink = writer.stdin.take().ok_or("Failed to open FFmpeg's input")?;

    let mut starts = Vec::new();
    let mut written: u64 = 0;
    let frame = size * u64::from(channels);
    let result = (|| -> Result<(), String> {
        for ((path, info), input) in sources.iter().zip(&request.inputs) {
            starts.push(written / frame);
            let mut filters = Vec::new();
            if let Some(range) = input_range(input) {
                filters.push(trim_filter(range, info.sample_rate));
            }
            if info.custom_layout {
                if let Some(n) = info.channels {
                    filters.push(format!("channelmap=channel_layout={}", layout_name(n)));
                }
            }
            if info.sample_rate != Some(rate) {
                filters.push(resample_filter(rate));
            }
            filters.push(format!("aformat=sample_fmts={sample_fmt}:channel_layouts={layout}"));
            let mut reader = hidden_command(&ffmpeg)
                .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
                .arg(path)
                .args(["-map", "0:a:0", "-af", &filters.join(","), "-f", raw, "-"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
            let mut out = reader.stdout.take().ok_or("Failed to read FFmpeg's output")?;
            let mut buf = vec![0u8; 1 << 16];
            let copied = (|| -> Result<(), String> {
                loop {
                    ctx.check()?;
                    let n = out.read(&mut buf).map_err(|e| e.to_string())?;
                    if n == 0 {
                        return Ok(());
                    }
                    sink.write_all(&buf[..n]).map_err(|e| format!("Cannot write the merged audio: {e}"))?;
                    written += n as u64;
                    if total > 0.0 {
                        ctx.emit("decoding", (written as f64 / frame as f64 / f64::from(rate) / total * 100.0).min(99.0));
                    }
                }
            })();
            if copied.is_err() {
                let _ = reader.kill();
            }
            let status = reader.wait().map_err(|e| e.to_string())?;
            copied?;
            if !status.success() {
                return Err(format!("Cannot decode {}", path.display()));
            }
        }
        Ok(())
    })();
    drop(sink);
    if result.is_err() {
        let _ = writer.kill();
    }
    let output = writer.wait_with_output().map_err(|e| e.to_string())?;
    result?;
    if !output.status.success() {
        return Err(format!("Cannot write the merged audio: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    ctx.check()?;

    let convert = ConvertRequest {
        input_file_path: joined.to_string_lossy().into_owned(),
        file_name: request.file_name.clone(),
        output_format: request.output_format.clone(),
        job_id: request.job_id.clone(),
        settings: request.settings.clone(),
        tags: request.tags.clone(),
        start_seconds: None,
        end_seconds: None,
        channel: None,
    };
    let converted = convert_core(ctx, &convert, Some(&sources[0].0))?;
    if converted.skipped {
        return Ok(Merged { converted, cue: None, verified: None });
    }
    let verified = if request.verify.unwrap_or(false) {
        ctx.emit("verifying", 0.0);
        Some(verify_parts(ctx, request, &sources, &starts, rate, &converted.path)?)
    } else {
        None
    };
    if !request.create_cue.unwrap_or(true) {
        return Ok(Merged { converted, cue: None, verified });
    }

    // The output's rate may differ (a lossy encoder's or the rate limit); CUE times are
    // in seconds, so they hold for any rate.
    let tracks: Vec<(String, String, u64)> =
        request.inputs.iter().zip(&starts).map(|(i, s)| (i.title.clone(), i.artist.clone(), *s)).collect();
    let format = OutFormat::parse(&request.output_format).unwrap_or(OutFormat::Flac);
    let text = build_cue(&converted.name, format, request.tags.as_ref(), &tracks, rate);
    let stem = converted.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "merged".into());
    let dir = converted.path.parent().map(Path::to_path_buf).unwrap_or_default();
    // Never replace an existing file: the sheet gets a free name like the audio does.
    let mut cue = None;
    for i in 0..1000 {
        let name = if i == 0 { format!("{stem}.cue") } else { format!("{stem}_{}.cue", i + 1) };
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                // UTF-8 with BOM, which CUE readers recognise.
                f.write_all(b"\xEF\xBB\xBF").and_then(|_| f.write_all(text.as_bytes())).map_err(|e| format!("Cannot write the CUE sheet: {e}"))?;
                cue = Some(path);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Cannot write the CUE sheet: {e}")),
        }
    }
    Ok(Merged { converted, cue, verified })
}

#[tauri::command]
pub async fn merge_audio(app: AppHandle, state: tauri::State<'_, ActiveJobs>, request: MergeRequest) -> Result<MergeResponse, String> {
    let ctx = JobCtx { app: Some(app), jobs: state.inner().clone(), job_id: request.job_id.clone() };
    let result = tauri::async_runtime::spawn_blocking(move || merge_blocking(&ctx, &request)).await.map_err(|e| e.to_string())?;
    Ok(match result {
        Ok(m) => MergeResponse {
            success: true,
            path: Some(m.converted.path.to_string_lossy().into_owned()),
            file_name: Some(m.converted.name),
            cue_path: m.cue.map(|p| p.to_string_lossy().into_owned()),
            skipped: m.converted.skipped,
            verified: m.verified.as_ref().map(|v| v.0),
            verify_note: m.verified.map(|v| v.1),
            error: None,
        },
        Err(e) => MergeResponse { success: false, path: None, file_name: None, cue_path: None, skipped: false, verified: None, verify_note: None, error: Some(e) },
    })
}
