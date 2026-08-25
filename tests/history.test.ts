import test from 'node:test';
import assert from 'node:assert/strict';
import { History, SnapshotStore } from '../src/editor/history';
import { RecoveryStore, memoryBackend, formatAge } from '../src/editor/recovery';
import { Scene } from '../src/scene/Scene';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { Vec3 } from '../src/core/math';
import { SelectMode } from '../src/render/Renderer';

function sceneWith(count: number, dense = false): Scene {
  const s = new Scene();
  for (let i = 0; i < count; i++) {
    const o = s.add('mesh', `cube${i}`, dense ? catmullClark(buildPrimitive('cube'), 2) : buildPrimitive('cube'));
    o.position = new Vec3(i * 3, 0, 0);
  }
  return s;
}

function snap(scene: Scene, store: SnapshotStore, label: string) {
  return {
    label,
    scene: scene.toJSON(store),
    mode: 'object' as const,
    editObject: null,
    selectMode: 'vertex' as SelectMode,
    verts: [],
    edges: [],
    faces: [],
  };
}

test('snapshots share the meshes an edit did not touch', () => {
  const scene = sceneWith(4);
  const store = new SnapshotStore();
  const first = scene.toJSON(store);

  // Edit one object.
  const target = [...scene.objects.values()][1];
  target.mesh!.positions[0].x += 1;
  target.mesh!.markDirty();
  const second = scene.toJSON(store);

  assert.notEqual(first.objects[1].mesh, second.objects[1].mesh, 'the edited mesh should be re-serialized');
  for (const i of [0, 2, 3]) {
    assert.equal(first.objects[i].mesh, second.objects[i].mesh, `object ${i} was copied for no reason`);
  }
});

test('serializing again without an edit reuses the same data', () => {
  const scene = sceneWith(2);
  const store = new SnapshotStore();
  const a = scene.toJSON(store);
  const b = scene.toJSON(store);
  assert.equal(a.objects[0].mesh, b.objects[0].mesh);
  assert.equal(a.objects[1].mesh, b.objects[1].mesh);
});

test('sharing does not leak between restored scenes', () => {
  // Restoring has to deep-copy: if a restored mesh aliased the snapshot's
  // arrays, the next edit would silently rewrite history.
  const scene = sceneWith(1);
  const store = new SnapshotStore();
  const saved = scene.toJSON(store);
  const restored = Scene.fromJSON(saved);
  const mesh = [...restored.objects.values()][0].mesh!;
  mesh.positions[0].x = 99;
  mesh.faces[0].push(0);
  assert.notEqual(saved.objects[0].mesh!.positions[0], 99);
  assert.equal(saved.objects[0].mesh!.faces[0].length, 4);
});

test('history stays inside its memory budget by dropping the oldest steps', () => {
  const scene = sceneWith(1, true);
  const history = new History(64, 1);
  for (let i = 0; i < 5; i++) {
    history.push(snap(scene, history.store, `step ${i}`));
    scene.objects.values().next().value!.mesh!.positions[0].x += 1;
    scene.objects.values().next().value!.mesh!.markDirty();
  }
  // A one-byte budget cannot hold anything, but undo has to stay possible.
  assert.equal(history.depth, 1);
  assert.equal(history.nextUndoLabel, 'step 4');
  assert.ok(history.canUndo);
});

test('a generous budget keeps every step', () => {
  const scene = sceneWith(1);
  const history = new History(64, 1024 * 1024 * 1024);
  for (let i = 0; i < 10; i++) history.push(snap(scene, history.store, `step ${i}`));
  assert.equal(history.depth, 10);
});

test('the step limit still applies', () => {
  const scene = sceneWith(1);
  const history = new History(3, 1024 * 1024 * 1024);
  for (let i = 0; i < 10; i++) history.push(snap(scene, history.store, `step ${i}`));
  assert.equal(history.depth, 3);
  assert.equal(history.nextUndoLabel, 'step 9');
});

test('shared meshes are only counted once against the budget', () => {
  const scene = sceneWith(3, true);
  const history = new History(64, 1024 * 1024 * 1024);
  history.push(snap(scene, history.store, 'one'));
  const single = history.footprint();
  for (let i = 0; i < 9; i++) history.push(snap(scene, history.store, `more ${i}`));
  assert.equal(history.depth, 10);
  assert.equal(history.footprint(), single, 'ten snapshots of an unchanged scene should cost one');
});

// ------------------------------------------------------------- recovery

test('recovery keeps a rolling set of copies, newest first', async () => {
  const store = new RecoveryStore(3);
  store.use(memoryBackend());
  for (let i = 0; i < 5; i++) {
    const scene = sceneWith(i + 1);
    const res = await store.save(scene.toJSON(), `save ${i}`);
    assert.ok(res.ok, res.reason);
    // Slots are keyed by timestamp, so keep them distinct.
    await new Promise((r) => setTimeout(r, 2));
  }
  const slots = await store.list();
  assert.equal(slots.length, 3, 'older copies should have been pruned');
  assert.ok(slots[0].savedAt >= slots[1].savedAt);
  assert.equal(slots[0].objectCount, 5);
});

test('the newest copy round-trips back into a scene', async () => {
  const store = new RecoveryStore();
  store.use(memoryBackend());
  const scene = sceneWith(2);
  await store.save(scene.toJSON(), 'Autosave');
  const rec = await store.latest();
  assert.ok(rec);
  const back = Scene.fromJSON(rec!.scene);
  assert.equal(back.objects.size, 2);
  assert.equal([...back.objects.values()][0].mesh!.faceCount, 6);
});

test('a backend that refuses every write reports failure instead of throwing', async () => {
  const store = new RecoveryStore();
  const broken = memoryBackend();
  broken.put = async () => {
    throw new Error('quota exceeded');
  };
  store.use(broken);
  const res = await store.save(sceneWith(1).toJSON(), 'Autosave');
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /quota/i);
  assert.deepEqual(await store.list(), []);
});

test('overlapping saves do not interleave', async () => {
  const store = new RecoveryStore(10);
  const backend = memoryBackend();
  const inner = backend.put.bind(backend);
  let inFlight = 0;
  backend.put = async (rec) => {
    inFlight++;
    assert.equal(inFlight, 1, 'two saves ran at once');
    await new Promise((r) => setTimeout(r, 1));
    await inner(rec);
    inFlight--;
  };
  store.use(backend);
  await Promise.all([1, 2, 3].map((i) => store.save(sceneWith(i).toJSON(), `save ${i}`)));
  assert.ok((await store.list()).length >= 1);
});

test('discard clears the copies', async () => {
  const store = new RecoveryStore();
  store.use(memoryBackend());
  await store.save(sceneWith(1).toJSON(), 'Autosave');
  assert.equal((await store.list()).length, 1);
  await store.discard();
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.latest(), null);
});

test('ages read the way a person would say them', () => {
  assert.equal(formatAge(5000), '5s ago');
  assert.equal(formatAge(120000), '2 min ago');
  assert.equal(formatAge(3 * 3600 * 1000), '3 h ago');
  assert.equal(formatAge(2 * 24 * 3600 * 1000), '2 days ago');
});
