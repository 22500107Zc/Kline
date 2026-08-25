/**
 * Local persistence: preferences and the recent-file list. Both are small and
 * both are best-effort — storage can be full, disabled or unavailable (a
 * file:// page, a private window), and none of that is worth interrupting the
 * user over, so every path degrades to "no saved state".
 *
 * Crash recovery used to live here too. It outgrew `localStorage` and moved to
 * `recovery.ts`, which uses IndexedDB.
 */

const PREFS_KEY = 'kiln.preferences';
const RECENT_KEY = 'kiln.recent';

export interface Preferences {
  theme: 'dark' | 'light';
  showGrid: boolean;
  showOverlays: boolean;
  autosaveEnabled: boolean;
  autosaveSeconds: number;
  snapIncrement: number;
  proportionalFalloff: string;
  renderSamples: number;
  renderWidth: number;
  renderHeight: number;
}

export function defaultPreferences(): Preferences {
  return {
    theme: 'dark',
    showGrid: true,
    showOverlays: true,
    autosaveEnabled: true,
    autosaveSeconds: 60,
    snapIncrement: 0.25,
    proportionalFalloff: 'smooth',
    renderSamples: 128,
    renderWidth: 960,
    renderHeight: 540,
  };
}

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    // Safari in private mode hands back an object that throws on write.
    const probe = '__kiln_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function loadPreferences(): Preferences {
  const s = storage();
  if (!s) return defaultPreferences();
  try {
    const raw = s.getItem(PREFS_KEY);
    if (!raw) return defaultPreferences();
    return { ...defaultPreferences(), ...JSON.parse(raw) };
  } catch {
    return defaultPreferences();
  }
}

export function savePreferences(p: Preferences): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* nothing useful to do if preferences will not fit */
  }
}

export interface RecentEntry {
  name: string;
  openedAt: number;
}

export function recentFiles(): RecentEntry[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

export function noteRecentFile(name: string): void {
  const s = storage();
  if (!s) return;
  try {
    const list = recentFiles().filter((r) => r.name !== name);
    list.unshift({ name, openedAt: Date.now() });
    s.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* ignore */
  }
}
