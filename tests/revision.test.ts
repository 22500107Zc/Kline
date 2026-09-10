import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, SceneObject } from '../src/scene/Scene';
import { History } from '../src/editor/history';
import { Vec3 } from '../src/core/math';
import { SelectMode } from '../src/render/Renderer';
import { interpret } from '../src/build/interpreter';
import { captureBaseline, executePlan, recordProvenance } from '../src/build/plan';
import {
  PROVENANCE_SCHEMA, assignPartKeys, cloneProvenance, normaliseProvenance, partKeyFor,
  regenerability, roleOf,
} from '../src/build/provenance';
import { mergeAsset, sameMesh, summariseMerge } from '../src/build/merge';
import {
  identifiedParts, parseRevision, proposedFromParts, rebuildRecipe, revisableSettings,
} from '../src/build/revise';
import { runProgramHere } from '../src/build/sandbox';
import { validatePlan } from '../src/build/plan';
import {
  RevisionSession, assetFingerprint, assetRootFor, collectAsset, revisability,
} from '../src/editor/revision';
import { buildPrimitive } from '../src/mesh/primitives';
import { createModifier } from '../src/modifiers';
import { catmullClark } from '../src/mesh/ops';

/** Build a scene containing one generated asset, exactly as the Build bar does. */
function build(prompt: string): { scene: Scene; root: SceneObject } {
  const scene = new Scene();
  const result = interpret(prompt);
  assert.ok(result.plan, `nothing built for "${prompt}"`);
  const { root, objects, keys } = executePlan(scene, result.plan!);
  recordProvenance(root, result.origin, captureBaseline(objects, keys, scene.materials));
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

test('a second preview is refused rather than quietly replacing the first', () => {
  // Silently rejecting the open proposal to make room for a new one is a
  // review thrown away without anybody being asked — the same quiet loss as
  // overwriting geometry, aimed at the decision instead of the model.
  const { scene, root } = build('a staircase with 20 steps');
  const { session, history, status } = hostFor(scene);
  const before = contents(scene);

  assert.ok(session.preview(root, rebuildRecipe(root.provenance!, { count: 30 })!.parts, '30 steps'));
  const live = scene.get(root.id)!;
  assert.equal(
    session.preview(live, rebuildRecipe(live.provenance!, { count: 25 })!.parts, '25 steps'),
    null,
    'a second revision was started over an open one',
  );
  assert.match(status[status.length - 1], /still waiting/);
  assert.equal(session.summary!.label, '30 steps', 'the first proposal was replaced');
  assert.equal(scene.get(root.id)!.children.length, 30);

  session.reject();
  assert.equal(contents(scene), before);
  assert.equal(history.canUndo, false);

  // With it closed, the next one starts normally.
  assert.ok(session.preview(scene.get(root.id)!, rebuildRecipe(root.provenance!, { count: 25 })!.parts, '25 steps'));
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

test('a removal that would take your work with it is a conflict, not a deletion', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  // A detail modelled onto the top step, which a shorter staircase removes.
  const detail = scene.add('mesh', 'Nosing', buildPrimitive('cube'));
  detail.position = new Vec3(0, 0, 0.5);
  scene.setParent(detail.id, kids[19].id);
  const worldBefore = detail.worldMatrix(scene).transformPoint(new Vec3());

  const { session } = hostFor(scene);
  const next = rebuildRecipe(root.provenance!, { count: 10 })!;
  const summary = session.preview(root, next.parts, '10 steps')!;

  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
  assert.ok(conflict, 'a step carrying your work was removed with no conflict');
  assert.match(conflict!.detail, /object\(s\) you made are attached/);
  assert.ok(scene.get(detail.id), 'the preview deleted your detail');

  // Agreeing to the removal lifts your work clear rather than taking it along,
  // and leaves it exactly where it was in the world.
  session.resolveConflict(conflict!.key, 'theirs', 'existence');
  const survivor = scene.get(detail.id);
  assert.ok(survivor, 'a detail you modelled was deleted along with its step');
  assert.equal(survivor!.parent, root.id, 'it should hang off the asset instead');
  assert.equal(survivor!.partKey, null);
  const worldAfter = survivor!.worldMatrix(scene).transformPoint(new Vec3());
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(worldBefore[axis] - worldAfter[axis]) < 1e-6,
      `your detail moved on ${axis}: ${worldBefore[axis]} -> ${worldAfter[axis]}`);
  }
});

// ------------------------------------------------------- deletion is a decision

test('a part you deleted stays deleted, revision after revision', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const doomedKey = kids[5].partKey!;
  scene.remove(kids[5].id);

  const { session } = hostFor(scene);
  // A revision that changes something else entirely.
  session.preview(root, rebuildRecipe(root.provenance!, { count: 20, color: '#ff0000' })!.parts, 'red');
  assert.equal(session.summary!.report.conflicts.length, 0,
    'recolouring is no reason to argue about a deletion');
  session.accept();

  const after = scene.get(root.id)!;
  assert.ok(!childrenOf(scene, after).some((c) => c.partKey === doomedKey),
    'the deleted step came back on the first revision');
  assert.deepEqual(after.provenance!.deletedParts, [doomedKey],
    'the deletion was not written down');

  // And again, and after a save and a reload.
  session.preview(after, rebuildRecipe(after.provenance!, { count: 20 })!.parts, 'again');
  session.accept();
  assert.ok(!childrenOf(scene, scene.get(root.id)!).some((c) => c.partKey === doomedKey),
    'the deleted step came back on the second revision');

  const reloaded = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  assert.deepEqual(reloaded.get(root.id)!.provenance!.deletedParts, [doomedKey],
    'the deletion did not survive a save and reload');
});

test('a deletion the revision disagrees with is a conflict, and restoring is a choice', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const key = kids[5].partKey!;
  scene.remove(kids[5].id);

  const { session } = hostFor(scene);
  // Scaling changes every step, including the one that is gone.
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!.parts, 'bigger')!;
  const conflict = summary.report.conflicts.find((c) => c.key === key);
  assert.ok(conflict, 'delete-versus-modify was decided silently');
  assert.equal(conflict!.kind, 'delete-vs-modify');
  assert.equal(conflict!.field, 'existence');
  assert.match(conflict!.yours ?? '', /deleted/);

  // It stays gone until asked for.
  assert.ok(!childrenOf(scene, scene.get(root.id)!).some((c) => c.partKey === key));
  session.resolveConflict(key, 'theirs', 'existence');
  assert.ok(childrenOf(scene, scene.get(root.id)!).some((c) => c.partKey === key),
    'asking for it back did not bring it back');
  session.accept();
  assert.ok(!(scene.get(root.id)!.provenance!.deletedParts ?? []).includes(key),
    'a restored part is still recorded as deleted');
});

test('deleted by both stays deleted without an argument', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const key = kids[19].partKey!;
  scene.remove(kids[19].id);

  const { session } = hostFor(scene);
  // Shrinking to 10 steps drops it too.
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
  assert.ok(!summary.report.conflicts.some((c) => c.key === key),
    'both sides agreeing is not a conflict');
  assert.ok(summary.report.staysDeleted > 0);
});

// ------------------------------------------- every edit counts before a removal

test('a material-only edit blocks a silent removal', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const slot = scene.addMaterial();
  scene.materials[slot].color = [1, 0, 0];
  kids[19].materialSlots = [slot];

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
  assert.ok(conflict, 'a recoloured step was removed without a word');
  assert.equal(conflict!.kind, 'modify-vs-delete');
  assert.match(conflict!.detail, /material/);
  assert.ok(scene.get(kids[19].id), 'it was removed during the preview');
});

test('changing a material in place counts, not just changing which slot', () => {
  // The subtle one: a slot is an index into a shared list, so recolouring a
  // material changes how an object looks without touching the object at all.
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const slot = kids[19].materialSlots[0];
  scene.materials[slot] = { ...scene.materials[slot], color: [0.9, 0.1, 0.1] };

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
  assert.ok(conflict, 'a material edited in place was invisible to the merge');
  assert.match(conflict!.detail, /material/);
});

test('modifier and animation edits block a silent removal too', () => {
  for (const [label, mutate] of [
    ['modifiers', (o: SceneObject) => { o.modifiers = [createModifier('subdivision')]; }],
    ['animation', (o: SceneObject) => {
      o.animation = [{ path: 'position', index: 2, keys: [{ frame: 1, value: 0 }, { frame: 10, value: 3 }] }];
    }],
  ] as const) {
    const { scene, root } = build('a staircase with 20 steps');
    const kids = childrenOf(scene, root);
    mutate(kids[19]);
    const { session } = hostFor(scene);
    const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 10 })!.parts, '10')!;
    const conflict = summary.report.conflicts.find((c) => c.objectId === kids[19].id);
    assert.ok(conflict, `an ${label} edit was invisible to the merge`);
    assert.match(conflict!.detail, new RegExp(label));
  }
});

test('a baseline too old to prove anything refuses to delete on a guess', () => {
  const { scene, root } = build('a staircase with 20 steps');
  // An asset recorded before Kline stored materials, modifiers or animation.
  const prov = root.provenance!;
  prov.baseline.version = 1;
  for (const part of prov.baseline.parts!) {
    delete part.materialSlots;
    delete part.materials;
    delete part.modifiers;
    delete part.animation;
  }

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(prov, { count: 10 })!.parts, '10')!;
  assert.equal(summary.report.unverifiable, true);
  const conflicts = summary.report.conflicts.filter((c) => c.kind === 'unverifiable');
  assert.equal(conflicts.length, 10, 'ten steps would have been deleted on an assumption');
  assert.match(conflicts[0].detail, /no way to show/);
});

// --------------------------------------------------- fields disagree out loud

test('both changing the same transform is a conflict, not a silent win', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  kids[3].position = new Vec3(5, 5, 5);

  const { session } = hostFor(scene);
  // Scaling moves every step, including the one you moved.
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!.parts, 'bigger')!;
  const conflict = summary.report.conflicts.find(
    (c) => c.objectId === kids[3].id && c.field === 'position',
  );
  assert.ok(conflict, 'the placement disagreement was decided silently');
  assert.equal(conflict!.kind, 'transform');
  assert.ok(conflict!.yours && conflict!.theirs, 'a conflict must show both values');
  assert.match(conflict!.yours!, /5/);
  // Nothing was written while it is in dispute.
  assert.deepEqual(scene.get(kids[3].id)!.position.toArray(), [5, 5, 5]);
});

test('resolving a name keeps the shape, and resolving a shape keeps the name', () => {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('cube'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [{
        key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: part.mesh!.toJSON(), materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });

  // You rename it and move it; the revision renames it differently and
  // reshapes it. Three separate questions.
  part.name = 'My body';
  part.position = new Vec3(1, 0, 0);
  const proposed = [{
    key: 'body#1', name: 'Generated body',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }];
  const { session } = hostFor(scene);
  const summary = session.preview(scene.get(root.id)!, proposed, 'reshape')!;

  const nameConflict = summary.report.conflicts.find((c) => c.field === 'name');
  assert.ok(nameConflict, 'two different names is a disagreement');
  assert.equal(summary.report.conflicts.some((c) => c.field === 'geometry'), false,
    'you did not touch the shape, so there is nothing to argue about there');
  // The shape was taken; the position you set was kept; the name is still open.
  const live = scene.get(part.id)!;
  assert.equal(live.faceCountForTest ?? live.mesh!.faceCount > 6, true);
  assert.deepEqual(live.position.toArray(), [1, 0, 0], 'your placement was reset');
  assert.equal(live.name, 'My body', 'the name changed while it was still in dispute');

  // Settling the name touches only the name.
  session.resolveConflict('body#1', 'theirs', 'name');
  assert.equal(scene.get(part.id)!.name, 'Generated body');
  assert.deepEqual(scene.get(part.id)!.position.toArray(), [1, 0, 0],
    'resolving a name reset an unrelated placement');
});

test('an unresolved conflict cannot slip through acceptance', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  kids[3].position = new Vec3(5, 5, 5);
  const { session, history } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 20, scale: 2 })!.parts, 'bigger');
  assert.ok(session.summary!.report.conflicts.length > 0);

  assert.equal(session.accept(), false, 'an open conflict was accepted anyway');
  assert.equal(session.active, true, 'the revision was closed with conflicts open');
  assert.equal(history.canUndo, false);

  // Saying it once settles them all, and is recorded as an override.
  const settled = session.keepMineForAll();
  assert.ok(settled > 0);
  assert.equal(session.summary!.report.conflicts.length, 0);
  assert.equal(session.accept(), true);
  assert.deepEqual(scene.get(kids[3].id)!.position.toArray(), [5, 5, 5],
    'keep-mine-for-all did not keep mine');
});

// ---------------------------------------------- the document is held on review

test('the fingerprint sees every kind of change, not a sample of one kind', () => {
  const { scene, root } = build('a table');
  const kids = childrenOf(scene, root);
  const stamp = () => assetFingerprint(scene, scene.get(root.id));
  const start = stamp();
  assert.equal(stamp(), start, 'the stamp is not stable');

  const changes: [string, () => void][] = [
    ['one vertex moved', () => { kids[0].mesh!.positions[3].x += 1e-3; kids[0].mesh!.markDirty(); }],
    ['a material slot', () => { kids[1].materialSlots = [scene.addMaterial()]; }],
    // A material the asset actually uses: editing one nothing points at is
    // correctly invisible to the asset's stamp.
    ['a material value', () => {
      const slot = kids[2].materialSlots[0];
      scene.materials[slot] = { ...scene.materials[slot], roughness: 0.11 };
    }],
    ['a modifier', () => { kids[2].modifiers = [createModifier('subdivision')]; }],
    ['an animation key', () => {
      kids[3].animation = [{ path: 'position', index: 0, keys: [{ frame: 1, value: 0 }] }];
    }],
    ['visibility', () => { kids[4].visible = false; }],
    ['a rename', () => { kids[0].name = 'Renamed'; }],
    ['protection', () => { kids[1].protectedFromRegen = true; }],
  ];
  let previous = start;
  for (const [what, mutate] of changes) {
    mutate();
    const now = stamp();
    assert.notEqual(now, previous, `${what} did not move the stamp`);
    previous = now;
  }
});

test('a mesh edit that misses a sampled index is still noticed', () => {
  // The reason the old sampled hash was replaced: it read one position in
  // every few hundred, so an edit between two samples was invisible.
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Grid', buildPrimitive('grid'));
  part.partKey = 'grid#1';
  scene.setParent(part.id, root.id);
  const before = assetFingerprint(scene, root);
  part.mesh!.positions[1].z += 0.25;   // index 1: never sampled by the old hash
  part.mesh!.markDirty();
  assert.notEqual(assetFingerprint(scene, root), before);
});

// -------------------------------------------- journey 1: 20 -> 30 -> 15 -> 25

test('a staircase survives being revised three times over', () => {
  const { scene, root } = build('a staircase with 20 steps');
  const kids = childrenOf(scene, root);
  const slot = scene.addMaterial();
  scene.materials[slot].color = [0.9, 0.1, 0.1];
  kids[0].materialSlots = [slot];
  const detail = scene.add('mesh', 'My finial', buildPrimitive('cube'));
  scene.setParent(detail.id, root.id);

  const { session, history } = hostFor(scene);
  const steps = (): SceneObject[] => childrenOf(scene, scene.get(root.id)!)
    .filter((c) => (c.partKey ?? '').startsWith('step#'));

  for (const [count, expect] of [[30, 30], [15, 15], [25, 25]] as const) {
    const live = scene.get(root.id)!;
    const summary = session.preview(
      live, rebuildRecipe(live.provenance!, { count })!.parts, `${count} steps`,
    )!;
    // Shrinking removes steps; none of them were edited, so none should argue.
    if (summary.report.conflicts.length) session.keepMineForAll();
    assert.equal(session.accept(), true, `accepting ${count} steps failed`);
    assert.equal(steps().length, expect, `expected ${expect} steps`);
    assert.ok(scene.get(detail.id), 'your finial was lost');
    assert.equal(scene.get(kids[0].id)?.materialSlots[0], slot,
      'your material was lost during repeated revisions');
  }
  assert.equal(history.depth, 3, 'three revisions should be three undo steps');
  assert.equal(scene.get(root.id)!.provenance!.revision, 3);
});

test('Keep Both leaves two independently addressable objects, once', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const kids = childrenOf(scene, root);
  for (const p of kids[2].mesh!.positions) p.z += 0.3;
  kids[2].mesh!.markDirty();
  const key = kids[2].partKey!;

  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!.parts, 'bigger');
  session.resolveConflict(key, 'both', 'geometry');
  session.keepMineForAll();
  session.accept();

  const after = childrenOf(scene, scene.get(root.id)!);
  const carriers = after.filter((c) => c.partKey === key);
  assert.equal(carriers.length, 1, 'two objects claim the same generated identity');
  const mine = after.find((c) => c.id === kids[2].id)!;
  assert.equal(mine.partKey, null, 'your copy still claims a generated identity');
  assert.notEqual(mine.name, carriers[0].name, 'the two are not separately addressable');

  // And a second revision knows which is which.
  const live = scene.get(root.id)!;
  const second = session.preview(live, rebuildRecipe(live.provenance!, { count: 8, scale: 2 })!.parts, 'again')!;
  assert.equal(second.report.conflicts.length, 0,
    'the settled argument came back on the next revision');
  session.accept();
  assert.ok(scene.get(mine.id), 'your kept copy was removed by the next revision');
});

test('Keep Mine survives the next revision instead of being re-argued', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const kids = childrenOf(scene, root);
  kids[2].position = new Vec3(9, 9, 9);

  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!.parts, 'bigger');
  session.keepMineForAll();
  session.accept();
  assert.deepEqual(scene.get(kids[2].id)!.position.toArray(), [9, 9, 9]);

  // The same revision again: the generator now proposes what the baseline
  // holds, so there is nothing new to disagree about and your placement stands.
  const live = scene.get(root.id)!;
  const again = session.preview(live, rebuildRecipe(live.provenance!, { count: 8, scale: 2 })!.parts, 'again')!;
  assert.equal(again.report.conflicts.length, 0, 'the same argument was had twice');
  session.accept();
  assert.deepEqual(scene.get(kids[2].id)!.position.toArray(), [9, 9, 9],
    'your placement was lost on the second revision');
});

test('a protected part cannot be changed through conflict resolution either', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const kids = childrenOf(scene, root);
  kids[4].protectedFromRegen = true;
  const before = JSON.stringify(kids[4].mesh!.toJSON());

  const { session } = hostFor(scene);
  const summary = session.preview(root, rebuildRecipe(root.provenance!, { count: 8, scale: 2 })!.parts, 'bigger')!;
  const conflict = summary.report.conflicts.find((c) => c.objectId === kids[4].id)!;
  assert.equal(conflict.kind, 'protected');
  // Even choosing the generator's version leaves a protected part alone unless
  // the protection is lifted first.
  session.resolveConflict(conflict.key, 'theirs', conflict.field);
  assert.equal(JSON.stringify(scene.get(kids[4].id)!.mesh!.toJSON()), before,
    'a protected part was changed through the conflict panel');
});

// --------------------------------- journey 6: reorder and rename generated parts

test('declared identifiers survive reordering and renaming; position matching does not', () => {
  const first = validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', id: 'top', name: 'Top', position: [0, 0, 1], size: [2, 1, 0.1] },
      { shape: 'cube', id: 'leg', name: 'Leg', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
    ],
  }).plan!;
  // The same program, reordered and renamed — which is what a model does when
  // asked to change one thing.
  const second = validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', id: 'leg', name: 'Support', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
      { shape: 'cube', id: 'top', name: 'Tabletop', position: [0, 0, 1], size: [3, 1, 0.1] },
    ],
  }).plan!;

  const a = identifiedParts(first.parts);
  const b = identifiedParts(second.parts);
  assert.deepEqual(a.uncertain, [], 'declared ids should not be uncertain');
  const keyOf = (parts: typeof a.parts, name: string): string =>
    parts.find((p) => p.name === name)!.key;
  assert.equal(keyOf(a.parts, 'Top'), keyOf(b.parts, 'Tabletop'),
    'the tabletop lost its identity when it was renamed and moved down the list');
  assert.equal(keyOf(a.parts, 'Leg'), keyOf(b.parts, 'Support'));

  // Without ids the same reorder swaps them, and that is reported rather than
  // presented as a match.
  const noIds = identifiedParts(validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', name: 'Support', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
      { shape: 'cube', name: 'Tabletop', position: [0, 0, 1], size: [3, 1, 0.1] },
    ],
  }).plan!.parts);
  assert.equal(noIds.uncertain.length, 2, 'parts with no identity must be flagged as uncertain');
});

test('a duplicated identifier is refused rather than silently picked between', () => {
  const plan = validatePlan({
    name: 'Rig',
    parts: [
      { shape: 'cube', id: 'leg', name: 'Leg', position: [0, 0, 0.5], size: [0.1, 0.1, 1] },
      { shape: 'cube', id: 'leg', name: 'Leg', position: [1, 0, 0.5], size: [0.1, 0.1, 1] },
    ],
  }).plan!;
  const out = identifiedParts(plan.parts);
  assert.equal(out.problems.length, 1, 'a duplicated id must be reported');
  assert.match(out.problems[0], /more than once/);
  assert.equal(new Set(out.parts.map((p) => p.key)).size, 2, 'the two must stay distinguishable');
  assert.equal(out.uncertain.length, 2, 'both should be treated as uncertain');
});

test('an edited program revises the asset it came from, with no model involved', async () => {
  const scene = new Scene();
  const built = runProgramHere(
    "part({shape:'cube', id:'top', name:'Top', at:[0,0,1], size:[2,1,0.1], color:'#8b5e34'});"
    + "part({shape:'cube', id:'leg', name:'Leg', at:[0,0,0.5], size:[0.1,0.1,1], color:'#8b5e34'});",
  );
  const plan = { name: 'Table', parts: built.parts };
  const { root, objects, keys } = executePlan(scene, plan);
  recordProvenance(root, { source: 'program', generator: 'program:hand', code: 'original' },
    captureBaseline(objects, keys, scene.materials));

  // Make it yours, then edit the program by hand.
  const top = childrenOf(scene, root).find((c) => c.name === 'Top')!;
  const slot = scene.addMaterial();
  top.materialSlots = [slot];

  const edited = runProgramHere(
    "part({shape:'cube', id:'top', name:'Top', at:[0,0,1], size:[4,1,0.1], color:'#8b5e34'});"
    + "part({shape:'cube', id:'leg', name:'Leg', at:[0,0,0.5], size:[0.1,0.1,1], color:'#8b5e34'});",
  );
  const { session } = hostFor(scene);
  const summary = session.preview(
    root, identifiedParts(edited.parts).parts, 'Your edited program', [], { code: 'wider' },
  )!;
  assert.equal(summary.report.conflicts.length, 0);
  assert.equal(session.accept(), true);

  const after = childrenOf(scene, scene.get(root.id)!).find((c) => c.name === 'Top')!;
  assert.equal(after.id, top.id, 'the asset was replaced rather than revised');
  assert.equal(after.materialSlots[0], slot, 'your material was lost');
  assert.ok(after.mesh!.bounds().size().x > 3, 'the edited program was not applied');
  assert.equal(scene.get(root.id)!.provenance!.code, 'wider',
    'the accepted program was not recorded');
});

test('an answer that outlived its question is refused, not applied', () => {
  // Journey 10: a slow revision whose target is replaced while it runs. The id
  // may well be handed to something else, so identity is what is checked.
  const { scene, root } = build('a table');
  const staleAssetId = root.provenance!.assetId;
  const proposal = rebuildRecipe(root.provenance!, { scale: 2 })!.parts;

  // The object is deleted and a different asset takes its place.
  const { session, status } = hostFor(scene);
  const replacement = build('a chair');
  scene.remove(root.id);
  const other = scene.add('empty', 'Chair');
  other.provenance = cloneProvenance(replacement.root.provenance!);

  assert.equal(session.preview(other, proposal, 'late answer', [], {}, staleAssetId), null,
    'a stale answer was applied to whatever was there instead');
  assert.match(status[status.length - 1], /replaced while/);
  assert.equal(session.active, false);

  // The same proposal against its own asset is fine.
  const fresh = build('a table');
  assert.ok(session.preview(
    fresh.root,
    rebuildRecipe(fresh.root.provenance!, { scale: 2 })!.parts,
    'in time', [], {}, fresh.root.provenance!.assetId,
  ));
});

// ----------------------- the review is scoped to its asset, not to the document

test('work done elsewhere during a review survives Reject', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session, history } = hostFor(scene);
  const bystander = scene.add('mesh', 'Not part of this', buildPrimitive('cube'));

  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');

  // While deciding, the creator gets on with something else entirely.
  bystander.position = new Vec3(4, 4, 4);
  bystander.name = 'A thing I made while thinking';
  const invented = scene.add('mesh', 'Invented mid-review', buildPrimitive('uvsphere'));
  const slot = scene.addMaterial();
  scene.materials[slot].color = [0.2, 0.9, 0.4];
  bystander.materialSlots = [slot];

  assert.equal(session.reject(), true);

  // The asset went back...
  assert.equal(childrenOf(scene, scene.get(root.id)!).length, 8, 'the asset did not go back');
  // ...and none of the rest did.
  const kept = scene.get(bystander.id);
  assert.ok(kept, 'Reject deleted an object made during the review');
  assert.deepEqual(kept!.position.toArray(), [4, 4, 4], 'Reject undid unrelated work');
  assert.equal(kept!.name, 'A thing I made while thinking');
  assert.equal(kept!.materialSlots[0], slot, 'Reject took back a material you made');
  assert.ok(scene.get(invented.id), 'Reject deleted an object invented during the review');
  assert.equal(history.canUndo, false, 'a rejected revision left a step in the history');
});

test('accepting takes in the asset and nothing else, as one undo step', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session, history } = hostFor(scene);

  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');
  const bystander = scene.add('mesh', 'Made during the review', buildPrimitive('cube'));
  bystander.position = new Vec3(2, 0, 0);
  assert.equal(session.accept(), true);
  assert.equal(history.depth, 1);

  // Undo puts the asset back and leaves the unrelated object where it is,
  // because it was never part of what was accepted.
  const step = history.undo({
    label: 'redo', scene: scene.toJSON(history.store), mode: 'object', editObject: null,
    selectMode: 'vertex', verts: [], edges: [], faces: [],
  })!;
  scene.adopt(Scene.fromJSON(step.scene));
  assert.equal(childrenOf(scene, scene.get(root.id)!).length, 8, 'undo did not restore the asset');
  const survivor = scene.get(bystander.id);
  assert.ok(survivor, 'undoing the revision deleted work that was never part of it');
  assert.deepEqual(survivor!.position.toArray(), [2, 0, 0]);
});

test('the asset under review is the only thing held', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session } = hostFor(scene);
  const kids = childrenOf(scene, root);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');

  assert.equal(session.touches([kids[0].id]), true, 'a part under review is not held');
  assert.equal(session.touches([root.id]), true, 'the asset root is not held');
  const outside = scene.add('mesh', 'Elsewhere', buildPrimitive('cube'));
  assert.equal(session.touches([outside.id]), false, 'an unrelated object was held');
  session.reject();
  assert.equal(session.touches([kids[0].id]), false, 'the hold outlived the review');
});

test('an object parented under the asset during a review is not lost by Reject', () => {
  const { scene, root } = build('a staircase with 8 steps');
  const { session } = hostFor(scene);
  session.preview(root, rebuildRecipe(root.provenance!, { count: 14 })!.parts, '14 steps');

  // Hung onto one of the *proposed* steps, which is about to stop existing.
  const live = childrenOf(scene, scene.get(root.id)!);
  const mine = scene.add('mesh', 'Hung on a proposal', buildPrimitive('cube'));
  scene.setParent(mine.id, live[live.length - 1].id);

  session.reject();
  const survivor = scene.get(mine.id);
  assert.ok(survivor, 'an object you made was deleted with the proposal it hung from');
  assert.equal(survivor!.parent, null, 'it should be lifted to the top level, not orphaned');
  assert.ok(scene.order.includes(mine.id), 'it is not reachable in the outliner');
});

// ------------------------------- per-vertex work is carried, not written off

test('choosing the revised shape carries weights, colours and UVs across', () => {
  const scene = new Scene();
  const root = scene.add('empty', 'Asset');
  const part = scene.add('mesh', 'Body', buildPrimitive('uvsphere'));
  part.partKey = 'body#1';
  scene.setParent(part.id, root.id);
  const baseMesh = part.mesh!.toJSON();
  root.provenance = normaliseProvenance({
    schema: 2, source: 'program', assetId: 'a1', generator: 'program', params: {},
    baseline: {
      version: 2,
      parts: [{
        key: 'body#1', name: 'Body', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: baseMesh, materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });

  // Rig it, paint it and unwrap it — three separate things stored against
  // these particular vertices.
  const mesh = part.mesh!;
  mesh.skin = {
    bones: new Int32Array(mesh.vertCount * 4),
    weights: new Float32Array(mesh.vertCount * 4),
  };
  for (let v = 0; v < mesh.vertCount; v++) {
    // Bone 1 above the equator, bone 0 below: a boundary the transfer has to
    // land in roughly the right place.
    const upper = mesh.positions[v].z > 0;
    mesh.skin.bones[v * 4] = upper ? 1 : 0;
    mesh.skin.weights[v * 4] = 1;
  }
  mesh.colors = new Float32Array(mesh.vertCount * 3);
  for (let v = 0; v < mesh.vertCount; v++) {
    mesh.colors[v * 3] = mesh.positions[v].z > 0 ? 1 : 0;
  }
  mesh.faceUV = mesh.faces.map(() => new Array(mesh.faces[0].length * 2).fill(0.5));
  mesh.markDirty();

  // A revision that rebuilds it with different topology.
  const denser = catmullClark(buildPrimitive('uvsphere'), 1);
  const proposed = [{
    key: 'body#1', name: 'Body',
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: denser.toJSON(),
  }];
  const { session } = hostFor(scene);
  const summary = session.preview(scene.get(root.id)!, proposed, 'denser')!;
  const conflict = summary.report.conflicts.find((c) => c.field === 'geometry')!;
  assert.ok(conflict, 'a topology change over rigged work should be a conflict');

  session.resolveConflict('body#1', 'theirs', 'geometry');
  const after = scene.get(part.id)!.mesh!;
  assert.notEqual(after.vertCount, mesh.vertCount, 'the new shape was not applied');
  assert.ok(after.skin, 'the skin weights were thrown away');
  assert.ok(after.colors, 'the vertex colours were thrown away');
  assert.equal(after.hasUV, true, 'the UVs were thrown away');

  // And they landed in the right places, not merely in some place.
  let right = 0;
  let counted = 0;
  for (let v = 0; v < after.vertCount; v++) {
    const z = after.positions[v].z;
    if (Math.abs(z) < 0.15) continue;   // near the boundary, either answer is fair
    counted++;
    const bone = after.skin!.bones[v * 4];
    if ((z > 0 && bone === 1) || (z < 0 && bone === 0)) right++;
  }
  assert.ok(counted > 20, 'not enough vertices away from the boundary to judge');
  assert.ok(right / counted > 0.95,
    `weights landed on the wrong side for ${counted - right} of ${counted} vertices`);

  // The panel says it happened, and how much to trust it.
  assert.ok(session.summary!.notes.some((n) => /Carried your/.test(n)),
    'carrying work across was done silently');
});

test('Keep Both on a one-mesh reference asset leaves a coherent structure', () => {
  const scene = new Scene();
  const asset = scene.add('mesh', 'Badge', buildPrimitive('cube'));
  asset.partKey = 'surface#1';
  asset.position = new Vec3(2, 0, 0);
  const baseMesh = asset.mesh!.toJSON();
  asset.provenance = normaliseProvenance({
    schema: 2, source: 'reference', assetId: 'a1', generator: 'reference:silhouette',
    params: { mode: 'silhouette', depth: 0.4 },
    reference: { textureId: 1, name: 'badge.png', frameTime: 0, width: 4, height: 4 },
    baseline: {
      version: 2,
      parts: [{
        key: 'surface#1', name: 'Badge', position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        mesh: baseMesh, materialSlots: [], materials: [], modifiers: [], animation: [],
        visible: true, locked: false,
      }],
    },
  });
  // Sculpted, so a rebuild is a real disagreement.
  for (const p of asset.mesh!.positions) p.z += 0.2;
  asset.mesh!.markDirty();
  const sculpted = JSON.stringify(asset.mesh!.toJSON());

  const proposed = [{
    key: 'surface#1', name: 'Badge',
    position: [2, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
    mesh: buildPrimitive('uvsphere').toJSON(),
  }];
  const { session } = hostFor(scene);
  const summary = session.preview(asset, proposed, 'deeper')!;
  const conflict = summary.report.conflicts.find((c) => c.field === 'geometry')!;
  session.resolveConflict(conflict.key, 'both', 'geometry');
  session.accept();

  const all = [...scene.objects.values()];
  const assets = all.filter((o) => o.provenance);
  assert.equal(assets.length, 1, 'keeping both produced two objects claiming the same asset');
  assert.equal(assets[0].id, asset.id, 'the asset lost its identity');
  assert.equal(assets[0].partKey, 'surface#1', 'the asset lost its part identity');
  assert.ok(assets[0].mesh!.faceCount > 6, 'the asset did not take the generated shape');

  const yours = all.find((o) => o.id !== asset.id && o.name.includes('yours'));
  assert.ok(yours, 'your version was not kept');
  assert.equal(yours!.partKey, null, 'your copy still carries a generated identity');
  assert.equal(yours!.provenance, null, 'your copy would be regenerated again');
  assert.equal(JSON.stringify(yours!.mesh!.toJSON()), sculpted, 'your sculpt was not what was kept');
  assert.equal(yours!.parent, asset.parent, 'your copy is not a sibling of the asset');

  // And the next revision knows exactly what it owns.
  const again = session.preview(scene.get(asset.id)!, proposed, 'again')!;
  assert.equal(again.report.conflicts.length, 0, 'the settled argument came back');
  session.accept();
  assert.ok(scene.get(yours!.id), 'your copy was swept up by the next revision');
});
