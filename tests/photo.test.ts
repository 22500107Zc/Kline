import test from 'node:test';
import assert from 'node:assert/strict';
import { Bitmap } from '../src/imaging/contour';
import {
  HINT_BACKGROUND, HINT_SUBJECT, matteCoverage, matteToMask, segmentSubject,
} from '../src/imaging/segment';
import { depthFromPhoto, inflationField, symmetryAxis } from '../src/imaging/depth';
import { meshFromPhoto } from '../src/imaging/photo';
import { Mesh } from '../src/mesh/Mesh';
import { meshFromDepth } from '../src/imaging/sceneDepth';
import { patchAligned } from '../src/imaging/neuralDepth';

/**
 * Photograph to model.
 *
 * Every test here is written against the thing that made a photograph come
 * out looking like a sticker of itself: a mask decided by brightness, a
 * thickness decided by nothing, a surface with no texture on it, and a shell
 * that was never actually closed.
 */

type RGB = [number, number, number];

/** A blank frame of one colour. */
function frame(width: number, height: number, colour: RGB, alpha = 255): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = colour[0];
    data[i * 4 + 1] = colour[1];
    data[i * 4 + 2] = colour[2];
    data[i * 4 + 3] = alpha;
  }
  return { width, height, data };
}

function paint(bitmap: Bitmap, test: (x: number, y: number) => boolean, colour: RGB, alpha = 255): Bitmap {
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (!test(x, y)) continue;
      const o = (y * bitmap.width + x) * 4;
      bitmap.data[o] = colour[0];
      bitmap.data[o + 1] = colour[1];
      bitmap.data[o + 2] = colour[2];
      bitmap.data[o + 3] = alpha;
    }
  }
  return bitmap;
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number) =>
  (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const ellipse = (cx: number, cy: number, rx: number, ry: number) => (x: number, y: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/** How many faces use each undirected edge. */
function edgeUse(mesh: Mesh): Map<string, number> {
  const counts = new Map<string, number>();
  for (const loop of mesh.faces) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Signed volume of the mesh, by the divergence theorem over its triangles. */
function volume(mesh: Mesh): number {
  let total = 0;
  for (const loop of mesh.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      const a = mesh.positions[loop[0]];
      const b = mesh.positions[loop[i]];
      const c = mesh.positions[loop[i + 1]];
      total += a.dot(b.cross(c)) / 6;
    }
  }
  return total;
}

// ------------------------------------------------------------ segmentation

test('the subject is found by colour, not by being the brighter half', () => {
  // A mid-grey object on a mid-brown floor. Both sit near the middle of the
  // brightness range, so no threshold anywhere separates them — which is
  // exactly the photograph the old mask could not handle, and exactly the
  // kind of photograph people have.
  const bitmap = paint(frame(96, 96, [124, 96, 62]), disc(48, 48, 26), [118, 122, 130]);
  const matte = segmentSubject(bitmap);
  assert.equal(matte.data[48 * 96 + 48] > 0.5, true, 'the middle of the object read as background');
  assert.equal(matte.data[3 * 96 + 3] < 0.5, true, 'the corner of the frame read as subject');

  const coverage = matteCoverage(matte);
  const expected = (Math.PI * 26 * 26) / (96 * 96);
  assert.ok(
    Math.abs(coverage - expected) < 0.06,
    `the subject covered ${(coverage * 100).toFixed(1)}% of the frame, the disc covers ${(expected * 100).toFixed(1)}%`,
  );
});

test('a cut-out image is taken at its word', () => {
  const bitmap = frame(64, 64, [200, 30, 30], 0);
  paint(bitmap, disc(32, 32, 18), [200, 30, 30], 255);
  const matte = segmentSubject(bitmap);
  assert.equal(matte.data[32 * 64 + 32], 1);
  assert.equal(matte.data[0], 0);
});

test('specks elsewhere in the frame do not become their own little models', () => {
  const bitmap = paint(frame(96, 96, [30, 30, 34]), disc(48, 48, 24), [220, 200, 160]);
  paint(bitmap, disc(12, 84, 3), [220, 200, 160]);
  const matte = segmentSubject(bitmap);
  assert.ok(matte.data[48 * 96 + 48] > 0.5, 'the subject was lost');
  assert.ok(matte.data[84 * 96 + 12] < 0.5, 'a speck across the frame survived');
});

test('a dark detail inside the subject does not punch a hole through it', () => {
  // A buckle on a bag: background-coloured, but enclosed. Left alone it opens
  // a window clean through the finished model.
  const bitmap = paint(frame(96, 96, [24, 26, 30]), disc(48, 48, 30), [215, 205, 190]);
  paint(bitmap, disc(48, 48, 6), [24, 26, 30]);
  const matte = segmentSubject(bitmap);
  assert.ok(matte.data[48 * 96 + 48] > 0.5, 'the enclosed detail was left as a hole');

  const mask = matteToMask(matte);
  assert.equal(mask.data[48 * 96 + 48], 1);
});

test('a subject that fills the frame is the whole frame, not nothing', () => {
  // A close-up leaves no background band to learn from, and the models then
  // agree on everything. Rather than declaring the photograph empty — which
  // reads as the feature being broken — the whole frame becomes the subject
  // and the person can crop.
  assert.ok(matteCoverage(segmentSubject(frame(48, 48, [90, 140, 200]))) > 0.9);

  const closeUp = paint(frame(64, 64, [180, 120, 90]), (x, y) => x > 30, [176, 126, 96]);
  assert.ok(matteCoverage(segmentSubject(closeUp)) > 0.9);
});

// --------------------------------------------------------------- inflation

test('inflating a circle gives a hemisphere, not a cylinder', () => {
  const size = 128;
  const r = 40;
  const bitmap = paint(frame(size, size, [10, 10, 10]), disc(64, 64, r), [240, 240, 240]);
  const matte = segmentSubject(bitmap);
  const field = inflationField(matte);

  // The solution of the equation being solved is exactly sqrt(R^2 - d^2) over
  // a disc, so the middle should stand about R pixels proud.
  const centre = field[64 * size + 64];
  assert.ok(Math.abs(centre - r) < r * 0.15, `the middle of a ${r}px disc came out ${centre.toFixed(1)}px deep`);

  // Half way out it should be sqrt(R^2 - (R/2)^2) = 0.866 R, which is what
  // separates a dome from a flat-topped extrusion.
  const halfway = field[64 * size + (64 + Math.round(r / 2))];
  assert.ok(
    Math.abs(halfway - r * 0.866) < r * 0.2,
    `half way out a dome should be ${(r * 0.866).toFixed(1)}px, this was ${halfway.toFixed(1)}px`,
  );
  assert.ok(halfway < centre, 'the surface does not fall away from the middle at all');
});

test('a thin part comes out thin and a thick part comes out thick', () => {
  // This is the whole reason the depth comes from a Poisson solve rather than
  // a distance to the outline. Distance-to-outline makes a strap as deep as
  // the widest point of the body it hangs off, which is what an inflated
  // silhouette looks like and why it never passes for the real object.
  const w = 200;
  const h = 120;
  const bitmap = frame(w, h, [12, 12, 16]);
  paint(bitmap, (x, y) => x >= 20 && x < 100 && y >= 20 && y < 100, [230, 225, 220]);
  paint(bitmap, (x, y) => x >= 100 && x < 180 && y >= 52 && y < 68, [230, 225, 220]);
  const matte = segmentSubject(bitmap);
  const field = inflationField(matte);

  const body = field[60 * w + 60];
  const strap = field[60 * w + 150];
  assert.ok(body > 25, `the body should be about 40px deep, it was ${body.toFixed(1)}`);
  assert.ok(strap < 12, `the strap is 16px wide so should be under 8px deep, it was ${strap.toFixed(1)}`);
  assert.ok(body > strap * 3, `body ${body.toFixed(1)} vs strap ${strap.toFixed(1)} is not a real difference`);
});

test('shading adds surface relief without pushing through the back', () => {
  const size = 128;
  const bitmap = paint(frame(size, size, [8, 8, 10]), disc(64, 64, 44), [200, 200, 200]);
  // A dark crease across the middle of the object.
  paint(bitmap, (x, y) => disc(64, 64, 44)(x, y) && Math.abs(y - 64) < 3, [60, 60, 60]);
  const matte = segmentSubject(bitmap);

  const flat = depthFromPhoto(bitmap, matte, { detail: 0 });
  const detailed = depthFromPhoto(bitmap, matte, { detail: 1 });
  const at = (f: typeof flat, x: number, y: number) => f.data[y * size + x];

  assert.ok(at(detailed, 64, 64) < at(flat, 64, 64), 'the crease did not show up in the surface');
  for (let i = 0; i < detailed.data.length; i++) {
    assert.ok(detailed.data[i] >= 0, 'shading pushed the surface through itself');
    assert.ok(Number.isFinite(detailed.data[i]), 'the depth field went to NaN');
  }
});

test('the mirror line of a symmetric subject is found, and a lopsided one is not claimed', () => {
  const size = 120;
  const round = paint(frame(size, size, [20, 22, 26]), disc(52, 60, 30), [220, 210, 200]);
  const sym = symmetryAxis(segmentSubject(round));
  assert.ok(Math.abs(sym.axis - 52) < 3, `a disc at x=52 mirrors about ${sym.axis.toFixed(1)}`);
  assert.ok(sym.score > 0.9, `a disc should mirror almost perfectly, scored ${sym.score.toFixed(2)}`);

  // A shape with a limb on one side only. The best available mirror line
  // cannot overlap it with itself, and saying so is what stops the depth
  // being evened out across something that is genuinely lopsided.
  const lop = paint(frame(size, size, [20, 22, 26]), disc(52, 60, 26), [220, 210, 200]);
  paint(lop, (x, y) => x > 60 && x < 108 && Math.abs(y - 60) < 6, [220, 210, 200]);
  assert.ok(symmetryAxis(segmentSubject(lop)).score < 0.8, 'a one-sided shape was called symmetric');
});

test('shading lopsidedness is evened out on a symmetric subject only', () => {
  // A round object lit hard from the left: the shading term reads the lit side
  // as standing further out than the shadowed side, which is a lighting fact
  // rather than a fact about the object.
  const size = 128;
  const bitmap = frame(size, size, [16, 18, 22]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!disc(64, 64, 40)(x, y)) continue;
      const o = (y * size + x) * 4;
      const lit = 235 - (x - 24) * 1.4;
      bitmap.data[o] = lit;
      bitmap.data[o + 1] = lit * 0.94;
      bitmap.data[o + 2] = lit * 0.86;
    }
  }
  const matte = segmentSubject(bitmap);
  const at = (f: { data: Float32Array }, x: number, y: number) => f.data[y * size + x];
  const lean = (f: { data: Float32Array }) => at(f, 40, 64) - at(f, 88, 64);

  const raw = depthFromPhoto(bitmap, matte, { detail: 1, symmetry: 0, smoothing: 0 });
  const evened = depthFromPhoto(bitmap, matte, { detail: 1, symmetry: 1, smoothing: 0 });
  assert.ok(Math.abs(lean(raw)) > 0.05, 'the test image is not actually lopsided');
  assert.ok(
    Math.abs(lean(evened)) < Math.abs(lean(raw)) * 0.35,
    `evening left ${lean(evened).toFixed(3)} of lean against ${lean(raw).toFixed(3)}`,
  );
  // The outline is the reliable half of the picture and must not move.
  for (let i = 0; i < evened.data.length; i++) {
    assert.equal(evened.data[i] > 0, raw.data[i] > 0, 'evening the depth changed the silhouette');
  }
});

// -------------------------------------------------------------- the model

test('a photograph becomes a closed, textured, correctly sized model', () => {
  // Taller than it is wide, so which way up the model came out is visible.
  const bitmap = paint(frame(120, 160, [40, 44, 52]), ellipse(60, 80, 30, 56), [222, 190, 150]);
  const result = meshFromPhoto(bitmap, { resolution: 90, targetHeight: 2 });

  assert.ok(result.mesh.faceCount > 500, `only ${result.mesh.faceCount} faces came out`);

  // Closed: every edge is shared by exactly two faces. An open shell looks
  // fine in the viewport and then fails at the boolean, the print and the
  // export, which is the worst order to find out in.
  const open = [...edgeUse(result.mesh)].filter(([, n]) => n !== 2);
  assert.deepEqual(open.slice(0, 5), [], `${open.length} edges are not shared by exactly two faces`);

  // Wound consistently: every edge is walked once in each direction. A face
  // put in backwards passes the count above and still renders as a hole, and
  // the side wall joining the two surfaces is exactly where that goes wrong.
  const directed = new Set<string>();
  for (const loop of result.mesh.faces) {
    for (let i = 0; i < loop.length; i++) {
      const key = `${loop[i]}>${loop[(i + 1) % loop.length]}`;
      assert.equal(directed.has(key), false, `edge ${key} is walked the same way by two faces`);
      directed.add(key);
    }
  }

  // Solid: a shell wound inside out has the right faces and no volume.
  const box = result.mesh.bounds();
  const span = (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);
  assert.ok(volume(result.mesh) > span * 0.1, 'the model came out inside out or hollow');

  // Textured: without coordinates the photograph cannot be projected back on,
  // and a grey blob in the right shape is not what anyone asked for.
  assert.equal(result.mesh.hasUV, true, 'no texture coordinates');
  for (let f = 0; f < result.mesh.faces.length; f++) {
    const uv = result.mesh.faceUV?.[f];
    assert.ok(uv, `face ${f} has no coordinates`);
    assert.equal(uv!.length, result.mesh.faces[f].length * 2);
    for (const value of uv!) assert.ok(value >= -1e-6 && value <= 1 + 1e-6, `uv ${value} is off the image`);
  }

  // Standing: the scene is Z-up and its front view looks along +Y, so a
  // photograph has to come out upright and facing that way. Built flat in XY
  // — which is right for a relief map — a photo of a person lies on the floor.
  assert.ok(Math.abs((box.max.z - box.min.z) - 2) < 1e-4, 'the model is not the height that was asked for');
  assert.ok(
    box.max.z - box.min.z > (box.max.x - box.min.x) * 1.4,
    'a subject twice as tall as it is wide came out wider than it is tall — the model is lying down',
  );
  assert.ok(Math.abs(box.min.z) < 1e-6, 'the model is not sitting on the floor');
  for (const p of result.mesh.positions) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  }
});

test('a small subject in a big frame is not modelled coarsely for it', () => {
  // The grid used to span the photograph, so a subject filling a quarter of
  // the frame got a quarter of the detail budget and three quarters of it went
  // into sampling empty floor. How tightly someone happened to crop decided
  // how good their model was, which is not a thing anyone would choose.
  const tight = paint(frame(80, 80, [30, 34, 40]), disc(40, 40, 34), [210, 190, 170]);
  const loose = paint(frame(240, 240, [30, 34, 40]), disc(120, 120, 34), [210, 190, 170]);

  const a = meshFromPhoto(tight, { resolution: 80 });
  const b = meshFromPhoto(loose, { resolution: 80 });

  assert.ok(b.mesh.faceCount > a.mesh.faceCount * 0.7, `${b.mesh.faceCount} faces from the loose crop against ${a.mesh.faceCount} from the tight one`);
  // And the same object, so it should come out the same size and shape.
  const ha = a.mesh.bounds();
  const hb = b.mesh.bounds();
  assert.ok(Math.abs((hb.max.x - hb.min.x) - (ha.max.x - ha.min.x)) < 0.1, 'the two crops gave different widths');
});

test('every texture coordinate sits well inside the outline', () => {
  // The joining wall and the outermost ring of the surface have their corners
  // on the outline. Reading the texture there wrapped every model in a fringe
  // of whatever it was photographed on — brown streaks around a vase that
  // stood on a table.
  //
  // Landing *just* inside the mask is not enough, which is why this measures
  // distance rather than which side of the line it fell on. The wall quads are
  // a thin lip seen edge-on, so their coordinates change fast across very few
  // pixels; the renderer answers that by sampling a coarse mip level, which
  // averages a wide neighbourhood. A coordinate one pixel inside the outline
  // still comes back mostly background at that level. It has to be clear of
  // the edge by a margin, and the margin is what is checked.
  const size = 160;
  const bitmap = paint(frame(size, size, [175, 120, 55]), disc(80, 80, 46), [40, 90, 210]);
  const { mesh, matte } = meshFromPhoto(bitmap, { resolution: 70 });
  assert.ok(mesh.faceCount > 0);

  // How far each subject pixel is from the nearest background pixel, by
  // breadth-first search out from the background.
  const dist = new Float32Array(size * size).fill(Infinity);
  const queue: number[] = [];
  for (let i = 0; i < dist.length; i++) {
    if (matte.data[i] < 0.5) { dist[i] = 0; queue.push(i); }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % size;
    const y = (i - x) / size;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (dist[j] !== Infinity) continue;
      dist[j] = dist[i] + 1;
      queue.push(j);
    }
  }

  const at = (u: number, v: number): number => {
    const x = Math.max(0, Math.min(size - 1, Math.round(u * (size - 1))));
    const y = Math.max(0, Math.min(size - 1, Math.round((1 - v) * (size - 1))));
    return dist[y * size + x];
  };

  // The wall that joins the two surfaces is the part that wore the floor: it
  // is a thin lip seen edge-on. Its faces are the ones spanning both surfaces,
  // so they have corners on each side of the model's mid-plane; the front and
  // back surfaces themselves sit wholly on one side.
  let closestOnWall = Infinity;
  let walls = 0;
  let everything = Infinity;
  for (let f = 0; f < mesh.faces.length; f++) {
    const uv = mesh.uvFor(f);
    if (!uv) continue;
    for (let i = 0; i < uv.length; i += 2) everything = Math.min(everything, at(uv[i], uv[i + 1]));
    const ys = mesh.faces[f].map((v) => mesh.positions[v].y);
    if (!(ys.some((y) => y < 0) && ys.some((y) => y > 0))) continue;
    walls++;
    for (let i = 0; i < uv.length; i += 2) closestOnWall = Math.min(closestOnWall, at(uv[i], uv[i + 1]));
  }

  assert.ok(walls > 0, 'the model has no joining wall to check');
  assert.ok(Number.isFinite(everything), 'the mesh has no texture coordinates to check');
  // Without the inset every one of these coordinates sits on the outline, and
  // the assertion reports 0 or 1.
  assert.ok(
    closestOnWall >= 2,
    `the joining wall reads ${closestOnWall} pixel(s) from the background — that edge will wear the floor`,
  );
});

test('the model has real depth, and the back can be flattened', () => {
  const bitmap = paint(frame(96, 96, [30, 30, 30]), disc(48, 48, 34), [210, 210, 210]);
  const round = meshFromPhoto(bitmap, { resolution: 70, back: 1 });
  const flat = meshFromPhoto(bitmap, { resolution: 70, back: 0, matte: round.matte });

  const depthOf = (m: Mesh) => m.bounds().max.y - m.bounds().min.y;
  assert.ok(depthOf(round.mesh) > 0.4, `a disc this wide should inflate well past flat, got ${depthOf(round.mesh)}`);
  assert.ok(depthOf(flat.mesh) < depthOf(round.mesh) * 0.7, 'flattening the back did nothing');
  assert.ok(flat.mesh.bounds().max.y < 1e-3, 'the flat back is not flat');
});

test('an empty frame produces nothing rather than throwing', () => {
  const blank = frame(32, 32, [0, 0, 0]);
  // Everything reads as one colour, so the subject is the whole frame; that
  // still has to come out as a mesh rather than an exception.
  const result = meshFromPhoto(blank, { resolution: 32 });
  assert.ok(result.mesh.faceCount >= 0);
  for (const p of result.mesh.positions) assert.ok(Number.isFinite(p.y));

  const tiny = meshFromPhoto({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, { resolution: 32 });
  assert.equal(tiny.mesh.faceCount, 0);
});

test('the mesh survives being handed to the ordinary modelling operators', () => {
  const bitmap = paint(frame(80, 80, [20, 20, 24]), disc(40, 40, 26), [200, 180, 160]);
  const { mesh } = meshFromPhoto(bitmap, { resolution: 48 });
  const topology = mesh.topology();
  assert.ok(topology.faceEdges.length === mesh.faces.length);
  for (const loop of mesh.faces) {
    assert.ok(loop.length >= 3, 'a face came out with fewer than three corners');
    assert.equal(new Set(loop).size, loop.length, 'a face repeats one of its own corners');
    for (const v of loop) assert.ok(v >= 0 && v < mesh.positions.length, 'a face points at a vertex that is not there');
  }
});

test('two strokes rescue a photograph the colours cannot separate', () => {
  // The honest limit of segmenting by colour: a subject photographed against
  // something its own colour cannot be found by colour, and no amount of work
  // on the models changes that. What changes it is being told. This is the
  // case the correction brush exists for — the alternative for these
  // photographs is a trained depth network, which means a few hundred
  // megabytes in the download or a server to upload to.
  const size = 200;
  const bitmap = frame(size, size, [144, 120, 98]);
  const inSubject = (x: number, y: number) => (x - 100) ** 2 / 3600 + (y - 100) ** 2 / 2500 <= 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      // Grain, so neither region is a flat colour the models can latch onto.
      const n = ((x * 5 + y * 11) % 17) - 8;
      const base = inSubject(x, y) ? [150, 126, 104] : [144, 120, 98];
      bitmap.data[o] = base[0] + n;
      bitmap.data[o + 1] = base[1] + n;
      bitmap.data[o + 2] = base[2] + n;
    }
  }

  let trueSubject = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (inSubject(x, y)) trueSubject++;
  const truth = trueSubject / (size * size);

  const agreement = (m: { data: Float32Array }): number => {
    let right = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((m.data[y * size + x] >= 0.5) === inSubject(x, y)) right++;
      }
    }
    return right / (size * size);
  };

  // Left alone it gives up, and says so by calling the whole frame subject —
  // which is the behaviour the verdict in the panel reports as a failure.
  const alone = segmentSubject(bitmap);
  assert.ok(alone.separation < 4, `separation ${alone.separation} — this frame is meant to be hopeless`);
  assert.ok(matteCoverage(alone) > 0.98, 'the unaided pass was expected to fall back to the whole frame');

  // One stroke through the subject, one across the background.
  const hints = new Uint8Array(size * size);
  for (let x = 75; x < 125; x++) for (let d = -3; d <= 3; d++) hints[(100 + d) * size + x] = HINT_SUBJECT;
  for (let x = 10; x < 60; x++) for (let d = -3; d <= 3; d++) hints[(25 + d) * size + x] = HINT_BACKGROUND;

  const helped = segmentSubject(bitmap, { hints });
  assert.ok(
    agreement(helped) > 0.95,
    `with two strokes only ${(agreement(helped) * 100).toFixed(1)}% of pixels are right`,
  );
  assert.ok(
    Math.abs(matteCoverage(helped) - truth) < 0.05,
    `the subject covers ${(truth * 100).toFixed(1)}% but ${(matteCoverage(helped) * 100).toFixed(1)}% was found`,
  );
});

test('a mark is obeyed even where the colours disagree with it', () => {
  // The marks are ground truth, not evidence. A stroke that contradicts what
  // the colour models believe still wins, or correcting anything is a
  // negotiation rather than an instruction.
  const size = 120;
  const bitmap = paint(frame(size, size, [20, 20, 20]), disc(60, 60, 34), [230, 230, 230]);
  const hints = new Uint8Array(size * size);
  // A patch of the bright disc marked as background, and a patch of the dark
  // surround marked as subject: both the opposite of what colour would say.
  for (let y = 50; y < 62; y++) for (let x = 50; x < 62; x++) hints[y * size + x] = HINT_BACKGROUND;
  for (let y = 8; y < 20; y++) for (let x = 8; x < 20; x++) hints[y * size + x] = HINT_SUBJECT;

  const m = segmentSubject(bitmap, { hints });
  assert.ok(m.data[55 * size + 55] < 0.5, 'a patch marked background came back as subject');
  assert.ok(m.data[13 * size + 13] >= 0.5, 'a patch marked subject came back as background');
});

test('an unmarked photograph is segmented exactly as it was before', () => {
  // The brush must not change what happens to everybody who never touches it.
  const bitmap = paint(frame(140, 140, [30, 40, 90]), disc(70, 70, 40), [220, 190, 60]);
  const plain = segmentSubject(bitmap);
  const empty = segmentSubject(bitmap, { hints: new Uint8Array(140 * 140) });
  assert.deepEqual(Array.from(empty.data), Array.from(plain.data));
});

test('a depth map becomes a surface that stands the right way up', () => {
  // The depth route answers a different question from the rest of this file —
  // "how far away is everything" rather than "what is this object" — so the
  // only thing shared with the silhouette pipeline is which way is up. A scene
  // and an object built from the same photograph have to stand the same way,
  // or dropping one beside the other looks like a bug.
  const w = 40;
  const hgt = 30;
  const data = new Float32Array(w * hgt);
  // Near at the bottom of the frame, far at the top: a floor receding away.
  // The map is inverse depth, so 1 is the nearest — the bottom row.
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) data[y * w + x] = y / (hgt - 1);
  const depth = { width: w, height: hgt, data, ms: 0 };
  const bitmap = frame(80, 60, [120, 120, 120]);

  const { mesh, covered } = meshFromDepth(bitmap, depth, { resolution: 40, targetWidth: 3, relief: 1 });
  assert.ok(mesh.faceCount > 0, 'nothing was built from the depth map');
  assert.ok(covered > 0.99, `only ${(covered * 100).toFixed(0)}% of a smooth frame was joined up`);

  const box = mesh.bounds();
  // X across, Z up, Y the distance away — the same convention meshFromPhoto uses.
  assert.ok(Math.abs((box.max.x - box.min.x) - 3) < 0.01, 'the scene is not the width asked for');
  assert.ok(box.max.z - box.min.z > 1, 'the scene has no height');
  assert.ok(Math.abs((box.max.y - box.min.y) - 1) < 0.02, 'the depth range is not the relief asked for');

  // The bottom of the picture is nearest, and nearest is towards -Y.
  const lowest = mesh.positions.reduce((a, b) => (b.z < a.z ? b : a));
  const highest = mesh.positions.reduce((a, b) => (b.z > a.z ? b : a));
  assert.ok(lowest.y < highest.y, 'the near end of the floor did not come out nearest the camera');
  assert.equal(mesh.hasUV, true, 'the surface has no texture coordinates');
});

test('the surface breaks at a step instead of stretching across it', () => {
  // A photograph does not connect the near edge of a table to the wall behind
  // it, but a grid laid over one does. Left alone that drags a sheet of rubber
  // between them, which is the single thing that makes depth-map geometry look
  // fake. Cells spanning a step are dropped instead.
  const w = 60;
  const hgt = 60;
  const data = new Float32Array(w * hgt);
  // Two flat planes at very different distances, meeting down the middle.
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) data[y * w + x] = x < w / 2 ? 0.9 : 0.1;
  const depth = { width: w, height: hgt, data, ms: 0 };
  const bitmap = frame(60, 60, [100, 100, 100]);

  const joined = meshFromDepth(bitmap, depth, { resolution: 60, cut: 1, smoothing: 0 });
  const broken = meshFromDepth(bitmap, depth, { resolution: 60, cut: 0.1, smoothing: 0 });

  assert.ok(joined.covered > 0.99, 'with cutting off, the whole frame should still be one sheet');
  assert.ok(broken.covered < joined.covered, 'cutting removed nothing at a step of 0.8');
  assert.ok(broken.covered > 0.9, `cutting removed ${((1 - broken.covered) * 100).toFixed(0)}% — far too much`);
  // Nothing left should span the gap.
  let widest = 0;
  for (let f = 0; f < broken.mesh.faces.length; f++) {
    const ys = broken.mesh.faces[f].map((v) => broken.mesh.positions[v].y);
    widest = Math.max(widest, Math.max(...ys) - Math.min(...ys));
  }
  assert.ok(widest < 0.2, `a face still spans ${widest.toFixed(2)} of depth across the step`);
});

test('the depth model input size is held to the patch grid', () => {
  // The model is a vision transformer with a 14px patch; anything else is
  // rejected at run time, which would be a failure the user sees rather than
  // one the slider prevents.
  for (const asked of [100, 250, 333, 392, 500, 9000]) {
    const got = patchAligned(asked);
    assert.equal(got % 14, 0, `${asked} rounded to ${got}, which is not a multiple of 14`);
    assert.ok(got >= 112 && got <= 644, `${asked} rounded to ${got}, outside the workable range`);
  }
});
