const CACHE = 'moneta-fx-v3';
const ASSETS = ['/', '/index.html', '/styles.css', '/js/app.js', '/js/engine.js', '/js/market.js', '/js/store.js', '/js/chart.js', '/js/tutorial.js', '/js/shared.js', '/js/admin.js', '/icon.svg'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); } return response;
  }).catch(() => caches.match(event.request).then(response => response || (event.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});
