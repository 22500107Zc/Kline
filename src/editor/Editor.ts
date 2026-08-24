import { AABB, DEG2RAD, Mat4, Vec3, decomposeMatrix, rayPlane } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { PRIMITIVES, PrimitiveKind, buildPrimitive } from '../mesh/primitives';
import { Renderer, SelectMode, ShadingMode, LineSegment, THEME, ViewportOptions } from '../render/Renderer';
import { LightType, Scene, SceneObject, SerializedScene } from '../scene/Scene';
import { ViewportCamera } from '../scene/ViewportCamera';
import { createMaterial } from '../scene/Material';
import { History, EditorSnapshot } from './history';
import { TransformKind, TransformSession } from './transform';
import {
  Rect, boxSelectElements, boxSelectObjects, normalizeRect, pickElement, pickFaceRay, pickObject,
  raycastGround,
} from './picking';
import { ElementSelection, deriveSelection, elementCount, emptySelection } from './selection';
import { edgeRing, insetFaces, loopCut } from '../mesh/ops';
import { ProportionalSettings, defaultProportional, influenceCircle, proportionalWeights } from './proportional';
import { SnapSettings, defaultSnap, snapPointUnderCursor } from './snapping';
import { SculptSettings, SculptStroke, defaultSculpt } from '../sculpt/sculpt';
import { ChannelPath, removeKey, setKey } from '../anim/animation';
import { bevelEdges } from '../mesh/bevel';
import { RenderJob } from '../render/pathtrace/RenderJob';
import { RenderSettings, defaultRenderSettings } from '../render/pathtrace/types';
import { buildTraceScene, cameraFromObject, cameraFromViewport } from '../render/pathtrace/build';
import { Preferences, defaultPreferences, loadPreferences, savePreferences, writeAutosave } from './persistence';

export type EditorMode = 'object' | 'edit' | 'sculpt';
export type PivotMode = 'median' | 'cursor';

interface TransformSnapshot {
  verts: { index: number; position: Vec3; weight: number }[] | null;
  objects: { id: number; world: Mat4; parentInverse: Mat4 }[] | null;
}

interface BevelState {
  baseline: Mesh;
  edges: number[];
  startX: number;
  startY: number;
  width: number;
  segments: number;
  profile: number;
}

type Modal =
  | { type: 'transform'; session: TransformSession; snapshot: TransformSnapshot }
  | { type: 'bevel'; state: BevelState }
  | { type: 'inset'; baseline: Mesh; faces: number[]; startX: number; startY: number; thickness: number; depth: number }
  | { type: 'loopcut'; edge: number | null; cuts: number }
  | { type: 'box'; rect: Rect; extend: boolean; subtract: boolean };

export type EditorEvent = 'change' | 'status' | 'modal' | 'render' | 'frame';

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
  selection: ElementSelection = emptySelection();
  selectionVersion = 0;
  pivotMode: PivotMode = 'median';
  statusMessage = '';
  proportional: ProportionalSettings = defaultProportional();
  snap: SnapSettings = defaultSnap();
  sculpt: SculptSettings = defaultSculpt();
  renderSettings: RenderSettings = defaultRenderSettings();
  activeRender: RenderJob | null = null;
  preferences: Preferences = defaultPreferences();
  /** Set when a mesh edit has happened since the last autosave. */
  private dirtySinceSave = false;
  private autosaveTimer: number | null = null;
  private playbackHandle: number | null = null;
  private playbackClock = 0;
  private stroke: SculptStroke | null = null;
  private strokeStart: Vec3 | null = null;
  private brushCursor: { center: Vec3; normal: Vec3; radius: number } | null = null;

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

  /** The object a sculpt stroke applies to. */
  get sculptObject(): SceneObject | null {
    if (this.mode !== 'sculpt') return null;
    const obj = this.scene.activeObject;
    return obj && obj.type === 'mesh' && obj.mesh ? obj : null;
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
      case 'bevel': {
        const b = this.modal.state;
        return `Bevel ${b.width.toFixed(4)} — ${b.segments} segment${b.segments === 1 ? '' : 's'}, profile ${b.profile.toFixed(2)} (scroll for segments)`;
      }
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

  /** The selection set the current mode edits directly. */
  private setForMode(mode: SelectMode = this.selectMode): Set<number> {
    return mode === 'vertex' ? this.selection.verts
      : mode === 'edge' ? this.selection.edges
        : this.selection.faces;
  }

  /**
   * Re-derive the passive selection sets after an edit made in `from` mode.
   * See `selection.ts` for why the authoritative set depends on the mode.
   */
  syncSelection(from: SelectMode = this.selectMode): void {
    const mesh = this.editMesh;
    if (!mesh) return;
    deriveSelection(mesh, this.selection, from);
    this.bumpSelection();
  }

  setSelectMode(mode: SelectMode): void {
    // Convert through the old mode's rules first, then hand authority over.
    this.syncSelection(this.selectMode);
    this.selectMode = mode;
    this.setStatus(`${mode[0].toUpperCase()}${mode.slice(1)} select`);
    this.bumpSelection();
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
      const count = elementCount(mesh, this.selectMode);
      const set = this.setForMode();
      set.clear();
      for (let i = 0; i < count; i++) set.add(i);
      this.syncSelection();
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
      const count = elementCount(mesh, this.selectMode);
      const set = this.setForMode();
      const next = new Set<number>();
      for (let i = 0; i < count; i++) if (!set.has(i)) next.add(i);
      set.clear();
      for (const i of next) set.add(i);
      this.syncSelection();
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
    const set = this.setForMode();
    if (!extend) set.clear();
    if (extend && set.has(hit)) set.delete(hit);
    else set.add(hit);
    this.syncSelection();
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
    const ring = edgeRing(mesh, hit);
    if (!extend) this.selection.edges.clear();
    for (const ei of ring.edges) this.selection.edges.add(ei);
    this.syncSelection('edge');
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

  /** Switch modes explicitly; the mode selector and commands both use this. */
  setMode(mode: EditorMode): void {
    if (mode === this.mode) return;
    if (mode === 'sculpt') {
      this.enterSculptMode();
      return;
    }
    if (mode === 'edit') {
      if (this.mode === 'sculpt') this.mode = 'object';
      if (this.mode === 'object') this.toggleEditMode();
      return;
    }
    this.mode = 'object';
    this.editObjectId = null;
    this.brushCursor = null;
    this.setStatus('Object Mode');
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.changed();
  }

  toggleEditMode(): void {
    if (this.mode === 'sculpt') {
      this.setMode('object');
      return;
    }
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
    const label = PRIMITIVES.find((p) => p.kind === kind)?.label ?? kind;
    this.beginUndo(`Add ${label}`);
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
      const obj = this.editObject;
      if (!mesh || !obj || this.selection.verts.size === 0) return null;
      let weights: Map<number, number> | null = null;
      if (this.proportional.enabled) {
        // The radius is a world-space distance; the mesh is not.
        const s = obj.scale;
        const avg = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
        weights = proportionalWeights(
          mesh, this.selection.verts, this.proportional.radius / avg,
          this.proportional.falloff, this.proportional.connected,
        );
      }
      const indices = weights ? [...weights.keys()] : [...this.selection.verts];
      return {
        verts: indices.map((index) => ({
          index, position: mesh.positions[index].clone(), weight: weights?.get(index) ?? 1,
        })),
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
        const moved = matrix.transformPoint(world);
        mesh.positions[v.index] = toLocal.transformPoint(
          v.weight >= 1 ? moved : world.lerp(moved, v.weight),
        );
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
    this.syncSelection('vertex');
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
    this.syncSelection('vertex');
    this.markGeometryDirty(obj);
    this.setStatus(`Loop cut: ${cuts} loop${cuts === 1 ? '' : 's'} inserted`);
    this.emit('modal');
  }

  // ------------------------------------------------------------------ bevel

  /** Start a modal bevel on the current edge (or face-region) selection. */
  startBevel(): void {
    const obj = this.editObject;
    const mesh = this.editMesh;
    if (!obj || !mesh) {
      this.setStatus('Bevel works in Edit Mode');
      return;
    }
    const edges = this.bevelTargets(mesh);
    if (edges.length === 0) {
      this.setStatus('Select edges or faces to bevel');
      return;
    }
    this.beginUndo('Bevel');
    this.modal = {
      type: 'bevel',
      state: {
        baseline: mesh.clone(), edges,
        startX: this.pointer.x, startY: this.pointer.y,
        width: 0, segments: 1, profile: 0.5,
      },
    };
    this.emit('modal');
  }

  /**
   * Which edges a bevel should act on: the selected edges, or the boundary of
   * the selected face region when the user is working in face mode.
   */
  private bevelTargets(mesh: Mesh): number[] {
    if (this.selection.edges.size > 0 && this.selectMode !== 'face') return [...this.selection.edges];
    if (this.selection.faces.size > 0) {
      const t = mesh.topology();
      const faces = this.selection.faces;
      const out: number[] = [];
      for (let ei = 0; ei < t.edges.length; ei++) {
        let inside = 0;
        for (const f of t.edges[ei].faces) if (faces.has(f)) inside++;
        if (inside === 1) out.push(ei);
      }
      if (out.length) return out;
    }
    return [...this.selection.edges];
  }

  private updateBevel(x: number, y: number): void {
    if (this.modal?.type !== 'bevel') return;
    const obj = this.editObject;
    if (!obj) return;
    const b = this.modal.state;
    const pivot = this.transformPivot() ?? new Vec3();
    const scale = this.camera.pixelScaleAt(pivot, this.canvas.clientHeight);
    b.width = Math.max(0, Math.hypot(x - b.startX, y - b.startY) * scale * (this.keys.shift ? 0.1 : 1));
    this.applyBevel();
    this.emit('modal');
  }

  private applyBevel(): void {
    if (this.modal?.type !== 'bevel') return;
    const obj = this.editObject;
    if (!obj) return;
    const b = this.modal.state;
    // Re-run from the pristine copy so dragging back and forth stays exact.
    const fresh = b.baseline.clone();
    const r = bevelEdges(fresh, b.edges, b.width, b.segments, b.profile);
    obj.mesh = fresh;
    this.selection.verts = new Set(r.newVerts);
    this.selection.edges.clear();
    this.selection.faces.clear();
    this.syncSelection('vertex');
    this.markGeometryDirty(obj);
  }

  // ----------------------------------------------------------------- sculpt

  get brushOverlay(): { center: Vec3; normal: Vec3; radius: number } | null {
    return this.brushCursor;
  }

  setSculptBrush(brush: SculptSettings['brush']): void {
    this.sculpt.brush = brush;
    this.setStatus(`Brush: ${brush}`);
    this.emit('change');
  }

  adjustBrushRadius(factor: number): void {
    this.sculpt.radius = Math.max(0.005, Math.min(100, this.sculpt.radius * factor));
    this.setStatus(`Brush radius ${this.sculpt.radius.toFixed(3)}`);
    this.emit('change');
    this.requestRender();
  }

  adjustBrushStrength(delta: number): void {
    this.sculpt.strength = Math.max(0.01, Math.min(1, this.sculpt.strength + delta));
    this.setStatus(`Brush strength ${this.sculpt.strength.toFixed(2)}`);
    this.emit('change');
  }

  enterSculptMode(): void {
    const obj = this.scene.activeObject;
    if (!obj || obj.type !== 'mesh' || !obj.mesh) {
      this.setStatus('Select a mesh object to sculpt');
      return;
    }
    this.mode = 'sculpt';
    this.editObjectId = null;
    this.clearElementSelection();
    this.setStatus(`Sculpt Mode — ${obj.name} (${this.sculpt.brush} brush)`);
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.changed();
  }

  /** Where the cursor meets the sculpted surface, in the mesh's own space. */
  private sculptHit(x: number, y: number): { local: Vec3; normal: Vec3; radius: number } | null {
    const obj = this.sculptObject;
    const mesh = obj?.mesh;
    if (!obj || !mesh) return null;
    const model = obj.worldMatrix(this.scene);
    const inv = model.inverse();
    const ray = this.camera.screenRay(x, y, this.viewport().width, this.viewport().height);
    const o = inv.transformPoint(ray.origin);
    const d = inv.transformDirection(ray.dir).normalized();
    const hit = pickFaceRay(mesh, o, d);
    if (!hit) return null;
    const local = o.add(d.scale(hit.t));
    const normal = mesh.topology().faceNormals[hit.face] ?? new Vec3(0, 0, 1);
    // The radius is authored in world units; convert once per stroke step.
    const sc = obj.scale;
    const avg = (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1;
    return { local, normal, radius: this.sculpt.radius / avg };
  }

  private beginStroke(x: number, y: number, invert: boolean): boolean {
    const obj = this.sculptObject;
    const mesh = obj?.mesh;
    if (!obj || !mesh) return false;
    const hit = this.sculptHit(x, y);
    if (!hit) return false;
    this.beginUndo(`Sculpt ${this.sculpt.brush}`);
    this.sculpt.invert = invert;
    this.stroke = new SculptStroke(mesh, this.sculpt, hit.radius);
    this.strokeStart = hit.local;
    this.stroke.begin(hit.local, hit.radius);
    this.stroke.dab(hit.local, hit.normal, hit.radius, new Vec3());
    this.markGeometryDirty(obj);
    return true;
  }

  private continueStroke(x: number, y: number): void {
    const obj = this.sculptObject;
    if (!this.stroke || !obj || !obj.mesh) return;
    if (this.sculpt.brush === 'grab') {
      // Grab drags along the view plane through the point the stroke started.
      const start = this.strokeStart;
      if (!start) return;
      const model = obj.worldMatrix(this.scene);
      const inv = model.inverse();
      const worldStart = model.transformPoint(start);
      const n = this.camera.forward().neg();
      const ray = this.camera.screenRay(x, y, this.viewport().width, this.viewport().height);
      const t = rayPlane(ray.origin, ray.dir, worldStart, n);
      if (t === null) return;
      const worldNow = ray.origin.add(ray.dir.scale(t));
      const delta = inv.transformPoint(worldNow).sub(start);
      const sc = obj.scale;
      const avg = (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1;
      this.stroke.dab(start, n, this.sculpt.radius / avg, delta);
      this.markGeometryDirty(obj);
      return;
    }
    const hit = this.sculptHit(x, y);
    if (!hit) return;
    this.stroke.dab(hit.local, hit.normal, hit.radius, new Vec3());
    this.markGeometryDirty(obj);
  }

  private endStroke(): void {
    if (!this.stroke) return;
    this.stroke = null;
    this.strokeStart = null;
    this.sculpt.invert = false;
    this.dirtySinceSave = true;
    this.changed();
  }

  // -------------------------------------------------------------- animation

  /** Key the active objects' transform at the current frame. */
  insertKeyframe(which: 'position' | 'rotation' | 'scale' | 'all' = 'all'): number {
    const objects = this.scene.selectedObjects();
    if (objects.length === 0) {
      this.setStatus('Select something to key');
      return 0;
    }
    this.beginUndo('Insert keyframe');
    const frame = this.scene.timeline.current;
    const paths: ChannelPath[] = which === 'all' ? ['position', 'rotation', 'scale'] : [which];
    for (const obj of objects) {
      for (const path of paths) {
        const v = path === 'position' ? obj.position : path === 'rotation' ? obj.rotation : obj.scale;
        setKey(obj.animation, path, 0, frame, v.x);
        setKey(obj.animation, path, 1, frame, v.y);
        setKey(obj.animation, path, 2, frame, v.z);
      }
    }
    this.setStatus(`Keyed ${which} at frame ${frame}`);
    this.changed();
    return objects.length;
  }

  deleteKeyframe(): number {
    const objects = this.scene.selectedObjects();
    if (objects.length === 0) return 0;
    this.beginUndo('Delete keyframe');
    let n = 0;
    for (const obj of objects) n += removeKey(obj.animation, this.scene.timeline.current);
    this.setStatus(n ? `Removed ${n} key${n === 1 ? '' : 's'}` : 'No key on this frame');
    this.changed();
    return n;
  }

  setFrame(frame: number): void {
    const tl = this.scene.timeline;
    const f = Math.max(tl.start, Math.min(tl.end, Math.round(frame)));
    this.scene.setFrame(f);
    for (const id of this.scene.objects.keys()) this.renderer.invalidate(id);
    this.emit('frame');
    this.changed();
  }

  stepFrame(delta: number): void {
    this.setFrame(this.scene.timeline.current + delta);
  }

  togglePlayback(): void {
    if (this.scene.timeline.playing) this.stopPlayback();
    else this.startPlayback();
  }

  startPlayback(): void {
    const tl = this.scene.timeline;
    if (tl.playing) return;
    tl.playing = true;
    this.playbackClock = performance.now();
    const tick = (now: number): void => {
      if (!this.scene.timeline.playing) return;
      const dt = (now - this.playbackClock) / 1000;
      const advance = dt * this.scene.timeline.fps;
      if (advance >= 1) {
        this.playbackClock = now;
        let next = this.scene.timeline.current + Math.floor(advance);
        if (next > this.scene.timeline.end) {
          if (!this.scene.timeline.loop) {
            this.stopPlayback();
            return;
          }
          const span = this.scene.timeline.end - this.scene.timeline.start + 1;
          next = this.scene.timeline.start + ((next - this.scene.timeline.start) % Math.max(1, span));
        }
        this.setFrame(next);
      }
      this.playbackHandle = requestAnimationFrame(tick);
    };
    this.playbackHandle = requestAnimationFrame(tick);
    this.emit('frame');
  }

  stopPlayback(): void {
    this.scene.timeline.playing = false;
    if (this.playbackHandle !== null) cancelAnimationFrame(this.playbackHandle);
    this.playbackHandle = null;
    this.emit('frame');
  }

  // ----------------------------------------------------------------- render

  /**
   * Kick off a path-traced render. `fromCamera` uses the scene camera when one
   * exists so the framing is reproducible; otherwise it renders the viewport.
   */
  startRender(fromCamera = true): RenderJob | null {
    this.cancelRender();
    let cam = null;
    if (fromCamera) {
      const camObj = [...this.scene.objects.values()].find((o) => o.type === 'camera' && o.visible);
      if (camObj) cam = cameraFromObject(this.scene, camObj.id);
    }
    if (!cam) cam = cameraFromViewport(this.camera);
    const traceScene = buildTraceScene(this.scene, cam, this.scene.world.sky);
    if (traceScene.positions.length === 0) {
      this.setStatus('Nothing to render');
      return null;
    }
    const job = new RenderJob(traceScene, { ...this.renderSettings });
    this.activeRender = job;
    job.onPass = () => this.emit('render');
    this.emit('render');
    void job.run().then(() => {
      this.emit('render');
      if (!job.cancelled) {
        const secs = ((Date.now() - job.startedAt) / 1000).toFixed(1);
        this.setStatus(`Render finished — ${job.settings.samples} samples in ${secs}s`);
      }
    });
    this.setStatus(`Rendering ${job.settings.width}×${job.settings.height} at ${job.settings.samples} samples…`);
    return job;
  }

  cancelRender(): void {
    if (!this.activeRender) return;
    this.activeRender.cancel();
    this.activeRender = null;
    this.emit('render');
  }

  // --------------------------------------------------------------- autosave

  applyPreferences(prefs: Preferences): void {
    this.preferences = prefs;
    this.options.showGrid = prefs.showGrid;
    this.options.showOverlays = prefs.showOverlays;
    this.snap.increment = prefs.snapIncrement;
    this.renderSettings.samples = prefs.renderSamples;
    this.renderSettings.width = prefs.renderWidth;
    this.renderSettings.height = prefs.renderHeight;
    savePreferences(prefs);
    this.startAutosave();
    this.changed();
  }

  loadStoredPreferences(): void {
    this.applyPreferences(loadPreferences());
  }

  startAutosave(): void {
    if (this.autosaveTimer !== null) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (!this.preferences.autosaveEnabled) return;
    const period = Math.max(15, this.preferences.autosaveSeconds) * 1000;
    this.autosaveTimer = setInterval(() => this.autosaveNow(false), period) as unknown as number;
  }

  /** Write a recovery copy. Returns false when storage refused it. */
  autosaveNow(announce = true): boolean {
    const res = writeAutosave(this.scene.toJSON(), 'Autosave');
    if (res.ok) {
      this.dirtySinceSave = false;
      if (announce) this.setStatus('Autosaved');
      return true;
    }
    if (announce || this.dirtySinceSave) {
      this.setStatus(`Autosave skipped — ${res.reason ?? 'storage unavailable'}`);
    }
    return false;
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
      case 'bevel':
        this.setStatus(`Bevel ${this.modal.state.width.toFixed(4)} × ${this.modal.state.segments}`);
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
    if (m.type === 'transform' || m.type === 'inset' || m.type === 'bevel') {
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
      const set = this.setForMode();
      if (!extend && !subtract) set.clear();
      for (const h of hits) {
        if (subtract) set.delete(h);
        else set.add(h);
      }
      this.syncSelection();
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
    if (this.modal?.type === 'transform' && this.proportional.enabled && this.mode === 'edit') {
      const ring = influenceCircle(
        this.modal.session.pivot, this.proportional.radius, this.camera.right(), this.camera.up(),
      );
      for (let i = 0; i < ring.length; i++) {
        lines.push({
          a: ring[i], b: ring[(i + 1) % ring.length], color: [0.35, 0.75, 1], overlay: true,
        });
      }
    }
    if (this.mode === 'sculpt' && this.brushCursor) {
      const c = this.brushCursor;
      const helper = Math.abs(c.normal.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
      const right = helper.cross(c.normal).normalized();
      const up = c.normal.cross(right).normalized();
      const ring = influenceCircle(c.center, c.radius, right, up, 48);
      const color: [number, number, number] = this.sculpt.invert ? [1, 0.45, 0.35] : [0.95, 0.95, 1];
      for (let i = 0; i < ring.length; i++) {
        lines.push({ a: ring[i], b: ring[(i + 1) % ring.length], color, overlay: true });
      }
    }
    if (this.modal?.type === 'transform' && this.modal.session.snapPoint) {
      const p = this.modal.session.snapPoint;
      const r = this.camera.pixelScaleAt(p, this.canvas.clientHeight) * 9;
      for (const [ax, ay] of [[this.camera.right(), this.camera.up()]] as [Vec3, Vec3][]) {
        lines.push({ a: p.sub(ax.scale(r)), b: p.add(ax.scale(r)), color: [1, 0.4, 0.9], overlay: true });
        lines.push({ a: p.sub(ay.scale(r)), b: p.add(ay.scale(r)), color: [1, 0.4, 0.9], overlay: true });
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
    if (this.mode === 'sculpt' && e.button === 0 && !e.altKey) {
      if (this.beginStroke(p.x, p.y, e.ctrlKey || e.metaKey)) return;
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
          this.updateSnapping(this.modal.session, p.x, p.y, e.ctrlKey);
          this.modal.session.setModifiers({
            precision: e.shiftKey,
            snap: this.snappingActive(e.ctrlKey) && this.snap.mode === 'increment',
          });
          this.applyTransform(this.modal.session.update(p.x, p.y));
          break;
        case 'inset':
          this.updateInset(p.x, p.y);
          break;
        case 'bevel':
          this.updateBevel(p.x, p.y);
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

    if (this.mode === 'sculpt') {
      this.updateBrushCursor(p.x, p.y);
      if (this.stroke && this.pointer.down && this.pointer.button === 0) {
        this.continueStroke(p.x, p.y);
        return;
      }
    }

    if (!this.pointer.down) return;
    const moved = Math.hypot(p.x - this.pointer.startX, p.y - this.pointer.startY);
    if (moved > 3) this.pointer.dragging = true;

    // A trackpad has no middle button, so Alt (Option) with the left button
    // drives navigation too. Alt+click without a drag still selects a loop.
    const navigating = this.pointer.button === 1 || (this.pointer.button === 0 && e.altKey);
    if (navigating) {
      if (e.shiftKey) this.camera.pan(dx, dy, this.canvas.clientHeight);
      else if (e.ctrlKey || e.metaKey) this.camera.zoom(-dy * 0.02);
      else this.camera.orbit(dx * 0.008, dy * 0.008);
      this.requestRender();
    } else if (this.pointer.button === 0 && this.pointer.dragging && this.mode !== 'sculpt') {
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
    if (this.stroke) {
      this.endStroke();
      return;
    }
    if (this.modal?.type === 'box') {
      this.applyBoxSelect();
      this.modal = null;
      this.emit('modal');
      this.requestRender();
      return;
    }
    if (!wasDown || dragging || e.button !== 0) return;

    const p = this.localPointer(e);
    if (this.mode === 'sculpt') return;
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
    if (this.modal?.type === 'transform' && this.proportional.enabled && this.mode === 'edit') {
      this.setProportionalRadius(this.proportional.radius * (e.deltaY < 0 ? 1 / 1.12 : 1.12));
      return;
    }
    if (this.modal?.type === 'bevel') {
      const b = this.modal.state;
      b.segments = Math.max(1, Math.min(32, b.segments + (e.deltaY < 0 ? 1 : -1)));
      this.applyBevel();
      this.emit('modal');
      return;
    }
    if (this.mode === 'sculpt' && (e.ctrlKey || e.metaKey)) {
      this.adjustBrushRadius(e.deltaY < 0 ? 1 / 1.1 : 1.1);
      return;
    }
    if (this.modal?.type === 'loopcut') {
      this.modal.cuts = Math.max(1, Math.min(64, this.modal.cuts + (e.deltaY < 0 ? 1 : -1)));
      this.updateLoopCutPreview(this.pointer.x, this.pointer.y);
      this.emit('modal');
      return;
    }
    if (e.shiftKey) {
      // Two-finger scroll with Shift pans, the way it does in most 3D apps.
      this.camera.pan(-e.deltaX, -e.deltaY, this.canvas.clientHeight);
    } else if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as a wheel event with ctrlKey set.
      this.camera.zoom(-e.deltaY * 0.05);
    } else {
      this.camera.zoom(e.deltaY < 0 ? 1 : -1);
    }
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
    if (m.type === 'bevel') {
      if (key === 'ArrowUp' || key === '+') {
        m.state.segments = Math.min(32, m.state.segments + 1);
        this.applyBevel();
        return true;
      }
      if (key === 'ArrowDown' || key === '-') {
        m.state.segments = Math.max(1, m.state.segments - 1);
        this.applyBevel();
        return true;
      }
      if (key === 'p' || key === 'P') {
        // Cycle the profile between chamfer, round and crease.
        m.state.profile = m.state.profile >= 0.99 ? 0 : m.state.profile < 0.05 ? 0.5 : 1;
        this.applyBevel();
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

  /** Ctrl inverts whatever the snap toggle is set to, the way Blender does it. */
  private snappingActive(ctrl: boolean): boolean {
    return this.snap.enabled !== ctrl;
  }

  private updateSnapping(session: TransformSession, x: number, y: number, ctrl: boolean): void {
    session.snapPoint = null;
    session.gridStep = 0;
    if (!this.snappingActive(ctrl) || session.kind !== 'translate') return;
    if (this.snap.mode === 'increment') return;
    if (this.snap.mode === 'grid') {
      session.gridStep = this.snap.increment;
      return;
    }
    const exclude = new Set<number>();
    if (this.mode === 'edit' && this.editObjectId !== null) exclude.add(this.editObjectId);
    else for (const id of this.scene.selection) exclude.add(id);
    session.snapPoint = snapPointUnderCursor(
      this.scene, this.camera, x, y, this.viewport(), this.snap.mode, exclude,
    );
  }

  /**
   * Change the proportional radius mid-drag. The weight set has to be rebuilt,
   * which means putting the already-moved vertices back first.
   */
  setProportionalRadius(radius: number): void {
    this.proportional.radius = Math.max(0.001, Math.min(1e5, radius));
    if (this.modal?.type === 'transform' && this.modal.snapshot.verts) {
      const mesh = this.editMesh;
      if (mesh) {
        for (const v of this.modal.snapshot.verts) mesh.positions[v.index] = v.position.clone();
        const fresh = this.captureTransform();
        if (fresh) this.modal.snapshot = fresh;
      }
      this.applyTransform(this.modal.session.update(this.pointer.x, this.pointer.y));
    }
    this.setStatus(`Proportional radius ${this.proportional.radius.toFixed(3)}`);
    this.emit('modal');
    this.requestRender();
  }

  toggleProportional(): void {
    this.proportional.enabled = !this.proportional.enabled;
    if (this.modal?.type === 'transform') this.setProportionalRadius(this.proportional.radius);
    this.setStatus(`Proportional editing ${this.proportional.enabled ? 'on' : 'off'}`);
    this.emit('change');
    this.requestRender();
  }

  /** Track where the brush would land, for the viewport ring. */
  private updateBrushCursor(x: number, y: number): void {
    const hit = this.sculptHit(x, y);
    const obj = this.sculptObject;
    if (!hit || !obj) {
      if (this.brushCursor) {
        this.brushCursor = null;
        this.requestRender();
      }
      return;
    }
    const model = obj.worldMatrix(this.scene);
    this.brushCursor = {
      center: model.transformPoint(hit.local),
      normal: model.normalMatrix().transformDirection(hit.normal).normalized(),
      radius: this.sculpt.radius,
    };
    this.requestRender();
  }

  get pointerPosition(): { x: number; y: number } {
    return { x: this.pointer.x, y: this.pointer.y };
  }
}
