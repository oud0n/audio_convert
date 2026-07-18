import React from 'react';
import { useAudioConverter } from '../context/AudioConverterContext';
import { CheckCircle2, AlertCircle, Info, X } from './Icons';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { toast, setToast } = useAudioConverter();
  
  return (
    <div id="root-container" className="flex h-screen bg-zinc-950 font-sans text-zinc-100 select-none overflow-hidden antialiased">
      {/* Main Panel Viewport */}
      <main className="flex-1 flex flex-col justify-between overflow-hidden relative">
        {children}
      </main>

      {/* Floating Interactive Toast notifications */}
      {toast && (
        <div
          id="toast-notification"
          className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3.5 rounded-xl border shadow-xl max-w-sm animate-bounce text-xs font-medium ${
            toast.type === 'success'
              ? 'bg-emerald-950/95 text-emerald-400 border-emerald-500/30 shadow-emerald-950/40'
              : toast.type === 'error'
              ? 'bg-rose-950/95 text-rose-400 border-rose-500/30 shadow-rose-950/40'
              : 'bg-zinc-900/95 text-zinc-300 border-zinc-800 shadow-zinc-950/50'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="h-4.5 w-4.5 text-emerald-400 shrink-0" />}
          {toast.type === 'error' && <AlertCircle className="h-4.5 w-4.5 text-rose-400 shrink-0" />}
          {toast.type === 'info' && <Info className="h-4.5 w-4.5 text-emerald-400 shrink-0" />}
          
          <div className="flex-1 leading-normal font-mono">{toast.message}</div>
          
          <button onClick={() => setToast(null)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
