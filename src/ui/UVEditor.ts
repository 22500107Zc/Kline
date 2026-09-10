import { Editor } from '../editor/Editor';
import { stretchPerFace } from '../uv/unwrap';
import { Mesh } from '../mesh/Mesh';
import { h } from './dom';

/**
 * A 2D view of the edit mesh's texture coordinates, and an editor for them.
 *
 * Coordinates are stored per face corner, which is what lets a seam hold two
 * different values at the same point. That is right for the data and wrong for
 * editing: dragging one corner of a quad and leaving the three faces beside it
 * behind is never what anyone means. So corners that sit at the same place and
 * belong to the same mesh vertex are gathered into one draggable point, and a
 * seam stays two points because its corners genuinely are apart.
 *
 * Faces are shaded by stretch — how far their UV area departs from their
 * surface area — because that is the one thing a wireframe layout cannot show
 * and the thing that actually ruins a texture.
 */

interface UVPoint {
  u: number;
  v: number;
  /** Every face corner this point stands for. */
  refs: { face: number; corner: number }[];
}

export class UVEditor {
  readonly root = h('div', { class: 'uv-editor hidden' });
  private canvas = h('canvas', { class: 'uv-canvas' }) as HTMLCanvasElement;
  private info = h('div', { class: 'uv-info' });
  private showStretch = true;
  private size = 340;

  /** View transform: UV (0..1) to canvas pixels. */
  private zoom = 1;
  private panX = 0;
  private panY = 0;

  private points: UVPoint[] = [];
  private pointsRevision = -1;
  private pointsMesh: Mesh | null = null;
  private selected = new Set<number>();

  private drag:
    | { kind: 'move'; startU: number; startV: number; origin: [number, number][] }
    | { kind: 'box'; x0: number; y0: number; x1: number; y1: number }
    | { kind: 'pan'; x: number; y: number }
    | null = null;

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
          title: 'Shade faces by how far their UV area departs from their surface area',
          on: {
            click: () => {
              this.showStretch = !this.showStretch;
              this.draw();
            },
          },
        }),
        h('button', {
          class: 'btn', text: 'Select all',
          on: {
            click: () => {
              this.rebuildPoints();
              this.selected = new Set(this.points.map((_, i) => i));
              this.draw();
            },
          },
        }),
        h('button', {
          class: 'btn', text: 'Frame',
          title: 'Reset the view',
          on: {
            click: () => {
              this.zoom = 1;
              this.panX = 0;
              this.panY = 0;
              this.draw();
            },
          },
        }),
      ]),
      h('p', {
        class: 'uv-info',
        text: 'Drag a point to move it · Shift adds · drag empty space to box select · Alt+drag pans · scroll zooms',
      }),
    );
    editor.on('change', () => {
      if (this.visible) this.draw();
    });
    this.wire();
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

  // ------------------------------------------------------------- geometry

  /**
   * Gather face corners into draggable points.
   *
   * Rebuilt whenever the mesh changes, keyed on its revision — the editor's
   * own operators renumber faces freely, and a stale index would move the
   * wrong coordinates.
   */
  private rebuildPoints(): void {
    const mesh = this.editor.editMesh;
    if (!mesh) {
      this.points = [];
      this.pointsMesh = null;
      return;
    }
    if (this.pointsMesh === mesh && this.pointsRevision === mesh.revision) return;
    this.pointsMesh = mesh;
    this.pointsRevision = mesh.revision;
    this.selected.clear();

    const byKey = new Map<string, UVPoint>();
    for (let f = 0; f < mesh.faces.length; f++) {
      const uv = mesh.uvFor(f);
      if (!uv) continue;
      const loop = mesh.faces[f];
      for (let c = 0; c < loop.length; c++) {
        const u = uv[c * 2];
        const v = uv[c * 2 + 1];
        // Keyed on the mesh vertex as well as the coordinate: two islands can
        // land on the same spot in the atlas without being the same point.
        const key = `${loop[c]}:${u.toFixed(6)}:${v.toFixed(6)}`;
        const existing = byKey.get(key);
        if (existing) existing.refs.push({ face: f, corner: c });
        else byKey.set(key, { u, v, refs: [{ face: f, corner: c }] });
      }
    }
    this.points = [...byKey.values()];
  }

  /** Write the points' coordinates back onto the mesh. */
  private commitPoints(): void {
    const mesh = this.editor.editMesh;
    if (!mesh) return;
    for (const p of this.points) {
      for (const ref of p.refs) {
        const uv = mesh.uvFor(ref.face);
        if (!uv) continue;
        uv[ref.corner * 2] = p.u;
        uv[ref.corner * 2 + 1] = p.v;
      }
    }
    // Deliberately not `markDirty`: coordinates changed, adjacency did not,
    // and bumping the revision here would invalidate the point index we are
    // in the middle of dragging.
    this.editor.requestRender();
    const obj = this.editor.editObject;
    if (obj) this.editor.markGeometryDirty(obj);
    this.pointsRevision = mesh.revision;
  }

  // ----------------------------------------------------------------- view

  private toCanvas(u: number, v: number): [number, number] {
    return [
      (u * this.zoom + this.panX) * this.size,
      (1 - (v * this.zoom + this.panY)) * this.size,
    ];
  }

  private toUV(x: number, y: number): [number, number] {
    return [
      (x / this.size - this.panX) / this.zoom,
      (1 - y / this.size - this.panY) / this.zoom,
    ];
  }

  private localPointer(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private nearestPoint(x: number, y: number, within = 8): number {
    let best = -1;
    let bestD = within * within;
    for (let i = 0; i < this.points.length; i++) {
      const [px, py] = this.toCanvas(this.points[i].u, this.points[i].v);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private wire(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.rebuildPoints();
      const [x, y] = this.localPointer(e);
      this.canvas.setPointerCapture(e.pointerId);

      if (e.altKey || e.button === 1) {
        this.drag = { kind: 'pan', x, y };
        return;
      }
      const hit = this.nearestPoint(x, y);
      if (hit >= 0) {
        if (e.shiftKey) this.selected.add(hit);
        else if (!this.selected.has(hit)) this.selected = new Set([hit]);
        const [u, v] = this.toUV(x, y);
        this.drag = {
          kind: 'move',
          startU: u,
          startV: v,
          origin: this.points.map((p) => [p.u, p.v] as [number, number]),
        };
        if (!this.editor.beginUndo('Move UV')) return;
      } else {
        if (!e.shiftKey) this.selected.clear();
        this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y };
      }
      this.draw();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const [x, y] = this.localPointer(e);
      if (this.drag.kind === 'pan') {
        this.panX += (x - this.drag.x) / this.size;
        this.panY -= (y - this.drag.y) / this.size;
        this.drag.x = x;
        this.drag.y = y;
      } else if (this.drag.kind === 'box') {
        this.drag.x1 = x;
        this.drag.y1 = y;
      } else {
        const [u, v] = this.toUV(x, y);
        const du = u - this.drag.startU;
        const dv = v - this.drag.startV;
        for (const i of this.selected) {
          const [ou, ov] = this.drag.origin[i];
          this.points[i].u = ou + du;
          this.points[i].v = ov + dv;
        }
        this.commitPoints();
      }
      this.draw();
    });

    const finish = (): void => {
      if (this.drag?.kind === 'box') {
        const { x0, y0, x1, y1 } = this.drag;
        const lo = [Math.min(x0, x1), Math.min(y0, y1)];
        const hi = [Math.max(x0, x1), Math.max(y0, y1)];
        // A click rather than a drag: leave the selection as the pointerdown
        // left it instead of clearing everything the user just picked.
        if (hi[0] - lo[0] > 2 || hi[1] - lo[1] > 2) {
          for (let i = 0; i < this.points.length; i++) {
            const [px, py] = this.toCanvas(this.points[i].u, this.points[i].v);
            if (px >= lo[0] && px <= hi[0] && py >= lo[1] && py <= hi[1]) this.selected.add(i);
          }
        }
      }
      this.drag = null;
      this.draw();
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = this.localPointer(e);
      const before = this.toUV(x, y);
      this.zoom = Math.max(0.15, Math.min(20, this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const after = this.toUV(x, y);
      // Keep whatever was under the cursor under the cursor.
      this.panX += (after[0] - before[0]) * this.zoom;
      this.panY += (after[1] - before[1]) * this.zoom;
      this.draw();
    }, { passive: false });

    this.canvas.addEventListener('keydown', (e) => e.stopPropagation());
  }

  // ----------------------------------------------------------------- draw

  private draw(): void {
    const size = this.size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#14161b';
    ctx.fillRect(0, 0, size, size);

    // The unit square, which is the texture; anything outside it wraps.
    const [ax, ay] = this.toCanvas(0, 0);
    const [bx, by] = this.toCanvas(1, 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const [gx] = this.toCanvas(t, 0);
      const [, gy] = this.toCanvas(0, t);
      ctx.beginPath();
      ctx.moveTo(gx, by);
      ctx.lineTo(gx, ay);
      ctx.moveTo(ax, gy);
      ctx.lineTo(bx, gy);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));

    const mesh = this.editor.editMesh;
    if (!mesh) {
      this.info.textContent = 'Enter Edit Mode to see a UV layout.';
      return;
    }
    if (!mesh.hasUV) {
      this.info.textContent = 'No coordinates yet — press U to unwrap.';
      return;
    }
    this.rebuildPoints();

    const stretch = stretchPerFace(mesh);
    const selectedFaces = this.editor.selection.faces;
    let mapped = 0;

    for (let f = 0; f < mesh.faces.length; f++) {
      const uv = mesh.uvFor(f);
      if (!uv) continue;
      mapped++;
      ctx.beginPath();
      const [sx, sy] = this.toCanvas(uv[0], uv[1]);
      ctx.moveTo(sx, sy);
      for (let i = 2; i < uv.length; i += 2) {
        const [px, py] = this.toCanvas(uv[i], uv[i + 1]);
        ctx.lineTo(px, py);
      }
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
      if (selectedFaces.has(f)) ctx.fillStyle = 'rgba(255,158,41,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(230,236,245,0.5)';
      ctx.stroke();
    }

    // Points last, so they sit on top of the faces they belong to.
    for (let i = 0; i < this.points.length; i++) {
      const [px, py] = this.toCanvas(this.points[i].u, this.points[i].v);
      if (px < -4 || py < -4 || px > size + 4 || py > size + 4) continue;
      const on = this.selected.has(i);
      ctx.fillStyle = on ? '#ff9e2c' : 'rgba(235,240,250,0.75)';
      ctx.beginPath();
      ctx.arc(px, py, on ? 3.2 : 2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (this.drag?.kind === 'box') {
      const { x0, y0, x1, y1 } = this.drag;
      ctx.strokeStyle = '#ff9e2c';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }

    const valid = stretch.filter((x) => x > 0).sort((a, b) => a - b);
    const median = valid[Math.floor(valid.length / 2)] ?? 0;
    const sel = this.selected.size;
    this.info.textContent =
      `${mapped}/${mesh.faceCount} faces mapped · median stretch ${median.toFixed(2)}`
      + (sel ? ` · ${sel} point${sel === 1 ? '' : 's'} selected` : '');
  }
}
