import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Decimation by quadric error metrics (Garland & Heckbert).
 *
 * Each vertex accumulates the squared-distance-to-plane quadric of the faces
 * around it; collapsing an edge costs the error of the merged quadric at the
 * best position for the surviving vertex, so flat regions collapse first and
 * silhouettes survive. Open borders get an extra quadric perpendicular to the
 * surface so the outline does not creep inward.
 *
 * The input is triangulated first — quadrics are defined per triangle — so the
 * result is a triangle mesh regardless of what went in.
 */

const Q = 10;

function addPlane(q: Float64Array, off: number, a: number, b: number, c: number, d: number, w: number): void {
  q[off] += a * a * w;
  q[off + 1] += a * b * w;
  q[off + 2] += a * c * w;
  q[off + 3] += a * d * w;
  q[off + 4] += b * b * w;
  q[off + 5] += b * c * w;
  q[off + 6] += b * d * w;
  q[off + 7] += c * c * w;
  q[off + 8] += c * d * w;
  q[off + 9] += d * d * w;
}

function quadricError(q: Float64Array, off: number, x: number, y: number, z: number): number {
  return (
    q[off] * x * x + 2 * q[off + 1] * x * y + 2 * q[off + 2] * x * z + 2 * q[off + 3] * x
    + q[off + 4] * y * y + 2 * q[off + 5] * y * z + 2 * q[off + 6] * y
    + q[off + 7] * z * z + 2 * q[off + 8] * z
    + q[off + 9]
  );
}

interface Candidate {
  cost: number;
  a: number;
  b: number;
  va: number;
  vb: number;
  x: number;
  y: number;
  z: number;
}

/** Binary min-heap; entries are validated on pop rather than removed on change. */
class Heap {
  private items: Candidate[] = [];

  get size(): number {
    return this.items.length;
  }

  push(c: Candidate): void {
    const a = this.items;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop(): Candidate | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Reduce the mesh to roughly `ratio` of its triangle count (0 < ratio <= 1).
 * `preserveBorder` keeps open edges pinned.
 */
export function decimate(mesh: Mesh, ratio: number, preserveBorder = true): Mesh {
  const src = mesh.clone();
  const { indices } = src.triangulate();
  const triCount = indices.length / 3;
  const target = Math.max(1, Math.floor(triCount * Math.min(1, Math.max(0.001, ratio))));
  if (target >= triCount) return src;

  const nv = src.positions.length;
  const pos = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = src.positions[i].x;
    pos[i * 3 + 1] = src.positions[i].y;
    pos[i * 3 + 2] = src.positions[i].z;
  }
  const tri = new Int32Array(indices);
  const dead = new Uint8Array(triCount);
  const gone = new Uint8Array(nv);
  const version = new Int32Array(nv);
  const quad = new Float64Array(nv * Q);
  const vertTris: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());

  const triNormal = (t: number): Vec3 => {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3];
    const uy = pos[b * 3 + 1] - pos[a * 3 + 1];
    const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3];
    const vy = pos[c * 3 + 1] - pos[a * 3 + 1];
    const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    return new Vec3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };

  const edgeTris = new Map<number, number[]>();
  const ekey = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a);

  for (let t = 0; t < triCount; t++) {
    const a = tri[t * 3];
    const b = tri[t * 3 + 1];
    const c = tri[t * 3 + 2];
    vertTris[a].add(t);
    vertTris[b].add(t);
    vertTris[c].add(t);
    const n = triNormal(t);
    const area = n.length();
    if (area < 1e-16) {
      dead[t] = 1;
      continue;
    }
    const un = n.scale(1 / area);
    const d = -(un.x * pos[a * 3] + un.y * pos[a * 3 + 1] + un.z * pos[a * 3 + 2]);
    for (const v of [a, b, c]) addPlane(quad, v * Q, un.x, un.y, un.z, d, area);
    for (const [u, w] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = ekey(u, w);
      const list = edgeTris.get(k);
      if (list) list.push(t);
      else edgeTris.set(k, [t]);
    }
  }

  if (preserveBorder) {
    for (const [k, list] of edgeTris) {
      if (list.length !== 1) continue;
      const a = Math.floor(k / nv);
      const b = k % nv;
      const n = triNormal(list[0]).normalized();
      const ex = pos[b * 3] - pos[a * 3];
      const ey = pos[b * 3 + 1] - pos[a * 3 + 1];
      const ez = pos[b * 3 + 2] - pos[a * 3 + 2];
      const len = Math.hypot(ex, ey, ez);
      if (len < 1e-12) continue;
      // Plane through the border edge, perpendicular to the surface.
      const bn = new Vec3(ex / len, ey / len, ez / len).cross(n);
      const d = -(bn.x * pos[a * 3] + bn.y * pos[a * 3 + 1] + bn.z * pos[a * 3 + 2]);
      const w = len * len * 1000;
      addPlane(quad, a * Q, bn.x, bn.y, bn.z, d, w);
      addPlane(quad, b * Q, bn.x, bn.y, bn.z, d, w);
    }
  }

  const merged = new Float64Array(Q);
  const evaluate = (a: number, b: number): Candidate => {
    for (let i = 0; i < Q; i++) merged[i] = quad[a * Q + i] + quad[b * Q + i];
    const m00 = merged[0];
    const m01 = merged[1];
    const m02 = merged[2];
    const m11 = merged[4];
    const m12 = merged[5];
    const m22 = merged[7];
    const det = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02);
    let x: number;
    let y: number;
    let z: number;
    if (Math.abs(det) > 1e-12) {
      const b0 = -merged[3];
      const b1 = -merged[6];
      const b2 = -merged[8];
      x = (b0 * (m11 * m22 - m12 * m12) - m01 * (b1 * m22 - m12 * b2) + m02 * (b1 * m12 - m11 * b2)) / det;
      y = (m00 * (b1 * m22 - m12 * b2) - b0 * (m01 * m22 - m12 * m02) + m02 * (m01 * b2 - b1 * m02)) / det;
      z = (m00 * (m11 * b2 - b1 * m12) - m01 * (m01 * b2 - b1 * m02) + b0 * (m01 * m12 - m11 * m02)) / det;
    } else {
      // Degenerate quadric: pick the cheapest of the two ends and the midpoint.
      let bestCost = Infinity;
      x = pos[a * 3];
      y = pos[a * 3 + 1];
      z = pos[a * 3 + 2];
      const opts: [number, number, number][] = [
        [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]],
        [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]],
        [(pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2],
      ];
      for (const [ox, oy, oz] of opts) {
        const c = quadricError(merged, 0, ox, oy, oz);
        if (c < bestCost) {
          bestCost = c;
          x = ox;
          y = oy;
          z = oz;
        }
      }
    }
    const cost = Math.max(0, quadricError(merged, 0, x, y, z));
    return { cost, a, b, va: version[a], vb: version[b], x, y, z };
  };

  const heap = new Heap();
  for (const k of edgeTris.keys()) {
    const a = Math.floor(k / nv);
    const b = k % nv;
    heap.push(evaluate(a, b));
  }

  const neighbours = (v: number): number[] => {
    const out = new Set<number>();
    for (const t of vertTris[v]) {
      if (dead[t]) continue;
      for (let i = 0; i < 3; i++) {
        const u = tri[t * 3 + i];
        if (u !== v) out.add(u);
      }
    }
    return [...out];
  };

  /** Reject collapses that would fold a triangle over or pinch the surface. */
  const safe = (a: number, b: number, x: number, y: number, z: number): boolean => {
    const na = new Set(neighbours(a));
    const nb = new Set(neighbours(b));
    let shared = 0;
    for (const v of na) if (nb.has(v)) shared++;
    let joint = 0;
    for (const t of vertTris[a]) {
      if (dead[t]) continue;
      const c0 = tri[t * 3];
      const c1 = tri[t * 3 + 1];
      const c2 = tri[t * 3 + 2];
      if (c0 === b || c1 === b || c2 === b) joint++;
    }
    if (shared !== joint) return false;
    for (const v of [a, b]) {
      for (const t of vertTris[v]) {
        if (dead[t]) continue;
        const c0 = tri[t * 3];
        const c1 = tri[t * 3 + 1];
        const c2 = tri[t * 3 + 2];
        if ((c0 === a || c1 === a || c2 === a) && (c0 === b || c1 === b || c2 === b)) continue;
        const before = triNormal(t);
        const sx = [pos[c0 * 3], pos[c1 * 3], pos[c2 * 3]];
        const sy = [pos[c0 * 3 + 1], pos[c1 * 3 + 1], pos[c2 * 3 + 1]];
        const sz = [pos[c0 * 3 + 2], pos[c1 * 3 + 2], pos[c2 * 3 + 2]];
        for (let i = 0; i < 3; i++) {
          const c = tri[t * 3 + i];
          if (c === a || c === b) {
            sx[i] = x;
            sy[i] = y;
            sz[i] = z;
          }
        }
        const ux = sx[1] - sx[0];
        const uy = sy[1] - sy[0];
        const uz = sz[1] - sz[0];
        const vx = sx[2] - sx[0];
        const vy = sy[2] - sy[0];
        const vz = sz[2] - sz[0];
        const after = new Vec3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        if (after.lengthSq() < 1e-20) return false;
        if (before.dot(after) <= 0) return false;
      }
    }
    return true;
  };

  let live = triCount;
  for (let t = 0; t < triCount; t++) if (dead[t]) live--;
  let guard = triCount * 12 + 1000;

  while (live > target && heap.size > 0 && guard-- > 0) {
    const c = heap.pop();
    if (!c) break;
    const { a, b } = c;
    if (gone[a] || gone[b]) continue;
    if (version[a] !== c.va || version[b] !== c.vb) continue;
    if (!safe(a, b, c.x, c.y, c.z)) {
      version[a]++;
      for (const u of neighbours(a)) heap.push(evaluate(a, u));
      continue;
    }

    pos[a * 3] = c.x;
    pos[a * 3 + 1] = c.y;
    pos[a * 3 + 2] = c.z;
    for (let i = 0; i < Q; i++) quad[a * Q + i] += quad[b * Q + i];

    for (const t of vertTris[b]) {
      if (dead[t]) continue;
      const c0 = tri[t * 3];
      const c1 = tri[t * 3 + 1];
      const c2 = tri[t * 3 + 2];
      if (c0 === a || c1 === a || c2 === a) {
        dead[t] = 1;
        live--;
        vertTris[c0].delete(t);
        vertTris[c1].delete(t);
        vertTris[c2].delete(t);
        continue;
      }
      for (let i = 0; i < 3; i++) if (tri[t * 3 + i] === b) tri[t * 3 + i] = a;
      vertTris[a].add(t);
    }
    vertTris[b].clear();
    gone[b] = 1;
    version[a]++;
    version[b]++;
    for (const u of neighbours(a)) heap.push(evaluate(a, u));
  }

  const remap = new Int32Array(nv).fill(-1);
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  for (let t = 0; t < triCount; t++) {
    if (dead[t]) continue;
    const loop: number[] = [];
    for (let i = 0; i < 3; i++) {
      const v = tri[t * 3 + i];
      if (remap[v] < 0) {
        remap[v] = positions.length;
        positions.push(new Vec3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
      }
      loop.push(remap[v]);
    }
    if (loop[0] === loop[1] || loop[1] === loop[2] || loop[0] === loop[2]) continue;
    faces.push(loop);
  }

  const out = new Mesh(positions, faces);
  out.shadeSmooth = src.shadeSmooth;
  return out;
}
