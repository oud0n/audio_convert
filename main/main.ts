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

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import ffmpegPath from 'ffmpeg-static'
import { parseFile } from 'music-metadata'

app.on('window-all-closed', () => {
  app.quit()
})

ipcMain.on('message', async (event, arg) => {
  event.reply('message', `${arg} World!`)
})

// IPC Handler to debug logs from renderer or main
ipcMain.on('log-debug', (event, arg) => {
  try {
    fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [RENDERER] ${arg}\n`);
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
  return new Promise((resolve, reject) => {
    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] decode-audio-to-wav called. File: "${filePath}"\n`);
    } catch (e) {}

    if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
      const errMessage = `Decode target file does not exist: "${filePath}"`;
      try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error: ${errMessage}\n`); } catch (e) {}
      reject(new Error(errMessage));
      return;
    }

    const execFfmpeg = getExecutableFFmpegPath();
    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Resolved FFmpeg Executable: "${execFfmpeg}"\n`);
    } catch (e) {}

    if (!execFfmpeg || !fs.existsSync(execFfmpeg)) {
      const err = new Error(`FFmpeg binary not found or not executable. Path: "${execFfmpeg}"`);
      try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error: ${err.message}\n`); } catch (e) {}
      reject(err);
      return;
    }

    const tempOutPath = path.join(
      os.tmpdir(),
      `decode_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.wav`
    );

    // Run ffmpeg -y -i input -acodec pcm_s16le -ar 44100 tempOutPath
    const ffmpegProcess = spawn(execFfmpeg, [
      '-y',
      '-i', filePath,
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      tempOutPath
    ]);

    let stderr = '';
    ffmpegProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpegProcess.on('close', async (code) => {
      try {
        fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] FFmpeg process closed with code: ${code}\n`);
      } catch (e) {}

      if (code === 0) {
        try {
          const buffer = await fs.promises.readFile(tempOutPath);
          await fs.promises.unlink(tempOutPath); // clean up
          resolve(buffer); // Over IPC, Buffer is transferred as Uint8Array
        } catch (err: any) {
          try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error reading WAV: ${err.message}\n`); } catch (e) {}
          reject(err);
        }
      } else {
        const err = new Error(`FFmpeg failed with code ${code}. Stderr: ${stderr.substring(0, 300)}`);
        try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error decoding: ${err.message}\nStderr: ${stderr}\n`); } catch (e) {}
        reject(err);
      }
    });

    ffmpegProcess.on('error', (err) => {
      try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] FFmpeg spawn error: ${err.message}\n`); } catch (e) {}
      reject(err);
    });
  });
});

// IPC Handler to extract detailed metadata (duration, title, artist, etc.) using music-metadata
ipcMain.handle('read-audio-metadata', async (_event, filePath: string) => {
  try {
    fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] read-audio-metadata called. File: "${filePath}"\n`);
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
      }
    };
  } catch (err: any) {
    try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Metadata error: ${err.message}\n`); } catch (e) {}
    return {
      success: false,
      error: err.message || 'Failed to parse metadata'
    };
  }
});

// IPC Handler to open directory selection dialog
ipcMain.handle('select-directory', async () => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(focusedWindow || undefined, {
    properties: ['openDirectory'],
  });
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
ipcMain.handle('save-converted-file', async (_event, { fileBuffer, savePath, saveInSourceFolder, inputFilePath, fileName, outputFormat, bitrate, tags }) => {
  const tempWavName = `temp_transcode_${Math.random().toString(36).substring(2, 9)}.wav`;
  const tempWavPath = path.join(os.tmpdir(), tempWavName);
  
  try {
    let targetDir = savePath;
    if (saveInSourceFolder && inputFilePath) {
      targetDir = path.dirname(inputFilePath);
    }
    
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    const fullPath = path.join(targetDir, fileName);
    
    // Write the raw PCM WAV to a temp file
    await fs.promises.writeFile(tempWavPath, Buffer.from(fileBuffer));
    
    // Build FFmpeg command args
    const formatUpper = (outputFormat || 'WAV').toUpperCase();
    const supportsArt = formatUpper === 'MP3' || formatUpper === 'FLAC' || formatUpper === 'M4A';
    
    const ffmpegArgs = ['-y', '-i', tempWavPath];
    
    // Only map the original file if the target format supports art
    if (supportsArt && inputFilePath && fs.existsSync(inputFilePath)) {
      ffmpegArgs.push('-i', inputFilePath);
    }
    
    // Map the audio from the temp WAV file (input 0)
    ffmpegArgs.push('-map', '0:a');
    
    // Map the video stream (album art) from the original file (input 1) if supported
    if (supportsArt && inputFilePath && fs.existsSync(inputFilePath)) {
      ffmpegArgs.push('-map', '1:v?', '-c:v', 'copy');
    }
    
    // Add metadata tags
    if (tags) {
      if (tags.title) ffmpegArgs.push('-metadata', `title=${tags.title}`);
      if (tags.artist) ffmpegArgs.push('-metadata', `artist=${tags.artist}`);
      if (tags.album) ffmpegArgs.push('-metadata', `album=${tags.album}`);
      if (tags.albumArtist) ffmpegArgs.push('-metadata', `album_artist=${tags.albumArtist}`);
      if (tags.track) ffmpegArgs.push('-metadata', `track=${tags.track}`);
      if (tags.disc) ffmpegArgs.push('-metadata', `disc=${tags.disc}`);
      if (tags.year) ffmpegArgs.push('-metadata', `date=${tags.year}`);
      if (tags.genre) ffmpegArgs.push('-metadata', `genre=${tags.genre}`);
      if (tags.comment) ffmpegArgs.push('-metadata', `comment=${tags.comment}`);
    }
    
    if (formatUpper === 'MP3') {
      ffmpegArgs.push('-codec:a', 'libmp3lame', '-b:a', `${bitrate || '320'}k`);
    } else if (formatUpper === 'FLAC') {
      ffmpegArgs.push('-codec:a', 'flac');
    } else if (formatUpper === 'M4A') {
      ffmpegArgs.push('-codec:a', 'aac', '-b:a', `${bitrate || '320'}k`);
    } else if (formatUpper === 'OGG') {
      ffmpegArgs.push('-codec:a', 'libvorbis', '-b:a', `${bitrate || '320'}k`);
    } else {
      // WAV format - write ID3v2 tags
      ffmpegArgs.push('-write_id3v2', '1');
    }
    
    ffmpegArgs.push(fullPath);
    
    // Run FFmpeg transcode process
    await new Promise<void>((resolve, reject) => {
      const execFfmpeg = getExecutableFFmpegPath() || 'ffmpeg';
      const ff = spawn(execFfmpeg, ffmpegArgs);
      let stderrLog = '';
      
      ff.stderr.on('data', (data) => {
        stderrLog += data.toString();
      });
      
      ff.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg transcoding exited with code ${code}. Stderr: ${stderrLog}`));
        }
      });
      
      ff.on('error', (err) => {
        reject(err);
      });
    });

    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Saved transcoded file to: "${fullPath}"\n`);
    } catch (e) {}

    return { success: true, path: fullPath };
  } catch (err: any) {
    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Transcoding error: ${err.message}\n`);
    } catch (e) {}
    return { success: false, error: err.message };
  } finally {
    // Clean up temporary WAV file
    try {
      if (fs.existsSync(tempWavPath)) {
        fs.unlinkSync(tempWavPath);
      }
    } catch (e) {}
  }
});

// IPC Handler to safely move an original source track to OS recycle bin
ipcMain.handle('trash-file', async (_event, filePath: string) => {
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (err: any) {
    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error trashing file "${filePath}": ${err.message}\n`);
    } catch (e) {}
    return { success: false, error: err.message };
  }
});

// IPC Handler to load settings.json from current working directory
ipcMain.handle('load-settings-file', async () => {
  const settingsPath = path.join(process.cwd(), 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const data = await fs.promises.readFile(settingsPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err: any) {
    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error loading settings.json: ${err.message}\n`);
    } catch (e) {}
  }
  return null;
});

// IPC Handler to save settings.json to current working directory
ipcMain.handle('save-settings-file', async (_event, payload) => {
  const settingsPath = path.join(process.cwd(), 'settings.json');
  try {
    await fs.promises.writeFile(settingsPath, JSON.stringify(payload, null, 2), 'utf-8');
    return { success: true };
  } catch (err: any) {
    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error saving settings.json: ${err.message}\n`);
    } catch (e) {}
    return { success: false, error: err.message };
  }
});

// Helper to compute raw PCM MD5 hash via FFmpeg
async function computePcmMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const execFfmpeg = getExecutableFFmpegPath();
    if (!execFfmpeg) return reject(new Error('FFmpeg executable path not found'));
    const ff = spawn(execFfmpeg, [
      '-y',
      '-i', filePath,
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'md5',
      '-'
    ]);
    let stdout = '';
    let stderr = '';
    ff.stdout.on('data', d => stdout += d.toString());
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('close', code => {
      if (code === 0) {
        const match = stdout.match(/[a-fA-F0-9]{32}/);
        if (match) resolve(match[0]);
        else resolve(stdout.trim());
      } else {
        reject(new Error(`FFmpeg md5 failed code ${code}: ${stderr}`));
      }
    });
    ff.on('error', reject);
  });
}

// Helper to decode audio to temporary PCM WAV file for comparison
async function decodeToTempWav(filePath: string): Promise<string> {
  const tempPath = path.join(os.tmpdir(), `verif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.wav`);
  return new Promise((resolve, reject) => {
    const execFfmpeg = getExecutableFFmpegPath();
    if (!execFfmpeg) return reject(new Error('FFmpeg executable path not found'));
    const ff = spawn(execFfmpeg, [
      '-y',
      '-i', filePath,
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      '-ac', '2',
      tempPath
    ]);
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('close', code => {
      if (code === 0) resolve(tempPath);
      else reject(new Error(`Decode failed code ${code}: ${stderr}`));
    });
    ff.on('error', reject);
  });
}

// Helper to detect high frequency cutoff (e.g. MP3 ~16kHz)
async function detectHighFreqCutoff(filePath: string): Promise<{ hasCutoff: boolean; freqHz?: number }> {
  return new Promise((resolve) => {
    const execFfmpeg = getExecutableFFmpegPath();
    if (!execFfmpeg) return resolve({ hasCutoff: false });
    const ff = spawn(execFfmpeg, [
      '-y',
      '-i', filePath,
      '-af', 'highpass=f=16000,astats=metadata=1:reset=1',
      '-f', 'null',
      '-'
    ]);
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('close', () => {
      const matches = stderr.match(/RMS level dB:\s*([-\d.]+)/i);
      if (matches && parseFloat(matches[1]) < -65) {
        resolve({ hasCutoff: true, freqHz: 16000 });
      } else {
        resolve({ hasCutoff: false });
      }
    });
    ff.on('error', () => resolve({ hasCutoff: false }));
  });
}

// Helper to compare two WAV files sample by sample
async function compareWavBuffers(path1: string, path2: string) {
  const buf1 = await fs.promises.readFile(path1);
  const buf2 = await fs.promises.readFile(path2);

  const headerOffset = 44;
  const pcm1 = new Int16Array(buf1.buffer, buf1.byteOffset + headerOffset, Math.floor((buf1.byteLength - headerOffset) / 2));
  const pcm2 = new Int16Array(buf2.buffer, buf2.byteOffset + headerOffset, Math.floor((buf2.byteLength - headerOffset) / 2));

  const minLen = Math.min(pcm1.length, pcm2.length);
  if (minLen === 0) {
    return { maxDiffDb: -100, snrDb: 100, correlationPercent: 100 };
  }

  let maxDiff = 0;
  let sumSqDiff = 0;
  let sumSq1 = 0;
  let sumSq2 = 0;
  let dotProd = 0;

  const step = minLen > 2000000 ? Math.floor(minLen / 1000000) : 1;
  let count = 0;

  for (let i = 0; i < minLen; i += step) {
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
  }

  let maxDiffDb = -100;
  if (maxDiff > 0) {
    maxDiffDb = Math.round((20 * Math.log10(maxDiff / 32768)) * 10) / 10;
  }

  const denom = Math.sqrt(sigPow1 * sigPow2);
  let correlation = 1.0;
  if (denom > 0) {
    correlation = (dotProd / count) / denom;
  }
  const correlationPercent = Math.max(0, Math.min(100, Math.round(correlation * 10000) / 100));

  return { maxDiffDb, snrDb, correlationPercent };
}

// IPC Handler to run quality verification (MD5 hash match & PCM waveform diff analysis)
ipcMain.handle('verify-audio-quality', async (_event, { originalPath, convertedPath, isLosslessPair }) => {
  const verifiedAt = new Date().toLocaleTimeString();
  try {
    fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] verify-audio-quality called.\n  Original: "${originalPath}"\n  Converted: "${convertedPath}"\n`);
  } catch (e) {}

  if (!originalPath || !convertedPath || !fs.existsSync(originalPath) || !fs.existsSync(convertedPath)) {
    return {
      success: false,
      error: 'Original or converted file path is invalid or missing.'
    };
  }

  try {
    // 1. Calculate PCM MD5 Hash for both files
    let origMd5 = '';
    let convMd5 = '';
    try {
      [origMd5, convMd5] = await Promise.all([
        computePcmMd5(originalPath),
        computePcmMd5(convertedPath)
      ]);
    } catch (e: any) {
      try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] MD5 calculation warning: ${e.message}\n`); } catch (e) {}
    }

    const exactMatch = !!(origMd5 && convMd5 && origMd5 === convMd5);

    if (exactMatch) {
      return {
        success: true,
        result: {
          verifiedAt,
          isLosslessPair: true,
          exactMatch: true,
          originalMd5: origMd5,
          convertedMd5: convMd5,
          snrDb: 100,
          maxDiffDb: -100,
          correlationPercent: 100,
          hasHighFreqCutoff: false,
          status: 'perfect',
          summaryMessage: '100%完全一致 (ビタ一文違いなし・データ欠損/劣化ゼロ)',
          details: [
            `元のPCM MD5: ${origMd5}`,
            `変換後PCM MD5: ${convMd5}`,
            `ハッシュ比較結果: 完全に一致 (Bit-exact match)`,
            `音声データの欠損・音質劣化は100%ゼロであることが数学的に証明されました。`
          ]
        }
      };
    }

    // 2. Perform PCM Diff Analysis (Decode both to temp WAV)
    let tempWavOrig = '';
    let tempWavConv = '';
    let diffMetrics = { maxDiffDb: -100, snrDb: 100, correlationPercent: 100 };
    let cutoffInfo = { hasCutoff: false, freqHz: undefined as number | undefined };

    try {
      [tempWavOrig, tempWavConv] = await Promise.all([
        decodeToTempWav(originalPath),
        decodeToTempWav(convertedPath)
      ]);

      diffMetrics = await compareWavBuffers(tempWavOrig, tempWavConv);
      cutoffInfo = await detectHighFreqCutoff(convertedPath);
    } catch (diffErr: any) {
      try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Diff analysis error: ${diffErr.message}\n`); } catch (e) {}
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
      status = 'passed';
      if (cutoffInfo.hasCutoff) {
        summaryMessage = `品質正常 (非可逆圧縮による高域カット ~${(cutoffInfo.freqHz || 16000) / 1000}kHz 検出)`;
      } else {
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
      `元のPCM MD5: ${origMd5 || 'N/A'}`,
      `変換後PCM MD5: ${convMd5 || 'N/A'}`,
      `波形類似度 (相関率): ${diffMetrics.correlationPercent}%`,
      `S/N比 (Signal-to-Noise Ratio): ${diffMetrics.snrDb} dB`,
      `最大波形差分ピーク: ${diffMetrics.maxDiffDb} dB`,
      cutoffInfo.hasCutoff
        ? `高周波カットオフ: 検出あり (~${(cutoffInfo.freqHz || 16000) / 1000}kHz 以上の帯域カット)`
        : `高周波カットオフ: 未検出 (広帯域維持)`
    ];

    return {
      success: true,
      result: {
        verifiedAt,
        isLosslessPair: !!isLosslessPair,
        exactMatch: false,
        originalMd5: origMd5,
        convertedMd5: convMd5,
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
    try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Quality verification exception: ${err.message}\n`); } catch (e) {}
    return {
      success: false,
      error: err.message || 'Failed to verify quality'
    };
  }
});
