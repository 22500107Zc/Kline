/**
 * Turning a picture into outlines.
 *
 * A reference image becomes a binary mask, the mask becomes closed contours via
 * marching squares, and the contours get simplified before anything downstream
 * builds geometry from them. Every function here is pure and works on plain
 * arrays, so it runs in a worker, in Node, or in a unit test.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major from the top-left. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface Mask {
  width: number;
  height: number;
  /** One byte per pixel: 1 inside the shape, 0 outside. */
  data: Uint8Array;
}

export type Point = [number, number];

export interface Loop {
  points: Point[];
  /** True when the loop encloses empty space inside another loop. */
  hole: boolean;
  /** Signed area in pixel units; positive is counter-clockwise. */
  area: number;
}

export type MaskChannel = 'luma' | 'alpha' | 'red' | 'green' | 'blue';

export interface MaskOptions {
  /** Which channel decides inside from outside. */
  channel?: MaskChannel;
  /** 0..1. Pixels at or above this are inside. */
  threshold?: number;
  /** Flip the test, for dark subjects on light backgrounds. */
  invert?: boolean;
}

function sample(bitmap: Bitmap, index: number, channel: MaskChannel): number {
  const d = bitmap.data;
  const o = index * 4;
  switch (channel) {
    case 'alpha': return d[o + 3] / 255;
    case 'red': return d[o] / 255;
    case 'green': return d[o + 1] / 255;
    case 'blue': return d[o + 2] / 255;
    default:
      // Rec. 709 luma, which tracks perceived brightness far better than a mean.
      return (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255;
  }
}

export function maskFromBitmap(bitmap: Bitmap, options: MaskOptions = {}): Mask {
  const channel = options.channel ?? 'luma';
  const threshold = options.threshold ?? 0.5;
  const invert = options.invert ?? false;
  const count = bitmap.width * bitmap.height;
  const data = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const v = sample(bitmap, i, channel);
    const inside = v >= threshold;
    data[i] = (invert ? !inside : inside) ? 1 : 0;
  }
  return { width: bitmap.width, height: bitmap.height, data };
}

/** Pick the channel that separates subject from background most cleanly. */
export function suggestMaskOptions(bitmap: Bitmap): MaskOptions {
  let transparent = 0;
  const count = bitmap.width * bitmap.height;
  const step = Math.max(1, Math.floor(count / 4096));
  let sampled = 0;
  let lumaSum = 0;
  for (let i = 0; i < count; i += step) {
    sampled++;
    if (bitmap.data[i * 4 + 3] < 250) transparent++;
    lumaSum += sample(bitmap, i, 'luma');
  }
  // A cut-out PNG is best masked by its alpha; otherwise threshold brightness
  // and assume the subject is whichever side of mid-grey is rarer.
  if (transparent / Math.max(1, sampled) > 0.05) {
    return { channel: 'alpha', threshold: 0.5, invert: false };
  }
  const meanLuma = lumaSum / Math.max(1, sampled);
  return { channel: 'luma', threshold: 0.5, invert: meanLuma > 0.5 };
}

/** Drop specks and plug pinholes: one erode/dilate cycle in each direction. */
export function denoiseMask(mask: Mask, radius = 1): Mask {
  if (radius <= 0) return mask;
  let current = mask;
  for (let i = 0; i < radius; i++) current = morph(morph(current, 'erode'), 'dilate');
  for (let i = 0; i < radius; i++) current = morph(morph(current, 'dilate'), 'erode');
  return current;
}

function morph(mask: Mask, mode: 'erode' | 'dilate'): Mask {
  const { width, height, data } = mask;
  const out = new Uint8Array(data.length);
  const wantAll = mode === 'erode';
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let all = true;
      let any = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          // Outside the image counts as background.
          const v = nx < 0 || ny < 0 || nx >= width || ny >= height ? 0 : data[ny * width + nx];
          if (v) any = true;
          else all = false;
        }
      }
      out[y * width + x] = (wantAll ? all : any) ? 1 : 0;
    }
  }
  return { width, height, data: out };
}

/** Largest-first list of the mask's connected components, as separate masks. */
export function splitComponents(mask: Mask, minPixels = 32): Mask[] {
  const { width, height, data } = mask;
  const labels = new Int32Array(data.length).fill(-1);
  const components: { pixels: number[]; size: number }[] = [];
  const stack: number[] = [];

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start] >= 0) continue;
    const id = components.length;
    const pixels: number[] = [];
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      pixels.push(p);
      const x = p % width;
      const y = (p - x) / width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (data[n] && labels[n] < 0) {
          labels[n] = id;
          stack.push(n);
        }
      }
    }
    components.push({ pixels, size: pixels.length });
  }

  return components
    .filter((c) => c.size >= minPixels)
    .sort((a, b) => b.size - a.size)
    .map((c) => {
      const out = new Uint8Array(data.length);
      for (const p of c.pixels) out[p] = 1;
      return { width, height, data: out };
    });
}

export function signedArea(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Marching squares over the mask, linking the per-cell segments into closed
 * loops. Cell corners sample pixel centres, so a contour runs half a pixel
 * outside the pixels it encloses — which is where the real edge is.
 */
export function traceContours(mask: Mask): Loop[] {
  const { width, height, data } = mask;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : data[y * width + x];

  // Endpoints live on cell edges and are keyed exactly, so neighbouring cells
  // agree and the segments chain without any tolerance fudging.
  const key = (p: Point): string => `${p[0]},${p[1]}`;
  const next = new Map<string, Point[]>();
  const addSegment = (a: Point, b: Point): void => {
    const list = next.get(key(a)) ?? [];
    list.push(b);
    next.set(key(a), list);
  };

  for (let y = -1; y < height; y++) {
    for (let x = -1; x < width; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;

      // Midpoints of the four cell edges, in pixel-centre coordinates.
      const top: Point = [x + 0.5, y];
      const right: Point = [x + 1, y + 0.5];
      const bottom: Point = [x + 0.5, y + 1];
      const left: Point = [x, y + 0.5];

      // Segments are wound so that "inside" stays on the left, which makes the
      // outer loops counter-clockwise and the holes clockwise.
      switch (code) {
        case 1: addSegment(bottom, left); break;
        case 2: addSegment(right, bottom); break;
        case 3: addSegment(right, left); break;
        case 4: addSegment(top, right); break;
        case 5: // saddle
          addSegment(top, left);
          addSegment(bottom, right);
          break;
        case 6: addSegment(top, bottom); break;
        case 7: addSegment(top, left); break;
        case 8: addSegment(left, top); break;
        case 9: addSegment(bottom, top); break;
        case 10: // saddle
          addSegment(left, bottom);
          addSegment(right, top);
          break;
        case 11: addSegment(right, top); break;
        case 12: addSegment(left, right); break;
        case 13: addSegment(bottom, right); break;
        case 14: addSegment(left, bottom); break;
      }
    }
  }

  const loops: Loop[] = [];
  const consumed = new Set<string>();

  for (const [startKey, targets] of next) {
    for (let branch = 0; branch < targets.length; branch++) {
      const edgeId = `${startKey}>${branch}`;
      if (consumed.has(edgeId)) continue;
      const points: Point[] = [];
      let cursor: Point = startKey.split(',').map(Number) as Point;
      let outgoingIndex = branch;
      let guard = 0;
      const limit = width * height * 4 + 16;

      while (guard++ < limit) {
        const k = key(cursor);
        const outs = next.get(k);
        if (!outs || outs.length === 0) break;
        const idx = Math.min(outgoingIndex, outs.length - 1);
        const id = `${k}>${idx}`;
        if (consumed.has(id)) break;
        consumed.add(id);
        points.push(cursor);
        cursor = outs[idx];
        // At a saddle the follow-on branch is chosen by arrival order, which
        // keeps the two crossings separate instead of merging them.
        const nextOuts = next.get(key(cursor));
        outgoingIndex = 0;
        if (nextOuts && nextOuts.length > 1) {
          for (let i = 0; i < nextOuts.length; i++) {
            if (!consumed.has(`${key(cursor)}>${i}`)) {
              outgoingIndex = i;
              break;
            }
          }
        }
        if (key(cursor) === startKey) break;
      }

      if (points.length >= 3) {
        const area = signedArea(points);
        if (Math.abs(area) > 0.5) loops.push({ points, hole: area < 0, area });
      }
    }
  }

  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  if (loops.length === 0) return loops;

  // The largest contour always bounds filled pixels, so its winding tells us
  // which sign means "outer" — no need to reason about the cell table's
  // handedness in a y-down image frame. Everything is then normalised so outer
  // loops are counter-clockwise and holes clockwise.
  const outerSign = Math.sign(loops[0].area) || 1;
  for (const loop of loops) {
    const isHole = Math.sign(loop.area) !== outerSign;
    const wantPositive = !isHole;
    if (loop.area > 0 !== wantPositive) {
      loop.points.reverse();
      loop.area = -loop.area;
    }
    loop.hole = isHole;
  }
  return loops;
}

/** Ramer-Douglas-Peucker, applied around a closed loop. */
export function simplifyLoop(points: Point[], tolerance: number): Point[] {
  if (tolerance <= 0 || points.length < 4) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        index = i;
      }
    }
    if (index >= 0 && worst > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out.length >= 3 ? out : points.slice();
}

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Simplify every loop, dropping any that collapse. */
export function simplifyContours(loops: Loop[], tolerance: number): Loop[] {
  const out: Loop[] = [];
  for (const loop of loops) {
    const points = simplifyLoop(loop.points, tolerance);
    if (points.length < 3) continue;
    const area = signedArea(points);
    if (Math.abs(area) < 1e-6) continue;
    out.push({ points, area, hole: area < 0 });
  }
  return out;
}

export function loopBounds(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function pointInLoop(p: Point, points: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
