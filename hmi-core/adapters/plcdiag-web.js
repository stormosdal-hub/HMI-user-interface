#!/usr/bin/env node
'use strict';
/*
 * plcdiag-web.js - leser diagnosebufferen fra web-serveren i en S7-1200, for plcdiag-adapter.js.
 *
 * Dette er den eneste fila som avhenger av PLS-ens firmware. Web API-et (JSON) kom i firmware 4.5,
 * og et prosjekt i TIA V16 kan ha høyst 4.4. Web-serveren har likevel en side for
 * diagnosebufferen, laget for nettleseren. Fila ber om de samme sidene som en nettleser, og
 * plukker radene ut av HTML-en:
 *
 *   /ClientArea/DiagTable.mwsl?ThrNav=0     oppføring 1-25, nyeste først
 *   /ClientArea/DiagTable.mwsl?ThrNav=1     oppføring 26-50
 *   /ClientArea/DiagLong.mwsl?EventData=…   den lange teksten til én oppføring
 *
 * Hver rad har en fast nøkkel, data-event-data, på 24 heksadesimale tegn: 3 byte hendelses-ID,
 * 8 byte tid (UTC, nanosekunder siden 1970) og 1 byte status (01 kommer, 00 går). En oppføring
 * får aldri en annen nøkkel, så den lange teksten hentes bare én gang.
 *
 * NY FIRMWARE. Sidene er laget for mennesker, ikke for programmer. Endrer en ny firmware eller
 * TIA-versjon dem, er det parseTable, parseLong og kanskje decodeKey her som må tilpasses; resten
 * av HMI-en bryr seg ikke om hvordan sidene ser ut. Prøv mot PLS-en med:
 *
 *   node adapters/plcdiag-web.js 10.0.123.51           hele bufferen, med de lange tekstene
 *   node adapters/plcdiag-web.js 10.0.123.51 --raw     HTML-en PLS-en sender, for å se hva som er endret
 *   node adapters/plcdiag-web.js http://10.0.123.51    uten kryptering, hvis web-serveren tillater det
 *
 * Krav i TIA: web-serveren slått på, og brukeren "Everybody" med rettigheten "query diagnostics".
 * Teksten er på engelsk, slik PLS-en har den. Bare GET-forespørsler: ingenting endres i PLS-en.
 *
 * Bygd på tcplink_diagbuf.js i PLS-prosjektet (TCP-link-block). Endrer du parsingen her, endre den
 * der også, så testskriptet og HMI-en leser sidene likt. Bare det som er innebygd i Node; kjører
 * på Node 10 og nyere.
 */

const http = require('http');
const https = require('https');

const PAGES = 2;          // 2 sider à 25 oppføringer: hele bufferen i en S7-1200
const TIMEOUT = 8000;     // ms per forespørsel

// ------------------------------------------------------------ HTML til tekst
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] || m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

// Et stykke HTML som ren tekst: <br> blir linjeskift, andre tagger forsvinner. Taggene fjernes
// før entitetene, så en &lt; i teksten aldri blir en tagg.
function htmlText(s) {
  return decodeEntities(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

// alle treff av et globalt regulært uttrykk (String.matchAll finnes ikke i Node 10)
function allMatches(rx, s) {
  const out = [];
  let m;
  rx.lastIndex = 0;
  while ((m = rx.exec(s)) !== null) out.push(m);
  return out;
}

// Nøkkelen fra data-event-data: 3 byte hendelses-ID, 8 byte tid (UTC, nanosekunder siden 1970),
// 1 byte status (01 kommer, 00 går). order sorterer etter tid, også innenfor samme millisekund.
function decodeKey(key) {
  const hi = parseInt(key.slice(6, 14), 16), lo = parseInt(key.slice(14, 22), 16);
  return {
    eventId: key.slice(0, 2) + ':' + key.slice(2, 6),
    ms: Math.floor(hi * (4294967296 / 1e6) + lo / 1e6),
    order: key.slice(6, 22),
    incoming: key.slice(22, 24) === '01',
  };
}

// Radene i DiagTable.mwsl: <tr ... data-event-data="…"> med fem celler: nummer, tid, dato,
// status, hendelse. Tid, dato og status leses fra nøkkelen, så de ikke avhenger av språket og
// tidsformatet på siden.
function parseTable(html) {
  const out = [];
  for (const m of allMatches(/<tr\b([^>]*\bdata-event-data="[^"]*"[^>]*)>([\s\S]*?)<\/tr>/gi, html)) {
    const attr = name => (new RegExp('\\b' + name + '="([^"]*)"', 'i').exec(m[1]) || [])[1] || '';
    const key = attr('data-event-data').toUpperCase();
    const cells = allMatches(/<td\b[^>]*>([\s\S]*?)<\/td>/gi, m[2]).map(c => htmlText(c[1]).replace(/\s+/g, ' ').trim());
    if (!/^[0-9A-F]{24}$/.test(key) || cells.length < 5) continue;
    out.push(Object.assign({ key, no: Number(attr('data-event-number')) || Number(cells[0]) || 0, text: cells[4] }, decodeKey(key)));
  }
  return out;
}

// Den lange teksten i DiagLong.mwsl, linje for linje slik PLS-en viser den, med "Incoming event" /
// "Outgoing event" til slutt. null: siden har ingen lang tekst der den pleier å stå.
function parseLong(html) {
  const m = /<td\b[^>]*class="ContentLongText"[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  if (!m) return null;
  return htmlText(m[1]).split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
}

// Hva slags oppføring, fra første ord i den lange teksten: "Error: IO device failure" er en feil,
// "CPU info: Power on" en opplysning.
function kindOf(long) {
  if (/^\s*error\b/i.test(long || '')) return 'error';
  if (/^\s*warning\b/i.test(long || '')) return 'warning';
  return long ? 'info' : '';
}

// ------------------------------------------------------------------ henting
// Feilen som tekst, med det som oftest er grunnen.
function explain(err) {
  if (err.code === 'ECONNREFUSED') return 'ECONNREFUSED (is the web server on in the PLC?)';
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return err.code + ' (no route to the PLC)';
  return err.code || err.message;
}

// Adressen til web-serveren: "10.0.123.51" blir https://10.0.123.51. Kaster en feil for noe som
// ikke er en adresse.
function baseUrl(s) {
  const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http:// and https://');
  return u;
}

// Leseren for én PLS. url: web-serveren (se baseUrl).
//   list()        Promise: oppføringene i PLS-en nå, nyeste først: [{ key, no, text, eventId, ms, order, incoming }]
//   details(key)  Promise: { long, kind } for én oppføring; long er '' når siden ikke har noen
//   finish()      lukker ledige forbindelser; kalles etter hver henting
function createReader(opts) {
  const base = baseUrl(opts.url);
  const lib = base.protocol === 'http:' ? http : https;
  const timeout = opts.timeout || TIMEOUT;
  // Én agent så lenge leseren lever. En ny TLS-forbindelse tar 3-4 s i en S7-1200; agenten husker
  // TLS-økten, så de neste tar et par tidels sekund. Innenfor en henting brukes samme forbindelse.
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 1 });

  function get(path) {
    return new Promise((resolve, reject) => {
      const req = lib.get({
        protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, path, agent, timeout,
        // PLS-en lager sertifikatet sitt selv, så det kan ikke sjekkes mot en kjent utsteder. Det
        // som hentes, er bare tekst til visning, og ingen passord sendes.
        rejectUnauthorized: false,
        headers: { Cookie: 'siemens_automation_language=en' },
      }, res => {
        if (res.statusCode !== 200) {
          res.resume();
          const denied = res.statusCode === 403 || (res.statusCode >= 300 && res.statusCode < 400);
          reject(new Error('HTTP ' + res.statusCode + (denied ? ' (does "Everybody" have "query diagnostics"?)' : '')));
          return;
        }
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('no answer in ' + timeout / 1000 + ' s')));
      req.on('error', reject);
    });
  }

  async function list() {
    const rows = [];
    for (let p = 0; p < PAGES; p++) {
      for (const r of parseTable(await get('/ClientArea/DiagTable.mwsl?ThrNav=' + p))) {
        if (!rows.some(x => x.key === r.key)) rows.push(r);
      }
    }
    if (!rows.length) throw new Error('no entries on the page (does "Everybody" have "query diagnostics"?)');
    return rows;
  }

  async function details(key) {
    const long = parseLong(await get('/ClientArea/DiagLong.mwsl?EventData=' + key)) || '';
    return { long, kind: kindOf(long) };
  }

  // Web-serveren har få forbindelser; økten huskes uansett.
  function finish() {
    for (const k of Object.keys(agent.freeSockets)) for (const s of agent.freeSockets[k]) s.destroy();
  }

  return { url: base.origin, list, details, finish, get };
}

// ------------------------------------------------------------ kommandolinje
async function main() {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith('--'));
  if (!target) {
    console.log('usage: node adapters/plcdiag-web.js <PLC address or URL> [--raw]');
    process.exitCode = 2;
    return;
  }
  const reader = createReader({ url: target });
  try {
    if (args.includes('--raw')) {
      const page = await reader.get('/ClientArea/DiagTable.mwsl?ThrNav=0');
      console.log('==== ' + reader.url + '/ClientArea/DiagTable.mwsl?ThrNav=0\n' + page);
      const first = parseTable(page)[0];
      if (first) console.log('\n==== ' + reader.url + '/ClientArea/DiagLong.mwsl?EventData=' + first.key + '\n' + await reader.get('/ClientArea/DiagLong.mwsl?EventData=' + first.key));
      else console.log('\n(no rows found in the page above: parseTable needs to be adapted)');
      return;
    }
    const rows = await reader.list();
    console.log('the diagnostic buffer at ' + reader.url + ': ' + rows.length + ' entries, newest first, time in UTC\n');
    for (const r of rows) {
      const d = await reader.details(r.key);
      const when = new Date(r.ms).toISOString().replace('T', ' ').replace('Z', '');
      console.log(String(r.no).padStart(3) + '  ' + when + '  ' + (r.incoming ? 'incoming' : 'outgoing') + '  ' + r.eventId + '  ' +
                  (d.kind || '-').padEnd(7) + '  ' + r.text);
      if (d.long) console.log(d.long.split('\n').map(l => '       | ' + l).join('\n') + '\n');
    }
  } catch (err) {
    console.log('error: ' + explain(err));
    process.exitCode = 1;
  } finally {
    reader.finish();
  }
}

if (require.main === module) {
  process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });   // | head
  main();
}

module.exports = { createReader, baseUrl, parseTable, parseLong, decodeKey, kindOf, htmlText, explain };
