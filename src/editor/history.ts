import { SerializedScene } from '../scene/Scene';
import { SelectMode } from '../render/Renderer';

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
 * Snapshot-based undo. Whole-scene snapshots trade memory for absolute
 * correctness — every operator, however exotic, is undoable without writing a
 * matching inverse.
 */
export class History {
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];

  constructor(public limit = 64) {}

  /** Record the state *before* an edit. */
  push(snapshot: EditorSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
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

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
