/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useState, useEffect } from 'react';
import Head from 'next/head';
import { useAudioConverter, outputTags } from '../context/AudioConverterContext';
import { 
  FileAudio, Upload, Trash2, Sliders, Volume2, 
  Plus, X, Save, Settings, Info, RefreshCw, AlertCircle,
  ShieldCheck, Coffee
} from '../components/Icons';
import { DonateModal } from '../components/DonateModal';
import { estimateOutputSize } from '../utils/audioEncoder';
import { MetadataTags, getFormatExtension, VBR_FORMATS } from '../types';
import { t } from '../utils/i18n';
import { AppBridge, isTauri, pathOnlyFile } from '../services/bridge';
import { renderFileName, insertToken, PREVIEW_TAGS, SUPPORTED_INPUT_EXTENSIONS, LOSSLESS_OUTPUT_FORMATS, DEFAULT_CHANNEL_PATTERN, DEFAULT_CHANNEL_NAMES, CHANNEL_KEYS, outputSampleRate, extractExtension } from '../utils/fileNamePattern';

/** Height of a queue row in px (fixed, so the windowed list can place rows exactly). */
const QUEUE_ROW_HEIGHT = 48;

export default function HomeDashboardPage() {
  const {
    // Basic States
    files,
    setFiles,
    settings,
    setSettings,
    selectedFileId,
    setSelectedFileId,
    isConverting,
    handleAddFiles,
    handleStartConversion,
    handleCancelConversion,
    handleUpdateTags,
    handleVerifyQuality,
    handleResetQueueStatus,
    showToast,

    // Multi-tab extensions
    tabs,
    activeTabId,
    setActiveTabId,
    handleAddTab,
    handleRemoveTab,
    handleRenameTab,
    logs,
    addLog,
    clearLogs,
    skippedFiles,
    setSkippedFiles,
    lang,
    setLang
  } = useAudioConverter();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  // The queue table draws only the rows in view (plus a margin) when it is long.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listView, setListView] = useState({ top: 0, height: 800 });
  const updateListView = () => {
    const el = listRef.current;
    if (el) setListView({ top: el.scrollTop, height: el.clientHeight });
  };
  useEffect(() => {
    updateListView();
    const el = listRef.current;
    const observer = typeof ResizeObserver !== 'undefined' && el ? new ResizeObserver(updateListView) : null;
    if (observer && el) observer.observe(el);
    window.addEventListener('resize', updateListView);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateListView);
    };
  }, []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Tab editing states
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState<string>('');
  
  // UI Panels states
  const [bottomTab, setBottomTab] = useState<'source' | 'metadata' | 'quality' | 'log'>('source');
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showPatternHelpModal, setShowPatternHelpModal] = useState(false);
  const [showDonateModal, setShowDonateModal] = useState(false);
  // The app menu's "Support the developer" item opens the same dialog.
  useEffect(() => {
    if (!AppBridge.isAvailable()) return;
    let off: (() => void) | undefined;
    let gone = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('open-donate-modal', () => setShowDonateModal(true)))
      .then((unlisten) => { if (gone) unlisten(); else off = unlisten; })
      .catch(() => {});
    return () => { gone = true; off?.(); };
  }, []);
  const [dragActive, setDragActive] = useState(false);
  const [showDebugLogs, setShowDebugLogs] = useState(false);

  // Playback Auditing States
  const [isPlaying, setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [volume, setVolume] = useState(0.8);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);

  // Tags Local State
  const [tags, setTags] = useState<MetadataTags>({
    title: '',
    artist: '',
    album: '',
    albumArtist: '',
    disc: '',
    year: '',
    genre: '',
    track: '',
    comment: '',
  });

  const selectedFile = files.find(f => f.id === selectedFileId) || null;

  // Sync tags on file change
  useEffect(() => {
    stopPlayback();
    if (selectedFile) {
      setTags(selectedFile.tags);
    } else {
      setTags({
        title: '',
        artist: '',
        album: '',
        albumArtist: '',
        disc: '',
        year: '',
        genre: '',
        track: '',
        comment: '',
      });
    }
  }, [selectedFileId]);

  // Waveform Renderer Effect
  useEffect(() => {
    if (bottomTab !== 'metadata') return;
    if (!canvasRef.current || !selectedFile || !selectedFile.originalAudioBuffer) {
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.fillStyle = '#09090b';
          ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.font = '11px "JetBrains Mono", monospace';
          ctx.fillStyle = '#4b5563';
          ctx.textAlign = 'center';
          ctx.fillText(!selectedFile ? 'SELECT A FILE TO DRAW WAVEFORM' : selectedFile.previewError ? 'WAVEFORM UNAVAILABLE (FILE CANNOT BE READ)' : 'LOADING WAVEFORM...', canvasRef.current.width / 2, canvasRef.current.height / 2);
        }
      }
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const buffer = selectedFile.originalAudioBuffer;
    const channelData = buffer.getChannelData(0); // Left channel
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1;
    const gridCols = 10;
    for (let i = 1; i < gridCols; i++) {
      const x = (width / gridCols) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    const gridRows = 4;
    for (let i = 1; i < gridRows; i++) {
      const y = (height / gridRows) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Center axis
    ctx.strokeStyle = '#374151';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Waveform envelope
    const step = Math.ceil(channelData.length / width);
    const amp = height / 2;

    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      
      for (let j = 0; j < step; j++) {
        const datum = channelData[i * step + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }

      const x = i;
      const y1 = (1 + min) * amp;
      const y2 = (1 + max) * amp;

      const progressRatio = i / width;
      if (progressRatio <= playbackProgress) {
        ctx.strokeStyle = '#10b981'; // emerald-500
      } else {
        ctx.strokeStyle = '#4b5563'; // grey-600
      }

      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();
    }

    // Long files are previewed only from the start: the backend then cuts the preview at
    // exactly 20 min x 48 kHz x 2 ch worth of samples (see preview_plan); say so.
    const cutAt = (48000 * 2 * 1200) / (buffer.sampleRate * buffer.numberOfChannels);
    // For long files the rate is first lowered until the whole file fits, which also ends
    // at the cut length; only a source known to be longer was really cut.
    const cut = Math.abs(buffer.duration - cutAt) < 0.5 && (!selectedFile.duration || selectedFile.duration > buffer.duration + 1);
    if (cut) {
      const mins = Math.floor(buffer.duration / 60);
      const secs = Math.floor(buffer.duration % 60).toString().padStart(2, '0');
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = '#f59e0b';
      ctx.textAlign = 'right';
      ctx.fillText(lang === 'ja' ? `プレビューは先頭 ${mins}:${secs} のみ` : `PREVIEW: FIRST ${mins}:${secs} ONLY`, width - 8, 14);
    }

    // Playhead
    const cursorX = playbackProgress * width;
    ctx.strokeStyle = '#f43f5e'; // rose-500
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, height);
    ctx.stroke();

    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.moveTo(cursorX - 5, 0);
    ctx.lineTo(cursorX + 5, 0);
    ctx.lineTo(cursorX, 8);
    ctx.fill();

  }, [selectedFile, playbackProgress, bottomTab]);

  // Audio Playback Implementation
  const startPlayback = () => {
    const buffer = selectedFile?.originalAudioBuffer;
    if (!buffer) return;

    if (typeof window === 'undefined') return;

    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.connect(ctx.destination);
    gainNodeRef.current = gainNode;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);

    sourceNodeRef.current = source;

    const duration = buffer.duration;
    const offset = pausedAtRef.current;

    source.start(0, offset);
    startTimeRef.current = ctx.currentTime - offset;
    isPlayingRef.current = true;
    setIsPlaying(true);

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const updateProgress = () => {
      if (!ctx || !isPlayingRef.current) return;
      const elapsed = ctx.currentTime - startTimeRef.current;
      
      if (elapsed >= duration) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        setPlaybackTime(0);
        setPlaybackProgress(0);
        pausedAtRef.current = 0;
        sourceNodeRef.current = null;
        return;
      }

      setPlaybackTime(elapsed);
      setPlaybackProgress(elapsed / duration);
      animationFrameRef.current = requestAnimationFrame(updateProgress);
    };

    animationFrameRef.current = requestAnimationFrame(updateProgress);
  };

  const pausePlayback = () => {
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    
    const ctx = audioCtxRef.current;
    if (ctx) {
      const elapsed = ctx.currentTime - startTimeRef.current;
      pausedAtRef.current = elapsed;
    }
    isPlayingRef.current = false;
    setIsPlaying(false);
  };

  const stopPlayback = () => {
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    pausedAtRef.current = 0;
    setPlaybackTime(0);
    setPlaybackProgress(0);
    isPlayingRef.current = false;
    setIsPlaying(false);
  };

  const togglePlayback = () => {
    if (!selectedFile || !selectedFile.originalAudioBuffer) return;
    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  };

  const playNextTrack = () => {
    if (files.length === 0) return;
    const currentIndex = files.findIndex(f => f.id === selectedFileId);
    const nextIndex = (currentIndex + 1) % files.length;
    setSelectedFileId(files[nextIndex].id);
  };

  const playPrevTrack = () => {
    if (files.length === 0) return;
    const currentIndex = files.findIndex(f => f.id === selectedFileId);
    const prevIndex = (currentIndex - 1 + files.length) % files.length;
    setSelectedFileId(files[prevIndex].id);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (gainNodeRef.current && audioCtxRef.current) {
      gainNodeRef.current.gain.setValueAtTime(val, audioCtxRef.current.currentTime);
    }
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedFile || !selectedFile.originalAudioBuffer) return;
    const ratio = parseFloat(e.target.value);
    const duration = selectedFile.originalAudioBuffer.duration;
    const targetOffset = ratio * duration;
    
    if (sourceNodeRef.current) {
      sourceNodeRef.current.stop();
      sourceNodeRef.current = null;
    }
    
    pausedAtRef.current = targetOffset;
    setPlaybackProgress(ratio);
    setPlaybackTime(targetOffset);

    if (isPlaying) {
      startPlayback();
    }
  };

  useEffect(() => {
    return () => {
      stopPlayback();
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
      }
    };
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    if (bottomTab === 'log' && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, bottomTab]);

  const startEditingTab = (id: string, name: string) => {
    setEditingTabId(id);
    setEditingTabName(name);
  };

  const finishEditingTab = (id: string) => {
    if (editingTabName.trim()) {
      handleRenameTab(id, editingTabName.trim());
    }
    setEditingTabId(null);
  };

  const handleTabNameKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') {
      finishEditingTab(id);
    } else if (e.key === 'Escape') {
      setEditingTabId(null);
    }
  };

  const handleSaveTags = () => {
    if (selectedFile) {
      handleUpdateTags(selectedFile.id, tags);
    }
  };

  // Drag and drop
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const scanFiles = async (dataTransfer: DataTransfer): Promise<File[]> => {
    const filesList: File[] = [];
    const items = dataTransfer.items;
    
    if (!items) {
      return Array.from(dataTransfer.files);
    }

    const traverse = (entry: any, topLevelPath: string, isTopLevelDir: boolean): Promise<void> => {
      return new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((file: File) => {
            const ext = file.name.lastIndexOf('.') > 0 ? file.name.substring(file.name.lastIndexOf('.') + 1).toLowerCase() : '';
            if (SUPPORTED_INPUT_EXTENSIONS.includes(ext)) {
              let fullPath = topLevelPath;
              if (isTopLevelDir && entry.fullPath) {
                // Split and remove the first segment (which matches the topLevelPath folder name)
                const segments = entry.fullPath.split('/').filter(Boolean);
                segments.shift(); 
                const isPosix = topLevelPath.includes('/') || !topLevelPath.includes('\\');
                const sep = isPosix ? '/' : '\\';
                const relativePath = isPosix ? segments.join('/') : segments.join('\\');
                fullPath = topLevelPath.replace(/[/\\]+$/, '') + sep + relativePath;
              }
              
              Object.defineProperty(file, 'path', {
                value: fullPath,
                writable: true,
                configurable: true,
                enumerable: true
              });
              
              filesList.push(file);
            }
            resolve();
          });
        } else if (entry.isDirectory) {
          const dirReader = entry.createReader();
          const readEntries = () => {
            dirReader.readEntries(async (results: any[]) => {
              if (results.length === 0) {
                resolve();
              } else {
                const promises = results.map(child => traverse(child, topLevelPath, isTopLevelDir));
                await Promise.all(promises);
                readEntries();
              }
            }, () => resolve());
          };
          readEntries();
        } else {
          resolve();
        }
      });
    };

    const promises: Promise<void>[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          let topLevelPath = AppBridge.getPathForFile(dataTransfer.files[i]);
          if (!topLevelPath) {
            topLevelPath = (dataTransfer.files[i] as any)?.path || '';
          }
          promises.push(traverse(entry, topLevelPath, entry.isDirectory));
        }
      }
    }

    await Promise.all(promises);
    return filesList;
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    // In Tauri the window-level drop listener below adds the files (with folders expanded).
    if (isTauri()) return;
    if (e.dataTransfer) {
      const droppedFiles = await scanFiles(e.dataTransfer);
      if (droppedFiles.length > 0) {
        handleAddFiles(droppedFiles);
      }
    }
  };

  // Tauri: dropped or picked paths. Folders are expanded (recursively) by the backend,
  // which also reports sizes; only paths are kept, the audio is read when needed.
  const addPaths = (paths: string[]) => {
    if (paths.length === 0) return;
    AppBridge.expandDroppedPaths(paths, SUPPORTED_INPUT_EXTENSIONS)
      .then(async ({ files: found, truncated }) => {
        if (found.length === 0) {
          showToast('info', lang === 'ja' ? '対応している音声ファイルが見つかりませんでした。' : 'No supported audio files were found.');
          return;
        }
        await handleAddFiles(found.map(f => pathOnlyFile(f.path, f.name, f.size)));
        // Shown after the add finished, so the "added" message does not replace it.
        if (truncated) {
          const message = lang === 'ja'
            ? `一度に追加できるのは ${found.length} ファイルまでです。残りは追加されていません。`
            : `Up to ${found.length} files can be added at once; the rest were not added.`;
          addLog(message, 'error');
          showToast('error', message);
        }
      })
      .catch((err) => console.warn('Cannot read dropped paths:', err));
  };
  const pickPaths = (folders: boolean) => {
    if (!isTauri()) {
      (folders ? folderInputRef : fileInputRef).current?.click();
      return;
    }
    AppBridge.pickAudioPaths(folders, SUPPORTED_INPUT_EXTENSIONS)
      .then(addPaths)
      .catch((err) => console.warn('Cannot open the file picker:', err));
  };

  // Register the native drop listener once; call the latest handler through a ref.
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/webviewWindow')
      .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        addPathsRef.current(event.payload.paths || []);
      }))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatDuration = (seconds: number) => {
    if (isNaN(seconds) || seconds === 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Helper lists for the format radio inputs
  // Only formats the converter can write.
  const allFormats = ['MP3', 'Ogg', 'WMA', 'FLAC', 'WavPack', 'WAV', 'Opus', 'ALAC', 'AC3', 'AIFF', 'M4A', 'DSF'];

  const actionModes = [
    { id: 'encode', label: lang === 'ja' ? 'エンコード' : 'Encode' },
    { id: 'extract', label: lang === 'ja' ? '抽出' : 'Extract' },
    { id: 'merge', label: lang === 'ja' ? '結合/CUE' : 'Merge/CUE' },
    { id: 'split', label: lang === 'ja' ? 'チャンネル毎のファイルに分割' : 'Split by channels' },
    { id: 'encode_multi', label: lang === 'ja' ? '多重チャンネルファイルにエンコード' : 'Encode multi-channel' },
    { id: 'copy', label: lang === 'ja' ? 'コピー' : 'Copy' },
  ];

  const updateSetting = <K extends keyof typeof settings>(key: K, val: typeof settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: val }));
  };

  const currentProgress = files.length > 0
    ? Math.round(files.reduce((acc, f) => acc + f.progress, 0) / files.length)
    : 0;

  return (
    <>
      <Head>
        <title>Audio Convert</title>
      </Head>

      <div className="flex-1 flex flex-col justify-between overflow-hidden bg-zinc-950 text-zinc-300 h-screen font-sans">
        
        {/* ======================================================== */}
        {/* TOP TAB BAR (Multi-Job Tabs) */}
        {/* ======================================================== */}
        <div className="bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-3 select-none shrink-0 h-10">
          <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none h-full pt-1">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const isEditing = tab.id === editingTabId;
              return (
                <div
                  key={tab.id}
                  onClick={() => !isEditing && setActiveTabId(tab.id)}
                  onDoubleClick={() => startEditingTab(tab.id, tab.name)}
                  className={`flex items-center gap-2 h-9 px-3 text-xs border-t-2 rounded-t-md cursor-pointer transition-all duration-150 ${
                    isActive 
                      ? 'bg-zinc-950 text-white border-t-emerald-500 font-bold border-x border-zinc-800' 
                      : 'bg-zinc-900/60 hover:bg-zinc-800/40 text-zinc-400 border-t-transparent border-x border-transparent'
                  }`}
                >
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingTabName}
                      onChange={(e) => setEditingTabName(e.target.value)}
                      onBlur={() => finishEditingTab(tab.id)}
                      onKeyDown={(e) => handleTabNameKeyDown(e, tab.id)}
                      className="bg-zinc-900 border border-zinc-700 text-white px-1 py-0.5 rounded text-[11px] focus:outline-none focus:border-emerald-500 w-24"
                      autoFocus
                    />
                  ) : (
                    <span className="truncate max-w-[100px]">{tab.name}</span>
                  )}
                  {tabs.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveTab(tab.id);
                      }}
                      className="hover:text-red-400 text-zinc-500 text-[10px] ml-1 cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
            <button
              onClick={() => handleAddTab()}
              className="p-1 text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800 rounded transition-colors cursor-pointer ml-1"
              title="Add conversion profile tab"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center gap-4 text-xs select-none">
            {/* Language Selector Toggle */}
            <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-zinc-400 gap-1 shrink-0">
              <button
                onClick={() => setLang('ja')}
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold transition-all cursor-pointer ${
                  lang === 'ja' ? 'bg-emerald-600 text-white' : 'hover:text-zinc-200'
                }`}
              >
                JA
              </button>
              <button
                onClick={() => setLang('en')}
                className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold transition-all cursor-pointer ${
                  lang === 'en' ? 'bg-emerald-600 text-white' : 'hover:text-zinc-200'
                }`}
              >
                EN
              </button>
            </div>
            
            <button
              onClick={() => setShowDonateModal(true)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-amber-400/30 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20 text-[10px] font-semibold transition-colors cursor-pointer"
              title={lang === 'ja' ? 'Buy Me a Coffee で開発者を支援' : 'Support the developer on Buy Me a Coffee'}
            >
              <Coffee className="h-3.5 w-3.5 text-amber-400" />
              <span>{lang === 'ja' ? '支援' : 'Support'}</span>
            </button>

            <div className="flex items-center gap-2 font-sans font-bold text-white">
              <Volume2 className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>Audio Convert</span>
            </div>
          </div>
        </div>

        {/* ======================================================== */}
        {/* TOOLBAR: File pickers & Audio Player */}
        {/* ======================================================== */}
        <div className="bg-zinc-950 border-b border-zinc-900 px-4 py-2 flex items-center justify-between gap-4 shrink-0 text-xs select-none">
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Import Buttons */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="audio/*"
              onChange={(e) => e.target.files && handleAddFiles(e.target.files)}
              className="hidden"
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              // @ts-ignore
              webkitdirectory=""
              directory=""
              onChange={(e) => e.target.files && handleAddFiles(e.target.files)}
              className="hidden"
            />
            <button
              onClick={() => pickPaths(false)}
              className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded font-semibold text-zinc-200 transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5 text-emerald-400" />
              <span>{t(lang, 'addFiles')}</span>
            </button>
            <button
              onClick={() => pickPaths(true)}
              className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded font-semibold text-zinc-200 transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Upload className="h-3.5 w-3.5 text-emerald-400" />
              <span>{t(lang, 'addFolder')}</span>
            </button>
            <button
              onClick={() => {
                setFiles([]);
                setSelectedFileId(null);
                addLog(lang === 'ja' ? 'キューをクリアしました。' : 'Cleared conversion queue.');
              }}
              disabled={files.length === 0}
              className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-30 border border-zinc-800 rounded text-zinc-400 hover:text-red-400 transition-colors cursor-pointer"
            >
              {t(lang, 'clearQueue')}
            </button>
            <button
              onClick={() => handleResetQueueStatus()}
              disabled={files.length === 0}
              title={t(lang, 'resetQueueTooltip')}
              className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-30 border border-zinc-800 rounded text-zinc-200 hover:text-emerald-400 transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5 text-cyan-400" />
              <span>{t(lang, 'resetQueueBtn')}</span>
            </button>

          </div>

          {/* Top-Right Player bar */}
          <div className="flex items-center gap-3 bg-zinc-900/60 border border-zinc-850 px-3 py-1 rounded-lg max-w-md w-full">
            <span className="text-[10px] font-mono text-zinc-500 shrink-0 w-24 truncate" title={selectedFile?.name || (lang === 'ja' ? '選択なし' : 'None')}>
              {selectedFile ? selectedFile.name : (lang === 'ja' ? 'トラック選択なし' : 'No track selected')}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Skip Back */}
              <button 
                onClick={playPrevTrack} 
                disabled={files.length === 0}
                className="p-1 hover:bg-zinc-800 hover:text-white rounded disabled:opacity-20 text-zinc-400 cursor-pointer"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>
              </button>
              {/* Play / Pause */}
              <button
                onClick={togglePlayback}
                disabled={!selectedFile}
                className="p-1 hover:bg-zinc-800 hover:text-white rounded disabled:opacity-20 text-zinc-400 cursor-pointer"
              >
                {isPlaying ? (
                  <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                ) : (
                  <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                )}
              </button>
              {/* Stop */}
              <button 
                onClick={stopPlayback} 
                disabled={!selectedFile}
                className="p-1 hover:bg-zinc-800 hover:text-white rounded disabled:opacity-20 text-zinc-400 cursor-pointer"
              >
                <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>
              </button>
              {/* Skip Forward */}
              <button 
                onClick={playNextTrack} 
                disabled={files.length === 0}
                className="p-1 hover:bg-zinc-800 hover:text-white rounded disabled:opacity-20 text-zinc-400 cursor-pointer"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
              </button>
            </div>
            {/* Playback seeking range */}
            <input
              type="range"
              min="0"
              max="1"
              step="0.001"
              value={playbackProgress}
              onChange={handleSeekChange}
              disabled={!selectedFile}
              className="flex-1 accent-emerald-500 bg-zinc-950 h-1 rounded-full cursor-pointer disabled:opacity-25"
            />
            {/* Playback time text */}
            <span className="text-[10px] font-mono text-zinc-400 shrink-0">
              {formatDuration(playbackTime)}/{formatDuration(selectedFile?.duration || 0)}
            </span>
            <div className="flex items-center gap-1.5 shrink-0 border-l border-zinc-800 pl-2">
              <span className="text-[9px] font-mono text-zinc-600">VOL</span>
              <input
                type="range"
                min="0"
                max="1.2"
                step="0.05"
                value={volume}
                onChange={handleVolumeChange}
                className="w-12 accent-emerald-500 bg-zinc-950 h-0.5 rounded-full cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* ======================================================== */}
        {/* MIDDLE SECTION: FILE LIST VIEWPORT */}
        {/* ======================================================== */}
        <div 
          ref={listRef}
          onScroll={updateListView}
          // The spacer rows change size while scrolling; the browser must not move the
          // scroll position to compensate.
          style={{ overflowAnchor: 'none' }}
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          className={`flex-1 overflow-auto p-4 select-none relative ${
            dragActive ? 'bg-zinc-900/40 border-2 border-dashed border-emerald-500/50' : ''
          }`}
        >
          {files.length > 0 ? (
            <div className="border border-zinc-850 rounded-lg overflow-hidden bg-zinc-900/40 shadow-xl">
              <table className="w-full text-left border-collapse min-w-[1200px]">
                <thead>
                  <tr className="border-b border-zinc-800/80 bg-zinc-900 text-[10px] font-mono text-zinc-500 font-semibold uppercase tracking-wider">
                    <th className="py-2.5 px-3 w-10 text-center">#</th>
                    <th className="py-2.5 px-3">{lang === 'ja' ? '入力ファイル名' : 'Input Filename'}</th>
                    <th className="py-2.5 px-3">{lang === 'ja' ? '出力ファイル名' : 'Output Filename'}</th>
                    <th className="py-2.5 px-3 w-28">{lang === 'ja' ? 'サイズ (IN → EST)' : 'Size (IN → EST)'}</th>
                    <th className="py-2.5 px-3 w-24">{lang === 'ja' ? 'コーデック' : 'Codec'}</th>
                    <th className="py-2.5 px-3 w-20">{lang === 'ja' ? '再生時間' : 'Duration'}</th>
                    <th className="py-2.5 px-3 w-20">{lang === 'ja' ? 'チャンネル' : 'Channels'}</th>
                    <th className="py-2.5 px-3 w-20">{lang === 'ja' ? 'サンプルレート' : 'Sample Rate'}</th>
                    <th className="py-2.5 px-3 w-18">{lang === 'ja' ? 'ビットレート' : 'Bitrate'}</th>
                    <th className="py-2.5 px-3 w-18">{lang === 'ja' ? 'ピーク値' : 'Peak'}</th>
                    <th className="py-2.5 px-3 w-20">{lang === 'ja' ? '音量調整' : 'Gain'}</th>
                    <th className="py-2.5 px-3 w-44">{lang === 'ja' ? 'ステータス' : 'Status'}</th>
                    <th className="py-2.5 px-3 w-16 text-center">{t(lang, 'colActions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/30 text-[11px] font-mono">
                  {(() => {
                    // Spacer rows stand in for the rows out of view. Every row is exactly
                    // ROW px high (the status cell does not wrap), so the spacers match.
                    // Short lists are drawn whole.
                    const ROW = QUEUE_ROW_HEIGHT;
                    const windowed = files.length > 200;
                    const first = windowed ? Math.max(0, Math.floor((listView.top - 60) / ROW) - 20) : 0;
                    const last = windowed ? Math.min(files.length, Math.ceil((listView.top + listView.height) / ROW) + 20) : files.length;
                    return (<>
                      {first > 0 && <tr aria-hidden style={{ height: first * ROW }}><td colSpan={13} /></tr>}
                  {files.slice(first, last).map((file, offset) => {
                    const index = first + offset;
                    const isSelected = selectedFileId === file.id;
                    const estSize = estimateOutputSize(file.duration, {
                      ...settings,
                      outputFormat: file.outputFormat as any,
                    });
                    
                    return (
                      <tr
                        key={file.id}
                        style={{ height: QUEUE_ROW_HEIGHT }}
                        onClick={() => setSelectedFileId(file.id)}
                        // One line per cell, so every row is exactly QUEUE_ROW_HEIGHT.
                        className={`hover:bg-zinc-800/40 cursor-pointer transition-colors duration-100 [&>td]:whitespace-nowrap ${
                          isSelected ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : ''
                        }`}
                      >
                        {/* Index */}
                        <td className="py-2 px-3 text-center text-zinc-600 font-semibold">{index + 1}</td>
                        
                        {/* Input filename */}
                        <td className="py-2 px-3 text-zinc-200 font-medium max-w-[200px] truncate" title={file.name}>
                          {file.name}
                        </td>
                        
                        {/* Output filename rename preview */}
                        <td className="py-2 px-3 text-zinc-400 max-w-[200px] truncate">
                          {(() => {
                            if (file.status === 'completed') {
                              return file.outputFileName || file.name;
                            }
                            // Extract keeps the stream's codec, Copy the file's own extension.
                            const ext = settings.actionMode === 'copy'
                              ? (file.originalFormat || 'bin')
                              : settings.actionMode === 'extract'
                                ? (file.sourceCodec ? extractExtension(file.sourceCodec) : '?')
                                : getFormatExtension(file.outputFormat || settings.outputFormat);
                            const stem = settings.renameByTags && file.tags
                              ? renderFileName(settings.renamePattern, outputTags(file, settings), file.name)
                              : renderFileName('%filename%', {}, file.name);
                            return `${stem}.${ext}`;
                          })()}
                        </td>
                        
                        {/* Size */}
                        <td className="py-2 px-3 text-zinc-400">
                          {formatSize(file.size)} → <span className="text-zinc-500">{estSize.toFixed(2)} MB</span>
                        </td>
                        
                        {/* Format */}
                        <td className="py-2 px-3 text-zinc-300">
                          <span className="text-zinc-300 font-semibold">{file.originalFormat.toUpperCase()}</span> → <span className="text-emerald-500 font-bold">{settings.actionMode === 'extract' || settings.actionMode === 'copy' ? (lang === 'ja' ? 'そのまま' : 'as is') : file.outputFormat}</span>
                        </td>

                        {/* Duration */}
                        <td className="py-2 px-3 text-zinc-400">{formatDuration(file.duration)}</td>
                        
                        {/* Channels */}
                        <td className="py-2 px-3 text-zinc-400">
                          {file.channels === 1 ? 'Mono' : file.channels === 2 ? 'Stereo' : `${file.channels} Ch`}
                        </td>
                        
                        {/* Sample rate */}
                        <td className="py-2 px-3 text-zinc-400">{(((settings.dop && (file.sourceCodec ?? '').startsWith('dsd_') && file.trackStart === undefined && file.channelIndex === undefined
                            && !['extract', 'copy', 'merge', 'encode_multi'].includes(settings.actionMode ?? 'encode')
                            && ['FLAC', 'WAV', 'AIFF'].includes((file.outputFormat || settings.outputFormat).toUpperCase()))
                          // DoP carries DSD at half the rate it decodes to (DSD64: 176.4 kHz).
                          ? (file.sourceSampleRate ?? file.sampleRate) / 2
                          : settings.actionMode === 'extract' || settings.actionMode === 'copy'
                          ? (file.sourceSampleRate ?? file.sampleRate)
                          : outputSampleRate(file.sourceSampleRate ?? file.sampleRate, settings, file.outputFormat || settings.outputFormat)) / 1000).toFixed(1)} kHz</td>

                        {/* Bitrate */}
                        <td className="py-2 px-3 text-zinc-450 text-zinc-500">{settings.bitrate}k</td>

                        {/* Peak Db */}
                        <td className="py-2 px-3 text-zinc-400">
                          {file.peakDb !== undefined ? `${file.peakDb} dB` : '--'}
                        </td>

                        {/* Volume normalize gain */}
                        <td className="py-2 px-3">
                          {file.gainMultiplier ? (
                            <span className="text-amber-500 font-semibold">
                              {file.gainMultiplier > 1 ? '+' : ''}
                              {(20 * Math.log10(file.gainMultiplier)).toFixed(1)} dB
                            </span>
                          ) : (
                            <span className="text-zinc-600">Dry</span>
                          )}
                        </td>

                        {/* Status */}
                        <td className="py-2 px-3">
                          {file.status === 'converting' || file.status === 'normalizing' ? (
                            <div className="flex flex-col gap-1 w-full">
                              <span className="text-[10px] text-emerald-400 uppercase font-bold tracking-tight animate-pulse">
                                {file.status} ({file.progress}%)
                              </span>
                              <div className="w-full bg-zinc-950 rounded-full h-1 border border-zinc-800">
                                <div className="bg-emerald-500 h-1 rounded-full transition-all duration-150" style={{ width: `${file.progress}%` }}></div>
                              </div>
                            </div>
                          ) : file.status === 'completed' ? (
                            <div className="flex items-center gap-1.5 flex-nowrap whitespace-nowrap overflow-hidden">
                              <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-md text-[9px] font-bold">
                                FINISHED
                              </span>
                              {file.isVerifying ? (
                                <span className="px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded-md text-[9px] flex items-center gap-1 animate-pulse">
                                  <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                                  <span>検証中</span>
                                </span>
                              ) : file.verificationResult ? (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedFileId(file.id);
                                    setBottomTab('quality');
                                  }}
                                  className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold border transition-colors cursor-pointer ${
                                    file.verificationResult.exactMatch || file.verificationResult.status === 'perfect'
                                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/30'
                                      : file.verificationResult.status === 'passed'
                                      ? 'bg-blue-500/20 text-blue-300 border-blue-500/40 hover:bg-blue-500/30'
                                      : file.verificationResult.status === 'warning'
                                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30'
                                      : 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30'
                                  }`}
                                  title="品質検証レポートを表示"
                                >
                                  {file.verificationResult.exactMatch || file.verificationResult.status === 'perfect'
                                    ? '✨100%完全一致'
                                    : file.verificationResult.status === 'passed'
                                    ? '🟢品質正常'
                                    : file.verificationResult.status === 'warning'
                                    ? '⚠️変化あり'
                                    : '🔴劣化検出'}
                                </button>
                              ) : null}
                            </div>
                          ) : file.status === 'failed' ? (
                            <span className="px-2 py-0.5 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-md text-[9px] font-bold" title={file.error}>
                              ERROR
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 bg-zinc-850 text-zinc-500 border border-zinc-800 rounded-md text-[9px]">
                              QUEUED
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="py-2 px-3 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFiles(prev => prev.filter(f => f.id !== file.id));
                              if (selectedFileId === file.id) setSelectedFileId(null);
                            }}
                            className="p-1 hover:bg-zinc-800 hover:text-red-400 rounded text-zinc-500 transition-colors cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                      {last < files.length && <tr aria-hidden style={{ height: (files.length - last) * ROW }}><td colSpan={13} /></tr>}
                    </>);
                  })()}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-12 max-w-lg mx-auto gap-4">
              <div className="h-12 w-12 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500 shadow-lg">
                <FileAudio className="h-6 w-6 animate-pulse" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">
                  {lang === 'ja' ? '変換キューは空です' : 'Conversion Queue is Empty'}
                </h3>
                <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
                  {t(lang, 'emptyQueueText')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ======================================================== */}
        {/* BOTTOM TABBED PANEL (Source File / Metadata / Logs) */}
        {/* ======================================================== */}
        <div className="bg-zinc-900 border-t border-zinc-800 flex flex-col shrink-0 overflow-hidden h-[300px]">
          {/* Tab Selector bar */}
          <div className="bg-zinc-900 border-b border-zinc-800 px-4 flex items-center shrink-0 h-9">
            {(['source', 'metadata', 'quality', 'log'] as const).map((tab) => {
              const label = tab === 'source' 
                ? t(lang, 'tabSourceFile') 
                : tab === 'metadata' 
                ? t(lang, 'tabMetadata') 
                : tab === 'quality'
                ? t(lang, 'tabQuality')
                : t(lang, 'tabLog');
              const isActive = bottomTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setBottomTab(tab)}
                  className={`h-full px-4 text-xs font-semibold border-b-2 transition-all cursor-pointer relative ${
                    isActive 
                      ? 'border-emerald-500 text-white font-bold bg-zinc-950/40' 
                      : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {label}
                  {tab === 'quality' && selectedFile?.verificationResult && (
                    <span className={`absolute top-1.5 right-1 h-1.5 w-1.5 rounded-full ${
                      selectedFile.verificationResult.exactMatch ? 'bg-emerald-400' : 'bg-blue-400'
                    }`}></span>
                  )}
                  {tab === 'log' && logs.length > 0 && (
                    <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Panel Content Viewports */}
          <div className="flex-1 bg-zinc-950 overflow-y-auto p-4 text-xs select-none">
            
            {/* 1. SOURCE FILE TAB */}
            {bottomTab === 'source' && (
              <div className="grid grid-cols-1 md:grid-cols-12 gap-5 leading-normal">
                {/* Left column: Path & renaming */}
                <div className="md:col-span-4 space-y-3.5">
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono font-semibold block mb-1">{t(lang, 'outputPath')}</span>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        disabled={settings.saveInSourceFolder}
                        value={settings.saveInSourceFolder ? (lang === 'ja' ? '（ソースフォルダ内）' : '(Inside source folder)') : settings.localSavePath}
                        onChange={(e) => updateSetting('localSavePath', e.target.value)}
                        className={`flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 font-mono text-[11px] focus:outline-none focus:border-emerald-500 ${
                          settings.saveInSourceFolder ? 'opacity-40 cursor-not-allowed text-zinc-500' : 'text-zinc-300'
                        }`}
                      />
                      <button 
                        onClick={async () => {
                          if (AppBridge.isAvailable()) {
                            try {
                              const selectedDir = await AppBridge.selectDirectory();
                              if (selectedDir) updateSetting('localSavePath', selectedDir);
                            } catch (err) {
                              console.warn('Failed to invoke select-directory:', err);
                            }
                          } else {
                            const customPath = prompt(lang === 'ja' ? "ローカルディレクトリパスを入力してください" : "Please enter local directory path", settings.localSavePath);
                            if (customPath) updateSetting('localSavePath', customPath);
                          }
                        }}
                        disabled={settings.saveInSourceFolder}
                        className={`px-2.5 bg-zinc-900 border border-zinc-800 rounded font-semibold transition-colors ${
                          settings.saveInSourceFolder 
                            ? 'opacity-40 cursor-not-allowed text-zinc-500' 
                            : 'hover:bg-zinc-800 text-zinc-300 cursor-pointer'
                        }`}
                        title="Browse save location"
                      >
                        ...
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-zinc-400 cursor-pointer hover:text-zinc-250">
                      <input
                        type="checkbox"
                        checked={settings.deleteOriginalAfterConvert}
                        onChange={(e) => updateSetting('deleteOriginalAfterConvert', e.target.checked)}
                        className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer"
                      />
                      <span>{t(lang, 'moveSourceToBin')}</span>
                    </label>
                    <label className="flex items-center gap-2 text-zinc-400 cursor-pointer hover:text-zinc-250">
                      <input
                        type="checkbox"
                        checked={settings.saveInSourceFolder}
                        onChange={(e) => updateSetting('saveInSourceFolder', e.target.checked)}
                        className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer"
                      />
                      <span>{t(lang, 'createSourceFolder')}</span>
                    </label>
                    <div className={`flex items-center gap-1.5 text-zinc-400 ${settings.saveInSourceFolder ? 'opacity-40' : ''}`}>
                      <span>{t(lang, 'keepFolders')}</span>
                      <select
                        disabled={settings.saveInSourceFolder}
                        value={settings.keepFolderFrom ?? 'last'}
                        onChange={(e) => updateSetting('keepFolderFrom', e.target.value as any)}
                        className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300"
                      >
                        <option value="last">{t(lang, 'keepFoldersLast')}</option>
                        <option value="first">{t(lang, 'keepFoldersFirst')}</option>
                      </select>
                      <input
                        type="number"
                        min={0}
                        max={20}
                        disabled={settings.saveInSourceFolder}
                        value={settings.keepFolderLevels ?? 0}
                        onChange={(e) => updateSetting('keepFolderLevels', Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0))) as any)}
                        className="w-12 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300"
                      />
                      <span>{t(lang, 'keepFoldersLevels')}</span>
                    </div>
                    <label className="flex items-center gap-2 text-zinc-400 cursor-pointer hover:text-zinc-250" title={t(lang, 'splitImagesHelp')}>
                      <input
                        type="checkbox"
                        checked={settings.splitImages ?? true}
                        onChange={(e) => updateSetting('splitImages', e.target.checked)}
                        className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer"
                      />
                      <span>{t(lang, 'splitImages')}</span>
                    </label>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-400">
                      <label className="flex items-center gap-1.5 cursor-pointer" title={t(lang, 'coverExternalHelp')}>
                        <input type="checkbox" checked={settings.coverExternal ?? true} onChange={(e) => updateSetting('coverExternal', e.target.checked)} className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer" />
                        <span>{t(lang, 'coverExternal')}</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={settings.saveCoverFile ?? false} onChange={(e) => updateSetting('saveCoverFile', e.target.checked)} className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer" />
                        <span>{t(lang, 'saveCoverFile')}</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={settings.coverResize ?? false} onChange={(e) => updateSetting('coverResize', e.target.checked)} className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer" />
                        <span>{t(lang, 'coverResize')}</span>
                      </label>
                      <span className={`flex items-center gap-1 ${settings.coverResize ? '' : 'opacity-40'}`}>
                        <input type="number" min={16} max={4000} disabled={!settings.coverResize} value={settings.coverMaxWidth ?? 400}
                          onChange={(e) => updateSetting('coverMaxWidth', Math.max(16, Math.min(4000, Math.floor(Number(e.target.value) || 400))))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        ×
                        <input type="number" min={16} max={4000} disabled={!settings.coverResize} value={settings.coverMaxHeight ?? 400}
                          onChange={(e) => updateSetting('coverMaxHeight', Math.max(16, Math.min(4000, Math.floor(Number(e.target.value) || 400))))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                      </span>
                      <select value={settings.coverFormat ?? 'keep'} onChange={(e) => updateSetting('coverFormat', e.target.value as any)}
                        className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" title={t(lang, 'coverFormat')}>
                        <option value="keep">{t(lang, 'coverFormatKeep')}</option>
                        <option value="jpeg">JPEG</option>
                        <option value="png">PNG</option>
                      </select>
                    </div>
                    {['FLAC', 'WAV', 'AIFF'].includes((settings.outputFormat || '').toUpperCase()) && (
                      <label className="flex items-center gap-2 text-zinc-400 cursor-pointer hover:text-zinc-250" title={t(lang, 'dopHelp')}>
                        <input type="checkbox" checked={settings.dop ?? false} onChange={(e) => updateSetting('dop', e.target.checked)} className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer" />
                        <span>{t(lang, 'dop')}</span>
                      </label>
                    )}
                    {(settings.outputFormat || '').toUpperCase() === 'DSF' && (
                      <span className="text-[10px] text-zinc-500">{t(lang, 'dsfOnlyFromDsd')}</span>
                    )}
                    <div className="flex items-center gap-1.5 text-zinc-400" title={t(lang, 'replayGainHelp')}>
                      <span>ReplayGain:</span>
                      <select
                        value={settings.replayGain ?? 'off'}
                        onChange={(e) => updateSetting('replayGain', e.target.value as any)}
                        className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300"
                      >
                        <option value="off">{t(lang, 'replayGainOff')}</option>
                        <option value="track">{t(lang, 'replayGainTrack')}</option>
                        <option value="album">{t(lang, 'replayGainAlbum')}</option>
                      </select>
                    </div>
                  </div>
                  <div className="pt-1.5 border-t border-zinc-900">
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="flex items-center gap-2 text-zinc-400 cursor-pointer hover:text-zinc-250">
                        <input
                          type="checkbox"
                          checked={settings.renameByTags}
                          onChange={(e) => updateSetting('renameByTags', e.target.checked)}
                          className="rounded border-zinc-900 bg-zinc-900 accent-emerald-500 cursor-pointer"
                        />
                        <span className="font-semibold">{t(lang, 'fileNamePattern')}</span>
                      </label>
                      <button 
                        onClick={() => setShowPatternHelpModal(true)}
                        className="px-2 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 rounded text-zinc-400 text-[10px] cursor-pointer"
                      >
                        {t(lang, 'macHelpBtn')}
                      </button>
                    </div>
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={settings.renamePattern || ''}
                        onChange={(e) => {
                          setSettings((prev) => ({
                            ...prev,
                            renamePattern: e.target.value,
                            renameByTags: true,
                          }));
                        }}
                        placeholder="%disc2%-%track2% %title%|%filename%"
                        className={`flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500 ${
                          !settings.renameByTags ? 'opacity-60' : ''
                        }`}
                      />
                    </div>
                  </div>
                </div>

                {/* Middle column: Output settings & DSP */}
                <div className="md:col-span-4 space-y-4 border-l border-zinc-900 pl-4">
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono font-semibold block mb-1">動作</span>
                    <div className="grid grid-cols-2 gap-2 text-zinc-400">
                      {actionModes.map((act) => (
                        <label key={act.id} className="flex items-center gap-2 cursor-pointer hover:text-zinc-200" title={t(lang, `actionHelp_${act.id}` as any)}>
                          <input
                            type="radio"
                            name="actionMode"
                            checked={(settings.actionMode ?? 'encode') === act.id}
                            onChange={() => updateSetting('actionMode', act.id as any)}
                            className="bg-zinc-900 border-zinc-800 text-emerald-500 accent-emerald-500 cursor-pointer"
                          />
                          <span>{act.label}</span>
                        </label>
                      ))}
                    </div>
                    {settings.actionMode === 'merge' && (
                      <label className="mt-1.5 flex items-center gap-2 text-zinc-400 cursor-pointer hover:text-zinc-250">
                        <input
                          type="checkbox"
                          checked={settings.mergeCreateCue ?? true}
                          onChange={(e) => updateSetting('mergeCreateCue', e.target.checked)}
                          className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer"
                        />
                        <span>{t(lang, 'mergeCreateCue')}</span>
                      </label>
                    )}
                    {settings.actionMode === 'split' && (
                      <div className="mt-1.5 space-y-1 text-[10px] text-zinc-400">
                        <div className="flex items-center gap-1.5">
                          <span>{t(lang, 'channelPattern')}</span>
                          <input
                            type="text"
                            value={settings.channelFilePattern ?? DEFAULT_CHANNEL_PATTERN}
                            onChange={(e) => updateSetting('channelFilePattern', e.target.value)}
                            className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-1.5 py-0.5 font-mono text-[11px] text-zinc-300"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-1" title={t(lang, 'channelNamesHelp')}>
                          {CHANNEL_KEYS.map((k) => (
                            <label key={k} className="flex items-center gap-0.5">
                              <span className="text-zinc-500">{k}</span>
                              <input
                                type="text"
                                value={(settings.channelNames ?? DEFAULT_CHANNEL_NAMES)[k] ?? k}
                                onChange={(e) => updateSetting('channelNames', { ...DEFAULT_CHANNEL_NAMES, ...(settings.channelNames ?? {}), [k]: e.target.value })}
                                className="w-9 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 font-mono text-[10px] text-zinc-300"
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="pt-2 border-t border-zinc-900 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-zinc-500 font-mono font-semibold block">{t(lang, 'outputSettings')}</span>
                      <label className="flex items-center gap-1.5 cursor-pointer text-emerald-400 font-bold bg-emerald-950/40 border border-emerald-800/60 px-2 py-0.5 rounded text-[10px] hover:bg-emerald-900/40 transition">
                        <input
                          type="checkbox"
                          checked={settings.sameAsSource}
                          onChange={(e) => updateSetting('sameAsSource', e.target.checked)}
                          className="rounded border-zinc-900 bg-zinc-900 accent-emerald-500 cursor-pointer h-3 w-3"
                        />
                        <span>{t(lang, 'sameAsSource')}</span>
                      </label>
                    </div>

                    {settings.sameAsSource && (
                      <div className="text-[9px] text-emerald-400/90 bg-emerald-950/20 border border-emerald-900/40 px-2 py-1 rounded italic leading-tight">
                        💡 {t(lang, 'sameAsSourceHint')}
                      </div>
                    )}

                    <div className={`grid grid-cols-2 gap-2 text-zinc-400 transition-all ${settings.sameAsSource ? 'opacity-40 pointer-events-none' : ''}`}>
                      <label className={`flex items-center gap-2 ${settings.sameAsSource ? 'cursor-not-allowed' : 'cursor-pointer hover:text-zinc-200'}`}>
                        <input
                          type="checkbox"
                          disabled={settings.sameAsSource}
                          checked={settings.sameAsSource ? false : settings.normalize}
                          onChange={(e) => updateSetting('normalize', e.target.checked)}
                          className="rounded border-zinc-900 bg-zinc-900 accent-emerald-500 cursor-pointer"
                        />
                        <span>{t(lang, 'normalize')}</span>
                        {settings.normalize && !settings.sameAsSource && (
                          <span className="text-[10px] font-bold text-amber-500">({settings.normalizationTargetDb} dB)</span>
                        )}
                      </label>
                      <label className={`flex items-center gap-2 ${settings.sameAsSource ? 'cursor-not-allowed' : 'cursor-pointer hover:text-zinc-200'}`}>
                        <input
                          type="checkbox"
                          disabled={settings.sameAsSource}
                          checked={settings.sameAsSource ? false : !!settings.tempoEnabled}
                          onChange={(e) => updateSetting('tempoEnabled', e.target.checked)}
                          className="rounded border-zinc-900 bg-zinc-900 accent-emerald-500 cursor-pointer"
                        />
                        <span>{t(lang, 'tempo')}</span>
                      </label>
                      <label className={`flex items-center gap-2 ${settings.sameAsSource ? 'cursor-not-allowed' : 'cursor-pointer hover:text-zinc-200'}`}>
                        <input
                          type="checkbox"
                          disabled={settings.sameAsSource}
                          checked={settings.sameAsSource ? false : !!settings.fadeEnabled}
                          onChange={(e) => updateSetting('fadeEnabled', e.target.checked)}
                          className="rounded border-zinc-900 bg-zinc-900 accent-emerald-500 cursor-pointer"
                        />
                        <span>{t(lang, 'fade')}</span>
                      </label>
                      <label className={`flex items-center gap-2 ${settings.sameAsSource ? 'cursor-not-allowed' : 'cursor-pointer hover:text-zinc-200'}`}>
                        <input
                          type="checkbox"
                          disabled={settings.sameAsSource}
                          checked={settings.sameAsSource ? false : settings.trimSilence}
                          onChange={(e) => updateSetting('trimSilence', e.target.checked)}
                          className="rounded border-zinc-900 bg-zinc-900 accent-emerald-500 cursor-pointer"
                        />
                        <span>{t(lang, 'trimSilence')}</span>
                      </label>
                    </div>
                    {!settings.sameAsSource && settings.tempoEnabled && (
                      <div className="flex items-center gap-1.5 text-[10px] text-zinc-400" title={t(lang, 'tempoHelp')}>
                        <span>{t(lang, 'tempo')}:</span>
                        <input type="number" step={0.001} min={1} max={1000} value={settings.tempoFrom ?? 0}
                          onChange={(e) => updateSetting('tempoFrom', Math.max(1, Math.min(1000, Number(e.target.value) || 0)))}
                          className="w-16 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span>→</span>
                        <input type="number" step={0.001} min={1} max={1000} value={settings.tempoTo ?? 0}
                          onChange={(e) => updateSetting('tempoTo', Math.max(1, Math.min(1000, Number(e.target.value) || 0)))}
                          className="w-16 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span className="text-zinc-500">×{((settings.tempoTo ?? 23.976) / (settings.tempoFrom || 25)).toFixed(4)}</span>
                      </div>
                    )}
                    {!settings.sameAsSource && settings.fadeEnabled && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
                        <span>{t(lang, 'fadeIn')}</span>
                        <input type="number" step={0.1} min={0} max={60} value={settings.fadeInSeconds ?? 0}
                          onChange={(e) => updateSetting('fadeInSeconds', Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span>{t(lang, 'fadeOut')}</span>
                        <input type="number" step={0.1} min={0} max={60} value={settings.fadeOutSeconds ?? 0}
                          onChange={(e) => updateSetting('fadeOutSeconds', Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span>{t(lang, 'padStart')}</span>
                        <input type="number" step={0.1} min={0} max={60} value={settings.padStartSeconds ?? 0}
                          onChange={(e) => updateSetting('padStartSeconds', Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span>{t(lang, 'padEnd')}</span>
                        <input type="number" step={0.1} min={0} max={60} value={settings.padEndSeconds ?? 0}
                          onChange={(e) => updateSetting('padEndSeconds', Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span className="text-zinc-500">{t(lang, 'seconds')}</span>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400" title={t(lang, 'splitByHelp')}>
                      <span>{t(lang, 'splitBy')}:</span>
                      <select value={settings.splitBy ?? 'off'} onChange={(e) => updateSetting('splitBy', e.target.value as any)}
                        className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300">
                        <option value="off">{t(lang, 'splitOff')}</option>
                        <option value="time">{t(lang, 'splitTime')}</option>
                        <option value="silence">{t(lang, 'splitSilence')}</option>
                      </select>
                      {settings.splitBy === 'time' && (<>
                        <input type="number" step={1} min={1} max={86400} value={settings.splitSeconds ?? 0}
                          onChange={(e) => updateSetting('splitSeconds', Math.max(1, Math.min(86400, Number(e.target.value) || 0)))}
                          className="w-16 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span>{t(lang, 'seconds')}</span>
                      </>)}
                      {settings.splitBy === 'silence' && (<>
                        <input type="number" step={1} min={-120} max={0} value={settings.splitThresholdDb ?? 0}
                          onChange={(e) => updateSetting('splitThresholdDb', Math.max(-120, Math.min(0, Number(e.target.value) || 0)))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span>dB</span>
                        <span>{t(lang, 'splitMinSilence')}</span>
                        <input type="number" step={0.1} min={0.05} max={60} value={settings.splitMinSilence ?? 0}
                          onChange={(e) => updateSetting('splitMinSilence', Math.max(0.05, Math.min(60, Number(e.target.value) || 0)))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <span>{t(lang, 'splitMinLength')}</span>
                        <input type="number" step={1} min={0} max={3600} value={settings.splitMinLength ?? 0}
                          onChange={(e) => updateSetting('splitMinLength', Math.max(0, Math.min(3600, Number(e.target.value) || 0)))}
                          className="w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[11px] text-zinc-300" />
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input type="checkbox" checked={settings.splitPreservePauses ?? false} onChange={(e) => updateSetting('splitPreservePauses', e.target.checked)}
                            className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer" />
                          <span>{t(lang, 'splitPreservePauses')}</span>
                        </label>
                      </>)}
                    </div>
                    {/* Normalizer Target Adjustment */}
                    {settings.normalize && !settings.sameAsSource && (
                      <div className="flex items-center gap-3 bg-zinc-900/40 p-1.5 rounded border border-zinc-900">
                        <span className="text-[9px] font-mono text-zinc-500 uppercase">{t(lang, 'targetDb')}</span>
                        <input
                          type="range"
                          min="-15"
                          max="-0.1"
                          step="0.5"
                          value={settings.normalizationTargetDb}
                          onChange={(e) => updateSetting('normalizationTargetDb', parseFloat(e.target.value))}
                          className="flex-1 accent-emerald-500 h-1 cursor-pointer bg-zinc-950"
                        />
                        <span className="text-[10px] font-mono text-emerald-400 font-bold shrink-0">
                          {settings.normalizationTargetDb} dB
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right column: Format matrix with inline config button */}
                <div className="md:col-span-4 space-y-2 border-l border-zinc-900 pl-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-zinc-500 font-mono font-semibold block">{t(lang, 'outputFormat')}</span>
                    <button
                      onClick={() => setShowConfigModal(true)}
                      className="px-2 py-0.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-emerald-400 rounded text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Settings className="h-3 w-3" />
                      <span>{t(lang, 'encoderDetails')}</span>
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-x-2 gap-y-1.5 bg-zinc-900/20 p-2.5 rounded-lg border border-zinc-900/60 max-h-[170px] overflow-y-auto">
                    {allFormats.map((fmt) => {
                      const displayFmt = fmt === 'Ogg' ? 'OGG' : fmt;
                      const isSelected = settings.outputFormat.toUpperCase() === displayFmt.toUpperCase();
                      return (
                        <label 
                          key={fmt} 
                          className={`flex items-center gap-2 cursor-pointer transition-colors ${
                            isSelected 
                              ? 'text-emerald-400 font-bold' 
                              : 'text-zinc-300 hover:text-zinc-100'
                          }`}
                          onClick={() => {
                            updateSetting('outputFormat', displayFmt as any);
                            addLog(`Output format updated to ${displayFmt}.`);
                          }}
                        >
                          <input
                            type="radio"
                            name="outputFormat"
                            checked={isSelected}
                            readOnly
                            className="bg-zinc-900 border-zinc-800 text-emerald-500 accent-emerald-500 cursor-pointer h-3 w-3"
                          />
                          <span className="text-[11px] font-mono tracking-tight">{fmt}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* 2. METADATA & WAVEFORM EDIT TAB */}
            {bottomTab === 'metadata' && (<>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-5 leading-normal">
                {selectedFile ? (
                  <>
                    {/* Left: Waveform visualizer */}
                    <div className="md:col-span-5 space-y-2">
                      <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono pb-1 border-b border-zinc-900">
                        <span>{t(lang, 'waveformAnalyzer')} ({formatDuration(selectedFile.duration)})</span>
                        <span className="text-zinc-400">{selectedFile.peakDb !== undefined ? `Peak: ${selectedFile.peakDb} dBFS` : t(lang, 'noPeakScan')}</span>
                      </div>
                      <div className="relative rounded overflow-hidden border border-zinc-900 bg-zinc-950 h-28">
                        <canvas
                          ref={canvasRef}
                          width={450}
                          height={110}
                          className="w-full h-full bg-zinc-950 block"
                        />
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <button
                          onClick={togglePlayback}
                          className={`px-3 py-1 rounded font-mono text-[10px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
                            isPlaying
                              ? 'bg-rose-600/10 border-rose-500/20 text-rose-400 hover:bg-rose-600/20'
                              : 'bg-emerald-600/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-600/20'
                          }`}
                        >
                          {isPlaying ? t(lang, 'pauseAudit') : t(lang, 'playAudit')}
                        </button>
                        <span className="text-[10px] text-zinc-500 font-mono">RMS: {selectedFile.rmsDb || '--'} dBFS</span>
                      </div>
                    </div>

                    {/* Right: Metadata tag forms */}
                    <div className="md:col-span-7 space-y-3.5 border-l border-zinc-900 pl-5">
                      <div className="grid grid-cols-5 gap-3">
                        <div className="col-span-3 space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'titleLabel')}</label>
                          <input
                            type="text"
                            value={tags.title}
                            onChange={(e) => setTags({ ...tags, title: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                        <div className="col-span-1 space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'discLabel')}</label>
                          <input
                            type="text"
                            value={tags.disc}
                            onChange={(e) => setTags({ ...tags, disc: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                        <div className="col-span-1 space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'trackLabel')}</label>
                          <input
                            type="text"
                            value={tags.track}
                            onChange={(e) => setTags({ ...tags, track: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'artistLabel')}</label>
                          <input
                            type="text"
                            value={tags.artist}
                            onChange={(e) => setTags({ ...tags, artist: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'albumArtistLabel')}</label>
                          <input
                            type="text"
                            value={tags.albumArtist}
                            onChange={(e) => setTags({ ...tags, albumArtist: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                        <div className="space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'albumLabel')}</label>
                          <input
                            type="text"
                            value={tags.album}
                            onChange={(e) => setTags({ ...tags, album: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-1 space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'yearLabel')}</label>
                          <input
                            type="text"
                            value={tags.year}
                            onChange={(e) => setTags({ ...tags, year: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                        <div className="col-span-2 space-y-0.5">
                          <label className="text-zinc-500 font-mono text-[9px]">{t(lang, 'genreLabel')}</label>
                          <input
                            type="text"
                            value={tags.genre}
                            onChange={(e) => setTags({ ...tags, genre: e.target.value })}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-zinc-300 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                          />
                        </div>
                      </div>
                      <div className="flex justify-between items-center pt-1">
                        <span className="text-[10px] text-zinc-500 italic">{t(lang, 'metaWriteDesc')}</span>
                        <button
                          onClick={handleSaveTags}
                          className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-[10px] font-semibold rounded flex items-center gap-1.5 border border-emerald-500 transition-all cursor-pointer shadow-md shadow-black/20"
                        >
                          <Save className="h-3.5 w-3.5" />
                          <span>{t(lang, 'metaWriteBtn')}</span>
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="col-span-12 py-10 text-center flex flex-col items-center justify-center gap-2">
                    <Info className="h-5 w-5 text-zinc-550" />
                    <p className="text-zinc-500 text-xs">{t(lang, 'metaSelectTrackDesc')}</p>
                  </div>
                )}
              </div>
              {/* Tag replacement rules (xrecode tagsreplace.txt format), for every output of this tab */}
              <div className="mt-4 pt-3 border-t border-zinc-900 space-y-1.5">
                <label className="flex items-center gap-2 text-[11px] text-zinc-300 font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.tagReplaceEnabled ?? false}
                    onChange={(e) => updateSetting('tagReplaceEnabled', e.target.checked)}
                    className="rounded border-zinc-800 bg-zinc-900 accent-emerald-500 cursor-pointer"
                  />
                  <span>{t(lang, 'tagRules')}</span>
                </label>
                <textarea
                  // Edited locally and saved when the field loses focus: every saved change
                  // rewrites the settings file and re-applies the rules to the queue.
                  key={`${activeTabId}:${settings.tagReplaceRules ?? ''}`}
                  defaultValue={settings.tagReplaceRules ?? ''}
                  onBlur={(e) => { if (e.target.value !== (settings.tagReplaceRules ?? '')) updateSetting('tagReplaceRules', e.target.value); }}
                  rows={5}
                  spellCheck={false}
                  placeholder={'[*]\nFeaturing=Ft.\n[Comments]\n<NULL>=Converted %y%-%m%-%d%\n[Genre]\n%CHANGECASE%=CapitalizEeachWord'}
                  className={`w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-[11px] text-zinc-300 font-mono select-text focus:border-emerald-500 focus:outline-none ${settings.tagReplaceEnabled ? '' : 'opacity-60'}`}
                />
                <span className="text-[10px] text-zinc-500 font-mono leading-tight block">{t(lang, 'tagRulesHelp')}</span>
              </div>
            </>)}

            {/* 3. LOG CONSOLE TAB */}
            {bottomTab === 'log' && (
              <div className="flex flex-col h-[220px]">
                <div className="flex items-center justify-between pb-1.5 border-b border-zinc-900 shrink-0">
                  <span className="text-[10px] font-mono text-zinc-500">CONVERSION RUN LOGS (CURRENT TAB PROFILE)</span>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 hover:text-zinc-300 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={showDebugLogs}
                        onChange={(e) => setShowDebugLogs(e.target.checked)}
                        className="rounded border-zinc-800 bg-zinc-950 accent-emerald-500 cursor-pointer h-3 w-3"
                      />
                      <span>{t(lang, 'showDebugLogs')}</span>
                    </label>
                    <button
                      onClick={clearLogs}
                      className="text-[10px] font-mono text-zinc-500 hover:text-red-400 cursor-pointer"
                    >
                      {t(lang, 'clearLogs')}
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto mt-2 bg-zinc-950 font-mono text-[11px] p-3 rounded-lg border border-zinc-900 select-text leading-relaxed">
                  {logs.filter(log => showDebugLogs || !log.message.startsWith('[DEBUG]')).length > 0 ? (
                    <div className="space-y-1">
                      {(() => {
                        const shown = logs.filter(log => showDebugLogs || !log.message.startsWith('[DEBUG]'));
                        return shown.length > 500 ? (
                          <div className="text-zinc-600 italic">{lang === 'ja' ? `古いログ ${shown.length - 500} 件は表示を省略しています。` : `${shown.length - 500} older entries are not shown.`}</div>
                        ) : null;
                      })()}
                      {logs
                        .filter(log => showDebugLogs || !log.message.startsWith('[DEBUG]'))
                        .slice(-500)
                        .map((log) => (
                          <div key={log.id} className="flex items-start gap-2">
                            <span className="text-zinc-650 shrink-0">[{log.timestamp}]</span>
                            <span className={
                              log.type === 'success' 
                                ? 'text-emerald-400 font-semibold' 
                                : log.type === 'error' 
                                ? 'text-rose-400 font-bold' 
                                : 'text-zinc-400'
                            }>
                              {log.message}
                            </span>
                          </div>
                        ))}
                      <div ref={logEndRef} />
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center text-zinc-600 italic select-none">
                      {t(lang, 'noLogs')}
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>

        {/* ======================================================== */}
        {/* FOOTER BAR (Global Controls) */}
        {/* ======================================================== */}
        <div className="bg-zinc-900 border-t border-zinc-800 px-4 py-3 shrink-0 select-none text-xs">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 text-zinc-500" />
                <span className="text-zinc-400">{t(lang, 'globalPreset')}</span>
                <span className="px-2 py-0.5 bg-zinc-950 border border-zinc-800 rounded text-emerald-400 font-bold font-mono">
                  {settings.outputFormat}
                </span>
                <span className="text-zinc-500 font-mono text-[10px]">
                  {settings.actionMode === 'extract' || settings.actionMode === 'copy'
                    ? (settings.actionMode === 'extract' ? 'Extract (no re-encoding)' : 'Copy (no re-encoding)')
                  : LOSSLESS_OUTPUT_FORMATS.includes((settings.outputFormat || '').toUpperCase())
                    ? `${settings.sameAsSource ? 'Lossless (Same as Source)' : `${settings.bitDepth}-bit Lossless`}${settings.actionMode === 'split' ? ' · mono per channel' : settings.actionMode === 'encode_multi' ? ' · joined channels' : ''}`
                    : settings.bitrateMode === 'vbr' && VBR_FORMATS.includes((settings.outputFormat || '').toUpperCase())
                      ? `VBR V${settings.vbrQuality ?? 2}`
                      : `${settings.bitrate} kbps`
                  }
                </span>
              </div>
              <div className="flex items-center gap-2 border-l border-zinc-800 pl-6">
                <Volume2 className="h-4 w-4 text-zinc-500" />
                <span className="text-zinc-400">{t(lang, 'normalizationLevel')}</span>
                <span className={`px-1.5 py-0.5 border rounded text-[10px] font-mono font-bold ${
                  settings.normalize && !settings.sameAsSource
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' 
                    : 'bg-zinc-950 border-zinc-800 text-zinc-500'
                }`}>
                  {settings.normalize && !settings.sameAsSource ? `ACTIVE (${settings.normalizationTargetDb} dB)` : 'BYPASS'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Batch progress ring */}
              {isConverting && (
                <div className="flex flex-col gap-1 w-32 shrink-0">
                  <div className="flex justify-between text-[9px] font-mono">
                    <span className="text-zinc-500">{t(lang, 'totalProgress')}</span>
                    <span className="text-emerald-400 font-bold">{currentProgress}%</span>
                  </div>
                  <div className="w-full bg-zinc-950 rounded-full h-1 border border-zinc-800">
                    <div className="bg-emerald-500 h-1 rounded-full transition-all duration-300" style={{ width: `${currentProgress}%` }}></div>
                  </div>
                </div>
              )}

            {/* 3. QUALITY AUDIT TAB */}
            {bottomTab === 'quality' && (
              <div className="h-full flex flex-col space-y-3 font-mono text-xs">
                <div className="flex items-center justify-between border-b border-zinc-900 pb-2 shrink-0">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    <span className="font-bold text-white text-xs">{t(lang, 'qualityTitle')}</span>
                  </div>
                  {selectedFile && (
                    <button
                      onClick={() => handleVerifyQuality(selectedFile.id)}
                      disabled={selectedFile.isVerifying || !selectedFile.path}
                      className="px-3 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 rounded text-[11px] font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-30 cursor-pointer"
                    >
                      <RefreshCw className={`h-3 w-3 ${selectedFile.isVerifying ? 'animate-spin' : ''}`} />
                      <span>{selectedFile.isVerifying ? t(lang, 'verifyingText') : t(lang, 'reverifyBtn')}</span>
                    </button>
                  )}
                </div>

                {!selectedFile ? (
                  <div className="flex-1 flex items-center justify-center text-zinc-500 text-xs py-8">
                    {t(lang, 'qualitySelectTrackDesc')}
                  </div>
                ) : !selectedFile.verificationResult ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 text-xs py-8 space-y-3">
                    <p>{lang === 'ja' ? 'このファイルの品質検証レポートはまだ生成されていません。' : 'No quality report available for this track.'}</p>
                    <button
                      onClick={() => handleVerifyQuality(selectedFile.id)}
                      disabled={selectedFile.isVerifying || !selectedFile.path}
                      className="px-4 py-1.5 bg-emerald-600 text-white font-bold rounded text-xs hover:bg-emerald-500 transition-colors flex items-center gap-2 cursor-pointer"
                    >
                      <ShieldCheck className="h-4 w-4" />
                      <span>{selectedFile.isVerifying ? t(lang, 'verifyingText') : t(lang, 'reverifyBtn')}</span>
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 overflow-y-auto pr-1">
                    {/* Overall Summary Card */}
                    <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-3 space-y-2.5">
                      <div className="flex items-center justify-between border-b border-zinc-800/60 pb-2">
                        <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">検証ステータス & 判定サマリー</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          selectedFile.verificationResult.status === 'perfect'
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : selectedFile.verificationResult.status === 'passed'
                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                            : selectedFile.verificationResult.status === 'warning'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        }`}>
                          {selectedFile.verificationResult.exactMatch
                            ? t(lang, 'qualityBadgePerfect')
                            : selectedFile.verificationResult.status === 'passed'
                            ? t(lang, 'qualityBadgePassed')
                            : selectedFile.verificationResult.status === 'warning'
                            ? t(lang, 'qualityBadgeWarning')
                            : t(lang, 'qualityBadgeDegraded')}
                        </span>
                      </div>

                      <div className="text-white text-xs font-semibold">
                        {selectedFile.verificationResult.summaryMessage}
                      </div>

                      <div className="space-y-1.5 pt-2 border-t border-zinc-800/40 text-[11px]">
                        <div className="flex justify-between">
                          <span className="text-zinc-500">波形類似度 (相関率):</span>
                          <span className="text-emerald-400 font-bold">{selectedFile.verificationResult.correlationPercent == null ? '未測定' : `${selectedFile.verificationResult.correlationPercent}%`}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-500">S/N比 (Signal-to-Noise Ratio):</span>
                          <span className="text-zinc-200 font-mono">{selectedFile.verificationResult.snrDb} dB</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-500">最大波形差分 (Peak Difference):</span>
                          <span className="text-zinc-200 font-mono">{selectedFile.verificationResult.maxDiffDb} dB</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-500">高音域カットオフ (Cutoff):</span>
                          <span className={selectedFile.verificationResult.hasHighFreqCutoff ? 'text-amber-400 font-bold' : 'text-zinc-400'}>
                            {selectedFile.verificationResult.hasHighFreqCutoff ? `検出あり (~${(selectedFile.verificationResult.cutoffFreqHz || 16000)/1000}kHz)` : '未測定'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Detailed Logs & SHA-256 Compare Card */}
                    <div className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-3 space-y-2.5">
                      <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider block border-b border-zinc-800/60 pb-2">PCM SHA-256 ハッシュ比較 & 診断ログ</span>
                      
                      <div className="space-y-1 text-[10px]">
                        <div className="text-zinc-400">元PCM SHA-256:</div>
                        <div className="bg-zinc-950 px-2 py-1 rounded text-zinc-300 font-mono border border-zinc-850 truncate select-all">
                          {selectedFile.verificationResult.originalHash || 'N/A'}
                        </div>
                        <div className="text-zinc-400 pt-1">変換後PCM SHA-256:</div>
                        <div className="bg-zinc-950 px-2 py-1 rounded text-zinc-300 font-mono border border-zinc-850 truncate select-all">
                          {selectedFile.verificationResult.convertedHash || 'N/A'}
                        </div>
                      </div>

                      <div className="pt-2 border-t border-zinc-800/40 space-y-1">
                        <span className="text-[10px] text-zinc-500 uppercase font-mono block">検証詳細:</span>
                        <ul className="space-y-1 text-[10px] text-zinc-400">
                          {selectedFile.verificationResult.details.map((detail, dIdx) => (
                            <li key={dIdx} className="flex items-start gap-1.5">
                              <span className="text-emerald-500">•</span>
                              <span>{detail}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

              {isConverting ? (
                <button
                  onClick={handleCancelConversion}
                  className="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded transition-colors cursor-pointer border border-rose-500"
                >
                  {t(lang, 'cancelBtn')}
                </button>
              ) : (
                <button
                  onClick={handleStartConversion}
                  disabled={files.length === 0}
                  className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold rounded shadow-lg shadow-emerald-950/20 border border-emerald-500 transition-all flex items-center gap-2 cursor-pointer hover:shadow-emerald-900/30"
                >
                  <RefreshCw className="h-4 w-4 shrink-0" />
                  <span>{t(lang, 'startBatchBtn')}</span>
                </button>
              )}

              <button
                onClick={() => {
                  if (confirm(t(lang, 'confirmClose'))) {
                    window.close();
                  }
                }}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded border border-zinc-700 transition-colors cursor-pointer"
              >
                {t(lang, 'closeBtn')}
              </button>
            </div>
          </div>
        </div>

        {/* ======================================================== */}
        {/* INLINE ENCODER CONFIG MODAL */}
        {/* ======================================================== */}
        {showConfigModal && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in select-none text-xs">
            <div className="bg-zinc-900 border border-zinc-800 w-full max-w-md rounded-xl p-5 shadow-2xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <div className="flex items-center gap-2">
                  <Sliders className="h-4 w-4 text-emerald-400" />
                  <span className="font-bold text-white text-sm">
                    {settings.outputFormat} {t(lang, 'encoderDetailSettings')}
                  </span>
                </div>
                <button 
                  onClick={() => setShowConfigModal(false)}
                  className="text-zinc-550 hover:text-zinc-350 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3.5">
                {settings.sameAsSource && (
                  <div className="p-2 bg-emerald-950/30 border border-emerald-800/50 rounded text-emerald-400 text-[10px] italic">
                    {lang === 'ja' 
                      ? '💡 ソース品質維持 (Same as Source) が有効なため、元音源のサンプリングレートおよび解像度が自動適用されます。'
                      : '💡 Same as Source mode is active. Original sampling rate & resolution will be preserved.'
                    }
                  </div>
                )}
                {/* Sample Rate selection */}
                <div className={`space-y-1.5 ${settings.sameAsSource ? 'opacity-40 pointer-events-none' : ''}`}>
                  <label className="text-zinc-450 text-[10px] font-mono text-zinc-550 block">{t(lang, 'samplingRate')}</label>
                  <div className="grid grid-cols-5 gap-1">
                    {[22050, 44100, 48000, 88200, 96000].map((rate) => (
                      <button
                        key={rate}
                        disabled={settings.sameAsSource}
                        onClick={() => updateSetting('sampleRate', rate as any)}
                        className={`py-1 rounded font-mono text-[10px] border transition-all cursor-pointer ${
                          settings.sampleRate === rate
                            ? 'bg-emerald-600/10 text-emerald-400 border-emerald-500/40 font-bold'
                            : 'bg-zinc-950 text-zinc-450 border-zinc-850 hover:bg-zinc-800 hover:text-zinc-300'
                        }`}
                      >
                        {rate / 1000}k
                      </button>
                    ))}
                  </div>
                </div>

                {/* Channels selection */}
                <div className="space-y-1.5">
                  <label className="text-zinc-450 text-[10px] font-mono text-zinc-550 block">{t(lang, 'channels')}</label>
                  <select
                    value={settings.channels}
                    onChange={(e) => updateSetting('channels', parseInt(e.target.value) as any)}
                    className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none cursor-pointer"
                  >
                    <option value={1}>{lang === 'ja' ? '1 - Mono (モノラル)' : '1 - Mono'}</option>
                    <option value={2}>{lang === 'ja' ? '2 - Stereo (ステレオ)' : '2 - Stereo'}</option>
                    <option value={6}>{lang === 'ja' ? '6 - 5.1 Surround (サラウンド)' : '6 - 5.1 Surround'}</option>
                  </select>
                </div>

                {/* Bitrate or Bit Depth selection */}
                {LOSSLESS_OUTPUT_FORMATS.includes((settings.outputFormat || '').toUpperCase()) ? (
                  <div className={`space-y-1.5 ${settings.sameAsSource ? 'opacity-40 pointer-events-none' : ''}`}>
                    <label className="text-zinc-450 text-[10px] font-mono text-zinc-550 block">{t(lang, 'bitDepth')}</label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {['16', '24', '32'].map((depth) => (
                        <button
                          key={depth}
                          disabled={settings.sameAsSource}
                          onClick={() => updateSetting('bitDepth', depth as any)}
                          className={`py-1.5 rounded font-mono text-[11px] border transition-all cursor-pointer ${
                            settings.bitDepth === depth
                              ? 'bg-emerald-600/10 text-emerald-400 border-emerald-500/40 font-bold'
                              : 'bg-zinc-950 text-zinc-450 border-zinc-850 hover:bg-zinc-800 hover:text-zinc-350'
                          }`}
                        >
                          {depth}-bit {depth === '32' ? 'Float' : 'PCM'}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {VBR_FORMATS.includes((settings.outputFormat || '').toUpperCase()) && (
                      <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
                        {(['vbr', 'cbr'] as const).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => updateSetting('bitrateMode', mode)}
                            className={`px-2 py-0.5 rounded border cursor-pointer ${
                              (settings.bitrateMode ?? 'cbr') === mode
                                ? 'bg-emerald-600/10 text-emerald-400 border-emerald-500/40 font-bold'
                                : 'bg-zinc-950 text-zinc-450 border-zinc-850 hover:bg-zinc-800'
                            }`}
                          >
                            {mode === 'vbr' ? t(lang, 'vbrMode') : t(lang, 'cbrMode')}
                          </button>
                        ))}
                        {settings.bitrateMode === 'vbr' && (
                          <select
                            value={settings.vbrQuality ?? 2}
                            onChange={(e) => updateSetting('vbrQuality', Number(e.target.value))}
                            className="bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-zinc-300"
                            title={t(lang, 'vbrQualityHelp')}
                          >
                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((q) => (
                              <option key={q} value={q}>V{q}{q === 0 ? ` (${t(lang, 'vbrBest')})` : q === 2 ? ` (${t(lang, 'vbrDefault')})` : ''}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                    {!(settings.bitrateMode === 'vbr' && VBR_FORMATS.includes((settings.outputFormat || '').toUpperCase())) && (<>
                    <label className="text-zinc-450 text-[10px] font-mono text-zinc-550 block">{t(lang, 'bitrate')}</label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {['128', '192', '256', '320'].map((rate) => (
                        <button
                          key={rate}
                          onClick={() => updateSetting('bitrate', rate as any)}
                          className={`py-1.5 rounded font-mono text-[11px] border transition-all cursor-pointer ${
                            settings.bitrate === rate
                              ? 'bg-emerald-600/10 text-emerald-400 border-emerald-500/40 font-bold'
                              : 'bg-zinc-950 text-zinc-450 border-zinc-850 hover:bg-zinc-800 hover:text-zinc-300'
                          }`}
                        >
                          {rate} kbps
                        </button>
                      ))}
                    </div>
                    </>)}
                  </div>
                )}

                {/* Additional advanced parameters */}
                <div className="pt-2 border-t border-zinc-800 space-y-2 text-[10px] text-zinc-500 leading-normal">
                  <div className="flex justify-between">
                    <span>{lang === 'ja' ? 'マルチスレッド変換コア数:' : 'Multi-thread conversion cores:'}</span>
                    <span className="text-zinc-400 font-bold">{settings.threadPoolSize} FFmpeg threads</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="16"
                    step="1"
                    value={settings.threadPoolSize}
                    onChange={(e) => updateSetting('threadPoolSize', parseInt(e.target.value))}
                    className="w-full accent-emerald-500 h-1 cursor-pointer bg-zinc-950 rounded"
                  />
                  <p>
                    {lang === 'ja' 
                      ? (AppBridge.isAvailable() ? '※ 変換はアプリに同梱した FFmpeg で、このコンピュータ上で行います。' : '※ ブラウザ版では、ブラウザ内の簡易エンコーダで変換します。')
                      : (AppBridge.isAvailable() ? '* Conversion runs on this computer with the FFmpeg bundled in the app.' : '* In the browser version, a simple in-browser encoder converts the files.')
                    }
                  </p>
                </div>
              </div>

              <div className="pt-3 border-t border-zinc-800 flex justify-end">
                <button
                  onClick={() => {
                    setShowConfigModal(false);
                    addLog(lang === 'ja' ? `エンコーダ設定を適用しました: ${settings.sampleRate}Hz、${settings.channels}Ch。` : `Applied encoder settings: ${settings.sampleRate}Hz, ${settings.channels}Ch.`);
                  }}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded cursor-pointer transition-colors"
                >
                  {lang === 'ja' ? '設定を適用して閉じる' : 'Apply and Close'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* PATTERN HELP MODAL */}
        {/* ======================================================== */}
        {showPatternHelpModal && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in select-none text-xs">
            <div className="bg-zinc-900 border border-zinc-800 w-full max-w-lg rounded-xl p-5 shadow-2xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <div className="flex items-center gap-2">
                  <Info className="h-4.5 w-4.5 text-emerald-400" />
                  <span className="font-bold text-white text-sm">
                    {lang === 'ja' ? 'ファイル名パターン ヘルプ & マクロタグ' : 'Filename Pattern Help & Macro Tags'}
                  </span>
                </div>
                <button 
                  onClick={() => setShowPatternHelpModal(false)}
                  className="text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3">
                <p className="text-zinc-400 text-[11px] leading-relaxed">
                  {lang === 'ja'
                    ? '以下のマクロタグをクリックすると、ファイル名パターンに自動挿入されます。'
                    : 'Click any macro tag below to insert it into the filename pattern.'
                  }
                </p>

                <div className="grid grid-cols-2 gap-2 max-h-[220px] overflow-y-auto pr-1">
                  {[
                    { tag: '%title%', descJa: 'タイトル (Title)', descEn: 'Track Title', example: 'Song Title' },
                    { tag: '%artist%', descJa: 'アーティスト名 (Artist)', descEn: 'Artist Name', example: 'Artist Name' },
                    { tag: '%album%', descJa: 'アルバム名 (Album)', descEn: 'Album Name', example: 'Album Title' },
                    { tag: '%albumartist%', descJa: 'アルバムアーティスト名', descEn: 'Album Artist', example: 'Various Artists' },
                    { tag: '%track2%', descJa: 'トラック番号（2 桁）', descEn: 'Track Number (2 digits)', example: '01' },
                    { tag: '%disc2%', descJa: 'ディスク番号（2 桁）', descEn: 'Disc Number (2 digits)', example: '01' },
                    { tag: '%year%', descJa: 'リリース年 (Year)', descEn: 'Release Year', example: '2026' },
                    { tag: '%genre%', descJa: 'ジャンル (Genre)', descEn: 'Music Genre', example: 'Pop / Rock' },
                    { tag: '%filename%', descJa: '元のファイル名', descEn: 'Source File Name', example: 'track01' },
                  ].map((item) => (
                    <button
                      key={item.tag}
                      onClick={() => {
                        const updated = insertToken(settings.renamePattern || '', item.tag);
                        setSettings((prev) => ({
                          ...prev,
                          renamePattern: updated,
                          renameByTags: true,
                        }));
                      }}
                      className="flex flex-col items-start p-2 bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 rounded transition-all cursor-pointer text-left group"
                    >
                      <span className="font-mono text-emerald-400 font-bold group-hover:text-emerald-300">{item.tag}</span>
                      <span className="text-[10px] text-zinc-400 mt-0.5">{lang === 'ja' ? item.descJa : item.descEn}</span>
                      <span className="text-[9px] font-mono text-zinc-600">例: {item.example}</span>
                    </button>
                  ))}
                </div>

                <div className="p-2.5 bg-zinc-950 border border-zinc-800/80 rounded space-y-1 font-mono text-[10px]">
                  <span className="text-zinc-500 uppercase block">{lang === 'ja' ? '現在のパターンプレビュー:' : 'CURRENT PATTERN PREVIEW:'}</span>
                  <div className="text-emerald-400 font-semibold truncate">
                    {`${renderFileName(settings.renamePattern || '', PREVIEW_TAGS, 'source file.wav')}.${getFormatExtension(settings.outputFormat)}`}
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-zinc-800 flex justify-end">
                <button
                  onClick={() => setShowPatternHelpModal(false)}
                  className="px-5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded cursor-pointer transition-colors"
                >
                  {lang === 'ja' ? '閉じる' : 'Close'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* SKIPPED FILES MODAL */}
        {/* ======================================================== */}
        {skippedFiles && (
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in select-none text-xs">
            <div className="bg-zinc-900 border border-zinc-850 w-full max-w-md rounded-xl p-5 shadow-2xl space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <div className="flex items-center gap-2 text-rose-450">
                  <AlertCircle className="h-4.5 w-4.5 shrink-0 text-rose-500" />
                  <span className="font-bold text-white text-sm">
                    {lang === 'ja' ? '一部のファイルの読み込みがスキップされました' : 'Some files were skipped'}
                  </span>
                </div>
                <button 
                  onClick={() => setSkippedFiles(null)}
                  className="text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3">
                <p className="text-zinc-400 leading-relaxed text-[11px]">
                  {lang === 'ja'
                    ? `以下のファイル（${skippedFiles.length}個）は、対応していない音声フォーマットであるか、デコード中にエラーが発生したため追加されませんでした。`
                    : `The following file(s) (${skippedFiles.length}) were not added because they are in an unsupported audio format or failed to decode.`
                  }
                </p>

                {/* Scrollable container showing skipped files list */}
                <div className="bg-zinc-950 border border-zinc-850 rounded-lg p-2.5 max-h-[180px] overflow-y-auto font-mono text-[11px] divide-y divide-zinc-900/60 scrollbar-thin">
                  {skippedFiles.map((file, i) => (
                    <div key={i} className="py-1.5 flex flex-col gap-0.5 first:pt-0 last:pb-0">
                      <span className="text-zinc-200 font-semibold truncate block" title={file.name}>
                        {file.name}
                      </span>
                      <span className="text-[10px] text-rose-400 block truncate" title={file.reason}>
                        ↳ {file.reason}
                      </span>
                    </div>
                  ))}
                </div>

                <p className="text-[10px] text-zinc-500 italic">
                  {lang === 'ja'
                    ? '※ ブラウザおよびElectronでサポートされている音声形式（WAV, MP3, FLAC, M4A, OGG 等）をご使用ください。'
                    : '* Please use audio formats supported by browser and Electron (WAV, MP3, FLAC, M4A, OGG, etc.).'
                  }
                </p>
              </div>

              <div className="pt-3 border-t border-zinc-800 flex justify-end">
                <button
                  onClick={() => setSkippedFiles(null)}
                  className="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded cursor-pointer transition-colors shadow-md shadow-black/20"
                >
                  {lang === 'ja' ? '確認' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Support the developer (Buy Me a Coffee) */}
        <DonateModal isOpen={showDonateModal} onClose={() => setShowDonateModal(false)} lang={lang} />

      </div>
    </>
  );
}
