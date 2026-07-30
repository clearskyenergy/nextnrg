// ClearSky Builders LLC — Site Map Designer Pro
// Service Worker v2 — cache CDN libs for offline use, NEVER the app itself
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT WAS WRONG WITH v1
//
// 1. The fetch handler was cache-first for EVERY request that was not on the
//    exclusion list, and the exclusion list did not include your own origin:
//
//        caches.match(e.request).then(cached => {
//          if (cached) return cached;      // any cached copy wins, forever
//
//    caches.match() searches every cache, not just this worker's. So once a
//    copy of editor.html existed anywhere, it was served on every load and
//    the network was never consulted.
//
// 2. The purge was keyed on a constant:
//
//        const CACHE = 'clearsky-pro-v1';
//        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
//
//    That deletes caches whose name DIFFERS from the current one. The name
//    never changed, so nothing was ever deleted, and a stale editor.html
//    inside clearsky-pro-v1 was permanent.
//
// Together those meant a deploy could not reach the browser. Unregistering
// the worker fixed it each time and it came back on the next visit.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT v2 DOES
//
// The app shell is never served from cache. HTML documents and anything on
// this origin go to the network first; the cache is a fallback for when you
// are genuinely offline, not a first port of call. Only the four CDN
// libraries are cache-first, which is what this worker was for.
//
// BUMP THE VERSION ON EVERY DEPLOY. It is the one line that has to change:
const VERSION = 'v2-2026-07-30';
const CACHE = 'clearsky-pro-' + VERSION;

// Third-party libraries only. Nothing of ours belongs in here.
const PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@300;400;600;700&display=swap',
];

// Hosts we are willing to cache. An allowlist, so nothing else can slip in.
const CACHEABLE_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// Never intercepted at all — live data and tiles.
const BYPASS = [
  'anthropic.com',
  'firebaseapp.com',
  'firebasestorage.googleapis.com',
  'gstatic.com/firebasejs',
  'googleapis.com/maps',
  'maps.googleapis.com',
  'maps.gstatic.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
];

function isCacheable(url) {
  return CACHEABLE_HOSTS.some(h => url.includes(h));
}
function isBypass(url) {
  return BYPASS.some(h => url.includes(h));
}

// Install — pre-cache the CDN libs, then take over immediately.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(PRECACHE.map(u => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// Activate — delete EVERY cache that is not this exact version. Because the
// version string changes on each deploy, this actually runs.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Let the page force an update without DevTools:
//   navigator.serviceWorker.controller.postMessage('omega-update')
self.addEventListener('message', e => {
  if (e.data === 'omega-update') {
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.skipWaiting());
  }
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = req.url;

  if (req.method !== 'GET') return;
  if (isBypass(url)) return;

  // ── The app shell. Network first, always. ──────────────────────────────
  // A navigation, an HTML document, or anything on our own origin. If the
  // network answers, that answer wins — a deploy is live the moment it
  // lands. The cache is only consulted when the network genuinely fails.
  const sameOrigin = url.startsWith(self.location.origin);
  const isDoc = req.mode === 'navigate'
    || (req.headers.get('accept') || '').includes('text/html');

  if (isDoc || sameOrigin) {
    e.respondWith(
      fetch(req).catch(() => caches.match(req).then(
        hit => hit || new Response('Offline — check your connection', { status: 503 })
      ))
    );
    return;
  }

  // ── Third-party libraries. Cache first, which is the point of this file.
  if (isCacheable(url)) {
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => new Response('Offline — check your connection', { status: 503 }));
      })
    );
    return;
  }

  // ── Anything else: leave it alone. Not caching what we do not understand
  //    is how the app shell ended up stuck in the first place.
});
