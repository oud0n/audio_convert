/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConverterSettings } from '../types';

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

