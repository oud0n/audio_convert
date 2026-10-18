# Audio Convert

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-oud0n-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/oud0n)
![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange)

[日本語 (Japanese)](#-日本語) | [English](#-english)

---

## 🇯🇵 日本語

Tauri（Rust）と Next.js で作った、デスクトップ向けの音声変換アプリです。xrecode の使い方（タブごとのプリセット、タグからのファイル名、変換後に元ファイルをゴミ箱へ）を手本にしています。変換はアプリに同梱した FFmpeg（LGPL）がこのコンピュータ上で行い、ロスレス変換はビット単位で一致するかを検証します。

### ダウンロード

[Releases](https://github.com/oud0n/audio_convert/releases) から入手できます。

- macOS: `.dmg`（Apple Silicon / Intel）
- Windows: `.exe`（インストーラ）/ `.msi`
- Linux: `.AppImage` / `.deb` / `.rpm`

### 主な機能

- **タブごとの変換設定**: タブごとに形式・出力先・ファイル名のパターンなどを持ち、終了時に保存して次回復元します。
- **出力形式**: FLAC・ALAC・WAV・AIFF・WavPack・MP3・AAC（M4A）・Ogg Vorbis・Opus・AC3・WMA・DSF。
  - 「ソース品質を維持 (Same as Source)」では、元のサンプルレート・チャンネル・ビット深度をそのまま保ちます。最大サンプルレート（例: 192 kHz → 96 kHz）も指定できます。リサンプリングには soxr（最高品質）を使います。
  - FLAC は圧縮レベル 0〜8 と非圧縮（VERBATIM）に対応しています。
  - MP3 / AAC / Vorbis は CBR と VBR（V0〜V9。macOS の AAC は Apple の TVBR）に対応しています。
- **DSD**:
  - DSF / DFF を PCM に変換できます。DSF へのビット単位のコピーや、DoP（FLAC / WAV / AIFF）での出力もできます。
  - PCM から DSD（DSF、DSD64 / 128 / 256）への変換もできます。sox-dsd を使い、既定のフィルタは xrecode と同じ `sdm-8` です（sdm-4〜8・clans-4〜8 も選べます）。
- **品質検証**:
  - ロスレス同士は、デコードした PCM の SHA-256 でビット一致を確認します。
  - 非可逆変換は、S/N 比・波形類似度・長さの差を 32 bit 浮動小数・元のチャンネル数で比較します。
  - 検証に通らなかった出力では、元ファイルをゴミ箱へ移しません。
- **キュー**: バッチがすべて成功するとキューから外れます（xrecode と同じ）。失敗があればキューも元ファイルも残ります。
- **タグとファイル名**:
  - タグの表示・編集ができ、ReplayGain 2.0 / R128 タグ（EBU R128 で測定）も書き込めます。
  - ファイル名はパターン（`%disc2%-%track2% %title%|%filename%` など。`\` や `/` でフォルダ分け）から作れます。
  - xrecode の tagsreplace.txt 形式のタグ置換ルールも使えます。
- **カバー**: 埋め込みカバーを引き継ぎます。元フォルダの `cover.jpg` などを埋め込んだり、縮小・形式変換したり、`folder.jpg` として保存したりもできます。
- **CUE とチャプター**: `.cue`、埋め込み CUE シート、チャプターを曲ごとに分割します。時間ごと・無音での分割もできます。
- **動作モード**:
  - エンコード（通常）
  - 結合（CUE の作成も可）
  - チャンネル毎のファイルに分割
  - 多重チャンネルファイルにエンコード
  - 抽出（再エンコードなし）
  - コピー
- **加工**: ノーマライズ、音量、無音の除去、テンポ変更（音程維持）、フェード、無音の追加。
- **画面**: 日本語 / 英語、ライト / ダーク / システムのテーマ、波形表示と再生。

### 開発とビルド

```bash
scripts/build-sox.sh # SoX をビルド（初回のみ。アプリのビルドとテストに必要です）
npm install          # 依存関係（postinstall で FFmpeg と SoX を src-tauri/binaries/ に置きます）
npm run dev          # 開発モードで起動
npm run build        # インストーラを作る（src-tauri/target/release/bundle/）
npm run typecheck    # 型チェック
npm test             # JavaScript のテスト
```

Rust のテストは `src-tauri` で `cargo test --lib` を実行します。テストと開発ビルドは、同梱用に用意した FFmpeg（`src-tauri/binaries/`）を使います。`FFMPEG_PATH` で別の FFmpeg を指定することもできます。postinstall は既定では ffmpeg-static（GPL）を置きます。リリースでは下の LGPL 版を使います。

#### 同梱する FFmpeg
`scripts/build-ffmpeg.sh` が、公式ソース（ハッシュ固定）から LGPL 版の FFmpeg をビルドします（LAME・Opus・Vorbis・soxr を静的リンク）。GitHub Actions の `ffmpeg.yml` が macOS（Apple Silicon / Intel）・Linux・Windows（MSYS2）でこれをビルドし、テストとリリースで使います。

- 手元では `scripts/build-ffmpeg.sh <作業フォルダ>` を実行します。最後の 2 行に出る `FFMPEG_BUNDLE_SOURCE` / `FFMPEG_BUNDLE_LICENSE` を指定して `node scripts/prepare-ffmpeg.mjs` を実行すると同梱されます。
- リリース用の確認（`--release`）では、必要なエンコーダがない FFmpeg や、`--enable-nonfree`（再配布不可）でビルドされた FFmpeg を拒否します。

#### 同梱する SoX（PCM → DSD）
Måns Rullgård 氏の SoX 派生版 [sox-dsd](https://github.com/mansr/sox) を、別プログラムとして同梱します。

- ライセンス: プログラムは GPL、DSD 処理を含むライブラリ部分は LGPL です。ライセンス文を同梱し、ソースのアーカイブをリリースに添付します。
- `scripts/build-sox.sh` がコミット固定・ハッシュ固定のソースからビルドし、`sox.yml` が FFmpeg と同じ 4 環境でビルドします。
- 手元では `scripts/build-sox.sh` のあと `node scripts/prepare-sox.mjs` を実行します（autoconf・automake・libtool が必要）。

### ☕ 開発者を支援（Buy Me a Coffee）

**Audio Convert (`audio_convert`)** は個人開発のプロジェクトです（無料・ソースコード公開）。
xrecode 互換の変換、ロスレスのビット一致検証、CUE 分割や DSD 対応などの開発を続けるため、コーヒー1杯（$3〜）からのご支援をいただけると大変励みになります！☕🎧
アプリでは、画面右上の「支援」ボタン（macOS ではメニューの「Help」→「開発者を支援」）から開けます。

👉 **[Buy Me a Coffee で oud0n を支援する](https://buymeacoffee.com/oud0n)**

### 📜 ライセンス

[PolyForm Noncommercial License 1.0.0](LICENSE)（Copyright 2026 oud0n）

- **非商用であれば自由に使えます**: 個人的な目的（趣味・学習・研究など、商用につながらないもの）での利用と、非営利団体・教育機関・公的な研究機関・政府機関での利用は、改変・再配布を含めて自由です。再配布するときは、`LICENSE`（またはライセンスの URL）と `Required Notice:` の行を一緒に渡してください。
- **商用利用には事前の許諾が必要です**: 業務での利用、有償の製品・サービスへの組み込み、販売などを考えている方は、[caliber.trivia66@icloud.com](mailto:caliber.trivia66@icloud.com) までご連絡ください。
- **改変版を公開・配布するときのお願い**: 出どころが分かるよう、次を守ってください。
  - 本ソフトウェア（[oud0n/audio_convert](https://github.com/oud0n/audio_convert)）をもとにしていることと、改変したことを、README など利用者の目に入る場所に書く
  - 改変版には別の名前を付け、本家の公式版・公認版と誤解されるような名前や表示を使わない
- 同梱の FFmpeg（LGPL）と SoX（sox-dsd。GPL / LGPL）は別のプログラムで、それぞれのライセンスに従います（アプリの `licenses/` フォルダにライセンス文があります）。

---

## 🇺🇸 English

A desktop audio converter built with Tauri (Rust) and Next.js, modeled on how xrecode is used: presets per tab, file names from tags, sources moved to the trash after conversion. Conversion runs on your computer with the bundled FFmpeg (LGPL), and lossless conversions are checked bit for bit.

### Download

Get it from [Releases](https://github.com/oud0n/audio_convert/releases).

- macOS: `.dmg` (Apple Silicon / Intel)
- Windows: `.exe` (installer) / `.msi`
- Linux: `.AppImage` / `.deb` / `.rpm`

### Features

- **Settings per tab**: each tab has its own format, output folder, file name pattern and more, saved on exit and restored on the next start.
- **Output formats**: FLAC, ALAC, WAV, AIFF, WavPack, MP3, AAC (M4A), Ogg Vorbis, Opus, AC3, WMA, DSF.
  - "Same as Source" keeps the source's sample rate, channels and bit depth. A maximum sample rate (e.g. 192 kHz → 96 kHz) can be set. Resampling uses soxr at its highest quality.
  - FLAC supports compression levels 0–8 and uncompressed (VERBATIM).
  - MP3 / AAC / Vorbis support CBR and VBR (V0–V9; AAC on macOS uses Apple's TVBR).
- **DSD**:
  - DSF / DFF convert to PCM, copy bit for bit to DSF, or go out as DoP (FLAC / WAV / AIFF).
  - PCM converts to DSD (DSF, DSD64 / 128 / 256) with sox-dsd. The default filter is `sdm-8`, the one xrecode uses (sdm-4–8 and clans-4–8 can be chosen).
- **Quality check**:
  - Lossless conversions are checked bit for bit (SHA-256 of the decoded PCM).
  - Lossy conversions are compared by S/N ratio, waveform correlation and length, in 32-bit float at the source's channel count.
  - Sources of outputs that fail are never moved to the trash.
- **Queue**: a batch that fully succeeds leaves the queue (as in xrecode). After any failure, the queue and the sources stay.
- **Tags and names**:
  - View and edit tags, and write ReplayGain 2.0 / R128 tags (measured with EBU R128).
  - Build file names from patterns (`%disc2%-%track2% %title%|%filename%`; `\` or `/` makes folders).
  - Tag replace rules in xrecode's tagsreplace.txt format.
- **Covers**: embedded covers are kept. Covers like `cover.jpg` from the source folder can be embedded, shrunk or converted, and saved as `folder.jpg`.
- **CUE and chapters**: `.cue` files, embedded CUE sheets and chapters split into tracks. Files can also be split by time or at silences.
- **Action modes**:
  - Encode (the default)
  - Merge (optionally with a CUE sheet)
  - Split by channels
  - Encode multi-channel
  - Extract (no re-encoding)
  - Copy
- **Processing**: normalization, volume, silence trimming, tempo change (keeps pitch), fades, added silence.
- **Interface**: Japanese / English, light / dark / system theme, waveform and player.

### Development and build

```bash
scripts/build-sox.sh # build SoX (once; app builds and tests need it)
npm install          # dependencies (postinstall puts FFmpeg and SoX in src-tauri/binaries/)
npm run dev          # start in development mode
npm run build        # build the installers (src-tauri/target/release/bundle/)
npm run typecheck    # type check
npm test             # JavaScript tests
```

Run the Rust tests with `cargo test --lib` in `src-tauri`. Tests and development builds use the FFmpeg prepared for bundling (`src-tauri/binaries/`); set `FFMPEG_PATH` to use another one. By default postinstall puts ffmpeg-static (GPL) there; releases use the LGPL build below.

#### Bundled FFmpeg
`scripts/build-ffmpeg.sh` builds an LGPL FFmpeg from the official, checksum-pinned sources (LAME, Opus, Vorbis and soxr linked statically). The GitHub Actions workflow `ffmpeg.yml` builds it on macOS (Apple Silicon and Intel), Linux and Windows (MSYS2) for the test and release workflows.

- To build it locally, run `scripts/build-ffmpeg.sh <work-dir>`, then pass the `FFMPEG_BUNDLE_SOURCE` / `FFMPEG_BUNDLE_LICENSE` values from its last two lines to `node scripts/prepare-ffmpeg.mjs`.
- The release check (`--release`) refuses an FFmpeg that lacks a required encoder or was built with `--enable-nonfree` (not redistributable).

#### Bundled SoX (PCM to DSD)
Måns Rullgård's SoX fork [sox-dsd](https://github.com/mansr/sox) ships as a separate program.

- License: the program is GPL, and the library code including the DSD support is LGPL. The license text ships with the app, and the source archive is attached to each release.
- `scripts/build-sox.sh` builds it from a commit- and checksum-pinned source, and `sox.yml` builds it on the same four platforms as FFmpeg.
- To build it locally, run `scripts/build-sox.sh` and then `node scripts/prepare-sox.mjs` (needs autoconf, automake and libtool).

### ☕ Support the developer (Buy Me a Coffee)

**Audio Convert (`audio_convert`)** is a personal project (free and source-available).
Your support, from the price of a coffee ($3 and up), keeps xrecode-compatible conversion, bit-exact lossless checks, CUE splitting and DSD support moving forward. ☕🎧
In the app, use the "Support" button at the top right (on macOS also Help → 開発者を支援).

👉 **[Support oud0n on Buy Me a Coffee](https://buymeacoffee.com/oud0n)**

### 📜 License

[PolyForm Noncommercial License 1.0.0](LICENSE) (Copyright 2026 oud0n)

- **Free for non-commercial use**: personal use (hobby, study, research and other uses not leading to commercial gain) and use by non-profit organisations, educational institutions, public research organisations and government bodies is free, including modification and redistribution. When you redistribute, pass on `LICENSE` (or the license URL) and the `Required Notice:` line with it.
- **Commercial use requires prior permission**: if you want to use it at work, include it in a paid product or service, or sell it, please contact [caliber.trivia66@icloud.com](mailto:caliber.trivia66@icloud.com).
- **If you publish or distribute a modified version**, please make its origin clear:
  - State, somewhere users will see it such as the README, that it is based on this software ([oud0n/audio_convert](https://github.com/oud0n/audio_convert)) and that you modified it.
  - Give the modified version a different name, and do not use names or wording that could be mistaken for the official or an endorsed version.
- The bundled FFmpeg (LGPL) and SoX (sox-dsd; GPL / LGPL) are separate programs under their own licenses (the license texts are in the app's `licenses/` folder).
