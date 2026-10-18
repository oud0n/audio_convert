/**
 * IPC Bridge service that abstracts communication between renderer and backend.
 * Seamlessly supports both Electron (legacy) and Tauri 2.0 (native).
 */
import type { QualityVerificationResult, MetadataTags, ElectronIpcFallback } from '../types';

export interface ProgressPayload {
  jobId: string;
  phase: string;
  progress: number;
}

export interface MetadataResult {
  success: boolean;
  format?: {
    duration: number;
    sampleRate: number;
    numberOfChannels: number;
    bitrate: number;
    bitDepth?: number | null;
    lossless?: boolean;
    codec?: string | null;
  };
  tags?: MetadataTags;
  error?: string;
}

export interface ConvertResult {
  success: boolean;
  path?: string;
  fileName?: string;
  error?: string;
  /** The output already existed and "skip" was chosen; nothing was written. */
  skipped?: boolean;
  /** "Overwrite" hit the source itself; the output may take this path once the source is trashed. */
  replacesPath?: string | null;
  /** Volume change the converter applied (normalization or boost), in dB. */
  gainDb?: number | null;
}

export interface VerificationResponse {
  success: boolean;
  result?: QualityVerificationResult;
  error?: string;
}

/** A file known only by its path (dropped on the Tauri window): the File itself is empty. */
export type PathOnlyFile = File & { path: string; nativeSize: number; pathOnly: true };

export function isPathOnlyFile(f: File): f is PathOnlyFile {
  return (f as any).pathOnly === true && typeof (f as any).path === 'string';
}

export function pathOnlyFile(path: string, name: string, size: number): PathOnlyFile {
  const file = new File([], name) as PathOnlyFile;
  Object.assign(file, { path, nativeSize: size, pathOnly: true });
  return file;
}

export interface DroppedFile {
  path: string;
  name: string;
  size: number;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

function getIpc(): ElectronIpcFallback | undefined {
  return typeof window !== 'undefined' ? window.ipc : undefined;
}

export function isElectron(): boolean {
  return !!getIpc();
}

let previewSeq = 0;

/** GTK (Linux) matches filter patterns case-sensitively; other systems ignore case. */
function pickerExtensions(extensions: string[]): string[] {
  const linux = typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);
  if (!linux) return extensions;
  return extensions.map(e => [...e].map(c => /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c).join(''));
}

export class AppBridge {
  static isAvailable(): boolean {
    return isTauri() || isElectron();
  }

  static getPathForFile(file: File): string {
    const ipc = getIpc();
    if (ipc?.getPathForFile) {
      try {
        return ipc.getPathForFile(file) || '';
      } catch {
        // fallback
      }
    }
    return (file as any).path || '';
  }

  static async readAudioMetadata(filePath: string): Promise<MetadataResult> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<MetadataResult>('read_audio_metadata', { path: filePath });
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<MetadataResult>('read-audio-metadata', filePath);
    }
    throw new Error('No desktop runtime detected');
  }

  /** Native picker for audio files or folders (Tauri only; paths, not file contents). */
  static async pickAudioPaths(folders: boolean, extensions: string[]): Promise<string[]> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open(folders
      ? { directory: true, multiple: true }
      : { multiple: true, filters: [{ name: 'Audio', extensions: pickerExtensions(extensions) }] });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  }

  static async selectDirectory(): Promise<string | null> {
    if (isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({ directory: true, multiple: false });
        if (!selected) return null;
        return Array.isArray(selected) ? selected[0] : selected;
      } catch {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<string | null>('select_directory');
      }
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<string | null>('select-directory');
    }
    return null;
  }

  static async getDefaultSavePath(): Promise<string> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string>('get_default_save_path');
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<string>('get-default-save-path');
    }
    return 'Music/Audio-Convert-Outputs';
  }

  static async saveConvertedFile(request: any): Promise<ConvertResult> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<ConvertResult>('convert_audio', { request });
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<ConvertResult>('save-converted-file', request);
    }
    throw new Error('No desktop runtime detected');
  }

  /** Renames a finished output to `to` in the same folder; never replaces an existing file. */
  static async moveOutputIntoPlace(from: string, to: string): Promise<ConvertResult> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<ConvertResult>('move_output_into_place', { from, to });
    }
    return { success: false, error: 'Not supported in this runtime' };
  }

  /** Expands dropped paths (folders recursively) to the files with one of `extensions`. */
  /** `truncated`: more files than the backend's limit (10000) were found. */
  static async expandDroppedPaths(paths: string[], extensions: string[]): Promise<{ files: DroppedFile[]; truncated: boolean }> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<{ files: DroppedFile[]; truncated: boolean }>('expand_dropped_paths', { paths, extensions });
    }
    return { files: [], truncated: false };
  }

  /** A new preview request id; ids only grow (also across page reloads). */
  static nextPreviewId(): number {
    previewSeq = (previewSeq + 1) % 1000;
    return Date.now() * 1000 + previewSeq;
  }

  /** Stops preview decodes started before `requestId` was made. */
  static async cancelPreview(requestId: number): Promise<void> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cancel_preview', { requestId });
    }
  }

  /** Decodes a file for the waveform/player; a newer request or cancel stops it. */
  static async decodeAudioToWav(filePath: string, requestId?: number): Promise<ArrayBuffer> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      // The backend answers with raw bytes (an ArrayBuffer).
      const data = await invoke<ArrayBuffer | number[] | Uint8Array>('decode_audio_to_wav', { filePath, requestId });
      if (data instanceof ArrayBuffer) return data;
      if (data instanceof Uint8Array) {
        return (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      }
      return new Uint8Array(data).buffer as ArrayBuffer;
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<ArrayBuffer>('decode-audio-to-wav', filePath);
    }
    throw new Error('No desktop runtime detected');
  }

  static async verifyAudioQuality(params: {
    originalPath: string;
    convertedPath: string;
    isLosslessPair: boolean;
    jobId?: string;
  }): Promise<VerificationResponse> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<VerificationResponse>('verify_audio_quality', {
        originalPath: params.originalPath,
        convertedPath: params.convertedPath,
        isLosslessPair: params.isLosslessPair,
        jobId: params.jobId,
      });
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<VerificationResponse>('verify-audio-quality', params);
    }
    throw new Error('No desktop runtime detected');
  }

  static async trashFile(filePath: string, jobId?: string): Promise<{ success: boolean; error?: string }> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<{ success: boolean; error?: string }>('trash_file', { filePath, jobId });
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<{ success: boolean; error?: string }>('trash-file', filePath, jobId);
    }
    throw new Error('No desktop runtime detected');
  }

  static async loadSettings(): Promise<any> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<any>('load_settings');
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<any>('load-settings-file');
    }
    return null;
  }

  static async saveSettings(settings: any): Promise<{ success: boolean; error?: string }> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<{ success: boolean; error?: string }>('save_settings', { settings });
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<{ success: boolean; error?: string }>('save-settings-file', settings);
    }
    return { success: false, error: 'No desktop runtime detected' };
  }

  static async startConversionJob(jobId: string): Promise<void> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('start_conversion_job', { jobId });
      return;
    }
    const ipc = getIpc();
    if (ipc) {
      await ipc.invoke('start-conversion-job', jobId);
    }
  }

  static async cancelConversionJob(jobId: string): Promise<void> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cancel_conversion_job', { jobId });
      return;
    }
    const ipc = getIpc();
    if (ipc) {
      await ipc.invoke('cancel-conversion-job', jobId);
    }
  }

  static async finishConversionJob(jobId: string): Promise<void> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('finish_conversion_job', { jobId });
      return;
    }
    const ipc = getIpc();
    if (ipc) {
      await ipc.invoke('finish-conversion-job', jobId);
    }
  }

  static onProgress(callback: (payload: ProgressPayload) => void): () => void {
    if (isTauri()) {
      let unlistenFn: (() => void) | null = null;
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen<ProgressPayload>('conversion-progress', (event) => {
          callback(event.payload);
        }).then((unlisten) => {
          unlistenFn = unlisten;
        });
      });
      return () => {
        if (unlistenFn) unlistenFn();
      };
    }
    const ipc = getIpc();
    if (ipc) {
      return ipc.on<ProgressPayload>('conversion-progress', (arg: ProgressPayload) => {
        if (arg) callback(arg);
      });
    }
    return () => {};
  }

  static logDebug(msg: string): void {
    if (isTauri()) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('log_debug', { message: msg }).catch(() => {});
      }).catch(() => {});
      return;
    }
    const ipc = getIpc();
    if (ipc) {
      ipc.send('log-debug', msg);
    }
  }
}
