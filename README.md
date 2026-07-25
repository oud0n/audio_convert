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
  - Web Audio API (`AudioContext`) による高速なブラウザネイティブデコードに対応。
  - ブラウザでデコードできない一部の形式（ALAC/M4Aなど）については、メインプロセス側の Node.js 音声デコーダーによる安全なフォールバック処理を自動で起動します。
* **オーディオ品質＆データ欠損検証 (Quality Audit & Lossless Verification)**:
  - 変換前後の音声データを数学的・音響学的に比較・検証する品質判定機能を搭載。
  - **100%完全一致検証 (Bit-exact PCM MD5 Checksum)**: 可逆圧縮（WAV ⇄ FLAC ⇄ ALAC）間などの変換において、PCMデータに1ビットの違いもないこと（MD5ハッシュ完全一致）を数学的に診断・表示します。
  - **音響波形比較＆帯域解析**: 有可逆圧縮（MP3/AAC等）や音量正規化適用時、S/N比(SNR dB)、最大波形差分(Peak Difference dB)、波形類似度(相関率%)、および16kHz以上の高音域カットオフ有無を自動解析・ビジュアル化します。
* **ソース品質を無劣化で維持 (Same as Source) モード**:
  - 元音源のサンプリングレート・ビット深度をそのまま自動維持し、音響スケーリングによる波形変化を招く正規化やトリムを自動バイパスして完全無劣化出力するダイレクトモードに対応しています。
* **メタデータ（ID3タグなど）の読み込み・編集**:
  - 変換前に、タイトル、アーティスト、アルバム、アルバムアーティスト、ディスク番号、トラック番号、リリース年、ジャンル、コメントなどのタグ情報を一覧で表示・直接編集できます。
* **タグ情報に基づく自動ファイルリネーム**:
  - `{artist} - {title}`、`{album} - {track} - {title}` などのカスタムパターンを使用し、タグ情報から出力ファイル名を自動生成できます。
* **高度な処理オプション＆バッチ再実行**:
  - 変換完了後、ワンクリックで全トラックのステータスを待機中に戻す「キュー状態をリセット」ボタンを標準搭載。
  - 変換完了後、元のソースファイルを安全にゴミ箱へ移動するオプション（Electronの安全なAPIを使用）。
  - 音声データの音量ノーマライズ（正規化）、無音区間の自動トリミング機能。
  - スレッドプールサイズやサンプリングレート、ビット深度、チャンネル数、ビットレートの微調整。
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
※ ビルド実行時に自動的に Next.js の古い型定義キャッシュ（`renderer/.next`）がクリーンアップされ、`dist/Audio Converter Setup 1.0.0.exe` (NSIS インストーラー) および `dist/Audio Converter-1.0.0-win.zip` (Zip 圧縮パッケージ) が同時に生成されます。

### 課題点・既知の制限事項

* **検証済みの出力フォーマット**:
  - 本アプリの変換機能は、現在のところ**出力フォーマットとして `FLAC` および `WAV` のみで動作検証**を行っています。その他の形式への変換については、正常にエンコードされない、または一部のメタデータが引き継がれない可能性があります。
* **アートワーク（アルバムアート）の欠落**:
  - 音声ファイルの変換（デコード・再エンコード）処理を行う際、基本的なテキストタグ情報（タイトル、アーティスト等）は保持されますが、**埋め込まれているアルバムアート（画像データ）は変換後のファイルから欠落します**。あらかじめご了承ください。

---

## 🇺🇸 English

A feature-rich desktop audio format conversion suite built with Next.js and Electron (Nextron).
Featuring an intuitive multi-tab (multi-job) interface, you can organize and batch-process audio conversion tasks with independent settings for each profile tab.

### Key Features

* **Multi-Tab (Multi-Job) Management**:
  - Configure and preserve separate encoding profiles (formats, output locations, rename patterns, etc.) per tab.
  - Automatically saves active tab layouts and settings to `settings.json` upon exit for instant restoration on next launch.
* **Versatile Audio Decoding & Fallback**:
  - Fast browser-native decoding via Web Audio API (`AudioContext`).
  - Automatic fallback to main-process Node.js/FFmpeg audio decoder for formats unsupported natively by browsers (e.g. ALAC/M4A).
* **Audio Quality & Data Loss Verification (Audit Engine)**:
  - Built-in mathematical and acoustic auditing to compare source vs converted audio.
  - **100% Bit-exact PCM MD5 Checksum**: Verifies bit-for-bit identity (zero loss) for lossless conversions (WAV ⇄ FLAC ⇄ ALAC).
  - **Waveform & Spectral Differential Analysis**: Calculates Signal-to-Noise Ratio (SNR dB), Peak Difference (dB), Waveform Correlation (%), and 16kHz high-frequency cutoff detection for lossy or normalized conversions.
* **Same as Source (Lossless Direct) Mode**:
  - Preserves original audio sampling rate and bit depth, automatically bypassing normalization and scaling to output 100% lossless identical audio.
* **Metadata (ID3 Tag) Inspection & Editing**:
  - View and edit Title, Artist, Album, Album Artist, Disc #, Track #, Year, Genre, and Comments prior to batch processing.
* **Tag-Based Automatic File Renaming**:
  - Custom filename generation using metadata placeholders (e.g., `{artist} - {title}`, `{album} - {track} - {title}`).
* **Advanced Processing & One-Click Queue Reset**:
  - One-click "Reset Queue Status" button to reset completed/failed files back to queued for instant re-processing with updated parameters.
  - Safe source file trash option via native Electron API upon conversion completion.
  - Peak loudness normalization (EBU R128 scaling) and automatic silence trimming.
  - Fine-grained control over thread pool size, sample rates, bit depth, channel layouts, and bitrates.
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
* Executing the build automatically purges stale Next.js cache (`renderer/.next`) and packages both `dist/Audio Converter Setup 1.0.0.exe` (NSIS Installer) and `dist/Audio Converter-1.0.0-win.zip` (Portable Zip Archive).

### Known Limitations

* **Validated Output Formats**:
  - Core encoding logic has been primarily validated for **`FLAC` and `WAV` output formats**. Outputting to other compressed codecs may have partial metadata preservation or encoding limits.
* **Embedded Cover Artwork**:
  - Text metadata tags (Title, Artist, Album, etc.) are preserved, but **embedded album cover artwork (image binary) is currently omitted** in transcode operations.
