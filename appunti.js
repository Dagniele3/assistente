/* Assistente v11: sezione Appunti (SPEC v11 §5). Caricato PRIMA di app.js: qui solo dichiarazioni (le funzioni di app.js
 * si usano solo dentro le funzioni, a pagina caricata).
 *
 * Dati
 * - Righe nelle schede "Appunti" e "Sezioni appunti" del foglio: lette con `dati`, scritte con la coda di sempre (`salva`).
 * - La pagina di ogni appunto (tratti, caselle di testo, foto) sta nel dispositivo (IndexedDB "assistente-appunti") e su
 *   Drive (Appunti/<ID>.json, azione appuntoSalva, con l'immagine <ID>.png per Claude in chat). Una pagina cambiata qui è
 *   "sporca" finché lo script non risponde; quelle cambiate altrove si scaricano (appuntiPagine) quando la colonna
 *   "Versione pagina" è diversa da quella che c'è qui.
 *
 * Pagina (JSON): { v: 1, id, modificato: ISO, sfondo: { colore: 'scuro'|'chiaro', motivo: 'vuoto'|'righe'|'quadretti' },
 *   el: [ { t: 'tratto', id, c: colore, s: spessore, ev: evidenziatore?, p: [x0, y0, x1, y1, …] },
 *         { t: 'testo', id, x, y, w, fs, c, html },
 *         { t: 'foto', id, x, y, w, h, f: chiave in foto } ],
 *   foto: { chiave: dataURL } }      coordinate in "punti pagina" (= px CSS con lo zoom al 100 %)
 *
 * Penna: la penna scrive, il dito scorre e fa lo zoom (pointerType); sul PC il mouse scrive con la penna scelta.
 * Prestazioni (Kirin 710A, WebView 114): si disegna solo la parte visibile (riquadro di ogni tratto), niente funzioni recenti.
 */
'use strict';

const AP_FISSE = { daSistemare: 'Da sistemare' };
const AP_COLORI_SEZ = ['#8ab4f8', '#81c995', '#fdd663', '#c58af9', '#f28b82', '#f6a96c', '#78d9ec', '#e8eaed'];
const AP_PENNE_SCURO = ['#e8eaed', '#8ab4f8', '#f28b82', '#81c995', '#fdd663', '#c58af9'];
const AP_PENNE_CHIARO = ['#1a2440', '#1a5fd0', '#c62828', '#2e7d32', '#e0a800', '#7b1fa2'];
const AP_SFONDI = { scuro: { fondo: '#161a20', riga: 'rgba(138,180,248,.13)' }, chiaro: { fondo: '#fbfaf6', riga: 'rgba(26,36,64,.14)' } };
const AP_PASSO = 32;                      // distanza tra le righe / i quadretti dello sfondo
const AP_LARGHEZZA = 1000;                // larghezza minima della pagina (punti)

// ───────────────────────── Memoria del dispositivo (IndexedDB) ─────────────────────────

const apMem = { db: null, apertura: null, riserva: {}, mini: {} };

function apDb() {
  if (apMem.db) return Promise.resolve(apMem.db);
  if (apMem.apertura) return apMem.apertura;
  apMem.apertura = new Promise(ok => {
    // Se il database non si apre entro 4 s (bloccato da un'altra scheda, memoria piena…) si va avanti in memoria,
    // sennò si fermerebbero l'appunto e anche la sincronizzazione. Alla chiamata dopo si riprova.
    let fatto = false;
    const fine = db => { if (fatto) return; fatto = true; if (!db) apMem.apertura = null; ok(db); };
    setTimeout(() => fine(null), 4000);
    let req;
    try { req = indexedDB.open('assistente-appunti', 1); } catch (e) { fine(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pagine')) db.createObjectStore('pagine', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('mini')) db.createObjectStore('mini', { keyPath: 'id' });
    };
    req.onsuccess = () => { apMem.db = req.result; apMem.db.onversionchange = () => { apMem.db.close(); apMem.db = null; apMem.apertura = null; }; fine(apMem.db); };
    req.onerror = () => fine(null);
  });
  return apMem.apertura;
}

function apStore(nome, modo, fn) {
  return apDb().then(db => new Promise(ok => {
    if (!db) { ok(fn(null)); return; }
    let ris;
    try {
      const tx = db.transaction(nome, modo);
      ris = fn(tx.objectStore(nome));
      tx.oncomplete = () => ok(ris && 'result' in ris ? ris.result : ris);
      tx.onerror = () => ok(null);
    } catch (e) { ok(null); }
  }));
}

/** Record della pagina: { id, pagina, base (versione del server da cui parte), sporca } */
function apLeggi(id) {
  return apStore('pagine', 'readonly', st => st ? st.get(id) : null).then(r => r || apMem.riserva[id] || null);
}
function apScrivi(rec) {
  apMem.riserva[rec.id] = rec;   // anche in memoria: se IndexedDB non c'è, almeno fino alla chiusura
  return apStore('pagine', 'readwrite', st => st ? st.put(rec) : null);
}
function apTutti() {
  return apStore('pagine', 'readonly', st => st ? st.getAll() : null).then(r => {
    const m = {};
    (r || []).forEach(x => { m[x.id] = x; });
    Object.keys(apMem.riserva).forEach(k => { if (!m[k]) m[k] = apMem.riserva[k]; });
    return Object.keys(m).map(k => m[k]);
  });
}
function apMiniLeggi(id) { return apStore('mini', 'readonly', st => st ? st.get(id) : null); }
function apMiniScrivi(rec) { return apStore('mini', 'readwrite', st => st ? st.put(rec) : null); }

let apSporche = 0;   // pagine non ancora inviate (per "N in coda")
function apContaSporche() { return apTutti().then(t => { apSporche = t.filter(x => x.sporca).length; return apSporche; }); }

// ───────────────────────── Righe (schede Appunti e Sezioni appunti) ─────────────────────────

function apRighe() { return (dati.schede && dati.schede.Appunti) || []; }
function apSezioni() { return (dati.schede && dati.schede['Sezioni appunti']) || []; }
function apRiga(id) { return apRighe().find(r => r.ID === id) || null; }
function apVivo(r) { return !r['Eliminato il'] && r.Archiviato !== true; }
function apSezDi(r) { return String(r.Sezione || '') || AP_FISSE.daSistemare; }
function apQuando(r) { const a = r['Modificato il'] || '', b = r['Versione pagina'] || ''; return a > b ? a : b; }

/** Salva campi di una riga Appunti; se c'è già un'operazione in coda per lo stesso appunto la aggiorna (meno invii). */
function apSalvaRiga(id, valori, subito) {
  const op = coda.find(o => o.scheda === 'Appunti' && o.tipo === 'salva' && o.id === id && !o._inviata);   // mai in una già partita
  if (op) {
    Object.assign(op.valori, valori);
    op.modificato = new Date().toISOString();
    applicaLocale(op);
    persisti();
  } else {
    if (!apRiga(id) && !valori['Creato il']) valori['Creato il'] = new Date().toISOString();
    salva('Appunti', valori, id);
  }
  pianificaSync(subito ? 600 : 6000);
}

function apFigli(nome) { return apSezioni().filter(s => String(s['Sezione madre'] || '') === nome).sort(apPerOrdine); }
function apPrimoLivello() { return apSezioni().filter(s => !s['Sezione madre']).sort(apPerOrdine); }
function apPerOrdine(a, b) { return (Number(a.Ordine) || 0) - (Number(b.Ordine) || 0) || String(a.Nome).localeCompare(String(b.Nome)); }
function apColoreSez(nome) { const s = apSezioni().find(x => x.Nome === nome && !x['Sezione madre']); return (s && s.Colore) || '#8ab4f8'; }

// ───────────────────────── Stato della vista ─────────────────────────

const AP = {
  sel: 'ds',            // 'ds' Da sistemare | 'tutte' | 'archivio' | 'cestino' | 'S|Lavoro' | 'S|Lavoro|Backorder'
  cerca: '', fissati: false, daFare: false,
  ordine: null,         // 'modifica' | 'mano' (letto da LS alla prima apertura)
  aperto: null,         // id dell'appunto aperto
  ed: null,             // editor aperto
  pannello: 'sezioni',  // sul telefono: quale colonna si vede
};

function apNomeSel(sel) {
  if (sel === 'ds') return AP_FISSE.daSistemare;
  if (sel === 'tutte') return 'Tutti gli appunti';
  if (sel === 'archivio') return 'Archivio';
  if (sel === 'cestino') return 'Cestino';
  const p = sel.split('|');
  return p[2] ? p[1] + ' › ' + p[2] : p[1];
}

function apFiltrati() {
  const q = normalizza(AP.cerca);
  let l = apRighe().filter(r => r.ID);
  if (q) l = l.filter(r => !r['Eliminato il'] && (normalizza(r.Titolo).indexOf(q) >= 0 || normalizza(r.Testo).indexOf(q) >= 0));
  else if (AP.sel === 'cestino') l = l.filter(r => r['Eliminato il']);
  else if (AP.sel === 'archivio') l = l.filter(r => !r['Eliminato il'] && r.Archiviato === true);
  else {
    l = l.filter(apVivo);
    if (AP.sel === 'ds') l = l.filter(r => apSezDi(r) === AP_FISSE.daSistemare);
    else if (AP.sel.indexOf('S|') === 0) {
      const p = AP.sel.split('|');
      l = l.filter(r => apSezDi(r) === p[1] && (!p[2] || String(r.Sottosezione || '') === p[2]));
    }
  }
  if (AP.fissati) l = l.filter(r => r.Fissato === true);
  if (AP.daFare) l = l.filter(r => n(r['Da spuntare']) > 0);
  const mano = AP.ordine === 'mano' && !q;
  return l.sort((a, b) => {
    if ((a.Fissato === true) !== (b.Fissato === true)) return a.Fissato === true ? -1 : 1;
    if (mano) { const d = (Number(a.Ordine) || 1e9) - (Number(b.Ordine) || 1e9); if (d) return d; }
    return apQuando(a) < apQuando(b) ? 1 : -1;
  });
}

function apConta(fn) { return apRighe().filter(r => apVivo(r) && fn(r)).length; }

// ───────────────────────── Vista ─────────────────────────

function vistaAppunti(main, query) {
  document.body.classList.add('pagina-appunti');
  if (AP.ordine == null) AP.ordine = LS.get('apOrdine', 'modifica');
  if (query.get('nuovo')) { apNuovo(); return; }
  if (query.get('rapido')) { history.replaceState(null, '', '#/appunti'); apriRapido(); }
  const sel = query.get('s'), aperto = query.get('a');
  if (sel) AP.sel = sel;
  AP.pannello = aperto ? 'appunto' : sel ? 'elenco' : 'sezioni';
  let guscio = $('.ap-guscio', main);
  if (!guscio) {
    main.innerHTML = `<div class="ap-guscio">
      <aside class="ap-col ap-sez" id="ap-sez"></aside>
      <section class="ap-col ap-elenco" id="ap-elenco"></section>
      <section class="ap-col ap-pagina" id="ap-pagina"></section></div>`;
    guscio = $('.ap-guscio', main);
    if (LS.get('apLarga', false)) guscio.classList.add('ap-larga');
  }
  guscio.dataset.pannello = AP.pannello;
  apDisegnaSezioni();
  apDisegnaElenco();
  if (aperto && aperto !== AP.aperto) apApri(aperto);
  else if (!aperto && AP.aperto) apChiudiEditor();
  else if (!aperto && !$('#ap-pagina .ap-vuota', main)) apPaginaVuota();
  else if (AP.ed) AP.ed.aggiornaTesta();
}

function apVai(param, sostituisci) {
  const q = new URLSearchParams();
  const s = param.s != null ? param.s : AP.sel, a = param.a !== undefined ? param.a : AP.aperto;
  if (s) q.set('s', s);
  if (a) q.set('a', a);
  const h = '#/appunti?' + q.toString();
  if (sostituisci) { location.replace(h); return; }
  location.hash = h;
}

function apDisegnaSezioni() {
  const box = $('#ap-sez');
  if (!box) return;
  const cerca = box.querySelector('#ap-cerca');
  const focus = document.activeElement === cerca;
  const voce = (sel, etichetta, conta, extra, cls) => `<div class="ap-voce ${cls || ''} ${AP.sel === sel && !AP.cerca ? 'attiva' : ''}" data-sel="${esc(sel)}" ${extra || ''}>
      ${etichetta}<span class="ap-conta">${conta || ''}</span></div>`;
  let h = `<div class="ap-testa-sez"><h1>✎ Appunti</h1><button type="button" class="ap-icona" id="ap-nuovo" title="Nuovo appunto">＋</button></div>
    <input id="ap-cerca" type="search" placeholder="⌕ cerca nei titoli e nel testo…" value="${esc(AP.cerca)}">
    <div class="chips ap-filtri">
      <button type="button" class="chip ${!AP.fissati && !AP.daFare ? 'attivo' : ''}" data-f="tutte">Tutte</button>
      <button type="button" class="chip ${AP.fissati ? 'attivo' : ''}" data-f="fissati">📌 fissati</button>
      <button type="button" class="chip ${AP.daFare ? 'attivo' : ''}" data-f="dafare">☐ da fare</button>
    </div>
    ${voce('ds', '📥 Da sistemare', apConta(r => apSezDi(r) === AP_FISSE.daSistemare), '', 'ap-ds')}
    <div class="ap-albero">`;
  apPrimoLivello().forEach(s => {
    const nome = String(s.Nome);
    h += voce('S|' + nome, `<span class="pallino" style="background:${esc(s.Colore || '#8ab4f8')}"></span><span class="ap-nome">${esc(nome)}</span>`,
      apConta(r => apSezDi(r) === nome), `data-sezione="${esc(s.ID)}"`, 'ap-l1');
    apFigli(nome).forEach(f => {
      h += voce('S|' + nome + '|' + f.Nome, `<span class="ap-freccia">›</span><span class="ap-nome">${esc(f.Nome)}</span>`,
        apConta(r => apSezDi(r) === nome && r.Sottosezione === f.Nome), `data-sezione="${esc(f.ID)}"`, 'ap-l2');
    });
  });
  h += `</div>
    <div class="ap-aggiungi"><button type="button" class="link" id="ap-piu-sez">＋ sezione</button> · <button type="button" class="link" id="ap-piu-sotto">＋ sottosezione</button></div>
    <div class="ap-fondo">
      ${voce('tutte', '🗂 Tutti gli appunti', apConta(() => true))}
      ${voce('archivio', '🗄 Archivio', apRighe().filter(r => !r['Eliminato il'] && r.Archiviato === true).length)}
      ${voce('cestino', '🗑 Cestino', apRighe().filter(r => r['Eliminato il']).length)}
      <p class="piccolo">Cestino: si svuota da solo dopo ${numPar('Appunti: giorni nel cestino', 30)} giorni; "ripristina" è sempre possibile prima.
      Tieni premuto o trascina un appunto su una sezione per spostarlo.</p>
    </div>`;
  box.innerHTML = h;
  const c = $('#ap-cerca', box);
  if (focus) { c.focus(); c.setSelectionRange(c.value.length, c.value.length); }
  c.oninput = () => { AP.cerca = c.value; apDisegnaElenco(); $$('.ap-voce', box).forEach(v => v.classList.toggle('attiva', !AP.cerca && v.dataset.sel === AP.sel)); if (innerWidth < 900 && AP.cerca) { AP.pannello = 'elenco'; $('.ap-guscio').dataset.pannello = 'elenco'; } };
  $$('.ap-filtri .chip', box).forEach(b => b.onclick = () => {
    const f = b.dataset.f;
    if (f === 'tutte') { AP.fissati = false; AP.daFare = false; }
    if (f === 'fissati') AP.fissati = !AP.fissati;
    if (f === 'dafare') AP.daFare = !AP.daFare;
    apDisegnaSezioni(); apDisegnaElenco();
  });
  $$('.ap-voce', box).forEach(v => {
    v.onclick = e => {
      if (e.target.closest('.ap-menu-btn')) return;
      AP.cerca = ''; AP.pannello = 'elenco';
      apVai({ s: v.dataset.sel, a: innerWidth < 900 ? null : AP.aperto });
    };
    if (v.dataset.sezione) {
      v.insertAdjacentHTML('beforeend', '<button type="button" class="ap-menu-btn" title="Sezione: rinomina, colore, sposta, elimina">⋯</button>');
      v.querySelector('.ap-menu-btn').onclick = e => { e.stopPropagation(); apMenuSezione(v.dataset.sezione, e.currentTarget); };
      apTrascinabile(v, { tipo: 'sezione', id: v.dataset.sezione });
    }
  });
  $('#ap-nuovo', box).onclick = () => apNuovo();
  $('#ap-piu-sez', box).onclick = () => apNuovaSezione(null);
  $('#ap-piu-sotto', box).onclick = () => {
    const p = AP.sel.split('|');
    if (p[0] === 'S') apNuovaSezione(p[1]);
    else apScegli('Sottosezione di quale sezione?', apPrimoLivello().map(s => [s.Nome, s.Nome])).then(m => { if (m) apNuovaSezione(m); });
  };
}

function apDisegnaElenco() {
  const box = $('#ap-elenco');
  if (!box) return;
  const l = apFiltrati();
  const titolo = AP.cerca ? 'Ricerca «' + esc(AP.cerca) + '» · ' + l.length : esc(apNomeSel(AP.sel));
  const cestino = AP.sel === 'cestino' && !AP.cerca;
  box.innerHTML = `<div class="ap-testa-elenco">
      <button type="button" class="ap-indietro" data-p="sezioni">‹</button>
      <h2>${titolo}</h2>
      ${cestino ? '' : `<select id="ap-ordine" aria-label="Ordine"><option value="modifica" ${AP.ordine === 'modifica' ? 'selected' : ''}>ultima modifica</option><option value="mano" ${AP.ordine === 'mano' ? 'selected' : ''}>a mano</option></select>`}
    </div>
    <ul class="ap-lista">${l.map(r => apVoceElenco(r, cestino)).join('') || `<li class="vuoto">${AP.cerca ? 'Nessun appunto trovato' : cestino ? 'Il cestino è vuoto' : 'Nessun appunto qui. ＋ per scriverne uno.'}</li>`}</ul>`;
  const o = $('#ap-ordine', box);
  if (o) o.onchange = () => { AP.ordine = o.value; LS.set('apOrdine', o.value); apDisegnaElenco(); };
  $('.ap-indietro', box).onclick = () => { AP.pannello = 'sezioni'; $('.ap-guscio').dataset.pannello = 'sezioni'; };
  $$('.ap-lista li[data-id]', box).forEach(li => {
    const id = li.dataset.id;
    li.onclick = e => {
      if (e.target.closest('[data-az]')) return;
      if (li._trascinato) { li._trascinato = false; return; }
      apVai({ a: id });
    };
    $$('[data-az]', li).forEach(b => b.onclick = e => {
      e.stopPropagation();
      if (b.dataset.az === 'ripristina') apRipristina(id);
      if (b.dataset.az === 'menu') apMenuAppunto(id, b);
    });
    if (!cestino) apTrascinabile(li, { tipo: 'appunto', id });
    apMiniatura(id, li.querySelector('.ap-mini'));
  });
}

function apVoceElenco(r, cestino) {
  const d = n(r['Da spuntare']);
  const quando = apQuando(r) || r['Creato il'];
  const sez = AP.sel === 'tutte' || AP.cerca ? '<span class="ap-dove">' + esc(apSezDi(r) + (r.Sottosezione ? ' › ' + r.Sottosezione : '')) + '</span> · ' : '';
  return `<li data-id="${esc(r.ID)}" class="${r.ID === AP.aperto ? 'aperto' : ''}">
    <div class="ap-mini"></div>
    <div class="corpo">
      <div class="ap-titolo">${r.Fissato === true ? '📌 ' : ''}${esc(r.Titolo || 'Senza titolo')}</div>
      <div class="sotto">${sez}${esc(apData(quando))}${cestino ? ' · nel cestino dal ' + esc(apData(r['Eliminato il'])) : ''}</div>
      ${d ? `<span class="ap-dafare">☐ ${d} da fare</span>` : ''}
      ${r['Proposta Claude'] ? '<span class="ap-proposta-chip">✳ proposta</span>' : ''}
    </div>
    ${cestino ? '<button type="button" class="chip" data-az="ripristina">↺ ripristina</button>' : '<button type="button" class="ap-menu-btn" data-az="menu" title="Sposta, fissa, archivia, elimina">⋯</button>'}
  </li>`;
}

function apData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const g = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  const ora = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (g === 0) return 'oggi ' + ora;
  if (g === 1) return 'ieri ' + ora;
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: g > 300 ? 'numeric' : undefined });
}

function apPaginaVuota() {
  const box = $('#ap-pagina');
  if (!box) return;
  box.innerHTML = `<div class="ap-vuota"><p>Scegli un appunto a sinistra o scrivine uno nuovo.</p>
    <button type="button" class="primario" id="ap-nuovo2">＋ appunto</button>
    <p class="piccolo">Sul tablet la penna scrive e il dito scorre; due dita = zoom. Sul PC: tasto T per scrivere con la tastiera, Ctrl + rotellina = zoom.</p></div>`;
  $('#ap-nuovo2', box).onclick = () => apNuovo();
}

// ───────────────────────── Azioni sugli appunti ─────────────────────────

function apTitoloAuto(d) {
  d = d || new Date();
  return 'Appunto ' + d.getDate() + '/' + (d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function apPaginaNuova(id, motivo) {
  return { v: 1, id, modificato: new Date().toISOString(), sfondo: { colore: 'scuro', motivo: motivo || 'quadretti' }, el: [], foto: {} };
}

/** Appunto nuovo: nella sezione che si sta guardando (o in Da sistemare) e aperto subito. */
function apNuovo(sezione, sotto) {
  const id = nuovoId();
  let s = sezione, ss = sotto || '';
  if (!s) {
    const p = AP.sel.split('|');
    if (p[0] === 'S') { s = p[1]; ss = p[2] || ''; } else s = AP_FISSE.daSistemare;
  }
  const adesso = new Date();
  apSalvaRiga(id, { 'Titolo': apTitoloAuto(adesso), 'Sezione': s, 'Sottosezione': ss, 'Creato il': adesso.toISOString(), 'Fissato': false, 'Archiviato': false, 'Testo': '', 'Da spuntare': 0 });
  apScrivi({ id, pagina: apPaginaNuova(id), base: '', sporca: true }).then(() => {
    AP.nuovoTitolo = id;
    apVai({ s: s === AP_FISSE.daSistemare ? 'ds' : 'S|' + s + (ss ? '|' + ss : ''), a: id }, percorso().query.get('nuovo'));
  });
}

function apSposta(id, sezione, sotto) {
  apSalvaRiga(id, { 'Sezione': sezione, 'Sottosezione': sotto || '', 'Archiviato': false, 'Eliminato il': '' }, true);
  toast('Spostato in ' + sezione + (sotto ? ' › ' + sotto : ''));
  apAggiornaTutto();
}

function apElimina(id) {
  apSalvaRiga(id, { 'Eliminato il': new Date().toISOString() }, true);
  toast('Nel cestino: si può ripristinare per ' + numPar('Appunti: giorni nel cestino', 30) + ' giorni');
  if (AP.aperto === id) apVai({ a: null }); else apAggiornaTutto();
}

function apRipristina(id) {
  const r = apRiga(id);
  const s = r ? apSezDi(r) : AP_FISSE.daSistemare;
  // se la sezione non c'è più torna in Da sistemare
  const esiste = s === AP_FISSE.daSistemare || apSezioni().some(x => x.Nome === s && !x['Sezione madre']);
  apSalvaRiga(id, Object.assign({ 'Eliminato il': '', 'Archiviato': false }, esiste ? {} : { 'Sezione': AP_FISSE.daSistemare, 'Sottosezione': '' }), true);
  toast('Ripristinato');
  apAggiornaTutto();
}

function apAggiornaTutto() { apDisegnaSezioni(); apDisegnaElenco(); if (AP.ed) AP.ed.aggiornaTesta(); }

function apDestinazioni() {
  const out = [[AP_FISSE.daSistemare + '|', '📥 ' + AP_FISSE.daSistemare]];
  apPrimoLivello().forEach(s => {
    out.push([s.Nome + '|', s.Nome]);
    apFigli(s.Nome).forEach(f => out.push([s.Nome + '|' + f.Nome, '    › ' + f.Nome]));
  });
  return out;
}

function apMenuAppunto(id, vicino) {
  const r = apRiga(id) || {};
  apMenu(vicino, [
    ['Sposta in…', () => apScegli('Sposta «' + (r.Titolo || 'appunto') + '» in…', apDestinazioni()).then(v => { if (v) { const p = v.split('|'); apSposta(id, p[0], p[1]); } })],
    [r.Fissato === true ? 'Togli 📌' : '📌 Fissa in cima', () => { apSalvaRiga(id, { 'Fissato': r.Fissato !== true }, true); apAggiornaTutto(); }],
    [r.Archiviato === true ? 'Togli dall\'archivio' : '🗄 Archivia', () => { apSalvaRiga(id, { 'Archiviato': r.Archiviato !== true }, true); apAggiornaTutto(); }],
    ['⧉ Duplica', () => apDuplica(id)],
    ['🗑 Elimina', () => apElimina(id), 'rosso'],
  ]);
}

function apDuplica(id) {
  const r = apRiga(id) || {};
  apLeggi(id).then(rec => {
    const nuovo = nuovoId();
    const p = JSON.parse(JSON.stringify((rec && rec.pagina) || apPaginaNuova(nuovo)));
    p.id = nuovo; p.modificato = new Date().toISOString();
    apSalvaRiga(nuovo, { 'Titolo': (r.Titolo || 'Appunto') + ' (copia)', 'Sezione': apSezDi(r), 'Sottosezione': r.Sottosezione || '', 'Testo': r.Testo || '', 'Da spuntare': n(r['Da spuntare']), 'Creato il': new Date().toISOString() }, true);
    apScrivi({ id: nuovo, pagina: p, base: '', sporca: true }).then(() => { toast('Copia creata'); apAggiornaTutto(); });
  });
}

// ───────────────────────── Sezioni ─────────────────────────

function apNuovaSezione(madre) {
  apChiedi(madre ? 'Nuova sottosezione in «' + madre + '»' : 'Nuova sezione', '').then(nome => {
    nome = (nome || '').trim().replace(/[|›]/g, '-');
    if (!nome) return;
    if (nome === AP_FISSE.daSistemare || apSezioni().some(s => s.Nome === nome && String(s['Sezione madre'] || '') === (madre || ''))) { toast('C\'è già'); return; }
    const fratelli = madre ? apFigli(madre) : apPrimoLivello();
    salva('Sezioni appunti', { 'Nome': nome, 'Sezione madre': madre || '', 'Colore': madre ? '' : AP_COLORI_SEZ[fratelli.length % AP_COLORI_SEZ.length], 'Ordine': fratelli.length + 1 });
    pianificaSync(1500);
    apVai({ s: 'S|' + (madre ? madre + '|' + nome : nome) });
    apAggiornaTutto();
  });
}

function apMenuSezione(idSez, vicino) {
  const s = apSezioni().find(x => x.ID === idSez);
  if (!s) return;
  const madre = String(s['Sezione madre'] || '');
  const voci = [['Rinomina', () => apRinominaSezione(s)]];
  if (!madre) {
    voci.push(['Colore', () => apScegli('Colore di «' + s.Nome + '»', AP_COLORI_SEZ.map(c => [c, '<span class="pallino" style="background:' + c + '"></span> ' + c]), true)
      .then(c => { if (c) { salva('Sezioni appunti', { 'Colore': c }, s.ID); pianificaSync(1500); apAggiornaTutto(); } })]);
    voci.push(['＋ Sottosezione', () => apNuovaSezione(s.Nome)]);
  } else {
    voci.push(['Sposta in un\'altra sezione', () => apScegli('Sposta «' + s.Nome + '» in…', apPrimoLivello().filter(x => x.Nome !== madre).map(x => [x.Nome, x.Nome]))
      .then(m => { if (m) apSpostaSottosezione(s, m); })]);
  }
  voci.push(['🗑 Elimina', () => apEliminaSezione(s), 'rosso']);
  apMenu(vicino, voci);
}

function apRinominaSezione(s) {
  apChiedi('Nuovo nome per «' + s.Nome + '»', s.Nome).then(nome => {
    nome = (nome || '').trim().replace(/[|›]/g, '-');
    if (!nome || nome === s.Nome) return;
    const vecchio = s.Nome, madre = String(s['Sezione madre'] || '');
    salva('Sezioni appunti', { 'Nome': nome }, s.ID);
    if (!madre) {
      apSezioni().filter(f => f['Sezione madre'] === vecchio).forEach(f => salva('Sezioni appunti', { 'Sezione madre': nome }, f.ID));
      apRighe().filter(r => r.Sezione === vecchio).forEach(r => apSalvaRiga(r.ID, { 'Sezione': nome }));
      if (AP.sel.split('|')[1] === vecchio) AP.sel = AP.sel.replace('S|' + vecchio, 'S|' + nome);
    } else {
      apRighe().filter(r => r.Sezione === madre && r.Sottosezione === vecchio).forEach(r => apSalvaRiga(r.ID, { 'Sottosezione': nome }));
      if (AP.sel === 'S|' + madre + '|' + vecchio) AP.sel = 'S|' + madre + '|' + nome;
    }
    pianificaSync(1500);
    apVai({});
    apAggiornaTutto();
  });
}

function apSpostaSottosezione(s, nuovaMadre) {
  const madre = s['Sezione madre'];
  if (apFigli(nuovaMadre).some(f => f.Nome === s.Nome)) { toast('In «' + nuovaMadre + '» c\'è già «' + s.Nome + '»'); return; }
  salva('Sezioni appunti', { 'Sezione madre': nuovaMadre, 'Ordine': apFigli(nuovaMadre).length + 1 }, s.ID);
  apRighe().filter(r => r.Sezione === madre && r.Sottosezione === s.Nome).forEach(r => apSalvaRiga(r.ID, { 'Sezione': nuovaMadre }));
  pianificaSync(1500);
  toast('«' + s.Nome + '» ora è in «' + nuovaMadre + '»');
  apVai({ s: 'S|' + nuovaMadre + '|' + s.Nome });
  apAggiornaTutto();
}

function apEliminaSezione(s) {
  const madre = String(s['Sezione madre'] || '');
  const dentro = apRighe().filter(r => madre ? r.Sezione === madre && r.Sottosezione === s.Nome : r.Sezione === s.Nome);
  const figli = madre ? [] : apFigli(s.Nome);
  apConferma('Eliminare «' + s.Nome + '»?' + (figli.length ? ' (anche le sue ' + figli.length + ' sottosezioni)' : '') +
    (dentro.length ? ' I suoi ' + dentro.length + ' appunti vanno in Da sistemare: non si perde niente.' : '')).then(si => {
    if (!si) return;
    dentro.forEach(r => apSalvaRiga(r.ID, { 'Sezione': AP_FISSE.daSistemare, 'Sottosezione': '' }));
    figli.forEach(f => elimina('Sezioni appunti', f.ID));
    elimina('Sezioni appunti', s.ID);
    pianificaSync(1500);
    apVai({ s: 'ds' });
    apAggiornaTutto();
  });
}

/** Nuovo ordine dei fratelli dopo un trascinamento (sezioni o sottosezioni). */
function apRiordinaSezioni(idSpostata, idPrima) {
  const s = apSezioni().find(x => x.ID === idSpostata), t = apSezioni().find(x => x.ID === idPrima);
  if (!s || !t) return;
  if (String(s['Sezione madre'] || '') !== String(t['Sezione madre'] || '')) {
    // sottosezione lasciata su una sottosezione di un'altra sezione: si sposta là
    if (s['Sezione madre'] && t['Sezione madre']) { apSpostaSottosezione(s, t['Sezione madre']); }
    return;
  }
  const madre = String(s['Sezione madre'] || '');
  const l = (madre ? apFigli(madre) : apPrimoLivello()).filter(x => x.ID !== s.ID);
  l.splice(l.indexOf(t), 0, s);
  l.forEach((x, i) => { if (Number(x.Ordine) !== i + 1) salva('Sezioni appunti', { 'Ordine': i + 1 }, x.ID); });
  pianificaSync(1500);
  apAggiornaTutto();
}

function apRiordinaAppunti(idSpostato, idPrima) {
  const l = apFiltrati().filter(r => r.ID !== idSpostato);
  const i = l.findIndex(r => r.ID === idPrima);
  l.splice(i < 0 ? l.length : i, 0, apRiga(idSpostato));
  l.forEach((r, k) => { if (Number(r.Ordine) !== k + 1) apSalvaRiga(r.ID, { 'Ordine': k + 1 }); });
  if (AP.ordine !== 'mano') { AP.ordine = 'mano'; LS.set('apOrdine', 'mano'); toast('Ordine «a mano»'); }
  pianificaSync(1500);
  apDisegnaElenco();
}

// ───────────────────────── Trascinare (appunti su una sezione, sezioni tra loro) ─────────────────────────
// Mouse: si trascina subito (oltre 6 px). Penna e dito: tieni premuto ~0,45 s; senza muoverti si apre il menu.

function apTrascinabile(el, cosa) {
  el.addEventListener('pointerdown', e => {
    if (e.button > 0 || e.target.closest('button,input,select')) return;
    const x0 = e.clientX, y0 = e.clientY, mouse = e.pointerType === 'mouse';
    let attivo = false, fantasma = null, sopra = null, timer = null, mosso = false;
    const inizia = () => {
      attivo = true;
      el._trascinato = true;
      fantasma = el.cloneNode(true);
      fantasma.className += ' ap-fantasma';
      fantasma.style.width = el.offsetWidth + 'px';
      document.body.appendChild(fantasma);
      try { el.setPointerCapture(e.pointerId); } catch (er) { /* niente */ }
      if (navigator.vibrate) try { navigator.vibrate(15); } catch (er) { /* niente */ }
    };
    if (!mouse) timer = setTimeout(() => { if (!mosso) inizia(); }, 450);
    const muovi = ev => {
      const d = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (!attivo) {
        if (d > 8) mosso = true;
        if (mouse && d > 6) inizia(); else return;
      }
      ev.preventDefault();
      fantasma.style.transform = 'translate(' + (ev.clientX + 8) + 'px,' + (ev.clientY + 8) + 'px)';
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const bersaglio = t && (t.closest('.ap-voce') || (cosa.tipo === 'appunto' ? t.closest('.ap-lista li[data-id]') : null));
      if (sopra && sopra !== bersaglio) sopra.classList.remove('ap-sopra');
      sopra = bersaglio && bersaglio !== el ? bersaglio : null;
      if (sopra) sopra.classList.add('ap-sopra');
    };
    const fine = ev => {
      clearTimeout(timer);
      el.removeEventListener('pointermove', muovi);
      el.removeEventListener('pointerup', fine);
      el.removeEventListener('pointercancel', fine);
      if (!attivo) {
        // pressione lunga senza muoversi (penna o dito) = menu
        if (!mouse && !mosso && ev.type === 'pointerup' && ev.timeStamp - e.timeStamp > 450) {
          el._trascinato = true;
          if (cosa.tipo === 'appunto') apMenuAppunto(cosa.id, el); else apMenuSezione(cosa.id, el);
        }
        return;
      }
      if (fantasma) fantasma.remove();
      if (sopra) sopra.classList.remove('ap-sopra');
      if (!sopra || ev.type === 'pointercancel') return;
      if (cosa.tipo === 'appunto') {
        if (sopra.dataset.id) apRiordinaAppunti(cosa.id, sopra.dataset.id);
        else apLasciaSu(cosa.id, sopra.dataset.sel);
      } else if (sopra.dataset.sezione) apRiordinaSezioni(cosa.id, sopra.dataset.sezione);
      else if (cosa.tipo === 'sezione' && sopra.dataset.sel) {
        const s = apSezioni().find(x => x.ID === cosa.id), p = sopra.dataset.sel.split('|');
        if (s && s['Sezione madre'] && p[0] === 'S' && !p[2] && p[1] !== s['Sezione madre']) apSpostaSottosezione(s, p[1]);
      }
    };
    el.addEventListener('pointermove', muovi);
    el.addEventListener('pointerup', fine);
    el.addEventListener('pointercancel', fine);
  });
}

function apLasciaSu(id, sel) {
  if (sel === 'ds') apSposta(id, AP_FISSE.daSistemare, '');
  else if (sel === 'archivio') { apSalvaRiga(id, { 'Archiviato': true }, true); toast('Archiviato'); apAggiornaTutto(); }
  else if (sel === 'cestino') apElimina(id);
  else if (sel && sel.indexOf('S|') === 0) { const p = sel.split('|'); apSposta(id, p[1], p[2] || ''); }
}

// ───────────────────────── Piccole finestre (niente prompt/confirm: nella WebView del tablet non sono sicuri) ─────────────────────────

function apFinestra(html, cls) {
  const sf = document.createElement('div');
  sf.className = 'ap-velo';
  sf.innerHTML = `<div class="ap-finestra ${cls || ''}">${html}</div>`;
  document.body.appendChild(sf);
  return sf;
}

function apChiedi(titolo, valore) {
  return new Promise(ok => {
    const sf = apFinestra(`<h3>${esc(titolo)}</h3><input id="ap-chiedi" value="${esc(valore || '')}">
      <div class="ap-bottoni"><button type="button" data-v="0">Annulla</button><button type="button" class="primario" data-v="1">OK</button></div>`);
    const inp = $('#ap-chiedi', sf);
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const chiudi = v => { sf.remove(); ok(v ? inp.value : null); };
    $$('button', sf).forEach(b => b.onclick = () => chiudi(b.dataset.v === '1'));
    inp.onkeydown = e => { if (e.key === 'Enter') chiudi(true); if (e.key === 'Escape') chiudi(false); };
    sf.onclick = e => { if (e.target === sf) chiudi(false); };
  });
}

function apConferma(testo) {
  return new Promise(ok => {
    const sf = apFinestra(`<p>${esc(testo)}</p><div class="ap-bottoni"><button type="button" data-v="0">Annulla</button><button type="button" class="primario" data-v="1">Sì</button></div>`);
    $$('button', sf).forEach(b => b.onclick = () => { sf.remove(); ok(b.dataset.v === '1'); });
    sf.onclick = e => { if (e.target === sf) { sf.remove(); ok(false); } };
  });
}

/** Scelta da un elenco [valore, etichetta HTML o testo]. */
function apScegli(titolo, voci, html) {
  return new Promise(ok => {
    const sf = apFinestra(`<h3>${esc(titolo)}</h3><div class="ap-scelte">${voci.map(v => `<button type="button" data-v="${esc(v[0])}">${html ? v[1] : esc(v[1])}</button>`).join('') || '<p class="piccolo">Niente da scegliere</p>'}</div>
      <div class="ap-bottoni"><button type="button" data-annulla="1">Annulla</button></div>`);
    $$('button', sf).forEach(b => b.onclick = () => { sf.remove(); ok(b.dataset.annulla ? null : b.dataset.v); });
    sf.onclick = e => { if (e.target === sf) { sf.remove(); ok(null); } };
  });
}

function apMenu(vicino, voci) {
  const sf = document.createElement('div');
  sf.className = 'ap-velo ap-velo-menu';
  sf.innerHTML = '<div class="ap-menu">' + voci.map((v, i) => `<button type="button" data-i="${i}" class="${v[2] || ''}">${esc(v[0])}</button>`).join('') + '</div>';
  document.body.appendChild(sf);
  const m = $('.ap-menu', sf), r = vicino.getBoundingClientRect();
  const x = Math.min(innerWidth - m.offsetWidth - 8, Math.max(8, r.right - m.offsetWidth));
  const y = r.bottom + m.offsetHeight + 8 > innerHeight ? Math.max(8, r.top - m.offsetHeight - 4) : r.bottom + 4;
  m.style.left = x + 'px'; m.style.top = y + 'px';
  sf.onclick = e => {
    const b = e.target.closest('button');
    sf.remove();
    if (b) voci[Number(b.dataset.i)][1]();
  };
}

// ───────────────────────── Appunto aperto ─────────────────────────

function apChiudiEditor() {
  if (AP.ed) { AP.ed.salvaSubito(); AP.ed.distruggi(); }
  AP.ed = null; AP.aperto = null;
  document.body.classList.remove('ap-tutto');
  apPaginaVuota();
}

function apApri(id) {
  if (AP.ed) { AP.ed.salvaSubito(); AP.ed.distruggi(); AP.ed = null; }
  AP.aperto = id;
  $$('.ap-lista li').forEach(li => li.classList.toggle('aperto', li.dataset.id === id));
  const box = $('#ap-pagina');
  box.innerHTML = '<div class="ap-vuota"><p>Apro…</p></div>';
  apLeggi(id).then(rec => {
    if (AP.aperto !== id) return;
    if (!rec) {
      const r = apRiga(id);
      if (r && r['Versione pagina']) {
        box.innerHTML = '<div class="ap-vuota"><p>Scarico la pagina…</p></div>';
        apScaricaPagine([id]).then(() => apLeggi(id)).then(rec2 => { if (AP.aperto === id) apMontaEditor(box, id, rec2 || { id, pagina: apPaginaNuova(id, 'quadretti'), base: '', sporca: false }); })
          .catch(() => { if (AP.aperto === id) box.innerHTML = '<div class="ap-vuota"><p>Questa pagina non è ancora su questo dispositivo e adesso non c\'è rete.</p></div>'; });
        return;
      }
      rec = { id, pagina: apPaginaNuova(id), base: '', sporca: false };
    }
    apMontaEditor(box, id, rec);
  });
}

/** v11.1: si sta scrivendo? (la pagina aspetta a ricaricarsi per la versione nuova) */
function apOccupato() { return !!(AP.ed && AP.ed.inUso && AP.ed.inUso()) || !!apRapidoAperto; }
/** v11.1: prima di ricaricare: salva subito l'appunto aperto e aspetta che sia scritto (la lettura segue la scrittura). */
async function apPrimaDiRicaricare() {
  if (!AP.ed) return;
  AP.ed.salvaSubito();
  if (AP.aperto) await apLeggi(AP.aperto);
}

function apMontaEditor(box, id, rec) {
  const r = apRiga(id) || {};
  const sola = !!r['Eliminato il'];
  box.innerHTML = `<div class="ap-testa-app">
      <div class="ap-dove-riga">
        <button type="button" class="ap-indietro" title="Indietro">‹</button>
        <span class="piccolo">Sezione</span><select id="ap-sez-sel"></select><span class="ap-sotto-sep">›</span><select id="ap-sotto-sel"></select>
        <button type="button" class="ap-icona" id="ap-fissa" title="Fissa in cima">📌</button>
        <button type="button" class="ap-icona" id="ap-piu" title="Altro">⋯</button>
        <button type="button" class="ap-icona ap-solo-largo" id="ap-larga" title="Pagina a tutta larghezza (nasconde le colonne a sinistra)">⤢</button>
        <button type="button" class="ap-icona" id="ap-tutto" title="Tutto schermo: resta solo la pagina (Esc per uscire)">⛶</button>
        <button type="button" class="ap-icona ap-solo-telefono" id="ap-strumenti" title="Strumenti per scrivere">✎</button>
      </div>
      <input id="ap-titolo" class="ap-titolo-in" value="${esc(r.Titolo || '')}" placeholder="Titolo" ${sola ? 'disabled' : ''}>
    </div>
    <div id="ap-proposta"></div>
    <div class="ap-editor" id="ap-editor"></div>
    <button type="button" class="ap-tutto-btn" id="ap-tutto-btn" title="Strumenti (trascina per spostare)">✎</button>`;
  $('.ap-indietro', box).onclick = () => { AP.pannello = 'elenco'; apVai({ a: null }); };
  const ed = creaEditor($('#ap-editor', box), rec.pagina, { soloLettura: sola, salvataggio: pagina => apPaginaCambiata(id, pagina), spostaIn: apSpostaSelezione });
  ed.id = id;
  ed.rec = rec;
  AP.ed = ed;
  const tit = $('#ap-titolo', box);
  tit.oninput = () => { apSalvaRiga(id, { 'Titolo': tit.value.trim() || 'Senza titolo' }); const li = $('.ap-lista li[data-id="' + id + '"] .ap-titolo'); if (li) li.textContent = (apRiga(id).Fissato === true ? '📌 ' : '') + (tit.value || 'Senza titolo'); };
  if (AP.nuovoTitolo === id) { AP.nuovoTitolo = null; setTimeout(() => { tit.focus(); tit.select(); }, 60); }
  $('#ap-fissa', box).onclick = () => { const x = apRiga(id); apSalvaRiga(id, { 'Fissato': !(x && x.Fissato === true) }, true); apAggiornaTutto(); };
  $('#ap-piu', box).onclick = e => apMenuAppunto(id, e.currentTarget);
  $('#ap-larga', box).onclick = () => { const g = $('.ap-guscio'); g.classList.toggle('ap-larga'); LS.set('apLarga', g.classList.contains('ap-larga')); $('#ap-larga').classList.toggle('attivo', g.classList.contains('ap-larga')); };
  $('#ap-larga', box).classList.toggle('attivo', $('.ap-guscio').classList.contains('ap-larga'));
  // telefono: si legge; la barra degli strumenti compare con ✎
  $('#ap-strumenti', box).onclick = () => { const e = $('#ap-editor'); e.classList.toggle('con-barra'); $('#ap-strumenti').classList.toggle('attivo', e.classList.contains('con-barra')); };
  ed.aggiornaTesta = () => apTestaEditor(id);
  ed.aggiornaTesta();
  apMontaTutto(box, sola);
}

// ───────────────────────── v11.1: tutto schermo ─────────────────────────

/** Entra/esce dal tutto schermo (la scelta si ricorda: riaprendo un appunto si torna come l'ultima volta). */
function apTutto(si) {
  document.body.classList.toggle('ap-tutto', !!si);
  LS.set('apTutto', !!si);
  const e = $('#ap-editor');
  if (e) e.classList.remove('barra-su');
}

function apMontaTutto(box, sola) {
  // nella barra degli strumenti: "esci dal tutto schermo" (visibile solo a tutto schermo)
  const barra = $('.ed-barra', box);
  if (barra) {
    const esci = document.createElement('button');
    esci.type = 'button'; esci.className = 'ap-esci-tutto'; esci.title = 'Esci dal tutto schermo (Esc)';
    esci.innerHTML = '<span>⤡</span><small>esci</small>';
    esci.onclick = () => apTutto(false);
    barra.appendChild(esci);
  }
  $('#ap-tutto', box).onclick = () => apTutto(true);
  const btn = $('#ap-tutto-btn', box);
  const metti = (x, y) => {
    const W = box.clientWidth || window.innerWidth, H = box.clientHeight || window.innerHeight;
    x = Math.max(4, Math.min(W - 38, x)); y = Math.max(4, Math.min(H - 38, y));
    btn.style.left = x + 'px'; btn.style.top = y + 'px';
    return { x, y };
  };
  const pos = LS.get('apTuttoPos', null);
  if (pos) { btn.style.left = pos.x + 'px'; btn.style.top = pos.y + 'px'; } else { btn.style.right = '8px'; btn.style.top = '8px'; }
  // tocco = barra degli strumenti sopra la pagina (o via); trascinamento = sposta il pulsantino
  btn.addEventListener('pointerdown', ev => {
    ev.preventDefault(); ev.stopPropagation();
    const r0 = btn.getBoundingClientRect(), rb = box.getBoundingClientRect();
    const dx = ev.clientX - r0.left, dy = ev.clientY - r0.top, x0 = ev.clientX, y0 = ev.clientY;
    let mosso = false, ultimo = null;
    try { btn.setPointerCapture(ev.pointerId); } catch (e) { /* niente */ }
    const muovi = e => {
      if (!mosso && Math.hypot(e.clientX - x0, e.clientY - y0) < 8) return;
      mosso = true; btn.style.right = '';
      ultimo = metti(e.clientX - rb.left - dx, e.clientY - rb.top - dy);
    };
    const fine = () => {
      btn.removeEventListener('pointermove', muovi); btn.removeEventListener('pointerup', fine); btn.removeEventListener('pointercancel', fine);
      if (mosso) { if (ultimo) LS.set('apTuttoPos', ultimo); return; }
      if (!sola) $('#ap-editor').classList.toggle('barra-su');
    };
    btn.addEventListener('pointermove', muovi); btn.addEventListener('pointerup', fine); btn.addEventListener('pointercancel', fine);
  });
  if (LS.get('apTutto', false)) apTutto(true);
}

document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && document.body.classList.contains('ap-tutto') && !document.querySelector('.ap-velo')) { ev.preventDefault(); apTutto(false); }
});

function apTestaEditor(id) {
  const r = apRiga(id) || {};
  const ss = $('#ap-sez-sel'), so = $('#ap-sotto-sel');
  if (!ss) return;
  const sez = apSezDi(r);
  ss.innerHTML = [AP_FISSE.daSistemare].concat(apPrimoLivello().map(s => s.Nome)).map(x => `<option ${x === sez ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const figli = sez === AP_FISSE.daSistemare ? [] : apFigli(sez);
  so.innerHTML = '<option value="">—</option>' + figli.map(f => `<option ${f.Nome === r.Sottosezione ? 'selected' : ''}>${esc(f.Nome)}</option>`).join('');
  so.style.display = figli.length ? '' : 'none';
  $('.ap-sotto-sep').style.display = figli.length ? '' : 'none';
  ss.onchange = () => apSposta(id, ss.value, '');
  so.onchange = () => apSposta(id, ss.value, so.value);
  $('#ap-fissa').classList.toggle('attivo', r.Fissato === true);
  const tit = $('#ap-titolo');
  if (tit && document.activeElement !== tit && r.Titolo != null && tit.value !== r.Titolo) tit.value = r.Titolo;
  apMostraProposta(id);
  apStatoSalvato();
}

function apStatoSalvato() {
  // v11.1: l'indicatore nella barra dell'appunto è stato tolto (basta la testata: "N in coda" conta anche le pagine)
  const el = $('#ap-salvato');
  if (!el || !AP.ed) return;
  const rec = AP.ed.rec;
  const ora = statoSync.ultimo ? new Date(statoSync.ultimo).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '';
  el.textContent = rec && rec.sporca ? '● salvato sul dispositivo · da inviare' : '● sincronizzato' + (ora ? ' ' + ora : '');
  el.classList.toggle('da-inviare', !!(rec && rec.sporca));
}

/** Ogni modifica della pagina: memoria del dispositivo subito, riga (testo per la ricerca, caselle) e invio poco dopo. */
function apPaginaCambiata(id, pagina) {
  const ed = AP.ed && AP.ed.id === id ? AP.ed : null;
  const rec = ed ? ed.rec : { id, base: '' };
  pagina.modificato = new Date().toISOString();
  rec.pagina = pagina;
  rec.sporca = true;
  apScrivi(rec);
  const info = apInfoPagina(pagina);
  const r = apRiga(id) || {};
  if (r.Testo !== info.testo || n(r['Da spuntare']) !== info.daSpuntare) apSalvaRiga(id, { 'Testo': info.testo, 'Da spuntare': info.daSpuntare });
  else pianificaSync(6000);
  apSporche = Math.max(apSporche, 1);
  apStatoSalvato();
  aggiornaStato();
  apMem.mini[id] = null;
}

/** Testo scritto a tastiera (per la ricerca) e caselle ancora da spuntare. */
function apInfoPagina(p) {
  const d = document.createElement('div');
  let testo = '', daSpuntare = 0;
  (p.el || []).filter(e => e.t === 'testo').sort((a, b) => a.y - b.y).forEach(e => {
    d.innerHTML = e.html || '';
    $$('li, div, p, br, ul, ol', d).forEach(x => { x.insertAdjacentText('beforebegin', '\n'); x.insertAdjacentText('afterend', '\n'); });
    testo += d.textContent.replace(/\n{2,}/g, '\n').trim() + '\n';
    daSpuntare += $$('ul.ed-spunta > li:not(.fatto)', d).length;
  });
  return { testo: testo.trim().slice(0, 20000), daSpuntare };
}

// ───────────────────────── Proposta di Claude (colonna "Proposta Claude", scritta dalla chat) ─────────────────────────
// Formato (una o più righe):  "SEZIONE: Lavoro › Backorder"   e/o   "TESTO: …" (il testo può andare a capo; "- " = elenco,
// "[] " = casella da spuntare). Accetta: SEZIONE sposta l'appunto (crea la sezione se manca), TESTO diventa una casella di
// testo in fondo alla pagina. Scarta: la colonna si svuota. Mai niente sovrascritto senza "Accetta".

function apLeggiProposta(s) {
  const out = { sezione: null, testo: null, altro: '' };
  const m = String(s || '').match(/SEZIONE:\s*([^\n]+)/i);
  if (m) { const p = m[1].split(/\s*(?:›|>|\/)\s*/); out.sezione = [p[0].trim(), (p[1] || '').trim()]; }
  const t = String(s || '').match(/TESTO:\s*([\s\S]*?)(?=\n\s*SEZIONE:|$)/i);
  if (t) out.testo = t[1].trim();
  if (!m && !t) out.altro = String(s || '').trim();
  return out;
}

function apMostraProposta(id) {
  const box = $('#ap-proposta');
  if (!box) return;
  const r = apRiga(id) || {};
  const s = String(r['Proposta Claude'] || '').trim();
  if (!s) { box.innerHTML = ''; return; }
  const p = apLeggiProposta(s);
  box.innerHTML = `<div class="ap-proposta"><span class="ap-stella">✳</span><div class="corpo"><b>Proposta Claude</b> (dalla chat)
      ${p.sezione ? ' · sposta in <b>' + esc(p.sezione[0] + (p.sezione[1] ? ' › ' + p.sezione[1] : '')) + '</b>' : ''}
      ${p.testo != null ? '<div class="ap-proposta-testo">' + esc(p.testo) + '</div>' : ''}${p.altro ? '<div class="ap-proposta-testo">' + esc(p.altro) + '</div>' : ''}</div>
      <button type="button" class="primario" id="ap-accetta">Accetta</button><button type="button" id="ap-scarta">Scarta</button></div>`;
  $('#ap-scarta', box).onclick = () => { apSalvaRiga(id, { 'Proposta Claude': '' }, true); box.innerHTML = ''; apDisegnaElenco(); };
  $('#ap-accetta', box).onclick = () => {
    if (p.testo != null || p.altro) { if (AP.ed) AP.ed.aggiungiTesto(apTestoInHtml(p.testo != null ? p.testo : p.altro)); }
    if (p.sezione) {
      const [sz, sotto] = p.sezione;
      if (sz && sz !== AP_FISSE.daSistemare && !apPrimoLivello().some(x => x.Nome === sz)) salva('Sezioni appunti', { 'Nome': sz, 'Sezione madre': '', 'Colore': AP_COLORI_SEZ[apPrimoLivello().length % AP_COLORI_SEZ.length], 'Ordine': apPrimoLivello().length + 1 });
      if (sotto && !apFigli(sz).some(x => x.Nome === sotto)) salva('Sezioni appunti', { 'Nome': sotto, 'Sezione madre': sz, 'Colore': '', 'Ordine': apFigli(sz).length + 1 });
      apSalvaRiga(id, { 'Sezione': sz || AP_FISSE.daSistemare, 'Sottosezione': sotto || '' });
    }
    apSalvaRiga(id, { 'Proposta Claude': '' }, true);
    box.innerHTML = '';
    toast('Proposta accettata');
    apAggiornaTutto();
  };
}

function apTestoInHtml(t) {
  const righe = String(t || '').split(/\n/);
  let html = '', lista = null;
  const chiudi = () => { if (lista) { html += '</ul>'; lista = null; } };
  righe.forEach(rg => {
    const c = rg.match(/^\s*\[( |x)?\]\s+(.*)$/i), b = rg.match(/^\s*[-•*]\s+(.*)$/);
    if (c) { if (lista !== 'spunta') { chiudi(); html += '<ul class="ed-spunta">'; lista = 'spunta'; } html += `<li${c[1] && c[1].toLowerCase() === 'x' ? ' class="fatto"' : ''}>${esc(c[2])}</li>`; }
    else if (b) { if (lista !== 'punti') { chiudi(); html += '<ul>'; lista = 'punti'; } html += '<li>' + esc(b[1]) + '</li>'; }
    else { chiudi(); html += '<div>' + (esc(rg) || '<br>') + '</div>'; }
  });
  chiudi();
  return html;
}

// ───────────────────────── Sincronizzazione delle pagine (chiamata da sincronizza() di app.js) ─────────────────────────

/** Invia le pagine cambiate su questo dispositivo (una alla volta: c'è l'immagine). */
async function appuntiInvia() {
  const tutte = await apTutti();
  const sporche = tutte.filter(x => x.sporca);
  apSporche = sporche.length;
  for (const rec of sporche) {
    const r = apRiga(rec.id);
    if (r && r['Eliminato il'] && !rec.base) { rec.sporca = false; await apScrivi(rec); continue; }   // nuovo e già nel cestino
    const pagina = rec.pagina;
    const inviata = pagina.modificato;
    let immagine = '';
    try { immagine = await rendiPaginaPng(pagina); } catch (e) { immagine = ''; }
    const valori = r ? { 'Titolo': r.Titolo, 'Sezione': apSezDi(r), 'Sottosezione': r.Sottosezione || '', 'Creato il': r['Creato il'] } : null;
    const j = await api('appuntoSalva', { id: rec.id, base: rec.base || '', pagina: JSON.stringify(pagina), immagine, valori });
    const ora = (await apLeggi(rec.id)) || rec;
    if (j.esito === 'conflitto' && !j.vinto) {
      // ha vinto la versione del server: questa è diventata la copia in conflitto; la pagina si riscarica
      ora.sporca = false; ora.base = ''; ora.scarica = true;
      toast('Appunto cambiato anche su un altro dispositivo: questa versione è in Da sistemare come «copia in conflitto»');
    } else {
      ora.base = j.versione;
      if (ora.pagina && ora.pagina.modificato === inviata) ora.sporca = false;   // cambiata intanto: resta da inviare
      if (j.copia) toast('Conflitto: l\'altra versione è in Da sistemare come «' + j.copia.titolo + '»');
    }
    await apScrivi(ora);
    if (AP.ed && AP.ed.id === rec.id) { AP.ed.rec = ora; }
    if (r) { r['Versione pagina'] = j.versione; }
  }
  await apContaSporche();
}

/** Scarica le pagine cambiate altrove (colonna "Versione pagina" diversa da quella del dispositivo). */
async function appuntiScarica() {
  const tutte = await apTutti();
  const qui = {};
  tutte.forEach(x => { qui[x.id] = x; });
  const da = apRighe().filter(r => {
    if (!r.ID || !r['Versione pagina']) return false;
    const x = qui[r.ID];
    if (!x) return !r['Eliminato il'];
    if (x.sporca) return false;
    return x.scarica || x.base !== r['Versione pagina'];
  }).map(r => r.ID);
  for (let i = 0; i < da.length && i < 90; i += 10) await apScaricaPagine(da.slice(i, i + 10));
  if (da.length) apDisegnaElenco();
}

async function apScaricaPagine(ids) {
  const j = await api('appuntiPagine', { ids });
  for (const id of Object.keys(j.pagine || {})) {
    let p;
    try { p = JSON.parse(j.pagine[id]); } catch (e) { continue; }
    const vecchio = await apLeggi(id);
    if (vecchio && vecchio.sporca) continue;
    const rec = { id, pagina: p, base: p.modificato, sporca: false };
    await apScrivi(rec);
    apMem.mini[id] = null;
    if (AP.ed && AP.ed.id === id && !AP.ed.inUso()) { AP.ed.rec = rec; AP.ed.carica(p); }
  }
}

// ───────────────────────── Miniature ─────────────────────────

function apMiniatura(id, box) {
  if (!box) return;
  const r = apRiga(id) || {};
  const ver = r['Versione pagina'] || r['Modificato il'] || '';
  if (apMem.mini[id] && apMem.mini[id].ver === ver) { box.style.backgroundImage = 'url(' + apMem.mini[id].url + ')'; return; }
  apLeggi(id).then(rec => {
    if (!rec) return;
    const v = rec.pagina.modificato;
    apMiniLeggi(id).then(m => {
      if (m && m.ver === v) { apMem.mini[id] = { ver, url: m.url }; box.style.backgroundImage = 'url(' + m.url + ')'; return; }
      rendiMiniatura(rec.pagina).then(url => {
        if (!url) return;
        apMem.mini[id] = { ver, url };
        apMiniScrivi({ id, ver: v, url });
        box.style.backgroundImage = 'url(' + url + ')';
      });
    });
  });
}

// ───────────────────────── Disegno della pagina (schermo, immagine per Claude, miniature) ─────────────────────────

const apImmagini = {};
function apImmagine(src) {
  if (apImmagini[src]) return apImmagini[src];
  const im = new Image();
  im.pronta = new Promise(ok => { im.onload = () => ok(im); im.onerror = () => ok(null); });
  im.src = src;
  apImmagini[src] = im;
  return im;
}

function apRiquadro(e) {
  if (e._bb) return e._bb;
  if (e.t === 'tratto') {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < e.p.length; i += 2) { const x = e.p[i], y = e.p[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const m = e.s / 2 + 1;
    Object.defineProperty(e, '_bb', { value: { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m }, writable: true, enumerable: false, configurable: true });
  } else {
    const h = e.t === 'testo' ? (e._h || 40) : e.h;
    return { x0: e.x, y0: e.y, x1: e.x + (e.w || 0), y1: e.y + h };
  }
  return e._bb;
}
function apTogliRiquadro(e) { if (e && e._bb) e._bb = null; }

function apSfondo(c, sfondo, x0, y0, x1, y1) {
  const s = AP_SFONDI[(sfondo && sfondo.colore) || 'scuro'] || AP_SFONDI.scuro;
  c.fillStyle = s.fondo;
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
  const motivo = (sfondo && sfondo.motivo) || 'vuoto';
  if (motivo === 'vuoto') return;
  c.strokeStyle = s.riga;
  c.lineWidth = 1;
  c.beginPath();
  for (let y = Math.ceil(y0 / AP_PASSO) * AP_PASSO; y <= y1; y += AP_PASSO) { c.moveTo(x0, y + 0.5); c.lineTo(x1, y + 0.5); }
  if (motivo === 'quadretti') for (let x = Math.ceil(x0 / AP_PASSO) * AP_PASSO; x <= x1; x += AP_PASSO) { c.moveTo(x + 0.5, y0); c.lineTo(x + 0.5, y1); }
  c.stroke();
}

function apTratto(c, e) {
  const p = e.p;
  c.strokeStyle = e.c; c.fillStyle = e.c;
  c.globalAlpha = e.ev ? 0.38 : 1;
  c.lineWidth = e.s;
  c.lineCap = e.ev ? 'square' : 'round'; c.lineJoin = 'round';
  if (p.length <= 2 || (p.length === 4 && p[0] === p[2] && p[1] === p[3])) {
    c.beginPath(); c.arc(p[0], p[1], e.s / 2, 0, Math.PI * 2); c.fill();
  } else {
    c.beginPath();
    c.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
      c.quadraticCurveTo(p[i], p[i + 1], mx, my);
    }
    c.lineTo(p[p.length - 2], p[p.length - 1]);
    c.stroke();
  }
  c.globalAlpha = 1;
}

/** Disegna gli elementi (tratti e foto; le caselle di testo solo se conTesto) che toccano il riquadro visibile. */
function apDisegnaElementi(c, pagina, v, conTesto) {
  const foto = pagina.foto || {};
  (pagina.el || []).forEach(e => {
    if (e.t === 'testo' && !conTesto) return;
    const b = e.t === 'testo' ? { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + (e._h || apAltezzaTesto(c, e)) } : apRiquadro(e);
    if (b.x1 < v.x0 || b.x0 > v.x1 || b.y1 < v.y0 || b.y0 > v.y1) return;
    if (e.t === 'tratto') apTratto(c, e);
    else if (e.t === 'foto') {
      const im = foto[e.f] ? apImmagine(foto[e.f]) : null;
      if (im && im.complete && im.naturalWidth) c.drawImage(im, e.x, e.y, e.w, e.h);
      else { c.fillStyle = 'rgba(128,128,128,.25)'; c.fillRect(e.x, e.y, e.w, e.h); }
    } else if (e.t === 'testo') apDisegnaTesto(c, e, pagina);
  });
}

function apLimiti(pagina) {
  let x1 = AP_LARGHEZZA, y1 = 400;
  (pagina.el || []).forEach(e => {
    const b = e.t === 'testo' ? { x1: e.x + e.w, y1: e.y + (e._h || 60) } : apRiquadro(e);
    if (b.x1 > x1) x1 = b.x1;
    if (b.y1 > y1) y1 = b.y1;
  });
  return { w: Math.ceil(x1 + 40), h: Math.ceil(y1 + 40) };
}

// Testo delle caselle disegnato sulla tela (per l'immagine della pagina e le miniature): grassetto, corsivo, sottolineato,
// colore, evidenziato, elenchi puntati e numerati, caselle da spuntare. Va a capo come nella casella.
function apBlocchiTesto(e) {
  const d = document.createElement('div');
  d.innerHTML = e.html || '';
  const blocchi = [];
  let corrente = null;
  const nuovo = (tipo, n, fatto) => { corrente = { tipo, n, fatto, pezzi: [] }; blocchi.push(corrente); };
  const visita = (nodo, st, lista) => {
    if (nodo.nodeType === 3) {
      if (!corrente) nuovo('p');
      if (nodo.nodeValue) corrente.pezzi.push({ t: nodo.nodeValue.replace(/\s+/g, ' '), st });
      return;
    }
    if (nodo.nodeType !== 1) return;
    const tag = nodo.tagName;
    const s2 = Object.assign({}, st);
    if (tag === 'B' || tag === 'STRONG') s2.b = true;
    if (tag === 'I' || tag === 'EM') s2.i = true;
    if (tag === 'U') s2.u = true;
    if (tag === 'FONT' && nodo.getAttribute('color')) s2.c = nodo.getAttribute('color');
    if (tag === 'MARK') s2.bg = '#fdd66380';
    const sty = nodo.style;
    if (sty) {
      if (sty.fontWeight === 'bold' || Number(sty.fontWeight) >= 600) s2.b = true;
      if (sty.fontStyle === 'italic') s2.i = true;
      if ((sty.textDecoration || sty.textDecorationLine || '').indexOf('underline') >= 0) s2.u = true;
      if (sty.color) s2.c = sty.color;
      if (sty.backgroundColor && sty.backgroundColor !== 'transparent') s2.bg = sty.backgroundColor;
    }
    // <br>: chiude la riga; una riga vuota (<div><br></div>) resta una riga vuota
    if (tag === 'BR') { if (corrente && corrente.tipo === 'p' && !corrente.pezzi.length) { corrente.br = true; corrente = null; } else nuovo('p'); return; }
    if (tag === 'UL' || tag === 'OL') {
      if (corrente && corrente.tipo === 'p' && !corrente.pezzi.length && !corrente.br) blocchi.pop();   // <div><ul>…: il div non è una riga in più
      let k = 0;
      Array.from(nodo.children).forEach(li => {
        if (li.tagName !== 'LI') return;
        k++;
        nuovo(nodo.classList.contains('ed-spunta') ? 'spunta' : tag === 'OL' ? 'num' : 'punto', k, li.classList.contains('fatto'));
        Array.from(li.childNodes).forEach(x => visita(x, s2, true));
      });
      corrente = null;
      return;
    }
    const blocco = /^(DIV|P|H\d)$/.test(tag);
    if (blocco && !lista && !(corrente && corrente.tipo === 'p' && !corrente.pezzi.length)) nuovo('p');
    Array.from(nodo.childNodes).forEach(x => visita(x, s2, lista));
    if (blocco && !lista) corrente = null;
  };
  Array.from(d.childNodes).forEach(x => visita(x, {}, false));
  return blocchi.filter(b => b.pezzi.length || b.tipo !== 'p' || b.br);
}

function apAltezzaTesto(c, e) { return apDisegnaTesto(c, e, null, true); }

function apDisegnaTesto(c, e, pagina, soloMisura) {
  const fs = e.fs || 18, lh = fs * 1.4, pad0 = 8;
  const famiglia = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const colore = e.c || ((pagina && pagina.sfondo && pagina.sfondo.colore === 'chiaro') ? '#1a2440' : '#e8eaed');
  let y = e.y + pad0;
  const maxX = e.x + e.w - pad0;
  apBlocchiTesto(e).forEach(b => {
    let rientro = 0, segno = '';
    if (b.tipo === 'punto') { rientro = fs * 1.2; segno = '•'; }
    if (b.tipo === 'num') { rientro = fs * 1.5; segno = b.n + '.'; }
    if (b.tipo === 'spunta') rientro = fs * 1.5;
    const x0 = e.x + pad0 + rientro;
    let x = x0;
    if (!soloMisura) {
      c.fillStyle = colore; c.textBaseline = 'alphabetic';
      c.font = fs + 'px ' + famiglia;
      if (segno) c.fillText(segno, e.x + pad0 + (b.tipo === 'num' ? 0 : fs * 0.25), y + fs);
      if (b.tipo === 'spunta') {
        const q = fs * 0.85;
        c.strokeStyle = colore; c.lineWidth = 1.5;
        c.strokeRect(e.x + pad0 + 1, y + (lh - q) / 2, q, q);
        if (b.fatto) { c.fillStyle = '#81c995'; c.fillRect(e.x + pad0 + 1, y + (lh - q) / 2, q, q); }
      }
    }
    const parole = [];
    b.pezzi.forEach(p => p.t.split(/(\s+)/).forEach(w => { if (w) parole.push({ w, st: p.st }); }));
    if (!parole.length) { y += lh; return; }
    parole.forEach(pz => {
      const st = pz.st;
      c.font = (st.i ? 'italic ' : '') + (st.b ? '700 ' : '400 ') + fs + 'px ' + famiglia;
      const lw = c.measureText(pz.w).width;
      if (x + lw > maxX && x > x0 && !/^\s+$/.test(pz.w)) { x = x0; y += lh; }
      if (x === x0 && /^\s+$/.test(pz.w)) return;
      if (!soloMisura) {
        if (st.bg) { c.fillStyle = st.bg; c.fillRect(x, y + 2, lw, lh - 2); }
        c.fillStyle = b.fatto ? 'rgba(160,166,172,.9)' : (st.c || colore);
        c.fillText(pz.w, x, y + fs);
        if (st.u || b.fatto) { c.fillRect(x, b.fatto ? y + fs * 0.62 : y + fs + 2, lw, 1.3); }
      }
      x += lw;
    });
    y += lh;
  });
  return y - e.y + pad0;
}

/** Immagine PNG della pagina per Claude in chat (leggibile: scala fino a 1,5, al massimo 2400 × 14000 px). */
function rendiPaginaPng(pagina) {
  const foto = pagina.foto || {};
  return Promise.all(Object.keys(foto).map(k => apImmagine(foto[k]).pronta)).then(() => {
    const prova = document.createElement('canvas').getContext('2d');
    (pagina.el || []).forEach(e => { if (e.t === 'testo') e._h = apAltezzaTesto(prova, e); });
    const L = apLimiti(pagina);
    const scala = Math.min(1.5, 2400 / L.w, 14000 / L.h);
    const cv = document.createElement('canvas');
    cv.width = Math.round(L.w * scala); cv.height = Math.round(L.h * scala);
    const c = cv.getContext('2d');
    c.scale(scala, scala);
    apSfondo(c, pagina.sfondo, 0, 0, L.w, L.h);
    apDisegnaElementi(c, pagina, { x0: 0, y0: 0, x1: L.w, y1: L.h }, true);
    return cv.toDataURL('image/png');
  });
}

function rendiMiniatura(pagina) {
  const foto = pagina.foto || {};
  return Promise.all(Object.keys(foto).map(k => apImmagine(foto[k]).pronta)).then(() => {
    const W = 1000, H = 760, s = 120 / W;
    const cv = document.createElement('canvas');
    cv.width = 120; cv.height = Math.round(H * s);
    const c = cv.getContext('2d');
    c.scale(s, s);
    (pagina.el || []).forEach(e => { if (e.t === 'testo') e._h = apAltezzaTesto(c, e); });
    apSfondo(c, pagina.sfondo, 0, 0, W, H);
    apDisegnaElementi(c, pagina, { x0: 0, y0: 0, x1: W, y1: H }, true);
    try { return cv.toDataURL('image/jpeg', 0.7); } catch (e) { return ''; }
  });
}

// ───────────────────────── Editor della pagina ─────────────────────────
// Due tele: "tela" (sfondo, tratti, foto: solo la parte visibile) e "vivo" (tratto che si sta disegnando, lazo, guide).
// Sopra, lo "strato" con le caselle di testo (HTML vero, modificabili) e il riquadro della selezione, spostato e scalato
// come la vista. Vista = { x, y } (angolo in alto a sinistra in punti pagina) e z (zoom).

const ED_STRUMENTI = [
  ['penna', '✒', 'penna'], ['evid', '🖍', 'evidenziatore'], ['testo', 'T', 'testo'], ['lazo', '➰', 'lazo'],
  ['gomma', '⌫', 'gomma'], ['gommaArea', '▭', 'g. area'],
];

function creaEditor(box, pagina, opz) {
  opz = opz || {};
  const rapido = !!opz.rapido;
  const ed = { pagina: null, v: { x: 0, y: 0, z: 1 }, storia: [], futuro: [], sel: [], strumento: 'penna', rec: null };
  const pref = LS.get('apPenna', { colore: null, spessore: 3, evColore: '#fdd663', evSpessore: 16, gomma: 14, ultimi: [] });
  box.innerHTML = `
    <div class="ed-barra" ${opz.soloLettura ? 'hidden' : ''}>
      <div class="ed-gruppo ed-strumenti">${ED_STRUMENTI.filter(s => !rapido || ['penna', 'evid', 'gomma'].indexOf(s[0]) >= 0)
        .map(s => `<button type="button" data-str="${s[0]}" title="${s[2]}"><span>${s[1]}</span><small>${s[2]}</small></button>`).join('')}</div>
      <div class="ed-gruppo ed-colori"></div>
      <label class="ed-spessore"><small>spessore · <b id="ed-sp-val"></b></small><input type="range" id="ed-sp" min="1" max="40" step="1"></label>
      <div class="ed-gruppo">
        <button type="button" data-az="annulla" title="Annulla (Ctrl+Z)"><span>↶</span><small>annulla</small></button>
        <button type="button" data-az="ripeti" title="Ripeti (Ctrl+Y)"><span>↷</span><small>ripeti</small></button>
        ${rapido ? '' : `<button type="button" data-str="spazio" title="Inserisci spazio: trascina in giù"><span>⇕</span><small>spazio</small></button>
        <button type="button" data-az="foto" title="Foto"><span>🖼</span><small>foto</small></button>
        <button type="button" data-az="sfondo" title="Sfondo della pagina"><span>▦</span><small>sfondo</small></button>`}
        ${rapido ? '<button type="button" data-az="tastiera" class="ed-tastiera"><span>⌨</span><small>tastiera</small></button>' : ''}
      </div>
      ${rapido ? '' : '<div class="ed-gruppo ed-ultimi" title="Ultimi strumenti usati"></div>'}
      <input type="file" accept="image/*" id="ed-file" hidden>
    </div>
    <div class="ed-barra-testo" hidden>
      <select id="ed-fs" title="Grandezza">${[14, 16, 18, 20, 24, 28, 34, 42].map(x => `<option value="${x}">${x}</option>`).join('')}</select>
      <button type="button" data-cmd="bold" title="Grassetto (Ctrl+B)"><b>B</b></button>
      <button type="button" data-cmd="italic" title="Corsivo (Ctrl+I)"><i>I</i></button>
      <button type="button" data-cmd="underline" title="Sottolineato (Ctrl+U)"><u>U</u></button>
      <span class="ed-colori-testo"></span>
      <button type="button" data-cmd="evidenzia" title="Evidenziato" class="ed-ev">ab</button>
      <button type="button" data-cmd="insertUnorderedList" title="Elenco puntato (scrivi «- »)">•≡</button>
      <button type="button" data-cmd="insertOrderedList" title="Elenco numerato">1.</button>
      <button type="button" data-cmd="spunta" title="Caselle da spuntare (scrivi «[] »)">☑</button>
      <button type="button" data-cmd="eliminaCasella" title="Elimina la casella di testo">🗑</button>
    </div>
    <div class="ed-vista" tabindex="0">
      <canvas class="ed-tela"></canvas>
      <canvas class="ed-vivo"></canvas>
      <div class="ed-strato"></div>
      <div class="ed-info"></div>
      <div class="ed-barretta"><span></span></div>
    </div>`;
  const vista = $('.ed-vista', box), tela = $('.ed-tela', box), vivo = $('.ed-vivo', box), strato = $('.ed-strato', box);
  const ctx = tela.getContext('2d'), cvv = vivo.getContext('2d');
  const barraTesto = $('.ed-barra-testo', box), info = $('.ed-info', box), barretta = $('.ed-barretta span', box);
  let dpr = window.devicePixelRatio || 1, W = 0, H = 0;
  let disegnoPendente = false, salvataggioT = null, inUso = false;
  vista.classList.toggle('ed-sola', !!opz.soloLettura);

  // ── modello ──
  function carica(p) {
    ed.pagina = p;
    if (!p.el) p.el = [];
    if (!p.foto) p.foto = {};
    if (!p.sfondo) p.sfondo = { colore: 'scuro', motivo: 'quadretti' };
    ed.storia = []; ed.futuro = []; ed.sel = [];
    Object.keys(p.foto).forEach(k => apImmagine(p.foto[k]).pronta.then(ridisegna));
    montaTesti();
    colori();
    ridisegna();
  }
  ed.carica = carica;
  ed.inUso = () => inUso || !!strato.querySelector('.ed-testo:focus');

  function istantanea() { return JSON.stringify(ed.pagina.el); }
  function prima() { ed.storia.push(istantanea()); if (ed.storia.length > 60) ed.storia.shift(); ed.futuro = []; }
  function cambiato(subito) {
    clearTimeout(salvataggioT);
    const fai = () => { pulisciFoto(); if (opz.salvataggio) opz.salvataggio(ed.pagina); };
    if (subito) fai(); else salvataggioT = setTimeout(fai, 1200);
  }
  ed.salvaSubito = () => { if (salvataggioT) { clearTimeout(salvataggioT); salvataggioT = null; leggiTesti(); pulisciFoto(); if (opz.salvataggio) opz.salvataggio(ed.pagina); } };
  function pulisciFoto() {
    const usate = {};
    ed.pagina.el.forEach(e => { if (e.t === 'foto') usate[e.f] = 1; });
    // le foto tolte restano finché si possono ancora riprendere con "annulla" (nella storia)
    const storia = ed.storia.join('');
    Object.keys(ed.pagina.foto).forEach(k => { if (!usate[k] && storia.indexOf('"f":"' + k + '"') < 0) delete ed.pagina.foto[k]; });
  }
  function annulla() {
    if (!ed.storia.length) return;
    ed.futuro.push(istantanea());
    ed.pagina.el = JSON.parse(ed.storia.pop());
    ed.sel = []; montaTesti(); ridisegna(); cambiato();
  }
  function ripeti() {
    if (!ed.futuro.length) return;
    ed.storia.push(istantanea());
    ed.pagina.el = JSON.parse(ed.futuro.pop());
    ed.sel = []; montaTesti(); ridisegna(); cambiato();
  }
  const nid = () => Math.random().toString(36).slice(2, 9);

  // ── vista e disegno ──
  function dimensiona() {
    dpr = window.devicePixelRatio || 1;
    W = vista.clientWidth; H = vista.clientHeight;
    [tela, vivo].forEach(c => { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; });
    // telefono: la prima volta la pagina si vede intera in larghezza (poi due dita per lo zoom)
    if (!ed.zoomFatto && W) { ed.zoomFatto = true; if (W < 700 && !rapido) ed.v.z = Math.max(0.25, Math.min(1, W / apLimiti(ed.pagina).w)); }
    ridisegna();
  }
  function aPagina(cx, cy) { const r = vista.getBoundingClientRect(); return { x: ed.v.x + (cx - r.left) / ed.v.z, y: ed.v.y + (cy - r.top) / ed.v.z }; }
  function limitaVista() {
    const L = apLimiti(ed.pagina);
    const maxX = Math.max(0, Math.max(L.w, AP_LARGHEZZA) - W / ed.v.z + 120), maxY = Math.max(0, L.h + H * 0.6 / ed.v.z - H / ed.v.z + 200);
    ed.v.x = Math.max(0, Math.min(maxX, ed.v.x));
    ed.v.y = Math.max(0, Math.min(maxY, ed.v.y));
    return L;
  }
  function ridisegna() {
    if (disegnoPendente) return;
    disegnoPendente = true;
    requestAnimationFrame(disegnaOra);
  }
  function disegnaOra() {
    disegnoPendente = false;
    if (!ed.pagina || !W) return;
    const L = limitaVista();
    const z = ed.v.z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -ed.v.x * dpr * z, -ed.v.y * dpr * z);
    const v = { x0: ed.v.x, y0: ed.v.y, x1: ed.v.x + W / z, y1: ed.v.y + H / z };
    apSfondo(ctx, ed.pagina.sfondo, v.x0 - 1, v.y0 - 1, v.x1 + 1, v.y1 + 1);
    apDisegnaElementi(ctx, ed.pagina, v, false);
    strato.style.transform = 'translate(' + (-ed.v.x * z) + 'px,' + (-ed.v.y * z) + 'px) scale(' + z + ')';
    disegnaSelezione();
    info.textContent = Math.round(z * 100) + ' %';
    const tot = Math.max(L.h, ed.v.y + H / z);
    barretta.style.height = Math.max(8, H / z / tot * 100) + '%';
    barretta.style.top = (ed.v.y / tot * 100) + '%';
  }
  ed.ridisegna = ridisegna;

  // ── caselle di testo (HTML) ──
  function montaTesti() {
    strato.innerHTML = '';
    ed.pagina.el.forEach(e => { if (e.t === 'testo') strato.appendChild(nodoTesto(e)); });
    const sel = document.createElement('div');
    sel.className = 'ed-sel'; sel.hidden = true;
    sel.innerHTML = '<span class="ed-maniglia" data-m="ridim"></span>';
    strato.appendChild(sel);
    modoStrato();
  }
  function nodoTesto(e) {
    const d = document.createElement('div');
    d.className = 'ed-testo';
    d.dataset.id = e.id;
    d.contentEditable = opz.soloLettura ? 'false' : 'true';
    d.spellcheck = false;
    d.style.cssText = `left:${e.x}px;top:${e.y}px;width:${e.w}px;font-size:${e.fs || 18}px;color:${e.c || ''}`;
    d.innerHTML = e.html || '';
    d.insertAdjacentHTML('afterbegin', '');
    const man = document.createElement('span');
    man.className = 'ed-sposta-testo'; man.contentEditable = 'false'; man.textContent = '⠿'; man.title = 'Trascina per spostare';
    const lar = document.createElement('span');
    lar.className = 'ed-larg-testo'; lar.contentEditable = 'false'; lar.title = 'Trascina per allargare';
    const guscio = document.createElement('div');
    guscio.className = 'ed-guscio-testo';
    guscio.style.cssText = `left:${e.x}px;top:${e.y}px;width:${e.w}px`;
    d.style.left = '0'; d.style.top = '0'; d.style.width = '100%';
    guscio.appendChild(man); guscio.appendChild(lar); guscio.appendChild(d);
    guscio.dataset.id = e.id;
    collegaTesto(guscio, d, man, lar, e);
    setTimeout(() => { e._h = guscio.offsetHeight; }, 0);
    return guscio;
  }
  function elDi(id) { return ed.pagina.el.find(x => x.id === id); }
  function htmlPulito(d) {
    const c = d.cloneNode(true);
    $$('.ed-sposta-testo,.ed-larg-testo', c).forEach(x => x.remove());
    return c.innerHTML.replace(/<span[^>]*><\/span>/g, '');
  }
  function leggiTesti() {
    $$('.ed-guscio-testo', strato).forEach(g => {
      const e = elDi(g.dataset.id); const d = g.querySelector('.ed-testo');
      if (e && d) { e.html = htmlPulito(d); e._h = g.offsetHeight; }
    });
  }
  function collegaTesto(g, d, man, lar, e) {
    let primaHtml = null;
    d.addEventListener('focus', () => { primaHtml = istantanea(); g.classList.add('attivo'); barraTesto.hidden = false; aggiornaBarraTesto(); inUso = true; });
    d.addEventListener('blur', () => {
      g.classList.remove('attivo'); inUso = false;
      setTimeout(() => { if (!strato.querySelector('.ed-testo:focus')) barraTesto.hidden = ed.strumento !== 'testo'; }, 150);
      const html = htmlPulito(d);
      if (!d.textContent.trim() && !/<li|<img/.test(html)) {
        // casella vuota: si toglie
        ed.pagina.el = ed.pagina.el.filter(x => x.id !== e.id);
        g.remove(); cambiato(); return;
      }
      if (html !== e.html) { if (primaHtml) { ed.storia.push(primaHtml); ed.futuro = []; } e.html = html; e._h = g.offsetHeight; cambiato(); }
    });
    d.addEventListener('input', () => { e.html = htmlPulito(d); e._h = g.offsetHeight; scorciatoie(d); cambiato(); });
    d.addEventListener('keydown', ev => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); d.blur(); annulla(); }
      if (ev.key === 'Escape') d.blur();
    });
    d.addEventListener('click', ev => {
      // casella da spuntare: tocco a sinistra della riga
      const li = ev.target.closest('ul.ed-spunta > li');
      if (li && ev.clientX - li.getBoundingClientRect().left < 0) { li.classList.toggle('fatto'); e.html = htmlPulito(d); cambiato(); }
    });
    d.addEventListener('pointerdown', ev => {
      const li = ev.target.closest('ul.ed-spunta > li');
      if (li && ev.clientX - li.getBoundingClientRect().left < 0) { ev.preventDefault(); li.classList.toggle('fatto'); e.html = htmlPulito(d); cambiato(); }
    });
    // sposta e allarga
    const trascina = (maniglia, fn) => maniglia.addEventListener('pointerdown', ev => {
      ev.preventDefault(); ev.stopPropagation();
      try { maniglia.setPointerCapture(ev.pointerId); } catch (e) { /* niente */ }
      const p0 = aPagina(ev.clientX, ev.clientY), x0 = e.x, y0 = e.y, w0 = e.w;
      prima();
      const mv = m => { const p = aPagina(m.clientX, m.clientY); fn(p.x - p0.x, p.y - p0.y, x0, y0, w0); g.style.left = e.x + 'px'; g.style.top = e.y + 'px'; g.style.width = e.w + 'px'; };
      const su = () => { maniglia.removeEventListener('pointermove', mv); maniglia.removeEventListener('pointerup', su); e._h = g.offsetHeight; cambiato(); };
      maniglia.addEventListener('pointermove', mv); maniglia.addEventListener('pointerup', su);
    });
    trascina(man, (dx, dy, x0, y0) => { e.x = Math.max(0, Math.round(x0 + dx)); e.y = Math.max(0, Math.round(y0 + dy)); });
    trascina(lar, (dx, dy, x0, y0, w0) => { e.w = Math.max(80, Math.round(w0 + dx)); });
  }
  function scorciatoie(d) {
    // "- " = elenco puntato, "[] " = caselle da spuntare, all'inizio di una riga
    const s = window.getSelection();
    if (!s.rangeCount) return;
    const n0 = s.anchorNode;
    if (!n0 || n0.nodeType !== 3) return;
    const t = n0.nodeValue.slice(0, s.anchorOffset).replace(/\u00a0/g, ' ');
    const blocco = n0.parentElement && n0.parentElement.closest('li');
    if (blocco || n0.previousSibling != null) return;
    // si cancellano i caratteri della scorciatoia come col tasto ← (il cursore resta dov'è), poi si fa l'elenco
    const togli = () => { for (let k = 0; k < t.length; k++) document.execCommand('delete'); };
    if (/^[-•]\s$/.test(t)) { togli(); document.execCommand('insertUnorderedList'); marcaSpunta(false); }
    else if (/^\[\s?\]\s$/.test(t)) { togli(); document.execCommand('insertUnorderedList'); marcaSpunta(true); }
  }
  function marcaSpunta(si) {
    const s = window.getSelection();
    const nodo = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
    const ul = nodo && nodo.closest('ul');
    if (ul) ul.classList.toggle('ed-spunta', si);
  }
  function testoAttivo() { const d = strato.querySelector('.ed-testo:focus'); return d ? { d, e: elDi(d.dataset.id) } : null; }
  function aggiornaBarraTesto() {
    const t = testoAttivo();
    $('#ed-fs', box).value = String((t && t.e && t.e.fs) || pref.fs || 18);
  }
  function nuovoTesto(px, py, html) {
    const pal = colorePenne();
    const e = { t: 'testo', id: nid(), x: Math.max(0, Math.round(px)), y: Math.max(0, Math.round(py - 12)), w: 360, fs: pref.fs || 18, c: pal === AP_PENNE_CHIARO ? '#1a2440' : '#e8eaed', html: html || '' };
    prima();
    ed.pagina.el.push(e);
    const g = nodoTesto(e);
    strato.insertBefore(g, strato.querySelector('.ed-sel'));
    const d = g.querySelector('.ed-testo');
    setTimeout(() => { d.focus(); const r = document.createRange(); r.selectNodeContents(d); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, 20);
    if (html) cambiato();
    return e;
  }
  ed.aggiungiTesto = html => {
    const L = apLimiti(ed.pagina);
    const e = nuovoTesto(40, Math.max(60, L.h - 20), html);
    ed.v.y = Math.max(0, e.y - 60); ridisegna();
    cambiato(true);
  };
  // barra del testo: i pulsanti non tolgono il fuoco alla casella
  $$('.ed-barra-testo button', box).forEach(b => {
    b.addEventListener('pointerdown', ev => ev.preventDefault());
    b.addEventListener('mousedown', ev => ev.preventDefault());
    b.onclick = () => {
      const t = testoAttivo();
      if (!t) return;
      const c = b.dataset.cmd;
      if (c === 'eliminaCasella') { prima(); ed.pagina.el = ed.pagina.el.filter(x => x.id !== t.e.id); t.d.closest('.ed-guscio-testo').remove(); cambiato(); return; }
      if (c === 'spunta') {
        const s = getSelection(); const nodo = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
        const ul = nodo && nodo.closest('ul');
        if (ul && ul.classList.contains('ed-spunta')) { document.execCommand('insertUnorderedList'); }
        else { if (!ul) document.execCommand('insertUnorderedList'); marcaSpunta(true); }
      } else if (c === 'evidenzia') {
        document.execCommand('styleWithCSS', false, true);
        document.execCommand('hiliteColor', false, 'rgba(253,214,99,.45)');
        document.execCommand('styleWithCSS', false, false);
      } else if (c === 'insertUnorderedList') { marcaSpunta(false); document.execCommand(c); }
      else document.execCommand(c);
      t.e.html = htmlPulito(t.d); cambiato();
    };
  });
  $('#ed-fs', box).addEventListener('change', () => {
    const t = testoAttivo() || ultimoTesto;
    pref.fs = Number($('#ed-fs', box).value); LS.set('apPenna', pref);
    if (t && t.e) { prima(); t.e.fs = pref.fs; t.d.closest('.ed-guscio-testo').querySelector('.ed-testo').style.fontSize = pref.fs + 'px'; cambiato(); t.d.focus(); }
  });
  let ultimoTesto = null;
  $('#ed-fs', box).addEventListener('pointerdown', () => { ultimoTesto = testoAttivo(); });
  function coloriTesto() {
    const pal = colorePenne();
    const box2 = $('.ed-colori-testo', box);
    box2.innerHTML = pal.map(c => `<button type="button" class="ed-col" data-c="${c}" style="--c:${c}" title="Colore del testo"></button>`).join('');
    $$('button', box2).forEach(b => {
      b.addEventListener('pointerdown', ev => ev.preventDefault());
      b.addEventListener('mousedown', ev => ev.preventDefault());
      b.onclick = () => { const t = testoAttivo(); if (!t) return; document.execCommand('foreColor', false, b.dataset.c); t.e.html = htmlPulito(t.d); cambiato(); };
    });
  }

  // ── selezione (lazo) ──
  function riquadroSel() {
    if (!ed.sel.length) return null;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    ed.sel.forEach(id => {
      const e = elDi(id); if (!e) return;
      const b = e.t === 'testo' ? { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + (e._h || 40) } : apRiquadro(e);
      x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
    });
    return x0 > x1 ? null : { x0: x0 - 6, y0: y0 - 6, x1: x1 + 6, y1: y1 + 6 };
  }
  function disegnaSelezione() {
    const s = strato.querySelector('.ed-sel');
    ed.sel = ed.sel.filter(id => elDi(id));
    const b = riquadroSel();
    let barra = box.querySelector('.ed-barra-sel');
    if (!s) return;
    if (!b) { s.hidden = true; if (barra) barra.remove(); return; }
    s.hidden = false;
    s.style.left = b.x0 + 'px'; s.style.top = b.y0 + 'px'; s.style.width = (b.x1 - b.x0) + 'px'; s.style.height = (b.y1 - b.y0) + 'px';
    s.style.borderWidth = (1.5 / ed.v.z) + 'px';
    s.querySelector('.ed-maniglia').style.transform = 'scale(' + (1 / ed.v.z) + ')';
    if (!barra) {
      barra = document.createElement('div');
      barra.className = 'ed-barra-sel';
      barra.innerHTML = `<button type="button" data-s="colore">● colore</button><button type="button" data-s="copia">⧉ copia</button>
        <button type="button" data-s="elimina">🗑 elimina</button><button type="button" data-s="sposta">↗ sposta in…</button><button type="button" data-s="spazio">⇕ inserisci spazio</button>`;
      vista.appendChild(barra);
      $$('button', barra).forEach(bt => bt.onclick = () => azioneSel(bt.dataset.s));
    }
    const sx = (b.x0 - ed.v.x) * ed.v.z, sy = (b.y1 - ed.v.y) * ed.v.z + 8;
    barra.style.left = Math.max(4, Math.min(W - barra.offsetWidth - 4, sx)) + 'px';
    barra.style.top = Math.max(4, Math.min(H - barra.offsetHeight - 4, sy)) + 'px';
  }
  function azioneSel(a) {
    if (!ed.sel.length) return;
    if (a === 'elimina') { prima(); ed.pagina.el = ed.pagina.el.filter(e => ed.sel.indexOf(e.id) < 0); ed.sel = []; montaTesti(); ridisegna(); cambiato(); }
    if (a === 'colore') {
      prima();
      ed.sel.forEach(id => { const e = elDi(id); if (e.t === 'tratto' && !e.ev) e.c = pref.colore || colorePenne()[0]; if (e.t === 'testo') e.c = pref.colore || colorePenne()[0]; });
      montaTesti(); ridisegna(); cambiato();
      toast('Colore: quello della penna scelta');
    }
    if (a === 'copia') {
      prima();
      const nuovi = ed.sel.map(id => { const c = JSON.parse(JSON.stringify(elDi(id))); c.id = nid(); trasla(c, 24, 24); return c; });
      ed.pagina.el = ed.pagina.el.concat(nuovi);
      ed.sel = nuovi.map(x => x.id); montaTesti(); ridisegna(); cambiato();
    }
    if (a === 'spazio') { scegliStrumento('spazio'); toast('Trascina in giù dal punto dove vuoi lo spazio'); }
    if (a === 'sposta' && opz.spostaIn) opz.spostaIn(ed.sel.map(id => JSON.parse(JSON.stringify(elDi(id)))), ed.pagina.foto, () => {
      prima(); ed.pagina.el = ed.pagina.el.filter(e => ed.sel.indexOf(e.id) < 0); ed.sel = []; montaTesti(); ridisegna(); cambiato(true);
    });
  }
  function trasla(e, dx, dy) {
    if (e.t === 'tratto') { for (let i = 0; i < e.p.length; i += 2) { e.p[i] += dx; e.p[i + 1] += dy; } apTogliRiquadro(e); }
    else { e.x += dx; e.y += dy; }
  }
  function scala(e, ox, oy, k) {
    if (e.t === 'tratto') { for (let i = 0; i < e.p.length; i += 2) { e.p[i] = ox + (e.p[i] - ox) * k; e.p[i + 1] = oy + (e.p[i + 1] - oy) * k; } e.s = Math.max(1, e.s * k); apTogliRiquadro(e); }
    else { e.x = ox + (e.x - ox) * k; e.y = oy + (e.y - oy) * k; e.w = Math.max(40, e.w * k); if (e.t === 'foto') e.h = e.h * k; if (e.t === 'testo') e.fs = Math.max(10, Math.round((e.fs || 18) * k)); }
  }
  function arrotonda(e) { if (e.t === 'tratto') e.p = e.p.map(v => Math.round(v * 10) / 10); else { e.x = Math.round(e.x); e.y = Math.round(e.y); e.w = Math.round(e.w); if (e.h) e.h = Math.round(e.h); } }
  function dentroPoligono(x, y, poli) {
    let dentro = false;
    for (let i = 0, j = poli.length - 2; i < poli.length; j = i, i += 2) {
      const xi = poli[i], yi = poli[i + 1], xj = poli[j], yj = poli[j + 1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
  }
  function selezionaCon(poli) {
    ed.sel = ed.pagina.el.filter(e => {
      if (e.t === 'tratto') {
        let k = 0, tot = 0;
        for (let i = 0; i < e.p.length; i += 2) { tot++; if (dentroPoligono(e.p[i], e.p[i + 1], poli)) k++; }
        return tot && k / tot >= 0.6;
      }
      const h = e.t === 'testo' ? (e._h || 40) : e.h;
      return dentroPoligono(e.x + e.w / 2, e.y + h / 2, poli);
    }).map(e => e.id);
  }
  function elementoIn(p) {
    for (let i = ed.pagina.el.length - 1; i >= 0; i--) {
      const e = ed.pagina.el[i];
      const b = e.t === 'testo' ? { x0: e.x, y0: e.y, x1: e.x + e.w, y1: e.y + (e._h || 40) } : apRiquadro(e);
      if (p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) {
        if (e.t !== 'tratto') return e;
        if (vicinoATratto(e, p.x, p.y, 10 / ed.v.z)) return e;
      }
    }
    return null;
  }
  function vicinoATratto(e, x, y, r) {
    const p = e.p, r2 = Math.pow(r + e.s / 2, 2);
    if (p.length === 2) return (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y) <= r2;
    for (let i = 0; i < p.length - 2; i += 2) if (distSeg2(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r2) return true;
    return false;
  }
  function distSeg2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }

  // ── gomme ──
  function gommaTratto(x, y, r) {
    const prima0 = ed.pagina.el.length;
    ed.pagina.el = ed.pagina.el.filter(e => e.t !== 'tratto' || !vicinoATratto(e, x, y, r));
    return ed.pagina.el.length !== prima0;
  }
  function gommaArea(x, y, r) {
    let cambio = false;
    const nuovi = [];
    ed.pagina.el.forEach(e => {
      if (e.t !== 'tratto') { nuovi.push(e); return; }
      const b = apRiquadro(e);
      if (x + r < b.x0 || x - r > b.x1 || y + r < b.y0 || y - r > b.y1) { nuovi.push(e); return; }
      let pezzo = [], r2 = r * r, tocca = false;
      const pezzi = [];
      for (let i = 0; i < e.p.length; i += 2) {
        const dx = e.p[i] - x, dy = e.p[i + 1] - y;
        if (dx * dx + dy * dy <= r2) { tocca = true; if (pezzo.length) { pezzi.push(pezzo); pezzo = []; } }
        else pezzo.push(e.p[i], e.p[i + 1]);
      }
      if (pezzo.length) pezzi.push(pezzo);
      if (!tocca) { nuovi.push(e); return; }
      cambio = true;
      pezzi.forEach(pz => { if (pz.length >= 4) nuovi.push({ t: 'tratto', id: nid(), c: e.c, s: e.s, ev: e.ev, p: pz }); });
    });
    if (cambio) ed.pagina.el = nuovi;
    return cambio;
  }

  // ── puntatore: la penna (e il mouse) usa lo strumento, il dito scorre e fa lo zoom ──
  const dita = {};
  let gesto = null, azione = null, penneViste = false;
  function dimDita() { return Object.keys(dita).map(k => dita[k]); }
  vista.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.ed-barra-sel')) return;
    const suTesto = ev.target.closest('.ed-guscio-testo');
    if (ev.pointerType === 'touch') {
      if (suTesto && ed.strumento === 'testo') return;   // il dito sulla casella: la tastiera la gestisce lei
      dita[ev.pointerId] = { x: ev.clientX, y: ev.clientY, t0: ev.timeStamp, x0: ev.clientX, y0: ev.clientY };
      try { vista.setPointerCapture(ev.pointerId); } catch (e) { /* niente */ }
      iniziaGesto();
      return;
    }
    if (ev.pointerType === 'pen') penneViste = true;
    if (ev.button === 1 || (ev.pointerType === 'mouse' && ev.button === 2)) {   // tasto centrale / destro del mouse = scorre
      ev.preventDefault();
      dita[ev.pointerId] = { x: ev.clientX, y: ev.clientY, t0: ev.timeStamp, x0: ev.clientX, y0: ev.clientY };
      try { vista.setPointerCapture(ev.pointerId); } catch (e) { /* niente */ } iniziaGesto(); return;
    }
    if (ev.button !== 0 && !(ev.buttons & 32)) return;
    if (opz.soloLettura) return;
    if (suTesto && (ed.strumento === 'testo' || ev.target.closest('.ed-sposta-testo,.ed-larg-testo'))) return;
    const attivo = document.activeElement;
    if (attivo && attivo.classList && attivo.classList.contains('ed-testo')) attivo.blur();
    ev.preventDefault();
    vista.focus({ preventScroll: true });
    try { vista.setPointerCapture(ev.pointerId); } catch (e) { /* niente */ }
    const p = aPagina(ev.clientX, ev.clientY);
    const str = (ev.buttons & 32) ? 'gomma' : ed.strumento;   // tasto gomma della penna
    inUso = true;
    if (str === 'penna' || str === 'evid') {
      const ev2 = str === 'evid';
      azione = { tipo: 'tratto', e: { t: 'tratto', id: nid(), c: ev2 ? pref.evColore : (pref.colore || colorePenne()[0]), s: ev2 ? pref.evSpessore : pref.spessore, ev: ev2 || undefined, p: [r1(p.x), r1(p.y)] } };
      if (!ev2) delete azione.e.ev;
      disegnaVivo();
    } else if (str === 'gomma' || str === 'gommaArea') {
      prima();
      azione = { tipo: str, cambio: false, r: (str === 'gomma' ? 6 : pref.gomma) / ed.v.z, ultimo: p };
      gommaPunto(p);
    } else if (str === 'lazo') {
      const b = riquadroSel();
      const man = ev.target.closest('.ed-maniglia');
      if (b && man) { prima(); azione = { tipo: 'ridim', p0: p, b, orig: ed.sel.map(id => JSON.parse(JSON.stringify(elDi(id)))) }; }
      else if (b && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) { prima(); azione = { tipo: 'muovi', p0: p, ultimo: p, mosso: false }; }
      else azione = { tipo: 'lazo', poli: [p.x, p.y], p0: p };
    } else if (str === 'testo') {
      azione = { tipo: 'testo', p0: p, c0: { x: ev.clientX, y: ev.clientY } };
    } else if (str === 'spazio') {
      prima();
      azione = { tipo: 'spazio', y0: p.y, dy: 0, sotto: ed.pagina.el.filter(e => (e.t === 'tratto' ? apRiquadro(e).y0 : e.y) >= p.y).map(e => e.id) };
    }
  });
  const r1 = v => Math.round(v * 10) / 10;
  vista.addEventListener('pointermove', ev => {
    if (dita[ev.pointerId]) { dita[ev.pointerId].x = ev.clientX; dita[ev.pointerId].y = ev.clientY; muoviGesto(); return; }
    if (!azione) return;
    const eventi = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    const lista = eventi.length ? eventi : [ev];
    if (azione.tipo === 'tratto') {
      const p = azione.e.p;
      lista.forEach(x => {
        const q = aPagina(x.clientX, x.clientY);
        const lx = p[p.length - 2], ly = p[p.length - 1];
        if (Math.abs(q.x - lx) + Math.abs(q.y - ly) >= 0.8 / ed.v.z) p.push(r1(q.x), r1(q.y));
      });
      disegnaVivo();
    } else if (azione.tipo === 'gomma' || azione.tipo === 'gommaArea') {
      lista.forEach(x => gommaPunto(aPagina(x.clientX, x.clientY)));
      const q = aPagina(ev.clientX, ev.clientY);
      guidaGomma(q, azione.r);
    } else if (azione.tipo === 'lazo') {
      lista.forEach(x => { const q = aPagina(x.clientX, x.clientY); azione.poli.push(r1(q.x), r1(q.y)); });
      disegnaVivo();
    } else if (azione.tipo === 'muovi') {
      const q = aPagina(ev.clientX, ev.clientY);
      const dx = q.x - azione.ultimo.x, dy = q.y - azione.ultimo.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) azione.mosso = true;
      ed.sel.forEach(id => trasla(elDi(id), dx, dy));
      azione.ultimo = q;
      $$('.ed-guscio-testo', strato).forEach(g => { const e = elDi(g.dataset.id); if (e && ed.sel.indexOf(e.id) >= 0) { g.style.left = e.x + 'px'; g.style.top = e.y + 'px'; } });
      ridisegna();
    } else if (azione.tipo === 'ridim') {
      const q = aPagina(ev.clientX, ev.clientY), b = azione.b;
      const k = Math.max(0.15, Math.min(8, Math.max((q.x - b.x0) / (b.x1 - b.x0), (q.y - b.y0) / (b.y1 - b.y0))));
      azione.orig.forEach(o => {
        const e = elDi(o.id); if (!e) return;
        Object.assign(e, JSON.parse(JSON.stringify(o)));
        scala(e, b.x0 + 6, b.y0 + 6, k);
      });
      montaTesti(); ridisegna();
    } else if (azione.tipo === 'spazio') {
      const q = aPagina(ev.clientX, ev.clientY);
      const dy = Math.max(-(azione.y0 - 0), q.y - azione.y0) - azione.dy;
      azione.dy += dy;
      azione.sotto.forEach(id => { const e = elDi(id); if (e) trasla(e, 0, dy); });
      montaTesti(); ridisegna();
      guidaSpazio(azione.y0, azione.dy);
    }
  });
  function finePuntatore(ev) {
    if (dita[ev.pointerId]) {
      const d = dita[ev.pointerId];
      delete dita[ev.pointerId];
      // tocco breve del dito senza muoversi in modalità testo = casella nuova; su una casella da spuntare = spunta
      if (ev.type === 'pointerup' && !Object.keys(dita).length && Math.hypot(d.x - d.x0, d.y - d.y0) < 8 && ev.timeStamp - d.t0 < 350) tocco(ev);
      iniziaGesto();
      return;
    }
    if (!azione) return;
    const a = azione; azione = null; inUso = false;
    cvv.setTransform(1, 0, 0, 1, 0, 0); cvv.clearRect(0, 0, vivo.width, vivo.height);
    if (a.tipo === 'tratto') {
      if (a.e.p.length === 2 && tocco(ev, true)) { return; }
      prima();
      ed.pagina.el.push(a.e);
      ctx.setTransform(dpr * ed.v.z, 0, 0, dpr * ed.v.z, -ed.v.x * dpr * ed.v.z, -ed.v.y * dpr * ed.v.z);
      apTratto(ctx, a.e);
      ricordaUltimo();
      cambiato();
    } else if (a.tipo === 'gomma' || a.tipo === 'gommaArea') {
      if (a.cambio) cambiato(); else ed.storia.pop();
    } else if (a.tipo === 'lazo') {
      if (a.poli.length < 8) {
        const e = elementoIn(a.p0);
        ed.sel = e ? [e.id] : [];
      } else selezionaCon(a.poli);
      ridisegna();
    } else if (a.tipo === 'muovi') {
      if (a.mosso) { ed.sel.forEach(id => arrotonda(elDi(id))); cambiato(); } else ed.storia.pop();
      ridisegna();
    } else if (a.tipo === 'ridim') { ed.sel.forEach(id => arrotonda(elDi(id))); montaTesti(); ridisegna(); cambiato(); }
    else if (a.tipo === 'testo') {
      const e = elementoIn(a.p0);
      if (!(e && e.t === 'testo')) nuovoTesto(a.p0.x, a.p0.y);
    } else if (a.tipo === 'spazio') { if (a.dy) cambiato(); else ed.storia.pop(); ridisegna(); }
  }
  vista.addEventListener('pointerup', finePuntatore);
  vista.addEventListener('pointercancel', finePuntatore);
  vista.addEventListener('contextmenu', ev => ev.preventDefault());

  /** Tocco breve: spunta una casella o (in modalità testo, col dito) crea una casella di testo. */
  function tocco(ev, daPenna) {
    const cx = ev.clientX, cy = ev.clientY;
    const li = $$('ul.ed-spunta > li', strato).find(x => { const r = x.getBoundingClientRect(); return cy >= r.top && cy <= r.bottom && cx >= r.left - 34 * ed.v.z && cx <= r.left + 4; });
    if (li && !opz.soloLettura) {
      const g = li.closest('.ed-guscio-testo'), e = g && elDi(g.dataset.id);
      if (e) { prima(); li.classList.toggle('fatto'); e.html = htmlPulito(g.querySelector('.ed-testo')); cambiato(); return true; }
    }
    if (!daPenna && ed.strumento === 'testo' && !opz.soloLettura) {
      const p = aPagina(ev.clientX, ev.clientY);
      const g = $$('.ed-guscio-testo', strato).find(x => { const r = x.getBoundingClientRect(); return cy >= r.top && cy <= r.bottom && cx >= r.left && cx <= r.right; });
      if (g) g.querySelector('.ed-testo').focus(); else nuovoTesto(p.x, p.y);
      return true;
    }
    return false;
  }
  function gommaPunto(p) {
    const a = azione;
    // anche i punti in mezzo, se il movimento è veloce
    const passi = Math.max(1, Math.ceil(Math.hypot(p.x - a.ultimo.x, p.y - a.ultimo.y) / (a.r * 0.7)));
    for (let i = 1; i <= passi; i++) {
      const x = a.ultimo.x + (p.x - a.ultimo.x) * i / passi, y = a.ultimo.y + (p.y - a.ultimo.y) * i / passi;
      if (a.tipo === 'gomma' ? gommaTratto(x, y, a.r) : gommaArea(x, y, a.r)) a.cambio = true;
    }
    if (passi === 1 && (a.tipo === 'gomma' ? gommaTratto(p.x, p.y, a.r) : gommaArea(p.x, p.y, a.r))) a.cambio = true;
    a.ultimo = p;
    if (a.cambio) ridisegna();
  }
  function prepVivo() { cvv.setTransform(1, 0, 0, 1, 0, 0); cvv.clearRect(0, 0, vivo.width, vivo.height); cvv.setTransform(dpr * ed.v.z, 0, 0, dpr * ed.v.z, -ed.v.x * dpr * ed.v.z, -ed.v.y * dpr * ed.v.z); }
  function disegnaVivo() {
    if (!azione) return;
    prepVivo();
    if (azione.tipo === 'tratto') apTratto(cvv, azione.e);
    if (azione.tipo === 'lazo') {
      cvv.strokeStyle = '#c58af9'; cvv.lineWidth = 1.5 / ed.v.z; cvv.setLineDash([6 / ed.v.z, 5 / ed.v.z]);
      cvv.beginPath(); const p = azione.poli; cvv.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) cvv.lineTo(p[i], p[i + 1]); cvv.closePath(); cvv.stroke();
      cvv.setLineDash([]);
    }
  }
  function guidaGomma(q, r) { prepVivo(); cvv.strokeStyle = 'rgba(242,139,130,.9)'; cvv.lineWidth = 1.5 / ed.v.z; cvv.beginPath(); cvv.arc(q.x, q.y, r, 0, Math.PI * 2); cvv.stroke(); }
  function guidaSpazio(y0, dy) {
    prepVivo(); cvv.fillStyle = 'rgba(138,180,248,.12)'; cvv.fillRect(ed.v.x, y0, W / ed.v.z, Math.max(0, dy));
    cvv.strokeStyle = '#8ab4f8'; cvv.lineWidth = 2 / ed.v.z; cvv.setLineDash([8 / ed.v.z, 6 / ed.v.z]);
    cvv.beginPath(); cvv.moveTo(ed.v.x, y0); cvv.lineTo(ed.v.x + W / ed.v.z, y0); cvv.stroke(); cvv.setLineDash([]);
  }

  // gesti con le dita: uno scorre, due scorrono e fanno lo zoom
  function iniziaGesto() {
    const d = dimDita();
    if (!d.length) { gesto = null; return; }
    if (d.length === 1) gesto = { tipo: 1, x: d[0].x, y: d[0].y, v0: Object.assign({}, ed.v) };
    else {
      const cx = (d[0].x + d[1].x) / 2, cy = (d[0].y + d[1].y) / 2;
      gesto = { tipo: 2, dist: Math.hypot(d[0].x - d[1].x, d[0].y - d[1].y), c: aPagina(cx, cy), z0: ed.v.z };
    }
  }
  function muoviGesto() {
    const d = dimDita();
    if (!gesto) return;
    if (gesto.tipo === 1 && d.length === 1) {
      ed.v.x = gesto.v0.x - (d[0].x - gesto.x) / ed.v.z;
      ed.v.y = gesto.v0.y - (d[0].y - gesto.y) / ed.v.z;
    } else if (gesto.tipo === 2 && d.length >= 2) {
      const dist = Math.hypot(d[0].x - d[1].x, d[0].y - d[1].y);
      ed.v.z = Math.max(0.25, Math.min(4, gesto.z0 * dist / Math.max(20, gesto.dist)));
      const r = vista.getBoundingClientRect();
      const cx = (d[0].x + d[1].x) / 2 - r.left, cy = (d[0].y + d[1].y) / 2 - r.top;
      ed.v.x = gesto.c.x - cx / ed.v.z; ed.v.y = gesto.c.y - cy / ed.v.z;
    }
    ridisegna();
  }
  vista.addEventListener('wheel', ev => {
    ev.preventDefault();
    if (ev.ctrlKey) {
      const c = aPagina(ev.clientX, ev.clientY);
      ed.v.z = Math.max(0.25, Math.min(4, ed.v.z * Math.exp(-ev.deltaY * 0.0022)));
      const r = vista.getBoundingClientRect();
      ed.v.x = c.x - (ev.clientX - r.left) / ed.v.z; ed.v.y = c.y - (ev.clientY - r.top) / ed.v.z;
    } else {
      const k = ev.deltaMode === 1 ? 32 : 1;
      ed.v.x += (ev.shiftKey ? ev.deltaY : ev.deltaX) * k / ed.v.z;
      if (!ev.shiftKey) ed.v.y += ev.deltaY * k / ed.v.z;
    }
    ridisegna();
  }, { passive: false });
  vista.addEventListener('keydown', ev => {
    if (ev.target.closest && ev.target.closest('.ed-testo')) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? ripeti() : annulla(); }
    else if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); ripeti(); }
    else if ((k === 'delete' || k === 'backspace') && ed.sel.length) { ev.preventDefault(); azioneSel('elimina'); }
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const m = { p: 'penna', e: 'evid', t: 'testo', l: 'lazo', g: 'gomma' }[k];
      if (m) scegliStrumento(m);
    }
  });

  // ── barra degli strumenti ──
  function colorePenne() { return ed.pagina && ed.pagina.sfondo && ed.pagina.sfondo.colore === 'chiaro' ? AP_PENNE_CHIARO : AP_PENNE_SCURO; }
  function colori() {
    const pal = colorePenne();
    if (pref.colore && pal.indexOf(pref.colore) < 0 && (AP_PENNE_SCURO.indexOf(pref.colore) >= 0 || AP_PENNE_CHIARO.indexOf(pref.colore) >= 0)) pref.colore = pal[0];
    const ev = ed.strumento === 'evid';
    const scelti = ev ? ['#fdd663', '#81c995', '#8ab4f8', '#f28b82', '#c58af9'] : pal;
    const att = ev ? pref.evColore : (pref.colore || pal[0]);
    $('.ed-colori', box).innerHTML = scelti.map(c => `<button type="button" class="ed-col ${c === att ? 'attivo' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('') +
      (rapido ? '' : `<label class="ed-col ed-libero ${scelti.indexOf(att) < 0 ? 'attivo' : ''}" title="Colore libero" style="--c:${att}"><input type="color" value="${att.length === 7 ? att : '#ffffff'}"></label>`);
    $$('.ed-colori button', box).forEach(b => b.onclick = () => impostaColore(b.dataset.c));
    const lib = $('.ed-colori input', box);
    if (lib) lib.onchange = () => impostaColore(lib.value);
    const sp = $('#ed-sp', box);
    sp.value = ev ? pref.evSpessore : ed.strumento === 'gommaArea' ? pref.gomma : pref.spessore;
    $('#ed-sp-val', box).textContent = sp.value + ' px';
    coloriTesto();
  }
  function impostaColore(c) {
    if (ed.strumento === 'evid') pref.evColore = c; else pref.colore = c;
    if (['lazo', 'gomma', 'gommaArea', 'spazio', 'testo'].indexOf(ed.strumento) >= 0 && !ed.sel.length) scegliStrumento('penna');
    LS.set('apPenna', pref); colori();
  }
  $('#ed-sp', box).oninput = () => {
    const v = Number($('#ed-sp', box).value);
    if (ed.strumento === 'evid') pref.evSpessore = v; else if (ed.strumento === 'gommaArea') pref.gomma = v; else pref.spessore = v;
    $('#ed-sp-val', box).textContent = v + ' px';
    LS.set('apPenna', pref);
  };
  function scegliStrumento(s) {
    ed.strumento = s;
    $$('.ed-barra [data-str]', box).forEach(b => b.classList.toggle('attivo', b.dataset.str === s));
    if (s !== 'lazo') { ed.sel = []; disegnaSelezione(); }
    barraTesto.hidden = s !== 'testo' && !strato.querySelector('.ed-testo:focus');
    modoStrato();
    colori();
    vista.dataset.strumento = s;
  }
  ed.scegliStrumento = scegliStrumento;
  function modoStrato() { strato.classList.toggle('ed-testi-attivi', ed.strumento === 'testo'); }
  function ricordaUltimo() {
    if (rapido) return;
    const u = { s: ed.strumento, c: ed.strumento === 'evid' ? pref.evColore : (pref.colore || colorePenne()[0]), w: ed.strumento === 'evid' ? pref.evSpessore : pref.spessore };
    pref.ultimi = [u].concat((pref.ultimi || []).filter(x => !(x.s === u.s && x.c === u.c && x.w === u.w))).slice(0, 3);
    LS.set('apPenna', pref);
    ultimi();
  }
  function ultimi() {
    const b = $('.ed-ultimi', box);
    if (!b) return;
    b.innerHTML = (pref.ultimi || []).length ? '<small>ultimi:</small>' + pref.ultimi.map((u, i) => `<button type="button" data-u="${i}" title="${u.s === 'evid' ? 'evidenziatore' : 'penna'} ${u.w} px"><span style="color:${u.c}">${u.s === 'evid' ? '🖍' : '✒'}</span><small>${u.w}</small></button>`).join('') : '';
    $$('button', b).forEach(x => x.onclick = () => {
      const u = pref.ultimi[Number(x.dataset.u)];
      if (u.s === 'evid') { pref.evColore = u.c; pref.evSpessore = u.w; } else { pref.colore = u.c; pref.spessore = u.w; }
      scegliStrumento(u.s);
    });
  }
  $$('.ed-barra [data-str]', box).forEach(b => b.onclick = () => scegliStrumento(b.dataset.str));
  $$('.ed-barra [data-az]', box).forEach(b => b.onclick = () => {
    const a = b.dataset.az;
    if (a === 'annulla') annulla();
    if (a === 'ripeti') ripeti();
    if (a === 'foto') $('#ed-file', box).click();
    if (a === 'tastiera') { scegliStrumento('testo'); const L = apLimiti(ed.pagina); nuovoTesto(24, Math.min(L.h - 30, ed.v.y + 40)); }
    if (a === 'sfondo') apScegli('Sfondo della pagina', [['scuro|vuoto', 'Scuro, vuoto'], ['scuro|righe', 'Scuro a righe'], ['scuro|quadretti', 'Scuro a quadretti'], ['chiaro|vuoto', 'Chiaro, vuoto'], ['chiaro|righe', 'Chiaro a righe'], ['chiaro|quadretti', 'Chiaro a quadretti']])
      .then(v => { if (!v) return; const p = v.split('|'); ed.pagina.sfondo = { colore: p[0], motivo: p[1] }; colori(); ridisegna(); cambiato(); });
  });
  $('#ed-file', box).onchange = ev => {
    const f = ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    apRiduciFoto(f).then(r => {
      const k = 'f' + nid();
      ed.pagina.foto[k] = r.url;
      const w = Math.min(600, r.w), h = Math.round(r.h * w / r.w);
      prima();
      ed.pagina.el.push({ t: 'foto', id: nid(), x: Math.round(ed.v.x + 40 / ed.v.z), y: Math.round(ed.v.y + 40 / ed.v.z), w, h, f: k });
      apImmagine(r.url).pronta.then(ridisegna);
      scegliStrumento('lazo');
      ed.sel = [ed.pagina.el[ed.pagina.el.length - 1].id];
      ridisegna(); cambiato();
    }).catch(() => toast('Foto non leggibile'));
  };

  ed.distruggi = () => { clearTimeout(salvataggioT); if (ro) ro.disconnect(); window.removeEventListener('resize', dimensiona); };
  let ro = null;
  if (window.ResizeObserver) { ro = new ResizeObserver(dimensiona); ro.observe(vista); } else window.addEventListener('resize', dimensiona);
  carica(pagina);
  scegliStrumento(opz.soloLettura ? 'lazo' : 'penna');
  ultimi();
  requestAnimationFrame(dimensiona);
  return ed;
}

/** Foto ridotta a 1600 px (JPEG): resta leggera dentro il file della pagina. */
function apRiduciFoto(file) {
  return new Promise((ok, ko) => {
    const lettore = new FileReader();
    lettore.onerror = ko;
    lettore.onload = () => {
      const im = new Image();
      im.onerror = ko;
      im.onload = () => {
        const k = Math.min(1, 1600 / Math.max(im.width, im.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        ok({ url: cv.toDataURL('image/jpeg', 0.85), w: cv.width, h: cv.height });
      };
      im.src = lettore.result;
    };
    lettore.readAsDataURL(file);
  });
}

// ───────────────────────── "Sposta in…" dal lazo (dividere un appunto) ─────────────────────────

function apSpostaSelezione(elementi, foto, togli) {
  const voci = [['__nuovo', '＋ Appunto nuovo (in Da sistemare)']].concat(apRighe().filter(r => apVivo(r) && r.ID !== AP.aperto)
    .sort((a, b) => (apQuando(a) < apQuando(b) ? 1 : -1)).slice(0, 40).map(r => [r.ID, (r.Titolo || 'Senza titolo') + ' · ' + apSezDi(r)]));
  apScegli('Sposta la selezione in…', voci).then(dest => {
    if (!dest) return;
    const fotoUsate = {};
    elementi.forEach(e => { if (e.t === 'foto' && foto[e.f]) fotoUsate[e.f] = foto[e.f]; });
    const metti = (id, rec, titolo) => {
      const p = rec.pagina;
      const L = apLimiti(p);
      let y0 = 1e9, x0 = 1e9;
      elementi.forEach(e => { const b = e.t === 'testo' ? { x0: e.x, y0: e.y } : apRiquadro(e); y0 = Math.min(y0, b.y0); x0 = Math.min(x0, b.x0); });
      const dy = (p.el.length ? L.h : 40) - y0, dx = 40 - x0;
      elementi.forEach(e => {
        e.id = Math.random().toString(36).slice(2, 9);
        if (e.t === 'tratto') { for (let i = 0; i < e.p.length; i += 2) { e.p[i] += dx; e.p[i + 1] += dy; } } else { e.x += dx; e.y += dy; }
        p.el.push(e);
      });
      Object.assign(p.foto, fotoUsate);
      p.modificato = new Date().toISOString();
      rec.sporca = true;
      const info = apInfoPagina(p);
      apSalvaRiga(id, Object.assign({ 'Testo': info.testo, 'Da spuntare': info.daSpuntare }, titolo ? { 'Titolo': titolo, 'Sezione': AP_FISSE.daSistemare, 'Creato il': new Date().toISOString() } : {}), true);
      apMem.mini[id] = null;
      return apScrivi(rec).then(() => { togli(); toast('Spostato in «' + (titolo || (apRiga(id) || {}).Titolo || 'appunto') + '»'); apDisegnaElenco(); });
    };
    if (dest === '__nuovo') {
      const id = nuovoId();
      metti(id, { id, pagina: apPaginaNuova(id), base: '', sporca: true }, apTitoloAuto() + ' (diviso)');
    } else apLeggi(dest).then(rec => {
      if (rec) metti(dest, rec, null);
      else apScaricaPagine([dest]).then(() => apLeggi(dest)).then(r2 => metti(dest, r2 || { id: dest, pagina: apPaginaNuova(dest), base: '', sporca: true }, null))
        .catch(() => toast('Quell\'appunto non è su questo dispositivo e non c\'è rete'));
    });
  });
}

// ───────────────────────── Appunto rapido (pop-up sopra la pagina) ─────────────────────────
// Nel tablet c'è quello nativo (più veloce, dalla home); questo serve nella web app (PC, telefono, ✎ delle dashboard).

let apRapidoAperto = null;
function apriRapido() {
  if (apRapidoAperto) return;
  const id = nuovoId();
  const adesso = new Date();
  const sf = document.createElement('div');
  sf.className = 'ap-velo ap-velo-rapido';
  sf.innerHTML = `<div class="ap-rapido">
    <div class="ap-rapido-testa">✎ <input id="ap-r-titolo" value="${esc(apTitoloAuto(adesso))}" title="Titolo (modificabile)"><span class="piccolo">va in <b>📥 Da sistemare</b></span></div>
    <div class="ap-editor ap-editor-rapido" id="ap-r-editor"></div>
    <div class="ap-rapido-piede"><span class="piccolo">senza rete si salva qui e parte dopo</span><button type="button" id="ap-r-annulla">Annulla</button><button type="button" class="primario" id="ap-r-salva">Salva</button></div>
  </div>`;
  document.body.appendChild(sf);
  document.body.classList.add('rapido-aperto');
  const pagina = apPaginaNuova(id, 'righe');
  const ed = creaEditor($('#ap-r-editor', sf), pagina, { rapido: true });
  apRapidoAperto = { sf, ed };
  const chiudi = () => { ed.distruggi(); sf.remove(); apRapidoAperto = null; document.body.classList.remove('rapido-aperto'); };
  $('#ap-r-annulla', sf).onclick = () => {
    if (!pagina.el.length) { chiudi(); return; }
    apConferma('Chiudere senza salvare?').then(si => { if (si) chiudi(); });
  };
  $('#ap-r-salva', sf).onclick = () => {
    ed.salvaSubito();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    setTimeout(() => {
      if (!pagina.el.length) { toast('La pagina è vuota'); return; }
      pagina.modificato = new Date().toISOString();
      const info = apInfoPagina(pagina);
      apScrivi({ id, pagina, base: '', sporca: true }).then(() => {
        apSalvaRiga(id, { 'Titolo': $('#ap-r-titolo', sf).value.trim() || apTitoloAuto(adesso), 'Sezione': AP_FISSE.daSistemare, 'Sottosezione': '', 'Creato il': adesso.toISOString(), 'Testo': info.testo, 'Da spuntare': info.daSpuntare, 'Fissato': false, 'Archiviato': false }, true);
        toast('Appunto in Da sistemare' + (navigator.onLine ? '' : ': lo invio appena torna il Wi-Fi'));
        chiudi();
        if (percorso().nome === 'appunti') apAggiornaTutto();
      });
    }, 60);
  };
}

/** Lasciando la sezione Appunti: salva la pagina aperta e toglie la pagina a tutta larghezza. */
function lasciaAppunti() {
  if (AP.ed) { AP.ed.salvaSubito(); AP.ed.distruggi(); AP.ed = null; AP.aperto = null; }
  document.body.classList.remove('pagina-appunti', 'ap-tutto');
}
