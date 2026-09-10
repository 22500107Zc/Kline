import { BuildPart, validatePlan } from './plan';

/**
 * Running generated code safely.
 *
 * "Build anything" cannot come from a fixed set of recipes — it comes from a
 * model writing a short program against a geometry API, which is how you get a
 * spiral staircase or a 37-tooth gear without anyone having anticipated them.
 * That program is untrusted, so it runs inside a Worker with the dangerous
 * globals removed and a hard time limit, and it can only produce data: a list
 * of primitives that goes through the same validator as everything else.
 */

export interface RunLimits {
  maxParts: number;
  maxMs: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxParts: 4000, maxMs: 3000 };

export interface RunResult {
  parts: BuildPart[];
  /** Anything the program passed to log(). */
  log: string[];
  ms: number;
}

/**
 * The sandbox harness, as source, because it has to be injected into a Worker
 * and also executed directly in tests. Defining it once as a string keeps those
 * two paths honestly identical.
 */
export const HARNESS_SOURCE = `
function buildParts(code, maxParts) {
  var parts = [];
  var log = [];
  var seed = 1234567;

  function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }

  function num(v, fallback) {
    v = Number(v);
    return isFinite(v) ? v : fallback;
  }

  function push(shape, x, y, z, w, d, h, color, rot, name, id) {
    if (parts.length >= maxParts) {
      throw new Error('This program tried to make more than ' + maxParts + ' parts.');
    }
    parts.push({
      shape: shape,
      name: name || undefined,
      id: typeof id === 'string' && id ? id : undefined,
      position: [num(x, 0), num(y, 0), num(z, 0)],
      size: [Math.abs(num(w, 1)) || 0.001, Math.abs(num(d, 1)) || 0.001, Math.abs(num(h, 1)) || 0.001],
      rotation: rot ? [num(rot[0], 0), num(rot[1], 0), num(rot[2], 0)] : undefined,
      color: typeof color === 'string' ? color : undefined
    });
  }

  var api = {
    box: function (x, y, z, w, d, h, c) { push('cube', x, y, z, w, d, h, c); },
    cube: function (x, y, z, w, d, h, c) { push('cube', x, y, z, w, d, h, c); },
    cyl: function (x, y, z, w, d, h, c) { push('cylinder', x, y, z, w, d, h, c); },
    cylinder: function (x, y, z, w, d, h, c) { push('cylinder', x, y, z, w, d, h, c); },
    sphere: function (x, y, z, w, d, h, c) { push('sphere', x, y, z, w, d, h, c); },
    ball: function (x, y, z, diameter, c) { push('sphere', x, y, z, diameter, diameter, diameter, c); },
    cone: function (x, y, z, w, d, h, c) { push('cone', x, y, z, w, d, h, c); },
    torus: function (x, y, z, w, d, h, c) { push('torus', x, y, z, w, d, h, c); },
    plane: function (x, y, z, w, d, c) { push('plane', x, y, z, w, d, 0.001, c); },
    part: function (spec) {
      spec = spec || {};
      var at = spec.at || spec.position || [0, 0, 0];
      var size = spec.size || [1, 1, 1];
      push(spec.shape || 'cube', at[0], at[1], at[2], size[0], size[1], size[2],
        spec.color, spec.rot || spec.rotation, spec.name, spec.id);
    },
    log: function () {
      if (log.length < 40) log.push(Array.prototype.join.call(arguments, ' '));
    },
    random: rnd,
    PI: Math.PI, TAU: Math.PI * 2,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2,
    abs: Math.abs, min: Math.min, max: Math.max, round: Math.round,
    floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, pow: Math.pow,
    hypot: Math.hypot, sign: Math.sign, Math: Math
  };

  var names = Object.keys(api);
  var values = names.map(function (n) { return api[n]; });
  // Shadow the escape hatches as parameters, so a stray fetch in generated code
  // is a TypeError rather than a request. "eval" and "Function" are absent on
  // purpose: they are illegal as strict-mode parameter names, and the harness
  // needs Function itself. They are handled below instead.
  var blocked = ['self', 'globalThis', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
    'postMessage', 'Worker', 'SharedWorker', 'indexedDB', 'caches', 'localStorage',
    'sessionStorage', 'require', 'process', 'window', 'document', 'navigator'];
  var args = names.concat(blocked);
  var vals = values.concat(blocked.map(function () { return undefined; }));

  var body = '"use strict";\\n' + code + '\\n';
  // Compile first, because this needs the real Function constructor.
  var fn = new Function(args.join(','), body);

  // Then empty those globals for real. Parameter shadowing on its own is
  // defeated by Function('return this')(); this is not, because the properties
  // are genuinely gone before the program runs. Only ever applied inside a
  // Worker — never to a page or Node global.
  var inWorker = typeof importScripts !== 'undefined' && typeof self !== 'undefined';
  if (inWorker) {
    for (var bi = 0; bi < blocked.length; bi++) {
      try { self[blocked[bi]] = undefined; } catch (e) { /* frozen; shadowing still applies */ }
    }
  }

  fn.apply(null, vals);
  return { parts: parts, log: log };
}
`;

/** The API description handed to the model, kept next to the implementation. */
export const API_REFERENCE = `Available functions (all coordinates in metres, Z up, ground at z = 0,
and x/y/z is always the CENTRE of the part):

  box(x, y, z, width, depth, height, color)
  cyl(x, y, z, width, depth, height, color)      // a cylinder, height along Z
  sphere(x, y, z, width, depth, height, color)
  ball(x, y, z, diameter, color)
  cone(x, y, z, width, depth, height, color)     // point upward
  torus(x, y, z, width, depth, height, color)
  plane(x, y, z, width, depth, color)
  part({shape, at:[x,y,z], size:[w,d,h], rot:[rx,ry,rz], color, name, id})   // rot in degrees
  log(...)                                        // shows in the panel

Also in scope: PI, TAU, sin, cos, tan, atan2, abs, min, max, round, floor,
ceil, sqrt, pow, hypot, sign, Math, random() (seeded, so results repeat).

Colors are hex strings like '#8b5e34'.

Give every part a stable "id" when you can — a short name like 'top' or
'leg-3'. It is how an edited version of this program is matched up with the
model already in the scene, so somebody's material and placement survive a
revision. Ids must be unique within one program. If you are editing an
existing program, keep the ids exactly as they are.`;

interface HarnessResult {
  parts: unknown[];
  log: string[];
}

type Harness = (code: string, maxParts: number) => HarnessResult;

let cachedHarness: Harness | null = null;

/** Compile the harness once for direct (non-Worker) execution. */
function harness(): Harness {
  if (!cachedHarness) {
    cachedHarness = new Function(`${HARNESS_SOURCE}; return buildParts;`)() as Harness;
  }
  return cachedHarness;
}

/**
 * Run a program on this thread. Used by the tests and as the fallback when a
 * Worker cannot be created; it cannot enforce the time limit, so the Worker
 * path is preferred wherever it is available.
 */
export function runProgramHere(code: string, limits: RunLimits = DEFAULT_LIMITS): RunResult {
  const started = Date.now();
  const raw = harness()(code, limits.maxParts);
  const { plan, warnings } = validatePlan({ name: 'Build', parts: raw.parts });
  if (!plan) throw new Error(`The program produced no usable parts. ${warnings.join(' ')}`.trim());
  return { parts: plan.parts, log: raw.log, ms: Date.now() - started };
}

function workerSource(): string {
  return `${HARNESS_SOURCE}
// Captured before the harness empties the globals, which includes this one.
var reply = self.postMessage.bind(self);
self.onmessage = function (e) {
  try {
    var out = buildParts(e.data.code, e.data.maxParts);
    reply({ ok: true, parts: out.parts, log: out.log });
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err) });
  }
};`;
}

/**
 * Run a program in a Worker, terminating it if it overruns. An infinite loop in
 * generated code is a when-not-if, and this is the only way to survive one.
 */
export function runProgramSandboxed(
  code: string, limits: RunLimits = DEFAULT_LIMITS,
): Promise<RunResult> {
  if (typeof Worker === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return Promise.resolve(runProgramHere(code, limits));
  }
  const started = Date.now();
  const blob = new Blob([workerSource()], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);

  return new Promise<RunResult>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The program was still running after ${limits.maxMs}ms and was stopped. Check for a loop that never ends.`));
    }, limits.maxMs);

    worker.onmessage = (event: MessageEvent) => {
      cleanup();
      const data = event.data as { ok: boolean; parts?: unknown[]; log?: string[]; error?: string };
      if (!data.ok) {
        reject(new Error(data.error ?? 'The program failed.'));
        return;
      }
      const { plan, warnings } = validatePlan({ name: 'Build', parts: data.parts ?? [] });
      if (!plan) {
        reject(new Error(`The program produced no usable parts. ${warnings.join(' ')}`.trim()));
        return;
      }
      resolve({ parts: plan.parts, log: data.log ?? [], ms: Date.now() - started });
    };
    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || 'The program could not be started.'));
    };
    worker.postMessage({ code, maxParts: limits.maxParts });
  });
}
