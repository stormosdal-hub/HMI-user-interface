/*
 * HMI-appen — editor + kjøring.
 *
 * Formen på konfigurasjonen (lagret av huben i config/hmi.json, eller eksportert som fil):
 * {
 *   "project": "Kjøreverk",
 *   "canvas": { "width": 1280, "height": 720 },
 *   "hub": { "url": "" },              // tom = samme vert som siden ble levert fra
 *   "vars": { "pls": "pls" },          // ${pls} inne i tagnavn byttes ut
 *   "screens": [
 *     { "id": "main", "name": "Main", "widgets": [
 *        { "id": "gauge-1", "type": "gauge", "x": 20, "y": 20, "w": 200, "h": 170,
 *          "props": { "label": "Speed", "tag": "${pls}.reals_0", "unit": "rpm", "min": 0, "max": 3000 } }
 *     ] }
 *   ]
 * }
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el } = H.helpers;
  const $ = s => document.querySelector(s);
  const GRID = 10;
  const DRAFT_KEY = 'hmi.draft';

  const state = {
    config: null,
    screenId: null,
    mode: 'edit',
    selected: null,
    selection: new Set(),  // alle valgte widgeter (Shift-klikk / Shift-dra)
    tags: new Map(),       // navn -> metadata fra hubens register
    values: new Map(),     // navn -> { value, ts, quality }
    events: [],
    mounted: new Map(),    // widget-id -> { root, handle, widget, tags }
    tagIndex: new Map(),   // tagnavn -> Set(widget-id)
    ws: null,
    connected: false,
    reconnectTimer: null,
    pendingHistory: new Map(), // tag -> [resolve, ...]
    cardTab: new Map(),        // kort-id -> fanen som vises (mens siden er åpen)
    requests: new Map(),       // forespørsel-id -> resolve (sjekk av formler)
    unsent: [],                // spørsmål som venter på forbindelsen (historikk, mens siden starter)
    clipboard: null,           // kopierte widgeter (Ctrl+C / høyreklikkmenyen)
    pasteCount: 0,
    announceCalcs: false,
    dirty: false,
    loadError: null,       // hubens prosjektfil kunne ikke leses: Save spør før den erstattes
    scale: 1,
  };

  // ================================================================ konfigurasjon
  function defaultConfig() {
    return { project: 'New project', canvas: { width: 1280, height: 720 }, hub: { url: '' }, vars: {}, screens: [{ id: 'main', name: 'Main', widgets: [] }] };
  }

  const copyDefault = v => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

  function uid(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 7); }

  function normalize(cfg) {
    const d = defaultConfig();
    cfg = Object.assign(d, cfg || {});
    cfg.canvas = Object.assign({ width: 1280, height: 720 }, cfg.canvas || {});
    cfg.hub = Object.assign({ url: '' }, cfg.hub || {});
    cfg.vars = cfg.vars && typeof cfg.vars === 'object' ? cfg.vars : {};
    cfg.calcs = Array.isArray(cfg.calcs) ? cfg.calcs : [];
    cfg.editCode = typeof cfg.editCode === 'string' ? cfg.editCode : (cfg.editCode != null ? String(cfg.editCode) : '');
    if (!Array.isArray(cfg.screens) || !cfg.screens.length) cfg.screens = d.screens;
    for (const s of cfg.screens) {
      s.id = s.id || uid('screen');
      s.name = s.name || 'Screen';
      s.widgets = Array.isArray(s.widgets) ? s.widgets : [];
      for (const w of s.widgets) {
        w.id = w.id || uid(w.type || 'widget');
        w.props = w.props || {};
        const def = H.widgets[w.type];
        if (def) for (const p of def.props) if (w.props[p.key] === undefined) w.props[p.key] = copyDefault(p.default);
        const named = { green: '#43c483', amber: '#f2b441', red: '#e5533d', cyan: '#5cc8e8' };
        if (named[w.props.color]) w.props.color = named[w.props.color];
        w.x = +w.x || 0; w.y = +w.y || 0;
        w.w = +w.w || (def ? def.size[0] : 160); w.h = +w.h || (def ? def.size[1] : 80);
        if (w.type === 'card') {
          if (!Array.isArray(w.props.tabs) || !w.props.tabs.length) w.props.tabs = [{ id: 'tab1', name: 'Overview' }];
          const seen = new Set();
          w.props.tabs.forEach((t, i) => { if (!t.id || seen.has(t.id)) t.id = 'tab' + (i + 1) + Math.random().toString(36).slice(2, 5); seen.add(t.id); t.name = t.name || 'Tab ' + (i + 1); });
        }
      }
      // widgeter på kort: kortet må finnes (kort kan ikke ligge i kort), og fanen også
      const byId = new Map(s.widgets.map(w => [w.id, w]));
      for (const w of s.widgets) {
        const card = w.parent && byId.get(w.parent);
        if (!card || card.type !== 'card' || w.type === 'card') { delete w.parent; delete w.tab; continue; }
        if (!card.props.tabs.some(t => t.id === w.tab)) w.tab = card.props.tabs[0].id;
      }
    }
    delete cfg._fresh;
    return cfg;
  }

  function readDraft() {
    try { const raw = localStorage.getItem(DRAFT_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  function writeDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state.config)); } catch { /* lagring utilgjengelig */ }
  }

  async function loadConfig() {
    let cfg = null, source = 'default';
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (r.ok) {
        const server = await r.json();
        if (server._fresh) {
          // ingen fil på huben ennå — hent et ulagret utkast fra denne nettleseren hvis det finnes
          const draft = readDraft();
          if (draft) { cfg = draft; source = 'draft'; } else { cfg = server; source = 'hub (new)'; }
        } else { cfg = server; source = 'hub'; }
      } else {
        // huben har en prosjektfil den ikke kan lese. Si det, og ikke bruk et utkast eller et
        // tomt prosjekt i stedet: en Save ville skrive det over den ekte filen.
        const res = await r.json().catch(() => ({}));
        state.loadError = res.error || `the hub answered ${r.status} ${r.statusText}`;
        source = 'error';
      }
    } catch { /* ikke levert av huben (åpnet som fil) */ }
    if (!cfg && source !== 'error') { const draft = readDraft(); if (draft) { cfg = draft; source = 'draft'; } }
    state.config = normalize(cfg);
    state.screenId = state.config.screens[0].id;
    state.dirty = source === 'draft';
    updateTitle();
    return source;
  }

  async function saveConfig() {
    if (state.loadError && !confirm(`The project file on the hub couldn’t be read when this page opened:\n\n${state.loadError}\n\n` +
      'Save the project shown here in its place? The hub keeps the unreadable file as a copy next to it.')) return false;
    try {
      const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.config, null, 2) });
      const res = await r.json();
      if (!r.ok || !res.ok) throw new Error(res.error || r.statusText);
      state.dirty = false; state.loadError = null; updateTitle();
      toast('Saved to ' + res.path + (res.kept ? '. The unreadable file was kept as ' + res.kept : ''));
      return true;
    } catch (e) {
      toast('Could not save to hub: ' + e.message + '. Use Export to download the file.', true);
      return false;
    }
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], { type: 'application/json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.config.project || 'hmi').replace(/[^\w.-]+/g, '_') + '.hmi.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state.config = normalize(JSON.parse(reader.result));
        state.screenId = state.config.screens[0].id;
        state.selected = null;
        markDirty();
        renderAll();
        connect();
        toast('Imported ' + file.name + ' — press Save to store it on the hub');
      } catch (e) { toast('Import failed: ' + e.message, true); }
    };
    reader.readAsText(file);
  }

  function markDirty() { state.dirty = true; writeDraft(); updateTitle(); }
  function updateTitle() {
    document.title = (state.config.project || 'HMI') + (state.dirty ? ' •' : '');
    $('#btn-project').textContent = state.config.project || 'New project';
  }

  const currentScreen = () => state.config.screens.find(s => s.id === state.screenId) || state.config.screens[0];
  const resolveTag = name => String(name || '').replace(/\$\{(\w+)\}/g, (_, k) => state.config.vars[k] ?? `\${${k}}`);

  // kopi av widgeten med ${vars} byttet ut i tag-egenskaper — widgeter ser aldri plassholdere
  function resolved(w) {
    const def = H.widgets[w.type];
    const props = { ...w.props };
    if (def) for (const p of def.props) {
      if ((p.type === 'tag' || p.type === 'tags') && typeof props[p.key] === 'string') props[p.key] = resolveTag(props[p.key]);
      if (p.type === 'bindings' && Array.isArray(props[p.key])) props[p.key] = props[p.key].map(b => ({ ...b, tag: resolveTag(b.tag) }));
      if (p.type === 'inputs' && props[p.key] && typeof props[p.key] === 'object') {
        props[p.key] = Object.fromEntries(Object.entries(props[p.key]).map(([k, t]) => [k, resolveTag(t)]));
      }
    }
    return { ...w, props };
  }

  // ================================================================ tegning av siden
  function renderAll() {
    renderScreens();
    renderPalette();
    renderCanvas();
    renderInspector();
    fitCanvas();
  }

  function renderScreens() {
    const nav = $('#screens');
    nav.innerHTML = '';
    for (const s of state.config.screens) {
      const b = el('button', s.id === state.screenId ? 'on' : '', s.name);
      b.addEventListener('click', () => { state.screenId = s.id; state.selected = null; state.selection.clear(); renderAll(); });
      nav.append(b);
    }
  }

  function renderPalette() {
    const p = $('#palette');
    p.innerHTML = '';
    p.append(el('h2', null, 'Add widget'));
    for (const [type, def] of Object.entries(H.widgets)) {
      const b = el('button', null, def.name);
      if (def.hint) b.append(el('small', null, def.hint));
      b.addEventListener('click', () => addWidget(type));
      p.append(b);
    }
  }

  function renderCanvas() {
    const canvas = $('#canvas');
    for (const id of [...state.mounted.keys()]) unmountWidget(id);
    canvas.innerHTML = '';
    canvas.style.width = state.config.canvas.width + 'px';
    canvas.style.height = state.config.canvas.height + 'px';
    canvas.classList.toggle('edit', state.mode === 'edit');
    // kort først (hvert monterer widgetene i fanen som vises), så de løse widgetene
    for (const w of currentScreen().widgets) if (!w.parent && isCard(w)) mountWidget(w);
    for (const w of currentScreen().widgets) if (!w.parent && !isCard(w)) mountWidget(w);
  }

  // ---- kort
  const isCard = w => !!w && w.type === 'card';
  const findWidget = id => currentScreen().widgets.find(x => x.id === id);
  const childrenOf = (cardId, tabId) => currentScreen().widgets.filter(x => x.parent === cardId && (tabId === undefined || x.tab === tabId));
  const activeTab = card => {
    const tabs = card.props.tabs || [];
    const t = state.cardTab.get(card.id);
    return tabs.some(x => x.id === t) ? t : (tabs[0] && tabs[0].id);
  };
  function showCardTab(cardId, tabId) {
    state.cardTab.set(cardId, tabId);
    const card = findWidget(cardId);
    if (card) remountWidget(card);
  }

  const ctx = {
    mode: () => state.mode,
    // returnerer true bare hvis skrivingen faktisk forlot nettleseren
    write(tag, value) {
      if (state.mode !== 'run') return false;
      if (!tag) { toast('This control has no tag bound', true); return false; }
      if (!state.connected) { toast('Not connected to the hub', true); return false; }
      // enheten bak taggen er frakoblet: ingenting kunne utført skrivingen
      const cur = state.values.get(tag);
      if (cur && cur.quality === 'bad') { toast(`Not sent: ${tag} is offline`, true); return false; }
      if (!send({ type: 'write', tag, value })) { toast('Not connected to the hub', true); return false; }
      return true;
    },
    confirm: askConfirm,
    // kvittere alarmer: en liste med nøkler, eller 'all'
    ack(keys) {
      const msg = keys === 'all' ? { type: 'ack', all: true } : { type: 'ack', keys };
      if (keys !== 'all' && !keys.length) return;
      if (!send(msg)) toast('Not connected to the hub', true);
    },
    value: tag => state.values.get(tag),
    // ditt eget navn på en tag (tagnavn), eller ''
    tagLabel: tag => { const t = state.tags.get(tag); return (t && t.label) || ''; },
    // tagoversikten fra huben (navn -> { dataType, label, ... }), for widgeter som velger tagger med et mønster
    registry: () => state.tags,
    history(tag) {
      return new Promise(resolve => {
        if (!state.connected) return resolve([]);
        const list = state.pendingHistory.get(tag) || [];
        list.push(resolve);
        state.pendingHistory.set(tag, list);
        send({ type: 'history', tag });
        setTimeout(() => resolve([]), 4000);
      });
    },
    // punkter for et tidsrom, fra hubens minne eller en historikktjeneste:
    // gir { series: { tag: [[ts, value eller null], ...] }, source, note, error }
    historyRange(tags, from, to, points) {
      if (!tags.length) return Promise.resolve({ series: {} });
      return request({ type: 'historyRange', tags, from, to, points }, 25000, true);
    },
    events: () => state.events.slice(),
    toast,
    // kort: hvilken fane som vises, og bytte den (huskes mens siden er åpen)
    cardTab(id, tabs) {
      let t = state.cardTab.get(id);
      if (!tabs.some(x => x.id === t)) { t = tabs[0].id; state.cardTab.set(id, t); }
      return t;
    },
    setCardTab(id, tabId) {
      showCardTab(id, tabId);
      if (state.mode === 'edit') select(id);
    },
    refresh(id) { if (state.mode === 'edit' && state.selected === id) renderInspector(); },
    // kodetekster: teksten for en verdi, og popup-vinduet med beskrivelsen
    code: (listId, value) => H.codes.lookup(listId, value),
    openCode(listId, value, { title, shown } = {}) {
      H.openCodeInfo({ listId, value, title, shown, canEdit: canEditCodes, openList: openCodeEditor,
        save: (id, code, set) => changeCodes([{ list: id, code, set }]) });
    },
  };

  function mountWidget(w) {
    let container = $('#canvas');
    if (w.parent) {
      // på et kort: bare når kortet viser fanen til denne widgeten
      const card = state.mounted.get(w.parent);
      if (!card || !card.handle.body || card.handle.activeTab !== w.tab) return;
      container = card.handle.body;
    }
    const root = el('div', 'widget');
    root.dataset.id = w.id;
    Object.assign(root.style, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' });
    if (state.selection.has(w.id)) root.classList.add('selected');
    const def = H.widgets[w.type];
    let handle = {}, tags = [];
    if (!def) {
      root.classList.add('unknown');
      root.append(el('div', 'plate', w.type), el('div', 'wbody', 'Unknown widget type'));
    } else {
      const rw = resolved(w);
      tags = def.tags(rw, state.tags).filter(Boolean);
      if (/^#[0-9a-f]{3,8}$/i.test(rw.props.color || '')) root.style.setProperty('--accent', rw.props.color);
      for (const [key, cssVar] of SIZE_VARS) {
        const f = H.helpers.sizeScale(rw.props[key]);
        if (f !== 1) root.style.setProperty(cssVar, f);
      }
      try { handle = def.mount(root, rw, ctx) || {}; } catch (e) { console.error(e); root.append(el('div', 'wbody', 'Widget error: ' + e.message)); }
    }
    if (state.mode === 'edit') root.append(el('div', 'handle'));
    container.append(root);
    state.mounted.set(w.id, { root, handle, widget: w, tags });
    if (isCard(w) && handle.body) for (const c of childrenOf(w.id, handle.activeTab)) mountWidget(c);
    for (const t of tags) {
      if (!state.tagIndex.has(t)) state.tagIndex.set(t, new Set());
      state.tagIndex.get(t).add(w.id);
      const v = state.values.get(t);
      if (v && handle.update) handle.update(t, v.value, v.quality, v.ts);
    }
    refreshStale(w.id);
    markCalc(w.id);
    if (handle.event) for (const ev of state.events) handle.event(ev);
  }

  // tekststørrelser og CSS-faktorene de setter på widgeten (style.css ganger størrelsene sine med dem)
  const SIZE_VARS = [['labelSize', '--fs-label'], ['textSize', '--fs-text']];

  const isCalcTag = t => typeof t === 'string' && t.startsWith('calc.');

  // Widgeter som viser en beregnet verdi har en ƒ; hold musen over den for å se formelen
  function markCalc(id) {
    const m = state.mounted.get(id);
    if (!m) return;
    const calcTags = m.tags.filter(isCalcTag);
    let badge = m.root.querySelector(':scope > .calc-badge, :scope > .plate > .calc-badge');
    if (!calcTags.length) { if (badge) badge.remove(); m.root.classList.remove('uses-calc'); return; }
    m.root.classList.add('uses-calc');
    if (!badge) {
      badge = el('span', 'calc-badge', '\u0192');
      const plate = m.root.querySelector(':scope > .plate');
      if (plate) plate.prepend(badge); else { badge.classList.add('corner'); m.root.append(badge); }
    }
    const lines = calcTags.map(t => {
      const info = state.tags.get(t);
      if (!info) return `${t}: not defined on the hub`;
      return `${t} = ${info.formula}${info.unit ? '  [' + info.unit + ']' : ''}${info.error ? '\n  \u26a0 ' + info.error : ''}`;
    });
    badge.title = 'Calculated by the hub\n' + lines.join('\n');
    badge.classList.toggle('err', calcTags.some(t => { const i = state.tags.get(t); return !i || i.error; }));
  }

  function unmountWidget(id) {
    const m = state.mounted.get(id);
    if (!m) return;
    if (isCard(m.widget)) for (const c of childrenOf(id)) unmountWidget(c.id);
    try { m.handle.destroy && m.handle.destroy(); } catch { /* ignorer */ }
    m.root.remove();
    for (const t of m.tags) { const set = state.tagIndex.get(t); if (set) { set.delete(id); if (!set.size) state.tagIndex.delete(t); } }
    state.mounted.delete(id);
  }

  function remountWidget(w) { unmountWidget(w.id); mountWidget(w); }

  function refreshStale(id) {
    const m = state.mounted.get(id);
    if (!m) return;
    const stale = m.tags.some(t => { const v = state.values.get(t); return v && v.quality === 'bad'; });
    m.root.classList.toggle('stale', stale);
  }

  function fitCanvas() {
    const vp = $('#viewport'), canvas = $('#canvas');
    if (state.mode === 'run') {
      const s = Math.min((vp.clientWidth - 16) / state.config.canvas.width, (vp.clientHeight - 16) / state.config.canvas.height, 2);
      state.scale = s > 0 ? s : 1;
    } else state.scale = 1;
    canvas.style.transform = `scale(${state.scale})`;
    // hold rulleområdet like stort som det skalerte lerretet
    canvas.style.marginRight = (state.config.canvas.width * (state.scale - 1)) + 'px';
    canvas.style.marginBottom = (state.config.canvas.height * (state.scale - 1)) + 'px';
  }

  // ================================================================ inspektør
  function field(labelText, input, hint) {
    const row = el('div', 'row');
    const lab = el('label', null, labelText);
    row.append(lab, input);
    if (hint) row.append(el('div', 'hint', hint));
    return row;
  }
  function textInput(value, onChange, type = 'text', evt = 'input') {
    const i = el('input'); i.type = type; i.value = value ?? '';
    i.addEventListener(evt, () => onChange(i.value));
    return i;
  }
  // tekststørrelser i prosent av normal. Faste trinn holder et skjermbilde enhetlig; en størrelse
  // skrevet i prosjektfilen for hånd beholdes og vises som et eget trinn. `mixed`: widgetene er ulike.
  const SIZE_STEPS = [75, 90, 100, 125, 150, 200, 250, 300];
  function sizeSelect(value, onChange, mixed = false) {
    const s = el('select');
    const cur = Number(value) || 100;
    const steps = mixed || SIZE_STEPS.includes(cur) ? SIZE_STEPS : [...SIZE_STEPS, cur].sort((a, b) => a - b);
    if (mixed) { const o = el('option', null, 'Mixed'); o.value = ''; s.append(o); }
    for (const n of steps) { const o = el('option', null, n === 100 ? '100% (normal)' : n + '%'); o.value = String(n); s.append(o); }
    s.value = mixed ? '' : String(cur);
    s.addEventListener('change', () => { if (s.value) onChange(Number(s.value)); });
    return s;
  }

  // tagoversikten: alle tagger med levende verdi; pick() utelates for bare å se
  // (Tag-list i topplinjen, og prosjektpanelet)
  function browseTags(current, pick, title) {
    H.openTagBrowser({
      tags: () => state.tags,
      live: name => state.values.get(name),
      vars: state.config.vars,
      current: current ? resolveTag(current) : '',
      pick,
      title,
      editName: changeName,
      alarms: true,   // tagoversikten åpnes bare i Edit-modus
      codeLists: () => H.codes.lists(),
    });
  }
  // ditt eget navn, din beskrivelse og alarmen for en tag: huben har dem (tagnames.json ved siden av
  // prosjektet), ikke i prosjektfilen, så det verken trenger eller gir en Save. Alle HMI-er og
  // alarmlisten får det med en gang. alarm: undefined = uendret, null = adapterens gjelder.
  async function changeName(tag, name, info, alarm) {
    let r, res = {};
    const change = alarm === undefined ? { tag, name, info } : { tag, name, info, alarm };
    try {
      r = await fetch('/api/names', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: [change] }) });
      res = await r.json();
    } catch (e) { throw new Error(r ? e.message : 'the hub can’t be reached'); }
    if (!r.ok || !res.ok) throw new Error(res.error || r.statusText);
    const t = state.tags.get(tag), dev = t && t.deviceLabel;
    if (alarm !== undefined) {
      const sev = alarm ? (alarm.severity === 'none' ? null : alarm.severity) : (t && t.deviceAlarm ? t.deviceAlarm.severity : null);
      const word = sev === 'alarm' ? 'an alarm' : sev === 'warning' ? 'a warning' : 'no alarm';
      return toast(`${tag}${name ? ` (“${name}”)` : ''} saved: ${word}${alarm === null && sev ? ', as the adapter sets it' : ''}`);
    }
    toast(name ? `${tag} is “${name}” now` : dev ? `${tag} has the device's name again: “${dev}”` : `${tag} has no name of its own now`);
  }
  // en tag valgt for en widget som fortsatt har standardetiketten: taggens eget navn, hvis den har et
  function autoLabel(w, text) {
    const def = H.widgets[w.type];
    const lp = def && def.props.find(p => p.key === 'label');
    const t = state.tags.get(resolveTag(text));
    if (!lp || !t || !t.label || (w.props.label && w.props.label !== lp.default)) return;
    w.props.label = t.label;
    markDirty();
    remountWidget(w);
    renderInspector();
  }
  const LIST_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3" cy="4" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="3" cy="12" r="1.3"/><rect x="6" y="3.2" width="8" height="1.6" rx=".8"/><rect x="6" y="7.2" width="8" height="1.6" rx=".8"/><rect x="6" y="11.2" width="8" height="1.6" rx=".8"/></svg>';
  // et tagfelt med bla-knappen; `multi` legger til i en kommaliste (trend-tagger)
  function tagField(value, onCommit, { multi = false, evt = 'input', placeholder = '', onPick = null } = {}) {
    const line = el('div', 'tagline');
    const input = textInput(value, v => onCommit(v), 'text', evt);
    input.setAttribute('list', 'taglist');
    input.autocomplete = 'off';
    if (placeholder) input.placeholder = placeholder;
    const btn = el('button', 'tagbtn');
    btn.type = 'button';
    btn.innerHTML = LIST_ICON;
    btn.title = 'Browse tags with live values';
    btn.setAttribute('aria-label', 'Browse tags');
    btn.addEventListener('click', () => {
      const parts = input.value.split(',').map(x => x.trim()).filter(Boolean);
      browseTags(multi ? parts[parts.length - 1] : input.value.trim(), text => {
        if (multi) { if (!parts.includes(text)) parts.push(text); input.value = parts.join(', '); }
        else input.value = text;
        onCommit(input.value);
        input.dispatchEvent(new Event('change', { bubbles: true }));   // som om det ble skrevet og forlatt
        if (onPick) onPick(text);
      });
    });
    line.append(input, btn);
    return line;
  }

  // Innstillinger kan avhenge av andre (showIf). Når et tekst- eller tagfelt forlates, tegnes panelet
  // på nytt, men bare hvis innstillingene som vises ville endret seg: da blir markøren der den er.
  let inspectorShown = null;   // { w, keys } for widgeten i panelet
  const shownKeys = w => { const d = H.widgets[w.type]; return d ? d.props.filter(p => !p.showIf || p.showIf(w.props)).map(p => p.key).join() : ''; };

  function renderInspector() {
    const box = $('#inspector');
    box.innerHTML = '';
    inspectorShown = null;
    const screen = currentScreen();
    if (state.selection.size > 1) return renderMultiInspector(box);
    const w = screen.widgets.find(x => x.id === state.selected);
    if (w) return renderWidgetInspector(box, w, screen);

    // ---- innstillinger for prosjekt + skjermbilde
    box.append(el('h2', null, 'Project'));
    box.append(field('Name', textInput(state.config.project, v => { state.config.project = v; markDirty(); updateTitle(); })));
    const size = el('div', 'grid2');
    size.append(
      field('Canvas width', textInput(state.config.canvas.width, v => { state.config.canvas.width = +v || 1280; markDirty(); renderCanvas(); fitCanvas(); }, 'number', 'change')),
      field('Canvas height', textInput(state.config.canvas.height, v => { state.config.canvas.height = +v || 720; markDirty(); renderCanvas(); fitCanvas(); }, 'number', 'change')),
    );
    box.append(size);
    box.append(field('Hub URL', textInput(state.config.hub.url, v => { state.config.hub.url = v.trim(); markDirty(); connect(); }, 'text', 'change'), 'Leave empty to use the host this page came from. Example: ws://192.168.1.10:8080'));
    const vars = el('textarea');
    vars.value = Object.entries(state.config.vars).map(([k, v]) => `${k}=${v}`).join('\n');
    vars.addEventListener('input', () => {
      const out = {};
      for (const line of vars.value.split('\n')) { const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2]; }
      state.config.vars = out; markDirty(); renderCanvas();
    });
    box.append(field('Variables (one per line: name=value)', vars, 'Use ${name} inside tag names: with pls=pls, ${pls}.bit00 is pls.bit00. Change the value to retarget every widget. Writing the tag out (pls.bit00) works too'));

    box.append(el('h2', null, 'Screen'));
    box.append(field('Name', textInput(screen.name, v => { screen.name = v; markDirty(); renderScreens(); })));
    const actions = el('div', 'actions');
    const del = el('button', 'danger', 'Delete screen');
    del.disabled = state.config.screens.length < 2;
    del.addEventListener('click', () => {
      if (!confirm(`Delete screen "${screen.name}" and its ${screen.widgets.length} widgets?`)) return;
      state.config.screens = state.config.screens.filter(s => s !== screen);
      state.screenId = state.config.screens[0].id; markDirty(); renderAll();
    });
    actions.append(del);
    box.append(actions);
    const known = [...state.tags.keys()].filter(t => !isCalcTag(t));
    const calcNames = (state.config.calcs || []).map(c => 'calc.' + c.name);
    box.append(field('Edit pass-code', textInput(state.config.editCode, v => { state.config.editCode = v.trim(); markDirty(); }, 'text', 'change'),
      'Asked for when switching to Edit, so a stray tap can\u2019t open the editor. Leave empty for none. Not a security measure: it is stored in the project file.'));
    const look = el('button', 'wide', 'Browse tags with live values');
    look.addEventListener('click', () => browseTags(''));
    box.append(look);
    box.append(el('h2', null, `Tags from devices (${known.length})`));
    box.append(el('div', known.length ? 'hint' : 'empty', known.length ? known.join(', ') : 'No adapters connected yet. Start one and its tags will appear here.'));
    box.append(el('h2', null, `\u0192 Calculated (${calcNames.length})`));
    box.append(el('div', calcNames.length ? 'hint calc-list' : 'empty', calcNames.length ? calcNames.join(', ') : 'None yet.'));
    const ca = el('div', 'actions');
    const cb = el('button', null, 'Edit calculations');
    cb.addEventListener('click', openCalcs);
    ca.append(cb);
    box.append(ca);
  }

  function renderMultiInspector(box) {
    const ws = [...state.selection].map(findWidget).filter(Boolean);
    box.append(el('h2', null, `${ws.length} widgets selected`));
    box.append(el('div', 'hint', 'Drag any of them to move them together, or use the arrow keys (Shift for 1 px). Shift-click adds or removes a widget; Shift-drag draws a selection box. Escape clears the selection.'));
    const list = el('div', 'selist');
    for (const w of ws) {
      const def = H.widgets[w.type];
      const b = el('button', null, `${def ? def.name : w.type}${w.props.label || w.props.title ? ' · ' + (w.props.label || w.props.title) : ''}`);
      b.title = 'Select only this one';
      b.addEventListener('click', () => select(w.id));
      list.append(b);
    }
    box.append(list);
    // tekststørrelser for alle på en gang, på widgetene som har innstillingen
    for (const [key, label] of [['labelSize', 'Label size'], ['textSize', 'Value and text size']]) {
      const has = ws.filter(w => { const d = H.widgets[w.type]; return d && d.props.some(p => p.key === key); });
      if (!has.length) continue;
      const sizes = new Set(has.map(w => Number(w.props[key]) || 100));
      const pick = sizeSelect([...sizes][0], v => {
        for (const w of has) w.props[key] = v;
        markDirty();
        for (const w of has) remountWidget(w);
        renderInspector();
      }, sizes.size > 1);
      box.append(field(label, pick, has.length < ws.length ? `Changes ${has.length} of the ${ws.length}; the others have no such setting` : null));
    }
    const actions = el('div', 'actions');
    const del = el('button', 'danger', `Delete ${ws.length} widgets`);
    del.addEventListener('click', () => deleteWidgets(ws.map(w => w.id)));
    actions.append(del);
    box.append(actions);
  }

  function renderWidgetInspector(box, w, screen) {
    const def = H.widgets[w.type];
    inspectorShown = { w, keys: shownKeys(w) };
    box.append(el('h2', null, (def ? def.name : w.type) + ' widget'));
    const pos = el('div', 'grid4');
    for (const k of ['x', 'y', 'w', 'h']) {
      pos.append(field(k.toUpperCase(), textInput(w[k], v => { w[k] = Math.max(0, +v || 0); applyGeometry(w); markDirty(); }, 'number')));
    }
    box.append(pos);
    if (w.parent) box.append(placeField(w));
    // innstillinger kan avhenge av andre (showIf); en endret liste eller avkrysning tegner panelet på nytt
    const conditional = !!def && def.props.some(x => x.showIf);
    if (def) for (const p of def.props) {
      if (p.showIf && !p.showIf(w.props)) continue;
      try {
      let input;
      const commit = v => { w.props[p.key] = v; markDirty(); remountWidget(w); };
      if (p.type === 'select') {
        input = el('select');
        for (const o of p.options) { const opt = el('option', null, o); opt.value = o; input.append(opt); }
        input.value = w.props[p.key];
        input.addEventListener('change', () => { commit(input.value); if (conditional) renderInspector(); });
      } else if (p.type === 'bool') {
        const wrap = el('label', 'check');
        input = el('input'); input.type = 'checkbox'; input.checked = !!w.props[p.key];
        input.addEventListener('change', () => { commit(input.checked); if (conditional) renderInspector(); });
        wrap.append(input, document.createTextNode(p.label));
        const row = el('div', 'row');
        row.append(wrap);
        if (p.hint) row.append(el('div', 'hint', p.hint));
        box.append(row);
        continue;
      } else if (p.type === 'number') {
        input = textInput(w.props[p.key], v => commit(v === '' ? '' : Number(v)), 'number');
        input.step = 'any';
      } else if (p.type === 'size') {
        input = sizeSelect(w.props[p.key], commit);
      } else if (p.type === 'codelist') {
        box.append(field(p.label, codeListField(w.props[p.key], v => { commit(v); renderInspector(); }), p.hint));
        continue;
      } else if (p.type === 'color') {
        const line = el('div', 'colorline');
        const pick = el('input');
        pick.type = 'color';
        const cur = w.props[p.key] || '';
        pick.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : (p.fallback || '#f2b441');
        const note = el('span', 'hint', cur || 'theme default');
        const reset = el('button', null, 'Default');
        reset.disabled = !cur;
        pick.addEventListener('input', () => {
          w.props[p.key] = pick.value;
          note.textContent = pick.value;
          reset.disabled = false;
          markDirty();
          // forhåndsvisning uten å bygge widgeten på nytt; aksentfargen er bare en CSS-variabel
          const m = state.mounted.get(w.id);
          if (m && p.key === 'color') m.root.style.setProperty('--accent', pick.value);
        });
        pick.addEventListener('change', () => remountWidget(w));
        reset.addEventListener('click', () => { w.props[p.key] = ''; markDirty(); remountWidget(w); renderInspector(); });
        line.append(pick, note, reset);
        box.append(field(p.label, line, p.hint));
        continue;
      } else if (p.type === 'asset') {
        box.append(assetField(p, w, commit));
        continue;
      } else if (p.type === 'tabs') {
        box.append(tabsField(p, w));
        continue;
      } else if (p.type === 'inputs') {
        box.append(inputsField(p, w));
        continue;
      } else if (p.type === 'bindings') {
        const n = (w.props[p.key] || []).length;
        const btn = el('button', 'wide', `Edit mappings (${n})`);
        btn.disabled = !w.props.asset;
        btn.addEventListener('click', () => openMappings(w));
        box.append(field(p.label, btn, w.props.asset ? 'Or double-click the widget on the canvas' : 'Choose a drawing first'));
        continue;
      } else if (p.type === 'tag' || p.type === 'tags') {
        box.append(field(p.label, tagField(w.props[p.key], v => commit(v), { multi: p.type === 'tags', onPick: p.type === 'tag' ? text => autoLabel(w, text) : null }), p.hint));
        continue;
      } else if (p.type === 'thresholds') {
        box.append(thresholdsField(p, w));
        continue;
      } else {
        input = textInput(w.props[p.key], v => commit(v));
      }
      box.append(field(p.label, input, p.hint));
      } catch (err) {
        // vis problemet i stedet for feltet, og fortsett å tegne resten av panelet
        console.error(`inspector field "${p.key}"`, err);
        box.append(el('div', 'hint err', `Couldn't show "${p.label}": ${err.message}`));
      }
    }
    const actions = el('div', 'actions');
    const dup = el('button', null, 'Duplicate');
    dup.addEventListener('click', () => {
      const copy = JSON.parse(JSON.stringify(w));
      copy.id = uid(w.type); copy.x += 20; copy.y += 20;
      screen.widgets.push(copy);
      // et kort kopieres med alt som ligger på det
      if (isCard(w)) for (const k of childrenOf(w.id)) screen.widgets.push({ ...JSON.parse(JSON.stringify(k)), id: uid(k.type), parent: copy.id });
      mountWidget(copy); select(copy.id); markDirty();
    });
    const del = el('button', 'danger', 'Delete');
    del.addEventListener('click', () => deleteWidget(w.id));
    actions.append(dup, del);
    box.append(actions);
  }

  // ---- kodetekster: hvilken liste en Value-widget henter tekstene sine fra
  function codeListField(value, onChange) {
    const line = el('div', 'assetline');
    const sel = el('select');
    const none = el('option', null, 'None');
    none.value = '';
    sel.append(none);
    for (const l of H.codes.lists()) {
      const o = el('option', null, `${l.name} (${Object.keys(l.codes).length})`);
      o.value = l.id;
      sel.append(o);
    }
    if (value && !H.codes.list(value)) {   // slettet, eller huben har ikke sendt listene ennå
      const o = el('option', null, `${value} (missing)`);
      o.value = value;
      sel.append(o);
    }
    sel.value = value || '';
    sel.addEventListener('change', () => onChange(sel.value));
    const edit = el('button', null, 'Edit…');
    edit.type = 'button';
    edit.title = 'Add and edit code lists and their texts';
    edit.addEventListener('click', () => openCodeEditor(sel.value));
    line.append(sel, edit);
    return line;
  }

  // ---- fargegrenser: [{ value, color }], holdt sortert etter verdi
  const THRESHOLD_COLOURS = ['#f2b441', '#e5533d', '#c79bf2', '#5cc8e8', '#43c483'];
  function thresholdsField(p, w) {
    const wrap = el('div', 'row');
    wrap.append(el('label', null, p.label));
    const list = Array.isArray(w.props[p.key]) ? w.props[p.key] : (w.props[p.key] = []);
    const commit = () => { markDirty(); remountWidget(w); };
    list.forEach((t, i) => {
      const row = el('div', 'throw');
      const v = textInput(t.value, val => {
        t.value = val === '' ? '' : Number(val);
        list.sort((a, b) => (a.value === '' ? Infinity : a.value) - (b.value === '' ? Infinity : b.value));
        commit();
        renderInspector();
      }, 'number', 'change');
      v.setAttribute('aria-label', 'Threshold value');
      const pick = el('input');
      pick.type = 'color';
      pick.value = /^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : THRESHOLD_COLOURS[0];
      pick.setAttribute('aria-label', 'Colour at or above this value');
      pick.addEventListener('change', () => { t.color = pick.value; commit(); });
      const x = el('button', 'x', '\u2715');
      x.title = 'Remove this threshold';
      x.addEventListener('click', () => { list.splice(i, 1); commit(); renderInspector(); });
      row.append(el('span', 'hint', '\u2265'), v, pick, x);
      wrap.append(row);
    });
    const add = el('button', 'wide', '+ Add threshold');
    add.addEventListener('click', () => {
      const lo = Number(w.props.min) || 0, hi = Number(w.props.max) || 100;
      const last = list.length ? Number(list[list.length - 1].value) : NaN;
      const value = Number.isFinite(last) ? Math.min(hi, last + (hi - lo) / 10) : lo + (hi - lo) * 0.8;
      list.push({ value: Math.round(value * 100) / 100, color: THRESHOLD_COLOURS[list.length % THRESHOLD_COLOURS.length] });
      commit();
      renderInspector();
    });
    wrap.append(add);
    if (p.hint) wrap.append(el('div', 'hint', p.hint));
    return wrap;
  }

  // ---- kort: fanelisten til et kort, og kortet/fanen til en widget som ligger på et
  function tabsField(p, w) {
    const wrap = el('div', 'row');
    wrap.append(el('label', null, p.label));
    const tabs = w.props.tabs;
    const redraw = () => { markDirty(); remountWidget(w); renderInspector(); };
    tabs.forEach((t, i) => {
      const row = el('div', 'tabrow' + (t.id === activeTab(w) ? ' on' : ''));
      const name = textInput(t.name, v => { t.name = v.trim() || t.name; markDirty(); remountWidget(w); }, 'text', 'change');
      const n = childrenOf(w.id, t.id).length;
      const count = el('span', 'hint', String(n));
      count.title = `${n} widget${n === 1 ? '' : 's'} on this tab`;
      const up = el('button', null, '\u2191'); up.title = 'Move left'; up.disabled = i === 0;
      up.addEventListener('click', () => { [tabs[i - 1], tabs[i]] = [tabs[i], tabs[i - 1]]; redraw(); });
      const down = el('button', null, '\u2193'); down.title = 'Move right'; down.disabled = i === tabs.length - 1;
      down.addEventListener('click', () => { [tabs[i + 1], tabs[i]] = [tabs[i], tabs[i + 1]]; redraw(); });
      const del = el('button', 'x', '\u2715'); del.title = 'Delete this tab'; del.disabled = tabs.length === 1;
      del.addEventListener('click', () => {
        if (n && !confirm(`Delete the tab "${t.name}" and the ${n} widget${n === 1 ? '' : 's'} on it?`)) return;
        for (const k of childrenOf(w.id, t.id)) unmountWidget(k.id);
        const screen = currentScreen();
        screen.widgets = screen.widgets.filter(x => !(x.parent === w.id && x.tab === t.id));
        tabs.splice(i, 1);
        redraw();
      });
      name.addEventListener('focus', () => { if (activeTab(w) !== t.id) { showCardTab(w.id, t.id); } });
      row.append(name, count, up, down, del);
      wrap.append(row);
    });
    const add = el('button', 'wide', '+ Add tab');
    add.addEventListener('click', () => {
      const id = 'tab' + Math.random().toString(36).slice(2, 7);
      tabs.push({ id, name: 'Tab ' + (tabs.length + 1) });
      state.cardTab.set(w.id, id);
      redraw();
    });
    wrap.append(add, el('div', 'hint', 'Click a tab on the card to show it. With the card, or a widget on it, selected, new widgets from the palette land on the tab that is showing. Drag widgets onto or off the card.'));
    return wrap;
  }

  function placeField(w) {
    const card = findWidget(w.parent);
    const row = el('div', 'row');
    row.append(el('label', null, `On card "${card.props.title || 'Card'}"`));
    const line = el('div', 'assetline');
    const sel = el('select');
    for (const t of card.props.tabs) { const o = el('option', null, 'Tab: ' + t.name); o.value = t.id; sel.append(o); }
    sel.value = w.tab;
    sel.addEventListener('change', () => {
      unmountWidget(w.id);
      w.tab = sel.value;
      markDirty();
      showCardTab(card.id, w.tab);   // følg den til den nye fanen
      select(w.id);
    });
    const off = el('button', null, 'Move to canvas');
    off.addEventListener('click', () => {
      const abs = absolutePos(w);
      unmountWidget(w.id);
      delete w.parent; delete w.tab;
      w.x = abs.x; w.y = abs.y;
      mountWidget(w); select(w.id); markDirty();
    });
    line.append(sel, off);
    row.append(line, el('div', 'hint', 'X and Y are measured from the top-left of the card'));
    return row;
  }

  // hvor en widget på et kort ligger på lerretet
  function absolutePos(w) {
    const m = state.mounted.get(w.id), canvas = $('#canvas');
    if (m) {
      const cr = canvas.getBoundingClientRect(), r = m.root.getBoundingClientRect();
      return { x: Math.round((r.left - cr.left) / state.scale), y: Math.round((r.top - cr.top) / state.scale) };
    }
    const card = findWidget(w.parent);
    return { x: card.x + w.x, y: card.y + 34 + w.y };
  }

  // ---- tegninger lagret på huben (config/assets)
  let assetList = null;
  function loadAssets(force) {
    if (!assetList || force) {
      assetList = fetch('/api/assets', { cache: 'no-store' }).then(r => (r.ok ? r.json() : [])).catch(() => []);
    }
    return assetList;
  }

  const ASSET_KIND = {
    svg: { rx: /\.svg$/i, accept: '.svg,image/svg+xml', type: 'image/svg+xml', hint: 'Drawings are stored in config/assets next to the project file' },
    js: { rx: /\.js$/i, accept: '.js,text/javascript', type: 'text/javascript', hint: 'Animation code is stored in config/assets next to the project file' },
  };
  async function putAsset(name, body, type) {
    const r = await fetch('/api/assets/' + encodeURIComponent(name), { method: 'PUT', headers: { 'Content-Type': type }, body });
    const res = await r.json();
    if (!r.ok || !res.ok) throw new Error(res.error || r.statusText);
    H.svg.forget(name);
    H.anim.forget(name);
    await loadAssets(true);
  }

  function assetField(p, w, commit) {
    const kind = ASSET_KIND[p.accept || 'svg'];
    const ext = p.accept || 'svg';
    const row = el('div', 'row');
    row.append(el('label', null, p.label));
    const line = el('div', 'assetline');
    const sel = el('select');
    const fill = list => {
      const cur = w.props[p.key] || '';
      sel.innerHTML = '';
      const none = el('option', null, '\u2014 choose \u2014'); none.value = ''; sel.append(none);
      const names = list.map(a => a.name).filter(n => kind.rx.test(n));
      if (cur && !names.includes(cur)) names.unshift(cur);
      for (const n of names) { const o = el('option', null, n); o.value = n; sel.append(o); }
      sel.value = cur;
    };
    fill([]);
    loadAssets().then(fill);
    sel.addEventListener('change', () => { commit(sel.value); renderInspector(); });
    const up = el('button', null, 'Upload\u2026');
    const file = el('input'); file.type = 'file'; file.accept = kind.accept; file.hidden = true;
    up.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      let name = f.name.replace(/[^\w.-]+/g, '_').replace(/^[^\w]+/, '');
      if (!kind.rx.test(name)) name += '.' + ext;
      const existing = (await loadAssets()).some(a => a.name === name);
      if (existing && !confirm(`Replace "${name}" on the hub? Every widget using it will show the new version.`)) return;
      try {
        await putAsset(name, f, kind.type);
        w.props[p.key] = name;
        markDirty();
        renderCanvas(); fitCanvas();
        renderInspector();
        toast(`Uploaded ${name}`);
      } catch (e) { toast('Upload failed: ' + e.message, true); }
    });
    line.append(sel, up, file);
    if (ext === 'js') {
      const nu = el('button', null, 'New\u2026');
      nu.title = 'Start a new snippet from a template';
      nu.addEventListener('click', async () => {
        let name = prompt('Name for the new animation code file', 'animation.js');
        if (!name) return;
        name = name.trim().replace(/[^\w.-]+/g, '_');
        if (!kind.rx.test(name)) name += '.js';
        if ((await loadAssets()).some(a => a.name === name)) return toast(`${name} already exists \u2014 pick it from the list`, true);
        try {
          await putAsset(name, H.anim.STARTER, kind.type);
          w.props[p.key] = name;
          markDirty();
          remountWidget(w);
          renderInspector();
          openAnimCode(w);
        } catch (e) { toast('Could not create the file: ' + e.message, true); }
      });
      line.append(nu);
    }
    row.append(line);
    row.append(el('div', 'hint', kind.hint));
    return row;
  }

  // ---- animasjonswidgeter: hvilken tag som driver hvilken inngang koden deklarerer
  function inputsField(p, w) {
    const wrap = el('div', 'row');
    wrap.append(el('label', null, p.label));
    const m = state.mounted.get(w.id);
    const declared = m && m.handle && m.handle.declared;
    const map = w.props[p.key] || (w.props[p.key] = {});
    const names = declared ? declared.map(d => d.name) : Object.keys(map);
    if (!w.props.asset) wrap.append(el('div', 'hint', 'Choose the code first.'));
    else if (!declared) wrap.append(el('div', 'hint', 'The inputs appear when the code runs and declares them with hmi.inputs().'));
    for (const name of names) {
      const d = declared && declared.find(x => x.name === name);
      const row = el('div', 'inrow');
      row.append(el('span', 'inname', name + (d && d.unit ? ` (${d.unit})` : '')));
      row.append(tagField(map[name] || '', v => {
        const t = v.trim();
        if (t) map[name] = t; else delete map[name];
        markDirty();
        remountWidget(w);
      }, { evt: 'change', placeholder: 'tag' }));
      wrap.append(row);
    }
    const stray = declared ? Object.keys(map).filter(n => !declared.some(d => d.name === n)) : [];
    for (const name of stray) {
      const row = el('div', 'inrow stray');
      row.append(el('span', 'inname', name), el('span', 'hint', `bound to ${map[name]}, but the code no longer declares it`));
      const x = el('button', null, 'Remove');
      x.addEventListener('click', () => { delete map[name]; markDirty(); remountWidget(w); renderInspector(); });
      row.append(x);
      wrap.append(row);
    }
    const btn = el('button', 'wide', 'Edit code');
    btn.disabled = !w.props.asset;
    btn.addEventListener('click', () => openAnimCode(w));
    wrap.append(btn, el('div', 'hint', w.props.asset ? 'Or double-click the widget on the canvas' : ''));
    return wrap;
  }

  async function openAnimCode(w) {
    const name = w.props.asset;
    if (!name) return toast('Choose or create the code first', true);
    let code;
    try { code = await H.anim.load(name); } catch (e) { return toast(e.message, true); }
    H.openAnimEditor({
      name, code,
      colors: H.anim.themeColors(w.props.color),
      boundTag: input => resolveTag((w.props.inputs || {})[input] || ''),
      live: tag => { const v = state.values.get(tag); return v ? v.value : undefined; },
      async save(text) {
        await putAsset(name, text, 'text/javascript');
        for (const m of [...state.mounted.values()]) if (m.widget.props.asset === name) remountWidget(m.widget);
        renderInspector();
      },
    });
  }

  function openMappings(w) {
    if (!w.props.asset) return toast('Choose a drawing first', true);
    H.openMappingEditor(w, {
      resolveTag,
      tagExists: name => state.tags.has(name),
      tagInfo: name => state.tags.get(name),
      browseTags,
      onSave(bindings) {
        w.props.bindings = bindings;
        markDirty();
        remountWidget(w);
        renderInspector();
        toast(`${bindings.length} mapping${bindings.length === 1 ? '' : 's'} applied \u2014 press Save to store them`);
      },
    });
  }

  function refreshTagList() {
    const dl = $('#taglist');
    dl.innerHTML = '';
    for (const name of [...state.tags.keys()].sort()) {
      const o = el('option');
      o.value = name;
      const info = state.tags.get(name);
      if (info && info.source === 'calc') o.label = '\u0192 ' + (info.formula || 'calculated');
      dl.append(o);
    }
    const insp = $('#inspector');
    if (!state.selected && state.mode === 'edit' && !(document.activeElement && insp.contains(document.activeElement))) renderInspector();
  }

  // ================================================================ redigering
  // at = { x, y, card } plasserer den der (fra høyreklikkmenyen); ellers legges de trappevis
  function addWidget(type, at) {
    const def = H.widgets[type];
    const screen = currentScreen();
    // med et kort, eller en widget på et kort, valgt: den nye widgeten havner i fanen som vises på kortet
    const sel = state.selected && findWidget(state.selected);
    let parent = null;
    if (at) parent = type !== 'card' && at.card ? at.card : null;
    else if (type !== 'card' && sel) parent = isCard(sel) ? sel : sel.parent ? findWidget(sel.parent) : null;
    const siblings = parent ? childrenOf(parent.id, activeTab(parent)).length : screen.widgets.filter(x => !x.parent).length;
    const step = parent ? 20 : 30, start = parent ? 10 : 20;
    const w = { id: uid(type), type, x: start + (siblings % 8) * step, y: start + (siblings % 8) * step, w: def.size[0], h: def.size[1], props: {} };
    if (at) { w.x = Math.max(0, snap(at.x)); w.y = Math.max(0, snap(at.y)); }
    if (parent) { w.parent = parent.id; w.tab = activeTab(parent); }
    for (const p of def.props) w.props[p.key] = copyDefault(p.default);
    screen.widgets.push(w);
    mountWidget(w);
    select(w.id);
    markDirty();
  }

  function deleteWidget(id) { deleteWidgets([id]); }
  function deleteWidgets(ids) {
    const screen = currentScreen();
    const gone = new Set();
    for (const id of ids) { gone.add(id); if (isCard(findWidget(id))) for (const k of childrenOf(id)) gone.add(k.id); }
    const extra = gone.size - ids.length;
    if (ids.length > 1 || extra > 0) {
      const what = ids.length > 1 ? `${ids.length} widgets` : `the card "${findWidget(ids[0]).props.title || 'Card'}"`;
      if (!confirm(`Delete ${what}${extra ? ` and the ${extra} widget${extra === 1 ? '' : 's'} on ${ids.length > 1 ? 'their cards' : 'it'}` : ''}?`)) return;
    }
    for (const id of ids) unmountWidget(id);
    screen.widgets = screen.widgets.filter(x => !gone.has(x.id));
    select(null);
    markDirty();
  }

  // state.selection har alle valgte widgeter; state.selected er satt når nøyaktig én er valgt
  function select(id) { setSelection(id ? [id] : []); }
  function setSelection(ids, redraw = true) {
    state.selection = new Set(ids.filter(id => findWidget(id)));
    state.selected = state.selection.size === 1 ? [...state.selection][0] : null;
    for (const [wid, m] of state.mounted) m.root.classList.toggle('selected', state.selection.has(wid));
    if (redraw) renderInspector();
  }
  // hva som flyttes når et utvalg flyttes: en widget på et kort som selv er valgt, flyttes med kortet
  function movers() {
    return [...state.selection].map(findWidget).filter(w => w && !(w.parent && state.selection.has(w.parent)));
  }

  function applyGeometry(w) {
    const m = state.mounted.get(w.id);
    if (m) Object.assign(m.root.style, { left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px' });
  }

  const snap = v => Math.round(v / GRID) * GRID;

  // kortet som har innholdsflaten under et skjermpunkt (kort kan ikke legges i kort)
  function cardBodyAt(cx, cy, exceptId) {
    for (const [id, m] of state.mounted) {
      if (id === exceptId || !isCard(m.widget) || !m.handle.body) continue;
      const r = m.handle.body.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return m.widget;
    }
    return null;
  }
  // et skjermpunkt som en posisjon på lerretet, eller inne i innholdsflaten til et kort
  function pointIn(cx, cy, card) {
    const box = card ? state.mounted.get(card.id).handle.body : $('#canvas');
    const r = box.getBoundingClientRect();
    return { x: (cx - r.left) / state.scale, y: (cy - r.top) / state.scale, card: card || null };
  }

  // ================================================================ kopiere, lime inn, duplisere, rekkefølge
  // Utklippstavlen har dype kopier med posisjonene på lerretet, så de kan limes inn
  // hvor som helst: et annet sted, et annet skjermbilde, på et kort eller utenfor.
  function copySelection() {
    const items = movers();
    if (!items.length) return 0;
    const all = currentScreen().widgets;
    state.clipboard = items.map(w => ({
      w: JSON.parse(JSON.stringify(w)),
      abs: w.parent ? absolutePos(w) : { x: w.x, y: w.y },
      kids: isCard(w) ? all.filter(k => k.parent === w.id).map(k => JSON.parse(JSON.stringify(k))) : [],
    }));
    state.pasteCount = 0;
    return items.length;
  }
  // at: { x, y, card } fra høyreklikkmenyen; uten den havner hver innliming 20 px lenger bort
  function paste(at) {
    const clip = state.clipboard;
    if (!clip || !clip.length) return;
    const screen = currentScreen();
    const minX = Math.min(...clip.map(c => c.abs.x)), minY = Math.min(...clip.map(c => c.abs.y));
    const shift = 20 * (++state.pasteCount);
    const ids = [];
    for (const c of clip) {
      const w = JSON.parse(JSON.stringify(c.w));
      w.id = uid(w.type);
      delete w.parent; delete w.tab;
      const onCard = at && at.card && !isCard(w) ? at.card : null;
      if (at) { w.x = at.x + (c.abs.x - minX); w.y = at.y + (c.abs.y - minY); }
      else { w.x = c.abs.x + shift; w.y = c.abs.y + shift; }
      if (onCard) { w.parent = onCard.id; w.tab = activeTab(onCard); }
      else if (at && at.card && isCard(w)) {               // et kort limt inn på et kort havner på lerretet der
        const abs = absolutePos({ parent: at.card.id, x: at.x, y: at.y });
        w.x = abs.x + (c.abs.x - minX); w.y = abs.y + (c.abs.y - minY);
      }
      w.x = Math.max(0, snap(w.x)); w.y = Math.max(0, snap(w.y));
      screen.widgets.push(w);
      for (const k of c.kids) screen.widgets.push({ ...JSON.parse(JSON.stringify(k)), id: uid(k.type), parent: w.id });
      mountWidget(w);
      ids.push(w.id);
    }
    setSelection(ids);
    markDirty();
  }
  function duplicateSelection() {
    const items = movers();
    if (!items.length) return;
    const screen = currentScreen(), ids = [];
    for (const src of items) {
      const w = JSON.parse(JSON.stringify(src));
      w.id = uid(w.type); w.x += 20; w.y += 20;
      screen.widgets.push(w);
      if (isCard(src)) for (const k of childrenOf(src.id)) screen.widgets.push({ ...JSON.parse(JSON.stringify(k)), id: uid(k.type), parent: w.id });
      mountWidget(w);
      ids.push(w.id);
    }
    setSelection(ids);
    markDirty();
  }
  function cutSelection() { if (copySelection()) deleteWidgets([...state.selection]); }
  // forrest = tegnes sist; rekkefølgen er rekkefølgen i skjermbildets widgetliste
  function reorder(toFront) {
    const screen = currentScreen();
    const chosen = new Set(movers().map(w => w.id));
    const picked = screen.widgets.filter(w => chosen.has(w.id)), rest = screen.widgets.filter(w => !chosen.has(w.id));
    screen.widgets = toFront ? rest.concat(picked) : picked.concat(rest);
    renderCanvas();
    markDirty();
  }
  function moveToCanvas() {
    for (const w of movers().filter(w => w.parent)) {
      const abs = absolutePos(w);
      unmountWidget(w.id);
      delete w.parent; delete w.tab;
      w.x = abs.x; w.y = abs.y;
      mountWidget(w);
    }
    setSelection([...state.selection]);
    markDirty();
  }

  // ================================================================ høyreklikkmeny (Edit-modus)
  let menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    window.removeEventListener('blur', closeMenu);
    window.removeEventListener('resize', closeMenu);
  }
  function onOutside(e) { if (menu && !menu.contains(e.target)) closeMenu(); }
  function onMenuKey(e) {
    if (!menu) return;
    const items = [...menu.querySelectorAll('.ctxitem:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    else if (e.key === 'ArrowRight' && document.activeElement && document.activeElement.classList.contains('sub')) { e.preventDefault(); document.activeElement.click(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && menu.querySelector('.ctxitem.back')) { e.preventDefault(); menu.querySelector('.ctxitem.back').click(); }
  }
  function fillMenu(items) {
    menu.innerHTML = '';
    for (const it of items) {
      if (it === '-') { menu.append(el('div', 'ctxsep')); continue; }
      if (it.title) { menu.append(el('div', 'ctxtitle', it.title)); continue; }
      const b = el('button', 'ctxitem' + (it.danger ? ' danger' : '') + (it.sub ? ' sub' : '') + (it.back ? ' back' : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.append(el('span', null, it.label));
      if (it.key) b.append(el('span', 'ctxkey', it.key));
      if (it.sub) b.append(el('span', 'ctxkey', '\u203a'));
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => {
        if (it.sub || it.back) { fillMenu((it.sub || it.back)()); place(); focusFirst(); return; }
        closeMenu();
        it.run();
      });
      menu.append(b);
    }
  }
  let menuAt = { x: 0, y: 0 };
  function place() {
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(menuAt.x, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(menuAt.y, innerHeight - r.height - 4)) + 'px';
  }
  const focusFirst = () => { const f = menu.querySelector('.ctxitem:not(:disabled)'); if (f) f.focus(); };
  function openMenu(x, y, items) {
    closeMenu();
    menu = el('div', 'ctxmenu');
    menu.setAttribute('role', 'menu');
    menuAt = { x, y };
    document.body.append(menu);
    fillMenu(items);
    place();
    focusFirst();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  }
  const ctrl = /Mac/.test(navigator.platform) ? '\u2318' : 'Ctrl+';
  function addItems(at, back) {
    return [{ label: 'Back', back }, '-'].concat(Object.keys(H.widgets)
      .filter(type => !(at.card && type === 'card'))
      .map(type => ({ label: H.widgets[type].name, run: () => addWidget(type, at) })));
  }
  function menuFor(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const root = hit && hit.closest('.widget');
    const w = root && findWidget(root.dataset.id);
    const card = cardBodyAt(e.clientX, e.clientY);
    const at = pointIn(e.clientX, e.clientY, card);
    const canPaste = !!(state.clipboard && state.clipboard.length);
    const addSub = { label: card ? 'Add widget to this card here' : 'Add widget here', sub: () => addItems(at, () => menuFor(e)) };
    // på tomt lerret, eller på den tomme delen av innholdsflaten til et kort
    if (!w || (isCard(w) && card && hit.closest('.card-body') && !hit.closest('.card-body .widget'))) {
      const items = [{ title: card ? `Card \u201c${card.props.title || 'Card'}\u201d` : `Screen \u201c${currentScreen().name}\u201d` },
        { label: 'Paste here', key: ctrl + 'V', disabled: !canPaste, run: () => paste(at) },
        addSub, '-',
        { label: 'Select all', key: ctrl + 'A', run: () => setSelection([...state.mounted.keys()].filter(id => { const x = findWidget(id); return x && !x.parent; })) }];
      if (card) {
        if (!state.selection.has(card.id)) select(card.id);
        items.push('-', { label: 'Delete card', key: 'Del', danger: true, run: () => deleteWidgets([card.id]) });
      }
      return items;
    }
    if (!state.selection.has(w.id)) select(w.id);
    const sel = [...state.selection].map(findWidget).filter(Boolean);
    const one = sel.length === 1 ? sel[0] : null;
    const def = one && H.widgets[one.type];
    const items = [{ title: one ? `${def ? def.name : one.type}${one.props.label || one.props.title ? ' \u00b7 ' + (one.props.label || one.props.title) : ''}` : `${sel.length} widgets` }];
    if (one && one.type === 'svg') items.push({ label: 'Edit mappings\u2026', run: () => openMappings(one) });
    if (one && one.type === 'anim') items.push({ label: 'Edit code\u2026', run: () => openAnimCode(one) });
    items.push(
      { label: 'Cut', key: ctrl + 'X', run: cutSelection },
      { label: 'Copy', key: ctrl + 'C', run: copySelection },
      { label: 'Paste here', key: ctrl + 'V', disabled: !canPaste, run: () => paste(at) },
      { label: 'Duplicate', key: ctrl + 'D', run: duplicateSelection },
      '-',
      { label: 'Bring to front', run: () => reorder(true) },
      { label: 'Send to back', run: () => reorder(false) });
    if (sel.some(x => x.parent && !state.selection.has(x.parent))) items.push({ label: 'Move to canvas', run: moveToCanvas });
    items.push('-', { label: sel.length > 1 ? `Delete ${sel.length} widgets` : 'Delete', key: 'Del', danger: true, run: () => deleteWidgets(sel.map(x => x.id)) });
    return items;
  }

  function setupCanvasInteraction() {
    const canvas = $('#canvas');
    let drag = null;       // flytting eller endring av størrelse
    let box = null;        // utvalgsboks med Shift-dra
    canvas.addEventListener('dblclick', e => {
      if (state.mode !== 'edit') return;
      // lerretet holder pekerfangsten mens det dras, så finn widgeten under markøren
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const root = hit && hit.closest('.widget');
      const w = root && currentScreen().widgets.find(x => x.id === root.dataset.id);
      if (w && w.type === 'svg') openMappings(w);
      if (w && w.type === 'anim') openAnimCode(w);
      if (w && w.type === 'value' && w.props.codeList) openCodeEditor(w.props.codeList);
    });

    canvas.addEventListener('contextmenu', e => {
      if (state.mode !== 'edit') return;      // Run-modus beholder nettleserens egen meny
      e.preventDefault();
      openMenu(e.clientX, e.clientY, menuFor(e));
    });
    canvas.addEventListener('pointerdown', e => {
      if (state.mode !== 'edit' || e.button !== 0) return;
      const root = e.target.closest('.widget');
      const w = root && currentScreen().widgets.find(x => x.id === root.dataset.id);
      if (e.shiftKey) {
        // Shift: et klikk legger til eller fjerner én widget, et drag tegner en utvalgsboks
        const cr = canvas.getBoundingClientRect();
        box = { sx: e.clientX, sy: e.clientY, cr, hit: w, base: new Set(state.selection), el: null, moved: false };
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (!w) { select(null); return; }
      const resize = e.target.classList.contains('handle');
      const group = !resize && state.selection.size > 1 && state.selection.has(w.id);
      if (!group && !(state.selection.size === 1 && state.selected === w.id)) select(w.id);
      const m = state.mounted.get(w.id);
      drag = {
        w, root: m ? m.root : root, resize, sx: e.clientX, sy: e.clientY, x: w.x, y: w.y, ww: w.w, wh: w.h,
        moved: false, floating: false, target: null,
        group: group ? movers().map(x => ({ w: x, x: x.x, y: x.y })) : null,
      };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    // kortet som har innholdsflaten under pekeren (kort kan ikke legges i kort)
    const cardAt = cardBodyAt;
    const markTarget = card => {
      for (const m of state.mounted.values()) if (isCard(m.widget)) m.root.classList.toggle('drop-target', !!card && m.widget.id === card.id);
    };
    // widgeter som boksen berører; et kort bare når boksen rommer hele kortet
    const inBox = (l, t, r, b) => {
      const ids = [];
      for (const [id, m] of state.mounted) {
        const q = m.root.getBoundingClientRect();
        const touches = q.left < r && q.right > l && q.top < b && q.bottom > t;
        const holds = q.left >= l && q.right <= r && q.top >= t && q.bottom <= b;
        if (isCard(m.widget) ? holds : touches) ids.push(id);
      }
      return ids;
    };

    canvas.addEventListener('pointermove', e => {
      if (box) {
        if (e.buttons === 0) { finishBox(e); return; }
        if (!box.moved && Math.abs(e.clientX - box.sx) < 3 && Math.abs(e.clientY - box.sy) < 3) return;
        box.moved = true;
        const l = Math.min(box.sx, e.clientX), t = Math.min(box.sy, e.clientY), r = Math.max(box.sx, e.clientX), b = Math.max(box.sy, e.clientY);
        if (!box.el) { box.el = el('div', 'marquee'); canvas.append(box.el); }
        Object.assign(box.el.style, {
          left: (l - box.cr.left) / state.scale + 'px', top: (t - box.cr.top) / state.scale + 'px',
          width: (r - l) / state.scale + 'px', height: (b - t) / state.scale + 'px',
        });
        setSelection([...box.base, ...inBox(l, t, r, b)], false);
        return;
      }
      if (!drag) return;
      if (e.buttons === 0) { end(); return; }   // knappen ble sluppet uten at vi fikk beskjed
      const dx = (e.clientX - drag.sx) / state.scale, dy = (e.clientY - drag.sy) / state.scale;
      if (!drag.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      drag.moved = true;
      if (drag.group) {                // flere widgeter: samme forskyvning for alle, hver blir i sin beholder
        const ox = snap(dx), oy = snap(dy);
        for (const g of drag.group) { g.w.x = Math.max(0, g.x + ox); g.w.y = Math.max(0, g.y + oy); applyGeometry(g.w); }
        return;
      }
      if (drag.resize) {
        drag.w.w = Math.max(40, snap(drag.ww + dx));
        drag.w.h = Math.max(30, snap(drag.wh + dy));
        applyGeometry(drag.w);
        return;
      }
      if (isCard(drag.w)) {           // kort flyttes på lerretet og tar med seg widgetene sine
        drag.w.x = Math.max(0, snap(drag.x + dx));
        drag.w.y = Math.max(0, snap(drag.y + dy));
        applyGeometry(drag.w);
        return;
      }
      // alle andre widgeter flyter på lerretet mens de dras, så de kan forlate eller gå inn i et kort
      if (!drag.floating) {
        const abs = absolutePos(drag.w);
        drag.x = abs.x; drag.y = abs.y;
        if (drag.root.parentElement !== canvas) canvas.append(drag.root);
        drag.root.classList.add('floating');
        drag.floating = true;
      }
      Object.assign(drag.root.style, { left: Math.max(0, snap(drag.x + dx)) + 'px', top: Math.max(0, snap(drag.y + dy)) + 'px' });
      drag.target = cardAt(e.clientX, e.clientY, drag.w.id);
      markTarget(drag.target);
    });

    function finishBox() {
      const b = box;
      box = null;                      // først, så ingenting nedenfor kan la den stå halvåpen
      if (b.el) b.el.remove();
      if (!b.moved) {                  // Shift-klikk: legg til eller fjern widgeten under pekeren
        const ids = new Set(b.base);
        if (b.hit) { if (ids.has(b.hit.id)) ids.delete(b.hit.id); else ids.add(b.hit.id); }
        setSelection([...ids]);
      } else setSelection([...state.selection]);
    }

    function end() {
      const d = drag;
      drag = null;                     // først, så en feil nedenfor aldri kan la et drag fortsette
      if (!d) return;
      try {
        if (d.floating) {
          const w = d.w, target = d.target;
          const ax = parseFloat(d.root.style.left), ay = parseFloat(d.root.style.top);
          if (target) {
            const tm = state.mounted.get(target.id), cr = canvas.getBoundingClientRect(), br = tm.handle.body.getBoundingClientRect();
            w.parent = target.id;
            w.tab = tm.handle.activeTab;
            w.x = Math.max(0, snap(ax - (br.left - cr.left) / state.scale));
            w.y = Math.max(0, snap(ay - (br.top - cr.top) / state.scale));
          } else {
            delete w.parent; delete w.tab;
            w.x = Math.max(0, snap(ax)); w.y = Math.max(0, snap(ay));
          }
          remountWidget(w);
          select(w.id);
        }
        if (d.moved) { markDirty(); renderInspector(); }
      } finally {
        markTarget(null);
      }
    }
    const stop = e => { if (box) finishBox(e); else end(); };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('lostpointercapture', stop);

    document.addEventListener('keydown', e => {
      if (state.mode !== 'edit') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.querySelector('.mm-overlay')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v', 'd'].includes(k)) {
        if (k === 'v') { e.preventDefault(); paste(); return; }
        if (!state.selection.size) return;
        e.preventDefault();
        if (k === 'c') copySelection(); else if (k === 'x') cutSelection(); else duplicateSelection();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelection([...state.mounted.keys()].filter(id => { const w = findWidget(id); return w && !w.parent; }));
        return;
      }
      if (!state.selection.size) return;
      const step = e.shiftKey ? 1 : GRID;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteWidgets([...state.selection]); }
      else if (e.key === 'Escape') select(null);
      else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        for (const w of movers()) {
          if (e.key === 'ArrowLeft') w.x = Math.max(0, w.x - step);
          if (e.key === 'ArrowRight') w.x += step;
          if (e.key === 'ArrowUp') w.y = Math.max(0, w.y - step);
          if (e.key === 'ArrowDown') w.y += step;
          applyGeometry(w);
        }
        markDirty(); renderInspector();
      }
    });
  }

  // Et spørsmål før en kontroll sender, for kommandoer som starter eller nullstiller noe. Fokus
  // starter på Cancel, så et tilfeldig Enter ikke sender; gir true bare for OK-knappen.
  function askConfirm({ title, message, ok = 'OK' }) {
    return new Promise(resolve => {
      const overlay = el('div', 'mm-overlay');
      const box = el('div', 'mm askbox');
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', title || 'Confirm');
      box.append(el('h2', null, title || 'Confirm'), el('p', 'askmsg', message));
      const actions = el('div', 'mm-actions');
      const cancel = el('button', 'ghost', 'Cancel');
      const go = el('button', 'primary', ok);
      actions.append(cancel, go);
      box.append(actions);
      overlay.append(box);
      document.body.append(overlay);
      const done = result => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(result); };
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(false); } };
      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => done(false));
      go.addEventListener('click', () => done(true));
      overlay.addEventListener('pointerdown', e => { if (e.target === overlay) done(false); });
      cancel.focus();
    });
  }

  // Edit bak en passkode: en sperre mot å bytte ved et uhell, ikke en lås
  function askEditCode(title = 'Switch to Edit', okText = 'Edit') {
    return new Promise(resolve => {
      const overlay = el('div', 'mm-overlay');
      const box = el('form', 'mm codebox');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', 'Edit pass-code');
      box.append(el('h2', null, title));
      const input = el('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', 'Pass-code');
      input.placeholder = 'Pass-code';
      const msg = el('div', 'codemsg');
      const actions = el('div', 'mm-actions');
      const cancel = el('button', 'ghost', 'Cancel');
      cancel.type = 'button';
      const ok = el('button', 'primary', okText);
      ok.type = 'submit';
      actions.append(cancel, ok);
      box.append(input, msg, actions);
      overlay.append(box);
      document.body.append(overlay);
      input.focus();
      const done = result => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(result); };
      const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(false); } };
      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => done(false));
      overlay.addEventListener('pointerdown', e => { if (e.target === overlay) done(false); });
      box.addEventListener('submit', e => {
        e.preventDefault();
        if (input.value.trim() === state.config.editCode) return done(true);
        msg.textContent = 'Wrong pass-code';
        box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
        input.select();
      });
    });
  }
  async function enterEdit() {
    if (state.mode === 'edit') return;
    if (state.config.editCode && !(await askEditCode())) return;
    setMode('edit');
  }

  function setMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('run', mode === 'run');
    document.body.classList.toggle('edit', mode === 'edit');
    $('#mode-edit').classList.toggle('on', mode === 'edit');
    $('#mode-run').classList.toggle('on', mode === 'run');
    $('#mode-edit').setAttribute('aria-pressed', String(mode === 'edit'));
    $('#mode-run').setAttribute('aria-pressed', String(mode === 'run'));
    if (mode === 'run') { state.selected = null; state.selection.clear(); }
    renderCanvas();
    renderInspector();
    fitCanvas();
  }

  // ================================================================ forbindelse til huben
  function hubUrl() {
    if (state.config.hub.url) return state.config.hub.url;
    if (location.host) return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    return 'ws://localhost:8080';
  }

  function send(msg) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    state.ws.send(JSON.stringify(msg));
    return true;
  }

  function setConn(cls, text) {
    const c = $('#conn');
    c.className = 'conn ' + cls;
    c.querySelector('.conn-text').textContent = text;
    c.title = hubUrl();
  }

  function connect() {
    clearTimeout(state.reconnectTimer);
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    const url = hubUrl();
    setConn('wait', 'Connecting');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { setConn('', 'Bad hub URL'); return; }
    state.ws = ws;
    ws.onopen = () => {
      state.connected = true;
      setConn('on', 'Connected');
      send({ type: 'hello', role: 'hmi', name: 'hmi-' + Math.random().toString(36).slice(2, 6) });
      send({ type: 'subscribe', tags: ['*'] });
      for (const m of state.unsent.splice(0)) if (state.requests.has(m.id)) send(m);   // det som ventet
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      state.connected = false;
      setConn('', 'Reconnecting');
      for (const v of state.values.values()) v.quality = 'bad';
      for (const id of state.mounted.keys()) refreshStale(id);
      H.alarms.set(null, { stale: true });   // fortsett å vise listen, merket som utdatert
      state.reconnectTimer = setTimeout(connect, 2500);
    };
    ws.onerror = () => {};
  }

  function onMessage(m) {
    switch (m.type) {
      case 'tags':
        state.tags = new Map((m.tags || []).map(t => [t.name, t]));
        refreshTagList();
        {
          const labels = [...state.tags.values()].filter(t => t.label).map(t => t.name + '=' + t.label).join('|');
          if (labels !== state.labelsKey) { state.labelsKey = labels; for (const w of state.mounted.values()) if (w.handle.relabel) w.handle.relabel(); }
        }
        for (const id of state.mounted.keys()) markCalc(id);
        // widgeter som velger taggene sine med et mønster (Timeline: pls.*): monteres på nytt når
        // mønsteret treffer andre tagger enn sist
        for (const m of [...state.mounted.values()]) {
          const def = H.widgets[m.widget.type];
          if (def && def.byPattern && def.tags(resolved(m.widget), state.tags).filter(Boolean).join('|') !== m.tags.join('|')) remountWidget(m.widget);
        }
        if (state.announceCalcs) {
          state.announceCalcs = false;
          const all = [...state.tags.values()].filter(t => t.source === 'calc');
          const bad = all.filter(t => t.error);
          if (bad.length) toast(`${bad.length} of ${all.length} calculations can\u2019t run: ${bad[0].name} \u2014 ${bad[0].error}`, true);
          else toast(`${all.length} calculation${all.length === 1 ? '' : 's'} running on the hub`);
        }
        break;
      case 'historyRange':
      case 'calcCheck': {
        const r = state.requests.get(m.id);
        if (r) { state.requests.delete(m.id); r(m); }
        break;
      }
      case 'update': {
        state.values.set(m.tag, { value: m.value, ts: m.ts, quality: m.quality || 'good' });
        const ids = state.tagIndex.get(m.tag);
        if (ids) for (const id of ids) {
          const w = state.mounted.get(id);
          if (w && w.handle.update) w.handle.update(m.tag, m.value, m.quality, m.ts);
          refreshStale(id);
        }
        break;
      }
      case 'restored': {
        // eldre punkter som huben har fått tilbake (f.eks. fra PLS-ens ringbuffer): trendene henter dem
        const ids = new Set();
        for (const tag of Object.keys(m.series || {})) for (const id of state.tagIndex.get(tag) || []) ids.add(id);
        for (const id of ids) {
          const w = state.mounted.get(id);
          if (w && w.handle.restored) w.handle.restored(m.series);
        }
        break;
      }
      case 'event':
        state.events.push(m);
        if (state.events.length > 200) state.events.shift();
        for (const w of state.mounted.values()) if (w.handle.event) w.handle.event(m);
        break;
      case 'events':
        state.events = m.events || [];
        for (const w of state.mounted.values()) if (w.handle.event) { w.handle.reset && w.handle.reset(); for (const ev of state.events) w.handle.event(ev); }
        break;
      case 'codes':
        H.codes.set(m.codes);
        if (m.error) toast(m.error, true);
        break;
      case 'alarms':
        H.alarms.set(m.alarms || []);
        break;
      case 'history': {
        const list = state.pendingHistory.get(m.tag) || [];
        state.pendingHistory.delete(m.tag);
        for (const resolve of list) resolve(m.points || []);
        break;
      }
      case 'error':
        toast(m.message, true);
        break;
      default: break;
    }
  }

  // ================================================================ beregninger
  let reqSeq = 0;
  // wait: uten forbindelse venter spørsmålet på den (innenfor timeoutMs), i stedet for å feile med
  // en gang. Siden monterer widgetene før forbindelsen er oppe, og starter i Run-modus når
  // prosjektet har en passkode: en trend spør da om historikken før huben kan svare.
  function request(msg, timeoutMs = 3000, wait = false) {
    return new Promise((resolve, reject) => {
      const id = ++reqSeq;
      state.requests.set(id, resolve);
      if (!send({ ...msg, id })) {
        if (!wait) { state.requests.delete(id); return reject(new Error('not connected to the hub')); }
        state.unsent.push({ ...msg, id });
      }
      setTimeout(() => { if (state.requests.delete(id)) reject(new Error(state.connected ? 'the hub did not answer' : 'not connected to the hub')); }, timeoutMs);
    });
  }

  function openCalcs() {
    H.openCalcEditor({
      calcs: state.config.calcs || [],
      vars: state.config.vars,
      tagNames: () => [...state.tags.keys()],
      tagInfo: name => state.tags.get(name),
      live: name => state.values.get(name),
      check: (formula, names) => request({ type: 'checkCalc', formula, vars: state.config.vars, names }),
      async save(calcs) {
        const before = state.config.calcs;
        state.config.calcs = calcs;
        markDirty();
        state.announceCalcs = true;
        if (!(await saveConfig())) { state.config.calcs = before; state.announceCalcs = false; throw new Error('save failed'); }
        renderInspector();
      },
    });
  }

  // ================================================================ kodetekster
  // Listene ligger på huben (codes.json), ikke i prosjektet: hver endring sendes for seg,
  // så den verken trenger eller gir en Save av layouten.
  async function changeCodes(changes) {
    let r, res = {};
    try {
      r = await fetch('/api/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) });
      res = await r.json();
    } catch (e) { throw new Error(r ? e.message : 'the hub can’t be reached'); }
    if (!r.ok || !res.ok) throw new Error(res.error || r.statusText);
    H.codes.set(res.codes);   // huben sier fra til alle andre HMI-er også
    return res.codes;
  }
  // beskrivelser kan leses av alle; å endre dem i Run-modus spør etter passkoden, hvis den er satt
  function canEditCodes() {
    if (state.mode === 'edit' || !state.config.editCode) return Promise.resolve(true);
    return askEditCode('Edit code texts', 'Continue');
  }
  function openCodeEditor(listId, openKey) {
    H.openCodeEditor({
      listId, openKey,
      canEdit: canEditCodes,
      change: changeCodes,
      usage: id => {
        const out = [];
        for (const s of state.config.screens) for (const w of s.widgets) if (w.props && w.props.codeList === id) out.push(`${w.props.label || 'Value'} (${s.name})`);
        return out;
      },
      onClose: () => { if (state.mode === 'edit') renderInspector(); },
    });
  }
  // ================================================================ alarmer
  // topplinjen: den mest akutte alarmen og hvor mange flere; et klikk åpner listen
  function renderAlarmBar() {
    const bar = $('#alarmbar');
    const s = H.alarms.banner();
    bar.className = 'alarmbar ' + s.cls + (H.alarms.stale() ? ' stale' : '');
    bar.querySelector('.alarmbar-text').textContent = s.text;
    bar.title = H.alarms.stale() ? 'No connection to the hub: the alarms may be out of date' : s.title;
  }
  function openAlarms() {
    H.openAlarmList({ ack: ctx.ack, openCode: (list, value, title) => ctx.openCode(list, value, { title }) });
  }

  // widgeter som viser kodetekster, følger listene når de endres
  function refreshCodeWidgets() {
    for (const m of state.mounted.values()) {
      if (!m.widget.props || !m.widget.props.codeList || !m.handle.update) continue;
      for (const t of m.tags) { const v = state.values.get(t); if (v) m.handle.update(t, v.value, v.quality, v.ts); }
    }
  }

  // ================================================================ diverse
  let toastTimer = null;
  function toast(msg, isError, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || (isError ? 5000 : 2500));
  }

  // ================================================================ oppstart
  async function boot() {
    const source = await loadConfig();
    setupCanvasInteraction();
    $('#mode-edit').addEventListener('click', enterEdit);
    $('#mode-run').addEventListener('click', () => setMode('run'));
    $('#btn-save').addEventListener('click', saveConfig);
    $('#btn-calcs').addEventListener('click', openCalcs);
    $('#btn-data').addEventListener('click', () => browseTags('', undefined, 'Tag list'));
    $('#inspector').addEventListener('change', () => {
      const s = inspectorShown;
      if (s && shownKeys(s.w) !== s.keys) renderInspector();
    });
    $('#btn-codes').addEventListener('click', () => {
      const w = state.selected && findWidget(state.selected);
      openCodeEditor(w && w.props.codeList);
    });
    H.codes.subscribe(refreshCodeWidgets);
    H.alarms.subscribe(renderAlarmBar);
    $('#alarmbar').addEventListener('click', openAlarms);
    renderAlarmBar();
    $('#btn-export').addEventListener('click', exportConfig);
    $('#btn-import').addEventListener('click', () => $('#file-import').click());
    $('#file-import').addEventListener('change', e => { if (e.target.files[0]) importConfig(e.target.files[0]); e.target.value = ''; });
    $('#btn-project').addEventListener('click', () => { if (state.mode === 'edit') select(null); });
    $('#btn-add-screen').addEventListener('click', () => {
      const s = { id: uid('screen'), name: 'Screen ' + (state.config.screens.length + 1), widgets: [] };
      state.config.screens.push(s); state.screenId = s.id; state.selected = null; state.selection.clear(); markDirty(); renderAll();
    });
    window.addEventListener('resize', fitCanvas);
    window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveConfig(); }
    });
    renderAll();
    setMode(state.config.editCode ? 'run' : 'edit');
    connect();
    if (source === 'draft') toast('Restored an unsaved draft from this browser');
    if (source === 'error') toast('The project couldn’t be opened: ' + state.loadError, true, 30000);
  }

  boot();
})();
