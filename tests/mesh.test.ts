import test from 'node:test';
import assert from 'node:assert/strict';
import { Mat4, Vec3 } from '../src/core/math';
import { Mesh } from '../src/mesh/Mesh';
import { createCube, createCylinder, createGrid, createIcoSphere, createPlane, createUVSphere } from '../src/mesh/primitives';
import {
  catmullClark, deleteFaces, dissolveFaces, duplicateFaces, edgeRing, extrudeFaces, flipNormals,
  insetFaces, loopCut, makeFace, mergeByDistance, recalculateNormals, subdivideFaces,
  translateVerts, triangulateFaces,
} from '../src/mesh/ops';

/** Signed volume of a closed mesh; positive when outward-facing. */
function volume(m: Mesh): number {
  let v = 0;
  for (const loop of m.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      v += m.positions[loop[0]].dot(m.positions[loop[i]].cross(m.positions[loop[i + 1]])) / 6;
    }
  }
  return v;
}

/** A closed manifold has every edge used by exactly two faces. */
function isClosed(m: Mesh): boolean {
  return m.topology().edges.every((e) => e.faces.length === 2);
}

test('cube topology is a closed manifold with Euler characteristic 2', () => {
  const c = createCube();
  assert.equal(c.vertCount, 8);
  assert.equal(c.faceCount, 6);
  assert.equal(c.edgeCount, 12);
  assert.equal(c.vertCount - c.edgeCount + c.faceCount, 2);
  assert.ok(isClosed(c));
});

test('primitives are outward-facing and closed', () => {
  for (const m of [createCube(), createUVSphere(1, 12, 8), createIcoSphere(1, 1), createCylinder()]) {
    assert.ok(isClosed(m), 'closed');
    assert.ok(volume(m) > 0, 'outward normals');
  }
});

test('cube face normals point away from the centre', () => {
  const c = createCube();
  const t = c.topology();
  for (let f = 0; f < c.faceCount; f++) {
    assert.ok(t.faceNormals[f].dot(t.faceCenters[f].normalized()) > 0.99);
  }
});

test('extrude keeps the mesh closed and grows its volume', () => {
  const c = createCube();
  const before = volume(c);
  const r = extrudeFaces(c, [1]); // +Z face
  translateVerts(c, r.movedVerts, r.normal.scale(1));
  assert.ok(isClosed(c), 'still closed');
  assert.equal(r.walls.length, 4);
  assert.ok(Math.abs(volume(c) - (before + 4)) < 1e-9, `volume ${volume(c)}`);
  assert.ok(r.normal.equals(new Vec3(0, 0, 1)));
});

test('extruding a multi-face region only walls the region boundary', () => {
  const g = createGrid(2, 2); // 4 quads
  const r = extrudeFaces(g, [0, 1, 2, 3]);
  assert.equal(r.walls.length, 8, 'outer boundary only');
  translateVerts(g, r.movedVerts, new Vec3(0, 0, 1));
  assert.equal(g.faceCount, 4 + 8);
});

test('inset shrinks a face and adds a ring', () => {
  const c = createCube();
  const r = insetFaces(c, [1], 0.25, 0);
  assert.equal(r.ring.length, 4);
  assert.ok(isClosed(c));
  const inner = c.faces[1].map((v) => c.positions[v]);
  for (const p of inner) {
    assert.ok(Math.abs(p.z - 1) < 1e-9, 'stays in plane');
    assert.ok(Math.max(Math.abs(p.x), Math.abs(p.y)) < 1, 'moved inward');
  }
});

test('loop cut splits a ring of quads', () => {
  const c = createCube();
  const edge = c.findEdge(0, 1);
  const ring = edgeRing(c, edge);
  assert.equal(ring.faces.length, 4, 'ring goes all the way round');
  assert.ok(ring.cyclic);
  const before = volume(c);
  const r = loopCut(c, edge, 1);
  assert.equal(r.newVerts.length, 4);
  assert.equal(c.faceCount, 6 + 4);
  assert.ok(isClosed(c));
  assert.ok(Math.abs(volume(c) - before) < 1e-9, 'shape unchanged');
});

test('loop cut with several cuts', () => {
  const c = createCube();
  const r = loopCut(c, c.findEdge(0, 1), 3);
  assert.equal(r.newVerts.length, 12);
  assert.ok(isClosed(c));
  assert.equal(c.faceCount, 2 + 4 * 4);
});

test('catmull-clark converges toward a sphere and stays closed', () => {
  const c = createCube();
  const s = catmullClark(c, 2);
  assert.ok(isClosed(s));
  assert.ok(s.faces.every((f) => f.length === 4), 'all quads');
  const r = s.positions.map((p) => p.length());
  const spread = Math.max(...r) - Math.min(...r);
  assert.ok(spread < 0.35, `radii spread ${spread}`);
  assert.ok(volume(s) > 0);
});

test('catmull-clark preserves an open boundary', () => {
  const p = createPlane();
  const s = catmullClark(p, 1);
  assert.equal(s.faceCount, 4);
  const b = s.bounds();
  assert.ok(Math.abs(b.max.x - 1) < 1e-6 && Math.abs(b.min.x + 1) < 1e-6, 'corners pinned');
});

test('subdivide faces keeps the mesh watertight via n-gon joins', () => {
  const c = createCube();
  subdivideFaces(c, [1]);
  assert.ok(isClosed(c), 'no T-junction holes');
  assert.equal(c.faceCount, 5 + 4);
  assert.ok(Math.abs(volume(c) - 8) < 1e-9);
});

test('merge by distance welds coincident vertices', () => {
  const a = createPlane();
  const b = createPlane();
  b.transform(Mat4.translation(new Vec3(2, 0, 0)));
  a.append(b);
  assert.equal(a.vertCount, 8);
  const removed = mergeByDistance(a, null, 1e-6);
  assert.equal(removed, 2);
  assert.equal(a.vertCount, 6);
  assert.equal(a.faceCount, 2);
});

test('recalculate normals fixes inverted faces', () => {
  const c = createCube();
  flipNormals(c, [0, 2, 4]);
  recalculateNormals(c);
  assert.ok(volume(c) > 0);
  const t = c.topology();
  for (let f = 0; f < c.faceCount; f++) {
    assert.ok(t.faceNormals[f].dot(t.faceCenters[f].normalized()) > 0.99, `face ${f}`);
  }
});

test('delete faces removes the faces and any orphaned vertices', () => {
  const c = createCube();
  deleteFaces(c, [1]);
  assert.equal(c.faceCount, 5);
  assert.equal(c.vertCount, 8, 'corners still used by side faces');
  const t = c.topology();
  assert.equal(t.edges.filter((e) => e.faces.length === 1).length, 4, 'open rim');
});

test('dissolve faces merges a region into one n-gon', () => {
  const g = createGrid(2, 2);
  const made = dissolveFaces(g, [0, 1, 2, 3]);
  assert.equal(made.length, 1);
  assert.equal(g.faceCount, 1);
  assert.equal(g.faces[0].length, 8, 'perimeter of the 2x2 grid');
});

test('make face closes a hole', () => {
  const c = createCube();
  deleteFaces(c, [1]);
  const rim = new Set<number>();
  const t = c.topology();
  for (const e of t.edges) if (e.faces.length === 1) { rim.add(e.a); rim.add(e.b); }
  const f = makeFace(c, [...rim]);
  assert.ok(f !== null);
  assert.ok(isClosed(c));
});

test('duplicate faces creates disconnected geometry', () => {
  const c = createCube();
  const d = duplicateFaces(c, [0]);
  assert.equal(d.faces.length, 1);
  assert.equal(d.verts.size, 4);
  assert.equal(c.vertCount, 12);
});

test('triangulate turns quads into triangles without changing volume', () => {
  const c = createCube();
  triangulateFaces(c);
  assert.equal(c.faceCount, 12);
  assert.ok(c.faces.every((f) => f.length === 3));
  assert.ok(Math.abs(volume(c) - 8) < 1e-9);
});

test('serialization round-trips', () => {
  const c = createUVSphere(1, 8, 6);
  const back = Mesh.fromJSON(JSON.parse(JSON.stringify(c.toJSON())));
  assert.equal(back.vertCount, c.vertCount);
  assert.equal(back.faceCount, c.faceCount);
  assert.ok(back.positions[5].equals(c.positions[5]));
  assert.equal(back.shadeSmooth, true);
});
