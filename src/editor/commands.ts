import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { PRIMITIVES } from '../mesh/primitives';
import {
  deleteEdges, deleteFaces, deleteVertices, dissolveFaces, duplicateFaces, extrudeEdges,
  extrudeFaces, facesToVerts, flipNormals, makeFace, mergeByDistance, mergeVertices,
  recalculateNormals, smoothVertices, subdivideFaces, triangulateFaces,
} from '../mesh/ops';
import { Scene } from '../scene/Scene';
import { downloadBinary, downloadText, openTextFile } from '../io/files';
import { exportMTL, exportOBJ, importOBJ } from '../io/obj';
import { exportSTL } from '../io/stl';
import { exportGLTF } from '../io/gltf';
import { Editor } from './Editor';
import { pruneSelection } from './selection';

export interface Command {
  id: string;
  label: string;
  category: 'File' | 'Edit' | 'Add' | 'Object' | 'Mesh' | 'Select' | 'View';
  shortcut?: string;
  /** Which mode the command applies to; omitted means both. */
  mode?: 'object' | 'edit';
  /** Return value is ignored; commands may return anything convenient. */
  run: (editor: Editor) => unknown;
  enabled?: (editor: Editor) => boolean;
}

const hasEditSelection = (ed: Editor): boolean => ed.mode === 'edit' && ed.selection.verts.size > 0;
const hasObjectSelection = (ed: Editor): boolean => ed.scene.selection.size > 0;

/** Run an edit-mode mesh operation with undo and cache invalidation handled. */
function editOp(ed: Editor, label: string, fn: (mesh: Mesh) => void): void {
  const obj = ed.editObject;
  const mesh = ed.editMesh;
  if (!obj || !mesh) return;
  ed.beginUndo(label);
  fn(mesh);
  // Indices shift under most operators; drop anything that no longer exists.
  pruneSelection(mesh, ed.selection);
  ed.syncSelection('vertex');
  ed.markGeometryDirty(obj);
  ed.setStatus(label);
}

function objectOp(ed: Editor, label: string, fn: (scene: Scene) => void): void {
  ed.beginUndo(label);
  fn(ed.scene);
  for (const id of ed.scene.objects.keys()) ed.renderer.invalidate(id);
  ed.emit('change');
  ed.requestRender();
  ed.setStatus(label);
}

export const COMMANDS: Command[] = [
  // ------------------------------------------------------------------- File
  {
    id: 'file.new', label: 'New Scene', category: 'File',
    run: (ed) => {
      ed.beginUndo('New scene');
      const scene = ed.scene;
      for (const id of [...scene.objects.keys()]) scene.remove(id);
      scene.cursor = new Vec3();
      ed.mode = 'object';
      ed.editObjectId = null;
      ed.emit('change');
      ed.requestRender();
      ed.setStatus('New scene');
    },
  },
  {
    id: 'file.save', label: 'Save Scene (.kiln)', category: 'File', shortcut: 'Ctrl+S',
    run: (ed) => {
      downloadText('scene.kiln', JSON.stringify(ed.scene.toJSON(), null, 1), 'application/json');
      ed.setStatus('Saved scene.kiln');
    },
  },
  {
    id: 'file.open', label: 'Open Scene (.kiln)', category: 'File', shortcut: 'Ctrl+O',
    run: async (ed) => {
      const file = await openTextFile('.kiln,application/json');
      if (!file) return;
      try {
        ed.loadSceneJSON(JSON.parse(file.text));
        ed.setStatus(`Opened ${file.name}`);
      } catch (err) {
        ed.setStatus(`Could not open ${file.name}: ${(err as Error).message}`);
      }
    },
  },
  {
    id: 'file.importObj', label: 'Import OBJ', category: 'File',
    run: async (ed) => {
      const file = await openTextFile('.obj');
      if (!file) return;
      const objects = importOBJ(file.text);
      if (objects.length === 0) {
        ed.setStatus('No geometry found in that OBJ');
        return;
      }
      objectOp(ed, 'Import OBJ', (scene) => {
        scene.selection.clear();
        for (const o of objects) {
          const added = scene.add('mesh', o.name, o.mesh);
          scene.selection.add(added.id);
          scene.active = added.id;
        }
      });
      ed.setStatus(`Imported ${objects.length} object(s) from ${file.name}`);
    },
  },
  {
    id: 'file.exportObj', label: 'Export OBJ', category: 'File',
    run: (ed) => {
      downloadText('scene.obj', exportOBJ(ed.scene), 'text/plain');
      downloadText('scene.mtl', exportMTL(ed.scene), 'text/plain');
      ed.setStatus('Exported scene.obj + scene.mtl');
    },
  },
  {
    id: 'file.exportStl', label: 'Export STL', category: 'File',
    run: (ed) => {
      downloadBinary('scene.stl', exportSTL(ed.scene), 'model/stl');
      ed.setStatus('Exported scene.stl');
    },
  },
  {
    id: 'file.exportGltf', label: 'Export glTF', category: 'File',
    run: (ed) => {
      downloadText('scene.gltf', exportGLTF(ed.scene), 'model/gltf+json');
      ed.setStatus('Exported scene.gltf');
    },
  },

  // ------------------------------------------------------------------- Edit
  { id: 'edit.undo', label: 'Undo', category: 'Edit', shortcut: 'Ctrl+Z', run: (ed) => ed.undo() },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', shortcut: 'Ctrl+Shift+Z', run: (ed) => ed.redo() },
  {
    id: 'edit.toggleMode', label: 'Toggle Edit Mode', category: 'Edit', shortcut: 'Tab',
    run: (ed) => ed.toggleEditMode(),
  },

  // -------------------------------------------------------------------- Add
  ...PRIMITIVES.map((p): Command => ({
    id: `add.${p.kind}`,
    label: p.label,
    category: 'Add',
    mode: 'object',
    run: (ed) => ed.addPrimitive(p.kind),
  })),
  { id: 'add.light.point', label: 'Point Light', category: 'Add', mode: 'object', run: (ed) => ed.addLight('point') },
  { id: 'add.light.sun', label: 'Sun', category: 'Add', mode: 'object', run: (ed) => ed.addLight('sun') },
  { id: 'add.light.spot', label: 'Spot Light', category: 'Add', mode: 'object', run: (ed) => ed.addLight('spot') },
  { id: 'add.light.area', label: 'Area Light', category: 'Add', mode: 'object', run: (ed) => ed.addLight('area') },
  { id: 'add.camera', label: 'Camera', category: 'Add', mode: 'object', run: (ed) => ed.addCamera() },
  { id: 'add.empty', label: 'Empty', category: 'Add', mode: 'object', run: (ed) => ed.addEmpty() },

  // ----------------------------------------------------------------- Select
  { id: 'select.all', label: 'Select All', category: 'Select', shortcut: 'A', run: (ed) => ed.selectAll() },
  { id: 'select.none', label: 'Deselect All', category: 'Select', shortcut: 'Alt+A', run: (ed) => ed.deselectAll() },
  { id: 'select.invert', label: 'Invert Selection', category: 'Select', shortcut: 'Ctrl+I', run: (ed) => ed.invertSelection() },
  {
    id: 'select.vertex', label: 'Vertex Select', category: 'Select', shortcut: '1', mode: 'edit',
    run: (ed) => ed.setSelectMode('vertex'),
  },
  {
    id: 'select.edge', label: 'Edge Select', category: 'Select', shortcut: '2', mode: 'edit',
    run: (ed) => ed.setSelectMode('edge'),
  },
  {
    id: 'select.face', label: 'Face Select', category: 'Select', shortcut: '3', mode: 'edit',
    run: (ed) => ed.setSelectMode('face'),
  },
  {
    id: 'select.linked', label: 'Select Linked', category: 'Select', shortcut: 'Ctrl+L', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const mesh = ed.editMesh;
      if (!mesh) return;
      const t = mesh.topology();
      const stack = [...ed.selection.verts];
      const seen = new Set(stack);
      while (stack.length) {
        const v = stack.pop()!;
        for (const ei of t.vertEdges[v] ?? []) {
          const e = t.edges[ei];
          const other = e.a === v ? e.b : e.a;
          if (!seen.has(other)) {
            seen.add(other);
            stack.push(other);
          }
        }
      }
      ed.selection.verts = seen;
      ed.syncSelection('vertex');
      ed.setStatus(`Selected linked (${seen.size} vertices)`);
    },
  },

  // ------------------------------------------------------------- Transforms
  { id: 'transform.move', label: 'Move', category: 'Object', shortcut: 'G', run: (ed) => ed.startTransform('translate') },
  { id: 'transform.rotate', label: 'Rotate', category: 'Object', shortcut: 'R', run: (ed) => ed.startTransform('rotate') },
  { id: 'transform.scale', label: 'Scale', category: 'Object', shortcut: 'S', run: (ed) => ed.startTransform('scale') },

  // ----------------------------------------------------------------- Object
  {
    id: 'object.delete', label: 'Delete', category: 'Object', mode: 'object', shortcut: 'X',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Delete objects', (scene) => {
      for (const id of [...scene.selection]) scene.remove(id);
      scene.selection.clear();
      scene.active = null;
    }),
  },
  {
    id: 'object.duplicate', label: 'Duplicate', category: 'Object', mode: 'object', shortcut: 'Shift+D',
    enabled: hasObjectSelection,
    run: (ed) => {
      ed.beginUndo('Duplicate objects');
      const scene = ed.scene;
      const copies: number[] = [];
      for (const src of scene.selectedObjects()) {
        const copy = scene.add(src.type, src.name.replace(/\.\d+$/, ''), src.mesh ? src.mesh.clone() : null);
        copy.position = src.position.clone();
        copy.rotation = src.rotation.clone();
        copy.scale = src.scale.clone();
        copy.modifiers = JSON.parse(JSON.stringify(src.modifiers));
        copy.materialSlots = [...src.materialSlots];
        copy.light = src.light ? { ...src.light } : null;
        copy.camera = src.camera ? { ...src.camera } : null;
        copies.push(copy.id);
      }
      scene.selection = new Set(copies);
      scene.active = copies[copies.length - 1] ?? null;
      ed.emit('change');
      ed.startTransform('translate', null, false);
    },
  },
  {
    id: 'object.join', label: 'Join', category: 'Object', mode: 'object', shortcut: 'Ctrl+J',
    enabled: (ed) => ed.scene.selection.size > 1,
    run: (ed) => objectOp(ed, 'Join objects', (scene) => {
      const active = scene.activeObject;
      if (!active || !active.mesh) return;
      const targetInverse = active.worldMatrix(scene).inverse();
      for (const src of scene.selectedObjects()) {
        if (src.id === active.id || !src.mesh) continue;
        const geo = src.mesh.clone();
        geo.transform(targetInverse.multiply(src.worldMatrix(scene)));
        const slotOffset = active.materialSlots.length;
        for (const s of src.materialSlots) active.materialSlots.push(s);
        active.mesh.append(geo, slotOffset);
        scene.remove(src.id);
      }
      active.invalidate();
      scene.selection = new Set([active.id]);
      scene.active = active.id;
    }),
  },
  {
    id: 'object.applyTransform', label: 'Apply Transform', category: 'Object', mode: 'object',
    shortcut: 'Ctrl+A', enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Apply transform', (scene) => {
      for (const obj of scene.selectedObjects()) {
        if (!obj.mesh) continue;
        obj.mesh.transform(obj.matrix());
        obj.position = new Vec3();
        obj.rotation = new Vec3();
        obj.scale = new Vec3(1, 1, 1);
        obj.invalidate();
      }
    }),
  },
  {
    id: 'object.originToGeometry', label: 'Origin to Geometry', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Origin to geometry', (scene) => {
      for (const obj of scene.selectedObjects()) {
        if (!obj.mesh) continue;
        const c = obj.mesh.bounds().center();
        obj.mesh.transform(Mat4.translation(c.neg()));
        obj.position = obj.position.add(obj.matrix().transformDirection(c));
        obj.invalidate();
      }
    }),
  },
  {
    id: 'object.originToCursor', label: 'Origin to 3D Cursor', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Origin to cursor', (scene) => {
      for (const obj of scene.selectedObjects()) {
        if (!obj.mesh) continue;
        const localCursor = obj.worldMatrix(scene).inverse().transformPoint(scene.cursor);
        obj.mesh.transform(Mat4.translation(localCursor.neg()));
        obj.position = scene.cursor.clone();
        obj.invalidate();
      }
    }),
  },
  {
    id: 'object.shadeSmooth', label: 'Shade Smooth', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Shade smooth', (scene) => {
      for (const o of scene.selectedObjects()) o.mesh?.setAllSmooth(true);
    }),
  },
  {
    id: 'object.shadeFlat', label: 'Shade Flat', category: 'Object', mode: 'object',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Shade flat', (scene) => {
      for (const o of scene.selectedObjects()) o.mesh?.setAllSmooth(false);
    }),
  },
  {
    id: 'object.hide', label: 'Hide Selected', category: 'Object', mode: 'object', shortcut: 'H',
    enabled: hasObjectSelection,
    run: (ed) => objectOp(ed, 'Hide', (scene) => {
      for (const o of scene.selectedObjects()) o.visible = false;
    }),
  },
  {
    id: 'object.unhide', label: 'Show All', category: 'Object', mode: 'object', shortcut: 'Alt+H',
    run: (ed) => objectOp(ed, 'Show all', (scene) => {
      for (const o of scene.objects.values()) o.visible = true;
    }),
  },

  // ------------------------------------------------------------------- Mesh
  {
    id: 'mesh.extrude', label: 'Extrude Region', category: 'Mesh', mode: 'edit', shortcut: 'E',
    enabled: hasEditSelection,
    run: (ed) => {
      const obj = ed.editObject;
      const mesh = ed.editMesh;
      if (!obj || !mesh) return;
      ed.beginUndo('Extrude');
      if (ed.selection.faces.size > 0) {
        const r = extrudeFaces(mesh, ed.selection.faces);
        ed.selection.verts = new Set(r.movedVerts);
        ed.syncSelection('vertex');
        ed.markGeometryDirty(obj);
        ed.startTransform('translate', null, false);
        const world = obj.worldMatrix(ed.scene).normalMatrix().transformDirection(r.normal);
        ed.currentTransform?.constrainTo(world, 'normal');
        ed.refreshTransform();
      } else if (ed.selection.edges.size > 0) {
        const moved = extrudeEdges(mesh, ed.selection.edges);
        ed.selection.verts = new Set(moved);
        ed.syncSelection('vertex');
        ed.markGeometryDirty(obj);
        ed.startTransform('translate', null, false);
      } else {
        ed.setStatus('Extrude needs an edge or face selection');
      }
    },
  },
  {
    id: 'mesh.inset', label: 'Inset Faces', category: 'Mesh', mode: 'edit', shortcut: 'I',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => ed.startInset(),
  },
  {
    id: 'mesh.loopcut', label: 'Loop Cut', category: 'Mesh', mode: 'edit', shortcut: 'Ctrl+R',
    run: (ed) => ed.startLoopCut(),
  },
  {
    id: 'mesh.subdivide', label: 'Subdivide', category: 'Mesh', mode: 'edit',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Subdivide', (mesh) => {
        const r = subdivideFaces(mesh, faces);
        for (const v of r.newVerts) ed.selection.verts.add(v);
      });
    },
  },
  {
    id: 'mesh.duplicate', label: 'Duplicate', category: 'Mesh', mode: 'edit', shortcut: 'Shift+D',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const obj = ed.editObject;
      const mesh = ed.editMesh;
      if (!obj || !mesh) return;
      ed.beginUndo('Duplicate');
      const r = duplicateFaces(mesh, ed.selection.faces);
      ed.selection.verts = new Set(r.verts);
      ed.syncSelection('vertex');
      ed.markGeometryDirty(obj);
      ed.startTransform('translate', null, false);
    },
  },
  {
    id: 'mesh.delete', label: 'Delete Selection', category: 'Mesh', mode: 'edit', shortcut: 'X',
    enabled: hasEditSelection,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      const edges = [...ed.selection.edges];
      const faces = [...ed.selection.faces];
      const mode = ed.selectMode;
      editOp(ed, `Delete ${mode === 'vertex' ? 'vertices' : mode === 'edge' ? 'edges' : 'faces'}`, (mesh) => {
        if (mode === 'vertex') deleteVertices(mesh, verts);
        else if (mode === 'edge') deleteEdges(mesh, edges);
        else deleteFaces(mesh, faces);
      });
      ed.clearElementSelection();
    },
  },
  {
    id: 'mesh.dissolve', label: 'Dissolve Faces', category: 'Mesh', mode: 'edit', shortcut: 'Ctrl+X',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 1,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Dissolve faces', (mesh) => {
        dissolveFaces(mesh, faces);
      });
    },
  },
  {
    id: 'mesh.merge', label: 'Merge at Centre', category: 'Mesh', mode: 'edit', shortcut: 'M',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.verts.size > 1,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Merge vertices', (mesh) => {
        mergeVertices(mesh, verts);
      });
      ed.clearElementSelection();
    },
  },
  {
    id: 'mesh.mergeByDistance', label: 'Merge by Distance', category: 'Mesh', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      let removed = 0;
      editOp(ed, 'Merge by distance', (mesh) => {
        removed = mergeByDistance(mesh, verts, 0.0001);
      });
      ed.clearElementSelection();
      ed.setStatus(`Merged ${removed} vertices`);
    },
  },
  {
    id: 'mesh.makeFace', label: 'New Face from Selection', category: 'Mesh', mode: 'edit', shortcut: 'F',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.verts.size >= 3,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Make face', (mesh) => {
        makeFace(mesh, verts);
      });
    },
  },
  {
    id: 'mesh.flipNormals', label: 'Flip Normals', category: 'Mesh', mode: 'edit',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Flip normals', (mesh) => flipNormals(mesh, faces));
    },
  },
  {
    id: 'mesh.recalcNormals', label: 'Recalculate Normals', category: 'Mesh', mode: 'edit', shortcut: 'Shift+N',
    run: (ed) => editOp(ed, 'Recalculate normals', (mesh) => recalculateNormals(mesh)),
  },
  {
    id: 'mesh.triangulate', label: 'Triangulate Faces', category: 'Mesh', mode: 'edit',
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Triangulate', (mesh) => triangulateFaces(mesh, faces));
    },
  },
  {
    id: 'mesh.smooth', label: 'Smooth Vertices', category: 'Mesh', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Smooth vertices', (mesh) => smoothVertices(mesh, verts, 0.5, 1));
    },
  },
  {
    id: 'mesh.selectFacesOfSelection', label: 'Select Faces of Vertices', category: 'Mesh', mode: 'edit',
    enabled: hasEditSelection,
    run: (ed) => {
      const mesh = ed.editMesh;
      if (!mesh) return;
      const t = mesh.topology();
      const faces = new Set<number>();
      for (const v of ed.selection.verts) for (const f of t.vertFaces[v] ?? []) faces.add(f);
      ed.selection.verts = facesToVerts(mesh, faces);
      ed.syncSelection('vertex');
    },
  },

  // ------------------------------------------------------------------- View
  { id: 'view.frameSelected', label: 'Frame Selected', category: 'View', shortcut: '.', run: (ed) => ed.frameSelected() },
  { id: 'view.frameAll', label: 'Frame All', category: 'View', shortcut: 'Home', run: (ed) => ed.frameAll() },
  { id: 'view.front', label: 'Front', category: 'View', shortcut: 'Numpad 1', run: (ed) => { ed.camera.setAxisView('front'); ed.requestRender(); } },
  { id: 'view.back', label: 'Back', category: 'View', shortcut: 'Ctrl+Numpad 1', run: (ed) => { ed.camera.setAxisView('back'); ed.requestRender(); } },
  { id: 'view.right', label: 'Right', category: 'View', shortcut: 'Numpad 3', run: (ed) => { ed.camera.setAxisView('right'); ed.requestRender(); } },
  { id: 'view.left', label: 'Left', category: 'View', shortcut: 'Ctrl+Numpad 3', run: (ed) => { ed.camera.setAxisView('left'); ed.requestRender(); } },
  { id: 'view.top', label: 'Top', category: 'View', shortcut: 'Numpad 7', run: (ed) => { ed.camera.setAxisView('top'); ed.requestRender(); } },
  { id: 'view.bottom', label: 'Bottom', category: 'View', shortcut: 'Ctrl+Numpad 7', run: (ed) => { ed.camera.setAxisView('bottom'); ed.requestRender(); } },
  {
    id: 'view.ortho', label: 'Toggle Orthographic', category: 'View', shortcut: 'Numpad 5',
    run: (ed) => {
      ed.camera.orthographic = !ed.camera.orthographic;
      ed.requestRender();
      ed.emit('change');
      ed.setStatus(ed.camera.orthographic ? 'Orthographic' : 'Perspective');
    },
  },
  {
    id: 'view.camera', label: 'Look Through Camera', category: 'View', shortcut: 'Numpad 0',
    run: (ed) => {
      const cam = [...ed.scene.objects.values()].find((o) => o.type === 'camera');
      if (!cam) {
        ed.setStatus('No camera in the scene');
        return;
      }
      ed.camera.lockedMatrix = ed.camera.lockedMatrix ? null : cam.worldMatrix(ed.scene);
      ed.requestRender();
      ed.setStatus(ed.camera.lockedMatrix ? `Looking through ${cam.name}` : 'Free view');
    },
  },
  {
    id: 'view.shading', label: 'Cycle Shading', category: 'View', shortcut: 'Z',
    run: (ed) => ed.cycleShading(),
  },
  {
    id: 'view.xray', label: 'Toggle X-Ray', category: 'View', shortcut: 'Alt+Z',
    run: (ed) => {
      ed.options.xray = !ed.options.xray;
      ed.emit('change');
      ed.requestRender();
      ed.setStatus(`X-ray ${ed.options.xray ? 'on' : 'off'}`);
    },
  },
  {
    id: 'view.grid', label: 'Toggle Grid', category: 'View',
    run: (ed) => {
      ed.options.showGrid = !ed.options.showGrid;
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.overlays', label: 'Toggle Overlays', category: 'View',
    run: (ed) => {
      ed.options.showOverlays = !ed.options.showOverlays;
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.wireframeOverlay', label: 'Toggle Wireframe Overlay', category: 'View',
    run: (ed) => {
      ed.options.showObjectWireframe = !ed.options.showObjectWireframe;
      for (const id of ed.scene.objects.keys()) ed.renderer.invalidate(id);
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'view.cursorToOrigin', label: '3D Cursor to World Origin', category: 'View', shortcut: 'Shift+C',
    run: (ed) => {
      ed.beginUndo('Cursor to origin');
      ed.scene.cursor = new Vec3();
      ed.frameAll();
      ed.emit('change');
    },
  },
];

export const COMMANDS_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function runCommand(editor: Editor, id: string): void {
  const cmd = COMMANDS_BY_ID.get(id);
  if (!cmd) return;
  if (cmd.enabled && !cmd.enabled(editor)) {
    editor.setStatus(`${cmd.label} is not available right now`);
    return;
  }
  void cmd.run(editor);
}

/** Normalise a keyboard event into a lookup string such as "ctrl+shift+z". */
export function keyChord(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  // Lowercase everything so named keys ("Tab", "Home") match the keymap too.
  let key = e.key.toLowerCase();
  if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') key = e.code.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

interface KeyBinding {
  chord: string;
  command: string;
  mode?: 'object' | 'edit';
}

export const KEYMAP: KeyBinding[] = [
  { chord: 'tab', command: 'edit.toggleMode' },
  { chord: 'ctrl+z', command: 'edit.undo' },
  { chord: 'ctrl+shift+z', command: 'edit.redo' },
  { chord: 'ctrl+y', command: 'edit.redo' },
  { chord: 'ctrl+s', command: 'file.save' },
  { chord: 'ctrl+o', command: 'file.open' },
  { chord: 'g', command: 'transform.move' },
  { chord: 'r', command: 'transform.rotate' },
  { chord: 's', command: 'transform.scale' },
  { chord: 'a', command: 'select.all' },
  { chord: 'alt+a', command: 'select.none' },
  { chord: 'ctrl+i', command: 'select.invert' },
  { chord: 'ctrl+l', command: 'select.linked', mode: 'edit' },
  { chord: '1', command: 'select.vertex', mode: 'edit' },
  { chord: '2', command: 'select.edge', mode: 'edit' },
  { chord: '3', command: 'select.face', mode: 'edit' },
  { chord: 'e', command: 'mesh.extrude', mode: 'edit' },
  { chord: 'i', command: 'mesh.inset', mode: 'edit' },
  { chord: 'ctrl+r', command: 'mesh.loopcut', mode: 'edit' },
  { chord: 'm', command: 'mesh.merge', mode: 'edit' },
  { chord: 'f', command: 'mesh.makeFace', mode: 'edit' },
  { chord: 'shift+n', command: 'mesh.recalcNormals', mode: 'edit' },
  { chord: 'ctrl+x', command: 'mesh.dissolve', mode: 'edit' },
  { chord: 'x', command: 'mesh.delete', mode: 'edit' },
  { chord: 'delete', command: 'mesh.delete', mode: 'edit' },
  { chord: 'shift+d', command: 'mesh.duplicate', mode: 'edit' },
  { chord: 'x', command: 'object.delete', mode: 'object' },
  { chord: 'delete', command: 'object.delete', mode: 'object' },
  { chord: 'shift+d', command: 'object.duplicate', mode: 'object' },
  { chord: 'ctrl+j', command: 'object.join', mode: 'object' },
  { chord: 'ctrl+a', command: 'object.applyTransform', mode: 'object' },
  { chord: 'h', command: 'object.hide', mode: 'object' },
  { chord: 'alt+h', command: 'object.unhide', mode: 'object' },
  { chord: 'z', command: 'view.shading' },
  { chord: 'alt+z', command: 'view.xray' },
  { chord: '.', command: 'view.frameSelected' },
  { chord: 'numpaddecimal', command: 'view.frameSelected' },
  { chord: 'home', command: 'view.frameAll' },
  { chord: 'numpad1', command: 'view.front' },
  { chord: 'ctrl+numpad1', command: 'view.back' },
  { chord: 'numpad3', command: 'view.right' },
  { chord: 'ctrl+numpad3', command: 'view.left' },
  { chord: 'numpad7', command: 'view.top' },
  { chord: 'ctrl+numpad7', command: 'view.bottom' },
  { chord: 'numpad5', command: 'view.ortho' },
  { chord: 'numpad0', command: 'view.camera' },
  { chord: 'shift+c', command: 'view.cursorToOrigin' },
];

/** Resolve a key event to a command id, honouring the current mode. */
export function lookupKey(chord: string, mode: 'object' | 'edit'): string | null {
  const exact = KEYMAP.find((k) => k.chord === chord && k.mode === mode);
  if (exact) return exact.command;
  const generic = KEYMAP.find((k) => k.chord === chord && !k.mode);
  return generic ? generic.command : null;
}
