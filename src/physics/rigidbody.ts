import { Mat4, Quat, Vec3 } from '../core/math';

/**
 * Rigid body simulation.
 *
 * The point of this in a modelling application is not to be a game engine. It
 * is to answer "where would these land if I dropped them" without anyone
 * placing forty objects by hand — so the simulation runs, and then it is baked
 * to keyframes and forgotten about. Everything downstream sees animation, not
 * physics.
 *
 * Bodies are oriented boxes and spheres. Orientation is carried as a
 * quaternion and integrated with a real inertia tensor, because a crate that
 * lands on a corner has to tip over, and no amount of axis-aligned collision
 * detection will make it. Box contacts are found by the separating axis
 * theorem and turned into a manifold by clipping one face against the other:
 * a single contact point lets a resting box rock forever, and four points at
 * the corners of the overlap are what actually hold it still.
 *
 * Contacts are resolved by sequential impulses with a positional correction
 * pass. Iterating converges on a stack that holds still, which single-pass
 * resolution never does — a tower built that way jitters apart.
 */

export type BodyShape = 'box' | 'sphere';

export interface RigidBody {
  /** Scene object this drives. */
  objectId: number;
  shape: BodyShape;
  /** Half-extents for a box; x is the radius for a sphere. */
  halfExtents: Vec3;
  position: Vec3;
  orientation: Quat;
  velocity: Vec3;
  /** Radians per second, in world space. */
  angularVelocity: Vec3;
  /** Zero means immovable: a floor, a wall, a conveyor that never moves. */
  mass: number;
  /** 0 slides forever, 1 grips. */
  friction: number;
  /** 0 lands dead, 1 bounces back to the height it fell from. */
  restitution: number;
  /** A body at rest stops being integrated until something hits it. */
  sleeping: boolean;
  /** How long it has been slow enough to fall asleep. */
  restTime: number;
  /** Inverse inertia in the body's own frame; zero for an immovable body. */
  invInertiaLocal: Vec3;
}

export interface WorldSettings {
  gravity: Vec3;
  /**
   * Fixed timestep. Physics is not framerate-independent and pretending it is
   * makes results depend on the machine that ran it.
   */
  step: number;
  iterations: number;
  /** Speed below which a body starts counting towards falling asleep. */
  sleepThreshold: number;
  /** How long it must stay that slow, in seconds. */
  sleepDelay: number;
}

export function defaultWorld(): WorldSettings {
  return {
    gravity: new Vec3(0, 0, -9.81),
    step: 1 / 60,
    iterations: 10,
    sleepThreshold: 0.05,
    sleepDelay: 0.4,
  };
}

/**
 * Inverse inertia, per axis, in the body's own frame.
 *
 * Zero mass means immovable, and an immovable body must not spin either — an
 * infinite mass with a finite inertia would be a floor you could set rotating
 * by bumping it.
 */
function inverseInertia(shape: BodyShape, half: Vec3, mass: number): Vec3 {
  if (mass <= 0) return new Vec3(0, 0, 0);
  if (shape === 'sphere') {
    const r = Math.max(1e-4, half.x);
    const i = (2 / 5) * mass * r * r;
    return new Vec3(1 / i, 1 / i, 1 / i);
  }
  const w = Math.max(1e-4, half.x * 2);
  const h = Math.max(1e-4, half.y * 2);
  const d = Math.max(1e-4, half.z * 2);
  const k = mass / 12;
  return new Vec3(
    1 / (k * (h * h + d * d)),
    1 / (k * (w * w + d * d)),
    1 / (k * (w * w + h * h)),
  );
}

export function createBody(objectId: number, partial: Partial<RigidBody> = {}): RigidBody {
  const shape = partial.shape ?? 'box';
  const halfExtents = partial.halfExtents ?? new Vec3(0.5, 0.5, 0.5);
  const mass = partial.mass ?? 1;
  return {
    objectId,
    shape,
    halfExtents,
    position: partial.position ?? new Vec3(),
    orientation: partial.orientation ?? Quat.identity(),
    velocity: partial.velocity ?? new Vec3(),
    angularVelocity: partial.angularVelocity ?? new Vec3(),
    mass,
    friction: partial.friction ?? 0.5,
    restitution: partial.restitution ?? 0.1,
    sleeping: false,
    restTime: 0,
    invInertiaLocal: partial.invInertiaLocal ?? inverseInertia(shape, halfExtents, mass),
  };
}

/** Recompute the inertia after a change of shape, size or mass. */
export function refreshInertia(b: RigidBody): void {
  b.invInertiaLocal = inverseInertia(b.shape, b.halfExtents, b.mass);
}

/** World-space inverse inertia tensor, as R·I⁻¹·Rᵀ applied to a vector. */
function applyInvInertia(b: RigidBody, v: Vec3): Vec3 {
  const inv = b.orientation.conjugate();
  const local = inv.rotate(v);
  const scaled = new Vec3(
    local.x * b.invInertiaLocal.x,
    local.y * b.invInertiaLocal.y,
    local.z * b.invInertiaLocal.z,
  );
  return b.orientation.rotate(scaled);
}

interface Contact {
  a: RigidBody;
  b: RigidBody;
  /** Unit normal, pointing from a towards b. */
  normal: Vec3;
  /** How far they overlap along the normal. */
  depth: number;
  /** Contact points, in world space. Up to four for a face-on box pair. */
  points: Vec3[];
  /** Accumulated normal impulse per point, kept across iterations. */
  impulse: number[];
  /**
   * The normal velocity each point is being solved *towards*, worked out once
   * from the approach speed before any impulse is applied.
   *
   * This has to be precomputed. Recomputing it inside the iteration loop is
   * the subtle way to lose restitution entirely: the first pass gives the body
   * its bounce, the second sees a separating contact, aims for zero, and takes
   * the bounce straight back off again.
   */
  bias: number[];
  /** Effective mass along the normal, per point. */
  massN: number[];
}

/** The radius of the sphere that encloses a body, for broad-phase rejection. */
function boundingRadius(b: RigidBody): number {
  return b.shape === 'sphere' ? b.halfExtents.x : b.halfExtents.length();
}

function sphereSphere(a: RigidBody, b: RigidBody): Contact | null {
  const d = b.position.sub(a.position);
  const dist = d.length();
  const sum = a.halfExtents.x + b.halfExtents.x;
  if (dist >= sum) return null;
  const normal = dist > 1e-9 ? d.scale(1 / dist) : new Vec3(0, 0, 1);
  return {
    a, b, normal,
    depth: sum - dist,
    points: [a.position.add(normal.scale(a.halfExtents.x - (sum - dist) * 0.5))],
    impulse: [0],
    bias: [0],
    massN: [0],
  };
}

/** Sphere against an oriented box, worked in the box's own frame. */
function sphereBox(sphere: RigidBody, box: RigidBody): Contact | null {
  const r = sphere.halfExtents.x;
  const inv = box.orientation.conjugate();
  const rel = inv.rotate(sphere.position.sub(box.position));
  const h = box.halfExtents;
  const closest = new Vec3(
    Math.max(-h.x, Math.min(h.x, rel.x)),
    Math.max(-h.y, Math.min(h.y, rel.y)),
    Math.max(-h.z, Math.min(h.z, rel.z)),
  );
  const delta = rel.sub(closest);
  const dist = delta.length();
  if (dist >= r) return null;
  let localNormal: Vec3;
  if (dist > 1e-9) {
    // Points from the sphere towards the box, which is a → b.
    localNormal = delta.scale(-1 / dist);
  } else {
    // The centre is inside; there is no direction, so use the nearest face.
    const gaps = [h.x - Math.abs(rel.x), h.y - Math.abs(rel.y), h.z - Math.abs(rel.z)];
    const axis = gaps.indexOf(Math.min(...gaps));
    const sign = Math.sign([rel.x, rel.y, rel.z][axis]) || 1;
    localNormal = Vec3.axis(axis).scale(-sign);
  }
  return {
    a: sphere,
    b: box,
    normal: box.orientation.rotate(localNormal),
    depth: r - dist,
    points: [box.position.add(box.orientation.rotate(closest))],
    impulse: [0],
    bias: [0],
    massN: [0],
  };
}

// ------------------------------------------------------------ box vs box

interface AxisTest {
  depth: number;
  axis: Vec3;
  /** 0-2 a face axis, 3-5 b face axis, 6+ an edge cross product. */
  index: number;
}

/** Half the box's extent when measured along `axis`. */
function projectRadius(b: RigidBody, axes: [Vec3, Vec3, Vec3], axis: Vec3): number {
  return Math.abs(axes[0].dot(axis)) * b.halfExtents.x
    + Math.abs(axes[1].dot(axis)) * b.halfExtents.y
    + Math.abs(axes[2].dot(axis)) * b.halfExtents.z;
}

/**
 * Separating axis test for two oriented boxes.
 *
 * Fifteen axes: three faces each and the nine edge-pair cross products. If any
 * of them separates the boxes they do not touch; otherwise the one they
 * overlap least along is the way out. Face axes are given a slight preference
 * over edge axes, because an edge-edge answer that is a hair shallower than a
 * face answer produces a contact along a line, and a box resting flat on a
 * floor would then be held up by one edge and rock.
 */
function boxBox(a: RigidBody, b: RigidBody): Contact | null {
  const axesA = a.orientation.basis();
  const axesB = b.orientation.basis();
  const toB = b.position.sub(a.position);

  let best: AxisTest | null = null;
  const consider = (rawAxis: Vec3, index: number, bias = 1): boolean => {
    const len = rawAxis.length();
    // Parallel edges give a zero-length cross product, which is not an axis;
    // the face tests already cover that configuration.
    if (len < 1e-6) return true;
    const axis = rawAxis.scale(1 / len);
    const overlap = projectRadius(a, axesA, axis) + projectRadius(b, axesB, axis)
      - Math.abs(toB.dot(axis));
    if (overlap <= 0) return false;
    const scored = overlap * bias;
    if (!best || scored < best.depth) {
      best = { depth: scored, axis: toB.dot(axis) < 0 ? axis.neg() : axis, index };
    }
    return true;
  };

  for (let i = 0; i < 3; i++) if (!consider(axesA[i], i)) return null;
  for (let i = 0; i < 3; i++) if (!consider(axesB[i], 3 + i)) return null;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      // The 1.03 makes an edge axis have to win by a clear margin.
      if (!consider(axesA[i].cross(axesB[j]), 6 + i * 3 + j, 1.03)) return null;
    }
  }
  if (!best) return null;
  const hit = best as AxisTest;

  // Recover the true depth: the bias was only for choosing between axes.
  const depth = projectRadius(a, axesA, hit.axis) + projectRadius(b, axesB, hit.axis)
    - Math.abs(toB.dot(hit.axis));

  if (hit.index >= 6) {
    // Edge against edge touches at a point, so there is nothing to clip.
    const point = edgeContact(a, axesA, b, axesB, hit.axis);
    return { a, b, normal: hit.axis, depth, points: [point], impulse: [0], bias: [0], massN: [0] };
  }

  // Face contact: clip the other box's most-facing face against this one.
  const aIsReference = hit.index < 3;
  const ref = aIsReference ? a : b;
  const inc = aIsReference ? b : a;
  const refAxes = aIsReference ? axesA : axesB;
  const incAxes = aIsReference ? axesB : axesA;
  const refNormal = aIsReference ? hit.axis : hit.axis.neg();
  const points = clipFaces(ref, refAxes, refNormal, inc, incAxes, depth);
  const fallback = points.length === 0 ? [a.position.add(toB.scale(0.5))] : points;
  return {
    a, b, normal: hit.axis, depth, points: fallback,
    impulse: fallback.map(() => 0),
    bias: fallback.map(() => 0),
    massN: fallback.map(() => 0),
  };
}

/** The corner of `b` furthest along `-axis`, which is where an edge pair meets. */
function edgeContact(
  a: RigidBody, axesA: [Vec3, Vec3, Vec3], b: RigidBody, axesB: [Vec3, Vec3, Vec3], axis: Vec3,
): Vec3 {
  const support = (body: RigidBody, axes: [Vec3, Vec3, Vec3], dir: Vec3): Vec3 => {
    let p = body.position.clone();
    const h = [body.halfExtents.x, body.halfExtents.y, body.halfExtents.z];
    for (let i = 0; i < 3; i++) {
      p = p.add(axes[i].scale(axes[i].dot(dir) >= 0 ? h[i] : -h[i]));
    }
    return p;
  };
  // Halfway between the deepest point of each, which is where the edges cross
  // to within the precision anything downstream cares about.
  return support(a, axesA, axis).add(support(b, axesB, axis.neg())).scale(0.5);
}

/**
 * Clip the incident box's face against the reference box's face, and keep the
 * corners that end up inside and below the surface.
 *
 * This is what turns "these two boxes overlap by 3mm along +Z" into the up-to
 * four points a resting box actually stands on. Without it a crate on a floor
 * has one contact and rocks about it indefinitely.
 */
function clipFaces(
  ref: RigidBody, refAxes: [Vec3, Vec3, Vec3], refNormal: Vec3,
  inc: RigidBody, incAxes: [Vec3, Vec3, Vec3], depth: number,
): Vec3[] {
  const refH = [ref.halfExtents.x, ref.halfExtents.y, ref.halfExtents.z];
  const incH = [inc.halfExtents.x, inc.halfExtents.y, inc.halfExtents.z];

  // The incident face is the one most opposed to the reference normal.
  let incAxis = 0;
  let incSign = 1;
  let bestDot = Infinity;
  for (let i = 0; i < 3; i++) {
    for (const sign of [1, -1]) {
      const d = incAxes[i].scale(sign).dot(refNormal);
      if (d < bestDot) {
        bestDot = d;
        incAxis = i;
        incSign = sign;
      }
    }
  }
  const incNormal = incAxes[incAxis].scale(incSign);
  const incCentre = inc.position.add(incNormal.scale(incH[incAxis]));
  const [u, v] = [(incAxis + 1) % 3, (incAxis + 2) % 3];
  let poly = [
    incCentre.add(incAxes[u].scale(incH[u])).add(incAxes[v].scale(incH[v])),
    incCentre.add(incAxes[u].scale(incH[u])).sub(incAxes[v].scale(incH[v])),
    incCentre.sub(incAxes[u].scale(incH[u])).sub(incAxes[v].scale(incH[v])),
    incCentre.sub(incAxes[u].scale(incH[u])).add(incAxes[v].scale(incH[v])),
  ];

  // Which reference axis the normal is, so its two side planes can be found.
  let refAxis = 0;
  let refBest = -Infinity;
  for (let i = 0; i < 3; i++) {
    const d = Math.abs(refAxes[i].dot(refNormal));
    if (d > refBest) {
      refBest = d;
      refAxis = i;
    }
  }
  for (const side of [(refAxis + 1) % 3, (refAxis + 2) % 3]) {
    for (const sign of [1, -1]) {
      const planeN = refAxes[side].scale(sign);
      const planeD = planeN.dot(ref.position) + refH[side];
      poly = clipAgainstPlane(poly, planeN, planeD);
      if (poly.length === 0) return [];
    }
  }

  // Keep only the corners that are actually below the reference face, and put
  // each one halfway into the overlap so the contact sits between the two
  // surfaces rather than on one of them.
  const faceD = refNormal.dot(ref.position) + refH[refAxis];
  const out: Vec3[] = [];
  for (const p of poly) {
    const sep = refNormal.dot(p) - faceD;
    if (sep > 1e-4) continue;
    out.push(p.sub(refNormal.scale(sep * 0.5)));
  }
  // A shallow contact can clip to more points than are useful; four is what a
  // face pair can produce and more than that is duplicates.
  return out.slice(0, 4).length > 0 ? out.slice(0, 4) : (depth > 0 ? poly.slice(0, 4) : []);
}

/** Sutherland–Hodgman clip of a polygon against the half-space n·p ≤ d. */
function clipAgainstPlane(poly: Vec3[], n: Vec3, d: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const dc = n.dot(cur) - d;
    const dn = n.dot(nxt) - d;
    if (dc <= 0) out.push(cur);
    if (dc * dn < 0) {
      const t = dc / (dc - dn);
      out.push(cur.add(nxt.sub(cur).scale(t)));
    }
  }
  return out;
}

function collide(a: RigidBody, b: RigidBody): Contact | null {
  if (a.shape === 'sphere' && b.shape === 'sphere') return sphereSphere(a, b);
  if (a.shape === 'box' && b.shape === 'box') return boxBox(a, b);
  if (a.shape === 'sphere') return sphereBox(a, b);
  const flipped = sphereBox(b, a);
  if (!flipped) return null;
  return {
    a, b,
    normal: flipped.normal.neg(),
    depth: flipped.depth,
    points: flipped.points,
    impulse: flipped.impulse,
    bias: flipped.bias,
    massN: flipped.massN,
  };
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
    for (const b of this.bodies) {
      b.sleeping = false;
      b.restTime = 0;
    }
  }

  /** Advance by exactly one fixed step. */
  step(): void {
    const dt = this.settings.step;
    const gravity = this.settings.gravity;

    for (const b of this.bodies) {
      if (b.mass <= 0 || b.sleeping) continue;
      b.velocity = b.velocity.add(gravity.scale(dt));
      // A touch of drag, so a body that is only ever nudged does eventually
      // stop rather than sliding for the whole bake. Kept small and equal on
      // both: a heavier hand on the angular term looks like settling and is
      // actually a thrown object losing its spin in mid-air.
      b.velocity = b.velocity.scale(1 - 0.002);
      b.angularVelocity = b.angularVelocity.scale(1 - 0.002);
    }

    const contacts = this.findContacts();
    this.prepare(contacts);
    for (let i = 0; i < this.settings.iterations; i++) this.resolve(contacts);
    this.separate(contacts);

    for (const b of this.bodies) {
      if (b.mass <= 0 || b.sleeping) continue;
      b.position = b.position.add(b.velocity.scale(dt));
      b.orientation = b.orientation.integrate(b.angularVelocity, dt);
    }

    this.updateSleep(contacts, dt);
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
   * Work out, once per step, what each contact point is solving for.
   *
   * Two things have to be settled before any impulse is applied. The effective
   * mass, which depends on where the point is relative to each centre and
   * therefore on how much each body can rotate out of the way. And the
   * restitution target — the velocity the point should end up separating at —
   * which must come from the approach speed *before* anything is done about
   * it, or the bounce is given on the first iteration and taken back on the
   * second.
   */
  private prepare(contacts: Contact[]): void {
    for (const c of contacts) {
      const { a, b, normal } = c;
      const invA = a.mass > 0 ? 1 / a.mass : 0;
      const invB = b.mass > 0 ? 1 / b.mass : 0;
      const e = Math.min(a.restitution, b.restitution);
      for (let i = 0; i < c.points.length; i++) {
        const p = c.points[i];
        const ra = p.sub(a.position);
        const rb = p.sub(b.position);
        const angA = applyInvInertia(a, ra.cross(normal)).cross(ra);
        const angB = applyInvInertia(b, rb.cross(normal)).cross(rb);
        const k = invA + invB + angA.add(angB).dot(normal);
        c.massN[i] = k > 1e-9 ? 1 / k : 0;
        c.impulse[i] = 0;

        const va = a.velocity.add(a.angularVelocity.cross(ra));
        const vb = b.velocity.add(b.angularVelocity.cross(rb));
        const along = vb.sub(va).dot(normal);
        // Only a real impact bounces. Applying restitution to the fraction of
        // a millimetre per second a resting stack settles at is what makes one
        // hum instead of holding still.
        c.bias[i] = along < -1 ? -e * along : 0;
      }
    }
  }

  /**
   * One pass of impulse resolution, over every point of every manifold.
   *
   * Called repeatedly: solving each point disturbs the ones already solved,
   * and iterating is what lets a stack converge on holding still rather than
   * shuffling every frame. Each point is solved in full rather than given a
   * share of the total — the next point sees the velocity the previous one
   * left behind, so the manifold distributes the load by itself.
   *
   * The normal impulse is accumulated and clamped at zero *in total* rather
   * than per iteration. A later pass can then take back some of an earlier
   * one's push, which is what lets an over-corrected corner relax, without any
   * single pass ever being able to pull the two bodies together.
   */
  private resolve(contacts: Contact[]): void {
    for (const c of contacts) {
      const { a, b, normal } = c;
      const invA = a.mass > 0 ? 1 / a.mass : 0;
      const invB = b.mass > 0 ? 1 / b.mass : 0;
      if (invA + invB <= 0) continue;
      if (a.sleeping && b.mass > 0) {
        a.sleeping = false;
        a.restTime = 0;
      }
      if (b.sleeping && a.mass > 0) {
        b.sleeping = false;
        b.restTime = 0;
      }
      const mu = Math.sqrt(a.friction * b.friction);

      for (let i = 0; i < c.points.length; i++) {
        if (c.massN[i] <= 0) continue;
        const p = c.points[i];
        const ra = p.sub(a.position);
        const rb = p.sub(b.position);
        const va = a.velocity.add(a.angularVelocity.cross(ra));
        const vb = b.velocity.add(b.angularVelocity.cross(rb));
        const along = vb.sub(va).dot(normal);

        let jn = (c.bias[i] - along) * c.massN[i];
        const total = Math.max(0, c.impulse[i] + jn);
        jn = total - c.impulse[i];
        c.impulse[i] = total;
        if (jn !== 0) {
          const impulse = normal.scale(jn);
          a.velocity = a.velocity.sub(impulse.scale(invA));
          b.velocity = b.velocity.add(impulse.scale(invB));
          a.angularVelocity = a.angularVelocity.sub(applyInvInertia(a, ra.cross(impulse)));
          b.angularVelocity = b.angularVelocity.add(applyInvInertia(b, rb.cross(impulse)));
        }

        // Friction, along whatever is left of the relative motion once the
        // normal component is taken out.
        const va2 = a.velocity.add(a.angularVelocity.cross(ra));
        const vb2 = b.velocity.add(b.angularVelocity.cross(rb));
        const relT = vb2.sub(va2);
        const tangential = relT.sub(normal.scale(relT.dot(normal)));
        const speed = tangential.length();
        if (speed < 1e-7) continue;
        const tangent = tangential.scale(1 / speed);
        const tA = applyInvInertia(a, ra.cross(tangent)).cross(ra);
        const tB = applyInvInertia(b, rb.cross(tangent)).cross(rb);
        const kT = invA + invB + tA.add(tB).dot(tangent);
        if (kT <= 1e-9) continue;
        // Coulomb: friction can stop sliding but never reverse it.
        const limit = mu * c.impulse[i];
        const jt = Math.max(-limit, Math.min(limit, -speed / kT));
        const fImpulse = tangent.scale(jt);
        a.velocity = a.velocity.sub(fImpulse.scale(invA));
        b.velocity = b.velocity.add(fImpulse.scale(invB));
        a.angularVelocity = a.angularVelocity.sub(applyInvInertia(a, ra.cross(fImpulse)));
        b.angularVelocity = b.angularVelocity.add(applyInvInertia(b, rb.cross(fImpulse)));
      }
    }
  }

  /**
   * Push overlapping bodies apart directly.
   *
   * Impulses alone leave a residual overlap that gravity keeps topping up, and
   * a stack slowly sinks into the floor. Correcting position separately, and
   * only beyond a small slop, fixes that without the jitter that correcting
   * every last micron would cause. Position only, never orientation: rotating
   * a body to fix an overlap moves its other contacts and starts a fight.
   */
  private separate(contacts: Contact[]): void {
    const slop = 0.001;
    const strength = 0.4;
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
   * impulses forever, and the keyframes record every one of them. A body has
   * to be slow for a while rather than slow for one step, because the top of
   * a bounce is slow too.
   */
  private updateSleep(contacts: Contact[], dt: number): void {
    const touching = new Set<RigidBody>();
    const overlapping = new Set<RigidBody>();
    for (const c of contacts) {
      touching.add(c.a);
      touching.add(c.b);
      // A pair still pushing through each other has not finished settling, and
      // letting them sleep freezes the overlap in place — the positional
      // correction is skipped for sleeping pairs, so nothing would resolve it.
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
      if (!still || !touching.has(b) || overlapping.has(b)) {
        b.restTime = 0;
        continue;
      }
      b.restTime += dt;
      if (b.restTime >= this.settings.sleepDelay) {
        b.sleeping = true;
        b.velocity = new Vec3();
        b.angularVelocity = new Vec3();
      }
    }
  }

  /** Every body's current transform. */
  snapshot(): BodyState[] {
    return this.bodies.map((b) => {
      const e = b.orientation.toEuler();
      return {
        objectId: b.objectId,
        position: [b.position.x, b.position.y, b.position.z] as [number, number, number],
        rotation: [e.x, e.y, e.z] as [number, number, number],
      };
    });
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

/**
 * A body sized to fit an object's local bounds, carrying its rotation.
 *
 * Local rather than world bounds, because the body is oriented: measuring the
 * axis-aligned extent of a rotated object would give a box larger than the
 * object and then rotate that.
 */
export function bodyForBounds(
  objectId: number, min: Vec3, max: Vec3, shape: BodyShape, mass: number,
  orientation: Quat = Quat.identity(), scale: Vec3 = new Vec3(1, 1, 1),
): RigidBody {
  const half = max.sub(min).scale(0.5).mul(new Vec3(
    Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z),
  ));
  const localCentre = min.add(max.sub(min).scale(0.5));
  return createBody(objectId, {
    shape,
    // A sphere takes the largest half-extent, so it encloses the object rather
    // than cutting through it.
    halfExtents: shape === 'sphere'
      ? new Vec3(Math.max(half.x, half.y, half.z), 0, 0)
      : half,
    position: localCentre,
    orientation,
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
