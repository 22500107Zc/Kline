import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { bevelEdges, bevelVertices, profilePoints, vertexFan } from '../src/mesh/bevel';
import { Mesh } from '../src/mesh/Mesh';
import { Vec3 } from '../src/core/math';

function signedVolume(m: Mesh): number {
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

function edgeStats(m: Mesh): { boundary: number; nonManifold: number } {
  let boundary = 0;
  let nonManifold = 0;
  for (const e of m.topology().edges) {
    if (e.faces.length === 1) boundary++;
    else if (e.faces.length > 2) nonManifold++;
  }
  return { boundary, nonManifold };
}

test('vertexFan orders a cube corner into a closed three-face loop', () => {
  const cube = buildPrimitive('cube');
  const fan = vertexFan(cube, 0);
  assert.ok(fan);
  assert.equal(fan!.cyclic, true);
  assert.equal(fan!.faces.length, 3);
  assert.equal(fan!.edges.length, 3);
});

test('bevelling every cube edge stays watertight and loses volume', () => {
  const cube = buildPrimitive('cube');
  const before = signedVolume(cube);
  const edges = cube.topology().edges.map((_, i) => i);
  const r = bevelEdges(cube, edges, 0.2, 1, 0.5);

  // 6 originals + 12 edge strips + 8 corner caps.
  assert.equal(cube.faceCount, 26);
  assert.equal(cube.vertCount, 24, 'each corner splits into one vertex per face');
  assert.equal(r.newFaces.length, 20);
  const stats = edgeStats(cube);
  assert.equal(stats.boundary, 0);
  assert.equal(stats.nonManifold, 0);
  assert.ok(signedVolume(cube) < before);
  assert.ok(signedVolume(cube) > before * 0.9);
});

test('more segments round the profile without opening the surface', () => {
  for (const segments of [2, 3, 5]) {
    const cube = buildPrimitive('cube');
    const edges = cube.topology().edges.map((_, i) => i);
    bevelEdges(cube, edges, 0.25, segments, 0.5);
    const stats = edgeStats(cube);
    assert.equal(stats.boundary, 0, `segments=${segments} left boundary edges`);
    assert.equal(stats.nonManifold, 0, `segments=${segments} went non-manifold`);
    assert.equal(cube.vertCount, 24 * segments);
  }
});

test('a single beveled edge widens its two side faces and adds one chamfer', () => {
  const cube = buildPrimitive('cube');
  const before = cube.faceCount;
  const r = bevelEdges(cube, [0], 0.2, 1, 0.5);
  assert.equal(cube.faceCount, before + 1);
  assert.equal(r.newFaces.length, 1);
  assert.equal(edgeStats(cube).boundary, 0);
  // The two vertices at the ends of the edge each split into two.
  assert.equal(cube.vertCount, 10);
});

test('bevel refuses boundary edges rather than tearing the mesh', () => {
  const grid = buildPrimitive('grid');
  const t = grid.topology();
  const border = t.edges.map((_, i) => i).filter((i) => t.edges[i].faces.length === 1);
  const before = grid.faceCount;
  const r = bevelEdges(grid, border, 0.05, 1, 0.5);
  assert.equal(r.newFaces.length, 0);
  assert.equal(grid.faceCount, before);
});

test('vertex bevel cuts exactly the corner tetrahedra away', () => {
  const cube = buildPrimitive('cube');
  const before = signedVolume(cube);
  const w = 0.2;
  bevelVertices(cube, [0, 1, 2, 3, 4, 5, 6, 7], w);
  // Each 90° corner loses a tetrahedron with legs of length w.
  const expected = before - 8 * (w ** 3) / 6;
  assert.ok(Math.abs(signedVolume(cube) - expected) < 1e-9);
  assert.equal(cube.faceCount, 14);
  assert.equal(edgeStats(cube).boundary, 0);
});

test('a zero width is a no-op', () => {
  const cube = buildPrimitive('cube');
  const edges = cube.topology().edges.map((_, i) => i);
  bevelEdges(cube, edges, 0, 2, 0.5);
  assert.equal(cube.faceCount, 6);
  assert.equal(cube.vertCount, 8);
});

test('the profile bulges outward at 0.5 and is flat at 0', () => {
  const origin = new Vec3();
  const a = new Vec3(1, 0, 0);
  const b = new Vec3(0, 1, 0);
  const flat = profilePoints(origin, a, b, 2, 0);
  const round = profilePoints(origin, a, b, 2, 0.5);
  assert.equal(flat.length, 3);
  // The chamfer midpoint sits on the chord; the arc midpoint sits further out.
  assert.ok(Math.abs(flat[1].length() - Math.SQRT1_2) < 1e-9);
  assert.ok(round[1].length() > flat[1].length() + 0.2);
  assert.ok(Math.abs(round[1].length() - 1) < 1e-6);
});
