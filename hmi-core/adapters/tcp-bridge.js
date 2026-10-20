#!/usr/bin/env node
'use strict';
/*
 * tcp-bridge.js — lar rå-TCP-enheter snakke med huben.
 *
 * Huben snakker WebSocket. Denne broen tar imot vanlige TCP-forbindelser og sender
 * meldingene uendret videre, så en enhet som bare kan åpne en TCP-socket, bruker likevel
 * nøyaktig den samme JSON-protokollen som alt annet.
 *
 * Den er en transportoversetter, ikke noe mer: den ser aldri på tagnavn eller verdier,
 * så du trenger aldri å røre den når taggene i et prosjekt endres. Hver TCP-forbindelse
 * får sin egen WebSocket-forbindelse til huben, så huben ser hver enhet
 * for seg (med eget navn, egne tagger, egen tilkoblet/frakoblet-tilstand).
 *
 * Ramming: ett kompakt JSON-objekt per linje, avsluttet med \n (NDJSON).
 * TCP er en bytestrøm — uten skilletegn kan to meldinger komme klistret sammen,
 * og én melding kan komme delt i to. Linjeskiftet er det som gjør dem mulige å skille.
 *
 * Bruk: node adapters/tcp-bridge.js [ws://localhost:8080] [9000]
 *       pek så enheten mot  <ip-til-denne-datamaskinen>:9000
 */
const net = require('net');
const WebSocket = require('ws');

const HUB  = process.argv[2] || process.env.HUB_URL || 'ws://localhost:8080';
const PORT = Number(process.argv[3] || process.env.TCP_PORT || 9000);
const MAX_LINE = 64 * 1024;   // en enhet som sender endeløst med byte uten linjeskift, blir koblet fra

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let seq = 0;

const server = net.createServer(sock => {
  const id = ++seq;
  const who = `${sock.remoteAddress}:${sock.remotePort}`;
  log(`[${id}] device connected from ${who}`);

  sock.setNoDelay(true);              // send små JSON-linjer med en gang
  sock.setKeepAlive(true, 20000);     // merk en enhet som har mistet strømmen

  const ws = new WebSocket(HUB);
  const pending = [];                 // meldinger fra enheten som kommer før forbindelsen til huben er oppe
  let hubOpen = false;
  let buf = '';

  // ---- hub -> enhet
  ws.on('open', () => {
    hubOpen = true;
    log(`[${id}] hub link open`);
    for (const line of pending) ws.send(line);
    pending.length = 0;
  });
  ws.on('message', raw => {
    // meldinger fra huben er kompakt JSON uten linjeskift inni, så én linje per melding
    if (!sock.destroyed) sock.write(raw.toString('utf8') + '\n');
  });
  ws.on('close', () => { log(`[${id}] hub link closed`); sock.end(); });
  ws.on('error', e => { log(`[${id}] hub error: ${e.message}`); sock.destroy(); });

  // ---- enhet -> hub
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (hubOpen) ws.send(line);
      else if (pending.length < 100) pending.push(line);
    }
    if (buf.length > MAX_LINE) {
      log(`[${id}] no newline in ${MAX_LINE} bytes — dropping device`);
      sock.destroy();
    }
  });

  sock.on('close', () => { log(`[${id}] device disconnected`); ws.close(); });
  sock.on('error', e => { log(`[${id}] device error: ${e.message}`); ws.close(); });
});

server.listen(PORT, () => {
  log(`TCP bridge listening on port ${PORT}, forwarding to ${HUB}`);
  log('devices should send one JSON object per line, ending each with \\n');
});
