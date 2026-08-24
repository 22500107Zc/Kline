import { Mat4, Vec3 } from '../../core/math';
import { Scene } from '../../scene/Scene';
import { ViewportCamera } from '../../scene/ViewportCamera';
import { LIGHT_STRIDE, MATERIAL_STRIDE, TraceCamera, TraceScene } from './types';

/** Flatten the editable scene into the tracer's transferable form. */
export function buildTraceScene(scene: Scene, camera: TraceCamera, skyStrength = 0.6): TraceScene {
  const posList: number[] = [];
  const nrmList: number[] = [];
  const uvList: number[] = [];
  const matList: number[] = [];

  for (const obj of scene.objects.values()) {
    if (!obj.visible || obj.type !== 'mesh') continue;
    const mesh = obj.evaluated(false);
    if (!mesh || mesh.faceCount === 0) continue;
    const model: Mat4 = obj.worldMatrix(scene);
    const normalMat = model.normalMatrix();
    const t = mesh.topology();
    const slots = obj.materialSlots.length ? obj.materialSlots : [0];

    const world = mesh.positions.map((p) => model.transformPoint(p));
    const worldVertN = t.vertNormals.map((n) => normalMat.transformDirection(n).normalized());

    for (let f = 0; f < mesh.faces.length; f++) {
      const loop = mesh.faces[f];
      if (loop.length < 3) continue;
      const smooth = mesh.isFaceSmooth(f);
      const fn = normalMat.transformDirection(t.faceNormals[f]).normalized();
      const slot = mesh.faceMaterial[f] ?? 0;
      const matIndex = slots[Math.min(slot, slots.length - 1)] ?? 0;
      const uv = mesh.uvFor(f);
      for (let i = 1; i + 1 < loop.length; i++) {
        for (const corner of [0, i, i + 1]) {
          const v = loop[corner];
          const p = world[v];
          const n = smooth ? worldVertN[v] : fn;
          posList.push(p.x, p.y, p.z);
          nrmList.push(n.x, n.y, n.z);
          uvList.push(uv ? uv[corner * 2] : 0, uv ? uv[corner * 2 + 1] : 0);
        }
        matList.push(matIndex);
      }
    }
  }

  const materials = new Float32Array(Math.max(1, scene.materials.length) * MATERIAL_STRIDE);
  for (let i = 0; i < scene.materials.length; i++) {
    const m = scene.materials[i];
    const o = i * MATERIAL_STRIDE;
    materials[o] = m.color[0];
    materials[o + 1] = m.color[1];
    materials[o + 2] = m.color[2];
    materials[o + 3] = m.metallic;
    materials[o + 4] = m.roughness;
    materials[o + 5] = m.emission[0];
    materials[o + 6] = m.emission[1];
    materials[o + 7] = m.emission[2];
    materials[o + 8] = m.emissionStrength;
    materials[o + 9] = m.alpha;
  }
  if (scene.materials.length === 0) {
    materials.set([0.75, 0.75, 0.78, 0, 0.5, 0, 0, 0, 0, 1]);
  }

  const lightObjects = [...scene.objects.values()].filter((o) => o.type === 'light' && o.visible && o.light);
  const lights = new Float32Array(Math.max(1, lightObjects.length) * LIGHT_STRIDE);
  lightObjects.forEach((obj, i) => {
    const l = obj.light!;
    const m = obj.worldMatrix(scene);
    const p = m.transformPoint(new Vec3());
    const d = m.transformDirection(new Vec3(0, 0, -1)).normalized();
    const type = l.type === 'point' ? 0 : l.type === 'sun' ? 1 : l.type === 'spot' ? 2 : 3;
    const o = i * LIGHT_STRIDE;
    lights[o] = p.x;
    lights[o + 1] = p.y;
    lights[o + 2] = p.z;
    lights[o + 3] = type;
    // A sun's "energy" is irradiance, not power, so it does not want the 4π.
    const e = type === 1 ? l.energy : l.energy;
    lights[o + 4] = l.color[0] * e;
    lights[o + 5] = l.color[1] * e;
    lights[o + 6] = l.color[2] * e;
    lights[o + 7] = Math.max(0, l.size);
    lights[o + 8] = d.x;
    lights[o + 9] = d.y;
    lights[o + 10] = d.z;
    lights[o + 11] = Math.cos(l.spotAngle);
  });

  return {
    positions: new Float32Array(posList),
    normals: new Float32Array(nrmList),
    uvs: new Float32Array(uvList),
    material: new Int32Array(matList),
    materials,
    lights,
    lightCount: lightObjects.length,
    background: [...scene.world.background] as [number, number, number],
    ambient: scene.world.ambient,
    skyStrength,
    camera,
  };
}

/** Camera description for the current viewport view. */
export function cameraFromViewport(vc: ViewportCamera): TraceCamera {
  const eye = vc.eye();
  const f = vc.forward();
  const r = vc.right();
  const u = vc.up();
  return {
    origin: [eye.x, eye.y, eye.z],
    forward: [f.x, f.y, f.z],
    right: [r.x, r.y, r.z],
    up: [u.x, u.y, u.z],
    fovY: vc.fov,
    orthographic: vc.orthographic,
    orthoHeight: vc.orthoHalfHeight(),
  };
}

/** Camera description for a scene camera object. */
export function cameraFromObject(scene: Scene, objId: number): TraceCamera | null {
  const obj = scene.get(objId);
  if (!obj || obj.type !== 'camera' || !obj.camera) return null;
  const m = obj.worldMatrix(scene);
  const origin = m.transformPoint(new Vec3());
  const forward = m.transformDirection(new Vec3(0, 0, -1)).normalized();
  const up = m.transformDirection(new Vec3(0, 1, 0)).normalized();
  const right = forward.cross(up).normalized();
  return {
    origin: [origin.x, origin.y, origin.z],
    forward: [forward.x, forward.y, forward.z],
    right: [right.x, right.y, right.z],
    up: [up.x, up.y, up.z],
    fovY: obj.camera.fov,
    orthographic: false,
    orthoHeight: 1,
  };
}
