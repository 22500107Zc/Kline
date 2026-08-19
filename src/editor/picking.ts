import { Mat4, Vec3, rayTriangle } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { Scene, SceneObject } from '../scene/Scene';
import { ViewportCamera } from '../scene/ViewportCamera';
import { SelectMode } from '../render/Renderer';

/**
 * CPU picking. Everything is ray-cast or projected on the CPU rather than read
 * back from a GPU id buffer: no pipeline stalls, and element picking can apply
 * the same "nearest within N pixels" rules the user expects.
 */

export interface Viewport {
  width: number;
  height: number;
}

export interface ObjectHit {
  object: SceneObject;
  distance: number;
}

const HELPER_PICK_RADIUS = 18;

export function pickObject(
  scene: Scene, camera: ViewportCamera, x: number, y: number, vp: Viewport,
): ObjectHit | null {
  const ray = camera.screenRay(x, y, vp.width, vp.height);
  let best: ObjectHit | null = null;

  for (const obj of scene.objects.values()) {
    if (!obj.visible || obj.locked) continue;
    if (obj.type === 'mesh') {
      const mesh = obj.evaluated();
      if (!mesh) continue;
      const inv = obj.worldMatrix(scene).inverse();
      const o = inv.transformPoint(ray.origin);
      const d = inv.transformDirection(ray.dir);
      const t = rayMeshDistance(mesh, o, d);
      if (t !== null) {
        // Convert back to world units so objects with different scales compare fairly.
        const worldHit = obj.worldMatrix(scene).transformPoint(o.add(d.scale(t)));
        const dist = worldHit.sub(ray.origin).length();
        if (!best || dist < best.distance) best = { object: obj, distance: dist };
      }
    } else {
      const origin = obj.worldMatrix(scene).transformPoint(new Vec3());
      const s = camera.worldToScreen(origin, vp.width, vp.height);
      if (s.z < -1 || s.z > 1) continue;
      if (Math.hypot(s.x - x, s.y - y) <= HELPER_PICK_RADIUS) {
        const dist = origin.sub(ray.origin).length() - 0.001;
        if (!best || dist < best.distance) best = { object: obj, distance: dist };
      }
    }
  }
  return best;
}

/** Nearest ray hit against a mesh, in the mesh's own space. */
export function rayMeshDistance(mesh: Mesh, origin: Vec3, dir: Vec3): number | null {
  let best: number | null = null;
  for (const loop of mesh.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      const t = rayTriangle(
        origin, dir, mesh.positions[loop[0]], mesh.positions[loop[i]], mesh.positions[loop[i + 1]],
      );
      if (t !== null && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/** The face a ray hits first, in mesh space. */
export function pickFaceRay(mesh: Mesh, origin: Vec3, dir: Vec3): { face: number; t: number } | null {
  let best: { face: number; t: number } | null = null;
  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    for (let i = 1; i + 1 < loop.length; i++) {
      const t = rayTriangle(
        origin, dir, mesh.positions[loop[0]], mesh.positions[loop[i]], mesh.positions[loop[i + 1]],
      );
      if (t !== null && (best === null || t < best.t)) best = { face: f, t };
    }
  }
  return best;
}

export interface ElementPickOptions {
  xray: boolean;
  radius: number;
}

/**
 * Pick one mesh element under the cursor. Vertices and edges are matched in
 * screen space; faces by ray intersection. Without x-ray, candidates hidden
 * behind surfaces are rejected by a shadow ray.
 */
export function pickElement(
  mesh: Mesh, model: Mat4, camera: ViewportCamera,
  x: number, y: number, vp: Viewport, mode: SelectMode,
  opts: ElementPickOptions = { xray: false, radius: 14 },
): number | null {
  const inv = model.inverse();
  const ray = camera.screenRay(x, y, vp.width, vp.height);
  const localOrigin = inv.transformPoint(ray.origin);
  const localDir = inv.transformDirection(ray.dir).normalized();

  if (mode === 'face') {
    const hit = pickFaceRay(mesh, localOrigin, localDir);
    if (hit) return hit.face;
    // Fall back to the nearest face centre on screen, so flat-on n-gons still pick.
    return nearestByScreen(
      mesh.faces.map((_, f) => f),
      (f) => model.transformPoint(mesh.faceCenter(f)),
      camera, x, y, vp, opts.radius * 1.5,
    );
  }

  if (mode === 'vertex') {
    const candidates = collectScreenCandidates(
      mesh.positions.map((_, i) => i),
      (i) => model.transformPoint(mesh.positions[i]),
      camera, x, y, vp, opts.radius,
    );
    for (const c of candidates) {
      if (opts.xray || !isOccluded(mesh, localOrigin, mesh.positions[c.index])) return c.index;
    }
    return candidates.length ? candidates[0].index : null;
  }

  const t = mesh.topology();
  const candidates = collectScreenCandidates(
    t.edges.map((_, i) => i),
    (i) => model.transformPoint(mesh.edgeCenter(i)),
    camera, x, y, vp, opts.radius * 1.6,
    (i) => {
      const e = t.edges[i];
      return [model.transformPoint(mesh.positions[e.a]), model.transformPoint(mesh.positions[e.b])];
    },
  );
  for (const c of candidates) {
    if (opts.xray || !isOccluded(mesh, localOrigin, mesh.edgeCenter(c.index))) return c.index;
  }
  return candidates.length ? candidates[0].index : null;
}

/** True when geometry sits between the eye and a point (both in mesh space). */
function isOccluded(mesh: Mesh, eye: Vec3, target: Vec3): boolean {
  const d = target.sub(eye);
  const len = d.length();
  if (len < 1e-9) return false;
  const dir = d.scale(1 / len);
  const t = rayMeshDistance(mesh, eye, dir);
  return t !== null && t < len - Math.max(1e-4, len * 0.002);
}

interface ScreenCandidate {
  index: number;
  screenDist: number;
  depth: number;
}

function collectScreenCandidates(
  items: number[],
  pointOf: (i: number) => Vec3,
  camera: ViewportCamera, x: number, y: number, vp: Viewport, radius: number,
  segmentOf?: (i: number) => [Vec3, Vec3],
): ScreenCandidate[] {
  const out: ScreenCandidate[] = [];
  for (const i of items) {
    let dist: number;
    let depth: number;
    if (segmentOf) {
      const [wa, wb] = segmentOf(i);
      const a = camera.worldToScreen(wa, vp.width, vp.height);
      const b = camera.worldToScreen(wb, vp.width, vp.height);
      if (a.z < -1 || a.z > 1 || b.z < -1 || b.z > 1) continue;
      dist = pointSegmentDistance2D(x, y, a.x, a.y, b.x, b.y);
      depth = (a.z + b.z) / 2;
    } else {
      const s = camera.worldToScreen(pointOf(i), vp.width, vp.height);
      if (s.z < -1 || s.z > 1) continue;
      dist = Math.hypot(s.x - x, s.y - y);
      depth = s.z;
    }
    if (dist <= radius) out.push({ index: i, screenDist: dist, depth });
  }
  // Prefer what's nearest the cursor, then nearest the eye.
  out.sort((a, b) => (a.screenDist - b.screenDist) * 0.4 + (a.depth - b.depth));
  return out;
}

function nearestByScreen(
  items: number[], pointOf: (i: number) => Vec3,
  camera: ViewportCamera, x: number, y: number, vp: Viewport, radius: number,
): number | null {
  const c = collectScreenCandidates(items, pointOf, camera, x, y, vp, radius);
  return c.length ? c[0].index : null;
}

export function pointSegmentDistance2D(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function normalizeRect(r: Rect): Rect {
  return {
    x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1),
  };
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** Objects whose origin or any vertex falls inside the rectangle. */
export function boxSelectObjects(
  scene: Scene, camera: ViewportCamera, rect: Rect, vp: Viewport,
): number[] {
  const r = normalizeRect(rect);
  const out: number[] = [];
  for (const obj of scene.objects.values()) {
    if (!obj.visible || obj.locked) continue;
    const model = obj.worldMatrix(scene);
    const origin = camera.worldToScreen(model.transformPoint(new Vec3()), vp.width, vp.height);
    if (origin.z >= -1 && origin.z <= 1 && inRect(r, origin.x, origin.y)) {
      out.push(obj.id);
      continue;
    }
    const mesh = obj.evaluated();
    if (!mesh) continue;
    for (const p of mesh.positions) {
      const s = camera.worldToScreen(model.transformPoint(p), vp.width, vp.height);
      if (s.z >= -1 && s.z <= 1 && inRect(r, s.x, s.y)) {
        out.push(obj.id);
        break;
      }
    }
  }
  return out;
}

/** Mesh elements inside the rectangle, respecting x-ray occlusion. */
export function boxSelectElements(
  mesh: Mesh, model: Mat4, camera: ViewportCamera, rect: Rect, vp: Viewport,
  mode: SelectMode, xray: boolean,
): number[] {
  const r = normalizeRect(rect);
  const inv = model.inverse();
  const eye = inv.transformPoint(camera.eye());
  const out: number[] = [];

  const test = (world: Vec3, local: Vec3): boolean => {
    const s = camera.worldToScreen(world, vp.width, vp.height);
    if (s.z < -1 || s.z > 1 || !inRect(r, s.x, s.y)) return false;
    return xray || !isOccluded(mesh, eye, local);
  };

  if (mode === 'vertex') {
    for (let i = 0; i < mesh.positions.length; i++) {
      if (test(model.transformPoint(mesh.positions[i]), mesh.positions[i])) out.push(i);
    }
  } else if (mode === 'edge') {
    const t = mesh.topology();
    for (let i = 0; i < t.edges.length; i++) {
      const c = mesh.edgeCenter(i);
      if (test(model.transformPoint(c), c)) out.push(i);
    }
  } else {
    for (let f = 0; f < mesh.faces.length; f++) {
      const c = mesh.faceCenter(f);
      if (test(model.transformPoint(c), c)) out.push(f);
    }
  }
  return out;
}

/** Where a screen ray meets the XY ground plane (used to place the 3D cursor). */
export function raycastGround(camera: ViewportCamera, x: number, y: number, vp: Viewport): Vec3 | null {
  const ray = camera.screenRay(x, y, vp.width, vp.height);
  if (Math.abs(ray.dir.z) < 1e-6) return null;
  const t = -ray.origin.z / ray.dir.z;
  if (t < 0) return null;
  return ray.origin.add(ray.dir.scale(t));
}
