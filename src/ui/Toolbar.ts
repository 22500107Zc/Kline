import { runCommand } from '../editor/commands';
import { Editor } from '../editor/Editor';
import { clear, h } from './dom';
import { icon } from './icons';

interface ToolButton {
  command: string;
  icon: string;
  label: string;
  key: string;
}

const OBJECT_TOOLS: ToolButton[] = [
  { command: 'transform.move', icon: 'move', label: 'Move', key: 'G' },
  { command: 'transform.rotate', icon: 'rotate', label: 'Rotate', key: 'R' },
  { command: 'transform.scale', icon: 'scale', label: 'Scale', key: 'S' },
  { command: 'object.duplicate', icon: 'add', label: 'Duplicate', key: 'Shift+D' },
  { command: 'object.delete', icon: 'del', label: 'Delete', key: 'X' },
];

const EDIT_TOOLS: ToolButton[] = [
  { command: 'transform.move', icon: 'move', label: 'Move', key: 'G' },
  { command: 'transform.rotate', icon: 'rotate', label: 'Rotate', key: 'R' },
  { command: 'transform.scale', icon: 'scale', label: 'Scale', key: 'S' },
  { command: 'mesh.extrude', icon: 'extrude', label: 'Extrude Region', key: 'E' },
  { command: 'mesh.inset', icon: 'inset', label: 'Inset Faces', key: 'I' },
  { command: 'mesh.loopcut', icon: 'loopcut', label: 'Loop Cut', key: 'Ctrl+R' },
  { command: 'mesh.subdivide', icon: 'subdivide', label: 'Subdivide', key: '' },
  { command: 'mesh.merge', icon: 'merge', label: 'Merge at Centre', key: 'M' },
  { command: 'mesh.delete', icon: 'del', label: 'Delete Selection', key: 'X' },
];

/** Left rail of the tools that matter in the current mode. */
export class Toolbar {
  readonly root = h('aside', { class: 'toolbar' });

  constructor(private editor: Editor) {
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  refresh(): void {
    clear(this.root);
    const ed = this.editor;
    const tools = ed.mode === 'edit' ? EDIT_TOOLS : OBJECT_TOOLS;
    for (const t of tools) {
      this.root.appendChild(h('button', {
        class: 'tool-btn',
        title: t.key ? `${t.label} — ${t.key}` : t.label,
        on: { click: () => runCommand(ed, t.command) },
      }, [icon(t.icon), h('span', { class: 'tool-key', text: t.key.replace('Shift+', '⇧').replace('Ctrl+', '^') })]));
    }
  }
}
