import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { knifeCut } from '../src/mesh/knife';
import { Mesh } from '../src/mesh/Mesh';
import { Vec3 } from '../src/core/math';
import { unwrap } from '../src/uv/unwrap';

/** A top-down orthographic projection, which is all the cut needs. */
const topDown = (p: Vec3): [number, number] => [p.x * 100 + 200, p.y * 100 + 200];

function stats(m: Mesh): { boundary: number; nonManifold: number } {
  let boundary = 0;
  let nonManifold = 0;
  for (const e of m.topology().edges) {
    if (e.faces.length === 1) boundary++;
    else if (e.faces.length > 2) nonManifold++;
  }
  return { boundary, nonManifold };
}

test('a cut across a grid splits every face it crosses', () => {
  const grid = buildPrimitive('grid');
  const before = grid.faceCount;
  const beforeStats = stats(grid);
  const r = knifeCut(grid, { project: topDown, path: [[-100, 213], [500, 213]], cutThrough: true });

  assert.equal(r.splits, 10, `expected one split per column, got ${r.splits}`);
  assert.equal(grid.faceCount, before + 10);
  assert.equal(stats(grid).nonManifold, 0, 'the cut went non-manifold');
  // Two extra boundary edges: the ones the cut crossed on the left and right.
  assert.equal(stats(grid).boundary, beforeStats.boundary + 2);
});

test('a cut through a solid leaves it closed', () => {
  const cube = buildPrimitive('cube');
  const r = knifeCut(cube, { project: topDown, path: [[-100, 210], [500, 210]], cutThrough: true });
  assert.ok(r.splits > 0);
  const s = stats(cube);
  assert.equal(s.boundary, 0, 'the cut opened a hole');
  assert.equal(s.nonManifold, 0, 'the cut went non-manifold');
});

test('both faces on a cut edge gain the same vertex', () => {
  // The whole point of collecting crossings per edge: if the two faces
  // sharing an edge got their own copies, the seam would be a hairline crack.
  const cube = buildPrimitive('cube');
  const before = cube.vertCount;
  knifeCut(cube, { project: topDown, path: [[-100, 210], [500, 210]], cutThrough: true });
  const added = cube.vertCount - before;
  // Four side faces, four crossed edges, one vertex each — not eight.
  assert.equal(added, 4, `the cut made ${added} vertices where four would do`);
});

test('a cut that misses the mesh changes nothing', () => {
  const cube = buildPrimitive('cube');
  const before = { f: cube.faceCount, v: cube.vertCount };
  const r = knifeCut(cube, { project: topDown, path: [[-500, -500], [-400, -400]], cutThrough: true });
  assert.equal(r.splits, 0);
  assert.equal(cube.faceCount, before.f);
  assert.equal(cube.vertCount, before.v);
});

test('a single point is not a cut', () => {
  const cube = buildPrimitive('cube');
  const before = cube.faceCount;
  assert.equal(knifeCut(cube, { project: topDown, path: [[0, 0]], cutThrough: true }).splits, 0);
  assert.equal(cube.faceCount, before);
});

test('back faces are left alone unless asked for', () => {
  const cube = buildPrimitive('cube');
  // Only the +z face is "front" here.
  const t = cube.topology();
  const front = (f: number): boolean => t.faceNormals[f].z > 0.5;
  const r = knifeCut(cube, {
    project: topDown,
    path: [[-100, 213], [500, 213]],
    frontFacing: front,
  });
  assert.equal(r.splits, 1, `only the front face should split, got ${r.splits}`);
  // And the neighbour still gets the vertices, so no T-junction is left.
  assert.equal(stats(cube).nonManifold, 0);
  for (const e of cube.topology().edges) assert.ok(e.faces.length <= 2);
});

test('a multi-segment cut follows the line the user drew', () => {
  const grid = buildPrimitive('grid');
  const before = grid.faceCount;
  // An L: across, then down.
  const r = knifeCut(grid, {
    project: topDown,
    path: [[-100, 213], [213, 213], [213, 500]],
    cutThrough: true,
  });
  assert.ok(r.splits > 6, `an L across a 10x10 grid should split plenty, got ${r.splits}`);
  assert.equal(grid.faceCount, before + r.splits);
  assert.equal(stats(grid).nonManifold, 0);
});

test('the cut carries UV coordinates onto the new vertices', () => {
  const cube = buildPrimitive('cube');
  unwrap(cube, { useSeams: false, angleLimit: 66, margin: 0.01 });
  assert.ok(cube.hasUV, 'the fixture needs coordinates to begin with');
  knifeCut(cube, { project: topDown, path: [[-100, 210], [500, 210]], cutThrough: true });
  let missing = 0;
  for (let f = 0; f < cube.faceCount; f++) if (!cube.uvFor(f)) missing++;
  assert.equal(missing, 0, `${missing} faces lost their coordinates to the cut`);
});
