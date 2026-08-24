import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { falloffWeight, proportionalWeights } from '../src/editor/proportional';
import { defaultSnap, snapToGrid } from '../src/editor/snapping';
import { COMMANDS, COMMANDS_BY_ID, KEYMAP, lookupKey } from '../src/editor/commands';
import { defaultPreferences } from '../src/editor/persistence';
import { Vec3 } from '../src/core/math';

test('every falloff runs from 1 to 0 and stays in range', () => {
  const types = ['smooth', 'sphere', 'root', 'inverseSquare', 'sharp', 'linear'] as const;
  for (const type of types) {
    assert.ok(Math.abs(falloffWeight(type, 0) - 1) < 1e-9, `${type} does not start at 1`);
    assert.ok(falloffWeight(type, 1) < 1e-9, `${type} does not reach 0`);
    for (let i = 0; i <= 10; i++) {
      const w = falloffWeight(type, i / 10);
      assert.ok(w >= 0 && w <= 1, `${type} left the 0..1 range`);
    }
  }
  assert.equal(falloffWeight('constant', 1), 1, 'constant falloff is deliberately flat');
});

test('proportional weights fall off with distance and stop at the radius', () => {
  const grid = buildPrimitive('grid');
  const centre = 0;
  const weights = proportionalWeights(grid, [centre], 0.5, 'smooth', false);
  assert.equal(weights.get(centre), 1);
  for (const [v, w] of weights) {
    const d = grid.positions[v].distanceTo(grid.positions[centre]);
    assert.ok(d <= 0.5 + 1e-9, `vertex ${v} at ${d} is outside the radius`);
    assert.ok(w > 0 && w <= 1);
  }
  const tighter = proportionalWeights(grid, [centre], 0.2, 'smooth', false);
  assert.ok(tighter.size < weights.size);
});

test('connected falloff measures along the surface, not through it', () => {
  // Two grids stacked close together but not joined.
  const mesh = buildPrimitive('grid');
  const far = mesh.clone();
  for (let i = 0; i < far.positions.length; i++) far.positions[i].z += 0.05;
  mesh.append(far);
  const seed = 0;
  const straight = proportionalWeights(mesh, [seed], 0.4, 'linear', false);
  const alongEdges = proportionalWeights(mesh, [seed], 0.4, 'linear', true);
  assert.ok(alongEdges.size < straight.size, 'connected mode should ignore the detached copy');
  for (const v of alongEdges.keys()) {
    assert.ok(v < mesh.positions.length / 2, 'reached the detached half through space');
  }
});

test('proportional editing scales to a dense mesh without going quadratic', () => {
  const dense = catmullClark(buildPrimitive('uvsphere'), 1);
  const started = Date.now();
  const weights = proportionalWeights(dense, [0], 0.3, 'smooth', false);
  assert.ok(weights.size > 1);
  assert.ok(Date.now() - started < 1500);
});

test('grid snapping rounds to the step', () => {
  const p = snapToGrid(new Vec3(1.31, -0.62, 0.04), 0.25);
  assert.equal(p.x, 1.25);
  assert.equal(p.y, -0.5);
  assert.equal(p.z, 0);
  assert.deepEqual(snapToGrid(new Vec3(1, 2, 3), 0).toArray(), [1, 2, 3]);
  assert.equal(defaultSnap().enabled, false);
});

test('every command id is unique and every keymap entry resolves', () => {
  const ids = new Set<string>();
  for (const cmd of COMMANDS) {
    assert.ok(!ids.has(cmd.id), `duplicate command id ${cmd.id}`);
    ids.add(cmd.id);
    assert.ok(cmd.label.length > 0);
  }
  for (const binding of KEYMAP) {
    assert.ok(COMMANDS_BY_ID.has(binding.command), `${binding.chord} points at a missing command`);
  }
});

test('mode-specific bindings win over the general ones', () => {
  assert.equal(lookupKey('x', 'edit'), 'mesh.delete');
  assert.equal(lookupKey('x', 'object'), 'object.delete');
  assert.equal(lookupKey('tab', 'sculpt'), 'edit.toggleMode', 'a general binding still applies in sculpt');
  assert.equal(lookupKey(']', 'sculpt'), 'sculpt.radiusUp');
  assert.equal(lookupKey(']', 'object'), null);
});

test('the new operators are reachable from the menus', () => {
  for (const id of [
    'mesh.bevel', 'mesh.bisect', 'mesh.bridge', 'mesh.spin', 'uv.unwrap',
    'object.booleanDifference', 'object.decimate', 'render.image', 'anim.insertKey',
    'mode.sculpt', 'transform.proportional', 'transform.snap',
  ]) {
    const cmd = COMMANDS_BY_ID.get(id);
    assert.ok(cmd, `${id} is missing`);
    assert.ok(
      ['File', 'Edit', 'Add', 'Object', 'Mesh', 'Select', 'View'].includes(cmd!.category),
      `${id} has no menu home`,
    );
  }
});

test('preference defaults are sane', () => {
  const p = defaultPreferences();
  assert.ok(p.autosaveSeconds >= 15);
  assert.ok(p.renderSamples > 0 && p.renderWidth > 0 && p.renderHeight > 0);
  assert.ok(p.snapIncrement > 0);
});
