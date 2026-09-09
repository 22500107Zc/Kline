import { Mesh } from '../mesh/Mesh';
import { Vec3 } from '../core/math';
import { Scene, SceneObject, SerializedObject, SerializedScene } from '../scene/Scene';
import { createMaterial, hexToLinear } from '../scene/Material';
import {
  CurrentPart, MergePlan, MergeReport, ProposedPart, mergeAsset, summariseMerge,
} from '../build/merge';
import {
  Baseline, BaselinePart, Provenance, cloneProvenance, hasBaseline, regenerability,
} from '../build/provenance';
import { EditorSnapshot } from './history';

/**
 * A revision you can look at before you agree to it.
 *
 * Generation is the one operation in a modelling application where "just try
 * it and undo if you hate it" is not good enough, because what it destroys is
 * not one edit but every edit you made since the last one. So a revision is
 * staged: the merge decides what each part should become, the result is put
 * into the scene so it can be *seen* — geometry is not reviewable as a list —
 * and the scene as it was is held intact until somebody says.
 *
 * Reject restores that held state exactly, so nothing about the original was
 * risked by looking. Accept turns the whole thing into one undo step, so a
 * revision that touched forty parts is one Ctrl+Z and not forty.
 */

export interface RevisionSummary {
  label: string;
  report: MergeReport;
  /** One line, for the status bar. */
  headline: string;
  /** Anything worth saying that is not a conflict. */
  notes: string[];
}

interface PendingRevision {
  assetId: string;
  rootId: number;
  label: string;
  /** The scene exactly as it was before the preview was applied. */
  before: EditorSnapshot;
  /** The new provenance to install if this is accepted. */
  provenance: Provenance;
  /** What the generator produced, kept so a conflict can still be resolved its way. */
  proposed: ProposedPart[];
  summary: RevisionSummary;
}

/** Everything the session needs from the editor, kept narrow for testability. */
export interface RevisionHost {
  scene: Scene;
  snapshot(label: string): EditorSnapshot;
  restore(snapshot: EditorSnapshot): void;
  pushHistory(snapshot: EditorSnapshot): void;
  setStatus(message: string): void;
  refresh(): void;
}

/**
 * The parts of an asset as they currently stand, and the objects under it that
 * the generator has never heard of.
 *
 * A detail you added — a handrail modelled onto a generated staircase, a bolt
 * dropped onto a generated bracket — has no part key, and that absence is what
 * marks it as yours. It is never matched, never replaced and never removed.
 */
export function collectAsset(scene: Scene, root: SceneObject): {
  current: CurrentPart[];
  userAdded: { id: number; name: string }[];
} {
  const current: CurrentPart[] = [];
  const userAdded: { id: number; name: string }[] = [];
  const doc = scene.toJSON();
  const byId = new Map<number, SerializedObject>();
  for (const o of doc.objects) byId.set(o.id, o);

  const visit = (id: number): void => {
    const obj = scene.get(id);
    if (!obj) return;
    const serialized = byId.get(id);
    if (serialized) {
      if (obj.partKey) {
        current.push({
          key: obj.partKey,
          object: serialized,
          protectedFromRegen: obj.protectedFromRegen,
        });
      } else if (id !== root.id) {
        userAdded.push({ id, name: obj.name });
      }
    }
    for (const child of obj.children) visit(child);
  };
  // An asset built from a reference image is one mesh, so its root is also its
  // only part. Starting from the children alone would find nothing to merge
  // and quietly treat every revision of a photo model as a fresh build.
  visit(root.id);
  return { current, userAdded };
}

/** A fingerprint of the asset, for noticing that it moved while we were thinking. */
export function assetFingerprint(scene: Scene, root: SceneObject | null): string {
  if (!root) return '';
  const doc = scene.toJSON();
  const wanted = new Set<number>([root.id]);
  const collect = (id: number): void => {
    const obj = scene.get(id);
    if (!obj) return;
    for (const c of obj.children) {
      wanted.add(c);
      collect(c);
    }
  };
  collect(root.id);
  const parts = doc.objects
    .filter((o) => wanted.has(o.id))
    .map((o) => JSON.stringify([o.id, o.name, o.position, o.rotation, o.scale, o.materialSlots,
      o.visible, o.locked, o.mesh?.positions.length ?? 0, o.mesh?.faces.length ?? 0,
      o.mesh ? hashMesh(o.mesh) : 0]));
  return parts.sort().join('|');
}

/** A cheap content hash — enough to notice a change, not a security digest. */
function hashMesh(mesh: NonNullable<SerializedObject['mesh']>): number {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(mesh.positions.length / 512));
  for (let i = 0; i < mesh.positions.length; i += step) {
    h ^= Math.round(mesh.positions[i] * 1e5) | 0;
    h = Math.imul(h, 16777619);
  }
  for (let f = 0; f < mesh.faces.length; f += Math.max(1, Math.floor(mesh.faces.length / 256))) {
    h ^= mesh.faces[f].length + mesh.faces[f][0] * 31;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class RevisionSession {
  private pending: PendingRevision | null = null;

  constructor(private host: RevisionHost) {}

  get active(): boolean {
    return this.pending !== null;
  }

  get summary(): RevisionSummary | null {
    return this.pending?.summary ?? null;
  }

  get rootId(): number | null {
    return this.pending?.rootId ?? null;
  }

  /**
   * Work out what a revision would do, apply it so it can be seen, and hold
   * the scene as it was.
   *
   * The merge runs first and touches nothing; only once it has a plan is
   * anything written, and the snapshot taken before that write is the exact
   * thing Reject puts back.
   */
  preview(
    root: SceneObject,
    proposed: ProposedPart[],
    label: string,
    notes: string[] = [],
    /**
     * Changes to the record itself — the revised program, new settings.
     *
     * Handed in rather than written to the live object, because the live
     * object's record is part of what Reject has to put back: writing the new
     * program onto it now would leave the program behind after a rejection.
     */
    patch: Partial<Pick<Provenance, 'code' | 'params' | 'prompt' | 'reference' | 'seed'>> = {},
  ): RevisionSummary | null {
    if (this.pending) this.reject();
    const prov = root.provenance;
    if (!prov) {
      this.host.setStatus('That object has no record of how it was made, so there is nothing to revise.');
      return null;
    }
    const scene = this.host.scene;
    const { current, userAdded } = collectAsset(scene, root);
    const plan = mergeAsset(prov.baseline, current, proposed, userAdded);

    const before = this.host.snapshot(label);
    this.applyPlan(root, plan, proposed);

    const next = cloneProvenance(prov);
    next.revision = prov.revision + 1;
    next.createdAt = Date.now();
    // The new baseline is what the generator just produced, not what the merge
    // settled on: the baseline's job is to record the generator's opinion, so
    // that next time round a part you kept can still be told from one it
    // changed.
    next.baseline = baselineFrom(proposed, prov.baseline);
    if (patch.code !== undefined) next.code = patch.code;
    if (patch.prompt !== undefined) next.prompt = patch.prompt;
    if (patch.seed !== undefined) next.seed = patch.seed;
    if (patch.reference !== undefined) next.reference = patch.reference;
    if (patch.params) next.params = { ...next.params, ...patch.params };

    const summary: RevisionSummary = {
      label,
      report: plan.report,
      headline: summariseMerge(plan.report),
      notes: [
        ...notes,
        ...(plan.report.blind
          ? ['No baseline was recorded for this asset, so your edits could not be told from the generator\'s. Everything is offered as the generator made it.']
          : []),
      ],
    };
    this.pending = {
      assetId: prov.assetId, rootId: root.id, label, before, provenance: next,
      proposed, summary,
    };
    this.host.refresh();
    this.host.setStatus(`Preview: ${label} — ${summary.headline}. Accept or Reject.`);
    return summary;
  }

  /**
   * Put the scene back exactly as it was.
   *
   * Restoring the held snapshot rather than undoing the changes one by one:
   * the snapshot *is* the previous state, so there is no sequence of inverse
   * operations to get subtly wrong, and the history is untouched — a rejected
   * revision leaves no trace, which is what "rejected" should mean.
   */
  reject(): boolean {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = null;
    this.host.restore(pending.before);
    this.host.setStatus(`Rejected: ${pending.label}. Nothing changed.`);
    this.host.refresh();
    return true;
  }

  /**
   * Forget a pending preview without restoring anything.
   *
   * For the cases where the scene it belonged to is going away regardless —
   * a new document, a file opened over the top. Accept and Reject both refer
   * to a scene that is about to stop existing, so neither is meaningful and
   * holding the snapshot would only make one of them wrong later.
   */
  discard(): void {
    if (!this.pending) return;
    this.pending = null;
    this.host.refresh();
  }

  /** Keep the preview, as one undoable step. */
  accept(): boolean {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = null;
    const root = this.host.scene.get(pending.rootId);
    if (root) root.provenance = pending.provenance;
    // The held snapshot becomes the undo entry, so undoing puts back the whole
    // revision — geometry, provenance, materials and hierarchy together —
    // rather than an object at a time.
    this.host.pushHistory(pending.before);
    this.host.setStatus(`Accepted: ${pending.label} — ${pending.summary.headline}`);
    this.host.refresh();
    return true;
  }

  /**
   * Settle one conflict the merge would not settle by itself.
   *
   * Only ever reachable from a preview, so every outcome is still inside the
   * held snapshot: choosing wrongly costs a Reject, not the work.
   *
   *   - "mine" is already what is in the scene; it is recorded as decided.
   *   - "theirs" writes the generated version over yours.
   *   - "both" gives the generated version its own object and hands yours the
   *     status of something you made — which it now is, since nothing will
   *     regenerate it again.
   */
  resolveConflict(key: string, choice: 'mine' | 'theirs' | 'both'): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const conflict = pending.summary.report.conflicts.find((c) => c.key === key);
    if (!conflict) return false;
    const scene = this.host.scene;
    const source = pending.proposed.find((p) => p.key === key) ?? null;
    const mine = conflict.objectId !== null ? scene.get(conflict.objectId) : null;

    if (choice === 'theirs' || choice === 'both') {
      if (!source) {
        // The generator dropped this part, so "use the revised one" means
        // removing it and "keep both" has nothing to add.
        if (choice === 'theirs' && mine) scene.remove(mine.id);
      } else if (choice === 'theirs' && mine) {
        if (source.mesh) mine.mesh = Mesh.fromJSON(source.mesh);
        mine.name = source.name;
        mine.position = new Vec3(...source.position);
        mine.rotation = new Vec3(...source.rotation);
        mine.scale = new Vec3(...source.scale);
        mine.protectedFromRegen = false;
        mine.invalidate();
      } else if (choice === 'both') {
        const root = scene.get(pending.rootId);
        const fresh = scene.add('mesh', source.name, source.mesh ? Mesh.fromJSON(source.mesh) : new Mesh());
        fresh.position = new Vec3(...source.position);
        fresh.rotation = new Vec3(...source.rotation);
        fresh.scale = new Vec3(...source.scale);
        fresh.partKey = key;
        fresh.materialSlots = [source.color
          ? materialFor(scene, source.color)
          : scene.ensureDefaultMaterial()];
        if (root) scene.setParent(fresh.id, root.id);
        // Yours keeps everything but the identity: it is your object now, and
        // two objects claiming one part key would make the next revision
        // ambiguous.
        if (mine) {
          mine.partKey = null;
          mine.name = scene.uniqueName(`${mine.name} (yours)`);
        }
      }
    }

    pending.summary.report.conflicts = pending.summary.report.conflicts.filter((c) => c.key !== key);
    for (const part of pending.summary.report.parts) {
      if (part.key !== key) continue;
      part.action = choice === 'mine' ? 'kept-yours' : choice === 'both' ? 'added' : 'updated';
      if (choice === 'mine') part.keptYours = ['everything'];
      else part.tookGenerator = ['geometry'];
    }
    pending.summary.headline = summariseMerge(pending.summary.report);
    this.host.refresh();
    return true;
  }

  /**
   * Apply a merge plan to the live scene.
   *
   * Only what the plan actually decided: a part whose geometry was kept is not
   * rewritten with identical data, because rewriting it would bump its
   * revision and make it look changed to everything downstream.
   */
  private applyPlan(root: SceneObject, plan: MergePlan, proposed: ProposedPart[]): void {
    const scene = this.host.scene;
    const byKey = new Map<string, ProposedPart>();
    for (const p of proposed) byKey.set(p.key, p);

    for (const id of plan.remove) {
      // Anything of yours hanging off a part the generator dropped is lifted
      // to the asset root first. `Scene.remove` takes the whole subtree, so
      // without this a detail modelled onto a step would disappear with the
      // step — losing work to a removal nobody asked about, which is exactly
      // what this is all for.
      const doomed = scene.get(id);
      if (doomed) {
        for (const child of [...doomed.children]) {
          const obj = scene.get(child);
          if (obj && !obj.partKey) scene.setParent(child, root.id);
        }
      }
      scene.remove(id);
    }

    for (const part of plan.parts) {
      if (part.objectId === null) {
        const source = byKey.get(part.key);
        if (!source) continue;
        const mesh = source.mesh ? Mesh.fromJSON(source.mesh) : new Mesh();
        const obj = scene.add('mesh', source.name, mesh);
        obj.partKey = part.key;
        obj.position = new Vec3(...source.position);
        obj.rotation = new Vec3(...source.rotation);
        obj.scale = new Vec3(...source.scale);
        obj.materialSlots = [source.color
          ? materialFor(scene, source.color)
          : scene.ensureDefaultMaterial()];
        scene.setParent(obj.id, root.id);
        continue;
      }
      const obj = scene.get(part.objectId);
      if (!obj) continue;
      if (part.mesh) {
        obj.mesh = Mesh.fromJSON(part.mesh);
        obj.invalidate();
      }
      if (part.name !== null) obj.name = part.name;
      if (part.position) obj.position = new Vec3(...part.position);
      if (part.rotation) obj.rotation = new Vec3(...part.rotation);
      if (part.scale) obj.scale = new Vec3(...part.scale);
    }
  }
}

/** Reuse a material of the same colour rather than adding a near-duplicate. */
function materialFor(scene: Scene, hex: string): number {
  const wanted = hexToLinear(hex);
  for (let i = 0; i < scene.materials.length; i++) {
    const m = scene.materials[i];
    if (m.name === hex && m.color.every((c, k) => Math.abs(c - wanted[k]) < 1e-6)) return i;
  }
  return scene.addMaterial(createMaterial({ name: hex, color: wanted, roughness: 0.55 }));
}

/** The generator's new output, recorded as the baseline for next time. */
export function baselineFrom(proposed: ProposedPart[], previous: Baseline): Baseline {
  const parts: BaselinePart[] = proposed.map((p) => ({
    key: p.key,
    name: p.name,
    position: p.position,
    rotation: p.rotation,
    scale: p.scale,
    mesh: p.mesh,
    color: p.color,
  }));
  return parts.length ? { parts } : previous;
}

/**
 * Whether an object can be revised at all, and what to say when it cannot.
 *
 * Three separate questions, because they have three different answers for the
 * user: nothing was recorded, the recording is there but the ingredients are
 * missing, or everything is present but there is no baseline so edits cannot
 * be distinguished. Only the first is a dead end.
 */
export function revisability(obj: SceneObject | null): {
  can: boolean;
  blind: boolean;
  why: string;
} {
  if (!obj) return { can: false, blind: false, why: 'Nothing is selected.' };
  const prov = obj.provenance;
  const { can, why } = regenerability(prov);
  if (!can) {
    return {
      can: false,
      blind: false,
      why: `${why} You can still copy it, edit it by hand, or build a new one alongside it.`,
    };
  }
  return {
    can: true,
    blind: !hasBaseline(prov),
    why: '',
  };
}

/** Find the generated asset a selected object belongs to. */
export function assetRootFor(scene: Scene, obj: SceneObject | null): SceneObject | null {
  let cursor = obj;
  let guard = 0;
  while (cursor && guard++ < 64) {
    if (cursor.provenance) return cursor;
    cursor = cursor.parent !== null ? scene.get(cursor.parent) : null;
  }
  return null;
}

export type { SerializedScene };
