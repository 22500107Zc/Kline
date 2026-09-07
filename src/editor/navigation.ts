/**
 * Viewport navigation: turning input events into camera gestures.
 *
 * Split out of the editor because the interesting part is the mapping, not
 * the plumbing, and the mapping is where trackpads go wrong. A mouse reports
 * one wheel event per detent with a delta of about 100. A MacBook trackpad
 * reports a two-finger scroll as a stream of sixty-odd events a second, each
 * a handful of pixels, and keeps sending them after the fingers lift because
 * of momentum. Code that treats one event as one zoom step is fine with the
 * mouse and unusable with the trackpad: a single flick arrives as a hundred
 * steps and the camera ends up inside the model, or a mile away from it.
 *
 * So every gesture here is measured in pixels of finger travel, and the wheel
 * is normalised into pixels first. A detent then works out to one step, and a
 * trackpad glide to a smooth continuous one, from the same numbers.
 */

/** The device buttons and keys, as the DOM reports them. */
export interface NavModifiers {
  alt: boolean;
  shift: boolean;
  /** Control or Command — either is the zoom modifier. */
  ctrl: boolean;
}

export type NavMode = 'orbit' | 'pan' | 'zoom';

export type NavGesture =
  | { kind: 'orbit'; dx: number; dy: number }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; amount: number };

/** Radians of rotation per pixel of drag. */
export const ORBIT_PER_PIXEL = 0.008;
/** Radians of rotation per pixel of two-finger scroll — a shade gentler. */
export const ORBIT_PER_SCROLL_PIXEL = 0.006;
/** Pixels of scroll that make one zoom step, which is 10% of the distance. */
export const PIXELS_PER_ZOOM_STEP = 100;
/** Pinch and Ctrl+scroll are reported far smaller, so they count for more. */
export const PIXELS_PER_PINCH_STEP = 25;

export function modifiersOf(e: { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): NavModifiers {
  return { alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
}

/**
 * What a press begins, or null if it is not a navigation press at all.
 *
 * The middle button is the mouse idiom. Option with the left button is the
 * same thing for a trackpad, which has no middle button to hold — a laptop is
 * the machine most people will try this on first, and until this existed
 * there was simply no way to turn the view on one.
 */
export function navModeForPress(button: number, m: NavModifiers): NavMode | null {
  if (button !== 1 && !(button === 0 && m.alt)) return null;
  if (m.shift) return 'pan';
  if (m.ctrl) return 'zoom';
  return 'orbit';
}

/**
 * The gesture a latched press drag produces. `dx`/`dy` are pixels moved.
 *
 * The mode is decided once, when the press lands, and then held for the whole
 * drag. Reading the modifiers afresh on every move sounds equivalent and is
 * not: letting go of Shift half way through a pan used to turn the rest of the
 * drag into an orbit, and letting go of Option turned it into a box select
 * that wiped the selection on release.
 */
export function pressGesture(mode: NavMode, dx: number, dy: number): NavGesture {
  switch (mode) {
    case 'pan': return { kind: 'pan', dx, dy };
    case 'zoom': return { kind: 'zoom', amount: -dy * 0.02 };
    case 'orbit': return { kind: 'orbit', dx: dx * ORBIT_PER_PIXEL, dy: dy * ORBIT_PER_PIXEL };
  }
}

/** A wheel event's deltas in pixels, whatever unit the device chose to use. */
export function wheelPixels(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  viewportHeight: number,
): { x: number; y: number } {
  // deltaMode 1 counts lines and 2 counts pages. Firefox uses lines for a
  // plain mouse wheel, so without this a wheel there moves a thirtieth of
  // what the same wheel moves in Chrome.
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, viewportHeight) : 1;
  const x = Number.isFinite(e.deltaX) ? e.deltaX * scale : 0;
  const y = Number.isFinite(e.deltaY) ? e.deltaY * scale : 0;
  return { x, y };
}

function clampAmount(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

/**
 * The gesture a scroll produces.
 *
 * Two fingers moving right on the pad read as a negative `deltaX`, the same
 * way they scroll a page's content right, so the signs are flipped to make a
 * scroll gesture push the view the way the fingers went — matching what the
 * same movement does while dragging.
 */
export function wheelGesture(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  m: NavModifiers,
  viewportHeight: number,
): NavGesture {
  const p = wheelPixels(e, viewportHeight);

  // Option with a two-finger scroll orbits. This is the gesture that makes a
  // laptop enough on its own: no button to hold down, no second hand, and it
  // works the same on a pad that clicks and one that does not.
  if (m.alt) {
    return { kind: 'orbit', dx: -p.x * ORBIT_PER_SCROLL_PIXEL, dy: -p.y * ORBIT_PER_SCROLL_PIXEL };
  }
  if (m.shift) return { kind: 'pan', dx: -p.x, dy: -p.y };
  if (m.ctrl) {
    // A trackpad pinch reaches the page as a wheel event with ctrlKey set,
    // reporting a few units per frame rather than a detent's hundred.
    return { kind: 'zoom', amount: clampAmount(-p.y / PIXELS_PER_PINCH_STEP, 1) };
  }
  return { kind: 'zoom', amount: clampAmount(-p.y / PIXELS_PER_ZOOM_STEP, 2) };
}
