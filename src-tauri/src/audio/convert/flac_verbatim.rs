//! Uncompressed FLAC: rewrites the audio frames of a FLAC file so every subframe is
//! VERBATIM (the samples stored as they are, no prediction or entropy coding).
//!
//! FFmpeg's encoder cannot write such files, so the converter encodes a normal FLAC
//! (which carries the tags and cover art), decodes its samples and writes them again
//! here. Metadata blocks are kept, except SEEKTABLE (its offsets no longer match).
//! The audio is unchanged, so the STREAMINFO MD5 stays valid.

use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

/// Samples per frame (the usual FLAC block size).
const BLOCK: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamInfo {
    pub sample_rate: u32,
    pub channels: u32,
    pub bits: u32,
    pub total_samples: u64,
}

struct Block {
    kind: u8,
    data: Vec<u8>,
}

/// Reads the metadata blocks only (not the audio). Returns them and the audio offset.
fn read_blocks(r: &mut impl Read) -> Result<(Vec<Block>, usize), String> {
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).map_err(|_| "not a FLAC file")?;
    if &magic != b"fLaC" {
        return Err("not a FLAC file".into());
    }
    let mut pos = 4;
    let mut blocks = Vec::new();
    loop {
        let mut header = [0u8; 4];
        r.read_exact(&mut header).map_err(|_| "truncated FLAC metadata")?;
        let last = header[0] & 0x80 != 0;
        let kind = header[0] & 0x7f;
        let len = u32::from_be_bytes([0, header[1], header[2], header[3]]) as usize;
        let mut data = vec![0u8; len];
        r.read_exact(&mut data).map_err(|_| "truncated FLAC metadata block")?;
        pos += 4 + len;
        blocks.push(Block { kind, data });
        if last {
            return Ok((blocks, pos));
        }
    }
}

pub fn parse_stream_info(data: &[u8]) -> Result<StreamInfo, String> {
    if data.len() < 34 {
        return Err("bad STREAMINFO".into());
    }
    let v = u64::from_be_bytes(data[10..18].try_into().unwrap());
    Ok(StreamInfo {
        sample_rate: (v >> 44) as u32,
        channels: ((v >> 41) & 0x7) as u32 + 1,
        bits: ((v >> 36) & 0x1f) as u32 + 1,
        total_samples: v & 0xf_ffff_ffff,
    })
}

struct BitWriter {
    out: Vec<u8>,
    acc: u64,
    n: u32,
}

impl BitWriter {
    fn new() -> Self {
        Self { out: Vec::new(), acc: 0, n: 0 }
    }
    fn put(&mut self, value: u64, bits: u32) {
        // bits <= 32 here, so acc never overflows (n < 8 before each call).
        self.acc = (self.acc << bits) | (value & ((1u64 << bits) - 1));
        self.n += bits;
        while self.n >= 8 {
            self.n -= 8;
            self.out.push((self.acc >> self.n) as u8);
        }
    }
    fn align(&mut self) {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.put(0, pad);
        }
    }
}

fn crc8(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in data {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 { (crc << 1) ^ 0x07 } else { crc << 1 };
        }
    }
    crc
}

fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x8005 } else { crc << 1 };
        }
    }
    crc
}

/// FLAC's UTF-8-like coding of the frame number.
fn utf8_number(v: u64, w: &mut BitWriter) {
    if v < 0x80 {
        w.put(v, 8);
        return;
    }
    // Total bytes: the first holds (7 - n) value bits, each following byte 6.
    let n: u32 = match v {
        _ if v < 1 << 11 => 2,
        _ if v < 1 << 16 => 3,
        _ if v < 1 << 21 => 4,
        _ if v < 1 << 26 => 5,
        _ if v < 1 << 31 => 6,
        _ => 7,
    };
    let lead = (0xff00u16 >> n) as u8 as u64; // n leading ones
    w.put(lead | (v >> (6 * (n - 1))), 8);
    for k in (0..n - 1).rev() {
        w.put(0x80 | ((v >> (6 * k)) & 0x3f), 8);
    }
}

/// Frame header sample rate: the 4-bit code, and the value written after the block
/// size for rates without a code of their own (the streamable subset never refers to
/// STREAMINFO for the rate).
fn rate_code(rate: u32) -> (u64, Option<(u64, u32)>) {
    let code = match rate {
        88200 => 0b0001,
        176400 => 0b0010,
        192000 => 0b0011,
        8000 => 0b0100,
        16000 => 0b0101,
        22050 => 0b0110,
        24000 => 0b0111,
        32000 => 0b1000,
        44100 => 0b1001,
        48000 => 0b1010,
        96000 => 0b1011,
        _ if rate % 1000 == 0 && rate / 1000 <= 255 => return (0b1100, Some(((rate / 1000) as u64, 8))),
        _ if rate <= 65535 => return (0b1101, Some((rate as u64, 16))),
        _ if rate % 10 == 0 && rate / 10 <= 65535 => return (0b1110, Some(((rate / 10) as u64, 16))),
        _ => 0b0000, // only STREAMINFO can hold it
    };
    (code, None)
}

fn bits_code(bits: u32) -> u64 {
    match bits {
        8 => 0b001,
        12 => 0b010,
        16 => 0b100,
        20 => 0b101,
        24 => 0b110,
        32 => 0b111,
        _ => 0b000, // from STREAMINFO
    }
}

/// One frame with VERBATIM subframes. `samples` is interleaved, `n` samples per channel.
fn write_frame(info: &StreamInfo, number: u64, samples: &[i32], n: usize) -> Vec<u8> {
    let mut w = BitWriter::new();
    w.put(0b11111111111110, 14); // sync
    w.put(0, 1); // reserved
    w.put(0, 1); // fixed block size
    w.put(0b0111, 4); // block size: 16 bits at the end of the header
    let (rate, rate_extra) = rate_code(info.sample_rate);
    w.put(rate, 4);
    w.put((info.channels - 1) as u64, 4); // independent channels
    w.put(bits_code(info.bits), 3);
    w.put(0, 1); // reserved
    utf8_number(number, &mut w);
    w.put((n - 1) as u64, 16);
    if let Some((value, bits)) = rate_extra {
        w.put(value, bits);
    }
    let crc = crc8(&w.out);
    w.put(crc as u64, 8);
    let ch = info.channels as usize;
    for c in 0..ch {
        w.put(0b0000_0010, 8); // padding 0, type VERBATIM (000001), no wasted bits
        for i in 0..n {
            w.put(samples[i * ch + c] as u32 as u64, info.bits);
        }
    }
    w.align();
    let crc = crc16(&w.out);
    w.put(crc as u64, 16);
    w.out
}

/// Rewrites `flac` (a FLAC file) in place with uncompressed frames. `pcm` is the raw
/// signed 32-bit little-endian interleaved audio of the same file (each sample's value
/// in the top bits, as FFmpeg's decoder outputs it).
pub fn rewrite_verbatim(flac: &Path, pcm: &Path) -> Result<(), String> {
    let (blocks, _) = read_blocks(&mut BufReader::new(File::open(flac).map_err(|e| e.to_string())?))?;
    let stream = blocks.first().filter(|b| b.kind == 0).ok_or("FLAC has no STREAMINFO")?;
    let info = parse_stream_info(&stream.data)?;
    if !(4..=32).contains(&info.bits) || info.channels == 0 {
        return Err(format!("unsupported FLAC format ({} bit, {} ch)", info.bits, info.channels));
    }
    let shift = 32 - info.bits;
    let ch = info.channels as usize;

    let tmp = flac.with_extension("verbatim.tmp");
    let result = (|| -> Result<(), String> {
        let mut reader = BufReader::new(File::open(pcm).map_err(|e| e.to_string())?);
        let mut frames = BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        let (mut min_frame, mut max_frame) = (u32::MAX, 0u32);
        let (mut total, mut number) = (0u64, 0u64);
        let mut raw = vec![0u8; BLOCK * ch * 4];
        let mut first_block = None;
        loop {
            let got = read_full(&mut reader, &mut raw).map_err(|e| e.to_string())?;
            let n = got / (4 * ch);
            if n == 0 {
                break;
            }
            let samples: Vec<i32> = raw[..n * ch * 4]
                .chunks_exact(4)
                .map(|b| i32::from_le_bytes(b.try_into().unwrap()) >> shift)
                .collect();
            let frame = write_frame(&info, number, &samples, n);
            min_frame = min_frame.min(frame.len() as u32);
            max_frame = max_frame.max(frame.len() as u32);
            first_block.get_or_insert(n);
            frames.write_all(&frame).map_err(|e| e.to_string())?;
            total += n as u64;
            number += 1;
            if n < BLOCK {
                break;
            }
        }
        frames.flush().map_err(|e| e.to_string())?;
        drop(frames);
        if info.total_samples != 0 && total != info.total_samples {
            return Err(format!("decoded {total} samples, FLAC header says {}", info.total_samples));
        }

        // STREAMINFO: block and frame sizes change; rate, channels, bits, total and MD5 do not.
        let mut si = stream.data.clone();
        let block = first_block.unwrap_or(BLOCK) as u16;
        si[0..2].copy_from_slice(&block.max(16).to_be_bytes());
        si[2..4].copy_from_slice(&block.max(16).to_be_bytes());
        let (min_frame, max_frame) = if total == 0 { (0, 0) } else { (min_frame, max_frame) };
        si[4..7].copy_from_slice(&min_frame.to_be_bytes()[1..]);
        si[7..10].copy_from_slice(&max_frame.to_be_bytes()[1..]);

        let kept: Vec<&Block> = blocks.iter().skip(1).filter(|b| b.kind != 3).collect();
        let out_path = flac.with_extension("verbatim.flac.tmp");
        let mut out = BufWriter::new(File::create(&out_path).map_err(|e| e.to_string())?);
        let mut head = b"fLaC".to_vec();
        let mut push_block = |kind: u8, data: &[u8], last: bool| {
            let len = data.len() as u32;
            head.push(kind | if last { 0x80 } else { 0 });
            head.extend_from_slice(&len.to_be_bytes()[1..]);
            head.extend_from_slice(data);
        };
        push_block(0, &si, kept.is_empty());
        for (i, b) in kept.iter().enumerate() {
            push_block(b.kind, &b.data, i + 1 == kept.len());
        }
        out.write_all(&head).map_err(|e| e.to_string())?;
        std::io::copy(&mut File::open(&tmp).map_err(|e| e.to_string())?, &mut out).map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        fs::rename(&out_path, flac).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(flac.with_extension("verbatim.flac.tmp"));
    result
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..])? {
            0 => break,
            k => got += k,
        }
    }
    Ok(got)
}

/// True if every subframe of the file's first frame is VERBATIM (used by the tests).
#[cfg(test)]
pub fn first_frame_is_verbatim(flac: &Path) -> Result<bool, String> {
    let bytes = fs::read(flac).map_err(|e| e.to_string())?;
    let (blocks, audio) = read_blocks(&mut &bytes[..])?;
    let info = parse_stream_info(&blocks[0].data)?;
    let frame = &bytes[audio..];
    // Header: 4 fixed bytes, the coded frame number, optional block size / rate bytes, CRC-8.
    let mut pos = 4;
    let lead = *frame.get(pos).ok_or("no frame")?;
    pos += (lead.leading_ones() as usize).max(1);
    let bs_code = frame[2] >> 4;
    if bs_code != 7 {
        return Ok(false);
    }
    let n = u16::from_be_bytes([frame[pos], frame[pos + 1]]) as usize + 1;
    pos += 2;
    pos += match frame[2] & 0x0f {
        12 => 1,
        13 | 14 => 2,
        _ => 0,
    };
    pos += 1; // CRC-8
    for _ in 0..info.channels {
        if frame.get(pos) != Some(&0b0000_0010) || info.bits % 8 != 0 {
            return Ok(false);
        }
        pos += 1 + n * info.bits as usize / 8;
    }
    Ok(true)
}
