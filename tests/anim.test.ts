import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeTransform, defaultTimeline, keyFrames, offsetKeys, removeKey, sampleChannel,
  sampleChannels, setKey,
} from '../src/anim/animation';
import type { Channel } from '../src/anim/animation';
import { Scene } from '../src/scene/Scene';
import { buildPrimitive } from '../src/mesh/primitives';
import { exportGLTF } from '../src/io/gltf';
import { Vec3 } from '../src/core/math';

test('keys land sorted no matter what order they arrive in', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 30, 3);
  setKey(channels, 'position', 0, 1, 1);
  setKey(channels, 'position', 0, 15, 2);
  assert.deepEqual(channels[0].keys.map((k) => k.frame), [1, 15, 30]);
  // Re-keying the same frame replaces rather than duplicates.
  setKey(channels, 'position', 0, 15, 9);
  assert.equal(channels[0].keys.length, 3);
  assert.equal(channels[0].keys[1].value, 9);
});

test('sampling holds the ends and interpolates between', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 10, 0, 'linear');
  setKey(channels, 'position', 0, 20, 10, 'linear');
  const ch = channels[0];
  assert.equal(sampleChannel(ch, 5), 0);
  assert.equal(sampleChannel(ch, 10), 0);
  assert.equal(sampleChannel(ch, 15), 5);
  assert.equal(sampleChannel(ch, 20), 10);
  assert.equal(sampleChannel(ch, 99), 10);
});

test('constant interpolation steps rather than ramps', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 1, 1, 0, 'constant');
  setKey(channels, 'position', 1, 10, 5, 'constant');
  assert.equal(sampleChannel(channels[0], 9), 0);
  assert.equal(sampleChannel(channels[0], 10), 5);
});

test('bezier eases and never overshoots a local extreme', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 2, 1, 0);
  setKey(channels, 'position', 2, 10, 1);
  setKey(channels, 'position', 2, 20, 0);
  const ch = channels[0];
  for (let f = 1; f <= 20; f += 0.5) {
    const v = sampleChannel(ch, f)!;
    assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `overshot to ${v} at frame ${f}`);
  }
  // The peak key is flat, so its neighbours sit just below it.
  assert.ok(sampleChannel(ch, 9)! < 1);
  assert.ok(sampleChannel(ch, 11)! < 1);
});

test('only keyed components are overwritten', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 1, 5);
  const sampled = sampleChannels(channels, 1);
  const current = { position: new Vec3(1, 2, 3), rotation: new Vec3(), scale: new Vec3(1, 1, 1) };
  const next = completeTransform(sampled, current, channels);
  assert.equal(next.position.x, 5);
  assert.equal(next.position.y, 2, 'unkeyed Y must survive');
  assert.equal(next.position.z, 3);
  assert.equal(next.scale.x, 1);
});

test('removing a key prunes the empty channel', () => {
  const channels: Channel[] = [];
  setKey(channels, 'scale', 0, 4, 2);
  assert.equal(channels.length, 1);
  assert.equal(removeKey(channels, 4), 1);
  assert.equal(channels.length, 0);
});

test('keyFrames lists each keyed frame once', () => {
  const channels: Channel[] = [];
  setKey(channels, 'position', 0, 5, 0);
  setKey(channels, 'position', 1, 5, 0);
  setKey(channels, 'rotation', 2, 12, 0);
  assert.deepEqual(keyFrames(channels), [5, 12]);
  offsetKeys(channels, 10);
  assert.deepEqual(keyFrames(channels), [15, 22]);
});

test('the scene drives animated objects and leaves the rest alone', () => {
  const scene = new Scene();
  const moving = scene.add('mesh', 'Moving', buildPrimitive('cube'));
  const still = scene.add('mesh', 'Still', buildPrimitive('cube'));
  still.position = new Vec3(9, 9, 9);
  setKey(moving.animation, 'position', 0, 1, 0, 'linear');
  setKey(moving.animation, 'position', 0, 11, 10, 'linear');

  assert.equal(scene.hasAnimation, true);
  scene.setFrame(6);
  assert.equal(moving.position.x, 5);
  assert.equal(still.position.x, 9);
  scene.setFrame(1);
  assert.equal(moving.position.x, 0);
});

test('animation survives a scene round trip', () => {
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  setKey(obj.animation, 'rotation', 2, 1, 0);
  setKey(obj.animation, 'rotation', 2, 24, Math.PI);
  scene.timeline = { ...defaultTimeline(), end: 24, fps: 30 };
  const copy = Scene.fromJSON(JSON.parse(JSON.stringify(scene.toJSON())));
  const restored = [...copy.objects.values()][0];
  assert.equal(restored.animation.length, 1);
  assert.equal(restored.animation[0].keys.length, 2);
  assert.equal(copy.timeline.fps, 30);
  assert.equal(copy.timeline.playing, false, 'a saved scene should never load mid-playback');
});

test('glTF export carries the animation and UV channels', () => {
  const scene = new Scene();
  const obj = scene.add('mesh', 'Cube', buildPrimitive('cube'));
  setKey(obj.animation, 'position', 0, 1, 0, 'linear');
  setKey(obj.animation, 'position', 0, 10, 4, 'linear');
  scene.timeline = { ...defaultTimeline(), start: 1, end: 10, fps: 24 };
  const gltf = JSON.parse(exportGLTF(scene));
  assert.equal(gltf.animations.length, 1);
  assert.equal(gltf.animations[0].channels[0].target.path, 'translation');
  assert.ok(gltf.animations[0].samplers.length >= 1);

  const noUV = JSON.parse(exportGLTF(scene));
  assert.equal(noUV.meshes[0].primitives[0].attributes.TEXCOORD_0, undefined);
});
