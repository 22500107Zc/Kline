import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Constructive solid geometry.
 *
 * Both operands go into BSP trees; clipping one tree against the other sorts
 * every polygon into "inside the other solid" or "outside it", which is all
 * three boolean operations need. Working on n-gons rather than triangles keeps
 * the untouched parts of each operand as whole faces, so only the polygons the
 * cut actually crosses get fragmented.
 */

export type BooleanOp = 'union' | 'difference' | 'intersect';

interface Poly {
  v: Vec3[];
  n: Vec3;
  w: number;
  mat: number;
  smooth: boolean;
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

function planeFrom(v: Vec3[]): { n: Vec3; w: number } | null {
  const n = new Vec3();
  for (let i = 0; i < v.length; i++) {
    const cur = v[i];
    const nxt = v[(i + 1) % v.length];
    n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
    n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
    n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
  }
  const len = n.length();
  if (len < 1e-14) return null;
  const un = n.scale(1 / len);
  return { n: un, w: un.dot(v[0]) };
}

function toPolys(mesh: Mesh, matOffset: number): Poly[] {
  const out: Poly[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    if (loop.length < 3) continue;
    const v = loop.map((i) => mesh.positions[i].clone());
    const pl = planeFrom(v);
    if (!pl) continue;
    out.push({ v, n: pl.n, w: pl.w, mat: (mesh.faceMaterial[f] ?? 0) + matOffset, smooth: mesh.isFaceSmooth(f) });
  }
  return out;
}

function flip(p: Poly): void {
  p.v.reverse();
  p.n = p.n.neg();
  p.w = -p.w;
}

/** Sort `poly` against a plane, splitting it when it straddles. */
function splitPoly(
  pn: Vec3, pw: number, poly: Poly, eps: number,
  coplanarFront: Poly[], coplanarBack: Poly[], front: Poly[], back: Poly[],
): void {
  let type = 0;
  const types: number[] = [];
  for (const p of poly.v) {
    const t = pn.dot(p) - pw;
    const kind = t < -eps ? BACK : t > eps ? FRONT : COPLANAR;
    type |= kind;
    types.push(kind);
  }
  switch (type) {
    case COPLANAR:
      (pn.dot(poly.n) > 0 ? coplanarFront : coplanarBack).push(poly);
      return;
    case FRONT:
      front.push(poly);
      return;
    case BACK:
      back.push(poly);
      return;
    default: {
      const fv: Vec3[] = [];
      const bv: Vec3[] = [];
      for (let i = 0; i < poly.v.length; i++) {
        const j = (i + 1) % poly.v.length;
        const ti = types[i];
        const tj = types[j];
        const vi = poly.v[i];
        const vj = poly.v[j];
        if (ti !== BACK) fv.push(vi);
        if (ti !== FRONT) bv.push(ti !== BACK ? vi.clone() : vi);
        if ((ti | tj) === SPANNING) {
          const t = (pw - pn.dot(vi)) / pn.dot(vj.sub(vi));
          const mid = vi.lerp(vj, t);
          fv.push(mid);
          bv.push(mid.clone());
        }
      }
      if (fv.length >= 3) front.push({ v: fv, n: poly.n, w: poly.w, mat: poly.mat, smooth: poly.smooth });
      if (bv.length >= 3) back.push({ v: bv, n: poly.n, w: poly.w, mat: poly.mat, smooth: poly.smooth });
      return;
    }
  }
}

interface Node {
  n: Vec3 | null;
  w: number;
  front: Node | null;
  back: Node | null;
  polys: Poly[];
}

function newNode(): Node {
  return { n: null, w: 0, front: null, back: null, polys: [] };
}

/** Iterative build — BSP depth is data-dependent and can outrun the JS stack. */
function build(root: Node, polys: Poly[], eps: number): void {
  const stack: { node: Node; polys: Poly[] }[] = [{ node: root, polys }];
  while (stack.length) {
    const { node, polys: list } = stack.pop()!;
    if (list.length === 0) continue;
    if (!node.n) {
      node.n = list[0].n;
      node.w = list[0].w;
    }
    const front: Poly[] = [];
    const back: Poly[] = [];
    for (const p of list) splitPoly(node.n, node.w, p, eps, node.polys, node.polys, front, back);
    if (front.length) {
      node.front = node.front ?? newNode();
      stack.push({ node: node.front, polys: front });
    }
    if (back.length) {
      node.back = node.back ?? newNode();
      stack.push({ node: node.back, polys: back });
    }
  }
}

function allNodes(root: Node): Node[] {
  const out: Node[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    if (n.front) stack.push(n.front);
    if (n.back) stack.push(n.back);
  }
  return out;
}

function allPolys(root: Node): Poly[] {
  const out: Poly[] = [];
  for (const n of allNodes(root)) for (const p of n.polys) out.push(p);
  return out;
}

function invert(root: Node): void {
  for (const node of allNodes(root)) {
    for (const p of node.polys) flip(p);
    if (node.n) {
      node.n = node.n.neg();
      node.w = -node.w;
    }
    const t = node.front;
    node.front = node.back;
    node.back = t;
  }
}

/** Drop the parts of `polys` that fall inside the solid `root` describes. */
function clipPolys(root: Node, polys: Poly[], eps: number): Poly[] {
  const out: Poly[] = [];
  const stack: { node: Node; polys: Poly[] }[] = [{ node: root, polys }];
  while (stack.length) {
    const { node, polys: list } = stack.pop()!;
    if (list.length === 0) continue;
    if (!node.n) {
      for (const p of list) out.push(p);
      continue;
    }
    const front: Poly[] = [];
    const back: Poly[] = [];
    for (const p of list) splitPoly(node.n, node.w, p, eps, front, back, front, back);
    if (node.front) stack.push({ node: node.front, polys: front });
    else for (const p of front) out.push(p);
    // No back child means everything back of this plane is solid: discard it.
    if (node.back) stack.push({ node: node.back, polys: back });
  }
  return out;
}

function clipTo(target: Node, other: Node, eps: number): void {
  for (const node of allNodes(target)) node.polys = clipPolys(other, node.polys, eps);
}

function polysToMesh(polys: Poly[], weld: number): Mesh {
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  // Cell size equals the weld radius, so a match is always in one of the 27
  // cells around the query. Rounding to a single cell would miss pairs that
  // straddle a cell boundary, which is exactly where split points land.
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
            const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
            if (d <= weldSq) return i;
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
  for (const poly of polys) {
    const loop: number[] = [];
    for (const p of poly.v) {
      const i = intern(p);
      if (loop[loop.length - 1] !== i) loop.push(i);
    }
    while (loop.length > 1 && loop[0] === loop[loop.length - 1]) loop.pop();
    if (loop.length < 3) continue;
    faces.push(loop);
    mats.push(poly.mat);
    smooth.push(poly.smooth);
  }
  const m = new Mesh(positions, faces, mats);
  if (smooth.some((s) => s)) m.faceSmooth = smooth;
  return m;
}

/**
 * Combine two meshes. Both must already be in the same coordinate space, and
 * both should be closed solids — an open surface has no well-defined inside,
 * so the result there is whatever the clipping happens to produce.
 *
 * `matOffset` shifts B's material slots so a caller can keep the two operands'
 * materials apart in the joined result.
 */
export function meshBoolean(a: Mesh, b: Mesh, op: BooleanOp, matOffset = 0): Mesh {
  const box = a.bounds();
  box.union(b.bounds());
  const scale = Math.max(1e-3, box.radius());
  const eps = 1e-7 * scale;

  const A = newNode();
  const B = newNode();
  build(A, toPolys(a, 0), eps);
  build(B, toPolys(b, matOffset), eps);

  switch (op) {
    case 'union':
      clipTo(A, B, eps);
      clipTo(B, A, eps);
      invert(B);
      clipTo(B, A, eps);
      invert(B);
      build(A, allPolys(B), eps);
      break;
    case 'difference':
      invert(A);
      clipTo(A, B, eps);
      clipTo(B, A, eps);
      invert(B);
      clipTo(B, A, eps);
      invert(B);
      build(A, allPolys(B), eps);
      invert(A);
      break;
    case 'intersect':
      invert(A);
      clipTo(B, A, eps);
      invert(B);
      clipTo(A, B, eps);
      clipTo(B, A, eps);
      build(A, allPolys(B), eps);
      invert(A);
      break;
  }

  const out = polysToMesh(allPolys(A), 1e-5 * scale);
  out.cleanDegenerate();
  // Splitting a polygon does not split its unsplit neighbour, so the cut line
  // is littered with T-junctions. They read as cracks and break every
  // adjacency query, so close them before handing the mesh back.
  stitchTJunctions(out, 1e-4 * scale);
  out.removeLooseVertices();
  return out;
}

/**
 * Insert vertices that sit in the middle of another face's edge into that
 * edge, turning T-junctions into shared edges.
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
      let changed = false;
      const out: number[] = [];
      for (let i = 0; i < loop.length; i++) {
        out.push(loop[i]);
        const ei = fe[i];
        const seq = ei >= 0 ? extra.get(ei) : undefined;
        if (!seq) continue;
        const e = t.edges[ei];
        const forward = loop[i] === e.a;
        for (const v of forward ? seq : seq.slice().reverse()) out.push(v);
        changed = true;
        inserted += seq.length;
      }
      if (changed) mesh.faces[f] = out;
    }
    mesh.markDirty();
  }
  return inserted;
}

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
