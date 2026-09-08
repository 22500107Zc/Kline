/**
 * A whole photograph as geometry, from an estimated depth map.
 *
 * The silhouette pipeline answers "what is this object and how thick is it".
 * This one answers a different question — "how far away is everything in this
 * picture" — and it is the question a photograph of a room, a street or a
 * person in front of anything actually poses. There is no subject to cut out
 * and no outline to inflate; there is only distance, and the network in
 * `neuralDepth` is what supplies it.
 *
 * What comes out is a surface seen from where the camera stood: correct in
 * front, hollow behind, and honest about it. That is the true shape of the
 * information a single photograph contains.
 */

import { Vec3, setting } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { recalculateNormals } from '../mesh/ops';
import { Bitmap } from './contour';
import { GenerateStats } from './generate';
import { NeuralDepth } from './neuralDepth';

export interface SceneDepthOptions {
  /** Grid cells across the longer side. */
  resolution?: number;
  /** World size of the longer side. */
  targetWidth?: number;
  /** How far the nearest point stands in front of the furthest, in world units. */
  relief?: number;
  /**
   * Where to break the surface rather than stretch it, 0..1.
   *
   * Nothing in a photograph connects the near edge of a table to the wall
   * behind it, but a grid laid over the picture does, and left alone it drags
   * a sheet of rubber between them. Neighbours whose depth differs by more
   * than this fraction of the frame's whole range are not joined. Lower cuts
   * more; 1 never cuts.
   */
  cut?: number;
  /** Smoothing passes over the depth before it becomes geometry. */
  smoothing?: number;
}

export interface SceneDepthResult {
  mesh: Mesh;
  stats: GenerateStats;
  /** Fraction of the frame that ended up as surface rather than cut away. */
  covered: number;
}

/** Bilinear read of the depth map in its own coordinates. */
function sample(depth: NeuralDepth, u: number, v: number): number {
  const x = Math.max(0, Math.min(depth.width - 1, u * (depth.width - 1)));
  const y = Math.max(0, Math.min(depth.height - 1, v * (depth.height - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(depth.width - 1, x0 + 1);
  const y1 = Math.min(depth.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = depth.data[y0 * depth.width + x0] * (1 - fx) + depth.data[y0 * depth.width + x1] * fx;
  const b = depth.data[y1 * depth.width + x0] * (1 - fx) + depth.data[y1 * depth.width + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Soften the depth without rounding off the steps between things.
 *
 * A plain blur across a depth discontinuity invents a ramp from the near
 * object to the far one, which is exactly the rubber sheet the cutting below
 * exists to avoid. Neighbours further apart than the cut distance are left out
 * of the average, so a surface is smoothed and a step is not.
 */
function smoothWithinSurfaces(
  values: Float32Array, nx: number, ny: number, limit: number, passes: number,
): void {
  if (passes <= 0) return;
  const next = new Float32Array(values.length);
  for (let p = 0; p < passes; p++) {
    next.set(values);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        const here = values[i];
        let sum = 0;
        let n = 0;
        const take = (j: number): void => {
          if (Math.abs(values[j] - here) > limit) return;
          sum += values[j];
          n++;
        };
        if (x > 0) take(i - 1);
        if (x + 1 < nx) take(i + 1);
        if (y > 0) take(i - nx);
        if (y + 1 < ny) take(i + nx);
        if (n === 0) continue;
        next[i] = here * 0.5 + (sum / n) * 0.5;
      }
    }
    values.set(next);
  }
}

/**
 * Build the surface.
 *
 * The scene is Z-up and its front view looks along +Y, so the picture's own
 * axes go to X across and Z up, with distance running away from the camera
 * along +Y — the same convention `meshFromPhoto` uses, so a scene and an
 * object built from the same photograph stand the same way up.
 */
export function meshFromDepth(
  bitmap: Bitmap, depth: NeuralDepth, options: SceneDepthOptions = {},
): SceneDepthResult {
  const started = Date.now();
  const mesh = new Mesh();
  const empty = (): SceneDepthResult => ({
    mesh,
    covered: 0,
    stats: { ms: Date.now() - started, loops: 0, verts: 0, faces: 0 },
  });
  if (bitmap.width === 0 || bitmap.height === 0 || depth.data.length === 0) return empty();

  const resolution = Math.floor(setting(options.resolution, 220, 16, 512));
  const targetWidth = setting(options.targetWidth, 3, 0.01, 1e4);
  const relief = setting(options.relief, 1.1, 0.01, 1e3);
  const cut = setting(options.cut, 0.06, 0.001, 1);
  const smoothing = Math.floor(setting(options.smoothing, 1, 0, 8));

  const aspect = bitmap.width / bitmap.height;
  const nx = aspect >= 1 ? resolution : Math.max(2, Math.round(resolution * aspect));
  const ny = aspect >= 1 ? Math.max(2, Math.round(resolution / aspect)) : resolution;
  const worldW = aspect >= 1 ? targetWidth : targetWidth * aspect;
  const worldH = aspect >= 1 ? targetWidth / aspect : targetWidth;

  const nodes = nx * ny;
  const field = new Float32Array(nodes);
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const v = sample(depth, nx === 1 ? 0 : gx / (nx - 1), ny === 1 ? 0 : gy / (ny - 1));
      // A depth map is not always ours: it can be handed in by a caller, and
      // one bad value would otherwise put a NaN in a vertex, which spreads
      // through the normals and renders the whole object as nothing.
      field[gy * nx + gx] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    }
  }
  smoothWithinSurfaces(field, nx, ny, cut, smoothing);

  const index = new Int32Array(nodes).fill(-1);
  const uv: (number[] | null)[] = [];
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const g = gy * nx + gx;
      const x = ((nx === 1 ? 0 : gx / (nx - 1)) - 0.5) * worldW;
      const z = (0.5 - (ny === 1 ? 0 : gy / (ny - 1))) * worldH;
      // The map is inverse depth: 1 is nearest. Nearest sits at -Y, which is
      // where the front view looks from.
      const y = (0.5 - field[g]) * relief;
      index[g] = mesh.positions.push(new Vec3(x, y, z)) - 1;
    }
  }

  const uvAt = (gx: number, gy: number): [number, number] => [
    nx === 1 ? 0 : gx / (nx - 1),
    // The renderer uploads textures flipped, so v runs up from the bottom.
    1 - (ny === 1 ? 0 : gy / (ny - 1)),
  ];

  let quads = 0;
  let cutCells = 0;
  for (let gy = 0; gy + 1 < ny; gy++) {
    for (let gx = 0; gx + 1 < nx; gx++) {
      const a = gy * nx + gx;
      const b = a + 1;
      const c = a + nx + 1;
      const d = a + nx;
      // One cell is either wholly on a surface or spanning a step. Spanning
      // cells are dropped rather than triangulated across, which is what turns
      // a rubber sheet into a foreground standing in front of a background.
      const lo = Math.min(field[a], field[b], field[c], field[d]);
      const hi = Math.max(field[a], field[b], field[c], field[d]);
      if (hi - lo > cut) { cutCells++; continue; }
      // Wound so the surface faces -Y, towards where the front view looks.
      mesh.faces.push([index[d], index[c], index[b], index[a]]);
      mesh.faceMaterial.push(0);
      uv.push([...uvAt(gx, gy + 1), ...uvAt(gx + 1, gy + 1), ...uvAt(gx + 1, gy), ...uvAt(gx, gy)]);
      quads++;
    }
  }

  if (quads === 0) return empty();

  mesh.faceUV = uv;
  mesh.setAllSmooth(true);
  // Vertices no face uses are left behind by the cutting; dropping them keeps
  // the exports clean and the vertex count honest.
  mesh.cleanDegenerate();
  recalculateNormals(mesh);
  mesh.markDirty();

  const cells = (nx - 1) * (ny - 1);
  return {
    mesh,
    covered: cells === 0 ? 0 : quads / cells,
    stats: {
      ms: Date.now() - started,
      loops: cutCells,
      verts: mesh.vertCount,
      faces: mesh.faceCount,
    },
  };
}
