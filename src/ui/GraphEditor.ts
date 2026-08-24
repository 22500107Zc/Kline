import { Editor } from '../editor/Editor';
import {
  CHANNEL_LABELS, Channel, ChannelPath, Interpolation, PROPERTY_PATHS, channelDefault,
  pathComponents, sampleChannel, setKey,
} from '../anim/animation';
import { clear, h } from './dom';

/**
 * The curve editor.
 *
 * A timeline shows you *when* something is keyed; it cannot show you what the
 * value does between those keys, and that is where animation actually lives.
 * A slow-in that overshoots, a hold that is not quite flat, two channels that
 * should move together and do not — none of it is visible until the curves are
 * drawn.
 *
 * Curves are sampled per pixel rather than drawn as bezier segments, because
 * the interpolation is already implemented once in `sampleChannel` and the
 * only way to be sure the picture matches playback is to ask the same function
 * the player asks.
 */

const AXIS_COLORS = ['#c94050', '#7ba832', '#4074c9'];

interface Hit {
  channel: Channel;
  keyIndex: number;
}

export class GraphEditor {
  readonly root = h('div', { class: 'graph-editor hidden' });
  private canvas = h('canvas', { class: 'graph-canvas' }) as HTMLCanvasElement;
  private info = h('div', { class: 'uv-info' });
  private channelList = h('div', { class: 'graph-channels' });
  private width = 560;
  private height = 260;

  /** Vertical view, in value units. Frames come from the timeline. */
  private valueLow = -1;
  private valueHigh = 1;
  private autoFit = true;

  private selected: Hit | null = null;
  private dragging = false;
  private hidden = new Set<string>();

  constructor(private editor: Editor) {
    this.root.append(
      h('div', { class: 'overlay-head' }, [
        h('h2', { text: 'Graph Editor' }),
        h('button', { class: 'icon-btn', text: '✕', title: 'Close', on: { click: () => this.hide() } }),
      ]),
      h('div', { class: 'graph-body' }, [this.channelList, this.canvas]),
      this.info,
      h('div', { class: 'uv-actions' }, [
        h('button', {
          class: 'btn', text: 'Fit',
          on: {
            click: () => {
              this.autoFit = true;
              this.draw();
            },
          },
        }),
        h('button', {
          class: 'btn', text: 'Ease',
          title: 'Set the selected key to smooth interpolation',
          on: { click: () => this.setInterp('bezier') },
        }),
        h('button', {
          class: 'btn', text: 'Linear',
          on: { click: () => this.setInterp('linear') },
        }),
        h('button', {
          class: 'btn', text: 'Hold',
          title: 'Constant: the value jumps at the next key rather than easing into it',
          on: { click: () => this.setInterp('constant') },
        }),
        h('button', {
          class: 'btn', text: 'Delete key',
          on: { click: () => this.deleteSelected() },
        }),
      ]),
      h('p', {
        class: 'uv-info',
        text: 'Drag a key to retime or revalue it · click a channel name to hide it',
      }),
    );
    editor.on('change', () => {
      if (this.visible) this.draw();
    });
    editor.on('frame', () => {
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
    this.autoFit = true;
    this.draw();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  // -------------------------------------------------------------- channels

  private channels(): Channel[] {
    const obj = this.editor.scene.get(this.editor.scene.active ?? -1);
    return obj ? obj.animation : [];
  }

  private key(ch: Channel): string {
    return `${ch.path}:${ch.index}`;
  }

  private visibleChannels(): Channel[] {
    return this.channels().filter((c) => !this.hidden.has(this.key(c)));
  }

  /** Add a channel for a property that has none yet, keyed where it stands. */
  addPropertyChannel(path: ChannelPath): void {
    const obj = this.editor.scene.get(this.editor.scene.active ?? -1);
    if (!obj) return;
    const scene = this.editor.scene;
    const frame = Math.round(scene.timeline.current);
    const material = scene.materials[obj.materialSlots[0] ?? 0];
    // Key the value the property actually has, so adding a channel is not also
    // an edit — nothing should move the moment it becomes animatable.
    let values = channelDefault(path);
    switch (path) {
      case 'light.energy': if (obj.light) values = [obj.light.energy]; break;
      case 'light.color': if (obj.light) values = [...obj.light.color]; break;
      case 'camera.fov': if (obj.camera) values = [obj.camera.fov]; break;
      case 'material.color': if (material) values = [...material.color]; break;
      case 'material.roughness': if (material) values = [material.roughness]; break;
      case 'material.metallic': if (material) values = [material.metallic]; break;
      case 'material.alpha': if (material) values = [material.alpha]; break;
      case 'material.emissionStrength': if (material) values = [material.emissionStrength]; break;
      default: break;
    }
    this.editor.beginUndo(`Animate ${CHANNEL_LABELS[path]}`);
    for (let i = 0; i < pathComponents(path); i++) {
      setKey(obj.animation, path, i, frame, values[i] ?? 0, 'bezier');
    }
    this.editor.setStatus(`Keyed ${CHANNEL_LABELS[path]} at frame ${frame}`);
    this.editor.emit('change');
  }

  /** Property paths that make sense for the active object and are not keyed. */
  availablePaths(): ChannelPath[] {
    const obj = this.editor.scene.get(this.editor.scene.active ?? -1);
    if (!obj) return [];
    const has = new Set(obj.animation.map((c) => c.path));
    const material = this.editor.scene.materials[obj.materialSlots[0] ?? 0];
    return PROPERTY_PATHS.filter((p) => {
      if (has.has(p)) return false;
      if (p.startsWith('light.')) return !!obj.light;
      if (p.startsWith('camera.')) return !!obj.camera;
      if (p.startsWith('material.')) return !!material && obj.type === 'mesh';
      return true;
    });
  }

  // ------------------------------------------------------------------ view

  private frameRange(): [number, number] {
    const t = this.editor.scene.timeline;
    return [t.start, Math.max(t.start + 1, t.end)];
  }

  private toX(frame: number): number {
    const [a, b] = this.frameRange();
    return ((frame - a) / (b - a)) * this.width;
  }

  private toY(value: number): number {
    const span = Math.max(1e-6, this.valueHigh - this.valueLow);
    return this.height - ((value - this.valueLow) / span) * this.height;
  }

  private fromX(x: number): number {
    const [a, b] = this.frameRange();
    return a + (x / this.width) * (b - a);
  }

  private fromY(y: number): number {
    const span = this.valueHigh - this.valueLow;
    return this.valueLow + ((this.height - y) / this.height) * span;
  }

  private fit(): void {
    let lo = Infinity;
    let hi = -Infinity;
    for (const ch of this.visibleChannels()) {
      for (const k of ch.keys) {
        lo = Math.min(lo, k.value);
        hi = Math.max(hi, k.value);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -1;
      hi = 1;
    }
    // A flat curve has no range of its own; give it one rather than dividing
    // by zero and drawing a line through the middle of nothing.
    if (hi - lo < 1e-6) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.12;
    this.valueLow = lo - pad;
    this.valueHigh = hi + pad;
  }

  private hitTest(x: number, y: number): Hit | null {
    let best: Hit | null = null;
    let bestD = 100;
    for (const ch of this.visibleChannels()) {
      for (let i = 0; i < ch.keys.length; i++) {
        const kx = this.toX(ch.keys[i].frame);
        const ky = this.toY(ch.keys[i].value);
        const d = (kx - x) ** 2 + (ky - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { channel: ch, keyIndex: i };
        }
      }
    }
    return best;
  }

  private setInterp(interp: Interpolation): void {
    if (!this.selected) {
      this.editor.setStatus('Select a key first');
      return;
    }
    this.editor.beginUndo('Key interpolation');
    this.selected.channel.keys[this.selected.keyIndex].interp = interp;
    this.editor.emit('change');
    this.editor.requestRender();
  }

  private deleteSelected(): void {
    if (!this.selected) return;
    const obj = this.editor.scene.get(this.editor.scene.active ?? -1);
    if (!obj) return;
    this.editor.beginUndo('Delete key');
    this.selected.channel.keys.splice(this.selected.keyIndex, 1);
    // A channel with nothing in it is not a channel.
    obj.animation = obj.animation.filter((c) => c.keys.length > 0);
    this.selected = null;
    this.editor.emit('change');
    this.editor.requestRender();
  }

  private wire(): void {
    const local = (e: PointerEvent): [number, number] => {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e);
      this.canvas.setPointerCapture(e.pointerId);
      const hit = this.hitTest(x, y);
      this.selected = hit;
      if (hit) {
        this.dragging = true;
        this.editor.beginUndo('Move key');
      } else {
        // Empty space scrubs, which is what a click in a timeline should do.
        this.editor.setFrame(Math.round(this.fromX(x)));
      }
      this.draw();
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.selected) return;
      const [x, y] = local(e);
      const ch = this.selected.channel;
      const key = ch.keys[this.selected.keyIndex];
      key.value = this.fromY(y);
      key.frame = Math.round(this.fromX(x));
      // Keys are held sorted, and dragging one past another has to keep that
      // true or every lookup after it reads the wrong span.
      ch.keys.sort((a, b) => a.frame - b.frame);
      this.selected.keyIndex = ch.keys.indexOf(key);
      this.editor.scene.setFrame(this.editor.scene.timeline.current);
      this.editor.requestRender();
      this.draw();
    });
    const stop = (): void => {
      if (this.dragging) this.editor.emit('change');
      this.dragging = false;
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.autoFit = false;
      const centre = (this.valueLow + this.valueHigh) / 2;
      const half = ((this.valueHigh - this.valueLow) / 2) * (e.deltaY < 0 ? 1 / 1.15 : 1.15);
      this.valueLow = centre - half;
      this.valueHigh = centre + half;
      this.draw();
    }, { passive: false });
  }

  // ------------------------------------------------------------------ draw

  private drawChannelList(): void {
    clear(this.channelList);
    const groups = new Map<ChannelPath, Channel[]>();
    for (const ch of this.channels()) {
      const g = groups.get(ch.path) ?? [];
      g.push(ch);
      groups.set(ch.path, g);
    }
    for (const [path, list] of groups) {
      this.channelList.appendChild(h('div', { class: 'graph-group', text: CHANNEL_LABELS[path] }));
      for (const ch of list.sort((a, b) => a.index - b.index)) {
        const k = this.key(ch);
        const off = this.hidden.has(k);
        const single = pathComponents(path) === 1;
        this.channelList.appendChild(h('button', {
          class: `graph-chan${off ? ' off' : ''}`,
          text: single ? 'value' : ['X', 'Y', 'Z'][ch.index] ?? String(ch.index),
          on: {
            click: () => {
              if (off) this.hidden.delete(k);
              else this.hidden.add(k);
              this.draw();
            },
          },
        })).style.borderLeftColor = AXIS_COLORS[single ? 2 : ch.index] ?? '#888';
      }
    }
    const available = this.availablePaths();
    if (available.length > 0) {
      const add = h('select', { class: 'sel' }) as HTMLSelectElement;
      add.append(h('option', { value: '', text: '+ animate…' }));
      for (const p of available) add.append(h('option', { value: p, text: CHANNEL_LABELS[p] }));
      add.addEventListener('change', () => {
        if (add.value) this.addPropertyChannel(add.value as ChannelPath);
        add.value = '';
      });
      add.addEventListener('keydown', (e) => e.stopPropagation());
      this.channelList.appendChild(add);
    }
  }

  private draw(): void {
    this.drawChannelList();
    if (this.autoFit) this.fit();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#14161b';
    ctx.fillRect(0, 0, this.width, this.height);

    const channels = this.visibleChannels();
    if (this.channels().length === 0) {
      this.info.textContent = 'Select an animated object, or key something with I.';
      return;
    }

    // Value grid, at a round step for whatever range is on screen.
    const span = this.valueHigh - this.valueLow;
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(span / 4, 1e-9))));
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = 'rgba(148,141,138,0.9)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (let v = Math.ceil(this.valueLow / step) * step; v <= this.valueHigh; v += step) {
      const y = this.toY(v);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(step < 1 ? 2 : 0), 3, y - 2);
    }

    // Curves, sampled per pixel through the same function playback uses.
    for (const ch of channels) {
      const single = pathComponents(ch.path) === 1;
      ctx.strokeStyle = AXIS_COLORS[single ? 2 : ch.index] ?? '#999';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= this.width; x++) {
        const v = sampleChannel(ch, this.fromX(x));
        if (v === null) continue;
        const y = this.toY(v);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      for (let i = 0; i < ch.keys.length; i++) {
        const k = ch.keys[i];
        const x = this.toX(k.frame);
        const y = this.toY(k.value);
        const on = this.selected?.channel === ch && this.selected.keyIndex === i;
        ctx.fillStyle = on ? '#ff9e2c' : ctx.strokeStyle;
        // A held key is drawn square, an eased one round: the shape says what
        // the curve will do without having to select it and read a label.
        if (k.interp === 'constant') ctx.fillRect(x - 3, y - 3, 6, 6);
        else {
          ctx.beginPath();
          ctx.arc(x, y, on ? 4 : 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Playhead.
    const px = this.toX(this.editor.scene.timeline.current);
    ctx.strokeStyle = '#ff9e2c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, this.height);
    ctx.stroke();

    const sel = this.selected;
    this.info.textContent = sel
      ? `${CHANNEL_LABELS[sel.channel.path]} `
        + `${['X', 'Y', 'Z'][sel.channel.index] ?? ''} · `
        + `frame ${sel.channel.keys[sel.keyIndex].frame} · `
        + `${sel.channel.keys[sel.keyIndex].value.toFixed(4)} · `
        + `${sel.channel.keys[sel.keyIndex].interp}`
      : `${channels.length} channel${channels.length === 1 ? '' : 's'} shown`;
  }
}
