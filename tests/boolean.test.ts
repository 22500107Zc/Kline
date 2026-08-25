import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { dissolveCoplanar, meshBoolean, stitchTJunctions } from '../src/mesh/boolean';
import { decimate } from '../src/mesh/decimate';
import { Mesh } from '../src/mesh/Mesh';
import { Mat4, Vec3 } from '../src/core/math';

function volume(m: Mesh): number {
  let v = 0;
  for (const loop of m.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      const a = m.positions[loop[0]];
      const b = m.positions[loop[i]];
      const c = m.positions[loop[i + 1]];
      v += a.dot(b.cross(c)) / 6;
    }
  }
  return v;
}

function watertight(m: Mesh): boolean {
  return m.topology().edges.every((e) => e.faces.length === 2);
}

/** Two 2×2×2 cubes overlapping by one unit along X. */
function pair(): [Mesh, Mesh] {
  const a = buildPrimitive('cube');
  const b = buildPrimitive('cube');
  b.transform(Mat4.translation(new Vec3(1, 0, 0)));
  return [a, b];
}

test('the three operations give the exact analytic volumes', () => {
  const cases: [Parameters<typeof meshBoolean>[2], number][] = [
    ['union', 12], ['difference', 4], ['intersect', 4],
  ];
  for (const [op, expected] of cases) {
    const [a, b] = pair();
    const r = meshBoolean(a, b, op);
    assert.ok(Math.abs(volume(r) - expected) < 1e-6, `${op} gave ${volume(r)}, wanted ${expected}`);
    assert.ok(watertight(r), `${op} left holes`);
  }
});

test('the operands are left untouched', () => {
  const [a, b] = pair();
  const beforeA = a.faceCount;
  const beforeB = b.faceCount;
  meshBoolean(a, b, 'difference');
  assert.equal(a.faceCount, beforeA);
  assert.equal(b.faceCount, beforeB);
});

test('a curved cut closes up rather than leaving T-junctions', () => {
  const sphere = buildPrimitive('uvsphere');
  const drill = buildPrimitive('cylinder');
  drill.transform(Mat4.scaling(new Vec3(0.5, 0.5, 2)));
  const r = meshBoolean(sphere, drill, 'difference');
  assert.ok(watertight(r), 'boolean left an open seam');
  assert.ok(r.faceCount > sphere.faceCount * 0.5);
  // Roughly the sphere minus the drilled cylinder's share of it.
  assert.ok(volume(r) > 2.3 && volume(r) < 3.1, `volume was ${volume(r)}`);
});

test('non-overlapping solids just add up', () => {
  const a = buildPrimitive('cube');
  const b = buildPrimitive('cube');
  b.transform(Mat4.translation(new Vec3(6, 0, 0)));
  const united = meshBoolean(a, b, 'union');
  assert.ok(Math.abs(volume(united) - 16) < 1e-6);
  const nothing = meshBoolean(a, b, 'intersect');
  assert.ok(Math.abs(volume(nothing)) < 1e-6);
});

test('B keeps its own material slots through the material offset', () => {
  const [a, b] = pair();
  const r = meshBoolean(a, b, 'union', 3);
  const slots = new Set(r.faceMaterial);
  assert.ok(slots.has(0), 'A kept slot 0');
  assert.ok(slots.has(3), 'B moved to slot 3');
});

test('limited dissolve merges the split faces back into n-gons', () => {
  const [a, b] = pair();
  const r = meshBoolean(a, b, 'union');
  const before = r.faceCount;
  const merged = dissolveCoplanar(r, 1);
  assert.ok(merged > 0);
  assert.ok(r.faceCount < before);
  assert.ok(Math.abs(volume(r) - 12) < 1e-6, 'dissolve changed the shape');
});

test('stitchTJunctions closes a deliberately mismatched seam', () => {
  // Two quads meeting along one edge, where the right-hand side is split.
  const m = new Mesh(
    [
      new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(1, 1, 0), new Vec3(0, 1, 0),
      new Vec3(1, 0.5, 0), new Vec3(2, 0, 0), new Vec3(2, 1, 0),
    ],
    [[0, 1, 2, 3], [1, 5, 4], [4, 5, 6, 2]],
  );
  assert.ok(!watertight(m));
  const inserted = stitchTJunctions(m, 1e-6);
  assert.equal(inserted, 1);
  assert.deepEqual(m.faces[0], [0, 1, 4, 2, 3]);
});

test('decimate keeps the silhouette while shedding triangles', () => {
  const sphere = buildPrimitive('uvsphere');
  const before = volume(sphere);
  const small = decimate(sphere, 0.25);
  assert.ok(small.triCount <= sphere.triCount * 0.3);
  assert.ok(watertight(small), 'decimation punched a hole');
  assert.ok(Math.abs(volume(small) - before) / before < 0.05);
});

test('decimate holds the border of an open surface', () => {
  const grid = buildPrimitive('grid');
  const box = grid.bounds();
  const small = decimate(grid, 0.1, true);
  const shrunk = small.bounds();
  assert.ok(Math.abs(shrunk.min.x - box.min.x) < 1e-6);
  assert.ok(Math.abs(shrunk.max.y - box.max.y) < 1e-6);
});

test('a ratio of 1 hands the mesh straight back', () => {
  const sphere = buildPrimitive('uvsphere');
  const same = decimate(sphere, 1);
  assert.equal(same.triCount, sphere.triCount);
});
