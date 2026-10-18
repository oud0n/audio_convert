# Audio Converter - 残件 TODO リスト

敵対的コードレビュー（Adversarial Review）により特定されたバグ修正、アーキテクチャ改善、および Rust バックエンド移行のタスク一覧です。

---

## 1. 緊急バグ修正 (Immediate Fixes)

- [x] **[Critical] 別ドライブ保存時の `EXDEV` 例外修正**
  - ファイル: `main/helpers/audio-pipeline.mjs` (`publishOutput`)
  - 内容: `fs.link` 失敗時の捕捉エラーコードに `'EXDEV'` を追加し、別パーティション・USBメモリ等への保存時にファイルコピー・フォールバックが確実に動作するように修正する。
- [x] **[Critical] macOS / Linux でのフォルダドロップ時のパス破壊修正**
  - ファイル: `renderer/pages/home.tsx` (`scanFiles`)
  - 内容: パス区切り文字の無条件 `\` 置換を廃止し、OS に適したセパレータ（`path.sep` または環境判定）を使用する。
- [x] **[Critical] 非可逆音源（AAC/MP3等）における音響品質監査のデッドコード修正**
  - ファイル: `main/main.ts` (`verify-audio-quality`)
  - 内容: エンコーダ遅延やパディングによるバイト数（`bytes`）不一致時にも、波形差分解析（SNR、相関率、ピーク差分）がスキップされずに実行されるよう判定ロジックを修正する。
- [x] **[High] 音響相関のゼロ除算欠陥（無音 vs 大音量音源の偽陽性100%判定）修正**
  - ファイル: `main/main.ts` (`compareWavBuffers`)
  - 内容: 片方の信号が無音（`sigPow1 === 0` または `sigPow2 === 0`）の場合に初期値（相関 1.0 / SNR 100dB）を返さず、無音同士の場合のみ100%、片方のみ無音の場合は相関0%・SNR -100dB と判定するよう修正する。
- [x] **[High] 再生プログレス更新の古いクロージャ（Stale Closure）修正**
  - ファイル: `renderer/pages/home.tsx` (`startPlayback` / `updateProgress`)
  - 内容: アニメーションループ内で古い React state `isPlaying` を参照して即座にループ終了する不具合を修正する（Ref による再生状態追跡）。
- [x] **[Medium] リネームパターンの安全置換（`replaceAll` & `$` 記号エスケープ）**
  - ファイル: `renderer/context/AudioConverterContext.tsx` (`runConversionWorkflow`)
  - 内容: 単一 `replace` から `split(token).join(val)` へ変更し、`$` 記号によるメタデータ文字列破壊と複数同名トークンの置換漏れを防止する。
- [x] **[Medium] 設定ファイル保存先のポータブル化**
  - ファイル: `main/main.ts` (`load-settings-file` / `save-settings-file`)
  - 内容: `process.cwd()` から `app.getPath('userData')` へ保存先を変更し、パッケージ版（`/Applications` や `Program Files`）での書き込み権限エラーを防止する。

---

## 2. メモリ・パフォーマンス・コード整理 (Optimization & Cleanup)

（すべて対応済み。2026-10-18）

---

## 3. Tauri 2.0 + Rust バックエンド移行計画 (Tauri 2.0 Native Migration)

ユーザー指定に基づき、Electron から **Tauri 2.0 (Rust バックエンド + Next.js フロントエンド)** への全面刷新を行います。

### Phase 1: Tauri 2.0 プロジェクト基盤と Rust オーディオエンジンの構築
- [x] **Tauri 2.0 初期化 (`src-tauri/`)**
  - `Cargo.toml` 設定（`tauri 2.12.3`, `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-shell`, `tauri-plugin-opener`, `serde`, `lofty`, `hound`, `sha2`, `trash` 等）
  - `tauri.conf.json` 設定（ウィンドウ設定、Next.js 静的出力ディレクトリ連携 `../app`、権限設定 `capabilities/default.json`）
- [x] **Rust コア音声処理モジュールの実装 (`src-tauri/src/audio/`)**
  - `metadata.rs`: `lofty` による規格準拠のメタデータ（ID3v2, VorbisComment, MP4 ilst 等）高速読み込み
  - `audit.rs`: SIMD・サンプル最適化された音響品質監査エンジン（Bit-exact PCM SHA-256、全サンプル SNR、ピーク差分、相関率計算）
  - `convert.rs`: 非同期プロセス追跡、ジョブキャンセル、ストリーミング進捗発火 (`conversion-progress`)、安全なファイル書き出しパイプライン

### Phase 2: Tauri IPC コマンド群の実装
- [x] `read_audio_metadata` コマンドの実装（曲名、アーティスト、カバーアート、フォーマット情報）
- [x] `convert_audio` コマンドの実装（ストリーミング進捗イベント `conversion-progress` をフロントへ発火）
- [x] `verify_audio_quality` コマンドの実装（高精度な波形監査）
- [x] `trash_file` コマンドの実装（ネイティブ OS のゴミ箱 API 呼び出し）
- [x] `load_settings` / `save_settings` コマンドの実装（OS の AppData / Application Support ディレクトリ自動利用）
- [x] `select_directory` コマンドの実装（`tauri-plugin-dialog` によるネイティブフォルダピッカー）

### Phase 3: フロントエンド（Next.js）の Tauri 対応と Electron 撤廃
- [x] **IPC 抽象化レイヤーの導入 (`renderer/services/bridge.ts`)**
  - `@tauri-apps/api/core`（`invoke`）および `@tauri-apps/api/event`（`listen`）への接続
  - ドラッグ＆ドロップ時のパス取得を Tauri ネイティブファイルドロップイベント（`onDragDropEvent`）へ対応
  - `AudioConverterContext.tsx` および `home.tsx` の全 `window.ipc` 呼び出しを `AppBridge` に完全置換
- [x] **ビルド・パッケージング検証**
  - Next.js の静的エクスポート（`next build renderer`）と `tauri build` の自動連携検証完了
- [x] **Electron 関連依存（`electron`, `electron-builder`, `nextron` 等）の完全削除（アプリ容量 150MB+ → 約 16MB への軽量化達成）**
