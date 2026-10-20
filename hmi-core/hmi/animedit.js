/*
 * Kodeeditor for Animation-widgeter.
 *
 * Venstre: kodesnutten med linjenumre. Høyre: en live forhåndsvisning i samme sandkasse som
 * widgeten bruker, en testkontroll for hver inngang koden deklarerer, og en konsoll som
 * viser feil med kodesnuttens egne linjenumre (klikk på en for å hoppe dit).
 *
 * H.openAnimEditor({ name, code, colors, boundTag(input) -> tag|'', live(tag) -> value, save(code) -> Promise })
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el, fmt } = H.helpers;

  H.openAnimEditor = function (opts) {
    let saved = opts.code;
    let runner = null;
    const testValues = {};          // navn på inngang -> verdi valgt med testkontrollene
    let declared = [];
    let useLive = false, liveTimer = 0;

    // ---------------------------------------------------------------- skall
    const overlay = el('div', 'mm-overlay');
    const box = el('div', 'mm ae');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Animation code editor');
    const head = el('header', 'mm-head');
    const title = el('h2', null, `Animation \u00b7 ${opts.name}`);
    const state = el('span', 'ae-state');
    title.append(state);
    const actions = el('div', 'mm-actions');
    const closeBtn = el('button', 'ghost', 'Close');
    const saveBtn = el('button', 'primary', 'Save');
    actions.append(closeBtn, saveBtn);
    head.append(title, actions);

    const bodyEl = el('div', 'ae-body');
    // kode
    const left = el('section', 'ae-left');
    const codebox = el('div', 'ae-codebox');
    const gutter = el('div', 'ae-gutter');
    const ta = el('textarea', 'ae-code');
    ta.value = opts.code;
    ta.spellcheck = false;
    ta.wrap = 'off';
    ta.setAttribute('aria-label', 'Animation code');
    codebox.append(gutter, ta);
    left.append(codebox, el('div', 'ae-hint', 'Ctrl+Enter runs \u00b7 Ctrl+S saves \u00b7 Tab indents \u00b7 hmi.inputs() \u00b7 hmi.stage() \u00b7 hmi.asset(name) \u00b7 hmi.colors \u2014 see the README'));
    // forhåndsvisning, innganger, konsoll
    const right = el('section', 'ae-right');
    const bar = el('div', 'ae-bar');
    const runBtn = el('button', 'ae-run', '\u25b6 Run');
    const liveLabel = el('label', 'mm-check');
    const liveBox = el('input');
    liveBox.type = 'checkbox';
    liveLabel.append(liveBox, document.createTextNode(' Use live tag values'));
    bar.append(runBtn, liveLabel);
    const preview = el('div', 'ae-preview');
    const inputsBox = el('div', 'ae-inputs');
    const consoleHead = el('div', 'ae-conhead');
    consoleHead.append(el('span', null, 'Console'));
    const clearBtn = el('button', 'ae-clear', 'Clear');
    consoleHead.append(clearBtn);
    const con = el('div', 'ae-console');
    right.append(bar, preview, inputsBox, consoleHead, con);
    bodyEl.append(left, right);
    box.append(head, bodyEl);
    overlay.append(box);
    document.body.append(overlay);
    ta.focus();

    // ---------------------------------------------------------------- kodefelt
    function lines() {
      const n = ta.value.split('\n').length;
      if (gutter.childElementCount !== n) {
        gutter.innerHTML = '';
        for (let i = 1; i <= n; i++) gutter.append(el('div', null, String(i)));
      }
      gutter.scrollTop = ta.scrollTop;
    }
    const dirty = () => ta.value !== saved;
    const markState = () => { state.textContent = dirty() ? ' \u2022 unsaved' : ''; };
    ta.addEventListener('input', () => { lines(); markState(); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const a = ta.selectionStart, b = ta.selectionEnd;
        ta.value = ta.value.slice(0, a) + '  ' + ta.value.slice(b);
        ta.selectionStart = ta.selectionEnd = a + 2;
        lines(); markState();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); start(); }
    });
    lines();

    function goToLine(n) {
      const all = ta.value.split('\n');
      if (n < 1 || n > all.length) return;
      let pos = 0;
      for (let i = 0; i < n - 1; i++) pos += all[i].length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos + all[n - 1].length);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
      ta.scrollTop = Math.max(0, (n - 4) * lh);
      gutter.scrollTop = ta.scrollTop;
      [...gutter.children].forEach((g, i) => g.classList.toggle('hit', i === n - 1));
    }

    // ---------------------------------------------------------------- konsoll
    let lastKey = '', lastRow = null, repeat = 1;
    function log(kind, text, line) {
      const key = kind + text + line;
      if (key === lastKey && lastRow) { repeat++; lastRow.querySelector('.ae-count').textContent = '\u00d7' + repeat; return; }
      lastKey = key; repeat = 1;
      const row = el('div', 'ae-line ' + kind);
      if (line) {
        const a = el('button', 'ae-lineno', 'line ' + line);
        a.addEventListener('click', () => goToLine(line));
        row.append(a);
      }
      row.append(el('span', null, text), el('span', 'ae-count', ''));
      con.append(row);
      lastRow = row;
      while (con.childElementCount > 200) con.firstChild.remove();
      con.scrollTop = con.scrollHeight;
    }
    clearBtn.addEventListener('click', () => { con.innerHTML = ''; lastKey = ''; lastRow = null; [...gutter.children].forEach(g => g.classList.remove('hit')); });

    // ---------------------------------------------------------------- inngangspanel
    function renderInputs() {
      inputsBox.innerHTML = '';
      if (!declared.length) {
        inputsBox.append(el('div', 'mm-muted', 'The code declares no inputs yet. Add them with hmi.inputs({ name: value, ... }).'));
        return;
      }
      for (const d of declared) {
        const row = el('div', 'ae-input');
        const tag = opts.boundTag(d.name);
        const name = el('div', 'ae-iname');
        name.append(el('b', null, d.name));
        name.append(el('span', null, tag ? '\u2190 ' + tag : 'not bound to a tag'));
        const numeric = typeof d.value === 'number';
        const hasRange = numeric && Number.isFinite(d.min) && Number.isFinite(d.max);
        const ctl = el('input');
        ctl.type = hasRange ? 'range' : numeric ? 'number' : 'text';
        if (hasRange) { ctl.min = d.min; ctl.max = d.max; ctl.step = d.step || (d.max - d.min) / 200; }
        if (ctl.type === 'number') ctl.step = 'any';
        const start = testValues[d.name] ?? d.value;
        ctl.value = start;
        const shown = el('span', 'ae-ival', fmt(start, 1) + (d.unit ? ' ' + d.unit : ''));
        ctl.disabled = useLive && !!tag;
        ctl.addEventListener('input', () => {
          const v = numeric ? Number(ctl.value) : ctl.value;
          testValues[d.name] = v;
          shown.textContent = fmt(v, 1) + (d.unit ? ' ' + d.unit : '');
          if (runner) runner.send({ [d.name]: v });
        });
        row.dataset.name = d.name;
        row.append(name, ctl, shown);
        inputsBox.append(row);
      }
    }

    function pumpLive() {
      clearInterval(liveTimer);
      if (!useLive) return;
      liveTimer = setInterval(() => {
        const values = {};
        for (const d of declared) {
          const tag = opts.boundTag(d.name);
          if (!tag) continue;
          const v = opts.live(tag);
          if (v === undefined || v === null) continue;
          values[d.name] = v;
          const row = inputsBox.querySelector(`[data-name="${CSS.escape(d.name)}"]`);
          if (row) {
            row.querySelector('input').value = v;
            row.querySelector('.ae-ival').textContent = fmt(v, 1) + (d.unit ? ' ' + d.unit : '');
          }
        }
        if (runner && Object.keys(values).length) runner.send(values);
      }, 200);
    }
    liveBox.addEventListener('change', () => { useLive = liveBox.checked; renderInputs(); pumpLive(); if (!useLive && runner) runner.send({ ...testValues }); });

    // ---------------------------------------------------------------- kjøring
    function start() {
      if (runner) runner.destroy();
      preview.innerHTML = '';
      log('info', `Running ${opts.name}\u2026`);
      runner = H.anim.run(preview, ta.value, {
        colors: opts.colors,
        onMessage(m) {
          if (m.kind === 'inputs') { declared = m.inputs; renderInputs(); }
          else if (m.kind === 'error') log('error', m.message, m.line);
          else if (m.kind === 'log') log(m.level === 'error' ? 'error' : m.level === 'warn' ? 'warn' : 'plain', m.text);
        },
      });
      declared = [];
      renderInputs();
      if (Object.keys(testValues).length && !useLive) runner.send({ ...testValues });
    }
    runBtn.addEventListener('click', start);

    // ---------------------------------------------------------------- lagre / lukke
    async function save() {
      saveBtn.disabled = true;
      try { await opts.save(ta.value); saved = ta.value; markState(); log('info', 'Saved \u2014 widgets using this code have restarted.'); }
      catch (e) { log('error', 'Save failed: ' + e.message); }
      saveBtn.disabled = false;
    }
    saveBtn.addEventListener('click', save);
    function close() {
      clearInterval(liveTimer);
      if (runner) runner.destroy();
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    closeBtn.addEventListener('click', () => { if (!dirty() || confirm('Close without saving your changes to the code?')) close(); });
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeBtn.click(); }
    }
    document.addEventListener('keydown', onKey, true);

    start();
  };
})();
