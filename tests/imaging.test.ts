import test from 'node:test';
import assert from 'node:assert/strict';
import { Bitmap, maskFromBitmap, signedArea, simplifyLoop, splitComponents, suggestMaskOptions, traceContours } from '../src/imaging/contour';
import { HINT_BACKGROUND, HINT_SUBJECT } from '../src/imaging/segment';
import { triangulatePolygon } from '../src/imaging/triangulate';
import { meshFromHeightfield, meshFromLathe, meshFromSilhouette } from '../src/imaging/generate';
import { decodeDepth, encodeDepth } from '../src/imaging/neuralDepth';
import { meshFromDepth } from '../src/imaging/sceneDepth';

/** A plain 64x48 bitmap, for the depth surface to be built over. */
function bitmap64(): Bitmap {
  return bitmap(64, 48, (x, y) => (x + y) % 3 !== 0);
}
import { Mesh } from '../src/mesh/Mesh';

/** Build a test bitmap from a paint callback: return true where the subject is. */
function bitmap(width: number, height: number, inside: (x: number, y: number) => boolean): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const v = inside(x, y) ? 255 : 0;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number) =>
  (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function isClosed(m: Mesh): boolean {
  return m.faceCount > 0 && m.topology().edges.every((e) => e.faces.length === 2);
}

function volume(m: Mesh): number {
  let v = 0;
  for (const loop of m.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      v += m.positions[loop[0]].dot(m.positions[loop[i]].cross(m.positions[loop[i + 1]])) / 6;
    }
  }
  return v;
}

test('thresholding picks alpha for cut-outs and brightness otherwise', () => {
  const opaque = bitmap(16, 16, () => true);
  assert.equal(suggestMaskOptions(opaque).channel, 'luma');

  const cutout = bitmap(16, 16, () => true);
  for (let i = 0; i < 16 * 16; i++) if (i % 2) cutout.data[i * 4 + 3] = 0;
  assert.equal(suggestMaskOptions(cutout).channel, 'alpha');
});

test('a dark subject on a light background is detected and inverted', () => {
  const b = bitmap(32, 32, (x, y) => !disc(16, 16, 8)(x, y));
  const options = suggestMaskOptions(b);
  assert.equal(options.invert, true);
  const mask = maskFromBitmap(b, options);
  // Inverted, "inside" is the dark disc.
  assert.ok(mask.data[16 * 32 + 16] === 1);
  assert.ok(mask.data[0] === 0);
});

test('tracing a square yields one counter-clockwise loop of the right size', () => {
  const b = bitmap(40, 40, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30);
  const loops = traceContours(maskFromBitmap(b));
  assert.equal(loops.length, 1);
  assert.equal(loops[0].hole, false);
  // The contour runs half a pixel outside the pixels, so a 20px square is 20x20.
  assert.ok(Math.abs(Math.abs(loops[0].area) - 400) < 45, `area ${loops[0].area}`);
});

test('tracing a ring yields an outer loop and a hole', () => {
  const b = bitmap(64, 64, (x, y) => disc(32, 32, 24)(x, y) && !disc(32, 32, 12)(x, y));
  const loops = traceContours(maskFromBitmap(b));
  assert.equal(loops.length, 2);
  assert.equal(loops[0].hole, false, 'largest loop is the outer boundary');
  assert.equal(loops[1].hole, true, 'the inner loop is a hole');
  assert.ok(Math.abs(loops[0].area) > Math.abs(loops[1].area));
});

test('separate blobs are split into components, largest first', () => {
  const b = bitmap(64, 32, (x, y) => disc(12, 16, 9)(x, y) || disc(46, 16, 5)(x, y));
  const parts = splitComponents(maskFromBitmap(b));
  assert.equal(parts.length, 2);
  const count = (m: (typeof parts)[0]) => m.data.reduce((a, v) => a + v, 0);
  assert.ok(count(parts[0]) > count(parts[1]));
});

test('simplification keeps the shape but drops redundant points', () => {
  const b = bitmap(80, 80, disc(40, 40, 30));
  const loop = traceContours(maskFromBitmap(b))[0];
  const simplified = simplifyLoop(loop.points, 1.5);
  assert.ok(simplified.length < loop.points.length / 2, 'meaningfully fewer points');
  assert.ok(simplified.length >= 8, 'still a circle');
  const ratio = Math.abs(signedArea(simplified)) / Math.abs(loop.area);
  assert.ok(ratio > 0.95 && ratio < 1.05, `area drift ${ratio}`);
});

test('triangulating a convex polygon covers it exactly', () => {
  const square: [number, number][] = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const { indices, vertices } = triangulatePolygon(square);
  assert.equal(indices.length, 6, 'two triangles');
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]];
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  assert.ok(Math.abs(area - 16) < 1e-9);
});

test('triangulating a square with a square hole covers only the material', () => {
  const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const hole: [number, number][] = [[4, 4], [4, 6], [6, 6], [6, 4]];
  const { indices, vertices } = triangulatePolygon(outer, [hole]);
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]];
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  assert.ok(Math.abs(area - (100 - 4)) < 1e-6, `covered ${area}, expected 96`);
});

test('triangulating a concave polygon stays inside it', () => {
  // An L-shape: a fan from vertex 0 would spill outside the notch.
  const L: [number, number][] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
  const { indices, vertices } = triangulatePolygon(L);
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]];
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  assert.ok(Math.abs(area - 20) < 1e-9, `covered ${area}, expected 20`);
});

test('a silhouette extrudes into a closed, outward-facing solid', () => {
  const b = bitmap(64, 64, disc(32, 32, 24));
  const { mesh, stats } = meshFromSilhouette(b, { depth: 0.5, targetHeight: 2 });
  assert.ok(mesh.faceCount > 0);
  assert.ok(isClosed(mesh), 'watertight');
  assert.ok(volume(mesh) > 0, 'normals point outward');
  assert.ok(stats.loops >= 1);

  const size = mesh.bounds().size();
  assert.ok(Math.abs(size.z - 2) < 0.05, `height ${size.z}`);
  assert.ok(Math.abs(size.y - 0.5) < 1e-6, `depth ${size.y}`);
  assert.ok(Math.abs(size.x - 2) < 0.1, 'a disc is as wide as it is tall');
});

test('a silhouette with a hole keeps the hole', () => {
  const b = bitmap(72, 72, (x, y) => disc(36, 36, 28)(x, y) && !disc(36, 36, 14)(x, y));
  const { mesh } = meshFromSilhouette(b, { depth: 0.4 });
  assert.ok(isClosed(mesh), 'still watertight around the hole');
  const solid = meshFromSilhouette(bitmap(72, 72, disc(36, 36, 28)), { depth: 0.4 }).mesh;
  assert.ok(volume(mesh) < volume(solid) * 0.8, 'the hole removed material');
});

test('two blobs extrude into two separate shells', () => {
  const b = bitmap(96, 48, (x, y) => disc(24, 24, 14)(x, y) || disc(72, 24, 14)(x, y));
  const { mesh } = meshFromSilhouette(b, { depth: 0.3 });
  assert.ok(isClosed(mesh));
  assert.ok(volume(mesh) > 0);
  // Two disjoint shells: every vertex belongs to one of two connected groups.
  const t = mesh.topology();
  const seen = new Set<number>();
  let shells = 0;
  for (let v = 0; v < mesh.vertCount; v++) {
    if (seen.has(v)) continue;
    shells++;
    const stack = [v];
    seen.add(v);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const ei of t.vertEdges[cur] ?? []) {
        const e = t.edges[ei];
        const other = e.a === cur ? e.b : e.a;
        if (!seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
    }
  }
  assert.equal(shells, 2);
});

test('a cut-out wears the picture, and never reads the background', () => {
  // A red disc on a blue field: every coordinate the mesh carries has to land
  // on the disc, or the model gets a blue fringe all the way round.
  const width = 96;
  const height = 96;
  const data = new Uint8ClampedArray(width * height * 4);
  const solid = disc(48, 48, 30);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const on = solid(x, y);
      data[o] = on ? 230 : 20;
      data[o + 1] = 30;
      data[o + 2] = on ? 30 : 220;
      data[o + 3] = 255;
    }
  }
  const b: Bitmap = { width, height, data };
  const { mesh } = meshFromSilhouette(b, { depth: 0.4, mask: { channel: 'red', threshold: 0.5 } });
  assert.ok(mesh.hasUV, 'the cut-out carries texture coordinates');

  let checked = 0;
  let outside = 0;
  for (let f = 0; f < mesh.faces.length; f++) {
    const uv = mesh.uvFor(f);
    assert.ok(uv, `face ${f} has no coordinates`);
    for (let i = 0; i < uv!.length; i += 2) {
      const u = uv![i];
      const v = uv![i + 1];
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, `uv ${u},${v} off the picture`);
      // v is stored flipped, because the renderer uploads textures flipped.
      const px = Math.round(u * (width - 1));
      const py = Math.round((1 - v) * (height - 1));
      checked++;
      if (!solid(px, py)) outside++;
    }
  }
  assert.ok(checked > 100, `only ${checked} coordinates to check`);
  assert.equal(outside, 0, `${outside} of ${checked} coordinates read the background`);
});

test('the correction brush overrides the threshold in Cut Out', () => {
  // A mid-grey square that the threshold drops, and a bright one it keeps.
  const b = bitmap(64, 64, (x, y) => x >= 34 && x < 58 && y >= 20 && y < 44);
  for (let y = 20; y < 44; y++) {
    for (let x = 6; x < 30; x++) {
      const o = (y * 64 + x) * 4;
      b.data[o] = b.data[o + 1] = b.data[o + 2] = 90;
    }
  }
  const plain = meshFromSilhouette(b, { depth: 0.3, mask: { channel: 'luma', threshold: 0.5 } });
  assert.equal(plain.stats.loops, 1, 'the grey square is below the threshold');

  const hints = new Uint8Array(64 * 64);
  for (let y = 24; y < 40; y++) for (let x = 10; x < 26; x++) hints[y * 64 + x] = 1;
  const marked = meshFromSilhouette(b, {
    depth: 0.3, mask: { channel: 'luma', threshold: 0.5, hints },
  });
  assert.ok(marked.stats.loops >= 2, `marking it kept it: ${marked.stats.loops} loops`);
  assert.ok(marked.mesh.bounds().size().x > plain.mesh.bounds().size().x * 1.5,
    'the marked square is part of the model');

  // And the other way: marking the bright square as background drops it.
  const drop = new Uint8Array(64 * 64);
  for (let y = 20; y < 44; y++) for (let x = 34; x < 58; x++) drop[y * 64 + x] = 2;
  const dropped = meshFromSilhouette(b, {
    depth: 0.3, mask: { channel: 'luma', threshold: 0.5, hints: drop },
  });
  assert.equal(dropped.mesh.faceCount, 0, 'nothing is left to extrude');
});

test('the brush marks mean the same thing in both segmenters', () => {
  // contour.ts deliberately does not import from segment.ts, so the two
  // agree by test rather than by reference. If one of them ever moves, this
  // is what says so before a user paints green and watches it vanish.
  assert.equal(HINT_SUBJECT, 1);
  assert.equal(HINT_BACKGROUND, 2);
});

test('an empty image produces nothing rather than throwing', () => {
  const { mesh } = meshFromSilhouette(bitmap(32, 32, () => false));
  assert.equal(mesh.faceCount, 0);
});

test('a rectangle lathes into a closed cylinder of the right proportions', () => {
  const b = bitmap(64, 64, (x, y) => x >= 22 && x < 42 && y >= 12 && y < 52);
  const { mesh } = meshFromLathe(b, { segments: 24, targetHeight: 2 });
  assert.ok(isClosed(mesh), 'watertight');
  assert.ok(volume(mesh) > 0, 'outward normals');
  const size = mesh.bounds().size();
  assert.ok(Math.abs(size.z - 2) < 0.06, `height ${size.z}`);
  // A 20px-wide profile around its centre gives a radius of 10px over 40px tall.
  assert.ok(Math.abs(size.x - 1) < 0.12, `diameter ${size.x}`);
  assert.ok(Math.abs(size.x - size.y) < 1e-6, 'circular in plan');
});

test('a lathe profile that reaches the axis closes without a cap', () => {
  // A triangle standing on its base revolves into a cone.
  const b = bitmap(64, 64, (x, y) => {
    const halfWidth = ((y - 8) / 48) * 20;
    return y >= 8 && y < 56 && Math.abs(x - 32) <= halfWidth;
  });
  const { mesh } = meshFromLathe(b, { segments: 20 });
  assert.ok(isClosed(mesh));
  assert.ok(volume(mesh) > 0);
});

test('a heightfield displaces by brightness and can be made solid', () => {
  const gradient = bitmap(32, 32, () => true);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const o = (y * 32 + x) * 4;
      const v = Math.round((x / 31) * 255);
      gradient.data[o] = gradient.data[o + 1] = gradient.data[o + 2] = v;
    }
  }
  const open = meshFromHeightfield(gradient, { resolution: 32, size: 2, height: 0.5 }).mesh;
  assert.equal(open.faceCount, 31 * 31);
  const size = open.bounds().size();
  assert.ok(Math.abs(size.z - 0.5) < 1e-6, 'full displacement range');
  assert.ok(Math.abs(size.x - 2) < 1e-6);

  const solid = meshFromHeightfield(gradient, { resolution: 24, solid: true, height: 0.4 }).mesh;
  assert.ok(isClosed(solid), 'solid heightfields are watertight');
  assert.ok(volume(solid) > 0);
});

test('inverting a heightfield mirrors the displacement', () => {
  const b = bitmap(16, 16, (x) => x < 8);
  const normal = meshFromHeightfield(b, { resolution: 16, height: 1 }).mesh;
  const inverted = meshFromHeightfield(b, { resolution: 16, height: 1, invert: true }).mesh;
  const highSide = (m: Mesh): number => {
    let left = 0;
    let right = 0;
    for (const p of m.positions) (p.x < 0 ? (left += p.z) : (right += p.z));
    return left - right;
  };
  assert.ok(highSide(normal) > 0);
  assert.ok(highSide(inverted) < 0);
});

test('a depth reading survives the project file exactly enough to rebuild from', () => {
  // Storing it is what lets a scene built from a photograph be revised months
  // later, offline, on a machine that never downloaded the network.
  const width = 64;
  const height = 48;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = (x / (width - 1)) * 0.5 + (y / (height - 1)) * 0.5;
  }
  const encoded = encodeDepth({ width, height, data, ms: 12 });
  const back = decodeDepth(encoded)!;
  assert.ok(back, 'the depth reading did not survive');
  assert.equal(back.width, width);
  assert.equal(back.height, height);
  let worst = 0;
  for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(data[i] - back.data[i]));
  assert.ok(worst < 1 / 60000, `quantising lost ${worst}, which is more than 16 bits should`);

  // And the same settings over the stored reading build the same surface.
  const bitmap = bitmap64();
  const fresh = meshFromDepth(bitmap, { width, height, data, ms: 0 }, { resolution: 32 });
  const rebuilt = meshFromDepth(bitmap, back, { resolution: 32 });
  assert.equal(rebuilt.mesh.faceCount, fresh.mesh.faceCount,
    'rebuilding from the stored reading gave a different surface');

  assert.equal(decodeDepth('nonsense'), null);
  assert.equal(decodeDepth(null), null);
  assert.equal(decodeDepth('4x4:not-base-64!!'), null);
  assert.equal(decodeDepth(`${width}x${height + 1}:${encoded.split(':')[1]}`), null,
    'a reading whose size does not match must be refused, not reshaped');
});
