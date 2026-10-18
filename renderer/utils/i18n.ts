export const translations = {
  ja: {
    // Title & Global
    appName: 'Audio Convert',
    
    // Import buttons
    addFiles: 'ファイル追加',
    addFolder: 'フォルダ追加',
    clearQueue: 'キュークリア',
    resetQueueBtn: 'キュー状態をリセット',
    resetQueueTooltip: '変換完了・失敗した全ファイルのステータスを待機中に戻します',
    sameAsSource: 'ソース品質を無劣化で維持 (Same as Source)',
    sameAsSourceHint: '元音源のサンプリングレート・ビット深度を維持し、音響スケーリング・正規化を自動バイパスします',
    
    // Bottom tabs
    tabSourceFile: 'ソースファイル',
    tabMetadata: 'メタデータ',
    tabQuality: '品質検証',
    tabLog: 'ログ',
    
    // Columns
    colSourceName: 'ソース名',
    colOutputFormat: '出力形式',
    colSize: 'サイズ',
    colDuration: '時間',
    colStatus: '状況',
    colProgress: '進捗',
    colActions: '操作',
    
    // Source File Tab
    outputPath: '出力パス',
    moveSourceToBin: '完了後、ソースファイルをゴミ箱に移動',
    createSourceFolder: 'ソースフォルダ内にファイルを作成',
    keepFolders: '元のフォルダ構成を残す:',
    splitImages: 'CUE・チャプターでトラックに分割',
    mergeOutput: '1 つのファイルに結合',
    mergeCreateCue: 'CUE を作成',
    mergeOutputHelp: 'キューのファイルを順に 1 つのファイルにまとめます。音声形式は最初のファイルに合わせ、タグとカバーも最初のファイルから取ります。品質検証が有効なときは、各部分が元ファイルとビット一致した場合だけ元ファイルをゴミ箱へ移します。',
    splitImagesHelp: '追加した .cue、または CUE シート / チャプターを含む音声ファイルを曲ごとに分けて変換します（INDEX 00 は無視）。元ファイルは全トラックの変換が終わってからゴミ箱へ移します。',
    vbrMode: 'VBR（品質）',
    cbrMode: 'CBR（固定）',
    vbrBest: '最高',
    vbrDefault: '既定',
    vbrQualityHelp: 'LAME の V 値（0 が最高音質）。AAC は同等の TVBR（V2 = TVBR 91）、Vorbis は同等の品質値になります。',
    keepFoldersLast: '末尾から',
    keepFoldersFirst: '先頭から',
    keepFoldersLevels: '階層',
    autoVerifyQuality: '変換後に自動でデータ欠損・品質検証を行う',
    fileNamePattern: 'ファイル名パターン:',
    action: '動作',
    outputSettings: '出力設定',
    normalize: '正規化',
    tempo: 'テンポ',
    fade: 'フェードイン/アウト',
    trimSilence: '無音部分の除去',
    targetDb: '目標dBFS:',
    encoderDetails: 'エンコーダ詳細',
    outputFormat: '出力形式',
    
    // Metadata Tab
    waveformAnalyzer: '波形アナライザー',
    noPeakScan: 'ピーク未スキャン',
    playAudit: '視聴開始',
    pauseAudit: '一時停止',
    titleLabel: 'タイトル (TITLE)',
    trackLabel: 'トラック (TRACK)',
    discLabel: 'ディスク (DISC)',
    artistLabel: 'アーティスト (ARTIST)',
    albumArtistLabel: 'アルバムアーティスト (ALBUM ARTIST)',
    albumLabel: 'アルバム (ALBUM)',
    yearLabel: 'リリース年 (YEAR)',
    genreLabel: 'ジャンル (GENRE)',
    metaWriteBtn: 'メタタグ書き込み',
    metaWriteDesc: '保存ボタンを押すと変更がファイルバッファヘッダーに書き込まれます。',
    metaSelectTrackDesc: 'テーブルのオーディオトラックを選択すると、波形の確認とID3メタタグの編集ができます。',
    
    // Quality Audit Tab & Badges
    qualityTitle: 'オーディオ品質＆データ欠損検証',
    qualitySelectTrackDesc: 'ファイルを選択すると、変換前後のデータ欠損および音質劣化の検証レポートを確認できます。',
    qualityBadgePerfect: '✨100%完全一致',
    qualityBadgePassed: '🟢品質正常',
    qualityBadgeWarning: '⚠️変化あり',
    qualityBadgeDegraded: '🔴劣化検出',
    reverifyBtn: '品質検証を再実行',
    verifyingText: 'データ欠損・音質検証中...',
    
    // Log Tab
    showDebugLogs: 'デバッグメッセージを表示',
    clearLogs: 'ログクリア',
    noLogs: 'ログ履歴はありません。',
    
    // Footer / Global
    globalPreset: 'グローバルプリセット:',
    normalizationLevel: '正規化レベル:',
    totalProgress: 'バッチ全体進捗',
    startBatchBtn: 'バッチ変換開始',
    cancelBtn: '処理中断',
    closeBtn: '閉じる',
    confirmClose: 'アプリケーションを終了しますか？',
    
    // Encoder settings modal
    encoderDetailSettings: 'エンコーダ詳細設定',
    samplingRate: 'サンプリングレート',
    channels: 'チャンネル数',
    bitrate: 'ビットレート',
    bitDepth: 'ビット深度',
    
    // Queue statuses
    statusQueued: '待機中',
    statusConverting: '変換中...',
    statusNormalizing: '正規化中...',
    statusCompleted: '完了',
    statusFailed: '失敗',
    
    // Messages & Modals
    skippedFilesTitle: 'スキップされたファイル一覧',
    skippedFilesDesc: '以下のファイルはデコードエラーのためスキップされました。',
    unsupportedFileDesc: 'デコードエラー: 未対応のコーデックか、破損したファイルです。',
    macHelp: 'ファイル名パターン:\n%title% 曲名 / %artist% アーティスト / %album% アルバム / %albumartist% アルバムアーティスト\n%track% / %track2% トラック番号（2 は 2 桁）/ %disc% / %disc2% ディスク番号\n%totaltracks% 総トラック数 / %year% 年 / %genre% ジャンル / %filename% 元のファイル名\n| で候補を区切ると、タグがそろう最初の候補を使います（例: %disc2%-%track2% %title%|%filename%）。\n\\ または / でフォルダを作れます（例: %artist%\\%album%\\%track2% %title%）。\n従来の {artist} などの書き方も使えます。',
    macHelpBtn: 'パターンヘルプ',
    dragDropText: '音声ファイルまたはフォルダをここにドラッグ＆ドロップしてキューに追加します',
    orText: 'または',
    emptyQueueText: '変換待ちのファイルはありません。上のボタンまたはドラッグ＆ドロップでファイルを追加してください。',
  },
  en: {
    // Title & Global
    appName: 'Audio Convert',
    
    // Import buttons
    addFiles: 'Add Files',
    addFolder: 'Add Folder',
    clearQueue: 'Clear Queue',
    resetQueueBtn: 'Reset Queue Status',
    resetQueueTooltip: 'Reset completed/failed file statuses to queued for re-conversion',
    sameAsSource: 'Same as Source (Lossless)',
    sameAsSourceHint: 'Keep original sample rate & bit depth, automatically bypassing normalization and scaling',
    
    // Bottom tabs
    tabSourceFile: 'Source File',
    tabMetadata: 'Metadata',
    tabQuality: 'Quality Audit',
    tabLog: 'Logs',
    
    // Columns
    colSourceName: 'Source Name',
    colOutputFormat: 'Output Format',
    colSize: 'Size',
    colDuration: 'Duration',
    colStatus: 'Status',
    colProgress: 'Progress',
    colActions: 'Actions',
    
    // Source File Tab
    outputPath: 'Output Path',
    moveSourceToBin: 'Trash source files upon completion',
    createSourceFolder: 'Save in source folder',
    keepFolders: 'Keep source folders:',
    splitImages: 'Split by CUE / chapters',
    mergeOutput: 'Merge into one file',
    mergeCreateCue: 'Create CUE',
    mergeOutputHelp: 'Joins the queued files, in order, into one file. Rate, channels, tags and cover follow the first file. With the quality check on, the originals go to the trash only if every part is bit-exact with its source.',
    splitImagesHelp: 'Added .cue files, and audio files with an embedded CUE sheet or chapters, are converted track by track (INDEX 00 ignored). The original goes to the trash only after all of its tracks are done.',
    vbrMode: 'VBR (quality)',
    cbrMode: 'CBR (fixed)',
    vbrBest: 'best',
    vbrDefault: 'default',
    vbrQualityHelp: 'LAME V level (0 = best). AAC uses the equivalent TVBR (V2 = TVBR 91), Vorbis the equivalent quality.',
    keepFoldersLast: 'last',
    keepFoldersFirst: 'first',
    keepFoldersLevels: 'levels',
    autoVerifyQuality: 'Auto-verify quality & data integrity after conversion',
    fileNamePattern: 'Filename pattern:',
    action: 'Action',
    outputSettings: 'Output Settings',
    normalize: 'Normalize',
    tempo: 'Tempo',
    fade: 'Fade In/Out',
    trimSilence: 'Trim Silence',
    targetDb: 'Target dBFS:',
    encoderDetails: 'Encoder Settings',
    outputFormat: 'Output Format',
    
    // Metadata Tab
    waveformAnalyzer: 'Waveform Analyzer',
    noPeakScan: 'No Peak scan',
    playAudit: 'PLAY AUDIT',
    pauseAudit: 'PAUSE AUDIT',
    titleLabel: 'Title (TITLE)',
    trackLabel: 'Track (TRACK)',
    discLabel: 'Disc (DISC)',
    artistLabel: 'Artist (ARTIST)',
    albumArtistLabel: 'Album Artist (ALBUM ARTIST)',
    albumLabel: 'Album (ALBUM)',
    yearLabel: 'Year (YEAR)',
    genreLabel: 'Genre (GENRE)',
    metaWriteBtn: 'Save Tags',
    metaWriteDesc: 'Click save to apply changes to file buffer header.',
    metaSelectTrackDesc: 'Select a track to audit waveform and edit ID3 tags.',
    
    // Quality Audit Tab & Badges
    qualityTitle: 'Audio Quality & Data Loss Verification',
    qualitySelectTrackDesc: 'Select a file to inspect data loss and quality audit reports.',
    qualityBadgePerfect: '✨100% Exact Match',
    qualityBadgePassed: '🟢Passed',
    qualityBadgeWarning: '⚠️Changed',
    qualityBadgeDegraded: '🔴Degraded',
    reverifyBtn: 'Re-run Verification',
    verifyingText: 'Verifying quality & integrity...',
    
    // Log Tab
    showDebugLogs: 'Show debug messages',
    clearLogs: 'Clear logs',
    noLogs: 'No log history.',
    
    // Footer / Global
    globalPreset: 'Global Preset:',
    normalizationLevel: 'Normalization:',
    totalProgress: 'Total Progress',
    startBatchBtn: 'Start Batch',
    cancelBtn: 'Cancel',
    closeBtn: 'Close',
    confirmClose: 'Do you want to exit the application?',
    
    // Encoder settings modal
    encoderDetailSettings: 'Encoder Detail Settings',
    samplingRate: 'Sampling Rate',
    channels: 'Channels',
    bitrate: 'Bitrate',
    bitDepth: 'Bit Depth',
    
    // Queue statuses
    statusQueued: 'Queued',
    statusConverting: 'Converting...',
    statusNormalizing: 'Normalizing...',
    statusCompleted: 'Completed',
    statusFailed: 'Failed',
    
    // Messages & Modals
    skippedFilesTitle: 'Skipped Files List',
    skippedFilesDesc: 'The following files were skipped due to decoding errors.',
    unsupportedFileDesc: 'Decode error: Unsupported codec or corrupted file.',
    macHelp: 'File name pattern:\n%title% / %artist% / %album% / %albumartist%\n%track% / %track2% track number (2 = zero-padded) / %disc% / %disc2% disc number\n%totaltracks% / %year% / %genre% / %filename% source file name\nSeparate alternatives with |; the first one whose tags all exist is used (e.g. %disc2%-%track2% %title%|%filename%).\nA \\ or / makes a subfolder (e.g. %artist%\\%album%\\%track2% %title%).\nThe older {artist} style still works.',
    macHelpBtn: 'Pattern Help',
    dragDropText: 'Drag & drop audio files or folders here to queue',
    orText: 'or',
    emptyQueueText: 'No files in queue. Click buttons above or drag & drop files here to add.',
  }
};

export type Language = 'ja' | 'en';
export type TranslationKey = keyof typeof translations.ja;

export function t(lang: Language, key: TranslationKey): string {
  const dict = translations[lang] || translations.ja;
  return dict[key] || translations.ja[key] || String(key);
}
