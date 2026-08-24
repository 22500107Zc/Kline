import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { bisect, bridgeLoops, chainLoops, edgeChains, pokeFaces, spinEdges, symmetrize } from '../src/mesh/modeling';
import { Mesh } from '../src/mesh/Mesh';
import { Vec3 } from '../src/core/math';

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

test('bisecting a cube in half and capping leaves exactly half the volume', () => {
  const cube = buildPrimitive('cube');
  const r = bisect(cube, new Vec3(0, 0, 1), 0, { clearFront: true, fill: true });
  assert.ok(Math.abs(volume(cube) - 4) < 1e-9);
  assert.ok(watertight(cube));
  assert.equal(r.newFaces.length, 1, 'the cut should cap with one n-gon');
  assert.equal(cube.faceCount, 6);
});

test('bisecting without clearing keeps the whole shape but adds the cut edge', () => {
  const cube = buildPrimitive('cube');
  const before = cube.faceCount;
  bisect(cube, new Vec3(0, 0, 1), 0.3, {});
  assert.ok(Math.abs(volume(cube) - 8) < 1e-9);
  assert.ok(cube.faceCount > before, 'faces crossing the plane should split');
  assert.ok(watertight(cube));
});

test('a plane that misses the mesh changes nothing', () => {
  const cube = buildPrimitive('cube');
  bisect(cube, new Vec3(0, 0, 1), 50, {});
  assert.equal(cube.faceCount, 6);
  assert.ok(Math.abs(volume(cube) - 8) < 1e-9);
});

test('chainLoops closes a ring and drops a dead end', () => {
  const loops = chainLoops([[0, 1], [1, 2], [2, 3], [3, 0], [7, 8]]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 4);
});

test('spin sweeps a profile into a closed surface of revolution', () => {
  const strip = new Mesh(
    [new Vec3(1, 0, -1), new Vec3(1.5, 0, 0), new Vec3(1, 0, 1)],
    [[0, 1, 2]],
  );
  const edges = [strip.findEdge(0, 1), strip.findEdge(1, 2)];
  const r = spinEdges(strip, edges, new Vec3(0, 0, 1), new Vec3(), Math.PI * 2, 12);
  // 12 steps × 2 profile edges, and the last ring welds back onto the first.
  assert.equal(r.newFaces.length, 24);
  assert.equal(strip.vertCount, 3 + 11 * 3);
});

test('a partial spin leaves the ends open', () => {
  const strip = new Mesh([new Vec3(1, 0, 0), new Vec3(1, 0, 1)], [[0, 1, 0]]);
  strip.faces = [[0, 1, 0]];
  strip.markDirty();
  const before = strip.vertCount;
  spinEdges(strip, [0], new Vec3(0, 0, 1), new Vec3(), Math.PI, 4);
  assert.equal(strip.vertCount, before + 4 * 2);
});

test('bridge joins two rings of matching size', () => {
  const m = new Mesh();
  const N = 8;
  const ring = (z: number, r: number): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < N; i++) {
      idx.push(m.positions.length);
      const a = (i / N) * Math.PI * 2;
      m.positions.push(new Vec3(Math.cos(a) * r, Math.sin(a) * r, z));
    }
    return idx;
  };
  const lower = ring(0, 1);
  const upper = ring(2, 1);
  for (let i = 0; i < N; i++) m.faces.push([lower[i], lower[(i + 1) % N], lower[(i + 2) % N]]);
  for (let i = 0; i < N; i++) m.faces.push([upper[i], upper[(i + 1) % N], upper[(i + 2) % N]]);
  m.faceMaterial = new Array(m.faces.length).fill(0);
  m.markDirty();
  const sel: number[] = [];
  for (let i = 0; i < N; i++) {
    sel.push(m.findEdge(lower[i], lower[(i + 1) % N]));
    sel.push(m.findEdge(upper[i], upper[(i + 1) % N]));
  }
  const r = bridgeLoops(m, sel);
  assert.equal(r.error, undefined);
  assert.equal(r.newFaces.length, N);
});

test('bridge reports the problem instead of guessing', () => {
  const cube = buildPrimitive('cube');
  const r = bridgeLoops(cube, [0, 1, 2]);
  assert.ok(r.error);
  assert.equal(r.newFaces.length, 0);
});

test('edgeChains separates an open chain from a closed ring', () => {
  const cube = buildPrimitive('cube');
  const t = cube.topology();
  // Every edge on the z = -1 face forms one ring.
  const ring = t.edges
    .map((_, i) => i)
    .filter((i) => cube.positions[t.edges[i].a].z < 0 && cube.positions[t.edges[i].b].z < 0);
  const chains = edgeChains(cube, ring);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].closed, true);
  assert.equal(chains[0].verts.length, 4);
});

test('symmetrize mirrors the kept half exactly', () => {
  const cube = buildPrimitive('cube');
  // Nudge a +X corner so the two halves start out different.
  const moved = cube.positions.findIndex((p) => p.x > 0 && p.y > 0 && p.z > 0);
  cube.positions[moved] = cube.positions[moved].add(new Vec3(0.5, 0, 0));
  cube.markDirty();
  symmetrize(cube, 0, true);
  assert.ok(watertight(cube));
  // Every vertex should now have a partner at the mirrored position.
  for (const p of cube.positions) {
    const mirrored = new Vec3(-p.x, p.y, p.z);
    assert.ok(
      cube.positions.some((q) => q.distanceTo(mirrored) < 1e-6),
      `no mirror partner for ${p.x},${p.y},${p.z}`,
    );
  }
});

test('poke fans each face out from its centre', () => {
  const cube = buildPrimitive('cube');
  const r = pokeFaces(cube, [0, 1, 2, 3, 4, 5], 0);
  assert.equal(r.newVerts.length, 6);
  assert.equal(cube.faceCount, 24);
  assert.ok(watertight(cube));
  assert.ok(Math.abs(volume(cube) - 8) < 1e-9, 'a flat poke should not change volume');
});
