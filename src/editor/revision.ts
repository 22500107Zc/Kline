import { Mesh } from '../mesh/Mesh';
import { Mat4, Vec3, decomposeMatrix } from '../core/math';
import { Scene, SceneObject, SerializedObject, SerializedScene } from '../scene/Scene';
import { createMaterial, hexToLinear } from '../scene/Material';
import {
  CurrentPart, MergeConflict, MergePlan, MergeReport, ProposedPart, mergeAsset, summariseMerge,
} from '../build/merge';
import {
  BASELINE_VERSION, Baseline, BaselinePart, Provenance, cloneProvenance, hasBaseline,
  regenerability,
} from '../build/provenance';
import { EditorSnapshot, SnapshotStore } from './history';
import { carryAttributes, describeCarry } from '../mesh/carry';

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

/**
 * What a revision did, kept after the panel that described it has gone.
 *
 * The panel is bound to the *pending* review and Accept and Reject both end
 * that, so anything written onto the summary at the last moment was displayed
 * to nobody: the note went up and the panel came down in the same breath. A
 * placement that could not be reproduced exactly is exactly such a note, and
 * it was the one thing in there that a person needed to act on.
 */
export interface RevisionOutcome {
  label: string;
  action: 'accepted' | 'rejected';
  /** Anything that could not be done exactly. Empty on the ordinary path. */
  warnings: string[];
}

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
  /** Anything that could not be done exactly, kept for the record afterwards. */
  warnings: string[];
  summary: RevisionSummary;
}

/** Everything the session needs from the editor, kept narrow for testability. */
export interface RevisionHost {
  scene: Scene;
  /**
   * The history's blob cache, so a document built during a review shares its
   * meshes with the snapshots either side of it instead of copying them. A
   * review is exactly when the meshes are biggest and most duplicated.
   *
   * A function rather than a value because the host hands this object over
   * from a field initialiser, before its own history exists.
   */
  snapshotStore?(): SnapshotStore | undefined;
  snapshot(label: string): EditorSnapshot;
  restore(snapshot: EditorSnapshot): void;
  pushHistory(snapshot: EditorSnapshot): void;
  setStatus(message: string): void;
  /**
   * Put something in front of the person that stays there until they dismiss
   * it. For what the status bar cannot carry: a status line is overwritten by
   * the next thing that happens, and a placement that had to be approximated
   * is not a thing to mention in passing.
   */
  notify?(title: string, warnings: string[]): void;
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

  /**
   * The last finished revision, and anything about it worth saying.
   *
   * Survives the review it describes. Read by the panel, which shows it in
   * place of the review once there is no review, and cleared when the person
   * dismisses it.
   */
  outcome: RevisionOutcome | null = null;

  constructor(private host: RevisionHost) {}

  /** The person has read the last outcome. */
  dismissOutcome(): void {
    this.outcome = null;
    this.host.refresh();
  }

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
   * Whether any of these objects is part of the asset under review.
   *
   * The line the transaction is drawn around. Inside it, the scene is showing
   * a proposal and editing would be lost whichever way the review went;
   * outside it, the scene is yours and always was.
   */
  touches(ids: number[]): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const scene = this.host.scene;
    const inside = new Set<number>();
    const walk = (id: number): void => {
      if (inside.has(id)) return;
      inside.add(id);
      for (const child of scene.get(id)?.children ?? []) walk(child);
    };
    walk(pending.rootId);
    return ids.some((id) => inside.has(id));
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
      warnings: [],
    };
    this.host.refresh();
    this.host.setStatus(`Preview: ${label} — ${summary.headline}. Accept or Reject.`);
    return summary;
  }

  /**
   * The objects on screen that *are* the proposal.
   *
   * Not "everything under the asset": something you made during the review and
   * hung on a proposed part is yours, and is governed by the history like the
   * rest of your work. The proposal is the generated parts and the root that
   * holds them.
   */
  private proposalIds(): Set<number> {
    const pending = this.pending;
    const out = new Set<number>();
    if (!pending) return out;
    const scene = this.host.scene;
    const walk = (id: number): void => {
      const obj = scene.get(id);
      if (!obj || out.has(id)) return;
      if (obj.partKey || id === pending.rootId) out.add(id);
      for (const child of obj.children) walk(child);
    };
    walk(pending.rootId);
    return out;
  }

  /**
   * The document as it stands with nobody having agreed to anything.
   *
   * The scene on screen during a review is two things at once: your document,
   * which you are still editing and which the history is about, and a proposal
   * laid over one asset in it, which nobody has accepted and which Reject is
   * entitled to erase without trace. Snapshotting the two together is what let
   * a rejected shape come back: an unrelated edit made during a review pushed
   * a whole-scene snapshot with the proposal inside it, Reject put the asset
   * back but could not reach into the history, and one Ctrl+Z later the
   * rejected geometry was on screen again with no way to tell it had been.
   *
   * So this is what the history records instead — everything of yours exactly
   * as it stands, the asset as it stood before the preview. Rejecting is then
   * genuinely traceless, and accepting adds exactly one step.
   */
  committedScene(): SerializedScene | null {
    return this.pending ? this.sceneWithAssetReverted(this.pending) : null;
  }

  /**
   * A restored document with the proposal put back on top.
   *
   * The other half of holding the proposal outside the history. Undo, redo and
   * a cancelled modal transform all restore a document that, by the rule
   * above, has the asset in its pre-preview form — so each of them would take
   * the preview off the screen, and there would be nothing to accept or reject
   * but a panel describing a change nobody could see any more.
   *
   * Stepping through your own history while a proposal is up is allowed, and
   * this is what keeps the proposal up while you do. Anything you made during
   * the review is *not* re-applied: it is document state, and if the step being
   * restored is from before you made it, it should go.
   */
  withProposal(doc: SerializedScene): SerializedScene {
    const pending = this.pending;
    if (!pending) return doc;
    const now = this.host.scene.toJSON(this.host.snapshotStore?.());
    const live = this.proposalIds();

    // Whatever the restored document says about the generated parts is
    // discarded — the proposal is the authority on those, and holding both
    // would mean two objects with one id.
    const docAsset = assetIdsIn(doc, pending.rootId);
    const base = doc.objects
      .filter((o) => !live.has(o.id)
        && !(docAsset.has(o.id) && (o.partKey || o.id === pending.rootId)))
      .map(cloneRecord);
    const proposal = now.objects.filter((o) => live.has(o.id)).map(cloneRecord);

    // Lifting is measured against wherever the object actually is: a restored
    // object against the document being restored, a proposed one against the
    // screen.
    const wasAt = worldMatrices(doc);
    for (const [id, m] of worldMatrices(now)) if (live.has(id)) wasAt.set(id, m);

    const { objects } = stitch([...proposal, ...base], wasAt);
    const present = new Set(objects.map((o) => o.id));
    const topLevel = objects.filter((o) => o.parent === null).map((o) => o.id);
    const listed = new Set<number>();
    const order = [...doc.order, ...now.order, ...topLevel].filter((id) => {
      if (listed.has(id) || !present.has(id) || !topLevel.includes(id)) return false;
      listed.add(id);
      return true;
    });

    return {
      ...doc,
      materials: materialsFor(doc, now),
      objects,
      order,
      selection: doc.selection.filter((id) => present.has(id)),
      active: doc.active !== null && present.has(doc.active) ? doc.active : null,
    };
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
    // Only the asset goes back. Restoring the whole scene would also undo
    // anything you did elsewhere while you were deciding — work you never
    // offered up and were never asked about, destroyed by a button labelled
    // "reject this revision".
    const warnings = [...pending.warnings];
    this.host.restore({
      ...pending.before,
      scene: this.sceneWithAssetReverted(pending, warnings),
    });
    // The reconstruction has just been applied to the scene in front of the
    // person, so whatever it could not do exactly is true *now* and is said
    // now — on a notice that outlives the panel it replaces.
    this.outcome = { label: pending.label, action: 'rejected', warnings: unique(warnings) };
    this.host.setStatus(`Rejected: ${pending.label}. The rest of your work is untouched.`);
    if (warnings.length) this.host.notify?.(`Rejected: ${pending.label}`, unique(warnings));
    this.host.refresh();
    return true;
  }

  /**
   * The scene as it is now, with just this asset put back as it was.
   *
   * The whole transaction, in one function. Reject adopts it; Accept pushes it
   * as the undo entry. Both need the same thing — everything else exactly as
   * it stands, this asset exactly as it stood — so both get it from here and
   * cannot drift apart.
   */
  private sceneWithAssetReverted(
    pending: PendingRevision,
    /**
     * Where to put anything that could not be done exactly, when the caller is
     * going to apply this result and is therefore in a position to report it.
     *
     * Omitted when the result is only being *measured*: the history takes a
     * committed document on every unrelated edit during a review, and a
     * warning about a detachment that has not happened and may never happen
     * does not belong in front of anybody each time.
     */
    collect?: string[],
  ): SerializedScene {
    const now = this.host.scene.toJSON(this.host.snapshotStore?.());
    const was = pending.before.scene;

    const subtreeNow = assetIdsIn(now, pending.rootId);
    const oldIds = assetIdsIn(was, pending.rootId);

    // Being inside the asset's subtree is not the same as being part of the
    // proposal. Something you made during the review and hung on a proposed
    // part is yours: it has no generated identity and it did not exist before,
    // so it is kept and lifted clear rather than swept away with the proposal
    // it happened to be attached to.
    const liveIds = new Set<number>();
    for (const o of now.objects) {
      if (!subtreeNow.has(o.id)) continue;
      if (oldIds.has(o.id) || o.partKey || o.id === pending.rootId) liveIds.add(o.id);
    }

    // Where everything is standing right now, read before anything is taken
    // apart. What survives the reconstruction has to survive it in place, and
    // after the proposal is gone there is nothing left to work that out from.
    const wasAt = worldMatrices(now);

    // The restored copies are the authority on the asset's own shape; anything
    // of yours keeps the state it is in. An id in both belongs to the asset.
    const restored = was.objects.filter((o) => oldIds.has(o.id)).map(cloneRecord);
    const kept = now.objects
      .filter((o) => !liveIds.has(o.id) && !oldIds.has(o.id))
      .map(cloneRecord);

    const { objects, warnings } = stitch([...kept, ...restored], wasAt);
    if (collect) for (const warning of warnings) collect.push(warning);

    const present = new Set(objects.map((o) => o.id));
    const topLevel = objects.filter((o) => o.parent === null).map((o) => o.id);
    const listed = new Set<number>();
    const order = [...now.order, ...topLevel].filter((id) => {
      if (listed.has(id) || !present.has(id)) return false;
      if (!topLevel.includes(id)) return false;
      listed.add(id);
      return true;
    });

    return {
      ...now,
      // Materials and textures are never rolled back: the list only grows, the
      // asset's slots are indices into it, and a material you made during the
      // review is yours.
      objects,
      order,
      selection: now.selection.filter((id) => present.has(id)),
      active: now.active !== null && present.has(now.active) ? now.active : null,
    };
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
    const scene = this.host.scene;
    // Computed before the provenance is installed, so the undo entry holds the
    // record as it was as well as the geometry as it was.
    const undone: string[] = [];
    const undoEntry: EditorSnapshot = {
      ...pending.before,
      scene: this.sceneWithAssetReverted(pending, undone),
      // Nothing is approximated by accepting — the asset is kept exactly as it
      // was previewed. The approximation is in the *undo*, which lifts work
      // off parts the revision introduced, and it has not happened yet. So the
      // warnings travel with the snapshot and are said when it is restored,
      // which is when they become true.
      warnings: unique(undone),
    };
    this.pending = null;
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
    this.host.pushHistory(undoEntry);
    this.outcome = {
      label: pending.label, action: 'accepted', warnings: unique(pending.warnings),
    };
    if (pending.warnings.length) {
      this.host.notify?.(`Accepted: ${pending.label}`, unique(pending.warnings));
    }
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
        if (source.mesh) {
          const previous = mine.mesh;
          const rebuilt = Mesh.fromJSON(source.mesh);
          // Everything stored against the old vertices that can be resampled
          // onto the new surface comes across. It is an approximation and it
          // says so — but "your weights are gone" was never the only possible
          // answer, only the easy one.
          if (previous) {
            const carried = carryAttributes(previous, rebuilt);
            if (carried.carried.length) {
              pending.summary.notes.push(`"${mine.name}": ${describeCarry(carried)}`);
            }
          }
          mine.mesh = rebuilt;
        }
        // The shape, and nothing else.
        //
        // This used to write the name and all three transforms across as well,
        // which quietly undid two different things. A name or a placement the
        // merge had already settled in your favour — because you changed it
        // and the generator did not — was reset to the generator's, without
        // ever being in dispute. And a *separate* conflict you had already
        // answered "keep mine" was reopened and answered the other way, by a
        // button that said nothing about it. Which of your decisions survived
        // came down to the order you happened to press them in.
        //
        // Each field is its own question here, and answering one answers one.
        mine.invalidate();
      } else if (choice === 'both' && mine && mine.id === pending.rootId) {
        // A model built from a picture is one mesh, so the asset's root *is*
        // its only part. Adding a sibling under it would leave the root being
        // both the container and one of the things it contains, and the next
        // revision would not know which it was looking at.
        //
        // So your version leaves the asset entirely and becomes an object of
        // your own, beside it. The asset keeps its identity, its record and
        // the generated geometry; you keep yours, free of anything that will
        // regenerate it again.
        const yours = scene.duplicateObject(mine.id, mine.parent);
        if (yours) {
          yours.provenance = null;
          yours.partKey = null;
          yours.protectedFromRegen = false;
          yours.name = scene.uniqueName(`${mine.name} (yours)`);
          // Its children came across with it; the asset keeps its own.
          for (const child of [...yours.children]) {
            const copy = scene.get(child);
            if (copy?.partKey) scene.remove(child);
          }
        }
        // The asset keeps the generated shape where you had put it: the
        // argument was about geometry, and a placement conflict — if there is
        // one — is its own row with its own answer. Your copy beside it keeps
        // everything, including the shape you are holding on to.
        if (source.mesh) mine.mesh = Mesh.fromJSON(source.mesh);
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
      const trouble = placeExactly(local, obj.name, (position, rotation, scale) => {
        obj.position = position;
        obj.rotation = rotation;
        obj.scale = scale;
      });
      // This one happens while you are looking at the preview, so it goes on
      // the panel in front of you — and into the record of what the operation
      // did, which outlives the panel.
      if (trouble && this.pending) {
        if (!this.pending.summary.notes.includes(trouble)) {
          this.pending.summary.notes.push(trouble);
        }
        if (!this.pending.warnings.includes(trouble)) this.pending.warnings.push(trouble);
      }
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

/**
 * The material list a restored document should carry while a proposal is up.
 *
 * Two things are true at once and the old rule could only express one of them.
 * The materials are *document state*: editing one during a review is ordinary
 * work, it goes in the history like any other edit, and undoing it has to put
 * the old values back. But a proposal may have been given a material that was
 * created after the document being restored — `materialFor` adds one when the
 * generator names a colour nothing in the scene already has — and its parts
 * address materials by index, so dropping that entry would leave them pointing
 * past the end of the list and rendering as the default.
 *
 * What was there before was `now.materials.length >= doc.materials.length ?
 * now.materials : doc.materials`: pick one whole list by comparing lengths.
 * A length cannot tell you which *values* belong to an undo state. Editing an
 * existing material during a review leaves both lists the same length, so the
 * live list won, and undoing the edit put the geometry back while silently
 * keeping the new colour — an undo that undid some of what it said it would.
 *
 * The list is append-only and indices are stable, so the two questions
 * separate cleanly per slot rather than per list:
 *
 *   - A slot the restored document knows about keeps *its* value. That is the
 *     state being restored, for every object that refers to it.
 *   - A slot created since is carried across unchanged, because something on
 *     screen may be the only thing that refers to it.
 *
 * A material shared between your work and a proposed part is one material, and
 * it follows the document: undoing an edit to it changes the proposal's
 * appearance too. That is not a compromise, it is what sharing means — and the
 * alternative, quietly forking it, would leave you with two materials where
 * you made one and no way to tell which is which.
 */
function materialsFor(doc: SerializedScene, now: SerializedScene): SerializedScene['materials'] {
  if (now.materials.length <= doc.materials.length) return doc.materials;
  return [...doc.materials, ...now.materials.slice(doc.materials.length)];
}

/**
 * A copy of a serialized object that reconstruction may safely rewrite.
 *
 * The scoped rebuilds below take objects out of two documents and stitch them
 * into a third, and stitching *edits*: it re-parents, rewrites children lists
 * and recomputes placements. `Array.prototype.filter` hands back a new array
 * of the same objects, so every one of those edits used to land on the
 * original — and one of those originals is `pending.before.scene`, the held
 * snapshot that Reject exists to restore, and the entries in the undo history.
 * Rebuilding twice therefore worked from an input the first rebuild had
 * already altered, and an undo could restore a state that no longer matched
 * what had been recorded.
 *
 * Only what is written to is copied. A serialized mesh is a frozen blob shared
 * deliberately between every snapshot that references it — copying those is
 * exactly the cost the history's blob store exists to avoid — and nothing here
 * writes to one.
 */
function cloneRecord(o: SerializedObject): SerializedObject {
  return {
    ...o,
    position: [...o.position] as [number, number, number],
    rotation: [...o.rotation] as [number, number, number],
    scale: [...o.scale] as [number, number, number],
    children: [...o.children],
    materialSlots: [...o.materialSlots],
  };
}

/** The same thing said twice is one thing. */
function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** Every id under a root in a serialized document, the root included. */
function assetIdsIn(doc: SerializedScene, rootId: number): Set<number> {
  const byId = new Map<number, SerializedObject>();
  for (const o of doc.objects) byId.set(o.id, o);
  const out = new Set<number>();
  const walk = (id: number): void => {
    if (out.has(id)) return;
    out.add(id);
    for (const child of byId.get(id)?.children ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

/**
 * World placement of every object in a serialized document.
 *
 * The scoped reconstruction below builds a document out of two others, so it
 * cannot ask the live scene where anything is — half the objects in the result
 * are not in it. This walks the parent chain in the document itself.
 */
function worldMatrices(doc: SerializedScene): Map<number, Mat4> {
  const byId = new Map<number, SerializedObject>();
  for (const o of doc.objects) byId.set(o.id, o);
  const out = new Map<number, Mat4>();
  const localOf = (o: SerializedObject): Mat4 =>
    Mat4.compose(new Vec3(...o.position), new Vec3(...o.rotation), new Vec3(...o.scale));
  const resolve = (id: number, guard: Set<number>): Mat4 => {
    const hit = out.get(id);
    if (hit) return hit;
    const o = byId.get(id);
    if (!o) return new Mat4();
    // A cycle in a hand-edited or damaged document would otherwise recurse
    // forever; treat the object as its own root and carry on.
    if (guard.has(id)) return localOf(o);
    guard.add(id);
    const local = localOf(o);
    const world = o.parent !== null && byId.has(o.parent)
      ? resolve(o.parent, guard).multiply(local)
      : local;
    out.set(id, world);
    return world;
  };
  for (const o of doc.objects) resolve(o.id, new Set());
  return out;
}

/** How far a rebuilt transform may sit from the one it is replacing. */
const PLACEMENT_TOLERANCE = 1e-4;

/**
 * Write a world-space placement into position/rotation/scale, and say so when
 * it does not fit.
 *
 * Those three cannot express every affine transform. A rotated child of a
 * non-uniformly scaled parent is sheared, and no combination of a position, an
 * euler rotation and three axis scales reproduces shear. When such an object is
 * lifted out from under its parent there is no exact answer available, so the
 * closest one is written and the shortfall is reported — rather than a wrong
 * placement applied in silence, which is the only other option and the worse
 * one.
 *
 * Returns null when the placement went in exactly, which is the ordinary case.
 */
function placeExactly(
  world: Mat4,
  name: string,
  write: (p: Vec3, r: Vec3, sc: Vec3) => void,
): string | null {
  const { position, rotation, scale } = decomposeMatrix(world);
  write(position, rotation, scale);
  const rebuilt = Mat4.compose(position, rotation, scale);
  const size = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1);
  let worst = 0;
  for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(rebuilt.m[i] - world.m[i]));
  if (worst <= PLACEMENT_TOLERANCE * size) return null;
  return `"${name}" was lifted off a part that is no longer there. Its parent's scale and `
    + 'rotation combined into a shear, which position, rotation and scale cannot hold between '
    + 'them, so it has been placed as closely as they can — worth checking.';
}

/**
 * Make a document that was assembled out of pieces into a coherent one.
 *
 * Three things can be wrong with such a document, and all three used to be:
 *
 *   - An object's parent is not in it. The old code set `parent = null` and
 *     stopped there, which keeps the object's *local* transform and so moves
 *     it: a detail modelled onto a part sitting two metres up dropped to the
 *     floor, and on a rotated or scaled parent it also turned and resized.
 *     Surviving the reconstruction is not the same as surviving it intact.
 *   - Links are one-way. A restored parent's `children` list was filtered to
 *     the objects restored beside it, so a survivor still naming that parent
 *     was not named back — an object simultaneously in the hierarchy and not
 *     in it, which the outliner and every world-space walk disagree about.
 *   - An id appears twice, or an object is its own ancestor.
 *
 * `wasAt` gives the world placement each object should end up keeping. An
 * object whose parent survives is left alone: following a parent is what
 * parenting is for, and a bolt attached to a bracket should go back with the
 * bracket rather than hang in the air where the bracket used to be. Only an
 * object being *lifted* — its parent is gone — has a placement to preserve,
 * and it is preserved against the world.
 *
 * Returns anything that could not be done exactly, for the caller to say out
 * loud rather than leave for somebody to notice.
 */
function stitch(
  objects: SerializedObject[],
  wasAt: Map<number, Mat4>,
): { objects: SerializedObject[]; warnings: string[] } {
  const warnings: string[] = [];

  // One entry per id, first occurrence winning. Two objects sharing an id is
  // not a hierarchy problem that can be repaired — it is two different objects
  // — but it must not reach the scene, where the second would shadow the first.
  const byId = new Map<number, SerializedObject>();
  for (const o of objects) if (!byId.has(o.id)) byId.set(o.id, o);
  const kept = [...byId.values()];

  // Lift anything whose parent did not come through, keeping where it is.
  for (const o of kept) {
    if (o.parent === null || byId.has(o.parent)) continue;
    o.parent = null;
    const world = wasAt.get(o.id);
    if (!world) continue;
    const trouble = placeExactly(world, o.name, (position, rotation, scale) => {
      o.position = [position.x, position.y, position.z];
      o.rotation = [rotation.x, rotation.y, rotation.z];
      o.scale = [scale.x, scale.y, scale.z];
    });
    if (trouble) warnings.push(trouble);
  }

  // Both directions of every link agree, or the link is not there.
  for (const o of kept) {
    const seen = new Set<number>();
    o.children = o.children.filter((c) => {
      if (seen.has(c) || c === o.id) return false;
      const child = byId.get(c);
      if (!child || child.parent !== o.id) return false;
      seen.add(c);
      return true;
    });
  }
  for (const o of kept) {
    if (o.parent === null) continue;
    const parent = byId.get(o.parent);
    if (!parent) continue;
    if (!parent.children.includes(o.id)) parent.children.push(o.id);
  }

  // A cycle survives every check above — each link is reciprocal and every
  // parent is present — and hangs the first walk that trusts it.
  for (const o of kept) {
    const seen = new Set<number>([o.id]);
    let at = o.parent;
    while (at !== null) {
      if (seen.has(at)) {
        const parent = byId.get(o.parent!);
        if (parent) parent.children = parent.children.filter((c) => c !== o.id);
        o.parent = null;
        warnings.push(`"${o.name}" was parented in a loop and has been lifted to the top level.`);
        break;
      }
      seen.add(at);
      at = byId.get(at)?.parent ?? null;
    }
  }

  return { objects: kept, warnings };
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
