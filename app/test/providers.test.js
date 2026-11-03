// Provider fallbacks with a fake network: no live calls. Each case is a real bug found by
// blocking hosts: Binance blocked made "BTCUSDT" resolve to a US stock, and a firewall that
// silently drops Binance cost a full timeout on every chart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QT_TIMEOUT_MS = "300";
// a data folder of its own: the calendar keeps a copy there (never the real data/)
process.env.QT_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "qt-providers-"));
// no history store: Kraken charts come from the (fake) API alone
process.env.QT_HISTORY = path.join(process.env.QT_DATA_DIR, "no-history", "bars.sqlite");
const btc = JSON.parse(
  readFileSync(new URL("./fixtures/btc-1d.json", import.meta.url), "utf8"),
);
let mode = {}; // host -> 'drop' | 'dns' | status code
let krakenRows = []; // Kraken's OHLC rows: [time, open, high, low, close, vwap, volume, trades]
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push(u.host);
  const m = mode[u.host] ?? mode["*"];
  if (m === "drop") {
    // A real dropped connection holds a socket open. The fake one has nothing keeping the event
    // loop alive, and Node before 24 unrefs AbortSignal.timeout, so hold a timer until the abort.
    const keepAlive = setTimeout(() => {}, 10000);
    return new Promise((_, rej) =>
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        rej(opts.signal.reason);
      }),
    );
  }
  if (m === "dns")
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  if (m) return new Response("blocked", { status: m });
  if (u.host === "api.exchange.coinbase.com") {
    const end = Date.parse(u.searchParams.get("end")) / 1000;
    const rows = btc
      .filter((b) => b.time < end)
      .slice(-300)
      .reverse()
      .map((b) => [b.time, b.low, b.high, b.open, b.close, b.volume]);
    return Response.json(rows);
  }
  if (u.host === "api.kraken.com" && u.pathname === "/0/public/AssetPairs")
    return Response.json({ error: [], result: { XXRPZUSD: { altname: "XRPUSD", wsname: "XRP/USD", status: "online" } } });
  if (u.host === "api.kraken.com" && u.pathname === "/0/public/OHLC")
    return Response.json({ error: [], result: { XXRPZUSD: krakenRows, last: 0 } });
  if (u.host === "nfs.faireconomy.media")
    return Response.json([{ title: "CPI", country: "USD", date: "2026-10-23T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" }]);
  return new Response("not mocked", { status: 404 });
};
const P = await import("../lib/providers.js");

test("with Binance blocked, crypto still resolves as crypto and loads from Coinbase", async () => {
  mode = {
    "api.binance.com": 451,
    "data-api.binance.vision": 451,
    "api.binance.us": 451,
  };
  for (const s of ["BTCUSDT", "btc", "ETH-USD", "SOL/USDT"])
    assert.equal((await P.resolve(s)).exchange, "BINANCE", s);
  assert.equal((await P.resolve("AAPL")).exchange, "US");
  const r = await P.getCandles("BTCUSDT", "1D", 100);
  assert.equal(r.provider, "Coinbase");
  assert.equal(r.candles.length, 100);
});

test("a silently dropped host costs one timeout, then is skipped", async () => {
  mode = {
    "api.binance.com": "drop",
    "data-api.binance.vision": "drop",
    "api.binance.us": "drop",
  };
  let t = Date.now();
  const a = await P.getCandles("BINANCE:ETHUSDT", "1D", 50);
  assert.equal(a.provider, "Coinbase");
  assert.ok(
    Date.now() - t < 1500,
    `first fallback took ${Date.now() - t} ms (three hosts should time out together)`,
  );
  t = Date.now();
  calls.length = 0;
  const b = await P.getCandles("BINANCE:SOLUSDT", "1D", 50);
  assert.equal(b.provider, "Coinbase");
  assert.ok(Date.now() - t < 200, "second chart skips the dead hosts");
  assert.ok(
    !calls.some((h) => h.includes("binance")),
    "no new Binance calls while it is marked down",
  );
});

test("network failures are upstream errors (the server answers 502)", async () => {
  mode = { "*": "dns" };
  await assert.rejects(P.economicCalendar(), (e) => e.upstream === true);
});

test("the calendar keeps its last good copy, serves it while the feed answers 429, and rests the feed", async () => {
  // fresh copies of the module: the one above is resting the feed after its failure
  mode = {};
  assert.equal((await (await import("../lib/providers.js?calendar-good")).economicCalendar()).length, 1);
  const C = await import("../lib/providers.js?calendar-429");
  mode = { "nfs.faireconomy.media": 429 };
  calls.length = 0;
  assert.equal((await C.economicCalendar())[0].title, "CPI");
  assert.equal((await C.economicCalendar())[0].title, "CPI");
  assert.equal(calls.filter((h) => h === "nfs.faireconomy.media").length, 1);
});

test("the chart note for a fallback is plain words: no hostnames or HTTP codes", async () => {
  // A Skool member saw "Using Kraken (Yahoo: query1.finance.yahoo.com returned HTTP 429)" on a chart and had to ask what it meant.
  mode = { "api.binance.com": 451, "data-api.binance.vision": 451, "api.binance.us": 451 };
  const r = await P.getCandles("BTCUSDT", "1D", 100);
  const text = r.notes.join(" ");
  assert.match(text, /Binance isn't answering right now, so this chart uses Coinbase\./);
  assert.doesNotMatch(text, /HTTP|\.com|returned/);
});

test("Kraken's coin names typed into search read as everyone else's", () => {
  assert.equal(P.commonCoin("XBTUSD"), "BTCUSD");
  assert.equal(P.commonCoin("XBT"), "BTC");
  assert.equal(P.commonCoin("XDGUSD"), "DOGEUSD");
  assert.equal(P.commonCoin("XRPUSD"), "XRPUSD");
  assert.equal(P.commonCoin("ETHXBT"), "ETHXBT");
});

test("Kraken pairs are keyed by the names everyone else uses (BTC, DOGE), valued by Kraken's own", async () => {
  const { krakenPairMap } = await import("../lib/providers.js");
  const m = krakenPairMap({
    XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", status: "online" },
    XDGUSD: { altname: "XDGUSD", wsname: "XDG/USD", status: "online" },
    SOLUSD: { altname: "SOLUSD", wsname: "SOL/USD", status: "online" },
    OLDUSD: { altname: "OLDUSD", wsname: "OLD/USD", status: "delisted" },
  });
  assert.equal(m.get("BTCUSD"), "XBTUSD");
  assert.equal(m.get("DOGEUSD"), "XDGUSD");
  assert.equal(m.get("SOLUSD"), "SOLUSD");
  assert.equal(m.has("OLDUSD"), false);
});

test("XAUUSD charts gold, and falls back to PAXG when Yahoo is down", async () => {
  mode = { "query1.finance.yahoo.com": 429, "query2.finance.yahoo.com": 429 };
  for (const s of ["XAUUSD", "xau/usd", "FX:XAUUSD"])
    assert.equal((await P.resolve(s)).id, "FX:XAUUSD", s);
  assert.equal((await P.resolve("XAGUSD")).id, "FX:XAGUSD");
  assert.equal((await P.resolve("GOLD")).exchange, "US", "Barrick's ticker stays a stock");
  for (const s of ["^FTSE", "YAHOO:^FTSE"])
    assert.equal((await P.resolve(s)).id, "YAHOO:^FTSE", s);
  calls.length = 0;
  const r = await P.getCandles("XAUUSD", "1D", 50).catch((e) => e);
  assert.ok(
    calls.some((h) => h.includes("binance") || h.includes("coinbase")),
    "gold tries the PAXG token feeds after Yahoo",
  );
  if (!(r instanceof Error)) assert.ok(r.notes.some((n) => n.includes("PAXG")));
});

test("crypto perpetual futures: BTCUSDT.P charts Binance futures, then Bybit where Binance futures is blocked", async () => {
  // A YouTube comment: "only spot trading is available in the list, and futures are not there".
  for (const [typed, id] of [
    ["BTCUSDT.P", "BINANCE:BTCUSDT.P"],
    ["btc.p", "BINANCE:BTCUSDT.P"],
    ["ETHPERP", "BINANCE:ETHUSDT.P"],
    ["BINANCE:SOLUSDT.P", "BINANCE:SOLUSDT.P"],
  ])
    assert.equal((await P.resolve(typed)).id, id, typed);
  const kline = (b) => [b.time * 1000, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume)];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.host === "fapi.binance.com" && mode["fapi.binance.com"] !== 451) {
      assert.equal(u.searchParams.get("symbol"), "BTCUSDT");
      return Response.json(btc.slice(-Number(u.searchParams.get("limit"))).map(kline));
    }
    if (u.host === "api.bybit.com") {
      assert.equal(u.searchParams.get("category"), "linear");
      return Response.json({ retCode: 0, result: { list: btc.slice(-60).reverse().map(kline) } });
    }
    return realFetch(url, opts);
  };
  try {
    mode = {};
    const a = await P.getCandles("BTCUSDT.P", "1D", 50);
    assert.equal(a.provider, "Binance futures");
    assert.equal(a.candles.length, 50);
    mode = { "fapi.binance.com": 451 };
    const b = await P.getCandles("BINANCE:BTCUSDT.P", "1W", 5);
    assert.equal(b.provider, "Bybit");
    assert.match(b.notes.join(" "), /Binance futures isn't answering right now, so this chart uses Bybit\./);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Kraken's OHLC feed fills a minute without trades with a flat, zero volume bar; its archives (the
// history store) have none. Mixed, a chart had two conventions: gaps in the past, flat bars lately.
test("Kraken's filler bars (no trades) are left out, as in the history store", async () => {
  mode = {};
  const t0 = 1792699920; // on a 2 minute boundary
  const row = (i, o, h, l, c, v, n) => [t0 + i * 60, String(o), String(h), String(l), String(c), String(c), String(v), n];
  krakenRows = [
    row(0, 1.3, 1.31, 1.29, 1.305, 1200, 4),
    row(1, 1.305, 1.305, 1.305, 1.305, 0, 0), // no trades: a filler
    row(2, 1.305, 1.32, 1.3, 1.31, 50, 1),
    row(3, 1.31, 1.31, 1.31, 1.31, 0, 0),
    row(4, 1.31, 1.31, 1.31, 1.31, 0, 0), // the minute still open, no trade yet: a filler too
  ];
  const r = await P.getCandles("KRAKEN:XRPUSD", "1m", 100);
  assert.equal(r.provider, "Kraken");
  assert.deepEqual(r.candles.map((b) => b.time), [t0, t0 + 120]);
  assert.equal(r.candles.at(-1).close, 1.31);
  // an interval built from them (2m from 1m) has a bar only where there were trades
  const two = await P.getCandles("KRAKEN:XRPUSD", "2m", 100);
  assert.deepEqual(two.candles.map((b) => [b.time, b.volume]), [[t0, 1200], [t0 + 120, 50]]);
  // a pair with no trades in the whole window says so instead of drawing a flat line
  krakenRows = [row(0, 1.3, 1.3, 1.3, 1.3, 0, 0), row(1, 1.3, 1.3, 1.3, 1.3, 0, 0)];
  await assert.rejects(P.getCandles("KRAKEN:XRPUSD", "1m", 101), /Kraken: no trades in its last 2 bars on 1m/);
});
