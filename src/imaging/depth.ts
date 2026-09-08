import { setting } from '../core/math';
import { Bitmap } from './contour';
import { Matte, labFromBitmap } from './segment';

/**
 * Giving a photograph a third dimension.
 *
 * The honest position first: a single photograph does not contain the back of
 * the thing it shows, and no amount of arithmetic will put it there. What it
 * does contain is an outline and a pattern of light, and those two together
 * are enough to build something that reads as the object rather than as a
 * sticker of it — which is the whole distance between "I extruded a logo" and
 * "that is my shoe".
 *
 * Two signals, combined:
 *
 * The outline gives the volume. Solving ∇²h = -4 across the inside of the
 * silhouette with h pinned to zero on its edge, then taking √h, produces
 * exactly a hemisphere over a circle — and, far more usefully, produces a
 * thickness that follows the *local* width everywhere else. A wide body comes
 * out deep and a thin strap comes out thin, from one solve, with nothing
 * measured by hand. That is why it is a Poisson solve rather than a distance
 * transform: distance to the edge makes every limb as deep as the object's
 * widest point, which is what makes inflated silhouettes look like inflated
 * silhouettes.
 *
 * The shading gives the surface. Brightness inside the subject, with its
 * broad lighting gradient removed, tracks the creases and folds and seams a
 * pure inflation cannot know about. It is added on top of the volume and
 * faded out towards the rim, where it would otherwise fight the outline.
 *
 * Then the whole field is smoothed along the image's own colour edges, so
 * detail stops where the object does.
 */

export interface DepthOptions {
  /** Overall depth as a fraction of what a full inflation would give, 0..2. */
  volume?: number;
  /** How much image shading is added as surface relief, 0..1. */
  detail?: number;
  /** Radius in pixels of the lighting gradient removed before using shading. */
  detailScale?: number;
  /** Edge-aware smoothing passes over the finished field. */
  smoothing?: number;
  /**
   * How much to even the depth out across the subject's own mirror line.
   *
   * 0 leaves each side as the photograph found it; 1 makes the two sides the
   * average of each other.
   *
   * Only applied when the silhouette really is symmetric — see
   * `symmetryAxis` — so a photograph of something lopsided is left alone.
   */
  symmetry?: number;
}

/** Where a subject mirrors itself, and how well. */
export interface Symmetry {
  /** Column the subject reflects about, in pixels. */
  axis: number;
  /** Overlap of the subject with its own reflection, 0..1. */
  score: number;
}

export interface DepthField {
  width: number;
  height: number;
  /** Half-thickness at each pixel, in pixels. Zero outside the subject. */
  data: Float32Array;
  /** The deepest half-thickness found, in pixels. */
  peak: number;
}

/**
 * Solve ∇²h = -4 inside the subject, h = 0 outside.
 *
 * Coarse to fine, because plain relaxation on a full-resolution grid moves
 * information one pixel per pass: filling the middle of a 300-pixel-wide
 * subject would take hundreds of passes, and stopping early leaves a dent
 * down the centre of everything. Solving small first and using that as the
 * starting guess gets there in a handful of passes at each size.
 */
export function inflationField(matte: Matte, iterations = 48): Float32Array {
  const levels: { w: number; h: number; inside: Uint8Array; scale: number }[] = [];
  let w = matte.width;
  let h = matte.height;
  let inside = new Uint8Array(w * h);
  for (let i = 0; i < inside.length; i++) inside[i] = matte.data[i] >= 0.5 ? 1 : 0;
  levels.push({ w, h, inside, scale: 1 });
  while (Math.min(w, h) > 24 && levels.length < 6) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        // A coarse cell counts as inside only when all four of its children
        // are, which keeps the coarse silhouette inside the fine one and
        // stops thin limbs from growing on the way back up.
        const a = inside[Math.min(h - 1, y * 2) * w + Math.min(w - 1, x * 2)];
        const b = inside[Math.min(h - 1, y * 2) * w + Math.min(w - 1, x * 2 + 1)];
        const c = inside[Math.min(h - 1, y * 2 + 1) * w + Math.min(w - 1, x * 2)];
        const d = inside[Math.min(h - 1, y * 2 + 1) * w + Math.min(w - 1, x * 2 + 1)];
        next[y * nw + x] = a && b && c && d ? 1 : 0;
      }
    }
    w = nw; h = nh; inside = next;
    levels.push({ w, h, inside, scale: levels.length ? 2 ** levels.length : 1 });
  }

  let field: Float32Array = new Float32Array(levels[levels.length - 1].w * levels[levels.length - 1].h);
  for (let l = levels.length - 1; l >= 0; l--) {
    const lv = levels[l];
    if (field.length !== lv.w * lv.h) field = upsample(field, levels[l + 1].w, levels[l + 1].h, lv.w, lv.h);
    relax(field, lv.inside, lv.w, lv.h, lv.scale, l === 0 ? iterations * 2 : iterations);
  }
  // h is a squared thickness; the square root is the surface.
  const out = new Float32Array(field.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(Math.max(0, field[i]));
  return out;
}

/** Gauss–Seidel with over-relaxation, red-black so the sweep order does not bias it. */
function relax(field: Float32Array, inside: Uint8Array, w: number, h: number, scale: number, iterations: number): void {
  // The right-hand side carries the level's cell size, so a value solved on a
  // coarse grid means the same thickness as one solved on the fine grid and
  // can be used as its starting guess unchanged.
  const rhs = 4 * scale * scale;
  const omega = 1.85;
  for (let it = 0; it < iterations; it++) {
    for (let parity = 0; parity < 2; parity++) {
      for (let y = 0; y < h; y++) {
        for (let x = (y + parity) & 1; x < w; x += 2) {
          const i = y * w + x;
          if (!inside[i]) { field[i] = 0; continue; }
          // Outside the subject and outside the frame both read as zero,
          // which is what pins the surface down to the silhouette.
          const l = x > 0 ? field[i - 1] : 0;
          const r = x + 1 < w ? field[i + 1] : 0;
          const u = y > 0 ? field[i - w] : 0;
          const d = y + 1 < h ? field[i + w] : 0;
          const target = (l + r + u + d + rhs) / 4;
          field[i] = Math.max(0, field[i] + omega * (target - field[i]));
        }
      }
    }
  }
}

function upsample(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, y >> 1);
    for (let x = 0; x < dw; x++) {
      out[y * dw + x] = src[sy * sw + Math.min(sw - 1, x >> 1)];
    }
  }
  return out;
}

/** Perceived brightness, 0..1, one per pixel. */
export function lumaPlane(bitmap: Bitmap): Float32Array {
  const n = bitmap.width * bitmap.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (0.2126 * bitmap.data[o] + 0.7152 * bitmap.data[o + 1] + 0.0722 * bitmap.data[o + 2]) / 255;
  }
  return out;
}

/**
 * Brightness with its broad lighting gradient subtracted.
 *
 * What is left is the part of the shading that comes from the surface rather
 * than from where the lamp happened to be — folds, seams, panel lines. Using
 * raw brightness instead would tilt the whole model towards the light.
 */
export function shadingRelief(luma: Float32Array, width: number, height: number, radius: number): Float32Array {
  const low = boxBlur(luma, width, height, Math.max(1, Math.round(radius)));
  const out = new Float32Array(luma.length);
  for (let i = 0; i < out.length; i++) out[i] = luma[i] - low[i];
  return out;
}

function boxBlur(src: Float32Array, width: number, height: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let k = -r; k <= r; k++) {
        const t = x + k;
        if (t < 0 || t >= width) continue;
        sum += src[y * width + t];
        count++;
      }
      tmp[y * width + x] = sum / count;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let count = 0;
      for (let k = -r; k <= r; k++) {
        const t = y + k;
        if (t < 0 || t >= height) continue;
        sum += tmp[t * width + x];
        count++;
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * The vertical line the subject most nearly mirrors about, and how well it does.
 *
 * Most things people photograph — a shoe, a bottle, a chair, a face — are
 * bilaterally symmetric, and the photograph is not: one side is lit and the
 * other is in shadow, so shading-derived depth comes out heavier on the lit
 * side. Knowing where the mirror line is lets that be evened out. Knowing how
 * *well* it mirrors is the other half, and the more important one: it is what
 * stops the correction being applied to something that genuinely is lopsided.
 */
export function symmetryAxis(matte: Matte): Symmetry {
  const { width, height, data } = matte;
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] < 0.5) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) return { axis: width / 2, score: 0 };

  // Candidates around the middle of the subject: an object photographed
  // roughly square-on mirrors near its own centre, and searching the whole
  // frame would mostly rank ways of overlapping the subject with nothing.
  const centre = (x0 + x1) / 2;
  const span = Math.max(2, (x1 - x0) * 0.15);
  const step = Math.max(1, Math.round((x1 - x0) / 120));
  const rows = Math.max(1, Math.round((y1 - y0) / 96));
  let best: Symmetry = { axis: centre, score: 0 };
  for (let a = centre - span; a <= centre + span; a += step / 2) {
    let both = 0;
    let either = 0;
    for (let y = y0; y <= y1; y += rows) {
      for (let x = x0; x <= x1; x += step) {
        const here = data[y * width + x] >= 0.5;
        const mx = Math.round(2 * a - x);
        const there = mx >= 0 && mx < width && data[y * width + mx] >= 0.5;
        if (here && there) both++;
        if (here || there) either++;
      }
    }
    const score = either === 0 ? 0 : both / either;
    if (score > best.score) best = { axis: a, score };
  }
  return best;
}

/** The finished half-thickness of the subject at every pixel. */
export function depthFromPhoto(bitmap: Bitmap, matte: Matte, options: DepthOptions = {}): DepthField {
  const { width, height } = matte;
  const volume = setting(options.volume, 1, 0, 2);
  const detailGain = setting(options.detail, 0.35, 0, 1);
  const smoothing = Math.floor(setting(options.smoothing, 2, 0, 6));

  const inflation = inflationField(matte);
  let peak = 0;
  for (let i = 0; i < inflation.length; i++) if (inflation[i] > peak) peak = inflation[i];

  const data = new Float32Array(width * height);
  if (peak <= 0) return { width, height, data, peak: 0 };

  const relief = detailGain > 0
    ? shadingRelief(lumaPlane(bitmap), width, height,
      setting(options.detailScale, Math.max(4, peak * 0.5), 1, 4096))
    : null;

  for (let i = 0; i < data.length; i++) {
    const base = inflation[i] * volume;
    if (base <= 0) { data[i] = 0; continue; }
    let z = base;
    if (relief) {
      // Faded towards the rim: near the outline the silhouette is the truth,
      // and letting shading push the surface around there tears holes in the
      // edge where the model should be closing over.
      const taper = Math.min(1, inflation[i] / (peak * 0.35));
      z += relief[i] * detailGain * peak * 0.9 * taper * taper;
    }
    // Softly floored rather than clamped to zero, so shading can thin a
    // surface without punching through it.
    data[i] = Math.max(base * 0.15, z);
  }

  const symmetry = setting(options.symmetry, 0.5, 0, 1);
  if (symmetry > 0) {
    const mirror = symmetryAxis(matte);
    // Ramped in rather than switched on: an object that mirrors at 0.8 gets a
    // little of the correction and one that mirrors at 0.95 gets all of it, so
    // there is no threshold where a nudge to a slider changes the model.
    const confidence = Math.max(0, Math.min(1, (mirror.score - 0.78) / 0.14));
    // Half, because evening two sides out means meeting in the middle. Pulling
    // all the way to the reflection would not even the lopsidedness out, it
    // would move it to the other side.
    const strength = symmetry * confidence * 0.5;
    if (strength > 0.01) mirrorDepth(data, matte, width, height, mirror.axis, strength);
  }

  const lab = smoothing > 0 ? labFromBitmap(bitmap) : null;
  for (let s = 0; s < smoothing && lab; s++) edgeAwareSmooth(data, lab, matte, width, height);

  let finalPeak = 0;
  for (let i = 0; i < data.length; i++) {
    if (matte.data[i] < 0.5) data[i] = 0;
    else if (data[i] > finalPeak) finalPeak = data[i];
  }
  return { width, height, data, peak: finalPeak };
}

/**
 * Pull each depth towards its reflection across the subject's mirror line.
 *
 * The silhouette is deliberately left alone — it is the reliable half of the
 * picture, and mirroring it would push the outline off the object. Only the
 * thickness is evened out, and only where both sides of the line are subject.
 */
function mirrorDepth(
  data: Float32Array, matte: Matte, width: number, height: number, axis: number, strength: number,
): void {
  const src = data.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (matte.data[i] < 0.5) continue;
      const mx = 2 * axis - x;
      if (mx < 0 || mx > width - 1) continue;
      const x0 = Math.floor(mx);
      const x1 = Math.min(width - 1, x0 + 1);
      const f = mx - x0;
      if (matte.data[y * width + x0] < 0.5 || matte.data[y * width + x1] < 0.5) continue;
      const reflected = src[y * width + x0] * (1 - f) + src[y * width + x1] * f;
      data[i] = src[i] * (1 - strength) + reflected * strength;
    }
  }
}

/** Average each depth with its neighbours, but only across pixels that match in colour. */
function edgeAwareSmooth(data: Float32Array, lab: Float32Array, matte: Matte, width: number, height: number): void {
  const src = data.slice();
  const sigma = 140;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (matte.data[i] < 0.5) continue;
      let sum = src[i];
      let weight = 1;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (matte.data[j] < 0.5) continue;
        const dl = lab[i * 3] - lab[j * 3];
        const da = lab[i * 3 + 1] - lab[j * 3 + 1];
        const db = lab[i * 3 + 2] - lab[j * 3 + 2];
        const w = Math.exp(-(dl * dl + da * da + db * db) / sigma);
        sum += src[j] * w;
        weight += w;
      }
      data[i] = sum / weight;
    }
  }
}
