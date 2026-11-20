'use strict';

/* LCD-editor – everything is rendered on the Pi by the same code that drives
 * the display, so the preview is pixel-exact. This file handles editing,
 * selection and talking to the API. Character LCDs (1602) use the same editor,
 * with positions in character cells instead of pixels, and colour TFTs (ST7789)
 * the OLED elements, each in its own colour. In the kjøreverk the data sources
 * are first of all the hub's tags ({pls.reals_0}, {calc.kv_speed_rpm} …).
 *
 * A layout has one or more tabs, each with its own elements; the editor works
 * on one tab at a time. The board's inputs INN0–INN7 move the display between
 * the tabs, as the layout's "nav" says. */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const props = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'html') props[k === 'html' ? 'innerHTML' : k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  Object.assign(el, props);
  return el;
}

async function api(method, url, data) {
  const opts = { method, headers: {} };
  if (data !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(url, opts);
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  return json;
}

function toast(msg, kind = 'info', ms = 3200) {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const uid = () => 'e' + Math.random().toString(36).slice(2, 8);
const tid = () => 't' + Math.random().toString(36).slice(2, 8);

function slugify(name) {
  return String(name).normalize('NFKD')
    .replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae')
    .replace(/[^\x00-\x7f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'uten-navn';
}

function unitSuffix(unit) {
  if (!unit) return '';
  return unit === '%' || unit.startsWith('°') ? unit : ' ' + unit;
}

/* ------------------------------------------------------------------------ */
/* Element types                                                             */
/* ------------------------------------------------------------------------ */

const DEFAULT_FONT = 'Silkscreen-Regular';

const SVG = {
  text: '<path d="M5 6h14M12 6v13"/>',
  value: '<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/>',
  icon: '<path d="M12 4l2.4 5 5.6.8-4 3.9.9 5.5L12 16.6l-4.9 2.6.9-5.5-4-3.9 5.6-.8z"/>',
  line: '<path d="M5 19L19 5"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<circle cx="12" cy="12" r="7.5"/>',
  bar: '<rect x="3.5" y="8.5" width="17" height="7" rx="1"/><path d="M6.5 12h6" stroke-width="3"/>',
  graph: '<path d="M3 17l5-6 4 3 5-8 4 5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="1"/><circle cx="9" cy="10" r="1.5"/><path d="M5 18l5-5 3 3 2-2 4 4"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.6 6.6C3.8 8.3 2 12 2 12s3.5 6 10 6a10 10 0 0 0 4-.8"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${SVG[name]}</svg>`;

const TYPES = {
  text: { label: 'Tekst', defaults: { text: 'Tekst', font: DEFAULT_FONT, size: 8, align: 'left', spacing: 1 } },
  value: { label: 'Verdi', defaults: { source: 'cpu_temp', decimals: 1, prefix: '', suffix: '°C', font: DEFAULT_FONT, size: 8, align: 'left', spacing: 1 } },
  icon: { label: 'Ikon', defaults: { icon: 'thermometer', scale: 1 } },
  line: { label: 'Linje', defaults: { width: 1 } },
  rect: { label: 'Rektangel', defaults: { w: 32, h: 16, fill: false, radius: 0, width: 1 } },
  ellipse: { label: 'Sirkel', defaults: { w: 16, h: 16, fill: false, width: 1 } },
  bar: { label: 'Stolpe', defaults: { w: 60, h: 8, source: 'cpu_percent', min: 0, max: 100, border: true, vertical: false } },
  graph: { label: 'Graf', defaults: { w: 64, h: 24, source: 'cpu_percent', min: '', max: '', span: '', style: 'line', border: true } },
  image: { label: 'Bilde', defaults: { w: 32, h: 32, data: '', dither: true, threshold: 128, invert: false } },
};

const POS = [{ k: 'x', l: 'X', t: 'num' }, { k: 'y', l: 'Y', t: 'num' }];
const SIZE = [{ k: 'w', l: 'Bredde', t: 'num', min: 1 }, { k: 'h', l: 'Høyde', t: 'num', min: 1 }];
const FONT = [
  { k: 'font', l: 'Font', t: 'font', wide: true },
  { k: 'size', l: 'Størrelse (px)', t: 'num', min: 4, max: 128 },
  { k: 'align', l: 'Justering', t: 'select', opts: [['left', 'Venstre'], ['center', 'Midt'], ['right', 'Høyre']] },
];
const COLOR = [{
  k: 'color', l: 'Tegnemodus', t: 'select', num: true, wide: true,
  opts: [[1, 'Lys (piksler på)'], [0, 'Slukk (piksler av)'], [2, 'Inverter (XOR)']],
}];
const SOURCE = { k: 'source', l: 'Datakilde', t: 'source', wide: true };
// A bit (a boolean tag from the hub) shows 1 or 0, or the element's own texts for them.
const isBoolEl = (el) => {
  const s = state.sources.find((x) => x.name === el.source);
  return !!s && (s.type === 'boolean' || typeof s.value === 'boolean');
};
const DECIMALS = { k: 'decimals', l: 'Desimaler', t: 'num', min: 0, max: 6, empty: true, when: (el) => !isBoolEl(el) };
const BIT_TEXTS = [
  { k: 'true_text', l: 'Tekst når 1', t: 'text', placeholder: '1', when: isBoolEl },
  { k: 'false_text', l: 'Tekst når 0', t: 'text', placeholder: '0', when: isBoolEl },
];

const FIELDS = {
  text: [{ k: 'text', l: 'Tekst', t: 'textarea', wide: true }, { t: 'insert', wide: true }, ...POS, ...FONT,
    { k: 'spacing', l: 'Linjeavstand', t: 'num' }, ...COLOR],
  value: [SOURCE, ...BIT_TEXTS, DECIMALS,
    { k: 'prefix', l: 'Tekst foran', t: 'text' }, { k: 'suffix', l: 'Tekst etter', t: 'text' }, ...POS, ...FONT, ...COLOR],
  icon: [{ k: 'icon', l: 'Ikon', t: 'icon', wide: true }, ...POS, { k: 'scale', l: 'Skala', t: 'num', min: 1, max: 8 }, ...COLOR],
  line: [...POS, { k: 'x2', l: 'X2', t: 'num' }, { k: 'y2', l: 'Y2', t: 'num' },
    { k: 'width', l: 'Tykkelse', t: 'num', min: 1, max: 16 }, ...COLOR],
  rect: [...POS, ...SIZE, { k: 'width', l: 'Strektykkelse', t: 'num', min: 1 }, { k: 'radius', l: 'Hjørneradius', t: 'num', min: 0 },
    { k: 'fill', l: 'Fylt', t: 'check' }, ...COLOR],
  ellipse: [...POS, ...SIZE, { k: 'width', l: 'Strektykkelse', t: 'num', min: 1 }, { k: 'fill', l: 'Fylt', t: 'check' }, ...COLOR],
  bar: [SOURCE, { k: 'min', l: 'Min', t: 'num' }, { k: 'max', l: 'Maks', t: 'num' }, ...POS, ...SIZE,
    { k: 'border', l: 'Ramme', t: 'check' }, { k: 'vertical', l: 'Loddrett', t: 'check' }, ...COLOR],
  graph: [SOURCE, { k: 'min', l: 'Min', t: 'num', empty: true, placeholder: 'auto' },
    { k: 'max', l: 'Maks', t: 'num', empty: true, placeholder: 'auto' },
    { k: 'span', l: 'Tidsrom (sek)', t: 'num', min: 1, max: 3600, empty: true, placeholder: '= bredde' },
    { k: 'style', l: 'Stil', t: 'select', opts: [['line', 'Linje'], ['bars', 'Søyler'], ['dots', 'Punkter']] },
    ...POS, ...SIZE, { k: 'border', l: 'Ramme', t: 'check', wide: true }, ...COLOR],
  image: [{ t: 'image', wide: true }, ...POS, ...SIZE, { k: 'dither', l: 'Dithering', t: 'check' },
    { k: 'invert', l: 'Inverter', t: 'check' }, { k: 'threshold', l: 'Terskel (uten dithering)', t: 'num', min: 0, max: 255, wide: true }, ...COLOR],
};

const HELP = {
  text: 'Skriv <code>{kilde}</code> for å vise en verdi, f.eks. <code>{calc.kv_speed_rpm:.0f} rpm</code>, ' +
    '<code>{cpu_temp:.1f}°C</code> eller <code>{time}</code>.',
  value: 'Taggene fra huben heter det samme som i HMI-et. En bit viser 1 eller 0, eller tekstene du gir den. ' +
    'Mens PLS-en eller huben er borte, viser verdien <code>--</code>.',
  graph: 'Viser historikk (ett målepunkt per sekund, opptil 1 time).',
  image: 'Bildet lagres i layouten og gjøres om til svart/hvitt på Pi-en.',
};

/* Colour TFTs (ST7789): the OLED elements, each in its own colour, on a background colour. */

const FG = '#ffffff';
const BG = '#000000';
const SWATCHES = ['#ffffff', '#8a96a3', '#ff4d4d', '#ff9f1c', '#ffd23f', '#3ecf8e', '#2ec4f1', '#3e7bff', '#b36bff'];
const COLOR_DEFAULTS = {
  text: { font: 'DejaVuSans', size: 16 },
  value: { font: 'DejaVuSans', size: 16 },
  icon: { scale: 2 },
  rect: { w: 40, h: 24 },
  ellipse: { w: 24, h: 24 },
  bar: { w: 120, h: 12 },
  graph: { w: 120, h: 40 },
};
const COLOR_TYPES = Object.fromEntries(Object.entries(TYPES).map(([type, t]) =>
  [type, { ...t, defaults: { ...t.defaults, ...COLOR_DEFAULTS[type] } }]));
COLOR_TYPES.image.defaults = { w: 64, h: 64, data: '' };

const COLOR_PICK = { k: 'color', l: 'Farge', t: 'color', wide: true };
const COLOR_FIELDS = Object.fromEntries(Object.entries(FIELDS).map(([type, fields]) =>
  [type, fields.map((f) => (f === COLOR[0] ? COLOR_PICK : f))]));
COLOR_FIELDS.image = [{ t: 'image', wide: true }, ...POS, ...SIZE];
const COLOR_HELP = { ...HELP, image: 'Bildet lagres i layouten og vises i farger. Gjennomsiktige deler viser bakgrunnen.' };

/* Character LCDs (HD44780, e.g. 1602): positions and sizes are in character cells. */

const CHAR_TYPES = {
  text: { label: 'Tekst', defaults: { text: 'Tekst', w: '', align: 'left' } },
  value: { label: 'Verdi', defaults: { source: 'cpu_temp', decimals: 1, prefix: '', suffix: '°C', w: '', align: 'right' } },
  icon: { label: 'Ikon', defaults: { icon: 'thermometer' } },
  bar: { label: 'Stolpe', defaults: { w: 8, source: 'cpu_percent', min: 0, max: 100 } },
  graph: { label: 'Graf', defaults: { w: 6, h: 1, source: 'cpu_percent', min: '', max: '', span: '', style: 'bars' } },
};

const CELL_POS = [{ k: 'x', l: 'Kolonne', t: 'num', min: 0 }, { k: 'y', l: 'Rad', t: 'num', min: 0 }];
const CELL_FIELD = [
  { k: 'w', l: 'Feltbredde (tegn)', t: 'num', min: 1, max: 40, empty: true, placeholder: 'auto' },
  { k: 'align', l: 'Justering i feltet', t: 'select', opts: [['left', 'Venstre'], ['center', 'Midt'], ['right', 'Høyre']] },
];
const CELL_W = { k: 'w', l: 'Bredde (tegn)', t: 'num', min: 1, max: 40 };

const CHAR_FIELDS = {
  text: [{ k: 'text', l: 'Tekst', t: 'textarea', wide: true }, { t: 'insert', wide: true }, ...CELL_POS, ...CELL_FIELD],
  value: [SOURCE, ...BIT_TEXTS, DECIMALS,
    { k: 'prefix', l: 'Tekst foran', t: 'text' }, { k: 'suffix', l: 'Tekst etter', t: 'text' }, ...CELL_POS, ...CELL_FIELD],
  icon: [{ k: 'icon', l: 'Ikon', t: 'icon', wide: true }, ...CELL_POS],
  bar: [SOURCE, { k: 'min', l: 'Min', t: 'num' }, { k: 'max', l: 'Maks', t: 'num' }, ...CELL_POS, CELL_W],
  graph: [SOURCE, { k: 'min', l: 'Min', t: 'num', empty: true, placeholder: 'auto' },
    { k: 'max', l: 'Maks', t: 'num', empty: true, placeholder: 'auto' },
    { k: 'span', l: 'Tidsrom (sek)', t: 'num', min: 1, max: 3600, empty: true, placeholder: '= 5 × bredde' },
    { k: 'style', l: 'Stil', t: 'select', opts: [['bars', 'Søyler'], ['line', 'Linje'], ['dots', 'Punkter']] },
    ...CELL_POS, CELL_W, { k: 'h', l: 'Høyde (rader)', t: 'num', min: 1, max: 4 }],
};

const SLOTS_NOTE = 'LCD-et har bare plass til 8 egne tegn om gangen, og ikoner, æ/ø/å, stolper og grafer deler på dem.';
const CHAR_HELP = {
  text: 'Skriv <code>{kilde}</code> for å vise en verdi, f.eks. <code>{calc.kv_speed_rpm:.0f}</code>. ' +
    'Gi teksten en feltbredde for å justere den. Æ, ø og å lages som egne tegn. ' + SLOTS_NOTE,
  value: 'Sett en feltbredde, så står tallet stille når antall siffer endres. En bit viser 1 eller 0, ' +
    'eller tekstene du gir den, og <code>--</code> mens PLS-en eller huben er borte.',
  icon: 'Hvert ikon bruker ett eget tegn (piler, grader og blokk er gratis). ' + SLOTS_NOTE,
  bar: 'Fylles i 5 steg per tegn, og bruker ett eget tegn.',
  graph: 'Hver rute i grafen bruker ett eget tegn. ' + SLOTS_NOTE,
};

/* The board's inputs INN0–INN7: what each one does with the tabs (the layout's "nav"). */
const NAV_ACTIONS = { next: 'Neste fane', prev: 'Forrige fane', goto: 'Gå til fanen', hold: 'Vis fanen mens den er på' };
const NAV_TAB = { goto: true, hold: true }; // the actions that name a tab

function elLabel(el) {
  switch (el.type) {
    case 'text': return (el.text || '').split('\n')[0] || '(tom tekst)';
    case 'value': return `${el.prefix || ''}{${el.source}}${el.suffix || ''}`;
    case 'icon': return `Ikon: ${el.icon}`;
    case 'bar':
    case 'graph': return `${TYPES[el.type].label}: ${el.source}`;
    default: return TYPES[el.type]?.label || el.type;
  }
}

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

const THEMES = {
  white: { name: 'Hvit OLED', top: '#eaf2ff', bottom: '#eaf2ff', split: 0 },
  blue: { name: 'Blå OLED', top: '#55c8ff', bottom: '#55c8ff', split: 0 },
  yellowblue: { name: 'Gul/blå OLED', top: '#ffd23f', bottom: '#55c8ff', split: 16 },
};
const LCD_THEMES = {
  green: { name: 'Grønn LCD', bg: '#97bf3a', off: '#8db336', on: '#1e2d0d', dark: ['#3a4719', '#36421a', '#1a220b'] },
  blue: { name: 'Blå LCD', bg: '#1f4fd6', off: '#2a5ae3', on: '#eef4ff', dark: ['#0c1a45', '#0f1f50', '#2c3c6c'] },
};
const CELL = { w: 6, h: 9, pad: 3 }; // LCD dots per character incl. the gap, and the glass border
const MARGIN = 10; // canvas px around the screen so edge handles stay visible and grabbable
const PIXEL_OFF = '#05070a';
const GRID_LINE = '#141a21';
const GRID_MAJOR = '#1d2630';

const prefs = { zoom: 0, grid: true, theme: 'white', lcdTheme: 'green', displayId: null, ...store.get('oled.prefs', {}) };

const state = {
  meta: null,
  sources: [],
  layout: null,
  tab: 0, // the tab being edited
  slug: null,
  savedJson: null,
  selected: null,
  hover: null,
  boxes: {},
  warnings: {},
  bits: null,
  bitsKey: null,
  undo: [],
  redo: [],
  clipboard: null,
  drag: null,
  live: null,
  inputs: null,
};

const canvas = $('#screen');
const ctx = canvas.getContext('2d');

const newTab = (name) => ({ id: tid(), name, elements: [] });
const newLayout = (d) => {
  const size = { width: d?.width ?? 128, height: d?.height ?? 64, refresh: 1 };
  const tabs = { tabs: [newTab('Fane 1')], nav: [] };
  if (d?.kind === 'char') return { name: 'Ny layout', kind: 'char', ...size, ...tabs };
  if (d?.kind === 'color') return { name: 'Ny layout', kind: 'color', ...size, background: BG, ...tabs };
  return { name: 'Ny layout', ...size, invert: false, ...tabs };
};
const kindOf = (x) => (['char', 'color'].includes(x?.kind) ? x.kind : 'pixel');
const isChar = (L = state.layout) => kindOf(L) === 'char';
const isColor = (L = state.layout) => kindOf(L) === 'color';
const types = () => (isChar() ? CHAR_TYPES : isColor() ? COLOR_TYPES : TYPES);
const defaultInk = () => (isColor() ? FG : 1);
const sizeLabel = (x) => `${x.width}×${x.height}${{ char: ' tegn', color: ' farge' }[kindOf(x)] || ''}`;
const layoutKey = (x) => `${kindOf(x)}:${x.width}x${x.height}`;
const fits = (d, L) => layoutKey(d) === layoutKey(L);
const curTab = () => state.layout.tabs[state.tab];
const els = () => curTab().elements;
const tabName = (t, i) => (t.name || '').trim() || `Fane ${i + 1}`;
const tabIndex = (id) => state.layout.tabs.findIndex((t) => t.id === id);
const selectedEl = () => els().find((e) => e.id === state.selected) || null;
const currentDisplay = () => state.meta?.displays.find((d) => d.id === prefs.displayId) || state.meta?.displays[0] || null;
const snapshot = () => JSON.stringify(state.layout);
const undoEntry = () => ({ json: snapshot(), tab: state.tab }); // undo shows the tab the change was made on
const isDirty = () => snapshot() !== state.savedJson;
const savePrefs = () => store.set('oled.prefs', prefs);

/* --- undo / redo ---------------------------------------------------------- */

let lastCheckpoint = { key: null, t: 0 };

// Called before every mutation. Repeated edits with the same key (typing in one
// field, nudging with arrows) within a short window collapse into one step.
function checkpoint(key = null) {
  const now = Date.now();
  if (key && key === lastCheckpoint.key && now - lastCheckpoint.t < 1500) {
    lastCheckpoint.t = now;
    return;
  }
  lastCheckpoint = { key, t: now };
  state.undo.push(undoEntry());
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
}

function restore(entry) {
  state.layout = JSON.parse(entry.json);
  state.tab = clamp(entry.tab, 0, state.layout.tabs.length - 1);
  lastCheckpoint = { key: null, t: 0 };
  if (!selectedEl()) state.selected = null;
  renderAll();
  changed();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(undoEntry());
  restore(state.undo.pop());
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(undoEntry());
  restore(state.redo.pop());
}

/* --- change propagation --------------------------------------------------- */

let draftTimer = null;

function changed({ list = true } = {}) {
  updateDirty();
  if (list) renderElementList();
  requestRender();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
  $('#btn-undo').disabled = !state.undo.length;
  $('#btn-redo').disabled = !state.redo.length;
}

function saveDraft() {
  store.set('oled.draft', { layout: state.layout, tab: state.tab, slug: state.slug, dirty: isDirty() });
}

function updateDirty() {
  $('#dirty-dot').hidden = !isDirty();
}

// Layouts from before tabs have their elements at the top level: they become one tab.
function setLayout(layout, { slug = null, saved = true, tab = 0 } = {}) {
  const fallback = { char: { kind: 'char', width: 16, height: 2 }, color: { kind: 'color', width: 284, height: 76 } };
  const tabs = Array.isArray(layout.tabs) && layout.tabs.length ? layout.tabs : [{ name: '', elements: layout.elements }];
  state.layout = { ...newLayout(fallback[kindOf(layout)]), ...layout };
  delete state.layout.elements;
  state.layout.tabs = tabs.map((t) => ({
    id: t.id || tid(),
    name: t.name || '',
    elements: (t.elements || []).map((e) => ({ id: uid(), color: defaultInk(), ...e })),
  }));
  const ids = new Set(state.layout.tabs.map((t) => t.id));
  state.layout.nav = (Array.isArray(layout.nav) ? layout.nav : []).filter((b) => NAV_ACTIONS[b?.action] &&
    Number.isInteger(b.input) && (!NAV_TAB[b.action] || ids.has(b.tab)));
  state.tab = clamp(Number(tab) || 0, 0, state.layout.tabs.length - 1);
  state.slug = slug;
  state.savedJson = saved ? snapshot() : null;
  state.selected = null;
  state.undo = [];
  state.redo = [];
  state.bits = null;
  state.boxes = {};
  renderAll();
  changed();
}

function updateEl(el, key, value) {
  checkpoint(`prop:${el.id}:${key}`);
  el[key] = value;
  changed();
}

/* ------------------------------------------------------------------------ */
/* Server rendering                                                          */
/* ------------------------------------------------------------------------ */

let renderBusy = false;
let renderAgain = false;

function requestRender() {
  if (renderBusy) { renderAgain = true; return; }
  doRender();
}

// The tab being edited, with the other tabs' elements left out: the server only needs their names.
function renderBody() {
  const L = state.layout;
  return { ...L, nav: undefined, tabs: L.tabs.map((t, i) => (i === state.tab ? t : { ...t, elements: [] })) };
}

const renderKey = () => `${layoutKey(state.layout)}#${curTab().id}`;

async function doRender() {
  renderBusy = true;
  renderAgain = false;
  try {
    const key = renderKey();
    const color = isColor();
    const res = await api('POST', `/api/render?tab=${state.tab}`, renderBody());
    if (key !== renderKey()) { renderAgain = true; return; } // another tab (or size) by now: render that
    const bits = await decodePng(res.png);
    state.bits = color ? bits.rgba : bits.data;
    state.bitsKey = key;
    // While moving/resizing, the locally computed box is newer than the server's.
    const d = state.drag;
    const localBox = d?.moved && ['move', 'se', 'e'].includes(d.mode) ? state.boxes[d.id] : null;
    state.boxes = res.boxes;
    if (localBox) state.boxes[d.id] = localBox;
    if (JSON.stringify(res.warnings) !== JSON.stringify(state.warnings)) {
      state.warnings = res.warnings;
      renderWarnings();
      renderElementList();
    }
    draw();
  } catch (e) {
    console.error(e);
  } finally {
    renderBusy = false;
    if (renderAgain) doRender();
  }
}

async function decodePng(b64) {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, c.width, c.height).data;
  const data = new Uint8Array(c.width * c.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4] > 127 ? 1 : 0;
  return { data, rgba: px, width: c.width, height: c.height };
}

const hasDynamic = () => els().some((e) =>
  ['value', 'bar', 'graph'].includes(e.type) || (e.type === 'text' && /\{[^}]+\}/.test(e.text || '')));

/* ------------------------------------------------------------------------ */
/* Drawing                                                                   */
/* ------------------------------------------------------------------------ */

function paintPixels(cx, bits, W, H, z, grid) {
  const theme = THEMES[prefs.theme] || THEMES.white;
  const gap = grid && z >= 4 ? 1 : 0;
  cx.fillStyle = gap ? GRID_LINE : PIXEL_OFF;
  cx.fillRect(0, 0, W * z, H * z);
  if (gap) {
    // brighter lines every 8 px (the controller's memory pages) make counting easier
    cx.fillStyle = GRID_MAJOR;
    for (let x = 8; x < W; x += 8) cx.fillRect(x * z - 1, 0, 1, H * z);
    for (let y = 8; y < H; y += 8) cx.fillRect(0, y * z - 1, W * z, 1);
    cx.fillStyle = PIXEL_OFF;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!bits || !bits[y * W + x]) cx.fillRect(x * z, y * z, z - gap, z - gap);
      }
    }
  }
  if (!bits) return;
  for (let y = 0; y < H; y++) {
    cx.fillStyle = y < theme.split ? theme.top : theme.bottom;
    for (let x = 0; x < W; x++) {
      if (bits[y * W + x]) cx.fillRect(x * z, y * z, z - gap, z - gap);
    }
  }
}

// Colour TFT: the server's RGB image scaled up without smoothing, with an optional pixel grid.
function paintColor(cx, rgba, W, H, z, grid) {
  cx.fillStyle = PIXEL_OFF;
  cx.fillRect(0, 0, W * z, H * z);
  if (rgba) {
    const src = h('canvas', { width: W, height: H });
    src.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
    cx.imageSmoothingEnabled = false;
    cx.drawImage(src, 0, 0, W * z, H * z);
  }
  if (grid && z >= 4) {
    cx.fillStyle = 'rgba(0, 0, 0, .35)';
    for (let x = 1; x < W; x++) cx.fillRect(x * z - 1, 0, 1, H * z);
    for (let y = 1; y < H; y++) cx.fillRect(0, y * z - 1, W * z, 1);
  }
}

// LCD dots for a character layout: 5×8 per cell with a gap, the unlit dots faintly visible.
function paintLcd(cx, bits, cols, rows, z, { dots = true, lit = true } = {}) {
  const t = LCD_THEMES[prefs.lcdTheme] || LCD_THEMES.green;
  const [bg, off, on] = lit ? [t.bg, t.off, t.on] : t.dark;
  const g = geom({ kind: 'char', width: cols, height: rows });
  cx.fillStyle = bg;
  cx.fillRect(0, 0, g.W * z, g.H * z);
  const gap = z >= 4 ? 1 : 0;
  const bw = cols * 5;
  for (const pass of dots ? [0, 1] : [1]) {
    cx.fillStyle = pass ? on : off;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 5; x++) {
            const v = bits ? bits[(r * 8 + y) * bw + c * 5 + x] : 0;
            if (pass ? !v : v) continue;
            cx.fillRect((g.ox + c * CELL.w + x) * z, (g.oy + r * CELL.h + y) * z, z - gap, z - gap);
          }
        }
      }
    }
  }
}

// Layout units -> canvas dots. OLED: one unit is one pixel. Character LCD: one
// unit is a character cell, drawn as 5×8 dots plus a gap, inside a glass border.
function geom(L = state.layout) {
  if (!isChar(L)) return { ux: 1, uy: 1, ox: 0, oy: 0, W: L.width, H: L.height };
  return {
    ux: CELL.w, uy: CELL.h, ox: CELL.pad, oy: CELL.pad,
    W: L.width * CELL.w - 1 + 2 * CELL.pad, H: L.height * CELL.h - 1 + 2 * CELL.pad,
  };
}

// Character cells end with a gap dot; leave it out so outlines hug the glyphs.
function toDots(x, y, g = geom()) {
  const t = isChar() ? 0.5 : 0;
  return [g.ox + x * g.ux - t, g.oy + y * g.uy - t];
}

function handlesFor(el) {
  if (isChar()) {
    const b = state.boxes[el.id];
    if (el.type === 'graph') return [{ name: 'se', x: el.x + el.w, y: el.y + el.h }];
    if (['text', 'value', 'bar'].includes(el.type) && b) return [{ name: 'e', x: b[2], y: (b[1] + b[3]) / 2 }];
    return [];
  }
  if (el.type === 'line') return [{ name: 'p1', x: el.x + 0.5, y: el.y + 0.5 }, { name: 'p2', x: el.x2 + 0.5, y: el.y2 + 0.5 }];
  if ('w' in el && 'h' in el) return [{ name: 'se', x: el.x + el.w, y: el.y + el.h }];
  return [];
}

function draw() {
  const L = state.layout;
  const z = prefs.zoom;
  const g = geom();
  const cw = g.W * z + 2 * MARGIN;
  const ch = g.H * z + 2 * MARGIN;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.translate(MARGIN, MARGIN);
  const bits = state.bitsKey === renderKey() ? state.bits : null;
  if (isChar()) paintLcd(ctx, bits, L.width, L.height, z, { dots: prefs.grid });
  else if (isColor()) paintColor(ctx, bits, L.width, L.height, z, prefs.grid);
  else paintPixels(ctx, bits, L.width, L.height, z, prefs.grid);

  const strokeBox = (b, color, dash) => {
    const [x0, y0] = toDots(b[0], b[1], g);
    const [x1, y1] = toDots(b[2], b[3], g);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.strokeRect(x0 * z - 1.5, y0 * z - 1.5, (x1 - x0) * z + 2, (y1 - y0) * z + 2);
    ctx.restore();
  };
  if (state.hover && state.hover !== state.selected && state.boxes[state.hover]) {
    strokeBox(state.boxes[state.hover], 'rgba(120, 190, 255, .6)', [3, 3]);
  }
  const el = selectedEl();
  if (el && state.boxes[el.id]) {
    strokeBox(state.boxes[el.id], '#3ea6ff', []);
    for (const hd of handlesFor(el)) {
      const [hx, hy] = toDots(hd.x, hd.y, g);
      ctx.fillStyle = '#3ea6ff';
      ctx.fillRect(hx * z - 4, hy * z - 4, 8, 8);
      ctx.strokeStyle = '#05070a';
      ctx.strokeRect(hx * z - 3.5, hy * z - 3.5, 7, 7);
    }
  }
  ctx.restore();
}

function setZoom(z) {
  prefs.zoom = clamp(Math.round(z), 1, 14);
  $('#zoom-label').textContent = `${prefs.zoom}×`;
  savePrefs();
  draw();
}

function fitZoom() {
  const wrap = $('#canvas-wrap');
  const avail = Math.max(wrap.clientWidth - 90, 128);
  setZoom(clamp(Math.floor(avail / geom().W), 2, 8));
}

/* ------------------------------------------------------------------------ */
/* Canvas interaction                                                        */
/* ------------------------------------------------------------------------ */

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  const css = r.width / canvas.width; // the canvas may be scaled down by CSS on narrow screens
  const scale = prefs.zoom * css; // screen px per dot, for handle hit-testing
  const dx = (e.clientX - r.left - MARGIN * css) / scale;
  const dy = (e.clientY - r.top - MARGIN * css) / scale;
  const g = geom();
  return { x: (dx - g.ox) / g.ux, y: (dy - g.oy) / g.uy, dx, dy, scale };
}

function hitHandle(p) {
  const el = selectedEl();
  if (!el) return null;
  const tol = 7 / p.scale;
  return handlesFor(el).find((hd) => {
    const [hx, hy] = toDots(hd.x, hd.y);
    return Math.abs(hx - p.dx) <= tol && Math.abs(hy - p.dy) <= tol;
  }) || null;
}

// The smallest element under the cursor wins, so small items inside frames stay clickable.
function hitElement(p) {
  let best = null;
  let bestArea = Infinity;
  const tol = isChar() ? 0 : 0.5;
  for (const el of [...els()].reverse()) {
    const b = state.boxes[el.id];
    if (!b || el.hidden) continue;
    if (p.x >= b[0] - tol && p.x < b[2] + tol && p.y >= b[1] - tol && p.y < b[3] + tol) {
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      if (area < bestArea) { best = el; bestArea = area; }
    }
  }
  return best;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = canvasPoint(e);
  const handle = hitHandle(p);
  const el = handle ? selectedEl() : hitElement(p);
  if (!el) { select(null); return; }
  if (el.id !== state.selected) select(el.id);
  canvas.setPointerCapture(e.pointerId);
  state.drag = {
    id: el.id,
    mode: handle ? handle.name : 'move',
    start: p,
    orig: structuredClone(el),
    origBox: state.boxes[el.id] ? [...state.boxes[el.id]] : null,
    moved: false,
  };
});

canvas.addEventListener('pointermove', (e) => {
  const p = canvasPoint(e);
  $('#coords').textContent = isChar() ? `kolonne ${Math.floor(p.x)}, rad ${Math.floor(p.y)}` : `x ${Math.floor(p.x)}, y ${Math.floor(p.y)}`;
  const d = state.drag;
  if (!d) {
    const handle = hitHandle(p);
    const el = handle ? null : hitElement(p);
    const cursors = { se: 'nwse-resize', e: 'ew-resize' };
    canvas.style.cursor = handle ? (cursors[handle.name] || 'crosshair') : el ? 'move' : 'default';
    const hover = el?.id || null;
    if (hover !== state.hover) { state.hover = hover; draw(); }
    return;
  }
  const el = selectedEl();
  if (!el) return;
  const dx = Math.round(p.x - d.start.x);
  const dy = Math.round(p.y - d.start.y);
  if (!d.moved && !dx && !dy) return;
  if (!d.moved) { checkpoint(); d.moved = true; }
  const o = d.orig;
  if (d.mode === 'move') {
    el.x = o.x + dx;
    el.y = o.y + dy;
    if (el.type === 'line') { el.x2 = o.x2 + dx; el.y2 = o.y2 + dy; }
    keepOnScreen(el);
    if (d.origBox) state.boxes[el.id] = d.origBox.map((v, i) => v + (i % 2 ? el.y - o.y : el.x - o.x));
  } else if (d.mode === 'se') {
    el.w = Math.max(1, o.w + dx);
    el.h = Math.max(1, o.h + dy);
    if (e.shiftKey && o.w && o.h) el.h = Math.max(1, Math.round(el.w * o.h / o.w));
    state.boxes[el.id] = [el.x, el.y, el.x + el.w, el.y + el.h];
  } else if (d.mode === 'e') {
    // an auto-width text field starts from its current length
    el.w = Math.max(1, (Number(o.w) || (d.origBox ? d.origBox[2] - d.origBox[0] : 1)) + dx);
    if (d.origBox) state.boxes[el.id] = [d.origBox[0], d.origBox[1], el.x + el.w, d.origBox[3]];
  } else if (d.mode === 'p1') {
    el.x = o.x + dx;
    el.y = o.y + dy;
  } else if (d.mode === 'p2') {
    el.x2 = o.x2 + dx;
    el.y2 = o.y2 + dy;
  }
  syncProps();
  draw();
  requestRender();
});

function endDrag() {
  if (state.drag?.moved) changed({ list: false });
  state.drag = null;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (!state.drag && state.hover) { state.hover = null; draw(); }
  $('#coords').textContent = '';
});
canvas.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(prefs.zoom + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

/* ------------------------------------------------------------------------ */
/* Element operations                                                        */
/* ------------------------------------------------------------------------ */

// A character placed outside an LCD is simply lost, so keep elements on the grid.
function keepOnScreen(el) {
  if (!isChar()) return;
  el.x = clamp(el.x, 0, state.layout.width - 1);
  el.y = clamp(el.y, 0, state.layout.height - 1);
}

function select(id) {
  state.selected = id;
  renderProps();
  renderElementList();
  draw();
}

function addElement(type, extra = {}) {
  const L = state.layout;
  const el = { id: uid(), type, color: defaultInk(), ...structuredClone(types()[type].defaults), ...extra };
  if (el.font && !state.meta.fonts.some((f) => f.id === el.font)) el.font = DEFAULT_FONT;
  if (el.x == null) {
    const n = els().length;
    if (isChar()) {
      el.x = 0;
      el.y = n % L.height;
    } else if (type === 'line') {
      el.x = Math.round(L.width / 2 - 15);
      el.y = Math.round(L.height / 2);
      el.x2 = el.x + 30;
      el.y2 = el.y;
    } else if ('w' in el) {
      el.x = Math.max(0, Math.round((L.width - el.w) / 2));
      el.y = Math.max(0, Math.round((L.height - el.h) / 2));
    } else {
      // stagger text/icons so new ones don't land exactly on top of each other
      el.x = 4 + (n * 6) % Math.max(L.width - 40, 8);
      el.y = 4 + (n * 10) % Math.max(L.height - 12, 8);
    }
  }
  checkpoint();
  els().push(el);
  state.selected = el.id;
  renderProps();
  changed();
  return el;
}

function removeSelected() {
  const el = selectedEl();
  if (!el) return;
  checkpoint();
  curTab().elements = els().filter((e) => e !== el);
  state.selected = null;
  renderProps();
  changed();
}

function duplicate(el = selectedEl(), offset = 4) {
  if (!el) return;
  if (isChar()) offset = 1;
  const copy = { ...structuredClone(el), id: uid(), x: el.x + offset, y: el.y + offset };
  if (el.type === 'line') { copy.x2 = el.x2 + offset; copy.y2 = el.y2 + offset; }
  keepOnScreen(copy);
  checkpoint();
  els().push(copy);
  state.selected = copy.id;
  renderProps();
  changed();
}

function moveLayer(el, dir) {
  const list = els();
  const i = list.indexOf(el);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  checkpoint();
  [list[i], list[j]] = [list[j], list[i]];
  changed();
}

function nudge(dx, dy) {
  const el = selectedEl();
  if (!el) return;
  checkpoint(`nudge:${el.id}`);
  const [x0, y0] = [el.x, el.y];
  el.x += dx;
  el.y += dy;
  if (el.type === 'line') { el.x2 += dx; el.y2 += dy; }
  keepOnScreen(el);
  const [mx, my] = [el.x - x0, el.y - y0];
  const b = state.boxes[el.id];
  if (b) state.boxes[el.id] = [b[0] + mx, b[1] + my, b[2] + mx, b[3] + my];
  syncProps();
  draw();
  changed({ list: false });
}

function addFromSource(s) {
  const isNum = typeof s.value === 'number';
  addElement('value', {
    source: s.name,
    decimals: isNum ? (Number.isInteger(s.value) ? 0 : 1) : '',  // a bit (boolean) has none
    prefix: '',
    suffix: unitSuffix(s.unit),
  });
}

/* ------------------------------------------------------------------------ */
/* Panels                                                                    */
/* ------------------------------------------------------------------------ */

function renderTools() {
  const tools = $('#tools');
  tools.replaceChildren(...Object.entries(types()).map(([type, t]) =>
    h('button', { class: 'tool', type: 'button', title: `Legg til ${t.label.toLowerCase()}`, onclick: () => addElement(type) },
      h('span', { html: svg(type) }), t.label)));
}

function renderLayoutControls() {
  const L = state.layout;
  $('#layout-name').value = L.name || '';
  const sizeSel = $('#layout-size');
  const key = `${L.width}x${L.height}`;
  const sizes = (isChar() ? state.meta.char_sizes : isColor() ? state.meta.color_sizes : state.meta.sizes)
    .map(([w, hh]) => `${w}x${hh}`);
  if (!sizes.includes(key)) sizes.push(key);
  sizeSel.replaceChildren(...sizes.map((s) => h('option', { value: s }, s.replace('x', '×'))));
  sizeSel.value = key;
  sizeSel.previousElementSibling.textContent = isChar() ? 'Størrelse (tegn)' : 'Størrelse';
  $('#layout-refresh').value = L.refresh ?? 1;
  $('#layout-invert').checked = !!L.invert;
  $('#layout-invert').closest('label').hidden = isChar() || isColor(); // only an OLED inverts
  $('#bg-field').hidden = !isColor();
  $('#layout-bg').value = L.background || BG;
  renderThemes();
  checkMismatch();
}

function renderThemes() {
  const themes = isChar() ? LCD_THEMES : THEMES;
  const sel = $('#theme-select');
  sel.hidden = isColor(); // a TFT shows its real colours
  if (isColor()) return;
  sel.replaceChildren(...Object.entries(themes).map(([k, t]) => h('option', { value: k }, t.name)));
  sel.value = isChar() ? prefs.lcdTheme : prefs.theme;
}

function renderElementList() {
  const list = $('#element-list');
  const items = els();
  $('#element-count').textContent = items.length ? `(${items.length})` : '';
  if (!items.length) {
    list.replaceChildren(h('li', { class: 'empty' }, 'Ingen elementer på denne fanen ennå – legg til fra knappene over.'));
    return;
  }
  // topmost first, like layers in a drawing program
  list.replaceChildren(...[...items].reverse().map((el) => {
    const cls = [el.id === state.selected && 'selected', el.hidden && 'is-hidden', state.warnings[el.id] && 'has-warning']
      .filter(Boolean).join(' ');
    return h('li', { class: cls, title: state.warnings[el.id] || '', onclick: () => select(el.id) },
      h('span', { html: svg(el.type) }),
      h('span', { class: 'el-label' }, elLabel(el)),
      h('button', {
        class: 'icon-btn', type: 'button', title: el.hidden ? 'Vis' : 'Skjul', html: svg(el.hidden ? 'eyeOff' : 'eye'),
        onclick: (e) => { e.stopPropagation(); updateEl(el, 'hidden', !el.hidden); },
      }));
  }));
}

function renderWarnings() {
  const box = $('#warnings');
  box.replaceChildren(...Object.entries(state.warnings).map(([id, msg]) => {
    const el = els().find((e) => e.id === id);
    return h('div', {}, `${el ? elLabel(el) : id}: ${msg}`);
  }));
}

function sourceOptions(current) {
  const groups = new Map();
  for (const s of state.sources) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const opts = [];
  if (current && !state.sources.some((s) => s.name === current)) {
    opts.push(h('option', { value: current }, `${current} (ikke tilgjengelig nå)`));
  }
  for (const [group, items] of groups) {
    opts.push(h('optgroup', { label: group },
      items.map((s) => h('option', { value: s.name }, s.label && s.label !== s.name ? `${s.label} – ${s.name}` : s.name))));
  }
  return opts;
}

function iconCanvas(rows) {
  const c = h('canvas', { width: rows[0].length, height: rows.length });
  const cx = c.getContext('2d');
  cx.fillStyle = '#d8dfe8';
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') cx.fillRect(x, y, 1, 1); }));
  return c;
}

function fieldRow(f, el) {
  const id = `f-${f.k || f.t}`;
  let input;
  const set = (v) => updateEl(el, f.k, v);
  switch (f.t) {
    case 'num':
      input = h('input', {
        id, type: 'number', step: 1, min: f.min, max: f.max, placeholder: f.placeholder, value: el[f.k] ?? '',
        oninput: () => {
          if (input.value === '') { if (f.empty) set(''); return; }
          const n = Number(input.value);
          if (Number.isFinite(n)) set(n);
        },
      });
      break;
    case 'text':
      input = h('input', { id, type: 'text', placeholder: f.placeholder, value: el[f.k] ?? '', oninput: () => set(input.value) });
      break;
    case 'textarea':
      input = h('textarea', { id, rows: 2, spellcheck: 'false', value: el[f.k] ?? '', oninput: () => set(input.value) });
      break;
    case 'color': {
      input = h('input', { id, type: 'color', value: /^#[0-9a-f]{6}$/i.test(el[f.k]) ? el[f.k] : FG, oninput: () => set(input.value) });
      input.dataset.key = f.k;
      const swatches = SWATCHES.map((c) => h('button', {
        type: 'button', class: 'swatch', style: `background:${c}`, title: c, 'aria-label': c,
        onclick: () => { input.value = c; set(c); },
      }));
      return h('div', { class: 'field wide' }, h('span', {}, f.l), h('div', { class: 'color-row' }, input, ...swatches));
    }
    case 'check':
      input = h('input', { id, type: 'checkbox', checked: !!el[f.k], onchange: () => set(input.checked) });
      input.dataset.key = f.k;
      return h('label', { class: `field check${f.wide ? ' wide' : ''}`, for: id }, input, h('span', {}, f.l));
    case 'select':
      input = h('select', { id, onchange: () => set(f.num ? Number(input.value) : input.value) },
        f.opts.map(([v, label]) => h('option', { value: v }, label)));
      input.value = el[f.k] ?? f.opts[0][0];
      break;
    case 'font':
      input = h('select', {
        id,
        onchange: () => {
          // pixel fonts only look right at their design sizes, so snap to one
          checkpoint();
          el.font = input.value;
          const font = state.meta.fonts.find((x) => x.id === input.value);
          if (font?.sizes.length && !font.sizes.includes(el.size)) el.size = font.sizes[0];
          syncProps();
          changed();
        },
      }, state.meta.fonts.map((font) =>
        h('option', { value: font.id }, font.name + (font.sizes.length ? ` (${font.sizes.join('/')} px)` : ''))));
      input.value = el.font || DEFAULT_FONT;
      break;
    case 'source':
      input = h('select', {
        id,
        onchange: () => {
          // keep the unit suffix in step with the source, unless the user customised it
          const old = state.sources.find((s) => s.name === el.source);
          const neu = state.sources.find((s) => s.name === input.value);
          checkpoint();
          if (el.type === 'value' && old && neu && el.suffix === unitSuffix(old.unit)) el.suffix = unitSuffix(neu.unit);
          el.source = input.value;
          renderProps();
          changed();
        },
      }, sourceOptions(el.source));
      input.value = el.source;
      break;
    case 'insert': {
      const sel = h('select', {
        id,
        onchange: () => {
          const ta = $('#f-text');
          const tok = `{${sel.value}}`;
          const pos = ta.selectionStart ?? ta.value.length;
          ta.value = ta.value.slice(0, pos) + tok + ta.value.slice(ta.selectionEnd ?? pos);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos + tok.length;
          updateEl(el, 'text', ta.value);
          sel.value = '';
        },
      }, h('option', { value: '' }, 'Sett inn verdi …'), sourceOptions());
      return h('div', { class: 'field wide' }, sel);
    }
    case 'icon':
      input = h('div', { class: 'icon-grid' }, (isChar() ? state.meta.lcd_icons : state.meta.icons).map(({ name, rows }) =>
        h('button', {
          type: 'button', title: `${name} (${rows[0].length}×${rows.length})`, class: name === el.icon ? 'selected' : '',
          onclick: (e) => {
            set(name);
            for (const b of e.currentTarget.parentNode.children) b.classList.toggle('selected', b === e.currentTarget);
          },
        }, iconCanvas(rows))));
      return h('div', { class: 'field wide' }, h('span', {}, f.l), input);
    case 'image': {
      const file = h('input', {
        type: 'file', accept: 'image/*', hidden: true,
        onchange: async () => {
          if (!file.files[0]) return;
          try {
            const img = await loadImageFile(file.files[0]);
            checkpoint();
            Object.assign(el, img);
            renderProps();
            changed();
          } catch (err) {
            toast(`Kunne ikke lese bildet: ${err.message}`, 'error');
          }
        },
      });
      return h('div', { class: 'field wide image-field' },
        h('button', { type: 'button', onclick: () => file.click() }, el.data ? 'Bytt bilde …' : 'Velg bilde …'), file);
    }
    default:
      return null;
  }
  input.dataset.key = f.k;
  return h('label', { class: `field${f.wide ? ' wide' : ''}`, for: id }, h('span', {}, f.l), input);
}

function renderProps() {
  const box = $('#props');
  const el = selectedEl();
  if (!el) {
    box.replaceChildren(h('p', { class: 'hint' }, 'Velg et element på skjermen eller i listen – eller legg til et nytt.'));
    return;
  }
  const btn = (icon, title, fn, extra = '') =>
    h('button', { type: 'button', class: `icon-btn ${extra}`, title, 'aria-label': title, html: svg(icon), onclick: fn });
  const [fields, help] = isChar() ? [CHAR_FIELDS, CHAR_HELP] : isColor() ? [COLOR_FIELDS, COLOR_HELP] : [FIELDS, HELP];
  box.replaceChildren(
    h('div', { class: 'props-head' },
      h('div', { class: 'props-title' }, h('span', { html: svg(el.type) }), types()[el.type]?.label || el.type),
      h('div', { class: 'props-actions' },
        btn('up', 'Flytt fremover', () => moveLayer(el, 1)),
        btn('down', 'Flytt bakover', () => moveLayer(el, -1)),
        btn('copy', 'Dupliser (Ctrl+D)', () => duplicate(el)),
        btn('trash', 'Slett (Del)', removeSelected, 'danger'))),
    h('div', { class: 'fields' }, (fields[el.type] || []).filter((f) => !f.when || f.when(el)).map((f) => fieldRow(f, el))),
    ...(help[el.type] ? [h('p', { class: 'props-help', html: help[el.type], style: 'margin-top:10px' })] : []),
  );
}

// Update input values in place (e.g. while dragging) without stealing focus.
function syncProps() {
  const el = selectedEl();
  if (!el) return;
  for (const input of $('#props').querySelectorAll('[data-key]')) {
    if (input === document.activeElement) continue;
    const v = el[input.dataset.key];
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v ?? '';
  }
}

function formatSourceValue(v) {
  if (v == null) return '–';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
  return String(v);
}

function renderSources() {
  const q = $('#source-search').value.trim().toLowerCase();
  const box = $('#sources');
  const groups = new Map();
  for (const s of state.sources) {
    if (q && !`${s.name} ${s.label} ${s.group}`.toLowerCase().includes(q)) continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  const nodes = [];
  for (const [group, items] of groups) {
    nodes.push(h('h3', {}, group));
    for (const s of items) {
      const value = s.error ? 'feil' : formatSourceValue(s.value) + (s.value != null && s.unit ? ` ${s.unit}` : '');
      nodes.push(h('div', {
        class: 'source-row',
        title: s.error ? `Feil: ${s.error}` : `Legg til {${s.name}} som verdi`,
        onclick: () => addFromSource(s),
      },
      h('span', { class: 's-label' }, s.label),
      h('span', { class: `s-value${s.error ? ' err' : ''}` }, value),
      h('span', { class: 's-name' }, `{${s.name}}`)));
    }
  }
  if (!nodes.length) nodes.push(h('p', { class: 'empty' }, 'Ingen treff.'));
  box.replaceChildren(...nodes);
}

function renderDisplays() {
  const sel = $('#display-select');
  const displays = state.meta.displays;
  sel.replaceChildren(...displays.map((d) => h('option', { value: d.id }, `${d.name} (${sizeLabel(d)})`)));
  const d = currentDisplay();
  if (d) sel.value = d.id;
}

function checkMismatch() {
  const d = currentDisplay();
  const L = state.layout;
  const box = $('#mismatch');
  if (!d || fits(d, L)) { box.hidden = true; return; }
  box.hidden = false;
  if (kindOf(d) === kindOf(L)) {
    box.replaceChildren(
      h('span', {}, `Layouten er ${sizeLabel(L)}, men «${d.name}» er ${sizeLabel(d)}.`),
      h('button', { type: 'button', onclick: () => setSize(d.width, d.height) }, `Bruk ${sizeLabel(d)}`));
    return;
  }
  const what = (x) => ({ char: `tegn-LCD (${sizeLabel(x)})`, color: `farge-TFT (${x.width}×${x.height})` }[kindOf(x)]
    || `OLED (${sizeLabel(x)})`);
  box.replaceChildren(
    h('span', {}, `Layouten er laget for ${what(L)}, men «${d.name}» er ${what(d)}.`),
    h('button', {
      type: 'button',
      onclick: () => {
        if (!confirmDiscard()) return;
        setLayout(newLayout(d));
        fitZoom();
      },
    }, `Ny layout for «${d.name}»`));
}

function setSize(w, hgt) {
  checkpoint();
  state.layout.width = w;
  state.layout.height = hgt;
  state.bits = null;
  renderLayoutControls();
  fitZoom();
  changed();
}

function renderAll() {
  renderTools();
  renderLayoutControls();
  renderTabs();
  renderInputs();
  renderElementList();
  renderProps();
  renderWarnings();
  draw();
}

/* ------------------------------------------------------------------------ */
/* Tabs                                                                      */
/* ------------------------------------------------------------------------ */

// The deployed layout's active tab, when the display shows this layout.
function liveTab() {
  const st = state.live;
  return st && st.layout_name === state.layout.name && st.tabs.length === state.layout.tabs.length ? st.tab : null;
}

function renderTabs() {
  const L = state.layout;
  const shown = liveTab();
  $('#tabbar').replaceChildren(
    ...L.tabs.map((t, i) => h('button', {
      type: 'button',
      class: `tab${i === state.tab ? ' active' : ''}`,
      role: 'tab',
      'aria-selected': String(i === state.tab),
      title: i === shown ? 'Denne fanen vises på displayet nå' : null,
      onclick: () => selectTab(i),
    }, h('span', { class: 'tab-num' }, String(i + 1)), tabName(t, i),
    i === shown ? h('span', { class: 'on-display', 'aria-label': '(på displayet)' }) : null)),
    h('button', { type: 'button', class: 'tab add', title: 'Ny fane', onclick: addTab }, '+ Ny fane'));
  $('#tab-pos').textContent = `${state.tab + 1} av ${L.tabs.length}`;
  const name = $('#tab-name');
  if (document.activeElement !== name) name.value = curTab().name;
  name.placeholder = `Fane ${state.tab + 1}`;
  $('#btn-tab-left').disabled = state.tab === 0;
  $('#btn-tab-right').disabled = state.tab === L.tabs.length - 1;
  $('#btn-tab-del').disabled = L.tabs.length === 1;
}

function selectTab(i) {
  if (i === state.tab) return;
  state.tab = i;
  state.selected = null;
  state.hover = null;
  state.boxes = {};
  state.warnings = {};
  renderAll();
  requestRender();
  saveDraft();
}

function addTab() {
  checkpoint();
  const L = state.layout;
  L.tabs.push(newTab(`Fane ${L.tabs.length + 1}`));
  changed();
  selectTab(L.tabs.length - 1);
}

function duplicateTab() {
  checkpoint();
  const t = curTab();
  const copy = { ...structuredClone(t), id: tid(), name: `${tabName(t, state.tab)} (kopi)` };
  copy.elements.forEach((e) => { e.id = uid(); });
  state.layout.tabs.splice(state.tab + 1, 0, copy);
  changed();
  selectTab(state.tab + 1);
}

function deleteTab() {
  const L = state.layout;
  const t = curTab();
  if (L.tabs.length === 1) return;
  const n = t.elements.length;
  if (n && !confirm(`Slette fanen «${tabName(t, state.tab)}» med ${n} element${n === 1 ? '' : 'er'}?`)) return;
  checkpoint();
  L.tabs.splice(state.tab, 1);
  L.nav = L.nav.filter((b) => b.tab !== t.id); // an input can't show a tab that is gone
  state.tab = Math.min(state.tab, L.tabs.length - 1);
  state.selected = null;
  state.boxes = {};
  renderAll();
  changed();
}

function moveTab(dir) {
  const tabs = state.layout.tabs;
  const j = state.tab + dir;
  if (j < 0 || j >= tabs.length) return;
  checkpoint();
  [tabs[state.tab], tabs[j]] = [tabs[j], tabs[state.tab]];
  state.tab = j;
  renderTabs();
  renderInputs();
  changed({ list: false });
}

/* ------------------------------------------------------------------------ */
/* The board's inputs                                                        */
/* ------------------------------------------------------------------------ */

function setNav(n, action, tab) {
  checkpoint(`nav:${n}`);
  const L = state.layout;
  L.nav = L.nav.filter((b) => b.input !== n);
  if (action) {
    L.nav.push(NAV_TAB[action] ? { input: n, action, tab: tab || curTab().id } : { input: n, action });
    L.nav.sort((a, b) => a.input - b.input);
  }
  renderInputs();
  changed({ list: false });
}

function renderInputs() {
  const ins = state.inputs || state.meta.inputs;
  const L = state.layout;
  $('#inputs').replaceChildren(...ins.inputs.map((inp) => {
    const n = inp.index;
    const b = L.nav.find((x) => x.input === n);
    const action = h('select', {
      'aria-label': `Hva ${inp.name} gjør`,
      onchange: (e) => setNav(n, e.target.value, b?.tab),
    }, h('option', { value: '' }, 'Ingenting'),
    ...Object.entries(NAV_ACTIONS).map(([k, label]) => h('option', { value: k }, label)));
    action.value = b?.action || '';
    const tab = b && NAV_TAB[b.action] ? h('select', {
      'aria-label': `Fanen ${inp.name} viser`,
      onchange: (e) => setNav(n, b.action, e.target.value),
    }, ...L.tabs.map((t, i) => h('option', { value: t.id }, `${i + 1} · ${tabName(t, i)}`))) : null;
    if (tab) tab.value = b.tab;
    return h('div', { class: `input-row${tab ? '' : ' no-tab'}` }, inputButton(inp), action, tab);
  }));
  $('#inputs-hint').hidden = L.tabs.length > 1;
  updateInputs(ins);
}

// Held down, it presses the input as if its switch was on: for trying the layout without switches.
function inputButton(inp) {
  const n = inp.index;
  let down = false;
  const press = (on) => {
    if (on === down) return;
    down = on;
    btn.classList.toggle('pressed', on);
    api('POST', `/api/inputs/${n}`, { on }).then(updateInputs).catch((e) => toast(e.message, 'error'));
    clearTimeout(liveTimer);
    liveTimer = setTimeout(pollLive, 120); // show the display's new tab right away
  };
  const btn = h('button', {
    type: 'button',
    class: 'inn-btn',
    'data-input': n,
    title: `GPIO${inp.gpio}. Hold inne for å prøve ${inp.name} uten bryter.`,
    onpointerdown: (e) => { if (e.button === 0) { btn.setPointerCapture(e.pointerId); press(true); } },
    onpointerup: () => press(false),
    onpointercancel: () => press(false),
    onlostpointercapture: () => press(false),
    onkeydown: (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(true); } },
    onkeyup: (e) => { if (e.key === ' ' || e.key === 'Enter') press(false); },
    onblur: () => press(false),
  }, h('span', { class: 'lamp' }), inp.name);
  return btn;
}

// Lamps and the status line, from /api/inputs or the live poll; the rows stay as they are.
function updateInputs(ins) {
  if (!ins) return;
  state.inputs = ins;
  for (const inp of ins.inputs) {
    const btn = $(`.inn-btn[data-input="${inp.index}"]`);
    if (!btn) continue;
    btn.classList.toggle('on', inp.on);
    btn.classList.toggle('unread', !inp.read);
  }
  const info = $('#inputs-info');
  const read = ins.inputs.filter((i) => i.read);
  info.classList.toggle('warn', !!ins.error);
  info.textContent = ins.error
    ? `Leses ikke${read.length ? ` alle` : ''}: ${ins.error}. Knappene virker likevel.`
    : `Leses fra GPIO ${read.map((i) => i.gpio).join(', ')}. Lampen lyser når inngangen er på.`;
}

/* ------------------------------------------------------------------------ */
/* Images                                                                    */
/* ------------------------------------------------------------------------ */

async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const nw = img.naturalWidth || 64;
    const nh = img.naturalHeight || 64;
    // store at most 320 px – the largest screen size, and keeps layouts small
    const s = Math.min(1, 320 / Math.max(nw, nh));
    const c = h('canvas', { width: Math.max(1, Math.round(nw * s)), height: Math.max(1, Math.round(nh * s)) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const L = state.layout;
    const fit = Math.min(1, L.width / nw, L.height / nh);
    return { data: c.toDataURL('image/png'), w: Math.max(1, Math.round(nw * fit)), h: Math.max(1, Math.round(nh * fit)) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------------ */
/* Files: save, open, deploy                                                  */
/* ------------------------------------------------------------------------ */

async function save() {
  const L = state.layout;
  L.name = (L.name || '').trim() || 'Uten navn';
  const slug = slugify(L.name);
  if (slug !== state.slug) {
    try {
      const existing = await api('GET', '/api/layouts');
      if (existing.some((x) => x.slug === slug) && !confirm(`Det finnes allerede en layout som heter «${L.name}». Overskrive den?`)) return;
    } catch { /* ignore – saving will report errors */ }
  }
  try {
    const res = await api('POST', '/api/layouts', L);
    state.slug = res.slug;
    state.savedJson = snapshot();
    updateDirty();
    saveDraft();
    toast(`Lagret «${L.name}»`, 'ok');
  } catch (e) {
    toast(`Lagring feilet: ${e.message}`, 'error');
  }
}

const confirmDiscard = () => !isDirty() || confirm('Du har ulagrede endringer. Vil du forkaste dem?');

async function openDialog() {
  const dlg = $('#open-dialog');
  const list = $('#layout-list');
  let layouts;
  try {
    layouts = await api('GET', '/api/layouts');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const fmt = (t) => (t ? new Date(t * 1000).toLocaleString('no-NO', { dateStyle: 'short', timeStyle: 'short' }) : '');
  list.replaceChildren(...(layouts.length ? layouts.map((l) =>
    h('li', {},
      h('div', {
        class: 'l-main',
        onclick: async () => {
          if (!confirmDiscard()) return;
          try {
            setLayout(await api('GET', `/api/layouts/${l.slug}`), { slug: l.slug });
            fitZoom();
            dlg.close();
          } catch (e) { toast(e.message, 'error'); }
        },
      },
      h('div', { class: 'l-name' }, l.name),
      h('div', { class: 'l-meta' }, `${sizeLabel(l)} · ${l.tabs > 1 ? `${l.tabs} faner · ` : ''}${fmt(l.updated)}`)),
      h('button', {
        type: 'button', class: 'icon-btn danger', title: 'Slett', html: svg('trash'),
        onclick: async () => {
          if (!confirm(`Slette «${l.name}»?`)) return;
          await api('DELETE', `/api/layouts/${l.slug}`);
          if (state.slug === l.slug) { state.slug = null; state.savedJson = null; updateDirty(); }
          openDialog();
        },
      })))
    : [h('li', { class: 'empty' }, 'Ingen lagrede layouter ennå.')]));
  if (!dlg.open) dlg.showModal();
}

async function deploy() {
  const d = currentDisplay();
  if (!d) { toast('Ingen display er konfigurert i config.toml', 'error'); return; }
  const L = state.layout;
  if (!fits(d, L)) {
    toast(`Layouten passer ikke: den er ${sizeLabel(L)}, displayet ${sizeLabel(d)}.`, 'error', 5000);
    return;
  }
  L.name = (L.name || '').trim() || 'Uten navn';
  const btn = $('#btn-deploy');
  btn.disabled = true;
  try {
    const res = await api('POST', `/api/displays/${encodeURIComponent(d.id)}/deploy?tab=${state.tab}`, L);
    state.slug = res.slug;
    state.savedJson = snapshot();
    updateDirty();
    saveDraft();
    const tab = L.tabs.length > 1 ? `, fane ${state.tab + 1} av ${L.tabs.length}` : '';
    toast(`«${L.name}» vises nå på ${d.name}${tab}` + (res.status.connected ? '' : ' (emulert – displayet er ikke tilkoblet)'),
      res.status.connected ? 'ok' : 'info', 4500);
    pollLive();
  } catch (e) {
    toast(`Deploy feilet: ${e.message}`, 'error', 5000);
  } finally {
    btn.disabled = false;
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.layout, null, 1)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${slugify(state.layout.name)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(file) {
  try {
    const layout = JSON.parse(await file.text());
    if (!Array.isArray(layout.elements) && !Array.isArray(layout.tabs)) throw new Error('filen mangler «tabs» (eller «elements»)');
    if (!confirmDiscard()) return;
    setLayout(layout, { saved: false });
    fitZoom();
    toast(`Importerte «${state.layout.name}» – husk å lagre`, 'ok');
  } catch (e) {
    toast(`Import feilet: ${e.message}`, 'error');
  }
}

/* ------------------------------------------------------------------------ */
/* Live view of the physical display                                          */
/* ------------------------------------------------------------------------ */

let liveTimer = null;

async function pollLive() {
  clearTimeout(liveTimer);
  const d = currentDisplay();
  if (!d) return;
  try {
    const res = await api('GET', `/api/displays/${encodeURIComponent(d.id)}/screen`);
    const bits = await decodePng(res.png);
    const st = res.status;
    const live = $('#live');
    const z = 2;
    const g = geom(st);
    live.width = g.W * z;
    live.height = g.H * z;
    const kind = kindOf(st);
    const shown = st.powered ? (kind === 'color' ? bits.rgba : bits.data) : null;
    if (kind === 'char') paintLcd(live.getContext('2d'), shown, st.width, st.height, z, { lit: st.powered && st.backlight });
    else if (kind === 'color') paintColor(live.getContext('2d'), shown, st.width, st.height, z, false);
    else paintPixels(live.getContext('2d'), shown, st.width, st.height, z, false);
    updateLiveStatus(st);
    updateInputs(res.inputs);
  } catch (e) {
    $('#live-info').textContent = `Ingen kontakt med serveren (${e.message})`;
    $('#display-dot').className = 'status-dot';
  }
  liveTimer = setTimeout(pollLive, 1000);
}

function updateLiveStatus(st) {
  const before = liveTab();
  state.live = st;
  Object.assign(currentDisplay(), st);
  if (liveTab() !== before) renderTabs();
  const tabs = st.tabs || [];
  $('#live-tabs').hidden = tabs.length < 2;
  $('#live-tab').textContent = tabs.length ? `Fane ${st.tab + 1} av ${tabs.length}` : '';
  $('#live-tab').title = tabs[st.tab] || '';
  const dot = $('#display-dot');
  dot.className = `status-dot ${st.connected ? 'ok' : 'emulated'}`;
  dot.title = st.connected ? 'Tilkoblet' : `Ikke tilkoblet: ${st.error || ''}`;
  const where = `${st.driver} · ${st.where}`;
  const what = st.layout_name
    ? `viser «${st.layout_name}»${tabs.length > 1 ? `, fane «${tabs[st.tab]}»,` : ''} siden ` +
      new Date(st.deployed_at * 1000).toLocaleTimeString('no-NO')
    : 'ingen layout deployet';
  $('#live-info').textContent = `${st.connected ? 'Tilkoblet' : 'Emulert'} (${where}) – ${what}`;
  const hint = $('#live-hint');
  hint.hidden = st.connected;
  const kind = kindOf(st);
  const char = kind === 'char';
  if (!st.connected) {
    hint.textContent = `Displayet svarer ikke (${st.error || 'ukjent feil'}). Bildet over er emulert. ` + (kind === 'color'
      ? 'Sjekk at SPI er slått på (sudo raspi-config → Interface Options → SPI) og at pinnene i config.toml stemmer med kablingen.'
      : 'Sjekk at I2C er slått på (sudo raspi-config → Interface Options → I2C), at kablingen stemmer, ' +
        `og at adressen ${st.address} dukker opp i «i2cdetect -y ${st.bus}»` +
        (char ? ' (PCF8574-adaptere bruker som regel 0x27 eller 0x3F).' : '.'));
  }
  $('#contrast-field').hidden = char;
  $('#contrast-field > span').textContent = kind === 'color' ? 'Lysstyrke' : 'Kontrast';
  const contrast = $('#contrast');
  if (!char && document.activeElement !== contrast) contrast.value = st.contrast;
  const backlight = $('#btn-backlight');
  backlight.hidden = !char;
  backlight.textContent = st.backlight ? 'Lys av' : 'Lys på';
  $('#btn-power').textContent = st.powered ? 'Slå av' : 'Slå på';
}

let contrastTimer = null;

async function liveTabStep(step) {
  const d = currentDisplay();
  if (!d) return;
  try {
    const res = await api('POST', `/api/displays/${encodeURIComponent(d.id)}/tab`, { step });
    updateLiveStatus(res.status);
    pollLive();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function displaySettings(data) {
  const d = currentDisplay();
  if (!d) return;
  try {
    const res = await api('POST', `/api/displays/${encodeURIComponent(d.id)}/settings`, data);
    updateLiveStatus(res.status);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ------------------------------------------------------------------------ */
/* Wiring                                                                    */
/* ------------------------------------------------------------------------ */

function bindUi() {
  $('#layout-name').addEventListener('input', (e) => {
    checkpoint('name');
    state.layout.name = e.target.value;
    changed({ list: false });
  });
  $('#layout-size').addEventListener('change', (e) => {
    const [w, hgt] = e.target.value.split('x').map(Number);
    setSize(w, hgt);
  });
  $('#layout-refresh').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!(v >= 0.1)) return;
    checkpoint('refresh');
    state.layout.refresh = v;
    changed({ list: false });
  });
  $('#layout-invert').addEventListener('change', (e) => {
    checkpoint();
    state.layout.invert = e.target.checked;
    changed({ list: false });
  });
  $('#layout-bg').addEventListener('input', (e) => {
    checkpoint('background');
    state.layout.background = e.target.value;
    changed({ list: false });
  });

  $('#tab-name').addEventListener('input', (e) => {
    checkpoint(`tabname:${curTab().id}`);
    curTab().name = e.target.value;
    renderTabs();
    renderInputs();
    changed({ list: false });
  });
  for (const [id, icon] of [['#btn-tab-left', 'left'], ['#btn-tab-right', 'right'], ['#btn-tab-dup', 'copy'],
    ['#btn-tab-del', 'trash'], ['#btn-live-prev', 'left'], ['#btn-live-next', 'right']]) {
    $(id).innerHTML = svg(icon);
  }
  $('#btn-tab-left').addEventListener('click', () => moveTab(-1));
  $('#btn-tab-right').addEventListener('click', () => moveTab(1));
  $('#btn-tab-dup').addEventListener('click', duplicateTab);
  $('#btn-tab-del').addEventListener('click', deleteTab);
  $('#btn-live-prev').addEventListener('click', () => liveTabStep(-1));
  $('#btn-live-next').addEventListener('click', () => liveTabStep(1));

  $('#btn-new').addEventListener('click', () => {
    if (!confirmDiscard()) return;
    setLayout(newLayout(currentDisplay()));
    fitZoom();
  });
  $('#btn-open').addEventListener('click', openDialog);
  $('#btn-save').addEventListener('click', save);
  $('#btn-export').addEventListener('click', exportJson);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });
  $('#btn-deploy').addEventListener('click', deploy);
  $('#display-select').addEventListener('change', (e) => {
    prefs.displayId = e.target.value;
    savePrefs();
    // An empty layout follows the display; anything else gets a warning with a fix.
    const d = currentDisplay();
    if (d && !fits(d, state.layout) && state.layout.tabs.every((t) => !t.elements.length)) {
      setLayout({ ...newLayout(d), name: state.layout.name });
      fitZoom();
    }
    checkMismatch();
    pollLive();
  });

  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-zoom-in').addEventListener('click', () => setZoom(prefs.zoom + 1));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(prefs.zoom - 1));
  const grid = $('#grid-toggle');
  grid.checked = prefs.grid;
  grid.addEventListener('change', () => { prefs.grid = grid.checked; savePrefs(); draw(); });
  const theme = $('#theme-select');
  theme.addEventListener('change', () => {
    if (isChar()) prefs.lcdTheme = theme.value; else prefs.theme = theme.value;
    savePrefs();
    draw();
    pollLive();
  });

  $('#source-search').addEventListener('input', renderSources);

  $('#contrast').addEventListener('input', (e) => {
    clearTimeout(contrastTimer);
    contrastTimer = setTimeout(() => displaySettings({ contrast: Number(e.target.value) }), 150);
  });
  $('#btn-power').addEventListener('click', () => displaySettings({ powered: !state.live?.powered }));
  $('#btn-backlight').addEventListener('click', () => displaySettings({ backlight: !state.live?.backlight }));
  $('#btn-clear').addEventListener('click', async () => {
    const d = currentDisplay();
    if (!d || !confirm(`Fjerne layouten fra «${d.name}»?`)) return;
    try {
      const res = await api('POST', `/api/displays/${encodeURIComponent(d.id)}/clear`);
      updateLiveStatus(res.status);
      pollLive();
    } catch (e) { toast(e.message, 'error'); }
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') { e.preventDefault(); save(); return; }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || $('#open-dialog').open) return;
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (mod && key === 'd') { e.preventDefault(); duplicate(); return; }
    if (mod && key === 'c' && selectedEl()) { state.clipboard = structuredClone(selectedEl()); return; }
    if (mod && key === 'v' && state.clipboard) { duplicate(state.clipboard, 6); state.clipboard = structuredClone(selectedEl()); return; }
    if (mod) return;
    const step = e.shiftKey ? (isChar() ? 4 : 8) : 1;
    const moves = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
    if (moves[key] && selectedEl()) { e.preventDefault(); nudge(...moves[key]); return; }
    if ((key === 'delete' || key === 'backspace') && selectedEl()) { e.preventDefault(); removeSelected(); return; }
    if (key === 'escape') select(null);
  });

  window.addEventListener('beforeunload', saveDraft);
}

function renderHub(hub) {
  const p = $('#hub-status');
  p.hidden = !hub;
  if (!hub) return;
  p.classList.toggle('down', !hub.connected);
  p.title = hub.url;
  p.replaceChildren(h('span', { class: `status-dot ${hub.connected ? 'ok' : 'emulated'}` }),
    hub.connected ? `Huben: ${hub.tags} tagger` : `Huben: ${hub.error || 'kobler til …'}`);
}

async function refreshSources() {
  try {
    const [sources, hub] = await Promise.all([api('GET', '/api/sources'), api('GET', '/api/hub')]);
    state.sources = sources;
    if (state.layout) {  // each display has its own; the list shows the edited tab's
      const tab = { tab: state.tab + 1, tab_count: state.layout.tabs.length, tab_name: tabName(curTab(), state.tab) };
      for (const src of sources) if (src.name in tab) src.value = tab[src.name];
    }
    renderSources();
    renderHub(hub);
  } catch { /* server restarting – try again next tick */ }
}

async function init() {
  try {
    state.meta = await api('GET', '/api/meta');
  } catch (e) {
    document.body.textContent = `Fikk ikke kontakt med serveren: ${e.message}`;
    return;
  }
  for (const err of state.meta.source_errors) toast(`Datakilde: ${err}`, 'error', 8000);
  const { vehicle, hub } = state.meta;
  if (vehicle) {
    $('#vehicle').textContent = vehicle;
    $('#vehicle').hidden = false;
    document.title = `LCD-editor – ${vehicle}`;
  }
  if (hub?.port) {
    const hmi = new URL('/', location.href);
    hmi.port = hub.port;
    $('#hmi-link').href = hmi.href;
    $('#hmi-link').hidden = false;
  }
  renderHub(hub);
  await refreshSources();
  renderTools();
  renderDisplays();
  bindUi();

  const draft = store.get('oled.draft', null);
  if (draft?.layout?.tabs || draft?.layout?.elements) {
    setLayout(draft.layout, { slug: draft.slug, saved: !draft.dirty, tab: draft.tab });
  } else {
    setLayout(newLayout(currentDisplay()));
  }
  if (prefs.zoom) setZoom(prefs.zoom); else fitZoom();

  pollLive();
  setInterval(refreshSources, 2000);
  // keep live values (clock, sensors) ticking in the preview
  setInterval(() => { if (!state.drag && hasDynamic()) requestRender(); }, 1000);
}

init();
