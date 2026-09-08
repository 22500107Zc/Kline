/**
 * What the user actually sees, asserted against a real browser.
 *
 * The suite in `tests/*.test.ts` covers the geometry, the solvers and the file
 * format, and covers them well — but every one of those tests stops at the
 * edge of the renderer. Three bugs shipped through that gap: a shadow pass
 * that silently drew nothing, a click that threw away the selection it had
 * just confirmed, and an axis whose labels ran together. None of them were
 * findable from data alone; all three are findable from here.
 *
 * Each test below is written against a specific failure that reached a user,
 * not against the implementation that happens to be there now.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, luma, resetScene, samplePixels, screenPoint } from './app/harness.mjs';

const app = await launchApp();

if (app.skip) {
  test('viewport and interaction tests', { skip: `${app.skip} — the browser suite did not run` }, () => {});
} else {
  test.after(() => app.close());

  const { page, centre } = app;

  /** A floor, a box above it, and a sun: the smallest scene that casts. */
  const shadowScene = async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline, ed = k.editor, S = ed.scene;
      k.run('add.plane');
      const floor = S.get(S.active);
      floor.scale.x = 8;
      floor.scale.y = 8;
      k.run('add.cube');
      S.get(S.active).position.z = 2;
      k.run('add.light.sun');
      const sun = S.get(S.active);
      sun.position.z = 8;
      sun.rotation.x = -0.9;
      if (sun.light) sun.light.energy = 5;
      S.selection.clear();
      S.active = null;
      for (let i = 0; i < 4 && ed.options.shading !== 'material'; i++) k.run('view.shading');
      ed.options.showGrid = false;
      ed.options.showOverlays = false;
    });
  };

  /** A lattice of points across the lower half of the frame, where the floor is. */
  const floorGrid = () => {
    const pts = [];
    for (let y = 0.55; y <= 0.92; y += 0.06) {
      for (let x = 0.12; x <= 0.88; x += 0.06) pts.push([x, y]);
    }
    return pts;
  };

  test('the shadow pass writes depth rather than leaving the map empty', async () => {
    await shadowScene();
    const depth = await page.evaluate(() => {
      const ed = window.kline.editor;
      const r = ed.renderer;
      const gl = r.gl;
      ed.renderNow();
      const tex = r.shadowMap;
      if (!tex) return { error: 'no shadow map was allocated' };

      // The depth attachment cannot be read directly, so it is sampled into a
      // small colour target through a plain (non-comparison) lookup.
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, `#version 300 es
in vec2 aP; out vec2 vT;
void main(){ vT = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; uniform sampler2D uD; in vec2 vT; out vec4 o;
void main(){ float d = texture(uD, vT).r; o = vec4(d, d, d, 1.0); }`));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(prog) };

      const N = 128;
      const colour = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, colour);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, N, N);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      gl.useProgram(prog);
      gl.uniform1i(gl.getUniformLocation(prog, 'uD'), 2);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aP');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, N, N);
      gl.disable(gl.DEPTH_TEST);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const px = new Uint8Array(N * N * 4);
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let min = 255;
      let occupied = 0;
      for (let i = 0; i < N * N; i++) {
        const v = px[i * 4];
        if (v < min) min = v;
        if (v < 250) occupied++;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(colour);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.disableVertexAttribArray(loc);
      window.kline.editor.requestRender();
      return { min, occupied, of: N * N };
    });

    assert.equal(depth.error, undefined, `depth read failed: ${depth.error}`);
    // An all-white map is a cleared one — the case where every shadow draw was
    // rejected and the pass produced nothing at all.
    assert.ok(
      depth.occupied > 0,
      `the shadow map is empty: every one of ${depth.of} texels is at the clear value`,
    );
  });

  test('a box above a floor casts a visible shadow onto it', async () => {
    await shadowScene();
    const points = floorGrid();

    await page.evaluate(() => { window.kline.editor.options.shadows = true; });
    const lit = (await samplePixels(page, points)).map(luma);

    await page.evaluate(() => { window.kline.editor.options.shadows = false; });
    const flat = (await samplePixels(page, points)).map(luma);

    // Only points that are on the floor at all — the frame also contains the
    // box itself and the background above the horizon.
    const onFloor = flat.map((v, i) => [v, i]).filter(([v]) => v > 60).map(([, i]) => i);
    assert.ok(onFloor.length > 20, `expected a floor to sample, found ${onFloor.length} lit points`);

    const spread = (values) => {
      const v = onFloor.map((i) => values[i]);
      return Math.max(...v) - Math.min(...v);
    };

    // Without shadows the floor is one flat tone; with them, part of it is
    // markedly darker. The gap between those two spreads is the shadow.
    assert.ok(
      spread(flat) < 25,
      `the unshadowed floor should be near-uniform, but its brightness ranges over ${spread(flat).toFixed(1)}`,
    );
    assert.ok(
      spread(lit) > 40,
      `no shadow reached the floor: brightness ranges over only ${spread(lit).toFixed(1)}`,
    );

    await page.evaluate(() => { window.kline.editor.options.shadows = true; });
  });

  test('no pass leaves a GL error behind, in any mode', async () => {
    await resetScene(page);
    const errors = await page.evaluate(() => {
      const k = window.kline, ed = k.editor, S = ed.scene;
      const gl = ed.renderer.gl;
      k.run('add.uvsphere');
      const ball = S.get(S.active);
      ball.mesh.shadeSmooth = true;
      ball.mesh.markDirty();
      k.run('add.light.sun');
      S.selection = new Set([ball.id]);
      S.active = ball.id;
      ed.options.showGrid = true;
      ed.options.showOverlays = true;

      const found = [];
      const drain = () => { while (gl.getError() !== gl.NO_ERROR) { /* clear */ } };
      const frame = (label) => {
        drain();
        ed.renderNow();
        const e = gl.getError();
        if (e !== gl.NO_ERROR) found.push(`${label}: 0x${e.toString(16)}`);
      };

      for (const shading of ['solid', 'material', 'wireframe']) {
        ed.options.shading = shading;
        frame(`object/${shading}`);
      }
      ed.options.shading = 'material';
      k.run('mode.edit');
      k.run('select.all');
      for (const mode of ['vertex', 'edge', 'face']) {
        ed.setSelectMode(mode);
        frame(`edit/${mode}`);
      }
      // Deleting an object leaves attribute arrays pointing at freed buffers,
      // which is exactly how the shadow pass came to draw nothing.
      k.run('mode.object');
      S.remove(ball.id);
      frame('after a delete');
      k.run('add.cube');
      frame('after a delete then an add');
      return found;
    });
    assert.deepEqual(errors, [], `GL errors were raised during rendering: ${errors.join(', ')}`);
  });

  test('edit-mode overlays draw through their own vertex layout', async () => {
    await resetScene(page);
    // Vertex dots and wires read their attributes from buffers packed far
    // tighter than a surface vertex. Handing them the surface layout leaves
    // the stride wrong, and the overlay does not vanish — it scatters, which
    // is why counting pixels is not enough. Where they land is the test.
    const check = async (selectMode) => page.evaluate((mode) => {
      const k = window.kline, ed = k.editor;
      ed.setSelectMode(mode);
      k.run('select.all');
      ed.options.showOverlays = true;
      ed.renderNow();

      const gl = ed.renderer.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      // Where the mesh actually is on screen, from its own bounds.
      const obj = ed.editObject;
      const b = obj.mesh.bounds();
      const model = obj.worldMatrix(ed.scene);
      const V = ed.camera.target.constructor;
      let lo = { x: Infinity, y: Infinity }, hi = { x: -Infinity, y: -Infinity };
      for (let i = 0; i < 8; i++) {
        const p = model.transformPoint(new V(
          i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z,
        ));
        const s = ed.camera.worldToScreen(p, w, h);
        lo = { x: Math.min(lo.x, s.x), y: Math.min(lo.y, s.y) };
        hi = { x: Math.max(hi.x, s.x), y: Math.max(hi.y, s.y) };
      }
      // Half a dot of slack, plus a little for the projection being coarse.
      const pad = 14;

      let orange = 0, stray = 0;
      for (let i = 0; i < w * h; i++) {
        const r = px[i * 4], g = px[i * 4 + 1], bl = px[i * 4 + 2];
        if (!(r > 180 && g > 100 && g < 200 && bl < 90)) continue;
        orange++;
        const x = i % w;
        // readPixels counts rows from the bottom; worldToScreen from the top.
        const y = h - 1 - Math.floor(i / w);
        if (x < lo.x - pad || x > hi.x + pad || y < lo.y - pad || y > hi.y + pad) stray++;
      }
      return { orange, stray, box: [lo.x | 0, lo.y | 0, hi.x | 0, hi.y | 0] };
    }, selectMode);

    await page.evaluate(() => {
      const k = window.kline;
      k.run('add.uvsphere');
      k.run('mode.edit');
    });

    for (const mode of ['vertex', 'edge']) {
      const r = await check(mode);
      assert.ok(
        r.orange > 500,
        `${mode} overlay is not being drawn: only ${r.orange} overlay pixels in the frame`,
      );
      // A mis-strided buffer walks off the end of its data and throws the
      // overlay across the frame; a correct one keeps it on the mesh.
      assert.ok(
        r.stray < r.orange * 0.02,
        `${mode} overlay is scattered: ${r.stray} of ${r.orange} pixels fall outside `
        + `the mesh at [${r.box}] — the buffer is being read at the wrong stride`,
      );
    }
  });

  /** Put a cube in edit mode with its top face picked, ready for an operator. */
  const cubeWithTopFacePicked = async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline;
      k.run('add.cube');
      k.run('mode.edit');
      k.run('select.face');
      k.run('select.none');
    });
    // The centre of the top face, projected through the app's own camera.
    const top = await screenPoint(page, [0, 0, 0.5]);
    await page.mouse.move(top.x, top.y);
    await page.mouse.click(top.x, top.y);
    return top;
  };

  test('confirming a modal with a click keeps the selection', async () => {
    await cubeWithTopFacePicked();
    assert.equal(
      await page.evaluate(() => window.kline.editor.selection.faces.size), 1,
      'clicking the top face should select exactly it',
    );

    // Confirm well below the cube, over empty space. That is the case that
    // matters: a modal is sized by dragging away from what it acts on, so the
    // confirming click routinely lands on nothing. Confirming back over the
    // face hides the bug, because the stray pick simply finds it again.
    const empty = await screenPoint(page, [0, 0, -3]);
    await page.keyboard.press('i');
    await page.mouse.move(empty.x, empty.y - 120);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    await page.mouse.up();

    const after = await page.evaluate(() => {
      const ed = window.kline.editor;
      return { faces: ed.selection.faces.size, modal: ed.modal ? ed.modal.type : null };
    });
    assert.equal(after.modal, null, 'the click should have confirmed the inset');
    // The release used to be read as a click on empty space, and deselect.
    assert.equal(after.faces, 1, 'the inset face should still be selected after confirming');
  });

  test('inset then extrude chains, which is the whole point of keeping it', async () => {
    const top = await cubeWithTopFacePicked();
    const faces = () => page.evaluate(() => window.kline.editor.editObject.mesh.faceCount);
    const start = await faces();

    await page.keyboard.press('i');
    await page.mouse.move(top.x + 40, top.y);
    await page.mouse.down();
    await page.mouse.up();
    const inset = await faces();
    assert.ok(inset > start, `inset added no geometry (${start} -> ${inset})`);

    await page.keyboard.press('e');
    await page.mouse.move(top.x, top.y - 60);
    await page.mouse.down();
    await page.mouse.up();
    const extruded = await faces();
    assert.ok(extruded > inset, `extrude after inset did nothing (${inset} -> ${extruded})`);
  });

  test('the ordinary ways of selecting still work', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline, S = k.editor.scene;
      k.run('add.cube');
      S.get(S.active).position.x = -2.2;
      k.run('add.cube');
      S.get(S.active).position.x = 2.2;
      S.selection.clear();
      S.active = null;
      k.editor.requestRender();
    });
    const count = () => page.evaluate(() => window.kline.editor.scene.selection.size);

    const left = await screenPoint(page, [-2.2, 0, 0]);
    await page.mouse.click(left.x, left.y);
    assert.equal(await count(), 1, 'a click should select the object under it');

    const right = await screenPoint(page, [2.2, 0, 0]);
    await page.keyboard.down('Shift');
    await page.mouse.click(right.x, right.y);
    await page.keyboard.up('Shift');
    assert.equal(await count(), 2, 'shift-click should extend the selection');

    // The origin: the gap between the two cubes, and dead centre of frame, so
    // it is certainly on the canvas rather than under a panel.
    const empty = await screenPoint(page, [0, 0, 0]);
    await page.mouse.click(empty.x, empty.y);
    assert.equal(await count(), 0, 'a click on empty space should deselect');

    // A rectangle drawn around both cubes, with room to spare on each side.
    const pad = 60;
    await page.mouse.move(Math.min(left.x, right.x) - pad, Math.min(left.y, right.y) - pad);
    await page.mouse.down();
    await page.mouse.move(Math.max(left.x, right.x) + pad, Math.max(left.y, right.y) + pad, { steps: 8 });
    await page.mouse.up();
    assert.equal(await count(), 2, 'a drag across both objects should select both');
  });

  test('escape cancels a transform and puts the value back', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline, S = k.editor.scene;
      k.run('add.cube');
      S.selection = new Set([S.active]);
      k.editor.requestRender();
    });
    const x = () => page.evaluate(
      () => +window.kline.editor.scene.get(window.kline.editor.scene.active).position.x,
    );
    const origin = await screenPoint(page, [0, 0, 0]);
    const before = await x();

    await page.mouse.move(origin.x, origin.y);
    await page.keyboard.press('g');
    await page.mouse.move(origin.x + 120, origin.y);
    await page.keyboard.press('Escape');
    assert.ok(Math.abs((await x()) - before) < 1e-6, 'escape left the object moved');

    await page.mouse.move(origin.x, origin.y);
    await page.keyboard.press('g');
    await page.mouse.move(origin.x + 120, origin.y);
    await page.mouse.down();
    await page.mouse.up();
    assert.ok(Math.abs((await x()) - before) > 0.1, 'a confirmed move did not move anything');
  });

  /** Drag across the middle of the viewport, the way a stroke is made. */
  const dragAcross = async (from, steps = 10, dx = 6, dy = 0) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + i * dx, from.y + i * dy);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
  };

  test('a sculpt stroke moves the surface it is dragged over', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      k.run('add.uvsphere');
      k.run('mode.sculpt');
      ed.sculpt.brush = 'draw';
      ed.sculpt.radius = 0.5;
      const o = ed.scene.get(ed.scene.active);
      window.__before = o.mesh.positions.map((p) => [p.x, p.y, p.z]);
    });
    const centre = await screenPoint(page, [0, 0, 0]);
    await dragAcross({ x: centre.x - 30, y: centre.y });

    const moved = await page.evaluate(() => {
      const o = window.kline.editor.scene.get(window.kline.editor.scene.active);
      let n = 0, worst = 0, nan = 0;
      o.mesh.positions.forEach((p, i) => {
        if (!Number.isFinite(p.x + p.y + p.z)) { nan++; return; }
        const q = window.__before[i];
        const d = Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]);
        if (d > 1e-6) n++;
        if (d > worst) worst = d;
      });
      return { n, worst, nan };
    });
    assert.equal(moved.nan, 0, 'the stroke put NaN into the mesh');
    assert.ok(moved.n > 10, `the stroke moved only ${moved.n} vertices — it is not reaching the surface`);
    assert.ok(moved.worst > 0.005, `the stroke barely displaced anything (${moved.worst})`);
  });

  test('a mask holds back the brush where it was painted', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      k.run('add.uvsphere');
      k.run('mode.sculpt');
      ed.sculpt.brush = 'mask';
      ed.sculpt.radius = 0.8;
      ed.sculpt.strength = 1;
    });
    const centre = await screenPoint(page, [0, 0, 0]);
    // Several passes, so a region actually reaches full mask rather than a
    // falloff value that is supposed to move a little.
    for (let i = 0; i < 5; i++) await dragAcross({ x: centre.x - 20, y: centre.y }, 8, 4);

    const painted = await page.evaluate(() => {
      const ed = window.kline.editor;
      const o = ed.scene.get(ed.scene.active);
      if (!o.mesh.mask) return { held: 0 };
      window.__mask = [...o.mesh.mask];
      window.__before = o.mesh.positions.map((p) => [p.x, p.y, p.z]);
      ed.sculpt.brush = 'draw';
      return { held: window.__mask.filter((v) => v > 0.9).length };
    });
    assert.ok(painted.held > 5, `the mask brush painted only ${painted.held} vertices to full strength`);

    await dragAcross({ x: centre.x - 20, y: centre.y }, 8, 4);
    const byLevel = await page.evaluate(() => {
      const o = window.kline.editor.scene.get(window.kline.editor.scene.active);
      const masked = [], partial = [];
      o.mesh.positions.forEach((p, i) => {
        const q = window.__before[i];
        const d = Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]);
        const m = window.__mask[i] ?? 0;
        if (m > 0.9) masked.push(d);
        else if (m > 0.1) partial.push(d);
      });
      const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
      return { masked: mean(masked), partial: mean(partial), partialCount: partial.length };
    });
    assert.ok(byLevel.partialCount > 0, 'no partly-masked vertices to compare against');
    // A mask is a falloff, so the test is the ratio, not that masked is zero.
    assert.ok(
      byLevel.masked < byLevel.partial * 0.1,
      `masked vertices moved ${byLevel.masked.toFixed(5)} against ${byLevel.partial.toFixed(5)} `
      + 'for partly-masked ones — the mask is not holding them',
    );
  });

  test('posing a bound rig changes what is on screen', async () => {
    await resetScene(page);
    const bound = await page.evaluate(() => {
      const k = window.kline, ed = k.editor, S = ed.scene;
      k.run('add.cylinder');
      const tube = S.get(S.active);
      tube.scale.z = 3;
      k.run('add.armature');
      const arm = [...S.objects.values()].find((o) => o.type === 'armature');
      k.run('rig.extrudeBone');
      k.run('rig.extrudeBone');
      S.selection = new Set([tube.id, arm.id]);
      S.active = arm.id;
      k.run('rig.bind');
      window.__tube = tube.id;
      window.__arm = arm.id;
      const skin = tube.skin ?? tube.mesh.skin;
      if (!skin) return { influences: 0 };
      let influences = 0;
      for (let i = 0; i < skin.bones.length; i++) if (skin.bones[i] >= 0 && skin.weights[i] > 0) influences++;
      // Weights are a partition of unity wherever anything is bound at all.
      const per = skin.bones.length / tube.mesh.positions.length;
      let badSums = 0;
      for (let v = 0; v < tube.mesh.positions.length; v++) {
        let sum = 0;
        for (let i = 0; i < per; i++) sum += skin.weights[v * per + i];
        if (sum > 1e-6 && Math.abs(sum - 1) > 1e-4) badSums++;
      }
      return { influences, badSums };
    });
    assert.ok(bound.influences > 0, 'binding produced no weights at all');
    assert.equal(bound.badSums, 0, 'some vertices have weights that do not sum to one');

    // Same camera, same everything, only the bone moves — so the mesh must
    // change, and so must the frame. Whole-frame difference rather than a few
    // sample points: on a flat-shaded surface two very different silhouettes
    // can happen to share a colour anywhere you happen to look.
    const deformed = await page.evaluate(() => {
      const ed = window.kline.editor, S = ed.scene;
      const tube = S.get(window.__tube);
      const arm = S.get(window.__arm);
      const gl = ed.renderer.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const frame = () => {
        ed.renderNow();
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const rest = tube.evaluated(false).positions.map((p) => [p.x, p.y, p.z]);
      const restFrame = frame();

      arm.armature.bones[arm.armature.bones.length - 1].rotation = [0, 0.9, 0];
      tube.invalidate?.();
      arm.invalidate?.();

      const posed = tube.evaluated(false).positions.map((p) => [p.x, p.y, p.z]);
      let moved = 0, still = 0, nan = 0;
      posed.forEach((p, i) => {
        if (!Number.isFinite(p[0] + p[1] + p[2])) { nan++; return; }
        const d = Math.hypot(p[0] - rest[i][0], p[1] - rest[i][1], p[2] - rest[i][2]);
        if (d > 1e-6) moved++; else still++;
      });

      const posedFrame = frame();
      let changed = 0;
      for (let i = 0; i < w * h; i++) {
        const d = Math.abs(restFrame[i * 4] - posedFrame[i * 4])
          + Math.abs(restFrame[i * 4 + 1] - posedFrame[i * 4 + 1])
          + Math.abs(restFrame[i * 4 + 2] - posedFrame[i * 4 + 2]);
        if (d > 12) changed++;
      }
      return { moved, still, nan, changed, pixels: w * h };
    });
    assert.equal(deformed.nan, 0, 'posing put NaN into the mesh');
    assert.ok(deformed.moved > 0, 'posing a bone moved nothing');
    assert.ok(deformed.still > 0, 'posing one bone moved the entire mesh — the weights are not localised');
    // The evaluated mesh changing is not enough: a modifier stack returns a
    // fresh mesh every run, and one keyed only by revision looks identical to
    // the last, so the viewport went on showing the rest pose.
    assert.ok(
      deformed.changed > deformed.pixels * 0.005,
      `only ${deformed.changed} of ${deformed.pixels} pixels changed — the deformed mesh `
      + 'is not reaching the screen',
    );
  });

  test('a physics bake drops a box onto a floor and keys where it lands', async () => {
    await resetScene(page);
    const baked = await page.evaluate(() => {
      const k = window.kline, ed = k.editor, S = ed.scene;
      k.run('add.plane');
      const floor = S.get(S.active);
      floor.scale.x = 8;
      floor.scale.y = 8;
      floor.physics = { kind: 'passive', mass: 0, shape: 'box', friction: 0.6, restitution: 0.1 };
      k.run('add.cube');
      const box = S.get(S.active);
      box.position.z = 5;
      box.rotation.x = 0.4;
      box.rotation.y = 0.3;
      box.physics = { kind: 'active', mass: 1, shape: 'box', friction: 0.6, restitution: 0.1 };
      k.run('physics.bake');
      const z = box.animation.find((c) => c.path === 'position' && c.index === 2);
      const rot = box.animation.filter((c) => c.path === 'rotation');
      return {
        keyed: !!z && z.keys.length > 1,
        startZ: z ? z.keys[0].value : null,
        endZ: z ? z.keys[z.keys.length - 1].value : null,
        rotationChannels: rot.length,
        rotationMoved: rot.some((c) => Math.abs(c.keys[c.keys.length - 1].value - c.keys[0].value) > 1e-3),
        status: ed.statusMessage,
      };
    });
    assert.ok(baked.keyed, 'the bake wrote no position keys');
    assert.ok(baked.endZ < baked.startZ - 2, `the box did not fall (${baked.startZ} -> ${baked.endZ})`);
    assert.ok(baked.endZ > 0.2, `the box fell through the floor to ${baked.endZ}`);
    assert.equal(baked.rotationChannels, 3, 'rotation was not baked');
    // A box dropped at an angle onto a floor has to rotate as it settles;
    // it used to collide as though it were axis-aligned and never would.
    assert.ok(baked.rotationMoved, 'the box never rotated — the solver is ignoring orientation');
  });

  test('the path tracer produces an image, not a blank canvas', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline, ed = k.editor, S = ed.scene;
      k.run('add.plane');
      const floor = S.get(S.active);
      floor.scale.x = 6;
      floor.scale.y = 6;
      k.run('add.uvsphere');
      S.get(S.active).position.z = 1.2;
      k.run('add.light.sun');
      S.get(S.active).position.z = 6;
      ed.renderSettings.width = 96;
      ed.renderSettings.height = 64;
      ed.renderSettings.samples = 8;
      ed.renderSettings.maxBounces = 3;
      k.run('render.image');
    });
    await page.waitForFunction(
      () => window.kline.editor.activeRender && window.kline.editor.activeRender.samplesDone > 0,
      null, { timeout: 60_000 },
    );
    const image = await page.evaluate(() => {
      const job = window.kline.editor.activeRender;
      const data = job.toImageData();
      let min = 255, max = 0, sum = 0;
      const n = data.width * data.height;
      for (let i = 0; i < n; i++) {
        const v = 0.2126 * data.data[i * 4] + 0.7152 * data.data[i * 4 + 1] + 0.0722 * data.data[i * 4 + 2];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const nan = [...data.data].some((v) => !Number.isFinite(v));
      window.kline.run('render.cancel');
      return { samples: job.samplesDone, triangles: job.triangles, min, max, mean: sum / n, nan };
    });
    assert.equal(image.nan, false, 'the render contains non-finite pixels');
    assert.ok(image.triangles > 0, 'the tracer was handed no geometry');
    // A frame that is one flat tone means nothing was hit, or everything was.
    assert.ok(
      image.max - image.min > 30,
      `the render is a flat field (${image.min.toFixed(0)}..${image.max.toFixed(0)}) — nothing was traced`,
    );
    assert.ok(image.mean > 5, `the render came back essentially black (mean ${image.mean.toFixed(1)})`);
  });

  test('a comparison tints changed geometry and ghosts what was removed', async () => {
    await resetScene(page);
    const counts = await page.evaluate(() => {
      const k = window.kline, ed = k.editor, S = ed.scene;
      k.run('add.cube');
      const block = S.get(S.active);
      for (let i = 0; i < 4 && ed.options.shading !== 'material'; i++) k.run('view.shading');
      ed.options.showGrid = false;
      ed.options.showOverlays = false;
      const before = JSON.parse(JSON.stringify(S.toJSON()));

      // Subdivide: every original face is replaced, so the comparison should
      // report new geometry and have old loops left over to ghost.
      S.selection = new Set([block.id]);
      S.active = block.id;
      k.run('mode.edit');
      k.run('select.face');
      k.run('select.all');
      k.run('mesh.subdivide');
      k.run('mode.object');
      S.selection.clear();
      S.active = null;

      const diff = ed.compareAgainst(before, 'before subdividing');
      const entry = diff.objects.find((o) => o.id === block.id);
      return {
        added: entry?.mesh?.added ?? 0,
        removed: entry?.mesh?.removed ?? 0,
        status: entry?.status,
      };
    });
    assert.equal(counts.status, 'changed', 'the edited object was not reported as changed');
    assert.ok(counts.added > 0, 'subdividing reported no new faces');
    assert.ok(counts.removed > 0, 'subdividing reported nothing removed');

    // The whole point is that it reaches the screen, so the frames are
    // compared with the comparison shown and hidden.
    const pixels = await page.evaluate(() => {
      const ed = window.kline.editor;
      const gl = ed.renderer.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const frame = () => {
        ed.renderNow();
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      ed.options.showDiff = false;
      const plain = frame();
      ed.options.showDiff = true;
      const shown = frame();
      let green = 0, red = 0;
      for (let i = 0; i < w * h; i++) {
        const dr = shown[i * 4] - plain[i * 4];
        const dg = shown[i * 4 + 1] - plain[i * 4 + 1];
        const db = shown[i * 4 + 2] - plain[i * 4 + 2];
        if (dg > 25 && dg > dr && dg > db) green++;
        if (dr > 25 && dr > dg && dr > db) red++;
      }
      return { green, red, of: w * h };
    });
    assert.ok(pixels.green > 400, `added geometry is not tinted: only ${pixels.green} greener pixels`);
    // Removed faces cannot be tinted — they are gone — so they are drawn as
    // outlines where they used to be, which is the other half of a diff.
    assert.ok(pixels.red > 40, `removed geometry left no ghost: only ${pixels.red} redder pixels`);

    await page.evaluate(() => window.kline.editor.stopComparing());
  });

  test('a comparison against an unchanged scene reports nothing', async () => {
    await resetScene(page);
    const result = await page.evaluate(() => {
      const k = window.kline, ed = k.editor;
      k.run('add.uvsphere');
      const before = JSON.parse(JSON.stringify(ed.scene.toJSON()));
      const diff = ed.compareAgainst(before, 'itself');
      const out = { identical: diff.identical, status: ed.statusMessage };
      ed.stopComparing();
      return out;
    });
    assert.ok(result.identical, `comparing a scene with itself found differences: ${result.status}`);
  });

  test('the comparison panel opens on its shortcut and lists the changes', async () => {
    await resetScene(page);
    await page.evaluate(() => {
      const k = window.kline;
      k.run('add.cube');
      window.__snapshot = JSON.parse(JSON.stringify(k.editor.scene.toJSON()));
      k.run('add.uvsphere');
      k.editor.scene.get(k.editor.scene.active).name = 'Newcomer';
    });
    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.press('Control+d');
    await page.waitForTimeout(250);
    const opened = await page.evaluate(() => {
      const panel = document.querySelector('.diff-panel');
      return { present: !!panel, hidden: panel?.classList.contains('hidden') };
    });
    assert.ok(opened.present, 'the comparison panel is not in the document');
    assert.equal(opened.hidden, false, 'ctrl+D did not open the comparison panel');

    const rows = await page.evaluate(() => {
      window.kline.editor.compareAgainst(window.__snapshot, 'a moment ago');
      return [...document.querySelectorAll('.diff-row')].map((r) => r.textContent);
    });
    assert.ok(
      rows.some((r) => r.includes('Newcomer')),
      `the added object is not listed; rows were ${JSON.stringify(rows)}`,
    );

    await page.evaluate(() => window.kline.editor.stopComparing());
    await page.keyboard.press('Escape');
  });

  test('the setup guide opens on a first run and stays shut once dismissed', async () => {
    // A fresh profile has no stored preference, which is what a genuine first
    // run looks like.
    const first = await page.evaluate(() => {
      const el = document.querySelector('.setup-guide');
      return {
        present: !!el,
        preference: window.kline.editor.preferences.showGuideOnStart,
      };
    });
    assert.ok(first.present, 'the guide is not in the document at all');

    // Open it explicitly, since earlier tests in this file have already been
    // through the boot sequence.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: true });
      if (!document.querySelector('.setup-guide').classList.contains('hidden')) return;
      window.kline.run('help.guide');
    });
    await page.waitForTimeout(200);

    const opened = await page.evaluate(() => {
      const el = document.querySelector('.setup-guide');
      return {
        open: !el.classList.contains('hidden'),
        title: el.querySelector('h2')?.textContent,
        cards: el.querySelectorAll('.setup-dot').length,
        hasAction: !!el.querySelector('.setup-try'),
        hasCheckbox: !!el.querySelector('.setup-again input'),
      };
    });
    assert.ok(opened.open, 'the guide did not open');
    assert.ok(opened.cards >= 3, `only ${opened.cards} cards — that is not a guide`);
    assert.ok(opened.hasAction, 'the first card has nothing to try');
    assert.ok(opened.hasCheckbox, 'there is no way to turn it off');

    // The demonstrations have to act on the real scene, or they teach nothing.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      for (const id of [...ed.scene.objects.keys()]) ed.scene.remove(id);
    });
    await page.click('.setup-try');
    await page.waitForTimeout(300);
    const built = await page.evaluate(() => window.kline.editor.scene.objects.size);
    assert.ok(built > 0, 'the first card\'s button did nothing to the scene');

    // Ticking the box must persist, not just hide the panel for this session.
    await page.click('.setup-again input');
    await page.waitForTimeout(200);
    const off = await page.evaluate(() => ({
      preference: window.kline.editor.preferences.showGuideOnStart,
      stored: JSON.parse(localStorage.getItem('kline.preferences') ?? '{}').showGuideOnStart,
    }));
    assert.equal(off.preference, false, 'the checkbox did not change the preference');
    assert.equal(off.stored, false, 'the choice was not written to storage, so it will come back');

    // And it must still be openable afterwards — onboarding you cannot get
    // back is a dead end.
    await page.evaluate(() => {
      document.querySelector('.setup-guide').classList.add('hidden');
      window.kline.run('help.guide');
    });
    await page.waitForTimeout(200);
    const reopened = await page.evaluate(
      () => !document.querySelector('.setup-guide').classList.contains('hidden'),
    );
    assert.ok(reopened, 'the guide could not be reopened from the Help command');

    await page.evaluate(() => {
      document.querySelector('.setup-guide').classList.add('hidden');
      const ed = window.kline.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: false });
    });
  });

  test('a pending crash recovery does not suppress the guide', async () => {
    // These were mutually exclusive at first, on the theory that a recovery
    // offer is more urgent. It backfired: closing the tab writes an autosave,
    // so almost every launch after the first has something to offer, and
    // anyone who quit without ticking the box never saw the guide again.
    // They occupy different corners and can both be up.
    const both = await page.evaluate(() => {
      const bar = document.querySelector('.recovery-bar');
      const guide = document.querySelector('.setup-guide');
      if (!bar || !guide) return { missing: true };
      // Stand both up the way a boot with a recovery copy would.
      bar.classList.remove('hidden');
      guide.classList.remove('hidden');
      const barBox = bar.getBoundingClientRect();
      const guideBox = guide.getBoundingClientRect();
      const overlap = !(barBox.bottom <= guideBox.top || guideBox.bottom <= barBox.top
        || barBox.right <= guideBox.left || guideBox.right <= barBox.left);
      bar.classList.add('hidden');
      guide.classList.add('hidden');
      return { missing: false, overlap, barHeight: barBox.height, guideTop: guideBox.top };
    });
    assert.equal(both.missing, false, 'the recovery bar or the guide is not in the document');
    assert.equal(both.overlap, false, 'the recovery bar and the guide cover each other');
  });

  test('walking the guide to the end closes it without touching the preference', async () => {
    await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: true });
      document.querySelector('.setup-guide').classList.add('hidden');
      window.kline.run('help.guide');
    });
    await page.waitForTimeout(200);
    const cards = await page.evaluate(() => document.querySelectorAll('.setup-dot').length);
    for (let i = 0; i < cards; i++) {
      await page.click('.setup-foot .btn.primary');
      await page.waitForTimeout(120);
    }
    const after = await page.evaluate(() => ({
      open: !document.querySelector('.setup-guide').classList.contains('hidden'),
      preference: window.kline.editor.preferences.showGuideOnStart,
    }));
    assert.equal(after.open, false, 'reaching the last card did not close the guide');
    // Finishing it is not the same as asking never to see it again; only the
    // checkbox means that.
    assert.equal(after.preference, true, 'finishing the guide silently turned it off');

    await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.applyPreferences({ ...ed.preferences, showGuideOnStart: false });
    });
  });

  // --------------------------------------------------------- navigation
  //
  // Kline is used on laptops, and a laptop has no middle mouse button. Every
  // one of these drives the real canvas through real input events, because
  // the failure being guarded against was never in the camera maths — it was
  // in what the browser reports and what the app does with it.

  /** The camera's orbit state, as the app currently holds it. */
  const cameraState = () => page.evaluate(() => {
    const c = window.kline.editor.camera;
    return { yaw: c.yaw, pitch: c.pitch, distance: c.distance, target: [c.target.x, c.target.y, c.target.z] };
  });

  test('a two-finger flick zooms smoothly instead of slamming into the model', async () => {
    await resetScene(page);
    await page.mouse.move(centre.x, centre.y);
    const before = await cameraState();
    // A trackpad reports a flick as a long stream of small deltas. Treating
    // each as a full wheel detent took the distance from 11 to the near
    // clamp in a fraction of a second, and there was no way back out.
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -4);
    const after = await cameraState();
    assert.ok(after.distance < before.distance, 'the flick did not zoom in at all');
    assert.ok(
      after.distance > before.distance * 0.5,
      `40 trackpad events took the camera from ${before.distance} to ${after.distance}`,
    );
  });

  test('scrolling zooms towards the cursor, not the middle of the screen', async () => {
    await resetScene(page);
    const before = await cameraState();
    // Off to one side, well inside the viewport.
    await page.mouse.move(centre.x - 260, centre.y + 120);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -30);
    const off = await cameraState();
    const moved = (s) => Math.hypot(...s.target.map((v, i) => v - before.target[i]));
    assert.ok(off.distance < before.distance, 'scrolling did not zoom');
    assert.ok(moved(off) > 0.5, `zooming at a corner barely moved the pivot: ${moved(off)}`);

    // And the middle stays the middle. Not to the last decimal — a real
    // pointer lands on a whole pixel and the middle of the canvas may not be
    // one — but nowhere near what an off-centre scroll does.
    await resetScene(page);
    await page.mouse.move(Math.round(centre.x), Math.round(centre.y));
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -30);
    const middle = await cameraState();
    assert.ok(middle.distance < before.distance);
    assert.ok(moved(middle) < 0.02, `zooming at the centre moved the pivot by ${moved(middle)}`);
  });

  test('Option with a two-finger scroll turns the view', async () => {
    await resetScene(page);
    await page.mouse.move(centre.x, centre.y);
    const before = await cameraState();
    await page.keyboard.down('Alt');
    for (let i = 0; i < 10; i++) await page.mouse.wheel(-20, 0);
    await page.keyboard.up('Alt');
    const after = await cameraState();
    assert.notEqual(after.yaw, before.yaw, 'Option + scroll did not orbit');
    assert.ok(
      Math.abs(after.distance - before.distance) < 1e-6,
      `orbiting also changed the distance, ${before.distance} to ${after.distance}`,
    );
  });

  test('Option and Shift with a scroll slides the view', async () => {
    await resetScene(page);
    await page.mouse.move(centre.x, centre.y);
    const before = await cameraState();
    await page.keyboard.down('Shift');
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 30);
    await page.keyboard.up('Shift');
    const after = await cameraState();
    assert.notDeepEqual(after.target, before.target, 'Shift + scroll did not pan');
    assert.ok(Math.abs(after.yaw - before.yaw) < 1e-9, 'panning also turned the view');
  });

  test('Option and drag orbits, and letting go of Option does not eat the selection', async () => {
    // Navigation used to be re-read from the keys on every move event, so a
    // finger coming off Option part way through an orbit turned the rest of
    // the drag into a box select — which then applied on release and wiped
    // whatever was selected.
    await resetScene(page);
    await page.evaluate(() => {
      window.kline.run('add.cube');
      window.kline.editor.frameSelected();
    });
    await page.waitForTimeout(120);
    const before = await cameraState();
    const selected = await page.evaluate(() => window.kline.editor.scene.selection.size);
    assert.equal(selected, 1, 'the cube should start selected');

    await page.mouse.move(centre.x, centre.y);
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await page.mouse.move(centre.x + 60, centre.y + 10, { steps: 6 });
    await page.keyboard.up('Alt');
    await page.mouse.move(centre.x + 120, centre.y + 20, { steps: 6 });
    await page.mouse.up();

    const after = await cameraState();
    assert.notEqual(after.yaw, before.yaw, 'Option + drag did not orbit');
    assert.equal(
      await page.evaluate(() => window.kline.editor.scene.selection.size),
      1,
      'releasing Option mid-orbit threw the selection away',
    );
    assert.equal(
      await page.evaluate(() => !!window.kline.editor.boxSelectRect),
      false,
      'a box select was left running after the orbit',
    );
  });

  // ----------------------------------------------------- photograph to model

  test('a photograph comes out as a closed, textured, three-dimensional model', async () => {
    await resetScene(page);
    const built = await page.evaluate(async () => {
      // A blue object on a warm floor, mixed so the two are the same
      // brightness to within a point. No threshold anywhere separates them —
      // the only thing that tells them apart is colour, which is exactly the
      // photograph the old mask could not do anything with.
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 300;
      const g = c.getContext('2d');
      const image = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          const inside = ((x - 120) / 70) ** 2 + ((y - 150) / 100) ** 2 < 1;
          const n = ((x * 7 + y * 13) % 29) - 14;
          image.data[o] = (inside ? 60 : 150) + n;
          image.data[o + 1] = (inside ? 80 : 70) + n;
          image.data[o + 2] = (inside ? 200 : 40) + n;
          image.data[o + 3] = 255;
        }
      }
      g.putImageData(image, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      const file = new File([blob], 'subject.png', { type: 'image/png' });
      window.kline.app.properties.openCreate(file);

      const editor = window.kline.editor;
      for (let i = 0; i < 200 && editor.scene.objects.size === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const object = [...editor.scene.objects.values()][0];
      if (!object || !object.mesh) return { ok: false };
      const mesh = object.mesh;
      const box = mesh.bounds();

      // Every edge shared by exactly two faces: a shell that only looks solid
      // fails at the first boolean or export.
      const edges = new Map();
      for (const loop of mesh.faces) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % loop.length];
          if (a === b) continue;
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      const material = editor.scene.materials[object.materialSlots[0] ?? 0];
      return {
        ok: true,
        faces: mesh.faceCount,
        hasUV: mesh.hasUV,
        openEdges: [...edges.values()].filter((n) => n !== 2).length,
        depth: box.max.y - box.min.y,
        height: box.max.z - box.min.z,
        width: box.max.x - box.min.x,
        floor: box.min.z,
        textures: editor.scene.textures.length,
        texture: material ? material.baseColorTexture : null,
      };
    });

    assert.equal(built.ok, true, 'no object was created from the photograph');
    assert.ok(built.faces > 500, `only ${built.faces} faces came out of the photograph`);
    assert.equal(built.hasUV, true, 'the model has no texture coordinates, so the photo cannot go on it');
    assert.equal(built.openEdges, 0, `${built.openEdges} edges are not shared by exactly two faces`);
    assert.equal(built.textures, 1, 'the photograph was not stored as a texture');
    assert.ok(built.texture !== null, 'the material is not using the photograph');
    // A cut-out would be flat. This has to have depth, and it has to come
    // from the subject's own width rather than a number someone typed.
    assert.ok(built.depth > 0.3, `the model is ${built.depth.toFixed(3)} deep, which is a sticker`);
    // Upright and on the floor: the scene is Z-up and its front view looks
    // along +Y, so a photograph has to stand rather than lie face up.
    assert.ok(Math.abs(built.height - 2) < 0.01, `the model stands ${built.height}, not the 2 asked for`);
    assert.ok(built.height > built.width, 'a subject taller than it is wide came out lying down');
    assert.ok(Math.abs(built.floor) < 1e-6, 'the model is not standing on the floor');
  });

  test('the photographed model actually renders, with the photograph on it', async () => {
    // The mesh existing and the mesh being drawn are different claims, and
    // the texture path in particular can fail without saying anything.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      // Material shading is the only mode that shows a texture, and it lights
      // the scene from the scene's own lights — of which a wiped scene has
      // none. Both are set here rather than assumed: this test is about what
      // is on the surface, so it is lit flat by ambient and the question is
      // only whether the photograph's own colours come through.
      ed.options.shading = 'material';
      ed.options.showDiff = false;
      ed.options.xray = false;
      ed.stopComparing();
      ed.scene.world.ambient = 1;
      // Framed on the model, then deselected: the selection outline is drawn
      // over the model and would otherwise be what got sampled.
      const model = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      ed.selectObject(model.id);
      ed.frameSelected();
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.requestRender();
    });
    await page.waitForTimeout(400);
    const [middle, left, corner] = await samplePixels(page, [[0.5, 0.5], [0.44, 0.52], [0.03, 0.04]]);
    assert.ok(
      luma(middle) > luma(corner) + 12 || luma(left) > luma(corner) + 12,
      `nothing drew where the model should be: ${JSON.stringify({ middle, left, corner })}`,
    );
    // The subject in the photograph is strongly blue. A model wearing its own
    // photograph comes out blue; one that dropped the texture comes out the
    // default grey, where the channels sit on top of each other.
    assert.ok(
      middle[2] > middle[0] * 1.3,
      `the model rendered ${JSON.stringify(middle)}, which is not the blue of the photograph`,
    );
  });

  test('selecting the model does not paint over the photograph', async () => {
    // Selecting an object tints it, and the tint used to be mixed into linear
    // radiance using an interface colour written for the screen. In linear
    // terms that colour is far brighter than a lit surface, so a tint of a
    // tenth put in most of the pixel: a model wearing a photograph turned
    // into a flat orange wash the moment it was selected — which is the
    // moment it is created, so the headline feature showed its result and hid
    // it in the same frame. Nobody noticed for weeks because the test above
    // deselects before it looks.
    //
    // The same sample, taken with the model selected. It still has to be the
    // blue of the photograph.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      // At the flat white ambient the test above uses, the surface is bright
      // enough to survive even a tint that is wrong, so the bug hides. This
      // is a brightness a lit scene actually produces.
      ed.scene.world.ambient = 0.3;
      const model = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      ed.selectObject(model.id);
      ed.requestRender();
    });
    await page.waitForTimeout(400);
    const [middle, left] = await samplePixels(page, [[0.5, 0.5], [0.44, 0.52]]);
    for (const [name, px] of [['middle', middle], ['left', left]]) {
      assert.ok(
        px[2] > px[0] * 1.3,
        `selected, the ${name} of the model rendered ${JSON.stringify(px)} — the photograph is under a wash`,
      );
    }
  });

  test('the selection outline stays outside the model it outlines', async () => {
    // The outline is an inverted hull: the mesh again, pushed out along its
    // normals, back faces only, so what is left over is a rim. On a dense
    // organic mesh with a thin lip round it — which is exactly what a
    // photograph produces — the pushed-out far side comes through the near
    // side, and the model wears a hatch of orange slivers that reads as
    // broken geometry rather than as selection.
    //
    // Where the model is on screen is read out of the picture rather than
    // guessed at, because the slivers do not appear in the middle: they
    // gather where the surface turns edge-on, which is off to the side and
    // moves with the framing.
    const hits = await page.evaluate(async () => {
      const ed = window.kline.editor;
      // Lit flat and bright, so "is this pixel the model" is not a judgement
      // call. Whether the hull comes through does not depend on the lighting
      // — the outline is drawn over the top of it — and the orange it is
      // drawn in is nothing a blue subject on a brown floor produces.
      ed.scene.world.ambient = 1;
      const model = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      ed.selectObject(model.id);

      // Drawn and read in the same task: a WebGL drawing buffer is discarded
      // the moment the browser composites, so anything later sees an empty
      // canvas — which reads as "no model on screen" rather than as a failure
      // to look.
      const gl = ed.renderer.gl;
      ed.renderNow();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      // The viewport behind the model is nearly black with a dim grid.
      const model_ = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) model_[j] = luma(i) > 60 ? 1 : 0;

      // Well inside the silhouette: the rim is a few pixels wide, so a pixel
      // with model this far away on all four sides is not on the rim.
      const R = 10;
      const interior = (x, y) => (
        x >= R && y >= R && x + R < w && y + R < h
        && model_[y * w + x] && model_[y * w + x - R] && model_[y * w + x + R]
        && model_[(y - R) * w + x] && model_[(y + R) * w + x]
      );

      let orange = 0;
      let inside = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!interior(x, y)) continue;
          inside++;
          const i = (y * w + x) * 4;
          // The outline colour is a strong orange: red well ahead of green,
          // green well ahead of blue. Nothing in a photograph of a blue
          // subject on a brown floor reaches it.
          if (px[i] > 170 && px[i] > px[i + 1] * 1.35 && px[i + 1] > px[i + 2] * 1.6) orange++;
        }
      }
      return { orange, inside };
    });

    assert.ok(hits.inside > 5000, `only ${hits.inside} pixels of model to look at`);
    assert.ok(
      hits.orange <= hits.inside * 0.002,
      `${hits.orange} of ${hits.inside} pixels inside the model are outline coloured — the hull is coming through`,
    );
  });

  test('rebuilding a photo does not pile up materials and textures', async () => {
    // The object is rebuilt on every settings change, and the texture is
    // applied on every rebuild. Making a fresh material each time meant one
    // per slider event — hundreds of identical orphans in the material list
    // and every one of them written into the saved file.
    const counts = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const panel = window.kline.app.properties.create;
      const before = { materials: ed.scene.materials.length, textures: ed.scene.textures.length };
      for (let i = 0; i < 12; i++) {
        panel.photo.depthScale = 0.5 + i * 0.05;
        panel.generate(true);
      }
      await new Promise((ok) => setTimeout(ok, 400));
      const object = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      const material = ed.scene.materials[object.materialSlots[0]];
      return {
        before,
        after: { materials: ed.scene.materials.length, textures: ed.scene.textures.length },
        slots: object.materialSlots.length,
        textured: material ? material.baseColorTexture : null,
      };
    });

    assert.equal(counts.after.materials, counts.before.materials, `twelve rebuilds added ${counts.after.materials - counts.before.materials} materials`);
    assert.equal(counts.after.textures, counts.before.textures, `twelve rebuilds added ${counts.after.textures - counts.before.textures} textures`);
    // And the model still wears the photograph after all of that.
    assert.equal(counts.slots, 1);
    assert.ok(counts.textured !== null, 'the model lost its texture while being rebuilt');
  });

  // ------------------------------------------------ the mode buttons work

  const modeButtons = () => page.evaluate(() => [...document.querySelectorAll('.mode-opt')].map((b) => ({
    label: b.textContent.trim(),
    active: b.classList.contains('active'),
    dimmed: b.classList.contains('unavailable'),
    title: b.title,
  })));
  const clickMode = async (label) => {
    await page.evaluate((l) => {
      const b = [...document.querySelectorAll('.mode-opt')].find((x) => x.textContent.trim() === l);
      if (!b) throw new Error(`no ${l} button`);
      b.click();
    }, label);
    await page.waitForTimeout(150);
  };

  test('Edit and Sculpt work on the one object in the scene without selecting it first', async () => {
    // Reported as "these buttons don't work". They were wired correctly and
    // did nothing, because Kline starts with nothing active and clicking empty
    // space puts it back there — and with nothing active they refused, looked
    // exactly like buttons that work, and said so only in a line at the bottom
    // of a crowded status bar.
    await resetScene(page);
    await page.evaluate(() => window.kline.run('add.cube'));
    await page.waitForTimeout(120);
    // Deselect, the way clicking empty space does.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.changed();
    });
    await page.waitForTimeout(120);

    assert.deepEqual(
      (await modeButtons()).map((b) => b.dimmed),
      [false, false, false],
      'the buttons look unavailable when there is an obvious object to use',
    );

    await clickMode('Edit');
    assert.equal(await page.evaluate(() => window.kline.editor.mode), 'edit', 'Edit did nothing');
    // And it selected what it chose, so leaving Edit Mode does not drop back
    // into a scene with nothing selected and a dead button again.
    assert.equal(await page.evaluate(() => window.kline.editor.scene.selection.size), 1);

    await clickMode('Sculpt');
    assert.equal(await page.evaluate(() => window.kline.editor.mode), 'sculpt', 'Sculpt did nothing');
    await clickMode('Object');
    assert.equal(await page.evaluate(() => window.kline.editor.mode), 'object');
  });

  test('a button that cannot act looks like it and says why', async () => {
    await resetScene(page);
    const empty = await modeButtons();
    assert.equal(empty.find((b) => b.label === 'Edit').dimmed, true, 'Edit looks usable with an empty scene');
    assert.equal(empty.find((b) => b.label === 'Sculpt').dimmed, true);
    assert.equal(empty.find((b) => b.label === 'Object').dimmed, false, 'Object Mode is always available');
    assert.match(empty.find((b) => b.label === 'Edit').title, /Add a mesh first/);

    // Clicking anyway still answers, rather than swallowing the press: a
    // disabled button would explain nothing to the one person who tries it.
    await clickMode('Edit');
    assert.equal(await page.evaluate(() => window.kline.editor.mode), 'object');
    assert.match(
      await page.evaluate(() => window.kline.editor.statusMessage ?? ''),
      /Add a mesh first/,
    );

    // Two meshes and nothing selected is a real question, so it is asked.
    await page.evaluate(() => {
      const ed = window.kline.editor;
      window.kline.run('add.cube');
      window.kline.run('add.uvsphere');
      ed.scene.selection.clear();
      ed.scene.active = null;
      ed.changed();
    });
    await page.waitForTimeout(150);
    const ambiguous = await modeButtons();
    assert.equal(ambiguous.find((b) => b.label === 'Edit').dimmed, true, 'two candidates should not be guessed between');
    assert.match(ambiguous.find((b) => b.label === 'Edit').title, /Click the object/);
    await clickMode('Edit');
    assert.equal(await page.evaluate(() => window.kline.editor.mode), 'object');
  });

  test('an empty Build box asks for a sentence instead of doing nothing', async () => {
    await resetScene(page);
    const result = await page.evaluate(() => {
      const ed = window.kline.editor;
      const input = document.querySelector('.build-bar input, input.build-input');
      if (input) input.value = '';
      document.querySelector('button.build-go')?.click();
      return { status: ed.statusMessage, focused: document.activeElement === input, objects: ed.scene.objects.size };
    });
    assert.match(result.status, /Say what to build/, 'Go with an empty box said nothing');
    assert.equal(result.focused, true, 'the cursor was not put where the words go');
    assert.equal(result.objects, 0, 'an empty prompt built something anyway');
  });

  test('opening a file gives you that file, not the last one mixed into it', async () => {
    // Undo and File > Open both replaced the whole scene by assigning a
    // remembered list of fields, and both lists were missing textures and the
    // timeline. So opening a file kept the previous scene's images and threw
    // the file's away — and because a material names its texture by id,
    // opening a photo model while a checker happened to hold id 1 put the
    // checker on the model.
    await resetScene(page);
    const result = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const settle = () => new Promise((ok) => setTimeout(ok, 120));

      window.kline.run('add.cube');
      window.kline.run('material.checker');
      await settle();
      ed.scene.timeline.end = 90;
      const file = JSON.parse(JSON.stringify(ed.scene.toJSON()));

      // Work on something else in between, as anyone would.
      ed.loadSceneJSON({ objects: [], order: [], materials: [], textures: [] });
      await settle();
      window.kline.run('add.uvsphere');
      window.kline.run('material.checker');
      await settle();
      // Two more images than the file carries, pushed straight in so the test
      // is about what opening a file does rather than about which command
      // happens to create a texture.
      ed.scene.textures.push(
        { id: 900, name: 'leftover A', url: 'data:image/png;base64,AAAA', width: 8, height: 8 },
        { id: 901, name: 'leftover B', url: 'data:image/png;base64,BBBB', width: 8, height: 8 },
      );
      const between = ed.scene.textures.length;

      ed.loadSceneJSON(file);
      await settle();
      return {
        between,
        fileTextures: file.textures.length,
        fileTimelineEnd: file.timeline.end,
        openedTextures: ed.scene.textures.length,
        openedNames: ed.scene.textures.map((t) => t.name),
        openedTimelineEnd: ed.scene.timeline.end,
        danglingMaterials: ed.scene.materials.filter(
          (m) => m.baseColorTexture !== null && !ed.scene.textures.some((t) => t.id === m.baseColorTexture),
        ).length,
      };
    });

    assert.ok(result.between > result.fileTextures, 'the in-between scene needs more images than the file for this to test anything');
    assert.equal(result.openedTextures, result.fileTextures, `opened a ${result.fileTextures}-image file and got ${result.openedTextures} images`);
    assert.equal(result.danglingMaterials, 0, 'a material points at an image that is not in the scene — that surface renders untextured');
    assert.equal(result.openedTimelineEnd, result.fileTimelineEnd, 'the previous scene\'s frame range survived the open');
  });

  test('undoing a texture takes the texture with it', async () => {
    // Adding a UV checker and undoing left a 33 KB embedded PNG in the
    // document for good, and in every save from then on.
    await resetScene(page);
    const counts = await page.evaluate(async () => {
      const ed = window.kline.editor;
      window.kline.run('add.cube');
      const before = ed.scene.textures.length;
      for (let i = 0; i < 3; i++) {
        window.kline.run('material.checker');
        await new Promise((ok) => setTimeout(ok, 80));
        window.kline.run('edit.undo');
        await new Promise((ok) => setTimeout(ok, 80));
      }
      return { before, after: ed.scene.textures.length, saved: ed.scene.toJSON().textures.length };
    });
    assert.equal(counts.after, counts.before, `three add-and-undo cycles left ${counts.after - counts.before} images behind`);
    assert.equal(counts.saved, counts.before, 'the leftover images would have been written into the saved file');
  });

  test('the whole journey: photo in, model out, saved, reopened, edited, exported', async () => {
    // Each step of this has a test of its own. This one is the chain, because
    // the chain is what somebody actually does, and every fault found in this
    // session lived in a seam between two steps that each worked.
    await resetScene(page);
    const journey = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const settle = (ms = 150) => new Promise((ok) => setTimeout(ok, ms));

      // 1. Drop a photograph on the window.
      const c = document.createElement('canvas');
      c.width = 160; c.height = 220;
      const g = c.getContext('2d');
      const img = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          const inside = ((x - 80) / 48) ** 2 + ((y - 110) / 78) ** 2 < 1;
          const n = ((x * 7 + y * 13) % 29) - 14;
          img.data[o] = (inside ? 60 : 150) + n;
          img.data[o + 1] = (inside ? 80 : 70) + n;
          img.data[o + 2] = (inside ? 200 : 40) + n;
          img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.kline.app.properties.openCreate(new File([blob], 'thing.png', { type: 'image/png' }));
      for (let i = 0; i < 200 && ed.scene.objects.size === 0; i++) await settle(50);
      const built = {
        faces: [...ed.scene.objects.values()][0]?.mesh?.faceCount ?? 0,
        textures: ed.scene.textures.length,
      };

      // 2. Save it.
      const file = JSON.parse(JSON.stringify(ed.scene.toJSON()));

      // 3. Do something else, then reopen it — the seam that was broken.
      ed.loadSceneJSON({ objects: [], order: [], materials: [], textures: [] });
      await settle();
      window.kline.run('add.cube');
      window.kline.run('material.checker');
      await settle();
      ed.loadSceneJSON(file);
      await settle(250);

      const object = [...ed.scene.objects.values()].find((o) => o.type === 'mesh');
      const material = ed.scene.materials[object.materialSlots[0] ?? 0];
      const reopened = {
        faces: object.mesh.faceCount,
        hasUV: object.mesh.hasUV,
        textures: ed.scene.textures.length,
        textureName: ed.scene.textures[0]?.name,
        materialTexture: material?.baseColorTexture ?? null,
        dangling: material && material.baseColorTexture !== null
          && !ed.scene.textures.some((t) => t.id === material.baseColorTexture),
      };

      // 4. Edit it, the way the header button does.
      ed.selectObject(null);
      ed.setMode('edit');
      const editing = { mode: ed.mode, selected: ed.scene.selection.size };
      window.kline.run('select.all');
      window.kline.run('mesh.subdivide');
      await settle();
      const subdivided = ed.editMesh?.faceCount ?? 0;
      window.kline.run('edit.undo');
      await settle();
      const afterUndo = ed.editMesh?.faceCount ?? 0;
      ed.setMode('object');

      // 5. Export it, through the real command, and read what it wrote.
      const written = [];
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => { written.push(blob); return realCreate.call(URL, blob); };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {};
      window.kline.run('file.exportGltf');
      await settle();
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
      const gltf = JSON.parse(await written[written.length - 1].text());
      return {
        built, reopened, editing, subdivided, afterUndo,
        gltf: {
          images: gltf.images?.length ?? 0,
          uv: gltf.meshes?.[0]?.primitives?.[0]?.attributes?.TEXCOORD_0 !== undefined,
          // Whichever material carries the picture — the default one is
          // still in the list and is not it.
          usesTexture: (gltf.materials ?? [])
            .map((m) => m.pbrMetallicRoughness?.baseColorTexture?.index)
            .find((i) => i !== undefined),
          materials: gltf.materials?.length ?? 0,
        },
      };
    });

    assert.ok(journey.built.faces > 500, `the photograph produced ${journey.built.faces} faces`);
    assert.equal(journey.built.textures, 1, 'the photograph was not stored with the model');

    assert.equal(journey.reopened.faces, journey.built.faces, 'reopening changed the model');
    assert.equal(journey.reopened.hasUV, true, 'reopening lost the texture coordinates');
    assert.equal(journey.reopened.textures, 1, `reopening left ${journey.reopened.textures} images in a one-image scene`);
    assert.equal(journey.reopened.textureName, 'thing', 'the reopened model is wearing the wrong picture');
    assert.equal(journey.reopened.dangling, false, 'the material points at an image that is not there');

    assert.equal(journey.editing.mode, 'edit', 'Edit Mode refused the model that was just opened');
    assert.ok(journey.subdivided > journey.built.faces, 'subdividing did nothing');
    assert.equal(journey.afterUndo, journey.built.faces, 'undo did not put the model back');

    assert.equal(journey.gltf.images, 1, 'the export dropped the photograph');
    assert.equal(journey.gltf.uv, true, 'the export dropped the texture coordinates');
    assert.equal(
      journey.gltf.usesTexture, 0,
      `none of the ${journey.gltf.materials} exported materials uses the photograph`,
    );
  });

  test('New Scene leaves nothing of the last one behind', async () => {
    // It removed the objects and stopped, so the materials and the embedded
    // images of whatever had been open stayed — and went into the next file
    // saved. Start something new after a photo model and you shipped the old
    // photograph inside it.
    const after = await page.evaluate(async () => {
      const ed = window.kline.editor;
      window.kline.run('add.cube');
      window.kline.run('material.checker');
      await new Promise((ok) => setTimeout(ok, 120));
      const loaded = { materials: ed.scene.materials.length, textures: ed.scene.textures.length };
      window.kline.run('file.new');
      await new Promise((ok) => setTimeout(ok, 120));
      const doc = ed.scene.toJSON();
      return {
        loaded,
        objects: ed.scene.objects.size,
        materials: ed.scene.materials.length,
        textures: ed.scene.textures.length,
        savedTextures: doc.textures.length,
        undoable: ed.history.steps().length > 0,
      };
    });

    assert.ok(after.loaded.textures > 0, 'the scene under test had no image to leave behind');
    assert.equal(after.objects, 0);
    assert.equal(after.textures, 0, `New Scene kept ${after.textures} image(s) from the previous one`);
    assert.equal(after.materials, 0, `New Scene kept ${after.materials} material(s) from the previous one`);
    assert.equal(after.savedTextures, 0, 'those images would have been written into the next file saved');
    // Starting a new document is one of the things people most want to undo.
    assert.equal(after.undoable, true, 'New Scene cannot be undone');
  });

  // ------------------------------------------------ the ways in

  test('dropping a photograph on the window builds a model', async () => {
    // The way anybody actually starts. Every test above reached the panel
    // through its own method; nothing had ever fired a real drop, so the
    // handler that turns a dragged file into a model was the one step of the
    // headline feature with no cover on it at all.
    await resetScene(page);
    const dropped = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 140; c.height = 190;
      const g = c.getContext('2d');
      const im = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          const inside = ((x - 70) / 40) ** 2 + ((y - 95) / 62) ** 2 < 1;
          im.data[o] = inside ? 60 : 150;
          im.data[o + 1] = inside ? 85 : 72;
          im.data[o + 2] = inside ? 200 : 42;
          im.data[o + 3] = 255;
        }
      }
      g.putImageData(im, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));

      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
      const mount = document.getElementById('app');
      const veil = () => document.querySelector('.drop-veil')?.classList.contains('visible');
      const fire = (type) => mount.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
      );

      fire('dragenter');
      const whileDragging = veil();
      fire('dragover');
      fire('drop');
      const afterDrop = veil();

      const ed = window.kline.editor;
      for (let i = 0; i < 200 && ed.scene.objects.size === 0; i++) {
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const object = [...ed.scene.objects.values()][0];
      return {
        whileDragging,
        afterDrop,
        objects: ed.scene.objects.size,
        faces: object?.mesh?.faceCount ?? 0,
        textures: ed.scene.textures.length,
        tab: document.querySelector('.tab.active')?.textContent?.trim(),
      };
    });

    assert.equal(dropped.whileDragging, true, 'nothing showed the window would take the file');
    assert.equal(dropped.afterDrop, false, 'the drop highlight stayed up afterwards');
    assert.equal(dropped.objects, 1, 'the drop produced no model');
    assert.ok(dropped.faces > 500, `the drop produced ${dropped.faces} faces`);
    assert.equal(dropped.textures, 1, 'the dropped photograph was not kept as a texture');
    assert.equal(dropped.tab, 'Create', 'the panel did not come forward to show the result');
  });

  test('the keys people actually press do what they say', async () => {
    await resetScene(page);
    const press = async (key, opts = {}) => {
      await page.evaluate(([k, o]) => {
        document.activeElement?.blur?.();
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: k,
          code: o.code ?? `Key${k.toUpperCase()}`,
          bubbles: true,
          cancelable: true,
          ctrlKey: !!o.ctrl,
          metaKey: !!o.meta,
          shiftKey: !!o.shift,
        }));
      }, [key, opts]);
      await page.waitForTimeout(120);
    };
    const mode = () => page.evaluate(() => window.kline.editor.mode);
    const count = () => page.evaluate(() => window.kline.editor.scene.objects.size);

    await page.evaluate(() => window.kline.run('add.cube'));
    await page.waitForTimeout(120);

    await press('Tab', { code: 'Tab' });
    assert.equal(await mode(), 'edit', 'Tab did not enter Edit Mode');
    await press('Tab', { code: 'Tab' });
    assert.equal(await mode(), 'object', 'Tab did not come back out');

    await press('k', { ctrl: true });
    assert.equal(
      await page.evaluate(() => !!document.querySelector('.palette:not(.hidden), .command-palette:not(.hidden)')),
      true,
      'Ctrl+K did not open the command palette',
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);

    const before = await count();
    await press('x');
    assert.equal(await count(), before - 1, 'X did not delete the selected object');
    await press('z', { ctrl: true });
    assert.equal(await count(), before, 'Ctrl+Z did not bring it back');
  });

  test('a crash gives the work back, textures included', async () => {
    // Recovery replaces the whole scene, so it went through the same door
    // that was dropping textures and the timeline — meaning a recovered
    // session came back with the geometry and none of the pictures on it.
    await resetScene(page);
    const recovery = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const settle = (ms = 150) => new Promise((ok) => setTimeout(ok, ms));
      window.kline.run('add.cube');
      window.kline.run('material.checker');
      await settle();
      const saved = { objects: ed.scene.objects.size, textures: ed.scene.textures.length };

      const wrote = await ed.autosaveNow(false);
      const slots = await ed.recovery.list();

      // What a crash and restart looks like from here.
      ed.newScene();
      await settle(80);
      const wiped = { objects: ed.scene.objects.size, textures: ed.scene.textures.length };

      const doc = slots[0] ? await ed.recovery.load(slots[0].id) : null;
      if (doc) ed.loadSceneJSON(doc.scene ?? doc);
      await settle();
      return {
        wrote, saved, wiped, slots: slots.length,
        back: { objects: ed.scene.objects.size, textures: ed.scene.textures.length },
      };
    });

    assert.equal(recovery.wrote, true, 'autosave reported failure');
    assert.ok(recovery.slots > 0, 'autosave left nothing to recover from');
    assert.equal(recovery.wiped.objects, 0, 'the scene was not actually cleared before recovering');
    assert.equal(recovery.back.objects, recovery.saved.objects, 'recovery lost objects');
    assert.equal(
      recovery.back.textures, recovery.saved.textures,
      `recovery came back with ${recovery.back.textures} of ${recovery.saved.textures} pictures`,
    );
  });

  test('the recovery prompt is a strip, not the whole window', async () => {
    // The application's shell is a grid, and it declared four rows for six
    // children. The extras were auto-placed, so the moment the recovery bar
    // appeared it took the row meant for the workspace and stretched to the
    // full height of the window: opening Kline with a recovered scene showed
    // a wall of empty brown with two enormous buttons floating in the middle
    // of it, and the 3D view squeezed into what was left.
    //
    // Nothing caught it because every test here starts from a clean store and
    // never sees the bar. This one puts a scene in the store, asks for the
    // prompt, and then measures the shell.
    const shape = await page.evaluate(async () => {
      const ed = window.kline.editor;
      const shell = window.kline.app;
      ed.addPrimitive('cube');
      await ed.autosaveNow(false);
      shell.offerRecovery();
      await new Promise((ok) => setTimeout(ok, 400));

      const bar = document.querySelector('.recovery-bar');
      const shown = bar && !bar.classList.contains('hidden');
      const rect = bar.getBoundingClientRect();
      const work = document.querySelector('.workspace').getBoundingClientRect();
      const view = document.querySelector('.viewport').getBoundingClientRect();
      return {
        shown,
        bar: Math.round(rect.height),
        workspace: Math.round(work.height),
        viewport: Math.round(view.height),
        viewportBottom: Math.round(view.bottom),
        workspaceBottom: Math.round(work.bottom),
        window: window.innerHeight,
        buttons: [...bar.querySelectorAll('.btn')].map((b) => Math.round(b.getBoundingClientRect().width)),
        pageWidth: window.innerWidth,
      };
    });

    assert.equal(shape.shown, true, 'the recovery prompt never appeared, so nothing was measured');
    // One line of controls. It was the better part of 600px.
    assert.ok(
      shape.bar < shape.window * 0.12,
      `the recovery bar is ${shape.bar}px of a ${shape.window}px window`,
    );
    // And the workspace still gets the window, which is the half that matters:
    // the bar being small is no use if it pushed the 3D view off the bottom.
    assert.ok(
      shape.workspace > shape.window * 0.7,
      `the workspace was left ${shape.workspace}px of a ${shape.window}px window`,
    );
    // Buttons in this application grow to fill their container, which is right
    // in a sidebar and wrong in a strip the width of the screen.
    assert.ok(shape.buttons.length >= 2, 'the prompt has no buttons to check');
    for (const w of shape.buttons) {
      assert.ok(
        w < shape.pageWidth * 0.2,
        `a button is ${w}px wide in a ${shape.pageWidth}px window — they are stretching to fill`,
      );
    }

    // And the 3D view fits the room it was given.
    //
    // A grid item will not shrink below its own content, and this one's
    // content is a canvas with a pixel size of its own — so the viewport sized
    // itself to the canvas while the canvas sized itself to the viewport, and
    // the pair settled on whatever the first frame measured. It came out 31px
    // taller than its slot with no bar and 68px taller with one, which put the
    // bottom of the render underneath the timeline where nobody could see it.
    assert.ok(
      shape.viewportBottom <= shape.workspaceBottom + 1,
      `the 3D view runs ${shape.viewportBottom - shape.workspaceBottom}px past the bottom of its container`,
    );
    assert.ok(
      shape.viewport <= shape.workspace + 1,
      `the 3D view is ${shape.viewport}px tall in a ${shape.workspace}px space`,
    );

    await page.evaluate(() => {
      document.querySelector('.recovery-bar').classList.add('hidden');
    });
  });

  test('two strokes on the preview rescue a photograph colour cannot separate', async () => {
    // The honest limit of the photo feature is that a subject photographed
    // against something its own colour cannot be found by colour. The unit
    // tests prove the segmentation obeys a correction; this proves the
    // correction can actually be made — that a drag on the preview reaches the
    // segmenter and the model is rebuilt from it. That path is a canvas, a
    // letterboxed placement and a pointer capture, and none of it is reachable
    // from Node.
    const out = await page.evaluate(async () => {
      const W = 300, H = 380;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const im = g.createImageData(W, H);
      const inSubject = (x, y) => ((x - 150) / 85) ** 2 + ((y - 190) / 150) ** 2 <= 1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const n = ((x * 5 + y * 11) % 17) - 8;
        // Six values apart: a difference you would struggle to see.
        const b = inSubject(x, y) ? [150, 126, 104] : [144, 120, 98];
        im.data[o] = b[0] + n; im.data[o + 1] = b[1] + n; im.data[o + 2] = b[2] + n;
        im.data[o + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.kline.app.properties.openCreate(new File([blob], 'shoe.png', { type: 'image/png' }));
      const ed = window.kline.editor;
      const started = ed.scene.objects.size;
      for (let i = 0; i < 300 && ed.scene.objects.size === started; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 700));

      const panel = window.kline.app.properties.create;
      const verdictText = () => document.querySelector('.create-verdict')?.textContent ?? '';
      const before = {
        coverage: panel.lastCoverage,
        verdict: verdictText(),
        bad: !!document.querySelector('.create-verdict.bad'),
        hasBrush: !!document.querySelector('.brush-controls'),
      };

      const pv = document.querySelector('.ref-preview');
      const rect = pv.getBoundingClientRect();
      const stroke = async (mode, from, to) => {
        // Chosen the way a person chooses it: by pressing the button.
        const btn = [...document.querySelectorAll('.brush-modes .seg')]
          .find((b) => b.textContent.trim().toLowerCase() === mode);
        btn.click();
        const at = (t) => ({
          clientX: rect.left + (from[0] + (to[0] - from[0]) * t) * rect.width,
          clientY: rect.top + (from[1] + (to[1] - from[1]) * t) * rect.height,
        });
        pv.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, ...at(0) }));
        for (let i = 1; i <= 12; i++) {
          pv.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, bubbles: true, ...at(i / 12) }));
        }
        pv.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, ...at(1) }));
        await new Promise((ok) => setTimeout(ok, 700));
      };
      await stroke('subject', [0.42, 0.5], [0.58, 0.5]);
      await stroke('background', [0.06, 0.1], [0.24, 0.1]);

      const model = [...ed.scene.objects.values()].find((o) => o.name.startsWith('Photo'));
      return {
        before,
        after: {
          coverage: panel.lastCoverage,
          verdict: verdictText(),
          good: !!document.querySelector('.create-verdict.good'),
          faces: model ? model.mesh.faceCount : 0,
        },
      };
    });

    assert.equal(out.before.hasBrush, true, 'photo mode offered no way to correct the subject');
    // Unaided, the segmenter gives up and calls the whole frame subject, and
    // the panel has to say so rather than presenting the blob as a result.
    assert.ok(out.before.coverage > 0.95, `unaided coverage was ${out.before.coverage}, expected the whole frame`);
    assert.equal(out.before.bad, true, `the panel did not report the failure: "${out.before.verdict}"`);

    // The subject really covers about 35% of that frame.
    assert.ok(
      Math.abs(out.after.coverage - 0.35) < 0.06,
      `after two strokes the subject came out at ${(out.after.coverage * 100).toFixed(1)}%, not about 35%`,
    );
    assert.equal(out.after.good, true, `the panel still reports a problem: "${out.after.verdict}"`);
    assert.ok(out.after.faces > 500, `the corrected model has ${out.after.faces} faces`);
  });

  test('a photograph with no subject to cut out still becomes geometry', async () => {
    // This is the claim the application is sold on, and it is the one thing
    // the silhouette pipeline cannot do: a picture with no single object to
    // find — a corridor, two things at different distances, converging walls.
    // There is nothing to segment and no outline to inflate, so it goes to the
    // depth network instead. If this test fails, the headline feature is gone.
    //
    // It really loads the 26MB model and really runs it, because the point is
    // that the model is bundled and works with nothing fetched from anywhere.
    const out = await page.evaluate(async () => {
      const W = 480, H = 360;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const im = g.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const t = y / H, horizon = 0.42;
        let r, gg, b;
        if (t < horizon) { r = 130 - t * 50; gg = 145 - t * 50; b = 170 - t * 40; }
        else {
          const f = (t - horizon) / (1 - horizon);
          r = 95 + f * 55; gg = 85 + f * 50; b = 72 + f * 40;
          if (Math.floor(f * 12) % 2 === 0) { r -= 12; gg -= 12; b -= 10; }
        }
        const edge = 0.5 - Math.abs(x / W - 0.5);
        if (t > horizon && edge < 0.06 + (1 - (t - horizon) / (1 - horizon)) * 0.18) {
          r *= 0.55; gg *= 0.55; b *= 0.6;
        }
        if (x > 300 && x < 440 && y > 250 && y < 340) { r = 195; gg = 95; b = 70; }
        if (x > 215 && x < 255 && y > 175 && y < 215) { r = 70; gg = 155; b = 195; }
        im.data[i] = r; im.data[i + 1] = gg; im.data[i + 2] = b; im.data[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      window.kline.app.properties.openCreate(new File([blob], 'corridor.png', { type: 'image/png' }));
      const ed = window.kline.editor;
      const started = ed.scene.objects.size;
      for (let i = 0; i < 300 && ed.scene.objects.size === started; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 400));

      // Chosen and pressed the way a person does it.
      const mode = [...document.querySelectorAll('.mode-btn')]
        .find((b) => b.textContent.trim() === 'Whole Scene');
      if (!mode) return { error: 'there is no Whole Scene mode' };
      mode.click();
      await new Promise((r) => setTimeout(r, 300));
      const build = [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Build the scene');
      if (!build) return { error: 'there is no button to build a scene' };
      build.click();

      const panel = window.kline.app.properties.create;
      for (let i = 0; i < 1500; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const note = panel.sceneNote?.textContent ?? '';
        if (/could not run|no surface/.test(note)) return { error: note };
        if (!/joined up/.test(note)) continue;
        // The object the panel itself built. Searching the scene for "a mesh
        // with a lot of faces" finds whatever an earlier test left lying
        // around, and then measures that instead — which is exactly what it
        // did, and reported the depth ordering backwards for an object that
        // has no depth ordering.
        const model = ed.scene.get(panel.targetId);
        if (!model || !model.mesh) return { error: `reported "${note}" but built nothing` };
        const box = model.mesh.bounds();
        // Where the two boxes ended up, in the model's own coordinates.
        const near = { x: (370 / W - 0.5), z: (0.5 - 295 / H) };
        const far = { x: (235 / W - 0.5), z: (0.5 - 195 / H) };
        const depthNear = (p) => {
          let best = null;
          let bestD = Infinity;
          for (const v of model.mesh.positions) {
            const d = (v.x / (box.max.x - box.min.x) - p.x) ** 2
              + (v.z / (box.max.z - box.min.z) - p.z) ** 2;
            if (d < bestD) { bestD = d; best = v; }
          }
          return best ? best.y : 0;
        };
        return {
          note,
          faces: model.mesh.faceCount,
          hasUV: model.mesh.hasUV,
          width: +(box.max.x - box.min.x).toFixed(2),
          depth: +(box.max.y - box.min.y).toFixed(2),
          nearBoxY: depthNear(near),
          farBoxY: depthNear(far),
          textures: ed.scene.textures.length,
          textured: (() => {
            const slot = model.materialSlots[0];
            const mat = ed.scene.materials[slot];
            return !!mat && mat.baseColorTexture != null;
          })(),
        };
      }
      return { error: 'the depth model never finished' };
    });

    assert.equal(out.error, undefined, `the scene route failed: ${out.error}`);
    assert.ok(out.faces > 5000, `the scene came out with only ${out.faces} faces`);
    assert.equal(out.hasUV, true, 'the scene has no texture coordinates, so the photo cannot go on it');
    assert.ok(out.textures >= 1, 'the photograph was not kept as a texture');
    assert.equal(out.textured, true, 'the scene is not wearing the photograph it was built from');
    assert.ok(out.depth > 0.2, `the scene is ${out.depth} deep, which is a flat sheet`);
    // The whole point: the near box has to come out nearer than the far one.
    // Nearest is towards -Y, so the near box's depth must be the smaller.
    assert.ok(
      out.nearBoxY < out.farBoxY,
      `the near box came out at y=${out.nearBoxY.toFixed(3)} and the far one at `
      + `y=${out.farBoxY.toFixed(3)} — the depth ordering is wrong`,
    );
  });

  test('nothing runs off the side of the window, at any width', async () => {
    // The whole right-hand side of the application used to sit past the edge
    // of the screen: property fields cut in half, a Restore button reading
    // "Re", the shading controls gone entirely. Two causes, both the same
    // mistake — a box that will not shrink below its own content.
    //
    // The workspace is a 42px toolbar, a viewport and a 262px sidebar, so its
    // minimum is over a thousand pixels; as a grid item that minimum grew the
    // shell's only column, and every row stretched to match. It looked like
    // the header overflowing. The header was being dragged along by the row
    // underneath it. Separately, five labelled tabs are wider than the
    // sidebar, and that overflow widened the document by another 71px.
    //
    // Checked at several widths because each fault appeared at a different
    // one, and the wide case looked fine while the narrow case was unusable.
    const widths = [1400, 1180, 980, 880];
    const report = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(250);
      report.push(await page.evaluate(() => {
        const past = [];
        for (const el of document.querySelectorAll('#app *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // The status hint is deliberately allowed to run under its own
          // clip and ellipsis; everything else has to fit.
          if (el.closest('.status-right')) continue;
          if (r.right > window.innerWidth + 1) {
            past.push(`${el.className || el.tagName} +${Math.round(r.right - window.innerWidth)}px`);
          }
        }
        // A tab with neither an icon nor a label is a blank patch you switch
        // panels by guessing at. Hiding the labels on a narrow sidebar was
        // meant to leave the icons; the icon is a span too, so it hid those
        // as well and left five empty 12px tabs at every width up to 1180.
        const tabs = [...document.querySelectorAll('.tab')].map((t) => {
          const r = t.getBoundingClientRect();
          const visible = [...t.children].some((k) => {
            const kr = k.getBoundingClientRect();
            return kr.width > 0 && kr.height > 0;
          });
          return { h: Math.round(r.height), visible };
        });
        return {
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          past: [...new Set(past)].slice(0, 6),
          tabs,
        };
      }));
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(250);

    for (const r of report) {
      assert.deepEqual(r.past, [], `at ${r.width}px these are off the right edge: ${r.past.join(', ')}`);
      assert.equal(
        r.documentWidth, r.width,
        `at ${r.width}px the document is ${r.documentWidth}px wide, so the layout is pushed sideways`,
      );
      assert.ok(r.tabs.length > 0, `no properties tabs found at ${r.width}px`);
      for (const t of r.tabs) {
        assert.equal(t.visible, true, `a properties tab is blank at ${r.width}px — nothing to read or aim at`);
        assert.ok(t.h > 18, `a properties tab is ${t.h}px tall at ${r.width}px`);
      }
    }
  });

  test('nothing logged an error to the console along the way', () => {
    assert.deepEqual(app.consoleErrors, [], `the app logged: ${app.consoleErrors.join(' | ')}`);
  });
}
