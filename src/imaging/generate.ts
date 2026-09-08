import { Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { mergeByDistance, recalculateNormals } from '../mesh/ops';
import {
  Bitmap, Loop, Mask, MaskOptions, Point, denoiseMask, loopBounds, maskFromBitmap, pointInLoop,
  simplifyContours, splitComponents, suggestMaskOptions, traceContours,
} from './contour';
import { triangulatePolygon } from './triangulate';

/**
 * Reference image to geometry.
 *
 * Three deterministic generators, no model weights and no network: extrude a
 * silhouette into a solid, revolve a silhouette into a turned form, or displace
 * a grid by image brightness. They run in milliseconds on any machine, which is
 * what makes them useful as the first thing that happens when you drop a
 * reference in.
 */

export interface GenerateStats {
  /** Milliseconds spent building the mesh. */
  ms: number;
  loops: number;
  verts: number;
  faces: number;
}

export interface GenerateResult {
  mesh: Mesh;
  stats: GenerateStats;
}

export interface SilhouetteOptions {
  /** Thickness of the extrusion in world units. */
  depth?: number;
  /** The finished shape is scaled to this height. */
  targetHeight?: number;
  /** Contour simplification tolerance, in pixels. */
  simplify?: number;
  /** Morphological cleanup passes before tracing. */
  denoise?: number;
  mask?: MaskOptions;
  /** Keep at most this many separate blobs, largest first. */
  maxParts?: number;
  /** Taper the front and back faces inward by this fraction of the depth. */
  bevel?: number;
}

/**
 * How far a texture coordinate is pulled off the silhouette, in pixels.
 *
 * A vertex on the outline sits exactly on the boundary between the subject
 * and whatever was behind it, so reading the photograph there gives half a
 * texel of background — a bright fringe all the way round the cut-out. Two
 * pixels in is enough to be clear of it and far too little to be seen as a
 * shift in the picture.
 */
const UV_INSET_PX = 2.5;

interface Shape {
  outer: Loop;
  holes: Loop[];
}

/** Assign each hole to the smallest outer loop that contains it. */
function groupShapes(loops: Loop[]): Shape[] {
  const outers = loops.filter((l) => !l.hole);
  const holes = loops.filter((l) => l.hole);
  const shapes: Shape[] = outers.map((outer) => ({ outer, holes: [] }));

  for (const hole of holes) {
    let best: Shape | null = null;
    for (const shape of shapes) {
      if (!pointInLoop(hole.points[0], shape.outer.points)) continue;
      if (!best || Math.abs(shape.outer.area) < Math.abs(best.outer.area)) best = shape;
    }
    if (best) best.holes.push(hole);
  }
  return shapes.filter((s) => Math.abs(s.outer.area) > 1);
}

/** Contours of a bitmap, cleaned up and grouped into outer/hole shapes. */
export function contoursFromBitmap(
  bitmap: Bitmap, options: SilhouetteOptions = {},
): { shapes: Shape[]; mask: Mask; width: number; height: number } {
  const maskOptions = options.mask ?? suggestMaskOptions(bitmap);
  const base = denoiseMask(maskFromBitmap(bitmap, maskOptions), options.denoise ?? 1);
  const parts = splitComponents(base, 32).slice(0, Math.max(1, options.maxParts ?? 8));
  const tolerance = options.simplify ?? 1.2;

  const shapes: Shape[] = [];
  for (const part of parts.length ? parts : [base]) {
    const loops = simplifyContours(traceContours(part), tolerance);
    shapes.push(...groupShapes(loops));
  }
  return { shapes, mask: base, width: bitmap.width, height: bitmap.height };
}

/**
 * Extrude the subject's outline into a solid. The image's vertical axis becomes
 * world Z and the extrusion runs along Y, so the result faces you in a front
 * view — the same orientation as the reference you traced it from.
 */
export function meshFromSilhouette(bitmap: Bitmap, options: SilhouetteOptions = {}): GenerateResult {
  const started = Date.now();
  const depth = options.depth ?? 0.4;
  const targetHeight = options.targetHeight ?? 2;
  const bevel = Math.max(0, Math.min(0.45, options.bevel ?? 0));

  const { shapes, mask } = contoursFromBitmap(bitmap, options);
  const mesh = new Mesh();
  if (shapes.length === 0) {
    return { mesh, stats: { ms: Date.now() - started, loops: 0, verts: 0, faces: 0 } };
  }

  // One scale for every shape, so multi-part results keep their relative sizes.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shape of shapes) {
    const b = loopBounds(shape.outer.points);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  const pixelHeight = Math.max(1e-6, maxY - minY);
  const scale = targetHeight / pixelHeight;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Image Y runs downward; negating it puts the subject the right way up.
  const toWorld = (p: Point, y: number, shrink: number): Vec3 =>
    new Vec3((p[0] - cx) * scale * shrink, y, -(p[1] - cy) * scale * shrink);

  const half = depth / 2;
  let loopCount = 0;
  // Per-corner texture coordinates, pushed in step with the faces. Every
  // vertex here is on the outline, so every one of them is pulled inward
  // before it reads the picture.
  const uv: (number[] | null)[] = [];
  const addFace = (corners: number[], coords: number[]): void => {
    mesh.faces.push(corners);
    mesh.faceMaterial.push(0);
    uv.push(coords);
  };

  for (const shape of shapes) {
    const holes = shape.holes.map((h) => h.points);
    const { vertices, indices } = triangulatePolygon(shape.outer.points, holes);
    if (indices.length === 0) continue;
    loopCount += 1 + holes.length;

    const shrink = 1 - bevel;
    const front = vertices.map((p) => mesh.positions.push(toWorld(p, -half, shrink)) - 1);
    const back = vertices.map((p) => mesh.positions.push(toWorld(p, half, shrink)) - 1);
    // A bevel needs a second, full-size ring at the mid-plane to taper to.
    const rim = bevel > 0 ? vertices.map((p) => mesh.positions.push(toWorld(p, 0, 1)) - 1) : null;
    const uvOf = insetTexCoords(vertices, indices, mask, bitmap);

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const ta = uvOf[a], tb = uvOf[b], tc = uvOf[c];
      addFace([front[a], front[b], front[c]], [...ta, ...tb, ...tc]);
      addFace([back[a], back[b], back[c]], [...ta, ...tb, ...tc]);
    }

    // Walls follow every ring: the outer boundary and each hole.
    const rings: number[][] = [];
    let offset = 0;
    rings.push(range(offset, shape.outer.points.length));
    offset += shape.outer.points.length;
    for (const hole of holes) {
      rings.push(range(offset, hole.length));
      offset += hole.length;
    }

    for (const ringIndices of rings) {
      for (let i = 0; i < ringIndices.length; i++) {
        const a = ringIndices[i];
        const b = ringIndices[(i + 1) % ringIndices.length];
        const ta = uvOf[a];
        const tb = uvOf[b];
        if (rim) {
          addFace([front[a], front[b], rim[b], rim[a]], [...ta, ...tb, ...tb, ...ta]);
          addFace([rim[a], rim[b], back[b], back[a]], [...ta, ...tb, ...tb, ...ta]);
        } else {
          addFace([front[a], front[b], back[b], back[a]], [...ta, ...tb, ...tb, ...ta]);
        }
      }
    }
  }

  mesh.faceUV = uv;
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
  if (mesh.faceCount > 0) recalculateNormals(mesh);
  return {
    mesh,
    stats: { ms: Date.now() - started, loops: loopCount, verts: mesh.vertCount, faces: mesh.faceCount },
  };
}

/**
 * A texture coordinate for every triangulated vertex, stepped off the outline.
 *
 * The inward direction comes from the triangulation itself: each vertex is
 * pushed toward the average of the centroids of the triangles it belongs to,
 * which points into the material whether the vertex is on the outer boundary
 * or around a hole, and needs no assumption about winding. The step is then
 * shortened until it lands on a pixel the mask calls subject, so a spike or a
 * tight notch keeps its own colour rather than borrowing the background's.
 */
function insetTexCoords(
  vertices: Point[], indices: number[], mask: Mask, bitmap: Bitmap,
): [number, number][] {
  const dir: Point[] = vertices.map(() => [0, 0]);
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    const cx = (vertices[tri[0]][0] + vertices[tri[1]][0] + vertices[tri[2]][0]) / 3;
    const cy = (vertices[tri[0]][1] + vertices[tri[1]][1] + vertices[tri[2]][1]) / 3;
    for (const v of tri) {
      const dx = cx - vertices[v][0];
      const dy = cy - vertices[v][1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      dir[v][0] += dx / len;
      dir[v][1] += dy / len;
    }
  }

  const inside = (px: number, py: number): boolean => {
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
    return mask.data[y * mask.width + x] !== 0;
  };
  const uvPixel = (px: number, py: number): [number, number] => [
    px / Math.max(1, bitmap.width - 1),
    // The renderer uploads textures flipped, so v runs up from the bottom.
    1 - py / Math.max(1, bitmap.height - 1),
  ];

  return vertices.map((p, v) => {
    const len = Math.hypot(dir[v][0], dir[v][1]);
    if (len < 1e-9) return uvPixel(p[0], p[1]);
    const nx = dir[v][0] / len;
    const ny = dir[v][1] / len;
    for (let step = UV_INSET_PX; step > 0.4; step /= 2) {
      const px = p[0] + nx * step;
      const py = p[1] + ny * step;
      if (inside(px, py)) return uvPixel(px, py);
    }
    return uvPixel(p[0], p[1]);
  });
}

function range(start: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(start + i);
  return out;
}

export interface LatheOptions {
  segments?: number;
  targetHeight?: number;
  /** 0..1 across the image; the vertical line the profile spins around. */
  axis?: number;
  /** Take the widest side, or only the left/right half. */
  side?: 'widest' | 'left' | 'right';
  /** Maximum profile samples; rows are averaged down to this. */
  profileSamples?: number;
  smooth?: boolean;
  mask?: MaskOptions;
  denoise?: number;
}

/**
 * Revolve the subject's profile around a vertical axis — a photograph of a
 * vase, bottle or turned leg becomes the real object in one pass.
 */
export function meshFromLathe(bitmap: Bitmap, options: LatheOptions = {}): GenerateResult {
  const started = Date.now();
  const segments = Math.max(3, Math.floor(options.segments ?? 48));
  const targetHeight = options.targetHeight ?? 2;
  const maxSamples = Math.max(4, Math.floor(options.profileSamples ?? 96));

  const maskOptions = options.mask ?? suggestMaskOptions(bitmap);
  const mask = denoiseMask(maskFromBitmap(bitmap, maskOptions), options.denoise ?? 1);
  const parts = splitComponents(mask, 32);
  const subject = parts[0] ?? mask;

  const { width, height, data } = subject;
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!data[y * width + x]) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  const mesh = new Mesh();
  if (minY > maxY) return { mesh, stats: { ms: Date.now() - started, loops: 0, verts: 0, faces: 0 } };

  const axisX = options.axis !== undefined
    ? minX + options.axis * (maxX - minX)
    : (minX + maxX) / 2;

  // One radius per image row: how far the silhouette reaches from the axis.
  const rows: { radius: number; y: number }[] = [];
  for (let y = minY; y <= maxY; y++) {
    let left = 0;
    let right = 0;
    let any = false;
    for (let x = 0; x < width; x++) {
      if (!data[y * width + x]) continue;
      any = true;
      const d = x - axisX;
      if (d < 0) left = Math.max(left, -d);
      else right = Math.max(right, d);
    }
    if (!any) continue;
    const radius = options.side === 'left' ? left : options.side === 'right' ? right : Math.max(left, right);
    rows.push({ radius, y });
  }
  if (rows.length < 2) return { mesh, stats: { ms: Date.now() - started, loops: 0, verts: 0, faces: 0 } };

  // Average down to a manageable number of profile samples.
  const step = Math.max(1, Math.floor(rows.length / maxSamples));
  const profile: { radius: number; y: number }[] = [];
  for (let i = 0; i < rows.length; i += step) {
    let radius = 0;
    let y = 0;
    let n = 0;
    for (let k = i; k < Math.min(rows.length, i + step); k++) {
      radius += rows[k].radius;
      y += rows[k].y;
      n++;
    }
    profile.push({ radius: radius / n, y: y / n });
  }
  if (profile[profile.length - 1].y !== rows[rows.length - 1].y) profile.push(rows[rows.length - 1]);

  const pixelHeight = Math.max(1e-6, maxY - minY);
  const scale = targetHeight / pixelHeight;
  const centreY = (minY + maxY) / 2;

  // Rings of vertices, bottom to top; a zero radius collapses to a pole.
  const rings: number[][] = [];
  for (let i = profile.length - 1; i >= 0; i--) {
    const { radius, y } = profile[i];
    const z = -(y - centreY) * scale;
    const r = radius * scale;
    if (r < 1e-6) {
      rings.push([mesh.positions.push(new Vec3(0, 0, z)) - 1]);
      continue;
    }
    const ring: number[] = [];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      ring.push(mesh.positions.push(new Vec3(Math.cos(a) * r, Math.sin(a) * r, z)) - 1);
    }
    rings.push(ring);
  }

  for (let i = 0; i + 1 < rings.length; i++) {
    const lower = rings[i];
    const upper = rings[i + 1];
    if (lower.length === 1 && upper.length === 1) continue;
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      if (lower.length === 1) mesh.faces.push([lower[0], upper[s], upper[s2]]);
      else if (upper.length === 1) mesh.faces.push([lower[s], lower[s2], upper[0]]);
      else mesh.faces.push([lower[s], lower[s2], upper[s2], upper[s]]);
      mesh.faceMaterial.push(0);
    }
  }

  // Flat caps wherever the profile stops short of the axis.
  for (const [index, ring] of [[0, rings[0]], [rings.length - 1, rings[rings.length - 1]]] as const) {
    if (ring.length <= 1) continue;
    const z = mesh.positions[ring[0]].z;
    const centre = mesh.positions.push(new Vec3(0, 0, z)) - 1;
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments;
      mesh.faces.push(index === 0 ? [centre, ring[s2], ring[s]] : [centre, ring[s], ring[s2]]);
      mesh.faceMaterial.push(0);
    }
  }

  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
  mergeByDistance(mesh, null, 1e-6);
  if (mesh.faceCount > 0) recalculateNormals(mesh);
  if (options.smooth !== false) mesh.setAllSmooth(true);
  return {
    mesh,
    stats: { ms: Date.now() - started, loops: profile.length, verts: mesh.vertCount, faces: mesh.faceCount },
  };
}

export interface HeightfieldOptions {
  /** Grid samples along the longer axis. */
  resolution?: number;
  /** World size of the longer axis. */
  size?: number;
  /** Peak displacement for full-white pixels. */
  height?: number;
  invert?: boolean;
  /** Close the sides and bottom so the result is a solid, printable block. */
  solid?: boolean;
  /** Thickness under the lowest point when solid. */
  base?: number;
  smooth?: boolean;
}

/** Displace a grid by image brightness — relief carvings, terrain, depth maps. */
export function meshFromHeightfield(bitmap: Bitmap, options: HeightfieldOptions = {}): GenerateResult {
  const started = Date.now();
  const resolution = Math.max(2, Math.min(512, Math.floor(options.resolution ?? 128)));
  const size = options.size ?? 2;
  const amplitude = options.height ?? 0.35;
  const invert = options.invert ?? false;
  const solid = options.solid ?? false;
  const base = options.base ?? 0.05;

  const aspect = bitmap.width / bitmap.height;
  const nx = aspect >= 1 ? resolution : Math.max(2, Math.round(resolution * aspect));
  const ny = aspect >= 1 ? Math.max(2, Math.round(resolution / aspect)) : resolution;
  const worldW = aspect >= 1 ? size : size * aspect;
  const worldH = aspect >= 1 ? size / aspect : size;

  const luma = (px: number, py: number): number => {
    const x = Math.min(bitmap.width - 1, Math.max(0, Math.round(px)));
    const y = Math.min(bitmap.height - 1, Math.max(0, Math.round(py)));
    const o = (y * bitmap.width + x) * 4;
    const v = (0.2126 * bitmap.data[o] + 0.7152 * bitmap.data[o + 1] + 0.0722 * bitmap.data[o + 2]) / 255;
    return invert ? 1 - v : v;
  };

  const mesh = new Mesh();
  const top: number[] = [];
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const u = nx === 1 ? 0 : gx / (nx - 1);
      const v = ny === 1 ? 0 : gy / (ny - 1);
      const z = luma(u * (bitmap.width - 1), v * (bitmap.height - 1)) * amplitude;
      top.push(mesh.positions.push(new Vec3((u - 0.5) * worldW, (0.5 - v) * worldH, z)) - 1);
    }
  }
  const gi = (x: number, y: number): number => top[y * nx + x];
  for (let gy = 0; gy + 1 < ny; gy++) {
    for (let gx = 0; gx + 1 < nx; gx++) {
      mesh.faces.push([gi(gx, gy + 1), gi(gx + 1, gy + 1), gi(gx + 1, gy), gi(gx, gy)]);
      mesh.faceMaterial.push(0);
    }
  }

  if (solid) {
    let lowest = Infinity;
    for (const i of top) lowest = Math.min(lowest, mesh.positions[i].z);
    const floor = lowest - Math.max(1e-4, base);
    const bottom = top.map((i) => {
      const p = mesh.positions[i];
      return mesh.positions.push(new Vec3(p.x, p.y, floor)) - 1;
    });
    const bi = (x: number, y: number): number => bottom[y * nx + x];
    for (let gy = 0; gy + 1 < ny; gy++) {
      for (let gx = 0; gx + 1 < nx; gx++) {
        mesh.faces.push([bi(gx, gy), bi(gx + 1, gy), bi(gx + 1, gy + 1), bi(gx, gy + 1)]);
        mesh.faceMaterial.push(0);
      }
    }
    const wall = (a: number, b: number): void => {
      mesh.faces.push([a, b, bottom[b], bottom[a]]);
      mesh.faceMaterial.push(0);
    };
    for (let gx = 0; gx + 1 < nx; gx++) {
      wall(gx, gx + 1);
      wall((ny - 1) * nx + gx + 1, (ny - 1) * nx + gx);
    }
    for (let gy = 0; gy + 1 < ny; gy++) {
      wall((gy + 1) * nx, gy * nx);
      wall(gy * nx + nx - 1, (gy + 1) * nx + nx - 1);
    }
    recalculateNormals(mesh);
  }

  if (options.smooth !== false) mesh.setAllSmooth(true);
  mesh.markDirty();
  return {
    mesh,
    stats: { ms: Date.now() - started, loops: 1, verts: mesh.vertCount, faces: mesh.faceCount },
  };
}
