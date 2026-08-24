import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Post-boolean cleanup.
 *
 * The boolean itself lives in `csg.ts`; what is left here is the tidying every
 * cut mesh needs: merging the fragments a cut leaves behind, and closing the
 * T-junctions where a split face meets an unsplit neighbour.
 */

export { meshBoolean, isSolid } from './csg';
export type { BooleanOp } from './csg';

/**
 * Merge neighbouring faces that lie in the same plane into single n-gons.
 * Booleans and imported triangle soups both leave a lot of these behind.
 */
export function dissolveCoplanar(mesh: Mesh, angleDeg = 1): number {
  const t = mesh.topology();
  const cosLimit = Math.cos(angleDeg * Math.PI / 180);
  const parent = new Int32Array(mesh.faces.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  let merges = 0;
  for (const e of t.edges) {
    if (e.faces.length !== 2) continue;
    const [f0, f1] = e.faces;
    if (mesh.faceMaterial[f0] !== mesh.faceMaterial[f1]) continue;
    if (mesh.isFaceSmooth(f0) !== mesh.isFaceSmooth(f1)) continue;
    if (t.faceNormals[f0].dot(t.faceNormals[f1]) < cosLimit) continue;
    const a = find(f0);
    const b = find(f1);
    if (a !== b) {
      parent[a] = b;
      merges++;
    }
  }
  if (merges === 0) return 0;

  const groups = new Map<number, number[]>();
  for (let f = 0; f < mesh.faces.length; f++) {
    const r = find(f);
    const g = groups.get(r);
    if (g) g.push(f);
    else groups.set(r, [f]);
  }

  const faces: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  let dissolved = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      faces.push(mesh.faces[group[0]]);
      mats.push(mesh.faceMaterial[group[0]] ?? 0);
      smooth.push(mesh.isFaceSmooth(group[0]));
      continue;
    }
    const loops = groupBoundaryLoops(mesh, group);
    if (loops.length !== 1 || loops[0].length < 3) {
      // Holes or a disjoint boundary: safer to leave the group alone.
      for (const f of group) {
        faces.push(mesh.faces[f]);
        mats.push(mesh.faceMaterial[f] ?? 0);
        smooth.push(mesh.isFaceSmooth(f));
      }
      continue;
    }
    faces.push(loops[0]);
    mats.push(mesh.faceMaterial[group[0]] ?? 0);
    smooth.push(mesh.isFaceSmooth(group[0]));
    dissolved += group.length - 1;
  }

  mesh.faces = faces;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  mesh.markDirty();
  mesh.removeLooseVertices();
  return dissolved;
}

/** Boundary loops of a set of faces, as vertex index rings. */
function groupBoundaryLoops(mesh: Mesh, group: number[]): number[][] {
  const inGroup = new Set(group);
  const t = mesh.topology();
  const next = new Map<number, number>();
  for (const f of group) {
    const loop = mesh.faces[f];
    for (let i = 0; i < loop.length; i++) {
      const ei = t.faceEdges[f][i];
      if (ei < 0) continue;
      let inside = 0;
      for (const nf of t.edges[ei].faces) if (inGroup.has(nf)) inside++;
      if (inside === 1) next.set(loop[i], loop[(i + 1) % loop.length]);
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: number[] = [];
    let cur = start;
    for (let guard = 0; guard < next.size + 2; guard++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      ring.push(cur);
      const nxt = next.get(cur);
      if (nxt === undefined) break;
      if (nxt === start) {
        loops.push(ring);
        break;
      }
      cur = nxt;
    }
  }
  return loops;
}

/**
 * Insert vertices that sit in the middle of another face's edge into that
 * edge, turning T-junctions into shared edges.
 *
 * Splitting a face does not split its unsplit neighbour, so any operation that
 * cuts across a surface leaves these behind. They read as hairline cracks and
 * they break every adjacency query downstream, so nothing that cuts should
 * return without calling this.
 */
export function stitchTJunctions(mesh: Mesh, eps = 1e-5): number {
  let inserted = 0;
  for (let pass = 0; pass < 4; pass++) {
    const t = mesh.topology();
    const openEdges: number[] = [];
    const candidates = new Set<number>();
    for (let i = 0; i < t.edges.length; i++) {
      if (t.edges[i].faces.length === 1) {
        openEdges.push(i);
        candidates.add(t.edges[i].a);
        candidates.add(t.edges[i].b);
      }
    }
    if (openEdges.length === 0) break;
    const cand = [...candidates];

    // edge index -> extra vertices to insert, ordered from a to b
    const extra = new Map<number, number[]>();
    const epsSq = eps * eps;
    for (const ei of openEdges) {
      const e = t.edges[ei];
      const a = mesh.positions[e.a];
      const b = mesh.positions[e.b];
      const ab = b.sub(a);
      const lenSq = ab.lengthSq();
      if (lenSq < epsSq) continue;
      const lo = new Vec3(Math.min(a.x, b.x) - eps, Math.min(a.y, b.y) - eps, Math.min(a.z, b.z) - eps);
      const hi = new Vec3(Math.max(a.x, b.x) + eps, Math.max(a.y, b.y) + eps, Math.max(a.z, b.z) + eps);
      const hits: { v: number; t: number }[] = [];
      for (const v of cand) {
        if (v === e.a || v === e.b) continue;
        const p = mesh.positions[v];
        if (p.x < lo.x || p.y < lo.y || p.z < lo.z || p.x > hi.x || p.y > hi.y || p.z > hi.z) continue;
        const ap = p.sub(a);
        const u = ap.dot(ab) / lenSq;
        if (u <= 0 || u >= 1) continue;
        if (ap.sub(ab.scale(u)).lengthSq() > epsSq) continue;
        hits.push({ v, t: u });
      }
      if (hits.length === 0) continue;
      hits.sort((x, y) => x.t - y.t);
      const seq: number[] = [];
      for (const h of hits) if (seq[seq.length - 1] !== h.v) seq.push(h.v);
      extra.set(ei, seq);
    }
    if (extra.size === 0) break;

    for (let f = 0; f < mesh.faces.length; f++) {
      const loop = mesh.faces[f];
      const fe = t.faceEdges[f];
      const srcUV = mesh.uvFor(f);
      // A vertex that is already a corner of this face must not be inserted a
      // second time: the face is a sliver folded against itself, and adding the
      // repeat is what turns a hairline crack into a four-face edge.
      const present = new Set(loop);
      let changed = false;
      const out: number[] = [];
      const outUV: number[] = [];
      for (let i = 0; i < loop.length; i++) {
        out.push(loop[i]);
        if (srcUV) outUV.push(srcUV[i * 2], srcUV[i * 2 + 1]);
        const ei = fe[i];
        const seq = ei >= 0 ? extra.get(ei) : undefined;
        if (!seq) continue;
        const e = t.edges[ei];
        const forward = loop[i] === e.a;
        const ordered = (forward ? seq : seq.slice().reverse()).filter((v) => !present.has(v));
        if (ordered.length === 0) continue;
        for (const v of ordered) {
          out.push(v);
          present.add(v);
          if (srcUV) {
            // The inserted point is on the edge, so its coordinates are too.
            const a = mesh.positions[loop[i]];
            const b = mesh.positions[loop[(i + 1) % loop.length]];
            const ab = b.sub(a);
            const denom = ab.lengthSq();
            const u = denom > 1e-20 ? mesh.positions[v].sub(a).dot(ab) / denom : 0;
            const j = ((i + 1) % loop.length) * 2;
            outUV.push(
              srcUV[i * 2] + (srcUV[j] - srcUV[i * 2]) * u,
              srcUV[i * 2 + 1] + (srcUV[j + 1] - srcUV[i * 2 + 1]) * u,
            );
          }
        }
        changed = true;
        inserted += ordered.length;
      }
      if (changed) {
        mesh.faces[f] = out;
        if (srcUV) mesh.setUV(f, outUV);
      }
    }
    mesh.markDirty();
  }
  return inserted;
}

/** Area of a 3D polygon, via Newell. */
function polyArea3D(points: Vec3[]): number {
  const n = new Vec3();
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const nxt = points[(i + 1) % points.length];
    n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
    n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
    n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
  }
  return n.length() * 0.5;
}

/**
 * Is this loop thinner than `eps`, measured across its longest edge?
 *
 * Raw area is the wrong test: a long thin sliver and a small honest triangle
 * can have the same area. What matters is whether the loop is thinner than the
 * distance at which two points count as the same — if it is, its far side is
 * the same edge as its near side, and keeping it means covering that edge
 * twice.
 */
export function isSliver(points: Vec3[], eps: number): boolean {
  let longest = 0;
  for (let i = 0; i < points.length; i++) {
    const d = points[(i + 1) % points.length].sub(points[i]).length();
    if (d > longest) longest = d;
  }
  if (longest <= eps) return true;
  return (2 * polyArea3D(points)) / longest <= eps;
}

/** Drop faces that have collapsed to a sliver at the given tolerance. */
export function dropSlivers(mesh: Mesh, eps: number): number {
  const faces: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  const uvs: (number[] | null)[] = [];
  let dropped = 0;
  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    // A loop that visits a vertex twice is a face folded against itself, not a
    // face with a hole; it has no interior to keep.
    const folded = new Set(loop).size !== loop.length;
    if (loop.length < 3 || folded || isSliver(loop.map((v) => mesh.positions[v]), eps)) {
      dropped++;
      continue;
    }
    faces.push(loop);
    mats.push(mesh.faceMaterial[f] ?? 0);
    smooth.push(mesh.isFaceSmooth(f));
    uvs.push(mesh.uvFor(f));
  }
  if (dropped === 0) return 0;
  mesh.faces = faces;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  if (mesh.faceUV) mesh.faceUV = uvs;
  mesh.markDirty();
  return dropped;
}

/**
 * Force a cut mesh back to a closed 2-manifold.
 *
 * Any floating-point boolean eventually meets a case where two surfaces cross
 * so nearly tangentially that the seam comes out a hair off: one face ends up
 * overlapping its neighbour by a sliver, and the seam between them carries
 * three faces instead of two. No single tolerance fixes that — tighten it and
 * the sliver survives, loosen it and honest detail collapses instead. So
 * rather than tuning, repair: collapse the runt edges the artifact hangs on,
 * clear out whatever folds up as a result, and repeat until the surface closes
 * or stops improving.
 *
 * Returns true when the mesh came out closed.
 */
export function repairManifold(mesh: Mesh, eps: number): boolean {
  const bad = (m: Mesh): number => {
    let n = 0;
    for (const e of m.topology().edges) if (e.faces.length !== 2) n++;
    return n;
  };

  // First close what can simply be closed: an open edge whose neighbour never
  // got the matching split is a T-junction, not damage.
  stitchTJunctions(mesh, eps);

  let remaining = bad(mesh);
  for (let pass = 0; pass < 8 && remaining > 0; pass++) {
    const t = mesh.topology();
    // A runt edge is one far shorter than the mesh's own scale. Judging against
    // the median rather than a constant keeps this working on a model of any
    // size, and keeps it from touching a mesh that is uniformly fine.
    const lens = t.edges
      .map((e) => mesh.positions[e.a].sub(mesh.positions[e.b]).length())
      .sort((x, y) => x - y);
    if (lens.length === 0) break;
    const runt = Math.max(eps, lens[lens.length >> 1] * 0.1);

    const parent = new Int32Array(mesh.positions.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    let collapsed = 0;
    for (let i = 0; i < t.edges.length; i++) {
      const e = t.edges[i];
      if (e.faces.length === 2) continue;
      if (lens.length && mesh.positions[e.a].sub(mesh.positions[e.b]).length() > runt) continue;
      const ra = find(e.a);
      const rb = find(e.b);
      if (ra === rb) continue;
      parent[Math.max(ra, rb)] = Math.min(ra, rb);
      collapsed++;
    }
    if (collapsed === 0) break;

    for (const loop of mesh.faces) for (let i = 0; i < loop.length; i++) loop[i] = find(loop[i]);
    mesh.markDirty();
    mesh.cleanDegenerate();
    dropSlivers(mesh, eps);
    stitchTJunctions(mesh, eps);

    const now = bad(mesh);
    if (now >= remaining) {
      remaining = now;
      break;
    }
    remaining = now;
  }
  mesh.removeLooseVertices();
  return remaining === 0;
}
