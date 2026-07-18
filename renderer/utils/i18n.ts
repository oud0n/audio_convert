export const translations = {
  ja: {
    // Title & Global
    appName: 'Audio Convert',
    
    // Import buttons
    addFiles: 'ファイル追加',
    addFolder: 'フォルダ追加',
    clearQueue: 'キュークリア',
    
    // Bottom tabs
    tabSourceFile: 'ソースファイル',
    tabMetadata: 'メタデータ',
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
    macHelp: '使用可能なパターンマクロ:\n{artist} - アーティスト名\n{albumArtist} - アルバムアーティスト名\n{title} - タイトル\n{album} - アルバム名\n{disc} - ディスク番号\n{track} - トラック番号\n{year} - リリース年\n{genre} - ジャンル',
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
    
    // Bottom tabs
    tabSourceFile: 'Source File',
    tabMetadata: 'Metadata',
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
    macHelp: 'Available pattern macros:\n{artist} - Artist\n{albumArtist} - Album Artist\n{title} - Title\n{album} - Album\n{disc} - Disc Number\n{track} - Track Number\n{year} - Year\n{genre} - Genre',
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
