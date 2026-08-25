import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, runProgramHere } from '../src/build/sandbox';

const run = (code: string) => runProgramHere(code, DEFAULT_LIMITS);

test('the API builds parts from a program', () => {
  const r = run(`
    box(0, 0, 0.5, 1, 1, 1, '#c0392b');
    cyl(2, 0, 1, 0.4, 0.4, 2);
    ball(0, 3, 1, 2, '#3a6fb0');
  `);
  assert.equal(r.parts.length, 3);
  assert.equal(r.parts[0].shape, 'cube');
  assert.equal(r.parts[0].color, '#c0392b');
  assert.equal(r.parts[1].shape, 'cylinder');
  assert.deepEqual(r.parts[2].size, [2, 2, 2], 'ball takes one diameter');
});

test('loops and maths make things no recipe could', () => {
  // A spiral staircase: exactly the kind of thing a fixed recipe list cannot hold.
  const r = run(`
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * TAU * 1.5;
      part({ shape: 'cube', at: [cos(a) * 2, sin(a) * 2, i * 0.18 + 0.09],
             size: [1.4, 0.5, 0.18], rot: [0, 0, a * 180 / PI], color: '#8b5e34' });
    }
  `);
  assert.equal(r.parts.length, 24);
  const zs = r.parts.map((p) => p.position[2]);
  assert.ok(zs[23] > zs[0], 'it climbs');
  // The first tread is at angle 0, so it legitimately carries no rotation.
  const angles = r.parts.map((p) => p.rotation?.[2] ?? 0);
  assert.ok(angles[23] > 300, `the last tread has turned ${angles[23]}°`);
  assert.equal(new Set(angles).size, 24, 'every tread is at its own angle');
  const radii = r.parts.map((p) => Math.hypot(p.position[0], p.position[1]));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 1e-9, 'and stays on the helix');
});

test('random is seeded, so the same program repeats exactly', () => {
  const code = 'for (let i = 0; i < 20; i++) box(random() * 10, random() * 10, 0.5, 1, 1, 1);';
  assert.deepEqual(run(code).parts.map((p) => p.position), run(code).parts.map((p) => p.position));
});

test('log output comes back to the caller', () => {
  const r = run(`log('made', 2, 'things'); box(0,0,0.5,1,1,1); box(1,0,0.5,1,1,1);`);
  assert.deepEqual(r.log, ['made 2 things']);
});

test('network and storage globals are not reachable', () => {
  for (const attempt of [
    'fetch("https://example.com")',
    'new XMLHttpRequest()',
    'importScripts("x.js")',
    'localStorage.setItem("a", "b")',
    'new Worker("x")',
    'postMessage("leak")',
  ]) {
    assert.throws(() => run(`${attempt}; box(0,0,0.5,1,1,1);`), /undefined|not a function|not a constructor/i,
      `"${attempt}" should not work`);
  }
});

test('a program cannot reach the host through globalThis or self', () => {
  assert.throws(() => run('globalThis.leak = 1; box(0,0,0.5,1,1,1);'), /undefined/i);
  assert.throws(() => run('self.leak = 1; box(0,0,0.5,1,1,1);'), /undefined/i);
  assert.equal((globalThis as Record<string, unknown>).leak, undefined);
});

test('the part budget is enforced', () => {
  assert.throws(
    () => runProgramHere('for (let i = 0; i < 100; i++) box(i, 0, 0.5, 1, 1, 1);', { maxParts: 10, maxMs: 1000 }),
    /more than 10 parts/,
  );
});

test('a syntax error is reported rather than swallowed', () => {
  assert.throws(() => run('box(0,0,0.5,1,1,1'), SyntaxError);
});

test('a program that builds nothing is an error, not an empty scene', () => {
  assert.throws(() => run('const x = 1 + 1;'), /no usable parts/i);
});

test('nonsense numbers are repaired instead of poisoning the scene', () => {
  const r = run(`
    box(NaN, 0, 0.5, 1, 1, 1);
    box(0, 0, 0.5, 0, -3, Infinity);
  `);
  assert.equal(r.parts.length, 2);
  for (const p of r.parts) {
    assert.ok(p.position.every(Number.isFinite), 'positions are finite');
    assert.ok(p.size.every((v) => Number.isFinite(v) && v > 0), 'sizes are positive and finite');
  }
});

test('the documented API matches what the harness actually provides', async () => {
  const { API_REFERENCE } = await import('../src/build/sandbox');
  for (const fn of ['box', 'cyl', 'sphere', 'ball', 'cone', 'torus', 'plane', 'part', 'log']) {
    assert.ok(API_REFERENCE.includes(`${fn}(`), `${fn} is not documented`);
    // Every documented call has to actually exist.
    assert.doesNotThrow(() => run(`if (typeof ${fn} !== 'function') throw new Error('missing'); box(0,0,0.5,1,1,1);`),
      `${fn} is documented but missing`);
  }
});

test('code is recovered from fenced and unfenced replies', async () => {
  const { extractCode } = await import('../src/build/llm');
  const code = 'const n = 3;\nbox(0, 0, 0.5, 1, 1, 1);';
  assert.equal(extractCode(code), code);
  assert.equal(extractCode('```js\n' + code + '\n```'), code);
  assert.equal(extractCode('Here you go:\n```javascript\n' + code + '\n```\nEnjoy!'), code);
  assert.equal(
    extractCode('Sure, this builds a box.\n' + code),
    code,
    'leading prose is dropped',
  );
  // When there are several blocks, the substantial one wins.
  assert.equal(extractCode('```js\n// nope\n```\ntext\n```js\n' + code + '\n```'), code);
});

test('the code prompt documents the same API the sandbox provides', async () => {
  const { CODE_SYSTEM_PROMPT } = await import('../src/build/llm');
  const { API_REFERENCE } = await import('../src/build/sandbox');
  assert.ok(CODE_SYSTEM_PROMPT.includes(API_REFERENCE), 'the reference is embedded verbatim');
  // The worked example in the prompt has to actually run.
  const start = CODE_SYSTEM_PROMPT.indexOf('const steps = 30');
  const example = CODE_SYSTEM_PROMPT.slice(start).replace(/`$/, '');
  const r = runProgramHere(example);
  assert.equal(r.parts.length, 31, 'thirty treads and a newel post');
  assert.ok(r.parts.every((p) => p.position[2] >= 0));
});
