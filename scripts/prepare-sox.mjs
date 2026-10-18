// Copies the SoX (sox-dsd) executable next to the Tauri app as a sidecar
// (src-tauri/binaries/audio-convert-sox-<target-triple>[.exe]) with its license text.
// It converts PCM to DSD (DSF) with its sigma-delta modulator.
//
// Source: $SOX_BUNDLE_SOURCE if set, else build/sox/out/bin/sox (the default output of
// scripts/build-sox.sh). Target: $TAURI_TARGET_TRIPLE if set, else the host.
//
//   node scripts/prepare-sox.mjs            local builds: warns about problems
//   node scripts/prepare-sox.mjs --release  release builds: problems are errors
//
// Checks: the program runs, writes DSF and has the `sdm` effect.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');

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
    console.error(`prepare-sox: ${message}`);
    process.exit(1);
  }
  console.warn(`prepare-sox: warning: ${message}`);
}

function main() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const source = process.env.SOX_BUNDLE_SOURCE || path.join(root, 'build', 'sox', 'out', 'bin', `sox${exe}`);
  if (!fs.existsSync(source)) {
    problem(`no SoX executable found at ${source} (run scripts/build-sox.sh or set SOX_BUNDLE_SOURCE); PCM to DSD conversion and app builds need it`);
    return;
  }
  const triple = process.env.TAURI_TARGET_TRIPLE || hostTriple();
  if (!triple) {
    problem(`unsupported platform ${process.platform}/${process.arch}`);
    return;
  }

  let help = '';
  let effect = '';
  try {
    help = execFileSync(source, ['-h'], { encoding: 'utf8' });
    effect = execFileSync(source, ['--help-effect', 'sdm'], { encoding: 'utf8' });
  } catch (error) {
    // `sox -h` exits 0, but some builds print help and exit 1: use what was printed.
    help = help || String(error.stdout || '');
    effect = effect || String(error.stdout || '');
    if (!help) {
      problem(`cannot run ${source}: ${error.message}`);
      return;
    }
  }
  if (!/AUDIO FILE FORMATS:.*\bdsf\b/.test(help)) problem(`${source} cannot write DSF (not a sox-dsd build)`);
  if (!/sdm \[-f filter\]/.test(effect)) problem(`${source} lacks the sdm effect (not a sox-dsd build)`);

  const dir = path.join(root, 'src-tauri', 'binaries');
  fs.mkdirSync(dir, { recursive: true });
  const targetExe = triple.includes('windows') ? '.exe' : '';
  const target = path.join(dir, `audio-convert-sox-${triple}${targetExe}`);
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);

  const license = process.env.SOX_BUNDLE_LICENSE || path.join(path.dirname(path.dirname(source)), 'SOX-LICENSE.txt');
  const licenseTarget = path.join(dir, 'sox-LICENSE.txt');
  if (fs.existsSync(license)) {
    fs.copyFileSync(license, licenseTarget);
  } else {
    problem(`no license file found for the bundled SoX at ${license} (set SOX_BUNDLE_LICENSE)`);
    fs.writeFileSync(licenseTarget, 'Bundled SoX (sox-dsd fork): https://github.com/mansr/sox\nGPL v2+ (program) / LGPL v2.1+ (library).\n');
  }
  console.log(`prepare-sox: ${path.relative(root, target)} <- ${source}`);
}

main();
