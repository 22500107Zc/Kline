import { Point, signedArea } from './contour';

/**
 * Ear-clipping triangulation for polygons with holes.
 *
 * Traced silhouettes are concave and frequently have holes — the inside of a
 * letter O, the gap in a door handle — so the fan triangulation the renderer
 * uses for convex n-gons is not enough to cap an extrusion. Holes are bridged
 * into the outer ring first, then the resulting simple polygon is ear-clipped.
 */

export interface Triangulation {
  /** Outer ring followed by each hole, in input order. */
  vertices: Point[];
  /** Triangle corner indices into `vertices`, counter-clockwise. */
  indices: number[];
}

const area2 = (a: Point, b: Point, c: Point): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function pointInTriangle(a: Point, b: Point, c: Point, p: Point): boolean {
  const d1 = area2(a, b, p);
  const d2 = area2(b, c, p);
  const d3 = area2(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export function triangulatePolygon(outer: Point[], holes: Point[][] = []): Triangulation {
  const vertices: Point[] = [];
  const ring: number[] = [];

  const outerCCW = signedArea(outer) > 0 ? outer : outer.slice().reverse();
  for (const p of outerCCW) {
    ring.push(vertices.length);
    vertices.push(p);
  }

  const holeRings: number[][] = [];
  for (const hole of holes) {
    if (hole.length < 3) continue;
    // Holes wind opposite the outer ring so the bridge does not cross itself.
    const holeCW = signedArea(hole) < 0 ? hole : hole.slice().reverse();
    const indices: number[] = [];
    for (const p of holeCW) {
      indices.push(vertices.length);
      vertices.push(p);
    }
    holeRings.push(indices);
  }

  // Bridge the rightmost holes first: by the time an inner hole is joined, the
  // outer ring already contains the ones further out.
  holeRings.sort((a, b) => leftmostX(vertices, b) - leftmostX(vertices, a));

  let merged = ring;
  for (const hole of holeRings) merged = bridgeHole(vertices, merged, hole);

  const indices = earClip(vertices, merged);
  return { vertices, indices };
}

function leftmostX(vertices: Point[], ring: number[]): number {
  let best = Infinity;
  for (const i of ring) best = Math.min(best, vertices[i][0]);
  return best;
}

/** Splice a hole into the outer ring with a two-way bridge. */
function bridgeHole(vertices: Point[], outer: number[], hole: number[]): number[] {
  // Start from the hole's leftmost vertex and look left for the nearest edge.
  let holeStart = 0;
  for (let i = 1; i < hole.length; i++) {
    if (vertices[hole[i]][0] < vertices[hole[holeStart]][0]) holeStart = i;
  }
  const bridgeIndex = findBridge(vertices, outer, vertices[hole[holeStart]]);
  if (bridgeIndex < 0) return outer;

  const out: number[] = [];
  for (let i = 0; i <= bridgeIndex; i++) out.push(outer[i]);
  for (let i = 0; i < hole.length; i++) out.push(hole[(holeStart + i) % hole.length]);
  out.push(hole[holeStart]);          // close the hole ring
  out.push(outer[bridgeIndex]);        // and come back to the outer ring
  for (let i = bridgeIndex + 1; i < outer.length; i++) out.push(outer[i]);
  return out;
}

/**
 * Index into `outer` that the hole point can see, by casting a ray to -x and
 * taking the endpoint of the first edge it crosses (then refining for the case
 * where that endpoint is hidden behind a reflex vertex).
 */
function findBridge(vertices: Point[], outer: number[], hp: Point): number {
  const [hx, hy] = hp;
  let bestX = -Infinity;
  let candidate = -1;

  for (let i = 0; i < outer.length; i++) {
    const a = vertices[outer[i]];
    const b = vertices[outer[(i + 1) % outer.length]];
    if (a[1] === b[1]) continue;
    if (hy > Math.max(a[1], b[1]) || hy < Math.min(a[1], b[1])) continue;
    const x = a[0] + ((hy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (x <= hx && x > bestX) {
      bestX = x;
      candidate = a[0] > b[0] ? i : (i + 1) % outer.length;
    }
  }
  if (candidate < 0) return -1;

  // Any reflex vertex inside the triangle (hole point, ray hit, candidate)
  // blocks the straight line; prefer the one closest in angle to the ray.
  const m = vertices[outer[candidate]];
  const tri: [Point, Point, Point] = [[bestX, hy], m, [hx, hy]];
  let bestTan = Infinity;
  let refined = candidate;
  for (let i = 0; i < outer.length; i++) {
    const p = vertices[outer[i]];
    if (p === m) continue;
    if (p[0] > hx || p[0] < bestX) continue;
    if (!pointInTriangle(tri[0], tri[1], tri[2], p)) continue;
    const tan = Math.abs(hy - p[1]) / (hx - p[0] || 1e-12);
    if (tan < bestTan) {
      bestTan = tan;
      refined = i;
    }
  }
  return refined;
}

function earClip(vertices: Point[], ring: number[]): number[] {
  const indices: number[] = [];
  const poly = ring.slice();
  let guard = poly.length * poly.length + 32;

  while (poly.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < poly.length; i++) {
      const ai = poly[(i + poly.length - 1) % poly.length];
      const bi = poly[i];
      const ci = poly[(i + 1) % poly.length];
      if (!isEar(vertices, poly, ai, bi, ci)) continue;
      indices.push(ai, bi, ci);
      poly.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate or self-touching input: clip the least-bad corner so the
      // caller still gets a cap rather than nothing at all.
      let best = -1;
      let bestArea = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = vertices[poly[(i + poly.length - 1) % poly.length]];
        const b = vertices[poly[i]];
        const c = vertices[poly[(i + 1) % poly.length]];
        const t = area2(a, b, c);
        if (t > bestArea) {
          bestArea = t;
          best = i;
        }
      }
      if (best < 0) break;
      indices.push(
        poly[(best + poly.length - 1) % poly.length], poly[best], poly[(best + 1) % poly.length],
      );
      poly.splice(best, 1);
    }
  }
  if (poly.length === 3) indices.push(poly[0], poly[1], poly[2]);

  // Drop anything with a repeated corner or no area.
  const out: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    if (a === b || b === c || a === c) continue;
    if (Math.abs(area2(vertices[a], vertices[b], vertices[c])) < 1e-12) continue;
    out.push(a, b, c);
  }
  return out;
}

function isEar(vertices: Point[], poly: number[], ai: number, bi: number, ci: number): boolean {
  const a = vertices[ai];
  const b = vertices[bi];
  const c = vertices[ci];
  if (area2(a, b, c) <= 0) return false; // reflex or collinear
  for (const pi of poly) {
    if (pi === ai || pi === bi || pi === ci) continue;
    if (pointInTriangle(a, b, c, vertices[pi])) return false;
  }
  return true;
}
