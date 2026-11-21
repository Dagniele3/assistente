// Service worker: tiene in cache i file dell'app per aprirla anche offline.
// Strategia: risponde subito dalla cache e intanto scarica la versione nuova.
// v11.1: una versione nuova si attiva alla PRIMA apertura. Il service worker nuovo si installa scaricando i file
// dalla rete (non dalla cache HTTP del browser), prende subito il controllo delle pagine aperte e lo dice loro:
// la pagina (app.js) salva l'appunto aperto e si ricarica una volta da sola, quando non si sta scrivendo.
// Le pagine della versione vecchia (che non sanno ricaricarsi) si ricaricano da qui solo quando sono nascoste.
// Le chiamate ad Apps Script (altro dominio) non passano di qui.
// v12: Appunti a pagina lunga divisa in fogli (titoletti, indice, barra trascinabile).
// v12.2: l'Indice spento nasconde davvero la colonna dei titoletti (app.css .ed-indice[hidden]); tablet in verticale
// con i pannelli di Sezioni e Indice sopra la pagina; colonne e indice ridimensionabili con le maniglie.
// v15: Scadenze senza la scelta Tutte / Casa (si vedono sempre tutte).
const CACHE = 'assistente-v15';
const FILE = ['./', './index.html', './app.css', './appunti.js', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

// pagine che hanno risposto "gestisco" (si ricaricano da sole, in modo sicuro)
const gestite = new Set();
self.addEventListener('message', e => {
  if (e.data === 'gestisco' && e.source) gestite.add(e.source.id);
});

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILE.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(chiavi => Promise.all(chiavi.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(() => { avvisaPagine(); }));   // non aspettato: finché l'attivazione non finisce le richieste resterebbero in attesa
});

const pausa = ms => new Promise(ok => setTimeout(ok, ms));

/** Dice alle pagine aperte che c'è la versione nuova; per 30 s ricarica quelle vecchie appena sono nascoste. */
async function avvisaPagine() {
  const pagine = await self.clients.matchAll({ type: 'window' });
  pagine.forEach(p => p.postMessage('nuova-versione'));
  const fatte = new Set();
  for (let i = 0; i < 10; i++) {
    await pausa(3000);
    const ora = await self.clients.matchAll({ type: 'window' });
    for (const p of ora) {
      if (gestite.has(p.id) || fatte.has(p.id) || p.visibilityState !== 'hidden') continue;
      if (!pagine.some(x => x.id === p.id)) continue;   // aperta dopo l'attivazione: è già nuova
      fatte.add(p.id);
      try { await p.navigate(p.url); } catch (err) { /* pagina chiusa nel frattempo */ }
    }
  }
}

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
