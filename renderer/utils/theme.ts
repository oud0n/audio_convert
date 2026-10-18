import { useSyncExternalStore } from 'react';

// Screen theme (as in ds_universal). "system" follows the OS (light / dark).
export type ThemeSetting = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

// Kept in this computer's web storage (pages/_document.tsx reads the same key before
// the page draws, so the first frame already has the right colors).
const STORAGE_KEY = 'ac_theme';

const hasWindow = typeof window !== 'undefined';
// Light only when the OS asks for it (dark otherwise), like _document.tsx.
const lightQuery = hasWindow && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function loadSetting(): ThemeSetting {
  try {
    const v = hasWindow ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // Storage unavailable: keep the default.
  }
  return 'system';
}

let setting: ThemeSetting = loadSetting();
let resolved: ResolvedTheme = resolve(setting);
const listeners = new Set<() => void>();

function resolve(s: ThemeSetting): ResolvedTheme {
  if (s === 'system') return lightQuery?.matches ? 'light' : 'dark';
  return s;
}

/** The window frame (title bar) follows the theme too in the desktop app. */
function applyWindowTheme(s: ThemeSetting) {
  if (!hasWindow || !('__TAURI_INTERNALS__' in window)) return;
  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(s === 'system' ? null : s))
    .catch(() => {});
}

function apply() {
  resolved = resolve(setting);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.classList.toggle('light', resolved === 'light');
    root.classList.toggle('dark', resolved === 'dark');
  }
  applyWindowTheme(setting);
  listeners.forEach(l => l());
}

if (hasWindow) {
  apply();
  // In "system", follow the OS as soon as it changes.
  lightQuery?.addEventListener('change', () => {
    if (setting === 'system') apply();
  });
}

export function setThemeSetting(s: ThemeSetting) {
  setting = s;
  try {
    window.localStorage.setItem(STORAGE_KEY, s);
  } catch {
    // Not saved, but this screen still switches.
  }
  apply();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The chosen theme (light / dark / system). */
export function useThemeSetting(): ThemeSetting {
  return useSyncExternalStore(subscribe, () => setting, () => 'system');
}

/** The theme on screen (light / dark); canvases redraw when it changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolved, () => 'dark');
}

/** Colors for canvas drawing (--ac-canvas-* in styles/globals.css), read at draw time. */
export function canvasColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(`--ac-canvas-${name}`).trim();
  return { bg: v('bg'), text: v('text'), grid: v('grid'), axis: v('axis'), wave: v('wave'), played: v('played'), note: v('note'), playhead: v('playhead') };
}
