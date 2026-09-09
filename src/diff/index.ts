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

/**
 * Per-vertex and per-corner data that is not geometry but is not nothing.
 *
 * These were not examined at all until now, which meant a scene where the only
 * change was an unwrap, a paint pass or a weight edit reported "no
 * differences". A comparison that says nothing changed when something did is
 * worse than no comparison, because it is believed.
 */
export interface AttributeDiff {
  uv: boolean;
  colors: boolean;
  skin: boolean;
  seams: boolean;
  smoothing: boolean;
  edgeWeights: boolean;
  /** True when any of the above differ. */
  any: boolean;
}

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
  attributes: AttributeDiff;
  /**
   * How many of the matched faces were matched by vertex index rather than by
   * where their corners are.
   *
   * An index match is only as good as the assumption that both sides number
   * their vertices the same way, which is true after most operators and false
   * after a rebuild. Counting them separately is what lets the panel say
   * "verified" for one and "probably" for the other instead of implying the
   * same confidence for both.
   */
  matchedByIndex: number;
  matchedByPosition: number;
}

export type ObjectStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ObjectDiff {
  id: number;
  name: string;
  /** The name it had before, when a rename is the change. */
  previousName?: string;
  status: ObjectStatus;
  transformChanged: boolean;
  /** The object points at different material slots than it did. */
  materialChanged: boolean;
  /**
   * The materials themselves changed, though the object still points at the
   * same slots.
   *
   * A distinct question from the one above and much the more common: turning
   * a material red does not touch any object, so an object-level comparison
   * that only looks at slot numbers reports nothing at all.
   */
  materialValuesChanged: boolean;
  modifiersChanged: boolean;
  visibilityChanged: boolean;
  animationChanged: boolean;
  /** Re-parented, which changes where it is even when its transform has not. */
  hierarchyChanged: boolean;
  /** Attributes changed without the geometry moving. */
  attributesChanged: boolean;
  /**
   * True when the two sides were matched by something that could be wrong.
   *
   * Object ids are stable through a save, a reload and the undo history, so
   * pairing by id is exact. An asset identity match after a regeneration is
   * exact too. Anything else — and anything with a modifier stack, whose
   * evaluated output is not what was compared — is flagged, so the panel can
   * say which answers it stands behind.
   */
  uncertain: boolean;
  /** Why the pairing or the comparison is uncertain. */
  uncertainty?: string;
  mesh: MeshDiff | null;
}

export interface SceneDiff {
  objects: ObjectDiff[];
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** The material list itself differs, not just which slots objects point at. */
  materialsChanged: boolean;
  worldChanged: boolean;
  /** True when the two versions are the same scene in every way examined. */
  identical: boolean;
  /**
   * What this comparison did not look at.
   *
   * `identical` is only trustworthy alongside this being empty. Anything
   * listed here is a place where the answer is "not examined", which the panel
   * must show rather than round down to "the same".
   */
  notExamined: string[];
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
  let matchedByIndex = 0;
  let matchedByPosition = 0;

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
    matchedByIndex++;
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
    matchedByPosition++;
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
    attributes: diffAttributes(a, b),
    matchedByIndex,
    matchedByPosition,
  };
}

/**
 * What changed that is attached to the geometry rather than being it.
 *
 * Compared as stored, because that is what these are: a UV island, a painted
 * colour and a skin weight are numbers written against particular corners, and
 * two lists of them are either the same list or a different one. There is no
 * geometric interpretation to be clever about.
 */
function diffAttributes(a: MeshData, b: MeshData): AttributeDiff {
  const differs = (x: unknown, y: unknown): boolean => JSON.stringify(x ?? null) !== JSON.stringify(y ?? null);
  const uv = differs(a.faceUV, b.faceUV);
  const colors = differs(a.colors, b.colors);
  const skin = differs(a.skin, b.skin);
  const seams = differs(a.seams, b.seams);
  const edgeWeights = differs(a.edgeWeights, b.edgeWeights);
  const smoothing = a.shadeSmooth !== b.shadeSmooth || differs(a.faceSmooth, b.faceSmooth);
  return {
    uv, colors, skin, seams, edgeWeights, smoothing,
    any: uv || colors || skin || seams || edgeWeights || smoothing,
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
  const oldByAssetKey = new Map<string, SerializedObject>();
  for (const o of before.objects) {
    const key = assetKeyOf(o, before);
    if (key && !oldByAssetKey.has(key)) oldByAssetKey.set(key, o);
  }

  const objects: ObjectDiff[] = [];

  // Pairing. Ids are exact — stable through a save, a reload and the whole
  // undo history — so they are tried first. An asset that was regenerated into
  // new objects keeps neither its ids nor its names, but does keep its part
  // key inside an asset of the same identity, so that is the second attempt.
  const pairedOld = new Set<number>();
  const pairOf = (o: SerializedObject): { was: SerializedObject | null; why?: string } => {
    const byId = oldById.get(o.id);
    if (byId) {
      pairedOld.add(byId.id);
      return { was: byId };
    }
    const key = assetKeyOf(o, after);
    if (key) {
      const candidate = oldByAssetKey.get(key);
      if (candidate && !pairedOld.has(candidate.id)) {
        pairedOld.add(candidate.id);
        return { was: candidate, why: 'matched by its part identity rather than by object id' };
      }
    }
    return { was: null };
  };

  for (const o of after.objects) {
    const { was, why } = pairOf(o);
    if (!was) {
      objects.push({
        ...blankDiff(o.id, o.name, 'added'),
        mesh: diffMesh(null, o.mesh ?? null),
      });
      continue;
    }
    const mesh = diffMesh(was.mesh ?? null, o.mesh ?? null);
    const transformChanged = transformOf(was) !== transformOf(o);
    const materialChanged = JSON.stringify(was.materialSlots) !== JSON.stringify(o.materialSlots);
    const materialValuesChanged = !materialChanged
      && materialsUsed(was, before) !== materialsUsed(o, after);
    const modifiersChanged = JSON.stringify(was.modifiers) !== JSON.stringify(o.modifiers);
    const visibilityChanged = was.visible !== o.visible || was.locked !== o.locked;
    const animationChanged = JSON.stringify(was.animation ?? []) !== JSON.stringify(o.animation ?? []);
    const hierarchyChanged = (was.parent ?? null) !== (o.parent ?? null);
    const attributesChanged = !!mesh && mesh.attributes.any;
    const geometryChanged = !!mesh && (mesh.added > 0 || mesh.removed > 0 || mesh.moved > 0);
    const renamed = was.name !== o.name;
    const changed = transformChanged || materialChanged || materialValuesChanged || modifiersChanged
      || visibilityChanged || animationChanged || hierarchyChanged || attributesChanged
      || geometryChanged || renamed;
    // A modifier stack means the mesh compared is not the mesh drawn. Saying
    // so is the difference between an answer and a misleading one.
    const evaluated = o.modifiers.length > 0 || was.modifiers.length > 0;
    objects.push({
      id: o.id,
      name: o.name,
      previousName: renamed ? was.name : undefined,
      status: changed ? 'changed' : 'unchanged',
      transformChanged,
      materialChanged,
      materialValuesChanged,
      modifiersChanged,
      visibilityChanged,
      animationChanged,
      hierarchyChanged,
      attributesChanged,
      uncertain: !!why || evaluated,
      uncertainty: why
        ?? (evaluated ? 'compared before its modifiers ran, so what you see may differ' : undefined),
      mesh,
    });
  }

  for (const o of before.objects) {
    if (newById.has(o.id) || pairedOld.has(o.id)) continue;
    objects.push({
      ...blankDiff(o.id, o.name, 'removed'),
      mesh: diffMesh(o.mesh ?? null, null),
    });
  }

  const count = (status: ObjectStatus): number => objects.filter((o) => o.status === status).length;
  const added = count('added');
  const removed = count('removed');
  const changed = count('changed');
  const materialsChanged = JSON.stringify(before.materials) !== JSON.stringify(after.materials);
  const worldChanged = JSON.stringify(before.world) !== JSON.stringify(after.world);

  // Everything this comparison does not look at, named. `identical` without
  // this list beside it would be a claim about the whole scene made from a
  // reading of part of it.
  const notExamined: string[] = [];
  if (JSON.stringify(before.textures ?? []) !== JSON.stringify(after.textures ?? [])) {
    notExamined.push('the image textures themselves differ; their pixels were not compared');
  }
  if (JSON.stringify(before.timeline ?? null) !== JSON.stringify(after.timeline ?? null)) {
    notExamined.push('the timeline settings differ');
  }
  if (objects.some((o) => o.modifiersChanged)) {
    notExamined.push('modifier settings changed; the geometry compared is what feeds the stack, not what comes out of it');
  }

  return {
    objects,
    added,
    removed,
    changed,
    unchanged: count('unchanged'),
    materialsChanged,
    worldChanged,
    identical: added + removed + changed === 0 && !materialsChanged && !worldChanged
      && notExamined.length === 0,
    notExamined,
  };
}

function blankDiff(id: number, name: string, status: ObjectStatus): Omit<ObjectDiff, 'mesh'> {
  return {
    id,
    name,
    status,
    transformChanged: false,
    materialChanged: false,
    materialValuesChanged: false,
    modifiersChanged: false,
    visibilityChanged: false,
    animationChanged: false,
    hierarchyChanged: false,
    attributesChanged: false,
    uncertain: false,
  };
}

/** The material definitions an object actually uses, as a comparable string. */
function materialsUsed(o: SerializedObject, doc: SerializedScene): string {
  return JSON.stringify(o.materialSlots.map((slot) => doc.materials[slot] ?? null));
}

/**
 * An object's identity within its generated asset, when it has one.
 *
 * `assetId` plus the part key: unique across files, stable across a
 * regeneration that renumbers every object, and absent on anything that was
 * not generated — which is exactly when it should not be used.
 */
function assetKeyOf(o: SerializedObject, doc: SerializedScene): string | null {
  if (!o.partKey) return null;
  const byId = new Map<number, SerializedObject>();
  for (const other of doc.objects) byId.set(other.id, other);
  let cursor: SerializedObject | undefined = o;
  let guard = 0;
  while (cursor && guard++ < 64) {
    const asset = cursor.provenance?.assetId;
    if (asset) return `${asset}/${o.partKey}`;
    cursor = cursor.parent !== null && cursor.parent !== undefined ? byId.get(cursor.parent) : undefined;
  }
  return null;
}

/** One line per object, for a status bar or a log. */
export function summarise(diff: SceneDiff): string {
  if (diff.identical) return 'No differences';
  const parts: string[] = [];
  // Said before the counts, because "0 changed, but I did not look at the
  // textures" and "0 changed" are different answers and only one is true.
  if (diff.added + diff.removed + diff.changed === 0 && diff.notExamined.length) {
    return `Nothing changed in what was compared — ${diff.notExamined[0]}`;
  }
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
  const attributes = diff.objects.filter((o) => o.attributesChanged).length;
  if (attributes) parts.push(`${attributes} with changed UVs, colours or weights`);
  if (diff.objects.some((o) => o.materialValuesChanged)) parts.push('material values');
  const uncertain = diff.objects.filter((o) => o.uncertain && o.status !== 'unchanged').length;
  if (uncertain) parts.push(`${uncertain} matched with less than certainty`);
  return parts.join(', ');
}

/**
 * A digest of which faces changed and how, for a cache that must not miss.
 *
 * The renderer keeps its vertex buffers until something it keys on moves, and
 * a comparison changes the buffers without changing any geometry — so this is
 * what tells it to rebuild. It has to distinguish "these forty faces moved"
 * from "those forty faces moved", which a count of forty cannot: the same
 * total with a different set is exactly the case where the viewport would
 * otherwise keep showing the previous answer.
 *
 * Cheap on purpose — one pass, no allocation — because it runs on every edit
 * made while a comparison is open.
 */
export function faceSignature(faces: readonly FaceChange[]): string {
  let hash = 2166136261;
  for (let i = 0; i < faces.length; i++) {
    // Position as well as value: the same changes in a different order are a
    // different picture.
    hash ^= (faces[i].charCodeAt(0) + i * 31) | 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${faces.length}:${(hash >>> 0).toString(36)}`;
}
