import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { Scene, SceneObject } from '../scene/Scene';
import { ViewportCamera } from '../scene/ViewportCamera';
import { DynamicBuffer, Program, setupAttribs } from './gl';
import { buildPoints, buildSurface, buildWire } from './MeshBuffers';
import {
  GRID_FRAG, GRID_VERT, LINE_FRAG, LINE_VERT, MAX_LIGHTS, MAX_MATERIALS,
  OUTLINE_FRAG, OUTLINE_VERT, POINT_FRAG, POINT_VERT, SURFACE_FRAG, SURFACE_VERT,
} from './shaders';

export type ShadingMode = 'solid' | 'material' | 'wireframe';
export type SelectMode = 'vertex' | 'edge' | 'face';

export interface EditOverlay {
  objectId: number;
  selectMode: SelectMode;
  verts: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
  /** Bumped by the editor whenever any of the selection sets change. */
  version: number;
}

export interface ViewportOptions {
  shading: ShadingMode;
  showGrid: boolean;
  showOverlays: boolean;
  showObjectWireframe: boolean;
  showOrigins: boolean;
  xray: boolean;
  backfaceCulling: boolean;
}

export interface LineSegment {
  a: Vec3;
  b: Vec3;
  color: [number, number, number];
  /** Drawn ignoring depth when true (axis guides, the 3D cursor). */
  overlay?: boolean;
}

export interface FrameState {
  scene: Scene;
  camera: ViewportCamera;
  options: ViewportOptions;
  edit: EditOverlay | null;
  lines: LineSegment[];
}

export const THEME = {
  wire: [0.05, 0.05, 0.06] as [number, number, number],
  wireSelected: [1.0, 0.62, 0.16] as [number, number, number],
  vertex: [0.0, 0.0, 0.0] as [number, number, number],
  vertexSelected: [1.0, 0.62, 0.16] as [number, number, number],
  outlineActive: [1.0, 0.62, 0.16] as [number, number, number],
  outlineSelected: [0.93, 0.42, 0.12] as [number, number, number],
  grid: [0.32, 0.32, 0.35] as [number, number, number],
  axisX: [0.79, 0.25, 0.31] as [number, number, number],
  axisY: [0.44, 0.66, 0.2] as [number, number, number],
  axisZ: [0.25, 0.45, 0.79] as [number, number, number],
  cursor: [0.95, 0.55, 0.15] as [number, number, number],
  light: [0.95, 0.85, 0.35] as [number, number, number],
  camera: [0.5, 0.85, 0.95] as [number, number, number],
};

interface GeometryEntry {
  key: string;
  surface: DynamicBuffer;
  wire: DynamicBuffer;
  points: DynamicBuffer;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private surfaceProgram: Program;
  private outlineProgram: Program;
  private lineProgram: Program;
  private pointProgram: Program;
  private gridProgram: Program;
  private gridQuad: WebGLBuffer;
  private lineScratch: DynamicBuffer;
  private cache = new Map<number, GeometryEntry>();
  width = 1;
  height = 1;
  pixelRatio = 1;
  lastDrawCalls = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is required — Kiln could not create a rendering context.');
    this.gl = gl;

    this.surfaceProgram = new Program(gl, SURFACE_VERT, SURFACE_FRAG, 'surface');
    this.outlineProgram = new Program(gl, OUTLINE_VERT, OUTLINE_FRAG, 'outline');
    this.lineProgram = new Program(gl, LINE_VERT, LINE_FRAG, 'line');
    this.pointProgram = new Program(gl, POINT_VERT, POINT_FRAG, 'point');
    this.gridProgram = new Program(gl, GRID_VERT, GRID_FRAG, 'grid');

    const quad = gl.createBuffer();
    if (!quad) throw new Error('failed to allocate grid buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.gridQuad = quad;

    this.lineScratch = new DynamicBuffer(gl);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  resize(): boolean {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.pixelRatio = ratio;
    return true;
  }

  private geometryFor(obj: SceneObject, mesh: Mesh, edit: EditOverlay | null): GeometryEntry {
    const editing = edit && edit.objectId === obj.id ? edit : null;
    const key = `${mesh.revision}|${editing ? `${editing.version}:${editing.selectMode}` : '-'}`;
    let entry = this.cache.get(obj.id);
    if (!entry) {
      entry = {
        key: '',
        surface: new DynamicBuffer(this.gl),
        wire: new DynamicBuffer(this.gl),
        points: new DynamicBuffer(this.gl),
      };
      this.cache.set(obj.id, entry);
    }
    if (entry.key === key) return entry;

    const faceSel = editing && editing.selectMode === 'face' ? editing.faces : null;
    const surface = buildSurface(mesh, faceSel);
    entry.surface.upload(surface.data, surface.count);

    if (editing) {
      const wire = buildWire(mesh, editing.edges, THEME.wire, THEME.wireSelected);
      entry.wire.upload(wire.data, wire.count);
      const pts = buildPoints(mesh, editing.verts);
      entry.points.upload(pts.data, pts.count);
    } else {
      entry.wire.count = 0;
      entry.points.count = 0;
    }
    entry.key = key;
    return entry;
  }

  /** Drop cached GPU buffers for objects that no longer exist. */
  private pruneCache(scene: Scene): void {
    for (const [id, entry] of this.cache) {
      if (!scene.objects.has(id)) {
        entry.surface.dispose();
        entry.wire.dispose();
        entry.points.dispose();
        this.cache.delete(id);
      }
    }
  }

  invalidate(objectId: number): void {
    const e = this.cache.get(objectId);
    if (e) e.key = '';
  }

  render(state: FrameState): void {
    const gl = this.gl;
    const { scene, camera, options, edit } = state;
    this.resize();
    this.pruneCache(scene);
    this.lastDrawCalls = 0;

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const viewProj = camera.viewProjection(aspect);
    const eye = camera.eye();
    const bg = scene.world.background;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const drawables: { obj: SceneObject; mesh: Mesh; model: Mat4; transparent: boolean }[] = [];
    for (const obj of scene.objects.values()) {
      if (!obj.visible || obj.type !== 'mesh') continue;
      const editing = !!edit && edit.objectId === obj.id;
      const mesh = obj.evaluated(editing);
      if (!mesh || mesh.faceCount === 0) continue;
      const transparent = obj.materialSlots.some((s) => (scene.materials[s]?.alpha ?? 1) < 0.999);
      drawables.push({ obj, mesh, model: obj.worldMatrix(scene), transparent });
    }

    if (options.shading !== 'wireframe') {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      if (options.backfaceCulling) {
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
      } else {
        gl.disable(gl.CULL_FACE);
      }
      for (const d of drawables) {
        if (d.transparent) continue;
        this.drawSurface(d.obj, d.mesh, d.model, state, viewProj, eye, 1);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.CULL_FACE);
    }

    // Selection outlines (object mode only).
    if (options.showOverlays && !edit && options.shading !== 'wireframe') {
      this.drawOutlines(scene, drawables, viewProj, eye);
    }

    if (options.showGrid) this.drawGrid(camera, viewProj);

    if (options.shading !== 'wireframe') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      const sorted = drawables
        .filter((d) => d.transparent)
        .sort((a, b) => {
          const da = a.model.transformPoint(new Vec3()).distanceTo(eye);
          const db = b.model.transformPoint(new Vec3()).distanceTo(eye);
          return db - da;
        });
      for (const d of sorted) this.drawSurface(d.obj, d.mesh, d.model, state, viewProj, eye, 1);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    if (options.showOverlays) {
      this.drawEditOverlays(state, drawables, viewProj);
      this.drawHelperLines(state, viewProj);
    }
  }

  private drawSurface(
    obj: SceneObject, mesh: Mesh, model: Mat4, state: FrameState,
    viewProj: Mat4, eye: Vec3, opacity: number,
  ): void {
    const gl = this.gl;
    const { scene, options, edit } = state;
    const entry = this.geometryFor(obj, mesh, edit);
    if (entry.surface.count === 0) return;

    const p = this.surfaceProgram;
    p.use();
    p.setMat4('uViewProj', viewProj.m);
    p.setMat4('uModel', model.m);
    p.setMat4('uNormalMat', model.normalMatrix().m);
    p.setVec3('uCamPos', eye.x, eye.y, eye.z);
    p.setInt('uShadingMode', options.shading === 'material' ? 1 : 0);
    p.setVec3('uSelectColor', ...THEME.wireSelected);
    p.setFloat('uObjectSelected', !edit && scene.selection.has(obj.id) ? 1 : 0);
    p.setFloat('uOpacity', opacity * (options.xray ? 0.45 : 1));

    const amb = scene.world.ambient;
    p.setVec3('uAmbient', amb, amb, amb);
    this.uploadLights(p, scene);
    this.uploadMaterials(p, scene, obj);

    gl.bindBuffer(gl.ARRAY_BUFFER, entry.surface.buffer);
    setupAttribs(gl, p, [
      { name: 'aPos', size: 3 }, { name: 'aNormal', size: 3 },
      { name: 'aFlags', size: 1 }, { name: 'aMatId', size: 1 },
    ]);
    gl.drawArrays(gl.TRIANGLES, 0, entry.surface.count);
    this.lastDrawCalls++;
  }

  private uploadLights(p: Program, scene: Scene): void {
    const pos = new Float32Array(MAX_LIGHTS * 4);
    const col = new Float32Array(MAX_LIGHTS * 4);
    const dir = new Float32Array(MAX_LIGHTS * 4);
    let n = 0;
    for (const obj of scene.objects.values()) {
      if (n >= MAX_LIGHTS || obj.type !== 'light' || !obj.visible || !obj.light) continue;
      const m = obj.worldMatrix(scene);
      const wp = m.transformPoint(new Vec3());
      const wd = m.transformDirection(new Vec3(0, 0, -1)).normalized();
      const type = obj.light.type === 'point' ? 0 : obj.light.type === 'sun' ? 1 : obj.light.type === 'spot' ? 2 : 3;
      pos.set([wp.x, wp.y, wp.z, type], n * 4);
      const e = obj.light.energy;
      col.set([
        obj.light.color[0] * e, obj.light.color[1] * e, obj.light.color[2] * e,
        Math.cos(obj.light.spotAngle),
      ], n * 4);
      dir.set([wd.x, wd.y, wd.z, obj.light.size], n * 4);
      n++;
    }
    p.setInt('uLightCount', n);
    p.setVec4Array('uLightPos', pos);
    p.setVec4Array('uLightColor', col);
    p.setVec4Array('uLightDir', dir);
  }

  private uploadMaterials(p: Program, scene: Scene, obj: SceneObject): void {
    const color = new Float32Array(MAX_MATERIALS * 3);
    const mr = new Float32Array(MAX_MATERIALS * 2);
    const emit = new Float32Array(MAX_MATERIALS * 4);
    const alpha = new Float32Array(MAX_MATERIALS);
    const slots = obj.materialSlots.length ? obj.materialSlots : [0];
    for (let i = 0; i < MAX_MATERIALS; i++) {
      const m = scene.materials[slots[Math.min(i, slots.length - 1)] ?? 0];
      const c = m?.color ?? [0.75, 0.75, 0.78];
      color.set(c, i * 3);
      mr.set([m?.metallic ?? 0, m?.roughness ?? 0.5], i * 2);
      emit.set([...(m?.emission ?? [0, 0, 0]), m?.emissionStrength ?? 0], i * 4);
      alpha[i] = m?.alpha ?? 1;
    }
    p.setVec3Array('uMatColor', color);
    p.setVec2Array('uMatMR', mr);
    p.setVec4Array('uMatEmit', emit);
    p.setFloatArray('uMatAlpha', alpha);
  }

  private drawOutlines(
    scene: Scene,
    drawables: { obj: SceneObject; mesh: Mesh; model: Mat4 }[],
    viewProj: Mat4, eye: Vec3,
  ): void {
    const gl = this.gl;
    const selected = drawables.filter((d) => scene.selection.has(d.obj.id));
    if (selected.length === 0) return;
    const p = this.outlineProgram;
    p.use();
    p.setMat4('uViewProj', viewProj.m);
    p.setVec3('uCamPos', eye.x, eye.y, eye.z);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    for (const d of selected) {
      const entry = this.cache.get(d.obj.id);
      if (!entry || entry.surface.count === 0) continue;
      const active = scene.active === d.obj.id;
      p.setMat4('uModel', d.model.m);
      p.setMat4('uNormalMat', d.model.normalMatrix().m);
      p.setFloat('uWidth', 0.0035);
      p.setVec3('uColor', ...(active ? THEME.outlineActive : THEME.outlineSelected));
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.surface.buffer);
      setupAttribs(gl, p, [
        { name: 'aPos', size: 3 }, { name: 'aNormal', size: 3 },
        { name: 'aFlags', size: 1 }, { name: 'aMatId', size: 1 },
      ]);
      gl.drawArrays(gl.TRIANGLES, 0, entry.surface.count);
      this.lastDrawCalls++;
    }
    gl.cullFace(gl.BACK);
    gl.disable(gl.CULL_FACE);
  }

  private drawGrid(camera: ViewportCamera, viewProj: Mat4): void {
    const gl = this.gl;
    const p = this.gridProgram;
    p.use();
    const eye = camera.eye();
    p.setMat4('uViewProj', viewProj.m);
    p.setMat4('uInvViewProj', viewProj.inverse().m);
    p.setVec3('uCamPos', eye.x, eye.y, eye.z);
    // Step the grid by powers of ten so it stays readable at any zoom: the fine
    // grid lands roughly one order of magnitude below the visible span.
    const span = camera.orthoHalfHeight() * 2;
    const decade = Math.pow(10, Math.round(Math.log10(Math.max(span, 1e-4))) - 1);
    p.setFloat('uSpacing', decade);
    p.setFloat('uFadeDistance', Math.max(20, camera.distance * 6));
    p.setVec3('uLineColor', ...THEME.grid);
    p.setVec3('uXAxisColor', ...THEME.axisX);
    p.setVec3('uYAxisColor', ...THEME.axisY);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridQuad);
    const loc = p.attrib('aPos');
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this.lastDrawCalls++;
  }

  private drawEditOverlays(
    state: FrameState,
    drawables: { obj: SceneObject; mesh: Mesh; model: Mat4 }[],
    viewProj: Mat4,
  ): void {
    const gl = this.gl;
    const { options, edit } = state;

    // Object-mode wireframe overlay.
    if (options.showObjectWireframe || options.shading === 'wireframe') {
      for (const d of drawables) {
        if (edit && edit.objectId === d.obj.id) continue;
        const entry = this.cache.get(d.obj.id);
        if (!entry) continue;
        if (entry.wire.count === 0) {
          const wire = buildWire(d.mesh, null, THEME.wire, THEME.wire);
          entry.wire.upload(wire.data, wire.count);
        }
        this.drawLineBuffer(entry.wire, d.model, viewProj, 0.00008, 0.55);
      }
    }

    if (!edit) return;
    const editable = drawables.find((d) => d.obj.id === edit.objectId);
    if (!editable) return;
    const entry = this.cache.get(edit.objectId);
    if (!entry) return;

    if (options.xray) gl.disable(gl.DEPTH_TEST);
    this.drawLineBuffer(entry.wire, editable.model, viewProj, 0.00012, 1);

    if (edit.selectMode === 'vertex' && entry.points.count > 0) {
      const p = this.pointProgram;
      p.use();
      p.setMat4('uViewProj', viewProj.m);
      p.setMat4('uModel', editable.model.m);
      p.setFloat('uSize', 6.5 * this.pixelRatio);
      p.setFloat('uDepthBias', 0.00016);
      p.setVec3('uColor', ...THEME.vertex);
      p.setVec3('uSelectColor', ...THEME.vertexSelected);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.points.buffer);
      setupAttribs(gl, p, [{ name: 'aPos', size: 3 }, { name: 'aFlags', size: 1 }]);
      gl.drawArrays(gl.POINTS, 0, entry.points.count);
      this.lastDrawCalls++;
    }
    if (options.xray) gl.enable(gl.DEPTH_TEST);
  }

  private drawLineBuffer(
    buffer: DynamicBuffer, model: Mat4, viewProj: Mat4, bias: number, alpha: number,
  ): void {
    if (buffer.count === 0) return;
    const gl = this.gl;
    const p = this.lineProgram;
    p.use();
    p.setMat4('uViewProj', viewProj.m);
    p.setMat4('uModel', model.m);
    p.setFloat('uDepthBias', bias);
    p.setFloat('uAlpha', alpha);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer.buffer);
    setupAttribs(gl, p, [{ name: 'aPos', size: 3 }, { name: 'aColor', size: 3 }]);
    gl.drawArrays(gl.LINES, 0, buffer.count);
    gl.disable(gl.BLEND);
    this.lastDrawCalls++;
  }

  /** Gizmos, light/camera helpers, the 3D cursor and modal transform guides. */
  private drawHelperLines(state: FrameState, viewProj: Mat4): void {
    const { scene, camera, options } = state;
    const segments: LineSegment[] = [];

    for (const obj of scene.objects.values()) {
      if (!obj.visible) continue;
      const m = obj.worldMatrix(scene);
      const selected = scene.selection.has(obj.id);
      if (obj.type === 'light' && obj.light) {
        const c: [number, number, number] = selected ? THEME.wireSelected : THEME.light;
        const o = m.transformPoint(new Vec3());
        const s = camera.pixelScaleAt(o, this.height) * 26;
        pushCircle(segments, o, s, camera, c);
        if (obj.light.type === 'sun') {
          const d = m.transformDirection(new Vec3(0, 0, -1)).normalized();
          segments.push({ a: o, b: o.add(d.scale(s * 4)), color: c });
        } else if (obj.light.type === 'spot') {
          const d = m.transformDirection(new Vec3(0, 0, -1)).normalized();
          const tip = o.add(d.scale(s * 5));
          const r = Math.tan(obj.light.spotAngle) * s * 5;
          pushCircle(segments, tip, r, camera, c, d);
          for (const k of [0, 1, 2, 3]) {
            const ang = (k / 4) * Math.PI * 2;
            const u = d.perpendicular();
            const v = d.cross(u);
            const rim = tip.add(u.scale(Math.cos(ang) * r)).add(v.scale(Math.sin(ang) * r));
            segments.push({ a: o, b: rim, color: c });
          }
        } else {
          for (let k = 0; k < 4; k++) {
            const ang = (k / 4) * Math.PI * 2;
            const u = camera.right().scale(Math.cos(ang)).add(camera.up().scale(Math.sin(ang)));
            segments.push({ a: o.add(u.scale(s * 1.4)), b: o.add(u.scale(s * 2.2)), color: c });
          }
        }
      } else if (obj.type === 'camera' && obj.camera) {
        const c: [number, number, number] = selected ? THEME.wireSelected : THEME.camera;
        pushCameraGizmo(segments, m, obj.camera.fov, camera.pixelScaleAt(m.transformPoint(new Vec3()), this.height) * 55, c);
      } else if (obj.type === 'empty') {
        const c: [number, number, number] = selected ? THEME.wireSelected : [0.6, 0.6, 0.65];
        const o = m.transformPoint(new Vec3());
        const s = camera.pixelScaleAt(o, this.height) * 24;
        for (let a = 0; a < 3; a++) {
          const d = Vec3.axis(a).scale(s);
          segments.push({ a: o.sub(d), b: o.add(d), color: c });
        }
      }
      if (options.showOrigins && obj.type === 'mesh' && selected) {
        const o = m.transformPoint(new Vec3());
        const s = camera.pixelScaleAt(o, this.height) * 4;
        for (let a = 0; a < 3; a++) {
          const d = Vec3.axis(a).scale(s);
          segments.push({ a: o.sub(d), b: o.add(d), color: THEME.wireSelected, overlay: true });
        }
      }
    }

    // 3D cursor.
    if (options.showOverlays) {
      const o = scene.cursor;
      const s = camera.pixelScaleAt(o, this.height) * 12;
      pushCircle(segments, o, s * 0.7, camera, THEME.cursor, undefined, true);
      for (let a = 0; a < 3; a++) {
        const d = Vec3.axis(a).scale(s);
        segments.push({ a: o.sub(d), b: o.add(d), color: THEME.cursor, overlay: true });
      }
    }

    segments.push(...state.lines);
    if (segments.length === 0) return;

    const depth = segments.filter((s) => !s.overlay);
    const noDepth = segments.filter((s) => s.overlay);
    if (depth.length) this.flushSegments(depth, viewProj, true);
    if (noDepth.length) this.flushSegments(noDepth, viewProj, false);
  }

  private flushSegments(segments: LineSegment[], viewProj: Mat4, depthTest: boolean): void {
    const gl = this.gl;
    const data = new Float32Array(segments.length * 2 * 6);
    let o = 0;
    for (const s of segments) {
      for (const p of [s.a, s.b]) {
        data[o++] = p.x; data[o++] = p.y; data[o++] = p.z;
        data[o++] = s.color[0]; data[o++] = s.color[1]; data[o++] = s.color[2];
      }
    }
    this.lineScratch.upload(data, segments.length * 2);
    if (!depthTest) gl.disable(gl.DEPTH_TEST);
    this.drawLineBuffer(this.lineScratch, Mat4.identity(), viewProj, 0.0002, 1);
    if (!depthTest) gl.enable(gl.DEPTH_TEST);
  }

  dispose(): void {
    for (const e of this.cache.values()) {
      e.surface.dispose();
      e.wire.dispose();
      e.points.dispose();
    }
    this.cache.clear();
    this.lineScratch.dispose();
    this.gl.deleteBuffer(this.gridQuad);
    this.surfaceProgram.dispose();
    this.outlineProgram.dispose();
    this.lineProgram.dispose();
    this.pointProgram.dispose();
    this.gridProgram.dispose();
  }
}

function pushCircle(
  out: LineSegment[], center: Vec3, radius: number, camera: ViewportCamera,
  color: [number, number, number], normal?: Vec3, overlay = false,
): void {
  const n = normal ? normal.normalized() : camera.forward();
  const u = n.perpendicular();
  const v = n.cross(u);
  const steps = 24;
  let prev = center.add(u.scale(radius));
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const p = center.add(u.scale(Math.cos(a) * radius)).add(v.scale(Math.sin(a) * radius));
    out.push({ a: prev, b: p, color, overlay });
    prev = p;
  }
}

function pushCameraGizmo(
  out: LineSegment[], m: Mat4, fov: number, size: number, color: [number, number, number],
): void {
  const o = m.transformPoint(new Vec3());
  const h = Math.tan(fov / 2) * size;
  const w = h * 1.5;
  const corners = [
    new Vec3(-w, -h, -size), new Vec3(w, -h, -size), new Vec3(w, h, -size), new Vec3(-w, h, -size),
  ].map((p) => m.transformPoint(p));
  for (let i = 0; i < 4; i++) {
    out.push({ a: corners[i], b: corners[(i + 1) % 4], color });
    out.push({ a: o, b: corners[i], color });
  }
  // Up triangle marker.
  const top = m.transformPoint(new Vec3(0, h * 1.6, -size));
  out.push({ a: corners[3], b: top, color });
  out.push({ a: corners[2], b: top, color });
}
