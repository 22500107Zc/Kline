import { Vec3 } from '../core/math';
import { Mesh } from './Mesh';
import { SurfaceSampler } from '../uv/transfer';
import { transferUV } from '../uv/transfer';

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
 * How much of the result is actually known to be good.
 *
 *   - `exact`      every sample landed on the old surface, within rounding.
 *   - `approximate` everything transferred, but samples had to reach for it.
 *   - `partial`    some of the target got nothing, and is left at its default.
 *   - `failed`     nothing transferred.
 *   - `unmeasured` something transferred and correspondence was never measured.
 *
 * `unmeasured` exists because the alternative is worse. A UV-only carry used
 * to leave the distance counters at their initial zero and take the report
 * from them, so "no vertex was found to be far away" — which nothing had
 * looked for — was printed as "every vertex found a close match". A report
 * that says it did not check is honest; one that infers success from a
 * counter nobody incremented is not.
 */
export type CarryQuality = 'exact' | 'approximate' | 'partial' | 'failed' | 'unmeasured';

export interface CarryReport {
  /** What was actually moved across, by name. */
  carried: string[];
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
  /** What the evidence supports saying. */
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

/**
 * Move skin weights, vertex colours and the sculpt mask from one mesh onto
 * another with different topology.
 *
 * The target is mutated. Returns what was carried and how much of it should be
 * treated with suspicion.
 */
export function carryAttributes(from: Mesh, to: Mesh): CarryReport {
  const report: CarryReport = {
    carried: [], uncertain: 0, total: 0, targetVerts: to.vertCount, worst: 0, span: 1,
    median: 0, quality: 'failed', uvFilled: 0, uvFaces: 0,
  };
  const wantsSkin = !!from.skin && from.skin.bones.length >= from.vertCount * 4;
  const wantsColors = !!from.colors && from.colors.length >= from.vertCount * 3;
  const wantsMask = !!from.mask && from.mask.length >= from.vertCount;

  const sampler = new SurfaceSampler(from);
  if (sampler.empty) {
    // No surface to sample from at all. Nothing is carried and nothing is
    // claimed — not even a UV transfer, which needs the same triangles.
    return report;
  }

  // Measured against the larger of the two shapes. A part that doubles in size
  // puts every new vertex a long way from the old surface, and calling all of
  // them suspect on that basis says nothing useful about the transfer.
  const fromBox = from.bounds();
  const toBox = to.bounds();
  const spanOf = (b: ReturnType<Mesh['bounds']>): number =>
    (b.valid ? Math.max(b.size().x, b.size().y, b.size().z, 1e-6) : 1);
  const span = Math.max(spanOf(fromBox), spanOf(toBox));
  const far = span * FAR_FRACTION;
  report.span = span;

  // How far every target vertex sits from the old surface, measured whether or
  // not there is anything per-vertex to carry. This used to be skipped
  // entirely when only UVs were moving, and the untouched counters were then
  // read as evidence of a close match — the report was strongest exactly where
  // it knew least. Measuring is a nearest-point query per vertex, which is
  // what a UV transfer already does per face corner, so it costs about a third
  // as much again and buys a claim that is true.
  const distances = measure(sampler, to, far, report);

  const bones = wantsSkin ? new Int32Array(to.vertCount * 4) : null;
  const weights = wantsSkin ? new Float32Array(to.vertCount * 4) : null;
  const colors = wantsColors ? new Float32Array(to.vertCount * 3).fill(1) : null;
  const mask = wantsMask ? new Float32Array(to.vertCount) : null;

  for (let v = 0; v < to.vertCount && (bones || colors || mask); v++) {
    const hit = sampler.closest(to.positions[v]);
    if (!hit) continue;

    // Barycentric across the triangle the point landed on, so a weight varies
    // smoothly over a face instead of snapping to whichever corner won.
    const corners: [number, number][] = [
      [hit.tri.a, hit.u], [hit.tri.b, hit.v], [hit.tri.c, hit.w],
    ];

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

  if (bones && weights) {
    to.skin = { bones, weights };
    report.carried.push('skin weights');
  }
  if (colors) {
    to.colors = colors;
    report.carried.push('vertex colours');
  }
  if (mask) {
    to.mask = mask;
    report.carried.push('sculpt mask');
  }
  // UVs have their own transfer, which understands seams; it runs whether or
  // not there was anything per-vertex, so one call carries everything that can
  // be carried.
  carryUV(from, to, report);
  grade(report, distances, to.vertCount, !!(bones || colors || mask));
  if (report.carried.length) to.markDirty();
  return report;
}

/**
 * Every target vertex's distance to the old surface, sorted.
 *
 * Sorted because the worst sample alone is a poor summary: one vertex on a
 * spike reads the same as a shape that moved bodily, and those want different
 * words. The middle of this tells them apart.
 */
function measure(
  sampler: SurfaceSampler, to: Mesh, far: number, report: CarryReport,
): number[] {
  const distances: number[] = [];
  for (let v = 0; v < to.vertCount; v++) {
    const hit = sampler.closest(to.positions[v]);
    if (!hit) continue;
    const distance = Math.sqrt(hit.distSq);
    distances.push(distance);
    if (distance > far) report.uncertain++;
    if (distance > report.worst) report.worst = distance;
  }
  report.total = distances.length;
  distances.sort((a, b) => a - b);
  report.median = distances.length ? distances[distances.length >> 1] : 0;
  return distances;
}

/** UVs, through the transfer that already knows about seams. */
function carryUV(from: Mesh, to: Mesh, report: CarryReport): void {
  if (!from.hasUV) return;
  // Counted against the faces that could take coordinates at all: a face with
  // fewer than three corners is not a surface and is never a shortfall.
  report.uvFaces = to.faces.reduce((n, f) => n + (f.length >= 3 ? 1 : 0), 0);
  report.uvFilled = transferUV(from, to, false);
  if (report.uvFilled > 0) report.carried.push('UV coordinates');
}

/**
 * Turn the measurements into a claim, and no more than one.
 *
 * Nothing here reads a counter that was never written: `total` is the number
 * of vertices actually measured, and when it is zero the verdict is
 * `unmeasured` rather than a clean bill of health.
 */
function grade(
  report: CarryReport, distances: number[], vertCount: number, perVertex: boolean,
): void {
  if (!report.carried.length) {
    report.quality = 'failed';
    return;
  }
  // Something got nothing. A UV transfer that reached only part of the target
  // leaves the rest with whatever coordinates they had, which is usually none;
  // a vertex the sampler could not place keeps its default weight or colour.
  const uvShort = report.carried.includes('UV coordinates')
    && report.uvFaces > 0 && report.uvFilled < report.uvFaces;
  const vertsShort = perVertex && distances.length < vertCount;
  if (uvShort || vertsShort) {
    report.quality = 'partial';
    return;
  }
  if (!distances.length) {
    report.quality = 'unmeasured';
    return;
  }
  // "Exact" is reserved for a target that sits on the old surface to within
  // rounding — a rebuild that kept the shape and changed only the topology.
  // Anything else transferred in full but by approximation, and how far it had
  // to reach is reported rather than folded into the verdict: a distance is a
  // fact, and what caused it is not something this can see.
  report.quality = report.worst <= report.span * 1e-6 ? 'exact' : 'approximate';
}

/**
 * One line describing what a carry achieved, and how much to trust it.
 *
 * Every claim here is backed by something that was counted. The previous
 * version could reach "Every vertex found a close match on the old shape" from
 * a report where no vertex had been looked at, because a UV-only transfer
 * skipped the measuring pass and left `uncertain` at zero — and zero read as
 * "none were far away" rather than "none were checked". It also explained a
 * large distance by saying the shape had "moved or resized as a whole", which
 * is one possible cause of a large distance and not one this can distinguish
 * from a shape that changed. Distances are now reported as distances.
 */
export function describeCarry(report: CarryReport): string {
  if (!report.carried.length) {
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
      return `${what} Every vertex landed on the old surface, so nothing was approximated.`;
    case 'unmeasured':
      return `${what} How closely the two surfaces correspond was not measured, so check it.`;
    case 'partial': {
      const parts: string[] = [];
      if (report.uvFaces > report.uvFilled) {
        parts.push(`${report.uvFaces - report.uvFilled} of ${report.uvFaces} faces got no `
          + 'coordinates and kept what they had');
      }
      if (report.total < report.targetVerts) {
        parts.push(`${report.targetVerts - report.total} vertices could not be placed on the `
          + 'old surface at all');
      }
      return `${what} It is incomplete: ${parts.join('; ')}.${reach()} Worth checking.`;
    }
    default:
      if (report.uncertain === 0) {
        return `${what} Everything transferred.${reach()}`;
      }
      return `${what} Everything transferred, but ${report.uncertain} of ${report.total} vertices `
        + `sat more than ${Math.round(FAR_FRACTION * 100)}% of the shape's size from the old `
        + `surface.${reach()} Worth checking those areas.`;
  }
}

export { Vec3 };
