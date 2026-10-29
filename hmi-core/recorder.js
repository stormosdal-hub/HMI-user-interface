#!/usr/bin/env node
'use strict';
/*
 * recorder.js - sender taggene og hendelsene reglene velger, til den sentrale serveren.
 *
 * Kjernefil, for Pi-en i hvert kjøreverk. Planen står i docs/PLAN.md, og hva som sendes, i
 * docs/PROTOKOLL.md. Recorderen:
 *   - kobler seg til huben to ganger: en leser (bare lesing: alle verdiene, tagoversikten,
 *     hendelsene og punktene som kommer tilbake fra ringen i PLS-en), og en historikktjeneste som
 *     svarer trendene i HMI-en med det serveren har, og melder statusen som rec.*-tagger
 *   - henter reglene fra serveren og holder dem i RAM (lib/record-rules.js). Fram til de er
 *     hentet, holdes hver endring som den er, og kjøres gjennom reglene når de kommer
 *   - samler det som skal lagres, i en kø i RAM, og sender den i batcher, én om gangen. En batch
 *     tas ut av køen først når serveren har lagret den. Er køen full, kastes de eldste, og
 *     serveren får vite om hullet
 *   - skriver aldri til disken: går strømmen mens serveren er utilgjengelig, er køen tapt
 *   - sender ingenting før klokka er synkronisert, og flytter punktene i køen hvis klokka hopper
 *   - fyller hullet etter en omstart fra hubens minne
 *
 *   node recorder.js [--config /etc/hmi-recorder.json] [ws://localhost:8080]
 *
 * Oppsettet er en JSON-fil som bare leses (config/recorder.example.json viser alt):
 *   { "vehicle": "kv07", "server": "http://dbserver:8090", "token": "...", "queueMB": 64, "sendSeconds": 10 }
 * Uten --config: /etc/hmi-recorder.json, ellers config/recorder.json. vehicle er vertsnavnet
 * hvis det mangler. --vehicle, --server, --token og --queue-mb overstyrer filen.
 *
 * Kjører på Node 10, som huben.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');
const { compilePatterns, compileRules, ruleFor, createRecorderRules, replayRules, checkRecording, eventWanted,
  activePauses, pauseMatcher, pauseText, localStamp } = require('./lib/record-rules');

const VERSION = '1.0.0';
const PROTOCOL = 1;

// ---------------------------------------------------------------- oppsettet
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function readSettings() {
  const given = opt('--config') || process.env.HMI_RECORDER_CONFIG;
  const files = given ? [given] : ['/etc/hmi-recorder.json', path.join(__dirname, 'config', 'recorder.json')];
  for (const f of files) {
    if (!given && !fs.existsSync(f)) continue;
    try { return { file: f, s: JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) }; }
    catch (e) { console.error(`The recorder's settings in ${f} can't be read: ${e.message}`); process.exit(1); }
  }
  return { file: null, s: {} };
}
const { file: SETTINGS_FILE, s: settings } = readSettings();
const HUB = args.find(a => /^wss?:\/\//.test(a)) || settings.hub || process.env.HUB_URL || 'ws://localhost:8080';
const VEHICLE = String(opt('--vehicle') || settings.vehicle || os.hostname()).trim();
const SERVER = String(opt('--server') || settings.server || '').trim().replace(/\/+$/, '');
const TOKEN = String(opt('--token') || settings.token || '').trim();
const QUEUE_MB = Number(opt('--queue-mb') || settings.queueMB) > 0 ? Number(opt('--queue-mb') || settings.queueMB) : 64;
const CLOCK_CHECK = settings.clockCheck !== false;   // false: stol på klokka uten å spørre systemet
if (!/^https?:\/\/[^/]+/.test(SERVER)) {
  console.error(`The recorder needs the central server's address, like "server": "http://dbserver:8090", in ${SETTINGS_FILE || '/etc/hmi-recorder.json'} (or --server).`);
  process.exit(1);
}
if (!TOKEN) log(`warning: no key ("token") for ${VEHICLE}; the server will refuse the data until one is set`);

const QUEUE_BYTES = QUEUE_MB * 1024 * 1024;
const SEND_EVERY = (Number(settings.sendSeconds) > 0 ? Number(settings.sendSeconds) : 10) * 1000;   // en batch så ofte, eller med en gang når det er mye
const BATCH_ITEMS = 20000;              // høyst så mange punkter per batch
const SYNC_EVERY = 60000;               // spør om klokka er synkronisert
const UNSYNCED_AFTER = 10 * 60000;      // svarer serveren, men klokka blir ikke synkronisert: send likevel etter så lenge
const BACKFILL_MARGIN = 5 * 60000;      // hullet fra hubens minne fylles med litt overlapp
const TIMEOUT = { hello: 15000, rules: 15000, ingest: 30000, history: 10000 };
const BOOT = (b => `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20)}`)(crypto.randomBytes(16).toString('hex'));
const mono = () => performance.now();
let startedAt = Date.now();

// ---------------------------------------------------------------- tagoversikten
const registry = new Map();   // navn -> { name, dataType, unit, label, description }
const names = new Map();      // samme tagnavn som én streng i minnet, ikke én per melding
const nameOf = s => { let x = names.get(s); if (x === undefined) { names.set(s, s); x = s; } return x; };
let catalogDirty = true;      // tagoversikten skal med i neste batch
function onTags(list) {
  let changed = false;
  for (const t of list || []) {
    if (!t || !t.name || t.name.startsWith('rec.')) continue;
    const info = { name: nameOf(t.name), dataType: t.dataType || 'number', unit: t.unit || '', label: t.label || '', description: t.info || t.description || '' };
    const prev = registry.get(info.name);
    if (!prev || prev.dataType !== info.dataType || prev.unit !== info.unit || prev.label !== info.label || prev.description !== info.description) {
      registry.set(info.name, info);
      changed = true;
    }
  }
  if (changed) catalogDirty = true;
}
const isText = (tag, v) => typeof v === 'string' || (v === null && registry.has(tag) && registry.get(tag).dataType === 'string');
// en verdi fra huben som den lagres: av/på som 1 og 0, dårlig kvalitet uten verdi; undefined: hoppes over
function stored(v, quality) {
  if (quality === 'bad' || v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  return undefined;
}

// ---------------------------------------------------------------- køen i RAM
// Et punkt: { k: 'pt' (tall, av/på) | 'txt', tag, ts, v, q, src }; en hendelse: { k: 'ev', ts, source,
// severity, message, src }. Før reglene er hentet, ligger endringene som de kom i `raw`:
// { k: 'upd', tag, v, quality, ts, m }, { k: 'grp', src, series } (fra ringen eller hubens minne) og hendelser.
let queue = [], queueBytes = 0;
let raw = [], rawBytes = 0, rawCount = 0;
const rawLast = new Map();    // tag -> siste verdi i `raw` ("v|quality"): bare endringer holdes
let inflight = null;          // batchen som sendes: { seq, items, bytes, gaps, catalog }
let seq = 0;
let gapsPending = [];         // hull som skal med i neste batch
let dropped = 0;              // punkter kastet siden oppstart fordi køen var full
let fullTold = false;
// omtrent hva et element koster i RAM, i byte (objektet, tallene og listene rundt)
const costOf = it => it.k === 'ev' ? 260 + 2 * String(it.message || '').length
  : it.k === 'grp' ? 120 * it.n
  : it.k === 'txt' ? 140 + 2 * String(it.v || '').length : 130;
// og omtrent hvor mye det blir i JSON
const jsonOf = it => it.k === 'ev' ? 90 + String(it.message || '').length + String(it.source || '').length
  : it.k === 'txt' ? 30 + String(it.v || '').length : 28;
const countOf = it => (it.k === 'grp' ? it.n : 1);
const pending = () => queue.length + rawCount + (inflight ? inflight.items.length : 0);
const totalBytes = () => queueBytes + rawBytes + (inflight ? inflight.bytes : 0);

function enqueue(it) {
  // det som fylles inn fra hubens minne (src 2), fortrenger aldri nyere verdier: er køen nesten full, hoppes resten over
  if (it.src === 2 && totalBytes() + costOf(it) > QUEUE_BYTES * 0.9) {
    dropped++;
    if (it.k !== 'ev') addGap(it.ts, it.ts, [it.tag], 'queue-full');
    return;
  }
  queue.push(it);
  queueBytes += costOf(it);
  if (totalBytes() > QUEUE_BYTES) trim();
}
function enqueueRaw(it) { raw.push(it); rawBytes += costOf(it); rawCount += countOf(it); if (totalBytes() > QUEUE_BYTES) trim(); }

// et hull serveren skal få vite om; et hull av samme slag som ikke er sendt ennå, utvides
function addGap(from, to, tags, reason) {
  if (!(to >= from)) return;
  const last = gapsPending[gapsPending.length - 1];
  if (last && last.reason === reason) {
    last.from = Math.min(last.from, from);
    last.to = Math.max(last.to, to);
    if (last.tags !== '*') last.tags = tags === '*' ? '*' : [...new Set(last.tags.concat(tags))];
    if (last.tags !== '*' && last.tags.length > 50) last.tags = '*';
    return;
  }
  gapsPending.push({ from, to, tags: tags !== '*' && tags.length > 50 ? '*' : tags, reason });
}
// hvilke tagger og hvilket tidsrom en liste elementer dekker
function span(items) {
  let from = Infinity, to = -Infinity, n = 0;
  const tags = new Set();
  const see = (tag, ts) => { if (ts < from) from = ts; if (ts > to) to = ts; if (tag) tags.add(tag); n++; };
  for (const it of items) {
    if (it.k === 'grp') { for (const tag of Object.keys(it.series)) for (const p of it.series[tag]) see(tag, p[0]); }
    else see(it.k === 'ev' ? null : it.tag, it.ts);
  }
  return { from, to, n, tags: tags.size > 50 ? '*' : [...tags] };
}
// køen er full: de eldste kastes, en tidel av taket om gangen, og hullet meldes
function trim() {
  const target = QUEUE_BYTES * 0.9;
  const cut = list => {
    let i = 0, b = 0;
    while (i < list.length && totalBytes() - b > target) { b += costOf(list[i]); i++; }
    return { gone: list.splice(0, i), b };
  };
  // før reglene finnes, er alt i `raw`; etterpå i `queue`
  const fromRaw = raw.length > 0;
  const r = cut(fromRaw ? raw : queue);
  if (!r.gone.length) return;
  if (fromRaw) { rawBytes -= r.b; rawCount -= r.gone.reduce((n, it) => n + countOf(it), 0); } else queueBytes -= r.b;
  const s = span(r.gone);
  dropped += s.n;
  addGap(s.from, s.to, s.tags, 'queue-full');
  if (!fullTold) {
    fullTold = true;
    hubEvent('warning', `The recorder's queue is full (${QUEUE_MB} MB): the oldest values are dropped until the central server takes them again`);
  }
}

// ---------------------------------------------------------------- reglene
let recording = null;         // regelsettet fra serveren, sjekket
let rulesVersion = null;
let compiled = null;          // reglene klare til bruk; null til både reglene og variablene er hentet
let vars = null;              // prosjektets variabler (${kv}) fra huben
let live = null;              // regelmotoren for sanntidsverdiene
let pauseIds = '';            // pausene som gjelder nå (id-er), for å se når det endres
let pausesOn = [];
let pauseTags = [];           // [{ p, res }] for alle pausene, til punkter i etterkant
const rulesReady = () => compiled !== null;

function sinkFor(src) {
  return {
    store(tag, v, q, ts) { enqueue({ k: isText(tag, v) ? 'txt' : 'pt', tag: nameOf(tag), ts: Math.round(ts), v, q, src }); },
    event(severity, message) { if (src === 0) hubEvent(severity, message); else log(`(older values) ${message}`); },
  };
}
function applyRules() {
  if (!recording || vars === null) return;
  compiled = compileRules(recording, vars);
  pauseTags = (recording.pauses || []).map(p => ({ p, res: compilePatterns(p.tags, vars) }));
  if (live) { live.setRules(compiled); updatePauses(); return; }
  live = createRecorderRules(compiled, sinkFor(0));
  updatePauses();
  // det som kom før reglene, gjennom dem nå, i rekkefølge
  const list = raw;
  raw = []; rawBytes = 0; rawCount = 0;
  rawLast.clear();
  for (const it of list) {
    if (it.k === 'upd') { live.tick(it.ts, it.m); live.value(it.tag, it.v, it.quality, it.ts, it.m); }
    else if (it.k === 'grp') replay(it.series, it.src);
    else if (it.k === 'ev') takeEvent(it);
  }
  if (list.length) log(`${list.length} changes from before the rules came were run through them`);
}
// en tag i en pause ved tiden ts (for punkter i etterkant)
const pausedAt = (tag, ts) => pauseTags.some(x => x.p.since <= ts && (x.p.until === null || x.p.until > ts) && x.res.some(re => re.test(tag)));
// punkter i etterkant (src 1: ringen i PLS-en, 2: hubens minne): en egen regelmotor, i tidsrekkefølge
function replay(series, src) {
  if (!rulesReady()) {
    const s = span([{ k: 'grp', series }]);
    if (s.n) enqueueRaw({ k: 'grp', src, series, n: s.n });
    return;
  }
  const eng = createRecorderRules(replayRules(compiled), sinkFor(src));
  const all = [];
  for (const tag of Object.keys(series)) {
    if (tag.startsWith('rec.')) continue;
    for (const p of series[tag]) if (Array.isArray(p) && Number.isFinite(p[0])) all.push([p[0], tag, p[1] === undefined ? null : p[1]]);
  }
  all.sort((a, b) => a[0] - b[0]);
  for (const [ts, tag, v] of all) {
    if (pausedAt(tag, ts)) continue;
    eng.tick(ts, ts);
    eng.value(tag, stored(v, 'good'), v === null ? 'bad' : 'good', ts, ts);
  }
  // det som venter (minInterval, flimring), ut med sin egen tid
  if (all.length) { const end = all[all.length - 1][0] + 1e12; eng.tick(end, end); }
}
// pausene: merket i lagringen, hendelsene i huben, og et hull til serveren når en pause er over
function updatePauses() {
  if (!live) return;
  const now = Date.now();
  const list = activePauses(recording, now);
  const ids = list.map(p => p.id + '|' + p.until).join(',');
  if (ids === pauseIds) return;
  const before = pausesOn;
  pauseIds = ids;
  pausesOn = list;
  const match = list.length ? pauseMatcher(list, vars) : null;
  live.setPaused(match ? match.tag : null, now, mono());
  for (const p of list) if (!before.some(b => b.id === p.id)) hubEvent('info', `Recording paused: ${pauseText(p, now, vars)}`);
  for (const p of before) {
    if (list.some(b => b.id === p.id)) continue;
    hubEvent('info', `Recording resumed: ${pauseText(Object.assign({}, p, { until: null, reason: '' }), now, vars).replace(/ until it is resumed$/, '')}`);
    const res = compilePatterns(p.tags, vars);
    const tags = p.tags.trim() === '*' ? '*' : [...registry.keys()].filter(n => res.some(re => re.test(n)));
    addGap(Math.max(p.since, startedAt), Math.min(now, p.until || now), tags, 'paused');
  }
}

// ---------------------------------------------------------------- hendelsene
const seenEvents = new Set();
let hubEvents = [];           // hubens liste fra da leseren koblet seg til, til hullet etter en omstart
function takeEvent(it) {
  if (!eventWanted(recording, it.severity)) return;
  if (pausesOn.length && pauseMatcher(pausesOn, vars).source(String(it.source || ''))) return;
  enqueue(it);
}
function onEvent(ev, src) {
  if (!ev || !Number.isFinite(ev.ts)) return;
  const key = `${ev.ts}|${ev.source}|${ev.message}`;
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  if (seenEvents.size > 3000) seenEvents.delete(seenEvents.values().next().value);
  const it = { k: 'ev', ts: ev.ts, source: String(ev.source || ''), severity: ev.severity || 'info', message: String(ev.message || ''), src };
  if (!rulesReady()) enqueueRaw(it); else takeEvent(it);
}

// ---------------------------------------------------------------- klokka
// Veggklokka minus den monotone: endrer den seg brått, har klokka hoppet (chrony stilte den), og alt
// i køen flyttes like mye. Ingenting sendes før systemet sier at klokka er synkronisert.
const clock = { synced: null, offset: Date.now() - mono(), jumps: [], how: null, told: false };
function clockJump(d) {
  let n = 0;
  for (const it of queue) { it.ts += d; n++; }
  for (const it of raw) {
    if (it.k === 'grp') { for (const tag of Object.keys(it.series)) for (const p of it.series[tag]) { p[0] += d; n++; } }
    else { it.ts += d; n++; }
  }
  for (const g of gapsPending) { g.from += d; g.to += d; }
  if (readerSince !== null) readerSince += d;
  startedAt += d;
  // verdiene regelmotoren venter med, har også den gamle tiden
  if (live) for (const st of live.states.values()) { if (st.cur) st.cur.ts += d; if (st.pending) st.pending.ts += d; }
  clock.jumps.push({ before: Date.now() - d, delta: d });
  const dir = d > 0 ? 'forward' : 'back';
  hubEvent('info', `The clock jumped ${dir} by ${Math.abs(d / 1000).toFixed(1)} s; ${n} value${n === 1 ? '' : 's'} waiting to be sent moved with it`);
}
setInterval(() => {
  const off = Date.now() - mono(), d = off - clock.offset;
  clock.offset = off;
  if (Math.abs(d) >= 1000) clockJump(d);
}, 1000);
function setSynced(v, how) {
  if (clock.synced === v) return;
  const was = clock.synced;
  clock.synced = v;
  clock.how = how;
  if (v) log(`the clock is synchronized${how ? ` (${how})` : ''}`);
  else log(`the clock isn't synchronized yet${how ? ` (${how})` : ''}: nothing is sent until it is`);
  if (was === true && !v) hubEvent('warning', 'This machine’s clock lost its synchronization; the recorder holds the values until it is back');
  publishStatus();
}
function checkClock() {
  if (!CLOCK_CHECK) return setSynced(true, 'clockCheck is off');
  execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000 }, (err, out) => {
    const s = String(out || '').trim();
    if (!err && (s === 'yes' || s === 'no')) return setSynced(s === 'yes', 'timedatectl');
    execFile('chronyc', ['-c', 'tracking'], { timeout: 5000 }, (err2, out2) => {
      const f = String(out2 || '').trim().split(',');
      if (!err2 && f.length > 5) return setSynced(f[0] !== '00000000' && !/not synchroni/i.test(f[f.length - 1]), 'chronyc');
      if (!clock.told) { clock.told = true; log('can’t tell whether this machine’s clock is synchronized (neither timedatectl nor chronyc answered); taking it as right'); }
      setSynced(true, null);
    });
  });
}
// sende, også uten synkronisert klokke når serveren har svart lenge nok (merket i batchen)
let firstAnswerAt = null;
const clockOk = () => clock.synced === true || (firstAnswerAt !== null && mono() - firstAnswerAt >= UNSYNCED_AFTER);

// ---------------------------------------------------------------- serveren
const SERVER_URL = new URL(SERVER);
const agent = new (SERVER_URL.protocol === 'https:' ? https : http).Agent({ keepAlive: true, maxSockets: 2 });
// { status, json, headers } eller { error } (ingen forbindelse, eller ikke noe svar i tide)
function call(method, route, body, timeoutMs, headers) {
  return new Promise(resolve => {
    const u = new URL(SERVER + '/api/v1' + route);
    const h = Object.assign({ Accept: 'application/json', 'Accept-Encoding': 'gzip', Authorization: 'Bearer ' + TOKEN }, headers || {});
    let data = null;
    if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
      if (data.length > 4096) { data = zlib.gzipSync(data); h['Content-Encoding'] = 'gzip'; }
      h['Content-Length'] = data.length;
    }
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const req = (u.protocol === 'https:' ? https : http).request({
      method, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: h, agent,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', e => finish({ error: e.message }));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        try { if (/gzip/.test(res.headers['content-encoding'] || '')) buf = zlib.gunzipSync(buf); }
        catch (e) { return finish({ error: `unreadable answer (${e.message})` }); }
        let json = null;
        try { json = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch (e) { /* ikke JSON */ }
        finish({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs / 1000} s`)));
    req.on('error', e => finish({ error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

let serverState = 'connecting';   // ok, unreachable, busy, key refused, ...
let helloOk = false;
let needRules = true;
let lastTs = undefined;            // nyeste data serveren har fra dette kjøreverket (fra /hello)
let maxBatchBytes = 5e6;
let waitUntil = 0;                 // mono: vent til da før neste forespørsel
let backoff = 0;
let lastAck = null;
let lastBatchAt = -Infinity, lastBatchFull = false;
let stopping = false;
const retryAfter = r => {
  const s = Number((r.json && r.json.retryAfter) || (r.headers && r.headers['retry-after']));
  return Number.isFinite(s) && s > 0 ? Math.min(s, 600) : 10;
};
const said = r => (r.json && r.json.error ? `: ${r.json.error}` : '');
function setServer(state, why) {
  if (state === serverState) return;
  const was = serverState;
  serverState = state;
  if (state === 'ok') { if (was !== 'connecting') hubEvent('info', `The central server answers again (${SERVER})`); else log(`the central server answers (${SERVER})`); }
  else if (state === 'unreachable' && was !== 'unreachable') {
    if (was === 'ok') hubEvent('info', `The central server can’t be reached (${why}); the recorder keeps the values in RAM meanwhile`);
    else log(`the central server can't be reached (${why})`);
  } else if (state === 'key refused') hubEvent('warning', `The central server refused this recorder's key for ${VEHICLE}${why}`);
  publishStatus();
}
// et svar som ikke er OK: vent, og hils på nytt når serveren har vært borte
function failed(r, what) {
  if (r.error || (r.status >= 500 && r.status !== 503)) {
    helloOk = false;
    backoff = Math.min(60, backoff ? backoff * 2 : 2);
    waitUntil = mono() + backoff * 1000;
    setServer('unreachable', r.error || `${what} answered ${r.status}${said(r)}`);
  } else if (r.status === 401 || r.status === 403) {
    waitUntil = mono() + 5 * 60000;
    setServer('key refused', said(r));
  } else if (r.status === 429 || r.status === 503) {
    waitUntil = mono() + retryAfter(r) * 1000;
    setServer('busy');
  } else {
    // en feil i det recorderen sendte: logg, og prøv igjen om en stund
    waitUntil = mono() + 60000;
    log(`${what}: the server answered ${r.status}${said(r)}`);
  }
}
async function hello() {
  const r = await call('POST', '/hello', { protocol: PROTOCOL, vehicle: VEHICLE, boot: BOOT, recorder: VERSION,
    clock: { synced: clock.synced === true, piTime: Date.now() } }, TIMEOUT.hello);
  if (r.status !== 200 || !r.json) return failed(r, '/hello');
  const j = r.json;
  helloOk = true;
  backoff = 0;
  if (firstAnswerAt === null) firstAnswerAt = mono();
  if (lastTs === undefined) lastTs = Number.isFinite(j.lastTs) ? j.lastTs : null;
  if (Number(j.maxBatchBytes) > 10000) maxBatchBytes = Number(j.maxBatchBytes);
  if (j.rulesVersion !== rulesVersion || !recording) needRules = true;
  catalogDirty = true;
  if (Number.isFinite(j.serverTime) && clock.synced && Math.abs(j.serverTime - Date.now()) > 5000) {
    log(`note: this machine's clock and the server's differ by ${Math.round((Date.now() - j.serverTime) / 1000)} s`);
  }
  setServer('ok');
}
async function fetchRules() {
  const r = await call('GET', '/rules?vehicle=' + encodeURIComponent(VEHICLE), undefined, TIMEOUT.rules,
    rulesVersion !== null ? { 'If-None-Match': `"${rulesVersion}"` } : null);
  if (r.status === 304) { needRules = false; return; }
  if (r.status !== 200 || !r.json) return failed(r, '/rules');
  const c = checkRecording(r.json.recording);
  for (const e of c.errors) log(`recording rules from the server: ${e} (a rule without tags is left out; otherwise the default is used)`);
  needRules = false;
  const first = recording === null;
  recording = c.recording;
  rulesVersion = r.json.version;
  applyRules();
  const n = recording.rules.length;
  hubEvent('info', `Recording rules version ${rulesVersion} from the central server ${first ? 'in use' : 'loaded'}: ${n} rule${n === 1 ? '' : 's'}`);
  publishStatus();
}

// ---- batchene
function takeBatch() {
  const limit = maxBatchBytes * 0.8;
  let size = 400, i = 0, bytes = 0;
  while (i < queue.length && i < BATCH_ITEMS && size < limit) { size += jsonOf(queue[i]) + (queue[i].tag ? queue[i].tag.length : 0); bytes += costOf(queue[i]); i++; }
  const items = queue.splice(0, i);
  queueBytes -= bytes;
  lastBatchFull = i >= BATCH_ITEMS || size >= limit;
  const b = { seq: ++seq, items, bytes, gaps: gapsPending, catalog: catalogDirty ? [...registry.values()] : null };
  gapsPending = [];
  catalogDirty = false;
  return b;
}
function payload(b) {
  const series = {}, text = {}, events = [];
  for (const it of b.items) {
    if (it.k === 'ev') {
      const e = { ts: it.ts, source: it.source, severity: it.severity, message: it.message };
      if (it.src) e.src = it.src;
      events.push(e);
      continue;
    }
    const p = [it.ts, it.v];
    if (it.q || it.src) p.push(it.q || 0);
    if (it.src) p.push(it.src);
    const into = it.k === 'txt' ? text : series;
    (into[it.tag] || (into[it.tag] = [])).push(p);
  }
  const body = { vehicle: VEHICLE, boot: BOOT, seq: b.seq, clock: { synced: clock.synced === true, piTime: Date.now() } };
  if (b.catalog) body.tags = b.catalog;
  if (Object.keys(series).length) body.series = series;
  if (Object.keys(text).length) body.text = text;
  if (events.length) body.events = events;
  if (b.gaps.length) body.gaps = b.gaps;
  return body;
}
async function sendBatch() {
  const b = inflight;
  const r = await call('POST', '/ingest', payload(b), TIMEOUT.ingest);
  if (r.status === 200) {
    inflight = null;
    lastAck = Date.now();
    backoff = 0;
    fullTold = false;
    if (r.json && r.json.rulesVersion !== undefined && r.json.rulesVersion !== rulesVersion) needRules = true;
    setServer('ok');
    return;
  }
  if (r.status === 413 && b.items.length > 1) {
    // for stor: halvparten tilbake først i køen, og samme nummer på resten
    const back = b.items.splice(Math.ceil(b.items.length / 2));
    const bytes = back.reduce((n, it) => n + costOf(it), 0);
    queue = back.concat(queue);
    queueBytes += bytes;
    b.bytes -= bytes;
    log(`batch ${b.seq} was too large for the server; sending it in two`);
    return;
  }
  if (r.status === 400 || r.status === 413) {
    // aldri godtatt: kastes, og serveren får vite om hullet i neste batch
    inflight = null;
    const s = span(b.items);
    gapsPending = b.gaps.concat(gapsPending);
    if (s.n) addGap(s.from, s.to, s.tags, 'rejected');
    if (b.catalog) catalogDirty = true;
    hubEvent('warning', `The central server refused ${s.n} value${s.n === 1 ? '' : 's'} (batch ${b.seq})${said(r)}`);
    return;
  }
  failed(r, '/ingest');
}

// ---- hullet etter en omstart: fra hubens minne
let backfilled = false;
const historyWaits = new Map();   // tag -> resolve
function askHub(tag, since) {
  return new Promise(resolve => {
    historyWaits.set(tag, resolve);
    reader.send(JSON.stringify({ type: 'history', tag, since }));
  });
}
async function backfill() {
  backfilled = true;
  const since = lastTs === null ? 1 : Math.max(1, lastTs - BACKFILL_MARGIN);
  const until = readerSince;   // det som kom etter dette, kom i sanntid
  if (since >= until) return;
  const wanted = [...registry.keys()].filter(n => { const r = ruleFor(compiled, n); return r && r.mode !== 'ignore'; });
  const timer = new Promise(resolve => setTimeout(resolve, 10000, 'timeout'));
  const got = {};
  await Promise.race([Promise.all(wanted.map(tag => askHub(tag, since).then(pts => { got[tag] = pts; }))), timer]);
  historyWaits.clear();
  // klokkehopp recorderen har sett: punkter fra før hoppet flyttes like mye
  const fix = ts => { for (const j of clock.jumps) if (j.delta > 0 && ts < j.before) ts += j.delta; return ts; };
  const series = {};
  let n = 0, first = until;
  for (const tag of Object.keys(got)) {
    const pts = (got[tag] || []).map(p => [fix(p[0]), p[1]]).filter(p => p[0] >= since && p[0] < until);
    if (pts.length) { series[tag] = pts; n += pts.length; first = Math.min(first, pts[0][0]); }
  }
  const evs = hubEvents.map(e => Object.assign({}, e, { ts: fix(e.ts) })).filter(e => e.ts >= since && e.ts < until);
  for (const e of evs) onEvent(e, 2);
  if (n) replay(series, 2);
  if (n || evs.length) hubEvent('info', `Filled in ${n} value${n === 1 ? '' : 's'} and ${evs.length} event${evs.length === 1 ? '' : 's'} from the hub's memory, from ${localStamp(Math.min(first, evs.length ? evs[0].ts : first))}`);
}

// ---- én ting om gangen: hilse, regler, hullet, batcher
let busy = false;
async function pump() {
  if (busy || mono() < waitUntil) return;
  busy = true;
  try {
    if (!helloOk) return await hello();
    if (needRules) return await fetchRules();
    if (!clockOk()) return;
    if (!backfilled && rulesReady() && readerOpen && registry.size && lastTs !== undefined) await backfill();
    if (!inflight) {
      const work = queue.length || gapsPending.length || catalogDirty;
      const due = stopping || lastBatchFull || mono() - lastBatchAt >= SEND_EVERY;
      if (!work || !due || !rulesReady()) return;
      lastBatchAt = mono();
      inflight = takeBatch();
    }
    await sendBatch();
  } catch (e) {
    log('error:', e && e.stack || e);
    waitUntil = mono() + 5000;
  } finally {
    busy = false;
  }
}
setInterval(pump, 250);
setInterval(() => { if (live) { live.tick(Date.now(), mono()); updatePauses(); } }, 250);

// ---------------------------------------------------------------- huben
const HUB_HTTP = HUB.replace(/^ws/, 'http').replace(/\/+$/, '');
let reader = null, readerOpen = false, readerSince = null;
function loadVars() {
  (HUB_HTTP.startsWith('https') ? https : http).get(HUB_HTTP + '/api/config', res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      let cfg = null;
      try { cfg = JSON.parse(body); } catch (e) { /* ikke JSON */ }
      if (res.statusCode === 200 && cfg) vars = cfg.vars || {};
      else { log(`could not read the project from the hub (${res.statusCode}); going on with the variables it had`); if (vars === null) vars = {}; }
      applyRules();
    });
  }).on('error', e => {
    log('could not reach the hub for the project:', e.message);
    if (vars === null) vars = {};
    applyRules();
  });
}
function onHub(m) {
  switch (m.type) {
    case 'update': {
      const values = m.values || { [m.tag]: m.value };
      const ts = Number(m.ts) || Date.now(), at = mono(), quality = m.quality || 'good';
      for (const tag of Object.keys(values)) {
        if (tag.startsWith('rec.')) continue;
        const v = stored(values[tag], quality);
        if (v === undefined) continue;
        if (live) { live.value(nameOf(tag), v, quality, ts, at); continue; }
        const key = v + '|' + quality;
        if (rawLast.get(tag) === key) continue;   // ingen endring
        rawLast.set(nameOf(tag), key);
        enqueueRaw({ k: 'upd', tag: nameOf(tag), v, quality, ts, m: at });
      }
      return;
    }
    case 'tags': return onTags(m.tags);
    case 'restored': return replay(m.series || {}, 1);
    case 'event': return onEvent(m, 0);
    case 'events': hubEvents = (m.events || []).filter(e => e && Number.isFinite(e.ts)); return;
    case 'history': {
      const done = historyWaits.get(m.tag);
      if (done) { historyWaits.delete(m.tag); done(Array.isArray(m.points) ? m.points : []); }
      return;
    }
    case 'configChanged': return loadVars();
    default:
  }
}
function connectReader() {
  reader = new WebSocket(HUB);
  reader.on('open', () => {
    readerOpen = true;
    if (readerSince === null) readerSince = Date.now();
    log(`connected to the hub ${HUB} (read-only)`);
    reader.send(JSON.stringify({ type: 'hello', role: 'hmi', name: 'recorder', readonly: true }));
    reader.send(JSON.stringify({ type: 'subscribe', tags: ['*'] }));
    loadVars();
  });
  reader.on('message', data => { let m; try { m = JSON.parse(data); } catch (e) { return; } onHub(m); });
  reader.on('close', () => {
    if (readerOpen) log('lost the hub, trying again in 2 s');
    readerOpen = false;
    for (const done of historyWaits.values()) done([]);
    historyWaits.clear();
    setTimeout(connectReader, 2000);
  });
  reader.on('error', () => {});
}

// ---- historikktjenesten: trendene i HMI-en spør serveren gjennom recorderen, og statusen som tagger
let service = null, serviceOpen = false;
const STATUS_TAGS = [
  { name: 'rec.server', dataType: 'string', description: 'The central server: ok, connecting, unreachable, busy or key refused' },
  { name: 'rec.queue', dataType: 'number', description: 'Values and events waiting in RAM to be sent' },
  { name: 'rec.queue_pct', dataType: 'number', unit: '%', description: 'How full the queue is. When full, the oldest values are dropped' },
  { name: 'rec.last_ack', dataType: 'string', description: 'When the server last confirmed a batch' },
  { name: 'rec.dropped', dataType: 'number', description: 'Values dropped since the recorder started, because the queue was full' },
  { name: 'rec.clock_synced', dataType: 'boolean', description: 'Whether this machine’s clock is synchronized. Nothing is sent until it is' },
  { name: 'rec.rules_version', dataType: 'number', description: 'The version of the recording rules from the server' },
];
let lastStatus = '';
function publishStatus(force) {
  if (!serviceOpen) return;
  const values = {
    'rec.server': serverState,
    'rec.queue': pending(),
    'rec.queue_pct': Math.round(totalBytes() / QUEUE_BYTES * 1000) / 10,
    'rec.last_ack': lastAck ? localStamp(lastAck) : '',
    'rec.dropped': dropped,
    'rec.clock_synced': clock.synced === true,
    'rec.rules_version': rulesVersion === null ? 0 : rulesVersion,
  };
  const key = JSON.stringify(values);
  if (!force && key === lastStatus) return;
  lastStatus = key;
  service.send(JSON.stringify({ type: 'update', values }));
}
setInterval(publishStatus, 2000);
function hubEvent(severity, message) {
  log(`[${severity}] ${message}`);
  if (serviceOpen) service.send(JSON.stringify({ type: 'event', severity, message }));
}
async function answerQuery(m) {
  const reply = x => { if (serviceOpen) service.send(JSON.stringify(Object.assign({ type: 'queryResult', id: m.id }, x))); };
  if (serverState === 'unreachable' || serverState === 'key refused') return reply({ error: `the central server ${serverState === 'unreachable' ? 'can’t be reached' : 'refused this recorder’s key'}` });
  const t0 = mono();
  const r = await call('POST', '/history', { vehicle: VEHICLE, tags: m.tags, from: m.from, to: m.to, points: m.points }, TIMEOUT.history);
  if (r.status === 200 && r.json) return reply({ series: r.json.series || {}, unrecorded: r.json.unrecorded || [], ms: Math.round(mono() - t0) });
  reply({ error: r.error ? `the central server didn’t answer (${r.error})` : `the central server answered ${r.status}${said(r)}` });
}
function connectService() {
  service = new WebSocket(HUB);
  service.on('open', () => {
    serviceOpen = true;
    service.send(JSON.stringify({ type: 'hello', role: 'adapter', name: 'rec', serves: ['history'] }));
    service.send(JSON.stringify({ type: 'register', tags: STATUS_TAGS }));
    publishStatus(true);
  });
  service.on('message', data => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (m.type === 'query') answerQuery(m);
  });
  service.on('close', () => { serviceOpen = false; setTimeout(connectService, 2000); });
  service.on('error', () => {});
}

// ---------------------------------------------------------------- start og stopp
// en normal stopp sender det som venter, i høyst 5 sekunder; resten er tapt (ingenting skrives til disken)
function stop(sig) {
  if (stopping) process.exit(0);
  stopping = true;
  log(`${sig}: sending what is waiting for up to 5 s, then stopping`);
  setInterval(() => { if (!inflight && !queue.length && !gapsPending.length) process.exit(0); }, 100);
  setTimeout(() => { log(`${pending()} values not sent`); process.exit(0); }, 5000);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

log(`recorder ${VERSION} for ${VEHICLE}: hub ${HUB}, server ${SERVER}, queue up to ${QUEUE_MB} MB${SETTINGS_FILE ? `, settings from ${SETTINGS_FILE}` : ''}`);
checkClock();
setInterval(checkClock, SYNC_EVERY);
connectReader();
connectService();
