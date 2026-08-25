import { BuildPart, BuildPlan, BuildShape, COLOR_NAMES, resolveColor } from './plan';
import { RECIPE_KEYS, RecipeOptions, runRecipe } from './recipes';

/**
 * "Build me a table" without a model.
 *
 * A small, deliberate grammar rather than a guess: a recognised noun runs a
 * procedural recipe, and anything shaped like "five red cubes in a circle"
 * falls through to a generic arrangement builder. It costs nothing, runs
 * offline, and always answers in under a millisecond — which is why it is the
 * default and the fallback rather than a consolation prize.
 */

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, hundred: 100,
};

const SHAPE_WORDS: Record<string, BuildShape> = {
  cube: 'cube', cubes: 'cube', box: 'cube', boxes: 'cube', block: 'cube', blocks: 'cube',
  sphere: 'sphere', spheres: 'sphere', ball: 'sphere', balls: 'sphere', orb: 'sphere',
  cylinder: 'cylinder', cylinders: 'cylinder', tube: 'cylinder', tubes: 'cylinder',
  pillar: 'cylinder', pillars: 'cylinder', column: 'cylinder', columns: 'cylinder',
  cone: 'cone', cones: 'cone',
  torus: 'torus', toruses: 'torus', tori: 'torus', donut: 'torus', donuts: 'torus',
  ring: 'torus', rings: 'torus',
  plane: 'plane', planes: 'plane', floor: 'plane', ground: 'plane',
  circle: 'circle', circles: 'circle', disc: 'circle',
  icosphere: 'icosphere', grid: 'grid',
};

type Arrangement = 'row' | 'circle' | 'stack' | 'grid' | 'scatter';

const ARRANGEMENTS: { words: string[]; kind: Arrangement }[] = [
  { words: ['in a row', 'in a line', 'row of', 'line of', 'side by side'], kind: 'row' },
  { words: ['in a circle', 'in a ring', 'circle of', 'ring of', 'around'], kind: 'circle' },
  { words: ['stack', 'stacked', 'on top of each other', 'tower of', 'pile'], kind: 'stack' },
  { words: ['grid', 'in a grid'], kind: 'grid' },
  { words: ['scatter', 'scattered', 'randomly', 'at random'], kind: 'scatter' },
];

export interface InterpretResult {
  plan: BuildPlan | null;
  /** Why nothing matched, when plan is null. */
  reason?: string;
}

function findCount(text: string): number | undefined {
  const digits = text.match(/\b(\d{1,3})\b/);
  if (digits) {
    const n = parseInt(digits[1], 10);
    if (n >= 1 && n <= 200) return n;
  }
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (word === 'a' || word === 'an') continue;
    if (new RegExp(`\\b${word}\\b`).test(text)) return value;
  }
  return undefined;
}

function findColor(text: string): string | undefined {
  const hex = text.match(/#[0-9a-f]{3,6}\b/);
  if (hex) return resolveColor(hex[0]) ?? undefined;
  // Longest names first so "dark green" does not match on "red" inside it.
  for (const name of Object.keys(COLOR_NAMES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return COLOR_NAMES[name];
  }
  return undefined;
}

function findScale(text: string): { scale: number; stretch: number } {
  let scale = 1;
  let stretch = 1;
  if (/\b(tiny|mini|miniature|little)\b/.test(text)) scale *= 0.45;
  else if (/\b(small|short)\b/.test(text)) scale *= 0.7;
  if (/\b(big|large)\b/.test(text)) scale *= 1.7;
  if (/\b(huge|giant|massive|enormous)\b/.test(text)) scale *= 2.6;
  if (/\btall\b/.test(text)) stretch *= 1.8;
  if (/\b(flat|squat|low)\b/.test(text)) stretch *= 0.5;
  return { scale, stretch };
}

function findArrangement(text: string): { kind: Arrangement; phrase: string } | undefined {
  // Longest phrase first, so "in a circle" is matched before a bare "circle".
  const all = ARRANGEMENTS.flatMap((e) => e.words.map((phrase) => ({ kind: e.kind, phrase })))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  for (const entry of all) if (text.includes(entry.phrase)) return entry;
  return undefined;
}

function findShape(text: string): { shape: BuildShape; word: string } | undefined {
  for (const word of Object.keys(SHAPE_WORDS).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return { shape: SHAPE_WORDS[word], word };
  }
  return undefined;
}

/** Lay `count` copies of one shape out in the requested pattern. */
function arrange(
  shape: BuildShape, count: number, arrangement: Arrangement,
  scale: number, stretch: number, color?: string,
): BuildPart[] {
  const s = 1 * scale;
  const h = s * stretch;
  const parts: BuildPart[] = [];
  const size: [number, number, number] = [s, s, h];

  const push = (x: number, y: number, z: number): void => {
    parts.push({ shape, name: shape, position: [x, y, z], size: [...size], color, smooth: shape !== 'cube' });
  };

  switch (arrangement) {
    case 'stack':
      for (let i = 0; i < count; i++) push(0, 0, h / 2 + i * h * 1.02);
      break;
    case 'circle': {
      const radius = Math.max(s, (count * s * 1.3) / (2 * Math.PI));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        push(Math.cos(a) * radius, Math.sin(a) * radius, h / 2);
      }
      break;
    }
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(count));
      for (let i = 0; i < count; i++) {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const rows = Math.ceil(count / cols);
        push((cx - (cols - 1) / 2) * s * 1.4, (cy - (rows - 1) / 2) * s * 1.4, h / 2);
      }
      break;
    }
    case 'scatter': {
      // Deterministic pseudo-random, so the same prompt gives the same scene.
      let seed = count * 9781 + shape.length * 137;
      const rand = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const spread = Math.max(2, count * 0.6) * s;
      for (let i = 0; i < count; i++) {
        push((rand() - 0.5) * spread, (rand() - 0.5) * spread, h / 2);
      }
      break;
    }
    default:
      for (let i = 0; i < count; i++) push((i - (count - 1) / 2) * s * 1.4, 0, h / 2);
  }
  return parts;
}

/** Turn a prompt into a plan, or explain why it could not. */
export function interpret(prompt: string): InterpretResult {
  const text = ` ${prompt.toLowerCase().replace(/[^\w#\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  if (!text.trim()) return { plan: null, reason: 'Nothing to build — type what you want.' };

  const color = findColor(text);
  const count = findCount(text);
  const { scale, stretch } = findScale(text);
  const options: RecipeOptions = { scale, stretch, color, count, words: text };

  // A recognised noun wins: "five tall towers" is five towers, not five cubes.
  for (const recipe of RECIPE_KEYS) {
    if (!new RegExp(`\\b${recipe.key.replace(/ /g, '\\s+')}s?\\b`).test(text)) continue;
    const repeats = countRepeats(text, count, recipe.key);
    const parts: BuildPart[] = [];
    for (let i = 0; i < repeats; i++) {
      const offset = repeats === 1 ? 0 : (i - (repeats - 1) / 2) * 3.2 * scale;
      for (const p of runRecipe(recipe.build, options)) {
        parts.push({ ...p, position: [p.position[0] + offset, p.position[1], p.position[2]] });
      }
    }
    return {
      plan: {
        name: repeats > 1 ? `${repeats} ${recipe.label}s` : recipe.label,
        parts,
        source: 'built-in recipe',
      },
    };
  }

  // Otherwise: a shape, a count and an arrangement. The arrangement phrase is
  // removed first — "12 cubes in a circle" is twelve cubes, not twelve circles.
  const arrangement = findArrangement(text);
  const shapeText = arrangement ? text.split(arrangement.phrase).join(' ') : text;
  const shape = findShape(shapeText) ?? findShape(text);
  if (shape) {
    const n = Math.max(1, Math.min(200, count ?? 1));
    return {
      plan: {
        name: n > 1 ? `${n} ${shape.word}` : shape.word,
        parts: arrange(shape.shape, n, arrangement?.kind ?? 'row', scale, stretch, color),
        source: 'built-in shapes',
      },
    };
  }

  return {
    plan: null,
    reason: 'No built-in recipe matched. Connect a local model, or try a shape ("12 cubes in a circle") or one of the known objects.',
  };
}

/** How many copies of a recipe the prompt asked for, ignoring counts that belong to the recipe itself. */
function countRepeats(text: string, count: number | undefined, key: string): number {
  if (!count || count < 2) return 1;
  // "a tower of 12 boxes" or "stairs with 20 steps" describe the recipe's own
  // detail, not how many towers to build.
  if (new RegExp(`\\b${key}s?\\s+(of|with)\\b`).test(text)) return 1;
  if (/\b(floors?|steps?|shelves|shelf|rows?|bricks?|tiers?|storeys?|stories)\b/.test(text)) return 1;
  // "5 tables" reads as five tables; cap it so nobody accidentally makes 200.
  if (new RegExp(`\\b${count}\\s+(\\w+\\s+){0,2}${key}s\\b`).test(text)) return Math.min(count, 12);
  if (new RegExp(`\\b${key}s\\b`).test(text)) return Math.min(count, 12);
  return 1;
}

/** Everything the offline interpreter knows how to make, for the UI. */
export function knownSubjects(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of RECIPE_KEYS) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    out.push(r.label);
  }
  return out.sort();
}
