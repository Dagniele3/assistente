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

const SCHEDE = ['Movimenti', 'Scheda', 'Log', 'Scadenze', 'Spesa', 'Pasti', 'Peso', 'Quaderno', 'Bollette', 'Alimenti'];

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
  if (!navigator.onLine) { statoSync.stato = 'offline'; aggiornaStato(); return; }
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
    dati = { schede: fresco.schede, categorie: fresco.categorie, parametri: fresco.parametri, casa: fresco.casa, server: fresco.server };
    coda.forEach(applicaLocale); // modifiche fatte durante l'invio
    LS.set('dati', dati);
    statoSync.ultimo = new Date().toISOString();
    LS.set('ultimoSync', statoSync.ultimo);
    statoSync.stato = 'ok';
    if (tablet && inviate.length) tablet.aggiornaWidget();
    ridisegnaSeLibero();
  } catch (e) {
    statoSync.stato = 'errore';
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

function calcScadenze() {
  const entro = numPar('Giorni per "in scadenza"', 7);
  const oggi = oggiK();
  const aperte = righe('Scadenze')
    .filter(s => s.Data && normalizza(s.Stato) !== 'chiusa')
    .map(s => Object.assign({}, s, { giorni: giorniTra(oggi, s.Data) }))
    .sort((a, b) => a.giorni - b.giorni);
  return { aperte, entro, prossima: aperte[0] || null, inScadenza: aperte.filter(s => s.giorni <= entro).length, scadute: aperte.filter(s => s.giorni < 0).length };
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
  const cat = (dati.categorie || []).map(c => c.nome);
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
    <button class="primario largo-tutto" type="button" id="vai-spesa">＋ Spesa veloce</button>
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

    <h2 id="spesa-veloce">Spesa veloce</h2>
    <form class="modulo carta" id="f-mov">
      <label class="campo">Importo (€)<input name="importo" type="number" step="0.01" min="0" inputmode="decimal" required></label>
      <label class="campo largo">Descrizione<input name="descrizione" required></label>
      <label class="campo">Categoria<select name="categoria"><option value="">Automatica</option>${cat.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
      <label class="campo">Data<input name="data" type="date" value="${oggiK()}"></label>
      <label class="campo">Tipo<select name="tipo"><option value="uscita">Uscita</option><option value="entrata">Entrata</option></select></label>
      <button class="primario" type="submit">Aggiungi</button>
    </form>

    <div class="azioni"><a class="bottone" href="#/bollette">Bollette e utenze</a><a class="bottone" href="#/mutuo">Mutuo</a></div>

    <h2>Ultimi movimenti</h2>
    <ul class="elenco carta">${recenti.length ? recenti.map(m => `<li>
      <div class="corpo"><div>${esc(m.Descrizione)}</div><div class="sotto">${dataBreve(m.Data)} · ${esc(m.Categoria || 'senza categoria')}</div></div>
      <div class="num ${n(m['Importo (uscite negative)']) > 0 ? 'testo-verde' : ''}">${euro.format(n(m['Importo (uscite negative)']))}</div>
      <button class="piccolo-b" data-elimina="${esc(m.ID)}" title="Elimina">✕</button></li>`).join('') : '<li class="vuoto">Nessun movimento. Aggiungine uno o incolla l\'esportazione della banca nel foglio.</li>'}</ul>
    ${bottonePenna('Movimenti')}`;

  $('#f-mov').onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const imp = Math.abs(n(fd.get('importo')));
    if (!imp) return;
    salva('Movimenti', {
      'Data': fd.get('data') || oggiK(), 'Descrizione': fd.get('descrizione'),
      'Importo (uscite negative)': fd.get('tipo') === 'entrata' ? imp : -imp,
      'Categoria': fd.get('categoria') || categorizzaLocale(fd.get('descrizione')),
    });
    toast('Movimento aggiunto');
    disegna();
  };
  collegaMese(main);
  $('#vai-spesa', main).onclick = () => { $('#spesa-veloce', main).scrollIntoView(); $('#f-mov input[name=importo]', main).focus(); };
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
      <button type="button" class="piccolo-b" id="sel-annulla">✕</button></div>`;

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
    sel.onchange = () => { salva('Movimenti', { 'Categoria': sel.value }, sel.dataset.catId); toast(sel.value); ridisegna(); };
  });
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

function vistaBollette(main, query) {
  const casa = dati.casa || {};
  const gruppi = casa.gruppi || [];
  if (!gruppi.length) {
    main.innerHTML = `<div class="testata"><h1>Bollette</h1></div>${schedeFinanze('bollette')}
      <div class="carta piccolo">Le bollette si ricavano dai Movimenti: compaiono quando lo script del foglio è alla versione 6.</div>`;
    return;
  }
  const scelto = (query && query.get('gruppo')) || (casa.avviso && casa.avviso.gruppo) || gruppi[0].nome;
  const g = gruppi.find(x => x.nome === scelto) || gruppi[0];
  const ig = gruppi.indexOf(g);
  const varTot = casa.totalePrec > 0 ? (casa.totale - casa.totalePrec) / casa.totalePrec : null;
  const varTxt = v => v == null ? '<span class="piccolo">—</span>' : `<span class="${v > 0 ? 'testo-giallo' : 'testo-verde'}">${v > 0 ? '+' : ''}${v}%</span>`;
  const ctr = (casa.controllo || []).filter(c => !c.errore && [g.nome].concat(g.parole || []).some(p => normalizza(p).indexOf(normalizza(c.fornitore)) >= 0));
  const mesi = casa.mesi || [];
  const lettere = mesi.slice(12).map(m => daChiave(m + '-01').toLocaleDateString('it-IT', { month: 'narrow' }));

  main.innerHTML = `
    <div class="testata"><h1>Bollette</h1><span class="piccolo">ultimi 12 mesi</span></div>
    ${schedeFinanze('bollette')}
    <div class="carta">
      <div class="etichetta">Totale utenze · ${euro0.format(casa.totale)}</div>
      <p class="piccolo" style="margin:0 0 6px">vs 12 mesi prima ${varTot == null ? '—' : varTxt(Math.round(varTot * 100))} · dai movimenti, niente da inserire</p>
      <ul class="elenco gruppi">${gruppi.map((x, i) => `<li class="toccabile ${x === g ? 'selezionato' : ''}" data-gruppo="${esc(x.nome)}">
        <span class="quadratino" style="background:${COLORI_GRUPPI[i % COLORI_GRUPPI.length]}"></span>
        <div class="corpo">${esc(x.nome)}<div class="sotto">${esc(x.frequenza || '')}${x.quota != null ? ' · ' + x.quota + '%' : ''}</div></div>
        <div class="num">${euro0.format(x.totale)} ${varTxt(x.variazione)}</div></li>`).join('')}</ul>
    </div>
    <div class="carta" style="margin-top:12px">
      <div class="etichetta">${esc(g.nome)} · mese per mese</div>
      <p class="piccolo" style="margin:0"><span class="quadratino" style="background:${COLORI_GRUPPI[ig % COLORI_GRUPPI.length]}"></span> quest'anno
        <span class="quadratino" style="background:#5a6b8c"></span> anno prima · tocca un gruppo sopra</p>
      ${graficoBollette(g.mesi || [], lettere, COLORI_GRUPPI[ig % COLORI_GRUPPI.length])}
      <div class="budget-testa"><span>Ultima bolletta</span><strong class="num ${g.scarto >= 20 ? 'testo-giallo' : ''}">${g.ultima ? euro0.format(g.ultima.importo) + ' · ' + dataBreve(g.ultima.data) : '—'}${g.scarto != null ? ' · ' + (g.scarto > 0 ? '+' : '') + g.scarto + '% vs media' : ''}</strong></div>
      <div class="budget-testa"><span>Media per bolletta</span><strong class="num">${g.media != null ? euro0.format(g.media) : '—'}</strong></div>
      <div class="budget-testa"><span>Frequenza · prossima</span><strong>${esc(g.frequenza || '—')}${g.prossima ? ' · ~' + dataBreve(g.prossima) : ''}</strong></div>
      <div class="budget-testa"><span>Mail ↔ addebito</span><strong>${ctr.length ? ctr.map(c => c.stato === 'addebitata' ? `<span class="testo-verde">✓ ${esc(c.fornitore)} ${dataBreve(c.addebito.data)}</span>`
        : `<span class="testo-giallo">${c.stato === 'ritardo' ? '⚠' : '⏳'} ${esc(c.fornitore)} ${c.stato === 'ritardo' ? 'senza addebito' : 'in attesa'}</span>`).join(' · ') : '<span class="piccolo">nessuna mail collegata</span>'}</strong></div>
    </div>
    <p class="piccolo">Gruppi e parole chiave: parametro "Gruppi bollette" nel foglio. Ogni gruppo somma i movimenti del mese (es. le due ricariche Iliad).</p>`;
  $$('[data-gruppo]', main).forEach(li => { li.onclick = () => { location.hash = '#/bollette?gruppo=' + encodeURIComponent(li.dataset.gruppo); }; });
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

const RICORRENZE = { 'Nessuna': 0, 'Mensile': 1, 'Trimestrale': 3, 'Semestrale': 6, 'Annuale': 12 };

function vistaScadenze(main, query) {
  const s = calcScadenze();
  const limite = 30;
  // Filtro per categoria (es. #/scadenze?categoria=Casa per manutenzioni e scadenze di casa).
  const filtro = (query && query.get('categoria')) || '';
  const categorie = ['Casa'].concat(s.aperte.map(x => String(x.Categoria || '').trim()).filter(Boolean))
    .filter((c, i, a) => a.findIndex(y => normalizza(y) === normalizza(c)) === i);
  const scelte = filtro ? s.aperte.filter(x => normalizza(x.Categoria) === normalizza(filtro)) : s.aperte;
  const vicine = scelte.filter(x => x.giorni <= limite);
  const lontane = scelte.filter(x => x.giorni > limite);
  const riga = x => `<li>
    <div class="corpo"><div>${esc(x.Titolo)}</div><div class="sotto">${dataBreve(x.Data)} · ${testoGiorni(x.giorni)}${x.Categoria ? ' · ' + esc(x.Categoria) : ''}${x.Ricorrenza && x.Ricorrenza !== 'Nessuna' ? ' · ' + esc(x.Ricorrenza) : ''}</div></div>
    <button class="piccolo-b" data-chiudi="${esc(x.ID)}">Fatta</button></li>`;

  main.innerHTML = `
    <h1>Scadenze</h1>
    <div class="azioni"><a class="bottone ${filtro ? '' : 'primario'}" href="#/scadenze">Tutte</a>${categorie.map(c => `<a class="bottone ${normalizza(c) === normalizza(filtro) ? 'primario' : ''}" href="#/scadenze?categoria=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}</div>
    <h2>Prossimi ${limite} giorni</h2>
    <ul class="elenco carta">${vicine.length ? vicine.map(riga).join('') : '<li class="vuoto">Niente in scadenza.</li>'}</ul>
    ${lontane.length ? `<h2>Più avanti</h2><ul class="elenco carta">${lontane.map(riga).join('')}</ul>` : ''}
    <h2>Nuova scadenza</h2>
    <form class="modulo carta" id="f-scad">
      <label class="campo largo">Cosa<input name="titolo" required></label>
      <label class="campo">Data<input name="data" type="date" value="${oggiK()}" required></label>
      <label class="campo">Categoria<input name="categoria" list="cat-scad" placeholder="es. Casa, Auto" value="${esc(filtro)}"><datalist id="cat-scad">${categorie.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="campo">Ricorrenza<select name="ricorrenza">${Object.keys(RICORRENZE).map(r => `<option>${r}</option>`).join('')}</select></label>
      <label class="campo">Preavviso (giorni)<input name="preavviso" type="number" min="0" value="${s.entro}"></label>
      <button class="primario" type="submit">Aggiungi</button>
    </form>
    ${bottonePenna('Scadenze')}`;

  $('#f-scad').onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    salva('Scadenze', {
      'Data': fd.get('data'), 'Titolo': fd.get('titolo'), 'Categoria': fd.get('categoria'),
      'Ricorrenza': fd.get('ricorrenza'), 'Giorni di preavviso': fd.get('preavviso'), 'Stato': 'Aperta',
    });
    toast('Scadenza aggiunta');
    disegna();
  };
  $$('[data-chiudi]', main).forEach(b => {
    b.onclick = () => {
      const x = s.aperte.find(y => y.ID === b.dataset.chiudi);
      salva('Scadenze', { 'Stato': 'Chiusa' }, x.ID);
      const mesi = RICORRENZE[x.Ricorrenza] || 0;
      if (mesi) {
        const d = daChiave(x.Data);
        const prossima = chiave(new Date(d.getFullYear(), d.getMonth() + mesi, d.getDate()));
        salva('Scadenze', {
          'Data': prossima, 'Titolo': x.Titolo, 'Categoria': x.Categoria || '', 'Ricorrenza': x.Ricorrenza,
          'Giorni di preavviso': x['Giorni di preavviso'] || '', 'Stato': 'Aperta',
        });
        toast('Fatta. Prossima: ' + dataBreve(prossima));
      } else toast('Fatta');
      disegna();
    };
  });
  // Dal tasto ＋ della striscia "Prossima scadenza" sul tablet: #/scadenze?nuova=1.
  if (query && query.get('nuova')) setTimeout(() => { const f = $('#f-scad', main); f.scrollIntoView(); const i = $('input', f); if (i) i.focus(); }, 0);
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
  const giornoFatto = k => log.some(l => l.Data === k);
  const cardio = k => log.some(l => l.Data === k && /corsa|bici|cammin|montagn|nuoto|cardio/i.test(l.Esercizio));
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
      <div class="budget-testa"><span>Fermo da ${fermo ? fermo.sett + ' settimane' : '—'}</span><strong class="testo-giallo">${fermo ? esc(fermo.nome) + ' ' + num1.format(fermo.kg) + ' kg' : ''}</strong></div></div>`;
  $('#pr-es', main).onchange = e => { location.hash = '#/progressi?es=' + encodeURIComponent(e.target.value); };
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
    </div>`;

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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

disegna();
aggiornaStato();
pianificaSync(0);

/** Voce della barra in basso per una pagina (v7): le sottopagine accendono la loro sezione. */
function gruppoNav(nome) {
  if (SCHEDE_FINANZE.some(s => s[0] === nome)) return 'finanze';
  if (SCHEDE_CIBO.some(s => s[0] === nome) || nome === 'dieta') return 'cibo';
  if (SCHEDE_ALL.some(s => s[0] === nome)) return 'allenamento';
  return nome;
}
