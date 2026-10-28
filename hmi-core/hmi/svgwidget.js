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
 *
 * Med Time slider får tegningen en tidsstripe: markøren dras bakover i tid, og tegningen viser
 * verdiene slik de var der (timeStrip nedenfor). Betjeningen er av så lenge.
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
    let locked = false;                 // tegningen viser fortiden: betjeningen er av

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
          if (locked) return;
          const cur = ctx.value(b.tag);
          ctx.write(b.tag, !truthy(cur ? cur.value : false));
        });
      } else if (b.action === 'set') {
        node.addEventListener('click', () => { if (!locked) ctx.write(b.tag, parseValue(String(b.value ?? 'true'))); });
      } else if (b.action === 'momentary') {
        node.addEventListener('pointerdown', e => {
          e.preventDefault();
          if (r.stop || locked) return;
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
      let chosen = null, visible = true, blink = false, shows = false, known = false;
      for (const r of t.rs) {
        const b = r.b;
        if (ACTIONS[b.action].dir === 'show') { shows = true; if (values.has(b.tag)) known = true; }
        if (!values.has(b.tag)) {
          // ingen verdi: står stille, og i fortiden viser delen at verdien ikke er kjent
          if (b.action === 'spin') r.active = false;
          if (locked && b.action === 'text') setText(r, '—');
          if (locked && (b.action === 'rotate' || b.action === 'move') && r.wrap) r.wrap.removeAttribute('transform');
          continue;
        }
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
      t.el.classList.toggle('hmi-unknown', locked && shows && !known);   // fortiden: ingen verdi å vise
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
      // alle verdiene på en gang: de levende, eller (past) verdiene ved et tidspunkt i fortiden.
      // I fortiden er betjeningen av, og et trykk som holdes, slippes.
      show(map, past) {
        locked = !!past;
        svg.classList.toggle('hmi-past', locked);
        if (locked) for (const t of targets.values()) for (const r of t.rs) if (r.stop) r.stop();
        values.clear();
        for (const [k, v] of map) values.set(k, v);
        for (const id of targets.keys()) refresh(id);
      },
      hasControls: bindings.some(b => ACTIONS[b.action] && ACTIONS[b.action].dir === 'control'),
      destroy() {
        dead = true;
        if (raf) cancelAnimationFrame(raf);
        for (const t of targets.values()) for (const r of t.rs) if (r.stop) r.stop();   // slipp alt som holdes
      },
    };
  }

  H.svg = { ACTIONS, defaultsFor, matchWhen, load, forget, build, find, parts, idOf, isGenerated, bboxIn, clientRect, runtime };

  // ---------------------------------------------------------------- tidsstripen
  // En stripe under tegningen med en markør som dras bakover i tid: tegningen viser da verdiene
  // slik de var der, fra hubens historikk (og en database, hvis en er koblet til). Strekene i
  // stripen er endringer i taggene tegningen bruker; pilene hopper mellom dem. Markøren følger
  // tidsmarkøren i Timeline og de andre tidsstripene på skjermen (HMI.helpers.time.cursor).
  // onChange(values, t): verdiene ved tidspunktet t, eller (null, null) for live.
  const firstAfter = (list, t) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] <= t) lo = m + 1; else hi = m; } return lo; };
  const firstFrom = (list, t) => { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < t) lo = m + 1; else hi = m; } return lo; };
  function timeStrip(body, tags, ctx, p, onChange) {
    const { RANGES, TICKS, SPAN_MIN, SPAN_MAX, clockOf, dayOf, durText, stamp, clamp, pointAt, fetchRange } = H.helpers.time;
    const run = () => ctx.mode() === 'run';
    const box = el('div', 'svg-time');
    const cv = el('canvas');
    cv.tabIndex = 0;
    cv.title = 'Drag the marker back in time. Arrow keys: previous and next change. Mouse wheel: zoom';
    const row = el('div', 'trend-foot');
    const when = el('span', 'svg-when');
    const tools = el('div', 'trend-tools');
    row.append(when, tools);
    box.append(cv, row);
    body.append(box);

    const series = new Map(tags.map(t => [t, []]));
    let changes = [];     // tidspunktene der en av taggene endret seg, sortert
    let win = { live: true, span: clamp(num(p.window, 600) * 1000, SPAN_MIN, SPAN_MAX) };
    let cursor = null;    // null: live; ellers tidspunktet tegningen viser
    let past = false;     // tegningen viser fortiden nå
    let note = '';        // feil fra huben
    let flash = '', flashTimer = 0;   // en kort beskjed, f.eks. at det ikke finnes noen tidligere endring
    const range = () => (win.live ? { from: Date.now() - win.span, to: Date.now() } : { from: win.from, to: win.to });
    const span = () => (win.live ? win.span : win.to - win.from);
    // den delte tidsmarkøren (Run-modus): en annen flytter denne, og denne flytter de andre
    const linked = p.timeLink !== false && run();
    const follow = t => setCursor(t, true);
    const off = linked ? H.helpers.time.cursor.on(follow) : null;

    // ---- punktene: det stripen viser, og like mye på hver side (men ikke etter nå)
    let seq = 0, loadTimer = 0, reload = 0, loaded = null, edge = true;
    const covered = () => { if (!loaded) return false; const r = range(); return r.from >= loaded.from && (r.to <= loaded.to || edge); };
    async function load() {
      clearTimeout(loadTimer);
      const my = ++seq, r = range(), s = r.to - r.from, now = Date.now();
      const from = r.from - s, to = Math.min(now, r.to + s);
      const res = await fetchRange(ctx, tags, from, to, 4000);
      if (my !== seq) return;   // et nyere spørsmål er stilt siden
      for (const [tag, pts] of series) {
        const got = res.series[tag] || [];
        series.set(tag, to === now ? got.concat(pts.filter(x => x[0] > to)) : got);   // behold det som kom i mellomtiden
      }
      loaded = { from, to };
      edge = to === now;
      note = res.error ? 'History: ' + res.error : '';
      changes = changesIn(res.series, from);
      for (const pts of series.values()) for (const x of pts) if (x[0] > to) changes.push(x[0]);
      changes.sort((a, b) => a - b);
      apply();
    }
    const loadSoon = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 200); };
    // endringene i et svar; det første punktet er verdien som holdt seg fra før `from`
    function changesIn(set, from) {
      const out = [];
      for (const tag of tags) {
        const pts = set[tag] || [];
        for (let i = 0; i < pts.length; i++) if (i > 0 || pts[0][0] > from) out.push(pts[i][0]);
      }
      return out.sort((a, b) => a - b);
    }
    // taggenes verdier ved t. Av/på-tagger lagres som 1 og 0 i historikken, og blir true og false igjen
    function valuesAt(t) {
      const out = new Map(), known = ctx.registry ? ctx.registry() : null;
      for (const [tag, pts] of series) {
        const i = pointAt(pts, t);
        if (i < 0 || pts[i][1] === null) continue;
        const info = known && known.get(tag);
        out.set(tag, info && info.dataType === 'boolean' ? pts[i][1] !== 0 : pts[i][1]);
      }
      return out;
    }
    function apply() {
      if (cursor !== null) { past = true; onChange(valuesAt(cursor), cursor); }
      else if (past) { past = false; onChange(null, null); }
      syncRow();
      schedule();
    }

    // ---- markøren og tidsrommet. quiet: beskjeden kom fra den delte tidsmarkøren
    function setCursor(t, quiet) {
      const now = Date.now();
      flash = '';
      if (t === null || t >= now - 250) {
        cursor = null;
        win = { live: true, span: span() };
      } else {
        cursor = t;
        const r = range(), s = r.to - r.from;
        if (win.live) win = { live: false, from: r.from, to: r.to };   // stripen står stille mens du ser på fortiden
        if (t < r.from || t > r.to) { const from = Math.min(t - s / 2, now - s); win = { live: false, from, to: from + s }; }
      }
      if (!covered()) loadSoon();
      apply();
      if (!quiet && off) H.helpers.time.cursor.set(cursor, follow);
    }
    function setWindow(from, to) {
      const s = clamp(to - from, SPAN_MIN, SPAN_MAX), now = Date.now();
      if (from + s >= now) win = cursor === null ? { live: true, span: s } : { live: false, from: now - s, to: now };
      else win = { live: false, from, to: from + s };
      if (!covered()) loadSoon();
      syncRow();
      schedule();
    }
    // factor > 1 zoomer ut, rundt markøren (live: med nå i høyre kant)
    function zoom(anchor, factor) {
      const r = range(), s = r.to - r.from, ns = clamp(s * factor, SPAN_MIN, SPAN_MAX);
      if (ns === s) return;
      if (win.live) { win = { live: true, span: ns }; if (!covered()) loadSoon(); syncRow(); schedule(); return; }
      const from = anchor - (anchor - r.from) * ns / s;
      setWindow(from, from + ns);
    }
    // forrige eller neste endring. Finnes den ikke i det som er hentet, spørres huben om alt
    // fram til nå (eller 31 dager tilbake): minnet er lite, og en database tynner det ut
    let stepping = 0;
    async function step(dir) {
      const from = cursor === null ? Date.now() : cursor;
      if (dir > 0 && cursor === null) return;
      let i = dir < 0 ? firstFrom(changes, from) - 1 : firstAfter(changes, from);
      if (i >= 0 && i < changes.length) return setCursor(changes[i]);
      if (dir > 0 && edge) return setCursor(null);
      const my = ++stepping, now = Date.now();
      const q = dir < 0 ? [from - SPAN_MAX, from] : [from, now];
      const res = await fetchRange(ctx, tags, q[0], q[1], 4000);
      if (my !== stepping) return;
      const found = changesIn(res.series, q[0]).filter(t => (dir < 0 ? t < from : t > from));
      if (found.length) return setCursor(dir < 0 ? found[found.length - 1] : found[0]);
      if (dir > 0) return setCursor(null);
      flash = 'No earlier change';
      syncRow();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flash = ''; syncRow(); }, 3000);
    }

    // ---- knappene
    const btn = (text, title, fn) => { const x = el('button', null, text); x.type = 'button'; x.title = title; x.addEventListener('click', e => { e.stopPropagation(); fn(); }); return x; };
    const rangeBtns = RANGES.map(([t, sec]) => btn(t, `Show ${t} on the slider`, () => {
      const s = sec * 1000, now = Date.now();
      if (cursor === null) win = { live: true, span: s };
      else { const from = cursor >= now - s ? now - s : cursor - s / 2; win = { live: false, from, to: from + s }; }
      if (!covered()) loadSoon();
      syncRow();
      schedule();
    }));
    const prev = btn('|◀', 'Previous change (←)', () => step(-1));
    const next = btn('▶|', 'Next change (→)', () => step(1));
    const liveBtn = btn('Live', 'Back to now (End)', () => setCursor(null));
    tools.append(...rangeBtns, prev, next, liveBtn);
    function syncRow() {
      rangeBtns.forEach((x, i) => x.classList.toggle('on', Math.abs(span() - RANGES[i][1] * 1000) < 1));
      next.disabled = cursor === null;
      liveBtn.hidden = cursor === null;
      box.classList.toggle('past', cursor !== null);
      const t = cursor === null ? 'Live' : `${stamp(cursor)} · ${durText(Date.now() - cursor)} ago`;
      when.textContent = [t, note, flash].filter(Boolean).join(' · ');
      when.classList.toggle('warn', !!(note || flash));
    }

    // ---- pekeren: dra markøren; ved kanten flytter tidsrommet seg
    let L = { x0: 8, x1: 100 };
    const local = e => { const b = cv.getBoundingClientRect(), k = b.width / (cv.clientWidth || 1) || 1; return (e.clientX - b.left) / k; };
    const timeAt = x => { const r = range(); return r.from + clamp((x - L.x0) / (L.x1 - L.x0 || 1), 0, 1) * (r.to - r.from); };
    let drag = null, edgeTimer = 0;
    const atNow = () => range().to >= Date.now() - 1000;
    const scrub = x => { drag.x = x; setCursor(x >= L.x1 && atNow() ? null : timeAt(x)); };
    cv.addEventListener('pointerdown', e => {
      if (!run() || (e.pointerType === 'mouse' && e.button !== 0)) return;
      cv.setPointerCapture(e.pointerId);
      cv.focus({ preventScroll: true });
      drag = { x: local(e) };
      scrub(drag.x);
      clearInterval(edgeTimer);
      edgeTimer = setInterval(() => {
        if (!drag) return;
        const over = drag.x < L.x0 ? drag.x - L.x0 : drag.x > L.x1 ? drag.x - L.x1 : 0;
        if (!over || (over > 0 && atNow())) return;
        const r = range(), d = clamp(over / 40, -1, 1) * (r.to - r.from) * 0.04;
        setWindow(r.from + d, r.to + d);
        setCursor(over < 0 ? range().from : atNow() ? null : range().to);
      }, 50);
      e.preventDefault();
    });
    cv.addEventListener('pointermove', e => { if (drag) scrub(local(e)); });
    const release = () => { drag = null; clearInterval(edgeTimer); };
    cv.addEventListener('pointerup', release);
    cv.addEventListener('pointercancel', release);
    cv.addEventListener('wheel', e => {
      if (!run()) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1, dx = e.deltaX * k, dy = e.deltaY * k;
      if (!dx && !dy) return;
      const r = range();
      if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        const d = (Math.abs(dx) > Math.abs(dy) ? dx : dy) / (L.x1 - L.x0 || 1) * (r.to - r.from);
        return setWindow(r.from + d, r.to + d);
      }
      zoom(cursor !== null ? cursor : timeAt(local(e)), Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    cv.addEventListener('keydown', e => {
      if (!run()) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'End' || e.key === 'Escape') setCursor(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });

    // ---- tegningen av stripen
    let raf = 0;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    const timer = setInterval(() => { if (win.live) schedule(); if (cursor !== null) syncRow(); }, 1000);
    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, Hh = cv.clientHeight;
      if (!W || !Hh) return;
      if (cv.width !== W * dpr || cv.height !== Hh * dpr) { cv.width = W * dpr; cv.height = Hh * dpr; }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, Hh);
      const css = getComputedStyle(box);
      const col = (name, d) => css.getPropertyValue(name).trim() || d;
      const r = range(), ms = r.to - r.from;
      const x0 = 8, x1 = W - 8, ty = 4, th = 12;
      L = { x0, x1 };
      const X = t => x0 + (t - r.from) / (ms || 1) * (x1 - x0);
      g.fillStyle = col('--line-soft', '#2b323b');
      g.fillRect(x0, ty, x1 - x0, th);
      // endringene: én strek per piksel
      g.fillStyle = col('--ink-2', '#aab3be');
      let lastX = -1;
      for (let i = firstFrom(changes, r.from); i < changes.length && changes[i] <= r.to; i++) {
        const x = Math.round(X(changes[i]));
        if (x !== lastX) g.fillRect(x, ty + 2, 1, th - 4);
        lastX = x;
      }
      // tidsaksen
      g.font = `10px ${css.fontFamily || 'sans-serif'}`;
      const minGap = g.measureText(ms >= 86400000 * 2 ? '00.00 00:00' : '00:00:00').width + 14;
      const stepMs = TICKS.find(s => s / ms * (x1 - x0) >= minGap) || TICKS[TICKS.length - 1];
      const off = new Date(r.from).getTimezoneOffset() * 60000;
      g.fillStyle = col('--ink-3', '#6f7a87');
      g.textAlign = 'center';
      g.textBaseline = 'top';
      for (let t = Math.ceil((r.from - off) / stepMs) * stepMs + off; t <= r.to; t += stepMs) {
        const x = Math.round(X(t));
        g.fillRect(x, ty + th, 1, 3);
        const midnight = clockOf(t) === '00:00';
        const text = stepMs >= 86400000 ? dayOf(t) : midnight && ms > 3600000 ? dayOf(t) : clockOf(t, stepMs < 60000);
        const tw = g.measureText(text).width / 2;
        if (x - tw >= 0 && x + tw <= W) g.fillText(text, x, ty + th + 4);
      }
      // markøren: i fortiden en linje med et håndtak, live en prikk i høyre kant
      if (cursor === null) {
        g.fillStyle = col('--live', '#f2b441');
        g.beginPath(); g.arc(x1, ty + th / 2, 4, 0, Math.PI * 2); g.fill();
      } else if (cursor >= r.from && cursor <= r.to) {
        const x = Math.round(X(cursor)) + 0.5;
        g.strokeStyle = g.fillStyle = col('--past', '#b18cf0');
        g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ty + th + 2); g.stroke();
        g.beginPath(); g.arc(x, ty + th / 2, 5.5, 0, Math.PI * 2); g.fill();
      }
    }
    // en tidsmarkør fra før (f.eks. en annen fane på et kort): tegningen åpner der
    if (linked && H.helpers.time.cursor.get() !== null) setCursor(H.helpers.time.cursor.get(), true);
    const first = setTimeout(load);
    const ro = new ResizeObserver(() => schedule());
    ro.observe(cv);
    syncRow();
    return {
      // en ny verdi: med i stripen, så den er der når markøren dras over den
      update(tag, value, q, ts) {
        const pts = series.get(tag);
        if (!pts || !edge) return;
        const v = q === 'bad' || value == null ? null : typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : undefined;
        if (v === undefined) return;   // tekst: huben har ingen historikk for den
        const last = pts[pts.length - 1];
        if (last && last[1] === v) return;
        const t = ts || Date.now();
        if (last && t < last[0]) pts.splice(pointAt(pts, t) + 1, 0, [t, v]); else pts.push([t, v]);
        if (last) changes.splice(firstAfter(changes, t), 0, t);
        // fjern det som er langt utenfor, men behold verdien som holdes fra før
        if (win.live) {
          const cut = Date.now() - 3 * win.span;
          let i = 0;
          while (i + 1 < pts.length && pts[i + 1][0] < cut) i++;
          if (i) pts.splice(0, i);
          const k = firstFrom(changes, cut);
          if (k) changes.splice(0, k);
        }
        schedule();
      },
      // huben har fått eldre punkter tilbake (f.eks. fra PLS-ens ringbuffer): hent på nytt
      restored() { clearTimeout(reload); reload = setTimeout(load, 300); },
      destroy() { clearInterval(timer); clearInterval(edgeTimer); clearTimeout(flashTimer); clearTimeout(first); clearTimeout(loadTimer); clearTimeout(reload); cancelAnimationFrame(raf); ro.disconnect(); seq++; stepping++; if (off) off(); },
    };
  }

  // ---------------------------------------------------------------- widgeten
  H.register('svg', {
    name: 'Drawing', hint: 'SVG with mapped parts', size: [480, 420],
    props: [
      { key: 'label', label: 'Label', type: 'text', default: '' },
      { key: 'asset', label: 'Drawing', type: 'asset', default: '' },
      { key: 'theme', label: 'Colours', type: 'select', options: ['dark', 'light', 'auto'], default: 'dark', hint: 'For drawings with adaptive colours (draw.io). Auto follows the operating system.' },
      { key: 'background', label: 'Background', type: 'select', options: ['drawing', 'none'], default: 'drawing' },
      { key: 'timeTravel', label: 'Time slider', type: 'bool', default: false,
        hint: 'A bar under the drawing. In Run mode, drag its marker back in time and the drawing shows the values as they were then. Controls in the drawing are off meanwhile' },
      { key: 'window', label: 'Time slider range (seconds)', type: 'number', default: 600, showIf: p => !!p.timeTravel,
        hint: 'What the bar shows at first. The hub keeps the last 600 changes of each tag' },
      { key: 'timeLink', label: 'Follow the time marker', type: 'bool', default: true, showIf: p => !!p.timeTravel,
        hint: 'The slider moves together with the time marker in timelines and the time sliders of other drawings on the screen' },
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
      const live = new Map();   // de siste verdiene, også mens tegningen viser fortiden
      let past = null;          // verdiene ved markøren i tidsstripen, eller null for live
      let pastT = null;         // tidspunktet de er fra
      const tags = this.tags(w);
      const banner = el('div', 'svg-past');
      banner.hidden = true;
      body.append(banner);
      const sayPast = () => { if (past) banner.textContent = `History ${H.helpers.time.stamp(pastT)}${rt && rt.hasControls ? ' · controls are off' : ''}`; };
      const strip = w.props.timeTravel && tags.length ? timeStrip(body, tags, ctx, w.props, (values, t) => {
        past = values;
        pastT = t;
        body.classList.toggle('past', !!past);
        banner.hidden = !past;
        sayPast();
        if (rt) rt.show(past || live, !!past);
      }) : null;
      load(w.props.asset).then(text => {
        if (dead) return;
        const svg = build(text, w.props);
        holder.append(svg);
        rt = runtime(svg, w.props.bindings || [], ctx);
        rt.show(past || live, !!past);
        sayPast();
        if (rt.missing.length && ctx.mode() === 'edit') {
          const warn = el('div', 'svg-warn', `${rt.missing.length} mapped part${rt.missing.length > 1 ? 's' : ''} not in drawing: ${rt.missing.join(', ')}`);
          body.append(warn);
        }
      }).catch(e => {
        if (!dead) holder.append(el('div', 'svg-note err', e.message));
      });
      return {
        update(tag, value, q, ts) {
          live.set(tag, value);
          if (strip) strip.update(tag, value, q, ts);
          if (rt && !past) rt.update(tag, value);
        },
        restored() { if (strip) strip.restored(); },
        destroy() { dead = true; if (rt) rt.destroy(); if (strip) strip.destroy(); },
      };
    },
  });
})();
