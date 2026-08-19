import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { catmullClark, mergeByDistance, smoothVertices, triangulateFaces } from '../mesh/ops';

/**
 * Non-destructive modifier stack. Modifiers are pure functions from mesh to
 * mesh, evaluated top to bottom; the original edit-mode geometry is never
 * touched.
 */

export type ModifierType =
  | 'subsurf' | 'mirror' | 'array' | 'solidify' | 'weld' | 'triangulate' | 'smooth';

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

export type Modifier =
  | SubsurfModifier | MirrorModifier | ArrayModifier | SolidifyModifier
  | WeldModifier | TriangulateModifier | SmoothModifier;

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

/** Run one modifier, returning a new mesh (the input is never mutated). */
export function applyModifier(mesh: Mesh, mod: Modifier): Mesh {
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
  }
}

/**
 * Evaluate a whole stack. In edit mode only modifiers flagged `showInEdit`
 * run, matching Blender's cage behaviour.
 */
export function evaluateStack(mesh: Mesh, modifiers: Modifier[], editMode = false): Mesh {
  let cur = mesh;
  for (const mod of modifiers) {
    if (!mod.enabled) continue;
    if (editMode && !mod.showInEdit) continue;
    cur = applyModifier(cur, mod);
  }
  return cur;
}

export function stackKey(modifiers: Modifier[], editMode: boolean): string {
  return `${editMode ? 'E' : 'O'}|${JSON.stringify(modifiers)}`;
}
