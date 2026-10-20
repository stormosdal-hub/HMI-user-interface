/*
 * Databaseleseren, siden. Snakker med db-browser.js (se der for forespørslene).
 *
 * Adresser, så Tilbake virker og en visning kan bokmerkes:
 *   #/table/<name>/rows | structure | manage     #/sql     #/new (en ny tabell, med --write)
 *   #/recording (hva som lagres, reglene, pause)     #/names (dine egne navn på tagger)
 */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  // el('div', { class: 'x', text: 'hi', onclick: fn, title: '…' }, child, …)
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok || j.error) throw new Error(j.error || r.statusText);
    return j;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dbb.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dbb.' + k, JSON.stringify(v)); } catch (e) { /* privat vindu */ } },
  };
  let toastTimer = 0;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 7000 : 3500);
  }

  // ---------------------------------------------------------------- tilstand
  const S = { info: null, objects: [], look: { recorder: false, tags: {}, labels: {} }, readable: store.get('readable', true) };
  const tables = () => S.objects.filter(o => o.type === 'table');
  const views = () => S.objects.filter(o => o.type === 'view');
  const isSystem = n => /^sqlite_/.test(n);
  const RECORDER_TABLES = ['sample', 'rollup', 'event', 'tag', 'batch', 'boot', 'meta'];
  const recorderOwns = n => S.look.recorder && (RECORDER_TABLES.includes(n) || n === 'sqlite_sequence');
  const ABOUT = {
    sample: 'One row per stored value: when (ts), which tag, the value (or text) and its quality q (0 good, 1 uncertain, 2 stale, 3 paused: nothing stored from here until the pause ends). Newest first.',
    rollup: 'Each tag’s lowest and highest value per minute, kept by the recorder at every write, so trends over days are quick.',
    event: 'Alarms, warnings and messages, as the event log showed them.',
    tag: 'Tag names, with your own name (label) and description (info) for each, as set under Tag names. sample and rollup refer to a tag by its number here.',
    batch: 'One row per write to the SD card: which rows it holds. Old data is deleted a whole write at a time.',
    boot: 'Each start of the Pi, so times can be corrected later.',
    meta: 'This database’s own id, when it was made, and the layout version.',
    sqlite_sequence: 'SQLite’s own counters for AUTOINCREMENT ids.',
  };

  // ---------------------------------------------------------------- formatering
  const fmtCount = n => (n === null || n === undefined ? '?' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + ' M' : n >= 1e4 ? Math.round(n / 1e3) + ' k' : String(n));
  const fmtBytes = b => (b === null || b === undefined ? '' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' kB' : b + ' B');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const localTime = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  const TIME_COLUMNS = /^(ts|first_ts|last_ts|written|first_seen)$/;
  const QUALITY = ['good', 'uncertain', 'stale', 'paused'];
  // hva en lagret verdi betyr, når "Readable values" er på: tider, tagnavn, kvalitet
  function readable(table, col, v) {
    if (!S.readable || v === null || v === undefined) return null;
    if (TIME_COLUMNS.test(col) && typeof v === 'number' && v > 1e11) return localTime(v);
    if (table === 'rollup' && col === 'minute' && typeof v === 'number') return localTime(v * 60000);
    if (col === 'tag' && S.look.recorder && (table === 'sample' || table === 'rollup') && S.look.tags[v]) return tagText(v);
    if (col === 'q' && table === 'sample' && QUALITY[v]) return QUALITY[v];
    return null;
  }
  // en lagret tag etter nummeret: navnet, og ditt navn på den
  const tagText = id => S.look.tags[id] + (S.look.labels && S.look.labels[id] ? ` · ${S.look.labels[id]}` : '');
  function cell(table, col, v) {
    const r = readable(table, col, v);
    if (v === null || v === undefined) return el('td', { class: 'null', text: 'NULL' });
    if (r !== null) return el('td', { class: 'read', text: r, title: `${col} = ${v}` });
    return el('td', { class: typeof v === 'number' ? 'num' : '', text: String(v), title: typeof v === 'string' && v.length > 40 ? v : null });
  }

  // ---------------------------------------------------------------- lasting
  async function loadAll() {
    const [info, objects, look] = await Promise.all([api('/api/info'), api('/api/objects'), api('/api/lookups')]);
    S.info = info; S.objects = objects; S.look = look;
    renderTop();
    renderSide();
  }
  function renderTop() {
    const i = S.info;
    $('#dbfile').textContent = `${i.file} · ${fmtBytes(i.bytes + i.walBytes)}`;
    $('#dbfile').title = `${i.file}\nSQLite ${i.sqlite}, ${i.journal} journal, Node ${i.node}`;
    const m = $('#mode');
    m.className = 'mode ' + (i.write ? 'rw' : 'ro');
    m.textContent = i.write ? 'Changes allowed' : 'Read-only';
    m.title = i.write ? 'Started with --write: rows and tables can be changed' : 'Nothing can be changed from here. Start with --write to make changes.';
    document.title = `${i.file.split(/[\\/]/).pop()} · Database browser`;
    // en pause er på: vises på hver side, så den ikke blir glemt
    const pz = $('#paused');
    const n = (i.pauses || []).length;
    pz.hidden = !n;
    pz.textContent = n ? `⏸ Recording paused${n > 1 ? ` (${n})` : ''}` : '';
    pz.title = n ? i.pauses.map(p => `${p.tags === '*' ? 'All tags' : p.tags}, since ${p.since.slice(11, 16)}, ${p.until ? 'until ' + p.until.slice(0, 16) : 'until resumed'}${p.reason ? ': ' + p.reason : ''}`).join('\n') : '';
  }
  function renderSide() {
    const side = $('#side');
    const cur = location.hash;
    side.innerHTML = '';
    const paused = (S.info.pauses || []).length;
    if (S.look.recorder) side.append(el('a', { href: '#/recording', class: 'sqllink' + (cur === '#/recording' ? ' on' : '') }, el('span', { class: 'nm', text: 'Recording' }), el('span', { class: 'n' + (paused ? ' paused' : ''), text: paused ? '⏸ paused' : 'what is stored' })));
    if (S.look.recorder) side.append(el('a', { href: '#/names', class: 'sqllink' + (cur === '#/names' ? ' on' : '') }, el('span', { class: 'nm', text: 'Tag names' }), el('span', { class: 'n', text: 'your names' })));
    side.append(el('a', { href: '#/sql', class: 'sqllink' + (cur === '#/sql' ? ' on' : '') }, el('span', { class: 'nm', text: 'SQL' }), el('span', { class: 'n', text: 'ask anything' })));
    const link = o => {
      const href = `#/table/${encodeURIComponent(o.name)}/rows`;
      const on = cur.startsWith(`#/table/${encodeURIComponent(o.name)}/`);
      return el('a', { href, class: (on ? 'on ' : '') + (isSystem(o.name) ? 'system' : ''), title: `${o.name}: ${o.rows === null ? '' : (o.estimated ? 'about ' : '') + o.rows + ' rows'}${o.bytes ? ', ' + fmtBytes(o.bytes) : ''}` },
        el('span', { class: 'nm', text: o.name }), el('span', { class: 'n', text: `${o.estimated ? '≈' : ''}${fmtCount(o.rows)}` }));
    };
    side.append(el('h2', { text: `Tables (${tables().length})` }), ...tables().map(link));
    if (views().length) side.append(el('h2', { text: `Views (${views().length})` }), ...views().map(link));
    if (S.info.write) side.append(el('button', { class: 'add', type: 'button', text: '+ New table', onclick: () => { location.hash = '#/new'; } }));
  }

  // ---------------------------------------------------------------- ruting
  async function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').map(decodeURIComponent);
    renderSide();
    const main = $('#main');
    main.innerHTML = '';
    try {
      if (parts[0] === 'table' && parts[1]) return await showTable(main, parts[1], parts[2] || 'rows');
      if (parts[0] === 'sql') return showSql(main);
      if (parts[0] === 'recording') return await showRecording(main);
      if (parts[0] === 'names') return await showNames(main);
      if (parts[0] === 'new' && S.info.write) return showNewTable(main);
      showHome(main);
    } catch (e) { main.append(el('p', { class: 'err', text: e.message })); }
  }
  // en side med endringer som ikke er lagret (lagringsreglene, tagnavn): { page, text }
  let unsaved = null;
  window.addEventListener('hashchange', e => {
    if (unsaved && !e.newURL.endsWith(unsaved.page) && !confirm(unsaved.text)) {
      history.replaceState(null, '', unsaved.page);
      return;
    }
    unsaved = null;
    route();
  });
  window.addEventListener('beforeunload', e => { if (unsaved) { e.preventDefault(); e.returnValue = ''; } });

  function showHome(main) {
    const i = S.info;
    main.append(el('h1', { text: i.file.split(/[\\/]/).pop() }),
      el('p', { class: 'desc', text: i.recorder ? 'The recorder’s database. Pick a table on the left, or ask with SQL.' : 'Pick a table on the left, or ask with SQL.' }),
      el('p', { class: 'stats', text: `${fmtBytes(i.bytes)} on disk${i.walBytes ? ` + ${fmtBytes(i.walBytes)} not yet merged (-wal)` : ''} · SQLite ${i.sqlite} · ${tables().length} tables` }));
    const t = el('table', { class: 'grid' }, el('thead', null, el('tr', null, ...['Table', 'Rows', 'Space', 'What it holds'].map(h => el('th', { text: h })))));
    const tb = el('tbody');
    for (const o of [...tables(), ...views()]) {
      tb.append(el('tr', { class: 'click', onclick: () => { location.hash = `#/table/${encodeURIComponent(o.name)}/rows`; } },
        el('td', { text: o.name }), el('td', { class: 'num', text: `${o.estimated ? '≈ ' : ''}${o.rows === null ? '?' : o.rows.toLocaleString()}` }),
        el('td', { class: 'num', text: fmtBytes(o.bytes) }), el('td', { text: (i.recorder && ABOUT[o.name]) || (o.type === 'view' ? 'a view' : ''), class: 'hint' })));
    }
    t.append(tb);
    main.append(el('div', { class: 'section' }, el('div', { class: 'gridwrap' }, t)));
  }

  // ---------------------------------------------------------------- en tabell
  async function showTable(main, name, tab) {
    const info = await api('/api/table?name=' + encodeURIComponent(name));
    const base = `#/table/${encodeURIComponent(name)}`;
    main.append(el('h1', null, name, el('span', { class: 'chip', text: info.type + (info.withoutRowid ? ', without rowid' : '') })));
    if (S.look.recorder && ABOUT[name]) main.append(el('p', { class: 'desc', text: ABOUT[name] }));
    main.append(el('p', { class: 'stats', text: `${info.estimated ? 'about ' : ''}${info.rows === null ? '?' : info.rows.toLocaleString()} rows${info.bytes ? ` · ${fmtBytes(info.bytes)} with its indexes` : ''} · ${info.columns.length} columns` }));
    const tabs = [['rows', 'Rows'], ['structure', 'Structure']];
    if (S.info.write && info.type === 'table') tabs.push(['manage', 'Manage']);
    if (!tabs.some(t => t[0] === tab)) tab = 'rows';   // f.eks. et bokmerket Manage, skrivebeskyttet nå
    main.append(el('nav', { class: 'tabs' }, ...tabs.map(([k, label]) => el('a', { href: `${base}/${k}`, class: k === tab ? 'on' : '', text: label }))));
    const body = el('div');
    main.append(body);
    if (tab === 'structure') return showStructure(body, info);
    if (tab === 'manage' && S.info.write) return showManage(body, info);
    return showRows(body, info);
  }

  // ---- rader: én side om gangen, nyeste først, filtrert med en SQL-betingelse
  function showRows(box, info) {
    const name = info.name;
    const saved = store.get('view.' + name, {});
    const v = { where: saved.where || '', order: saved.order || '', dir: saved.dir || '', offset: 0, limit: saved.limit || 100 };
    const cols = info.columns.map(c => c.name);
    const keep = () => store.set('view.' + name, { where: v.where, order: v.order, dir: v.dir, limit: v.limit });

    // recorderens tabeller: velg en tag og en tid i stedet for å skrive betingelsen
    let helper = null;
    const hasTag = S.look.recorder && cols.includes('tag') && (name === 'sample' || name === 'rollup');
    const timeCol = cols.includes('ts') ? 'ts' : name === 'rollup' ? 'minute' : null;
    if (S.look.recorder && (hasTag || timeCol)) {
      const tagSel = el('select', { 'aria-label': 'Tag' }, el('option', { value: '', text: 'All tags' }),
        ...Object.entries(S.look.tags).sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true })).map(([id]) => el('option', { value: id, text: tagText(id) })));
      const from = el('input', { type: 'datetime-local', 'aria-label': 'From' });
      const to = el('input', { type: 'datetime-local', 'aria-label': 'To' });
      const make = () => {
        const parts = [];
        if (hasTag && tagSel.value) parts.push(`tag = ${tagSel.value}`);
        const t = x => (timeCol === 'minute' ? Math.floor(new Date(x).getTime() / 60000) : new Date(x).getTime());
        if (timeCol && from.value) parts.push(`${timeCol} >= ${t(from.value)}`);
        if (timeCol && to.value) parts.push(`${timeCol} <= ${t(to.value)}`);
        v.where = parts.join(' AND ');
        filter.value = v.where;
        v.offset = 0; keep(); load();
      };
      helper = el('div', { class: 'bar helper' },
        hasTag ? el('label', null, 'Tag', tagSel) : null,
        timeCol ? el('label', null, 'From', from) : null,
        timeCol ? el('label', null, 'To', to) : null,
        el('button', { type: 'button', text: 'Show', onclick: make }),
        el('span', { class: 'hint', text: 'This writes the condition below for you.' }));
    }
    const filter = el('input', { type: 'text', class: 'filter', value: v.where, placeholder: 'A condition in SQL, e.g. value > 1000 AND q = 0', 'aria-label': 'Filter' });
    filter.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    const apply = () => { v.where = filter.value.trim(); v.offset = 0; keep(); load(); };
    const readableBox = el('input', { type: 'checkbox', checked: S.readable });
    readableBox.addEventListener('change', () => { S.readable = readableBox.checked; store.set('readable', S.readable); draw(); });
    const perPage = el('select', { 'aria-label': 'Rows per page' }, ...[50, 100, 500, 1000].map(n => el('option', { value: n, text: `${n} a page`, selected: n === v.limit })));
    perPage.addEventListener('change', () => { v.limit = Number(perPage.value); v.offset = 0; keep(); load(); });
    const exportLink = el('a', { href: '#', text: 'Export CSV', title: 'Every row that matches the filter, as a CSV file (can be big)' });
    exportLink.addEventListener('click', e => {
      e.preventDefault();
      location.href = `/api/export?name=${encodeURIComponent(name)}&readable=${S.readable ? 1 : 0}${v.where ? '&where=' + encodeURIComponent(v.where) : ''}`;
    });
    const bar = el('div', { class: 'bar' },
      filter, el('button', { type: 'button', text: 'Filter', onclick: apply }),
      el('button', { type: 'button', class: 'ghost', text: 'Clear', onclick: () => { filter.value = ''; apply(); } }));
    const bar2 = el('div', { class: 'bar' },
      el('label', { title: 'Times, tag names and quality as words; the stored value shows when you point at it' }, readableBox, 'Readable values'),
      perPage, exportLink, el('span', { class: 'spacer' }),
      S.info.write && info.type === 'table' ? el('button', { type: 'button', text: '+ Add row', onclick: () => rowDialog(info, null, load) }) : null);
    const grid = el('div', { class: 'gridwrap' });
    const pager = el('div', { class: 'pager' });
    const sqlLine = el('details', { class: 'sqlline' }, el('summary', { text: 'The SQL for this page' }), el('pre'));
    box.append(...[helper, bar, bar2, grid, pager, sqlLine].filter(Boolean));

    let data = null;
    async function load() {
      grid.innerHTML = '';
      grid.append(el('p', { class: 'hint', style: 'padding:10px', text: 'Loading…' }));
      try {
        data = await api(`/api/rows?name=${encodeURIComponent(name)}&offset=${v.offset}&limit=${v.limit}` +
          (v.where ? '&where=' + encodeURIComponent(v.where) : '') + (v.order ? `&order=${encodeURIComponent(v.order)}&dir=${v.dir}` : ''));
        draw();
      } catch (e) { grid.innerHTML = ''; grid.append(el('p', { class: 'err', style: 'padding:10px', text: e.message })); pager.innerHTML = ''; }
    }
    function draw() {
      if (!data) return;
      const shown = data.columns.filter(c => c !== '__rowid__');
      const idx = shown.map(c => data.columns.indexOf(c));
      const head = el('tr', null, ...shown.map(c => {
        const on = v.order === c;
        return el('th', { class: 'sortable', title: 'Sort by ' + c, onclick: () => { v.dir = on && v.dir === 'asc' ? 'desc' : 'asc'; v.order = c; v.offset = 0; keep(); load(); } },
          c, on ? el('span', { class: 'arrow', text: v.dir === 'desc' ? '↓' : '↑' }) : null);
      }));
      const tb = el('tbody');
      for (const r of data.rows) {
        const tr = el('tr', { class: 'click', title: S.info.write ? 'Click to see or change this row' : 'Click to see the whole row' }, ...idx.map((i, k) => cell(name, shown[k], r[i])));
        tr.addEventListener('click', () => rowDialog(info, rowObject(data, r), load));
        tb.append(tr);
      }
      grid.innerHTML = '';
      if (!data.rows.length) grid.append(el('p', { class: 'hint', style: 'padding:10px', text: v.where ? 'No row matches the filter.' : 'The table is empty.' }));
      else grid.append(el('table', { class: 'grid' }, el('thead', null, head), tb));
      pager.innerHTML = '';
      const first = data.offset + 1, last = data.offset + data.rows.length;
      pager.append(
        el('button', { type: 'button', text: '« First', disabled: data.offset === 0, onclick: () => { v.offset = 0; load(); } }),
        el('button', { type: 'button', text: '‹ Previous', disabled: data.offset === 0, onclick: () => { v.offset = Math.max(0, v.offset - v.limit); load(); } }),
        el('span', { text: data.rows.length ? `Rows ${first.toLocaleString()}–${last.toLocaleString()}${!v.where && info.rows ? ` of ${info.estimated ? 'about ' : ''}${info.rows.toLocaleString()}` : ''}` : '' }),
        el('button', { type: 'button', text: 'Next ›', disabled: !data.hasMore, onclick: () => { v.offset += v.limit; load(); } }),
        el('span', { class: 'hint', text: `${data.ms} ms${!v.order && data.key ? ' · newest first' : ''}` }));
      sqlLine.querySelector('pre').textContent = data.sql;
    }
    load();
  }
  // en rad som { column: value }, med nøkkelen for å endre den
  function rowObject(data, r) {
    const o = {};
    data.columns.forEach((c, i) => { o[c] = r[i]; });
    return o;
  }

  // ---- én rad: se hele; med --write, endre eller slett den (eller legg til en ny: row = null)
  function rowDialog(info, row, reload) {
    const write = S.info.write && info.type === 'table';
    const isNew = !row;
    const inputs = {};
    const fields = el('div', { class: 'fields' });
    for (const c of info.columns) {
      const val = row ? row[c.name] : undefined;
      const txt = el('input', { type: 'text', value: val === null || val === undefined ? '' : String(val), readonly: !write || c.generated, 'aria-label': c.name,
        placeholder: isNew ? (c.dflt !== null ? `default: ${c.dflt}` : c.pk ? 'automatic' : '') : '' });
      const nul = el('input', { type: 'checkbox', checked: row ? val === null : false, disabled: !write || c.generated, title: 'NULL: no value' });
      nul.addEventListener('change', () => { txt.disabled = nul.checked; });
      txt.disabled = nul.checked;
      inputs[c.name] = { txt, nul, col: c, orig: val };
      fields.append(el('span', { class: 'fname' }, c.name, el('div', { class: 'ftype', text: [c.type, c.pk ? 'primary key' : '', c.notnull ? 'not null' : ''].filter(Boolean).join(', ') })),
        txt, el('label', { class: 'hint' }, nul, 'NULL'));
      const r = row ? readable(info.name, c.name, val) : null;
      if (r !== null) fields.append(el('span'), el('span', { class: 'readable', text: r }));
    }
    // typede verdier: tall forblir tall i INTEGER- og REAL-kolonner
    const valueOf = ({ txt, nul, col }) => {
      if (nul.checked) return null;
      const s = txt.value;
      if (/INT|REAL|FLOA|DOUB|NUM|DEC/i.test(col.type || '') && s.trim() !== '' && !Number.isNaN(Number(s))) return Number(s);
      return s;
    };
    const key = {};
    if (row) for (const k of Object.keys(row)) if (k === '__rowid__' || info.columns.some(c => c.name === k && c.pk)) key[k] = row[k];
    const msg = el('div', { class: 'err' });
    const actions = [];
    if (write && !isNew) actions.push(el('button', { type: 'button', class: 'danger', text: 'Delete row', onclick: async () => {
      if (recorderOwns(info.name) && !confirm(`${info.name} belongs to the recorder. Delete this row anyway?`)) return;
      if (!confirm('Delete this row? This can’t be undone.')) return;
      try { await api('/api/row/delete', { table: info.name, key }); close(); toast('Row deleted'); reload(); refreshSide(); } catch (e) { msg.textContent = e.message; }
    } }));
    actions.push(el('span', { class: 'grow' }));
    actions.push(el('button', { type: 'button', class: 'ghost', text: write ? 'Cancel' : 'Close', onclick: () => close() }));
    if (write) actions.push(el('button', { type: 'button', class: 'primary', text: isNew ? 'Add' : 'Save', onclick: async () => {
      const values = {};
      for (const [n, f] of Object.entries(inputs)) {
        if (f.col.generated) continue;
        if (isNew) { if (f.nul.checked || f.txt.value !== '') values[n] = valueOf(f); }
        else { const nv = valueOf(f); if (nv !== f.orig) values[n] = nv; }
      }
      if (!isNew && !Object.keys(values).length) return close();
      if (!isNew && recorderOwns(info.name) && !confirm(`${info.name} belongs to the recorder. Change this row anyway?`)) return;
      try {
        const r = isNew ? await api('/api/row/insert', { table: info.name, values }) : await api('/api/row/update', { table: info.name, key, values });
        close(); toast(isNew ? 'Row added' : `Saved (${r.changes} row)`); reload(); refreshSide();
      } catch (e) { msg.textContent = e.message; }
    } }));
    const close = dialog(isNew ? `New row in ${info.name}` : `A row of ${info.name}`, [fields, msg], actions);
  }

  // ---- struktur
  function showStructure(box, info) {
    const t = el('table', { class: 'grid' }, el('thead', null, el('tr', null, ...['Column', 'Type', 'Primary key', 'Not null', 'Default'].map(h => el('th', { text: h })))));
    const tb = el('tbody');
    for (const c of info.columns) tb.append(el('tr', null, el('td', { class: 'mono', text: c.name }), el('td', { text: c.type || '' }),
      el('td', { text: c.pk ? (c.pk > 1 ? `yes (${c.pk})` : 'yes') : '' }), el('td', { text: c.notnull ? 'yes' : '' }), el('td', { class: 'mono', text: c.dflt === null ? '' : c.dflt })));
    t.append(tb);
    box.append(el('div', { class: 'section' }, el('h3', { text: 'Columns' }), el('div', { class: 'gridwrap' }, t)));
    if (info.indexes.length) {
      const it = el('table', { class: 'grid' }, el('thead', null, el('tr', null, ...['Index', 'Columns', 'Unique', 'Made by'].map(h => el('th', { text: h })))));
      const ib = el('tbody');
      const by = { c: 'CREATE INDEX', u: 'UNIQUE in the table', pk: 'PRIMARY KEY' };
      for (const ix of info.indexes) ib.append(el('tr', null, el('td', { class: 'mono', text: ix.name }), el('td', { class: 'mono', text: ix.columns.join(', ') }), el('td', { text: ix.unique ? 'yes' : '' }), el('td', { text: by[ix.origin] || ix.origin })));
      it.append(ib);
      box.append(el('div', { class: 'section' }, el('h3', { text: 'Indexes' }), el('div', { class: 'gridwrap' }, it),
        el('p', { class: 'hint', text: 'An index makes looking up rows by those columns fast, and takes space of its own.' })));
    }
    if (info.foreignKeys.length) box.append(el('div', { class: 'section' }, el('h3', { text: 'Refers to' }),
      ...info.foreignKeys.map(f => el('div', { class: 'mono', text: `${f.from} → ${f.table}.${f.to}` }))));
    if (info.triggers.length) box.append(el('div', { class: 'section' }, el('h3', { text: 'Triggers' }), ...info.triggers.map(t2 => el('pre', { class: 'create', text: t2.sql }))));
    box.append(el('div', { class: 'section' }, el('h3', { text: 'How it was made' }), el('pre', { class: 'create', text: info.sql || '(built in)' })));
  }

  // ---- administrere (--write): hver endring vises som SQL før den kjøres
  function showManage(box, info) {
    const n = info.name;
    const qn = s => '"' + String(s).replace(/"/g, '""') + '"';
    if (recorderOwns(n)) box.append(el('div', { class: 'warnbox', text: `The recorder writes to ${n} and relies on how it is made. Changing it while the recorder runs can stop the recording. Stop the recorder first, and press Back up at the top.` }));
    const run = async (sql, { typed } = {}) => {
      if (typed) {
        const answer = prompt(`${sql}\n\nThis can’t be undone. Type the table name (${n}) to go ahead:`);
        if (answer !== n) { if (answer !== null) toast('The name didn’t match: nothing was changed', true); return false; }
      } else if (!confirm(`Run this?\n\n${sql}`)) return false;
      try { await api('/api/sql', { sql }); toast('Done'); await loadAll(); return true; } catch (e) { toast(e.message, true); return false; }
    };
    const card = (title, dangerous, ...kids) => el('div', { class: 'card' + (dangerous ? ' dangerous' : '') }, el('h3', { text: title }), el('div', { class: 'bar' }, ...kids));
    const colSel = () => el('select', null, ...info.columns.map(c => el('option', { value: c.name, text: c.name })));
    const TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'];

    const newName = el('input', { type: 'text', placeholder: 'new name' });
    box.append(card('Rename the table', false, newName, el('button', { type: 'button', text: 'Rename', onclick: async () => {
      if (!newName.value.trim()) return;
      if (await run(`ALTER TABLE ${qn(n)} RENAME TO ${qn(newName.value.trim())};`)) location.hash = `#/table/${encodeURIComponent(newName.value.trim())}/manage`;
    } })));

    const cName = el('input', { type: 'text', placeholder: 'column name' });
    const cType = el('select', null, ...TYPES.map(t => el('option', { text: t })));
    const cDefault = el('input', { type: 'text', placeholder: 'default (optional)' });
    box.append(card('Add a column', false, cName, cType, cDefault, el('button', { type: 'button', text: 'Add', onclick: () => {
      if (!cName.value.trim()) return;
      const d = cDefault.value.trim();
      const lit = d === '' ? '' : ` DEFAULT ${/^-?\d+(\.\d+)?$/.test(d) ? d : `'${d.replace(/'/g, "''")}'`}`;
      run(`ALTER TABLE ${qn(n)} ADD COLUMN ${qn(cName.value.trim())} ${cType.value}${lit};`).then(ok => ok && route());
    } })));

    const rOld = colSel(), rNew = el('input', { type: 'text', placeholder: 'new name' });
    box.append(card('Rename a column', false, rOld, el('span', { text: '→' }), rNew, el('button', { type: 'button', text: 'Rename', onclick: () => {
      if (rNew.value.trim()) run(`ALTER TABLE ${qn(n)} RENAME COLUMN ${qn(rOld.value)} TO ${qn(rNew.value.trim())};`).then(ok => ok && route());
    } })));

    const ixCols = el('span', { class: 'bar' }, ...info.columns.map(c => el('label', null, el('input', { type: 'checkbox', value: c.name }), c.name)));
    const ixUnique = el('input', { type: 'checkbox' });
    box.append(card('Add an index', false, ixCols, el('label', null, ixUnique, 'unique'), el('button', { type: 'button', text: 'Create', onclick: () => {
      const cs = [...ixCols.querySelectorAll('input:checked')].map(x => x.value);
      if (!cs.length) return toast('Tick the columns first', true);
      run(`CREATE ${ixUnique.checked ? 'UNIQUE ' : ''}INDEX ${qn(`${n}_${cs.join('_')}`)} ON ${qn(n)} (${cs.map(qn).join(', ')});`).then(ok => ok && route());
    } })));

    const ownIndexes = info.indexes.filter(ix => ix.origin === 'c');
    if (ownIndexes.length) {
      const ixSel = el('select', null, ...ownIndexes.map(ix => el('option', { value: ix.name, text: `${ix.name} (${ix.columns.join(', ')})` })));
      box.append(card('Remove an index', true, ixSel, el('button', { type: 'button', class: 'danger', text: 'Remove', onclick: () => run(`DROP INDEX ${qn(ixSel.value)};`).then(ok => ok && route()) })));
    }
    const dCol = colSel();
    box.append(card('Remove a column', true, dCol, el('button', { type: 'button', class: 'danger', text: 'Remove', onclick: () => run(`ALTER TABLE ${qn(n)} DROP COLUMN ${qn(dCol.value)};`).then(ok => ok && route()) }),
      el('span', { class: 'hint', text: 'Not possible for a column in the primary key or an index' })));
    box.append(card('Empty the table', true, el('button', { type: 'button', class: 'danger', text: 'Delete every row', onclick: () => run(`DELETE FROM ${qn(n)};`, { typed: true }).then(ok => ok && route()) }),
      el('span', { class: 'hint', text: 'The table stays, with no rows' })));
    box.append(card('Delete the table', true, el('button', { type: 'button', class: 'danger', text: 'Delete the table', onclick: async () => {
      if (await run(`DROP TABLE ${qn(n)};`, { typed: true })) location.hash = '#/';
    } }), el('span', { class: 'hint', text: 'With all its rows and indexes' })));
  }

  // ---- en ny tabell (--write)
  function showNewTable(main) {
    const qn = s => '"' + String(s).replace(/"/g, '""') + '"';
    const TYPES = ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC'];
    const name = el('input', { type: 'text', placeholder: 'table name', 'aria-label': 'Table name' });
    const rows = el('div');
    const preview = el('pre', { class: 'create' });
    const addCol = (c = {}) => {
      const r = el('div', { class: 'colrow' });
      const cn = el('input', { type: 'text', placeholder: 'column name', value: c.name || '' });
      const ct = el('select', null, ...TYPES.map(t => el('option', { text: t, selected: t === c.type })));
      const pk = el('input', { type: 'checkbox', checked: !!c.pk }), nn = el('input', { type: 'checkbox' }), un = el('input', { type: 'checkbox' });
      const df = el('input', { type: 'text', placeholder: 'default' });
      const x = el('button', { type: 'button', class: 'ghost', text: '✕', title: 'Remove this column', onclick: () => { r.remove(); upd(); } });
      r.append(cn, ct, el('label', null, pk, 'key'), el('label', null, nn, 'not null'), el('label', null, un, 'unique'), df, x);
      r._get = () => ({ name: cn.value.trim(), type: ct.value, pk: pk.checked, nn: nn.checked, un: un.checked, df: df.value.trim() });
      r.addEventListener('input', upd); r.addEventListener('change', upd);
      rows.append(r);
      upd();
    };
    function sql() {
      const cs = [...rows.children].map(r => r._get()).filter(c => c.name);
      if (!name.value.trim() || !cs.length) return '';
      const pks = cs.filter(c => c.pk);
      const lines = cs.map(c => {
        let s = `  ${qn(c.name)} ${c.type}`;
        if (pks.length === 1 && c.pk) s += c.type === 'INTEGER' ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY';
        if (c.nn) s += ' NOT NULL';
        if (c.un) s += ' UNIQUE';
        if (c.df) s += ` DEFAULT ${/^-?\d+(\.\d+)?$/.test(c.df) ? c.df : `'${c.df.replace(/'/g, "''")}'`}`;
        return s;
      });
      if (pks.length > 1) lines.push(`  PRIMARY KEY (${pks.map(c => qn(c.name)).join(', ')})`);
      return `CREATE TABLE ${qn(name.value.trim())} (\n${lines.join(',\n')}\n);`;
    }
    function upd() { preview.textContent = sql() || 'Give the table a name and at least one column.'; }
    name.addEventListener('input', upd);
    main.append(el('h1', { text: 'New table' }),
      el('p', { class: 'desc', text: 'A table of your own, in this database. The recorder’s tables are left alone. The SQL below is what will run.' }),
      el('div', { class: 'card' }, el('div', { class: 'bar' }, el('label', null, 'Name', name)), el('h3', { style: 'margin-top:12px', text: 'Columns' }), rows,
        el('button', { type: 'button', class: 'ghost', text: '+ Column', onclick: () => addCol() })),
      el('div', { class: 'section' }, el('h3', { text: 'SQL' }), preview),
      el('div', { class: 'bar', style: 'margin-top:12px' }, el('button', { type: 'button', class: 'primary', text: 'Create the table', onclick: async () => {
        const s = sql();
        if (!s) return toast('Give the table a name and at least one column', true);
        try { await api('/api/sql', { sql: s }); await loadAll(); toast('Table created'); location.hash = `#/table/${encodeURIComponent(name.value.trim())}/rows`; }
        catch (e) { toast(e.message, true); }
      } })));
    addCol({ name: 'id', type: 'INTEGER', pk: true });
    addCol();
  }

  // ---------------------------------------------------------------- lagring
  // Hva recorderen lagrer, hvor mye av hver tag, og reglene som bestemmer det. Reglene
  // redigeres som et utkast og lagres samlet; recorderen plukker opp den lagrede filen selv.
  const MODE_TEXT = { change: 'each change', interval: 'at a fixed interval', ignore: 'nothing (ignored)' };
  // recorderens tagmønstre: ${var} fra prosjektet, * for hva som helst
  const patternsOf = (text, vars) => String(text || '')
    .replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m))
    .split(/[\s,]+/).filter(Boolean)
    .map(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  const secs = s => (s >= 3600 && s % 3600 === 0 ? `${s / 3600} h` : s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);
  // en regel på én linje, med ord
  function ruleText(r) {
    if (r.mode === 'ignore') return 'Not stored';
    if (r.mode === 'interval') return `Every ${secs(r.every || 60)}, changed or not`;
    const p = [];
    p.push(r.deadband !== undefined && r.deadband !== '' && Number(String(r.deadband).replace('%', '')) > 0 ? `Changes of at least ${r.deadband}` : 'Every change');
    if (r.bits) p.push(`only bits ${r.bits}`);
    if (r.ignoreBits) p.push(`not bits ${r.ignoreBits}`);
    if (r.minInterval > 0) p.push(`at most one per ${secs(r.minInterval)}`);
    if (r.maxInterval > 0) p.push(`again after ${secs(r.maxInterval)}`);
    if (r.flickerChanges > 0) p.push(`flicker: over ${r.flickerChanges} in ${r.flickerSeconds} s`);
    return p.join(' · ');
  }

  async function showRecording(main) {
    const [info, stats] = await Promise.all([api('/api/recording'), api('/api/recording/stats')]);
    const draft = JSON.parse(JSON.stringify(info.recording));
    const saved = JSON.stringify(draft);
    const vars = info.vars || {};
    const setDirty = () => {
      const d = JSON.stringify(draft) !== saved;
      unsaved = d ? { page: '#/recording', text: 'The recording rules have changes that aren’t saved. Leave them?' } : null;
      saveBar.hidden = !d;
    };
    const view = store.get('rec.view', { sort: 'h1', filter: '', unrecorded: true });

    // alle tagger vi kjenner til: de lagrede, og hubens
    const byName = new Map();
    for (const t of stats.tags) byName.set(t.name, Object.assign({ onHub: false }, t));
    for (const t of info.hubTags) {
      const s = byName.get(t.name) || { name: t.name, h1: 0, h24: 0, total: 0, last: null };
      byName.set(t.name, Object.assign(s, { onHub: true, online: t.online, unit: t.unit, calc: t.calc, label: t.label || s.label || '' }));
    }
    const allTags = [...byName.values()];
    const compiled = () => draft.rules.map(r => patternsOf(r.tags, vars));
    const ruleOf = (name, c = compiled()) => { for (let i = 0; i < c.length; i++) if (c[i].some(re => re.test(name))) return i; return -1; };

    // ---- siden
    const r = info.recorder;
    const status = [];
    if (!info.hub.ok) status.push(el('span', { class: 'err', text: `No hub: ${info.hub.error}. The tags on the hub and the recorder’s status can’t be shown; what is stored, and the rules, can.` }));
    else if (r.running) status.push(el('span', { class: 'okmsg', text: 'The recorder is running' }), ` · rules in use since ${r.rulesAt}` +
      (r.buffered !== null ? ` · ${r.buffered} values waiting in RAM` : '') + (r.mbPerDay !== null ? ` · about ${r.mbPerDay} MB a day now` : ''));
    else status.push(el('span', { class: 'err', text: 'The recorder isn’t running (no status from it on the hub)' }), '. Start it: node recorder.js');
    if (r.lastWrite) status.push(` · last write ${new Date(r.lastWrite).toLocaleString()}`);
    main.append(el('h1', { text: 'Recording' }),
      el('p', { class: 'desc', text: 'What the recorder stores, and the rules that decide it. A tag is stored only if a rule catches it, and the first rule that does decides how. Saved rules are used within a few seconds, without a restart.' }),
      el('p', { class: 'stats' }, ...status),
      el('p', { class: 'hint mono', text: `Rules file: ${info.file}` }));
    if (info.error) main.append(el('div', { class: 'warnbox', text: `The rules file can’t be read: ${info.error} Saving replaces it; the old file is kept beside it.` }));
    if (!info.exists && info.projectRules) main.append(el('div', { class: 'warnbox', text: 'The rules are still in the project file. The recorder moves them here when it next starts; they are shown below as they are there.' }));
    // et gammelt prosjekt: vis reglene og innstillingene, klare til å lagres her
    if (!info.exists && info.projectRules && Array.isArray(info.projectRules.rules)) {
      const p = JSON.parse(JSON.stringify(info.projectRules));
      draft.rules = p.rules;
      for (const k of ['flushSeconds', 'keepDays', 'maxMB', 'events']) if (p[k] !== undefined) draft[k] = p[k];
    }
    if (info.warnings.length) main.append(el('div', { class: 'warnbox', text: 'Settings in the rules file that are left out: ' + info.warnings.join('; ') }));

    // ---- hvor mye hver tag lagrer
    const tagBox = el('div', { class: 'section' });
    const rulesBox = el('div', { class: 'section' });
    const settingsBox = el('div', { class: 'section' });
    const saveBar = el('div', { class: 'savebar', hidden: true },
      el('span', { text: 'The rules have changes that aren’t saved.' }), el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'ghost', text: 'Discard', onclick: () => { unsaved = null; route(); } }),
      el('button', { type: 'button', class: 'primary', text: 'Save rules', onclick: save }));
    const pauseBox = el('div', { class: 'section' });
    main.append(pauseBox, tagBox, rulesBox, settingsBox, saveBar);

    // ---- pause: med en gang, ikke med Save rules (reglene som redigeres, blir som de er)
    const MINUTES = [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, '24 hours'], [0, 'Until I resume it']];
    const pauseScope = p => (p.tags === '*' ? 'all tags' : p.tags.replace(/\$\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)));
    const whenText = t => { const today = new Date().toDateString() === new Date(t.replace(' ', 'T')).toDateString(); return today ? t.slice(11, 16) : t.slice(0, 16); };
    function renderPause() {
      pauseBox.innerHTML = '';
      const rp = info.recorderPaused;
      if (!info.pauses.length) {
        pauseBox.append(el('div', { class: 'card pause off' }, el('div', { class: 'bar' },
          el('span', { text: info.exists ? 'Recording is on: values are stored as the rules below say.' : 'There are no rules yet, so nothing is recorded.' }),
          el('span', { class: 'spacer' }),
          el('button', { type: 'button', text: '⏸ Pause recording…', disabled: !info.exists, title: 'Stop storing for a while, e.g. during maintenance or tests, so those values aren’t mixed with real ones', onclick: () => pauseDialog() }))));
        if (rp && rp.count > 0) pauseBox.append(el('p', { class: 'hint', text: 'The recorder still says it is paused; it takes this up within a few seconds.' }));
        return;
      }
      for (const p of info.pauses) {
        const until = p.until ? `until ${whenText(p.until)}` : 'until you resume it';
        const act = (label, body, title) => el('button', { type: 'button', class: 'small', text: label, title, onclick: () => pauseAction(Object.assign({ id: p.id }, body)) });
        pauseBox.append(el('div', { class: 'card pause on' },
          el('div', { class: 'bar' },
            el('b', { text: `⏸ Paused: ${pauseScope(p)}` }),
            el('span', { text: `since ${whenText(p.since)}, ${until}` }),
            el('span', { class: 'spacer' }),
            act('+30 min', { action: 'extend', minutes: 30 }, 'Longer: 30 minutes more'),
            act('+1 h', { action: 'extend', minutes: 60 }, 'Longer: an hour more'),
            p.until ? act('No end', { action: 'extend', minutes: 0 }, 'Until you resume it') : null,
            el('button', { type: 'button', class: 'primary small', text: '▶ Resume now', onclick: () => pauseAction({ action: 'end', id: p.id }) })),
          p.reason ? el('div', { class: 'hint', text: `Why: ${p.reason}` }) : null));
      }
      const confirmed = rp && rp.count >= info.pauses.length;
      // spør igjen til recorderen sier den har pauset
      if (!confirmed && info.recorder.running) {
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => { if (location.hash === '#/recording') refreshPauses(); }, 4000);
      }
      pauseBox.append(el('div', { class: 'bar' },
        el('span', { class: confirmed ? 'okmsg' : 'hint', text: confirmed ? `The recorder has paused: ${rp.text}` : info.recorder.running ? 'Waiting for the recorder to take it up (a few seconds)…' : 'The recorder isn’t running; it keeps to this when it starts.' }),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'ghost small', text: '⏸ Pause more…', onclick: () => pauseDialog() })));
    }
    async function refreshPauses() {
      try {
        const fresh = await api('/api/recording');
        Object.assign(info, { pauses: fresh.pauses, recorderPaused: fresh.recorderPaused, recorder: fresh.recorder });
        S.info.pauses = fresh.pauses;
        renderTop(); renderSide(); renderPause();
      } catch (e) { toast(e.message, true); }
    }
    onPausesChanged = refreshPauses;
    let confirmTimer = 0;
    async function pauseAction(body) {
      try { await api('/api/recording/pause', body); }
      catch (e) { toast(e.message, true); return false; }
      toast(body.action === 'start' ? 'Paused. The recorder stops storing within a few seconds.' : body.action === 'end' ? 'Resumed. The recorder stores again within a few seconds.' : 'The pause is longer now.');
      await refreshPauses();
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { if (location.hash === '#/recording') refreshPauses(); }, 4000);   // recorderens svar
      return true;
    }
    function pauseDialog() {
      const all = el('input', { type: 'radio', name: 'scope', checked: true });
      const some = el('input', { type: 'radio', name: 'scope' });
      const tags = el('input', { type: 'text', class: 'mono', style: 'width:100%', placeholder: 'kv_1.*   or   kv_1.speedAct, kv_1.torqueAct' });
      // ett klikk for en hel enhet: delen av tagnavnene før første punktum
      const devices = [...new Set(allTags.map(t => t.name.split('.')[0]).filter(d => d && d !== 'rec'))].sort();
      const devBar = el('div', { class: 'bar', style: 'margin-top:6px' }, el('span', { class: 'hint', text: 'A whole device:' }),
        ...devices.map(d => el('button', { type: 'button', class: 'ghost small mono', text: `${d}.*`, onclick: () => { some.checked = true; tags.value = `${d}.*`; upd(); } })));
      const caught = el('div', { class: 'hint' });
      const len = el('select', null, ...MINUTES.map(([m, label]) => el('option', { value: m, text: label, selected: m === 60 })));
      const reason = el('input', { type: 'text', style: 'width:100%', placeholder: 'e.g. maintenance on kv_1, brake test (optional; kept in the event log)' });
      const upd = () => {
        const c = patternsOf(all.checked ? '*' : tags.value, vars);
        const names = allTags.filter(t => c.some(re => re.test(t.name)) && ruleOf(t.name) >= 0 && draft.rules[ruleOf(t.name)].mode !== 'ignore').map(t => t.name);
        caught.textContent = all.checked ? `Every tag: ${names.length} are recorded now.` : names.length ? `Of the recorded tags, this pauses ${names.length}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` and ${names.length - 8} more` : ''}` : 'This matches none of the tags that are recorded now.';
      };
      for (const x of [all, some]) x.addEventListener('change', upd);
      tags.addEventListener('input', () => { some.checked = !!tags.value.trim() || some.checked; all.checked = !some.checked; upd(); });
      const msg = el('div', { class: 'err' });
      const close = dialog('Pause recording', [
        el('p', { class: 'desc', text: 'While paused, nothing is stored for these tags, and their events and alarms aren’t either. Trends show a gap. The pause and its end are written to the event log, with the reason.' }),
        el('div', { class: 'rfield' }, el('label', null, 'What'), el('div', null,
          el('label', { class: 'line' }, all, ' All tags'),
          el('label', { class: 'line' }, some, ' Only these tags:'), tags, devices.length ? devBar : null, caught)),
        el('div', { class: 'rfield' }, el('label', null, 'For'), el('div', null, len, el('div', { class: 'hint', text: 'It ends by itself then. Resume earlier with Resume now.' }))),
        el('div', { class: 'rfield' }, el('label', null, 'Why'), reason),
        msg,
      ], [
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'ghost', text: 'Cancel', onclick: () => close() }),
        el('button', { type: 'button', class: 'primary', text: '⏸ Pause now', onclick: async () => {
          if (some.checked && !tags.value.trim()) { msg.textContent = 'Name the tags to pause, or pick All tags.'; return; }
          if (await pauseAction({ action: 'start', tags: all.checked ? '*' : tags.value.trim(), minutes: Number(len.value), reason: reason.value.trim() })) close();
        } }),
      ]);
      upd();
    }

    function renderTags() {
      tagBox.innerHTML = '';
      const c = compiled();
      const total24 = allTags.reduce((a, t) => a + (t.h24 || 0), 0) || 1;
      // søkefeltet snevrer dette inn mens du skriver (renderRows)
      const list = allTags.filter(t => view.unrecorded || t.h24 > 0 || (ruleOf(t.name, c) >= 0 && draft.rules[ruleOf(t.name, c)].mode !== 'ignore'));
      const key = view.sort;
      list.sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) : (b[key] || 0) - (a[key] || 0) || a.name.localeCompare(b.name)));
      const filter = el('input', { type: 'text', class: 'filter', value: view.filter, placeholder: 'Find a tag', 'aria-label': 'Find a tag' });
      filter.addEventListener('input', () => { view.filter = filter.value; store.set('rec.view', view); renderRows(); });
      const unrec = el('input', { type: 'checkbox', checked: view.unrecorded });
      unrec.addEventListener('change', () => { view.unrecorded = unrec.checked; store.set('rec.view', view); renderTags(); });
      tagBox.append(el('h3', { text: `What is stored, per tag (${stats.from})` }),
        el('div', { class: 'bar' }, filter, el('label', null, unrec, 'Show tags that aren’t stored')));
      const head = el('tr', null, ...[['name', 'Tag'], [null, 'Stored by'], ['h1', 'Last hour'], ['h24', 'Last 24 h'], ['h24', 'MB a day'], [null, 'Share'], ['last', 'Last stored'], [null, '']]
        .map(([k, label]) => el('th', { class: k ? 'sortable' : '', onclick: k ? () => { view.sort = k; store.set('rec.view', view); renderTags(); } : null }, label, view.sort === k && label !== 'MB a day' ? el('span', { class: 'arrow', text: '↓' }) : null)));
      const tb = el('tbody');
      const wrap = el('div', { class: 'gridwrap' }, el('table', { class: 'grid' }, el('thead', null, head), tb));
      tagBox.append(wrap);
      function renderRows() {
        tb.innerHTML = '';
        const qq = view.filter.trim().toLowerCase();
        for (const t of list.filter(x => !qq || x.name.toLowerCase().includes(qq) || (x.label || '').toLowerCase().includes(qq))) {
          const i = ruleOf(t.name, c), rule = draft.rules[i];
          const by = i < 0 ? el('span', { class: 'hint', text: 'no rule: not stored' }) :
            el('span', { class: rule.mode === 'ignore' ? 'hint' : '' }, el('b', { text: `Rule ${i + 1}` }), ` · ${rule.mode === 'ignore' ? 'ignored' : ruleText(rule)}`);
          const share = (t.h24 || 0) / total24;
          tb.append(el('tr', null,
            el('td', { class: 'mono', title: t.onHub ? (t.online ? 'on the hub now' : 'its device is offline') : 'not on the hub now' }, t.name,
              t.label ? el('span', { class: 'label', text: `  ${t.label}` }) : null, !t.onHub ? el('span', { class: 'hint', text: '  (not on the hub)' }) : null),
            el('td', { class: 'by' }, by),
            el('td', { class: 'num', text: (t.h1 || 0).toLocaleString() }),
            el('td', { class: 'num', text: (t.h24 || 0).toLocaleString() }),
            el('td', { class: 'num', text: t.h24 ? (t.h24 * stats.bytesPerValue / 1e6).toFixed(t.h24 * stats.bytesPerValue > 1e6 ? 1 : 2) : '' }),
            el('td', null, el('span', { class: 'sharebar' }, el('span', { style: `width:${Math.max(share > 0 ? 1 : 0, Math.round(share * 100))}%` })), el('span', { class: 'hint', text: share >= 0.001 ? ` ${(share * 100).toFixed(share < 0.1 ? 1 : 0)} %` : '' })),
            el('td', { class: 'hint', text: t.last ? new Date(t.last).toLocaleString() : '' }),
            el('td', null, el('button', { type: 'button', class: 'ghost small', text: 'Rule…', title: 'Set how this tag is stored', onclick: () => ruleForTag(t.name) }))));
        }
        if (!tb.children.length) tb.append(el('tr', null, el('td', { colspan: 8, class: 'hint', text: 'No tag matches.' })));
      }
      renderRows();
    }

    // ---- reglene, i rekkefølge
    function renderRules() {
      rulesBox.innerHTML = '';
      const c = compiled();
      rulesBox.append(el('h3', { text: 'Rules — the first rule that catches a tag decides' }));
      if (!draft.rules.length) rulesBox.append(el('p', { class: 'hint', text: 'No rules, so nothing is stored. Add one, or press Rule… next to a tag above.' }));
      draft.rules.forEach((rule, i) => {
        const caught = allTags.filter(t => ruleOf(t.name, c) === i).map(t => t.name);
        const matchesAll = allTags.filter(t => c[i].some(re => re.test(t.name))).length;
        const card = el('div', { class: 'card rule ' + rule.mode },
          el('div', { class: 'bar' },
            el('b', { class: 'rnum', text: String(i + 1) }),
            el('span', { class: 'mono rtags', text: rule.tags }),
            el('span', { class: 'spacer' }),
            el('button', { type: 'button', class: 'ghost small', text: 'Edit', onclick: () => editRule(i) }),
            el('button', { type: 'button', class: 'ghost small', text: '↑', title: 'Earlier: checked first', disabled: i === 0, onclick: () => { [draft.rules[i - 1], draft.rules[i]] = [draft.rules[i], draft.rules[i - 1]]; changed(); } }),
            el('button', { type: 'button', class: 'ghost small', text: '↓', title: 'Later', disabled: i === draft.rules.length - 1, onclick: () => { [draft.rules[i + 1], draft.rules[i]] = [draft.rules[i], draft.rules[i + 1]]; changed(); } }),
            el('button', { type: 'button', class: 'ghost small', text: '✕', title: 'Delete this rule', onclick: () => { draft.rules.splice(i, 1); changed(); } })),
          el('div', { class: 'rtext', text: ruleText(rule) }),
          el('div', { class: 'hint', text: caught.length ? `Catches ${caught.length} tag${caught.length === 1 ? '' : 's'}: ${caught.slice(0, 8).join(', ')}${caught.length > 8 ? `, and ${caught.length - 8} more` : ''}` : 'Catches no tag at the moment' }),
          matchesAll > caught.length ? el('div', { class: 'hint', text: `${matchesAll - caught.length} more match, but an earlier rule takes them` }) : null,
          rule.note ? el('div', { class: 'hint', text: rule.note }) : null);
        rulesBox.append(card);
      });
      rulesBox.append(el('button', { type: 'button', class: 'add', text: '+ Add rule', onclick: () => editRule(-1, null, 'Added at the end of the list: an earlier rule that catches the same tags decides for them. Move it up with ↑.', true) }));
    }

    // ---- innstillinger
    function renderSettings() {
      settingsBox.innerHTML = '';
      const numField = (label, key, hint) => {
        const i = el('input', { type: 'number', min: '0', step: 'any', value: draft[key] });
        i.addEventListener('input', () => { draft[key] = i.value === '' ? '' : Number(i.value); setDirty(); });
        return el('label', { class: 'set', title: hint }, label, i);
      };
      const ev = el('input', { type: 'checkbox', checked: draft.events !== false });
      ev.addEventListener('change', () => { draft.events = ev.checked; setDirty(); });
      settingsBox.append(el('h3', { text: 'Settings' }), el('div', { class: 'bar' },
        numField('Write to the SD card every (s)', 'flushSeconds', 'Values wait in RAM and are written together. A power cut loses at most this much.'),
        numField('Keep for (days)', 'keepDays', 'Older data is deleted'),
        numField('Size limit (MB)', 'maxMB', 'Past this, the oldest data is deleted'),
        el('label', null, ev, 'Store alarms, warnings and messages')));
    }

    function changed() { setDirty(); renderRules(); renderTags(); }

    // en tags egen regel: rediger den hvis den finnes, eller lag en, først i listen så den vinner
    function ruleForTag(name) {
      const i = ruleOf(name);
      const own = i >= 0 && !/\*/.test(draft.rules[i].tags) && draft.rules[i].tags.split(/[\s,]+/).filter(Boolean).length === 1;
      if (own) return editRule(i);
      editRule(-1, { tags: name, mode: 'change' }, i >= 0
        ? `A rule just for ${name}, placed first so it decides before rule ${i + 1} (${draft.rules[i].tags}).`
        : `${name} isn’t stored now. This rule stores it.`);
    }

    // ---- én regel, i en dialog. index -1: en ny regel, plassert først (en tags egen regel vinner),
    // eller sist med atEnd (+ Add rule)
    function editRule(index, fresh, intro, atEnd) {
      const rule = index >= 0 ? JSON.parse(JSON.stringify(draft.rules[index])) : Object.assign({ tags: '', mode: 'change' }, fresh || {});
      rule.mode = rule.mode || 'change';
      const input = (key, attrs) => { const x = el('input', Object.assign({ type: 'text', value: rule[key] === undefined ? '' : rule[key] }, attrs)); x.addEventListener('input', () => { rule[key] = x.value; update(); }); return x; };
      const tags = input('tags', { class: 'mono', style: 'width:100%', placeholder: 'kv_1.speedAct, kv_1.torqueAct   or   kv_1.bit*' });
      const caught = el('div', { class: 'hint' });
      const modes = el('div', { class: 'bar' }, ...Object.entries({ change: 'Each change', interval: 'At a fixed interval', ignore: 'Nothing: ignore these tags' }).map(([m, label]) => {
        const radio = el('input', { type: 'radio', name: 'mode', value: m, checked: rule.mode === m });
        radio.addEventListener('change', () => { rule.mode = m; update(); });
        return el('label', null, radio, label);
      }));
      const bitsMode = el('select', null, el('option', { value: '', text: 'All bits count' }), el('option', { value: 'bits', text: 'Only these bits count' }), el('option', { value: 'ignoreBits', text: 'All bits except these' }));
      bitsMode.value = rule.bits ? 'bits' : rule.ignoreBits ? 'ignoreBits' : '';
      const bitsList = el('input', { type: 'text', value: rule.bits || rule.ignoreBits || '', placeholder: '0-7, 11', style: 'width:120px' });
      const syncBits = () => { delete rule.bits; delete rule.ignoreBits; if (bitsMode.value && bitsList.value.trim()) rule[bitsMode.value] = bitsList.value.trim(); bitsList.disabled = !bitsMode.value; update(); };
      bitsMode.addEventListener('change', syncBits); bitsList.addEventListener('input', syncBits);
      bitsList.disabled = !bitsMode.value;
      const field = (label, control, hint) => el('div', { class: 'rfield' }, el('label', null, label), control, hint ? el('span', { class: 'hint', text: hint }) : null);
      const changeBox = el('div', null,
        field('Smallest change', input('deadband', { placeholder: 'every change', style: 'width:120px' }), 'For numbers: 30 stores a change of 30 or more; 2% two percent of the last stored value. Empty: every change.'),
        field('Bits (words)', el('span', { class: 'bar' }, bitsMode, bitsList), 'For a status word: store it only when the bits that matter change, not for one that flickers.'),
        field('At most one value per', el('span', null, input('minInterval', { placeholder: 'no limit', style: 'width:90px' }), ' s'), 'The latest value is stored when the time is up, so the final one is never lost.'),
        field('Store again after', el('span', null, input('maxInterval', { placeholder: 'never', style: 'width:90px' }), ' s'), 'Even without a change, so a steady value still has points now and then.'),
        field('Flicker', el('span', null, 'more than ', input('flickerChanges', { placeholder: '-', style: 'width:60px' }), ' changes within ', input('flickerSeconds', { placeholder: '-', style: 'width:60px' }), ' s'), 'Then its changes are held back until it settles; one event says so.'));
      const intervalBox = el('div', null, field('Store the value every', el('span', null, input('every', { placeholder: '60', style: 'width:90px' }), ' s'), 'The latest value at each interval, whether it changed or not.'));
      const note = input('note', { placeholder: 'Why this rule (optional)', style: 'width:100%' });
      const est = el('div', { class: 'estimate' });
      const estBtn = el('button', { type: 'button', text: 'Estimate with the last hour', onclick: async () => {
        const names = allTags.filter(t => t.total > 0 && patternsOf(rule.tags, vars).some(re => re.test(t.name))).map(t => t.name);
        if (!names.length) { est.textContent = 'None of these tags has stored values to try it on.'; return; }
        est.textContent = 'Working it out…';
        try {
          const res = await api('/api/recording/estimate', { rule, tags: names, vars, minutes: 60 });
          est.innerHTML = '';
          const pct = res.before ? Math.round((1 - res.after / res.before) * 100) : 0;
          est.append(el('div', null, el('b', { text: `Last hour: ${res.before.toLocaleString()} stored → about ${res.after.toLocaleString()} with this rule` }), res.before ? ` (${pct >= 0 ? pct + ' % fewer' : -pct + ' % more'})` : ''),
            ...res.tags.slice(0, 12).map(t => el('div', { class: 'hint mono', text: `${t.name}: ${t.before.toLocaleString()} → ${t.after.toLocaleString()}${t.capped ? ' (first 200 000 only)' : ''}` })),
            el('div', { class: 'hint', text: 'Played from what was stored. Exact when the rule in use stores every change; too low when it already leaves values out.' }));
        } catch (e) { est.textContent = e.message; }
      } });
      const msg = el('div', { class: 'err' });
      function update() {
        const c = patternsOf(rule.tags, vars);
        const names = allTags.filter(t => c.some(re => re.test(t.name))).map(t => t.name);
        caught.textContent = rule.tags.trim() ? (names.length ? `Matches ${names.length}: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ` and ${names.length - 10} more` : ''}` : 'Matches no tag the hub or the database knows (yet)') : 'Names separated by commas. * matches anything. Project variables work: ' + (Object.keys(vars).map(k => `\${${k}} = ${vars[k]}`).join(', ') || 'none');
        changeBox.hidden = rule.mode !== 'change';
        intervalBox.hidden = rule.mode !== 'interval';
        estBtn.disabled = rule.mode === 'ignore' || !rule.tags.trim();
        est.textContent = '';
      }
      const close = dialog(index >= 0 ? `Rule ${index + 1}` : atEnd ? 'New rule, at the end' : 'New rule, first', [
        intro ? el('p', { class: 'desc', text: intro }) : null,
        el('div', { class: 'rfield' }, el('label', null, 'Tags'), tags), caught,
        el('h3', { class: 'dh', text: 'What to store' }), modes, changeBox, intervalBox,
        el('div', { class: 'rfield' }, el('label', null, 'Note'), note),
        el('div', { class: 'bar', style: 'margin-top:10px' }, estBtn), est, msg,
      ].filter(Boolean), [
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'ghost', text: 'Cancel', onclick: () => close() }),
        el('button', { type: 'button', class: 'primary', text: 'OK', onclick: () => {
          if (!rule.tags.trim()) { msg.textContent = 'Name at least one tag.'; return; }
          if (rule.mode === 'interval' && !(Number(rule.every) >= 1)) { msg.textContent = 'Say how often, in seconds (1 or more).'; return; }
          // behold bare det modusen bruker, og tall som tall
          const clean = { tags: rule.tags.trim(), mode: rule.mode };
          if (rule.mode === 'interval') clean.every = Number(rule.every);
          if (rule.mode === 'change') {
            if (String(rule.deadband || '').trim()) clean.deadband = /%$/.test(String(rule.deadband).trim()) ? String(rule.deadband).trim() : Number(rule.deadband);
            if (rule.bits) clean.bits = rule.bits;
            if (rule.ignoreBits) clean.ignoreBits = rule.ignoreBits;
            for (const k of ['minInterval', 'maxInterval', 'flickerChanges', 'flickerSeconds']) if (String(rule[k] === undefined ? '' : rule[k]).trim() !== '') clean[k] = Number(rule[k]);
          }
          if (String(rule.note || '').trim()) clean.note = String(rule.note).trim();
          if (index >= 0) draft.rules[index] = clean; else if (atEnd) draft.rules.push(clean); else draft.rules.unshift(clean);
          close();
          changed();
        } }),
      ]);
      update();
    }

    async function save() {
      try { await api('/api/recording', { recording: draft }); }
      catch (e) { toast('Not saved: ' + e.message, true); return; }
      unsaved = null;
      toast('Saved. The recorder uses the new rules within a few seconds.');
      await route();
    }

    renderPause();
    renderTags();
    renderRules();
    renderSettings();
    setDirty();
  }

  // ---------------------------------------------------------------- tagnavn
  // Ditt eget navn og din egen beskrivelse for hver tag, f.eks. bit05 -> "Dør lukket". Huben har dem
  // (tagnames.json ved siden av prosjektet); HMI-en, denne leseren og databasen viser dem.
  // Verdiene oppdateres hvert sekund, så en bit kan finnes ved å få den til å endre seg.
  let namesGen = 0;
  const showVal = v => (v === null || v === undefined ? '—' : typeof v === 'boolean' ? String(v) : typeof v === 'number' ? String(+v.toFixed(3)) : String(v));
  function paintValue(td, v, stale, flash) {
    td.textContent = showVal(v);
    td.className = 'val' + (typeof v === 'number' ? ' num' : '') + (v === true ? ' on' : '') + (stale ? ' stale' : '');
    if (flash) { td.classList.remove('flash'); void td.offsetWidth; td.classList.add('flash'); }   // start blinkingen på nytt
  }
  async function showNames(main) {
    const gen = ++namesGen;
    main.append(el('h1', { text: 'Tag names' }),
      el('p', { class: 'desc', text: 'Your own name and description for each tag, so bit05 can be “Door closed” without a change to the PLC program. The tag keeps its name, so screens, recording rules and stored history stay as they are. The HMI, this browser and the database (tag.label, tag.info) show your names.' }));
    const data = await api('/api/names');
    const hubOk = data.hub.ok;
    if (hubOk) main.append(el('p', { class: 'hint mono', text: `Kept by the hub in ${data.file}` }));
    else main.append(el('div', { class: 'warnbox', text: `The hub can’t be reached (${data.hub.error}). The hub keeps the names, so they can’t be changed now. Shown are the names the recorder copied into the database.` }));
    // prosjektvariabelen som navngir enheten med flest tagger, for eksempelet
    const varNames = Object.keys(data.vars || {});
    const ofVar = k => data.tags.filter(t => t.name.startsWith(data.vars[k] + '.'));
    const top = varNames.slice().sort((a, b) => ofVar(b).length - ofVar(a).length)[0];
    if (hubOk && top && ofVar(top).length) {
      const ex = ofVar(top)[0].name;
      main.append(el('p', { class: 'hint', text: `Names for tags of ${varNames.map(k => `\${${k}} = ${data.vars[k]}`).join(', ')} are saved with the variable (${ex} as \${${top}}${ex.slice(String(data.vars[top]).length)}), so they follow it: a vehicle with another ${top} gets the same names.` }));
    }

    const view = store.get('names.view', { filter: '', show: 'all' });
    const edits = new Map();   // tag -> { label, info }, ikke lagret ennå
    const tags = data.tags.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const filter = el('input', { type: 'text', class: 'filter', value: view.filter, placeholder: 'Find a tag, a name or a description', 'aria-label': 'Find' });
    const show = el('select', { 'aria-label': 'Which tags' }, ...[['all', 'All tags'], ['named', 'With a name'], ['unnamed', 'Without a name'], ['stored', 'Stored in the database']]
      .map(([v, t]) => el('option', { value: v, text: t, selected: view.show === v })));
    const count = el('span', { class: 'hint' });
    filter.addEventListener('input', () => { view.filter = filter.value; store.set('names.view', view); render(); });
    show.addEventListener('change', () => { view.show = show.value; store.set('names.view', view); render(); });
    main.append(el('div', { class: 'bar' }, filter, show, count),
      el('p', { class: 'hint', text: 'To find a bit: watch the Now column and make it change (open the door, press the button). A value that changes blinks.' }));
    const tb = el('tbody');
    main.append(el('div', { class: 'gridwrap names' }, el('table', { class: 'grid' },
      el('thead', null, el('tr', null, ...['Tag', 'Your name', 'Description', 'Now', 'From the device'].map(h => el('th', { text: h })))), tb)));
    const saveNote = el('span');
    const saveBar = el('div', { class: 'savebar', hidden: true }, saveNote, el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'ghost', text: 'Discard', onclick: () => { unsaved = null; route(); } }),
      el('button', { type: 'button', class: 'primary', text: 'Save names', onclick: save }));
    main.append(saveBar);

    const valueCells = new Map();
    const last = new Map(tags.map(t => [t.name, JSON.stringify(t.value === undefined ? null : t.value)]));
    function dirty() {
      saveNote.textContent = `${edits.size} tag${edits.size === 1 ? '' : 's'} with changes that aren’t saved.`;
      unsaved = edits.size ? { page: '#/names', text: 'Tag names have changes that aren’t saved. Leave them?' } : null;
      saveBar.hidden = !edits.size;
    }
    function render() {
      tb.innerHTML = '';
      valueCells.clear();
      const q = view.filter.trim().toLowerCase();
      let n = 0;
      for (const t of tags) {
        const e = edits.get(t.name) || t;
        const label = e.label || '', info = e.info || '', shown = label || t.deviceLabel || '';
        if ((view.show === 'named' && !shown) || (view.show === 'unnamed' && shown) || (view.show === 'stored' && !t.stored)) continue;
        if (q && !`${t.name}\n${label}\n${info}\n${t.deviceLabel || ''}\n${t.description || ''}`.toLowerCase().includes(q)) continue;
        n++;
        // navnet enheten gir taggen (f.eks. fra PLS-en) står som forslag, og gjelder når feltet er tomt
        const name = el('input', { type: 'text', value: label, maxlength: '80', disabled: !hubOk, placeholder: t.deviceLabel || '', 'aria-label': `Your name for ${t.name}` });
        const desc = el('input', { type: 'text', value: info, maxlength: '2000', disabled: !hubOk, 'aria-label': `Description of ${t.name}` });
        const tr = el('tr', { class: edits.has(t.name) ? 'changed' : '' });
        const onInput = () => {
          const nv = { label: name.value.trim(), info: desc.value.trim() };
          if (nv.label === (t.label || '') && nv.info === (t.info || '')) edits.delete(t.name); else edits.set(t.name, nv);
          tr.classList.toggle('changed', edits.has(t.name));
          dirty();
        };
        name.addEventListener('input', onInput);
        desc.addEventListener('input', onInput);
        const val = el('td');
        paintValue(val, t.value, t.onHub && (!t.online || t.quality === 'bad'), false);
        if (!t.onHub) val.textContent = '';
        valueCells.set(t.name, val);
        tr.append(
          el('td', { class: 'mono', title: t.key && t.key !== t.name ? `saved as ${t.key}` : t.onHub ? '' : 'not on the hub now' }, t.name, !t.onHub ? el('span', { class: 'hint', text: '  (not on the hub)' }) : null),
          el('td', { class: 'edit' }, name), el('td', { class: 'edit wide' }, desc), val,
          el('td', { class: 'hint', text: [t.deviceLabel ? `“${t.deviceLabel}”` : '', t.description || (t.calc ? 'calculated by the hub' : '')].filter(Boolean).join('  '), title: t.description || null }));
        tb.append(tr);
      }
      count.textContent = `${n} of ${tags.length} tags`;
      if (!n) tb.append(el('tr', null, el('td', { colspan: 5, class: 'hint', text: tags.length ? 'No tag matches.' : 'No tags yet: start the hub and the adapters.' })));
    }
    async function save() {
      const changes = [...edits].map(([tag, e]) => ({ tag, name: e.label, info: e.info }));
      try { await api('/api/names', { changes }); } catch (e) { toast(e.message, true); return; }
      unsaved = null;
      toast(`Saved. The HMI shows ${changes.length === 1 ? 'it' : 'them'} at once, the database within a few seconds.`);
      await loadAll();
      route();
    }
    // verdiene nå, hvert sekund, mens denne siden er åpen
    const poll = async () => {
      if (gen !== namesGen || location.hash !== '#/names') return;   // har forlatt siden
      if (hubOk && document.visibilityState === 'visible') {
        try {
          const r = await api('/api/names/values');
          for (const [name, [v, stale]] of Object.entries(r.values)) {
            const k = JSON.stringify(v), changed = last.get(name) !== k;
            last.set(name, k);
            const td = valueCells.get(name);
            if (td) paintValue(td, v, stale, changed);
          }
        } catch (e) { /* huben var borte et øyeblikk: neste forsøk viser det */ }
      }
      setTimeout(poll, 1000);
    };
    render();
    setTimeout(poll, 1000);
  }

  // ---------------------------------------------------------------- SQL
  function examples() {
    if (!S.look.recorder) return [['Tables and their columns', "SELECT m.name AS table_name, p.name AS column_name, p.type\nFROM sqlite_master m, pragma_table_info(m.name) p\nWHERE m.type = 'table'\nORDER BY m.name, p.cid;"]];
    const tag = Object.values(S.look.tags)[0] || 'kv_1.speedAct';
    return [
      ['The last values of one tag', `-- change the tag name to the one you want\nSELECT datetime(s.ts / 1000, 'unixepoch', 'localtime') AS time, s.value, s.text, s.q\nFROM sample s JOIN tag t ON t.id = s.tag\nWHERE t.name = '${tag}'\nORDER BY s.id DESC\nLIMIT 100;`],
      ['Your names for the tags', "SELECT name, label AS your_name, info AS description\nFROM tag\nORDER BY name;"],
      ['Values stored per tag', "SELECT t.name, t.label, SUM(r.rows) AS values_stored,\n  datetime(MIN(r.minute) * 60, 'unixepoch', 'localtime') AS first,\n  datetime(MAX(r.minute) * 60, 'unixepoch', 'localtime') AS last\nFROM rollup r JOIN tag t ON t.id = r.tag\nGROUP BY r.tag\nORDER BY values_stored DESC;"],
      ['Hourly lowest and highest of a tag',`SELECT strftime('%Y-%m-%d %H:00', r.minute * 60, 'unixepoch', 'localtime') AS hour,\n  MIN(r.lo) AS lowest, MAX(r.hi) AS highest, SUM(r.n) AS values_stored\nFROM rollup r JOIN tag t ON t.id = r.tag\nWHERE t.name = '${tag}'\nGROUP BY hour\nORDER BY hour DESC\nLIMIT 48;`],
      ['Alarms and warnings of the last 24 hours', "SELECT datetime(ts / 1000, 'unixepoch', 'localtime') AS time, source, severity, message\nFROM event\nWHERE severity IN ('alarm', 'warning') AND ts > (strftime('%s', 'now') - 86400) * 1000\nORDER BY id DESC;"],
      ['When recording was paused, and why', "SELECT datetime(ts / 1000, 'unixepoch', 'localtime') AS time, message\nFROM event\nWHERE source = 'rec' AND (message LIKE 'Recording paus%' OR message LIKE 'Recording resumed%' OR message LIKE '%during a pause%')\nORDER BY id DESC;"],
      ['When a tag was stale (link lost)',"SELECT datetime(s.ts / 1000, 'unixepoch', 'localtime') AS time, t.name\nFROM sample s JOIN tag t ON t.id = s.tag\nWHERE s.q = 2\nORDER BY s.id DESC\nLIMIT 200;"],
      ['Writes to the SD card per hour', "SELECT strftime('%Y-%m-%d %H:00', written / 1000, 'unixepoch', 'localtime') AS hour,\n  COUNT(*) AS writes, SUM(rows) AS rows\nFROM batch\nGROUP BY hour\nORDER BY hour DESC\nLIMIT 48;"],
      ['Space used per table and index', "SELECT name, ROUND(SUM(pgsize) / 1e6, 1) AS megabytes\nFROM dbstat\nGROUP BY name\nORDER BY SUM(pgsize) DESC;"],
    ];
  }
  function showSql(main) {
    const box = el('textarea', { class: 'sqlbox', spellcheck: 'false', 'aria-label': 'SQL' });
    box.value = store.get('sql.text', 'SELECT * FROM sqlite_master;');
    const ex = el('select', { 'aria-label': 'Examples' }, el('option', { value: '', text: 'Examples…' }), ...examples().map(([label], i) => el('option', { value: i, text: label })));
    ex.addEventListener('change', () => { if (ex.value !== '') { box.value = examples()[ex.value][1]; ex.value = ''; box.focus(); } });
    const hist = store.get('sql.history', []);
    const hs = el('select', { 'aria-label': 'Earlier queries' }, el('option', { value: '', text: `Earlier (${hist.length})…` }), ...hist.map((h, i) => el('option', { value: i, text: h.replace(/\s+/g, ' ').slice(0, 80) })));
    hs.addEventListener('change', () => { if (hs.value !== '') { box.value = hist[hs.value]; hs.value = ''; box.focus(); } });
    const out = el('div', { class: 'section' });
    const status = el('div', { class: 'hint' });
    const go = async () => {
      const sql = box.value.trim();
      if (!sql) return;
      store.set('sql.text', box.value);
      store.set('sql.history', [sql, ...hist.filter(h => h !== sql)].slice(0, 20));
      status.textContent = 'Running…'; status.className = 'hint';
      out.innerHTML = '';
      try {
        const r = await api('/api/sql', { sql });
        if (r.columns) {
          status.textContent = `${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ' (the first 1000: narrow it down with WHERE or LIMIT)' : ''} · ${r.ms} ms`;
          if (r.rows.length) {
            const t = el('table', { class: 'grid' }, el('thead', null, el('tr', null, ...r.columns.map(c => el('th', { text: c })))),
              el('tbody', null, ...r.rows.map(row => el('tr', null, ...row.map((v, i) => cell('', r.columns[i], v))))));
            out.append(el('div', { class: 'gridwrap' }, t));
          }
        } else if (r.message) { status.textContent = `${r.message} · ${r.ms} ms`; status.className = 'okmsg'; await loadAll(); }
        else { status.textContent = `Done: ${r.changes} row${r.changes === 1 ? '' : 's'} changed · ${r.ms} ms`; status.className = 'okmsg'; await loadAll(); }
      } catch (e) { status.textContent = e.message; status.className = 'err'; }
    };
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    main.append(el('h1', { text: 'SQL' }),
      el('p', { class: 'desc', text: S.info.write ? 'Anything SQLite understands. Changes happen at once: press Back up first if in doubt.' : 'Ask anything with SELECT. The browser is read-only, so nothing typed here can change the database.' }),
      el('div', { class: 'bar' }, ex, hs, el('span', { class: 'spacer' }), el('span', { class: 'hint', text: 'Ctrl+Enter runs it' }), el('button', { type: 'button', class: 'primary', text: 'Run', onclick: go })),
      box, status, out);
    box.focus();
  }

  // ---------------------------------------------------------------- dialoger
  // returnerer close()
  function dialog(title, body, actions) {
    const back = document.activeElement;
    const ov = el('div', { class: 'overlay' });
    const d = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, el('h2', { text: title }), ...[].concat(body), el('div', { class: 'actions' }, ...actions));
    ov.append(d);
    document.body.append(ov);
    const onKey = e => { if (e.key === 'Escape') close(); };
    function close() { document.removeEventListener('keydown', onKey); ov.remove(); if (back && back.focus) back.focus(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
    const f = d.querySelector('input:not([readonly]):not([disabled]), button');
    if (f) f.focus();
    return close;
  }

  async function refreshSide() { try { S.objects = await api('/api/objects'); renderSide(); } catch (e) { /* neste lasting viser det */ } }

  // en pause kan starte eller slutte et annet sted (en annen nettleser, sluttiden): sjekkes hvert 10. s,
  // så topplinjen aldri sier pauset når den ikke er det, eller omvendt
  let onPausesChanged = null;   // Recording-siden tegner pausene sine på nytt
  setInterval(async () => {
    if (!S.info || document.visibilityState !== 'visible') return;
    try {
      const i = await api('/api/info');
      if (JSON.stringify(i.pauses || []) === JSON.stringify(S.info.pauses || [])) return;
      S.info.pauses = i.pauses;
      renderTop();
      renderSide();
      if (onPausesChanged && location.hash === '#/recording') onPausesChanged();
    } catch (e) { /* leserens server stoppet: neste klikk sier fra */ }
  }, 10000);

  // ---------------------------------------------------------------- oppstart
  $('#btn-refresh').addEventListener('click', async () => { await loadAll(); route(); toast('Read again'); });
  $('#btn-backup').addEventListener('click', async () => {
    if (!confirm('Make a copy of the whole database next to it? A big database takes a while, and needs as much free space again.')) return;
    const b = $('#btn-backup');
    b.disabled = true; b.textContent = 'Backing up…';
    try { const r = await api('/api/backup', {}); toast(`Copied to ${r.file} (${fmtBytes(r.bytes)}, ${(r.ms / 1000).toFixed(1)} s)`); }
    catch (e) { toast(e.message, true); }
    b.disabled = false; b.textContent = 'Back up';
  });
  loadAll().then(route).catch(e => { $('#main').append(el('p', { class: 'err', text: 'Can’t reach the database browser: ' + e.message })); });
})();
