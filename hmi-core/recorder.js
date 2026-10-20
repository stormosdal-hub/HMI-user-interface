#!/usr/bin/env node
'use strict';
/*
 * recorder.js - lagrer taggene og hendelsene du velger, i en SQLite-database på Pi-en.
 *
 * Kjernefil. Hvilke tagger, og hvor ofte, settes i en regelfil ved siden av databasen
 * (recorder.db -> recorder.rules.json), som redigeres i databaseleseren under Recording; se
 * lib/record-rules.js. Endringer virker innen noen sekunder, uten omstart. Recorderen:
 *   - kobler seg til huben kun for lesing og lytter på alle tagger og hendelser
 *   - holder verdiene som reglene velger, i RAM, og skriver dem i én transaksjon hvert
 *     flushSeconds (standard 30), noe som skåner SD-kortet; en normal stopp skriver dem også
 *   - sletter data eldre enn keepDays, og de eldste dataene når databasen passerer maxMB
 *   - kan pauses (alle tagger, eller noen) fra databaseleseren, f.eks. under vedlikehold
 *   - kopierer dine egne tagnavn (hubens tagnavn) inn i tag-tabellen sin, så databasen
 *     forklarer seg selv
 *   - melder statusen sin som rec.*-tagger, så HMI-en kan vise den (og viser den som foreldet
 *     hvis recorderen stopper)
 *   - lagrer med hver rad Pi-ens klokketid pluss oppstarten (boot) og tiden siden oppstart, så
 *     tidene kan rettes senere når riktig tid er kjent
 *
 * Krever Node.js 22.13 eller nyere (innebygd SQLite).
 *
 *   node recorder.js [ws://localhost:8080] [--db data/recorder.db]
 *   node recorder.js --db data/recorder.db --query "kv_1.speedAct, calc.*" [--minutes 60]
 *   node recorder.js --db data/recorder.db --events [--minutes 60]
 *   node recorder.js --db data/recorder.db --info
 */

// ---------------------------------------------------------------- Node-versjon (denne delen må tåle gamle Node-versjoner)
var parts = process.versions.node.split('.').map(Number);
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 13)) {
  console.error('The recorder needs Node.js 22.13 or newer for its built-in SQLite; this computer has ' + process.version + '.');
  console.error('See "Installing without internet" in README.md.');
  process.exit(1);
}
// Node kaller sin SQLite "experimental": greit for oss, så hopp over akkurat den advarselen
const emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const text = typeof w === 'string' ? w : (w && w.message) || '';
  if (/SQLite/.test(text)) return;
  return emitWarning.call(process, w, ...rest);
};

const fs = require('fs');
const path = require('path');
const http = require('http');
const { DatabaseSync } = require('node:sqlite');
const { compileRules, createRecorderRules, ruleFor, checkRecording, rulesFileFor, readRulesFile, writeRulesFile, DEFAULTS,
  activePauses, pauseMatcher, pauseText, parseStamp } = require('./lib/record-rules');

// ---------------------------------------------------------------- argumenter
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const flag = name => args.includes(name);
const HUB = args.find(a => /^wss?:\/\//.test(a)) || process.env.HUB_URL || 'ws://localhost:8080';
const DB_PATH = path.resolve(opt('--db') || process.env.HMI_RECORDER_DB || path.join(__dirname, 'data', 'recorder.db'));
const RULES_PATH = rulesFileFor(DB_PATH);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- databasen
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS meta  (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS boot  (id INTEGER PRIMARY KEY AUTOINCREMENT, boot_key TEXT UNIQUE NOT NULL, first_seen INTEGER NOT NULL);
  -- label, info: ditt eget navn og din egen beskrivelse av taggen (hubens tagnavn), kopiert inn
  CREATE TABLE IF NOT EXISTS tag   (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, label TEXT, info TEXT);
  -- én rad per lagret verdi; q: 0 god, 1 usikker, 2 foreldet, 3 pauset (en pause begynte: ingenting
  -- lagres før den slutter). ts = Pi-ens klokke, mono = ms siden oppstart
  CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, boot INTEGER NOT NULL,
                                     mono INTEGER NOT NULL, tag INTEGER NOT NULL, value REAL, text TEXT, q INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS event  (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, boot INTEGER NOT NULL,
                                     mono INTEGER NOT NULL, source TEXT, severity TEXT, message TEXT);
  -- én rad per skriving: hvilke rader den har, for sletting av gamle data, spørringer og (senere) videresending
  CREATE TABLE IF NOT EXISTS batch  (id INTEGER PRIMARY KEY AUTOINCREMENT, written INTEGER NOT NULL,
                                     first_sample INTEGER, last_sample INTEGER, first_event INTEGER, last_event INTEGER,
                                     first_ts INTEGER, last_ts INTEGER, rows INTEGER NOT NULL);
`;

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // en tilfeldig id for denne databasefilen: rader identifiseres senere med (kjøretøy, database, rad)
  if (!db.prepare("SELECT value FROM meta WHERE key = 'db_id'").get()) {
    const id = require('crypto').randomBytes(8).toString('hex');
    db.prepare("INSERT INTO meta (key, value) VALUES ('db_id', ?), ('created', ?), ('schema', '1')").run(id, new Date().toISOString());
  }
  // en database fra før tagnavn fantes: gi plass til dem
  const tagCols = db.prepare("SELECT name FROM pragma_table_info('tag')").all().map(r => r.name);
  if (!tagCols.includes('label')) db.exec('ALTER TABLE tag ADD COLUMN label TEXT; ALTER TABLE tag ADD COLUMN info TEXT;');
  // trender spør etter én tag over et tidsrom: dette holder det raskt uansett hvor mye annet som
  // er lagret (omtrent en tredjedel mer plass). Bygges én gang; på en stor database tar det litt tid.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'sample_tag'").get()) {
    const t0 = Date.now();
    db.exec('CREATE INDEX sample_tag ON sample (tag, id)');
    log(`built the index for trends in ${Date.now() - t0} ms (once)`);
  }
  // Hver tags laveste og høyeste verdi per minutt, oppdatert ved hver skriving: en trend over dager
  // eller uker leser én rad per minutt i stedet for hver lagrede verdi. n teller tallene i den, bad
  // foreldet-merkene, rows hver lagrede verdi (tekst også), for "hvor mye lagrer hver tag".
  // Bygges én gang fra det som er lagret; et sammendrag fra før `rows` fantes, bygges på nytt.
  const rollupCols = db.prepare("SELECT name FROM pragma_table_info('rollup')").all().map(r => r.name);
  if (!rollupCols.includes('rows')) {
    const t0 = Date.now();
    db.exec(`DROP TABLE IF EXISTS rollup;
             CREATE TABLE rollup (tag INTEGER NOT NULL, minute INTEGER NOT NULL, lo REAL, hi REAL, n INTEGER NOT NULL,
                                  bad INTEGER NOT NULL, rows INTEGER NOT NULL, PRIMARY KEY (tag, minute)) WITHOUT ROWID;
             INSERT INTO rollup SELECT tag, ts / 60000, MIN(CASE WHEN q < 2 THEN value END), MAX(CASE WHEN q < 2 THEN value END),
               COUNT(CASE WHEN q < 2 AND value IS NOT NULL THEN 1 END), SUM(q >= 2), COUNT(*) FROM sample GROUP BY tag, ts / 60000;`);
    log(`built the minute summary in ${Date.now() - t0} ms (once)`);
  }
  return db;
}

const monoNow = () => { const t = process.hrtime(); return Math.round(t[0] * 1000 + t[1] / 1e6); };   // ms siden oppstart på Linux
function bootKey() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch (e) { return 'start-' + Date.now().toString(36); }   // ikke Linux: én "boot" per oppstart av recorderen
}
const fmtTime = ms => { const d = new Date(ms); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const usedMB = db => { const g = k => db.prepare(`PRAGMA ${k}`).get()[k]; return (g('page_count') - g('freelist_count')) * g('page_size') / 1e6; };

// ---------------------------------------------------------------- spørringer fra terminalen
function patternsToRegex(text) {
  return String(text || '').split(/[\s,]+/).filter(Boolean)
    .map(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
}
function firstIdSince(db, col, sinceTs) {
  const b = db.prepare(`SELECT MIN(${col}) AS id FROM batch WHERE last_ts >= ?`).get(sinceTs);
  return b && b.id != null ? b.id : null;
}
function runQuery() {
  if (!fs.existsSync(DB_PATH)) { console.error('No database at ' + DB_PATH); process.exit(1); }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const minutes = Number(opt('--minutes') || 60);
  const since = Date.now() - minutes * 60000;
  if (flag('--info')) {
    const n = t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const range = db.prepare('SELECT MIN(first_ts) AS a, MAX(last_ts) AS b FROM batch').get();
    const tags = db.prepare('SELECT COUNT(DISTINCT tag) AS n FROM sample').get().n;
    console.log(`database   ${DB_PATH}\nid         ${db.prepare("SELECT value FROM meta WHERE key='db_id'").get().value}\nsize       ${usedMB(db).toFixed(2)} MB in use`);
    console.log(`values     ${n('sample')} rows, ${tags} tags\nevents     ${n('event')}\nwrites     ${n('batch')}\nboots      ${n('boot')}`);
    if (range.a) console.log(`from       ${fmtTime(range.a)}\nto         ${fmtTime(range.b)}`);
    return;
  }
  if (flag('--events')) {
    const first = firstIdSince(db, 'first_event', since);
    console.log('time,source,severity,message');
    if (first == null) return;
    for (const r of db.prepare('SELECT ts, source, severity, message FROM event WHERE id >= ? AND ts >= ? ORDER BY id').iterate(first, since)) {
      console.log(`${fmtTime(r.ts)},${r.source},${r.severity},"${String(r.message).replace(/"/g, '""')}"`);
    }
    return;
  }
  const res = patternsToRegex(opt('--query'));
  const ids = db.prepare('SELECT id, name FROM tag').all().filter(t => res.some(r => r.test(t.name)));
  console.log('time,tag,value,quality');
  const first = firstIdSince(db, 'first_sample', since);
  if (!ids.length || first == null) return;
  const byId = new Map(ids.map(t => [t.id, t.name]));
  const Q = ['good', 'uncertain', 'stale', 'paused'];
  const stmt = db.prepare(`SELECT ts, tag, value, text, q FROM sample WHERE id >= ? AND ts >= ? AND tag IN (${ids.map(() => '?').join(',')}) ORDER BY id`);
  for (const r of stmt.iterate(first, since, ...ids.map(t => t.id))) {
    console.log(`${fmtTime(r.ts)}.${String(r.ts % 1000).padStart(3, '0')},${byId.get(r.tag)},${r.text != null ? '"' + r.text + '"' : r.value},${Q[r.q] || r.q}`);
  }
}

// ---------------------------------------------------------------- lagring
function runRecorder() {
  const WebSocket = require('ws');
  const db = openDb(DB_PATH);
  const boot = (() => {
    const key = bootKey();
    db.prepare('INSERT OR IGNORE INTO boot (boot_key, first_seen) VALUES (?, ?)').run(key, Date.now());
    return db.prepare('SELECT id FROM boot WHERE boot_key = ?').get(key).id;
  })();
  const tagIds = new Map(db.prepare('SELECT id, name FROM tag').all().map(r => [r.name, r.id]));
  const lastEventTs = (db.prepare('SELECT MAX(ts) AS t FROM event').get() || {}).t || 0;

  let settings = { flushSeconds: 30, keepDays: 7, maxMB: 1000, events: true };
  let engine = null, rules = [], recordedCount = 0, vars = {}, registry = [];
  const buffer = { samples: [], events: [] };
  let lastWrite = 0, stored = db.prepare('SELECT COUNT(*) AS n FROM sample').get().n;
  const recentEvents = new Set();
  let recentRate = [];   // [mono, rows] per skriving, for anslaget av MB per dag

  const sink = {
    store(tag, v, q, ts, m) {
      buffer.samples.push({ ts, m, tag, v, q });
      if (buffer.samples.length >= 50000) flush('buffer full');   // begrens RAM-bruken, uansett hva flushSeconds sier
    },
    event(severity, message) { toHubEvent(severity, message); },
  };

  // ---- reglene: regelfilen ved siden av databasen, som databaseleseren skriver. Recorderen
  // sjekker den hvert 2. sekund og tar i bruk en endring med en gang. Prosjektets variabler (${kv}
  // i tagnavn) kommer fra huben. Eldre prosjekter hadde reglene i prosjektfilen: de flyttes til
  // regelfilen første gang.
  let recording = null;   // det regelfilen inneholder; null til det finnes en
  let rulesAt = '';       // når reglene som brukes, ble lastet (rec.rules_at)
  let ownWrite = 0;       // regelfilen slik recorderen selv skrev den (da gamle regler ble flyttet)
  function applyRules(why) {
    const rec = recording || Object.assign({}, DEFAULTS, { rules: [] });
    settings = { flushSeconds: rec.flushSeconds, keepDays: rec.keepDays, maxMB: rec.maxMB, events: rec.events };
    rules = compileRules(rec, vars);
    if (engine) engine.setRules(rules); else engine = createRecorderRules(rules, sink);
    scheduleFlush();
    rulesAt = fmtTime(Date.now());
    if (!recording) log(`no recording rules yet, so nothing is stored: set them in the database browser (node db-browser.js), under Recording`);
    else log(`rules ${why}: ${rules.length} rule(s); writing every ${settings.flushSeconds} s, keeping ${settings.keepDays} days, at most ${settings.maxMB} MB`);
    countRecorded();
    checkPauses();
  }

  // ---- pauser: settes i databaseleseren ("pauses" i regelfilen), f.eks. under vedlikehold.
  // Sjekkes hvert sekund, så en pause med sluttid slutter av seg selv. Hendelser går til hubens
  // logg (og dermed inn i databasen), for å si når og hvorfor ingenting ble lagret.
  const startedAt = Date.now();
  let pausesOn = [], pauseKey = '', pauseMatch = null, pauseFrom = Infinity;
  function checkPauses() {
    if (!engine) return;
    const now = Date.now();
    const list = activePauses(recording, now);
    const key = JSON.stringify([list, vars]);
    if (key === pauseKey) return;
    pauseKey = key;
    const before = new Map(pausesOn.map(p => [p.id, p]));
    const after = new Set(list.map(p => p.id));
    for (const p of list) {
      const was = before.get(p.id);
      if (!was) toHubEvent('info', `${parseStamp(p.since) < startedAt ? 'The recorder started during a pause' : 'Recording paused'}: ${pauseText(p, now, vars)}`);
      else if (was.until !== p.until || was.tags !== p.tags) toHubEvent('info', `Recording pause changed: ${pauseText(p, now, vars)}`);
    }
    for (const p of pausesOn) {
      if (after.has(p.id)) continue;
      const ended = p.until && parseStamp(p.until) <= now;
      toHubEvent('info', `Recording resumed: ${pauseText(Object.assign({}, p, { until: null, reason: '' }), now, vars).replace(/ until it is resumed$/, '')}${ended ? ` (the pause ended at ${p.until.slice(11, 16)})` : ''}`);
    }
    if (list.length || pausesOn.length) log(list.length ? `paused: ${list.map(p => pauseText(p, now, vars)).join('; ')}` : 'recording again: no pause');
    pausesOn = list;
    pauseMatch = list.length ? pauseMatcher(list, vars) : null;
    pauseFrom = list.length ? Math.min(...list.map(p => parseStamp(p.since))) : Infinity;
    engine.setPaused(pauseMatch && pauseMatch.tag, now, monoNow());
    publishStatus();
  }
  setInterval(checkPauses, 1000).unref();
  // en hendelse fra en pauset enhet eller tag, under pausen (recorderens egne beholdes alltid)
  const pausedEvent = ev => !!pauseMatch && ev.source !== 'rec' && ev.ts >= pauseFrom && pauseMatch.source(String(ev.source || ''));
  function loadRulesFile(why) {
    const r = readRulesFile(RULES_PATH);
    if (r.missing) { if (recording) log(`${RULES_PATH} is gone: going on with the rules in use`); return; }
    if (r.error) {
      log(`recording rules not read: ${r.error}`);
      toHubEvent('warning', `The recording rules couldn't be read, so the recorder goes on with the rules it had. ${r.error}`);
      return;
    }
    for (const w of r.warnings) log(`recording rules: ${w} (that setting is left out)`);
    recording = r.recording;
    applyRules(why);
  }
  const httpBase = HUB.replace(/^ws/, 'http').replace(/\/+$/, '');
  function loadConfig() {
    http.get(httpBase + '/api/config', res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let cfg;
        try { cfg = JSON.parse(body); } catch (e) { return log('could not read the project:', e.message); }
        // huben får ikke lest prosjektfilen sin: fortsett lagringen med reglene og variablene vi har
        if (res.statusCode !== 200) return log(`could not read the project, going on as before: ${cfg.error || res.statusCode}`);
        vars = cfg.vars || {};
        // reglene lå før i prosjektfilen: flytt dem til regelfilen, én gang
        if (!recording && !fs.existsSync(RULES_PATH) && cfg.record && typeof cfg.record === 'object') {
          const c = checkRecording(cfg.record);
          try {
            writeRulesFile(RULES_PATH, c.recording);
            ownWrite = fs.statSync(RULES_PATH).mtimeMs;   // ikke en endring som skal lastes på nytt
            recording = c.recording;
            log(`recording rules moved from the project file to ${RULES_PATH}`);
            toHubEvent('info', `Recording rules moved from the project file to ${path.basename(RULES_PATH)}; set them in the database browser now`);
          } catch (e) { log(`could not write ${RULES_PATH}: ${e.message}`); }
        }
        applyRules(recording ? 'in use' : 'none');
      });
    }).on('error', e => log('could not reach the hub for the project:', e.message));
  }
  // hvor mange av hubens tagger en regel treffer, for statusen
  function countRecorded() {
    recordedCount = registry.filter(t => !t.startsWith('rec.') && ruleFor(rules, t)).length;
    publishStatus();
  }

  // ---- skriving
  let flushTimer = null;
  function scheduleFlush() {
    clearInterval(flushTimer);
    flushTimer = setInterval(() => flush('timer'), settings.flushSeconds * 1000);
  }
  const insSample = db.prepare('INSERT INTO sample (ts, boot, mono, tag, value, text, q) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insEvent = db.prepare('INSERT INTO event (ts, boot, mono, source, severity, message) VALUES (?, ?, ?, ?, ?, ?)');
  const insTag = db.prepare('INSERT OR IGNORE INTO tag (name) VALUES (?)');
  const getTag = db.prepare('SELECT id FROM tag WHERE name = ?');
  const insBatch = db.prepare('INSERT INTO batch (written, first_sample, last_sample, first_event, last_event, first_ts, last_ts, rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const lastId = t => db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = '${t}'`).get();
  const upRollup = db.prepare(`INSERT INTO rollup (tag, minute, lo, hi, n, bad, rows) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tag, minute) DO UPDATE SET
      lo = CASE WHEN lo IS NULL THEN excluded.lo WHEN excluded.lo IS NULL THEN lo ELSE MIN(lo, excluded.lo) END,
      hi = CASE WHEN hi IS NULL THEN excluded.hi WHEN excluded.hi IS NULL THEN hi ELSE MAX(hi, excluded.hi) END,
      n = n + excluded.n, bad = bad + excluded.bad, rows = rows + excluded.rows`);
  function tagId(name) {
    let id = tagIds.get(name);
    if (id === undefined) {
      insTag.run(name); id = getTag.get(name).id; tagIds.set(name, id);
      const n = hubNames.get(name);
      if (n && (n.label || n.info)) { setTagText.run(n.label || null, n.info || null, name); tagText.set(name, n.label + '\n' + n.info); }
    }
    return id;
  }
  // ---- dine egne navn på tagger, fra huben (config/tagnames.json der), kopiert inn i tabellen
  // tag som label og info hver gang de endres, så databasen forklarer seg selv
  const tagText = new Map(db.prepare('SELECT name, label, info FROM tag').all().map(r => [r.name, (r.label || '') + '\n' + (r.info || '')]));
  let hubNames = new Map();   // tag -> { label, info }, slik hubens tagliste har dem
  const setTagText = db.prepare('UPDATE tag SET label = ?, info = ? WHERE name = ?');
  function copyNames(list) {
    hubNames = new Map(list.map(t => [t.name, { label: t.label || '', info: t.info || '' }]));
    const changes = [];
    for (const [name, n] of hubNames) {
      if (tagIds.has(name) && tagText.get(name) !== n.label + '\n' + n.info) changes.push([name, n]);   // lagrede tagger; andre når de lagres første gang
    }
    if (!changes.length) return;
    try {
      db.exec('BEGIN');
      for (const [name, n] of changes) { setTagText.run(n.label || null, n.info || null, name); tagText.set(name, n.label + '\n' + n.info); }
      db.exec('COMMIT');
      log(`tag names: ${changes.length} copied into the database`);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (x) { /* ingenting å angre */ }
      log('tag names not copied:', e.message);
    }
  }
  function flush(why) {
    const s = buffer.samples, e = buffer.events;
    if (!s.length && !e.length) return;
    buffer.samples = []; buffer.events = [];
    const t0 = Date.now();
    try {
      db.exec('BEGIN');
      const before = { s: (lastId('sample') || { seq: 0 }).seq, e: (lastId('event') || { seq: 0 }).seq };
      let firstTs = Infinity, lastTs = -Infinity;
      const minutes = new Map();   // "tag:minute" -> minuttsammendraget for denne skrivingen
      for (const r of s) {
        const isText = typeof r.v === 'string';
        const val = isText ? null : typeof r.v === 'boolean' ? (r.v ? 1 : 0) : (typeof r.v === 'number' && Number.isFinite(r.v) ? r.v : null);
        const id = tagId(r.tag);
        insSample.run(r.ts, boot, Math.round(r.m), id, val, isText ? r.v : null, r.q);
        if (r.ts < firstTs) firstTs = r.ts; if (r.ts > lastTs) lastTs = r.ts;
        const key = id + ':' + Math.floor(r.ts / 60000);
        let mm = minutes.get(key);
        if (!mm) minutes.set(key, (mm = { id, minute: Math.floor(r.ts / 60000), lo: null, hi: null, n: 0, bad: 0, rows: 0 }));
        mm.rows++;
        if (r.q >= 2) mm.bad++;
        else if (val !== null) { mm.lo = mm.lo === null ? val : Math.min(mm.lo, val); mm.hi = mm.hi === null ? val : Math.max(mm.hi, val); mm.n++; }
      }
      for (const mm of minutes.values()) upRollup.run(mm.id, mm.minute, mm.lo, mm.hi, mm.n, mm.bad, mm.rows);
      for (const r of e) {
        insEvent.run(r.ts, boot, Math.round(r.m), r.source, r.severity, r.message);
        if (r.ts < firstTs) firstTs = r.ts; if (r.ts > lastTs) lastTs = r.ts;
      }
      const after = { s: (lastId('sample') || { seq: 0 }).seq, e: (lastId('event') || { seq: 0 }).seq };
      insBatch.run(Date.now(), s.length ? before.s + 1 : null, s.length ? after.s : null, e.length ? before.e + 1 : null, e.length ? after.e : null,
        firstTs, lastTs, s.length + e.length);
      db.exec('COMMIT');
      stored += s.length;
      lastWrite = Date.now();
      recentRate.push([monoNow(), s.length]);
      if (why !== 'timer') log(`wrote ${s.length} values and ${e.length} events (${why}) in ${Date.now() - t0} ms`);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (x) { /* ingenting å angre */ }
      buffer.samples = s.concat(buffer.samples); buffer.events = e.concat(buffer.events);   // behold dem til neste forsøk
      log('writing failed, will retry:', err.message);
    }
    enforceSize();
    publishStatus();
  }

  // ---- sletting av gamle data: hele skrivinger (batcher) om gangen, eldste først
  function deleteBatchesUpTo(batch) {
    db.exec('BEGIN');
    db.prepare('DELETE FROM batch WHERE id <= ?').run(batch.id);
    // minuttsammendraget følger verdiene: alt før det som er igjen
    const left = db.prepare('SELECT MIN(first_ts) AS t FROM batch').get();
    const from = left && left.t != null ? Math.floor(left.t / 60000) : null;
    if (batch.last_sample != null) {
      // verdier som forsvinner fra et minutt som blir stående (det eldste som er igjen, delt mellom to
      // skrivinger), trekkes også fra det, så tallene på Recording-siden stemmer med det som er lagret
      if (from !== null) {
        const gone = db.prepare(`SELECT tag, ts / 60000 AS minute, COUNT(CASE WHEN q < 2 AND value IS NOT NULL THEN 1 END) AS n,
          SUM(q >= 2) AS bad, COUNT(*) AS rows FROM sample WHERE id <= ? AND ts >= ? GROUP BY tag, ts / 60000`).all(batch.last_sample, from * 60000);
        const down = db.prepare('UPDATE rollup SET n = n - ?, bad = bad - ?, rows = rows - ? WHERE tag = ? AND minute = ?');
        const empty = db.prepare('DELETE FROM rollup WHERE tag = ? AND minute = ? AND rows <= 0');
        for (const g of gone) { down.run(g.n, g.bad, g.rows, g.tag, g.minute); empty.run(g.tag, g.minute); }
      }
      db.prepare('DELETE FROM sample WHERE id <= ?').run(batch.last_sample);
    }
    if (batch.last_event != null) db.prepare('DELETE FROM event WHERE id <= ?').run(batch.last_event);
    if (from !== null) db.prepare('DELETE FROM rollup WHERE minute < ?').run(from);
    else db.exec('DELETE FROM rollup');
    db.exec('COMMIT');
    stored = db.prepare('SELECT COUNT(*) AS n FROM sample').get().n;
  }
  function enforceAge() {
    const cutoff = Date.now() - settings.keepDays * 86400000;
    const last = db.prepare('SELECT * FROM batch WHERE last_ts < ? ORDER BY id DESC LIMIT 1').get(cutoff);
    if (last) { deleteBatchesUpTo(last); log(`deleted data older than ${settings.keepDays} days`); }
  }
  function enforceSize() {
    if (usedMB(db) <= settings.maxMB) return;
    const target = settings.maxMB * 0.9;
    let from = null, to = null, n = 0;
    while (usedMB(db) > target) {
      const oldest = db.prepare('SELECT * FROM batch ORDER BY id LIMIT 1').get();
      if (!oldest) break;
      // slett omtrent en tidel av batchene om gangen
      const count = db.prepare('SELECT COUNT(*) AS n FROM batch').get().n;
      const upTo = db.prepare('SELECT * FROM batch ORDER BY id LIMIT 1 OFFSET ?').get(Math.max(0, Math.floor(count / 10) - 1));
      if (from == null) from = oldest.first_ts;
      to = upTo.last_ts;
      deleteBatchesUpTo(upTo);
      n++;
      if (count <= 1) break;
    }
    if (from != null) toHubEvent('warning', `Recorder database reached its size limit of ${settings.maxMB} MB: deleted the oldest data, from ${fmtTime(from)} to ${fmtTime(to)}`);
  }
  setInterval(enforceAge, 10 * 60000).unref();

  // ---- status som rec.*-tagger
  let adapter = null, adapterOpen = false;
  function toHubEvent(severity, message) {
    if (adapterOpen) adapter.send(JSON.stringify({ type: 'event', severity, message }));
    else log(`[${severity}] ${message}`);
  }
  function publishStatus() {
    if (!adapterOpen) return;
    const now = monoNow();
    recentRate = recentRate.filter(([t]) => now - t < 10 * 60000);
    const span = recentRate.length ? Math.max(settings.flushSeconds * 1000, now - recentRate[0][0] + settings.flushSeconds * 1000) : 0;
    const rows = recentRate.reduce((a, [, n]) => a + n, 0);
    // målt: omtrent 47 byte per lagret verdi med trendindeksen; små databaser er for det meste fast overhead
    const bytesPerRow = stored > 20000 ? (usedMB(db) * 1e6) / stored : 47;
    const values = {
      'rec.buffered': buffer.samples.length + buffer.events.length,
      'rec.last_write': lastWrite ? fmtTime(lastWrite) : '',
      'rec.stored': stored,
      'rec.db_mb': Math.round(usedMB(db) * 100) / 100,
      'rec.recorded_tags': recordedCount,
      'rec.flickering': engine ? [...engine.states.values()].filter(s => s.flickering).length : 0,
      'rec.mb_per_day': span ? Math.round(rows / (span / 1000) * 86400 * bytesPerRow / 1e6 * 10) / 10 : 0,
      'rec.rules_at': rulesAt,
      'rec.paused': pausesOn.length,
      'rec.pause_text': pausesOn.map(p => pauseText(p, null, vars)).join('; '),
    };
    adapter.send(JSON.stringify({ type: 'update', values }));
  }
  // ---- historikk for trender. Huben sender spørsmålet fra en trend videre ({ type: 'query', id, tags,
  // from, to, points }), og dette svarer fra databasen og verdiene som fortsatt er i RAM.
  // Hver tag får høyst `points` tidsluker (buckets), hver med sin laveste og høyeste verdi, så en
  // kort topp likevel vises i en trend over en uke. Verdier lagres når de endres, så svaret
  // starter med siste verdi før `from`; null markerer hvor verdien ble foreldet.
  const qFirst = db.prepare('SELECT MIN(first_sample) AS id FROM batch WHERE last_ts >= ?');
  const qLast = db.prepare('SELECT MAX(last_sample) AS id FROM batch WHERE first_ts <= ?');
  const qBuckets = db.prepare(`SELECT CAST((ts - ?) / ? AS INTEGER) AS b, MIN(CASE WHEN q < 2 THEN value END) AS lo,
      MAX(CASE WHEN q < 2 THEN value END) AS hi, COUNT(CASE WHEN q < 2 AND value IS NOT NULL THEN 1 END) AS n,
      SUM(q >= 2) AS bad, MIN(ts) AS t0
    FROM sample WHERE tag = ? AND id BETWEEN ? AND ? AND ts BETWEEN ? AND ? GROUP BY b`);
  // luker på ett minutt eller mer hentes fra minuttsammendraget: én rad per minutt, ikke hver verdi
  const qRollup = db.prepare(`SELECT CAST((minute * 60000 - ?) / ? AS INTEGER) AS b, MIN(lo) AS lo, MAX(hi) AS hi,
      SUM(n) AS n, SUM(bad) AS bad, MIN(minute) * 60000 AS t0
    FROM rollup WHERE tag = ? AND minute BETWEEN ? AND ? GROUP BY b`);
  // verdien som gjaldt da tidsrommet startet: i den første skrivingen som når inn i det, eller før
  const qFirstBatch = db.prepare('SELECT first_sample AS a, last_sample AS z FROM batch WHERE last_ts >= ? AND first_sample IS NOT NULL ORDER BY first_sample LIMIT 1');
  const qBeforeIn = db.prepare('SELECT value, q FROM sample WHERE tag = ? AND id BETWEEN ? AND ? AND ts < ? ORDER BY id DESC LIMIT 1');
  const qBeforeOut = db.prepare('SELECT value, q FROM sample WHERE tag = ? AND id < ? ORDER BY id DESC LIMIT 1');
  function history(q) {
    const from = Math.floor(Number(q.from)), to = Math.ceil(Number(q.to));
    if (!(to > from)) throw new Error('empty time range');
    const n = Math.max(10, Math.min(4000, Math.round(Number(q.points) || 1000)));
    const bucket = Math.max(1, Math.ceil((to - from) / n));
    const byMinute = bucket >= 60000;
    const first = (qFirst.get(from) || {}).id, last = (qLast.get(to) || {}).id;
    const fb = qFirstBatch.get(from);
    const series = {}, unrecorded = [];
    for (const name of (Array.isArray(q.tags) ? q.tags : []).slice(0, 8)) {
      const id = tagIds.get(name);
      // aldri lagret: ingen lagringsregel treffer den (huben svarer da fra minnet sitt)
      if (id == null && !buffer.samples.some(s => s.tag === name)) { unrecorded.push(name); continue; }
      const buckets = new Map();
      let before = null;
      if (id != null) {
        if (byMinute) for (const r of qRollup.iterate(from, bucket, id, Math.floor(from / 60000), Math.floor(to / 60000))) buckets.set(r.b, r);
        else if (first != null && last != null) for (const r of qBuckets.iterate(from, bucket, id, first, last, from, to)) buckets.set(r.b, r);
        before = (fb && qBeforeIn.get(id, fb.a, fb.z, from)) || qBeforeOut.get(id, fb ? fb.a : Number.MAX_SAFE_INTEGER) || null;
      }
      for (const s of buffer.samples) {   // ikke skrevet ennå
        if (s.tag !== name || s.ts < from || s.ts > to) continue;
        const b = Math.floor((s.ts - from) / bucket);
        const v = typeof s.v === 'boolean' ? (s.v ? 1 : 0) : (typeof s.v === 'number' && Number.isFinite(s.v) ? s.v : null);
        const r = buckets.get(b) || { b, lo: null, hi: null, n: 0, bad: 0, t0: s.ts };
        if (s.q >= 2) r.bad++;
        else if (v !== null) { r.lo = r.lo === null ? v : Math.min(r.lo, v); r.hi = r.hi === null ? v : Math.max(r.hi, v); r.n++; }
        buckets.set(b, r);
      }
      const pts = [];
      if (before && before.q < 2 && before.value !== null) pts.push([from, before.value]);
      for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
        const r = buckets.get(b), t = from + b * bucket;
        if (r.n === 1 || (r.n && r.lo === r.hi)) pts.push([Math.max(t, r.t0), r.lo]);
        else if (r.n) pts.push([t + bucket * 0.25, r.lo], [t + bucket * 0.75, r.hi]);
        if (r.bad) pts.push([t + bucket, null]);
      }
      series[name] = pts;
    }
    return { series, unrecorded, bucket };
  }

  function connectAdapter() {
    adapter = new WebSocket(HUB);
    adapter.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== 'query') return;
      const t0 = Date.now();
      let reply;
      try { reply = Object.assign({ type: 'queryResult', id: m.id }, history(m)); }
      catch (e) { reply = { type: 'queryResult', id: m.id, error: e.message }; }
      reply.ms = Date.now() - t0;
      if (adapterOpen) adapter.send(JSON.stringify(reply));
    });
    adapter.on('open', () => {
      adapterOpen = true;
      adapter.send(JSON.stringify({ type: 'hello', role: 'adapter', name: 'rec', serves: ['history'] }));
      adapter.send(JSON.stringify({ type: 'register', tags: [
        { name: 'rec.buffered', dataType: 'number', description: 'values waiting in RAM for the next write' },
        { name: 'rec.last_write', dataType: 'string' },
        { name: 'rec.stored', dataType: 'number', description: 'values in the database' },
        { name: 'rec.db_mb', dataType: 'number', unit: 'MB' },
        { name: 'rec.recorded_tags', dataType: 'number', description: 'tags matched by a recording rule' },
        { name: 'rec.flickering', dataType: 'number', description: 'tags whose changes are held back as flickering' },
        { name: 'rec.mb_per_day', dataType: 'number', unit: 'MB/day', description: 'at the rate of the last 10 minutes' },
        { name: 'rec.rules_at', dataType: 'string', description: 'when the recording rules in use were loaded' },
        { name: 'rec.paused', dataType: 'number', description: 'pauses on now (0: recording as the rules say)' },
        { name: 'rec.pause_text', dataType: 'string', description: 'what is paused, until when, and why' },
      ] }));
      publishStatus();
    });
    adapter.on('close', () => { adapterOpen = false; setTimeout(connectAdapter, 2000); });
    adapter.on('error', () => {});
  }
  setInterval(publishStatus, 5000).unref();

  // ---- lytter på huben, kun lesing
  let reader = null;
  function connectReader() {
    reader = new WebSocket(HUB);
    reader.on('open', () => {
      log(`connected to ${HUB} (read-only); database ${DB_PATH}`);
      reader.send(JSON.stringify({ type: 'hello', role: 'hmi', name: 'recorder', readonly: true }));
      reader.send(JSON.stringify({ type: 'subscribe', tags: ['*'] }));
      loadConfig();
    });
    reader.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      const mono = monoNow();
      if (m.type === 'update' && engine) {
        const values = m.values || { [m.tag]: m.value };
        for (const tag of Object.keys(values)) if (!tag.startsWith('rec.')) engine.value(tag, values[tag], m.quality || 'good', m.ts || Date.now(), mono);
      } else if (m.type === 'tags') {
        registry = (m.tags || []).map(t => t.name);
        copyNames(m.tags || []);
        countRecorded();
      } else if ((m.type === 'event' || m.type === 'events') && settings.events) {
        for (const ev of m.type === 'events' ? m.events || [] : [m]) {
          if (ev.ts <= lastEventTs) continue;                       // lagret i en tidligere kjøring
          if (pausedEvent(ev)) continue;
          const key = `${ev.ts}|${ev.source}|${ev.message}`;
          if (recentEvents.has(key)) continue;
          recentEvents.add(key);
          if (recentEvents.size > 2000) recentEvents.delete(recentEvents.values().next().value);
          buffer.events.push({ ts: ev.ts, m: mono, source: ev.source, severity: ev.severity, message: ev.message });
        }
      } else if (m.type === 'configChanged') {
        loadConfig();
      }
    });
    reader.on('close', () => { log('hub connection lost, retrying in 2 s'); setTimeout(connectReader, 2000); });
    reader.on('error', () => {});
  }
  setInterval(() => { if (engine) engine.tick(Date.now(), monoNow()); }, 250).unref();

  // ---- en normal stopp skriver det som er i RAM
  const stop = sig => { log(`${sig}: writing what is in RAM, then stopping`); flush('stopping'); try { db.close(); } catch (e) { /* lukket */ } process.exit(0); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  log(`recording rules: ${RULES_PATH}`);
  loadRulesFile('loaded');
  fs.watchFile(RULES_PATH, { interval: 2000 }, (cur, prev) => {
    if ((cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) && cur.mtimeMs !== ownWrite) loadRulesFile('changed');
  });
  connectReader();
  connectAdapter();
  scheduleFlush();
  enforceAge();
}

if (flag('--query') || flag('--events') || flag('--info')) runQuery();
else runRecorder();
