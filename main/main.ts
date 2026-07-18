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

// IPC Handler to decode any audio file (ALAC, AAC, etc.) to PCM WAV via FFmpeg
ipcMain.handle('decode-audio-to-wav', async (_event, filePath: string) => {
  return new Promise((resolve, reject) => {
    try {
      fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] decode-audio-to-wav called. File: "${filePath}"\nFFmpeg Path: "${ffmpegPath}"\n`);
    } catch (e) {}

    if (!ffmpegPath) {
      const err = new Error('FFmpeg static binary path not found.');
      try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error: ${err.message}\n`); } catch (e) {}
      reject(err);
      return;
    }
    const tempOutPath = path.join(
      os.tmpdir(),
      `decode_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.wav`
    );

    // Run ffmpeg -i input -acodec pcm_s16le -ar 44100 -y tempOutPath
    const ffmpegProcess = spawn(ffmpegPath, [
      '-i', filePath,
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      tempOutPath,
      '-y'
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
        const err = new Error(`FFmpeg failed with code ${code}. Error: ${stderr}`);
        try { fs.appendFileSync('debug_ipc.log', `[${new Date().toISOString()}] [MAIN] Error decoding: ${err.message}\n`); } catch (e) {}
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
      const ff = spawn(ffmpegPath || 'ffmpeg', ffmpegArgs);
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
