import test from 'node:test';
import assert from 'node:assert/strict';
import { SURFACE_LAYOUT, SURFACE_STRIDE, buildSurface } from '../src/render/MeshBuffers';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import { cubeProject } from '../src/uv/unwrap';
import { Mesh } from '../src/mesh/Mesh';
import { Vec3 } from '../src/core/math';

/** Expand an indexed buffer back into the corner stream it came from. */
function expand(s: ReturnType<typeof buildSurface>): number[][] {
  const out: number[][] = [];
  for (const i of s.indices) {
    out.push(Array.from(s.data.subarray(i * SURFACE_STRIDE, (i + 1) * SURFACE_STRIDE)));
  }
  return out;
}

test('the shared layout covers the whole vertex', () => {
  // The stride is derived from this, so a program that describes only the
  // attributes it reads would read every vertex from the wrong offset.
  const total = SURFACE_LAYOUT.reduce((n, a) => n + a.size, 0);
  assert.equal(total, SURFACE_STRIDE, 'the layout and the stride disagree');
});

test('the indexed buffer expands to exactly the corners it replaced', () => {
  for (const [name, sub, smooth] of [
    ['cube', 0, false], ['cube', 0, true], ['uvsphere', 0, true], ['torus', 1, false],
  ] as [string, number, boolean][]) {
    let m = buildPrimitive(name as 'cube');
    if (sub) m = catmullClark(m, sub);
    m.shadeSmooth = smooth;
    m.markDirty();
    cubeProject(m, 1);
    const s = buildSurface(m, null);
    const corners = expand(s);
    assert.equal(corners.length, m.triCount * 3, `${name}: wrong corner count`);

    // Rebuild the same stream directly and compare, value for value.
    const t = m.topology();
    let k = 0;
    for (let f = 0; f < m.faces.length; f++) {
      const loop = m.faces[f];
      if (loop.length < 3) continue;
      const fn = t.faceNormals[f];
      const uv = m.uvFor(f);
      for (let i = 1; i + 1 < loop.length; i++) {
        for (const c of [0, i, i + 1]) {
          const v = loop[c];
          const p = m.positions[v];
          const nrm = m.isFaceSmooth(f) ? t.vertNormals[v] : fn;
          const want = [
            p.x, p.y, p.z, nrm.x, nrm.y, nrm.z,
            uv ? uv[c * 2] : 0, uv ? uv[c * 2 + 1] : 0,
            0, m.faceMaterial[f] ?? 0, 1, 1, 1,
          ];
          const got = corners[k++];
          for (let j = 0; j < SURFACE_STRIDE; j++) {
            assert.ok(
              Math.abs(got[j] - Math.fround(want[j])) < 1e-6,
              `${name}: corner ${k - 1} component ${j} is ${got[j]}, wanted ${want[j]}`,
            );
          }
        }
      }
    }
  }
});

test('a smooth mesh collapses to about one vertex per mesh vertex', () => {
  const m = buildPrimitive('uvsphere');
  m.shadeSmooth = true;
  m.markDirty();
  const s = buildSurface(m, null);
  // Without UVs there is nothing to split a vertex on, so it should be exact.
  assert.equal(s.count, m.vertCount, `${s.count} vertices for ${m.vertCount} mesh vertices`);
  assert.ok(s.count < s.corners * 0.25, 'barely deduplicated');
});

test('flat shading keeps the corners that genuinely differ', () => {
  const m = buildPrimitive('cube');
  m.shadeSmooth = false;
  m.markDirty();
  const s = buildSurface(m, null);
  // Each corner of a cube belongs to three faces with three different normals.
  assert.equal(s.count, 24, `${s.count} vertices, wanted 24`);
  assert.equal(s.corners, 36);
});

test('a UV seam splits a vertex, as it must', () => {
  // Two triangles sharing an edge but giving that edge different coordinates.
  const m = new Mesh(
    [new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(1, 1, 0), new Vec3(0, 1, 0)],
    [[0, 1, 2], [0, 2, 3]],
  );
  m.shadeSmooth = true;
  m.setUV(0, [0, 0, 1, 0, 1, 1]);
  m.setUV(1, [0.5, 0.5, 0.9, 0.9, 0, 1]);
  m.markDirty();
  const s = buildSurface(m, null);
  // Vertices 0 and 2 carry two different coordinates, so they cannot merge.
  assert.equal(s.count, 6, `${s.count} vertices; 0 and 2 should each be split`);
});

test('a selected face does not drag its neighbours into the selection', () => {
  const m = buildPrimitive('cube');
  m.shadeSmooth = true;
  m.markDirty();
  const s = buildSurface(m, new Set([0]));
  const corners = expand(s);
  let flagged = 0;
  for (const c of corners) if (c[8] === 1) flagged++;
  // One quad, two triangles, three corners each.
  assert.equal(flagged, 6, `${flagged} corners marked selected, wanted 6`);
});

test('per-face materials survive deduplication', () => {
  const m = buildPrimitive('cube');
  m.shadeSmooth = true;
  m.faceMaterial = [0, 1, 2, 0, 1, 2];
  m.markDirty();
  const s = buildSurface(m, null);
  const corners = expand(s);
  let k = 0;
  for (let f = 0; f < m.faces.length; f++) {
    for (let i = 1; i + 1 < m.faces[f].length; i++) {
      for (let c = 0; c < 3; c++) {
        assert.equal(corners[k++][9], m.faceMaterial[f], `face ${f} lost its material`);
      }
    }
  }
});

test('vertex colours survive deduplication', () => {
  const m = buildPrimitive('cube');
  m.shadeSmooth = true;
  const c = m.ensureColors();
  for (let v = 0; v < m.vertCount; v++) c[v * 3] = v / m.vertCount;
  m.markDirty();
  const s = buildSurface(m, null);
  const corners = expand(s);
  let k = 0;
  for (const loop of m.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      for (const idx of [0, i, i + 1]) {
        assert.ok(
          Math.abs(corners[k++][10] - Math.fround(loop[idx] / m.vertCount)) < 1e-6,
          'a vertex colour was lost',
        );
      }
    }
  }
});

test('every index is in range', () => {
  const m = catmullClark(buildPrimitive('torus'), 1);
  const s = buildSurface(m, null);
  for (const i of s.indices) assert.ok(i >= 0 && i < s.count, `index ${i} outside 0..${s.count}`);
  assert.equal(s.indices.length % 3, 0, 'the index list is not whole triangles');
});

test('an empty mesh produces an empty buffer', () => {
  const s = buildSurface(new Mesh(), null);
  assert.equal(s.count, 0);
  assert.equal(s.indices.length, 0);
  assert.equal(s.corners, 0);
});

test('indexing saves most of the memory on a smooth mesh', () => {
  const m = catmullClark(buildPrimitive('uvsphere'), 1);
  m.shadeSmooth = true;
  m.markDirty();
  const s = buildSurface(m, null);
  const unindexed = s.corners * SURFACE_STRIDE * 4;
  const indexed = s.count * SURFACE_STRIDE * 4 + s.indices.length * 4;
  assert.ok(indexed < unindexed * 0.35, `${indexed} bytes against ${unindexed} unindexed`);
});
