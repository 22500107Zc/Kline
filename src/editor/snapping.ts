import { Mat4, Vec3 } from '../core/math';
import { Scene } from '../scene/Scene';
import { ViewportCamera } from '../scene/ViewportCamera';
import { Viewport } from './picking';

/**
 * Snapping targets. `increment` and `grid` are numeric; the rest look for real
 * geometry under the cursor, ignoring whatever is currently being dragged.
 */
export type SnapMode = 'increment' | 'grid' | 'vertex' | 'edge' | 'face';

export const SNAP_LABELS: Record<SnapMode, string> = {
  increment: 'Increment',
  grid: 'Absolute Grid',
  vertex: 'Vertex',
  edge: 'Edge',
  face: 'Face',
};

export interface SnapSettings {
  enabled: boolean;
  mode: SnapMode;
  increment: number;
}

export function defaultSnap(): SnapSettings {
  return { enabled: false, mode: 'increment', increment: 0.25 };
}

function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = b.sub(a);
  const len = ab.lengthSq();
  if (len < 1e-16) return a.clone();
  const t = Math.max(0, Math.min(1, p.sub(a).dot(ab) / len));
  return a.add(ab.scale(t));
}

/**
 * Nearest geometric snap point to the cursor, in world space.
 * `excludeObjects` keeps the dragged geometry from snapping to itself.
 */
export function snapPointUnderCursor(
  scene: Scene, camera: ViewportCamera, x: number, y: number, vp: Viewport,
  mode: SnapMode, excludeObjects: Set<number>, pixelRadius = 26,
): Vec3 | null {
  if (mode === 'increment' || mode === 'grid') return null;
  let best: { p: Vec3; d: number } | null = null;
  const consider = (world: Vec3): void => {
    const s = camera.worldToScreen(world, vp.width, vp.height);
    if (s.z > 1 || s.z < -1) return;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d > pixelRadius) return;
    if (!best || d < best.d) best = { p: world, d };
  };

  for (const obj of scene.objects.values()) {
    if (!obj.visible || obj.type !== 'mesh' || excludeObjects.has(obj.id)) continue;
    const mesh = obj.evaluated(false);
    if (!mesh) continue;
    const model: Mat4 = obj.worldMatrix(scene);
    if (mode === 'vertex') {
      for (const p of mesh.positions) consider(model.transformPoint(p));
      continue;
    }
    if (mode === 'face') {
      for (let f = 0; f < mesh.faces.length; f++) consider(model.transformPoint(mesh.faceCenter(f)));
      continue;
    }
    const t = mesh.topology();
    const ray = camera.screenRay(x, y, vp.width, vp.height);
    for (let i = 0; i < t.edges.length; i++) {
      const e = t.edges[i];
      const a = model.transformPoint(mesh.positions[e.a]);
      const b = model.transformPoint(mesh.positions[e.b]);
      const mid = a.add(b).scale(0.5);
      const s = camera.worldToScreen(mid, vp.width, vp.height);
      if (s.z > 1 || s.z < -1 || Math.hypot(s.x - x, s.y - y) > pixelRadius * 2) continue;
      // Snap to the point on the edge nearest the cursor ray, not just its midpoint.
      const onRay = ray.origin.add(ray.dir.scale(Math.max(0, mid.sub(ray.origin).dot(ray.dir))));
      consider(closestOnSegment(onRay, a, b));
    }
  }
  return best ? (best as { p: Vec3 }).p : null;
}

/** Round a world position onto the absolute grid. */
export function snapToGrid(p: Vec3, step: number): Vec3 {
  if (step <= 0) return p.clone();
  return new Vec3(
    Math.round(p.x / step) * step,
    Math.round(p.y / step) * step,
    Math.round(p.z / step) * step,
  );
}
