import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { parseFile } from 'music-metadata';

export function safeFileName(name) {
  let value = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/g, '');
  if (!value) value = 'audio';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) value = `_${value}`;
  const ext = path.extname(value).slice(0, 16);
  // Leave room for collision suffixes and avoid splitting surrogate pairs.
  let stem = value.slice(0, value.length - path.extname(value).length);
  while (stem.length + ext.length > 180) stem = Array.from(stem).slice(0, -1).join('');
  return stem + ext;
}

export function checkCancelled(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Conversion cancelled'), { name: 'AbortError' });
}

function runProcess(executable, args, onStdout = undefined, signal = undefined) {
  return new Promise((resolve, reject) => {
    checkCancelled(signal);
    const child = spawn(executable, ['-nostdin', '-hide_banner', ...args], { windowsHide: true });
    const abort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-32768); });
    child.stdout.on('data', chunk => { if (onStdout) onStdout(chunk); });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) reject(Object.assign(new Error('Conversion cancelled'), { name: 'AbortError' }));
      else if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exit ${code}: ${stderr}`));
    });
  });
}

/** @param {string} executable @param {string[]} args @param {((chunk: Buffer) => void) | undefined} onStdout @param {AbortSignal | undefined} signal */
export async function runFFmpeg(executable, args, onStdout = undefined, signal = undefined) {
  let receivedOutput = false;
  const stdout = chunk => { receivedOutput = true; if (onStdout) onStdout(chunk); };
  try { return await runProcess(executable, args, stdout, signal); }
  catch (error) {
    checkCancelled(signal);
    const inputIndex = args.indexOf('-i') + 1;
    if (process.platform !== 'win32' || receivedOutput || !inputIndex || !/Error opening input|No such file or directory/.test(error.message)) throw error;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-input-'));
    try {
      const staged = path.join(directory, 'input' + path.extname(args[inputIndex]));
      await fs.copyFile(args[inputIndex], staged);
      const retry = [...args]; retry[inputIndex] = staged;
      checkCancelled(signal);
      return await runProcess(executable, retry, onStdout, signal);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
}

/** @param {string} executable @param {string} file @param {AbortSignal | undefined} signal */
export async function pcmFingerprint(executable, file, signal = undefined) {
  // f64 preserves all supported integer PCM bits and float32 samples, with no remix/resampling.
  const hash = createHash('sha256');
  let bytes = 0;
  await runFFmpeg(executable, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_f64le', '-f', 'f64le', '-'], chunk => {
    bytes += chunk.length;
    hash.update(chunk);
  }, signal);
  if (!bytes) throw new Error('Decoded audio is empty');
  return { hash: hash.digest('hex'), bytes };
}

export async function waveIsFloat(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (header.toString('ascii', 8, 12) !== 'WAVE') return false;
    const size = (await handle.stat()).size;
    for (let offset = 12; offset + 8 <= size;) {
      const chunk = Buffer.alloc(8); await handle.read(chunk, 0, 8, offset);
      const length = chunk.readUInt32LE(4);
      if (chunk.toString('ascii', 0, 4) === 'fmt ' && length >= 16) {
        const fmt = Buffer.alloc(Math.min(length, 40)); await handle.read(fmt, 0, fmt.length, offset + 8);
        const code = fmt.readUInt16LE(0);
        return code === 3 || (code === 65534 && fmt.length >= 40 && fmt.readUInt16LE(24) === 3);
      }
      offset += 8 + length + length % 2;
    }
    return false;
  } finally { await handle.close(); }
}

async function publishOutput(staging, destination, signal) {
  checkCancelled(signal);
  try { await fs.link(staging, destination); return; }
  catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) throw error;
  }
  // FAT/exFAT cannot hard-link. Exclusively create a new file and roll it back on failure.
  const output = await fs.open(destination, 'wx');
  let input;
  let complete = false;
  try {
    input = await fs.open(staging, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      checkCancelled(signal);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      for (let offset = 0; offset < bytesRead;) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
        if (!bytesWritten) throw new Error('Output write made no progress');
        offset += bytesWritten;
      }
    }
    await output.sync();
    checkCancelled(signal);
    complete = true;
  } finally {
    await input?.close();
    await output.close();
    if (!complete) await fs.unlink(destination).catch(() => {});
  }
}

// RIFF INFO text encoding is ambiguous for non-Latin tags. Use Unicode ID3v2.3 in WAV.
async function appendWavTags(file, tags) {
  const ids = { title: 'TIT2', artist: 'TPE1', album: 'TALB', albumArtist: 'TPE2', track: 'TRCK', disc: 'TPOS', year: 'TYER', genre: 'TCON' };
  const frames = [];
  for (const [key, id] of Object.entries(ids)) {
    if (!tags[key]) continue;
    const body = Buffer.concat([Buffer.from([1, 255, 254]), Buffer.from(tags[key], 'utf16le')]);
    const header = Buffer.alloc(10); header.write(id); header.writeUInt32BE(body.length, 4);
    frames.push(header, body);
  }
  if (tags.comment) {
    const text = Buffer.concat([Buffer.from([1]), Buffer.from('eng'), Buffer.from([255, 254, 0, 0, 255, 254]), Buffer.from(tags.comment, 'utf16le')]);
    const header = Buffer.alloc(10); header.write('COMM'); header.writeUInt32BE(text.length, 4); frames.push(header, text);
  }
  const body = Buffer.concat(frames);
  if (!body.length) return;
  const header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) header[9 - i] = (body.length >>> (7 * i)) & 127;
  const id3 = Buffer.concat([header, body]);
  const chunk = Buffer.alloc(8); chunk.write('id3 '); chunk.writeUInt32LE(id3.length, 4);
  const handle = await fs.open(file, 'r+');
  try {
    const { size } = await handle.stat();
    const tail = Buffer.concat([chunk, id3, ...(id3.length % 2 ? [Buffer.alloc(1)] : [])]);
    if (size + tail.length - 8 > 0xffffffff) throw new Error('WAV exceeds RIFF size limit');
    await handle.write(tail, 0, tail.length, size);
    const length = Buffer.alloc(4); length.writeUInt32LE(size + tail.length - 8);
    await handle.write(length, 0, 4, 4);
  } finally { await handle.close(); }
}

/** @param {string} executable @param {any} request @param {any} source */
export async function convertAudio(executable, request, source, options = {}) {
  const { signal, onProgress } = options;
  checkCancelled(signal);
  const progressReader = phase => {
    let pending = '';
    return chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('out_time_us=') && source.duration > 0) {
          const seconds = Number(line.slice(12)) / 1000000;
          if (Number.isFinite(seconds)) onProgress?.({ phase, progress: Math.max(0, Math.min(99, seconds / source.duration * 100)) });
        }
      }
    };
  };
  const { inputFilePath, settings, outputFormat } = request;
  const tags = { ...source.tags, ...request.tags };
  const format = outputFormat.toUpperCase();
  const ext = { WAV: 'wav', AIFF: 'aiff', FLAC: 'flac', ALAC: 'm4a', M4A: 'm4a', MP3: 'mp3', OGG: 'ogg', OPUS: 'opus', AC3: 'ac3', WMA: 'wma', WAVPACK: 'wv' }[format];
  if (!ext) throw new Error(`Unsupported output format: ${format}`);
  const name = safeFileName(request.fileName.replace(/\.[^.]*$/, '') + '.' + ext);
  const targetDir = settings.saveInSourceFolder ? path.dirname(inputFilePath) : settings.localSavePath;
  await fs.mkdir(targetDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-convert-'));
  const tempOutput = path.join(workDir, `output.${ext}`);
  let staging;
  try {
    const args = ['-y', '-i', inputFilePath, '-map', '0:a:0', '-map_metadata', format === 'WAV' ? '-1' : '0'];
    if (['MP3', 'FLAC', 'M4A', 'ALAC'].includes(format) && source.hasArt) {
      args.push('-map', '0:v:0?', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
    }
    const depth = settings.sameAsSource ? (source.bitsPerSample || (source.lossless === false ? 24 : undefined)) : Number(settings.bitDepth);
    if (['WAV', 'AIFF', 'FLAC', 'ALAC', 'WAVPACK'].includes(format) && (!depth || ![8, 16, 24, 32, 64].includes(depth))) {
      throw new Error('Cannot determine a supported source bit depth');
    }
    if ((settings.sameAsSource && ['FLAC', 'ALAC'].includes(format) && source.isFloat) || (format === 'ALAC' && depth > 24) || (format === 'FLAC' && depth > 32) || (settings.sameAsSource && format === 'WAVPACK' && depth > 32)) {
      throw new Error(`${format} cannot preserve this source PCM precision; choose WAV or explicit conversion settings`);
    }
    const filters = [];
    if (!settings.sameAsSource) {
      if (settings.trimSilence) filters.push(`silenceremove=start_periods=1:start_duration=0:start_threshold=${settings.trimSilenceThresholdDb}dB:detection=peak:window=0.001`, 'areverse', `silenceremove=start_periods=1:start_duration=0:start_threshold=${settings.trimSilenceThresholdDb}dB:detection=peak:window=0.001`, 'areverse');
      if (settings.normalize) {
        onProgress?.({ phase: 'normalizing', progress: 0 });
        const log = await runFFmpeg(executable, ['-i', inputFilePath, '-map', '0:a:0', ...(filters.length ? ['-af', filters.join(',') + ',volumedetect'] : ['-af', 'volumedetect']), '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'], progressReader('normalizing'), signal);
        const peak = log.match(/max_volume:\s*(-?[\d.]+|inf|-inf) dB/);
        if (!peak) throw new Error('Peak normalization analysis failed');
        const gain = settings.normalizationTargetDb - Number(peak[1]);
        if (Number.isFinite(gain)) filters.push(`volume=${gain}dB`);
      } else if (settings.volumeBoostDb) filters.push(`volume=${settings.volumeBoostDb}dB`);
      args.push('-ar', String(settings.sampleRate), '-ac', String(settings.channels));
    }
    if (settings.sameAsSource) {
      if (source.sampleRate) args.push('-ar', String(source.sampleRate));
      if (source.channels) args.push('-ac', String(source.channels));
    }
    if (filters.length) args.push('-af', filters.join(','));
    const pcm = source.isFloat && settings.sameAsSource ? `pcm_f${depth}${format === 'AIFF' ? 'be' : 'le'}` : `pcm_${depth === 8 ? (format === 'AIFF' ? 's8' : 'u8') : `s${depth}${format === 'AIFF' ? 'be' : 'le'}`}`;
    const codecs = { WAV: pcm, AIFF: pcm, FLAC: 'flac', ALAC: 'alac', WAVPACK: 'wavpack', MP3: 'libmp3lame', M4A: 'aac', OGG: 'libvorbis', OPUS: 'libopus', AC3: 'ac3', WMA: 'wmav2' };
    args.push('-c:a', codecs[format], '-threads', String(Math.max(1, Math.min(16, settings.threadPoolSize || 1))));
    if (['FLAC', 'ALAC', 'WAVPACK'].includes(format)) args.push('-sample_fmt', format === 'WAVPACK' && source.isFloat && settings.sameAsSource ? 'fltp' : (depth > 16 ? 's32' : 's16') + (['ALAC', 'WAVPACK'].includes(format) ? 'p' : ''), '-bits_per_raw_sample', String(depth));
    if (['MP3', 'M4A', 'OGG', 'OPUS', 'AC3', 'WMA'].includes(format)) args.push('-b:a', `${settings.bitrate}k`);
    const tagKeys = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist', track: 'track', disc: 'disc', year: 'date', genre: 'genre', comment: 'comment' };
    for (const [key, ffKey] of Object.entries(tagKeys)) {
      if (format !== 'WAV' && typeof tags[key] === 'string') args.push('-metadata', `${ffKey}=${tags[key]}`);
    }
    args.push('-progress', 'pipe:1', '-nostats', tempOutput);
    onProgress?.({ phase: 'converting', progress: 0 });
    await runFFmpeg(executable, args, progressReader('converting'), signal);
    checkCancelled(signal);
    if (format === 'WAV') await appendWavTags(tempOutput, tags);
    const encoded = await parseFile(tempOutput);
    if (settings.sameAsSource && ((source.sampleRate && encoded.format.sampleRate !== source.sampleRate) || (source.channels && encoded.format.numberOfChannels !== source.channels) || (source.bitsPerSample && ['WAV', 'AIFF', 'FLAC', 'ALAC', 'WAVPACK'].includes(format) && encoded.format.bitsPerSample !== source.bitsPerSample))) {
      throw new Error('Output format cannot preserve the requested source audio structure or bit depth');
    }
    const stat = await fs.stat(tempOutput);
    checkCancelled(signal);
    if (!stat.size) throw new Error('FFmpeg produced an empty file');
    // Publish only a complete file. link is atomic and refuses existing destinations.
    staging = path.join(targetDir, `.audio-convert-${randomUUID()}.tmp`);
    await fs.copyFile(tempOutput, staging, fs.constants.COPYFILE_EXCL);
    const base = name.slice(0, -ext.length - 1);
    for (let i = 0; i < 10000; i++) {
      const destination = path.join(targetDir, i ? `${base} (${i}).${ext}` : name);
      try {
        checkCancelled(signal);
        await publishOutput(staging, destination, signal);
        return { path: destination, fileName: path.basename(destination) };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Too many output filename collisions');
  } catch (error) {
    throw new Error(`Conversion failed (input=${inputFilePath}, output=${path.join(targetDir, name)}, pathLength=${path.join(targetDir, name).length}): ${error.message}`);
  } finally {
    if (staging) await fs.unlink(staging).catch(() => {});
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
