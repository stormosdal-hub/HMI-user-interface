'use strict';
/*
 * hub-adapter.js - kobler et Node.js-program til HMI-huben som en adapter.
 *
 * Node 22 eller nyere har en innebygd WebSocket-klient, så da trengs ingen pakker: kopier filen
 * ved siden av programmet ditt. På eldre Node brukes pakken ws (npm install ws) i stedet.
 *
 *   const { HubAdapter } = require('./hub-adapter');
 *
 *   const hub = new HubAdapter({ url: 'ws://192.168.1.10:8080', name: 'node_1' });   // navnet er tagprefikset
 *   hub.addTag('temp', { dataType: 'number', unit: '°C' });                           // -> taggen node_1.temp
 *   hub.addTag('pump', { dataType: 'boolean', writable: true, onWrite: v => setPump(v) });
 *   hub.start();                                                                       // kobler til, og holder forbindelsen oppe
 *
 *   hub.set('temp', 21.5);             // fra programmet ditt, så ofte du vil
 *   hub.event('Pump started');         // en linje i HMI-ens hendelseslogg
 *
 * Adapteren gjør resten selv:
 *   - kobler til huben, sier hello og registrerer taggene (med verdiene de har nå);
 *   - sender en verdi bare når den er endret;
 *   - kaller onWrite når HMI-en skriver til en skrivbar tag (den kan også være async), og sender
 *     verdien som faktisk ble satt tilbake (ekkoet), så alle HMI-er viser den;
 *   - oppdager en død forbindelse og kobler til igjen av seg selv.
 */

// den innebygde klienten (Node 22+), ellers pakken ws: begge har samme onopen/onmessage/send
const WS = typeof WebSocket === 'function' ? WebSocket : require('ws');
const DATA_TYPES = ['number', 'boolean', 'string'];

class HubAdapter {
  /**
   * @param {object} o
   * @param {string} o.url     huben, f.eks. ws://192.168.1.10:8080
   * @param {string} o.name    adapterens navn og tagprefiks, unikt på huben (bokstaver, sifre og _)
   * @param {number} [o.reconnectMs]  første ventetid før et nytt forsøk (dobles, høyst 30 s)
   * @param {function|null} [o.log]   en funksjon for meldinger, eller null
   */
  constructor({ url = 'ws://localhost:8080', name = 'node_1', reconnectMs = 2000, log = console.log } = {}) {
    this.url = url;
    this.name = name;
    this.reconnectMs = reconnectMs;
    this.log = log || (() => {});
    this.tags = new Map();   // nøkkel -> { def, onWrite, value, quality }
    this.ws = null;
    this.running = false;
    this.timers = { retry: null, alive: null };
    this.wait = reconnectMs;
    this.lastMsg = 0;
  }

  get connected() { return !!this.ws && this.ws.readyState === 1; }

  // ------------------------------------------------------------ for programmet ditt
  /**
   * Legg til taggen <name>.<key>. Kall før start(), eller senere (den registreres da med en gang).
   * dataType: 'number', 'boolean' eller 'string'.
   * onWrite(value): kalles når HMI-en skriver taggen. Returner (eller resolve) verdien som faktisk
   *   ble satt, eller undefined for "som bedt om"; kast en feil for å avvise skrivingen.
   * alarm: f.eks. { severity: 'alarm', text: 'CPU above 90 %' }: huben viser alarmen så lenge
   *   verdien er true (eller ulik 0); se README.md for when, delay og codes.
   */
  addTag(key, { dataType = 'number', unit = '', writable = false, description = '', onWrite = null, alarm = null, value } = {}) {
    if (!DATA_TYPES.includes(dataType)) throw new Error(`dataType must be one of ${DATA_TYPES.join(', ')}`);
    const def = { name: this.full(key), dataType, unit, writable: !!writable };
    if (description) def.description = description;
    if (alarm) def.alarm = alarm;
    this.tags.set(key, { def, onWrite, value, quality: 'good' });
    if (this.connected) this.register([key]);
    return this;
  }

  /** Ny verdi for en tag. Sendes bare hvis den (eller kvaliteten) er endret. quality: 'good',
   *  eller 'bad' når programmet vet at verdien ikke stemmer (HMI-en viser den da som foreldet). */
  set(key, value, quality = 'good') { this.setMany({ [key]: value }, quality); }

  /** Flere verdier samtidig, i én melding: { temp: 21.5, pump: true }. */
  setMany(values, quality = 'good') {
    const out = {};
    for (const [key, value] of Object.entries(values)) {
      const t = this.tags.get(key);
      if (!t) throw new Error(`unknown tag "${key}": addTag() it first`);
      if (t.value !== value || t.quality !== quality) {
        t.value = value;
        t.quality = quality;
        out[this.full(key)] = value;
      }
    }
    if (Object.keys(out).length) this.send(Object.assign({ type: 'update', values: out }, quality !== 'good' ? { quality } : {}));
  }

  /** Verdien en tag har nå (det programmet sist satte, eller det HMI-en sist skrev). */
  get(key) { const t = this.tags.get(key); return t ? t.value : undefined; }

  /** En linje i HMI-ens hendelseslogg. severity: 'info', 'warning' eller 'alarm'.
   *  En advarsel eller alarm blir stående i alarmlisten til noen kvitterer for den. */
  event(message, severity = 'info') { this.send({ type: 'event', severity, message: String(message) }); }

  /** Kobler til huben, og holder forbindelsen oppe til stop(). */
  start() {
    if (this.running) return this;
    this.running = true;
    this.connect();
    // huben svarer på { type: 'ping' }; er det helt stille i 45 s, er forbindelsen død
    this.timers.alive = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastMsg > 45000) { this.log('no answer from the hub for 45 s'); this.drop(); return; }
      this.send({ type: 'ping' });
    }, 15000);
    return this;
  }

  stop() {
    this.running = false;
    clearInterval(this.timers.alive);
    clearTimeout(this.timers.retry);
    this.drop();
  }

  // ------------------------------------------------------------ protokollen
  full(key) { return `${this.name}.${key}`; }

  send(msg) {
    if (this.connected) this.ws.send(JSON.stringify(msg));
  }

  register(keys) {
    const tags = [];
    for (const [key, t] of this.tags) {
      if (keys && !keys.includes(key)) continue;
      tags.push(t.value === undefined ? t.def : Object.assign({}, t.def, { value: t.value }));   // så HMI-en har verdien med en gang
    }
    if (tags.length) this.send({ type: 'register', tags });
  }

  onMessage(msg) {
    if (msg.type === 'write') this.onWrite(String(msg.tag || ''), msg.value, msg.from);
    else if (msg.type === 'welcome') this.log(`hub: connected as ${msg.name}`);
    else if (msg.type === 'error') this.log(`hub says: ${msg.message}`);
  }

  async onWrite(tag, value, who) {
    const key = tag.startsWith(this.name + '.') ? tag.slice(this.name.length + 1) : null;
    const t = key !== null ? this.tags.get(key) : null;
    if (!t || !t.def.writable) { this.event(`Write to ${tag} refused: not a writable tag`); return; }
    let applied = value;
    if (t.onWrite) {
      try {
        const r = await t.onWrite(value);
        if (r !== undefined) applied = r;
      } catch (e) {   // avvist: ekkoet er den gamle verdien, så kontrollen hopper tilbake
        this.log(`write ${tag} = ${JSON.stringify(value)} refused: ${e.message}`);
        this.event(`Write to ${tag} refused: ${e.message}`);
        applied = t.value;
      }
    }
    t.value = applied;
    this.send({ type: 'update', tag, value: applied });   // ekkoet
    this.log(`write from ${who || 'HMI'}: ${key} = ${JSON.stringify(applied)}`);
  }

  // ------------------------------------------------------------ forbindelsen
  connect() {
    if (!this.running) return;
    let ws;
    try { ws = new WS(this.url); } catch (e) { this.log(`hub ${this.url}: ${e.message}`); return this.retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.wait = this.reconnectMs;
      this.lastMsg = Date.now();
      this.send({ type: 'hello', role: 'adapter', name: this.name });
      this.register();
      this.log(`connected to ${this.url} as ${this.name}`);
    };
    ws.onmessage = e => {
      this.lastMsg = Date.now();
      let msg;
      try { msg = JSON.parse(String(e.data)); } catch (err) { return; }
      if (msg && typeof msg === 'object') this.onMessage(msg);
    };
    ws.onerror = () => {};   // close kommer etterpå, og forteller det som trengs
    ws.onclose = () => {
      if (this.ws !== ws) return;    // en gammel forbindelse som allerede er erstattet
      this.ws = null;
      if (this.running) { this.log('disconnected from the hub'); this.retry(); }
    };
  }

  // slipp en forbindelse med en gang, også en som har hengt seg opp, og prøv på nytt
  drop() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.onerror = () => {};
      try { if (typeof ws.terminate === 'function') ws.terminate(); else ws.close(); } catch (e) { /* allerede lukket */ }
    }
    if (this.running) this.retry();
  }

  retry() {
    clearTimeout(this.timers.retry);
    this.log(`trying the hub again in ${Math.round(this.wait / 1000)} s`);
    this.timers.retry = setTimeout(() => this.connect(), this.wait);
    this.wait = Math.min(this.wait * 2, 30000);
  }
}

module.exports = { HubAdapter };
