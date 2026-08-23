import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG2RAD, Mat4, Vec3, decomposeMatrix } from '../src/core/math';
import { Scene } from '../src/scene/Scene';
import { createCube, createPlane } from '../src/mesh/primitives';
import { createModifier, evaluateStack } from '../src/modifiers';
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
