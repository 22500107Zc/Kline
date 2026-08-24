import test from 'node:test';
import assert from 'node:assert/strict';
import { PackItem, packRects } from '../src/uv/pack';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { unwrap } from '../src/uv/unwrap';
import { Mesh } from '../src/mesh/Mesh';

/** Do any two placements overlap? Nothing else about a packer matters if they do. */
function overlaps(items: PackItem[], result: ReturnType<typeof packRects>): boolean {
  const byId = new Map(items.map((i) => [i.id, i]));
  const boxes = result.placements.map((p) => {
    const it = byId.get(p.id)!;
    return {
      x: p.x, y: p.y,
      w: p.rotated ? it.height : it.width,
      h: p.rotated ? it.width : it.height,
    };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const gapX = a.x + a.w <= b.x + 1e-9 || b.x + b.w <= a.x + 1e-9;
      const gapY = a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9;
      if (!gapX && !gapY) return true;
    }
  }
  return false;
}

function squares(n: number, size = 1): PackItem[] {
  return Array.from({ length: n }, (_, id) => ({ id, width: size, height: size }));
}

test('nothing overlaps, whatever the shapes', () => {
  const cases: PackItem[][] = [
    squares(16),
    Array.from({ length: 20 }, (_, id) => ({ id, width: 1 + (id % 5), height: 1 + ((id * 7) % 3) })),
    Array.from({ length: 12 }, (_, id) => ({ id, width: 10, height: 0.3 })),
    [{ id: 0, width: 3, height: 1 }, { id: 1, width: 1, height: 3 }, { id: 2, width: 2, height: 2 }],
  ];
  for (const items of cases) {
    const r = packRects(items);
    assert.equal(r.placements.length, items.length, 'an item was dropped');
    assert.ok(!overlaps(items, r), 'two items overlap');
  }
});

test('sixteen unit squares pack into a four-by-four with nothing wasted', () => {
  const r = packRects(squares(16));
  assert.ok(Math.max(r.width, r.height) <= 4 + 1e-6, `used ${r.width}x${r.height}`);
  assert.ok(r.occupancy > 0.99, `occupancy ${r.occupancy.toFixed(3)}`);
});

test('a single item takes exactly its own space', () => {
  const r = packRects([{ id: 0, width: 3, height: 7 }]);
  assert.equal(r.placements.length, 1);
  assert.equal(r.placements[0].x, 0);
  assert.equal(r.placements[0].y, 0);
  assert.equal(Math.max(r.width, r.height), 7);
});

test('nothing to pack is not an error', () => {
  const r = packRects([]);
  assert.deepEqual(r.placements, []);
  assert.equal(r.width, 0);
});

test('rotation is used when it helps', () => {
  // Three tall strips and a wide one. Turning the wide one lets them share a
  // square instead of forcing the bin as wide as the strip is long.
  const items: PackItem[] = [
    { id: 0, width: 1, height: 6 }, { id: 1, width: 1, height: 6 },
    { id: 2, width: 1, height: 6 }, { id: 3, width: 6, height: 1 },
  ];
  const withRotation = packRects(items, true);
  const without = packRects(items, false);
  assert.ok(!overlaps(items, withRotation));
  assert.ok(
    Math.max(withRotation.width, withRotation.height) <= Math.max(without.width, without.height) + 1e-9,
    'allowing rotation should never make the result worse',
  );
  assert.ok(withRotation.placements.some((p) => p.rotated), 'nothing was rotated');
});

test('the packer beats laying everything out in a row', () => {
  const items = Array.from({ length: 30 }, (_, id) => ({
    id, width: 1 + (id % 4) * 0.5, height: 1 + ((id * 3) % 5) * 0.4,
  }));
  const r = packRects(items);
  const rowExtent = items.reduce((s, i) => s + i.width, 0);
  assert.ok(Math.max(r.width, r.height) < rowExtent * 0.4, 'no better than a single row');
  assert.ok(r.occupancy > 0.6, `occupancy came out ${r.occupancy.toFixed(3)}`);
});

// ----------------------------------------------------------- through unwrap

/** Total UV area the layout covers, as a fraction of the unit square. */
function coverage(m: Mesh): number {
  let area = 0;
  for (let f = 0; f < m.faceCount; f++) {
    const uv = m.uvFor(f);
    if (!uv) continue;
    let s = 0;
    for (let i = 0; i < uv.length; i += 2) {
      const j = (i + 2) % uv.length;
      s += uv[i] * uv[j + 1] - uv[j] * uv[i + 1];
    }
    area += Math.abs(s) / 2;
  }
  return area;
}

test('an unwrap uses a fair share of the texture', () => {
  // Packing perfectly is impossible with irregular islands, but leaving three
  // quarters of the texture empty means the packer is not doing its job.
  for (const name of ['cube', 'uvsphere', 'cylinder'] as const) {
    const m = buildPrimitive(name);
    unwrap(m, { useSeams: false, angleLimit: 66, margin: 0.01 });
    const c = coverage(m);
    assert.ok(c > 0.35, `${name} only covered ${(c * 100).toFixed(1)}% of the texture`);
    assert.ok(c <= 1.01, `${name} covered ${(c * 100).toFixed(1)}%, which is more than there is`);
  }
});

test('every island lands inside the unit square', () => {
  const m = catmullClark(buildPrimitive('uvsphere'), 1);
  unwrap(m, { useSeams: false, angleLimit: 66, margin: 0.01 });
  for (let f = 0; f < m.faceCount; f++) {
    const uv = m.uvFor(f);
    if (!uv) continue;
    for (const c of uv) assert.ok(c >= -1e-6 && c <= 1 + 1e-6, `coordinate ${c} is outside the texture`);
  }
});

test('islands do not sit on top of each other', () => {
  // Sample the layout on a grid and count how often two different faces from
  // different islands claim the same spot. Overlap means one paints over the
  // other, which no amount of texture resolution fixes.
  const m = buildPrimitive('cube');
  unwrap(m, { useSeams: false, angleLimit: 66, margin: 0.02 });
  const grid = 64;
  const owner = new Int32Array(grid * grid).fill(-1);
  let clashes = 0;
  for (let f = 0; f < m.faceCount; f++) {
    const uv = m.uvFor(f);
    if (!uv) continue;
    let minU = 1; let maxU = 0; let minV = 1; let maxV = 0;
    for (let i = 0; i < uv.length; i += 2) {
      minU = Math.min(minU, uv[i]); maxU = Math.max(maxU, uv[i]);
      minV = Math.min(minV, uv[i + 1]); maxV = Math.max(maxV, uv[i + 1]);
    }
    // Sample strictly inside the island's box, so a shared border does not
    // count as an overlap.
    for (let y = Math.ceil(minV * grid) + 1; y < Math.floor(maxV * grid); y++) {
      for (let x = Math.ceil(minU * grid) + 1; x < Math.floor(maxU * grid); x++) {
        const i = y * grid + x;
        if (owner[i] >= 0 && owner[i] !== f) clashes++;
        owner[i] = f;
      }
    }
  }
  assert.equal(clashes, 0, `${clashes} texels are claimed by two islands`);
});
