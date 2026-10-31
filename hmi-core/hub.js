#!/usr/bin/env node
'use strict';
/*
 * HMI-hub — den gjenbrukbare tag-megleren (broker).
 *
 *  - WebSocket- og JSON-protokoll for HMI-er og adaptere (se README.md)
 *  - Serverer HMI-webappen fra ./hmi over HTTP på samme port
 *  - Lagrer prosjektkonfigurasjonen (widgeter, skjermbilder, tagkoblinger) som en JSON-fil
 *  - Holder siste verdi for hver tag, de siste endringene av hver numerisk tag (også de en
 *    adapter gjenoppretter fra enheten, f.eks. PLS-ens ringbuffer), og en løpende liste over
 *    hendelser/alarmer
 *
 * Bruk:    node hub.js [port] [config-file]
 *          HMI_PORT=8080 HMI_CONFIG=./config/hmi.json node hub.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { compile, resolveVars } = require('./lib/calc');
const { vehicleName } = require('./lib/vehicle');

const PORT = Number(process.env.HMI_PORT || process.argv[2] || 8080);
const CONFIG_PATH = path.resolve(process.env.HMI_CONFIG || process.argv[3] || path.join(__dirname, 'config', 'hmi.json'));
// kjøreverkets navn (/etc/kjoreverk/vehicle): kilden for alarmene og hendelsene fra beregningene,
// som PLS-adapteren bruker det samme. Uten det er kilden beregningens tag.
const VEHICLE = vehicleName();
const HMI_DIR = path.join(__dirname, 'hmi');
// tegninger og andre prosjektfiler ligger ved siden av konfigurasjonen, så når du kopierer
// konfigurasjonsmappen, kopierer du hele prosjektet
const ASSET_DIR = path.join(path.dirname(CONFIG_PATH), 'assets');
const ASSET_NAME = /^[\w][\w.-]{0,80}\.(svg|png|jpe?g|webp|js|glb|gltf|bin)$/i;
// tekster og beskrivelser for feil- og alarmkoder, også ved siden av konfigurasjonen (se "kodetekster")
const CODES_PATH = path.join(path.dirname(CONFIG_PATH), 'codes.json');
// dine egne navn og beskrivelser for tagger, også ved siden av konfigurasjonen (se "tagnavn")
const NAMES_PATH = path.join(path.dirname(CONFIG_PATH), 'tagnames.json');

// three.js for Animation-widgeter, servert fra node_modules så det virker uten internett
let THREE_DIR = null;
try { THREE_DIR = path.dirname(require.resolve('three')); } catch { /* npm install er ikke kjørt ennå */ }
const ASSET_MAX = 20 * 1024 * 1024;
const HISTORY_LEN = Number(process.env.HMI_HISTORY || 600);   // endringer som beholdes per numerisk tag
const EVENTS_LEN = 200;

// ---------------------------------------------------------------- tilstand
const tags = new Map();     // name -> { name, dataType, unit, writable, owner, value, ts, quality }
const history = new Map();  // name -> [[ts, value], ...]
const events = [];          // løpende liste med { type:'event', ts, source, severity, message }
const clients = new Set();
const lastWriteLog = new Map();   // klient|tag -> siste loggede verdi  // { ws, role, name, subs:Set, owns:Set, alive }
let clientSeq = 0;

const now = () => Date.now();
// Tidsrom måles med en monoton klokke: å stille maskinens klokke (for eksempel fra den
// sentrale serveren etter et strømbrudd) må ikke forstyrre tidskontroller eller ratebegrensninger.
const { performance } = require('perf_hooks');
const mono = () => performance.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function send(c, msg) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

// treff på abonnement: eksakt navn, "*" for alt, "prefix.*" for en gruppe
function matches(subs, name) {
  if (subs.has('*') || subs.has(name)) return true;
  for (const s of subs) if (s.endsWith('*') && name.startsWith(s.slice(0, -1))) return true;
  return false;
}

function isOnline(ownerName) {
  for (const c of clients) if (c.role === 'adapter' && c.name === ownerName) return true;
  return false;
}

// label: navnet som vises. Ditt eget (tagnavn) går foran navnet adapteren oppga (deviceLabel,
// f.eks. navnet fra PLS-en); '' når taggen ikke har noe. ownLabel, info: ditt eget navn og din
// egen beskrivelse alene, '' når du ikke har gitt noen
function registrySnapshot() {
  return [...tags.values()].map(t => {
    const n = tagNames.get(t.name), own = n ? n.name : '';
    return { ...t, online: t.source === 'calc' ? true : isOnline(t.owner), label: own || t.deviceLabel || '', ownLabel: own, info: n ? n.info : '' };
  });
}

function broadcastToHmi(msg, tagName) {
  for (const c of clients) {
    if (c.role !== 'hmi') continue;
    if (tagName && !matches(c.subs, tagName)) continue;
    send(c, msg);
  }
}

let registryTimer = null;
function broadcastRegistry() {
  // slå sammen mange registreringer på rad til én melding
  if (registryTimer) return;
  registryTimer = setTimeout(() => {
    registryTimer = null;
    broadcastToHmi({ type: 'tags', tags: registrySnapshot() });
  }, 20);
}

function typeOf(value) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function applyUpdate(name, value, ts, quality, from) {
  if (isCalc(name)) {
    if (from) send(from, { type: 'error', message: `"${name}": names starting with calc. are reserved for calculated tags` });
    return;
  }
  let t = tags.get(name);
  if (!t) {
    // ukjente tagger registreres underveis, så adaptere kan ta det lettvint
    t = { name, dataType: typeOf(value), unit: '', writable: false, owner: from ? from.name : null };
    tags.set(name, t);
    if (from) from.owns.add(name);
    broadcastRegistry();
  }
  t.value = value;
  t.ts = ts;
  t.quality = quality || 'good';
  remember(name, ts, value);
  broadcastToHmi({ type: 'update', tag: name, value, ts, quality: t.quality }, name);
  if (t.alarm) tagAlarm(t);
  feedTime(name, value, mono());
  markCalcInput(name);
}

// ================================================================ beregnede tagger
// Definert i prosjektfilen (calcs: [...]) og regnet ut her, ikke i nettleseren:
// alle HMI-er ser samme resultat, historikk/trender virker, og de kjører uten åpen nettleser.
// Resultatene er vanlige tagger med navn calc.<name>; enheter får ikke publisere under calc.
const CALC_PREFIX = 'calc.';
const CALC_NAME = /^[A-Za-z_]\w*(\.\w+)*$/;
const isCalc = name => typeof name === 'string' && name.startsWith(CALC_PREFIX);
let calcs = new Map();            // tag -> { tag, def, raw, formula, compiled, deps, error }
let calcOrder = [];               // rekkefølge for utregning: en beregning kommer etter dem den bruker
let calcDependents = new Map();   // inngangstag -> Set(calc-tagger som leser den direkte)
let timeFeeds = new Map();        // tag -> Set(calc-oppføringer der tidsfunksjonene leser den direkte)
let projectVars = {};
const calcDirty = new Set();
let calcScheduled = false;

function loadCalcs(cfg) {
  projectVars = (cfg && cfg.vars) || {};
  indexNames();   // tagnavn kan bruke variablene
  const defs = Array.isArray(cfg && cfg.calcs) ? cfg.calcs : [];
  const next = new Map();
  for (const d of defs) {
    if (!d || typeof d !== 'object') continue;
    const short = String(d.name || '').trim();
    const tag = CALC_PREFIX + short;
    if (next.has(tag)) { next.get(tag).error = `${tag} is defined more than once`; continue; }
    const old = calcs.get(tag);
    const e = { tag, def: d, raw: String(d.formula || ''), formula: resolveVars(d.formula, projectVars), deps: [], compiled: null, error: null,
      lastTruth: old ? old.lastTruth : undefined, loggedTruth: old ? old.loggedTruth : undefined, lastEvent: old ? old.lastEvent : undefined };
    if (old && old.flushTimer) clearTimeout(old.flushTimer);
    if (!CALC_NAME.test(short)) e.error = 'the name may only use letters, digits and _ (dots between parts)';
    else {
      try { e.compiled = compile(e.formula); e.deps = e.compiled.deps; }
      catch (err) { e.error = err.message + (err.pos != null ? ` (at character ${err.pos + 1})` : ''); }
    }
    next.set(tag, e);
  }
  // andre beregninger som brukes, må finnes og må ikke danne en løkke
  for (const e of next.values()) {
    if (e.error) continue;
    const missing = e.deps.filter(dep => isCalc(dep) && !next.has(dep));
    if (missing.length) e.error = `uses ${missing.join(', ')}, which is not defined`;
  }
  const order = [], mark = new Map();
  const visit = (e, path) => {
    if (mark.get(e.tag) === 2) return;
    if (mark.get(e.tag) === 1) {
      const loop = [...path.slice(path.indexOf(e.tag)), e.tag];
      for (const t of loop) { const x = next.get(t); if (!x.error) x.error = `circular reference: ${loop.join(' \u2192 ')}`; }
      return;
    }
    mark.set(e.tag, 1);
    for (const dep of e.deps) if (next.has(dep)) visit(next.get(dep), [...path, e.tag]);
    mark.set(e.tag, 2);
    order.push(e.tag);
  };
  for (const e of next.values()) visit(e, []);

  for (const tag of calcs.keys()) if (!next.has(tag)) { tags.delete(tag); history.delete(tag); }
  calcs = next;
  calcOrder = order;
  calcDependents = new Map();
  timeFeeds = new Map();
  for (const e of calcs.values()) {
    e.timed = !!(e.compiled && e.compiled.timed);
    if (e.compiled) for (const t of e.compiled.timeTags) {
      if (!timeFeeds.has(t)) timeFeeds.set(t, new Set());
      timeFeeds.get(t).add(e);
    }
    for (const dep of e.deps) {
      if (!calcDependents.has(dep)) calcDependents.set(dep, new Set());
      calcDependents.get(dep).add(e.tag);
    }
    const prev = tags.get(e.tag) || {};
    tags.set(e.tag, {
      name: e.tag, dataType: e.def.type === 'boolean' ? 'boolean' : 'number', unit: e.def.unit || '', writable: false,
      owner: 'hub', source: 'calc', formula: e.raw, resolved: e.formula, inputs: e.deps,
      description: e.def.description || '', error: e.error, note: null, timed: e.timed,
      event: e.def.event && e.def.event.severity ? e.def.event : null,
      value: prev.value, ts: prev.ts, quality: prev.quality || 'bad',
    });
  }
  for (const tag of calcOrder) evalCalc(calcs.get(tag));
  // alarmer fra beregninger som er fjernet, eller som ikke lenger gir advarsel eller alarm
  for (const a of [...alarms.values()]) {
    if (a.kind !== 'calc') continue;
    const e = calcs.get(a.tag), ev = e && e.def.event;
    if (!ev || !ALARM_SEVERITIES.includes(ev.severity)) { alarms.delete(a.key); broadcastAlarms(); }
  }
  broadcastRegistry();
  const bad = [...calcs.values()].filter(e => e.error);
  log(`[calc] ${calcs.size} calculation(s) loaded` + (bad.length ? `, ${bad.length} with errors: ` + bad.map(e => `${e.tag}: ${e.error}`).join('; ') : ''));
}

function evalCalc(e) {
  const t = e && tags.get(e.tag);
  if (!t) return;
  let value = null, quality = 'good', note = null;
  if (e.error) quality = 'bad';
  else {
    // resultatet er bare så godt som den dårligste inngangen
    for (const dep of e.deps) {
      const it = tags.get(dep);
      if (!it || it.value === undefined || it.value === null) { quality = 'bad'; note = `waiting for ${dep}`; break; }
      if (it.quality === 'bad') quality = 'bad';
      else if (it.quality === 'uncertain' && quality === 'good') quality = 'uncertain';
    }
    // foreldede innganger: tidsfunksjonene glemmer, så hoppet når data kommer tilbake ikke tas for en ekte endring
    if (quality === 'bad' && e.timed) e.compiled.reset();
    if (!note) {
      let v;
      try { v = e.compiled.evaluate(n => tags.get(n).value, mono()); } catch { v = NaN; }
      if (e.def.type === 'boolean') value = !Number.isNaN(v) && !!v;
      else if (Number.isFinite(v)) value = +v.toPrecision(12);
      else { quality = 'bad'; note = Number.isNaN(v) ? 'result is not a number' : 'result is infinite (division by zero?)'; }
    }
  }
  if (t.note !== note) { t.note = note; broadcastRegistry(); }
  const ts = now(), m = mono();
  calcEvent(e, value, quality);
  // uendrede resultater sendes høyst én gang i sekundet, så trender likevel får ett punkt per sekund
  if (value === t.value && quality === t.quality && t.sentAt !== undefined && m - t.sentAt < 1000) return;
  t.sentAt = m;
  if (value !== t.value) feedTime(t.name, value, m);
  t.value = value;
  t.ts = ts;
  t.quality = quality;
  if (typeof value === 'number') remember(t.name, ts, value);
  broadcastToHmi({ type: 'update', tag: t.name, value, ts, quality }, t.name);
}

// Hver endring av en tag går rett til tidsfunksjonene som leser den, så ingen går tapt
// selv når flere kommer før neste utregning.
function feedTime(name, value, ts) {
  const set = timeFeeds.get(name);
  if (set) for (const e of set) e.compiled.feed(name, value, ts);
}

// En beregning med en hendelse utløser den når den blir sann (eller ulik null), og sier fra når
// den går over. Foreldede resultater teller ikke. Høyst én hendelse per beregning per sekund:
// endringer i mellomtiden holdes tilbake og slås sammen med den neste, og sluttilstanden logges alltid.
function calcEvent(e, value, quality) {
  const ev = e.def.event;
  if (!ev || !['info', 'warning', 'alarm'].includes(ev.severity) || quality === 'bad' || value === null) return;
  const truth = !!value;
  // alarmlisten følger hver endring; hendelsesloggen nedenfor begrenses til én i sekundet
  if (ALARM_SEVERITIES.includes(ev.severity)) {
    if (truth) raiseAlarm('tag:' + e.tag, { kind: 'calc', source: VEHICLE || e.tag, tag: e.tag, severity: ev.severity, text: String(ev.text || '').trim() || `${e.tag} is true` }, false);
    else clearAlarm('tag:' + e.tag, false);
  }
  if (e.lastTruth === undefined) {            // det første sikre resultatet
    e.lastTruth = truth;
    if (e.loggedTruth === undefined) e.loggedTruth = false;
    if (truth === e.loggedTruth) return;
  } else {
    if (truth === e.lastTruth) return;
    e.lastTruth = truth;
  }
  e.flips = (e.flips || 0) + 1;
  flushCalcEvent(e);
}
function flushCalcEvent(e) {
  if (e.flushTimer) return;                   // allerede planlagt
  const wait = (e.lastEvent === undefined ? -Infinity : e.lastEvent) + 1000 - mono();
  if (wait > 0) { e.flushTimer = setTimeout(() => { e.flushTimer = null; flushCalcEvent(e); }, wait); return; }
  if (e.lastTruth === e.loggedTruth) { e.flips = 0; return; }   // den gikk tilbake igjen: ingenting nytt å logge
  const ev = e.def.event;
  const text = String(ev.text || '').trim() || `${e.tag} is true`;
  const extra = Math.max(0, (e.flips || 1) - 1);
  const more = extra ? ` (${extra} more change${extra === 1 ? '' : 's'} in the second before)` : '';
  e.flips = 0;
  e.lastEvent = mono();
  e.loggedTruth = e.lastTruth;
  if (e.lastTruth) pushEvent({ source: VEHICLE || e.tag, tag: e.tag, severity: ev.severity, message: text + more });
  else pushEvent({ source: VEHICLE || e.tag, tag: e.tag, severity: 'info', message: `Cleared: ${text}${more}` });
}

// Tidsfunksjoner endrer seg med klokken selv når ingen inngang gjør det: sjekk de beregningene
// ti ganger i sekundet, og alt som avhenger av dem.
setInterval(() => {
  for (const tag of calcOrder) {
    const e = calcs.get(tag);
    if (e && e.timed) { evalCalc(e); markCalcInput(tag); }
  }
}, 100);

// Innganger endres én tag om gangen, ofte mange samtidig: samle dem og regn ut hver berørte
// beregning én gang, i avhengighetsrekkefølge.
function markCalcInput(name) {
  if (!calcDependents.has(name)) return;
  calcDirty.add(name);
  if (!calcScheduled) { calcScheduled = true; setImmediate(runCalcs); }
}
function runCalcs() {
  calcScheduled = false;
  const affected = new Set();
  const stack = [...calcDirty];
  calcDirty.clear();
  while (stack.length) {
    for (const c of calcDependents.get(stack.pop()) || []) if (!affected.has(c)) { affected.add(c); stack.push(c); }
  }
  for (const tag of calcOrder) if (affected.has(tag)) evalCalc(calcs.get(tag));
}

// Prosjektfilen: { cfg }, { missing: true } når det ikke finnes noen ennå, eller { error } når den
// finnes, men ikke kan brukes. Det siste må aldri tas for et nytt, tomt prosjekt: et trykk på
// Save ville da skrive det tomme prosjektet over den.
function readConfigFile() {
  let raw;
  try { raw = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return { error: `${CONFIG_PATH} can't be read: ${e.message}` };
  }
  try {
    const cfg = JSON.parse(raw.replace(/^﻿/, ''));   // Notepad kan lagre en BOM (byte-order mark)
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('it holds no project');
    return { cfg };
  } catch (e) {
    return { error: `${CONFIG_PATH} is not a valid project file (${e.message}). Fix it or restore a backup, then reload the HMI.` };
  }
}

// ---------------------------------------------------------------- kodetekster
// { lists: { <id>: { name, prefix, codes: { <code>: { text, info, updated } } } } }
// En egen fil i stedet for en del av prosjektet: en beskrivelse kan legges til i Run-modus
// uten å lagre layouten, og hver endring legges på det som ligger på disken, så to personer
// som redigerer forskjellige koder, ikke skriver over hverandre.
const CODE_ID = /^[\w-]{1,64}$/;
const RESERVED_KEY = k => k === '__proto__' || k === 'constructor' || k === 'prototype';
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function readCodes() {
  let raw;
  try { raw = fs.readFileSync(CODES_PATH, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { codes: { lists: {} } };   // ingen ennå
    return { codes: { lists: {} }, error: `${CODES_PATH} can't be read: ${e.message}` };
  }
  try {
    const codes = JSON.parse(raw.replace(/^﻿/, ''));   // Notepad kan lagre en BOM (byte-order mark)
    if (!codes || typeof codes.lists !== 'object' || !codes.lists) throw new Error('it has no "lists"');
    return { codes };
  } catch (e) {
    // skriv aldri over en fil vi ikke fikk lest: den kan inneholde notater fra flere år
    return { codes: { lists: {} }, error: `${CODES_PATH} is not valid (${e.message}). Fix or move it; until then code texts can't be saved.` };
  }
}

function writeCodes(codes) {
  const tmp = CODES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(codes, null, 2));
  fs.renameSync(tmp, CODES_PATH);   // alt eller ingenting, selv om strømmen går midt i skrivingen
}

// changes: [{ list, set: { name, prefix } }   opprett en liste eller gi den nytt navn
//           { list, remove: true }             slett en liste
//           { list, code, set: { text, info } } legg til eller endre én kode (begge tomme fjerner den)
//           { list, code, remove: true }]      slett én kode
// Alle eller ingen: den første ugyldige endringen kaster en feil før noe blir skrevet.
function applyCodeChanges(codes, changes) {
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  for (const ch of changes) {
    const id = ch && String(ch.list);
    if (!ch || !CODE_ID.test(id) || RESERVED_KEY(id)) throw new Error(`invalid list id "${ch && ch.list}"`);
    if (ch.code === undefined) {
      if (ch.remove) { delete codes.lists[id]; continue; }
      if (!own(codes.lists, id)) codes.lists[id] = { name: id, prefix: '', codes: {} };
      const l = codes.lists[id], s = ch.set || {};
      if (s.name !== undefined) l.name = str(s.name, 80).trim() || id;
      if (s.prefix !== undefined) l.prefix = str(s.prefix, 8).trim();
      if (!l.codes || typeof l.codes !== 'object') l.codes = {};
      continue;
    }
    if (!own(codes.lists, id)) throw new Error(`there is no list "${id}"`);
    const l = codes.lists[id];
    const code = str(ch.code, 64).trim();
    if (!code || RESERVED_KEY(code)) throw new Error(`invalid code "${ch.code}"`);
    if (ch.remove) { delete l.codes[code]; continue; }
    const e = Object.assign({}, own(l.codes, code) ? l.codes[code] : {});
    const s = ch.set || {};
    if (s.text !== undefined) e.text = str(s.text, 200).trim();
    if (s.info !== undefined) e.info = str(s.info, 20000).replace(/\s+$/, '');
    e.updated = now();
    if (!e.text && !e.info) delete l.codes[code]; else l.codes[code] = e;
  }
}

// ---------------------------------------------------------------- tagnavn
// { tags: { "${kv}.bit05": { name: "Dør lukket", info: "Endebryter B12, venstre dør", updated } } }
// Ditt eget navn og din egen beskrivelse for en tag, i stedet for en endring i PLS-programmet:
// taggen beholder navnet sitt, så skjermbilder, regler og lagret historikk forblir som de er, og
// HMI-en viser ditt. En egen fil ved siden av prosjektet,
// som kodetekstene. Et navn lagret for pls.bit05 mens prosjektvariabelen kv = pls, lagres som
// ${kv}.bit05, så det følger variabelen: en enhet med kv = pls2 får de samme navnene.
let tagNames = new Map();   // tag (variabler satt inn) -> { name, info, key }

function readNames() {
  let raw;
  try { raw = fs.readFileSync(NAMES_PATH, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { names: { tags: {} } };   // ingen ennå
    return { names: { tags: {} }, error: `${NAMES_PATH} can't be read: ${e.message}` };
  }
  try {
    const names = JSON.parse(raw.replace(/^﻿/, ''));   // Notepad kan lagre en BOM (byte-order mark)
    if (!names || typeof names.tags !== 'object' || !names.tags || Array.isArray(names.tags)) throw new Error('it has no "tags"');
    return { names };
  } catch (e) {
    // skriv aldri over en fil vi ikke fikk lest
    return { names: { tags: {} }, error: `${NAMES_PATH} is not valid (${e.message}). Fix or move it; until then tag names can't be saved.` };
  }
}

function writeNames(names) {
  const tmp = NAMES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(names, null, 2));
  fs.renameSync(tmp, NAMES_PATH);   // alt eller ingenting
}

// navnene per tag, med variablene satt inn. Et navn skrevet helt ut vinner over et med variabel.
function indexNames() {
  const rn = readNames();
  if (rn.error) log(`[names] WARNING ${rn.error}`);
  const keys = Object.keys(rn.names.tags).sort((a, b) => (b.indexOf('${') >= 0) - (a.indexOf('${') >= 0));
  const next = new Map();
  for (const key of keys) {
    const e = rn.names.tags[key];
    if (!e || typeof e !== 'object') continue;
    next.set(resolveVars(key, projectVars), { name: String(e.name || ''), info: String(e.info || ''), key });
  }
  tagNames = next;
}

// pls.bit05 -> ${kv}.bit05 når en prosjektvariabel angir enheten
function namesKey(tag) {
  for (const k of Object.keys(projectVars)) {
    const v = projectVars[k];
    if (v && tag.indexOf(v + '.') === 0) return '${' + k + '}' + tag.slice(String(v).length);
  }
  return tag;
}

// changes: [{ tag, name, info }], taggen slik HMI-en viser den; tomt navn og tom beskrivelse
// fjerner den. Alle eller ingen: den første ugyldige endringen kaster en feil før noe blir skrevet.
function applyNameChanges(names, changes) {
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  for (const ch of changes) {
    const tag = ch ? String(ch.tag == null ? '' : ch.tag).trim() : '';
    if (!tag || tag.length > 200 || /\s/.test(tag) || RESERVED_KEY(tag)) throw new Error(`invalid tag name "${ch && ch.tag}"`);
    // én oppføring per tag: en annen nøkkel som betyr samme tag, fjernes
    for (const k of Object.keys(names.tags)) if (resolveVars(k, projectVars) === tag) delete names.tags[k];
    const name = str(ch.name, 80), info = str(ch.info, 2000);
    if (name || info) names.tags[namesKey(tag)] = { name, info, updated: now() };
  }
}

// en endring gjort for hånd i filen tas også i bruk innen noen sekunder
fs.watchFile(NAMES_PATH, { interval: 2000 }, (cur, prev) => {
  if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) { indexNames(); broadcastRegistry(); }
});

// ---------------------------------------------------------------- historikk for trender
// Tall, og boolske verdier som 1 og 0, så en trend kan vise en bit også. Bare endringer lagres:
// trendene tegner trinn, så en verdi som er lik den forrige, sier ingenting nytt, og en tag som
// sjelden endres, beholder lang historikk innenfor HISTORY_LEN punkter.
function remember(name, ts, value) {
  const v = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  if (typeof v !== 'number' || !Number.isFinite(v)) return;
  let h = history.get(name);
  if (!h) history.set(name, (h = []));
  const last = h[h.length - 1];
  if (last && last[1] === v) return;
  h.push([ts, v]);
  if (h.length > HISTORY_LEN) h.splice(0, h.length - HISTORY_LEN);
}

// Eldre punkter en adapter har fått fra enheten selv, for eksempel PLS-ens retentive ringbuffer
// (tcplink-adapter.js): { type: 'restore', origin, series: { tag: [[ts, value, ref?], ...] } }.
// Etter et strømbrudd eller et brudd på linken er de tilbake i trendene.
//   ref    valgfri: hvilken post i enheten punktet kommer fra (TcpLink: løpenummer og PLS-tid).
//          En ref huben har fått før, hoppes over, så en adapter som starter på nytt og sender
//          alt igjen, ikke gir dobbelpunkter. Punkter med samme ref (et word og bitene i det)
//          telles som én endring i hendelsesloggen.
// Hvert punkt settes inn på sin plass i tid:
//   - samme verdi som punktet før: sier ingenting nytt, hoppes over.
//   - samme verdi som punktet etter: det punktet er den samme endringen, sett senere (huben fikk
//     den direkte, eller først da linken kom tilbake). Det tas bort, og endringen står på
//     enhetens eget tidspunkt.
// Ikke nye: de som bare flyttet en endring huben allerede hadde, høyst 2 s. Er noe nytt, sier
// hendelsesloggen fra (origin: hvor de kom fra), og HMI-ene får punktene (`restored`), så åpne
// trender kan hente tidsrommet på nytt.
const restoredRefs = new Map();   // adapter -> Set(ref), de siste REFS_MAX
const REFS_MAX = 20000;
function restoreHistory(c, series, origin) {
  const added = {}, items = new Set(), t0 = now();
  const seen = restoredRefs.get(c.name) || new Set(), fresh = new Set();
  let n = 0, refused = 0;
  for (const [name, pts] of Object.entries(series && typeof series === 'object' ? series : {})) {
    const t = tags.get(name);
    if (!t || t.owner !== c.name || !Array.isArray(pts)) { refused++; continue; }   // bare egne tagger
    let h = history.get(name);
    if (!h) history.set(name, (h = []));
    const list = pts.filter(p => Array.isArray(p) && Number.isFinite(Number(p[0])))
      .map(p => [Math.min(Number(p[0]), t0), typeof p[1] === 'boolean' ? (p[1] ? 1 : 0) : p[1], p[2]])
      .filter(p => typeof p[1] === 'number' && Number.isFinite(p[1]))
      .sort((a, b) => a[0] - b[0]);
    for (const [ts, v, ref] of list) {
      const id = ref == null ? null : String(ref).slice(0, 64);
      if (id !== null) { if (seen.has(id)) continue; fresh.add(id); }
      const p = [ts, v];
      let i = h.length;
      while (i > 0 && h[i - 1][0] > p[0]) i--;
      if (i > 0 && h[i - 1][1] === p[1]) continue;
      const next = h[i];
      h.splice(i, 0, p);
      if (next && next[1] === p[1]) {
        h.splice(i + 1, 1);
        if (next[0] - p[0] <= 2000) continue;
      }
      (added[name] = added[name] || []).push(p);
      items.add(id !== null ? 'r' + id : 'p' + n);
      n++;
    }
    if (h.length > HISTORY_LEN) h.splice(0, h.length - HISTORY_LEN);
  }
  for (const id of fresh) seen.add(id);
  for (const id of seen) { if (seen.size <= REFS_MAX) break; seen.delete(id); }   // de eldste først
  restoredRefs.set(c.name, seen);
  if (refused) log(`[restore] ${c.name}: ${refused} series skipped (unknown tag, or one ${c.name} doesn't own)`);
  if (!n) return;
  let from = Infinity, to = -Infinity;
  for (const pts of Object.values(added)) for (const p of pts) { from = Math.min(from, p[0]); to = Math.max(to, p[0]); }
  log(`[restore] ${c.name}: ${n} point${n === 1 ? '' : 's'} for ${Object.keys(added).length} tag${Object.keys(added).length === 1 ? '' : 's'}`);
  const k = items.size;
  pushEvent({ source: c.name, severity: 'info', message: `Restored ${k} change${k === 1 ? '' : 's'} from ${String(origin || 'the device').slice(0, 80)} (${clockText(from)} to ${clockText(to)})` });
  for (const o of clients) {
    if (o.role !== 'hmi') continue;
    const mine = {};
    for (const name of Object.keys(added)) if (matches(o.subs, name)) mine[name] = added[name];
    if (Object.keys(mine).length) send(o, { type: 'restored', series: mine });
  }
}

// 2026-10-26 09:12:03, i denne maskinens lokaltid
function clockText(ms) {
  const d = new Date(ms), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const HUB_START = now();
const pendingQueries = new Map();   // spørrings-id -> { reply, timer }, mens historikktjenesten jobber med den
let querySeq = 0;
// Minnet rekker langt nok tilbake når hver tags historikk starter før `from`, eller ikke har
// gått full og huben startet før `from` (en tag som sjelden endres, har få punkter).
function memoryCovers(q) {
  return q.tags.every(name => {
    const h = history.get(name);
    if (h && h.length >= HISTORY_LEN) return h[0][0] <= q.from;
    return HUB_START <= q.from;
  });
}
// punktene i tidsrommet, med siste verdi før det først; tynnet ut til høyst `points`
function fromMemory(q) {
  const series = {};
  for (const name of q.tags) {
    const h = history.get(name) || [];
    let i = 0;
    while (i < h.length && h[i][0] < q.from) i++;
    const pts = i > 0 ? [[q.from, h[i - 1][1]]] : [];
    for (; i < h.length && h[i][0] <= q.to; i++) pts.push(h[i]);
    series[name] = thin(pts, q.from, q.to, q.points);
  }
  return series;
}
// høyst omtrent `n` tidsluker (buckets), hver lagret som sin laveste og høyeste verdi
function thin(pts, from, to, n) {
  if (pts.length <= n * 2) return pts;
  const bucket = Math.max(1, Math.ceil((to - from) / n));
  const out = [];
  let b = -1, lo = null, hi = null;
  const put = () => { if (lo === null) return; const t = from + b * bucket; if (lo[1] === hi[1]) out.push(lo); else out.push([t + bucket * 0.25, Math.min(lo[1], hi[1])], [t + bucket * 0.75, Math.max(lo[1], hi[1])]); };
  for (const p of pts) {
    const k = Math.floor((p[0] - from) / bucket);
    if (k !== b) { put(); b = k; lo = hi = p; continue; }
    if (p[1] < lo[1]) lo = p;
    if (p[1] > hi[1]) hi = p;
  }
  put();
  return out;
}

// ---------------------------------------------------------------- aktive alarmer
// En alarm er en betingelse som er på eller av. Den kommer fra:
//   tag    en tag som en adapter registrerte med  alarm: { severity, text, when, delay, codes }
//          (tcplink-adapter: "event": "warning" eller "alarm" under "tags" i innstillingsfilen)
//   calc   en beregning der hendelsen er en advarsel eller en alarm
//   link   en adapter som koblet fra, til den kobler til igjen
//   event  en advarsel eller alarmhendelse uten betingelse bak: står i listen til den er kvittert
// Som i ISA-18.2 står en alarm i listen til den både har gått over og er kvittert. Tag- og
// calc-alarmer følger verdiene, så etter en omstart eller ny tilkobling bygger listen seg opp
// igjen fra verdiene slik de er. Kvitteringer holdes bare i minnet.
const alarms = new Map();        // key -> { key, kind, source, tag, severity, text, value, codes,
                                 //          active, acked, since, ts, clearedAt, ackedAt, ackedBy, count }
const alarmDelays = new Map();   // key -> timer, for alarmer som må stå en stund først
const ALARM_SEVERITIES = ['warning', 'alarm'];
const ALARMS_MAX = 500;
const truthy = v => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '' && v !== '0' && v !== 'false');

let alarmTimer = null;
function broadcastAlarms() {
  if (alarmTimer) return;
  alarmTimer = setTimeout(() => { alarmTimer = null; broadcastToHmi({ type: 'alarms', alarms: [...alarms.values()] }); }, 30);
}

// log: skriv den også til hendelsesloggen (beregninger og hendelser logger seg selv)
function raiseAlarm(key, info, log) {
  let a = alarms.get(key);
  if (a && a.active && a.text === info.text && a.severity === info.severity) return;   // ingenting nytt
  if (!a) { a = { key, count: 0 }; alarms.set(key, a); trimAlarms(); }
  Object.assign(a, info, { active: true, acked: false, since: now(), ts: now(), clearedAt: null });
  a.count++;
  if (log) pushEvent({ source: a.source, tag: a.tag, severity: a.severity, message: a.text });
  broadcastAlarms();
}
function clearAlarm(key, log) {
  const pending = alarmDelays.get(key);
  if (pending) { clearTimeout(pending); alarmDelays.delete(key); }
  const a = alarms.get(key);
  if (!a || !a.active) return;
  a.active = false;
  a.clearedAt = a.ts = now();
  if (log) pushEvent({ source: a.source, tag: a.tag, severity: 'info', message: `Cleared: ${a.text}` });
  if (a.acked) alarms.delete(key);   // gått over og kvittert: tilbake til normal
  broadcastAlarms();
}
function ackAlarms(keys, by) {
  for (const key of keys) {
    const a = alarms.get(key);
    if (!a || a.acked) continue;
    a.acked = true;
    a.ackedAt = a.ts = now();
    a.ackedBy = by;
    pushEvent({ source: by, severity: 'info', message: `Acknowledged: ${a.text}` });
    if (!a.active) alarms.delete(key);
  }
  broadcastAlarms();
}
// en advarsel eller alarm uten noe som får den til å gå over: står i listen til den er kvittert; gjentak telles
function eventAlarm(source, severity, text) {
  const key = `event:${source}|${text}`;
  let a = alarms.get(key);
  if (!a) { a = { key, kind: 'event', source, text, count: 0 }; alarms.set(key, a); trimAlarms(); }
  a.count++;
  Object.assign(a, { severity, active: false, acked: false, since: now(), ts: now(), clearedAt: now() });
  broadcastAlarms();
}
// la aldri listen vokse uten grense: fjern de eldste av dem som ikke lenger er aktive
function trimAlarms() {
  if (alarms.size <= ALARMS_MAX) return;
  const old = [...alarms.values()].filter(a => !a.active).sort((a, b) => a.ts - b.ts);
  for (const a of old.slice(0, alarms.size - ALARMS_MAX)) alarms.delete(a.key);
}

// alarmen en tag har, ut fra det adapteren dens registrerte
function alarmDef(a) {
  if (!a || typeof a !== 'object' || !ALARM_SEVERITIES.includes(a.severity)) return null;
  return {
    severity: a.severity,
    text: String(a.text == null ? '' : a.text).slice(0, 200),
    when: a.when === 'false' || a.when === false ? 'false' : 'true',
    delay: Math.max(0, Math.min(3600000, Number(a.delay) || 0)),
    codes: a.codes ? String(a.codes).slice(0, 64) : null,
  };
}
// "Drive fault F{value}" med kodens tekst fra kodelisten, hvis taggen angir en
function alarmText(t, def) {
  const shown = typeof t.value === 'number' || typeof t.value === 'string' ? String(t.value) : '';
  let text = (def.text || (t.dataType === 'boolean' ? t.name : `${t.name} = {value}`)).split('{value}').join(shown);
  if (def.codes && shown) {
    const l = readCodes().codes.lists[def.codes];
    const e = l && l.codes && own(l.codes, shown) ? l.codes[shown] : null;
    const short = e && (e.text || String(e.info || '').split('\n')[0].trim());
    if (short) text += ': ' + short;
  }
  return text;
}
// alarmen til en tag følger verdien; en foreldet verdi lar den være som den er
function tagAlarm(t, now_) {
  const def = t.alarm, key = 'tag:' + t.name;
  if (!def || t.quality === 'bad' || t.value === undefined || t.value === null) return;
  const on = def.when === 'false' ? !truthy(t.value) : truthy(t.value);
  if (!on) return clearAlarm(key, true);
  const a = alarms.get(key);
  if (def.delay && !now_ && !(a && a.active)) {   // den må stå i `delay` ms først
    if (!alarmDelays.has(key)) alarmDelays.set(key, setTimeout(() => { alarmDelays.delete(key); const cur = tags.get(t.name); if (cur) tagAlarm(cur, true); }, def.delay));
    return;
  }
  raiseAlarm(key, { kind: 'tag', source: t.owner || t.name.split('.')[0], tag: t.name, severity: def.severity,
    text: alarmText(t, def), value: t.value, codes: def.codes }, true);
}

function pushEvent(ev) {
  const e = {
    type: 'event',
    ts: ev.ts || now(),
    source: ev.source || 'hub',
    severity: ['info', 'warning', 'alarm'].includes(ev.severity) ? ev.severity : 'info',
    message: String(ev.message == null ? '' : ev.message),
  };
  if (ev.tag && typeof ev.tag === 'string') e.tag = ev.tag;   // taggen bak hendelsen, når det finnes en
  events.push(e);
  if (events.length > EVENTS_LEN) events.shift();
  broadcastToHmi(e);
  log(`[event] ${e.severity} ${e.source}: ${e.message}`);
  return e;
}

// ---------------------------------------------------------------- protokoll
function handle(c, msg) {
  switch (msg.type) {
    case 'hello': {
      c.role = msg.role === 'adapter' ? 'adapter' : 'hmi';
      c.name = String(msg.name || `${c.role}-${++clientSeq}`);
      c.readonly = c.role === 'hmi' && !!msg.readonly;   // f.eks. en skjerm eller en logger: leser bare
      c.serves = c.role === 'adapter' && Array.isArray(msg.serves) ? msg.serves.map(String) : [];   // en historikktjeneste: ['history']
      send(c, { type: 'welcome', name: c.name, role: c.role, serverTime: now() });
      if (c.role === 'hmi') {
        send(c, { type: 'tags', tags: registrySnapshot() });
        send(c, { type: 'events', events });
        const rc = readCodes();
        send(c, { type: 'codes', codes: rc.codes, error: rc.error });
        send(c, { type: 'alarms', alarms: [...alarms.values()] });
      } else {
        pushEvent({ source: c.name, severity: 'info', message: 'adapter connected' });
        clearAlarm('link:' + c.name, false);   // "adapter connected" sier det allerede
      }
      log(`[hello] ${c.role}${c.readonly ? ' (read-only)' : ''} ${c.name}`);
      return;
    }

    case 'register': {
      // { tags: [ { name, dataType, unit, label, description, writable, value, alarm } ] }
      for (const def of msg.tags || []) {
        if (!def || !def.name) continue;
        if (isCalc(def.name)) { send(c, { type: 'error', message: `"${def.name}": names starting with calc. are reserved for calculated tags` }); continue; }
        const prev = tags.get(def.name) || {};
        const t = {
          name: def.name,
          dataType: def.dataType || prev.dataType || 'number',
          unit: def.unit != null ? def.unit : (prev.unit != null ? prev.unit : ''),   // ikke ?? : kjører på Node 12
          description: def.description ? String(def.description) : '',   // fra adapteren, f.eks. layoutfilen
          deviceLabel: def.label ? String(def.label).trim().slice(0, 80) : '',   // enhetens eget navn, f.eks. fra PLS-en
          writable: !!def.writable,
          owner: c.name,
          value: prev.value,
          ts: prev.ts,
          quality: prev.value === undefined ? 'uncertain' : 'good',
          alarm: alarmDef(def.alarm),
        };
        tags.set(def.name, t);
        c.owns.add(def.name);
        if (!t.alarm) clearAlarm('tag:' + def.name, true);   // ikke lenger en alarm (layouten er endret)
        if (def.value !== undefined) applyUpdate(def.name, def.value, now(), 'good', c);
      }
      broadcastRegistry();
      log(`[register] ${c.name}: ${(msg.tags || []).length} tags`);
      return;
    }

    case 'update': {
      // én: { tag, value, ts? }   flere samlet: { values: { name: value, ... }, ts? }
      const ts = Number(msg.ts) || now();
      if (msg.values && typeof msg.values === 'object') {
        for (const [name, value] of Object.entries(msg.values)) applyUpdate(name, value, ts, msg.quality, c);
      } else if (msg.tag !== undefined) {
        applyUpdate(String(msg.tag), msg.value, ts, msg.quality, c);
      }
      return;
    }

    case 'restore': {
      // eldre punkter fra enheten selv, til historikken (se restoreHistory). Endrer ikke verdien nå.
      if (c.role !== 'adapter') return send(c, { type: 'error', message: 'only an adapter can restore history' });
      restoreHistory(c, msg.series, msg.origin);
      return;
    }

    case 'subscribe': {
      // { tags: ["a.b", "esp32_1.*", "*"] }  — uten tags betyr det alt
      const list = Array.isArray(msg.tags) && msg.tags.length ? msg.tags : ['*'];
      for (const s of list) c.subs.add(String(s));
      // send nåværende verdier med en gang, så widgetene får innhold når de lastes
      for (const t of tags.values()) {
        if (t.value !== undefined && matches(c.subs, t.name)) {
          send(c, { type: 'update', tag: t.name, value: t.value, ts: t.ts, quality: t.quality });
        }
      }
      return;
    }

    case 'unsubscribe': {
      for (const s of msg.tags || []) c.subs.delete(String(s));
      return;
    }

    case 'write': {
      // { tag, value }  → sendes videre til adapteren som eier taggen
      if (c.readonly) return send(c, { type: 'error', message: `${c.name} connected read-only and can't write ${msg.tag}` });
      const t = tags.get(String(msg.tag));
      if (!t) return send(c, { type: 'error', message: `unknown tag "${msg.tag}"` });
      if (t.source === 'calc') return send(c, { type: 'error', message: `${t.name} is calculated by the hub and can't be written` });
      let owner = null;
      for (const o of clients) if (o.role === 'adapter' && o.name === t.owner) owner = o;
      if (!owner) return send(c, { type: 'error', message: `adapter "${t.owner}" for "${t.name}" is offline` });
      send(owner, { type: 'write', tag: t.name, value: msg.value, from: c.name, ts: now() });
      // hold-for-å-kjøre (hold-to-run) gjentar samme skriving flere ganger i sekundet: logg bare endringer
      const key = `${c.name}|${t.name}`, val = JSON.stringify(msg.value);
      if (lastWriteLog.get(key) !== val) { lastWriteLog.set(key, val); log(`[write] ${c.name} -> ${t.name} = ${val}`); }
      return;
    }

    case 'event': {
      const e = pushEvent({ ...msg, source: msg.source || c.name });
      // en advarsel eller alarm fra en enhet står i listen til noen kvitterer den
      if (c.role === 'adapter' && ALARM_SEVERITIES.includes(e.severity)) eventAlarm(e.source, e.severity, e.message);
      return;
    }

    case 'ack': {
      // { keys: [...] } eller { all: true }
      if (c.readonly) return send(c, { type: 'error', message: `${c.name} connected read-only and can't acknowledge alarms` });
      ackAlarms(msg.all ? [...alarms.keys()] : (Array.isArray(msg.keys) ? msg.keys.map(String) : []), c.name);
      return;
    }

    case 'history': {
      // { tag, since? } → { type:'history', tag, points:[[ts,value],...] }
      const h = history.get(String(msg.tag)) || [];
      const since = Number(msg.since) || 0;
      send(c, { type: 'history', tag: msg.tag, points: since ? h.filter(p => p[0] >= since) : h });
      return;
    }

    case 'historyRange': {
      // en trend ber om et tidsrom: { id, tags, from, to, points }
      //   → { type: 'historyRange', id, series: { tag: [[ts, value eller null for et hull], ...] }, source, note }
      // Hubens eget minne svarer når det rekker langt nok tilbake; ellers svarer en historikktjeneste
      // (en adapter som sa serves: ['history']), fra databasen sin. Uten den er minnet alt som finnes.
      const q = { tags: (Array.isArray(msg.tags) ? msg.tags : []).map(String).slice(0, 8), from: Number(msg.from), to: Number(msg.to), points: Number(msg.points) || 1000 };
      const reply = r => send(c, Object.assign({ type: 'historyRange', id: msg.id }, r));
      if (!(q.to > q.from)) return reply({ series: {}, error: 'empty time range' });
      if (memoryCovers(q)) return reply({ source: 'hub', series: fromMemory(q) });
      let rec = null;
      for (const o of clients) if (o.role === 'adapter' && o.serves && o.serves.includes('history')) rec = o;
      if (!rec) return reply({ source: 'hub', series: fromMemory(q), note: 'No history database is connected, so only what the hub has in memory is shown' });
      const qid = ++querySeq;
      const timer = setTimeout(() => {
        if (pendingQueries.delete(qid)) reply({ source: 'hub', series: fromMemory(q), note: 'The history database didn’t answer in time, so only what the hub has in memory is shown' });
      }, 20000);
      pendingQueries.set(qid, { reply, timer, q });
      send(rec, Object.assign({ type: 'query', id: qid }, q));
      return;
    }

    case 'queryResult': {
      // svaret fra historikktjenesten, sendt videre til HMI-en som spurte. Tagger den aldri lagret,
      // får det hubens minne har, og en merknad som sier hvorfor.
      if (!c.serves || !c.serves.includes('history')) return;
      const p = pendingQueries.get(msg.id);
      if (!p) return;
      pendingQueries.delete(msg.id);
      clearTimeout(p.timer);
      const series = msg.series || {};
      const unrecorded = Array.isArray(msg.unrecorded) ? msg.unrecorded.filter(n => p.q.tags.includes(n)) : [];
      // etter tjenestens siste punkt, hubens minne: verdier den ikke har lagret ennå
      const mem = fromMemory(p.q);
      for (const name of p.q.tags) {
        const got = Array.isArray(series[name]) ? series[name] : [];
        const lastT = got.length ? got[got.length - 1][0] : -Infinity;
        series[name] = got.concat((mem[name] || []).filter(pt => pt[0] > lastT));
      }
      p.reply({ source: 'history', series, error: msg.error, ms: msg.ms,
        note: unrecorded.length ? `Not in the history database, so only what the hub has in memory: ${unrecorded.join(', ')}` : undefined });
      return;
    }

    case 'checkCalc': {
      // editoren ber huben sjekke en formel mens den skrives:
      // hubens parser er den eneste, så svaret er nøyaktig det som vil kjøre
      const formula = resolveVars(msg.formula, msg.vars || projectVars);
      const reply = { type: 'calcCheck', id: msg.id, resolved: formula };
      try {
        const cc = compile(formula);
        const pending = new Set(Array.isArray(msg.names) ? msg.names : []);
        reply.ok = true;
        reply.deps = cc.deps;
        reply.unknown = cc.deps.filter(d => !tags.has(d) && !pending.has(d));
        if (cc.timed) reply.timed = true;
        if (cc.deps.every(d => tags.has(d) && tags.get(d).value != null)) {
          const v = cc.evaluate(n => tags.get(n).value, mono());
          reply.value = Number.isFinite(v) ? +v.toPrecision(12) : null;
          if (!Number.isFinite(v)) reply.note = Number.isNaN(v) ? 'result is not a number' : 'result is infinite (division by zero?)';
        }
      } catch (err) { reply.ok = false; reply.error = err.message; reply.pos = err.pos; }
      return send(c, reply);
    }

    case 'list':
      return send(c, { type: 'tags', tags: registrySnapshot() });

    case 'ping':
      return send(c, { type: 'pong', ts: now() });

    default:
      send(c, { type: 'error', message: `unknown message type "${msg.type}"` });
  }
}

function onDisconnect(c) {
  clients.delete(c);
  // en adapter som koblet til på nytt før den gamle, døde forbindelsen ble oppdaget, er fortsatt tilkoblet
  if (c.role === 'adapter' && isOnline(c.name)) { log(`[bye] old connection of ${c.name} (it is connected again)`); return; }
  if (c.role === 'adapter') {
    // merk alt adapteren eide som foreldet, men la siste verdi være synlig
    for (const name of c.owns) {
      const t = tags.get(name);
      if (!t || t.owner !== c.name) continue;
      t.quality = 'bad';
      broadcastToHmi({ type: 'update', tag: name, value: t.value, ts: t.ts, quality: 'bad' }, name);
      markCalcInput(name);
    }
    raiseAlarm('link:' + c.name, { kind: 'link', source: c.name, tag: null, severity: 'warning', text: 'Adapter disconnected' }, true);
    broadcastRegistry();
  }
  log(`[bye] ${c.role || '?'} ${c.name || ''}`);
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const DEFAULT_CONFIG = {
  project: 'New project',
  canvas: { width: 1280, height: 720 },
  vars: {},
  screens: [{ id: 'main', name: 'Main', widgets: [] }],
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listAssets() {
  try {
    return fs.readdirSync(ASSET_DIR)
      .filter(n => ASSET_NAME.test(n))
      .map(n => { const st = fs.statSync(path.join(ASSET_DIR, n)); return { name: n, size: st.size, modified: st.mtimeMs }; })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/config') {
    if (req.method === 'GET') {
      const rp = readConfigFile();
      if (rp.cfg) return json(res, 200, rp.cfg);
      if (rp.missing) return json(res, 200, { ...DEFAULT_CONFIG, _fresh: true });
      log(`[config] WARNING ${rp.error}`);
      return json(res, 500, { ok: false, error: rp.error });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const cfg = JSON.parse((await readBody(req)).toString('utf8'));
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        // en prosjektfil som ikke kan leses, tas vare på som kopi, ikke bare skrevet over: den kan
        // være én skrivefeil unna et helt prosjekt
        let kept = null;
        if (readConfigFile().error) {
          kept = CONFIG_PATH + '.unreadable-' + new Date().toISOString().replace(/[:.]/g, '-');
          fs.copyFileSync(CONFIG_PATH, kept);
          log(`[config] kept the unreadable project file as ${kept}`);
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        log(`[config] saved ${CONFIG_PATH}`);
        loadCalcs(cfg);   // formler virker med en gang, uten omstart
        broadcastToHmi({ type: 'configChanged' });
        return json(res, 200, { ok: true, path: CONFIG_PATH, kept });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
  }
  // ---- prosjektets ressurser (SVG-tegninger, bilder): GET liste, GET/PUT/DELETE én fil
  if (url.pathname === '/api/assets' && req.method === 'GET') return json(res, 200, listAssets());
  const am = url.pathname.match(/^\/(?:api\/)?assets\/(.+)$/);
  if (am) {
    const name = decodeURIComponent(am[1]);
    if (!ASSET_NAME.test(name)) return json(res, 400, { ok: false, error: 'invalid asset name (letters, digits, _ . - and .svg/.png/.jpg/.webp)' });
    const file = path.join(ASSET_DIR, name);
    if (req.method === 'GET') {
      return fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readBody(req, ASSET_MAX);
        fs.mkdirSync(ASSET_DIR, { recursive: true });
        fs.writeFileSync(file, body);
        log(`[asset] saved ${name} (${body.length} bytes)`);
        return json(res, 200, { ok: true, name, size: body.length });
      } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (req.method === 'DELETE') {
      try { fs.unlinkSync(file); log(`[asset] deleted ${name}`); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 404, { ok: false, error: e.message }); }
    }
  }

  // ---- kodetekster: GET alle lister, POST { changes: [...] } (se applyCodeChanges)
  if (url.pathname === '/api/codes') {
    if (req.method === 'GET') {
      const rc = readCodes();
      return rc.error ? json(res, 500, { ok: false, error: rc.error }) : json(res, 200, rc.codes);
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const changes = Array.isArray(body.changes) ? body.changes : [];
        const rc = readCodes();
        if (rc.error) return json(res, 500, { ok: false, error: rc.error });
        applyCodeChanges(rc.codes, changes);
        writeCodes(rc.codes);
        log(`[codes] ${changes.length} change${changes.length === 1 ? '' : 's'} saved to ${CODES_PATH}`);
        broadcastToHmi({ type: 'codes', codes: rc.codes });
        return json(res, 200, { ok: true, codes: rc.codes });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
  }

  // ---- dine egne tagnavn: GET filen (og navnene per tag), POST { changes: [{ tag, name, info }] }
  if (url.pathname === '/api/names') {
    if (req.method === 'GET') {
      const rn = readNames();
      if (rn.error) return json(res, 500, { ok: false, error: rn.error });
      const byTag = {};
      for (const [tag, n] of tagNames) byTag[tag] = n;
      return json(res, 200, { tags: rn.names.tags, byTag, vars: projectVars, file: NAMES_PATH });
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8'));
        const changes = Array.isArray(body.changes) ? body.changes : [];
        const rn = readNames();
        if (rn.error) return json(res, 500, { ok: false, error: rn.error });
        applyNameChanges(rn.names, changes);
        fs.mkdirSync(path.dirname(NAMES_PATH), { recursive: true });
        writeNames(rn.names);
        indexNames();
        broadcastRegistry();   // alle HMI-er får navnene med taglisten
        log(`[names] ${changes.length} change${changes.length === 1 ? '' : 's'} saved to ${NAMES_PATH}`);
        return json(res, 200, { ok: true, tags: rn.names.tags });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
  }

  if (url.pathname === '/api/alarms') return json(res, 200, [...alarms.values()]);
  if (url.pathname === '/api/tags') return json(res, 200, registrySnapshot());
  if (url.pathname === '/api/events') return json(res, 200, events);
  if (url.pathname === '/api/history') {
    return json(res, 200, history.get(url.searchParams.get('tag')) || []);
  }

  // three.js: /vendor/three/three.module.js og /vendor/three/addons/... (examples/jsm)
  if (url.pathname.startsWith('/vendor/three/')) {
    if (!THREE_DIR) { res.writeHead(404); return res.end('three.js is not installed - run npm install'); }
    const rel = decodeURIComponent(url.pathname.slice('/vendor/three/'.length));
    const base = rel.startsWith('addons/') ? path.join(THREE_DIR, '..', 'examples', 'jsm') : THREE_DIR;
    const file = path.normalize(path.join(base, rel.startsWith('addons/') ? rel.slice(7) : rel));
    if (!file.startsWith(path.normalize(base) + path.sep) || !/\.(js|json|wasm)$/.test(file)) { res.writeHead(403); return res.end(); }
    return fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  }

  // statiske HMI-filer
  let file = path.normalize(decodeURIComponent(url.pathname));
  if (file === '/' || file === '\\') file = '/index.html';
  const full = path.join(HMI_DIR, file);
  if (!full.startsWith(HMI_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const c = { ws, role: null, name: null, subs: new Set(), owns: new Set(), alive: true };
  clients.add(c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(c, { type: 'error', message: 'invalid JSON' }); }
    if (!msg || typeof msg !== 'object') return;
    if (!c.role && msg.type !== 'hello') {
      // vær tilgivende: behandle første melding fra en ukjent klient som en underforstått hello
      handle(c, { type: 'hello', role: msg.type === 'subscribe' ? 'hmi' : 'adapter' });
    }
    try { handle(c, msg); } catch (e) { log('handler error', e); send(c, { type: 'error', message: e.message }); }
  });
  ws.on('close', () => onDisconnect(c));
  ws.on('error', () => {});
});

// kast forbindelser som har sluttet å svare på ping (f.eks. en Wi-Fi-enhet som mistet strømmen)
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
  }
}, 15000);

server.listen(PORT, () => {
  log(`HMI hub listening on http://localhost:${PORT}  (ws://<this-host>:${PORT})`);
  if (VEHICLE) log(`vehicle ${VEHICLE}: the source of the calculations' alarms and events`);
  log(`Node.js:     ${process.version} on ${process.platform}/${process.arch}`);
  log(`config file: ${CONFIG_PATH}`);
  log(`assets:      ${ASSET_DIR}`);
  log(`code texts:  ${CODES_PATH}`);
  log(`tag names:   ${NAMES_PATH}`);
  const rc = readCodes();
  if (rc.error) log(`[codes] WARNING ${rc.error}`);
  const rp = readConfigFile();
  if (rp.error) log(`[config] WARNING ${rp.error}`);
  loadCalcs(rp.cfg || {});
});
