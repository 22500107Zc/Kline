import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { isSolid, meshBoolean } from '../src/mesh/csg';
import { dissolveCoplanar, repairManifold } from '../src/mesh/boolean';
import { TriangleBVH } from '../src/mesh/bvh';
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
const watertight = (m: Mesh): boolean => m.topology().edges.every((e) => e.faces.length === 2);

/**
 * The identity that actually pins a boolean down: whatever the shapes,
 * |A∪B| + |A∩B| must equal |A| + |B|, and |A| − |A∩B| must equal |A\\B|.
 */
function checkAlgebra(label: string, make: () => [Mesh, Mesh], tol = 0.02): void {
  const [a0, b0] = make();
  const va = volume(a0);
  const vb = volume(b0);
  const vol: Record<string, number> = {};
  for (const op of ['union', 'difference', 'intersect'] as const) {
    const [a, b] = make();
    const r = meshBoolean(a, b, op);
    vol[op] = volume(r);
    assert.ok(watertight(r), `${label}: ${op} left an open surface`);
  }
  assert.ok(
    Math.abs(vol.union + vol.intersect - (va + vb)) < tol,
    `${label}: union+intersect was ${(vol.union + vol.intersect).toFixed(4)}, wanted ${(va + vb).toFixed(4)}`,
  );
  assert.ok(
    Math.abs(va - vol.intersect - vol.difference) < tol,
    `${label}: A-intersect was ${(va - vol.intersect).toFixed(4)}, wanted ${vol.difference.toFixed(4)}`,
  );
}

test('boolean algebra holds for overlapping boxes', () => {
  checkAlgebra('boxes', () => {
    const a = buildPrimitive('cube');
    const b = buildPrimitive('cube');
    b.transform(Mat4.translation(new Vec3(1, 0, 0)));
    return [a, b];
  }, 1e-6);
});

test('boolean algebra holds for a curved cut', () => {
  checkAlgebra('sphere/cylinder', () => {
    const a = buildPrimitive('uvsphere');
    const b = buildPrimitive('cylinder');
    b.transform(Mat4.scaling(new Vec3(0.5, 0.5, 2)));
    return [a, b];
  });
});

test('a rounded solid carved by a sphere terminates and stays exact', () => {
  // Two rounded surfaces meeting almost tangentially is the case that makes
  // BSP-based CSG split for ever.
  const started = Date.now();
  checkAlgebra('rounded cube/sphere', () => {
    const a = catmullClark(buildPrimitive('cube'), 1);
    const b = buildPrimitive('uvsphere');
    b.transform(Mat4.translation(new Vec3(0.9, 0.9, 0.9)));
    return [a, b];
  });
  assert.ok(Date.now() - started < 20000, 'took far too long');
});

test('a dense pair still finishes quickly', () => {
  const a = catmullClark(buildPrimitive('cube'), 2);
  const b = buildPrimitive('uvsphere');
  b.transform(Mat4.translation(new Vec3(0.7, 0.2, 0.4)));
  const started = Date.now();
  const r = meshBoolean(a, b, 'difference');
  assert.ok(watertight(r));
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started}ms`);
});

test('separated solids need no cutting at all', () => {
  const a = buildPrimitive('cube');
  const b = buildPrimitive('cube');
  b.transform(Mat4.translation(new Vec3(9, 0, 0)));
  assert.ok(Math.abs(volume(meshBoolean(a, b, 'union')) - 16) < 1e-6);
  assert.ok(Math.abs(volume(meshBoolean(a, b, 'difference')) - 8) < 1e-6);
  assert.equal(meshBoolean(a, b, 'intersect').faceCount, 0);
});

test('an empty operand degrades sensibly', () => {
  const a = buildPrimitive('cube');
  const empty = new Mesh();
  assert.equal(meshBoolean(a, empty, 'intersect').faceCount, 0);
  assert.equal(meshBoolean(a, empty, 'difference').faceCount, a.faceCount);
  assert.equal(meshBoolean(empty, a, 'union').faceCount, a.faceCount);
});

test('coordinates ride through the cut', () => {
  const a = buildPrimitive('cube');
  for (let f = 0; f < a.faceCount; f++) {
    a.setUV(f, a.faces[f].flatMap((_, i) => [i / 4, f / 6]));
  }
  const b = buildPrimitive('cube');
  b.transform(Mat4.translation(new Vec3(1.2, 0, 0)));
  const r = meshBoolean(a, b, 'difference');
  let mapped = 0;
  for (let f = 0; f < r.faceCount; f++) if (r.uvFor(f)) mapped++;
  assert.ok(mapped > r.faceCount * 0.8, `only ${mapped}/${r.faceCount} faces kept coordinates`);
});

test('B keeps its own material slots', () => {
  const a = buildPrimitive('cube');
  const b = buildPrimitive('cube');
  b.transform(Mat4.translation(new Vec3(1, 0, 0)));
  const r = meshBoolean(a, b, 'union', 3);
  const slots = new Set(r.faceMaterial);
  assert.ok(slots.has(0) && slots.has(3));
});

test('limited dissolve tidies the fragments without moving the surface', () => {
  const a = buildPrimitive('cube');
  const b = buildPrimitive('cube');
  b.transform(Mat4.translation(new Vec3(1, 0, 0)));
  const r = meshBoolean(a, b, 'union');
  const before = r.faceCount;
  assert.ok(dissolveCoplanar(r, 1) > 0);
  assert.ok(r.faceCount < before);
  assert.ok(Math.abs(volume(r) - 12) < 1e-6);
});

test('isSolid tells a closed mesh from an open one', () => {
  assert.equal(isSolid(buildPrimitive('cube')), true);
  assert.equal(isSolid(buildPrimitive('grid')), false);
  assert.equal(isSolid(new Mesh()), false);
});

test('the BVH agrees with brute force about inside and outside', () => {
  const sphere = buildPrimitive('uvsphere');
  const bvh = new TriangleBVH(sphere.positions, sphere.faces);
  assert.equal(bvh.contains(new Vec3(0, 0, 0)), true);
  assert.equal(bvh.contains(new Vec3(0, 0, 3)), false);
  assert.equal(bvh.contains(new Vec3(0.5, 0.5, 0.5)), true);
  assert.equal(bvh.contains(new Vec3(1.5, 0, 0)), false);
});

test('the BVH finds the triangles a box touches', () => {
  const cube = buildPrimitive('cube');
  const bvh = new TriangleBVH(cube.positions, cube.faces);
  assert.equal(bvh.triangleCount, 12);
  const all = bvh.queryBox(new Vec3(-9, -9, -9), new Vec3(9, 9, 9));
  assert.equal(new Set(all).size, 12);
  const corner = bvh.queryBox(new Vec3(0.9, 0.9, 0.9), new Vec3(1.1, 1.1, 1.1));
  assert.ok(corner.length > 0 && corner.length < 12);
});

test('a ray crosses a cube twice, and misses when it should', () => {
  const cube = buildPrimitive('cube');
  const bvh = new TriangleBVH(cube.positions, cube.faces);
  // Deliberately off the face diagonals: a ray straight down an axis runs
  // along the edge two triangles share and is counted by both, which is the
  // degeneracy `contains` retries around.
  assert.equal(bvh.raycastAll(new Vec3(-5, 0.31, 0.17), new Vec3(1, 0, 0)).length, 2);
  assert.equal(bvh.raycastAll(new Vec3(-5, 9, 0), new Vec3(1, 0, 0)).length, 0);
  const near = bvh.raycastNearest(new Vec3(-5, 0.31, 0.17), new Vec3(1, 0, 0));
  assert.ok(near && Math.abs(near.t - 4) < 1e-6);
});

test('every result is a closed solid, wherever the cutter lands', () => {
  // A sweep, not a single placement: the cases that break a boolean are the
  // ones where a seam happens to graze an existing vertex, and you only find
  // those by moving the cutter around.
  const base = catmullClark(buildPrimitive('cube'), 1);
  let checked = 0;
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const offset = new Vec3(
      Math.cos(angle) * 0.75,
      Math.sin(angle * 1.7) * 0.55,
      Math.sin(angle) * 0.75,
    );
    for (const op of ['union', 'difference', 'intersect'] as const) {
      const a = base.clone();
      const b = buildPrimitive('uvsphere');
      b.transform(Mat4.scaling(new Vec3(0.6, 0.6, 0.6)));
      b.transform(Mat4.translation(offset));
      const r = meshBoolean(a, b, op);
      if (r.faceCount === 0) continue;
      assert.ok(
        watertight(r),
        `${op} at ${offset.x.toFixed(2)},${offset.y.toFixed(2)},${offset.z.toFixed(2)} left an open surface`,
      );
      checked++;
    }
  }
  assert.ok(checked > 30, `only ${checked} of the placements produced geometry`);
});

test('repair closes a surface a sliver has torn open', () => {
  // A quad with a spurious extra face folded along one edge: three faces meet
  // where two should. Repair should notice and drop the fold.
  const m = new Mesh(
    [
      new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(1, 1, 0), new Vec3(0, 1, 0),
      new Vec3(0, 0, 1), new Vec3(1, 0, 1), new Vec3(1, 1, 1), new Vec3(0, 1, 1),
    ],
    [
      [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
      [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
    ],
  );
  assert.ok(watertight(m));
  // Split one edge a hair off centre on one side only, the way a near-tangent
  // cut does, then let repair put it back.
  m.positions.push(new Vec3(0.5, 0, 1e-6));
  m.faces[0] = [0, 3, 2, 1, 8];
  m.markDirty();
  assert.ok(!watertight(m));
  repairManifold(m, 1e-4);
  assert.ok(watertight(m), 'repair left the surface open');
});
