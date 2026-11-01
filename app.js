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

const SCHEDE = ['Movimenti', 'Scheda', 'Log', 'Scadenze', 'Spesa', 'Pasti', 'Peso', 'Quaderno', 'Bollette'];

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

function uscite(da, a, categoria) {
  let tot = 0;
  righe('Movimenti').forEach(m => {
    const imp = n(m['Importo (uscite negative)']);
    if (imp >= 0 || !m.Data || m.Data < da || m.Data > a) return;
    if (categoria !== undefined && (m.Categoria || '') !== categoria) return;
    tot -= imp;
  });
  return tot;
}

function calcFinanze() {
  const oggi = new Date();
  const y = oggi.getFullYear(), m = oggi.getMonth(), g = oggi.getDate();
  const giorniMese = new Date(y, m + 1, 0).getDate();
  const inizio = chiave(new Date(y, m, 1)), fine = chiave(oggi);
  const giorniPrec = new Date(y, m, 0).getDate();
  const inizioPrec = chiave(new Date(y, m - 1, 1));
  const finePrec = chiave(new Date(y, m - 1, Math.min(g, giorniPrec)));
  const speso = uscite(inizio, fine);
  const spesoPrec = uscite(inizioPrec, finePrec);
  const proiezione = speso / g * giorniMese;
  const budget = numPar('Budget mensile (€)', null);
  const soglia = numPar('Soglia di attenzione (% del budget)', 0.8);
  let stato = 'neutro';
  if (budget) stato = proiezione > budget ? 'rosso' : speso > budget * soglia ? 'giallo' : 'verde';
  const categorie = (dati.categorie || []).map(c => {
    const s = uscite(inizio, fine, c.nome);
    const sp = uscite(inizioPrec, finePrec, c.nome);
    let st = 'neutro';
    if (c.budget) st = s >= c.budget ? 'rosso' : s > c.budget * soglia ? 'giallo' : 'verde';
    return { nome: c.nome, speso: s, prec: sp, budget: c.budget, stato: st };
  });
  const senza = uscite(inizio, fine, '');
  if (senza > 0) categorie.push({ nome: 'Senza categoria', speso: senza, prec: uscite(inizioPrec, finePrec, ''), budget: null, stato: 'neutro' });
  return { speso, spesoPrec, proiezione, budget, soglia, stato, avviso: !!(budget && proiezione > budget), g, giorniMese, categorie, inizio, fine };
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
  '': vistaHome, finanze: vistaFinanze, scadenze: vistaScadenze, spesa: vistaSpesa,
  allenamento: vistaAllenamento, dieta: vistaDieta, peso: vistaPeso, impostazioni: main => vistaImpostazioni(main, false),
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
  $$('#nav a').forEach(a => a.classList.toggle('attiva', a.getAttribute('href') === '#/' + p.nome));
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

function vistaFinanze(main) {
  const f = calcFinanze();
  const mesiMedia = numPar('Mesi per la media (simulazione)', 3);
  const cat = (dati.categorie || []).map(c => c.nome);
  const recenti = righe('Movimenti').slice().sort((a, b) => (a.Data < b.Data ? 1 : -1)).slice(0, 15);
  const delta = f.speso - f.spesoPrec;
  const colore = { verde: 'testo-verde', giallo: 'testo-giallo', rosso: 'testo-rosso', neutro: '' };

  main.innerHTML = `
    <h1>Finanze</h1>
    ${f.avviso ? `<div class="avviso-box"><strong>Occhio:</strong> a questo ritmo il mese chiude a ${euro0.format(f.proiezione)}, oltre il budget di ${euro0.format(f.budget)}.</div>` : ''}
    <div class="griglia">
      <div class="carta"><div class="etichetta">Speso nel mese</div>
        <div class="grande num ${colore[f.stato]}">${euro.format(f.speso)}</div>
        <div class="riga2">${f.budget ? 'su ' + euro0.format(f.budget) + ' di budget (' + pct.format(f.speso / f.budget) + ')' : 'Budget non impostato (scheda Parametri)'}</div></div>
      <div class="carta"><div class="etichetta">Proiezione a fine mese</div>
        <div class="grande num">${euro0.format(f.proiezione)}</div>
        <div class="riga2">media ${euro.format(f.speso / f.g)} al giorno × ${f.giorniMese} giorni</div></div>
      <div class="carta"><div class="etichetta">Stesso periodo mese scorso</div>
        <div class="grande num">${euro0.format(f.spesoPrec)}</div>
        <div class="riga2 ${delta > 0 ? 'testo-rosso' : 'testo-verde'}">${delta > 0 ? '+' : ''}${euro0.format(delta)} rispetto ad allora</div></div>
    </div>

    <h2>Spesa veloce</h2>
    <form class="modulo carta" id="f-mov">
      <label class="campo">Importo (€)<input name="importo" type="number" step="0.01" min="0" inputmode="decimal" required></label>
      <label class="campo largo">Descrizione<input name="descrizione" required></label>
      <label class="campo">Categoria<select name="categoria"><option value="">Automatica</option>${cat.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
      <label class="campo">Data<input name="data" type="date" value="${oggiK()}"></label>
      <label class="campo">Tipo<select name="tipo"><option value="uscita">Uscita</option><option value="entrata">Entrata</option></select></label>
      <button class="primario" type="submit">Aggiungi</button>
    </form>

    <h2>Categorie, dall'inizio del mese</h2>
    <div class="carta tabella-scorre"><table>
      <thead><tr><th></th><th>Categoria</th><th class="n">Speso</th><th class="n">Budget</th><th class="n">Stesso periodo prima</th></tr></thead>
      <tbody>${f.categorie.map(c => `<tr>
        <td><span class="pallino ${c.stato === 'neutro' ? '' : c.stato}"></span></td>
        <td>${esc(c.nome)}</td>
        <td class="n">${euro.format(c.speso)}</td>
        <td class="n">${c.budget ? euro0.format(c.budget) : '—'}</td>
        <td class="n">${euro.format(c.prec)}</td></tr>`).join('')}</tbody>
    </table></div>

    <h2>Simulazione: se riducessi…</h2>
    <div class="carta">
      <p class="piccolo">Media mensile degli ultimi ${mesiMedia} mesi interi. Sposta i cursori per vedere quanto risparmieresti.</p>
      <div id="sim">${cat.map(c => {
        const media = mediaMensile(c, mesiMedia);
        return `<div class="slider-riga" data-media="${media}">
          <div>${esc(c)}<div class="piccolo num">${euro0.format(media)} / mese</div></div>
          <input type="range" min="0" max="100" step="5" value="0" aria-label="Riduzione ${esc(c)}">
          <div class="num" data-out>0% · ${euro0.format(0)}</div></div>`;
      }).join('')}</div>
      <p class="grande num" id="sim-tot" style="margin:14px 0 0">Risparmio: ${euro0.format(0)} al mese</p>
    </div>

    ${sezioneCasa()}

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
  $$('#sim .slider-riga').forEach(r => {
    $('input', r).oninput = () => {
      const v = Number($('input', r).value) / 100;
      $('[data-out]', r).textContent = pct.format(v) + ' · ' + euro0.format(Number(r.dataset.media) * v);
      let tot = 0;
      $$('#sim .slider-riga').forEach(x => { tot += Number(x.dataset.media) * Number($('input', x).value) / 100; });
      $('#sim-tot').textContent = 'Risparmio: ' + euro0.format(tot) + ' al mese, ' + euro0.format(tot * 12) + ' all\'anno';
    };
  });
  collegaElimina(main, 'Movimenti');
  collegaCasa(main);
}

// Casa (mutuo dai Parametri, bollette dalla scheda Bollette) ────────────────────────────

const TIPI_BOLLETTA = { Luce: 'kWh', Gas: 'Smc', Acqua: 'm³', Altro: '' };

function sezioneCasa() {
  // La scheda Bollette esiste dallo script v3 (che manda anche "casa"): prima non si può scrivere.
  if (!dati.casa) return '<h2>Casa</h2><div class="carta piccolo">Mutuo e bollette compaiono quando lo script del foglio è alla versione 3.</div>';
  const mu = dati.casa.mutuo;
  const bollette = righe('Bollette').filter(b => b.Data).sort((a, b) => (a.Data < b.Data ? 1 : -1));
  // Importi per mese (ultimi 6 mesi, per data della bolletta) e tipo.
  const oggi = new Date(), mesi = [];
  for (let i = 5; i >= 0; i--) mesi.push(chiave(new Date(oggi.getFullYear(), oggi.getMonth() - i, 1)).slice(0, 7));
  const tipi = Object.keys(TIPI_BOLLETTA).filter(t => bollette.some(b => b.Tipo === t));
  const importo = (mese, tipo) => bollette.filter(b => b.Data.slice(0, 7) === mese && (!tipo || b.Tipo === tipo)).reduce((s, b) => s + n(b['Importo (€)']), 0);
  const nomeMese = k => daChiave(k + '-01').toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
  const alGiorno = b => {
    if (!b['Periodo dal'] || !b['Periodo al'] || b.Consumo === '' || b.Consumo == null) return '—';
    const g = giorniTra(b['Periodo dal'], b['Periodo al']) + 1;
    return g > 0 ? num1.format(n(b.Consumo) / g) + ' ' + esc(b['Unità'] || TIPI_BOLLETTA[b.Tipo] || '') + '/g' : '—';
  };
  return `
    <h2>Casa</h2>
    <div class="griglia">
      <div class="carta"><div class="etichetta">Mutuo</div>
        ${mu ? `<div class="grande num">${euro.format(mu.rata)}</div>
        <div class="riga2">${mu.prossima ? 'prossima rata ' + dataBreve(mu.prossima) + ' · ' : ''}${mu.pagate}${mu.totali ? '/' + mu.totali : ''} rate pagate</div>
        ${mu.residuo != null ? `<div class="riga2">capitale residuo ${euro0.format(mu.residuo)}${mu.mancanti != null ? ' · mancano ' + mu.mancanti + ' rate' : ''}</div>` : ''}`
        : '<div class="riga2">Compila nel foglio, scheda Parametri: Mutuo rata (o capitale + tasso + rate totali) e Mutuo prima rata.</div>'}</div>
      <div class="carta"><div class="etichetta">Bollette del mese</div>
        <div class="grande num">${euro0.format(importo(mesi[5]))}</div>
        <div class="riga2">${tipi.map(t => esc(t) + ' ' + euro0.format(importo(mesi[5], t))).join(' · ') || 'nessuna bolletta registrata'}</div></div>
    </div>
    ${tipi.length ? `<div class="carta tabella-scorre"><table>
      <thead><tr><th>Mese</th>${tipi.map(t => `<th class="n">${esc(t)}</th>`).join('')}<th class="n">Totale</th></tr></thead>
      <tbody>${mesi.map(m => `<tr><td>${nomeMese(m)}</td>${tipi.map(t => `<td class="n">${importo(m, t) ? euro0.format(importo(m, t)) : '—'}</td>`).join('')}<td class="n">${euro0.format(importo(m))}</td></tr>`).join('')}</tbody>
    </table></div>` : ''}
    <h2>Nuova bolletta</h2>
    <form class="modulo carta" id="f-bol">
      <label class="campo">Tipo<select name="tipo">${Object.keys(TIPI_BOLLETTA).map(t => `<option>${t}</option>`).join('')}</select></label>
      <label class="campo">Importo (€)<input name="importo" type="number" step="0.01" min="0" inputmode="decimal" required></label>
      <label class="campo">Data<input name="data" type="date" value="${oggiK()}" required></label>
      <label class="campo">Periodo dal<input name="dal" type="date"></label>
      <label class="campo">Periodo al<input name="al" type="date"></label>
      <label class="campo">Consumo<input name="consumo" type="number" step="0.01" min="0" inputmode="decimal" placeholder="kWh / Smc / m³"></label>
      <label class="campo"><span><input name="pagata" type="checkbox"> Pagata</span></label>
      <button class="primario" type="submit">Aggiungi</button>
    </form>
    ${bollette.length ? `<ul class="elenco carta">${bollette.slice(0, 12).map(b => `<li>
      <div class="corpo"><div>${esc(b.Tipo || 'Bolletta')} · ${euro.format(n(b['Importo (€)']))}${b.Pagata === true ? '' : ' <span class="testo-giallo">da pagare</span>'}</div>
      <div class="sotto">${dataBreve(b.Data)}${b['Periodo dal'] ? ' · dal ' + dataBreve(b['Periodo dal']) + ' al ' + dataBreve(b['Periodo al']) : ''}${b.Consumo !== '' && b.Consumo != null ? ' · ' + esc(b.Consumo) + ' ' + esc(b['Unità'] || TIPI_BOLLETTA[b.Tipo] || '') + ' (' + alGiorno(b) + ')' : ''}</div></div>
      ${b.Pagata === true ? '' : `<button class="piccolo-b" data-pagata="${esc(b.ID)}">Pagata</button>`}
      <button class="piccolo-b" data-elimina-bol="${esc(b.ID)}" title="Elimina">✕</button></li>`).join('')}</ul>` : ''}`;
}

function collegaCasa(main) {
  const f = $('#f-bol', main);
  if (!f) return;
  f.onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const tipo = fd.get('tipo');
    salva('Bollette', {
      'Data': fd.get('data'), 'Tipo': tipo, 'Importo (€)': n(fd.get('importo')),
      'Periodo dal': fd.get('dal') || '', 'Periodo al': fd.get('al') || '', 'Consumo': fd.get('consumo') || '',
      'Unità': TIPI_BOLLETTA[tipo] || '', 'Pagata': fd.get('pagata') === 'on',
    });
    toast('Bolletta aggiunta');
    disegna();
  };
  $$('[data-pagata]', main).forEach(b => { b.onclick = () => { salva('Bollette', { 'Pagata': true }, b.dataset.pagata); disegna(); }; });
  $$('[data-elimina-bol]', main).forEach(b => {
    b.onclick = () => { if (confirm('Eliminare questa bolletta?')) { elimina('Bollette', b.dataset.eliminaBol); disegna(); } };
  });
}

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

function vistaAllenamento(main, query) {
  const a = calcAllenamento();
  const oggi = oggiK();
  const giornoScelto = query.get('giorno') || GIORNI[new Date().getDay()];
  const esercizi = righe('Scheda').filter(e => normalizza(e.Giorno) === normalizza(giornoScelto))
    .sort((x, y) => n(x.Ordine) - n(y.Ordine));
  const logOggi = righe('Log').filter(l => l.Data === oggi);
  const ultimoKg = nome => {
    const l = righe('Log').filter(x => normalizza(x.Esercizio) === normalizza(nome) && x['Peso (kg)'] !== '' && x['Peso (kg)'] != null)
      .sort((x, y) => (x.Data < y.Data ? 1 : -1))[0];
    return l ? l['Peso (kg)'] : '';
  };
  const giorniConScheda = GIORNI.filter(g => righe('Scheda').some(e => normalizza(e.Giorno) === normalizza(g)));

  main.innerHTML = `
    <h1>Allenamento</h1>
    <div class="griglia">
      <div class="carta"><div class="etichetta">Oggi</div><div class="grande">${esc(a.stato)}</div></div>
      <div class="carta"><div class="etichetta">Questa settimana</div><div class="grande num">${a.settimana}${a.obiettivo ? ' / ' + a.obiettivo : ''}</div></div>
    </div>
    <h2>Scheda di ${esc(giornoScelto.toLowerCase())}</h2>
    <div class="azioni">${GIORNI.slice(1).concat(GIORNI[0]).map(g => `<a class="bottone ${normalizza(g) === normalizza(giornoScelto) ? 'primario' : ''}" href="#/allenamento?giorno=${encodeURIComponent(g)}">${g.slice(0, 3)}${giorniConScheda.indexOf(g) >= 0 ? ' •' : ''}</a>`).join('')}</div>
    <ul class="elenco carta">${esercizi.length ? esercizi.map(e => {
      const fatto = logOggi.some(l => normalizza(l.Esercizio) === normalizza(e.Esercizio));
      const kg = ultimoKg(e.Esercizio) || e['Peso previsto (kg)'] || '';
      return `<li class="${fatto ? 'fatto' : ''}">
        <div class="corpo"><div>${esc(e.Esercizio)}</div><div class="sotto">${esc(e.Serie)} × ${esc(e.Ripetizioni)}${e.Note ? ' · ' + esc(e.Note) : ''}</div></div>
        <label class="campo">kg<input type="number" step="0.5" min="0" inputmode="decimal" value="${esc(kg)}" data-kg="${esc(e.ID)}" style="width:90px"></label>
        <button class="${fatto ? '' : 'primario'}" data-fatto="${esc(e.ID)}">${fatto ? 'Ancora' : 'Fatto'}</button></li>`;
    }).join('') : '<li class="vuoto">Nessun esercizio per questo giorno.</li>'}</ul>

    <h2>Aggiungi un esercizio alla scheda</h2>
    <form class="modulo carta" id="f-es">
      <label class="campo">Giorno<select name="giorno">${GIORNI.slice(1).concat(GIORNI[0]).map(g => `<option ${g === giornoScelto ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
      <label class="campo largo">Esercizio<input name="esercizio" required></label>
      <label class="campo">Serie<input name="serie" type="number" min="1" value="3"></label>
      <label class="campo">Ripetizioni<input name="rip" type="number" min="1" value="10"></label>
      <label class="campo">kg previsti<input name="kg" type="number" step="0.5" min="0"></label>
      <button class="primario" type="submit">Aggiungi</button>
    </form>
    ${bottonePenna('Log')}`;

  $$('[data-fatto]', main).forEach(b => {
    b.onclick = () => {
      const e = esercizi.find(x => x.ID === b.dataset.fatto);
      salva('Log', {
        'Data': oggi, 'Esercizio': e.Esercizio, 'Serie': e.Serie, 'Ripetizioni': e.Ripetizioni,
        'Peso (kg)': $('[data-kg="' + e.ID + '"]', main).value,
      });
      toast(e.Esercizio + ': registrato');
      disegna();
    };
  });
  $('#f-es').onsubmit = e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ord = righe('Scheda').filter(x => normalizza(x.Giorno) === normalizza(fd.get('giorno'))).length + 1;
    salva('Scheda', {
      'Giorno': fd.get('giorno'), 'Ordine': ord, 'Esercizio': fd.get('esercizio'),
      'Serie': fd.get('serie'), 'Ripetizioni': fd.get('rip'), 'Peso previsto (kg)': fd.get('kg'),
    });
    toast('Esercizio aggiunto');
    disegna();
  };
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
    <h1>Peso</h1>
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
