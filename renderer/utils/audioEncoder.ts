/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConverterSettings } from '../types';

/**
 * Encodes a browser AudioBuffer into a WAV (RIFF) ArrayBuffer.
 * Handles bit depth, resampling, normalization, volume booster, and channels.
 */
export function bufferToWav(
  audioBuffer: AudioBuffer,
  settings: ConverterSettings,
  onProgress?: (progress: number) => void
): ArrayBuffer {
  const numberOfChannels = Math.min(audioBuffer.numberOfChannels, settings.channels);
  const sampleRate = settings.sameAsSource ? audioBuffer.sampleRate : settings.sampleRate;
  const bitDepth = parseInt(settings.bitDepth) as 16 | 24 | 32;

  // 1. Calculate Peak and RMS for normalization if needed
  let channels: Float32Array[] = [];
  let peakVal = 0;
  for (let i = 0; i < numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
    const data = channels[i];
    for (let j = 0; j < data.length; j++) {
      const absVal = Math.abs(data[j]);
      if (absVal > peakVal) peakVal = absVal;
    }
  }

  // 2. Compute Gain multiplier based on normalization & volume boost (bypassed if sameAsSource)
  let gain = 1.0;
  
  if (!settings.sameAsSource) {
    // Apply manual volume boost first
    if (settings.volumeBoostDb !== 0) {
      gain *= Math.pow(10, settings.volumeBoostDb / 20);
    }

    // Apply normalization if enabled
    if (settings.normalize && peakVal > 0) {
      // Normalization target amp (e.g., -1dB -> ~0.891)
      const targetAmp = Math.pow(10, settings.normalizationTargetDb / 20);
      // Adjust gain so peak matches target
      gain = targetAmp / peakVal;
    }
  }

  // 3. Setup resampling (Linear Interpolation)
  const sourceSampleRate = audioBuffer.sampleRate;
  const ratio = sourceSampleRate / sampleRate;
  const sourceLength = audioBuffer.length;
  const targetLength = Math.round(sourceLength / ratio);

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataSize = targetLength * blockAlign;
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  // RIFF Header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // size of pack
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size (16 for PCM)
  // format tag: 1 = PCM integer, 3 = IEEE Float
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples with optional progress tracking
  let offset = 44;
  const progressStep = Math.max(1, Math.floor(targetLength / 10));

  for (let i = 0; i < targetLength; i++) {
    if (onProgress && i % progressStep === 0) {
      onProgress(Math.min(95, Math.round((i / targetLength) * 100)));
    }

    const srcIndex = i * ratio;
    const indexA = Math.floor(srcIndex);
    const indexB = Math.min(indexA + 1, sourceLength - 1);
    const weight = srcIndex - indexA;

    for (let channel = 0; channel < numberOfChannels; channel++) {
      const data = channels[channel];
      // Interpolated value
      let sample = data[indexA] * (1 - weight) + data[indexB] * weight;

      // Apply gain multiplier (volume boost / normalization)
      sample *= gain;

      // Clamp value
      sample = Math.max(-1, Math.min(1, sample));

      if (bitDepth === 16) {
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      } else if (bitDepth === 24) {
        // 24-bit integer PCM
        const intSample = Math.floor(sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF);
        view.setInt8(offset, intSample & 0xFF);
        view.setInt8(offset + 1, (intSample >> 8) & 0xFF);
        view.setInt8(offset + 2, (intSample >> 16) & 0xFF);
        offset += 3;
      } else {
        // 32-bit Float
        view.setFloat32(offset, sample, true);
        offset += 4;
      }
    }
  }

  if (onProgress) {
    onProgress(100);
  }

  return arrayBuffer;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Estimates file size in Megabytes based on settings and duration.
 */
export function estimateOutputSize(duration: number, settings: ConverterSettings): number {
  const fmt = (settings.outputFormat || 'WAV').toUpperCase();
  if (['WAV', 'FLAC', 'ALAC'].includes(fmt)) {
    const bitDepth = parseInt(settings.bitDepth) || 16;
    const byteRate = settings.sampleRate * settings.channels * (bitDepth / 8);
    // FLAC and ALAC achieve roughly ~50-60% compression ratio compared to raw uncompressed WAV
    const compressionFactor = fmt === 'WAV' ? 1.0 : 0.55;
    return ((byteRate * duration) / (1024 * 1024)) * compressionFactor;
  } else {
    // Lossy compressed format estimation (based on requested kbps bitrate)
    const kbps = parseInt(settings.bitrate) || 320;
    const bytesPerSec = (kbps * 1000) / 8;
    return (bytesPerSec * duration) / (1024 * 1024);
  }
}

/**
 * Analyzes audio amplitude to find Peak dBFS and RMS dBFS.
 */
export function analyzeAudioBuffer(audioBuffer: AudioBuffer): { peakDb: number; rmsDb: number } {
  let peak = 0;
  let squareSum = 0;
  let totalSamples = 0;

  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const data = audioBuffer.getChannelData(c);
    totalSamples += data.length;
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      const absVal = Math.abs(val);
      if (absVal > peak) peak = absVal;
      squareSum += val * val;
    }
  }

  const rms = Math.sqrt(squareSum / (totalSamples || 1));
  
  // Convert to dBFS (reference is 1.0)
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;

  return {
    peakDb: Math.round(peakDb * 10) / 10,
    rmsDb: Math.round(rmsDb * 10) / 10,
  };
}

/**
 * Generates an interesting mock audio buffer (with multiple harmonics or synth pattern)
 * in case a loaded file has unsupported format or we want a quick template file.
 */
export function createMockAudioBuffer(durationSec: number = 3.5, sampleRate: number = 44100): AudioBuffer {
  // Guard against SSR execution
  if (typeof window === 'undefined') {
    return {} as AudioBuffer;
  }
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const numSamples = durationSec * sampleRate;
  const buffer = ctx.createBuffer(2, numSamples, sampleRate);

  const freqLeft = 220; // A3
  const freqRight = 330; // E4

  const channelL = buffer.getChannelData(0);
  const channelR = buffer.getChannelData(1);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    
    // Create a beat synth track with decay envelope
    const envelope = Math.exp(-3 * (t % 1.0)); // beat every 1s
    const synthL = Math.sin(2 * Math.PI * freqLeft * t) * 0.5 + Math.sin(2 * Math.PI * freqLeft * 2.01 * t) * 0.15;
    const synthR = Math.sin(2 * Math.PI * freqRight * t) * 0.5 + Math.sin(2 * Math.PI * freqRight * 1.5 * t) * 0.15;

    // Add some white noise in background
    const noise = (Math.random() - 0.5) * 0.02;

    channelL[i] = (synthL * envelope + noise) * 0.6;
    channelR[i] = (synthR * envelope + noise) * 0.6;
  }

  return buffer;
}
