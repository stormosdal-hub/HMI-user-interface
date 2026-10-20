'use strict';
/*
 * lib/record-rules.js - bestemmer hvilke tagverdier recorderen lagrer, og tar vare på regelfilen.
 * Et bibliotek for recorder.js og db-browser.js, ikke et program: det kjøres ikke alene.
 *
 * Reglene ligger i en fil ved siden av databasen (recorder.db -> recorder.rules.json), skrevet av
 * databaseleseren og lest av recorderen, som fanger opp endringer av seg selv:
 *
 *   {
 *     "flushSeconds": 30, "keepDays": 7, "maxMB": 1000, "events": true,
 *     "rules": [
 *       { "tags": "${kv}.spare*", "mode": "ignore" },
 *       { "tags": "${kv}.speedAct, ${kv}.torqueAct", "deadband": "1%", "minInterval": 1, "maxInterval": 60 },
 *       { "tags": "${kv}.statusWord", "ignoreBits": "8, 10" },
 *       { "tags": "${kv}.ints_1", "mode": "interval", "every": 60 },
 *       { "tags": "${kv}.bit0*", "flickerChanges": 6, "flickerSeconds": 2 }
 *     ]
 *   }
 *
 * En tag lagres bare hvis en regel treffer den; første regel som treffer, gjelder. Hva en regel lagrer:
 *   mode "change" (standard): hver endring
 *     - deadband: et tall lagres når det har flyttet seg minst så mye siden sist lagrede
 *       verdi; "2%" er to prosent av den verdien
 *     - bits / ignoreBits: for ord teller bare endringer i disse bitene ("0-7, 11"), eller alle
 *       unntatt disse; et statusord med en bit som flimrer, lagres da bare når de andre endres
 *     - minInterval: høyst én lagret verdi per så mange sekunder; siste verdi lagres når
 *       intervallet er over, så sluttverdien går aldri tapt
 *     - maxInterval: verdien lagres på nytt etter så mange sekunder selv om ingenting er endret
 *     - flickerChanges / flickerSeconds: flere enn N endringer innen T sekunder stopper lagring av
 *       hver endring; recorderen melder episoden som en hendelse og lagrer verdien når den roer seg
 *   mode "interval": siste verdi hvert `every` sekund, endret eller ikke
 *   mode "ignore": ingenting. Legg den over en bredere regel for å utelate noen av taggene dens.
 * Uansett regel lagres en tags første verdi og hver endring i kvalitet (good / uncertain / stale),
 * unntatt med "ignore".
 *
 * Pauser stopper lagringen en stund, f.eks. under vedlikehold, så testverdier ikke blandes med
 * ekte verdier. Settes i databaseleseren; tidene følger Pi-ens egen klokke:
 *   "pauses": [ { "id": "k3f9a", "tags": "*", "since": "2026-09-28 14:02:10",
 *                 "until": "2026-09-28 15:02:10", "reason": "maintenance" } ]
 *   tags: hvilke tagger ("*" alle sammen, "kv_1.*" én enhet); until: null = til den gjenopptas.
 * Der en pause begynner, får hver pausede tag et merke (q 3, ingen verdi), så en trend viser et hull;
 * når den slutter, lagres hver tags verdi i det øyeblikket. Hendelser fra pausede tagger og enheter
 * utelates også.
 *
 * Tider som gis til motoren, er millisekunder på en monoton klokke (de hopper aldri).
 */
const fs = require('fs');
const path = require('path');

// "${kv}.bit0*, calc.*" -> [RegExp]; * passer med hva som helst, også punktum
function compilePatterns(text, vars) {
  return String(text || '')
    .replace(/\$\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m))
    .split(/[\s,]+/).filter(Boolean)
    .map(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
}

function num(v, d) { const n = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(n) ? d : n; }

// "160" -> { abs: 160 }, "2%" -> { pct: 2 }; ingenting eller 0 -> hver endring
function parseDeadband(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().replace(',', '.');
  if (!s) return { abs: 0, pct: 0 };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(%?)$/);
  if (!m) return null;
  return m[2] ? { abs: 0, pct: Number(m[1]) } : { abs: Number(m[1]), pct: 0 };
}
// "0-7, 11" -> bitene som en maske (opptil 32 bit); null når den ikke kan leses
function parseBits(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return 0;
  let mask = 0;
  for (const part of s.split(/[\s,;]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (a > 31 || b > 31 || b < a) return null;
    for (let i = a; i <= b; i++) mask |= 1 << i;
  }
  return mask >>> 0;
}
const MODES = ['change', 'interval', 'ignore'];

// reglene, klare til bruk
function compileRules(record, vars) {
  const rules = Array.isArray(record && record.rules) ? record.rules : [];
  return rules.map((r, i) => {
    const db = parseDeadband(r.deadband) || { abs: 0, pct: 0 };
    const only = parseBits(r.bits), except = parseBits(r.ignoreBits);
    // bitene der endringer teller: bare disse, eller alle unntatt disse, eller (null) hele verdien
    const mask = only ? only : except ? (~except >>> 0) : null;
    return {
      index: i,
      text: String(r.tags || ''),
      patterns: compilePatterns(r.tags, vars),
      mode: MODES.includes(r.mode) ? r.mode : 'change',
      every: Math.max(1, num(r.every, 60)) * 1000,
      deadband: db.abs,
      deadbandPct: db.pct,
      mask,
      minInterval: Math.max(0, num(r.minInterval, 0)) * 1000,
      maxInterval: Math.max(0, num(r.maxInterval, 0)) * 1000,
      flickerChanges: Math.max(0, Math.floor(num(r.flickerChanges, 0))),
      flickerWindow: Math.max(0, num(r.flickerSeconds, 0)) * 1000,
    };
  });
}

function ruleFor(rules, tag) {
  for (const r of rules) for (const p of r.patterns) if (p.test(tag)) return r;
  return null;
}
// regnes verdien som endret etter denne regelen? a: den nye verdien, b: den det sammenlignes med
function differs(a, b, r) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (r.mask !== null && Number.isInteger(a) && Number.isInteger(b)) return ((a ^ b) & r.mask) !== 0;
    if (r.deadbandPct > 0) return a !== b && Math.abs(a - b) >= Math.abs(b) * r.deadbandPct / 100;
    return r.deadband > 0 ? Math.abs(a - b) >= r.deadband : a !== b;
  }
  return a !== b;
}

const QUALITY = { good: 0, uncertain: 1, bad: 2 };
const PAUSED = 3;   // q for merket som lagres der en pause begynner: ingen verdi herfra

/*
 * createRecorderRules(rules, sink)
 *   sink.store(tag, value, q, ts, mono)   en verdi som skal tas vare på
 *   sink.event(severity, message)          en flimreepisode begynte eller sluttet
 * returnerer { value(tag, value, quality, ts, mono), tick(ts, mono), setRules(rules),
 *              setPaused(isPaused(tag) eller null, ts, mono), states }
 */
function createRecorderRules(rules, sink) {
  const states = new Map();   // tag -> tilstand
  let pausedTag = null;       // tag -> true mens en pause dekker den

  function stateFor(tag) {
    let st = states.get(tag);
    if (st && st.rule) return st;
    if (st) return null;   // allerede kjent at den ikke skal lagres
    const rule = ruleFor(rules, tag);
    if (!rule || rule.mode === 'ignore') { states.set(tag, { rule: null }); return null; }
    // raw: siste betydelige verdi (for å telle endringer); cur: den faktiske siste verdien
    st = { rule, stored: null, raw: undefined, rawQ: 0, cur: null, pending: null, changes: [], flickering: false, flickCount: 0, flickStart: 0,
      paused: !!(pausedTag && pausedTag(tag)) };
    states.set(tag, st);
    return st;
  }

  function keep(tag, st, v, q, ts, m) {
    st.stored = { v, q, m };
    st.pending = null;
    sink.store(tag, v, q, ts, m);
  }

  function value(tag, v, quality, ts, m) {
    const st = stateFor(tag);
    if (!st) return;
    const r = st.rule;
    const q = QUALITY[quality] !== undefined ? QUALITY[quality] : 0;
    if (st.paused) { st.cur = { v, q, ts }; return; }   // fulgt, ikke lagret: lagres når pausen slutter
    const changed = st.raw === undefined || differs(v, st.raw, r);
    if (changed || q !== st.rawQ) st.raw = v;
    st.rawQ = q;
    st.cur = { v, q, ts };
    // første verdi og hver endring i kvalitet lagres alltid
    if (!st.stored || q !== st.stored.q) {
      if (st.flickering) endFlicker(tag, st, ts, m, 'quality changed');
      keep(tag, st, v, q, ts, m);
      return;
    }
    if (r.mode === 'interval') return;   // lagres av tick(), etter klokken
    if (!changed) return;
    // flimring: tell betydelige endringer i vinduet
    if (r.flickerChanges > 0 && r.flickerWindow > 0) {
      st.changes.push(m);
      while (st.changes.length && st.changes[0] <= m - r.flickerWindow) st.changes.shift();
      if (st.flickering) { st.flickCount++; return; }
      if (st.changes.length > r.flickerChanges) {
        st.flickering = true;
        st.flickStart = st.changes[0];
        st.flickCount = st.changes.length;
        st.pending = null;
        sink.event('warning', `${tag} is flickering: more than ${r.flickerChanges} changes in ${r.flickerWindow / 1000} s. Its changes aren't stored until it settles.`);
        return;
      }
    }
    if (!differs(v, st.stored.v, r)) { st.pending = null; return; }   // tilbake innenfor dødbåndet
    if (r.minInterval > 0 && m - st.stored.m < r.minInterval) { st.pending = { v, q, ts, m }; return; }
    keep(tag, st, v, q, ts, m);
  }

  function endFlicker(tag, st, ts, m, why) {
    const secs = ((m - st.flickStart) / 1000).toFixed(1);
    sink.event('info', `${tag} settled${why ? ' (' + why + ')' : ''} after ${st.flickCount} changes in ${secs} s`);
    st.flickering = false;
    st.changes = [];
  }

  // kalles noen ganger i sekundet: ventende verdier, flimring som har roet seg, og gjentak etter maxInterval
  function tick(ts, m) {
    for (const [tag, st] of states) {
      if (!st.rule || !st.stored || st.paused) continue;
      const r = st.rule;
      if (r.mode === 'interval') {
        if (st.cur && m - st.stored.m >= r.every) keep(tag, st, st.cur.v, st.cur.q, ts, m);
        continue;
      }
      if (st.flickering) {
        const last = st.changes.length ? st.changes[st.changes.length - 1] : st.flickStart;
        if (m - last >= r.flickerWindow) {
          endFlicker(tag, st, ts, m, '');
          keep(tag, st, st.cur.v, st.cur.q, st.cur.ts, m);     // verdien den roet seg på, fra da den sist endret seg
        }
        continue;
      }
      if (st.pending && m - st.stored.m >= r.minInterval) {
        const p = st.pending;
        keep(tag, st, p.v, p.q, p.ts, p.m);   // med tiden den kom
        st.stored.m = m;   // men neste intervall telles fra nå: høyst én per minInterval
        continue;
      }
      if (r.maxInterval > 0 && m - st.stored.m >= r.maxInterval && st.cur) keep(tag, st, st.cur.v, st.cur.q, ts, m);
    }
  }

  // nye regler: taggene beholder det de sist lagret, så lagring av reglene ikke lagrer alt på nytt
  function setRules(newRules) {
    rules = newRules;
    for (const [tag, st] of states) {
      const rule = ruleFor(rules, tag);
      if (!rule || rule.mode === 'ignore') { states.set(tag, { rule: null }); continue; }
      if (st.rule) {
        st.rule = rule;
        if (st.flickering && (rule.mode !== 'change' || !(rule.flickerChanges > 0))) st.flickering = false;
        if (rule.mode !== 'change') st.pending = null;
      } else states.delete(tag);
    }
  }

  // en pause begynner eller slutter: isPaused(tag) sier hvilke tagger den dekker nå (null: ingen)
  function setPaused(isPaused, ts, m) {
    pausedTag = isPaused || null;
    for (const [tag, st] of states) {
      if (!st.rule) continue;
      const p = !!(pausedTag && pausedTag(tag));
      if (p === st.paused) continue;
      st.paused = p;
      if (p) {
        // et merke der de lagrede verdiene stopper, så en trend viser et hull, ikke en strek over pausen
        if (st.stored) { sink.store(tag, null, PAUSED, ts, m); st.stored = { v: null, q: PAUSED, m }; }
        st.pending = null;
        st.flickering = false;
        st.changes = [];
      } else if (st.cur) {
        // lagringen fortsetter med verdien taggen har nå, enten den er endret eller ikke
        st.raw = st.cur.v;
        st.rawQ = st.cur.q;
        keep(tag, st, st.cur.v, st.cur.q, ts, m);
      } else st.stored = null;
    }
  }

  return { value, tick, setRules, setPaused, states };
}

// ---------------------------------------------------------------- regelfilen
const DEFAULTS = { flushSeconds: 30, keepDays: 7, maxMB: 1000, events: true };
// recorder.db -> recorder.rules.json, ved siden av den
function rulesFileFor(dbPath) {
  const p = path.parse(dbPath);
  return path.join(p.dir, p.name + '.rules.json');
}

// Sjekker det som skal lagres, og rydder i det: { recording, errors: ["rule 2: ..."] }
function checkRecording(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const errors = [];
  const n = (v, d, min, max, what) => {
    const x = num(v, d);
    if (x < min || x > max) errors.push(`${what} must be between ${min} and ${max}`);
    return x;
  };
  const out = {
    flushSeconds: n(inp.flushSeconds, DEFAULTS.flushSeconds, 1, 3600, 'Write every'),
    keepDays: n(inp.keepDays, DEFAULTS.keepDays, 0.01, 3650, 'Keep for'),
    maxMB: n(inp.maxMB, DEFAULTS.maxMB, 1, 1e6, 'Size limit'),
    events: inp.events !== false,
    rules: [],
  };
  (Array.isArray(inp.rules) ? inp.rules : []).forEach((r, i) => {
    const where = `Rule ${i + 1}`;
    const tags = String(r && r.tags || '').trim();
    if (!tags) { errors.push(`${where}: name at least one tag`); return; }
    const mode = MODES.includes(r.mode) ? r.mode : 'change';
    const rule = { tags, mode };
    const pos = (key, what, min) => {
      if (r[key] === undefined || r[key] === null || r[key] === '') return;
      const x = Number(r[key]);
      if (!Number.isFinite(x) || x < (min || 0)) { errors.push(`${where}: ${what} must be a number of at least ${min || 0}`); return; }
      rule[key] = x;
    };
    if (mode === 'interval') {
      pos('every', 'the interval', 1);
      if (rule.every === undefined) errors.push(`${where}: say how often, in seconds`);
    }
    if (mode === 'change') {
      if (r.deadband !== undefined && r.deadband !== null && String(r.deadband).trim() !== '') {
        const db = parseDeadband(r.deadband);
        if (!db) errors.push(`${where}: the smallest change is a number, like 50, or a percentage, like 2%`);
        else rule.deadband = db.pct ? `${db.pct}%` : db.abs;
      }
      for (const [key, what] of [['bits', 'the bits to watch'], ['ignoreBits', 'the bits to ignore']]) {
        if (r[key] === undefined || r[key] === null || String(r[key]).trim() === '') continue;
        if (parseBits(r[key]) === null) errors.push(`${where}: ${what} are bit numbers 0 to 31, like 0-7, 11`);
        else rule[key] = String(r[key]).trim();
      }
      if (rule.bits && rule.ignoreBits) errors.push(`${where}: give either the bits to watch or the bits to ignore, not both`);
      pos('minInterval', 'at most one value per');
      pos('maxInterval', 'store again after');
      pos('flickerChanges', 'the flicker count');
      pos('flickerSeconds', 'the flicker time');
      if ((rule.flickerChanges > 0) !== (rule.flickerSeconds > 0)) errors.push(`${where}: flicker needs both a number of changes and a time`);
      if (rule.minInterval > 0 && rule.maxInterval > 0 && rule.maxInterval < rule.minInterval) errors.push(`${where}: "store again after" can't be shorter than "at most one value per"`);
    }
    if (r.note && String(r.note).trim()) rule.note = String(r.note).trim().slice(0, 300);
    out.rules.push(rule);
  });
  (Array.isArray(inp.pauses) ? inp.pauses : []).forEach((p, i) => {
    const where = `Pause ${i + 1}`;
    if (!p || typeof p !== 'object') { errors.push(`${where}: not a pause`); return; }
    const since = parseStamp(p.since);
    const open = p.until === null || p.until === undefined || String(p.until).trim() === '';
    const until = open ? null : parseStamp(p.until);
    if (since === null) { errors.push(`${where}: "since" is a time like 2026-09-28 14:30`); return; }
    if (!open && until === null) { errors.push(`${where}: "until" is a time like 2026-09-28 15:30, or null until it is resumed`); return; }
    const pause = { id: String(p.id || '').trim().slice(0, 40) || since.toString(36), tags: String(p.tags || '').trim() || '*',
      since: localStamp(since), until: until === null ? null : localStamp(until) };
    if (p.reason && String(p.reason).trim()) pause.reason = String(p.reason).trim().slice(0, 200);
    if (!out.pauses) out.pauses = [];
    out.pauses.push(pause);
  });
  return { recording: out, errors };
}

// ---------------------------------------------------------------- pauser
// "2026-09-28 14:30:05" i Pi-ens egen tid, som recorderen og databaseleseren deler
const pad2 = n => String(n).padStart(2, '0');
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function parseStamp(s) {
  const m = String(s === undefined || s === null ? '' : s).trim().match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?$/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
  return Number.isFinite(t) ? t : null;
}
// pausene som gjelder akkurat nå (en med `until` i fortiden er over)
function activePauses(recording, now) {
  return (recording && Array.isArray(recording.pauses) ? recording.pauses : []).filter(p => {
    const since = parseStamp(p.since), until = p.until ? parseStamp(p.until) : null;
    return since !== null && (until === null || until > now);
  });
}
// hvilke tagger pausene dekker, og hvilke hendelseskilder: en enhets egne hendelser (kilde kv_1)
// og alarmene til taggene dens (kilde kv_1.faultCode) følger taggene (kv_1.*)
function pauseMatcher(pauses, vars) {
  const res = [].concat(...pauses.map(p => compilePatterns(p.tags, vars)));
  return {
    tag: name => res.some(re => re.test(name)),
    source: src => res.some(re => re.test(src) || re.test(src + '.\u0001')),
  };
}
// en pause i ord: "all tags until 15:02 (maintenance)", "kv_1.* until ..." med variablene satt inn
function pauseText(p, now, vars) {
  const day = localStamp(now === undefined || now === null ? Date.now() : now).slice(0, 10);
  const when = t => (t.slice(0, 10) === day ? t.slice(11, 16) : t.slice(0, 16));
  const tags = p.tags === '*' ? 'all tags' : String(p.tags).replace(/\$\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
  return `${tags} ${p.until ? 'until ' + when(p.until) : 'until it is resumed'}${p.reason ? ` (${p.reason})` : ''}`;
}

// { recording, warnings } | { missing: true } | { error }. Streng ved lagring (checkRecording),
// tilgivende ved lesing: en regel med en rar innstilling lagrer likevel, og advarslene sier hva.
// En fil som ikke kan leses, blir aldri skrevet over.
function readRulesFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return { error: `${file} can't be read: ${e.message}` };
  }
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); }   // Notepad kan lagre en BOM (byte-order mark)
  catch (e) { return { error: `${file} is not valid JSON (${e.message}). Fix it, or delete it and set the rules again.` }; }
  const c = checkRecording(j);
  return { recording: c.recording, warnings: c.errors };
}
// alt eller ingenting, selv om strømmen går midt i skrivingen
function writeRulesFile(file, recording) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(recording, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = {
  compilePatterns, compileRules, ruleFor, createRecorderRules, QUALITY, PAUSED,
  parseDeadband, parseBits, checkRecording, rulesFileFor, readRulesFile, writeRulesFile, DEFAULTS,
  localStamp, parseStamp, activePauses, pauseMatcher, pauseText,
};
