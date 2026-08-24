import { Mat4, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { PRIMITIVES } from '../mesh/primitives';
import {
  deleteEdges, deleteFaces, deleteVertices, dissolveFaces, duplicateFaces, extrudeEdges,
  extrudeFaces, facesToVerts, flipNormals, makeFace, mergeByDistance, mergeVertices,
  recalculateNormals, smoothVertices, subdivideFaces, triangulateFaces,
} from '../mesh/ops';
import { Scene } from '../scene/Scene';
import { bevelVertices, markBevelWeight } from '../mesh/bevel';
import { voxelRemesh, voxelSizeForTarget } from '../mesh/remesh';
import { BooleanOp, dissolveCoplanar, isSolid, meshBoolean, stitchTJunctions } from '../mesh/boolean';
import { bisect, bridgeLoops, pokeFaces, spinEdges, symmetrize } from '../mesh/modeling';
import { decimate } from '../mesh/decimate';
import {
  cubeProject, cylinderProject, markSeams, planarProject, smartProject, sphereProject, unwrap,
} from '../uv/unwrap';
import { generateCheckerTexture, loadTextureFile } from '../scene/Texture';
import { FALLOFF_LABELS, FalloffType } from './proportional';
import { SNAP_LABELS, SnapMode } from './snapping';
import { BRUSH_LABELS, SculptBrush } from '../sculpt/sculpt';
import { pickFile } from '../io/files';
import { preserveUV, transferUV } from '../uv/transfer';
import { downloadBinary, downloadText, openTextFile } from '../io/files';
import { exportMTL, exportOBJ, importOBJ } from '../io/obj';
import { exportSTL } from '../io/stl';
import { exportGLTF } from '../io/gltf';
import { Editor, EditorMode } from './Editor';
import { pruneSelection } from './selection';

export interface Command {
  id: string;
  label: string;
  category: 'File' | 'Edit' | 'Add' | 'Object' | 'Mesh' | 'Rig' | 'Select' | 'View';
  shortcut?: string;
  /** Which mode the command applies to; omitted means every mode. */
  mode?: EditorMode;
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
  // Anything the operator cannot carry exactly is resampled off the pre-edit
  // surface, so an unwrapped model survives being modelled on.
  preserveUV(mesh, () => fn(mesh));
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
  { id: 'add.armature', label: 'Armature', category: 'Add', mode: 'object', run: (ed) => ed.addArmature() },

  // ---------------------------------------------------------------- Rigging
  {
    id: 'rig.extrudeBone', label: 'Add Bone', category: 'Rig', mode: 'object',
    run: (ed) => ed.extrudeBone(),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.bind', label: 'Bind to Armature (automatic weights)', category: 'Rig', mode: 'object',
    run: (ed) => ed.bindToArmature(),
    enabled: (ed) => !!ed.activeArmature && ed.scene.selection.size >= 2,
  },
  {
    id: 'rig.clearPose', label: 'Clear Pose', category: 'Rig', mode: 'object',
    run: (ed) => ed.clearArmaturePose(),
    enabled: (ed) => !!ed.activeArmature,
  },
  {
    id: 'rig.nextBone', label: 'Next Bone', category: 'Rig',
    run: (ed) => {
      const rig = ed.activeArmature;
      if (!rig?.armature || rig.armature.bones.length === 0) return;
      ed.activeBone = (ed.activeBone + 1) % rig.armature.bones.length;
      ed.setStatus(`Active bone: ${rig.armature.bones[ed.activeBone].name}`);
      ed.emit('change');
      ed.requestRender();
    },
    enabled: (ed) => !!ed.activeArmature,
  },

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
    id: 'mesh.knife', label: 'Knife', category: 'Mesh', mode: 'edit', shortcut: 'K',
    run: (ed) => ed.startKnife(),
    enabled: (ed) => ed.mode === 'edit',
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

  // ------------------------------------------------------- Mesh: hard surface
  {
    id: 'mesh.bevel', label: 'Bevel', category: 'Mesh', shortcut: 'Ctrl+B', mode: 'edit',
    run: (ed) => ed.startBevel(),
    enabled: (ed) => ed.mode === 'edit' && (ed.selection.edges.size > 0 || ed.selection.faces.size > 0),
  },
  {
    id: 'mesh.bevelWeightFull', label: 'Set Bevel Weight: Full', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Set bevel weight', (mesh) => {
        markBevelWeight(mesh, edges, 1);
      });
      ed.setStatus(`${edges.length} edge${edges.length === 1 ? '' : 's'} back to full bevel width`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.bevelWeightHalf', label: 'Set Bevel Weight: Half', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Set bevel weight', (mesh) => {
        markBevelWeight(mesh, edges, 0.5);
      });
      ed.setStatus(`${edges.length} edge${edges.length === 1 ? '' : 's'} set to half bevel width`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.bevelWeightNone', label: 'Set Bevel Weight: None', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Set bevel weight', (mesh) => {
        markBevelWeight(mesh, edges, 0);
      });
      ed.setStatus(`${edges.length} edge${edges.length === 1 ? '' : 's'} excluded from bevels`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.bevelVertices', label: 'Bevel Vertices', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const verts = [...ed.selection.verts];
      editOp(ed, 'Bevel vertices', (mesh) => {
        bevelVertices(mesh, verts, 0.08);
      });
    },
    enabled: hasEditSelection,
  },
  {
    id: 'mesh.bisect', label: 'Bisect at 3D Cursor (view aligned)', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const obj = ed.editObject;
      if (!obj) return;
      // The cut plane faces the camera and passes through the 3D cursor, which
      // is the one plane the user can position without a gizmo.
      const inv = obj.worldMatrix(ed.scene).inverse();
      const normal = inv.transformDirection(ed.camera.forward()).normalized();
      const point = inv.transformPoint(ed.scene.cursor);
      editOp(ed, 'Bisect', (mesh) => {
        bisect(mesh, normal, normal.dot(point), { fill: true });
      });
    },
  },
  {
    id: 'mesh.bisectCut', label: 'Bisect and Remove Front Half', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const obj = ed.editObject;
      if (!obj) return;
      const inv = obj.worldMatrix(ed.scene).inverse();
      const normal = inv.transformDirection(ed.camera.forward()).normalized();
      const point = inv.transformPoint(ed.scene.cursor);
      editOp(ed, 'Bisect (cut)', (mesh) => {
        bisect(mesh, normal, normal.dot(point), { fill: true, clearBack: true });
      });
    },
  },
  {
    id: 'mesh.spin', label: 'Spin Selected Edges Around Z', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const obj = ed.editObject;
      if (!obj) return;
      const edges = [...ed.selection.edges];
      if (edges.length === 0) {
        ed.setStatus('Spin needs an edge selection');
        return;
      }
      const inv = obj.worldMatrix(ed.scene).inverse();
      const center = inv.transformPoint(ed.scene.cursor);
      editOp(ed, 'Spin', (mesh) => {
        spinEdges(mesh, edges, new Vec3(0, 0, 1), center, Math.PI * 2, 16);
      });
    },
  },
  {
    id: 'mesh.bridge', label: 'Bridge Edge Loops', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      let problem: string | undefined;
      editOp(ed, 'Bridge loops', (mesh) => {
        problem = bridgeLoops(mesh, edges).error;
      });
      if (problem) ed.setStatus(problem);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'mesh.poke', label: 'Poke Faces', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const faces = [...ed.selection.faces];
      editOp(ed, 'Poke faces', (mesh) => {
        pokeFaces(mesh, faces, 0);
      });
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.faces.size > 0,
  },
  {
    id: 'mesh.symmetrizeX', label: 'Symmetrize +X to -X', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Symmetrize', (mesh) => symmetrize(mesh, 0, true)),
  },
  {
    id: 'mesh.limitedDissolve', label: 'Limited Dissolve (merge coplanar)', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      let merged = 0;
      editOp(ed, 'Limited dissolve', (mesh) => {
        merged = dissolveCoplanar(mesh, 1.5);
      });
      ed.setStatus(`Limited dissolve: ${merged} face${merged === 1 ? '' : 's'} merged`);
    },
  },
  {
    id: 'mesh.stitch', label: 'Fix T-Junctions', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      let n = 0;
      editOp(ed, 'Fix T-junctions', (mesh) => {
        const scale = Math.max(1e-6, mesh.bounds().radius());
        n = stitchTJunctions(mesh, 1e-4 * scale);
      });
      ed.setStatus(n ? `Stitched ${n} vertices into their neighbours' edges` : 'No T-junctions found');
    },
  },

  // ------------------------------------------------------------------- UV
  {
    id: 'uv.unwrap', label: 'Unwrap (conformal, respects seams)', category: 'Mesh', shortcut: 'U', mode: 'edit',
    run: (ed) => {
      let islands = 0;
      editOp(ed, 'Unwrap', (mesh) => {
        islands = unwrap(mesh, { useSeams: true, angleLimit: 66, margin: 0.01 });
      });
      ed.setStatus(`Unwrapped into ${islands} island${islands === 1 ? '' : 's'}`);
    },
  },
  {
    id: 'uv.smart', label: 'Smart UV Project', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      let islands = 0;
      editOp(ed, 'Smart UV project', (mesh) => {
        islands = smartProject(mesh, 66, 0.01);
      });
      ed.setStatus(`Projected ${islands} island${islands === 1 ? '' : 's'}`);
    },
  },
  {
    id: 'uv.cube', label: 'Cube Project', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Cube project', (mesh) => cubeProject(mesh, Math.max(0.001, mesh.bounds().radius()))),
  },
  {
    id: 'uv.cylinder', label: 'Cylinder Project', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Cylinder project', (mesh) => cylinderProject(mesh)),
  },
  {
    id: 'uv.sphere', label: 'Sphere Project', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Sphere project', (mesh) => sphereProject(mesh)),
  },
  {
    id: 'uv.planar', label: 'Planar Project (top)', category: 'Mesh', mode: 'edit',
    run: (ed) => editOp(ed, 'Planar project', (mesh) => planarProject(mesh, 2)),
  },
  {
    id: 'uv.markSeam', label: 'Mark Seam', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Mark seam', (mesh) => {
        markSeams(mesh, edges, true);
      });
      ed.setStatus(`Marked ${edges.length} seam edge${edges.length === 1 ? '' : 's'}`);
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'uv.clearSeam', label: 'Clear Seam', category: 'Mesh', mode: 'edit',
    run: (ed) => {
      const edges = [...ed.selection.edges];
      editOp(ed, 'Clear seam', (mesh) => {
        markSeams(mesh, edges, false);
      });
    },
    enabled: (ed) => ed.mode === 'edit' && ed.selection.edges.size > 0,
  },
  {
    id: 'view.uvCheck', label: 'Toggle UV Checker', category: 'View',
    run: (ed) => {
      ed.options.uvCheck = !ed.options.uvCheck;
      ed.setStatus(`UV checker ${ed.options.uvCheck ? 'on' : 'off'}`);
      ed.emit('change');
      ed.requestRender();
    },
  },

  // -------------------------------------------------------------- Booleans
  {
    id: 'object.booleanDifference', label: 'Boolean Difference', category: 'Object', mode: 'object',
    run: (ed) => runBoolean(ed, 'difference'),
    enabled: (ed) => ed.scene.selection.size >= 2,
  },
  {
    id: 'object.booleanUnion', label: 'Boolean Union', category: 'Object', mode: 'object',
    run: (ed) => runBoolean(ed, 'union'),
    enabled: (ed) => ed.scene.selection.size >= 2,
  },
  {
    id: 'object.booleanIntersect', label: 'Boolean Intersect', category: 'Object', mode: 'object',
    run: (ed) => runBoolean(ed, 'intersect'),
    enabled: (ed) => ed.scene.selection.size >= 2,
  },
  {
    id: 'object.decimate', label: 'Decimate to Half', category: 'Object', mode: 'object',
    run: (ed) => {
      const objs = ed.scene.selectedObjects().filter((o) => o.mesh);
      if (objs.length === 0) return;
      objectOp(ed, 'Decimate', () => {
        for (const o of objs) {
          if (!o.mesh) continue;
          const before = o.mesh;
          o.mesh = decimate(before, 0.5);
          transferUV(before, o.mesh);
        }
      });
      const total = objs.reduce((n, o) => n + (o.mesh?.triCount ?? 0), 0);
      ed.setStatus(`Decimated to ${total} triangles`);
    },
    enabled: hasObjectSelection,
  },

  // -------------------------------------------------------------- Textures
  {
    id: 'material.checker', label: 'Add UV Checker Texture', category: 'Object',
    run: (ed) => {
      const obj = ed.scene.activeObject;
      const slot = obj?.materialSlots[0] ?? 0;
      const mat = ed.scene.materials[slot];
      if (!mat) {
        ed.setStatus('No material to texture');
        return;
      }
      objectOp(ed, 'Add checker texture', (scene) => {
        const tex = generateCheckerTexture(512, 8);
        scene.textures.push(tex);
        mat.baseColorTexture = tex.id;
      });
      ed.setStatus(`Checker texture on ${mat.name}`);
    },
  },
  {
    id: 'material.loadTexture', label: 'Load Image Texture', category: 'Object',
    run: async (ed) => {
      const file = await pickFile('image/*');
      if (!file) return;
      const tex = await loadTextureFile(file);
      const obj = ed.scene.activeObject;
      const slot = obj?.materialSlots[0] ?? 0;
      const mat = ed.scene.materials[slot];
      objectOp(ed, 'Load texture', (scene) => {
        scene.textures.push(tex);
        if (mat) mat.baseColorTexture = tex.id;
      });
      ed.setStatus(`Loaded ${tex.name} (${tex.width}×${tex.height})`);
    },
  },

  // ------------------------------------------------------------- Animation
  {
    id: 'anim.insertKey', label: 'Insert Keyframe', category: 'Object', shortcut: 'I', mode: 'object',
    run: (ed) => ed.insertKeyframe('all'),
    enabled: hasObjectSelection,
  },
  {
    id: 'anim.insertLocKey', label: 'Insert Location Keyframe', category: 'Object', mode: 'object',
    run: (ed) => ed.insertKeyframe('position'),
    enabled: hasObjectSelection,
  },
  {
    id: 'anim.deleteKey', label: 'Delete Keyframe', category: 'Object', shortcut: 'Alt+I', mode: 'object',
    run: (ed) => ed.deleteKeyframe(),
    enabled: hasObjectSelection,
  },
  {
    id: 'anim.play', label: 'Play / Pause Animation', category: 'View', shortcut: 'Space',
    run: (ed) => ed.togglePlayback(),
  },
  {
    id: 'anim.nextFrame', label: 'Next Frame', category: 'View', shortcut: 'Right',
    run: (ed) => ed.stepFrame(1),
  },
  {
    id: 'anim.prevFrame', label: 'Previous Frame', category: 'View', shortcut: 'Left',
    run: (ed) => ed.stepFrame(-1),
  },
  {
    id: 'anim.jumpStart', label: 'Jump to Start', category: 'View', shortcut: 'Shift+Left',
    run: (ed) => ed.setFrame(ed.scene.timeline.start),
  },
  {
    id: 'anim.jumpEnd', label: 'Jump to End', category: 'View', shortcut: 'Shift+Right',
    run: (ed) => ed.setFrame(ed.scene.timeline.end),
  },

  // ---------------------------------------------------------------- Render
  {
    id: 'render.image', label: 'Render Image', category: 'View', shortcut: 'F12',
    run: (ed) => ed.startRender(true),
  },
  {
    id: 'render.viewport', label: 'Render Current View', category: 'View',
    run: (ed) => ed.startRender(false),
  },
  {
    id: 'render.cancel', label: 'Cancel Render', category: 'View',
    run: (ed) => ed.cancelRender(),
    enabled: (ed) => ed.activeRender !== null && !ed.activeRender.finished,
  },

  // ----------------------------------------------------------------- Modes
  {
    id: 'mode.object', label: 'Object Mode', category: 'Edit',
    run: (ed) => ed.setMode('object'),
  },
  {
    id: 'mode.edit', label: 'Edit Mode', category: 'Edit',
    run: (ed) => ed.setMode('edit'),
  },
  {
    id: 'mode.sculpt', label: 'Sculpt Mode', category: 'Edit',
    run: (ed) => ed.setMode('sculpt'),
  },

  // ------------------------------------------------------- Sculpt & options
  {
    id: 'sculpt.cycleBrush', label: 'Next Sculpt Brush', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const order = Object.keys(BRUSH_LABELS) as SculptBrush[];
      const next = order[(order.indexOf(ed.sculpt.brush) + 1) % order.length];
      ed.setSculptBrush(next);
    },
  },
  {
    id: 'sculpt.radiusUp', label: 'Larger Brush', category: 'Edit', shortcut: ']', mode: 'sculpt',
    run: (ed) => ed.adjustBrushRadius(1.15),
  },
  {
    id: 'sculpt.radiusDown', label: 'Smaller Brush', category: 'Edit', shortcut: '[', mode: 'sculpt',
    run: (ed) => ed.adjustBrushRadius(1 / 1.15),
  },
  {
    id: 'sculpt.symmetryX', label: 'Toggle X Symmetry', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      ed.sculpt.symmetry[0] = !ed.sculpt.symmetry[0];
      ed.setStatus(`X symmetry ${ed.sculpt.symmetry[0] ? 'on' : 'off'}`);
      ed.emit('change');
    },
  },
  {
    id: 'sculpt.remesh', label: 'Voxel Remesh', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const obj = ed.editObject ?? ed.scene.get(ed.scene.active ?? -1);
      const mesh = obj?.mesh;
      if (!obj || !mesh || mesh.faceCount === 0) {
        ed.setStatus('Nothing to remesh');
        return;
      }
      const before = mesh.faceCount;
      const t0 = Date.now();
      ed.beginUndo('Voxel remesh');
      // Aim for a similar triangle count to what is already there, with a
      // floor: remeshing a cube is pointless at six faces' worth of detail.
      const target = Math.max(20000, Math.min(400000, mesh.triCount));
      const rebuilt = voxelRemesh(mesh, { voxelSize: voxelSizeForTarget(mesh, target) });
      if (rebuilt.faceCount === 0) {
        ed.setStatus('Remesh produced nothing — the mesh may not enclose a volume');
        return;
      }
      obj.mesh = rebuilt;
      ed.markGeometryDirty(obj);
      ed.setStatus(
        `Remeshed ${before} faces into ${rebuilt.faceCount} in ${Date.now() - t0}ms — UVs were reset`,
      );
      ed.emit('change');
    },
  },
  {
    id: 'sculpt.clearMask', label: 'Clear Sculpt Mask', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const mesh = (ed.editObject ?? ed.scene.get(ed.scene.active ?? -1))?.mesh;
      if (!mesh || !mesh.mask) {
        ed.setStatus('Nothing is masked');
        return;
      }
      ed.beginUndo('Clear mask');
      mesh.mask = null;
      mesh.markDirty();
      ed.setStatus('Mask cleared');
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'sculpt.invertMask', label: 'Invert Sculpt Mask', category: 'Edit', mode: 'sculpt',
    run: (ed) => {
      const mesh = (ed.editObject ?? ed.scene.get(ed.scene.active ?? -1))?.mesh;
      if (!mesh) return;
      ed.beginUndo('Invert mask');
      const mask = mesh.ensureMask();
      for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i];
      mesh.markDirty();
      ed.setStatus('Mask inverted');
      ed.emit('change');
      ed.requestRender();
    },
  },
  {
    id: 'transform.proportional', label: 'Toggle Proportional Editing', category: 'Edit', shortcut: 'O', mode: 'edit',
    run: (ed) => ed.toggleProportional(),
  },
  {
    id: 'transform.falloff', label: 'Next Proportional Falloff', category: 'Edit', mode: 'edit',
    run: (ed) => {
      const order = Object.keys(FALLOFF_LABELS) as FalloffType[];
      const next = order[(order.indexOf(ed.proportional.falloff) + 1) % order.length];
      ed.proportional.falloff = next;
      ed.setStatus(`Falloff: ${FALLOFF_LABELS[next]}`);
      ed.emit('change');
    },
  },
  {
    id: 'transform.snap', label: 'Toggle Snapping', category: 'Edit', shortcut: 'Shift+Tab',
    run: (ed) => {
      ed.snap.enabled = !ed.snap.enabled;
      ed.setStatus(`Snapping ${ed.snap.enabled ? `on (${SNAP_LABELS[ed.snap.mode]})` : 'off'}`);
      ed.emit('change');
    },
  },
  {
    id: 'transform.snapMode', label: 'Next Snap Target', category: 'Edit',
    run: (ed) => {
      const order = Object.keys(SNAP_LABELS) as SnapMode[];
      const next = order[(order.indexOf(ed.snap.mode) + 1) % order.length];
      ed.snap.mode = next;
      ed.setStatus(`Snap to ${SNAP_LABELS[next]}`);
      ed.emit('change');
    },
  },
  {
    id: 'file.autosave', label: 'Save Recovery Copy Now', category: 'File',
    run: (ed) => ed.autosaveNow(true),
  },
];

/**
 * Boolean between the active object and everything else selected. The active
 * object keeps its name and modifiers; the cutters are consumed.
 */
function runBoolean(ed: Editor, op: BooleanOp): void {
  const scene = ed.scene;
  const target = scene.activeObject;
  if (!target || !target.mesh) {
    ed.setStatus('Boolean needs an active mesh object');
    return;
  }
  const cutters = scene.selectedObjects().filter((o) => o !== target && o.type === 'mesh' && o.mesh);
  if (cutters.length === 0) {
    ed.setStatus('Select a second object to use as the cutter');
    return;
  }
  // An open surface has no inside, so the classification has nothing to go on.
  // Say so rather than returning something that only looks like a mistake.
  const open = [target, ...cutters].filter((o) => o.mesh && !isSolid(o.mesh));
  if (open.length > 0) {
    ed.setStatus(
      `${open.map((o) => o.name).join(', ')} ${open.length === 1 ? 'is not a closed solid' : 'are not closed solids'}`
      + ' — a boolean needs a watertight mesh on both sides.',
    );
    return;
  }
  objectOp(ed, `Boolean ${op}`, () => {
    const toLocal = target.worldMatrix(scene).inverse();
    let result = target.mesh!;
    for (const cutter of cutters) {
      const other = (cutter.evaluated(false) ?? cutter.mesh!).clone();
      other.transform(toLocal.multiply(cutter.worldMatrix(scene)));
      const before = result;
      result = meshBoolean(before, other, op);
      // The cut face is new geometry; sample it off whichever operand it
      // came from so a textured model survives being carved.
      transferUV(before, result);
      transferUV(other, result);
    }
    target.mesh = result;
    for (const c of cutters) scene.remove(c.id);
    scene.selection = new Set([target.id]);
    scene.active = target.id;
  });
  ed.setStatus(`Boolean ${op}: ${target.mesh.faceCount} faces`);
}


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
  // Give the keys whose `key` value reads badly in a shortcut label a short
  // name, so the keymap and the sheet can use the same spelling.
  if (key === ' ') key = 'space';
  else if (key.startsWith('arrow')) key = key.slice(5);
  parts.push(key);
  return parts.join('+');
}

interface KeyBinding {
  chord: string;
  command: string;
  mode?: EditorMode;
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
  { chord: 'ctrl+b', command: 'mesh.bevel', mode: 'edit' },
  { chord: 'u', command: 'uv.unwrap', mode: 'edit' },
  { chord: 'o', command: 'transform.proportional', mode: 'edit' },
  { chord: 'shift+tab', command: 'transform.snap' },
  { chord: 'i', command: 'anim.insertKey', mode: 'object' },
  { chord: 'alt+i', command: 'anim.deleteKey', mode: 'object' },
  { chord: 'space', command: 'anim.play' },
  { chord: 'right', command: 'anim.nextFrame' },
  { chord: 'left', command: 'anim.prevFrame' },
  { chord: 'shift+left', command: 'anim.jumpStart' },
  { chord: 'shift+right', command: 'anim.jumpEnd' },
  { chord: 'f12', command: 'render.image' },
  { chord: 'k', command: 'mesh.knife', mode: 'edit' },
  { chord: ']', command: 'sculpt.radiusUp', mode: 'sculpt' },
  { chord: '[', command: 'sculpt.radiusDown', mode: 'sculpt' },
  { chord: 'b', command: 'sculpt.cycleBrush', mode: 'sculpt' },
];

/** Resolve a key event to a command id, honouring the current mode. */
export function lookupKey(chord: string, mode: EditorMode): string | null {
  const exact = KEYMAP.find((k) => k.chord === chord && k.mode === mode);
  if (exact) return exact.command;
  const generic = KEYMAP.find((k) => k.chord === chord && !k.mode);
  return generic ? generic.command : null;
}
