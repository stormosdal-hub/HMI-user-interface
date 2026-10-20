#!/usr/bin/env node
'use strict';
/*
 * Databaseleseren: se gjennom en SQLite-database i en nettleser. Laget for recorderens
 * database (tagnavn og tider vist lesbart), og virker med alle andre SQLite-filer.
 *
 *   node db-browser.js [--db data/recorder.db] [--port 8088] [--write] [--local] [--hub http://localhost:8080]
 *
 *   --db      databasefilen (standard: recorderens standard, data/recorder.db)
 *   --port    webporten (standard 8088)
 *   --write   tillat endringer: redigere rader, lage og endre tabeller. Uten den åpnes
 *             databasen skrivebeskyttet, og ingenting du skriver noe sted kan endre den.
 *   --local   bare denne datamaskinen kan åpne siden (standard: hele nettverket, som huben)
 *   --hub     hvor huben er, for taglisten og recorderens status (standard: denne datamaskinen)
 *
 * Recording: hva recorderen lagrer, hvor mye av hver tag, og reglene som bestemmer det; og
 * å pause lagringen, f.eks. under vedlikehold. Reglene og pausene er en fil ved siden av databasen
 * (recorder.rules.json, se lib/record-rules.js), ikke i databasen, så de kan settes uten
 * --write; recorderen plukker dem opp av seg selv.
 * Tagnavn: ditt eget navn og din egen beskrivelse for hver tag. Huben har dem (tagnames.json ved
 * siden av prosjektet), så denne siden trenger huben for å endre dem. Se docs/DATABASE-BROWSER.md.
 *
 * Bruker Nodes innebygde SQLite (Node.js 22.13 eller nyere, som recorderen) og ingen npm-pakker,
 * så den kjører på en Raspberry Pi uten internett som den er: kopier hmi-core, start den.
 */

// ---------------------------------------------------------------- Node-versjon (denne delen må virke i gammel Node)
var parts = process.versions.node.split('.').map(Number);
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 13)) {
  console.error('The database browser needs Node.js 22.13 or newer for its built-in SQLite; this computer has ' + process.version + '.');
  console.error('See "Installing without internet" in README.md for how to install a newer Node.js.');
  process.exit(1);
}
// node:sqlite skriver en "experimental"-advarsel ved hver start; den sier ingenting nyttig her
const emit = process.emitWarning;
process.emitWarning = function (w) {
  if (String(w && w.message || w).includes('SQLite')) return;
  return emit.apply(process, arguments);
};

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const RR = require('./lib/record-rules');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
if (flag('--help') || flag('-h')) {
  console.log('node db-browser.js [--db data/recorder.db] [--port 8088] [--write] [--local] [--hub http://localhost:8080]');
  process.exit(0);
}
const DB_PATH = path.resolve(opt('--db', path.join(__dirname, 'data', 'recorder.db')));
const RULES_PATH = RR.rulesFileFor(DB_PATH);
const HUB = opt('--hub', process.env.HUB_URL || 'http://localhost:8080').replace(/^ws/, 'http').replace(/\/+$/, '');
const PORT = Number(opt('--port', 8088));
const WRITE = flag('--write');
const HOST = flag('--local') ? '127.0.0.1' : '0.0.0.0';
const UI_DIR = path.join(__dirname, 'db-browser');
const MAX_ROWS = 1000;           // rader sendt for én side eller ett SQL-resultat, uansett hvor mange som treffer

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// lag aldri en tom database ved en feil, for en feilskrevet sti
if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}.`);
  console.error('The recorder makes it the first time it starts (node recorder.js). If you gave the recorder');
  console.error('another place with --db, give the browser the same: node db-browser.js --db <that file>');
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH, { readOnly: !WRITE });
db.exec('PRAGMA busy_timeout = 5000');   // recorderen skriver kanskje: vent på den i stedet for å feile

// ---------------------------------------------------------------- hjelpefunksjoner
const q = name => '"' + String(name).replace(/"/g, '""') + '"';   // et SQL-navn i anførselstegn
// setReturnArrays og columns() kom i Node 22.16: med dem beholder et resultat kolonner som
// har samme navn (SELECT a.id, b.id); uten dem er radene objekter
function prepare(sql) {
  const st = db.prepare(sql);
  const arrays = typeof st.setReturnArrays === 'function' && typeof st.columns === 'function';
  if (arrays) st.setReturnArrays(true);
  return { st, arrays };
}
// de første `max` radene, som arrays, med kolonnenavnene, og om det var flere
function fetchRows(sql, params, max) {
  const { st, arrays } = prepare(sql);
  const rows = [];
  let columns = arrays ? st.columns().map(c => c.name) : null, truncated = false;
  for (const r of st.iterate(...params)) {
    if (rows.length >= max) { truncated = true; break; }
    if (!columns) columns = Object.keys(r);
    rows.push(arrays ? r : columns.map(c => r[c]));
  }
  return { columns: columns || [], rows, truncated };
}
// verdier som går til nettleseren: BLOB-er som en kort beskrivelse, store heltall som tekst
const clean = v => (v instanceof Uint8Array ? `[${v.length} bytes]` : typeof v === 'bigint' ? String(v) : v);
const cleanRows = rows => rows.map(r => r.map(clean));

function objects() {
  const all = db.prepare("SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger') ORDER BY type, name").all();
  return all;
}
function objectNamed(name, types) {
  const o = objects().find(x => x.name === name && types.includes(x.type));
  if (!o) throw Object.assign(new Error(`There is no ${types.join(' or ')} named "${name}"`), { status: 404 });
  return o;
}
const withoutRowid = o => o.type === 'table' && /\bWITHOUT\s+ROWID\b/i.test(o.sql || '');

// antall rader: nøyaktig, unntatt for en enorm tabell der rowid-spennet svarer med en gang
function rowCount(o) {
  if (o.type === 'table' && !withoutRowid(o)) {
    const r = db.prepare(`SELECT MAX(rowid) - MIN(rowid) + 1 AS n FROM ${q(o.name)}`).get();
    if (r && r.n > 5e6) return { rows: r.n, estimated: true };
  }
  try { return { rows: db.prepare(`SELECT COUNT(*) AS n FROM ${q(o.name)}`).get().n, estimated: false }; }
  catch (e) { return { rows: null, error: e.message }; }
}
// plass per tabell og indeks, når SQLite ble bygget med dbstat-tabellen (Nodes er det)
function sizes() {
  try {
    const out = {};
    for (const r of db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all()) out[r.name] = r.bytes;
    return out;
  } catch (e) { return null; }
}
const fileSize = f => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
const isRecorder = () => ['sample', 'tag', 'batch'].every(n => objects().some(o => o.type === 'table' && o.name === n));

function tableInfo(name) {
  const o = objectNamed(name, ['table', 'view']);
  const columns = db.prepare(`PRAGMA table_xinfo(${q(name)})`).all().filter(c => c.hidden !== 1)
    .map(c => ({ name: c.name, type: c.type, notnull: !!c.notnull, dflt: c.dflt_value, pk: c.pk, generated: c.hidden > 1 }));
  const indexes = o.type !== 'table' ? [] : db.prepare(`PRAGMA index_list(${q(name)})`).all().map(ix => ({
    name: ix.name, unique: !!ix.unique, origin: ix.origin,
    columns: db.prepare(`PRAGMA index_info(${q(ix.name)})`).all().map(c => c.name),
    sql: (objects().find(x => x.type === 'index' && x.name === ix.name) || {}).sql || null,
  }));
  const foreignKeys = o.type !== 'table' ? [] : db.prepare(`PRAGMA foreign_key_list(${q(name)})`).all()
    .map(f => ({ from: f.from, table: f.table, to: f.to }));
  const triggers = objects().filter(x => x.type === 'trigger' && x.tbl === name).map(x => ({ name: x.name, sql: x.sql }));
  const sz = sizes();
  return {
    name, type: o.type, sql: o.sql, withoutRowid: withoutRowid(o), columns, indexes, foreignKeys, triggers,
    ...rowCount(o),
    bytes: sz ? (sz[name] || 0) + indexes.reduce((a, ix) => a + (sz[ix.name] || 0), 0) : null,
  };
}

// hvordan radene i en tabell skilles, for redigering: rowid, primærnøkkelen, eller ikke (views)
function keyOf(info) {
  if (info.type !== 'table') return null;
  if (!info.withoutRowid) return ['rowid'];
  return info.columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
}
const keySql = key => key.map(k => (k === 'rowid' ? 'rowid' : q(k)));

// én side av en tabell: nyeste først som standard, et filter skrevet som en SQL-betingelse
function tableRows({ name, where, order, dir, offset, limit }) {
  const info = tableInfo(name);
  const key = keyOf(info);
  const names = info.columns.map(c => c.name);
  if (order && order !== 'rowid' && !names.includes(order)) throw new Error(`There is no column "${order}"`);
  const by = order ? [order === 'rowid' ? 'rowid' : q(order)] : key ? keySql(key) : [];
  const desc = dir ? dir === 'desc' : !order && !!key;   // nyeste først hvis ikke sortert på annen måte
  const lim = Math.max(1, Math.min(MAX_ROWS, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  const keyCols = key && key[0] === 'rowid' ? 'rowid AS "__rowid__", ' : '';
  const sql = `SELECT ${keyCols}* FROM ${q(name)}${where ? ` WHERE (${where})` : ''}` +
    `${by.length ? ` ORDER BY ${by.map(b => `${b} ${desc ? 'DESC' : 'ASC'}`).join(', ')}` : ''} LIMIT ${lim + 1} OFFSET ${off}`;
  const t0 = Date.now();
  const r = fetchRows(sql, [], lim + 1);
  const more = r.rows.length > lim;
  return { columns: r.columns, rows: cleanRows(r.rows.slice(0, lim)), hasMore: more, key, offset: off, sql, ms: Date.now() - t0 };
}

// setninger i et stykke SQL, uten å telle ; inne i anførselstegn og kommentarer
function statementCount(sql) {
  const bare = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  return bare.split(';').filter(s => s.trim()).length;
}
// SQL-boksen. En spørring gir rader tilbake; en endring melder hvor mange rader den endret. Flere
// setninger på en gang kjøres sammen, uten resultater.
function runSql(sql) {
  const t0 = Date.now();
  const text = String(sql || '').trim();
  if (!text) throw new Error('Type an SQL statement first');
  if (statementCount(text) > 1) {
    db.exec(text);
    return { message: `Ran ${statementCount(text)} statements. Results are shown for one statement at a time.`, ms: Date.now() - t0 };
  }
  if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i.test(text)) {
    const r = fetchRows(text, [], MAX_ROWS);
    return { columns: r.columns, rows: cleanRows(r.rows), truncated: r.truncated, ms: Date.now() - t0 };
  }
  const res = db.prepare(text).run();
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid), ms: Date.now() - t0 };
}

// ---- recorderens database, lesbart: tagnavn og tider
const TIME_COLUMNS = /^(ts|first_ts|last_ts|written|first_seen)$/;
// dine egne navn står i tag-tabellen (label, info) når recorderen har kopiert dem
const hasLabels = () => !!db.prepare("SELECT 1 FROM pragma_table_info('tag') WHERE name = 'label'").get();
function lookups() {
  if (!isRecorder()) return { recorder: false };
  const tags = {}, labels = {};
  for (const r of db.prepare(`SELECT id, name${hasLabels() ? ', label' : ''} FROM tag`).all()) { tags[r.id] = r.name; if (r.label) labels[r.id] = r.label; }
  return { recorder: true, tags, labels };
}
const localTime = ms => { const d = new Date(ms); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`; };

// en hel tabell (eller de filtrerte radene) som CSV, skrevet mens den leses: alle størrelser, lite minne
async function exportCsv(res, { name, where, readable }) {
  const info = tableInfo(name);
  const look = readable ? lookups() : { recorder: false };
  const { st } = prepare(`SELECT * FROM ${q(name)}${where ? ` WHERE (${where})` : ''}`);
  if (typeof st.setReturnArrays === 'function') st.setReturnArrays(false);
  const cols = info.columns.map(c => c.name);
  const extra = [];   // lesbare kolonner ved siden av de rå
  if (look.recorder && cols.includes('tag')) extra.push(['tag_name', r => look.tags[r.tag] || '']);
  if (look.recorder && cols.includes('tag') && Object.keys(look.labels).length) extra.push(['tag_label', r => look.labels[r.tag] || '']);
  if (readable) for (const c of cols) if (TIME_COLUMNS.test(c)) extra.push([c + '_time', r => (typeof r[c] === 'number' ? localTime(r[c]) : '')]);
  if (readable && name === 'rollup') extra.push(['minute_time', r => localTime(r.minute * 60000)]);
  const cell = v => { v = clean(v); if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}.csv"` });
  res.write([...cols, ...extra.map(e => e[0])].join(',') + '\n');
  let n = 0, chunk = '';
  for (const r of st.iterate()) {
    chunk += [...cols.map(c => cell(r[c])), ...extra.map(e => cell(e[1](r)))].join(',') + '\n';
    if (++n % 2000 === 0) { if (!res.write(chunk)) await new Promise(ok => res.once('drain', ok)); chunk = ''; }
  }
  res.end(chunk);
  log(`[export] ${name}: ${n} rows`);
}

// en kopi av hele databasen, konsistent selv mens recorderen skriver (VACUUM INTO)
function backup() {
  const pages = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
  const dir = path.dirname(DB_PATH);
  if (typeof fs.statfsSync === 'function') {
    const s = fs.statfsSync(dir);
    const free = s.bavail * s.bsize;
    if (free < pages * 1.1) throw new Error(`Not enough free space in ${dir}: the copy needs about ${mb(pages)}, ${mb(free)} is free`);
  }
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const file = path.join(dir, `${path.basename(DB_PATH, path.extname(DB_PATH))}-backup-${stamp}${path.extname(DB_PATH) || '.db'}`);
  if (fs.existsSync(file)) throw new Error(`${file} exists already; try again in a minute`);
  const t0 = Date.now();
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  log(`[backup] ${file} (${mb(fileSize(file))}, ${Date.now() - t0} ms)`);
  return { file, bytes: fileSize(file), ms: Date.now() - t0 };
}
const mb = b => `${(b / 1e6).toFixed(1)} MB`;

// ---- endre rader (bare med --write). Verdier kommer som JSON: null, tall og tekst.
function keyWhere(info, keyValues) {
  const key = keyOf(info);
  if (!key || !key.length) throw new Error(`Rows of ${info.name} can't be told apart (a view, or no primary key)`);
  return { sql: key.map(k => `${k === 'rowid' ? 'rowid' : q(k)} = ?`).join(' AND '), params: key.map(k => keyValues[k === 'rowid' ? '__rowid__' : k]) };
}
function checkColumns(info, values) {
  const names = info.columns.map(c => c.name);
  const cols = Object.keys(values || {});
  for (const c of cols) if (!names.includes(c)) throw new Error(`There is no column "${c}" in ${info.name}`);
  return cols;
}
function updateRow({ table, key, values }) {
  const info = tableInfo(table);
  const cols = checkColumns(info, values);
  if (!cols.length) throw new Error('Nothing to change');
  const w = keyWhere(info, key);
  const r = db.prepare(`UPDATE ${q(table)} SET ${cols.map(c => `${q(c)} = ?`).join(', ')} WHERE ${w.sql}`).run(...cols.map(c => values[c]), ...w.params);
  return { changes: Number(r.changes) };
}
function insertRow({ table, values }) {
  const info = tableInfo(table);
  const cols = checkColumns(info, values);
  const sql = cols.length ? `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})` : `INSERT INTO ${q(table)} DEFAULT VALUES`;
  const r = db.prepare(sql).run(...cols.map(c => values[c]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}
function deleteRow({ table, key }) {
  const info = tableInfo(table);
  const w = keyWhere(info, key);
  const r = db.prepare(`DELETE FROM ${q(table)} WHERE ${w.sql}`).run(...w.params);
  return { changes: Number(r.changes) };
}

// ---------------------------------------------------------------- lagring
// huben, for taggene, prosjektets variabler og recorderens status. Valgfri: uten den
// viser Recording hva som er lagret, og reglene kan fortsatt settes.
// { data } eller { error }; med `send` blir det sendt med POST som JSON
function hubJson(p, send) {
  return new Promise(resolve => {
    const body = send === undefined ? null : Buffer.from(JSON.stringify(send));
    const req = http.request(HUB + p, { method: body ? 'POST' : 'GET', timeout: 2500,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* ikke JSON */ }
        if (res.statusCode === 200 && j) resolve({ data: j });
        else resolve({ error: (j && j.error) || `the hub answered ${res.statusCode}` });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'the hub did not answer' }); });
    req.on('error', e => resolve({ error: `the hub can't be reached at ${HUB} (${e.code || e.message})` }));
    req.end(body || undefined);
  });
}

async function recordingInfo() {
  const file = RR.readRulesFile(RULES_PATH);
  const [tags, cfg] = await Promise.all([hubJson('/api/tags'), hubJson('/api/config')]);
  const hubTags = tags.data ? tags.data.filter(t => !String(t.name).startsWith('rec.')) : [];
  const rec = {};
  if (tags.data) for (const t of tags.data) if (String(t.name).startsWith('rec.')) rec[t.name.slice(4)] = { value: t.value, stale: t.quality === 'bad' || t.online === false };
  const lastWrite = isRecorder() ? (db.prepare('SELECT MAX(written) AS t FROM batch').get() || {}).t : null;
  const val = k => (rec[k] ? rec[k].value : null);
  return {
    file: RULES_PATH, exists: !file.missing, error: file.error || null, warnings: file.warnings || [],
    recording: file.recording || Object.assign({}, RR.DEFAULTS, { rules: [] }),
    pauses: RR.activePauses(file.recording, Date.now()),
    // hva recorderen sier den har pauset: den leser filen hvert 2. sekund
    recorderPaused: rec.paused && !rec.paused.stale ? { count: val('paused'), text: val('pause_text') } : null,
    hub: { url: HUB, ok: !tags.error, error: tags.error || null },
    vars: (cfg.data && cfg.data.vars) || {},
    // hva prosjektfilen fortsatt sier, for et gammelt prosjekt der reglene ikke er flyttet ennå
    projectRules: !file.missing ? null : (cfg.data && cfg.data.record) || null,
    hubTags: hubTags.map(t => ({ name: t.name, label: t.label || '', type: t.dataType, unit: t.unit || '', online: t.online !== false, calc: t.source === 'calc' })),
    recorder: { running: !!(rec.rules_at && !rec.rules_at.stale), rulesAt: rec.rules_at ? rec.rules_at.value : null, buffered: rec.buffered ? rec.buffered.value : null, mbPerDay: rec.mb_per_day ? rec.mb_per_day.value : null, lastWrite },
  };
}

// lagre reglene: sjekkes først. En fil som ikke kunne leses, beholdes ved siden av, ikke tapt.
function saveRecording(recording) {
  const c = RR.checkRecording(Object.assign({}, recording, { pauses: undefined }));
  if (c.errors.length) throw Object.assign(new Error(c.errors.join('\n')), { errors: c.errors });
  const before = RR.readRulesFile(RULES_PATH);
  // pauser settes med Pause og Resume, med en gang, ikke med reglene: de som gjelder nå, blir
  const onNow = RR.activePauses(before.recording, Date.now());
  if (onNow.length) c.recording.pauses = onNow;
  let kept = null;
  if (before.error && fs.existsSync(RULES_PATH)) {
    kept = RULES_PATH + '.unreadable-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(RULES_PATH, kept);
  }
  RR.writeRulesFile(RULES_PATH, c.recording);
  log(`[rules] saved ${c.recording.rules.length} rule(s) to ${RULES_PATH}${kept ? `; the unreadable file kept as ${kept}` : ''}`);
  return { saved: c.recording, kept };
}

// ---- pause: rett inn i regelfilen, resten av den blir nøyaktig som den er. Recorderen
// leser den innen 2 s. Tider er denne datamaskinens klokke, recorderens også.
function readRulesRaw() {
  let raw;
  try { raw = fs.readFileSync(RULES_PATH, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') throw new Error('There are no recording rules yet, so nothing is recorded and there is nothing to pause.');
    throw new Error(`${RULES_PATH} can't be read: ${e.message}`);
  }
  try {
    const j = JSON.parse(raw.replace(/^﻿/, ''));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('it holds no rules');
    return j;
  } catch (e) { throw new Error(`${RULES_PATH} is not valid (${e.message}). Save the rules on the Recording page first, then pause.`); }
}
// { action: 'start', tags, minutes (0: til den gjenopptas), reason } | { action: 'end', id | all }
// | { action: 'extend', id, minutes (0: til den gjenopptas) }
function changePauses(b) {
  const file = readRulesRaw();
  const now = Date.now();
  // pauser som er over, ryddes bort
  let pauses = RR.activePauses({ pauses: RR.checkRecording({ pauses: file.pauses }).recording.pauses }, now);
  const minutes = Number(b.minutes) || 0;
  if (minutes < 0 || minutes > 60 * 24 * 60) throw new Error('A pause lasts from a minute to 60 days, or until it is resumed');
  let what;
  if (b.action === 'start') {
    const tags = String(b.tags || '').trim() || '*';
    const reason = String(b.reason || '').trim().slice(0, 200);
    const p = { id: now.toString(36) + Math.random().toString(36).slice(2, 5), tags, since: RR.localStamp(now), until: minutes ? RR.localStamp(now + minutes * 60000) : null };
    if (reason) p.reason = reason;
    pauses.push(p);
    what = `paused ${RR.pauseText(p, now)}`;
  } else if (b.action === 'end') {
    const n = pauses.length;
    pauses = b.all ? [] : pauses.filter(p => p.id !== b.id);
    if (pauses.length === n) throw new Error('That pause is over already');
    what = b.all ? 'resumed everything' : 'resumed one pause';
  } else if (b.action === 'extend') {
    const p = pauses.find(x => x.id === b.id);
    if (!p) throw new Error('That pause is over already');
    p.until = minutes ? RR.localStamp(Math.max(now, p.until ? RR.parseStamp(p.until) : now) + minutes * 60000) : null;
    what = `longer: ${RR.pauseText(p, now)}`;
  } else throw new Error('unknown pause action');
  if (pauses.length) file.pauses = pauses; else delete file.pauses;
  RR.writeRulesFile(RULES_PATH, file);
  log(`[pause] ${what}`);
  return { pauses };
}

// ---- tagnavn: huben har dem (tagnames.json ved siden av prosjektet); databasen har en kopi
// av navnene på lagrede tagger (tag.label, tag.info), vist når huben ikke kan nås
async function namesInfo() {
  const [tags, names] = await Promise.all([hubJson('/api/tags'), hubJson('/api/names')]);
  const out = new Map();
  const get = name => { if (!out.has(name)) out.set(name, { name, label: '', info: '', stored: false, onHub: false }); return out.get(name); };
  if (isRecorder()) {
    for (const r of db.prepare(`SELECT name${hasLabels() ? ', label, info' : ''} FROM tag`).all()) {
      if (String(r.name).startsWith('rec.')) continue;
      Object.assign(get(r.name), { stored: true }, names.data ? {} : { label: r.label || '', info: r.info || '' });
    }
  }
  if (tags.data) for (const h of tags.data) {
    if (String(h.name).startsWith('rec.')) continue;
    Object.assign(get(h.name), { onHub: true, online: h.online !== false, value: h.value, quality: h.quality, type: h.dataType,
      unit: h.unit || '', description: h.description || '', deviceLabel: h.deviceLabel || '', calc: h.source === 'calc' });
  }
  if (names.data) for (const [tag, n] of Object.entries(names.data.byTag || {})) Object.assign(get(tag), { label: n.name, info: n.info, key: n.key });
  return { hub: { url: HUB, ok: !names.error, error: names.error || null }, file: names.data ? names.data.file : null,
    vars: names.data ? names.data.vars : {}, tags: [...out.values()] };
}
// verdiene nå, for å se hvilken bit som endrer seg
async function hubValues() {
  const tags = await hubJson('/api/tags');
  if (tags.error) throw new Error(tags.error);
  const values = {};
  for (const h of tags.data) values[h.name] = [h.value === undefined ? null : h.value, h.quality === 'bad' || h.online === false];
  return { values };
}
async function saveNames(changes) {
  const r = await hubJson('/api/names', { changes: Array.isArray(changes) ? changes : [] });
  if (r.error) throw new Error(`Not saved: ${r.error}`);
  log(`[names] ${changes.length} change(s) sent to the hub`);
  return { ok: true };
}

// hvor mye hver tag lagrer: siste time, siste døgn, alt som er beholdt. Fra minutt-
// sammendraget når det finnes (raskt på alle databasestørrelser), ellers ved å telle.
function tagStats() {
  if (!isRecorder()) return { tags: [], note: 'This isn’t a recorder database' };
  const now = Date.now(), minNow = Math.floor(now / 60000);
  const names = new Map(db.prepare(`SELECT id, name${hasLabels() ? ', label' : ''} FROM tag`).all().map(r => [r.id, r]));
  const out = new Map();
  const row = id => { if (!out.has(id)) { const t = names.get(id); out.set(id, { name: t ? t.name : `#${id}`, label: (t && t.label) || '', h1: 0, h24: 0, total: 0, last: null }); } return out.get(id); };
  // recorderens minuttsammendrag teller hver lagrede verdi i `rows` (tekst også)
  const hasRollup = objects().some(o => o.type === 'table' && o.name === 'rollup') &&
    db.prepare("SELECT 1 FROM pragma_table_info('rollup') WHERE name = 'rows'").get();
  if (hasRollup) {
    for (const r of db.prepare('SELECT tag, SUM(rows) AS n, MAX(minute) AS last FROM rollup GROUP BY tag').all()) { const s = row(r.tag); s.total = r.n; s.last = (r.last + 1) * 60000; }
    for (const r of db.prepare('SELECT tag, SUM(rows) AS n FROM rollup WHERE minute >= ? GROUP BY tag').all(minNow - 1440)) row(r.tag).h24 = r.n;
    for (const r of db.prepare('SELECT tag, SUM(rows) AS n FROM rollup WHERE minute >= ? GROUP BY tag').all(minNow - 60)) row(r.tag).h1 = r.n;
  } else {
    const since = t => (db.prepare('SELECT MIN(first_sample) AS id FROM batch WHERE last_ts >= ?').get(t) || {}).id;
    const count = (t, key) => { const id = since(t); if (id == null) return; for (const r of db.prepare('SELECT tag, COUNT(*) AS n, MAX(ts) AS last FROM sample WHERE id >= ? AND ts >= ? GROUP BY tag').all(id, t)) { const s = row(r.tag); s[key] = r.n; if (!s.last || r.last > s.last) s.last = r.last; } };
    count(now - 3600000, 'h1'); count(now - 86400000, 'h24');
    for (const r of db.prepare('SELECT tag, COUNT(*) AS n FROM sample GROUP BY tag').all()) row(r.tag).total = r.n;
  }
  const samples = db.prepare('SELECT MAX(rowid) - MIN(rowid) + 1 AS n FROM sample').get().n || 0;
  const bytesPerValue = samples > 20000 ? fileSize(DB_PATH) / samples : 47;   // målt når det er nok
  return { tags: [...out.values()], bytesPerValue, from: hasRollup ? 'the minute summary' : 'the stored values' };
}

// "hva ville denne regelen ha lagret?": siste time med lagrede verdier for hver tag, spilt
// gjennom regelen. Den starter fra det som ble lagret, så den er nøyaktig når regelen i bruk lagrer
// hver endring, og for lav når den regelen allerede utelater verdier.
function estimate({ rule, tags, vars, minutes }) {
  const c = RR.checkRecording({ rules: [rule] });
  if (c.errors.length) throw new Error(c.errors.join('\n'));
  const compiled = RR.compileRules({ rules: c.recording.rules.map(r => Object.assign({}, r, { tags: '*' })) }, vars || {});
  const span = Math.max(5, Math.min(1440, Number(minutes) || 60)) * 60000;
  const to = Date.now(), from = to - span;
  const first = (db.prepare('SELECT MIN(first_sample) AS id FROM batch WHERE last_ts >= ?').get(from) || {}).id;
  const ids = new Map(db.prepare('SELECT id, name FROM tag').all().map(r => [r.name, r.id]));
  const rows = db.prepare('SELECT ts, value, text, q FROM sample WHERE tag = ? AND id >= ? AND ts >= ? ORDER BY id LIMIT 200001');
  const Q = ['good', 'uncertain', 'bad'];
  const result = [];
  for (const name of (tags || []).slice(0, 50)) {
    const id = ids.get(name);
    if (id == null || first == null) { result.push({ name, before: 0, after: 0 }); continue; }
    const list = rows.all(id, first, from);
    let after = 0;
    const engine = RR.createRecorderRules(compiled, { store() { after++; }, event() {} });
    let tick = from;
    for (const s of list.slice(0, 200000)) {
      if (s.q >= RR.PAUSED) continue;   // merket fra en pause: ingen verdi, og ingen regel laget det
      for (; tick <= s.ts; tick += 250) engine.tick(tick, tick);
      engine.value(name, s.text !== null ? s.text : s.value, Q[s.q] || 'good', s.ts, s.ts);
    }
    for (; tick <= to; tick += 250) engine.tick(tick, tick);
    result.push({ name, before: Math.min(list.length, 200000), after, capped: list.length > 200000 });
  }
  return { minutes: span / 60000, tags: result, before: result.reduce((a, r) => a + r.before, 0), after: result.reduce((a, r) => a + r.after, 0) };
}

// ---------------------------------------------------------------- http
const MIME ={ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) { reject(new Error('too much data')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('not valid JSON')); } });
    req.on('error', reject);
  });
}
// SQLites egne ord, med et hint der det hjelper
function friendly(e) {
  const m = e.message || String(e);
  if (/readonly database/i.test(m)) return 'The browser was started read-only, so it can’t change the database. Start it with --write to make changes.';
  if (/database is locked/i.test(m)) return 'The database is busy (the recorder is writing a lot?). Try again in a moment.';
  return m;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, g = k => url.searchParams.get(k);
  try {
    if (p === '/api/info') {
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      return json(res, 200, {
        file: DB_PATH, write: WRITE, bytes: fileSize(DB_PATH), walBytes: fileSize(DB_PATH + '-wal'), pageSize,
        sqlite: db.prepare('SELECT sqlite_version() AS v').get().v, journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
        node: process.version, recorder: isRecorder(),
        pauses: RR.activePauses(RR.readRulesFile(RULES_PATH).recording, Date.now()),
      });
    }
    if (p === '/api/objects') {
      const sz = sizes();
      return json(res, 200, objects().map(o => ({ type: o.type, name: o.name, table: o.tbl,
        ...(o.type === 'table' || o.type === 'view' ? rowCount(o) : {}), bytes: sz ? sz[o.name] || 0 : null })));
    }
    if (p === '/api/table') return json(res, 200, tableInfo(g('name')));
    if (p === '/api/rows') return json(res, 200, tableRows({ name: g('name'), where: g('where'), order: g('order'), dir: g('dir'), offset: g('offset'), limit: g('limit') }));
    if (p === '/api/lookups') return json(res, 200, lookups());
    if (p === '/api/export') return await exportCsv(res, { name: g('name'), where: g('where'), readable: g('readable') === '1' });
    if (p === '/api/sql' && req.method === 'POST') { const b = await readJson(req); return json(res, 200, runSql(b.sql)); }
    if (p === '/api/backup' && req.method === 'POST') return json(res, 200, backup());
    if (p === '/api/recording' && req.method === 'GET') return json(res, 200, await recordingInfo());
    if (p === '/api/recording' && (req.method === 'PUT' || req.method === 'POST')) { const b = await readJson(req); return json(res, 200, saveRecording(b.recording)); }
    if (p === '/api/recording/stats') return json(res, 200, tagStats());
    if (p === '/api/recording/estimate' && req.method === 'POST') { const b = await readJson(req); return json(res, 200, estimate(b)); }
    if (p === '/api/recording/pause' && req.method === 'POST') { const b = await readJson(req); return json(res, 200, changePauses(b)); }
    if (p === '/api/names' && req.method === 'GET') return json(res, 200, await namesInfo());
    if (p === '/api/names' && req.method === 'POST') { const b = await readJson(req); return json(res, 200, await saveNames(b.changes)); }
    if (p === '/api/names/values') return json(res, 200, await hubValues());
    if (p.startsWith('/api/row/') && req.method === 'POST') {
      if (!WRITE) return json(res, 403, { error: friendly(new Error('readonly database')) });
      const b = await readJson(req);
      if (p === '/api/row/update') return json(res, 200, updateRow(b));
      if (p === '/api/row/insert') return json(res, 200, insertRow(b));
      if (p === '/api/row/delete') return json(res, 200, deleteRow(b));
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown request' });
    // siden
    const file = path.normalize(path.join(UI_DIR, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!file.startsWith(UI_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    json(res, e.status || 400, { error: friendly(e), errors: e.errors });
  }
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Pick another: --port 8089` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  log(`Database browser: http://${HOST === '127.0.0.1' ? 'localhost' : '<this-computer>'}:${PORT}`);
  log(`database: ${DB_PATH} (${mb(fileSize(DB_PATH))}), ${WRITE ? 'CHANGES ALLOWED (--write)' : 'read-only'}`);
  log(`recording rules: ${RULES_PATH}; hub: ${HUB}`);
  if (WRITE) log('Careful: changing the recorder’s own tables can break it. Stop the recorder and back up first.');
  if (HOST !== '127.0.0.1') log(`Anyone on the network can open it${WRITE ? ' and change the database' : ''}. --local limits it to this computer.`);
});
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
