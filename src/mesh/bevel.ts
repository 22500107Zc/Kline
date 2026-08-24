import { Vec3, clamp } from '../core/math';
import { Mesh } from './Mesh';

/**
 * Bevel.
 *
 * The mesh kernel is an n-gon soup, so bevel is expressed purely in terms of
 * the *fan* of faces around each affected vertex. Beveled edges cut that fan
 * into sectors; every sector collapses to one new vertex, which is what keeps
 * unbeveled edges crack-free (both of their faces keep sharing a corner).
 *
 *   fan around v:   S0 -e0- S1 -e1- S2 -e2- (back to S0)
 *
 * Each cut edge then owns a profile chain running across it from one sector to
 * the next, and those chains are shared: the edge's own quad strip, the strip
 * of the next beveled edge along, and the corner cap at the vertex all index
 * the same vertices, so the result is watertight by construction rather than
 * by a merge-by-distance pass afterwards.
 */

export interface BevelResult {
  /** Indices of the faces the operator appended. */
  newFaces: number[];
  /** Every vertex that now forms part of the beveled surface. */
  newVerts: Set<number>;
}

export interface VertexFan {
  /** Faces around the vertex in rotational order. */
  faces: number[];
  /**
   * Edge crossings. For a cyclic fan `edges[i]` is the edge between
   * `faces[i-1]` and `faces[i]` (so `edges[0]` closes the loop). For an open
   * fan there is one extra entry and the first and last are boundary edges.
   */
  edges: number[];
  cyclic: boolean;
}

/**
 * Order the faces around a vertex. Returns null when the vertex is
 * non-manifold, which callers treat as "leave this corner alone".
 */
export function vertexFan(mesh: Mesh, v: number): VertexFan | null {
  const t = mesh.topology();
  const incidentFaces = t.vertFaces[v];
  const incidentEdges = t.vertEdges[v];
  if (!incidentFaces || incidentFaces.length === 0 || !incidentEdges) return null;

  // The two edges each face uses at this vertex.
  const pair = new Map<number, [number, number]>();
  for (const f of incidentFaces) {
    const loop = mesh.faces[f];
    const i = loop.indexOf(v);
    if (i < 0 || loop.indexOf(v, i + 1) >= 0) return null;
    const L = loop.length;
    const eIn = t.faceEdges[f][(i - 1 + L) % L];
    const eOut = t.faceEdges[f][i];
    if (eIn < 0 || eOut < 0 || eIn === eOut) return null;
    pair.set(f, [eIn, eOut]);
  }
  for (const ei of incidentEdges) if (t.edges[ei].faces.length > 2) return null;

  const across = (ei: number, f: number): number => {
    const fs = t.edges[ei].faces;
    if (fs.length !== 2) return -1;
    return fs[0] === f ? fs[1] : fs[0];
  };
  const exit = (f: number, ei: number): number => {
    const p = pair.get(f);
    if (!p) return -1;
    return p[0] === ei ? p[1] : p[1] === ei ? p[0] : -1;
  };

  const faces: number[] = [];
  const edges: number[] = [];
  const seen = new Set<number>();

  const boundary = incidentEdges.find((ei) => t.edges[ei].faces.length === 1);
  if (boundary !== undefined) {
    let e = boundary;
    let f = t.edges[e].faces[0];
    edges.push(e);
    for (;;) {
      if (f < 0 || seen.has(f)) return null;
      seen.add(f);
      faces.push(f);
      const ex = exit(f, e);
      if (ex < 0) return null;
      edges.push(ex);
      if (t.edges[ex].faces.length === 1) break;
      const nf = across(ex, f);
      if (nf < 0) return null;
      e = ex;
      f = nf;
    }
    if (faces.length !== incidentFaces.length) return null;
    return { faces, edges, cyclic: false };
  }

  let f = incidentFaces[0];
  const start = pair.get(f)![0];
  let e = start;
  for (;;) {
    if (seen.has(f)) return null;
    seen.add(f);
    faces.push(f);
    edges.push(e);
    const ex = exit(f, e);
    if (ex < 0) return null;
    if (ex === start) break;
    const nf = across(ex, f);
    if (nf < 0) return null;
    e = ex;
    f = nf;
  }
  if (faces.length !== incidentFaces.length) return null;
  return { faces, edges, cyclic: true };
}

function otherEnd(mesh: Mesh, ei: number, v: number): number {
  const e = mesh.topology().edges[ei];
  return e.a === v ? e.b : e.a;
}

/**
 * Slide the corner `v` of face `f` away from beveled edge `eBev`, along f's
 * other edge at that corner, far enough that the perpendicular distance to the
 * beveled edge is `width`.
 */
function slidePoint(
  mesh: Mesh, v: number, eBev: number, eOther: number, width: number, doClamp: boolean,
): Vec3 {
  const p = mesh.positions[v];
  const uB = mesh.positions[otherEnd(mesh, eBev, v)].sub(p);
  const uO = mesh.positions[otherEnd(mesh, eOther, v)].sub(p);
  const lenO = uO.length();
  if (lenO < 1e-12) return p.clone();
  const dirO = uO.scale(1 / lenO);
  const lenB = uB.length();
  const dirB = lenB > 1e-12 ? uB.scale(1 / lenB) : dirO;
  // sin of the corner angle: how much of a slide along dirO buys distance
  // from the beveled edge.
  const sinT = Math.max(dirB.cross(dirO).length(), 0.05);
  let t = width / sinT;
  if (doClamp) t = Math.min(t, lenO * 0.49);
  return p.add(dirO.scale(t));
}

/**
 * Both of the face's edges at this corner are beveled, so the new point has to
 * stand off from each of them by its own width.
 *
 * In the basis of the two edge directions the answer is exact. Writing the
 * offset as `x·da + y·db`, the distance from the ray along `da` is `y·sinθ`
 * and from the ray along `db` is `x·sinθ`, so `y = w1/sinθ` and `x = w2/sinθ`.
 * With equal widths that collapses to the familiar `w / sin(θ/2)` along the
 * bisector, but it stays correct when the two edges carry different weights.
 */
function bisectorPoint(
  mesh: Mesh, f: number, v: number, e1: number, e2: number, w1: number, w2: number, doClamp: boolean,
): Vec3 {
  const p = mesh.positions[v];
  const a = mesh.positions[otherEnd(mesh, e1, v)].sub(p);
  const b = mesh.positions[otherEnd(mesh, e2, v)].sub(p);
  const la = a.length();
  const lb = b.length();
  if (la < 1e-12 || lb < 1e-12) return p.clone();
  const da = a.scale(1 / la);
  const db = b.scale(1 / lb);
  const sinT = da.cross(db).length();
  if (sinT < 1e-6) {
    // Straight-through corner: no wedge to bisect, so step perpendicular into
    // the face by the average width.
    const inward = mesh.faceCenter(f).sub(p);
    const flat = inward.sub(da.scale(inward.dot(da)));
    if (flat.lengthSq() < 1e-16) return p.clone();
    let t = (w1 + w2) * 0.5;
    if (doClamp) t = Math.min(t, Math.min(la, lb) * 0.49);
    return p.add(flat.normalized().scale(t));
  }
  let x = w2 / sinT;
  let y = w1 / sinT;
  if (doClamp) {
    const s = Math.min(1, la * 0.49 / Math.max(x, 1e-12), lb * 0.49 / Math.max(y, 1e-12));
    x *= s;
    y *= s;
  }
  return p.add(da.scale(x)).add(db.scale(y));
}

/**
 * The largest fraction of the requested widths that keeps every bevel inside
 * the geometry it is cutting into.
 *
 * Clamping each corner on its own gives a bevel that is wide in the roomy
 * places and pinched in the tight ones. Scaling every width by one factor
 * instead keeps the bevel even, which is what the eye expects and what makes
 * the width readout mean something.
 */
function overlapScale(mesh: Mesh, beveled: Set<number>, widthOf: (ei: number) => number): number {
  const t = mesh.topology();
  let scale = 1;
  for (const ei of beveled) {
    const e = t.edges[ei];
    const w = widthOf(ei);
    if (w <= 1e-12) continue;
    for (const v of [e.a, e.b]) {
      const p = mesh.positions[v];
      const dirB = mesh.positions[otherEnd(mesh, ei, v)].sub(p).normalized();
      // Only the edges this bevel actually slides along matter: the other edge
      // of each of its two faces at this corner.
      for (const f of e.faces) {
        const loop = mesh.faces[f];
        const i = loop.indexOf(v);
        if (i < 0) continue;
        const L = loop.length;
        const eIn = t.faceEdges[f][(i - 1 + L) % L];
        const eOut = t.faceEdges[f][i];
        const eO = eIn === ei ? eOut : eIn;
        if (eO < 0 || eO === ei) continue;
        const q = mesh.positions[otherEnd(mesh, eO, v)];
        const lenO = q.distanceTo(p);
        if (lenO < 1e-12) continue;
        const dirO = q.sub(p).scale(1 / lenO);
        // The same floor `slidePoint` uses, so this predicts the slide it will
        // actually make rather than a stricter hypothetical one.
        const sinT = Math.max(dirB.cross(dirO).length(), 0.05);
        const allowed = lenO * 0.49 * sinT;
        if (allowed / w < scale) scale = Math.max(0, allowed / w);
      }
    }
  }
  return scale;
}

/**
 * Points along the bevel profile running from `p0` to `p1` around `origin`.
 * `profile` 0.5 is a circular arc, 0 a flat chamfer, 1 a sharp crease.
 */
export function profilePoints(
  origin: Vec3, p0: Vec3, p1: Vec3, segments: number, profile: number,
): Vec3[] {
  const out: Vec3[] = [p0.clone()];
  const a = p0.sub(origin);
  const b = p1.sub(origin);
  const la = a.length();
  const lb = b.length();
  const bend = profile / 0.5;
  let ang = 0;
  let na = a;
  let nb = b;
  if (la > 1e-9 && lb > 1e-9) {
    na = a.scale(1 / la);
    nb = b.scale(1 / lb);
    ang = Math.acos(clamp(na.dot(nb), -1, 1));
  }
  const sinAng = Math.sin(ang);
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const chord = a.lerp(b, t);
    let v = chord;
    if (ang > 1e-4 && sinAng > 1e-6) {
      const dir = na.scale(Math.sin((1 - t) * ang) / sinAng).add(nb.scale(Math.sin(t * ang) / sinAng));
      const arc = dir.scale(la + (lb - la) * t);
      v = chord.add(arc.sub(chord).scale(bend));
    }
    out.push(origin.add(v));
  }
  out.push(p1.clone());
  return out;
}

/**
 * The point that sits `width` inside every face meeting at `v`.
 *
 * This is where a bevel's profile is actually centred. Sweeping the arc about
 * the original vertex instead — which is the obvious thing to do, and wrong —
 * bows it inward: on a cube it puts the midpoint of each rounded edge well
 * under the surface a real fillet would have, and the corners come out visibly
 * sucked in. Offsetting each incident face plane inward by its own width and
 * intersecting them gives the centre of the sphere the corner is a patch of,
 * which is what the profile should curve around.
 *
 * Three faces determine the point exactly; more are solved in the least
 * squares sense, and a degenerate corner falls back to the vertex itself.
 */
function offsetCentre(mesh: Mesh, v: number, widthOfFace: (f: number) => number): Vec3 {
  const t = mesh.topology();
  const faces = t.vertFaces[v] ?? [];
  const origin = mesh.positions[v];
  if (faces.length < 3) return origin;

  // Normal equations for "signed distance to each offset plane is zero".
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rhs = [0, 0, 0];
  for (const f of faces) {
    const n = t.faceNormals[f];
    if (!n || n.lengthSq() < 1e-16) continue;
    // Normals point out of the solid, so moving inward is the negative side.
    const d = n.dot(mesh.faceCenter(f)) - widthOfFace(f);
    const c = [n.x, n.y, n.z];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) a[i * 3 + j] += c[i] * c[j];
      rhs[i] += c[i] * d;
    }
  }

  const det =
    a[0] * (a[4] * a[8] - a[5] * a[7]) -
    a[1] * (a[3] * a[8] - a[5] * a[6]) +
    a[2] * (a[3] * a[7] - a[4] * a[6]);
  // A flat or nearly flat fan gives a singular system: the faces do not pin a
  // point down, so there is nothing better than the vertex.
  if (Math.abs(det) < 1e-9) return origin;
  const inv = 1 / det;
  const x =
    inv * (rhs[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (rhs[1] * a[8] - a[5] * rhs[2]) + a[2] * (rhs[1] * a[7] - a[4] * rhs[2]));
  const y =
    inv * (a[0] * (rhs[1] * a[8] - a[5] * rhs[2]) - rhs[0] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * rhs[2] - rhs[1] * a[6]));
  const z =
    inv * (a[0] * (a[4] * rhs[2] - rhs[1] * a[7]) - a[1] * (a[3] * rhs[2] - rhs[1] * a[6]) + rhs[0] * (a[3] * a[7] - a[4] * a[6]));
  const c = new Vec3(x, y, z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return origin;
  // A wild answer means the corner was close to singular after all.
  let span = 0;
  for (const f of faces) span = Math.max(span, widthOfFace(f));
  if (c.distanceTo(origin) > span * 8 + 1e-9) return origin;
  return c;
}

interface CornerPlan {
  /** face -> (one of its two edges at this vertex) -> the vertex to use there. */
  faceEdgeVert: Map<number, Map<number, number>>;
  /** Beveled edge -> the profile chain crossing it, running from `fromFace`'s side. */
  chains: Map<number, { verts: number[]; fromFace: number }>;
  /** Ring bounding the corner cap, or null when the profiles already close up. */
  cap: number[] | null;
  /** Centre the cap's own patch curves around. */
  centre: Vec3;
}

function frozenPlan(mesh: Mesh, v: number, beveled: Set<number>, segments: number): CornerPlan {
  const t = mesh.topology();
  const faceEdgeVert = new Map<number, Map<number, number>>();
  for (const f of t.vertFaces[v] ?? []) {
    const loop = mesh.faces[f];
    const i = loop.indexOf(v);
    if (i < 0) continue;
    const L = loop.length;
    const per = new Map<number, number>();
    per.set(t.faceEdges[f][(i - 1 + L) % L], v);
    per.set(t.faceEdges[f][i], v);
    faceEdgeVert.set(f, per);
  }
  const chains = new Map<number, { verts: number[]; fromFace: number }>();
  for (const ei of t.vertEdges[v] ?? []) {
    if (beveled.has(ei)) chains.set(ei, { verts: new Array(segments + 1).fill(v), fromFace: -1 });
  }
  return { faceEdgeVert, chains, cap: null, centre: mesh.positions[v] };
}

/**
 * Work out what happens to one vertex.
 *
 * Every *crossing* (an edge of the fan) carries a vertex per side. Unbeveled
 * crossings share one, which is what stops the surface tearing there; beveled
 * crossings carry two, and the profile runs between them. Each sector then
 * places its own points: a single face between two beveled edges bevels along
 * its bisector, a longer run slides its two end corners out and leaves the
 * crossings in the middle sitting on the original vertex, so the bevel tapers
 * away instead of dragging unrelated geometry with it.
 */
function planCorner(
  mesh: Mesh, v: number, beveled: Set<number>, widthOf: (ei: number) => number, segments: number,
  profile: number, doClamp: boolean, addVert: (p: Vec3) => number,
): CornerPlan {
  const t = mesh.topology();
  const fan = vertexFan(mesh, v);
  if (!fan) return frozenPlan(mesh, v, beveled, segments);

  const nc = fan.edges.length;
  const m = fan.faces.length;
  const cuts: number[] = [];
  for (let i = 0; i < nc; i++) if (beveled.has(fan.edges[i])) cuts.push(i);
  if (cuts.length === 0) return frozenPlan(mesh, v, beveled, segments);

  const origin = mesh.positions[v];
  const nextSide = new Array<number>(nc).fill(v);
  const prevSide = new Array<number>(nc).fill(v);

  const otherEdgeOf = (f: number, ei: number): number => {
    const loop = mesh.faces[f];
    const i = loop.indexOf(v);
    const L = loop.length;
    const a = t.faceEdges[f][(i - 1 + L) % L];
    return a === ei ? t.faceEdges[f][i] : a;
  };

  // Sector spans, as [firstCrossing, faceCount] in fan index space.
  const spans: { start: number; count: number }[] = [];
  if (fan.cyclic) {
    for (let i = 0; i < cuts.length; i++) {
      const start = cuts[i];
      const next = cuts[(i + 1) % cuts.length];
      const count = cuts.length === 1 ? m : (next - start + m) % m;
      spans.push({ start, count });
    }
  } else {
    const bounds = [0, ...cuts, nc - 1];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const count = bounds[i + 1] - bounds[i];
      if (count > 0) spans.push({ start: bounds[i], count });
    }
  }

  for (const span of spans) {
    const ci = (j: number): number => (fan.cyclic ? (span.start + j) % nc : span.start + j);
    const fi = (j: number): number => fan.faces[fan.cyclic ? (span.start + j) % m : span.start + j];
    const ms = span.count;
    const e0 = fan.edges[ci(0)];
    const eN = fan.edges[ci(ms)];
    const bev0 = beveled.has(e0);
    const bevN = beveled.has(eN);

    if (ms === 1) {
      const f = fi(0);
      let p: Vec3;
      if (bev0 && bevN) p = bisectorPoint(mesh, f, v, e0, eN, widthOf(e0), widthOf(eN), doClamp);
      else if (bev0) p = slidePoint(mesh, v, e0, eN, widthOf(e0), doClamp);
      else if (bevN) p = slidePoint(mesh, v, eN, e0, widthOf(eN), doClamp);
      else p = origin.clone();
      const q = bev0 || bevN ? addVert(p) : v;
      nextSide[ci(0)] = q;
      prevSide[ci(1)] = q;
      continue;
    }

    const pStart = bev0 ? slidePoint(mesh, v, e0, otherEdgeOf(fi(0), e0), widthOf(e0), doClamp) : origin;
    const pEnd = bevN ? slidePoint(mesh, v, eN, otherEdgeOf(fi(ms - 1), eN), widthOf(eN), doClamp) : origin;

    if (ms === 2) {
      // Both ends land on the same interior crossing; split the difference.
      let p: Vec3;
      if (bev0 && bevN) p = pStart.add(pEnd).scale(0.5);
      else if (bev0) p = pStart;
      else p = pEnd;
      const q = bev0 || bevN ? addVert(p) : v;
      nextSide[ci(0)] = q;
      prevSide[ci(1)] = q;
      nextSide[ci(1)] = q;
      prevSide[ci(2)] = q;
      continue;
    }

    const qs = bev0 ? addVert(pStart) : v;
    const qe = bevN ? addVert(pEnd) : v;
    nextSide[ci(0)] = qs;
    prevSide[ci(1)] = qs;
    nextSide[ci(1)] = qs;
    prevSide[ci(ms)] = qe;
    prevSide[ci(ms - 1)] = qe;
    nextSide[ci(ms - 1)] = qe;
  }

  // Profile chains. Two crossings that span the same pair of corner vertices
  // with the same arc (a bevel running straight through the vertex) share one
  // chain, otherwise the two strips would meet at coincident but unwelded
  // vertices.
  // Where the profile arcs are centred. Falls back to the vertex when the fan
  // does not pin a point down, which is what the old code always did.
  const widthOfFace = (f: number): number => {
    const loop = mesh.faces[f];
    const i = loop.indexOf(v);
    if (i < 0) return 0;
    const L = loop.length;
    let w = 0;
    for (const ei of [t.faceEdges[f][(i - 1 + L) % L], t.faceEdges[f][i]]) {
      if (ei >= 0 && beveled.has(ei)) w = Math.max(w, widthOf(ei));
    }
    return w;
  };
  const centre = offsetCentre(mesh, v, widthOfFace);

  const chains = new Map<number, { verts: number[]; fromFace: number }>();
  const built: { a: number; b: number; verts: number[] }[] = [];
  for (const i of cuts) {
    const from = fan.cyclic ? fan.faces[(i - 1 + m) % m] : fan.faces[i - 1];
    const v0 = prevSide[i];
    const v1 = nextSide[i];
    const pts = profilePoints(centre, mesh.positions[v0], mesh.positions[v1], segments, profile);
    let verts: number[] | null = null;
    for (const prior of built) {
      const same = prior.a === v0 && prior.b === v1;
      const flipped = prior.a === v1 && prior.b === v0;
      if (!same && !flipped) continue;
      const seq = same ? prior.verts : prior.verts.slice().reverse();
      let matches = true;
      for (let k = 0; k < seq.length; k++) {
        if (!mesh.positions[seq[k]].equals(pts[k], 1e-7)) { matches = false; break; }
      }
      if (matches) { verts = seq; break; }
    }
    if (!verts) {
      verts = [v0];
      for (let k = 1; k < pts.length - 1; k++) verts.push(addVert(pts[k]));
      verts.push(v1);
      built.push({ a: v0, b: v1, verts });
    }
    chains.set(fan.edges[i], { verts, fromFace: from ?? -1 });
  }

  // Cap ring: walk the crossings in order, taking both sides of each.
  const ring: number[] = [];
  for (let i = 0; i < nc; i++) {
    const chain = chains.get(fan.edges[i]);
    if (chain) {
      const seq = chain.verts[0] === prevSide[i] ? chain.verts : chain.verts.slice().reverse();
      for (const x of seq) ring.push(x);
    } else {
      ring.push(prevSide[i], nextSide[i]);
    }
  }
  const dedup: number[] = [];
  for (const x of ring) if (dedup[dedup.length - 1] !== x) dedup.push(x);
  while (dedup.length > 1 && dedup[0] === dedup[dedup.length - 1]) dedup.pop();
  let cap: number[] | null = null;
  if (dedup.length >= 3 && new Set(dedup).size === dedup.length) {
    // A ring with no area is two profiles lying on top of each other, which is
    // the bevel passing straight through rather than a hole to fill.
    const n = new Vec3();
    for (let i = 0; i < dedup.length; i++) {
      const cur = mesh.positions[dedup[i]];
      const nxt = mesh.positions[dedup[(i + 1) % dedup.length]];
      n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
      n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
      n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
    }
    let wMax = 0;
    for (const i of cuts) wMax = Math.max(wMax, widthOf(fan.edges[i]));
    if (n.length() * 0.5 > wMax * wMax * 1e-4) cap = dedup;
  }

  const faceEdgeVert = new Map<number, Map<number, number>>();
  const put = (f: number, ei: number, val: number): void => {
    if (f === undefined || f < 0) return;
    let per = faceEdgeVert.get(f);
    if (!per) { per = new Map(); faceEdgeVert.set(f, per); }
    per.set(ei, val);
  };
  for (let i = 0; i < nc; i++) {
    const after = fan.cyclic ? fan.faces[i % m] : fan.faces[i];
    const before = fan.cyclic ? fan.faces[(i - 1 + m) % m] : fan.faces[i - 1];
    put(after, fan.edges[i], nextSide[i]);
    put(before, fan.edges[i], prevSide[i]);
  }

  return { faceEdgeVert, chains, cap, centre };
}

function pushFace(mesh: Mesh, loop: number[], likeFace: number): number {
  const idx = mesh.faces.length;
  mesh.faces.push(loop);
  mesh.faceMaterial.push(mesh.faceMaterial[likeFace] ?? 0);
  if (mesh.faceSmooth) mesh.faceSmooth.push(mesh.isFaceSmooth(likeFace));
  return idx;
}

/**
 * Round or chamfer the given edges. `segments` 1 is a flat chamfer; higher
 * values follow a circular arc controlled by `profile`.
 */
export function bevelEdges(
  mesh: Mesh, edgeSel: Iterable<number>, width = 0.1, segments = 1,
  profile = 0.5, doClamp = true,
): BevelResult {
  const t = mesh.topology();
  const segs = Math.max(1, Math.round(segments));
  const beveled = new Set<number>();
  for (const ei of edgeSel) {
    const e = t.edges[ei];
    // A boundary edge has no second face to open a gap between, and an edge
    // weighted to zero is being asked to stay sharp — neither is beveled at
    // all, as opposed to beveled by nothing, which would leave a seam of
    // zero-area faces behind.
    if (e && e.faces.length === 2 && mesh.bevelWeight(e.a, e.b) > 1e-6) beveled.add(ei);
  }
  const empty: BevelResult = { newFaces: [], newVerts: new Set() };
  if (beveled.size === 0 || width <= 0) return empty;

  const cornerVerts = new Set<number>();
  const addVert = (p: Vec3): number => {
    const i = mesh.positions.length;
    mesh.positions.push(p);
    cornerVerts.add(i);
    return i;
  };

  const affected = new Set<number>();
  for (const ei of beveled) {
    affected.add(t.edges[ei].a);
    affected.add(t.edges[ei].b);
  }

  // Per-edge widths: the requested width scaled by the edge's own weight, then
  // scaled again by whatever keeps the whole bevel from folding over itself.
  const perEdge = new Map<number, number>();
  for (const ei of beveled) {
    const e = t.edges[ei];
    perEdge.set(ei, width * mesh.bevelWeight(e.a, e.b));
  }
  const raw = (ei: number): number => perEdge.get(ei) ?? width;
  const shrink = doClamp ? overlapScale(mesh, beveled, raw) : 1;
  const widthOf = (ei: number): number => raw(ei) * shrink;

  const plans = new Map<number, CornerPlan>();
  for (const v of affected) {
    plans.set(v, planCorner(mesh, v, beveled, widthOf, segs, profile, doClamp, addVert));
  }

  // Rewrite the original faces onto their new corner vertices. A corner can
  // widen into two when the bevel runs past it on only one side.
  const touchedFaces = new Set<number>();
  for (const v of affected) for (const f of t.vertFaces[v] ?? []) touchedFaces.add(f);
  for (const f of touchedFaces) {
    const loop = mesh.faces[f];
    const L = loop.length;
    const out: number[] = [];
    for (let i = 0; i < L; i++) {
      const v = loop[i];
      const per = plans.get(v)?.faceEdgeVert.get(f);
      const a = per?.get(t.faceEdges[f][(i - 1 + L) % L]);
      const b = per?.get(t.faceEdges[f][i]);
      if (a === undefined || b === undefined) out.push(v);
      else if (a === b) out.push(a);
      else out.push(a, b);
    }
    mesh.faces[f] = out;
  }

  const newFaces: number[] = [];

  // Quad strips along each beveled edge.
  for (const ei of beveled) {
    const e = t.edges[ei];
    const [f0, f1] = e.faces;
    const chainA = plans.get(e.a)?.chains.get(ei);
    const chainB = plans.get(e.b)?.chains.get(ei);
    if (!chainA || !chainB) continue;
    // Orient both chains so index 0 sits on f0's side.
    const A = chainA.fromFace === f0 || chainA.fromFace < 0 ? chainA.verts : chainA.verts.slice().reverse();
    const B = chainB.fromFace === f0 || chainB.fromFace < 0 ? chainB.verts : chainB.verts.slice().reverse();
    if (A.length !== B.length) continue;
    // f0's loop runs a->b or b->a; the strip must run the other way to stay
    // wound consistently with it.
    const loop0 = mesh.faces[f0];
    let forward = true;
    for (let i = 0; i < loop0.length; i++) {
      const cur = loop0[i];
      const nxt = loop0[(i + 1) % loop0.length];
      if (cur === A[0] && nxt === B[0]) { forward = true; break; }
      if (cur === B[0] && nxt === A[0]) { forward = false; break; }
    }
    for (let i = 0; i + 1 < A.length; i++) {
      const quad = forward
        ? [B[i], A[i], A[i + 1], B[i + 1]]
        : [A[i], B[i], B[i + 1], A[i + 1]];
      const dedup: number[] = [];
      for (const x of quad) if (!dedup.includes(x)) dedup.push(x);
      if (dedup.length >= 3) newFaces.push(pushFace(mesh, dedup, f1 ?? f0));
    }
  }

  // Corner caps.
  for (const v of affected) {
    const plan = plans.get(v);
    if (!plan || !plan.cap) continue;
    const ring = plan.cap;
    const n = new Vec3();
    for (let i = 0; i < ring.length; i++) {
      const cur = mesh.positions[ring[i]];
      const nxt = mesh.positions[ring[(i + 1) % ring.length]];
      n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
      n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
      n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
    }
    const outward = t.vertNormals[v] ?? new Vec3(0, 0, 1);
    const loop = n.dot(outward) < 0 ? ring.slice().reverse() : ring;
    const like = (t.vertFaces[v] ?? [])[0] ?? 0;
    if (segs === 1 || loop.length <= 3) {
      newFaces.push(pushFace(mesh, loop, like));
      continue;
    }
    // A flat n-gon across the ring cuts the corner off square. The profiles
    // bounding it are arcs about the same centre, so the corner is a patch of
    // that sphere: walk inward from the ring in concentric rounds, each one
    // pushed back out to the profiles' own radius, and close with a fan at the
    // pole. A single fan straight to the pole would make a cone instead.
    const origin = plan.centre;
    const dirs = loop.map((x) => mesh.positions[x].sub(origin));
    let radius = 0;
    const pole = new Vec3();
    for (const d of dirs) {
      const len = d.length();
      radius += len;
      if (len > 1e-12) pole.addInPlace(d.scale(1 / len));
    }
    radius /= loop.length;
    if (pole.lengthSq() < 1e-16 || radius < 1e-12) {
      newFaces.push(pushFace(mesh, loop, like));
      continue;
    }

    const axis = pole.normalized();
    const onSphere = (d: Vec3): number => {
      const len = d.length();
      return addVert(origin.add(len > 1e-12 ? d.scale(radius / len) : axis.scale(radius)));
    };
    let prev = loop;
    const rounds = Math.max(1, Math.round(segs / 2));
    for (let r = 1; r < rounds; r++) {
      const s = r / rounds;
      const ring2 = dirs.map((d) => onSphere(d.scale(1 - s).add(axis.scale(s * radius))));
      for (let i = 0; i < prev.length; i++) {
        const j = (i + 1) % prev.length;
        const quad: number[] = [];
        for (const x of [prev[i], prev[j], ring2[j], ring2[i]]) if (!quad.includes(x)) quad.push(x);
        if (quad.length >= 3) newFaces.push(pushFace(mesh, quad, like));
      }
      prev = ring2;
    }
    const hub = addVert(origin.add(axis.scale(radius)));
    for (let i = 0; i < prev.length; i++) {
      newFaces.push(pushFace(mesh, [prev[i], prev[(i + 1) % prev.length], hub], like));
    }
  }

  mesh.markDirty();
  const map = mesh.removeLooseVertices();
  const newVerts = new Set<number>();
  for (const x of cornerVerts) if (map[x] >= 0) newVerts.add(map[x]);
  return { newFaces, newVerts };
}

/**
 * Replace each selected vertex with a polygon, cutting its corner off at
 * `width` along every incident edge.
 */
export function bevelVertices(
  mesh: Mesh, verts: Iterable<number>, width = 0.1, doClamp = true,
): BevelResult {
  const t = mesh.topology();
  const fans = new Map<number, VertexFan>();
  for (const v of new Set(verts)) {
    const fan = vertexFan(mesh, v);
    if (fan) fans.set(v, fan);
  }
  const targets = [...fans.keys()];
  const empty: BevelResult = { newFaces: [], newVerts: new Set() };
  if (targets.length === 0 || width <= 0) return empty;

  const newVerts = new Set<number>();
  const newFaces: number[] = [];
  // vertex -> edge -> the point cut out of that edge
  const onEdge = new Map<number, Map<number, number>>();

  for (const v of targets) {
    const perEdge = new Map<number, number>();
    for (const ei of t.vertEdges[v] ?? []) {
      const p = mesh.positions[v];
      const q = mesh.positions[otherEnd(mesh, ei, v)];
      const len = q.distanceTo(p);
      if (len < 1e-12) continue;
      const d = doClamp ? Math.min(width, len * 0.49) : width;
      const idx = mesh.positions.length;
      mesh.positions.push(p.lerp(q, d / len));
      newVerts.add(idx);
      perEdge.set(ei, idx);
    }
    onEdge.set(v, perEdge);
  }

  // Every corner at a target vertex splits into the two edge points.
  const touched = new Set<number>();
  for (const v of targets) for (const f of t.vertFaces[v] ?? []) touched.add(f);
  for (const f of touched) {
    const loop = mesh.faces[f];
    const L = loop.length;
    const out: number[] = [];
    for (let i = 0; i < L; i++) {
      const v = loop[i];
      const perEdge = onEdge.get(v);
      if (!perEdge) {
        out.push(v);
        continue;
      }
      const eIn = t.faceEdges[f][(i - 1 + L) % L];
      const eOut = t.faceEdges[f][i];
      const a = perEdge.get(eIn);
      const b = perEdge.get(eOut);
      if (a === undefined || b === undefined) {
        out.push(v);
        continue;
      }
      out.push(a, b);
    }
    mesh.faces[f] = out;
  }

  for (const v of targets) {
    const fan = fans.get(v)!;
    const perEdge = onEdge.get(v)!;
    const ring: number[] = [];
    for (const ei of fan.edges) {
      const p = perEdge.get(ei);
      if (p !== undefined && ring[ring.length - 1] !== p) ring.push(p);
    }
    while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
    if (ring.length < 3) continue;
    const n = new Vec3();
    for (let i = 0; i < ring.length; i++) {
      const cur = mesh.positions[ring[i]];
      const nxt = mesh.positions[ring[(i + 1) % ring.length]];
      n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
      n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
      n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
    }
    const outward = t.vertNormals[v] ?? new Vec3(0, 0, 1);
    newFaces.push(pushFace(mesh, n.dot(outward) < 0 ? ring.slice().reverse() : ring, (t.vertFaces[v] ?? [])[0] ?? 0));
  }

  mesh.markDirty();
  const map = mesh.removeLooseVertices();
  const kept = new Set<number>();
  for (const x of newVerts) if (map[x] >= 0) kept.add(map[x]);
  return { newFaces, newVerts: kept };
}

/** Set the bevel weight on the given edges. */
export function markBevelWeight(mesh: Mesh, edges: Iterable<number>, weight: number): number {
  const t = mesh.topology();
  let n = 0;
  for (const ei of edges) {
    const e = t.edges[ei];
    if (!e) continue;
    mesh.setBevelWeight(e.a, e.b, weight);
    n++;
  }
  return n;
}
