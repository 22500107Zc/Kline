import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { paintTargets, uvAtPoint, uvScaleAt } from '../src/paint/texture';
import { SculptStroke, defaultSculpt } from '../src/sculpt/sculpt';
import { cubeProject } from '../src/uv/unwrap';
import { Vec3 } from '../src/core/math';
import { Mesh } from '../src/mesh/Mesh';

test('a fresh mesh has no colours and reads as white', () => {
  const cube = buildPrimitive('cube');
  assert.equal(cube.colors, null);
  assert.deepEqual(cube.colorAt(0), [1, 1, 1]);
});

test('the colour array starts white so an unpainted mesh looks unchanged', () => {
  const cube = buildPrimitive('cube');
  const c = cube.ensureColors();
  assert.equal(c.length, cube.vertCount * 3);
  for (const v of c) assert.equal(v, 1);
});

test('the colour brush paints where it touches and nowhere else', () => {
  const cube = buildPrimitive('cube');
  const s = { ...defaultSculpt(), brush: 'color' as const, strength: 1, radius: 0.9, paintColor: [1, 0, 0] as [number, number, number] };
  const stroke = new SculptStroke(cube, s, s.radius);
  const at = cube.positions[0].clone();
  stroke.begin(at, s.radius);
  for (let i = 0; i < 6; i++) stroke.dab(at, new Vec3(0, 0, 1), s.radius, new Vec3());

  const painted = cube.colorAt(0);
  assert.ok(painted[0] > 0.9 && painted[1] < 0.2, `vertex 0 came out ${painted}`);
  // The far corner of a 2-unit cube is well outside a 0.9 radius.
  let far = 0;
  for (let v = 0; v < cube.vertCount; v++) {
    if (cube.positions[v].distanceTo(at) > 2) far = v;
  }
  assert.deepEqual(cube.colorAt(far), [1, 1, 1], 'paint reached a vertex the brush never touched');
});

test('the colour brush does not move geometry', () => {
  const cube = buildPrimitive('cube');
  const before = cube.positions.map((p) => p.clone());
  const s = { ...defaultSculpt(), brush: 'color' as const, strength: 1, radius: 3 };
  const stroke = new SculptStroke(cube, s, s.radius);
  stroke.begin(new Vec3(), s.radius);
  stroke.dab(new Vec3(), new Vec3(0, 0, 1), s.radius, new Vec3());
  for (let i = 0; i < cube.vertCount; i++) {
    assert.ok(cube.positions[i].distanceTo(before[i]) < 1e-12);
  }
});

test('inverted, the colour brush paints back to white', () => {
  const cube = buildPrimitive('cube');
  const colors = cube.ensureColors();
  colors.fill(0);
  const s = { ...defaultSculpt(), brush: 'color' as const, strength: 1, radius: 3, invert: true };
  const stroke = new SculptStroke(cube, s, s.radius);
  stroke.begin(new Vec3(), s.radius);
  for (let i = 0; i < 6; i++) stroke.dab(new Vec3(), new Vec3(0, 0, 1), s.radius, new Vec3());
  assert.ok(cube.colorAt(0)[0] > 0.8, `erasing left ${cube.colorAt(0)}`);
});

test('a masked vertex keeps its colour', () => {
  const cube = buildPrimitive('cube');
  const mask = cube.ensureMask();
  mask[0] = 1;
  const s = { ...defaultSculpt(), brush: 'color' as const, strength: 1, radius: 5, paintColor: [0, 0, 0] as [number, number, number] };
  const stroke = new SculptStroke(cube, s, s.radius);
  stroke.begin(new Vec3(), s.radius);
  for (let i = 0; i < 4; i++) stroke.dab(new Vec3(), new Vec3(0, 0, 1), s.radius, new Vec3());
  assert.deepEqual(cube.colorAt(0), [1, 1, 1], 'the masked vertex was painted');
  assert.ok(cube.colorAt(1)[0] < 0.5, 'nothing else was painted either');
});

test('colours survive a save and load', () => {
  const cube = buildPrimitive('cube');
  const c = cube.ensureColors();
  c[0] = 0.25;
  c[1] = 0.5;
  const back = Mesh.fromJSON(JSON.parse(JSON.stringify(cube.toJSON())));
  assert.ok(back.colors);
  assert.equal(back.colors![0], 0.25);
  assert.equal(back.colors![1], 0.5);
  assert.equal(back.clone().colors![1], 0.5);
});

// ------------------------------------------------------------ texture paint

test('a point on a face maps to a coordinate inside that face', () => {
  const cube = buildPrimitive('cube');
  cubeProject(cube, 1);
  // The centre of face 0.
  const centre = cube.faceCenter(0);
  const uv = uvAtPoint(cube, 0, centre);
  assert.ok(uv, 'no coordinate came back');
  const corners = cube.uvFor(0)!;
  let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
  for (let i = 0; i < corners.length; i += 2) {
    minU = Math.min(minU, corners[i]); maxU = Math.max(maxU, corners[i]);
    minV = Math.min(minV, corners[i + 1]); maxV = Math.max(maxV, corners[i + 1]);
  }
  assert.ok(uv![0] >= minU - 1e-6 && uv![0] <= maxU + 1e-6, `u ${uv![0]} outside [${minU}, ${maxU}]`);
  assert.ok(uv![1] >= minV - 1e-6 && uv![1] <= maxV + 1e-6, `v ${uv![1]} outside [${minV}, ${maxV}]`);
});

test('a brush over a seam finds faces on both sides', () => {
  // This is the whole reason painting works per face rather than per hit: a
  // brush on an edge has to stamp into every island it overlaps.
  const cube = buildPrimitive('cube');
  cubeProject(cube, 1);
  // A corner of the cube, where three faces meet.
  const corner = cube.positions[0];
  const targets = paintTargets(cube, corner, 0.5);
  assert.ok(targets.length >= 3, `only ${targets.length} faces found at a corner`);
  const faces = new Set(targets.map((t) => t.face));
  assert.equal(faces.size, targets.length, 'the same face came back twice');
  for (const t of targets) {
    assert.ok(t.outline.length >= 3, 'a target had no outline to clip against');
  }
});

test('a mesh without coordinates has nowhere to paint', () => {
  const cube = buildPrimitive('cube');
  assert.deepEqual(paintTargets(cube, new Vec3(), 5), []);
});

test('the brush scale reflects how the surface was unwrapped', () => {
  const cube = buildPrimitive('cube');
  cubeProject(cube, 1);
  const scale = uvScaleAt(cube, 0);
  assert.ok(scale > 0 && Number.isFinite(scale), `scale came out ${scale}`);
  // A face two units across mapped into a fraction of the atlas has a scale
  // well under one.
  assert.ok(scale < 1, `expected a shrink, got ${scale}`);
});

test('vertex colours reach the path tracer', async () => {
  const { Scene } = await import('../src/scene/Scene');
  const { createMaterial } = await import('../src/scene/Material');
  const { buildTraceScene } = await import('../src/render/pathtrace/build');
  const cam = {
    origin: [0, -5, 0] as [number, number, number],
    forward: [0, 1, 0] as [number, number, number],
    right: [1, 0, 0] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
    fovY: 0.7, orthographic: false, orthoHeight: 1, aperture: 0, focusDistance: 5,
  };

  const plain = new Scene();
  plain.materials.push(createMaterial({ name: 'M' }));
  plain.add('mesh', 'Cube', buildPrimitive('cube'));
  assert.equal(buildTraceScene(plain, cam, 0).colors.length, 0, 'an unpainted scene should carry no colours');

  const painted = new Scene();
  painted.materials.push(createMaterial({ name: 'M' }));
  const obj = painted.add('mesh', 'Cube', buildPrimitive('cube'));
  const c = obj.mesh!.ensureColors();
  c.fill(0.5);
  const ts = buildTraceScene(painted, cam, 0);
  assert.equal(ts.colors.length, ts.positions.length, 'one colour per position');
  assert.ok(ts.colors.every((v) => Math.abs(v - 0.5) < 1e-6));
});
