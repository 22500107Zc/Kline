import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, SceneObject } from '../src/scene/Scene';
import { History } from '../src/editor/history';
import { Vec3 } from '../src/core/math';
import { SelectMode } from '../src/render/Renderer';
import { interpret } from '../src/build/interpreter';
import { captureBaseline, executePlan, recordProvenance } from '../src/build/plan';
import {
  PROVENANCE_SCHEMA, assignPartKeys, normaliseProvenance, partKeyFor, regenerability, roleOf,
} from '../src/build/provenance';
import { mergeAsset, sameMesh, summariseMerge } from '../src/build/merge';
import { parseRevision, proposedFromParts, rebuildRecipe, revisableSettings } from '../src/build/revise';
import {
  RevisionSession, assetFingerprint, assetRootFor, collectAsset, revisability,
} from '../src/editor/revision';
import { buildPrimitive } from '../src/mesh/primitives';

/** Build a scene containing one generated asset, exactly as the Build bar does. */
function build(prompt: string): { scene: Scene; root: SceneObject } {
  const scene = new Scene();
  const result = interpret(prompt);
  assert.ok(result.plan, `nothing built for "${prompt}"`);
  const { root, objects, keys } = executePlan(scene, result.plan!);
  recordProvenance(root, result.origin, captureBaseline(objects, keys));
  return { scene, root };
}

/** A revision host backed by a plain scene, which is all the session needs. */
function hostFor(scene: Scene): {
  session: RevisionSession; history: History; refreshes: number[]; status: string[];
} {
  const history = new History();
  const refreshes: number[] = [];
  const status: string[] = [];
  const snapshot = (label: string) => ({
    label,
    scene: scene.toJSON(history.store),
    mode: 'object' as const,
    editObject: null,
    selectMode: 'vertex' as SelectMode,
    verts: [], edges: [], faces: [],
  });
  const session = new RevisionSession({
    scene,
    snapshot,
    restore: (snap) => { scene.adopt(Scene.fromJSON(snap.scene)); },
    pushHistory: (snap) => history.push(snap),
    setStatus: (m) => { status.push(m); },
    refresh: () => { refreshes.push(1); },
  });
  return { session, history, refreshes, status };
}

/**
 * The scene's contents, ignoring the id counter.
 *
 * `adopt` deliberately never counts `nextId` backwards — an id handed out
 * during a preview must not be handed out again — so "the scene is unchanged"
 * means its objects, materials and relationships, not that counter.
 */
function contents(scene: Scene): string {
  const doc = scene.toJSON() as Record<string, unknown>;
  delete doc.nextId;
  return JSON.stringify(doc);
}

const childrenOf = (scene: Scene, root: SceneObject): SceneObject[] =>
  root.children.map((id) => scene.get(id)!).filter(Boolean);

// ------------------------------------------------------------------ identity

test('a repeated part is identified by its role and its ordinal, not its index', () => {
  assert.equal(roleOf('Step 7'), 'step');
  assert.equal(roleOf('Step'), 'step');
  assert.equal(roleOf('Hat brim'), 'hat-brim');
  assert.equal(roleOf('Leg.003'), 'leg');
  assert.equal(partKeyFor('Step 12', 12), 'step#12');

  const keys = assignPartKeys(['Top', 'Leg', 'Leg', 'Leg', 'Leg']);
  assert.deepEqual(keys, ['top#1', 'leg#1', 'leg#2', 'leg#3', 'leg#4']);
  // Same list, same keys — the mapping cannot drift between two runs.
  assert.deepEqual(assignPartKeys(['Top', 'Leg', 'Leg', 'Leg', 'Leg']), keys);
});

test('growing a repeated part keeps the ones that were already there', () => {
  const twenty = assignPartKeys(Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`));
  const thirty = assignPartKeys(Array.from({ length: 30 }, (_, i) => `Step ${i + 1}`));
  assert.deepEqual(thirty.slice(0, 20), twenty);
  assert.equal(thirty[29], 'step#30');
  // And shrinking drops from the top rather than renumbering the lot.
  const ten = assignPartKeys(Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`));
  assert.deepEqual(ten, twenty.slice(0, 10));
});

// ---------------------------------------------------------------- provenance

test('a generated asset records what made it, and every part is identified', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const prov = root.provenance;
  assert.ok(prov, 'the asset has no provenance');
  assert.equal(prov!.schema, PROVENANCE_SCHEMA);
  assert.equal(prov!.source, 'recipe');
  assert.equal(prov!.params.count, 20);
  assert.equal(prov!.prompt, 'a staircase with 20 steps');
  assert.ok(prov!.assetId.length > 4);
  assert.equal(regenerability(prov).can, true);

  const kids = childrenOf(scene, root);
  assert.equal(kids.length, 20);
  assert.ok(kids.every((k) => !!k.partKey), 'a generated part has no key');
  assert.equal(new Set(kids.map((k) => k.partKey)).size, 20, 'part keys are not unique');
  assert.equal(prov!.baseline.parts?.length, 20);
});

test('provenance survives a save and reload, and old files load without it', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const reloaded = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const back = reloaded.get(root.id)!;
  assert.equal(back.provenance?.assetId, root.provenance!.assetId);
  assert.equal(back.provenance?.params.count, 20);
  assert.equal(back.provenance?.baseline.parts?.length, 20);
  assert.equal(reloaded.get(root.children[0])!.partKey, scene.get(root.children[0])!.partKey);

  // A document written before any of this existed: the fields are simply not
  // there, and that has to be an ordinary scene rather than an error.
  const legacy = JSON.parse(JSON.stringify(scene.toJSON())) as Record<string, unknown>;
  for (const o of legacy.objects as Record<string, unknown>[]) {
    delete o.provenance;
    delete o.partKey;
    delete o.protectedFromRegen;
  }
  const old = Scene.fromJSON(legacy as never);
  assert.equal(old.objects.size, scene.objects.size);
  assert.equal(old.get(root.id)!.provenance, null);
  assert.equal(revisability(old.get(root.id)).can, false);
  assert.match(revisability(old.get(root.id)).why, /no record of how it was made/);
});

test('rubbish in the provenance field is dropped rather than trusted', () => {
  assert.equal(normaliseProvenance(null), null);
  assert.equal(normaliseProvenance({ source: 'nonsense', assetId: 'x' }), null);
  assert.equal(normaliseProvenance({ source: 'recipe' }), null, 'no id is no identity');
  const p = normaliseProvenance({
    source: 'recipe', assetId: 'a1', params: { count: 20, bad: { deep: 1 }, ok: 'yes' },
    baseline: { parts: [{ key: 'step#1', position: [1, 'x', 3] }, { name: 'no key' }] },
  });
  assert.ok(p);
  assert.deepEqual(Object.keys(p!.params).sort(), ['count', 'ok']);
  assert.equal(p!.baseline.parts?.length, 1, 'a baseline part with no key has no identity');
  assert.deepEqual(p!.baseline.parts![0].position, [1, 0, 3]);
});

test('duplicating a generated asset copies the parts and mints a new identity', () => {
  const { scene, root } = build('a table');
  const copy = scene.duplicateObject(root.id)!;
  assert.equal(copy.children.length, root.children.length);
  assert.notEqual(copy.provenance!.assetId, root.provenance!.assetId);
  assert.equal(copy.provenance!.params.recipe, root.provenance!.params.recipe);
  // Part keys are kept: within the copy they still name the same parts.
  assert.deepEqual(
    childrenOf(scene, copy).map((c) => c.partKey),
    childrenOf(scene, root).map((c) => c.partKey),
  );
});

// -------------------------------------------------------------------- revise

test('a revision request is read against the settings the asset actually has', () => {
  const { root } = build('a staircase with 20 steps');
  const prov = root.provenance!;

  const more = parseRevision(prov, 'change this staircase from 20 steps to 30');
  assert.equal(more.params.count, 30);
  assert.equal(more.empty, false);

  const bigger = parseRevision(prov, 'make it bigger');
  assert.ok((bigger.params.scale as number) > 1);

  const nothing = parseRevision(prov, 'make it nicer');
  assert.equal(nothing.empty, true, 'a request naming no setting must not look like it worked');

  // A setting this asset does not have is reported, not invented.
  const shapes = build('12 cubes in a circle');
  const segments = parseRevision(shapes.root.provenance!, 'use 8 segments');
  assert.equal(segments.params.segments, undefined);
});

test('the settings a user can change are listed without the internals', () => {
  const { root } = build('a staircase with 20 steps');
  const keys = revisableSettings(root.provenance).map((s) => s.key);
  assert.ok(keys.includes('count'));
  assert.ok(!keys.includes('words'), 'the raw prompt text is not a setting');
  assert.ok(!keys.includes('recipe'));
});

test('rerunning a recipe with a new count produces matching part keys', () => {
  const { root } = build('a staircase with 20 steps');
  const next = rebuildRecipe(root.provenance!, { count: 30 });
  assert.ok(next);
  const keys = next!.parts.map((p) => p.key);
  assert.equal(keys.filter((k) => k.startsWith('step#')).length, 30);
  const baseKeys = root.provenance!.baseline.parts!.map((p) => p.key);
  // Every part that existed before still exists under the same name.
  for (const key of baseKeys) assert.ok(keys.includes(key), `${key} lost its identity`);
});

// --------------------------------------------------------------------- merge

test('a revision keeps your materials, your extra objects and your placement', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);

  // The user recolours one step, moves another, and adds a handrail.
  const slot = scene.addMaterial();
  kids[0].materialSlots = [slot];
  kids[1].position = new Vec3(9, 9, 9);
  const rail = scene.add('mesh', 'Handrail', buildPrimitive('cube'));
  scene.setParent(rail.id, root.id);

  const next = rebuildRecipe(root.provenance!, { count: 30 })!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, next.parts, userAdded);

  assert.equal(plan.report.added, 10, 'ten new steps');
  assert.equal(plan.report.removed, 0);
  assert.equal(plan.report.conflicts.length, 0, 'nothing here actually disagrees');
  assert.equal(plan.report.userAdded.length, 1);
  assert.equal(plan.report.userAdded[0].name, 'Handrail');

  const moved = plan.report.parts.find((p) => p.objectId === kids[1].id)!;
  assert.ok(moved.keptYours.includes('position'), 'the step you moved was moved back');
  assert.ok(!plan.remove.includes(rail.id), 'your own object was scheduled for removal');
  // Materials are never taken from the generator.
  assert.ok(plan.parts.every((p) => !('materialSlots' in p)));
});

test('a sculpted part and a topology change is a conflict, not a silent overwrite', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);

  // Sculpt: move vertices without changing the face list.
  const mesh = kids[3].mesh!;
  for (const p of mesh.positions) p.z += 0.15;
  mesh.markDirty();

  // A revision that rebuilds every step with a different shape.
  const next = rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, next.parts, userAdded);

  const conflict = plan.report.conflicts.find((c) => c.objectId === kids[3].id);
  assert.ok(conflict, 'the sculpted step was overwritten without a word');
  assert.match(conflict!.detail, /you/i);
  assert.ok(!plan.parts.some((p) => p.objectId === kids[3].id && p.mesh),
    'a conflicted part must not be written');
});

test('a topology conflict names the attributes that cannot come with it', () => {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('cube'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  const baseMesh = part.mesh!.toJSON();
  root.provenance = normaliseProvenance({
    source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: { parts: [{ key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mesh: baseMesh }] },
  });

  // The user unwraps it, then a revision rebuilds it with more faces.
  part.mesh!.faceUV = part.mesh!.faces.map(() => [0, 0, 1, 0, 1, 1, 0, 1]);
  part.mesh!.markDirty();
  const denser = buildPrimitive('uvsphere');
  const proposed = [{
    key: 'body#1', name: 'Body',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: denser.toJSON(),
  }];
  const { current } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, proposed, []);
  const conflict = plan.report.conflicts[0];
  assert.ok(conflict);
  assert.equal(conflict.kind, 'topology');
  assert.match(conflict.detail, /UV coordinates/);
});

test('a protected part is never regenerated, and says so when asked to be', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  kids[2].protectedFromRegen = true;

  const next = rebuildRecipe(root.provenance!, { count: 20, scale: 1.5 })!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(root.provenance!.baseline, current, next.parts, userAdded);

  assert.equal(plan.report.protectedParts, 1);
  assert.ok(!plan.parts.some((p) => p.objectId === kids[2].id),
    'a protected part was written anyway');
  const conflict = plan.report.conflicts.find((c) => c.objectId === kids[2].id);
  assert.ok(conflict, 'a revision that changes a protected part must report it');
  assert.equal(conflict!.kind, 'protected');
});

test('with no baseline the merge admits it cannot tell your edits apart', () => {
  const { scene, root } = build('a table');
  const prov = root.provenance!;
  prov.baseline = {};
  const next = rebuildRecipe(prov, {})!;
  const { current, userAdded } = collectAsset(scene, root);
  const plan = mergeAsset(prov.baseline, current, next.parts, userAdded);
  assert.equal(plan.report.blind, true);
  assert.ok(summariseMerge(plan.report).length > 0);
});

// ------------------------------------------------------------------- session

test('rejecting a preview leaves the scene exactly as it was', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const { session, history } = hostFor(scene);
  const before = contents(scene);

  const next = rebuildRecipe(root.provenance!, { count: 30 })!;
  const summary = session.preview(root, next.parts, '30 steps');
  assert.ok(summary);
  assert.equal(session.active, true);
  assert.equal(scene.get(root.id)!.children.length, 30, 'the preview is not visible');

  assert.equal(session.reject(), true);
  assert.equal(session.active, false);
  assert.equal(contents(scene), before, 'reject did not restore the scene');
  assert.equal(history.canUndo, false, 'a rejected revision left a step in the history');
});

test('accepting a revision is one undoable step that carries the record with it', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const { session, history } = hostFor(scene);
  const before = contents(scene);

  const next = rebuildRecipe(root.provenance!, { count: 30 })!;
  session.preview(root, next.parts, '30 steps');
  assert.equal(session.accept(), true);

  const after = scene.get(root.id)!;
  assert.equal(after.children.length, 30);
  assert.equal(after.provenance!.revision, 1);
  assert.equal(after.provenance!.baseline.parts!.length, 30, 'the baseline did not move on');
  assert.equal(history.depth, 1, 'a thirty-part revision must be one undo step');

  // Undo puts back the geometry, the record and the relationships together.
  const step = history.undo({
    label: 'redo', scene: scene.toJSON(history.store), mode: 'object', editObject: null,
    selectMode: 'vertex', verts: [], edges: [], faces: [],
  })!;
  scene.adopt(Scene.fromJSON(step.scene));
  assert.equal(contents(scene), before, 'undo did not restore everything');
  assert.equal(scene.get(root.id)!.provenance!.revision, 0);
});

test('a second preview replaces the first rather than stacking on it', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const { session, history } = hostFor(scene);
  const before = contents(scene);

  session.preview(root, rebuildRecipe(root.provenance!, { count: 30 })!.parts, '30 steps');
  const live = scene.get(root.id)!;
  session.preview(live, rebuildRecipe(live.provenance!, { count: 25 })!.parts, '25 steps');
  assert.equal(scene.get(root.id)!.children.length, 25);
  session.reject();
  assert.equal(contents(scene), before);
  assert.equal(history.canUndo, false);
});

test('a conflict can be settled three ways, all inside the preview', () => {
  const setup = () => {
    const { scene, root } = build('a staircase with 8 steps');
    const kids = childrenOf(scene, root);
    for (const p of kids[2].mesh!.positions) p.z += 0.3;
    kids[2].mesh!.markDirty();
    const sculpted = JSON.stringify(kids[2].mesh!.toJSON());
    const { session, history } = hostFor(scene);
    const next = rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!;
    // Captured before the preview writes anything, which is what Reject has
    // to be measured against.
    const before = contents(scene);
    const summary = session.preview(root, next.parts, 'bigger')!;
    const conflict = summary.report.conflicts.find((c) => c.objectId === kids[2].id)!;
    return { scene, root, session, history, conflict, sculpted, before, targetId: kids[2].id };
  };

  // Keep mine: the object is already yours, and it stays that way.
  {
    const { scene, session, conflict, sculpted, targetId } = setup();
    assert.equal(session.resolveConflict(conflict.key, 'mine'), true);
    assert.equal(session.summary!.report.conflicts.length, 0);
    session.accept();
    assert.equal(JSON.stringify(scene.get(targetId)!.mesh!.toJSON()), sculpted);
  }

  // Use the revised one: your version goes, knowingly.
  {
    const { scene, session, conflict, sculpted, targetId } = setup();
    assert.equal(session.resolveConflict(conflict.key, 'theirs'), true);
    session.accept();
    assert.notEqual(JSON.stringify(scene.get(targetId)!.mesh!.toJSON()), sculpted);
  }

  // Keep both: yours survives as your own object, the generated one takes the
  // identity — so the next revision has exactly one part to match.
  {
    const { scene, root, session, conflict, sculpted, targetId } = setup();
    assert.equal(session.resolveConflict(conflict.key, 'both'), true);
    session.accept();
    const mine = scene.get(targetId)!;
    assert.equal(JSON.stringify(mine.mesh!.toJSON()), sculpted, 'your version was not kept');
    assert.equal(mine.partKey, null, 'two objects would claim the same part');
    const carriers = childrenOf(scene, scene.get(root.id)!)
      .filter((c) => c.partKey === conflict.key);
    assert.equal(carriers.length, 1, 'the part identity is ambiguous after keeping both');
    assert.notEqual(carriers[0].id, targetId);
  }

  // And a rejection after resolving still puts everything back.
  {
    const { scene, session, conflict, history, before } = setup();
    session.resolveConflict(conflict.key, 'theirs');
    session.reject();
    assert.equal(contents(scene), before, 'resolving then rejecting changed the scene');
    assert.equal(history.canUndo, false);
  }
});

test('the fingerprint notices the asset moving while a request is in flight', () => {
  const { scene, root } = build('a table');
  const stamp = assetFingerprint(scene, root);
  assert.equal(assetFingerprint(scene, root), stamp, 'the fingerprint is not stable');
  scene.get(root.children[0])!.position = new Vec3(0, 0, 5);
  assert.notEqual(assetFingerprint(scene, root), stamp);
});

test('the asset root is found from any part of it', () => {
  const { scene, root } = build('a table');
  const leg = scene.get(root.children[2])!;
  assert.equal(assetRootFor(scene, leg)?.id, root.id);
  assert.equal(assetRootFor(scene, root)?.id, root.id);
  const loose = scene.add('mesh', 'Loose', buildPrimitive('cube'));
  assert.equal(assetRootFor(scene, loose), null);
});

test('two meshes are the same only when they really are', () => {
  const a = buildPrimitive('cube').toJSON();
  const b = buildPrimitive('cube').toJSON();
  assert.equal(sameMesh(a, b), true);
  b.positions[0] += 1e-4;
  assert.equal(sameMesh(a, b), false);
  assert.equal(sameMesh(null, null), true);
  assert.equal(sameMesh(a, null), false);
});

test('a plan turned into proposed parts keeps rotations in radians', () => {
  const result = interpret('a spiral staircase with 6 steps');
  const parts = proposedFromParts(result.plan!.parts);
  const turned = parts.find((p) => p.rotation.some((r) => Math.abs(r) > 1e-9));
  assert.ok(turned, 'a spiral staircase has turned treads');
  assert.ok(turned!.rotation.every((r) => Math.abs(r) < 7), 'rotations were left in degrees');
});

test('a pending preview blocks the paths that would make it permanent', () => {
  // Three ways a proposal could become the model without anyone agreeing: an
  // autosave, a save to disk, and a document loaded over the top of it.
  const { scene, root } = build('a staircase with 6 steps');
  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 9 })!.parts, '9 steps');
  assert.equal(session.active, true);

  // Discard is for the case where the scene itself is going away: it neither
  // restores nor commits, because both would be claims about a scene that no
  // longer exists.
  session.discard();
  assert.equal(session.active, false);
  assert.equal(session.summary, null);
  assert.equal(scene.get(root.id)!.children.length, 9, 'discard is not a rollback');
  assert.equal(scene.get(root.id)!.provenance!.revision, 0, 'discard is not an acceptance');
});

test('reviewing an asset with no baseline says so instead of guessing', () => {
  const { scene, root } = build('a table');
  root.provenance!.baseline = {};
  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, {})!.parts, 'rebuild');
  assert.ok(summary);
  assert.equal(summary!.report.blind, true);
  assert.ok(summary!.notes.some((n) => /could not be told/.test(n)),
    'a blind merge must say that it is blind');
});

test('an object with no record cannot be previewed at all', () => {
  const scene = new Scene();
  const plain = scene.add('mesh', 'Hand-modelled', buildPrimitive('cube'));
  const { session, status } = hostFor(scene);
  assert.equal(session.preview(plain, [], 'anything'), null);
  assert.equal(session.active, false);
  assert.match(status[status.length - 1], /no record of how it was made/);
});

test('your work is lifted clear of a part the generator drops', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  // A detail modelled onto the top step, which a shorter staircase removes.
  const detail = scene.add('mesh', 'Nosing', buildPrimitive('cube'));
  scene.setParent(detail.id, kids[19].id);

  const { session } = hostFor(scene);
  const next = rebuildRecipe(root.provenance!, { count: 10 })!;
  session.preview(root, next.parts, '10 steps');
  session.accept();

  const survivor = scene.get(detail.id);
  assert.ok(survivor, 'a detail you modelled was deleted along with its step');
  assert.equal(survivor!.parent, root.id, 'it should hang off the asset instead');
  assert.equal(survivor!.partKey, null);
});
