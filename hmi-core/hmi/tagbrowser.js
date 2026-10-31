/*
 * Taggleser - alle tagger i huben med live verdi, datatype, kvalitet og alder.
 *
 * H.openTagBrowser({
 *   tags()        -> Map(navn -> oppføring i registeret)      (state.tags)
 *   live(name)    -> { value, quality, ts } | undefined   (state.values)
 *   vars          -> prosjektvariabler, så en valgt tag kan settes inn som ${pls}.bit00
 *   current       -> taggen feltet har nå (oppløst), uthevet
 *   pick(text)    -> kalles med den valgte taggen; utelat for bare å se
 *   title         -> overskriften (valgfri), f.eks. 'Tag list'
 *   alarms        -> true: redigeringen har også taggens alarm (bare i Edit-modus)
 *   codeLists     -> () => kodelistene, til en alarm som slår opp koden (H.codes.lists)
 *   editName(tag, name, info) -> Promise: lagrer ditt eget navn og beskrivelse for en tag
 *                    (tagnavn, holdt av huben); utelat, så blir navn bare vist
 * })
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el } = H.helpers;

  const ago = ts => {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 2) return 'now';
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    return Math.floor(s / 3600) + ' h ago';
  };
  const TYPES = { boolean: 'bool', number: 'number', string: 'string' };
  const show = v => (v === null || v === undefined) ? '\u2014' : typeof v === 'boolean' ? String(v) : typeof v === 'number' ? String(+v.toFixed(3)) : String(v);
  // "Alarm when off, after 2 s: Door open" for en alarm slik huben sender den
  const isBool = info => info.dataType === 'boolean';
  const alarmSummary = (a, info) => {
    const word = a.severity === 'alarm' ? 'Alarm' : 'Warning';
    const when = a.when === 'false' ? (isBool(info) ? 'off' : '0') : (isBool(info) ? 'on' : 'not 0');
    return `${word} when ${when}${a.delay ? `, after ${+(a.delay / 1000).toFixed(1)} s` : ''}${a.text ? ': ' + a.text : ''}`;
  };

  H.openTagBrowser = function (opts) {
    const picking = typeof opts.pick === 'function';
    const vars = opts.vars || {};
    // ${var}-formen av en tag, når en prosjektvariabel navngir enheten dens
    const withVars = name => {
      for (const [k, v] of Object.entries(vars)) if (v && name.startsWith(v + '.')) return '${' + k + '}' + name.slice(v.length);
      return null;
    };

    const overlay = el('div', 'mm-overlay');
    const box = el('div', 'mm tb');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const heading = opts.title || (picking ? 'Choose a tag' : 'Tags on the hub');
    box.setAttribute('aria-label', heading);
    const head = el('header', 'mm-head');
    const title = el('h2', null, heading);
    const count = el('span', 'tb-count');
    title.append(count);
    const closeBtn = el('button', 'ghost', 'Close');
    const actions = el('div', 'mm-actions');
    actions.append(closeBtn);
    head.append(title, actions);

    const bar = el('div', 'tb-bar');
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Search tags\u2026';
    search.setAttribute('aria-label', 'Search tags');
    const kind = el('select');
    for (const [v, t] of [['all', 'All tags'], ['named', 'With a name'], ['alarms', 'Alarms and warnings'], ['device', 'From devices'], ['calc', 'Calculated'], ['live', 'Live only'], ['stale', 'Stale or no value']]) {
      const o = el('option', null, t); o.value = v; kind.append(o);
    }
    bar.append(search, kind);
    // navngiving: et klikk på en tag gir den ditt eget navn og beskrivelse i stedet for å velge den
    let naming = false;
    const nameBtn = el('button', 'ghost', opts.alarms ? '✎ Name and alarm' : '✎ Name tags');
    nameBtn.type = 'button';
    nameBtn.title = 'Your own name and description for a tag, e.g. bit05 = Door closed. The tag keeps its name.' +
      (opts.alarms ? ' And whether it comes up in the alarm list.' : '');
    nameBtn.setAttribute('aria-pressed', 'false');
    if (opts.editName) bar.append(nameBtn);
    let useVars = null;
    if (picking && Object.keys(vars).length) {
      const lab = el('label', 'mm-check');
      useVars = el('input');
      useVars.type = 'checkbox';
      useVars.checked = true;
      lab.append(useVars, document.createTextNode(' Insert with project variables'));
      lab.title = 'pls.bit00 is inserted as ${pls}.bit00, so the widget follows the variable';
      bar.append(lab);
    }

    const table = el('div', 'tb-list');
    const footText = picking ? 'Click a tag to use it. Values update live.' : 'Values update live.';
    const foot = el('div', 'tb-foot', footText);
    const editBox = el('div', 'tb-edit');
    editBox.hidden = true;
    box.append(head, bar, editBox, table, foot);
    nameBtn.addEventListener('click', () => {
      naming = !naming;
      nameBtn.classList.toggle('on', naming);
      nameBtn.setAttribute('aria-pressed', String(naming));
      foot.textContent = naming ? `Click a tag to give it your own name and description${opts.alarms ? ', or make it an alarm' : ''}. Make a bit change (open the door, press the button) to find it.` : footText;
      if (!naming) closeEditor();
    });

    // ditt navn på én tag
    function closeEditor() { editBox.hidden = true; editBox.innerHTML = ''; }
    function openEditor(name, info) {
      editBox.innerHTML = '';
      editBox.hidden = false;
      const nameIn = el('input');
      // bare ditt eget navn: navnet enheten gir taggen, står som forslag og gjelder når feltet er tomt
      nameIn.value = info.ownLabel !== undefined ? info.ownLabel : (info.label || '');
      nameIn.maxLength = 80;
      nameIn.placeholder = info.deviceLabel ? `${info.deviceLabel} (from the device)` : 'e.g. Door closed';
      const infoIn = el('input');
      infoIn.value = info.info || '';
      infoIn.maxLength = 2000;
      infoIn.placeholder = 'What it means, where it comes from (optional)';
      const msg = el('div', 'tb-edit-msg');
      const save = el('button', 'primary', 'Save');
      const cancel = el('button', 'ghost', 'Cancel');
      save.type = cancel.type = 'button';
      const lab = (text, input) => { const l = el('label', null, text); l.append(input); return l; };
      const title = el('div', 'tb-edit-tag', name);
      if (info.deviceLabel) title.append(el('span', 'tb-edit-desc', `  The device calls it “${info.deviceLabel}”. Your name replaces it here; leave it empty to use the device's.`));
      if (info.description) title.append(el('span', 'tb-edit-desc', '  ' + info.description));
      editBox.append(title, lab('Your name', nameIn), lab('Description', infoIn));
      const readAlarm = opts.alarms ? alarmEditor(name, info, lab) : null;
      editBox.append(save, cancel, msg);
      const doSave = async () => {
        save.disabled = true;
        msg.textContent = '';
        try {
          const alarm = readAlarm ? readAlarm() : undefined;
          await opts.editName(name, nameIn.value.trim(), infoIn.value.trim(), alarm);
          info.ownLabel = nameIn.value.trim();
          info.label = info.ownLabel || info.deviceLabel || '';
          info.info = infoIn.value.trim();
          if (alarm !== undefined) {
            info.ownAlarm = alarm;
            info.alarm = alarm ? (alarm.severity === 'none' ? null : alarm) : (info.deviceAlarm || null);
          }
          closeEditor();
          build();
        } catch (e) { msg.textContent = e.message; save.disabled = false; }
      };
      save.addEventListener('click', doSave);
      cancel.addEventListener('click', closeEditor);
      for (const i of [nameIn, infoIn]) i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
      nameIn.focus();
    }
    // alarmen til én tag: om den kommer i alarmlisten, når, med hvilken tekst. Legger feltene i
    // editBox og returnerer en funksjon som gir det som skal lagres: undefined (ingen endring
    // mulig), null (ingen egen: adapterens gjelder), { severity: 'none' } eller hele alarmen.
    function alarmEditor(name, info, lab) {
      const sec = el('div', 'tb-edit-alarm');
      editBox.append(sec);
      if (info.source === 'calc') {
        sec.append(el('span', 'tb-edit-desc', 'A calculation gets its alarm in \u0192 Calculations: give it a Warning or Alarm event there.'));
        return () => undefined;
      }
      const dev = info.deviceAlarm || null, mine = info.ownAlarm || null, bool = isBool(info);
      const level = el('select');
      const opt = (sel, v, t) => { const o = el('option', null, t); o.value = v; sel.append(o); };
      if (dev) { opt(level, '', `As the adapter: ${alarmSummary(dev, info)}`); opt(level, 'none', 'No alarm'); }
      else opt(level, '', 'No alarm');
      opt(level, 'warning', 'Warning');
      opt(level, 'alarm', 'Alarm');
      level.value = mine ? mine.severity : '';
      const base = mine && mine.severity !== 'none' ? mine : (dev || {});
      const when = el('select');
      opt(when, 'true', bool ? 'When it is on' : 'When it is not 0');
      opt(when, 'false', bool ? 'When it is off' : 'When it is 0');
      when.value = base.when === 'false' ? 'false' : 'true';
      const called = info.ownLabel || info.deviceLabel || name;
      const text = el('input');
      text.className = 'tb-alarm-text';
      text.maxLength = 200;
      text.value = base.text || '';
      text.placeholder = bool ? called : `${called} = {value}`;
      text.title = '{value} becomes the value, e.g. Drive fault F{value}. Empty: the tag’s name';
      const delay = el('input');
      delay.type = 'number'; delay.min = '0'; delay.max = '3600'; delay.step = '0.1';
      delay.className = 'tb-alarm-delay';
      delay.value = String(base.delay ? +(base.delay / 1000).toFixed(1) : 0);
      delay.title = 'How long it must last before it comes up, so a short flicker doesn’t';
      const detail = el('div', 'tb-alarm-detail');
      detail.append(lab('Active', when), lab('Text in the alarm list', text), lab('Delay (s)', delay));
      let codes = null;
      if (!bool && opts.codeLists) {
        codes = el('select');
        opt(codes, '', 'No code list');
        for (const l of opts.codeLists()) opt(codes, l.id, l.name);
        if (base.codes && ![...codes.options].some(o => o.value === base.codes)) opt(codes, base.codes, base.codes + ' (missing)');
        codes.value = base.codes || '';
        codes.title = 'Adds the code’s text from Code texts to the alarm';
        detail.append(lab('Code list', codes));
      }
      const sync = () => { detail.hidden = level.value !== 'warning' && level.value !== 'alarm'; };
      level.addEventListener('change', sync);
      sync();
      sec.append(lab('Alarm list', level), detail);
      return () => {
        const v = level.value;
        if (!v) return null;
        if (v === 'none') return { severity: 'none' };
        const d = Math.round(Math.max(0, Math.min(3600, Number(delay.value) || 0)) * 1000);
        return { severity: v, when: when.value, text: text.value.trim(), delay: d, codes: codes && codes.value ? codes.value : null };
      };
    }
    overlay.append(box);
    document.body.append(overlay);
    search.focus();

    const close = () => { clearInterval(timer); document.removeEventListener('keydown', onKey, true); overlay.remove(); };
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (!editBox.hidden) closeEditor(); else close();
    }
    document.addEventListener('keydown', onKey, true);   // før en eventuell editor under
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(); });

    // ---- rader
    let rows = new Map();   // navn -> { valueCell, ageCell, row }
    let lastKeys = '';
    function state(name, info) {
      const v = opts.live(name);
      const online = info.source === 'calc' || info.online !== false;
      if (!v || v.value === undefined || v.value === null) return 'none';
      if (v.quality === 'bad' || !online) return 'stale';
      return 'live';
    }
    function matches(name, info) {
      const q = search.value.trim().toLowerCase();
      if (q && ![name, info.label, info.info, info.description].some(s => (s || '').toLowerCase().includes(q))) return false;
      const k = kind.value, isCalc = info.source === 'calc', s = state(name, info);
      if (k === 'named' && !info.label) return false;
      if (k === 'alarms' && !info.alarm) return false;
      if (k === 'device' && isCalc) return false;
      if (k === 'calc' && !isCalc) return false;
      if (k === 'live' && s !== 'live') return false;
      if (k === 'stale' && s === 'live') return false;
      return true;
    }
    function build() {
      const tags = opts.tags();
      const names = [...tags.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      table.innerHTML = '';
      rows = new Map();
      let shown = 0, group = null;
      const headRow = el('div', 'tb-row tb-th');
      headRow.append(el('span', null, 'Tag'), el('span', null, 'Value'), el('span', null, 'Unit'), el('span', null, 'Type'), el('span', null, 'Updated'), el('span', null, ''));
      table.append(headRow);
      for (const name of names) {
        const info = tags.get(name);
        if (!matches(name, info)) continue;
        const dev = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
        if (dev !== group) {
          group = dev;
          const g = el('div', 'tb-group');
          const online = dev === 'calc' || info.online !== false;
          g.append(el('span', 'tb-dot ' + (online ? 'on' : 'off')), el('span', null, dev === 'calc' ? 'calc  \u2014 calculated by the hub' : dev));
          if (dev !== 'calc' && !online) g.append(el('span', 'tb-off', 'disconnected'));
          table.append(g);
        }
        const clickable = picking || !!opts.editName;
        const row = el(clickable ? 'button' : 'div', 'tb-row');
        if (clickable) row.type = 'button';
        const nm = el('span', 'tb-name');
        if (info.source === 'calc') { const f = el('span', 'calc-badge', '\u0192'); f.title = info.formula || ''; nm.append(f); }
        nm.append(el('span', 'tb-dev', dev + '.'), el('span', null, name.slice(dev.length + 1)));
        if (info.writable) { const wr = el('span', 'tb-rw', 'writable'); nm.append(wr); }
        if (info.label) nm.append(el('span', 'tb-label', info.label));
        if (info.alarm) {
          const a = el('span', 'tb-alarm ' + info.alarm.severity, info.alarm.severity === 'alarm' ? '\u26a0 alarm' : '\u26a0 warning');
          a.title = alarmSummary(info.alarm, info) + (info.ownAlarm ? '' : '\nFrom the adapter (kjoreverk-options.json)');
          nm.append(a);
        }
        const valueCell = el('span', 'tb-val'), unitCell = el('span', 'tb-unit', info.unit || ''), ageCell = el('span', 'tb-age');
        const typeCell = el('span', 'tb-type', TYPES[info.dataType] || info.dataType || '');
        const stateCell = el('span', 'tb-state');
        row.append(nm, valueCell, unitCell, typeCell, ageCell, stateCell);
        const about = [info.label, info.info, info.formula ? `${name} = ${info.formula}` : info.description].filter(Boolean);
        if (about.length) row.title = about.join('\n');
        if (opts.current && opts.current === name) row.classList.add('current');
        if (clickable) row.addEventListener('click', () => {
          if (naming || !picking) { if (!naming) nameBtn.click(); openEditor(name, info); return; }
          const text = useVars && useVars.checked ? (withVars(name) || name) : name;
          close();
          opts.pick(text);
        });
        table.append(row);
        rows.set(name, { row, valueCell, ageCell, stateCell, info });
        shown++;
      }
      if (!shown) table.append(el('div', 'mm-muted', tags.size ? 'No tags match.' : 'No tags on the hub yet. Start an adapter and its tags appear here.'));
      count.textContent = ` ${shown} of ${tags.size}`;
      refresh();
      const cur = table.querySelector('.tb-row.current');
      if (cur) cur.scrollIntoView({ block: 'center' });
    }
    function refresh() {
      for (const [name, r] of rows) {
        const v = opts.live(name);
        const s = state(name, r.info);
        r.valueCell.textContent = v ? show(v.value) : '\u2014';
        r.valueCell.className = 'tb-val' + (v && typeof v.value === 'boolean' ? (v.value ? ' on' : ' off') : '');
        r.ageCell.textContent = v ? ago(v.ts) : 'never';
        r.stateCell.textContent = s === 'live' ? '' : s === 'stale' ? 'stale' : 'no value';
        r.row.classList.toggle('stale', s !== 'live');
      }
    }
    search.addEventListener('input', build);
    kind.addEventListener('change', build);
    // verdier hvert halve sekund; selve listen når tagger kommer eller går
    const timer = setInterval(() => {
      const keys = [...opts.tags().keys()].join('|');
      if (keys !== lastKeys) { lastKeys = keys; build(); } else refresh();
    }, 500);
    lastKeys = [...opts.tags().keys()].join('|');
    build();
    return close;
  };
})();
