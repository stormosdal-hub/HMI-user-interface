#!/usr/bin/env node
'use strict';
/*
 * plcdiag-adapter.js - PLS-ens diagnosebuffer i HMI-en: hvorfor PLS-en mener noe er galt.
 *
 * TcpLink sender AT noe er galt: ERROR-dioden, og at OB82 eller OB80 har kjørt (TcpLinkDiag.scl i
 * PLS-prosjektet). HVORFOR står i PLS-ens diagnosebuffer. Den har ingen plass i TcpLink, men
 * PLS-ens web-server viser den. Denne tjenesten leser den derfra med plcdiag-web.js, og gir den til
 * huben som datasettet pls.diagbuffer. PLC diagnostics-widgeten viser det.
 *
 * Alt som avhenger av PLS-ens firmware (sidene og HTML-en), står i plcdiag-web.js. Endrer en ny
 * firmware web-sidene, er det den som må tilpasses, og bare denne tjenesten trenger en omstart:
 * linken til PLS-en og huben går som før.
 *
 * NÅR den henter, og aldri ellers (ingen fast polling):
 *   - når tjenesten starter
 *   - når linken til PLS-en kommer opp, og når den faller: CPU-en kan ha gått i STOP, og
 *     web-serveren svarer også da
 *   - når et diagnosesignal fra PLS-en endrer seg: words PLS-en har merket {led}, {ob80} eller {dec}
 *     i navnet (diodene, og tellerne og koden fra OB82 og OB80), og bits merket {alarm}.
 *     --watch velger andre
 *   - når noen trykker Refresh i widgeten
 * Flere grunner tett etter hverandre gir én henting, og det går aldri mer enn én om gangen. Signalene
 * setter i gang høyst én henting hvert 10. sekund: en syklustid som overskrides hele tiden, skal ikke
 * gi PLS-en mer å gjøre. Mislykkes en henting, prøver den igjen etter 30 s, så sjeldnere, høyst hvert
 * 5. minutt, til én lykkes: PLS-en og nettet kan bruke lenger tid enn Pi-en på å starte.
 *
 * BARE I RAM. Pi-en tar vare på opptil 500 oppføringer, også dem PLS-en har skjøvet ut (den har 50
 * plasser), til tjenesten starter på nytt. Da hentes de 50 PLS-en har, på nytt. Ingenting skrives
 * til SD-kortet.
 *
 * Bruk (install.sh setter den opp som kjoreverk@plcdiag-adapter):
 *   node adapters/plcdiag-adapter.js --plc=10.0.123.51:2000     PLS-en, som for tcplink-adapter.js; web-serveren er
 *                                                               https://10.0.123.51 (porten for TcpLink tas bort)
 *   node adapters/plcdiag-adapter.js --web=http://10.0.123.60   web-serveren på en annen adresse, eller uten kryptering
 *   node adapters/plcdiag-adapter.js --device=pls               tagprefikset: datasettet heter pls.diagbuffer, og signalene pls.*
 *   node adapters/plcdiag-adapter.js --watch=words_8,words_14   signalene som setter i gang en henting, i stedet for de merkede
 *   node adapters/plcdiag-adapter.js --name=kv_52.diag          navnet i huben (ellers kjøreverkets navn med .diag)
 *   node adapters/plcdiag-adapter.js ws://10.0.0.5:8080         en hub på en annen maskin (ellers HUB_URL eller ws://localhost:8080)
 * Uten --plc og --web, og uten --device, brukes "connect" og "device" fra
 * tcplink-options/kjoreverk-options.json, som tcplink-adapter.js gjør.
 *
 * Bare det som er innebygd i Node, pluss ws for huben. Kjører på Node 10 og nyere.
 */
const fs = require('fs');
const path = require('path');
const { vehicleName } = require('../lib/vehicle');
const web = require('./plcdiag-web');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// Tidsrom måles med en monoton klokke, så å stille maskinens klokke ikke forstyrrer dem.
const { performance } = require('perf_hooks');
const mono = () => performance.now();

const KEEP = 500;          // så mange oppføringer tar Pi-en vare på, i RAM
const MIN_GAP = 10000;     // ms mellom hentinger signalene setter i gang
const PUBLISH_MS = 300;    // under en henting: høyst ett nytt datasett så ofte
const RETRY_FIRST = 30000, RETRY_MAX = 300000;   // ms til neste forsøk etter en henting som mislyktes
const NAME_RX = /^[A-Za-z_][\w.-]*$/;
// signalene som setter i gang en henting, når --watch ikke er gitt: merket i navnet fra PLS-en
const WATCH_WORDS = ['led', 'ob80', 'dec'];   // ERROR-/MAINT-dioden, OB80s fault_id, tellerne og OB82s HW-ID og kanal
const WATCH_BITS = ['alarm'];

function run(o) {
  const WebSocket = require('ws');
  const D = o.device;
  const SET = `${D}.diagbuffer`, LINK = `${D}.link`;
  const reader = web.createReader({ url: o.web });

  // ---- bufferen: alt Pi-en har sett, med plassen oppføringen har i PLS-en nå (no; 0 = skjøvet ut)
  const entries = new Map();   // nøkkel -> { key, no, text, eventId, ms, order, incoming, long, kind }
  // reason: grunnen til siste forsøk; fetchReason: grunnen til siste som lyktes
  const st = { busy: false, again: null, error: '', reason: '', fetchedAt: 0, fetchReason: '', plcCount: 0 };

  const sorted = () => [...entries.values()].sort((a, b) =>   // nyeste først
    (a.order < b.order ? 1 : a.order > b.order ? -1 : a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

  function snapshot() {
    return {
      web: reader.url, busy: st.busy, reason: st.reason, error: st.error,
      fetchedAt: st.fetchedAt, fetchReason: st.fetchReason, plcCount: st.plcCount, kept: entries.size,
      entries: sorted().map(e => ({ key: e.key, no: e.no, eventId: e.eventId, ms: e.ms, incoming: e.incoming, text: e.text, long: e.long, kind: e.kind })),
    };
  }

  // Én henting om gangen. Ber noen om en ny mens en pågår, kjøres den etterpå.
  async function refresh(reason) {
    if (st.busy) { if (st.again === null) st.again = reason; return; }
    st.busy = true;
    st.reason = reason;
    changed(true);
    try {
      const rows = await reader.list();
      let fresh = 0;
      for (const e of entries.values()) e.no = 0;
      for (const r of rows) {
        const e = entries.get(r.key);
        if (e) { e.no = r.no; if (!e.text) e.text = r.text; }
        else { entries.set(r.key, Object.assign(r, { long: null, kind: '' })); fresh++; }
      }
      for (const e of sorted().slice(KEEP)) entries.delete(e.key);
      Object.assign(st, { plcCount: rows.length, fetchedAt: Date.now(), fetchReason: reason, error: '' });
      log(`${rows.length} entries in the PLC, ${fresh} new (${reason})`);
      clearTimeout(retryTimer);
      retryTimer = null;
      retryMs = 0;
      changed(true);                                // radene først, de lange tekstene etter hvert
      for (const e of sorted()) {
        if (!e.no || e.long !== null) continue;
        const d = await reader.details(e.key);
        e.long = d.long;
        e.kind = d.kind;
        changed();
      }
    } catch (err) {
      st.error = web.explain(err);
      retryMs = Math.min(RETRY_MAX, retryMs ? retryMs * 2 : RETRY_FIRST);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { retryTimer = null; soon('trying again', 0); }, retryMs);
      log(`couldn't read the diagnostic buffer at ${reader.url}: ${st.error} (${reason}); trying again in ${retryMs / 1000} s`);
    } finally {
      reader.finish();
    }
    st.busy = false;
    changed(true);
    if (st.again !== null) {
      const next = st.again;
      st.again = null;
      refresh(next);
    }
  }

  // Hent om litt. Flere grunner tett etter hverandre gir én henting: når ERROR-dioden begynner å
  // blinke, endres gjerne flere signaler samtidig, og oppføringen havner i bufferen et øyeblikk
  // etter signalet.
  let soonTimer = null, lastAuto = -Infinity, retryTimer = null, retryMs = 0;
  function soon(reason, ms) {
    if (soonTimer) return;
    const wait = Math.max(ms, lastAuto + MIN_GAP - mono());
    soonTimer = setTimeout(() => { soonTimer = null; lastAuto = mono(); refresh(reason); }, wait);
  }

  // ---- datasettet til huben: med en gang, eller samlet når mange endringer kommer tett
  let pubTimer = null;
  function changed(now) {
    if (now) { clearTimeout(pubTimer); pubTimer = null; publish(); return; }
    if (!pubTimer) pubTimer = setTimeout(() => { pubTimer = null; publish(); }, PUBLISH_MS);
  }
  function publish() {
    if (hubOpen) ws.send(JSON.stringify({ type: 'dataset', name: SET, data: snapshot() }));
  }

  // ---- huben som adapter: datasettet ut, Refresh fra widgeten inn
  let ws = null, hubOpen = false;
  function connectHub() {
    ws = new WebSocket(o.hub);
    ws.on('open', () => {
      hubOpen = true;
      log(`hub ${o.hub} connected as ${o.name}`);
      ws.send(JSON.stringify({ type: 'hello', role: 'adapter', name: o.name }));
      publish();
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type === 'datasetAction' && m.name === SET) {
        if (m.action === 'refresh') refresh('Refresh in the HMI');
        else log(`unknown action "${m.action}" from ${m.from}`);
      } else if (m.type === 'error') log('hub error:', m.message);
    });
    ws.on('close', () => {
      if (hubOpen) log('hub connection lost, retrying in 2 s');
      hubOpen = false;
      setTimeout(connectHub, 2000);
    });
    ws.on('error', () => {});
  }

  // ---- huben som leser: signalene som setter i gang en henting
  let watch = null, watched = new Set();
  // tag -> siste verdi. Beholdes over nye forbindelser og en hub som starter på nytt (og mangler
  // taggene en stund), så en endring mens den var borte, også teller.
  const last = new Map();
  const labelOf = new Map();
  const isWord = slot => /^words_\d+$/.test(slot), isBit = slot => /^bit\d+$/.test(slot);
  function onTags(list) {
    const want = new Set([LINK]);
    for (const t of list) {
      if (!t || typeof t.name !== 'string' || t.name.indexOf(D + '.') !== 0) continue;
      const slot = t.name.slice(D.length + 1);
      const pick = o.watch ? o.watch.indexOf(slot) >= 0
        : (isWord(slot) && WATCH_WORDS.indexOf(t.format) >= 0) || (isBit(slot) && WATCH_BITS.indexOf(t.format) >= 0);
      if (pick) { want.add(t.name); labelOf.set(t.name, t.label || slot); }
    }
    const add = [...want].filter(n => !watched.has(n)), drop = [...watched].filter(n => !want.has(n));
    if (!add.length && !drop.length) return;
    // en subscribe uten tagger betyr alt, så aldri en tom liste
    if (drop.length) watch.send(JSON.stringify({ type: 'unsubscribe', tags: drop }));
    if (add.length) watch.send(JSON.stringify({ type: 'subscribe', tags: add }));
    watched = want;
    log(`watching ${[...want].map(n => (labelOf.has(n) && labelOf.get(n) !== n.slice(D.length + 1) ? `${n} (${labelOf.get(n)})` : n)).join(', ')}`);
  }
  function onValue(tag, value) {
    if (value === null || value === undefined) return;   // en plass som ikke finnes lenger
    const had = last.has(tag), before = last.get(tag);
    last.set(tag, value);
    if (!had || before === value) return;                // første verdi: bare utgangspunktet
    if (tag === LINK) soon(value ? 'the PLC link came up' : 'the PLC link went down', value ? 1000 : 2000);
    else soon(`${labelOf.get(tag) || tag} changed`, 1500);
  }
  function connectWatch() {
    watch = new WebSocket(o.hub);
    watch.on('open', () => {
      watched = new Set();
      watch.send(JSON.stringify({ type: 'hello', role: 'hmi', name: `${o.name}-watch`, readonly: true }));
    });
    watch.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type === 'tags') onTags(m.tags || []);
      else if (m.type === 'update' && watched.has(m.tag)) onValue(m.tag, m.value);
    });
    watch.on('close', () => setTimeout(connectWatch, 2000));
    watch.on('error', () => {});
  }

  connectHub();
  connectWatch();
  lastAuto = mono();
  refresh('the service started');
}

// ================================================================ start
module.exports = { run };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flagValue = k => { const a = args.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
  const pos = args.filter(a => !a.startsWith('--'));
  // samme standard som tcplink-adapter.js: PLS-ens adresse og tagprefikset fra innstillingsfila
  let opts = {};
  const file = path.join(__dirname, 'tcplink-options', 'kjoreverk-options.json');
  try { opts = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { /* ingen fil: --plc og --device må gis */ }
  const plc = flagValue('--plc') || opts.connect || '';
  const o = {
    hub: pos.find(a => /^wss?:\/\//i.test(a)) || process.env.HUB_URL || 'ws://localhost:8080',
    device: flagValue('--device') || opts.device || 'pls',
    web: flagValue('--web') || String(plc).replace(/:\d+$/, ''),
  };
  o.name = flagValue('--name') || `${vehicleName() || o.device}.diag`;
  const w = flagValue('--watch');
  if (w !== null) o.watch = w.split(',').map(s => s.trim().replace(new RegExp('^' + o.device.replace(/\./g, '\\.') + '\\.'), '')).filter(Boolean);
  if (!NAME_RX.test(o.device)) { console.error(`--device=${o.device}: letters, digits, _ . - only`); process.exit(1); }
  if (!NAME_RX.test(o.name)) { console.error(`--name=${o.name}: letters, digits, _ . - only`); process.exit(1); }
  if (!o.web) { console.error('Set the PLC: --plc=10.0.123.51:2000 (as for tcplink-adapter.js), or the web server: --web=https://10.0.123.51'); process.exit(1); }
  try { o.web = web.baseUrl(o.web).origin; } catch (e) { console.error(`--web=${o.web}: not an address (${e.message})`); process.exit(1); }
  log(`PLC diagnostics: the diagnostic buffer at ${o.web} becomes ${o.device}.diagbuffer, named ${o.name} in the hub; ` +
      `fetched when ${o.watch ? o.watch.join(', ') : 'the marked signals'} or ${o.device}.link change`);
  run(o);
}
