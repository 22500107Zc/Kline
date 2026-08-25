/*
 * Kiln's service worker.
 *
 * Kiln is a single static bundle with no backend, so "offline" just means
 * serving the shell from cache. Stale-while-revalidate keeps the installed app
 * launching instantly while still picking up a rebuild on the next start.
 */

const CACHE = 'kline-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Navigations fall back to the cached shell so the app opens offline.
    if (request.mode === 'navigate') {
      try {
        const fresh = await fetch(request);
        cache.put('./', fresh.clone());
        return fresh;
      } catch {
        return (await cache.match('./')) ?? (await cache.match('./index.html')) ?? Response.error();
      }
    }

    const cached = await cache.match(request);
    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => cached);
    return cached ?? network;
  })());
});
