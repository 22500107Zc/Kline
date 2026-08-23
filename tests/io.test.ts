import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from '../src/core/math';
import { Scene } from '../src/scene/Scene';
import { createCube, createUVSphere } from '../src/mesh/primitives';
import { createMaterial } from '../src/scene/Material';
import { createModifier } from '../src/modifiers';
import { exportOBJ, importOBJ } from '../src/io/obj';
import { exportSTL } from '../src/io/stl';
import { exportGLTF } from '../src/io/gltf';

function sceneWithCube(): Scene {
  const s = new Scene();
  s.materials.push(createMaterial({ name: 'Clay', color: [0.8, 0.4, 0.2] }));
  const obj = s.add('mesh', 'Cube', createCube());
  obj.position = new Vec3(0, 0, 1);
  return s;
}

test('OBJ export writes transformed, Y-up geometry', () => {
  const text = exportOBJ(sceneWithCube());
  const verts = text.split('\n').filter((l) => l.startsWith('v '));
  assert.equal(verts.length, 8);
  assert.equal(text.split('\n').filter((l) => l.startsWith('f ')).length, 6);
  assert.match(text, /^o Cube$/m);
  assert.match(text, /^usemtl Clay$/m);
  // Kiln's +Z (up) becomes OBJ's +Y, so every vertex sits at y = 0 or y = 2.
  for (const line of verts) {
    const y = parseFloat(line.split(/\s+/)[2]);
    assert.ok(Math.abs(y) < 1e-6 || Math.abs(y - 2) < 1e-6, `unexpected y ${y}`);
  }
});

test('OBJ round-trips through import with axes restored', () => {
  const back = importOBJ(exportOBJ(sceneWithCube()));
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'Cube');
  assert.equal(back[0].mesh.vertCount, 8);
  assert.equal(back[0].mesh.faceCount, 6);
  const b = back[0].mesh.bounds();
  assert.ok(Math.abs(b.min.z) < 1e-5 && Math.abs(b.max.z - 2) < 1e-5, 'Z-up restored');
});

test('OBJ import handles negative indices, quads and missing groups', () => {
  const objects = importOBJ([
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
    'f -4 -3 -2 -1',
  ].join('\n'));
  assert.equal(objects.length, 1);
  assert.deepEqual(objects[0].mesh.faces, [[0, 1, 2, 3]]);
});

test('binary STL has a correct header and triangle count', () => {
  const buffer = exportSTL(sceneWithCube());
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  assert.equal(count, 12, 'a cube is twelve triangles');
  assert.equal(buffer.byteLength, 84 + 12 * 50);
});

test('glTF export produces a valid-looking document', () => {
  const s = sceneWithCube();
  s.add('light', 'Light').position = new Vec3(3, 3, 3);
  const obj = s.activeObject ?? [...s.objects.values()][0];
  obj.modifiers.push(createModifier('subsurf'));
  const gltf = JSON.parse(exportGLTF(s));

  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.meshes.length, 1);
  assert.equal(gltf.materials.length, 1);
  assert.deepEqual(gltf.extensionsUsed, ['KHR_lights_punctual']);
  assert.equal(gltf.extensions.KHR_lights_punctual.lights.length, 1);

  // The root node converts Z-up to Y-up and owns every other node.
  const root = gltf.nodes[gltf.scenes[0].nodes[0]];
  assert.equal(root.name, 'KilnScene');
  assert.ok(Math.abs(root.rotation[0] + Math.SQRT1_2) < 1e-6);
  assert.equal(root.children.length, 2);

  // Buffer views must be 4-byte aligned and inside the buffer.
  const byteLength = gltf.buffers[0].byteLength;
  for (const view of gltf.bufferViews) {
    assert.equal(view.byteOffset % 4, 0, 'aligned');
    assert.ok(view.byteOffset + view.byteLength <= byteLength, 'inside the buffer');
  }
  const positions = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  assert.equal(positions.type, 'VEC3');
  assert.equal(positions.min.length, 3);
  assert.ok(gltf.buffers[0].uri.startsWith('data:application/octet-stream;base64,'));
});

test('glTF export honours the selection filter', () => {
  const s = sceneWithCube();
  s.add('mesh', 'Sphere', createUVSphere(1, 8, 6));
  s.selection = new Set([[...s.objects.values()][0].id]);
  const gltf = JSON.parse(exportGLTF(s, true));
  assert.equal(gltf.meshes.length, 1);
});
