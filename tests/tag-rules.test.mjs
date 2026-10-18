import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTagRules, parseTagRules } from '../renderer/utils/fileNamePattern.ts';

const RULES = `# comment
[*]
Featuring=Ft.
[Comments]
<NULL>=Created %y%-%m%-%d%
[Artist!]
the band=The Band
[Track]
<ANY>=%track2%/%totaltracks2%
[Composer]
x=y
[Genre]
%CHANGECASE%=CapitalizEeachWord
[Album]
Live=<NULL>
`;

test('xrecode tagsreplace rules', () => {
  const now = new Date(2026, 9, 18);
  const out = applyTagRules({ title: 'A Featuring B', artist: 'THE BAND Featuring C', comment: '', track: '3', totalTracks: '12', genre: 'hard rock', album: 'Live at X' }, RULES, now);
  assert.equal(out.title, 'A Ft. B');
  assert.equal(out.artist, 'The Band Ft. C', 'case-insensitive section');
  assert.equal(out.comment, 'Created 2026-10-18');
  assert.equal(out.track, '03/12');
  assert.equal(out.genre, 'Hard Rock');
  assert.equal(out.album, ' at X');
  assert.equal(parseTagRules(RULES).length, 6, 'unknown sections are ignored');
});

test('case changes and empty rules', () => {
  assert.equal(applyTagRules({ title: 'abc' }, '[*]\n%CHANGECASE%=UpperCase').title, 'ABC');
  assert.equal(applyTagRules({ title: 'Abc' }, '[Title]\n%CHANGECASE%=LowerCase').title, 'abc');
  assert.deepEqual(applyTagRules({ title: 'x' }, ''), { title: 'x' });
  assert.equal(applyTagRules({ title: 'a.b' }, '[Title]\n.=_').title, 'a_b', 'from is literal, not a regex');
});
