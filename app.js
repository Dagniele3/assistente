/* Assistente: web app offline-first.
 * Dati: Google Sheet "Assistente" tramite Apps Script (azioni dati / sync / quaderno).
 * Ogni modifica si applica subito in locale e va in coda; la coda si invia quando c'è rete.
 * Pensata per girare anche nella WebView 114 del tablet: niente funzioni web troppo recenti.
 */
'use strict';

// ───────────────────────── Memoria locale ─────────────────────────

const LS = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};

let config = LS.get('config', { url: '', token: '' });
// Dentro l'app del tablet la configurazione la decide l'app (inserita una volta sola, lì).
const tablet = window.AssistenteTablet;
if (tablet) {
  try {
    const c = JSON.parse(tablet.config());
    if (c.url && c.token) { config = c; LS.set('config', c); }
  } catch (e) { /* configurazione dell'app non leggibile: resta quella locale */ }
}
let dati = LS.get('dati', null);
let coda = LS.get('coda', []);
let statoSync = { stato: 'idle', ultimo: LS.get('ultimoSync', null), errore: '' };

const SCHEDE = ['Movimenti', 'Scheda', 'Log', 'Scadenze', 'Spesa', 'Pasti', 'Peso', 'Quaderno', 'Bollette', 'Alimenti', 'Salute', 'Attività', 'Uscite'];

function datiVuoti() {
  const schede = {};
  SCHEDE.forEach(n => { schede[n] = []; });
  return { schede, categorie: [], parametri: {}, server: null };
}
if (!dati) dati = datiVuoti();

// ───────────────────────── Utilità ─────────────────────────

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const euro0 = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('it-IT', { style: 'percent', maximumFractionDigits: 0 });

function nuovoId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function pad(n) { return String(n).padStart(2, '0'); }
function chiave(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function oggiK() { return chiave(new Date()); }
function daChiave(k) { const p = String(k).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function giorniTra(k1, k2) { return Math.round((daChiave(k2) - daChiave(k1)) / 864e5); }
function spostaGiorni(k, n) { const d = daChiave(k); d.setDate(d.getDate() + n); return chiave(d); }
function dataBreve(k) {
  if (!k) return '';
  const d = daChiave(k);
  return d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
}
function oraAdesso() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function n(v) { const x = Number(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; }
function normalizza(s) { return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function righe(scheda) { return (dati.schede && dati.schede[scheda]) || []; }
function par(nome) { return dati.parametri ? dati.parametri[nome] : undefined; }
function numPar(nome, def) { const v = Number(par(nome)); return par(nome) === '' || par(nome) == null || isNaN(v) || v === 0 ? def : v; }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('visibile');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('visibile'), 2600);
}

// ───────────────────────── Modifiche locali + coda ─────────────────────────

function applicaLocale(op) {
  if (op.tipo === 'quaderno') return;
  const elenco = dati.schede[op.scheda] || (dati.schede[op.scheda] = []);
  const i = elenco.findIndex(r => r.ID === op.id);
  if (op.tipo === 'elimina') { if (i >= 0) elenco.splice(i, 1); return; }
  const riga = Object.assign(i >= 0 ? elenco[i] : { ID: op.id }, op.valori, { 'Modificato il': op.modificato });
  if (i < 0) elenco.push(riga);
}

function salva(scheda, valori, id) {
  const op = { scheda, tipo: 'salva', id: id || nuovoId(), modificato: new Date().toISOString(), valori };
  coda.push(op);
  applicaLocale(op);
  persisti();
  pianificaSync();
  return op.id;
}

function elimina(scheda, id) {
  const op = { scheda, tipo: 'elimina', id, modificato: new Date().toISOString() };
  coda.push(op);
  applicaLocale(op);
  persisti();
  pianificaSync();
}

function persisti() {
  LS.set('dati', dati);
  if (!LS.set('coda', coda)) toast('Memoria piena: sincronizza appena possibile');
  aggiornaStato();
}

// ───────────────────────── Sincronizzazione ─────────────────────────

async function api(azione, extra) {
  if (!config.url || !config.token) throw new Error('App non configurata');
  const r = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ token: config.token, azione }, extra || {})),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.errore || 'Errore del server');
  return j;
}

let timerSync = null;
function pianificaSync(ms) {
  clearTimeout(timerSync);
  timerSync = setTimeout(sincronizza, ms == null ? 800 : ms);
}

async function sincronizza() {
  if (statoSync.stato === 'in corso') return;
  if (!config.url || !config.token) { statoSync.stato = 'da configurare'; aggiornaStato(); return; }
  // 14/11 (Daniele: sul tablet sempre "Offline"): dentro l'app del tablet navigator.onLine può restare falso anche col
  // Wi-Fi acceso, e prima non si provava nemmeno. Ora si prova sempre; "Offline" solo se il collegamento fallisce davvero.
  statoSync.stato = 'in corso'; statoSync.errore = ''; aggiornaStato();
  try {
    // Pagine del quaderno: una alla volta (contengono l'immagine).
    for (const op of coda.filter(o => o.tipo === 'quaderno')) {
      await api('quaderno', op);
      coda = coda.filter(o => o !== op);
      LS.set('coda', coda);
    }
    const inviate = coda.filter(o => o.tipo !== 'quaderno');
    if (inviate.length) {
      await api('sync', { operazioni: inviate });
      coda = coda.filter(o => inviate.indexOf(o) < 0);
      LS.set('coda', coda);
    }
    const fresco = await api('dati');
    dati = { schede: fresco.schede, categorie: fresco.categorie, parametri: fresco.parametri, casa: fresco.casa, fisico: fresco.fisico, server: fresco.server, versione: fresco.versione, batteria: fresco.batteria };
    coda.forEach(applicaLocale); // modifiche fatte durante l'invio
    LS.set('dati', dati);
    statoSync.ultimo = new Date().toISOString();
    LS.set('ultimoSync', statoSync.ultimo);
    statoSync.stato = 'ok';
    if (tablet && inviate.length) tablet.aggiornaWidget();
    ridisegnaSeLibero();
  } catch (e) {
    const rete = e instanceof TypeError || !navigator.onLine;   // fetch senza risposta = niente rete
    statoSync.stato = rete ? 'offline' : 'errore';
    statoSync.errore = e.message || String(e);
  }
  aggiornaStato();
}

function aggiornaStato() {
  const b = $('#stato');
  if (!b) return;
  b.className = 'stato-sync';
  const ora = statoSync.ultimo ? new Date(statoSync.ultimo).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : null;
  let testo;
  if (statoSync.stato === 'da configurare') testo = 'Da configurare';
  else if (statoSync.stato === 'in corso') testo = 'Sincronizzo…';
  else if (coda.length) { testo = coda.length + ' in coda'; b.classList.add('coda'); }
  else if (statoSync.stato === 'errore') { testo = 'Errore'; b.classList.add('errore'); }
  else testo = ora ? 'Aggiornato ' + ora : 'Mai sincronizzato';
  if (statoSync.stato === 'offline' && !coda.length) testo = 'Offline' + (ora ? ' · ' + ora : '');
  b.textContent = testo;
  b.title = statoSync.errore || 'Tocca per sincronizzare';
}

function ridisegnaSeLibero() {
  const a = document.activeElement;
  if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && $('#vista').contains(a)) return;
  if (document.body.classList.contains('quaderno-aperto')) return;
  disegna();
}

// ───────────────────────── Calcoli ─────────────────────────

const DA_ASSEGNARE = 'Da assegnare';

/** Tipo della categoria dalla scheda Categorie: Spesa (anche se vuota o sconosciuta), Entrata, Risparmio. */
function tipoCat(nome) {
  const c = (dati.categorie || []).find(x => x.nome === (nome || '').trim());
  return (c && c.tipo) || 'Spesa';
}

/** Spesa netta (uscite − rimborsi) dei movimenti di Tipo Spesa nel periodo; con "categoria" solo di quella. */
function uscite(da, a, categoria) {
  let tot = 0;
  righe('Movimenti').forEach(m => {
    if (!m.Data || m.Data < da || m.Data > a) return;
    if (categoria !== undefined ? (m.Categoria || '') !== categoria : tipoCat(m.Categoria) !== 'Spesa') return;
    tot -= n(m['Importo (uscite negative)']);
  });
  return tot;
}

function entrate(da, a) {
  let tot = 0;
  righe('Movimenti').forEach(m => {
    if (m.Data && m.Data >= da && m.Data <= a && tipoCat(m.Categoria) === 'Entrata') tot += n(m['Importo (uscite negative)']);
  });
  return tot;
}

/** Budget totale: somma dei budget delle categorie di Tipo Spesa; se nessuna ne ha, il parametro "Budget mensile (€)". */
function budgetTotale() {
  const d = budgetDin();
  if (d) return d.totale;
  const s = (dati.categorie || []).filter(c => (c.tipo || 'Spesa') === 'Spesa').reduce((t, c) => t + (n(c.budget) || 0), 0);
  return s > 0 ? s : numPar('Budget mensile (€)', null);
}

/** Mese "yyyy-mm" da mostrare: quello chiesto, altrimenti il corrente (nei giorni 1–3 il precedente). */
function meseDefault() {
  const o = new Date();
  return chiave(new Date(o.getFullYear(), o.getMonth() - (o.getDate() <= 3 ? 1 : 0), 1)).slice(0, 7);
}
function spostaMese(m, k) { const d = daChiave(m + '-01'); return chiave(new Date(d.getFullYear(), d.getMonth() + k, 1)).slice(0, 7); }
function nomeMese(m, breve) {
  return daChiave(m + '-01').toLocaleDateString('it-IT', breve ? { month: 'short' } : { month: 'long', year: 'numeric' });
}

/** Numeri del mese "yyyy-mm" (default: mese corrente). Mese in corso: fino a oggi, con proiezione; mese chiuso: intero. */
function calcFinanze(mese) {
  const oggi = new Date();
  const corrente = chiave(oggi).slice(0, 7);
  mese = mese || corrente;
  const d0 = daChiave(mese + '-01'), y = d0.getFullYear(), m = d0.getMonth();
  const inCorso = mese === corrente;
  const giorniMese = new Date(y, m + 1, 0).getDate();
  const g = inCorso ? oggi.getDate() : giorniMese;
  const inizio = chiave(new Date(y, m, 1)), fine = chiave(new Date(y, m, g)), fineMese = chiave(new Date(y, m, giorniMese));
  const giorniPrec = new Date(y, m, 0).getDate();
  const inizioPrec = chiave(new Date(y, m - 1, 1));
  const finePrec = chiave(new Date(y, m - 1, Math.min(g, giorniPrec)));
  const speso = uscite(inizio, fine);
  const spesoPrec = uscite(inizioPrec, finePrec);
  const proiezione = inCorso ? speso / g * giorniMese : speso;
  const budget = budgetTotale();
  const soglia = numPar('Soglia di attenzione (% del budget)', 0.8);
  let stato = 'neutro';
  if (budget) stato = proiezione > budget ? 'rosso' : speso > budget * soglia ? 'giallo' : 'verde';
  const categorie = (dati.categorie || []).filter(c => (c.tipo || 'Spesa') === 'Spesa').map(c => {
    const s = uscite(inizio, fine, c.nome);
    const sp = uscite(inizioPrec, finePrec, c.nome);
    let st = 'neutro';
    if (c.budget) st = s >= c.budget ? 'rosso' : s > c.budget * soglia ? 'giallo' : 'verde';
    return { nome: c.nome, speso: s, prec: sp, budget: c.budget, stato: st };
  });
  const senza = uscite(inizio, fine, '');
  if (senza > 0) categorie.push({ nome: 'Senza categoria', speso: senza, prec: uscite(inizioPrec, finePrec, ''), budget: null, stato: 'neutro' });
  const ent = entrate(inizio, fineMese);
  return { mese, inCorso, speso, spesoPrec, proiezione, budget, soglia, stato, avviso: !!(inCorso && budget && proiezione > budget), g, giorniMese,
    categorie, inizio, fine, entrate: ent, risparmio: ent - uscite(inizio, fineMese) };
}

function mediaMensile(categoria, mesi) {
  const oggi = new Date();
  const da = chiave(new Date(oggi.getFullYear(), oggi.getMonth() - mesi, 1));
  const a = chiave(new Date(oggi.getFullYear(), oggi.getMonth(), 0));
  return uscite(da, a, categoria) / mesi;
}

/**
 * v9: aperte = scadenze (Tipo vuoto o "Scadenza") non fatte/chiuse; quelle "si chiude da sola" passate vanno nello storico
 * invece di diventare scadute. storico = fatte, chiuse, eventi registrati e chiuse da sole, dalla più recente
 * ("quando" = Fatta il, altrimenti la data).
 */
function calcScadenze() {
  const entro = numPar('Giorni per "in scadenza"', 7);
  const oggi = oggiK();
  const aperte = [], storico = [];
  righe('Scadenze').filter(s => s.Data).forEach(s => {
    const stato = normalizza(s.Stato), evento = normalizza(s.Tipo).indexOf('evento') === 0;
    const giorni = giorniTra(oggi, s.Data);
    const daSola = s['Si chiude da sola'] === true && giorni < 0;
    if (evento || stato === 'chiusa' || stato === 'fatta' || daSola) {
      storico.push(Object.assign({}, s, { giorni, daSola: daSola && stato !== 'fatta', quando: String(s['Fatta il'] || s.Data).slice(0, 10) }));
    } else aperte.push(Object.assign({}, s, { giorni }));
  });
  aperte.sort((a, b) => a.giorni - b.giorni);
  storico.sort((a, b) => b.quando.localeCompare(a.quando));
  return { aperte, storico, entro, prossima: aperte[0] || null, inScadenza: aperte.filter(s => s.giorni <= entro).length, scadute: aperte.filter(s => s.giorni < 0).length };
}

const GIORNI = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

function calcAllenamento() {
  const oggi = new Date();
  const k = chiave(oggi);
  const giornoOggi = normalizza(GIORNI[oggi.getDay()]);
  const scheda = righe('Scheda');
  const eserciziOggi = scheda.filter(e => normalizza(e.Giorno) === giornoOggi);
  const lun = chiave(new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - ((oggi.getDay() + 6) % 7)));
  const giorniFatti = {};
  let fattoOggi = false;
  righe('Log').forEach(l => {
    if (!l.Data) return;
    if (l.Data === k) fattoOggi = true;
    if (l.Data >= lun && l.Data <= k) giorniFatti[l.Data] = true;
  });
  const giorniScheda = {};
  scheda.forEach(e => { if (e.Giorno) giorniScheda[normalizza(e.Giorno)] = true; });
  const obiettivo = numPar('Allenamenti a settimana (obiettivo)', Object.keys(giorniScheda).length);
  return { stato: fattoOggi ? 'fatto' : eserciziOggi.length ? 'da fare' : 'riposo', eserciziOggi, settimana: Object.keys(giorniFatti).length, obiettivo };
}

function calcPeso() {
  const misure = righe('Peso').filter(p => p.Data && n(p['Peso (kg)']) > 0)
    .map(p => ({ data: p.Data, kg: n(p['Peso (kg)']), id: p.ID }))
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  if (!misure.length) return { misure, ultimo: null, var30: null };
  const ultimo = misure[misure.length - 1];
  const k30 = spostaGiorni(oggiK(), -30);
  const prima = misure.filter(x => x.data <= k30);
  const rif = prima.length ? prima[prima.length - 1] : misure[0];
  return { misure, ultimo, var30: rif === ultimo ? null : ultimo.kg - rif.kg };
}

function pastiOggi() {
  const k = oggiK();
  return righe('Pasti').filter(p => p.Data === k).sort((a, b) => String(a.Ora || '').localeCompare(String(b.Ora || '')));
}

// ───────────────────────── Router ─────────────────────────

const VISTE = {
  '': vistaHome, finanze: vistaFinanze, movimenti: vistaMovimenti, budget: vistaBudget, bollette: vistaBollette, mutuo: vistaMutuo, scadenze: vistaScadenze, spesa: vistaSpesa,
  allenamento: vistaAllenamento, scheda: vistaScheda, progressi: vistaProgressi,
  cibo: vistaCibo, dieta: vistaCibo, piano: vistaPiano, controlli: vistaControlli, peso: vistaPeso, impostazioni: main => vistaImpostazioni(main, false),
  fuori: vistaFuori, uscita: vistaUscita, anno: vistaAnnoFuori, vola: vistaSiVola, // v8
  tranquillita: vistaTranquillita, // v10
};

function percorso() {
  const h = location.hash.replace(/^#\/?/, '');
  const parti = h.split('?');
  return { nome: parti[0], query: new URLSearchParams(parti[1] || '') };
}

function disegna() {
  const p = percorso();
  if (p.nome === 'quaderno') { apriQuaderno(p.query.get('dest') || 'Nessuna'); return; }
  chiudiQuadernoSeAperto();
  const vista = VISTE[p.nome] || vistaHome;
  aggiornaBadgeFuori(); // v8
  $$('#nav a').forEach(a => a.classList.toggle('attiva', a.getAttribute('href') === '#/' + gruppoNav(p.nome)));
  const main = $('#vista');
  if (!config.url || !config.token) { vistaImpostazioni(main, true); return; }
  vista(main, p.query);
  window.scrollTo(0, 0);
}

function bottonePenna(dest) {
  return '<button class="penna" type="button" title="Scrivi a penna" onclick="location.hash=\'#/quaderno?dest=' + esc(dest) + '\'">✎</button>';
}

// ───────────────────────── Viste ─────────────────────────

function vistaHome(main) {
  const f = calcFinanze(), s = calcScadenze(), a = calcAllenamento(), p = calcPeso();
  const daComprare = righe('Spesa').filter(x => x.Articolo && x.Preso !== true).length;
  const pasti = pastiOggi();
  const pall = st => '<span class="pallino ' + (st === 'neutro' ? '' : st) + '"></span>';
  main.innerHTML = `
    <h1>Oggi, ${esc(new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }))}</h1>
    <div class="griglia">
      <a class="carta ${f.avviso ? 'avviso' : ''}" href="#/finanze">
        <div class="etichetta">Finanze ${pall(f.stato)}</div>
        <div class="grande num">${euro0.format(f.speso)}${f.budget ? ' <span class="piccolo">/ ' + euro0.format(f.budget) + '</span>' : ''}</div>
        <div class="riga2">Proiezione ${euro0.format(f.proiezione)}${f.avviso ? ' · <span class="testo-rosso">occhio</span>' : ''}</div>
      </a>
      <a class="carta" href="#/scadenze">
        <div class="etichetta">Scadenze ${pall(s.scadute ? 'rosso' : s.inScadenza ? 'giallo' : 'verde')}</div>
        <div class="grande">${s.prossima ? esc(s.prossima.Titolo) : 'Nessuna'}</div>
        <div class="riga2">${s.prossima ? testoGiorni(s.prossima.giorni) + ' · ' : ''}${s.inScadenza} entro ${s.entro} giorni</div>
      </a>
      <a class="carta" href="#/spesa">
        <div class="etichetta">Spesa</div>
        <div class="grande num">${daComprare}</div>
        <div class="riga2">da comprare</div>
      </a>
      <a class="carta" href="#/allenamento">
        <div class="etichetta">Allenamento ${pall(a.stato === 'fatto' ? 'verde' : a.stato === 'da fare' ? 'giallo' : 'neutro')}</div>
        <div class="grande">Oggi: ${esc(a.stato)}</div>
        <div class="riga2">Settimana ${a.settimana}${a.obiettivo ? '/' + a.obiettivo : ''}</div>
      </a>
      <a class="carta" href="#/dieta">
        <div class="etichetta">Dieta</div>
        <div class="grande num">${pasti.length} ${pasti.length === 1 ? 'pasto' : 'pasti'}</div>
        <div class="riga2">${pasti.length ? esc(pasti.map(x => x.Pasto).join(', ')) : 'registrati oggi'}</div>
      </a>
      <a class="carta" href="#/peso">
        <div class="etichetta">Peso</div>
        <div class="grande num">${p.ultimo ? num1.format(p.ultimo.kg) + ' kg' : '—'}</div>
        <div class="riga2">${p.var30 == null ? 'variazione 30 giorni: —' : (p.var30 <= 0 ? '↓ ' : '↑ ') + num1.format(Math.abs(p.var30)) + ' kg in 30 giorni'}</div>
      </a>
    </div>
    <p class="piccolo" style="margin-top:24px"><a href="#/impostazioni">Impostazioni</a></p>`;
}

function testoGiorni(g) {
  if (g < 0) return '<span class="testo-rosso">scaduta da ' + -g + (g === -1 ? ' giorno' : ' giorni') + '</span>';
  if (g === 0) return '<span class="testo-giallo">oggi</span>';
  if (g === 1) return 'domani';
  return 'tra ' + g + ' giorni';
}

// Finanze ────────────────────────────

function vistaFinanze(main, query) {
  const mese = (query && query.get('mese')) || meseDefault();
  const f = calcFinanze(mese);
  const mesiMedia = numPar('Mesi per la media (simulazione)', 3);
  const catSpesa = (dati.categorie || []).filter(c => (c.tipo || 'Spesa') === 'Spesa' && c.nome !== DA_ASSEGNARE).map(c => c.nome);
  const recenti = righe('Movimenti').slice().sort((a, b) => (a.Data < b.Data ? 1 : -1)).slice(0, 8);
  const delta = f.spesoPrec ? (f.speso - f.spesoPrec) / f.spesoPrec : 0;
  const daAss = righe('Movimenti').filter(m => (m.Categoria || '').trim() === DA_ASSEGNARE).length;
  const resta = f.budget ? f.budget - f.proiezione : null;
  const catMese = f.categorie.filter(c => c.speso > 0.5).sort((a, b) => b.speso - a.speso);

  main.innerHTML = `
    <div class="testata"><h1>Finanze</h1>${selettoreMese('finanze', mese)}</div>
    ${schedeFinanze('finanze')}
    ${f.avviso ? `<div class="avviso-box"><strong>Occhio:</strong> a questo ritmo il mese chiude a ${euro0.format(f.proiezione)}, oltre il budget di ${euro0.format(f.budget)}.</div>` : ''}
    <div class="griglia-2">
      <a class="carta" href="#/movimenti?mese=${mese}"><div class="etichetta">Speso</div>
        <div class="grande num">${euro0.format(f.speso)}</div>
        <div class="riga2">vs ${nomeMese(f.inCorso ? spostaMese(mese, -1) : spostaMese(mese, -1), true)} <span class="${delta > 0 ? 'testo-giallo' : 'testo-verde'}">${delta > 0 ? '+' : ''}${pct.format(delta)}</span></div></a>
      <a class="carta" href="#/budget"><div class="etichetta">${f.inCorso ? 'Fine mese vs budget' : 'Vs budget'}</div>
        <div class="grande num">${f.budget ? '/ ' + euro0.format(f.budget) : '—'}</div>
        <div class="riga2 ${resta == null ? '' : resta >= 0 ? 'testo-verde' : 'testo-giallo'}">${resta == null ? 'imposta i budget' : (resta >= 0 ? 'restano ' : 'sfori di ') + euro0.format(Math.abs(resta))}</div></a>
      <div class="carta"><div class="etichetta">Risparmio</div>
        <div class="grande num ${f.risparmio < 0 ? 'testo-giallo' : 'testo-verde'}">${f.risparmio >= 0 ? '+' : ''}${euro0.format(f.risparmio)}</div>
        <div class="riga2">entrate ${euro0.format(f.entrate)}</div></div>
      <a class="carta ${daAss ? 'evidenza' : ''}" href="#/movimenti?filtro=assegnare"><div class="etichetta">Da assegnare</div>
        <div class="grande num ${daAss ? 'testo-giallo' : 'testo-verde'}">${daAss}</div>
        <div class="riga2">${daAss ? 'tocca per sistemarli' : 'tutto a posto'}</div></a>
    </div>

    <h2>Categorie · ${nomeMese(mese)}</h2>
    <ul class="elenco carta">${catMese.length ? catMese.map(c => `<li class="toccabile" data-cat="${esc(c.nome)}">
      <div class="corpo">${esc(c.nome)}</div>
      <div class="num ${c.budget && c.speso > c.budget ? 'testo-giallo' : ''}">${euro0.format(c.speso)}${c.budget ? ' <span class="piccolo">/ ' + euro0.format(c.budget) + '</span>' : ''}</div></li>`).join('')
      : '<li class="vuoto">Nessuna spesa nel mese.</li>'}
      <li class="toccabile" data-vai="#/movimenti?mese=${mese}"><div class="corpo piccolo">tocca una categoria → movimenti</div><div>›</div></li></ul>
    <div class="azioni"><a class="bottone" href="#/movimenti?mese=${mese}">Tutti i movimenti</a><a class="bottone primario" href="#/budget">Budget</a></div>

    ${sezioneDaAssegnare()}

    <div class="azioni"><a class="bottone" href="#/bollette">Bollette e utenze</a><a class="bottone" href="#/mutuo">Mutuo</a></div>

    <h2>Ultimi movimenti</h2>
    <ul class="elenco carta">${recenti.length ? recenti.map(m => `<li>
      <div class="corpo"><div>${esc(m.Descrizione)}</div><div class="sotto">${dataBreve(m.Data)} · ${esc(m.Categoria || 'senza categoria')}</div></div>
      <div class="num ${n(m['Importo (uscite negative)']) > 0 ? 'testo-verde' : ''}">${euro.format(n(m['Importo (uscite negative)']))}</div>
      <button class="piccolo-b" data-elimina="${esc(m.ID)}" title="Elimina">✕</button></li>`).join('') : '<li class="vuoto">Nessun movimento: arrivano dall\'import della banca (cartella "Movimenti banca").</li>'}</ul>
    ${bottonePenna('Movimenti')}`;

  // v10 §7: niente più "Spesa veloce" (un movimento scritto a mano si sommava a quello importato dalla banca).
  collegaMese(main);
  $$('[data-cat]', main).forEach(li => {
    li.onclick = () => { location.hash = '#/movimenti?mese=' + mese + '&categoria=' + encodeURIComponent(li.dataset.cat); };
  });
  $$('[data-vai]', main).forEach(li => { li.onclick = () => { location.hash = li.dataset.vai; }; });
  collegaElimina(main, 'Movimenti');
  collegaDaAssegnare(main);
  if (query && query.get('vista') === 'assegna' && $('#da-assegnare', main)) setTimeout(() => $('#da-assegnare', main).scrollIntoView(), 0);
}

// Selettore del mese (Finanze, Movimenti) ────────────────────────────

function selettoreMese(vista, mese) {
  const primo = righe('Movimenti').reduce((p, m) => (m.Data && m.Data.slice(0, 7) < p ? m.Data.slice(0, 7) : p), chiave(new Date()).slice(0, 7));
  const ultimo = chiave(new Date()).slice(0, 7);
  return `<div class="mese-sel" data-vista="${vista}">
    <button type="button" class="piccolo-b" data-mese="${spostaMese(mese, -1)}" ${mese <= primo ? 'disabled' : ''} aria-label="Mese prima">‹</button>
    <span>${nomeMese(mese)}</span>
    <button type="button" class="piccolo-b" data-mese="${spostaMese(mese, 1)}" ${mese >= ultimo ? 'disabled' : ''} aria-label="Mese dopo">›</button></div>`;
}

function collegaMese(main) {
  $$('.mese-sel [data-mese]', main).forEach(b => {
    b.onclick = () => {
      const p = percorso();
      p.query.set('mese', b.dataset.mese);
      location.hash = '#/' + $('.mese-sel', main).dataset.vista + '?' + p.query.toString();
    };
  });
}

// Movimenti: elenco completo con ricerca, filtri, ordinamento, selezione e somma ────────────────────────────
// Parametri nell'indirizzo: mese=yyyy-mm (o "tutti"), categoria=… (anche più volte), filtro=spese|entrate|assegnare, id=… (evidenziato).

const statoMov = { testo: '', tipo: 'tutte', cats: [], ordine: 'data', giu: true, sel: {} };

function vistaMovimenti(main, query) {
  const q = query || new URLSearchParams();
  const chiaveQ = q.toString();
  if (statoMov.chiaveQ !== chiaveQ) {
    // Arrivo da un link (tablet, Finanze): i parametri impostano i filtri; poi restano quelli scelti sulla pagina.
    statoMov.chiaveQ = chiaveQ;
    statoMov.mese = q.get('mese') || meseDefault();
    statoMov.cats = q.getAll('categoria');
    statoMov.tipo = q.get('filtro') === 'assegnare' ? 'assegnare' : q.get('filtro') === 'entrate' ? 'entrate' : q.get('filtro') === 'spese' ? 'spese' : 'tutte';
    if (statoMov.tipo === 'assegnare' || q.get('id')) statoMov.mese = 'tutti';
    statoMov.id = q.get('id') || '';
    statoMov.sel = {};
  }
  disegnaMovimenti(main);
}

function filtraMovimenti() {
  const s = statoMov, testo = normalizza(s.testo);
  let l = righe('Movimenti').filter(m => m.Data);
  if (s.mese !== 'tutti') l = l.filter(m => m.Data.slice(0, 7) === s.mese);
  if (s.tipo === 'spese') l = l.filter(m => n(m['Importo (uscite negative)']) < 0 && tipoCat(m.Categoria) === 'Spesa');
  if (s.tipo === 'entrate') l = l.filter(m => tipoCat(m.Categoria) === 'Entrata');
  if (s.tipo === 'assegnare') l = l.filter(m => (m.Categoria || '').trim() === DA_ASSEGNARE);
  if (s.cats.length) l = l.filter(m => s.cats.indexOf((m.Categoria || '').trim()) >= 0);
  if (testo) l = l.filter(m => normalizza(m.Descrizione + ' ' + (m.Categoria || '')).indexOf(testo) >= 0);
  const v = m => s.ordine === 'data' ? m.Data : n(m['Importo (uscite negative)']);
  l.sort((a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * (s.giu ? -1 : 1));
  return l;
}

function disegnaMovimenti(main) {
  const s = statoMov, l = filtraMovimenti();
  const categorie = (dati.categorie || []).map(c => c.nome);
  const spese = l.filter(m => tipoCat(m.Categoria) === 'Spesa').reduce((t, m) => t - n(m['Importo (uscite negative)']), 0);
  const ent = l.filter(m => tipoCat(m.Categoria) === 'Entrata').reduce((t, m) => t + n(m['Importo (uscite negative)']), 0);
  const daAss = righe('Movimenti').filter(m => (m.Categoria || '').trim() === DA_ASSEGNARE).length;
  const mesi = [];
  for (let m = chiave(new Date()).slice(0, 7), i = 0; i < 18; i++, m = spostaMese(m, -1)) mesi.push(m);
  const nSel = Object.keys(s.sel).length;
  const sommaSel = l.filter(m => s.sel[m.ID]).reduce((t, m) => t + n(m['Importo (uscite negative)']), 0);
  const chip = (val, testo) => `<button type="button" class="chip ${s.tipo === val ? 'attivo' : ''} ${val === 'assegnare' ? 'chip-giallo' : ''}" data-tipo="${val}">${testo}</button>`;

  main.innerHTML = `
    <div class="testata"><h1>Movimenti</h1>
      <select id="mov-mese" aria-label="Mese"><option value="tutti">tutti i mesi</option>${mesi.map(m => `<option value="${m}" ${m === s.mese ? 'selected' : ''}>${nomeMese(m)}</option>`).join('')}</select></div>
    ${schedeFinanze('movimenti')}
    <input id="mov-cerca" type="search" placeholder="⌕ cerca (glovo, iren…)" value="${esc(s.testo)}" class="largo-tutto">
    <div class="chips">${chip('tutte', 'Tutte')}${chip('spese', 'Spese')}${chip('entrate', 'Entrate')}${chip('assegnare', 'Da assegnare ' + daAss)}</div>
    <div class="chips">
      <details class="menu-cat"><summary class="chip ${s.cats.length ? 'attivo' : ''}">Categorie${s.cats.length ? ' (' + s.cats.length + ')' : ''} ▾</summary>
        <div class="menu">${categorie.map(c => `<label><input type="checkbox" data-filtro-cat="${esc(c)}" ${s.cats.indexOf(c) >= 0 ? 'checked' : ''}> ${esc(c)}</label>`).join('')}
          ${s.cats.length ? '<button type="button" class="piccolo-b" id="cat-tutte">Tutte le categorie</button>' : ''}</div></details>
      <button type="button" class="chip ${s.ordine === 'data' ? 'attivo' : ''}" data-ordine="data">${s.ordine === 'data' ? (s.giu ? '↓ ' : '↑ ') : ''}data</button>
      <button type="button" class="chip ${s.ordine === 'importo' ? 'attivo' : ''}" data-ordine="importo">${s.ordine === 'importo' ? (s.giu ? '↓ ' : '↑ ') : ''}importo</button>
    </div>
    <p class="piccolo">${l.length} movimenti · spese ${euro0.format(spese)} · entrate ${euro0.format(ent)}</p>
    <ul class="elenco carta movimenti">${l.length ? l.slice(0, 400).map(m => {
      const imp = n(m['Importo (uscite negative)']);
      return `<li data-id="${esc(m.ID)}" class="${s.sel[m.ID] ? 'selezionato' : ''} ${m.ID === s.id ? 'cercato' : ''}">
        <input type="checkbox" data-sel="${esc(m.ID)}" ${s.sel[m.ID] ? 'checked' : ''} aria-label="Seleziona">
        <div class="corpo"><div>${esc(m.Descrizione)}</div>
          <div class="sotto">${dataBreve(m.Data)} · <select class="cat-riga ${(m.Categoria || '') === DA_ASSEGNARE ? 'testo-giallo' : ''}" data-cat-id="${esc(m.ID)}" aria-label="Categoria">
            ${(categorie.indexOf(m.Categoria) < 0 ? ['<option selected>' + esc(m.Categoria || 'senza categoria') + '</option>'] : []).join('')}
            ${categorie.map(c => `<option ${c === m.Categoria ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div></div>
        <div class="num ${imp > 0 ? 'testo-verde' : ''}">${imp > 0 ? '+' : ''}${euro.format(imp)}</div></li>`;
    }).join('') + (l.length > 400 ? `<li class="vuoto">… altri ${l.length - 400}: restringi con i filtri</li>` : '')
      : '<li class="vuoto">Nessun movimento con questi filtri.</li>'}</ul>
    <div class="barra-sel ${nSel ? 'visibile' : ''}">
      <span>${nSel} selezionati</span><strong class="num">${euro.format(sommaSel)}</strong>
      <select id="sel-cat" aria-label="Assegna categoria"><option value="">categoria ▾</option>${categorie.map(c => `<option>${esc(c)}</option>`).join('')}</select>
      <button type="button" class="piccolo-b" id="sel-annulla">✕</button></div>
    <div id="regole-box"></div>`;

  const ridisegna = () => { const y = window.scrollY; disegnaMovimenti(main); window.scrollTo(0, y); };
  $('#mov-mese', main).onchange = e => { s.mese = e.target.value; s.sel = {}; ridisegna(); };
  let t;
  $('#mov-cerca', main).oninput = e => {
    s.testo = e.target.value;
    clearTimeout(t);
    t = setTimeout(() => { disegnaMovimenti(main); const c = $('#mov-cerca', main); c.focus(); c.setSelectionRange(c.value.length, c.value.length); }, 250);
  };
  $$('[data-tipo]', main).forEach(b => { b.onclick = () => { s.tipo = b.dataset.tipo; if (s.tipo === 'assegnare') s.mese = 'tutti'; s.sel = {}; ridisegna(); }; });
  $$('[data-ordine]', main).forEach(b => {
    b.onclick = () => { if (s.ordine === b.dataset.ordine) s.giu = !s.giu; else { s.ordine = b.dataset.ordine; s.giu = true; } ridisegna(); };
  });
  $$('[data-filtro-cat]', main).forEach(cb => {
    cb.onchange = () => {
      const c = cb.dataset.filtroCat;
      s.cats = cb.checked ? s.cats.concat([c]) : s.cats.filter(x => x !== c);
      ridisegna();
      const d = $('.menu-cat', main); if (d) d.open = true;
    };
  });
  if ($('#cat-tutte', main)) $('#cat-tutte', main).onclick = () => { s.cats = []; ridisegna(); };
  $$('[data-sel]', main).forEach(cb => {
    cb.onchange = () => { if (cb.checked) s.sel[cb.dataset.sel] = true; else delete s.sel[cb.dataset.sel]; ridisegna(); };
  });
  $$('[data-cat-id]', main).forEach(sel => {
    sel.onchange = () => {
      salva('Movimenti', { 'Categoria': sel.value }, sel.dataset.catId); toast(sel.value);
      // v10 §9: "Vale anche per i prossimi?" con la parola proposta (azione parolaChiave).
      const m = righe('Movimenti').find(x => x.ID === sel.dataset.catId);
      s.proposta = sel.value !== DA_ASSEGNARE ? { id: sel.dataset.catId, categoria: sel.value, parola: parolaProposta(m && m.Descrizione) } : null;
      ridisegna();
    };
  });
  if (s.proposta) {
    const li = $('[data-id="' + CSS.escape(s.proposta.id) + '"]', main);
    if (li) {
      const p = s.proposta, box = document.createElement('li');
      box.className = 'carta scorciatoia';
      box.innerHTML = `<div class="aggiungi-parola">Vale anche per i prossimi? Aggiungi la parola <input value="${esc(p.parola)}"> a <strong>${esc(p.categoria)}</strong>
        <button type="button" class="primario">Aggiungi</button><button type="button" class="piccolo-b">No</button></div>`;
      li.after(box);
      const [si, no] = $$('button', box);
      no.onclick = () => { s.proposta = null; box.remove(); };
      si.onclick = async () => {
        const parola = $('input', box).value.trim();
        if (parola.length < 3) { toast('Parola troppo corta'); return; }
        try {
          const r = await api('parolaChiave', { categoria: p.categoria, parola });
          toast('Ricordata per ' + p.categoria + (r.applicate ? ': assegnati altri ' + r.applicate : ''));
          s.proposta = null; testiMov = null;
          sincronizza();
        } catch (e) { toast('Serve la rete: ' + (e.message || e)); }
      };
    }
  }
  disegnaRegoleCategorie($('#regole-box', main));
  $('#sel-cat', main).onchange = e => {
    const c = e.target.value;
    if (!c) return;
    Object.keys(s.sel).forEach(id => salva('Movimenti', { 'Categoria': c }, id));
    toast(Object.keys(s.sel).length + ' → ' + c);
    s.sel = {};
    ridisegna();
  };
  $('#sel-annulla', main).onclick = () => { s.sel = {}; ridisegna(); };
  if (s.id) {
    const li = $('[data-id="' + CSS.escape(s.id) + '"]', main);
    if (li) setTimeout(() => li.scrollIntoView({ block: 'center' }), 0);
  }
}

// Schede di Finanze (SPEC v6 §F1) ────────────────────────────

const SCHEDE_FINANZE = [['finanze', 'Panoramica'], ['movimenti', 'Movimenti'], ['budget', 'Budget'], ['bollette', 'Bollette'], ['mutuo', 'Mutuo']];

function schedeFinanze(attiva) {
  return `<nav class="schede-fin">${SCHEDE_FINANZE.map(s => `<a href="#/${s[0]}" class="${s[0] === attiva ? 'attiva' : ''}">${s[1]}</a>`).join('')}</nav>`;
}

// Budget dinamico (SPEC v6 §F2) ────────────────────────────
// Totale = media delle ENTRATE dei 3 mesi chiusi − risparmio programmato. Categorie (Tipo Spesa) collegate a totale fisso:
// alzandone una, le altre non bloccate scendono in proporzione al loro peso. Salvataggio: colonna "Budget mensile (€)"
// di Categorie (azione budget) e parametro "Risparmio programmato (%)" (azione parametri).

let salvaBudgetTimer = null;
const RISPARMI = [5, 10, 15, 20];

/** Categorie che ricevono un budget: Tipo Spesa, escluso "Da assegnare". */
function catBudget() { return (dati.categorie || []).filter(c => (c.tipo || 'Spesa') === 'Spesa' && c.nome !== DA_ASSEGNARE); }

/** Spesa per categoria nei 3 mesi chiusi precedenti (per le proporzioni). */
function spesa3Mesi() {
  const o = new Date(), da = chiave(new Date(o.getFullYear(), o.getMonth() - 3, 1)), a = chiave(new Date(o.getFullYear(), o.getMonth(), 0));
  const out = {};
  catBudget().forEach(c => { out[c.nome] = Math.max(0, uscite(da, a, c.nome)); });
  return out;
}

/** Budget proporzionali alla spesa dei 3 mesi, arrotondati a 10 € (l'ultimo assorbe l'arrotondamento). */
function proporzioni(totale, bloccate, attuali) {
  const s3 = spesa3Mesi(), nomi = Object.keys(s3);
  const fissi = nomi.filter(x => bloccate[x]).reduce((t, x) => t + (attuali[x] || 0), 0);
  const liberi = nomi.filter(x => !bloccate[x]);
  const peso = liberi.reduce((t, x) => t + s3[x], 0) || liberi.length;
  const out = Object.assign({}, attuali);
  let resto = Math.max(0, totale - fissi);
  liberi.forEach((x, i) => {
    const v = i === liberi.length - 1 ? resto : Math.round(Math.max(0, totale - fissi) * (s3[x] || (peso === liberi.length ? 1 : 0)) / peso / 10) * 10;
    out[x] = Math.max(0, Math.min(v, resto));
    resto -= out[x];
  });
  return out;
}

/** Media entrate dei 3 mesi chiusi, risparmio (%) e totale da spendere; null senza entrate. */
function budgetDin(rispOverride) {
  const o = new Date(), da = chiave(new Date(o.getFullYear(), o.getMonth() - 3, 1)), a = chiave(new Date(o.getFullYear(), o.getMonth(), 0));
  let media = entrate(da, a) / 3;
  if (!(media > 0) && dati.budgetDinamico) media = dati.budgetDinamico.mediaEntrate;
  const rp = par('Risparmio programmato (%)');
  let r = rispOverride != null ? rispOverride : rp === '' || rp == null ? null : n(rp);
  if (r != null && r > 0 && r < 1) r *= 100;
  if (!(media > 0) || r == null) return null;
  return { media, risparmio: r, totale: Math.round(media * (1 - r / 100) / 10) * 10 };
}

function vistaBudget(main) {
  const cats = catBudget();
  const din = budgetDin() || budgetDin(10) || { media: 0, risparmio: 10, totale: 0 };
  const bloccate = LS.get('budgetBloccate', {});
  const modo = LS.get('budgetModo', 'euro');
  const attuali = {};
  cats.forEach(c => { attuali[c.nome] = n(c.budget) || 0; });
  const somma = Object.values(attuali).reduce((a, b) => a + b, 0);
  // Prima volta (o totale cambiato): budget proporzionali alla spesa dei 3 mesi.
  let budget = Math.abs(somma - din.totale) > 15 ? proporzioni(din.totale, bloccate, attuali) : attuali;
  const daSalvare = budget !== attuali;
  const s3 = spesa3Mesi();

  const riga = c => `<div class="budget-riga" data-riga="${esc(c.nome)}">
      <div class="budget-testa"><span>${esc(c.nome)} <button type="button" class="lucchetto ${bloccate[c.nome] ? 'chiuso' : ''}" data-blocca="${esc(c.nome)}"
        aria-label="Blocca ${esc(c.nome)}">${bloccate[c.nome] ? '🔒' : '🔓'}</button></span><strong class="num" data-val></strong></div>
      <input type="range" min="0" max="${din.totale}" step="10" value="${budget[c.nome] || 0}" data-budget="${esc(c.nome)}" aria-label="Budget ${esc(c.nome)}">
      <div class="piccolo">ultimi 3 mesi ${euro0.format(s3[c.nome] / 3)}/mese</div></div>`;

  main.innerHTML = `
    <div class="testata"><h1>Budget</h1><span class="piccolo">${nomeMese(chiave(new Date()).slice(0, 7))} · si salva da solo</span></div>
    ${schedeFinanze('budget')}
    <div class="carta">
      <div class="etichetta">Budget totale</div>
      <div class="budget-testa"><span>media entrate 3 mesi</span><strong class="num">${euro0.format(din.media)}</strong></div>
      <div class="budget-testa" style="align-items:center;margin-top:8px"><span>risparmio programmato</span>
        <span class="chips" style="margin:0">${RISPARMI.map(r => `<button type="button" class="chip ${r === din.risparmio ? 'attivo' : ''}" data-risparmio="${r}">−${r}%</button>`).join('')}</span></div>
      <div class="budget-testa totale"><span>da spendere</span><strong class="num grande">${euro0.format(din.totale)}</strong></div>
      <div class="testo-verde">risparmio previsto ${euro0.format(din.media - din.totale)}/mese · ${euro0.format((din.media - din.totale) * 12)} in 12 mesi</div>
    </div>
    <div class="carta budget" style="margin-top:12px">
      <div class="budget-testa"><span class="etichetta" style="margin:0">Per categoria</span>
        <span class="chips" style="margin:0"><button type="button" class="chip ${modo === 'euro' ? 'attivo' : ''}" data-modo="euro">€</button><button type="button" class="chip ${modo === 'pct' ? 'attivo' : ''}" data-modo="pct">%</button></span></div>
      <p class="piccolo">Proporzionale alla spesa degli ultimi 3 mesi. Se ne alzi una, le altre scendono; 🔒 = bloccata.</p>
      ${cats.map(riga).join('')}
      <div class="budget-testa totale"><button type="button" class="piccolo-b" id="bud-ripristina">↺ ripristina proporzioni</button><strong class="num" id="bud-tot"></strong></div>
    </div>`;

  const mostra = () => {
    let tot = 0;
    $$('[data-budget]', main).forEach(r => {
      const v = Number(r.value);
      tot += v;
      $('[data-val]', r.closest('.budget-riga')).textContent = modo === 'pct' ? pct.format(din.totale ? v / din.totale : 0) + ' · ' + euro0.format(v)
        : euro0.format(v) + ' · ' + pct.format(din.totale ? v / din.totale : 0);
    });
    $('#bud-tot', main).textContent = 'totale ' + euro0.format(tot);
  };
  const applica = b => {
    budget = b;
    $$('[data-budget]', main).forEach(r => { r.value = budget[r.dataset.budget] || 0; });
    cats.forEach(c => { c.budget = budget[c.nome] || null; });
    LS.set('dati', dati);
    mostra();
    clearTimeout(salvaBudgetTimer);
    salvaBudgetTimer = setTimeout(salvaBudget, 1200);
  };
  $$('[data-budget]', main).forEach(r => {
    r.oninput = () => {
      const nome = r.dataset.budget, v = Number(r.value), prima = budget[nome] || 0;
      const altre = cats.map(c => c.nome).filter(x => x !== nome && !bloccate[x]);
      const fissi = cats.map(c => c.nome).filter(x => x !== nome && bloccate[x]).reduce((t, x) => t + (budget[x] || 0), 0);
      const max = Math.max(0, din.totale - fissi);
      const nuovo = Math.min(v, altre.length ? max : prima);
      const b = Object.assign({}, budget, { [nome]: nuovo });
      // Le altre (non bloccate) prendono la differenza in proporzione al loro peso attuale.
      const resto = max - nuovo, pesi = altre.reduce((t, x) => t + (budget[x] || 0), 0);
      altre.forEach(x => { b[x] = pesi > 0 ? Math.round(resto * (budget[x] || 0) / pesi) : Math.round(resto / altre.length); });
      // Arrotondamenti: la differenza va alla categoria libera più grande, così il totale resta quello.
      const scarto = max - nuovo - altre.reduce((t, x) => t + b[x], 0);
      if (scarto && altre.length) { const g = altre.reduce((m, x) => (b[x] > b[m] ? x : m), altre[0]); b[g] = Math.max(0, b[g] + scarto); }
      applica(b);
    };
  });
  $$('[data-blocca]', main).forEach(b => {
    b.onclick = () => { bloccate[b.dataset.blocca] = !bloccate[b.dataset.blocca]; LS.set('budgetBloccate', bloccate); vistaBudget(main); };
  });
  $$('[data-modo]', main).forEach(b => { b.onclick = () => { LS.set('budgetModo', b.dataset.modo); vistaBudget(main); }; });
  $('#bud-ripristina', main).onclick = () => { LS.set('budgetBloccate', {}); applica(proporzioni(din.totale, {}, budget)); vistaBudget(main); };
  $$('[data-risparmio]', main).forEach(b => {
    b.onclick = () => {
      const r = Number(b.dataset.risparmio);
      dati.parametri = Object.assign({}, dati.parametri, { 'Risparmio programmato (%)': r });
      LS.set('dati', dati);
      api('parametri', { valori: { 'Risparmio programmato (%)': r } }).then(() => toast('Risparmio −' + r + '% salvato'))
        .catch(e => toast('Non salvato (serve la rete): ' + (e.message || e)));
      const nuovo = budgetDin(r);
      cats.forEach(c => { c.budget = null; });
      applica(proporzioni(nuovo.totale, bloccate, budget));
      vistaBudget(main);
    };
  });
  mostra();
  if (daSalvare) applica(budget);
}

/** Invia tutti i budget allo script (colonna "Budget mensile (€)" di Categorie). Senza rete riprova alla prossima modifica. */
async function salvaBudget() {
  const b = {};
  catBudget().forEach(c => { b[c.nome] = n(c.budget) || 0; });
  try {
    await api('budget', { budget: b });
    toast('Budget salvato');
    if (tablet) tablet.aggiornaWidget();
  } catch (e) {
    toast('Budget non salvato (serve la rete): ' + (e.message || e));
  }
}

// Bollette dai movimenti (SPEC v6 §E) ────────────────────────────

const COLORI_GRUPPI = ['#f2c14e', '#e8825a', '#ef9b6b', '#4f8fe6', '#9b7fe8', '#5fd3b0', '#6eb8e8', '#d8c060', '#e07a6a'];

/**
 * v9 (SPEC v9 §5.1, mockup 33): gruppi in alto; sotto, SEMPRE il "Dettaglio" con tutti gli addebiti delle bollette del periodo
 * scelto (3/6/12/24 mesi): data, gruppo (pallino), descrizione, importo; tocco su una riga = il movimento. Tocco su un gruppo =
 * il dettaglio si filtra su quel gruppo (secondo tocco o ✕ = tutti). Niente KPI in testa al dettaglio. Gli addebiti sono gli
 * stessi movimenti dello script (ids per gruppo, analisiBollette_), così tablet e web app filtrano le stesse righe.
 */
function vistaBollette(main, query) {
  const casa = dati.casa || {};
  const gruppi = casa.gruppi || [];
  if (!gruppi.length) {
    main.innerHTML = `<div class="testata"><h1>Bollette</h1></div>${schedeFinanze('bollette')}
      <div class="carta piccolo">Le bollette si ricavano dai Movimenti: compaiono quando lo script del foglio è alla versione 6.</div>`;
    return;
  }
  const scelto = (query && query.get('gruppo')) || '';
  const g = gruppi.find(x => x.nome === scelto) || null;
  const ig = g ? gruppi.indexOf(g) : -1;
  const mesiP = Number((query && query.get('mesi')) || LS.get('bolletteMesi', 12)) || 12;
  const varTxt = v => v == null ? '<span class="piccolo">—</span>' : `<span class="${v > 0 ? 'testo-giallo' : 'testo-verde'}">${v > 0 ? '+' : ''}${v}%</span>`;
  const colore = i => COLORI_GRUPPI[i % COLORI_GRUPPI.length];

  // Dettaglio: movimenti dei gruppi (dagli ids dello script), nel periodo, dal più recente.
  const daK = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - mesiP + 1); return chiave(d); })();
  const gruppoDi = {};
  gruppi.forEach((x, i) => (x.ids || []).forEach(id => { gruppoDi[id] = i; }));
  const conIds = gruppi.some(x => x.ids);
  const dett = righe('Movimenti').filter(m => m.Data && m.ID in gruppoDi && String(m.Data) >= daK && (!g || gruppoDi[m.ID] === ig))
    .sort((a, b) => String(b.Data).localeCompare(String(a.Data)));

  main.innerHTML = `
    <div class="testata"><h1>Bollette</h1>
      <select id="bo-mesi" class="sel-periodo">${[3, 6, 12, 24].map(m => `<option value="${m}" ${m === mesiP ? 'selected' : ''}>${m} mesi</option>`).join('')}</select></div>
    ${schedeFinanze('bollette')}
    <div class="carta">
      <div class="etichetta">Gruppi · 12 mesi</div>
      <ul class="elenco gruppi">${gruppi.map((x, i) => `<li class="toccabile ${x === g ? 'selezionato' : ''}" data-gruppo="${esc(x.nome)}">
        <span class="quadratino" style="background:${colore(i)}"></span>
        <div class="corpo">${esc(x.nome)}<div class="sotto">${esc(x.frequenza || '')}${x.quota != null ? ' · ' + x.quota + '%' : ''}</div></div>
        <div class="num">${euro0.format(x.totale)} ${varTxt(x.variazione)}</div></li>`).join('')}</ul>
    </div>
    <div class="carta" style="margin-top:12px">
      <div class="budget-testa"><div class="etichetta" style="margin:0">Dettaglio</div>
        ${g ? `<button class="chip chip-giallo chip-piccolo" id="bo-togli">⚡ ${esc(g.nome)} ✕</button>` : '<span class="piccolo">tutte · tocca un gruppo per filtrare</span>'}</div>
      ${!conIds ? '<p class="piccolo">Il dettaglio compare con lo script del foglio alla versione 9.</p>'
        : dett.length ? `<ul class="elenco dettaglio-bollette">${dett.map(m => `<li class="toccabile" data-mov="${esc(m.ID)}">
          <span class="data-riga">${daChiave(m.Data).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</span>
          <span class="pallino-gruppo" style="background:${colore(gruppoDi[m.ID])}"></span>
          <div class="corpo">${esc(m.Descrizione || '')}</div>
          <div class="num">${euro.format(Math.abs(n(m['Importo (uscite negative)'])))}</div></li>`).join('')}</ul>`
        : `<p class="piccolo">Nessun addebito${g ? ' ' + esc(g.nome) : ''} negli ultimi ${mesiP} mesi.</p>`}
    </div>
    ${g ? `<div class="carta" style="margin-top:12px">
      <div class="etichetta">${esc(g.nome)} · mese per mese</div>
      <p class="piccolo" style="margin:0"><span class="quadratino" style="background:${colore(ig)}"></span> quest'anno
        <span class="quadratino" style="background:#5a6b8c"></span> anno prima</p>
      ${graficoBollette(g.mesi || [], (casa.mesi || []).slice(12).map(m => daChiave(m + '-01').toLocaleDateString('it-IT', { month: 'narrow' })), colore(ig))}
      <div class="budget-testa"><span>Ultima bolletta</span><strong class="num ${g.scarto >= 20 ? 'testo-giallo' : ''}">${g.ultima ? euro0.format(g.ultima.importo) + ' · ' + dataBreve(g.ultima.data) : '—'}${g.scarto != null ? ' · ' + (g.scarto > 0 ? '+' : '') + g.scarto + '% vs media' : ''}</strong></div>
      <div class="budget-testa"><span>Frequenza · prossima</span><strong>${esc(g.frequenza || '—')}${g.prossima ? ' · ~' + dataBreve(g.prossima) : ''}</strong></div>
      ${(() => { const ctr = (casa.controllo || []).filter(c => !c.errore && [g.nome].concat(g.parole || []).some(p => normalizza(p).indexOf(normalizza(c.fornitore)) >= 0));
        return `<div class="budget-testa"><span>Mail ↔ addebito</span><strong>${ctr.length ? ctr.map(c => c.stato === 'addebitata' ? `<span class="testo-verde">✓ ${esc(c.fornitore)} ${dataBreve(c.addebito.data)}</span>`
          : `<span class="testo-giallo">${c.stato === 'ritardo' ? '⚠' : '⏳'} ${esc(c.fornitore)} ${c.stato === 'ritardo' ? 'senza addebito' : 'in attesa'}</span>`).join(' · ') : '<span class="piccolo">nessuna mail collegata</span>'}</strong></div>`; })()}
    </div>` : ''}
    <div id="gb-box"></div>`;
  const vai = (gr, m) => { location.hash = '#/bollette?' + new URLSearchParams(Object.assign(gr ? { gruppo: gr } : {}, { mesi: m || mesiP })).toString(); };
  $$('[data-gruppo]', main).forEach(li => { li.onclick = () => vai(li.dataset.gruppo === scelto ? '' : li.dataset.gruppo); });
  // v10 §8: tocco su un movimento del Dettaglio = scorciatoie "Togli da <gruppo>" / "Metti in un gruppo…" (e "Apri il movimento").
  $$('[data-mov]', main).forEach(li => { li.onclick = () => scorciatoiaBolletta(li, li.dataset.mov, $('#gb-box', main)); });
  disegnaGruppiBollette($('#gb-box', main));
  const tg = $('#bo-togli', main);
  if (tg) tg.onclick = () => vai('');
  $('#bo-mesi', main).onchange = e => { LS.set('bolletteMesi', Number(e.target.value)); vai(scelto, e.target.value); };
}

/** Barre mese per mese: ultimi 12 mesi (colore) accanto agli stessi mesi dell'anno prima (grigio). */
function graficoBollette(mesi, lettere, colore) {
  const W = 360, H = 150, b = 20, max = Math.max(1, ...mesi);
  const w = (W - 4) / 12;
  let s = '';
  for (let i = 0; i < 12; i++) {
    const prima = mesi[i] || 0, ora = mesi[i + 12] || 0, x = 2 + i * w;
    const h1 = (H - b - 6) * prima / max, h2 = (H - b - 6) * ora / max;
    s += `<rect x="${x + w * 0.12}" y="${H - b - h1}" width="${w * 0.36}" height="${h1}" rx="2" fill="#5a6b8c"/>`;
    s += `<rect x="${x + w * 0.5}" y="${H - b - h2}" width="${w * 0.36}" height="${h2}" rx="2" fill="${colore}"/>`;
    s += `<text x="${x + w / 2}" y="${H - 5}" text-anchor="middle" font-size="11" fill="#9aa0a6">${esc(lettere[i] || '')}</text>`;
  }
  return `<svg class="grafico-bollette" viewBox="0 0 ${W} ${H}" role="img" aria-label="Importi mese per mese">${s}</svg>`;
}

// Mutuo (SPEC v6 §F3) ────────────────────────────

const PARAMETRI_MUTUO = [['Mutuo rata (€)', 'Rata (€)', 'number'], ['Mutuo prima rata', 'Prima rata', 'date'], ['Mutuo rate totali', 'Rate totali', 'number'],
  ['Mutuo capitale iniziale (€)', 'Capitale iniziale (€)', 'number'], ['Mutuo tasso annuo (%)', 'Tasso annuo (%)', 'number']];

/** Valore di un parametro per un campo: le date (anche ISO da JSON) diventano yyyy-mm-dd. */
function valoreCampo(v, tipo) {
  if (v == null) return '';
  if (tipo === 'date') {
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return chiave(new Date(s));
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) : s.slice(0, 10);
  }
  return String(v);
}

function vistaMutuo(main) {
  const mu = dati.casa && dati.casa.mutuo;
  const quota = mu && mu.totali ? mu.pagate / mu.totali : null;
  let fine = '';
  const prima = valoreCampo(par('Mutuo prima rata'), 'date');
  if (prima && mu && mu.totali) {
    const d = daChiave(prima);
    fine = new Date(d.getFullYear(), d.getMonth() + mu.totali - 1, 1).toLocaleDateString('it-IT', { month: 'short', year: 'numeric' });
  }
  main.innerHTML = `
    <div class="testata"><h1>Mutuo</h1><span class="piccolo">si salva nel foglio</span></div>
    ${schedeFinanze('mutuo')}
    <div class="carta">
      <div class="etichetta">Situazione</div>
      ${mu ? `<div class="griglia-3">
        <div><div class="piccolo">rata</div><div class="grande num">${euro0.format(mu.rata)}</div></div>
        <div><div class="piccolo">pagate</div><div class="grande num">${mu.pagate}${mu.totali ? '/' + mu.totali : ''}</div></div>
        <div><div class="piccolo">residuo</div><div class="grande num">${mu.residuo != null ? '~' + euro0.format(mu.residuo) : '—'}</div></div></div>
        ${quota != null ? `<div class="barra-mutuo"><span style="width:${Math.round(quota * 100)}%"></span></div>
        <p class="piccolo">${pct.format(quota)} pagato${fine ? ' · fine prevista ' + fine : ''}${mu.prossima ? ' · prossima rata ' + dataBreve(mu.prossima) : ''}</p>` : ''}
        ${mu.residuo == null ? '<p class="piccolo">Residuo stimato non disponibile: servono capitale iniziale e tasso annuo.</p>' : ''}`
        : '<p class="piccolo">Compila rata (o capitale + tasso + rate totali) e prima rata qui sotto.</p>'}
    </div>
    <div class="carta" style="margin-top:12px">
      <div class="etichetta">Parametri (modificabili)</div>
      ${PARAMETRI_MUTUO.map(p => `<label class="campo-riga">${p[1]}<input type="${p[2] === 'date' ? 'date' : 'text'}" ${p[2] === 'number' ? 'inputmode="decimal"' : ''}
        data-par="${esc(p[0])}" value="${esc(valoreCampo(par(p[0]), p[2]))}" placeholder="—"></label>`).join('')}
      <p class="piccolo">Vuoti capitale o tasso = residuo stimato non disponibile. Tasso: es. 2,5 per 2,5%.</p>
    </div>`;
  $$('[data-par]', main).forEach(inp => {
    inp.onchange = async () => {
      const nome = inp.dataset.par, v = inp.value;
      dati.parametri = Object.assign({}, dati.parametri, { [nome]: v });
      LS.set('dati', dati);
      try {
        const r = await api('parametri', { valori: { [nome]: v } });
        if (r.mutuo !== undefined) { dati.casa = Object.assign({}, dati.casa, { mutuo: r.mutuo }); LS.set('dati', dati); }
        toast('Salvato: ' + nome);
        if (tablet) tablet.aggiornaWidget();
        vistaMutuo(main);
      } catch (e) {
        toast('Non salvato (serve la rete): ' + (e.message || e));
      }
    };
  });
}

// Da assegnare (movimenti importati dalla banca senza categoria sicura) ────────────────────────────

function sezioneDaAssegnare() {
  const da = righe('Movimenti').filter(m => (m.Categoria || '').trim() === DA_ASSEGNARE)
    .sort((a, b) => (a.Data < b.Data ? 1 : -1));
  if (!da.length) return '';
  const scelte = (dati.categorie || []).filter(c => c.nome !== DA_ASSEGNARE).map(c => c.nome);
  return `
    <h2 id="da-assegnare">Da assegnare (${da.length})</h2>
    <ul class="elenco carta">${da.map(m => `<li data-mov="${esc(m.ID)}">
      <div class="corpo"><div>${esc(m.Descrizione)}</div><div class="sotto">${dataBreve(m.Data)}</div>
        <div class="ricorda" hidden></div></div>
      <div class="num">${euro.format(n(m['Importo (uscite negative)']))}</div>
      <select data-assegna="${esc(m.ID)}" aria-label="Categoria"><option value="">Scegli…</option>${scelte.map(c => `<option>${esc(c)}</option>`).join('')}</select>
    </li>`).join('')}</ul>`;
}

/** Parola da proporre come parola chiave: la prima parola significativa della descrizione ("Bonifico a Stella…" → "stella"). */
function parolaProposta(descr) {
  const t = String(descr || '').replace(/\(in attesa\)/i, '').replace(/^(Bonifico (a|da)|Bancomat Pay( ricevuto)?|Storno)\s+/i, '');
  const w = t.split(/[\s–\-*]+/).find(x => x.replace(/[^\p{L}]/gu, '').length >= 3);
  return w ? normalizza(w.replace(/[^\p{L}\p{N}.']/gu, '')) : '';
}

function collegaDaAssegnare(main) {
  $$('[data-assegna]', main).forEach(sel => {
    sel.onchange = () => {
      const categoria = sel.value;
      if (!categoria) return;
      const li = sel.closest('li'), m = righe('Movimenti').find(x => x.ID === sel.dataset.assegna);
      salva('Movimenti', { 'Categoria': categoria }, sel.dataset.assegna);
      toast(categoria);
      li.classList.add('fatto');
      sel.disabled = true;
      // Facoltativo: ricordare la parola chiave, così la prossima volta la categoria arriva da sola.
      const parola = parolaProposta(m && m.Descrizione);
      const box = $('.ricorda', li);
      box.hidden = false;
      box.innerHTML = `<input value="${esc(parola)}" aria-label="Parola chiave" style="width:10em">
        <button class="piccolo-b" type="button">Ricorda per ${esc(categoria)}</button>`;
      $('button', box).onclick = async () => {
        const p = $('input', box).value.trim();
        if (p.length < 3) { toast('Parola troppo corta'); return; }
        try {
          const r = await api('parolaChiave', { categoria, parola: p });
          toast('Ricordata' + (r.applicate ? ': assegnati altri ' + r.applicate : ''));
          box.hidden = true;
          sincronizza();
        } catch (e) {
          toast('Serve la rete: ' + (e.message || e));
        }
      };
    };
  });
}

// Casa (mutuo dai Parametri, bollette dalla scheda Bollette) ────────────────────────────


function categorizzaLocale(descr) {
  const d = String(descr || '').toLowerCase();
  const c = (dati.categorie || []).find(c => c.paroleChiave.split(',').map(p => p.trim().toLowerCase()).filter(Boolean).some(p => d.indexOf(p) >= 0));
  return c ? c.nome : '';
}

function collegaElimina(main, scheda, conferma) {
  $$('[data-elimina]', main).forEach(b => {
    b.onclick = () => {
      if (conferma !== false && !confirm('Eliminare questa riga?')) return;
      elimina(scheda, b.dataset.elimina);
      disegna();
    };
  });
}

// Scadenze ────────────────────────────

const RICORRENZE = { 'Nessuna': 0, 'Mensile': 1, 'Bimestrale': 2, 'Trimestrale': 3, 'Semestrale': 6, 'Annuale': 12 };

/** "ven 12 nov 2027" */
function dataAnno(k) { return daChiave(k).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); }

/** Prossima data di una ricorrenza: stesso giorno N mesi dopo (fine mese se il giorno non esiste, es. 31 → 30). */
function prossimaRicorrenza(k, mesi) {
  const d = daChiave(k);
  const ultimo = new Date(d.getFullYear(), d.getMonth() + mesi + 1, 0).getDate();
  return chiave(new Date(d.getFullYear(), d.getMonth() + mesi, Math.min(d.getDate(), ultimo)));
}

/**
 * v9 (SPEC v9 §5.2): Scadenze con le schede Prossime | Storico.
 * - "✓ fatta" apre il selettore "Fatta il" (oggi già scelto, ieri o una data qualsiasi): Stato "Fatta" + colonna "Fatta il",
 *   la scadenza passa da sola nello Storico. Con la Ricorrenza la prossima la crea lo script (v9) dalla data in cui è stata
 *   davvero fatta, o dalla data prevista se "Giorno fisso"; con lo script vecchio la crea la web app come prima.
 * - Data passata nel modulo: "Promemoria scaduto o evento da registrare?" (Tipo "Evento registrato" = Storico, niente Calendar).
 * - "Si chiude da sola": passata la data va nello Storico senza diventare scaduta.
 * - Storico: per data decrescente, filtro per categoria, ricerca nel titolo, per categoria "ultimo: … · in media ogni …";
 *   la data "Fatta il" si cambia toccandola.
 * - Dal tablet: #/scadenze?fatta=<ID> apre subito il selettore per quella scadenza.
 */
function vistaScadenze(main, query) {
  const s = calcScadenze();
  const limite = 30;
  const vista = (query && query.get('vista')) === 'storico' ? 'storico' : 'prossime';
  const filtro = (query && query.get('categoria')) || '';
  const tutte = s.aperte.concat(s.storico);
  const categorie = ['Casa'].concat(tutte.map(x => String(x.Categoria || '').trim()).filter(Boolean))
    .filter((c, i, a) => a.findIndex(y => normalizza(y) === normalizza(c)) === i);
  const link = (v, c) => '#/scadenze?' + new URLSearchParams(Object.assign(v === 'storico' ? { vista: 'storico' } : {}, c ? { categoria: c } : {})).toString();
  const testa = `<div class="testata"><h1>Scadenze</h1></div>
    <nav class="schede-fin"><a href="${link('prossime', filtro)}" class="${vista === 'prossime' ? 'attiva' : ''}">Prossime</a><a href="${link('storico', filtro)}" class="${vista === 'storico' ? 'attiva' : ''}">Storico</a></nav>
    <div class="azioni"><a class="bottone ${filtro ? '' : 'primario'}" href="${link(vista, '')}">Tutte</a>${categorie.map(c => `<a class="bottone ${normalizza(c) === normalizza(filtro) ? 'primario' : ''}" href="${link(vista, c)}">${esc(c)}</a>`).join('')}</div>`;
  if (vista === 'storico') return vistaStoricoScadenze(main, query, s, testa, filtro);

  const scelte = filtro ? s.aperte.filter(x => normalizza(x.Categoria) === normalizza(filtro)) : s.aperte;
  const vicine = scelte.filter(x => x.giorni <= limite);
  const lontane = scelte.filter(x => x.giorni > limite);
  const riga = x => `<li>
    <div class="corpo"><div>${esc(x.Titolo)}</div><div class="sotto">${dataBreve(x.Data)} · ${testoGiorni(x.giorni)}${x.Categoria ? ' · ' + esc(x.Categoria) : ''}${x.Ricorrenza && x.Ricorrenza !== 'Nessuna' ? ' · ' + esc(x.Ricorrenza) : ''}${x['Si chiude da sola'] === true ? ' · si chiude da sola' : ''}${x['ID evento'] ? ' · 📅' : ''}</div></div>
    <button class="piccolo-b" data-fatta="${esc(x.ID)}">✓ fatta</button></li>`;

  main.innerHTML = `${testa}
    <h2>Prossimi ${limite} giorni</h2>
    <ul class="elenco carta">${vicine.length ? vicine.map(riga).join('') : '<li class="vuoto">Niente in scadenza.</li>'}</ul>
    ${lontane.length ? `<h2>Più avanti</h2><ul class="elenco carta">${lontane.map(riga).join('')}</ul>` : ''}
    <div id="pannello-fatta" class="carta pannello-fatta" hidden></div>
    <h2>Nuova scadenza</h2>
    <form class="modulo carta" id="f-scad">
      <label class="campo largo">Cosa<input name="titolo" required></label>
      <label class="campo">Data<input name="data" type="date" value="${oggiK()}" required></label>
      <label class="campo">Categoria<input name="categoria" list="cat-scad" placeholder="es. Casa, Auto" value="${esc(filtro)}"><datalist id="cat-scad">${categorie.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="campo">Ricorrenza<select name="ricorrenza">${Object.keys(RICORRENZE).map(r => `<option>${r}</option>`).join('')}</select></label>
      <label class="campo">Preavviso (giorni)<input name="preavviso" type="number" min="0" max="28" value="${s.entro}"></label>
      <label class="campo-check"><input type="checkbox" name="dasola"> si chiude da sola (appuntamenti, eventi senza azione)</label>
      <label class="campo-check"><input type="checkbox" name="fisso"> giorno fisso: la prossima dalla data prevista, non da quando è fatta</label>
      <input type="hidden" name="tipo" value="">
      <div id="scelta-passato" class="scelta-passato" hidden>
        <p>La data è passata: <strong>promemoria scaduto o evento da registrare?</strong></p>
        <div class="azioni"><button type="button" class="bottone" data-tipo="Scadenza">Promemoria scaduto</button>
          <button type="button" class="bottone primario" data-tipo="Evento registrato">Evento da registrare (storico)</button></div>
      </div>
      <button class="primario" type="submit">Aggiungi</button>
    </form>
    <p class="piccolo">Le scadenze future vanno anche nel Google Calendar (promemoria ai giorni di preavviso e il giorno stesso) quando lo script del foglio è alla versione 9.</p>
    ${bottonePenna('Scadenze')}`;

  const form = $('#f-scad');
  form.onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(form);
    const passata = fd.get('data') < oggiK();
    if (passata && !fd.get('tipo')) { $('#scelta-passato').hidden = false; $('#scelta-passato').scrollIntoView({ block: 'center' }); return; }
    const evento = fd.get('tipo') === 'Evento registrato';
    salva('Scadenze', {
      'Data': fd.get('data'), 'Titolo': fd.get('titolo'), 'Categoria': fd.get('categoria'),
      'Ricorrenza': evento ? 'Nessuna' : fd.get('ricorrenza'), 'Giorni di preavviso': fd.get('preavviso'),
      'Stato': evento ? 'Fatta' : 'Aperta', 'Tipo': evento ? 'Evento registrato' : 'Scadenza', 'Fatta il': evento ? fd.get('data') : '',
      'Si chiude da sola': !!fd.get('dasola'), 'Giorno fisso': !!fd.get('fisso'),
    });
    toast(evento ? 'Evento registrato nello storico' : 'Scadenza aggiunta');
    disegna();
  };
  $$('[data-tipo]', form).forEach(b => { b.onclick = () => { form.tipo.value = b.dataset.tipo; form.requestSubmit ? form.requestSubmit() : form.onsubmit(new Event('submit')); }; });
  form.data.onchange = () => { form.tipo.value = ''; $('#scelta-passato').hidden = true; };

  const apriFatta = id => {
    const x = s.aperte.find(y => y.ID === id);
    if (!x) return;
    const p = $('#pannello-fatta');
    const ieri = spostaGiorni(oggiK(), -1);
    p.hidden = false;
    p.innerHTML = `<div class="etichetta">✓ ${esc(x.Titolo)} · fatta il</div>
      <div class="chips"><button class="chip attivo" data-quando="${oggiK()}">oggi</button><button class="chip" data-quando="${ieri}">ieri</button>
        <input type="date" id="fatta-data" value="${oggiK()}" max="${oggiK()}"></div>
      ${RICORRENZE[x.Ricorrenza] ? `<p class="piccolo" id="fatta-prossima"></p>` : ''}
      <div class="azioni"><button class="bottone" id="fatta-annulla">Annulla</button><button class="bottone primario" id="fatta-ok">Conferma</button></div>`;
    const inp = $('#fatta-data', p);
    const mostraProssima = () => {
      const pr = $('#fatta-prossima', p);
      if (pr) pr.textContent = 'Prossima: ' + dataAnno(prossimaRicorrenza(x['Giorno fisso'] === true ? x.Data : inp.value, RICORRENZE[x.Ricorrenza]))
        + (x['Giorno fisso'] === true ? ' (dalla data prevista)' : ' (da quando è stata fatta)');
    };
    $$('[data-quando]', p).forEach(b => { b.onclick = () => { inp.value = b.dataset.quando; $$('[data-quando]', p).forEach(c => c.classList.toggle('attivo', c === b)); mostraProssima(); }; });
    inp.onchange = () => { $$('[data-quando]', p).forEach(c => c.classList.toggle('attivo', c.dataset.quando === inp.value)); mostraProssima(); };
    mostraProssima();
    $('#fatta-annulla', p).onclick = () => { p.hidden = true; };
    $('#fatta-ok', p).onclick = () => {
      const quando = inp.value || oggiK();
      salva('Scadenze', { 'Stato': 'Fatta', 'Fatta il': quando }, x.ID);
      const mesi = RICORRENZE[x.Ricorrenza] || 0;
      if (mesi && !(dati.versione >= 9)) {
        // Script vecchio: la prossima la crea la web app (con la v9 la crea lo script, insieme all'evento nel calendario).
        salva('Scadenze', {
          'Data': prossimaRicorrenza(x['Giorno fisso'] === true ? x.Data : quando, mesi), 'Titolo': x.Titolo, 'Categoria': x.Categoria || '',
          'Ricorrenza': x.Ricorrenza, 'Giorni di preavviso': x['Giorni di preavviso'] || '', 'Stato': 'Aperta',
        });
      }
      toast(mesi ? 'Fatta. Prossima: ' + dataAnno(prossimaRicorrenza(x['Giorno fisso'] === true ? x.Data : quando, mesi)) : 'Fatta: è nello storico');
      disegna();
    };
    p.scrollIntoView({ block: 'center' });
  };
  $$('[data-fatta]', main).forEach(b => { b.onclick = () => apriFatta(b.dataset.fatta); });
  if (query && query.get('fatta')) setTimeout(() => apriFatta(query.get('fatta')), 0);
  // Dal tasto ＋ della striscia "Prossima scadenza" sul tablet: #/scadenze?nuova=1.
  if (query && query.get('nuova')) setTimeout(() => { const f = $('#f-scad', main); f.scrollIntoView(); const i = $('input', f); if (i) i.focus(); }, 0);
}

/** "3 mesi fa", "12 giorni fa", "oggi". */
function tempoFa(k) {
  const g = giorniTra(k, oggiK());
  if (g <= 0) return 'oggi';
  if (g < 45) return g + (g === 1 ? ' giorno fa' : ' giorni fa');
  const m = Math.round(g / 30.4);
  return m < 18 ? m + (m === 1 ? ' mese fa' : ' mesi fa') : Math.round(g / 365) + ' anni fa';
}

function ogniQuanto(giorni) {
  if (giorni < 45) return 'ogni ' + Math.round(giorni) + ' giorni';
  const m = Math.round(giorni / 30.4);
  return m < 18 ? 'ogni ' + m + (m === 1 ? ' mese' : ' mesi') : 'ogni ' + num1.format(giorni / 365) + ' anni';
}

function vistaStoricoScadenze(main, query, s, testa, filtro) {
  const cerca = (query && query.get('q')) || '';
  const st = s.storico.filter(x => (!filtro || normalizza(x.Categoria) === normalizza(filtro)) && (!cerca || normalizza(x.Titolo).indexOf(normalizza(cerca)) >= 0));
  // Per categoria: ultimo e frequenza media (dalle date distinte, dalla più vecchia).
  const perCat = {};
  st.forEach(x => { const c = String(x.Categoria || '').trim() || 'Senza categoria'; (perCat[c] = perCat[c] || []).push(x.quando); });
  const riass = Object.keys(perCat).map(c => {
    const d = perCat[c].slice().sort();
    const media = d.length >= 2 ? giorniTra(d[0], d[d.length - 1]) / (d.length - 1) : null;
    return `<li><div class="corpo"><div>${esc(c)} <span class="piccolo">· ${d.length}</span></div><div class="sotto">ultimo: ${tempoFa(d[d.length - 1])}${media ? ' · in media ' + ogniQuanto(media) : ''}</div></div></li>`;
  });
  main.innerHTML = `${testa}
    <input type="search" id="st-cerca" class="cerca-storico" placeholder="Cerca nel titolo (es. amministratore)" value="${esc(cerca)}">
    ${riass.length ? `<h2>Ogni quanto succede</h2><ul class="elenco carta">${riass.join('')}</ul>` : ''}
    <h2>Storico</h2>
    <ul class="elenco carta">${st.length ? st.map(x => `<li>
      <div class="corpo"><div>${esc(x.Titolo)}</div><div class="sotto">${x.Categoria ? esc(x.Categoria) + ' · ' : ''}${normalizza(x.Tipo).indexOf('evento') === 0 ? 'evento registrato' : x.daSola ? 'chiusa da sola' : 'prevista ' + dataBreve(x.Data)}</div></div>
      ${normalizza(x.Tipo).indexOf('evento') === 0 || x.daSola ? `<span class="num">${dataBreve(x.quando)}</span>`
        : `<input type="date" class="data-fatta" data-id="${esc(x.ID)}" value="${esc(x.quando)}" max="${oggiK()}" title="Fatta il (tocca per cambiarla)">`}</li>`).join('')
      : '<li class="vuoto">Niente nello storico' + (cerca ? ' per "' + esc(cerca) + '"' : '') + '.</li>'}</ul>
    <p class="piccolo">Ci finiscono le scadenze fatte (✓ fatta), gli eventi registrati e quelle che si chiudono da sole. La data di "fatta il" si cambia toccandola.</p>`;
  const inp = $('#st-cerca', main);
  inp.onchange = () => { location.hash = '#/scadenze?' + new URLSearchParams(Object.assign({ vista: 'storico' }, filtro ? { categoria: filtro } : {}, inp.value ? { q: inp.value } : {})).toString(); };
  $$('.data-fatta', main).forEach(i => { i.onchange = () => { if (i.value) { salva('Scadenze', { 'Fatta il': i.value }, i.dataset.id); toast('Data aggiornata'); } }; });
}

// Spesa ────────────────────────────

function vistaSpesa(main) {
  const voci = righe('Spesa').filter(x => x.Articolo);
  const daPrendere = voci.filter(x => x.Preso !== true), presi = voci.filter(x => x.Preso === true);
  const riga = x => `<li class="${x.Preso === true ? 'fatto' : ''}">
    <input type="checkbox" data-spunta="${esc(x.ID)}" ${x.Preso === true ? 'checked' : ''} aria-label="Preso">
    <div class="corpo"><div>${esc(x.Articolo)}</div>${x['Quantità'] ? `<div class="sotto">${esc(x['Quantità'])}</div>` : ''}</div>
    <button class="piccolo-b" data-elimina="${esc(x.ID)}" title="Togli">✕</button></li>`;

  main.innerHTML = `
    <h1>Spesa</h1>
    <form class="modulo carta" id="f-spesa">
      <label class="campo largo">Articolo<input name="articolo" required autocomplete="off"></label>
      <label class="campo">Quantità<input name="quantita" style="width:110px"></label>
      <button class="primario" type="submit">Aggiungi</button>
    </form>
    <h2>Da comprare (${daPrendere.length})</h2>
    <ul class="elenco carta">${daPrendere.length ? daPrendere.map(riga).join('') : '<li class="vuoto">Lista vuota.</li>'}</ul>
    ${presi.length ? `<h2>Nel carrello (${presi.length})</h2><ul class="elenco carta">${presi.map(riga).join('')}</ul>
      <div class="azioni"><button id="svuota">Togli i presi dalla lista</button></div>` : ''}
    ${bottonePenna('Spesa')}`;

  $('#f-spesa').onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    salva('Spesa', { 'Articolo': fd.get('articolo'), 'Quantità': fd.get('quantita'), 'Preso': false, 'Aggiunto il': oggiK() });
    disegna();
    $('#f-spesa [name=articolo]').focus();
  };
  $$('[data-spunta]', main).forEach(c => {
    c.onchange = () => { salva('Spesa', { 'Preso': c.checked }, c.dataset.spunta); disegna(); };
  });
  collegaElimina(main, 'Spesa', false);
  const sv = $('#svuota');
  if (sv) sv.onclick = () => { presi.forEach(x => elimina('Spesa', x.ID)); disegna(); };
}

// Allenamento ────────────────────────────

// ───────────────────────── Allenamento (SPEC v7 §E, mockup 24) ─────────────────────────
// Oggi: esercizi del giorno, serie da segnare (una riga di Log per serie: Serie = 1, Note "serie N"), timer di recupero.
// Scheda: dati della scheda (Parametri) e settimana tipo; esercizi per giorno nella scheda "Scheda" (Ordine = posizione).
// Progressi: costanza, volume settimanale, carico per esercizio, esercizi fermi.

const SCHEDE_ALL = [['allenamento', 'Oggi'], ['scheda', 'Scheda'], ['progressi', 'Progressi']];
const FINITO_WEB = 'Allenamento completato';

function schedeAll(attiva) {
  return `<nav class="schede-fin">${SCHEDE_ALL.map(s => `<a href="#/${s[0]}" class="${s[0] === attiva ? 'attiva' : ''}">${s[1]}</a>`).join('')}</nav>`;
}

function eserciziDel(giorno) {
  return righe('Scheda').filter(e => normalizza(e.Giorno) === normalizza(giorno) && String(e.Esercizio || '').trim())
    .sort((a, b) => n(a.Ordine) - n(b.Ordine));
}
function logDel(k, esercizio) {
  return righe('Log').filter(l => l.Data === k && (!esercizio || normalizza(l.Esercizio) === normalizza(esercizio)));
}
/** Serie fatte oggi per un esercizio: righe di Log con il loro "Serie" (le righe del tablet valgono tutte le serie). */
function serieFatte(k, esercizio) { return logDel(k, esercizio).reduce((s, l) => s + Math.max(1, n(l.Serie)), 0); }
function oggiGiorno() { return SETTIMANA[(new Date().getDay() + 6) % 7]; }

// Timer di recupero della web app (anche con lo schermo del tablet acceso: la pagina resta aperta).
const timerWeb = { fine: 0, durata: n(LS.get('recuperoWeb', 0)) || 0, pausa: -1, id: null };

function avviaTimer(sec) {
  timerWeb.durata = sec;
  timerWeb.fine = Date.now() + sec * 1000;
  timerWeb.pausa = -1;
  LS.set('recuperoWeb', sec);
  tickTimer();
}
function tickTimer() {
  clearInterval(timerWeb.id);
  timerWeb.id = setInterval(() => {
    const el = $('#timer-cifre');
    if (!el) { if (Date.now() > timerWeb.fine) clearInterval(timerWeb.id); return; }
    const resto = timerWeb.pausa >= 0 ? timerWeb.pausa : Math.max(0, timerWeb.fine - Date.now());
    const s = Math.ceil(resto / 1000);
    el.textContent = Math.floor(s / 60) + ':' + pad(s % 60);
    const b = $('#timer-barra');
    if (b) b.style.width = (timerWeb.durata ? Math.min(100, resto / (timerWeb.durata * 1000) * 100) : 0) + '%';
    if (resto === 0 && timerWeb.pausa < 0 && timerWeb.fine) {
      timerWeb.fine = 0;
      el.textContent = 'VIA!';
      $('#timer-carta') && $('#timer-carta').classList.add('lampeggia');
      try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch (e) { /* niente vibrazione */ }
    }
  }, 200);
}

function vistaAllenamento(main) {
  const k = oggiK(), giorno = oggiGiorno(), es = eserciziDel(giorno);
  const nomeScheda = par('Nome scheda') || '', rec = numPar('Recupero (s)', 90);
  if (!timerWeb.durata) timerWeb.durata = rec;
  const inizio = valoreCampo(par('Inizio scheda'), 'date'), settimane = numPar('Settimane scheda', 0);
  const settN = inizio ? Math.floor(giorniTra(inizio, k) / 7) + 1 : 0;
  const fatti = es.filter(e => serieFatte(k, e.Esercizio) >= Math.max(1, n(e.Serie)));
  const corrente = es.find(e => serieFatte(k, e.Esercizio) < Math.max(1, n(e.Serie)));
  const finito = logDel(k, FINITO_WEB).length > 0;
  const gruppo = es.length ? (es[0].Allenamento || '') : '';
  const ultimoKg = nome => {
    const l = righe('Log').filter(x => normalizza(x.Esercizio) === normalizza(nome) && n(x['Peso (kg)']) > 0).sort((a, b) => (a.Data < b.Data ? 1 : -1))[0];
    return l ? n(l['Peso (kg)']) : 0;
  };

  let serieHtml = '';
  if (corrente) {
    const tot = Math.max(1, n(corrente.Serie)), fatte = logDel(k, corrente.Esercizio);
    const celle = [];
    for (let i = 0; i < tot; i++) {
      const l = fatte[i];
      celle.push(`<button type="button" class="serie ${l ? 'fatta' : i === fatte.length ? 'prossima' : ''}" data-serie="${i}">
        <span class="piccolo">serie ${i + 1}</span><strong>${l ? esc(l.Ripetizioni) + ' × ' + esc(l['Peso (kg)'] || '—') : '— × ' + (ultimoKg(corrente.Esercizio) || n(corrente['Peso previsto (kg)']) || '—')}</strong></button>`);
    }
    serieHtml = `<div class="carta" style="margin-top:12px"><div class="etichetta">${esc(corrente.Esercizio)} · in corso</div>
      <div class="serie-riga">${celle.join('')}</div><p class="piccolo">tocca una serie per segnare ripetizioni e kg fatti</p></div>`;
  }

  main.innerHTML = `
    <div class="testata"><h1>Allenamento</h1><span class="piccolo">${dataBreve(k)}</span></div>
    ${schedeAll('allenamento')}
    <div class="carta"><div class="etichetta">Oggi${gruppo ? ' · ' + esc(gruppo) : es.length ? '' : ' · riposo'}</div>
      ${nomeScheda || settN ? `<p class="piccolo" style="margin:0 0 4px">${nomeScheda ? 'scheda "' + esc(nomeScheda) + '"' : ''}${settN > 0 ? ' · settimana ' + settN + (settimane ? ' di ' + settimane : '') : ''}${es.length ? ' · ' + fatti.length + ' di ' + es.length + ' fatti' : ''}</p>` : ''}
      <ul class="elenco">${es.length ? es.map(e => {
        const s = serieFatte(k, e.Esercizio), tot = Math.max(1, n(e.Serie)), ok = s >= tot;
        return `<li class="${ok ? 'fatto' : ''}"><input type="checkbox" data-spunta="${esc(e.ID)}" ${ok ? 'checked' : ''} aria-label="Fatto">
          <div class="corpo">${esc(e.Esercizio)}${s && !ok ? ' <span class="piccolo">' + s + '/' + tot + '</span>' : ''}</div>
          <div class="num piccolo">${esc(e.Serie)}×${esc(e.Ripetizioni)}${e['Unità'] && e['Unità'] !== 'rip' ? ' ' + esc(e['Unità']) : ''} <strong>${n(e['Peso previsto (kg)']) ? esc(e['Peso previsto (kg)']) + ' kg' : ''}</strong></div></li>`;
      }).join('') : `<li class="vuoto">${righe('Scheda').some(e => String(e.Esercizio || '').trim()) ? 'Oggi riposo.' : 'Nessuna scheda: creala in <a href="#/scheda">Scheda</a>.'}</li>`}</ul></div>
    ${serieHtml}
    <div class="carta timer-carta" id="timer-carta" style="margin-top:12px">
      <div class="etichetta testo-giallo" style="justify-content:center">Recupero</div>
      <div class="timer-cifre num" id="timer-cifre">${Math.floor(timerWeb.durata / 60)}:${pad(timerWeb.durata % 60)}</div>
      <div class="barra-mutuo"><span id="timer-barra" style="width:0;background:var(--giallo)"></span></div>
      <div class="chips" style="justify-content:center">${[60, 90, 120].map(s => `<button type="button" class="chip ${s === timerWeb.durata ? 'attivo' : ''}" data-t="${s}">${s}</button>`).join('')}
        <button type="button" class="chip" data-piu="-15">−15 s</button><button type="button" class="chip" data-piu="15">+15 s</button>
        <button type="button" class="chip" id="t-pausa">❚❚</button></div>
      <p class="piccolo" style="text-align:center">parte da solo quando segni una serie · vibra alla fine</p></div>
    <div class="azioni" style="justify-content:center">
      <button class="primario" type="button" id="all-finito">${finito ? 'Allenamento finito ✓' : 'Allenamento finito'}</button>
      <button type="button" id="all-timer">⏱ solo timer</button></div>`;

  tickTimer();
  $$('[data-t]', main).forEach(b => { b.onclick = () => { avviaTimer(Number(b.dataset.t)); vistaAllenamento(main); }; });
  $$('[data-piu]', main).forEach(b => {
    b.onclick = () => { if (timerWeb.pausa >= 0) timerWeb.pausa = Math.max(0, timerWeb.pausa + Number(b.dataset.piu) * 1000); else timerWeb.fine = Math.max(Date.now() + 1000, timerWeb.fine + Number(b.dataset.piu) * 1000); };
  });
  $('#t-pausa', main).onclick = () => {
    if (timerWeb.pausa >= 0) { timerWeb.fine = Date.now() + timerWeb.pausa; timerWeb.pausa = -1; } else { timerWeb.pausa = Math.max(0, timerWeb.fine - Date.now()); }
  };
  $('#all-timer', main).onclick = () => avviaTimer(timerWeb.durata || rec);
  $('#all-finito', main).onclick = () => {
    if (!finito) salva('Log', { 'Data': k, 'Esercizio': FINITO_WEB, 'Note': 'dalla web app' });
    toast('Allenamento segnato come fatto');
    vistaAllenamento(main);
  };
  $$('[data-spunta]', main).forEach(cb => {
    cb.onchange = () => {
      const e = es.find(x => x.ID === cb.dataset.spunta);
      if (cb.checked) {
        const resto = Math.max(1, n(e.Serie)) - serieFatte(k, e.Esercizio);
        if (resto > 0) salva('Log', { 'Data': k, 'Esercizio': e.Esercizio, 'Serie': resto, 'Ripetizioni': e.Ripetizioni, 'Peso (kg)': e['Peso previsto (kg)'] || '' });
      } else logDel(k, e.Esercizio).forEach(l => elimina('Log', l.ID));
      vistaAllenamento(main);
    };
  });
  $$('[data-serie]', main).forEach(b => {
    b.onclick = () => {
      const i = Number(b.dataset.serie), fatte = logDel(k, corrente.Esercizio);
      const prima = fatte[i];
      const kg0 = prima ? prima['Peso (kg)'] : ultimoKg(corrente.Esercizio) || corrente['Peso previsto (kg)'] || '';
      const v = prompt(corrente.Esercizio + ' · serie ' + (i + 1) + '\nripetizioni × kg (es. 8 × 40)', (prima ? prima.Ripetizioni : corrente.Ripetizioni) + ' × ' + kg0);
      if (v == null) return;
      const m = v.replace(',', '.').match(/(\d+)\s*[x×*]?\s*(\d+(?:\.\d+)?)?/i);
      if (!m) return;
      salva('Log', { 'Data': k, 'Esercizio': corrente.Esercizio, 'Serie': 1, 'Ripetizioni': Number(m[1]), 'Peso (kg)': m[2] ? Number(m[2]) : '', 'Note': 'serie ' + (i + 1) }, prima ? prima.ID : undefined);
      if (!prima) avviaTimer(timerWeb.durata || rec);
      vistaAllenamento(main);
    };
  });
}

// Scheda ────────────────────────────

function vistaScheda(main, query) {
  const giorno = query && query.get('giorno');
  const campo = (nome, et, val, tipo) => `<label class="campo-riga">${et}<input type="${tipo || 'text'}" ${tipo ? '' : 'inputmode="decimal"'} data-par="${esc(nome)}" value="${esc(val)}" placeholder="—"></label>`;
  const testa = `<div class="testata"><h1>Scheda</h1><span class="piccolo">${esc(par('Nome scheda') || '')}</span></div>${schedeAll('scheda')}`;
  if (!giorno) {
    main.innerHTML = `${testa}
      <div class="carta"><div class="etichetta">Scheda attiva</div>
        <label class="campo-riga">Nome<input data-par="Nome scheda" value="${esc(par('Nome scheda') || '')}" placeholder="es. Forza A"></label>
        ${campo('Inizio scheda', 'Dal', valoreCampo(par('Inizio scheda'), 'date'), 'date')}
        ${campo('Settimane scheda', 'Durata (settimane)', par('Settimane scheda') || '')}
        ${campo('Allenamenti a settimana (obiettivo)', 'Obiettivo a settimana', par('Allenamenti a settimana (obiettivo)') || '')}
        ${campo('Recupero (s)', 'Recupero di base (s)', par('Recupero (s)') || 90)}</div>
      <div class="carta" style="margin-top:12px"><div class="etichetta">Settimana tipo</div>
        <ul class="elenco">${SETTIMANA.map(g => {
          const es = eserciziDel(g);
          return `<li class="toccabile" data-vai="#/scheda?giorno=${encodeURIComponent(g)}"><strong style="width:44px">${g.slice(0, 3)}</strong>
            <div class="corpo ${es.length ? 'testo-accento' : 'piccolo'}">${es.length ? esc(es[0].Allenamento || 'allenamento') : 'riposo'}</div>
            <span class="piccolo">${es.length ? es.length + ' esercizi ›' : '＋'}</span></li>`;
        }).join('')}</ul></div>`;
    $$('[data-par]', main).forEach(i => { i.onchange = () => { salvaParametri({ [i.dataset.par]: i.value }, 'Salvato'); }; });
    $$('[data-vai]', main).forEach(li => { li.onclick = () => { location.hash = li.dataset.vai; }; });
    return;
  }

  const es = eserciziDel(giorno);
  const nomeAll = es.length ? es[0].Allenamento || '' : '';
  main.innerHTML = `${testa}
    <a href="#/scheda" class="piccolo">‹ settimana tipo</a>
    <div class="carta" style="margin-top:8px">
      <div class="budget-testa"><span class="etichetta" style="margin:0">${esc(giorno)}</span><span class="piccolo">trascina ≡ per ordinare</span></div>
      <label class="campo-riga">Allenamento<input id="sch-nome" value="${esc(nomeAll)}" placeholder="es. Petto e dorso"></label>
      <ul class="elenco" id="sch-lista">${es.map(e => `<li data-id="${esc(e.ID)}"><span class="maniglia" aria-label="Trascina">≡</span>
        <div class="corpo">${esc(e.Esercizio)}</div>
        <button class="piccolo-b lucchetto" data-togli="${esc(e.ID)}" aria-label="Togli">✕</button>
        <span class="controlli"><input class="corto" data-campo="Serie" value="${esc(e.Serie)}" inputmode="numeric" aria-label="Serie">×
        <input class="corto" data-campo="Ripetizioni" value="${esc(e.Ripetizioni)}" inputmode="numeric" aria-label="Ripetizioni">
        <select class="corto" data-campo="Unità" aria-label="Unità">${['rip', 's', 'min'].map(u => `<option ${String(e['Unità'] || 'rip') === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <input class="corto" data-campo="Peso previsto (kg)" value="${esc(e['Peso previsto (kg)'] || '')}" inputmode="decimal" aria-label="kg" placeholder="kg"> kg</span></li>`).join('') || '<li class="vuoto">Giorno di riposo: aggiungi un esercizio.</li>'}</ul>
      <form id="sch-nuovo" class="riga-aggiungi"><input id="sch-es" placeholder="＋ esercizio (cerca o scrivi)…" list="sch-noti" autocomplete="off">
        <datalist id="sch-noti">${[...new Set(righe('Scheda').map(e => e.Esercizio).filter(Boolean))].map(x => `<option value="${esc(x)}">`).join('')}</datalist>
        <button class="primario" type="submit">Aggiungi</button></form>
    </div>`;

  $('#sch-nome', main).onchange = e => { eserciziDel(giorno).forEach(x => salva('Scheda', { 'Allenamento': e.target.value }, x.ID)); toast('Salvato'); };
  $$('[data-campo]', main).forEach(i => { i.onchange = () => { salva('Scheda', { [i.dataset.campo]: i.value }, i.closest('li').dataset.id); toast('Salvato'); }; });
  $$('[data-togli]', main).forEach(b => { b.onclick = () => { elimina('Scheda', b.dataset.togli); vistaScheda(main, query); }; });
  $('#sch-nuovo', main).onsubmit = e => {
    e.preventDefault();
    const nome = $('#sch-es', main).value.trim();
    if (!nome) return;
    const simile = righe('Scheda').filter(x => normalizza(x.Esercizio) === normalizza(nome)).pop();
    salva('Scheda', { 'Giorno': giorno, 'Ordine': es.length + 1, 'Esercizio': nome, 'Allenamento': $('#sch-nome', main).value,
      'Serie': simile ? simile.Serie : 3, 'Ripetizioni': simile ? simile.Ripetizioni : 10, 'Unità': simile ? simile['Unità'] || 'rip' : 'rip',
      'Peso previsto (kg)': simile ? simile['Peso previsto (kg)'] || '' : '' });
    vistaScheda(main, query);
  };
  // Riordino trascinando la maniglia ≡ (funziona col dito: pointer events), poi Ordine = nuova posizione.
  const lista = $('#sch-lista', main);
  let preso = null;
  $$('.maniglia', main).forEach(h => {
    h.onpointerdown = ev => { preso = h.closest('li'); preso.classList.add('trascinato'); h.setPointerCapture(ev.pointerId); ev.preventDefault(); };
    h.onpointermove = ev => {
      if (!preso) return;
      const sotto = $$('li[data-id]', lista).find(li => li !== preso && ev.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
      if (sotto) lista.insertBefore(preso, sotto); else lista.appendChild(preso);
    };
    h.onpointerup = () => {
      if (!preso) return;
      preso.classList.remove('trascinato');
      preso = null;
      $$('li[data-id]', lista).forEach((li, i) => { const e = es.find(x => x.ID === li.dataset.id); if (e && n(e.Ordine) !== i + 1) salva('Scheda', { 'Ordine': i + 1 }, li.dataset.id); });
      toast('Ordine salvato');
    };
  });
}

// Progressi ────────────────────────────

function vistaProgressi(main, query) {
  const oggi = oggiK(), lun = spostaGiorni(oggi, -((daChiave(oggi).getDay() + 6) % 7));
  const log = righe('Log').filter(l => l.Data && l.Esercizio);
  const obiettivo = numPar('Allenamenti a settimana (obiettivo)', new Set(righe('Scheda').filter(e => e.Esercizio).map(e => normalizza(e.Giorno))).size || 3);
  // v8: contano anche le sessioni dell'orologio (corsa, escursione, palestra…), senza segnarle a mano.
  const sess = sessioniOrologioWeb();
  const giornoFatto = k => log.some(l => l.Data === k) || sess.some(s => s.data === k);
  const cardio = k => log.some(l => l.Data === k && /corsa|bici|cammin|montagn|nuoto|cardio/i.test(l.Esercizio)) || sess.some(s => s.data === k && s.cardio);
  // Costanza: ultime 4 settimane.
  let fatti = 0, pianificate = 0, eseguite = 0;
  const celle = [];
  for (let w = 3; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const k = spostaGiorni(lun, -7 * w + d);
      const g = SETTIMANA[d], es = eserciziDel(g);
      if (k <= oggi && giornoFatto(k)) { fatti++; pianificate += es.reduce((s, e) => s + Math.max(1, n(e.Serie)), 0); eseguite += log.filter(l => l.Data === k && l.Esercizio !== FINITO_WEB).reduce((s, l) => s + Math.max(1, n(l.Serie)), 0); }
      celle.push(`<span class="cal ${k > oggi ? '' : cardio(k) ? 'nel' : giornoFatto(k) ? 'sotto' : ''}" title="${dataBreve(k)}"></span>`);
    }
  }
  let fila = 0;
  for (let w = 0; w < 52; w++) {
    let c = 0;
    for (let d = 0; d < 7; d++) if (giornoFatto(spostaGiorni(lun, -7 * w + d))) c++;
    if (c >= obiettivo || (w === 0 && c > 0)) fila++; else if (w > 0) break;
  }
  // Volume settimanale (t): Serie × Ripetizioni × kg, ultime 8 settimane.
  const vol = [];
  for (let w = 7; w >= 0; w--) {
    const da = spostaGiorni(lun, -7 * w), a = spostaGiorni(da, 6);
    vol.push(log.filter(l => l.Data >= da && l.Data <= a).reduce((s, l) => s + Math.max(1, n(l.Serie)) * n(l.Ripetizioni) * n(l['Peso (kg)']), 0) / 1000);
  }
  const maxV = Math.max(0.1, ...vol);
  // Carico per esercizio.
  const nomi = [...new Set(log.filter(l => n(l['Peso (kg)']) > 0).map(l => l.Esercizio))].sort();
  const scelto = (query && query.get('es')) || nomi[0] || '';
  const perSett = [];
  for (let w = 7; w >= 0; w--) {
    const da = spostaGiorni(lun, -7 * w), a = spostaGiorni(da, 6);
    const kg = log.filter(l => normalizza(l.Esercizio) === normalizza(scelto) && l.Data >= da && l.Data <= a).map(l => n(l['Peso (kg)']));
    perSett.push(kg.length ? Math.max(...kg) : null);
  }
  const rec = log.filter(l => normalizza(l.Esercizio) === normalizza(scelto)).sort((a, b) => n(b['Peso (kg)']) - n(a['Peso (kg)']) || (a.Data < b.Data ? 1 : -1))[0];
  const validi = perSett.filter(x => x != null);
  const delta = validi.length > 1 ? validi[validi.length - 1] - validi[0] : 0;
  // Fermo: esercizio il cui massimo non sale da almeno 3 settimane (con almeno 3 sedute).
  let fermo = null;
  nomi.forEach(nm => {
    const righeEs = log.filter(l => normalizza(l.Esercizio) === normalizza(nm) && n(l['Peso (kg)']) > 0).sort((a, b) => (a.Data < b.Data ? -1 : 1));
    if (righeEs.length < 3) return;
    const max = Math.max(...righeEs.map(l => n(l['Peso (kg)'])));
    const primo = righeEs.find(l => n(l['Peso (kg)']) === max);
    const sett = Math.floor(giorniTra(primo.Data, oggi) / 7);
    if (sett >= 3 && (!fermo || sett > fermo.sett)) fermo = { nome: nm, sett, kg: max };
  });
  const W = 320, H = 110;
  const puntiKg = (() => {
    const v = perSett.map((x, i) => ({ x, i })).filter(p => p.x != null);
    if (!v.length) return '';
    const mn = Math.min(...v.map(p => p.x)), mx = Math.max(...v.map(p => p.x)), r = Math.max(1, mx - mn);
    return v.map(p => `${(p.i * W / 7).toFixed(1)},${(H - 12 - (H - 24) * (p.x - mn) / r).toFixed(1)}`).join(' ');
  })();

  main.innerHTML = `
    <div class="testata"><h1>Progressi</h1><span class="piccolo">8 settimane</span></div>
    ${schedeAll('progressi')}
    <div class="carta"><div class="etichetta">Costanza · ultime 4 settimane</div>
      <div class="griglia-3">
        <div><div class="piccolo">allenamenti</div><div class="grande num">${fatti}<span class="piccolo">/${obiettivo * 4}</span></div></div>
        <div><div class="piccolo">serie fatte</div><div class="grande num">${pianificate ? Math.min(100, Math.round(eseguite / pianificate * 100)) + '%' : '—'}</div></div>
        <div><div class="piccolo">di fila</div><div class="grande num testo-verde">${fila} sett.</div></div></div>
      <div class="calendario sette">${celle.join('')}</div>
      <p class="piccolo"><span class="quadratino" style="background:var(--accento)"></span>palestra <span class="quadratino" style="background:var(--verde)"></span>cardio / montagna</p></div>
    <div class="carta" style="margin-top:12px"><div class="etichetta">Volume settimanale (t)</div>
      <svg class="grafico-bollette" viewBox="0 0 ${W} ${H}" role="img" aria-label="Volume settimanale">${vol.map((v, i) =>
        `<rect x="${i * W / 8 + 8}" y="${H - 18 - (H - 26) * v / maxV}" width="${W / 8 - 16}" height="${(H - 26) * v / maxV}" rx="3" fill="${i === 7 ? '#7fd4ff' : '#4f7fc0'}"/>
         <text x="${i * W / 8 + W / 16}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#9aa0a6">S${i + 1}</text>`).join('')}</svg></div>
    <div class="carta" style="margin-top:12px">
      <div class="budget-testa"><label class="etichetta" style="margin:0">Carico · <select id="pr-es" class="cat-riga">${nomi.map(x => `<option ${x === scelto ? 'selected' : ''}>${esc(x)}</option>`).join('') || '<option>—</option>'}</select></label>
        <span class="${delta > 0 ? 'testo-verde' : 'piccolo'}">${delta ? (delta > 0 ? '+' : '') + num1.format(delta) + ' kg in 8 sett.' : ''}</span></div>
      <svg class="grafico-bollette" viewBox="0 0 ${W} ${H}" role="img" aria-label="Carico per settimana">${puntiKg ? `<polyline points="${puntiKg}" fill="none" stroke="var(--verde)" stroke-width="2.5"/>` : '<text x="10" y="60" font-size="12" fill="#9aa0a6">nessun carico segnato</text>'}</svg>
      <div class="budget-testa"><span>Record</span><strong>${rec ? esc(rec['Peso (kg)']) + ' kg × ' + esc(rec.Ripetizioni) + ' · ' + dataBreve(rec.Data) : '—'}</strong></div>
      <div class="budget-testa"><span>Fermo da ${fermo ? fermo.sett + ' settimane' : '—'}</span><strong class="testo-giallo">${fermo ? esc(fermo.nome) + ' ' + num1.format(fermo.kg) + ' kg' : ''}</strong></div></div>
    ${rigaBatteria()}`;
  $('#pr-es', main).onchange = e => { location.hash = '#/progressi?es=' + encodeURIComponent(e.target.value); };
}

/**
 * v9 (SPEC v9 §5.4): batteria dell'orologio letta dalla mini app a ogni apertura → consumo medio al giorno (solo i cali tra
 * due letture, le ricariche non contano). Normale per il T-Rex 3 Pro: ~3–5 %/giorno (3–4 settimane di autonomia).
 */
function rigaBatteria() {
  const b = dati.batteria;
  if (!b) return `<p class="piccolo" style="margin-top:12px">⌚ Batteria orologio: arriva aprendo Allenamento sull'orologio (script v9, mini app 1.1).</p>`;
  const q = new Date(b.quando);
  return `<div class="carta" style="margin-top:12px"><div class="budget-testa"><span>⌚ Batteria orologio</span>
    <strong class="num ${b.consumoGiorno > 6 ? 'testo-giallo' : ''}">${b.consumoGiorno != null ? num1.format(b.consumoGiorno) + ' %/giorno' : '—'}</strong></div>
    <p class="piccolo" style="margin:0">ultima ${b.ultima}% · ${q.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} ${pad(q.getHours())}:${pad(q.getMinutes())} · ${b.letture} letture${b.consumoGiorno == null ? ' · servono almeno 12 ore di letture' : ' · normale ~3–5 %/giorno'}</p></div>`;
}

// ───────────────────────── Cibo (SPEC v7 §D, mockup 23) ─────────────────────────
// Unità del piano = la SETTIMANA: ogni giorno ha un tipo A (allenamento), R (riposo), L (libero) con le sue kcal.
// Stesse regole dello script (pianoCibo_): tipi dal parametro "Settimana tipo cibo" o, se vuoto, A nei giorni con esercizi.

const SCHEDE_CIBO = [['cibo', 'Diario'], ['piano', 'Piano'], ['controlli', 'Controlli'], ['peso', 'Peso']];
const ORDINE_PASTI = ['Colazione', 'Pranzo', 'Spuntino', 'Cena'];
const SETTIMANA = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];

function schedeCibo(attiva) {
  return `<nav class="schede-fin">${SCHEDE_CIBO.map(s => `<a href="#/${s[0]}" class="${s[0] === attiva ? 'attiva' : ''}">${s[1]}</a>`).join('')}</nav>`;
}

function piano() {
  const num = (nome, def) => { const v = n(par(nome)); return v > 0 ? v : def; };
  const base = num('Obiettivo kcal', 2200);
  const kcal = { A: num('Kcal giorno allenamento', base), R: num('Kcal giorno riposo', base), L: num('Kcal giorno libero', base) };
  let tipi = String(par('Settimana tipo cibo') || '').toUpperCase().replace(/[^ARL]/g, '');
  if (tipi.length !== 7) {
    const g = {};
    righe('Scheda').forEach(e => { if (String(e.Esercizio || '').trim()) g[normalizza(e.Giorno)] = true; });
    tipi = SETTIMANA.map(x => (g[normalizza(x)] ? 'A' : 'R')).join('');
  }
  const p = calcPeso();
  return {
    obiettivo: String(par('Cibo obiettivo') || 'mantenere'), kcal, tipi,
    settimana: tipi.split('').reduce((s, t) => s + kcal[t], 0),
    gkg: num('Proteine (g/kg)', 1.8), grassiPct: num('Grassi (% kcal)', 27), peso: p.ultimo ? p.ultimo.kg : null,
  };
}

function tipoDel(pi, k) { return pi.tipi.charAt((daChiave(k).getDay() + 6) % 7); }
function obiettivoDel(pi, k) { return pi.kcal[tipoDel(pi, k)]; }
function macroDel(pi, kcal) {
  const p = pi.peso ? Math.round(pi.gkg * pi.peso) : numPar('Obiettivo proteine (g)', 140);
  const g = Math.round(kcal * pi.grassiPct / 100 / 9);
  return { p, g, c: Math.max(0, Math.round((kcal - p * 4 - g * 9) / 4)) };
}
const NOMI_TIPO = { A: 'allenamento', R: 'riposo', L: 'libero' };

function pastiDel(k) {
  return righe('Pasti').filter(p => p.Data === k).sort((a, b) => String(a.Ora || '').localeCompare(String(b.Ora || '')));
}
function totaliPasti(lista) {
  return lista.reduce((t, p) => ({ kcal: t.kcal + n(p.Kcal), p: t.p + n(p['Proteine (g)']), c: t.c + n(p['Carboidrati (g)']), g: t.g + n(p['Grassi (g)']) }),
    { kcal: 0, p: 0, c: 0, g: 0 });
}

/** Salva parametri nel foglio (azione parametri) e subito nella copia locale. */
async function salvaParametri(valori, messaggio) {
  dati.parametri = Object.assign({}, dati.parametri, valori);
  LS.set('dati', dati);
  try {
    const r = await api('parametri', { valori });
    if (r.mutuo !== undefined && dati.casa) dati.casa.mutuo = r.mutuo;
    LS.set('dati', dati);
    toast(messaggio || 'Salvato');
    if (tablet) tablet.aggiornaWidget();
  } catch (e) {
    toast('Non salvato nel foglio (serve la rete): ' + (e.message || e));
  }
}

function anelloSvg(valore, obiettivo, testo, sotto) {
  const f = obiettivo > 0 ? Math.min(1, valore / obiettivo) : 0, r = 42, cir = 2 * Math.PI * r;
  return `<svg class="anello" viewBox="0 0 100 100" role="img" aria-label="${esc(testo)} ${esc(sotto)}">
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(90,200,255,.15)" stroke-width="9"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="${valore > obiettivo * 1.1 ? 'var(--giallo)' : 'var(--accento)'}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${cir * f} ${cir}" transform="rotate(-90 50 50)"/>
    <text x="50" y="50" text-anchor="middle" font-size="17" font-weight="700" fill="var(--testo)">${esc(testo)}</text>
    <text x="50" y="65" text-anchor="middle" font-size="8.5" fill="var(--testo-2)">${esc(sotto)}</text></svg>`;
}

function barraMacro(nome, g, obiettivo, colore) {
  return `<div class="macro-riga"><div class="budget-testa"><span>${nome}</span><span class="num"><strong>${Math.round(g)}</strong>/${obiettivo} g</span></div>
    <div class="barra-mutuo sottile"><span style="width:${Math.min(100, obiettivo ? g / obiettivo * 100 : 0)}%;background:${colore}"></span></div></div>`;
}

// Diario ────────────────────────────

function pastoPerOra(h) { return h < 11 ? 'Colazione' : h < 15 ? 'Pranzo' : h < 18 ? 'Spuntino' : 'Cena'; }

function vistaCibo(main, query) {
  const k = (query && query.get('giorno')) || oggiK();
  const pi = piano(), tipo = tipoDel(pi, k), ob = pi.kcal[tipo], mg = macroDel(pi, ob);
  const lista = pastiDel(k), tot = totaliPasti(lista);
  const alimenti = righe('Alimenti').filter(a => String(a.Nome || '').trim()).sort((a, b) => n(b.Usi) - n(a.Usi));
  let pastoScelto = pastoPerOra(new Date().getHours());
  const gruppi = ORDINE_PASTI.concat(lista.map(p => p.Pasto).filter(x => x && ORDINE_PASTI.indexOf(x) < 0))
    .filter((x, i, a) => a.indexOf(x) === i);

  main.innerHTML = `
    <div class="testata"><h1>Cibo</h1><span class="piccolo">${k === oggiK() ? 'oggi' : dataBreve(k)}</span></div>
    ${schedeCibo('cibo')}
    <div class="carta riga-anello">
      ${anelloSvg(tot.kcal, ob, String(Math.round(tot.kcal)), 'di ' + ob + ' kcal')}
      <div class="corpo-anello">
        <div class="etichetta">${k === oggiK() ? 'Oggi' : dataBreve(k)} · ${NOMI_TIPO[tipo]}</div>
        <div class="piccolo">${tot.kcal <= ob ? 'restano <strong>' + Math.round(ob - tot.kcal) + ' kcal</strong>' : '<span class="testo-giallo">oltre di ' + Math.round(tot.kcal - ob) + ' kcal</span>'} · obiettivo del giorno dal Piano</div>
        ${barraMacro('Prot', tot.p, mg.p, '#5fd3b0')}${barraMacro('Carb', tot.c, mg.c, '#6ea8ff')}${barraMacro('Grassi', tot.g, mg.g, '#ffcf5a')}
      </div>
    </div>
    <div class="carta" style="margin-top:12px">
      <div class="etichetta">Aggiungi</div>
      <form id="f-cibo" class="riga-aggiungi"><input id="cibo-testo" placeholder='cosa hai mangiato… (es. "pasta 100 g")' autocomplete="off" list="lista-alimenti">
        <datalist id="lista-alimenti">${alimenti.map(a => `<option value="${esc(a.Nome)}">`).join('')}</datalist>
        <button class="primario" type="submit" aria-label="Aggiungi">＋</button></form>
      <div class="chips"><button type="button" class="chip attivo" id="cibo-pasto">${pastoScelto}</button><span class="piccolo" style="align-self:center">rapidi:</span>
        ${alimenti.slice(0, 6).map(a => `<button type="button" class="chip" data-rapido="${esc(a.ID)}">${esc(a.Nome)} ${Math.round(n(a.Kcal))}</button>`).join('') || '<span class="piccolo" style="align-self:center">nessun alimento salvato</span>'}</div>
      <div id="cibo-nuovo" class="nascosto">
        <p class="piccolo">Alimento nuovo: scrivi una volta kcal e macro, poi resta tra i salvati.</p>
        <div class="griglia-4"><label class="campo">kcal<input id="n-kcal" inputmode="decimal"></label><label class="campo">prot g<input id="n-p" inputmode="decimal"></label>
          <label class="campo">carb g<input id="n-c" inputmode="decimal"></label><label class="campo">grassi g<input id="n-g" inputmode="decimal"></label></div>
        <label class="campo-riga"><span><input type="checkbox" id="n-salva" checked> salva tra gli alimenti</span><button type="button" class="primario piccolo-b" id="n-ok">Aggiungi</button></label>
      </div>
      <p class="piccolo">kcal e macro dagli alimenti salvati; se è nuovo li scrivi una volta e restano.</p>
    </div>
    <div class="carta" style="margin-top:12px">
      <div class="budget-testa"><span class="etichetta" style="margin:0">${k === oggiK() ? 'Oggi' : 'Il'} a tavola</span>
        <span><a class="bottone piccolo-b" href="#/cibo?giorno=${spostaGiorni(k, -1)}" aria-label="Giorno prima">◀</a> ${dataBreve(k)}
        ${k < oggiK() ? `<a class="bottone piccolo-b" href="#/cibo?giorno=${spostaGiorni(k, 1)}" aria-label="Giorno dopo">▶</a>` : ''}</span></div>
      ${gruppi.map(g => {
        const p = lista.filter(x => (x.Pasto || 'Spuntino') === g);
        return `<div class="pasto-gruppo"><div class="budget-testa"><strong>${esc(g)}${p.length && p[0].Ora ? ' <span class="piccolo">' + esc(String(p[0].Ora).slice(0, 5)) + '</span>' : ''}</strong>
          <span class="num">${p.length ? Math.round(totaliPasti(p).kcal) + ' kcal' : '<a href="#" data-aggiungi="' + esc(g) + '">＋ aggiungi</a>'}</span></div>
          ${p.map(x => `<div class="budget-testa pasto-riga"><span>${esc(x['Cosa ho mangiato'] || '')}</span><span class="num">${Math.round(n(x.Kcal))}
            <button class="piccolo-b lucchetto" data-elimina-pasto="${esc(x.ID)}" aria-label="Elimina">✕</button></span></div>`).join('')}</div>`;
      }).join('')}
    </div>
    ${bottonePenna('Pasti')}`;

  const aggiungi = (nome, valori, alimento) => {
    const ora = k === oggiK() ? oraAdesso() : '12:00';
    salva('Pasti', Object.assign({ 'Data': k, 'Ora': ora, 'Pasto': pastoScelto, 'Cosa ho mangiato': nome }, valori));
    if (alimento) salva('Alimenti', { 'Usi': n(alimento.Usi) + 1 }, alimento.ID);
    toast(nome + ' · ' + Math.round(n(valori.Kcal)) + ' kcal');
    vistaCibo(main, query);
  };
  const valoriDi = (a, fattore) => ({ 'Kcal': Math.round(n(a.Kcal) * fattore), 'Proteine (g)': Math.round(n(a['Proteine (g)']) * fattore),
    'Carboidrati (g)': Math.round(n(a['Carboidrati (g)']) * fattore), 'Grassi (g)': Math.round(n(a['Grassi (g)']) * fattore) });
  $('#cibo-pasto', main).onclick = e => { pastoScelto = ORDINE_PASTI[(ORDINE_PASTI.indexOf(pastoScelto) + 1) % 4]; e.target.textContent = pastoScelto; };
  $$('[data-rapido]', main).forEach(b => {
    b.onclick = () => { const a = alimenti.find(x => x.ID === b.dataset.rapido); aggiungi(a.Nome + (a.Porzione ? ' ' + a.Porzione : ''), valoriDi(a, 1), a); };
  });
  $$('[data-aggiungi]', main).forEach(a => {
    a.onclick = e => { e.preventDefault(); pastoScelto = a.dataset.aggiungi; $('#cibo-pasto', main).textContent = pastoScelto; $('#cibo-testo', main).focus(); };
  });
  $('#f-cibo', main).onsubmit = e => {
    e.preventDefault();
    const t = $('#cibo-testo', main).value.trim();
    if (!t) return;
    // "pasta 100 g": se l'alimento salvato ha porzione "100 g" e qui c'è un'altra quantità, kcal in proporzione.
    const m = t.match(/^(.*?)\s*(\d+(?:[.,]\d+)?)\s*(g|ml)?$/i);
    const nome = (m ? m[1] : t).trim();
    const a = alimenti.find(x => normalizza(x.Nome) === normalizza(nome)) || alimenti.find(x => normalizza(x.Nome) === normalizza(t));
    if (a) {
      const q = m && m[2] ? n(m[2]) : 0, porz = n(String(a.Porzione || '').replace(/[^\d.,]/g, ''));
      aggiungi(t, valoriDi(a, q && porz ? q / porz : 1), a);
      return;
    }
    $('#cibo-nuovo', main).classList.remove('nascosto');
    $('#n-kcal', main).focus();
  };
  $('#n-ok', main).onclick = () => {
    const t = $('#cibo-testo', main).value.trim();
    const v = { 'Kcal': n($('#n-kcal', main).value), 'Proteine (g)': n($('#n-p', main).value), 'Carboidrati (g)': n($('#n-c', main).value), 'Grassi (g)': n($('#n-g', main).value) };
    let al = null;
    if ($('#n-salva', main).checked) {
      const m = t.match(/^(.*?)\s*(\d+(?:[.,]\d+)?\s*(?:g|ml))$/i);
      const id = nuovoId();
      salva('Alimenti', Object.assign({ 'Nome': m ? m[1].trim() : t, 'Porzione': m ? m[2].replace(/\s+/g, ' ') : '', 'Usi': 0 }, v), id);
      al = { ID: id, Usi: 0 };
    }
    aggiungi(t, v, al);
  };
  $$('[data-elimina-pasto]', main).forEach(b => { b.onclick = () => { elimina('Pasti', b.dataset.eliminaPasto); vistaCibo(main, query); }; });
}

// Piano ────────────────────────────

function vistaPiano(main) {
  const pi = piano(), p = calcPeso();
  const obPeso = n(par('Obiettivo peso')), entro = valoreCampo(par('Peso obiettivo entro'), 'date');
  let ritmo = '';
  if (p.ultimo && obPeso && entro) {
    const sett = giorniTra(oggiK(), entro) / 7;
    if (sett > 0) {
      const v = (obPeso - p.ultimo.kg) / sett;
      ritmo = `≈ ${v > 0 ? '+' : ''}${num1.format(v)} kg/settimana · ${Math.abs(v) <= 0.75 ? '<span class="testo-verde">sostenibile</span>' : '<span class="testo-giallo">troppo veloce</span>'}`;
    }
  }
  const o = new Date(), mese = chiave(o).slice(0, 7), giorniMese = new Date(o.getFullYear(), o.getMonth() + 1, 0).getDate();
  let kMese = 0;
  for (let d = 1; d <= giorniMese; d++) kMese += obiettivoDel(pi, mese + '-' + pad(d));
  const media = pi.settimana / 7, mg = macroDel(pi, media);
  const pctP = Math.round(mg.p * 4 / media * 100), pctG = Math.round(pi.grassiPct), pctC = Math.max(0, 100 - pctP - pctG);
  const campo = (nome, et, val, tipo) => `<label class="campo-riga">${et}<input type="${tipo || 'text'}" ${tipo ? '' : 'inputmode="decimal"'} data-par="${esc(nome)}" value="${esc(val)}" placeholder="—"></label>`;

  main.innerHTML = `
    <div class="testata"><h1>Piano</h1><span class="piccolo">si salva nel foglio</span></div>
    ${schedeCibo('piano')}
    <div class="carta">
      <div class="etichetta">Obiettivo</div>
      <div class="chips">${['dimagrire', 'mantenere', 'massa'].map(x => `<button type="button" class="chip ${pi.obiettivo === x ? 'attivo' : ''}" data-obiettivo="${x}">${x}</button>`).join('')}</div>
      ${campo('Obiettivo peso', 'Peso oggi ' + (p.ultimo ? num1.format(p.ultimo.kg) : '—') + ' → obiettivo (kg)', par('Obiettivo peso') || '')}
      ${campo('Peso obiettivo entro', 'Entro', entro, 'date')}
      <p class="piccolo">${ritmo || 'scrivi obiettivo e data per vedere il ritmo'}</p>
    </div>
    <div class="carta" style="margin-top:12px">
      <div class="budget-testa"><span class="etichetta" style="margin:0">Kcal della settimana</span><strong class="num grande">${Math.round(pi.settimana).toLocaleString('it-IT')} kcal</strong></div>
      <p class="piccolo">somma dei 7 giorni secondo il tipo · mese: ${Math.round(kMese).toLocaleString('it-IT')} kcal</p>
      ${campo('Kcal giorno allenamento', '<span class="testo-accento">A</span> giorno di allenamento', pi.kcal.A)}
      ${campo('Kcal giorno riposo', 'R riposo', pi.kcal.R)}
      ${campo('Kcal giorno libero', '<span class="testo-giallo">L</span> pasto libero', pi.kcal.L)}
      <div class="settimana-tipo">${SETTIMANA.map((g, i) => `<div><span class="piccolo">${g.charAt(0)}</span>
        <button type="button" class="giorno-tipo tipo-${pi.tipi.charAt(i)}" data-giorno="${i}">${pi.tipi.charAt(i)}</button></div>`).join('')}</div>
      <p class="piccolo">settimana tipo: tocca un giorno per cambiare A → R → L${String(par('Settimana tipo cibo') || '').length === 7 ? '' : ' · ora i giorni A seguono la scheda di allenamento'}</p>
    </div>
    <div class="carta" style="margin-top:12px">
      <div class="etichetta">Macro (% kcal, giorno medio)</div>
      <div class="barra-macro"><span style="width:${pctP}%;background:#5fd3b0"></span><span style="width:${pctC}%;background:#6ea8ff"></span><span style="width:${pctG}%;background:#ffcf5a"></span></div>
      <p class="piccolo">■ prot ${mg.p} g · ■ carb ${mg.c} g · ■ grassi ${mg.g} g</p>
      ${campo('Proteine (g/kg)', 'Proteine (g per kg)', pi.gkg)}
      ${campo('Grassi (% kcal)', 'Grassi (% delle kcal)', pi.grassiPct)}
      <p class="piccolo">proteine = g/kg × peso · i carboidrati sono il resto</p>
    </div>
    ${cartaBilancio(true)}`;
  collegaBilancio(main, () => vistaPiano(main));

  $$('[data-obiettivo]', main).forEach(b => { b.onclick = () => { salvaParametri({ 'Cibo obiettivo': b.dataset.obiettivo }, 'Obiettivo: ' + b.dataset.obiettivo); vistaPiano(main); }; });
  $$('[data-par]', main).forEach(i => { i.onchange = () => { salvaParametri({ [i.dataset.par]: i.value }, 'Salvato'); vistaPiano(main); }; });
  $$('[data-giorno]', main).forEach(b => {
    b.onclick = () => {
      const t = pi.tipi.split(''), i = Number(b.dataset.giorno);
      t[i] = { A: 'R', R: 'L', L: 'A' }[t[i]];
      salvaParametri({ 'Settimana tipo cibo': t.join('') }, 'Settimana tipo salvata');
      vistaPiano(main);
    };
  });
}

// Controlli ────────────────────────────

function vistaControlli(main, query) {
  const pi = piano(), oggi = oggiK();
  const mese = (query && query.get('mese')) || oggi.slice(0, 7);
  const d0 = daChiave(mese + '-01'), giorniMese = new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate();
  const giorni = [];
  for (let d = 1; d <= giorniMese; d++) {
    const k = mese + '-' + pad(d), t = totaliPasti(pastiDel(k)), ob = obiettivoDel(pi, k);
    giorni.push({ k, d, kcal: t.kcal, p: t.p, ob, futuro: k > oggi, vuoto: t.kcal === 0 });
  }
  const passati = giorni.filter(g => !g.futuro && !g.vuoto);
  const kcalMese = passati.reduce((s, g) => s + g.kcal, 0), previste = passati.reduce((s, g) => s + g.ob, 0);
  const nelRange = passati.filter(g => Math.abs(g.kcal - g.ob) <= g.ob * 0.1).length;
  const protMedia = passati.length ? passati.reduce((s, g) => s + g.p, 0) / passati.length : 0, protOb = macroDel(pi, pi.settimana / 7).p;
  // Settimana (unità del piano)
  const lun = spostaGiorni(oggi, -((daChiave(oggi).getDay() + 6) % 7));
  let kSett = 0, obSettFinora = 0;
  for (let i = 0; i < 7; i++) { const k = spostaGiorni(lun, i); if (k <= oggi) { kSett += totaliPasti(pastiDel(k)).kcal; obSettFinora += obiettivoDel(pi, k); } }
  // Ultimi 30 giorni
  const ult = [];
  for (let i = 29; i >= 0; i--) { const k = spostaGiorni(oggi, -i); ult.push({ k, kcal: totaliPasti(pastiDel(k)).kcal, ob: obiettivoDel(pi, k) }); }
  const pesi = calcPeso().misure.filter(m => m.data >= spostaGiorni(oggi, -30));
  const perPasto = {};
  righe('Pasti').filter(p => p.Data >= spostaGiorni(oggi, -30)).forEach(p => { perPasto[p.Pasto || 'altro'] = (perPasto[p.Pasto || 'altro'] || 0) + n(p.Kcal); });
  const totP = Object.values(perPasto).reduce((a, b) => a + b, 0);
  const pesante = Object.keys(perPasto).sort((a, b) => perPasto[b] - perPasto[a])[0];
  // Da migliorare: regole semplici, la prima che vale.
  const sotto = passati.filter(g => g.p < protOb * 0.9).length;
  const sopra = passati.filter(g => g.kcal > g.ob * 1.1).length;
  let consiglio = 'Tutto nel piano: continua così.';
  if (!passati.length) consiglio = 'Segna i pasti nel Diario: i controlli partono dai giorni con almeno un pasto.';
  else if (sotto >= passati.length / 2) consiglio = `Proteine sotto obiettivo ${sotto} giorni su ${passati.length}: a colazione +20 g (es. yogurt greco 250 g).`;
  else if (sopra > nelRange) consiglio = `${sopra} giorni sopra il piano: guarda ${pesante ? 'la ' + pesante.toLowerCase() : 'il pasto più pesante'} (${totP ? Math.round(perPasto[pesante] / totP * 100) : 0}% delle kcal).`;
  else if (totP && perPasto[pesante] / totP > 0.4) consiglio = `${pesante}: ${Math.round(perPasto[pesante] / totP * 100)}% delle kcal. Spostane un po' a pranzo o allo spuntino.`;

  const colore = g => (g.futuro || g.vuoto ? '' : Math.abs(g.kcal - g.ob) <= g.ob * 0.1 ? 'nel' : g.kcal > g.ob ? 'sopra' : 'sotto');
  const vuoti = (d0.getDay() + 6) % 7;
  const W = 340, H = 110, max = Math.max(1, ...ult.map(x => Math.max(x.kcal, x.ob)));
  const linea = campo => ult.map((x, i) => `${(i * (W / 29)).toFixed(1)},${(H - 8 - (H - 16) * x[campo] / max).toFixed(1)}`).join(' ');

  main.innerHTML = `
    <div class="testata"><h1>Controlli</h1>${selettoreMese('controlli', mese)}</div>
    ${schedeCibo('controlli')}
    <div class="carta"><div class="etichetta">Questa settimana</div>
      <div class="budget-testa"><span>${Math.round(kSett).toLocaleString('it-IT')} kcal su ${Math.round(obSettFinora).toLocaleString('it-IT')} previste finora</span>
      <strong class="${Math.abs(kSett - obSettFinora) <= obSettFinora * 0.1 ? 'testo-verde' : 'testo-giallo'}">${kSett > obSettFinora * 1.1 ? 'sopra' : kSett < obSettFinora * 0.9 ? 'sotto' : 'in linea'}</strong></div>
      <p class="piccolo">obiettivo della settimana ${Math.round(pi.settimana).toLocaleString('it-IT')} kcal · restano ${Math.max(0, Math.round(pi.settimana - kSett)).toLocaleString('it-IT')}</p></div>
    ${cartaBilancio()}
    <div class="carta" style="margin-top:12px"><div class="etichetta">${nomeMese(mese)} finora</div>
      <div class="griglia-3">
        <div><div class="piccolo">kcal mangiate</div><div class="grande num">${Math.round(kcalMese).toLocaleString('it-IT')}</div><div class="piccolo">di ${Math.round(previste).toLocaleString('it-IT')} previste</div></div>
        <div><div class="piccolo">giorni nel range</div><div class="grande num testo-verde">${nelRange}/${passati.length}</div><div class="piccolo">±10% dal piano</div></div>
        <div><div class="piccolo">proteine medie</div><div class="grande num">${Math.round(protMedia)} g</div><div class="piccolo">obiettivo ${protOb}</div></div></div>
      <div class="calendario">${'<span></span>'.repeat(vuoti)}${giorni.map(g => `<a href="#/cibo?giorno=${g.k}" class="cal ${colore(g)} ${g.k === oggi ? 'oggi' : ''}">${g.d}</a>`).join('')}</div>
      <p class="piccolo"><span class="quadratino" style="background:var(--verde)"></span>nel piano <span class="quadratino" style="background:var(--giallo)"></span>sopra
        <span class="quadratino" style="background:var(--accento)"></span>sotto · tocca un giorno = i suoi pasti</p></div>
    <div class="carta" style="margin-top:12px"><div class="etichetta">Ultimi 30 giorni</div>
      <p class="piccolo" style="margin:0">━ kcal ╍ piano</p>
      <svg class="grafico-bollette" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="kcal degli ultimi 30 giorni">
        <polyline points="${linea('ob')}" fill="none" stroke="var(--giallo)" stroke-width="1.5" stroke-dasharray="4 3"/>
        <polyline points="${linea('kcal')}" fill="none" stroke="var(--accento)" stroke-width="2"/></svg>
      <div class="budget-testa"><span>Peso</span><strong class="num">${pesi.length > 1 ? num1.format(pesi[0].kg) + ' → ' + num1.format(pesi[pesi.length - 1].kg) + ' kg' : '—'}</strong></div>
      <div class="budget-testa"><span>Pasto più "pesante"</span><strong>${pesante && totP ? esc(pesante.toLowerCase()) + ' · ' + Math.round(perPasto[pesante] / totP * 100) + '% delle kcal' : '—'}</strong></div></div>
    <div class="carta evidenza" style="margin-top:12px"><div class="etichetta testo-giallo">Da migliorare</div><div>${esc(consiglio)}</div></div>`;
  collegaMese(main);
  collegaBilancio(main, () => vistaControlli(main, query));
}

// Dieta ────────────────────────────

function pastoDellOra() {
  const h = new Date().getHours();
  return h < 11 ? 'Colazione' : h < 15 ? 'Pranzo' : h < 18 ? 'Spuntino' : 'Cena';
}

function vistaDieta(main) {
  const pasti = pastiOggi();
  const kcal = pasti.reduce((t, p) => t + n(p.Kcal), 0);
  main.innerHTML = `
    <h1>Dieta</h1>
    <div class="griglia">
      <div class="carta"><div class="etichetta">Pasti oggi</div><div class="grande num">${pasti.length}</div></div>
      ${kcal ? `<div class="carta"><div class="etichetta">Calorie segnate</div><div class="grande num">${Math.round(kcal)} kcal</div></div>` : ''}
    </div>
    <h2>Aggiungi</h2>
    <form class="modulo carta" id="f-pasto">
      <label class="campo">Pasto<select name="pasto">${['Colazione', 'Pranzo', 'Cena', 'Spuntino'].map(p => `<option ${p === pastoDellOra() ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
      <label class="campo largo">Cosa hai mangiato<input name="cosa" required></label>
      <label class="campo">Kcal (facoltativo)<input name="kcal" type="number" min="0" inputmode="numeric"></label>
      <button class="primario" type="submit">Aggiungi</button>
    </form>
    <h2>Oggi</h2>
    <ul class="elenco carta">${pasti.length ? pasti.map(p => `<li>
      <div class="corpo"><div>${esc(p['Cosa ho mangiato'])}</div><div class="sotto">${esc(p.Pasto)}${p.Ora ? ' · ' + esc(p.Ora) : ''}${p.Kcal ? ' · ' + esc(p.Kcal) + ' kcal' : ''}</div></div>
      <button class="piccolo-b" data-elimina="${esc(p.ID)}" title="Elimina">✕</button></li>`).join('') : '<li class="vuoto">Nessun pasto registrato oggi.</li>'}</ul>
    ${bottonePenna('Pasti')}`;

  $('#f-pasto').onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    salva('Pasti', { 'Data': oggiK(), 'Ora': oraAdesso(), 'Pasto': fd.get('pasto'), 'Cosa ho mangiato': fd.get('cosa'), 'Kcal': fd.get('kcal') });
    toast('Pasto aggiunto');
    disegna();
  };
  collegaElimina(main, 'Pasti');
}

// Peso ────────────────────────────

function vistaPeso(main, query) {
  const p = calcPeso();
  const giorni = Number(query.get('giorni')) || 30;
  let valore = p.ultimo ? p.ultimo.kg : 75;
  const oggiFatto = p.ultimo && p.ultimo.data === oggiK();

  main.innerHTML = `
    <div class="testata"><h1>Peso</h1></div>
    ${schedeCibo('peso')}
    <div class="carta">
      <div class="etichetta">${oggiFatto ? 'Correggi il peso di oggi' : 'Peso di oggi'}</div>
      <div class="peso-input">
        <button data-d="-1">−1</button><button data-d="-0.1">−0,1</button>
        <div class="valore num" id="pv"></div>
        <button data-d="0.1">+0,1</button><button data-d="1">+1</button>
      </div>
      <div class="azioni" style="justify-content:center"><button class="primario" id="salva-peso" style="min-width:200px">Salva</button></div>
    </div>
    <h2>Andamento</h2>
    <div class="azioni">
      <a class="bottone ${giorni === 30 ? 'primario' : ''}" href="#/peso?giorni=30">30 giorni</a>
      <a class="bottone ${giorni === 90 ? 'primario' : ''}" href="#/peso?giorni=90">90 giorni</a>
    </div>
    <div class="carta grafico">${graficoPeso(p.misure, giorni)}
      <div class="riga2">${p.ultimo ? 'Ultimo: ' + num1.format(p.ultimo.kg) + ' kg (' + dataBreve(p.ultimo.data) + ')' : 'Nessuna pesata.'}${p.var30 == null ? '' : ' · ' + (p.var30 <= 0 ? '↓ ' : '↑ ') + num1.format(Math.abs(p.var30)) + ' kg in 30 giorni'}</div>
    </div>`;

  const mostra = () => { $('#pv').textContent = num1.format(valore) + ' kg'; };
  mostra();
  $$('[data-d]', main).forEach(b => { b.onclick = () => { valore = Math.round((valore + Number(b.dataset.d)) * 10) / 10; mostra(); }; });
  $('#salva-peso').onclick = () => {
    salva('Peso', { 'Data': oggiK(), 'Peso (kg)': valore }, oggiFatto ? p.ultimo.id : undefined);
    toast('Peso salvato');
    disegna();
  };
}

function graficoPeso(misure, giorni) {
  const da = spostaGiorni(oggiK(), -giorni);
  const punti = misure.filter(m => m.data >= da);
  if (punti.length < 2) return '<p class="vuoto">Servono almeno due pesate in questo periodo per il grafico.</p>';
  const W = 600, H = 200, M = 28;
  const min = Math.min.apply(null, punti.map(p => p.kg)) - 0.5, max = Math.max.apply(null, punti.map(p => p.kg)) + 0.5;
  const x = k => M + (giorniTra(da, k) / giorni) * (W - 2 * M);
  const y = kg => H - M - ((kg - min) / (max - min)) * (H - 2 * M);
  const linea = punti.map(p => x(p.data).toFixed(1) + ',' + y(p.kg).toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Andamento del peso">
    <line x1="${M}" x2="${W - M}" y1="${y(max - 0.5)}" y2="${y(max - 0.5)}" stroke="var(--bordo)" />
    <line x1="${M}" x2="${W - M}" y1="${y(min + 0.5)}" y2="${y(min + 0.5)}" stroke="var(--bordo)" />
    <text x="2" y="${y(max - 0.5) + 4}" fill="var(--testo-2)" font-size="12">${num1.format(max - 0.5)}</text>
    <text x="2" y="${y(min + 0.5) + 4}" fill="var(--testo-2)" font-size="12">${num1.format(min + 0.5)}</text>
    <polyline points="${linea}" fill="none" stroke="var(--accento)" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    ${punti.map(p => `<circle cx="${x(p.data).toFixed(1)}" cy="${y(p.kg).toFixed(1)}" r="3.5" fill="var(--accento)" />`).join('')}
  </svg>`;
}

// Impostazioni ────────────────────────────

function vistaImpostazioni(main, primaVolta) {
  if (tablet) {
    main.innerHTML = `<h1>Impostazioni</h1><div class="carta">
      <p>Su questo tablet indirizzo e token si gestiscono nell'app.</p>
      <p>Modifiche in coda: <strong>${coda.length}</strong> · Ultima sincronizzazione: ${statoSync.ultimo ? new Date(statoSync.ultimo).toLocaleString('it-IT') : 'mai'}</p>
      ${statoSync.errore ? `<p class="testo-rosso">Ultimo errore: ${esc(statoSync.errore)}</p>` : ''}
      <div class="azioni"><button class="primario" id="imp-app">Apri le impostazioni dell'app</button></div></div>`;
    $('#imp-app').onclick = () => tablet.apriImpostazioni();
    return;
  }
  main.innerHTML = `
    <h1>${primaVolta ? 'Benvenuto' : 'Impostazioni'}</h1>
    ${primaVolta ? '<p>Per collegare l\'app al foglio servono l\'indirizzo dello script e il token. Il token lo trovi nel foglio, menu <strong>Assistente → Mostra token per le app</strong>.</p>' : ''}
    <form class="carta" id="f-conf" style="display:flex;flex-direction:column;gap:12px">
      <label class="campo">Indirizzo dello script (finisce con /exec)<input name="url" type="url" value="${esc(config.url)}" required></label>
      <label class="campo">Token<input name="token" value="${esc(config.token)}" required autocomplete="off"></label>
      <div class="azioni"><button class="primario" type="submit">Salva e sincronizza</button></div>
    </form>
    ${primaVolta ? '' : `<h2>Stato</h2><div class="carta">
      <p>Modifiche in coda: <strong>${coda.length}</strong></p>
      <p>Ultima sincronizzazione: ${statoSync.ultimo ? new Date(statoSync.ultimo).toLocaleString('it-IT') : 'mai'}</p>
      ${statoSync.errore ? `<p class="testo-rosso">Ultimo errore: ${esc(statoSync.errore)}</p>` : ''}
    </div>`}`;
  $('#f-conf').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    config = { url: String(fd.get('url')).trim(), token: String(fd.get('token')).trim() };
    LS.set('config', config);
    toast('Collegamento in corso…');
    await sincronizza();
    if (statoSync.stato === 'ok') { toast('Collegato'); location.hash = '#/'; disegna(); } else toast('Non riesco a collegarmi: ' + statoSync.errore);
  };
}

// ───────────────────────── Quaderno a penna ─────────────────────────
// La penna del tablet non trasmette la pressione: tratto a spessore costante,
// leggermente più sottile quando si scrive veloce.

let quaderno = null;

function apriQuaderno(dest) {
  if (quaderno) return;
  document.body.classList.add('quaderno-aperto');
  const el = document.createElement('div');
  el.className = 'quaderno';
  const destinazioni = ['Nessuna', 'Movimenti', 'Pasti', 'Peso', 'Log', 'Scadenze', 'Spesa'];
  el.innerHTML = `
    <div class="strumenti">
      <button id="q-chiudi" title="Chiudi">✕</button>
      <input id="q-titolo" placeholder="Titolo (facoltativo)">
      <select id="q-dest" aria-label="Destinazione">${destinazioni.map(d => `<option ${d === dest ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <button id="q-annulla">Annulla</button>
      <button id="q-pulisci">Pulisci</button>
      <button id="q-salva" class="primario">Salva</button>
    </div>
    <canvas id="q-tela"></canvas>`;
  document.body.appendChild(el);

  const tela = $('#q-tela', el), ctx = tela.getContext('2d');
  const tratti = [];
  let corrente = null, vistaPenna = false;
  const dpr = window.devicePixelRatio || 1;

  function dimensiona() {
    tela.width = tela.clientWidth * dpr;
    tela.height = tela.clientHeight * dpr;
    ridisegna();
  }
  function ridisegna() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--carta') || '#fff';
    ctx.fillRect(0, 0, tela.clientWidth, tela.clientHeight);
    tratti.forEach(t => disegnaTratto(ctx, t));
  }
  function disegnaTratto(c, t) {
    c.strokeStyle = '#1a2440'; c.fillStyle = '#1a2440'; c.lineCap = 'round'; c.lineJoin = 'round';
    if (t.length === 1) { c.beginPath(); c.arc(t[0].x, t[0].y, t[0].w / 2, 0, Math.PI * 2); c.fill(); return; }
    for (let i = 1; i < t.length; i++) {
      c.lineWidth = t[i].w;
      c.beginPath(); c.moveTo(t[i - 1].x, t[i - 1].y); c.lineTo(t[i].x, t[i].y); c.stroke();
    }
  }
  function punto(e, prec) {
    const r = tela.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp, w: 2.6 };
    if (prec) {
      const v = Math.hypot(p.x - prec.x, p.y - prec.y) / Math.max(1, p.t - prec.t);
      const obiettivo = Math.max(1.6, Math.min(3.2, 3.2 - v * 0.9));
      p.w = prec.w * 0.7 + obiettivo * 0.3;
    }
    return p;
  }
  // Se la penna è stata usata, il palmo appoggiato (touch) non disegna.
  function accetta(e) {
    if (e.pointerType === 'pen') { vistaPenna = true; return true; }
    return !(vistaPenna && e.pointerType === 'touch');
  }

  tela.addEventListener('pointerdown', e => {
    if (!accetta(e)) return;
    tela.setPointerCapture(e.pointerId);
    corrente = [punto(e)];
    tratti.push(corrente);
    disegnaTratto(ctx, corrente);
  });
  tela.addEventListener('pointermove', e => {
    if (!corrente || !accetta(e)) return;
    const eventi = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    eventi.forEach(ev => {
      const p = punto(ev, corrente[corrente.length - 1]);
      corrente.push(p);
      disegnaTratto(ctx, corrente.slice(-2));
    });
  });
  const fine = () => { corrente = null; };
  tela.addEventListener('pointerup', fine);
  tela.addEventListener('pointercancel', fine);

  $('#q-annulla', el).onclick = () => { tratti.pop(); ridisegna(); };
  $('#q-pulisci', el).onclick = () => { if (tratti.length && confirm('Cancellare la pagina?')) { tratti.length = 0; ridisegna(); } };
  $('#q-chiudi', el).onclick = () => {
    if (tratti.length && !confirm('Chiudere senza salvare?')) return;
    chiudiQuaderno();
  };
  $('#q-salva', el).onclick = () => {
    if (!tratti.length) { toast('La pagina è vuota'); return; }
    // Esporta a risoluzione 1:1 su sfondo bianco: leggibile e leggera da inviare.
    const out = document.createElement('canvas');
    out.width = tela.clientWidth; out.height = tela.clientHeight;
    const c = out.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, out.width, out.height);
    tratti.forEach(t => disegnaTratto(c, t));
    const op = {
      tipo: 'quaderno', id: nuovoId(), modificato: new Date().toISOString(), immagine: out.toDataURL('image/png'),
      titolo: $('#q-titolo', el).value.trim(), data: oggiK(), destinazione: $('#q-dest', el).value,
    };
    coda.push(op);
    persisti();
    pianificaSync(0);
    toast('Pagina salvata' + (navigator.onLine ? '' : ': la invio appena torna il Wi-Fi'));
    tratti.length = 0;
    chiudiQuaderno();
  };

  quaderno = { el, dimensiona };
  window.addEventListener('resize', dimensiona);
  requestAnimationFrame(dimensiona);
}

function chiudiQuaderno() {
  const dest = $('#q-dest') ? $('#q-dest').value : '';
  chiudiQuadernoSeAperto();
  const ritorno = { Movimenti: 'finanze', Pasti: 'dieta', Peso: 'peso', Log: 'allenamento', Scadenze: 'scadenze', Spesa: 'spesa' }[dest] || '';
  location.hash = '#/' + ritorno;
}

function chiudiQuadernoSeAperto() {
  if (!quaderno) return;
  window.removeEventListener('resize', quaderno.dimensiona);
  quaderno.el.remove();
  quaderno = null;
  document.body.classList.remove('quaderno-aperto');
}

// ───────────────────────── Avvio ─────────────────────────

// Dentro l'app del tablet la navigazione tra sezioni la fanno i widget: barra ridotta.
if (/AssistenteTablet/.test(navigator.userAgent)) document.body.classList.add('incorporata');

$('#stato').onclick = () => sincronizza();
window.addEventListener('hashchange', disegna);
window.addEventListener('online', () => pianificaSync(0));
window.addEventListener('offline', () => { statoSync.stato = 'offline'; aggiornaStato(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) pianificaSync(0); });
setInterval(() => { if (!document.hidden && coda.length) sincronizza(); }, 60000);


// ───────────────────────── v8: Fuori (Diario, Uscita, Anno, Si vola?), orologio (SPEC v8, mockup 29) ─────────────────────────
// Le uscite arrivano da sole dalle sessioni dell'orologio (scheda Uscite, creata dallo script con l'azione `salute`).
// Tipo finale = "Tipo scelto" (la scelta di Daniele vince sempre) altrimenti "Tipo" automatico; "da classificare" in cima.

const SCHEDE_FUORI = [['fuori', 'Diario'], ['uscita', 'Uscita'], ['anno', 'Anno'], ['vola', 'Si vola?']];
const TIPI_FUORI = {
  volo: { icona: '🪂', nome: 'Volo', filtro: 'voli' }, montagna: { icona: '⛰', nome: 'Montagna', filtro: 'montagna' },
  scalata: { icona: '🧗', nome: 'Scalata', filtro: 'scalate' }, neve: { icona: '❄', nome: 'Neve', filtro: 'neve' },
  bici: { icona: '🚵', nome: 'Bici', filtro: 'bici' },
};
const FILTRI_FUORI = [['tutte', 'tutte'], ['voli', '🪂 voli'], ['montagna', '⛰ montagna'], ['scalate', '🧗 scalate'], ['neve', '❄ neve'], ['bici', '🚵 bici']];

function schedeFuori(attiva) {
  return `<nav class="schede-fin">${SCHEDE_FUORI.map(s => `<a href="#/${s[0]}" class="${s[0] === attiva ? 'attiva' : ''}">${s[1]}</a>`).join('')}</nav>`;
}

function tipoUscita(u) { return normalizza(u['Tipo scelto']) || normalizza(u.Tipo) || 'da classificare'; }
function usciteTutte() { return righe('Uscite').filter(u => u.Data).sort((a, b) => (a.Data < b.Data ? 1 : a.Data > b.Data ? -1 : 0)); }
function usciteFuori() { return usciteTutte().filter(u => TIPI_FUORI[tipoUscita(u)]); }
function daClassificare() { return usciteTutte().filter(u => tipoUscita(u) === 'da classificare'); }
function oreMinuti(min) { const m = Math.round(n(min)); return m >= 60 ? Math.floor(m / 60) + 'h' + pad(m % 60) : m + ' min'; }
function intIt(x) { return Math.round(n(x)).toLocaleString('it-IT'); }

/** Sessioni dell'orologio (scheda Attività) con la categoria finale, per la costanza e la settimana. */
function sessioniOrologioWeb() {
  const scelte = {};
  righe('Uscite').forEach(u => { if (u['ID attività']) scelte[u['ID attività']] = tipoUscita(u); });
  return righe('Attività').filter(a => a.Data).map(a => {
    const t = String(a.Tipo || '').toUpperCase();
    const cat = scelte[a.ID] || (/STRENGTH|WEIGHT|CALISTHENICS|HIGH_INTENSITY|TREADMILL|STATIONARY|SWIMMING|ELLIPTICAL|ROWING|YOGA|PILATES|STAIR|BOOT_CAMP|EXERCISE_CLASS|STRETCHING/.test(t) ? 'allenamento'
      : /RUNNING|WALKING/.test(t) ? (n(a['Dislivello (m)']) >= (t === 'WALKING' ? 300 : 400) ? 'montagna' : 'allenamento') : 'altro');
    return { data: a.Data, tipo: t, categoria: cat, cardio: !/STRENGTH|WEIGHT|CALISTHENICS/.test(t) };
  }).filter(s => s.categoria !== 'non conta' && s.categoria !== 'da classificare');
}

/** Distanza in metri tra due punti. */
function metri(a, b) {
  const R = 6371000, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function puntoDa(s) { const p = String(s || '').split(',').map(Number); return p.length >= 2 && !isNaN(p[0]) && !isNaN(p[1]) && p[0] ? [p[0], p[1]] : null; }

/** Località preferite di FUORI: "nome|lat|lon|quota|S:2,SO:1; …". */
function preferitiFuori() {
  return String(par('Località preferite') || '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const f = x.split('|');
    return { nome: f[0].trim(), lat: n(f[1]), lon: n(f[2]), quota: n(f[3]), orient: (f[4] || '').trim() };
  }).filter(p => p.lat);
}

const ROSA8 = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

/**
 * Decollo noto entro 300 m dalla partenza: prima i preferiti, poi OpenStreetMap (Overpass, dal browser, con cache).
 * Ritorna { nome, orient } oppure null.
 */
async function decolloVicino(partenza) {
  const p = puntoDa(partenza);
  if (!p) return null;
  for (const f of preferitiFuori()) if (metri(p, [f.lat, f.lon]) <= 300) return { nome: f.nome, orient: f.orient.replace(/:\d/g, '').replace(/,/g, ' / ') };
  const cache = LS.get('decolliVicini', {}), k = p[0].toFixed(3) + ',' + p[1].toFixed(3);
  if (cache[k] !== undefined) return cache[k];
  const q = `[out:json][timeout:20];(nwr["free_flying:site"="takeoff"](around:300,${p[0]},${p[1]});nwr["sport"="free_flying"](around:300,${p[0]},${p[1]}););out center tags 10;`;
  for (const s of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try {
      const r = await fetch(s + '?data=' + encodeURIComponent(q));
      if (!r.ok) continue;
      const j = await r.json();
      const el = (j.elements || []).filter(e => e.tags && !/landing|packing/.test(e.tags['free_flying:site'] || ''));
      let ris = null;
      if (el.length) {
        const t = el[0].tags;
        ris = { nome: t.name || t.description || 'decollo OSM', orient: t['free_flying:site_orientation'] || t.direction || '' };
      }
      cache[k] = ris;
      LS.set('decolliVicini', cache);
      return ris;
    } catch (e) { /* prossimo server */ }
  }
  return null;
}

/** Meteo del giorno dell'uscita (archivio di Open-Meteo) → testo breve per la colonna "Meteo (testo)". */
async function meteoDelGiorno(u) {
  const p = puntoDa(u.Partenza);
  if (!p || !u.Data) return '';
  const ora = Number(String(u.Inizio || '13').slice(0, 2)) || 13;
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${p[0]}&longitude=${p[1]}&start_date=${u.Data}&end_date=${u.Data}` +
    '&hourly=temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_850hPa&timezone=Europe%2FRome';
  const j = await (await fetch(url)).json();
  const h = j.hourly;
  if (!h || !h.time) return '';
  const i = Math.min(h.time.length - 1, Math.max(0, ora));
  const v = Math.round(h.wind_speed_10m[i]), raf = Math.round(h.wind_gusts_10m[i]), v15 = Math.round(h.wind_speed_850hPa[i]);
  const dir = ROSA8[Math.round(((h.wind_direction_10m[i] % 360) + 360) % 360 / 45) % 8];
  const base = Math.round(125 * (h.temperature_2m[i] - h.dew_point_2m[i]) / 100) * 100 + (n(j.elevation) || 0);
  const sv = numPar('Volo vento medio max (km/h)', 25), sr = numPar('Volo raffiche max (km/h)', 30), s15 = numPar('Volo vento 1500 m max (km/h)', 30);
  const sem = v <= sv && raf <= sr && v15 <= s15 ? 'verde' : v <= sv * 1.2 && raf <= sr * 1.2 && v15 <= s15 * 1.2 ? 'giallo' : 'rosso';
  return `${Math.round(h.temperature_2m[i])}° · vento ${v} km/h ${dir} · raffiche ${raf} · 1500 m: ${v15} km/h · base ${intIt(base)} m · semaforo ${sem}`;
}

function vistaFuori(main, query) {
  const anni = [...new Set(usciteTutte().map(u => u.Data.slice(0, 4)))].sort().reverse();
  const anno = (query && query.get('anno')) || String(new Date().getFullYear());
  if (anni.indexOf(anno) < 0) anni.unshift(anno);
  const filtro = (query && query.get('filtro')) || 'tutte';
  const dell = usciteFuori().filter(u => u.Data.slice(0, 4) === anno);
  const voli = dell.filter(u => tipoUscita(u) === 'volo');
  const lista = filtro === 'tutte' ? dell : dell.filter(u => (TIPI_FUORI[tipoUscita(u)] || {}).filtro === filtro);
  const dc = daClassificare();

  main.innerHTML = `
    <div class="testata"><h1>Fuori</h1><select id="fu-anno" class="cat-riga">${anni.map(a => `<option ${a === anno ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
    ${schedeFuori('fuori')}
    <div class="carta griglia-3 fuori-tot">
      <div><div class="piccolo">${anno}</div><div class="grande num">${dell.length}</div><div class="piccolo">uscite</div></div>
      <div><div class="piccolo">voli</div><div class="grande num testo-verde">${voli.length}</div><div class="piccolo">${oreMinuti(voli.reduce((s, u) => s + n(u['Durata (min)']), 0))} in aria</div></div>
      <div><div class="piccolo">dislivello</div><div class="grande num testo-accento">${intIt(dell.filter(u => tipoUscita(u) !== 'volo').reduce((s, u) => s + n(u['Dislivello (m)']), 0))}</div><div class="piccolo">m+</div></div>
    </div>
    ${dc.length ? `<div class="carta evidenza" style="margin-top:12px"><div class="etichetta testo-giallo">Da classificare · ${dc.length}</div>
      ${dc.map(u => `<div class="da-class" data-id="${esc(u.ID)}">
        <div class="budget-testa"><a href="#/uscita?id=${encodeURIComponent(u.ID)}"><strong>${esc(u.Nome || 'Attività')}</strong> · ${oreMinuti(u['Durata (min)'])}${n(u.Km) ? ' · ' + num1.format(n(u.Km)) + ' km' : ''}</a><span class="piccolo">${dataBreve(u.Data)}</span></div>
        <p class="piccolo sugg" data-sugg="${esc(u.ID)}">${u.Suggerimento === 'volo' ? '🪂 <strong>Sembra un volo · confermi?</strong> (molta discesa, pochi passi)' : ''}</p>
        <div class="chips">${[['volo', '🪂 Volo'], ['montagna', '⛰ Montagna'], ['scalata', '🧗 Scalata'], ['neve', '❄ Neve'], ['bici', '🚵 Bici'], ['allenamento', '🏋 Allenamento'], ['non conta', '✕ Non conta']]
          .map(t => `<button type="button" class="chip" data-classifica="${t[0]}">${t[1]}</button>`).join('')}</div></div>`).join('')}</div>` : ''}
    <div class="chips" style="margin-top:12px">${FILTRI_FUORI.map(f => `<a class="chip ${f[0] === filtro ? 'attivo' : ''}" href="#/fuori?anno=${anno}&filtro=${f[0]}">${f[1]}</a>`).join('')}</div>
    <div class="uscite">${lista.map(rigaUscita).join('') || '<p class="piccolo" style="padding:12px">Nessuna uscita.</p>'}</div>
    <div style="text-align:center;margin-top:14px"><button type="button" class="primario" id="fu-mano">＋ uscita a mano</button>
      <p class="piccolo">⌚ le uscite registrate con l'orologio arrivano da sole</p></div>
    <div id="fu-form"></div>`;

  $('#fu-anno', main).onchange = e => { location.hash = '#/fuori?anno=' + e.target.value + '&filtro=' + filtro; };
  $$('[data-classifica]', main).forEach(b => {
    b.onclick = () => {
      const id = b.closest('[data-id]').dataset.id;
      salva('Uscite', { 'Tipo scelto': b.dataset.classifica }, id);
      toast(b.dataset.classifica === 'non conta' ? 'Nascosta (resta in Attività)' : 'Spostata in ' + b.dataset.classifica);
      vistaFuori(main, query);
    };
  });
  // Suggerimento "Sembra un volo": partenza entro 300 m da un decollo noto (in sottofondo, non sposta niente da solo).
  dc.forEach(async u => {
    if (u.Suggerimento === 'volo') return;
    const d = await decolloVicino(u.Partenza);
    const el = $(`[data-sugg="${CSS.escape(u.ID)}"]`, main);
    if (d && el) el.innerHTML = `🪂 <strong>Sembra un volo · confermi?</strong> (partenza vicino a ${esc(d.nome)})`;
  });
  $('#fu-mano', main).onclick = () => formUscita($('#fu-form', main), null, () => vistaFuori(main, query));
}

function rigaUscita(u) {
  const t = TIPI_FUORI[tipoUscita(u)] || { icona: '•' };
  const volo = tipoUscita(u) === 'volo';
  const sotto = volo ? `${oreMinuti(u['Durata (min)'])}${u.Decollo ? ' · decollo ' + esc(u.Decollo) : ''}`
    : `${n(u['Dislivello (m)']) ? intIt(u['Dislivello (m)']) + ' m+ · ' : ''}${n(u.Km) ? num1.format(n(u.Km)) + ' km · ' : ''}${oreMinuti(u['Durata (min)'])}`;
  const meteo = String(u['Meteo (testo)'] || '').split(' · ').slice(0, 2).join(' · ');
  return `<a class="carta uscita" href="#/uscita?id=${encodeURIComponent(u.ID)}">
    <span class="uscita-icona">${t.icona}</span>
    <span class="uscita-corpo"><span class="budget-testa"><strong>${esc(u.Nome || t.nome || 'Uscita')}${volo ? ' · volo' : ''}</strong><span class="piccolo">${dataBreve(u.Data)}</span></span>
      <span class="${volo ? 'testo-verde' : 'testo-accento'}">${sotto}</span>
      <span class="piccolo">${esc(meteo)}${u.Diario ? ' · nota' : ''}${u['Foto (link cartella)'] ? ' · foto' : ''}${u.Persone ? ' · con ' + esc(u.Persone) : ''}</span></span></a>`;
}

/** Uscita a mano (o modifica dei dati base). */
function formUscita(box, u, fatto) {
  const v = u || { Data: oggiK(), Tipo: 'montagna' };
  box.innerHTML = `<div class="carta" style="margin-top:12px"><div class="etichetta">${u ? 'Modifica uscita' : 'Nuova uscita'}</div>
    <label class="campo-riga">Data<input type="date" id="fm-data" value="${esc(v.Data)}"></label>
    <label class="campo-riga">Tipo<select id="fm-tipo">${Object.keys(TIPI_FUORI).map(k => `<option value="${k}" ${tipoUscita(v) === k ? 'selected' : ''}>${TIPI_FUORI[k].icona} ${TIPI_FUORI[k].nome}</option>`).join('')}</select></label>
    <label class="campo-riga">Nome<input id="fm-nome" value="${esc(v.Nome || '')}" placeholder="es. Monte Soglio"></label>
    <label class="campo-riga">Decollo (voli)<input id="fm-dec" value="${esc(v.Decollo || '')}"></label>
    <label class="campo-riga">Durata (min)<input id="fm-dur" inputmode="numeric" value="${esc(v['Durata (min)'] || '')}"></label>
    <label class="campo-riga">Dislivello (m+)<input id="fm-dis" inputmode="numeric" value="${esc(v['Dislivello (m)'] || '')}"></label>
    <label class="campo-riga">Km<input id="fm-km" inputmode="decimal" value="${esc(v.Km || '')}"></label>
    <label class="campo-riga">Quota max (m)<input id="fm-q" inputmode="numeric" value="${esc(v['Quota max (m)'] || '')}"></label>
    <button type="button" class="primario" id="fm-salva">Salva</button></div>`;
  $('#fm-salva', box).onclick = () => {
    const tipo = $('#fm-tipo', box).value;
    const valori = { Data: $('#fm-data', box).value, Nome: $('#fm-nome', box).value.trim(), Decollo: $('#fm-dec', box).value.trim(),
      'Durata (min)': $('#fm-dur', box).value, 'Dislivello (m)': $('#fm-dis', box).value, Km: $('#fm-km', box).value, 'Quota max (m)': $('#fm-q', box).value };
    if (u) valori['Tipo scelto'] = tipo; else valori.Tipo = tipo;
    salva('Uscite', valori, u ? u.ID : null);
    toast('Uscita salvata');
    fatto();
  };
}

const tracce = {};

async function caricaTraccia(u) {
  if (tracce[u.ID] !== undefined) return tracce[u.ID];
  const loc = LS.get('traccia:' + u.ID, null);
  if (loc) return (tracce[u.ID] = loc);
  if (u.Traccia) return (tracce[u.ID] = u.Traccia);
  try {
    const r = await api('traccia', { id: u.ID });
    tracce[u.ID] = r.traccia || '';
    if (r.traccia) LS.set('traccia:' + u.ID, r.traccia);
  } catch (e) { tracce[u.ID] = ''; }
  return tracce[u.ID];
}

/** Traccia "lat,lon,ele;…" → SVG (nord in alto), con partenza e arrivo e le loro quote. */
function svgTraccia(t, volo) {
  const p = String(t || '').split(';').map(x => x.split(',').map(Number)).filter(x => x.length >= 2 && !isNaN(x[0]));
  if (p.length < 2) return '';
  const la = p.map(x => x[0]), lo = p.map(x => x[1]);
  const cx = Math.cos((Math.min(...la) + Math.max(...la)) / 2 * Math.PI / 180);
  const W = 340, H = 170, m = 22;
  const dx = Math.max(1e-6, (Math.max(...lo) - Math.min(...lo)) * cx), dy = Math.max(1e-6, Math.max(...la) - Math.min(...la));
  const s = Math.min((W - 2 * m) / dx, (H - 2 * m) / dy);
  const X = x => m + (x[1] - Math.min(...lo)) * cx * s + ((W - 2 * m) - dx * s) / 2, Y = x => H - m - (x[0] - Math.min(...la)) * s - ((H - 2 * m) - dy * s) / 2;
  const a = p[0], b = p[p.length - 1];
  const et = (x, testo, sopra) => `<text x="${Math.min(W - 4, Math.max(4, X(x))).toFixed(0)}" y="${(Y(x) + (sopra ? -10 : 18)).toFixed(0)}" text-anchor="${X(x) > W / 2 ? 'end' : 'start'}" font-size="11" fill="#e8eefc">${testo}</text>`;
  return `<svg class="traccia" viewBox="0 0 ${W} ${H}" role="img" aria-label="traccia GPS">
    <rect width="${W}" height="${H}" rx="12" fill="#14333a"/>
    <polyline points="${p.map(x => X(x).toFixed(1) + ',' + Y(x).toFixed(1)).join(' ')}" fill="none" stroke="#6ee7a8" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="${X(a)}" cy="${Y(a)}" r="6" fill="#ffcf5a"/><circle cx="${X(b)}" cy="${Y(b)}" r="6" fill="#7fd4ff"/>
    ${et(a, (volo ? 'decollo ' : 'partenza ') + (a[2] != null && !isNaN(a[2]) ? intIt(a[2]) + ' m' : ''), Y(a) > 30)}
    ${et(b, (volo ? 'atterraggio ' : 'arrivo ') + (b[2] != null && !isNaN(b[2]) ? intIt(b[2]) + ' m' : ''), Y(b) > 30)}</svg>`;
}

/** GPX (es. esportato da Zepp) → traccia compatta, km, dislivello, quota max. */
function leggiGpx(testo) {
  const doc = new DOMParser().parseFromString(testo, 'application/xml');
  const pt = $$('trkpt, rtept', doc).map(e => [Number(e.getAttribute('lat')), Number(e.getAttribute('lon')), Number((e.querySelector('ele') || {}).textContent)]);
  if (pt.length < 2) throw new Error('nessun punto nel GPX');
  let km = 0, su = 0, max = -1e9, prec = NaN;
  pt.forEach((x, i) => {
    if (i) km += metri(pt[i - 1], x) / 1000;
    if (!isNaN(x[2])) { max = Math.max(max, x[2]); if (!isNaN(prec) && x[2] - prec > 2) su += x[2] - prec; if (isNaN(prec) || Math.abs(x[2] - prec) > 2) prec = x[2]; }
  });
  const passo = Math.max(1, Math.ceil(pt.length / 400));
  const t = pt.filter((x, i) => i % passo === 0 || i === pt.length - 1).map(x => x[0].toFixed(5) + ',' + x[1].toFixed(5) + (isNaN(x[2]) ? '' : ',' + Math.round(x[2]))).join(';');
  return { traccia: t, km: Math.round(km * 10) / 10, dislivello: Math.round(su), quota: max > -1e8 ? Math.round(max) : '', partenza: pt[0][0].toFixed(5) + ',' + pt[0][1].toFixed(5) };
}

/** Foto ridotta a 1600 px (JPEG) prima dell'invio a Drive. */
function riduciFoto(file) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => ko(new Error('immagine non leggibile'));
    img.src = URL.createObjectURL(file);
  });
}

function vistaUscita(main, query) {
  const tutte = usciteTutte().filter(u => tipoUscita(u) !== 'non conta');
  let i = tutte.findIndex(u => u.ID === (query && query.get('id')));
  if (i < 0) i = 0;
  const u = tutte[i];
  if (!u) { main.innerHTML = `<div class="testata"><h1>Uscita</h1></div>${schedeFuori('uscita')}<p class="piccolo">Nessuna uscita ancora.</p>`; return; }
  const tipo = tipoUscita(u), volo = tipo === 'volo', t = TIPI_FUORI[tipo] || { icona: '•', nome: 'Da classificare' };
  const vai = j => `#/uscita?id=${encodeURIComponent(tutte[j].ID)}`;
  main.innerHTML = `
    <div class="testata"><h1>Uscita</h1><span class="frecce">${i < tutte.length - 1 ? `<a class="chip" href="${vai(i + 1)}" aria-label="precedente">◀</a>` : ''}${i > 0 ? `<a class="chip" href="${vai(i - 1)}" aria-label="successiva">▶</a>` : ''}</span></div>
    ${schedeFuori('uscita')}
    <div id="us-traccia" class="carta" style="padding:6px"><p class="piccolo" style="padding:8px">Carico la traccia…</p></div>
    <div class="carta" style="margin-top:12px">
      <div class="budget-testa"><strong class="grande">${t.icona} ${esc(u.Nome || t.nome)} · ${dataBreve(u.Data)}</strong></div>
      <p class="piccolo" id="us-decollo">${volo ? (u.Decollo ? 'decollo: <strong>' + esc(u.Decollo) + '</strong>' : 'cerco il decollo…') : esc(t.nome)}</p>
      <div class="griglia-3 fuori-tot">
        <div><div class="piccolo">${volo ? 'in aria' : 'durata'}</div><div class="grande num">${oreMinuti(u['Durata (min)'])}</div></div>
        <div><div class="piccolo">quota max</div><div class="grande num">${n(u['Quota max (m)']) ? intIt(u['Quota max (m)']) + ' m' : '—'}</div></div>
        <div><div class="piccolo">${volo ? 'salita max' : 'dislivello'}</div><div class="grande num">${volo ? (n(u['Salita max (m/s)']) ? '+' + num1.format(n(u['Salita max (m/s)'])) + ' m/s' : '—') : (n(u['Dislivello (m)']) ? intIt(u['Dislivello (m)']) + ' m+' : '—')}</div></div></div>
      ${n(u.Km) ? `<p class="piccolo">${num1.format(n(u.Km))} km${volo && n(u['Dislivello (m)']) ? ' · ' + intIt(u['Dislivello (m)']) + ' m di salita in termica' : ''}</p>` : ''}
      <div class="chips"><span class="piccolo">Cambia tipo:</span>${[['volo', '🪂'], ['montagna', '⛰'], ['scalata', '🧗'], ['neve', '❄'], ['bici', '🚵'], ['allenamento', '🏋'], ['non conta', '✕']]
        .map(x => `<button type="button" class="chip ${tipo === x[0] ? 'attivo' : ''}" data-tipo="${x[0]}" title="${x[0]}">${x[1]}</button>`).join('')}</div>
    </div>
    <div class="carta" style="margin-top:12px"><div class="etichetta">Meteo del giorno</div><p id="us-meteo">${esc(u['Meteo (testo)'] || (u.Partenza ? 'lo ricostruisco dall\'archivio di Open-Meteo…' : 'serve il punto di partenza (dall\'orologio o da un GPX)'))}</p></div>
    <div class="carta" style="margin-top:12px"><div class="etichetta">Diario</div>
      <textarea id="us-diario" rows="4" placeholder="com'è andata…">${esc(u.Diario || '')}</textarea>
      <label class="campo-riga">👥 Con<input id="us-persone" value="${esc(u.Persone || '')}" placeholder="es. Marco"></label>
      <div class="chips">
        <label class="chip">📷 aggiungi foto<input type="file" id="us-foto" accept="image/*" multiple hidden></label>
        ${u['Foto (link cartella)'] ? `<a class="chip" href="${esc(u['Foto (link cartella)'])}" target="_blank" rel="noopener">📁 foto su Drive</a>` : ''}
        <label class="chip">🗺 carica GPX<input type="file" id="us-gpx" accept=".gpx,application/gpx+xml" hidden></label>
        <button type="button" class="chip" id="us-modifica">✎ modifica dati</button></div>
      <div id="us-form"></div></div>`;

  $$('[data-tipo]', main).forEach(b => { b.onclick = () => { salva('Uscite', { 'Tipo scelto': b.dataset.tipo }, u.ID); toast('Tipo: ' + b.dataset.tipo); vistaUscita(main, query); }; });
  const salvaTesto = () => salva('Uscite', { Diario: $('#us-diario', main).value, Persone: $('#us-persone', main).value }, u.ID);
  $('#us-diario', main).onchange = salvaTesto;
  $('#us-persone', main).onchange = salvaTesto;
  $('#us-modifica', main).onclick = () => formUscita($('#us-form', main), u, () => vistaUscita(main, query));
  $('#us-foto', main).onchange = async e => {
    for (const f of e.target.files) {
      try { toast('Invio ' + f.name + '…'); const r = await api('fotoUscita', { id: u.ID, nome: f.name.replace(/\.[^.]+$/, '') + '.jpg', immagine: await riduciFoto(f) });
        applicaLocale({ scheda: 'Uscite', tipo: 'salva', id: u.ID, modificato: new Date().toISOString(), valori: { 'Foto (link cartella)': r.cartella } }); persisti(); toast('Foto salvata su Drive'); }
      catch (err) { toast('Foto non inviata: ' + (err.message || err)); }
    }
    vistaUscita(main, query);
  };
  $('#us-gpx', main).onchange = async e => {
    try {
      const g = leggiGpx(await e.target.files[0].text());
      LS.set('traccia:' + u.ID, g.traccia);
      tracce[u.ID] = g.traccia;
      salva('Uscite', { Traccia: g.traccia, Km: u.Km || g.km, 'Dislivello (m)': u['Dislivello (m)'] || g.dislivello, 'Quota max (m)': u['Quota max (m)'] || g.quota, Partenza: u.Partenza || g.partenza }, u.ID);
      toast('Traccia caricata');
      vistaUscita(main, query);
    } catch (err) { toast('GPX non letto: ' + (err.message || err)); }
  };

  caricaTraccia(u).then(t => {
    const box = $('#us-traccia', main);
    if (box) box.innerHTML = t ? svgTraccia(t, volo) : '<p class="piccolo" style="padding:8px">Nessuna traccia GPS (Zepp non l\'ha inviata a Connessione Salute): carica il GPX esportato da Zepp.</p>';
  });
  if (volo && !u.Decollo && u.Partenza) {
    decolloVicino(u.Partenza).then(d => {
      const el = $('#us-decollo', main);
      if (!el) return;
      if (!d) { el.textContent = 'decollo non riconosciuto (nessun decollo noto entro 300 m)'; return; }
      el.innerHTML = `decollo riconosciuto: <strong>${esc(d.nome)}</strong>${d.orient ? ' · orientato ' + esc(d.orient) : ''}`;
      salva('Uscite', { Decollo: d.nome + (d.orient ? ' ' + d.orient : '') }, u.ID);
    });
  }
  if (!u['Meteo (testo)'] && u.Partenza) {
    meteoDelGiorno(Object.assign({ Inizio: (righe('Attività').find(a => a.ID === u['ID attività']) || {}).Inizio }, u)).then(m => {
      const el = $('#us-meteo', main);
      if (el) el.textContent = m || 'meteo non disponibile';
      if (m) salva('Uscite', { 'Meteo (testo)': m }, u.ID);
    }).catch(() => { const el = $('#us-meteo', main); if (el) el.textContent = 'meteo non disponibile (serve la rete)'; });
  }
}

function vistaAnnoFuori(main, query) {
  const anno = (query && query.get('anno')) || String(new Date().getFullYear());
  const anni = [...new Set(usciteTutte().map(u => u.Data.slice(0, 4)).concat([anno]))].sort().reverse();
  const dell = usciteFuori().filter(u => u.Data.slice(0, 4) === anno);
  const perMese = Array.from({ length: 12 }, () => ({ m: 0, v: 0 }));
  dell.forEach(u => { const k = Number(u.Data.slice(5, 7)) - 1; if (tipoUscita(u) === 'volo') perMese[k].v++; else perMese[k].m++; });
  const max = Math.max(1, ...perMese.map(x => Math.max(x.m, x.v)));
  const W = 340, H = 120, bw = W / 12;
  const voli = dell.filter(u => tipoUscita(u) === 'volo');
  const dec = {};
  voli.forEach(u => { const k = String(u.Decollo || 'decollo sconosciuto').replace(/\s+(N|NE|E|SE|S|SO|SW|O|W|NO|NW)([\s/;-].*)?$/, ''); dec[k] = dec[k] || { n: 0, min: 0 }; dec[k].n++; dec[k].min += n(u['Durata (min)']); });
  const piu = Object.keys(dec).sort((a, b) => dec[b].n - dec[a].n || dec[b].min - dec[a].min).slice(0, 6);
  const lungo = voli.slice().sort((a, b) => n(b['Durata (min)']) - n(a['Durata (min)']))[0];
  const alto = dell.slice().sort((a, b) => n(b['Quota max (m)']) - n(a['Quota max (m)']))[0];
  const duro = dell.filter(u => tipoUscita(u) !== 'volo').sort((a, b) => n(b['Dislivello (m)']) - n(a['Dislivello (m)']))[0];
  main.innerHTML = `
    <div class="testata"><h1>Anno</h1><select id="an-anno" class="cat-riga">${anni.map(a => `<option ${a === anno ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
    ${schedeFuori('anno')}
    <div class="carta"><div class="etichetta">Uscite per mese · ${anno}</div>
      <svg class="grafico-bollette" viewBox="0 0 ${W} ${H}" role="img" aria-label="uscite per mese">${perMese.map((x, i) => `
        <rect x="${i * bw + 4}" y="${H - 18 - (H - 26) * x.m / max}" width="${bw / 2 - 4}" height="${(H - 26) * x.m / max}" rx="2" fill="#7fd4ff"/>
        <rect x="${i * bw + bw / 2}" y="${H - 18 - (H - 26) * x.v / max}" width="${bw / 2 - 4}" height="${(H - 26) * x.v / max}" rx="2" fill="#6ee7a8"/>
        <text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#9aa0a6">${'GFMAMGLASOND'.charAt(i)}</text>`).join('')}</svg>
      <p class="piccolo"><span class="quadratino" style="background:#7fd4ff"></span>montagna e altro <span class="quadratino" style="background:#6ee7a8"></span>voli</p></div>
    <div class="carta" style="margin-top:12px"><div class="etichetta">Decolli più usati</div>
      ${piu.map(k => `<div class="budget-testa riga-sottile"><span>${esc(k)}</span><span class="piccolo">${dec[k].n} ${dec[k].n === 1 ? 'volo' : 'voli'} · ${oreMinuti(dec[k].min)}</span></div>`).join('') || '<p class="piccolo">nessun volo</p>'}</div>
    <div class="carta" style="margin-top:12px"><div class="etichetta">Record</div>
      <div class="budget-testa riga-sottile"><span>Volo più lungo</span><strong>${lungo ? oreMinuti(lungo['Durata (min)']) + ' · ' + esc(String(lungo.Decollo || lungo.Nome || '').split(' ')[0] ? lungo.Decollo || lungo.Nome : '') : '—'}</strong></div>
      <div class="budget-testa riga-sottile"><span>Quota max</span><strong>${alto && n(alto['Quota max (m)']) ? intIt(alto['Quota max (m)']) + ' m' : '—'}</strong></div>
      <div class="budget-testa riga-sottile"><span>Giro più duro</span><strong>${duro && n(duro['Dislivello (m)']) ? intIt(duro['Dislivello (m)']) + ' m+ · ' + esc(duro.Nome || '') : '—'}</strong></div></div>`;
  $('#an-anno', main).onchange = e => { location.hash = '#/anno?anno=' + e.target.value; };
}

/**
 * "Si vola?" (formato telefono): per ogni località preferita, semaforo del giorno con le stesse soglie della pagina FUORI
 * (parametri "Volo …"): vento al suolo, raffiche, vento a 1500 m (850 hPa), pioggia; ora volabile solo con la luce
 * (alba + margine, tramonto − margine) e, se il decollo ha orientamenti, col vento da un settore buono.
 */
const LIVELLI_VOLO = [950, 900, 850, 800, 750, 700, 650, 600];

/** Gradiente adiabatico saturo (°C/km), come Volo.satura del tablet. */
function saturaVolo(t, z) {
  const p = 1013.25 * Math.pow(1 - 2.25577e-5 * z, 5.25588), es = 6.112 * Math.exp(17.67 * t / (t + 243.5));
  const rs = 0.622 * es / Math.max(1, p - es), tk = t + 273.15;
  return Math.max(3, Math.min(9.8, 9.8 * (1 + 2.501e6 * rs / (287 * tk)) / (1 + 2.501e6 * 2.501e6 * rs * 0.622 / (1004 * 287 * tk * tk))));
}

/**
 * v9: termiche dell'ora (stesse formule del tablet, Volo.java): bolla T+1 °C (+1 col sole pieno), base cumuli, plafond (cima della
 * bolla, non oltre la base), W* di Deardorff col flusso stimato dalla radiazione (35 %), B/S = 12 × (W* diviso il taglio in m/s)², vento in quota.
 */
function termicheOra(h, i, quota, sogliaQuota) {
  const t2 = h.temperature_2m[i], td2 = h.dew_point_2m[i], sw = Math.max(0, h.shortwave_radiation[i] || 0);
  const rad = d => d * Math.PI / 180;
  // Profilo: [quota, T, u, v] dal suolo in su (vento in componenti, per interpolare la direzione).
  const pr = [[quota + 10, t2, h.wind_speed_10m[i] * Math.sin(rad(h.wind_direction_10m[i])), h.wind_speed_10m[i] * Math.cos(rad(h.wind_direction_10m[i]))]];
  LIVELLI_VOLO.forEach(l => {
    const z = h['geopotential_height_' + l + 'hPa'][i], v = h['wind_speed_' + l + 'hPa'][i], d = h['wind_direction_' + l + 'hPa'][i];
    if (z > quota + 30) pr.push([z, h['temperature_' + l + 'hPa'][i], v * Math.sin(rad(d)), v * Math.cos(rad(d))]);
  });
  const ip = (z, k) => {
    if (z <= pr[0][0]) return pr[0][k];
    for (let j = 1; j < pr.length; j++) if (z <= pr[j][0]) return pr[j - 1][k] + (z - pr[j - 1][0]) / (pr[j][0] - pr[j - 1][0]) * (pr[j][k] - pr[j - 1][k]);
    return pr[pr.length - 1][k];
  };
  const tb0 = t2 + 1 + Math.min(1, sw / 600), lcl = quota + 125 * Math.max(0, tb0 - td2);
  let tb = tb0, cima = quota + 4500;
  for (let z = quota + 25; z < quota + 4500; z += 25) { tb -= (z - 25 < lcl ? 9.8 : saturaVolo(tb, z)) * 0.025; if (tb < ip(z, 1)) { cima = z; break; } }
  let plaf = Math.max(quota, Math.min(cima, lcl));
  if (sw < 50) plaf = quota;
  const zi = plaf - quota, flusso = 0.35 * sw;
  let w = zi < 150 || flusso < 20 ? 0 : Math.cbrt(9.81 / (t2 + 273.15) * flusso / 1200 * zi);
  if ((h.precipitation[i] || 0) > 0.3) w *= 0.3; else if ((h.cloud_cover_low[i] || 0) > 80) w *= 0.6;
  w = Math.min(4, w);
  const taglio = Math.hypot(ip(plaf, 2) - pr[0][2], ip(plaf, 3) - pr[0][3]) / 3.6;
  const bs = w < 0.3 ? 0 : Math.min(20, 12 * Math.pow(w / Math.max(0.5, taglio), 2));
  let vqForte = 0;
  for (const z of [1500, 2000, 2500, 3000, 3500]) {
    if (z < quota) continue;
    if (Math.hypot(ip(z, 2), ip(z, 3)) >= sogliaQuota) { vqForte = z; break; }
  }
  return { w, plaf, bs, vqForte };
}

/**
 * v10 (SPEC v10 §4): due voti su 10 al posto delle stelle, con le stesse regole del tablet (Volo.votoVolo / Volo.tranquillita).
 * Caso di prova comune (mockup 34): W* 1,4 · plafond +1.040 · vento 5 km/h su soglia 20 (calmo 5) · B/S 7 · pioggia 0,9 mm ·
 * raffiche +4 · vento forte in quota da 2.500 m → Volo buono 3 punti = 4/10, Tranquillità 4 punti = 5/10.
 */
const TRANQ_INIZIALI = {
  idealeDa: 1, idealeA: 1.5, accettabile: 2, forte: 2.5, plafond: 300, ventoPieno: 30, ventoMeta: 50, raffiche: 8, bsPieno: 7, bsMeta: 5, penalita: -2,
};
const TRANQ_NOMI = {
  idealeDa: 'Tranquillità termica ideale da (m/s)', idealeA: 'Tranquillità termica ideale a (m/s)',
  accettabile: 'Tranquillità termica accettabile fino a (m/s)', forte: 'Tranquillità termica troppo forte oltre (m/s)',
  plafond: 'Tranquillità plafond che basta (m)', ventoPieno: 'Tranquillità vento decollo pieno (%)', ventoMeta: 'Tranquillità vento decollo metà (%)',
  raffiche: 'Tranquillità raffiche tollerate (km/h)', bsPieno: 'Tranquillità B/S pieno', bsMeta: 'Tranquillità B/S metà', penalita: 'Tranquillità penalità',
};

/** Soglie della Tranquillità dai Parametri (valori iniziali se una riga manca). */
function tranqPar() {
  const t = {};
  Object.keys(TRANQ_INIZIALI).forEach(k => {
    const v = Number(String(par(TRANQ_NOMI[k]) == null ? '' : par(TRANQ_NOMI[k])).replace(',', '.'));
    t[k] = par(TRANQ_NOMI[k]) === '' || par(TRANQ_NOMI[k]) == null || isNaN(v) ? TRANQ_INIZIALI[k] : v;
  });
  t.penalita = -Math.abs(t.penalita) || -2;
  return t;
}

const dec1 = x => String(Math.round(x * 10) / 10).replace('.', ',');

/** Classe del colore di un voto (SPEC v10 §10): ≥ 6 verde · 4–5 giallo · ≤ 3 rosso · 0 / non volabile grigio. */
function coloreVoto(v) { return !v ? 'grigio' : v >= 6 ? 'verde' : v >= 4 ? 'giallo' : 'rosso'; }

/** Da punti su 8 a voto su 10; non volabile = 0, "Al limite" al massimo 2, totale negativo = 0. */
function votoDaPunti(punti, col) {
  if (col === 'rosso') return 0;
  const v = Math.max(0, Math.min(10, Math.round(Math.max(0, punti) / 8 * 10)));
  return col === 'giallo' ? Math.min(v, 2) : v;
}

/** Ore migliori: fino a 3 ore di fila nella finestra con il W* medio più alto (come v9). */
function oreMiglioriVolo(ore, col) {
  const min = col === 'verde' ? 2 : 1;
  const L = Math.max(1, Math.min(3, ore.filter(o => o.st >= min).length));
  let da = 0, meglio = -1;
  for (let k = 0; k + L <= ore.length; k++) {
    const pz = ore.slice(k, k + L);
    if (pz.some(o => o.st < min)) continue;
    const sm = pz.reduce((a, o) => a + o.w, 0);
    if (sm > meglio) { meglio = sm; da = k; }
  }
  return ore.slice(da, da + L);
}

/** Valori misurati alle ore migliori: W*, plafond sopra il decollo, B/S (medie), vento, raffiche sul medio, pioggia (massimi), vento in quota. */
function misureVolo(pz, quota) {
  const media = f => pz.reduce((a, o) => a + o[f], 0) / pz.length;
  const vq = pz.find(o => o.vqForte);
  // Arrotondati come sul tablet (W* al decimo, plafond a 10 m, B/S intero), così i voti sono gli stessi.
  const w = Math.round(media('w') * 10) / 10, plaf = Math.round(media('plaf') / 10) * 10;
  return { w, plaf, sopra: plaf - Math.max(0, quota), bs: Math.round(media('bs')), v: Math.max(...pz.map(o => o.v)),
    raf: Math.max(...pz.map(o => o.raf - o.v)), pio: Math.max(...pz.map(o => o.pio)), mm: Math.max(...pz.map(o => o.mm)),
    vq: vq ? vq.vqForte : 0, mig: pad(pz[0].ora) + '–' + pad(pz[pz.length - 1].ora + 1) };
}

/** Voto "Volo buono": i punti della v9 (fissi), mostrati su 10. Righe = [testo, punti]. */
function votoVolo(x, col, calmo, sv) {
  if (col === 'rosso' || !x) return { voto: 0, punti: 0, righe: [['nessuna finestra volabile', 0]] };
  const r = [];
  const pw = x.w >= 2 ? 3 : x.w >= 1.5 ? 2 : x.w >= 1 ? 1 : 0;
  r.push([`Termiche W* ${dec1(x.w)} m/s`, pw]);
  const pp = x.sopra >= 1500 ? 3 : x.sopra >= 1000 ? 2 : x.sopra >= 500 ? 1 : 0;
  r.push([`Plafond +${intIt(Math.max(0, x.sopra))} m sopra il decollo`, pp]);
  const fascia = x.v >= calmo && x.v <= sv * 0.6;
  r.push([`Vento decollo ${Math.round(x.v)} km/h (buono ${intIt(calmo)}–${intIt(sv * 0.6)})`, fascia ? 1 : 0]);
  r.push([`Regolarità B/S ${Math.round(x.bs)} (da 5)`, x.bs >= 5 ? 1 : 0]);
  if (x.pio >= 20 || x.mm > 0) r.push([`Pioggia ${Math.round(x.pio)} %${x.mm > 0 ? ' · ' + dec1(x.mm) + ' mm' : ''}`, -1]);
  if (x.raf >= 12) r.push([`Raffiche +${Math.round(x.raf)} km/h sul medio`, -1]);
  if (x.vq) r.push([`Vento forte in quota da ${intIt(x.vq)} m`, -1]);
  const punti = r.reduce((a, q) => a + q[1], 0);
  if (col === 'giallo') r.push(['Al limite: voto massimo 2', 0]);
  return { voto: votoDaPunti(punti, col), punti: Math.max(0, punti), righe: r };
}

/** Voto "Tranquillità" (SPEC v10 §4.2): termiche dolci, poco vento, niente rischi. tp = tranqPar(). */
function votoTranquillita(x, col, sv, tp) {
  if (col === 'rosso' || !x) return { voto: 0, punti: 0, righe: [['nessuna finestra volabile', 0]] };
  const r = [], pen = tp.penalita;
  const w = Math.round(x.w * 10) / 10; // come si vede (1,5 m/s = ideale)
  if (w > tp.forte) r.push([`Termiche troppo forti (${dec1(w)} m/s, oltre ${dec1(tp.forte)})`, -2]);
  else if (w > tp.accettabile) r.push([`Termiche forti (${dec1(w)} m/s, oltre ${dec1(tp.accettabile)})`, 0]);
  else if (w > tp.idealeA) r.push([`Termiche vivaci (${dec1(w)} m/s, fino a ${dec1(tp.accettabile)})`, 1]);
  else if (w >= tp.idealeDa) r.push([`Termiche dolci (${dec1(w)} m/s, ideale ${dec1(tp.idealeDa)}–${dec1(tp.idealeA)})`, 3]);
  else r.push([`Termiche deboli (${dec1(w)} m/s, sotto ${dec1(tp.idealeDa)})`, 2]);
  r.push([`Plafond +${intIt(Math.max(0, x.sopra))} m (basta ${intIt(tp.plafond)})`, x.sopra >= tp.plafond ? 1 : 0]);
  const pct = sv > 0 ? x.v / sv * 100 : 100;
  r.push([`Vento decollo ${Math.round(x.v)} km/h (${Math.round(pct)} % soglia)`, pct <= tp.ventoPieno ? 2 : pct <= tp.ventoMeta ? 1 : 0]);
  r.push([x.bs >= tp.bsPieno ? `Termiche regolari (B/S ${Math.round(x.bs)})` : x.bs >= tp.bsMeta ? `Termiche da gestire (B/S ${Math.round(x.bs)})` : `Termiche strappate (B/S ${Math.round(x.bs)})`,
    x.bs >= tp.bsPieno ? 2 : x.bs >= tp.bsMeta ? 1 : 0]);
  const piove = x.pio >= 20 || x.mm > 0;
  r.push([piove ? `Pioggia ${x.mm > 0 ? dec1(x.mm) + ' mm' : Math.round(x.pio) + ' %'}` : 'Pioggia no', piove ? pen : 0]);
  r.push([`Raffiche +${Math.max(0, Math.round(x.raf))} km/h (limite ${intIt(tp.raffiche)})`, x.raf >= tp.raffiche ? pen : 0]);
  r.push([x.vq ? `Vento forte in quota da ${intIt(x.vq)} m` : 'Vento in quota ok', x.vq ? pen : 0]);
  const punti = r.reduce((a, q) => a + q[1], 0);
  if (col === 'giallo') r.push(['Al limite: voto massimo 2', 0]);
  return { voto: votoDaPunti(punti, col), punti: Math.max(0, punti), righe: r };
}

/** Il perché di un voto: una riga per voce con i punti (verdi i positivi, gialli/rossi i negativi) e il totale. */
function perVotoHtml(titolo, v) {
  return `<div class="perche-voto"><div class="etichetta">${esc(titolo)} ${v.voto}/10 · perché</div>
    ${v.righe.map(q => `<div class="riga-perche"><span>${esc(q[0])}</span><strong class="${q[1] > 0 ? 'testo-verde' : q[1] < -1 ? 'testo-rosso' : q[1] < 0 ? 'testo-giallo' : ''}">${q[1] > 0 ? '+' + q[1] : q[1] < 0 ? '−' + Math.abs(q[1]) : '0'}</strong></div>`).join('')}
    <div class="riga-perche totale"><span>Totale ${v.punti} / 8 punti</span><strong>${v.voto}/10</strong></div></div>`;
}

/** Previsione Open-Meteo di un preferito (cache di un'ora, come v9). */
async function previsioneVolo(p) {
  const chiaveC = 'sivola9:' + p.lat.toFixed(3) + ',' + p.lon.toFixed(3);
  let j = LS.get(chiaveC, null);
  if (!j || Date.now() - j.alle > 3600e3) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&forecast_days=3&timezone=Europe%2FRome` +
      (p.quota ? '&elevation=' + p.quota : '') + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_850hPa,precipitation_probability,precipitation,' +
      'temperature_2m,dew_point_2m,shortwave_radiation,cloud_cover_low,' + LIVELLI_VOLO.map(l => `temperature_${l}hPa,geopotential_height_${l}hPa,wind_speed_${l}hPa,wind_direction_${l}hPa`).join(',') +
      '&daily=sunrise,sunset&wind_speed_unit=kmh';
    j = await (await fetch(url)).json();
    if (!j.hourly) throw new Error('previsione non valida');
    j.alle = Date.now();
    LS.set(chiaveC, j);
  }
  return j;
}

/**
 * Per ogni preferito e per oggi / domani / dopodomani: semaforo, finestra, ore migliori e misure (stesse soglie "Volo …"
 * della pagina FUORI). Le misure servono anche all'anteprima di "Regola tranquillità" senza riscaricare.
 */
async function calcolaVoli() {
  const pref = preferitiFuori();
  const sv = numPar('Volo vento medio max (km/h)', 25), sr = numPar('Volo raffiche max (km/h)', 30), s15 = numPar('Volo vento 1500 m max (km/h)', 30);
  const pPct = numPar('Volo pioggia %', 40), calmo = numPar('Volo vento calmo (km/h)', 5), mAlba = numPar('Volo margine alba (h)', 2), mTram = numPar('Volo margine tramonto (min)', 30);
  const pMm = numPar('Volo pioggia max (mm/h)', 0.2);
  const out = [];
  for (const p of pref) {
    const orient = {};
    p.orient.split(',').forEach(x => { const q = x.split(':'); if (q[0]) orient[q[0].trim().toUpperCase().replace('SW', 'SO').replace('NW', 'NO').replace(/^W$/, 'O')] = Number(q[1]) || 0; });
    const conOr = Object.keys(orient).length > 0;
    const voce = { p, orient: conOr ? Object.keys(orient).filter(k => orient[k]).join('/') : '', giorni: [], errore: '' };
    out.push(voce);
    let j;
    try { j = await previsioneVolo(p); } catch (e) { voce.errore = 'previsione non disponibile (serve la rete)'; continue; }
    const h = j.hourly, quota = j.elevation != null ? j.elevation : (p.quota || 0);
    for (let g = 0; g < 3; g++) {
      const alba = new Date(j.daily.sunrise[g]), tram = new Date(j.daily.sunset[g]);
      const ore = [];
      for (let i = 0; i < h.time.length; i++) {
        const t = new Date(h.time[i]);
        if (t.toDateString() !== alba.toDateString()) continue;
        if (!(t >= new Date(alba.getTime() + mAlba * 3600e3) && t <= new Date(tram.getTime() - mTram * 60e3))) continue;
        const v = h.wind_speed_10m[i], raf = h.wind_gusts_10m[i], v15 = h.wind_speed_850hPa[i], pio = h.precipitation_probability[i] || 0;
        const sett = ROSA8[Math.round(((h.wind_direction_10m[i] % 360) + 360) % 360 / 45) % 8];
        let st = v <= sv && raf <= sr && v15 <= s15 ? 2 : v <= sv * 1.2 && raf <= sr * 1.2 && v15 <= s15 * 1.2 ? 1 : 0;
        if (pio >= pPct || h.precipitation[i] >= pMm) st = 0;
        if (conOr && v > calmo) st = Math.min(st, orient[sett] === 2 ? 2 : orient[sett] === 1 ? 1 : 0);
        ore.push(Object.assign({ ora: t.getHours(), st, v: Math.round(v), raf: Math.round(raf), v15: Math.round(v15), sett, pio, mm: h.precipitation[i] || 0 },
          termicheOra(h, i, quota, s15)));
      }
      const buone = ore.filter(o => o.st === 2), limite = ore.filter(o => o.st >= 1);
      const col = buone.length >= 2 ? 'verde' : limite.length >= 2 ? 'giallo' : 'rosso';
      const fin = buone.length ? buone : limite;
      const x = col !== 'rosso' && ore.length ? misureVolo(oreMiglioriVolo(ore, col), quota) : null;
      voce.giorni.push({ g, data: alba, col, x, sv, calmo, finestra: fin.length && col !== 'rosso' ? pad(fin[0].ora) + '–' + pad(fin[fin.length - 1].ora + 1) : '' });
    }
  }
  return out;
}

function nomeGiornoVolo(d, g) {
  const t = d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' });
  return g === 0 ? 'oggi ' + t : t;
}

/** "Si vola?" (mockup 35): per ogni preferito tre righe (oggi, domani, dopodomani) con "Volo N · Tranq. N"; tocco = il perché. */
async function vistaSiVola(main) {
  const pref = preferitiFuori();
  main.innerHTML = `<div class="testata"><h1>Si vola?</h1><span class="piccolo">Open-Meteo · stima</span></div>${schedeFuori('vola')}
    <div id="sv-elenco">${pref.length ? '<p class="piccolo">Carico le previsioni…</p>' : '<p class="piccolo">Nessuna località preferita: aggiungile dalla pagina FUORI del tablet (★).</p>'}</div>
    <div class="carta piccolo" style="margin-top:12px">Tocca un voto per il perché. <a href="#/tranquillita"><strong>✎ Regola tranquillità</strong></a></div>`;
  if (!pref.length) return;
  const voli = await calcolaVoli();
  const tp = tranqPar();
  const el = $('#sv-elenco', main);
  if (!el) return;
  const perche = {};
  el.innerHTML = voli.map((vo, i) => `<div class="carta sivola" style="margin-top:10px">
      <div class="etichetta">${esc(vo.p.nome)}${vo.orient ? ' · ' + esc(vo.orient) : ''}</div>
      ${vo.errore ? `<p class="piccolo">${esc(vo.errore)}</p>` : vo.giorni.map(gg => {
        const vv = votoVolo(gg.x, gg.col, gg.calmo, gg.sv), vt = votoTranquillita(gg.x, gg.col, gg.sv, tp);
        const k = i + '-' + gg.g;
        perche[k + 'v'] = perVotoHtml('Volo buono', vv) + (gg.x ? `<p class="piccolo">finestra ${gg.finestra} · migliore ${gg.x.mig} · W* ${dec1(gg.x.w)} m/s · plafond ${intIt(gg.x.plaf)} m · B/S ${Math.round(gg.x.bs)}</p>` : '');
        perche[k + 't'] = perVotoHtml('Tranquillità', vt) + '<p class="piccolo"><a href="#/tranquillita">✎ Regola tranquillità</a></p>';
        return `<div class="riga-volo"><span>${esc(nomeGiornoVolo(gg.data, gg.g))}</span>
          ${gg.col === 'rosso' ? '<span class="piccolo">non volabile · 0 / 0</span>'
            : `<span class="pillole-voto"><button type="button" class="pillola-voto ${coloreVoto(vv.voto)}" data-perche="${k}v">Volo ${vv.voto}</button><button type="button" class="pillola-voto ${coloreVoto(vt.voto)}" data-perche="${k}t">Tranq. ${vt.voto}</button></span>`}</div>
          <div class="perche-box" data-box="${k}" hidden></div>`;
      }).join('')}</div>`).join('');
  $$('[data-perche]', el).forEach(b => {
    b.onclick = () => {
      const k = b.dataset.perche, box = $('[data-box="' + k.slice(0, -1) + '"]', el);
      const aperto = !box.hidden && box.dataset.di === k;
      $$('.perche-box', el).forEach(x => { x.hidden = true; x.dataset.di = ''; });
      $$('.pillola-voto', el).forEach(x => x.classList.remove('aperta'));
      if (aperto) return;
      box.innerHTML = perche[k];
      box.hidden = false;
      box.dataset.di = k;
      b.classList.add('aperta');
    };
  });
}

/**
 * "Regola tranquillità" (mockup 35, SPEC v10 §4.4): un cursore per ogni soglia (non si incrociano), penalità −1/−2/−3,
 * anteprima prima → dopo sui dati già scaricati, "Salva nei Parametri" (azione parametri) e "↺ valori iniziali".
 */
let regolaTranq = null;
async function vistaTranquillita(main) {
  if (!regolaTranq) regolaTranq = tranqPar();
  const t = regolaTranq, sv = numPar('Volo vento medio max (km/h)', 25);
  const cursore = (k, min, max, passo, testo, valore) => `<div class="cursore-riga"><div class="budget-testa"><span>${testo}</span><strong id="tq-v-${k}">${valore}</strong></div>
    <input type="range" data-tq="${k}" min="${min}" max="${max}" step="${passo}" value="${t[k]}" aria-label="${esc(testo)}"></div>`;
  const testi = {
    ideale: () => `${dec1(t.idealeDa)} – ${dec1(t.idealeA)} m/s`, accettabile: () => `fino a ${dec1(t.accettabile)} m/s`, forte: () => `oltre ${dec1(t.forte)} m/s`,
    plafond: () => `+${intIt(t.plafond)} m`, ventoPieno: () => `≤ ${t.ventoPieno} % soglia · ${intIt(sv * t.ventoPieno / 100)} km/h`,
    ventoMeta: () => `≤ ${t.ventoMeta} % soglia · ${intIt(sv * t.ventoMeta / 100)} km/h`, raffiche: () => `+${t.raffiche} km/h`,
    bsPieno: () => `≥ ${t.bsPieno}`, bsMeta: () => `≥ ${t.bsMeta}`,
  };
  main.innerHTML = `<div class="testata"><h1>Regola tranquillità</h1></div>${schedeFuori('vola')}
    <div class="carta regola-tranq">
      <div class="cursore-riga"><div class="budget-testa"><span>Termica ideale</span><strong id="tq-v-ideale">${testi.ideale()}</strong></div>
        <div class="doppio"><input type="range" data-tq="idealeDa" min="0.3" max="3" step="0.1" value="${t.idealeDa}" aria-label="Termica ideale da">
          <input type="range" data-tq="idealeA" min="0.3" max="3" step="0.1" value="${t.idealeA}" aria-label="Termica ideale a"></div></div>
      ${cursore('accettabile', 0.5, 3.5, 0.1, 'Termica accettabile', testi.accettabile())}
      ${cursore('forte', 1, 4, 0.1, 'Termica troppo forte (penalità)', testi.forte())}
      ${cursore('plafond', 0, 1500, 50, 'Plafond che mi basta', testi.plafond())}
      ${cursore('ventoPieno', 5, 100, 5, 'Vento al decollo (pieno punteggio)', testi.ventoPieno())}
      ${cursore('ventoMeta', 5, 100, 5, 'Vento al decollo (metà punteggio)', testi.ventoMeta())}
      ${cursore('raffiche', 2, 25, 1, 'Raffiche tollerate', testi.raffiche())}
      ${cursore('bsPieno', 1, 15, 0.5, 'Regolarità (B/S) per pieno punteggio', testi.bsPieno())}
      ${cursore('bsMeta', 1, 15, 0.5, 'Regolarità (B/S) per metà punteggio', testi.bsMeta())}
      <div class="cursore-riga"><span>Penalità pioggia · raffiche · quota</span>
        <div class="segmenti">${[-1, -2, -3].map(p => `<button type="button" data-pen="${p}" class="${t.penalita === p ? 'attivo' : ''}">−${Math.abs(p)}</button>`).join('')}</div></div>
    </div>
    <div class="carta" style="margin-top:12px"><div class="etichetta">Anteprima con questi valori</div><div id="tq-anteprima"><p class="piccolo">Carico le previsioni…</p></div></div>
    <button type="button" class="primario largo-tutto" id="tq-salva" style="margin-top:12px">Salva nei Parametri</button>
    <p style="text-align:center"><button type="button" class="piccolo-b" id="tq-iniziali">↺ valori iniziali</button></p>
    <p class="piccolo">I cursori non si incrociano. Il voto Volo buono non cambia: si regola solo la Tranquillità.</p>`;

  let voli = [];
  const prima = tranqPar();
  const anteprima = () => {
    const box = $('#tq-anteprima', main);
    if (!box) return;
    const r = [];
    voli.forEach(vo => vo.giorni.forEach(gg => {
      if (gg.col === 'rosso') return;
      const a = votoTranquillita(gg.x, gg.col, gg.sv, prima).voto, b = votoTranquillita(gg.x, gg.col, gg.sv, t).voto;
      r.push(`<div class="budget-testa riga-sottile"><span>${esc(vo.p.nome)} ${esc(nomeGiornoVolo(gg.data, gg.g))}</span>
        <span>${a} → <span class="pillola-voto ${coloreVoto(b)}">${b}</span></span></div>`);
    }));
    box.innerHTML = r.join('') || '<p class="piccolo">Nessun giorno volabile nei preferiti (oppure manca la rete).</p>';
  };
  // Vincoli: da ≤ a ≤ accettabile ≤ forte; vento pieno ≤ metà; B/S metà ≤ pieno. Chi si muove spinge gli altri.
  const vincola = k => {
    const ord = ['idealeDa', 'idealeA', 'accettabile', 'forte'];
    const i = ord.indexOf(k);
    if (i >= 0) {
      for (let j = i + 1; j < ord.length; j++) if (t[ord[j]] < t[ord[j - 1]]) t[ord[j]] = t[ord[j - 1]];
      for (let j = i - 1; j >= 0; j--) if (t[ord[j]] > t[ord[j + 1]]) t[ord[j]] = t[ord[j + 1]];
    }
    if (k === 'ventoPieno' && t.ventoMeta < t.ventoPieno) t.ventoMeta = t.ventoPieno;
    if (k === 'ventoMeta' && t.ventoPieno > t.ventoMeta) t.ventoPieno = t.ventoMeta;
    if (k === 'bsPieno' && t.bsMeta > t.bsPieno) t.bsMeta = t.bsPieno;
    if (k === 'bsMeta' && t.bsPieno < t.bsMeta) t.bsPieno = t.bsMeta;
  };
  const aggiorna = () => {
    $$('[data-tq]', main).forEach(i => { i.value = t[i.dataset.tq]; });
    Object.keys(testi).forEach(k => { const e = $('#tq-v-' + k, main); if (e) e.textContent = testi[k](); });
    $$('[data-pen]', main).forEach(b => b.classList.toggle('attivo', Number(b.dataset.pen) === t.penalita));
    anteprima();
  };
  $$('[data-tq]', main).forEach(i => { i.oninput = () => { t[i.dataset.tq] = Math.round(Number(i.value) * 10) / 10; vincola(i.dataset.tq); aggiorna(); }; });
  $$('[data-pen]', main).forEach(b => { b.onclick = () => { t.penalita = Number(b.dataset.pen); aggiorna(); }; });
  $('#tq-iniziali', main).onclick = () => { Object.assign(t, TRANQ_INIZIALI); aggiorna(); toast('Valori iniziali: si salvano con "Salva nei Parametri"'); };
  $('#tq-salva', main).onclick = async () => {
    if (!script10()) { toast(SERVE_V10); return; }
    const valori = {};
    Object.keys(TRANQ_NOMI).forEach(k => { valori[TRANQ_NOMI[k]] = t[k]; });
    await salvaParametri(valori, 'Tranquillità salvata nei Parametri');
    regolaTranq = null;
    location.hash = '#/vola';
  };
  voli = await calcolaVoli().catch(() => []);
  anteprima();
}

// ───────────────────────── v10: regole dall'app (SPEC v10 §8 Gruppi bollette, §9 Regole delle categorie) ─────────────────────────

/** Testo dei movimenti di 24 mesi con "Dettagli banca" (azione testiMovimenti), per le anteprime. Senza rete: i movimenti dell'app. */
let testiMov = null;
/** v10: le azioni nuove (parametri Tranquillità e Gruppi bollette, categorie) esistono solo dallo script versione 10. */
const SERVE_V10 = 'Serve lo script del foglio versione 10: non salvato';
function script10() { return Number(dati.versione || 0) >= 10; }
async function caricaTestiMov() {
  if (testiMov) return testiMov;
  try {
    const r = await api('testiMovimenti');
    testiMov = { righe: r.movimenti || [], completi: true };
  } catch (e) {
    testiMov = { righe: righe('Movimenti').filter(m => m.Data).map(m => ({ id: m.ID, d: m.Data, desc: m.Descrizione || '', imp: n(m['Importo (uscite negative)']), cat: (m.Categoria || '').trim(), txt: '' })),
      completi: false, errore: e.message || String(e) };
    setTimeout(() => { testiMov = null; }, 60e3); // riprova al prossimo giro
  }
  return testiMov;
}

const PAROLE_GENERICHE = ['addebito', 'pagamento', 'bonifico', 'carta', 'favore', 'presso', 'operazione', 'disposizione', 'ordine', 'della', 'delle',
  'dello', 'degli', 'spa', 'srl', 'snc', 'sas', 'via', 'corso', 'piazza', 'torino', 'italia', 'italy', 'pos', 'sdd', 'core', 'debito', 'diretto', 'rata',
  'canone', 'acquisto', 'commissione', 'commissioni', 'contabilizzato', 'attesa', 'data', 'valuta', 'mandato', 'addebiti'];

/** Parole di un testo nel formato delle bollette ("Iren S.p.A." → "iren s p a"), come testoBolletta_ dello script. */
function testoBol(s) { return ' ' + normalizza(s).replace(/[^a-z0-9\-]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '; }

/** "Gruppi bollette" → [{ nome, si: [...], no: [...] }] (stesse regole di gruppiBollette_). */
function leggiGruppiBol(valore) {
  return String(valore || '').split('|').map(g => {
    const p = g.split('=');
    if (p.length < 2) return null;
    const parole = p.slice(1).join('=').split(',').map(x => testoBol(x).trim()).filter(Boolean);
    return { nome: p[0].trim(), si: parole.filter(x => x[0] !== '-'), no: parole.filter(x => x[0] === '-').map(x => x.slice(1).trim()) };
  }).filter(g => g && g.nome);
}
function scriviGruppiBol(gruppi) {
  return gruppi.filter(g => g.nome.trim() && g.si.length).map(g => g.nome.trim().replace(/[=|,]/g, ' ') + ' = ' + g.si.concat(g.no.map(x => '-' + x)).join(', ')).join(' | ');
}
/** Primo gruppo che prende il movimento (indice) o −1. */
function gruppoDiMov(gruppi, m) {
  const t = testoBol(m.desc + ' ' + m.txt);
  const c = p => t.indexOf(' ' + p) >= 0;
  return gruppi.findIndex(g => g.si.length && g.si.some(c) && !g.no.some(c));
}
/** Parola "caratteristica" di un movimento: la più lunga, non generica, che non compare negli altri movimenti dati. */
function parolaCaratteristica(m, altri) {
  const parole = testoBol(m.desc + ' ' + m.txt).trim().split(' ').filter(w => w.length >= 4 && !/^\d+$/.test(w) && PAROLE_GENERICHE.indexOf(w) < 0);
  const testi = altri.map(a => testoBol(a.desc + ' ' + a.txt));
  const uniche = parole.filter(w => !testi.some(t => t.indexOf(' ' + w + ' ') >= 0));
  return (uniche.length ? uniche : parole).sort((a, b) => b.length - a.length)[0] || '';
}

let statoGB = null; // { gruppi, salvati } mentre si modificano i gruppi

/** Riquadro "Gruppi bollette" in fondo a Bollette: elenco nell'ordine di applicazione, parole sì/no, anteprima, Salva. */
async function disegnaGruppiBollette(box) {
  const salvati = String(par('Gruppi bollette') || '');
  if (!statoGB || statoGB.salvati !== salvati) statoGB = { gruppi: leggiGruppiBol(salvati), salvati };
  const s = statoGB, vecchi = leggiGruppiBol(salvati);
  const cambiato = scriviGruppiBol(s.gruppi) !== scriviGruppiBol(vecchi);
  const tm = await caricaTestiMov();
  if (!box.isConnected) return;
  // Anteprima: con le regole nuove quanti movimenti prende ogni gruppo e quali entrano / escono.
  const conta = s.gruppi.map(() => 0), cambi = s.gruppi.map(() => []);
  tm.righe.forEach(m => {
    const a = gruppoDiMov(vecchi, m), b = gruppoDiMov(s.gruppi, m);
    if (b >= 0) conta[b]++;
    const na = a >= 0 ? vecchi[a].nome : '', nb = b >= 0 ? s.gruppi[b].nome : '';
    if (na === nb) return;
    s.gruppi.forEach((g, i) => {
      if (g.nome === nb) cambi[i].push({ m, entra: true, da: na });
      if (g.nome === na) cambi[i].push({ m, entra: false, a: nb });
    });
    if (na && !s.gruppi.some(g => g.nome === na)) { /* gruppo tolto: i suoi movimenti li mostra il gruppo che li prende */ }
  });
  const rigaMov = (c) => `<li><span class="${c.entra ? 'entra' : 'esce'}">${c.entra ? 'entra' : 'esce'}</span>
    <span class="data-riga">${daChiave(c.m.d).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
    <div class="corpo">${esc(c.m.desc)}${c.entra ? (c.da ? ' <span class="piccolo">(da ' + esc(c.da) + ')</span>' : '') : (c.a ? ' <span class="piccolo">(→ ' + esc(c.a) + ')</span>' : ' <span class="piccolo">(→ nessun gruppo)</span>')}</div>
    <div class="num">${euro.format(Math.abs(c.m.imp))}</div></li>`;
  box.innerHTML = `<div class="carta" style="margin-top:12px" id="gruppi-bollette">
    <div class="etichetta">Gruppi bollette</div>
    <p class="piccolo" style="margin-top:0">In ordine di applicazione: il primo gruppo che prende il movimento vince. Parole cercate in descrizione e dettagli della banca.</p>
    <ul class="elenco regole">${s.gruppi.map((g, i) => `<li data-g="${i}">
      <div class="testa-regola"><span class="quadratino" style="background:${COLORI_GRUPPI[i % COLORI_GRUPPI.length]}"></span>
        <input value="${esc(g.nome)}" data-nome-g="${i}" aria-label="Nome del gruppo">
        <span class="frecce"><button type="button" data-su="${i}" ${i ? '' : 'disabled'}>↑</button><button type="button" data-giu="${i}" ${i < s.gruppi.length - 1 ? '' : 'disabled'}>↓</button></span>
        <button type="button" class="piccolo-b" data-togli-g="${i}" title="Elimina il gruppo">✕</button></div>
      <div>${g.si.map((p, k) => `<span class="chip-parola">${esc(p)}<button type="button" data-via="${i}:si:${k}">✕</button></span>`).join('')}
        <span class="aggiungi-parola"><input placeholder="parola" data-nuova="${i}:si"><button type="button" data-aggiungi="${i}:si">＋</button></span></div>
      <div>${g.no.map((p, k) => `<span class="chip-parola no">−${esc(p)}<button type="button" data-via="${i}:no:${k}">✕</button></span>`).join('')}
        <span class="aggiungi-parola"><input placeholder="esclusa" data-nuova="${i}:no"><button type="button" data-aggiungi="${i}:no">＋ esclusa</button></span></div>
      <p class="piccolo" style="margin:4px 0 0">${conta[i]} movimenti in 24 mesi${cambi[i].length ? ` · <span class="entra">${cambi[i].filter(c => c.entra).length} entrano</span> · <span class="esce">${cambi[i].filter(c => !c.entra).length} escono</span>` : ''}</p>
      ${cambi[i].length ? `<ul class="elenco anteprima-regole">${cambi[i].slice(0, 30).map(rigaMov).join('')}${cambi[i].length > 30 ? `<li class="vuoto">… altri ${cambi[i].length - 30}</li>` : ''}</ul>` : ''}
    </li>`).join('')}</ul>
    <div class="azioni"><button type="button" id="gb-nuovo">＋ nuovo gruppo</button></div>
    ${!tm.completi ? `<p class="piccolo testo-giallo">Anteprima solo sui movimenti dell'app (${esc(tm.errore || 'serve la rete')}): i dettagli della banca non ci sono.</p>` : ''}
    ${cambiato ? `<div class="azioni"><button type="button" class="primario" id="gb-salva">Salva</button><button type="button" id="gb-annulla">Annulla le modifiche</button></div>`
      : '<p class="piccolo">Nessuna modifica. Tocca un movimento nel Dettaglio per toglierlo da un gruppo o metterlo in un altro.</p>'}
  </div>`;
  const ridisegna = () => disegnaGruppiBollette(box);
  const parola = v => testoBol(v).trim();
  $$('[data-nome-g]', box).forEach(inp => { inp.onchange = () => { s.gruppi[+inp.dataset.nomeG].nome = inp.value.replace(/[=|,]/g, ' ').trim(); ridisegna(); }; });
  $$('[data-su]', box).forEach(b => { b.onclick = () => { const i = +b.dataset.su; s.gruppi.splice(i - 1, 0, s.gruppi.splice(i, 1)[0]); ridisegna(); }; });
  $$('[data-giu]', box).forEach(b => { b.onclick = () => { const i = +b.dataset.giu; s.gruppi.splice(i + 1, 0, s.gruppi.splice(i, 1)[0]); ridisegna(); }; });
  $$('[data-togli-g]', box).forEach(b => { b.onclick = () => { const i = +b.dataset.togliG; if (confirm('Eliminare il gruppo "' + s.gruppi[i].nome + '"? (si salva solo con Salva)')) { s.gruppi.splice(i, 1); ridisegna(); } }; });
  $$('[data-via]', box).forEach(b => { b.onclick = () => { const q = b.dataset.via.split(':'); s.gruppi[+q[0]][q[1]].splice(+q[2], 1); ridisegna(); }; });
  $$('[data-aggiungi]', box).forEach(b => {
    b.onclick = () => {
      const q = b.dataset.aggiungi.split(':'), inp = $('[data-nuova="' + b.dataset.aggiungi + '"]', box), p = parola(inp.value);
      if (p.length < 2) { toast('Parola troppo corta'); return; }
      const lista = s.gruppi[+q[0]][q[1]];
      if (lista.indexOf(p) < 0) lista.push(p);
      ridisegna();
    };
  });
  $$('[data-nuova]', box).forEach(inp => { inp.onkeydown = e => { if (e.key === 'Enter') $('[data-aggiungi="' + inp.dataset.nuova + '"]', box).click(); }; });
  $('#gb-nuovo', box).onclick = () => {
    const nome = (prompt('Nome del nuovo gruppo') || '').replace(/[=|,]/g, ' ').trim();
    if (!nome) return;
    const p = parola(prompt('Prima parola che lo riconosce (es. iren)') || '');
    if (!p) { toast('Serve almeno una parola'); return; }
    s.gruppi.push({ nome, si: [p], no: [] });
    ridisegna();
  };
  const sv = $('#gb-salva', box);
  if (sv) sv.onclick = async () => {
    if (!script10()) { toast(SERVE_V10); return; }
    const valore = scriviGruppiBol(s.gruppi);
    if (!valore) { toast('Serve almeno un gruppo con una parola'); return; }
    await salvaParametri({ 'Gruppi bollette': valore }, 'Gruppi bollette salvati');
    statoGB = null;
    await sincronizza(); // il riepilogo (dati.casa) si ricalcola con i gruppi nuovi
    disegna();
  };
  const an = $('#gb-annulla', box);
  if (an) an.onclick = () => { statoGB = null; ridisegna(); };
}

/**
 * Scorciatoie dal Dettaglio (tocco su un movimento): "Togli da <gruppo>" (propone una parola esclusa) o "Metti in un gruppo…"
 * (propone la parola da aggiungere). Cambiano solo i gruppi in modifica: si vede l'anteprima e si salva con "Salva".
 */
async function scorciatoiaBolletta(li, idMov, box) {
  const vecchio = $('.scorciatoia', li.parentNode);
  if (vecchio) { const era = vecchio.dataset.mov; vecchio.remove(); if (era === idMov) return; }
  const tm = await caricaTestiMov();
  const salvati = String(par('Gruppi bollette') || '');
  if (!statoGB || statoGB.salvati !== salvati) statoGB = { gruppi: leggiGruppiBol(salvati), salvati };
  const s = statoGB;
  const m = tm.righe.find(x => x.id === idMov) || { id: idMov, desc: (righe('Movimenti').find(x => x.ID === idMov) || {}).Descrizione || '', txt: '', imp: 0 };
  const gi = gruppoDiMov(s.gruppi, m);
  // "Altri" = movimenti del gruppo con un'altra descrizione (lo stesso negozio in altri mesi non conta).
  const altri = gi >= 0 ? tm.righe.filter(x => x.id !== m.id && testoBol(x.desc) !== testoBol(m.desc) && gruppoDiMov(s.gruppi, x) === gi) : [];
  const propostaNo = parolaCaratteristica(m, altri);
  const propostaSi = parolaCaratteristica(m, []);
  const div = document.createElement('li');
  div.className = 'carta scorciatoia';
  div.dataset.mov = idMov;
  div.innerHTML = `<div class="piccolo">${esc(m.desc)}</div>
    ${gi >= 0 ? `<div class="aggiungi-parola">Togli da <strong>${esc(s.gruppi[gi].nome)}</strong> con la parola esclusa
      <input value="${esc(propostaNo)}" id="sc-no"><button type="button" id="sc-togli">Togli</button></div>` : ''}
    <div class="aggiungi-parola">Metti in <select id="sc-gruppo">${s.gruppi.map((g, i) => `<option value="${i}" ${i === gi ? 'disabled' : ''}>${esc(g.nome)}</option>`).join('')}</select>
      con la parola <input value="${esc(propostaSi)}" id="sc-si"><button type="button" id="sc-metti">Metti</button></div>
    <div class="azioni"><a class="bottone" href="#/movimenti?id=${encodeURIComponent(idMov)}">Apri il movimento</a></div>`;
  li.after(div);
  const vaiAnteprima = () => { disegnaGruppiBollette(box).then(() => { const g = $('#gruppi-bollette'); if (g) g.scrollIntoView(); }); toast('Controlla l\'anteprima e premi Salva'); };
  const t = $('#sc-togli', div);
  if (t) t.onclick = () => { const p = testoBol($('#sc-no', div).value).trim(); if (p.length < 2) return; if (s.gruppi[gi].no.indexOf(p) < 0) s.gruppi[gi].no.push(p); div.remove(); vaiAnteprima(); };
  $('#sc-metti', div).onclick = () => {
    const i = Number($('#sc-gruppo', div).value), p = testoBol($('#sc-si', div).value).trim();
    if (p.length < 2 || !s.gruppi[i]) return;
    if (s.gruppi[i].si.indexOf(p) < 0) s.gruppi[i].si.push(p);
    // Se un gruppo prima nell'elenco lo prende ancora, lo si esclude lì.
    const prima = gruppoDiMov(s.gruppi, m);
    if (prima >= 0 && prima !== i) s.gruppi[prima].no.push(parolaCaratteristica(m, tm.righe.filter(x => x.id !== m.id && testoBol(x.desc) !== testoBol(m.desc) && gruppoDiMov(s.gruppi, x) === prima)));
    div.remove();
    vaiAnteprima();
  };
}

// §9 Regole delle categorie ────────────────────────────

let statoCat = null; // { cats: [{ nome, vecchio, parole, intesa }], salvate, sposta, sel }

function catDaDati() {
  return (dati.categorie || []).map(c => ({ nome: c.nome, vecchio: c.nome,
    parole: String(c.paroleChiave || '').split(',').map(x => normalizza(x)).filter(Boolean),
    intesa: String(c.intesa || '').split(';').map(x => x.trim()).filter(Boolean) }));
}
/** Categoria dalle parole chiave (regola 1 dell'import, come assegnaCategoria_): la prima con una parola trovata, o ''. */
function catDaParole(cats, m) {
  const testo = ' ' + normalizza(m.txt || m.desc);
  for (const c of cats) {
    if (c.nome === DA_ASSEGNARE) continue;
    if (c.parole.some(p => new RegExp('[^a-z]' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(testo))) return c.nome;
  }
  return '';
}

async function disegnaRegoleCategorie(box) {
  const firma = JSON.stringify(catDaDati());
  // base = regole com'erano all'apertura: l'anteprima confronta con quelle anche dopo "Salva" (poi si spuntano i movimenti).
  if (!statoCat || statoCat.salvate !== firma) statoCat = { cats: catDaDati(), salvate: firma, sposta: {}, sel: {}, base: statoCat ? statoCat.base : catDaDati() };
  const s = statoCat, vecchie = catDaDati();
  const cambiato = JSON.stringify(s.cats) !== firma;
  const tm = await caricaTestiMov();
  if (!box.isConnected) return;
  const intesaViste = [...new Set(vecchie.concat(s.cats).reduce((a, c) => a.concat(c.intesa), []))].sort();
  const usate = {};
  tm.righe.forEach(m => { usate[m.cat] = (usate[m.cat] || 0) + 1; });
  const tolte = vecchie.filter(v => !s.cats.some(c => c.vecchio === v.nome) && v.nome !== DA_ASSEGNARE);
  // Anteprima: movimenti già presenti che le parole nuove porterebbero in un'altra categoria (solo regola delle parole:
  // la categoria Intesa dei movimenti vecchi non è salvata). Cambiano solo quelli spuntati.
  const tutte = tm.righe.filter(m => m.id).map(m => ({ m, a: catDaParole(s.cats, m), prima: catDaParole(s.base, m) }))
    .filter(x => x.a && x.a !== x.m.cat);
  const proposte = tutte.filter(x => x.a !== x.prima);
  const altre = tutte.filter(x => x.a === x.prima); // le parole li davano già altrove: forse corretti a mano
  const nSel = proposte.filter(x => s.sel[x.m.id]).length;
  box.innerHTML = `<div class="carta" style="margin-top:16px" id="regole-categorie">
    <div class="etichetta">Regole delle categorie</div>
    <p class="piccolo" style="margin-top:0">In ordine: vince la prima categoria con una parola trovata; poi la categoria Intesa. Valgono subito per l'import; i movimenti già presenti cambiano solo se li spunti nell'anteprima.</p>
    <ul class="elenco regole">${s.cats.map((c, i) => `<li>
      <div class="testa-regola"><strong style="flex:1">${esc(c.nome)}</strong>
        <span class="frecce"><button type="button" data-su-c="${i}" ${i ? '' : 'disabled'}>↑</button><button type="button" data-giu-c="${i}" ${i < s.cats.length - 1 ? '' : 'disabled'}>↓</button></span>
        ${c.nome === DA_ASSEGNARE ? '' : `<button type="button" class="piccolo-b" data-togli-c="${i}" title="Elimina la categoria">✕</button>`}</div>
      ${c.nome === DA_ASSEGNARE ? '<p class="piccolo" style="margin:2px 0">quello che nessuna regola prende</p>' : `
      <div>${c.parole.map((p, k) => `<span class="chip-parola">${esc(p)}<button type="button" data-via-c="${i}:parole:${k}">✕</button></span>`).join('')}
        <span class="aggiungi-parola"><input placeholder="parola" data-nuova-c="${i}"><button type="button" data-aggiungi-c="${i}">＋</button></span></div>
      <div>${c.intesa.map((p, k) => `<span class="chip-parola intesa">${esc(p)}<button type="button" data-via-c="${i}:intesa:${k}">✕</button></span>`).join('')}
        <span class="aggiungi-parola"><select data-intesa-c="${i}"><option value="">＋ categoria Intesa…</option>${intesaViste.filter(x => c.intesa.indexOf(x) < 0).map(x => `<option>${esc(x)}</option>`).join('')}<option value="*">altra…</option></select></span></div>`}
    </li>`).join('')}</ul>
    <div class="azioni"><button type="button" id="cat-nuova">＋ nuova categoria</button></div>
    ${tolte.length ? `<div class="avviso-box">${tolte.map(t => usate[t.nome] ? `"${esc(t.nome)}" ha ${usate[t.nome]} movimenti (24 mesi): spostali in
      <select data-sposta="${esc(t.nome)}"><option value="">scegli…</option>${s.cats.map(c => `<option ${s.sposta[t.nome] === c.nome ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</select>`
      : `"${esc(t.nome)}" si elimina (nessun movimento)`).join('<br>')}</div>` : ''}
    ${!tm.completi ? `<p class="piccolo testo-giallo">Anteprima solo sui movimenti dell'app (${esc(tm.errore || 'serve la rete')}).</p>` : ''}
    ${cambiato ? '<div class="azioni"><button type="button" class="primario" id="cat-salva">Salva le regole</button><button type="button" id="cat-annulla">Annulla le modifiche</button></div>' : ''}
    <div class="etichetta" style="margin-top:14px">Anteprima · movimenti già presenti che cambierebbero (${proposte.length})</div>
    ${proposte.length ? `<div class="chips"><button type="button" class="chip chip-piccolo" id="cat-tutti">seleziona tutti</button><button type="button" class="chip chip-piccolo" id="cat-nessuno">nessuno</button></div>
      <ul class="elenco anteprima-regole">${proposte.slice(0, 200).map(x => `<li><input type="checkbox" data-sel-c="${esc(x.m.id)}" ${s.sel[x.m.id] ? 'checked' : ''} aria-label="Aggiorna">
        <span class="data-riga">${daChiave(x.m.d).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
        <div class="corpo">${esc(x.m.desc)}<div class="piccolo">${esc(x.m.cat || '—')} → <strong>${esc(x.a)}</strong></div></div>
        <div class="num">${euro.format(x.m.imp)}</div></li>`).join('')}</ul>
      <div class="azioni"><button type="button" class="primario" id="cat-aggiorna" ${nSel ? '' : 'disabled'}>Aggiorna i selezionati (${nSel})</button></div>
      ${cambiato ? '<p class="piccolo">Prima salva le regole, poi aggiorna i movimenti.</p>' : ''}`
      : '<p class="piccolo">Nessun movimento cambierebbe categoria con le parole nuove.</p>'}
    ${altre.length ? `<details style="margin-top:8px"><summary class="piccolo">Altri ${altre.length} movimenti con una categoria diversa da quella delle parole (forse corretti a mano): non si toccano</summary>
      <ul class="elenco anteprima-regole">${altre.slice(0, 100).map(x => `<li><span class="data-riga">${daChiave(x.m.d).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' })}</span>
        <div class="corpo">${esc(x.m.desc)}<div class="piccolo">${esc(x.m.cat || '—')} · le parole direbbero ${esc(x.a)}</div></div></li>`).join('')}</ul></details>` : ''}
  </div>`;
  const ridisegna = () => disegnaRegoleCategorie(box);
  $$('[data-su-c]', box).forEach(b => { b.onclick = () => { const i = +b.dataset.suC; s.cats.splice(i - 1, 0, s.cats.splice(i, 1)[0]); ridisegna(); }; });
  $$('[data-giu-c]', box).forEach(b => { b.onclick = () => { const i = +b.dataset.giuC; s.cats.splice(i + 1, 0, s.cats.splice(i, 1)[0]); ridisegna(); }; });
  $$('[data-togli-c]', box).forEach(b => { b.onclick = () => { s.cats.splice(+b.dataset.togliC, 1); ridisegna(); }; });
  $$('[data-via-c]', box).forEach(b => { b.onclick = () => { const q = b.dataset.viaC.split(':'); s.cats[+q[0]][q[1]].splice(+q[2], 1); ridisegna(); }; });
  $$('[data-aggiungi-c]', box).forEach(b => {
    b.onclick = () => {
      const i = +b.dataset.aggiungiC, p = normalizza($('[data-nuova-c="' + i + '"]', box).value).replace(/[,;]/g, ' ').trim();
      if (p.length < 3) { toast('Parola troppo corta'); return; }
      if (s.cats[i].parole.indexOf(p) < 0) s.cats[i].parole.push(p);
      ridisegna();
    };
  });
  $$('[data-nuova-c]', box).forEach(inp => { inp.onkeydown = e => { if (e.key === 'Enter') $('[data-aggiungi-c="' + inp.dataset.nuovaC + '"]', box).click(); }; });
  $$('[data-intesa-c]', box).forEach(sel => {
    sel.onchange = () => {
      let v = sel.value;
      if (v === '*') v = (prompt('Categoria Intesa (come scritta nell\'export della banca)') || '').replace(/[;,]/g, ' ').trim();
      if (v && s.cats[+sel.dataset.intesaC].intesa.indexOf(v) < 0) s.cats[+sel.dataset.intesaC].intesa.push(v);
      ridisegna();
    };
  });
  $$('[data-sposta]', box).forEach(sel => { sel.onchange = () => { s.sposta[sel.dataset.sposta] = sel.value; }; });
  $('#cat-nuova', box).onclick = () => {
    const nome = (prompt('Nome della nuova categoria') || '').trim();
    if (!nome) return;
    if (s.cats.some(c => normalizza(c.nome) === normalizza(nome))) { toast('Esiste già'); return; }
    const iDa = s.cats.findIndex(c => c.nome === DA_ASSEGNARE);
    s.cats.splice(iDa >= 0 ? iDa : s.cats.length, 0, { nome, vecchio: '', parole: [], intesa: [] });
    ridisegna();
  };
  $$('[data-sel-c]', box).forEach(cb => { cb.onchange = () => { if (cb.checked) s.sel[cb.dataset.selC] = true; else delete s.sel[cb.dataset.selC]; ridisegna(); }; });
  const tutti = $('#cat-tutti', box), nessuno = $('#cat-nessuno', box);
  if (tutti) tutti.onclick = () => { proposte.forEach(x => { s.sel[x.m.id] = true; }); ridisegna(); };
  if (nessuno) nessuno.onclick = () => { s.sel = {}; ridisegna(); };
  const an = $('#cat-annulla', box);
  if (an) an.onclick = () => { statoCat = null; ridisegna(); };
  const sv = $('#cat-salva', box);
  if (sv) sv.onclick = async () => {
    if (!script10()) { toast(SERVE_V10); return; }
    try {
      const r = await api('categorie', { categorie: s.cats, sposta: s.sposta });
      toast('Regole salvate' + (r.spostati ? ' · spostati ' + r.spostati + ' movimenti' : ''));
      await sincronizza();
      testiMov = null;
      s.salvate = JSON.stringify(catDaDati());
      s.cats = catDaDati();
      ridisegna();
    } catch (e) { toast('Non salvate: ' + (e.message || e)); }
  };
  const ag = $('#cat-aggiorna', box);
  if (ag) ag.onclick = async () => {
    if (!script10()) { toast(SERVE_V10); return; }
    if (cambiato) { toast('Prima salva le regole'); return; }
    const cambi = proposte.filter(x => s.sel[x.m.id]).map(x => ({ id: x.m.id, categoria: x.a }));
    try {
      const r = await api('ricategorizza', { cambi });
      toast('Aggiornati ' + r.aggiornati + ' movimenti');
      s.sel = {};
      testiMov = null;
      await sincronizza();
      ridisegna();
    } catch (e) { toast('Non aggiornati: ' + (e.message || e)); }
  };
}

// ── Cibo: bilancio e calorie calibrate (dati dello script: dati.fisico) ──

function cartaBilancio(soloCalorie) {
  const f = dati.fisico || {}, b = f.bilancio, c = f.calorie;
  let h = '';
  if (b && !soloCalorie) h += `<div class="carta bordo-verde" style="margin-top:12px"><div class="etichetta">⌚ Bilancio della settimana</div>
    <div class="budget-testa"><span>mangiate ${intIt(b.mangiate)} − consumate ${intIt(b.consumate)}</span>
    <strong class="${b.bilancio <= 0 ? 'testo-verde' : 'testo-giallo'}">${b.bilancio > 0 ? '+' : b.bilancio < 0 ? '−' : ''}${intIt(Math.abs(b.bilancio))} kcal</strong></div>
    <p class="piccolo">≈ ${b.kg > 0 ? '+' : b.kg < 0 ? '−' : ''}${String(Math.abs(b.kg).toFixed(2)).replace('.', ',')} kg (7.700 kcal ≈ 1 kg) · consumo dall'orologio, ${b.giorni} giorni</p></div>`;
  if (c) h += c.ok ? `<div class="carta" style="margin-top:12px"><div class="etichetta">Calorie · consumo reale</div>
      <p class="piccolo">dopo ${c.settimane} settimane di pasti, peso e orologio</p>
      <div class="griglia-3"><div><div class="piccolo">consumi davvero</div><div class="grande num">${intIt(c.reale)}</div><div class="piccolo">kcal/giorno</div></div>
        <div><div class="piccolo">l'orologio stima</div><div class="grande num">${c.orologio ? intIt(c.orologio) : '—'}</div><div class="piccolo">${c.differenza != null ? (c.differenza > 0 ? '+' : '') + c.differenza + '%' : ''}</div></div>
        <div><div class="piccolo">ritmo</div><div class="grande num">${c.ritmo > 0 ? '+' : ''}${num1.format(c.ritmo)}</div><div class="piccolo">kg/sett.</div></div></div>
      <div class="proposta">Per <strong>${c.ritmo > 0 ? '+' : ''}${num1.format(c.ritmo)} kg/sett.</strong> il piano diventa <strong>${intIt(c.proposta)}</strong> kcal/sett. (era ${intIt(c.obiettivo)})</div>
      <button type="button" class="primario" id="applica-piano">✓ applica al piano</button>
      <p class="piccolo">non cambia niente da solo: le kcal A/R/L si riscalano in proporzione</p></div>`
    : `<div class="carta" style="margin-top:12px"><div class="etichetta">Calorie · consumo reale</div>
      <p>Servono ancora <strong>${c.servono}</strong> ${c.servono === 1 ? 'settimana' : 'settimane'} di pasti e pesate (pasti in ≥ 5 giorni, peso ≥ 2 volte a settimana).</p></div>`;
  return h;
}

function collegaBilancio(main, ridisegna) {
  const b = $('#applica-piano', main);
  if (!b) return;
  b.onclick = () => {
    const c = dati.fisico.calorie, pi = piano();
    const f = c.proposta / pi.settimana;
    const valori = { 'Kcal giorno allenamento': Math.round(pi.kcal.A * f / 10) * 10, 'Kcal giorno riposo': Math.round(pi.kcal.R * f / 10) * 10, 'Kcal giorno libero': Math.round(pi.kcal.L * f / 10) * 10 };
    salvaParametri(valori, 'Piano aggiornato: ' + intIt(c.proposta) + ' kcal/settimana');
    c.obiettivo = c.proposta;
    ridisegna();
  };
}

function aggiornaBadgeFuori() {
  const a = $('#nav a[href="#/fuori"]');
  if (!a) return;
  const k = daClassificare().length;
  a.innerHTML = 'Fuori' + (k ? ` <span class="badge">${k}</span>` : '');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

disegna();
aggiornaStato();
pianificaSync(0);

/** Voce della barra in basso per una pagina (v7): le sottopagine accendono la loro sezione. */
function gruppoNav(nome) {
  if (SCHEDE_FINANZE.some(s => s[0] === nome)) return 'finanze';
  if (SCHEDE_CIBO.some(s => s[0] === nome) || nome === 'dieta') return 'cibo';
  if (SCHEDE_ALL.some(s => s[0] === nome)) return 'allenamento';
  if (SCHEDE_FUORI.some(s => s[0] === nome) || nome === 'tranquillita') return 'fuori';
  return nome;
}
