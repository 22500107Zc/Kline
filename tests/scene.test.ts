import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG2RAD, Mat4, Vec3, decomposeMatrix } from '../src/core/math';
import { Scene } from '../src/scene/Scene';
import { createCube, createPlane } from '../src/mesh/primitives';
import { MODIFIER_LABELS, createModifier, evaluateStack, normaliseModifier } from '../src/modifiers';
import { hexToLinear, linearToHex } from '../src/scene/Material';

test('matrix decomposition round-trips through compose', () => {
  const position = new Vec3(1.5, -2, 0.25);
  const rotation = new Vec3(20 * DEG2RAD, -35 * DEG2RAD, 110 * DEG2RAD);
  const scale = new Vec3(2, 0.5, 1.25);
  const d = decomposeMatrix(Mat4.compose(position, rotation, scale));
  assert.ok(d.position.equals(position, 1e-5));
  assert.ok(d.scale.equals(scale, 1e-5));
  // Compare the rebuilt matrices rather than the euler triple, which is not unique.
  const a = Mat4.compose(position, rotation, scale).m;
  const b = Mat4.compose(d.position, d.rotation, d.scale).m;
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-4, `element ${i}`);
});

test('parenting composes world matrices and refuses cycles', () => {
  const s = new Scene();
  const parent = s.add('empty', 'Parent');
  const child = s.add('empty', 'Child');
  parent.position = new Vec3(0, 0, 5);
  child.position = new Vec3(2, 0, 0);
  s.setParent(child.id, parent.id);
  assert.ok(child.worldMatrix(s).transformPoint(new Vec3()).equals(new Vec3(2, 0, 5), 1e-6));

  s.setParent(parent.id, child.id); // would be a cycle
  assert.equal(parent.parent, null);
});

test('removing a parent removes its children', () => {
  const s = new Scene();
  const parent = s.add('mesh', 'Parent', createCube());
  const child = s.add('mesh', 'Child', createCube());
  s.setParent(child.id, parent.id);
  s.remove(parent.id);
  assert.equal(s.objects.size, 0);
});

test('object names stay unique', () => {
  const s = new Scene();
  const a = s.add('mesh', 'Cube', createCube());
  const b = s.add('mesh', 'Cube', createCube());
  const c = s.add('mesh', 'Cube', createCube());
  assert.deepEqual([a.name, b.name, c.name], ['Cube', 'Cube.001', 'Cube.002']);
});

test('mirror modifier doubles geometry and welds the seam', () => {
  const mesh = createCube();
  mesh.transform(Mat4.translation(new Vec3(1, 0, 0))); // sits against x = 0
  const mod = createModifier('mirror');
  const out = evaluateStack(mesh, [mod]);
  assert.equal(out.vertCount, 12, 'four seam vertices welded');
  // Like Blender, mirroring welds vertices but leaves the two touching faces in
  // place — removing interior geometry is the artist's call.
  assert.equal(out.faceCount, 12);
  assert.ok(out.bounds().min.x < -1.9 && out.bounds().max.x > 1.9);
});

test('array modifier repeats along the bounding box', () => {
  const mod = createModifier('array');
  if (mod.type !== 'array') throw new Error('wrong type');
  mod.count = 4;
  const out = evaluateStack(createCube(), [mod]);
  assert.equal(out.faceCount, 24);
  assert.ok(Math.abs(out.bounds().size().x - 8) < 1e-6);
});

test('solidify gives an open plane thickness and closes it', () => {
  const mod = createModifier('solidify');
  if (mod.type !== 'solidify') throw new Error('wrong type');
  mod.thickness = 0.2;
  const out = evaluateStack(createPlane(), [mod]);
  assert.equal(out.faceCount, 2 + 4, 'two shells plus a rim');
  assert.ok(out.topology().edges.every((e) => e.faces.length === 2), 'watertight');
  assert.ok(Math.abs(out.bounds().size().z - 0.2) < 1e-6);
});

test('disabled modifiers are skipped and edit-mode respects showInEdit', () => {
  const sub = createModifier('subsurf');
  const base = createCube();
  sub.enabled = false;
  assert.equal(evaluateStack(base, [sub]).faceCount, 6);
  sub.enabled = true;
  sub.showInEdit = false;
  assert.equal(evaluateStack(base, [sub], true).faceCount, 6, 'hidden in edit mode');
  assert.equal(evaluateStack(base, [sub], false).faceCount, 24);
});

test('the evaluated mesh is cached until geometry or the stack changes', () => {
  const s = new Scene();
  const obj = s.add('mesh', 'Cube', createCube());
  obj.modifiers.push(createModifier('subsurf'));
  const first = obj.evaluated();
  assert.equal(first, obj.evaluated(), 'cached');
  obj.mesh!.markDirty();
  assert.notEqual(first, obj.evaluated(), 'invalidated by a geometry change');
});

test('scene serialization round-trips objects, materials and hierarchy', () => {
  const s = new Scene();
  s.ensureDefaultMaterial();
  const parent = s.add('mesh', 'Cube', createCube());
  parent.modifiers.push(createModifier('subsurf'));
  const light = s.add('light', 'Light');
  light.position = new Vec3(1, 2, 3);
  s.setParent(light.id, parent.id);
  s.selection = new Set([parent.id]);
  s.active = parent.id;

  const back = Scene.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(back.objects.size, 2);
  const backParent = back.get(parent.id)!;
  assert.equal(backParent.modifiers.length, 1);
  assert.equal(backParent.children.length, 1);
  assert.equal(back.get(light.id)!.light?.type, 'point');
  assert.ok(back.get(light.id)!.position.equals(new Vec3(1, 2, 3)));
  assert.equal(back.active, parent.id);
  assert.equal(backParent.evaluated()!.faceCount, 24, 'modifiers still evaluate');
});

test('scene statistics count evaluated geometry', () => {
  const s = new Scene();
  const obj = s.add('mesh', 'Cube', createCube());
  obj.modifiers.push(createModifier('subsurf'));
  assert.equal(s.stats().faces, 24);
  obj.visible = false;
  assert.equal(s.stats().faces, 0);
});

test('colour conversion round-trips through sRGB hex', () => {
  for (const hex of ['#000000', '#ffffff', '#ff9e2c', '#3a7bd5']) {
    assert.equal(linearToHex(hexToLinear(hex)), hex);
  }
});

test('a group\'s bounds include its children', () => {
  const s = new Scene();
  const group = s.add('empty', 'Group');
  const child = s.add('mesh', 'Cube', createCube());
  child.position = new Vec3(0, 0, 5);
  s.setParent(child.id, group.id);

  const alone = s.add('empty', 'Lonely').bounds(s);
  assert.ok(alone.size().length() < 1e-9, 'an empty on its own is a point');

  const box = group.bounds(s);
  assert.ok(box.max.z > 5.9 && box.min.z < 4.1, `group bounds z ${box.min.z}..${box.max.z}`);
  assert.ok(box.size().x > 1.9, 'and its width');
});

test('hidden children are left out of a group\'s bounds', () => {
  const s = new Scene();
  const group = s.add('empty', 'Group');
  const child = s.add('mesh', 'Cube', createCube());
  child.position = new Vec3(0, 0, 20);
  child.visible = false;
  s.setParent(child.id, group.id);
  assert.ok(group.bounds(s).size().length() < 1e-9);
});

test('a modifier missing its fields goes inert rather than producing NaN', () => {
  // Inside the app every modifier comes from createModifier and is complete.
  // A scene file is not the app: one written by another version, truncated, or
  // hand-edited arrives partial, and a partial modifier used to either throw
  // (mirror reading axis[0] off undefined) or silently fill the mesh with NaN
  // (solidify multiplying by an undefined thickness), which then renders as
  // nothing and saves as a file worse than the one it came from.
  for (const type of Object.keys(MODIFIER_LABELS) as (keyof typeof MODIFIER_LABELS)[]) {
    const bare = { id: 1, type, name: type, enabled: true, showInEdit: true };
    const mesh = createCube();
    let out;
    assert.doesNotThrow(() => {
      out = evaluateStack(mesh, [bare as never], false);
    }, `a bare ${type} modifier threw`);
    assert.ok(out, `${type} produced nothing`);
    assert.ok(
      out.positions.every((p) => Number.isFinite(p.x + p.y + p.z)),
      `${type} put NaN into the mesh`,
    );
    for (const face of out.faces) {
      assert.ok(face.length >= 3, `${type} produced a face with ${face.length} vertices`);
      assert.ok(
        face.every((v) => v >= 0 && v < out.positions.length),
        `${type} produced a face indexing a vertex that does not exist`,
      );
    }
  }
});

test('a modifier this build does not know about is skipped, not fatal', () => {
  // A scene from a newer version must still open here, minus the effect that
  // cannot run — never as a stack that evaluates to undefined.
  const mesh = createCube();
  const unknown = { id: 9, type: 'holographic-lattice', name: 'From The Future', enabled: true, showInEdit: true };
  assert.equal(normaliseModifier(unknown), null, 'an unknown type should be rejected');
  let out;
  assert.doesNotThrow(() => { out = evaluateStack(mesh, [unknown as never], false); });
  assert.equal(out.faceCount, mesh.faceCount, 'an unrunnable modifier should leave the mesh alone');

  // And the same scene must survive a save/load round trip without it.
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube');
  obj.mesh = createCube();
  obj.modifiers = [unknown as never, createModifier('subsurf')];
  const back = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const restored = [...back.objects.values()][0];
  assert.equal(restored.modifiers.length, 1, 'the unrunnable modifier should have been dropped on load');
  assert.equal(restored.modifiers[0].type, 'subsurf', 'the runnable one should have survived');
});

test('a modifier keeps the values it does carry', () => {
  // Completing a partial modifier must not overwrite what the file actually
  // said — a levels: 3 subdivision has to stay a levels: 3 subdivision.
  const filled = normaliseModifier({ id: 7, type: 'subsurf', name: 'Mine', enabled: false, levels: 3 });
  assert.ok(filled);
  assert.equal(filled.id, 7);
  assert.equal(filled.name, 'Mine');
  assert.equal(filled.enabled, false);
  assert.equal((filled as { levels: number }).levels, 3);
  // And the field it did not carry comes from the defaults.
  assert.equal(typeof filled.showInEdit, 'boolean');
});
