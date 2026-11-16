/*
 * Animasjonswidget — en Three.js-kodesnutt fra prosjektets assets, styrt av tagger.
 *
 * Kodesnutten kjører i sin egen sandkasse-ramme (iframe):
 *   - ingen origin, ingen tilgang til HMI-siden, hubens WebSocket eller prosjekt-API-et
 *   - kan laste three.js / three/addons (servert av huben) og filer fra config/assets
 *   - tagverdier går inn; ut går bare verdier for utgangene koden deklarerer, og HMI-en skriver dem
 *     bare til taggen som er koblet til hver av dem i widgetens egenskaper (og bare i Run-modus)
 *   - å fjerne rammen frigjør WebGL og stopper alle løkker
 *
 * Inne i kodesnutten finnes et globalt `hmi`-objekt:
 *   const input = hmi.inputs({ roll: { value: 0, min: -180, max: 180, unit: '°', smooth: 0.25 }, yaw: 0 })
 *       deklarerer innganger HMI-en kan koble tagger til; returnerer et objekt der egenskapene
 *       alltid har siste verdi (smooth: sekunder å gli over, wrap: 360 for vinkler)
 *   const output = hmi.outputs({ setpoint: { value: 50, min: 0, max: 100, unit: '%' }, pump: false })
 *       deklarerer utganger; `output.setpoint = 70` skriver den koblede taggen. Å lese gir det koden
 *       satte sist, eller taggens verdi når den endres et annet sted
 *   hmi.hold('start')                   trykket inn til funksjonen den gir kalles, eller pekeren slippes
 *   hmi.panel([{ output: 'setpoint' }, { output: 'pump' }, { output: 'start', type: 'button' }])
 *       ferdige glidebrytere, brytere og knapper for utgangene, over animasjonen
 *   const { scene, camera, renderer, onFrame } = hmi.stage({ camera: [x,y,z], grid: true, controls: true })
 *       valgfri ferdig scene, lys, størrelsestilpasning og render-løkke
 *   hmi.onInput((name, value) => ...)   kalles når en koblet tag endres
 *   hmi.onOutput((name, value) => ...)  kalles når taggen til en utgang endres et annet sted
 *   hmi.asset('robot.glb')              URL til en fil i config/assets
 *   hmi.colors                          { background, accent, ink, grid, gridSoft }
 *   hmi.container                       element å rendre inn i hvis du lager din egen renderer
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el, plate } = H.helpers;

  // ---------------------------------------------------------------- kodebuffer
  const cache = new Map();
  function load(name) {
    if (!cache.has(name)) {
      cache.set(name, fetch('/assets/' + encodeURIComponent(name), { cache: 'no-cache' })
        .then(r => { if (!r.ok) throw new Error(`${name} could not be loaded (${r.status})`); return r.text(); })
        .catch(e => { cache.delete(name); throw e; }));
    }
    return cache.get(name);
  }
  const forget = name => cache.delete(name);

  function themeColors(accent) {
    const cs = getComputedStyle(document.documentElement);
    const v = (k, d) => cs.getPropertyValue(k).trim() || d;
    return {
      background: v('--panel-2', '#262c34'), panel: v('--panel', '#1e2329'), ink: v('--ink', '#e7eaee'),
      accent: accent || v('--live', '#f2b441'), grid: v('--line', '#3a434f'), gridSoft: v('--line-soft', '#2b323b'),
    };
  }

  // ---------------------------------------------------------------- kode som kjører inne i rammen
  // __OFFSET__ byttes ut med linjen der brukerens kode starter, så feil peker på brukerens linjer.
  const HELPER = `
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const cfg = __CFG__;
const OFFSET = __OFFSET__;
const post = m => parent.postMessage(m, '*');

// ---- errors and console go to the HMI
let budget = 60;
setInterval(() => { budget = 60; }, 1000);
const say = (m) => { if (budget-- > 0) post(m); };
const text = a => { if (a instanceof Error) return a.message; if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } } return String(a); };
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { orig(...a); say({ kind: 'log', level, text: a.map(text).join(' ') }); };
}
const lineOf = n => (n && n > OFFSET ? n - OFFSET : null);
addEventListener('error', e => {
  if (e.target && e.target !== window && e.target.tagName === 'SCRIPT') {
    say({ kind: 'error', message: 'The code could not be loaded. Check the import lines: only "three" and "three/addons/..." can be imported here.' });
    return;
  }
  say({ kind: 'error', message: e.message || 'error', line: lineOf(e.lineno), col: e.colno });
}, true);
addEventListener('unhandledrejection', e => say({ kind: 'error', message: 'Unhandled: ' + text(e.reason) }));
document.addEventListener('securitypolicyviolation', e => say({ kind: 'error',
  message: 'Blocked ' + (e.blockedURI || e.violatedDirective) + ' \\u2014 animations can only load three.js and files from the project assets (use hmi.asset(name)).' }));

// ---- inputs
const defs = {}, input = {}, target = {}, pending = {}, listeners = [];
const num = v => (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v));
function setValue(name, v) {
  const d = defs[name];
  if (!d) { pending[name] = v; return; }
  if (d.smooth > 0 && Number.isFinite(num(v))) target[name] = num(v);
  else input[name] = typeof d.value === 'number' && Number.isFinite(num(v)) ? num(v) : v;
  for (const f of listeners) { try { f(name, v); } catch (e) { say({ kind: 'error', message: e.message }); } }
}
function inputs(spec) {
  for (const [name, raw] of Object.entries(spec || {})) {
    const d = raw !== null && typeof raw === 'object' ? { ...raw } : { value: raw };
    if (d.value === undefined) d.value = 0;
    defs[name] = d;
    input[name] = d.value;
    target[name] = d.value;
  }
  post({ kind: 'inputs', inputs: Object.entries(defs).map(([name, d]) => ({
    name, value: d.value, min: d.min, max: d.max, step: d.step, unit: d.unit || '', label: d.label || '' })) });
  for (const k of Object.keys(pending)) { if (defs[k]) { setValue(k, pending[k]); delete pending[k]; } }
  return input;
}

// ---- outputs: the code sets them, the HMI writes the tag bound to each
const outDefs = {}, outValue = {}, outSetAt = {}, outPending = {}, outListeners = [], held = new Map();
const ECHO_MS = 1000;   // after the code sets an output, the tag's own updates wait this long
// a value as the output's kind (from its starting value); clamp: keep it within min..max
function coerce(d, v, clamp) {
  if (typeof d.value === 'boolean') return typeof v === 'string' ? !['', 'false', '0', 'off'].includes(v.trim().toLowerCase()) : !!v;
  if (typeof d.value === 'number') {
    let n = typeof v === 'string' && v.trim() === '' ? NaN : num(v);
    if (!Number.isFinite(n)) return undefined;
    if (clamp && Number.isFinite(d.min)) n = Math.max(d.min, n);
    if (clamp && Number.isFinite(d.max)) n = Math.min(d.max, n);
    return n;
  }
  return v == null ? '' : String(v);
}
function outDef(name) {
  const d = outDefs[name];
  if (!d) say({ kind: 'error', message: 'There is no output called "' + name + '". Declare it with hmi.outputs().' });
  return d;
}
function setOutput(name, v) {
  const d = outDef(name);
  if (!d) return;
  const c = coerce(d, v, true);
  if (c === undefined) { say({ kind: 'error', message: 'Output ' + name + ': ' + text(v) + ' is not a number' }); return; }
  outValue[name] = c;
  outSetAt[name] = performance.now();
  post({ kind: 'write', name, value: c });
}
// the bound tag changed (or the HMI sends what the device has after a write)
function tagOutput(name, v) {
  const d = outDefs[name];
  if (!d) { outPending[name] = v; return; }
  if (v === null || v === undefined || held.has(name)) return;
  if (performance.now() - (outSetAt[name] ?? -Infinity) < ECHO_MS) return;   // an older value on its way back
  const c = coerce(d, v, false);
  if (c === undefined || c === outValue[name]) return;
  outValue[name] = c;
  for (const f of outListeners) { try { f(name, c); } catch (e) { say({ kind: 'error', message: e.message }); } }
}
// reading gives the latest value, setting writes; a name that isn't declared says so
const output = new Proxy({}, {
  get: (_, k) => (typeof k === 'string' ? outValue[k] : undefined),
  set: (_, k, v) => { setOutput(String(k), v); return true; },
  has: (_, k) => k in outDefs,
  ownKeys: () => Object.keys(outDefs),
  getOwnPropertyDescriptor: (_, k) => (k in outDefs ? { value: outValue[k], writable: true, enumerable: true, configurable: true } : undefined),
});
function outputs(spec) {
  for (const [name, raw] of Object.entries(spec || {})) {
    const d = raw !== null && typeof raw === 'object' ? { ...raw } : { value: raw };
    if (d.value === undefined) d.value = 0;
    outDefs[name] = d;
    outValue[name] = d.value;   // shown until the tag's value arrives; nothing is written at the start
  }
  post({ kind: 'outputs', outputs: Object.entries(outDefs).map(([name, d]) => ({
    name, value: d.value, min: d.min, max: d.max, step: d.step, unit: d.unit || '', label: d.label || '' })) });
  for (const k of Object.keys(outPending)) { if (outDefs[k]) { tagOutput(k, outPending[k]); delete outPending[k]; } }
  return output;
}
// pressed (the output's 'press' value, true or 1) until the returned function is called, or the
// pointer is let go, or the widget loses focus; then its 'release' value (false or 0). With
// 'repeat' (ms) the HMI sends the press again that often, for hold-to-run.
function hold(name) {
  const d = outDef(name);
  if (!d) return () => {};
  if (held.has(name)) return held.get(name);
  const numeric = typeof d.value === 'number';
  const press = coerce(d, d.press !== undefined ? d.press : (numeric ? 1 : true), true);
  const release = coerce(d, d.release !== undefined ? d.release : (numeric ? 0 : false), true);
  if (press === undefined || release === undefined) { say({ kind: 'error', message: 'Output ' + name + ': press and release must be numbers' }); return () => {}; }
  outValue[name] = press;
  post({ kind: 'press', name, value: press, release, repeat: Number(d.repeat) > 0 ? Number(d.repeat) : 0 });
  const beat = setInterval(() => post({ kind: 'held', name }), 150);   // the HMI lets go if these stop
  const stop = () => {
    if (held.get(name) !== stop) return;
    held.delete(name);
    clearInterval(beat);
    outValue[name] = release;
    outSetAt[name] = performance.now();
    post({ kind: 'release', name });
  };
  held.set(name, stop);
  return stop;
}
const releaseHeld = () => { for (const stop of [...held.values()]) stop(); };
addEventListener('pointerup', releaseHeld, true);
addEventListener('pointercancel', releaseHeld, true);
addEventListener('blur', e => { if (e.target === window) releaseHeld(); });
addEventListener('pagehide', releaseHeld);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHeld(); });

// ---- ready-made controls for the outputs (and read-outs of inputs), over the animation
let panelCss = false;
const syncs = [];
function panelStyle() {
  if (panelCss) return;
  panelCss = true;
  const c = cfg.colors;
  const st = document.createElement('style');
  st.textContent =
    '.hmi-panel{position:absolute;z-index:10;display:flex;flex-direction:column;gap:9px;box-sizing:border-box;min-width:170px;max-width:calc(100% - 24px);' +
      'max-height:calc(100% - 24px);overflow:auto;padding:10px 12px;border-radius:8px;border:1px solid ' + c.grid + ';' +
      'background:color-mix(in srgb,' + c.panel + ' 86%,transparent);color:' + c.ink + ';font:12px system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none;-webkit-user-select:none}' +
    '.hmi-panel.top-left{top:12px;left:12px}.hmi-panel.top-right{top:12px;right:12px}' +
    '.hmi-panel.bottom-left{bottom:12px;left:12px}.hmi-panel.bottom-right{bottom:12px;right:12px}' +
    '.hmi-ptitle{font-weight:600;opacity:.8}' +
    '.hmi-prow{display:flex;flex-direction:column;gap:4px}' +
    '.hmi-prow.switch,.hmi-prow.value,.hmi-prow.number{flex-direction:row;align-items:center;justify-content:space-between;gap:12px}' +
    '.hmi-phead{display:flex;justify-content:space-between;gap:12px}' +
    '.hmi-pval{font-variant-numeric:tabular-nums;font-weight:600;color:' + c.accent + '}' +
    '.hmi-panel input[type=range]{width:100%;margin:0;accent-color:' + c.accent + ';touch-action:none;cursor:pointer}' +
    '.hmi-panel input[type=number]{width:76px;box-sizing:border-box;padding:3px 6px;border-radius:5px;border:1px solid ' + c.grid + ';background:' + c.background + ';color:' + c.ink + ';font:inherit;text-align:right}' +
    '.hmi-switch{position:relative;flex:none;width:38px;height:20px;padding:0;border-radius:10px;border:1px solid ' + c.grid + ';background:' + c.gridSoft + ';cursor:pointer}' +
    '.hmi-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:' + c.ink + ';transition:left .12s}' +
    '.hmi-switch[aria-checked=true]{background:' + c.accent + ';border-color:' + c.accent + '}' +
    '.hmi-switch[aria-checked=true]::after{left:20px;background:' + c.panel + '}' +
    '.hmi-pbtn{padding:7px 10px;border-radius:6px;border:1px solid ' + c.grid + ';background:' + c.gridSoft + ';color:' + c.ink + ';font:inherit;font-weight:600;cursor:pointer;touch-action:none}' +
    '.hmi-pbtn.held{background:' + c.accent + ';border-color:' + c.accent + ';color:' + c.panel + '}' +
    '.hmi-panel :focus-visible{outline:2px solid ' + c.accent + ';outline-offset:2px}';
  document.head.append(st);
  (function tick() { for (const f of syncs) f(); requestAnimationFrame(tick); })();
}
function panel(items, o = {}) {
  panelStyle();
  const make = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const box = make('div', 'hmi-panel ' + (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(o.place) ? o.place : 'top-left'));
  if (o.width) box.style.width = typeof o.width === 'number' ? o.width + 'px' : String(o.width);
  if (o.title) box.append(make('div', 'hmi-ptitle', o.title));
  for (const item of items || []) {
    const isInput = item.input !== undefined;
    const name = String(isInput ? item.input : item.output);
    const d = isInput ? defs[name] : outDef(name);
    if (!d) { if (isInput) say({ kind: 'error', message: 'There is no input called "' + name + '". Declare it with hmi.inputs().' }); continue; }
    const kind = isInput ? 'value' : item.type || (typeof d.value === 'boolean' ? 'switch' : Number.isFinite(d.min) && Number.isFinite(d.max) ? 'slider' : 'number');
    const unit = item.unit ?? d.unit ?? '';
    const step = Number(item.step ?? d.step) || (kind === 'slider' ? (d.max - d.min > 20 ? 1 : (d.max - d.min) / 100) : 0);
    const decimals = item.decimals ?? (step ? (String(+step.toPrecision(6)).split('.')[1] || '').length : 1);
    const show = v => (typeof v === 'number' ? v.toFixed(Math.min(6, decimals)) : typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v ?? '')) + (unit && typeof v === 'number' ? ' ' + unit : '');
    const row = make('div', 'hmi-prow ' + kind);
    const label = make('span', null, item.label ?? d.label ?? name);
    let last;
    const changed = v => { if (v === last) return false; last = v; return true; };
    if (kind === 'value') {
      const val = make('span', 'hmi-pval');
      row.append(label, val);
      syncs.push(() => { if (changed(input[name])) val.textContent = show(input[name]); });
    } else if (kind === 'slider') {
      const head = make('div', 'hmi-phead'), val = make('span', 'hmi-pval'), r = make('input');
      r.type = 'range'; r.min = d.min; r.max = d.max; r.step = step || 'any';
      head.append(label, val);
      row.append(head, r);
      let dragging = false;
      r.addEventListener('pointerdown', () => { dragging = true; });
      for (const ev of ['pointerup', 'pointercancel', 'change']) r.addEventListener(ev, () => { dragging = false; });
      r.addEventListener('input', () => { output[name] = Number(r.value); });
      syncs.push(() => { if (changed(outValue[name])) { val.textContent = show(outValue[name]); if (!dragging) r.value = outValue[name]; } });
    } else if (kind === 'switch') {
      const b = make('button', 'hmi-switch');
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-label', label.textContent);
      b.addEventListener('click', () => { output[name] = !coerce(d, outValue[name], false); });
      row.append(label, b);
      syncs.push(() => { const on = !!coerce(d, outValue[name], false); if (changed(on)) b.setAttribute('aria-checked', String(on)); });
    } else if (kind === 'button') {
      const b = make('button', 'hmi-pbtn', item.text ?? item.label ?? d.label ?? name);
      let stop = null;
      const down = () => { if (!held.has(name)) stop = hold(name); };
      const up = () => { if (stop) { stop(); stop = null; } };
      b.addEventListener('pointerdown', e => { e.preventDefault(); down(); });
      b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); down(); } });
      b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') up(); });
      b.addEventListener('blur', up);
      row.append(b);
      syncs.push(() => { const on = held.has(name); if (changed(on)) b.classList.toggle('held', on); });
    } else {
      const f = make('input');
      f.type = 'number'; f.step = step || 'any';
      if (Number.isFinite(d.min)) f.min = d.min;
      if (Number.isFinite(d.max)) f.max = d.max;
      f.addEventListener('change', () => { if (f.value !== '') output[name] = Number(f.value); });
      f.addEventListener('keydown', e => { if (e.key === 'Enter') f.blur(); });
      row.append(label, f);
      syncs.push(() => { if (document.activeElement !== f && changed(outValue[name])) f.value = outValue[name]; });
    }
    box.append(row);
  }
  hmi.container.append(box);
  return box;
}

// smoothing runs on its own, whether or not hmi.stage() is used
let lastT = 0;
(function glide(t) {
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
  lastT = t;
  for (const [name, d] of Object.entries(defs)) {
    if (!(d.smooth > 0) || typeof input[name] !== 'number') continue;
    let diff = target[name] - input[name];
    if (d.wrap) diff = ((diff % d.wrap) + d.wrap * 1.5) % d.wrap - d.wrap / 2;   // shortest way round
    input[name] += Math.abs(diff) < 1e-6 ? diff : diff * (1 - Math.exp(-dt / d.smooth));
  }
  requestAnimationFrame(glide);
})(0);

addEventListener('message', e => {
  if (e.source !== parent || !e.data || !e.data.values) return;
  if (e.data.kind === 'values') for (const [k, v] of Object.entries(e.data.values)) setValue(k, v);
  else if (e.data.kind === 'outputValues') for (const [k, v] of Object.entries(e.data.values)) tagOutput(k, v);
});

// ---- ready-made stage
function stage(o = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !!o.transparent });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  hmi.container.append(renderer.domElement);
  const scene = new THREE.Scene();
  if (!o.transparent) scene.background = new THREE.Color(cfg.colors.background);
  const camera = new THREE.PerspectiveCamera(o.fov || 45, 1, 0.05, 2000);
  camera.position.set(...(o.camera || [4, 3, 6]));
  const look = new THREE.Vector3(...(o.target || [0, 0, 0]));
  camera.lookAt(look);
  if (o.lights !== false) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a434f, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(5, 8, 6);
    scene.add(sun);
  }
  if (o.grid) {
    const g = new THREE.GridHelper(typeof o.grid === 'number' ? o.grid : 12, 12, cfg.colors.grid, cfg.colors.gridSoft);
    g.position.y = o.gridY ?? -1.2;
    scene.add(g);
  }
  let controls = null;
  if (o.controls) { controls = new OrbitControls(camera, renderer.domElement); controls.target.copy(look); controls.enableDamping = true; controls.update(); }
  const frames = [];
  const fit = () => { const w = innerWidth || 1, h = innerHeight || 1; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  addEventListener('resize', fit);
  fit();
  let last = performance.now();
  renderer.setAnimationLoop(t => {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    for (const f of frames) { try { f(dt, t); } catch (e) { say({ kind: 'error', message: e.message, line: lineOf(stackLine(e)) }); } }
    if (controls) controls.update();
    renderer.render(scene, camera);
  });
  return { THREE, scene, camera, renderer, controls, onFrame: f => frames.push(f) };
}
const stackLine = e => { const m = String(e && e.stack || '').match(/about:srcdoc:(\\d+):\\d+/); return m ? +m[1] : null; };

const hmi = {
  inputs, outputs, hold, panel, stage, colors: cfg.colors, container: document.getElementById('root'),
  onInput: f => { listeners.push(f); },
  onOutput: f => { outListeners.push(f); },
  asset: name => (cfg.assets && cfg.assets[name]) || cfg.origin + '/assets/' + encodeURIComponent(name),
  get values() { return input; },
};
globalThis.hmi = hmi;
post({ kind: 'ready' });
`;

  // ---------------------------------------------------------------- three.js til rammen
  // Rammen har ingen origin, og Chrome (Local Network Access) lar ikke en slik ramme hente noe fra
  // en hub på en lokal adresse (http://192.168.x.x), bare fra localhost. Derfor henter denne siden
  // three.js, de addonene koden importerer og filene den nevner med hmi.asset('...'), og rammen får
  // dem som data:-URL-er i import-kartet sitt. Ingenting i rammen henter fra huben.
  const modules = new Map();   // nøkkel i import-kartet -> Promise<{ url, deps }>
  const ADDON_REF = /(['"])three\/addons\/([^'"]+)\1/g;
  const RELATIVE = /(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
  const ASSET_REF = /hmi\.asset\(\s*(['"])([^'"]+)\1\s*\)/g;
  const dataUrl = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  async function getText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} (${r.status})`);
    return r.text();
  }
  // én modul som data:-URL; dens egne relative importer blir også nøkler i import-kartet, så
  // ingenting pakkes inn to ganger
  function loadModule(key) {
    if (!modules.has(key)) {
      const p = (async () => {
        let text;
        const deps = [];
        if (key === 'three') {
          text = (await getText('/vendor/three/three.module.js')).replace(/(['"])\.\/three\.core\.js\1/g, '$1three/core$1');
          deps.push('three/core');
        } else if (key === 'three/core') {
          text = await getText('/vendor/three/three.core.js');
        } else {
          const path = key.slice('three/addons/'.length);
          text = (await getText('/vendor/three/addons/' + path)).replace(RELATIVE, (m, kw, q, rel) => {
            const dep = 'three/addons/' + new URL(rel, 'http://x/' + path).pathname.slice(1);
            deps.push(dep);
            return kw + q + dep + q;
          });
          for (const m of text.matchAll(ADDON_REF)) deps.push('three/addons/' + m[2]);
        }
        return { url: await dataUrl(new Blob([text], { type: 'text/javascript' })), deps };
      })();
      p.catch(() => modules.delete(key));
      modules.set(key, p);
    }
    return modules.get(key);
  }
  // det koden trenger: { imports: import-kartet, assets: navn -> data:-URL }
  async function pack(code) {
    const imports = {};
    const visit = async key => {
      if (key in imports) return;
      imports[key] = null;
      let mod;
      try { mod = await loadModule(key); } catch (e) {
        if (key === 'three' || key === 'three/core') throw e;
        delete imports[key];   // en addon som ikke finnes: importen feiler i rammen, med en melding
        return;
      }
      imports[key] = mod.url;
      await Promise.all(mod.deps.map(visit));
    };
    const wanted = new Set(['three']);
    for (const m of (HELPER + '\n' + code).matchAll(ADDON_REF)) wanted.add('three/addons/' + m[2]);
    await Promise.all([...wanted].map(visit));
    const assets = {};
    for (const m of code.matchAll(ASSET_REF)) {
      const name = m[2];
      if (name in assets) continue;
      try {
        const r = await fetch('/assets/' + encodeURIComponent(name), { cache: 'no-cache' });
        if (r.ok) assets[name] = await dataUrl(await r.blob());
      } catch { /* hmi.asset gir hubens adresse; lasteren sier fra */ }
    }
    return { imports, assets };
  }

  // ---------------------------------------------------------------- rammen
  const frames = new Map();   // contentWindow -> handler
  addEventListener('message', e => {
    const h = frames.get(e.source);
    if (h && e.data && typeof e.data === 'object') h(e.data);
  });

  function run(holder, code, { colors, onMessage }) {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Animation');
    frame.className = 'anim-frame';
    holder.append(frame);

    let ready = false, dead = false;
    const latest = {}, latestOut = {};
    const post = (values, kind = 'values') => frame.contentWindow && frame.contentWindow.postMessage({ kind, values }, '*');
    frames.set(frame.contentWindow, m => {
      if (m.kind === 'ready') {
        ready = true;
        if (Object.keys(latest).length) post({ ...latest });
        if (Object.keys(latestOut).length) post({ ...latestOut }, 'outputValues');
      }
      onMessage(m);
    });
    pack(code).then(pkg => { if (!dead) frame.srcdoc = page(code, colors, pkg); })
      .catch(e => { if (!dead) onMessage({ kind: 'error', message: `three.js could not be loaded from the hub: ${e.message}` }); });
    return {
      frame,
      send(values) {
        Object.assign(latest, values);
        if (ready) post(values);
      },
      // the tags bound to outputs: what the device has
      sendOutputs(values) {
        Object.assign(latestOut, values);
        if (ready) post(values, 'outputValues');
      },
      destroy() {
        dead = true;
        frames.delete(frame.contentWindow);
        frame.remove();
      },
    };
  }

  // rammens dokument: koden, hjelperen og import-kartet med three.js
  function page(code, colors, pkg) {
    const origin = location.origin;
    const nonce = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' data: ${origin}/vendor/`,
      `connect-src ${origin}/assets/ ${origin}/vendor/ data: blob:`,
      `img-src ${origin}/assets/ data: blob:`,
      `media-src ${origin}/assets/ data: blob:`,
      "style-src 'unsafe-inline'",
    ].join('; ');
    const importmap = { imports: { ...pkg.imports, 'three/addons/': `${origin}/vendor/three/addons/` } };
    const cfg = { colors, origin, assets: pkg.assets };
    const safe = s => String(s).replace(/<\/script/gi, '<\\/script');
    const prefix =
      `<!doctype html><html><head><meta charset="utf-8">\n` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
      `<script type="importmap" nonce="${nonce}">${JSON.stringify(importmap)}</script>\n` +
      `<style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:${colors.background}}canvas{display:block}</style>\n` +
      `</head><body><div id="root"></div>\n` +
      `<script type="module" nonce="${nonce}">${HELPER.replace('__CFG__', JSON.stringify(cfg))}</script>\n` +
      `<script type="module" nonce="${nonce}">\n`;
    const offset = prefix.split('\n').length - 1;
    return prefix.replace('__OFFSET__', String(offset)) + safe(code) +
      `\n</script>\n<script type="module" nonce="${nonce}">parent.postMessage({ kind: 'started' }, '*');</script>\n</body></html>`;
  }

  const STARTER =`// Animation snippet. Inputs declared here can be bound to tags in the HMI.
import * as THREE from 'three';

const input = hmi.inputs({
  angle: { value: 0, min: 0, max: 360, unit: '\u00b0', smooth: 0.2, wrap: 360 },
});

// scene, camera, lights, resizing and render loop sized to the widget
const { scene, onFrame } = hmi.stage({ camera: [3, 2.5, 4], grid: true, controls: true });

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.5, 1.5, 1.5),
  new THREE.MeshStandardMaterial({ color: hmi.colors.accent }),
);
scene.add(cube);

onFrame(() => {
  cube.rotation.y = THREE.MathUtils.degToRad(input.angle);
});
`;

  // ---------------------------------------------------------------- utgangene: skriving til taggene
  // Rammen sier hva koden setter; dette skriver taggen som er koblet til utgangen, med samme regler
  // som de andre kontrollene (ctx.write: bare i Run-modus, ikke til en frakoblet enhet).
  //   - en glidebryter sender mange verdier: høyst én skriving per WRITE_GAP per utgang, og den
  //     siste kommer alltid fram
  //   - SETTLE_MS etter siste skriving får koden taggens verdi, så den viser det enheten har
  //     (også når skrivingen ble avvist)
  //   - hmi.hold(): holdt til rammen slipper, og bare så lenge rammen sier fra at den fortsatt
  //     holder (HOLD_TIMEOUT), så et trykk aldri blir hengende hvis koden stopper
  const WRITE_GAP = 100, SETTLE_MS = 1200, HOLD_TIMEOUT = 600;
  const plain = v => typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
  function outputWriter(ctx, tagOf, resend) {
    const slots = new Map();   // utgang -> { last, timer, settle, value, due }
    const holds = new Map();   // utgang -> { stop, beat, dog }
    const warned = new Set();
    let dead = false;
    const slot = name => {
      if (!slots.has(name)) slots.set(name, { last: -Infinity, timer: 0, settle: 0, value: undefined, due: false });
      return slots.get(name);
    };
    const tag = name => {
      const t = tagOf[name];
      if (!t && !warned.has(name) && ctx.mode() === 'run') { warned.add(name); ctx.write('', null); }   // "This control has no tag bound"
      return t;
    };
    function settle(name) {
      const s = slot(name);
      clearTimeout(s.settle);
      s.settle = setTimeout(() => {
        const cur = ctx.value(tagOf[name]);
        if (!dead && cur && cur.value !== undefined) resend(name, cur.value);
      }, SETTLE_MS);
    }
    function flush(name) {
      const s = slot(name);
      s.timer = 0;
      if (!s.due) return;
      s.due = false;
      s.last = performance.now();
      ctx.write(tagOf[name], s.value);
      if (!dead) settle(name);
    }
    function release(name) {
      const h = holds.get(name);
      if (h) h.stop();
    }
    return {
      write(name, value) {
        if (!plain(value) || holds.has(name) || !tag(name)) return;
        const s = slot(name);
        s.value = value;
        s.due = true;
        const wait = s.last + WRITE_GAP - performance.now();
        if (wait <= 0) flush(name);
        else if (!s.timer) s.timer = setTimeout(() => flush(name), wait);
      },
      press(name, value, releaseValue, repeat) {
        if (!plain(value) || !plain(releaseValue) || !tag(name)) return;
        release(name);
        const t = tagOf[name], s = slot(name);
        clearTimeout(s.timer);
        s.timer = 0;
        s.due = false;
        const h = { beat: performance.now(), dog: 0, stop: null };
        h.stop = H.hold(() => ctx.write(t, value), () => {
          holds.delete(name);
          clearInterval(h.dog);
          ctx.write(t, releaseValue);
          if (!dead) settle(name);
        }, repeat > 0 ? Math.max(50, repeat) : 0);
        if (!h.stop) return;
        h.dog = setInterval(() => { if (performance.now() - h.beat > HOLD_TIMEOUT) h.stop(); }, 150);
        holds.set(name, h);
      },
      beat(name) { const h = holds.get(name); if (h) h.beat = performance.now(); },
      release,
      // widgeten fjernes: slipp alt som holdes, og send det siste som ventet
      destroy() {
        dead = true;
        for (const h of [...holds.values()]) h.stop();
        for (const [name, s] of slots) {
          clearTimeout(s.settle);
          if (s.timer) { clearTimeout(s.timer); flush(name); }
        }
      },
    };
  }

  H.anim = { load, forget, run, themeColors, STARTER };

  // ---------------------------------------------------------------- widgeten
  H.register('anim', {
    name: 'Animation', hint: 'Three.js scene driven by tags', size: [420, 340],
    props: [
      { key: 'label', label: 'Label', type: 'text', default: '' },
      { key: 'asset', label: 'Code', type: 'asset', accept: 'js', default: '' },
      { key: 'inputs', label: 'Inputs', type: 'inputs', default: {} },
      { key: 'outputs', label: 'Outputs', type: 'outputs', default: {} },
      { key: 'color', label: 'Accent colour', type: 'color', default: '', fallback: '#f2b441', hint: 'Given to the code as hmi.colors.accent' },
      H.commonProps.labelSize(),
    ],
    tags: w => [...new Set([...Object.values(w.props.inputs || {}), ...Object.values(w.props.outputs || {})].filter(Boolean))],
    mount(root, w, ctx) {
      const body = plate(root, w.props.label || null);
      body.classList.add('wanim');
      const holder = el('div', 'anim-holder');
      const err = el('div', 'anim-error');
      err.hidden = true;
      body.append(holder, err);
      const handle = { declared: null, declaredOutputs: null };
      if (!w.props.asset) {
        holder.append(el('div', 'svg-note', ctx.mode() === 'edit' ? 'Choose, upload or create the code in the properties panel' : 'No animation code selected'));
        return handle;
      }
      // tag -> navnene på inngangene som er koblet til den
      const byTag = new Map();
      for (const [name, tag] of Object.entries(w.props.inputs || {})) {
        if (!tag) continue;
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(name);
      }
      // og det samme for utgangene: tag -> navn, og navn -> tag
      const outByTag = new Map(), outTag = {};
      for (const [name, tag] of Object.entries(w.props.outputs || {})) {
        if (!tag) continue;
        outTag[name] = tag;
        if (!outByTag.has(tag)) outByTag.set(tag, []);
        outByTag.get(tag).push(name);
      }
      let runner = null, dead = false;
      const pending = {}, pendingOut = {};
      const showError = m => {
        err.hidden = false;
        err.textContent = (m.line ? `Line ${m.line}: ` : '') + m.message;
        err.title = 'Open the code editor to see all messages';
      };
      const writer = outputWriter(ctx, outTag, (name, value) => { if (runner) runner.sendOutputs({ [name]: value }); });
      load(w.props.asset).then(code => {
        if (dead) return;
        runner = run(holder, code, {
          colors: themeColors(w.props.color),
          onMessage(m) {
            const name = String(m.name);
            if (m.kind === 'inputs') { handle.declared = m.inputs; ctx.refresh && ctx.refresh(w.id); }
            else if (m.kind === 'outputs') { handle.declaredOutputs = m.outputs; ctx.refresh && ctx.refresh(w.id); }
            else if (m.kind === 'write') writer.write(name, m.value);
            else if (m.kind === 'press') writer.press(name, m.value, m.release, Number(m.repeat) || 0);
            else if (m.kind === 'held') writer.beat(name);
            else if (m.kind === 'release') writer.release(name);
            else if (m.kind === 'error') showError(m);
          },
        });
        if (Object.keys(pending).length) runner.send(pending);
        if (Object.keys(pendingOut).length) runner.sendOutputs(pendingOut);
      }).catch(e => { if (!dead) showError({ message: e.message }); });

      handle.update = (tag, value) => {
        const names = byTag.get(tag), outNames = outByTag.get(tag);
        if (names) {
          const values = {};
          for (const n of names) values[n] = value;
          if (runner) runner.send(values); else Object.assign(pending, values);
        }
        if (outNames) {
          const values = {};
          for (const n of outNames) values[n] = value;
          if (runner) runner.sendOutputs(values); else Object.assign(pendingOut, values);
        }
      };
      handle.destroy = () => { dead = true; writer.destroy(); if (runner) runner.destroy(); };
      return handle;
    },
  });
})();
