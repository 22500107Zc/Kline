import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from '../src/mesh/Mesh';
import { Vec3 } from '../src/core/math';
import { buildPrimitive } from '../src/mesh/primitives';
import { carryAttributes, describeCarry } from '../src/mesh/carry';
import { smartProject } from '../src/uv/unwrap';

/** A cube with coordinates on it, and nothing else stored per vertex. */
function mapped(): Mesh {
  const mesh = buildPrimitive('cube');
  smartProject(mesh);
  assert.equal(mesh.hasUV, true, 'the fixture has no coordinates to carry');
  return mesh;
}

/** Move every vertex of a mesh bodily. */
function shifted(mesh: Mesh, by: Vec3): Mesh {
  const copy = mesh.clone();
  for (let i = 0; i < copy.positions.length; i++) copy.positions[i] = copy.positions[i].add(by);
  copy.markDirty();
  return copy;
}

test('a UV-only carry reports what it measured, not what it assumed', () => {
  const from = mapped();
  const to = buildPrimitive('cube');
  const report = carryAttributes(from, to);

  assert.deepEqual(report.carried, ['UV coordinates']);
  // The old report reached "every vertex found a close match" from counters
  // that had never been written to, because the measuring pass was skipped
  // whenever there was nothing per-vertex to carry.
  assert.ok(report.total > 0, 'correspondence was never measured');
  assert.equal(report.total, to.vertCount, 'not every vertex was accounted for');
  assert.equal(report.quality, 'exact', 'the same cube twice should correspond exactly');
  assert.equal(report.worst, 0);
  assert.match(describeCarry(report), /landed on the old surface/);
  assert.doesNotMatch(describeCarry(report), /moved or resized as a whole/);
});

test('a UV carry between separated shapes says how far it had to reach', () => {
  const from = mapped();
  const to = shifted(buildPrimitive('cube'), new Vec3(40, 0, 0));
  const report = carryAttributes(from, to);

  assert.deepEqual(report.carried, ['UV coordinates']);
  assert.equal(report.total, to.vertCount);
  assert.ok(report.worst > 10, `nothing was measured: worst reach was ${report.worst}`);
  assert.ok(report.median > 10, 'the typical reach was not measured');
  assert.equal(report.uncertain, to.vertCount, 'a shape 40 units away should be all uncertain');
  assert.notEqual(report.quality, 'exact', 'a far-away match was graded as exact');

  const said = describeCarry(report);
  // A distance is a fact; what caused it is not something this can see.
  assert.doesNotMatch(said, /moved or resized as a whole/);
  assert.doesNotMatch(said, /Every vertex found a close match/);
  assert.match(said, /%/, 'the reach was not reported');
});

test('a source with no coordinates carries nothing and claims nothing', () => {
  const report = carryAttributes(buildPrimitive('cube'), buildPrimitive('cube'));
  assert.deepEqual(report.carried, []);
  assert.equal(report.quality, 'failed');
  assert.match(describeCarry(report), /Nothing could be carried/);
});

test('an empty source is reported as a failure, not as a clean transfer', () => {
  const empty = new Mesh();
  const report = carryAttributes(empty, buildPrimitive('cube'));
  assert.deepEqual(report.carried, []);
  assert.equal(report.total, 0);
  assert.equal(report.quality, 'failed');
  assert.doesNotMatch(describeCarry(report), /close match/);
});

test('an empty target is reported as a failure too', () => {
  const report = carryAttributes(mapped(), new Mesh());
  assert.equal(report.quality, 'failed');
  assert.equal(report.targetVerts, 0);
});

test('skin weights, colours, mask and coordinates carry together and are all named', () => {
  const from = mapped();
  from.skin = {
    bones: new Int32Array(from.vertCount * 4),
    weights: new Float32Array(from.vertCount * 4),
  };
  for (let v = 0; v < from.vertCount; v++) {
    from.skin.bones[v * 4] = 2;
    from.skin.weights[v * 4] = 1;
  }
  from.colors = new Float32Array(from.vertCount * 3).fill(0.25);
  from.mask = new Float32Array(from.vertCount).fill(0.5);

  const to = buildPrimitive('uvsphere');
  const report = carryAttributes(from, to);

  assert.deepEqual(
    [...report.carried].sort(),
    ['UV coordinates', 'sculpt mask', 'skin weights', 'vertex colours'],
  );
  assert.equal(to.skin?.bones.length, to.vertCount * 4, 'weights did not reach every vertex');
  assert.equal(to.colors?.length, to.vertCount * 3);
  assert.equal(to.mask?.length, to.vertCount);
  assert.equal(report.total, to.vertCount, 'not every vertex was measured');
  assert.ok(report.quality !== 'unmeasured', 'a measured transfer was reported as unmeasured');
  // Every vertex got a real bone, sampled from the old surface.
  assert.equal(to.skin!.bones[0], 2);
  assert.ok(to.mask![0] > 0.4 && to.mask![0] < 0.6);
});

test('a partly-mapped source is reported as partial rather than complete', () => {
  const from = mapped();
  // Strip the coordinates off half the faces: a source that can only answer
  // for part of the surface.
  for (let f = 0; f < from.faces.length; f += 2) from.setUV(f, null);
  const to = buildPrimitive('cube');
  const report = carryAttributes(from, to);

  if (report.uvFilled < report.uvFaces) {
    assert.equal(report.quality, 'partial', 'an incomplete transfer was graded as complete');
    assert.match(describeCarry(report), /incomplete/);
    assert.doesNotMatch(describeCarry(report), /Every vertex/);
  } else {
    // The sampler filled every face from the half that still had coordinates,
    // which is a complete transfer — and is allowed to say so.
    assert.equal(report.uvFilled, report.uvFaces);
    assert.notEqual(report.quality, 'partial');
  }
});

test('no report claims a close correspondence it did not measure', () => {
  const cases: Mesh[][] = [
    [mapped(), buildPrimitive('cube')],
    [mapped(), buildPrimitive('uvsphere')],
    [mapped(), shifted(buildPrimitive('cube'), new Vec3(0, 0, 25))],
    [new Mesh(), buildPrimitive('cube')],
    [buildPrimitive('cube'), buildPrimitive('cube')],
  ];
  for (const [from, to] of cases) {
    const report = carryAttributes(from, to);
    const said = describeCarry(report);
    if (/landed on the old surface|Everything transferred/.test(said)) {
      assert.ok(report.total > 0,
        `"${said}" was said about a transfer where nothing was measured`);
    }
    if (report.quality === 'unmeasured') {
      assert.match(said, /not measured/, 'an unmeasured transfer did not say so');
    }
  }
});
