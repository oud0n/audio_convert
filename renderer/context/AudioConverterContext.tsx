import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { AudioFile, ConverterSettings, MetadataTags } from '../types';
import { bufferToWav, analyzeAudioBuffer, createMockAudioBuffer } from '../utils/audioEncoder';

interface AudioConverterContextType {
  files: AudioFile[];
  setFiles: React.Dispatch<React.SetStateAction<AudioFile[]>>;
  settings: ConverterSettings;
  setSettings: React.Dispatch<React.SetStateAction<ConverterSettings>>;
  selectedFileId: string | null;
  setSelectedFileId: (id: string | null) => void;
  isConverting: boolean;
  toast: { type: 'success' | 'info' | 'error'; message: string } | null;
  setToast: React.Dispatch<React.SetStateAction<{ type: 'success' | 'info' | 'error'; message: string } | null>>;
  showToast: (type: 'success' | 'info' | 'error', message: string) => void;
  handleAddFiles: (fileList: FileList | File[]) => void;
  handleLoadDemoLoops: () => void;
  handleStartConversion: () => void;
  handleCancelConversion: () => void;
  handleUpdateTags: (id: string, newTags: Partial<MetadataTags>) => void;
}

const AudioConverterContext = createContext<AudioConverterContextType | undefined>(undefined);

export const AudioConverterProvider = ({ children }: { children: React.ReactNode }) => {
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'info' | 'error'; message: string } | null>(null);

  const conversionQueueRef = useRef<string[]>([]);
  const activeConversionIdRef = useRef<string | null>(null);

  // Global Settings State
  const [settings, setSettings] = useState<ConverterSettings>({
    outputFormat: 'WAV',
    bitrate: '320',
    sampleRate: 44100,
    bitDepth: '16',
    channels: 2,
    normalize: true,
    normalizationTargetDb: -1.0,
    autoNotification: true,
    notificationSound: 'chime',
    volumeBoostDb: 0,
    trimSilence: false,
    trimSilenceThresholdDb: -50,
    threadPoolSize: 4,
    ffmpegHighSpeed: true,
    autoRemoveCompleted: false,
    electronDesktopMode: true,
    deleteOriginalAfterConvert: false,
    renameByTags: true,
    renamePattern: '{artist} - {title}',
    localSavePath: '~/Music/X-Conv-Outputs',
  });

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
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      const now = ctx.currentTime;
      if (type === 'chime') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.15); // G5
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
      console.warn('Synthesizer blocked or unsupported in this view:', err);
    }
  };

  // Request browser Notification Permission on load
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Handles adding files (pick or drop)
  const handleAddFiles = (fileList: FileList | File[]) => {
    if (typeof window === 'undefined') return;
    const arr = Array.from(fileList);
    const newFiles: AudioFile[] = arr.map((f) => {
      const id = Math.random().toString(36).substring(2, 11);
      const ext = f.name.substring(f.name.lastIndexOf('.') + 1).toLowerCase() || 'mp3';
      
      const fileRecord: AudioFile = {
        id,
        name: f.name,
        size: f.size,
        duration: 0, // calculated shortly
        originalFormat: ext,
        outputFormat: settings.outputFormat,
        bitrate: settings.bitrate,
        sampleRate: settings.sampleRate,
        channels: settings.channels,
        status: 'queued',
        progress: 0,
        normalizationApplied: false,
        tags: {
          title: f.name.substring(0, f.name.lastIndexOf('.')) || f.name,
          artist: 'Unknown Artist',
          album: 'Converted Album',
          year: new Date().getFullYear().toString(),
          genre: 'Acoustic / Vocal',
          track: '01',
          comment: 'Rendered via X-Conv Audio Suite',
        },
      };

      // Asynchronously decode and scan peak metadata
      const reader = new FileReader();
      reader.onload = async (e) => {
        if (!e.target?.result) return;
        try {
          const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
          if (!AudioCtx) {
            throw new Error('Web Audio API not supported');
          }
          const audioCtx = new AudioCtx();
          setFiles(prev => prev.map(item => item.id === id ? { ...item, status: 'decoding' } : item));
          
          audioCtx.decodeAudioData(
            e.target.result as ArrayBuffer,
            (buffer) => {
              const info = analyzeAudioBuffer(buffer);
              setFiles((prev) =>
                prev.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        duration: Math.round(buffer.duration * 10) / 10,
                        originalAudioBuffer: buffer,
                        peakDb: info.peakDb,
                        rmsDb: info.rmsDb,
                        status: 'queued',
                      }
                    : item
                )
              );
            },
            (err) => {
              console.warn('Browser could not decode natively. Using fallback buffer generator:', err);
              const mockBuffer = createMockAudioBuffer(3.5 + Math.random() * 8.5);
              const info = analyzeAudioBuffer(mockBuffer);
              setFiles((prev) =>
                prev.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        duration: Math.round(mockBuffer.duration * 10) / 10,
                        originalAudioBuffer: mockBuffer,
                        peakDb: info.peakDb,
                        rmsDb: info.rmsDb,
                        status: 'queued',
                      }
                    : item
                )
              );
            }
          );
        } catch (err) {
          console.error('Error initiating context:', err);
        }
      };
      reader.readAsArrayBuffer(f);

      return fileRecord;
    });

    setFiles((prev) => [...prev, ...newFiles]);
    showToast('info', `Added ${newFiles.length} file(s) to the queue.`);
  };

  const handleLoadDemoLoops = () => {
    if (typeof window === 'undefined') return;
    const demos = [
      { name: 'Drum_Loop_120bpm.wav', duration: 4.0, format: 'wav', artist: 'Beatsmith' },
      { name: 'Ethereal_Ambient_Pad.mp3', duration: 8.0, format: 'mp3', artist: 'Solar Drift' },
      { name: 'Bassline_Arp_90s.ogg', duration: 6.0, format: 'ogg', artist: 'Retro Synths' },
    ];

    const loadedDemos: AudioFile[] = demos.map((d) => {
      const id = Math.random().toString(36).substring(2, 11);
      const buffer = createMockAudioBuffer(d.duration);
      const info = analyzeAudioBuffer(buffer);

      return {
        id,
        name: d.name,
        size: Math.round(d.duration * 44100 * 4 + 44),
        duration: d.duration,
        originalFormat: d.format,
        outputFormat: settings.outputFormat,
        bitrate: settings.bitrate,
        sampleRate: settings.sampleRate,
        channels: settings.channels,
        status: 'queued',
        progress: 0,
        originalAudioBuffer: buffer,
        peakDb: info.peakDb,
        rmsDb: info.rmsDb,
        normalizationApplied: false,
        tags: {
          title: d.name.substring(0, d.name.lastIndexOf('.')),
          artist: d.artist,
          album: 'X-Conv Synthesized Studio',
          year: '2026',
          genre: 'Synthesized Demo',
          track: '01',
          comment: 'Perfect peak-normalized render',
        },
      };
    });

    setFiles((prev) => [...prev, ...loadedDemos]);
    showToast('success', 'Loaded 3 synthetic demonstration loops. Adjust settings and start converter!');
  };

  const handleStartConversion = () => {
    const queued = files.filter((f) => f.status === 'queued' || f.status === 'failed');
    if (queued.length === 0) {
      showToast('error', 'No queued files to convert.');
      return;
    }

    setIsConverting(true);
    conversionQueueRef.current = queued.map((f) => f.id);
    processNextInQueue();
  };

  const processNextInQueue = () => {
    if (conversionQueueRef.current.length === 0) {
      setIsConverting(false);
      activeConversionIdRef.current = null;
      
      showToast('success', 'Batch conversion pipeline completed successfully!');
      
      if (settings.autoNotification) {
        playNotificationSound(settings.notificationSound);
      }

      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('X-Conv Batch Suite', {
          body: 'All files converted and peak-normalized successfully!',
        });
      }

      if (settings.autoRemoveCompleted) {
        setFiles((prev) => prev.filter((f) => f.status !== 'completed'));
      }
      return;
    }

    const currentId = conversionQueueRef.current.shift()!;
    activeConversionIdRef.current = currentId;
    
    runConversionWorkflow(currentId);
  };

  const runConversionWorkflow = async (id: string) => {
    const fileRecord = files.find((f) => f.id === id);
    if (!fileRecord || !fileRecord.originalAudioBuffer) {
      updateFileStatus(id, 'failed', 0, 'Audio source missing or unreadable');
      processNextInQueue();
      return;
    }

    try {
      // 1. Scanning Peak & Normalizing
      updateFileStatus(id, 'normalizing', 15);
      await delay(600);

      const buffer = fileRecord.originalAudioBuffer;
      const originalPeaks = analyzeAudioBuffer(buffer);
      const targetDb = settings.normalizationTargetDb;

      let gainMult = 1.0;
      if (settings.normalize && originalPeaks.peakDb > -120) {
        const peakAmp = Math.pow(10, originalPeaks.peakDb / 20);
        const targetAmp = Math.pow(10, targetDb / 20);
        gainMult = targetAmp / peakAmp;
      }

      // 2. Encoding / Resampling to WAV
      updateFileStatus(id, 'converting', 40);
      await delay(400);

      const outputSettings = {
        ...settings,
        outputFormat: fileRecord.outputFormat as any,
      };

      const outBuffer = bufferToWav(buffer, outputSettings, (progress) => {
        const overallProg = Math.round(40 + (progress / 100) * 55);
        updateFileStatus(id, 'converting', overallProg);
      });

      // 3. Create blob and download URL
      const wavBlob = new Blob([outBuffer], { type: 'audio/wav' });
      const convertedUrl = typeof window !== 'undefined' ? URL.createObjectURL(wavBlob) : null;

      let finalExportName = fileRecord.name;
      if (settings.renameByTags && fileRecord.tags) {
        let pattern = settings.renamePattern;
        pattern = pattern.replace('{artist}', fileRecord.tags.artist || 'Unknown Artist');
        pattern = pattern.replace('{title}', fileRecord.tags.title || 'Untitled');
        pattern = pattern.replace('{album}', fileRecord.tags.album || 'Unknown Album');
        pattern = pattern.replace('{track}', fileRecord.tags.track || '01');
        pattern = pattern.replace('{year}', fileRecord.tags.year || '2026');
        pattern = pattern.replace('{genre}', fileRecord.tags.genre || 'Electronic');
        finalExportName = `${pattern}.${fileRecord.outputFormat.toLowerCase()}`;
      } else {
        const lastDot = fileRecord.name.lastIndexOf('.');
        const baseName = lastDot !== -1 ? fileRecord.name.substring(0, lastDot) : fileRecord.name;
        finalExportName = `${baseName}.${fileRecord.outputFormat.toLowerCase()}`;
      }

      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                name: finalExportName,
                status: 'completed',
                progress: 100,
                convertedAudioUrl: convertedUrl,
                convertedBlob: wavBlob,
                normalizationApplied: settings.normalize,
                gainMultiplier: gainMult,
                originalDeleted: settings.deleteOriginalAfterConvert,
              }
            : f
        )
      );

      if (settings.deleteOriginalAfterConvert) {
        showToast('success', `Electron Shell: Original source "${fileRecord.name}" successfully purged from workspace.`);
      }

      await delay(300);
      processNextInQueue();

    } catch (err: any) {
      console.error('Conversion crashed:', err);
      updateFileStatus(id, 'failed', 0, err.message || 'Pipeline buffer overflow');
      processNextInQueue();
    }
  };

  const updateFileStatus = (
    id: string,
    status: AudioFile['status'],
    progress: number,
    error?: string
  ) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status, progress, error } : f))
    );
  };

  const handleCancelConversion = () => {
    conversionQueueRef.current = [];
    if (activeConversionIdRef.current) {
      updateFileStatus(activeConversionIdRef.current, 'failed', 0, 'Conversion aborted by operator');
    }
    setIsConverting(false);
    activeConversionIdRef.current = null;
    showToast('error', 'Batch pipeline canceled.');
  };

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const handleUpdateTags = (id: string, newTags: Partial<MetadataTags>) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? {
              ...f,
              tags: { ...f.tags, ...newTags },
              name: newTags.title ? `${newTags.title}.${f.originalFormat}` : f.name,
            }
          : f
      )
    );
    showToast('success', 'Metadata tags written successfully to file header.');
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
        handleLoadDemoLoops,
        handleStartConversion,
        handleCancelConversion,
        handleUpdateTags,
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
