import { Vec3 } from '../core/math';
import { Scene, SceneObject } from '../scene/Scene';
import { Channel, sampleChannel } from '../anim/animation';

/**
 * glTF 2.0 export (.gltf with an embedded base64 buffer).
 *
 * Kline is Z-up, glTF is Y-up, so everything is parented to a root node that
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

  // Images, and the textures that point at them.
  //
  // Kline stores a texture as a data URL so a saved scene is self-contained,
  // and glTF accepts a data URL as an image `uri` — so the picture travels
  // inside the .gltf too. Without this the export carried TEXCOORD_0 and a
  // material and no image at all: every model built from a photograph arrived
  // in Blender or a game engine as a grey lump, with nothing in the file to
  // say the photograph had ever been on it.
  const imageOfTexture = new Map<number, number>();
  const images: { uri: string; name?: string }[] = [];
  const textures: { source: number; sampler: number }[] = [];
  for (const t of scene.textures) {
    if (!t?.url || imageOfTexture.has(t.id)) continue;
    imageOfTexture.set(t.id, textures.length);
    images.push({ uri: t.url, name: t.name });
    textures.push({ source: images.length - 1, sampler: 0 });
  }
  const usesTextures = textures.length > 0;
  const textureTransforms: string[] = [];

  const materials = scene.materials.map((m) => {
    const index = m.baseColorTexture == null ? undefined : imageOfTexture.get(m.baseColorTexture);
    const pbr: Record<string, unknown> = {
      baseColorFactor: [...m.color, m.alpha],
      metallicFactor: m.metallic,
      roughnessFactor: m.roughness,
    };
    if (index !== undefined) {
      const base: Record<string, unknown> = { index };
      // Tiling and offset are not part of a plain glTF texture reference, so
      // exporting them silently would mean the model arrives with its picture
      // stretched differently from how it looks here.
      const tiled = m.uvScale[0] !== 1 || m.uvScale[1] !== 1
        || m.uvOffset[0] !== 0 || m.uvOffset[1] !== 0;
      if (tiled) {
        base.extensions = {
          KHR_texture_transform: { scale: [...m.uvScale], offset: [...m.uvOffset] },
        };
        if (!textureTransforms.length) textureTransforms.push('KHR_texture_transform');
      }
      pbr.baseColorTexture = base;
    }
    return {
      name: m.name,
      pbrMetallicRoughness: pbr,
      emissiveFactor: m.emission.map((c) => Math.min(1, c * Math.max(m.emissionStrength, 0))),
      alphaMode: m.alpha < 0.999 ? 'BLEND' : 'OPAQUE',
      doubleSided: true,
    };
  });

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
          const texcoords: number[] = [];
          const indices: number[] = [];
          let anyUV = false;
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          for (const f of faces) {
            const loop = mesh.faces[f];
            const smooth = mesh.isFaceSmooth(f);
            const base = positions.length / 3;
            const uv = mesh.uvFor(f);
            if (uv) anyUV = true;
            for (let corner = 0; corner < loop.length; corner++) {
              const v = loop[corner];
              const p = mesh.positions[v];
              const n = smooth ? t.shadingNormals[v] : t.faceNormals[f];
              positions.push(p.x, p.y, p.z);
              normals.push(n.x, n.y, n.z);
              // glTF's V axis runs the other way.
              texcoords.push(uv ? uv[corner * 2] : 0, uv ? 1 - uv[corner * 2 + 1] : 0);
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

          let uvAccessor: number | undefined;
          if (anyUV) {
            const uvView = pushView(new Float32Array(texcoords), TARGET_ARRAY_BUFFER);
            accessors.push({
              bufferView: uvView, componentType: COMPONENT_FLOAT,
              count: texcoords.length / 2, type: 'VEC2',
            });
            uvAccessor = accessors.length - 1;
          }

          const idxView = pushView(new Uint32Array(indices), TARGET_ELEMENT_ARRAY_BUFFER);
          accessors.push({
            bufferView: idxView, componentType: COMPONENT_UINT,
            count: indices.length, type: 'SCALAR',
          });
          const idxAccessor = accessors.length - 1;

          const attributes: Record<string, number> = { POSITION: posAccessor, NORMAL: nrmAccessor };
          if (uvAccessor !== undefined) attributes.TEXCOORD_0 = uvAccessor;
          primitives.push({
            attributes,
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
  nodes.push({ name: 'KlineScene', rotation: [-s, 0, 0, s], children: roots });
  const rootIndex = nodes.length - 1;

  const cameras = [...scene.objects.values()].some((o) => o.type === 'camera' && o.camera)
    ? [{
        type: 'perspective',
        perspective: { yfov: 39.6 * (Math.PI / 180), znear: 0.1, zfar: 1000, aspectRatio: 16 / 9 },
      }]
    : undefined;

  // ---- animation: one sampler per animated node, baked at the scene's fps
  const animChannels: Record<string, unknown>[] = [];
  const animSamplers: Record<string, unknown>[] = [];
  const tl = scene.timeline;
  for (const obj of included) {
    if (obj.animation.length === 0) continue;
    const nodeIndex = nodeIndexById.get(obj.id);
    if (nodeIndex === undefined) continue;
    const frames: number[] = [];
    for (let f = tl.start; f <= tl.end; f++) frames.push(f);
    if (frames.length < 2) continue;
    const times = new Float32Array(frames.map((f) => (f - tl.start) / Math.max(1, tl.fps)));
    const timeView = pushView(times, TARGET_ARRAY_BUFFER);
    accessors.push({
      bufferView: timeView, componentType: COMPONENT_FLOAT, count: times.length,
      type: 'SCALAR', min: [times[0]], max: [times[times.length - 1]],
    });
    const timeAccessor = accessors.length - 1;

    const paths: { path: 'translation' | 'rotation' | 'scale'; key: 'position' | 'rotation' | 'scale' }[] = [
      { path: 'translation', key: 'position' },
      { path: 'rotation', key: 'rotation' },
      { path: 'scale', key: 'scale' },
    ];
    for (const { path, key } of paths) {
      const chans = obj.animation.filter((c: Channel) => c.path === key);
      if (chans.length === 0) continue;
      const base = key === 'position' ? obj.position : key === 'rotation' ? obj.rotation : obj.scale;
      const comps = path === 'rotation' ? 4 : 3;
      const values = new Float32Array(frames.length * comps);
      frames.forEach((frame, i) => {
        const v = base.clone();
        for (const c of chans) {
          const sampled = sampleChannel(c, frame);
          if (sampled === null) continue;
          if (c.index === 0) v.x = sampled;
          else if (c.index === 1) v.y = sampled;
          else v.z = sampled;
        }
        if (path === 'rotation') values.set(eulerToQuaternion(v), i * 4);
        else values.set([v.x, v.y, v.z], i * 3);
      });
      const valueView = pushView(values, TARGET_ARRAY_BUFFER);
      accessors.push({
        bufferView: valueView, componentType: COMPONENT_FLOAT,
        count: frames.length, type: path === 'rotation' ? 'VEC4' : 'VEC3',
      });
      animSamplers.push({ input: timeAccessor, output: accessors.length - 1, interpolation: 'LINEAR' });
      animChannels.push({
        sampler: animSamplers.length - 1,
        target: { node: nodeIndex, path },
      });
    }
  }

  const totalBytes = new Uint8Array(byteLength);
  let o = 0;
  for (const c of chunks) {
    totalBytes.set(c, o);
    o += c.byteLength;
  }

  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Kline' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [rootIndex] }],
    nodes,
    meshes,
    materials: materials.length ? materials : undefined,
    images: usesTextures ? images : undefined,
    textures: usesTextures ? textures : undefined,
    // One sampler for everything: Kline wraps and filters every texture the
    // same way, so a per-texture sampler would be the same object repeated.
    samplers: usesTextures
      ? [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
      : undefined,
    accessors,
    bufferViews,
    buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${base64(totalBytes)}` }],
    animations: animChannels.length
      ? [{ name: 'KlineAction', channels: animChannels, samplers: animSamplers }]
      : undefined,
    cameras,
  };
  const extensions = [...(lights.length ? ['KHR_lights_punctual'] : []), ...textureTransforms];
  if (extensions.length) gltf.extensionsUsed = extensions;
  if (lights.length) gltf.extensions = { KHR_lights_punctual: { lights } };
  return JSON.stringify(gltf, null, 2);
}
