import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { AudioFile, ConverterSettings, MetadataTags, JobTab, LogEntry, getFormatExtension } from '../types';
import { analyzeAudioBuffer } from '../utils/audioEncoder';
import { AppBridge, isPathOnlyFile, type PathOnlyFile } from '../services/bridge';
import { DEFAULT_RENAME_PATTERN, renderFileName, emptyTags, tagsFromMetadata, editedTags, isLosslessSource, LOSSLESS_OUTPUT_FORMATS } from '../utils/fileNamePattern';

interface AudioConverterContextType {
  files: AudioFile[];
  setFiles: (update: AudioFile[] | ((prev: AudioFile[]) => AudioFile[])) => void;
  settings: ConverterSettings;
  setSettings: (update: ConverterSettings | ((prev: ConverterSettings) => ConverterSettings)) => void;
  selectedFileId: string | null;
  setSelectedFileId: (id: string | null) => void;
  isConverting: boolean;
  toast: { type: 'success' | 'info' | 'error'; message: string } | null;
  setToast: React.Dispatch<React.SetStateAction<{ type: 'success' | 'info' | 'error'; message: string } | null>>;
  showToast: (type: 'success' | 'info' | 'error', message: string) => void;
  handleAddFiles: (fileList: FileList | File[]) => void;
  handleStartConversion: () => void;
  handleCancelConversion: () => void;
  handleUpdateTags: (id: string, newTags: Partial<MetadataTags>) => void;
  handleVerifyQuality: (id: string) => Promise<void>;
  handleResetQueueStatus: () => void;

  // Tab-related Extensions
  tabs: JobTab[];
  setTabs: React.Dispatch<React.SetStateAction<JobTab[]>>;
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  handleAddTab: (name?: string) => void;
  handleRemoveTab: (id: string) => void;
  handleRenameTab: (id: string, name: string) => void;
  logs: LogEntry[];
  addLog: (message: string, type?: 'info' | 'success' | 'error') => void;
  clearLogs: () => void;
  skippedFiles: Array<{ name: string; reason: string }> | null;
  setSkippedFiles: React.Dispatch<React.SetStateAction<Array<{ name: string; reason: string }> | null>>;
  lang: 'ja' | 'en';
  setLang: (lang: 'ja' | 'en') => void;
}

/** One AudioContext for decoding and sound effects (browsers limit how many exist). */
let audioContextSingleton: AudioContext | null = null;
function sharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioContextSingleton) {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    audioContextSingleton = new AudioCtx();
  }
  return audioContextSingleton;
}

/** The file to decode for the waveform/player: the output once the source is in the trash. */
function previewSourcePath(f: AudioFile): string {
  return f.originalDeleted && f.outputPath ? f.outputPath : f.path || '';
}

const AudioConverterContext = createContext<AudioConverterContextType | undefined>(undefined);

const defaultSettings: ConverterSettings = {
  outputFormat: 'ALAC',
  bitrate: '320',
  sampleRate: 44100,
  bitDepth: '16',
  channels: 2,
  normalize: false,
  normalizationTargetDb: -1.0,
  autoNotification: true,
  notificationSound: 'chime',
  volumeBoostDb: 0,
  trimSilence: false,
  trimSilenceThresholdDb: -50,
  threadPoolSize: 4,
  ffmpegHighSpeed: true,
  autoRemoveCompleted: false,
  autoVerifyQuality: true,
  sameAsSource: true,
  electronDesktopMode: true,
  deleteOriginalAfterConvert: true,
  saveInSourceFolder: true,
  renameByTags: true,
  renamePattern: DEFAULT_RENAME_PATTERN,
  localSavePath: '~/Music/Audio-Convert-Outputs',
  maxSampleRate: 0,
  flacCompressionLevel: 5,
  flacUncompressed: false,
  onExisting: 'rename',
};

export const AudioConverterProvider = ({ children }: { children: React.ReactNode }) => {
  const [tabs, setTabs] = useState<JobTab[]>([]);
  const [activeTabId, _setActiveTabId] = useState<string>('');

  const saveSettingsToDisk = (currentTabs: JobTab[], activeId: string) => {
    if (!AppBridge.isAvailable()) return;
    const tabsToSave = currentTabs.map(t => ({
      id: t.id,
      name: t.name,
      settings: t.settings,
    }));
    AppBridge.saveSettings({
      tabs: tabsToSave,
      activeTabId: activeId,
    }).catch((e) => {
      console.warn('Failed to save settings to disk:', e);
    });
  };

  const setActiveTabId = (id: string) => {
    _setActiveTabId(id);
    if (id && tabs.length > 0) {
      saveSettingsToDisk(tabs, id);
    }
  };

  const [isConverting, setIsConverting] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'info' | 'error'; message: string } | null>(null);
  const [skippedFiles, setSkippedFiles] = useState<Array<{ name: string; reason: string }> | null>(null);
  const [lang, setLang] = useState<'ja' | 'en'>('ja');

  const conversionQueueRef = useRef<string[]>([]);
  const activeConversionIdRef = useRef<string | null>(null);
  const activeConversionTabIdRef = useRef<string | null>(null);
  const jobRef = useRef<{ id: string; cancelled: boolean } | null>(null);
  const batchRef = useRef({ success: 0, failed: 0, warnings: 0 });
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    if (!AppBridge.isAvailable()) return;
    return AppBridge.onProgress(event => {
      if (event.jobId !== jobRef.current?.id || jobRef.current.cancelled) return;
      const tabId = activeConversionTabIdRef.current;
      const fileId = activeConversionIdRef.current;
      if (tabId && fileId) setTabs(prev => prev.map(tab => tab.id === tabId ? {
        ...tab, files: tab.files.map(file => file.id === fileId ? { ...file, status: event.phase as any, progress: event.progress } : file)
      } : tab));
    });
  }, []);
  const defaultSavePathRef = useRef<string>('~/Music/Audio-Convert-Outputs');

  // Initialize tabs by loading settings.json or falling back to default tab1 (FLAC)
  useEffect(() => {
    const initTabs = async () => {
      let defaultPath = '~/Music/Audio-Convert-Outputs';
      if (AppBridge.isAvailable()) {
        try {
          const resolvedPath = await AppBridge.getDefaultSavePath();
          if (resolvedPath) {
            defaultPath = resolvedPath;
            defaultSavePathRef.current = resolvedPath;
          }
        } catch (e) {
          console.warn('Failed to get default save path:', e);
        }
      }

      let loadedConfig: any = null;
      if (AppBridge.isAvailable()) {
        try {
          loadedConfig = await AppBridge.loadSettings();
        } catch (e) {
          console.warn('Failed to load settings file:', e);
        }
      }

      if (loadedConfig && Array.isArray(loadedConfig.tabs) && loadedConfig.tabs.length > 0) {
        const initialTabs: JobTab[] = loadedConfig.tabs.map((t: any) => ({
          id: t.id || `tab_${Math.random().toString(36).substring(2, 7)}`,
          name: t.name || 'tab1',
          files: [],
          settings: {
            ...defaultSettings,
            localSavePath: defaultPath,
            ...t.settings,
          },
          logs: [
            {
              id: 'log_init_' + Math.random().toString(36).substring(2, 7),
              timestamp: new Date().toLocaleTimeString(),
              message: `Loaded profile "${t.name}" from settings.json. Ready.`,
              type: 'info',
            }
          ],
          selectedFileId: null,
        }));
        setTabs(initialTabs);
        const savedActiveId = loadedConfig.activeTabId;
        if (savedActiveId && initialTabs.some(t => t.id === savedActiveId)) {
          _setActiveTabId(savedActiveId);
        } else {
          _setActiveTabId(initialTabs[0].id);
        }
      } else {
        // Default fallback: a single tab named tab1 (or タブ1) with FLAC output format
        const defaultTabName = lang === 'ja' ? 'タブ1' : 'tab1';
        const fallbackTabId = 'tab_default_' + Math.random().toString(36).substring(2, 7);
        const fallbackTabs: JobTab[] = [
          {
            id: fallbackTabId,
            name: defaultTabName,
            files: [],
            settings: {
              ...defaultSettings,
              localSavePath: defaultPath,
              outputFormat: 'FLAC',
            },
            logs: [
              {
                id: 'log_init_' + Math.random().toString(36).substring(2, 7),
                timestamp: new Date().toLocaleTimeString(),
                message: `Initialized default profile "${defaultTabName}". Ready.`,
                type: 'info',
              }
            ],
            selectedFileId: null,
          }
        ];
        setTabs(fallbackTabs);
        _setActiveTabId(fallbackTabId);
      }
    };

    initTabs();
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0] || null;

  // Deriving current tab scope state
  const files = activeTab ? activeTab.files : [];
  const settings = activeTab ? activeTab.settings : defaultSettings;
  const selectedFileId = activeTab ? activeTab.selectedFileId : null;
  const logs = activeTab ? activeTab.logs : [];

  // The waveform and player need decoded audio. Only the selected file is decoded (on
  // demand); with the app backend, files that can be read again are released when not
  // selected. A source moved to the trash is read from its output instead.
  const selectedRecord = files.find(f => f.id === selectedFileId) || null;
  const selectedPath = selectedRecord ? previewSourcePath(selectedRecord) : '';
  const selectedHasBuffer = !!selectedRecord?.originalAudioBuffer;
  useEffect(() => {
    const keepId = selectedFileId;
    const releasable = (f: AudioFile) =>
      AppBridge.isAvailable() && !!f.originalAudioBuffer && !!previewSourcePath(f) && f.id !== keepId;
    setTabs(prev => prev.some(t => t.files.some(releasable))
      ? prev.map(t => t.files.some(releasable)
        ? { ...t, files: t.files.map(f => releasable(f) ? { ...f, originalAudioBuffer: null } : f) }
        : t)
      : prev);
    if (!keepId || !selectedPath || selectedHasBuffer || !AppBridge.isAvailable()) return;
    let stale = false;
    if (selectedRecord?.previewError) {
      setTabs(prev => prev.map(t => t.files.some(f => f.id === keepId)
        ? { ...t, files: t.files.map(f => f.id === keepId ? { ...f, previewError: undefined } : f) }
        : t));
    }
    AppBridge.decodeAudioToWav(selectedPath)
      .then((data) => {
        if (stale) return null;
        const ctx = sharedAudioContext();
        if (!ctx) throw new Error('Web Audio is not available');
        return ctx.decodeAudioData(data);
      })
      .then((buffer) => {
        if (stale || !buffer) return;
        const info = analyzeAudioBuffer(buffer);
        setTabs(prev => prev.map(t => t.files.some(f => f.id === keepId)
          ? { ...t, files: t.files.map(f => f.id === keepId ? { ...f, originalAudioBuffer: buffer, previewError: undefined, peakDb: info.peakDb, rmsDb: info.rmsDb } : f) }
          : t));
      })
      .catch((err) => {
        if (stale) return;
        const message = String(err?.message || err);
        setTabs(prev => prev.map(t => t.files.some(f => f.id === keepId)
          ? { ...t, files: t.files.map(f => f.id === keepId ? { ...f, previewError: message } : f) }
          : t));
      });
    return () => { stale = true; };
  }, [selectedFileId, selectedPath, selectedHasBuffer]);

  // Helper to add logs to specific tab
  const addLogToTab = (tabId: string, message: string, type: 'info' | 'success' | 'error' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    const logId = 'log_' + Math.random().toString(36).substring(2, 9);
    const entry: LogEntry = { id: logId, timestamp, message, type };
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, logs: [...t.logs, entry] } : t));
  };

  const addLog = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
    if (activeTabId) {
      addLogToTab(activeTabId, message, type);
    }
  };

  const clearLogs = () => {
    if (activeTabId) {
      setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, logs: [] } : t));
    }
  };

  // Proxied setters
  const setFiles = (update: AudioFile[] | ((prev: AudioFile[]) => AudioFile[])) => {
    setTabs(prev => prev.map(t => {
      if (t.id === activeTabId) {
        const nextFiles = typeof update === 'function' ? update(t.files) : update;
        return { ...t, files: nextFiles };
      }
      return t;
    }));
  };

  const setSettings = (update: ConverterSettings | ((prev: ConverterSettings) => ConverterSettings)) => {
    setTabs(prev => {
      const nextTabs = prev.map(t => {
        if (t.id === activeTabId) {
          const nextSettings = typeof update === 'function' ? update(t.settings) : update;
          const updatedFiles = t.files.map(f => {
            if (f.status === 'queued' || f.status === 'failed') {
              return {
                ...f,
                outputFormat: nextSettings.outputFormat,
                bitrate: nextSettings.bitrate,
                sampleRate: nextSettings.sampleRate,
                channels: nextSettings.channels,
              };
            }
            return f;
          });
          return { ...t, settings: nextSettings, files: updatedFiles };
        }
        return t;
      });
      saveSettingsToDisk(nextTabs, activeTabId);
      return nextTabs;
    });
  };

  const setSelectedFileId = (id: string | null) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, selectedFileId: id } : t));
  };

  // Tab operations
  const handleAddTab = (name?: string) => {
    const newTabId = 'tab_' + Math.random().toString(36).substring(2, 9);
    const defaultTabName = lang === 'ja' ? `タブ ${tabs.length + 1}` : `Tab ${tabs.length + 1}`;
    const newTabName = name || defaultTabName;
    const newTab: JobTab = {
      id: newTabId,
      name: newTabName,
      files: [],
      settings: { 
        ...defaultSettings,
        localSavePath: defaultSavePathRef.current
      },
      logs: [
        {
          id: 'log_' + Math.random().toString(36).substring(2, 9),
          timestamp: new Date().toLocaleTimeString(),
          message: lang === 'ja' 
            ? `ジョブタブ "${newTabName}" が作成されました。準備完了。` 
            : `Job Tab "${newTabName}" created. Ready.`,
          type: 'info',
        }
      ],
      selectedFileId: null,
    };
    setTabs(prev => {
      const nextTabs = [...prev, newTab];
      saveSettingsToDisk(nextTabs, newTabId);
      return nextTabs;
    });
    _setActiveTabId(newTabId);
    showToast('success', lang === 'ja' ? `ジョブタブを作成しました: ${newTabName}` : `Created job tab: ${newTabName}`);
  };

  const handleRemoveTab = (id: string) => {
    if (id === activeConversionTabIdRef.current) {
      showToast('info', lang === 'ja' ? '処理完了または停止後にタブを削除してください。' : 'Wait for conversion to finish or stop before removing this tab.');
      return;
    }
    if (tabs.length <= 1) {
      showToast('error', lang === 'ja' ? '最後のタブを閉じることはできません。' : 'Cannot close the last remaining tab.');
      return;
    }
    const index = tabs.findIndex(t => t.id === id);
    const updated = tabs.filter(t => t.id !== id);
    setTabs(updated);
    
    let nextActiveId = activeTabId;
    if (activeTabId === id) {
      const nextActiveIndex = Math.max(0, index - 1);
      nextActiveId = updated[nextActiveIndex].id;
      _setActiveTabId(nextActiveId);
    }
    
    saveSettingsToDisk(updated, nextActiveId);
    showToast('info', lang === 'ja' ? 'タブを閉じました。' : 'Tab closed.');
  };

  const handleRenameTab = (id: string, name: string) => {
    setTabs(prev => {
      const nextTabs = prev.map(t => t.id === id ? { ...t, name } : t);
      saveSettingsToDisk(nextTabs, activeTabId);
      return nextTabs;
    });
  };

  const showToast = (type: 'success' | 'info' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast(null);
    }, 4500);
  };

  // Web Audio Synthesizer sound effects
  const playNotificationSound = (type: ConverterSettings['notificationSound']) => {
    if (typeof window === 'undefined') return;
    try {
      const ctx = sharedAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      const now = ctx.currentTime;
      if (type === 'chime') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.15);
        gainNode.gain.setValueAtTime(0.3, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
        osc.start(now);
        osc.stop(now + 1.2);
      } else if (type === 'beep') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1100, now + 0.08);
        gainNode.gain.setValueAtTime(0.2, now);
        gainNode.gain.setValueAtTime(0, now + 0.06);
        gainNode.gain.setValueAtTime(0.2, now + 0.08);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'glass') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, now);
        gainNode.gain.setValueAtTime(0.25, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.start(now);
        osc.stop(now + 0.6);
      } else {
        osc.type = 'square';
        osc.frequency.setValueAtTime(330, now);
        osc.frequency.setValueAtTime(440, now + 0.06);
        osc.frequency.setValueAtTime(554.37, now + 0.12);
        osc.frequency.setValueAtTime(659.25, now + 0.18);
        gainNode.gain.setValueAtTime(0.12, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.start(now);
        osc.stop(now + 0.45);
      }
    } catch (err) {
      console.warn('Synthesizer blocked or unsupported:', err);
    }
  };

  const processAndDecodeFile = (f: File, targetTabId: string): Promise<{ success: boolean; fileRecord?: AudioFile; error?: string }> => {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).substring(2, 11);
      const ext = f.name.lastIndexOf('.') > 0 ? f.name.substring(f.name.lastIndexOf('.') + 1).toLowerCase() : '';
      // Files dropped on the Tauri window arrive as a path only (an empty File): skip the
      // browser decode and let FFmpeg read the file. Their real size comes with them.
      const pathOnly = isPathOnlyFile(f);
      const fileSize = pathOnly ? (f as PathOnlyFile).nativeSize : f.size;

      addLogToTab(targetTabId, `[DEBUG] "${f.name}" - 解析開始 (サイズ: ${fileSize} bytes, 拡張子: ${ext})`, 'info');

      // With the app backend, keep only the path and the metadata. The audio is read by
      // FFmpeg at conversion time, and decoded for the waveform/player only while the
      // file is selected, so a large folder does not fill memory.
      const knownPath = AppBridge.isAvailable() ? AppBridge.getPathForFile(f) : '';
      if (knownPath) {
        AppBridge.readAudioMetadata(knownPath)
          .then((meta) => {
            const format = meta?.success ? meta.format : undefined;
            if (!format || (!(format.duration > 0) && !(format.sampleRate > 0))) {
              const reason = meta?.error || (lang === 'ja' ? '音声として読み込めません。' : 'Not a readable audio file.');
              addLogToTab(targetTabId, `[DEBUG] "${f.name}" - メタデータ読み込み失敗: ${reason}`, 'error');
              resolve({ success: false, error: reason });
              return;
            }
            const tags = meta.tags ? tagsFromMetadata(meta.tags) : emptyTags();
            const fileRecord: AudioFile = {
              id,
              name: f.name,
              path: knownPath,
              size: fileSize,
              duration: Math.round((format.duration || 0) * 10) / 10,
              originalFormat: ext,
              outputFormat: settings.outputFormat,
              bitrate: format.bitrate ? `${Math.round(format.bitrate / 1000)}k` : `${settings.bitrate}k`,
              sampleRate: format.sampleRate,
              sourceSampleRate: format.sampleRate,
              channels: format.numberOfChannels || 2,
              status: 'queued',
              progress: 0,
              normalizationApplied: false,
              originalAudioBuffer: null,
              tags,
              sourceTags: { ...tags },
              sourceLossless: typeof format.lossless === 'boolean' ? format.lossless : undefined,
            };
            resolve({ success: true, fileRecord });
          })
          .catch((err) => {
            addLogToTab(targetTabId, `[DEBUG] "${f.name}" - メタデータ読み込み例外: ${err?.message || err}`, 'error');
            resolve({ success: false, error: `${err?.message || err}` });
          });
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        if (!e.target?.result) {
          addLogToTab(targetTabId, `[DEBUG] "${f.name}" - エラー: FileReaderの読み込み結果が空です`, 'error');
          resolve({ success: false, error: 'ファイルの読み込みに失敗しました。' });
          return;
        }
        try {
          const audioCtx = sharedAudioContext();
          if (!audioCtx) {
            addLogToTab(targetTabId, `[DEBUG] "${f.name}" - エラー: Web Audio API (AudioContext) が未サポートです`, 'error');
            resolve({ success: false, error: 'Web Audio APIがサポートされていません。' });
            return;
          }
          
          addLogToTab(targetTabId, `[DEBUG] "${f.name}" - ブラウザネイティブ(AudioContext.decodeAudioData)デコード開始...`, 'info');
          
          const decodeInBrowser = (data: ArrayBuffer, ok: (b: AudioBuffer) => void, fail: (err: any) => void) =>
            pathOnly ? fail({ message: 'path only', pathOnly: true }) : audioCtx.decodeAudioData(data, ok, fail);
          decodeInBrowser(
            e.target.result as ArrayBuffer,
            (buffer) => {
              addLogToTab(targetTabId, `[DEBUG] "${f.name}" - ブラウザデコードに成功しました。再生時間: ${buffer.duration.toFixed(2)}秒`, 'success');
              
              const resolveFilePath = (fileObj: File): string => AppBridge.getPathForFile(fileObj);

              const filePath = resolveFilePath(f);
              const info = analyzeAudioBuffer(buffer);

              let initialTags: MetadataTags = emptyTags();
              let sourceLossless: boolean | undefined = undefined;

              const createAndResolve = (finalTags: MetadataTags, metaFormat?: any) => {
                const nativeSampleRate = metaFormat?.sampleRate || buffer.sampleRate;
                const nativeChannels = metaFormat?.numberOfChannels || buffer.numberOfChannels;
                const nativeBitrate = metaFormat?.bitrate ? `${Math.round(metaFormat.bitrate / 1000)}k` : `${settings.bitrate}k`;
                const nativeDuration = metaFormat?.duration ? Math.round(metaFormat.duration * 10) / 10 : Math.round(buffer.duration * 10) / 10;

                const fileRecord: AudioFile = {
                  id,
                  name: f.name,
                  path: filePath,
                  size: fileSize,
                  duration: nativeDuration,
                  originalFormat: ext,
                  outputFormat: settings.outputFormat,
                  bitrate: nativeBitrate,
                  sampleRate: nativeSampleRate,
                  sourceSampleRate: nativeSampleRate,
                  channels: nativeChannels,
                  status: 'queued',
                  progress: 0,
                  normalizationApplied: false,
                  originalAudioBuffer: buffer,
                  peakDb: info.peakDb,
                  rmsDb: info.rmsDb,
                  tags: finalTags,
                  sourceTags: { ...finalTags },
                  sourceLossless,
                };
                resolve({ success: true, fileRecord });
              };

              if (filePath && AppBridge.isAvailable()) {
                AppBridge.readAudioMetadata(filePath)
                  .then((metaResult) => {
                    let metaFormat: any = undefined;
                    if (metaResult && metaResult.success) {
                      if (metaResult.tags) {
                        initialTags = tagsFromMetadata(metaResult.tags);
                      }
                      if (metaResult.format) {
                        metaFormat = metaResult.format;
                        sourceLossless = typeof metaResult.format.lossless === 'boolean' ? metaResult.format.lossless : undefined;
                      }
                    }
                    createAndResolve(initialTags, metaFormat);
                  })
                  .catch(() => createAndResolve(initialTags));
              } else {
                createAndResolve(initialTags);
              }
            },
            (err) => {
              if (err?.pathOnly) {
                addLogToTab(targetTabId, `[DEBUG] "${f.name}" - ドロップされたファイルを FFmpeg でデコードします。`, 'info');
              } else {
                addLogToTab(targetTabId, `[DEBUG] "${f.name}" - ブラウザデコード失敗: ${err?.message || '不明なデコードエラー'}。フォールバック処理を起動します。`, 'error');
              }
              
              const resolveFilePath = (fileObj: File): string => AppBridge.getPathForFile(fileObj);

              const filePath = resolveFilePath(f);
              const hasIpc = AppBridge.isAvailable();
              
              addLogToTab(targetTabId, `[DEBUG] "${f.name}" - 診断情報: resolved filePath = "${filePath || 'undefined'}", AppBridge利用可能性 = ${hasIpc}`, 'info');

              if (filePath && hasIpc) {
                addLogToTab(targetTabId, `[DEBUG] "${f.name}" - IPC「decode-audio-to-wav」を呼び出し中 (Path: "${filePath}")...`, 'info');
                
                AppBridge.decodeAudioToWav(filePath)
                  .then(async (arrayBuffer) => {
                    addLogToTab(targetTabId, `[DEBUG] "${f.name}" - IPCデコード成功。WAVバイナリサイズ: ${arrayBuffer.byteLength} bytes`, 'success');
                    try {
                      // Read metadata tags using AppBridge
                      let metadataTags: MetadataTags = emptyTags();

                      let metaResultObj: any = null;
                      try {
                        addLogToTab(targetTabId, `[DEBUG] "${f.name}" - IPC「read-audio-metadata」を呼び出し中...`, 'info');
                        const metaResult = await AppBridge.readAudioMetadata(filePath);
                        metaResultObj = metaResult;
                        if (metaResult && metaResult.success && metaResult.tags) {
                          addLogToTab(targetTabId, `[DEBUG] "${f.name}" - メタデータ解析成功: タイトル="${metaResult.tags.title}", アーティスト="${metaResult.tags.artist}"`, 'success');
                          metadataTags = tagsFromMetadata(metaResult.tags);
                        } else {
                          addLogToTab(targetTabId, `[DEBUG] "${f.name}" - メタデータ解析失敗 (バックエンド側): ${metaResult?.error || '不明'}`, 'error');
                        }
                      } catch (metaErr: any) {
                        addLogToTab(targetTabId, `[DEBUG] "${f.name}" - メタデータ通信例外: ${metaErr?.message || metaErr}`, 'error');
                        console.warn('Failed to read metadata tags:', metaErr);
                      }

                      // Decode the WAV buffer in renderer browser context
                      addLogToTab(targetTabId, `[DEBUG] "${f.name}" - 展開したWAVバッファの最終デコード開始...`, 'info');
                      audioCtx.decodeAudioData(
                        arrayBuffer,
                        (decodedWavBuffer) => {
                          addLogToTab(targetTabId, `[DEBUG] "${f.name}" - 全デコードが正常完了しました!`, 'success');
                          const info = analyzeAudioBuffer(decodedWavBuffer);
                          const nativeSampleRate = metaResultObj?.format?.sampleRate || decodedWavBuffer.sampleRate;
                          const nativeChannels = metaResultObj?.format?.numberOfChannels || decodedWavBuffer.numberOfChannels;
                          const nativeBitrate = metaResultObj?.format?.bitrate ? `${Math.round(metaResultObj.format.bitrate / 1000)}k` : `${settings.bitrate}k`;
                          const nativeDuration = metaResultObj?.format?.duration ? Math.round(metaResultObj.format.duration * 10) / 10 : Math.round(decodedWavBuffer.duration * 10) / 10;

                          const fileRecord: AudioFile = {
                            id,
                            name: f.name,
                            path: filePath,
                            size: fileSize,
                            duration: nativeDuration,
                            originalFormat: ext,
                            outputFormat: settings.outputFormat,
                            bitrate: nativeBitrate,
                            sampleRate: nativeSampleRate,
                            sourceSampleRate: nativeSampleRate,
                            channels: nativeChannels,
                            status: 'queued',
                            progress: 0,
                            normalizationApplied: false,
                            originalAudioBuffer: decodedWavBuffer,
                            peakDb: info.peakDb,
                            rmsDb: info.rmsDb,
                            tags: metadataTags,
                            sourceTags: { ...metadataTags },
                            sourceLossless: typeof metaResultObj?.format?.lossless === 'boolean' ? metaResultObj.format.lossless : undefined,
                          };
                          resolve({ success: true, fileRecord });
                        },
                        (wavDecodeErr) => {
                          addLogToTab(targetTabId, `[DEBUG] "${f.name}" - エラー: WAVデコードデータのWeb Audio読み込みに失敗しました。`, 'error');
                          resolve({ success: false, error: 'FFmpegでデコードされたWAVデータの読み込みに失敗しました。' });
                        }
                      );
                    } catch (decodeErr: any) {
                      addLogToTab(targetTabId, `[DEBUG] "${f.name}" - デコード例外: ${decodeErr?.message || decodeErr}`, 'error');
                      resolve({ success: false, error: decodeErr?.message || 'デコード処理中にエラーが発生しました。' });
                    }
                  })
                  .catch((ipcErr) => {
                    addLogToTab(targetTabId, `[DEBUG] "${f.name}" - エラー: IPC通信「decode-audio-to-wav」失敗 - ${ipcErr.message || ipcErr}`, 'error');
                    AppBridge.logDebug(`FFmpeg IPC decode failed for: ${f.name}. Error: ${ipcErr.message || ipcErr}`);
                    resolve({ success: false, error: `デコード失敗: ${ipcErr.message || ipcErr}` });
                  });
              } else {
                addLogToTab(targetTabId, `[DEBUG] "${f.name}" - エラー: フォールバック不能。ファイルパスまたはIPC接続が不足しています (filePath: ${filePath ? 'あり' : 'なし'}, hasIpc: ${hasIpc})`, 'error');
                AppBridge.logDebug(`Cannot fallback for: ${f.name}. filePath: ${filePath}, hasIpc: ${hasIpc}`);
                const reason = err?.message || 'デコードエラー: 未対応のコーデックか、破損したファイルです。';
                resolve({ success: false, error: reason });
              }
            }
          );
        } catch (err: any) {
          addLogToTab(targetTabId, `[DEBUG] "${f.name}" - デコーダ初期化エラー: ${err?.message || err}`, 'error');
          resolve({ success: false, error: err?.message || 'オーディオデコーダの初期化に失敗しました。' });
        }
      };
      reader.onerror = () => {
        addLogToTab(targetTabId, `[DEBUG] "${f.name}" - FileReaderエラー発生`, 'error');
        resolve({ success: false, error: 'ファイルの読込中にエラーが発生しました。' });
      };
      reader.readAsArrayBuffer(f);
    });
  };

  // Handles adding files
  const handleAddFiles = async (fileList: FileList | File[]) => {
    if (typeof window === 'undefined') return;
    const targetTabId = activeTabId;
    const tabName = tabs.find(t => t.id === targetTabId)?.name || 'current';
    const arr = Array.from(fileList);

    const analyzingMsg = lang === 'ja' ? `${arr.length}個のファイルを解析中...` : `Analyzing ${arr.length} files...`;
    const startedMsg = lang === 'ja' ? `${arr.length}個のファイルの読み込みとデコードを開始しました。` : `Started reading and decoding ${arr.length} files.`;
    showToast('info', analyzingMsg);
    addLogToTab(targetTabId, startedMsg, 'info');

    // Decode a few files at a time: a dropped folder can hold thousands, and each decode
    // runs FFmpeg and holds the decoded audio in memory.
    const results: Array<{ success: boolean; fileRecord?: AudioFile; error?: string }> = new Array(arr.length);
    let next = 0;
    const worker = async () => {
      while (next < arr.length) {
        const i = next++;
        results[i] = await processAndDecodeFile(arr[i], targetTabId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, arr.length) }, worker));

    const succeededFiles: AudioFile[] = [];
    const skippedFiles: Array<{ name: string; reason: string }> = [];

    results.forEach((res, i) => {
      const originalFile = arr[i];
      if (res.success && res.fileRecord) {
        succeededFiles.push(res.fileRecord);
      } else {
        skippedFiles.push({
          name: originalFile.name,
          reason: res.error || (lang === 'ja' ? '不明なエラー' : 'Unknown Error')
        });
      }
    });

    if (succeededFiles.length > 0) {
      // Output format from the target tab's settings as they are now (they may have
      // changed while decoding). Rate, channels and bitrate stay the source's.
      setTabs(prev => prev.map(t => t.id === targetTabId ? {
        ...t,
        files: [...t.files, ...succeededFiles.map(f => ({ ...f, outputFormat: t.settings.outputFormat }))]
      } : t));
      
      const successLog = lang === 'ja' ? `${succeededFiles.length}個のファイルをインポートしました。` : `Imported ${succeededFiles.length} files.`;
      const successToast = lang === 'ja' ? `${succeededFiles.length}個のファイルを "${tabName}" に追加しました。` : `Added ${succeededFiles.length} files to "${tabName}".`;
      addLogToTab(targetTabId, successLog, 'success');
      showToast('success', successToast);
    }

    if (skippedFiles.length > 0) {
      skippedFiles.forEach(skipped => {
        const skippedMsg = lang === 'ja' ? `スキップ: "${skipped.name}" - ${skipped.reason}` : `Skipped: "${skipped.name}" - ${skipped.reason}`;
        addLogToTab(targetTabId, skippedMsg, 'error');
      });
      setSkippedFiles(skippedFiles);
    }
  };



  const handleStartConversion = () => {
    if (activeConversionTabIdRef.current) return;
    const targetTabId = activeTabId;
    const currentTab = tabs.find(t => t.id === targetTabId);
    if (!currentTab) return;

    const queued = currentTab.files.filter((f) => f.status === 'queued' || f.status === 'failed');
    if (queued.length === 0) {
      showToast('error', lang === 'ja' ? 'このタブには変換待ちのファイルがありません。' : 'No queued files to convert in this tab.');
      return;
    }

    setIsConverting(true);
    batchRef.current = { success: 0, failed: 0, warnings: 0 };
    activeConversionTabIdRef.current = targetTabId;
    conversionQueueRef.current = queued.map((f) => f.id);
    
    addLogToTab(targetTabId, lang === 'ja' ? `${queued.length}個のファイルのバッチ処理を開始します...` : `Starting batch pipeline for ${queued.length} items...`, 'info');
    processNextInQueue();
  };

  const processNextInQueue = () => {
    const targetTabId = activeConversionTabIdRef.current;
    if (!targetTabId) {
      setIsConverting(false);
      return;
    }

    if (conversionQueueRef.current.length === 0) {
      setIsConverting(false);
      activeConversionIdRef.current = null;
      activeConversionTabIdRef.current = null;
      
      const { success, failed, warnings } = batchRef.current;
      const message = lang === 'ja' ? `バッチ完了: 成功 ${success}件、失敗 ${failed}件、要確認 ${warnings}件` : `Batch finished: ${success} succeeded, ${failed} failed, ${warnings} need review`;
      addLogToTab(targetTabId, message, failed || warnings ? 'error' : 'success');
      showToast(failed ? 'error' : warnings ? 'info' : 'success', message);
      
      const tabSettings = tabsRef.current.find(t => t.id === targetTabId)?.settings || defaultSettings;
      if (tabSettings.autoNotification) {
        playNotificationSound(tabSettings.notificationSound);
      }

      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Audio Convert', {
          body: message,
        });
      }

      if (tabSettings.autoRemoveCompleted) {
        setTabs(prev => prev.map(t => t.id === targetTabId ? {
          ...t,
          files: t.files.filter((f) => f.status !== 'completed')
        } : t));
      }
      return;
    }

    const currentId = conversionQueueRef.current.shift()!;
    activeConversionIdRef.current = currentId;
    runConversionWorkflow(targetTabId, currentId);
  };

  const runConversionWorkflow = async (tabId: string, id: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    const fileRecord = tab?.files.find((f) => f.id === id);
    
    if (!tab || !fileRecord || !fileRecord.path) {
      batchRef.current.failed++;
      updateFileStatus(tabId, id, 'failed', 0, 'Audio source missing or unreadable');
      processNextInQueue();
      return;
    }

    const tabSettings = tab.settings;
    const job = { id: crypto.randomUUID(), cancelled: false };
    jobRef.current = job;
    // Set once the output file exists on disk, so a later failure or cancel does not
    // report a saved file as failed (a retry would then create "name_2.ext").
    let publishedPath = '';
    let publishedName = '';
    let trashedOriginal = false;
    const checkActive = () => {
      if (job.cancelled) throw new Error(lang === 'ja' ? '処理を中断しました。' : 'Conversion cancelled.');
    };

    try {
      await AppBridge.startConversionJob(job.id);
      checkActive();

      // The converter measures the peak itself and reports the gain it applied.
      let gainMult: number | undefined = tabSettings.sameAsSource || tabSettings.normalize
        ? undefined
        : Math.pow(10, tabSettings.volumeBoostDb / 20);

      addLogToTab(tabId, `[${fileRecord.name}] Step 2: Converting with FFmpeg (resampling: ${tabSettings.sampleRate}Hz, bit depth: ${tabSettings.bitDepth}-bit)...`, 'info');
      updateFileStatus(tabId, id, 'converting', 0);

      let savedOutputPath = '';
      // Set when "overwrite" hit the source file itself: the output got a new name and
      // takes the source's name once the source is in the trash.
      let replacesPath = '';

      const targetExt = getFormatExtension(fileRecord.outputFormat);
      const outputStem = tabSettings.renameByTags && fileRecord.tags
        ? renderFileName(tabSettings.renamePattern, fileRecord.tags, fileRecord.name)
        : renderFileName('%filename%', {}, fileRecord.name);
      let finalExportName = `${outputStem}.${targetExt}`;

      let verificationResult: any = undefined;
      // 1. Save to local disk via IPC
      if (AppBridge.isAvailable()) {
        addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] ファイルをディスクに書き込み中...` : `[${fileRecord.name}] Writing file to disk...`, 'info');
        const saveResult = await AppBridge.saveConvertedFile({
          jobId: job.id,
          settings: tabSettings,
          inputFilePath: fileRecord.path,
          fileName: finalExportName,
          outputFormat: fileRecord.outputFormat,
          // Only edited tags; the converter copies everything else from the source.
          tags: editedTags(fileRecord.tags, fileRecord.sourceTags),
        });

        if (saveResult?.success && saveResult.skipped && saveResult.path) {
          // An existing output was kept. It is not ours: do not verify it and never
          // delete the original because of it.
          batchRef.current.success++;
          addLogToTab(tabId, lang === 'ja'
            ? `[${fileRecord.name}] 出力先に同名のファイルがあるためスキップしました: "${saveResult.path}"`
            : `[${fileRecord.name}] Skipped: the output file already exists: "${saveResult.path}"`, 'info');
          setTabs(prev => prev.map(t => t.id === tabId ? {
            ...t,
            files: t.files.map(f => f.id === id ? { ...f, status: 'completed', progress: 100, outputPath: saveResult.path, outputFileName: saveResult.fileName } : f),
          } : t));
          return;
        }
        if (saveResult?.success && saveResult.path) {
          // Record the saved file before any cancel check can throw.
          publishedPath = saveResult.path;
          publishedName = saveResult.fileName || finalExportName;
          replacesPath = saveResult.replacesPath || '';
          setTabs(prev => prev.map(tab => tab.id === tabId ? { ...tab, files: tab.files.map(file => file.id === id ? { ...file, outputPath: saveResult.path, outputFileName: saveResult.fileName } : file) } : tab));
        }
        checkActive();
        let savedPath = '';
        if (saveResult && saveResult.success && saveResult.path) {
          savedPath = saveResult.path;
          savedOutputPath = savedPath;
          finalExportName = saveResult.fileName || finalExportName;
          if (typeof saveResult.gainDb === 'number') gainMult = Math.pow(10, saveResult.gainDb / 20);
          addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] ディスク保存完了: "${savedPath}"` : `[${fileRecord.name}] Saved successfully to: "${savedPath}"`, 'success');
        } else {
          throw new Error(saveResult?.error || 'Failed to save file');
        }

        if (tabSettings.autoVerifyQuality && fileRecord.path && savedPath) {
          checkActive();
          addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] データ欠損・品質劣化チェックを実行中...` : `[${fileRecord.name}] Verifying quality and data loss...`, 'info');
          // Bit-exact comparison only makes sense when the audio was not changed on purpose.
          const capped = !!tabSettings.maxSampleRate && (fileRecord.sourceSampleRate ?? fileRecord.sampleRate) > tabSettings.maxSampleRate;
          const isLosslessPair = tabSettings.sameAsSource && !capped &&
                                isLosslessSource(fileRecord.sourceLossless, fileRecord.name) &&
                                LOSSLESS_OUTPUT_FORMATS.includes(fileRecord.outputFormat.toUpperCase());
          try {
            const vRes = await AppBridge.verifyAudioQuality({
              jobId: job.id,
              originalPath: fileRecord.path,
              convertedPath: savedPath,
              isLosslessPair,
            });

            checkActive();
            if (vRes && vRes.success && vRes.result) {
              verificationResult = vRes.result;
              const logMsg = lang === 'ja'
                ? `[${fileRecord.name}] 品質検証完了: ${vRes.result.summaryMessage}`
                : `[${fileRecord.name}] Quality audit completed: ${vRes.result.summaryMessage}`;
              addLogToTab(tabId, logMsg, vRes.result.status === 'perfect' || vRes.result.status === 'passed' ? 'success' : 'error');
            } else {
              addLogToTab(tabId, `Quality verification failed: ${vRes?.error || 'No result'}`, 'error');
            }
          } catch (vErr: any) {
            if (job.cancelled) throw vErr;
            addLogToTab(tabId, `Quality verification failed: ${vErr.message}`, 'error');
          }
        }
      }

      if (!savedOutputPath) throw new Error('No output file was saved');
      checkActive();

      // 3. Trash original file if deleteOriginalAfterConvert is active
      let originalDeleted = false;
      if (tabSettings.deleteOriginalAfterConvert && savedOutputPath !== fileRecord.path && (!tabSettings.autoVerifyQuality || verificationResult?.status === 'perfect' || verificationResult?.status === 'passed') && fileRecord.path && AppBridge.isAvailable()) {
        addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] 元ファイルをゴミ箱に移動中...` : `[${fileRecord.name}] Moving original file to trash...`, 'info');
        const trashResult = await AppBridge.trashFile(fileRecord.path, job.id);
        if (trashResult && trashResult.success) {
          addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] 元ファイルをゴミ箱に移動しました。` : `[${fileRecord.name}] Moved original file to trash.`, 'success');
          originalDeleted = true;
          trashedOriginal = true;
          if (replacesPath) {
            const moved = await AppBridge.moveOutputIntoPlace(savedOutputPath, replacesPath);
            if (moved?.success && moved.path) {
              savedOutputPath = moved.path;
              publishedPath = moved.path;
              publishedName = moved.fileName || publishedName;
              addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] 出力を元のファイル名に変更しました: "${moved.path}"` : `[${fileRecord.name}] Renamed the output to the original name: "${moved.path}"`, 'success');
            } else {
              batchRef.current.warnings++;
              addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] 出力を元のファイル名に変更できませんでした: ${moved?.error}` : `[${fileRecord.name}] Could not rename the output to the original name: ${moved?.error}`, 'error');
            }
          }
        } else {
          batchRef.current.warnings++;
          addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] 元ファイルのゴミ箱への移動に失敗しました: ${trashResult.error}` : `[${fileRecord.name}] Failed to move original file to trash: ${trashResult.error}`, 'error');
        }
      }

      checkActive();
      batchRef.current.success++;
      if (tabSettings.autoVerifyQuality && (!verificationResult || !['perfect', 'passed'].includes(verificationResult.status))) batchRef.current.warnings++;
      setTabs(prev => prev.map(t => {
        if (t.id === tabId) {
          return {
            ...t,
            files: t.files.map(f => f.id === id ? {
              ...f,
              outputFileName: publishedName || finalExportName,
              outputPath: savedOutputPath,
              status: 'completed',
              progress: 100,
              normalizationApplied: !tabSettings.sameAsSource && tabSettings.normalize,
              gainMultiplier: gainMult,
              originalDeleted: originalDeleted,
              verificationResult: verificationResult,
            } : f)
          };
        }
        return t;
      }));

      addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] 変換に成功しました。` : `[${fileRecord.name}] Conversion finished successfully.`, 'success');

    } catch (err: any) {
      if (publishedPath) {
        // The file was already written; only the steps after saving were stopped.
        batchRef.current.success++;
        batchRef.current.warnings++;
        addLogToTab(tabId, lang === 'ja'
          ? `[${fileRecord.name}] 出力は保存済みです（"${publishedPath}"）。保存後の処理は中断されました: ${err.message}`
          : `[${fileRecord.name}] Output was saved ("${publishedPath}"); later steps stopped: ${err.message}`, 'info');
        setTabs(prev => prev.map(t => t.id === tabId ? {
          ...t,
          files: t.files.map(f => f.id === id ? { ...f, status: 'completed', progress: 100, outputPath: publishedPath, outputFileName: publishedName, originalDeleted: trashedOriginal } : f),
        } : t));
      } else {
        if (!job.cancelled) batchRef.current.failed++;
        addLogToTab(tabId, lang === 'ja' ? `[${fileRecord.name}] 変換失敗: ${err.message}` : `[${fileRecord.name}] Conversion failed: ${err.message}`, 'error');
        updateFileStatus(tabId, id, 'failed', 0, err.message || 'Conversion failed');
      }
    } finally {
      await AppBridge.finishConversionJob(job.id).catch(() => {});
      jobRef.current = null;
      if (job.cancelled) {
        const message = lang === 'ja' ? `バッチ中断: 成功 ${batchRef.current.success}件、失敗 ${batchRef.current.failed}件` : `Batch cancelled: ${batchRef.current.success} succeeded, ${batchRef.current.failed} failed`;
        addLogToTab(tabId, message, 'info');
        showToast('info', message);
        setIsConverting(false);
        activeConversionIdRef.current = null;
        activeConversionTabIdRef.current = null;
      } else processNextInQueue();
    }
  };

  const handleVerifyQuality = async (id: string) => {
    const targetTabId = activeTabId;
    const tab = tabs.find(t => t.id === targetTabId);
    const file = tab?.files.find(f => f.id === id);
    if (!tab || !file || !file.path || !AppBridge.isAvailable()) {
      showToast('error', lang === 'ja' ? 'ソースファイルのパスが存在しません。' : 'Source file path missing');
      return;
    }

    setTabs(prev => prev.map(t => t.id === targetTabId ? {
      ...t,
      files: t.files.map(f => f.id === id ? { ...f, isVerifying: true } : f)
    } : t));

    const outputPath = file.outputPath;
    if (!outputPath) {
      setTabs(prev => prev.map(t => t.id === targetTabId ? { ...t, files: t.files.map(f => f.id === id ? { ...f, isVerifying: false } : f) } : t));
      showToast('error', lang === 'ja' ? '保存済みの出力パスがありません。再変換してください。' : 'Saved output path missing. Convert again.');
      return;
    }

    addLogToTab(targetTabId, lang === 'ja' ? `[${file.name}] 再検証を実行中...` : `[${file.name}] Re-running quality verification...`, 'info');
    const capped = !!tab.settings.maxSampleRate && (file.sourceSampleRate ?? file.sampleRate) > tab.settings.maxSampleRate;
    const isLosslessPair = (tab.settings.sameAsSource ?? true) && !capped &&
                          isLosslessSource(file.sourceLossless, file.name) &&
                          LOSSLESS_OUTPUT_FORMATS.includes(file.outputFormat.toUpperCase());

    try {
      const vRes = await AppBridge.verifyAudioQuality({
        originalPath: file.path,
        convertedPath: outputPath,
        isLosslessPair,
      });

      if (vRes && vRes.success && vRes.result) {
        addLogToTab(targetTabId, lang === 'ja' ? `[${file.name}] 品質検証完了: ${vRes.result.summaryMessage}` : `[${file.name}] Quality audit finished: ${vRes.result.summaryMessage}`, 'success');
        setTabs(prev => prev.map(t => t.id === targetTabId ? {
          ...t,
          files: t.files.map(f => f.id === id ? {
            ...f,
            isVerifying: false,
            verificationResult: vRes.result
          } : f)
        } : t));
      } else {
        showToast('error', vRes?.error || (lang === 'ja' ? '検証に失敗しました。' : 'Verification failed'));
        setTabs(prev => prev.map(t => t.id === targetTabId ? {
          ...t,
          files: t.files.map(f => f.id === id ? { ...f, isVerifying: false } : f)
        } : t));
      }
    } catch (e: any) {
      showToast('error', e.message || 'Verification exception');
      setTabs(prev => prev.map(t => t.id === targetTabId ? {
        ...t,
        files: t.files.map(f => f.id === id ? { ...f, isVerifying: false } : f)
      } : t));
    }
  };

  const updateFileStatus = (
    tabId: string,
    id: string,
    status: AudioFile['status'],
    progress: number,
    error?: string
  ) => {
    setTabs(prev => prev.map(t => {
      if (t.id === tabId) {
        return {
          ...t,
          files: t.files.map(f => f.id === id ? { ...f, status, progress, error } : f)
        };
      }
      return t;
    }));
  };

  const handleCancelConversion = () => {
    const targetTabId = activeConversionTabIdRef.current;
    if (!targetTabId) return;

    conversionQueueRef.current = [];
    const job = jobRef.current;
    if (!job || job.cancelled) return;
    job.cancelled = true;
    AppBridge.cancelConversionJob(job.id).catch(error => {
      addLogToTab(targetTabId, `Cancellation request failed: ${error.message}`, 'error');
    });
    showToast('info', lang === 'ja' ? '処理を停止しています…' : 'Stopping conversion…');
  };


  const handleUpdateTags = (id: string, newTags: Partial<MetadataTags>) => {
    const targetTabId = activeTabId;
    setTabs(prev => prev.map(t => {
      if (t.id === targetTabId) {
        return {
          ...t,
          files: t.files.map(f => f.id === id ? {
            ...f,
            tags: { ...f.tags, ...newTags },
          } : f)
        };
      }
      return t;
    }));
    addLogToTab(targetTabId, lang === 'ja' ? `トラック ID: ${id} のメタデータタグを更新しました。` : `Updated metadata tags for track ID: ${id}`, 'info');
    showToast('success', lang === 'ja' ? '出力用メタデータを更新しました。変換時に保存します。' : 'Output metadata updated. It will be saved on conversion.');
  };

  const handleResetQueueStatus = () => {
    if (activeConversionTabIdRef.current) return;
    const targetTabId = activeTabId;
    setTabs(prev => prev.map(t => {
      if (t.id === targetTabId) {
        return {
          ...t,
          files: t.files.map(f => ({
            ...f,
            status: 'queued',
            progress: 0,
            error: undefined,
            verificationResult: undefined,
            outputPath: undefined,
            outputFileName: undefined,
            outputFormat: t.settings.outputFormat,
            bitrate: t.settings.bitrate,
            sampleRate: t.settings.sampleRate,
            channels: t.settings.channels,
          }))
        };
      }
      return t;
    }));
    addLogToTab(targetTabId, lang === 'ja' ? '全トラックの変換ステータスを待機中 (queued) にリセットしました。' : 'Reset all track conversion statuses to queued.', 'info');
    showToast('info', lang === 'ja' ? 'キューのステータスを待機中にリセットしました。' : 'Queue statuses reset to queued.');
  };

  return (
    <AudioConverterContext.Provider
      value={{
        files,
        setFiles,
        settings,
        setSettings,
        selectedFileId,
        setSelectedFileId,
        isConverting,
        toast,
        setToast,
        showToast,
        handleAddFiles,
        handleStartConversion,
        handleCancelConversion,
        handleUpdateTags,
        handleVerifyQuality,
        handleResetQueueStatus,

        // Tab-related Extensions
        tabs,
        setTabs,
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
        setLang,
      }}
    >
      {children}
    </AudioConverterContext.Provider>
  );
};

export const useAudioConverter = () => {
  const context = useContext(AudioConverterContext);
  if (context === undefined) {
    throw new Error('useAudioConverter must be used within an AudioConverterProvider');
  }
  return context;
};
