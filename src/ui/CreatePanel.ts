import { Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { Mesh } from '../mesh/Mesh';
import { Bitmap, MaskChannel, MaskOptions, denoiseMask, maskFromBitmap, splitComponents, suggestMaskOptions, traceContours, simplifyContours } from '../imaging/contour';
import {
  HeightfieldOptions, LatheOptions, SilhouetteOptions,
  meshFromHeightfield, meshFromLathe, meshFromSilhouette,
} from '../imaging/generate';
import {
  Reference, bitmapFromReference, drawReferenceInto, isSupportedFile, loadReference,
  releaseReference, seekVideo,
} from '../imaging/load';
import { button, checkbox, clear, h, numberField, row, select } from './dom';

type Mode = 'silhouette' | 'lathe' | 'relief';

const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: 'silhouette', label: 'Cut Out', blurb: 'Trace the outline and extrude it into a solid.' },
  { id: 'lathe', label: 'Turn', blurb: 'Spin the profile around a vertical axis.' },
  { id: 'relief', label: 'Relief', blurb: 'Raise the surface by image brightness.' },
];

/**
 * Drop in a photo or a video frame and get geometry back.
 *
 * The object is built the moment a file lands, then rebuilt in place as the
 * settings change, so the reference and the mesh stay side by side instead of
 * the panel being a one-shot import dialog.
 */
export class CreatePanel {
  readonly root = h('div', { class: 'create-panel' });

  private reference: Reference | null = null;
  private bitmap: Bitmap | null = null;
  private mode: Mode = 'silhouette';
  private targetId: number | null = null;
  /** The name this panel gave the target, so a user rename is never clobbered. */
  private assignedName = '';
  private frameTime = 0;
  private busy = false;
  private pending = false;

  private mask: Required<Pick<MaskOptions, 'channel' | 'threshold' | 'invert'>> = {
    channel: 'luma', threshold: 0.5, invert: false,
  };
  private silhouette: Required<Pick<SilhouetteOptions, 'depth' | 'targetHeight' | 'simplify' | 'denoise' | 'maxParts' | 'bevel'>> = {
    depth: 0.4, targetHeight: 2, simplify: 1.2, denoise: 1, maxParts: 8, bevel: 0,
  };
  private lathe: Required<Pick<LatheOptions, 'segments' | 'targetHeight' | 'axis' | 'side' | 'smooth'>> = {
    segments: 48, targetHeight: 2, axis: 0.5, side: 'widest', smooth: true,
  };
  private relief: Required<Pick<HeightfieldOptions, 'resolution' | 'size' | 'height' | 'invert' | 'solid' | 'smooth'>> = {
    resolution: 128, size: 2, height: 0.35, invert: false, solid: false, smooth: true,
  };

  private preview = h('canvas', { class: 'ref-preview' });
  private body = h('div', { class: 'create-body' });
  private statsLine = h('p', { class: 'dim small create-stats' });

  constructor(private editor: Editor) {
    this.root.append(this.body);
    this.build();
  }

  /** Accept a file from the drop target or the file picker. */
  async loadFile(file: File): Promise<void> {
    if (!isSupportedFile(file)) {
      this.editor.setStatus(`${file.name} is not an image or a video`);
      return;
    }
    this.editor.setStatus(`Reading ${file.name}…`);
    try {
      const reference = await loadReference(file);
      releaseReference(this.reference);
      this.reference = reference;
      this.frameTime = 0;
      this.targetId = null;
      this.assignedName = '';
      if (reference.kind === 'video' && reference.duration > 0) {
        // The first frame of a video is often black; a little way in is safer.
        this.frameTime = Math.min(reference.duration * 0.1, 1);
        await seekVideo(reference.element as HTMLVideoElement, this.frameTime);
      }
      this.sampleFrame();
      const suggested = suggestMaskOptions(this.bitmap!);
      this.mask = {
        channel: (suggested.channel ?? 'luma') as MaskChannel,
        threshold: suggested.threshold ?? 0.5,
        invert: suggested.invert ?? false,
      };
      this.build();
      this.generate(true);
    } catch (err) {
      this.editor.setStatus((err as Error).message);
    }
  }

  dispose(): void {
    releaseReference(this.reference);
    this.reference = null;
  }

  private sampleFrame(): void {
    if (!this.reference) return;
    this.bitmap = bitmapFromReference(this.reference, this.mode === 'relief' ? 512 : 384);
  }

  // ------------------------------------------------------------------- build

  private build(): void {
    clear(this.body);
    if (!this.reference) {
      this.body.appendChild(this.dropZone());
      return;
    }
    this.body.appendChild(this.referenceSection());
    this.body.appendChild(this.modeSection());
    this.body.appendChild(this.settingsSection());
    this.body.appendChild(this.actionsSection());
    this.drawPreview();
  }

  private dropZone(): HTMLElement {
    const input = h('input', { type: 'file', class: 'hidden-input' });
    input.accept = 'image/*,video/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.loadFile(file);
    });

    const zone = h('div', {
      class: 'drop-zone',
      on: { click: () => input.click() },
    }, [
      h('div', { class: 'drop-mark', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 15l5-5 4 4 3-3 6 6"/><rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="8.5" cy="8.5" r="1.4"/></svg>' }),
      h('p', { class: 'drop-title', text: 'Drop an image or a video' }),
      h('p', { class: 'dim small', text: 'Or click to choose a file. It is read on this machine and never uploaded.' }),
      input,
    ]);
    return zone;
  }

  private referenceSection(): HTMLElement {
    const ref = this.reference!;
    const section = h('section', { class: 'prop-section' }, [
      h('div', { class: 'ref-head' }, [
        h('span', { class: 'ref-name', text: ref.name, title: ref.name }),
        h('button', {
          class: 'icon-btn small', text: '✕', title: 'Clear the reference',
          on: {
            click: () => {
              releaseReference(this.reference);
              this.reference = null;
              this.bitmap = null;
              this.targetId = null;
              this.assignedName = '';
              this.build();
            },
          },
        }),
      ]),
      this.preview,
      h('p', { class: 'dim small', text: `${ref.width}×${ref.height}${ref.kind === 'video' ? ` · ${ref.duration.toFixed(1)}s` : ''}` }),
    ]);

    if (ref.kind === 'video' && ref.duration > 0) {
      const slider = h('input', {
        type: 'range', class: 'slider',
        min: '0', max: ref.duration.toFixed(3), step: '0.01', value: `${this.frameTime}`,
      });
      const label = h('span', { class: 'mono small', text: `${this.frameTime.toFixed(2)}s` });
      let queued = false;
      const scrub = async (commit: boolean): Promise<void> => {
        if (queued) return;
        queued = true;
        this.frameTime = parseFloat(slider.value);
        label.textContent = `${this.frameTime.toFixed(2)}s`;
        await seekVideo(ref.element as HTMLVideoElement, this.frameTime);
        queued = false;
        this.sampleFrame();
        this.drawPreview();
        if (commit) this.generate(false);
      };
      slider.addEventListener('input', () => void scrub(false));
      slider.addEventListener('change', () => void scrub(true));
      section.appendChild(h('div', { class: 'scrub-row' }, [
        h('span', { class: 'prop-label', text: 'Frame' }), slider, label,
      ]));
    }
    return section;
  }

  private modeSection(): HTMLElement {
    const group = h('div', { class: 'mode-group' });
    for (const m of MODES) {
      group.appendChild(h('button', {
        class: `mode-btn${this.mode === m.id ? ' active' : ''}`,
        title: m.blurb,
        text: m.label,
        on: {
          click: () => {
            if (this.mode === m.id) return;
            this.mode = m.id;
            this.sampleFrame();
            this.build();
            // A different generator makes a very different shape, so refit the
            // view rather than leaving the camera inside the new object.
            this.generate(true, true);
          },
        },
      }));
    }
    return h('section', { class: 'prop-section' }, [
      group,
      h('p', { class: 'dim small', text: MODES.find((m) => m.id === this.mode)!.blurb }),
    ]);
  }

  private settingsSection(): HTMLElement {
    const section = h('section', { class: 'prop-section' }, [
      h('h3', { class: 'prop-heading', text: 'Settings' }),
    ]);

    const num = (
      label: string, value: number, step: number,
      set: (v: number) => void, opts: { min?: number; max?: number; precision?: number } = {},
    ): void => {
      section.appendChild(row(label, numberField({
        label: '', value, step, min: opts.min, max: opts.max, precision: opts.precision ?? 2,
        onLive: (v) => { set(v); this.generate(false); },
        onChange: (v) => { set(v); this.generate(true); },
      })));
    };
    const toggle = (label: string, value: boolean, set: (v: boolean) => void): void => {
      section.appendChild(checkbox(label, value, (v) => { set(v); this.generate(true); }));
    };

    if (this.mode !== 'relief') {
      section.appendChild(row('Detect', select(
        [
          { value: 'luma', label: 'Brightness' },
          { value: 'alpha', label: 'Transparency' },
          { value: 'red', label: 'Red channel' },
          { value: 'green', label: 'Green channel' },
          { value: 'blue', label: 'Blue channel' },
        ],
        this.mask.channel,
        (v) => { this.mask.channel = v as MaskChannel; this.generate(true); },
      )));
      num('Threshold', this.mask.threshold, 0.01, (v) => { this.mask.threshold = v; }, { min: 0, max: 1 });
      toggle('Subject is darker', this.mask.invert, (v) => { this.mask.invert = v; });
    }

    if (this.mode === 'silhouette') {
      num('Depth', this.silhouette.depth, 0.02, (v) => { this.silhouette.depth = v; }, { min: 0.001 });
      num('Height', this.silhouette.targetHeight, 0.05, (v) => { this.silhouette.targetHeight = v; }, { min: 0.01 });
      num('Smoothing', this.silhouette.simplify, 0.1, (v) => { this.silhouette.simplify = v; }, { min: 0, max: 12 });
      num('Clean up', this.silhouette.denoise, 1, (v) => { this.silhouette.denoise = Math.round(v); }, { min: 0, max: 5, precision: 0 });
      num('Bevel', this.silhouette.bevel, 0.01, (v) => { this.silhouette.bevel = v; }, { min: 0, max: 0.45 });
      num('Max parts', this.silhouette.maxParts, 1, (v) => { this.silhouette.maxParts = Math.round(v); }, { min: 1, max: 64, precision: 0 });
    } else if (this.mode === 'lathe') {
      num('Segments', this.lathe.segments, 1, (v) => { this.lathe.segments = Math.round(v); }, { min: 3, max: 256, precision: 0 });
      num('Height', this.lathe.targetHeight, 0.05, (v) => { this.lathe.targetHeight = v; }, { min: 0.01 });
      num('Axis', this.lathe.axis, 0.01, (v) => { this.lathe.axis = v; }, { min: 0, max: 1 });
      section.appendChild(row('Profile', select(
        [
          { value: 'widest', label: 'Widest side' },
          { value: 'left', label: 'Left of axis' },
          { value: 'right', label: 'Right of axis' },
        ],
        this.lathe.side,
        (v) => { this.lathe.side = v as 'widest' | 'left' | 'right'; this.generate(true); },
      )));
      toggle('Smooth shading', this.lathe.smooth, (v) => { this.lathe.smooth = v; });
    } else {
      num('Resolution', this.relief.resolution, 8, (v) => { this.relief.resolution = Math.round(v); }, { min: 8, max: 512, precision: 0 });
      num('Size', this.relief.size, 0.1, (v) => { this.relief.size = v; }, { min: 0.05 });
      num('Depth', this.relief.height, 0.02, (v) => { this.relief.height = v; }, { min: 0 });
      toggle('Invert', this.relief.invert, (v) => { this.relief.invert = v; });
      toggle('Solid block', this.relief.solid, (v) => { this.relief.solid = v; });
      toggle('Smooth shading', this.relief.smooth, (v) => { this.relief.smooth = v; });
    }

    section.appendChild(this.statsLine);
    return section;
  }

  private actionsSection(): HTMLElement {
    return h('section', { class: 'prop-section' }, [
      h('div', { class: 'btn-row' }, [
        button('Add as New Object', () => {
          this.targetId = null;
          this.assignedName = '';
          this.generate(true);
        }, { title: 'Keep the current result and build another from the same reference' }),
        button('Frame', () => this.editor.frameSelected(), { title: 'Zoom the viewport to the result' }),
      ]),
      h('p', { class: 'dim small', text: 'Tweaks rebuild the object in place. Everything after that is normal modelling — Tab into Edit Mode and keep going.' }),
    ]);
  }

  // ---------------------------------------------------------------- generate

  /** Rebuild the target object from the current settings. */
  private generate(commit: boolean, refit = false): void {
    if (!this.bitmap) return;
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    try {
      const result = this.buildMesh();
      if (result.mesh.faceCount === 0) {
        this.statsLine.textContent = 'Nothing found at this threshold — try moving it, or flip "subject is darker".';
        return;
      }

      let object = this.editor.scene.get(this.targetId);
      if (!object) {
        if (commit) this.editor.beginUndo('Create from reference');
        object = this.editor.scene.add('mesh', this.nameForMode(), result.mesh);
        object.position = this.placementFor(result.mesh);
        this.targetId = object.id;
        this.assignedName = object.name;
        this.editor.selectObject(object.id);
        this.editor.frameSelected();
      } else {
        object.mesh = result.mesh;
        // Keep the name honest as the mode changes, unless it was renamed.
        if (object.name === this.assignedName && !object.name.startsWith(this.nameForMode())) {
          object.name = this.editor.scene.uniqueName(this.nameForMode());
          this.assignedName = object.name;
        }
      }
      this.editor.markGeometryDirty(object);
      if (refit) this.editor.frameSelected();

      const { stats } = result;
      this.statsLine.textContent =
        `${stats.verts.toLocaleString()} verts · ${stats.faces.toLocaleString()} faces · ${stats.ms} ms`;
      this.editor.setStatus(`${object.name}: ${stats.faces.toLocaleString()} faces from ${this.reference?.name ?? 'reference'}`);
      this.drawPreview();
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        this.generate(false);
      }
    }
  }

  /**
   * Lay new results out along +X beside whatever is already in the scene,
   * rather than stacking every generated object on the 3D cursor.
   */
  private placementFor(mesh: Mesh): Vec3 {
    const cursor = this.editor.scene.cursor.clone();
    const existing = this.editor.scene.bounds(false);
    if (!existing.valid) return cursor;
    const box = mesh.bounds();
    if (!box.valid) return cursor;
    const gap = 0.4;
    cursor.x = existing.max.x + gap - box.min.x;
    return cursor;
  }

  private nameForMode(): string {
    return this.mode === 'silhouette' ? 'Cutout' : this.mode === 'lathe' ? 'Turned' : 'Relief';
  }

  private buildMesh(): ReturnType<typeof meshFromSilhouette> {
    const bitmap = this.bitmap!;
    if (this.mode === 'silhouette') {
      return meshFromSilhouette(bitmap, { ...this.silhouette, mask: { ...this.mask } });
    }
    if (this.mode === 'lathe') {
      return meshFromLathe(bitmap, {
        ...this.lathe,
        denoise: this.silhouette.denoise,
        mask: { ...this.mask },
      });
    }
    return meshFromHeightfield(bitmap, { ...this.relief });
  }

  /** Frame plus the traced outline, so the threshold is something you can see. */
  private drawPreview(): void {
    const ref = this.reference;
    if (!ref) return;
    const width = 260;
    const height = Math.max(90, Math.min(200, Math.round((width * ref.height) / ref.width)));
    this.preview.width = width;
    this.preview.height = height;
    const placement = drawReferenceInto(this.preview, ref);
    const ctx = this.preview.getContext('2d');
    if (!ctx || !placement || !this.bitmap || this.mode === 'relief') return;

    const mask = denoiseMask(maskFromBitmap(this.bitmap, this.mask), this.silhouette.denoise);
    const parts = splitComponents(mask, 32).slice(0, this.mode === 'lathe' ? 1 : this.silhouette.maxParts);
    const sx = placement.width / this.bitmap.width;
    const sy = placement.height / this.bitmap.height;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ff9e2c';
    ctx.fillStyle = 'rgba(255, 158, 44, 0.16)';
    for (const part of parts.length ? parts : [mask]) {
      for (const loop of simplifyContours(traceContours(part), this.silhouette.simplify)) {
        ctx.beginPath();
        loop.points.forEach(([x, y], i) => {
          const px = placement.x + x * sx;
          const py = placement.y + y * sy;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        if (!loop.hole) ctx.fill();
        ctx.stroke();
      }
    }
    if (this.mode === 'lathe') {
      const ax = placement.x + this.lathe.axis * placement.width;
      ctx.strokeStyle = '#4074c9';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(ax, placement.y);
      ctx.lineTo(ax, placement.y + placement.height);
      ctx.stroke();
    }
    ctx.restore();
  }
}
