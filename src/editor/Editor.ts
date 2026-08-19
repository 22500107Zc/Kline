import { AABB, DEG2RAD, Mat4, Vec3, decomposeMatrix } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { PrimitiveKind, buildPrimitive } from '../mesh/primitives';
import { Renderer, SelectMode, ShadingMode, LineSegment, THEME, ViewportOptions } from '../render/Renderer';
import { LightType, Scene, SceneObject, SerializedScene } from '../scene/Scene';
import { ViewportCamera } from '../scene/ViewportCamera';
import { createMaterial } from '../scene/Material';
import { History, EditorSnapshot } from './history';
import { TransformKind, TransformSession } from './transform';
import {
  Rect, boxSelectElements, boxSelectObjects, normalizeRect, pickElement, pickObject, raycastGround,
} from './picking';
import { edgeRing, insetFaces, loopCut } from '../mesh/ops';

export type EditorMode = 'object' | 'edit';
export type PivotMode = 'median' | 'cursor';

export interface ElementSelection {
  verts: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
}

interface TransformSnapshot {
  verts: { index: number; position: Vec3 }[] | null;
  objects: { id: number; world: Mat4; parentInverse: Mat4 }[] | null;
}

type Modal =
  | { type: 'transform'; session: TransformSession; snapshot: TransformSnapshot }
  | { type: 'inset'; baseline: Mesh; faces: number[]; startX: number; startY: number; thickness: number; depth: number }
  | { type: 'loopcut'; edge: number | null; cuts: number }
  | { type: 'box'; rect: Rect; extend: boolean; subtract: boolean };

export type EditorEvent = 'change' | 'status' | 'modal';

/**
 * The application controller: owns the scene, the viewport camera, input
 * handling, the operator/undo plumbing and the render loop. The UI layer only
 * reads state from here and calls commands.
 */
export class Editor {
  readonly scene = new Scene();
  readonly camera = new ViewportCamera();
  readonly renderer: Renderer;
  readonly history = new History();

  mode: EditorMode = 'object';
  editObjectId: number | null = null;
  selectMode: SelectMode = 'vertex';
  selection: ElementSelection = { verts: new Set(), edges: new Set(), faces: new Set() };
  selectionVersion = 0;
  pivotMode: PivotMode = 'median';
  statusMessage = '';

  options: ViewportOptions = {
    shading: 'solid',
    showGrid: true,
    showOverlays: true,
    showObjectWireframe: false,
    showOrigins: true,
    xray: false,
    backfaceCulling: false,
  };

  private modal: Modal | null = null;
  private listeners = new Map<EditorEvent, Set<() => void>>();
  private needsRender = true;
  private running = false;
  private pointer = { x: 0, y: 0, down: false, button: -1, startX: 0, startY: 0, dragging: false };
  private keys = { shift: false, ctrl: false, alt: false };
  private hoverPreview: LineSegment[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.buildDefaultScene();
    this.attachEvents();
  }

  // ---------------------------------------------------------------- lifecycle

  private buildDefaultScene(): void {
    const s = this.scene;
    s.materials.push(createMaterial({ name: 'Material', color: [0.75, 0.75, 0.78] }));

    const cube = s.add('mesh', 'Cube', buildPrimitive('cube'));
    cube.position = new Vec3(0, 0, 1);

    const light = s.add('light', 'Light');
    light.position = new Vec3(4.08, 1.01, 5.9);
    if (light.light) light.light.energy = 1000;

    const cam = s.add('camera', 'Camera');
    cam.position = new Vec3(7.36, -6.93, 4.96);
    cam.rotation = new Vec3(63.6 * DEG2RAD, 0, 46.7 * DEG2RAD);

    s.selection = new Set([cube.id]);
    s.active = cube.id;
    this.camera.target = new Vec3(0, 0, 1);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => {
      if (!this.running) return;
      if (this.needsRender || this.renderer.resize()) {
        this.needsRender = false;
        this.renderer.render({
          scene: this.scene,
          camera: this.camera,
          options: this.options,
          edit: this.editOverlay(),
          lines: this.overlayLines(),
        });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  requestRender(): void {
    this.needsRender = true;
  }

  on(event: EditorEvent, fn: () => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }

  emit(event: EditorEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  private changed(): void {
    this.requestRender();
    this.emit('change');
  }

  setStatus(msg: string): void {
    this.statusMessage = msg;
    this.emit('status');
  }

  // ------------------------------------------------------------------- state

  get editObject(): SceneObject | null {
    return this.mode === 'edit' ? this.scene.get(this.editObjectId) : null;
  }

  get editMesh(): Mesh | null {
    return this.editObject?.mesh ?? null;
  }

  get modalLabel(): string | null {
    if (!this.modal) return null;
    switch (this.modal.type) {
      case 'transform': return this.modal.session.header();
      case 'inset': return `Inset ${this.modal.thickness.toFixed(4)} (depth ${this.modal.depth.toFixed(3)})`;
      case 'loopcut': return `Loop Cut — ${this.modal.cuts} cut${this.modal.cuts === 1 ? '' : 's'} (scroll to change, click to confirm)`;
      case 'box': return 'Box Select';
    }
  }

  get isModal(): boolean {
    return this.modal !== null;
  }

  /** The running transform session, for operators that want to constrain it. */
  get currentTransform(): TransformSession | null {
    return this.modal?.type === 'transform' ? this.modal.session : null;
  }

  /** Re-apply the running transform (after changing its constraint). */
  refreshTransform(): void {
    if (this.modal?.type !== 'transform') return;
    this.applyTransform(this.modal.session.update(this.pointer.x, this.pointer.y));
  }

  get boxSelectRect(): Rect | null {
    return this.modal?.type === 'box' ? normalizeRect(this.modal.rect) : null;
  }

  private editOverlay() {
    const obj = this.editObject;
    if (!obj) return null;
    return {
      objectId: obj.id,
      selectMode: this.selectMode,
      verts: this.selection.verts,
      edges: this.selection.edges,
      faces: this.selection.faces,
      version: this.selectionVersion,
    };
  }

  private viewport(): { width: number; height: number } {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  // --------------------------------------------------------------- selection

  bumpSelection(): void {
    this.selectionVersion++;
    this.requestRender();
    this.emit('change');
  }

  clearElementSelection(): void {
    this.selection.verts.clear();
    this.selection.edges.clear();
    this.selection.faces.clear();
    this.bumpSelection();
  }

  /** Vertices are canonical; edges and faces are derived from them. */
  recomputeDerivedSelection(): void {
    const mesh = this.editMesh;
    if (!mesh) return;
    const verts = this.selection.verts;
    const t = mesh.topology();
    this.selection.edges = new Set();
    for (let e = 0; e < t.edges.length; e++) {
      const rec = t.edges[e];
      if (verts.has(rec.a) && verts.has(rec.b)) this.selection.edges.add(e);
    }
    this.selection.faces = new Set();
    for (let f = 0; f < mesh.faces.length; f++) {
      if (mesh.faces[f].every((v) => verts.has(v))) this.selection.faces.add(f);
    }
    this.bumpSelection();
  }

  setSelectMode(mode: SelectMode): void {
    this.selectMode = mode;
    this.recomputeDerivedSelection();
    this.setStatus(`${mode[0].toUpperCase()}${mode.slice(1)} select`);
  }

  selectedVertList(): number[] {
    return [...this.selection.verts];
  }

  /** Vertices that a transform should move, taking the select mode into account. */
  transformVerts(): number[] {
    return [...this.selection.verts];
  }

  selectAll(): void {
    if (this.mode === 'edit') {
      const mesh = this.editMesh;
      if (!mesh) return;
      this.selection.verts = new Set(mesh.positions.map((_, i) => i));
      this.recomputeDerivedSelection();
    } else {
      this.scene.selection = new Set(
        [...this.scene.objects.values()].filter((o) => o.visible && !o.locked).map((o) => o.id),
      );
      if (this.scene.active === null) this.scene.active = [...this.scene.selection][0] ?? null;
      this.changed();
    }
  }

  deselectAll(): void {
    if (this.mode === 'edit') this.clearElementSelection();
    else {
      this.scene.selection.clear();
      this.changed();
    }
  }

  invertSelection(): void {
    if (this.mode === 'edit') {
      const mesh = this.editMesh;
      if (!mesh) return;
      const next = new Set<number>();
      for (let i = 0; i < mesh.positions.length; i++) if (!this.selection.verts.has(i)) next.add(i);
      this.selection.verts = next;
      this.recomputeDerivedSelection();
    } else {
      const next = new Set<number>();
      for (const o of this.scene.objects.values()) if (!this.scene.selection.has(o.id)) next.add(o.id);
      this.scene.selection = next;
      this.changed();
    }
  }

  selectObject(id: number | null, extend = false): void {
    if (!extend) this.scene.selection.clear();
    if (id !== null) {
      if (extend && this.scene.selection.has(id)) this.scene.selection.delete(id);
      else this.scene.selection.add(id);
      this.scene.active = this.scene.selection.has(id) ? id : null;
    } else {
      this.scene.active = null;
    }
    this.changed();
  }

  private selectElementAt(x: number, y: number, extend: boolean): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) return;
    const model = obj.worldMatrix(this.scene);
    const hit = pickElement(mesh, model, this.camera, x, y, this.viewport(), this.selectMode, {
      xray: this.options.xray,
      radius: 14,
    });
    if (hit === null) {
      if (!extend) this.clearElementSelection();
      return;
    }
    const verts = this.vertsOfElement(mesh, hit);
    if (!extend) this.selection.verts.clear();
    const allSelected = verts.every((v) => this.selection.verts.has(v));
    if (extend && allSelected) for (const v of verts) this.selection.verts.delete(v);
    else for (const v of verts) this.selection.verts.add(v);
    this.recomputeDerivedSelection();
  }

  private vertsOfElement(mesh: Mesh, index: number): number[] {
    if (this.selectMode === 'vertex') return [index];
    if (this.selectMode === 'edge') {
      const e = mesh.topology().edges[index];
      return e ? [e.a, e.b] : [];
    }
    return mesh.faces[index] ?? [];
  }

  /** Grow the selection along an edge loop (Alt+click). */
  selectLoopAt(x: number, y: number, extend: boolean): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) return;
    const model = obj.worldMatrix(this.scene);
    const hit = pickElement(mesh, model, this.camera, x, y, this.viewport(), 'edge', {
      xray: this.options.xray, radius: 18,
    });
    if (hit === null) return;
    const t = mesh.topology();
    const ring = edgeRing(mesh, hit);
    if (!extend) this.selection.verts.clear();
    for (const ei of ring.edges) {
      const e = t.edges[ei];
      this.selection.verts.add(e.a);
      this.selection.verts.add(e.b);
    }
    this.recomputeDerivedSelection();
    this.setStatus(`Selected edge ring (${ring.edges.length} edges)`);
  }

  // ----------------------------------------------------------------- history

  snapshot(label: string): EditorSnapshot {
    return {
      label,
      scene: this.scene.toJSON(),
      mode: this.mode,
      editObject: this.editObjectId,
      selectMode: this.selectMode,
      verts: [...this.selection.verts],
      edges: [...this.selection.edges],
      faces: [...this.selection.faces],
    };
  }

  /** Record the pre-edit state so the next operation is undoable. */
  beginUndo(label: string): void {
    this.history.push(this.snapshot(label));
  }

  private restore(s: EditorSnapshot): void {
    const restored = Scene.fromJSON(s.scene);
    this.scene.objects = restored.objects;
    this.scene.order = restored.order;
    this.scene.materials = restored.materials;
    this.scene.world = restored.world;
    this.scene.cursor = restored.cursor;
    this.scene.selection = restored.selection;
    this.scene.active = restored.active;
    this.mode = s.mode;
    this.editObjectId = s.editObject;
    this.selectMode = s.selectMode;
    this.selection = { verts: new Set(s.verts), edges: new Set(s.edges), faces: new Set(s.faces) };
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.bumpSelection();
    this.changed();
  }

  /** Replace the whole scene from a parsed .kiln document. */
  loadSceneJSON(data: SerializedScene): void {
    const restored = Scene.fromJSON(data);
    this.history.clear();
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.scene.objects = restored.objects;
    this.scene.order = restored.order;
    this.scene.materials = restored.materials;
    this.scene.world = restored.world;
    this.scene.cursor = restored.cursor;
    this.scene.selection = restored.selection;
    this.scene.active = restored.active;
    this.mode = 'object';
    this.editObjectId = null;
    this.clearElementSelection();
    this.frameAll();
    this.changed();
  }

  undo(): void {
    const s = this.history.undo(this.snapshot('redo'));
    if (!s) {
      this.setStatus('Nothing to undo');
      return;
    }
    this.setStatus(`Undo: ${s.label}`);
    this.restore(s);
  }

  redo(): void {
    const s = this.history.redo(this.snapshot('undo'));
    if (!s) {
      this.setStatus('Nothing to redo');
      return;
    }
    this.setStatus(`Redo: ${s.label}`);
    this.restore(s);
  }

  /** Call after mutating an object's geometry so caches refresh. */
  markGeometryDirty(obj: SceneObject): void {
    obj.mesh?.markDirty();
    obj.invalidate();
    this.renderer.invalidate(obj.id);
    this.changed();
  }

  // -------------------------------------------------------------- mode & add

  toggleEditMode(): void {
    if (this.mode === 'object') {
      const obj = this.scene.activeObject;
      if (!obj || obj.type !== 'mesh' || !obj.mesh) {
        this.setStatus('Select a mesh object to edit');
        return;
      }
      this.mode = 'edit';
      this.editObjectId = obj.id;
      this.clearElementSelection();
      this.setStatus(`Edit Mode — ${obj.name}`);
    } else {
      this.mode = 'object';
      this.editObjectId = null;
      this.setStatus('Object Mode');
    }
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.changed();
  }

  addPrimitive(kind: PrimitiveKind): SceneObject {
    this.beginUndo(`Add ${kind}`);
    const label = kind[0].toUpperCase() + kind.slice(1);
    const obj = this.scene.add('mesh', label, buildPrimitive(kind));
    obj.position = this.scene.cursor.clone();
    this.selectObject(obj.id);
    this.setStatus(`Added ${obj.name}`);
    return obj;
  }

  addLight(type: LightType): SceneObject {
    this.beginUndo('Add light');
    const obj = this.scene.add('light', type[0].toUpperCase() + type.slice(1));
    if (obj.light) obj.light.type = type;
    obj.position = this.scene.cursor.add(new Vec3(0, 0, 3));
    this.selectObject(obj.id);
    return obj;
  }

  addCamera(): SceneObject {
    this.beginUndo('Add camera');
    const obj = this.scene.add('camera', 'Camera');
    obj.position = this.camera.eye();
    const f = this.camera.forward();
    obj.rotation = new Vec3(Math.acos(-f.z), 0, Math.atan2(f.y, f.x) + Math.PI / 2);
    this.selectObject(obj.id);
    return obj;
  }

  addEmpty(): SceneObject {
    this.beginUndo('Add empty');
    const obj = this.scene.add('empty', 'Empty');
    obj.position = this.scene.cursor.clone();
    this.selectObject(obj.id);
    return obj;
  }

  // ------------------------------------------------------------------ modals

  /**
   * Begin a modal transform. Compound operators (extrude, duplicate) push their
   * own undo step first and pass `pushUndo = false`, so cancelling rolls back
   * the whole operation rather than just the move.
   */
  startTransform(kind: TransformKind, axis: number | null = null, pushUndo = true): void {
    const pivot = this.transformPivot();
    if (!pivot) {
      this.setStatus('Nothing selected');
      return;
    }
    const snapshot = this.captureTransform();
    if (!snapshot) return;
    if (pushUndo) {
      this.beginUndo(kind === 'translate' ? 'Move' : kind === 'rotate' ? 'Rotate' : 'Scale');
    }
    const session = new TransformSession(
      kind, pivot, this.camera, this.viewport(), this.pointer.x, this.pointer.y,
    );
    if (axis !== null) session.setAxis(axis);
    session.setModifiers({ precision: this.keys.shift, snap: this.keys.ctrl });
    this.modal = { type: 'transform', session, snapshot };
    this.applyTransform(session.update(this.pointer.x, this.pointer.y));
    this.emit('modal');
  }

  private transformPivot(): Vec3 | null {
    if (this.pivotMode === 'cursor') return this.scene.cursor.clone();
    if (this.mode === 'edit') {
      const obj = this.editObject;
      const mesh = this.editMesh;
      if (!obj || !mesh || this.selection.verts.size === 0) return null;
      const model = obj.worldMatrix(this.scene);
      const c = new Vec3();
      for (const v of this.selection.verts) c.addInPlace(model.transformPoint(mesh.positions[v]));
      return c.scale(1 / this.selection.verts.size);
    }
    const objs = this.scene.selectedObjects();
    if (objs.length === 0) return null;
    const c = new Vec3();
    for (const o of objs) c.addInPlace(o.worldMatrix(this.scene).transformPoint(new Vec3()));
    return c.scale(1 / objs.length);
  }

  private captureTransform(): TransformSnapshot | null {
    if (this.mode === 'edit') {
      const mesh = this.editMesh;
      if (!mesh || this.selection.verts.size === 0) return null;
      return {
        verts: [...this.selection.verts].map((index) => ({ index, position: mesh.positions[index].clone() })),
        objects: null,
      };
    }
    const objs = this.scene.selectedObjects();
    if (objs.length === 0) return null;
    return {
      verts: null,
      objects: objs.map((o) => ({
        id: o.id,
        world: o.worldMatrix(this.scene),
        parentInverse: o.parent !== null
          ? (this.scene.get(o.parent)?.worldMatrix(this.scene) ?? Mat4.identity()).inverse()
          : Mat4.identity(),
      })),
    };
  }

  private applyTransform(matrix: Mat4): void {
    if (this.modal?.type !== 'transform') return;
    const snap = this.modal.snapshot;
    if (snap.verts) {
      const obj = this.editObject;
      const mesh = this.editMesh;
      if (!obj || !mesh) return;
      const model = obj.worldMatrix(this.scene);
      const toLocal = model.inverse();
      for (const v of snap.verts) {
        const world = model.transformPoint(v.position);
        mesh.positions[v.index] = toLocal.transformPoint(matrix.transformPoint(world));
      }
      this.markGeometryDirty(obj);
    } else if (snap.objects) {
      for (const item of snap.objects) {
        const obj = this.scene.get(item.id);
        if (!obj) continue;
        const local = item.parentInverse.multiply(matrix.multiply(item.world));
        const d = decomposeMatrix(local);
        obj.position = d.position;
        obj.rotation = d.rotation;
        obj.scale = d.scale;
      }
      this.changed();
    }
    this.emit('modal');
  }

  startInset(): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh || this.selection.faces.size === 0) {
      this.setStatus('Inset needs a face selection');
      return;
    }
    this.beginUndo('Inset');
    this.modal = {
      type: 'inset',
      baseline: mesh.clone(),
      faces: [...this.selection.faces],
      startX: this.pointer.x,
      startY: this.pointer.y,
      thickness: 0,
      depth: 0,
    };
    this.emit('modal');
  }

  private updateInset(x: number, y: number): void {
    if (this.modal?.type !== 'inset') return;
    const obj = this.editObject;
    if (!obj) return;
    const m = this.modal;
    const pivot = this.transformPivot() ?? new Vec3();
    const scale = this.camera.pixelScaleAt(pivot, this.canvas.clientHeight);
    m.thickness = Math.max(0, Math.hypot(x - m.startX, y - m.startY) * scale * (this.keys.shift ? 0.1 : 1));
    // Re-run the operator from the pristine copy each frame so it stays exact.
    const fresh = m.baseline.clone();
    const r = insetFaces(fresh, m.faces, m.thickness, m.depth);
    obj.mesh = fresh;
    this.selection.verts = new Set(r.movedVerts);
    this.recomputeDerivedSelection();
    this.markGeometryDirty(obj);
    this.emit('modal');
  }

  startLoopCut(): void {
    if (!this.editObject) {
      this.setStatus('Loop cut works in Edit Mode');
      return;
    }
    this.modal = { type: 'loopcut', edge: null, cuts: 1 };
    this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
    this.emit('modal');
  }

  private updateLoopCutPreview(x: number, y: number): void {
    if (this.modal?.type !== 'loopcut') return;
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) return;
    const model = obj.worldMatrix(this.scene);
    const hit = pickElement(mesh, model, this.camera, x, y, this.viewport(), 'edge', {
      xray: true, radius: 100,
    });
    this.modal.edge = hit;
    this.hoverPreview = [];
    if (hit === null) return;
    const ring = edgeRing(mesh, hit);
    const t = mesh.topology();
    const cuts = this.modal.cuts;
    for (let k = 0; k < cuts; k++) {
      const p = (k + 1) / (cuts + 1);
      const pts: Vec3[] = [];
      for (const ei of ring.edges) {
        const e = t.edges[ei];
        pts.push(model.transformPoint(mesh.positions[e.a].lerp(mesh.positions[e.b], p)));
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        this.hoverPreview.push({ a: pts[i], b: pts[i + 1], color: [1, 0.85, 0.2], overlay: true });
      }
      if (ring.cyclic && pts.length > 2) {
        this.hoverPreview.push({ a: pts[pts.length - 1], b: pts[0], color: [1, 0.85, 0.2], overlay: true });
      }
    }
    this.requestRender();
  }

  private confirmLoopCut(): void {
    if (this.modal?.type !== 'loopcut') return;
    const obj = this.editObject;
    const mesh = this.editMesh;
    const edge = this.modal.edge;
    const cuts = this.modal.cuts;
    this.modal = null;
    this.hoverPreview = [];
    if (!obj || !mesh || edge === null) {
      this.setStatus('Loop cut cancelled');
      this.emit('modal');
      return;
    }
    this.beginUndo('Loop Cut');
    const r = loopCut(mesh, edge, cuts);
    this.selection.verts = new Set(r.newVerts);
    this.recomputeDerivedSelection();
    this.markGeometryDirty(obj);
    this.setStatus(`Loop cut: ${cuts} loop${cuts === 1 ? '' : 's'} inserted`);
    this.emit('modal');
  }

  confirmModal(): void {
    if (!this.modal) return;
    switch (this.modal.type) {
      case 'transform':
        this.setStatus(this.modal.session.header());
        this.modal = null;
        break;
      case 'inset':
        this.setStatus(`Inset ${this.modal.thickness.toFixed(4)}`);
        this.modal = null;
        break;
      case 'loopcut':
        this.confirmLoopCut();
        return;
      case 'box':
        this.applyBoxSelect();
        this.modal = null;
        break;
    }
    this.emit('modal');
    this.changed();
  }

  cancelModal(): void {
    if (!this.modal) return;
    const m = this.modal;
    this.modal = null;
    this.hoverPreview = [];
    if (m.type === 'transform' || m.type === 'inset') {
      // Undo restores the pre-modal snapshot that beginUndo pushed.
      const s = this.history.undo(this.snapshot('cancelled'));
      if (s) this.restore(s);
      this.setStatus('Cancelled');
    }
    this.emit('modal');
    this.changed();
  }

  private applyBoxSelect(): void {
    if (this.modal?.type !== 'box') return;
    const rect = normalizeRect(this.modal.rect);
    if (Math.abs(rect.x1 - rect.x0) < 3 && Math.abs(rect.y1 - rect.y0) < 3) return;
    const extend = this.modal.extend;
    const subtract = this.modal.subtract;
    if (this.mode === 'edit') {
      const obj = this.editObject;
      const mesh = this.editMesh;
      if (!obj || !mesh) return;
      const hits = boxSelectElements(
        mesh, obj.worldMatrix(this.scene), this.camera, rect, this.viewport(),
        this.selectMode, this.options.xray,
      );
      if (!extend && !subtract) this.selection.verts.clear();
      for (const h of hits) {
        for (const v of this.vertsOfElement(mesh, h)) {
          if (subtract) this.selection.verts.delete(v);
          else this.selection.verts.add(v);
        }
      }
      this.recomputeDerivedSelection();
    } else {
      const hits = boxSelectObjects(this.scene, this.camera, rect, this.viewport());
      if (!extend && !subtract) this.scene.selection.clear();
      for (const id of hits) {
        if (subtract) this.scene.selection.delete(id);
        else this.scene.selection.add(id);
      }
      if (this.scene.active === null || !this.scene.selection.has(this.scene.active)) {
        this.scene.active = [...this.scene.selection][0] ?? null;
      }
      this.changed();
    }
  }

  // ------------------------------------------------------------------- views

  frameSelected(): void {
    let box: AABB;
    if (this.mode === 'edit' && this.editObject && this.editMesh && this.selection.verts.size) {
      box = new AABB();
      const model = this.editObject.worldMatrix(this.scene);
      for (const v of this.selection.verts) box.expand(model.transformPoint(this.editMesh.positions[v]));
    } else {
      box = this.scene.bounds(this.scene.selection.size > 0);
    }
    if (!box.valid) box = this.scene.bounds(false);
    this.camera.frame(box);
    this.requestRender();
  }

  frameAll(): void {
    this.camera.frame(this.scene.bounds(false));
    this.requestRender();
  }

  setShading(mode: ShadingMode): void {
    this.options.shading = mode;
    this.changed();
  }

  cycleShading(): void {
    const order: ShadingMode[] = ['solid', 'material', 'wireframe'];
    this.setShading(order[(order.indexOf(this.options.shading) + 1) % order.length]);
    this.setStatus(`Shading: ${this.options.shading}`);
  }

  private overlayLines(): LineSegment[] {
    const lines: LineSegment[] = [...this.hoverPreview];
    if (this.modal?.type === 'transform') {
      const s = this.modal.session;
      if (s.axis !== null && !s.plane) {
        const color = [THEME.axisX, THEME.axisY, THEME.axisZ][s.axis];
        const dir = Vec3.axis(s.axis).scale(1000);
        lines.push({ a: s.pivot.sub(dir), b: s.pivot.add(dir), color, overlay: true });
      }
    }
    return lines;
  }

  // ------------------------------------------------------------------- input

  private attachEvents(): void {
    const c = this.canvas;
    c.tabIndex = 0;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.requestRender()).observe(c);
  }

  private localPointer(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.localPointer(e);
    this.pointer = { x: p.x, y: p.y, down: true, button: e.button, startX: p.x, startY: p.y, dragging: false };
    this.syncModifierKeys(e);
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);

    if (this.modal) {
      if (e.button === 0) this.confirmModal();
      else if (e.button === 2) this.cancelModal();
      return;
    }
    if (e.button === 2 && e.shiftKey) {
      const hit = raycastGround(this.camera, p.x, p.y, this.viewport());
      if (hit) {
        this.beginUndo('Move 3D cursor');
        this.scene.cursor = hit;
        this.changed();
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.localPointer(e);
    const dx = p.x - this.pointer.x;
    const dy = p.y - this.pointer.y;
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.syncModifierKeys(e);

    if (this.modal) {
      switch (this.modal.type) {
        case 'transform':
          this.modal.session.setModifiers({ precision: e.shiftKey, snap: e.ctrlKey });
          this.applyTransform(this.modal.session.update(p.x, p.y));
          break;
        case 'inset':
          this.updateInset(p.x, p.y);
          break;
        case 'loopcut':
          this.updateLoopCutPreview(p.x, p.y);
          break;
        case 'box':
          this.modal.rect.x1 = p.x;
          this.modal.rect.y1 = p.y;
          this.emit('modal');
          this.requestRender();
          break;
      }
      return;
    }

    if (!this.pointer.down) return;
    const moved = Math.hypot(p.x - this.pointer.startX, p.y - this.pointer.startY);
    if (moved > 3) this.pointer.dragging = true;

    if (this.pointer.button === 1) {
      if (e.shiftKey) this.camera.pan(dx, dy, this.canvas.clientHeight);
      else if (e.ctrlKey) this.camera.zoom(-dy * 0.02);
      else this.camera.orbit(dx * 0.008, dy * 0.008);
      this.requestRender();
    } else if (this.pointer.button === 0 && this.pointer.dragging) {
      this.modal = {
        type: 'box',
        rect: { x0: this.pointer.startX, y0: this.pointer.startY, x1: p.x, y1: p.y },
        extend: e.shiftKey,
        subtract: e.ctrlKey,
      };
      this.emit('modal');
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const wasDown = this.pointer.down;
    const dragging = this.pointer.dragging;
    this.pointer.down = false;
    this.pointer.dragging = false;
    if (this.modal?.type === 'box') {
      this.applyBoxSelect();
      this.modal = null;
      this.emit('modal');
      this.requestRender();
      return;
    }
    if (!wasDown || dragging || e.button !== 0) return;

    const p = this.localPointer(e);
    if (this.mode === 'edit') {
      if (e.altKey) this.selectLoopAt(p.x, p.y, e.shiftKey);
      else this.selectElementAt(p.x, p.y, e.shiftKey);
    } else {
      const hit = pickObject(this.scene, this.camera, p.x, p.y, this.viewport());
      this.selectObject(hit ? hit.object.id : null, e.shiftKey);
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (this.modal?.type === 'loopcut') {
      this.modal.cuts = Math.max(1, Math.min(64, this.modal.cuts + (e.deltaY < 0 ? 1 : -1)));
      this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
      this.emit('modal');
      return;
    }
    this.camera.zoom(e.deltaY < 0 ? 1 : -1);
    this.requestRender();
  }

  private syncModifierKeys(e: PointerEvent | KeyboardEvent | WheelEvent): void {
    this.keys.shift = e.shiftKey;
    this.keys.ctrl = e.ctrlKey || e.metaKey;
    this.keys.alt = e.altKey;
  }

  /** Feed a keyboard event from the document. Returns true when handled. */
  handleKey(e: KeyboardEvent): boolean {
    this.syncModifierKeys(e);
    if (this.modal) return this.handleModalKey(e);
    return false;
  }

  private handleModalKey(e: KeyboardEvent): boolean {
    const m = this.modal;
    if (!m) return false;
    const key = e.key;
    if (key === 'Escape') {
      this.cancelModal();
      return true;
    }
    if (key === 'Enter' || key === ' ') {
      this.confirmModal();
      return true;
    }
    if (m.type === 'transform') {
      const axisIndex = { x: 0, y: 1, z: 2 }[key.toLowerCase()];
      if (axisIndex !== undefined) {
        m.session.setAxis(axisIndex, e.shiftKey);
        this.applyTransform(m.session.update(this.pointer.x, this.pointer.y));
        return true;
      }
      if (m.session.typeChar(key === 'Backspace' ? 'Backspace' : key)) {
        this.applyTransform(m.session.update(this.pointer.x, this.pointer.y));
        return true;
      }
    }
    if (m.type === 'loopcut') {
      if (key === 'ArrowUp' || key === '+') {
        m.cuts = Math.min(64, m.cuts + 1);
        this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
        return true;
      }
      if (key === 'ArrowDown' || key === '-') {
        m.cuts = Math.max(1, m.cuts - 1);
        this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
        return true;
      }
    }
    return true; // swallow everything else while modal
  }

  get pointerPosition(): { x: number; y: number } {
    return { x: this.pointer.x, y: this.pointer.y };
  }
}
