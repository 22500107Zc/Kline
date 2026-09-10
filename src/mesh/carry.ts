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

export interface CarryReport {
  /** What was actually moved across, by name. */
  carried: string[];
  /** Vertices whose nearest old surface point was further than `far`. */
  uncertain: number;
  /** Total vertices considered. */
  total: number;
  /** The furthest any sample had to reach, in world units. */
  worst: number;
  /** The size the reach is measured against. */
  span: number;
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
  const report: CarryReport = { carried: [], uncertain: 0, total: to.vertCount, worst: 0, span: 1 };
  const wantsSkin = !!from.skin && from.skin.bones.length >= from.vertCount * 4;
  const wantsColors = !!from.colors && from.colors.length >= from.vertCount * 3;
  const wantsMask = !!from.mask && from.mask.length >= from.vertCount;
  if (!wantsSkin && !wantsColors && !wantsMask) {
    // UVs have their own transfer, which understands seams; run it anyway so
    // one call carries everything that can be carried.
    return { ...report, carried: carryUV(from, to) };
  }

  const sampler = new SurfaceSampler(from);
  if (sampler.empty) return report;

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

  const bones = wantsSkin ? new Int32Array(to.vertCount * 4) : null;
  const weights = wantsSkin ? new Float32Array(to.vertCount * 4) : null;
  const colors = wantsColors ? new Float32Array(to.vertCount * 3).fill(1) : null;
  const mask = wantsMask ? new Float32Array(to.vertCount) : null;

  for (let v = 0; v < to.vertCount; v++) {
    const hit = sampler.closest(to.positions[v]);
    if (!hit) continue;
    const distance = Math.sqrt(hit.distSq);
    if (distance > far) report.uncertain++;
    if (distance > report.worst) report.worst = distance;

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
  report.carried.push(...carryUV(from, to));
  to.markDirty();
  return report;
}

/** UVs, through the transfer that already knows about seams. */
function carryUV(from: Mesh, to: Mesh): string[] {
  if (!from.hasUV) return [];
  const moved = transferUV(from, to, false);
  return moved > 0 ? ['UV coordinates'] : [];
}

/** One line describing what a carry achieved, and how much to trust it. */
export function describeCarry(report: CarryReport): string {
  if (!report.carried.length) return 'There was nothing stored against the old vertices to carry.';
  const what = `Carried your ${report.carried.join(', ')} onto the new shape by nearest surface point.`;
  if (report.uncertain === 0) return `${what} Every vertex found a close match on the old shape.`;
  // All of them being far apart is one situation — the shape moved or resized
  // as a whole, and the mapping is a broad one — and a handful being far apart
  // is a different one, where particular areas are worth looking at. Reporting
  // both the same way makes the first sound like a failure and buries the
  // second.
  const percent = Math.round((report.worst / Math.max(report.span, 1e-6)) * 100);
  if (report.uncertain === report.total) {
    return `${what} The shape moved or resized as a whole (by up to ${percent}% of its size), `
      + 'so this is a broad match rather than a close one — worth a look over.';
  }
  return `${what} ${report.uncertain} of ${report.total} vertices had no close match, `
    + 'so check those areas.';
}

export { Vec3 };
