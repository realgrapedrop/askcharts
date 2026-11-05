import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compilePine, runPine } from '../public/lib/pine.js';
import { TEMPLATES, templateCode, feeFor } from '../public/lib/pinetemplates.js';
import { pineTunables, pineChecks } from '../public/lib/pinequant.js';

const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
const ctx = { symbol: 'BINANCE:BTCUSDT', tf: '1D' };

test('strategy templates: eight, each with a name, a kind and a line on what it does', () => {
  assert.equal(TEMPLATES.length, 8);
  assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, 8);
  for (const t of TEMPLATES) assert.ok(t.name && t.kind && t.about.endsWith('.'), t.id);
});

test('strategy templates: the fee follows the market, written into the script', () => {
  assert.equal(feeFor('KRAKEN:XRPUSD'), 0.1);
  assert.equal(feeFor('BINANCE:BTCUSDT.P'), 0.1);
  assert.equal(feeFor('AAPL'), 0);
  assert.equal(feeFor('NASDAQ:NVDA'), 0);
  for (const t of TEMPLATES) {
    assert.equal(compilePine(templateCode(t, { symbol: 'KRAKEN:XRPUSD' })).meta.opts.commission_value, 0.1, t.id);
    assert.equal(compilePine(templateCode(t, { symbol: 'AAPL' })).meta.opts.commission_value, 0, t.id);
  }
});

for (const t of TEMPLATES)
  test(`strategy template ${t.id}: runs clean, trades in and out on the whole account, two settings to check`, async () => {
    const c = compilePine(templateCode(t, { symbol: ctx.symbol }));
    assert.equal(c.meta.kind, 'strategy');
    assert.equal(c.meta.title, t.name);
    const r = runPine(c, bars, {}, ctx);
    assert.deepEqual(r.warnings, []);
    const s = r.strategy;
    assert.ok(s.trades.length >= 3, `${s.trades.length} closed trades`);
    assert.ok(s.trades.every((x) => x.exitTime > x.entryTime), 'every trade closes after it opens');
    // the whole account: the first trade is worth about the starting capital
    const first = s.trades[0];
    assert.ok(Math.abs((first.entryPrice * first.qty) / 10000 - 1) < 0.02, `first trade ${first.entryPrice * first.qty}`);
    const tun = pineTunables(c.inputs, {});
    assert.equal(tun.length, 2);
    for (const x of tun) assert.equal(x.values.length, 5, `${x.label}: ${x.values}`);
    const q = await pineChecks({ inputs: c.inputs, bars, run: (p, props) => runPine(c, bars, p, { ...ctx, ...(props ? { strategy: props } : {}) }).strategy });
    assert.equal(q.variants.length, 25);
    assert.equal(q.failed, 0);
    // the trend ones can go short too
    const short = c.inputs.find((x) => x.label === 'Also trade short');
    if (short) assert.ok(runPine(c, bars, { [short.key]: true }, ctx).strategy.trades.some((x) => x.side === 'short'));
  });
