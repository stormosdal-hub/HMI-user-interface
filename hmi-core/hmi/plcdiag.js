/*
 * PLC diagnostics-widgeten: PLS-ens diagnosebuffer, slik adapters/plcdiag-adapter.js leser den fra
 * PLS-ens web-server. Den viser hvorfor PLS-en mener noe er galt: en modul som er borte, en
 * syklustid som er overskredet, hvorfor CPU-en gikk i STOP.
 *
 * Datasettet (ctx.dataset, vanligvis pls.diagbuffer) er
 *   { web, busy, reason, error, fetchedAt, fetchReason, plcCount, kept,
 *     entries: [{ key, no, eventId, ms, incoming, text, long, kind }] }   nyeste først
 * Én rad per oppføring: plassen i PLS-en (– når PLS-en har skjøvet den ut og bare Pi-en har den),
 * tid og dato i nettleserens tidssone, kommer/går og hendelsen. Et klikk på raden viser den lange
 * teksten, slik PLS-en har den (på engelsk). Refresh ber tjenesten hente bufferen på nytt.
 */
(function () {
  'use strict';
  const H = window.HMI;
  const { el } = H.helpers;

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const clockOf = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const exact = ms => { const d = new Date(ms); return `${dayOf(d)} ${clockOf(d)}.${pad(d.getMilliseconds(), 3)}`; };
  const utc = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  // per widget, mens siden er åpen: radene som er åpne, nøklene som er vist, og når en ny dukket
  // opp (den blinker). Widgeten monteres på nytt når du bytter skjermbilde eller modus; dette blir stående.
  const memory = new Map();   // widget-id -> { open: Set, seen: Set | null, fresh: Map(nøkkel -> tid) }
  const FLASH_MS = 1600;      // som dg-flash i style.css

  H.register('plcdiag', {
    name: 'PLC diagnostics', hint: 'The PLC’s diagnostic buffer', size: [760, 420],
    props: [
      { key: 'label', label: 'Label', type: 'text', default: 'PLC diagnostic buffer' },
      { key: 'dataset', label: 'Dataset', type: 'dataset', default: '${pls}.diagbuffer',
        hint: 'The name plcdiag-adapter.js gives it: the tag prefix with .diagbuffer. ${pls} is the project variable' },
      H.commonProps.labelSize(), H.commonProps.textSize('Row text size'),
    ],
    tags: () => [],
    mount(root, w, ctx) {
      const p = w.props;
      const name = String(p.dataset || '').trim();
      const b = H.helpers.plate(root, p.label);
      b.classList.add('wdiag');
      if (!memory.has(w.id)) memory.set(w.id, { open: new Set(), seen: null, fresh: new Map() });
      const mem = memory.get(w.id);

      const top = el('div', 'dg-top');
      const sum = el('div', 'dg-sum');
      const btn = el('button', 'dg-refresh', 'Refresh');
      btn.type = 'button';
      btn.title = 'Fetch the diagnostic buffer from the PLC’s web server again';
      top.append(sum, btn);
      const list = el('div', 'dg-list');
      list.setAttribute('role', 'table');
      b.append(top, list);

      let rec = null;
      const data = () => (rec && rec.data) || null;

      function summary() {
        const d = data();
        sum.textContent = '';
        sum.className = 'dg-sum';
        if (!name) { sum.textContent = 'Choose a dataset in Edit mode'; return; }
        if (!rec) {
          sum.textContent = `Waiting for ${name} from the PLC diagnostics service (kjoreverk@plcdiag-adapter)`;
          return;
        }
        if (rec.stale) sum.append(el('span', 'dg-warn', 'No connection to the hub · '));
        else if (!rec.online) sum.append(el('span', 'dg-warn', `${rec.owner} is not running: this is what it sent last · `));
        let text;
        if (d.busy) text = `Fetching from ${d.web} (${d.reason})…`;
        else if (d.fetchedAt) text = `Fetched ${ago(Date.now() - d.fetchedAt)}${d.fetchReason ? ` (${d.fetchReason})` : ''}`;
        else text = 'Not fetched yet';
        // antallet i PLS-en er bare kjent etter en henting som har lyktes
        text += (d.plcCount ? ` · ${d.plcCount} in the PLC` : '') + ` · ${d.kept} kept`;
        sum.append(document.createTextNode(text));
        if (d.error) sum.append(el('span', 'dg-bad', ` · Couldn’t fetch: ${d.error}`));
        sum.title = `From ${d.web}, read by ${rec.owner}. Times are in this browser’s time zone.` +
          (d.fetchedAt ? `\nLast fetched ${new Date(d.fetchedAt).toLocaleString()}` : '');
      }

      function refreshButton() {
        const d = data();
        const usable = !!(rec && rec.online && !rec.stale);
        btn.disabled = !usable || !!(d && d.busy);
        btn.textContent = d && d.busy ? 'Fetching…' : 'Refresh';
      }

      function details(e) {
        const box = el('div', 'dg-long');
        const meta = el('span', 'dg-meta', `Event ID 16#${e.eventId} · ${exact(e.ms)} (UTC ${utc(e.ms)})`);
        if (!e.no) meta.append(document.createTextNode(' · No longer in the PLC: the Pi has kept it until the service restarts'));
        box.append(meta);
        box.append(document.createTextNode(
          e.long !== null ? e.long || '(no text)'
            : e.no ? 'Fetching the text…' : 'The text wasn’t fetched before the PLC pushed the entry out.'));
        return box;
      }

      function toggle(key) {
        if (mem.open.has(key)) mem.open.delete(key); else mem.open.add(key);
        rows();
      }

      function rows() {
        const d = data();
        const scroll = list.scrollTop;
        list.textContent = '';
        if (!d || !d.entries.length) {
          list.append(el('div', 'dg-empty', !d ? 'No entries yet' : d.busy ? 'Fetching…' : 'No entries'));
          return;
        }
        const head = el('div', 'dg-row dg-head');
        head.setAttribute('role', 'row');
        for (const h of ['#', 'Time', 'Date', 'Status', 'Event']) head.append(el('span', null, h));
        list.append(head);
        const now = performance.now();
        for (const [k, at] of mem.fresh) if (now - at > FLASH_MS) mem.fresh.delete(k);
        for (const e of d.entries) {
          const t = new Date(e.ms);
          const open = mem.open.has(e.key);
          if (mem.seen && !mem.seen.has(e.key)) mem.fresh.set(e.key, now);
          const r = el('div', `dg-row ${e.incoming ? 'in' : 'out'}${e.kind ? ' ' + e.kind : ''}${!e.no ? ' gone' : ''}` +
                              `${open ? ' open' : ''}${mem.fresh.has(e.key) ? ' new' : ''}`);
          // raden bygges på nytt når den lange teksten kommer: blinket fortsetter der det var
          if (mem.fresh.has(e.key)) r.style.animationDelay = `-${Math.round(now - mem.fresh.get(e.key))}ms`;
          r.setAttribute('role', 'row');
          r.tabIndex = 0;
          r.setAttribute('aria-expanded', open ? 'true' : 'false');
          r.title = (e.kind === 'error' ? 'Error' : e.kind === 'warning' ? 'Warning' : 'Information') +
            (e.no ? ` · entry ${e.no} in the PLC` : ' · no longer in the PLC; the Pi has kept it');
          r.append(el('span', 'dg-no', e.no ? String(e.no) : '–'), el('span', 'dg-t', clockOf(t)), el('span', 'dg-t', dayOf(t)),
                   el('span', 'dg-st', e.incoming ? 'Incoming' : 'Outgoing'), el('span', 'dg-ev', e.text));
          if (open) r.append(details(e));
          // et klikk i den åpne teksten lukker ikke raden, så teksten kan markeres og kopieres
          r.addEventListener('click', ev => { if (!ev.target.closest('.dg-long')) toggle(e.key); });
          r.addEventListener('keydown', ev => {
            if (ev.target === r && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggle(e.key); }
          });
          list.append(r);
        }
        list.scrollTop = scroll;
        mem.seen = new Set(d.entries.map(e => e.key));
        // åpne rader som ikke finnes lenger, glemmes
        for (const k of [...mem.open]) if (!mem.seen.has(k)) mem.open.delete(k);
      }

      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (ctx.mode() !== 'run' || !name) return;
        if (ctx.datasetAction(name, 'refresh')) { btn.disabled = true; btn.textContent = 'Fetching…'; }
      });

      const off = name ? ctx.dataset(name, r => {
        const before = rec && rec.data;
        rec = r;
        summary();
        refreshButton();
        // bare statusen endret (forbindelsen): radene er de samme
        if (!rec || !before || rec.data !== before) rows();
      }) : () => {};
      if (!name) { summary(); refreshButton(); rows(); }
      const tick = setInterval(summary, 5000);   // "Fetched 12 s ago"
      return { destroy() { off(); clearInterval(tick); } };
    },
  });
})();
