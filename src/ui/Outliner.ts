import { Editor } from '../editor/Editor';
import { SceneObject } from '../scene/Scene';
import { clear, h } from './dom';
import { icon } from './icons';

const TYPE_ICON: Record<string, string> = {
  mesh: 'mesh', light: 'light', camera: 'camera', empty: 'empty',
};

/** The scene tree: click to select, double-click to rename, eye to hide. */
export class Outliner {
  readonly root = h('div', { class: 'panel outliner' });
  private list = h('div', { class: 'outliner-list' });

  constructor(private editor: Editor) {
    this.root.appendChild(h('div', { class: 'panel-title' }, [
      h('span', { text: 'Outliner' }),
      h('span', { class: 'panel-count' }),
    ]));
    this.root.appendChild(this.list);
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  refresh(): void {
    const scene = this.editor.scene;
    const count = this.root.querySelector('.panel-count');
    if (count) count.textContent = `${scene.objects.size}`;
    clear(this.list);

    if (scene.objects.size === 0) {
      this.list.appendChild(h('div', { class: 'empty-state' }, [
        h('p', { text: 'Nothing in the scene yet.' }),
        h('p', { class: 'dim', text: 'Use the Add menu to place your first object.' }),
      ]));
      return;
    }

    for (const { obj, depth } of scene.walk()) {
      this.list.appendChild(this.rowFor(obj, depth));
    }
  }

  private rowFor(obj: SceneObject, depth: number): HTMLElement {
    const scene = this.editor.scene;
    const selected = scene.selection.has(obj.id);
    const active = scene.active === obj.id;
    const editing = this.editor.editObjectId === obj.id && this.editor.mode === 'edit';

    const name = h('span', { class: 'outliner-name', text: obj.name });
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startRename(obj, name);
    });

    const visibility = h('button', {
      class: `icon-btn small${obj.visible ? '' : ' off'}`,
      title: obj.visible ? 'Hide in viewport' : 'Show in viewport',
      on: {
        click: (e) => {
          e.stopPropagation();
          if (!this.editor.beginUndo(obj.visible ? 'Hide object' : 'Show object')) return;
          obj.visible = !obj.visible;
          this.editor.requestRender();
          this.editor.emit('change');
        },
      },
    }, [icon(obj.visible ? 'eye' : 'eyeOff')]);

    const row = h('div', {
      class: `outliner-row${selected ? ' selected' : ''}${active ? ' active' : ''}${editing ? ' editing' : ''}`,
      style: { paddingLeft: `${8 + depth * 14}px` },
      on: {
        click: (e) => {
          this.editor.selectObject(obj.id, (e as MouseEvent).shiftKey);
        },
        dblclick: () => {
          if (obj.type === 'mesh') {
            this.editor.selectObject(obj.id);
            if (this.editor.mode === 'object') this.editor.toggleEditMode();
          }
        },
      },
    }, [
      icon(TYPE_ICON[obj.type] ?? 'empty', 'icon type-icon'),
      name,
      obj.modifiers.length ? h('span', { class: 'outliner-badge', text: `${obj.modifiers.length}`, title: `${obj.modifiers.length} modifier(s)` }) : null,
      visibility,
    ]);
    return row;
  }

  private startRename(obj: SceneObject, label: HTMLElement): void {
    const input = h('input', { class: 'rename-input', value: obj.name, type: 'text' });
    label.replaceWith(input);
    input.focus();
    input.select();
    const finish = (commit: boolean): void => {
      if (commit && input.value.trim()) {
        if (!this.editor.beginUndo('Rename object')) return;
        obj.name = input.value.trim();
      }
      this.editor.emit('change');
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
}
