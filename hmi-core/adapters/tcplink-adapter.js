#!/usr/bin/env node
'use strict';
/*
 * tcplink-adapter.js - forbindelsen til en PLS med TcpLink-blokken, med navnene fra PLS-en.
 *
 * TcpLink (se TCP_LINK.md i PLS-prosjektet) sender dataene som plasser i arrayer: bits, words,
 * times, ints, dints og reals. Headeren på hver melding sier hvor store arrayene er, og ved hver
 * tilkobling sender PLS-en navnene på plassene (TcpLinkNames). Adapteren trenger derfor ingen
 * layoutfil:
 *
 *   - én tag per plass, oppkalt etter plassen: kv_1.bit00, kv_1.words_0, kv_1.reals_0, og
 *     kv_1.cmd_bit00, kv_1.cmd_ints_0 ... for kommandoene tilbake
 *   - navnet fra PLS-en blir taggens navn i HMI-en (label), og en [enhet] til slutt i navnet på
 *     en tallplass blir enheten: 'Hastighet [rpm]' gir Hastighet, rpm
 *   - endrer du størrelsen på en UDT, eller et navn, i PLS-en, registrerer adapteren taggene
 *     på nytt ved neste tilkobling (eller på en flanke på resendNames)
 *
 * Taggen er plassen, og den endres aldri. Navnet er det som vises. Gir du en plass et nytt navn
 * i PLS-en, beholder skjermbilder, beregninger og historikk koblingen sin.
 * Et navn du selv gir en tag i HMI-en (tagnavn), går foran navnet fra PLS-en.
 *
 * Det PLS-en ikke kan si noe om (hvilken plass som er en feilkode med alarm, hvilken
 * kommandobit som er hold-for-å-kjøre), står i en valgfri innstillingsfil, se
 * adapters/tcplink-options/kjoreverk-options.json.
 *
 * Bruk:
 *   node adapters/tcplink-adapter.js                        innstillingene i tcplink-options/kjoreverk-options.json
 *   node adapters/tcplink-adapter.js <options.json>         andre innstillinger
 *   node adapters/tcplink-adapter.js --plc=10.0.123.51:2000 koble til PLS-en der (overstyrer "connect")
 *   node adapters/tcplink-adapter.js --device=kv_2          tagprefikset (overstyrer "device")
 *   node adapters/tcplink-adapter.js ws://10.0.0.5:8080     en hub på en annen maskin (ellers HUB_URL eller ws://localhost:8080)
 *   node adapters/tcplink-adapter.js --no-commands          send bare nuller til PLS-en: HMI-en kan ikke styre noe
 *   node adapters/tcplink-adapter.js --dump                 logg hver melding i hex mens den kjører
 *
 * Bare det som er innebygd i Node, pluss ws for huben. Kjører på Node 10 og nyere.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// Tidsintervaller bruker en monoton klokke, så å stille datamaskinens klokke kan ikke utløse
// eller blinde vakthunden for forbindelsen.
const { performance } = require('perf_hooks');
const mono = () => performance.now();

// ================================================================ formatet på linjen
// Big-endian overalt. Se TCP_LINK.md avsnitt 5.
const UP_MAGIC = 0xa5, UP_VER = 7, UP_HDR = 32;     // PLS -> PC, format 7
const DN_MAGIC = 0x5a, DN_VER = 3, DN_HDR = 14;     // PC -> PLS, format 3
const KIND_DATA = 0, KIND_NAMES = 1;                // byte 7 i meldingen fra PLS-en
const LEN_MAX = 8192;                               // TSEND sitt tak; alt større er en falsk header

// De tolv layoutplassene, i rekkefølgen på linjen. Bits oppgis i byte, resten i antall elementer.
//   key    navnet i navnemeldingen          tag    taggen for plass i
//   size   byte per element                  udt    hvor plassen ligger i PLS-en (beskrivelsen)
const pad2 = i => (i < 10 ? '0' + i : String(i));
const SECTIONS = [
  { key: 'tx_bits', kind: 'bool', tag: i => 'bit' + pad2(i), udt: 'txDigital.bits' },
  { key: 'tx_words', kind: 'word', size: 2, tag: i => 'words_' + i, udt: 'txDigital.words' },
  { key: 'tx_times', kind: 'dtl', size: 12, tag: i => 'times_' + i, udt: 'txDigital.times' },
  { key: 'tx_ints', kind: 'int', size: 2, tag: i => 'ints_' + i, udt: 'txAnalog.ints', numeric: true },
  { key: 'tx_dints', kind: 'dint', size: 4, tag: i => 'dints_' + i, udt: 'txAnalog.dints', numeric: true },
  { key: 'tx_reals', kind: 'real', size: 4, tag: i => 'reals_' + i, udt: 'txAnalog.reals', numeric: true },
  { key: 'rx_bits', kind: 'bool', tag: i => 'cmd_bit' + pad2(i), udt: 'rx.bits', cmd: true },
  { key: 'rx_words', kind: 'word', size: 2, tag: i => 'cmd_words_' + i, udt: 'rx.words', cmd: true },
  { key: 'rx_times', kind: 'dtl', size: 12, tag: i => 'cmd_times_' + i, udt: 'rx.times', cmd: true },
  { key: 'rx_ints', kind: 'int', size: 2, tag: i => 'cmd_ints_' + i, udt: 'rx.ints', cmd: true, numeric: true },
  { key: 'rx_dints', kind: 'dint', size: 4, tag: i => 'cmd_dints_' + i, udt: 'rx.dints', cmd: true, numeric: true },
  { key: 'rx_reals', kind: 'real', size: 4, tag: i => 'cmd_reals_' + i, udt: 'rx.reals', cmd: true, numeric: true },
];
const RANGE = { word: [0, 65535], int: [-32768, 32767], dint: [-2147483648, 2147483647] };

// antall plasser i en seksjon: bits oppgis i byte
const slots = (s, n) => (s.kind === 'bool' ? n * 8 : n);
const bytesOf = (s, n) => (s.kind === 'bool' ? n : n * s.size);
function sectionLen(lay, from) {
  let n = 0;
  for (let k = 0; k < 6; k++) n += bytesOf(SECTIONS[from + k], lay[from + k]);
  return n;
}

// S7-strenger bruker én byte per tegn, og TIA skriver dem som Windows-1252. Egen tabell i stedet
// for TextDecoder: den finnes ikke i Node 10, og ikke i Node-utgaver uten full ICU.
const CP1252_80 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
function cp1252(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] >= 0x80 && b[i] < 0xa0 ? CP1252_80[b[i] - 0x80] : b[i]);
  return s;
}

// S7 DTL, 12 byte: år UInt, måned, dag, ukedag, time, minutt, sekund (USInt hver), nanosekund UDInt
const readDTL = (m, o) => ({ year: m.readUInt16BE(o), month: m[o + 2], day: m[o + 3], hour: m[o + 5], minute: m[o + 6], second: m[o + 7], ns: m.readUInt32BE(o + 8) });
// 1970 = aldri satt (en DTL starter der)
function dtlMs(d, utc) {
  if (!d || d.year <= 1970) return null;
  const a = [d.year, d.month - 1, d.day, d.hour, d.minute, d.second, Math.floor(d.ns / 1e6)];
  return utc ? Date.UTC(a[0], a[1], a[2], a[3], a[4], a[5], a[6]) : new Date(a[0], a[1], a[2], a[3], a[4], a[5], a[6]).getTime();
}
// vises i denne maskinens lokaltid
function dtlText(d, utc) {
  const ms = dtlMs(d, utc);
  if (ms === null) return '';
  const t = new Date(ms), p = x => pad2(x);
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

// En komplett navnemelding -> { tx_bits: ['Start', ''], ... }, eller null hvis den ikke henger
// sammen. Hver S7-streng er [deklarert lengde][nåværende lengde][deklarerte tegn]; lengdene er
// partall, så strengene følger rett etter hverandre og må slutte nøyaktig ved len.
function walkNames(m, length) {
  const out = {};
  let off = UP_HDR;
  for (let s = 0; s < SECTIONS.length; s++) {
    const names = [];
    for (let n = m[8 + s]; n > 0; n--) {
      if (off + 2 > length) return null;
      const max = m[off], cur = m[off + 1];
      if (max % 2 || cur > max || off + 2 + max > length) return null;
      names.push(cp1252(m.subarray(off + 2, off + 2 + cur)).trim());
      off += 2 + max;
    }
    out[SECTIONS[s].key] = names;
  }
  return off === length ? out : null;
}

// Returnerer { kind, frame, rest, skipped }, med frame null når flere byte trengs.
// TCP er en bytestrøm: let etter headeren. En header teller bare når alt i den stemmer: for
// data må len passe med layouten, for navn må reservebytene være null og strengene slutte ved len.
function nextFrame(buf) {
  let skipped = 0;
  for (;;) {
    const start = buf.indexOf(UP_MAGIC);
    if (start < 0) return { kind: null, frame: null, rest: Buffer.alloc(0), skipped: skipped + buf.length };
    skipped += start;
    buf = buf.subarray(start);
    if (buf.length < UP_HDR) return { kind: null, frame: null, rest: buf, skipped };
    const ver = buf[1], kind = buf[7], length = buf.readUInt16BE(2);
    if (ver === UP_VER && kind === KIND_DATA && length === UP_HDR + sectionLen(buf.subarray(8, 20), 0)) {
      if (buf.length < length) return { kind: null, frame: null, rest: buf, skipped };
      return { kind: KIND_DATA, frame: buf.subarray(0, length), rest: buf.subarray(length), skipped };
    }
    if (ver === UP_VER && kind === KIND_NAMES && length <= LEN_MAX && buf[6] === 0 && buf[16] === 0 &&
        buf.subarray(20, 32).every(x => x === 0) && length >= UP_HDR + 2 * buf.subarray(8, 20).reduce((a, x) => a + x, 0)) {
      if (buf.length < length) return { kind: null, frame: null, rest: buf, skipped };
      if (walkNames(buf, length) !== null) return { kind: KIND_NAMES, frame: buf.subarray(0, length), rest: buf.subarray(length), skipped };
    }
    buf = buf.subarray(1);              // falsk header inne i innholdet
    skipped++;
  }
}

// En datamelding -> { seq, utc, ts, layout, values: { bit00: true, reals_0: 1450.2, ... }, dtl: { times_0: {...} } }
function decodeData(m) {
  const lay = [...m.subarray(8, 20)];
  const utc = (m[6] & 1) === 0;
  const values = {}, dtl = { ts: readDTL(m, 20) };
  let off = UP_HDR;
  for (let k = 0; k < 6; k++) {
    const s = SECTIONS[k], n = lay[k];
    for (let i = 0; i < slots(s, n); i++) {
      const name = s.tag(i);
      if (s.kind === 'bool') values[name] = ((m[off + (i >> 3)] >> (i & 7)) & 1) === 1;
      else if (s.kind === 'word') values[name] = m.readUInt16BE(off + 2 * i);
      else if (s.kind === 'int') values[name] = m.readInt16BE(off + 2 * i);
      else if (s.kind === 'dint') values[name] = m.readInt32BE(off + 4 * i);
      else if (s.kind === 'real') values[name] = +m.readFloatBE(off + 4 * i).toPrecision(7);
      else if (s.kind === 'dtl') { dtl[name] = readDTL(m, off + 12 * i); values[name] = dtlText(dtl[name], utc); }
    }
    off += bytesOf(s, n);
  }
  values.ts = dtlText(dtl.ts, utc);
  values.ts_is_local = !utc;
  return { seq: m.readUInt16BE(4), utc, layout: lay, values, dtl };
}

// Kommandorammen i størrelsene PLS-en ba om (layout[6..11]); en plass som mangler i cmd, er 0.
function encodeCommands(seq, lay, cmd) {
  const rx = lay.slice(6, 12);
  const b = Buffer.alloc(DN_HDR + sectionLen(lay, 6));
  b[0] = DN_MAGIC; b[1] = DN_VER;
  b.writeUInt16BE(b.length, 2);
  b.writeUInt16BE(seq & 0xffff, 4);
  Buffer.from(rx).copy(b, 8);
  let off = DN_HDR;
  for (let k = 6; k < 12; k++) {
    const s = SECTIONS[k], n = lay[k];
    for (let i = 0; i < slots(s, n); i++) {
      const v = cmd[s.tag(i)];
      if (s.kind === 'bool') { if (v) b[off + (i >> 3)] |= 1 << (i & 7); }
      else if (s.kind === 'word') b.writeUInt16BE(v || 0, off + 2 * i);
      else if (s.kind === 'int') b.writeInt16BE(v || 0, off + 2 * i);
      else if (s.kind === 'dint') b.writeInt32BE(v || 0, off + 4 * i);
      else if (s.kind === 'real') b.writeFloatBE(v || 0, off + 4 * i);
    }
    off += bytesOf(s, n);
  }
  return b;
}

// 'Moment [Nm]' -> { label: 'Moment', unit: 'Nm' }, bare for tallplasser og bare helt til slutt,
// som i klientene i PLS-prosjektet. Bits, words, times og kommandobits beholder hele teksten.
function splitUnit(s, text) {
  const m = s.numeric && /^(.*\S)\s*\[([^[\]]+)\]$/.exec(text);
  return m ? { label: m[1], unit: m[2].trim() } : { label: text, unit: '' };
}

function hexdump(buf, cols = 16) {
  const lines = [];
  for (let i = 0; i < buf.length; i += cols) {
    lines.push(`  ${String(i).padStart(4)}  ${[...buf.subarray(i, i + cols)].map(x => x.toString(16).padStart(2, '0')).join(' ')}`);
  }
  return lines.join('\n');
}

// ================================================================ innstillingene
const NAME_RX = /^[A-Za-z_][\w.-]*$/;
const EVENT_SEVERITIES = ['info', 'warning', 'alarm'];
const isAlarm = o => o.event === 'warning' || o.event === 'alarm';
const TX_SLOT = /^(bit\d{2,}|(words|times|ints|dints|reals)_\d+)$/;
const CMD_SLOT = /^(cmd_bit\d{2,}|cmd_(words|ints|dints|reals)_\d+)$/;

function loadOptions(file) {
  let o = {};
  if (file) {
    // Notepad kan lagre et byte-order mark
    try { o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch (e) { throw new Error(`${file}: ${e.message}`); }
  }
  o.tags = o.tags || {};
  for (const [name, t] of Object.entries(o.tags)) {
    const where = `"tags"."${name}"`;
    if (!t || typeof t !== 'object') throw new Error(`${where} should be an object`);
    const tx = TX_SLOT.test(name), cmd = CMD_SLOT.test(name);
    if (!tx && !cmd) throw new Error(`${where}: not a TcpLink slot (bit00, words_0, ints_0, dints_0, reals_0, cmd_bit00, cmd_ints_0 ...)`);
    const allowed = tx ? ['event', 'text', 'codes', 'delay', 'bits', 'description'] : ['hold', 'autoReset', 'description'];
    for (const k of Object.keys(t)) {
      if (k.charAt(0) === '_') continue;   // kommentarer
      if (!allowed.includes(k)) throw new Error(`${where}: "${k}" is not an option for ${tx ? 'a slot from the PLC' : 'a command'} (${allowed.join(', ')})`);
    }
    if (t.event !== undefined && !EVENT_SEVERITIES.includes(t.event)) throw new Error(`${where}: event must be ${EVENT_SEVERITIES.join(', ')} (not "${t.event}")`);
    if (t.hold !== undefined) {
      if (!/^cmd_bit/.test(name)) throw new Error(`${where}: "hold" is for command bits only`);
      if (!(t.hold >= 100)) throw new Error(`${where}: hold must be at least 100 ms`);
      if (t.autoReset) throw new Error(`${where}: has both "hold" and "autoReset" - pick one`);
    }
    if (t.autoReset !== undefined && !(t.autoReset >= 50)) throw new Error(`${where}: autoReset must be at least 50 ms`);
    if (t.bits !== undefined) {
      if (!/^(words|ints|dints)_/.test(name)) throw new Error(`${where}: "bits" needs a word, int or dint`);
      const width = /^dints_/.test(name) ? 32 : 16;
      t.bitList = Object.entries(t.bits).map(([k, v]) => {
        const d = typeof v === 'string' ? { name: v } : v;
        if (!(+k >= 0 && +k < width)) throw new Error(`${where}: bit ${k} doesn't exist in a ${width}-bit value`);
        if (!d || !NAME_RX.test(d.name || '')) throw new Error(`${where}: bit ${k} needs a name (letters, digits, _ . -)`);
        if (d.event !== undefined && !EVENT_SEVERITIES.includes(d.event)) throw new Error(`${where}: bit ${k} event must be ${EVENT_SEVERITIES.join(', ')}`);
        return { bit: +k, name: d.name, event: d.event, text: d.text, description: d.description || '' };
      });
    }
  }
  return o;
}

// ================================================================ adapteren
function run(o, hubUrl, dump) {
  const WebSocket = require('ws');
  const D = o.device;
  const T = n => `${D}.${n}`;
  const timeoutMs = o.timeoutMs || 3000;          // så lenge uten melding før taggene blir foreldet
  const dropMs = Math.max(timeoutMs * 3, 10000);  // så lenge før forbindelsen kobles opp på nytt
  const sendEveryMs = o.sendEveryMs || 500;       // godt under rxTimeout (2 s) i PLS-en
  const reconnectMs = o.reconnectMs || 2000;
  const commands = o.commands !== false;
  const opt = name => o.tags[name] || {};

  let ws = null, hubOpen = false;
  let plc = null, plcAt = '', rxBuf = Buffer.alloc(0), lastRx = 0, link = false, everLinked = false;
  let layout = null, layoutKey = '', names = null, namesKey = '', seqOut = 0, lastSeq = null, rxGaps = 0, lostBytes = 0;
  let registered = new Set();   // taggene adapteren har registrert hos huben nå
  let labels = new Map();       // plass -> navnet fra PLS-en, uten enheten
  const optWarned = new Set();
  let lastVals = {}, lastDtl = {}, lastUtc = true, sent = {}, lastFull = -Infinity, prevVals = null;

  // kommandobildet: det adapteren sender til PLS-en, per kommandotag
  const cmd = {};
  const holdTimers = new Map(), holdBlocked = new Set(), holdWarned = new Set(), resetTimers = new Map();
  const cmdSlots = () => {
    const out = [];
    if (layout) for (let k = 6; k < 12; k++) {
      if (SECTIONS[k].kind === 'dtl') continue;   // times i kommandorammen sendes som nuller
      for (let i = 0; i < slots(SECTIONS[k], layout[k]); i++) out.push({ s: SECTIONS[k], name: SECTIONS[k].tag(i) });
    }
    return out;
  };
  const cmdSlot = name => cmdSlots().find(x => x.name === name);
  function clearBits() {
    for (const k of Object.keys(cmd)) {
      if (!/^cmd_bit/.test(k)) continue;
      if (opt(k).hold && cmd[k]) { clearTimeout(holdTimers.get(k)); holdBlocked.add(k); }
      cmd[k] = false;
    }
  }

  const toHub = m => { if (hubOpen) ws.send(JSON.stringify(m)); };
  const event = (severity, message) => { log(`[${severity}] ${message}`); toHub({ type: 'event', severity, message }); };

  // ---- taggene: én per plass i layouten, med navnet fra PLS-en
  function nameOf(s, i) {
    const list = names && names[s.key];
    return list && i < list.length ? list[i] : '';
  }
  function tagList() {
    const tags = [
      { name: T('link'), dataType: 'boolean', description: 'true while messages arrive from the PLC',
        alarm: { severity: 'alarm', text: 'No data from the PLC', when: 'false', delay: 2000 } },
      { name: T('rx_gaps'), dataType: 'number', description: 'jumps in the PLC sequence number (lost or repeated messages)' },
      { name: T('ts'), dataType: 'string', description: 'the PLC clock when the message was built' },
      { name: T('ts_is_local'), dataType: 'boolean', description: 'true: the PLC sends local time, false: UTC' },
    ];
    labels = new Map();
    if (!layout) return tags;
    const alarmOf = (x, name, bool) => (isAlarm(x) ? { severity: x.event, text: x.text || (bool ? `${name} on` : `${name} = {value}`), codes: x.codes, delay: x.delay } : undefined);
    for (let k = 0; k < SECTIONS.length; k++) {
      const s = SECTIONS[k];
      if (s.kind === 'dtl' && s.cmd) continue;     // ingen times i retning PC -> PLS
      for (let i = 0; i < slots(s, layout[k]); i++) {
        const name = s.tag(i), x = opt(name), n = splitUnit(s, nameOf(s, i));
        if (n.label) labels.set(name, n.label);
        const dataType = s.kind === 'bool' ? 'boolean' : s.kind === 'dtl' ? 'string' : 'number';
        tags.push({ name: T(name), dataType, unit: n.unit, label: n.label, writable: !!s.cmd,
          description: x.description || `${s.udt}[${i}] in the PLC`,
          alarm: s.cmd ? undefined : alarmOf(x, n.label || name, s.kind === 'bool') });
        if (s.kind === 'dtl') tags.push({ name: T(name + '_age'), dataType: 'number', unit: 's', label: n.label ? n.label + ' (age)' : '',
          description: `seconds from ${name} to the PLC clock (ts)` });
        for (const bt of x.bitList || []) tags.push({ name: T(bt.name), dataType: 'boolean', description: bt.description || `bit ${bt.bit} of ${name}`,
          alarm: alarmOf(bt, bt.name, true) });
      }
    }
    return tags;
  }
  function registerTags(why) {
    const tags = tagList();
    const now = new Set(tags.map(t => t.name));
    toHub({ type: 'register', tags });
    // plasser som ikke finnes lenger (en mindre UDT): vis dem som foreldet
    const gone = {};
    for (const n of registered) if (!now.has(n)) gone[n] = null;
    if (Object.keys(gone).length) toHub({ type: 'update', values: gone, quality: 'bad' });
    registered = now;
    sent = {};
    if (why) log(`registered ${tags.length} tags (${why})`);
    for (const name of Object.keys(o.tags)) {
      if (!layout || now.has(T(name)) || optWarned.has(name)) continue;
      optWarned.add(name);
      log(`warning: options for "${name}", but the PLC has no such slot`);
    }
  }

  // ---- huben
  function connectHub() {
    ws = new WebSocket(hubUrl);
    ws.on('open', () => {
      hubOpen = true;
      log(`hub ${hubUrl} connected as ${D}`);
      toHub({ type: 'hello', role: 'adapter', name: D });
      registered = new Set();
      registerTags();
      toHub({ type: 'update', values: { [T('link')]: link, [T('rx_gaps')]: rxGaps } });
      publish(null, true);
      publishCmd();
    });
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type === 'write') onWrite(m);
      else if (m.type === 'error') log('hub error:', m.message);
    });
    ws.on('close', () => {
      if (hubOpen) {
        log('hub connection lost, retrying in 2 s');
        // ingen kan se eller stoppe maskinen via HMI-en nå: slipp kommandobitene
        if ((o.onHubLoss || 'clearBits') === 'clearBits') { clearBits(); sendCmd('hub connection lost'); }
      }
      hubOpen = false;
      setTimeout(connectHub, 2000);
    });
    ws.on('error', () => {});
  }

  // ---- PLS-en: den er den passive siden og lytter; adapteren kobler til
  const [host, port] = String(o.connect).split(':');
  let warned = false;
  function connectPlc() {
    const sock = net.connect({ host, port: +port });
    let up = false;
    sock.on('connect', () => {
      up = true; warned = false;
      plc = sock; plcAt = `${host}:${port}`; rxBuf = Buffer.alloc(0); lastSeq = null; lastRx = mono();
      // ingenting går ut før den første datameldingen har fortalt hvordan kommandorammen skal se ut
      layout = null;
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 5000);
      event('info', `PLC connected at ${plcAt}`);
      if ((o.onReconnect || 'clearBits') === 'clearBits') { clearBits(); publishCmd(); }
    });
    sock.on('data', onData);
    sock.on('error', e => {
      if (up) log('PLC socket:', e.message);
      else if (!warned) { log(`PLC ${host}:${port} not reachable (${e.code || e.message}), retrying every ${reconnectMs / 1000} s`); warned = true; }
    });
    sock.on('close', () => {
      if (plc === sock) {
        plc = null;
        event('info', 'PLC disconnected');   // alarmen for forbindelsen følger (se tagList)
        goStale('PLC disconnected');
      }
      setTimeout(connectPlc, reconnectMs);
    });
  }

  function onData(chunk) {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    for (;;) {
      const r = nextFrame(rxBuf);
      rxBuf = r.rest;
      if (r.skipped) {
        if (!lostBytes) event('warning', 'Message from the PLC not understood; looking for the next header');
        lostBytes += r.skipped;
      }
      if (!r.frame) break;
      if (lostBytes) { event('info', `Back in step with the PLC after skipping ${lostBytes} bytes`); lostBytes = 0; }
      lastRx = mono();
      const seq = r.frame.readUInt16BE(4);   // navn og data deler telleren
      if (lastSeq !== null && seq !== ((lastSeq + 1) & 0xffff)) {
        rxGaps++;
        toHub({ type: 'update', tag: T('rx_gaps'), value: rxGaps });
        if (rxGaps <= 5) log(`sequence jump: ${lastSeq} -> ${seq}`);
      }
      lastSeq = seq;
      if (dump) { log(`<- PLC ${r.kind === KIND_NAMES ? 'names' : 'data'} (${r.frame.length} bytes)`); console.log(hexdump(r.frame)); }
      if (r.kind === KIND_NAMES) onNames(walkNames(r.frame, r.frame.length));
      else onDataFrame(decodeData(r.frame));
    }
    if (rxBuf.length > 4 * LEN_MAX) rxBuf = Buffer.alloc(0);   // kan ikke være en melding
  }

  function onNames(next) {
    const key = JSON.stringify(next);
    const count = Object.keys(next).reduce((a, k) => a + next[k].filter(Boolean).length, 0);
    if (key === namesKey) { log(`names from the PLC: unchanged (${count} named slots)`); return; }
    // hva som er endret, i loggen, så en ny nedlasting synes der
    const changed = [];
    if (names) {
      for (const s of SECTIONS) {
        const a = names[s.key] || [], b = next[s.key] || [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if ((a[i] || '') !== (b[i] || '')) changed.push(`${s.tag(i)} "${a[i] || ''}" -> "${b[i] || ''}"`);
        }
      }
    }
    names = next; namesKey = key;
    if (changed.length) event('info', `Names from the PLC changed: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}`);
    else log(`names from the PLC: ${count} named slots`);
    if (layout) registerTags('new names');
  }

  function onDataFrame(d) {
    const key = d.layout.join(',');
    if (key !== layoutKey || !layout) {
      if (layoutKey && key !== layoutKey) event('info', `The PLC changed its sizes: ${describe(d.layout)}`);
      else log(`PLC sizes: ${describe(d.layout)}`);
      layout = d.layout; layoutKey = key;
      if (layout[8]) log('warning: the PLC wants times in the command frame; they are sent as zeros');
      if (!names) log('no names from the PLC yet: the tags have only their slot names (bit00, reals_0 ...)');
      registerTags('layout');
      publishCmd();
      sendCmd('first message');
    } else layout = d.layout;
    lastDtl = d.dtl; lastUtc = d.utc;
    if (!link) {
      link = true;
      toHub({ type: 'update', tag: T('link'), value: true });
      event('info', everLinked ? 'Data from the PLC again' : 'First message from the PLC');
      everLinked = true;
      sent = {};
    }
    // bits i words, fra innstillingene
    for (const [name, x] of Object.entries(o.tags)) {
      if (!x.bitList || !(name in d.values)) continue;
      for (const bt of x.bitList) d.values[bt.name] = ((d.values[name] >>> bt.bit) & 1) === 1;
    }
    publish(d.values, false);
    infoEvents(d.values);
  }
  const describe = l => `tx ${l[0] * 8} bits, ${l[1]} words, ${l[2]} times, ${l[3]} ints, ${l[4]} dints, ${l[5]} reals; ` +
    `rx ${l[6] * 8} bits, ${l[7]} words, ${l[9]} ints, ${l[10]} dints, ${l[11]} reals`;

  // "info"-hendelser fra innstillingene: logges her ved hver endring. Advarsler og alarmer er hubens.
  function infoEvents(vals) {
    if (prevVals) {
      const check = (name, x, label) => {
        if (x.event !== 'info' || !(name in vals) || vals[name] === prevVals[name]) return;
        const text = (x.text || (typeof vals[name] === 'boolean' ? `${label} on` : `${label} = {value}`));
        if (vals[name]) event('info', text.replace('{value}', vals[name]));
        else event('info', `${text.replace('{value}', prevVals[name])} cleared`);
      };
      for (const [name, x] of Object.entries(o.tags)) {
        check(name, x, labels.get(name) || name);
        for (const bt of x.bitList || []) check(bt.name, bt, bt.name);
      }
    }
    prevVals = vals;
  }

  // endrede verdier til huben; alt minst én gang i sekundet, så trendene får et punkt
  function publish(vals, full) {
    if (vals) lastVals = vals;
    const m = mono(), everything = full || m - lastFull > 1000;
    if (everything) lastFull = m;
    const out = {};
    for (const k of Object.keys(lastVals)) {
      const v = lastVals[k];
      if (everything || sent[k] !== v) { out[T(k)] = v; sent[k] = v; }
    }
    // alderen til hver tid, målt mot PLS-klokka i samme melding: klokken på denne maskinen spiller ingen rolle
    const ref = dtlMs(lastDtl.ts, lastUtc);
    for (const k of Object.keys(lastDtl)) {
      if (k === 'ts') continue;
      const ms = dtlMs(lastDtl[k], lastUtc);
      const age = ms === null || ref === null ? null : Math.max(0, Math.round((ref - ms) / 1000));
      if (everything || sent[k + '_age'] !== age) { out[T(k + '_age')] = age; sent[k + '_age'] = age; }
    }
    if (Object.keys(out).length) toHub({ type: 'update', values: out, quality: link ? 'good' : 'bad' });
  }

  function goStale(why) {
    if (!link) return;
    link = false;
    toHub({ type: 'update', tag: T('link'), value: false });
    // behold de siste verdiene synlige, men merket som foreldet (stale)
    const out = {};
    for (const k of Object.keys(lastVals)) out[T(k)] = lastVals[k];
    if (Object.keys(out).length) toHub({ type: 'update', values: out, quality: 'bad' });
    if (why !== 'PLC disconnected') event('info', `No data from the PLC for ${Math.round(timeoutMs / 1000)} s (${why})`);
  }
  setInterval(() => {
    const quiet = mono() - lastRx;
    if (link && quiet > timeoutMs) goStale('timeout');
    // en forbindelse som er stille så lenge, er død selv om TCP ikke har merket det ennå
    if (plc && quiet > dropMs) { log(`nothing from the PLC for ${Math.round(quiet / 1000)} s: reconnecting`); plc.destroy(); }
    if (link) publish(null, false);
  }, 250);

  // ---- kommandoene
  function publishCmd() {
    const out = {};
    for (const x of cmdSlots()) out[T(x.name)] = cmdValue(x);
    if (Object.keys(out).length) toHub({ type: 'update', values: out });
  }
  const cmdValue = x => (x.name in cmd ? cmd[x.name] : x.s.kind === 'bool' ? false : 0);

  function sendCmd(why) {
    if (!plc || !layout) return false;
    // med --no-commands går det bare nuller ut: nok til å holde linken i live
    const buf = encodeCommands(++seqOut, layout, commands ? cmd : {});
    plc.write(buf);
    if (dump) { log(`-> PLC commands (${why})`); console.log(hexdump(buf)); }
    return true;
  }
  let sendTimer = null;
  const scheduleSend = () => { clearTimeout(sendTimer); sendTimer = setTimeout(() => sendCmd('change'), 20); };
  setInterval(() => sendCmd('keep-alive'), sendEveryMs);

  const echo = name => { const x = cmdSlot(name); if (x) toHub({ type: 'update', values: { [T(name)]: cmdValue(x) } }); };

  // Hold-for-å-kjøre: HMI-en gjentar "trykket" mens knappen holdes. Stopper gjentakelsene
  // (nettleser lukket, nettbrett i dvale, Wi-Fi borte), faller biten etter `hold` ms. Den blir
  // så stående av til HMI-en sender et slipp, så trykk bufret under et brudd ikke kan starte den igjen.
  function holdExpired(name) {
    holdTimers.delete(name);
    if (!cmd[name]) return;
    cmd[name] = false;
    holdBlocked.add(name);
    event('warning', `${T(name)} released: the hold-to-run signal stopped arriving (browser, tablet or network lost?)`);
    echo(name);
    sendCmd('hold released');
  }

  function onWrite(m) {
    const name = String(m.tag).slice(D.length + 1);
    const x = cmdSlot(name);
    const refuse = why => { event('warning', `${m.tag} not changed: ${why}`); echo(name); };
    if (!x) {
      if (CMD_SLOT.test(name)) return refuse(layout ? 'the PLC has no such command slot' : 'the PLC has not sent its sizes yet');
      return refuse('it is sent by the PLC and is read-only');
    }
    if (!commands) return refuse('commands to the PLC are off (--no-commands or "commands": false)');
    if (!plc) return refuse('the PLC is not connected');
    const before = cmdValue(x), o_ = opt(name);
    let v;
    if (x.s.kind === 'bool') v = m.value === true || m.value === 1 || m.value === 'true' || m.value === '1';
    else {
      const n = typeof m.value === 'boolean' ? (m.value ? 1 : 0) : Number(m.value);
      if (!Number.isFinite(n)) return refuse(`"${m.value}" is not a number`);
      if (x.s.kind === 'real') v = Math.fround(n);
      else {
        const r = RANGE[x.s.kind];
        v = Math.min(r[1], Math.max(r[0], Math.round(n)));
        if (v !== n) event('warning', `${m.tag}: ${m.value} limited to ${v} (${x.s.kind})`);
      }
    }
    if (o_.hold) {
      if (v && holdBlocked.has(name)) {
        // fortsatt trykket fra før bruddet: vent på et slipp
        if (!holdWarned.has(name)) { event('warning', `${m.tag}: release the button and press again`); holdWarned.add(name); }
        echo(name);
        return;
      }
      clearTimeout(holdTimers.get(name));
      if (v) holdTimers.set(name, setTimeout(() => holdExpired(name), o_.hold));
      else { holdTimers.delete(name); holdBlocked.delete(name); holdWarned.delete(name); }
    }
    cmd[name] = v;
    if (o_.autoReset && v) {
      clearTimeout(resetTimers.get(name));
      resetTimers.set(name, setTimeout(() => { cmd[name] = x.s.kind === 'bool' ? false : 0; echo(name); sendCmd('auto-reset'); }, o_.autoReset));
    }
    echo(name);
    // gjentakelser av en uendret verdi (hold-for-å-kjøre) trenger ingen egen ramme: keep-alive bærer dem
    if (v !== before) scheduleSend();
  }

  log(`connecting to the PLC at ${o.connect}`);
  connectPlc();
  connectHub();
}

// ================================================================ start
module.exports = { SECTIONS, nextFrame, walkNames, decodeData, encodeCommands, splitUnit, cp1252, loadOptions };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')).map(a => a.split('=')[0]));
  const flagValue = k => { const a = args.find(x => x.startsWith(k + '=')); return a ? a.slice(k.length + 1) : null; };
  const pos = args.filter(a => !a.startsWith('--'));
  const fileArg = pos.find(a => /\.json$/i.test(a));
  const hubUrl = pos.find(a => /^wss?:\/\//i.test(a)) || process.env.HUB_URL || 'ws://localhost:8080';
  const defaultFile = path.join(__dirname, 'tcplink-options', 'kjoreverk-options.json');
  const file = fileArg || (fs.existsSync(defaultFile) ? defaultFile : null);
  let o;
  try { o = loadOptions(file); } catch (e) { console.error(`Options ${e.message}`); process.exit(1); }
  if (flagValue('--plc')) o.connect = flagValue('--plc');
  if (flagValue('--device')) o.device = flagValue('--device');
  if (flags.has('--no-commands')) o.commands = false;
  if (!o.device || !NAME_RX.test(o.device)) { console.error('Set the tag prefix: "device" in the options file, or --device=kv_1'); process.exit(1); }
  if (!/^[^:\s]+:\d+$/.test(String(o.connect || ''))) { console.error('Set the PLC address: "connect" in the options file, or --plc=10.0.123.51:2000'); process.exit(1); }
  log(`TcpLink adapter for "${o.device}"${file ? `, options ${path.basename(file)}` : ''}; commands to the PLC ${o.commands !== false ? 'enabled' : 'OFF (only zeros are sent)'}`);
  run(o, hubUrl, flags.has('--dump'));
}
