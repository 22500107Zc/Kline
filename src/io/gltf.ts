import { Vec3 } from '../core/math';
import { Scene, SceneObject } from '../scene/Scene';

/**
 * glTF 2.0 export (.gltf with an embedded base64 buffer).
 *
 * Kiln is Z-up, glTF is Y-up, so everything is parented to a root node that
 * carries a -90° X rotation instead of rewriting every vertex.
 */

interface GLTFAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

function eulerToQuaternion(e: Vec3): [number, number, number, number] {
  // Matches Mat4.rotationEuler: Rz * Ry * Rx.
  const cx = Math.cos(e.x / 2), sx = Math.sin(e.x / 2);
  const cy = Math.cos(e.y / 2), sy = Math.sin(e.y / 2);
  const cz = Math.cos(e.z / 2), sz = Math.sin(e.z / 2);
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function exportGLTF(scene: Scene, selectionOnly = false): string {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target: number }[] = [];
  const accessors: GLTFAccessor[] = [];

  const pushView = (data: ArrayBufferView, target: number): number => {
    // glTF requires 4-byte aligned buffer views.
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const materials = scene.materials.map((m) => ({
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: [...m.color, m.alpha],
      metallicFactor: m.metallic,
      roughnessFactor: m.roughness,
    },
    emissiveFactor: m.emission.map((c) => Math.min(1, c * Math.max(m.emissionStrength, 0))),
    alphaMode: m.alpha < 0.999 ? 'BLEND' : 'OPAQUE',
    doubleSided: true,
  }));

  const meshes: unknown[] = [];
  const nodes: Record<string, unknown>[] = [];
  const lights: Record<string, unknown>[] = [];
  const nodeIndexById = new Map<number, number>();

  const included: SceneObject[] = [...scene.objects.values()].filter(
    (o) => (!selectionOnly || scene.selection.has(o.id)) && o.visible,
  );

  for (const obj of included) {
    const node: Record<string, unknown> = { name: obj.name };
    const q = eulerToQuaternion(obj.rotation);
    if (obj.position.lengthSq() > 0) node.translation = obj.position.toArray();
    if (Math.abs(q[3] - 1) > 1e-9) node.rotation = q;
    if (!obj.scale.equals(new Vec3(1, 1, 1))) node.scale = obj.scale.toArray();

    if (obj.type === 'mesh') {
      const mesh = obj.evaluated();
      if (mesh && mesh.faceCount > 0) {
        const t = mesh.topology();
        // One primitive per material slot used by the mesh.
        const bySlot = new Map<number, number[]>();
        for (let f = 0; f < mesh.faces.length; f++) {
          const slot = mesh.faceMaterial[f] ?? 0;
          const list = bySlot.get(slot) ?? [];
          list.push(f);
          bySlot.set(slot, list);
        }
        const primitives: unknown[] = [];
        for (const [slot, faces] of bySlot) {
          const positions: number[] = [];
          const normals: number[] = [];
          const indices: number[] = [];
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          for (const f of faces) {
            const loop = mesh.faces[f];
            const smooth = mesh.isFaceSmooth(f);
            const base = positions.length / 3;
            for (const v of loop) {
              const p = mesh.positions[v];
              const n = smooth ? t.vertNormals[v] : t.faceNormals[f];
              positions.push(p.x, p.y, p.z);
              normals.push(n.x, n.y, n.z);
              for (let k = 0; k < 3; k++) {
                const c = [p.x, p.y, p.z][k];
                min[k] = Math.min(min[k], c);
                max[k] = Math.max(max[k], c);
              }
            }
            for (let i = 1; i + 1 < loop.length; i++) indices.push(base, base + i, base + i + 1);
          }
          if (indices.length === 0) continue;

          const posView = pushView(new Float32Array(positions), TARGET_ARRAY_BUFFER);
          accessors.push({
            bufferView: posView, componentType: COMPONENT_FLOAT,
            count: positions.length / 3, type: 'VEC3', min, max,
          });
          const posAccessor = accessors.length - 1;

          const nrmView = pushView(new Float32Array(normals), TARGET_ARRAY_BUFFER);
          accessors.push({
            bufferView: nrmView, componentType: COMPONENT_FLOAT,
            count: normals.length / 3, type: 'VEC3',
          });
          const nrmAccessor = accessors.length - 1;

          const idxView = pushView(new Uint32Array(indices), TARGET_ELEMENT_ARRAY_BUFFER);
          accessors.push({
            bufferView: idxView, componentType: COMPONENT_UINT,
            count: indices.length, type: 'SCALAR',
          });
          const idxAccessor = accessors.length - 1;

          primitives.push({
            attributes: { POSITION: posAccessor, NORMAL: nrmAccessor },
            indices: idxAccessor,
            material: obj.materialSlots[slot] ?? 0,
            mode: 4,
          });
        }
        if (primitives.length) {
          meshes.push({ name: `${obj.name}-mesh`, primitives });
          node.mesh = meshes.length - 1;
        }
      }
    } else if (obj.type === 'light' && obj.light) {
      const l = obj.light;
      const type = l.type === 'sun' ? 'directional' : l.type === 'spot' ? 'spot' : 'point';
      const light: Record<string, unknown> = {
        name: obj.name,
        type,
        color: l.color,
        // Approximate: Blender-style watts converted to candela / lux.
        intensity: type === 'directional' ? l.energy : l.energy / (4 * Math.PI),
      };
      if (type === 'spot') {
        light.spot = { innerConeAngle: l.spotAngle * 0.75, outerConeAngle: l.spotAngle };
      }
      lights.push(light);
      node.extensions = { KHR_lights_punctual: { light: lights.length - 1 } };
    } else if (obj.type === 'camera' && obj.camera) {
      node.camera = 0;
    }

    nodes.push(node);
    nodeIndexById.set(obj.id, nodes.length - 1);
  }

  // Re-create the hierarchy, then parent everything under a Z-up→Y-up root.
  const parented = new Set<number>();
  for (const obj of included) {
    if (obj.parent === null) continue;
    const pi = nodeIndexById.get(obj.parent);
    const ci = nodeIndexById.get(obj.id);
    if (pi === undefined || ci === undefined) continue;
    const kids = (nodes[pi].children as number[]) ?? [];
    kids.push(ci);
    nodes[pi].children = kids;
    parented.add(ci);
  }
  const roots = nodes.map((_, i) => i).filter((i) => !parented.has(i));
  const s = Math.SQRT1_2;
  nodes.push({ name: 'KilnScene', rotation: [-s, 0, 0, s], children: roots });
  const rootIndex = nodes.length - 1;

  const cameras = [...scene.objects.values()].some((o) => o.type === 'camera' && o.camera)
    ? [{
        type: 'perspective',
        perspective: { yfov: 39.6 * (Math.PI / 180), znear: 0.1, zfar: 1000, aspectRatio: 16 / 9 },
      }]
    : undefined;

  const totalBytes = new Uint8Array(byteLength);
  let o = 0;
  for (const c of chunks) {
    totalBytes.set(c, o);
    o += c.byteLength;
  }

  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Kiln' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [rootIndex] }],
    nodes,
    meshes,
    materials: materials.length ? materials : undefined,
    accessors,
    bufferViews,
    buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${base64(totalBytes)}` }],
    cameras,
  };
  if (lights.length) {
    gltf.extensionsUsed = ['KHR_lights_punctual'];
    gltf.extensions = { KHR_lights_punctual: { lights } };
  }
  return JSON.stringify(gltf, null, 2);
}
