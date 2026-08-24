import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';

/**
 * The knife.
 *
 * A cut is a polyline the user draws over the model on screen. Everything
 * happens in that 2D space, because that is where the user drew it: a stroke
 * that reads as a straight line across a curved surface is only straight from
 * the camera, and projecting it back into 3D any other way would bend it.
 *
 * The work is in getting the seam shared. Where the cut crosses an edge, both
 * faces on that edge have to gain the same vertex, or the cut leaves a hairline
 * crack down the middle. So crossings are collected per mesh edge first,
 * vertices are made once, and only then are the faces rebuilt around them.
 */

export interface KnifeOptions {
  /** World-space point to screen coordinates. */
  project: (p: Vec3) => [number, number];
  /** The stroke, in the same screen coordinates. */
  path: [number, number][];
  /**
   * Cut faces pointing away from the camera as well. Off by default: a cut
   * drawn over the front of a model usually is not also meant for the back.
   */
  cutThrough?: boolean;
  /** True when this face is towards the camera. Required unless `cutThrough`. */
  frontFacing?: (face: number) => boolean;
  /** Only cut these faces. Omitted means the whole mesh. */
  restrict?: Iterable<number>;
}

export interface KnifeResult {
  /** Vertices the cut inserted. */
  newVerts: number[];
  /** How many faces the cut split. */
  splits: number;
}

/** Where a cut segment crosses a face edge, in that edge's own parameter. */
interface Crossing {
  /** Index into the face's corner list: the edge from corner i to corner i+1. */
  corner: number;
  /** 0..1 along that edge. */
  t: number;
  /** Distance along the whole stroke, for ordering. */
  along: number;
}

/**
 * Where two 2D segments cross, as parameters along each, or null.
 *
 * Endpoints are excluded on the face's side: a cut that clips exactly through
 * a corner would otherwise register on both edges meeting there and split the
 * face twice in the same place.
 */
function segmentCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): [number, number] | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6) return null;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  return [t, u];
}

export function knifeCut(mesh: Mesh, options: KnifeOptions): KnifeResult {
  const empty: KnifeResult = { newVerts: [], splits: 0 };
  const path = options.path;
  if (path.length < 2 || mesh.faces.length === 0) return empty;

  const t = mesh.topology();
  const screen = mesh.positions.map((p) => options.project(p));

  // Cumulative stroke length, so crossings can be ordered along the cut rather
  // than by which face happened to be visited first.
  const cumulative: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }

  const allowed = options.restrict ? new Set(options.restrict) : null;
  const faceCrossings = new Map<number, Crossing[]>();
  // Mesh edge index -> the parameters along it that need a vertex. Shared
  // between the faces on that edge, which is what keeps the cut watertight.
  const edgeSplits = new Map<number, number[]>();

  for (let f = 0; f < mesh.faces.length; f++) {
    if (allowed && !allowed.has(f)) continue;
    if (!options.cutThrough && options.frontFacing && !options.frontFacing(f)) continue;
    const loop = mesh.faces[f];
    if (loop.length < 3) continue;

    const hits: Crossing[] = [];
    for (let c = 0; c < loop.length; c++) {
      const a = screen[loop[c]];
      const b = screen[loop[(c + 1) % loop.length]];
      for (let s = 0; s + 1 < path.length; s++) {
        const cross = segmentCross(
          a[0], a[1], b[0], b[1],
          path[s][0], path[s][1], path[s + 1][0], path[s + 1][1],
        );
        if (!cross) continue;
        const [te, tp] = cross;
        const along = cumulative[s] + (cumulative[s + 1] - cumulative[s]) * tp;
        hits.push({ corner: c, t: te, along });
      }
    }
    if (hits.length < 2) continue;
    hits.sort((x, y) => x.along - y.along);
    faceCrossings.set(f, hits);

    for (const hit of hits) {
      const ei = t.faceEdges[f][hit.corner];
      if (ei < 0) continue;
      const e = t.edges[ei];
      // Edge parameters are stored from the edge's own `a` to `b`, so the two
      // faces sharing it agree on where the point goes.
      const forward = loop[hit.corner] === e.a;
      const param = forward ? hit.t : 1 - hit.t;
      const list = edgeSplits.get(ei) ?? [];
      if (!list.some((p) => Math.abs(p - param) < 1e-5)) list.push(param);
      edgeSplits.set(ei, list);
    }
  }
  if (faceCrossings.size === 0) return empty;

  // Make the shared vertices.
  const vertexAt = new Map<string, number>();
  const newVerts: number[] = [];
  for (const [ei, params] of edgeSplits) {
    const e = t.edges[ei];
    params.sort((a, b) => a - b);
    for (const p of params) {
      const idx = mesh.positions.length;
      mesh.positions.push(mesh.positions[e.a].lerp(mesh.positions[e.b], p));
      vertexAt.set(`${ei}:${p.toFixed(6)}`, idx);
      newVerts.push(idx);
    }
  }

  const lookup = (ei: number, param: number): number | undefined => {
    const params = edgeSplits.get(ei);
    if (!params) return undefined;
    for (const p of params) {
      if (Math.abs(p - param) < 1e-5) return vertexAt.get(`${ei}:${p.toFixed(6)}`);
    }
    return undefined;
  };

  // Rebuild each cut face: insert the new vertices into its loop, then split it
  // along the chord between the first and last crossing.
  const extraFaces: number[][] = [];
  const extraMaterial: number[] = [];
  const extraSmooth: boolean[] = [];
  const extraUV: (number[] | null)[] = [];
  let splits = 0;

  for (const [f, hits] of faceCrossings) {
    const loop = mesh.faces[f];
    const srcUV = mesh.uvFor(f);
    // Per corner, the inserted vertices on the edge that leaves it, ordered.
    const inserts = new Map<number, { vert: number; t: number }[]>();
    for (const hit of hits) {
      const ei = t.faceEdges[f][hit.corner];
      if (ei < 0) continue;
      const e = t.edges[ei];
      const forward = loop[hit.corner] === e.a;
      const vert = lookup(ei, forward ? hit.t : 1 - hit.t);
      if (vert === undefined) continue;
      const list = inserts.get(hit.corner) ?? [];
      if (!list.some((x) => x.vert === vert)) list.push({ vert, t: hit.t });
      inserts.set(hit.corner, list);
    }
    if (inserts.size < 2) continue;

    const expanded: number[] = [];
    const expandedUV: number[] = [];
    for (let c = 0; c < loop.length; c++) {
      expanded.push(loop[c]);
      if (srcUV) expandedUV.push(srcUV[c * 2], srcUV[c * 2 + 1]);
      const list = inserts.get(c);
      if (!list) continue;
      list.sort((a, b) => a.t - b.t);
      const j = ((c + 1) % loop.length) * 2;
      for (const ins of list) {
        expanded.push(ins.vert);
        if (srcUV) {
          expandedUV.push(
            srcUV[c * 2] + (srcUV[j] - srcUV[c * 2]) * ins.t,
            srcUV[c * 2 + 1] + (srcUV[j + 1] - srcUV[c * 2 + 1]) * ins.t,
          );
        }
      }
    }

    // The chord runs between the first and last crossing along the stroke.
    const firstVert = (() => {
      const h = hits[0];
      const ei = t.faceEdges[f][h.corner];
      const e = t.edges[ei];
      return lookup(ei, loop[h.corner] === e.a ? h.t : 1 - h.t);
    })();
    const lastVert = (() => {
      const h = hits[hits.length - 1];
      const ei = t.faceEdges[f][h.corner];
      const e = t.edges[ei];
      return lookup(ei, loop[h.corner] === e.a ? h.t : 1 - h.t);
    })();
    if (firstVert === undefined || lastVert === undefined || firstVert === lastVert) continue;

    const ia = expanded.indexOf(firstVert);
    const ib = expanded.indexOf(lastVert);
    if (ia < 0 || ib < 0) continue;
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    const sideA = expanded.slice(lo, hi + 1);
    const sideB = expanded.slice(hi).concat(expanded.slice(0, lo + 1));
    if (sideA.length < 3 || sideB.length < 3) continue;

    const uvSlice = (from: number, to: number): number[] | null => {
      if (!srcUV) return null;
      const out: number[] = [];
      for (let i = from; i <= to; i++) out.push(expandedUV[i * 2], expandedUV[i * 2 + 1]);
      return out;
    };
    const uvA = uvSlice(lo, hi);
    const uvB = srcUV
      ? (() => {
        const out: number[] = [];
        for (let i = hi; i < expanded.length; i++) out.push(expandedUV[i * 2], expandedUV[i * 2 + 1]);
        for (let i = 0; i <= lo; i++) out.push(expandedUV[i * 2], expandedUV[i * 2 + 1]);
        return out;
      })()
      : null;

    mesh.faces[f] = sideA;
    if (srcUV) mesh.setUV(f, uvA);
    extraFaces.push(sideB);
    extraMaterial.push(mesh.faceMaterial[f] ?? 0);
    extraSmooth.push(mesh.isFaceSmooth(f));
    extraUV.push(uvB);
    splits++;
  }

  for (let i = 0; i < extraFaces.length; i++) {
    const idx = mesh.faces.length;
    mesh.faces.push(extraFaces[i]);
    mesh.faceMaterial.push(extraMaterial[i]);
    if (mesh.faceSmooth) mesh.faceSmooth.push(extraSmooth[i]);
    if (mesh.faceUV) mesh.setUV(idx, extraUV[i]);
  }

  mesh.markDirty();

  // Faces the cut crossed but did not split still gained vertices on their
  // edges from the neighbour that did; those are already in their loops
  // because the loop rebuild above ran per face. Anything left is a face the
  // cut only grazed, and stitching closes it.
  insertMissedVertices(mesh, edgeSplits, t, vertexAt);
  mesh.markDirty();
  return { newVerts, splits };
}

/**
 * Put the new vertices into the loops of faces that share a cut edge but were
 * not themselves split — a back face, or one the stroke only clipped.
 *
 * Without this the two faces on that edge disagree about how many corners it
 * has, which is a T-junction: it shades as a crack and it breaks every
 * adjacency query downstream.
 */
function insertMissedVertices(
  mesh: Mesh,
  edgeSplits: Map<number, number[]>,
  t: ReturnType<Mesh['topology']>,
  vertexAt: Map<string, number>,
): void {
  for (const [ei, params] of edgeSplits) {
    const e = t.edges[ei];
    const verts = params.map((p) => vertexAt.get(`${ei}:${p.toFixed(6)}`)).filter((v): v is number => v !== undefined);
    if (verts.length === 0) continue;
    for (const f of e.faces) {
      const loop = mesh.faces[f];
      if (verts.every((v) => loop.includes(v))) continue;
      // Find where this edge sits in the (possibly rebuilt) loop.
      for (let c = 0; c < loop.length; c++) {
        const a = loop[c];
        const b = loop[(c + 1) % loop.length];
        const matches = (a === e.a && b === e.b) || (a === e.b && b === e.a);
        if (!matches) continue;
        const forward = a === e.a;
        const ordered = params
          .map((p, i) => ({ p, v: verts[i] }))
          .filter((x) => x.v !== undefined && !loop.includes(x.v))
          .sort((x, y) => (forward ? x.p - y.p : y.p - x.p))
          .map((x) => x.v);
        if (ordered.length === 0) break;
        const srcUV = mesh.uvFor(f);
        const out = loop.slice(0, c + 1).concat(ordered, loop.slice(c + 1));
        if (srcUV) {
          const uv: number[] = [];
          for (let i = 0; i <= c; i++) uv.push(srcUV[i * 2], srcUV[i * 2 + 1]);
          const j = ((c + 1) % loop.length) * 2;
          for (const v of ordered) {
            const pa = mesh.positions[a];
            const pb = mesh.positions[b];
            const ab = pb.sub(pa);
            const denom = ab.lengthSq();
            const u = denom > 1e-20 ? mesh.positions[v].sub(pa).dot(ab) / denom : 0.5;
            uv.push(
              srcUV[c * 2] + (srcUV[j] - srcUV[c * 2]) * u,
              srcUV[c * 2 + 1] + (srcUV[j + 1] - srcUV[c * 2 + 1]) * u,
            );
          }
          for (let i = c + 1; i < loop.length; i++) uv.push(srcUV[i * 2], srcUV[i * 2 + 1]);
          mesh.faces[f] = out;
          mesh.setUV(f, uv);
        } else {
          mesh.faces[f] = out;
        }
        break;
      }
    }
  }
}

/** A screen-space projector for a camera matrix, for callers that have one. */
export function screenProjector(
  viewProj: { transformPoint(p: Vec3): Vec3 }, width: number, height: number,
): (p: Vec3) => [number, number] {
  return (p: Vec3): [number, number] => {
    const c = viewProj.transformPoint(p);
    return [(c.x * 0.5 + 0.5) * width, (0.5 - c.y * 0.5) * height];
  };
}
