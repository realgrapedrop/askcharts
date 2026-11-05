import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePine, runPine } from '../public/lib/pine.js';
import { pineChecks, pineTunables, stressProps } from '../public/lib/pinequant.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));

const strategy = (head, body) => compilePine(`//@version=6
strategy("Test", overlay=true${head})
${body}`);
const MA_CROSS = `fast = input.int(10, "Fast length", minval=2)
slow = input.int(30, "Slow length")
on = input.bool(true, "Trade")
a = ta.ema(close, fast)
b = ta.sma(close, slow)
if on and ta.crossover(a, b)
    strategy.entry("L", strategy.long)
if ta.crossunder(a, b)
    strategy.close("L")`;
const runner = (c) => (params, props) => runPine(c, bars, params, { symbol: 'BINANCE:BTCUSDT', tf: '1D', ...(props ? { strategy: props } : {}) }).strategy;
const check = (c, opts = {}) => pineChecks({ inputs: c.inputs, run: runner(c), bars, ...opts });

test('Pine checks vary the first two number inputs, kept to their step, min and max', () => {
  const c = compilePine(`//@version=6
strategy("T")
on = input.bool(true, "On")
src = input.source(close, "Source")
len = input.int(14, "Length", minval=12)
mult = input.float(3, "Factor", step=0.5, maxval=3.5)
off = input.int(0, "Offset")
plot(close)`);
  const t = pineTunables(c.inputs, {});
  assert.deepEqual(t.map((x) => x.label), ['Length', 'Factor']);
  assert.deepEqual(t[0].values, [12, 14, 17, 20]);
  assert.deepEqual(t[1].values, [2, 2.5, 3, 3.5]);
  // a value set on the chart is the base; keys pick other inputs
  assert.equal(pineTunables(c.inputs, { in3: 20 })[0].base, 20);
  assert.deepEqual(pineTunables(c.inputs, {}, ['in4']).map((x) => x.label), ['Factor']);
});

test('Pine checks: one run per bar of equity, the gates of the rule checks, Monte Carlo the same every time', async () => {
  const c = strategy(', commission_type=strategy.commission.percent, commission_value=0.1', MA_CROSS);
  const base = runner(c)({});
  assert.equal(base.equity.length, bars.length);
  let last = 0;
  const q = await check(c, { progress: (d, t) => (last = `${d}/${t}`) });
  assert.equal(last, '26/26');
  assert.equal(q.variants.length, 25);
  assert.deepEqual(q.gates.map((g) => g.key), ['wf', 'pbo', 'dsr', 'cost', 'robust', 'quarters']);
  assert.equal(q.quarters.rows[0].from, base.equity[0].time);
  assert.equal(q.walkForward.folds.length, 5);
  assert.ok(q.walkForward.folds.every((f) => f.from < f.to));
  assert.equal(q.base.trades, base.stats.totalTrades);
  assert.equal(q.thin, q.base.trades < 30);
  assert.ok(q.monteCarlo, 'enough trades for a Monte Carlo');
  const again = await check(c);
  assert.deepEqual(again.monteCarlo, q.monteCarlo);
});

test('Pine checks: the cost stress costs something even for a script with no fees', async () => {
  const c = strategy('', MA_CROSS);
  const stress = stressProps({}, bars);
  assert.equal(stress.commission_value, 0);
  assert.ok(stress.slippage > 0);
  assert.ok(Math.abs(stress.pct - 0.05) < 0.01, `about 0.05% of the price, got ${stress.pct}`);
  const q = await check(c);
  assert.ok(q.costStress < q.base.netPct, `${q.costStress} below ${q.base.netPct}`);
});

test('Pine checks: one lucky setting fails Nearby settings', async () => {
  const c = strategy('', `len = input.int(14, "Length")
r = ta.rsi(close, len)
if len == 14 and ta.crossover(r, 50)
    strategy.entry("L", strategy.long)
if len == 14 and ta.crossunder(r, 50)
    strategy.close("L")`);
  const q = await check(c);
  const robust = q.gates.find((g) => g.key === 'robust');
  assert.equal(robust.pass, false);
  assert.equal(q.robustness.share, 0);
});

test('Pine checks: a version that stops with an error is left out; Stop stops', async () => {
  const c = strategy('', `${MA_CROSS}
if fast > 12
    runtime.error("too fast")`);
  const q = await check(c);
  assert.equal(q.failed, 5); // fast 14 (of 6, 8, 10, 12, 14) with each of the five slow lengths
  assert.ok(q.gates.length > 0);
  let runs = 0;
  await assert.rejects(check(c, { progress: () => runs++, stopped: () => runs >= 3 }), (e) => e.stopped === true);
  assert.equal(runs, 3);
});

test('Pine checks: a strategy trading a sliver of its capital keeps its small returns and says how small', async () => {
  const c = strategy(', default_qty_value=0.01', MA_CROSS);
  const q = await check(c);
  assert.ok(q.sizePct > 0 && q.sizePct < 1, `size ${q.sizePct}%`);
  assert.ok(q.variants.some((v) => v.netPct !== 0 && Math.abs(v.netPct) < 0.1), 'returns under 0.1% are not rounded to 0');
  const full = await check(strategy(', default_qty_type=strategy.percent_of_equity, default_qty_value=100', MA_CROSS));
  assert.ok(full.sizePct > 90, `size ${full.sizePct}%`);
});
