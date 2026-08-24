import { Vec3 } from '../core/math';

/**
 * Keyframe animation.
 *
 * One channel per animated scalar — nine per object at most — each holding a
 * sorted key list. Keeping channels independent is what makes it possible to
 * key location on one frame and rotation on another, which is how animators
 * actually work.
 */

export type Interpolation = 'constant' | 'linear' | 'bezier';
export type ChannelPath = 'position' | 'rotation' | 'scale';

export interface Keyframe {
  frame: number;
  value: number;
  interp: Interpolation;
}

export interface Channel {
  path: ChannelPath;
  /** 0 = x, 1 = y, 2 = z. */
  index: number;
  keys: Keyframe[];
}

export interface TimelineSettings {
  start: number;
  end: number;
  fps: number;
  current: number;
  playing: boolean;
  loop: boolean;
}

export function defaultTimeline(): TimelineSettings {
  return { start: 1, end: 120, fps: 24, current: 1, playing: false, loop: true };
}

export const CHANNEL_LABELS: Record<ChannelPath, string> = {
  position: 'Location',
  rotation: 'Rotation',
  scale: 'Scale',
};

function findChannel(channels: Channel[], path: ChannelPath, index: number): Channel | undefined {
  return channels.find((c) => c.path === path && c.index === index);
}

/** Insert or replace a key, keeping the list sorted by frame. */
export function setKey(
  channels: Channel[], path: ChannelPath, index: number, frame: number,
  value: number, interp: Interpolation = 'bezier',
): Channel {
  let ch = findChannel(channels, path, index);
  if (!ch) {
    ch = { path, index, keys: [] };
    channels.push(ch);
  }
  const f = Math.round(frame);
  const existing = ch.keys.find((k) => k.frame === f);
  if (existing) {
    existing.value = value;
    existing.interp = interp;
  } else {
    ch.keys.push({ frame: f, value, interp });
    ch.keys.sort((a, b) => a.frame - b.frame);
  }
  return ch;
}

export function removeKey(channels: Channel[], frame: number, path?: ChannelPath): number {
  const f = Math.round(frame);
  let removed = 0;
  for (const ch of channels) {
    if (path && ch.path !== path) continue;
    const before = ch.keys.length;
    ch.keys = ch.keys.filter((k) => k.frame !== f);
    removed += before - ch.keys.length;
  }
  // Drop channels that no longer hold anything.
  for (let i = channels.length - 1; i >= 0; i--) if (channels[i].keys.length === 0) channels.splice(i, 1);
  return removed;
}

/** Every frame that carries at least one key, ascending. */
export function keyFrames(channels: Channel[]): number[] {
  const set = new Set<number>();
  for (const ch of channels) for (const k of ch.keys) set.add(k.frame);
  return [...set].sort((a, b) => a - b);
}

/**
 * Auto tangent for a bezier key, Catmull-Rom style but flattened at local
 * extrema so an eased value never overshoots past its own keys.
 */
function autoSlope(keys: Keyframe[], i: number): number {
  const cur = keys[i];
  const prev = keys[i - 1];
  const next = keys[i + 1];
  if (!prev || !next) {
    const other = prev ?? next;
    if (!other) return 0;
    const df = cur.frame - other.frame;
    return df === 0 ? 0 : (cur.value - other.value) / df;
  }
  const dPrev = cur.value - prev.value;
  const dNext = next.value - cur.value;
  if (dPrev * dNext <= 0) return 0;
  const span = next.frame - prev.frame;
  return span === 0 ? 0 : (next.value - prev.value) / span;
}

export function sampleChannel(ch: Channel, frame: number): number | null {
  const keys = ch.keys;
  if (keys.length === 0) return null;
  if (frame <= keys[0].frame) return keys[0].value;
  if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value;

  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const t = (frame - a.frame) / span;
  if (a.interp === 'constant') return a.value;
  if (a.interp === 'linear') return a.value + (b.value - a.value) * t;

  // Cubic Hermite with auto tangents.
  const m0 = autoSlope(keys, lo) * span;
  const m1 = autoSlope(keys, hi) * span;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * a.value
    + (t3 - 2 * t2 + t) * m0
    + (-2 * t3 + 3 * t2) * b.value
    + (t3 - t2) * m1
  );
}

export interface SampledTransform {
  position: Vec3 | null;
  rotation: Vec3 | null;
  scale: Vec3 | null;
}

/**
 * Sample all channels at a frame. A component with no channel comes back
 * untouched so a partly animated object keeps its authored values.
 */
export function sampleChannels(channels: Channel[], frame: number): SampledTransform {
  const out: SampledTransform = { position: null, rotation: null, scale: null };
  for (const ch of channels) {
    const v = sampleChannel(ch, frame);
    if (v === null) continue;
    const key = ch.path;
    if (!out[key]) out[key] = key === 'scale' ? new Vec3(1, 1, 1) : new Vec3();
    const target = out[key]!;
    if (ch.index === 0) target.x = v;
    else if (ch.index === 1) target.y = v;
    else target.z = v;
  }
  return out;
}

/**
 * Fill in components a channel set does not cover, so the caller can assign
 * the result wholesale without losing unkeyed axes.
 */
export function completeTransform(
  sampled: SampledTransform, current: { position: Vec3; rotation: Vec3; scale: Vec3 },
  channels: Channel[],
): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const pick = (path: ChannelPath, from: Vec3 | null, fallback: Vec3): Vec3 => {
    if (!from) return fallback;
    const out = fallback.clone();
    for (const axis of [0, 1, 2]) {
      if (!findChannel(channels, path, axis)) continue;
      if (axis === 0) out.x = from.x;
      else if (axis === 1) out.y = from.y;
      else out.z = from.z;
    }
    return out;
  };
  return {
    position: pick('position', sampled.position, current.position),
    rotation: pick('rotation', sampled.rotation, current.rotation),
    scale: pick('scale', sampled.scale, current.scale),
  };
}

export function cloneChannels(channels: Channel[]): Channel[] {
  return channels.map((c) => ({ path: c.path, index: c.index, keys: c.keys.map((k) => ({ ...k })) }));
}

/** Shift every key by a whole number of frames. */
export function offsetKeys(channels: Channel[], delta: number): void {
  for (const ch of channels) {
    for (const k of ch.keys) k.frame += Math.round(delta);
    ch.keys.sort((a, b) => a.frame - b.frame);
  }
}
