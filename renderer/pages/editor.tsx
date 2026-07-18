/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useAudioConverter } from '../context/AudioConverterContext';
import { Play, Pause, Save, FileAudio, Music4 } from '../components/Icons';
import { MetadataTags } from '../types';

export default function WaveformEditorPage() {
  const { files, selectedFileId, handleUpdateTags: onUpdateTags } = useAudioConverter();
  
  const selectedFile = files.find(f => f.id === selectedFileId) || null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [volume, setVolume] = useState(0.8);
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

  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number>(0);
  const animationFrameRef = useRef<number | null>(null);

  // Sync state when selected file changes
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
  }, [selectedFile]);

  // Handle waveform rendering
  useEffect(() => {
    if (!canvasRef.current || !selectedFile || !selectedFile.originalAudioBuffer) {
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.fillStyle = '#09090b';
          ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          ctx.font = '12px "JetBrains Mono", monospace';
          ctx.fillStyle = '#3f3f46';
          ctx.textAlign = 'center';
          ctx.fillText('SELECT A QUEUED AUDIO FILE TO DRAW WAVEFORM', canvasRef.current.width / 2, canvasRef.current.height / 2);
        }
      }
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const buffer = selectedFile.originalAudioBuffer;
    const channelData = buffer.getChannelData(0); // Take Left channel
    const width = canvas.width;
    const height = canvas.height;

    // Clear and background
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines
    ctx.strokeStyle = '#18181b';
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

    // Centered axis line
    ctx.strokeStyle = '#27272a';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Waveform Drawing params
    const step = Math.ceil(channelData.length / width);
    const amp = height / 2;

    // Draw sample lines
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
        ctx.strokeStyle = '#3f3f46'; // zinc-600
      }

      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();
    }

    // Draw active cursor playhead
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

  }, [selectedFile, playbackProgress]);

  // Handle Play/Pause actions
  const togglePlayback = () => {
    if (!selectedFile || !selectedFile.originalAudioBuffer) return;

    if (isPlaying) {
      pausePlayback();
    } else {
      startPlayback();
    }
  };

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

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);

    sourceNodeRef.current = source;

    const duration = buffer.duration;
    const offset = pausedAtRef.current;

    source.start(0, offset);
    startTimeRef.current = ctx.currentTime - offset;
    setIsPlaying(true);

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const updateProgress = () => {
      if (!ctx || !isPlaying) return;
      const elapsed = ctx.currentTime - startTimeRef.current;
      
      if (elapsed >= duration) {
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
    setIsPlaying(false);
  };

  useEffect(() => {
    return () => {
      stopPlayback();
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
      }
    };
  }, []);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
  };

  const handleSaveTags = () => {
    if (selectedFile) {
      onUpdateTags(selectedFile.id, tags);
    }
  };

  const handleInputChange = (field: keyof MetadataTags, val: string) => {
    setTags(prev => ({
      ...prev,
      [field]: val,
    }));
  };

  const formatTime = (timeInSecs: number) => {
    const minutes = Math.floor(timeInSecs / 60);
    const seconds = Math.floor(timeInSecs % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <>
      <Head>
        <title>Waveform & Tag Editor - X-Conv Audio Suite</title>
      </Head>

      <div id="waveform-editor-panel" className="flex-1 overflow-y-auto bg-zinc-950 p-6 text-zinc-300">
        <div className="max-w-4xl mx-auto space-y-6">
          
          {/* Panel Header */}
          <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
            <div>
              <h2 className="text-xl font-bold text-white font-sans tracking-tight">Audio Waveform & Tag Editor</h2>
              <p className="text-xs text-zinc-500 font-mono mt-0.5">EDIT METADATA TAGS AND REVIEW AUDIO FREQUENCIES IN REAL-TIME</p>
            </div>
            {selectedFile && (
              <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-3 py-1 rounded">
                FILE: {selectedFile.name.length > 35 ? selectedFile.name.slice(0, 32) + '...' : selectedFile.name}
              </div>
            )}
          </div>

          {selectedFile ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Left: Waveform display and Playback controllers */}
              <div className="lg:col-span-2 space-y-4">
                
                {/* Waveform Canvas block */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3 shadow-md">
                  <div className="flex items-center justify-between text-xs text-zinc-400 font-mono pb-2 border-b border-zinc-800/50">
                    <span className="flex items-center gap-1.5">
                      <FileAudio className="h-4 w-4 text-emerald-400" />
                      <span>AUDIO WAVEFORM DESCRIPTOR</span>
                    </span>
                    <span>{formatTime(playbackTime)} / {formatTime(selectedFile.duration)}</span>
                  </div>

                  <div className="relative rounded-lg overflow-hidden border border-zinc-950">
                    <canvas
                      ref={canvasRef}
                      width={560}
                      height={160}
                      className="w-full h-40 bg-zinc-950 cursor-pointer block"
                    />
                  </div>

                  {/* Interactive Player Controls */}
                  <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={togglePlayback}
                        className={`h-9 px-4 rounded font-mono text-xs font-semibold flex items-center gap-2 border transition-all cursor-pointer ${
                          isPlaying
                            ? 'bg-rose-600/15 border-rose-500/30 text-rose-400 hover:bg-rose-600/20'
                            : 'bg-emerald-600 text-white border-emerald-500 hover:bg-emerald-500'
                        }`}
                      >
                        {isPlaying ? (
                          <>
                            <Pause className="h-3.5 w-3.5 fill-current" />
                            <span>PAUSE TRACK</span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5 fill-current" />
                            <span>PLAY AUDIT</span>
                          </>
                        )}
                      </button>
                      
                      <button
                        onClick={stopPlayback}
                        className="h-9 px-3 bg-zinc-800 border border-zinc-700/80 hover:bg-zinc-700 rounded text-zinc-300 font-mono text-xs transition-all cursor-pointer"
                      >
                        STOP
                      </button>
                    </div>

                    {/* Volume Booster slider */}
                    <div className="flex items-center gap-3 bg-zinc-950 border border-zinc-800 px-3 py-1.5 rounded-lg">
                      <span className="text-[10px] text-zinc-500 font-mono">AUDIT VOL</span>
                      <input
                        type="range"
                        min="0"
                        max="1.2"
                        step="0.05"
                        value={volume}
                        onChange={handleVolumeChange}
                        className="w-20 accent-emerald-500 bg-zinc-900 h-1 rounded-full cursor-pointer"
                      />
                      <span className="text-[10px] text-emerald-400 font-mono font-bold w-7 text-right">
                        {Math.round(volume * 100)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Analyzer Specs Box */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 font-mono text-xs">
                  <div className="p-2.5 bg-zinc-950/50 rounded border border-zinc-800/50">
                    <span className="text-zinc-500 text-[9px] block">PEAK LEVEL</span>
                    <span className="text-rose-400 font-bold block text-sm mt-0.5">
                      {selectedFile.peakDb !== undefined ? `${selectedFile.peakDb} dBFS` : 'CALCULATING...'}
                    </span>
                  </div>
                  <div className="p-2.5 bg-zinc-950/50 rounded border border-zinc-800/50">
                    <span className="text-zinc-500 text-[9px] block">RMS AMPLITUDE</span>
                    <span className="text-amber-500 font-bold block text-sm mt-0.5">
                      {selectedFile.rmsDb !== undefined ? `${selectedFile.rmsDb} dBFS` : 'CALCULATING...'}
                    </span>
                  </div>
                  <div className="p-2.5 bg-zinc-950/50 rounded border border-zinc-800/50">
                    <span className="text-zinc-500 text-[9px] block">SAMPLING</span>
                    <span className="text-zinc-300 block text-sm mt-0.5">
                      {selectedFile.sampleRate / 1000} kHz
                    </span>
                  </div>
                  <div className="p-2.5 bg-zinc-950/50 rounded border border-zinc-800/50">
                    <span className="text-zinc-500 text-[9px] block">CHANNEL MAP</span>
                    <span className="text-zinc-300 block text-sm mt-0.5">
                      {selectedFile.channels === 1 ? '1 - Mono' : selectedFile.channels === 2 ? '2 - Stereo' : `${selectedFile.channels} Channels`}
                    </span>
                  </div>
                </div>

              </div>

              {/* Right: Metadata Tag Editor form */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col justify-between shadow-md">
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-white font-medium pb-2 border-b border-zinc-800/40">
                    <Music4 className="h-4.5 w-4.5 text-emerald-400" />
                    <span>Metadata Tags</span>
                  </div>

                  {/* Form fields */}
                  <div className="space-y-3 text-xs">
                    
                    {/* Track Title */}
                    <div className="space-y-1">
                      <label className="text-zinc-400 font-mono text-[10px]">TRACK TITLE</label>
                      <input
                        type="text"
                        value={tags.title}
                        onChange={(e) => handleInputChange('title', e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                        placeholder="Title of track"
                      />
                    </div>

                    {/* Artist */}
                    <div className="space-y-1">
                      <label className="text-zinc-400 font-mono text-[10px]">ARTIST NAME</label>
                      <input
                        type="text"
                        value={tags.artist}
                        onChange={(e) => handleInputChange('artist', e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                        placeholder="Artist or Composer"
                      />
                    </div>

                    {/* Album */}
                    <div className="space-y-1">
                      <label className="text-zinc-400 font-mono text-[10px]">ALBUM NAME</label>
                      <input
                        type="text"
                        value={tags.album}
                        onChange={(e) => handleInputChange('album', e.target.value)}
                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                        placeholder="Album/Source folder"
                      />
                    </div>

                    {/* Row: Year & Genre */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-zinc-400 font-mono text-[10px]">RELEASE YEAR</label>
                        <input
                          type="text"
                          value={tags.year}
                          onChange={(e) => handleInputChange('year', e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                          placeholder="2026"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-zinc-400 font-mono text-[10px]">GENRE</label>
                        <input
                          type="text"
                          value={tags.genre}
                          onChange={(e) => handleInputChange('genre', e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                          placeholder="Electronic / Podcast"
                        />
                      </div>
                    </div>

                    {/* Track # & Comment */}
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-1 space-y-1">
                        <label className="text-zinc-400 font-mono text-[10px]">TRACK #</label>
                        <input
                          type="text"
                          value={tags.track}
                          onChange={(e) => handleInputChange('track', e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                          placeholder="01"
                        />
                      </div>
                      <div className="col-span-2 space-y-1">
                        <label className="text-zinc-400 font-mono text-[10px]">COMMENT</label>
                        <input
                          type="text"
                          value={tags.comment}
                          onChange={(e) => handleInputChange('comment', e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1.5 text-zinc-300 font-mono focus:border-emerald-500 focus:outline-none"
                          placeholder="Rendered via X-Conv"
                        />
                      </div>
                    </div>

                  </div>
                </div>

                <div className="pt-4 border-t border-zinc-800/40 mt-4">
                  <button
                    onClick={handleSaveTags}
                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-semibold rounded flex items-center justify-center gap-2 border border-emerald-500 transition-all hover:shadow-lg hover:shadow-emerald-950/20 cursor-pointer"
                  >
                    <Save className="h-4 w-4" />
                    <span>WRITE META TAGS</span>
                  </button>
                </div>
              </div>

            </div>
          ) : (
            <div className="p-8 text-center bg-zinc-900 border border-zinc-800/80 rounded-xl max-w-lg mx-auto flex flex-col items-center gap-4">
              <div className="h-12 w-12 rounded-full bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center text-zinc-400">
                <FileAudio className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-white">No Audio Track Selected</h3>
                <p className="text-xs text-zinc-500 max-w-sm mx-auto leading-relaxed">
                  Choose a loaded track in the Batch Converter dashboard, then select "Waveform & Tags" to inspect its sample curves, listen to playback audits, and edit metadata headers.
                </p>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
