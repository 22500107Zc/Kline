import { SerializedObject } from '../scene/Scene';
import { Baseline, BaselinePart, SerializedMesh } from './provenance';

/**
 * Keeping your work when the generator runs again.
 *
 * A regeneration has three versions of every part in play, not two: what the
 * generator made last time, what you made of it, and what the generator would
 * make now. Comparing only the first and last is what makes "regenerate" mean
 * "throw your work away" everywhere else — the new output simply overwrites,
 * and the two hours you spent on materials go with it.
 *
 * With the baseline in hand each field can be decided on its own:
 *
 *   - the generator changed it and you did not  -> take the generator's
 *   - you changed it and the generator did not  -> keep yours
 *   - neither changed it                        -> nothing to decide
 *   - both changed it, differently              -> a conflict, reported
 *
 * The last case is the important one and the one that must never be decided
 * silently. Sculpting a generated shape and then asking for a different
 * topology is a real disagreement about what the object is; there is no merge
 * that keeps both, and pretending otherwise loses the sculpt. So it comes back
 * as a conflict with the choices spelled out, and nothing is applied until
 * somebody picks.
 *
 * What this does *not* do is claim that arbitrary edits survive. A vertex
 * moved in Edit Mode, a sculpted crease, an unwrapped UV island and a painted
 * weight are all stored against a particular set of vertices; when a
 * regeneration produces a different set, the mapping is gone and no amount of
 * merging brings it back. Those are conflicts, and they are reported as
 * conflicts rather than quietly dropped.
 */

/** How one part came out of the merge. */
export type MergeAction =
  | 'unchanged'
  | 'updated'
  | 'kept-yours'
  | 'added'
  | 'removed'
  | 'conflict'
  | 'protected';

export type ConflictKind =
  | 'geometry'
  | 'topology'
  | 'removal'
  | 'protected'
  | 'transform'
  | 'material';

export interface MergeConflict {
  key: string;
  name: string;
  kind: ConflictKind;
  /** Plain-language account of what disagrees, shown to the user as-is. */
  detail: string;
  /** Object id in the live scene, when the part is still there. */
  objectId: number | null;
}

/** One part's outcome, and the object it should become. */
export interface MergedPart {
  key: string;
  name: string;
  action: MergeAction;
  /** Fields taken from the generator's new output. */
  tookGenerator: string[];
  /** Fields kept from the user's version. */
  keptYours: string[];
  objectId: number | null;
}

export interface MergeReport {
  parts: MergedPart[];
  conflicts: MergeConflict[];
  /** Objects under the asset that the generator does not know about. */
  userAdded: { id: number; name: string }[];
  added: number;
  removed: number;
  updated: number;
  keptYours: number;
  unchanged: number;
  protectedParts: number;
  /**
   * True when the baseline was missing, so a user edit could not be told from
   * a generator change. Every field is then treated as the user's, and the
   * generator's version is offered as a whole rather than merged.
   */
  blind: boolean;
}

/** One part as the generator proposes it now. */
export interface ProposedPart {
  key: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  mesh: SerializedMesh | null;
  color?: string;
}

/** What the merge decided for one part, ready to be applied to the scene. */
export interface PartPlan {
  key: string;
  /** Null for a part that does not exist yet. */
  objectId: number | null;
  action: MergeAction;
  /** The geometry to use, or null to leave the object's own alone. */
  mesh: SerializedMesh | null;
  name: string | null;
  position: [number, number, number] | null;
  rotation: [number, number, number] | null;
  scale: [number, number, number] | null;
  /** Present only when the part is new and needs a colour from the generator. */
  color?: string;
}

export interface MergePlan {
  report: MergeReport;
  parts: PartPlan[];
  /** Objects to delete: parts the generator dropped that you had not edited. */
  remove: number[];
}

/** How the user's copy of a part is presented to the merge. */
export interface CurrentPart {
  key: string;
  object: SerializedObject;
  /** Held back from regeneration at the user's request. */
  protectedFromRegen: boolean;
}

const ROUND = 1e-6;

function sameTriple(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b) return a === b;
  for (let i = 0; i < 3; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > ROUND) return false;
  }
  return true;
}

/**
 * Whether two meshes are the same geometry.
 *
 * Serialised form rather than a tolerance-based comparison: the question here
 * is "did this change since it was written down", and the two sides are either
 * the same recorded numbers or they are not. A geometric tolerance belongs in
 * the comparison view, where the question is "does this look different"; using
 * one here would let a real edit hide inside the tolerance.
 */
export function sameMesh(a: SerializedMesh | null, b: SerializedMesh | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether two meshes have the same vertex and face structure, ignoring positions. */
export function sameTopology(a: SerializedMesh | null, b: SerializedMesh | null): boolean {
  if (!a || !b) return a === b;
  if (a.positions.length !== b.positions.length) return false;
  if (a.faces.length !== b.faces.length) return false;
  for (let f = 0; f < a.faces.length; f++) {
    const fa = a.faces[f];
    const fb = b.faces[f];
    if (fa.length !== fb.length) return false;
    for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return false;
  }
  return true;
}

/**
 * Attributes that are stored per-vertex or per-corner, and so are only
 * meaningful against the topology they were made for.
 *
 * Named individually because the honest answer to "does my unwrap survive"
 * depends on which of these the object actually carries: a plain generated box
 * has none of them and regenerates freely, and one that has been unwrapped,
 * painted and weighted has three separate things to lose.
 */
export function boundAttributes(mesh: SerializedMesh | null): string[] {
  if (!mesh) return [];
  const out: string[] = [];
  if (mesh.faceUV && mesh.faceUV.some((uv) => uv)) out.push('UV coordinates');
  if (mesh.colors && mesh.colors.length) out.push('vertex colours');
  if (mesh.skin && mesh.skin.bones.length) out.push('skin weights');
  if (mesh.seams && mesh.seams.length) out.push('seams');
  if (mesh.mask && mesh.mask.length) out.push('sculpt mask');
  return out;
}

/**
 * Decide what a regeneration should do to every part of an asset.
 *
 * Pure: it reads three descriptions and returns a plan. Nothing in the scene
 * is touched, which is what lets the result be shown as a preview and thrown
 * away without consequence.
 */
export function mergeAsset(
  baseline: Baseline,
  current: CurrentPart[],
  proposed: ProposedPart[],
  userAdded: { id: number; name: string }[] = [],
): MergePlan {
  const base = new Map<string, BaselinePart>();
  for (const p of baseline.parts ?? []) base.set(p.key, p);
  const mine = new Map<string, CurrentPart>();
  for (const p of current) mine.set(p.key, p);
  const theirs = new Map<string, ProposedPart>();
  for (const p of proposed) theirs.set(p.key, p);

  const blind = !(baseline.parts && baseline.parts.length);
  const parts: MergedPart[] = [];
  const plans: PartPlan[] = [];
  const conflicts: MergeConflict[] = [];
  const remove: number[] = [];

  const keys = new Set<string>([...base.keys(), ...mine.keys(), ...theirs.keys()]);

  for (const key of keys) {
    const was = base.get(key) ?? null;
    const now = mine.get(key) ?? null;
    const next = theirs.get(key) ?? null;

    // The generator no longer makes this part.
    if (!next) {
      if (!now) continue;
      const name = now.object.name;
      if (now.protectedFromRegen) {
        conflicts.push({
          key, name, kind: 'protected', objectId: now.object.id,
          detail: `"${name}" is protected, and this revision would remove it.`,
        });
        parts.push({ key, name, action: 'protected', tookGenerator: [], keptYours: ['everything'], objectId: now.object.id });
        continue;
      }
      const edited = blind || !was || !unchangedSinceBaseline(was, now.object);
      if (edited) {
        conflicts.push({
          key, name, kind: 'removal', objectId: now.object.id,
          detail: blind
            ? `This revision removes "${name}", and there is no record of what it looked like when it was generated, so your changes to it cannot be told apart.`
            : `This revision removes "${name}", but you changed it after it was generated.`,
        });
        parts.push({ key, name, action: 'conflict', tookGenerator: [], keptYours: [], objectId: now.object.id });
        continue;
      }
      remove.push(now.object.id);
      parts.push({ key, name, action: 'removed', tookGenerator: ['removal'], keptYours: [], objectId: now.object.id });
      continue;
    }

    // A part the generator makes now and did not before.
    if (!now) {
      parts.push({ key, name: next.name, action: 'added', tookGenerator: ['everything'], keptYours: [], objectId: null });
      plans.push({
        key, objectId: null, action: 'added',
        mesh: next.mesh, name: next.name,
        position: next.position, rotation: next.rotation, scale: next.scale, color: next.color,
      });
      continue;
    }

    const obj = now.object;
    const name = obj.name;
    if (now.protectedFromRegen) {
      const wouldChange = !was || !sameMesh(was.mesh, next.mesh)
        || !sameTriple(was.position, next.position) || !sameTriple(was.rotation, next.rotation)
        || !sameTriple(was.scale, next.scale);
      if (wouldChange) {
        conflicts.push({
          key, name, kind: 'protected', objectId: obj.id,
          detail: `"${name}" is protected from regeneration, and this revision would change it.`,
        });
      }
      parts.push({
        key, name, action: 'protected', tookGenerator: [],
        keptYours: ['everything'], objectId: obj.id,
      });
      continue;
    }

    const tookGenerator: string[] = [];
    const keptYours: string[] = [];
    const plan: PartPlan = {
      key, objectId: obj.id, action: 'unchanged',
      mesh: null, name: null, position: null, rotation: null, scale: null,
    };

    // ---- geometry
    const generatorMovedGeometry = !was || !sameMesh(was.mesh, next.mesh);
    const youMovedGeometry = !was || !sameMesh(was.mesh, obj.mesh ?? null);
    if (generatorMovedGeometry && !youMovedGeometry) {
      plan.mesh = next.mesh;
      tookGenerator.push('geometry');
    } else if (!generatorMovedGeometry && youMovedGeometry) {
      keptYours.push('geometry');
    } else if (generatorMovedGeometry && youMovedGeometry) {
      if (sameMesh(obj.mesh ?? null, next.mesh)) {
        // Both arrived at the same shape; there is nothing to disagree about.
        keptYours.push('geometry');
      } else {
        const lost = boundAttributes(obj.mesh ?? null);
        const topologyChanged = !sameTopology(obj.mesh ?? null, next.mesh);
        conflicts.push({
          key, name, objectId: obj.id,
          kind: topologyChanged ? 'topology' : 'geometry',
          detail: describeGeometryConflict(name, blind, topologyChanged, lost),
        });
        parts.push({ key, name, action: 'conflict', tookGenerator, keptYours, objectId: obj.id });
        continue;
      }
    }

    // ---- name, transform, and everything else that is a plain value
    //
    // These merge field by field, which is what makes "keep its placement" and
    // "keep its materials" true rather than aspirational: moving a generated
    // logo and then changing its extrusion depth touches two different fields,
    // and only one of them has two opinions.
    const decide = (
      field: string,
      basedOn: boolean,        // generator changed it since the baseline
      yours: boolean,          // you changed it since the baseline
      take: () => void,
    ): void => {
      if (basedOn && !yours) {
        take();
        tookGenerator.push(field);
      } else if (yours) {
        keptYours.push(field);
      }
    };

    decide('name', !!was && was.name !== next.name, !!was && was.name !== obj.name,
      () => { plan.name = next.name; });
    decide('position', !was || !sameTriple(was.position, next.position),
      !was || !sameTriple(was.position, obj.position),
      () => { plan.position = next.position; });
    decide('rotation', !was || !sameTriple(was.rotation, next.rotation),
      !was || !sameTriple(was.rotation, obj.rotation),
      () => { plan.rotation = next.rotation; });
    decide('scale', !was || !sameTriple(was.scale, next.scale),
      !was || !sameTriple(was.scale, obj.scale),
      () => { plan.scale = next.scale; });

    // Materials, modifiers, visibility, animation and hierarchy are never
    // taken from the generator: a re-run has no opinion about them beyond the
    // colour it asked for on a brand new part, and the whole point is that
    // what you did to them is yours.
    if (obj.materialSlots.length) keptYours.push('materials');
    if (obj.modifiers.length) keptYours.push('modifiers');
    if (obj.animation && obj.animation.length) keptYours.push('animation');
    if (!obj.visible || obj.locked) keptYours.push('visibility');

    plan.action = tookGenerator.length ? 'updated' : keptYours.length ? 'kept-yours' : 'unchanged';
    parts.push({ key, name, action: plan.action, tookGenerator, keptYours, objectId: obj.id });
    if (plan.action !== 'unchanged') plans.push(plan);
  }

  const count = (action: MergeAction): number => parts.filter((p) => p.action === action).length;
  return {
    parts: plans,
    remove,
    report: {
      parts,
      conflicts,
      userAdded,
      added: count('added'),
      removed: count('removed'),
      updated: count('updated'),
      keptYours: count('kept-yours'),
      unchanged: count('unchanged'),
      protectedParts: count('protected'),
      blind,
    },
  };
}

function describeGeometryConflict(
  name: string, blind: boolean, topologyChanged: boolean, lost: string[],
): string {
  if (blind) {
    return `"${name}" has no recorded baseline, so your edits to its shape cannot be told from `
      + 'the generator\'s. Applying the revision would replace the shape entirely.';
  }
  const what = lost.length
    ? ` Your ${lost.join(', ')} are stored against the vertices this would replace, so they cannot be carried over.`
    : '';
  return topologyChanged
    ? `You changed the shape of "${name}", and this revision rebuilds it with different topology. `
      + `There is no correspondence between the two, so one has to win.${what}`
    : `Both you and this revision moved the vertices of "${name}", differently.${what}`;
}

/** Whether an object still matches what the generator produced for it. */
function unchangedSinceBaseline(was: BaselinePart, obj: SerializedObject): boolean {
  return sameMesh(was.mesh, obj.mesh ?? null)
    && sameTriple(was.position, obj.position)
    && sameTriple(was.rotation, obj.rotation)
    && sameTriple(was.scale, obj.scale)
    && was.name === obj.name;
}

/** One line for a status bar; the panel shows the detail. */
export function summariseMerge(report: MergeReport): string {
  const bits: string[] = [];
  if (report.added) bits.push(`${report.added} added`);
  if (report.removed) bits.push(`${report.removed} removed`);
  if (report.updated) bits.push(`${report.updated} updated`);
  if (report.keptYours) bits.push(`${report.keptYours} kept as you had them`);
  if (report.unchanged) bits.push(`${report.unchanged} unchanged`);
  if (report.protectedParts) bits.push(`${report.protectedParts} protected`);
  if (report.userAdded.length) bits.push(`${report.userAdded.length} of yours untouched`);
  if (report.conflicts.length) bits.push(`${report.conflicts.length} conflict${report.conflicts.length === 1 ? '' : 's'}`);
  return bits.length ? bits.join(', ') : 'nothing to change';
}
