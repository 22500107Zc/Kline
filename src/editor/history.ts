import { Mesh } from '../mesh/Mesh';
import { SerializedObject, SerializedScene } from '../scene/Scene';
import { SelectMode } from '../render/Renderer';

export type SerializedMesh = ReturnType<Mesh['toJSON']>;

export interface EditorSnapshot {
  label: string;
  scene: SerializedScene;
  mode: 'object' | 'edit' | 'sculpt';
  editObject: number | null;
  selectMode: SelectMode;
  verts: number[];
  edges: number[];
  faces: number[];
}

/**
 * Serialized mesh data, shared between snapshots.
 *
 * Snapshot undo is worth keeping — it makes every operator undoable without
 * writing a matching inverse for each one — but copying every mesh in the
 * scene on every edit is not. Editing one object in a scene of twenty used to
 * copy all twenty, and sixty-four times over as the history filled up.
 *
 * A mesh's serialized form only changes when the mesh does, and `revision`
 * already tracks that. So serialize once per revision and let every snapshot
 * point at the same frozen blob: work becomes proportional to what the edit
 * touched, and an untouched mesh costs one copy no matter how deep the history
 * goes. Sharing is safe because nothing mutates a blob — `Mesh.fromJSON`
 * rebuilds every array on the way back out.
 */
export class SnapshotStore {
  private byMesh = new WeakMap<Mesh, { revision: number; data: SerializedMesh }>();
  private bytes = new WeakMap<object, number>();

  serialize(mesh: Mesh): SerializedMesh {
    const hit = this.byMesh.get(mesh);
    if (hit && hit.revision === mesh.revision) return hit.data;
    const data = mesh.toJSON();
    this.byMesh.set(mesh, { revision: mesh.revision, data });
    this.bytes.set(data, estimateMeshBytes(data));
    return data;
  }

  /** Roughly how much memory a shared blob holds, for the history budget. */
  sizeOf(data: object): number {
    return this.bytes.get(data) ?? 0;
  }
}

function estimateMeshBytes(d: SerializedMesh): number {
  let n = d.positions.length * 8;
  for (const f of d.faces) n += f.length * 8 + 32;
  n += d.faceMaterial.length * 8;
  if (d.faceSmooth) n += d.faceSmooth.length;
  if (d.faceUV) for (const uv of d.faceUV) if (uv) n += uv.length * 8 + 32;
  if (d.seams) n += d.seams.length * 24;
  if (d.edgeWeights) n += d.edgeWeights.length * 32;
  return n;
}

/**
 * Snapshot-based undo, bounded by memory rather than by a step count alone.
 *
 * A count on its own is the wrong limit: sixty-four steps of moving a cube is
 * nothing, and sixty-four steps on a subdivided character is hundreds of
 * megabytes. Both limits apply, and the memory one counts each shared blob
 * once however many snapshots reference it.
 */
export class History {
  readonly store = new SnapshotStore();
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];

  constructor(public limit = 64, public budgetBytes = 256 * 1024 * 1024) {}

  /** Record the state *before* an edit. */
  push(snapshot: EditorSnapshot): void {
    this.undoStack.push(snapshot);
    this.redoStack.length = 0;
    while (this.undoStack.length > this.limit) this.undoStack.shift();
    // Always keep one step: undoing the thing you just did matters more than
    // the budget, and a single snapshot over budget is the user's own scene.
    while (this.undoStack.length > 1 && this.footprint() > this.budgetBytes) {
      this.undoStack.shift();
    }
  }

  /** Bytes held by the history, counting each shared mesh blob once. */
  footprint(): number {
    const seen = new Set<object>();
    let total = 0;
    for (const stack of [this.undoStack, this.redoStack]) {
      for (const snap of stack) {
        for (const o of snap.scene.objects as SerializedObject[]) {
          if (!o.mesh || seen.has(o.mesh)) continue;
          seen.add(o.mesh);
          total += this.store.sizeOf(o.mesh);
        }
      }
    }
    return total;
  }

  undo(current: EditorSnapshot): EditorSnapshot | null {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(current);
    return s;
  }

  redo(current: EditorSnapshot): EditorSnapshot | null {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(current);
    return s;
  }

  get depth(): number {
    return this.undoStack.length;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get nextUndoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? '';
  }
  get nextRedoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.label ?? '';
  }

  /**
   * The recorded steps, newest last, for anything that wants to look back
   * rather than travel back.
   *
   * Comparing against an earlier version needs to *read* a snapshot without
   * unwinding to it, which undo cannot do — it pops. The scenes handed out
   * here are the stored ones, so callers must treat them as read-only.
   */
  steps(): { index: number; label: string; scene: SerializedScene }[] {
    return this.undoStack.map((s, index) => ({ index, label: s.label, scene: s.scene }));
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
