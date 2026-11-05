import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.QT_OFFLINE = '1';
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-pine-'));
const { start } = await import('../server.js');
const { TEMPLATES, templateCode } = await import('../public/lib/pinetemplates.js');
const { busy } = await import('../lib/pinerun.js');
let server, base;
const H = { 'x-qt': '1', 'Content-Type': 'application/json' };
const post = (p, body, headers = H) => fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
const MA = templateCode(TEMPLATES[0], { symbol: 'BINANCE:BTCUSDT' });
// busy work on every bar: slow enough to hit a short time limit
const SLOW = `//@version=6
strategy("Slow")
w = 0.0
for i = 0 to 20000
    w := w + math.sqrt(i)
plot(w)`;

before(async () => { const s = await start(39000 + Math.floor(Math.random() * 1000)); server = s.server; base = `http://127.0.0.1:${s.port}`; });
after(() => server.close());

test('Pine on the server: check, sweep, scan and profile answer on the offline bars', async () => {
  const c = await (await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1D' })).json();
  assert.equal(c.ok, true);
  assert.equal(c.source, 'fixture');
  assert.ok(c.strategy.train && c.strategy.test);
  const s = await (await post('/api/pine/sweep', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1D', sweep: { in1: [10, 20], in2: [40, 50] } })).json();
  assert.equal(s.tried, 4);
  assert.ok(s.picked);
  const sc = await (await post('/api/pine/scan', { symbol: 'BINANCE:BTCUSDT', tfs: ['1D'] })).json();
  assert.equal(sc.results.length, 8);
  assert.equal(sc.fee, 0.1);
  const p = await (await post('/api/market/profile', { symbol: 'BINANCE:BTCUSDT', tf: '1D' })).json();
  assert.ok(['trending', 'mean reverting', 'neither'].includes(p.character));
});

test('Pine on the server: only from the app, inside the limits', async () => {
  assert.equal((await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT' }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post('/api/pine/check', { code: '', symbol: 'BINANCE:BTCUSDT' })).status, 400);
  assert.equal((await post('/api/pine/check', { code: 'x'.repeat(100001), symbol: 'BINANCE:BTCUSDT' })).status, 413);
  const many = { in1: [1, 2, 3, 4, 5, 6, 7, 8], in2: [1, 2, 3, 4, 5, 6, 7] };
  assert.equal((await post('/api/pine/sweep', { code: MA, symbol: 'BINANCE:BTCUSDT', sweep: many })).status, 400);
  assert.equal((await post('/api/pine/scan', { symbol: 'BINANCE:BTCUSDT', tfs: ['1h', '4h', '1D', '1W'] })).status, 400);
  // a request can't slip in other strategy settings, names an object already has, or odd input names
  const props = JSON.parse('{"commission_value": 0, "margin_long": 1, "constructor": [[[1]]], "toString": "x", "hasOwnProperty": "slippage", "__proto__": {"polluted": 1}}');
  const c = await (await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', props, params: { constructor: 1, __proto__: 2, in1: 30 } })).json();
  assert.equal(c.ok, true);
  assert.match(c.strategy.fees, /^commission 0\b/);
  assert.equal({}.polluted, undefined);
  // the profile is a POST like the rest: a plain GET (a link another site opens) runs nothing
  assert.equal((await fetch(`${base}/api/market/profile?symbol=BINANCE:BTCUSDT&tf=1D`)).status, 404);
  // a bad interval fails inside the fetch and gives its place back
  assert.equal((await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: 'banana' })).status, 400);
  assert.equal(busy(), 0);
});

test('Pine on the server: a run that takes too long is stopped, and two at once is the most', async () => {
  process.env.QT_PINE_LIMIT_MS = '400';
  try {
    const slow = () => post('/api/pine/check', { code: SLOW, symbol: 'BINANCE:BTCUSDT', tf: '1D' });
    const [a, b, c] = await Promise.all([slow(), slow(), slow()]);
    const codes = [a.status, b.status, c.status].sort();
    assert.deepEqual(codes, [503, 504, 504]);
    assert.match((await (a.status === 504 ? a : b).json()).error, /Stopped after 0.4 s/);
  } finally {
    delete process.env.QT_PINE_LIMIT_MS;
  }
  // and the app still answers, with both places free
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal(busy(), 0);
});

test('Pine on the server: a request that closes stops its run and frees its place', async () => {
  const ac = new AbortController();
  const gone = post('/api/pine/check', { code: SLOW, symbol: 'BINANCE:BTCUSDT', tf: '1D' }, H).catch(() => 'closed');
  // the same, through a fetch that's abandoned after a moment
  const r = fetch(`${base}/api/pine/check`, { method: 'POST', headers: H, body: JSON.stringify({ code: SLOW, symbol: 'BINANCE:BTCUSDT', tf: '1D' }), signal: ac.signal }).catch(() => 'closed');
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(busy(), 2);
  ac.abort();
  assert.equal(await r, 'closed');
  for (let i = 0; i < 50 && busy() > 1; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(busy(), 1);
  // the other one runs on to its own end (the slow script takes a few seconds)
  await gone;
  assert.equal(busy(), 0);
});

test('Pine on the server: warmed up on the bars before the window, trading from its first bar', async () => {
  const { compilePine, runPine } = await import('../public/lib/pine.js');
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
  const MACD = templateCode(TEMPLATES.find((t) => t.id === 'macd-cross'), { symbol: 'BINANCE:BTCUSDT' });
  const c = await (await post('/api/pine/check', { code: MACD, symbol: 'BINANCE:BTCUSDT', tf: '1D', limit: 300 })).json();
  // the last 300 bars, as the Strategy tester with its testing period from the first of them
  assert.deepEqual([c.bars.count, c.bars.from, c.bars.to], [300, fx[700].time, fx[999].time]);
  const sum = (s) => [s.trades.length, Number(((s.equity.at(-1).value / s.equity[0].value - 1) * 100).toFixed(2))];
  const ctx = { symbol: 'BINANCE:BTCUSDT', tf: '1D' };
  const warm = runPine(compilePine(MACD), fx.slice(-800), {}, { ...ctx, range: { from: fx[700].time, to: null } }).strategy;
  const cold = runPine(compilePine(MACD), fx.slice(-300), {}, ctx).strategy;
  assert.deepEqual([c.strategy.closedTrades, c.strategy.whole.returnPct], sum(warm));
  assert.notDeepEqual(sum(cold), sum(warm), 'started cold, the first bars read differently');
  assert.equal(c.strategy.whole.from, fx[700].time);
  // the profile reads the window only
  const p = await (await post('/api/market/profile', { symbol: 'BINANCE:BTCUSDT', tf: '1D', limit: 300 })).json();
  assert.equal(p.bars.count, 300);
});

test('Pine on the server: the last 2 years unless asked, counted in time; the window says when it falls short', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
  const YEAR = 365.25 * 86400;
  const first = (years) => fx.findIndex((b) => b.time >= fx.at(-1).time - years * YEAR);
  const c = await (await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1D' })).json();
  assert.deepEqual([c.bars.count, c.bars.from, c.years, c.short], [1000 - first(2), fx[first(2)].time, 2, null]);
  // the same window everywhere: the scan, the sweep and the profile
  const sc = await (await post('/api/pine/scan', { symbol: 'BINANCE:BTCUSDT', tfs: ['1D'], templates: ['ma-cross'] })).json();
  assert.equal(sc.intervals[0].bars.from, fx[first(2)].time);
  const sw = await (await post('/api/pine/sweep', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1D', sweep: { in1: [10, 20] } })).json();
  assert.equal(sw.bars.from, fx[first(2)].time);
  const p = await (await post('/api/market/profile', { symbol: 'BINANCE:BTCUSDT', tf: '1D' })).json();
  assert.equal(p.bars.from, fx[first(2)].time);
  // a year when asked
  const one = await (await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1D', years: 1 })).json();
  assert.deepEqual([one.bars.from, one.years], [fx[first(1)].time, 1]);
  // more years than the history has: all of it, and short says so
  const ten = await (await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1D', years: 10 })).json();
  assert.deepEqual([ten.bars.count, ten.short], [1000, 'history']);
  // fewer bars than the years: the bars win, and short says so
  const cap = await (await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1D', limit: 200 })).json();
  assert.deepEqual([cap.bars.count, cap.short], [200, 'bars']);
  // bars further apart than the interval (here the offline daily bars on 4h; on a chart, a weekend) start the
  // window a little after the years asked: that isn't short
  const gap = await (await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '4h' })).json();
  assert.deepEqual([gap.bars.from, gap.short], [fx[first(2)].time, null]);
  // too few bars in the years asked
  const r = await post('/api/pine/check', { code: MA, symbol: 'BINANCE:BTCUSDT', tf: '1W', years: 0.25 });
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /bars in the last 0.25 years/);
});
