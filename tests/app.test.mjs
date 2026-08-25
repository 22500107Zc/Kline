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
      const k = window.kiln, ed = k.editor, S = ed.scene;
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
      const ed = window.kiln.editor;
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
      window.kiln.editor.requestRender();
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

    await page.evaluate(() => { window.kiln.editor.options.shadows = true; });
    const lit = (await samplePixels(page, points)).map(luma);

    await page.evaluate(() => { window.kiln.editor.options.shadows = false; });
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

    await page.evaluate(() => { window.kiln.editor.options.shadows = true; });
  });

  test('no pass leaves a GL error behind, in any mode', async () => {
    await resetScene(page);
    const errors = await page.evaluate(() => {
      const k = window.kiln, ed = k.editor, S = ed.scene;
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
      const k = window.kiln, ed = k.editor;
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
      const k = window.kiln;
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
      const k = window.kiln;
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
      await page.evaluate(() => window.kiln.editor.selection.faces.size), 1,
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
      const ed = window.kiln.editor;
      return { faces: ed.selection.faces.size, modal: ed.modal ? ed.modal.type : null };
    });
    assert.equal(after.modal, null, 'the click should have confirmed the inset');
    // The release used to be read as a click on empty space, and deselect.
    assert.equal(after.faces, 1, 'the inset face should still be selected after confirming');
  });

  test('inset then extrude chains, which is the whole point of keeping it', async () => {
    const top = await cubeWithTopFacePicked();
    const faces = () => page.evaluate(() => window.kiln.editor.editObject.mesh.faceCount);
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
      const k = window.kiln, S = k.editor.scene;
      k.run('add.cube');
      S.get(S.active).position.x = -2.2;
      k.run('add.cube');
      S.get(S.active).position.x = 2.2;
      S.selection.clear();
      S.active = null;
      k.editor.requestRender();
    });
    const count = () => page.evaluate(() => window.kiln.editor.scene.selection.size);

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
      const k = window.kiln, S = k.editor.scene;
      k.run('add.cube');
      S.selection = new Set([S.active]);
      k.editor.requestRender();
    });
    const x = () => page.evaluate(
      () => +window.kiln.editor.scene.get(window.kiln.editor.scene.active).position.x,
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

  test('nothing logged an error to the console along the way', () => {
    assert.deepEqual(app.consoleErrors, [], `the app logged: ${app.consoleErrors.join(' | ')}`);
  });
}
