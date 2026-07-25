/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import { useAudioConverter } from '../context/AudioConverterContext';
import { 
  Sliders, Volume2, Cpu, Bell, ShieldCheck, Zap, Laptop, 
  Folder, Plus, Trash, FileText, Sparkles 
} from '../components/Icons';
import { ConverterSettings, SettingsPreset } from '../types';

export default function SettingsPage() {
  const { settings, setSettings } = useAudioConverter();
  
  const [presets, setPresets] = useState<SettingsPreset[]>([]);
  const [newPresetName, setNewPresetName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');

  // Standard factory presets
  const factoryPresets: SettingsPreset[] = [
    {
      id: 'factory-wav-hq',
      name: 'Studio WAV (Lossless)',
      isCustom: false,
      settings: {
        outputFormat: 'WAV',
        bitrate: '320',
        sampleRate: 48000,
        bitDepth: '24',
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
        autoVerifyQuality: true,
        sameAsSource: false,
        electronDesktopMode: true,
        deleteOriginalAfterConvert: false,
        saveInSourceFolder: true,
        renameByTags: true,
        renamePattern: '{artist} - {title}',
        localSavePath: '~/Music/X-Conv-Outputs',
      }
    },
    {
      id: 'factory-mp3-pod',
      name: 'Podcast Optimized MP3',
      isCustom: false,
      settings: {
        outputFormat: 'MP3',
        bitrate: '192',
        sampleRate: 44100,
        bitDepth: '16',
        channels: 1, // Mono podcast
        normalize: true,
        normalizationTargetDb: -2.0,
        autoNotification: true,
        notificationSound: 'glass',
        volumeBoostDb: 3, // Boost speech slightly
        trimSilence: true,
        trimSilenceThresholdDb: -45,
        threadPoolSize: 4,
        ffmpegHighSpeed: true,
        autoRemoveCompleted: true,
        autoVerifyQuality: true,
        sameAsSource: false,
        electronDesktopMode: true,
        deleteOriginalAfterConvert: true, // Delete voice memos after conversion
        saveInSourceFolder: true,
        renameByTags: true,
        renamePattern: '{track} - {title}',
        localSavePath: '~/Podcasts/Audits',
      }
    },
    {
      id: 'factory-flac-archive',
      name: 'Archival FLAC (Same as Source)',
      isCustom: false,
      settings: {
        outputFormat: 'FLAC',
        bitrate: '320',
        sampleRate: 96000, // High-res sampling
        bitDepth: '24',
        channels: 2,
        normalize: false,
        normalizationTargetDb: -1.0,
        autoNotification: true,
        notificationSound: 'digital',
        volumeBoostDb: 0,
        trimSilence: false,
        trimSilenceThresholdDb: -50,
        threadPoolSize: 8,
        ffmpegHighSpeed: false, // Maximum filter quality
        autoRemoveCompleted: false,
        autoVerifyQuality: true,
        sameAsSource: true,
        electronDesktopMode: false,
        deleteOriginalAfterConvert: false,
        saveInSourceFolder: false,
        renameByTags: false,
        renamePattern: '{artist} - {album} - {title}',
        localSavePath: '~/Archive/Lossless',
      }
    }
  ];

  // Load custom presets from local storage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const loaded = localStorage.getItem('xconv_custom_presets');
      if (loaded) {
        try {
          setPresets(JSON.parse(loaded));
        } catch (e) {
          console.error('Failed to parse custom presets', e);
        }
      }
    }
  }, []);

  const saveCustomPreset = () => {
    if (!newPresetName.trim()) return;
    
    const newPreset: SettingsPreset = {
      id: 'preset_' + Math.random().toString(36).substring(2, 11),
      name: newPresetName.trim(),
      isCustom: true,
      settings: { ...settings }
    };

    const updated = [...presets, newPreset];
    setPresets(updated);
    if (typeof window !== 'undefined') {
      localStorage.setItem('xconv_custom_presets', JSON.stringify(updated));
    }
    setNewPresetName('');
    setSelectedPresetId(newPreset.id);
    alert(`Preset "${newPreset.name}" successfully saved to local storage!`);
  };

  const deleteCustomPreset = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = presets.filter(p => p.id !== id);
    setPresets(updated);
    if (typeof window !== 'undefined') {
      localStorage.setItem('xconv_custom_presets', JSON.stringify(updated));
    }
    if (selectedPresetId === id) {
      setSelectedPresetId('');
    }
  };

  const applyPreset = (preset: SettingsPreset) => {
    setSettings(preset.settings);
    setSelectedPresetId(preset.id);
  };

  const updateSetting = <K extends keyof ConverterSettings>(key: K, value: ConverterSettings[K]) => {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const sampleRates = [22050, 44100, 48000, 88200, 96000];
  const bitrates = ['128', '192', '256', '320'];
  const bitDepths = ['16', '24', '32'];
  const sounds = [
    { id: 'chime', label: 'Ethereal Chime' },
    { id: 'beep', label: 'Tech Beep' },
    { id: 'glass', label: 'Sleek Glass' },
    { id: 'digital', label: 'Retro Digital' },
  ];

  const getRenamePreview = () => {
    let outputName = settings.renamePattern;
    outputName = outputName.replace('{artist}', 'Beatsmith');
    outputName = outputName.replace('{title}', 'Drum_Loop_120bpm');
    outputName = outputName.replace('{album}', 'X-Conv Synthesized Studio');
    outputName = outputName.replace('{track}', '04');
    outputName = outputName.replace('{year}', '2026');
    outputName = outputName.replace('{genre}', 'Electronic');
    return `${outputName}.${settings.outputFormat.toLowerCase()}`;
  };

  return (
    <>
      <Head>
        <title>Encoder Settings - X-Conv Audio Suite</title>
      </Head>

      <div id="settings-panel" className="flex-1 overflow-y-auto bg-zinc-950 p-6 text-zinc-300">
        <div className="max-w-4xl mx-auto space-y-6">
          
          {/* Panel Header */}
          <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
            <div>
              <h2 className="text-xl font-bold text-white font-sans tracking-tight">Encoder Configuration</h2>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">FINE-TUNE SAMPLING, PRESETS, AND DIRECT OS DESKTOP PIPELINES</p>
            </div>
            <div className="flex items-center gap-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded-full text-xs font-mono">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>X-CONV ACCELERATED</span>
            </div>
          </div>

          {/* PRESETS SECTION */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800/40">
              <div className="flex items-center gap-2.5 text-white font-medium">
                <Sparkles className="h-4.5 w-4.5 text-emerald-400" />
                <span>Configurations & Presets</span>
              </div>
              <span className="text-[10px] font-mono text-zinc-500">SAVE, LOAD, OR PURGE HARDWARE PROFILES</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Load preset */}
              <div className="space-y-2">
                <label className="text-xs text-zinc-400 font-mono block">SELECT CONFIGURATION TEMPLATE</label>
                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                  {/* Built-in Presets */}
                  <div className="text-[10px] text-zinc-500 font-mono tracking-wider pt-1 uppercase">FACTORY TEMPLATES</div>
                  {factoryPresets.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => applyPreset(p)}
                      className={`w-full flex items-center justify-between p-2 rounded text-xs border text-left transition-all cursor-pointer ${
                        selectedPresetId === p.id
                          ? 'bg-emerald-600/10 text-emerald-400 border-emerald-500/40 font-bold'
                          : 'bg-zinc-950 text-zinc-400 border-zinc-800/80 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      <span>• {p.name}</span>
                      <span className="text-[9px] font-mono px-1 bg-zinc-900 border border-zinc-800 text-zinc-500 rounded">Factory</span>
                    </button>
                  ))}

                  {/* User Presets */}
                  {presets.length > 0 && (
                    <>
                      <div className="text-[10px] text-zinc-500 font-mono tracking-wider pt-2 uppercase">MY CUSTOM CONFIGS</div>
                      {presets.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => applyPreset(p)}
                          className={`w-full flex items-center justify-between p-2 rounded text-xs border text-left transition-all cursor-pointer ${
                            selectedPresetId === p.id
                              ? 'bg-emerald-600/10 text-emerald-400 border-emerald-500/40 font-bold'
                              : 'bg-zinc-950 text-zinc-400 border-zinc-800/80 hover:bg-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <span>★ {p.name}</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-mono px-1 bg-zinc-900 border border-zinc-800 text-amber-500 rounded">Saved</span>
                            <span 
                              onClick={(e) => deleteCustomPreset(p.id, e)}
                              className="p-1 hover:bg-red-950/20 text-zinc-500 hover:text-red-400 rounded transition-colors cursor-pointer"
                            >
                              <Trash className="h-3.5 w-3.5" />
                            </span>
                          </div>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>

              {/* Save current settings as custom preset */}
              <div className="bg-zinc-950/50 border border-zinc-800/60 p-4 rounded-xl flex flex-col justify-between">
                <div className="space-y-2">
                  <span className="text-xs text-zinc-300 font-semibold block">Create Custom Preset</span>
                  <p className="text-[10px] text-zinc-500 font-mono leading-relaxed">
                    Freeze the active audio layout, sample frequencies, Electron output path, and auto-renaming metrics into a persistent custom preset.
                  </p>
                </div>

                <div className="space-y-2 pt-2">
                  <input
                    type="text"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                    placeholder="e.g. My Lofi Mastering Preset"
                  />
                  <button
                    onClick={saveCustomPreset}
                    disabled={!newPresetName.trim()}
                    className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-mono font-semibold rounded flex items-center justify-center gap-1.5 border border-emerald-500 transition-all disabled:opacity-40 cursor-pointer"
                  >
                    <Plus className="h-4 w-4" />
                    <span>FREEZE CURRENT STATE</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Settings Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

            {/* Card 1: Core Format Specifications */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2.5 text-white font-medium pb-2 border-b border-zinc-800/40">
                <Sliders className="h-4.5 w-4.5 text-emerald-400" />
                <span>Output Format Specs</span>
              </div>

              {/* Default Output Format */}
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-400 font-mono">DEFAULT OUTPUT FORMAT</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {(['WAV', 'MP3', 'FLAC', 'M4A', 'OGG'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => updateSetting('outputFormat', fmt)}
                      className={`py-2 rounded text-xs font-mono border transition-all cursor-pointer ${
                        settings.outputFormat === fmt
                          ? 'bg-emerald-600 text-white border-emerald-500 shadow-md shadow-emerald-950/20 font-bold'
                          : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:bg-zinc-800 hover:text-zinc-200'
                      }`}
                    >
                      {fmt}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-500 italic mt-1 leading-relaxed">
                  {settings.outputFormat === 'WAV' 
                    ? 'WAV offers maximum fidelity (lossless 16-bit to 32-bit floats) rendered fully inside your browser.'
                    : `Compressed ${settings.outputFormat} parameters simulate exact sizing ratios, compression speed curves, and bitrate optimizations.`
                  }
                </p>
              </div>

              {/* Same as Source mode toggle */}
              <div className="flex items-center justify-between p-2.5 bg-emerald-950/20 border border-emerald-800/40 rounded-lg">
                <div className="space-y-0.5">
                  <span className="text-xs text-emerald-400 font-bold block">Same as Source (Lossless Quality)</span>
                  <span className="text-[10px] text-zinc-400 font-mono leading-tight block">Preserves original sample rate & depth. Automatically bypasses normalization.</span>
                </div>
                <button
                  onClick={() => updateSetting('sameAsSource', !settings.sameAsSource)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.sameAsSource ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.sameAsSource ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Sample Rate */}
              <div className={`space-y-1.5 ${settings.sameAsSource ? 'opacity-40 pointer-events-none' : ''}`}>
                <label className="text-xs text-zinc-400 font-mono">SAMPLE RATE</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {sampleRates.map((sr) => (
                    <button
                      key={sr}
                      disabled={settings.sameAsSource}
                      onClick={() => updateSetting('sampleRate', sr as any)}
                      className={`py-1.5 rounded text-xs font-mono border transition-all cursor-pointer ${
                        settings.sampleRate === sr
                          ? 'bg-zinc-800 text-emerald-400 border-emerald-500/40 font-semibold'
                          : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:bg-zinc-800'
                      }`}
                    >
                      {sr / 1000}k
                    </button>
                  ))}
                </div>
              </div>

              {/* Channels & Bitrate / Bit depth based on format selection */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-zinc-400 font-mono">CHANNELS</label>
                  <select
                    value={settings.channels}
                    onChange={(e) => updateSetting('channels', parseInt(e.target.value) as any)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none cursor-pointer"
                  >
                    <option value={1}>1 - Mono</option>
                    <option value={2}>2 - Stereo</option>
                    <option value={6}>6 - 5.1 Surround (Sim)</option>
                  </select>
                </div>

                {settings.outputFormat === 'WAV' || settings.outputFormat === 'FLAC' ? (
                  <div className={`space-y-1.5 ${settings.sameAsSource ? 'opacity-40 pointer-events-none' : ''}`}>
                    <label className="text-xs text-zinc-400 font-mono">BIT DEPTH</label>
                    <select
                      disabled={settings.sameAsSource}
                      value={settings.bitDepth}
                      onChange={(e) => updateSetting('bitDepth', e.target.value as any)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none cursor-pointer"
                    >
                      {bitDepths.map((bd) => (
                        <option key={bd} value={bd}>
                          {bd}-bit {bd === '32' ? 'IEEE Float' : 'Integer'}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <label className="text-xs text-zinc-400 font-mono">COMPRESSION BITRATE</label>
                    <select
                      value={settings.bitrate}
                      onChange={(e) => updateSetting('bitrate', e.target.value as any)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none cursor-pointer"
                    >
                      {bitrates.map((br) => (
                        <option key={br} value={br}>
                          {br} kbps (CBR)
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Card 2: DSP & Normalizer */}
            <div className={`bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 space-y-4 transition-all ${settings.sameAsSource ? 'opacity-40 pointer-events-none' : ''}`}>
              <div className="flex items-center gap-2.5 text-white font-medium pb-2 border-b border-zinc-800/40">
                <Volume2 className="h-4.5 w-4.5 text-emerald-400" />
                <span>Normalizer & Volume Gain</span>
              </div>

              {/* Volume Normalization toggle */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block">Volume Normalization</span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">Peak-normalization algorithm (EBU R128 scaling)</span>
                </div>
                <button
                  disabled={settings.sameAsSource}
                  onClick={() => updateSetting('normalize', !settings.normalize)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.normalize && !settings.sameAsSource ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.normalize && !settings.sameAsSource ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Normalization Target slider */}
              {settings.normalize && (
                <div className="space-y-2 pt-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-zinc-400">TARGET PEAK LEVEL</span>
                    <span className="text-emerald-400 font-bold">{settings.normalizationTargetDb} dBFS</span>
                  </div>
                  <input
                    type="range"
                    min="-20.0"
                    max="-0.1"
                    step="0.5"
                    value={settings.normalizationTargetDb}
                    onChange={(e) => updateSetting('normalizationTargetDb', parseFloat(e.target.value))}
                    className="w-full accent-emerald-500 bg-zinc-950 h-1.5 rounded-lg cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                    <span>-20.0 dB (Soft)</span>
                    <span>-1.0 dB (Standard)</span>
                    <span>-0.1 dB (Peak Limit)</span>
                  </div>
                </div>
              )}

              {/* Pre-Gain Booster */}
              <div className="space-y-2 pt-1 border-t border-zinc-800/40">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-zinc-400">MANUAL PRE-GAIN BOOST</span>
                  <span className={`font-bold ${settings.volumeBoostDb > 0 ? 'text-amber-500' : settings.volumeBoostDb < 0 ? 'text-cyan-500' : 'text-zinc-400'}`}>
                    {settings.volumeBoostDb > 0 ? `+${settings.volumeBoostDb}` : settings.volumeBoostDb} dB
                  </span>
                </div>
                <input
                  type="range"
                  min="-12.0"
                  max="24.0"
                  step="1.0"
                  value={settings.volumeBoostDb}
                  onChange={(e) => updateSetting('volumeBoostDb', parseFloat(e.target.value))}
                  className="w-full accent-emerald-500 bg-zinc-950 h-1.5 rounded-lg cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>-12 dB (Cut)</span>
                  <span>0 dB (Dry)</span>
                  <span>+24 dB (High Boost)</span>
                </div>
              </div>

              {/* Silence Trimmer */}
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/40">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block">Silence Auto-Trimming</span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">Strip silent lead-in and decay segments</span>
                </div>
                <button
                  onClick={() => updateSetting('trimSilence', !settings.trimSilence)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.trimSilence ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.trimSilence ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Card 3: Electron native Shell desktop mapping */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2.5 text-white font-medium pb-2 border-b border-zinc-800/40">
                <Laptop className="h-4.5 w-4.5 text-emerald-400" />
                <span>Electron Desktop Shell</span>
              </div>

              {/* Electron Bridge Mode toggle */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block flex items-center gap-1.5">
                    <Folder className="h-3.5 w-3.5 text-emerald-500" />
                    <span>Electron Integration Mode</span>
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">Use local OS folder pathways for batch writes</span>
                </div>
                <button
                  onClick={() => updateSetting('electronDesktopMode', !settings.electronDesktopMode)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.electronDesktopMode ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.electronDesktopMode ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Local Save Path Input */}
              {settings.electronDesktopMode && (
                <div className="space-y-1.5 pt-1">
                  <label className="text-xs text-zinc-400 font-mono block">NATIVE DESKTOP DIRECTORY PATH</label>
                  <input
                    type="text"
                    value={settings.localSavePath}
                    onChange={(e) => updateSetting('localSavePath', e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                    placeholder="e.g. ~/Music/X-Conv-Outputs"
                  />
                  <p className="text-[9px] text-zinc-500 font-mono leading-normal">
                    Electron fs module will output converted streams to this local directory path bypass downloading manually.
                  </p>
                </div>
              )}

              {/* Auto Quality Verification Toggle */}
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/40">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Auto Quality & Data Loss Verification</span>
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">
                    Verify PCM MD5 bit-exact match & signal degradation after conversion
                  </span>
                </div>
                <button
                  onClick={() => updateSetting('autoVerifyQuality', !settings.autoVerifyQuality)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.autoVerifyQuality ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.autoVerifyQuality ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Delete Original after Conversion */}
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/40">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block">Delete original files</span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">
                    Safely remove the pre-converted file from queue upon conversion success
                  </span>
                </div>
                <button
                  onClick={() => updateSetting('deleteOriginalAfterConvert', !settings.deleteOriginalAfterConvert)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.deleteOriginalAfterConvert ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.deleteOriginalAfterConvert ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Card 4: Metadata-driven Renaming Suite */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2.5 text-white font-medium pb-2 border-b border-zinc-800/40">
                <FileText className="h-4.5 w-4.5 text-emerald-400" />
                <span>Metadata Renaming Format</span>
              </div>

              {/* Rename toggle */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block">ID3 Rename on Save</span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">Automatically rename output file based on ID3 tags</span>
                </div>
                <button
                  onClick={() => updateSetting('renameByTags', !settings.renameByTags)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.renameByTags ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.renameByTags ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Pattern Input and Preview */}
              {settings.renameByTags && (
                <div className="space-y-3 pt-1">
                  <div className="space-y-1">
                    <label className="text-xs text-zinc-400 font-mono block">RENAME STRING PATTERN</label>
                    <input
                      type="text"
                      value={settings.renamePattern}
                      onChange={(e) => updateSetting('renamePattern', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-xs text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                      placeholder="e.g. {artist} - {title}"
                    />
                    <div className="flex flex-wrap gap-1 mt-1.5 text-[9px] font-mono text-zinc-500">
                      <span className="px-1 bg-zinc-950 border border-zinc-800 rounded">{'{artist}'}</span>
                      <span className="px-1 bg-zinc-950 border border-zinc-800 rounded">{'{title}'}</span>
                      <span className="px-1 bg-zinc-950 border border-zinc-800 rounded">{'{album}'}</span>
                      <span className="px-1 bg-zinc-950 border border-zinc-800 rounded">{'{track}'}</span>
                      <span className="px-1 bg-zinc-950 border border-zinc-800 rounded">{'{year}'}</span>
                    </div>
                  </div>

                  {/* File preview simulation */}
                  <div className="bg-zinc-950 border border-zinc-800/60 p-2.5 rounded font-mono text-xs space-y-1">
                    <span className="text-[10px] text-zinc-500 uppercase">PREVIEW EXPORT RESOLUTION:</span>
                    <div className="text-emerald-400 font-semibold truncate">
                      {getRenamePreview()}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Card 5: FFmpeg Engine Settings */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2.5 text-white font-medium pb-2 border-b border-zinc-800/40">
                <Cpu className="h-4.5 w-4.5 text-emerald-400" />
                <span>Multi-threading & Engine</span>
              </div>

              {/* Thread count selection */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-zinc-400">PARALLEL CONVERSION CORES</span>
                  <span className="text-emerald-400 font-bold">{settings.threadPoolSize} CORES</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="16"
                  step="1"
                  value={settings.threadPoolSize}
                  onChange={(e) => updateSetting('threadPoolSize', parseInt(e.target.value))}
                  className="w-full accent-emerald-500 bg-zinc-950 h-1.5 rounded-lg cursor-pointer"
                />
                <p className="text-[9px] text-zinc-500 leading-normal font-mono">
                  Specifies how many files are converted simultaneously. Higher values speed up large queues but consume more CPU.
                </p>
              </div>

              {/* FFmpeg High-speed mode */}
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/40">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
                    <span>FFmpeg High-Speed Mode</span>
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">Accelerate operations via pipeline bypasses</span>
                </div>
                <button
                  onClick={() => updateSetting('ffmpegHighSpeed', !settings.ffmpegHighSpeed)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.ffmpegHighSpeed ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.ffmpegHighSpeed ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Card 6: Notifications & Queue Control */}
            <div className="bg-zinc-900 border border-zinc-800/80 rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2.5 text-white font-medium pb-2 border-b border-zinc-800/40">
                <Bell className="h-4.5 w-4.5 text-emerald-400" />
                <span>Completion Notifications</span>
              </div>

              {/* Alert sound toggle */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block">Audible Finish Alert</span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">Play a notification sound upon queue completion</span>
                </div>
                <button
                  onClick={() => updateSetting('autoNotification', !settings.autoNotification)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.autoNotification ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.autoNotification ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Alert sound selection */}
              {settings.autoNotification && (
                <div className="space-y-1.5 pt-1">
                  <label className="text-[10px] text-zinc-400 font-mono block">SELECT AUDIO SIGNATURE</label>
                  <div className="grid grid-cols-2 gap-2">
                    {sounds.map((sound) => (
                      <button
                        key={sound.id}
                        onClick={() => updateSetting('notificationSound', sound.id as any)}
                        className={`px-2.5 py-1.5 rounded text-xs border text-left transition-all cursor-pointer ${
                          settings.notificationSound === sound.id
                            ? 'bg-zinc-800 text-emerald-400 border-emerald-500/30'
                            : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:bg-zinc-800'
                        }`}
                      >
                        • {sound.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Auto-remove completed */}
              <div className="flex items-center justify-between pt-2 border-t border-zinc-800/40">
                <div className="space-y-0.5">
                  <span className="text-xs text-zinc-300 font-semibold block">Auto-Clear Queue</span>
                  <span className="text-[10px] text-zinc-500 font-mono leading-tight block">Remove files from dashboard when finished</span>
                </div>
                <button
                  onClick={() => updateSetting('autoRemoveCompleted', !settings.autoRemoveCompleted)}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                    settings.autoRemoveCompleted ? 'bg-emerald-600' : 'bg-zinc-800'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                      settings.autoRemoveCompleted ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

          </div>

        </div>
      </div>
    </>
  );
}
