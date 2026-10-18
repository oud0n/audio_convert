/**
 * File name patterns and tag helpers.
 *
 * Pattern syntax:
 *  - `%token%` is replaced by a tag value, e.g. `%disc2%-%track2% %title%`.
 *  - `|` separates alternatives. The first alternative whose tokens all have a value
 *    is used; if none works, the source file name is used.
 *  - The older `{token}` syntax still works (`{track}` is zero-padded to 2 digits).
 *
 * Kept free of TypeScript-only runtime syntax so Node can run it directly in tests.
 */

export interface PatternTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  disc?: string;
  year?: string;
  genre?: string;
  track?: string;
  comment?: string;
  totalTracks?: string;
  totalDiscs?: string;
}

export const TAG_KEYS = ['title', 'artist', 'album', 'albumArtist', 'disc', 'year', 'genre', 'track', 'comment'] as const;
type TagKey = (typeof TAG_KEYS)[number];

export const DEFAULT_RENAME_PATTERN = '%disc2%-%track2% %title%|%filename%';

const LEGACY_TOKENS: Record<string, string> = {
  '{artist}': '%artist%',
  '{title}': '%title%',
  '{album}': '%album%',
  '{albumArtist}': '%albumartist%',
  '{disc}': '%disc%',
  '{track}': '%track2%',
  '{year}': '%year%',
  '{genre}': '%genre%',
};

/** Splits "3/12" into number and total. */
function splitNumber(value: string | undefined): { n?: number; total?: number } {
  const text = (value ?? '').trim();
  const m = /^(\d+)\s*(?:\/\s*(\d+))?$/.exec(text);
  if (!m) return {};
  return { n: Number(m[1]), total: m[2] ? Number(m[2]) : undefined };
}

function pad2(n: number | undefined): string | undefined {
  return n === undefined ? undefined : String(n).padStart(2, '0');
}

function stem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function text(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  return v ? v : undefined;
}

function resolveToken(token: string, tags: PatternTags, sourceFileName: string): string | undefined {
  const track = splitNumber(tags.track);
  const disc = splitNumber(tags.disc);
  // A total typed into the track/disc field ("4/10") wins over the stored total.
  const totalTracks = track.total ?? splitNumber(tags.totalTracks).n;
  const totalDiscs = disc.total ?? splitNumber(tags.totalDiscs).n;
  switch (token.toLowerCase()) {
    case 'title': return text(tags.title);
    case 'artist': return text(tags.artist);
    case 'album': return text(tags.album);
    case 'albumartist': return text(tags.albumArtist);
    case 'year': return text(tags.year);
    case 'genre': return text(tags.genre);
    case 'comment': return text(tags.comment);
    case 'filename': return text(stem(sourceFileName));
    case 'track': return track.n === undefined ? undefined : String(track.n);
    case 'track2': return pad2(track.n);
    case 'totaltracks': return totalTracks === undefined ? undefined : String(totalTracks);
    case 'totaltracks2': return pad2(totalTracks);
    case 'disc': case 'disk': return disc.n === undefined ? undefined : String(disc.n);
    case 'disc2': case 'disk2': return pad2(disc.n);
    case 'totaldiscs': return totalDiscs === undefined ? undefined : String(totalDiscs);
    case 'totaldiscs2': return pad2(totalDiscs);
    default: return undefined;
  }
}

/** Replaces `%token%`s in `text` with tag values; unknown or empty tokens become "". */
export function expandTokens(text: string, tags: PatternTags, sourceFileName = ''): string {
  return text.replace(/%([a-z0-9]+)%/gi, (_, token: string) => resolveToken(token, tags, sourceFileName) ?? '');
}

/** Converts the old `{token}` syntax to `%token%`. */
export function normalizePattern(pattern: string): string {
  let out = pattern;
  for (const [legacy, modern] of Object.entries(LEGACY_TOKENS)) out = out.split(legacy).join(modern);
  return out;
}

/**
 * Makes a name safe as a single file name on Windows, macOS and Linux. Mirrors the
 * converter's `safe_file_name` so the preview shows the name that will be written.
 */
export function safeFileName(name: string): string {
  let clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  const chars = Array.from(clean);
  if (chars.length > 180) clean = chars.slice(0, 180).join('');
  clean = clean.replace(/[ .]+$/g, '');
  if (!clean) clean = 'audio';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9]) *(\.|$)/i.test(clean)) {
    clean = `_${clean}`;
    // Stay within the limit so a second pass gives the same name.
    const again = Array.from(clean);
    if (again.length > 180) clean = again.slice(0, 180).join('').replace(/[ .]+$/g, '');
  }
  return clean;
}

/**
 * Builds the output file name stem (no extension) from a pattern. A `\\` or `/` written
 * in the pattern makes a subfolder (xrecode style), e.g. `%artist%\\%album%\\%title%`;
 * separators inside tag values never do. The result uses `/` between folders.
 */
export function renderFileName(pattern: string, tags: PatternTags, sourceFileName: string): string {
  const alternatives = normalizePattern(pattern || '').split('|');
  for (const alt of alternatives) {
    let ok = true;
    const result = alt.replace(/%([a-z0-9]+)%/gi, (_, token: string) => {
      const value = resolveToken(token, tags, sourceFileName);
      if (value === undefined) { ok = false; return ''; }
      return value.replace(/[\\/]/g, '_');
    });
    const parts = result.split(/[\\/]/).map((p) => p.trim()).filter(Boolean);
    if (ok && parts.length) return parts.map(safeFileName).join('/');
  }
  return safeFileName(stem(sourceFileName));
}

/** Adds a token to the first alternative of a pattern (keeps the `|...` fallbacks). */
export function insertToken(pattern: string, token: string): string {
  const parts = (pattern || '').split('|');
  const first = parts[0].trim();
  parts[0] = first ? `${first} ${token}` : token;
  return parts.join('|');
}

/** Sample tags for pattern previews. */
export const PREVIEW_TAGS: PatternTags = {
  title: 'Track_01', artist: 'Beatsmith', album: 'Demo Album', albumArtist: 'Beatsmith',
  disc: '1', track: '1', year: '2026', genre: 'Electronic',
};

/** Tags with every field present and empty. */
export function emptyTags(): Required<PatternTags> {
  return { title: '', artist: '', album: '', albumArtist: '', disc: '', year: '', genre: '', track: '', comment: '', totalTracks: '', totalDiscs: '' };
}

/** Copies tag strings from a metadata result; missing fields become empty strings. */
export function tagsFromMetadata(meta: Partial<Record<keyof PatternTags, unknown>> | undefined | null): Required<PatternTags> {
  const out = emptyTags();
  if (!meta) return out;
  for (const key of Object.keys(out) as (keyof PatternTags)[]) {
    const v = meta[key];
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = String(v);
  }
  return out;
}

/**
 * Tags the user changed compared with the source. Only these are sent to the
 * converter; the rest are copied from the source file unchanged. "" clears a tag.
 */
export function editedTags(current: PatternTags, source: PatternTags | undefined): Partial<Record<TagKey, string>> {
  const out: Partial<Record<TagKey, string>> = {};
  for (const key of TAG_KEYS) {
    const now = current[key] ?? '';
    const before = source?.[key] ?? '';
    if (now !== before) out[key] = now;
  }
  return out;
}

/** xrecode's default file name for "split by channels" (prog.settings.pattern.fpc). */
export const DEFAULT_CHANNEL_PATTERN = '0%nchannel%_%chname%_%filename%';

/** FFmpeg channel names and the names used for %chname% (xrecode cn_*; side = RL / RR). */
export const CHANNEL_KEYS = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'];
export const DEFAULT_CHANNEL_NAMES: Record<string, string> = {
  FL: 'FL', FR: 'FR', FC: 'C', LFE: 'LFE', BL: 'BL', BR: 'BR', SL: 'RL', SR: 'RR',
};

/** The output name of one channel: %nchannel% (1-based) and %chname% filled in first. */
export function renderChannelFileName(pattern: string, index: number, channel: string, names: Record<string, string> | undefined, tags: PatternTags, sourceFileName: string): string {
  const name = (names ?? DEFAULT_CHANNEL_NAMES)[channel] ?? DEFAULT_CHANNEL_NAMES[channel] ?? channel;
  const filled = (pattern || DEFAULT_CHANNEL_PATTERN)
    .replace(/%nchannel%/gi, String(index + 1))
    .replace(/%chname%/gi, name.replace(/[%|\\/]/g, '_'));
  return renderFileName(filled, tags, sourceFileName);
}

export const LOSSLESS_OUTPUT_FORMATS = ['WAV', 'AIFF', 'FLAC', 'ALAC', 'WAVPACK', 'DSF'];

const LOSSLESS_EXTENSIONS = ['wav', 'w64', 'rf64', 'bwf', 'aif', 'aiff', 'aifc', 'flac', 'fla', 'ape', 'wv', 'tta', 'tak'];

/** Lossless source check: prefer the codec reported by the backend, else the extension. */
export function isLosslessSource(sourceLossless: boolean | undefined, fileName: string): boolean {
  if (typeof sourceLossless === 'boolean') return sourceLossless;
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return false;
  return LOSSLESS_EXTENSIONS.includes(fileName.slice(dot + 1).toLowerCase());
}

/** Extensions accepted when adding files or scanning folders (decoded by FFmpeg). */
export const SUPPORTED_INPUT_EXTENSIONS = [
  'wav', 'w64', 'rf64', 'bwf', 'aif', 'aiff', 'aifc', 'caf', 'flac', 'fla', 'm4a', 'm4b', 'mp4', 'alac', 'aac',
  'mp3', 'mp2', 'mpa', 'ogg', 'oga', 'opus', 'spx', 'wma', 'asf', 'wv', 'ape', 'tta', 'tak', 'mpc', 'ac3', 'eac3',
  'dts', 'mka', 'mkv', 'webm', 'mov', 'dsf', 'dff', 'amr', 'au', 'snd', 'voc', 'cue',
];

/** Formats that can hold an embedded CUE sheet or chapters (checked when added). */
export const IMAGE_CAPABLE_EXTENSIONS = ['flac', 'fla', 'wv', 'ape', 'tta', 'tak', 'm4a', 'm4b', 'mp4', 'mka', 'mkv', 'ogg', 'opus'];

/**
 * Tag replacement rules in xrecode's tagsreplace.txt format:
 *
 *   [*]            every tag          [Title], [Artist], [Album], [Album Artist], [Year],
 *   [Comments!]    `!` = ignore case  [Date], [Genre], [Track], [Disc], [Comments]
 *   from=to        replace every `from` with `to`
 *   <NULL>=to      an empty tag gets `to`;  from=<NULL> clears what matched
 *   <ANY>=to       any value (empty too) becomes `to`
 *   %CHANGECASE%=UpperCase | LowerCase | CapitalizEeachWord
 *
 * `to` may use %y% %m% %d% (today) and the file name pattern tokens (%track2%,
 * %totaltracks2%, ...). Lines starting with # are comments. Sections xrecode knows but
 * this app has no tag for (Composer, Lyrics, ...) are ignored.
 */
type Key = 'title' | 'artist' | 'album' | 'albumArtist' | 'year' | 'genre' | 'track' | 'disc' | 'comment';
const ALL_KEYS: Key[] = ['title', 'artist', 'album', 'albumArtist', 'year', 'genre', 'track', 'disc', 'comment'];

const SECTION_KEYS: Record<string, Key[]> = {
  '*': ALL_KEYS,
  title: ['title'],
  artist: ['artist'],
  album: ['album'],
  'album artist': ['albumArtist'],
  year: ['year'],
  date: ['year'],
  genre: ['genre'],
  track: ['track'],
  disc: ['disc'],
  comments: ['comment'],
  comment: ['comment'],
};

interface Rule { from: string; to: string }
interface Section { keys: Key[]; ignoreCase: boolean; rules: Rule[] }

export function parseTagRules(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const raw of (text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      let name = head[1].trim();
      const ignoreCase = name.endsWith('!');
      if (ignoreCase) name = name.slice(0, -1).trim();
      const keys = SECTION_KEYS[name.toLowerCase()];
      current = keys ? { keys, ignoreCase, rules: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    const eq = line.indexOf('=');
    if (!current || eq <= 0) continue;
    current.rules.push({ from: line.slice(0, eq), to: line.slice(eq + 1) });
  }
  return sections;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function changeCase(value: string, mode: string): string {
  switch (mode.toLowerCase()) {
    case 'uppercase': return value.toUpperCase();
    case 'lowercase': return value.toLowerCase();
    case 'capitalizeeachword':
      return value.toLowerCase().replace(/(^|[\s\-_/(\[{"'.])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
    default: return value;
  }
}

/** Applies the rules in order; returns a new tag object (other fields are kept). */
export function applyTagRules<T extends PatternTags>(tags: T, text: string, now: Date = new Date()): T {
  const out: T = { ...tags };
  const sections = parseTagRules(text);
  if (!sections.length) return out;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = (s: string) => s.replace(/%y%/gi, String(now.getFullYear())).replace(/%m%/gi, pad(now.getMonth() + 1)).replace(/%d%/gi, pad(now.getDate()));
  for (const section of sections) {
    for (const rule of section.rules) {
      const target = rule.to === '<NULL>' ? '' : rule.to;
      for (const key of section.keys) {
        const value = (out[key] ?? '') as string;
        let next = value;
        if (rule.from === '%CHANGECASE%') {
          next = changeCase(value, rule.to);
        } else if (rule.from === '<NULL>') {
          if (!value.trim()) next = expandTokens(today(target), out);
        } else if (rule.from === '<ANY>') {
          next = expandTokens(today(target), out);
        } else if (rule.from && value) {
          next = value.replace(new RegExp(escapeRegExp(rule.from), section.ignoreCase ? 'gi' : 'g'), () => expandTokens(today(target), out));
        }
        (out as any)[key] = next;
      }
    }
  }
  return out;
}

const STANDARD_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];
const LOSSY_RATES: Record<string, number[]> = {
  MP3: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000],
  OPUS: [48000],
  AC3: [32000, 44100, 48000],
  WMA: [8000, 11025, 16000, 22050, 32000, 44100, 48000],
  M4A: [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000],
  OGG: [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000],
};

/** Highest allowed rate <= wanted, preferring one that divides it (the converter's rule). */
function pickFrom(rates: number[], wanted: number): number {
  if (rates.includes(wanted)) return wanted;
  const below = rates.filter(r => r <= wanted);
  const even = below.filter(r => wanted % r === 0);
  if (even.length) return Math.max(...even);
  return below.length ? Math.max(...below) : rates[0];
}

/**
 * The sample rate a file will be written at, as the converter decides it: the source's
 * rate ("same as source") or the chosen one, under the rate limit, then a rate the
 * lossy encoder accepts.
 */
export function outputSampleRate(sourceRate: number, s: { sameAsSource?: boolean; sampleRate?: number; maxSampleRate?: number; bitrateMode?: string }, format: string): number {
  let rate = s.sameAsSource ? sourceRate : (s.sampleRate || sourceRate);
  const max = s.maxSampleRate || 0;
  if (max && rate > max) rate = pickFrom([...STANDARD_RATES.filter(r => r <= max), max], rate);
  const lossy = LOSSY_RATES[(format || '').toUpperCase()];
  if (lossy) rate = pickFrom(lossy, rate);
  // VBR AAC uses Apple's encoder on macOS, which stops at 48 kHz.
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
  if (mac && (format || '').toUpperCase() === 'M4A' && s.bitrateMode === 'vbr') rate = pickFrom(LOSSY_RATES.MP3, rate);
  return rate;
}
