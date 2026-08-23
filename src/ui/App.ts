import { Editor } from '../editor/Editor';
import { COMMANDS, KEYMAP, keyChord, lookupKey, runCommand } from '../editor/commands';
import { Header } from './Header';
import { Outliner } from './Outliner';
import { Properties } from './Properties';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { clear, h } from './dom';

/** Assembles the shell around the viewport and routes keyboard input. */
export class App {
  readonly editor: Editor;
  private canvas: HTMLCanvasElement;
  private heatBar = h('div', { class: 'heat-bar' });
  private boxSelect = h('div', { class: 'box-select' });
  private shortcuts = h('div', { class: 'overlay-panel shortcuts hidden' });
  private viewportHint = h('div', { class: 'viewport-hint' });

  constructor(private mount: HTMLElement) {
    this.canvas = h('canvas', { class: 'viewport-canvas' });
    this.editor = new Editor(this.canvas);

    const header = new Header(this.editor, () => this.toggleShortcuts());
    const toolbar = new Toolbar(this.editor);
    const outliner = new Outliner(this.editor);
    const properties = new Properties(this.editor);
    const status = new StatusBar(this.editor);

    const viewport = h('main', { class: 'viewport' }, [
      this.canvas, this.boxSelect, this.viewportHint, this.shortcuts,
    ]);
    const right = h('div', { class: 'sidebar' }, [outliner.root, properties.root]);

    mount.append(
      header.root,
      this.heatBar,
      h('div', { class: 'workspace' }, [toolbar.root, viewport, right]),
      status.root,
    );

    this.buildShortcuts();
    this.wireKeyboard();
    this.editor.on('modal', () => this.syncModalChrome());
    this.editor.on('change', () => this.syncModalChrome());
    this.syncModalChrome();
    this.editor.start();
    this.editor.setStatus('Ready — MMB orbits, Shift+MMB pans, wheel zooms');
  }

  private syncModalChrome(): void {
    this.heatBar.classList.toggle('live', this.editor.isModal);
    const rect = this.editor.boxSelectRect;
    if (rect) {
      Object.assign(this.boxSelect.style, {
        display: 'block',
        left: `${rect.x0}px`,
        top: `${rect.y0}px`,
        width: `${rect.x1 - rect.x0}px`,
        height: `${rect.y1 - rect.y0}px`,
      });
    } else {
      this.boxSelect.style.display = 'none';
    }
    const label = this.editor.modalLabel;
    this.viewportHint.textContent = label ?? '';
    this.viewportHint.classList.toggle('visible', !!label);
  }

  private wireKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (!this.shortcuts.classList.contains('hidden') && e.key === 'Escape') {
        this.toggleShortcuts();
        e.preventDefault();
        return;
      }
      if (this.editor.handleKey(e)) {
        e.preventDefault();
        return;
      }
      const command = lookupKey(keyChord(e), this.editor.mode);
      if (command) {
        e.preventDefault();
        runCommand(this.editor, command);
      }
    });
    // Keep the canvas focused so the keymap always applies.
    this.mount.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      if (!/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) this.canvas.focus();
    });
  }

  private toggleShortcuts(): void {
    this.shortcuts.classList.toggle('hidden');
  }

  private buildShortcuts(): void {
    clear(this.shortcuts);
    const byCommand = new Map(COMMANDS.map((c) => [c.id, c]));
    const groups = new Map<string, { chord: string; label: string; mode?: string }[]>();
    for (const binding of KEYMAP) {
      const cmd = byCommand.get(binding.command);
      if (!cmd) continue;
      const list = groups.get(cmd.category) ?? [];
      list.push({ chord: binding.chord, label: cmd.label, mode: binding.mode });
      groups.set(cmd.category, list);
    }

    this.shortcuts.appendChild(h('div', { class: 'overlay-head' }, [
      h('h2', { text: 'Keyboard' }),
      h('button', { class: 'icon-btn', text: '✕', title: 'Close', on: { click: () => this.toggleShortcuts() } }),
    ]));

    const grid = h('div', { class: 'shortcut-grid' });
    for (const [category, list] of groups) {
      grid.appendChild(h('div', { class: 'shortcut-group' }, [
        h('h3', { text: category }),
        ...list.map((item) => h('div', { class: 'shortcut-row' }, [
          h('kbd', { text: prettyChord(item.chord) }),
          h('span', { text: item.label }),
          item.mode ? h('em', { text: item.mode }) : null,
        ])),
      ]));
    }
    grid.appendChild(h('div', { class: 'shortcut-group' }, [
      h('h3', { text: 'Mouse' }),
      ...[
        ['Left click', 'Select'],
        ['Left drag', 'Box select'],
        ['Shift + click', 'Extend selection'],
        ['Alt + click', 'Select edge ring (Edit Mode)'],
        ['Middle drag', 'Orbit'],
        ['Shift + middle', 'Pan'],
        ['Ctrl + middle', 'Zoom'],
        ['Wheel', 'Zoom'],
        ['Shift + right click', 'Place 3D cursor'],
      ].map(([k, v]) => h('div', { class: 'shortcut-row' }, [h('kbd', { text: k }), h('span', { text: v })])),
    ]));
    this.shortcuts.appendChild(grid);
  }
}

function prettyChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => {
      if (part.startsWith('numpad')) return `Numpad ${part.slice(6).replace('decimal', '.')}`;
      if (part.length === 1) return part.toUpperCase();
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(' + ');
}
