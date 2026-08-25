import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from '../src/core/math';
import { Scene } from '../src/scene/Scene';
import { createCube, createPlane, createUVSphere } from '../src/mesh/primitives';
import { catmullClark, extrudeFaces, subdivideFaces } from '../src/mesh/ops';
import { createModifier } from '../src/modifiers';
import { diffMesh, diffScene, summarise } from '../src/diff';

/** A scene holding one mesh, which is what most of these compare. */
function sceneWith(mesh: ReturnType<typeof createCube>, name = 'Cube'): Scene {
  const scene = new Scene();
  const obj = scene.add('mesh', name);
  obj.mesh = mesh;
  return scene;
}

const json = (s: Scene) => JSON.parse(JSON.stringify(s.toJSON()));

test('a mesh compared against itself has no differences at all', () => {
  const mesh = createUVSphere();
  const d = diffMesh(mesh.toJSON(), mesh.toJSON());
  assert.ok(d);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.moved, 0);
  assert.equal(d.unchanged, mesh.faceCount);
});

test('moving one vertex marks only the faces that touch it', () => {
  const before = createCube();
  const after = createCube();
  after.positions[0] = after.positions[0].add(new Vec3(0.3, 0, 0));
  after.markDirty();

  const d = diffMesh(before.toJSON(), after.toJSON());
  assert.ok(d);
  assert.equal(d.added, 0, 'nothing was added');
  assert.equal(d.removed, 0, 'nothing was removed');
  // A cube vertex belongs to three faces, and only those three moved.
  const touching = before.faces.filter((f) => f.includes(0)).length;
  assert.equal(d.moved, touching, `expected ${touching} moved faces, got ${d.moved}`);
  assert.equal(d.unchanged, before.faceCount - touching);
});

test('extruding a face reads as added geometry, not as the whole mesh changing', () => {
  const before = createCube();
  const after = createCube();
  extrudeFaces(after, [0], 0.5);

  const d = diffMesh(before.toJSON(), after.toJSON());
  assert.ok(d);
  assert.ok(d.added > 0, 'the extrusion added no faces');
  // The five faces the extrusion did not touch must still read as unchanged;
  // a diff that lights up the whole model is no more use than no diff at all.
  assert.ok(d.unchanged >= 5, `only ${d.unchanged} faces were recognised as untouched`);
});

test('renumbering a mesh without changing its shape shows nothing', () => {
  // The hard case: an operator rebuilds the arrays, so index-for-index
  // comparison sees a completely different mesh while the surface is
  // identical. Matching on where the corners are is what survives this.
  const before = createCube();
  const after = createCube();
  const order = [3, 1, 5, 0, 4, 2];
  after.faces = order.map((i) => before.faces[i].slice());
  after.faceMaterial = order.map((i) => before.faceMaterial[i]);
  // Renumber the vertices too, rewriting every loop to match.
  const remap = [4, 0, 6, 2, 5, 1, 7, 3];
  const positions = new Array(after.positions.length);
  after.positions.forEach((p, i) => { positions[remap[i]] = p; });
  after.positions = positions;
  after.faces = after.faces.map((f) => f.map((v) => remap[v]));
  after.markDirty();

  const d = diffMesh(before.toJSON(), after.toJSON());
  assert.ok(d);
  assert.equal(d.added, 0, `${d.added} faces looked new after a pure renumbering`);
  assert.equal(d.removed, 0, `${d.removed} faces looked deleted after a pure renumbering`);
  assert.equal(d.unchanged, before.faceCount);
});

test('winding direction and starting corner do not count as a change', () => {
  const before = createPlane();
  const after = createPlane();
  after.faces = after.faces.map((f) => [...f].reverse());
  after.markDirty();
  const d = diffMesh(before.toJSON(), after.toJSON());
  assert.ok(d);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test('deleting geometry is reported as removed, with the loops to draw', () => {
  const before = createCube();
  const after = createCube();
  after.faces = after.faces.slice(0, 4);
  after.faceMaterial = after.faceMaterial.slice(0, 4);
  after.markDirty();

  const d = diffMesh(before.toJSON(), after.toJSON());
  assert.ok(d);
  assert.equal(d.removed, 2, 'two faces went missing');
  assert.equal(d.removedFaces.length, 2);
  // The removed loops have to be drawable, so they need positions to point at.
  assert.ok(d.removedPositions.length > 0, 'no positions came back for the removed faces');
  for (const loop of d.removedFaces) {
    for (const v of loop) {
      assert.ok(v * 3 + 2 < d.removedPositions.length, `removed loop references vertex ${v} with no position`);
    }
  }
});

test('two identical faces on one side match two on the other, not one', () => {
  // Duplicate keys have to be counted, not collapsed, or a mesh with repeated
  // geometry reports phantom additions.
  const before = createPlane();
  before.faces.push(before.faces[0].slice());
  before.faceMaterial.push(0);
  before.markDirty();
  const after = createPlane();
  after.faces.push(after.faces[0].slice());
  after.faceMaterial.push(0);
  after.markDirty();

  const d = diffMesh(before.toJSON(), after.toJSON());
  assert.ok(d);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.unchanged, 2);
});

test('a subdivided mesh is almost entirely new geometry, and says so', () => {
  const before = createCube();
  const after = catmullClark(createCube(), 2);
  const d = diffMesh(before.toJSON(), after.toJSON());
  assert.ok(d);
  assert.equal(d.added, after.faceCount, 'subdivision should read as all-new faces');
  assert.equal(d.removed, before.faceCount);
});

// ------------------------------------------------------------------- scenes

test('an untouched scene compares clean', () => {
  const scene = sceneWith(createCube());
  const d = diffScene(json(scene), json(scene));
  assert.ok(d.identical, `expected no differences, got: ${summarise(d)}`);
  assert.equal(summarise(d), 'No differences');
});

test('adding and removing objects is reported per object', () => {
  const before = new Scene();
  const keep = before.add('mesh', 'Keep');
  keep.mesh = createCube();
  const gone = before.add('mesh', 'Gone');
  gone.mesh = createPlane();

  const after = Scene.fromJSON(json(before));
  after.remove(gone.id);
  const fresh = after.add('mesh', 'New');
  fresh.mesh = createPlane();

  const d = diffScene(json(before), json(after));
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.objects.find((o) => o.name === 'New')?.status, 'added');
  assert.equal(d.objects.find((o) => o.name === 'Gone')?.status, 'removed');
  assert.equal(d.objects.find((o) => o.name === 'Keep')?.status, 'unchanged');
});

test('a rename is a rename, not a delete next to an unrelated add', () => {
  const before = new Scene();
  const obj = before.add('mesh', 'Before');
  obj.mesh = createCube();
  const after = Scene.fromJSON(json(before));
  [...after.objects.values()][0].name = 'After';

  const d = diffScene(json(before), json(after));
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  const entry = d.objects[0];
  assert.equal(entry.status, 'changed');
  assert.equal(entry.previousName, 'Before');
  assert.equal(entry.name, 'After');
});

test('moving an object is a transform change, not a geometry change', () => {
  const before = sceneWith(createCube());
  const after = Scene.fromJSON(json(before));
  [...after.objects.values()][0].position = new Vec3(3, 0, 0);

  const d = diffScene(json(before), json(after));
  const entry = d.objects[0];
  assert.equal(entry.status, 'changed');
  assert.ok(entry.transformChanged, 'the move was not noticed');
  assert.equal(entry.mesh?.added, 0, 'moving an object should not rewrite its mesh');
  assert.equal(entry.mesh?.moved, 0);
});

test('a modifier added to the stack is reported without touching the mesh', () => {
  const before = sceneWith(createCube());
  const after = Scene.fromJSON(json(before));
  [...after.objects.values()][0].modifiers.push(createModifier('subsurf'));

  const d = diffScene(json(before), json(after));
  const entry = d.objects[0];
  assert.ok(entry.modifiersChanged, 'the new modifier was not noticed');
  assert.equal(entry.mesh?.added, 0, 'the base mesh did not change');
});

test('editing geometry inside an object is found through the scene diff', () => {
  const before = sceneWith(createCube());
  const after = Scene.fromJSON(json(before));
  const mesh = [...after.objects.values()][0].mesh!;
  subdivideFaces(mesh, [0]);

  const d = diffScene(json(before), json(after));
  assert.equal(d.changed, 1);
  assert.ok((d.objects[0].mesh?.added ?? 0) > 0);
  assert.match(summarise(d), /faces/);
});

test('the summary names what actually happened', () => {
  const before = sceneWith(createCube());
  const after = Scene.fromJSON(json(before));
  const extra = after.add('mesh', 'Second');
  extra.mesh = createPlane();

  const text = summarise(diffScene(json(before), json(after)));
  assert.match(text, /1 added/);
  assert.doesNotMatch(text, /removed/);
});

test('comparing an empty scene with a full one does not throw', () => {
  const full = sceneWith(createUVSphere());
  const empty = new Scene();
  const forward = diffScene(json(empty), json(full));
  const back = diffScene(json(full), json(empty));
  assert.equal(forward.added, 1);
  assert.equal(back.removed, 1);
  assert.ok(!forward.identical);
});
