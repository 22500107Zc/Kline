import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArmatureData, boneEnvelope, clearPose, createArmature, createBone, poseMatrices,
  posedSegments, skinMatrices, sortBones,
} from '../src/anim/armature';
import { MAX_INFLUENCES, applySkin, createSkin, envelopeWeights, normaliseSkin, setWeight, weightOf } from '../src/mesh/skin';
import { buildPrimitive } from '../src/mesh/primitives';
import { Scene } from '../src/scene/Scene';
import { createModifier } from '../src/modifiers';
import { Mat4, Vec3 } from '../src/core/math';
import { Mesh } from '../src/mesh/Mesh';

/** A two-bone chain running up the Z axis, like an upper and lower arm. */
function chain(): ArmatureData {
  return {
    bones: [
      createBone({ name: 'upper', head: [0, 0, 0], tail: [0, 0, 1] }),
      createBone({ name: 'lower', parent: 0, head: [0, 0, 1], tail: [0, 0, 2] }),
    ],
  };
}

test('an unposed rig deforms nothing', () => {
  // The property that makes a rig safe to attach to a finished model.
  const a = chain();
  for (const m of skinMatrices(a)) {
    for (const p of [new Vec3(1, 2, 3), new Vec3(-4, 0.5, 2)]) {
      assert.ok(m.transformPoint(p).distanceTo(p) < 1e-9, 'the rest pose moved a point');
    }
  }
});

test('posing a bone moves its own tail and its children', () => {
  const a = chain();
  a.bones[0].rotation = [Math.PI / 2, 0, 0];
  const segs = posedSegments(a);
  // A quarter turn about the bone's own X takes the tail from along the bone
  // to square across it. Which perpendicular it lands on depends on the basis
  // roll is measured from, and that is not a promise worth making — what
  // matters is that it swung a right angle without changing length.
  assert.ok(Math.abs(segs[0].tail.z) < 1e-6, `tail should leave the Z axis, z was ${segs[0].tail.z}`);
  assert.ok(Math.abs(segs[0].tail.length() - 1) < 1e-6, 'the bone changed length');
  // And the child follows, ending two units out along the same direction.
  assert.ok(Math.abs(segs[1].tail.length() - 2) < 1e-6, `child tail at ${segs[1].tail.length()}`);
  assert.ok(segs[1].tail.normalized().distanceTo(segs[0].tail.normalized()) < 1e-6, 'the chain kinked');
});

test('a child bone posed alone leaves its parent where it was', () => {
  const a = chain();
  a.bones[1].rotation = [Math.PI / 2, 0, 0];
  const segs = posedSegments(a);
  assert.ok(segs[0].head.distanceTo(new Vec3(0, 0, 0)) < 1e-9);
  assert.ok(segs[0].tail.distanceTo(new Vec3(0, 0, 1)) < 1e-9, 'the parent moved');
  assert.ok(segs[1].head.distanceTo(new Vec3(0, 0, 1)) < 1e-9, 'the joint came apart');
  assert.ok(segs[1].tail.distanceTo(new Vec3(0, 0, 1)) > 0.5, 'the child did not move');
});

test('clearing a pose puts everything back', () => {
  const a = chain();
  a.bones[0].rotation = [0.4, 0.2, -0.7];
  a.bones[1].position = [1, 2, 3];
  clearPose(a);
  const segs = posedSegments(a);
  assert.ok(segs[0].tail.distanceTo(new Vec3(0, 0, 1)) < 1e-9);
  assert.ok(segs[1].tail.distanceTo(new Vec3(0, 0, 2)) < 1e-9);
});

test('bones sort parents-first and keep their links', () => {
  // Deliberately out of order: a child at index 0.
  const a: ArmatureData = {
    bones: [
      createBone({ name: 'child', parent: 1 }),
      createBone({ name: 'root', parent: -1 }),
      createBone({ name: 'grandchild', parent: 0 }),
    ],
  };
  sortBones(a);
  assert.deepEqual(a.bones.map((b) => b.name), ['root', 'child', 'grandchild']);
  assert.equal(a.bones[0].parent, -1);
  assert.equal(a.bones[1].parent, 0);
  assert.equal(a.bones[2].parent, 1);
});

test('a parent cycle is broken rather than hung on', () => {
  const a: ArmatureData = {
    bones: [createBone({ name: 'a', parent: 1 }), createBone({ name: 'b', parent: 0 })],
  };
  sortBones(a);
  assert.equal(a.bones.length, 2, 'a bone went missing');
  assert.ok(a.bones.some((b) => b.parent === -1), 'the cycle was left in place');
  // And it still evaluates.
  assert.equal(poseMatrices(a).pose.length, 2);
});

test('weights sum to one and respect the influence limit', () => {
  const skin = createSkin(3);
  // More bones than a vertex can hold. The sum staying at one is the invariant
  // everything downstream relies on; which bones survive depends on the order
  // they were painted in, and deliberately so — each stroke renormalises, so
  // the newest paint wins, which is what painting should do.
  for (let b = 0; b < 6; b++) setWeight(skin, 0, b, 1 - b * 0.1);
  let sum = 0;
  let used = 0;
  for (let i = 0; i < MAX_INFLUENCES; i++) {
    sum += skin.weights[i];
    if (skin.bones[i] >= 0) used++;
  }
  assert.ok(Math.abs(sum - 1) < 1e-6, `weights summed to ${sum}`);
  assert.ok(used <= MAX_INFLUENCES, `${used} influences on one vertex`);
  assert.ok(used > 0, 'the vertex ended up bound to nothing');
});

test('setting a weight to zero drops the influence', () => {
  const skin = createSkin(1);
  setWeight(skin, 0, 2, 1);
  setWeight(skin, 0, 5, 1);
  assert.ok(weightOf(skin, 0, 2) > 0 && weightOf(skin, 0, 5) > 0);
  setWeight(skin, 0, 2, 0);
  assert.equal(weightOf(skin, 0, 2), 0);
  assert.ok(Math.abs(weightOf(skin, 0, 5) - 1) < 1e-6, 'the remaining bone was not renormalised');
});

test('automatic weights bind every vertex to something', () => {
  const cyl = buildPrimitive('cylinder');
  const a = chain();
  const skin = envelopeWeights(cyl, a);
  for (let v = 0; v < cyl.vertCount; v++) {
    let sum = 0;
    for (let i = 0; i < MAX_INFLUENCES; i++) sum += skin.weights[v * MAX_INFLUENCES + i];
    assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${v} summed to ${sum}`);
  }
});

test('automatic weights follow the nearest bone', () => {
  const mesh = new Mesh(
    [new Vec3(0, 0, 0.1), new Vec3(0, 0, 1.9)],
    [],
  );
  const skin = envelopeWeights(mesh, chain());
  assert.ok(weightOf(skin, 0, 0) > weightOf(skin, 0, 1), 'the low vertex should follow the upper bone');
  assert.ok(weightOf(skin, 1, 1) > weightOf(skin, 1, 0), 'the high vertex should follow the lower bone');
});

test('skinning moves weighted geometry and leaves the rest', () => {
  const mesh = new Mesh([new Vec3(0, 0, 2), new Vec3(5, 5, 5)], []);
  const skin = createSkin(2);
  setWeight(skin, 0, 1, 1);
  // Vertex 1 is bound to nothing at all.
  const a = chain();
  a.bones[0].rotation = [Math.PI / 2, 0, 0];
  const out = applySkin(mesh, a, skin);
  assert.ok(out.positions[0].distanceTo(mesh.positions[0]) > 0.5, 'the weighted vertex did not move');
  assert.ok(out.positions[1].distanceTo(new Vec3(5, 5, 5)) < 1e-9, 'an unweighted vertex was dragged along');
});

test('an unposed rig leaves skinned geometry untouched', () => {
  const cyl = buildPrimitive('cylinder');
  const a = chain();
  const skin = envelopeWeights(cyl, a);
  const out = applySkin(cyl, a, skin);
  for (let i = 0; i < cyl.vertCount; i++) {
    assert.ok(out.positions[i].distanceTo(cyl.positions[i]) < 1e-6, `vertex ${i} drifted`);
  }
});

test('the armature modifier deforms through the scene', () => {
  const scene = new Scene();
  const rig = scene.add('armature', 'Rig');
  rig.armature = chain();
  const body = scene.add('mesh', 'Body', buildPrimitive('cylinder'));
  body.mesh!.skin = envelopeWeights(body.mesh!, rig.armature);
  const mod = createModifier('armature');
  if (mod.type === 'armature') mod.objectId = rig.id;
  body.modifiers.push(mod);

  const rest = body.evaluated(false)!;
  const restPositions = rest.positions.map((p) => p.clone());

  rig.armature.bones[0].rotation = [Math.PI / 2, 0, 0];
  body.invalidate();
  const posed = body.evaluated(false)!;
  assert.notEqual(posed, rest, 'the cache did not notice the pose change');
  assert.equal(posed.vertCount, restPositions.length, 'skinning changed the topology');
  let moved = 0;
  for (let i = 0; i < posed.vertCount; i++) {
    if (posed.positions[i].distanceTo(restPositions[i]) > 0.1) moved++;
  }
  assert.ok(moved > posed.vertCount * 0.5, `only ${moved} of ${posed.vertCount} vertices moved`);
});

test('the modifier is inert without weights or a rig', () => {
  const scene = new Scene();
  const body = scene.add('mesh', 'Body', buildPrimitive('cube'));
  const mod = createModifier('armature');
  body.modifiers.push(mod);
  const out = body.evaluated(false)!;
  assert.equal(out.vertCount, 8);
  assert.equal(out.bounds().max.x, 1);
});

test('a rig and its weights survive a save and load', () => {
  const scene = new Scene();
  const rig = scene.add('armature', 'Rig');
  rig.armature = chain();
  rig.armature.bones[1].rotation = [0.5, 0, 0];
  const body = scene.add('mesh', 'Body', buildPrimitive('cylinder'));
  body.mesh!.skin = envelopeWeights(body.mesh!, rig.armature);

  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const rig2 = [...back.objects.values()].find((o) => o.type === 'armature')!;
  const body2 = [...back.objects.values()].find((o) => o.type === 'mesh')!;
  assert.equal(rig2.armature?.bones.length, 2);
  assert.equal(rig2.armature?.bones[1].rotation[0], 0.5);
  assert.ok(body2.mesh?.skin, 'the weights were lost');
  assert.equal(body2.mesh!.skin!.weights.length, body.mesh!.skin!.weights.length);
});

test('an envelope falls back to the bone length when unset', () => {
  const b = createBone({ head: [0, 0, 0], tail: [0, 0, 4] });
  assert.equal(boneEnvelope(b), 2);
  b.envelope = 0.25;
  assert.equal(boneEnvelope(b), 0.25);
});

test('a fresh armature has one bone', () => {
  const a = createArmature();
  assert.equal(a.bones.length, 1);
  assert.equal(a.bones[0].parent, -1);
  normaliseSkin(createSkin(1), 1);
});

test('the mesh-to-armature transform is respected', () => {
  // A mesh offset from the rig must be weighted by where it sits in rig space,
  // not by its own local coordinates.
  const mesh = new Mesh([new Vec3(0, 0, 0.1)], []);
  const offset = Mat4.translation(new Vec3(0, 0, 1.8));
  const near = envelopeWeights(mesh, chain());
  const far = envelopeWeights(mesh, chain(), offset);
  assert.ok(weightOf(near, 0, 0) > weightOf(near, 0, 1));
  assert.ok(weightOf(far, 0, 1) > weightOf(far, 0, 0), 'the offset was ignored');
});
