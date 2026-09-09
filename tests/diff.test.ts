import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from '../src/core/math';
import { Scene } from '../src/scene/Scene';
import { createCube, createPlane, createUVSphere } from '../src/mesh/primitives';
import { catmullClark, extrudeFaces, subdivideFaces } from '../src/mesh/ops';
import { createModifier } from '../src/modifiers';
import { FaceChange, MeshDiff, diffMesh, diffScene, faceSignature, summarise } from '../src/diff';
import { Mesh } from '../src/mesh/Mesh';
import { buildPrimitive } from '../src/mesh/primitives';
import { normaliseProvenance } from '../src/build/provenance';

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

// ------------------------------------------- what the comparison did not read

test('the same number of different faces moving is a different signature', () => {
  // The renderer holds its vertex buffers until something it keys on changes.
  // Keying on counts alone meant that moving a different set of the same
  // number of faces looked identical to it, so the viewport went on showing
  // the tints from the previous comparison.
  const a: FaceChange[] = ['unchanged', 'moved', 'unchanged', 'unchanged'];
  const b: FaceChange[] = ['unchanged', 'unchanged', 'moved', 'unchanged'];
  assert.equal(a.filter((f) => f === 'moved').length, b.filter((f) => f === 'moved').length);
  assert.notEqual(faceSignature(a), faceSignature(b), 'the cache would not have noticed');
  assert.equal(faceSignature(a), faceSignature([...a]), 'the same picture must be the same key');
  assert.notEqual(faceSignature(a), faceSignature([...a, 'unchanged']));
});

test('a changed material value is reported even though no object was touched', () => {
  const scene = new Scene();
  scene.ensureDefaultMaterial();
  const cube = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  cube.materialSlots = [0];
  const before = JSON.parse(JSON.stringify(scene.toJSON()));

  scene.materials[0].color = [1, 0, 0];
  const diff = diffScene(before, scene.toJSON());

  assert.equal(diff.identical, false, 'turning a material red reported no differences');
  const row = diff.objects.find((o) => o.id === cube.id)!;
  assert.equal(row.materialValuesChanged, true);
  assert.equal(row.materialChanged, false, 'the object still points at the same slot');
  assert.equal(row.status, 'changed');
});

test('an unwrap with no vertex moved is a change, not "identical"', () => {
  const scene = new Scene();
  const cube = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const before = JSON.parse(JSON.stringify(scene.toJSON()));

  cube.mesh!.faceUV = cube.mesh!.faces.map(() => [0, 0, 1, 0, 1, 1, 0, 1]);
  cube.mesh!.markDirty();
  const diff = diffScene(before, scene.toJSON());

  assert.equal(diff.identical, false, 'a UV change was reported as no change at all');
  const row = diff.objects.find((o) => o.id === cube.id)!;
  assert.equal(row.attributesChanged, true);
  assert.equal(row.mesh!.attributes.uv, true);
  assert.equal(row.mesh!.moved, 0, 'no vertex actually moved');
  assert.match(summarise(diff), /UVs/);
});

test('vertex colours, weights, seams and smoothing are each examined', () => {
  const base = () => {
    const scene = new Scene();
    scene.add('mesh', 'Cube', buildPrimitive('cube'));
    return scene;
  };
  const check = (name: string, mutate: (m: Mesh) => void, field: keyof MeshDiff['attributes']) => {
    const scene = base();
    const cube = [...scene.objects.values()][0];
    const before = JSON.parse(JSON.stringify(scene.toJSON()));
    mutate(cube.mesh!);
    cube.mesh!.markDirty();
    const diff = diffScene(before, scene.toJSON());
    assert.equal(diff.identical, false, `${name} was not examined`);
    assert.equal(diff.objects.find((o) => o.id === cube.id)!.mesh!.attributes[field], true, name);
  };
  check('vertex colours', (m) => { m.colors = new Array(m.vertCount * 3).fill(0.5); }, 'colors');
  check('skin weights', (m) => {
    m.skin = { bones: new Array(m.vertCount * 4).fill(0), weights: new Array(m.vertCount * 4).fill(0.25) };
  }, 'skin');
  check('seams', (m) => { m.seams = new Set(['0-1']); }, 'seams');
  check('smoothing', (m) => { m.setAllSmooth(true); }, 'smoothing');
});

test('a modifier stack makes the answer uncertain, and says so', () => {
  const scene = new Scene();
  const cube = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const before = JSON.parse(JSON.stringify(scene.toJSON()));
  cube.modifiers = [createModifier('subdivision')];
  const diff = diffScene(before, scene.toJSON());

  const row = diff.objects.find((o) => o.id === cube.id)!;
  assert.equal(row.modifiersChanged, true);
  assert.equal(row.uncertain, true);
  assert.match(row.uncertainty ?? '', /modifiers/);
  // And the scene-level answer admits what it did not compare.
  assert.ok(diff.notExamined.some((n) => /modifier/.test(n)));
  assert.equal(diff.identical, false);
});

test('"identical" is never claimed over something that was not read', () => {
  const scene = new Scene();
  scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const before = JSON.parse(JSON.stringify(scene.toJSON()));
  // The pixels of an embedded texture are not compared; a different texture
  // list must not therefore come back as "no differences".
  const after = JSON.parse(JSON.stringify(scene.toJSON()));
  after.textures = [{ id: 1, name: 'Photo', url: 'data:image/png;base64,AAAA', width: 2, height: 2 }];
  const diff = diffScene(before, after);
  assert.equal(diff.identical, false);
  assert.ok(diff.notExamined.length > 0);
  assert.match(summarise(diff), /not compared|differ/);

  // And a genuinely identical pair still says so.
  const same = diffScene(before, JSON.parse(JSON.stringify(before)));
  assert.equal(same.identical, true);
  assert.deepEqual(same.notExamined, []);
  assert.equal(summarise(same), 'No differences');
});

test('a regenerated part is paired by its identity, not lost and re-added', () => {
  // A revision replaces objects, so ids do not survive it. Without a second
  // way to pair them, every part of a revised asset would read as one deletion
  // plus one unrelated addition.
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  root.provenance = normaliseProvenance({
    source: 'recipe', assetId: 'asset-1', generator: 'recipe:Test', params: {}, baseline: {},
  });
  const part = scene.add('mesh', 'Step 1', buildPrimitive('cube'));
  part.partKey = 'step#1';
  scene.setParent(part.id, root.id);
  const before = JSON.parse(JSON.stringify(scene.toJSON()));

  // Rebuilt: same asset, same part key, a brand new object id.
  scene.remove(part.id);
  const rebuilt = scene.add('mesh', 'Step 1', buildPrimitive('cube'));
  rebuilt.partKey = 'step#1';
  rebuilt.position = new Vec3(0, 0, 1);
  scene.setParent(rebuilt.id, root.id);

  const diff = diffScene(before, scene.toJSON());
  const row = diff.objects.find((o) => o.id === rebuilt.id)!;
  assert.equal(row.status, 'changed', 'the regenerated part read as a brand new object');
  assert.equal(row.transformChanged, true);
  assert.equal(row.uncertain, true, 'a match that is not by id must say so');
  assert.match(row.uncertainty ?? '', /part identity/);
  assert.equal(diff.removed, 0, 'the old part was reported as deleted');
  assert.equal(diff.added, 0);
});

test('faces matched by index and by position are counted apart', () => {
  const scene = new Scene();
  const cube = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  const before = JSON.parse(JSON.stringify(scene.toJSON()));
  cube.mesh!.positions[0].x += 0.5;
  cube.mesh!.markDirty();
  const diff = diffScene(before, scene.toJSON());
  const mesh = diff.objects.find((o) => o.id === cube.id)!.mesh!;
  assert.equal(mesh.matchedByIndex, 6, 'a cube has six faces and numbering did not change');
  assert.equal(mesh.matchedByPosition, 0);
});
