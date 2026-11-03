// Your own data keys (data/feeds.json), with a fake network: no live calls and no real keys.
// Viewers asked to plug in their own feed instead of the free public sources (YouTube, Oct 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QT_TIMEOUT_MS = "300";
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qt-feeds-"));
const FILE = path.join(process.env.QT_DATA_DIR, "feeds.json");
let stamp = Date.now() / 1000;
function writeFeeds(obj) {
  if (obj == null) fs.rmSync(FILE, { force: true });
  else {
    fs.writeFileSync(FILE, JSON.stringify(obj));
    stamp += 5; // a clearly newer mtime, whatever the file system's clock resolution
    fs.utimesSync(FILE, stamp, stamp);
  }
}
const KEYS = {
  keyId: "PKTESTKEYID",
  secretKey: "TESTSECRET",
  apiKey: "POLYTESTKEY",
  token: "OANDATESTTOKEN",
};

// 5-minute bars for one day, 08:00 to 19:55 New York (EDT, UTC-4): pre-market, the session, after hours.
const DAY = Date.UTC(2026, 9, 14) / 1000;
const fiveMin = Array.from(
  { length: 144 },
  (_, i) => DAY + 12 * 3600 + i * 300,
);
const bar = (t, k) => ({
  o: 100 + k,
  h: 101 + k,
  l: 99 + k,
  c: 100.5 + k,
  v: 1000 + k,
});

let alpacaStatus = 200;
let polygonFuturesStatus = 200;
let oandaStatus = 200;
// Nasdaq and Yahoo not answering (500, not 429: a 429 rests Yahoo for minutes, for the tests after too)
let publicDown = false;
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  calls.push({ host: u.host, url: String(url), headers: opts.headers || {} });
  if (u.host === "data.alpaca.markets") {
    if (alpacaStatus !== 200)
      return Response.json({ message: "forbidden." }, { status: alpacaStatus });
    const sym = u.searchParams.get("symbols");
    const tf = u.searchParams.get("timeframe");
    let rows;
    if (tf === "1Day")
      rows = Array.from({ length: 30 }, (_, i) => ({
        t: new Date((DAY - i * 86400 + 4 * 3600) * 1000).toISOString(),
        ...bar(0, i),
      }));
    else
      rows = fiveMin
        .map((t, i) => ({ t: new Date(t * 1000).toISOString(), ...bar(t, i) }))
        .reverse();
    assert.equal(u.searchParams.get("sort"), "desc");
    const page2 = u.searchParams.get("page_token") === "p2";
    const half = Math.ceil(rows.length / 2);
    return Response.json({
      bars: { [sym]: page2 ? rows.slice(half) : rows.slice(0, half) },
      next_page_token: page2 ? null : "p2",
    });
  }
  if (u.host === "api.massive.com" && u.pathname.startsWith("/futures/")) {
    if (polygonFuturesStatus !== 200) return Response.json({ status: "NOT_AUTHORIZED" }, { status: polygonFuturesStatus });
    assert.equal(u.searchParams.get("sort"), "window_start.desc");
    const rows = fiveMin
      .map((t, i) => ({ window_start: t * 1e9, open: 20000 + i, high: 20001 + i, low: 19999 + i, close: 20000.5 + i, volume: 50 }))
      .reverse();
    return Response.json({ results: rows, status: "OK" });
  }
  if (u.host === "api-fxpractice.oanda.com" || u.host === "api-fxtrade.oanda.com") {
    if (oandaStatus !== 200) return Response.json({ errorMessage: "Insufficient authorization" }, { status: oandaStatus });
    const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", ".000000000Z");
    const daily = u.searchParams.get("granularity") === "D";
    const times = daily ? Array.from({ length: 5 }, (_, i) => DAY + i * 86400) : fiveMin;
    return Response.json({
      candles: times.map((t, i) => ({
        time: iso(t),
        complete: true,
        volume: 12,
        mid: { o: String(2000 + i), h: String(2001 + i), l: String(1999 + i), c: String(2000.5 + i) },
      })),
    });
  }
  if (publicDown && ["api.nasdaq.com", "query1.finance.yahoo.com"].includes(u.host)) return new Response("down", { status: 500 });
  // Nasdaq's daily history: 30 days to DAY, official closes 200 and up; nothing yet today
  // Binance's pairs, for search: a stock token (AMDB) beside two Bitcoin pairs
  if (["api.binance.com", "data-api.binance.vision"].includes(u.host) && u.pathname === "/api/v3/exchangeInfo")
    return Response.json({ symbols: [["AMDBUSDT", "AMDB", "USDT"], ["BTCUSDT", "BTC", "USDT"], ["BTCUSDC", "BTC", "USDC"]].map(([symbol, baseAsset, quoteAsset]) => ({ symbol, baseAsset, quoteAsset, status: "TRADING" })) });
  if (u.host === "api.nasdaq.com") {
    // Nasdaq's ticker lookup, for search
    if (u.pathname.startsWith("/api/autocomplete/")) {
      const q = u.searchParams.get("search").toUpperCase();
      const all = [["AMD", "Advanced Micro Devices, Inc. Common Stock", "STOCKS"], ["AMDL", "GraniteShares 2x Long AMD Daily ETF", "ETF"], ["BTC", "Grayscale Bitcoin Mini Trust ETF", "ETF"]];
      return Response.json({ data: all.filter(([t]) => t.startsWith(q)).map(([symbol, name, asset]) => ({ symbol, name, asset, exchange: "NASDAQ-GS" })) });
    }
    if (u.pathname.endsWith("/chart")) return Response.json({ data: { chart: [], volume: "0" } });
    const day = (i) => new Date((DAY - i * 86400) * 1000);
    const rows = Array.from({ length: 30 }, (_, i) => ({ date: `${day(i).getUTCMonth() + 1}/${day(i).getUTCDate()}/${day(i).getUTCFullYear()}`, open: "$199.00", high: "$202.00", low: "$198.00", close: `$${200 + i}.00`, volume: "50,000,000" }));
    return Response.json({ data: { tradesTable: { rows } } });
  }
  if (u.host === "query1.finance.yahoo.com") {
    const ts = fiveMin;
    return Response.json({
      chart: {
        result: [
          {
            meta: { gmtoffset: -14400 },
            timestamp: ts,
            indicators: { quote: [{ open: ts.map(() => 25000), high: ts.map(() => 25010), low: ts.map(() => 24990), close: ts.map(() => 25005), volume: ts.map(() => 7) }] },
          },
        ],
      },
    });
  }
  if (u.host === "api.massive.com") {
    const rows = fiveMin
      .map((t, i) => ({ t: t * 1000, ...bar(t, i) }))
      .reverse();
    return Response.json({ results: rows, status: "OK" });
  }
  return new Response("not mocked", { status: 404 });
};
const P = await import("../lib/providers.js");
const F = await import("../lib/feeds.js");

const leaks = () =>
  calls.filter((c) => {
    const sentTo = c.host;
    const carries = JSON.stringify(c.headers) + c.url;
    const own =
      {
        "data.alpaca.markets": [KEYS.keyId, KEYS.secretKey],
        "api.massive.com": [KEYS.apiKey],
        "api-fxpractice.oanda.com": [KEYS.token],
        "api-fxtrade.oanda.com": [KEYS.token],
      }[sentTo] || [];
    return Object.values(KEYS).some(
      (k) => carries.includes(k) && !own.includes(k),
    );
  });

test("with no feeds.json, stock charts use only the public sources", async () => {
  writeFeeds(null);
  assert.deepEqual(F.configured(), []);
  assert.equal(F.stockChain("AAPL", "1D", 100).length, 0);
});

test("an Alpaca key takes over US stock charts: session bars only, keys in headers only", async () => {
  writeFeeds({ alpaca: { keyId: KEYS.keyId, secretKey: KEYS.secretKey } });
  calls.length = 0;
  const r = await P.getCandles("US:AAPL", "5m", 50);
  assert.equal(r.provider, "Alpaca (IEX)");
  assert.equal(r.candles.length, 50);
  assert.ok(
    r.candles.every((b) => F.inUsSession(b.time)),
    "pre-market and after-hours bars are left out",
  );
  assert.equal(
    r.candles.at(-1).time,
    DAY + 19 * 3600 + 55 * 60,
    "last bar is 15:55 New York",
  );
  for (let i = 1; i < r.candles.length; i++)
    assert.ok(r.candles[i].time > r.candles[i - 1].time);
  assert.ok(
    r.notes.some((n) => /IEX/.test(n)),
    "the chart says it's the IEX feed",
  );
  const alpaca = calls.filter((c) => c.host === "data.alpaca.markets");
  assert.equal(alpaca.length, 2, "follows Alpaca's next_page_token");
  assert.equal(alpaca[0].headers["APCA-API-KEY-ID"], KEYS.keyId);
  assert.ok(
    alpaca.every(
      (c) => !c.url.includes(KEYS.secretKey) && !c.url.includes(KEYS.keyId),
    ),
    "keys never go in the URL",
  );
  assert.deepEqual(leaks(), []);
  assert.equal(
    JSON.stringify(F.configured()),
    '["alpaca"]',
    "health lists names, never keys",
  );
});

test("on the free IEX feed, daily and longer charts take the official daily bars: Nasdaq, then Yahoo", async () => {
  calls.length = 0;
  const r = await P.getCandles("US:MSFT", "1D", 20);
  assert.equal(r.provider, "Nasdaq");
  assert.equal(r.candles.at(-1).close, 200, "Nasdaq's close, not IEX's last trade");
  assert.equal(calls.filter((c) => c.host === "data.alpaca.markets").length, 0, "IEX isn't asked while Nasdaq answers");
  const w = await P.getCandles("US:MSFT", "1W", 3);
  assert.equal(w.provider, "Nasdaq");
  // intraday stays on the key
  assert.equal((await P.getCandles("US:MSFT", "15m", 10)).provider, "Alpaca (IEX)");
});

test("IEX's daily bars stand in when Nasdaq and Yahoo don't answer, on the trading date at UTC midnight", async () => {
  publicDown = true;
  try {
    const r = await P.getCandles("US:ORCL", "1D", 20);
    assert.equal(r.provider, "Alpaca (IEX)");
    assert.ok(r.candles.every((b) => b.time % 86400 === 0));
    assert.equal(r.candles.at(-1).time, DAY);
    assert.ok(r.notes.some((n) => /IEX trades only/.test(n)), r.notes.join(" | "));
    const w = await P.getCandles("US:NVDA", "1W", 3);
    assert.equal(w.provider, "Alpaca (IEX)");
    assert.ok(w.candles.length >= 3, "weekly bars built from the key's daily bars");
  } finally {
    publicDown = false;
  }
});

test("a SIP key (the whole market) keeps daily charts on the key", async () => {
  writeFeeds({ alpaca: { keyId: KEYS.keyId, secretKey: KEYS.secretKey, feed: "sip" } });
  const r = await P.getCandles("US:INTC", "1D", 20);
  assert.equal(r.provider, "Alpaca (SIP)");
  assert.equal(r.candles.at(-1).time, DAY);
});

test("a refused Alpaca key falls back to Polygon, and the chart says why in plain words", async () => {
  writeFeeds({
    alpaca: { keyId: KEYS.keyId, secretKey: KEYS.secretKey },
    polygon: { apiKey: KEYS.apiKey },
  });
  alpacaStatus = 401;
  calls.length = 0;
  const r = await P.getCandles("US:TSLA", "15m", 10);
  assert.equal(r.provider, "Polygon");
  assert.ok(r.candles.length > 0);
  assert.ok(r.candles.every((b) => F.inUsSession(b.time)));
  assert.ok(
    r.notes.includes("Alpaca refused your key, so this chart uses Polygon."),
    r.notes.join(" | "),
  );
  assert.doesNotMatch(r.notes.join(" "), /HTTP|401|\.com/);
  const poly = calls.find((c) => c.host === "api.massive.com");
  assert.equal(poly.headers.Authorization, `Bearer ${KEYS.apiKey}`);
  assert.ok(
    !poly.url.includes(KEYS.apiKey),
    "the Polygon key goes in a header, not the URL",
  );
  assert.deepEqual(leaks(), []);
  // A refused key rests for a minute instead of being asked again on every chart.
  calls.length = 0;
  await P.getCandles("US:AMD", "15m", 10);
  assert.equal(calls.filter((c) => c.host === "data.alpaca.markets").length, 0);
});

test("a broken feeds.json leaves the public sources working", async () => {
  fs.writeFileSync(FILE, "{ not json");
  stamp += 5;
  fs.utimesSync(FILE, stamp, stamp);
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    assert.deepEqual(F.configured(), []);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((m) => /feeds\.json/.test(m)));
});

// ---------- CME futures (NQ, MNQ, ES, MES) ----------
test("the front contract rolls 8 days before the third Friday of each quarter month", () => {
  const at = (d) => F.frontContract("NQ", Date.parse(d));
  assert.equal(at("2026-10-15T12:00:00Z"), "NQZ6");
  assert.equal(at("2026-12-09T12:00:00Z"), "NQZ6");
  assert.equal(at("2026-12-10T14:00:00Z"), "NQH7", "Dec 2026 expires Fri 18th, so it rolls Thu 10th");
  assert.equal(at("2027-03-12T12:00:00Z"), "NQM7");
  assert.equal(F.frontContract("MNQ", Date.parse("2026-01-02T12:00:00Z")), "MNQH6");
});

test("NQ, MNQ, ES and MES resolve and search as CME futures", async () => {
  for (const [typed, id] of [
    ["NQ", "CME:NQ1!"],
    ["nq1!", "CME:NQ1!"],
    ["MNQ", "CME:MNQ1!"],
    ["CME_MINI:NQ1!", "CME:NQ1!"],
    ["CME:ES1!", "CME:ES1!"],
    ["MES1!", "CME:MES1!"],
  ])
    assert.equal((await P.resolve(typed)).id, id, typed);
  assert.equal((await P.search("MNQ"))[0].symbol, "CME:MNQ1!");
  const es = await P.search("ES");
  assert.equal(es[0].symbol, "CME:ES1!");
  assert.equal(es[0].type, "futures");
});

test("search puts what was typed in full first: AMD the stock before AMDBUSDT, Bitcoin's pairs before the fund named BTC", async () => {
  const amd = (await P.search("AMD")).map((r) => r.symbol);
  assert.equal(amd[0], "US:AMD", amd.join());
  assert.ok(amd.includes("BINANCE:AMDBUSDT") && amd.includes("US:AMDL"), "the rest are still listed");
  const btc = (await P.search("btc")).map((r) => r.symbol);
  assert.deepEqual(btc.slice(0, 3), ["BINANCE:BTCUSDT", "BINANCE:BTCUSDC", "US:BTC"], btc.join());
  for (const [typed, first] of [["EURUSD", "FX:EURUSD"], ["gold", "FX:XAUUSD"], ["XAU", "FX:XAUUSD"]])
    assert.equal((await P.search(typed))[0].symbol, first, typed);
});

test("without a Polygon key, futures chart Yahoo's delayed feed and say so", async () => {
  writeFeeds(null);
  const r = await P.getCandles("NQ1!", "5m", 30);
  assert.equal(r.provider, "Yahoo (delayed)");
  assert.equal(r.candles.length, 30);
  assert.ok(r.notes.some((n) => /^Delayed about 10 minutes/.test(n)), r.notes.join(" | "));
});

test("with a Polygon key, futures chart the live front contract, key in a header", async () => {
  writeFeeds({ polygon: { apiKey: KEYS.apiKey } });
  calls.length = 0;
  const r = await P.getCandles("CME:MNQ1!", "15m", 20);
  const contract = F.frontContract("MNQ");
  assert.equal(r.provider, `Polygon ${contract}`);
  assert.ok(r.candles.length > 0 && r.candles.length <= 20);
  assert.ok(r.notes.some((n) => n.includes(`Front contract ${contract}`)), r.notes.join(" | "));
  const c = calls.find((x) => x.url.includes("/futures/v1/aggs/"));
  assert.ok(c.url.includes(`/futures/v1/aggs/${contract}?`), c.url);
  assert.equal(c.headers.Authorization, `Bearer ${KEYS.apiKey}`);
  assert.deepEqual(leaks(), []);
});

test("a Polygon plan without futures falls back to the delayed chart, in plain words", async () => {
  polygonFuturesStatus = 403;
  const r = await P.getCandles("CME:ES1!", "1h", 20);
  assert.equal(r.provider, "Yahoo (delayed)");
  assert.ok(r.notes.includes("Your Polygon plan doesn't include this, so this chart uses Yahoo (delayed)."), r.notes.join(" | "));
  polygonFuturesStatus = 200;
});

test("an OANDA token charts OANDA: symbols with mid prices, token in a header, practice server by default", async () => {
  writeFeeds({ oanda: { token: KEYS.token } });
  calls.length = 0;
  const r = await P.getCandles("OANDA:NAS100_USD", "5m", 30);
  assert.equal(r.provider, "OANDA");
  assert.equal(r.candles.length, 30);
  assert.equal(typeof r.candles[0].close, "number");
  assert.ok(r.notes.some((n) => /not exchange data/.test(n)), r.notes.join(" | "));
  const c = calls.find((x) => x.host === "api-fxpractice.oanda.com");
  assert.ok(c.url.includes("/v3/instruments/NAS100_USD/candles?"), c.url);
  assert.equal(c.headers.Authorization, `Bearer ${KEYS.token}`);
  assert.deepEqual(leaks(), []);
});

test("a live OANDA account uses the live server, and daily bars land on UTC midnight", async () => {
  writeFeeds({ oanda: { token: KEYS.token, account: "live" } });
  calls.length = 0;
  const r = await P.getCandles("OANDA:XAU_USD", "1D", 5);
  const c = calls.find((x) => x.host === "api-fxtrade.oanda.com");
  assert.ok(c.url.includes("dailyAlignment=0") && c.url.includes("alignmentTimezone=UTC"), c.url);
  assert.equal(r.candles[0].time % 86400, 0);
});

test("an OANDA token goes first for forex and metals; gold isn't called a token chart", async () => {
  writeFeeds({ oanda: { token: KEYS.token } });
  calls.length = 0;
  const fx = await P.getCandles("EURUSD", "15m", 10);
  assert.equal(fx.provider, "OANDA");
  assert.ok(calls.some((x) => x.url.includes("/v3/instruments/EUR_USD/candles?")));
  const gold = await P.getCandles("XAUUSD", "15m", 10);
  assert.equal(gold.provider, "OANDA");
  assert.ok(!gold.notes.some((n) => /backed by real gold/.test(n)), gold.notes.join(" | "));
});

test("a refused OANDA token falls back to the public sources for forex and says why", async () => {
  writeFeeds({ oanda: { token: KEYS.token } });
  oandaStatus = 401;
  const r = await P.getCandles("GBPUSD", "1h", 10);
  assert.notEqual(r.provider, "OANDA");
  assert.ok(r.notes.some((n) => n.startsWith("OANDA refused your key")), r.notes.join(" | "));
  oandaStatus = 200;
});

test("OANDA: symbols without a token say what to do", async () => {
  writeFeeds(null);
  await assert.rejects(() => P.getCandles("OANDA:SPX500_USD", "1h", 10), /need your own OANDA token/);
});
