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

/**
 * How far inside the outline the silhouette reads its colour, in grid cells.
 *
 * Grid nodes on the outline sit exactly where the photograph stops being the
 * subject and starts being whatever it was standing on, so reading the texture
 * where they sit wraps the model in a fringe of that: brown streaks down every
 * edge of a vase photographed on a table. Reading from a little further in
 * costs a sliver of accuracy along the silhouette and removes the fringe.
 */
const OUTLINE_INSET_CELLS = 1.5;

/**
 * The least the inset is ever allowed to be, in source pixels.
 *
 * A coarse grid over a small subject makes a cell smaller than a pixel, and an
 * inset measured in cells then rounds to nothing. One pixel in is not a margin
 * either — these wall faces are a lip seen edge-on, so their coordinates
 * change fast over very few pixels and the renderer answers that by sampling a
 * coarse mip level, which averages a wide neighbourhood. Two pixels is the
 * floor.
 */
const MIN_INSET_PX = 2;

/**
 * For every pixel of the matte, the pixel it should read its colour from.
 *
 * Pixels at least `radius` inside the subject read themselves. Everything else
 * — the boundary, and the background — is sent to the nearest pixel that is
 * that far in. Two breadth-first passes: the first measures how deep each
 * pixel is, the second carries the deep pixels' own indices outward.
 *
 * Both walk the eight neighbours, so what the first pass measures is the
 * larger of the two axis distances. That is never more than the straight-line
 * distance, so a pixel this calls `radius` deep really is at least that far
 * from the background — the error is on the side of insetting further, which
 * is the harmless side.
 *
 * Null when the subject is nowhere `radius` thick, which leaves the caller to
 * read where it sits; there is no better answer for a subject two pixels wide.
 */
function insetLookup(matte: Matte, radius: number): Int32Array | null {
  const { width, height, data } = matte;
  const n = width * height;
  if (n === 0) return null;
  const depth = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] < 0.5) {
      depth[i] = 0;
      queue[tail++] = i;
    }
  }
  // An all-subject frame has no background to measure from, so everything in
  // it is as deep as it needs to be and reads where it sits.
  if (tail === 0) return null;
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    const d = depth[i] + 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ax = x + dx;
        const ay = y + dy;
        if (ax < 0 || ay < 0 || ax >= width || ay >= height) continue;
        const j = ay * width + ax;
        if (depth[j] !== -1) continue;
        depth[j] = d;
        queue[tail++] = j;
      }
    }
  }

  const source = new Int32Array(n).fill(-1);
  head = 0;
  tail = 0;
  for (let i = 0; i < n; i++) {
    if (depth[i] >= radius) {
      source[i] = i;
      queue[tail++] = i;
    }
  }
  if (tail === 0) return null;
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const ax = x + dx;
        const ay = y + dy;
        if (ax < 0 || ay < 0 || ax >= width || ay >= height) continue;
        const j = ay * width + ax;
        if (source[j] !== -1) continue;
        source[j] = source[i];
        queue[tail++] = j;
      }
    }
  }
  return source;
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

  // The grid covers the subject, not the photograph.
  //
  // Nobody frames a photo tight against the thing in it. A subject filling a
  // quarter of the frame used to get a quarter of the grid, so three quarters
  // of the detail budget went into sampling empty carpet — and the model came
  // out coarse for no reason other than how the photo was cropped. Fitting the
  // grid to the subject's own bounds gets that detail back for nothing.
  const box = subjectBounds(matte);
  if (!box) return empty();

  const cropW = box.x1 - box.x0 + 1;
  const cropH = box.y1 - box.y0 + 1;
  const aspect = cropW / cropH;
  const nx = aspect >= 1 ? resolution : Math.max(2, Math.round(resolution * aspect));
  const ny = aspect >= 1 ? Math.max(2, Math.round(resolution / aspect)) : resolution;
  // Two world units on the longer side; the whole thing is rescaled to
  // targetHeight at the end anyway.
  const worldW = aspect >= 1 ? 2 : 2 * aspect;
  const worldH = aspect >= 1 ? 2 / aspect : 2;
  const pixelToWorld = worldW / Math.max(1, cropW);

  /** Where a grid node sits in the source image, in pixels. */
  const imageAt = (gx: number, gy: number): { px: number; py: number } => ({
    px: box.x0 + (nx === 1 ? 0 : gx / (nx - 1)) * (cropW - 1),
    py: box.y0 + (ny === 1 ? 0 : gy / (ny - 1)) * (cropH - 1),
  });

  const nodes = nx * ny;
  const inside = new Uint8Array(nodes);
  const thickness = new Float32Array(nodes);
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const { px, py } = imageAt(gx, gy);
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
  // Coordinates address the whole photograph, because the whole photograph is
  // what gets stored as the texture — the grid is cropped, the image is not.
  const uvPixel = (px: number, py: number): [number, number] => [
    px / Math.max(1, bitmap.width - 1),
    1 - py / Math.max(1, bitmap.height - 1),
  ];
  const uvAt = (gx: number, gy: number): [number, number] => {
    const { px, py } = imageAt(gx, gy);
    return uvPixel(px, py);
  };

  // Which nodes are on the silhouette: a node with a solid cell on all four
  // sides is in the middle of the subject, anything else is on its edge.
  const onOutline = new Uint8Array(nodes);
  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const g = gy * nx + gx;
      if (!used[g]) continue;
      let solid = 0;
      let touching = 0;
      for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
        const cx = gx + dx;
        const cy = gy + dy;
        if (cx < 0 || cy < 0 || cx + 1 >= nx || cy + 1 >= ny) continue;
        touching++;
        if (cells[cy * (nx - 1) + cx]) solid++;
      }
      onOutline[g] = touching === 4 && solid === 4 ? 0 : 1;
    }
  }

  const cellPx = cropW / Math.max(1, nx - 1);
  const insetRadius = Math.max(MIN_INSET_PX, Math.round(cellPx * OUTLINE_INSET_CELLS));
  const insetSource = insetLookup(matte, insetRadius);

  /** A coordinate for a node on the silhouette, pulled onto the subject. */
  const uvInside = (gx: number, gy: number): [number, number] => {
    if (!insetSource) return uvAt(gx, gy);
    const { px, py } = imageAt(gx, gy);
    const x = Math.max(0, Math.min(matte.width - 1, Math.round(px)));
    const y = Math.max(0, Math.min(matte.height - 1, Math.round(py)));
    const s = insetSource[y * matte.width + x];
    if (s < 0) return uvAt(gx, gy);
    const sx = s % matte.width;
    return uvPixel(sx, (s - sx) / matte.width);
  };

  /**
   * The coordinate for one corner of a face.
   *
   * Corners in the middle of the subject read exactly where they sit, so the
   * photograph lands on the model undistorted. Only the ring on the silhouette
   * is moved, and only far enough to be on the subject.
   */
  const uvForCorner = (gx: number, gy: number): [number, number] => (
    onOutline[gy * nx + gx] ? uvInside(gx, gy) : uvAt(gx, gy)
  );
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
      const ua = uvForCorner(cx, cy);
      const ub = uvForCorner(cx + 1, cy);
      const uc = uvForCorner(cx + 1, cy + 1);
      const ud = uvForCorner(cx, cy + 1);
      addFace([frontIdx[d], frontIdx[c], frontIdx[b], frontIdx[a]], [ud, uc, ub, ua]);
      addFace([backIdx[a], backIdx[b], backIdx[c], backIdx[d]], [ua, ub, uc, ud]);
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
    // Read from inside the subject, never from the silhouette itself. These
    // nodes sit exactly where the photograph has already become the floor, and
    // the wall is a thin lip seen edge-on, so reading where they sit put a
    // stretched smear of floor colour down every edge of every model.
    const up = uvInside(p % nx, Math.floor(p / nx));
    const uq = uvInside(q % nx, Math.floor(q / nx));
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

/** The subject's bounding box in image pixels, or null when there is no subject. */
function subjectBounds(matte: Matte): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = matte.width;
  let y0 = matte.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < matte.height; y++) {
    for (let x = 0; x < matte.width; x++) {
      if (matte.data[y * matte.width + x] < 0.5) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  // A margin of one pixel so the outline is not sitting on the grid's own
  // edge, where the surface would be cut off flat instead of closing over.
  return {
    x0: Math.max(0, x0 - 1),
    y0: Math.max(0, y0 - 1),
    x1: Math.min(matte.width - 1, x1 + 1),
    y1: Math.min(matte.height - 1, y1 + 1),
  };
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
