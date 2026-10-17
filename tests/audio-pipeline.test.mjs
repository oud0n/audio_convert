import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseFile } from 'music-metadata';
import ffmpegStatic from 'ffmpeg-static';
import { safeFileName, convertAudio, pcmFingerprint, runFFmpeg } from '../main/helpers/audio-pipeline.mjs';

const executable = process.env.FFMPEG_PATH || ffmpegStatic;
const settings = { sameAsSource: true, bitDepth: '24', sampleRate: 48000, channels: 2, bitrate: '192', threadPoolSize: 2, saveInSourceFolder: false };

test('cancellation terminates a running FFmpeg and rejects pre-cancelled work', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  let received = false;
  await assert.rejects(runFFmpeg(executable, ['-re', '-f', 'lavfi', '-i', 'sine=duration=60', '-progress', 'pipe:1', '-f', 'null', '-'], () => {
    received = true;
    controller.abort();
  }, controller.signal), { name: 'AbortError' });
  assert.equal(received, true);
  await assert.rejects(runFFmpeg(executable, ['-version'], undefined, controller.signal), { name: 'AbortError' });
});

test('real conversion progress can cancel before publication and cleans temporary output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-cancel-test-'));
  try {
    const input = path.join(dir, 'input.wav'); await fs.writeFile(input, wav24());
    const controller = new AbortController();
    const progress = [];
    await assert.rejects(convertAudio(executable, {
      inputFilePath: input, fileName: 'output.flac', outputFormat: 'FLAC', settings: { ...settings, localSavePath: dir }
    }, { bitsPerSample: 24, duration: 0.1 }, { signal: controller.signal, onProgress: event => {
      progress.push(event);
      if (event.progress > 0) controller.abort();
    } }), /cancelled/);
    assert.ok(progress.some(event => event.progress > 0 && event.progress <= 99));
    assert.deepEqual(await fs.readdir(dir), ['input.wav']);
    assert.deepEqual(await fs.readFile(input), wav24());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('normalization analysis is cancellable and emits measured progress', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-normalize-cancel-'));
  try {
    const input = path.join(dir, 'input.wav'); await fs.writeFile(input, wav24());
    const controller = new AbortController();
    let measured = false;
    await assert.rejects(convertAudio(executable, {
      inputFilePath: input, fileName: 'output.wav', outputFormat: 'WAV',
      settings: { ...settings, sameAsSource: false, normalize: true, normalizationTargetDb: -1, localSavePath: dir }
    }, { bitsPerSample: 24, duration: 0.1 }, { signal: controller.signal, onProgress: event => {
      if (event.phase === 'normalizing' && event.progress > 0) { measured = true; controller.abort(); }
    } }), /cancelled/);
    assert.equal(measured, true);
    assert.deepEqual(await fs.readdir(dir), ['input.wav']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

function wav24(lowBit = 0) {
  const length = 4800;
  const buffer = Buffer.alloc(44 + length * 6);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(48000, 24); buffer.writeUInt32LE(48000 * 6, 28); buffer.writeUInt16LE(6, 32); buffer.writeUInt16LE(24, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(length * 6, 40);
  for (let i = 0; i < length; i++) for (let c = 0; c < 2; c++) buffer.writeIntLE(Math.round(Math.sin(i * 0.1) * 2000000) + lowBit, 44 + i * 6 + c * 3, 3);
  return buffer;
}

test('Unicode output names retain Korean and sanitize Windows restrictions', () => {
  assert.equal(safeFileName('고백.wav'), '고백.wav');
  assert.equal(safeFileName('CON.wav'), '_CON.wav');
  assert.equal(safeFileName('title:track/one?.wav '), 'title_track_one_.wav');
  assert.ok(safeFileName('😀'.repeat(200) + '.flac').length <= 180);
});

test('24-bit preservation, low-bit detection, settings, collisions, failure cleanup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-test-'));
  try {
    const input = path.join(dir, '고백, 꽃.wav');
    const altered = path.join(dir, 'changed.wav');
    await fs.writeFile(input, wav24()); await fs.writeFile(altered, wav24(1));
    const source = { bitsPerSample: 24, isFloat: false, hasArt: false };
    const output = path.join(dir, 'output');
    const request = { inputFilePath: input, settings: { ...settings, localSavePath: output }, fileName: '고백: 꽃.flac', outputFormat: 'FLAC', tags: { title: '고백, 꽃', track: '14' } };
    const result = await convertAudio(executable, request, source);
    assert.equal(result.fileName, '고백_ 꽃.flac');
    const meta = await parseFile(result.path);
    assert.equal(meta.format.bitsPerSample, 24); assert.equal(meta.format.sampleRate, 48000); assert.equal(meta.common.title, '고백, 꽃');
    const original = await pcmFingerprint(executable, input);
    assert.deepEqual(await pcmFingerprint(executable, result.path), original);
    assert.notEqual((await pcmFingerprint(executable, altered)).hash, original.hash);
    const collision = await convertAudio(executable, request, source);
    assert.equal(collision.fileName, '고백_ 꽃_2.flac');
    const wav = await convertAudio(executable, { ...request, fileName: 'preserved.wav', outputFormat: 'WAV' }, source);
    assert.equal((await parseFile(wav.path)).format.bitsPerSample, 24);
    assert.deepEqual(await pcmFingerprint(executable, wav.path), original);
    for (const format of ['ALAC', 'AIFF', 'WAVPACK']) {
      const r = await convertAudio(executable, { ...request, fileName: `preserved.${format}`, outputFormat: format }, source);
      assert.deepEqual(await pcmFingerprint(executable, r.path), original);
    }
    const changed = await convertAudio(executable, { ...request, fileName: 'processed.wav', outputFormat: 'WAV', settings: { ...request.settings, sameAsSource: false, sampleRate: 44100, channels: 1, bitDepth: '16', volumeBoostDb: -6 } }, source);
    const cm = await parseFile(changed.path);
    assert.equal(cm.format.sampleRate, 44100); assert.equal(cm.format.numberOfChannels, 1); assert.equal(cm.format.bitsPerSample, 16);
    let originalVolume = '', changedVolume = '';
    originalVolume = await runFFmpeg(executable, ['-i', input, '-af', 'volumedetect', '-f', 'null', '-']);
    changedVolume = await runFFmpeg(executable, ['-i', changed.path, '-af', 'volumedetect', '-f', 'null', '-']);
    const peak = log => Number(log.match(/max_volume: (-?[\d.]+) dB/)[1]);
    assert.ok(Math.abs(peak(changedVolume) - peak(originalVolume) + 6) < 0.3);
    const normalized = await convertAudio(executable, { ...request, fileName: 'normalized.wav', outputFormat: 'WAV', settings: { ...request.settings, sameAsSource: false, normalize: true, normalizationTargetDb: -1, volumeBoostDb: 0 } }, source);
    const normalizedLog = await runFFmpeg(executable, ['-i', normalized.path, '-af', 'volumedetect', '-f', 'null', '-']);
    assert.ok(Math.abs(peak(normalizedLog) + 1) < 0.2);
    await assert.rejects(convertAudio(executable, { ...request, inputFilePath: path.join(dir, 'missing.wav') }, source));
    assert.ok((await fs.readdir(output)).every(name => !name.startsWith('.audio-convert-')));
    assert.deepEqual(await fs.readFile(input), wav24());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('leading/trailing silence removal and Korean tags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-trim-test-'));
  try {
    const input = path.join(dir, 'silence.wav');
    await runFFmpeg(executable, ['-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,0.2\\,0.7)\\,0.1*sin(2*PI*440*t)\\,0):s=48000:d=1', '-c:a', 'pcm_s24le', input]);
    const result = await convertAudio(executable, { inputFilePath: input, fileName: '고백.wav', outputFormat: 'WAV', tags: { title: '고백', comment: 'test' }, settings: { ...settings, sameAsSource: false, trimSilence: true, trimSilenceThresholdDb: -50, localSavePath: dir } }, { bitsPerSample: 24, isFloat: false, hasArt: false });
    const m = await parseFile(result.path);
    assert.ok(m.format.duration > 0.45 && m.format.duration < 0.6, `duration=${m.format.duration}`);
    assert.equal(m.common.title, '고백');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('supplied DJMAX fixture preserves 24-bit PCM and supported artwork', async t => {
  const directory = path.resolve('for_test/music_djmax_sample/DJMAX RESPECT V - BLACK SQUARE Original Soundtrack(REMASTERED)/DISC 1');
  const entries = await fs.readdir(directory).catch(() => []);
  const name = entries.find(value => value.startsWith('14 ReX') && value.endsWith('.wav'));
  if (!name) { t.skip('Local fixture is not redistributed'); return; }
  const input = path.join(directory, name);
  const sourceMeta = await parseFile(input);
  const original = await pcmFingerprint(executable, input);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-fixture-test-'));
  try {
    for (const format of ['WAV', 'FLAC', 'ALAC']) {
      const result = await convertAudio(executable, { inputFilePath: input, fileName: name, outputFormat: format, settings: { ...settings, localSavePath: dir }, tags: { title: sourceMeta.common.title, track: String(sourceMeta.common.track.no) } }, { bitsPerSample: sourceMeta.format.bitsPerSample, isFloat: false, hasArt: !!sourceMeta.common.picture?.length });
      const m = await parseFile(result.path);
      assert.equal(m.format.bitsPerSample, 24); assert.equal(m.format.sampleRate, 48000);
      assert.deepEqual(await pcmFingerprint(executable, result.path), original);
      assert.equal(m.common.title, '고백, 꽃, 늑대 Part.2');
      assert.equal(m.common.track.no, 14);
      if (format !== 'WAV') assert.equal(m.common.picture.length, 1);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('long Unicode input and output directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-long-test-'));
  try {
    const directory = path.join(root, ...Array(6).fill('한국어 directory with spaces '.repeat(2)));
    await fs.mkdir(directory, { recursive: true });
    const input = path.join(directory, '고백.wav'); await fs.writeFile(input, wav24());
    const result = await convertAudio(executable, { inputFilePath: input, fileName: '한글?.wav', outputFormat: 'WAV', settings: { ...settings, localSavePath: directory } }, { bitsPerSample: 24, isFloat: false, hasArt: false });
    assert.equal(result.fileName, '한글_.wav');
    assert.deepEqual(await pcmFingerprint(executable, result.path), await pcmFingerprint(executable, input));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('floating-point WAV precision and lossy-source PCM defaults', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-float-test-'));
  try {
    for (const bits of [32, 64]) {
      const input = path.join(dir, `float${bits}.wav`);
      await runFFmpeg(executable, ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=0.1', '-c:a', `pcm_f${bits}le`, input]);
      const source = { bitsPerSample: bits, isFloat: true, sampleRate: 48000, channels: 1 };
      const request = { inputFilePath: input, fileName: `copy${bits}.wav`, outputFormat: 'WAV', settings: { ...settings, localSavePath: dir } };
      const output = await convertAudio(executable, request, source);
      assert.deepEqual(await pcmFingerprint(executable, output.path), await pcmFingerprint(executable, input));
      const { waveIsFloat } = await import('../main/helpers/audio-pipeline.mjs');
      assert.equal(await waveIsFloat(output.path), true);
      await assert.rejects(convertAudio(executable, { ...request, outputFormat: 'FLAC' }, source), /cannot preserve/);
    }
    const mp3 = path.join(dir, 'source.mp3');
    await runFFmpeg(executable, ['-f', 'lavfi', '-i', 'sine=sample_rate=44100:duration=0.1', '-c:a', 'libmp3lame', mp3]);
    const output = await convertAudio(executable, { inputFilePath: mp3, fileName: 'decoded.wav', outputFormat: 'WAV', settings: { ...settings, localSavePath: dir } }, { lossless: false, sampleRate: 44100, channels: 1 });
    const m = await parseFile(output.path);
    assert.equal(m.format.bitsPerSample, 24); assert.equal(m.format.sampleRate, 44100);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('FAT/exFAT publication fallback refuses collisions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-copy-test-'));
  const originalLink = fs.link;
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Hard links unsupported'), { code: 'ENOTSUP' }); });
  try {
    const input = path.join(dir, 'input.wav'); await fs.writeFile(input, wav24());
    const request = { inputFilePath: input, fileName: 'copy.wav', outputFormat: 'WAV', settings: { ...settings, localSavePath: dir } };
    const source = { bitsPerSample: 24, isFloat: false };
    const first = await convertAudio(executable, request, source);
    const original = await fs.readFile(first.path);
    const second = await convertAudio(executable, request, source);
    assert.equal(second.fileName, 'copy_2.wav');
    assert.deepEqual(await fs.readFile(first.path), original);
    assert.deepEqual(await pcmFingerprint(executable, second.path), await pcmFingerprint(executable, input));
  } finally { fs.link = originalLink; await fs.rm(dir, { recursive: true, force: true }); }
});

test('EXDEV cross-device link fallback copies file and preserves audio', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-exdev-test-'));
  const originalLink = fs.link;
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Cross-device link'), { code: 'EXDEV' }); });
  try {
    const input = path.join(dir, 'input.wav'); await fs.writeFile(input, wav24());
    const request = { inputFilePath: input, fileName: 'exdev_copy.wav', outputFormat: 'WAV', settings: { ...settings, localSavePath: dir } };
    const source = { bitsPerSample: 24, isFloat: false };
    const result = await convertAudio(executable, request, source);
    assert.equal(result.fileName, 'exdev_copy.wav');
    assert.deepEqual(await pcmFingerprint(executable, result.path), await pcmFingerprint(executable, input));
  } finally { fs.link = originalLink; await fs.rm(dir, { recursive: true, force: true }); }
});

