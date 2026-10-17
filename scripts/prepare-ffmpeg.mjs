// Copies an FFmpeg executable next to the Tauri app as a sidecar
// (src-tauri/binaries/audio-convert-ffmpeg-<target-triple>[.exe]) and its license text.
// The app-specific name keeps Linux packages from installing a second /usr/bin/ffmpeg.
//
// Source: $FFMPEG_BUNDLE_SOURCE if set, else the ffmpeg-static package.
// Target: $TAURI_TARGET_TRIPLE if set, else the host.
//
//   node scripts/prepare-ffmpeg.mjs            local builds: warns about problems
//   node scripts/prepare-ffmpeg.mjs --release  release builds: problems are errors
//
// Release checks: the encoders the app writes must exist, and the build must not
// use --enable-nonfree (such builds may not be redistributed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');

const REQUIRED_ENCODERS = ['flac', 'alac', 'wavpack', 'pcm_s24le', 'pcm_f32le', 'libmp3lame', 'aac', 'libvorbis', 'libopus', 'ac3', 'wmav2'];

function hostTriple() {
  const { platform, arch } = process;
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!cpu) return null;
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`;
  if (platform === 'linux') return `${cpu}-unknown-linux-gnu`;
  return null;
}

function problem(message) {
  if (release) {
    console.error(`prepare-ffmpeg: ${message}`);
    process.exit(1);
  }
  console.warn(`prepare-ffmpeg: warning: ${message}`);
}

function main() {
  let source = process.env.FFMPEG_BUNDLE_SOURCE;
  if (!source) {
    try { source = require('ffmpeg-static'); } catch { source = null; }
  }
  if (!source || !fs.existsSync(source)) {
    problem('no FFmpeg executable found (install ffmpeg-static or set FFMPEG_BUNDLE_SOURCE)');
    return;
  }
  const triple = process.env.TAURI_TARGET_TRIPLE || hostTriple();
  if (!triple) {
    problem(`unsupported platform ${process.platform}/${process.arch}`);
    return;
  }

  let version = '';
  let encoders = '';
  try {
    version = execFileSync(source, ['-hide_banner', '-version'], { encoding: 'utf8' });
    encoders = execFileSync(source, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  } catch (error) {
    problem(`cannot run ${source}: ${error.message}`);
    return;
  }
  const missing = REQUIRED_ENCODERS.filter(name => !new RegExp(`^\\s*A\\S*\\s+${name}\\s`, 'm').test(encoders));
  if (missing.length) problem(`${source} lacks encoders: ${missing.join(', ')}`);
  if (/--enable-nonfree/.test(version)) {
    problem(`${source} was built with --enable-nonfree and may not be redistributed; set FFMPEG_BUNDLE_SOURCE to a GPL/LGPL build`);
  }

  const dir = path.join(root, 'src-tauri', 'binaries');
  fs.mkdirSync(dir, { recursive: true });
  const exe = triple.includes('windows') ? '.exe' : '';
  const target = path.join(dir, `audio-convert-ffmpeg-${triple}${exe}`);
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);

  // License text shipped with the app (GPL/LGPL require it).
  const licenseCandidates = [
    process.env.FFMPEG_BUNDLE_LICENSE,
    `${source}.LICENSE`,
    path.join(path.dirname(source), 'LICENSE'),
  ].filter(Boolean);
  // Keep every text found: ffmpeg-static's ffmpeg.LICENSE is only FFmpeg's notice,
  // the full GPL text is in its LICENSE file.
  const licenses = [...new Set(licenseCandidates.map(p => path.resolve(p)))].filter(p => fs.existsSync(p));
  const licenseTarget = path.join(dir, 'ffmpeg-LICENSE.txt');
  const firstLine = version.split('\n')[0];
  const configLine = version.split('\n').find(l => l.startsWith('configuration:')) || '';
  // Point at the exact upstream release when the version is a plain release number.
  const upstreamVersion = /^ffmpeg version (\d+(?:\.\d+)+)\b/.exec(firstLine)?.[1];
  const sourceLine = upstreamVersion
    ? `FFmpeg source code for this version: https://ffmpeg.org/releases/ffmpeg-${upstreamVersion}.tar.xz`
    : 'FFmpeg source code: https://ffmpeg.org/download.html';
  const provider = process.env.FFMPEG_BUNDLE_SOURCE
    ? 'Built by this project (see scripts/build-ffmpeg-macos.sh in the application source).'
    : 'Binary from the ffmpeg-static npm package (https://github.com/eugeneware/ffmpeg-static); see its README for the builds and their sources.';
  const header = `Bundled FFmpeg\n${firstLine}\n${configLine}\n${sourceLine}\n${provider}\n\n`;
  if (licenses.length) {
    fs.writeFileSync(licenseTarget, header + licenses.map(p => fs.readFileSync(p, 'utf8')).join('\n\n----\n\n'));
  }
  else {
    problem('no license file found for the bundled FFmpeg (set FFMPEG_BUNDLE_LICENSE)');
    fs.writeFileSync(licenseTarget, header);
  }
  console.log(`prepare-ffmpeg: ${path.relative(root, target)} <- ${source}`);
}

main();
