import { DEG2RAD, Vec3 } from '../core/math';
import { Mesh } from '../mesh/Mesh';
import { PrimitiveKind, buildPrimitive } from '../mesh/primitives';
import { Scene, SceneObject } from '../scene/Scene';
import { createMaterial, hexToLinear } from '../scene/Material';
import {
  BASELINE_VERSION, Baseline, BaselinePart, GENERATOR_VERSION, PROVENANCE_SCHEMA, Provenance,
  ProvenanceSource, ReferenceOrigin, assignIdentities, newAssetId,
} from './provenance';

/**
 * The build plan: what "make me a table" turns into.
 *
 * Deliberately flat and small — a list of primitives with a position, a size
 * and a colour, nothing nested and no references between parts. That is what
 * makes it both trivial to validate and something a 3B parameter model running
 * on a laptop can actually emit correctly.
 *
 * Units are metres, Z is up, and the ground is z = 0. A part's position is the
 * centre of its bounding box, so a 1m cube sitting on the floor is at z = 0.5.
 */

export const BUILD_SHAPES = [
  'cube', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'circle', 'icosphere', 'grid',
] as const;

export type BuildShape = (typeof BUILD_SHAPES)[number];

export interface BuildPart {
  shape: BuildShape;
  name?: string;
  /**
   * A stable identity the program chose for this part.
   *
   * Role-and-ordinal matching works for a recipe, whose parts come out in the
   * same order with the same names every time. A generated program has no such
   * discipline: a model asked to make the tabletop wider may rename it, or emit
   * the legs before the top, and matching by position in the list would then
   * hand your material to a different part. An explicit id survives both.
   *
   * Pure data. It travels in the plan the sandbox already returns, so nothing
   * about the sandbox's reach changes.
   */
  id?: string;
  /** Centre of the part, in metres. */
  position: [number, number, number];
  /** Bounding-box size in metres; the primitive is scaled to match. */
  size: [number, number, number];
  /** Degrees, XYZ. */
  rotation?: [number, number, number];
  /** "#rrggbb" or a common colour name. */
  color?: string;
  smooth?: boolean;
}

export interface BuildPlan {
  name: string;
  parts: BuildPart[];
  /** Where the plan came from, for the status line. */
  source?: string;
  /** Anything the planner wants to tell the user. */
  note?: string;
}

const SHAPE_TO_PRIMITIVE: Record<BuildShape, PrimitiveKind> = {
  cube: 'cube',
  sphere: 'uvsphere',
  icosphere: 'icosphere',
  cylinder: 'cylinder',
  cone: 'cone',
  torus: 'torus',
  plane: 'plane',
  circle: 'circle',
  grid: 'grid',
};

export const COLOR_NAMES: Record<string, string> = {
  black: '#1a1a1a', white: '#f2f2f2', grey: '#8a8a8a', gray: '#8a8a8a',
  silver: '#c0c4c8', red: '#c0392b', crimson: '#a01f2d', pink: '#e79ab5',
  orange: '#e07b26', amber: '#e0a020', yellow: '#e3c341', gold: '#c9a227',
  green: '#4f8f3f', lime: '#8bc34a', teal: '#2f8f86', cyan: '#3fb5c4',
  blue: '#3a6fb0', navy: '#26456e', purple: '#7d5ba6', violet: '#8f6fc4',
  magenta: '#b0459b', brown: '#7a5230', tan: '#b89468', wood: '#8b5e34',
  beige: '#d8c8a8', cream: '#efe3c8', charcoal: '#3a3a3c', steel: '#7f8c99',
  copper: '#b3714e', bronze: '#8c6239', glass: '#cfe4ee',
};

export function resolveColor(value: string | undefined): string | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.slice(1).split('').map((c) => c + c).join('')}`;
  }
  return COLOR_NAMES[raw] ?? null;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function triple(value: unknown, fallback: [number, number, number], lo: number, hi: number):
[number, number, number] {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const v = clamp(value, lo, hi);
    return [v, v, v];
  }
  if (!Array.isArray(value)) return fallback;
  const out: [number, number, number] = [...fallback];
  for (let i = 0; i < 3; i++) {
    const n = Number(value[i]);
    if (Number.isFinite(n)) out[i] = clamp(n, lo, hi);
  }
  return out;
}

export interface ValidationResult {
  plan: BuildPlan | null;
  /** Problems that were repaired rather than rejected. */
  warnings: string[];
}

/**
 * Coerce whatever a model produced into a plan we are willing to execute.
 *
 * Anything unrecognised is repaired toward a sane default rather than thrown
 * out — a model that writes "box" instead of "cube", or a size of 900, should
 * still give the user something, not an error.
 */
export function validatePlan(input: unknown, fallbackName = 'Build'): ValidationResult {
  const warnings: string[] = [];
  if (!input || typeof input !== 'object') return { plan: null, warnings: ['Not an object.'] };

  const raw = input as Record<string, unknown>;
  const rawParts = Array.isArray(raw.parts) ? raw.parts
    : Array.isArray(raw.objects) ? raw.objects
      : Array.isArray(input) ? (input as unknown[]) : null;
  if (!rawParts) return { plan: null, warnings: ['No "parts" array.'] };

  const aliases: Record<string, BuildShape> = {
    box: 'cube', block: 'cube', cuboid: 'cube', rect: 'cube', slab: 'cube',
    ball: 'sphere', globe: 'sphere', uvsphere: 'sphere',
    tube: 'cylinder', pipe: 'cylinder', rod: 'cylinder', disc: 'cylinder', column: 'cylinder',
    pyramid: 'cone', spike: 'cone',
    ring: 'torus', donut: 'torus',
    floor: 'plane', ground: 'plane', quad: 'plane',
  };

  const parts: BuildPart[] = [];
  for (const entry of rawParts.slice(0, 400)) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const shapeRaw = String(p.shape ?? p.type ?? p.primitive ?? 'cube').trim().toLowerCase();
    let shape = BUILD_SHAPES.find((s) => s === shapeRaw) ?? aliases[shapeRaw];
    if (!shape) {
      shape = 'cube';
      warnings.push(`Unknown shape "${shapeRaw}", used a cube.`);
    }

    const size = triple(p.size ?? p.scale ?? p.dimensions, [1, 1, 1], 0.001, 500);
    const position = triple(p.position ?? p.at ?? p.location, [0, 0, size[2] / 2], -500, 500);
    const rotation = triple(p.rotation ?? p.rotate, [0, 0, 0], -3600, 3600);

    const colorRaw = typeof p.color === 'string' ? p.color : typeof p.colour === 'string' ? p.colour : undefined;
    const color = resolveColor(colorRaw);
    if (colorRaw && !color) warnings.push(`Unknown colour "${colorRaw}".`);

    const rawId = typeof p.id === 'string' ? p.id : undefined;
    parts.push({
      shape,
      id: rawId && /^[A-Za-z0-9_.:-]{1,48}$/.test(rawId.trim()) ? rawId.trim() : undefined,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : undefined,
      position,
      size,
      rotation: rotation.some((v) => v !== 0) ? rotation : undefined,
      color: color ?? undefined,
      smooth: typeof p.smooth === 'boolean' ? p.smooth : undefined,
    });
  }

  if (parts.length === 0) return { plan: null, warnings: [...warnings, 'No usable parts.'] };
  if (rawParts.length > parts.length) {
    warnings.push(`Skipped ${rawParts.length - parts.length} unusable part(s).`);
  }

  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, 40)
    : fallbackName;
  return { plan: { name, parts }, warnings };
}

/** Scale a primitive so its bounding box matches `size`, then place it. */
export function meshForPart(part: BuildPart): Mesh {
  const mesh = buildPrimitive(SHAPE_TO_PRIMITIVE[part.shape]);
  const box = mesh.bounds();
  if (!box.valid) return mesh;
  const extent = box.size();
  const centre = box.center();
  const factor = new Vec3(
    extent.x > 1e-6 ? part.size[0] / extent.x : 1,
    extent.y > 1e-6 ? part.size[1] / extent.y : 1,
    extent.z > 1e-6 ? part.size[2] / extent.z : 1,
  );
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i].sub(centre);
    mesh.positions[i] = new Vec3(p.x * factor.x, p.y * factor.y, p.z * factor.z);
  }
  mesh.markDirty();
  if (part.smooth !== undefined) mesh.setAllSmooth(part.smooth);
  return mesh;
}

export interface ExecuteResult {
  root: SceneObject;
  objects: SceneObject[];
  /** Part keys in the same order as `objects`. */
  keys: string[];
}

/** Everything a later revision needs to know about how this build was asked for. */
export interface BuildOrigin {
  source: ProvenanceSource;
  generator: string;
  prompt?: string;
  code?: string;
  params?: Record<string, number | string | boolean | null>;
  seed?: number;
  reference?: ReferenceOrigin;
  /** Reuse an existing identity, when this build is a revision of one. */
  assetId?: string;
  revision?: number;
}

/**
 * Turn a plan into real scene objects, grouped under one empty so the whole
 * build can be moved, hidden or deleted as a unit.
 */
export function executePlan(scene: Scene, plan: BuildPlan, origin = new Vec3()): ExecuteResult {
  const root = scene.add('empty', plan.name);
  root.position = origin.clone();

  // One material per distinct colour, so the outliner does not fill with
  // near-duplicate materials on a fifty-part build.
  const materials = new Map<string, number>();
  const materialFor = (hex: string): number => {
    const existing = materials.get(hex);
    if (existing !== undefined) return existing;
    const index = scene.addMaterial(createMaterial({
      name: hex,
      color: hexToLinear(hex),
      roughness: 0.55,
    }));
    materials.set(hex, index);
    return index;
  };

  const objects: SceneObject[] = [];
  const keys = assignIdentities(
    plan.parts.map((p) => ({ id: p.id, name: p.name ?? p.shape })),
  ).keys;
  for (const [index, part] of plan.parts.entries()) {
    const obj = scene.add('mesh', part.name ?? part.shape, meshForPart(part));
    obj.partKey = keys[index];
    obj.position = new Vec3(part.position[0], part.position[1], part.position[2]);
    if (part.rotation) {
      obj.rotation = new Vec3(
        part.rotation[0] * DEG2RAD, part.rotation[1] * DEG2RAD, part.rotation[2] * DEG2RAD,
      );
    }
    obj.materialSlots = [part.color ? materialFor(part.color) : scene.ensureDefaultMaterial()];
    scene.setParent(obj.id, root.id);
    objects.push(obj);
  }
  return { root, objects, keys };
}

/**
 * The geometry a generator just produced, frozen for comparison later.
 *
 * This is the thing that makes a revision possible rather than a replacement.
 * With it, three states are knowable — what the generator made, what you made
 * of it, and what the generator would make now — and a change can be applied
 * to one without discarding the other. Without it there are only two, and no
 * way to tell which of them moved.
 */
export function captureBaseline(
  objects: SceneObject[], keys: string[], materials?: unknown[],
): Baseline {
  const byId = new Map<number, string>();
  objects.forEach((obj, i) => byId.set(obj.id, keys[i] ?? obj.partKey ?? `part#${i + 1}`));
  const parts: BaselinePart[] = objects.map((obj, i) => ({
    key: keys[i] ?? obj.partKey ?? `part#${i + 1}`,
    name: obj.name,
    position: obj.position.toArray(),
    rotation: obj.rotation.toArray(),
    scale: obj.scale.toArray(),
    mesh: obj.mesh ? obj.mesh.toJSON() : null,
    // Everything the merge has to consult before it is allowed to call a part
    // untouched. Geometry alone was not enough: a recoloured, rigged or
    // animated part looked identical to one nobody had opened.
    materialSlots: [...obj.materialSlots],
    materials: materials
      ? obj.materialSlots.map((slot) => materials[slot] ?? null)
      : undefined,
    modifiers: JSON.parse(JSON.stringify(obj.modifiers)),
    animation: JSON.parse(JSON.stringify(obj.animation ?? [])),
    visible: obj.visible,
    locked: obj.locked,
    protectedFromRegen: obj.protectedFromRegen,
    parentKey: obj.parent !== null ? byId.get(obj.parent) ?? null : null,
    childKeys: obj.children.map((id) => byId.get(id)).filter((k): k is string => !!k),
  }));
  return { parts, version: BASELINE_VERSION };
}

/** Attach the record of how an asset was made to its root. */
export function recordProvenance(
  root: SceneObject, origin: BuildOrigin, baseline: Baseline,
): Provenance {
  const provenance: Provenance = {
    schema: PROVENANCE_SCHEMA,
    source: origin.source,
    assetId: origin.assetId ?? newAssetId(),
    generator: origin.generator,
    generatorVersion: GENERATOR_VERSION,
    prompt: origin.prompt,
    code: origin.code,
    params: { ...(origin.params ?? {}) },
    seed: origin.seed,
    reference: origin.reference,
    baseline,
    createdAt: Date.now(),
    revision: origin.revision ?? 0,
  };
  root.provenance = provenance;
  return provenance;
}

/** A compact description of the plan, for the status line. */
export function describePlan(plan: BuildPlan): string {
  const shapes = new Map<string, number>();
  for (const p of plan.parts) shapes.set(p.shape, (shapes.get(p.shape) ?? 0) + 1);
  const summary = [...shapes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([shape, n]) => `${n} ${shape}${n === 1 ? '' : 's'}`)
    .join(', ');
  return `${plan.name}: ${summary}`;
}
