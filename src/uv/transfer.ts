import { Vec3, closestPointOnTriangle } from '../core/math';
import { Mesh } from '../mesh/Mesh';

export { closestPointOnTriangle };

/**
 * Texture-coordinate transfer.
 *
 * Most operators change a mesh's topology, which means new corners with no
 * coordinates. Rather than teach every operator its own interpolation rule,
 * anything that cannot carry UVs exactly hands the job here: the pre-edit mesh
 * becomes a surface to sample, and each new corner takes the coordinates of
 * the point closest to it. New geometry that sits on the old surface — a
 * subdivision, a boolean seam, a bevel — lands where it should; new geometry
 * that leaves the surface takes the nearest border's coordinates, which is the
 * only defensible answer.
 */

interface TriRef {
  /** Vertex indices. */
  a: number;
  b: number;
  c: number;
  face: number;
  /** Corner indices within the face, matching the fan triangulation. */
  ca: number;
  cb: number;
  cc: number;
}

/**
 * A mesh prepared for closest-point queries, bucketed into a uniform grid so a
 * transfer is not an all-pairs sweep.
 */
export class SurfaceSampler {
  private tris: TriRef[] = [];
  private cells = new Map<number, number[]>();
  private cell: number;
  private minCell = new Vec3();
  private maxRing = 4;
  readonly empty: boolean;

  constructor(private mesh: Mesh) {
    for (let f = 0; f < mesh.faces.length; f++) {
      const loop = mesh.faces[f];
      for (let i = 1; i + 1 < loop.length; i++) {
        this.tris.push({
          a: loop[0], b: loop[i], c: loop[i + 1], face: f, ca: 0, cb: i, cc: i + 1,
        });
      }
    }
    this.empty = this.tris.length === 0;

    const box = mesh.bounds();
    const size = box.valid ? box.size() : new Vec3(1, 1, 1);
    const span = Math.max(size.x, size.y, size.z, 1e-6);
    // Roughly 32 cells across the longest axis, and never finer than the
    // average triangle, or a dense mesh spends all its time on bookkeeping.
    this.cell = Math.max(span / 32, span / Math.max(4, Math.cbrt(this.tris.length) * 4));
    this.minCell = box.valid ? box.min : new Vec3();

    // Never expand past the grid's own extent; beyond that the brute-force
    // fallback is both cheaper and exact.
    this.maxRing = Math.min(48, Math.ceil(span / this.cell) + 2);

    for (let i = 0; i < this.tris.length; i++) {
      const t = this.tris[i];
      const lo = this.cellOf(this.minOf(t));
      const hi = this.cellOf(this.maxOf(t));
      for (let x = lo[0]; x <= hi[0]; x++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let z = lo[2]; z <= hi[2]; z++) {
            const k = this.key(x, y, z);
            const list = this.cells.get(k);
            if (list) list.push(i);
            else this.cells.set(k, [i]);
          }
        }
      }
    }
  }

  private minOf(t: TriRef): Vec3 {
    const a = this.mesh.positions[t.a];
    const b = this.mesh.positions[t.b];
    const c = this.mesh.positions[t.c];
    return new Vec3(Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.min(a.z, b.z, c.z));
  }

  private maxOf(t: TriRef): Vec3 {
    const a = this.mesh.positions[t.a];
    const b = this.mesh.positions[t.b];
    const c = this.mesh.positions[t.c];
    return new Vec3(Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y), Math.max(a.z, b.z, c.z));
  }

  private cellOf(p: Vec3): [number, number, number] {
    return [
      Math.floor((p.x - this.minCell.x) / this.cell),
      Math.floor((p.y - this.minCell.y) / this.cell),
      Math.floor((p.z - this.minCell.z) / this.cell),
    ];
  }

  private key(x: number, y: number, z: number): number {
    return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  }

  private consider(
    i: number, p: Vec3, seen: Set<number>,
    best: { tri: TriRef; u: number; v: number; w: number; distSq: number } | null,
  ): { tri: TriRef; u: number; v: number; w: number; distSq: number } | null {
    if (seen.has(i)) return best;
    seen.add(i);
    const t = this.tris[i];
    const r = closestPointOnTriangle(
      p, this.mesh.positions[t.a], this.mesh.positions[t.b], this.mesh.positions[t.c],
    );
    const d = r.point.sub(p).lengthSq();
    if (!best || d < best.distSq) return { tri: t, u: r.u, v: r.v, w: r.w, distSq: d };
    return best;
  }

  /** Nearest point on the surface, with the face and barycentrics that produced it. */
  closest(p: Vec3): { tri: TriRef; u: number; v: number; w: number; distSq: number } | null {
    if (this.empty) return null;
    const [cx, cy, cz] = this.cellOf(p);
    let best: { tri: TriRef; u: number; v: number; w: number; distSq: number } | null = null;
    const seen = new Set<number>();

    // Expanding cubic shells. Only the shell itself is visited — walking the
    // whole cube each time makes this cubic in the radius, which is the
    // difference between milliseconds and minutes on a dense mesh.
    for (let ring = 0; ring <= this.maxRing; ring++) {
      if (best && Math.sqrt(best.distSq) <= (ring - 1) * this.cell) return best;
      for (let x = cx - ring; x <= cx + ring; x++) {
        const xEdge = Math.abs(x - cx) === ring;
        for (let y = cy - ring; y <= cy + ring; y++) {
          const yEdge = Math.abs(y - cy) === ring;
          if (xEdge || yEdge) {
            for (let z = cz - ring; z <= cz + ring; z++) {
              const list = this.cells.get(this.key(x, y, z));
              if (list) for (const i of list) best = this.consider(i, p, seen, best);
            }
          } else {
            for (const z of ring === 0 ? [cz] : [cz - ring, cz + ring]) {
              const list = this.cells.get(this.key(x, y, z));
              if (list) for (const i of list) best = this.consider(i, p, seen, best);
            }
          }
        }
      }
    }

    // A point far outside the grid never reaches the data by expanding shells;
    // the exhaustive answer is cheap next to an unbounded walk.
    if (!best) {
      for (let i = 0; i < this.tris.length; i++) best = this.consider(i, p, seen, best);
    }
    return best;
  }

  /** Coordinates at the point on the surface nearest `p`, or null if unmapped. */
  sampleUV(p: Vec3): [number, number] | null {
    const hit = this.closest(p);
    if (!hit) return null;
    const uv = this.mesh.uvFor(hit.tri.face);
    if (!uv) return null;
    const ua = uv[hit.tri.ca * 2];
    const va = uv[hit.tri.ca * 2 + 1];
    const ub = uv[hit.tri.cb * 2];
    const vb = uv[hit.tri.cb * 2 + 1];
    const uc = uv[hit.tri.cc * 2];
    const vc = uv[hit.tri.cc * 2 + 1];
    return [
      ua * hit.u + ub * hit.v + uc * hit.w,
      va * hit.u + vb * hit.v + vc * hit.w,
    ];
  }

  /** Sample every corner of a polygon against one source face, for coherence. */
  sampleFaceCoherent(points: Vec3[]): number[] | null {
    const centre = new Vec3();
    for (const p of points) centre.addInPlace(p);
    const hit = this.closest(centre.scale(1 / Math.max(1, points.length)));
    if (!hit) return null;
    const uv = this.mesh.uvFor(hit.tri.face);
    if (!uv) return null;
    const a = this.mesh.positions[hit.tri.a];
    const b = this.mesh.positions[hit.tri.b];
    const c = this.mesh.positions[hit.tri.c];
    const out: number[] = [];
    for (const p of points) {
      const r = closestPointOnTriangle(p, a, b, c);
      out.push(
        uv[hit.tri.ca * 2] * r.u + uv[hit.tri.cb * 2] * r.v + uv[hit.tri.cc * 2] * r.w,
        uv[hit.tri.ca * 2 + 1] * r.u + uv[hit.tri.cb * 2 + 1] * r.v + uv[hit.tri.cc * 2 + 1] * r.w,
      );
    }
    return out;
  }
}

/**
 * Give every face of `target` that lacks coordinates the ones from the point
 * of `source` nearest each corner. Returns how many faces were filled in.
 */
/**
 * What a transfer had to do, for a caller that has to report on its quality.
 *
 * `reseamed` is the count of faces that could not take their corners'
 * coordinates directly: those straddled a seam in the source and were
 * re-sampled against a single source face instead, which is the right answer
 * and is not the *same* answer. A caller claiming a lossless transfer needs to
 * know it happened.
 */
export interface TransferStats {
  /** Faces that were candidates for coordinates. */
  considered: number;
  /** Faces that got them. */
  filled: number;
  /** Faces re-sampled coherently because their corners straddled a seam. */
  reseamed: number;
}

export function transferUV(
  source: Mesh, target: Mesh, onlyMissing = true, stats?: TransferStats,
): number {
  if (!source.hasUV) return 0;
  const sampler = new SurfaceSampler(source);
  if (sampler.empty) return 0;

  // A face whose corners straddle a seam would come back with coordinates from
  // both sides and stretch across the whole map; anything wider than this gets
  // re-sampled against a single source face instead.
  const seamSpan = 0.35;
  let filled = 0;

  for (let f = 0; f < target.faces.length; f++) {
    if (onlyMissing && target.uvFor(f)) continue;
    const loop = target.faces[f];
    if (loop.length < 3) continue;
    if (stats) stats.considered++;
    const points = loop.map((v) => target.positions[v]);
    const run: number[] = [];
    let ok = true;
    for (const p of points) {
      const uv = sampler.sampleUV(p);
      if (!uv) {
        ok = false;
        break;
      }
      run.push(uv[0], uv[1]);
    }
    if (!ok) continue;

    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < run.length; i += 2) {
      minU = Math.min(minU, run[i]);
      maxU = Math.max(maxU, run[i]);
      minV = Math.min(minV, run[i + 1]);
      maxV = Math.max(maxV, run[i + 1]);
    }
    if (maxU - minU > seamSpan || maxV - minV > seamSpan) {
      const coherent = sampler.sampleFaceCoherent(points);
      if (coherent) {
        target.setUV(f, coherent);
        filled++;
        // Counted only when it actually changed the answer. The test above is
        // a wide-footprint test, not a seam test: a face legitimately covering
        // most of the map trips it, and re-sampling such a face against the
        // one source face it already sat on gives back what it had. Reporting
        // that as a re-sample would make a lossless transfer look lossy, which
        // is the same class of error as the reverse.
        if (stats && changed(run, coherent)) stats.reseamed++;
        continue;
      }
    }
    target.setUV(f, run);
    filled++;
  }
  if (filled) target.markDirty();
  if (stats) stats.filled = filled;
  return filled;
}

/** Whether two coordinate runs differ by more than rounding. */
function changed(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return true;
  return false;
}

/**
 * Run an operator with the mesh's coordinates preserved: exact wherever the
 * operator carried them itself, sampled from the pre-edit surface everywhere
 * else.
 */
export function preserveUV<T>(mesh: Mesh, fn: () => T): T {
  if (!mesh.hasUV) return fn();
  const before = mesh.clone();
  const result = fn();
  transferUV(before, mesh, true);
  return result;
}
