import { AABB, Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { Modifier, ObjectResolver, evaluateStack, stackKey } from '../modifiers';
import { Material, cloneMaterial, createMaterial } from './Material';
import { SceneTexture, reserveTextureId } from './Texture';
import {
  Channel, TimelineSettings, cloneChannels, completeTransform, defaultTimeline, sampleChannels,
} from '../anim/animation';

export type ObjectType = 'mesh' | 'light' | 'camera' | 'empty';
export type LightType = 'point' | 'sun' | 'spot' | 'area';

export interface LightData {
  type: LightType;
  color: [number, number, number];
  /** Watts for point/spot/area, irradiance for sun. */
  energy: number;
  /** Spot cone half-angle in radians. */
  spotAngle: number;
  /** Area light edge length. */
  size: number;
}

export interface CameraData {
  fov: number;
  near: number;
  far: number;
  orthographic: boolean;
  orthoScale: number;
}

export function createLightData(type: LightType = 'point'): LightData {
  return {
    type,
    color: [1, 1, 1],
    energy: type === 'sun' ? 3 : 100,
    spotAngle: Math.PI / 6,
    size: 1,
  };
}

export function createCameraData(): CameraData {
  return { fov: 39.6 * (Math.PI / 180), near: 0.1, far: 1000, orthographic: false, orthoScale: 6 };
}

export class SceneObject {
  id: number;
  name: string;
  type: ObjectType;
  position = new Vec3();
  rotation = new Vec3();
  scale = new Vec3(1, 1, 1);
  visible = true;
  /** Excluded from selection and picking when locked. */
  locked = false;
  parent: number | null = null;
  children: number[] = [];
  mesh: Mesh | null = null;
  modifiers: Modifier[] = [];
  /** Indices into `Scene.materials`; face material slots index into this list. */
  materialSlots: number[] = [];
  light: LightData | null = null;
  camera: CameraData | null = null;

  private evalCache: { key: string; revision: number; mesh: Mesh } | null = null;

  /** Keyframe channels driving this object's transform. */
  animation: Channel[] = [];
  /**
   * Back-reference to the owning scene. Modifiers that point at another object
   * (boolean, above all) cannot be evaluated without it.
   */
  owner: Scene | null = null;
  /** Re-entrancy guard: a boolean chain that loops back would never return. */
  private evaluating = false;

  constructor(id: number, name: string, type: ObjectType) {
    this.id = id;
    this.name = name;
    this.type = type;
  }

  matrix(): Mat4 {
    return Mat4.compose(this.position, this.rotation, this.scale);
  }

  /** Local matrix combined with every ancestor's. */
  worldMatrix(scene: Scene): Mat4 {
    let m = this.matrix();
    let p = this.parent !== null ? scene.get(this.parent) : null;
    let guard = 0;
    while (p && guard++ < 64) {
      m = p.matrix().multiply(m);
      p = p.parent !== null ? scene.get(p.parent) : null;
    }
    return m;
  }

  /** Modifier-evaluated mesh, memoised against geometry revision + stack state. */
  evaluated(editMode = false): Mesh | null {
    if (!this.mesh) return null;
    if (this.modifiers.length === 0) return this.mesh;
    if (this.evaluating) return this.mesh;
    const scene = this.owner;
    // References to other objects have to be part of the cache key, or editing
    // a boolean's cutter would leave the result stale.
    let refs = '';
    if (scene) {
      for (const mod of this.modifiers) {
        if (mod.type !== 'boolean' || mod.objectId === null) continue;
        const other = scene.get(mod.objectId);
        refs += `|${mod.objectId}:${other?.mesh?.revision ?? -1}`;
      }
    }
    const key = stackKey(this.modifiers, editMode) + refs;
    if (this.evalCache && this.evalCache.key === key && this.evalCache.revision === this.mesh.revision) {
      return this.evalCache.mesh;
    }
    const resolve: ObjectResolver | undefined = scene
      ? (id) => {
        const other = scene.get(id);
        if (!other || other === this) return null;
        const geo = other.evaluated(false);
        if (!geo) return null;
        // Bring the cutter into this object's local space.
        const into = this.worldMatrix(scene).inverse().multiply(other.worldMatrix(scene));
        const copy = geo.clone();
        copy.transform(into);
        return copy;
      }
      : undefined;
    this.evaluating = true;
    let result: Mesh;
    try {
      result = evaluateStack(this.mesh, this.modifiers, editMode, resolve);
    } finally {
      this.evaluating = false;
    }
    this.evalCache = { key, revision: this.mesh.revision, mesh: result };
    return result;
  }

  invalidate(): void {
    this.evalCache = null;
  }

  get animated(): boolean {
    return this.animation.length > 0;
  }

  /**
   * World-space bounds, including children — a group's extent is its contents,
   * otherwise framing an empty puts the camera inside whatever hangs off it.
   */
  bounds(scene: Scene, editMode = false, depth = 0): AABB {
    const b = new AABB();
    const m = this.worldMatrix(scene);
    const geo = this.evaluated(editMode);
    if (geo) {
      for (const p of geo.positions) b.expand(m.transformPoint(p));
    } else {
      b.expand(m.transformPoint(new Vec3()));
    }
    if (depth < 32) {
      for (const id of this.children) {
        const child = scene.get(id);
        if (child && child.visible) b.union(child.bounds(scene, editMode, depth + 1));
      }
    }
    return b;
  }
}

export interface WorldSettings {
  background: [number, number, number];
  ambient: number;
  showGrid: boolean;
  gridSize: number;
  /**
   * Strength of the sky dome in a path-traced render. It both lights the
   * scene and is what a ray that escapes sees, so raising it brightens the
   * shadows and the backdrop together.
   */
  sky: number;
}

export class Scene {
  objects = new Map<number, SceneObject>();
  /** Top-level display order in the outliner. */
  order: number[] = [];
  materials: Material[] = [];
  /** Images referenced by materials, embedded so a saved scene is portable. */
  textures: SceneTexture[] = [];
  world: WorldSettings = {
    background: [0.05, 0.05, 0.06],
    ambient: 0.12,
    showGrid: true,
    gridSize: 1,
    sky: 0.35,
  };
  selection = new Set<number>();
  active: number | null = null;
  timeline: TimelineSettings = defaultTimeline();
  /** 3D cursor — the pivot/spawn point, as in Blender. */
  cursor = new Vec3();

  private nextId = 1;
  private nameCounts = new Map<string, number>();

  uniqueName(base: string): string {
    const used = new Set([...this.objects.values()].map((o) => o.name));
    if (!used.has(base)) {
      this.nameCounts.set(base, 0);
      return base;
    }
    let n = this.nameCounts.get(base) ?? 0;
    let name: string;
    do {
      n++;
      name = `${base}.${String(n).padStart(3, '0')}`;
    } while (used.has(name));
    this.nameCounts.set(base, n);
    return name;
  }

  add(type: ObjectType, name: string, mesh: Mesh | null = null): SceneObject {
    const obj = new SceneObject(this.nextId++, this.uniqueName(name), type);
    obj.owner = this;
    obj.mesh = mesh;
    if (type === 'light') obj.light = createLightData();
    if (type === 'camera') obj.camera = createCameraData();
    if (mesh) obj.materialSlots = [this.ensureDefaultMaterial()];
    this.objects.set(obj.id, obj);
    this.order.push(obj.id);
    return obj;
  }

  get(id: number | null): SceneObject | null {
    return id === null ? null : this.objects.get(id) ?? null;
  }

  get activeObject(): SceneObject | null {
    return this.get(this.active);
  }

  selectedObjects(): SceneObject[] {
    return [...this.selection].map((id) => this.objects.get(id)).filter((o): o is SceneObject => !!o);
  }

  remove(id: number): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    for (const c of [...obj.children]) this.remove(c);
    if (obj.parent !== null) {
      const p = this.objects.get(obj.parent);
      if (p) p.children = p.children.filter((c) => c !== id);
    }
    this.objects.delete(id);
    this.order = this.order.filter((o) => o !== id);
    this.selection.delete(id);
    if (this.active === id) this.active = this.selection.values().next().value ?? null;
  }

  setParent(childId: number, parentId: number | null): void {
    const child = this.objects.get(childId);
    if (!child) return;
    // Refuse to build a cycle.
    let p = parentId;
    let guard = 0;
    while (p !== null && guard++ < 64) {
      if (p === childId) return;
      p = this.objects.get(p)?.parent ?? null;
    }
    if (child.parent !== null) {
      const old = this.objects.get(child.parent);
      if (old) old.children = old.children.filter((c) => c !== childId);
    }
    child.parent = parentId;
    if (parentId !== null) {
      const np = this.objects.get(parentId);
      if (np && !np.children.includes(childId)) np.children.push(childId);
      this.order = this.order.filter((o) => o !== childId);
    } else if (!this.order.includes(childId)) {
      this.order.push(childId);
    }
  }

  ensureDefaultMaterial(): number {
    if (this.materials.length === 0) {
      this.materials.push(createMaterial({ name: 'Material', color: [0.75, 0.75, 0.78] }));
    }
    return 0;
  }

  addMaterial(m?: Material): number {
    this.materials.push(m ?? createMaterial());
    return this.materials.length - 1;
  }

  materialFor(obj: SceneObject, faceSlot: number): Material {
    const idx = obj.materialSlots[faceSlot] ?? obj.materialSlots[0] ?? 0;
    return this.materials[idx] ?? createMaterial();
  }

  /** Depth-first traversal of the hierarchy in outliner order. */
  *walk(): Generator<{ obj: SceneObject; depth: number }> {
    const visit = function* (this: Scene, id: number, depth: number): Generator<{ obj: SceneObject; depth: number }> {
      const o = this.objects.get(id);
      if (!o) return;
      yield { obj: o, depth };
      for (const c of o.children) yield* visit.call(this, c, depth + 1);
    }.bind(this);
    for (const id of this.order) yield* visit(id, 0);
  }

  bounds(selectionOnly = false): AABB {
    const b = new AABB();
    for (const obj of this.objects.values()) {
      if (selectionOnly && !this.selection.has(obj.id)) continue;
      if (!obj.visible) continue;
      b.union(obj.bounds(this));
    }
    return b;
  }

  stats(): { objects: number; verts: number; edges: number; faces: number; tris: number } {
    let verts = 0, edges = 0, faces = 0, tris = 0;
    for (const obj of this.objects.values()) {
      if (!obj.visible) continue;
      const m = obj.evaluated();
      if (!m) continue;
      verts += m.vertCount;
      edges += m.edgeCount;
      faces += m.faceCount;
      tris += m.triCount;
    }
    return { objects: this.objects.size, verts, edges, faces, tris };
  }

  /** Any object in the scene carrying keyframes. */
  animatedObjects(): SceneObject[] {
    return [...this.objects.values()].filter((o) => o.animation.length > 0);
  }

  get hasAnimation(): boolean {
    for (const o of this.objects.values()) if (o.animation.length > 0) return true;
    return false;
  }

  /** Drive every animated object's transform to the given frame. */
  setFrame(frame: number): boolean {
    this.timeline.current = frame;
    let changed = false;
    for (const obj of this.objects.values()) {
      if (obj.animation.length === 0) continue;
      const sampled = sampleChannels(obj.animation, frame);
      const next = completeTransform(sampled, obj, obj.animation);
      obj.position = next.position;
      obj.rotation = next.rotation;
      obj.scale = next.scale;
      changed = true;
    }
    return changed;
  }

  /**
   * `meshes` lets a caller reuse serialized mesh data it already holds — undo
   * passes its snapshot store so an untouched mesh is not copied again.
   */
  toJSON(meshes?: { serialize(m: Mesh): ReturnType<Mesh['toJSON']> }): SerializedScene {
    return {
      format: 'kiln-scene',
      version: 1,
      nextId: this.nextId,
      world: { ...this.world, background: [...this.world.background] as [number, number, number] },
      cursor: this.cursor.toArray(),
      materials: this.materials.map(cloneMaterial),
      textures: this.textures.map((t) => ({ ...t })),
      timeline: { ...this.timeline, playing: false },
      active: this.active,
      selection: [...this.selection],
      order: [...this.order],
      objects: [...this.objects.values()].map((o) => ({
        id: o.id,
        name: o.name,
        type: o.type,
        position: o.position.toArray(),
        rotation: o.rotation.toArray(),
        scale: o.scale.toArray(),
        visible: o.visible,
        locked: o.locked,
        parent: o.parent,
        children: [...o.children],
        mesh: o.mesh ? (meshes ? meshes.serialize(o.mesh) : o.mesh.toJSON()) : null,
        modifiers: JSON.parse(JSON.stringify(o.modifiers)),
        materialSlots: [...o.materialSlots],
        light: o.light ? { ...o.light, color: [...o.light.color] as [number, number, number] } : null,
        camera: o.camera ? { ...o.camera } : null,
        animation: cloneChannels(o.animation),
      })),
    };
  }

  static fromJSON(data: SerializedScene): Scene {
    const s = new Scene();
    s.nextId = data.nextId ?? 1;
    s.world = { ...s.world, ...data.world };
    s.cursor = Vec3.fromArray(data.cursor ?? [0, 0, 0]);
    s.materials = (data.materials ?? []).map(cloneMaterial);
    s.textures = (data.textures ?? []).map((t) => ({ ...t }));
    s.timeline = { ...defaultTimeline(), ...(data.timeline ?? {}), playing: false };
    for (const t of s.textures) reserveTextureId(t.id);
    s.order = [...(data.order ?? [])];
    for (const od of data.objects ?? []) {
      const o = new SceneObject(od.id, od.name, od.type);
      o.owner = s;
      o.position = Vec3.fromArray(od.position);
      o.rotation = Vec3.fromArray(od.rotation);
      o.scale = Vec3.fromArray(od.scale);
      o.visible = od.visible !== false;
      o.locked = !!od.locked;
      o.parent = od.parent ?? null;
      o.children = [...(od.children ?? [])];
      o.mesh = od.mesh ? Mesh.fromJSON(od.mesh) : null;
      o.modifiers = od.modifiers ?? [];
      o.materialSlots = od.materialSlots ?? [];
      o.light = od.light ?? null;
      o.camera = od.camera ?? null;
      o.animation = cloneChannels(od.animation ?? []);
      s.objects.set(o.id, o);
      s.nextId = Math.max(s.nextId, o.id + 1);
    }
    if (s.order.length === 0) s.order = [...s.objects.keys()];
    s.selection = new Set((data.selection ?? []).filter((id) => s.objects.has(id)));
    s.active = data.active !== undefined && s.objects.has(data.active as number) ? data.active : null;
    return s;
  }
}

export interface SerializedObject {
  id: number;
  name: string;
  type: ObjectType;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  visible: boolean;
  locked: boolean;
  parent: number | null;
  children: number[];
  mesh: ReturnType<Mesh['toJSON']> | null;
  modifiers: Modifier[];
  materialSlots: number[];
  light: LightData | null;
  camera: CameraData | null;
  animation?: Channel[];
}

export interface SerializedScene {
  format: string;
  version: number;
  nextId: number;
  world: WorldSettings;
  cursor: [number, number, number];
  materials: Material[];
  textures?: SceneTexture[];
  timeline?: TimelineSettings;
  active: number | null;
  selection: number[];
  order: number[];
  objects: SerializedObject[];
}
