import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkScript, sweepScript, scanSymbol, profileBars, HOLDOUT } from '../lib/pinework.js';
import { TEMPLATES, templateCode } from '../public/lib/pinetemplates.js';
import { compilePine, runPine } from '../public/lib/pine.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
const ctx = { symbol: 'BINANCE:BTCUSDT', tf: '1D' };
const MA = templateCode(TEMPLATES[0], { symbol: ctx.symbol });
// the first bar of the last 30%, as the checks split them
const splitAt = bars[Math.floor(bars.length * (1 - HOLDOUT))].time;

test('check: a strategy on bars gives the whole run, the first 70% and the last 30%', () => {
  const r = checkScript({ code: MA, bars, ctx });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'strategy');
  assert.deepEqual(r.inputs.map((x) => x.label), ['Fast average length', 'Slow average length', 'Also trade short']);
  const s = r.strategy;
  assert.equal(s.train.to, splitAt);
  assert.equal(s.test.from, splitAt);
  assert.equal(s.train.trades + s.test.trades, s.closedTrades);
  assert.equal(s.tinyOrder, false);
  assert.ok(s.fees.includes('0.1'));
  // how long a typical trade was held: the median, in hours
  const r2 = (v) => Number(v.toFixed(1));
  const all = runPine(compilePine(MA), bars, {}, ctx).strategy.trades.filter((t) => t.exitTime > s.test.from);
  const held = all.map((t) => t.exitTime - t.entryTime).sort((a, b) => a - b);
  assert.equal(s.test.holdHours, r2(held[Math.floor(held.length / 2)] / 3600));
  assert.ok(s.whole.holdHours >= 24, 'a daily strategy holds for days');
});

test('check: errors come back with their line; an indicator gives its plots; a tiny order is flagged', () => {
  const bad = checkScript({ code: '//@version=6\nstrategy("x")\nplot(foo)', bars, ctx });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.line, 3);
  const ind = checkScript({ code: '//@version=6\nindicator("RSI")\nplot(ta.rsi(close, 14), "RSI")', bars, ctx });
  assert.equal(ind.ok, true);
  assert.equal(ind.plots[0].title, 'RSI');
  assert.ok(ind.plots[0].last > 0 && ind.plots[0].last < 100);
  const tiny = checkScript({ code: MA, bars, ctx, props: { default_qty_type: 'fixed', default_qty_value: 0.001 } });
  assert.equal(tiny.strategy.tinyOrder, true);
});

test('sweep: picked on the first 70% only; a version that only trades in the last 30% is never picked', async () => {
  // mode 2 trades only in the last 30%, where buying and holding from its first bar does best of all
  const code = `//@version=6
strategy("Planted", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
mode = input.int(1, "Mode")
len = input.int(20, "Length")
late = time >= ${splitAt * 1000}
if mode == 1 and ta.crossover(close, ta.sma(close, len))
    strategy.entry("L", strategy.long)
if mode == 1 and ta.crossunder(close, ta.sma(close, len))
    strategy.close("L")
if mode == 2 and late and strategy.position_size == 0
    strategy.entry("L", strategy.long)`;
  const r = await sweepScript({ code, bars, ctx, sweep: { in1: [1, 2], in2: [10, 20, 30] } });
  assert.equal(r.ok, true);
  assert.equal(r.tried, 6);
  assert.equal(r.picked.inputs.in1, 1);
  // only the pick's last 30% comes back
  assert.ok(r.best.every((x) => !('test' in x)));
  assert.ok(r.picked.test.from === splitAt);
  assert.ok(r.checks.of >= 4);
});

test('sweep: no version with enough trades on the first 70% means no pick, said plainly', async () => {
  const code = `//@version=6
strategy("Never", initial_capital=10000)
len = input.int(20, "Length")
if time >= ${splitAt * 1000} and ta.crossover(close, ta.sma(close, len))
    strategy.entry("L", strategy.long)`;
  const r = await sweepScript({ code, bars, ctx, sweep: { in1: [10, 20] } });
  assert.equal(r.picked, null);
  assert.match(r.note, /No version closed 3 trades/);
});

test('scan: every template on each interval, picked on the first 70%, ranked on the last 30%', () => {
  const r = scanSymbol({ barsByTf: { '1D': bars }, symbol: ctx.symbol, fee: 0.1 });
  assert.equal(r.results.length, 8);
  assert.equal(r.trials, 72);
  assert.ok(r.results.every((x) => x.tf === '1D'));
  const ranked = r.results.filter((x) => x.test?.sharpe != null).map((x) => x.test.sharpe);
  assert.deepEqual(ranked, [...ranked].sort((a, b) => b - a));
  assert.equal(r.intervals[0].bars.count, bars.length);
});

test('scan with shorts: the three trend kinds go short too, the other five stay long only', () => {
  const long = scanSymbol({ barsByTf: { '1D': bars }, symbol: ctx.symbol, fee: 0.1 });
  const both = scanSymbol({ barsByTf: { '1D': bars }, symbol: ctx.symbol, fee: 0.1, shorts: true });
  assert.equal(long.shorts, false);
  assert.equal(both.shorts, true);
  assert.equal(both.trials, 72);
  const by = (r) => Object.fromEntries(r.results.map((x) => [x.template, x]));
  const [l, s] = [by(long), by(both)];
  for (const id of ['ma-cross', 'macd-cross', 'supertrend']) {
    assert.equal(s[id].shorts, true, id);
    assert.notDeepEqual([s[id].train, s[id].test], [l[id].train, l[id].test], `${id} changed with shorts`);
  }
  for (const id of ['channel-breakout', 'rsi-bounce', 'bollinger-bounce', 'trend-pullback', 'momentum']) {
    assert.equal(s[id].shorts, false, id);
    assert.deepEqual([s[id].train, s[id].test], [l[id].train, l[id].test], `${id} as before`);
  }
});

test('profile: a series that keeps going is trending, one that snaps back is mean reverting', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const walk = (phi) => {
    let p = 100, prev = 0;
    return Array.from({ length: 2000 }, (_, i) => {
      const r = phi * prev + rand() * 0.02;
      prev = r;
      const o = p;
      p *= Math.exp(r);
      return { time: 1.6e9 + i * 86400, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p };
    });
  };
  assert.equal(profileBars(walk(0.3), '1D').character, 'trending');
  assert.equal(profileBars(walk(-0.3), '1D').character, 'mean reverting');
  const real = profileBars(bars, '1D');
  assert.equal(real.bars.count, 1000);
  assert.ok(real.volatilityPct > 0 && real.typicalRangePct > 0);
});
