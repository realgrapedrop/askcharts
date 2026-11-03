import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as I from '../public/lib/indicators.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
const close = bars.map((b) => b.close);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// Independent, deliberately naive versions of the textbook formulas.
function naiveEma(src, n) {
  const out = []; let prev;
  for (let i = 0; i < src.length; i++) {
    if (i < n - 1) { out.push(NaN); continue; }
    if (i === n - 1) { prev = src.slice(0, n).reduce((a, b) => a + b) / n; out.push(prev); continue; }
    prev = (src[i] - prev) * (2 / (n + 1)) + prev; out.push(prev);
  }
  return out;
}
function naiveRsi(src, n) {
  // Wilder's original method: seed with simple averages, then smooth.
  const out = new Array(src.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = src[i] - src[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= n; l /= n; out[n] = 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = 100 - 100 / (1 + g / l);
  }
  return out;
}
function naiveAtr(b, n) {
  const trs = b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
  const out = new Array(b.length).fill(NaN);
  let a = trs.slice(0, n).reduce((s, v) => s + v) / n; out[n - 1] = a;
  for (let i = n; i < b.length; i++) { a = (a * (n - 1) + trs[i]) / n; out[i] = a; }
  return out;
}

test('SMA matches a plain average', () => {
  const s = I.sma(close, 20);
  for (const i of [19, 100, 999]) assert.ok(near(s[i], close.slice(i - 19, i + 1).reduce((a, b) => a + b) / 20));
  assert.ok(Number.isNaN(s[18]));
});

test('EMA is seeded with the SMA and matches the textbook recursion', () => {
  const a = I.ema(close, 21), b = naiveEma(close, 21);
  for (const i of [20, 21, 500, 999]) assert.ok(near(a[i], b[i]), `i=${i}`);
});

test("RSI matches Wilder's method", () => {
  const a = I.compute('rsi', bars, { length: 14 }).value, b = naiveRsi(close, 14);
  assert.ok(Number.isNaN(a[13]));
  for (const i of [14, 15, 200, 999]) assert.ok(near(a[i], b[i]), `i=${i} ${a[i]} vs ${b[i]}`);
  assert.ok(a.slice(14).every((v) => v >= 0 && v <= 100));
});

test('ATR uses Wilder smoothing', () => {
  const a = I.atr(bars, 14), b = naiveAtr(bars, 14);
  for (const i of [13, 14, 500, 999]) assert.ok(near(a[i], b[i]), `i=${i}`);
});

test('MACD line is fast EMA minus slow EMA, histogram is MACD minus signal', () => {
  const m = I.compute('macd', bars);
  const f = naiveEma(close, 12), s = naiveEma(close, 26);
  assert.ok(near(m.macd[999], f[999] - s[999]));
  assert.ok(near(m.hist[999], m.macd[999] - m.signal[999]));
});

test('Bollinger bands use population standard deviation', () => {
  const r = I.compute('bb', bars, { length: 20, mult: 2 });
  const w = close.slice(980, 1000), mean = w.reduce((a, b) => a + b) / 20;
  const sd = Math.sqrt(w.reduce((a, v) => a + (v - mean) ** 2, 0) / 20);
  assert.ok(near(r.basis[999], mean));
  assert.ok(near(r.upper[999], mean + 2 * sd, 1e-5));
});

test('every built-in indicator runs on real data and returns full-length series', () => {
  // XRPL On chain needs the XRP Ledger store's data as well as bars (its own test is below)
  for (const def of I.INDICATORS.filter((d) => !d.onchain)) {
    const out = I.compute(def.id, bars);
    for (const o of def.outputs) {
      assert.ok(Array.isArray(out[o.key]), `${def.id}.${o.key} missing`);
      assert.ok(out[o.key].length >= bars.length, `${def.id}.${o.key} too short`);
      const last = out[o.key].slice(0, bars.length).filter((v) => Number.isFinite(v));
      assert.ok(last.length > 0, `${def.id}.${o.key} has no values`);
    }
  }
  assert.ok(I.INDICATORS.length >= 50, `only ${I.INDICATORS.length} indicators`);
});

test('supertrend flips direction and stays on the right side of price', () => {
  const r = I.compute('supertrend', bars);
  const flips = r.direction.filter((d, i) => i && d !== r.direction[i - 1] && Number.isFinite(r.direction[i - 1])).length;
  assert.ok(flips > 3);
  bars.forEach((b, i) => { if (Number.isFinite(r.up[i])) assert.ok(r.up[i] <= b.high * 1.0001); });
});

test('XRPL On chain: buckets into bars, share of all, big payments, and no data', () => {
  const T = 1761000000;
  const xb = [0, 1, 2, 3, 4, 5].map((i) => ({ time: T + i * 60, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  // [start, ledgers, txs, failed, batch, money, markets, nfts, accounts, other, xrp, pays, ex_in, ex_out, fees, created, last]
  const cols = ['txs', 'failed', 'batch', 'money', 'markets', 'nfts', 'accounts', 'other', 'xrp', 'pays', 'ex_in', 'ex_out', 'fees', 'created', 'last'];
  const rows = [
    [T - 60, 1, 999, 0, 0, 999, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99], // before the first bar: left out
    [T, 2, 100, 10, 40, 20, 20, 5, 5, 0, 500, 3, 0, 0, 1, 0, 102],
    [T + 60, 1, 50, 5, 20, 10, 10, 3, 2, 0, 200, 1, 0, 0, 1, 0, 117],
    [T + 65, 1, 10, 0, 0, 5, 5, 0, 0, 0, 7, 1, 0, 0, 1, 0, 118], // a second with no bar of its own: the bar before
    [T + 300, 3, 30, 3, 3, 10, 10, 2, 2, 0, 1, 1, 0, 0, 1, 0, 190],
  ];
  const whales = [
    { t: T + 70, xrp: 2e6, dstName: 'Binance' },
    { t: T + 301, xrp: 5e5 },
    { t: T + 302, xrp: 3e6, srcName: 'Kraken' },
    { t: T + 120, xrp: 2e5 }, // under the floor
  ];
  const d = { cols, rows, whales, tf: 60, first: T - 60 };
  const a = I.compute('xrpl_activity', xb, { __onchain: d });
  assert.deepEqual(a.money, [20, 15, NaN, NaN, NaN, 10]);
  assert.deepEqual(a.total, [100, 60, NaN, NaN, NaN, 30]);
  assert.deepEqual(a.batch, [40, 20, NaN, NaN, NaN, 3]);
  // the bar's last ledger: the highest, not a sum; and how many closed in it
  assert.deepEqual(a.ledger, [102, 118, NaN, NaN, NaN, 190]);
  assert.deepEqual(a.ledgers, [2, 2, NaN, NaN, NaN, 3]);
  assert.ok(I.BY_ID.xrpl_activity.outputs.filter((o) => o.legendOnly).length === 2);
  // Per ledger: the bar's counts over its ledgers
  const per = I.compute('xrpl_activity', xb, { show: 'Per ledger (average)', __onchain: d });
  assert.deepEqual(per.money, [10, 7.5, NaN, NaN, NaN, 10 / 3]);
  assert.deepEqual(per.total, [50, 30, NaN, NaN, NaN, 10]);
  assert.deepEqual(per.ledger, a.ledger);
  assert.equal(I.BY_ID.xrpl_activity.precisionOf({ show: 'Per ledger (average)' }), 1);
  assert.equal(I.BY_ID.xrpl_activity.precisionOf({}), 0);
  const share = I.compute('xrpl_activity', xb, { show: 'Share of all (%)', __onchain: d });
  assert.deepEqual(share.money.map((v) => (Number.isFinite(v) ? Math.round(v) : v)), [20, 25, NaN, NaN, NaN, 33]);
  const m = I.compute('xrpl_moved', xb, { __onchain: d, whale: 400000 });
  assert.deepEqual(m.xrp, [500, 207, NaN, NaN, NaN, 1]);
  assert.deepEqual(m.markers.map((x) => [x.time, x.color, x.text]), [
    [T + 60, '#f23645', '2M Binance'],
    [T + 300, '#2962ff', '3.5M \u00d72'],
  ]);
  assert.equal(I.compute('xrpl_moved', xb, { __onchain: d, marks: false }).markers, undefined);
  // off the chart (an alert, a backtest): every value NaN and a reason, never a throw
  const none = I.compute('xrpl_activity', xb);
  assert.ok(none.error && none.money.every(Number.isNaN));
  // the store has nothing for these bars
  assert.match(I.compute('xrpl_moved', xb, { __onchain: { ...d, rows: [] , reason: 'No XRP Ledger data yet.' } }).error, /No XRP Ledger data yet/);
  assert.match(I.compute('xrpl_moved', xb, { __onchain: { ...d, rows: [rows[0]] } }).error, /it starts/);

  // exchange flows: In up, Out below zero, Net the difference; bars with no ledger stay empty
  const fx = { ...d, rows: [[T, 2, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 300, 120, 0, 0, 5], [T + 120, 1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 50, 0, 0, 6]] };
  const x = I.compute('xrpl_exchanges', xb, { __onchain: fx });
  assert.deepEqual(x.in, [300, NaN, 0, NaN, NaN, NaN]);
  assert.deepEqual(x.out, [-120, NaN, -50, NaN, NaN, NaN]);
  assert.deepEqual(x.net, [180, NaN, -50, NaN, NaN, NaN]);
  assert.ok(I.compute('xrpl_exchanges', xb).error);
  // network: new accounts, fees burned in XRP, or the average fee in drops; one shown at a time
  const nx = { ...d, rows: [[T, 2, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2500000, 3, 5], [T + 120, 1, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 500000, 1, 6]] };
  const na = I.compute('xrpl_network', xb, { __onchain: nx });
  assert.deepEqual(na.created, [3, NaN, 1, NaN, NaN, NaN]);
  assert.ok(na.burned.every(Number.isNaN) && na.fee.every(Number.isNaN));
  const nb = I.compute('xrpl_network', xb, { show: 'Fees burned (XRP)', __onchain: nx });
  assert.deepEqual(nb.burned, [2.5, NaN, 0.5, NaN, NaN, NaN]);
  assert.ok(nb.created.every(Number.isNaN));
  const nf = I.compute('xrpl_network', xb, { show: 'Average fee (drops)', __onchain: nx });
  assert.deepEqual(nf.fee, [250000, NaN, 100000, NaN, NaN, NaN]);
  assert.equal(I.BY_ID.xrpl_network.precisionOf({ show: 'Fees burned (XRP)' }), 2);
  assert.equal(I.BY_ID.xrpl_network.precisionOf({}), 0);
  assert.equal(I.BY_ID.xrpl_network.partialNewest({ show: 'Average fee (drops)' }), false);
  assert.ok(I.compute('xrpl_network', xb).error);
  // DEX: [start, ledgers, got, paid, amm_got, amm_paid, bridge, fills, swaps, counted, last]
  const dc = ['dex_got', 'dex_paid', 'amm_got', 'amm_paid', 'dex_bridge', 'dex_fills', 'amm_swaps', 'dex_n', 'last'];
  const dx = { cols: dc, tf: 60, first: T - 60, whales: [], rows: [
    [T, 4, 10, 6, 3, 1, 2, 5, 2, 4, 9], // counted whole
    [T + 60, 3, 0, 0, 0, 0, 0, 0, 0, 0, 12], // stored before counting began
    [T + 120, 4, 5, 1, 0, 1, 0.5, 2, 1, 2, 16], // counting began inside it
  ] };
  const db1 = I.compute('xrpl_dex', xb, { __onchain: dx });
  assert.deepEqual(db1.bought, [8, NaN, 4.5, NaN, NaN, NaN]);
  assert.deepEqual(db1.sold, [-4, NaN, -0.5, NaN, NaN, NaN]);
  assert.deepEqual(db1.net, [4, NaN, 4, NaN, NaN, NaN]);
  assert.deepEqual(db1.barNote, [null, null, 'counting began in this bar', null, null, null]);
  const db2 = I.compute('xrpl_dex', xb, { show: 'Order book and AMM', __onchain: dx });
  assert.deepEqual(db2.book, [12, NaN, 5, NaN, NaN, NaN]);
  assert.deepEqual(db2.amm, [4, NaN, 1, NaN, NaN, NaN]);
  assert.ok(db2.bought.every(Number.isNaN));
  assert.deepEqual(I.compute('xrpl_dex', xb, { show: 'Bridged', __onchain: dx }).bridged, [2, NaN, 0.5, NaN, NaN, NaN]);
  assert.deepEqual(I.BY_ID.xrpl_dex.outputsFor({}), ['bought', 'sold', 'net']);
  assert.deepEqual(I.BY_ID.xrpl_dex.outputsFor({ show: 'Bridged' }), ['bridged']);
  // nothing counted yet: says so
  assert.match(I.compute('xrpl_dex', xb, { __onchain: { ...dx, rows: [dx.rows[1]] } }).error, /No DEX numbers/);
  // an outage: ledgers 6 to 9 never stored. The bar after it breaks the line, the empty bars inside it say
  // so, and the bars at its edges and a bar with a hole of its own are partial; a seconds chart's empty bar
  // (no jump) is neither
  const gc = [...cols, 'first'];
  const g = (start, n, first, last) => [start, n, n, 0, 0, n, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, last, first];
  const gd = { ...d, cols: gc, rows: [g(T, 3, 1, 3), g(T + 60, 2, 4, 5), g(T + 240, 1, 10, 10), g(T + 300, 2, 11, 13)] };
  const ga = I.compute('xrpl_activity', xb, { __onchain: gd });
  assert.deepEqual(ga.gaps.before, [false, false, false, false, true, false]);
  assert.deepEqual(ga.gaps.outage, [false, false, true, true, false, false]);
  assert.deepEqual(ga.gaps.partial, [false, true, false, false, true, true]);
  // on a seconds chart the edges aren't marked: its bars hold a ledger or two, and empty ones are normal
  assert.deepEqual(I.compute('xrpl_activity', xb, { __onchain: { ...gd, tf: 5 } }).gaps.partial, [false, false, false, false, false, true]);
  assert.equal(a.gaps, undefined, 'an older store reader sends no first ledger: no gaps');
  const quiet = I.compute('xrpl_activity', xb, { __onchain: { ...gd, rows: [g(T, 3, 1, 3), g(T + 180, 1, 4, 4)] } });
  assert.deepEqual(quiet.gaps.before, [false, false, false, false, false, false]);
  assert.deepEqual(quiet.gaps.outage, [false, false, false, false, false, false]);
});

test('custom indicators can be registered and computed', () => {
  I.registerIndicator({ id: 'custom:test', name: 'Test', calc: (b, p, ta) => ({ value: ta.sma(ta.source(b), 3) }) });
  const v = I.compute('custom:test', bars).value;
  assert.ok(near(v[2], (close[0] + close[1] + close[2]) / 3));
});

// ---------- custom indicator format (docs/custom-indicators.md) ----------
test('the template and the bundled example follow the custom indicator format', async () => {
  const tpl = (await import('../docs/indicator-template.js')).default;
  assert.deepEqual(I.indicatorProblems(tpl), []);
  const ex = (await import('../custom/ema-ribbon-squeeze.js')).default;
  assert.deepEqual(I.indicatorProblems(ex), []);
});

test('the alert example indicator follows the format and an alert on its output fires on its signal bars', async () => {
  const { conditionFn } = await import('../public/lib/backtest.js');
  const ex = (await import('../docs/alert-example.js')).default;
  assert.deepEqual(I.indicatorProblems(ex), []);
  I.registerIndicator({ ...ex, id: 'custom:alert-example' });
  const out = I.compute('custom:alert-example', bars);
  const fired = conditionFn(bars, { sig: { id: 'custom:alert-example', params: {} } })({ left: 'sig.buy', op: '>', right: 0 });
  const signalBars = out.buy.flatMap((v, i) => (v === 1 ? [i] : []));
  assert.ok(signalBars.length > 0, 'the fixture has at least one buy signal');
  assert.deepEqual(bars.flatMap((_, i) => (fired(i) ? [i] : [])), signalBars);
});

test('a malformed custom indicator is refused, with each problem named', () => {
  const good = {
    name: 'Ok',
    inputs: [{ key: 'length', type: 'int', default: 14 }],
    outputs: [{ key: 'value', kind: 'line', color: '#2962ff' }],
    calc: (bars, p, ta) => ({ value: ta.sma(ta.source(bars), p.length) }),
  };
  assert.deepEqual(I.indicatorProblems(good), []);
  const cases = [
    [{ ...good, calc: undefined }, /needs a `calc\(bars, p, ta\)` function/],
    [{ ...good, name: '' }, /needs a `name`/],
    [{ ...good, inputs: [{ key: 'length', type: 'int', default: 2.5 }] }, /input "length": an int input needs a whole-number default/],
    [{ ...good, inputs: [{ key: 'ma', type: 'select', options: ['SMA'], default: 'EMA' }] }, /input "ma": its default must be one of its options/],
    [{ ...good, inputs: [{ key: 'src', type: 'source', default: 'close' }] }, /a source input's key must be "source"/],
    [{ ...good, inputs: [{ key: 'on', type: 'checkbox', default: true }] }, /`type` must be one of int, float, select, source, time, bool, color, text, textarea, timeframe/],
    [{ ...good, inputs: [{ key: 'on', type: 'bool', default: 'yes' }] }, /input "on": a bool input needs true or false as its default/],
    [{ ...good, outputs: [{ key: 'value', kind: 'area' }] }, /`kind` must be "line" or "histogram"/],
    [{ ...good, outputs: [{ key: 'a' }, { key: 'a' }], calc: (b) => ({ a: b.map(() => 1) }) }, /output "a": the key is used twice/],
    [{ ...good, calc: (bars) => ({ value: bars.slice(1).map((b) => b.close) }) }, /output "value": calc\(\) returned 299 values, but there are 300 bars/],
    [{ ...good, calc: () => ({}) }, /output "value": calc\(\) returned no list for it/],
    [{ ...good, calc: () => { throw new Error('boom'); } }, /calc\(\) stopped with an error on test bars: boom/],
    [{ ...good, calc: (bars) => ({ value: bars.map((b) => b.close), markers: [{ time: bars[0].time, position: 'top', shape: 'arrowUp' }] }) }, /markers: each needs/],
    [{ ...good, levels: ['70'] }, /`levels` must be a list of numbers/],
  ];
  for (const [def, re] of cases) assert.match(I.indicatorProblems(def).join('\n'), re);
  assert.throws(
    () => I.registerIndicator({ ...good, id: 'custom:test-broken', calc: () => ({}) }),
    /doesn't follow the format \(docs\/custom-indicators\.md\):\n- output "value"/,
  );
  assert.equal(I.BY_ID['custom:test-broken'], undefined, 'a refused indicator is not registered');
  assert.equal(I.registerIndicator({ ...good, id: 'custom:test-ok' }).id, 'custom:test-ok');
});
