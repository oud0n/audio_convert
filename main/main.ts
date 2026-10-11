import path from 'path'
import { app, ipcMain, dialog, BrowserWindow, shell } from 'electron'
import serve from 'electron-serve'
import { createWindow } from './helpers/create-window'

const isProd = process.env.NODE_ENV === 'production'

if (isProd) {
  serve({ directory: 'app' })
} else {
  app.setPath('userData', `${app.getPath('userData')} (development)`)
}

;(async () => {
  await app.whenReady()

  const mainWindow = createWindow('main', {
    width: 1000,
    height: 600,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
    },
  })

  if (isProd) {
    await mainWindow.loadURL('app://./home')
  } else {
    const port = process.argv[2]
    await mainWindow.loadURL(`http://localhost:${port}/home`)
    mainWindow.webContents.openDevTools()
  }
})()

import fs from 'fs'
import os from 'os'
import ffmpegPath from 'ffmpeg-static'
import { parseFile } from 'music-metadata'
import { convertAudio, pcmFingerprint, runFFmpeg, waveIsFloat, checkCancelled } from './helpers/audio-pipeline.mjs'

const conversionJobs = new Map<string, AbortController>();
const jobKey = (sender: number, id: string) => `${sender}:${id}`;
function jobSignal(sender: number, id?: string) {
  if (!id) return undefined;
  const job = conversionJobs.get(jobKey(sender, id));
  if (!job) throw new Error('Conversion job missing');
  checkCancelled(job.signal);
  return job.signal;
}
ipcMain.handle('start-conversion-job', (event, id: string) => {
  const key = jobKey(event.sender.id, id);
  if (conversionJobs.has(key)) throw new Error('Duplicate conversion job');
  conversionJobs.set(key, new AbortController());
});
ipcMain.handle('cancel-conversion-job', (event, id: string) => {
  conversionJobs.get(jobKey(event.sender.id, id))?.abort();
});
ipcMain.handle('finish-conversion-job', (event, id: string) => {
  conversionJobs.delete(jobKey(event.sender.id, id));
});
app.on('web-contents-created', (_event, contents) => {
  contents.once('destroyed', () => {
    for (const [key, controller] of conversionJobs) {
      if (key.startsWith(`${contents.id}:`)) { controller.abort(); conversionJobs.delete(key); }
    }
  });
});

app.on('window-all-closed', () => {
  app.quit()
})

ipcMain.on('message', async (event, arg) => {
  event.reply('message', `${arg} World!`)
})

// IPC Handler to debug logs from renderer or main
ipcMain.on('log-debug', (event, arg) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [RENDERER] ${arg}\n`);
  } catch (e) {}
});

// Helper to get usable FFmpeg binary path (handles app.asar unpacking and dev paths)
function getExecutableFFmpegPath(): string | null {
  if (ffmpegPath && typeof ffmpegPath === 'string') {
    let resolved = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  const devPath = path.join(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  return ffmpegPath || null;
}

// IPC Handler to decode any audio file (ALAC, AAC, etc.) to PCM WAV via FFmpeg
ipcMain.handle('decode-audio-to-wav', async (_event, filePath: string) => {
  const temp = await decodeToTempWav(filePath);
  try { return await fs.promises.readFile(temp); }
  finally { await fs.promises.unlink(temp).catch(() => {}); }
});

// IPC Handler to extract detailed metadata (duration, title, artist, etc.) using music-metadata
ipcMain.handle('read-audio-metadata', async (_event, filePath: string) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [MAIN] read-audio-metadata called. File: "${filePath}"\n`);
  } catch (e) {}

  try {
    const metadata = await parseFile(filePath);
    return {
      success: true,
      format: {
        duration: metadata.format.duration || 0,
        sampleRate: metadata.format.sampleRate || 44100,
        numberOfChannels: metadata.format.numberOfChannels || 2,
        bitrate: metadata.format.bitrate || 128000,
      },
      tags: {
        title: metadata.common.title || '',
        artist: metadata.common.artist || '',
        album: metadata.common.album || '',
        albumArtist: metadata.common.albumartist || '',
        disc: metadata.common.disk.no ? metadata.common.disk.no.toString() : '1',
        year: metadata.common.year?.toString() || '',
        genre: metadata.common.genre?.join(', ') || '',
        track: metadata.common.track.no ? metadata.common.track.no.toString().padStart(2, '0') : '01',
        comment: metadata.common.comment?.map(value => value.text).join('\n') || '',
      }
    };
  } catch (err: any) {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [MAIN] Metadata error: ${err.message}\n`); } catch (e) {}
    return {
      success: false,
      error: err.message || 'Failed to parse metadata'
    };
  }
});

// IPC Handler to open directory selection dialog
ipcMain.handle('select-directory', async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const options = { properties: ['openDirectory'] as Array<'openDirectory'> };
  const result = focusedWindow ? await dialog.showOpenDialog(focusedWindow, options) : await dialog.showOpenDialog(options);
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});

// IPC Handler to retrieve the OS-specific default home folder save path
ipcMain.handle('get-default-save-path', () => {
  const home = app.getPath('home');
  return path.join(home, 'Music', 'Audio-Convert-Outputs');
});

// IPC Handler to write a converted ArrayBuffer directly to target disk (with FFmpeg compression and tag embedding)
ipcMain.handle('save-converted-file', async (event, request) => {
  try {
    const signal = jobSignal(event.sender.id, request.jobId);
    const metadata = await parseFile(request.inputFilePath);
    const result = await convertAudio(getExecutableFFmpegPath() || 'ffmpeg', request, {
      bitsPerSample: metadata.format.bitsPerSample,
      duration: metadata.format.duration,
      sampleRate: metadata.format.sampleRate, channels: metadata.format.numberOfChannels, lossless: metadata.format.lossless,
      isFloat: /FLOAT|IEEE|pcm_f/i.test(metadata.format.codec || '') || (metadata.format.container === 'WAVE' && await waveIsFloat(request.inputFilePath)),
      hasArt: !!metadata.common.picture?.length,
      tags: { title: metadata.common.title || '', artist: metadata.common.artist || '', album: metadata.common.album || '', albumArtist: metadata.common.albumartist || '', track: metadata.common.track.no?.toString() || '', disc: metadata.common.disk.no?.toString() || '', year: metadata.common.year?.toString() || '', genre: metadata.common.genre?.join(', ') || '', comment: metadata.common.comment?.map(value => value.text).join('\n') || '' },
    }, { signal, onProgress: (progress: { phase: string; progress: number }) => {
      if (!event.sender.isDestroyed()) event.sender.send('conversion-progress', { jobId: request.jobId, ...progress });
    } });
    return { success: true, ...result };
  } catch (err: any) {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] ${err.stack || err.message}\n`); } catch {}
    return { success: false, error: err.message };
  }
});

// Preview is decoded from the actual output, not from an intermediate browser buffer.
ipcMain.handle('read-output-preview', async (event, filePath: string, jobId?: string) => {
  const temp = await decodeToTempWav(filePath, jobSignal(event.sender.id, jobId));
  try { return await fs.promises.readFile(temp); }
  finally { await fs.promises.unlink(temp).catch(() => {}); }
});

// IPC Handler to safely move an original source track to OS recycle bin
ipcMain.handle('trash-file', async (event, filePath: string, jobId?: string) => {
  try {
    jobSignal(event.sender.id, jobId);
    await shell.trashItem(filePath);
    return { success: true };
  } catch (err: any) {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [MAIN] Error trashing file "${filePath}": ${err.message}\n`);
    } catch (e) {}
    return { success: false, error: err.message };
  }
});

// IPC Handler to load settings.json from userData (with cwd fallback for dev)
ipcMain.handle('load-settings-file', async () => {
  const userSettingsPath = path.join(app.getPath('userData'), 'settings.json');
  const cwdSettingsPath = path.join(process.cwd(), 'settings.json');
  const targetPath = fs.existsSync(userSettingsPath) ? userSettingsPath : (fs.existsSync(cwdSettingsPath) ? cwdSettingsPath : null);
  try {
    if (targetPath) {
      const data = await fs.promises.readFile(targetPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err: any) {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [MAIN] Error loading settings.json: ${err.message}\n`);
    } catch (e) {}
  }
  return null;
});

// IPC Handler to save settings.json to userData directory
ipcMain.handle('save-settings-file', async (_event, payload) => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    await fs.promises.writeFile(settingsPath, JSON.stringify(payload, null, 2), 'utf-8');
    return { success: true };
  } catch (err: any) {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [MAIN] Error saving settings.json: ${err.message}\n`);
    } catch (e) {}
    return { success: false, error: err.message };
  }
});

// Helper to compute raw PCM SHA-256 hash via FFmpeg
async function computePcmFingerprint(filePath: string, signal?: AbortSignal) {
  const metadata = await parseFile(filePath);
  const fingerprint = await pcmFingerprint(getExecutableFFmpegPath() || 'ffmpeg', filePath, signal);
  return { ...fingerprint, sampleRate: metadata.format.sampleRate, channels: metadata.format.numberOfChannels };
}

async function decodeToTempWav(filePath: string, signal?: AbortSignal, sampleRate?: number): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audio-preview-'));
  const tempPath = path.join(directory, 'preview.wav');
  try {
    const args = ['-y', '-i', filePath, '-map', '0:a:0', '-acodec', 'pcm_s16le', '-ac', '2'];
    if (sampleRate) args.push('-ar', String(sampleRate));
    args.push('-map_metadata', '-1', tempPath);
    await runFFmpeg(getExecutableFFmpegPath() || 'ffmpeg', args, undefined, signal);
    // Move out of the working directory so existing callers can unlink the file.
    const result = path.join(os.tmpdir(), `preview_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
    await fs.promises.rename(tempPath, result);
    return result;
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

// Helper to extract PCM Int16Array from a WAV Buffer by finding the 'data' chunk marker
function extractPcmFromWavBuffer(buf: Buffer): Int16Array {
  for (let offset = 12; offset + 8 <= buf.length;) {
    const length = buf.readUInt32LE(offset + 4);
    if (buf.toString('ascii', offset, offset + 4) === 'data') {
      const end = Math.min(buf.length, offset + 8 + length);
      const samples = new Int16Array(Math.floor((end - offset - 8) / 2));
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(offset + 8 + i * 2);
      return samples;
    }
    offset += 8 + length + (length % 2);
  }
  throw new Error('WAV data chunk missing');
}

// Helper to compare two WAV files sample by sample
async function compareWavBuffers(path1: string, path2: string) {
  const buf1 = await fs.promises.readFile(path1);
  const buf2 = await fs.promises.readFile(path2);

  const pcm1 = extractPcmFromWavBuffer(buf1);
  const pcm2 = extractPcmFromWavBuffer(buf2);

  const minLen = Math.min(pcm1.length, pcm2.length);
  if (minLen === 0) {
    throw new Error('Cannot compare empty audio');
  }

  let maxDiff = 0;
  let sumSqDiff = 0;
  let sumSq1 = 0;
  let sumSq2 = 0;
  let dotProd = 0;

  const startSample = Math.min(250, Math.floor(minLen * 0.005));
  const step = Math.max(1, Math.floor((minLen - startSample) / 500000));
  let count = 0;

  for (let i = startSample; i < minLen; i += step) {
    const s1 = pcm1[i];
    const s2 = pcm2[i];
    const diff = Math.abs(s1 - s2);

    if (diff > maxDiff) maxDiff = diff;
    sumSqDiff += diff * diff;
    sumSq1 += s1 * s1;
    sumSq2 += s2 * s2;
    dotProd += s1 * s2;
    count++;
  }

  const mse = sumSqDiff / count;
  const sigPow1 = sumSq1 / count;
  const sigPow2 = sumSq2 / count;

  let snrDb = 100;
  if (mse > 0 && sigPow1 > 0) {
    snrDb = Math.round((10 * Math.log10(sigPow1 / mse)) * 10) / 10;
  } else if (sigPow1 === 0 && mse > 0) {
    snrDb = -100;
  }

  let maxDiffDb = -100;
  if (maxDiff > 0) {
    maxDiffDb = Math.round((20 * Math.log10(maxDiff / 32768)) * 10) / 10;
  }

  const denom = Math.sqrt(sigPow1 * sigPow2);
  let correlation = 0.0;
  if (sigPow1 === 0 && sigPow2 === 0) {
    correlation = 1.0;
    snrDb = 100;
  } else if (sigPow1 === 0 || sigPow2 === 0) {
    correlation = 0.0;
    snrDb = -100;
  } else if (denom > 0) {
    correlation = (dotProd / count) / denom;
  }
  const correlationPercent = Math.max(0, Math.min(100, Math.round(correlation * 10000) / 100));

  return { maxDiffDb, snrDb, correlationPercent };
}

// IPC Handler to run quality verification (SHA-256 hash match & PCM waveform diff analysis)
ipcMain.handle('verify-audio-quality', async (event, { originalPath, convertedPath, isLosslessPair, jobId }) => {
  const verifiedAt = new Date().toLocaleTimeString();
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [MAIN] verify-audio-quality called.\n  Original: "${originalPath}"\n  Converted: "${convertedPath}"\n`);
  } catch (e) {}

  if (!originalPath || !convertedPath || !fs.existsSync(originalPath) || !fs.existsSync(convertedPath)) {
    return {
      success: false,
      error: 'Original or converted file path is invalid or missing.'
    };
  }

  try {
    // 1. Calculate PCM SHA-256 Hash for both files
    const signal = jobSignal(event.sender.id, jobId);
    const [original, converted] = await Promise.all([
      computePcmFingerprint(originalPath, signal), computePcmFingerprint(convertedPath, signal)
    ]);
    const originalHash = original.hash;
    const convertedHash = converted.hash;
    const structureMatch = original.sampleRate === converted.sampleRate && original.channels === converted.channels && original.bytes === converted.bytes;
    const exactMatch = structureMatch && originalHash === convertedHash;

    if (exactMatch) {
      return {
        success: true,
        result: {
          verifiedAt,
          isLosslessPair: true,
          exactMatch: true,
          originalHash,
          convertedHash,
          snrDb: 100,
          maxDiffDb: -100,
          correlationPercent: 100,
          hasHighFreqCutoff: false,
          status: 'perfect',
          summaryMessage: 'PCM完全一致 (サンプル値・音声構成が一致)',
          details: [
            `元のPCM SHA-256: ${originalHash}`,
            `変換後PCM SHA-256: ${convertedHash}`,
            `ハッシュ比較結果: 完全に一致 (Bit-exact match)`,
            `元の精度を保持したPCMサンプル値と音声構成が一致しています。`
          ]
        }
      };
    }

    // 2. Perform PCM Diff Analysis (Decode both to temp WAV)
    let tempWavOrig = '';
    let tempWavConv = '';
    let diffMetrics: { maxDiffDb: number; snrDb: number; correlationPercent: number };
    if (!structureMatch && isLosslessPair) {
      return {
        success: true,
        result: {
          verifiedAt,
          isLosslessPair: true,
          exactMatch: false,
          status: 'warning',
          originalHash,
          convertedHash,
          hasHighFreqCutoff: false,
          summaryMessage: '可逆変換ですが音声構成またはサンプル数が異なります。完全一致ではありません。',
          details: [
            `Source: ${original.sampleRate}Hz / ${original.channels}ch / ${original.bytes} bytes`,
            `Output: ${converted.sampleRate}Hz / ${converted.channels}ch / ${converted.bytes} bytes`
          ]
        }
      };
    }
    let cutoffInfo = { hasCutoff: false, freqHz: undefined as number | undefined };

    try {
      // Sequential assignment ensures cleanup if the second decode fails.
      const compareRate = Math.min(original.sampleRate || 44100, converted.sampleRate || 44100);
      tempWavOrig = await decodeToTempWav(originalPath, signal, compareRate);
      tempWavConv = await decodeToTempWav(convertedPath, signal, compareRate);

      diffMetrics = await compareWavBuffers(tempWavOrig, tempWavConv);
      // Spectral cutoff is not measured by PCM comparison. Do not claim a detection.
      cutoffInfo = { hasCutoff: false, freqHz: undefined };
    } catch (diffErr: any) {
      throw new Error(`Quality analysis failed: ${diffErr.message}`);
    } finally {
      if (tempWavOrig && fs.existsSync(tempWavOrig)) {
        try { await fs.promises.unlink(tempWavOrig); } catch (e) {}
      }
      if (tempWavConv && fs.existsSync(tempWavConv)) {
        try { await fs.promises.unlink(tempWavConv); } catch (e) {}
      }
    }

    // Determine status & summary
    let status: 'perfect' | 'passed' | 'warning' | 'degraded' = 'passed';
    let summaryMessage = '品質良好 (非可逆圧縮による変化を検出)';

    if (diffMetrics.correlationPercent >= 99.0 && diffMetrics.snrDb >= 30) {
      if (isLosslessPair) {
        status = 'warning';
        summaryMessage = `波形は類似していますがPCMは一致しません (波形類似度 ${diffMetrics.correlationPercent}%)`;
      } else if (cutoffInfo.hasCutoff) {
        status = 'passed';
        summaryMessage = `品質正常 (非可逆圧縮による高域カット ~${(cutoffInfo.freqHz || 16000) / 1000}kHz 検出)`;
      } else {
        status = 'passed';
        summaryMessage = `品質良好 (波形類似度: ${diffMetrics.correlationPercent}%)`;
      }
    } else if (diffMetrics.correlationPercent >= 90.0) {
      status = 'warning';
      summaryMessage = `音質変化あり (波形類似度: ${diffMetrics.correlationPercent}%, S/N比: ${diffMetrics.snrDb}dB)`;
    } else {
      status = 'degraded';
      summaryMessage = `大幅な音質変化/データ欠損の可能性 (波形類似度: ${diffMetrics.correlationPercent}%)`;
    }

    const details = [
      `元のPCM SHA-256: ${originalHash || 'N/A'}`,
      `変換後PCM SHA-256: ${convertedHash || 'N/A'}`,
      `波形類似度 (相関率): ${diffMetrics.correlationPercent}%`,
      `S/N比 (Signal-to-Noise Ratio): ${diffMetrics.snrDb} dB`,
      `最大波形差分ピーク: ${diffMetrics.maxDiffDb} dB`,
      cutoffInfo.hasCutoff
        ? `高周波カットオフ: 検出あり (~${(cutoffInfo.freqHz || 16000) / 1000}kHz 以上の帯域カット)`
        : `高周波カットオフ: 未測定`
    ];

    return {
      success: true,
      result: {
        verifiedAt,
        isLosslessPair: !!isLosslessPair,
        exactMatch: false,
        originalHash,
        convertedHash,
        snrDb: diffMetrics.snrDb,
        maxDiffDb: diffMetrics.maxDiffDb,
        correlationPercent: diffMetrics.correlationPercent,
        hasHighFreqCutoff: cutoffInfo.hasCutoff,
        cutoffFreqHz: cutoffInfo.freqHz,
        status,
        summaryMessage,
        details
      }
    };
  } catch (err: any) {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug_ipc.log'), `[${new Date().toISOString()}] [MAIN] Quality verification exception: ${err.message}\n`); } catch (e) {}
    return {
      success: false,
      error: err.message || 'Failed to verify quality'
    };
  }
});
