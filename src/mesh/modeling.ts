import { Mat4, Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Higher-level modelling operators built on top of the kernel: plane cuts,
 * revolves, loop bridging, symmetry and decimation.
 */

function pushFace(mesh: Mesh, loop: number[], likeFace: number, uv?: number[] | null): number {
  const idx = mesh.faces.length;
  mesh.faces.push(loop);
  mesh.faceMaterial.push(mesh.faceMaterial[likeFace] ?? 0);
  if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.isFaceSmooth(likeFace));
  if (uv !== undefined && mesh.faceUV) mesh.setUV(idx, uv);
  return idx;
}

function lerpUV(a: [number, number] | null, b: [number, number] | null, t: number): [number, number] | null {
  if (!a || !b) return null;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function packUV(list: ([number, number] | null)[]): number[] | null {
  const out: number[] = [];
  for (const p of list) {
    if (!p) return null;
    out.push(p[0], p[1]);
  }
  return out;
}

export interface BisectOptions {
  /** Cap the cut with new faces. */
  fill?: boolean;
  /** Discard geometry on the positive side of the plane. */
  clearFront?: boolean;
  /** Discard geometry on the negative side. */
  clearBack?: boolean;
}

export interface BisectResult {
  /** Vertices created along the cut, plus any existing ones it passed through. */
  cutVerts: number[];
  newFaces: number[];
}

/**
 * Cut the mesh with a plane (`normal · p = offset`), optionally throwing away
 * one side and capping the opening.
 */
export function bisect(
  mesh: Mesh, normal: Vec3, offset: number, opts: BisectOptions = {},
): BisectResult {
  const n = normal.normalized();
  const scale = Math.max(1e-6, mesh.bounds().radius());
  const eps = 1e-6 * scale;
  const nv = mesh.positions.length;
  const side = new Int8Array(nv);
  for (let i = 0; i < nv; i++) {
    const d = n.dot(mesh.positions[i]) - offset;
    side[i] = d > eps ? 1 : d < -eps ? -1 : 0;
  }

  const onPlane = new Set<number>();
  for (let i = 0; i < nv; i++) if (side[i] === 0) onPlane.add(i);

  // One new vertex per crossed edge, shared by both faces that use it.
  const crossing = new Map<number, number>();
  const key = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a);
  const splitPoint = (a: number, b: number): number => {
    const k = key(a, b);
    const found = crossing.get(k);
    if (found !== undefined) return found;
    const pa = mesh.positions[a];
    const pb = mesh.positions[b];
    const t = (offset - n.dot(pa)) / n.dot(pb.sub(pa));
    const idx = mesh.positions.length;
    mesh.positions.push(pa.lerp(pb, t));
    crossing.set(k, idx);
    onPlane.add(idx);
    return idx;
  };

  const faces: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  const uvs: (number[] | null)[] = [];
  const segments: [number, number][] = [];
  const carryUV = !!mesh.faceUV;

  const emit = (loop: number[], src: number, loopUV: ([number, number] | null)[] | null): void => {
    const dedup: number[] = [];
    const dedupUV: ([number, number] | null)[] = [];
    for (let i = 0; i < loop.length; i++) {
      if (dedup[dedup.length - 1] === loop[i]) continue;
      dedup.push(loop[i]);
      if (loopUV) dedupUV.push(loopUV[i]);
    }
    while (dedup.length > 1 && dedup[0] === dedup[dedup.length - 1]) {
      dedup.pop();
      dedupUV.pop();
    }
    if (dedup.length < 3) return;
    faces.push(dedup);
    mats.push(mesh.faceMaterial[src] ?? 0);
    smooth.push(mesh.isFaceSmooth(src));
    if (carryUV) uvs.push(loopUV ? packUV(dedupUV) : null);
  };

  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    let hasFront = false;
    let hasBack = false;
    for (const v of loop) {
      if (side[v] > 0) hasFront = true;
      else if (side[v] < 0) hasBack = true;
    }
    const srcUV = carryUV ? loop.map((_, i) => mesh.uvAt(f, i)) : null;
    if (!hasFront || !hasBack) {
      // Entirely on one side (or lying in the plane): keep or drop as asked.
      if (hasFront && opts.clearFront) continue;
      if (hasBack && opts.clearBack) continue;
      if (!hasFront && !hasBack && (opts.clearFront || opts.clearBack)) continue;
      emit(loop, f, srcUV);
      continue;
    }
    const front: number[] = [];
    const back: number[] = [];
    const frontUV: ([number, number] | null)[] = [];
    const backUV: ([number, number] | null)[] = [];
    const touched: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const j = (i + 1) % loop.length;
      const b = loop[j];
      if (side[a] >= 0) {
        front.push(a);
        if (srcUV) frontUV.push(srcUV[i]);
      }
      if (side[a] <= 0) {
        back.push(a);
        if (srcUV) backUV.push(srcUV[i]);
      }
      if (side[a] === 0) touched.push(a);
      if (side[a] * side[b] < 0) {
        const m = splitPoint(a, b);
        // Where along the edge the plane fell, in the same parameter the
        // position used.
        const pa = mesh.positions[a];
        const pb = mesh.positions[b];
        const denom = n.dot(pb.sub(pa));
        const tt = Math.abs(denom) < 1e-12 ? 0.5 : (offset - n.dot(pa)) / denom;
        const mid = srcUV ? lerpUV(srcUV[i], srcUV[j], tt) : null;
        front.push(m);
        back.push(m);
        if (srcUV) {
          frontUV.push(mid);
          backUV.push(mid);
        }
        touched.push(m);
      }
    }
    if (touched.length === 2) segments.push([touched[0], touched[1]]);
    if (!opts.clearFront) emit(front, f, srcUV ? frontUV : null);
    if (!opts.clearBack) emit(back, f, srcUV ? backUV : null);
  }

  mesh.faces = faces;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  if (carryUV) mesh.faceUV = uvs;
  mesh.markDirty();

  const newFaces: number[] = [];
  if (opts.fill && segments.length > 0) {
    for (const loop of chainLoops(segments)) {
      if (loop.length < 3) continue;
      const poly = orientLoop(mesh, loop, opts.clearFront ? n : n.neg());
      newFaces.push(pushFace(mesh, poly, 0));
    }
    mesh.markDirty();
  }

  const cutVerts = [...onPlane].filter((v) => v < mesh.positions.length);
  const map = mesh.removeLooseVertices();
  return { cutVerts: cutVerts.map((v) => map[v]).filter((v) => v >= 0), newFaces };
}

/** Link undirected segments into closed rings, dropping anything that dead-ends. */
export function chainLoops(segments: [number, number][]): number[][] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of segments) {
    if (a === b) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const usedEdge = new Set<string>();
  const loops: number[][] = [];
  for (const start of adj.keys()) {
    for (;;) {
      const firstNext = (adj.get(start) ?? []).find((n) => !usedEdge.has(`${Math.min(start, n)}-${Math.max(start, n)}`));
      if (firstNext === undefined) break;
      const loop = [start];
      let prev = start;
      let cur = firstNext;
      usedEdge.add(`${Math.min(prev, cur)}-${Math.max(prev, cur)}`);
      let closed = false;
      for (let guard = 0; guard < segments.length + 2; guard++) {
        loop.push(cur);
        const next = (adj.get(cur) ?? []).find(
          (n) => n !== prev && !usedEdge.has(`${Math.min(cur, n)}-${Math.max(cur, n)}`),
        );
        if (next === undefined) break;
        usedEdge.add(`${Math.min(cur, next)}-${Math.max(cur, next)}`);
        if (next === start) {
          closed = true;
          break;
        }
        prev = cur;
        cur = next;
      }
      if (closed && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

function orientLoop(mesh: Mesh, loop: number[], want: Vec3): number[] {
  const n = new Vec3();
  for (let i = 0; i < loop.length; i++) {
    const cur = mesh.positions[loop[i]];
    const nxt = mesh.positions[loop[(i + 1) % loop.length]];
    n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
    n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
    n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
  }
  return n.dot(want) < 0 ? loop.slice().reverse() : loop;
}

/**
 * Revolve the selected edges around an axis, sweeping out a surface.
 * A full turn welds the last ring back onto the first.
 */
export function spinEdges(
  mesh: Mesh, edgeSel: Iterable<number>, axis: Vec3, center: Vec3,
  angle = Math.PI * 2, steps = 12,
): { newVerts: number[]; newFaces: number[] } {
  const t = mesh.topology();
  const list = [...edgeSel].filter((ei) => t.edges[ei]);
  if (list.length === 0 || steps < 1) return { newVerts: [], newFaces: [] };

  const profile: number[] = [];
  const seen = new Set<number>();
  for (const ei of list) {
    for (const v of [t.edges[ei].a, t.edges[ei].b]) {
      if (!seen.has(v)) {
        seen.add(v);
        profile.push(v);
      }
    }
  }
  const pairs = list.map((ei) => [t.edges[ei].a, t.edges[ei].b] as [number, number]);
  const likeFace = t.edges[list[0]].faces[0] ?? 0;

  const full = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-6;
  const dA = angle / steps;
  const unit = axis.normalized();
  const newVerts: number[] = [];
  const newFaces: number[] = [];

  let ring = new Map<number, number>();
  for (const v of profile) ring.set(v, v);

  for (let s = 1; s <= steps; s++) {
    const last = full && s === steps;
    const next = new Map<number, number>();
    if (last) {
      for (const v of profile) next.set(v, v);
    } else {
      const rot = Mat4.translation(center)
        .multiply(Mat4.rotationAxis(unit, dA * s))
        .multiply(Mat4.translation(center.neg()));
      for (const v of profile) {
        const idx = mesh.positions.length;
        mesh.positions.push(rot.transformPoint(mesh.positions[v]));
        newVerts.push(idx);
        next.set(v, idx);
      }
    }
    for (const [a, b] of pairs) {
      const a0 = ring.get(a)!;
      const b0 = ring.get(b)!;
      const a1 = next.get(a)!;
      const b1 = next.get(b)!;
      const quad: number[] = [];
      for (const v of [a0, b0, b1, a1]) if (!quad.includes(v)) quad.push(v);
      if (quad.length >= 3) newFaces.push(pushFace(mesh, quad, likeFace));
    }
    ring = next;
  }

  mesh.markDirty();
  return { newVerts, newFaces };
}

/** Open chains and closed rings formed by a set of edges. */
export function edgeChains(mesh: Mesh, edgeSel: Iterable<number>): { verts: number[]; closed: boolean }[] {
  const t = mesh.topology();
  const adj = new Map<number, number[]>();
  const edges = [...edgeSel].filter((ei) => t.edges[ei]);
  for (const ei of edges) {
    const { a, b } = t.edges[ei];
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const visited = new Set<number>();
  const out: { verts: number[]; closed: boolean }[] = [];
  const walk = (start: number): number[] => {
    const chain = [start];
    visited.add(start);
    let cur = start;
    for (;;) {
      const next = (adj.get(cur) ?? []).find((v) => !visited.has(v));
      if (next === undefined) break;
      visited.add(next);
      chain.push(next);
      cur = next;
    }
    return chain;
  };
  // Open chains start at an endpoint of valence 1.
  for (const [v, ns] of adj) {
    if (ns.length === 1 && !visited.has(v)) out.push({ verts: walk(v), closed: false });
  }
  for (const v of adj.keys()) {
    if (visited.has(v)) continue;
    const chain = walk(v);
    out.push({ verts: chain, closed: chain.length > 2 });
  }
  return out;
}

/**
 * Join two edge loops with a band of quads, rotating and flipping the second
 * loop to whichever alignment gives the shortest total span.
 */
export function bridgeLoops(
  mesh: Mesh, edgeSel: Iterable<number>,
): { newFaces: number[]; error?: string } {
  const chains = edgeChains(mesh, edgeSel);
  if (chains.length !== 2) {
    return { newFaces: [], error: `Bridge needs exactly two loops, found ${chains.length}` };
  }
  const [A, B] = chains;
  if (A.verts.length !== B.verts.length) {
    return { newFaces: [], error: `Loops have ${A.verts.length} and ${B.verts.length} vertices` };
  }
  const n = A.verts.length;
  const closed = A.closed && B.closed;

  const cost = (offset: number, flip: boolean): number => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = flip ? (offset - i + n * 2) % n : (offset + i) % n;
      sum += mesh.positions[A.verts[i]].distanceTo(mesh.positions[B.verts[j]]);
    }
    return sum;
  };
  let best = { offset: 0, flip: false, cost: Infinity };
  const offsets = closed ? n : 1;
  for (let o = 0; o < offsets; o++) {
    for (const flip of [false, true]) {
      const c = cost(o, flip);
      if (c < best.cost) best = { offset: o, flip, cost: c };
    }
  }

  const mapB = (i: number): number => (
    best.flip ? B.verts[(best.offset - i + n * 2) % n] : B.verts[(best.offset + i) % n]
  );
  const t = mesh.topology();
  const likeFace = t.vertFaces[A.verts[0]]?.[0] ?? 0;
  const newFaces: number[] = [];
  const span = closed ? n : n - 1;
  for (let i = 0; i < span; i++) {
    const a0 = A.verts[i];
    const a1 = A.verts[(i + 1) % n];
    const b0 = mapB(i);
    const b1 = mapB((i + 1) % n);
    const quad: number[] = [];
    for (const v of [a0, a1, b1, b0]) if (!quad.includes(v)) quad.push(v);
    if (quad.length >= 3) newFaces.push(pushFace(mesh, quad, likeFace));
  }
  mesh.markDirty();
  return { newFaces };
}

/**
 * Mirror one half of the mesh onto the other: cut on the axis plane, drop the
 * far side, mirror what is left and weld along the seam.
 */
export function symmetrize(mesh: Mesh, axis: 0 | 1 | 2, positiveToNegative = true): void {
  const n = Vec3.axis(axis);
  bisect(mesh, n, 0, positiveToNegative ? { clearBack: true } : { clearFront: true });

  const keepCount = mesh.positions.length;
  const faceCount = mesh.faces.length;
  const eps = 1e-6 * Math.max(1e-6, mesh.bounds().radius());
  const map = new Int32Array(keepCount).fill(-1);
  for (let i = 0; i < keepCount; i++) {
    const p = mesh.positions[i];
    const c = axis === 0 ? p.x : axis === 1 ? p.y : p.z;
    if (Math.abs(c) <= eps) {
      map[i] = i;
      continue;
    }
    const q = p.clone();
    if (axis === 0) q.x = -q.x;
    else if (axis === 1) q.y = -q.y;
    else q.z = -q.z;
    map[i] = mesh.positions.length;
    mesh.positions.push(q);
  }
  for (let f = 0; f < faceCount; f++) {
    const loop = mesh.faces[f].map((v) => map[v]).reverse();
    const dedup: number[] = [];
    for (const v of loop) if (dedup[dedup.length - 1] !== v) dedup.push(v);
    while (dedup.length > 1 && dedup[0] === dedup[dedup.length - 1]) dedup.pop();
    if (dedup.length >= 3) pushFace(mesh, dedup, f);
  }
  mesh.markDirty();
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
}

/** Fan each face out from a new vertex at its centre. */
export function pokeFaces(mesh: Mesh, faceSel: Iterable<number>, offset = 0): { newVerts: number[] } {
  const t = mesh.topology();
  const targets = [...new Set(faceSel)].filter((f) => mesh.faces[f]?.length >= 3);
  if (targets.length === 0) return { newVerts: [] };
  const newVerts: number[] = [];
  const drop = new Set(targets);
  for (const f of targets) {
    const loop = mesh.faces[f];
    const c = mesh.faceCenter(f).add(t.faceNormals[f].scale(offset));
    const ci = mesh.positions.length;
    mesh.positions.push(c);
    newVerts.push(ci);
    const src = mesh.faceUV ? loop.map((_, i) => mesh.uvAt(f, i)) : null;
    let centre: [number, number] | null = null;
    if (src && src.every(Boolean)) {
      centre = [
        src.reduce((a, p) => a + p![0], 0) / src.length,
        src.reduce((a, p) => a + p![1], 0) / src.length,
      ];
    }
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      pushFace(mesh, [loop[i], loop[j], ci], f, src ? packUV([src[i], src[j], centre]) : undefined);
    }
  }
  const faces: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  const uvs: (number[] | null)[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    if (drop.has(f)) continue;
    faces.push(mesh.faces[f]);
    mats.push(mesh.faceMaterial[f] ?? 0);
    smooth.push(mesh.isFaceSmooth(f));
    uvs.push(mesh.uvFor(f));
  }
  mesh.faces = faces;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  if (mesh.faceUV) mesh.faceUV = uvs;
  mesh.markDirty();
  return { newVerts };
}
