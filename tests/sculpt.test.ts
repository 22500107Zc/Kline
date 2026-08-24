import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark, subdivideFaces } from '../src/mesh/ops';
import { SculptStroke, VertexGrid, brushFalloff, defaultSculpt } from '../src/sculpt/sculpt';
import { Vec3 } from '../src/core/math';
import { Mesh } from '../src/mesh/Mesh';
import { voxelRemesh, voxelSizeForTarget } from '../src/mesh/remesh';

test('the falloff runs from 1 at the centre to 0 at the rim', () => {
  assert.equal(brushFalloff(0), 1);
  assert.equal(brushFalloff(1), 0);
  assert.equal(brushFalloff(2), 0, 'outside the radius still clamps to zero');
  assert.ok(brushFalloff(0.5) > 0.3 && brushFalloff(0.5) < 0.6);
  // Monotonic, so a stroke never gets stronger further from the centre.
  for (let i = 1; i <= 10; i++) {
    assert.ok(brushFalloff(i / 10) <= brushFalloff((i - 1) / 10));
  }
});

test('the vertex grid finds exactly the points inside the radius', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const grid = new VertexGrid(sphere, 0.2);
  const centre = new Vec3(0, 0, 1);
  const found = new Set(grid.query(centre, 0.35));
  let expected = 0;
  for (let i = 0; i < sphere.vertCount; i++) {
    if (sphere.positions[i].distanceTo(centre) <= 0.35) {
      expected++;
      assert.ok(found.has(i), `missed vertex ${i}`);
    }
  }
  assert.equal(found.size, expected);
});

test('draw pushes the surface out along the brush normal', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = { ...defaultSculpt(), brush: 'draw' as const, strength: 1, autoSmooth: 0 };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const centre = new Vec3(0, 0, 1);
  const before = sphere.positions.map((p) => p.clone());
  const moved = stroke.dab(centre, new Vec3(0, 0, 1), 0.4, new Vec3());
  assert.ok(moved > 0);
  let lifted = 0;
  for (let i = 0; i < sphere.vertCount; i++) {
    const d = sphere.positions[i].z - before[i].z;
    if (Math.abs(d) > 1e-9) {
      assert.ok(d > 0, 'draw should only push outward');
      lifted++;
    }
  }
  // `moved` counts everything inside the radius; the outermost ring is
  // weighted so near zero that its displacement is below the epsilon.
  assert.ok(lifted > 0 && lifted <= moved);
});

test('inverting draw digs in instead', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = { ...defaultSculpt(), brush: 'draw' as const, strength: 1, invert: true, autoSmooth: 0 };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const top = sphere.positions.reduce((best, p, i) => (p.z > sphere.positions[best].z ? i : best), 0);
  const before = sphere.positions[top].z;
  stroke.dab(new Vec3(0, 0, 1), new Vec3(0, 0, 1), 0.5, new Vec3());
  assert.ok(sphere.positions[top].z < before);
});

test('a dab outside the mesh touches nothing', () => {
  const sphere = buildPrimitive('uvsphere');
  const stroke = new SculptStroke(sphere, defaultSculpt(), 0.3);
  assert.equal(stroke.dab(new Vec3(50, 50, 50), new Vec3(0, 0, 1), 0.3, new Vec3()), 0);
});

test('smooth pulls a spike back toward its neighbours', () => {
  const grid = buildPrimitive('grid');
  const spike = Math.floor(grid.vertCount / 2);
  grid.positions[spike] = grid.positions[spike].add(new Vec3(0, 0, 1));
  grid.markDirty();
  const settings = { ...defaultSculpt(), brush: 'smooth' as const, strength: 1, autoSmooth: 0 };
  const stroke = new SculptStroke(grid, settings, 0.4);
  const centre = grid.positions[spike].clone();
  stroke.dab(centre, new Vec3(0, 0, 1), 0.5, new Vec3());
  assert.ok(grid.positions[spike].z < 0.9, `spike stayed at ${grid.positions[spike].z}`);
});

test('grab drags the captured set and nothing else', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = { ...defaultSculpt(), brush: 'grab' as const, autoSmooth: 0 };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const centre = new Vec3(0, 0, 1);
  stroke.begin(centre, 0.4);
  const before = sphere.positions.map((p) => p.clone());
  stroke.dab(centre, new Vec3(0, 0, 1), 0.4, new Vec3(0.3, 0, 0));
  for (let i = 0; i < sphere.vertCount; i++) {
    const d = sphere.positions[i].sub(before[i]);
    if (d.lengthSq() < 1e-18) continue;
    assert.ok(Math.abs(d.y) < 1e-9 && Math.abs(d.z) < 1e-9, 'grab moved off its drag axis');
    assert.ok(d.x > 0 && d.x <= 0.3 + 1e-9);
  }
  // Repeating the same total delta is idempotent, not cumulative.
  const snapshot = sphere.positions.map((p) => p.clone());
  stroke.dab(centre, new Vec3(0, 0, 1), 0.4, new Vec3(0.3, 0, 0));
  for (let i = 0; i < sphere.vertCount; i++) {
    assert.ok(sphere.positions[i].distanceTo(snapshot[i]) < 1e-12);
  }
});

test('X symmetry mirrors the stroke', () => {
  const sphere = catmullClark(buildPrimitive('uvsphere'), 1);
  const settings = {
    ...defaultSculpt(), brush: 'draw' as const, strength: 1, autoSmooth: 0,
    symmetry: [true, false, false] as [boolean, boolean, boolean],
  };
  const stroke = new SculptStroke(sphere, settings, 0.4);
  const before = sphere.positions.map((p) => p.clone());
  stroke.dab(new Vec3(0.9, 0, 0), new Vec3(1, 0, 0), 0.5, new Vec3());
  let left = 0;
  let right = 0;
  for (let i = 0; i < sphere.vertCount; i++) {
    if (sphere.positions[i].distanceTo(before[i]) < 1e-9) continue;
    if (before[i].x > 0) right++;
    else left++;
  }
  assert.ok(right > 0 && left > 0, `symmetry only touched one side (${left}/${right})`);
});

// ------------------------------------------- spacing, masking and remeshing

test('a stroke is the same however fast it was drawn', () => {
  // The same path, reported as two long jumps or as many short ones. Without
  // spacing the fast version would lay down two dabs and the slow one twenty.
  const run = (steps: number): Mesh => {
    const m = buildPrimitive('grid');
    for (let i = 0; i < 3; i++) subdivideFaces(m, m.faces.map((_, f) => f));
    const s = { ...defaultSculpt(), brush: 'draw' as const, strength: 0.8, radius: 0.35, autoSmooth: 0 };
    const stroke = new SculptStroke(m, s, s.radius);
    const from = new Vec3(-0.6, 0, 0);
    const to = new Vec3(0.6, 0, 0);
    stroke.begin(from, s.radius);
    for (let i = 1; i <= steps; i++) {
      const at = from.lerp(to, i / steps);
      stroke.stroke(at, new Vec3(0, 0, 1), s.radius, new Vec3());
    }
    return m;
  };
  const fast = run(2);
  const slow = run(40);
  let worst = 0;
  for (let i = 0; i < fast.positions.length; i++) {
    worst = Math.max(worst, fast.positions[i].distanceTo(slow.positions[i]));
  }
  assert.ok(worst < 0.02, `the two strokes differ by up to ${worst.toFixed(4)}`);
  // And it actually did something.
  const raised = fast.positions.filter((p) => p.z > 0.01).length;
  assert.ok(raised > 5, `only ${raised} vertices moved`);
});

test('a masked vertex stays put', () => {
  const m = buildPrimitive('grid');
  for (let i = 0; i < 3; i++) subdivideFaces(m, m.faces.map((_, f) => f));
  // Mask the left half completely.
  const mask = m.ensureMask();
  for (let i = 0; i < m.positions.length; i++) mask[i] = m.positions[i].x < 0 ? 1 : 0;
  const before = m.positions.map((p) => p.clone());

  const s = { ...defaultSculpt(), brush: 'draw' as const, strength: 1, radius: 2, autoSmooth: 0 };
  const stroke = new SculptStroke(m, s, s.radius);
  stroke.begin(new Vec3(), s.radius);
  stroke.dab(new Vec3(), new Vec3(0, 0, 1), s.radius, new Vec3());

  let movedMasked = 0;
  let movedFree = 0;
  for (let i = 0; i < m.positions.length; i++) {
    const d = m.positions[i].distanceTo(before[i]);
    if (mask[i] >= 1) {
      if (d > 1e-9) movedMasked++;
    } else if (d > 1e-6) movedFree++;
  }
  assert.equal(movedMasked, 0, `${movedMasked} fully masked vertices moved anyway`);
  assert.ok(movedFree > 0, 'nothing outside the mask moved either');
});

test('the mask brush paints the mask, not the surface', () => {
  const m = buildPrimitive('grid');
  for (let i = 0; i < 2; i++) subdivideFaces(m, m.faces.map((_, f) => f));
  const before = m.positions.map((p) => p.clone());
  const s = { ...defaultSculpt(), brush: 'mask' as const, strength: 1, radius: 0.5 };
  const stroke = new SculptStroke(m, s, s.radius);
  stroke.begin(new Vec3(), s.radius);
  for (let i = 0; i < 4; i++) stroke.dab(new Vec3(), new Vec3(0, 0, 1), s.radius, new Vec3());

  for (let i = 0; i < m.positions.length; i++) {
    assert.ok(m.positions[i].distanceTo(before[i]) < 1e-12, 'the mask brush moved geometry');
  }
  assert.ok(m.mask, 'no mask was painted');
  const painted = [...m.mask!].filter((v) => v > 0.1).length;
  assert.ok(painted > 0, 'the mask is empty');
  // And only near the brush.
  for (let i = 0; i < m.positions.length; i++) {
    if (m.mask![i] > 0.1) assert.ok(m.positions[i].length() < 0.6);
  }
});

test('remeshing keeps the shape and evens out the topology', () => {
  const sphere = buildPrimitive('uvsphere');
  const before = volumeOfMesh(sphere);
  const out = voxelRemesh(sphere, { voxelSize: voxelSizeForTarget(sphere, 8000) });

  assert.ok(out.faceCount > 0, 'remesh produced nothing');
  assert.ok(out.topology().edges.every((e) => e.faces.length === 2), 'the remesh is not closed');
  const after = volumeOfMesh(out);
  assert.ok(
    Math.abs(after - before) / before < 0.05,
    `volume moved from ${before.toFixed(4)} to ${after.toFixed(4)}`,
  );

  // A uv-sphere crowds its poles; the remesh should not.
  const spread = (m: Mesh): number => {
    const lengths = m.topology().edges.map((e) => m.positions[e.a].distanceTo(m.positions[e.b]));
    lengths.sort((a, b) => a - b);
    return lengths[Math.floor(lengths.length * 0.95)] / Math.max(1e-9, lengths[Math.floor(lengths.length * 0.05)]);
  };
  assert.ok(
    spread(out) < spread(sphere),
    `edge lengths are no more even: ${spread(out).toFixed(2)} vs ${spread(sphere).toFixed(2)}`,
  );
});

test('remeshing a cube keeps its corners roughly where they were', () => {
  const cube = buildPrimitive('cube');
  const out = voxelRemesh(cube, { voxelSize: 0.06, smoothPasses: 1 });
  const b = out.bounds();
  // Voxelising rounds the corners a little; it must not move the sides.
  for (const v of [b.min.x, b.min.y, b.min.z]) assert.ok(Math.abs(v + 1) < 0.12, `min at ${v}`);
  for (const v of [b.max.x, b.max.y, b.max.z]) assert.ok(Math.abs(v - 1) < 0.12, `max at ${v}`);
  assert.ok(out.topology().edges.every((e) => e.faces.length === 2));
});

test('a target triangle count lands near the target', () => {
  const sphere = buildPrimitive('uvsphere');
  for (const target of [4000, 16000]) {
    const out = voxelRemesh(sphere, { voxelSize: voxelSizeForTarget(sphere, target) });
    const ratio = out.triCount / target;
    assert.ok(ratio > 0.4 && ratio < 2.5, `asked for ${target}, got ${out.triCount}`);
  }
});

function volumeOfMesh(m: Mesh): number {
  let v = 0;
  for (const loop of m.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      v += m.positions[loop[0]].dot(m.positions[loop[i]].cross(m.positions[loop[i + 1]])) / 6;
    }
  }
  return Math.abs(v);
}
