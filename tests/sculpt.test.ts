import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { SculptStroke, VertexGrid, brushFalloff, defaultSculpt } from '../src/sculpt/sculpt';
import { Vec3 } from '../src/core/math';

test('the falloff runs from 1 at the centre to 0 at the rim', () => {
  assert.equal(brushFalloff(0), 1);
  assert.equal(brushFalloff(1), 0);
  assert.equal(brushFalloff(2), 0, 'outside the radius still clamps to zero');
  assert.ok(brushFalloff(0.5) > 0.3 && brushFalloff(0.5) < 0.6);
  // Monotonic, so a stroke never gets stronger further from the centre.
  for (let i = 1; i <= 10; i++) {
    assert.ok(brushFalloff(i / 10) <= brushFalloff((i - 1) / 10));
  }
});

test('the vertex grid finds exactly the points inside the radius', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const grid = new VertexGrid(sphere, 0.2);
  const centre = new Vec3(0, 0, 1);
  const found = new Set(grid.query(centre, 0.35));
  let expected = 0;
  for (let i = 0; i < sphere.vertCount; i++) {
    if (sphere.positions[i].distanceTo(centre) <= 0.35) {
      expected++;
      assert.ok(found.has(i), `missed vertex ${i}`);
    }
  }
  assert.equal(found.size, expected);
});

test('draw pushes the surface out along the brush normal', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = { ...defaultSculpt(), brush: 'draw' as const, strength: 1, autoSmooth: 0 };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const centre = new Vec3(0, 0, 1);
  const before = sphere.positions.map((p) => p.clone());
  const moved = stroke.dab(centre, new Vec3(0, 0, 1), 0.4, new Vec3());
  assert.ok(moved > 0);
  let lifted = 0;
  for (let i = 0; i < sphere.vertCount; i++) {
    const d = sphere.positions[i].z - before[i].z;
    if (Math.abs(d) > 1e-9) {
      assert.ok(d > 0, 'draw should only push outward');
      lifted++;
    }
  }
  // `moved` counts everything inside the radius; the outermost ring is
  // weighted so near zero that its displacement is below the epsilon.
  assert.ok(lifted > 0 && lifted <= moved);
});

test('inverting draw digs in instead', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = { ...defaultSculpt(), brush: 'draw' as const, strength: 1, invert: true, autoSmooth: 0 };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const top = sphere.positions.reduce((best, p, i) => (p.z > sphere.positions[best].z ? i : best), 0);
  const before = sphere.positions[top].z;
  stroke.dab(new Vec3(0, 0, 1), new Vec3(0, 0, 1), 0.5, new Vec3());
  assert.ok(sphere.positions[top].z < before);
});

test('a dab outside the mesh touches nothing', () => {
  const sphere = buildPrimitive('uvsphere');
  const stroke = new SculptStroke(sphere, defaultSculpt(), 0.3);
  assert.equal(stroke.dab(new Vec3(50, 50, 50), new Vec3(0, 0, 1), 0.3, new Vec3()), 0);
});

test('smooth pulls a spike back toward its neighbours', () => {
  const grid = buildPrimitive('grid');
  const spike = Math.floor(grid.vertCount / 2);
  grid.positions[spike] = grid.positions[spike].add(new Vec3(0, 0, 1));
  grid.markDirty();
  const settings = { ...defaultSculpt(), brush: 'smooth' as const, strength: 1, autoSmooth: 0 };
  const stroke = new SculptStroke(grid, settings, 0.4);
  const centre = grid.positions[spike].clone();
  stroke.dab(centre, new Vec3(0, 0, 1), 0.5, new Vec3());
  assert.ok(grid.positions[spike].z < 0.9, `spike stayed at ${grid.positions[spike].z}`);
});

test('grab drags the captured set and nothing else', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = { ...defaultSculpt(), brush: 'grab' as const, autoSmooth: 0 };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const centre = new Vec3(0, 0, 1);
  stroke.begin(centre, 0.4);
  const before = sphere.positions.map((p) => p.clone());
  stroke.dab(centre, new Vec3(0, 0, 1), 0.4, new Vec3(0.3, 0, 0));
  for (let i = 0; i < sphere.vertCount; i++) {
    const d = sphere.positions[i].sub(before[i]);
    if (d.lengthSq() < 1e-18) continue;
    assert.ok(Math.abs(d.y) < 1e-9 && Math.abs(d.z) < 1e-9, 'grab moved off its drag axis');
    assert.ok(d.x > 0 && d.x <= 0.3 + 1e-9);
  }
  // Repeating the same total delta is idempotent, not cumulative.
  const snapshot = sphere.positions.map((p) => p.clone());
  stroke.dab(centre, new Vec3(0, 0, 1), 0.4, new Vec3(0.3, 0, 0));
  for (let i = 0; i < sphere.vertCount; i++) {
    assert.ok(sphere.positions[i].distanceTo(snapshot[i]) < 1e-12);
  }
});

test('X symmetry mirrors the stroke', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = {
    ...defaultSculpt(), brush: 'draw' as const, strength: 1, autoSmooth: 0,
    symmetry: [true, false, false] as [boolean, boolean, boolean],
  };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const before = sphere.positions.map((p) => p.clone());
  stroke.dab(new Vec3(0.9, 0, 0), new Vec3(1, 0, 0), 0.5, new Vec3());
  let left = 0;
  let right = 0;
  for (let i = 0; i < sphere.vertCount; i++) {
    if (sphere.positions[i].distanceTo(before[i]) < 1e-9) continue;
    if (before[i].x > 0) right++;
    else left++;
  }
  assert.ok(right > 0 && left > 0, `symmetry only touched one side (${left}/${right})`);
});
