#!/usr/bin/env node
'use strict';
/*
 * binary-adapter.js - gjør posisjonsbaserte binærdata om til navngitte tagger, ut fra en layoutfil.
 *
 * Kjernefil: lik i alle prosjekter. Det som endres per prosjekt, er layoutfilen.
 * Layouten velger én av to moduser:
 *
 * "frames" (standard) - for små mikrokontrollere (brukes ikke med PLS-en):
 *     [len hi][len lo][type][payload], tall little-endian, en hello-ramme navngir enheten.
 *     Flere enheter kan koble til; hver får sitt eget tagprefiks.
 *
 * "fixed" - PLS-stil, f.eks. en Siemens S7-1200 med TSEND_C / TRCV_C (Open User Communication):
 *     fromPlc  en blokk med fast lengde som PLS-en sender; hvert felt blir en tag
 *     toPlc    en kommandoblokk med fast lengde som adapteren sender; feltene er skrivbare tagger
 *     Big-endian som standard, Bool-er pakket åtte per byte, S7-typenavn, og offset skrevet
 *     slik TIA viser dem i Offset-kolonnen til en DB ("14.0", "6.3").
 *
 * Bruk:
 *   node adapters/binary-adapter.js <layout.json> [ws://hub:8080] [port]
 *   node adapters/binary-adapter.js            uten argumenter: adapters/binary-layouts/kjoreverk-layout.json
 *   node adapters/binary-adapter.js <layout.json> --map     skriv ut de utregnede feltoffsetene og avslutt
 *   node adapters/binary-adapter.js <layout.json> --dump    logg hver blokk i hex mens den kjører
 *   node adapters/binary-adapter.js <layout.json> --plc=192.168.0.1:2000   koble til PLS-en der
 *                                        (--plc=2000 venter i stedet på PLS-en på den porten)
 *   node adapters/binary-adapter.js <layout.json> --name=kv_52   navnet i huben, som alarmlisten viser (ellers
 *                                       kjøreverkets navn i /etc/kjoreverk/vehicle, eller "device")
 *   node adapters/binary-adapter.js <layout.json> --commands  send kommandoer selv om layouten
 *                                                            har toPlc.enabled = false (f.eks. for en test)
 *
 * Layoutformatet er beskrevet i README (avsnittet "Pakket binærdata") og i
 * layouten adapters/binary-layouts/kjoreverk-layout.json.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const { vehicleName } = require('../lib/vehicle');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// Tidsintervaller bruker en monoton klokke, så å stille datamaskinens klokke kan ikke utløse
// eller blinde vakthunden for forbindelsen.
const { performance } = require('perf_hooks');
const mono = () => performance.now();

// ================================================================ typer
// S7-navn og vanlige navn peker på de samme kodekene. `bool` er én bit i fixed-modus og
// én hel byte i frames-modus (ESP32-layouten er eldre enn bitpakkingen).
const ALIAS = {
  bool: 'bool', boolean: 'bool',
  byte: 'uint8', usint: 'uint8', char: 'uint8', uint8: 'uint8',
  sint: 'int8', int8: 'int8',
  word: 'uint16', uint: 'uint16', uint16: 'uint16',
  int: 'int16', int16: 'int16',
  dword: 'uint32', udint: 'uint32', uint32: 'uint32',
  dint: 'int32', int32: 'int32',
  real: 'float32', float32: 'float32', float: 'float32',
  lreal: 'float64', float64: 'float64', double: 'float64',
  dtl: 'dtl',
};
const rw = (size, name, min, max) => ({
  size, min, max,
  get: (b, o, be) => b[`read${name}${size > 1 ? (be ? 'BE' : 'LE') : ''}`](o),
  set: (b, o, v, be) => b[`write${name}${size > 1 ? (be ? 'BE' : 'LE') : ''}`](v, o),
});
const CODEC = {
  uint8: rw(1, 'UInt8', 0, 255),
  int8: rw(1, 'Int8', -128, 127),
  uint16: rw(2, 'UInt16', 0, 65535),
  int16: rw(2, 'Int16', -32768, 32767),
  uint32: rw(4, 'UInt32', 0, 4294967295),
  int32: rw(4, 'Int32', -2147483648, 2147483647),
  float32: { ...rw(4, 'Float'), float: true },
  float64: { ...rw(8, 'Double'), float: true },
  boolbyte: { size: 1, get: (b, o) => b.readUInt8(o) !== 0, set: (b, o, v) => b.writeUInt8(v ? 1 : 0, o) },
  // DTL: Year UInt, Month, Day, Weekday, Hour, Minute, Second (USInt hver), Nanosecond UDInt = 12 byte
  dtl: {
    size: 12,
    get: (b, o, be) => ({
      year: be ? b.readUInt16BE(o) : b.readUInt16LE(o), month: b[o + 2], day: b[o + 3],
      hour: b[o + 5], minute: b[o + 6], second: b[o + 7], ns: be ? b.readUInt32BE(o + 8) : b.readUInt32LE(o + 8),
    }),
    set: (b, o, d, be) => {
      if (be) b.writeUInt16BE(d.year, o); else b.writeUInt16LE(d.year, o);
      const weekday = new Date(d.year, d.month - 1, d.day).getDay() + 1;   // DTL: 1 = søndag
      b[o + 2] = d.month; b[o + 3] = d.day; b[o + 4] = weekday;
      b[o + 5] = d.hour; b[o + 6] = d.minute; b[o + 7] = d.second;
      if (be) b.writeUInt32BE(d.ns || 0, o + 8); else b.writeUInt32LE(d.ns || 0, o + 8);
    },
  },
};

// "14.3" / "14" / 14 -> { byte, bit }
function parseOffset(v, what) {
  if (typeof v === 'number') return { byte: v, bit: 0 };
  const m = String(v == null ? '' : v).trim().match(/^(\d+)(?:\.(\d))?$/);
  if (!m || (m[2] && +m[2] > 7)) throw new Error(`${what}: offset "${v}" should look like 14 or 14.0 (byte.bit, bit 0-7)`);
  return { byte: +m[1], bit: m[2] ? +m[2] : 0 };
}
const fmtOffset = f => `${f.byte}.${f.bit}`;
const NAME_RX = /^[A-Za-z_][\w.-]*$/;
// "event" på et felt: info logges av denne adapteren ved hver endring; warning og alarm gjør
// feltet til en alarm som huben holder (aktiv til verdien går tilbake, listet til den er kvittert)
const EVENT_SEVERITIES = ['info', 'warning', 'alarm'];
const isAlarm = o => o.event === 'warning' || o.event === 'alarm';

// ================================================================ layout
// "extends": "other.json" tar den layouten og endrer det denne filen sier. fromPlc og
// toPlc flettes nøkkel for nøkkel, og deres "overrides" flettes etter feltnavn.
function readLayoutJson(file, depth = 0) {
  let j;
  // Notepad kan lagre et byte-order mark; og med "extends" må meldingen si hvilken fil
  try { j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { throw new Error(`${file}: ${e.message}`); }
  if (!j.extends) return j;
  if (depth > 4) throw new Error('"extends" goes too deep (a loop?)');
  const base = readLayoutJson(path.resolve(path.dirname(file), j.extends), depth + 1);
  const out = { ...base, ...j };
  delete out.extends;
  for (const k of ['fromPlc', 'toPlc']) {
    if (!base[k] && !j[k]) continue;
    out[k] = { ...(base[k] || {}), ...(j[k] || {}) };
    out[k].overrides = { ...((base[k] || {}).overrides || {}), ...((j[k] || {}).overrides || {}) };
  }
  out._notes = [...(base._notes || []), ...(j._notes || [])];
  return out;
}

function loadLayout(file) {
  const L = readLayoutJson(file);
  L.file = file;
  L.mode = L.mode || (L.fromPlc || L.toPlc ? 'fixed' : 'frames');
  if (L.mode === 'frames') return loadFrames(L);
  if (L.mode !== 'fixed') throw new Error(`unknown mode "${L.mode}" (use "frames" or "fixed")`);
  L.be = (L.byteOrder || 'big') === 'big';
  L.msb0 = (L.bitOrder || 'lsb0') === 'msb0';
  if (!L.device || !NAME_RX.test(L.device)) throw new Error('"device" (the tag prefix, e.g. "pls") is required');
  L.fromPlc = L.fromPlc ? block(L, L.fromPlc, 'fromPlc') : null;
  L.toPlc = L.toPlc ? block(L, L.toPlc, 'toPlc') : null;
  if (!L.fromPlc && !L.toPlc) throw new Error('a fixed layout needs "fromPlc", "toPlc" or both');
  const names = new Set();
  for (const b of [L.fromPlc, L.toPlc].filter(Boolean)) {
    for (const f of b.fields) for (const n of [f.name, ...(f.bits || []).map(x => x.name), f.age ? f.name + '_age' : null].filter(Boolean)) {
      if (names.has(n)) throw new Error(`the name "${n}" is used twice`);
      names.add(n);
    }
  }
  if (names.has('link')) throw new Error('"link" is reserved: the adapter publishes it');
  return L;
}

function block(L, spec, where) {
  const b = { ...spec };
  if (!(spec.length > 0)) throw new Error(`${where}.length (bytes per block) is required`);
  b.fields = expand(L, spec.fields || [], where, spec.length, false);
  const OVERRIDABLE = ['name', 'unit', 'description', 'default', 'autoReset', 'hold', 'event', 'text', 'codes'];
  for (const [key, o] of Object.entries(spec.overrides || {})) {
    const f = b.fields.find(x => x.name === key);
    if (!f) throw new Error(`${where}.overrides: there is no field "${key}"`);
    for (const k of Object.keys(o)) if (!OVERRIDABLE.includes(k)) throw new Error(`${where}.overrides.${key}: "${k}" can't be overridden (${OVERRIDABLE.join(', ')})`);
    Object.assign(f, o);
    if (!NAME_RX.test(f.name)) throw new Error(`${where}.overrides.${key}: invalid name "${f.name}"`);
  }
  // en feilstavet alvorlighetsgrad ville ellers gått ubemerket til feilen den skulle vise
  for (const f of b.fields) for (const o of [f, ...(f.bits || [])]) {
    if (o.event !== undefined && !EVENT_SEVERITIES.includes(o.event)) throw new Error(`${where}: "${o.name}" event must be ${EVENT_SEVERITIES.join(', ')} (not "${o.event}")`);
  }
  for (const f of b.fields) {
    if (!f.hold) continue;
    if (where !== 'toPlc' || f.type !== 'bool') throw new Error(`${where}: "hold" is for command Bools only ("${f.name}")`);
    if (f.autoReset) throw new Error(`${where}: "${f.name}" has both "hold" and "autoReset" - pick one`);
    if (!(f.hold >= 100)) throw new Error(`${where}: "${f.name}" hold must be at least 100 ms`);
  }
  b.check = expand(L, spec.check || [], where + '.check', spec.length, true);
  b.fixed = expand(L, spec.fixed || [], where + '.fixed', spec.length, true);
  for (const f of b.fields) {
    if (!f.ageFrom) continue;
    const ref = b.fields.find(x => x.name === f.ageFrom);
    if (!ref || ref.type !== 'dtl') throw new Error(`${where}: "${f.name}" has ageFrom "${f.ageFrom}", which is not a DTL field of the same block`);
  }
  // overlappende felt er nesten alltid en skrivefeil i et offset
  const used = new Map();
  for (const f of [...b.fields, ...b.check, ...b.fixed]) {
    const cells = f.type === 'bool' ? [`${f.byte}.${f.bit}`] : Array.from({ length: f.size * 8 }, (_, i) => `${f.byte + (i >> 3)}.${i & 7}`);
    for (const c of cells) {
      if (used.has(c)) throw new Error(`${where}: "${f.name || f.type}" at ${fmtOffset(f)} overlaps "${used.get(c)}"`);
      used.set(c, f.name || f.type);
    }
  }
  return b;
}

function expand(L, list, where, length, constants) {
  const out = [];
  for (const [n, spec] of list.entries()) {
    const type = ALIAS[String(spec.type || '').toLowerCase()];
    if (!type) throw new Error(`${where}[${n}]: unknown type "${spec.type}"`);
    const start = parseOffset(spec.offset, `${where}[${n}]`);
    const count = spec.count || 1;
    for (let i = 0; i < count; i++) {
      const f = { type, unit: spec.unit || '', description: spec.description || '' };
      if (type === 'bool') {
        const abs = start.byte * 8 + start.bit + i;
        f.byte = abs >> 3; f.bit = abs & 7; f.size = 1;
      } else {
        if (start.bit) throw new Error(`${where}[${n}]: ${spec.type} must start on a whole byte (x.0), not ${spec.offset}`);
        f.size = CODEC[type].size; f.byte = start.byte + i * f.size; f.bit = 0;
      }
      if (f.byte + f.size > length) throw new Error(`${where}[${n}]: ${spec.type} at ${fmtOffset(f)} runs past the end of the ${length}-byte block`);
      if (constants) {
        if (spec.value === undefined && !spec.auto) throw new Error(`${where}[${n}]: needs "value" or "auto"`);
        f.value = typeof spec.value === 'string' && /^(16#|0x)/i.test(spec.value) ? parseInt(spec.value.replace(/^16#/i, '0x'), 16) : spec.value;
        f.auto = spec.auto;
        out.push(f);
        continue;
      }
      const name = (spec.names && spec.names[i]) || pattern(spec.name, (spec.start || 0) + i);
      if (!name || !NAME_RX.test(name)) throw new Error(`${where}[${n}]: invalid name "${name}" (letters, digits, _ . -)`);
      f.name = name;
      f.default = spec.default;
      f.autoReset = spec.autoReset;
      f.hold = spec.hold;
      f.event = spec.event;
      f.text = spec.text;
      f.codes = spec.codes;   // en liste med kodetekster: alarmteksten får kodens tekst ("Drive fault F7900: Motor blocked")
      f.age = type === 'dtl' && !!spec.age;
      f.ageFrom = spec.ageFrom;
      f.utc = spec.clock === 'utc';
      if (spec.bits) {
        if (!['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32'].includes(type)) throw new Error(`${where}[${n}]: "bits" needs an integer type`);
        f.bits = Object.entries(spec.bits).map(([k, v]) => {
          const d = typeof v === 'string' ? { name: v } : v;
          if (+k >= f.size * 8) throw new Error(`${where}[${n}]: bit ${k} doesn't exist in a ${spec.type}`);
          return { bit: +k, name: d.name, event: d.event, text: d.text, description: d.description || '' };
        });
      }
      out.push(f);
    }
  }
  return out;
}
// "bit{i:2}" -> bit00, "ints_{i}" -> ints_0
const pattern = (p, i) => String(p || '').replace(/\{i(?::(\d+))?\}/g, (_, w) => String(i).padStart(w ? +w : 0, '0'));

// ================================================================ koding / dekoding (fixed-modus)
const mask = (L, bit) => (L.msb0 ? 0x80 >> bit : 1 << bit);

function readField(L, buf, f) {
  if (f.type === 'bool') return (buf[f.byte] & mask(L, f.bit)) !== 0;
  return CODEC[f.type].get(buf, f.byte, L.be);
}
function writeField(L, buf, f, v) {
  if (f.type === 'bool') { if (v) buf[f.byte] |= mask(L, f.bit); else buf[f.byte] &= ~mask(L, f.bit); return; }
  CODEC[f.type].set(buf, f.byte, v, L.be);
}
// begrens og rund av en verdi for et heltalls- eller flyttallsfelt
function coerce(f, v) {
  if (f.type === 'bool') return v === true || v === 1 || v === 'true' || v === '1';
  let n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
  if (!Number.isFinite(n)) return null;
  const c = CODEC[f.type];
  if (c.float) return n;
  n = Math.round(n);
  return Math.min(c.max, Math.max(c.min, n));
}
function dtlText(d, utc) {
  if (!d || d.year <= 1970) return '';
  const p = (x, w = 2) => String(x).padStart(w, '0');
  if (utc) {   // vises i denne datamaskinens lokaltid
    const t = new Date(Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second));
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  }
  return `${d.year}-${p(d.month)}-${p(d.day)} ${p(d.hour)}:${p(d.minute)}:${p(d.second)}`;
}
function dtlMs(d, utc) {
  if (!d || d.year <= 1970) return null;
  const args = [d.year, d.month - 1, d.day, d.hour, d.minute, d.second, Math.floor(d.ns / 1e6)];
  return utc ? Date.UTC(...args) : new Date(...args).getTime();
}

// Alle tagger en blokk gir fra én buffer: { name: value }
function decodeBlock(L, b, buf) {
  const out = {};
  for (const f of b.fields) {
    const v = readField(L, buf, f);
    if (f.type === 'dtl') { out[f.name] = dtlText(v, f.utc); out.__dtl = out.__dtl || {}; out.__dtl[f.name] = v; continue; }
    out[f.name] = f.type.startsWith('float') ? +v.toPrecision(7) : v;
    for (const bt of f.bits || []) out[bt.name] = ((v >>> bt.bit) & 1) === 1;
  }
  return out;
}
function checkBlock(L, b, buf) {
  for (const c of b.check) {
    if (c.auto === 'counter') continue;
    const want = c.auto === 'length' ? b.length : c.value;
    if (readField(L, buf, c) !== want) return `${fmtOffset(c)} is ${readField(L, buf, c)}, expected ${want}`;
  }
  return null;
}
// Koder en blokk. `fixed`-konstanter er det mottakeren forventer; `check`-konstanter skrives
// også, så en simulator kan bygge nøyaktig det adapteren kontrollerer.
function encodeBlock(L, b, values, seq = 0) {
  const buf = Buffer.alloc(b.length);
  for (const c of [...b.fixed, ...b.check]) writeField(L, buf, c, c.auto === 'counter' ? seq % (CODEC[c.type].max + 1 || 65536) : c.auto === 'length' ? b.length : c.value);
  for (const f of b.fields) {
    if (!(f.name in values)) continue;
    writeField(L, buf, f, values[f.name]);
  }
  return buf;
}

function hexdump(buf, cols = 16) {
  const lines = [];
  for (let i = 0; i < buf.length; i += cols) {
    lines.push(`  ${String(i).padStart(4)}  ${[...buf.subarray(i, i + cols)].map(x => x.toString(16).padStart(2, '0')).join(' ')}`);
  }
  return lines.join('\n');
}

function printMap(L) {
  console.log(`layout "${L.layout || path.basename(L.file)}"  mode fixed  device ${L.device}  ${L.be ? 'big' : 'little'}-endian  bits ${L.msb0 ? 'msb0' : 'lsb0'}`);
  for (const [label, b] of [['fromPlc (PLC -> PC)', L.fromPlc], ['toPlc (PC -> PLC)', L.toPlc]]) {
    if (!b) continue;
    console.log(`\n${label}: ${b.length} bytes${label.startsWith('toPlc') ? `, sending ${b.enabled ? 'ENABLED' : 'disabled'}` : ''}`);
    for (const c of [...b.check, ...b.fixed]) console.log(`  ${fmtOffset(c).padStart(6)}  ${c.type.padEnd(8)} ${c.auto ? `(auto ${c.auto})` : `= ${c.value}`}`);
    for (const f of b.fields) {
      console.log(`  ${fmtOffset(f).padStart(6)}  ${f.type.padEnd(8)} ${L.device}.${f.name}${f.unit ? ` [${f.unit}]` : ''}${f.autoReset ? `  (auto-reset ${f.autoReset} ms)` : ''}${f.hold ? `  (hold-to-run, drops ${f.hold} ms after the last press)` : ''}`);
      for (const bt of f.bits || []) console.log(`          bit ${String(bt.bit).padStart(2)}   ${L.device}.${bt.name}`);
    }
  }
}

// ================================================================ fixed-modus: adapteren
function runFixed(L, hubUrl, portArg, dump) {
  const WebSocket = require('ws');
  const T = n => `${L.device}.${n}`;
  const from = L.fromPlc, to = L.toPlc;
  const toByName = new Map(), bitOwner = new Map();
  if (to) for (const f of to.fields) { toByName.set(f.name, f); for (const bt of f.bits || []) bitOwner.set(bt.name, { f, bit: bt.bit }); }
  const timeoutMs = L.timeoutMs || 3000;

  // kommandobilde: verdiene adapteren sender til PLS-en
  const cmd = {};
  if (to) for (const f of to.fields) cmd[f.name] = f.default !== undefined ? coerce(f, f.default) : f.type === 'bool' ? false : 0;
  const holdTimers = new Map(), holdBlocked = new Set(), holdWarned = new Set();
  const clearBits = () => {
    if (!to) return;
    for (const f of to.fields) {
      if (f.type !== 'bool') continue;
      if (f.hold && cmd[f.name]) { clearTimeout(holdTimers.get(f.name)); holdBlocked.add(f.name); }
      cmd[f.name] = false;
    }
  };

  let ws = null, hubOpen = false, plc = null, plcAt = '', rxBuf = Buffer.alloc(0), lastRx = 0, link = false, everLinked = false, seq = 0;
  let sent = {}, lastFull = -Infinity, sendTimer = null, rxGaps = 0, lastSeq = null, skipped = 0;
  const seqField = from && from.check.find(c => c.auto === 'counter');
  const resetTimers = new Map();
  let lastDtl = {};

  const toHub = m => { if (hubOpen) ws.send(JSON.stringify(m)); };
  const event = (severity, message) => { log(`[${severity}] ${message}`); toHub({ type: 'event', severity, message }); };

  function registerTags() {
    // forbindelsen er også en alarm: ingen data fra PLS-en på 2 s (litt frist ved oppstart)
    const tags = [{ name: T('link'), dataType: 'boolean', description: 'true while blocks arrive from the PLC',
      alarm: { severity: 'alarm', text: 'No data from the PLC', when: 'false', delay: 2000 } }];
    if (seqField) tags.push({ name: T('rx_gaps'), dataType: 'number', description: 'jumps in the PLC sequence number (lost or repeated blocks)' });
    // felt med warning- eller alarm-hendelse: huben følger verdiene deres, så en alarm som alt er på
    // når adapteren starter, eller når PLS-en eller huben kommer tilbake, blir også listet
    const alarmOf = (o, bool) => (isAlarm(o) ? { severity: o.event, text: o.text || (bool ? `${o.name} on` : `${o.name} = {value}`), codes: o.codes } : undefined);
    const add = (f, writable) => {
      tags.push({ name: T(f.name), dataType: f.type === 'bool' ? 'boolean' : f.type === 'dtl' ? 'string' : 'number', unit: f.unit, writable,
        description: f.description || undefined, alarm: writable ? undefined : alarmOf(f, f.type === 'bool') });
      for (const bt of f.bits || []) tags.push({ name: T(bt.name), dataType: 'boolean', writable, description: bt.description || undefined, alarm: writable ? undefined : alarmOf(bt, true) });
      if (f.age) tags.push({ name: T(f.name + '_age'), dataType: 'number', unit: 's' });
    };
    if (from) for (const f of from.fields) add(f, false);
    if (to) for (const f of to.fields) add(f, true);
    toHub({ type: 'register', tags });
  }

  // ---- forbindelse til huben
  function connectHub() {
    ws = new WebSocket(hubUrl);
    ws.on('open', () => {
      hubOpen = true;
      log(`hub ${hubUrl} connected as ${L.name || L.device}`);
      toHub({ type: 'hello', role: 'adapter', name: L.name || L.device });
      registerTags();
      sent = {};
      toHub({ type: 'update', tag: T('link'), value: link });
      if (seqField) toHub({ type: 'update', tag: T('rx_gaps'), value: rxGaps });
      publishFrom(null, true);
      publishCmd();
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'write') onWrite(m);
      else if (m.type === 'error') log('hub error:', m.message);
    });
    ws.on('close', () => {
      if (hubOpen) {
        log('hub connection lost, retrying in 2 s');
        // ingen kan se eller stoppe maskinen via HMI-en nå: slipp kommandobitene
        if ((L.onHubLoss || 'clearBits') === 'clearBits' && to) { clearBits(); sendCmd('hub connection lost'); }
      }
      hubOpen = false;
      setTimeout(connectHub, 2000);
    });
    ws.on('error', () => {});
  }

  // ---- PLS-forbindelsen: lytt (PLS aktiv) eller koble til (PLS passiv)
  function attach(sock, where) {
    if (plc && plc !== sock) { log(`replacing the previous PLC connection (${plcAt})`); plc.destroy(); }
    plc = sock; plcAt = where; rxBuf = Buffer.alloc(0); lastSeq = null;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 5000);
    event('info', `PLC connected from ${where}`);
    if ((L.onReconnect || 'clearBits') === 'clearBits') clearBits();
    publishCmd();
    sendCmd('connected');
    let first = true;
    sock.on('data', chunk => {
      if (first) log(`first data from the PLC: ${chunk.length} bytes in the first chunk (the layout expects blocks of ${from ? from.length : '-'})`);
      first = false;
      rxBuf = Buffer.concat([rxBuf, chunk]);
      if (!from) { rxBuf = Buffer.alloc(0); return; }
      while (rxBuf.length >= from.length) {
        const blk = rxBuf.subarray(0, from.length);
        const bad = checkBlock(L, from, blk);
        if (bad) {
          // let etter headeren: skyv én byte og prøv igjen
          if (skipped === 0) {
            event('warning', `Block from the PLC rejected (${bad}); looking for the next header`);
            if (dump) console.log(hexdump(blk));
          }
          if (!from.check.some(c => c.auto !== 'counter')) { rxBuf = Buffer.alloc(0); break; }   // ingenting å lete etter
          rxBuf = rxBuf.subarray(1);
          skipped++;
          continue;
        }
        if (skipped) { event('info', `Back in step with the PLC after skipping ${skipped} bytes`); skipped = 0; }
        rxBuf = rxBuf.subarray(from.length);
        onBlock(blk);
      }
    });
    sock.on('close', () => {
      if (plc !== sock) return;
      plc = null;
      event('info', 'PLC disconnected');   // alarmen for forbindelsen følger (se registerTags)
      goStale('PLC disconnected');
    });
    sock.on('error', e => log('PLC socket:', e.message));
  }

  if (L.connect) {
    const [host, port] = String(L.connect).split(':');
    let warned = false;
    const tryConnect = () => {
      const s = net.connect({ host, port: +port }, () => { warned = false; attach(s, `${host}:${port}`); });
      s.on('error', e => { if (!warned) { log(`PLC ${host}:${port} not reachable (${e.code || e.message}), retrying every ${L.reconnectMs || 1000} ms`); warned = true; } });
      s.on('close', () => setTimeout(() => { if (!plc) tryConnect(); }, L.reconnectMs || 1000));
    };
    tryConnect();
    log(`connecting to the PLC at ${L.connect}`);
  } else {
    const port = +(portArg || L.listen || 2000);
    net.createServer(s => attach(s, `${s.remoteAddress}:${s.remotePort}`)).listen(port, () => log(`waiting for the PLC on TCP port ${port}`));
  }

  // ---- PLS -> tagger
  function onBlock(blk) {
    lastRx = mono();
    if (seqField) {
      const seqNow = readField(L, blk, seqField), max = CODEC[seqField.type].max + 1;
      if (lastSeq !== null && seqNow !== (lastSeq + 1) % max) {
        rxGaps++;
        toHub({ type: 'update', tag: T('rx_gaps'), value: rxGaps });
        if (rxGaps <= 5) log(`sequence jump: ${lastSeq} -> ${seqNow}`);
      }
      lastSeq = seqNow;
    }
    if (dump) { log(`<- PLC block (${blk.length} bytes)`); console.log(hexdump(blk)); }
    const vals = decodeBlock(L, from, blk);
    lastDtl = vals.__dtl || {};
    delete vals.__dtl;
    if (!link) {
      link = true;
      toHub({ type: 'update', tag: T('link'), value: true });
      event('info', everLinked ? 'Data from the PLC again' : `First block from the PLC (${blk.length} bytes)`);
      everLinked = true;
      sent = {};
    }
    publishFrom(vals, false);
    events(vals);
  }

  // "info"-hendelser: logges her ved hver endring. Advarsler og alarmer er hubens (se registerTags).
  let prevVals = null;
  function events(vals) {
    const fire = (sev, text) => event(sev, text);
    if (prevVals) {
      for (const f of from.fields) {
        const v = vals[f.name], p = prevVals[f.name];
        if (f.event === 'info' && v !== p) {
          if (f.type === 'bool') { if (v) fire(f.event, f.text || `${f.name} on`); else fire('info', `${f.text || f.name} cleared`); }
          else if (v) fire(f.event, (f.text || `${f.name} = {value}`).replace('{value}', v));
          else fire('info', `${(f.text || f.name).replace('{value}', p)} cleared`);
        }
        for (const bt of f.bits || []) {
          if (bt.event !== 'info' || vals[bt.name] === prevVals[bt.name]) continue;
          if (vals[bt.name]) fire(bt.event, bt.text || `${bt.name} on`); else fire('info', `${bt.text || bt.name} cleared`);
        }
      }
    }
    prevVals = vals;
  }

  let lastVals = {};
  function publishFrom(vals, full) {
    if (vals) lastVals = vals;
    const now = Date.now(), m = mono();                  // veggklokke bare for DTL-alderne nedenfor
    const everything = full || m - lastFull > 1000;     // trender får et punkt minst hvert sekund
    if (everything) lastFull = m;
    const out = {};
    for (const [k, v] of Object.entries(lastVals)) if (everything || sent[k] !== v) { out[T(k)] = v; sent[k] = v; }
    for (const f of from ? from.fields : []) {
      if (!f.age) continue;
      const ms = dtlMs(lastDtl[f.name], f.utc);
      // ageFrom: målt mot et tidsstempel i samme blokk (PLS-ens egen klokke)
      const ref = f.ageFrom ? dtlMs(lastDtl[f.ageFrom], from.fields.find(x => x.name === f.ageFrom).utc) : now;
      const age = ms === null || ref === null ? null : Math.max(0, Math.round((ref - ms) / 1000));
      if (everything || sent[f.name + '_age'] !== age) { out[T(f.name + '_age')] = age; sent[f.name + '_age'] = age; }
    }
    if (Object.keys(out).length) toHub({ type: 'update', values: out, quality: link ? 'good' : 'bad' });
  }

  function goStale(why) {
    if (!link && lastRx) return;
    link = false;
    toHub({ type: 'update', tag: T('link'), value: false });
    // behold de siste verdiene synlige, men merket som foreldet (stale)
    const out = {};
    for (const [k, v] of Object.entries(lastVals)) out[T(k)] = v;
    if (Object.keys(out).length) toHub({ type: 'update', values: out, quality: 'bad' });
    // selve alarmen hører til link-taggen (se registerTags): dette sier bare hvorfor, i loggen
    if (why !== 'PLC disconnected' && lastRx) event('info', `No data from the PLC for ${Math.round(timeoutMs / 1000)} s (${why})`);
  }
  setInterval(() => {
    if (link && mono() - lastRx > timeoutMs) goStale('timeout');
    if (link) publishFrom(null, false);   // holder _age-taggene og trendene i gang
  }, 250);

  // ---- tagger -> PLS
  function publishCmd() {
    if (!to) return;
    const out = {};
    for (const f of to.fields) {
      out[T(f.name)] = cmd[f.name];
      for (const bt of f.bits || []) out[T(bt.name)] = ((cmd[f.name] >>> bt.bit) & 1) === 1;
    }
    toHub({ type: 'update', values: out });
  }

  function sendCmd(why) {
    if (!to || !to.enabled || !plc) return false;
    const buf = encodeBlock(L, to, cmd, seq++);
    plc.write(buf);
    if (dump) { log(`-> PLC command block (${why})`); console.log(hexdump(buf)); }
    return true;
  }
  const scheduleSend = () => { clearTimeout(sendTimer); sendTimer = setTimeout(() => sendCmd('change'), 20); };
  if (to && to.enabled && to.sendEveryMs > 0) setInterval(() => sendCmd('keep-alive'), to.sendEveryMs);

  // ekkoet for én kommandotag: det som nå står i kommandoblokken
  function echo(name) {
    const f = toByName.get(name);
    if (!f) return;
    const out = { [T(f.name)]: cmd[f.name] };
    for (const bt of f.bits || []) out[T(bt.name)] = ((cmd[f.name] >>> bt.bit) & 1) === 1;
    toHub({ type: 'update', values: out });
  }

  // Hold-for-å-kjøre: HMI-en gjentar "trykket" mens knappen holdes. Stopper gjentakelsene
  // (nettleser lukket, nettbrett i dvale, Wi-Fi borte), faller biten etter `hold` ms. Den blir
  // så stående av til HMI-en sender et slipp, så trykk bufret under et brudd ikke kan starte den igjen.
  function holdExpired(f) {
    holdTimers.delete(f.name);
    if (!cmd[f.name]) return;
    cmd[f.name] = false;
    holdBlocked.add(f.name);
    event('warning', `${T(f.name)} released: the hold-to-run signal stopped arriving (browser, tablet or network lost?)`);
    echo(f.name);
    sendCmd('hold released');
  }

  function onWrite(m) {
    const key = String(m.tag).slice(L.device.length + 1);
    const f = toByName.get(key), owner = bitOwner.get(key);
    const refuse = why => { event('warning', `${m.tag} not changed: ${why}`); if (f) echo(f.name); else if (owner) echo(owner.f.name); };
    if (!f && !owner) return refuse('it is sent by the PLC and is read-only');
    if (!to.enabled) return refuse('sending to the PLC is disabled in the layout (toPlc.enabled)');
    if (!plc) return refuse('the PLC is not connected');
    const target = owner ? owner.f : f;
    const before = cmd[target.name];
    if (owner) {
      const on = m.value === true || m.value === 1 || m.value === 'true';
      cmd[owner.f.name] = on ? cmd[owner.f.name] | (1 << owner.bit) : cmd[owner.f.name] & ~(1 << owner.bit);
    } else {
      const v = coerce(f, m.value);
      if (v === null) return refuse(`"${m.value}" is not a number`);
      if (f.type !== 'bool' && !CODEC[f.type].float && v !== Number(m.value)) event('warning', `${m.tag}: ${m.value} limited to ${v} (${f.type})`);
      if (f.hold) {
        if (v && holdBlocked.has(f.name)) {
          // fortsatt trykket fra før bruddet: vent på et slipp
          if (!holdWarned.has(f.name)) { event('warning', `${m.tag}: release the button and press again`); holdWarned.add(f.name); }
          echo(f.name);
          return;
        }
        clearTimeout(holdTimers.get(f.name));
        if (v) holdTimers.set(f.name, setTimeout(() => holdExpired(f), f.hold));
        else { holdTimers.delete(f.name); holdBlocked.delete(f.name); holdWarned.delete(f.name); }
      }
      cmd[f.name] = v;
      if (f.autoReset && v) {
        clearTimeout(resetTimers.get(f.name));
        resetTimers.set(f.name, setTimeout(() => { cmd[f.name] = f.type === 'bool' ? false : 0; echo(f.name); sendCmd('auto-reset'); }, f.autoReset));
      }
    }
    echo(target.name);
    // gjentakelser av en uendret verdi (hold-for-å-kjøre) trenger ingen egen blokk:
    // keep-alive bærer dem
    if (cmd[target.name] !== before) scheduleSend();
  }

  connectHub();
}

// ================================================================ frames-modus (ESP32-format)
function loadFrames(L) {
  if (!Array.isArray(L.tags) || !L.tags.length) throw new Error('layout has no tags');
  let offset = 0;
  L.tags.forEach((t, i) => {
    const type = ALIAS[String(t.type).toLowerCase()];
    if (!type || type === 'dtl') throw new Error(`tag "${t.name}": unknown type "${t.type}"`);
    t.codec = type === 'bool' ? 'boolbyte' : type;
    t.offset = t.offset === undefined ? offset : t.offset;
    t.size = CODEC[t.codec].size;
    t.index = i;
    t.scale = typeof t.scale === 'number' && t.scale !== 0 ? t.scale : 1;
    offset = Math.max(offset, t.offset + t.size);
  });
  L.frameSize = offset;
  return L;
}

function runFrames(L, hubUrl, portArg) {
  const WebSocket = require('ws');
  const PORT = Number(portArg || process.env.BIN_PORT || 9100);
  const F_TELEMETRY = 0x01, F_WRITE = 0x02, F_EVENT = 0x03, F_HELLO = 0x04, F_PING = 0x05, F_PONG = 0x06;
  const SEVERITY = ['info', 'warning', 'alarm'];
  const byName = new Map(L.tags.map(t => [t.name, t]));
  const sample = {};   // (ikke Object.fromEntries: den krever Node 12)
  for (const t of L.tags) sample[`device.${t.name}`] = 0;
  const jsonSize = JSON.stringify(sample).length + 30;
  log(`layout "${L.layout}": ${L.tags.length} tags, ${L.frameSize} bytes per frame`);
  log(`same data as named JSON would be roughly ${jsonSize} bytes - about ${(jsonSize / L.frameSize).toFixed(1)}x larger`);

  const frame = (type, payload = Buffer.alloc(0)) => {
    const out = Buffer.alloc(3 + payload.length);
    out.writeUInt16BE(1 + payload.length, 0);
    out.writeUInt8(type, 2);
    payload.copy(out, 3);
    return out;
  };
  function takeFrames(buf, onFrame) {
    let pos = 0;
    while (buf.length - pos >= 2) {
      const len = buf.readUInt16BE(pos);
      if (len < 1 || len > 8192) throw new Error(`bad frame length ${len}`);
      if (buf.length - pos - 2 < len) break;
      onFrame(buf.readUInt8(pos + 2), buf.subarray(pos + 3, pos + 2 + len));
      pos += 2 + len;
    }
    return buf.subarray(pos);
  }

  let seq = 0;
  net.createServer(sock => {
    const id = ++seq;
    log(`[${id}] device connected from ${sock.remoteAddress}:${sock.remotePort}`);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 20000);
    let buf = Buffer.alloc(0), deviceName = null, ws = null, hubOpen = false, framesSeen = 0;
    const T = name => `${deviceName}.${name}`;
    const toHub = m => { if (hubOpen) ws.send(JSON.stringify(m)); };

    function openHub(name) {
      deviceName = name;
      ws = new WebSocket(hubUrl);
      ws.on('open', () => {
        hubOpen = true;
        log(`[${id}] hub link open for "${deviceName}"`);
        toHub({ type: 'hello', role: 'adapter', name: deviceName });
        toHub({ type: 'register', tags: L.tags.map(t => ({ name: T(t.name), dataType: t.codec === 'boolbyte' ? 'boolean' : 'number', unit: t.unit || '', writable: !!t.writable })) });
      });
      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === 'write') onHubWrite(m);
        else if (m.type === 'error') log(`[${id}] hub error: ${m.message}`);
      });
      ws.on('close', () => { hubOpen = false; sock.end(); });
      ws.on('error', e => { log(`[${id}] hub error: ${e.message}`); sock.destroy(); });
    }
    function onHubWrite(m) {
      const name = String(m.tag).slice(deviceName.length + 1);
      const t = byName.get(name);
      if (!t) return log(`[${id}] write to unknown tag ${m.tag}`);
      if (!t.writable) return log(`[${id}] tag ${m.tag} is not writable`);
      const payload = Buffer.alloc(1 + t.size);
      payload.writeUInt8(t.index, 0);
      const raw = typeof m.value === 'boolean' ? (m.value ? 1 : 0) : Number(m.value) / t.scale;
      CODEC[t.codec].set(payload, 1, raw, false);
      sock.write(frame(F_WRITE, payload));
      log(`[${id}] write -> ${name} = ${m.value} (${1 + t.size} bytes)`);
    }
    function onTelemetry(payload) {
      if (payload.length < L.frameSize) return log(`[${id}] short telemetry frame: ${payload.length} of ${L.frameSize} bytes`);
      const values = {};
      for (const t of L.tags) {
        const v = CODEC[t.codec].get(payload, t.offset, false);
        values[T(t.name)] = typeof v === 'boolean' ? v : +(v * t.scale).toFixed(4);
      }
      toHub({ type: 'update', values });
      if (++framesSeen === 1) log(`[${id}] first frame decoded: ${JSON.stringify(values)}`);
    }
    function onFrame(type, payload) {
      switch (type) {
        case F_HELLO: {
          const name = payload.toString('utf8').trim() || `bin_${id}`;
          log(`[${id}] hello from "${name}"`);
          if (!ws) openHub(name);
          break;
        }
        case F_TELEMETRY:
          if (!deviceName) return log(`[${id}] telemetry before hello, ignored`);
          onTelemetry(payload);
          break;
        case F_EVENT: {
          if (!deviceName) return;
          const severity = SEVERITY[payload.readUInt8(0)] || 'info';
          const message = payload.subarray(1).toString('utf8');
          toHub({ type: 'event', severity, message });
          log(`[${id}] event ${severity}: ${message}`);
          break;
        }
        case F_PING: sock.write(frame(F_PONG)); break;
        default: log(`[${id}] unknown frame type 0x${type.toString(16)}`);
      }
    }
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      try { buf = takeFrames(buf, onFrame); } catch (e) { log(`[${id}] ${e.message} - dropping device`); sock.destroy(); }
      if (buf.length > 16384) { log(`[${id}] buffer overrun`); sock.destroy(); }
    });
    sock.on('close', () => { log(`[${id}] device disconnected after ${framesSeen} frames`); if (ws) ws.close(); });
    sock.on('error', e => { log(`[${id}] socket error: ${e.message}`); if (ws) ws.close(); });
  }).listen(PORT, () => log(`binary adapter (frames) listening on port ${PORT}, forwarding to ${hubUrl}`));
}

// ================================================================ start
module.exports = { loadLayout, decodeBlock, encodeBlock, readField, writeField, hexdump, CODEC, ALIAS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')).map(a => a.split('=')[0]));
  const flagValue = k => { const a = args.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
  const pos = args.filter(a => !a.startsWith('--'));
  const file = pos[0] || path.join(__dirname, 'binary-layouts', 'kjoreverk-layout.json');
  let L;
  try { L = loadLayout(file); } catch (e) { console.error(`Layout ${file}: ${e.message}`); process.exit(1); }
  const hubUrl = pos[1] || process.env.HUB_URL || 'ws://localhost:8080';
  if (flags.has('--map')) {
    if (L.mode === 'fixed') printMap(L);
    else for (const t of L.tags) console.log(`${String(t.offset).padStart(4)}  ${t.type.padEnd(8)} ${t.name}`);
    process.exit(0);
  }
  if (L.mode === 'fixed' && flagValue('--plc')) {
    // --plc=host:port kobler til PLS-en der; --plc=port venter på den på den porten
    const v = flagValue('--plc');
    if (v.includes(':')) { L.connect = v; } else { delete L.connect; L.listen = +v; }
  }
  if (L.mode === 'fixed') {
    L.name = flagValue('--name') || vehicleName() || '';   // navnet i huben; taggene beholder "device" som prefiks
    if (L.name && !NAME_RX.test(L.name)) { console.error(`--name=${L.name}: letters, digits, _ . - only`); process.exit(1); }
    if (flags.has('--commands') && L.toPlc && !L.toPlc.enabled) {
      L.toPlc.enabled = true;
      log('commands enabled from the command line (--commands); the layout itself has them disabled');
    }
    log(`binary adapter (fixed) for "${L.device}"${L.name && L.name !== L.device ? `, named ${L.name} in the hub` : ''}, layout ${path.basename(file)}; commands to the PLC ${L.toPlc && L.toPlc.enabled ? 'enabled' : 'DISABLED'}`);
    runFixed(L, hubUrl, pos[2], flags.has('--dump'));
  } else runFrames(L, hubUrl, pos[2]);
}
