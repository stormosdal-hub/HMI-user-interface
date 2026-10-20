/*
 * Kodetekster: en kort tekst og en beskrivelse for hver kode i en liste med feil- eller alarmkoder.
 *
 * Huben holder listene i codes.json ved siden av prosjektfilen og sender dem til hver HMI
 * (meldingen "codes"). Endringer går til huben én og én (POST /api/codes), aldri som hel fil,
 * så en beskrivelse lagt til i Run-modus lagrer ikke layouten, og to som redigerer hver sin
 * kode overskriver ikke hverandre.
 *
 * H.codes                   listene slik huben sist sendte dem, pluss hjelpere
 *   .set(codes)             nye lister fra huben; sier fra til hver abonnent
 *   .subscribe(fn) -> off
 *   .list(id)               { id, name, prefix, codes } eller null
 *   .lookup(id, value)      { list, key, label, entry, short } eller null når listen ikke finnes
 *   .key(value, prefix)     nøkkelen en verdi lagres under: 7900, "16#1EDC" og "F7900" er alle "7900"
 * H.openCodeInfo(opts)      pop-up-vinduet for én kode (en Value-widget klikket i Run-modus)
 * H.openCodeEditor(opts)    alle lister og koder
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el } = H.helpers;
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const NUMERIC = /^[+-]?\d+(\.\d+)?$/;

  // ---------------------------------------------------------------- nøkler og etiketter
  // Heltall lagres som desimale sifre, uansett hvordan de er skrevet; annen tekst som den er.
  // Et listeprefiks som er skrevet med ("F7900" i en liste med prefiks F) tas bort.
  function key(v, prefix) {
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    const s = String(v == null ? '' : v).trim();
    const p = String(prefix || '');
    const bare = p && s.toUpperCase().startsWith(p.toUpperCase()) ? s.slice(p.length).trim() : s;
    for (const t of bare === s ? [s] : [bare, s]) {
      const u = t.replace(/_/g, '');
      let m;
      if ((m = u.match(/^(?:16#|0x)([0-9a-f]+)$/i))) return String(parseInt(m[1], 16));
      if ((m = u.match(/^(?:2#|0b)([01]+)$/i))) return String(parseInt(m[1], 2));
      if (NUMERIC.test(u)) return String(Number(u));
    }
    return s;
  }
  const label = (list, k) => (NUMERIC.test(k) && list && list.prefix ? list.prefix : '') + k;
  const firstLine = s => String(s || '').split('\n').map(x => x.trim()).find(Boolean) || '';
  const shortText = e => (e ? e.text || firstLine(e.info) : '');
  const sortKeys = keys => keys.sort((a, b) => {
    const na = NUMERIC.test(a), nb = NUMERIC.test(b);
    if (na && nb) return Number(a) - Number(b);
    if (na !== nb) return na ? -1 : 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  const when = ts => ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'list';

  // tekst med nettadresser som lenker (en beskrivelse kan peke til manualen)
  function linked(text) {
    const frag = document.createDocumentFragment();
    String(text || '').split(/(https?:\/\/[^\s<>"]+)/g).forEach((part, i) => {
      if (i % 2 === 0) { if (part) frag.append(part); return; }
      const a = el('a', null, part);
      a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer';
      frag.append(a);
    });
    return frag;
  }

  // ---------------------------------------------------------------- lageret
  let data = { lists: {} };
  const listeners = new Set();
  H.codes = {
    key, label, shortText,
    get: () => data,
    set(codes) {
      data = codes && codes.lists && typeof codes.lists === 'object' ? codes : { lists: {} };
      for (const fn of [...listeners]) { try { fn(data); } catch (e) { console.error(e); } }
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    list(id) {
      if (!id || !own(data.lists, id)) return null;
      const l = data.lists[id];
      return { id, name: l.name || id, prefix: l.prefix || '', codes: l.codes && typeof l.codes === 'object' ? l.codes : {} };
    },
    lists() {
      return Object.keys(data.lists).map(id => H.codes.list(id)).sort((a, b) => a.name.localeCompare(b.name));
    },
    lookup(id, value) {
      const list = H.codes.list(id);
      if (!list) return null;
      const k = value == null || value === '' ? '' : key(value, list.prefix);
      const entry = k && own(list.codes, k) ? list.codes[k] : null;
      return { list, key: k, label: label(list, k), entry, short: shortText(entry) };
    },
  };

  // ---------------------------------------------------------------- felles deler
  function dialog(cls, name) {
    const overlay = el('div', 'mm-overlay');
    const box = el('div', 'mm ' + cls);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', name);
    overlay.append(box);
    document.body.append(overlay);
    return { overlay, box };
  }
  const button = (cls, text, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };

  // kortteksten og beskrivelsen til én kode; save(set) -> Promise, så done()
  function codeForm(entry, save, done, { focusInfo = false } = {}) {
    const form = el('form', 'cp-form');
    const text = el('input');
    text.type = 'text';
    text.maxLength = 200;
    text.value = (entry && entry.text) || '';
    text.placeholder = 'For example: Motor blocked';
    const info = el('textarea');
    info.value = (entry && entry.info) || '';
    info.placeholder = 'What it means, likely causes, what to check and do. Add to it whenever you learn more.';
    const msg = el('div', 'cp-msg');
    const lab = (t, input, hint) => { const l = el('label', null, t); const w = el('div', 'cp-field'); w.append(l, input); if (hint) w.append(el('div', 'cp-hint', hint)); return w; };
    const cancel = button('ghost', 'Cancel');
    const ok = el('button', 'primary', 'Save');
    ok.type = 'submit';
    const acts = el('div', 'mm-actions');
    acts.append(cancel, ok);
    form.append(lab('Short text, shown on the widget', text), lab('Description', info, 'Ctrl+Enter or Ctrl+S saves'), msg, acts);
    const start = text.value + '\u0000' + info.value;
    const changed = () => text.value + '\u0000' + info.value !== start;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      ok.disabled = true;
      msg.textContent = '';
      try { await save({ text: text.value, info: info.value }); done(true); } catch (err) { msg.textContent = 'Not saved: ' + err.message; ok.disabled = false; }
    });
    info.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } });
    // Ctrl+S lagrer denne teksten, ikke layouten bak
    form.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); form.requestSubmit(); } });
    const leave = () => { if (!changed() || confirm('Discard the changes to this text?')) done(false); };
    cancel.addEventListener('click', leave);
    form._leave = leave;
    setTimeout(() => (focusInfo ? info : text).focus());
    return form;
  }

  // teksten og beskrivelsen til én kode, for lesing
  function codeView(entry) {
    const v = el('div', 'cp-view');
    if (entry.text) v.append(el('div', 'cp-text', entry.text));
    if (entry.info) { const d = el('div', 'cp-info'); d.append(linked(entry.info)); v.append(d); }
    if (entry.updated) v.append(el('div', 'cp-meta', 'Last changed ' + when(entry.updated)));
    return v;
  }

  // ---------------------------------------------------------------- pop-up-vinduet for én kode
  // opts: { listId, value, title, shown (verdien slik widgeten viser den),
  //         canEdit() -> Promise<bool>, save(listId, key, set) -> Promise, openList(listId, key) }
  H.openCodeInfo = function (opts) {
    const back = document.activeElement;
    const { overlay, box } = dialog('cp', 'Code text');
    const head = el('header', 'mm-head');
    const title = el('h2');
    const closeBtn = button('ghost', 'Close', () => close());
    const top = el('div', 'mm-actions');
    top.append(closeBtn);
    head.append(title, top);
    const body = el('div', 'cp-body');
    const foot = el('footer', 'cp-foot');
    box.append(head, body, foot);
    let form = null;

    function render() {
      body.innerHTML = '';
      foot.innerHTML = '';
      form = null;
      const c = H.codes.lookup(opts.listId, opts.value);
      title.textContent = opts.title || 'Code';
      if (!c) {
        body.append(el('p', 'cp-empty', `The code list "${opts.listId}" doesn’t exist any more. Choose another one for this widget in Edit mode.`));
        return;
      }
      title.append(el('span', 'cp-list', c.list.name));
      const row = el('div', 'cp-coderow');
      row.append(el('span', 'cp-code', c.key ? c.label : 'No value'));
      if (opts.shown && opts.shown !== c.label && opts.shown !== c.key) row.append(el('span', 'cp-alt', opts.shown));
      body.append(row);
      if (!c.key) return;
      const all = button('ghost', `All codes in ${c.list.name}`, () => { close(); opts.openList(c.list.id, c.key); });
      const right = el('div', 'mm-actions');
      if (c.entry) body.append(codeView(c.entry));
      else body.append(el('p', 'cp-empty', `There is no text for ${c.label} yet. If you know what it means, add it for the next person.`));
      const edit = button('primary', c.entry ? 'Edit' : 'Add text', async () => {
        if (!(await opts.canEdit())) return;
        body.querySelectorAll('.cp-view, .cp-empty').forEach(n => n.remove());
        foot.innerHTML = '';
        form = codeForm(c.entry, set => opts.save(c.list.id, c.key, set), () => render(), { focusInfo: !!c.entry });
        body.append(form);
      });
      right.append(edit);
      foot.append(all, right);
      edit.focus();
    }

    // en annen HMI endret listene: vis det, med mindre denne er under redigering
    const off = H.codes.subscribe(() => { if (!form) render(); });
    function close() {
      off();
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (back && back.focus) back.focus();
    }
    function onKey(e) {
      if (e.key !== 'Escape' || document.querySelector('.mm.codebox')) return;
      e.preventDefault();
      if (form) form._leave(); else close();
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay && !form) close(); });
    render();
    if (!box.contains(document.activeElement)) closeBtn.focus();
  };

  // ---------------------------------------------------------------- editoren
  // opts: { listId, canEdit() -> Promise<bool>, change(changes) -> Promise,
  //         usage(listId) -> ["Fault code (PLC link)", ...], openKey, onClose() }
  H.openCodeEditor = function (opts) {
    const { overlay, box } = dialog('cx', 'Code texts');
    const head = el('header', 'mm-head');
    head.append(el('h2', null, 'Code texts'));
    const acts = el('div', 'mm-actions');
    const closeBtn = button('ghost', 'Close', () => tryClose());
    acts.append(closeBtn);
    head.append(acts);
    const side = el('nav', 'cx-side');
    const main = el('section', 'cx-main');
    const bodyEl = el('div', 'cx-body');
    bodyEl.append(side, main);
    box.append(head, bodyEl);

    let current = H.codes.list(opts.listId) ? opts.listId : ((H.codes.lists()[0] || {}).id || null);
    let open = opts.openKey ? { key: opts.openKey, edit: false } : null;   // koden som vises i sin helhet
    let adding = false, pasting = false, naming = false, search = '';
    let allowed = null;    // spurt én gang per editor
    let deferred = false;  // listene endret seg mens noe ble skrevet
    const may = async () => allowed || (allowed = await opts.canEdit());
    const status = el('div', 'cx-status');
    const say = (text, err) => { status.textContent = text; status.className = 'cx-status' + (err ? ' err' : ''); };
    const change = async changes => { try { await opts.change(changes); return true; } catch (e) { say('Not saved: ' + e.message, true); return false; } };

    // ---- listene til venstre
    function renderSide() {
      side.innerHTML = '';
      side.append(el('h3', null, 'Lists'));
      for (const l of H.codes.lists()) {
        const b = button('cx-listbtn' + (l.id === current ? ' on' : ''), null, () => { current = l.id; open = null; adding = pasting = false; search = ''; say(''); render(); });
        b.append(el('span', null, l.name), el('small', null, String(Object.keys(l.codes).length)));
        side.append(b);
      }
      if (naming) {
        const f = el('form', 'cx-newlist');
        const name = el('input');
        name.type = 'text'; name.placeholder = 'e.g. V90 faults'; name.maxLength = 80;
        name.setAttribute('aria-label', 'Name of the new list');
        const ok = el('button', 'primary', 'Create');
        ok.type = 'submit';
        f.append(name, ok);
        f.addEventListener('submit', async e => {
          e.preventDefault();
          const n = name.value.trim();
          if (!n || !(await may())) return;
          let id = slug(n), i = 2;
          while (H.codes.list(id)) id = slug(n) + '-' + i++;
          naming = false;
          if (await change([{ list: id, set: { name: n, prefix: '' } }])) { current = id; open = null; say(`Created "${n}". A prefix such as F shows code 7900 as F7900.`); }
          render();
        });
        name.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); naming = false; renderSide(); } });
        side.append(f);
        setTimeout(() => name.focus());
      } else {
        side.append(button('mm-add', '+ New list', async () => { if (await may()) { naming = true; renderSide(); } }));
      }
      side.append(el('p', 'cx-sidehint', 'One list per kind of code, for example the drive’s faults and its warnings. A Value widget shows the texts of the list chosen in its settings.'));
    }

    // ---- den valgte listen til høyre
    function renderMain() {
      main.innerHTML = '';
      const list = H.codes.list(current);
      if (!list) {
        main.append(el('p', 'cx-intro', 'Code texts turn numbers such as fault codes into words. Make a list, add the codes you know, and choose the list on a Value widget. In Run mode, clicking the value shows the description, and anyone can add what they learn.'), status);
        return;
      }
      const settings = el('div', 'cx-settings');
      const field = (labelText, value, max, width, commit) => {
        const w = el('label', 'cx-set');
        w.append(el('span', null, labelText));
        const i = el('input');
        i.type = 'text'; i.value = value; i.maxLength = max; i.style.width = width;
        i.addEventListener('change', async () => {
          if (!(await may())) { i.value = value; return; }
          if (await commit(i.value.trim())) { value = i.value.trim(); say('Saved'); }
        });
        w.append(i);
        return w;
      };
      settings.append(
        field('Name', list.name, 80, '220px', v => change([{ list: list.id, set: { name: v } }])),
        field('Prefix', list.prefix, 8, '70px', v => change([{ list: list.id, set: { prefix: v } }])),
      );
      const used = opts.usage(list.id);
      const n = Object.keys(list.codes).length;
      const meta = el('div', 'cx-meta', `${n} code${n === 1 ? '' : 's'} · ` + (used.length ? `used by ${used.join(', ')}` : 'not used by any widget yet'));
      const del = button('cx-del', 'Delete list', async () => {
        if (!(await may())) return;
        const q = `Delete the list "${list.name}" with its ${n} code text${n === 1 ? '' : 's'}?` +
          (used.length ? `\n\n${used.length} widget${used.length === 1 ? ' uses' : 's use'} it: ${used.join(', ')}.` : '') + '\n\nThis can’t be undone.';
        if (!confirm(q)) return;
        if (await change([{ list: list.id, remove: true }])) { current = (H.codes.lists()[0] || {}).id || null; open = null; say(`Deleted "${list.name}"`); render(); }
      });
      settings.append(meta, del);

      const tools = el('div', 'cx-tools');
      const find = el('input');
      find.type = 'search'; find.placeholder = 'Search codes and texts'; find.value = search;
      find.setAttribute('aria-label', 'Search codes and texts');
      find.addEventListener('input', () => { search = find.value; renderRows(); });
      tools.append(find,
        button('mm-add small', '+ Add code', async () => { if (await may()) { adding = true; pasting = false; open = null; renderMain(); } }),
        button('mm-add small', 'Paste rows…', async () => { if (await may()) { pasting = !pasting; adding = false; renderMain(); } }));
      main.append(settings, tools, status);
      if (pasting) main.append(pastePanel(list));
      if (adding) main.append(addPanel(list));
      const rows = el('div', 'cx-rows');
      main.append(rows);
      renderRows();
    }

    function renderRows() {
      const rows = main.querySelector('.cx-rows');
      const list = H.codes.list(current);
      if (!rows || !list) return;
      rows.innerHTML = '';
      const q = search.trim().toLowerCase();
      const keys = sortKeys(Object.keys(list.codes)).filter(k => {
        if (!q) return true;
        const e = list.codes[k];
        return (label(list, k) + '\u0000' + k + '\u0000' + (e.text || '') + '\u0000' + (e.info || '')).toLowerCase().includes(q);
      });
      if (!keys.length) {
        rows.append(el('p', 'mm-muted', q ? 'No code matches the search.' : 'No codes in this list yet. Add them one by one, or paste rows from a spreadsheet or a manual.'));
        return;
      }
      for (const k of keys) {
        const e = list.codes[k];
        if (open && open.key === k) { rows.append(openPanel(list, k, e)); continue; }
        const row = button('cx-row', null, () => { open = { key: k, edit: false }; adding = false; renderRows(); });
        row.append(el('span', 'cx-code', label(list, k)), el('span', 'cx-text', e.text || '—'),
          el('span', 'cx-info', firstLine(e.info)), el('span', 'cx-when', e.updated ? new Date(e.updated).toLocaleDateString() : ''));
        rows.append(row);
      }
    }

    // én kode i sin helhet: for lesing, eller med Edit for å endre den
    function openPanel(list, k, e) {
      const p = el('div', 'cx-open');
      const top = el('div', 'cx-opentop');
      top.append(el('span', 'cx-code big', label(list, k)));
      p.append(top);
      if (open.edit) {
        p.append(codeForm(e, set => opts.change([{ list: list.id, code: k, set }]), saved => {
          open.edit = false;
          if (saved) say(`Saved ${label(list, k)}`);
          render();
        }, { focusInfo: true }));
        return p;
      }
      p.append(codeView(e));
      const a = el('div', 'mm-actions');
      a.append(
        button('ghost', 'Close', () => { open = null; renderRows(); }),
        button('cx-del', 'Delete', async () => {
          if (!(await may()) || !confirm(`Delete the text for ${label(list, k)}?`)) return;
          if (await change([{ list: list.id, code: k, remove: true }])) { open = null; say(`Deleted ${label(list, k)}`); render(); }
        }),
        button('primary', 'Edit', async () => { if (await may()) { open.edit = true; renderRows(); } }));
      p.append(a);
      setTimeout(() => p.scrollIntoView({ block: 'nearest' }));
      return p;
    }

    // en ny kode: nummeret først, så tekstene
    function addPanel(list) {
      const p = el('div', 'cx-open');
      const w = el('label', 'cx-set');
      w.append(el('span', null, 'Code'));
      const code = el('input');
      code.type = 'text';
      code.placeholder = list.prefix ? `${list.prefix}7900, 7900 or 16#1EDC` : '7900 or 16#1EDC';
      code.style.width = '200px';
      w.append(code);
      const note = el('div', 'cp-hint');
      const showKey = () => {
        const k = key(code.value, list.prefix);
        note.textContent = !k ? '' : own(list.codes, k) ? `${label(list, k)} is in the list already; saving adds to it` : `Stored as ${label(list, k)}`;
      };
      code.addEventListener('input', showKey);
      p.append(w, note);
      p.append(codeForm(null, async set => {
        const k = key(code.value, list.prefix);
        if (!k) { code.focus(); throw new Error('type the code first'); }
        const prev = own(list.codes, k) ? list.codes[k] : null;
        // å legge til på en kode som finnes beholder det som sto der
        if (prev) set = { text: set.text || prev.text || '', info: [prev.info, set.info].filter(s => s && s.trim()).join('\n\n') };
        await opts.change([{ list: list.id, code: k, set }]);
        say(`Saved ${label(list, k)}`);
      }, () => { adding = false; render(); }));
      setTimeout(() => code.focus(), 10);
      return p;
    }

    // rader kopiert fra et regneark (tabulatorer) eller skrevet med semikolon: kode, korttekst, beskrivelse
    function parseRows(text, prefix) {
      const unquote = s => { const t = s.trim(); return /^".*"$/s.test(t) ? t.slice(1, -1).replace(/""/g, '"') : t; };
      const rows = [];
      for (const line of String(text).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const sep = line.includes('\t') ? '\t' : ';';
        const cells = line.split(sep);
        const k = key(unquote(cells[0]), prefix);
        if (k) rows.push({ key: k, text: unquote(cells[1] || ''), info: unquote(cells.slice(2).join(sep)) });
      }
      // en første rad som ikke er et tall, over rader som er det, regnes som overskrifter
      let heading = false;
      if (rows.length > 1 && !NUMERIC.test(rows[0].key) && rows.slice(1).filter(r => NUMERIC.test(r.key)).length >= (rows.length - 1) * 0.8) { rows.shift(); heading = true; }
      return { rows, heading };
    }
    function pastePanel(list) {
      const p = el('div', 'cx-open');
      p.append(el('div', 'cp-hint', 'One code per row: code, short text, description. Copy the columns from a spreadsheet, or separate them with semicolons. For example: 7900; Motor blocked; Check the brake and the load'));
      const ta = el('textarea', 'cx-paste');
      ta.placeholder = '7900\tMotor blocked\tCheck the brake and the load\n7901;Motor overspeed;';
      const repl = el('label', 'mm-check');
      const rbox = el('input'); rbox.type = 'checkbox';
      repl.append(rbox, document.createTextNode(' Replace texts that are filled in already (otherwise only empty ones are filled)'));
      const preview = el('div', 'cx-preview');
      const go = button('primary', 'Import', null);
      const a = el('div', 'mm-actions');
      a.append(button('ghost', 'Cancel', () => { pasting = false; renderMain(); }), go);
      p.append(ta, repl, preview, a);
      const plan = () => {
        const { rows, heading } = parseRows(ta.value, list.prefix);
        const changes = [];
        let fresh = 0, filled = 0, kept = 0;
        for (const r of rows) {
          const prev = own(list.codes, r.key) ? list.codes[r.key] : null;
          const set = {};
          if (r.text && (rbox.checked || !prev || !prev.text)) set.text = r.text;
          if (r.info && (rbox.checked || !prev || !prev.info)) set.info = r.info;
          if (!Object.keys(set).length) { kept++; continue; }
          if (prev) filled++; else fresh++;
          changes.push({ list: list.id, code: r.key, set });
        }
        return { rows, heading, changes, fresh, filled, kept };
      };
      const show = () => {
        const r = plan();
        go.disabled = !r.changes.length;
        if (!r.rows.length) { preview.textContent = ''; return; }
        preview.textContent = `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}: ${r.fresh} new, ${r.filled} to fill in or replace, ${r.kept} unchanged` +
          (r.heading ? ' · the first row looks like headings and is skipped' : '') +
          ` · first: ${r.rows.slice(0, 3).map(x => `${label(list, x.key)} ${x.text}`).join(', ')}`;
      };
      ta.addEventListener('input', show);
      rbox.addEventListener('change', show);
      go.addEventListener('click', async () => {
        const r = plan();
        if (!r.changes.length) return;
        go.disabled = true;
        if (await change(r.changes)) { pasting = false; say(`Imported ${r.changes.length} code${r.changes.length === 1 ? '' : 's'}: ${r.fresh} new, ${r.filled} filled in or replaced`); render(); }
        else go.disabled = false;
      });
      setTimeout(() => ta.focus());
      return p;
    }

    function render() { renderSide(); renderMain(); }

    // en annen HMI (eller denne) endret listene. Skriving avbrytes ikke: omtegningen venter.
    const busy = () => (open && open.edit) || adding || pasting ||
      (box.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'search');
    const off = H.codes.subscribe(() => { if (busy()) deferred = true; else render(); });
    box.addEventListener('focusout', () => setTimeout(() => { if (deferred && !busy()) { deferred = false; render(); } }));

    function tryClose() {
      const f = box.querySelector('.cp-form');
      if (f && !confirm('Close without saving the text being edited?')) return;
      off();
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) {
      if (e.key !== 'Escape' || document.querySelector('.mm.codebox')) return;
      e.preventDefault();
      const f = box.querySelector('.cp-form');
      if (f) f._leave(); else tryClose();
    }
    document.addEventListener('keydown', onKey);
    render();
  };
})();
