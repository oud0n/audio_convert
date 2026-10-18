# Audio Converter

[日本語 (Japanese)](#-日本語) | [English](#-english)

---

## 🇯🇵 日本語

Next.js と Electron (Nextron) で構築された、デスクトップ向けの高機能オーディオフォーマット変換アプリケーションです。
直感的なマルチタブ（マルチジョブ）インターフェースにより、複数の変換タスクをタブ単位で並列管理しながら一括で変換処理を行うことができます。

### 主な機能

* **マルチタブ（マルチジョブ）管理**:
  - タブごとに異なる変換パラメータ（フォーマット、出力先、命名ルール等）を設定・保存できます。
  - アプリ終了時にタブの状態や変換設定が自動で `settings.json` に保存され、次回起動時に自動復元されます。
* **多様なオーディオファイルデコード**:
  - 追加したファイルはパスとタグ情報だけを保持し、音声は変換時に FFmpeg が読み込みます。大量のファイルやフォルダを追加してもメモリを消費しません。
  - 波形表示と再生用の音声は、選択中のファイルだけを FFmpeg でデコードします（48 kHz を超える音源は 44.1/48 kHz に下げて表示します）。ピーク・RMS も選択したときに計算します。
* **オーディオ品質＆データ欠損検証 (Quality Audit & Lossless Verification)**:
  - 変換前後の音声データを数学的・音響学的に比較・検証する品質判定機能を搭載。
  - **100%完全一致検証 (Bit-exact PCM SHA-256 Checksum)**: 可逆圧縮（WAV ⇄ FLAC ⇄ ALAC）間などの変換において、PCMデータに1ビットの違いもないこと（SHA-256ハッシュ完全一致）を数学的に診断・表示します。
  - **音響波形比較**: 非可逆圧縮（MP3/AAC等）や音量正規化適用時、S/N比(SNR dB)、最大波形差分(Peak Difference dB)、波形類似度(相関率%)を表示します。高域カットオフ解析は未実装のため「未測定」と表示します。
* **ソース品質を無劣化で維持 (Same as Source) モード**:
  - 元音源のサンプリングレート・チャンネル構成・対応するビット深度を維持し（ビット深度を持たない非可逆音源のPCM出力は24bit）、正規化・音量変更・トリムをバイパスします。出力形式が元の精度を保持できない場合はエラーを表示します。MP3/AAC等の非可逆出力は無劣化ではありません。
* **メタデータ（ID3タグなど）の読み込み・編集**:
  - 変換前に、タイトル、アーティスト、アルバム、アルバムアーティスト、ディスク番号、トラック番号、リリース年、ジャンル、コメントなどのタグ情報を一覧で表示・直接編集できます。
* **タグ情報に基づく自動ファイルリネーム**:
  - `{artist} - {title}`、`{album} - {track} - {title}` などのカスタムパターンを使用し、タグ情報から出力ファイル名を自動生成できます。
* **高度な処理オプション＆バッチ再実行**:
  - 変換完了後、ワンクリックで全トラックのステータスを待機中に戻す「キュー状態をリセット」ボタンを標準搭載。
  - 変換完了後、元のソースファイルを安全にゴミ箱へ移動するオプション（Electronの安全なAPIを使用）。
  - 音声データの音量ノーマライズ（正規化）、無音区間の自動トリミング機能。
  - FFmpegエンコードスレッド数やサンプリングレート、ビット深度、チャンネル数、ビットレートの微調整。
* **多言語対応 (Localization)**:
  - 上部メニューから日本語と英語の表示言語をワンクリックで切り替えることができます。

### 開発とビルド

#### 依存関係のインストール
```bash
npm install
```

#### 開発モードでの起動
```bash
npm run dev
```

#### プロダクションビルド（パッケージング）
```bash
npm run build
```
※ Tauri でビルドし、インストーラーは `src-tauri/target/release/bundle/` に生成されます。

#### 同梱する FFmpeg
`npm install` 時に `scripts/prepare-ffmpeg.mjs` が FFmpeg を `src-tauri/binaries/` にコピーし、アプリに同梱します（ライセンス文も同梱）。既定は `ffmpeg-static` のバイナリで、`FFMPEG_BUNDLE_SOURCE` で別のビルドを指定できます。リリースビルド（`node scripts/prepare-ffmpeg.mjs --release`）では、必要なエンコーダがない FFmpeg や `--enable-nonfree` でビルドされた（再配布できない）FFmpeg を拒否します。リリースでは全 OS で、`scripts/build-ffmpeg.sh` が公式ソース（ハッシュ固定）から LGPL 版の FFmpeg（LAME・Opus・Vorbis・soxr を静的リンク）をビルドして同梱します。GitHub Actions の `ffmpeg.yml` が macOS（Apple Silicon / Intel）・Linux・Windows（MSYS2）でこれをビルドし、テストとリリースで使います。ビルド結果はスクリプトのハッシュでキャッシュされ、スクリプトを変えたときだけ作り直されます。手元でも `scripts/build-ffmpeg.sh <作業フォルダ>` でビルドでき、最後の 2 行に出る `FFMPEG_BUNDLE_SOURCE` / `FFMPEG_BUNDLE_LICENSE` を指定して `node scripts/prepare-ffmpeg.mjs` を実行すると同梱されます。

### 課題点・既知の制限事項

* **検証済みの出力フォーマット**:
  - 本アプリの変換機能は、現在のところ**提示音源を使って `FLAC`・`WAV`・`ALAC` 出力を動作検証**を行っています。その他の形式への変換については、正常にエンコードされない、または一部のメタデータが引き継がれない可能性があります。
* **アートワーク（アルバムアート）の欠落**:
  - 音声ファイルの変換（デコード・再エンコード）処理を行う際、基本的なテキストタグ情報（タイトル、アーティスト等）は保持されますが、**MP3・FLAC・M4A・ALACでは先頭の埋め込み画像を保持します**。WAV・AIFFなど他の形式では画像を保持しません。

---

## 🇺🇸 English

A feature-rich desktop audio format conversion suite built with Next.js and Electron (Nextron).
Featuring an intuitive multi-tab (multi-job) interface, you can organize and batch-process audio conversion tasks with independent settings for each profile tab.

### Key Features

* **Multi-Tab (Multi-Job) Management**:
  - Configure and preserve separate encoding profiles (formats, output locations, rename patterns, etc.) per tab.
  - Automatically saves active tab layouts and settings to `settings.json` upon exit for instant restoration on next launch.
* **Versatile Audio Decoding & Fallback**:
  - Added files keep only their path and tags; FFmpeg reads the audio at conversion time, so large folders do not use up memory.
  - Only the selected file is decoded (by FFmpeg) for the waveform and player; sources above 48 kHz are shown at 44.1/48 kHz. Peak and RMS are measured when a file is selected.
* **Audio Quality & Data Loss Verification (Audit Engine)**:
  - Built-in mathematical and acoustic auditing to compare source vs converted audio.
  - **100% Bit-exact PCM SHA-256 Checksum**: Verifies bit-for-bit identity (zero loss) for lossless conversions (WAV ⇄ FLAC ⇄ ALAC).
  - **Waveform & Spectral Differential Analysis**: Calculates Signal-to-Noise Ratio (SNR dB), Peak Difference (dB), Waveform Correlation (%), for lossy or normalized conversions. Spectral cutoff detection is not implemented and is displayed as unmeasured.
* **Same as Source (Lossless Direct) Mode**:
  - Preserves source sample rate, channel layout, and supported PCM precision while bypassing normalization, gain and trimming. Unsupported precision produces an error. Lossy formats such as MP3/AAC remain lossy.
* **Metadata (ID3 Tag) Inspection & Editing**:
  - View and edit Title, Artist, Album, Album Artist, Disc #, Track #, Year, Genre, and Comments prior to batch processing.
* **Tag-Based Automatic File Renaming**:
  - Custom filename generation using metadata placeholders (e.g., `{artist} - {title}`, `{album} - {track} - {title}`).
* **Advanced Processing & One-Click Queue Reset**:
  - One-click "Reset Queue Status" button to reset completed/failed files back to queued for instant re-processing with updated parameters.
  - Safe source file trash option via native Electron API upon conversion completion.
  - Peak amplitude normalization and automatic silence trimming.
  - Fine-grained control over FFmpeg encoder threads, sample rates, bit depth, channel layouts, and bitrates.
* **Multi-Language Support (Localization)**:
  - Instant UI toggle between Japanese and English.

### Development & Build

#### Install Dependencies
```bash
npm install
```

#### Start Development Mode
```bash
npm run dev
```

#### Production Build & Packaging
```bash
npm run build
```
* Builds with Tauri; installers are written to `src-tauri/target/release/bundle/`.

#### Bundled FFmpeg
`npm install` runs `scripts/prepare-ffmpeg.mjs`, which copies FFmpeg to `src-tauri/binaries/` so it ships with the app (with its license text). The default is the `ffmpeg-static` binary; set `FFMPEG_BUNDLE_SOURCE` to use another build. Release builds (`node scripts/prepare-ffmpeg.mjs --release`) refuse an FFmpeg that lacks a required encoder or was built with `--enable-nonfree` (not redistributable). Releases on every platform bundle an LGPL FFmpeg built from the official, checksum-pinned sources by `scripts/build-ffmpeg.sh` (LAME, Opus, Vorbis and soxr linked statically). The GitHub Actions workflow `ffmpeg.yml` builds it on macOS (Apple Silicon and Intel), Linux and Windows (MSYS2) for the test and release workflows; builds are cached by the script's hash, so FFmpeg is rebuilt only when the script changes. To build it locally, run `scripts/build-ffmpeg.sh <work-dir>` and pass the `FFMPEG_BUNDLE_SOURCE` / `FFMPEG_BUNDLE_LICENSE` values from its last two lines to `node scripts/prepare-ffmpeg.mjs`.

### Known Limitations

* **Validated Output Formats**:
  - Core encoding logic has been primarily validated for **`FLAC`, `WAV` and `ALAC` outputs with the supplied local fixture**. Outputting to other compressed codecs may have partial metadata preservation or encoding limits.
* **Embedded Cover Artwork**:
  - Text metadata tags (Title, Artist, Album, etc.) are preserved, but **the first embedded cover image is preserved for MP3, FLAC, M4A and ALAC**. Other outputs, including WAV and AIFF, omit artwork.


### 変換・検証の実装仕様 / Conversion and verification

- WAVのテキストタグはUnicode対応のID3v2.3として保存します。
- 保存はFFmpegで一元処理し、ブラウザの音声バッファは出力生成に使用しません。元ファイルをゴミ箱に移動した後は、波形と再生に保存された出力を使います。
- ピーク正規化を有効にした場合はピーク目標値を優先し、手動音量変更は適用しません。無音トリムは先頭・末尾を対象とします。
- 出力名のみNFC正規化し、Windows禁止文字・予約名・長すぎる名前を処理します。入力パスは変更しません。同名ファイルがある場合は、設定に応じて連番を付ける（`名前_2`、`名前_3`…）・上書きする・スキップするのいずれかを行います（既定は連番）。サンプルレートの変換には soxr（最高品質設定）を使います。FLAC は圧縮レベル 0〜8 のほか、非圧縮（全サブフレームが VERBATIM）でも書き出せます。
- 完成した出力を同じ保存先の一時ファイルからハードリンクで確定します。FAT/exFAT等のハードリンク非対応の保存先では排他的に新規ファイルを作成し、コピー失敗時には削除します。「上書き」を選んだ場合のみ既存出力を置き換えます。元ファイル自身は上書きしません。
- PCM完全一致は、元の精度を保持したfloat64 PCMのSHA-256とサンプルレート・チャンネル数・PCMバイト数で判断します。これはコンテナやタグを含むファイル全体の一致ではありません。
- 音声構成が異なる場合は完全一致とせず、波形比較は実行しません。ハッシュ・波形解析失敗は検証失敗として扱います。
- 自動検証が有効な場合、検証失敗やwarning/degradedの出力では元ファイルをゴミ箱へ移しません。
- Windows/macOS/Linux CIで生成音源を使う回帰テストを実行します。`npm run typecheck`・`npm test`・`src-tauri` での `cargo test --lib` でローカル検証できます。`FFMPEG_PATH` で使う FFmpeg を指定できます。
- ログはElectronのuserData内の `debug_ipc.log` に保存します。
- キャンセルは実行中のFFmpeg（正規化解析・変換・自動検証）を停止し、停止完了まで新しいバッチを開始しません。保存確定済みの出力は保持します。元ファイルのゴミ箱移動を既にOSへ依頼した場合、その操作は取り消せません。
- 正規化解析と変換の進捗はFFmpegの処理時刻から表示します。バッチ終了通知は成功・失敗・要確認の件数を表示します。

The native FFmpeg pipeline applies conversion settings, and preserves supported source precision; once the source is in the trash, the waveform and player use the saved output. Output names retain Unicode while sanitizing Windows restrictions. When the output name exists, the file gets a number (`name_2`, `name_3`, ...), replaces it, or is skipped, as set (default: number); the source file itself is never replaced. Sample rates are converted with soxr at its highest quality. FLAC can be written at levels 0-8 or uncompressed (every subframe VERBATIM). Publication uses hard links with an exclusive-copy fallback for FAT/exFAT. Exact PCM verification uses float64 PCM SHA-256 plus audio structure and decoded byte count. Failed analysis never passes verification. Optional source trashing is withheld when enabled automatic verification fails or reports warning/degraded.
