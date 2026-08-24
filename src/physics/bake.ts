import { Vec3 } from '../core/math';
import { Scene } from '../scene/Scene';
import { setKey } from '../anim/animation';
import { PhysicsWorld, RigidBody, bodyForBounds, defaultWorld } from './rigidbody';

/**
 * Turning a simulation into animation.
 *
 * A modelling application does not need physics at runtime; it needs the
 * answer physics gives. So the sim runs once, over the timeline, and the
 * result is written as keyframes — after which nothing depends on the solver
 * being deterministic, the same across machines, or even still present. The
 * animation is the artefact.
 */

export interface BakeResult {
  /** Objects that were simulated. */
  bodies: number;
  frames: number;
  /** Keys written across all channels. */
  keys: number;
}

/**
 * Build a world from whatever in the scene has been marked as a body.
 *
 * Shapes come from world-space bounds rather than the geometry itself. A box
 * around a chair settles it on a floor correctly, and an exact hull would cost
 * far more than the difference is worth in an application where the point is
 * to get a plausible resting arrangement quickly.
 */
export function worldFromScene(scene: Scene): PhysicsWorld {
  const world = new PhysicsWorld(defaultWorld());
  for (const obj of scene.objects.values()) {
    if (!obj.physics || !obj.visible) continue;
    const geo = obj.evaluated(false);
    if (!geo || geo.positions.length === 0) continue;
    const local = geo.bounds();
    if (!local.valid) continue;
    const m = obj.worldMatrix(scene);
    let lo = new Vec3(Infinity, Infinity, Infinity);
    let hi = new Vec3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      const p = m.transformPoint(new Vec3(
        i & 1 ? local.max.x : local.min.x,
        i & 2 ? local.max.y : local.min.y,
        i & 4 ? local.max.z : local.min.z,
      ));
      lo = new Vec3(Math.min(lo.x, p.x), Math.min(lo.y, p.y), Math.min(lo.z, p.z));
      hi = new Vec3(Math.max(hi.x, p.x), Math.max(hi.y, p.y), Math.max(hi.z, p.z));
    }
    const mass = obj.physics.kind === 'passive' ? 0 : Math.max(1e-3, obj.physics.mass);
    const body = bodyForBounds(obj.id, lo, hi, obj.physics.shape, mass);
    body.friction = obj.physics.friction;
    body.restitution = obj.physics.restitution;
    body.rotation = obj.rotation.clone();
    world.add(body);
  }
  return world;
}

/**
 * Run the simulation across the timeline and write the result as keyframes.
 *
 * Existing position and rotation keys on the simulated objects are cleared
 * first: leaving them would blend the sim against whatever was there and
 * produce something that is neither.
 */
export function bakeToKeyframes(scene: Scene): BakeResult {
  const world = worldFromScene(scene);
  const active = world.bodies.filter((b) => b.mass > 0);
  if (active.length === 0) return { bodies: 0, frames: 0, keys: 0 };

  const start = Math.round(scene.timeline.start);
  const end = Math.round(scene.timeline.end);
  const frames = Math.max(0, end - start);
  const fps = Math.max(1, scene.timeline.fps);

  // The object's own origin is not usually the centre of its bounds, so the
  // sim's positions have to be brought back to origins before they are keyed.
  const originOffset = new Map<number, Vec3>();
  for (const b of world.bodies) {
    const obj = scene.get(b.objectId);
    if (obj) originOffset.set(b.objectId, obj.position.sub(b.position));
  }

  const track = world.simulate(frames, fps);
  let keys = 0;
  const simulated = new Set(active.map((b) => b.objectId));

  for (const id of simulated) {
    const obj = scene.get(id);
    if (!obj) continue;
    obj.animation = obj.animation.filter((c) => c.path !== 'position' && c.path !== 'rotation');
  }

  for (let f = 0; f < track.length; f++) {
    const frame = start + f;
    for (const state of track[f]) {
      if (!simulated.has(state.objectId)) continue;
      const obj = scene.get(state.objectId);
      if (!obj) continue;
      const offset = originOffset.get(state.objectId) ?? new Vec3();
      const pos = [
        state.position[0] + offset.x,
        state.position[1] + offset.y,
        state.position[2] + offset.z,
      ];
      for (let i = 0; i < 3; i++) {
        // Linear rather than bezier: the solver already produced a sample per
        // frame, and smoothing between them would round off the moment of an
        // impact, which is the one part nobody wants softened.
        setKey(obj.animation, 'position', i, frame, pos[i], 'linear');
        setKey(obj.animation, 'rotation', i, frame, state.rotation[i], 'linear');
        keys += 2;
      }
    }
  }

  return { bodies: active.length, frames: track.length, keys };
}

/** Remove baked animation from every simulated object. */
export function clearBake(scene: Scene): number {
  let cleared = 0;
  for (const obj of scene.objects.values()) {
    if (!obj.physics) continue;
    const before = obj.animation.length;
    obj.animation = obj.animation.filter((c) => c.path !== 'position' && c.path !== 'rotation');
    if (obj.animation.length !== before) cleared++;
  }
  return cleared;
}

/** Where every body ends up, without writing anything — for a quick preview. */
export function settle(scene: Scene, seconds = 3): Map<number, RigidBody> {
  const world = worldFromScene(scene);
  const steps = Math.round(seconds / world.settings.step);
  for (let i = 0; i < steps; i++) world.step();
  const out = new Map<number, RigidBody>();
  for (const b of world.bodies) out.set(b.objectId, b);
  return out;
}
