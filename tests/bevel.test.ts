import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { bevelEdges, bevelVertices, markBevelWeight, profilePoints, vertexFan } from '../src/mesh/bevel';
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
    // 24 vertices per segment around the profiles, plus whatever the eight
    // corner patches need to stay round rather than flat.
    assert.ok(
      cube.vertCount >= 24 * segments + 8,
      `segments=${segments} gave ${cube.vertCount} vertices`,
    );
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

function volumeOf(m: Mesh): number {
  let v = 0;
  for (const loop of m.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      v += m.positions[loop[0]].dot(m.positions[loop[i]].cross(m.positions[loop[i + 1]])) / 6;
    }
  }
  return v;
}

/** The shortest edge left in the mesh: zero means the clamp collapsed something. */
function shortestEdge(m: Mesh): number {
  let min = Infinity;
  for (const e of m.topology().edges) {
    min = Math.min(min, m.positions[e.a].distanceTo(m.positions[e.b]));
  }
  return min;
}

test('a width wider than the model shrinks instead of turning inside out', () => {
  const before = Math.abs(volumeOf(buildPrimitive('cube')));

  const loose = buildPrimitive('cube');
  bevelEdges(loose, loose.topology().edges.map((_, i) => i), 20, 2, 0.5, false);
  assert.ok(
    Math.abs(volumeOf(loose)) > before * 10,
    'unclamped, a width ten times the model should turn it inside out — the test proves nothing otherwise',
  );

  const cube = buildPrimitive('cube');
  bevelEdges(cube, cube.topology().edges.map((_, i) => i), 20, 2, 0.5, true);
  const after = Math.abs(volumeOf(cube));
  assert.ok(after > before * 0.3, `volume collapsed from ${before} to ${after}`);
  assert.ok(after <= before + 1e-6, `bevel grew the cube from ${before} to ${after}`);
  assert.ok(shortestEdge(cube) > 1e-6, 'clamping left zero-length edges behind');
  assert.ok(cube.topology().edges.every((e) => e.faces.length === 2), 'clamped bevel left a hole');
});

test('the clamp settles on one width for the whole bevel', () => {
  // A slab: the short edges are a quarter the length of the long ones. Clamping
  // each corner on its own would leave the long edges wide and pinch only the
  // short ones; one global factor should give exactly the same mesh as asking
  // for the largest width that fits anywhere, with clamping off.
  const slab = (): Mesh => {
    const b = buildPrimitive('cube');
    for (const p of b.positions) p.y *= 0.25;
    b.markDirty();
    return b;
  };
  const clamped = slab();
  bevelEdges(clamped, clamped.topology().edges.map((_, i) => i), 100, 2, 0.5, true);
  // 0.49 of the shortest edge, the standoff a corner can afford.
  const explicit = slab();
  bevelEdges(explicit, explicit.topology().edges.map((_, i) => i), 0.5 * 0.49, 2, 0.5, false);

  assert.equal(clamped.faceCount, explicit.faceCount);
  assert.ok(
    Math.abs(volumeOf(clamped) - volumeOf(explicit)) < 1e-6,
    `clamped ${volumeOf(clamped).toFixed(5)} vs explicit ${volumeOf(explicit).toFixed(5)}`,
  );
  assert.ok(clamped.topology().edges.every((e) => e.faces.length === 2));
});

test('a rounded cube has the volume a rounded cube should have', () => {
  // The arc has to be centred where a real fillet's is, not on the original
  // vertex. Steiner's formula gives the answer to check against: a box of side
  // `a` grown by a ball of radius r.
  const r = 0.5;
  const a = 2 - 2 * r;
  const want = a ** 3 + 6 * a * a * r + 12 * a * (Math.PI * r * r / 4) + (4 / 3) * Math.PI * r ** 3;
  const cube = buildPrimitive('cube');
  bevelEdges(cube, cube.topology().edges.map((_, i) => i), r, 16, 0.5, true);
  const got = Math.abs(volumeOf(cube));
  assert.ok(Math.abs(got - want) / want < 0.01, `rounded cube came to ${got.toFixed(4)}, wanted ${want.toFixed(4)}`);
  assert.ok(cube.topology().edges.every((e) => e.faces.length === 2), 'the rounded cube is not closed');
});

test('an edge weight of zero leaves that edge sharp', () => {
  const cube = buildPrimitive('cube');
  const t = cube.topology();
  const all = t.edges.map((_, i) => i);
  markBevelWeight(cube, [all[0]], 0);
  const weighted = cube.clone();

  const plain = buildPrimitive('cube');
  bevelEdges(plain, plain.topology().edges.map((_, i) => i), 0.1, 1, 0.5, true);
  bevelEdges(weighted, all, 0.1, 1, 0.5, true);

  assert.ok(
    weighted.faceCount < plain.faceCount,
    `weighted bevel made ${weighted.faceCount} faces, unweighted ${plain.faceCount}`,
  );
  assert.ok(weighted.topology().edges.every((e) => e.faces.length === 2), 'a zero weight opened a hole');
});

test('bevel weights survive a save and load', () => {
  const cube = buildPrimitive('cube');
  markBevelWeight(cube, [0, 3], 0.25);
  const back = Mesh.fromJSON(JSON.parse(JSON.stringify(cube.toJSON())));
  const e0 = back.topology().edges[0];
  assert.equal(back.bevelWeight(e0.a, e0.b), 0.25);
  assert.equal(cube.clone().bevelWeight(e0.a, e0.b), 0.25);
});
