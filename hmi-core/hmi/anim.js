/*
 * Animasjonswidget — en Three.js-kodesnutt fra prosjektets assets, styrt av tagger.
 *
 * Kodesnutten kjører i sin egen sandkasse-ramme (iframe):
 *   - ingen origin, ingen tilgang til HMI-siden, hubens WebSocket eller prosjekt-API-et
 *   - kan laste three.js / three/addons (servert av huben) og filer fra config/assets
 *   - tagverdier går bare inn; å fjerne rammen frigjør WebGL og stopper alle løkker
 *
 * Inne i kodesnutten finnes et globalt `hmi`-objekt:
 *   const input = hmi.inputs({ roll: { value: 0, min: -180, max: 180, unit: '°', smooth: 0.25 }, yaw: 0 })
 *       deklarerer innganger HMI-en kan koble tagger til; returnerer et objekt der egenskapene
 *       alltid har siste verdi (smooth: sekunder å gli over, wrap: 360 for vinkler)
 *   const { scene, camera, renderer, onFrame } = hmi.stage({ camera: [x,y,z], grid: true, controls: true })
 *       valgfri ferdig scene, lys, størrelsestilpasning og render-løkke
 *   hmi.onInput((name, value) => ...)   kalles når en koblet tag endres
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
  if (e.source !== parent || !e.data || e.data.kind !== 'values') return;
  for (const [k, v] of Object.entries(e.data.values)) setValue(k, v);
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
  inputs, stage, colors: cfg.colors, container: document.getElementById('root'),
  onInput: f => { listeners.push(f); },
  asset: name => cfg.origin + '/assets/' + encodeURIComponent(name),
  get values() { return input; },
};
globalThis.hmi = hmi;
post({ kind: 'ready' });
`;

  // ---------------------------------------------------------------- rammen
  const frames = new Map();   // contentWindow -> handler
  addEventListener('message', e => {
    const h = frames.get(e.source);
    if (h && e.data && typeof e.data === 'object') h(e.data);
  });

  function run(holder, code, { colors, onMessage }) {
    const origin = location.origin;
    const nonce = 'n' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${origin}/vendor/`,
      `connect-src ${origin}/assets/ ${origin}/vendor/ data: blob:`,
      `img-src ${origin}/assets/ data: blob:`,
      `media-src ${origin}/assets/ blob:`,
      "style-src 'unsafe-inline'",
    ].join('; ');
    const importmap = { imports: { three: `${origin}/vendor/three/three.module.js`, 'three/addons/': `${origin}/vendor/three/addons/` } };
    const cfg = { colors, origin };
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
    const doc = prefix.replace('__OFFSET__', String(offset)) + safe(code) +
      `\n</script>\n<script type="module" nonce="${nonce}">parent.postMessage({ kind: 'started' }, '*');</script>\n</body></html>`;

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Animation');
    frame.className = 'anim-frame';
    holder.append(frame);

    let ready = false;
    const latest = {};
    const post = values => frame.contentWindow && frame.contentWindow.postMessage({ kind: 'values', values }, '*');
    frames.set(frame.contentWindow, m => {
      if (m.kind === 'ready') { ready = true; if (Object.keys(latest).length) post({ ...latest }); }
      onMessage(m);
    });
    frame.srcdoc = doc;
    return {
      frame,
      send(values) {
        Object.assign(latest, values);
        if (ready) post(values);
      },
      destroy() {
        frames.delete(frame.contentWindow);
        frame.remove();
      },
    };
  }

  const STARTER = `// Animation snippet. Inputs declared here can be bound to tags in the HMI.
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

  H.anim = { load, forget, run, themeColors, STARTER };

  // ---------------------------------------------------------------- widgeten
  H.register('anim', {
    name: 'Animation', hint: 'Three.js scene driven by tags', size: [420, 340],
    props: [
      { key: 'label', label: 'Label', type: 'text', default: '' },
      { key: 'asset', label: 'Code', type: 'asset', accept: 'js', default: '' },
      { key: 'inputs', label: 'Inputs', type: 'inputs', default: {} },
      { key: 'color', label: 'Accent colour', type: 'color', default: '', fallback: '#f2b441', hint: 'Given to the code as hmi.colors.accent' },
      H.commonProps.labelSize(),
    ],
    tags: w => [...new Set(Object.values(w.props.inputs || {}).filter(Boolean))],
    mount(root, w, ctx) {
      const body = plate(root, w.props.label || null);
      body.classList.add('wanim');
      const holder = el('div', 'anim-holder');
      const err = el('div', 'anim-error');
      err.hidden = true;
      body.append(holder, err);
      const handle = { declared: null };
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
      let runner = null, dead = false;
      const pending = {};
      const showError = m => {
        err.hidden = false;
        err.textContent = (m.line ? `Line ${m.line}: ` : '') + m.message;
        err.title = 'Open the code editor to see all messages';
      };
      load(w.props.asset).then(code => {
        if (dead) return;
        runner = run(holder, code, {
          colors: themeColors(w.props.color),
          onMessage(m) {
            if (m.kind === 'inputs') { handle.declared = m.inputs; ctx.refresh && ctx.refresh(w.id); }
            else if (m.kind === 'error') showError(m);
          },
        });
        if (Object.keys(pending).length) runner.send(pending);
      }).catch(e => { if (!dead) showError({ message: e.message }); });

      handle.update = (tag, value) => {
        const names = byTag.get(tag);
        if (!names) return;
        const values = {};
        for (const n of names) values[n] = value;
        if (runner) runner.send(values); else Object.assign(pending, values);
      };
      handle.destroy = () => { dead = true; if (runner) runner.destroy(); };
      return handle;
    },
  });
})();
