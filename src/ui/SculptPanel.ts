import { Editor } from '../editor/Editor';
import { BRUSH_LABELS, SculptBrush } from '../sculpt/sculpt';
import { runCommand } from '../editor/commands';
import { hexToLinear, linearToHex } from '../scene/Material';
import { checkbox, clear, h } from './dom';

/** Brush picker and settings, shown only while Sculpt Mode is active. */
export class SculptPanel {
  readonly root = h('div', { class: 'sculpt-panel hidden' });

  constructor(private editor: Editor) {
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  private slider(
    label: string, value: number, min: number, max: number, step: number,
    onInput: (v: number) => void, format: (v: number) => string,
  ): HTMLElement {
    const readout = h('span', { class: 'sp-value', text: format(value) });
    const input = h('input', {
      type: 'range', class: 'sp-slider',
      min: String(min), max: String(max), step: String(step), value: String(value),
    });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      readout.textContent = format(v);
      onInput(v);
    });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    return h('div', { class: 'sp-row' }, [
      h('div', { class: 'sp-head' }, [h('span', { text: label }), readout]),
      input,
    ]);
  }

  refresh(): void {
    const ed = this.editor;
    const active = ed.mode === 'sculpt';
    this.root.classList.toggle('hidden', !active);
    if (!active) return;

    clear(this.root);
    this.root.appendChild(h('h3', { class: 'sp-title', text: 'Sculpt' }));

    const grid = h('div', { class: 'sp-brushes' });
    for (const [id, label] of Object.entries(BRUSH_LABELS)) {
      grid.appendChild(h('button', {
        class: `sp-brush${ed.sculpt.brush === id ? ' active' : ''}`,
        text: label,
        title: `${label} brush`,
        on: { click: () => ed.setSculptBrush(id as SculptBrush) },
      }));
    }
    this.root.appendChild(grid);

    this.root.append(
      this.slider('Radius', ed.sculpt.radius, 0.01, 4, 0.01, (v) => {
        ed.sculpt.radius = v;
        ed.requestRender();
      }, (v) => v.toFixed(2)),
      this.slider('Strength', ed.sculpt.strength, 0.01, 1, 0.01, (v) => {
        ed.sculpt.strength = v;
      }, (v) => v.toFixed(2)),
      this.slider('Auto-smooth', ed.sculpt.autoSmooth, 0, 1, 0.01, (v) => {
        ed.sculpt.autoSmooth = v;
      }, (v) => v.toFixed(2)),
      this.slider('Spacing', ed.sculpt.spacing, 0.02, 1, 0.01, (v) => {
        ed.sculpt.spacing = v;
      }, (v) => `${Math.round(v * 100)}%`),
    );

    const sym = h('div', { class: 'sp-sym' }, [h('span', { class: 'sp-head', text: 'Symmetry' })]);
    (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
      sym.appendChild(h('button', {
        class: `sp-axis${ed.sculpt.symmetry[i] ? ' active' : ''}`,
        text: axis,
        on: {
          click: () => {
            ed.sculpt.symmetry[i] = !ed.sculpt.symmetry[i];
            ed.emit('change');
          },
        },
      }));
    });
    this.root.appendChild(sym);

    if (ed.sculpt.brush === 'color') {
      this.root.append(
        h('span', { class: 'sp-head', text: 'Colour' }),
        this.colorPicker(ed.sculpt.paintColor, (c) => {
          ed.sculpt.paintColor = c;
          ed.emit('change');
        }),
        h('p', { class: 'sp-hint', text: 'Ctrl paints white. Vertex colour multiplies into the material.' }),
      );
    }

    if (ed.sculpt.brush === 'texture') {
      const mat = ed.scene.materials[ed.sculptObject?.materialSlots[0] ?? 0];
      const hasMap = !!mat && mat.baseColorTexture !== null;
      this.root.append(
        h('span', { class: 'sp-head', text: 'Colour' }),
        this.colorPicker(ed.paintBrush.color, (c) => {
          ed.paintBrush.color = c;
          ed.emit('change');
        }),
        this.slider('Softness', ed.paintBrush.softness, 0, 1, 0.01, (v) => {
          ed.paintBrush.softness = v;
        }, (v) => v.toFixed(2)),
      );
      if (!hasMap) {
        this.root.append(
          h('p', {
            class: 'sp-warn',
            text: 'This material has no base colour map to paint on.',
          }),
          h('button', {
            class: 'btn', text: 'Create a blank map',
            on: { click: () => runCommand(ed, 'paint.newTexture') },
          }),
        );
      }
    }

    // The weight brush needs to know which bone it is painting, and that only
    // makes sense once the mesh is actually bound to something.
    if (ed.sculpt.brush === 'weight') {
      const mesh = ed.sculptObject?.mesh;
      const rig = [...ed.scene.objects.values()].find((o) => {
        if (!o.armature) return false;
        return ed.sculptObject?.modifiers.some((m) => m.type === 'armature' && m.objectId === o.id) ?? false;
      });
      if (!mesh?.skin || !rig?.armature) {
        this.root.appendChild(h('p', {
          class: 'sp-warn',
          text: 'Bind this mesh to an armature first (Rig → Bind) — there are no weights to paint yet.',
        }));
      } else {
        const bones = rig.armature.bones;
        const picker = h('select', { class: 'sel' }) as HTMLSelectElement;
        bones.forEach((b, i) => picker.append(h('option', { value: String(i), text: b.name })));
        picker.value = String(Math.min(ed.sculpt.weightBone, bones.length - 1));
        picker.addEventListener('change', () => {
          ed.sculpt.weightBone = Number(picker.value);
          ed.activeBone = ed.sculpt.weightBone;
          ed.emit('change');
          ed.requestRender();
        });
        picker.addEventListener('keydown', (e) => e.stopPropagation());
        this.root.append(h('span', { class: 'sp-head', text: 'Painting bone' }), picker);
      }
    }

    this.root.appendChild(h('span', { class: 'sp-head', text: 'Topology' }));
    const tools = h('div', { class: 'sp-topology' });
    tools.append(
      h('button', {
        class: 'sp-axis wide', text: 'Remesh',
        title: 'Rebuild the mesh at an even density. Resets UVs.',
        on: { click: () => runCommand(ed, 'sculpt.remesh') },
      }),
      h('button', {
        class: 'sp-axis wide', text: 'Clear mask',
        on: { click: () => runCommand(ed, 'sculpt.clearMask') },
      }),
      h('button', {
        class: 'sp-axis wide', text: 'Invert mask',
        on: { click: () => runCommand(ed, 'sculpt.invertMask') },
      }),
    );
    this.root.appendChild(tools);

    this.root.appendChild(h('p', { class: 'sp-hint', text: 'Hold Ctrl to invert · [ and ] resize · Ctrl+scroll resizes' }));

    const obj = ed.sculptObject;
    if (obj?.mesh && obj.mesh.vertCount < 2000) {
      this.root.appendChild(h('p', {
        class: 'sp-warn',
        text: `${obj.mesh.vertCount} vertices — add a Subdivision modifier or subdivide for finer detail.`,
      }));
    }
    this.root.appendChild(checkbox('Show wireframe', ed.options.showObjectWireframe, (v) => {
      ed.options.showObjectWireframe = v;
      ed.requestRender();
      ed.emit('change');
    }));
  }

  /** A colour swatch bound to a linear RGB triple. */
  private colorPicker(
    value: [number, number, number], onChange: (c: [number, number, number]) => void,
  ): HTMLElement {
    const input = h('input', { type: 'color', class: 'color-input', value: linearToHex(value) });
    input.addEventListener('input', () => onChange(hexToLinear((input as HTMLInputElement).value)));
    return input;
  }
}
