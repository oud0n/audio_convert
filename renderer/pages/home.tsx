/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState } from 'react';
import Head from 'next/head';
import { useAudioConverter } from '../context/AudioConverterContext';
import { 
  FileAudio, Upload, Download, Trash2, Sliders, Volume2, 
  CheckCircle2, AlertCircle, RefreshCw, Layers, Sparkles, Laptop 
} from '../components/Icons';
import { estimateOutputSize } from '../utils/audioEncoder';
import { AudioFile } from '../types';

export default function HomeDashboardPage() {
  const {
    files,
    setFiles,
    settings,
    handleAddFiles: onAddFiles,
    handleLoadDemoLoops: onLoadDemoLoops,
    handleStartConversion: onStartConversion,
    handleCancelConversion: onCancelConversion,
    isConverting,
    selectedFileId,
    setSelectedFileId,
  } = useAudioConverter();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onAddFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddFiles(e.target.files);
    }
  };

  const removeFile = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFiles((prev) => prev.filter((f) => f.id !== id));
    if (selectedFileId === id) {
      setSelectedFileId(null);
    }
  };

  const updateIndividualFormat = (id: string, format: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, outputFormat: format } : f))
    );
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDuration = (seconds: number) => {
    if (isNaN(seconds) || seconds === 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusBadge = (status: AudioFile['status'], originalDeleted?: boolean) => {
    switch (status) {
      case 'queued':
        return <span className="px-2 py-0.5 bg-zinc-800 text-zinc-400 border border-zinc-700 rounded font-mono text-[10px]">QUEUED</span>;
      case 'decoding':
        return (
          <span className="px-2 py-0.5 bg-cyan-950/40 text-cyan-400 border border-cyan-800/30 rounded font-mono text-[10px] flex items-center gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span>DECODING</span>
          </span>
        );
      case 'normalizing':
        return (
          <span className="px-2 py-0.5 bg-amber-950/40 text-amber-400 border border-amber-800/30 rounded font-mono text-[10px] flex items-center gap-1">
            <Volume2 className="h-3 w-3 animate-pulse" />
            <span>GAIN SCAN</span>
          </span>
        );
      case 'converting':
        return (
          <span className="px-2 py-0.5 bg-emerald-950/40 text-emerald-400 border border-emerald-800/30 rounded font-mono text-[10px] flex items-center gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span>ENCODING</span>
          </span>
        );
      case 'completed':
        return (
          <div className="flex flex-col items-center gap-1">
            <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded font-mono text-[10px] flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              <span>FINISHED</span>
            </span>
            {originalDeleted && (
              <span className="px-1.5 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 rounded text-[9px] font-mono scale-90 tracking-tighter uppercase block text-center" title="Pre-converted file was automatically removed from Local Disk">
                Source Deleted
              </span>
            )}
          </div>
        );
      case 'failed':
        return (
          <span className="px-2 py-0.5 bg-rose-950/40 text-rose-400 border border-rose-800/30 rounded font-mono text-[10px] flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            <span>ERROR</span>
          </span>
        );
    }
  };

  const totalProgress = files.length > 0
    ? Math.round(files.reduce((acc, f) => acc + f.progress, 0) / files.length)
    : 0;

  return (
    <>
      <Head>
        <title>Batch Converter - X-Conv Audio Suite</title>
      </Head>
      
      <div id="dashboard-tab" className="flex-1 flex flex-col justify-between overflow-hidden bg-zinc-950 text-zinc-300">
        
        {/* Scrollable File List Workspace */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          
          {/* Drag & Drop Visual Target Zone */}
          <div
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 group h-44 ${
              dragActive
                ? 'border-emerald-500 bg-emerald-950/10 shadow-lg shadow-emerald-950/20'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/60'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="audio/*"
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="h-11 w-11 rounded-lg bg-zinc-800/80 group-hover:bg-zinc-700/80 border border-zinc-700/50 flex items-center justify-center text-zinc-400 group-hover:text-emerald-400 transition-colors mb-3">
              <Upload className="h-5 w-5" />
            </div>

            <p className="text-sm font-semibold text-white">Drag & drop files here, or <span className="text-emerald-400">browse folders</span></p>
            <p className="text-xs text-zinc-500 font-mono mt-1">SUPPORTS WAV, MP3, FLAC, M4A, OGG, AND AAC AUDIO TRACKS</p>

            <button
              onClick={(e) => {
                e.stopPropagation();
                onLoadDemoLoops();
              }}
              className="absolute bottom-3 right-3 px-3 py-1 bg-emerald-600/10 hover:bg-emerald-600/25 border border-emerald-500/20 rounded-md text-[10px] font-mono text-emerald-400 flex items-center gap-1.5 transition-all shadow-sm shadow-black/40 cursor-pointer"
            >
              <Sparkles className="h-3 w-3" />
              <span>LOAD DEMO SYNTH LOOPS</span>
            </button>
          </div>

          {/* Batch Queue Table */}
          {files.length > 0 ? (
            <div className="border border-zinc-800 bg-zinc-900 rounded-xl overflow-hidden shadow-lg shadow-black/20">
              <div className="p-3.5 bg-zinc-900 border-b border-zinc-800/80 flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Layers className="h-4.5 w-4.5 text-emerald-400" />
                  <span className="text-xs font-semibold text-white tracking-wide font-mono uppercase">BATCH CONVERSION QUEUE ({files.length} ITEMS)</span>
                </div>
                <button
                  onClick={() => {
                    setFiles([]);
                    setSelectedFileId(null);
                  }}
                  disabled={isConverting}
                  className="text-[10px] font-mono text-zinc-500 hover:text-red-400 disabled:opacity-30 transition-colors cursor-pointer"
                >
                  CLEAR QUEUE
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800/60 text-[10px] font-mono text-zinc-500 tracking-wider">
                      <th className="py-2.5 px-4 w-12 text-center">STATUS</th>
                      <th className="py-2.5 px-3">FILE DETAILS</th>
                      <th className="py-2.5 px-3">SOURCE SPEC</th>
                      <th className="py-2.5 px-3">DESTINATION FORMAT</th>
                      <th className="py-2.5 px-3">GAIN SCALING</th>
                      <th className="py-2.5 px-4 text-right w-24">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/40 text-xs font-mono">
                    {files.map((file) => {
                      const isSelected = selectedFileId === file.id;
                      const estimatedSize = estimateOutputSize(file.duration, {
                        ...settings,
                        outputFormat: file.outputFormat as any,
                      });

                      return (
                        <tr
                          key={file.id}
                          onClick={() => setSelectedFileId(file.id)}
                          className={`hover:bg-zinc-800/35 cursor-pointer transition-colors ${
                            isSelected ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''
                          }`}
                        >
                          {/* Status Badge */}
                          <td className="py-3 px-4 text-center">
                            {getStatusBadge(file.status, file.originalDeleted)}
                          </td>

                          {/* File details (name, duration, size) */}
                          <td className="py-3 px-3 max-w-xs sm:max-w-md">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-zinc-200 font-semibold truncate block" title={file.name}>
                                {file.name}
                              </span>
                              {/* Live Metadata Rename Target Preview */}
                              {file.status !== 'completed' && settings.renameByTags && file.tags && (
                                <span className="text-[10px] text-emerald-500/70 truncate block" title="Dynamic Output file name calculated from ID3 tags">
                                  ↳ Rename Preview: {(() => {
                                    let pat = settings.renamePattern;
                                    pat = pat.replace('{artist}', file.tags.artist || 'Unknown Artist');
                                    pat = pat.replace('{title}', file.tags.title || 'Untitled');
                                    pat = pat.replace('{album}', file.tags.album || 'Unknown Album');
                                    pat = pat.replace('{track}', file.tags.track || '01');
                                    pat = pat.replace('{year}', file.tags.year || '2026');
                                    pat = pat.replace('{genre}', file.tags.genre || 'Electronic');
                                    return `${pat}.${file.outputFormat ? file.outputFormat.toLowerCase() : settings.outputFormat.toLowerCase()}`;
                                  })()}
                                </span>
                              )}
                              <div className="flex gap-3 text-[10px] text-zinc-500">
                                <span>{formatDuration(file.duration)}</span>
                                <span>•</span>
                                <span>{formatSize(file.size)}</span>
                              </div>
                            </div>
                          </td>

                          {/* Source original spec */}
                          <td className="py-3 px-3 text-zinc-400">
                            <div className="flex flex-col">
                              <span>{file.originalFormat.toUpperCase()}</span>
                              <span className="text-[10px] text-zinc-600">{file.sampleRate / 1000}kHz • {file.channels === 1 ? 'Mono' : 'Stereo'}</span>
                            </div>
                          </td>

                          {/* Destination Format selector */}
                          <td className="py-3 px-3 text-zinc-300">
                            {file.status === 'queued' ? (
                              <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                                {(['WAV', 'MP3', 'FLAC'] as const).map((fmt) => (
                                  <button
                                    key={fmt}
                                    onClick={(e) => updateIndividualFormat(file.id, fmt, e)}
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono border transition-all cursor-pointer ${
                                      file.outputFormat === fmt
                                        ? 'bg-zinc-800 text-emerald-400 border-emerald-500/30'
                                        : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-300'
                                    }`}
                                  >
                                    {fmt}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="flex flex-col">
                                <span className="text-emerald-400 font-bold">{file.outputFormat}</span>
                                <span className="text-[10px] text-zinc-500 font-mono">~{estimatedSize.toFixed(1)} MB</span>
                              </div>
                            )}
                          </td>

                          {/* Normalizer Peak values */}
                          <td className="py-3 px-3 text-zinc-400">
                            {file.peakDb !== undefined ? (
                              <div className="flex flex-col gap-0.5">
                                <span className="text-zinc-300">Peak: {file.peakDb} dB</span>
                                {file.normalizationApplied && file.gainMultiplier ? (
                                  <span className="text-[10px] text-amber-500">Normalized ({file.gainMultiplier > 1 ? '+' : ''}{Math.round(20 * Math.log10(file.gainMultiplier) * 10) / 10} dB)</span>
                                ) : (
                                  <span className="text-[10px] text-zinc-600">Dry Volume</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-zinc-600 italic">No analysis</span>
                            )}
                          </td>

                          {/* Actions buttons */}
                          <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end items-center gap-1.5">
                              {file.status === 'completed' && file.convertedAudioUrl && (
                                <a
                                  href={file.convertedAudioUrl}
                                  download={`${file.name.substring(0, file.name.lastIndexOf('.')) || file.name}_XConv.${file.outputFormat.toLowerCase()}`}
                                  className="p-1.5 bg-emerald-600/10 hover:bg-emerald-600 border border-emerald-500/20 hover:border-emerald-500 rounded text-emerald-400 hover:text-white transition-all shadow-sm"
                                  title="Download Converted Audio"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </a>
                              )}
                              <button
                                onClick={(e) => removeFile(file.id, e)}
                                disabled={isConverting}
                                className="p-1.5 bg-zinc-950 border border-zinc-800 hover:border-red-500/30 hover:bg-red-950/20 text-zinc-500 hover:text-red-400 rounded transition-all disabled:opacity-20 cursor-pointer"
                                title="Remove from queue"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-12 text-center bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg mx-auto flex flex-col items-center gap-4 mt-8">
              <div className="h-12 w-12 rounded-full bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center text-zinc-400">
                <FileAudio className="h-6 w-6 animate-pulse" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-white">Your converter queue is empty</h3>
                <p className="text-xs text-zinc-500 max-w-sm mx-auto leading-relaxed">
                  Drag and drop your audio files above, browse local folders, or load our synthetic demo synth beats to test the real-time normalizer, bitrate specs, and tags writing!
                </p>
              </div>
            </div>
          )}

        </div>

        {/* Global Dashboard Pipeline Action Bar */}
        <div id="batch-control-bar" className="bg-zinc-900 border-t border-zinc-800/80 p-4 select-none">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            
            {/* Preset Quick Summary Options */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-mono">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-zinc-500" />
                <span className="text-zinc-400">Global Preset:</span>
                <span className="px-2 py-0.5 bg-zinc-950 border border-zinc-800 rounded text-emerald-400 font-bold">
                  {settings.outputFormat}
                </span>
                {settings.outputFormat === 'WAV' ? (
                  <span className="text-zinc-500 text-[10px]">{settings.bitDepth}-bit PCM</span>
                ) : (
                  <span className="text-zinc-500 text-[10px]">{settings.bitrate} kbps</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Volume2 className="h-4 w-4 text-zinc-500" />
                <span className="text-zinc-400">Normalizer:</span>
                <span className={`px-2 py-0.5 border rounded text-[10px] font-bold ${
                  settings.normalize 
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' 
                    : 'bg-zinc-950 border-zinc-800 text-zinc-500'
                }`}>
                  {settings.normalize ? `ACTIVE (${settings.normalizationTargetDb} dBFS)` : 'BYPASS'}
                </span>
              </div>

              {settings.electronDesktopMode && (
                <div className="flex items-center gap-2">
                  <Laptop className="h-4 w-4 text-emerald-400 animate-pulse" />
                  <span className="text-zinc-400">Electron Output:</span>
                  <span className="px-2 py-0.5 bg-emerald-950/40 border border-emerald-500/30 rounded text-emerald-400 text-[10px] font-bold max-w-[200px] truncate" title={settings.localSavePath}>
                    {settings.localSavePath}
                  </span>
                </div>
              )}
            </div>

            {/* Action Trigger Block & Dashboard Progress Ring */}
            <div className="flex items-center gap-4 w-full md:w-auto justify-end">
              
              {/* Visual Queue Pipeline Progress Bar */}
              {isConverting && (
                <div className="flex flex-col gap-1 w-44">
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-zinc-500">PIPELINE BATCH</span>
                    <span className="text-emerald-400 font-bold">{totalProgress}%</span>
                  </div>
                  <div className="w-full bg-zinc-950 rounded-full h-1.5 border border-zinc-800">
                    <div
                      className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${totalProgress}%` }}
                    ></div>
                  </div>
                </div>
              )}

              {isConverting ? (
                <button
                  onClick={onCancelConversion}
                  className="px-5 py-2.5 bg-zinc-850 hover:bg-zinc-800 hover:text-rose-400 border border-zinc-700 hover:border-rose-500/30 rounded-lg text-xs font-mono font-semibold transition-all cursor-pointer"
                >
                  ABORT BATCH
                </button>
              ) : (
                <button
                  onClick={onStartConversion}
                  disabled={files.length === 0}
                  className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white hover:shadow-lg hover:shadow-emerald-950/40 border border-emerald-500 rounded-lg text-xs font-mono font-bold transition-all disabled:opacity-40 disabled:hover:shadow-none flex items-center gap-2 cursor-pointer"
                >
                  <RefreshCw className="h-4 w-4 shrink-0" />
                  <span>START BATCH CONVERSION</span>
                </button>
              )}

            </div>

          </div>
        </div>

      </div>
    </>
  );
}
