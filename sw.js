/* Offline cache and update delivery.
 *
 * Bumping CACHE is what publishes an update: the browser sees a byte-different
 * sw.js, installs it alongside the running one, and it then WAITS. It does not
 * call skipWaiting on its own - the page shows an "Update available" prompt and
 * only sends SKIP_WAITING when the user accepts, so a match in progress is never
 * reloaded out from under the scorer.
 */
const CACHE = 'khotrack-v27';

const ASSETS = [
  './', './index.html', './styles.css?v=27',
  './share.js?v=27', './app.js?v=27', './scoring.js?v=27', './detail.js?v=27',
  './manifest.webmanifest', './icon-192.png?v=27', './icon-512.png?v=27', './icon-maskable.png?v=27'
];

self.addEventListener('install', e => {
  // no skipWaiting here on purpose - see the note above
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* The page asks to be taken over once the user accepts the update. */
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
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
