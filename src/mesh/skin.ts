import { Mat4, Vec3, closestPointOnSegment } from '../core/math';
import { Mesh } from './Mesh';
import { ArmatureData, boneEnvelope, boneHead, boneTail, poseMatrices } from '../anim/armature';

/**
 * Skinning.
 *
 * Every vertex is tied to a handful of bones with a weight each, and deforming
 * is a weighted blend of what those bones did. Four influences per vertex is
 * the number everything else settled on and for the same reason: a fifth is
 * almost never visible, and a fixed stride keeps the whole thing in two flat
 * arrays instead of an array of arrays.
 *
 * Weights are stored on the mesh rather than on the armature, because they
 * belong to the geometry: subdividing a character has to carry them, and
 * swapping the rig underneath should not throw them away.
 */

/** Bone influences per vertex. */
export const MAX_INFLUENCES = 4;

export interface SkinData {
  /** `MAX_INFLUENCES` bone indices per vertex; -1 for an unused slot. */
  bones: Int32Array;
  /** Matching weights, normalised to sum to 1 where any bone is bound. */
  weights: Float32Array;
}

export function createSkin(vertexCount: number): SkinData {
  return {
    bones: new Int32Array(vertexCount * MAX_INFLUENCES).fill(-1),
    weights: new Float32Array(vertexCount * MAX_INFLUENCES),
  };
}

export function cloneSkin(s: SkinData): SkinData {
  return { bones: s.bones.slice(), weights: s.weights.slice() };
}

/** Grow or shrink a skin to match a vertex count, keeping what it can. */
export function resizeSkin(s: SkinData, vertexCount: number): SkinData {
  const next = createSkin(vertexCount);
  const n = Math.min(s.bones.length, next.bones.length);
  next.bones.set(s.bones.subarray(0, n));
  next.weights.set(s.weights.subarray(0, n));
  return next;
}

/** The weight a vertex gives one bone. */
export function weightOf(skin: SkinData, vertex: number, bone: number): number {
  const o = vertex * MAX_INFLUENCES;
  for (let i = 0; i < MAX_INFLUENCES; i++) {
    if (skin.bones[o + i] === bone) return skin.weights[o + i];
  }
  return 0;
}

/**
 * Set one vertex's weight for one bone, keeping the total at 1.
 *
 * Renormalising here rather than in a pass afterwards is what stops a paint
 * stroke from quietly inflating a vertex past full weight — the sum is the
 * invariant everything downstream relies on, so it is maintained at the point
 * of change.
 */
export function setWeight(skin: SkinData, vertex: number, bone: number, weight: number): void {
  const o = vertex * MAX_INFLUENCES;
  const w = Math.max(0, Math.min(1, weight));
  let slot = -1;
  for (let i = 0; i < MAX_INFLUENCES; i++) {
    if (skin.bones[o + i] === bone) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    if (w <= 0) return;
    // Take a free slot, or evict the weakest influence — which is exactly what
    // a fixed influence count means in practice.
    let weakest = 0;
    for (let i = 0; i < MAX_INFLUENCES; i++) {
      if (skin.bones[o + i] < 0) {
        weakest = i;
        break;
      }
      if (skin.weights[o + i] < skin.weights[o + weakest]) weakest = i;
    }
    slot = weakest;
    skin.bones[o + slot] = bone;
  }
  skin.weights[o + slot] = w;
  if (w <= 0) skin.bones[o + slot] = -1;
  normaliseVertex(skin, vertex);
}

function normaliseVertex(skin: SkinData, vertex: number): void {
  const o = vertex * MAX_INFLUENCES;
  let sum = 0;
  for (let i = 0; i < MAX_INFLUENCES; i++) {
    if (skin.bones[o + i] < 0) skin.weights[o + i] = 0;
    sum += skin.weights[o + i];
  }
  if (sum <= 1e-9) return;
  for (let i = 0; i < MAX_INFLUENCES; i++) skin.weights[o + i] /= sum;
}

/** Normalise every vertex; use after a bulk edit. */
export function normaliseSkin(skin: SkinData, vertexCount: number): void {
  for (let v = 0; v < vertexCount; v++) normaliseVertex(skin, v);
}

/**
 * Weights from bone envelopes.
 *
 * Proper heat-diffusion weighting solves a system over the whole surface and
 * gives better results around joints, but it needs the mesh to be a clean
 * closed manifold and it fails opaquely when it is not. Distance to the bone
 * segment always produces something, and something predictable: influence
 * falls off smoothly to nothing at the envelope's edge, so a vertex near two
 * bones blends and one near a single bone follows it exactly.
 *
 * `toArmature` brings mesh-space positions into armature space, since the two
 * objects rarely share a transform.
 */
export function envelopeWeights(
  mesh: Mesh, armature: ArmatureData, toArmature: Mat4 = new Mat4(),
): SkinData {
  const skin = createSkin(mesh.positions.length);
  const bones = armature.bones;
  if (bones.length === 0) return skin;

  const heads = bones.map(boneHead);
  const tails = bones.map(boneTail);
  const radii = bones.map(boneEnvelope);
  const scratch: { bone: number; w: number }[] = [];

  for (let v = 0; v < mesh.positions.length; v++) {
    const p = toArmature.transformPoint(mesh.positions[v]);
    scratch.length = 0;
    for (let b = 0; b < bones.length; b++) {
      const d = closestPointOnSegment(p, heads[b], tails[b]).distanceTo(p);
      const r = radii[b];
      if (d >= r) continue;
      // Smooth falloff, and an inverse-square core so a vertex sitting on a
      // bone follows that bone rather than averaging with its neighbours.
      const t = 1 - d / r;
      scratch.push({ bone: b, w: t * t * t + 1e-4 });
    }
    if (scratch.length === 0) {
      // Outside every envelope: bind to the nearest bone so the vertex still
      // travels with the rig instead of being left behind in space.
      let best = 0;
      let bestD = Infinity;
      for (let b = 0; b < bones.length; b++) {
        const d = closestPointOnSegment(p, heads[b], tails[b]).distanceTo(p);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      scratch.push({ bone: best, w: 1 });
    }
    scratch.sort((a, b) => b.w - a.w);
    const o = v * MAX_INFLUENCES;
    let sum = 0;
    for (let i = 0; i < MAX_INFLUENCES && i < scratch.length; i++) sum += scratch[i].w;
    for (let i = 0; i < MAX_INFLUENCES; i++) {
      if (i < scratch.length) {
        skin.bones[o + i] = scratch[i].bone;
        skin.weights[o + i] = scratch[i].w / sum;
      } else {
        skin.bones[o + i] = -1;
        skin.weights[o + i] = 0;
      }
    }
  }
  return skin;
}

/**
 * Deform a mesh by an armature's current pose.
 *
 * Linear blend skinning: each vertex is transformed by every bone that claims
 * it and the results are mixed by weight. It pinches at a sharply bent joint —
 * that is inherent to blending matrices rather than rotations — but it is what
 * every real-time pipeline does, and it costs one matrix multiply per
 * influence.
 */
export function applySkin(
  mesh: Mesh, armature: ArmatureData, skin: SkinData,
  meshToArmature: Mat4 = new Mat4(), armatureToMesh: Mat4 = new Mat4(),
): Mesh {
  const out = mesh.clone();
  const { rest, pose } = poseMatrices(armature);
  if (rest.length === 0) return out;
  // Precompute the whole chain per bone, so the inner loop is one transform.
  const full = rest.map((r, i) => armatureToMesh.multiply(pose[i]).multiply(r.inverse()).multiply(meshToArmature));

  for (let v = 0; v < out.positions.length; v++) {
    const o = v * MAX_INFLUENCES;
    const src = mesh.positions[v];
    let x = 0;
    let y = 0;
    let z = 0;
    let total = 0;
    for (let i = 0; i < MAX_INFLUENCES; i++) {
      const b = skin.bones[o + i];
      const w = skin.weights[o + i];
      if (b < 0 || b >= full.length || w <= 0) continue;
      const q = full[b].transformPoint(src);
      x += q.x * w;
      y += q.y * w;
      z += q.z * w;
      total += w;
    }
    // A vertex nothing claims stays exactly where it is rather than collapsing
    // to the origin, which is what dividing by a zero total would do.
    if (total > 1e-6) out.positions[v] = new Vec3(x / total, y / total, z / total);
  }
  out.markDirty();
  return out;
}

/** How many vertices give this bone any weight at all. */
export function boneVertexCount(skin: SkinData, bone: number, vertexCount: number): number {
  let n = 0;
  for (let v = 0; v < vertexCount; v++) if (weightOf(skin, v, bone) > 0) n++;
  return n;
}
