import { COMMANDS, Command, runCommand } from '../editor/commands';
import { Editor } from '../editor/Editor';
import { clear, h } from './dom';

/**
 * Everything the app can do, one keystroke away.
 *
 * The menus are organised by category, which is useless if you do not already
 * know the category. This searches all of them by name, which is how you find
 * "Recalculate Normals" when you have no idea it lives under Mesh.
 */
export class CommandPalette {
  readonly root = h('div', { class: 'palette hidden' });
  private input = h('input', {
    class: 'palette-input', type: 'text',
    placeholder: 'Search commands — try "extrude", "export", "smooth"',
  });
  private list = h('div', { class: 'palette-list' });
  private matches: Command[] = [];
  private active = 0;

  constructor(private editor: Editor) {
    this.root.append(
      h('div', { class: 'palette-box' }, [this.input, this.list]),
    );
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  open(): void {
    this.root.classList.remove('hidden');
    this.input.value = '';
    this.active = 0;
    this.refresh();
    this.input.focus();
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private onKey(e: KeyboardEvent): void {
    // Let Cmd+K through so the same chord closes the palette again.
    const meta = e.ctrlKey || e.metaKey;
    if (!(meta && e.key.toLowerCase() === 'k')) e.stopPropagation();
    if (e.key === 'Escape') {
      this.close();
      return;
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      this.active = Math.min(this.matches.length - 1, this.active + 1);
      this.render();
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      this.active = Math.max(0, this.active - 1);
      this.render();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = this.matches[this.active];
      if (cmd) {
        this.close();
        runCommand(this.editor, cmd.id);
      }
    }
  }

  private refresh(): void {
    const query = this.input.value.trim().toLowerCase();
    // Commands from the other mode stay listed, marked, rather than silently
    // vanishing — that is how you find out "Recalculate Normals" needs Edit Mode.
    const available = [...COMMANDS].sort((a, b) => {
      const am = !a.mode || a.mode === this.editor.mode ? 0 : 1;
      const bm = !b.mode || b.mode === this.editor.mode ? 0 : 1;
      return am - bm;
    });
    this.matches = query
      ? available
        .map((c) => ({ c, score: score(query, `${c.category} ${c.label}`.toLowerCase()) }))
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40)
        .map((m) => m.c)
      : available.slice(0, 40);
    this.active = 0;
    this.render();
  }

  private render(): void {
    clear(this.list);
    if (this.matches.length === 0) {
      this.list.appendChild(h('div', { class: 'palette-empty', text: 'Nothing matches that.' }));
      return;
    }
    this.matches.forEach((cmd, i) => {
      const wrongMode = !!cmd.mode && cmd.mode !== this.editor.mode;
      const disabled = wrongMode || (cmd.enabled ? !cmd.enabled(this.editor) : false);
      const row = h('button', {
        class: `palette-row${i === this.active ? ' active' : ''}${disabled ? ' disabled' : ''}`,
        on: {
          click: () => {
            this.close();
            if (wrongMode) {
              this.editor.setStatus(
                `${cmd.label} is a ${cmd.mode === 'edit' ? 'Edit' : 'Object'} Mode command — press Tab to switch`,
              );
              return;
            }
            runCommand(this.editor, cmd.id);
          },
          pointerenter: () => {
            this.active = i;
            this.render();
          },
        },
      }, [
        h('span', { class: 'palette-cat', text: cmd.category }),
        h('span', { class: 'palette-label', text: cmd.label }),
        wrongMode ? h('em', { class: 'palette-mode', text: `${cmd.mode} mode` }) : null,
        cmd.shortcut ? h('kbd', { text: cmd.shortcut }) : null,
      ]);
      this.list.appendChild(row);
    });
    this.list.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }
}

/** Subsequence match: every query character in order, rewarding tight runs and word starts. */
function score(query: string, text: string): number {
  let ti = 0;
  let total = 0;
  let streak = 0;
  for (const ch of query) {
    if (ch === ' ') continue;
    const found = text.indexOf(ch, ti);
    if (found < 0) return 0;
    const atWordStart = found === 0 || text[found - 1] === ' ';
    streak = found === ti ? streak + 1 : 0;
    total += 1 + streak + (atWordStart ? 3 : 0);
    ti = found + 1;
  }
  // Prefer shorter labels when the score would otherwise tie.
  return total + Math.max(0, 24 - text.length) * 0.1;
}
