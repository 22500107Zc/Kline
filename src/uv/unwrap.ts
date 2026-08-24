import { Vec3, clamp } from '../core/math';
import { Mesh } from '../mesh/Mesh';

/**
 * UV unwrapping.
 *
 * Two routes to the same place. Projection operators (cube, cylinder, sphere,
 * planar) assign coordinates straight from geometry and are exact for the
 * shapes they name. Unwrapping proper cuts the surface into islands — along
 * user seams, or where the surface folds past an angle limit — flattens each
 * island with least-squares conformal maps, then packs the islands into the
 * unit square at a shared texel density.
 */

export interface IslandOptions {
  /**
   * Start a new island once a face tilts more than this many degrees away from
   * the island's own axis. Comparing against the island rather than the
   * immediate neighbour is what stops a sphere growing into one unflattenable
   * island: every island stays inside a cone and so has a usable projection.
   */
  angleLimit?: number;
  /** Respect the mesh's seam flags. */
  useSeams?: boolean;
  /** Only consider these faces; others are left alone. */
  faces?: Iterable<number>;
}

/** Group faces into connected regions, cut by seams and/or a sharpness limit. */
export function uvIslands(mesh: Mesh, opts: IslandOptions = {}): number[][] {
  const t = mesh.topology();
  const pool = opts.faces ? new Set(opts.faces) : new Set(mesh.faces.map((_, f) => f));
  const cosLimit = opts.angleLimit === undefined ? -2 : Math.cos(opts.angleLimit * Math.PI / 180);
  const seen = new Set<number>();
  const islands: number[][] = [];

  for (const start of pool) {
    if (seen.has(start)) continue;
    const island: number[] = [];
    const stack = [start];
    const axis = t.faceNormals[start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      island.push(f);
      const loop = mesh.faces[f];
      for (let i = 0; i < loop.length; i++) {
        const ei = t.faceEdges[f][i];
        if (ei < 0) continue;
        const e = t.edges[ei];
        if (opts.useSeams && mesh.isSeam(e.a, e.b)) continue;
        for (const nf of e.faces) {
          if (nf === f || seen.has(nf) || !pool.has(nf)) continue;
          if (cosLimit > -2 && axis.dot(t.faceNormals[nf]) < cosLimit) continue;
          seen.add(nf);
          stack.push(nf);
        }
      }
    }
    islands.push(island);
  }
  return islands;
}

function frameFor(normal: Vec3): { x: Vec3; y: Vec3 } {
  const n = normal.lengthSq() > 1e-12 ? normal.normalized() : new Vec3(0, 0, 1);
  const helper = Math.abs(n.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  const x = helper.cross(n).normalized();
  return { x, y: n.cross(x).normalized() };
}

interface IslandLayout {
  faces: number[];
  /** Per face, the flat [u,v,…] run. */
  uv: number[][];
  worldArea: number;
}

function planarLayout(mesh: Mesh, faces: number[]): IslandLayout {
  const t = mesh.topology();
  const n = new Vec3();
  let worldArea = 0;
  for (const f of faces) {
    const a = mesh.faceArea(f);
    worldArea += a;
    n.addInPlace(t.faceNormals[f].scale(Math.max(a, 1e-9)));
  }
  const { x, y } = frameFor(n);
  const uv = faces.map((f) => {
    const out: number[] = [];
    for (const v of mesh.faces[f]) {
      const p = mesh.positions[v];
      out.push(p.dot(x), p.dot(y));
    }
    return out;
  });
  return { faces, uv, worldArea };
}

/** Sparse least-squares solve by conjugate gradient on the normal equations. */
function solveLeastSquares(
  rows: { cols: number[]; vals: number[] }[], rhs: number[], cols: number, iterations: number,
): Float64Array {
  const x = new Float64Array(cols);
  const mulA = (v: Float64Array): Float64Array => {
    const out = new Float64Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      let s = 0;
      for (let k = 0; k < row.cols.length; k++) s += row.vals[k] * v[row.cols[k]];
      out[r] = s;
    }
    return out;
  };
  const mulAT = (v: Float64Array): Float64Array => {
    const out = new Float64Array(cols);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const s = v[r];
      if (s === 0) continue;
      for (let k = 0; k < row.cols.length; k++) out[row.cols[k]] += row.vals[k] * s;
    }
    return out;
  };

  const b = new Float64Array(rhs);
  let r = mulAT(b);
  const p = new Float64Array(r);
  let rr = 0;
  for (let i = 0; i < cols; i++) rr += r[i] * r[i];
  const target = rr * 1e-12;
  for (let it = 0; it < iterations && rr > target; it++) {
    const ap = mulAT(mulA(p));
    let pap = 0;
    for (let i = 0; i < cols; i++) pap += p[i] * ap[i];
    if (Math.abs(pap) < 1e-30) break;
    const alpha = rr / pap;
    for (let i = 0; i < cols; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    let rr2 = 0;
    for (let i = 0; i < cols; i++) rr2 += r[i] * r[i];
    const beta = rr2 / rr;
    for (let i = 0; i < cols; i++) p[i] = r[i] + beta * p[i];
    rr = rr2;
  }
  return x;
}

/**
 * Flatten one island with a least-squares conformal map. Two vertices are
 * pinned to their planar-projected positions, which fixes the otherwise free
 * translation, rotation and scale of the solution.
 */
function lscmLayout(mesh: Mesh, faces: number[]): IslandLayout {
  const seed = planarLayout(mesh, faces);
  const local = new Map<number, number>();
  const verts: number[] = [];
  for (const f of faces) {
    for (const v of mesh.faces[f]) {
      if (!local.has(v)) {
        local.set(v, verts.length);
        verts.push(v);
      }
    }
  }
  const n = verts.length;
  if (n < 3) return seed;

  // Seed positions, used both for pinning and as the fallback.
  const seedUV = new Float64Array(n * 2);
  for (let i = 0; i < faces.length; i++) {
    const loop = mesh.faces[faces[i]];
    for (let k = 0; k < loop.length; k++) {
      const li = local.get(loop[k])!;
      seedUV[li * 2] = seed.uv[i][k * 2];
      seedUV[li * 2 + 1] = seed.uv[i][k * 2 + 1];
    }
  }

  // Pin the two most distant seed points so the solve is well posed.
  let p0 = 0;
  let p1 = 1;
  let bestD = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < Math.min(n, i + 24); j++) {
      const dx = seedUV[i * 2] - seedUV[j * 2];
      const dy = seedUV[i * 2 + 1] - seedUV[j * 2 + 1];
      const d = dx * dx + dy * dy;
      if (d > bestD) {
        bestD = d;
        p0 = i;
        p1 = j;
      }
    }
  }
  if (bestD <= 0) return seed;

  const pinned = new Set([p0, p1]);
  const freeIndex = new Int32Array(n).fill(-1);
  let freeCount = 0;
  for (let i = 0; i < n; i++) if (!pinned.has(i)) freeIndex[i] = freeCount++;
  if (freeCount === 0) return seed;

  const rows: { cols: number[]; vals: number[] }[] = [];
  const rhs: number[] = [];
  const addRow = (
    terms: { v: number; s: number; t: number }[],
  ): void => {
    const cols: number[] = [];
    const vals: number[] = [];
    let constant = 0;
    for (const term of terms) {
      if (pinned.has(term.v)) {
        constant += term.s * seedUV[term.v * 2] + term.t * seedUV[term.v * 2 + 1];
      } else {
        const c = freeIndex[term.v];
        cols.push(c * 2, c * 2 + 1);
        vals.push(term.s, term.t);
      }
    }
    if (cols.length === 0) return;
    rows.push({ cols, vals });
    rhs.push(-constant);
  };

  for (const f of faces) {
    const loop = mesh.faces[f];
    for (let k = 1; k + 1 < loop.length; k++) {
      const tri = [local.get(loop[0])!, local.get(loop[k])!, local.get(loop[k + 1])!];
      const a = mesh.positions[verts[tri[0]]];
      const b = mesh.positions[verts[tri[1]]];
      const c = mesh.positions[verts[tri[2]]];
      const ab = b.sub(a);
      const ac = c.sub(a);
      const nrm = ab.cross(ac);
      const twoArea = nrm.length();
      if (twoArea < 1e-14) continue;
      const xh = ab.normalized();
      const yh = nrm.normalized().cross(xh);
      // Triangle laid flat in its own plane.
      const x1 = 0;
      const y1 = 0;
      const x2 = ab.length();
      const y2 = 0;
      const x3 = ac.dot(xh);
      const y3 = ac.dot(yh);
      const d = Math.sqrt(twoArea);
      const w = [
        [(x3 - x2) / d, (y3 - y2) / d],
        [(x1 - x3) / d, (y1 - y3) / d],
        [(x2 - x1) / d, (y2 - y1) / d],
      ];
      // Re: sum(a*s - b*t) = 0
      addRow(tri.map((v, i) => ({ v, s: w[i][0], t: -w[i][1] })));
      // Im: sum(b*s + a*t) = 0
      addRow(tri.map((v, i) => ({ v, s: w[i][1], t: w[i][0] })));
    }
  }
  if (rows.length === 0) return seed;

  const sol = solveLeastSquares(rows, rhs, freeCount * 2, Math.min(4000, freeCount * 8 + 100));
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    if (pinned.has(i)) {
      out[i * 2] = seedUV[i * 2];
      out[i * 2 + 1] = seedUV[i * 2 + 1];
    } else {
      const c = freeIndex[i];
      out[i * 2] = sol[c * 2];
      out[i * 2 + 1] = sol[c * 2 + 1];
    }
  }
  for (let i = 0; i < n * 2; i++) if (!Number.isFinite(out[i])) return seed;

  const uv = faces.map((f) => {
    const run: number[] = [];
    for (const v of mesh.faces[f]) {
      const li = local.get(v)!;
      run.push(out[li * 2], out[li * 2 + 1]);
    }
    return run;
  });

  // A conformal solve can settle on the mirrored solution; flip it back.
  let signed = 0;
  for (const run of uv) {
    for (let i = 0; i < run.length; i += 2) {
      const j = (i + 2) % run.length;
      signed += run[i] * run[j + 1] - run[j] * run[i + 1];
    }
  }
  if (signed < 0) for (const run of uv) for (let i = 0; i < run.length; i += 2) run[i] = -run[i];

  return { faces, uv, worldArea: seed.worldArea };
}

function layoutArea(layout: IslandLayout): number {
  let a = 0;
  for (const run of layout.uv) {
    for (let i = 0; i < run.length; i += 2) {
      const j = (i + 2) % run.length;
      a += run[i] * run[j + 1] - run[j] * run[i + 1];
    }
  }
  return Math.abs(a) * 0.5;
}

/** Rotate an island to whichever of a few angles gives the tightest box. */
function orientIsland(layout: IslandLayout): void {
  let best = { angle: 0, area: Infinity };
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const run of layout.uv) {
      for (let i = 0; i < run.length; i += 2) {
        const x = run[i] * c - run[i + 1] * s;
        const y = run[i] * s + run[i + 1] * c;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < best.area) best = { angle: a, area };
  }
  if (best.angle === 0) return;
  const c = Math.cos(best.angle);
  const s = Math.sin(best.angle);
  for (const run of layout.uv) {
    for (let i = 0; i < run.length; i += 2) {
      const x = run[i];
      const y = run[i + 1];
      run[i] = x * c - y * s;
      run[i + 1] = x * s + y * c;
    }
  }
}

/**
 * Scale every island to a shared texel density, then shelf-pack them into the
 * unit square and write the result onto the mesh.
 */
export function packIslands(mesh: Mesh, layouts: IslandLayout[], margin = 0.01): void {
  const boxes: { l: IslandLayout; w: number; h: number; x: number; y: number; px: number; py: number }[] = [];
  for (const layout of layouts) {
    const uvArea = layoutArea(layout);
    // Equal texel density: an island covering twice the surface gets twice the
    // UV area, so a single texture resolves the whole model evenly.
    const scale = uvArea > 1e-12 ? Math.sqrt(layout.worldArea / uvArea) : 1;
    orientIsland(layout);
    let x0 = Infinity;
    let y0 = Infinity;
    for (const run of layout.uv) {
      for (let i = 0; i < run.length; i += 2) {
        run[i] *= scale;
        run[i + 1] *= scale;
        if (run[i] < x0) x0 = run[i];
        if (run[i + 1] < y0) y0 = run[i + 1];
      }
    }
    let w = 0;
    let h = 0;
    for (const run of layout.uv) {
      for (let i = 0; i < run.length; i += 2) {
        run[i] -= x0;
        run[i + 1] -= y0;
        if (run[i] > w) w = run[i];
        if (run[i + 1] > h) h = run[i + 1];
      }
    }
    boxes.push({ l: layout, w, h, x: 0, y: 0, px: 0, py: 0 });
  }

  boxes.sort((a, b) => b.h - a.h);
  const total = boxes.reduce((s, b) => s + (b.w + margin) * (b.h + margin), 0);
  const base = Math.max(1e-6, Math.sqrt(total));
  // Shelf packing is very sensitive to the row width, and a bad guess wastes
  // half the texture; trying a spread of widths costs nothing here.
  let bestExtent = Infinity;
  for (const mult of [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.8, 2.2]) {
    const rowWidth = base * mult;
    let cx = 0;
    let cy = 0;
    let shelf = 0;
    let usedW = 0;
    for (const b of boxes) {
      if (cx > 0 && cx + b.w + margin > rowWidth) {
        cx = 0;
        cy += shelf + margin;
        shelf = 0;
      }
      b.x = cx;
      b.y = cy;
      cx += b.w + margin;
      if (cx > usedW) usedW = cx;
      if (b.h > shelf) shelf = b.h;
    }
    const extent = Math.max(usedW, cy + shelf);
    if (extent < bestExtent - 1e-9) {
      bestExtent = extent;
      for (const b of boxes) {
        b.px = b.x;
        b.py = b.y;
      }
    }
  }
  for (const b of boxes) {
    b.x = b.px;
    b.y = b.py;
  }
  const fit = 1 / Math.max(bestExtent, 1e-6);

  for (const b of boxes) {
    for (let i = 0; i < b.l.faces.length; i++) {
      const run = b.l.uv[i];
      const out: number[] = [];
      for (let k = 0; k < run.length; k += 2) {
        out.push(
          clamp((run[k] + b.x) * fit, 0, 1),
          clamp((run[k + 1] + b.y) * fit, 0, 1),
        );
      }
      mesh.setUV(b.l.faces[i], out);
    }
  }
  mesh.markDirty();
}

export interface UnwrapOptions extends IslandOptions {
  margin?: number;
  /** Skip the conformal solve and just project each island flat. */
  projectOnly?: boolean;
}

/** Full unwrap: split into islands, flatten each, pack. Returns the island count. */
export function unwrap(mesh: Mesh, opts: UnwrapOptions = {}): number {
  const islands = uvIslands(mesh, opts);
  const layouts = islands
    .filter((i) => i.length > 0)
    .map((i) => (opts.projectOnly ? planarLayout(mesh, i) : lscmLayout(mesh, i)));
  packIslands(mesh, layouts, opts.margin ?? 0.01);
  return layouts.length;
}

/** Angle-based unwrap with no seams required — Blender's "Smart UV Project". */
export function smartProject(mesh: Mesh, angleLimit = 66, margin = 0.01): number {
  return unwrap(mesh, { angleLimit, useSeams: true, margin, projectOnly: true });
}

/** Project each face down its dominant world axis. */
export function cubeProject(mesh: Mesh, size = 1): void {
  const t = mesh.topology();
  const s = size > 0 ? 1 / size : 1;
  for (let f = 0; f < mesh.faces.length; f++) {
    const n = t.faceNormals[f];
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    const run: number[] = [];
    for (const v of mesh.faces[f]) {
      const p = mesh.positions[v];
      if (az >= ax && az >= ay) run.push(p.x * s * Math.sign(n.z || 1), p.y * s);
      else if (ax >= ay) run.push(-p.y * s * Math.sign(n.x || 1), p.z * s);
      else run.push(p.x * s * Math.sign(n.y || 1), p.z * s);
    }
    mesh.setUV(f, run.map((x) => x * 0.5 + 0.5));
  }
  mesh.markDirty();
}

/** Wrap around the Z axis. The seam sits where the angle wraps past ±180°. */
export function cylinderProject(mesh: Mesh): void {
  const box = mesh.bounds();
  const c = box.center();
  const h = Math.max(1e-6, box.size().z);
  for (let f = 0; f < mesh.faces.length; f++) {
    const run: number[] = [];
    const angles: number[] = [];
    for (const v of mesh.faces[f]) {
      const p = mesh.positions[v];
      angles.push(Math.atan2(p.y - c.y, p.x - c.x));
    }
    const fixed = unwrapAngles(angles);
    const shift = Math.floor(fixed.reduce((a, b) => a + b, 0) / fixed.length / (Math.PI * 2) + 0.5);
    mesh.faces[f].forEach((v, i) => {
      const p = mesh.positions[v];
      run.push(fixed[i] / (Math.PI * 2) + 0.5 - shift, (p.z - box.min.z) / h);
    });
    mesh.setUV(f, run);
  }
  mesh.markDirty();
}

/** Equirectangular projection about the mesh centre. */
export function sphereProject(mesh: Mesh): void {
  const c = mesh.bounds().center();
  for (let f = 0; f < mesh.faces.length; f++) {
    const angles: number[] = [];
    const lat: number[] = [];
    for (const v of mesh.faces[f]) {
      const p = mesh.positions[v].sub(c);
      angles.push(Math.atan2(p.y, p.x));
      const r = Math.max(1e-9, p.length());
      lat.push(Math.acos(clamp(p.z / r, -1, 1)));
    }
    const fixed = unwrapAngles(angles);
    const shift = Math.floor(fixed.reduce((a, b) => a + b, 0) / fixed.length / (Math.PI * 2) + 0.5);
    const run: number[] = [];
    for (let i = 0; i < fixed.length; i++) {
      run.push(fixed[i] / (Math.PI * 2) + 0.5 - shift, 1 - lat[i] / Math.PI);
    }
    mesh.setUV(f, run);
  }
  mesh.markDirty();
}

/** Flat projection along a world axis. */
export function planarProject(mesh: Mesh, axis: 0 | 1 | 2): void {
  const box = mesh.bounds();
  const size = box.size();
  const sx = Math.max(1e-6, Math.max(size.x, size.y, size.z));
  for (let f = 0; f < mesh.faces.length; f++) {
    const run: number[] = [];
    for (const v of mesh.faces[f]) {
      const p = mesh.positions[v].sub(box.min);
      if (axis === 2) run.push(p.x / sx, p.y / sx);
      else if (axis === 0) run.push(p.y / sx, p.z / sx);
      else run.push(p.x / sx, p.z / sx);
    }
    mesh.setUV(f, run);
  }
  mesh.markDirty();
}

/** Keep a face's angles on one branch so it does not stretch across the seam. */
function unwrapAngles(angles: number[]): number[] {
  if (angles.length === 0) return angles;
  const out = [angles[0]];
  for (let i = 1; i < angles.length; i++) {
    let a = angles[i];
    while (a - out[i - 1] > Math.PI) a -= Math.PI * 2;
    while (a - out[i - 1] < -Math.PI) a += Math.PI * 2;
    out.push(a);
  }
  return out;
}

/** Mark or clear seams on the given edges. */
export function markSeams(mesh: Mesh, edges: Iterable<number>, on: boolean): number {
  const t = mesh.topology();
  let n = 0;
  for (const ei of edges) {
    const e = t.edges[ei];
    if (!e) continue;
    mesh.setSeam(e.a, e.b, on);
    n++;
  }
  return n;
}

/** How far UV area departs from surface area, per face — 1 is undistorted. */
export function stretchPerFace(mesh: Mesh): number[] {
  const out: number[] = [];
  let totalUV = 0;
  let totalWorld = 0;
  for (let f = 0; f < mesh.faces.length; f++) {
    const uv = mesh.uvFor(f);
    if (!uv) {
      out.push(0);
      continue;
    }
    let a = 0;
    for (let i = 0; i < uv.length; i += 2) {
      const j = (i + 2) % uv.length;
      a += uv[i] * uv[j + 1] - uv[j] * uv[i + 1];
    }
    const uvArea = Math.abs(a) * 0.5;
    const world = mesh.faceArea(f);
    totalUV += uvArea;
    totalWorld += world;
    out.push(world > 1e-12 ? uvArea / world : 0);
  }
  const norm = totalWorld > 1e-12 && totalUV > 1e-12 ? totalWorld / totalUV : 1;
  return out.map((v) => v * norm);
}
