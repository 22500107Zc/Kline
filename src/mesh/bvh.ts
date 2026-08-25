import { Vec3, closestPointOnTriangle } from '../core/math';

/**
 * A bounding volume hierarchy over triangles.
 *
 * Shared by everything that needs to ask geometric questions of a whole mesh:
 * booleans (which triangles cross which), inside/outside tests (how many times
 * does a ray cross the surface), the knife (what did the cursor hit) and
 * physics (what is near what).
 */

export interface TriHit {
  tri: number;
  t: number;
  u: number;
  v: number;
}

const LEAF_SIZE = 8;

export class TriangleBVH {
  /** Flat triangle corner indices, three per triangle. */
  readonly tri: Int32Array;
  /** Face each triangle came from, so callers can map results back. */
  readonly triFace: Int32Array;
  private bounds: Float64Array;
  private left: Int32Array;
  private right: Int32Array;
  private start: Int32Array;
  private count: Int32Array;
  private order: Int32Array;
  private nodeCount = 0;

  constructor(readonly positions: Vec3[], faces: number[][]) {
    const tri: number[] = [];
    const triFace: number[] = [];
    for (let f = 0; f < faces.length; f++) {
      const loop = faces[f];
      for (let i = 1; i + 1 < loop.length; i++) {
        tri.push(loop[0], loop[i], loop[i + 1]);
        triFace.push(f);
      }
    }
    this.tri = new Int32Array(tri);
    this.triFace = new Int32Array(triFace);

    const n = triFace.length;
    const maxNodes = Math.max(1, n * 2);
    this.bounds = new Float64Array(maxNodes * 6);
    this.left = new Int32Array(maxNodes).fill(-1);
    this.right = new Int32Array(maxNodes).fill(-1);
    this.start = new Int32Array(maxNodes);
    this.count = new Int32Array(maxNodes);
    this.order = new Int32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    if (n > 0) this.buildTree();
  }

  get triangleCount(): number {
    return this.triFace.length;
  }

  private triBounds(t: number, out: Float64Array, o: number): void {
    const a = this.positions[this.tri[t * 3]];
    const b = this.positions[this.tri[t * 3 + 1]];
    const c = this.positions[this.tri[t * 3 + 2]];
    out[o] = Math.min(a.x, b.x, c.x);
    out[o + 1] = Math.min(a.y, b.y, c.y);
    out[o + 2] = Math.min(a.z, b.z, c.z);
    out[o + 3] = Math.max(a.x, b.x, c.x);
    out[o + 4] = Math.max(a.y, b.y, c.y);
    out[o + 5] = Math.max(a.z, b.z, c.z);
  }

  private nodeBounds(node: number, from: number, to: number): void {
    const o = node * 6;
    this.bounds[o] = this.bounds[o + 1] = this.bounds[o + 2] = Infinity;
    this.bounds[o + 3] = this.bounds[o + 4] = this.bounds[o + 5] = -Infinity;
    const tmp = new Float64Array(6);
    for (let i = from; i < to; i++) {
      this.triBounds(this.order[i], tmp, 0);
      for (let a = 0; a < 3; a++) {
        if (tmp[a] < this.bounds[o + a]) this.bounds[o + a] = tmp[a];
        if (tmp[3 + a] > this.bounds[o + 3 + a]) this.bounds[o + 3 + a] = tmp[3 + a];
      }
    }
  }

  private buildTree(): void {
    const n = this.order.length;
    const centroid = new Float64Array(n * 3);
    const tmp = new Float64Array(6);
    for (let t = 0; t < n; t++) {
      this.triBounds(t, tmp, 0);
      centroid[t * 3] = (tmp[0] + tmp[3]) * 0.5;
      centroid[t * 3 + 1] = (tmp[1] + tmp[4]) * 0.5;
      centroid[t * 3 + 2] = (tmp[2] + tmp[5]) * 0.5;
    }

    const root = this.nodeCount++;
    this.nodeBounds(root, 0, n);
    this.start[root] = 0;
    this.count[root] = n;
    const stack: { node: number; from: number; to: number }[] = [{ node: root, from: 0, to: n }];

    while (stack.length) {
      const { node, from, to } = stack.pop()!;
      const span = to - from;
      if (span <= LEAF_SIZE || this.nodeCount + 2 > this.left.length) continue;

      // Split on the widest spread of centroids, at the median.
      let axis = 0;
      let bestSpread = -1;
      for (let a = 0; a < 3; a++) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = from; i < to; i++) {
          const c = centroid[this.order[i] * 3 + a];
          if (c < lo) lo = c;
          if (c > hi) hi = c;
        }
        if (hi - lo > bestSpread) {
          bestSpread = hi - lo;
          axis = a;
        }
      }
      if (bestSpread <= 1e-15) continue;

      const slice = Array.from(this.order.subarray(from, to));
      slice.sort((x, y) => centroid[x * 3 + axis] - centroid[y * 3 + axis]);
      this.order.set(slice, from);
      const mid = from + (span >> 1);

      const l = this.nodeCount++;
      const r = this.nodeCount++;
      this.nodeBounds(l, from, mid);
      this.nodeBounds(r, mid, to);
      this.start[l] = from;
      this.count[l] = mid - from;
      this.start[r] = mid;
      this.count[r] = to - mid;
      this.left[node] = l;
      this.right[node] = r;
      this.count[node] = 0;
      stack.push({ node: l, from, to: mid });
      stack.push({ node: r, from: mid, to });
    }
  }

  private boxOverlaps(node: number, lo: Vec3, hi: Vec3): boolean {
    const o = node * 6;
    return !(
      this.bounds[o] > hi.x || this.bounds[o + 3] < lo.x
      || this.bounds[o + 1] > hi.y || this.bounds[o + 4] < lo.y
      || this.bounds[o + 2] > hi.z || this.bounds[o + 5] < lo.z
    );
  }

  /** Triangles whose bounding box overlaps the given box. */
  queryBox(lo: Vec3, hi: Vec3, out: number[] = []): number[] {
    if (this.nodeCount === 0) return out;
    const stack = [0];
    const tmp = new Float64Array(6);
    while (stack.length) {
      const node = stack.pop()!;
      if (!this.boxOverlaps(node, lo, hi)) continue;
      const l = this.left[node];
      if (l >= 0) {
        stack.push(l, this.right[node]);
        continue;
      }
      const from = this.start[node];
      for (let i = from; i < from + this.count[node]; i++) {
        // A leaf holds several triangles and its node box covers all of them,
        // so each still has to be tested; returning the whole leaf would make
        // every caller filter again.
        const t = this.order[i];
        this.triBounds(t, tmp, 0);
        if (tmp[0] > hi.x || tmp[3] < lo.x || tmp[1] > hi.y || tmp[4] < lo.y
          || tmp[2] > hi.z || tmp[5] < lo.z) continue;
        out.push(t);
      }
    }
    return out;
  }

  private slab(node: number, o: Vec3, inv: Vec3, tMax: number): boolean {
    const b = node * 6;
    let lo = -Infinity;
    let hi = tMax;
    for (let a = 0; a < 3; a++) {
      const oa = a === 0 ? o.x : a === 1 ? o.y : o.z;
      const ia = a === 0 ? inv.x : a === 1 ? inv.y : inv.z;
      const t0 = (this.bounds[b + a] - oa) * ia;
      const t1 = (this.bounds[b + 3 + a] - oa) * ia;
      lo = Math.max(lo, Math.min(t0, t1));
      hi = Math.min(hi, Math.max(t0, t1));
    }
    return hi >= Math.max(lo, 0);
  }

  /** Every triangle the ray crosses, sorted by distance. */
  raycastAll(origin: Vec3, dir: Vec3, tMax = Infinity): TriHit[] {
    const hits: TriHit[] = [];
    if (this.nodeCount === 0) return hits;
    const inv = new Vec3(1 / (dir.x || 1e-20), 1 / (dir.y || 1e-20), 1 / (dir.z || 1e-20));
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (!this.slab(node, origin, inv, tMax)) continue;
      const l = this.left[node];
      if (l >= 0) {
        stack.push(l, this.right[node]);
        continue;
      }
      const from = this.start[node];
      for (let i = from; i < from + this.count[node]; i++) {
        const t = this.order[i];
        const hit = this.rayTri(origin, dir, t, tMax);
        if (hit) hits.push(hit);
      }
    }
    hits.sort((a, b) => a.t - b.t);
    return hits;
  }

  raycastNearest(origin: Vec3, dir: Vec3, tMax = Infinity): TriHit | null {
    const all = this.raycastAll(origin, dir, tMax);
    return all.length ? all[0] : null;
  }

  private rayTri(o: Vec3, d: Vec3, t: number, tMax: number): TriHit | null {
    const a = this.positions[this.tri[t * 3]];
    const b = this.positions[this.tri[t * 3 + 1]];
    const c = this.positions[this.tri[t * 3 + 2]];
    const e1 = b.sub(a);
    const e2 = c.sub(a);
    const p = d.cross(e2);
    const det = e1.dot(p);
    if (Math.abs(det) < 1e-14) return null;
    const inv = 1 / det;
    const tv = o.sub(a);
    const u = tv.dot(p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    const q = tv.cross(e1);
    const v = d.dot(q) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return null;
    const dist = e2.dot(q) * inv;
    if (dist <= 1e-9 || dist >= tMax) return null;
    return { tri: t, t: dist, u, v };
  }

  /**
   * Distance from a point to the nearest triangle, searching an expanding box.
   * Returns Infinity when nothing is within `limit`.
   */
  distanceTo(p: Vec3, limit: number): number {
    const radius = limit;
    const lo = new Vec3(p.x - radius, p.y - radius, p.z - radius);
    const hi = new Vec3(p.x + radius, p.y + radius, p.z + radius);
    let best = Infinity;
    for (const t of this.queryBox(lo, hi)) {
      const r = closestPointOnTriangle(
        p, this.positions[this.tri[t * 3]], this.positions[this.tri[t * 3 + 1]],
        this.positions[this.tri[t * 3 + 2]],
      );
      const d = r.point.distanceTo(p);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Is the point inside this (closed) surface?
   *
   * Parity along a ray, retried in a different direction whenever a hit lands
   * suspiciously close to a triangle edge — the one case where a single ray
   * gives the wrong answer.
   */
  contains(p: Vec3): boolean {
    if (this.nodeCount === 0) return false;
    const dirs = [
      new Vec3(0.5773502691896258, 0.5773502691896258, 0.5773502691896258),
      new Vec3(-0.3129, 0.7845, 0.5352),
      new Vec3(0.8231, -0.2134, 0.5266),
      new Vec3(-0.6712, -0.4411, 0.5955),
      new Vec3(0.1234, 0.9014, -0.4152),
    ];
    for (const dir of dirs) {
      const hits = this.raycastAll(p, dir);
      let clean = true;
      for (const h of hits) {
        const w = 1 - h.u - h.v;
        // Grazing a shared edge counts once or twice depending on floating
        // point luck, so this ray is not to be trusted.
        if (h.u < 1e-6 || h.v < 1e-6 || w < 1e-6) {
          clean = false;
          break;
        }
      }
      if (clean) return hits.length % 2 === 1;
    }
    return this.raycastAll(p, dirs[0]).length % 2 === 1;
  }
}
