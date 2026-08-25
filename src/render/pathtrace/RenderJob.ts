import { denoise } from './denoise';
import { Bvh, buildBvh, renderBand, tonemapToImage } from './tracer';
import { BandRequest, BandResult, RenderSettings, TraceScene } from './types';

/**
 * Drives a render to completion.
 *
 * The image is cut into horizontal bands and handed to a pool of workers, one
 * pass at a time, so the preview refines evenly instead of finishing the top
 * of the frame first. If workers are unavailable the same code runs on the
 * main thread, one band per task, which keeps the UI alive at the cost of
 * speed rather than failing outright.
 */
export class RenderJob {
  readonly accum: Float32Array;
  /**
   * First-hit surface colour, normal and distance, accumulated alongside the
   * radiance. They cost nothing extra to gather and they are what lets the
   * filter tell an edge from noise.
   */
  readonly accumAlbedo: Float32Array;
  readonly accumNormal: Float32Array;
  readonly accumDepth: Float32Array;
  samplesDone = 0;
  triangles = 0;
  cancelled = false;
  finished = false;
  startedAt = Date.now();

  private workers: Worker[] = [];
  private busy = new Set<Worker>();
  private queue: BandRequest[] = [];
  private inFlight = 0;
  private pass = 0;
  private fallbackBvh: Bvh | null = null;
  private resolveDone: (() => void) | null = null;

  onPass: ((job: RenderJob) => void) | null = null;

  constructor(
    private scene: TraceScene,
    readonly settings: RenderSettings,
  ) {
    const px = settings.width * settings.height;
    this.accum = new Float32Array(px * 3);
    this.accumAlbedo = new Float32Array(px * 3);
    this.accumNormal = new Float32Array(px * 3);
    this.accumDepth = new Float32Array(px);
  }

  get totalPasses(): number {
    return Math.max(1, Math.ceil(this.settings.samples / this.settings.samplesPerPass));
  }

  get progress(): number {
    return Math.min(1, this.samplesDone / Math.max(1, this.settings.samples));
  }

  /** Tonemapped pixels for whatever has accumulated so far. */
  toImageData(filter = this.settings.denoise): ImageData {
    const { width, height } = this.settings;
    const out = new Uint8ClampedArray(width * height * 4);
    const samples = Math.max(1, this.samplesDone);
    const source = filter ? this.filtered(samples) : this.accum;
    tonemapToImage(
      source, filter ? 1 : samples, width, height, out,
      this.settings.transparentBackground, null, this.settings.exposure,
    );
    return new ImageData(out, width, height);
  }

  /**
   * The accumulated image with the edge-aware filter applied.
   *
   * Filter strength falls off as samples accumulate: at eight samples the
   * noise is the thing you see and a heavy filter is a clear win, while at a
   * thousand there is little left to remove and over-filtering would only cost
   * detail. Below four passes the reach is too short to help at all.
   */
  private filtered(samples: number): Float32Array {
    const { width, height } = this.settings;
    const n = width * height;
    const inv = 1 / samples;
    const color = new Float32Array(n * 3);
    const albedo = new Float32Array(n * 3);
    const normal = new Float32Array(n * 3);
    const depth = new Float32Array(n);
    for (let i = 0; i < n * 3; i++) {
      color[i] = this.accum[i] * inv;
      albedo[i] = this.accumAlbedo[i] * inv;
      normal[i] = this.accumNormal[i] * inv;
    }
    for (let i = 0; i < n; i++) depth[i] = this.accumDepth[i] * inv;
    // Normals averaged over samples come back short; renormalize so the
    // agreement test measures direction rather than sample count.
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const l = Math.hypot(normal[o], normal[o + 1], normal[o + 2]);
      if (l > 1e-6) {
        normal[o] /= l;
        normal[o + 1] /= l;
        normal[o + 2] /= l;
      }
    }
    const passes = samples >= 512 ? 3 : samples >= 128 ? 4 : 5;
    const colorSigma = samples >= 512 ? 1.5 : samples >= 128 ? 2.5 : 4;
    return denoise({ width, height, color, albedo, normal, depth }, { passes, colorSigma });
  }

  async run(): Promise<void> {
    const started = this.spawnWorkers();
    if (!started) {
      this.fallbackBvh = buildBvh(this.scene.positions);
      this.triangles = this.scene.positions.length / 9;
    }
    this.enqueuePass();
    return new Promise<void>((resolve) => {
      this.resolveDone = resolve;
      // Workers start themselves once they report back from 'init'.
      if (!started) void this.runOnMainThread();
    });
  }

  cancel(): void {
    this.cancelled = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.queue = [];
    if (!this.finished) {
      this.finished = true;
      this.resolveDone?.();
    }
  }

  private bandHeight(): number {
    const lanes = Math.max(1, this.workers.length || 1);
    return Math.max(8, Math.ceil(this.settings.height / (lanes * 4)));
  }

  private enqueuePass(): void {
    const h = this.settings.height;
    const step = this.bandHeight();
    const samples = Math.min(
      this.settings.samplesPerPass,
      Math.max(1, this.settings.samples - this.pass * this.settings.samplesPerPass),
    );
    for (let y = 0; y < h; y += step) {
      this.queue.push({ y0: y, y1: Math.min(h, y + step), pass: this.pass, samples, seed: this.pass * 9781 + 17 });
    }
    this.pass++;
  }

  private spawnWorkers(): boolean {
    if (typeof Worker === 'undefined') return false;
    const want = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    try {
      for (let i = 0; i < want; i++) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent): void => this.onWorkerMessage(w, e);
        w.onerror = (): void => {
          // One worker failing is not fatal; the rest of the pool carries on.
          w.terminate();
          this.busy.delete(w);
          this.workers = this.workers.filter((x) => x !== w);
        };
        w.postMessage({ type: 'init', scene: this.scene, settings: this.settings });
        this.workers.push(w);
      }
    } catch {
      for (const w of this.workers) w.terminate();
      this.workers = [];
      return false;
    }
    return this.workers.length > 0;
  }

  private onWorkerMessage(w: Worker, e: MessageEvent): void {
    const msg = e.data as { type: 'ready'; triangles: number } | { type: 'band'; result: BandResult };
    if (msg.type === 'ready') {
      this.triangles = msg.triangles;
      this.dispatch(w);
      return;
    }
    this.inFlight--;
    this.busy.delete(w);
    this.absorb(msg.result);
    this.dispatch(w);
  }

  private dispatch(w: Worker): void {
    if (this.cancelled || this.busy.has(w)) return;
    const req = this.queue.shift();
    if (!req) {
      if (this.inFlight === 0) this.completePass();
      return;
    }
    this.inFlight++;
    this.busy.add(w);
    w.postMessage({ type: 'band', req });
  }

  private pump(): void {
    for (const w of this.workers) this.dispatch(w);
  }

  private absorb(result: BandResult): void {
    const { width } = this.settings;
    const base = result.y0 * width * 3;
    for (let i = 0; i < result.data.length; i++) {
      this.accum[base + i] += result.data[i];
      this.accumAlbedo[base + i] += result.albedo[i];
      this.accumNormal[base + i] += result.normal[i];
    }
    const dbase = result.y0 * width;
    for (let i = 0; i < result.depth.length; i++) this.accumDepth[dbase + i] += result.depth[i];
  }

  private completePass(): void {
    if (this.cancelled) return;
    const samples = Math.min(
      this.settings.samplesPerPass,
      Math.max(0, this.settings.samples - this.samplesDone),
    );
    this.samplesDone += samples;
    this.onPass?.(this);
    if (this.samplesDone >= this.settings.samples) {
      this.finished = true;
      for (const w of this.workers) w.terminate();
      this.workers = [];
      this.resolveDone?.();
      return;
    }
    this.enqueuePass();
    if (this.workers.length) this.pump();
  }

  /** No-worker path: one band per macrotask so the page keeps repainting. */
  private async runOnMainThread(): Promise<void> {
    while (!this.cancelled && this.samplesDone < this.settings.samples) {
      const req = this.queue.shift();
      if (!req) {
        this.completePass();
        continue;
      }
      const result = renderBand(this.scene, this.fallbackBvh!, this.settings, req);
      this.absorb(result);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!this.finished) {
      this.finished = true;
      this.resolveDone?.();
    }
  }
}
