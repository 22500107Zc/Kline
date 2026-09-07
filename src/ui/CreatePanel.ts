import { Vec3 } from '../core/math';
import { Editor } from '../editor/Editor';
import { SceneObject } from '../scene/Scene';
import { Mesh } from '../mesh/Mesh';
import { Bitmap, MaskChannel, MaskOptions, denoiseMask, maskFromBitmap, splitComponents, suggestMaskOptions, traceContours, simplifyContours } from '../imaging/contour';
import {
  HeightfieldOptions, LatheOptions, SilhouetteOptions,
  meshFromHeightfield, meshFromLathe, meshFromSilhouette,
} from '../imaging/generate';
import { PhotoOptions, PhotoResult, meshFromPhoto } from '../imaging/photo';
import { DepthField, DepthOptions, depthFromPhoto } from '../imaging/depth';
import { MIN_SEPARATION, Matte, segmentSubject } from '../imaging/segment';
import { createTexture } from '../scene/Texture';
import { createMaterial } from '../scene/Material';
import {
  Reference, bitmapFromReference, blobFromReference, drawReferenceInto, isSupportedFile,
  loadReference, releaseReference, seekVideo, textureFromReference,
} from '../imaging/load';
import { BackendInfo, generateMesh, probeBackend, storeEndpoint, storedEndpoint } from '../ai/client';
import { button, checkbox, clear, h, numberField, row, select } from './dom';

type Mode = 'photo' | 'silhouette' | 'lathe' | 'relief';

const MODES: { id: Mode; label: string; blurb: string }[] = [
  {
    id: 'photo',
    label: 'Photo',
    blurb: 'Find the subject by colour, inflate it to its own thickness, and project the photo back on. '
      + 'The far side is the near side, shallower — a photograph does not contain the back.',
  },
  { id: 'silhouette', label: 'Cut Out', blurb: 'Trace the outline and extrude it into a flat solid.' },
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
  private mode: Mode = 'photo';
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
  private photo: Required<Pick<PhotoOptions, 'resolution' | 'targetHeight' | 'depthScale' | 'back'>>
    & Required<Pick<DepthOptions, 'volume' | 'detail' | 'symmetry'>> & { texture: boolean } = {
      resolution: 160, targetHeight: 2, depthScale: 1, back: 0.8,
      volume: 1, detail: 0.35, symmetry: 0.5, texture: true,
    };
  /**
   * Finding the subject and solving its thickness cost a few hundred
   * milliseconds and depend on neither the grid resolution nor the target
   * height. Cached against the settings that do change them, so dragging a
   * slider rebuilds the mesh and nothing else.
   */
  private matte: { key: string; value: Matte } | null = null;
  private depthField: { key: string; value: DepthField } | null = null;
  /** The texture id already made for this reference, so retries do not pile up copies. */
  private photoTexture: { key: string; id: number } | null = null;
  /**
   * The material slot this panel made, and which object it made it for.
   *
   * Kept because the object is rebuilt on every settings change, and a fresh
   * material each time would mean one per slider event — hundreds of them in
   * the material list and in the saved file, all identical, all but one
   * unused.
   */
  private photoMaterial: { objectId: number; slot: number } | null = null;
  /** Whether the viewport has already been switched over to show a photograph. */
  private revealedTexture = false;
  /** Fraction of the frame the last photo build found as subject. */
  private lastCoverage = 0;
  /** Pending debounced photo rebuild, if a slider is mid-drag. */
  private photoTimer: number | null = null;

  private endpoint = storedEndpoint();
  private backend: BackendInfo | null = null;
  private backendModel = '';
  private aiPrompt = '';
  private aiRunning: AbortController | null = null;
  /** Whether a probe has run, so the rebuild does not clobber its message. */
  private aiChecked = false;
  private aiStatus = h('span', { class: 'ai-status', text: 'not checked' });
  private aiNote = h('p', { class: 'dim small' });

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
    if (this.photoTimer !== null) {
      clearTimeout(this.photoTimer);
      this.photoTimer = null;
    }
    releaseReference(this.reference);
    this.reference = null;
  }

  private sampleFrame(): void {
    if (!this.reference) return;
    // Photo mode reads colour and shading rather than tracing an outline, and
    // it now fits its grid to the subject rather than to the frame — so a
    // sharper source buys detail in the model instead of just costing time.
    const detail = this.mode === 'photo' ? 512 : this.mode === 'relief' ? 512 : 384;
    this.bitmap = bitmapFromReference(this.reference, detail);
    this.matte = null;
    this.depthField = null;
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
    this.body.appendChild(this.aiSection());
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

    if (this.mode !== 'relief' && this.mode !== 'photo') {
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

    if (this.mode === 'photo') {
      num('Detail', this.photo.resolution, 8, (v) => { this.photo.resolution = Math.round(v); }, { min: 24, max: 400, precision: 0 });
      num('Height', this.photo.targetHeight, 0.05, (v) => { this.photo.targetHeight = v; }, { min: 0.01 });
      num('Roundness', this.photo.volume, 0.05, (v) => { this.photo.volume = v; }, { min: 0, max: 2 });
      num('Surface relief', this.photo.detail, 0.05, (v) => { this.photo.detail = v; }, { min: 0, max: 1 });
      num('Even out the sides', this.photo.symmetry, 0.05, (v) => { this.photo.symmetry = v; }, { min: 0, max: 1 });
      num('Thickness', this.photo.depthScale, 0.05, (v) => { this.photo.depthScale = v; }, { min: 0.02, max: 4 });
      num('Back fullness', this.photo.back, 0.05, (v) => { this.photo.back = v; }, { min: 0, max: 1 });
      toggle('Project the photo on as a texture', this.photo.texture, (v) => { this.photo.texture = v; });
    } else if (this.mode === 'silhouette') {
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

  /**
   * Hand the frame to a local image-to-3D model, if one is running. The whole
   * feature is opt-in and points at 127.0.0.1 by default: no endpoint, no
   * network traffic.
   */
  private aiSection(): HTMLElement {
    const section = h('section', { class: 'prop-section ai-section' }, [
      h('h3', { class: 'prop-heading' }, [
        h('span', { text: 'Local AI model' }),
        this.aiStatus,
      ]),
    ]);

    const input = h('input', { class: 'text-input', type: 'text', value: this.endpoint });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      this.endpoint = input.value.trim() || this.endpoint;
      storeEndpoint(this.endpoint);
      void this.checkBackend();
    });
    section.appendChild(row('Server', input));

    if (this.backend && this.backend.models.length > 1) {
      section.appendChild(row('Model', select(
        this.backend.models.map((m) => ({ value: m, label: m })),
        this.backendModel || this.backend.models[0],
        (v) => { this.backendModel = v; },
      )));
    }

    const prompt = h('input', {
      class: 'text-input', type: 'text', value: this.aiPrompt,
      placeholder: 'optional hint, if the model takes one',
    });
    prompt.addEventListener('keydown', (e) => e.stopPropagation());
    prompt.addEventListener('input', () => { this.aiPrompt = prompt.value; });
    section.appendChild(row('Prompt', prompt));

    section.appendChild(h('div', { class: 'btn-row' }, [
      button(this.aiRunning ? 'Cancel' : 'Generate 3D', () => {
        if (this.aiRunning) {
          this.aiRunning.abort();
          return;
        }
        void this.runBackend();
      }, { class: this.aiRunning ? '' : 'primary', title: 'Send this frame to the local model' }),
      button('Check', () => void this.checkBackend(), { title: 'See whether a server is listening' }),
    ]));
    section.appendChild(this.aiNote);
    if (!this.aiChecked && !this.aiRunning) {
      this.aiNote.textContent =
        'Optional. Point this at a local image-to-3D server — tools/kline-ai-server.py in the repo is a working example. Everything above works without it.';
    }
    return section;
  }

  private setBackendStatus(text: string, state: 'ok' | 'bad' | 'idle' | 'busy'): void {
    this.aiStatus.textContent = text;
    this.aiStatus.className = `ai-status ${state}`;
  }

  private async checkBackend(): Promise<void> {
    this.aiChecked = true;
    this.setBackendStatus('checking…', 'busy');
    const result = await probeBackend(this.endpoint);
    if (result.ok) {
      this.backend = result.info;
      this.backendModel = this.backendModel || result.info.models[0] || '';
      this.setBackendStatus(result.info.name, 'ok');
      this.aiNote.textContent = result.info.detail ?? 'Ready.';
    } else {
      this.backend = null;
      this.setBackendStatus('offline', 'bad');
      this.aiNote.textContent = `${result.reason} at ${this.endpoint}. Start a server, or keep using the generators above.`;
    }
    this.build();
  }

  private async runBackend(): Promise<void> {
    if (!this.reference) return;
    const controller = new AbortController();
    this.aiRunning = controller;
    this.setBackendStatus('generating…', 'busy');
    this.aiNote.textContent = 'Working. This can take anywhere from seconds to minutes.';
    this.build();
    const started = Date.now();
    try {
      const image = await blobFromReference(this.reference);
      const result = await generateMesh(this.endpoint, {
        image,
        model: this.backendModel || undefined,
        prompt: this.aiPrompt || undefined,
        signal: controller.signal,
      });
      this.editor.beginUndo('Generate with local model');
      const object = this.editor.scene.add('mesh', result.name || 'AI Mesh', result.mesh);
      object.position = this.placementFor(result.mesh);
      this.editor.selectObject(object.id);
      this.editor.markGeometryDirty(object);
      this.editor.frameSelected();
      const seconds = result.seconds ?? (Date.now() - started) / 1000;
      this.setBackendStatus('done', 'ok');
      this.aiNote.textContent =
        `${result.mesh.faceCount.toLocaleString()} faces in ${seconds.toFixed(1)}s. It is a normal mesh now — edit it like anything else.`;
      this.editor.setStatus(`${object.name}: ${result.mesh.faceCount.toLocaleString()} faces from the local model`);
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.setBackendStatus(aborted ? 'cancelled' : 'failed', aborted ? 'idle' : 'bad');
      this.aiNote.textContent = aborted ? 'Cancelled.' : (err as Error).message;
    } finally {
      this.aiRunning = null;
      this.build();
    }
  }

  // ---------------------------------------------------------------- generate

  /**
   * Rebuild the target object from the current settings.
   *
   * Photo mode's analysis costs the better part of a second, and a slider
   * emits an event per pixel of travel — so a live drag would queue forty of
   * those and the panel would still be catching up a minute later. Live
   * changes wait until the dragging stops; releasing the slider rebuilds at
   * once. Everything else is fast enough to run on every event, as it did.
   */
  private generate(commit: boolean, refit = false): void {
    if (this.photoTimer !== null) {
      clearTimeout(this.photoTimer);
      this.photoTimer = null;
    }
    if (this.mode !== 'photo' || commit) {
      this.generateNow(commit, refit);
      return;
    }
    this.statsLine.textContent = 'Working…';
    this.photoTimer = setTimeout(() => {
      this.photoTimer = null;
      this.generateNow(false, refit);
    }, 160) as unknown as number;
  }

  private generateNow(commit: boolean, refit = false): void {
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
      if (this.mode === 'photo') this.applyPhotoTexture(object);
      this.editor.markGeometryDirty(object);
      if (refit) this.editor.frameSelected();

      const { stats } = result;
      this.statsLine.textContent =
        `${stats.verts.toLocaleString()} verts · ${stats.faces.toLocaleString()} faces · ${stats.ms} ms`;
      if (this.mode === 'photo') this.reportSubject();
      this.editor.setStatus(`${object.name}: ${stats.faces.toLocaleString()} faces from ${this.reference?.name ?? 'reference'}`);
      this.drawPreview();
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        this.generateNow(false);
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
    if (this.mode === 'photo') return 'Photo';
    return this.mode === 'silhouette' ? 'Cutout' : this.mode === 'lathe' ? 'Turned' : 'Relief';
  }

  private buildMesh(): ReturnType<typeof meshFromSilhouette> {
    const bitmap = this.bitmap!;
    if (this.mode === 'photo') return this.buildPhoto(bitmap);
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

  /**
   * The photograph route, with the slow half cached.
   *
   * Segmentation and the depth solve are keyed on the settings that actually
   * change them. Without that, nudging the target height would re-run a
   * GrabCut and a Poisson solve — half a second of work to move some vertices
   * that were already in the right place relative to each other.
   */
  private buildPhoto(bitmap: Bitmap): PhotoResult {
    const matteKey = `${bitmap.width}x${bitmap.height}:${this.frameTime}`;
    if (this.matte?.key !== matteKey) {
      this.matte = { key: matteKey, value: segmentSubject(bitmap) };
      this.depthField = null;
    }
    const matte = this.matte.value;

    const depthKey = `${matteKey}|${this.photo.volume}|${this.photo.detail}|${this.photo.symmetry}`;
    if (this.depthField?.key !== depthKey) {
      this.depthField = {
        key: depthKey,
        value: depthFromPhoto(bitmap, matte, {
          volume: this.photo.volume,
          detail: this.photo.detail,
          symmetry: this.photo.symmetry,
        }),
      };
    }

    const result = meshFromPhoto(bitmap, {
      resolution: this.photo.resolution,
      targetHeight: this.photo.targetHeight,
      depthScale: this.photo.depthScale,
      back: this.photo.back,
      matte,
      field: this.depthField.value,
    });
    this.noteCoverage(result);
    return result;
  }

  /** Remember what the last photo build found, for the line under the settings. */
  private noteCoverage(result: PhotoResult): void {
    this.lastCoverage = result.coverage;
  }

  /**
   * Say what was found, and say when it was not found.
   *
   * A subject that covers the whole frame, or none of it, means the colour
   * models could not tell the thing from the room behind it — and the model
   * that comes out is then a rectangle or nothing. Announcing that beats
   * letting someone conclude the feature is broken and close the panel.
   */
  private reportSubject(): void {
    const matte = this.matte?.value;
    if (!matte) return;
    const percent = Math.round(this.lastCoverage * 100);
    if (matte.separation < MIN_SEPARATION) {
      this.statsLine.textContent +=
        ' — the subject and the background are the same colours here, so the whole frame was used. '
        + 'Crop to the subject, or shoot it against something that contrasts.';
    } else if (percent < 3) {
      this.statsLine.textContent += ' — almost nothing was found; try a photo where the subject is nearer the middle.';
    } else {
      this.statsLine.textContent += ` — subject fills ${percent}% of the frame`;
    }
  }

  /**
   * Put the photograph on the model.
   *
   * This is not decoration. An inflated silhouette with no texture is a grey
   * lump in roughly the right outline, and it is the step everyone skips —
   * the difference between "that is my shoe" and "that is a shoe-shaped
   * thing" is almost entirely the picture being on it.
   */
  private applyPhotoTexture(object: SceneObject): void {
    const ref = this.reference;
    if (!ref) return;
    const scene = this.editor.scene;
    if (!this.photo.texture) {
      object.materialSlots = [scene.ensureDefaultMaterial()];
      return;
    }
    const key = `${ref.name}:${this.frameTime}`;
    if (this.photoTexture?.key !== key) {
      try {
        const { url, width, height } = textureFromReference(ref);
        const texture = createTexture(ref.name.replace(/\.[^.]+$/, ''), url, width, height);
        const stale = this.photoTexture?.id ?? null;
        scene.textures.push(texture);
        this.photoTexture = { key, id: texture.id };
        // The previous frame's copy goes, unless something else has taken it
        // up in the meantime. A texture is an embedded PNG; scrubbing a video
        // would otherwise put one in the file per frame anyone looked at.
        if (stale !== null && !scene.materials.some((m) => m.baseColorTexture === stale)) {
          const at = scene.textures.findIndex((t) => t.id === stale);
          if (at >= 0) scene.textures.splice(at, 1);
        }
      } catch (err) {
        this.editor.setStatus(`The model was built, but the photo could not be used as a texture: ${(err as Error).message}`);
        return;
      }
    }

    const settings = {
      name: `${object.name} surface`,
      baseColorTexture: this.photoTexture.id,
      // A photograph already contains its own highlights; a shiny material on
      // top of one reads as plastic wrap.
      roughness: 0.85,
      metallic: 0,
    };
    // One material for this object, updated in place. A new one per rebuild
    // would leave the material list full of identical orphans, and every one
    // of them would be written into the saved scene.
    const existing = this.photoMaterial;
    if (existing && existing.objectId === object.id && scene.materials[existing.slot]) {
      Object.assign(scene.materials[existing.slot], settings);
      object.materialSlots = [existing.slot];
      this.showTexture();
      return;
    }
    const slot = scene.addMaterial(createMaterial(settings));
    this.photoMaterial = { objectId: object.id, slot };
    object.materialSlots = [slot];
    this.showTexture();
  }

  /**
   * Put the viewport where the photograph can be seen.
   *
   * Solid shading is the right default for modelling — it reads shape without
   * a material in the way — but it is the wrong thing to be looking at one
   * second after dropping a photograph on the window. The whole promise is
   * that the picture comes out on the model, and in solid shading it does
   * not: the first thing anyone saw after using the headline feature was a
   * grey blob, with nothing on screen to say the photograph had arrived at
   * all.
   *
   * Once, on the first photo model of the session. Anybody who then goes back
   * to solid shading meant it, and is left alone.
   */
  private showTexture(): void {
    if (this.revealedTexture) return;
    this.revealedTexture = true;
    if (this.editor.options.shading !== 'solid') return;
    this.editor.setShading('material');
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

    if (this.mode === 'photo') {
      // The matte over the frame, so the thing being modelled is visible
      // before the model exists. Photo mode does not use a threshold, so
      // there is nothing to nudge — but there is plenty to check.
      const matte = this.matte?.value;
      if (!matte) return;
      const overlay = document.createElement('canvas');
      overlay.width = matte.width;
      overlay.height = matte.height;
      const octx = overlay.getContext('2d');
      if (!octx) return;
      const image = octx.createImageData(matte.width, matte.height);
      for (let i = 0; i < matte.data.length; i++) {
        image.data[i * 4] = 255;
        image.data[i * 4 + 1] = 158;
        image.data[i * 4 + 2] = 44;
        image.data[i * 4 + 3] = Math.round((1 - Math.min(1, matte.data[i])) * 150);
      }
      octx.putImageData(image, 0, 0);
      ctx.drawImage(overlay, placement.x, placement.y, placement.width, placement.height);
      return;
    }

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
