import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AppBridge } from '../services/bridge';
import { X, Coffee, ExternalLink, Copy, Check, Heart, Star, Smartphone, Sparkles } from './Icons';

interface DonateModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: 'ja' | 'en';
}

const BUY_ME_A_COFFEE_URL = 'https://buymeacoffee.com/oud0n';
const GITHUB_REPO_URL = 'https://github.com/oud0n/audio_convert';

/** "Support the developer" (Buy Me a Coffee), as in ds_universal. */
export const DonateModal: React.FC<DonateModalProps> = ({ isOpen, onClose, lang }) => {
  const [copied, setCopied] = useState(false);
  const ja = lang === 'ja';

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const open = (url: string) => {
    AppBridge.openExternal(url).catch((e) => console.warn('Cannot open the link:', e));
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(BUY_ME_A_COFFEE_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn('Cannot copy to the clipboard:', e);
    }
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-xl flex flex-col shadow-2xl overflow-hidden my-auto text-zinc-200 select-text">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-400/20 border border-amber-400/40 flex items-center justify-center text-amber-400">
              <Coffee className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-1.5">
                {ja ? '開発者を支援' : 'Support the developer'} <span className="text-xs font-normal text-amber-400">（Buy Me a Coffee）</span>
              </h2>
              <p className="text-[11px] text-zinc-400">
                {ja ? 'Audio Convert の継続的な開発・検証を応援していただけます' : 'Help keep Audio Convert developed and tested'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-fg hover:bg-zinc-800 transition-colors cursor-pointer"
            aria-label={ja ? '閉じる' : 'Close'}
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          <div className="bg-gradient-to-r from-zinc-800 to-zinc-900 border border-zinc-700 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
              <Sparkles className="h-[15px] w-[15px] text-amber-400" />
              <span>{ja ? 'いつもご利用ありがとうございます！' : 'Thank you for using the app!'}</span>
            </div>
            <p className="text-xs text-zinc-300 leading-relaxed">
              {ja ? (
                <>
                  <strong className="text-fg">Audio Convert（audio_convert）</strong>
                  は、個人が休日や夜間に開発している、無料でソースコードを公開しているソフトウェアです。
                  xrecode 互換の変換、ロスレスのビット一致検証、CUE 分割や DSD 対応などの継続開発をサポートしていただけると大変励みになります☕🎧
                </>
              ) : (
                <>
                  <strong className="text-fg">Audio Convert (audio_convert)</strong>
                  {' '}is free, source-available software developed in my spare time.
                  Your support keeps xrecode-compatible conversion, bit-exact lossless checks, CUE splitting and DSD support moving forward ☕🎧
                </>
              )}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-stretch">
            {/* Button and URL */}
            <div className="md:col-span-3 flex flex-col justify-between space-y-3 bg-zinc-950 border border-zinc-800 rounded-xl p-4">
              <div>
                <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block mb-1">
                  {ja ? 'PC / デスクトップから支援' : 'From your computer'}
                </span>
                <p className="text-xs text-zinc-300 mb-3">
                  {ja
                    ? 'ブラウザで Buy Me a Coffee のページを開き、コーヒー1杯（$3〜）から直接支援できます。'
                    : 'Opens the Buy Me a Coffee page in your browser; support starts at one coffee ($3).'}
                </p>
              </div>

              <button
                onClick={() => open(BUY_ME_A_COFFEE_URL)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#FFDD00] hover:bg-[#ffe333] active:bg-[#e6c700] text-black font-extrabold text-sm transition-all shadow-md cursor-pointer group"
              >
                <Coffee className="h-[18px] w-[18px] text-black group-hover:scale-110 transition-transform" />
                <span>{ja ? 'Buy Me a Coffee で支援する' : 'Support on Buy Me a Coffee'}</span>
                <ExternalLink className="h-3.5 w-3.5 opacity-70 group-hover:opacity-100 transition-opacity ml-1" />
              </button>

              <div className="pt-2">
                <span className="text-[10px] text-zinc-400 block mb-1">{ja ? 'URLを直接共有・保存:' : 'Share or save the link:'}</span>
                <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-700 rounded-lg p-1.5 text-xs font-mono">
                  <span className="flex-1 truncate text-zinc-300 px-1 select-all">{BUY_ME_A_COFFEE_URL}</span>
                  <button
                    onClick={handleCopyUrl}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      copied ? 'bg-emerald-600 text-white' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                    }`}
                    title={ja ? 'URLをクリップボードにコピー' : 'Copy the link'}
                  >
                    {copied ? (
                      <>
                        <Check className="h-3 w-3" />
                        <span>{ja ? 'コピー完了' : 'Copied'}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>{ja ? 'コピー' : 'Copy'}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* QR code for phones */}
            <div className="md:col-span-2 flex flex-col items-center justify-center bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-center">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-400 mb-2">
                <Smartphone className="h-[13px] w-[13px] text-amber-400" />
                <span>{ja ? 'スマホから支援' : 'From your phone'}</span>
              </div>
              <div className="p-2.5 bg-[#ffffff] rounded-xl shadow-lg border border-zinc-300 flex items-center justify-center">
                <QRCodeSVG value={BUY_ME_A_COFFEE_URL} size={128} bgColor="#ffffff" fgColor="#000000" level="M" includeMargin={false} />
              </div>
              <p className="text-[10px] text-zinc-400 mt-2.5 leading-tight">
                {ja ? 'スマホのカメラでスキャンして手軽に支援いただけます' : 'Scan with your phone camera'}
              </p>
            </div>
          </div>

          {/* What the support is used for */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 space-y-2">
            <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5">
              <Heart className="h-[13px] w-[13px] text-red-400" />
              {ja ? 'ご支援金の主な使い道' : 'What your support pays for'}
            </h4>
            <ul className="text-xs text-zinc-400 space-y-1.5 pl-1">
              <li className="flex items-start gap-2">
                <span>🎧</span>
                <span>{ja ? '検証用の音源・オーディオ機器（DAC など）の購入' : 'Test recordings and audio gear (DACs and more)'}</span>
              </li>
              <li className="flex items-start gap-2">
                <span>🛠️</span>
                <span>{ja ? 'FFmpeg など同梱ツールのビルド・更新' : 'Building and updating the bundled tools such as FFmpeg'}</span>
              </li>
              <li className="flex items-start gap-2">
                <span>💻</span>
                <span>{ja ? 'Windows / macOS / Linux 対応・自動ビルド環境の整備' : 'Windows / macOS / Linux support and automated builds'}</span>
              </li>
            </ul>
          </div>

          {/* Other ways to help */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-3 py-2.5 bg-zinc-900/50 rounded-xl border border-zinc-800 text-xs text-zinc-400">
            <div className="flex items-center gap-2">
              <Star className="h-[15px] w-[15px] text-amber-400" />
              <span>{ja ? 'GitHubでのStar ⭐ や不具合報告・フィードバックも大歓迎です！' : 'Stars ⭐, bug reports and feedback on GitHub are very welcome!'}</span>
            </div>
            <button
              onClick={() => open(GITHUB_REPO_URL)}
              className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 font-medium hover:underline cursor-pointer"
            >
              <span>{ja ? 'GitHubリポジトリ' : 'GitHub repository'}</span>
              <ExternalLink className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-zinc-800 bg-zinc-950">
          <span className="text-[11px] text-zinc-400 flex items-center gap-1">
            Creator ID: <span className="font-mono font-bold text-amber-300">oud0n</span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            {ja ? '閉じる' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};
