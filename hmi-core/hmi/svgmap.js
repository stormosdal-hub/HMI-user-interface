/*
 * Koblingseditor for Drawing-widgeter.
 *
 * Venstre: tegningen. Hover viser hvilken del som er under markøren, klikk velger den.
 * Høyre: delene i tegningen (navngitte som standard), og koblingene til den
 * valgte delen. Koblinger redigeres på en kopi og skrives bare tilbake ved Apply.
 *
 * H.openMappingEditor(widget, {
 *   resolveTag(name) -> string,   tagExists(name) -> bool,
 *   onSave(bindings)
 * })
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el } = H.helpers;
  const S = () => H.svg;

  const RULE_HINT = 'Conditions: true · false · =3 · !=0 · >50 · <=10 · 10..20 · running · * (anything). The first matching rule wins; no match keeps the drawing\u2019s own colour.';
  const WHEN_HINT = 'true · false · =3 · >50 · 10..20 · running · *';

  H.openMappingEditor = function (widget, opts) {
    const svgApi = S();
    let working = JSON.parse(JSON.stringify(widget.props.bindings || []));
    const startJSON = JSON.stringify(working);
    let selected = null;
    let showAll = false;
    let svg = null, allParts = [], partIds = new Set();

    // ---------------------------------------------------------------- skall
    const overlay = el('div', 'mm-overlay');
    const box = el('div', 'mm');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Mapping editor');
    const head = el('header', 'mm-head');
    const title = el('h2', null, `Mappings \u00b7 ${widget.props.asset}`);
    const actions = el('div', 'mm-actions');
    const cancelBtn = el('button', 'ghost', 'Cancel');
    const applyBtn = el('button', 'primary', 'Apply');
    actions.append(cancelBtn, applyBtn);
    head.append(title, actions);

    const bodyEl = el('div', 'mm-body');
    const stage = el('section', 'mm-stage');
    const canvas = el('div', 'mm-canvas');
    const layer = el('div', 'mm-layer');      // omriss tegnet over tegningen
    const hover = el('div', 'mm-hover');
    const tip = el('div', 'mm-tip');
    hover.append(tip);
    stage.append(canvas, layer, hover);
    const side = el('aside', 'mm-side');
    bodyEl.append(stage, side);
    box.append(head, bodyEl);
    overlay.append(box);
    document.body.append(overlay);
    applyBtn.focus();

    function close() {
      window.removeEventListener('resize', drawOutlines);
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
    function dirty() { return JSON.stringify(working) !== startJSON; }
    cancelBtn.addEventListener('click', () => { if (!dirty() || confirm('Discard changes to the mappings?')) close(); });
    applyBtn.addEventListener('click', () => { opts.onSave(working.filter(b => b.target)); close(); });
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    }
    document.addEventListener('keydown', onKey);

    // ---------------------------------------------------------------- tegning
    canvas.append(el('div', 'mm-empty', 'Loading drawing\u2026'));
    svgApi.load(widget.props.asset).then(text => {
      canvas.innerHTML = '';
      svg = svgApi.build(text, widget.props);
      canvas.append(svg);
      allParts = svgApi.parts(svg);
      partIds = new Set(allParts.map(p => p.id));
      const firstMapped = working.find(b => partIds.has(b.target));
      selected = firstMapped ? firstMapped.target : null;
      renderSide();
      requestAnimationFrame(drawOutlines);
    }).catch(e => { canvas.innerHTML = ''; canvas.append(el('div', 'mm-empty err', e.message)); });

    const pickable = () => new Set(allParts.filter(p => showAll || !p.generated).map(p => p.id));

    function partAt(node) {
      const ok = pickable();
      for (let n = node; n && n !== svg && n !== canvas; n = n.parentElement || n.parentNode) {
        const id = svgApi.idOf(n);
        if (id && ok.has(id)) return id;
      }
      return null;
    }

    function place(div, rect) {
      const base = stage.getBoundingClientRect();
      Object.assign(div.style, {
        left: (rect.left - base.left - 3) + 'px', top: (rect.top - base.top - 3) + 'px',
        width: (rect.width + 6) + 'px', height: (rect.height + 6) + 'px',
      });
    }

    function drawOutlines() {
      layer.innerHTML = '';
      if (!svg) return;
      const mapped = new Set(working.map(b => b.target));
      for (const p of allParts) {
        const isSel = p.id === selected;
        if (!isSel && !mapped.has(p.id)) continue;
        const r = svgApi.clientRect(p.el);
        if (!r) continue;
        const d = el('div', 'mm-outline' + (isSel ? ' sel' : ''));
        place(d, r);
        if (isSel) d.append(el('span', 'mm-tag', p.id));
        layer.append(d);
      }
    }
    window.addEventListener('resize', drawOutlines);

    stage.addEventListener('mousemove', e => {
      const id = svg && partAt(e.target);
      if (!id) { hover.style.display = 'none'; stage.style.cursor = ''; return; }
      const r = svgApi.clientRect(svgApi.find(svg, id));
      if (!r) return;
      place(hover, r);
      tip.textContent = id;
      hover.style.display = 'block';
      stage.style.cursor = 'pointer';
    });
    stage.addEventListener('mouseleave', () => { hover.style.display = 'none'; });
    stage.addEventListener('click', e => {
      const id = svg && partAt(e.target);
      if (!id) return;
      selected = id;
      if (!working.some(b => b.target === id)) addBinding(id);
      renderSide();
      drawOutlines();
    });

    // ---------------------------------------------------------------- sidepanel
    function addBinding(target) {
      working.push({ target, tag: '', action: 'color', ...svgApi.defaultsFor('color') });
    }

    function renderSide() {
      side.innerHTML = '';
      const counts = new Map();
      for (const b of working) counts.set(b.target, (counts.get(b.target) || 0) + 1);

      // liste over deler
      const partsBox = el('div', 'mm-section');
      const h = el('div', 'mm-row-between');
      h.append(el('h3', null, 'Parts'));
      const toggle = el('label', 'mm-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = showAll;
      cb.addEventListener('change', () => { showAll = cb.checked; renderSide(); });
      toggle.append(cb, document.createTextNode(' include unnamed'));
      h.append(toggle);
      partsBox.append(h);
      const list = el('div', 'mm-parts');
      const visibleParts = allParts.filter(p => showAll || !p.generated || counts.has(p.id));
      if (!visibleParts.length) {
        list.append(el('div', 'mm-muted', 'No named parts. Give shapes an id in your drawing program, or tick "include unnamed".'));
      }
      for (const p of visibleParts) {
        const b = el('button', 'mm-part' + (p.id === selected ? ' on' : '') + (p.generated ? ' gen' : ''));
        b.append(el('span', null, p.id));
        if (counts.get(p.id)) b.append(el('b', null, String(counts.get(p.id))));
        b.addEventListener('click', () => { selected = p.id; renderSide(); drawOutlines(); });
        list.append(b);
      }
      partsBox.append(list);

      const lost = [...new Set(working.map(b => b.target))].filter(t => t && !partIds.has(t));
      if (lost.length && svg) {
        const warn = el('div', 'mm-lost');
        warn.append(el('b', null, 'Not in this drawing: '), document.createTextNode(lost.join(', ')));
        warn.append(el('div', 'mm-muted', 'The part was renamed or removed. Select it below to delete or retarget its mappings.'));
        for (const t of lost) {
          const b = el('button', 'mm-part lostpart' + (t === selected ? ' on' : ''), t);
          b.addEventListener('click', () => { selected = t; renderSide(); drawOutlines(); });
          warn.append(b);
        }
        partsBox.append(warn);
      }
      side.append(partsBox);

      // koblingene til den valgte delen
      const detail = el('div', 'mm-section');
      if (!selected) {
        detail.append(el('div', 'mm-muted', 'Click a part of the drawing, or pick one from the list, to map it to tags.'));
        side.append(detail);
        return;
      }
      const dh = el('div', 'mm-row-between');
      dh.append(el('h3', null, selected));
      detail.append(dh);
      detail.append(el('div', 'mm-muted', 'Show actions change the drawing when the tag changes. Control actions write the tag when the part is clicked in Run mode. One part can have several rows.'));
      working.forEach((b, i) => { if (b.target === selected) detail.append(card(b, i)); });
      const add = el('button', 'mm-add', '+ Add mapping');
      add.addEventListener('click', () => { addBinding(selected); renderSide(); drawOutlines(); });
      detail.append(add);
      side.append(detail);
    }

    // én koblingsrad
    function card(b, index) {
      const c = el('div', 'mm-card ' + ((svgApi.ACTIONS[b.action] || {}).dir || ''));

      const top = el('div', 'mm-card-top');
      const sel = el('select');
      for (const [dir, label] of [['show', 'Show (tag \u2192 drawing)'], ['control', 'Control (drawing \u2192 tag)']]) {
        const g = document.createElement('optgroup');
        g.label = label;
        for (const [key, a] of Object.entries(svgApi.ACTIONS)) {
          if (a.dir !== dir) continue;
          const o = el('option', null, a.label);
          o.value = key;
          g.append(o);
        }
        sel.append(g);
      }
      sel.value = b.action;
      sel.addEventListener('change', () => {
        const keep = { target: b.target, tag: b.tag };
        working[index] = { ...keep, action: sel.value, ...svgApi.defaultsFor(sel.value) };
        renderSide();
      });
      const del = el('button', 'mm-x', '\u2715');
      del.title = 'Remove this mapping';
      del.addEventListener('click', () => { working.splice(index, 1); renderSide(); drawOutlines(); });
      top.append(sel, del);
      c.append(top);

      // tag
      const tagRow = el('div', 'mm-field');
      tagRow.append(el('label', null, 'Tag'));
      const tagIn = el('input');
      tagIn.type = 'text';
      tagIn.value = b.tag || '';
      tagIn.placeholder = 'device.tag or ${var}.tag';
      tagIn.setAttribute('list', 'taglist');
      tagIn.autocomplete = 'off';
      const status = el('div', 'mm-tagstatus');
      const showStatus = () => {
        const raw = tagIn.value.trim();
        status.textContent = '';
        status.className = 'mm-tagstatus';
        if (!raw) { status.textContent = 'No tag yet'; status.classList.add('warn'); return; }
        const res = opts.resolveTag(raw);
        const known = opts.tagExists(res);
        const info = opts.tagInfo ? opts.tagInfo(res) : null;
        const what = info && info.source === 'calc' ? '\u0192 calculated on hub' : 'on hub';
        status.textContent = (res !== raw ? `\u2192 ${res} \u00b7 ` : '') + (known ? what : 'not on hub right now');
        status.classList.add(known ? 'ok' : 'warn');
      };
      tagIn.addEventListener('input', () => { b.tag = tagIn.value.trim(); showStatus(); });
      showStatus();
      const tagLine = el('div', 'tagline');
      tagLine.append(tagIn);
      if (opts.browseTags) {
        const btn = el('button', 'tagbtn');
        btn.type = 'button';
        btn.title = 'Browse tags with live values';
        btn.setAttribute('aria-label', 'Browse tags');
        btn.textContent = '\u2630';
        btn.addEventListener('click', () => opts.browseTags(tagIn.value.trim(), text => {
          tagIn.value = text;
          b.tag = text;
          showStatus();
        }));
        tagLine.append(btn);
      }
      tagRow.append(tagLine, status);
      c.append(tagRow);

      // parametere for handlingen
      const def = svgApi.ACTIONS[b.action] || { params: [] };
      if (!def.params.length) c.append(el('div', 'mm-muted', b.action === 'toggle' ? 'Click writes the opposite of the tag\u2019s current value.' : ''));
      for (const p of def.params) {
        if (p.type === 'rules') { c.append(rulesEditor(b)); continue; }
        const f = el('div', 'mm-field');
        f.append(el('label', null, p.label));
        let input;
        if (p.type === 'select') {
          input = el('select');
          for (const o of p.options) { const op = el('option', null, o); op.value = o; input.append(op); }
          input.value = b[p.key] ?? p.default;
          input.addEventListener('change', () => { b[p.key] = input.value; });
        } else {
          input = el('input');
          input.type = p.type === 'number' ? 'number' : 'text';
          if (p.type === 'number') input.step = 'any';
          input.value = b[p.key] ?? p.default;
          if (p.key === 'when') input.placeholder = WHEN_HINT;
          input.addEventListener('input', () => { b[p.key] = p.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value; });
        }
        f.append(input);
        if (p.hint) f.append(el('div', 'mm-muted', p.hint));
        else if (p.key === 'when') f.append(el('div', 'mm-muted', WHEN_HINT));
        c.append(f);
      }
      return c;
    }

    function rulesEditor(b) {
      if (!Array.isArray(b.rules)) b.rules = [];
      const wrap = el('div', 'mm-field');
      wrap.append(el('label', null, 'Rules'));
      const rows = el('div', 'mm-rules');
      const draw = () => {
        rows.innerHTML = '';
        b.rules.forEach((r, i) => {
          const row = el('div', 'mm-rule');
          const w = el('input');
          w.type = 'text';
          w.value = r.when ?? '';
          w.placeholder = 'when';
          w.addEventListener('input', () => { r.when = w.value; });
          const col = el('input');
          col.type = 'color';
          col.value = /^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : '#43c483';
          r.color = col.value;
          col.addEventListener('input', () => { r.color = col.value; });
          const x = el('button', 'mm-x', '\u2715');
          x.title = 'Remove rule';
          x.addEventListener('click', () => { b.rules.splice(i, 1); draw(); });
          row.append(w, col, x);
          rows.append(row);
        });
        const add = el('button', 'mm-add small', '+ Rule');
        add.addEventListener('click', () => { b.rules.push({ when: '', color: '#f2b441' }); draw(); });
        rows.append(add);
      };
      draw();
      wrap.append(rows, el('div', 'mm-muted', RULE_HINT));
      return wrap;
    }

    renderSide();
  };
})();
