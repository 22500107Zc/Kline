import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';
import { TriangleBVH } from './bvh';
import { dropSlivers, isSliver, repairManifold, stitchTJunctions } from './boolean';

/**
 * Surface-based constructive solid geometry.
 *
 * The classic BSP approach (csg.js and its descendants) splits every polygon
 * against every plane it meets. On flat operands that is fine; on two rounded
 * surfaces touching almost tangentially the split count runs away and it never
 * finishes — a rounded cube carved with a sphere is enough to hang it.
 *
 * This works on the surfaces instead:
 *
 *   1. find the triangle pairs that actually cross, through a BVH;
 *   2. cut each crossed triangle along the intersection segments, so no
 *      triangle straddles the other solid any more;
 *   3. ask of each resulting piece whether it is inside the other solid, by
 *      ray parity;
 *   4. keep the pieces the operation asks for, flipping B's where it needs the
 *      inside of a subtraction.
 *
 * Work is proportional to the number of crossings, not to their arrangement,
 * so tangency costs nothing special.
 */

export type BooleanOp = 'union' | 'difference' | 'intersect';

interface Piece {
  /** World-space corners, in order. */
  points: Vec3[];
  /** Face of the operand this came from. */
  face: number;
  material: number;
  smooth: boolean;
  uv: number[] | null;
  /** 0 for the first operand, 1 for the second. */
  operand: 0 | 1;
}

/** Two triangles' shared segment, or null when they miss. */
function triangleIntersection(
  a0: Vec3, a1: Vec3, a2: Vec3, b0: Vec3, b1: Vec3, b2: Vec3, eps: number,
): [Vec3, Vec3] | null {
  const nb = b1.sub(b0).cross(b2.sub(b0));
  const nbLen = nb.length();
  if (nbLen < eps) return null;
  const nbu = nb.scale(1 / nbLen);
  const wb = nbu.dot(b0);
  const da = [nbu.dot(a0) - wb, nbu.dot(a1) - wb, nbu.dot(a2) - wb];
  if ((da[0] > eps && da[1] > eps && da[2] > eps) || (da[0] < -eps && da[1] < -eps && da[2] < -eps)) {
    return null;
  }

  const na = a1.sub(a0).cross(a2.sub(a0));
  const naLen = na.length();
  if (naLen < eps) return null;
  const nau = na.scale(1 / naLen);
  const wa = nau.dot(a0);
  const db = [nau.dot(b0) - wa, nau.dot(b1) - wa, nau.dot(b2) - wa];
  if ((db[0] > eps && db[1] > eps && db[2] > eps) || (db[0] < -eps && db[1] < -eps && db[2] < -eps)) {
    return null;
  }

  // Coplanar triangles share no single segment; the classifier handles them.
  const dir = nau.cross(nbu);
  const dirLen = dir.length();
  if (dirLen < 1e-12) return null;
  const axis = dir.scale(1 / dirLen);

  const spanOn = (p: Vec3[], d: number[]): [number, number] | null => {
    const hits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const di = d[i];
      const dj = d[j];
      if (Math.abs(di) <= eps) hits.push(axis.dot(p[i]));
      if ((di > eps && dj < -eps) || (di < -eps && dj > eps)) {
        const t = di / (di - dj);
        hits.push(axis.dot(p[i].add(p[j].sub(p[i]).scale(t))));
      }
    }
    if (hits.length < 2) return null;
    return [Math.min(...hits), Math.max(...hits)];
  };

  const sa = spanOn([a0, a1, a2], da);
  const sb = spanOn([b0, b1, b2], db);
  if (!sa || !sb) return null;
  const lo = Math.max(sa[0], sb[0]);
  const hi = Math.min(sa[1], sb[1]);
  if (hi - lo <= eps) return null;

  // Rebuild the endpoints on the line of intersection of the two planes.
  const denom = 1 - nau.dot(nbu) ** 2;
  if (Math.abs(denom) < 1e-14) return null;
  const c1 = (wa - wb * nau.dot(nbu)) / denom;
  const c2 = (wb - wa * nau.dot(nbu)) / denom;
  const base = nau.scale(c1).add(nbu.scale(c2));
  const t0 = lo - axis.dot(base);
  const t1 = hi - axis.dot(base);
  return [base.add(axis.scale(t0)), base.add(axis.scale(t1))];
}

/**
 * A grid of the operands' own vertices, used to pull intersection points onto
 * them.
 *
 * Where two surfaces meet almost tangentially the segment endpoints land a
 * hair off an existing corner — near enough to be the same point, far enough
 * to survive welding. Each one then becomes a sliver of overlap between two
 * faces, which is an edge with three faces once everything is stitched. Moving
 * the point the last fraction onto the corner removes the sliver instead of
 * cleaning up after it.
 */
class VertexSnap {
  private cells = new Map<string, Vec3[]>();

  constructor(private tol: number, ...meshes: Mesh[]) {
    for (const m of meshes) for (const p of m.positions) this.add(p);
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private add(p: Vec3): void {
    const inv = 1 / this.tol;
    const k = this.key(Math.floor(p.x * inv), Math.floor(p.y * inv), Math.floor(p.z * inv));
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(p);
    else this.cells.set(k, [p]);
  }

  /** The nearest operand vertex within tolerance, or `p` itself. */
  snap(p: Vec3): Vec3 {
    const inv = 1 / this.tol;
    const cx = Math.floor(p.x * inv);
    const cy = Math.floor(p.y * inv);
    const cz = Math.floor(p.z * inv);
    let best: Vec3 | null = null;
    let bestSq = this.tol * this.tol;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.cells.get(this.key(cx + dx, cy + dy, cz + dz));
          if (!bucket) continue;
          for (const q of bucket) {
            const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
            if (d < bestSq) {
              bestSq = d;
              best = q;
            }
          }
        }
      }
    }
    return best ?? p;
  }
}

/** An orthonormal frame in a triangle's plane, for 2D work. */
function planeFrame(n: Vec3): { x: Vec3; y: Vec3 } {
  const helper = Math.abs(n.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  const x = helper.cross(n).normalized();
  return { x, y: n.cross(x).normalized() };
}

/**
 * Cut a convex polygon with the line through `p` along `d` (2D). Both halves
 * are returned; a polygon the line misses comes back whole.
 */
function splitConvex(
  poly: { u: number; v: number }[], px: number, py: number, dx: number, dy: number, eps: number,
): { u: number; v: number }[][] {
  const side = poly.map((q) => (q.u - px) * dy - (q.v - py) * dx);
  let hasPos = false;
  let hasNeg = false;
  for (const s of side) {
    if (s > eps) hasPos = true;
    else if (s < -eps) hasNeg = true;
  }
  if (!hasPos || !hasNeg) return [poly];

  const front: { u: number; v: number }[] = [];
  const back: { u: number; v: number }[] = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const si = side[i];
    const sj = side[j];
    if (si >= -eps) front.push(poly[i]);
    if (si <= eps) back.push(poly[i]);
    if ((si > eps && sj < -eps) || (si < -eps && sj > eps)) {
      const t = si / (si - sj);
      const cut = {
        u: poly[i].u + (poly[j].u - poly[i].u) * t,
        v: poly[i].v + (poly[j].v - poly[i].v) * t,
      };
      front.push(cut);
      back.push(cut);
    }
  }
  const out: { u: number; v: number }[][] = [];
  if (front.length >= 3) out.push(front);
  if (back.length >= 3) out.push(back);
  return out.length ? out : [poly];
}

function polyArea2D(poly: { u: number; v: number }[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    a += poly[i].u * poly[j].v - poly[j].u * poly[i].v;
  }
  return Math.abs(a) * 0.5;
}

interface Operand {
  mesh: Mesh;
  bvh: TriangleBVH;
  /** Per triangle, the segments other geometry cuts it with. */
  cuts: Map<number, [Vec3, Vec3][]>;
}

function prepare(mesh: Mesh): Operand {
  return { mesh, bvh: new TriangleBVH(mesh.positions, mesh.faces), cuts: new Map() };
}

/** Barycentric coordinates of `p` within triangle abc, for UV interpolation. */
function barycentric(p: Vec3, a: Vec3, b: Vec3, c: Vec3): [number, number, number] {
  const v0 = b.sub(a);
  const v1 = c.sub(a);
  const v2 = p.sub(a);
  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-20) return [1, 0, 0];
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  return [1 - v - w, v, w];
}

/** Break every crossed triangle into pieces that no longer straddle the other solid. */
function fragment(op: Operand, eps: number, operand: 0 | 1): Piece[] {
  const { mesh, bvh } = op;
  const pieces: Piece[] = [];

  for (let t = 0; t < bvh.triangleCount; t++) {
    const ia = bvh.tri[t * 3];
    const ib = bvh.tri[t * 3 + 1];
    const ic = bvh.tri[t * 3 + 2];
    const a = mesh.positions[ia];
    const b = mesh.positions[ib];
    const c = mesh.positions[ic];
    const face = bvh.triFace[t];
    const material = mesh.faceMaterial[face] ?? 0;
    const smooth = mesh.isFaceSmooth(face);

    // Corner coordinates for this triangle, taken from the face's fan.
    let triUV: [number, number][] | null = null;
    const faceUV = mesh.uvFor(face);
    if (faceUV) {
      const loop = mesh.faces[face];
      const c0 = loop.indexOf(ia);
      const c1 = loop.indexOf(ib);
      const c2 = loop.indexOf(ic);
      if (c0 >= 0 && c1 >= 0 && c2 >= 0) {
        triUV = [
          [faceUV[c0 * 2], faceUV[c0 * 2 + 1]],
          [faceUV[c1 * 2], faceUV[c1 * 2 + 1]],
          [faceUV[c2 * 2], faceUV[c2 * 2 + 1]],
        ];
      }
    }

    const segments = op.cuts.get(t);
    const emit = (points: Vec3[]): void => {
      let uv: number[] | null = null;
      if (triUV) {
        uv = [];
        for (const p of points) {
          const [wa, wb, wc] = barycentric(p, a, b, c);
          uv.push(
            triUV[0][0] * wa + triUV[1][0] * wb + triUV[2][0] * wc,
            triUV[0][1] * wa + triUV[1][1] * wb + triUV[2][1] * wc,
          );
        }
      }
      pieces.push({ points, face, material, smooth, uv, operand });
    };

    if (!segments || segments.length === 0) {
      emit([a, b, c]);
      continue;
    }

    const n = b.sub(a).cross(c.sub(a));
    const len = n.length();
    if (len < eps) {
      emit([a, b, c]);
      continue;
    }
    const nu = n.scale(1 / len);
    const { x, y } = planeFrame(nu);
    const to2 = (p: Vec3): { u: number; v: number } => {
      const d = p.sub(a);
      return { u: d.dot(x), v: d.dot(y) };
    };
    const to3 = (q: { u: number; v: number }): Vec3 => a.add(x.scale(q.u)).add(y.scale(q.v));

    let polys: { u: number; v: number }[][] = [[to2(a), to2(b), to2(c)]];
    for (const [s0, s1] of segments) {
      const p0 = to2(s0);
      const p1 = to2(s1);
      const dx = p1.u - p0.u;
      const dy = p1.v - p0.v;
      if (Math.hypot(dx, dy) < eps) continue;
      const next: { u: number; v: number }[][] = [];
      for (const poly of polys) {
        for (const part of splitConvex(poly, p0.u, p0.v, dx, dy, eps)) next.push(part);
      }
      polys = next;
      // Cutting by the full line rather than the segment over-cuts a little.
      // The extra edges are harmless — they get welded and stitched later —
      // and it keeps every piece convex, which keeps this simple and exact.
      if (polys.length > 512) break;
    }

    const minArea = eps * eps;
    for (const poly of polys) {
      if (poly.length < 3 || polyArea2D(poly) <= minArea) continue;
      emit(poly.map(to3));
    }
  }
  return pieces;
}

/** Where is this piece relative to the other solid? */
type Side = 'inside' | 'outside' | 'onSurface';

function classify(piece: Piece, other: Operand, eps: number): Side {
  const centre = new Vec3();
  for (const p of piece.points) centre.addInPlace(p);
  centre.scaleInPlace(1 / piece.points.length);

  // A piece lying on the other surface has no meaningful parity — a ray from
  // it starts on the boundary. Real distance, not a bounding-box hit: a large
  // triangle's box covers points nowhere near the triangle itself.
  if (other.bvh.distanceTo(centre, eps * 8) <= eps * 4) return 'onSurface';

  return other.bvh.contains(centre) ? 'inside' : 'outside';
}

function reverse(piece: Piece): Piece {
  const points = piece.points.slice().reverse();
  let uv: number[] | null = null;
  if (piece.uv) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < piece.uv.length; i += 2) pairs.push([piece.uv[i], piece.uv[i + 1]]);
    pairs.reverse();
    uv = pairs.flat();
  }
  return { ...piece, points, uv };
}


function assemble(pieces: Piece[], weld: number, matOffset: (p: Piece) => number): Mesh {
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  const uvs: (number[] | null)[] = [];

  const cells = new Map<string, number[]>();
  const inv = 1 / weld;
  const weldSq = weld * weld;
  const intern = (p: Vec3): number => {
    const cx = Math.floor(p.x * inv);
    const cy = Math.floor(p.y * inv);
    const cz = Math.floor(p.z * inv);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const i of bucket) {
            const q = positions[i];
            if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2 <= weldSq) return i;
          }
        }
      }
    }
    const idx = positions.length;
    positions.push(p);
    const k = `${cx},${cy},${cz}`;
    const bucket = cells.get(k);
    if (bucket) bucket.push(idx);
    else cells.set(k, [idx]);
    return idx;
  };

  for (const piece of pieces) {
    const loop: number[] = [];
    const uvRun: number[] = [];
    for (let i = 0; i < piece.points.length; i++) {
      const v = intern(piece.points[i]);
      if (loop[loop.length - 1] === v) continue;
      loop.push(v);
      if (piece.uv) uvRun.push(piece.uv[i * 2], piece.uv[i * 2 + 1]);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) {
      loop.pop();
      uvRun.length = Math.max(0, uvRun.length - 2);
    }
    if (loop.length < 3) continue;
    // Welding can fold a sliver back on itself, giving a loop that visits the
    // same vertex twice. Those are the pieces that show up later as edges with
    // four faces, so they go now rather than becoming somebody else's problem.
    if (new Set(loop).size !== loop.length) continue;
    if (isSliver(loop.map((v) => positions[v]), weld)) continue;
    faces.push(loop);
    mats.push(matOffset(piece));
    smooth.push(piece.smooth);
    uvs.push(piece.uv && uvRun.length === loop.length * 2 ? uvRun : null);
  }

  const out = new Mesh(positions, faces, mats);
  if (smooth.some((s) => s)) out.faceSmooth = smooth;
  if (uvs.some((u) => u)) out.faceUV = uvs;
  return out;
}

/**
 * Combine two meshes. Both must be in the same space. Open surfaces have no
 * inside, so the classification falls back to "outside" for them, which turns
 * a union into a join and a difference into a no-op rather than nonsense.
 */
export function meshBoolean(a: Mesh, b: Mesh, op: BooleanOp, matOffset = 0): Mesh {
  if (a.faceCount === 0) {
    if (op === 'union') return b.clone();
    return new Mesh();
  }
  if (b.faceCount === 0) {
    if (op === 'intersect') return new Mesh();
    return a.clone();
  }

  const box = a.bounds();
  box.union(b.bounds());
  const scale = Math.max(1e-4, box.radius());
  const eps = 1e-7 * scale;

  // One tolerance throughout. Welding at a tighter distance than stitching is
  // what produces four-face edges: a face too thin to survive stitching still
  // passes the weld's sliver test, and then stitching wires its far side into
  // the same edge its near side already sits on.
  const tol = 1e-4 * scale;

  const A = prepare(a);
  const B = prepare(b);
  const snap = new VertexSnap(tol, a, b);

  // Collect the segments where the two surfaces cross.
  for (let ta = 0; ta < A.bvh.triangleCount; ta++) {
    const a0 = a.positions[A.bvh.tri[ta * 3]];
    const a1 = a.positions[A.bvh.tri[ta * 3 + 1]];
    const a2 = a.positions[A.bvh.tri[ta * 3 + 2]];
    const lo = new Vec3(
      Math.min(a0.x, a1.x, a2.x) - eps, Math.min(a0.y, a1.y, a2.y) - eps, Math.min(a0.z, a1.z, a2.z) - eps,
    );
    const hi = new Vec3(
      Math.max(a0.x, a1.x, a2.x) + eps, Math.max(a0.y, a1.y, a2.y) + eps, Math.max(a0.z, a1.z, a2.z) + eps,
    );
    for (const tb of B.bvh.queryBox(lo, hi)) {
      const b0 = b.positions[B.bvh.tri[tb * 3]];
      const b1 = b.positions[B.bvh.tri[tb * 3 + 1]];
      const b2 = b.positions[B.bvh.tri[tb * 3 + 2]];
      const seg = triangleIntersection(a0, a1, a2, b0, b1, b2, eps);
      if (!seg) continue;
      const cut: [Vec3, Vec3] = [snap.snap(seg[0]), snap.snap(seg[1])];
      if (cut[0].sub(cut[1]).lengthSq() <= eps * eps) continue;
      (A.cuts.get(ta) ?? A.cuts.set(ta, []).get(ta)!).push(cut);
      (B.cuts.get(tb) ?? B.cuts.set(tb, []).get(tb)!).push(cut);
    }
  }

  const piecesA = fragment(A, eps, 0);
  const piecesB = fragment(B, eps, 1);

  const keep: Piece[] = [];
  const wantAInside = op === 'intersect';
  const wantBInside = op !== 'union';

  for (const piece of piecesA) {
    const side = classify(piece, B, eps);
    if (side === 'onSurface') {
      // Coincident surface: keep A's copy for union and intersect, drop it for
      // a subtraction, which is the convention every modeller uses.
      if (op !== 'difference') keep.push(piece);
      continue;
    }
    if ((side === 'inside') === wantAInside) keep.push(piece);
  }

  for (const piece of piecesB) {
    const side = classify(piece, A, eps);
    if (side === 'onSurface') continue;
    if ((side === 'inside') !== wantBInside) continue;
    // A subtraction keeps the inside of B, turned to face outward.
    keep.push(op === 'union' || op === 'intersect' ? piece : reverse(piece));
  }

  const out = assemble(keep, tol, (p) => p.material + (p.operand === 1 ? matOffset : 0));
  out.shadeSmooth = a.shadeSmooth;
  out.cleanDegenerate();
  // Over-cutting leaves points sitting on a neighbour's edge; weld them in so
  // the result is a closed surface rather than one with hairline cracks.
  // Stitching lengthens loops, which can flatten one into a sliver, so clear
  // those out and stitch again over the gap they leave.
  stitchTJunctions(out, tol);
  if (dropSlivers(out, tol) > 0) stitchTJunctions(out, tol);
  // Near-tangent seams still leave the odd sliver of overlap. Repair rather
  // than tune: no tolerance setting removes all of them without eating detail.
  repairManifold(out, tol);
  return out;
}

/** Non-manifold or open input has no well-defined inside; callers may warn. */
export function isSolid(mesh: Mesh): boolean {
  if (mesh.faceCount === 0) return false;
  for (const e of mesh.topology().edges) if (e.faces.length !== 2) return false;
  return true;
}
