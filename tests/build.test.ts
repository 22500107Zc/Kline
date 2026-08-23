import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../src/scene/Scene';
import { describePlan, executePlan, meshForPart, validatePlan } from '../src/build/plan';
import { interpret, knownSubjects } from '../src/build/interpreter';
import { RECIPES, runRecipe } from '../src/build/recipes';

const plan = (prompt: string) => {
  const r = interpret(prompt);
  assert.ok(r.plan, `no plan for "${prompt}": ${r.reason}`);
  return r.plan!;
};

test('a part is scaled so its bounding box matches the requested size', () => {
  for (const shape of ['cube', 'sphere', 'cylinder', 'cone', 'torus'] as const) {
    const mesh = meshForPart({ shape, position: [0, 0, 0], size: [2, 0.5, 3] });
    const s = mesh.bounds().size();
    assert.ok(Math.abs(s.x - 2) < 1e-6, `${shape} x = ${s.x}`);
    assert.ok(Math.abs(s.y - 0.5) < 1e-6, `${shape} y = ${s.y}`);
    assert.ok(Math.abs(s.z - 3) < 1e-6, `${shape} z = ${s.z}`);
  }
});

test('a part mesh is centred on its own origin', () => {
  const mesh = meshForPart({ shape: 'cone', position: [5, 5, 5], size: [1, 1, 2] });
  const c = mesh.bounds().center();
  assert.ok(Math.hypot(c.x, c.y, c.z) < 1e-6, `centre ${c.toArray()}`);
});

test('every recipe builds parts that sit on or above the ground', () => {
  for (const recipe of RECIPES) {
    const parts = runRecipe(recipe.build, { scale: 1, stretch: 1 });
    assert.ok(parts.length > 0, `${recipe.label} produced nothing`);
    for (const p of parts) {
      const bottom = p.position[2] - p.size[2] / 2;
      assert.ok(bottom > -0.35, `${recipe.label} part "${p.name}" starts at z=${bottom.toFixed(2)}`);
      assert.ok(p.size.every((v) => v > 0), `${recipe.label} has a zero dimension`);
      assert.ok(p.size.every((v) => v < 50), `${recipe.label} is implausibly large`);
    }
  }
});

test('every recipe is reachable from a plain prompt', () => {
  for (const recipe of RECIPES) {
    const p = plan(`build a ${recipe.keys[0]}`);
    assert.equal(p.name, recipe.label, `"${recipe.keys[0]}" produced ${p.name}`);
  }
});

test('scale words change the size of the result', () => {
  const normal = plan('a table');
  const big = plan('a huge table');
  const tiny = plan('a tiny table');
  const width = (p: typeof normal) => Math.max(...p.parts.map((q) => q.size[0]));
  assert.ok(width(big) > width(normal) * 2);
  assert.ok(width(tiny) < width(normal) * 0.6);
});

test('"tall" stretches height without widening', () => {
  const normal = plan('a tower');
  const tall = plan('a tall tower');
  const top = (p: typeof normal) => Math.max(...p.parts.map((q) => q.position[2] + q.size[2] / 2));
  const wide = (p: typeof normal) => Math.max(...p.parts.map((q) => q.size[0]));
  assert.ok(top(tall) > top(normal) * 1.5);
  assert.ok(Math.abs(wide(tall) - wide(normal)) < 1e-6);
});

test('a named colour is applied to the whole build', () => {
  const p = plan('a red chair');
  assert.ok(p.parts.every((q) => q.color === '#c0392b'), 'every part is red');
});

test('a hex colour is accepted', () => {
  const p = plan('a #3fb5c4 tower');
  assert.ok(p.parts.every((q) => q.color === '#3fb5c4'));
});

test('counts inside a recipe describe the recipe, not how many to build', () => {
  const withSteps = plan('stairs with 20 steps');
  assert.equal(withSteps.parts.length, 20, 'twenty steps, one staircase');
  const floors = plan('a tower of 12 floors');
  assert.equal(floors.parts.length, 12);
});

test('a count outside a recipe repeats the whole thing', () => {
  const three = plan('3 chairs');
  const one = plan('a chair');
  assert.equal(three.parts.length, one.parts.length * 3);
  const xs = new Set(three.parts.map((p) => Math.round(p.position[0] * 100)));
  assert.ok(xs.size > 1, 'the copies are spread out, not stacked');
});

test('generic shapes arrange in a row, circle, stack and grid', () => {
  const row = plan('5 cubes in a row');
  assert.equal(row.parts.length, 5);
  assert.ok(row.parts.every((p) => Math.abs(p.position[1]) < 1e-9), 'a row runs along one axis');

  const circle = plan('8 spheres in a circle');
  assert.equal(circle.parts.length, 8);
  const radii = circle.parts.map((p) => Math.hypot(p.position[0], p.position[1]));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 1e-6, 'all on one radius');

  const stack = plan('stack of 6 boxes');
  assert.equal(stack.parts.length, 6);
  const heights = stack.parts.map((p) => p.position[2]).sort((a, b) => a - b);
  assert.ok(heights[0] < heights[5], 'they go up');
  assert.ok(stack.parts.every((p) => Math.hypot(p.position[0], p.position[1]) < 1e-9));

  const grid = plan('9 cylinders in a grid');
  assert.equal(grid.parts.length, 9);
});

test('scatter is deterministic for the same prompt', () => {
  const a = plan('12 scattered cubes');
  const b = plan('12 scattered cubes');
  assert.deepEqual(a.parts.map((p) => p.position), b.parts.map((p) => p.position));
});

test('an unrecognised prompt explains itself instead of guessing', () => {
  const r = interpret('a photorealistic dragon wearing a hat');
  assert.equal(r.plan, null);
  assert.match(r.reason ?? '', /local model|recipe/i);
});

test('an empty prompt is handled', () => {
  assert.equal(interpret('   ').plan, null);
});

test('validation repairs sloppy model output rather than rejecting it', () => {
  const { plan: p, warnings } = validatePlan({
    name: 'Thing',
    parts: [
      { type: 'box', position: [0, 0, 0.5], size: [1, 1, 1], colour: 'red' },
      { shape: 'blob', position: 'nonsense', size: 9999 },
      'not an object',
    ],
  });
  assert.ok(p);
  assert.equal(p!.parts.length, 2, 'the string was dropped, the odd shapes repaired');
  assert.equal(p!.parts[0].shape, 'cube', 'box became a cube');
  assert.equal(p!.parts[0].color, '#c0392b', 'colour name resolved');
  assert.equal(p!.parts[1].shape, 'cube', 'unknown shape fell back');
  assert.ok(p!.parts[1].size.every((v) => v <= 500), 'size clamped');
  assert.ok(warnings.length >= 2);
});

test('validation rejects input that is not a plan at all', () => {
  assert.equal(validatePlan(null).plan, null);
  assert.equal(validatePlan({ hello: 'world' }).plan, null);
  assert.equal(validatePlan({ parts: [] }).plan, null);
});

test('executing a plan groups every part under one empty', () => {
  const scene = new Scene();
  const p = plan('a table');
  const { root, objects } = executePlan(scene, p);
  assert.equal(root.type, 'empty');
  assert.equal(objects.length, p.parts.length);
  assert.equal(root.children.length, p.parts.length);
  for (const o of objects) {
    assert.equal(o.parent, root.id);
    assert.ok(o.mesh && o.mesh.faceCount > 0);
  }
});

test('executing a plan reuses one material per colour', () => {
  const scene = new Scene();
  const { objects } = executePlan(scene, plan('a red chair'));
  const slots = new Set(objects.map((o) => o.materialSlots[0]));
  assert.equal(slots.size, 1, 'one shared red material');
});

test('a built table has believable real-world proportions', () => {
  const scene = new Scene();
  const { root } = executePlan(scene, plan('a table'));
  const box = root.bounds(scene);
  for (const child of root.children) box.union(scene.get(child)!.bounds(scene));
  assert.ok(box.max.z > 0.6 && box.max.z < 0.9, `table height ${box.max.z}`);
  assert.ok(box.size().x > 1 && box.size().x < 2.5, `table width ${box.size().x}`);
});

test('the plan summary names what was built', () => {
  assert.match(describePlan(plan('a snowman')), /Snowman/);
  assert.match(describePlan(plan('5 cubes in a row')), /5 cubes/);
});

test('the recipe list is exposed for the UI', () => {
  const subjects = knownSubjects();
  assert.ok(subjects.length >= 20);
  assert.ok(subjects.includes('Table') && subjects.includes('Castle'));
});

// --------------------------------------------------------------- model layer

test('JSON is recovered from fences, prose and trailing commas', async () => {
  const { extractJSON } = await import('../src/build/llm');
  const want = { name: 'X', parts: [{ shape: 'cube' }] };
  assert.deepEqual(extractJSON('{"name":"X","parts":[{"shape":"cube"}]}'), want);
  assert.deepEqual(extractJSON('```json\n{"name":"X","parts":[{"shape":"cube"}]}\n```'), want);
  assert.deepEqual(extractJSON('Sure! Here you go:\n{"name":"X","parts":[{"shape":"cube"}]}\nHope that helps.'), want);
  assert.deepEqual(extractJSON('{"name":"X","parts":[{"shape":"cube"},],}'), want);
  assert.equal(extractJSON('no json here'), null);
  assert.equal(extractJSON('{ hopelessly [ broken '), null);
});

test('the system prompt pins down the schema the validator expects', async () => {
  const { SYSTEM_PROMPT } = await import('../src/build/llm');
  const { BUILD_SHAPES } = await import('../src/build/plan');
  for (const shape of BUILD_SHAPES) {
    assert.ok(SYSTEM_PROMPT.includes(shape), `${shape} is not offered to the model`);
  }
  assert.match(SYSTEM_PROMPT, /CENTRE|CENTER/);
  assert.match(SYSTEM_PROMPT, /metres/);
  // The worked example has to survive our own validator.
  const example = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('{"name":"Stool"'));
  const { extractJSON } = await import('../src/build/llm');
  const { validatePlan } = await import('../src/build/plan');
  const parsed = validatePlan(extractJSON(example));
  assert.ok(parsed.plan, 'the example in the prompt is not a valid plan');
  assert.equal(parsed.plan!.parts.length, 4);
  assert.deepEqual(parsed.warnings, []);
});

test('provider defaults point at a local, zero-cost model', async () => {
  const { PROVIDER_DEFAULTS } = await import('../src/build/llm');
  assert.match(PROVIDER_DEFAULTS.ollama.baseUrl, /127\.0\.0\.1|localhost/);
  assert.equal(PROVIDER_DEFAULTS.ollama.apiKey, '', 'a local model needs no key');
});

test('an arrangement phrase is never mistaken for the shape', () => {
  for (const [prompt, shape, count] of [
    ['12 cubes in a circle', 'cube', 12],
    ['ring of 5 boxes', 'cube', 5],
    ['8 spheres in a row', 'sphere', 8],
    ['a circle of 6 cylinders', 'cylinder', 6],
    ['stack of 4 cones', 'cone', 4],
  ] as const) {
    const p = plan(prompt);
    assert.equal(p.parts.length, count, prompt);
    assert.ok(p.parts.every((q) => q.shape === shape), `${prompt} produced ${p.parts[0].shape}`);
  }
});

test('asking for circles still gets circles', () => {
  const p = plan('3 circles in a row');
  assert.ok(p.parts.every((q) => q.shape === 'circle'));
});
