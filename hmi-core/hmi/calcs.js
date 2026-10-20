/*
 * Editor for beregninger.
 *
 * Beregnede tagger defineres i prosjektfilen og regnes ut av huben, så hver
 * HMI viser samme resultat og trender har historikk. Denne dialogen redigerer listen; hver
 * formel sjekkes fortløpende av hubens egen parser mens du skriver.
 *
 * H.openCalcEditor({
 *   calcs: [...], vars: {...},
 *   tagNames() -> [navn i huben], tagInfo(name) -> oppføring i registeret | undefined,
 *   live(name) -> { value, quality } | undefined   (siste oppdatering, ikke øyeblikksbildet i registeret)
 *   check(formula, pendingNames) -> Promise<{ ok, error, pos, deps, unknown, value, note }>,
 *   save(calcs) -> Promise
 * })
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el, fmt } = H.helpers;
  const NAME_RX = /^[A-Za-z_]\w*(\.\w+)*$/;
  const BARE_TAG = /^[A-Za-z_]\w*(\.\w+)+$/;

  const HELP = [
    ['Tags', 'mono_1.speed \u00b7 ${mono}.speed \u00b7 calc.motor_power \u00b7 [odd-name.with-dashes]'],
    ['Operators', '+ \u2212 * / % ^ \u00b7 == != < <= > >= \u00b7 && || ! \u00b7 cond ? a : b'],
    ['Functions', 'abs sqrt pow exp log log10 sin cos tan asin acos atan atan2 floor ceil round(x, digits) sign min max avg sum hypot clamp(x, lo, hi) if(cond, a, b)'],
    ['Conditions', 'a && b && !c (all of them) \u00b7 a || b (any) \u00b7 count(a, b, c) >= 2 (at least two true) \u00b7 between(x, lo, hi) \u00b7 choose type boolean for yes/no results'],
    ['Over time', 'changes(x, s) how often x changed \u00b7 rate(x, s) change per second \u00b7 delta(x, s) change over s \u00b7 held(cond, s) true after s seconds without a break \u00b7 stretch(cond, s) stays true s seconds after \u00b7 avgOver minOver maxOver(x, s). s is seconds, a number. They start measuring when saved.'],
    ['Constants', 'pi e true false \u2014 booleans count as 1 and 0, angles are radians'],
    ['Quality', 'If an input is stale or missing, the result is stale too. Division by zero gives a stale result, never a number.'],
  ];

  // mønstre å starte fra; device.*-navn er plassholdere som byttes ut med ekte tagger
  const EXAMPLES = [
    ['All conditions met', 'device.speed > 1000 && device.sensor1 && !device.sensor2', 'boolean'],
    ['At least 2 of 3 signals true', 'count(device.sensor1, device.sensor2, device.sensor3) >= 2', 'boolean'],
    ['Value inside a band', 'between(device.speed, 900, 1100)', 'boolean'],
    ['Conditions met for 5 s', 'held(device.speed > 1000 && device.sensor1, 5)', 'boolean'],
    ['Signal flickering (loose cable?)', 'changes(device.sensor1, 2) >= 6', 'boolean'],
    ['Value changing too fast (crash?)', 'abs(rate(device.speed, 0.5)) > 5000', 'boolean'],
    ['Keep a short event visible for 10 s', 'stretch(changes(device.sensor1, 2) >= 6, 10)', 'boolean'],
    ['A number when conditions are met', 'if(device.speed > 1000 && device.sensor1, 1, 0)', 'number'],
    ['Average over the last minute', 'avgOver(device.speed, 60)', 'number'],
  ];

  H.openCalcEditor = function (opts) {
    const working = JSON.parse(JSON.stringify(opts.calcs || []));
    const startJSON = JSON.stringify(working);
    const checks = new Map();       // beregning -> resultat av siste sjekk
    const nameErrors = new Map();   // beregning -> problem med navnet

    const overlay = el('div', 'mm-overlay');
    const box = el('div', 'mm ce');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Calculations');
    const head = el('header', 'mm-head');
    head.append(el('h2', null, '\u0192  Calculations'));
    const actions = el('div', 'mm-actions');
    const cancelBtn = el('button', 'ghost', 'Cancel');
    const saveBtn = el('button', 'primary', 'Save & apply');
    actions.append(cancelBtn, saveBtn);
    head.append(actions);
    const body = el('div', 'ce-body');
    const intro = el('p', 'ce-intro');
    intro.textContent = 'Values worked out by the hub from other tags. Each result is a read-only tag named calc.<name>, marked \u0192 wherever it is shown, and kept in the hub\u2019s history like a measured tag. Changes take effect when you save \u2014 no restart.';
    const list = el('div', 'ce-list');
    const add = el('button', 'mm-add', '+ Add calculation');
    const help = el('div', 'ce-help');
    for (const [k, v] of HELP) { const row = el('div'); row.append(el('b', null, k), el('span', null, v)); help.append(row); }
    body.append(intro, list, add, help);
    box.append(head, body);
    overlay.append(box);
    document.body.append(overlay);

    const refreshers = new Set();
    const ticker = setInterval(() => refreshers.forEach(f => f()), 1000);
    const close = () => { clearInterval(ticker); document.removeEventListener('keydown', onKey); overlay.remove(); };
    const dirty = () => JSON.stringify(working) !== startJSON;
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); } }
    document.addEventListener('keydown', onKey);
    cancelBtn.addEventListener('click', () => { if (!dirty() || confirm('Discard changes to the calculations?')) close(); });
    add.addEventListener('click', () => {
      working.push({ name: '', formula: '', unit: '', decimals: 2, type: 'number', description: '', event: { severity: '', text: '' } });
      render();
      const last = list.lastElementChild;
      if (last) last.querySelector('.ce-name input').focus();
    });

    saveBtn.addEventListener('click', async () => {
      const problems = validateNames();
      if (problems.length) { render(); return; }
      const clean = working.filter(c => c.name || c.formula).map(c => {
        const o = { ...c };
        if (!o.event || !o.event.severity) delete o.event;   // ingen tomme hendelsesoppføringer i prosjektfilen
        return o;
      });
      const broken = clean.filter(c => { const r = checks.get(c); return r && r.ok === false; });
      if (broken.length && !confirm(`${broken.length} calculation${broken.length > 1 ? 's have' : ' has'} an error and won\u2019t run until fixed. Save anyway?`)) return;
      saveBtn.disabled = true;
      try { await opts.save(clean); close(); }
      catch (e) { saveBtn.disabled = false; }
    });

    const pendingNames = () => working.filter(c => NAME_RX.test(c.name || '')).map(c => 'calc.' + c.name);

    function validateNames() {
      const seen = new Map(), problems = [];
      nameErrors.clear();
      for (const c of working) {
        if (!c.name && !c.formula) continue;
        let err = '';
        if (!NAME_RX.test(c.name || '')) err = 'Use letters, digits and _ (dots between parts), starting with a letter';
        else if (seen.has(c.name)) err = 'Another calculation already has this name';
        seen.set(c.name, c);
        if (err) { nameErrors.set(c, err); problems.push(c); }
      }
      return problems;
    }

    function insertAt(ta, text) {
      const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
      ta.selectionStart = ta.selectionEnd = a + text.length;
      ta.focus();
      ta.dispatchEvent(new Event('input'));
    }
    // bruk helst ${var}-formen når en prosjektvariabel passer med enhetsdelen, så formler følger den
    function tagText(name) {
      for (const [k, v] of Object.entries(opts.vars || {})) {
        if (v && name.startsWith(v + '.')) return '${' + k + '}' + name.slice(v.length);
      }
      return BARE_TAG.test(name) ? name : '[' + name + ']';
    }

    function card(c, index) {
      const d = el('div', 'ce-card');

      // navn, type, enhet, desimaler
      const row = el('div', 'ce-row');
      const nameWrap = el('label', 'ce-name');
      nameWrap.append(el('span', 'ce-prefix', 'calc.'));
      const name = el('input');
      name.type = 'text';
      name.value = c.name || '';
      name.placeholder = 'motor_power';
      name.spellcheck = false;
      nameWrap.append(name);
      const type = el('select');
      for (const t of ['number', 'boolean']) { const o = el('option', null, t); o.value = t; type.append(o); }
      type.value = c.type === 'boolean' ? 'boolean' : 'number';
      const unit = el('input');
      unit.type = 'text'; unit.value = c.unit || ''; unit.placeholder = 'unit'; unit.className = 'ce-unit';
      const dec = el('input');
      dec.type = 'number'; dec.value = c.decimals ?? 2; dec.min = 0; dec.max = 6; dec.className = 'ce-dec'; dec.title = 'Decimals shown in the preview';
      const del = el('button', 'mm-x', '\u2715');
      del.title = 'Delete this calculation';
      del.addEventListener('click', () => {
        if ((c.formula || c.name) && !confirm(`Delete calc.${c.name || '(unnamed)'}? Widgets using it will show no value.`)) return;
        working.splice(index, 1);
        render();
      });
      row.append(nameWrap, type, unit, dec, del);
      d.append(row);
      if (nameErrors.has(c)) d.append(el('div', 'ce-status err', nameErrors.get(c)));

      // formel
      const ta = el('textarea', 'ce-formula');
      ta.value = c.formula || '';
      ta.rows = 2;
      ta.spellcheck = false;
      ta.placeholder = '${mono}.torque * ${mono}.speed * 2 * pi / 60 / 1000';
      d.append(ta);

      const tools = el('div', 'ce-tools');
      const pick = el('select');
      const first = el('option', null, 'Insert tag\u2026'); first.value = ''; pick.append(first);
      const measured = document.createElement('optgroup'); measured.label = 'From devices';
      const calculated = document.createElement('optgroup'); calculated.label = 'Calculated';
      const self = 'calc.' + (c.name || '');
      for (const n of [...new Set([...opts.tagNames(), ...pendingNames()])].sort()) {
        if (n === self) continue;
        const o = el('option', null, n); o.value = n;
        (n.startsWith('calc.') ? calculated : measured).append(o);
      }
      if (measured.children.length) pick.append(measured);
      if (calculated.children.length) pick.append(calculated);
      pick.addEventListener('change', () => { if (pick.value) insertAt(ta, tagText(pick.value)); pick.value = ''; });
      tools.append(pick);
      const ex = el('select');
      const ex0 = el('option', null, 'Insert example\u2026'); ex0.value = ''; ex.append(ex0);
      EXAMPLES.forEach(([label], i) => { const o = el('option', null, label); o.value = String(i); ex.append(o); });
      ex.title = 'Start from a pattern, then replace device.* with your tags';
      ex.addEventListener('change', () => {
        const e = EXAMPLES[+ex.value];
        ex.value = '';
        if (!e) return;
        if (ta.value.trim() && !confirm('Replace the formula with this example?')) return;
        ta.value = e[1];
        c.formula = e[1];
        c.type = e[2];
        type.value = e[2];
        ta.dispatchEvent(new Event('input'));
        ta.focus();
      });
      tools.append(ex);
      const desc = el('input');
      desc.type = 'text'; desc.value = c.description || ''; desc.placeholder = 'Note (optional) \u2014 what this is and why'; desc.className = 'ce-desc';
      tools.append(desc);
      d.append(tools);

      // en hendelse når resultatet blir true (eller ulikt null): uønskede tilstander havner i loggen
      const evRow = el('div', 'ce-event');
      const ev = c.event || (c.event = { severity: '', text: '' });
      const sev = el('select');
      for (const [v, t] of [['', 'No event'], ['info', 'Info event'], ['warning', 'Warning event'], ['alarm', 'Alarm event']]) {
        const o = el('option', null, t); o.value = v; sev.append(o);
      }
      sev.value = ev.severity || '';
      sev.setAttribute('aria-label', 'Event when it becomes true');
      const evText = el('input');
      evText.type = 'text';
      evText.value = ev.text || '';
      evText.placeholder = 'when it becomes true, e.g. Sensor 5 is flickering: loose cable?';
      evText.disabled = !ev.severity;
      sev.addEventListener('change', () => { ev.severity = sev.value; evText.disabled = !sev.value; if (sev.value) evText.focus(); });
      evText.addEventListener('input', () => { ev.text = evText.value; });
      evRow.append(el('span', 'ce-evlabel', 'When it becomes true:'), sev, evText);
      d.append(evRow);

      const status = el('div', 'ce-status');
      const running = el('div', 'ce-running');
      d.append(status, running);

      // det huben kjører nå for dette navnet (gir bare mening når det er lagret)
      const showRunning = () => {
        const info = c.name && opts.tagInfo('calc.' + c.name);
        running.textContent = '';
        if (!info) return;
        const same = info.formula === (c.formula || '');
        let text = 'Running on hub: ';
        if (info.error) { running.className = 'ce-running err'; text += info.error; }
        else {
          running.className = 'ce-running';
          const now = opts.live('calc.' + c.name) || info;
          const v = now.value;
          text += (v === null || v === undefined ? '\u2014' : typeof v === 'boolean' ? String(v) : fmt(v, c.decimals ?? 2) + (c.unit ? ' ' + c.unit : ''));
          if (now.quality && now.quality !== 'good') text += ` (${now.quality}${info.note ? ', ' + info.note : ''})`;
        }
        if (!same) text += ' \u00b7 edited, not saved yet';
        running.textContent = text;
      };

      let timer = 0, seq = 0;
      const check = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const f = (c.formula || '').trim();
          if (!f) { status.className = 'ce-status'; status.textContent = 'Write a formula using tags, numbers and functions.'; checks.delete(c); return; }
          const my = ++seq;
          let r;
          try { r = await opts.check(f, pendingNames()); } catch (e) { r = { ok: null, error: e.message }; }
          if (my !== seq) return;
          checks.set(c, r);
          if (r.ok === null) { status.className = 'ce-status warn'; status.textContent = 'Can\u2019t check: ' + r.error; return; }
          if (!r.ok) {
            status.className = 'ce-status err';
            status.textContent = `\u2715 ${r.error}` + (r.pos != null ? ` (at character ${r.pos + 1})` : '');
            return;
          }
          const parts = [];
          if (r.value != null) parts.push('= ' + (c.type === 'boolean' ? String(!!r.value) : fmt(r.value, c.decimals ?? 2) + (c.unit ? ' ' + c.unit : '')));
          else if (r.note) parts.push(r.note);
          else parts.push('no value yet');
          if (r.timed) parts.push('time functions start measuring once saved');
          if (r.deps && r.deps.length) parts.push('uses ' + r.deps.join(', '));
          status.className = 'ce-status ' + (r.unknown && r.unknown.length ? 'warn' : 'ok');
          status.textContent = (r.unknown && r.unknown.length ? '\u26a0 ' : '\u2713 ') + parts.join(' \u00b7 ') +
            (r.unknown && r.unknown.length ? ` \u00b7 not on hub right now: ${r.unknown.join(', ')}` : '');
        }, 250);
      };

      name.addEventListener('input', () => { c.name = name.value.trim(); showRunning(); });
      name.addEventListener('change', () => { validateNames(); render(); });
      type.addEventListener('change', () => { c.type = type.value; check(); });
      unit.addEventListener('input', () => { c.unit = unit.value; check(); });
      dec.addEventListener('input', () => { c.decimals = dec.value === '' ? 2 : Number(dec.value); check(); });
      ta.addEventListener('input', () => { c.formula = ta.value; check(); showRunning(); });
      desc.addEventListener('input', () => { c.description = desc.value; });
      check();
      showRunning();
      refreshers.add(showRunning);
      return d;
    }

    function render() {
      refreshers.clear();
      list.innerHTML = '';
      if (!working.length) list.append(el('div', 'mm-muted', 'No calculations yet. Add one to work out values like power, efficiency or totals from measured tags.'));
      working.forEach((c, i) => list.append(card(c, i)));
    }
    validateNames();
    render();
  };
})();
