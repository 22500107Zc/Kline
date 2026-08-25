/**
 * Enough browser to test the half of Kiln that unit tests cannot reach.
 *
 * Everything below the renderer is pure data and covered by the suite in
 * `tests/`. Everything the user actually looks at — whether a shadow lands on
 * the floor, whether a click leaves the selection intact — lives on the far
 * side of a WebGL context and a pointer event, and no amount of unit testing
 * touches it. Three real bugs shipped through that gap before anyone thought
 * to look at the screen.
 *
 * No test dependency is added for this. Playwright and a Chromium build are
 * used when they happen to be present and the suite skips cleanly when they
 * are not, so `npm test` still runs anywhere Node runs.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * Find a Chromium that can actually be executed.
 *
 * Playwright's own `executablePath()` reports the build its version expects,
 * which is not always the build that is installed — so it is a first guess to
 * be checked, not an answer.
 */
function findChromium(playwright) {
  const candidates = [];
  if (process.env.KILN_CHROMIUM) candidates.push(process.env.KILN_CHROMIUM);
  try {
    candidates.push(playwright.chromium.executablePath());
  } catch {
    // Playwright cannot say; the search below still might.
  }
  const pool = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pool && existsSync(pool)) {
    for (const dir of readdirSync(pool)) {
      if (!dir.startsWith('chromium')) continue;
      for (const layout of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        candidates.push(join(pool, dir, layout));
      }
    }
  }
  candidates.push(
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

/** The newest mtime under a directory, so a stale build can be spotted. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

/**
 * Build the app if `dist` is missing or older than the sources.
 *
 * Testing a stale bundle is worse than not testing at all: it reports on code
 * nobody is running and goes green over a bug that is right there in the
 * working tree.
 */
function ensureBuild() {
  const index = join(DIST, 'index.html');
  if (existsSync(index) && statSync(index).mtimeMs >= newestMtime(join(ROOT, 'src'))) return;
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'ignore' });
}

function serveDist() {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const path = join(DIST, url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, ''));
    if (!path.startsWith(DIST) || !existsSync(path) || statSync(path).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

/**
 * Start the app in a real browser, or explain why it could not be started.
 *
 * Returns `{ skip: reason }` rather than throwing when the environment simply
 * has no browser — a contributor without Playwright installed should see the
 * rest of the suite pass, not a wall of failures about something they did not
 * break.
 */
export async function launchApp() {
  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch {
    return { skip: 'playwright-core is not installed' };
  }
  const executablePath = findChromium(playwright);
  if (!executablePath) return { skip: 'no Chromium build was found' };

  ensureBuild();
  const { server, port } = await serveDist();

  const browser = await playwright.chromium.launch({
    executablePath,
    // SwiftShader so this runs on a machine with no GPU, which is every CI box.
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.kline?.editor?.renderer, null, { timeout: 30_000 });
  // The first frames set up texture arrays and compile programs.
  await page.waitForTimeout(600);

  const rect = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });

  return {
    page,
    consoleErrors,
    /** Middle of the 3D viewport, in page coordinates. */
    centre: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    viewport: rect,
    async close() {
      await browser.close();
      await new Promise((ok) => server.close(ok));
    },
  };
}

/**
 * Wipe the scene and put the camera back, so each test starts from the same
 * place regardless of what the one before it did.
 */
export async function resetScene(page) {
  await page.evaluate(() => {
    const ed = window.kline.editor;
    if (ed.mode !== 'object') window.kline.run('mode.object');
    for (const id of [...ed.scene.objects.keys()]) ed.scene.remove(id);
    ed.scene.selection.clear();
    ed.scene.active = null;
    const c = ed.camera;
    c.target = new (c.target.constructor)(0, 0, 0);
    c.distance = 11;
    c.yaw = -43 * (Math.PI / 180);
    c.pitch = 27 * (Math.PI / 180);
    c.orthographic = false;
    c.lockedMatrix = null;
    ed.requestRender();
  });
}

/**
 * Where a world-space point lands on the page, using the app's own camera.
 *
 * Clicking at a hard-coded offset from the middle of the viewport only works
 * at the viewport size it was written for, and silently picks nothing at any
 * other — which reads as a broken feature rather than a broken test.
 */
export async function screenPoint(page, [x, y, z]) {
  return page.evaluate(([wx, wy, wz]) => {
    const ed = window.kline.editor;
    const r = ed.canvas.getBoundingClientRect();
    const p = ed.camera.worldToScreen(
      new (ed.camera.target.constructor)(wx, wy, wz), r.width, r.height,
    );
    return { x: r.left + p.x, y: r.top + p.y };
  }, [x, y, z]);
}

/**
 * Draw a frame and read the colour at a point in the drawing buffer.
 *
 * Both halves have to happen in one page call: a WebGL drawing buffer is
 * discarded the moment the browser composites, so a read from a later task
 * sees nothing.
 */
export async function samplePixels(page, points) {
  return page.evaluate((pts) => {
    const ed = window.kline.editor;
    const gl = ed.renderer.gl;
    ed.renderNow();
    const out = [];
    const px = new Uint8Array(4);
    for (const [fx, fy] of pts) {
      // Fractions of the canvas, with y measured from the bottom as GL does.
      const x = Math.round(fx * (gl.drawingBufferWidth - 1));
      const y = Math.round((1 - fy) * (gl.drawingBufferHeight - 1));
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.push([px[0], px[1], px[2]]);
    }
    return out;
  }, points);
}

/** Perceived brightness, which is what "is this in shadow" actually asks. */
export function luma([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
