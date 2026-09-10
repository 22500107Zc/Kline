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
  // The two cubes occupy the same space — that is a fact about geometry, and
  // it is recorded as one.
  assert.equal(report.coincident, true, 'the same cube twice should coincide');
  assert.equal(report.worst, 0);
  // It is *not* on its own a reason to claim the coordinates came across
  // untouched: an unwrapped cube has seams, and a face whose corners straddle
  // one is re-sampled rather than copied.
  assert.equal(report.quality, 'approximate',
    'coincident geometry was taken as proof that nothing was approximated');
  const uv = report.attributes.find((a) => a.name === 'UV coordinates');
  assert.equal(uv.outcome, 'resampled');
  assert.ok(uv.lossy.length > 0, 'a re-sampled transfer reported no reason');
  assert.match(describeCarry(report), /Not a straight copy/);
  assert.doesNotMatch(describeCarry(report), /moved or resized as a whole/);
  assert.doesNotMatch(describeCarry(report), /nothing was approximated/);
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

// ----------------------------------- geometry is not attribute preservation

/**
 * A source with nothing about it that forces an approximation: one flat quad,
 * with a coordinate footprint small enough that the transfer takes each
 * corner's own value rather than re-deriving the face against a single source
 * triangle. A wide footprint trips the transfer's straddle test and genuinely
 * does change the corners — which is a real loss, and one this file checks for
 * separately.
 */
function seamless(): Mesh {
  const mesh = new Mesh();
  mesh.positions = [
    new Vec3(-1, -1, 0), new Vec3(1, -1, 0), new Vec3(1, 1, 0), new Vec3(-1, 1, 0),
  ];
  mesh.faces = [[0, 1, 2, 3]];
  mesh.faceMaterial = [0];
  mesh.setUV(0, [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3]);
  mesh.markDirty();
  return mesh;
}

test('a lossless path is the only thing allowed to claim exact preservation', () => {
  const from = seamless();
  const to = seamless();
  to.setUV(0, null);
  const report = carryAttributes(from, to);

  // Same surface, same vertices, one face, no seam to straddle, nothing to
  // blend and no influence to drop. This is what lossless looks like.
  assert.equal(report.coincident, true);
  assert.equal(report.quality, 'exact', 'a demonstrably lossless transfer was not called exact');
  const uv = report.attributes.find((a) => a.name === 'UV coordinates');
  assert.equal(uv.outcome, 'preserved');
  assert.deepEqual(uv.lossy, []);
  assert.match(describeCarry(report), /copied from the vertex it belonged to/);
  // And it really is what was there, corner for corner.
  const back = to.uvFor(0);
  assert.deepEqual([...back].map((n) => +n.toFixed(6)), [0.1, 0.1, 0.3, 0.1, 0.3, 0.3, 0.1, 0.3]);
});

test('a coincident surface with seams is not exact, and says which faces were re-sampled', () => {
  const from = mapped();
  const to = buildPrimitive('cube');
  const report = carryAttributes(from, to);

  assert.equal(report.coincident, true, 'the surfaces do coincide');
  assert.notEqual(report.quality, 'exact',
    'seam handling changed the coordinates and the report called it exact');
  const uv = report.attributes.find((a) => a.name === 'UV coordinates');
  assert.equal(uv.outcome, 'resampled');
  assert.match(uv.lossy.join(' '), /straddled a seam/);
});

test('coordinates that reach no faces are reported even when the weights arrive', () => {
  const from = mapped();
  from.skin = {
    bones: new Int32Array(from.vertCount * 4),
    weights: new Float32Array(from.vertCount * 4),
  };
  for (let v = 0; v < from.vertCount; v++) {
    from.skin.bones[v * 4] = 3;
    from.skin.weights[v * 4] = 1;
  }
  // A target made only of degenerate faces: nothing that can take coordinates.
  const to = buildPrimitive('cube');
  to.faces = to.faces.map(() => [0, 1]);
  to.faceMaterial = to.faces.map(() => 0);
  to.markDirty();

  const report = carryAttributes(from, to);

  assert.ok(report.carried.includes('skin weights'), 'the weights did not come across');
  assert.equal(report.uvFilled, 0, 'the fixture did transfer coordinates after all');
  const uv = report.attributes.find((a) => a.name === 'UV coordinates');
  assert.ok(uv, 'coordinates were asked for and no verdict was recorded');
  assert.equal(uv.outcome, 'failed',
    'a UV transfer that filled no faces was not reported as a failure');
  assert.equal(report.quality, 'partial',
    'a failed attribute was hidden by the ones that succeeded');
  assert.match(describeCarry(report), /no UV coordinates could be transferred at all/);
});

test('dropping a fifth influence is reported, not folded into a clean result', () => {
  // Every source vertex carries four influences; a target vertex sampled
  // between three of them pools up to twelve and can keep four.
  const from = seamless();
  from.skin = {
    bones: new Int32Array(from.vertCount * 4),
    weights: new Float32Array(from.vertCount * 4),
  };
  for (let v = 0; v < from.vertCount; v++) {
    for (let i = 0; i < 4; i++) {
      from.skin.bones[v * 4 + i] = v * 4 + i;      // every corner, different bones
      from.skin.weights[v * 4 + i] = 0.25;
    }
  }
  // A target whose vertices sit inside the source face rather than on its
  // corners, so each sample pools influences from three different corners.
  const to = new Mesh();
  to.positions = [
    new Vec3(-0.5, -0.5, 0), new Vec3(0.5, -0.5, 0), new Vec3(0.5, 0.5, 0), new Vec3(-0.5, 0.5, 0),
  ];
  to.faces = [[0, 1, 2, 3]];
  to.faceMaterial = [0];
  to.markDirty();

  const report = carryAttributes(from, to);
  const skin = report.attributes.find((a) => a.name === 'skin weights');
  assert.ok(skin, 'weights were asked for and no verdict was recorded');
  assert.equal(skin.delivered, to.vertCount, 'every vertex should have got weights');
  assert.notEqual(skin.outcome, 'preserved',
    'influences were discarded and the result was still called preserved');
  assert.equal(report.coincident, true, 'the target does lie on the source surface');
  assert.notEqual(report.quality, 'exact',
    'a transfer that discarded influences was called exact');
  assert.match(skin.lossy.join(' '), /influences|blended/);

  // Every kept vertex still sums to one, whatever was dropped.
  for (let v = 0; v < to.vertCount; v++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += to.skin.weights[v * 4 + i];
    assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${v} weights sum to ${sum}`);
  }
});

test('every attribute asked for gets a verdict, including on a total failure', () => {
  const from = mapped();
  from.colors = new Float32Array(from.vertCount * 3).fill(0.5);
  const report = carryAttributes(from, new Mesh());
  const names = report.attributes.map((a) => a.name).sort();
  assert.deepEqual(names, ['UV coordinates', 'vertex colours'],
    'an attribute was asked for and never accounted for');
  assert.ok(report.attributes.every((a) => a.outcome === 'failed'));
  assert.equal(report.quality, 'failed');
});

test('a subdivided coincident surface is resampled, not copied', () => {
  // One triangle, mapped into a small corner of the map so the transfer takes
  // the direct path and the seam fallback never runs — the case where the old
  // report had nothing left to object to.
  const from = new Mesh();
  from.positions = [new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 1, 0)];
  from.faces = [[0, 1, 2]];
  from.faceMaterial = [0];
  from.setUV(0, [0.1, 0.1, 0.3, 0.1, 0.1, 0.3]);
  from.markDirty();

  // The same triangle, subdivided about a new interior vertex. Every vertex
  // lies exactly on the source surface, so the geometry could not correspond
  // more closely — and the middle one is not a source vertex, so its
  // coordinates are a blend of three that are, not a copy of any.
  const to = new Mesh();
  to.positions = [
    new Vec3(0, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(1 / 3, 1 / 3, 0),
  ];
  to.faces = [[0, 1, 3], [1, 2, 3], [2, 0, 3]];
  to.faceMaterial = [0, 0, 0];
  to.markDirty();

  const report = carryAttributes(from, to);

  // The transfer works: every face gets coordinates.
  assert.equal(report.uvFilled, 3, 'the transfer did not cover the target');
  assert.equal(report.uvFaces, 3);
  assert.equal(report.coincident, true, 'the surfaces do occupy the same space');

  const uv = report.attributes.find((a) => a.name === 'UV coordinates');
  assert.ok(uv, 'coordinates were asked for and no verdict was recorded');
  assert.equal(uv.delivered, 3, 'coverage should be complete');
  assert.equal(uv.outcome, 'resampled',
    'an interpolated coordinate was reported as a preserved one');
  assert.ok(uv.lossy.length > 0, 'an interpolated transfer gave no reason');
  assert.match(uv.lossy.join(' '), /interpolat|between/i);

  assert.notEqual(report.quality, 'exact',
    'a transfer that interpolated new coordinates claimed exact preservation');
  const said = describeCarry(report);
  assert.doesNotMatch(said, /copied from the vertex it belonged to/);
  assert.doesNotMatch(said, /nothing was approximated/);

  // The interior vertex really did get a blended value: the centroid of the
  // three source coordinates, which is not any one of them.
  const face = to.uvFor(0);
  assert.ok(face, 'the first face got no coordinates');
  const middle = [face[4], face[5]];
  assert.ok(Math.abs(middle[0] - (0.1 + 0.3 + 0.1) / 3) < 1e-6, `u was ${middle[0]}`);
  assert.ok(Math.abs(middle[1] - (0.1 + 0.1 + 0.3) / 3) < 1e-6, `v was ${middle[1]}`);
});
