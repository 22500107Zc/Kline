import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrimitive } from '../src/mesh/primitives';
import { catmullClark } from '../src/mesh/ops';
import {
  cubeProject, cylinderProject, markSeams, planarProject, smartProject, sphereProject,
  stretchPerFace, unwrap, uvIslands,
} from '../src/uv/unwrap';
import { Mesh } from '../src/mesh/Mesh';

function uvBounds(m: Mesh): { min: number[]; max: number[]; mapped: number } {
  const min = [Infinity, Infinity];
  const max = [-Infinity, -Infinity];
  let mapped = 0;
  for (let f = 0; f < m.faceCount; f++) {
    const uv = m.uvFor(f);
    if (!uv) continue;
    mapped++;
    for (let i = 0; i < uv.length; i += 2) {
      min[0] = Math.min(min[0], uv[i]);
      max[0] = Math.max(max[0], uv[i]);
      min[1] = Math.min(min[1], uv[i + 1]);
      max[1] = Math.max(max[1], uv[i + 1]);
    }
  }
  return { min, max, mapped };
}

function medianStretch(m: Mesh): number {
  const s = stretchPerFace(m).filter((x) => x > 0).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

test('a cube unwraps into six flat islands inside the unit square', () => {
  const cube = buildPrimitive('cube');
  const islands = unwrap(cube, { angleLimit: 45 });
  assert.equal(islands, 6);
  const b = uvBounds(cube);
  assert.equal(b.mapped, 6);
  assert.ok(b.min[0] >= 0 && b.min[1] >= 0);
  assert.ok(b.max[0] <= 1 && b.max[1] <= 1);
  assert.ok(Math.abs(medianStretch(cube) - 1) < 1e-6, 'flat faces should not distort');
});

test('the angle limit cuts a sphere into usable islands instead of one', () => {
  const sphere = buildPrimitive('uvsphere');
  const islands = unwrap(sphere, { angleLimit: 66 });
  assert.ok(islands > 3, `expected several islands, got ${islands}`);
  assert.ok(medianStretch(sphere) > 0.85 && medianStretch(sphere) < 1.2);
});

test('conformal unwrapping beats a plain projection on a rounded shape', () => {
  const roundedA = catmullClark(buildPrimitive('cube'), 2);
  const roundedB = roundedA.clone();
  unwrap(roundedA, { angleLimit: 40 });
  smartProject(roundedB, 40, 0.01);
  const worst = (m: Mesh): number => {
    const s = stretchPerFace(m).filter((x) => x > 0).sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.95)] ?? 0;
  };
  assert.ok(worst(roundedA) <= worst(roundedB) + 1e-6);
  assert.ok(worst(roundedA) < 1.5, `95th-percentile stretch was ${worst(roundedA)}`);
});

test('seams cut islands where the user asks', () => {
  const cyl = buildPrimitive('cylinder');
  const t = cyl.topology();
  assert.equal(uvIslands(cyl, { useSeams: true }).length, 1);
  // Cut the top rim right round, which is what separates a cap from the wall.
  const rim = t.edges
    .map((_, i) => i)
    .filter((i) => cyl.positions[t.edges[i].a].z > 0.9 && cyl.positions[t.edges[i].b].z > 0.9);
  assert.ok(rim.length > 4);
  markSeams(cyl, rim, true);
  assert.equal(uvIslands(cyl, { useSeams: true }).length, 2);
  markSeams(cyl, rim, false);
  assert.equal(uvIslands(cyl, { useSeams: true }).length, 1, 'clearing a seam should heal the island');
});

test('seams survive a round trip through JSON', () => {
  const cube = buildPrimitive('cube');
  markSeams(cube, [0, 1], true);
  unwrap(cube, { useSeams: true });
  const copy = Mesh.fromJSON(JSON.parse(JSON.stringify(cube.toJSON())));
  assert.ok(copy.hasUV);
  assert.equal(copy.seams?.size, 2);
  assert.deepEqual(copy.uvFor(0), cube.uvFor(0));
});

test('coordinates are dropped when an operator reshapes the face', () => {
  const cube = buildPrimitive('cube');
  unwrap(cube);
  assert.ok(cube.uvFor(0));
  cube.faces[0] = [...cube.faces[0], cube.faces[1][0]];
  cube.markDirty();
  assert.equal(cube.uvFor(0), null, 'a face with a new corner count must lose its stale UVs');
  assert.ok(cube.uvFor(1), 'untouched faces keep theirs');
});

test('the projections cover every face', () => {
  for (const [name, project] of [
    ['cube', (m: Mesh) => cubeProject(m, 2)],
    ['cylinder', cylinderProject],
    ['sphere', sphereProject],
    ['planar', (m: Mesh) => planarProject(m, 2)],
  ] as [string, (m: Mesh) => void][]) {
    const mesh = buildPrimitive('cylinder');
    project(mesh);
    const b = uvBounds(mesh);
    assert.equal(b.mapped, mesh.faceCount, `${name} left faces unmapped`);
    assert.ok(Number.isFinite(b.min[0]) && Number.isFinite(b.max[1]));
  }
});

test('cylinder projection keeps each face contiguous across the wrap', () => {
  const cyl = buildPrimitive('cylinder');
  cylinderProject(cyl);
  for (let f = 0; f < cyl.faceCount; f++) {
    const uv = cyl.uvFor(f);
    // The caps genuinely wrap the whole circle; only the wall can stay narrow.
    if (!uv || cyl.faces[f].length !== 4) continue;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < uv.length; i += 2) {
      min = Math.min(min, uv[i]);
      max = Math.max(max, uv[i]);
    }
    // A face that straddled the seam would span most of the U range.
    assert.ok(max - min < 0.6, `face ${f} spans ${max - min} in U`);
  }
});
