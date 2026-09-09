import { SerializedObject } from '../scene/Scene';

/**
 * Where a generated object came from, and what it looked like before you
 * touched it.
 *
 * Generating geometry is the easy half. The half every tool skips is coming
 * back to it: "make that staircase thirty steps instead of twenty" is a
 * sentence anyone would say, and in every application that exists the answer
 * is to generate a second staircase and redo your materials on it. The reason
 * is that nothing is kept — the prompt, the recipe, the numbers it ran with
 * and the shape it produced all evaporate the moment the objects land in the
 * scene, so there is nothing to revise, only something to replace.
 *
 * So this records four things and saves them in the file:
 *
 *   - What made it (a recipe, a generated program, a reference image, an
 *     import) and the settings that made it, so it can be run again.
 *   - A stable identity per asset and per generated part, so "the third step"
 *     survives renaming, reordering and a save/reload.
 *   - The generated baseline — the exact geometry the generator produced.
 *     Without it there is no way to tell a change *you* made from a change the
 *     generator is about to make, and no way to keep the first while applying
 *     the second.
 *   - A schema version, so a file written by an older build is recognisable
 *     rather than misread.
 *
 * Nothing here re-runs anything on load. Opening a file shows the geometry the
 * file contains; a regeneration only ever happens because somebody asked.
 */

/** Bumped when the shape of what is stored changes. */
export const PROVENANCE_SCHEMA = 1;

/** Bumped when a generator's output changes for the same input. */
export const GENERATOR_VERSION = 1;

export type ProvenanceSource = 'recipe' | 'program' | 'reference' | 'import';

/** A value a revision is allowed to change. */
export type ParamValue = number | string | boolean | null;

export type SerializedMesh = NonNullable<SerializedObject['mesh']>;

/** One generated part, as the generator last produced it. */
export interface BaselinePart {
  /** Stable semantic identity — see `partKeyFor`. */
  key: string;
  name: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  mesh: SerializedMesh | null;
  /** The colour the generator asked for, so a recoloured part is detectable. */
  color?: string;
}

/**
 * What the generator produced last time.
 *
 * `parts` for a multi-part asset (a recipe or a program), `mesh` for a
 * single-mesh one (anything derived from a reference image). Both may be
 * present; neither being present means the baseline could not be captured,
 * which is honest and is treated as "cannot tell your edits from the
 * generator's" rather than as "no edits".
 */
export interface Baseline {
  parts?: BaselinePart[];
  mesh?: SerializedMesh | null;
}

/** The source image a reference-derived asset was built from. */
export interface ReferenceOrigin {
  /** Scene texture holding the picture, so the file is self-contained. */
  textureId: number | null;
  name: string;
  /** Video playhead the frame was taken from, in seconds. */
  frameTime: number;
  width: number;
  height: number;
  /**
   * True when the picture itself was not kept — the asset can be described
   * and inspected but not regenerated without the original file.
   */
  missing?: boolean;
}

export interface Provenance {
  schema: number;
  source: ProvenanceSource;
  /**
   * Identity of the asset itself, independent of object ids.
   *
   * Object ids are renumbered by a duplicate and are only unique inside one
   * scene; two files merged together would collide. This is minted once and
   * carried, so an asset stays the same asset through save, reload, rename
   * and re-parenting.
   */
  assetId: string;
  /** Which generator, e.g. "recipe:Stairs", "program", "reference:silhouette". */
  generator: string;
  generatorVersion: number;
  /** The words that produced it, when there were any. */
  prompt?: string;
  /** The program, for a generated-code asset. */
  code?: string;
  /** Settings a revision may change. Structured on purpose: see `revise.ts`. */
  params: Record<string, ParamValue>;
  /** Present where the generator is random, so a re-run repeats. */
  seed?: number;
  reference?: ReferenceOrigin;
  baseline: Baseline;
  createdAt: number;
  /** Bumped on every accepted revision, for the history line. */
  revision: number;
}

let assetCounter = 0;

/**
 * A fresh asset id.
 *
 * Random rather than sequential because these are compared across files: two
 * scenes generated in two sessions and then merged must not collide, and a
 * counter alone would guarantee that they do.
 */
export function newAssetId(): string {
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `a${(Date.now() % 0xffffffff).toString(36)}${(++assetCounter).toString(36)}${rand}`;
}

/**
 * A stable key for one generated part.
 *
 * Position in an array is not identity — inserting a step at the bottom shifts
 * every step after it. Nor is the display name, which repeats ("Step", "Step",
 * "Step") and which the user is free to change.
 *
 * So: the *role* the generator gave the part, normalised, plus which one it is
 * within that role. `Step 7` and `Step` (the seventh of them) both become
 * `step#7`. When a count changes, the correspondence is defined and boring —
 * roles line up by ordinal, lowest first, and whatever is left over on either
 * side is genuinely an addition or a removal. Twenty steps becoming thirty
 * keeps `step#1`..`step#20` and adds `step#21`..`step#30`; thirty becoming
 * twenty removes the top ten rather than renumbering the lot.
 */
export function partKeyFor(name: string | undefined, ordinalWithinRole: number): string {
  const role = roleOf(name);
  return `${role}#${ordinalWithinRole}`;
}

/** The repeated-part role a name belongs to: "Step 7" and "Step" are both steps. */
export function roleOf(name: string | undefined): string {
  const raw = (name ?? 'part').trim().toLowerCase();
  // Trailing ordinals and Blender-style .001 suffixes are which-one-is-it, not
  // which-kind-is-it.
  const stripped = raw.replace(/[\s._-]*\d+$/, '').trim();
  const role = (stripped || raw || 'part').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return role || 'part';
}

/**
 * Assign keys to a list of named parts, in order.
 *
 * Exported because both the generator and the merge have to agree on it
 * exactly, and a second implementation would eventually disagree.
 */
export function assignPartKeys(names: (string | undefined)[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const role = roleOf(name);
    const n = (seen.get(role) ?? 0) + 1;
    seen.set(role, n);
    return `${role}#${n}`;
  });
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function triple(v: unknown, fallback: number): [number, number, number] {
  const a = Array.isArray(v) ? v : [];
  return [
    isFiniteNumber(a[0]) ? a[0] : fallback,
    isFiniteNumber(a[1]) ? a[1] : fallback,
    isFiniteNumber(a[2]) ? a[2] : fallback,
  ];
}

/** A stored value we are willing to hand to a generator. */
function paramValue(v: unknown): ParamValue | undefined {
  if (v === null) return null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (isFiniteNumber(v)) return v;
  return undefined;
}

function serializedMesh(v: unknown): SerializedMesh | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Partial<SerializedMesh>;
  if (!Array.isArray(m.positions) || !Array.isArray(m.faces)) return null;
  return v as SerializedMesh;
}

/**
 * Read provenance out of a document, keeping only what is usable.
 *
 * Same rule as the rest of the loader: check what a field has to be, keep it
 * if it is, drop it if it is not, never throw. A file from before any of this
 * existed simply has none, which is a supported state and not an error — the
 * geometry opens exactly as it always did, and the revise action tells you
 * honestly that there is nothing recorded to revise from.
 */
export function normaliseProvenance(raw: unknown): Provenance | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<Provenance>;
  const source: ProvenanceSource | null =
    p.source === 'recipe' || p.source === 'program' || p.source === 'reference' || p.source === 'import'
      ? p.source
      : null;
  if (!source) return null;
  if (typeof p.assetId !== 'string' || !p.assetId) return null;

  const params: Record<string, ParamValue> = {};
  if (p.params && typeof p.params === 'object') {
    for (const [key, value] of Object.entries(p.params)) {
      const v = paramValue(value);
      if (v !== undefined) params[key] = v;
    }
  }

  const rawBase = (p.baseline && typeof p.baseline === 'object' ? p.baseline : {}) as Partial<Baseline>;
  const parts: BaselinePart[] = [];
  for (const entry of Array.isArray(rawBase.parts) ? rawBase.parts : []) {
    if (!entry || typeof entry !== 'object') continue;
    const bp = entry as Partial<BaselinePart>;
    if (typeof bp.key !== 'string' || !bp.key) continue;
    parts.push({
      key: bp.key,
      name: typeof bp.name === 'string' ? bp.name : bp.key,
      position: triple(bp.position, 0),
      rotation: triple(bp.rotation, 0),
      scale: triple(bp.scale, 1),
      mesh: serializedMesh(bp.mesh),
      color: typeof bp.color === 'string' ? bp.color : undefined,
    });
  }

  let reference: ReferenceOrigin | undefined;
  if (p.reference && typeof p.reference === 'object') {
    const r = p.reference as Partial<ReferenceOrigin>;
    reference = {
      textureId: Number.isInteger(r.textureId) ? (r.textureId as number) : null,
      name: typeof r.name === 'string' ? r.name : 'reference',
      frameTime: isFiniteNumber(r.frameTime) ? r.frameTime : 0,
      width: isFiniteNumber(r.width) ? r.width : 0,
      height: isFiniteNumber(r.height) ? r.height : 0,
      missing: r.missing === true,
    };
  }

  // Built by omission rather than with explicit nulls, so a record that goes
  // through a save and a reload comes back byte-identical. A normaliser that
  // adds `mesh: null` where there was no mesh makes every reloaded asset look
  // as though something changed.
  const baseline: Baseline = {};
  if (parts.length) baseline.parts = parts;
  const baseMesh = serializedMesh(rawBase.mesh);
  if (baseMesh) baseline.mesh = baseMesh;

  return {
    schema: isFiniteNumber(p.schema) ? p.schema : 0,
    source,
    assetId: p.assetId,
    generator: typeof p.generator === 'string' ? p.generator : source,
    generatorVersion: isFiniteNumber(p.generatorVersion) ? p.generatorVersion : 0,
    prompt: typeof p.prompt === 'string' ? p.prompt : undefined,
    code: typeof p.code === 'string' ? p.code : undefined,
    params,
    seed: isFiniteNumber(p.seed) ? p.seed : undefined,
    reference,
    baseline,
    createdAt: isFiniteNumber(p.createdAt) ? p.createdAt : 0,
    revision: isFiniteNumber(p.revision) ? Math.max(0, Math.floor(p.revision)) : 0,
  };
}

/** A deep copy, so a snapshot never shares mutable state with the live object. */
export function cloneProvenance(p: Provenance): Provenance {
  return JSON.parse(JSON.stringify(p)) as Provenance;
}

/**
 * Whether this asset can actually be regenerated, and what is missing if not.
 *
 * The honest answer matters more than the optimistic one: an asset whose
 * reference image was never embedded can be described and compared but not
 * rebuilt, and saying so up front is better than producing something wrong
 * from a picture that is no longer there.
 */
export function regenerability(p: Provenance | null): { can: boolean; why: string } {
  if (!p) {
    return {
      can: false,
      why: 'This object has no record of how it was made — it was imported, modelled by hand, '
        + 'or made before revisions existed.',
    };
  }
  if (p.schema > PROVENANCE_SCHEMA) {
    return { can: false, why: 'This object was made by a newer version of Kline than this one.' };
  }
  switch (p.source) {
    case 'recipe':
      return { can: true, why: '' };
    case 'program':
      return p.code
        ? { can: true, why: '' }
        : { can: false, why: 'The program that built this was not kept.' };
    case 'reference':
      return p.reference && !p.reference.missing
        ? { can: true, why: '' }
        : { can: false, why: `The picture this was built from (${p.reference?.name ?? 'unknown'}) is not in this file.` };
    default:
      return { can: false, why: 'Imported geometry has no generator to re-run.' };
  }
}

/** Whether the baseline is good enough to tell a user edit from a generator change. */
export function hasBaseline(p: Provenance | null): boolean {
  if (!p) return false;
  return !!(p.baseline.parts?.length || p.baseline.mesh);
}
