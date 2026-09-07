import { Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { recalculateNormals } from '../mesh/ops';
import { Bitmap } from './contour';
import { DepthField, DepthOptions, depthFromPhoto } from './depth';
import { Matte, SegmentOptions, matteCoverage, segmentSubject } from './segment';
import { GenerateStats } from './generate';

/**
 * A photograph in, a model out.
 *
 * The other generators in this folder each take one narrow reading of an
 * image: a silhouette becomes a prism, a profile becomes a turned form, a
 * brightness map becomes a relief. All three are useful and all three are
 * obvious the moment you point them at an actual photograph, because a
 * photograph of a real object is not a logo and comes out looking like a
 * cardboard cut-out of itself.
 *
 * This one puts the pieces together into the thing people actually want. The
 * subject is found by colour rather than brightness, so it works on a photo
 * taken in a room. Its outline is inflated by a Poisson solve, so its
 * thickness follows its width the way a real object's does. Its shading is
 * read for surface detail on top of that. The photograph itself is projected
 * back on as a texture, which is the step that decides whether the result
 * looks like the object or like a grey blob in roughly its shape.
 *
 * What it cannot do is see the back, and it does not pretend to: the far side
 * is the near side, shallower. Say that plainly in the interface rather than
 * letting someone discover it by orbiting.
 */

export interface PhotoOptions {
  /** Grid samples along the longer axis. */
  resolution?: number;
  /** World height of the finished model. */
  targetHeight?: number;
  /** Multiplier on the reconstructed thickness. */
  depthScale?: number;
  /** How much of the front's depth the unseen back gets, 0 flat to 1 mirrored. */
  back?: number;
  segment?: SegmentOptions;
  depth?: DepthOptions;
  /** Reuse a matte already computed for the preview instead of finding it again. */
  matte?: Matte;
  /**
   * Reuse a depth field already solved for this matte.
   *
   * Finding the subject and solving its thickness are the slow half of this
   * and neither depends on the grid resolution or the target height, so a
   * panel dragging those sliders hands the same field back each time rather
   * than paying for it sixty times a second.
   */
  field?: DepthField;
}

export interface PhotoResult {
  mesh: Mesh;
  stats: GenerateStats;
  /** The subject mask this was built from, for the preview to draw. */
  matte: Matte;
  /** Fraction of the frame the subject covered. */
  coverage: number;
}

/** Bilinear read of a single-channel plane. */
function samplePlane(plane: Float32Array, width: number, height: number, px: number, py: number): number {
  const x = Math.max(0, Math.min(width - 1, px));
  const y = Math.max(0, Math.min(height - 1, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = plane[y0 * width + x0] * (1 - fx) + plane[y0 * width + x1] * fx;
  const b = plane[y1 * width + x0] * (1 - fx) + plane[y1 * width + x1] * fx;
  return a * (1 - fy) + b * fy;
}

export function meshFromPhoto(bitmap: Bitmap, options: PhotoOptions = {}): PhotoResult {
  const started = Date.now();
  const resolution = Math.max(24, Math.min(400, Math.floor(options.resolution ?? 160)));
  const targetHeight = options.targetHeight ?? 2;
  const depthScale = Math.max(0.02, Math.min(4, options.depthScale ?? 1));
  const back = Math.max(0, Math.min(1, options.back ?? 0.8));

  const matte = options.matte ?? segmentSubject(bitmap, options.segment);
  const field = options.field ?? depthFromPhoto(bitmap, matte, options.depth);
  const mesh = new Mesh();
  const empty = (): PhotoResult => ({
    mesh,
    matte,
    coverage: matteCoverage(matte),
    stats: { ms: Date.now() - started, loops: 0, verts: 0, faces: 0 },
  });
  if (field.peak <= 0) return empty();

  const aspect = bitmap.width / bitmap.height;
  const nx = aspect >= 1 ? resolution : Math.max(2, Math.round(resolution * aspect));
  const ny = aspect >= 1 ? Math.max(2, Math.round(resolution / aspect)) : resolution;
  // The grid spans the image, one world unit wide per world unit tall at the
  // image's own aspect; the whole thing is rescaled to targetHeight at the end.
  const worldW = aspect >= 1 ? 2 : 2 * aspect;
  const worldH = aspect >= 1 ? 2 / aspect : 2;
  const pixelToWorld = worldW / Math.max(1, bitmap.width);

  const nodes = nx * ny;
  const inside = new Uint8Array(nodes);
  const thickness = new Float32Array(nodes);
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const u = nx === 1 ? 0 : gx / (nx - 1);
      const v = ny === 1 ? 0 : gy / (ny - 1);
      const px = u * (bitmap.width - 1);
      const py = v * (bitmap.height - 1);
      const g = gy * nx + gx;
      inside[g] = samplePlane(matte.data, matte.width, matte.height, px, py) >= 0.5 ? 1 : 0;
      thickness[g] = inside[g]
        ? samplePlane(field.data, field.width, field.height, px, py) * pixelToWorld * depthScale
        : 0;
    }
  }

  const cells = solidCells(inside, nx, ny);

  const frontIdx = new Int32Array(nodes).fill(-1);
  const backIdx = new Int32Array(nodes).fill(-1);
  const used = new Uint8Array(nodes);
  for (let cy = 0; cy + 1 < ny; cy++) {
    for (let cx = 0; cx + 1 < nx; cx++) {
      if (!cells[cy * (nx - 1) + cx]) continue;
      used[cy * nx + cx] = 1;
      used[cy * nx + cx + 1] = 1;
      used[(cy + 1) * nx + cx] = 1;
      used[(cy + 1) * nx + cx + 1] = 1;
    }
  }
  // The scene is Z-up and its front view looks along +Y, so the photograph's
  // own axes go to X across and Z up, with thickness towards the camera.
  // Building it flat in XY instead — which is what a relief map wants — leaves
  // a photograph of a person lying face up on the floor.
  const nodeAt = (gx: number, gy: number): { x: number; z: number } => ({
    x: ((nx === 1 ? 0 : gx / (nx - 1)) - 0.5) * worldW,
    z: (0.5 - (ny === 1 ? 0 : gy / (ny - 1))) * worldH,
  });
  // The outline is where the inflation goes to nothing, so the joining wall
  // there would be a ring of zero-area faces — geometry that renders as
  // nothing and breaks every normal computed from it. A floor of a fraction
  // of the model's depth turns it into a thin lip instead, which is both
  // valid and closer to how a real edge looks.
  let deepest = 0;
  for (let g = 0; g < nodes; g++) if (thickness[g] > deepest) deepest = thickness[g];
  const minThickness = deepest * 0.004;

  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const g = gy * nx + gx;
      if (!used[g]) continue;
      const { x, z } = nodeAt(gx, gy);
      const t = Math.max(minThickness, thickness[g]);
      frontIdx[g] = mesh.positions.push(new Vec3(x, -t, z)) - 1;
      backIdx[g] = mesh.positions.push(new Vec3(x, t * back, z)) - 1;
    }
  }

  const uv: (number[] | null)[] = [];
  // The renderer uploads textures flipped, so v runs up from the bottom of
  // the image while the grid runs down from its top.
  const uvAt = (gx: number, gy: number): [number, number] => [
    nx === 1 ? 0 : gx / (nx - 1),
    ny === 1 ? 1 : 1 - gy / (ny - 1),
  ];
  const addFace = (corners: number[], coords: [number, number][]): void => {
    mesh.faces.push(corners);
    mesh.faceMaterial.push(0);
    uv.push(coords.flat());
  };

  for (let cy = 0; cy + 1 < ny; cy++) {
    for (let cx = 0; cx + 1 < nx; cx++) {
      if (!cells[cy * (nx - 1) + cx]) continue;
      const a = cy * nx + cx;
      const b = a + 1;
      const c = a + nx + 1;
      const d = a + nx;
      // Wound so the front faces -Y, which is where the front view looks
      // from; the back is the same quad the other way round.
      addFace(
        [frontIdx[d], frontIdx[c], frontIdx[b], frontIdx[a]],
        [uvAt(cx, cy + 1), uvAt(cx + 1, cy + 1), uvAt(cx + 1, cy), uvAt(cx, cy)],
      );
      addFace(
        [backIdx[a], backIdx[b], backIdx[c], backIdx[d]],
        [uvAt(cx, cy), uvAt(cx + 1, cy), uvAt(cx + 1, cy + 1), uvAt(cx, cy + 1)],
      );
    }
  }

  // The wall that joins the two surfaces along the outline. Without it the
  // model is two loose shells, which looks fine in the viewport and fails the
  // moment anyone booleans it, prints it or exports it.
  for (const edge of boundaryEdges(cells, nx, ny)) {
    const { p, q } = edge;
    const np = nodeAt(p % nx, Math.floor(p / nx));
    const nq = nodeAt(q % nx, Math.floor(q / nx));
    // Point the wall away from the cell it belongs to rather than working the
    // winding out per direction — four cases is four chances to get one wrong.
    const inner = nodeAt(edge.cx + 0.5, edge.cy + 0.5);
    const outward = (np.x + nq.x) / 2 - inner.x;
    const outwardZ = (np.z + nq.z) / 2 - inner.z;
    // The normal the quad [front p, front q, back q, back p] actually has,
    // which is the edge direction crossed with the front-to-back direction.
    const normalX = np.z - nq.z;
    const normalZ = nq.x - np.x;
    const facingOut = normalX * outward + normalZ * outwardZ > 0;
    const corners = facingOut
      ? [frontIdx[p], frontIdx[q], backIdx[q], backIdx[p]]
      : [frontIdx[q], frontIdx[p], backIdx[p], backIdx[q]];
    const up = uvAt(p % nx, Math.floor(p / nx));
    const uq = uvAt(q % nx, Math.floor(q / nx));
    addFace(corners, facingOut ? [up, uq, uq, up] : [uq, up, up, uq]);
  }

  if (mesh.faces.length === 0) return empty();

  mesh.faceUV = uv;
  mesh.setAllSmooth(true);
  scaleToHeight(mesh, targetHeight);
  recalculateNormals(mesh);
  mesh.markDirty();

  return {
    mesh,
    matte,
    coverage: matteCoverage(matte),
    stats: { ms: Date.now() - started, loops: 1, verts: mesh.vertCount, faces: mesh.faceCount },
  };
}

/**
 * Resize so the model stands a known height whatever the photograph's framing,
 * centred left to right and sitting on the floor rather than half through it.
 */
function scaleToHeight(mesh: Mesh, targetHeight: number): void {
  const box = mesh.bounds();
  if (!box.valid || targetHeight <= 0) return;
  const span = box.max.z - box.min.z;
  if (span <= 1e-9) return;
  const k = targetHeight / span;
  const cx = (box.min.x + box.max.x) / 2;
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i];
    mesh.positions[i] = new Vec3((p.x - cx) * k, p.y * k, (p.z - box.min.z) * k);
  }
}

/**
 * Which grid cells are solid: all four corners inside the subject, and no
 * corner where the solid region pinches to a point.
 *
 * The pinch matters. Two cells meeting only at a corner give that corner four
 * wall quads instead of two, and the result is a mesh that is not a surface
 * any more — every downstream operator that walks edges then has to guess.
 * A single cell is cheap to give up and the shape does not miss it.
 */
function solidCells(inside: Uint8Array, nx: number, ny: number): Uint8Array {
  const cw = nx - 1;
  const ch = ny - 1;
  const cells = new Uint8Array(Math.max(0, cw * ch));
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const a = cy * nx + cx;
      cells[cy * cw + cx] = inside[a] && inside[a + 1] && inside[a + nx] && inside[a + nx + 1] ? 1 : 0;
    }
  }
  // Removing a cell can pinch somewhere else, so this runs until it settles.
  for (let pass = 0; pass < 8; pass++) {
    let removed = 0;
    for (let gy = 1; gy < ny - 1; gy++) {
      for (let gx = 1; gx < nx - 1; gx++) {
        const nw = cells[(gy - 1) * cw + gx - 1];
        const ne = cells[(gy - 1) * cw + gx];
        const sw = cells[gy * cw + gx - 1];
        const se = cells[gy * cw + gx];
        if (nw && se && !ne && !sw) { cells[gy * cw + gx] = 0; removed++; }
        else if (ne && sw && !nw && !se) { cells[gy * cw + gx - 1] = 0; removed++; }
      }
    }
    if (!removed) break;
  }
  return cells;
}

interface BoundaryEdge {
  /** Grid node indices at each end. */
  p: number;
  q: number;
  /** Grid coordinates of the solid cell's centre, so the wall can face away from it. */
  cx: number;
  cy: number;
}

/** Every grid edge with solid on one side and nothing on the other. */
function boundaryEdges(cells: Uint8Array, nx: number, ny: number): BoundaryEdge[] {
  const cw = nx - 1;
  const ch = ny - 1;
  const out: BoundaryEdge[] = [];
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      if (!cells[cy * cw + cx]) continue;
      const a = cy * nx + cx;
      if (cy === 0 || !cells[(cy - 1) * cw + cx]) out.push({ p: a, q: a + 1, cx, cy });
      if (cy + 1 === ch || !cells[(cy + 1) * cw + cx]) out.push({ p: a + nx, q: a + nx + 1, cx, cy });
      if (cx === 0 || !cells[cy * cw + cx - 1]) out.push({ p: a, q: a + nx, cx, cy });
      if (cx + 1 === cw || !cells[cy * cw + cx + 1]) out.push({ p: a + 1, q: a + nx + 1, cx, cy });
    }
  }
  return out;
}
