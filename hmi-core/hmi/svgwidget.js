/*
 * Tegningswidget — en SVG fra prosjektets assets med en koblingstabell.
 *
 * Hver koblingsrad er  { target, tag, action, ...params }
 *   target : delen av tegningen, via data-cell-id (draw.io) eller id (Inkscape, Illustrator, håndskrevet)
 *   tag    : tag i huben, kan inneholde ${var}
 *   action : hva som skjer — handlingen bestemmer retningen:
 *
 *   show (tag -> tegning)                       control (tegning -> tag), bare i Run-modus
 *     color    rules [{when, color}], apply     toggle     klikk skriver det motsatte av taggens verdi
 *     text     template "{value} rpm", decimals momentary  trykk skriver `on`, slipp skriver `off`
 *     visible  when                             set        klikk skriver `value`
 *     blink    when
 *     spin     when, seconds (negativ = mot klokka)
 *     rotate   min, max -> from, to (grader)
 *     move     min, max -> dx, dy (tegningsenheter)
 *
 * Betingelser (`when`): true, false, =3, !=0, >50, <=10, 10..20, running, * (hva som helst)
 *
 * Flere rader kan peke på samme del: f.eks. en knapp som veksler `power` og
 * farges etter `power` — fargen viser da det enheten meldte tilbake.
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el, num, fmt, parseValue, truthy, plate } = H.helpers;
  const NS = 'http://www.w3.org/2000/svg';
  const PAINTABLE = 'rect,path,ellipse,circle,polygon,polyline,line';
  const MEASURABLE = PAINTABLE + ',text,image,use';

  // ---------------------------------------------------------------- handlingskatalog
  // Felles for kjøretiden og koblingseditoren (svgmap.js).
  const ACTIONS = {
    color: {
      dir: 'show', label: 'Colour by state',
      params: [
        { key: 'apply', label: 'Paint', type: 'select', options: ['fill', 'stroke', 'both'], default: 'fill' },
        { key: 'rules', label: 'Rules', type: 'rules', default: [{ when: 'true', color: '#43c483' }] },
      ],
    },
    text: {
      dir: 'show', label: 'Show value as text',
      params: [
        { key: 'template', label: 'Text', type: 'text', default: '{value}', hint: '{value} is replaced, e.g. {value} rpm' },
        { key: 'decimals', label: 'Decimals', type: 'number', default: 0 },
      ],
    },
    visible: { dir: 'show', label: 'Visible when', params: [{ key: 'when', label: 'When', type: 'text', default: 'true' }] },
    blink:   { dir: 'show', label: 'Blink when',   params: [{ key: 'when', label: 'When', type: 'text', default: 'true' }] },
    spin: {
      dir: 'show', label: 'Spin when',
      params: [
        { key: 'when', label: 'When', type: 'text', default: 'true' },
        { key: 'seconds', label: 'Seconds per turn', type: 'number', default: 2, hint: 'Negative spins counter-clockwise' },
      ],
    },
    rotate: {
      dir: 'show', label: 'Rotate by value',
      params: [
        { key: 'min', label: 'Value min', type: 'number', default: 0 },
        { key: 'max', label: 'Value max', type: 'number', default: 100 },
        { key: 'from', label: 'Angle at min', type: 'number', default: 0 },
        { key: 'to', label: 'Angle at max', type: 'number', default: 270 },
      ],
    },
    move: {
      dir: 'show', label: 'Move by value',
      params: [
        { key: 'min', label: 'Value min', type: 'number', default: 0 },
        { key: 'max', label: 'Value max', type: 'number', default: 100 },
        { key: 'dx', label: 'Move x at max', type: 'number', default: 100 },
        { key: 'dy', label: 'Move y at max', type: 'number', default: 0 },
      ],
    },
    toggle:    { dir: 'control', label: 'Toggle on click', params: [] },
    momentary: {
      dir: 'control', label: 'Momentary (hold)',
      params: [
        { key: 'on', label: 'Value while pressed', type: 'text', default: 'true' },
        { key: 'off', label: 'Value on release', type: 'text', default: 'false' },
        { key: 'repeatMs', label: 'Repeat while held (ms)', type: 'number', default: 0,
          hint: 'Hold-to-run: 200 re-sends the press every 200 ms, so the adapter can drop it if the repeats stop. 0 = off' },
      ],
    },
    set: { dir: 'control', label: 'Set value on click', params: [{ key: 'value', label: 'Value', type: 'text', default: 'true' }] },
  };

  function defaultsFor(action) {
    const out = {};
    for (const p of (ACTIONS[action] || { params: [] }).params) out[p.key] = JSON.parse(JSON.stringify(p.default));
    return out;
  }

  // betingelser (true, =3, >50, 10..20 ...) deles med kontrollenes "Enabled when"
  const { matchWhen } = H.helpers;

  // ---------------------------------------------------------------- lasting
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

  // Tolk, rens og klargjør en SVG for innebygd bruk. Tegningen er data, ikke kode.
  function build(text, opts = {}) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const src = doc.documentElement;
    if (!src || src.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) throw new Error('Not a valid SVG file');
    src.querySelectorAll('script').forEach(n => n.remove());
    for (const n of [src, ...src.querySelectorAll('*')]) {
      for (const a of [...n.attributes]) {
        const v = a.value.trim().toLowerCase();
        if (a.name.toLowerCase().startsWith('on')) n.removeAttribute(a.name);
        else if (/href$/i.test(a.name) && v.startsWith('javascript:')) n.removeAttribute(a.name);
      }
    }
    src.removeAttribute('content');   // draw.io sin innebygde redigerbare kopi — stor og ubrukt her
    const svg = document.importNode(src, true);
    if (!svg.getAttribute('viewBox')) {
      const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
      if (w && h) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.classList.add('hmi-svg');
    // adaptive farger (draw.io bruker light-dark()); mørk passer til HMI-en
    const theme = opts.theme || 'dark';
    svg.style.colorScheme = theme === 'light' ? 'light' : theme === 'auto' ? 'light dark' : 'dark';
    const panel = getComputedStyle(document.documentElement).getPropertyValue('--panel-2').trim() || '#262c34';
    svg.style.setProperty('--ge-dark-color', panel);   // draw.io sin mørke bakgrunn -> widgetens bakgrunn
    if (opts.background === 'none') {
      svg.style.background = 'transparent';
      const first = [...svg.children].find(c => c.localName === 'rect');
      if (first && first.getAttribute('width') === '100%' && first.getAttribute('height') === '100%') first.style.display = 'none';
    }
    return svg;
  }

  // ---------------------------------------------------------------- finne deler
  const idOf = n => (n && n.getAttribute && (n.getAttribute('data-cell-id') || n.getAttribute('id'))) || null;
  function find(svg, id) {
    if (!id) return null;
    const q = CSS.escape(id);
    return svg.querySelector(`[data-cell-id="${q}"]`) || svg.querySelector(`[id="${q}"]`);
  }
  // ID-er et tegneprogram har funnet på (tilfeldige draw.io-id-er, Inkscape rect123, rene tall)
  function isGenerated(id) {
    return /^\d+$/.test(id)
      || /^[A-Za-z0-9_-]{20}-\d+$/.test(id)
      || /^ge-svg-/.test(id)
      || /^(rect|path|g|ellipse|circle|text|tspan|layer|image|polygon|polyline|line|use|svg|defs|stop|clippath|mask|lineargradient|radialgradient|metadata|namedview|guide|flowroot|flowpara|pattern|marker|filter|symbol)[-_]?\d+(-\d+)*$/i.test(id);
  }
  const SKIP = new Set(['defs', 'style', 'title', 'desc', 'metadata', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'filter', 'marker', 'pattern', 'symbol', 'script']);
  function parts(svg) {
    const out = [], seen = new Set();
    for (const n of svg.querySelectorAll('[data-cell-id],[id]')) {
      if (n === svg || SKIP.has(n.localName.toLowerCase()) || n.closest('defs,foreignObject')) continue;
      const id = idOf(n);
      if (!id || seen.has(id) || id === '0' || id === '1') continue;
      seen.add(id);
      out.push({ id, el: n, generated: isGenerated(id) });
    }
    return out;
  }

  // Omsluttende boks for figurene i en del, uttrykt i `ref` sitt eget koordinatsystem.
  // Virker gjennom transformene tegneprogrammer legger på indre elementer.
  function bboxIn(target, ref) {
    const refCTM = ref.getCTM && ref.getCTM();
    if (!refCTM) return null;
    const inv = refCTM.inverse();
    const shapes = [...target.querySelectorAll(MEASURABLE)].filter(s => !s.closest('foreignObject'));
    if (target.matches && target.matches(MEASURABLE)) shapes.push(target);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of shapes) {
      let b, m;
      try { b = s.getBBox(); m = s.getCTM(); } catch { continue; }
      if (!m || (!b.width && !b.height)) continue;
      const t = inv.multiply(m);
      for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
        const p = new DOMPoint(x, y).matrixTransform(t);
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
  }

  // Skjermrektangel for de synlige figurene i en del (for utheving i editoren)
  function clientRect(target) {
    const shapes = [...target.querySelectorAll(PAINTABLE + ',text')].filter(s => !s.closest('foreignObject'));
    if (target.matches && target.matches(PAINTABLE + ',text')) shapes.push(target);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of shapes) {
      const r = s.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    if (!Number.isFinite(x0)) { const r = target.getBoundingClientRect(); return r.width || r.height ? r : null; }
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0, right: x1, bottom: y1 };
  }

  // ---------------------------------------------------------------- farging
  // Tegneprogrammer skriver ofte farger som inline-stiler, så vi overstyrer inline-
  // egenskaper på hver enkelt figur og husker originalene for å sette dem tilbake.
  const originals = new WeakMap();
  function original(s) {
    let o = originals.get(s);
    if (!o) {
      const cs = getComputedStyle(s);
      o = {
        fill: [s.style.getPropertyValue('fill'), s.style.getPropertyPriority('fill')],
        stroke: [s.style.getPropertyValue('stroke'), s.style.getPropertyPriority('stroke')],
        hasFill: cs.fill !== 'none' && cs.fill !== 'transparent' && cs.fill !== 'rgba(0, 0, 0, 0)',
        hasStroke: cs.stroke !== 'none' && cs.stroke !== 'transparent',
      };
      originals.set(s, o);
    }
    return o;
  }
  function paint(target, chosen) {
    const shapes = [...target.querySelectorAll(PAINTABLE)].filter(s => !s.closest('foreignObject'));
    if (target.matches && target.matches(PAINTABLE)) shapes.push(target);
    for (const s of shapes) {
      const o = original(s);
      for (const prop of ['fill', 'stroke']) {
        const [v, pri] = o[prop];
        if (v) s.style.setProperty(prop, v, pri); else s.style.removeProperty(prop);
        if (!chosen) continue;
        if (chosen.apply !== 'both' && chosen.apply !== prop) continue;
        if (prop === 'fill' ? o.hasFill : o.hasStroke) s.style.setProperty(prop, chosen.color);
      }
    }
  }

  // Elementet som holder tekstetiketten til en del, eller null hvis den ikke har noen
  function labelNode(target) {
    const t = target.querySelector('text');
    if (t) return t;
    const fo = target.querySelector('foreignObject');
    if (!fo) return null;
    const full = fo.textContent.trim();
    if (!full) return null;
    let n = fo;
    for (;;) {
      const own = [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
      const kids = [...n.children].filter(k => k.textContent.trim());
      if (!own && kids.length === 1 && kids[0].textContent.trim() === full) n = kids[0]; else break;
    }
    return n === fo ? null : n;
  }

  // ---------------------------------------------------------------- kjøretid
  function runtime(svg, bindings, ctx) {
    const values = new Map();
    const targets = new Map();          // id -> { el, rs: [] }
    const byTag = new Map();            // tag -> Set(id)
    const missing = [];
    const spinners = [];
    const run = ctx.mode() === 'run';
    let raf = 0, last = 0, dead = false;

    bindings.forEach(b => {
      const def = ACTIONS[b.action];
      if (!def) return;
      const node = find(svg, b.target);
      if (!node) { if (!missing.includes(b.target)) missing.push(b.target); return; }
      let t = targets.get(b.target);
      if (!t) targets.set(b.target, (t = { el: node, rs: [] }));
      const r = { b, el: node, angle: 0, active: false };
      t.rs.push(r);
      if (b.tag) {
        if (!byTag.has(b.tag)) byTag.set(b.tag, new Set());
        byTag.get(b.tag).add(b.target);
      }
      if (def.dir === 'control' && run) wireControl(r);
      if (b.action === 'spin') spinners.push(r);
    });

    function wireControl(r) {
      const { b, el: node } = r;
      node.classList.add('hmi-hot');
      if (b.action === 'toggle') {
        node.addEventListener('click', () => {
          const cur = ctx.value(b.tag);
          ctx.write(b.tag, !truthy(cur ? cur.value : false));
        });
      } else if (b.action === 'set') {
        node.addEventListener('click', () => ctx.write(b.tag, parseValue(String(b.value ?? 'true'))));
      } else if (b.action === 'momentary') {
        node.addEventListener('pointerdown', e => {
          e.preventDefault();
          if (r.stop) return;
          try { node.setPointerCapture(e.pointerId); } catch { /* ikke alle elementer støtter capture */ }
          r.stop = H.hold(
            () => ctx.write(b.tag, parseValue(String(b.on ?? 'true'))),
            () => { r.stop = null; ctx.write(b.tag, parseValue(String(b.off ?? 'false'))); },
            num(b.repeatMs, 0),
          );
        });
        const up = () => { if (r.stop) r.stop(); };
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
        node.addEventListener('lostpointercapture', up);
      }
    }

    function wrap(r) {
      if (r.wrap) return r.wrap;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'hmi-xf');
      r.el.parentNode.insertBefore(g, r.el);
      g.appendChild(r.el);
      r.wrap = g;
      return g;
    }
    function center(r) {
      if (!r.center) {
        const bb = bboxIn(r.el, wrap(r));
        if (bb && (bb.width || bb.height)) r.center = [bb.x + bb.width / 2, bb.y + bb.height / 2];
      }
      return r.center || [0, 0];
    }
    const rotateTo = (r, a) => { const [cx, cy] = center(r); wrap(r).setAttribute('transform', `rotate(${a.toFixed(2)} ${cx} ${cy})`); };
    const lerp = (v, b, a0, a1) => {
      const lo = num(b.min, 0), hi = num(b.max, 100);
      const f = Math.min(1, Math.max(0, (Number(v) - lo) / ((hi - lo) || 1)));
      return a0 + (a1 - a0) * f;
    };

    function setText(r, text) {
      if (!r.label) {
        r.label = labelNode(r.el);
        if (!r.label) {   // ingen etikett i tegningen: legg til en midt i delen
          const bb = bboxIn(r.el, r.el);
          const t = document.createElementNS(NS, 'text');
          t.setAttribute('class', 'hmi-svg-text');
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('dominant-baseline', 'central');
          t.setAttribute('x', bb ? bb.x + bb.width / 2 : 0);
          t.setAttribute('y', bb ? bb.y + bb.height / 2 : 0);
          r.el.appendChild(t);
          r.label = t;
        }
      }
      r.label.textContent = text;
    }

    function refresh(id) {
      const t = targets.get(id);
      if (!t) return;
      let chosen = null, visible = true, blink = false;
      for (const r of t.rs) {
        const b = r.b;
        if (!values.has(b.tag)) continue;
        const v = values.get(b.tag);
        switch (b.action) {
          case 'color': {
            const rule = (b.rules || []).find(x => matchWhen(x.when, v));
            if (rule && rule.color) chosen = { apply: b.apply || 'fill', color: rule.color };   // senere rader vinner
            break;
          }
          case 'visible': if (!matchWhen(b.when, v)) visible = false; break;
          case 'blink': if (matchWhen(b.when, v)) blink = true; break;
          case 'text': setText(r, String(b.template ?? '{value}').split('{value}').join(fmt(v, b.decimals ?? 0))); break;
          case 'spin': r.active = matchWhen(b.when, v); break;
          case 'rotate': rotateTo(r, lerp(v, b, num(b.from, 0), num(b.to, 270))); break;
          case 'move': {
            const f = lerp(v, b, 0, 1);
            wrap(r).setAttribute('transform', `translate(${(num(b.dx, 0) * f).toFixed(2)} ${(num(b.dy, 0) * f).toFixed(2)})`);
            break;
          }
          default: break;
        }
      }
      if (t.rs.some(r => r.b.action === 'color')) paint(t.el, chosen);
      t.el.style.visibility = visible ? '' : 'hidden';
      t.el.classList.toggle('hmi-blink', blink);
      if (spinners.some(r => r.active) && !raf) raf = requestAnimationFrame(tick);
    }

    function tick(ts) {
      raf = 0;
      if (dead) return;
      const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
      last = ts;
      let any = false;
      for (const r of spinners) {
        if (!r.active) continue;
        any = true;
        const s = num(r.b.seconds, 2) || 2;
        r.angle = (r.angle + 360 * dt / s) % 360;
        rotateTo(r, r.angle);
      }
      if (any) raf = requestAnimationFrame(tick); else last = 0;
    }

    return {
      missing,
      update(tag, value) {
        values.set(tag, value);
        const ids = byTag.get(tag);
        if (ids) for (const id of ids) refresh(id);
      },
      destroy() {
        dead = true;
        if (raf) cancelAnimationFrame(raf);
        for (const t of targets.values()) for (const r of t.rs) if (r.stop) r.stop();   // slipp alt som holdes
      },
    };
  }

  H.svg = { ACTIONS, defaultsFor, matchWhen, load, forget, build, find, parts, idOf, isGenerated, bboxIn, clientRect, runtime };

  // ---------------------------------------------------------------- widgeten
  H.register('svg', {
    name: 'Drawing', hint: 'SVG with mapped parts', size: [480, 420],
    props: [
      { key: 'label', label: 'Label', type: 'text', default: '' },
      { key: 'asset', label: 'Drawing', type: 'asset', default: '' },
      { key: 'theme', label: 'Colours', type: 'select', options: ['dark', 'light', 'auto'], default: 'dark', hint: 'For drawings with adaptive colours (draw.io). Auto follows the operating system.' },
      { key: 'background', label: 'Background', type: 'select', options: ['drawing', 'none'], default: 'drawing' },
      H.commonProps.labelSize(),
      { key: 'bindings', label: 'Mappings', type: 'bindings', default: [] },
    ],
    tags: w => [...new Set((w.props.bindings || []).map(b => b.tag).filter(Boolean))],
    mount(root, w, ctx) {
      const body = plate(root, w.props.label || null);
      body.classList.add('wsvg');
      const holder = el('div', 'svg-holder');
      body.append(holder);
      if (!w.props.asset) {
        holder.append(el('div', 'svg-note', ctx.mode() === 'edit' ? 'Choose or upload a drawing in the properties panel' : 'No drawing selected'));
        return {};
      }
      let rt = null, dead = false;
      const pending = new Map();
      load(w.props.asset).then(text => {
        if (dead) return;
        const svg = build(text, w.props);
        holder.append(svg);
        rt = runtime(svg, w.props.bindings || [], ctx);
        for (const [t, v] of pending) rt.update(t, v);
        pending.clear();
        if (rt.missing.length && ctx.mode() === 'edit') {
          const warn = el('div', 'svg-warn', `${rt.missing.length} mapped part${rt.missing.length > 1 ? 's' : ''} not in drawing: ${rt.missing.join(', ')}`);
          body.append(warn);
        }
      }).catch(e => {
        if (!dead) holder.append(el('div', 'svg-note err', e.message));
      });
      return {
        update(tag, value) { if (rt) rt.update(tag, value); else pending.set(tag, value); },
        destroy() { dead = true; if (rt) rt.destroy(); },
      };
    },
  });
})();
