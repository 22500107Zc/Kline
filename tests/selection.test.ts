import test from 'node:test';
import assert from 'node:assert/strict';
import { createCube, createGrid } from '../src/mesh/primitives';
import { deriveSelection, elementCount, emptySelection, pruneSelection } from '../src/editor/selection';
import { edgeRing } from '../src/mesh/ops';

test('deriving from vertices needs every vertex of an edge or face', () => {
  const c = createCube();
  const sel = emptySelection();
  // The +Z face of the default cube.
  for (const v of c.faces[1]) sel.verts.add(v);
  deriveSelection(c, sel, 'vertex');
  assert.equal(sel.faces.size, 1);
  assert.ok(sel.faces.has(1));
  assert.equal(sel.edges.size, 4, 'only the rim edges of that face');
});

test('an edge ring stays a ring instead of bleeding into the whole mesh', () => {
  const c = createCube();
  const ring = edgeRing(c, c.findEdge(0, 1));
  const sel = emptySelection();
  for (const e of ring.edges) sel.edges.add(e);
  deriveSelection(c, sel, 'edge');
  assert.equal(sel.edges.size, 4, 'the ring itself');
  assert.equal(sel.verts.size, 8, 'every corner is an endpoint');
  assert.equal(sel.faces.size, 0, 'no face has all four of its edges in the ring');

  // Deriving those same vertices the vertex-mode way would select everything —
  // which is exactly the failure the mode-authoritative model avoids.
  const naive = emptySelection();
  naive.verts = new Set(sel.verts);
  deriveSelection(c, naive, 'vertex');
  assert.equal(naive.edges.size, 12);
});

test('deriving from faces takes everything the faces touch', () => {
  const g = createGrid(2, 2);
  const sel = emptySelection();
  sel.faces.add(0);
  deriveSelection(g, sel, 'face');
  assert.equal(sel.verts.size, 4);
  assert.equal(sel.edges.size, 4);
});

test('a face is selected from edges only when all of its edges are', () => {
  const c = createCube();
  const t = c.topology();
  const sel = emptySelection();
  for (const e of t.faceEdges[1]) sel.edges.add(e);
  deriveSelection(c, sel, 'edge');
  assert.ok(sel.faces.has(1));
  assert.equal(sel.faces.size, 1);

  sel.edges.delete(t.faceEdges[1][0]);
  deriveSelection(c, sel, 'edge');
  assert.equal(sel.faces.size, 0, 'one missing edge is enough to drop the face');
});

test('mode switches round-trip a face selection', () => {
  const c = createCube();
  const sel = emptySelection();
  sel.faces.add(1);
  deriveSelection(c, sel, 'face');   // face -> vertex/edge
  deriveSelection(c, sel, 'vertex'); // vertex -> edge/face
  assert.ok(sel.faces.has(1));
  assert.equal(sel.faces.size, 1);
});

test('element counts follow the select mode', () => {
  const c = createCube();
  assert.equal(elementCount(c, 'vertex'), 8);
  assert.equal(elementCount(c, 'edge'), 12);
  assert.equal(elementCount(c, 'face'), 6);
});

test('pruning drops indices that no longer exist', () => {
  const c = createCube();
  const sel = emptySelection();
  sel.verts.add(7);
  sel.verts.add(99);
  sel.edges.add(50);
  sel.faces.add(5);
  sel.faces.add(12);
  pruneSelection(c, sel);
  assert.deepEqual([...sel.verts], [7]);
  assert.deepEqual([...sel.edges], []);
  assert.deepEqual([...sel.faces], [5]);
});
