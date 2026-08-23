/** Compact geometric icons drawn as inline SVG paths on a 24x24 grid. */

const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS: Record<string, string> = {
  move: wrap('<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>'),
  rotate: wrap('<path d="M20 12a8 8 0 1 1-2.7-6"/><path d="M20 4v4h-4"/>'),
  scale: wrap('<rect x="4" y="12" width="8" height="8"/><path d="M14 10V4h-6M20 4l-8 8"/>'),
  extrude: wrap('<path d="M4 14h8v6H4zM8 10h8v6"/><path d="M18 8V2m0 0-2.5 2.5M18 2l2.5 2.5"/>'),
  inset: wrap('<rect x="3" y="3" width="18" height="18"/><rect x="7.5" y="7.5" width="9" height="9"/>'),
  loopcut: wrap('<rect x="3" y="4" width="18" height="16"/><path d="M12 4v16" stroke-dasharray="2 2.5"/>'),
  subdivide: wrap('<rect x="3" y="3" width="18" height="18"/><path d="M12 3v18M3 12h18"/>'),
  merge: wrap('<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 7l10 4M7 17l10-4"/>'),
  del: wrap('<path d="M5 5l14 14M19 5L5 19"/>'),
  add: wrap('<path d="M12 4v16M4 12h16"/>'),
  vertex: wrap('<rect x="4" y="4" width="16" height="16"/><circle cx="4" cy="4" r="1.8" fill="currentColor"/><circle cx="20" cy="4" r="1.8" fill="currentColor"/><circle cx="4" cy="20" r="1.8" fill="currentColor"/><circle cx="20" cy="20" r="1.8" fill="currentColor"/>'),
  edge: wrap('<rect x="4" y="4" width="16" height="16"/><path d="M4 20h16" stroke-width="3"/>'),
  face: wrap('<rect x="4" y="4" width="16" height="16"/><rect x="4" y="4" width="16" height="16" fill="currentColor" opacity="0.35" stroke="none"/>'),
  solid: wrap('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" opacity="0.8"/>'),
  material: wrap('<circle cx="12" cy="12" r="8"/><circle cx="9" cy="9" r="2.5" fill="currentColor" stroke="none" opacity="0.6"/>'),
  wireframe: wrap('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4v16M6 6l12 12M18 6L6 18"/>'),
  xray: wrap('<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>'),
  eye: wrap('<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: wrap('<path d="M4 4l16 16"/><path d="M9.5 5.4A9.7 9.7 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.3 3.7M6.6 7.6A17 17 0 0 0 2 12s4 6 10 6a9.6 9.6 0 0 0 3.4-.6"/>'),
  mesh: wrap('<path d="M12 2l9 5.5v9L12 22l-9-5.5v-9z"/><path d="M12 22V12l9-4.5M12 12L3 7.5"/>'),
  light: wrap('<circle cx="12" cy="10" r="4"/><path d="M12 2v2M12 16v2M4 10H2M22 10h-2M5.5 3.5 4 2M18.5 3.5 20 2M9.5 20h5"/>'),
  camera: wrap('<path d="M3 7h11v10H3z"/><path d="M14 11l7-4v10l-7-4z"/>'),
  empty: wrap('<path d="M12 4v16M4 12h16M7 7l10 10M17 7L7 17"/>'),
  modifier: wrap('<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="10" cy="17" r="2" fill="currentColor" stroke="none"/>'),
  world: wrap('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>'),
  smooth: wrap('<path d="M3 16c4 0 5-8 9-8s5 8 9 8"/>'),
  reference: wrap('<rect x="2.5" y="4" width="13" height="11" rx="1"/><path d="M2.5 12l3.5-3.5 3 3 2-2 4 4"/><circle cx="6.5" cy="7.5" r="1.1"/><path d="M13 17.5l4.5 2.6 4-2.3v-5.2l-4-2.3-4 2.3v4.9z"/>'),
};

export function icon(name: keyof typeof ICONS | string, className = 'icon'): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.innerHTML = ICONS[name] ?? '';
  return span;
}
