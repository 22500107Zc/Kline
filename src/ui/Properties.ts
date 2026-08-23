import { RAD2DEG, DEG2RAD, Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { MODIFIER_LABELS, Modifier, ModifierType, createModifier } from '../modifiers';
import { createMaterial, hexToLinear, linearToHex } from '../scene/Material';
import { LightType, SceneObject } from '../scene/Scene';
import { button, checkbox, clear, h, numberField, row, select } from './dom';
import { icon } from './icons';

type Tab = 'object' | 'modifiers' | 'material' | 'world';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'object', label: 'Object', icon: 'mesh' },
  { id: 'modifiers', label: 'Modifiers', icon: 'modifier' },
  { id: 'material', label: 'Material', icon: 'material' },
  { id: 'world', label: 'Scene', icon: 'world' },
];

/** The right-hand properties editor. Rebuilds on every change — it is small. */
export class Properties {
  readonly root = h('div', { class: 'panel properties' });
  private tab: Tab = 'object';
  private body = h('div', { class: 'prop-body' });
  private tabBar = h('div', { class: 'tab-bar' });

  constructor(private editor: Editor) {
    this.root.appendChild(this.tabBar);
    this.root.appendChild(this.body);
    this.buildTabs();
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  private buildTabs(): void {
    clear(this.tabBar);
    for (const t of TABS) {
      this.tabBar.appendChild(h('button', {
        class: `tab${this.tab === t.id ? ' active' : ''}`,
        title: t.label,
        on: {
          click: () => {
            this.tab = t.id;
            this.buildTabs();
            this.refresh();
          },
        },
      }, [icon(t.icon), h('span', { text: t.label })]));
    }
  }

  refresh(): void {
    clear(this.body);
    const obj = this.editor.scene.activeObject;
    switch (this.tab) {
      case 'object': this.buildObjectTab(obj); break;
      case 'modifiers': this.buildModifierTab(obj); break;
      case 'material': this.buildMaterialTab(obj); break;
      case 'world': this.buildWorldTab(); break;
    }
  }

  private section(title: string, children: (HTMLElement | null)[]): HTMLElement {
    return h('section', { class: 'prop-section' }, [
      h('h3', { class: 'prop-heading', text: title }),
      ...children,
    ]);
  }

  private emptyState(message: string, hint: string): HTMLElement {
    return h('div', { class: 'empty-state' }, [
      h('p', { text: message }),
      h('p', { class: 'dim', text: hint }),
    ]);
  }

  // ------------------------------------------------------------------ object

  private buildObjectTab(obj: SceneObject | null): void {
    if (!obj) {
      this.body.appendChild(this.emptyState(
        'No active object.',
        'Click an object in the viewport or the outliner to edit it.',
      ));
      return;
    }
    const ed = this.editor;

    const nameInput = h('input', { class: 'text-input', value: obj.name, type: 'text' });
    nameInput.addEventListener('change', () => {
      ed.beginUndo('Rename object');
      obj.name = nameInput.value.trim() || obj.name;
      ed.emit('change');
    });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());

    this.body.appendChild(this.section('Identity', [
      row('Name', nameInput),
      checkbox('Visible in viewport', obj.visible, (v) => {
        ed.beginUndo('Toggle visibility');
        obj.visible = v;
        ed.requestRender();
        ed.emit('change');
      }),
    ]));

    const vectorRow = (
      label: string, get: () => Vec3, set: (v: Vec3) => void, step: number, scale = 1,
    ): HTMLElement => {
      const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
      const fields = axes.map((axis) => numberField({
        label: axis.toUpperCase(),
        value: get()[axis] * scale,
        step,
        axis,
        onLive: (value) => {
          const v = get().clone();
          v[axis] = value / scale;
          set(v);
          ed.requestRender();
        },
        onChange: (value) => {
          ed.beginUndo(`Set ${label.toLowerCase()}`);
          const v = get().clone();
          v[axis] = value / scale;
          set(v);
          ed.requestRender();
          ed.emit('change');
        },
      }));
      return h('div', { class: 'prop-vector' }, [
        h('label', { class: 'prop-label', text: label }),
        h('div', { class: 'nf-group' }, fields),
      ]);
    };

    this.body.appendChild(this.section('Transform', [
      vectorRow('Location', () => obj.position, (v) => { obj.position = v; }, 0.01),
      vectorRow('Rotation', () => obj.rotation, (v) => { obj.rotation = v; }, 0.5, RAD2DEG),
      vectorRow('Scale', () => obj.scale, (v) => { obj.scale = v; }, 0.01),
    ]));

    if (obj.type === 'mesh' && obj.mesh) {
      const evaluated = obj.evaluated();
      this.body.appendChild(this.section('Mesh', [
        h('div', { class: 'stat-grid' }, [
          h('span', { text: 'Vertices' }), h('b', { text: `${obj.mesh.vertCount}` }),
          h('span', { text: 'Edges' }), h('b', { text: `${obj.mesh.edgeCount}` }),
          h('span', { text: 'Faces' }), h('b', { text: `${obj.mesh.faceCount}` }),
          h('span', { text: 'Evaluated tris' }), h('b', { text: `${evaluated?.triCount ?? 0}` }),
        ]),
        h('div', { class: 'btn-row' }, [
          button('Shade Smooth', () => {
            ed.beginUndo('Shade smooth');
            obj.mesh?.setAllSmooth(true);
            ed.markGeometryDirty(obj);
          }),
          button('Shade Flat', () => {
            ed.beginUndo('Shade flat');
            obj.mesh?.setAllSmooth(false);
            ed.markGeometryDirty(obj);
          }),
        ]),
      ]));
    }

    if (obj.type === 'light' && obj.light) {
      const light = obj.light;
      this.body.appendChild(this.section('Light', [
        row('Type', select(
          (['point', 'sun', 'spot', 'area'] as LightType[]).map((t) => ({ value: t, label: t })),
          light.type,
          (v) => {
            ed.beginUndo('Change light type');
            light.type = v as LightType;
            ed.requestRender();
            ed.emit('change');
          },
        )),
        row('Colour', this.colorInput(light.color, (c) => {
          light.color = c;
          ed.requestRender();
        })),
        row('Power', numberField({
          label: 'W', value: light.energy, step: 5, precision: 1, min: 0,
          onLive: (v) => { light.energy = v; ed.requestRender(); },
          onChange: (v) => { light.energy = v; ed.requestRender(); ed.emit('change'); },
        })),
        light.type === 'spot' ? row('Cone', numberField({
          label: '°', value: light.spotAngle * RAD2DEG, step: 1, precision: 1, min: 1, max: 89,
          onLive: (v) => { light.spotAngle = v * DEG2RAD; ed.requestRender(); },
          onChange: (v) => { light.spotAngle = v * DEG2RAD; ed.requestRender(); ed.emit('change'); },
        })) : null,
      ]));
    }

    if (obj.type === 'camera' && obj.camera) {
      const cam = obj.camera;
      this.body.appendChild(this.section('Camera', [
        row('Focal FOV', numberField({
          label: '°', value: cam.fov * RAD2DEG, step: 1, precision: 1, min: 5, max: 160,
          onLive: (v) => { cam.fov = v * DEG2RAD; ed.requestRender(); },
          onChange: (v) => { cam.fov = v * DEG2RAD; ed.requestRender(); ed.emit('change'); },
        })),
        row('Clip start', numberField({
          label: 'm', value: cam.near, step: 0.01, min: 0.001,
          onChange: (v) => { cam.near = v; ed.requestRender(); },
        })),
        row('Clip end', numberField({
          label: 'm', value: cam.far, step: 10, min: 1,
          onChange: (v) => { cam.far = v; ed.requestRender(); },
        })),
      ]));
    }
  }

  private colorInput(
    color: [number, number, number], onChange: (c: [number, number, number]) => void,
  ): HTMLElement {
    const input = h('input', { type: 'color', class: 'color-input', value: linearToHex(color) });
    input.addEventListener('input', () => onChange(hexToLinear(input.value)));
    return input;
  }

  // --------------------------------------------------------------- modifiers

  private buildModifierTab(obj: SceneObject | null): void {
    if (!obj || obj.type !== 'mesh') {
      this.body.appendChild(this.emptyState(
        'Modifiers apply to mesh objects.',
        'Select a mesh to build a non-destructive stack.',
      ));
      return;
    }
    const ed = this.editor;

    const addSelect = select(
      [{ value: '', label: 'Add Modifier…' },
        ...(Object.keys(MODIFIER_LABELS) as ModifierType[]).map((t) => ({ value: t, label: MODIFIER_LABELS[t] }))],
      '',
      (v) => {
        if (!v) return;
        ed.beginUndo(`Add ${v} modifier`);
        obj.modifiers.push(createModifier(v as ModifierType));
        ed.markGeometryDirty(obj);
        addSelect.value = '';
      },
    );
    this.body.appendChild(h('div', { class: 'prop-section' }, [addSelect]));

    if (obj.modifiers.length === 0) {
      this.body.appendChild(this.emptyState(
        'The stack is empty.',
        'Modifiers evaluate top to bottom and never touch your original mesh.',
      ));
      return;
    }

    obj.modifiers.forEach((mod, index) => {
      this.body.appendChild(this.modifierCard(obj, mod, index));
    });
  }

  private modifierCard(obj: SceneObject, mod: Modifier, index: number): HTMLElement {
    const ed = this.editor;
    const update = (label: string): void => {
      ed.beginUndo(label);
      ed.markGeometryDirty(obj);
    };
    const live = (): void => {
      obj.invalidate();
      ed.renderer.invalidate(obj.id);
      ed.requestRender();
    };

    const header = h('div', { class: 'mod-header' }, [
      icon('modifier'),
      h('span', { class: 'mod-name', text: mod.name }),
      h('button', {
        class: `icon-btn small${mod.enabled ? '' : ' off'}`, title: 'Enable in viewport',
        on: { click: () => { update('Toggle modifier'); mod.enabled = !mod.enabled; ed.markGeometryDirty(obj); } },
      }, [icon(mod.enabled ? 'eye' : 'eyeOff')]),
      h('button', {
        class: 'icon-btn small', title: 'Move up', disabled: index === 0,
        on: {
          click: () => {
            update('Reorder modifiers');
            const [m] = obj.modifiers.splice(index, 1);
            obj.modifiers.splice(index - 1, 0, m);
            ed.markGeometryDirty(obj);
          },
        },
      }, [h('span', { text: '↑' })]),
      h('button', {
        class: 'icon-btn small', title: 'Move down', disabled: index === obj.modifiers.length - 1,
        on: {
          click: () => {
            update('Reorder modifiers');
            const [m] = obj.modifiers.splice(index, 1);
            obj.modifiers.splice(index + 1, 0, m);
            ed.markGeometryDirty(obj);
          },
        },
      }, [h('span', { text: '↓' })]),
      h('button', {
        class: 'icon-btn small danger', title: 'Remove modifier',
        on: {
          click: () => {
            update('Remove modifier');
            obj.modifiers.splice(index, 1);
            ed.markGeometryDirty(obj);
          },
        },
      }, [icon('del')]),
    ]);

    const body = h('div', { class: 'mod-body' });
    const num = (
      label: string, value: number, step: number, set: (v: number) => void,
      opts: { min?: number; max?: number; precision?: number } = {},
    ): HTMLElement => row(label, numberField({
      label: '', value, step, precision: opts.precision ?? 3, min: opts.min, max: opts.max,
      onLive: (v) => { set(v); live(); },
      onChange: (v) => { update(`Set ${label.toLowerCase()}`); set(v); ed.markGeometryDirty(obj); },
    }));

    switch (mod.type) {
      case 'subsurf':
        body.appendChild(num('Levels', mod.levels, 1, (v) => { mod.levels = Math.round(v); }, { min: 0, max: 4, precision: 0 }));
        body.appendChild(checkbox('Show in Edit Mode', mod.showInEdit, (v) => {
          update('Toggle edit-mode display');
          mod.showInEdit = v;
          ed.markGeometryDirty(obj);
        }));
        break;
      case 'mirror': {
        const axisRow = h('div', { class: 'btn-row' }, (['X', 'Y', 'Z'] as const).map((axis, i) =>
          h('button', {
            class: `btn toggle${mod.axis[i] ? ' on' : ''}`,
            text: axis,
            on: {
              click: () => {
                update('Toggle mirror axis');
                mod.axis[i] = !mod.axis[i];
                ed.markGeometryDirty(obj);
              },
            },
          })));
        body.appendChild(row('Axis', axisRow));
        body.appendChild(checkbox('Merge at centre', mod.merge, (v) => {
          update('Toggle mirror merge');
          mod.merge = v;
          ed.markGeometryDirty(obj);
        }));
        body.appendChild(num('Threshold', mod.mergeThreshold, 0.001, (v) => { mod.mergeThreshold = v; }, { min: 0, precision: 4 }));
        break;
      }
      case 'array':
        body.appendChild(num('Count', mod.count, 1, (v) => { mod.count = Math.max(1, Math.round(v)); }, { min: 1, precision: 0 }));
        body.appendChild(row('Relative offset', h('div', { class: 'nf-group' },
          (['x', 'y', 'z'] as const).map((axis, i) => numberField({
            label: axis.toUpperCase(), value: mod.relativeOffset[i], step: 0.05, axis,
            onLive: (v) => { mod.relativeOffset[i] = v; live(); },
            onChange: (v) => { update('Set array offset'); mod.relativeOffset[i] = v; ed.markGeometryDirty(obj); },
          })))));
        body.appendChild(checkbox('Merge ends', mod.mergeEnds, (v) => {
          update('Toggle array merge');
          mod.mergeEnds = v;
          ed.markGeometryDirty(obj);
        }));
        break;
      case 'solidify':
        body.appendChild(num('Thickness', mod.thickness, 0.01, (v) => { mod.thickness = v; }));
        body.appendChild(num('Offset', mod.offset, 0.1, (v) => { mod.offset = v; }, { min: -1, max: 1 }));
        break;
      case 'weld':
        body.appendChild(num('Distance', mod.distance, 0.001, (v) => { mod.distance = Math.max(1e-6, v); }, { precision: 4 }));
        break;
      case 'smooth':
        body.appendChild(num('Factor', mod.factor, 0.05, (v) => { mod.factor = v; }, { min: 0, max: 1 }));
        body.appendChild(num('Repeat', mod.iterations, 1, (v) => { mod.iterations = Math.round(v); }, { min: 1, max: 20, precision: 0 }));
        break;
      case 'triangulate':
        body.appendChild(h('p', { class: 'dim small', text: 'Converts every n-gon to triangles at render time.' }));
        break;
    }

    body.appendChild(h('div', { class: 'btn-row' }, [
      button('Apply', () => {
        const mesh = obj.mesh;
        if (!mesh) return;
        update('Apply modifier');
        const applied = obj.evaluated(false);
        if (applied) {
          obj.mesh = applied.clone();
          obj.modifiers.splice(index, 1);
        }
        ed.markGeometryDirty(obj);
      }, { title: 'Bake this modifier into the mesh' }),
    ]));

    return h('div', { class: `mod-card${mod.enabled ? '' : ' disabled'}` }, [header, body]);
  }

  // ---------------------------------------------------------------- material

  private buildMaterialTab(obj: SceneObject | null): void {
    const ed = this.editor;
    const scene = ed.scene;
    if (!obj || obj.type !== 'mesh') {
      this.body.appendChild(this.emptyState(
        'Materials belong to mesh objects.',
        'Select a mesh to edit its slots.',
      ));
      return;
    }
    if (obj.materialSlots.length === 0) obj.materialSlots.push(scene.ensureDefaultMaterial());

    const slots = h('div', { class: 'slot-list' }, obj.materialSlots.map((matIndex, slot) => {
      const mat = scene.materials[matIndex];
      return h('div', {
        class: `slot${slot === 0 ? ' active' : ''}`,
      }, [
        h('span', { class: 'swatch', style: { background: linearToHex(mat?.color ?? [1, 0, 1]) } }),
        h('span', { text: mat?.name ?? 'Missing' }),
      ]);
    }));

    this.body.appendChild(this.section('Slots', [
      slots,
      h('div', { class: 'btn-row' }, [
        button('New Material', () => {
          ed.beginUndo('New material');
          const idx = scene.addMaterial(createMaterial());
          obj.materialSlots = [idx];
          ed.requestRender();
          ed.emit('change');
        }),
      ]),
    ]));

    const mat = scene.materials[obj.materialSlots[0]];
    if (!mat) return;
    const live = (): void => ed.requestRender();

    const nameInput = h('input', { class: 'text-input', value: mat.name, type: 'text' });
    nameInput.addEventListener('change', () => {
      ed.beginUndo('Rename material');
      mat.name = nameInput.value || mat.name;
      ed.emit('change');
    });
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());

    this.body.appendChild(this.section('Surface', [
      row('Name', nameInput),
      row('Base colour', this.colorInput(mat.color, (c) => { mat.color = c; live(); })),
      row('Metallic', numberField({
        label: '', value: mat.metallic, step: 0.01, min: 0, max: 1,
        onLive: (v) => { mat.metallic = v; live(); },
        onChange: (v) => { mat.metallic = v; live(); ed.emit('change'); },
      })),
      row('Roughness', numberField({
        label: '', value: mat.roughness, step: 0.01, min: 0, max: 1,
        onLive: (v) => { mat.roughness = v; live(); },
        onChange: (v) => { mat.roughness = v; live(); ed.emit('change'); },
      })),
      row('Alpha', numberField({
        label: '', value: mat.alpha, step: 0.01, min: 0, max: 1,
        onLive: (v) => { mat.alpha = v; live(); },
        onChange: (v) => { mat.alpha = v; live(); ed.emit('change'); },
      })),
      row('Emission', this.colorInput(mat.emission, (c) => { mat.emission = c; live(); })),
      row('Emission strength', numberField({
        label: '', value: mat.emissionStrength, step: 0.1, min: 0,
        onLive: (v) => { mat.emissionStrength = v; live(); },
        onChange: (v) => { mat.emissionStrength = v; live(); ed.emit('change'); },
      })),
      h('p', { class: 'dim small', text: 'Material shading shows in the Material and Rendered viewport modes (press Z).' }),
    ]));
  }

  // ------------------------------------------------------------------- world

  private buildWorldTab(): void {
    const ed = this.editor;
    const world = ed.scene.world;
    const stats = ed.scene.stats();

    this.body.appendChild(this.section('World', [
      row('Background', this.colorInput(world.background, (c) => {
        world.background = c;
        ed.requestRender();
      })),
      row('Ambient', numberField({
        label: '', value: world.ambient, step: 0.01, min: 0, max: 2,
        onLive: (v) => { world.ambient = v; ed.requestRender(); },
        onChange: (v) => { world.ambient = v; ed.requestRender(); ed.emit('change'); },
      })),
    ]));

    this.body.appendChild(this.section('Viewport', [
      checkbox('Grid floor', ed.options.showGrid, (v) => { ed.options.showGrid = v; ed.requestRender(); }),
      checkbox('Overlays', ed.options.showOverlays, (v) => { ed.options.showOverlays = v; ed.requestRender(); }),
      checkbox('Object wireframes', ed.options.showObjectWireframe, (v) => {
        ed.options.showObjectWireframe = v;
        for (const id of ed.scene.objects.keys()) ed.renderer.invalidate(id);
        ed.requestRender();
      }),
      checkbox('Backface culling', ed.options.backfaceCulling, (v) => {
        ed.options.backfaceCulling = v;
        ed.requestRender();
      }),
      checkbox('X-ray', ed.options.xray, (v) => { ed.options.xray = v; ed.requestRender(); }),
      checkbox('Orthographic', ed.camera.orthographic, (v) => {
        ed.camera.orthographic = v;
        ed.requestRender();
      }),
    ]));

    this.body.appendChild(this.section('Statistics', [
      h('div', { class: 'stat-grid' }, [
        h('span', { text: 'Objects' }), h('b', { text: `${stats.objects}` }),
        h('span', { text: 'Vertices' }), h('b', { text: stats.verts.toLocaleString() }),
        h('span', { text: 'Edges' }), h('b', { text: stats.edges.toLocaleString() }),
        h('span', { text: 'Faces' }), h('b', { text: stats.faces.toLocaleString() }),
        h('span', { text: 'Triangles' }), h('b', { text: stats.tris.toLocaleString() }),
      ]),
    ]));
  }
}
