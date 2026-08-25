import { Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';

/**
 * Proportional editing: vertices near the selection follow it, weighted by a
 * falloff curve. Distance is straight-line by default, or measured along the
 * surface when `connected` is on, which stops a fold in the mesh dragging the
 * far side of a limb along with it.
 */

export type FalloffType =
  | 'smooth' | 'sphere' | 'root' | 'inverseSquare' | 'sharp' | 'linear' | 'constant';

export const FALLOFF_LABELS: Record<FalloffType, string> = {
  smooth: 'Smooth',
  sphere: 'Sphere',
  root: 'Root',
  inverseSquare: 'Inverse Square',
  sharp: 'Sharp',
  linear: 'Linear',
  constant: 'Constant',
};

export interface ProportionalSettings {
  enabled: boolean;
  /** World-space radius of influence. */
  radius: number;
  falloff: FalloffType;
  /** Measure distance along edges instead of through space. */
  connected: boolean;
}

export function defaultProportional(): ProportionalSettings {
  return { enabled: false, radius: 1, falloff: 'smooth', connected: false };
}

/** `t` is 0 at the selection and 1 at the edge of the radius. */
export function falloffWeight(type: FalloffType, t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const i = 1 - x;
  switch (type) {
    case 'smooth': return i * i * (3 - 2 * i);
    case 'sphere': return Math.sqrt(Math.max(0, 1 - x * x));
    case 'root': return Math.sqrt(i);
    case 'inverseSquare': return i * i;
    case 'sharp': return i * i * i;
    case 'linear': return i;
    case 'constant': return 1;
  }
}

/**
 * Weight every vertex within `radius` of the selection. Selected vertices are
 * always 1; vertices outside the radius are absent from the result.
 */
export function proportionalWeights(
  mesh: Mesh, selected: Iterable<number>, radius: number,
  type: FalloffType = 'smooth', connected = false,
): Map<number, number> {
  const out = new Map<number, number>();
  const seeds = [...new Set(selected)];
  for (const v of seeds) out.set(v, 1);
  if (seeds.length === 0 || radius <= 0) return out;

  if (connected) {
    // Dijkstra outward along edges from the whole selection.
    const t = mesh.topology();
    const dist = new Float64Array(mesh.positions.length).fill(Infinity);
    const queue: { v: number; d: number }[] = [];
    for (const v of seeds) {
      dist[v] = 0;
      queue.push({ v, d: 0 });
    }
    while (queue.length) {
      // Small frontiers; a linear scan beats the bookkeeping of a heap here.
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[bi].d) bi = i;
      const cur = queue.splice(bi, 1)[0];
      if (cur.d > dist[cur.v]) continue;
      for (const ei of t.vertEdges[cur.v] ?? []) {
        const e = t.edges[ei];
        const other = e.a === cur.v ? e.b : e.a;
        const nd = cur.d + mesh.positions[cur.v].distanceTo(mesh.positions[other]);
        if (nd < dist[other] && nd <= radius) {
          dist[other] = nd;
          queue.push({ v: other, d: nd });
        }
      }
    }
    for (let v = 0; v < dist.length; v++) {
      if (dist[v] === 0 || dist[v] === Infinity) continue;
      out.set(v, falloffWeight(type, dist[v] / radius));
    }
    return out;
  }

  // Straight-line distance, bucketed so a big mesh is not an all-pairs sweep.
  const cell = Math.max(radius, 1e-6);
  const buckets = new Map<string, number[]>();
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  for (const v of seeds) {
    const p = mesh.positions[v];
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell), Math.floor(p.z / cell));
    const b = buckets.get(k);
    if (b) b.push(v);
    else buckets.set(k, [v]);
  }
  const r2 = radius * radius;
  for (let v = 0; v < mesh.positions.length; v++) {
    if (out.has(v)) continue;
    const p = mesh.positions[v];
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    const cz = Math.floor(p.z / cell);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = buckets.get(key(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const s of bucket) {
            const d = p.distanceTo(mesh.positions[s]);
            if (d * d < best * best) best = d;
          }
        }
      }
    }
    if (best * best <= r2) out.set(v, falloffWeight(type, best / radius));
  }
  return out;
}

/** Points on a circle of `radius` around `center`, for the influence overlay. */
export function influenceCircle(center: Vec3, radius: number, right: Vec3, up: Vec3, steps = 48): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push(center.add(right.scale(Math.cos(a) * radius)).add(up.scale(Math.sin(a) * radius)));
  }
  return pts;
}
