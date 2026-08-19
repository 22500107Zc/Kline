import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Destructive mesh operators. Each takes a mesh plus a selection and edits it
 * in place, returning whatever the caller needs to re-derive selection state.
 *
 * Conventions:
 *  - operators never leave loose vertices behind unless documented;
 *  - existing face indices stay stable where possible, so a face selection
 *    survives the edit;
 *  - every operator calls `mesh.markDirty()` before returning.
 */

export interface BoundaryEdge {
  /** Edge index in the topology at call time. */
  ei: number;
  /** Directed as traversed by `face`'s corner loop. */
  a: number;
  b: number;
  face: number;
}

/** Edges of `faceSet` that have exactly one incident face inside the set. */
export function regionBoundary(mesh: Mesh, faceSet: Set<number>): BoundaryEdge[] {
  const t = mesh.topology();
  const out: BoundaryEdge[] = [];
  for (const f of faceSet) {
    const loop = mesh.faces[f];
    if (!loop) continue;
    for (let i = 0; i < loop.length; i++) {
      const ei = t.faceEdges[f][i];
      if (ei === undefined || ei < 0) continue;
      let inside = 0;
      for (const nf of t.edges[ei].faces) if (faceSet.has(nf)) inside++;
      if (inside === 1) out.push({ ei, a: loop[i], b: loop[(i + 1) % loop.length], face: f });
    }
  }
  return out;
}

/** Every vertex touched by the given faces. */
export function facesToVerts(mesh: Mesh, faces: Iterable<number>): Set<number> {
  const s = new Set<number>();
  for (const f of faces) for (const v of mesh.faces[f] ?? []) s.add(v);
  return s;
}

function pushFace(mesh: Mesh, loop: number[], likeFace: number): number {
  const idx = mesh.faces.length;
  mesh.faces.push(loop);
  mesh.faceMaterial.push(mesh.faceMaterial[likeFace] ?? 0);
  if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.isFaceSmooth(likeFace));
  return idx;
}

export interface RegionSplitResult {
  /** Original boundary vertex -> its freshly duplicated copy. */
  vertMap: Map<number, number>;
  /** Indices of the side-wall faces created around the region. */
  walls: number[];
  boundary: BoundaryEdge[];
  /** Vertices belonging to the (now detached) region after the split. */
  movedVerts: Set<number>;
}

/**
 * Detach `faceSet` from the rest of the mesh along its boundary, duplicating
 * only the boundary vertices and stitching a ring of quads between the old and
 * new boundary. This is the shared skeleton of extrude and inset — the two
 * differ purely in where the duplicated vertices are then moved.
 */
export function splitRegion(mesh: Mesh, faceSet: Set<number>): RegionSplitResult {
  const boundary = regionBoundary(mesh, faceSet);
  const vertMap = new Map<number, number>();
  for (const be of boundary) {
    for (const v of [be.a, be.b]) {
      if (!vertMap.has(v)) {
        vertMap.set(v, mesh.positions.length);
        mesh.positions.push(mesh.positions[v].clone());
      }
    }
  }

  for (const f of faceSet) {
    mesh.faces[f] = mesh.faces[f].map((v) => vertMap.get(v) ?? v);
  }

  const walls: number[] = [];
  for (const be of boundary) {
    const a2 = vertMap.get(be.a)!;
    const b2 = vertMap.get(be.b)!;
    walls.push(pushFace(mesh, [b2, a2, be.a, be.b], be.face));
  }

  mesh.markDirty();
  return { vertMap, walls, boundary, movedVerts: facesToVerts(mesh, faceSet) };
}

export interface ExtrudeResult {
  movedVerts: Set<number>;
  walls: number[];
  normal: Vec3;
}

/** Extrude a region of faces. The region is left in place; move `movedVerts` to finish. */
export function extrudeFaces(mesh: Mesh, faces: Iterable<number>): ExtrudeResult {
  const faceSet = new Set(faces);
  if (faceSet.size === 0) return { movedVerts: new Set(), walls: [], normal: new Vec3(0, 0, 1) };

  const t = mesh.topology();
  const normal = new Vec3();
  for (const f of faceSet) normal.addInPlace(t.faceNormals[f]);
  const n = normal.lengthSq() > 1e-12 ? normal.normalized() : new Vec3(0, 0, 1);

  const res = splitRegion(mesh, faceSet);
  return { movedVerts: res.movedVerts, walls: res.walls, normal: n };
}

/** Extrude selected boundary edges into new quads. Returns the new vertices. */
export function extrudeEdges(mesh: Mesh, edges: Iterable<number>): Set<number> {
  const t = mesh.topology();
  const list = [...edges];
  const vertMap = new Map<number, number>();
  const moved = new Set<number>();
  for (const ei of list) {
    const e = t.edges[ei];
    if (!e) continue;
    for (const v of [e.a, e.b]) {
      if (!vertMap.has(v)) {
        const nv = mesh.positions.length;
        mesh.positions.push(mesh.positions[v].clone());
        vertMap.set(v, nv);
        moved.add(nv);
      }
    }
  }
  for (const ei of list) {
    const e = t.edges[ei];
    if (!e) continue;
    const a2 = vertMap.get(e.a)!;
    const b2 = vertMap.get(e.b)!;
    pushFace(mesh, [e.a, e.b, b2, a2], e.faces[0] ?? 0);
  }
  mesh.markDirty();
  return moved;
}

/**
 * Inset a face region: the region shrinks inward by `thickness` inside its own
 * plane and shifts by `depth` along the region normal, with a ring of new faces
 * filling the gap.
 */
export function insetFaces(
  mesh: Mesh, faces: Iterable<number>, thickness = 0.1, depth = 0,
): { movedVerts: Set<number>; ring: number[] } {
  const faceSet = new Set(faces);
  if (faceSet.size === 0) return { movedVerts: new Set(), ring: [] };

  const before = mesh.topology();
  const regionNormal = new Vec3();
  for (const f of faceSet) regionNormal.addInPlace(before.faceNormals[f]);
  const rn = regionNormal.lengthSq() > 1e-12 ? regionNormal.normalized() : new Vec3(0, 0, 1);

  // Inward direction per boundary vertex, computed before the topology changes:
  // average of the vectors toward the centers of the region faces around it.
  const inward = new Map<number, Vec3>();
  const boundary = regionBoundary(mesh, faceSet);
  const bverts = new Set<number>();
  for (const be of boundary) {
    bverts.add(be.a);
    bverts.add(be.b);
  }
  for (const v of bverts) {
    const dir = new Vec3();
    for (const f of before.vertFaces[v] ?? []) {
      if (!faceSet.has(f)) continue;
      const d = before.faceCenters[f].sub(mesh.positions[v]);
      if (d.lengthSq() > 1e-16) dir.addInPlace(d.normalized());
    }
    const flat = dir.sub(rn.scale(dir.dot(rn)));
    inward.set(v, flat.lengthSq() > 1e-16 ? flat.normalized() : new Vec3());
  }

  const res = splitRegion(mesh, faceSet);
  for (const [old, nv] of res.vertMap) {
    const dir = inward.get(old) ?? new Vec3();
    mesh.positions[nv] = mesh.positions[old].add(dir.scale(thickness)).add(rn.scale(depth));
  }
  // Interior vertices only need the depth offset.
  const boundaryCopies = new Set(res.vertMap.values());
  if (depth !== 0) {
    for (const v of res.movedVerts) {
      if (!boundaryCopies.has(v)) mesh.positions[v] = mesh.positions[v].add(rn.scale(depth));
    }
  }
  mesh.markDirty();
  return { movedVerts: res.movedVerts, ring: res.walls };
}

/** Inset each selected face on its own, without sharing boundaries. */
export function insetFacesIndividual(
  mesh: Mesh, faces: Iterable<number>, thickness = 0.1, depth = 0,
): { movedVerts: Set<number>; ring: number[] } {
  const moved = new Set<number>();
  const ring: number[] = [];
  for (const f of faces) {
    const r = insetFaces(mesh, [f], thickness, depth);
    for (const v of r.movedVerts) moved.add(v);
    ring.push(...r.ring);
  }
  return { movedVerts: moved, ring };
}

/** Ring of quads crossed by walking perpendicular to `startEdge`. */
export function edgeRing(
  mesh: Mesh, startEdge: number,
): { edges: number[]; faces: number[]; cyclic: boolean } {
  const t = mesh.topology();
  const start = t.edges[startEdge];
  if (!start) return { edges: [], faces: [], cyclic: false };

  const edges = [startEdge];
  const faces: number[] = [];
  const seenEdge = new Set([startEdge]);
  const seenFace = new Set<number>();
  let cyclic = false;

  for (let dir = 0; dir < Math.min(2, start.faces.length); dir++) {
    let face: number | undefined = start.faces[dir];
    let edge = startEdge;
    while (face !== undefined && !seenFace.has(face) && mesh.faces[face].length === 4) {
      seenFace.add(face);
      faces.push(face);
      const i = t.faceEdges[face].indexOf(edge);
      if (i < 0) break;
      const opp: number = t.faceEdges[face][(i + 2) % 4];
      if (opp === undefined || opp < 0) break;
      if (opp === startEdge) {
        cyclic = true;
        break;
      }
      if (seenEdge.has(opp)) break;
      seenEdge.add(opp);
      if (dir === 0) edges.push(opp);
      else edges.unshift(opp);
      const nextFace: number | undefined = t.edges[opp].faces.find((x) => x !== face);
      edge = opp;
      face = nextFace;
    }
  }
  return { edges, faces, cyclic };
}

/**
 * Insert `cuts` edge loops across the quad ring containing `startEdge`.
 * `offset` in (-1, 1) slides a single cut along the ring, as Ctrl+R does.
 */
export function loopCut(
  mesh: Mesh, startEdge: number, cuts = 1, offset = 0,
): { newVerts: number[] } {
  const n = Math.max(1, Math.floor(cuts));
  const ring = edgeRing(mesh, startEdge);
  if (ring.faces.length === 0) return { newVerts: [] };

  const t = mesh.topology();
  const ringSet = new Set(ring.edges);
  const params: number[] = [];
  for (let k = 0; k < n; k++) {
    let p = (k + 1) / (n + 1);
    if (n === 1) p = 0.5 + 0.5 * Math.max(-0.999, Math.min(0.999, offset));
    params.push(p);
  }

  const edgeVerts = new Map<number, number[]>();
  const newVerts: number[] = [];
  for (const ei of ring.edges) {
    const e = t.edges[ei];
    const pa = mesh.positions[e.a];
    const pb = mesh.positions[e.b];
    const list: number[] = [];
    for (const p of params) {
      const idx = mesh.positions.length;
      mesh.positions.push(pa.lerp(pb, p));
      list.push(idx);
      newVerts.push(idx);
    }
    edgeVerts.set(ei, list);
  }

  const cornerVerts = (face: number, corner: number): number[] => {
    const ei = t.faceEdges[face][corner];
    const loop = mesh.faces[face];
    const list = edgeVerts.get(ei)!;
    const forward = loop[corner] === t.edges[ei].a;
    return forward ? list : list.slice().reverse();
  };

  const replaced: { face: number; loops: number[][] }[] = [];
  for (const f of ring.faces) {
    const fe = t.faceEdges[f];
    let i = -1;
    for (let k = 0; k < 4; k++) {
      if (ringSet.has(fe[k]) && ringSet.has(fe[(k + 2) % 4])) {
        i = k;
        break;
      }
    }
    if (i < 0) continue;
    const loop = mesh.faces[f];
    const A = [loop[i], ...cornerVerts(f, i), loop[(i + 1) % 4]];
    const C = [loop[(i + 2) % 4], ...cornerVerts(f, (i + 2) % 4), loop[(i + 3) % 4]];
    const loops: number[][] = [];
    for (let k = 0; k <= n; k++) {
      loops.push([A[k], A[k + 1], C[n - k], C[n + 1 - k]]);
    }
    replaced.push({ face: f, loops });
  }

  for (const r of replaced) {
    mesh.faces[r.face] = r.loops[0];
    for (let k = 1; k < r.loops.length; k++) pushFace(mesh, r.loops[k], r.face);
  }
  mesh.markDirty();
  return { newVerts };
}

/** Linear (non-smoothing) quad subdivision of the given faces. */
export function subdivideFaces(mesh: Mesh, faces: Iterable<number>): { newVerts: number[] } {
  const faceSet = new Set(faces);
  if (faceSet.size === 0) return { newVerts: [] };
  const t = mesh.topology();
  const newVerts: number[] = [];

  const edgePoint = new Map<number, number>();
  const touchedEdges = new Set<number>();
  for (const f of faceSet) for (const ei of t.faceEdges[f]) if (ei >= 0) touchedEdges.add(ei);
  for (const ei of touchedEdges) {
    const e = t.edges[ei];
    const idx = mesh.positions.length;
    mesh.positions.push(mesh.positions[e.a].lerp(mesh.positions[e.b], 0.5));
    edgePoint.set(ei, idx);
    newVerts.push(idx);
  }

  // Faces outside the selection that share a cut edge gain the midpoint as an
  // extra corner, so the mesh stays watertight (an n-gon "trifan" join).
  const outside = new Map<number, number[]>();
  for (const ei of touchedEdges) {
    for (const f of t.edges[ei].faces) {
      if (faceSet.has(f)) continue;
      const arr = outside.get(f) ?? [];
      arr.push(ei);
      outside.set(f, arr);
    }
  }

  const additions: number[][] = [];
  for (const f of faceSet) {
    const loop = mesh.faces[f];
    const center = mesh.faceCenter(f);
    const ci = mesh.positions.length;
    mesh.positions.push(center);
    newVerts.push(ci);
    const quads: number[][] = [];
    for (let i = 0; i < loop.length; i++) {
      const prevE = t.faceEdges[f][(i - 1 + loop.length) % loop.length];
      const nextE = t.faceEdges[f][i];
      quads.push([loop[i], edgePoint.get(nextE)!, ci, edgePoint.get(prevE)!]);
    }
    mesh.faces[f] = quads[0];
    for (let i = 1; i < quads.length; i++) additions.push(quads[i]);
    for (let i = 1; i < quads.length; i++) {
      mesh.faceMaterial.push(mesh.faceMaterial[f] ?? 0);
      if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.isFaceSmooth(f));
    }
  }
  for (const q of additions) mesh.faces.push(q);

  for (const [f, eis] of outside) {
    const loop = mesh.faces[f];
    const out: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      out.push(loop[i]);
      const ei = t.faceEdges[f][i];
      if (eis.includes(ei)) out.push(edgePoint.get(ei)!);
    }
    mesh.faces[f] = out;
  }

  mesh.markDirty();
  return { newVerts };
}

/** Catmull-Clark subdivision of the whole mesh (used by the Subsurf modifier). */
export function catmullClark(mesh: Mesh, levels = 1): Mesh {
  let cur = mesh;
  for (let l = 0; l < Math.max(0, Math.floor(levels)); l++) cur = catmullClarkOnce(cur);
  return cur;
}

function catmullClarkOnce(mesh: Mesh): Mesh {
  const t = mesh.topology();
  const nv = mesh.positions.length;
  const positions: Vec3[] = [];
  const faces: number[][] = [];
  const faceMaterial: number[] = [];
  const faceSmooth: boolean[] | null = mesh.faceSmooth ? [] : null;

  // Face points.
  const facePoint: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    facePoint.push(positions.length);
    positions.push(t.faceCenters[f].clone());
  }

  // Edge points.
  const edgePoint: number[] = [];
  for (let e = 0; e < t.edges.length; e++) {
    const rec = t.edges[e];
    const p = mesh.positions[rec.a].add(mesh.positions[rec.b]);
    if (rec.faces.length === 2) {
      const q = t.faceCenters[rec.faces[0]].add(t.faceCenters[rec.faces[1]]);
      positions.push(p.add(q).scale(0.25));
    } else {
      positions.push(p.scale(0.5));
    }
    edgePoint.push(positions.length - 1);
  }

  // Vertex points.
  const vertPoint: number[] = [];
  for (let v = 0; v < nv; v++) {
    const incidentF = t.vertFaces[v] ?? [];
    const incidentE = t.vertEdges[v] ?? [];
    const boundaryEdges = incidentE.filter((e) => t.edges[e].faces.length === 1);
    const P = mesh.positions[v];
    let np: Vec3;
    if (incidentF.length === 0) {
      np = P.clone();
    } else if (boundaryEdges.length >= 2) {
      // Cubic B-spline crease rule along the boundary.
      const m = new Vec3();
      let count = 0;
      for (const e of boundaryEdges) {
        const rec = t.edges[e];
        m.addInPlace(mesh.positions[rec.a === v ? rec.b : rec.a]);
        count++;
      }
      np = count > 0 ? P.scale(6).add(m).scale(1 / (6 + count)) : P.clone();
    } else {
      const n = incidentF.length;
      const F = new Vec3();
      for (const f of incidentF) F.addInPlace(t.faceCenters[f]);
      F.scaleInPlace(1 / n);
      const R = new Vec3();
      for (const e of incidentE) R.addInPlace(mesh.edgeCenter(e));
      R.scaleInPlace(1 / Math.max(1, incidentE.length));
      np = F.add(R.scale(2)).add(P.scale(n - 3)).scale(1 / n);
    }
    vertPoint.push(positions.length);
    positions.push(np);
  }

  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    for (let i = 0; i < loop.length; i++) {
      const prevE = t.faceEdges[f][(i - 1 + loop.length) % loop.length];
      const nextE = t.faceEdges[f][i];
      if (prevE < 0 || nextE < 0) continue;
      faces.push([vertPoint[loop[i]], edgePoint[nextE], facePoint[f], edgePoint[prevE]]);
      faceMaterial.push(mesh.faceMaterial[f] ?? 0);
      if (faceSmooth) faceSmooth.push(mesh.isFaceSmooth(f));
    }
  }

  const out = new Mesh(positions, faces, faceMaterial);
  out.shadeSmooth = mesh.shadeSmooth;
  out.faceSmooth = faceSmooth;
  out.removeLooseVertices();
  return out;
}

/** Weld vertices closer than `dist`. Returns how many were removed. */
export function mergeByDistance(mesh: Mesh, verts: Iterable<number> | null, dist = 0.0001): number {
  const candidates = verts ? new Set(verts) : new Set(mesh.positions.map((_, i) => i));
  const cell = Math.max(dist, 1e-9);
  const buckets = new Map<string, number[]>();
  const remap = new Array<number>(mesh.positions.length).fill(-1);
  const key = (p: Vec3) =>
    `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)},${Math.floor(p.z / cell)}`;

  for (const v of candidates) {
    const p = mesh.positions[v];
    let target = -1;
    const bx = Math.floor(p.x / cell);
    const by = Math.floor(p.y / cell);
    const bz = Math.floor(p.z / cell);
    outer: for (let dx = -1; dx <= 1 && target < 0; dx++) {
      for (let dy = -1; dy <= 1 && target < 0; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${bx + dx},${by + dy},${bz + dz}`);
          if (!list) continue;
          for (const o of list) {
            if (mesh.positions[o].distanceTo(p) <= dist) {
              target = o;
              break outer;
            }
          }
        }
      }
    }
    if (target >= 0) {
      remap[v] = target;
    } else {
      const k = key(p);
      const list = buckets.get(k) ?? [];
      list.push(v);
      buckets.set(k, list);
    }
  }

  let removed = 0;
  for (let i = 0; i < remap.length; i++) if (remap[i] >= 0) removed++;
  if (removed === 0) return 0;

  mesh.faces = mesh.faces.map((f) => f.map((v) => (remap[v] >= 0 ? remap[v] : v)));
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
  return removed;
}

/** Collapse the given vertices to a single point (Merge at Center). */
export function mergeVertices(mesh: Mesh, verts: Iterable<number>, at?: Vec3): number {
  const list = [...verts];
  if (list.length < 2) return 0;
  const center = at ?? list
    .reduce((acc, v) => acc.addInPlace(mesh.positions[v]), new Vec3())
    .scale(1 / list.length);
  const keep = list[0];
  mesh.positions[keep] = center;
  const remap = new Map<number, number>();
  for (const v of list) remap.set(v, keep);
  mesh.faces = mesh.faces.map((f) => f.map((v) => remap.get(v) ?? v));
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
  return list.length - 1;
}

export function deleteFaces(mesh: Mesh, faces: Iterable<number>, keepVerts = false): void {
  const drop = new Set(faces);
  const kept: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    if (drop.has(f)) continue;
    kept.push(mesh.faces[f]);
    mats.push(mesh.faceMaterial[f] ?? 0);
    smooth.push(mesh.isFaceSmooth(f));
  }
  mesh.faces = kept;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  mesh.markDirty();
  if (!keepVerts) mesh.removeLooseVertices();
}

export function deleteVertices(mesh: Mesh, verts: Iterable<number>): void {
  const drop = new Set(verts);
  const doomed: number[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    if (mesh.faces[f].some((v) => drop.has(v))) doomed.push(f);
  }
  deleteFaces(mesh, doomed, true);
  const map = new Array<number>(mesh.positions.length).fill(-1);
  const positions: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i++) {
    if (drop.has(i)) continue;
    map[i] = positions.length;
    positions.push(mesh.positions[i]);
  }
  mesh.positions = positions;
  mesh.faces = mesh.faces.map((f) => f.map((v) => map[v]).filter((v) => v >= 0));
  mesh.cleanDegenerate();
  mesh.removeLooseVertices();
}

export function deleteEdges(mesh: Mesh, edges: Iterable<number>): void {
  const t = mesh.topology();
  const doomed = new Set<number>();
  for (const ei of edges) for (const f of t.edges[ei]?.faces ?? []) doomed.add(f);
  deleteFaces(mesh, doomed);
}

/** Merge a connected face region into a single n-gon (Dissolve Faces). */
export function dissolveFaces(mesh: Mesh, faces: Iterable<number>): number[] {
  const faceSet = new Set(faces);
  if (faceSet.size < 2) return [...faceSet];
  const boundary = regionBoundary(mesh, faceSet);
  if (boundary.length < 3) return [...faceSet];

  // Chain the directed boundary edges into loops.
  const nextOf = new Map<number, number[]>();
  for (const be of boundary) {
    const arr = nextOf.get(be.a) ?? [];
    arr.push(be.b);
    nextOf.set(be.a, arr);
  }
  const created: number[] = [];
  const used = new Set<string>();
  const template = [...faceSet][0];
  for (const be of boundary) {
    if (used.has(`${be.a}>${be.b}`)) continue;
    const loop: number[] = [be.a];
    let cur = be.b;
    let guard = 0;
    used.add(`${be.a}>${be.b}`);
    while (cur !== be.a && guard++ < boundary.length + 2) {
      loop.push(cur);
      const outs = nextOf.get(cur);
      if (!outs || outs.length === 0) break;
      const nxt = outs.find((n) => !used.has(`${cur}>${n}`));
      if (nxt === undefined) break;
      used.add(`${cur}>${nxt}`);
      cur = nxt;
    }
    if (cur === be.a && loop.length >= 3) created.push(pushFace(mesh, loop, template));
  }
  if (created.length === 0) return [...faceSet];
  deleteFaces(mesh, faceSet);
  mesh.markDirty();
  return created;
}

/** Build one n-gon (or a quad from two edges' worth of verts) from a vertex set. */
export function makeFace(mesh: Mesh, verts: number[]): number | null {
  if (verts.length < 3) return null;
  const t = mesh.topology();
  // Order the vertices by walking existing edges when possible, else by angle.
  const set = new Set(verts);
  const ordered: number[] = [];
  const visited = new Set<number>();
  let cur = verts[0];
  while (cur !== undefined && !visited.has(cur)) {
    visited.add(cur);
    ordered.push(cur);
    let nxt: number | undefined;
    for (const ei of t.vertEdges[cur] ?? []) {
      const e = t.edges[ei];
      const other = e.a === cur ? e.b : e.a;
      if (set.has(other) && !visited.has(other)) {
        nxt = other;
        break;
      }
    }
    cur = nxt as number;
  }
  if (ordered.length !== verts.length) {
    const center = verts
      .reduce((acc, v) => acc.addInPlace(mesh.positions[v]), new Vec3())
      .scale(1 / verts.length);
    let normal = new Vec3();
    for (let i = 0; i < verts.length; i++) {
      const p = mesh.positions[verts[i]].sub(center);
      const q = mesh.positions[verts[(i + 1) % verts.length]].sub(center);
      normal.addInPlace(p.cross(q));
    }
    if (normal.lengthSq() < 1e-16) normal = new Vec3(0, 0, 1);
    const u = normal.normalized().perpendicular();
    const v = normal.normalized().cross(u);
    ordered.length = 0;
    ordered.push(
      ...[...verts].sort((x, y) => {
        const px = mesh.positions[x].sub(center);
        const py = mesh.positions[y].sub(center);
        return Math.atan2(px.dot(v), px.dot(u)) - Math.atan2(py.dot(v), py.dot(u));
      }),
    );
  }
  const idx = mesh.faces.length;
  mesh.faces.push(ordered);
  mesh.faceMaterial.push(0);
  if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.shadeSmooth);
  mesh.markDirty();
  return idx;
}

export function flipNormals(mesh: Mesh, faces?: Iterable<number>): void {
  const set = faces ? new Set(faces) : null;
  for (let f = 0; f < mesh.faces.length; f++) {
    if (!set || set.has(f)) mesh.faces[f] = mesh.faces[f].slice().reverse();
  }
  mesh.markDirty();
}

/** Make winding consistent across shells, then orient each shell outward. */
export function recalculateNormals(mesh: Mesh, inside = false): void {
  const t = mesh.topology();
  const visited = new Uint8Array(mesh.faces.length);
  const shells: number[][] = [];

  for (let seed = 0; seed < mesh.faces.length; seed++) {
    if (visited[seed]) continue;
    const shell: number[] = [];
    const stack = [seed];
    visited[seed] = 1;
    while (stack.length) {
      const f = stack.pop()!;
      shell.push(f);
      const loop = mesh.faces[f];
      for (let i = 0; i < loop.length; i++) {
        const ei = t.faceEdges[f][i];
        if (ei < 0) continue;
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        for (const nf of t.edges[ei].faces) {
          if (nf === f || visited[nf]) continue;
          const nloop = mesh.faces[nf];
          const j = nloop.indexOf(a);
          // Consistent neighbours traverse the shared edge in the opposite order.
          const sameDir = j >= 0 && nloop[(j + 1) % nloop.length] === b;
          if (sameDir) mesh.faces[nf] = nloop.slice().reverse();
          visited[nf] = 1;
          stack.push(nf);
        }
      }
    }
    shells.push(shell);
  }

  for (const shell of shells) {
    let vol = 0;
    for (const f of shell) {
      const loop = mesh.faces[f];
      for (let i = 1; i + 1 < loop.length; i++) {
        const a = mesh.positions[loop[0]];
        const b = mesh.positions[loop[i]];
        const c = mesh.positions[loop[i + 1]];
        vol += a.dot(b.cross(c)) / 6;
      }
    }
    const wantFlip = inside ? vol > 0 : vol < 0;
    if (wantFlip) for (const f of shell) mesh.faces[f] = mesh.faces[f].slice().reverse();
  }
  mesh.markDirty();
}

/** Laplacian smoothing of the given vertices (or all of them). */
export function smoothVertices(mesh: Mesh, verts: Iterable<number> | null, factor = 0.5, iterations = 1): void {
  const t0 = mesh.topology();
  const set = verts ? new Set(verts) : new Set(mesh.positions.map((_, i) => i));
  for (let it = 0; it < iterations; it++) {
    const t = it === 0 ? t0 : mesh.topology();
    const next = mesh.positions.map((p) => p.clone());
    for (const v of set) {
      const nb = t.vertEdges[v] ?? [];
      if (nb.length === 0) continue;
      const avg = new Vec3();
      for (const ei of nb) {
        const e = t.edges[ei];
        avg.addInPlace(mesh.positions[e.a === v ? e.b : e.a]);
      }
      avg.scaleInPlace(1 / nb.length);
      next[v] = mesh.positions[v].lerp(avg, factor);
    }
    mesh.positions = next;
    mesh.markDirty();
  }
}

export function triangulateFaces(mesh: Mesh, faces?: Iterable<number>): void {
  const set = faces ? new Set(faces) : null;
  const out: number[][] = [];
  const mats: number[] = [];
  const smooth: boolean[] = [];
  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    if ((set && !set.has(f)) || loop.length <= 3) {
      out.push(loop);
      mats.push(mesh.faceMaterial[f] ?? 0);
      smooth.push(mesh.isFaceSmooth(f));
      continue;
    }
    for (let i = 1; i + 1 < loop.length; i++) {
      out.push([loop[0], loop[i], loop[i + 1]]);
      mats.push(mesh.faceMaterial[f] ?? 0);
      smooth.push(mesh.isFaceSmooth(f));
    }
  }
  mesh.faces = out;
  mesh.faceMaterial = mats;
  if (mesh.faceSmooth) mesh.faceSmooth = smooth;
  mesh.markDirty();
}

/** Duplicate a face region into disconnected geometry. Returns the new faces and verts. */
export function duplicateFaces(
  mesh: Mesh, faces: Iterable<number>,
): { faces: number[]; verts: Set<number> } {
  const faceSet = [...new Set(faces)];
  const map = new Map<number, number>();
  const verts = new Set<number>();
  for (const f of faceSet) {
    for (const v of mesh.faces[f]) {
      if (!map.has(v)) {
        map.set(v, mesh.positions.length);
        verts.add(mesh.positions.length);
        mesh.positions.push(mesh.positions[v].clone());
      }
    }
  }
  const newFaces: number[] = [];
  for (const f of faceSet) newFaces.push(pushFace(mesh, mesh.faces[f].map((v) => map.get(v)!), f));
  mesh.markDirty();
  return { faces: newFaces, verts };
}

/** Move a set of vertices by a delta. */
export function translateVerts(mesh: Mesh, verts: Iterable<number>, delta: Vec3): void {
  for (const v of verts) mesh.positions[v] = mesh.positions[v].add(delta);
  mesh.markDirty();
}
