/**
 * What changed between two versions of a model.
 *
 * Every other part of a 3D application answers "what does this look like now".
 * None of them answers "what is different from yesterday" — you reopen an old
 * file next to the new one and squint. Text has had `diff` since 1974 and
 * nobody would give it up; geometry has never had the equivalent, because a
 * mesh has no line numbers and the obvious approach of comparing vertex arrays
 * falls apart the moment an operator renumbers anything.
 *
 * The way through is to compare geometry rather than storage. A face is
 * identified by where its corners are in space, quantised to a tolerance, and
 * sorted so winding and starting corner do not matter. Two faces with the same
 * key are the same face however the arrays were shuffled in between. What is
 * left over on each side is what was genuinely added or removed.
 *
 * Faces that merely *moved* — sculpted, transformed, nudged — would show as a
 * removal plus an addition under that rule, which is true but useless. So an
 * index-aligned pass runs first: where the two meshes agree on a face's vertex
 * indices, the face is the same face, and the only question is whether its
 * corners sit somewhere new. That pass is exact whenever an operator preserved
 * numbering, which is the common case, and the geometric pass picks up
 * everything else.
 *
 * Both sides come in as serialised scenes, so the same code compares the live
 * scene against a point in undo history, against an autosave, or against a
 * file from a week ago.
 */

import { SerializedObject, SerializedScene } from '../scene/Scene';

/** How a face differs from the version it is being compared with. */
export type FaceChange = 'unchanged' | 'moved' | 'added';

/** Numeric form of `FaceChange`, as handed to the renderer. */
export const FACE_CHANGE_CODE: Record<FaceChange, number> = {
  unchanged: 0,
  moved: 1,
  added: 2,
};

export interface MeshDiff {
  /** One entry per face of the new mesh. */
  faces: FaceChange[];
  /** Loops from the old mesh with no counterpart, in old-mesh vertex indices. */
  removedFaces: number[][];
  /** Positions the removed loops refer to, flat xyz. */
  removedPositions: number[];
  added: number;
  removed: number;
  moved: number;
  unchanged: number;
  /** Vertex counts on each side, which is the headline number for a mesh. */
  vertsBefore: number;
  vertsAfter: number;
}

export type ObjectStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ObjectDiff {
  id: number;
  name: string;
  /** The name it had before, when a rename is the change. */
  previousName?: string;
  status: ObjectStatus;
  transformChanged: boolean;
  materialChanged: boolean;
  modifiersChanged: boolean;
  visibilityChanged: boolean;
  animationChanged: boolean;
  mesh: MeshDiff | null;
}

export interface SceneDiff {
  objects: ObjectDiff[];
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** True when the two versions are the same scene in every way examined. */
  identical: boolean;
}

/**
 * Grid size for treating two corner positions as the same place.
 *
 * Fine enough that a deliberate nudge registers as a move, coarse enough that
 * re-deriving the same vertex through different arithmetic does not. A model
 * is authored in units where 1 is about a metre, so this is a hundredth of a
 * millimetre.
 */
const TOLERANCE = 1e-5;

function quantise(value: number): number {
  // Rounding to a grid makes two positions either equal or not, with no
  // "close enough" comparison to get wrong when keys go into a Map.
  const snapped = Math.round(value / TOLERANCE);
  // -0 and 0 are the same place but different string keys.
  return snapped === 0 ? 0 : snapped;
}

/**
 * A key identifying a face by where it is, not by how it is stored.
 *
 * Corner keys are sorted, so the same face wound the other way or starting
 * from a different corner produces the same string. That is what survives an
 * operator rebuilding a mesh from scratch.
 */
function faceKey(loop: number[], positions: number[]): string {
  const corners = loop.map((v) => {
    const at = v * 3;
    return `${quantise(positions[at])},${quantise(positions[at + 1])},${quantise(positions[at + 2])}`;
  });
  corners.sort();
  return corners.join('|');
}

function sameLoop(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function loopMoved(loop: number[], before: number[], after: number[]): boolean {
  for (const v of loop) {
    const at = v * 3;
    if (quantise(before[at]) !== quantise(after[at])) return true;
    if (quantise(before[at + 1]) !== quantise(after[at + 1])) return true;
    if (quantise(before[at + 2]) !== quantise(after[at + 2])) return true;
  }
  return false;
}

type MeshData = NonNullable<SerializedObject['mesh']>;

/** Compare two meshes, classifying every face of the newer one. */
export function diffMesh(before: MeshData | null, after: MeshData | null): MeshDiff | null {
  if (!before && !after) return null;
  const empty: MeshData = { positions: [], faces: [], faceMaterial: [], shadeSmooth: false, faceSmooth: null };
  const a = before ?? empty;
  const b = after ?? empty;

  const faces: FaceChange[] = new Array(b.faces.length).fill('added');
  const matchedInOld = new Uint8Array(a.faces.length);
  let moved = 0;
  let unchanged = 0;

  // Pass one: where both versions agree on a face's vertex indices, it is the
  // same face and only its position is in question. Exact whenever the
  // operator left numbering alone, which is most of the time.
  const aligned = Math.min(a.faces.length, b.faces.length);
  for (let f = 0; f < aligned; f++) {
    if (!sameLoop(a.faces[f], b.faces[f])) continue;
    // A shared index must exist on both sides for the comparison to mean
    // anything; a shrunken position array means this face is not really the
    // same one.
    if (b.faces[f].some((v) => v * 3 + 2 >= a.positions.length)) continue;
    matchedInOld[f] = 1;
    if (loopMoved(b.faces[f], a.positions, b.positions)) {
      faces[f] = 'moved';
      moved++;
    } else {
      faces[f] = 'unchanged';
      unchanged++;
    }
  }

  // Pass two: everything the index pass could not speak for, matched on where
  // the corners actually are. Duplicate keys are counted rather than
  // overwritten, so two identical faces in one mesh match two in the other.
  const pool = new Map<string, number[]>();
  for (let f = 0; f < a.faces.length; f++) {
    if (matchedInOld[f]) continue;
    const key = faceKey(a.faces[f], a.positions);
    const list = pool.get(key);
    if (list) list.push(f);
    else pool.set(key, [f]);
  }
  for (let f = 0; f < b.faces.length; f++) {
    if (faces[f] !== 'added') continue;
    const key = faceKey(b.faces[f], b.positions);
    const list = pool.get(key);
    if (!list || list.length === 0) continue;
    const old = list.pop()!;
    matchedInOld[old] = 1;
    faces[f] = 'unchanged';
    unchanged++;
  }

  const removedFaces: number[][] = [];
  for (let f = 0; f < a.faces.length; f++) if (!matchedInOld[f]) removedFaces.push(a.faces[f].slice());

  let added = 0;
  for (const change of faces) if (change === 'added') added++;

  return {
    faces,
    removedFaces,
    removedPositions: removedFaces.length ? a.positions.slice() : [],
    added,
    removed: removedFaces.length,
    moved,
    unchanged,
    vertsBefore: a.positions.length / 3,
    vertsAfter: b.positions.length / 3,
  };
}

function triple(v: [number, number, number] | undefined): string {
  if (!v) return '-';
  return `${quantise(v[0])},${quantise(v[1])},${quantise(v[2])}`;
}

function transformOf(o: SerializedObject): string {
  return `${triple(o.position)}|${triple(o.rotation)}|${triple(o.scale)}`;
}

/**
 * Compare two scenes.
 *
 * Objects are paired by id, which is stable across a save and reload and
 * across the undo history, so a rename shows up as a rename rather than as a
 * deletion next to an unrelated addition.
 */
export function diffScene(before: SerializedScene, after: SerializedScene): SceneDiff {
  const oldById = new Map<number, SerializedObject>();
  for (const o of before.objects) oldById.set(o.id, o);
  const newById = new Map<number, SerializedObject>();
  for (const o of after.objects) newById.set(o.id, o);

  const objects: ObjectDiff[] = [];

  for (const o of after.objects) {
    const was = oldById.get(o.id);
    if (!was) {
      objects.push({
        id: o.id,
        name: o.name,
        status: 'added',
        transformChanged: false,
        materialChanged: false,
        modifiersChanged: false,
        visibilityChanged: false,
        animationChanged: false,
        mesh: diffMesh(null, o.mesh ?? null),
      });
      continue;
    }
    const mesh = diffMesh(was.mesh ?? null, o.mesh ?? null);
    const transformChanged = transformOf(was) !== transformOf(o);
    const materialChanged = JSON.stringify(was.materialSlots) !== JSON.stringify(o.materialSlots);
    const modifiersChanged = JSON.stringify(was.modifiers) !== JSON.stringify(o.modifiers);
    const visibilityChanged = was.visible !== o.visible || was.locked !== o.locked;
    const animationChanged = JSON.stringify(was.animation ?? []) !== JSON.stringify(o.animation ?? []);
    const geometryChanged = !!mesh && (mesh.added > 0 || mesh.removed > 0 || mesh.moved > 0);
    const renamed = was.name !== o.name;
    const changed = transformChanged || materialChanged || modifiersChanged
      || visibilityChanged || animationChanged || geometryChanged || renamed;
    objects.push({
      id: o.id,
      name: o.name,
      previousName: renamed ? was.name : undefined,
      status: changed ? 'changed' : 'unchanged',
      transformChanged,
      materialChanged,
      modifiersChanged,
      visibilityChanged,
      animationChanged,
      mesh,
    });
  }

  for (const o of before.objects) {
    if (newById.has(o.id)) continue;
    objects.push({
      id: o.id,
      name: o.name,
      status: 'removed',
      transformChanged: false,
      materialChanged: false,
      modifiersChanged: false,
      visibilityChanged: false,
      animationChanged: false,
      mesh: diffMesh(o.mesh ?? null, null),
    });
  }

  const count = (status: ObjectStatus): number => objects.filter((o) => o.status === status).length;
  const added = count('added');
  const removed = count('removed');
  const changed = count('changed');
  const materialsChanged = JSON.stringify(before.materials) !== JSON.stringify(after.materials);
  const worldChanged = JSON.stringify(before.world) !== JSON.stringify(after.world);

  return {
    objects,
    added,
    removed,
    changed,
    unchanged: count('unchanged'),
    identical: added + removed + changed === 0 && !materialsChanged && !worldChanged,
  };
}

/** One line per object, for a status bar or a log. */
export function summarise(diff: SceneDiff): string {
  if (diff.identical) return 'No differences';
  const parts: string[] = [];
  if (diff.added) parts.push(`${diff.added} added`);
  if (diff.removed) parts.push(`${diff.removed} removed`);
  if (diff.changed) parts.push(`${diff.changed} changed`);
  const faces = diff.objects.reduce(
    (acc, o) => {
      if (!o.mesh) return acc;
      acc.added += o.mesh.added;
      acc.removed += o.mesh.removed;
      acc.moved += o.mesh.moved;
      return acc;
    },
    { added: 0, removed: 0, moved: 0 },
  );
  const facePart: string[] = [];
  if (faces.added) facePart.push(`+${faces.added}`);
  if (faces.removed) facePart.push(`−${faces.removed}`);
  if (faces.moved) facePart.push(`~${faces.moved}`);
  if (facePart.length) parts.push(`${facePart.join(' ')} faces`);
  return parts.join(', ');
}
