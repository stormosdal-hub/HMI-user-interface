/*
 * Widgetbibliotek for HMI-en.
 *
 * Hver widgettype registreres med:
 *   name   : vises i paletten
 *   size   : [bredde, høyde] når den plasseres første gang
 *   props  : skjema for egenskapspanelet
 *            { key, label, type: text|number|tag|tags|select|bool, default, options?, hint? }
 *   tags(w, known): taggene widgeten vil ha oppdateringer for; known er tagoversikten fra huben
 *            (navn -> info). Med byPattern: true monteres widgeten på nytt når listen endres
 *   mount(root, w, ctx): bygg DOM-en inni root og returner et håndtak:
 *            { update(tag, value, quality, ts), event(ev), reset(), restored(series), destroy() }
 *            (alle valgfrie; restored: huben har fått eldre punkter tilbake for disse taggene)
 *
 * ctx gir widgetene: mode() -> 'edit'|'run', write(tag, value), value(tag),
 *                    history(tag) -> Promise<[[ts,value],...]>, events() -> siste hendelser,
 *                    registry() -> tagoversikten (navn -> { dataType, label, ... })
 *
 * Widgeter ser aldri "${var}"-plassholdere — appen løser dem opp før mount().
 * Ny widgettype: kopier en av blokkene nedenfor og registrer en ny nøkkel.
 */
(function () {
  'use strict';
  const H = (window.HMI = window.HMI || {});
  H.widgets = {};
  H.register = (type, def) => { H.widgets[type] = def; };

  // ---------------------------------------------------------------- hjelpere
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const num = (v, fallback) => { const n = Number(v); return v === '' || v == null || Number.isNaN(n) ? fallback : n; };
  const fmt = (v, d = 1) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(Math.max(0, Math.min(6, num(d, 1) | 0)));
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    return v == null || v === '' ? '—' : String(v);
  };
  // heltall i TIA-notasjon: 16#FF37, 2#1111_1111_0011_0111 (16 eller 32 bit brede)
  const fmtBase = (v, base) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fmt(v);
    const bits = Math.abs(v) > 0xFFFF || v < -0x8000 ? 32 : 16;
    const u = v < 0 ? (bits === 32 ? v >>> 0 : v & 0xFFFF) : Math.round(v);
    if (base === 16) return '16#' + u.toString(16).toUpperCase().padStart(bits / 4, '0');
    return '2#' + u.toString(2).padStart(bits, '0').replace(/(\d{4})(?=\d)/g, '$1_');
  };
  // "true"/"false"/tall blir ekte verdier; alt annet forblir en streng
  const parseValue = s => {
    if (typeof s !== 'string') return s;
    const t = s.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
    return t;
  };
  const truthy = v => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '' && v !== 'false' && v !== '0');
  const isOn = (v, onValue) => (onValue === '' || onValue == null) ? truthy(v) : String(v) === String(onValue);
  // betingelser på en verdi: true, false, =3, !=0, >50, <=10, 10..20, running (tekst), * eller tom (hva som helst)
  function matchWhen(when, v) {
    const w = String(when == null ? '' : when).trim();
    if (w === '' || w === '*') return true;
    if (w === 'true') return truthy(v);
    if (w === 'false') return !truthy(v);
    let m = w.match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/);
    if (m) { const n = Number(v); return typeof v !== 'boolean' && !Number.isNaN(n) && n >= +m[1] && n <= +m[2]; }
    m = w.match(/^(>=|<=|!=|>|<|=)\s*(.*)$/);
    if (m) {
      const op = m[1], rhs = m[2].trim();
      const a = Number(v), b = Number(rhs);
      const numeric = rhs !== '' && !Number.isNaN(b) && typeof v !== 'boolean' && v !== '' && v != null && !Number.isNaN(a);
      switch (op) {
        case '=':  return numeric ? a === b : String(v) === rhs;
        case '!=': return numeric ? a !== b : String(v) !== rhs;
        case '>':  return numeric && a > b;
        case '<':  return numeric && a < b;
        case '>=': return numeric && a >= b;
        case '<=': return numeric && a <= b;
      }
    }
    return String(v) === w;
  }
  const outOfRange = (v, p) => typeof v === 'number' && ((p.warnAbove !== '' && p.warnAbove != null && v > Number(p.warnAbove)) || (p.warnBelow !== '' && p.warnBelow != null && v < Number(p.warnBelow)));
  const plate = (root, label) => {
    if (label) root.appendChild(el('div', 'plate', label));
    const body = el('div', 'wbody');
    root.appendChild(body);
    return body;
  };
  const hhmmss = ts => new Date(ts).toTimeString().slice(0, 8);
  // En visning som er for bred for widgeten krymper til den får plass, så widgeten aldri kutter
  // sifre av en verdi: "16#EB3" for 16#EB31 leses som et annet tall. Bare bredden: den endres med
  // verdien under kjøring, mens en visning som er for høy allerede synes under redigering.
  // `line` holder visningen og enheten, `box` er plassen de har. changed() etter at teksten
  // endres; når widgeten endrer størrelse, tilpasses den igjen av seg selv.
  function fitReadout(readout, line, box) {
    let key = '';
    const fit = () => {
      readout.style.fontSize = '';
      const cs = getComputedStyle(box);
      const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const rw = readout.scrollWidth;
      if (!rw || room <= 0) return;
      const k = (room - (line.scrollWidth - rw)) / rw;
      if (k < 1) readout.style.fontSize = Math.max(8, parseFloat(getComputedStyle(readout).fontSize) * k * 0.97) + 'px';
    };
    const ro = new ResizeObserver(() => fit());
    ro.observe(box);
    return {
      // måling koster en layout, så bare når teksten ble lengre eller kortere, eller fikk ny stil
      changed() { const k = readout.textContent.length + readout.className; if (k !== key) { key = k; fit(); } },
      stop() { ro.disconnect(); },
    };
  }
  // en tekststørrelse (prosent av normal) som faktor: 150 -> 1.5
  const sizeScale = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(600, Math.max(25, n)) / 100 : 1; };

  H.helpers = { el, num, fmt, parseValue, truthy, isOn, matchWhen, plate, sizeScale };

  // ---------------------------------------------------------------- hold-for-å-kjøre (hold-to-run)
  // Hvert trykk som holdes inne registreres her. Mister siden fokus, skjules fanen eller forlates
  // siden, slippes alle, i stedet for at en maskin fortsetter å gå på et trykk som ingen
  // holder lenger.
  //   H.hold(press, release, repeatMs) -> stop()   eller null hvis første trykk feilet
  //   press()   sender trykkverdien, returnerer false hvis den ikke kunne sendes
  //   repeatMs  > 0: send trykket på nytt så ofte mens det holdes, så adapteren kan droppe
  //             kommandoen hvis gjentakelsene uteblir (se "hold" i layouten til binary-adapteren)
  const holds = new Set();
  const releaseAll = () => { for (const stop of [...holds]) stop(); };
  window.addEventListener('blur', releaseAll);
  window.addEventListener('pagehide', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  H.hold = function (press, release, repeatMs) {
    if (press() === false) return null;
    let timer = 0;
    const stop = () => {
      if (!holds.has(stop)) return;
      holds.delete(stop);
      clearInterval(timer);
      release();
    };
    holds.add(stop);
    if (repeatMs > 0) timer = setInterval(() => { if (press() === false) stop(); }, repeatMs);
    return stop;
  };
  H.releaseAllHolds = releaseAll;

  // ---------------------------------------------------------------- tryggere betjening
  // Felles for Button, Switch, Slider og Number input.
  //   Enabled when: en tag og en betingelse. Mens den ikke holder, eller taggen er foreldet eller
  //     mangler verdi, er kontrollen grået ut og kan ikke brukes, og et trykk som holdes slippes.
  //   Ask before sending: et spørsmål å svare på først, for kommandoer som starter/nullstiller noe.
  const safetyProps = confirmHint => [
    { key: 'enableTag', label: 'Enabled when tag', type: 'tag', default: '',
      hint: 'Leave empty for always. While the condition below doesn’t hold, or this tag is stale, the control is greyed out' },
    { key: 'enableWhen', label: 'Condition', type: 'text', default: 'true', showIf: p => !!p.enableTag,
      hint: 'true, false, =3, !=0, >50, 10..20. For several conditions, make a boolean calculation (such as calc.jog_allowed) and use it as the tag' },
    { key: 'confirm', label: 'Ask before sending', type: 'text', default: '', hint: confirmHint },
  ];
  // onChange(enabled) får beskjed hver gang den endres
  function guard(root, w, ctx, onChange) {
    const p = w.props;
    let enabled = !p.enableTag;
    root.classList.add('control');
    const set = on => {
      enabled = on;
      root.classList.toggle('disabled', !on);
      root.title = on ? '' : `Not enabled: ${p.enableTag} is not ${p.enableWhen || 'true'}`;
      for (const c of root.querySelectorAll('.wbody button, .wbody input')) c.disabled = !on;
      if (onChange) onChange(on);
    };
    return {
      start() { set(enabled); },
      enabled: () => enabled,
      update(tag, v, q) { if (p.enableTag && tag === p.enableTag) set(q !== 'bad' && v !== undefined && matchWhen(p.enableWhen || 'true', v)); },
      // gir true for å gå videre: med en gang når det ikke er satt noe spørsmål
      ask(message, ok) {
        if (!p.confirm) return Promise.resolve(true);
        return ctx.confirm({ title: p.label || p.text || 'Confirm', message, ok });
      },
    };
  }
  const tagsOf = w => [w.props.tag, w.props.enableTag];
  H.helpers.guard = guard;

  const P = {
    label: (d = 'Label') => ({ key: 'label', label: 'Label', type: 'text', default: d }),
    tag: () => ({ key: 'tag', label: 'Tag', type: 'tag', default: '' }),
    unit: () => ({ key: 'unit', label: 'Unit', type: 'text', default: '' }),
    decimals: (d = 1) => ({ key: 'decimals', label: 'Decimals', type: 'number', default: d }),
    // tom = temafargen; `fallback` er det fargevelgeren da viser
    color: (label = 'Colour', fallback = '#f2b441') => ({ key: 'color', label, type: 'color', default: '', fallback }),
    // tekststørrelser i prosent av normal; appen gjør dem om til --fs-label og --fs-text på widgeten
    labelSize: (label = 'Label size', hint) => ({ key: 'labelSize', label, type: 'size', default: 100, hint }),
    textSize: (label = 'Value size', hint) => ({ key: 'textSize', label, type: 'size', default: 100, hint }),
    safety: safetyProps,   // Enabled when + Ask before sending: spres inn i props, med guard() i mount
  };
  H.commonProps = P;

  // ---------------------------------------------------------------- kort
  // En beholder. Andre widgeter kan slippes på det, og det kan ha faner. Kortet tegner bare
  // rammen sin; appen monterer widgetene i den aktive fanen inn i `body`.
  // Widgeter på et kort har `parent` (kortets id) og `tab`, med x/y relativt til body.
  H.register('card', {
    name: 'Card', hint: 'Holds widgets, with tabs', size: [440, 300], container: true,
    props: [
      { key: 'title', label: 'Title', type: 'text', default: 'Card', hint: 'Leave empty and use one tab for a plain frame' },
      { key: 'tabs', label: 'Tabs', type: 'tabs', default: [{ id: 'tab1', name: 'Overview' }] },
      P.color('Tab colour'),
      P.labelSize('Title size', 'The title and the tabs'),
    ],
    tags: () => [],
    mount(root, w, ctx) {
      root.classList.add('card');
      const tabs = Array.isArray(w.props.tabs) && w.props.tabs.length ? w.props.tabs : [{ id: 'tab1', name: 'Tab 1' }];
      const active = ctx.cardTab(w.id, tabs);
      const title = String(w.props.title || '').trim();
      if (title || tabs.length > 1) {
        const head = el('div', 'card-head');
        if (title) head.append(el('span', 'card-title', title));
        if (tabs.length > 1) {
          const bar = el('div', 'card-tabs');
          bar.setAttribute('role', 'tablist');
          for (const t of tabs) {
            const b = el('button', t.id === active ? 'on' : '', t.name || 'Tab');
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', String(t.id === active));
            b.addEventListener('pointerdown', e => e.stopPropagation());   // et klikk på en fane er ikke et drag
            b.addEventListener('click', e => { e.stopPropagation(); ctx.setCardTab(w.id, t.id); });
            bar.append(b);
          }
          head.append(bar);
        }
        root.append(head);
      }
      const body = el('div', 'card-body');
      root.append(body);
      return { body, activeTab: active };
    },
  });

  // ---------------------------------------------------------------- tekst
  H.register('text', {
    name: 'Text', hint: 'Static heading or note', size: [240, 44],
    props: [
      { key: 'text', label: 'Text', type: 'text', default: 'Heading' },
      { key: 'size', label: 'Size', type: 'select', options: ['small', 'medium', 'large', 'x-large', 'xx-large'], default: 'medium' },
      { key: 'align', label: 'Align', type: 'select', options: ['left', 'center', 'right'], default: 'left' },
      P.color('Text colour', '#e7eaee'),
    ],
    tags: () => [],
    mount(root, w) {
      const b = plate(root, null);
      b.classList.add('wtext', 'size-' + (w.props.size || 'medium'));
      b.style.justifyContent = { center: 'center', right: 'flex-end' }[w.props.align] || 'flex-start';
      b.textContent = w.props.text;
      return {};
    },
  });

  // ---------------------------------------------------------------- verdi
  H.register('value', {
    name: 'Value', hint: 'Numeric or text readout', size: [200, 104],
    props: [
      P.label('Value'), P.tag(), P.unit(), P.decimals(1),
      { key: 'format', label: 'Number format', type: 'select', options: ['decimal', 'hex', 'binary'], default: 'decimal', hint: 'Hex and binary suit status and control words (16#FF37, 2#1111_...)' },
      { key: 'codeList', label: 'Code texts', type: 'codelist', default: '',
        hint: 'For fault and alarm codes: shows the text for each code. In Run mode, click the value to read the description, or add one' },
      { key: 'codeShow', label: 'Show', type: 'select', options: ['number and text', 'text only', 'number only'], default: 'number and text',
        hint: 'Text only still shows the number for a code that has no text yet', showIf: p => !!p.codeList },
      P.color('Value colour'),
      P.labelSize(), P.textSize('Value size', 'The number, its unit and the code text'),
      { key: 'warnAbove', label: 'Alarm above', type: 'number', default: '' },
      { key: 'warnBelow', label: 'Alarm below', type: 'number', default: '' },
    ],
    tags: w => [w.props.tag],
    mount(root, w, ctx) {
      const p = w.props;
      const b = plate(root, p.label);
      b.classList.add('wvalue');
      const r = el('div', 'readout', '—');
      // tall og enhet deler grunnlinje, og paret er sentrert uansett høyde på widgeten
      const line = el('div', 'valline');
      line.append(r);
      if (p.unit) line.append(el('span', 'unit', p.unit));
      b.append(line);
      const fitter = fitReadout(r, line, b);
      const number = v => (p.format === 'hex' ? fmtBase(v, 16) : p.format === 'binary' ? fmtBase(v, 2) : fmt(v, p.decimals));

      // kodetekster: teksten under tallet, og et klikk i Run-modus viser beskrivelsen
      let codeLine = null, last;
      if (p.codeList) {
        root.classList.add('has-codes');
        codeLine = el('div', 'codetext');
        b.append(codeLine);
        const mark = el('span', 'code-mark', 'i');
        mark.title = 'Click in Run mode for the description of the code';
        const pl = root.querySelector(':scope > .plate');
        (pl || b).append(mark);
        const open = () => { if (ctx.mode() === 'run') ctx.openCode(p.codeList, last, { title: p.label, shown: last == null ? '' : number(last) }); };
        if (ctx.mode() === 'run') {
          b.tabIndex = 0;
          b.setAttribute('role', 'button');
          b.setAttribute('aria-label', `${p.label || 'Value'}: show the description of the code`);
        }
        b.addEventListener('click', open);
        b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      }
      return {
        update(_t, v) {
          last = v;
          let shown = number(v), asText = typeof v === 'string' || p.format === 'binary';
          if (codeLine) {
            const c = v == null ? null : ctx.code(p.codeList, v);
            const txt = c ? c.short : '';
            let under = '';
            if (!c) under = v == null ? '' : 'Code list missing';
            else if (!txt) under = p.codeShow === 'number only' ? '' : 'No text yet';
            else if (p.codeShow === 'text only') { shown = txt; asText = true; }
            else if (p.codeShow !== 'number only') under = txt;
            codeLine.textContent = under;
            codeLine.classList.toggle('unknown', !txt);
            codeLine.title = txt || '';
          }
          r.textContent = shown;
          r.classList.toggle('text', asText);
          r.classList.toggle('alarm', outOfRange(v, p));
          fitter.changed();
        },
        destroy: fitter.stop,
      };
    },
  });

  // ---------------------------------------------------------------- viserinstrument (gauge)
  // Vinkler er grader med klokka fra kl. 12. Hver stil er bare geometri.
  const GAUGE_STYLES = {
    arc:        { a0: -135, a1: 135, vb: [100, 88],  cy: 50, r: 40, place: 'bottom' },
    semicircle: { a0: -90,  a1: 90,  vb: [100, 56],  cy: 52, r: 42, place: 'bottom' },
    ring:       { a0: -180, a1: 180, vb: [100, 100], cy: 50, r: 40, place: 'center' },
    needle:     { a0: -135, a1: 135, vb: [100, 88],  cy: 50, r: 40, place: 'bottom', needle: true },
  };
  const WIDTHS = { thin: 4, normal: 9, thick: 14 };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, cls) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute('class', cls);
    return e;
  };
  const polar = (cx, cy, r, a) => { const t = a * Math.PI / 180; return [cx + r * Math.sin(t), cy - r * Math.cos(t)]; };
  function arcD(cx, cy, r, a0, a1) {
    if (a1 - a0 >= 360) a1 = a0 + 359.99;
    const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  const hasNum = v => v !== '' && v != null && !Number.isNaN(Number(v));
  // andel av området, og alarmsonene [fra, til] som andeler
  const scaleOf = p => {
    const lo = num(p.min, 0), hi = num(p.max, 100);
    const frac = v => Math.min(1, Math.max(0, (Number(v) - lo) / ((hi - lo) || 1)));
    const zones = [];
    if (hasNum(p.warnBelow) && Number(p.warnBelow) > lo) zones.push([0, frac(p.warnBelow)]);
    if (hasNum(p.warnAbove) && Number(p.warnAbove) < hi) zones.push([frac(p.warnAbove), 1]);
    return { lo, hi, frac, zones };
  };
  const rangeText = p => `${fmt(num(p.min, 0), 0)} \u2013 ${fmt(num(p.max, 100), 0)}${p.unit ? ' ' + p.unit : ''}`;

  // ---- terskler og skalaer, felles for viserinstrumentet og stolpen
  // terskler: [{ value, color }]. På eller over en terskel får verdien terskelens farge; under
  // den første beholder den widgetens egen farge.
  const thresholdsOf = p => (Array.isArray(p.thresholds) ? p.thresholds : [])
    .filter(t => t && hasNum(t.value) && /^#[0-9a-f]{3,8}$/i.test(t.color || ''))
    .map(t => ({ value: Number(t.value), color: t.color }))
    .sort((a, b) => a.value - b.value);
  const colorFor = (ths, v) => { let c = ''; if (typeof v === 'number') for (const t of ths) if (v >= t.value) c = t.color; return c; };
  // tall for skalaen: lo, lo + steg, ... hi
  const divisionsOf = p => Math.max(1, Math.min(20, Math.round(num(p.divisions, 5))));
  const scaleNumber = v => { const r = Math.round(v * 100) / 100; return String(Object.is(r, -0) ? 0 : r); };
  // gauge: skalainnstillingene finnes bare for needle-stilen; bar: inndelinger bare med tall
  const scaleProps = (kind) => [
    { key: 'thresholds', label: 'Colour thresholds', type: 'thresholds', default: [],
      hint: 'At or above a threshold the value takes its colour. Below the first one it keeps the colour set above' },
    { key: 'scaleNumbers', label: 'Scale numbers', type: 'bool', default: false,
      hint: kind === 'gauge' ? 'Numbers inside the dial' : 'Numbered ticks along the bar',
      showIf: kind === 'gauge' ? p => p.style === 'needle' : null },
    { key: 'divisions', label: 'Scale divisions', type: 'number', default: 5,
      hint: kind === 'gauge' ? 'Numbered steps from min to max; also sets the tick marks' : 'Numbered steps from min to max',
      showIf: kind === 'gauge' ? p => p.style === 'needle' : p => !!p.scaleNumbers },
    { key: 'warnAbove', label: 'Alarm above', type: 'number', default: '', hint: 'Alarm limits are drawn as red zones on the scale' },
    { key: 'warnBelow', label: 'Alarm below', type: 'number', default: '' },
    { key: 'alarmBlink', label: 'Blink while in alarm', type: 'bool', default: true },
  ];

  H.register('gauge', {
    name: 'Gauge', hint: 'Arc, half circle, needle or ring', size: [200, 170],
    props: [
      P.label('Gauge'), P.tag(), P.unit(),
      { key: 'min', label: 'Min', type: 'number', default: 0 },
      { key: 'max', label: 'Max', type: 'number', default: 100 },
      P.decimals(1),
      { key: 'style', label: 'Style', type: 'select', options: ['arc', 'semicircle', 'needle', 'ring'], default: 'arc' },
      { key: 'thickness', label: 'Thickness', type: 'select', options: ['thin', 'normal', 'thick'], default: 'normal' },
      P.color('Colour'),
      P.labelSize(), P.textSize('Value size', 'The readout and the range. The dial itself grows with the widget'),
      ...scaleProps('gauge'),
    ],
    tags: w => [w.props.tag],
    mount(root, w) {
      const p = w.props;
      const st = GAUGE_STYLES[p.style] || GAUGE_STYLES.arc;
      const numbers = !!(st.needle && p.scaleNumbers);
      const b = plate(root, p.label);
      b.style.padding = '4px';
      const cx = 50, cy = st.cy, r = st.r;
      const sw = st.needle ? Math.min(WIDTHS[p.thickness] || 9, 4) : (WIDTHS[p.thickness] || 9);
      const sc = scaleOf(p), ths = thresholdsOf(p), n = divisionsOf(p);
      const ang = f => st.a0 + (st.a1 - st.a0) * f;
      // med tall får skiven plass under seg til visningen
      const vbh = numbers ? 100 : st.vb[1];
      const svg = svgEl('svg', { viewBox: `0 0 ${st.vb[0]} ${vbh}`, preserveAspectRatio: 'xMidYMid meet' }, 'gauge style-' + (p.style || 'arc'));
      const full = arcD(cx, cy, r, st.a0, st.a1);
      svg.append(svgEl('path', { d: full, 'stroke-width': sw }, 'track'));
      const inRange = t => t.value > sc.lo && t.value < sc.hi;
      if (st.needle) {
        // viserskiver viser området til hver terskel som et farget bånd på sporet
        ths.forEach((t, i) => {
          const f0 = sc.frac(t.value), f1 = i + 1 < ths.length ? sc.frac(ths[i + 1].value) : 1;
          if (f1 > f0) svg.append(svgEl('path', { d: arcD(cx, cy, r, ang(f0), ang(f1)), 'stroke-width': sw, stroke: t.color }, 'band'));
        });
      }
      const zr = st.needle ? r : r - sw / 2 - 2.2, zw = st.needle ? sw : 2.6;
      for (const [f0, f1] of sc.zones) svg.append(svgEl('path', { d: arcD(cx, cy, zr, ang(f0), ang(f1)), 'stroke-width': zw }, 'zone'));
      let fill = null, needle = null;
      if (st.needle) {
        // store streker ved hver inndeling, en liten strek halvveis
        for (let i = 0; i <= n * 2; i++) {
          const a = ang(i / (n * 2)), major = i % 2 === 0;
          const [x0, y0] = polar(cx, cy, r - sw / 2 - 1, a), [x1, y1] = polar(cx, cy, r - sw / 2 - (major ? 7 : 4), a);
          svg.append(svgEl('line', { x1: x0, y1: y0, x2: x1, y2: y1 }, major ? 'tick major' : 'tick'));
          if (numbers && major) {
            const [tx, ty] = polar(cx, cy, r - sw / 2 - 12.5, a);
            const t = svgEl('text', { x: tx.toFixed(2), y: ty.toFixed(2), 'text-anchor': 'middle', 'dominant-baseline': 'central' }, 'scale-num');
            t.textContent = scaleNumber(sc.lo + (sc.hi - sc.lo) * (i / 2) / n);
            svg.append(t);
          }
        }
        needle = svgEl('g', {}, 'needle');
        needle.append(svgEl('line', { x1: cx, y1: cy + 5, x2: cx, y2: cy - r + 7 }), svgEl('circle', { cx, cy, r: 3.2 }));
        needle.style.transformOrigin = `${cx}px ${cy}px`;
        needle.style.transform = `rotate(${st.a0}deg)`;
        svg.append(needle);
      } else {
        fill = svgEl('path', { d: full, 'stroke-width': sw, pathLength: 100 }, 'fill');
        fill.style.strokeDasharray = '0 100';
        svg.append(fill);
        // et kort merke på tvers av sporet der hver terskel begynner
        for (const t of ths.filter(inRange)) {
          const a = ang(sc.frac(t.value));
          const [x0, y0] = polar(cx, cy, r - sw / 2 - 1.5, a), [x1, y1] = polar(cx, cy, r + sw / 2 + 1.5, a);
          svg.append(svgEl('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: t.color }, 'thmark'));
        }
      }
      b.append(svg);
      const overlay = el('div', 'gauge-overlay place-' + st.place + ' style-' + (p.style || 'arc') + (numbers ? ' numbers' : ''));
      const readout = el('div', 'readout', '\u2014');
      overlay.append(readout);
      if (!numbers) overlay.append(el('div', 'range', rangeText(p)));   // tallene viser allerede området
      b.append(overlay);
      const fitter = fitReadout(readout, readout, overlay);
      return {
        destroy: fitter.stop,
        update(_t, v) {
          const f = typeof v === 'number' ? sc.frac(v) : 0;
          if (fill) fill.style.strokeDasharray = `${(f * 100).toFixed(2)} 100`;
          if (needle) needle.style.transform = `rotate(${ang(f).toFixed(2)}deg)`;
          readout.textContent = fmt(v, p.decimals) + (p.unit ? ' ' + p.unit : '');
          const alarm = outOfRange(v, p);
          const c = alarm ? '' : colorFor(ths, v);    // i alarm vinner den røde fra CSS
          if (fill) fill.style.stroke = c;
          if (needle) needle.style.setProperty('--needle', c || null);
          readout.style.color = c;
          svg.classList.toggle('alarm', alarm);
          svg.classList.toggle('blink', alarm && p.alarmBlink !== false);
          readout.classList.toggle('alarm', alarm);
          fitter.changed();
        },
      };
    },
  });

  // ---------------------------------------------------------------- stolpe (bar)
  H.register('bar', {
    name: 'Bar', hint: 'Straight bar, horizontal or vertical', size: [260, 110],
    props: [
      P.label('Bar'), P.tag(), P.unit(),
      { key: 'min', label: 'Min', type: 'number', default: 0 },
      { key: 'max', label: 'Max', type: 'number', default: 100 },
      P.decimals(1),
      { key: 'orientation', label: 'Orientation', type: 'select', options: ['horizontal', 'vertical'], default: 'horizontal', hint: 'Vertical bars fill from the bottom' },
      { key: 'origin', label: 'Fill from', type: 'select', options: ['min', 'zero'], default: 'min', hint: 'Zero suits signed values like torque or current: the bar grows either way from 0' },
      P.color('Colour'),
      P.labelSize(), P.textSize('Value size', 'The readout, the unit and the scale numbers'),
      ...scaleProps('bar'),
    ],
    tags: w => [w.props.tag],
    mount(root, w) {
      const p = w.props;
      const vertical = p.orientation === 'vertical';
      const b = plate(root, p.label);
      b.classList.add('wbar', vertical ? 'vertical' : 'horizontal');
      if (p.scaleNumbers) b.classList.add('numbers');
      const sc = scaleOf(p), ths = thresholdsOf(p), n = divisionsOf(p);
      const zeroF = p.origin === 'zero' ? sc.frac(0) : 0;
      const place = (node, f0, f1) => {
        const a = Math.min(f0, f1) * 100, s = Math.abs(f1 - f0) * 100;
        if (vertical) { node.style.bottom = a + '%'; node.style.height = s + '%'; }
        else { node.style.left = a + '%'; node.style.width = s + '%'; }
      };
      const track = el('div', 'bar-track');
      const lane = el('div', 'bar-lane');     // spor + alarmstripe ved siden av
      lane.append(track);
      if (sc.zones.length) {
        const strip = el('div', 'bar-strip');
        for (const [f0, f1] of sc.zones) { const z = el('div', 'bar-zone'); place(z, f0, f1); strip.append(z); }
        lane.append(strip);
      }
      if (p.origin === 'zero' && zeroF > 0 && zeroF < 1) { const z = el('div', 'bar-zero'); place(z, zeroF, zeroF); track.append(z); }
      const fill = el('div', 'bar-fill');
      place(fill, zeroF, zeroF);
      track.append(fill);
      // en tynn strek på tvers av sporet der hver terskel begynner
      for (const t of ths) {
        if (!(t.value > sc.lo && t.value < sc.hi)) continue;
        const m = el('div', 'bar-mark');
        m.style.background = t.color;
        m.style[vertical ? 'bottom' : 'left'] = (sc.frac(t.value) * 100) + '%';
        track.append(m);
      }
      const read = el('div', 'bar-read');
      const readout = el('span', 'readout', '\u2014');
      read.append(readout);
      if (p.unit) read.append(el('span', 'unit', p.unit));
      // skalaen: nummererte streker ved hver inndeling, eller bare min og max
      const scale = el('div', 'bar-scale' + (p.scaleNumbers ? ' ticks' : ''));
      if (p.scaleNumbers) {
        for (let i = 0; i <= n; i++) {
          const pos = (i / n) * 100;
          const tick = el('span', 'bar-tick'), label = el('span', 'bar-num', scaleNumber(sc.lo + (sc.hi - sc.lo) * i / n));
          tick.style[vertical ? 'bottom' : 'left'] = pos + '%';
          label.style[vertical ? 'bottom' : 'left'] = pos + '%';
          if (i === 0) label.classList.add('first');
          if (i === n) label.classList.add('last');
          scale.append(tick, label);
        }
      } else {
        scale.append(el('span', null, fmt(sc.lo, 0)), el('span', null, fmt(sc.hi, 0)));
      }
      if (vertical && p.scaleNumbers) {
        const row = el('div', 'bar-row');
        row.append(lane, scale);
        b.append(read, row);
      } else if (vertical) {
        const side = el('div', 'bar-side');
        const [lo, hi] = scale.children;
        side.append(hi, read, lo);
        b.append(lane, side);
      } else {
        b.append(read, lane, scale);
      }
      return {
        update(_t, v) {
          const f = typeof v === 'number' ? sc.frac(v) : zeroF;
          place(fill, zeroF, f);
          readout.textContent = fmt(v, p.decimals);
          const alarm = outOfRange(v, p);
          const c = alarm ? '' : colorFor(ths, v);
          fill.style.background = c;
          readout.style.color = c;
          fill.classList.toggle('alarm', alarm);
          fill.classList.toggle('blink', alarm && p.alarmBlink !== false);
          readout.classList.toggle('alarm', alarm);
        },
      };
    },
  });

  // ---------------------------------------------------------------- lampe (led)
  H.register('led', {
    name: 'Indicator', hint: 'On/off lamp', size: [160, 76],
    props: [
      P.label('Indicator'), P.tag(),
      { key: 'onValue', label: 'On when value equals', type: 'text', default: '', hint: 'Leave empty for any true / non-zero value' },
      P.color('Lit colour', '#43c483'),
      { key: 'onText', label: 'On text', type: 'text', default: 'On' },
      { key: 'offText', label: 'Off text', type: 'text', default: 'Off' },
      P.labelSize(), P.textSize('Lamp and text size'),
    ],
    tags: w => [w.props.tag],
    mount(root, w) {
      const b = plate(root, w.props.label);
      const dot = el('div', 'led');
      const cap = el('span', 'led-cap', w.props.offText);
      b.append(dot, cap);
      return {
        update(_t, v) {
          const on = isOn(v, w.props.onValue);
          dot.classList.toggle('on', on);
          cap.textContent = on ? w.props.onText : w.props.offText;
        },
      };
    },
  });

  // ---------------------------------------------------------------- bryter
  H.register('switch', {
    name: 'Switch', hint: 'Toggle, writes true/false', size: [160, 76],
    props: [P.label('Switch'), P.tag(), { key: 'onText', label: 'On text', type: 'text', default: 'On' }, { key: 'offText', label: 'Off text', type: 'text', default: 'Off' }, P.color('On colour', '#43c483'),
      P.labelSize(), P.textSize('Switch and text size'),
      ...safetyProps('A question such as "Enable the drive?", asked before switching on. Switching off is sent at once'),
      { key: 'confirmOff', label: 'Ask when switching off too', type: 'bool', default: false, showIf: p => !!p.confirm,
        hint: 'Leave this off for anything that stops a machine: stopping should never wait for an answer' }],
    tags: tagsOf,
    mount(root, w, ctx) {
      const p = w.props;
      const b = plate(root, p.label);
      const sw = el('button', 'switch');
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', 'false');
      sw.append(el('span', 'knob'));
      const cap = el('span', 'switch-cap', p.offText);
      b.append(sw, cap);
      let cur = false;
      // "Enabled when" holder bare igjen innkobling: en bryter som er på kan alltid slås av
      const g = guard(root, w, ctx, on => { sw.disabled = !on && !cur; });
      sw.addEventListener('click', async () => {
        if (ctx.mode() !== 'run') return;
        const next = !cur;
        if (next && !g.enabled()) return;
        if ((next || p.confirmOff) && !(await g.ask(p.confirm, next ? 'Switch on' : 'Switch off'))) return;
        if (next && !g.enabled()) return;   // den kan ha endret seg mens spørsmålet var åpent
        ctx.write(p.tag, next);
      });
      g.start();
      return {
        update(t, v, q) {
          g.update(t, v, q);
          if (t !== p.tag) return;
          cur = truthy(v);
          sw.setAttribute('aria-checked', String(cur));
          sw.disabled = !g.enabled() && !cur;
          cap.textContent = cur ? p.onText : p.offText;
        },
      };
    },
  });

  // ---------------------------------------------------------------- knapp
  H.register('button', {
    name: 'Button', hint: 'Writes a value when pressed', size: [160, 76],
    props: [
      P.label(''), P.tag(),
      { key: 'text', label: 'Button text', type: 'text', default: 'Start' },
      { key: 'value', label: 'Value on press', type: 'text', default: 'true', hint: 'true, false, a number or text' },
      { key: 'releaseValue', label: 'Value on release', type: 'text', default: '', hint: 'Leave empty for a plain click' },
      { key: 'holdRepeatMs', label: 'Repeat while held (ms)', type: 'number', default: 0,
        hint: 'Hold-to-run (jog): 200 sends the press every 200 ms while held, so the adapter can switch it off if they stop. Pair it with "hold" in the layout. 0 = off' },
      P.color('Pressed colour'),
      P.labelSize(), P.textSize('Button size', 'The button text; the button grows with it'),
      ...safetyProps('A question such as "Reset the drive fault?", asked before sending. With a value on release, OK sends a short press: the value, then the release value half a second later. Not for hold-to-run (repeat while held): that sends at once'),
    ],
    // knappen følger også taggen sin, så den grånes ut som foreldet når enheten blir frakoblet
    tags: tagsOf,
    mount(root, w, ctx) {
      const b = plate(root, w.props.label);
      const btn = el('button', 'wbtn', w.props.text);
      b.append(btn);
      const release = w.props.releaseValue;
      const hasRelease = release !== '' && release != null;
      // hold-to-run må holdes inne, så det kan ikke vente på et spørsmål
      const askFirst = !!w.props.confirm && !(num(w.props.holdRepeatMs, 0) > 0);
      let stop = null;
      const g = guard(root, w, ctx, on => { if (!on && stop) stop(); });   // ikke lenger aktivert: slipp
      g.start();
      // med et spørsmål: spør, send så én gang (et kort trykk når det finnes en slippverdi)
      if (askFirst) btn.addEventListener('click', async () => {
        if (ctx.mode() !== 'run' || !g.enabled()) return;
        if (!(await g.ask(w.props.confirm, w.props.text || 'Send'))) return;
        if (!g.enabled() || !ctx.write(w.props.tag, parseValue(w.props.value))) return;
        if (hasRelease) {
          btn.classList.add('held');
          setTimeout(() => { btn.classList.remove('held'); ctx.write(w.props.tag, parseValue(release)); }, 500);
        }
      });
      const press = () => {
        if (ctx.mode() !== 'run' || stop || askFirst || !g.enabled()) return;
        btn.classList.add('held');
        stop = H.hold(
          () => ctx.write(w.props.tag, parseValue(w.props.value)),
          () => {
            stop = null;
            btn.classList.remove('held');
            if (release !== '' && release != null) ctx.write(w.props.tag, parseValue(release));
          },
          num(w.props.holdRepeatMs, 0),
        );
        if (!stop) btn.classList.remove('held');
      };
      const up = () => { if (stop) stop(); };
      btn.addEventListener('pointerdown', e => {
        if (ctx.mode() !== 'run' || askFirst) return;
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch { /* capture er bare en bonus */ }
        press();
      });
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('blur', up);
      // tastatur: Space eller Enter holdt nede virker som et holdt trykk (med spørsmål spør klikket)
      btn.addEventListener('keydown', e => { if (!askFirst && (e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } });
      btn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') up(); });
      return { update: (t, v, q) => g.update(t, v, q), destroy: up };
    },
  });

  // ---------------------------------------------------------------- glidebryter (slider)
  H.register('slider', {
    name: 'Slider', hint: 'Writes a number on release', size: [240, 96],
    props: [
      P.label('Setpoint'), P.tag(), P.unit(),
      { key: 'min', label: 'Min', type: 'number', default: 0 },
      { key: 'max', label: 'Max', type: 'number', default: 100 },
      { key: 'step', label: 'Step', type: 'number', default: 1 },
      P.decimals(0),
      P.color('Colour'),
      P.labelSize(), P.textSize('Text size', 'The current value and the min and max'),
      ...safetyProps('A question such as "Change the speed setpoint?", asked with the new value when the slider is let go'),
    ],
    tags: tagsOf,
    mount(root, w, ctx) {
      const b = plate(root, w.props.label);
      b.classList.add('wslider');
      const range = el('input');
      range.type = 'range';
      range.min = num(w.props.min, 0); range.max = num(w.props.max, 100); range.step = num(w.props.step, 1) || 1;
      const line = el('div', 'line');
      const lo = el('span', null, fmt(num(w.props.min, 0), w.props.decimals));
      const cur = el('span', 'cur', '—');
      const hi = el('span', null, fmt(num(w.props.max, 100), w.props.decimals));
      line.append(lo, cur, hi);
      b.append(range, line);
      let dragging = false, asking = false, last;
      const show = v => { cur.textContent = fmt(v, w.props.decimals) + (w.props.unit ? ' ' + w.props.unit : ''); };
      const restore = () => { if (typeof last === 'number') { range.value = last; show(last); } };
      const g = guard(root, w, ctx);
      g.start();
      range.addEventListener('pointerdown', () => { dragging = true; });
      range.addEventListener('pointerup', () => setTimeout(() => { dragging = false; }, 250));
      range.addEventListener('input', () => show(Number(range.value)));
      range.addEventListener('change', async () => {
        dragging = false;
        if (ctx.mode() !== 'run') return;
        const v = Number(range.value);
        if (!g.enabled()) return restore();
        asking = true;
        const go = await g.ask(`${w.props.confirm}\n\nNew value: ${cur.textContent}`, 'Set');
        asking = false;
        if (!go || !g.enabled()) return restore();   // tilbake til det enheten har
        ctx.write(w.props.tag, v);
      });
      return {
        update(t, v, q) {
          g.update(t, v, q);
          if (t !== w.props.tag || typeof v !== 'number') return;
          last = v;
          if (dragging || asking) return;
          range.value = v; show(v);
        },
      };
    },
  });

  // ---------------------------------------------------------------- tallfelt
  H.register('input', {
    name: 'Number input', hint: 'Type a value and set it', size: [220, 96],
    props: [
      P.label('Setpoint'), P.tag(), P.unit(),
      { key: 'min', label: 'Min', type: 'number', default: '' },
      { key: 'max', label: 'Max', type: 'number', default: '' },
      { key: 'step', label: 'Step', type: 'number', default: 1 },
      P.decimals(1),
      P.color('Value colour'),
      P.labelSize(), P.textSize('Text size', 'The current value, the input box and its button'),
      ...safetyProps('A question such as "Change the speed setpoint?", asked with the new value before it is set'),
    ],
    tags: tagsOf,
    mount(root, w, ctx) {
      const b = plate(root, w.props.label);
      b.classList.add('winput');
      const cur = el('div', 'cur');
      cur.innerHTML = 'Current <b>—</b>';
      const form = el('form');
      const inp = el('input');
      inp.type = 'number';
      if (w.props.min !== '') inp.min = w.props.min;
      if (w.props.max !== '') inp.max = w.props.max;
      inp.step = num(w.props.step, 1) || 'any';
      inp.placeholder = w.props.unit || 'value';
      const btn = el('button', null, 'Set');
      btn.type = 'submit';
      form.append(inp, btn);
      b.append(cur, form);
      const g = guard(root, w, ctx);
      g.start();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (ctx.mode() !== 'run' || inp.value === '' || !g.enabled()) return;
        const v = Number(inp.value);
        if (!(await g.ask(`${w.props.confirm}\n\nNew value: ${fmt(v, w.props.decimals)}${w.props.unit ? ' ' + w.props.unit : ''}`, 'Set'))) return;
        if (!g.enabled()) return;
        ctx.write(w.props.tag, v);
        inp.value = '';
      });
      return {
        update(t, v, q) {
          g.update(t, v, q);
          if (t === w.props.tag) cur.querySelector('b').textContent = fmt(v, w.props.decimals) + (w.props.unit ? ' ' + w.props.unit : '');
        },
      };
    },
  });

  // ---------------------------------------------------------------- trend
  // Viser et tidsrom: live (siste `span` fram til nå) eller en fast strekning lenger tilbake.
  // Punktene kommer fra huben, som spør en historikktjeneste (hvis en er koblet til) om alt som er
  // eldre enn dens eget minne.
  // Verdier tegnes som trinn: en lagret verdi holder til den neste. null er et hull (foreldet).
  const TREND_COLORS = ['#f2b441', '#5cc8e8', '#43c483'];
  const RANGES = [['10 min', 600], ['1 h', 3600], ['8 h', 28800], ['24 h', 86400], ['7 d', 604800]];
  const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800].map(s => s * 1000);
  const pad2 = n => String(n).padStart(2, '0');
  const clockOf = (t, secs) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${secs ? ':' + pad2(d.getSeconds()) : ''}`; };
  const dayOf = t => new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
  const spanText = ms => (ms >= 86400000 ? `${+(ms / 86400000).toFixed(1)} d` : ms >= 3600000 ? `${+(ms / 3600000).toFixed(1)} h` : `${Math.round(ms / 60000)} min`);
  H.register('trend', {
    name: 'Trend', hint: 'Line chart, up to 3 tags', size: [360, 200],
    props: [
      P.label('Trend'),
      { key: 'tags', label: 'Tags (comma separated)', type: 'tags', default: '' },
      { key: 'window', label: 'Time range (seconds)', type: 'number', default: 120,
        hint: 'What the trend shows at first. The hub keeps the last 600 changes of each tag: minutes for a busy value, longer for one that seldom changes. Anything older needs a connected history database' },
      { key: 'timeControls', label: 'Time controls in Run mode', type: 'bool', default: true,
        hint: 'Buttons for 10 min to 7 days, back and forward in time, and Live' },
      { key: 'min', label: 'Min (empty = auto)', type: 'number', default: '' },
      { key: 'max', label: 'Max (empty = auto)', type: 'number', default: '' },
      P.decimals(1),
      { key: 'color1', label: 'Line 1 colour', type: 'color', default: '', fallback: '#f2b441' },
      { key: 'color2', label: 'Line 2 colour', type: 'color', default: '', fallback: '#5cc8e8' },
      { key: 'color3', label: 'Line 3 colour', type: 'color', default: '', fallback: '#43c483' },
      P.labelSize(), P.textSize('Legend and axis size'),
    ],
    tags: w => String(w.props.tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3),
    mount(root, w, ctx) {
      const p = w.props;
      const b = plate(root, p.label);
      b.classList.add('wtrend');
      const cv = el('canvas');
      const foot = el('div', 'trend-foot');
      const legend = el('div', 'legend');
      const note = el('div', 'trend-note');
      foot.append(legend);
      b.append(cv, foot, note);
      const names = this.tags(w);
      const fontPx = 11 * sizeScale(p.textSize);
      // taggens eget navn (tagnavn) i forklaringen når den har et
      const shown = name => (ctx.tagLabel && ctx.tagLabel(name)) || name;
      const series = names.map((name, i) => {
        const li = el('span', null, shown(name));
        li.title = name;
        const color = p['color' + (i + 1)] || TREND_COLORS[i];
        li.style.setProperty('--c', color);
        legend.append(li);
        return { name, pts: [], color, li, last: null };
      });

      // ---- hva som vises: live, eller en fast strekning [fra, til]
      let view = { live: true, span: Math.max(5, num(p.window, 120)) * 1000 };
      const range = () => (view.live ? { to: Date.now(), from: Date.now() - view.span } : { from: view.from, to: view.to });
      const span = () => (view.live ? view.span : view.to - view.from);
      const longLive = () => view.live && view.span > 3600000;   // oppfriskes nå og da, ikke punkt for punkt

      let seq = 0, refresh = 0, reload = 0;
      async function load() {
        const my = ++seq, r = range(), width = Math.max(100, Math.round(cv.clientWidth || 400));
        note.textContent = 'Loading…';
        note.className = 'trend-note';
        let res;
        try { res = await ctx.historyRange(names, r.from, r.to, width); }
        catch (e) { res = { series: {}, error: e.message }; }
        if (my !== seq) return;   // et nyere spørsmål er stilt siden
        for (const s of series) {
          const got = (res.series && res.series[s.name]) || [];
          s.pts = view.live ? got.concat(s.pts.filter(x => x[0] > r.to)) : got;   // behold det som kom i mellomtiden
        }
        note.textContent = res.error ? 'History: ' + res.error : res.note || '';
        note.className = 'trend-note' + (res.error || res.note ? ' warn' : '');
        schedule();
        clearTimeout(refresh);
        if (longLive()) refresh = setTimeout(load, Math.max(15000, view.span / 400));
      }

      // ---- tidskontrollene (Run-modus)
      const tools = el('div', 'trend-tools');
      const rangeLabel = el('span', 'trend-range');
      const btn = (text, title, fn) => { const x = el('button', null, text); x.type = 'button'; x.title = title; x.addEventListener('click', e => { e.stopPropagation(); fn(); }); return x; };
      const go = v => { view = v; syncTools(); load(); };
      const rangeBtns = RANGES.map(([t, s]) => btn(t, `The last ${t}, live`, () => go({ live: true, span: s * 1000 })));
      const back = btn('◀', 'Back in time', () => { const r = range(), s = span(); go({ live: false, from: r.from - s / 2, to: r.to - s / 2 }); });
      const fwd = btn('▶', 'Forward in time', () => {
        const r = range(), s = span();
        go(r.to + s / 2 >= Date.now() ? { live: true, span: s } : { live: false, from: r.from + s / 2, to: r.to + s / 2 });
      });
      const liveBtn = btn('Live', 'Back to now', () => go({ live: true, span: span() }));
      function syncTools() {
        rangeBtns.forEach((x, i) => x.classList.toggle('on', view.live && view.span === RANGES[i][1] * 1000));
        fwd.disabled = view.live;
        liveBtn.hidden = view.live;
        const r = range();
        rangeLabel.textContent = view.live ? '' : `${dayOf(r.from)} ${clockOf(r.from)} – ${dayOf(r.to) === dayOf(r.from) ? '' : dayOf(r.to) + ' '}${clockOf(r.to)} (${spanText(span())})`;
      }
      if (p.timeControls !== false && ctx.mode() === 'run') {
        tools.append(rangeLabel, ...rangeBtns, back, fwd, liveBtn);
        foot.append(tools);
        syncTools();
      }

      // ---- markøren: tid og verdier der pekeren er (Run-modus)
      let hoverX = null;
      cv.addEventListener('pointermove', e => { if (ctx.mode() !== 'run') return; hoverX = e.offsetX; schedule(); });
      cv.addEventListener('pointerleave', () => { hoverX = null; schedule(); });
      const valueAt = (pts, t) => { let v = null; for (const x of pts) { if (x[0] > t) break; v = x[1]; } return v; };

      let raf = 0;
      const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
      const timer = setInterval(() => { if (view.live) schedule(); }, 1000);

      function draw() {
        const dpr = window.devicePixelRatio || 1;
        const W = cv.clientWidth, Hh = cv.clientHeight;
        if (!W || !Hh) return;
        if (cv.width !== W * dpr || cv.height !== Hh * dpr) { cv.width = W * dpr; cv.height = Hh * dpr; }
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, Hh);
        const { from: tStart, to: tEnd } = range();
        const now = Date.now();
        // skalaen: det som er synlig, pluss verdien som holdes fra før tidsrommet
        let lo = num(p.min, NaN), hi = num(p.max, NaN);
        if (Number.isNaN(lo) || Number.isNaN(hi)) {
          let mn = Infinity, mx = -Infinity;
          for (const s of series) {
            const held = valueAt(s.pts, tStart);
            for (const v of [held, ...s.pts.filter(x => x[0] >= tStart && x[0] <= tEnd).map(x => x[1])]) {
              if (typeof v === 'number') { if (v < mn) mn = v; if (v > mx) mx = v; }
            }
          }
          if (mn === Infinity) { mn = 0; mx = 1; }
          if (mn === mx) { mn -= 1; mx += 1; }
          const pad = (mx - mn) * 0.1;
          if (Number.isNaN(lo)) lo = mn - pad;
          if (Number.isNaN(hi)) hi = mx + pad;
        }
        const css = getComputedStyle(root);
        const soft = css.getPropertyValue('--line-soft') || '#2b323b', ink3 = css.getPropertyValue('--ink-3') || '#6f7a87';
        g.font = `${fontPx}px ${css.fontFamily || 'sans-serif'}`;
        // tallene på aksen bestemmer hvor mye plass venstre side trenger
        const labels = [0, 1, 2].map(i => fmt(hi - (hi - lo) * i / 2, p.decimals));
        const padL = Math.ceil(Math.max(...labels.map(t => g.measureText(t).width))) + 10;
        const padR = 8, padT = 6, padB = Math.ceil(fontPx) + 8, half = fontPx / 2 + 1;
        const x0 = padL, x1 = W - padR, y0 = padT, y1 = Hh - padB;
        const X = t => x0 + (t - tStart) / (tEnd - tStart || 1) * (x1 - x0);
        const Y = v => y1 - (v - lo) / (hi - lo || 1) * (y1 - y0);
        g.strokeStyle = soft;
        g.fillStyle = ink3;
        g.lineWidth = 1;
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        for (let i = 0; i <= 2; i++) {
          const y = y0 + (y1 - y0) * i / 2;
          g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
          g.fillText(labels[i], x0 - 6, Math.min(y1 - half, Math.max(y0 + half, y)));
        }
        // tidsaksen: et rundt steg som gir plass til etikettene, på lokale klokkeslett
        const ms = tEnd - tStart;
        const minGap = g.measureText(ms >= 86400000 * 2 ? '00.00 00:00' : '00:00:00').width + 18;
        const step = TICKS.find(s => s / ms * (x1 - x0) >= minGap) || TICKS[TICKS.length - 1];
        const off = new Date(tStart).getTimezoneOffset() * 60000;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        for (let t = Math.ceil((tStart - off) / step) * step + off; t <= tEnd; t += step) {
          const x = X(t);
          g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
          const midnight = clockOf(t) === '00:00';
          const text = step >= 86400000 ? dayOf(t) : midnight && ms > 3600000 ? dayOf(t) : clockOf(t, step < 60000);
          const tw = g.measureText(text).width / 2;
          if (x - tw >= x0 - 4 && x + tw <= W) g.fillText(text, x, y1 + 4);
        }
        // linjene, som trinn; null bryter dem
        g.save();
        g.beginPath(); g.rect(x0, y0 - 1, x1 - x0, y1 - y0 + 2); g.clip();
        g.lineWidth = 1.5;
        g.lineJoin = 'round';
        const end = X(Math.min(tEnd, now));
        for (const s of series) {
          g.strokeStyle = s.color;
          g.beginPath();
          let prev = null;
          for (const [t, v] of s.pts) {
            const x = X(t);
            if (v === null) { if (prev) g.lineTo(x, prev); prev = null; continue; }
            const y = Y(v);
            if (prev === null) g.moveTo(x, y); else { g.lineTo(x, prev); g.lineTo(x, y); }
            prev = y;
          }
          if (prev !== null) g.lineTo(Math.max(end, 0), prev);   // siste verdi holder fram til nå
          g.stroke();
        }
        g.restore();
        // markøren
        if (hoverX !== null && hoverX >= x0 && hoverX <= x1) {
          const t = tStart + (hoverX - x0) / (x1 - x0) * (tEnd - tStart);
          g.strokeStyle = css.getPropertyValue('--ink-2') || '#aab3be';
          g.setLineDash([3, 3]);
          g.beginPath(); g.moveTo(hoverX, y0); g.lineTo(hoverX, y1); g.stroke();
          g.setLineDash([]);
          const rows = [(ms > 86400000 ? dayOf(t) + ' ' : '') + clockOf(t, ms < 3600000)]
            .concat(series.map(s => { const v = valueAt(s.pts, t); return `${(ctx.tagLabel && ctx.tagLabel(s.name)) || s.name.split('.').pop()}  ${v === null ? '—' : fmt(v, p.decimals)}`; }));
          const lh = fontPx + 5, bw = Math.max(...rows.map(r => g.measureText(r).width)) + 16, bh = rows.length * lh + 8;
          const bx = hoverX + bw + 12 > x1 ? hoverX - bw - 8 : hoverX + 8;
          g.fillStyle = 'rgba(20, 24, 29, 0.92)';
          g.fillRect(bx, y0 + 4, bw, bh);
          g.textAlign = 'left';
          g.textBaseline = 'top';
          rows.forEach((r, i) => {
            g.fillStyle = i === 0 ? (css.getPropertyValue('--ink-2') || '#aab3be') : series[i - 1].color;
            g.fillText(r, bx + 8, y0 + 8 + i * lh);
          });
        }
      }

      // første lasting når widgeten er på siden: lerretets bredde avgjør hvor mange punkter vi ber om
      const first = setTimeout(load);
      const ro = new ResizeObserver(() => schedule());
      ro.observe(cv);
      return {
        update(name, v, q, ts) {
          const s = series.find(x => x.name === name);
          if (!s) return;
          const val = typeof v === 'boolean' ? (v ? 1 : 0) : v;
          if (typeof val === 'number') { s.last = val; s.li.textContent = `${shown(name)} ${fmt(val, p.decimals)}`; }
          if (!view.live) return;   // en strekning i fortiden flytter seg ikke
          const t = ts || Date.now();
          const point = q === 'bad' ? [t, null] : typeof val === 'number' ? [t, val] : null;
          if (!point) return;
          // lange tidsrom: høyst omtrent ett punkt per piksel; oppfriskingen fyller inn resten
          const lastPt = s.pts[s.pts.length - 1];
          if (longLive() && lastPt && t - lastPt[0] < view.span / 1500) return;
          s.pts.push(point);
          // fjern det som har rullet ut, men behold verdien som holdes fra før tidsrommet
          const cut = Date.now() - view.span;
          let i = 0;
          while (i + 1 < s.pts.length && s.pts[i + 1][0] < cut) i++;
          if (i) s.pts.splice(0, i);
          schedule();
        },
        // tagnavnene er endret
        relabel() { for (const x of series) x.li.textContent = x.last === null ? shown(x.name) : `${shown(x.name)} ${fmt(x.last, p.decimals)}`; },
        // huben har fått eldre punkter tilbake (f.eks. fra PLS-ens ringbuffer): hent tidsrommet på nytt
        restored() { clearTimeout(reload); reload = setTimeout(load, 300); },
        destroy() { clearInterval(timer); clearTimeout(refresh); clearTimeout(first); clearTimeout(reload); cancelAnimationFrame(raf); ro.disconnect(); seq++; },
      };
    },
  });

  // ---------------------------------------------------------------- tidslinje
  // Digitale signaler over tid, ett felt per signal med en stolpe der signalet var på: for å se
  // hva som var aktivt når. Dra for å gå bakover og framover i tid (og opp og ned i listen),
  // rull med musehjulet eller klyp for å zoome. Punktene kommer fra huben som til Trend
  // (historyRange), med et tidsrom ekstra på hver side, så et kort drag ikke venter på huben.
  const LANES_MAX = 128;
  const SPAN_MIN = 10e3, SPAN_MAX = 31 * 86400e3;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const globRe = s => new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  // "kv_1.*" tar med av/på-taggene (dataType boolean) som passer, sortert; et navn alene tas med
  // som det er (på når verdien ikke er 0); "!kv_1.link" tar en tag eller en gruppe ut igjen.
  // known: tagoversikten fra huben (navn -> info)
  function timelineTags(spec, known) {
    const out = [];
    for (const part of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const not = part[0] === '!', pat = not ? part.slice(1).trim() : part;
      if (!pat) continue;
      let hits = [pat];
      if (pat.includes('*')) {
        const re = globRe(pat);
        hits = known ? [...known.values()].filter(t => (not || t.dataType === 'boolean') && re.test(t.name)).map(t => t.name) : [];
        hits.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      }
      for (const n of hits) {
        const i = out.indexOf(n);
        if (not) { if (i >= 0) out.splice(i, 1); } else if (i < 0) out.push(n);
      }
    }
    return out;
  }
  // 4.2 s, 2 min 7 s, 15 min, 3 h 12 min, 2 d
  const durText = ms => {
    const s = Math.round(ms / 1000);
    const two = (a, ua, c, uc) => (c ? `${a} ${ua} ${c} ${uc}` : `${a} ${ua}`);
    if (ms < 10000) return `${+(ms / 1000).toFixed(1)} s`;
    if (s < 60) return `${s} s`;
    if (s < 3600) return two(Math.floor(s / 60), 'min', s % 60, 's');
    if (s < 86400) return two(Math.floor(s / 3600), 'h', Math.floor(s % 3600 / 60), 'min');
    return two(Math.floor(s / 86400), 'd', Math.floor(s % 86400 / 3600), 'h');
  };
  // klokkeslett med sekunder, og datoen når det ikke er i dag
  const stamp = t => (new Date(t).toDateString() !== new Date().toDateString() ? dayOf(t) + ' ' : '') + clockOf(t, true);

  H.register('timeline', {
    name: 'Timeline', hint: 'Digital signals over time; drag and zoom', size: [520, 260],
    props: [
      P.label('Timeline'),
      { key: 'tags', label: 'Signals (comma separated)', type: 'tags', default: '*',
        hint: '* is every digital (on/off) tag, kv_1.* those of one device. A tag named on its own is on when it isn’t 0. !kv_1.link leaves one out. Up to 128 signals' },
      { key: 'window', label: 'Time range (seconds)', type: 'number', default: 600,
        hint: 'What it shows at first. In Run mode, drag sideways to go back in time, and use the mouse wheel or two fingers to zoom. The hub keeps the last 600 changes of each tag' },
      { key: 'onlyActive', label: 'Hide signals that stay off', type: 'bool', default: false,
        hint: 'Shows only the signals that were on somewhere in the time range' },
      { key: 'timeControls', label: 'Time controls in Run mode', type: 'bool', default: true,
        hint: 'Buttons for 10 min to 7 days, back and forward, zoom, and Live' },
      P.color('On colour', '#43c483'),
      P.labelSize(), P.textSize('Names and axis size'),
    ],
    // taggene følger tagoversikten (kv_1.*): appen monterer widgeten på nytt når listen endres
    byPattern: true,
    tags: (w, known) => timelineTags(w.props.tags, known).slice(0, LANES_MAX),
    mount(root, w, ctx) {
      const p = w.props;
      const b = plate(root, p.label);
      b.classList.add('wtrend', 'wtimeline');
      const cv = el('canvas');
      const foot = el('div', 'trend-foot');
      const info = el('span', 'tl-info');
      const note = el('div', 'trend-note');
      foot.append(info);
      b.append(cv, foot, note);
      const run = () => ctx.mode() === 'run';
      const all = timelineTags(p.tags, ctx.registry ? ctx.registry() : null);
      const lanes = all.slice(0, LANES_MAX).map(name => ({ name, pts: [] }));
      const byName = new Map(lanes.map(l => [l.name, l]));
      const names = lanes.map(l => l.name);
      const capped = all.length > lanes.length ? `Showing the first ${lanes.length} of ${all.length} signals: narrow the list in the settings` : '';
      info.textContent = lanes.length ? `${lanes.length} signal${lanes.length === 1 ? '' : 's'}` : '';
      info.title = 'Drag sideways to move in time, up and down to scroll the list. Mouse wheel or two fingers: zoom. Shift+wheel: move in time';
      const fontPx = 11 * sizeScale(p.textSize);
      const shown = name => (ctx.tagLabel && ctx.tagLabel(name)) || name;
      const isOnV = v => v !== null && v !== undefined && v !== 0 && v !== false;
      const sameState = (a, b2) => (a === null) === (b2 === null) && isOnV(a) === isOnV(b2);
      // indeksen til siste punkt på eller før t; -1 når alle er senere
      const at = (pts, t) => { let lo = 0, hi = pts.length - 1, i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i; };

      // ---- hva som vises: live, eller en fast strekning [fra, til]
      let view = { live: true, span: clamp(num(p.window, 600) * 1000, SPAN_MIN, SPAN_MAX) };
      const range = () => (view.live ? { to: Date.now(), from: Date.now() - view.span } : { from: view.from, to: view.to });
      const span = () => (view.live ? view.span : view.to - view.from);

      // ---- punktene: det som vises, og like mye på hver side (men ikke etter nå)
      let seq = 0, loadTimer = 0, reload = 0;
      let loaded = null;   // { from, to, span } for det som sist ble hentet
      let edge = true;     // det som er hentet, rekker fram til nå: nye verdier legges til
      const covered = () => {
        if (!loaded) return false;
        const r = range();
        return Math.abs(loaded.span - span()) < 1 && r.from >= loaded.from && (r.to <= loaded.to || edge);
      };
      async function load() {
        clearTimeout(loadTimer);
        if (!names.length) return;
        const my = ++seq, r = range(), s = r.to - r.from, now = Date.now();
        const from = r.from - s, to = Math.min(now, r.to + s);
        const points = Math.min(4000, Math.max(300, Math.round((cv.clientWidth || 400) * 3)));
        if (!loaded) note.textContent = 'Loading…';
        const parts = [];
        for (let i = 0; i < names.length; i += 8) parts.push(names.slice(i, i + 8));   // huben tar 8 tagger per spørsmål
        let res;
        try { res = await Promise.all(parts.map(x => ctx.historyRange(x, from, to, points))); }
        catch (e) { res = [{ series: {}, error: e.message }]; }
        if (my !== seq) return;   // et nyere spørsmål er stilt siden
        const series = Object.assign({}, ...res.map(x => x.series || {}));
        for (const l of lanes) {
          const got = series[l.name] || [];
          l.pts = to === now ? got.concat(l.pts.filter(x => x[0] > to)) : got;   // behold det som kom i mellomtiden
        }
        loaded = { from, to, span: s };
        edge = to === now;
        const bad = res.find(x => x.error), said = res.find(x => x.note);
        note.textContent = [bad ? 'History: ' + bad.error : said ? said.note : '', capped].filter(Boolean).join('. ');
        note.className = 'trend-note' + (note.textContent ? ' warn' : '');
        schedule();
      }
      const loadSoon = () => { clearTimeout(loadTimer); loadTimer = setTimeout(load, 200); };

      // ---- flytte og zoome
      function setView(from, to) {
        const s = clamp(to - from, SPAN_MIN, SPAN_MAX);
        view = from + s >= Date.now() ? { live: true, span: s } : { live: false, from, to: from + s };
        syncTools();
        if (!covered()) loadSoon();
        schedule();
      }
      // factor > 1 zoomer ut. Live står nå fast i høyre kant; ellers står tiden ved `anchor` stille
      function zoom(anchor, factor) {
        const r = range(), s = r.to - r.from, ns = clamp(s * factor, SPAN_MIN, SPAN_MAX);
        if (ns === s) return;
        if (view.live) { view = { live: true, span: ns }; syncTools(); loadSoon(); schedule(); return; }
        const a = anchor == null ? (r.from + r.to) / 2 : anchor;
        const from = a - (a - r.from) * ns / s;
        setView(from, from + ns);
      }
      const pan = f => { const r = range(), d = f * (r.to - r.from); setView(r.from + d, r.to + d); };

      // ---- tidskontrollene (Run-modus)
      const tools = el('div', 'trend-tools');
      const rangeLabel = el('span', 'trend-range');
      const btn = (text, title, fn) => { const x = el('button', null, text); x.type = 'button'; x.title = title; x.addEventListener('click', e => { e.stopPropagation(); fn(); }); return x; };
      const rangeBtns = RANGES.map(([t, s]) => btn(t, `The last ${t}, live`, () => { view = { live: true, span: s * 1000 }; syncTools(); load(); }));
      const back = btn('◀', 'Back in time', () => pan(-0.5));
      const fwd = btn('▶', 'Forward in time', () => pan(0.5));
      const zoomOut = btn('−', 'Zoom out', () => zoom(null, 2));
      const zoomIn = btn('+', 'Zoom in', () => zoom(null, 0.5));
      const liveBtn = btn('Live', 'Back to now', () => { view = { live: true, span: span() }; syncTools(); load(); });
      function syncTools() {
        rangeBtns.forEach((x, i) => x.classList.toggle('on', view.live && view.span === RANGES[i][1] * 1000));
        fwd.disabled = view.live;
        zoomIn.disabled = span() <= SPAN_MIN;
        zoomOut.disabled = span() >= SPAN_MAX;
        liveBtn.hidden = view.live;
        const r = range();
        // live: hvor langt tilbake, når ingen av knappene passer (etter en zoom)
        rangeLabel.textContent = view.live ? (RANGES.some(x => x[1] * 1000 === view.span) ? '' : `Last ${durText(view.span)}`)
          : `${dayOf(r.from)} ${clockOf(r.from, span() < 3600000)} – ${dayOf(r.to) === dayOf(r.from) ? '' : dayOf(r.to) + ' '}${clockOf(r.to, span() < 3600000)} (${durText(span())})`;
      }
      if (p.timeControls !== false && run()) {
        tools.append(rangeLabel, ...rangeBtns, back, fwd, zoomOut, zoomIn, liveBtn);
        foot.append(tools);
      }
      syncTools();

      // ---- pekeren: dra, klyp, hjul, og markøren med signalet under (Run-modus)
      let L = { x0: 0, x1: 1, y0: 0, y1: 1, rowH: 20, W: 1, Hh: 1 };   // fra siste tegning
      let scrollY = 0, hover = null, drag = null, pinch = null;
      const ptrs = new Map();
      // i lerretets egne piksler: Run-modus skalerer hele skjermbildet
      const local = e => { const r = cv.getBoundingClientRect(), k = r.width / (cv.clientWidth || 1) || 1; return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }; };
      const timeAt = (x, r) => r.from + clamp((x - L.x0) / (L.x1 - L.x0 || 1), 0, 1) * (r.to - r.from);
      const startDrag = pt => { const r = range(); drag = { start: pt, from: r.from, to: r.to, scrollY, moved: false }; };
      cv.addEventListener('pointerdown', e => {
        if (!run() || (e.pointerType === 'mouse' && e.button !== 0)) return;
        cv.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, local(e));
        if (ptrs.size === 1) startDrag(local(e));
        else if (ptrs.size === 2) {
          const [a, c] = [...ptrs.values()], r = range();
          pinch = { d: Math.hypot(a.x - c.x, a.y - c.y) || 1, at: timeAt((a.x + c.x) / 2, r), f: ((a.x + c.x) / 2 - L.x0) / (L.x1 - L.x0 || 1), span: r.to - r.from };
          drag = null;
        }
        e.preventDefault();
      });
      cv.addEventListener('pointermove', e => {
        if (!run()) return;
        const pt = local(e);
        if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, pt);
        if (pinch && ptrs.size >= 2) {
          const [a, c] = [...ptrs.values()];
          const ns = clamp(pinch.span * pinch.d / (Math.hypot(a.x - c.x, a.y - c.y) || 1), SPAN_MIN, SPAN_MAX);
          const from = pinch.at - clamp(pinch.f, 0, 1) * ns;
          setView(from, from + ns);
          return;
        }
        if (drag) {
          const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
          if (!drag.moved && Math.hypot(dx, dy) < 4) return;
          drag.moved = true;
          hover = null;
          cv.classList.add('dragging');
          const dt = -dx / (L.x1 - L.x0 || 1) * (drag.to - drag.from);
          scrollY = drag.scrollY - dy;
          setView(drag.from + dt, drag.to + dt);
          return;
        }
        hover = pt;
        schedule();
      });
      const release = e => {
        if (!ptrs.delete(e.pointerId)) return;
        if (drag && !drag.moved && e.type === 'pointerup') { hover = local(e); schedule(); }   // et trykk: markøren der
        if (ptrs.size < 2) pinch = null;
        if (!ptrs.size) { drag = null; cv.classList.remove('dragging'); }
        else if (!drag) { startDrag([...ptrs.values()][0]); drag.moved = true; }   // fra klyp til dra
      };
      cv.addEventListener('pointerup', release);
      cv.addEventListener('pointercancel', release);
      cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !ptrs.size) { hover = null; schedule(); } });
      cv.addEventListener('wheel', e => {
        if (!run()) return;
        e.preventDefault();
        const pt = local(e), k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const dx = e.deltaX * k, dy = e.deltaY * k;
        if (!dx && !dy) return;
        if (pt.x < L.x0) { scrollY += dy || dx; schedule(); return; }   // over navnene: rull listen
        const r = range();
        if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
          const d = (Math.abs(dx) > Math.abs(dy) ? dx : dy) / (L.x1 - L.x0 || 1) * (r.to - r.from);
          return setView(r.from + d, r.to + d);
        }
        zoom(timeAt(pt.x, r), Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)));   // ctrl: klyp på styreflaten
      }, { passive: false });

      // ---- tegningen
      let raf = 0;
      const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
      const timer = setInterval(() => { if (view.live) schedule(); }, 1000);
      const fitCache = new Map();
      function fitText(g, s, width) {
        const key = s + '|' + width + '|' + g.font;
        let r = fitCache.get(key);
        if (r === undefined) {
          r = s;
          if (g.measureText(s).width > width) { while (r.length > 1 && g.measureText(r + '…').width > width) r = r.slice(0, -1); r += '…'; }
          if (fitCache.size > 500) fitCache.clear();
          fitCache.set(key, r);
        }
        return r;
      }
      // det siste punktet gjelder fram til nå, eller til slutten av det som er hentet
      const holdEnd = () => (edge || !loaded ? Date.now() : loaded.to);
      const wasOn = (l, from, to) => {
        const pts = l.pts, end = holdEnd();
        for (let i = Math.max(0, at(pts, from)); i < pts.length && pts[i][0] <= to; i++) {
          if (isOnV(pts[i][1]) && (i + 1 < pts.length ? pts[i + 1][0] : end) > from) return true;
        }
        return false;
      };
      // hvor lenge verdien ved t holdt seg: fra punktet der den begynte, til det neste som skiller seg ut
      function stretch(l, t) {
        const pts = l.pts, i = at(pts, t);
        if (i < 0) return null;
        const v = pts[i][1];
        let a = i, z = i + 1;
        while (a > 0 && sameState(pts[a - 1][1], v)) a--;
        while (z < pts.length && sameState(pts[z][1], v)) z++;
        return { v, from: pts[a][0], fromKnown: !(a === 0 && loaded && pts[0][0] <= loaded.from), to: z < pts.length ? pts[z][0] : null };
      }
      let shownLanes = lanes;

      function draw() {
        const dpr = window.devicePixelRatio || 1;
        const W = cv.clientWidth, Hh = cv.clientHeight;
        if (!W || !Hh) return;
        if (cv.width !== W * dpr || cv.height !== Hh * dpr) { cv.width = W * dpr; cv.height = Hh * dpr; }
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, Hh);
        const css = getComputedStyle(root);
        const col = (name, d) => css.getPropertyValue(name).trim() || d;
        const soft = col('--line-soft', '#2b323b'), line = col('--line', '#3a434f');
        const ink = col('--ink', '#e7eaee'), ink2 = col('--ink-2', '#aab3be'), ink3 = col('--ink-3', '#6f7a87');
        const onCol = p.color || col('--ok', '#43c483');
        g.font = `${fontPx}px ${css.fontFamily || 'sans-serif'}`;
        g.lineWidth = 1;
        const r = range(), tStart = r.from, tEnd = r.to, ms = tEnd - tStart, now = Date.now();
        shownLanes = p.onlyActive ? lanes.filter(l => wasOn(l, tStart, tEnd)) : lanes;
        // feltene: navnene til venstre, tidsaksen nederst, en rullefelt-strek når listen er for lang
        const rowH = Math.round(fontPx * 1.9), padB = Math.ceil(fontPx) + 8;
        let nameW = 0;
        for (const l of shownLanes) nameW = Math.max(nameW, g.measureText(shown(l.name)).width);
        nameW = Math.round(clamp(nameW + 16, 48, W * 0.4));
        const y0 = 0, y1 = Hh - padB, over = shownLanes.length * rowH - (y1 - y0);
        const x0 = nameW, x1 = W - (over > 0 ? 8 : 2);
        scrollY = clamp(scrollY, 0, Math.max(0, over));
        L = { x0, x1, y0, y1, rowH, W, Hh };
        const X = t => x0 + (t - tStart) / (ms || 1) * (x1 - x0);

        // tidsaksen: et rundt steg som gir plass til etikettene, på lokale klokkeslett
        const minGap = g.measureText(ms >= 86400000 * 2 ? '00.00 00:00' : '00:00:00').width + 18;
        const step = TICKS.find(s => s / ms * (x1 - x0) >= minGap) || TICKS[TICKS.length - 1];
        const off = new Date(tStart).getTimezoneOffset() * 60000;
        g.strokeStyle = soft;
        g.fillStyle = ink3;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        for (let t = Math.ceil((tStart - off) / step) * step + off; t <= tEnd; t += step) {
          const x = Math.round(X(t)) + 0.5;
          g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
          const midnight = clockOf(t) === '00:00';
          const text = step >= 86400000 ? dayOf(t) : midnight && ms > 3600000 ? dayOf(t) : clockOf(t, step < 60000);
          const tw = g.measureText(text).width / 2;
          if (x - tw >= x0 - 4 && x + tw <= W) g.fillText(text, x, y1 + 4);
        }

        // ett felt per signal: en stolpe der det var på, en tynn strek der det var av,
        // stiplet der enheten var frakoblet, ingenting før det første punktet
        const hovLane = run() && hover && hover.y >= y0 && hover.y < y1 ? Math.floor((hover.y - y0 + scrollY) / rowH) : -1;
        const end = Math.min(holdEnd(), tEnd);
        const inset = Math.round(rowH * 0.2);
        g.save();
        g.beginPath(); g.rect(0, y0, W, y1 - y0); g.clip();
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        shownLanes.forEach((l, i) => {
          const y = y0 + i * rowH - scrollY;
          if (y + rowH < y0 || y > y1) return;
          if (i === hovLane || i % 2) { g.fillStyle = i === hovLane ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.025)'; g.fillRect(0, y, x1, rowH); }
          g.fillStyle = ink2;
          g.fillText(fitText(g, shown(l.name), nameW - 12), 6, y + rowH / 2);
          const pts = l.pts;
          for (let k = Math.max(0, at(pts, tStart)); k < pts.length; k++) {
            const t = pts[k][0];
            if (t > tEnd) break;
            const t2 = k + 1 < pts.length ? pts[k + 1][0] : end;
            if (t2 <= tStart) continue;
            const v = pts[k][1], a = X(Math.max(t, tStart)), z = X(Math.min(t2, tEnd));
            if (v === null) {
              g.strokeStyle = ink3;
              g.setLineDash([3, 3]);
              g.beginPath(); g.moveTo(a, y + rowH / 2); g.lineTo(z, y + rowH / 2); g.stroke();
              g.setLineDash([]);
            } else if (isOnV(v)) {
              g.fillStyle = onCol;
              g.fillRect(a, y + inset, Math.max(1.5, z - a), rowH - 2 * inset);   // også en kort puls synes
            } else {
              g.fillStyle = line;
              g.fillRect(a, y + rowH - inset - 1, Math.max(0, z - a), 1);
            }
          }
        });
        g.restore();
        g.strokeStyle = line;
        g.beginPath(); g.moveTo(x0 - 0.5, y0); g.lineTo(x0 - 0.5, y1); g.stroke();
        if (over > 0) {
          const total = shownLanes.length * rowH, th = Math.max(16, (y1 - y0) * (y1 - y0) / total);
          g.fillStyle = ink3;
          g.fillRect(W - 5, y0 + scrollY / over * (y1 - y0 - th), 3, th);
        }
        if (!shownLanes.length) {
          g.fillStyle = ink3;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          const why = lanes.length ? 'No signal was on in this time range'
            : String(p.tags || '').trim() ? `No digital tags match “${String(p.tags).trim()}” yet` : 'Choose the signals in the settings';
          g.fillText(fitText(g, why, W - 16), W / 2, (y0 + y1) / 2);
        }

        // markøren: tiden nederst, og hvor lenge signalet under pekeren var på eller av
        if (!run() || !hover) return;
        const l = hovLane >= 0 ? shownLanes[hovLane] : null;
        const lh = fontPx + 5;
        const tip = (rows, colors, x, y) => {
          const bw = Math.max(...rows.map(t => g.measureText(t).width)) + 16, bh = rows.length * lh + 8;
          const bx = x + 14 + bw > W ? Math.max(2, x - bw - 10) : x + 14;
          const by = y + bh + 4 > y1 ? Math.max(2, y - bh - 4) : y + 4;
          g.fillStyle = 'rgba(20, 24, 29, 0.94)';
          g.fillRect(bx, by, bw, bh);
          g.strokeStyle = line;
          g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
          g.textAlign = 'left';
          g.textBaseline = 'top';
          rows.forEach((t, i) => { g.fillStyle = colors[i] || ink2; g.fillText(t, bx + 8, by + 4 + i * lh); });
        };
        const title = l ? shown(l.name) + (shown(l.name) !== l.name ? `  (${l.name})` : '') : '';
        if (hover.x < x0) { if (l) tip([title], [ink], hover.x, hover.y); return; }
        if (hover.x > x1) return;
        const t = tStart + (hover.x - x0) / (x1 - x0) * ms;
        g.strokeStyle = ink2;
        g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(Math.round(hover.x) + 0.5, y0); g.lineTo(Math.round(hover.x) + 0.5, y1); g.stroke();
        g.setLineDash([]);
        const when = stamp(t), ww = g.measureText(when).width + 10, wx = clamp(hover.x - ww / 2, x0, W - ww);
        g.fillStyle = 'rgba(20, 24, 29, 0.95)';
        g.fillRect(wx, y1 + 1, ww, padB - 1);
        g.fillStyle = ink;
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(when, wx + 5, y1 + 4);
        if (!l || t > now) return;
        const s = stretch(l, t);
        if (!s) return tip([title, 'No data this far back'], [ink], hover.x, hover.y);
        const on = isOnV(s.v);
        const what = s.v === null ? 'Offline' : (on ? 'On' : 'Off') + (typeof s.v === 'number' && s.v !== 0 && s.v !== 1 ? ` (${s.v})` : '');
        const until = s.to !== null ? s.to : edge ? null : undefined;   // null: fortsatt slik nå; undefined: ukjent
        const rows = [title, `${what}  ${s.fromKnown ? '' : 'before '}${stamp(s.from)} – ${until === null ? 'now' : until === undefined ? '…' : stamp(until)}`];
        if (until !== undefined) rows.push(`${s.fromKnown ? '' : 'at least '}${durText((until === null ? now : until) - s.from)}`);
        tip(rows, [ink, on ? onCol : ink2, ink2], hover.x, hover.y);
      }

      // første lasting når widgeten er på siden: lerretets bredde avgjør hvor mange punkter vi ber om
      const first = setTimeout(load);
      const ro = new ResizeObserver(() => schedule());
      ro.observe(cv);
      return {
        update(name, v, q, ts) {
          const l = byName.get(name);
          if (!l || !edge) return;   // en strekning i fortiden: en ny verdi hører ikke hjemme der
          const t = ts || Date.now();
          const val = q === 'bad' || v === undefined || v === null ? null
            : typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : truthy(v) ? 1 : 0;
          const pts = l.pts, last = pts[pts.length - 1];
          if (last && last[1] === val) return;
          if (last && t < last[0]) pts.splice(at(pts, t) + 1, 0, [t, val]);
          else pts.push([t, val]);
          // fjern det som er langt utenfor, men behold verdien som holdes fra før
          if (view.live) {
            const cut = Date.now() - 3 * view.span;
            let i = 0;
            while (i + 1 < pts.length && pts[i + 1][0] < cut) i++;
            if (i) pts.splice(0, i);
          }
          schedule();
        },
        // tagnavnene er endret
        relabel() { fitCache.clear(); schedule(); },
        // huben har fått eldre punkter tilbake (f.eks. fra PLS-ens ringbuffer): hent tidsrommet på nytt
        restored() { clearTimeout(reload); reload = setTimeout(load, 300); },
        destroy() { clearInterval(timer); clearTimeout(first); clearTimeout(loadTimer); clearTimeout(reload); cancelAnimationFrame(raf); ro.disconnect(); seq++; },
      };
    },
  });

  // ---------------------------------------------------------------- hendelser / alarmer
  const SEV = { info: 0, warning: 1, alarm: 2 };
  H.register('events', {
    name: 'Event log', hint: 'Messages and alarms', size: [360, 160],
    props: [
      P.label('Events'),
      { key: 'source', label: 'Source starts with', type: 'text', default: '', hint: 'Leave empty for all sources' },
      { key: 'minSeverity', label: 'Show from', type: 'select', options: ['info', 'warning', 'alarm'], default: 'info' },
      { key: 'rows', label: 'Rows', type: 'number', default: 8 },
      P.labelSize(), P.textSize('Row text size'),
    ],
    tags: () => [],
    mount(root, w) {
      const b = plate(root, w.props.label);
      b.classList.add('wevents');
      const list = el('div', 'evlist');
      const none = el('div', 'none', 'No events yet');
      list.append(none);
      b.append(list);
      const minR = SEV[w.props.minSeverity] || 0;
      const src = String(w.props.source || '').trim();
      const rows = Math.max(1, num(w.props.rows, 8));
      return {
        event(ev) {
          if ((SEV[ev.severity] || 0) < minR) return;
          if (src && !String(ev.source).startsWith(src)) return;
          none.remove();
          const row = el('div', 'evrow');
          const t = el('time', null, hhmmss(ev.ts));
          const sev = el('span', 'sev ' + ev.severity);
          const msg = el('span', 'msg');
          msg.append(el('b', null, ev.source), document.createTextNode(ev.message));
          row.append(t, sev, msg);
          list.prepend(row);
          while (list.children.length > rows) list.lastChild.remove();
        },
        reset() { list.innerHTML = ''; list.append(none); },
      };
    },
  });
})();
