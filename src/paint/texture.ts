import { Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { SceneTexture } from '../scene/Texture';

/**
 * Texture painting.
 *
 * The hard part is not the brush, it is the seams. A model's UV layout cuts
 * the surface into islands, and two points that are neighbours on the model
 * can be far apart in the texture. A brush that only stamps where the cursor
 * is leaves a hairline gap down every seam, visible the moment the model
 * turns — so the stamp goes down once per *face* the brush touches, clipped to
 * that face's own triangle in UV space. A seam is then painted twice, once from
 * each side, which is exactly what closes it.
 *
 * Pixels live in a canvas per texture rather than in the data URL, because
 * re-encoding a PNG on every dab would make painting unusable. The URL is
 * refreshed when the stroke ends.
 */

export interface Brush {
  /** Radius in pixels of the texture. */
  radius: number;
  /** Linear RGB. */
  color: [number, number, number];
  /** 0..1. */
  strength: number;
  /** 0 is a hard edge, 1 fades all the way to the centre. */
  softness: number;
}

export function defaultBrush(): Brush {
  return { radius: 24, color: [0.9, 0.2, 0.2], strength: 0.8, softness: 0.5 };
}

function toSrgb(c: number): number {
  const x = Math.min(1, Math.max(0, c));
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
}

/**
 * A texture's pixels, mutable.
 *
 * Held separately from `SceneTexture` because that is the serializable record
 * and this is a live drawing surface. One of these exists per texture actually
 * being painted, not per texture in the scene.
 */
export class PaintSurface {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dirty = false;

  constructor(readonly texture: SceneTexture, width = 1024, height = 1024) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = texture.width || width;
    this.canvas.height = texture.height || height;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser will not give us a 2D canvas to paint on');
    this.ctx = ctx;
    // Start from whatever the texture already holds, so painting over an
    // imported map edits it rather than replacing it.
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Draw the texture's existing pixels in, once the image has decoded. */
  async adoptExisting(): Promise<void> {
    if (!this.texture.url) return;
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = this.texture.url;
    });
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /**
   * Stamp the brush at a UV coordinate, clipped to a triangle.
   *
   * The clip is what makes seams work: the same world point is stamped once
   * for each face that owns it, and each stamp is confined to its own face, so
   * paint never bleeds into a neighbouring island that happens to sit next to
   * it in the atlas.
   */
  stamp(brush: Brush, u: number, v: number, clip?: [number, number][]): void {
    const x = u * this.width;
    // Textures are addressed with v up; canvases with y down.
    const y = (1 - v) * this.height;
    const ctx = this.ctx;
    ctx.save();
    if (clip && clip.length >= 3) {
      ctx.beginPath();
      // A hair of overlap between adjacent faces, so the shared edge is
      // covered from both sides rather than falling between them.
      const cx = clip.reduce((a, p) => a + p[0], 0) / clip.length;
      const cy = clip.reduce((a, p) => a + p[1], 0) / clip.length;
      const grow = 1.5;
      clip.forEach(([px, py], i) => {
        const gx = this.width * px;
        const gy = this.height * (1 - py);
        const dx = gx - this.width * cx;
        const dy = gy - this.height * (1 - cy);
        const len = Math.hypot(dx, dy) || 1;
        const ex = gx + (dx / len) * grow;
        const ey = gy + (dy / len) * grow;
        if (i === 0) ctx.moveTo(ex, ey);
        else ctx.lineTo(ex, ey);
      });
      ctx.closePath();
      ctx.clip();
    }
    const [r, g, b] = brush.color;
    const inner = brush.radius * (1 - Math.min(0.99, brush.softness));
    const gradient = ctx.createRadialGradient(x, y, Math.max(0, inner), x, y, Math.max(0.5, brush.radius));
    const rgb = `${toSrgb(r)}, ${toSrgb(g)}, ${toSrgb(b)}`;
    gradient.addColorStop(0, `rgba(${rgb}, ${brush.strength})`);
    gradient.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, brush.radius), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.dirty = true;
  }

  /** Fill the whole texture with one colour. */
  fill(color: [number, number, number]): void {
    const [r, g, b] = color;
    this.ctx.fillStyle = `rgb(${toSrgb(r)}, ${toSrgb(g)}, ${toSrgb(b)})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.dirty = true;
  }

  /**
   * Write the pixels back into the texture record.
   *
   * Encoding a PNG is not cheap, so this is a stroke-end operation rather than
   * something to do per dab.
   */
  commit(): boolean {
    if (!this.dirty) return false;
    this.texture.url = this.canvas.toDataURL('image/png');
    this.texture.width = this.width;
    this.texture.height = this.height;
    this.dirty = false;
    return true;
  }

  get hasUncommittedPaint(): boolean {
    return this.dirty;
  }
}

/** A face the brush reached, with the UV to stamp at and the face's own outline. */
export interface PaintTarget {
  face: number;
  uv: [number, number];
  outline: [number, number][];
}

/**
 * Every face within `radius` of `center` that carries UVs, with the UV the
 * brush centre maps to on each.
 *
 * Working per face rather than per hit is what closes seams: the same stroke
 * paints into every island the brush overlaps, so a cut in the layout does not
 * show as a gap on the model.
 */
export function paintTargets(mesh: Mesh, center: Vec3, radius: number): PaintTarget[] {
  const out: PaintTarget[] = [];
  if (!mesh.hasUV) return out;
  const r2 = radius * radius;
  for (let f = 0; f < mesh.faces.length; f++) {
    const uv = mesh.uvFor(f);
    if (!uv) continue;
    const loop = mesh.faces[f];
    // Cheap reject: no corner within reach and no crossing of the brush.
    let near = false;
    for (const v of loop) {
      if (mesh.positions[v].sub(center).lengthSq() <= r2) {
        near = true;
        break;
      }
    }
    if (!near) {
      // The brush can still land in the middle of a large face.
      const c = mesh.faceCenter(f);
      if (c.sub(center).lengthSq() > r2) continue;
    }
    const mapped = uvAtPoint(mesh, f, center);
    if (!mapped) continue;
    const outline: [number, number][] = [];
    for (let i = 0; i < loop.length; i++) outline.push([uv[i * 2], uv[i * 2 + 1]]);
    out.push({ face: f, uv: mapped, outline });
  }
  return out;
}

/**
 * The UV a world point maps to on a face, by barycentric interpolation over
 * whichever of the face's triangles is nearest. Points outside the face still
 * get a coordinate — extrapolating is what lets a brush overlapping the edge
 * paint across it rather than stopping dead.
 */
export function uvAtPoint(mesh: Mesh, face: number, p: Vec3): [number, number] | null {
  const uv = mesh.uvFor(face);
  const loop = mesh.faces[face];
  if (!uv || loop.length < 3) return null;
  let best: [number, number] | null = null;
  let bestDist = Infinity;
  for (let i = 1; i + 1 < loop.length; i++) {
    const a = mesh.positions[loop[0]];
    const b = mesh.positions[loop[i]];
    const c = mesh.positions[loop[i + 1]];
    const bary = barycentric(p, a, b, c);
    if (!bary) continue;
    const [wa, wb, wc] = bary;
    // How far outside the triangle the point falls, for picking the best one.
    const outside = Math.max(0, -wa) + Math.max(0, -wb) + Math.max(0, -wc);
    if (outside >= bestDist) continue;
    bestDist = outside;
    best = [
      uv[0] * wa + uv[i * 2] * wb + uv[(i + 1) * 2] * wc,
      uv[1] * wa + uv[i * 2 + 1] * wb + uv[(i + 1) * 2 + 1] * wc,
    ];
  }
  return best;
}

/** Barycentric coordinates of `p` projected onto triangle `abc`. */
function barycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): [number, number, number] | null {
  const v0 = b.sub(a);
  const v1 = c.sub(a);
  const v2 = p.sub(a);
  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-16) return null;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  return [1 - v - w, v, w];
}

/**
 * How many UV units one world unit covers on a face.
 *
 * The brush radius is authored in world units so it matches every other brush,
 * but the stamp works in texture pixels. This is the conversion, and it varies
 * across a model — a stretched unwrap genuinely does paint coarser there, and
 * showing that is more honest than pretending otherwise.
 */
export function uvScaleAt(mesh: Mesh, face: number): number {
  const uv = mesh.uvFor(face);
  const loop = mesh.faces[face];
  if (!uv || loop.length < 3) return 1;
  let world = 0;
  let texture = 0;
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    world += mesh.positions[loop[i]].distanceTo(mesh.positions[loop[j]]);
    texture += Math.hypot(uv[i * 2] - uv[j * 2], uv[i * 2 + 1] - uv[j * 2 + 1]);
  }
  if (world < 1e-9) return 1;
  return texture / world;
}
