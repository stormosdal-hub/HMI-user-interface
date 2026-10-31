'use strict';
/*
 * lib/calc.js — et lite, trygt formelspråk for beregnede tagger. Et bibliotek for hub.js, ikke et
 * program: det kjøres ikke alene.
 *
 * Formler parses til et tre og regnes ut ved å gå gjennom treet. Ingenting sendes
 * noen gang til JavaScripts eval/Function, så en formel kan bare regne på
 * tagverdier — en prosjektfil kan ikke kjøre kode på maskinen som kjører huben.
 *
 *   tall         1   2.5   .5   1e3
 *   tagger       pls.reals_0   calc.kv_power_w   [odd-name.with-dashes]
 *   konstanter   pi  e  true  false
 *   operatorer   + - * / % ^   == != < <= > >=   && || !   cond ? a : b
 *   funksjoner   abs sqrt pow exp log log10 sin cos tan asin acos atan atan2
 *                floor ceil round(x, digits) sign min max avg sum hypot
 *                clamp(x, lo, hi)  if(cond, a, b)  count(a, b, ...)  between(x, lo, hi)
 *   over tid     changes(x, s)  rate(x, s)  delta(x, s)  held(cond, s)  stretch(cond, s)
 *                avgOver(x, s)  minOver(x, s)  maxOver(x, s)      (s = sekunder, et tall)
 *
 * Boolske verdier teller som 1/0. Trigonometriske funksjoner bruker radianer.
 *
 * Tidsfunksjoner husker inngangen sin. Når inngangen er en tag, gir huben dem hver endring
 * (feed), så ingenting går tapt mellom utregningene; ellers leser de inngangen hver gang
 * formelen regnes ut. reset() glemmer alt; brukes når inngangene blir foreldet (stale), så
 * hoppet når data kommer tilbake ikke blir tatt for en ekte endring.
 */

const FUNCS = {
  abs: [1, 1, Math.abs], sqrt: [1, 1, Math.sqrt], exp: [1, 1, Math.exp],
  log: [1, 1, Math.log], log10: [1, 1, Math.log10], sign: [1, 1, Math.sign],
  sin: [1, 1, Math.sin], cos: [1, 1, Math.cos], tan: [1, 1, Math.tan],
  asin: [1, 1, Math.asin], acos: [1, 1, Math.acos], atan: [1, 1, Math.atan],
  floor: [1, 1, Math.floor], ceil: [1, 1, Math.ceil],
  pow: [2, 2, Math.pow], atan2: [2, 2, Math.atan2],
  round: [1, 2, (x, d = 0) => { const f = 10 ** Math.max(0, Math.min(12, Math.round(d))); return Math.round(x * f) / f; }],
  min: [1, Infinity, Math.min], max: [1, Infinity, Math.max], hypot: [1, Infinity, Math.hypot],
  sum: [1, Infinity, (...a) => a.reduce((s, x) => s + x, 0)],
  avg: [1, Infinity, (...a) => a.reduce((s, x) => s + x, 0) / a.length],
  clamp: [3, 3, (x, lo, hi) => Math.min(hi, Math.max(lo, x))],
  if: [3, 3, null],   // regnes ut først når det trengs, se nedenfor
  count: [1, Infinity, (...a) => a.filter(x => x && !Number.isNaN(x)).length],
  between: [3, 3, (x, lo, hi) => (x >= lo && x <= hi ? 1 : 0)],
};
// funksjoner over tid: (inngang, sekunder)
const TIME = {
  changes: 'how many times x changed in the last s seconds',
  rate: 'how fast x changes, per second, over the last s seconds',
  delta: 'how much x changed over the last s seconds',
  held: 'true once cond has been true for s seconds without a break',
  stretch: 'true while cond is true and for s seconds after',
  avgOver: 'time-weighted average of x over the last s seconds',
  minOver: 'lowest x in the last s seconds',
  maxOver: 'highest x in the last s seconds',
};
const MAX_SAMPLES = 20000;
const CONSTS = { pi: Math.PI, e: Math.E, true: 1, false: 0 };

class FormulaError extends Error {
  constructor(message, pos) { super(message); this.pos = pos; }
}

// ---------------------------------------------------------------- tokener
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/))) { out.push({ t: 'num', v: parseFloat(m[0]), pos: i }); i += m[0].length; continue; }
    if ((m = rest.match(/^[A-Za-z_]\w*(?:\.\w+)*/))) { out.push({ t: 'name', v: m[0], pos: i }); i += m[0].length; continue; }
    if (c === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) throw new FormulaError('missing ] after tag name', i);
      const name = src.slice(i + 1, end).trim();
      if (!name) throw new FormulaError('empty [ ]', i);
      out.push({ t: 'tag', v: name, pos: i });
      i = end + 1;
      continue;
    }
    if (c === '$') throw new FormulaError(`unknown variable ${(rest.match(/^\$\{?\w*\}?/) || [c])[0]}`, i);
    const two = src.substr(i, 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two, pos: i }); i += 2; continue; }
    if ('+-*/%^()<>!?:,'.includes(c)) { out.push({ t: 'op', v: c, pos: i }); i++; continue; }
    if (c === '=') throw new FormulaError('use == to compare', i);
    throw new FormulaError(`unexpected character "${c}"`, i);
  }
  out.push({ t: 'end', pos: src.length });
  return out;
}

// ---------------------------------------------------------------- parser (precedence climbing, skrevet for hånd)
function parse(src) {
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k];
  const isOp = v => peek().t === 'op' && peek().v === v;
  const expect = v => {
    if (!isOp(v)) throw new FormulaError(`expected "${v}"`, peek().pos);
    k++;
  };
  const deps = new Set();
  const timeNodes = [];   // i postorden: en indre tidsfunksjon kommer før den som omslutter den

  function ternary() {
    const c = or();
    if (!isOp('?')) return c;
    k++;
    const a = ternary();
    expect(':');
    return { k: 'tern', c, a, b: ternary() };
  }
  const leftAssoc = (next, ops) => () => {
    let a = next();
    while (peek().t === 'op' && ops.includes(peek().v)) { const op = toks[k++].v; a = { k: 'bin', op, a, b: next() }; }
    return a;
  };
  function unary() {
    if (peek().t === 'op' && ['-', '+', '!'].includes(peek().v)) { const op = toks[k++].v; return { k: 'un', op, a: unary() }; }
    return power();
  }
  function power() {
    const a = primary();
    if (isOp('^')) { k++; return { k: 'bin', op: '^', a, b: unary() }; }   // høyreassosiativ, 2^-1 virker
    return a;
  }
  function primary() {
    const t = peek();
    if (t.t === 'num') { k++; return { k: 'num', v: t.v }; }
    if (t.t === 'tag') { k++; deps.add(t.v); return { k: 'tag', name: t.v }; }
    if (t.t === 'name') {
      k++;
      if (isOp('(') && TIME[t.v]) {
        k++;
        const args = [];
        if (!isOp(')')) { do { args.push(ternary()); } while (isOp(',') && ++k); }
        expect(')');
        if (args.length !== 2) throw new FormulaError(`${t.v}() takes an input and a time in seconds, like ${t.v}(x, 2)`, t.pos);
        const w = args[1];
        if (w.k !== 'num' || !(w.v >= 0.05 && w.v <= 3600)) throw new FormulaError(`${t.v}(): the time must be a number of seconds from 0.05 to 3600`, t.pos);
        const node = { k: 'time', fn: t.v, arg: args[0], win: w.v * 1000, tagArg: args[0].k === 'tag' ? args[0].name : null, st: fresh() };
        timeNodes.push(node);
        return node;
      }
      if (isOp('(')) {
        const fn = FUNCS[t.v];
        if (!fn) throw new FormulaError(`unknown function ${t.v}()`, t.pos);
        k++;
        const args = [];
        if (!isOp(')')) { do { args.push(ternary()); } while (isOp(',') && ++k); }
        expect(')');
        if (args.length < fn[0] || args.length > fn[1]) {
          const want = fn[0] === fn[1] ? fn[0] : fn[1] === Infinity ? `at least ${fn[0]}` : `${fn[0]}\u2013${fn[1]}`;
          throw new FormulaError(`${t.v}() takes ${want} argument${fn[0] === 1 && (fn[1] === 1 || fn[1] === Infinity) ? '' : 's'}`, t.pos);
        }
        return { k: 'call', fn: t.v, args };
      }
      if (!t.v.includes('.') && t.v in CONSTS) return { k: 'num', v: CONSTS[t.v] };
      if (!t.v.includes('.')) throw new FormulaError(`"${t.v}" is not a tag (tags look like device.name) or a known constant`, t.pos);
      deps.add(t.v);
      return { k: 'tag', name: t.v };
    }
    if (isOp('(')) { k++; const e = ternary(); expect(')'); return e; }
    if (t.t === 'end') throw new FormulaError('formula ends too early', t.pos);
    throw new FormulaError(`unexpected "${t.v}"`, t.pos);
  }
  const mul = leftAssoc(unary, ['*', '/', '%']);
  const add = leftAssoc(mul, ['+', '-']);
  const cmp = leftAssoc(add, ['==', '!=', '<', '<=', '>', '>=']);
  const and = leftAssoc(cmp, ['&&']);
  const or = leftAssoc(and, ['||']);

  if (peek().t === 'end') throw new FormulaError('formula is empty', 0);
  const ast = ternary();
  if (peek().t !== 'end') throw new FormulaError(`unexpected "${peek().v}"`, peek().pos);
  return { ast, deps: [...deps], timeNodes };
}

// ---------------------------------------------------------------- minne for tidsfunksjonene
function fresh() { return { t: [], v: [], changes: [], since: null, lastTrue: -Infinity }; }
const truthy = v => !!v && !Number.isNaN(v);

// én avlesning av inngangen; verdier holdes som trinn (bare endringer lagres)
function sample(n, v, ts) {
  if (!Number.isFinite(v)) return;
  const st = n.st;
  if (n.fn === 'held') return;                          // held() jobber ut fra utregningene
  if (truthy(v)) st.lastTrue = Math.max(st.lastTrue, ts);
  if (n.fn === 'stretch') return;
  const last = st.v.length ? st.v[st.v.length - 1] : undefined;
  if (last === undefined || v !== last) {
    if (last !== undefined) st.changes.push(ts);
    st.t.push(ts); st.v.push(v);
  }
}
function trim(st, now, W) {
  const from = now - W;
  let drop = 0;                                         // behold siste avlesning før vinduet: den er verdien ved starten av det
  while (drop < st.t.length - 1 && st.t[drop + 1] <= from) drop++;
  if (st.t.length - drop > MAX_SAMPLES) drop = st.t.length - MAX_SAMPLES;
  if (drop) { st.t.splice(0, drop); st.v.splice(0, drop); }
  let c = 0;
  while (c < st.changes.length && st.changes[c] <= from) c++;
  if (st.changes.length - c > MAX_SAMPLES) c = st.changes.length - MAX_SAMPLES;
  if (c) st.changes.splice(0, c);
}
// regn ut resultatet til en tidsfunksjon ved `now`, gitt inngangens nåværende verdi
function step(n, v, now) {
  const st = n.st, W = n.win;
  if (n.fn === 'held') {
    if (truthy(v)) { if (st.since === null) st.since = now; n.result = now - st.since >= W ? 1 : 0; }
    else { st.since = null; n.result = 0; }
    return;
  }
  if (n.fn === 'stretch') {
    if (truthy(v)) st.lastTrue = now;
    n.result = truthy(v) || now - st.lastTrue < W ? 1 : 0;
    return;
  }
  sample(n, v, now);
  trim(st, now, W);
  if (!st.v.length) { n.result = NaN; return; }
  const cur = st.v[st.v.length - 1], t0 = st.t[0], v0 = st.v[0];
  switch (n.fn) {
    case 'changes': n.result = st.changes.length; break;
    case 'delta': n.result = cur - v0; break;
    case 'rate': { const span = Math.min(W, now - t0); n.result = span > 0 ? (cur - v0) / (span / 1000) : 0; break; }
    case 'minOver': { let m = Infinity; for (const x of st.v) if (x < m) m = x; n.result = m; break; }
    case 'maxOver': { let m = -Infinity; for (const x of st.v) if (x > m) m = x; n.result = m; break; }
    case 'avgOver': {
      const from = Math.max(now - W, t0), span = now - from;
      if (span <= 0) { n.result = cur; break; }
      let acc = 0;
      for (let i = 0; i < st.t.length; i++) {
        const a = Math.max(st.t[i], from), b = i + 1 < st.t.length ? st.t[i + 1] : now;
        if (b > a) acc += st.v[i] * (b - a);
      }
      n.result = acc / span;
      break;
    }
  }
}

// ---------------------------------------------------------------- utregning
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return NaN;
}

function run(n, get) {
  switch (n.k) {
    case 'num': return n.v;
    case 'tag': return get(n.name);
    case 'tern': return run(n.c, get) ? run(n.a, get) : run(n.b, get);
    case 'un': {
      const a = run(n.a, get);
      return n.op === '-' ? -a : n.op === '!' ? (a ? 0 : 1) : a;
    }
    case 'bin': {
      if (n.op === '&&') return run(n.a, get) && run(n.b, get) ? 1 : 0;
      if (n.op === '||') return run(n.a, get) || run(n.b, get) ? 1 : 0;
      const a = run(n.a, get), b = run(n.b, get);
      switch (n.op) {
        case '+': return a + b;   case '-': return a - b;
        case '*': return a * b;   case '/': return a / b;
        case '%': return a % b;   case '^': return a ** b;
        case '==': return a === b ? 1 : 0;  case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;     case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;     case '>=': return a >= b ? 1 : 0;
      }
      break;
    }
    case 'time': return n.result === undefined ? NaN : n.result;   // regnet ut før hovedgjennomgangen
    case 'call':
      if (n.fn === 'if') return run(n.args[0], get) ? run(n.args[1], get) : run(n.args[2], get);
      return FUNCS[n.fn][2](...n.args.map(a => run(a, get)));
  }
  throw new Error('bad formula tree');
}

// compile(formula) -> { deps, timed, timeTags, evaluate(getValue, now), feed(tag, value, ts), reset() }
function compile(formula) {
  const { ast, deps, timeNodes } = parse(String(formula == null ? '' : formula));
  return {
    deps,
    timed: timeNodes.length > 0,
    timeTags: [...new Set(timeNodes.map(n => n.tagArg).filter(Boolean))],
    evaluate(get, now = Date.now()) {
      const g = name => toNumber(get(name));
      // tidsfunksjonene først, indre før ytre, slik at hver av dem holdes oppdatert
      // også inne i en gren av if() som hovedgjennomgangen ikke tar
      for (const n of timeNodes) step(n, run(n.arg, g), now);
      return run(ast, g);
    },
    feed(tag, value, ts) { for (const n of timeNodes) if (n.tagArg === tag) sample(n, toNumber(value), ts); },
    reset() { for (const n of timeNodes) { n.st = fresh(); n.result = undefined; } },
  };
}

// ${var}-plassholdere, samme regel som i HMI-en
function resolveVars(text, vars) {
  return String(text == null ? '' : text).replace(/\$\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

module.exports = { compile, resolveVars, toNumber, FormulaError, FUNCTIONS: Object.keys(FUNCS), TIME_FUNCTIONS: TIME, CONSTANTS: Object.keys(CONSTS) };
