# Audio Convert — Free Lossless Audio Converter for macOS, Windows and Linux

[![Latest release](https://img.shields.io/github/v/release/oud0n/audio_convert)](https://github.com/oud0n/audio_convert/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/oud0n/audio_convert/total)](https://github.com/oud0n/audio_convert/releases)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-oud0n-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/oud0n)

**English** | [日本語](README.ja.md)

**Audio Convert** is a free, offline batch audio converter for **FLAC, ALAC, WAV, AIFF, WavPack, MP3, AAC, Ogg Vorbis, Opus and DSD (DSF / DFF)**. It converts music libraries on your own computer with a bundled FFmpeg, **verifies lossless conversions bit for bit**, splits **CUE sheets** into tracks, converts **DSD to PCM and PCM to DSD**, writes **ReplayGain / R128** tags and names files from tags.

Built with Tauri (Rust) and Next.js, it runs natively on Apple Silicon and Intel Macs, Windows and Linux. Its workflow follows xrecode: presets per tab, file names from tags, and sources moved to the trash after a verified conversion.

- 🎧 Lossless and lossy: FLAC to ALAC, WAV to FLAC, FLAC to MP3, APE to FLAC, M4A to FLAC and more
- ✅ Bit-perfect check: SHA-256 of the decoded PCM, so a lossless output is proven identical to the source
- 💿 CUE splitter: `.cue` files, embedded CUE sheets and chapters become separate tracks
- 🎛 DSD converter: DSF / DFF to PCM, DoP, and PCM to DSD64 / DSD128 / DSD256
- 🔒 Private: no upload, no account, no telemetry; everything runs locally

## Download

Get the latest version from **[Releases](https://github.com/oud0n/audio_convert/releases/latest)**.

| OS | Files |
| --- | --- |
| macOS (Apple Silicon / Intel) | `.dmg` |
| Windows | `.exe` (installer) / `.msi` |
| Linux | `.AppImage` / `.deb` / `.rpm` |

## Supported formats

| | Formats |
| --- | --- |
| **Output** | FLAC, ALAC (M4A), WAV, AIFF, WavPack, MP3, AAC (M4A), Ogg Vorbis, Opus, AC3, WMA, DSF |
| **Input** | Everything above, plus APE (Monkey's Audio), TAK, TTA, W64, DFF and the other formats FFmpeg decodes |
| **DSD** | DSF / DFF → PCM, bit-exact DSF copy, DoP in FLAC / WAV / AIFF, PCM → DSF (DSD64 / 128 / 256) |
| **Splitting** | CUE sheets (external and embedded), chapters, fixed time, silence |

## Features

- **Settings per tab**: each tab keeps its own format, output folder, file name pattern and more, saved on exit and restored on the next start.
- **Encoder options**:
  - "Same as Source" keeps the source's sample rate, channels and bit depth. A maximum sample rate (e.g. 192 kHz → 96 kHz) can be set. Resampling uses soxr at its highest quality.
  - FLAC supports compression levels 0–8 and uncompressed (VERBATIM).
  - MP3 / AAC / Vorbis support CBR and VBR (V0–V9; AAC on macOS uses Apple's TVBR).
- **DSD**:
  - DSF / DFF convert to PCM, copy bit for bit to DSF, or go out as DoP (FLAC / WAV / AIFF).
  - PCM converts to DSD (DSF, DSD64 / 128 / 256) with sox-dsd. The default filter is `sdm-8` (sdm-4–8 and clans-4–8 can be chosen).
- **Quality check**:
  - Lossless conversions are checked bit for bit (SHA-256 of the decoded PCM).
  - Lossy conversions are compared by S/N ratio, waveform correlation and length, in 32-bit float at the source's channel count.
  - Sources of outputs that fail are never moved to the trash.
- **Queue**: a batch that fully succeeds leaves the queue. After any failure, the queue and the sources stay.
- **Tags and file names**:
  - View and edit tags, and write ReplayGain 2.0 / R128 tags (measured with EBU R128).
  - Build file names from patterns (`%disc2%-%track2% %title%|%filename%`; `\` or `/` makes folders).
  - Tag replace rules in tagsreplace.txt format.
- **Cover art**: embedded covers are kept. Covers like `cover.jpg` from the source folder can be embedded, shrunk or converted, and saved as `folder.jpg`.
- **Action modes**: Encode (the default), Merge (optionally with a CUE sheet), Split by channels, Encode multi-channel, Extract (no re-encoding), Copy.
- **Processing**: normalization, volume, silence trimming, tempo change (keeps pitch), fades, added silence.
- **Interface**: English / Japanese, light / dark / system theme, waveform view and player.

## FAQ

**Is it free?**
Yes, for personal and other non-commercial use (see [License](#license)). There are no ads, no account and no time limit.

**Does it upload my files?**
No. FFmpeg and SoX ship inside the app, and every conversion runs on your computer.

**Is FLAC to ALAC (or WAV to FLAC) really lossless?**
Yes, and the app proves it: after converting, it decodes both files and compares the SHA-256 of the PCM. A mismatch is reported as a failure, and the source is kept.

**Can it split a single-file album with a CUE sheet?**
Yes. Add the `.cue` file or the audio file with an embedded CUE sheet, and each track becomes its own file with tags from the sheet.

**Can it convert DSD (DSF / DFF) for players that don't support DSD?**
Yes. Convert DSD to PCM (FLAC, WAV, ALAC, ...) at the sample rate you choose, or output DoP for DACs that support it.

**Does it run on Apple Silicon?**
Yes. The macOS build is native for both Apple Silicon and Intel.

## Build from source

```bash
scripts/build-sox.sh # build SoX (once; app builds and tests need it)
npm install          # dependencies (postinstall puts FFmpeg and SoX in src-tauri/binaries/)
npm run dev          # start in development mode
npm run build        # build the installers (src-tauri/target/release/bundle/)
npm run typecheck    # type check
npm test             # JavaScript tests
```

Run the Rust tests with `cargo test --lib` in `src-tauri`. Tests and development builds use the FFmpeg prepared for bundling (`src-tauri/binaries/`); set `FFMPEG_PATH` to use another one. By default postinstall puts ffmpeg-static (GPL) there; releases use the LGPL build below.

### Bundled FFmpeg

`scripts/build-ffmpeg.sh` builds an LGPL FFmpeg from the official, checksum-pinned sources (LAME, Opus, Vorbis and soxr linked statically). The GitHub Actions workflow `ffmpeg.yml` builds it on macOS (Apple Silicon and Intel), Linux and Windows (MSYS2) for the test and release workflows.

- To build it locally, run `scripts/build-ffmpeg.sh <work-dir>`, then pass the `FFMPEG_BUNDLE_SOURCE` / `FFMPEG_BUNDLE_LICENSE` values from its last two lines to `node scripts/prepare-ffmpeg.mjs`.
- The release check (`--release`) refuses an FFmpeg that lacks a required encoder or was built with `--enable-nonfree` (not redistributable).

### Bundled SoX (PCM to DSD)

Måns Rullgård's SoX fork [sox-dsd](https://github.com/mansr/sox) ships as a separate program.

- License: the program is GPL, and the library code including the DSD support is LGPL. The license text ships with the app, and the source archive is attached to each release.
- `scripts/build-sox.sh` builds it from a commit- and checksum-pinned source, and `sox.yml` builds it on the same four platforms as FFmpeg.
- To build it locally, run `scripts/build-sox.sh` and then `node scripts/prepare-sox.mjs` (needs autoconf, automake and libtool).

## ☕ Support the developer

**Audio Convert** is a personal project (free and source-available). Your support, from the price of a coffee ($3 and up), keeps bit-exact lossless checks, CUE splitting and DSD support moving forward. ☕🎧
In the app, use the "Support" button at the top right (on macOS also Help → 開発者を支援).

👉 **[Support oud0n on Buy Me a Coffee](https://buymeacoffee.com/oud0n)**

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) (Copyright 2026 oud0n)

- **Free for non-commercial use**: personal use (hobby, study, research and other uses not leading to commercial gain) and use by non-profit organisations, educational institutions, public research organisations and government bodies is free, including modification and redistribution. When you redistribute, pass on `LICENSE` (or the license URL) and the `Required Notice:` line with it.
- **Commercial use requires prior permission**: if you want to use it at work, include it in a paid product or service, or sell it, please contact [caliber.trivia66@icloud.com](mailto:caliber.trivia66@icloud.com).
- **If you publish or distribute a modified version**, please make its origin clear:
  - State, somewhere users will see it such as the README, that it is based on this software ([oud0n/audio_convert](https://github.com/oud0n/audio_convert)) and that you modified it.
  - Give the modified version a different name, and do not use names or wording that could be mistaken for the official or an endorsed version.
- The bundled FFmpeg (LGPL) and SoX (sox-dsd; GPL / LGPL) are separate programs under their own licenses (the license texts are in the app's `licenses/` folder).
