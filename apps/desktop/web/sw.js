// Installability + app-shell caching. Documents and API responses always come
// from the network: a stale library listing is worse than an offline notice.
const SHELL_CACHE = 'guzi-shell-v10';
const SHELL_ASSETS = [
  '/library',
  '/web/styles.css',
  '/web/reader-math.css',
  '/web/vendor/cytoscape.min.js',
  '/web/graph-model.js',
  '/web/graph-view.js',
  '/web/app.js',
  '/web/assets/app-icon.png',
  '/web/assets/brand-glyph-96.png',
  '/web/assets/brand-glyph-dark-96.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isShell = SHELL_ASSETS.includes(url.pathname);
  if (!isShell) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error())),
  );
});
