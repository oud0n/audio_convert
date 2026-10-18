/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export function getFormatExtension(fmt: string): string {
  const upper = (fmt || '').toUpperCase();
  if (upper === 'ALAC') return 'm4a';
  if (upper === 'WAVPACK') return 'wv';
  return upper.toLowerCase();
}


export interface MetadataTags {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  disc: string;
  year: string;
  genre: string;
  track: string;
  comment: string;
  totalTracks?: string;
  totalDiscs?: string;
}

export interface QualityVerificationResult {
  verifiedAt: string;
  isLosslessPair: boolean;
  exactMatch: boolean; // SHA-256 100% Bit-exact Match
  originalHash?: string;
  convertedHash?: string;
  snrDb?: number; // Signal-to-Noise ratio in dB
  maxDiffDb?: number; // Max peak difference in dB
  correlationPercent?: number; // Waveform similarity correlation (0 - 100%)
  hasHighFreqCutoff: boolean; // High frequency cutoff detection (e.g. MP3 ~16kHz)
  cutoffFreqHz?: number; // Estimated cutoff frequency
  status: 'perfect' | 'passed' | 'warning' | 'degraded';
  summaryMessage: string;
  details: string[];
}

export interface AudioFile {
  id: string;
  name: string;
  outputFileName?: string;
  outputPath?: string;
  path?: string; // absolute local path resolved via preload webUtils
  size: number;
  duration: number; // in seconds
  originalFormat: string;
  outputFormat: string;
  bitrate: string;
  sampleRate: number;
  channels: number;
  status: 'queued' | 'decoding' | 'normalizing' | 'converting' | 'completed' | 'failed';
  progress: number;
  error?: string;
  originalAudioBuffer?: AudioBuffer | null;
  /** Why the waveform/player audio could not be loaded. */
  previewError?: string;
  peakDb?: number;
  rmsDb?: number;
  tags: MetadataTags;
  /** Tags as read from the source file; edits are detected against these. */
  sourceTags?: MetadataTags;
  /** Backend codec check (ALAC in .m4a is lossless, AAC is not). */
  sourceLossless?: boolean;
  /** Sample rate of the source file; sampleRate follows the tab settings. */
  sourceSampleRate?: number;
  normalizationApplied: boolean;
  gainMultiplier?: number;
  originalDeleted?: boolean;
  verificationResult?: QualityVerificationResult;
  isVerifying?: boolean;
}

export interface ConverterSettings {
  outputFormat: 'WAV' | 'MP3' | 'FLAC' | 'M4A' | 'OGG' | 'ALAC' | 'OPUS' | 'AIFF' | 'AC3' | 'WMA' | 'WAVPACK' | string;
  bitrate: '128' | '192' | '256' | '320';
  sampleRate: 22050 | 44100 | 48000 | 88200 | 96000;
  bitDepth: '16' | '24' | '32';
  channels: 1 | 2 | 6; // 1 = Mono, 2 = Stereo, 6 = 5.1 Surround
  normalize: boolean;
  normalizationTargetDb: number; // target peak dB, e.g. -1.0
  autoNotification: boolean;
  notificationSound: 'chime' | 'beep' | 'glass' | 'digital';
  volumeBoostDb: number; // manual gain, -10 to +20
  trimSilence: boolean;
  trimSilenceThresholdDb: number; // e.g. -50 dB
  threadPoolSize: number; // 1 to 16
  ffmpegHighSpeed: boolean; // toggle visual mode
  autoRemoveCompleted: boolean;
  autoVerifyQuality: boolean; // Enable automatic quality and data loss verification after conversion
  sameAsSource: boolean; // Keep original audio quality (sample rate, bit depth, bypass normalize)
  
  // New Local Desktop App & Electron Features
  electronDesktopMode: boolean; // Simulates/enables direct local OS access via Electron bridge
  deleteOriginalAfterConvert: boolean; // Deletes the original file from workspace once successfully converted
  saveInSourceFolder: boolean; // Save output files inside source directory
  renameByTags: boolean; // Enable file renaming based on ID3 metadata tags
  renamePattern: string; // e.g. "%disc2%-%track2% %title%|%filename%" (legacy "{track} - {title}" also works)
  localSavePath: string; // Target directory path on Desktop
  maxSampleRate?: number; // 0 = no limit; higher source rates are reduced (also in "same as source")
  flacCompressionLevel?: number; // 0-8
  flacUncompressed?: boolean; // FLAC without compression (overrides the level)
  onExisting?: 'rename' | 'overwrite' | 'skip'; // when the output file already exists
}

export interface SettingsPreset {
  id: string;
  name: string;
  settings: ConverterSettings;
  isCustom: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error';
}

export interface JobTab {
  id: string;
  name: string;
  files: AudioFile[];
  settings: ConverterSettings;
  logs: LogEntry[];
  selectedFileId: string | null;
}

export interface ElectronIpcFallback {
  invoke: <T = any>(channel: string, ...args: any[]) => Promise<T>;
  send: (channel: string, ...args: any[]) => void;
  on: <T = any>(channel: string, callback: (arg: T) => void) => () => void;
  getPathForFile?: (file: File) => string;
}

declare global {
  interface Window {
    ipc?: ElectronIpcFallback;
  }
}
