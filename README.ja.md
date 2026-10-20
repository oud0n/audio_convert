# Audio Convert — macOS・Windows・Linux 対応の無料ロスレス音声変換ソフト

[![Latest release](https://img.shields.io/github/v/release/oud0n/audio_convert)](https://github.com/oud0n/audio_convert/releases/latest)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-orange)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-oud0n-FFDD00?style=flat&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/oud0n)

[English](README.md) | **日本語**

**Audio Convert** は、**FLAC・ALAC・WAV・AIFF・WavPack・MP3・AAC・Ogg Vorbis・Opus・DSD（DSF / DFF）** に対応した、無料・オフラインの一括音声変換ソフトです。同梱の FFmpeg がこのコンピュータ上で変換し、**ロスレス変換はビット単位で一致するかを検証**します。**CUE シートの分割**、**DSD → PCM / PCM → DSD 変換**、**ReplayGain / R128 タグ**の書き込み、タグからのファイル名作成もできます。

Tauri（Rust）と Next.js で作っており、Apple Silicon / Intel の Mac、Windows、Linux でネイティブに動きます。使い方は xrecode を手本にしています（タブごとのプリセット、タグからのファイル名、検証済みの変換後に元ファイルをゴミ箱へ）。

- 🎧 ロスレスも非可逆も: FLAC → ALAC、WAV → FLAC、FLAC → MP3、APE → FLAC、M4A → FLAC など
- ✅ ビット一致の検証: デコードした PCM の SHA-256 を比べ、元と同一であることを確かめます
- 💿 CUE 分割: `.cue`、埋め込み CUE シート、チャプターを曲ごとのファイルに分けます
- 🎛 DSD 変換: DSF / DFF → PCM、DoP、PCM → DSD64 / DSD128 / DSD256
- 🔒 プライバシー: アップロード・アカウント登録・利用状況の送信はありません

## ダウンロード

最新版は **[Releases](https://github.com/oud0n/audio_convert/releases/latest)** から入手できます。

| OS | ファイル |
| --- | --- |
| macOS（Apple Silicon / Intel） | `.dmg` |
| Windows | `.exe`（インストーラ）/ `.msi` |
| Linux | `.AppImage` / `.deb` / `.rpm` |

## 対応形式

| | 形式 |
| --- | --- |
| **出力** | FLAC、ALAC（M4A）、WAV、AIFF、WavPack、MP3、AAC（M4A）、Ogg Vorbis、Opus、AC3、WMA、DSF |
| **入力** | 上記すべてと、APE（Monkey's Audio）、TAK、TTA、W64、DFF など FFmpeg が読める形式 |
| **DSD** | DSF / DFF → PCM、DSF へのビット単位のコピー、DoP（FLAC / WAV / AIFF）、PCM → DSF（DSD64 / 128 / 256） |
| **分割** | CUE シート（外部・埋め込み）、チャプター、時間ごと、無音 |

## 主な機能

- **タブごとの変換設定**: タブごとに形式・出力先・ファイル名のパターンなどを持ち、終了時に保存して次回復元します。
- **エンコーダの設定**:
  - 「ソース品質を維持 (Same as Source)」では、元のサンプルレート・チャンネル・ビット深度をそのまま保ちます。最大サンプルレート（例: 192 kHz → 96 kHz）も指定できます。リサンプリングには soxr（最高品質）を使います。
  - FLAC は圧縮レベル 0〜8 と非圧縮（VERBATIM）に対応しています。
  - MP3 / AAC / Vorbis は CBR と VBR（V0〜V9。macOS の AAC は Apple の TVBR）に対応しています。
- **DSD**:
  - DSF / DFF を PCM に変換できます。DSF へのビット単位のコピーや、DoP（FLAC / WAV / AIFF）での出力もできます。
  - PCM から DSD（DSF、DSD64 / 128 / 256）への変換もできます。sox-dsd を使い、既定のフィルタは `sdm-8` です（sdm-4〜8・clans-4〜8 も選べます）。
- **品質検証**:
  - ロスレス同士は、デコードした PCM の SHA-256 でビット一致を確認します。
  - 非可逆変換は、S/N 比・波形類似度・長さの差を 32 bit 浮動小数・元のチャンネル数で比較します。
  - 検証に通らなかった出力では、元ファイルをゴミ箱へ移しません。
- **キュー**: バッチがすべて成功するとキューから外れます。失敗があればキューも元ファイルも残ります。
- **タグとファイル名**:
  - タグの表示・編集ができ、ReplayGain 2.0 / R128 タグ（EBU R128 で測定）も書き込めます。
  - ファイル名はパターン（`%disc2%-%track2% %title%|%filename%` など。`\` や `/` でフォルダ分け）から作れます。
  - tagsreplace.txt 形式のタグ置換ルールも使えます。
- **カバー**: 埋め込みカバーを引き継ぎます。元フォルダの `cover.jpg` などを埋め込んだり、縮小・形式変換したり、`folder.jpg` として保存したりもできます。
- **動作モード**: エンコード（通常）、結合（CUE の作成も可）、チャンネル毎のファイルに分割、多重チャンネルファイルにエンコード、抽出（再エンコードなし）、コピー。
- **加工**: ノーマライズ、音量、無音の除去、テンポ変更（音程維持）、フェード、無音の追加。
- **画面**: 日本語 / 英語、ライト / ダーク / システムのテーマ、波形表示と再生。

## よくある質問

**無料ですか？**
個人利用などの非商用なら無料です（[ライセンス](#ライセンス)を参照）。広告・アカウント登録・期限はありません。

**ファイルをどこかへ送りますか？**
送りません。FFmpeg と SoX はアプリに同梱されていて、変換はすべてこのコンピュータ上で行います。

**FLAC → ALAC（や WAV → FLAC）は本当にロスレスですか？**
はい。変換後に両方をデコードし、PCM の SHA-256 を比べて確かめます。一致しなければ失敗として報告し、元ファイルは残します。

**CUE シート付きの 1 ファイルのアルバムを分割できますか？**
できます。`.cue` か、CUE シートを埋め込んだ音声ファイルを追加すると、シートのタグ付きで曲ごとのファイルになります。

**DSD（DSF / DFF）を DSD 非対応のプレーヤー向けに変換できますか？**
できます。好きなサンプルレートで PCM（FLAC・WAV・ALAC など）に変換するか、対応 DAC 向けに DoP で出力します。

**Apple Silicon で動きますか？**
動きます。macOS 版は Apple Silicon と Intel の両方にネイティブ対応しています。

## 開発とビルド

```bash
scripts/build-sox.sh # SoX をビルド（初回のみ。アプリのビルドとテストに必要です）
npm install          # 依存関係（postinstall で FFmpeg と SoX を src-tauri/binaries/ に置きます）
npm run dev          # 開発モードで起動
npm run build        # インストーラを作る（src-tauri/target/release/bundle/）
npm run typecheck    # 型チェック
npm test             # JavaScript のテスト
```

Rust のテストは `src-tauri` で `cargo test --lib` を実行します。テストと開発ビルドは、同梱用に用意した FFmpeg（`src-tauri/binaries/`）を使います。`FFMPEG_PATH` で別の FFmpeg を指定することもできます。postinstall は既定では ffmpeg-static（GPL）を置きます。リリースでは下の LGPL 版を使います。

### 同梱する FFmpeg

`scripts/build-ffmpeg.sh` が、公式ソース（ハッシュ固定）から LGPL 版の FFmpeg をビルドします（LAME・Opus・Vorbis・soxr を静的リンク）。GitHub Actions の `ffmpeg.yml` が macOS（Apple Silicon / Intel）・Linux・Windows（MSYS2）でこれをビルドし、テストとリリースで使います。

- 手元では `scripts/build-ffmpeg.sh <作業フォルダ>` を実行します。最後の 2 行に出る `FFMPEG_BUNDLE_SOURCE` / `FFMPEG_BUNDLE_LICENSE` を指定して `node scripts/prepare-ffmpeg.mjs` を実行すると同梱されます。
- リリース用の確認（`--release`）では、必要なエンコーダがない FFmpeg や、`--enable-nonfree`（再配布不可）でビルドされた FFmpeg を拒否します。

### 同梱する SoX（PCM → DSD）

Måns Rullgård 氏の SoX 派生版 [sox-dsd](https://github.com/mansr/sox) を、別プログラムとして同梱します。

- ライセンス: プログラムは GPL、DSD 処理を含むライブラリ部分は LGPL です。ライセンス文を同梱し、ソースのアーカイブをリリースに添付します。
- `scripts/build-sox.sh` がコミット固定・ハッシュ固定のソースからビルドし、`sox.yml` が FFmpeg と同じ 4 環境でビルドします。
- 手元では `scripts/build-sox.sh` のあと `node scripts/prepare-sox.mjs` を実行します（autoconf・automake・libtool が必要）。

## ☕ 開発者を支援（Buy Me a Coffee）

**Audio Convert** は個人開発のプロジェクトです（無料・ソースコード公開）。ロスレスのビット一致検証、CUE 分割や DSD 対応などの開発を続けるため、コーヒー1杯（$3〜）からのご支援をいただけると大変励みになります！☕🎧
アプリでは、画面右上の「支援」ボタン（macOS ではメニューの「Help」→「開発者を支援」）から開けます。

👉 **[Buy Me a Coffee で oud0n を支援する](https://buymeacoffee.com/oud0n)**

## ライセンス

[PolyForm Noncommercial License 1.0.0](LICENSE)（Copyright 2026 oud0n）

- **非商用であれば自由に使えます**: 個人的な目的（趣味・学習・研究など、商用につながらないもの）での利用と、非営利団体・教育機関・公的な研究機関・政府機関での利用は、改変・再配布を含めて自由です。再配布するときは、`LICENSE`（またはライセンスの URL）と `Required Notice:` の行を一緒に渡してください。
- **商用利用には事前の許諾が必要です**: 業務での利用、有償の製品・サービスへの組み込み、販売などを考えている方は、[caliber.trivia66@icloud.com](mailto:caliber.trivia66@icloud.com) までご連絡ください。
- **改変版を公開・配布するときのお願い**: 出どころが分かるよう、次を守ってください。
  - 本ソフトウェア（[oud0n/audio_convert](https://github.com/oud0n/audio_convert)）をもとにしていることと、改変したことを、README など利用者の目に入る場所に書く
  - 改変版には別の名前を付け、本家の公式版・公認版と誤解されるような名前や表示を使わない
- 同梱の FFmpeg（LGPL）と SoX（sox-dsd。GPL / LGPL）は別のプログラムで、それぞれのライセンスに従います（アプリの `licenses/` フォルダにライセンス文があります）。
