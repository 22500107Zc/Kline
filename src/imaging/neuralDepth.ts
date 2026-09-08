/**
 * Real depth, for photographs a silhouette cannot describe.
 *
 * The rest of this folder works from an outline: find the subject, inflate it,
 * add relief from the shading. That is exact for a shoe on a plain floor and
 * useless for a room, a street, a person standing in front of anything — the
 * pictures people actually have. Those need to be *understood*, not measured,
 * and the only thing that understands them is a network trained on a few
 * million photographs.
 *
 * So one is bundled: Depth Anything V2 Small, quantised to eight bits, 26MB,
 * Apache-2.0. It runs here, on the machine, through ONNX Runtime's WebAssembly
 * backend, with its own runtime served from the application rather than a CDN.
 * Nothing is uploaded and nothing is fetched at run time — the promise that
 * your photographs stay yours survives intact, which is the only reason this
 * was acceptable at all.
 *
 * It is loaded the first time somebody asks for it and never otherwise, so a
 * session that does not use it pays nothing.
 *
 * What comes back is *inverse* depth, and relative: bigger means nearer, and
 * the numbers have no unit. That is enough to build a scene from — it is not
 * enough to measure one, and nothing here pretends otherwise.
 */

import { Bitmap } from './contour';

/** Depth as the network sees it: bigger is nearer, no unit. */
export interface NeuralDepth {
  width: number;
  height: number;
  /** Inverse depth, normalised to 0..1 across this frame. 1 is the nearest. */
  data: Float32Array;
  /** How long the network took, for the panel to report. */
  ms: number;
}

export interface NeuralDepthOptions {
  /**
   * Square side the picture is resized to for the network, in pixels.
   *
   * Must be a multiple of 14 — the model is a vision transformer and that is
   * its patch size. Bigger is sharper and slower, roughly with the square:
   * 252 takes about a second, 392 under three, 518 about seven, on one
   * WebAssembly thread.
   */
  size?: number;
  /** Called with 0..1 while the model file is being read. */
  onProgress?: (fraction: number) => void;
}

/** Where the model and the runtime live, relative to the page. */
const MODEL_URL = 'models/depth-anything-v2-small-int8.onnx';
const RUNTIME_DIR = 'ort/';

/** ImageNet normalisation, which is what the model was trained against. */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** The transformer's patch size; every input side has to be a multiple. */
const PATCH = 14;

type Session = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  inputNames: readonly string[];
  outputNames: readonly string[];
};

let loading: Promise<Session> | null = null;
let failure: string | null = null;

/** Whether the model has already been loaded, so the UI can say "ready". */
export function depthModelReady(): boolean {
  return loading !== null && failure === null;
}

/** Why the model could not be loaded, if it could not. */
export function depthModelFailure(): string | null {
  return failure;
}

/**
 * Resolve a bundled asset against wherever the application is being served
 * from. The desktop build runs from a custom scheme and the web build can sit
 * in a subdirectory, so neither an absolute path nor a bare relative one is
 * right on its own.
 */
function assetUrl(path: string): string {
  if (typeof document === 'undefined') return path;
  return new URL(path, document.baseURI).toString();
}

/**
 * Load the runtime and the model, once.
 *
 * The import is dynamic so that neither the runtime's JavaScript nor the model
 * is fetched by anybody who never asks for this. That is most people most of
 * the time, and it is 40MB.
 */
async function session(onProgress?: (f: number) => void): Promise<Session> {
  if (loading) return loading;
  loading = (async () => {
    const ort = await import('onnxruntime-web/wasm');
    // Served by us, never from a CDN: an application that quietly reaches out
    // to a third party the first time you use a feature is not an application
    // that runs on your machine, whatever its README says.
    ort.env.wasm.wasmPaths = assetUrl(RUNTIME_DIR);
    // Threads need cross-origin isolation, which a plain static host does not
    // have. Asking for them anyway fails at load rather than falling back, so
    // this asks for what is always available and takes the slower path.
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';

    const response = await fetch(assetUrl(MODEL_URL));
    if (!response.ok) throw new Error(`the depth model could not be read (${response.status})`);
    const total = Number(response.headers.get('content-length') ?? 0);
    let bytes: Uint8Array;
    if (onProgress && total > 0 && response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let read = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        read += value.length;
        onProgress(Math.min(1, read / total));
      }
      bytes = new Uint8Array(read);
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.length; }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    onProgress?.(1);
    return await ort.InferenceSession.create(bytes) as unknown as Session;
  })();
  try {
    return await loading;
  } catch (err) {
    failure = (err as Error).message;
    loading = null;
    throw err;
  }
}

/** Round a size to the patch grid the model needs, within sane bounds. */
export function patchAligned(size: number): number {
  const clamped = Math.max(PATCH * 8, Math.min(PATCH * 46, Math.round(size)));
  return Math.round(clamped / PATCH) * PATCH;
}

/**
 * Sample the bitmap into the network's square input, normalised per channel.
 *
 * Squashed to a square rather than letterboxed: the model was trained on
 * squashed images, and padding puts a hard edge through the middle of the
 * picture that it reads as a real one.
 */
function inputTensor(bitmap: Bitmap, size: number): Float32Array {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(bitmap.height - 1, Math.floor((y + 0.5) * bitmap.height / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(bitmap.width - 1, Math.floor((x + 0.5) * bitmap.width / size));
      const s = (sy * bitmap.width + sx) * 4;
      const i = y * size + x;
      out[i] = (bitmap.data[s] / 255 - MEAN[0]) / STD[0];
      out[plane + i] = (bitmap.data[s + 1] / 255 - MEAN[1]) / STD[1];
      out[2 * plane + i] = (bitmap.data[s + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}

/**
 * Estimate depth for a photograph.
 *
 * Throws when the model cannot be loaded or run — the caller is expected to
 * fall back to the silhouette pipeline and say what happened, rather than
 * presenting a failure as a result.
 */
export async function estimateDepth(
  bitmap: Bitmap, options: NeuralDepthOptions = {},
): Promise<NeuralDepth> {
  if (bitmap.width === 0 || bitmap.height === 0) {
    throw new Error('there is no picture to read depth from');
  }
  const size = patchAligned(options.size ?? 392);
  const ort = await import('onnxruntime-web/wasm');
  const model = await session(options.onProgress);

  const started = Date.now();
  const input = new ort.Tensor('float32', inputTensor(bitmap, size), [1, 3, size, size]);
  const output = await model.run({ [model.inputNames[0]]: input as unknown as never });
  const depth = output[model.outputNames[0]];
  if (!depth) throw new Error('the depth model returned nothing');

  // [1, h, w] or [1, 1, h, w] depending on how the model was exported.
  const dims = depth.dims;
  const h = dims.length >= 3 ? Number(dims[dims.length - 2]) : size;
  const w = dims.length >= 3 ? Number(dims[dims.length - 1]) : size;
  const raw = depth.data;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // A frame the model reads as one flat distance — a wall, a blank sky — has
  // no range to normalise against. Zero is the honest answer.
  const span = hi - lo;
  const data = new Float32Array(w * h);
  if (Number.isFinite(lo) && span > 1e-6) {
    for (let i = 0; i < data.length; i++) {
      const v = raw[i];
      data[i] = Number.isFinite(v) ? (v - lo) / span : 0;
    }
  }
  return { width: w, height: h, data, ms: Date.now() - started };
}
