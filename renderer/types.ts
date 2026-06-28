/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MetadataTags {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  track: string;
  comment: string;
}

export interface AudioFile {
  id: string;
  name: string;
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
  convertedAudioUrl?: string | null;
  convertedBlob?: Blob | null;
  peakDb?: number;
  rmsDb?: number;
  tags: MetadataTags;
  normalizationApplied: boolean;
  gainMultiplier?: number;
  originalDeleted?: boolean;
}

export interface ConverterSettings {
  outputFormat: 'WAV' | 'MP3' | 'FLAC' | 'M4A' | 'OGG';
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
  
  // New Local Desktop App & Electron Features
  electronDesktopMode: boolean; // Simulates/enables direct local OS access via Electron bridge
  deleteOriginalAfterConvert: boolean; // Deletes the original file from workspace once successfully converted
  renameByTags: boolean; // Enable file renaming based on ID3 metadata tags
  renamePattern: string; // Rename pattern (e.g., "{track} - {artist} - {title}")
  localSavePath: string; // Target directory path on Desktop
}

export interface SettingsPreset {
  id: string;
  name: string;
  settings: ConverterSettings;
  isCustom: boolean;
}
