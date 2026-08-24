import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '../src/scene/Scene';
import { createMaterial } from '../src/scene/Material';
import { buildPrimitive } from '../src/mesh/primitives';
import { buildTraceScene, cameraFromObject } from '../src/render/pathtrace/build';
import { buildBvh, renderBand, tonemapToImage } from '../src/render/pathtrace/tracer';
import { defaultRenderSettings, LIGHT_STRIDE, MATERIAL_STRIDE } from '../src/render/pathtrace/types';
import { Vec3 } from '../src/core/math';
import type { TraceCamera } from '../src/render/pathtrace/types';

function lookAt(eye: Vec3, target: Vec3): TraceCamera {
  const forward = target.sub(eye).normalized();
  const right = forward.cross(new Vec3(0, 0, 1)).normalized();
  const up = right.cross(forward).normalized();
  return {
    origin: eye.toArray(), forward: forward.toArray(), right: right.toArray(), up: up.toArray(),
    fovY: 0.7, orthographic: false, orthoHeight: 1,
  };
}

function studio(): { scene: Scene; camera: TraceCamera } {
  const scene = new Scene();
  scene.materials.push(createMaterial({ name: 'Grey', color: [0.6, 0.6, 0.6], roughness: 0.8 }));
  const floor = scene.add('mesh', 'Floor', buildPrimitive('plane'));
  floor.scale = new Vec3(10, 10, 1);
  floor.materialSlots = [0];
  const ball = scene.add('mesh', 'Ball', buildPrimitive('uvsphere'));
  ball.position = new Vec3(0, 0, 1);
  ball.materialSlots = [0];
  const light = scene.add('light', 'Key');
  light.position = new Vec3(0, -2, 6);
  if (light.light) light.light.energy = 2000;
  return { scene, camera: lookAt(new Vec3(0, -6, 3), new Vec3(0, 0, 1)) };
}

test('the scene flattens into triangles, materials and lights', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.3);
  assert.ok(ts.positions.length > 0);
  assert.equal(ts.positions.length % 9, 0);
  assert.equal(ts.material.length, ts.positions.length / 9);
  assert.equal(ts.normals.length, ts.positions.length);
  assert.equal(ts.lightCount, 1);
  assert.equal(ts.lights.length % LIGHT_STRIDE, 0);
  assert.equal(ts.materials.length % MATERIAL_STRIDE, 0);
});

test('hidden objects are not traced', () => {
  const { scene, camera } = studio();
  const full = buildTraceScene(scene, camera, 0.3).positions.length;
  for (const o of scene.objects.values()) if (o.name === 'Ball') o.visible = false;
  const fewer = buildTraceScene(scene, camera, 0.3).positions.length;
  assert.ok(fewer < full);
});

test('the BVH covers every triangle', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.3);
  const bvh = buildBvh(ts.positions);
  assert.equal(bvh.order.length, ts.positions.length / 9);
  const seen = new Set(bvh.order);
  assert.equal(seen.size, bvh.order.length, 'a triangle appeared twice');
  assert.ok(bvh.nodeCount > 1);
});

test('a lit scene renders something, and the shadow is darker than the lit floor', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.25);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: 64, height: 48, samples: 24 };
  const band = renderBand(ts, bvh, settings, {
    y0: 0, y1: settings.height, pass: 0, samples: settings.samples, seed: 7,
  });
  assert.equal(band.data.length, settings.width * settings.height * 3);
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < band.data.length; i += 3) {
    const l = (band.data[i] + band.data[i + 1] + band.data[i + 2]) / 3 / settings.samples;
    sum += l;
    if (l < 0.02) dark++;
  }
  const mean = sum / (settings.width * settings.height);
  assert.ok(mean > 0.02, `image came back essentially black (mean ${mean})`);
  assert.ok(Number.isFinite(mean));
  assert.ok(dark < settings.width * settings.height * 0.5, 'most of the frame should be lit');
});

test('an empty scene renders the sky rather than failing', () => {
  const scene = new Scene();
  const ts = buildTraceScene(scene, lookAt(new Vec3(0, -5, 0), new Vec3()), 0.5);
  assert.equal(ts.positions.length, 0);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: 16, height: 16, samples: 2 };
  const band = renderBand(ts, bvh, settings, { y0: 0, y1: 16, pass: 0, samples: 2, seed: 1 });
  assert.ok(band.data.every((v) => Number.isFinite(v) && v >= 0));
  assert.ok(band.data.some((v) => v > 0), 'the sky should still contribute');
});

test('more samples converge rather than drift', () => {
  const { scene, camera } = studio();
  const ts = buildTraceScene(scene, camera, 0.25);
  const bvh = buildBvh(ts.positions);
  const settings = { ...defaultRenderSettings(), width: 32, height: 24 };
  const mean = (samples: number, seed: number): number => {
    const band = renderBand(ts, bvh, settings, { y0: 0, y1: 24, pass: 0, samples, seed });
    let s = 0;
    for (let i = 0; i < band.data.length; i++) s += band.data[i];
    return s / band.data.length / samples;
  };
  const low = mean(8, 1);
  const high = mean(64, 2);
  assert.ok(Math.abs(low - high) / Math.max(high, 1e-6) < 0.25, `${low} vs ${high}`);
});

test('tonemapping produces opaque 8-bit pixels', () => {
  const width = 4;
  const height = 2;
  const accum = new Float32Array(width * height * 3).fill(1.5);
  const out = new Uint8ClampedArray(width * height * 4);
  tonemapToImage(accum, 1, width, height, out);
  for (let i = 0; i < width * height; i++) {
    assert.equal(out[i * 4 + 3], 255);
    assert.ok(out[i * 4] > 180, 'a bright sample should map near white');
  }
});

test('a scene camera drives the framing when there is one', () => {
  const scene = new Scene();
  const cam = scene.add('camera', 'Camera');
  cam.position = new Vec3(3, 4, 5);
  const desc = cameraFromObject(scene, cam.id);
  assert.ok(desc);
  assert.deepEqual(desc!.origin, [3, 4, 5]);
  assert.equal(cameraFromObject(scene, 9999), null);
});
