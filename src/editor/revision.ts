import { Mesh } from '../mesh/Mesh';
import { Vec3, decomposeMatrix } from '../core/math';
import { Scene, SceneObject, SerializedObject, SerializedScene } from '../scene/Scene';
import { createMaterial, hexToLinear } from '../scene/Material';
import {
  CurrentPart, MergeConflict, MergePlan, MergeReport, ProposedPart, mergeAsset, summariseMerge,
} from '../build/merge';
import {
  BASELINE_VERSION, Baseline, BaselinePart, Provenance, cloneProvenance, hasBaseline,
  regenerability,
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
  /** Part keys that stay deleted, updated as existence conflicts are settled. */
  stillDeleted: Set<string>;
  /** Every choice made during review, recorded so the outcome is explainable. */
  resolved: { key: string; field: string; choice: 'mine' | 'theirs' | 'both' }[];
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

  /** Everything of the creator's own hanging under an object, at any depth. */
  const userUnder = (id: number): { id: number; name: string }[] => {
    const out: { id: number; name: string }[] = [];
    const walk = (at: number): void => {
      const node = scene.get(at);
      if (!node) return;
      for (const child of node.children) {
        const obj = scene.get(child);
        if (!obj) continue;
        if (!obj.partKey) out.push({ id: obj.id, name: obj.name });
        walk(child);
      }
    };
    walk(id);
    return out;
  };

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
          userDescendants: userUnder(id),
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

/**
 * A stamp identifying exactly which version of an asset a request was made
 * against.
 *
 * The first attempt at this sampled a few hundred vertex positions and hashed
 * them, which is fast and wrong: a mesh edit that happens to miss every
 * sampled index is invisible, and so is any change to a material, a modifier
 * or an animation. A stamp that can miss a change is worse than none, because
 * it is trusted.
 *
 * So it is exact. `Mesh.revision` is bumped by every mutation the kernel makes
 * — it is what the renderer and the modifier cache already rely on — and
 * everything else that could have changed is small enough to compare whole.
 * There is nothing here that is sampled, approximated, or hoped about.
 */
export function assetFingerprint(scene: Scene, root: SceneObject | null): string {
  if (!root) return '';
  const parts: string[] = [];
  const visit = (id: number): void => {
    const o = scene.get(id);
    if (!o) return;
    parts.push(JSON.stringify([
      o.id, o.partKey, o.name,
      o.position.toArray(), o.rotation.toArray(), o.scale.toArray(),
      o.materialSlots, o.materialSlots.map((slot) => scene.materials[slot] ?? null),
      o.visible, o.locked, o.protectedFromRegen, o.parent, [...o.children].sort(),
      o.modifiers, o.animation ?? [],
      // The kernel's own change counter, plus identity: a modifier stack hands
      // back a fresh mesh at revision 1 every time it runs, so the counter
      // alone would collide.
      o.mesh ? [o.mesh.id, o.mesh.revision] : null,
    ]));
    for (const child of o.children) visit(child);
  };
  visit(root.id);
  return parts.join('|');
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
    /**
     * The asset this proposal was generated against.
     *
     * A model takes seconds and a person does not wait. If the object was
     * deleted and something else now holds its id — a new build, an import, a
     * reopened file — then this answer belongs to a question about something
     * that no longer exists, and applying it would corrupt whatever is there
     * now. Identity is checked rather than inferred from the id.
     */
    expectAssetId?: string,
  ): RevisionSummary | null {
    // A second request while one is open used to silently reject the first.
    // That is a proposal thrown away without anybody being asked — the same
    // class of quiet loss this whole thing exists to stop, just aimed at the
    // review instead of the model.
    if (this.pending) {
      this.host.setStatus(
        `"${this.pending.label}" is still waiting. Accept or reject it before starting another.`,
      );
      return null;
    }
    const prov = root.provenance;
    if (!prov) {
      this.host.setStatus('That object has no record of how it was made, so there is nothing to revise.');
      return null;
    }
    if (expectAssetId !== undefined && prov.assetId !== expectAssetId) {
      this.host.setStatus(
        'That object was replaced while this revision was being generated, so the result was '
        + 'discarded. Nothing was changed.',
      );
      return null;
    }
    const scene = this.host.scene;
    const { current, userAdded } = collectAsset(scene, root);
    const plan = mergeAsset(prov.baseline, current, proposed, userAdded, {
      deleted: prov.deletedParts,
      materials: scene.materials,
    });

    const before = this.host.snapshot(label);
    this.applyPlan(root, plan, proposed);

    const next = cloneProvenance(prov);
    next.revision = prov.revision + 1;
    next.createdAt = Date.now();
    // The new baseline is what the generator just produced, not what the merge
    // settled on: the baseline's job is to record the generator's opinion, so
    // that next time round a part you kept can still be told from one it
    // changed.
    // The baseline is not written here. Half of it has to be read from the
    // live objects *after* every conflict has been settled, so it is built at
    // acceptance instead — see `accept`.
    next.deletedParts = undefined;   // filled in at acceptance, once conflicts are settled
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
      stillDeleted: new Set(plan.stillDeleted),
      resolved: [],
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
    // An unresolved conflict must not vanish into an acceptance. Either settle
    // them one at a time, or say once that your versions win — which is
    // recorded, so the next revision knows the argument was had.
    if (pending.summary.report.conflicts.length) {
      this.host.setStatus(
        `${pending.summary.report.conflicts.length} conflict(s) still open. Resolve them, or `
        + 'choose "Keep my versions for all remaining" to settle them together.',
      );
      return false;
    }
    this.pending = null;
    const scene = this.host.scene;
    const root = scene.get(pending.rootId);
    if (root) {
      const live = new Map<string, SceneObject>();
      const walk = (id: number): void => {
        const obj = scene.get(id);
        if (!obj) return;
        if (obj.partKey && !live.has(obj.partKey)) live.set(obj.partKey, obj);
        for (const child of obj.children) walk(child);
      };
      walk(root.id);
      pending.provenance.baseline = baselineFrom(
        pending.proposed, pending.provenance.baseline, live, scene.materials,
      );
      // A part with no object behind it after every choice was made is one you
      // deleted. Recorded here, so it does not come back next time.
      const gone = [...pending.stillDeleted].filter((key) => !live.has(key));
      pending.provenance.deletedParts = gone.length ? gone : undefined;
      root.provenance = pending.provenance;
    }
    // The held snapshot becomes the undo entry, so undoing puts back the whole
    // revision — geometry, provenance, materials and hierarchy together —
    // rather than an object at a time.
    this.host.pushHistory(pending.before);
    this.host.setStatus(`Accepted: ${pending.label} — ${pending.summary.headline}`);
    this.host.refresh();
    return true;
  }

  /**
   * Settle every remaining conflict in your favour, in one act.
   *
   * Offered because refusing to accept until each is answered individually is
   * right in principle and tiring in practice on a forty-part asset. What it
   * is not is a way for them to disappear: choosing this is a decision, it is
   * recorded on the parts it covers, and it reads as an override rather than
   * as agreement.
   */
  keepMineForAll(): number {
    const pending = this.pending;
    if (!pending) return 0;
    const open = [...pending.summary.report.conflicts];
    for (const conflict of open) this.resolveConflict(conflict.key, 'mine', conflict.field);
    return open.length;
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
  resolveConflict(
    key: string,
    choice: 'mine' | 'theirs' | 'both',
    field?: MergeConflict['field'],
  ): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const conflict = pending.summary.report.conflicts.find(
      (c) => c.key === key && (field === undefined || c.field === field),
    );
    if (!conflict) return false;
    const scene = this.host.scene;
    const source = pending.proposed.find((p) => p.key === key) ?? null;
    const mine = conflict.objectId !== null ? scene.get(conflict.objectId) : null;

    // Protection is not advice. A part held back from regeneration stays held
    // back through this panel too — otherwise the switch means "unless you
    // press a different button", which is not what anybody reads it as. The
    // conflict is closed either way, because it has been answered: the answer
    // is that the protection stands.
    if (mine?.protectedFromRegen && choice !== 'mine') {
      this.host.setStatus(
        `"${mine.name}" is protected from regeneration. Turn that off in its properties first `
        + 'if you want this revision to change it.',
      );
      this.settle(pending, conflict, 'kept-yours');
      return true;
    }

    // A disagreement about a name is settled by changing a name. Applying the
    // whole generated part would also reset a placement and a shape nobody was
    // arguing about, which is the quiet loss this is all here to prevent.
    if (conflict.field && conflict.field !== 'geometry' && conflict.field !== 'existence') {
      if (choice === 'theirs' && mine && source) {
        if (conflict.field === 'name') mine.name = source.name;
        if (conflict.field === 'position') mine.position = new Vec3(...source.position);
        if (conflict.field === 'rotation') mine.rotation = new Vec3(...source.rotation);
        if (conflict.field === 'scale') mine.scale = new Vec3(...source.scale);
      }
      // "Keep both" has no meaning for a single scalar field; it is not
      // offered for one, and if it arrives anyway it means keep mine.
      this.settle(pending, conflict, choice === 'theirs' ? 'updated' : 'kept-yours');
      return true;
    }

    // Existence: you deleted it, the revision wants it back (or the reverse).
    if (conflict.field === 'existence') {
      const root = scene.get(pending.rootId);
      if (choice === 'theirs') {
        if (source && root) {
          // Restore it, explicitly, because you asked.
          const obj = scene.add('mesh', source.name, source.mesh ? Mesh.fromJSON(source.mesh) : new Mesh());
          obj.partKey = key;
          obj.position = new Vec3(...source.position);
          obj.rotation = new Vec3(...source.rotation);
          obj.scale = new Vec3(...source.scale);
          obj.materialSlots = [source.color
            ? materialFor(scene, source.color)
            : scene.ensureDefaultMaterial()];
          scene.setParent(obj.id, root.id);
          pending.stillDeleted.delete(key);
        } else if (mine) {
          // The other direction: the generator removes it and you agree.
          this.detachUserWork(mine, pending.rootId);
          scene.remove(mine.id);
          pending.stillDeleted.add(key);
        }
      } else {
        // Keep mine: whatever you had is what stays, deletion included.
        if (!mine) pending.stillDeleted.add(key);
      }
      this.settle(pending, conflict, choice === 'theirs' ? 'updated' : 'kept-yours');
      return true;
    }

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

    this.settle(pending, conflict, choice === 'mine' ? 'kept-yours' : choice === 'both' ? 'added' : 'updated');
    return true;
  }

  /**
   * Record that one disagreement has been answered, and refresh the counts.
   *
   * The summary is what somebody reads to decide whether they are finished, so
   * it has to move as each choice is made rather than at the end.
   */
  private settle(
    pending: PendingRevision, conflict: MergeConflict, action: 'kept-yours' | 'updated' | 'added',
  ): void {
    const report = pending.summary.report;
    report.conflicts = report.conflicts.filter((c) => c !== conflict);
    pending.resolved.push({
      key: conflict.key,
      field: conflict.field ?? 'geometry',
      choice: action === 'kept-yours' ? 'mine' : action === 'added' ? 'both' : 'theirs',
    });
    const stillOpen = report.conflicts.some((c) => c.key === conflict.key);
    for (const part of report.parts) {
      if (part.key !== conflict.key || stillOpen) continue;
      part.action = action;
      if (action === 'kept-yours') part.keptYours = [...new Set([...part.keptYours, conflict.field ?? 'geometry'])];
      else part.tookGenerator = [...new Set([...part.tookGenerator, conflict.field ?? 'geometry'])];
    }
    pending.summary.headline = summariseMerge(report);
    this.host.refresh();
  }

  /**
   * Move anything the creator made out from under a part about to be removed.
   *
   * `Scene.remove` takes the whole subtree, so a detail modelled onto a step
   * would go with the step. Lifting it to the asset root keeps it, and keeping
   * its world matrix keeps it where it was — a survivor that teleports because
   * its parent's transform vanished has been damaged, not preserved.
   */
  private detachUserWork(doomed: SceneObject, rootId: number): void {
    const scene = this.host.scene;
    const root = scene.get(rootId);
    if (!root) return;
    for (const child of [...doomed.children]) {
      const obj = scene.get(child);
      if (!obj) continue;
      if (obj.partKey) {
        this.detachUserWork(obj, rootId);
        continue;
      }
      const world = obj.worldMatrix(scene);
      scene.setParent(child, rootId);
      const local = root.worldMatrix(scene).inverse().multiply(world);
      const placed = decomposeMatrix(local);
      obj.position = placed.position;
      obj.rotation = placed.rotation;
      obj.scale = placed.scale;
    }
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
      // clear first, at any depth and keeping its place in the world. Without
      // it a detail modelled onto a step disappears with the step; with a
      // naive reparent it survives but jumps, which is damage wearing the
      // clothes of preservation.
      const doomed = scene.get(id);
      if (doomed) this.detachUserWork(doomed, root.id);
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

/**
 * The baseline to compare against next time.
 *
 * Two different questions live in one record, and they take their answers from
 * two different places.
 *
 * For the fields the generator owns — shape, placement, name — it is what the
 * generator just produced, *even where you kept yours instead*. That is what
 * makes a preserved edit stay preserved: next time round the generator offers
 * the same thing again, which now matches the baseline, so it reads as "the
 * generator did not change this" and your version is kept without asking you
 * a second time. Recording your version here instead would make the next
 * revision believe the generator had produced it, and quietly overwrite it.
 *
 * For the fields the generator has no opinion about — materials, modifiers,
 * animation, visibility — it is the state at the moment you agreed, so that an
 * edit made afterwards is detectable as an edit.
 */
export function baselineFrom(
  proposed: ProposedPart[],
  previous: Baseline,
  live: Map<string, SceneObject>,
  materials: unknown[],
): Baseline {
  const parts: BaselinePart[] = proposed.map((p) => {
    const obj = live.get(p.key) ?? null;
    return {
      key: p.key,
      name: p.name,
      position: p.position,
      rotation: p.rotation,
      scale: p.scale,
      mesh: p.mesh,
      color: p.color,
      materialSlots: obj ? [...obj.materialSlots] : [],
      materials: obj ? obj.materialSlots.map((slot) => materials[slot] ?? null) : [],
      modifiers: obj ? JSON.parse(JSON.stringify(obj.modifiers)) : [],
      animation: obj ? JSON.parse(JSON.stringify(obj.animation ?? [])) : [],
      visible: obj ? obj.visible : true,
      locked: obj ? obj.locked : false,
      protectedFromRegen: obj ? obj.protectedFromRegen : false,
    };
  });
  return parts.length ? { parts, version: BASELINE_VERSION } : previous;
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
