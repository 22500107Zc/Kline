import { Editor } from '../editor/Editor';
import { stretchPerFace } from '../uv/unwrap';
import { h } from './dom';

/**
 * A 2D view of the edit mesh's texture coordinates.
 *
 * Faces are shaded by stretch — how far their UV area departs from their
 * surface area — because that is the one thing a wireframe UV layout cannot
 * show and the thing that actually ruins a texture.
 */
export class UVEditor {
  readonly root = h('div', { class: 'uv-editor hidden' });
  private canvas = h('canvas', { class: 'uv-canvas' });
  private info = h('div', { class: 'uv-info' });
  private showStretch = true;

  constructor(private editor: Editor) {
    this.root.append(
      h('div', { class: 'overlay-head' }, [
        h('h2', { text: 'UV Editor' }),
        h('button', {
          class: 'icon-btn', text: '✕', title: 'Close', on: { click: () => this.hide() },
        }),
      ]),
      this.canvas,
      this.info,
      h('div', { class: 'uv-actions' }, [
        h('button', {
          class: 'btn', text: 'Stretch',
          on: {
            click: () => {
              this.showStretch = !this.showStretch;
              this.draw();
            },
          },
        }),
      ]),
    );
    editor.on('change', () => {
      if (this.visible) this.draw();
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.draw();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private draw(): void {
    const size = 320;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    ctx.fillStyle = '#14161b';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const p = (i / 8) * size;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    const mesh = this.editor.editMesh;
    if (!mesh) {
      this.info.textContent = 'Enter Edit Mode to see a UV layout.';
      return;
    }
    if (!mesh.hasUV) {
      this.info.textContent = 'No coordinates yet — press U to unwrap.';
      return;
    }

    const stretch = stretchPerFace(mesh);
    const selected = this.editor.selection.faces;
    let mapped = 0;
    // Y is flipped: image space runs downward, UV space runs up.
    const px = (u: number): number => u * size;
    const py = (v: number): number => (1 - v) * size;

    for (let f = 0; f < mesh.faces.length; f++) {
      const uv = mesh.uvFor(f);
      if (!uv) continue;
      mapped++;
      ctx.beginPath();
      ctx.moveTo(px(uv[0]), py(uv[1]));
      for (let i = 2; i < uv.length; i += 2) ctx.lineTo(px(uv[i]), py(uv[i + 1]));
      ctx.closePath();
      if (this.showStretch) {
        const s = stretch[f] || 1;
        // 1 is neutral; compressed goes blue, stretched goes red.
        const d = Math.max(-1, Math.min(1, Math.log(Math.max(s, 1e-4)) / Math.log(3)));
        const r = Math.round(120 + d * 110);
        const g = Math.round(150 - Math.abs(d) * 90);
        const b = Math.round(120 - d * 110);
        ctx.fillStyle = `rgba(${r},${g},${b},0.55)`;
      } else {
        ctx.fillStyle = 'rgba(120,150,190,0.35)';
      }
      if (selected.has(f)) ctx.fillStyle = 'rgba(255,158,41,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(230,236,245,0.5)';
      ctx.stroke();
    }

    const valid = stretch.filter((x) => x > 0).sort((a, b) => a - b);
    const median = valid[Math.floor(valid.length / 2)] ?? 0;
    this.info.textContent =
      `${mapped}/${mesh.faceCount} faces mapped · median stretch ${median.toFixed(2)}`;
  }
}
