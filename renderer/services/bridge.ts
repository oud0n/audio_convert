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
  };
  tags?: MetadataTags;
  error?: string;
}

export interface ConvertResult {
  success: boolean;
  path?: string;
  fileName?: string;
  error?: string;
}

export interface VerificationResponse {
  success: boolean;
  result?: QualityVerificationResult;
  error?: string;
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

  static async readOutputPreview(filePath: string, jobId?: string): Promise<ArrayBuffer> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke<number[] | Uint8Array>('read_output_preview', { filePath, jobId });
      if (data instanceof Uint8Array) {
        return (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      }
      return new Uint8Array(data).buffer as ArrayBuffer;
    }
    const ipc = getIpc();
    if (ipc) {
      return await ipc.invoke<ArrayBuffer>('read-output-preview', filePath, jobId);
    }
    throw new Error('No desktop runtime detected');
  }

  static async decodeAudioToWav(filePath: string): Promise<ArrayBuffer> {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const data = await invoke<number[] | Uint8Array>('decode_audio_to_wav', { filePath });
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
