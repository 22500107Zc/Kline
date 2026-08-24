import { Mat4, Vec3 } from '../core/math';

/**
 * Rigid body simulation.
 *
 * The point of this in a modelling application is not to be a game engine. It
 * is to answer "where would these land if I dropped them" without anyone
 * placing forty objects by hand — so the simulation runs, and then it is baked
 * to keyframes and forgotten about. Everything downstream sees animation, not
 * physics.
 *
 * Bodies are boxes and spheres. A convex hull solver would fit more shapes,
 * but a box around a chair is close enough to settle it on a floor, and the
 * failure mode of an approximate shape (it rests a little high) is far kinder
 * than the failure mode of a slow or unstable one.
 *
 * Contacts are resolved by sequential impulses with a positional correction
 * pass. Iterating impulses converges on a stack that holds still, which
 * single-pass resolution never does — a tower built that way jitters apart.
 */

export type BodyShape = 'box' | 'sphere';

export interface RigidBody {
  /** Scene object this drives. */
  objectId: number;
  shape: BodyShape;
  /** Half-extents for a box; x is the radius for a sphere. */
  halfExtents: Vec3;
  position: Vec3;
  /** Euler XYZ, radians. */
  rotation: Vec3;
  velocity: Vec3;
  angularVelocity: Vec3;
  /** Zero means immovable: a floor, a wall, a conveyor that never moves. */
  mass: number;
  /** 0 slides forever, 1 grips. */
  friction: number;
  /** 0 lands dead, 1 bounces back to the height it fell from. */
  restitution: number;
  /** A body at rest stops being integrated until something hits it. */
  sleeping: boolean;
}

export interface WorldSettings {
  gravity: Vec3;
  /** Fixed timestep. Physics is not framerate-independent and pretending it is
   * makes results depend on the machine that ran it. */
  step: number;
  iterations: number;
  /** Velocity below which a body is allowed to fall asleep. */
  sleepThreshold: number;
}

export function defaultWorld(): WorldSettings {
  return {
    gravity: new Vec3(0, 0, -9.81),
    step: 1 / 60,
    iterations: 8,
    sleepThreshold: 0.04,
  };
}

export function createBody(objectId: number, partial: Partial<RigidBody> = {}): RigidBody {
  return {
    objectId,
    shape: partial.shape ?? 'box',
    halfExtents: partial.halfExtents ?? new Vec3(0.5, 0.5, 0.5),
    position: partial.position ?? new Vec3(),
    rotation: partial.rotation ?? new Vec3(),
    velocity: partial.velocity ?? new Vec3(),
    angularVelocity: partial.angularVelocity ?? new Vec3(),
    mass: partial.mass ?? 1,
    friction: partial.friction ?? 0.5,
    restitution: partial.restitution ?? 0.1,
    sleeping: false,
  };
}

interface Contact {
  a: RigidBody;
  b: RigidBody;
  /** Unit normal, pointing from a towards b. */
  normal: Vec3;
  /** How far they overlap along the normal. */
  depth: number;
  point: Vec3;
}

/** The radius of the sphere that encloses a body, for broad-phase rejection. */
function boundingRadius(b: RigidBody): number {
  return b.shape === 'sphere' ? b.halfExtents.x : b.halfExtents.length();
}

/**
 * Contact between two spheres.
 *
 * The easy case, and the one worth having exactly right: two spheres either
 * overlap or they do not, and the normal is the line between their centres.
 */
function sphereSphere(a: RigidBody, b: RigidBody): Contact | null {
  const d = b.position.sub(a.position);
  const dist = d.length();
  const sum = a.halfExtents.x + b.halfExtents.x;
  if (dist >= sum) return null;
  const normal = dist > 1e-9 ? d.scale(1 / dist) : new Vec3(0, 0, 1);
  return {
    a, b, normal,
    depth: sum - dist,
    point: a.position.add(normal.scale(a.halfExtents.x - (sum - dist) * 0.5)),
  };
}

/**
 * Contact between two axis-aligned boxes.
 *
 * Rotation is deliberately ignored for the overlap test. A rotated box needs
 * the separating-axis theorem and a clipping pass to find the contact
 * manifold, and the result of getting that subtly wrong is a stack that
 * explodes. An axis-aligned approximation settles reliably, and for the job
 * this does — dropping props onto a floor — a box that rests a hair high is a
 * far better failure than one that jitters.
 */
function boxBox(a: RigidBody, b: RigidBody): Contact | null {
  const d = b.position.sub(a.position);
  const overlapX = a.halfExtents.x + b.halfExtents.x - Math.abs(d.x);
  if (overlapX <= 0) return null;
  const overlapY = a.halfExtents.y + b.halfExtents.y - Math.abs(d.y);
  if (overlapY <= 0) return null;
  const overlapZ = a.halfExtents.z + b.halfExtents.z - Math.abs(d.z);
  if (overlapZ <= 0) return null;

  // Push out along whichever axis they overlap least — the shallowest way out
  // is the one that does not teleport a body through its neighbour.
  let normal: Vec3;
  let depth: number;
  if (overlapX <= overlapY && overlapX <= overlapZ) {
    normal = new Vec3(Math.sign(d.x) || 1, 0, 0);
    depth = overlapX;
  } else if (overlapY <= overlapZ) {
    normal = new Vec3(0, Math.sign(d.y) || 1, 0);
    depth = overlapY;
  } else {
    normal = new Vec3(0, 0, Math.sign(d.z) || 1);
    depth = overlapZ;
  }
  return { a, b, normal, depth, point: a.position.add(d.scale(0.5)) };
}

/** Contact between a sphere and an axis-aligned box. */
function sphereBox(sphere: RigidBody, box: RigidBody): Contact | null {
  const r = sphere.halfExtents.x;
  const rel = sphere.position.sub(box.position);
  const closest = new Vec3(
    Math.max(-box.halfExtents.x, Math.min(box.halfExtents.x, rel.x)),
    Math.max(-box.halfExtents.y, Math.min(box.halfExtents.y, rel.y)),
    Math.max(-box.halfExtents.z, Math.min(box.halfExtents.z, rel.z)),
  );
  const delta = rel.sub(closest);
  const dist = delta.length();
  if (dist >= r) return null;
  // A centre inside the box has no direction to push along; use the nearest
  // face instead of an undefined normal.
  let normal: Vec3;
  if (dist > 1e-9) {
    normal = delta.scale(-1 / dist);
  } else {
    const gaps = [
      box.halfExtents.x - Math.abs(rel.x),
      box.halfExtents.y - Math.abs(rel.y),
      box.halfExtents.z - Math.abs(rel.z),
    ];
    const axis = gaps.indexOf(Math.min(...gaps));
    normal = Vec3.axis(axis).scale(-(Math.sign([rel.x, rel.y, rel.z][axis]) || 1));
  }
  return {
    a: sphere, b: box, normal,
    depth: r - dist,
    point: box.position.add(closest),
  };
}

function collide(a: RigidBody, b: RigidBody): Contact | null {
  if (a.shape === 'sphere' && b.shape === 'sphere') return sphereSphere(a, b);
  if (a.shape === 'box' && b.shape === 'box') return boxBox(a, b);
  if (a.shape === 'sphere') return sphereBox(a, b);
  const flipped = sphereBox(b, a);
  if (!flipped) return null;
  return { a, b, normal: flipped.normal.neg(), depth: flipped.depth, point: flipped.point };
}

/** One frozen instant, ready to be turned into keyframes. */
export interface BodyState {
  objectId: number;
  position: [number, number, number];
  rotation: [number, number, number];
}

export class PhysicsWorld {
  bodies: RigidBody[] = [];

  constructor(public settings: WorldSettings = defaultWorld()) {}

  add(body: RigidBody): RigidBody {
    this.bodies.push(body);
    return body;
  }

  /** Wake everything: after an edit, nothing's rest is trustworthy any more. */
  wakeAll(): void {
    for (const b of this.bodies) b.sleeping = false;
  }

  /** Advance by exactly one fixed step. */
  step(): void {
    const dt = this.settings.step;
    const gravity = this.settings.gravity;

    for (const b of this.bodies) {
      if (b.mass <= 0 || b.sleeping) continue;
      b.velocity = b.velocity.add(gravity.scale(dt));
      // A touch of drag, so a body that is only ever nudged sideways does
      // eventually stop rather than sliding for the whole bake.
      b.velocity = b.velocity.scale(1 - 0.002);
      b.angularVelocity = b.angularVelocity.scale(1 - 0.02);
    }

    const contacts = this.findContacts();
    for (let i = 0; i < this.settings.iterations; i++) this.resolve(contacts);
    this.separate(contacts);

    for (const b of this.bodies) {
      if (b.mass <= 0 || b.sleeping) continue;
      b.position = b.position.add(b.velocity.scale(dt));
      b.rotation = b.rotation.add(b.angularVelocity.scale(dt));
    }

    this.updateSleep(contacts);
  }

  private findContacts(): Contact[] {
    const out: Contact[] = [];
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.bodies[i];
        const b = this.bodies[j];
        // Two immovable bodies can never resolve anything between them.
        if (a.mass <= 0 && b.mass <= 0) continue;
        if (a.sleeping && b.sleeping) continue;
        const reach = boundingRadius(a) + boundingRadius(b);
        if (a.position.sub(b.position).lengthSq() > reach * reach) continue;
        const c = collide(a, b);
        if (c) out.push(c);
      }
    }
    return out;
  }

  /**
   * One pass of impulse resolution.
   *
   * Called repeatedly: solving each contact in turn disturbs the ones already
   * solved, and iterating is what lets a stack converge on holding still
   * rather than shuffling every frame.
   */
  private resolve(contacts: Contact[]): void {
    for (const c of contacts) {
      const { a, b, normal } = c;
      const invA = a.mass > 0 ? 1 / a.mass : 0;
      const invB = b.mass > 0 ? 1 / b.mass : 0;
      const invSum = invA + invB;
      if (invSum <= 0) continue;
      if (a.sleeping && b.mass > 0) a.sleeping = false;
      if (b.sleeping && a.mass > 0) b.sleeping = false;

      const rel = b.velocity.sub(a.velocity);
      const along = rel.dot(normal);
      // Already separating: an impulse here would suck them back together.
      if (along > 0) continue;

      const e = Math.min(a.restitution, b.restitution);
      const jn = (-(1 + e) * along) / invSum;
      const impulse = normal.scale(jn);
      a.velocity = a.velocity.sub(impulse.scale(invA));
      b.velocity = b.velocity.add(impulse.scale(invB));

      // Friction, along whatever is left of the relative motion once the
      // normal component is taken out.
      const tangentVel = rel.sub(normal.scale(along));
      const tangentSpeed = tangentVel.length();
      if (tangentSpeed < 1e-6) continue;
      const tangent = tangentVel.scale(1 / tangentSpeed);
      const mu = Math.sqrt(a.friction * b.friction);
      // Coulomb: friction cannot exceed the normal impulse times mu, or it
      // would push a body backwards rather than just stopping it.
      const jt = Math.max(-mu * jn, Math.min(mu * jn, -tangentSpeed / invSum));
      const fImpulse = tangent.scale(jt);
      a.velocity = a.velocity.sub(fImpulse.scale(invA));
      b.velocity = b.velocity.add(fImpulse.scale(invB));

      // A glancing hit sets things spinning; enough to look alive, not enough
      // to pretend this integrates a real inertia tensor.
      const lever = c.point.sub(a.position).cross(fImpulse).scale(invA * 0.5);
      a.angularVelocity = a.angularVelocity.sub(lever);
      const leverB = c.point.sub(b.position).cross(fImpulse).scale(invB * 0.5);
      b.angularVelocity = b.angularVelocity.add(leverB);
    }
  }

  /**
   * Push overlapping bodies apart directly.
   *
   * Impulses alone leave a residual overlap that gravity keeps topping up, and
   * a stack slowly sinks into the floor. Correcting position separately, and
   * only beyond a small slop, fixes that without the jitter that correcting
   * every last micron would cause.
   */
  private separate(contacts: Contact[]): void {
    const slop = 0.001;
    const strength = 0.6;
    for (const c of contacts) {
      const invA = c.a.mass > 0 ? 1 / c.a.mass : 0;
      const invB = c.b.mass > 0 ? 1 / c.b.mass : 0;
      const invSum = invA + invB;
      if (invSum <= 0) continue;
      const push = (Math.max(0, c.depth - slop) / invSum) * strength;
      c.a.position = c.a.position.sub(c.normal.scale(push * invA));
      c.b.position = c.b.position.add(c.normal.scale(push * invB));
    }
  }

  /**
   * Let bodies that have stopped moving stop being simulated.
   *
   * Without this a bake never truly settles: a pile keeps trading tiny
   * impulses forever, and the keyframes record every one of them.
   */
  private updateSleep(contacts: Contact[]): void {
    const touching = new Set<RigidBody>();
    const overlapping = new Set<RigidBody>();
    for (const c of contacts) {
      touching.add(c.a);
      touching.add(c.b);
      // A pair still pushing through each other has not finished settling, and
      // letting them sleep freezes the overlap in place — the positional
      // correction is skipped for sleeping pairs, so nothing would ever
      // resolve it.
      if (c.depth > 0.005) {
        overlapping.add(c.a);
        overlapping.add(c.b);
      }
    }
    const limit = this.settings.sleepThreshold;
    for (const b of this.bodies) {
      if (b.mass <= 0) continue;
      const still = b.velocity.length() < limit && b.angularVelocity.length() < limit;
      // Only something resting on another body can sleep; a body still falling
      // through open air is slow at the top of its arc too.
      if (still && touching.has(b) && !overlapping.has(b)) {
        b.sleeping = true;
        b.velocity = new Vec3();
        b.angularVelocity = new Vec3();
      }
    }
  }

  /** Every body's current transform. */
  snapshot(): BodyState[] {
    return this.bodies.map((b) => ({
      objectId: b.objectId,
      position: [b.position.x, b.position.y, b.position.z] as [number, number, number],
      rotation: [b.rotation.x, b.rotation.y, b.rotation.z] as [number, number, number],
    }));
  }

  /** Run the whole simulation and record where everything was on each frame. */
  simulate(frames: number, fps: number): BodyState[][] {
    const out: BodyState[][] = [this.snapshot()];
    const stepsPerFrame = Math.max(1, Math.round(1 / (this.settings.step * fps)));
    for (let f = 1; f <= frames; f++) {
      for (let i = 0; i < stepsPerFrame; i++) this.step();
      out.push(this.snapshot());
    }
    return out;
  }
}

/** A body sized to fit an object's world-space bounds. */
export function bodyForBounds(
  objectId: number, min: Vec3, max: Vec3, shape: BodyShape, mass: number,
): RigidBody {
  const half = max.sub(min).scale(0.5);
  const centre = min.add(half);
  return createBody(objectId, {
    shape,
    // A sphere takes the largest half-extent, so it encloses the object rather
    // than cutting through it.
    halfExtents: shape === 'sphere'
      ? new Vec3(Math.max(half.x, half.y, half.z), 0, 0)
      : half,
    position: centre,
    mass,
  });
}

/** World-space axis-aligned bounds of a transformed local box. */
export function transformedBounds(min: Vec3, max: Vec3, m: Mat4): { min: Vec3; max: Vec3 } {
  let lo = new Vec3(Infinity, Infinity, Infinity);
  let hi = new Vec3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    const p = m.transformPoint(new Vec3(
      i & 1 ? max.x : min.x,
      i & 2 ? max.y : min.y,
      i & 4 ? max.z : min.z,
    ));
    lo = new Vec3(Math.min(lo.x, p.x), Math.min(lo.y, p.y), Math.min(lo.z, p.z));
    hi = new Vec3(Math.max(hi.x, p.x), Math.max(hi.y, p.y), Math.max(hi.z, p.z));
  }
  return { min: lo, max: hi };
}
