//! DSD sources (DSF / DFF) kept as DSD: copied to a DSF file, or packed as DoP
//! ("DSD over PCM", 24-bit PCM at 1/16 of the DSD rate with 0x05 / 0xFA markers) into
//! FLAC / WAV / AIFF for players that pass DoP to a DAC (xrecode `usedop`).
//!
//! The bit stream is never changed: a DSF output holds the same bits, and a DoP
//! output unpacks to the same bits (`dop_matches` checks that). PCM sources cannot be
//! made into DSD here (that needs a sigma-delta modulator).

use super::*;
use std::io::{BufReader, BufWriter, Seek, SeekFrom};

/// A DSD file opened for reading: the bit stream per channel, oldest bit first (MSB).
pub struct DsdReader {
    file: BufReader<File>,
    dff: bool,
    pub channels: u32,
    /// Bits per second per channel (2822400 for DSD64).
    pub rate: u32,
    /// Bytes per channel still to read.
    remaining: u64,
    /// DSF: bytes per channel per block.
    block: usize,
}

fn read_u32le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}
fn read_u64le(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}
fn read_u64be(b: &[u8]) -> u64 {
    u64::from_be_bytes(b[..8].try_into().unwrap())
}

impl DsdReader {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut file = BufReader::new(File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?);
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic).map_err(|e| e.to_string())?;
        match &magic {
            b"DSD " => Self::open_dsf(file),
            b"FRM8" => Self::open_dff(file),
            _ => Err("Not a DSF or DFF file".into()),
        }
    }

    fn open_dsf(mut file: BufReader<File>) -> Result<Self, String> {
        let mut head = [0u8; 24];
        file.read_exact(&mut head).map_err(|e| e.to_string())?; // rest of "DSD " chunk
        let mut fmt = [0u8; 52];
        file.read_exact(&mut fmt).map_err(|e| e.to_string())?;
        if &fmt[..4] != b"fmt " || read_u32le(&fmt[16..]) != 0 {
            return Err("Unsupported DSF format".into());
        }
        let channels = read_u32le(&fmt[24..]);
        let rate = read_u32le(&fmt[28..]);
        let bits = read_u32le(&fmt[32..]);
        let samples = read_u64le(&fmt[36..]);
        let block = read_u32le(&fmt[44..]) as usize;
        // Header values sized against what DSF allows, so a damaged header cannot ask
        // for a huge buffer.
        if bits != 1 || channels == 0 || channels > 8 || block == 0 || block > 1 << 20 {
            return Err("Unsupported DSF format (only 1-bit LSB-first)".into());
        }
        let mut data = [0u8; 12];
        file.read_exact(&mut data).map_err(|e| e.to_string())?;
        if &data[..4] != b"data" {
            return Err("DSF data chunk not found".into());
        }
        Ok(Self { file, dff: false, channels, rate, remaining: samples.div_ceil(8), block })
    }

    fn open_dff(mut file: BufReader<File>) -> Result<Self, String> {
        let mut head = [0u8; 8 + 4];
        file.read_exact(&mut head).map_err(|e| e.to_string())?; // size + "DSD "
        if &head[8..] != b"DSD " {
            return Err("Not a DSDIFF file".into());
        }
        let (mut channels, mut rate) = (0u32, 0u32);
        loop {
            let mut ck = [0u8; 12];
            file.read_exact(&mut ck).map_err(|_| "DFF sound data not found".to_string())?;
            let size = read_u64be(&ck[4..]);
            match &ck[..4] {
                b"PROP" => {
                    if size > 1 << 20 {
                        return Err("Damaged DFF header".into());
                    }
                    let mut body = vec![0u8; size as usize];
                    file.read_exact(&mut body).map_err(|e| e.to_string())?;
                    let mut at = 4; // "SND "
                    while at + 12 <= body.len() {
                        let id = &body[at..at + 4];
                        // Bounded by the (already bounded) PROP chunk.
                        let len = (read_u64be(&body[at + 4..]).min(body.len() as u64)) as usize;
                        let v = &body[at + 12..(at + 12 + len).min(body.len())];
                        match id {
                            b"FS  " if v.len() >= 4 => rate = u32::from_be_bytes([v[0], v[1], v[2], v[3]]),
                            b"CHNL" if v.len() >= 2 => channels = u32::from(u16::from_be_bytes([v[0], v[1]])),
                            b"CMPR" if v.len() >= 4 && &v[..4] != b"DSD " => return Err("Compressed (DST) DFF is not supported".into()),
                            _ => {}
                        }
                        at += 12 + len + (len & 1);
                    }
                }
                b"DSD " => {
                    if channels == 0 || channels > 8 || rate == 0 {
                        return Err("DFF without sound properties".into());
                    }
                    return Ok(Self { file, dff: true, channels, rate, remaining: size / u64::from(channels), block: 0 });
                }
                _ => {
                    let skip = i64::try_from(size + (size & 1)).map_err(|_| "Damaged DFF header".to_string())?;
                    file.seek_relative(skip).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    /// The next part of the stream: one Vec per channel (equal lengths), MSB first.
    pub fn next_chunk(&mut self) -> Result<Option<Vec<Vec<u8>>>, String> {
        if self.remaining == 0 {
            return Ok(None);
        }
        let ch = self.channels as usize;
        if self.dff {
            let n = (self.remaining.min(16384)) as usize;
            let mut raw = vec![0u8; n * ch];
            self.file.read_exact(&mut raw).map_err(|e| format!("Cannot read DSD data: {e}"))?;
            self.remaining -= n as u64;
            let mut out = vec![Vec::with_capacity(n); ch];
            for frame in raw.chunks_exact(ch) {
                for (c, b) in frame.iter().enumerate() {
                    out[c].push(*b);
                }
            }
            return Ok(Some(out));
        }
        let mut raw = vec![0u8; self.block * ch];
        self.file.read_exact(&mut raw).map_err(|e| format!("Cannot read DSD data: {e}"))?;
        let n = (self.remaining.min(self.block as u64)) as usize;
        self.remaining -= n as u64;
        // DSF stores each byte LSB first.
        Ok(Some((0..ch).map(|c| raw[c * self.block..c * self.block + n].iter().map(|b| b.reverse_bits()).collect()).collect()))
    }
}

/// True when `codec` is FFmpeg's name for a DSD stream.
pub fn is_dsd_codec(codec: Option<&str>) -> bool {
    codec.is_some_and(|c| c.starts_with("dsd_"))
}

const DSF_BLOCK: usize = 4096;
/// DSD silence (an idle pattern with no DC), used to pad the last block.
const DSD_SILENCE: u8 = 0x69;

/// Writes a DSF file from `reader`, with an ID3v2 tag at the end.
pub fn write_dsf(reader: &mut DsdReader, output: &Path, tags: &TagMap, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let ch = reader.channels as usize;
    let mut out = BufWriter::new(File::create(output).map_err(|e| e.to_string())?);
    let io = |e: std::io::Error| e.to_string();
    // Header first with placeholder sizes; patched at the end.
    out.write_all(&[0u8; 28 + 52 + 12]).map_err(io)?;
    let mut pending: Vec<Vec<u8>> = vec![Vec::new(); ch];
    let mut bytes_per_channel: u64 = 0;
    let mut blocks: u64 = 0;
    let mut flush = |pending: &mut Vec<Vec<u8>>, out: &mut BufWriter<File>, all: bool| -> Result<(), String> {
        while pending[0].len() >= DSF_BLOCK || (all && !pending[0].is_empty()) {
            for p in pending.iter_mut() {
                let take = p.len().min(DSF_BLOCK);
                let mut block: Vec<u8> = p.drain(..take).map(|b| b.reverse_bits()).collect();
                block.resize(DSF_BLOCK, DSD_SILENCE.reverse_bits());
                out.write_all(&block).map_err(io)?;
            }
            blocks += 1;
        }
        Ok(())
    };
    while let Some(chunk) = reader.next_chunk()? {
        if cancelled() {
            return Err(crate::audio::audit::CANCELLED.into());
        }
        bytes_per_channel += chunk[0].len() as u64;
        for (p, c) in pending.iter_mut().zip(chunk) {
            p.extend(c);
        }
        flush(&mut pending, &mut out, false)?;
    }
    flush(&mut pending, &mut out, true)?;
    let data_size = 12 + blocks * (DSF_BLOCK * ch) as u64;
    let id3 = build_id3v23(tags).unwrap_or_default();
    out.write_all(&id3).map_err(io)?;
    let total = 28 + 52 + data_size + id3.len() as u64;
    let mut header = Vec::with_capacity(92);
    header.extend_from_slice(b"DSD ");
    header.extend_from_slice(&28u64.to_le_bytes());
    header.extend_from_slice(&total.to_le_bytes());
    header.extend_from_slice(&(if id3.is_empty() { 0 } else { 28 + 52 + data_size }).to_le_bytes());
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&52u64.to_le_bytes());
    header.extend_from_slice(&1u32.to_le_bytes()); // version
    header.extend_from_slice(&0u32.to_le_bytes()); // DSD raw
    let channel_type: u32 = match ch {
        1 => 1,
        2 => 2,
        3 => 3,
        4 => 4,
        5 => 6,
        6 => 7,
        _ => 2,
    };
    header.extend_from_slice(&channel_type.to_le_bytes());
    header.extend_from_slice(&(ch as u32).to_le_bytes());
    header.extend_from_slice(&reader.rate.to_le_bytes());
    header.extend_from_slice(&1u32.to_le_bytes()); // bits per sample (LSB first)
    header.extend_from_slice(&(bytes_per_channel * 8).to_le_bytes());
    header.extend_from_slice(&(DSF_BLOCK as u32).to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_size.to_le_bytes());
    let mut file = out.into_inner().map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    file.write_all(&header).map_err(io)?;
    file.sync_all().map_err(io)
}

/// DoP frames as s32le PCM (24-bit values in the top bits): per frame and channel,
/// marker << 16 | two DSD bytes. `marker` alternates 0x05 / 0xFA frame by frame.
pub fn dop_pack(chunk: &[Vec<u8>], marker: &mut bool, out: &mut Vec<u8>) {
    let frames = chunk[0].len() / 2;
    for f in 0..frames {
        let m: u32 = if *marker { 0xFA } else { 0x05 };
        *marker = !*marker;
        for c in chunk {
            let v = (m << 16) | (u32::from(c[2 * f]) << 8) | u32::from(c[2 * f + 1]);
            out.extend_from_slice(&(v << 8).to_le_bytes());
        }
    }
}

/// Runs FFmpeg to encode the DoP stream of `reader` (raw s32le on stdin) to `output`.
pub fn write_dop(ffmpeg: &Path, reader: &mut DsdReader, args_after_input: &[String], output: &Path, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    if !reader.rate.is_multiple_of(16) {
        return Err("This DSD rate cannot be carried as DoP".into());
    }
    let ch = reader.channels as usize;
    let mut cmd = hidden_command(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "s32le", "-ar"])
        .arg((reader.rate / 16).to_string())
        .args(["-ch_layout", &layout_name(ch as u32), "-i", "pipe:0"])
        .args(args_after_input)
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    let mut sink = child.stdin.take().ok_or("Failed to open FFmpeg's input")?;
    let mut marker = false;
    let mut carry: Vec<Vec<u8>> = vec![Vec::new(); ch];
    let result = (|| -> Result<(), String> {
        let mut buf = Vec::new();
        while let Some(chunk) = reader.next_chunk()? {
            if cancelled() {
                return Err(crate::audio::audit::CANCELLED.into());
            }
            for (c, part) in carry.iter_mut().zip(chunk) {
                c.extend(part);
            }
            let even = carry[0].len() & !1;
            let ready: Vec<Vec<u8>> = carry.iter_mut().map(|c| c.drain(..even).collect()).collect();
            buf.clear();
            dop_pack(&ready, &mut marker, &mut buf);
            sink.write_all(&buf).map_err(|e| format!("Cannot write DoP audio: {e}"))?;
        }
        if !carry[0].is_empty() {
            for c in carry.iter_mut() {
                c.push(DSD_SILENCE);
            }
            buf.clear();
            dop_pack(&carry, &mut marker, &mut buf);
            sink.write_all(&buf).map_err(|e| format!("Cannot write DoP audio: {e}"))?;
        }
        Ok(())
    })();
    drop(sink);
    if result.is_err() {
        let _ = child.kill();
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    result?;
    if !out.status.success() {
        return Err(format!("FFmpeg failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// True when `converted` (a DoP FLAC / WAV / AIFF) carries exactly the DSD bits of
/// `original`. None when `converted` is not DoP.
pub fn dop_matches(original: &Path, converted: &Path, cancelled: &dyn Fn() -> bool) -> Result<Option<bool>, String> {
    let mut reader = DsdReader::open(original)?;
    let ch = reader.channels as usize;
    let mut child = hidden_command(&get_ffmpeg_executable())
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(converted)
        .args(["-map", "0:a:0", "-c:a", "pcm_s32le", "-f", "s32le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut pcm = BufReader::new(child.stdout.take().ok_or("no output")?);
    let result = (|| -> Result<Option<bool>, String> {
        let mut first = true;
        let mut frame = vec![0u8; 4 * ch];
        // One frame holds two DSD bytes per channel; a stream with an odd byte count
        // ends with that byte and DSD silence (as `write_dop` pads it).
        let mut carry: Vec<Vec<u8>> = vec![Vec::new(); ch];
        while let Some(chunk) = reader.next_chunk()? {
            if cancelled() {
                return Err(crate::audio::audit::CANCELLED.into());
            }
            for (c, part) in carry.iter_mut().zip(chunk) {
                c.extend(part);
            }
            let even = carry[0].len() & !1;
            let chunk: Vec<Vec<u8>> = carry.iter_mut().map(|c| c.drain(..even).collect()).collect();
            let mut i = 0;
            while i + 1 < chunk[0].len() {
                if pcm.read_exact(&mut frame).is_err() {
                    return Ok(Some(false));
                }
                for (c, data) in chunk.iter().enumerate() {
                    let v = u32::from_le_bytes(frame[4 * c..4 * c + 4].try_into().unwrap()) >> 8;
                    let marker = v >> 16;
                    if marker != 0x05 && marker != 0xFA {
                        return Ok(if first { None } else { Some(false) });
                    }
                    if (v & 0xFFFF) != (u32::from(data[i]) << 8 | u32::from(data[i + 1])) {
                        return Ok(Some(false));
                    }
                }
                first = false;
                i += 2;
            }
        }
        if !carry[0].is_empty() {
            if pcm.read_exact(&mut frame).is_err() {
                return Ok(Some(false));
            }
            for (c, data) in carry.iter().enumerate() {
                let v = u32::from_le_bytes(frame[4 * c..4 * c + 4].try_into().unwrap()) >> 8;
                if (v & 0xFFFF) != (u32::from(data[0]) << 8 | u32::from(DSD_SILENCE)) {
                    return Ok(Some(false));
                }
            }
            first = false;
        }
        // Nothing may follow the source's bits.
        if pcm.read_exact(&mut frame).is_ok() {
            return Ok(Some(false));
        }
        Ok(Some(!first))
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Noise-shaping filters of sox-dsd's `sdm` effect.
pub const SDM_FILTERS: &[&str] = &["sdm-4", "sdm-5", "sdm-6", "sdm-7", "sdm-8", "clans-4", "clans-5", "clans-6", "clans-7", "clans-8"];

/// The SoX arguments that read `rate` Hz, `channels`-channel f32 PCM on stdin and write
/// DSD (64/128/256 x 44.1 kHz) as DSF to stdout (the app gives SoX the output file as
/// stdout, so non-ASCII paths never pass through a narrow Windows argv). sdm maps 0 dBFS
/// to 50 % modulation (the SACD level), so the DSD decodes 6 dB below the PCM. (SoX's -G
/// guard must not be used: with the 1-bit output it ruins the file.)
pub fn sox_dsd_args(rate: u32, channels: u32, dsd_multiple: u32, filter: &str) -> Vec<String> {
    let multiple = match dsd_multiple {
        128 | 256 => dsd_multiple,
        _ => 64,
    };
    let filter = if SDM_FILTERS.contains(&filter) { filter } else { "sdm-8" };
    vec![
        "-S".into(), "-V2".into(),
        "-t".into(), "raw".into(), "-e".into(), "floating-point".into(), "-b".into(), "32".into(), "-L".into(),
        "-r".into(), rate.to_string(), "-c".into(), channels.to_string(), "-".into(),
        "-t".into(), "dsf".into(), "-".into(),
        "rate".into(), "-v".into(), (44_100 * multiple).to_string(),
        "sdm".into(), "-f".into(), filter.into(),
    ]
}

/// Seconds of input SoX has read, from its -S progress line ("In:0.00% 00:01:02.35 ...";
/// the percentage stays 0 for a raw pipe of unknown length).
pub fn sox_progress_seconds(text: &str) -> Option<f64> {
    let at = text.rfind("In:")?;
    let time = text[at..].split_whitespace().nth(1)?;
    let mut parts = time.split(':').map(|p| p.parse::<f64>());
    let (h, m, s) = (parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?);
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Writes `tags` into a DSF file in place: the ID3v2 tag goes at the end (replacing one
/// that is there) and the header's file size and metadata pointer are updated.
pub fn set_dsf_tags(path: &Path, tags: &TagMap) -> Result<(), String> {
    let io = |e: std::io::Error| format!("Cannot tag the DSF file: {e}");
    let mut file = OpenOptions::new().read(true).write(true).open(path).map_err(io)?;
    let mut head = [0u8; 28];
    file.read_exact(&mut head).map_err(io)?;
    if &head[..4] != b"DSD " {
        return Err("Not a DSF file".into());
    }
    let len = file.metadata().map_err(io)?.len();
    let pointer = read_u64le(&head[20..]);
    // Audio ends where an old tag starts (or at the end of the file).
    let audio_end = if pointer > 0 && pointer < len { pointer } else { len };
    file.set_len(audio_end).map_err(io)?;
    let id3 = build_id3v23(tags).unwrap_or_default();
    file.seek(SeekFrom::Start(audio_end)).map_err(io)?;
    file.write_all(&id3).map_err(io)?;
    let total = audio_end + id3.len() as u64;
    file.seek(SeekFrom::Start(12)).map_err(io)?;
    file.write_all(&total.to_le_bytes()).map_err(io)?;
    file.write_all(&(if id3.is_empty() { 0 } else { audio_end }).to_le_bytes()).map_err(io)?;
    file.sync_all().map_err(io)
}

/// Gain (dB) applied before the modulator so the resampler's inter-sample peaks of a loud
/// master are not clipped (SoX's integer `rate` stage clips at full scale).
pub const DSD_HEADROOM_DB: f64 = 1.0;

/// PCM (any source FFmpeg reads) to a DSF file at `output`: FFmpeg decodes with the
/// usual cut, channel and effect filters to f32 on a pipe, SoX resamples to the DSD rate
/// and modulates with sox-dsd's sigma-delta modulator. Cancelling kills both.
pub(super) fn pcm_to_dsf(
    ctx: &JobCtx,
    ffmpeg: &Path,
    input: &Path,
    settings: &ConverterSettings,
    source: &SourceInfo,
    gain_db: Option<f64>,
    output: &Path,
) -> Result<(), String> {
    let (rate, channels) = target_shape(OutFormat::Dsf, settings, source);
    let rate = rate.or(source.sample_rate).unwrap_or(44_100);
    let channels = channels.or(source.channels).unwrap_or(2).max(1);
    if channels > 6 {
        return Err(format!("DSF holds at most 6 channels (the source has {channels})"));
    }
    let mut filters = pre_gain_filters(OutFormat::Dsf, settings, source);
    let gain = gain_db.filter(|g| !same_as_source(settings) && g.is_finite()).unwrap_or(0.0) - DSD_HEADROOM_DB;
    filters.push(format!("volume={gain:.4}dB"));
    // Channels in their order: relabelled (never remixed) when the count is unchanged,
    // so a 2.1 or 4.0 source keeps every channel. Always the rate SoX is told.
    if source.channels == Some(channels) {
        filters.push(format!("channelmap=channel_layout={}", layout_name(channels)));
    }
    filters.push(format!("aresample={rate},aformat=sample_fmts=flt:channel_layouts={}", layout_name(channels)));
    let mut decode: Vec<String> = vec!["-nostdin".into(), "-v".into(), "error".into(), "-i".into(), input.to_string_lossy().into_owned(), "-map".into(), "0:a:0".into()];
    decode.extend(["-af".into(), filters.join(",")]);
    decode.extend(["-c:a".into(), "pcm_f32le".into(), "-f".into(), "f32le".into(), "-".into()]);

    ctx.check()?;
    ctx.emit("converting", 0.0);
    let out_file = File::create(output).map_err(|e| format!("Cannot create the DSD file: {e}"))?;
    let mut decoder = hidden_command(ffmpeg)
        .args(&decode)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start FFmpeg: {e}"))?;
    let pcm = decoder.stdout.take().ok_or("Failed to read FFmpeg's output")?;
    let sox = crate::audio::audit::get_sox_executable();
    let filter = settings.dsd_filter.as_deref().unwrap_or("sdm-8");
    let mut modulator = match hidden_command(&sox)
        .args(sox_dsd_args(rate, channels, settings.dsd_rate.unwrap_or(64), filter))
        .stdin(Stdio::from(pcm))
        .stdout(Stdio::from(out_file))
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            let _ = decoder.kill();
            let _ = decoder.wait();
            return Err(format!("Failed to start SoX ({}): {e}", sox.display()));
        }
    };

    // Both stderr streams are drained on their own threads (a full pipe would stall the
    // process); SoX's carries the progress, FFmpeg's only errors.
    let ffmpeg_err = decoder.stderr.take();
    let ffmpeg_tail = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut e) = ffmpeg_err {
            let _ = e.read_to_string(&mut text);
        }
        text
    });
    let sox_err = modulator.stderr.take();
    let progress_ctx = ctx.clone();
    let duration = source.duration;
    let sox_tail = std::thread::spawn(move || {
        let mut tail = String::new();
        if let Some(mut e) = sox_err {
            let mut buf = [0u8; 4096];
            while let Ok(n) = e.read(&mut buf) {
                if n == 0 {
                    break;
                }
                tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                if duration > 0.0 {
                    if let Some(done) = sox_progress_seconds(&tail) {
                        progress_ctx.emit("converting", (done / duration * 100.0).clamp(0.0, 99.0));
                    }
                }
                if tail.len() > 16384 {
                    tail.drain(..tail.len() - 4096);
                }
            }
        }
        tail
    });

    let mut cancelled = false;
    let (decode_status, modulate_status) = loop {
        if ctx.cancelled() {
            cancelled = true;
            let _ = decoder.kill();
            let _ = modulator.kill();
        }
        match (decoder.try_wait(), modulator.try_wait()) {
            (Ok(Some(d)), Ok(Some(m))) => break (d, m),
            (Err(e), _) | (_, Err(e)) => {
                let _ = decoder.kill();
                let _ = modulator.kill();
                let _ = decoder.wait();
                let _ = modulator.wait();
                return Err(format!("PCM to DSD did not finish: {e}"));
            }
            // One side failed: the other would wait (SoX for input) or keep decoding.
            (Ok(Some(d)), Ok(None)) if !d.success() => {
                let _ = modulator.kill();
            }
            (Ok(None), Ok(Some(m))) if !m.success() => {
                let _ = decoder.kill();
            }
            _ => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let ffmpeg_text = ffmpeg_tail.join().unwrap_or_default();
    let sox_text = sox_tail.join().unwrap_or_default();
    if cancelled {
        return Err("Conversion cancelled".into());
    }
    let last_lines = |text: &str, skip_progress: bool| -> String {
        let lines: Vec<&str> = text.split(['\n', '\r']).map(str::trim).filter(|l| !l.is_empty() && !(skip_progress && l.starts_with("In:"))).collect();
        lines.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" / ")
    };
    // SoX first: when it fails, FFmpeg only sees a broken pipe.
    if !modulate_status.success() {
        return Err(format!("SoX could not write DSD: {}", last_lines(&sox_text, true)));
    }
    if !decode_status.success() {
        return Err(format!("Cannot decode the source: {}", last_lines(&ffmpeg_text, false)));
    }
    Ok(())
}

#[cfg(test)]
pub mod test_util {
    use super::*;

    /// A DSD64 DSF with a first-order sigma-delta modulated sine (enough for tests).
    pub fn write_test_dsf(path: &Path, seconds: f64, channels: u32) {
        let rate = 2_822_400u32;
        let bits = (seconds * f64::from(rate)) as usize;
        let mut chans = vec![vec![0u8; bits.div_ceil(8)]; channels as usize];
        for (c, data) in chans.iter_mut().enumerate() {
            let mut integ = 0.0f64;
            for i in 0..bits {
                let x = 0.5 * (2.0 * std::f64::consts::PI * (1000.0 + 500.0 * c as f64) * i as f64 / f64::from(rate)).sin();
                let y = if integ >= 0.0 { 1.0 } else { -1.0 };
                integ += x - y;
                if y > 0.0 {
                    data[i / 8] |= 0x80 >> (i % 8);
                }
            }
        }
        // Through a DFF-like in-memory reader: build the DSF via write_dsf from a temp DFF.
        let dff = path.with_extension("tmp.dff");
        write_test_dff(&dff, rate, &chans, bits);
        let mut r = DsdReader::open(&dff).unwrap();
        write_dsf(&mut r, path, &vec![("title".into(), "DSD Test".into())], &|| false).unwrap();
        let _ = fs::remove_file(&dff);
    }

    /// A DFF (DSDIFF) file from per-channel MSB-first bytes.
    pub fn write_test_dff(path: &Path, rate: u32, chans: &[Vec<u8>], _bits: usize) {
        let ch = chans.len();
        let n = chans[0].len();
        let mut snd = Vec::new();
        snd.extend_from_slice(b"SND ");
        let mut sub = |id: &[u8], body: &[u8]| {
            snd.extend_from_slice(id);
            snd.extend_from_slice(&(body.len() as u64).to_be_bytes());
            snd.extend_from_slice(body);
            if body.len() & 1 == 1 {
                snd.push(0);
            }
        };
        sub(b"FS  ", &rate.to_be_bytes());
        let mut chnl = (ch as u16).to_be_bytes().to_vec();
        for i in 0..ch {
            chnl.extend_from_slice(if i == 0 { b"SLFT" } else { b"SRGT" });
        }
        sub(b"CHNL", &chnl);
        sub(b"CMPR", b"DSD \x0enot compressed\x00");
        let mut data = Vec::with_capacity(n * ch);
        for i in 0..n {
            for c in chans {
                data.push(c[i]);
            }
        }
        let mut body = Vec::new();
        body.extend_from_slice(b"DSD ");
        body.extend_from_slice(b"FVER");
        body.extend_from_slice(&4u64.to_be_bytes());
        body.extend_from_slice(&0x0105_0000u32.to_be_bytes());
        body.extend_from_slice(b"PROP");
        body.extend_from_slice(&(snd.len() as u64).to_be_bytes());
        body.extend_from_slice(&snd);
        body.extend_from_slice(b"DSD ");
        body.extend_from_slice(&(data.len() as u64).to_be_bytes());
        body.extend_from_slice(&data);
        let mut file = Vec::new();
        file.extend_from_slice(b"FRM8");
        file.extend_from_slice(&(body.len() as u64).to_be_bytes());
        file.extend_from_slice(&body);
        fs::write(path, file).unwrap();
    }
}
