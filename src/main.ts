import { App } from './ui/App';
import './style.css';

// Registering the worker is what lets browsers install Kiln as a desktop app,
// and what makes it start without a network connection afterwards.
if ('serviceWorker' in navigator && import.meta.env.PROD && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    // Resolve against the page, not this module: the bundle lives in assets/.
    const url = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(url, { scope: import.meta.env.BASE_URL }).catch(() => {
      /* Installing offline support is a bonus; never block startup on it. */
    });
  });
}

const mount = document.getElementById('app');
if (!mount) throw new Error('Kiln could not find its mount point (#app).');

try {
  const app = new App(mount);
  // Scripting handle: `kiln.editor` in the browser console reaches the live
  // scene, the command registry and every mesh operator.
  (window as unknown as { kiln: unknown }).kiln = { app, editor: app.editor };
} catch (err) {
  mount.innerHTML = '';
  const message = err instanceof Error ? err.message : String(err);
  const panel = document.createElement('div');
  panel.className = 'fatal';
  panel.innerHTML = `
    <h1>Kiln could not start</h1>
    <p>${message}</p>
    <p class="dim">Kiln needs WebGL2. Try a recent Chrome, Firefox, Edge or Safari, and make
    sure hardware acceleration is enabled.</p>`;
  mount.appendChild(panel);
  throw err;
}
