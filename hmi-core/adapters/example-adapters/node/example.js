'use strict';
/*
 * example.js - et eksempelprogram flettet sammen med en adapter til HMI-huben.
 *
 * Programmet viser to ting:
 *   - ekte verdier fra datamaskinen det kjører på (CPU-last, minne, oppetid), lest med Node selv;
 *   - et lite program som HMI-en styrer: en teller som går med en hastighet du setter, kan
 *     startes, stoppes og nullstilles fra HMI-en.
 * Bytt ut det med ditt eget program: les verdiene du vil vise med hub.set(), og gjør det
 * HMI-en ber om i onWrite-funksjonene.
 *
 *   node example.js                                  # huben på denne maskinen
 *   node example.js ws://192.168.1.10:8080 node_1    # huben på Pi-en, adapternavn node_1
 *
 * Taggene (med navnet node_1):
 *   node_1.cpu_load   CPU-last, %                (leses)
 *   node_1.mem_used   minne i bruk, %            (leses)
 *   node_1.uptime     maskinens oppetid, h       (leses)
 *   node_1.host       maskinens navn             (leses: Value-widget)
 *   node_1.count      telleren                   (leses)
 *   node_1.rate       tellinger per sekund       (skrivbar: Number input eller Slider)
 *   node_1.running    telleren går               (skrivbar: Switch)
 *   node_1.reset      nullstill telleren         (skrivbar: Button, verdi true)
 *   node_1.cpu_high   CPU over 90 % i 5 s        (alarm i HMI-ens alarmliste)
 */
const os = require('os');
const { HubAdapter } = require('./hub-adapter');

const url = process.argv[2] || process.env.HUB_URL || 'ws://localhost:8080';
const name = process.argv[3] || 'node_1';

// ---------------------------------------------------------------- programmet ditt
const counter = { count: 0, rate: 1, running: true };

// CPU-last siden forrige gang: andelen av tiden som ikke var idle, over alle kjerner
let lastCpu = os.cpus();
function cpuLoad() {
  const now = os.cpus();
  let busy = 0, total = 0;
  now.forEach((c, i) => {
    const a = c.times, b = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 };
    const t = (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + (a.idle - b.idle);
    busy += t - (a.idle - b.idle);
    total += t;
  });
  lastCpu = now;
  return total ? Math.round(busy / total * 1000) / 10 : 0;
}

// ---------------------------------------------------------------- adapteren
const hub = new HubAdapter({ url, name });
hub.addTag('cpu_load', { unit: '%', description: 'CPU load of this computer' })
  .addTag('mem_used', { unit: '%' })
  .addTag('uptime', { unit: 'h' })
  .addTag('host', { dataType: 'string', value: os.hostname() })
  .addTag('count', { value: 0 })
  .addTag('rate', {
    unit: '/s', writable: true, value: counter.rate,
    // kalles når HMI-en skriver node_1.rate: begrens, og returner det som faktisk ble satt (ekkoet)
    onWrite: v => {
      const r = Number(v);
      if (!Number.isFinite(r)) throw new Error('not a number');
      counter.rate = Math.max(0, Math.min(100, r));
      return counter.rate;
    },
  })
  .addTag('running', {
    dataType: 'boolean', writable: true, value: counter.running,
    onWrite: v => {
      counter.running = !!v;
      hub.event(`Counter ${counter.running ? 'started' : 'stopped'} from the HMI`);
      return counter.running;
    },
  })
  .addTag('reset', {
    // en knapp: true nullstiller telleren; taggen går straks tilbake til false
    dataType: 'boolean', writable: true, value: false,
    onWrite: v => { if (v) { counter.count = 0; hub.event('Counter reset'); } return false; },
  })
  .addTag('cpu_high', { dataType: 'boolean', value: false, alarm: { severity: 'warning', text: 'CPU load above 90 %', delay: 5000 } });
hub.start();

// ---------------------------------------------------------------- hovedløkken
setInterval(() => {
  if (counter.running) counter.count += counter.rate;
  const cpu = cpuLoad();
  hub.setMany({
    cpu_load: cpu,
    cpu_high: cpu > 90,
    mem_used: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
    uptime: Math.round(os.uptime() / 360) / 10,
    count: Math.round(counter.count),
  });
}, 1000);

process.on('SIGINT', () => { hub.stop(); process.exit(0); });
