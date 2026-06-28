/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useRouter } from 'next/router';
import Link from 'next/link';
import { Music, Sliders, Volume2, Info, Activity } from './Icons';

interface SidebarProps {
  pendingCount: number;
  convertingCount: number;
}

export default function Sidebar({ pendingCount, convertingCount }: SidebarProps) {
  const router = useRouter();

  const navItems = [
    {
      path: '/home',
      label: 'Batch Converter',
      icon: Music,
      badge: pendingCount > 0 ? pendingCount : undefined,
      badgeColor: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    },
    {
      path: '/settings',
      label: 'Encoder Settings',
      icon: Sliders,
    },
    {
      path: '/editor',
      label: 'Waveform & Tags',
      icon: Activity,
    },
  ];

  return (
    <div id="app-sidebar" className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col justify-between h-full select-none text-zinc-300">
      <div className="p-5 flex flex-col gap-6">
        {/* Brand Header */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-emerald-600 flex items-center justify-center text-white shadow-lg shadow-emerald-950/40 border border-emerald-500/30">
            <Volume2 className="h-5 w-5 animate-pulse" />
          </div>
          <div>
            <h1 className="font-sans font-bold text-white tracking-tight leading-none text-lg">X-Conv</h1>
            <span className="font-mono text-[10px] text-zinc-500 tracking-wider">AUDIO SUITE v3.1</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex flex-col gap-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = router.pathname === item.path;
            return (
              <Link
                href={item.path}
                id={`sidebar-tab-${item.path.slice(1)}`}
                key={item.path}
                className={`flex items-center justify-between w-full px-3 py-2.5 rounded-lg transition-all duration-200 group text-left ${
                  isActive
                    ? 'bg-emerald-600/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-950/20'
                    : 'hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon className={`h-4.5 w-4.5 transition-transform duration-200 group-hover:scale-105 ${isActive ? 'text-emerald-400' : 'text-zinc-500'}`} />
                  <span className="text-sm font-medium">{item.label}</span>
                </div>
                {item.badge !== undefined && (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${item.badgeColor}`}>
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Footer Info Box */}
      <div className="p-4 m-4 bg-zinc-950/60 border border-zinc-800/60 rounded-xl">
        <div className="flex items-start gap-2.5">
          <Info className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <p className="text-[11px] font-medium text-zinc-300">Browser Audio Sandbox</p>
            <p className="text-[10px] leading-normal text-zinc-500 font-mono">
              Lossless PCM generation and resampling run directly on device via Web Audio API. Zero server upload needed.
            </p>
          </div>
        </div>
        <div className="mt-3 pt-2.5 border-t border-zinc-800/80 flex items-center justify-between">
          <span className="text-[10px] font-mono text-zinc-500">FFmpeg Cluster</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-[10px] font-mono text-emerald-400">READY</span>
          </span>
        </div>
      </div>
    </div>
  );
}
