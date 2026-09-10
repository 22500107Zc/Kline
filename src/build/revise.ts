import { BuildPart, BuildPlan, COLOR_NAMES, resolveColor } from './plan';
import { RECIPE_KEYS, RecipeOptions, runRecipe } from './recipes';
import { ParamValue, Provenance, assignIdentities } from './provenance';
import { ProposedPart } from './merge';
import { meshForPart } from './plan';
import { DEG2RAD } from '../core/math';

/**
 * "Make that thirty steps instead of twenty."
 *
 * The point of keeping a recipe's settings as named numbers rather than as a
 * sentence is that this sentence does not need a model at all. The staircase
 * was built with `count: 20`; the request names thirty; the recipe runs again
 * with thirty. That is instant, offline, exactly repeatable, and — unlike
 * asking anything to regenerate from the prompt — it cannot quietly change the
 * eleven things nobody asked about.
 *
 * Where an asset has no structured settings to change, that honesty has to
 * hold too: a generated program is revised by editing the program, which needs
 * either a model or the user, and this says so rather than guessing.
 */

/** What a revision request turned into. */
export interface RevisionRequest {
  /** Parameters to change, merged over the recorded ones. */
  params: Record<string, ParamValue>;
  /** Plain-language account of what will change, for the preview. */
  summary: string;
  /** True when nothing in the request could be turned into a change. */
  empty: boolean;
  /** Anything understood but not applicable, so the user is not left guessing. */
  notes: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, hundred: 100,
};

/** Every number in the text, digits or words, in the order they appear. */
function numbersIn(text: string): number[] {
  const out: { at: number; value: number }[] = [];
  for (const m of text.matchAll(/\b(\d{1,4})(?:\.\d+)?\b/g)) {
    out.push({ at: m.index ?? 0, value: Number(m[0]) });
  }
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    const m = new RegExp(`\\b${word}\\b`).exec(text);
    if (m) out.push({ at: m.index, value });
  }
  return out.sort((a, b) => a.at - b.at).map((e) => e.value);
}

/** A decimal anywhere in the text, for settings that are not whole numbers. */
function decimalIn(text: string): number | null {
  const m = /\b(\d+(?:\.\d+)?)\b/.exec(text);
  return m ? Number(m[1]) : null;
}

const MULTIPLIERS: { words: RegExp; factor: number }[] = [
  { words: /\b(much|far|way)\s+(bigger|larger|wider|taller|longer)\b/, factor: 1.8 },
  { words: /\b(bigger|larger|wider|longer|thicker|deeper)\b/, factor: 1.35 },
  { words: /\btaller\b/, factor: 1.4 },
  { words: /\b(much|far|way)\s+(smaller|thinner|shorter|narrower)\b/, factor: 0.55 },
  { words: /\b(smaller|thinner|shorter|narrower|shallower)\b/, factor: 0.75 },
  { words: /\bhalf\b/, factor: 0.5 },
  { words: /\b(double|twice)\b/, factor: 2 },
];

/**
 * Read a revision request against what the asset actually exposes.
 *
 * Only parameters the asset has are considered, so the same sentence means
 * different things to different assets and nothing invents a setting that
 * does not exist. A request that names nothing changeable comes back empty
 * rather than as a no-op that looks like it worked.
 */
export function parseRevision(prov: Provenance, request: string): RevisionRequest {
  const text = ` ${request.toLowerCase().replace(/[^\w#.\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  const params: Record<string, ParamValue> = {};
  const changes: string[] = [];
  const notes: string[] = [];
  const has = (key: string): boolean => key in prov.params;

  // ---- how many
  const countWords = /\b(steps?|stairs?|treads?|floors?|storey|storeys|stories|shelves|shelf|tiers?|rows?|posts?|segments?|sides?|parts?|copies|count)\b/;
  if (has('count') && (countWords.test(text) || /\bmake it (\d+)\b/.test(text))) {
    const numbers = numbersIn(text);
    if (numbers.length) {
      const wanted = Math.max(1, Math.min(200, Math.round(numbers[numbers.length - 1])));
      params.count = wanted;
      changes.push(`${wanted} instead of ${prov.params.count ?? 'the default'}`);
    }
  } else if (has('count') && numbersIn(text).length === 1 && /\b(to|into|now)\b/.test(text)) {
    const wanted = Math.max(1, Math.min(200, Math.round(numbersIn(text)[0])));
    params.count = wanted;
    changes.push(`${wanted} instead of ${prov.params.count ?? 'the default'}`);
  }

  // ---- size
  const scale = typeof prov.params.scale === 'number' ? prov.params.scale : 1;
  const stretch = typeof prov.params.stretch === 'number' ? prov.params.stretch : 1;
  for (const { words, factor } of MULTIPLIERS) {
    if (!words.test(text)) continue;
    const vertical = /\b(tall|taller|shorter|higher|lower|height)\b/.test(text);
    if (vertical && has('stretch')) {
      params.stretch = round(stretch * factor);
      changes.push(`${factor > 1 ? 'taller' : 'shorter'} by ${Math.round(Math.abs(1 - factor) * 100)}%`);
    } else if (has('scale')) {
      params.scale = round(scale * factor);
      changes.push(`${factor > 1 ? 'bigger' : 'smaller'} by ${Math.round(Math.abs(1 - factor) * 100)}%`);
    }
    break;
  }

  // ---- colour
  const colour = findColour(text);
  if (colour && has('color')) {
    params.color = colour;
    changes.push(`coloured ${colour}`);
  } else if (colour) {
    notes.push('This asset does not take a colour setting; change its material instead.');
  }

  // ---- a named numeric setting, for reference-derived assets
  //
  // "change the extrusion depth to 0.6" names a setting the reference pipeline
  // actually has, so it is applied by name rather than by guesswork.
  for (const [key, phrases] of Object.entries(NAMED_SETTINGS)) {
    if (!has(key)) continue;
    if (!phrases.some((phrase) => text.includes(phrase))) continue;
    const value = decimalIn(text);
    if (value === null) continue;
    params[key] = value;
    changes.push(`${key} ${value}`);
  }

  return {
    params,
    summary: changes.length ? changes.join(', ') : '',
    empty: changes.length === 0,
    notes,
  };
}

/** Words that name a setting the reference generators expose. */
const NAMED_SETTINGS: Record<string, string[]> = {
  depth: ['depth', 'thickness', 'extrusion', 'extrude'],
  targetHeight: ['height', 'tall'],
  bevel: ['bevel'],
  simplify: ['smoothing', 'simplify'],
  resolution: ['detail', 'resolution'],
  threshold: ['threshold'],
  relief: ['relief'],
  volume: ['roundness', 'volume'],
  segments: ['segments', 'sides'],
};

const round = (v: number): number => Math.round(v * 1000) / 1000;

function findColour(text: string): string | null {
  const hex = text.match(/#[0-9a-f]{3,6}\b/);
  if (hex) return resolveColor(hex[0]);
  for (const name of Object.keys(COLOR_NAMES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return COLOR_NAMES[name];
  }
  return null;
}

/**
 * Run a recipe again with revised settings.
 *
 * Deliberately the same code path the original build took, given the same
 * shape of input — a revision that ran a different generator would be a second
 * implementation of the object, and the two would drift.
 */
export function rebuildRecipe(
  prov: Provenance, params: Record<string, ParamValue>,
): { plan: BuildPlan; parts: ProposedPart[] } | null {
  const merged = { ...prov.params, ...params };
  const key = typeof merged.recipe === 'string' ? merged.recipe : null;
  if (!key) return null;
  const recipe = RECIPE_KEYS.find((r) => r.key === key);
  if (!recipe) return null;

  const options: RecipeOptions = {
    scale: numberOr(merged.scale, 1),
    stretch: numberOr(merged.stretch, 1),
    color: typeof merged.color === 'string' ? merged.color : undefined,
    count: typeof merged.count === 'number' ? merged.count : undefined,
    words: typeof merged.words === 'string' ? merged.words : undefined,
  };
  const repeats = Math.max(1, Math.min(12, numberOr(merged.repeats, 1)));
  const parts: BuildPart[] = [];
  for (let i = 0; i < repeats; i++) {
    const offset = repeats === 1 ? 0 : (i - (repeats - 1) / 2) * 3.2 * options.scale;
    for (const p of runRecipe(recipe.build, options)) {
      parts.push({ ...p, position: [p.position[0] + offset, p.position[1], p.position[2]] });
    }
  }
  const plan: BuildPlan = {
    name: repeats > 1 ? `${repeats} ${recipe.label}s` : recipe.label,
    parts,
    source: 'built-in recipe',
  };
  return { plan, parts: proposedFromParts(parts) };
}

function numberOr(v: ParamValue | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Turn a plan's parts into the merge's view of them, keys and all.
 *
 * The keys come from the same function the original build used, which is what
 * makes `step#7` in the new output the same step as `step#7` in the baseline
 * — and what gives a 20-to-30 change a defined answer rather than a diff of
 * two unrelated lists.
 */
export function proposedFromParts(parts: BuildPart[]): ProposedPart[] {
  return identifiedParts(parts).parts;
}

/** The same, with the identity problems the caller should show. */
export function identifiedParts(
  parts: BuildPart[],
): { parts: ProposedPart[]; problems: string[]; uncertain: string[] } {
  const assigned = assignIdentities(parts.map((p) => ({ id: p.id, name: p.name ?? p.shape })));
  const keys = assigned.keys;
  const out: ProposedPart[] = parts.map((part, i) => {
    const mesh = meshForPart(part);
    const rotation: [number, number, number] = part.rotation
      ? [part.rotation[0] * DEG2RAD, part.rotation[1] * DEG2RAD, part.rotation[2] * DEG2RAD]
      : [0, 0, 0];
    return {
      key: keys[i],
      name: part.name ?? part.shape,
      position: [part.position[0], part.position[1], part.position[2]],
      rotation,
      scale: [1, 1, 1],
      mesh: mesh.toJSON(),
      color: part.color,
    };
  });
  return {
    parts: out,
    problems: assigned.problems,
    // Anything not carrying an identity of its own is matched by where it sits
    // in the list, which is a guess the moment a program reorders itself.
    uncertain: keys.filter((_, i) => assigned.source[i] === 'derived'),
  };
}

/** The settings an asset exposes, for the panel that shows what can be changed. */
export function revisableSettings(prov: Provenance | null): { key: string; value: ParamValue }[] {
  if (!prov) return [];
  const hidden = new Set(['words', 'recipe']);
  return Object.entries(prov.params)
    .filter(([key]) => !hidden.has(key))
    .map(([key, value]) => ({ key, value }));
}

/**
 * The instruction handed to a model when a generated program is revised.
 *
 * The existing program goes with it, because "make the tabletop wider" against
 * a program that already builds a table is a small edit a small model can
 * make, while the same words with no code are a whole table to reinvent.
 */
export function programRevisionPrompt(prov: Provenance, request: string): string {
  return [
    'Here is a program that builds a 3D model:',
    '',
    prov.code ?? '',
    '',
    prov.prompt ? `It was written for: ${prov.prompt}` : '',
    '',
    `Change it so that: ${request}`,
    '',
    'Change as little as possible. Keep every part name exactly as it is, keep the same',
    'number of distinct part names, and keep the parts in the same order — the names are',
    'how the edited model is matched up with the one already in the scene.',
    'Reply with the corrected JavaScript only.',
  ].filter((line) => line !== null).join('\n');
}
