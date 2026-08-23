import { BuildPart, BuildShape } from './plan';

/**
 * Procedural recipes for things people actually ask for.
 *
 * These are what make "build me a table" work with no model, no network and no
 * account — the offline interpreter matches a noun and calls one of these. Each
 * takes a size multiplier and an optional colour and returns parts sitting on
 * the ground, centred on the origin.
 */

export interface RecipeOptions {
  /** Overall scale multiplier from words like "big" or "tiny". */
  scale: number;
  /** Extra height multiplier from "tall". */
  stretch: number;
  /** Primary colour, if the prompt named one. */
  color?: string;
  /** How many, for recipes that repeat (steps, floors, boxes). */
  count?: number;
}

type Recipe = (o: RecipeOptions) => BuildPart[];

function part(
  shape: BuildShape,
  name: string,
  position: [number, number, number],
  size: [number, number, number],
  color?: string,
  extra: Partial<BuildPart> = {},
): BuildPart {
  return { shape, name, position, size, color, ...extra };
}

const scaled = (parts: BuildPart[], s: number, stretch: number): BuildPart[] =>
  parts.map((p) => ({
    ...p,
    position: [p.position[0] * s, p.position[1] * s, p.position[2] * s * stretch],
    size: [p.size[0] * s, p.size[1] * s, p.size[2] * s * stretch],
  }));

const WOOD = '#8b5e34';
const DARK = '#4a4a4e';
const CLOTH = '#6d7f96';

function table(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? WOOD;
  const w = 1.6;
  const d = 0.9;
  const h = 0.75;
  const leg = 0.08;
  const inset = 0.1;
  const parts = [part('cube', 'Top', [0, 0, h - 0.03], [w, d, 0.06], c)];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      parts.push(part('cube', 'Leg', [
        sx * (w / 2 - inset - leg / 2), sy * (d / 2 - inset - leg / 2), (h - 0.06) / 2,
      ], [leg, leg, h - 0.06], c));
    }
  }
  return parts;
}

function chair(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? WOOD;
  const w = 0.45;
  const d = 0.45;
  const seat = 0.45;
  const leg = 0.05;
  const parts = [
    part('cube', 'Seat', [0, 0, seat], [w, d, 0.05], c),
    part('cube', 'Back', [0, -d / 2 + leg / 2, seat + 0.25], [w, leg, 0.5], c),
  ];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      parts.push(part('cube', 'Leg', [
        sx * (w / 2 - leg / 2), sy * (d / 2 - leg / 2), (seat - 0.025) / 2,
      ], [leg, leg, seat - 0.025], c));
    }
  }
  return parts;
}

function stool(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? WOOD;
  const parts = [part('cylinder', 'Seat', [0, 0, 0.6], [0.34, 0.34, 0.05], c, { smooth: true })];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(part('cylinder', 'Leg', [Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0.29],
      [0.04, 0.04, 0.58], c, { smooth: true }));
  }
  return parts;
}

function bench(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? WOOD;
  const parts = [part('cube', 'Seat', [0, 0, 0.45], [1.8, 0.4, 0.06], c)];
  for (const sx of [-1, 1]) {
    parts.push(part('cube', 'Leg', [sx * 0.75, 0, 0.21], [0.08, 0.36, 0.42], c));
  }
  return parts;
}

function bookshelf(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? WOOD;
  const w = 0.9;
  const d = 0.3;
  const h = 1.8;
  const shelves = Math.max(2, Math.min(8, o.count ?? 4));
  const parts = [
    part('cube', 'Side', [-w / 2, 0, h / 2], [0.04, d, h], c),
    part('cube', 'Side', [w / 2, 0, h / 2], [0.04, d, h], c),
    part('cube', 'Back', [0, d / 2, h / 2], [w, 0.02, h], c),
  ];
  for (let i = 0; i <= shelves; i++) {
    parts.push(part('cube', 'Shelf', [0, 0, (i / shelves) * (h - 0.04) + 0.02], [w, d, 0.03], c));
  }
  return parts;
}

function bed(o: RecipeOptions): BuildPart[] {
  const frame = o.color ?? WOOD;
  return [
    part('cube', 'Frame', [0, 0, 0.2], [1.4, 2, 0.3], frame),
    part('cube', 'Mattress', [0, 0, 0.42], [1.34, 1.94, 0.16], '#e8e4dc'),
    part('cube', 'Pillow', [0, -0.75, 0.55], [0.9, 0.35, 0.12], '#f2f0ec'),
    part('cube', 'Headboard', [0, -1.02, 0.6], [1.4, 0.08, 0.9], frame),
  ];
}

function sofa(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? CLOTH;
  const parts = [
    part('cube', 'Base', [0, 0, 0.22], [2, 0.9, 0.44], c),
    part('cube', 'Back', [0, 0.38, 0.62], [2, 0.16, 0.5], c),
  ];
  for (const sx of [-1, 1]) {
    parts.push(part('cube', 'Arm', [sx * 0.92, 0, 0.56], [0.16, 0.9, 0.24], c));
  }
  for (const sx of [-1, 1]) {
    parts.push(part('cube', 'Cushion', [sx * 0.42, -0.05, 0.5], [0.78, 0.72, 0.14], c));
  }
  return parts;
}

function lamp(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? DARK;
  return [
    part('cylinder', 'Base', [0, 0, 0.03], [0.3, 0.3, 0.06], c, { smooth: true }),
    part('cylinder', 'Stem', [0, 0, 0.7], [0.04, 0.04, 1.3], c, { smooth: true }),
    part('cone', 'Shade', [0, 0, 1.5], [0.5, 0.5, 0.36], '#e3c341', { smooth: true, rotation: [180, 0, 0] }),
  ];
}

function tower(o: RecipeOptions): BuildPart[] {
  const c = o.color;
  const floors = Math.max(2, Math.min(40, o.count ?? 6));
  const parts: BuildPart[] = [];
  for (let i = 0; i < floors; i++) {
    const t = i / floors;
    const w = 1.2 * (1 - t * 0.45);
    parts.push(part('cube', `Floor ${i + 1}`, [0, 0, 0.3 + i * 0.62], [w, w, 0.6], c));
  }
  return parts;
}

function stairs(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#9aa0a6';
  const steps = Math.max(2, Math.min(40, o.count ?? 8));
  const rise = 0.18;
  const run = 0.28;
  const parts: BuildPart[] = [];
  for (let i = 0; i < steps; i++) {
    const h = rise * (i + 1);
    parts.push(part('cube', `Step ${i + 1}`, [0, i * run, h / 2], [1.2, run, h], c));
  }
  return parts;
}

function wall(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#a5674f';
  const rows = Math.max(2, Math.min(20, o.count ?? 6));
  const cols = 6;
  const bw = 0.4;
  const bh = 0.18;
  const parts: BuildPart[] = [];
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 ? bw / 2 : 0;
    for (let i = 0; i < cols; i++) {
      const x = (i - (cols - 1) / 2) * bw + offset;
      parts.push(part('cube', 'Brick', [x, 0, bh / 2 + r * bh], [bw * 0.94, 0.2, bh * 0.9], c));
    }
  }
  return parts;
}

function fence(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? WOOD;
  const posts = Math.max(2, Math.min(30, o.count ?? 6));
  const gap = 0.9;
  const span = (posts - 1) * gap;
  const parts: BuildPart[] = [];
  for (let i = 0; i < posts; i++) {
    parts.push(part('cube', 'Post', [i * gap - span / 2, 0, 0.6], [0.08, 0.08, 1.2], c));
  }
  for (const z of [0.4, 0.9]) {
    parts.push(part('cube', 'Rail', [0, 0, z], [span + 0.08, 0.04, 0.1], c));
  }
  return parts;
}

function house(o: RecipeOptions): BuildPart[] {
  const body = o.color ?? '#d8c8a8';
  return [
    part('cube', 'Walls', [0, 0, 1.2], [4, 3, 2.4], body),
    part('cone', 'Roof', [0, 0, 3.1], [4.6, 3.6, 1.4], '#8c3b2e', { rotation: [0, 0, 45] }),
    part('cube', 'Door', [0, -1.51, 0.55], [0.8, 0.06, 1.1], '#6b4423'),
    part('cube', 'Window', [-1.2, -1.51, 1.6], [0.7, 0.06, 0.7], '#9fc4d6'),
    part('cube', 'Window', [1.2, -1.51, 1.6], [0.7, 0.06, 0.7], '#9fc4d6'),
    part('cube', 'Chimney', [1.3, 0.6, 3.5], [0.4, 0.4, 1.2], '#7a5230'),
  ];
}

function tree(o: RecipeOptions): BuildPart[] {
  const leaf = o.color ?? '#4f8f3f';
  return [
    part('cylinder', 'Trunk', [0, 0, 0.9], [0.28, 0.28, 1.8], '#6b4423', { smooth: true }),
    part('sphere', 'Canopy', [0, 0, 2.3], [1.9, 1.9, 1.7], leaf, { smooth: true }),
    part('sphere', 'Canopy', [-0.6, 0.35, 1.9], [1.2, 1.2, 1.1], leaf, { smooth: true }),
    part('sphere', 'Canopy', [0.65, -0.3, 2.05], [1.1, 1.1, 1], leaf, { smooth: true }),
  ];
}

function snowman(o: RecipeOptions): BuildPart[] {
  const snow = o.color ?? '#f2f2f2';
  return [
    part('sphere', 'Base', [0, 0, 0.55], [1.1, 1.1, 1.1], snow, { smooth: true }),
    part('sphere', 'Torso', [0, 0, 1.4], [0.8, 0.8, 0.8], snow, { smooth: true }),
    part('sphere', 'Head', [0, 0, 2.05], [0.56, 0.56, 0.56], snow, { smooth: true }),
    part('cylinder', 'Hat brim', [0, 0, 2.32], [0.6, 0.6, 0.04], '#1a1a1a', { smooth: true }),
    part('cylinder', 'Hat', [0, 0, 2.5], [0.36, 0.36, 0.34], '#1a1a1a', { smooth: true }),
    part('cone', 'Nose', [0, -0.3, 2.08], [0.1, 0.28, 0.1], '#e07b26', { rotation: [90, 0, 0], smooth: true }),
    part('cylinder', 'Arm', [-0.6, 0, 1.45], [0.7, 0.05, 0.05], '#6b4423', { rotation: [0, 90, 20] }),
    part('cylinder', 'Arm', [0.6, 0, 1.45], [0.7, 0.05, 0.05], '#6b4423', { rotation: [0, 90, -20] }),
  ];
}

function robot(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#7f8c99';
  return [
    part('cube', 'Torso', [0, 0, 1.15], [0.8, 0.5, 1], c),
    part('cube', 'Head', [0, 0, 1.85], [0.5, 0.45, 0.4], c),
    part('sphere', 'Eye', [-0.13, -0.24, 1.9], [0.1, 0.1, 0.1], '#3fb5c4', { smooth: true }),
    part('sphere', 'Eye', [0.13, -0.24, 1.9], [0.1, 0.1, 0.1], '#3fb5c4', { smooth: true }),
    part('cylinder', 'Antenna', [0, 0, 2.2], [0.03, 0.03, 0.3], '#c0392b', { smooth: true }),
    part('cube', 'Arm', [-0.55, 0, 1.2], [0.18, 0.18, 0.9], c),
    part('cube', 'Arm', [0.55, 0, 1.2], [0.18, 0.18, 0.9], c),
    part('cube', 'Leg', [-0.22, 0, 0.33], [0.24, 0.24, 0.66], c),
    part('cube', 'Leg', [0.22, 0, 0.33], [0.24, 0.24, 0.66], c),
  ];
}

function rocket(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#f2f2f2';
  const parts = [
    part('cylinder', 'Body', [0, 0, 1.6], [0.8, 0.8, 3.2], c, { smooth: true }),
    part('cone', 'Nose', [0, 0, 3.65], [0.8, 0.8, 0.9], '#c0392b', { smooth: true }),
    part('cylinder', 'Band', [0, 0, 2.6], [0.84, 0.84, 0.2], '#c0392b', { smooth: true }),
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    parts.push(part('cone', 'Fin', [Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0.4],
      [0.25, 0.25, 0.8], '#c0392b'));
  }
  return parts;
}

function car(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#3a6fb0';
  const parts = [
    part('cube', 'Body', [0, 0, 0.55], [1.8, 4, 0.5], c),
    part('cube', 'Cabin', [0, -0.2, 1.05], [1.5, 2, 0.5], c),
    part('cube', 'Windscreen', [0, -1.21, 1.05], [1.4, 0.04, 0.4], '#9fc4d6'),
  ];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      parts.push(part('cylinder', 'Wheel', [sx * 0.92, sy * 1.3, 0.33], [0.2, 0.66, 0.66],
        '#1a1a1a', { rotation: [0, 90, 0], smooth: true }));
    }
  }
  return parts;
}

function castle(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#9aa0a6';
  const parts = [part('cube', 'Keep', [0, 0, 1.5], [4, 4, 3], c)];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      parts.push(part('cylinder', 'Tower', [sx * 2, sy * 2, 2], [1.2, 1.2, 4], c, { smooth: true }));
      parts.push(part('cone', 'Spire', [sx * 2, sy * 2, 4.6], [1.4, 1.4, 1.2], '#8c3b2e', { smooth: true }));
    }
  }
  for (let i = 0; i < 8; i++) {
    const x = -1.75 + (i / 7) * 3.5;
    parts.push(part('cube', 'Merlon', [x, -2, 3.2], [0.35, 0.35, 0.4], c));
    parts.push(part('cube', 'Merlon', [x, 2, 3.2], [0.35, 0.35, 0.4], c));
  }
  parts.push(part('cube', 'Gate', [0, -2.02, 0.9], [1.1, 0.1, 1.8], '#6b4423'));
  return parts;
}

function pyramid(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#d8c8a8';
  const steps = Math.max(2, Math.min(20, o.count ?? 6));
  const parts: BuildPart[] = [];
  for (let i = 0; i < steps; i++) {
    const w = 5 * (1 - i / steps);
    parts.push(part('cube', `Tier ${i + 1}`, [0, 0, 0.25 + i * 0.5], [w, w, 0.5], c));
  }
  return parts;
}

function arch(o: RecipeOptions): BuildPart[] {
  const c = o.color ?? '#9aa0a6';
  const parts: BuildPart[] = [
    part('cube', 'Pier', [-1.2, 0, 1], [0.5, 0.6, 2], c),
    part('cube', 'Pier', [1.2, 0, 1], [0.5, 0.6, 2], c),
  ];
  const segments = 7;
  for (let i = 0; i < segments; i++) {
    const a = Math.PI * (i / (segments - 1));
    parts.push(part('cube', 'Voussoir', [-Math.cos(a) * 1.2, 0, 2 + Math.sin(a) * 1.2],
      [0.45, 0.6, 0.4], c, { rotation: [0, (a * 180) / Math.PI - 90, 0] }));
  }
  return parts;
}

export const RECIPES: { keys: string[]; label: string; build: Recipe }[] = [
  { keys: ['table', 'desk', 'dining table'], label: 'Table', build: table },
  { keys: ['chair', 'seat'], label: 'Chair', build: chair },
  { keys: ['stool'], label: 'Stool', build: stool },
  { keys: ['bench'], label: 'Bench', build: bench },
  { keys: ['bookshelf', 'shelf', 'shelves', 'bookcase'], label: 'Bookshelf', build: bookshelf },
  { keys: ['bed'], label: 'Bed', build: bed },
  { keys: ['sofa', 'couch', 'settee'], label: 'Sofa', build: sofa },
  { keys: ['lamp', 'floor lamp'], label: 'Lamp', build: lamp },
  { keys: ['tower', 'skyscraper', 'high rise'], label: 'Tower', build: tower },
  { keys: ['stairs', 'staircase', 'steps'], label: 'Stairs', build: stairs },
  { keys: ['wall', 'brick wall'], label: 'Wall', build: wall },
  { keys: ['fence', 'railing'], label: 'Fence', build: fence },
  { keys: ['house', 'cottage', 'cabin', 'home'], label: 'House', build: house },
  { keys: ['tree', 'oak'], label: 'Tree', build: tree },
  { keys: ['snowman'], label: 'Snowman', build: snowman },
  { keys: ['robot', 'android', 'mech'], label: 'Robot', build: robot },
  { keys: ['rocket', 'spaceship', 'missile'], label: 'Rocket', build: rocket },
  { keys: ['car', 'truck', 'vehicle'], label: 'Car', build: car },
  { keys: ['castle', 'fort', 'fortress'], label: 'Castle', build: castle },
  { keys: ['pyramid', 'ziggurat'], label: 'Pyramid', build: pyramid },
  { keys: ['arch', 'archway', 'bridge'], label: 'Arch', build: arch },
];

/** Every noun the offline interpreter recognises, longest first so "dining table" wins. */
export const RECIPE_KEYS: { key: string; label: string; build: Recipe }[] = RECIPES
  .flatMap((r) => r.keys.map((key) => ({ key, label: r.label, build: r.build })))
  .sort((a, b) => b.key.length - a.key.length);

export function runRecipe(
  build: Recipe, options: RecipeOptions,
): BuildPart[] {
  return scaled(build(options), options.scale, options.stretch);
}
