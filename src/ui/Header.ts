import { COMMANDS, Command, runCommand } from '../editor/commands';
import { Editor } from '../editor/Editor';
import { ShadingMode } from '../render/Renderer';
import { clear, h } from './dom';
import { icon } from './icons';

const MENUS: { label: string; categories: Command['category'][] }[] = [
  { label: 'File', categories: ['File'] },
  { label: 'Add', categories: ['Add'] },
  { label: 'Object', categories: ['Object'] },
  { label: 'Mesh', categories: ['Mesh'] },
  { label: 'Select', categories: ['Select'] },
  { label: 'View', categories: ['View'] },
];

/** Top bar: wordmark, menus, mode switch, select-mode and shading controls. */
export class Header {
  readonly root = h('header', { class: 'header' });
  private openMenu: HTMLElement | null = null;
  private modeArea = h('div', { class: 'header-right' });

  constructor(private editor: Editor, onShowShortcuts: () => void) {
    this.root.appendChild(h('div', { class: 'wordmark', title: 'Kiln' }, [
      h('span', { text: 'K' }),
      h('span', { class: 'wordmark-accent', text: 'I' }),
      h('span', { text: 'LN' }),
    ]));

    const menuBar = h('nav', { class: 'menu-bar' });
    for (const menu of MENUS) menuBar.appendChild(this.buildMenu(menu.label, menu.categories));
    menuBar.appendChild(h('button', {
      class: 'menu-label',
      text: 'Shortcuts',
      on: { click: () => { this.closeMenu(); onShowShortcuts(); } },
    }));
    this.root.appendChild(menuBar);
    this.root.appendChild(this.modeArea);

    document.addEventListener('pointerdown', (e) => {
      if (this.openMenu && !this.openMenu.contains(e.target as Node)) this.closeMenu();
    });
    editor.on('change', () => this.refresh());
    this.refresh();
  }

  private buildMenu(label: string, categories: Command['category'][]): HTMLElement {
    const items = h('div', { class: 'menu-items' });
    const wrapper = h('div', { class: 'menu' }, [
      h('button', {
        class: 'menu-label',
        text: label,
        on: {
          click: (e) => {
            e.stopPropagation();
            const isOpen = wrapper.classList.contains('open');
            this.closeMenu();
            if (!isOpen) {
              this.populate(items, categories);
              wrapper.classList.add('open');
              this.openMenu = wrapper;
            }
          },
        },
      }),
      items,
    ]);
    return wrapper;
  }

  private populate(container: HTMLElement, categories: Command['category'][]): void {
    clear(container);
    const ed = this.editor;
    let lastCategory = '';
    for (const cmd of COMMANDS) {
      if (!categories.includes(cmd.category)) continue;
      if (cmd.mode && cmd.mode !== ed.mode) continue;
      if (cmd.category !== lastCategory && lastCategory !== '') {
        container.appendChild(h('div', { class: 'menu-sep' }));
      }
      lastCategory = cmd.category;
      const disabled = cmd.enabled ? !cmd.enabled(ed) : false;
      container.appendChild(h('button', {
        class: `menu-item${disabled ? ' disabled' : ''}`,
        disabled,
        on: {
          click: () => {
            this.closeMenu();
            runCommand(ed, cmd.id);
          },
        },
      }, [
        h('span', { text: cmd.label }),
        cmd.shortcut ? h('kbd', { text: cmd.shortcut }) : null,
      ]));
    }
    if (!container.children.length) {
      container.appendChild(h('div', { class: 'menu-empty', text: 'Nothing available in this mode' }));
    }
  }

  private closeMenu(): void {
    this.openMenu?.classList.remove('open');
    this.openMenu = null;
  }

  refresh(): void {
    const ed = this.editor;
    clear(this.modeArea);

    const modeButton = h('button', {
      class: `mode-switch ${ed.mode}`,
      title: 'Tab — switch between Object and Edit mode',
      on: { click: () => ed.toggleEditMode() },
    }, [
      h('span', { class: 'mode-dot' }),
      h('span', { text: ed.mode === 'edit' ? 'Edit Mode' : 'Object Mode' }),
    ]);
    this.modeArea.appendChild(modeButton);

    if (ed.mode === 'edit') {
      const group = h('div', { class: 'seg-group' });
      const modes: { id: 'vertex' | 'edge' | 'face'; key: string }[] = [
        { id: 'vertex', key: '1' }, { id: 'edge', key: '2' }, { id: 'face', key: '3' },
      ];
      for (const m of modes) {
        group.appendChild(h('button', {
          class: `seg${ed.selectMode === m.id ? ' active' : ''}`,
          title: `${m.id[0].toUpperCase()}${m.id.slice(1)} select (${m.key})`,
          on: { click: () => ed.setSelectMode(m.id) },
        }, [icon(m.id)]));
      }
      this.modeArea.appendChild(group);
    }

    const shading = h('div', { class: 'seg-group' });
    const modes: { id: ShadingMode; label: string }[] = [
      { id: 'solid', label: 'Solid' },
      { id: 'material', label: 'Material' },
      { id: 'wireframe', label: 'Wireframe' },
    ];
    for (const m of modes) {
      shading.appendChild(h('button', {
        class: `seg${ed.options.shading === m.id ? ' active' : ''}`,
        title: `${m.label} shading (Z cycles)`,
        on: { click: () => ed.setShading(m.id) },
      }, [icon(m.id)]));
    }
    shading.appendChild(h('button', {
      class: `seg${ed.options.xray ? ' active' : ''}`,
      title: 'X-ray — see and select through surfaces (Alt+Z)',
      on: {
        click: () => {
          ed.options.xray = !ed.options.xray;
          ed.requestRender();
          ed.emit('change');
        },
      },
    }, [icon('xray')]));
    this.modeArea.appendChild(shading);
  }
}
