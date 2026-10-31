/*
 * Aktive alarmer: listen huben holder (meldingen "alarms"), vinduet som viser den, og
 * Alarm list-widgeten.
 *
 * En alarm blir stående i listen til den er borte og kvittert (som i ISA-18.2):
 *   aktiv, ikke kvittert         krever oppmerksomhet: rød (alarm) eller gul (advarsel)
 *   aktiv, kvittert              fortsatt på, men noen har sett den
 *   borte, ikke kvittert         den forsvant før noen så den
 * En advarsel- eller alarmmelding fra en enhet uten betingelse bak blir stående til den
 * er kvittert.
 *
 * H.alarms                  listen slik huben sist sendte den
 *   .set(list, { stale })   stale: forbindelsen til huben er borte, listen kan være utdatert
 *   .subscribe(fn) -> off
 *   .sorted(filter)         mest presserende først
 * H.openAlarmList(opts)     vinduet: { ack(keys | 'all'), openCode(list, value, title) }
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el } = H.helpers;

  // ---------------------------------------------------------------- lageret
  let list = [], stale = false;
  const listeners = new Set();
  const RANK = { alarm: 2, warning: 1 };
  const urgency = a => (a.acked ? 0 : 4) + (a.active ? 2 : 0);
  H.alarms = {
    get: () => list,
    stale: () => stale,
    set(next, opts = {}) {
      list = Array.isArray(next) ? next : list;
      stale = !!opts.stale;
      for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } }
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // ukvitterte først, så aktive, så alarmer før advarsler, så de nyeste
    sorted(filter) {
      return list.filter(filter || (() => true)).sort((a, b) =>
        urgency(b) - urgency(a) || (RANK[b.severity] || 0) - (RANK[a.severity] || 0) || b.since - a.since);
    },
    counts(filter) {
      const l = list.filter(filter || (() => true));
      return { total: l.length, unacked: l.filter(a => !a.acked).length, active: l.filter(a => a.active).length };
    },
  };

  const clock = ts => {
    const d = new Date(ts), today = new Date().toDateString() === d.toDateString();
    return today ? d.toTimeString().slice(0, 8) : d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const stateText = a => {
    if (a.kind === 'event') return a.acked ? 'Acknowledged' : 'Not acknowledged';
    if (a.active) return a.acked ? 'Active · acknowledged' : 'Active';
    return 'Cleared · not acknowledged';
  };

  // én alarm som en rad. actions: { ack(key) | null, openCode(list, value, title) }
  function row(a, actions) {
    const r = el('div', `al-row ${a.severity}${a.acked ? ' acked' : ''}${a.active ? ' active' : ' cleared'}`);
    r.setAttribute('role', 'row');
    const dot = el('span', 'al-dot');
    dot.title = a.severity === 'alarm' ? 'Alarm' : 'Warning';
    const time = el('time', 'al-time', clock(a.since));
    time.title = 'Since ' + new Date(a.since).toLocaleString() + (a.clearedAt && !a.active ? '\nCleared ' + new Date(a.clearedAt).toLocaleString() : '') +
      (a.acked ? `\nAcknowledged ${new Date(a.ackedAt).toLocaleString()} by ${a.ackedBy}` : '');
    const msg = el('span', 'al-msg');
    msg.append(el('b', null, a.source), document.createTextNode(a.text));
    if (a.count > 1) msg.append(el('span', 'al-count', `×${a.count}`));
    // taggen bak alarmen; en beregning uten kjøreverksnavn har den allerede som kilde
    if (a.tag && a.tag !== a.source) msg.append(el('span', 'al-tag', a.tag));
    msg.title = `${a.source}: ${a.text}` + (a.tag ? `\nTag: ${a.tag}` : '');
    const st = el('span', 'al-state', stateText(a));
    const tools = el('span', 'al-tools');
    if (a.codes && a.value != null && actions.openCode) {
      const info = el('button', 'al-info', 'i');
      info.type = 'button';
      info.title = 'The description of this code';
      info.setAttribute('aria-label', 'Description of the code');
      info.addEventListener('click', e => { e.stopPropagation(); actions.openCode(a.codes, a.value, a.text); });
      tools.append(info);
    }
    if (!a.acked && actions.ack) {
      const ack = el('button', 'al-ack', 'Ack');
      ack.type = 'button';
      ack.title = 'Acknowledge: you have seen it';
      ack.addEventListener('click', e => { e.stopPropagation(); actions.ack([a.key]); });
      tools.append(ack);
    }
    r.append(dot, time, msg, st, tools);
    return r;
  }
  H.alarms.row = row;

  // ---------------------------------------------------------------- vinduet
  H.openAlarmList = function (opts) {
    const back = document.activeElement;
    const overlay = el('div', 'mm-overlay');
    const box = el('div', 'mm al');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Alarms');
    const head = el('header', 'mm-head');
    const title = el('h2', null, 'Alarms');
    const acts = el('div', 'mm-actions');
    const ackAll = el('button', 'primary', 'Acknowledge all');
    const closeBtn = el('button', 'ghost', 'Close');
    acts.append(ackAll, closeBtn);
    head.append(title, acts);
    const body = el('div', 'al-body');
    box.append(head, body);
    overlay.append(box);
    document.body.append(overlay);

    function render() {
      const c = H.alarms.counts();
      title.textContent = 'Alarms';
      title.append(el('span', 'al-sum', c.total ? `${c.active} active · ${c.unacked} not acknowledged` : ''));
      ackAll.disabled = !c.unacked;
      body.innerHTML = '';
      if (H.alarms.stale()) body.append(el('div', 'al-stale', 'No connection to the hub: this list may be out of date.'));
      const all = H.alarms.sorted();
      if (!all.length) { body.append(el('p', 'al-empty', 'No alarms. An alarm is listed while it is active, and until someone acknowledges it.')); return; }
      const table = el('div', 'al-list');
      table.setAttribute('role', 'table');
      for (const a of all) table.append(row(a, { ack: opts.ack, openCode: opts.openCode }));
      body.append(table);
    }
    const off = H.alarms.subscribe(render);
    const close = () => { off(); document.removeEventListener('keydown', onKey); overlay.remove(); if (back && back.focus) back.focus(); };
    function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.mm.cp, .mm.codebox')) { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey);
    closeBtn.addEventListener('click', close);
    ackAll.addEventListener('click', () => opts.ack('all'));
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(); });
    render();
    closeBtn.focus();
  };

  // ---------------------------------------------------------------- widgeten
  const SEV = { warning: 1, alarm: 2 };
  H.register('alarms', {
    name: 'Alarm list', hint: 'Active alarms, with Ack', size: [460, 200],
    props: [
      { key: 'label', label: 'Label', type: 'text', default: 'Alarms' },
      { key: 'source', label: 'Source starts with', type: 'text', default: '', hint: 'Leave empty for every alarm. Example: kv_52, the PLC’s and the calculations’ alarms on that vehicle' },
      { key: 'minSeverity', label: 'Show from', type: 'select', options: ['warning', 'alarm'], default: 'warning' },
      H.commonProps.labelSize(), H.commonProps.textSize('Row text size'),
    ],
    tags: () => [],
    mount(root, w, ctx) {
      const p = w.props;
      const b = H.helpers.plate(root, p.label);
      b.classList.add('walarms');
      const src = String(p.source || '').trim();
      const min = SEV[p.minSeverity] || 1;
      const filter = a => (SEV[a.severity] || 0) >= min && (!src || String(a.source).startsWith(src));
      const plate = root.querySelector(':scope > .plate');
      const ackAll = el('button', 'al-ackall', 'Ack all');
      ackAll.type = 'button';
      ackAll.addEventListener('click', e => { e.stopPropagation(); ctx.ack(H.alarms.sorted(filter).filter(a => !a.acked).map(a => a.key)); });
      if (plate) plate.append(ackAll);
      function render() {
        const run = ctx.mode() === 'run';
        const l = H.alarms.sorted(filter);
        b.innerHTML = '';
        ackAll.hidden = !run || !l.some(a => !a.acked);
        if (!l.length) { b.append(el('div', 'al-empty', H.alarms.stale() ? 'No connection to the hub' : 'No alarms')); return; }
        const table = el('div', 'al-list');
        for (const a of l) table.append(row(a, { ack: run ? ctx.ack : null, openCode: run ? (list, value, title) => ctx.openCode(list, value, { title }) : null }));
        b.append(table);
      }
      const off = H.alarms.subscribe(render);
      render();
      return { destroy: off };
    },
  });

  // hvor mange som venter, for topplinjen: { cls, text, title }
  H.alarms.banner = function () {
    const l = H.alarms.sorted();
    const c = H.alarms.counts();
    if (!l.length) return { cls: 'none', text: 'No alarms', title: 'No active or unacknowledged alarms' };
    const top = l[0];
    const unackedAlarm = l.some(a => !a.acked && a.severity === 'alarm');
    const unackedWarn = l.some(a => !a.acked && a.severity === 'warning');
    const cls = unackedAlarm ? 'alarm' : unackedWarn ? 'warning' : 'standing';
    const more = l.length > 1 ? `  +${l.length - 1}` : '';
    return { cls, text: `${top.source}: ${top.text}${more}`, title: `${c.active} active, ${c.unacked} not acknowledged. Click for the list.` };
  };
})();
