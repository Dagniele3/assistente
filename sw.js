// Service worker: tiene in cache i file dell'app per aprirla anche offline.
// Strategia: risponde subito dalla cache e intanto scarica la versione nuova per il prossimo avvio.
// Le chiamate ad Apps Script (altro dominio) non passano di qui.
const CACHE = 'assistente-v10';
const FILE = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(chiavi => Promise.all(chiavi.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const inCache = await cache.match(e.request, { ignoreSearch: true });
    const rete = fetch(e.request).then(r => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    }).catch(() => inCache);
    return inCache || rete;
  }));
});
