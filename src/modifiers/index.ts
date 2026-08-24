import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { catmullClark, mergeByDistance, smoothVertices, triangulateFaces } from '../mesh/ops';
import { BooleanOp, meshBoolean } from '../mesh/boolean';
import { decimate } from '../mesh/decimate';
import { bevelEdges } from '../mesh/bevel';
import { transferUV } from '../uv/transfer';
import { ArmatureData } from '../anim/armature';
import { MAX_INFLUENCES, applySkin, resizeSkin } from '../mesh/skin';

/**
 * Non-destructive modifier stack. Modifiers are pure functions from mesh to
 * mesh, evaluated top to bottom; the original edit-mode geometry is never
 * touched.
 */

export type ModifierType =
  | 'subsurf' | 'mirror' | 'array' | 'solidify' | 'weld' | 'triangulate' | 'smooth'
  | 'boolean' | 'decimate' | 'bevel' | 'armature';

interface ModifierBase {
  id: number;
  type: ModifierType;
  name: string;
  enabled: boolean;
  /** Also apply while in Edit Mode (Blender's "display in edit mode"). */
  showInEdit: boolean;
}

export interface SubsurfModifier extends ModifierBase {
  type: 'subsurf';
  levels: number;
}

export interface MirrorModifier extends ModifierBase {
  type: 'mirror';
  axis: [boolean, boolean, boolean];
  merge: boolean;
  mergeThreshold: number;
}

export interface ArrayModifier extends ModifierBase {
  type: 'array';
  count: number;
  /** Offset as a multiple of the bounding-box size along each axis. */
  relativeOffset: [number, number, number];
  constantOffset: [number, number, number];
  mergeEnds: boolean;
}

export interface SolidifyModifier extends ModifierBase {
  type: 'solidify';
  thickness: number;
  /** -1 = inward, 0 = centred, 1 = outward. */
  offset: number;
}

export interface WeldModifier extends ModifierBase {
  type: 'weld';
  distance: number;
}

export interface TriangulateModifier extends ModifierBase {
  type: 'triangulate';
}

export interface SmoothModifier extends ModifierBase {
  type: 'smooth';
  factor: number;
  iterations: number;
}

export interface BooleanModifier extends ModifierBase {
  type: 'boolean';
  operation: BooleanOp;
  /** Scene object id of the cutter. Resolved by the caller, not here. */
  objectId: number | null;
}

export interface DecimateModifier extends ModifierBase {
  type: 'decimate';
  /** Fraction of the original triangle count to keep. */
  ratio: number;
  preserveBorder: boolean;
}

export interface BevelModifier extends ModifierBase {
  type: 'bevel';
  width: number;
  segments: number;
  profile: number;
  /** Only bevel edges sharper than this many degrees. */
  angleLimit: number;
}

export interface ArmatureModifier extends ModifierBase {
  type: 'armature';
  /** Scene object id of the rig. Resolved by the caller, not here. */
  objectId: number | null;
}

export type Modifier =
  | SubsurfModifier | MirrorModifier | ArrayModifier | SolidifyModifier
  | WeldModifier | TriangulateModifier | SmoothModifier
  | BooleanModifier | DecimateModifier | BevelModifier | ArmatureModifier;

/**
 * Resolves a modifier's reference to another object into evaluated geometry
 * already transformed into the owning object's space. Supplied by the scene,
 * which is the only thing that can see other objects.
 */
export type ObjectResolver = (id: number) => Mesh | null;

/**
 * Resolves a reference to an armature, along with the transforms between the
 * two objects' spaces. Separate from `ObjectResolver` because a rig is not
 * geometry and pretending otherwise would mean deforming by a mesh.
 */
export type ArmatureResolver = (id: number) => {
  armature: ArmatureData;
  meshToArmature: Mat4;
  armatureToMesh: Mat4;
} | null;

let modifierCounter = 0;

export function createModifier(type: ModifierType): Modifier {
  const base = { id: ++modifierCounter, enabled: true, showInEdit: false };
  switch (type) {
    case 'subsurf':
      return { ...base, type, name: 'Subdivision', levels: 1, showInEdit: true };
    case 'mirror':
      return {
        ...base, type, name: 'Mirror', axis: [true, false, false],
        merge: true, mergeThreshold: 0.001, showInEdit: true,
      };
    case 'array':
      return {
        ...base, type, name: 'Array', count: 3,
        relativeOffset: [1, 0, 0], constantOffset: [0, 0, 0], mergeEnds: false,
      };
    case 'solidify':
      return { ...base, type, name: 'Solidify', thickness: 0.05, offset: -1 };
    case 'weld':
      return { ...base, type, name: 'Weld', distance: 0.001 };
    case 'triangulate':
      return { ...base, type, name: 'Triangulate' };
    case 'smooth':
      return { ...base, type, name: 'Smooth', factor: 0.5, iterations: 1 };
    case 'boolean':
      return { ...base, type, name: 'Boolean', operation: 'difference', objectId: null };
    case 'decimate':
      return { ...base, type, name: 'Decimate', ratio: 0.5, preserveBorder: true };
    case 'bevel':
      return { ...base, type, name: 'Bevel', width: 0.02, segments: 2, profile: 0.5, angleLimit: 30 };
    case 'armature':
      return { ...base, type, name: 'Armature', objectId: null, showInEdit: true };
  }
}

export const MODIFIER_LABELS: Record<ModifierType, string> = {
  subsurf: 'Subdivision Surface',
  mirror: 'Mirror',
  array: 'Array',
  solidify: 'Solidify',
  weld: 'Weld',
  triangulate: 'Triangulate',
  smooth: 'Smooth',
  boolean: 'Boolean',
  decimate: 'Decimate',
  bevel: 'Bevel',
  armature: 'Armature',
};

function applyMirror(mesh: Mesh, mod: MirrorModifier): Mesh {
  let cur = mesh;
  for (let a = 0; a < 3; a++) {
    if (!mod.axis[a]) continue;
    const out = cur.clone();
    const flipped = cur.clone();
    const s = new Vec3(a === 0 ? -1 : 1, a === 1 ? -1 : 1, a === 2 ? -1 : 1);
    flipped.transform(Mat4.scaling(s));
    // Negative determinant inverts winding, so flip the loops back.
    flipped.faces = flipped.faces.map((f) => f.slice().reverse());
    out.append(flipped);
    if (mod.merge) {
      const onPlane: number[] = [];
      const key: 'x' | 'y' | 'z' = a === 0 ? 'x' : a === 1 ? 'y' : 'z';
      for (let i = 0; i < out.positions.length; i++) {
        if (Math.abs(out.positions[i][key]) <= mod.mergeThreshold) onPlane.push(i);
      }
      for (const i of onPlane) out.positions[i][key] = 0;
      mergeByDistance(out, onPlane, Math.max(mod.mergeThreshold, 1e-6));
    }
    cur = out;
  }
  return cur;
}

function applyArray(mesh: Mesh, mod: ArrayModifier): Mesh {
  const count = Math.max(1, Math.floor(mod.count));
  if (count === 1) return mesh;
  const size = mesh.bounds().size();
  const step = new Vec3(
    mod.relativeOffset[0] * size.x + mod.constantOffset[0],
    mod.relativeOffset[1] * size.y + mod.constantOffset[1],
    mod.relativeOffset[2] * size.z + mod.constantOffset[2],
  );
  const out = mesh.clone();
  for (let i = 1; i < count; i++) {
    const copy = mesh.clone();
    copy.transform(Mat4.translation(step.scale(i)));
    out.append(copy);
  }
  if (mod.mergeEnds) mergeByDistance(out, null, 1e-4);
  return out;
}

function applySolidify(mesh: Mesh, mod: SolidifyModifier): Mesh {
  const t = mesh.topology();
  const th = mod.thickness;
  const outerShift = ((mod.offset + 1) / 2) * th;
  const innerShift = outerShift - th;

  const out = new Mesh([], [], []);
  out.shadeSmooth = mesh.shadeSmooth;
  const nv = mesh.positions.length;
  for (let i = 0; i < nv; i++) out.positions.push(mesh.positions[i].add(t.vertNormals[i].scale(outerShift)));
  for (let i = 0; i < nv; i++) out.positions.push(mesh.positions[i].add(t.vertNormals[i].scale(innerShift)));

  for (let f = 0; f < mesh.faces.length; f++) {
    out.faces.push(mesh.faces[f].slice());
    out.faceMaterial.push(mesh.faceMaterial[f] ?? 0);
  }
  for (let f = 0; f < mesh.faces.length; f++) {
    out.faces.push(mesh.faces[f].slice().reverse().map((v) => v + nv));
    out.faceMaterial.push(mesh.faceMaterial[f] ?? 0);
  }
  // Rim faces along open boundaries.
  for (let f = 0; f < mesh.faces.length; f++) {
    const loop = mesh.faces[f];
    for (let i = 0; i < loop.length; i++) {
      const ei = t.faceEdges[f][i];
      if (ei < 0 || t.edges[ei].faces.length !== 1) continue;
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      out.faces.push([b, a, a + nv, b + nv]);
      out.faceMaterial.push(mesh.faceMaterial[f] ?? 0);
    }
  }
  if (mesh.faceSmooth) {
    out.faceSmooth = [];
    for (let pass = 0; pass < 2; pass++) {
      for (let f = 0; f < mesh.faces.length; f++) out.faceSmooth.push(mesh.isFaceSmooth(f));
    }
    while (out.faceSmooth.length < out.faces.length) out.faceSmooth.push(mesh.shadeSmooth);
  }
  out.markDirty();
  return out;
}

/** Bevel every edge sharper than the angle limit. */
function applyBevelModifier(mesh: Mesh, mod: BevelModifier): Mesh {
  const out = mesh.clone();
  const t = out.topology();
  const cosLimit = Math.cos(mod.angleLimit * Math.PI / 180);
  const edges: number[] = [];
  for (let ei = 0; ei < t.edges.length; ei++) {
    const e = t.edges[ei];
    if (e.faces.length !== 2) continue;
    if (t.faceNormals[e.faces[0]].dot(t.faceNormals[e.faces[1]]) < cosLimit) edges.push(ei);
  }
  if (edges.length === 0) return mesh;
  bevelEdges(out, edges, mod.width, Math.max(1, Math.round(mod.segments)), mod.profile);
  transferUV(mesh, out);
  return out;
}

/** Run one modifier, returning a new mesh (the input is never mutated). */
export function applyModifier(
  mesh: Mesh, mod: Modifier, resolve?: ObjectResolver, rig?: ArmatureResolver,
): Mesh {
  switch (mod.type) {
    case 'subsurf':
      return mod.levels > 0 ? catmullClark(mesh, Math.min(4, mod.levels)) : mesh;
    case 'mirror':
      return applyMirror(mesh, mod);
    case 'array':
      return applyArray(mesh, mod);
    case 'solidify':
      return applySolidify(mesh, mod);
    case 'weld': {
      const out = mesh.clone();
      mergeByDistance(out, null, mod.distance);
      return out;
    }
    case 'triangulate': {
      const out = mesh.clone();
      triangulateFaces(out);
      return out;
    }
    case 'smooth': {
      const out = mesh.clone();
      smoothVertices(out, null, mod.factor, Math.min(20, Math.max(1, mod.iterations)));
      return out;
    }
    case 'boolean': {
      if (mod.objectId === null || !resolve) return mesh;
      const other = resolve(mod.objectId);
      // No cutter means the modifier is simply inert, not an error.
      if (!other || other.faceCount === 0) return mesh;
      const cut = meshBoolean(mesh, other, mod.operation);
      transferUV(mesh, cut);
      transferUV(other, cut);
      return cut;
    }
    case 'decimate': {
      if (mod.ratio >= 0.999) return mesh;
      const smaller = decimate(mesh, mod.ratio, mod.preserveBorder);
      transferUV(mesh, smaller);
      return smaller;
    }
    case 'bevel':
      return mod.width > 0 ? applyBevelModifier(mesh, mod) : mesh;
    case 'armature': {
      if (mod.objectId === null || !rig) return mesh;
      const bound = rig(mod.objectId);
      // No rig, or geometry that was never weighted: inert, not an error.
      if (!bound || !mesh.skin) return mesh;
      const skin = mesh.skin.bones.length === mesh.positions.length * MAX_INFLUENCES
        ? mesh.skin
        : resizeSkin(mesh.skin, mesh.positions.length);
      return applySkin(mesh, bound.armature, skin, bound.meshToArmature, bound.armatureToMesh);
    }
  }
}

/**
 * Evaluate a whole stack. In edit mode only modifiers flagged `showInEdit`
 * run, matching Blender's cage behaviour.
 */
export function evaluateStack(
  mesh: Mesh, modifiers: Modifier[], editMode = false,
  resolve?: ObjectResolver, rig?: ArmatureResolver,
): Mesh {
  let cur = mesh;
  for (const mod of modifiers) {
    if (!mod.enabled) continue;
    if (editMode && !mod.showInEdit) continue;
    cur = applyModifier(cur, mod, resolve, rig);
  }
  return cur;
}

export function stackKey(modifiers: Modifier[], editMode: boolean): string {
  return `${editMode ? 'E' : 'O'}|${JSON.stringify(modifiers)}`;
}
