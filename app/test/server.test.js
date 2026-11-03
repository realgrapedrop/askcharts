import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';

process.env.QT_OFFLINE = '1';
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-test-'));
const { start } = await import('../server.js');
let server, base;
const H = { 'x-qt': '1', 'Content-Type': 'application/json' };

before(async () => { const s = await start(0 || 39000 + Math.floor(Math.random() * 1000)); server = s.server; base = `http://127.0.0.1:${s.port}`; });
after(() => server.close());

test('health and the app page load', async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  const page = await (await fetch(`${base}/`)).text();
  assert.ok(page.includes('AskCharts'));
  const lib = await fetch(`${base}/vendor/lightweight-charts.standalone.production.js`);
  assert.equal(lib.status, 200);
});

test('the page says so when the chart library is blocked', async () => {
  const page = await (await fetch(`${base}/`)).text();
  // the check is a file of its own (the sign-in gateway's policy runs no inline script), straight after the library
  assert.match(page, /lightweight-charts[^"]*"><\/script>\s*<script src="\/js\/chart-blocked\.js"><\/script>/);
  const script = await (await fetch(`${base}/js/chart-blocked.js`)).text();
  const run = (window) => {
    const added = [];
    const document = { createElement: () => ({ style: {} }), body: { appendChild: (el) => added.push(el) } };
    vm.runInNewContext(script, { window, document });
    return added;
  };
  assert.match(run({})[0].textContent, /ad blocker/);
  assert.equal(run({ LightweightCharts: {} }).length, 0);
});

test('candles come back sorted with OHLCV', async () => {
  const r = await (await fetch(`${base}/api/candles?symbol=BTCUSDT&tf=1W&limit=50`)).json();
  assert.equal(r.candles.length, 50);
  for (let i = 1; i < r.candles.length; i++) assert.ok(r.candles[i].time > r.candles[i - 1].time);
  assert.ok(['open', 'high', 'low', 'close', 'volume'].every((k) => k in r.candles[0]));
});

test('state round-trips', async () => {
  await fetch(`${base}/api/state`, { method: 'PUT', headers: H, body: JSON.stringify({ watchlists: { Main: ['BINANCE:BTCUSDT'] } }) });
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(s.watchlists, { Main: ['BINANCE:BTCUSDT'] });
});

test('a save built on an older revision is refused: another page saved since', async () => {
  const rev0 = (await (await fetch(`${base}/api/state/rev`)).json()).rev;
  const put = (body, rev) => fetch(`${base}/api/state${rev === undefined ? '' : `?rev=${rev}`}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  // page A and page B both loaded at rev0; A saves first
  const a = await put({ layout: '2' }, rev0);
  assert.equal(a.status, 200);
  const revA = (await a.json()).rev;
  assert.equal(revA, rev0 + 1);
  const b = await put({ layout: '4' }, rev0);
  assert.equal(b.status, 409);
  const why = await b.json();
  assert.equal(why.rev, revA);
  assert.match(why.error, /another tab or on another device/);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).layout, '2', "B didn't write over A");
  // B keeps its own: it saves on the revision it was told
  assert.equal((await put({ layout: '4' }, why.rev)).status, 200);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual([s.layout, s.rev], ['4', revA + 1]);
  // an older page that names no revision is taken as before
  assert.equal((await put({ layout: '1' })).status, 200);
  assert.equal((await (await fetch(`${base}/api/state/rev`)).json()).rev, revA + 2);
});

test('alerts can be created, listed and deleted', async () => {
  const a = await (await fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', tf: '1D', left: 'close', op: '>', right: 1 }) })).json();
  assert.ok(a.id);
  await fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H });
  const log = await (await fetch(`${base}/api/alerts/log`)).json();
  assert.ok(log.some((e) => e.alertId === a.id), 'the alert fired');
  await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
  assert.equal((await (await fetch(`${base}/api/alerts`)).json()).length, 0);
});

test('a malformed custom indicator is refused on save and never replaces a working one', async () => {
  const save = (code) => fetch(`${base}/api/custom`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Test format check', code }) });
  const broken = "export default { name: 'Broken', calc: (bars) => ({ value: bars.slice(5).map((b) => b.close) }) };";
  const r1 = await save(broken);
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error, /calc\(\) returned 295 values, but there are 300 bars/);
  let list = await (await fetch(`${base}/api/custom`)).json();
  assert.ok(!list.some((c) => c.file === 'test-format-check.js'), 'a refused new file is not kept');
  const good = "export default { name: 'Fine', calc: (bars, p, ta) => ({ value: ta.source(bars) }) };";
  assert.equal((await save(good)).status, 200);
  assert.equal((await save(broken)).status, 400);
  const kept = await (await fetch(`${base}/custom/test-format-check.js`)).text();
  assert.equal(kept, good, 'the working version stays');
  list = await (await fetch(`${base}/api/custom`)).json();
  assert.equal(list.find((c) => c.file === 'test-format-check.js').error, null);
  await fetch(`${base}/api/custom/test-format-check.js`, { method: 'DELETE', headers: H });
});

test('POST /api/backtest runs the tester on the server, with quant checks on request', async () => {
  const strategy = {
    indicators: { fast: { id: 'ema', params: { length: 9 } }, slow: { id: 'ema', params: { length: 21 } } },
    entryLong: [{ left: 'fast', op: 'crossesAbove', right: 'slow' }],
    exitLong: [{ left: 'fast', op: 'crossesBelow', right: 'slow' }],
  };
  const r = await (await fetch(`${base}/api/backtest`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BTCUSDT', tf: '1D', limit: 500, strategy, quantChecks: true }) })).json();
  assert.equal(r.symbol, 'BINANCE:BTCUSDT');
  assert.equal(r.bars, 500);
  assert.ok(r.stats.totalTrades > 0 && Number.isFinite(r.stats.netProfitPct));
  assert.equal(r.trades.length, r.stats.totalTrades);
  assert.ok(r.quantChecks.total >= 3 && r.quantChecks.gates.every((g) => typeof g.pass === 'boolean'));
  assert.equal(r.equity, undefined, 'equity only when asked for');
  const bad = await fetch(`${base}/api/backtest`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BTCUSDT', strategy: { entryLong: [{ left: 'nope', op: '>', right: 1 }] } }) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown operand "nope"/);
  const noHeader = await fetch(`${base}/api/backtest`, { method: 'POST', body: '{}' });
  assert.equal(noHeader.status, 403);
  const inds = await (await fetch(`${base}/api/indicators`)).json();
  assert.ok(inds.some((d) => d.id === 'ema' && d.inputs.some((i) => i.key === 'length') && d.outputs.includes('value')));
});

test('writes without the app header are refused', async () => {
  const r = await fetch(`${base}/api/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});

test('a custom indicator file can be saved and loaded', async () => {
  const code = "export default { name: 'Double close', calc: (bars, p, ta) => ({ value: ta.source(bars).map((v) => v * 2) }) };";
  const r = await (await fetch(`${base}/api/custom`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Test double close', code }) })).json();
  assert.equal(r.ok, true);
  const list = await (await fetch(`${base}/api/custom`)).json();
  assert.ok(list.some((c) => c.file === 'test-double-close.js'));
  await fetch(`${base}/api/custom/test-double-close.js`, { method: 'DELETE', headers: H });
});

test('screener and scan work', async () => {
  const rows = await (await fetch(`${base}/api/screener?universe=crypto`)).json();
  assert.ok(rows.length > 0);
  const scan = await (await fetch(`${base}/api/scan`, { method: 'POST', headers: H, body: JSON.stringify({ symbols: ['BTCUSDT'], tf: '1D', indicators: { rsi: { id: 'rsi', params: { length: 14 } } }, rules: [{ left: 'rsi', op: '>', right: 0 }] }) })).json();
  assert.equal(scan[0].pass, true);
});

// ---- regressions from the API fuzz (Oct 2026) ----
const status = async (url, init) => (await fetch(`${base}${url}`, init)).status;

test('client mistakes get a 400, not a 500', async () => {
  assert.equal(await status('/api/candles?symbol=&tf=1D'), 400);
  assert.equal(await status('/api/candles?symbol=BTCUSDT&tf=banana'), 400);
  assert.equal(await status('/api/resolve?symbol='), 400);
  assert.equal(await status('/%E0%A4%A'), 400);
  assert.equal(await status('/api/state', { method: 'PUT', headers: H, body: 'not json' }), 400);
  assert.equal(await status('/api/state', { method: 'PUT', headers: H, body: '[1,2]' }), 400);
  assert.equal(await status('/api/scan', { method: 'POST', headers: H, body: '{"symbols":5,"rules":"x"}' }), 400);
  assert.equal(await status('/api/webhook-test', { method: 'POST', headers: H, body: '{"url":"notaurl"}' }), 400);
});

test('symbols that could reshape an upstream URL are refused', async () => {
  for (const s of ['BINANCE:BTC&interval=1m', 'US:../../admin', ':::', 'A B?C', 'x'.repeat(80)])
    assert.equal(await status(`/api/candles?symbol=${encodeURIComponent(s)}&tf=1D`), 400, s);
  for (const s of ['BTCUSDT', 'EUR/USD', '^FTSE', 'YAHOO:GC=F', 'VOD.L', 'BRK-B'])
    assert.equal(await status(`/api/resolve?symbol=${encodeURIComponent(s)}`), 200, s);
});

test('an opaque Origin is refused with 403, not a crash', async () => {
  assert.equal(await status('/api/state', { method: 'PUT', headers: { ...H, Origin: 'null' }, body: '{}' }), 403);
});

test('alerts with a bad operator, operand or body are refused up front', async () => {
  const post = (b) => status('/api/alerts', { method: 'POST', headers: H, body: JSON.stringify(b) });
  assert.equal(await post('x'), 400);
  assert.equal(await post({ symbol: 'BTCUSDT', right: 1, op: 'bogus' }), 400);
  assert.equal(await post({ symbol: 'BTCUSDT', right: 1, op: '>', left: 'nope' }), 400);
  assert.equal(await post({ symbol: 'BTCUSDT', op: '>', left: 'rsi', right: 70, indicators: { rsi: { id: 'rsi', params: { length: 14 } } } }), 200);
  assert.equal(await status('/api/alerts/doesnotexist', { method: 'PATCH', headers: H, body: '{}' }), 404);
  for (const a of await (await fetch(`${base}/api/alerts`)).json()) await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});

test('a "once" alert fires once even when checks overlap', async () => {
  const a = await (await fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', tf: '1D', left: 'close', op: '>', right: 1 }) })).json();
  await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H })));
  const log = await (await fetch(`${base}/api/alerts/log`)).json();
  assert.equal(log.filter((e) => e.alertId === a.id).length, 1);
  await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});

test('static files cannot escape their folder', async () => {
  for (const u of ['/..%2F..%2Fserver.js', '/custom/..%2Fserver.js', '/custom/..%2F..%2F..%2Fetc%2Fpasswd', '/..%5cserver.js'])
    assert.ok([403, 404].includes(await status(u)), u);
});

test('POST /api/shutdown stops a running copy (used by the installer to update)', async () => {
  const { spawn } = await import('node:child_process');
  const port = 41000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), QT_OFFLINE: '1' }, stdio: 'pipe' });
  const exited = new Promise((r) => child.on('exit', r));
  // Deadlines, not a fixed number of polls: on a busy machine the copy can take several seconds to start.
  const within = (ms, p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} took over ${ms / 1000}s`)), ms).unref())]);
  try {
    let out = '';
    const actual = await within(30000, new Promise((ok, no) => {
      child.stdout.on('data', (d) => { out += d; const m = /localhost:(\d+)/.exec(out); if (m) ok(Number(m[1])); });
      exited.then((code) => no(new Error(`the copy exited (${code}) before it started:\n${out}`)));
    }), 'starting the copy');
    assert.equal((await fetch(`http://127.0.0.1:${actual}/api/shutdown`, { method: 'POST' })).status, 403, 'needs the app header');
    assert.equal((await fetch(`http://127.0.0.1:${actual}/api/shutdown`, { method: 'POST', headers: { 'x-qt': '1' } })).status, 200);
    assert.equal(await within(10000, exited, 'shutting down'), 0);
  } finally {
    // Always stop it: a copy left running keeps this test file's process alive, and the whole run hangs.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('slash notation: pairs stay pairs, two symbols make a ratio', async () => {
  const r = async (s) => (await (await fetch(`${base}/api/resolve?symbol=${encodeURIComponent(s)}`)).json()).id;
  assert.equal(await r('BTC/USDT'), 'BINANCE:BTCUSDT');
  assert.equal(await r('EUR/USD'), 'FX:EURUSD');
  assert.equal(await r('BTCUSDT/ETHUSDT'), 'SPREAD:BINANCE:BTCUSDT / BINANCE:ETHUSDT');
  const sp = await (await fetch(`${base}/api/candles?symbol=${encodeURIComponent('BTCUSDT/ETHUSDT')}&tf=1D&limit=20`)).json();
  assert.equal(sp.candles.length, 20);
  assert.ok(Math.abs(sp.candles.at(-1).close - 1) < 1e-9, 'offline fixture serves the same bars for both sides');
});

test('a watchlist alert checks every symbol on the list, once each', async () => {
  await fetch(`${base}/api/state`, { method: 'PUT', headers: H, body: JSON.stringify({ watchlists: { Crypto: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'] } }) });
  const a = await (await fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ watchlist: 'Crypto', tf: '1D', left: 'close', op: '>', right: 0 }) })).json();
  assert.equal(a.watchlist, 'Crypto');
  await fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H });
  await fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H });
  const fired = (await (await fetch(`${base}/api/alerts/log`)).json()).filter((e) => e.alertId === a.id);
  assert.deepEqual(fired.map((e) => e.symbol).sort(), ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT']);
  assert.ok(fired.every((e) => e.text.includes(e.symbol)), 'each message names its symbol');
  const none = await fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ tf: '1D', left: 'close', op: '>', right: 0 }) });
  assert.equal(none.status, 400);
  await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});

// as on TradingView, a list's "Only once" alert stops when every symbol has fired; an edit can make it one symbol's
test('a watchlist alert on Only once stops after every symbol fires, and can become one symbol\'s', async () => {
  await fetch(`${base}/api/state`, { method: 'PUT', headers: H, body: JSON.stringify({ watchlists: { Crypto: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'] } }) });
  const a = await (await fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ watchlist: 'Crypto', tf: '1D', left: 'close', op: '>', right: 0, trigger: 'once' }) })).json();
  await fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H });
  const after = (await (await fetch(`${base}/api/alerts`)).json()).find((x) => x.id === a.id);
  assert.deepEqual(Object.keys(after.lastBars).sort(), ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT']);
  assert.equal(after.active, false);
  const one = await (await fetch(`${base}/api/alerts/${a.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ watchlist: null, symbol: 'BINANCE:BTCUSDT', active: true }) })).json();
  assert.equal(one.symbol, 'BINANCE:BTCUSDT');
  assert.ok(!('watchlist' in one));
  await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});

test('multi-condition alerts: all must hold, or any, and five at most', async () => {
  const mk = async (body) => fetch(`${base}/api/alerts`, { method: 'POST', headers: H, body: JSON.stringify({ symbol: 'BTCUSDT', tf: '1D', trigger: 'once', ...body }) });
  const all = await (await mk({ conditions: [{ left: 'close', op: '>', right: 1 }, { left: 'close', op: '<', right: 1 }], match: 'all' })).json();
  const any = await (await mk({ conditions: [{ left: 'close', op: '>', right: 1 }, { left: 'close', op: '<', right: 1 }], match: 'any' })).json();
  const line = await (await mk({ conditions: [{ left: 'close', op: '>', right: { line: { t1: 0, p1: 1, t2: 1, p2: 1, extend: 'right' } } }] })).json();
  await fetch(`${base}/api/alerts/check`, { method: 'POST', headers: H });
  const log = await (await fetch(`${base}/api/alerts/log`)).json();
  assert.ok(!log.some((e) => e.alertId === all.id), 'all: one false condition blocks it');
  assert.ok(log.some((e) => e.alertId === any.id), 'any: one true condition fires it');
  assert.ok(log.some((e) => e.alertId === line.id), 'a drawn line works as a condition');
  const six = await mk({ conditions: Array.from({ length: 6 }, () => ({ left: 'close', op: '>', right: 1 })) });
  assert.equal(six.status, 400);
  for (const a of [all, any, line]) await fetch(`${base}/api/alerts/${a.id}`, { method: 'DELETE', headers: H });
});
