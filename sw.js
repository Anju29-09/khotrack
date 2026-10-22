/* Offline cache. Bumping CACHE retires every older copy on the next load. */
const CACHE = 'khotrack-v26';

const ASSETS = [
  './', './index.html', './styles.css?v=26',
  './share.js?v=26', './app.js?v=26', './scoring.js?v=26', './detail.js?v=26',
  './manifest.webmanifest', './icon-192.png?v=26', './icon-512.png?v=26', './icon-maskable.png?v=26'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network first so edits show up straight away, cache as the offline fallback. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
