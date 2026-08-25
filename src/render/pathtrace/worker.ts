import { Bvh, buildBvh, renderBand } from './tracer';
import { BandRequest, RenderSettings, TraceScene } from './types';

/**
 * Worker wrapper around the tracer. The BVH is built once per job and kept
 * here, so each band request only carries the rows to shade.
 */

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(data: unknown, transfer?: Transferable[]): void;
}

const ctx = self as unknown as WorkerScope;

let scene: TraceScene | null = null;
let settings: RenderSettings | null = null;
let bvh: Bvh | null = null;

ctx.onmessage = (e: MessageEvent): void => {
  const msg = e.data as
    | { type: 'init'; scene: TraceScene; settings: RenderSettings }
    | { type: 'band'; req: BandRequest };

  if (msg.type === 'init') {
    scene = msg.scene;
    settings = msg.settings;
    bvh = buildBvh(scene.positions);
    ctx.postMessage({ type: 'ready', triangles: scene.positions.length / 9 });
    return;
  }
  if (msg.type === 'band' && scene && settings && bvh) {
    const result = renderBand(scene, bvh, settings, msg.req);
    ctx.postMessage({ type: 'band', result }, [
      result.data.buffer, result.albedo.buffer, result.normal.buffer, result.depth.buffer,
    ]);
  }
};
