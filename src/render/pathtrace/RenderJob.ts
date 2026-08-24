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
    this.accum = new Float32Array(settings.width * settings.height * 3);
  }

  get totalPasses(): number {
    return Math.max(1, Math.ceil(this.settings.samples / this.settings.samplesPerPass));
  }

  get progress(): number {
    return Math.min(1, this.samplesDone / Math.max(1, this.settings.samples));
  }

  /** Tonemapped pixels for whatever has accumulated so far. */
  toImageData(): ImageData {
    const { width, height } = this.settings;
    const out = new Uint8ClampedArray(width * height * 4);
    tonemapToImage(
      this.accum, Math.max(1, this.samplesDone), width, height, out,
      this.settings.transparentBackground, null, this.settings.exposure,
    );
    return new ImageData(out, width, height);
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
    for (let i = 0; i < result.data.length; i++) this.accum[base + i] += result.data[i];
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
