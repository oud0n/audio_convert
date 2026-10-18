import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderFileName, normalizePattern, tagsFromMetadata, editedTags, isLosslessSource, DEFAULT_RENAME_PATTERN,
  safeFileName, insertToken,
} from '../renderer/utils/fileNamePattern.ts';

const full = { title: 'Song', artist: 'A', album: 'Al', albumArtist: 'AA', disc: '1', track: '3', year: '1999', genre: '', comment: '' };

test('default pattern gives disc-track title names', () => {
  assert.equal(renderFileName(DEFAULT_RENAME_PATTERN, full, '/x/source.flac'), '01-03 Song');
});

test('falls back through alternatives and finally to the source name', () => {
  const p = '%disc2%-%track2% %title%|%track2% %title%|%filename%';
  assert.equal(renderFileName(p, { ...full, disc: '' }, 'a.flac'), '03 Song');
  assert.equal(renderFileName(p, { title: '', track: '' }, 'C:\\music\\Orig Name.wav'), 'Orig Name');
  assert.equal(renderFileName('%title%', {}, 'only.mp3'), 'only', 'no alternative works -> file name');
});

test('handles n/total numbers and totals', () => {
  const tags = { track: '7/12', disc: '2/3', title: 'T' };
  assert.equal(renderFileName('%disc%.%track2% of %totaltracks2% (%totaldiscs%)', tags, 'f'), '2.07 of 12 (3)');
  assert.equal(renderFileName('%track% %title%', { track: 'A1', title: 'T' }, 'f.wav'), 'f', 'non-numeric track is missing');
});

test('legacy {token} patterns still work', () => {
  assert.equal(normalizePattern('{disc} - {track} - {title}'), '%disc% - %track2% - %title%');
  assert.equal(renderFileName('{disc} - {track} - {title}', full, 'x.wav'), '1 - 03 - Song');
  assert.equal(renderFileName('{disc} - {track} - {title}', {}, 'x.wav'), 'x', 'no invented "Untitled" names');
});

test('tag values cannot create folders; unknown tokens fail the alternative', () => {
  assert.equal(renderFileName('%artist% - %title%', { artist: 'AC/DC', title: 'T' }, 'f'), 'AC_DC - T');
  assert.equal(renderFileName('%nope% %title%|%title%', full, 'f'), 'Song');
});

test('metadata copy and edit detection', () => {
  const src = tagsFromMetadata({ title: 'T', track: 5, junk: 'x' });
  assert.equal(src.title, 'T');
  assert.equal(src.track, '5');
  assert.equal(src.artist, '');
  assert.deepEqual(editedTags({ ...src, artist: 'New', title: '' }, src), { artist: 'New', title: '' });
  assert.deepEqual(editedTags(src, src), {});
});

test('lossless source detection prefers the backend codec', () => {
  assert.equal(isLosslessSource(true, 'a.m4a'), true);
  assert.equal(isLosslessSource(false, 'a.flac'), false);
  assert.equal(isLosslessSource(undefined, 'a.APE'), true);
  assert.equal(isLosslessSource(undefined, 'a.m4a'), false);
});

test('names are made safe the same way as the converter', () => {
  assert.equal(renderFileName('%artist%: %title%?', { artist: 'A', title: 'B' }, 'f'), 'A_ B_');
  assert.equal(safeFileName('name. . '), 'name');
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(safeFileName(''), 'audio');
  assert.equal(Array.from(safeFileName('あ'.repeat(300))).length, 180);
});

test('inserting a token keeps the fallbacks', () => {
  assert.equal(insertToken('%disc2%-%track2%|%filename%', '%title%'), '%disc2%-%track2% %title%|%filename%');
  assert.equal(insertToken('', '%title%'), '%title%');
});

test('truncation happens before the empty and reserved-name checks', () => {
  assert.equal(safeFileName(' '.repeat(180) + 'a'), 'audio');
  assert.equal(safeFileName('CON' + ' '.repeat(177) + 'a'), '_CON');
  assert.equal(safeFileName('COM1 .txt'), '_COM1 .txt');
});

test('round 4: totals from edits, extensionless names, idempotent safety', () => {
  assert.equal(renderFileName('%track2%-%totaltracks2%', { track: '4/10', totalTracks: '12' }, 'f'), '04-10');
  assert.equal(isLosslessSource(undefined, 'wav'), false);
  const name = 'CON.' + ' '.repeat(175) + 'a';
  assert.equal(safeFileName(safeFileName(name)), safeFileName(name));
});

test('separators written in the pattern make subfolders', () => {
  const tags = { artist: 'AC/DC', album: 'Back\\In Black', title: 'Hells: Bells', track: '1' };
  assert.equal(renderFileName('%artist%\\%album%\\%track2% %title%', tags, 'f'), 'AC_DC/Back_In Black/01 Hells_ Bells');
  assert.equal(renderFileName('%title%/sub', { title: 'B' }, 'f'), 'B/sub');
  assert.equal(renderFileName(' a / .. / b ', {}, 'f'), 'a/audio/b', 'dot folders are not kept');
  assert.equal(renderFileName('%album%/%title%|%filename%', { title: 'T' }, 'src.flac'), 'src', 'missing tag falls back');
  assert.equal(renderFileName('/', {}, 'src.flac'), 'src');
});
