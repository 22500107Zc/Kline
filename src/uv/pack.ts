/**
 * Rectangle packing for UV islands.
 *
 * Shelf packing — lay islands in rows as tall as their tallest member — is
 * easy and wasteful: every row is padded up to its tallest island, and a model
 * with one long thin strip and a hundred small pieces spends most of the
 * texture on air. Since texture memory is the budget everyone is actually
 * fighting, the extra work here pays for itself.
 *
 * This is MaxRects: keep the set of maximal empty rectangles, place each item
 * in the free rectangle that wraps it most tightly, then split whatever it
 * overlapped. It is the best of the classic heuristics by a clear margin, and
 * the cost — a list of rectangles to prune per placement — is nothing against
 * an unwrap of a few hundred islands.
 */

export interface PackItem {
  width: number;
  height: number;
  /** Whatever the caller needs to identify this item afterwards. */
  id: number;
}

export interface Placement {
  id: number;
  x: number;
  y: number;
  /** True when the item was turned a quarter turn to fit. */
  rotated: boolean;
}

export interface PackResult {
  placements: Placement[];
  /** The extent actually used, which is what the caller scales by. */
  width: number;
  height: number;
  /** Fraction of that extent covered by items. */
  occupancy: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Place items into a bin of the given width, growing downward as needed.
 *
 * Returns null when an item is wider than the bin and cannot be turned to fit,
 * which the caller answers by trying a wider bin rather than by failing.
 */
function packInto(items: PackItem[], binWidth: number, allowRotate: boolean): PackResult | null {
  const free: Rect[] = [{ x: 0, y: 0, w: binWidth, h: Number.MAX_SAFE_INTEGER / 4 }];
  const placements: Placement[] = [];
  let usedW = 0;
  let usedH = 0;
  let area = 0;

  for (const item of items) {
    let best: { rect: number; x: number; y: number; rotated: boolean; fit: number; second: number } | null = null;
    for (let i = 0; i < free.length; i++) {
      const r = free[i];
      for (const rotated of allowRotate ? [false, true] : [false]) {
        const w = rotated ? item.height : item.width;
        const h = rotated ? item.width : item.height;
        if (w > r.w + 1e-12 || h > r.h + 1e-12) continue;
        // Best short side fit: the leftover on the tighter axis. Choosing by
        // this rather than by area is what keeps long thin islands from
        // carving a wide rectangle into two useless slivers.
        const leftoverW = r.w - w;
        const leftoverH = r.h - h;
        const fit = Math.min(leftoverW, leftoverH);
        const second = Math.max(leftoverW, leftoverH);
        if (!best || fit < best.fit - 1e-12 || (Math.abs(fit - best.fit) < 1e-12 && second < best.second)) {
          best = { rect: i, x: r.x, y: r.y, rotated, fit, second };
        }
      }
    }
    if (!best) return null;

    const w = best.rotated ? item.height : item.width;
    const h = best.rotated ? item.width : item.height;
    const placed: Rect = { x: best.x, y: best.y, w, h };
    placements.push({ id: item.id, x: best.x, y: best.y, rotated: best.rotated });
    usedW = Math.max(usedW, best.x + w);
    usedH = Math.max(usedH, best.y + h);
    area += w * h;

    // Split every free rectangle the placement overlapped, then drop any that
    // is wholly inside another — that pruning is what keeps the list maximal
    // and stops it growing without bound.
    for (let i = free.length - 1; i >= 0; i--) {
      const split = splitRect(free[i], placed);
      if (split) {
        free.splice(i, 1, ...split);
      }
    }
    pruneContained(free);
  }

  const extent = Math.max(usedW, usedH);
  return {
    placements,
    width: usedW,
    height: usedH,
    occupancy: extent > 0 ? area / (extent * extent) : 0,
  };
}

/**
 * The parts of `r` left over once `cut` is removed from it, or null when they
 * do not overlap.
 *
 * Up to four pieces, one per side. They overlap each other, which is the point:
 * keeping every maximal rectangle is what lets a later item find the largest
 * space available rather than a fragment of it.
 */
function splitRect(r: Rect, cut: Rect): Rect[] | null {
  if (cut.x >= r.x + r.w || cut.x + cut.w <= r.x || cut.y >= r.y + r.h || cut.y + cut.h <= r.y) {
    return null;
  }
  const out: Rect[] = [];
  if (cut.x > r.x) out.push({ x: r.x, y: r.y, w: cut.x - r.x, h: r.h });
  if (cut.x + cut.w < r.x + r.w) {
    out.push({ x: cut.x + cut.w, y: r.y, w: r.x + r.w - (cut.x + cut.w), h: r.h });
  }
  if (cut.y > r.y) out.push({ x: r.x, y: r.y, w: r.w, h: cut.y - r.y });
  if (cut.y + cut.h < r.y + r.h) {
    out.push({ x: r.x, y: cut.y + cut.h, w: r.w, h: r.y + r.h - (cut.y + cut.h) });
  }
  return out.filter((s) => s.w > 1e-9 && s.h > 1e-9);
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - 1e-12
    && inner.y >= outer.y - 1e-12
    && inner.x + inner.w <= outer.x + outer.w + 1e-12
    && inner.y + inner.h <= outer.y + outer.h + 1e-12;
}

function pruneContained(free: Rect[]): void {
  for (let i = free.length - 1; i >= 0; i--) {
    for (let j = free.length - 1; j >= 0; j--) {
      if (i === j) continue;
      if (contains(free[j], free[i])) {
        free.splice(i, 1);
        break;
      }
    }
  }
}

/**
 * Pack items into as small a square as they will go.
 *
 * The bin width is the one parameter that matters and there is no way to
 * choose it up front — a width that suits one set of islands wastes half the
 * texture for another. Trying a spread and keeping the tightest costs a few
 * milliseconds and routinely gains ten to twenty per cent.
 */
export function packRects(items: PackItem[], allowRotate = true): PackResult {
  if (items.length === 0) return { placements: [], width: 0, height: 0, occupancy: 0 };

  // No single ordering wins. Placing the biggest awkward pieces first is right
  // most of the time, but a set of long thin strips packs better sorted by
  // height, and a set of similar squares better by area — and which one you
  // have is exactly what a heuristic cannot tell in advance. Trying all four
  // costs milliseconds and removes the guess.
  const orders: ((a: PackItem, b: PackItem) => number)[] = [
    (a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height),
    (a, b) => b.width * b.height - a.width * a.height,
    (a, b) => b.height - a.height,
    (a, b) => b.width - a.width,
  ];

  const totalArea = items.reduce((s, i) => s + i.width * i.height, 0);
  const widest = Math.max(...items.map((i) => (allowRotate ? Math.min(i.width, i.height) : i.width)));
  const ideal = Math.sqrt(Math.max(totalArea, 1e-12));

  let best: PackResult | null = null;
  let bestExtent = Infinity;
  for (const order of orders) {
    const sorted = [...items].sort(order);
    for (const mult of [0.8, 0.9, 1, 1.1, 1.25, 1.45, 1.7, 2.1]) {
      const binWidth = Math.max(widest, ideal * mult);
      const result = packInto(sorted, binWidth, allowRotate);
      if (!result) continue;
      // Islands are fitted into a square, so what matters is the longer side.
      const extent = Math.max(result.width, result.height);
      if (extent < bestExtent - 1e-9) {
        bestExtent = extent;
        best = result;
      }
    }
  }
  // Every width failed, which can only mean a single item taller than the bin
  // could ever be; fall back to a bin that certainly fits it.
  return best ?? packInto([...items], Math.max(widest, ideal) * 4, allowRotate) ?? {
    placements: items.map((i, n) => ({ id: i.id, x: 0, y: n, rotated: false })),
    width: 1,
    height: items.length,
    occupancy: 0,
  };
}
