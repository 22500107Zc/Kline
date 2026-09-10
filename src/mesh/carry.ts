import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';
import { SurfaceSampler } from '../uv/transfer';
import { TransferStats, transferUV } from '../uv/transfer';

/**
 * Carrying per-vertex work across a rebuild.
 *
 * When a regeneration replaces every vertex, anything stored *against* those
 * vertices has nothing left to hold on to: skin weights, vertex colours and
 * sculpt masks are all indexed by vertex, and the new mesh has different ones.
 * The usual answer is to say so and lose them.
 *
 * There is a better answer, and it is the one a rigger does by hand: for each
 * new vertex, find the closest point on the old surface and take what was
 * there. It is an approximation — a weight sampled at the nearest surface
 * point is not the weight the old vertex had, because there is no old vertex —
 * but it is a good one wherever the two shapes broadly agree, which is the
 * case a regeneration actually produces. Where they do not agree it degrades
 * smoothly rather than failing, and how far each sample had to reach is
 * reported so the caller can say when the result should be checked.
 *
 * This is offered as a choice, never applied silently: "carry my weights
 * across" is a decision with a cost, and the cost has to be visible.
 */

/**
 * What happened to one attribute that was asked for.
 *
 *   - `preserved` every unit that wanted a value got the value it had.
 *   - `resampled` every unit got a value, but the value was interpolated or
 *     re-derived rather than copied.
 *   - `reduced`   every unit got a value, and something had to be discarded to
 *     fit it — an influence beyond the four a vertex can hold.
 *   - `partial`   some units got nothing and keep whatever they had.
 *   - `failed`    nothing got anything.
 */
export type AttributeOutcome = 'preserved' | 'resampled' | 'reduced' | 'partial' | 'failed';

export interface AttributeReport {
  /** What this is, in the words the panel uses. */
  name: string;
  /** Units that wanted a value — vertices, or faces for coordinates. */
  wanted: number;
  /** Units that got one. */
  delivered: number;
  outcome: AttributeOutcome;
  /** Every reason this is not a byte-for-byte copy of what was there. */
  lossy: string[];
}

/**
 * How much of the result is actually known to be good.
 *
 *   - `exact`      demonstrably lossless: the surfaces coincide, every sample
 *                  landed on a vertex rather than between them, every attribute
 *                  asked for arrived in full, and nothing had to be discarded
 *                  or re-derived along the way.
 *   - `approximate` everything asked for arrived, by interpolation.
 *   - `partial`    something asked for did not arrive, or not everywhere.
 *   - `failed`     nothing arrived.
 *   - `unmeasured` something arrived and correspondence was never measured.
 *
 * The bar for `exact` is deliberately high, and it is about *attributes*, not
 * about geometry. Two surfaces sitting in the same place proves that the
 * nearest-point search had somewhere close to look; it does not prove that
 * what came back is what was there. A sample landing in the middle of a
 * triangle blends three corners. A face whose corners straddle a seam is
 * re-sampled against one source face instead of taking its corners' own
 * coordinates. A vertex under five bones keeps four. Each of those is the
 * right thing to do and none of them is preservation, so none of them is
 * allowed to be reported as it.
 */
export type CarryQuality = 'exact' | 'approximate' | 'partial' | 'failed' | 'unmeasured';

export interface CarryReport {
  /** What was actually moved across, by name. */
  carried: string[];
  /** One entry per attribute that was asked for. */
  attributes: AttributeReport[];
  /** Vertices whose nearest old surface point was further than `far`. */
  uncertain: number;
  /** Vertices actually placed on the old surface. Zero when nothing was measured. */
  total: number;
  /** Vertices in the target, whether or not they could be placed. */
  targetVerts: number;
  /** The furthest any sample had to reach, in world units. */
  worst: number;
  /** The size the reach is measured against. */
  span: number;
  /** How far the typical sample had to reach, in world units. */
  median: number;
  /**
   * Whether the two surfaces occupy the same space, within rounding.
   *
   * Kept separate from `quality` on purpose. This is a fact about geometry and
   * says nothing on its own about whether the attributes survived.
   */
  coincident: boolean;
  /** What the evidence supports saying about the attributes. */
  quality: CarryQuality;
  /** Faces of the target that received coordinates, and how many were tried. */
  uvFilled: number;
  uvFaces: number;
}

/**
 * How far a sample may reach before the answer stops meaning much.
 *
 * Expressed as a fraction of the mesh's own size, so it means the same thing
 * on a doorknob and on a building.
 */
const FAR_FRACTION = 0.05;

/** How close a barycentric weight must be to 1 for a sample to be *at* a vertex. */
const AT_A_CORNER = 1 - 1e-6;

/**
 * Move skin weights, vertex colours and the sculpt mask from one mesh onto
 * another with different topology.
 *
 * The target is mutated. Returns what was carried and how much of it should be
 * treated with suspicion.
 */
export function carryAttributes(from: Mesh, to: Mesh): CarryReport {
  const report: CarryReport = {
    carried: [], attributes: [], uncertain: 0, total: 0, targetVerts: to.vertCount,
    worst: 0, span: 1, median: 0, coincident: false, quality: 'failed',
    uvFilled: 0, uvFaces: 0,
  };
  const wantsSkin = !!from.skin && from.skin.bones.length >= from.vertCount * 4;
  const wantsColors = !!from.colors && from.colors.length >= from.vertCount * 3;
  const wantsMask = !!from.mask && from.mask.length >= from.vertCount;

  const sampler = new SurfaceSampler(from);
  if (sampler.empty) {
    // No surface to sample from at all. Nothing is carried and nothing is
    // claimed — not even a UV transfer, which needs the same triangles.
    for (const [name, wanted] of requested(from, to, wantsSkin, wantsColors, wantsMask)) {
      report.attributes.push({ name, wanted, delivered: 0, outcome: 'failed', lossy: [] });
    }
    return report;
  }

  // Measured against the larger of the two shapes. A part that doubles in size
  // puts every new vertex a long way from the old surface, and calling all of
  // them suspect on that basis says nothing useful about the transfer.
  const spanOf = (b: ReturnType<Mesh['bounds']>): number =>
    (b.valid ? Math.max(b.size().x, b.size().y, b.size().z, 1e-6) : 1);
  const span = Math.max(spanOf(from.bounds()), spanOf(to.bounds()));
  const far = span * FAR_FRACTION;
  report.span = span;

  const bones = wantsSkin ? new Int32Array(to.vertCount * 4) : null;
  const weights = wantsSkin ? new Float32Array(to.vertCount * 4) : null;
  const colors = wantsColors ? new Float32Array(to.vertCount * 3).fill(1) : null;
  const mask = wantsMask ? new Float32Array(to.vertCount) : null;

  const distances: number[] = [];
  // Samples that landed between vertices rather than on one. Blending three
  // corners is the right way to fill the gap and is not the same as copying.
  let blended = 0;
  // Vertices where a fifth influence had to be dropped to fit the four a
  // vertex can hold.
  let crowded = 0;
  let placed = 0;

  for (let v = 0; v < to.vertCount; v++) {
    const hit = sampler.closest(to.positions[v]);
    if (!hit) continue;
    placed++;
    const distance = Math.sqrt(hit.distSq);
    distances.push(distance);
    if (distance > far) report.uncertain++;
    if (distance > report.worst) report.worst = distance;

    // Barycentric across the triangle the point landed on, so a weight varies
    // smoothly over a face instead of snapping to whichever corner won.
    const corners: [number, number][] = [
      [hit.tri.a, hit.u], [hit.tri.b, hit.v], [hit.tri.c, hit.w],
    ];
    if (!corners.some(([, share]) => share >= AT_A_CORNER)) blended++;

    if (bones && weights && from.skin) {
      // Blend the influences of the three corners, then keep the four
      // strongest — which is what the format holds, and what a fifth influence
      // would be dropped into anyway.
      const pool = new Map<number, number>();
      for (const [corner, share] of corners) {
        for (let i = 0; i < 4; i++) {
          const bone = from.skin.bones[corner * 4 + i];
          const weight = from.skin.weights[corner * 4 + i] * share;
          if (weight <= 0) continue;
          pool.set(bone, (pool.get(bone) ?? 0) + weight);
        }
      }
      if (pool.size > 4) crowded++;
      const best = [...pool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = best.reduce((sum, [, w]) => sum + w, 0);
      for (let i = 0; i < best.length; i++) {
        bones[v * 4 + i] = best[i][0];
        weights[v * 4 + i] = total > 0 ? best[i][1] / total : 0;
      }
    }

    if (colors && from.colors) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (const [corner, share] of corners) sum += from.colors[corner * 3 + c] * share;
        colors[v * 3 + c] = sum;
      }
    }

    if (mask && from.mask) {
      let sum = 0;
      for (const [corner, share] of corners) sum += from.mask[corner] * share;
      mask[v] = sum;
    }
  }

  report.total = placed;
  distances.sort((a, b) => a - b);
  report.median = distances.length ? distances[distances.length >> 1] : 0;
  report.coincident = distances.length > 0
    && placed === to.vertCount
    && report.worst <= span * 1e-6;

  // Every sample landed on a vertex, so nothing was blended between them.
  const sampledCleanly = placed === to.vertCount && blended === 0;

  if (bones && weights) {
    to.skin = { bones, weights };
    report.carried.push('skin weights');
    report.attributes.push(attribute('skin weights', to.vertCount, placed, [
      ...(sampledCleanly ? [] : ['sampled between vertices and blended']),
      ...(crowded ? [`${crowded} vertices had more than four influences; the weakest were dropped`] : []),
    ], crowded > 0 ? 'reduced' : undefined));
  }
  if (colors) {
    to.colors = colors;
    report.carried.push('vertex colours');
    report.attributes.push(attribute('vertex colours', to.vertCount, placed,
      sampledCleanly ? [] : ['sampled between vertices and blended']));
  }
  if (mask) {
    to.mask = mask;
    report.carried.push('sculpt mask');
    report.attributes.push(attribute('sculpt mask', to.vertCount, placed,
      sampledCleanly ? [] : ['sampled between vertices and blended']));
  }
  // UVs have their own transfer, which understands seams; it runs whether or
  // not there was anything per-vertex, so one call carries everything that can
  // be carried.
  carryUV(from, to, report);
  grade(report, distances);
  if (report.carried.length) to.markDirty();
  return report;
}

/** One attribute's verdict, from what it wanted against what it got. */
function attribute(
  name: string, wanted: number, delivered: number, lossy: string[],
  forced?: AttributeOutcome,
): AttributeReport {
  const outcome: AttributeOutcome = delivered === 0 ? 'failed'
    : delivered < wanted ? 'partial'
      : forced ?? (lossy.length ? 'resampled' : 'preserved');
  return { name, wanted, delivered, outcome, lossy };
}

/** What was asked for, for the case where nothing could be attempted. */
function requested(
  from: Mesh, to: Mesh, skin: boolean, colors: boolean, mask: boolean,
): [string, number][] {
  const out: [string, number][] = [];
  if (skin) out.push(['skin weights', to.vertCount]);
  if (colors) out.push(['vertex colours', to.vertCount]);
  if (mask) out.push(['sculpt mask', to.vertCount]);
  if (from.hasUV) out.push(['UV coordinates', to.faces.filter((f) => f.length >= 3).length]);
  return out;
}

/**
 * UVs, through the transfer that already knows about seams.
 *
 * A source that has coordinates is a request, and a request that delivers
 * nothing is a failure that has to be reported — even when the skin weights
 * beside it came across perfectly. Previously this only recorded a success:
 * filling zero faces pushed nothing onto `carried`, so there was no entry to
 * be wrong about, and the report read as though coordinates had never been
 * asked for.
 */
function carryUV(from: Mesh, to: Mesh, report: CarryReport): void {
  if (!from.hasUV) return;
  // Counted against the faces that could take coordinates at all: a face with
  // fewer than three corners is not a surface and is never a shortfall.
  report.uvFaces = to.faces.reduce((n, f) => n + (f.length >= 3 ? 1 : 0), 0);
  const stats: TransferStats = { considered: 0, filled: 0, reseamed: 0 };
  report.uvFilled = transferUV(from, to, false, stats);
  if (report.uvFilled > 0) report.carried.push('UV coordinates');
  report.attributes.push(attribute('UV coordinates', report.uvFaces, report.uvFilled,
    stats.reseamed
      ? [`${stats.reseamed} faces straddled a seam and were re-sampled rather than copied`]
      : []));
}

/**
 * Turn the measurements into a claim, and no more than one.
 *
 * Nothing here reads a counter that was never written, and nothing here reads
 * a *geometric* fact as an attribute one. Coincident surfaces used to be
 * enough for "nothing was approximated"; they are now only enough to stop
 * geometry being the reason it is not.
 */
function grade(report: CarryReport, distances: number[]): void {
  const asked = report.attributes;
  if (!asked.length || asked.every((a) => a.outcome === 'failed')) {
    report.quality = 'failed';
    return;
  }
  // Anything asked for that did not fully arrive. A UV transfer that filled no
  // faces lands here even when weights and colours came across untouched.
  if (asked.some((a) => a.outcome === 'failed' || a.outcome === 'partial')) {
    report.quality = 'partial';
    return;
  }
  if (!distances.length) {
    report.quality = 'unmeasured';
    return;
  }
  const lossless = report.coincident && asked.every((a) => a.outcome === 'preserved');
  report.quality = lossless ? 'exact' : 'approximate';
}

/**
 * One line describing what a carry achieved, and how much to trust it.
 *
 * Every claim here is backed by something that was counted, and the geometry
 * and the attributes are reported as the separate things they are.
 */
export function describeCarry(report: CarryReport): string {
  if (!report.carried.length && report.attributes.every((a) => a.outcome === 'failed')) {
    return 'Nothing could be carried across: there was nothing stored against the old vertices, '
      + 'or no old surface to sample from.';
  }
  const what = `Carried your ${report.carried.join(', ')} onto the new shape by nearest surface point.`;
  const reach = (): string => {
    if (!report.total) return '';
    const pct = (d: number): number => Math.round((d / Math.max(report.span, 1e-6)) * 100);
    return ` Samples reached ${pct(report.median)}% of the shape's size typically and `
      + `${pct(report.worst)}% at most.`;
  };

  switch (report.quality) {
    case 'exact':
      return `${what} Every value was copied from the vertex it belonged to, so nothing was `
        + 'approximated.';
    case 'unmeasured':
      return `${what} How closely the two surfaces correspond was not measured, so check it.`;
    case 'partial': {
      const short = report.attributes.filter((a) => a.outcome === 'failed' || a.outcome === 'partial');
      const parts = short.map((a) => (a.delivered === 0
        ? `no ${a.name} could be transferred at all`
        : `${a.wanted - a.delivered} of ${a.wanted} did not receive ${a.name}`));
      const carried = report.carried.length
        ? `Carried your ${report.carried.join(', ')} across.`
        : 'Nothing could be carried across.';
      return `${carried} It is incomplete: ${parts.join('; ')}.${reach()} Worth checking.`;
    }
    default: {
      const why = report.attributes.flatMap((a) => a.lossy);
      const caveat = why.length ? ` Not a straight copy: ${unique(why).join('; ')}.` : '';
      if (report.uncertain === 0) {
        return `${what} Everything transferred.${caveat}${reach()}`;
      }
      return `${what} Everything transferred, but ${report.uncertain} of ${report.total} vertices `
        + `sat more than ${Math.round(FAR_FRACTION * 100)}% of the shape's size from the old `
        + `surface.${caveat}${reach()} Worth checking those areas.`;
    }
  }
}

/** The same reason said twice is one reason. */
function unique(list: string[]): string[] {
  return [...new Set(list)];
}

export { Vec3 };
