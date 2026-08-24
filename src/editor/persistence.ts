import { SerializedScene } from '../scene/Scene';

/**
 * Local persistence: preferences, the recent-file list and a crash-recovery
 * autosave. All of it is best-effort — storage can be full, disabled or
 * unavailable (a file:// page, a private window), and none of that is worth
 * interrupting the user over, so every path degrades to "no saved state".
 */

const PREFS_KEY = 'kiln.preferences';
const AUTOSAVE_KEY = 'kiln.autosave';
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

export interface AutosaveRecord {
  savedAt: number;
  name: string;
  scene: SerializedScene;
}

export interface AutosaveResult {
  ok: boolean;
  reason?: string;
  bytes?: number;
}

export function writeAutosave(scene: SerializedScene, name: string): AutosaveResult {
  const s = storage();
  if (!s) return { ok: false, reason: 'Local storage is unavailable' };
  const payload = JSON.stringify({ savedAt: Date.now(), name, scene } satisfies AutosaveRecord);
  try {
    s.setItem(AUTOSAVE_KEY, payload);
    return { ok: true, bytes: payload.length };
  } catch {
    // Almost always the quota: embedded textures make a scene very large.
    try {
      s.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'Scene is too large to autosave locally', bytes: payload.length };
  }
}

export function readAutosave(): AutosaveRecord | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as AutosaveRecord;
    return rec && rec.scene ? rec : null;
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  const s = storage();
  try {
    s?.removeItem(AUTOSAVE_KEY);
  } catch {
    /* ignore */
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

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
