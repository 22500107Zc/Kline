import test from 'node:test';
import assert from 'node:assert/strict';
import { RAD2DEG, Vec3 } from '../src/core/math';
import { ViewportCamera } from '../src/scene/ViewportCamera';
import { TransformSession } from '../src/editor/transform';
import { KEYMAP, COMMANDS_BY_ID, lookupKey } from '../src/editor/commands';

const VP = { width: 800, height: 600 };

function frontCamera(): ViewportCamera {
  const c = new ViewportCamera();
  c.setAxisView('front'); // looking along +Y, with +X right and +Z up
  c.distance = 10;
  c.target = new Vec3();
  return c;
}

test('the camera projects and unprojects consistently', () => {
  const cam = frontCamera();
  const p = new Vec3(1, 0, 2);
  const s = cam.worldToScreen(p, VP.width, VP.height);
  const ray = cam.screenRay(s.x, s.y, VP.width, VP.height);
  const toPoint = p.sub(ray.origin);
  const cross = toPoint.normalized().cross(ray.dir).length();
  assert.ok(cross < 1e-3, `ray should pass through the point (cross ${cross})`);
});

test('axis views look down the expected axes', () => {
  const cam = new ViewportCamera();
  cam.setAxisView('top');
  assert.ok(cam.forward().z < -0.999);
  cam.setAxisView('front');
  assert.ok(cam.forward().y > 0.999);
  cam.setAxisView('right');
  assert.ok(cam.forward().x < -0.999);
});

test('constrained translation only moves along its axis', () => {
  const cam = frontCamera();
  const s = new TransformSession('translate', new Vec3(), cam, VP, 400, 300);
  s.setModifiers({ precision: false, snap: false });
  s.setAxis(0);
  const m = s.update(500, 240);
  const moved = m.transformPoint(new Vec3());
  assert.ok(Math.abs(moved.y) < 1e-9 && Math.abs(moved.z) < 1e-9, 'stays on X');
  assert.ok(moved.x > 0, 'moves right with the mouse');
});

test('typed numeric input overrides the mouse', () => {
  const s = new TransformSession('translate', new Vec3(), frontCamera(), VP, 400, 300);
  s.setModifiers({ precision: false, snap: false });
  s.setAxis(2);
  for (const ch of '2.5') assert.ok(s.typeChar(ch));
  const moved = s.update(410, 310).transformPoint(new Vec3());
  assert.ok(moved.equals(new Vec3(0, 0, 2.5), 1e-9));
  assert.match(s.header(), /2\.5/);
});

test('a custom constraint follows an arbitrary direction, and axis keys clear it', () => {
  const s = new TransformSession('translate', new Vec3(), frontCamera(), VP, 400, 300);
  s.setModifiers({ precision: false, snap: false });
  s.constrainTo(new Vec3(0, 0, 1), 'normal');
  for (const ch of '3') s.typeChar(ch);
  assert.ok(s.update(400, 300).transformPoint(new Vec3()).equals(new Vec3(0, 0, 3), 1e-9));
  assert.match(s.header(), /along normal/);
  s.setAxis(0);
  assert.equal(s.custom, null);
});

test('snapping quantises translation', () => {
  const s = new TransformSession('translate', new Vec3(), frontCamera(), VP, 400, 300);
  s.setAxis(0);
  s.setModifiers({ precision: false, snap: true });
  const moved = s.update(437, 300).transformPoint(new Vec3());
  assert.ok(Math.abs(moved.x / 0.25 - Math.round(moved.x / 0.25)) < 1e-9, 'lands on the grid');
});

test('scale about a pivot leaves the pivot fixed', () => {
  const pivot = new Vec3(1, 0, 1);
  const s = new TransformSession('scale', pivot, frontCamera(), VP, 500, 300);
  s.setModifiers({ precision: false, snap: false });
  for (const ch of '2') s.typeChar(ch);
  const m = s.update(500, 300);
  assert.ok(m.transformPoint(pivot).equals(pivot, 1e-6), 'pivot is a fixed point');
  assert.ok(m.transformPoint(pivot.add(new Vec3(1, 0, 0))).equals(pivot.add(new Vec3(2, 0, 0)), 1e-6));
});

test('rotation about a pivot preserves distance', () => {
  const pivot = new Vec3();
  const s = new TransformSession('rotate', pivot, frontCamera(), VP, 500, 300);
  s.setModifiers({ precision: false, snap: false });
  s.setAxis(2);
  for (const ch of '90') s.typeChar(ch);
  const m = s.update(500, 300);
  const p = new Vec3(1, 0, 0);
  const r = m.transformPoint(p);
  assert.ok(Math.abs(r.length() - 1) < 1e-6);
  assert.ok(Math.abs(r.z) < 1e-6, 'stays in the XY plane');
  assert.match(s.header(), /90\.00°/);
});

test('every key binding points at a real command', () => {
  for (const binding of KEYMAP) {
    assert.ok(COMMANDS_BY_ID.has(binding.command), `unknown command ${binding.command}`);
  }
});

test('mode-specific bindings win over generic ones', () => {
  assert.equal(lookupKey('x', 'edit'), 'mesh.delete');
  assert.equal(lookupKey('x', 'object'), 'object.delete');
  assert.equal(lookupKey('ctrl+z', 'edit'), 'edit.undo');
  assert.equal(lookupKey('nope', 'object'), null);
});

test('command shortcut labels stay in sync with the keymap', () => {
  for (const cmd of COMMANDS_BY_ID.values()) {
    if (!cmd.shortcut || cmd.shortcut.startsWith('Numpad') || cmd.shortcut.includes('Numpad')) continue;
    const chord = cmd.shortcut.toLowerCase().replace(/\s+/g, '');
    const bound = KEYMAP.some((k) => k.chord === chord && k.command === cmd.id);
    assert.ok(bound, `${cmd.id} advertises ${cmd.shortcut} but nothing is bound to it`);
  }
});

test('rotation angle readout uses degrees', () => {
  assert.ok(Math.abs(RAD2DEG * Math.PI - 180) < 1e-9);
});
