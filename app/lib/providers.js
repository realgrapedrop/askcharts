// Market data from free, keyless public sources, each with fallbacks. Keys you add yourself
// (data/feeds.json, see lib/feeds.js) go in front of them.
//
//   Crypto  BINANCE:BTCUSDT   Binance -> Binance market-data mirror -> Binance.US -> Coinbase -> Kraken
//   Perps   BINANCE:BTCUSDT.P Binance USD-M futures -> Bybit linear perpetuals
//   Stocks  US:AAPL           Your Alpaca / Polygon key -> Yahoo (when it isn't rate limiting you) -> Nasdaq
//   Forex   FX:EURUSD         Your OANDA key -> Yahoo -> Kraken
//   OANDA   OANDA:XAU_USD     Your OANDA key only (any instrument your account lists)
//   Futures CME:NQ1!          Your Polygon key (data/feeds.json) -> Yahoo, about 10 minutes delayed
//   Global  YAHOO:^FTSE       Yahoo only (indices, futures, non-US stocks)
//
// Symbols are "EXCHANGE:TICKER" strings, like TradingView's. resolve() turns what a person types
// ("btc", "aapl", "eurusd", "VOD.L") into one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseTf,
  resample,
  nativeBase,
  isIntraday,
} from "../public/lib/series.js";
import * as feeds from "./feeds.js";
import * as imports from "./imports.js";
import * as history from "./history.js";
import * as store from "./store.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
// Yahoo answers 429 to any full browser User-Agent (seen 15 Oct 2026) but 200 to a bare one.
const YAHOO = { "User-Agent": "Mozilla/5.0" };
const TIMEOUT_MS = Number(process.env.QT_TIMEOUT_MS) || 10000;
const FIAT = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"];
const OFFLINE = process.env.QT_OFFLINE === "1";
// Spot metals, quoted like forex (XAUUSD). Yahoo's futures first; gold falls back to PAXG, a token
// backed one-to-one by gold, so the chart still loads when Yahoo is rate limiting.
const METALS = {
  XAUUSD: { name: "Gold / USD", word: "GOLD", yahoo: "GC=F", token: "PAXG" },
  XAGUSD: { name: "Silver / USD", word: "SILVER", yahoo: "SI=F" },
};
// CME equity index futures as continuous front-month charts, TradingView-style (NQ1!). The public
// chart is Yahoo's, about 10 minutes behind; your own Polygon key (data/feeds.json) charts the live contract.
export const FUTURES = {
  NQ: { name: "E-mini Nasdaq-100 futures", yahoo: "NQ=F" },
  MNQ: { name: "Micro E-mini Nasdaq-100 futures", yahoo: "MNQ=F" },
  ES: { name: "E-mini S&P 500 futures", yahoo: "ES=F" },
  MES: { name: "Micro E-mini S&P 500 futures", yahoo: "MES=F" },
};
const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- plumbing ----------
export const health = {};
function mark(name, ok, err) {
  health[name] = {
    ok,
    at: new Date().toISOString(),
    ...(err ? { error: String(err.message || err).slice(0, 200) } : {}),
  };
}

// A host that timed out or couldn't be reached is skipped for a minute, so a firewall that
// silently drops one provider costs one timeout, not one per chart, before the fallback runs.
const hostDownUntil = new Map();
const upstreamError = (message, status) =>
  Object.assign(new Error(message), { status, upstream: true });

async function getJson(url, headers = {}) {
  const host = new URL(url).host;
  if ((hostDownUntil.get(host) || 0) > Date.now())
    throw upstreamError(
      `${host} isn't reachable from here (trying again in a minute)`,
    );
  let res;
  try {
    res = await fetchJson(url, headers);
  } catch (e) {
    hostDownUntil.set(host, Date.now() + 60e3);
    const why =
      e.name === "TimeoutError" ? "timed out" : e.cause?.code || e.message;
    throw upstreamError(`${host} couldn't be reached (${why})`);
  }
  hostDownUntil.delete(host);
  if (!res.ok) {
    const e = upstreamError(`${host} returned HTTP ${res.status}`, res.status);
    throw e;
  }
  return res.json();
}

function fetchJson(url, headers) {
  return fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const cache = new Map();
const CACHE_MAX = 400;
// Cache with in-flight de-duplication, so ten charts asking for the same thing make one request.
// Bounded: the oldest entries go first, so a long session can't grow memory without limit.
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && (hit.pending || now - hit.at < ttlMs)) return hit.promise;
  if (cache.size >= CACHE_MAX)
    for (const [k, v] of cache) {
      if (cache.size < CACHE_MAX * 0.9) break;
      if (!v.pending) cache.delete(k);
    }
  const promise = fn().then(
    (v) => {
      cache.set(key, { at: Date.now(), promise: Promise.resolve(v) });
      return v;
    },
    (e) => {
      cache.delete(key);
      throw e;
    },
  );
  cache.set(key, { at: now, pending: true, promise });
  return promise;
}

// Sub-minute charts poll every second, so their cache must expire just under a second. A US stock
// outside market hours has nothing new, so it waits longer and spares the Alpaca rate limit.
const ttlFor = (tf, sym) => {
  const s = parseTf(tf).seconds;
  if (s < 60) return sym?.exchange === "US" && !feeds.usMarketOpen() ? 30000 : 900;
  return s < 3600 ? 4000 : s < 86400 ? 15000 : 60000;
};

const MAJOR_CRYPTO = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "DOT",
  "LTC",
  "BCH",
  "TRX",
  "XLM",
  "ATOM",
  "UNI",
  "NEAR",
  "APT",
  "ARB",
  "OP",
  "SUI",
  "PEPE",
  "SHIB",
  "AAVE",
  "ETC",
  "FIL",
  "HBAR",
  "ICP",
  "INJ",
  "TON",
  "XMR",
  "ZEC",
  "HYPE",
];
const badInput = (message) =>
  Object.assign(new Error(message), { status: 400 });

// ---------- symbol resolution ----------
let binanceSymbols = null; // Map ticker -> { base, quote }
export async function binanceSymbolMap() {
  if (OFFLINE)
    return new Map([
      ["BTCUSDT", { base: "BTC", quote: "USDT" }],
      ["ETHUSDT", { base: "ETH", quote: "USDT" }],
    ]);
  return cached("binance:symbols", 6 * 3600e3, async () => {
    const info = await binanceGet("/api/v3/exchangeInfo");
    binanceSymbols = new Map(
      info.symbols
        .filter((s) => s.status === "TRADING")
        .map((s) => [s.symbol, { base: s.baseAsset, quote: s.quoteAsset }]),
    );
    return binanceSymbols;
  }).catch(() => binanceSymbols || new Map());
}

let usTickers = null;
async function usTickerSet() {
  if (usTickers) return usTickers;
  try {
    const rows = await nasdaqScreener("stocks");
    usTickers = new Set(rows.map((r) => r.ticker));
  } catch {
    usTickers = new Set();
  }
  return usTickers;
}

// Spreads and ratios, like TradingView's BTCUSDT/ETHUSDT or AAPL - MSFT: one operator between two
// symbols (or a symbol and a number). Canonical id: "SPREAD:<id> <op> <id>", spaces around op.
const OP_SPLIT = [/^(.+?)\s*([/*])\s*(.+)$/, /^(.+?)\s+([+-])\s+(.+)$/];
const isNumStr = (x) => /^-?\d+(\.\d+)?$/.test(String(x).trim());
export function parseSpread(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase();
  if (s.startsWith("SPREAD:")) {
    const m = /^SPREAD:(.+?) ([/*+-]) (.+)$/.exec(s);
    return m ? { a: m[1], op: m[2], b: m[3] } : null;
  }
  const fx = /^([A-Z]{3})\/([A-Z]{3})$/.exec(s);
  if (fx && FIAT.includes(fx[1]) && FIAT.includes(fx[2])) return null; // EUR/USD is a pair, not a ratio
  // SOL/USDT, BTC/USD: a quote currency on the right means a trading pair, not a ratio.
  if (/^[A-Z0-9]{2,12}\/(USDT|USDC|FDUSD|BUSD|USD)$/.test(s)) return null;
  for (const re of OP_SPLIT) {
    const m = re.exec(s);
    if (m && m[1].trim() && m[3].trim())
      return { a: m[1].trim(), op: m[2], b: m[3].trim() };
  }
  return null;
}

export async function resolve(raw) {
  let sp = parseSpread(raw);
  // ETH/BTC is Binance's ETHBTC pair when Binance lists it; otherwise it's a ratio.
  if (
    sp &&
    sp.op === "/" &&
    /^[A-Z0-9]{2,12}$/.test(sp.a) &&
    /^[A-Z0-9]{2,6}$/.test(sp.b) &&
    (await binanceSymbolMap()).has(sp.a + sp.b)
  )
    sp = null;
  if (sp) {
    if ([sp.a, sp.b].some((x) => parseSpread(x)))
      throw badInput("Use one operator per spread, like BTCUSDT/ETHUSDT");
    if (isNumStr(sp.a) && isNumStr(sp.b))
      throw badInput("A spread needs at least one symbol");
    const side = async (x) =>
      isNumStr(x) ? String(Number(x)) : (await resolve(x)).id;
    const [a, b] = await Promise.all([side(sp.a), side(sp.b)]);
    const id = `SPREAD:${a} ${sp.op} ${b}`;
    return { id, exchange: "SPREAD", ticker: `${a} ${sp.op} ${b}` };
  }
  const input = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!input) throw badInput("Empty symbol");
  // NQ1!, CME_MINI:NQ1!, MNQ: futures. A bare root that is also a US stock ticker (ES) stays the stock.
  const fut = /^(CME(?:_MINI)?:)?([A-Z]{2,3})(1!)?$/.exec(input);
  if (fut && FUTURES[fut[2]] && (fut[1] || fut[3] || !(await usTickerSet()).has(fut[2])))
    return { id: `CME:${fut[2]}1!`, exchange: "CME", ticker: `${fut[2]}1!` };
  // BTCUSDT.P, BTC.P, BTCPERP, BINANCE:ETHUSDT.P: crypto perpetual futures, TradingView's ".P".
  const perp = /^(?:BINANCE:)?([A-Z0-9]{2,15}?)(USDT|USDC)?[-/]?(?:\.P|PERP)$/.exec(input);
  if (perp) {
    const t = `${perp[1]}${perp[2] || "USDT"}.P`;
    return { id: `BINANCE:${t}`, exchange: "BINANCE", ticker: t };
  }
  // Tickers go into upstream URLs, so only the characters real tickers use are allowed.
  if (
    !/^([A-Z0-9_]{1,20}:)?[A-Z0-9][A-Z0-9.\-_^=/]{0,29}$/.test(
      input.replace(/(^|:)\^/, "$1A"),
    )
  )
    throw badInput(`"${String(raw).slice(0, 40)}" isn't a symbol`);
  if (input.includes(":")) {
    const [exchange, ticker] = input.split(":");
    return { id: `${exchange}:${ticker}`, exchange, ticker };
  }
  const fx = input.replace("/", "");
  if (
    /^[A-Z]{6}$/.test(fx) &&
    FIAT.includes(fx.slice(0, 3)) &&
    FIAT.includes(fx.slice(3))
  )
    return { id: `FX:${fx}`, exchange: "FX", ticker: fx };
  if (METALS[fx]) return { id: `FX:${fx}`, exchange: "FX", ticker: fx };
  if (/[=^.]/.test(input))
    return { id: `YAHOO:${input}`, exchange: "YAHOO", ticker: input };
  const bin = await binanceSymbolMap();
  if (!bin.size) {
    // Binance unreachable (blocked country, firewall): recognise crypto without its symbol list,
    // so the Coinbase and Kraken fallbacks still get the request.
    const pair = /^([A-Z0-9]{2,12})[-/]?(USDT|USDC|FDUSD)$/.exec(input);
    if (pair)
      return {
        id: `BINANCE:${pair[1]}${pair[2]}`,
        exchange: "BINANCE",
        ticker: `${pair[1]}${pair[2]}`,
      };
    const base = input.replace(/[-/]?USD$/, "");
    if (MAJOR_CRYPTO.includes(base))
      return {
        id: `BINANCE:${base}USDT`,
        exchange: "BINANCE",
        ticker: `${base}USDT`,
      };
  }
  const slashPair = /^([A-Z0-9]{2,12})\/([A-Z0-9]{2,6})$/.exec(input);
  if (slashPair && bin.has(slashPair[1] + slashPair[2]))
    return {
      id: `BINANCE:${slashPair[1]}${slashPair[2]}`,
      exchange: "BINANCE",
      ticker: `${slashPair[1]}${slashPair[2]}`,
    };
  if (bin.has(input))
    return { id: `BINANCE:${input}`, exchange: "BINANCE", ticker: input };
  const crypto = input.replace(/[-/]/g, "");
  if (bin.has(`${crypto}USDT`) && !(await usTickerSet()).has(input))
    return {
      id: `BINANCE:${crypto}USDT`,
      exchange: "BINANCE",
      ticker: `${crypto}USDT`,
    };
  if (/^[A-Z]{2,10}-USD$/.test(input))
    return { id: `COINBASE:${input}`, exchange: "COINBASE", ticker: input };
  return { id: `US:${input}`, exchange: "US", ticker: input };
}

export function kindOf(id) {
  const ex = id.split(":")[0];
  return ["BINANCE", "COINBASE", "KRAKEN"].includes(ex)
    ? "crypto"
    : ex === "FX"
      ? "fx"
      : ex === "US"
        ? "stock"
        : "global";
}

// ---------- Binance ----------
const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api.binance.us",
];
let binanceHostIdx = 0;
let binanceKnownGood = false;
async function binanceGet(p) {
  const order = BINANCE_HOSTS.map(
    (_, k) => (binanceHostIdx + k) % BINANCE_HOSTS.length,
  );
  // Until a host has answered, ask all of them at once but still prefer them in order
  // (binance.us is a separate exchange with its own prices, so it is the last resort).
  // A firewall that silently drops Binance then costs one timeout, not three.
  const early = binanceKnownGood
    ? null
    : order.map((idx) => getJson(BINANCE_HOSTS[idx] + p));
  early?.forEach((pr) => pr.catch(() => {}));
  let lastErr;
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    try {
      const out = await (early ? early[k] : getJson(BINANCE_HOSTS[idx] + p));
      binanceHostIdx = idx;
      binanceKnownGood = true;
      mark("binance", true);
      return out;
    } catch (e) {
      lastErr = e;
      // 451/403 = blocked in your country; 400 = bad symbol (don't hop hosts for that).
      if (e.status === 400) throw e;
    }
  }
  binanceKnownGood = false;
  mark("binance", false, lastErr);
  throw lastErr;
}

const BINANCE_NATIVE = [
  "1s",
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "6h",
  "8h",
  "12h",
  "1D",
  "3D",
  "1W",
  "1M",
];
const binanceInterval = (tf) =>
  ({ "1D": "1d", "3D": "3d", "1W": "1w" })[tf] || tf;

async function binanceCandles(ticker, tf, limit, futures = false) {
  const base = nativeBase(tf, futures ? BINANCE_NATIVE.slice(1) : BINANCE_NATIVE);
  if (!base) throw new Error(`Binance can't build a ${tf} chart`);
  const ratio = Math.max(
    1,
    Math.round(parseTf(tf).seconds / parseTf(base).seconds),
  );
  const want = Math.min(limit * ratio + ratio, 20000);
  let out = [],
    endTime = null;
  while (out.length < want) {
    const n = Math.min(1000, want - out.length);
    const q = `/klines?symbol=${encodeURIComponent(ticker)}&interval=${binanceInterval(base)}&limit=${n}${endTime ? `&endTime=${endTime}` : ""}`;
    const rows = await (futures ? binanceFuturesGet(`/fapi/v1${q}`) : binanceGet(`/api/v3${q}`));
    if (!rows.length) break;
    out = rows
      .map((k) => ({
        time: k[0] / 1000,
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }))
      .concat(out);
    endTime = rows[0][0] - 1;
    if (rows.length < n) break;
  }
  return base === tf ? out.slice(-limit) : resample(out, tf).slice(-limit);
}

// ---------- Crypto perpetual futures ----------
// Binance USD-M futures, then Bybit's linear perpetuals (Binance futures is blocked in some countries).
async function binanceFuturesGet(p) {
  try {
    const out = await getJson(`https://fapi.binance.com${p}`);
    mark("binance-futures", true);
    return out;
  } catch (e) {
    mark("binance-futures", false, e);
    throw e;
  }
}
export async function perpSymbols() {
  if (OFFLINE) return new Set(["BTCUSDT", "ETHUSDT"]);
  return cached("binance:perps", 6 * 3600e3, async () => {
    const info = await binanceFuturesGet("/fapi/v1/exchangeInfo");
    return new Set(
      info.symbols
        .filter((s) => s.contractType === "PERPETUAL" && s.status === "TRADING")
        .map((s) => s.symbol),
    );
  }).catch(() => new Set());
}
const BYBIT_NATIVE = { "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1D": "D", "1W": "W" };
async function bybitCandles(ticker, tf, limit) {
  const base = nativeBase(tf, Object.keys(BYBIT_NATIVE));
  if (!base) throw new Error(`Bybit can't build a ${tf} chart`);
  const ratio = Math.max(1, Math.round(parseTf(tf).seconds / parseTf(base).seconds));
  const want = Math.min(limit * ratio + ratio, 20000);
  let out = [],
    end = null;
  while (out.length < want) {
    const n = Math.min(1000, want - out.length);
    const j = await getJson(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(ticker)}&interval=${BYBIT_NATIVE[base]}&limit=${n}${end ? `&end=${end}` : ""}`,
    );
    if (j.retCode) throw new Error(`Bybit: ${j.retMsg}`);
    const rows = j.result?.list || [];
    if (!rows.length) break;
    out = rows
      .map((k) => ({ time: +k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }))
      .reverse()
      .concat(out);
    end = +rows.at(-1)[0] - 1;
    if (rows.length < n) break;
  }
  out = dedupe(out);
  return base === tf ? out.slice(-limit) : resample(out, tf).slice(-limit);
}

// ---------- Coinbase ----------
const COINBASE_NATIVE = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1D": 86400,
};
// Sub-minute crypto bars (1s, 5s...) from Coinbase's and Kraken's public trades: neither has candles
// under a minute. A live poll takes only the latest trades; a first load pages back a few thousand.
// The oldest bar is dropped when it may be missing trades from before the first one fetched.
function barsFromTrades(trades, sec, cutOff) {
  const m = new Map();
  for (const t of trades) {
    const time = Math.floor(t.ms / 1000 / sec) * sec;
    const b = m.get(time);
    if (!b) m.set(time, { time, first: t.ms, last: t.ms, open: t.p, high: t.p, low: t.p, close: t.p, volume: t.s });
    else {
      if (t.ms < b.first) { b.first = t.ms; b.open = t.p; }
      if (t.ms >= b.last) { b.last = t.ms; b.close = t.p; }
      b.high = Math.max(b.high, t.p);
      b.low = Math.min(b.low, t.p);
      b.volume += t.s;
    }
  }
  if (cutOff && m.size > 1) m.delete(Math.min(...m.keys()));
  return [...m.values()].sort((a, b) => a.time - b.time).map(({ first, last, ...bar }) => bar);
}

async function coinbaseTradeCandles(product, tf, limit) {
  const sec = parseTf(tf).seconds;
  const live = limit <= 20;
  const size = live ? 100 : 1000;
  const trades = [];
  let after = null, cutOff = false;
  for (let page = 0; page < (live ? 1 : 6); page++) {
    const rows = await getJson(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/trades?limit=${size}${after ? `&after=${after}` : ""}`,
    );
    for (const r of rows) trades.push({ ms: Date.parse(r.time), p: +r.price, s: +r.size });
    cutOff = rows.length >= size;
    if (!cutOff) break;
    after = rows.at(-1).trade_id; // newest first, so the last row is the oldest
    const span = (trades[0].ms - trades.at(-1).ms) / 1000;
    if (span >= limit * sec) break;
  }
  return barsFromTrades(trades, sec, cutOff).slice(-limit);
}

async function krakenTradeCandles(pair, tf, limit) {
  const sec = parseTf(tf).seconds;
  const live = limit <= 20;
  const url = (q) => `https://api.kraken.com/0/public/Trades?pair=${encodeURIComponent(pair)}&${q}`;
  const read = (j) => {
    if (j.error?.length) throw new Error(`Kraken: ${j.error.join(", ")}`);
    const key = Object.keys(j.result).find((k) => k !== "last");
    return j.result[key].map((r) => ({ ms: r[2] * 1000, p: +r[0], s: +r[1] }));
  };
  // Kraken only pages forward, so step back in windows the size of the last page and keep going
  // while each window reaches the trades already held (no gap).
  const size = live ? 200 : 1000;
  let trades = read(await getJson(url(`count=${size}`)));
  let cutOff = trades.length >= size;
  for (let page = 0; !live && cutOff && page < 5 && trades.length; page++) {
    const oldest = trades[0].ms;
    if ((trades.at(-1).ms - oldest) / 1000 >= limit * sec) break;
    const span = Math.max(trades.at(-1).ms - oldest, 60e3);
    const older = read(await getJson(url(`count=1000&since=${Math.floor((oldest - span) * 1e6)}`)));
    if (!older.length || older.at(-1).ms < oldest) break; // a gap: keep what is continuous
    trades = older.filter((t) => t.ms < oldest).concat(trades);
    cutOff = true; // the window can start mid-bar
  }
  return barsFromTrades(trades, sec, cutOff).slice(-limit);
}

async function coinbaseCandles(product, tf, limit) {
  if (parseTf(tf).seconds < 60) return coinbaseTradeCandles(product, tf, limit);
  const base = nativeBase(tf, Object.keys(COINBASE_NATIVE));
  if (!base) throw new Error(`Coinbase can't build a ${tf} chart`);
  const g = COINBASE_NATIVE[base];
  const ratio = Math.max(1, Math.round(parseTf(tf).seconds / g));
  const want = Math.min(limit * ratio, 1500);
  let end = Math.floor(Date.now() / 1000),
    out = [];
  try {
    while (out.length < want) {
      const start = end - 300 * g;
      const rows = await getJson(
        `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${g}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`,
      );
      if (!rows.length) break;
      out = rows
        .map((r) => ({
          time: r[0],
          low: r[1],
          high: r[2],
          open: r[3],
          close: r[4],
          volume: r[5],
        }))
        .reverse()
        .concat(out);
      end = start;
    }
    mark("coinbase", true);
  } catch (e) {
    mark("coinbase", false, e);
    throw e;
  }
  out = dedupe(out);
  return base === tf ? out.slice(-limit) : resample(out, tf).slice(-limit);
}

// ---------- Kraken ----------
const KRAKEN_NATIVE = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1D": 1440,
};
const krakenAsset = (a) => (a === "BTC" ? "XBT" : a);
// Kraken's names for a coin typed into search (XBTUSD, XDG) as everyone else's (BTCUSD, DOGE), so its own
// pair is found too, and the chart's name lookup for KRAKEN:XBTUSD finds "BTC / USD"
export const commonCoin = (q) => q.replace(/^XBT/, "BTC").replace(/^XDG/, "DOGE");

// Product lists for search. An exchange that doesn't answer just drops out of the results.
const coinbaseProducts = () =>
  cached(
    "coinbase:products",
    6 * 3600e3,
    async () =>
      new Set(
        (await getJson("https://api.exchange.coinbase.com/products"))
          .filter((p) => p.status === "online")
          .map((p) => p.id),
      ),
  ).catch(() => new Set());
// "BTCUSD" -> "XBTUSD": Kraken's own name for the pair, keyed by the names everyone else uses.
export const krakenPairMap = (result) =>
  new Map(
    Object.values(result)
      .filter((p) => p.wsname && p.status !== "delisted")
      .map((p) => {
        const [b, q] = p.wsname.split("/");
        return [`${{ XBT: "BTC", XDG: "DOGE" }[b] || b}${q}`, p.altname];
      }),
  );
const krakenPairs = () =>
  cached("kraken:pairs", 6 * 3600e3, async () => {
    const j = await getJson("https://api.kraken.com/0/public/AssetPairs");
    if (j.error?.length) throw new Error(j.error.join(", "));
    return krakenPairMap(j.result);
  }).catch(() => new Map());
// Kraken's online pairs, for the Crypto data page's Add coin: Kraken's own name and a readable one
// ("XRP/EUR", "ETH/BTC"), in whatever currency each is quoted, not USD alone.
export const krakenAddPairs = () =>
  cached("kraken:add-pairs", 6 * 3600e3, async () => {
    const j = await getJson("https://api.kraken.com/0/public/AssetPairs");
    if (j.error?.length) throw new Error(j.error.join(", "));
    return Object.values(j.result)
      .filter((p) => p.wsname && p.status === "online")
      .map((p) => ({ pair: p.altname, name: p.wsname.replace(/^XBT\//, "BTC/").replace(/^XDG\//, "DOGE/").replace(/\/XBT$/, "/BTC").replace(/\/XDG$/, "/DOGE") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
// Years of Kraken's own bars from the history store (history/ at the repo root), with the API's newest
// 720 on top: where they overlap the API's win, since late trades can still change a bar. `info` gets
// the chart's note when the store is behind, and where its bars came from (the title's tooltip).
async function krakenWithHistory(pair, tf, limit, info = {}) {
  const stored = history.bars("KRAKEN", pair, tf, limit);
  let live = [];
  try {
    live = await krakenCandles(pair, tf, 720);
  } catch (e) {
    if (!stored?.candles.length) throw e;
  }
  // An interval built from a shorter one (2h from 1h, 1W from 1D) starts the API's bars partway into a
  // bar, so its first one is missing its start; the store's copy of that bar is whole.
  if (live.length > 1 && nativeBase(tf, Object.keys(KRAKEN_NATIVE)) !== tf && stored?.candles.some((b) => b.time === live[0].time)) live = live.slice(1);
  const cut = live.length ? live[0].time : Infinity;
  const kept = (stored?.candles || []).filter((b) => b.time < cut);
  const sec = parseTf(tf).seconds;
  if (stored?.last != null && live.length && live[0].time - stored.last > Math.max(3 * sec, 2 * 3600))
    info.note = `The Kraken history on this computer ends ${utcTime(stored.last)}, so this chart skips from there to ${utcTime(live[0].time)}. It fills in with the next history update (Settings, Crypto data).`;
  const spans = (stored?.sources || []).filter((x) => x.from < cut);
  info.source = spans.length
    ? ["Kraken's own bars, stored on this computer:", ...spans.map((x) => `${sourceLabel(x.name)}: ${utcDay(x.from)} to ${utcDay(Math.min(x.to, cut - 1))}`), live.length ? "The newest 720: live from Kraken." : "Kraken's live feed isn't answering."].join("\n")
    : null;
  return [...kept, ...live].slice(-limit);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const utcDay = (t) => {
  const d = new Date(t * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const utcTime = (t) => `${utcDay(t)} ${new Date(t * 1000).toISOString().slice(11, 16)} UTC`;
const sourceLabel = (n) =>
  n === "kraken-ohlc"
    ? "Kraken's OHLC feed"
    : n === "kraken-trades"
      ? "Built from Kraken's trades"
      : n === "kraken-built"
        ? "Built from Kraken's 4h bars"
        : n.startsWith("kraken-archive-")
          ? `Kraken's ${n === "kraken-archive-Full" ? "full" : n.slice(15)} archive`
          : n;

async function krakenCandles(pair, tf, limit) {
  if (parseTf(tf).seconds < 60) return krakenTradeCandles(pair, tf, limit);
  const base = nativeBase(tf, Object.keys(KRAKEN_NATIVE));
  if (!base) throw new Error(`Kraken can't build a ${tf} chart`);
  try {
    const j = await getJson(
      `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${KRAKEN_NATIVE[base]}`,
    );
    if (j.error?.length) throw new Error(`Kraken: ${j.error.join(", ")}`);
    const key = Object.keys(j.result).find((k) => k !== "last");
    // A minute without trades comes back as a flat, zero volume bar. The history store (Kraken's
    // archives) has none, so they go here too and a chart keeps one convention throughout.
    const out = j.result[key].filter((r) => +r[6] > 0 || +r[7] > 0).map((r) => ({
      time: r[0],
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[6],
    }));
    if (!out.length && j.result[key].length) throw new Error(`no trades in its last ${j.result[key].length} bars on ${base}`);
    mark("kraken", true);
    return base === tf ? out.slice(-limit) : resample(out, tf).slice(-limit);
  } catch (e) {
    mark("kraken", false, e);
    throw e;
  }
}

// ---------- Yahoo ----------
let yahooDownUntil = 0;
const YAHOO_NATIVE = {
  "1m": ["1m", "7d"],
  "2m": ["2m", "60d"],
  "5m": ["5m", "60d"],
  "15m": ["15m", "60d"],
  "30m": ["30m", "60d"],
  "1h": ["60m", "730d"],
  "1D": ["1d", "20y"],
  "1W": ["1wk", "max"],
  "1M": ["1mo", "max"],
};
export const yahooAvailable = () => Date.now() > yahooDownUntil;

async function yahooCandles(symbol, tf, limit) {
  if (!yahooAvailable())
    throw new Error(
      "Yahoo is rate limiting this connection (retrying in a few minutes)",
    );
  const base = nativeBase(tf, Object.keys(YAHOO_NATIVE));
  if (!base) throw new Error(`Yahoo can't build a ${tf} chart`);
  const [interval, range] = YAHOO_NATIVE[base];
  let j;
  try {
    j = await getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`,
      YAHOO,
    );
  } catch (e) {
    if (e.status === 429) yahooDownUntil = Date.now() + 10 * 60e3;
    mark("yahoo", false, e);
    throw e;
  }
  const out = parseYahoo(j, base);
  mark("yahoo", true);
  return base === tf ? out.slice(-limit) : resample(out, tf).slice(-limit);
}

export function parseYahoo(j, tf) {
  const r = j?.chart?.result?.[0];
  if (!r)
    throw new Error(
      j?.chart?.error?.description || "Yahoo returned no data for that symbol",
    );
  const q = r.indicators?.quote?.[0] || {};
  const off = r.meta?.gmtoffset || 0;
  const daily = !isIntraday(tf);
  const out = [];
  (r.timestamp || []).forEach((t, i) => {
    if (q.close?.[i] == null || q.open?.[i] == null) return;
    const time = daily ? Math.floor((t + off) / 86400) * 86400 : t;
    out.push({
      time,
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume?.[i] || 0,
    });
  });
  return dedupe(out);
}

// ---------- Nasdaq (US stocks, ETFs, NDX/COMP) ----------
const NQ = {
  Origin: "https://www.nasdaq.com",
  Referer: "https://www.nasdaq.com/",
};
const nqClass = new Map();
const num = (s) => {
  if (s == null) return 0;
  const v = parseFloat(String(s).replace(/[$,%\s]/g, ""));
  return Number.isFinite(v) ? v : 0;
};

async function nasdaqQuery(ticker, pathFn) {
  const classes = [nqClass.get(ticker), "stocks", "etf", "index"].filter(
    (c, i, a) => c && a.indexOf(c) === i,
  );
  let lastErr;
  for (const cls of classes) {
    try {
      const j = await getJson(pathFn(cls), NQ);
      if (j?.data) {
        nqClass.set(ticker, cls);
        mark("nasdaq", true);
        return { j, cls };
      }
      lastErr = new Error(
        j?.status?.bCodeMessage?.[0]?.errorMessage ||
          `Nasdaq has no data for ${ticker}`,
      );
    } catch (e) {
      lastErr = e;
    }
  }
  mark(
    "nasdaq",
    lastErr?.status ? false : true,
    lastErr?.status ? lastErr : null,
  );
  throw lastErr;
}

// Nasdaq stamps intraday points with New York wall-clock time written as if it were UTC.
export function nyWallToUtc(ms) {
  const wallHour = new Date(ms).getUTCHours();
  for (const h of [4, 5]) {
    const utc = ms + h * 3600e3;
    const nyHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hourCycle: "h23",
      }).format(new Date(utc)),
    );
    if (nyHour === wallHour) return utc;
  }
  return ms + 5 * 3600e3;
}

async function nasdaqToday(ticker) {
  const { j } = await nasdaqQuery(
    ticker,
    (cls) =>
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/chart?assetclass=${cls}`,
  );
  const pts = (j.data.chart || []).filter((p) => {
    const d = new Date(p.x);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return mins >= 570 && mins < 960; // 09:30-16:00 New York
  });
  return { pts, volume: num(j.data.volume) };
}

async function nasdaqCandles(ticker, tf, limit) {
  // Nasdaq's intraday chart is one point a minute; don't pass it off as seconds.
  if (parseTf(tf).seconds < 60) throw new Error(`Nasdaq can't build a ${tf} chart`);
  if (isIntraday(tf)) {
    const { pts } = await nasdaqToday(ticker);
    const minute = pts.map((p) => {
      const t = Math.floor(nyWallToUtc(p.x) / 1000 / 60) * 60;
      return { time: t, open: p.y, high: p.y, low: p.y, close: p.y, volume: 0 };
    });
    return resample(dedupe(minute), tf).slice(-limit);
  }
  const to = new Date();
  const from = new Date(Date.now() - 3653 * 86400e3); // Nasdaq serves up to ~10 years
  const fmt = (d) => d.toISOString().slice(0, 10);
  const { j } = await nasdaqQuery(
    ticker,
    (cls) =>
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/historical?assetclass=${cls}&fromdate=${fmt(from)}&limit=9999&todate=${fmt(to)}`,
  );
  const rows = j.data.tradesTable?.rows || [];
  let daily = rows
    .map((r) => {
      const [m, d, y] = r.date.split("/").map(Number);
      return {
        time: Date.UTC(y, m - 1, d) / 1000,
        open: num(r.open),
        high: num(r.high),
        low: num(r.low),
        close: num(r.close),
        volume: num(r.volume),
      };
    })
    .filter((b) => b.close > 0)
    .reverse();
  daily = daily.map((b) =>
    b.open
      ? b
      : { ...b, open: b.close, high: b.high || b.close, low: b.low || b.close },
  );
  // Today's session isn't in the history table until the close, so build it from the intraday feed.
  try {
    const { pts, volume } = await nasdaqToday(ticker);
    if (pts.length) {
      const day = Math.floor(pts[0].x / 86400e3) * 86400;
      if (!daily.length || daily.at(-1).time < day) {
        const ys = pts.map((p) => p.y);
        daily.push({
          time: day,
          open: ys[0],
          high: Math.max(...ys),
          low: Math.min(...ys),
          close: ys.at(-1),
          volume,
        });
      }
    }
  } catch {
    /* history alone is fine */
  }
  return tf === "1D" ? daily.slice(-limit) : resample(daily, tf).slice(-limit);
}

// The US market's state from Nasdaq's market info: open by its own opening and closing times (not by
// the wording of a status), and the date of the last regular session. If Nasdaq doesn't answer,
// the clock: weekdays 9:30 to 16:00 New York time.
export async function usMarket() {
  const etNow = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .format(new Date())
    .replace(" ", "T");
  try {
    const d = (await cached("nq:market-info", 60e3, () => getJson("https://api.nasdaq.com/api/market-info", NQ)))?.data || {};
    if (!d.openRaw || !d.closeRaw) throw new Error("no market hours");
    const open = !!d.isBusinessDay && etNow >= d.openRaw && etNow < d.closeRaw;
    const closedToday = !!d.isBusinessDay && etNow >= d.closeRaw;
    const today = new Date(`${d.openRaw.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
    return { open, status: open ? "Market Open" : d.marketIndicator || "", lastSession: closedToday ? today : d.previousTradeDate || "" };
  } catch {
    const [date, time] = etNow.split("T");
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const open = day >= 1 && day <= 5 && time >= "09:30:00" && time < "16:00:00";
    return { open, status: open ? "Market Open" : "", lastSession: "" };
  }
}

export async function nasdaqScreener(kind = "stocks") {
  if (OFFLINE) return fixture("screener-us.json");
  return cached(`nq:screener:${kind}`, 60e3, async () => {
    // The full list (with sectors) is last-close data, so overlay live quotes on the 200 biggest.
    // stocks every ten minutes, so the last session's close and change are there soon after the bell
    const full = await cached(`nq:screener-full:${kind}`, kind === "etf" ? 6 * 3600e3 : 10 * 60e3, () =>
      getJson(
        `https://api.nasdaq.com/api/screener/${kind}?tableonly=true&limit=25&offset=0&download=true`,
        NQ,
      ),
    );
    const raw = full?.data?.rows || full?.data?.data?.rows || [];
    mark("nasdaq", true);
    const rows = raw
      .map((r) => ({
        ticker: r.symbol?.trim(),
        symbol: `US:${r.symbol?.trim()}`,
        name: r.name || r.companyName || "",
        price: num(r.lastsale ?? r.lastSalePrice),
        changePct: num(r.pctchange ?? r.percentageChange),
        volume: num(r.volume),
        marketCap: num(r.marketCap),
        sector: r.sector || (kind === "etf" ? "ETF" : ""),
        industry: r.industry || "",
        country: r.country || "",
        live: false,
      }))
      .filter((r) => r.ticker && !/[\^/]/.test(r.ticker));
    const top = [...rows]
      .sort((x, y) => y.marketCap - x.marketCap)
      .slice(0, 200);
    const market = await usMarket();
    try {
      const live = await nasdaqLiveQuotes(
        top.map((r) => r.ticker),
        kind === "etf" ? "etf" : "stocks",
      );
      for (const r of top) {
        const l = live[r.ticker];
        if (!l?.price) continue;
        // Outside the regular session the live price is a pre-market or after-hours trade: keep the
        // session's close and change apart (the heatmap colours by those), and the move since.
        const open = market.open;
        const close = r.price,
          sessionChange = r.changePct;
        Object.assign(r, {
          price: l.price,
          changePct: l.changePct,
          volume: l.volume || r.volume,
          live: true,
          session: l.status || "",
          regularPrice: open ? l.price : close,
          sessionChangePct: open ? l.changePct : sessionChange,
          extChangePct: !open && close > 0 ? (l.price / close - 1) * 100 : null,
        });
      }
    } catch {
      /* last-close data is still useful */
    }
    return rows;
  });
}

// Live quotes for US symbols, 20 per request.
async function nasdaqLiveQuotes(tickers, defaultClass) {
  const etfs = defaultClass
    ? new Set()
    : new Set(
        (await nasdaqScreener("etf").catch(() => [])).map((r) => r.ticker),
      );
  const out = {};
  const chunks = [];
  for (let i = 0; i < tickers.length; i += 20)
    chunks.push(tickers.slice(i, i + 20));
  await Promise.all(
    chunks.map(async (chunk) => {
      const qs = chunk
        .map((t) => {
          const cls =
            nqClass.get(t) ||
            defaultClass ||
            (etfs.has(t)
              ? "etf"
              : ["NDX", "COMP", "RUT", "DJI"].includes(t)
                ? "index"
                : "stocks");
          return `symbol=${encodeURIComponent(`${t.toLowerCase()}|${cls}`)}`;
        })
        .join("&");
      const j = await cached(`nq:wl:${qs}`, 5000, () =>
        getJson(`https://api.nasdaq.com/api/quote/watchlist?${qs}`, NQ),
      );
      for (const r of j?.data || [])
        out[r.symbol] = {
          price: num(r.lastSalePrice),
          changePct: num(r.percentageChange),
          ...(r.netChange != null ? { change: num(r.netChange) } : {}),
          volume: num(r.volume),
          status: r.marketStatus,
        };
    }),
  );
  return out;
}

// ---------- public API ----------
const dedupe = (bars) => {
  const out = [];
  for (const b of bars) {
    if (out.length && b.time <= out.at(-1).time) {
      if (b.time === out.at(-1).time) out[out.length - 1] = b;
      continue;
    }
    out.push(b);
  }
  return out;
};

function fixture(name) {
  return JSON.parse(
    readFileSync(path.join(here, "..", "test", "fixtures", name), "utf8"),
  );
}

async function tryChain(chain) {
  const errors = [];
  for (const [provider, fn] of chain) {
    try {
      const candles = await fn();
      if (candles.length) return { candles, provider, fallbacks: errors };
      errors.push(`${provider}: no data`);
    } catch (e) {
      errors.push(`${provider}: ${e.message}`);
    }
  }
  const err = new Error(
    `No source could load this chart. ${errors.join(" | ")}`,
  );
  err.status = 502;
  throw err;
}

function cryptoParts(ticker) {
  const m = /^(.+?)(USDT|USDC|FDUSD|USD|BTC|ETH|EUR|BNB)$/.exec(ticker);
  return m ? { base: m[1], quote: m[2] } : { base: ticker, quote: "USDT" };
}

async function spreadCandles(sym, tf, limit) {
  const { a, op, b } = parseSpread(sym.id);
  const side = async (x) =>
    isNumStr(x) ? { constant: Number(x) } : getCandles(x, tf, limit);
  const [ra, rb] = await Promise.all([side(a), side(b)]);
  const f = (x, y) =>
    op === "/" ? x / y : op === "*" ? x * y : op === "+" ? x + y : x - y;
  const combine = (ba, bb) => {
    const o = f(ba.open, bb.open),
      c = f(ba.close, bb.close);
    const pts = [o, c, f(ba.high, bb.high), f(ba.low, bb.low)].filter(
      Number.isFinite,
    );
    return {
      time: ba.time ?? bb.time,
      open: o,
      high: Math.max(...pts),
      low: Math.min(...pts),
      close: c,
      volume: 0,
    };
  };
  const k = (v) => ({ time: undefined, open: v, high: v, low: v, close: v });
  let candles;
  if (ra.constant !== undefined)
    candles = rb.candles.map((x) => combine(k(ra.constant), x));
  else if (rb.constant !== undefined)
    candles = ra.candles.map((x) => combine(x, k(rb.constant)));
  else {
    const byTime = new Map(rb.candles.map((x) => [x.time, x]));
    candles = ra.candles
      .filter((x) => byTime.has(x.time))
      .map((x) => combine(x, byTime.get(x.time)));
  }
  candles = candles.filter(
    (x) => Number.isFinite(x.open) && Number.isFinite(x.close),
  );
  if (!candles.length)
    throw Object.assign(
      new Error("The two symbols have no bars at the same times"),
      { status: 422 },
    );
  const from =
    [ra.provider, rb.provider].filter(Boolean).join(" + ") || "constant";
  return {
    symbol: sym.id,
    tf,
    provider: from,
    candles: candles.slice(-limit),
    notes: ["Spread built from both symbols' bars at matching times."],
  };
}

export async function getCandles(rawSymbol, tf = "1D", limit = 1500) {
  try {
    parseTf(tf);
  } catch (e) {
    throw badInput(e.message);
  }
  const asked = Math.max(10, Number(limit) || 1500);
  limit = Math.min(asked, 20000);
  const sym = await resolve(rawSymbol);
  // a symbol the history store holds can give far more bars than an exchange's API
  const stored = ["KRAKEN", "US", "BINANCE"].includes(sym.exchange) && parseTf(tf).seconds >= 60 && history.covers(sym.exchange, sym.ticker);
  if (stored) limit = Math.min(asked, history.MAX_BARS);
  if (sym.exchange === "SPREAD") return spreadCandles(sym, tf, limit);
  // Your own imported bars (data/imports/<NAME>.csv).
  if (sym.exchange === "CSV") return imports.csvCandles(sym.ticker, tf, limit);
  if (OFFLINE) {
    const bars = fixture("btc-1d.json");
    return {
      symbol: sym.id,
      tf,
      provider: "fixture",
      candles:
        tf === "1D" ? bars.slice(-limit) : resample(bars, tf).slice(-limit),
      notes: [],
    };
  }
  return cached(`candles:${sym.id}:${tf}:${limit}`, ttlFor(tf, sym), async () => {
    const t = sym.ticker;
    const notes = [],
      kraken = {};
    let chain, held;
    // A store that holds the symbol keeps its bars, and the live source fills in only from its last bar (that
    // bar too: it may have been stored unfinished), asking for just that stretch.
    const fromStore = (exchange, label, where) => {
      const st = history.bars(exchange, t, tf, limit);
      const cut = st?.candles.length ? st.candles.at(-1).time : null;
      if (cut != null) held = { st, cut, label, where };
      return cut == null ? limit : Math.min(limit, Math.ceil((Date.now() / 1000 - cut) / parseTf(tf).seconds) + 10);
    };
    if (sym.exchange === "BINANCE" && t.endsWith(".P")) {
      const pair = t.slice(0, -2);
      chain = [
        ["Binance futures", () => binanceCandles(pair, tf, limit, true)],
        ["Bybit", () => bybitCandles(pair, tf, limit)],
      ];
    } else if (sym.exchange === "BINANCE" && stored) {
      // Binance's own bars (Settings, Crypto data); no other exchange's bars after them
      const want = fromStore("BINANCE", "Binance's own bars", "Settings, Crypto data");
      chain = [["Binance", () => binanceCandles(t, tf, want)]];
    } else if (sym.exchange === "BINANCE") {
      const { base, quote } = cryptoParts(t);
      const usdQuote = ["USDT", "USDC", "FDUSD", "USD"].includes(quote);
      chain = [["Binance", () => binanceCandles(t, tf, limit)]];
      if (usdQuote) {
        chain.push([
          "Coinbase",
          () => coinbaseCandles(`${base}-USD`, tf, limit),
        ]);
        chain.push([
          "Kraken",
          () => krakenCandles(`${krakenAsset(base)}USD`, tf, limit),
        ]);
      }
    } else if (sym.exchange === "COINBASE") {
      chain = [["Coinbase", () => coinbaseCandles(t, tf, limit)]];
    } else if (sym.exchange === "KRAKEN") {
      chain = [["Kraken", () => (stored ? krakenWithHistory(t, tf, limit, kraken) : krakenCandles(t, tf, limit))]];
    } else if (sym.exchange === "FX" && METALS[t]) {
      const m = METALS[t];
      chain = feeds.fxChain(t, tf, limit).concat([["Yahoo", () => yahooCandles(m.yahoo, tf, limit)]]);
      if (m.token)
        chain.push(
          ["Binance", () => binanceCandles(`${m.token}USDT`, tf, limit)],
          ["Coinbase", () => coinbaseCandles(`${m.token}-USD`, tf, limit)],
        );
    } else if (sym.exchange === "FX") {
      chain = feeds.fxChain(t, tf, limit).concat([
        ["Yahoo", () => yahooCandles(`${t}=X`, tf, limit)],
        ["Kraken", () => krakenCandles(t, tf, limit)],
      ]);
    } else if (sym.exchange === "OANDA") {
      if (!feeds.hasOanda())
        throw badInput("OANDA symbols need your own OANDA token in data/feeds.json. See the README's own data feed section.");
      chain = [["OANDA", () => feeds.oandaCandles(t, tf, limit)]];
    } else if (sym.exchange === "CME" && FUTURES[t.replace(/1!$/, "")]) {
      const root = t.replace(/1!$/, "");
      chain = feeds.futuresChain(root, tf, limit).concat([
        ["Yahoo (delayed)", () => yahooCandles(FUTURES[root].yahoo, tf, limit)],
      ]);
    } else if (sym.exchange === "US") {
      // The stock history (Settings, Stock data) holds the whole market's bars to about an hour ago
      const want = stored ? fromStore("US", "The whole market's bars from Alpaca", "Settings, Stock data") : limit;
      // Your own keys (data/feeds.json) go first; the public sources stay behind them.
      const keys = feeds.stockChain(t, tf, want);
      const pub = isIntraday(tf)
        ? [
            ["Yahoo", () => yahooCandles(t, tf, want)],
            ["Nasdaq", () => nasdaqCandles(t, tf, want)],
          ]
        : [
            ["Nasdaq", () => nasdaqCandles(t, tf, want)],
            ["Yahoo", () => yahooCandles(t, tf, want)],
          ];
      // Except daily and longer on Alpaca's free IEX feed: IEX is one exchange, so its days end on IEX's last
      // trade with a few percent of the volume (AAPL: 34 of 42 closes off, Oct 2026). Nasdaq's and Yahoo's are
      // the official daily bars; IEX stands in when neither answers.
      const iex = (c) => c[0] === "Alpaca (IEX)";
      chain = isIntraday(tf) ? keys.concat(pub) : [...keys.filter((c) => !iex(c)), ...pub, ...keys.filter(iex)];
    } else {
      chain = [["Yahoo", () => yahooCandles(t, tf, limit)]];
    }
    let res;
    try {
      res = await tryChain(chain);
    } catch (e) {
      // the stored bars still chart when no live source answers
      if (!held) throw e;
      res = { candles: [], provider: "the history on this computer", fallbacks: [] };
    }
    if (held) {
      const { st, cut, label, where } = held;
      const tail = res.candles.filter((b) => b.time >= cut);
      if (tail.length && tail[0].time - cut > Math.max(3 * parseTf(tf).seconds, 4 * 86400))
        notes.push(`The history on this computer ends ${utcTime(cut)}, so this chart skips from there to ${utcTime(tail[0].time)}. It fills in with the next update (${where}).`);
      res.candles = [...st.candles.filter((b) => b.time < cut), ...tail].slice(-limit);
      kraken.source = [`${label}, stored on this computer: ${utcDay(st.candles[0].time)} to ${utcDay(cut)}.`, tail.length ? `The newest: live from ${res.provider}.` : "No live source is answering, so the chart stops at the stored bars."].join("\n");
    }
    // Plain words on the chart; the technical reason stays in the server log and /api/health.
    const keyFails = res.fallbacks.filter((f) => feeds.isKeyProvider(f));
    for (const f of keyFails) {
      const why = String(f).replace(/^[^:]*:\s*/, "");
      notes.push(`${why[0].toUpperCase()}${why.slice(1)}, so this chart uses ${res.provider}.`);
    }
    const publicFails = res.fallbacks.filter((f) => !feeds.isKeyProvider(f));
    if (publicFails.length) {
      const busy = [
        ...new Set(publicFails.map((f) => String(f).split(":")[0].trim())),
      ].join(" and ");
      notes.push(
        `${busy} isn't answering right now, so this chart uses ${res.provider}.`,
      );
    }
    if (res.provider === "Yahoo (delayed)")
      notes.push(
        "Delayed about 10 minutes, because CME charges for live futures data. Your own Polygon futures key in data/feeds.json makes it live.",
      );
    if (sym.exchange === "CME" && res.provider.startsWith("Polygon "))
      notes.push(
        `Front contract ${res.provider.slice(8)} from your Polygon key, not joined to older contracts. Whether it's live depends on your Polygon futures plan.`,
      );
    if (res.provider === "Alpaca (IEX)")
      notes.push(
        held
          ? "Stored bars are the whole market's; the newest come live from your Alpaca key on the free IEX feed, where volume counts IEX trades only."
          : "Live from your Alpaca key on the free IEX feed: prices are live, volume counts IEX trades only.",
      );
    if (res.provider === "OANDA")
      notes.push(
        "OANDA's own prices from your token, not exchange data: volume counts price changes, not contracts or shares.",
      );
    if (METALS[t] && res.provider !== "Yahoo" && res.provider !== "OANDA")
      notes.push(
        `This chart follows ${METALS[t].token}, a token backed by real gold, until Yahoo's gold feed is back.`,
      );
    if (sym.exchange === "US" && res.provider === "Nasdaq" && isIntraday(tf))
      notes.push(
        "Free intraday stock data covers today only and has no volume per bar. Older bars and volume appear when Yahoo is back.",
      );
    if (res.provider === "Kraken" && !stored)
      notes.push("Kraken's free feed shows the last 720 bars.");
    if (kraken.note) notes.push(kraken.note);
    return {
      symbol: sym.id,
      tf,
      provider: res.provider,
      // where the bars came from, for the legend title's tooltip (the history store's sources)
      source: kraken.source ?? null,
      candles: res.candles,
      // the most bars this symbol can give (the report's deep runs ask for up to this many)
      maxBars: stored ? history.MAX_BARS : 20000,
      notes,
    };
  });
}

// ---------- currency conversion ----------
// The price scale's currency menu (TradingView's currency conversion): a chart's prices in another
// currency, bar by bar. Every rate goes through the dollar: a currency's dollar value per bar comes
// from Yahoo's dollar rates (USDEUR=X is euros per dollar), a coin's from its USDT market (Binance
// first, then the crypto chain's fallbacks). USD and the dollar stablecoins count as exactly $1.
// The currencies are the ones Yahoo had a dollar rate for on 19 Oct 2026 (not ISK or BGN).
const FIAT_CUR = {
  USD: "US Dollar", EUR: "Euro", GBP: "British Pound", JPY: "Japanese Yen", CHF: "Swiss Franc", CAD: "Canadian Dollar",
  AUD: "Australian Dollar", NZD: "New Zealand Dollar", CNY: "Chinese Yuan", HKD: "Hong Kong Dollar", SGD: "Singapore Dollar",
  KRW: "South Korean Won", INR: "Indian Rupee", IDR: "Indonesian Rupiah", THB: "Thai Baht", MYR: "Malaysian Ringgit",
  PHP: "Philippine Peso", TWD: "New Taiwan Dollar", VND: "Vietnamese Dong", BRL: "Brazilian Real", MXN: "Mexican Peso",
  ARS: "Argentine Peso", CLP: "Chilean Peso", COP: "Colombian Peso", PEN: "Peruvian Sol", ZAR: "South African Rand",
  TRY: "Turkish Lira", RUB: "Russian Ruble", SEK: "Swedish Krona", NOK: "Norwegian Krone", DKK: "Danish Krone",
  PLN: "Polish Zloty", CZK: "Czech Koruna", HUF: "Hungarian Forint", RON: "Romanian Leu", ILS: "Israeli New Shekel",
  AED: "United Arab Emirates Dirham", SAR: "Saudi Riyal", QAR: "Qatari Riyal", KWD: "Kuwaiti Dinar", EGP: "Egyptian Pound",
  NGN: "Nigerian Naira", KES: "Kenyan Shilling", PKR: "Pakistani Rupee", BDT: "Bangladeshi Taka", UAH: "Ukrainian Hryvnia",
  AFN: "Afghan Afghani",
};
// Coins, offered when Binance lists them against USDT.
const CRYPTO_CUR = {
  "1INCH": "1inch", AAVE: "Aave", ADA: "Cardano", ALGO: "Algorand", APT: "Aptos", ARB: "Arbitrum", ATOM: "Cosmos",
  AVAX: "Avalanche", BCH: "Bitcoin Cash", BNB: "BNB", BTC: "Bitcoin", CRV: "Curve DAO", DOGE: "Dogecoin", DOT: "Polkadot",
  ENA: "Ethena", ETC: "Ethereum Classic", ETH: "Ethereum", FIL: "Filecoin", HBAR: "Hedera", ICP: "Internet Computer",
  INJ: "Injective", LDO: "Lido DAO", LINK: "Chainlink", LTC: "Litecoin", NEAR: "NEAR Protocol", OP: "Optimism", PEPE: "Pepe",
  POL: "Polygon", SHIB: "Shiba Inu", SOL: "Solana", SUI: "Sui", TAO: "Bittensor", TON: "Toncoin", TRX: "TRON", UNI: "Uniswap",
  USDC: "USD Coin", USDT: "Tether", WIF: "dogwifhat", XLM: "Stellar", XRP: "XRP",
};
const DOLLARS = new Set(["USD", "USDT", "USDC"]);

export async function currencyList() {
  let listed = () => true;
  try {
    const m = await binanceSymbolMap();
    listed = (c) => m.has(`${c}USDT`);
  } catch {
    /* Binance unreachable: offer them all, the fallbacks may still have them */
  }
  return [
    ...Object.entries(FIAT_CUR).map(([code, name]) => ({ code, name, kind: "fiat" })),
    ...Object.entries(CRYPTO_CUR)
      .filter(([c]) => DOLLARS.has(c) || listed(c))
      .map(([code, name]) => ({ code, name, kind: "crypto" })),
  ].sort((a, b) => a.code.localeCompare(b.code));
}

// Dollars per one unit of a currency, bar by bar (null: exactly one dollar).
async function usdPer(cur, tf, limit) {
  if (DOLLARS.has(cur)) return null;
  if (FIAT_CUR[cur])
    // kept two minutes: currency rates move slowly, and Yahoo's allowance is shared with stock charts
    return cached(`usdper:${cur}:${tf}:${limit}`, 120e3, async () =>
      (await yahooCandles(`USD${cur}=X`, tf, limit)).filter((b) => b.close > 0).map((b) => ({ time: b.time, v: 1 / b.close })),
    );
  if (CRYPTO_CUR[cur]) return (await getCandles(`BINANCE:${cur}USDT`, tf, limit)).candles.map((b) => ({ time: b.time, v: b.close }));
  throw badInput(`A chart can't be shown in ${cur}`);
}

// Units of `to` per unit of `from`, per bar, from `since` (unix seconds) to now. Under a minute the
// rate is per minute (Yahoo has nothing finer).
export async function conversionRate(from, to, tf = "1D", since = 0) {
  from = String(from || "").toUpperCase();
  to = String(to || "").toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(from) || !/^[A-Z0-9]{2,10}$/.test(to)) throw badInput("Use currency codes like USD or EUR");
  const rtf = parseTf(tf).seconds < 60 ? "1m" : tf,
    sec = parseTf(rtf).seconds;
  const span = Math.max(sec, Date.now() / 1000 - (Number(since) || 0));
  // whole steps of 250 bars, so a chart that's open for a while keeps hitting the cache
  const limit = Math.min(5000, Math.ceil((span / sec + 5) / 250) * 250);
  return cached(`conv:${from}:${to}:${rtf}:${limit}`, ttlFor(rtf), async () => {
    const [a, b] = await Promise.all([usdPer(from, rtf, limit), usdPer(to, rtf, limit)]);
    let rates;
    if (!a && !b) rates = [{ time: 0, rate: 1 }];
    else if (!b) rates = a.map((x) => ({ time: x.time, rate: x.v }));
    else if (!a) rates = b.map((x) => ({ time: x.time, rate: 1 / x.v }));
    else {
      // on the times of the busier series, the other one as it stood then
      const [base, other, flip] = a.length >= b.length ? [a, b, false] : [b, a, true];
      rates = [];
      let j = -1;
      for (const x of base) {
        while (j + 1 < other.length && other[j + 1].time <= x.time) j++;
        if (j < 0) continue;
        rates.push({ time: x.time, rate: flip ? other[j].v / x.v : x.v / other[j].v });
      }
    }
    // how often a live chart asks again: a coin moves by the second, currencies slowly
    const coin = [from, to].some((c) => CRYPTO_CUR[c] && !DOLLARS.has(c));
    return { from, to, tf: rtf, refresh: coin ? 30 : 300, rates: rates.filter((r) => Number.isFinite(r.rate) && r.rate > 0) };
  });
}

// Latest price and day change for a list of symbols (watchlists, paper trading, heatmaps).
export async function getQuotes(symbols) {
  const out = {};
  const resolved = await Promise.all(
    symbols.map((s) => resolve(s).catch(() => null)),
  );
  const binance = resolved
    .filter((r) => r?.exchange === "BINANCE" && !r.ticker.endsWith(".P"))
    .map((r) => r.ticker);
  if (binance.length && !OFFLINE) {
    try {
      const rows = await cached(
        `binance:24h:${binance.sort().join(",")}`,
        3000,
        () =>
          binanceGet(
            `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(binance))}`,
          ),
      );
      for (const r of rows)
        out[`BINANCE:${r.symbol}`] = {
          price: +r.lastPrice,
          changePct: +r.priceChangePercent,
          volume: +r.quoteVolume,
        };
    } catch {
      /* fall through to candles */
    }
  }
  const us = resolved.filter((r) => r?.exchange === "US");
  if (us.length && !OFFLINE) {
    try {
      const live = await nasdaqLiveQuotes(us.map((r) => r.ticker));
      for (const r of us) if (live[r.ticker]) out[r.id] = live[r.ticker];
    } catch {
      /* fall through to candles */
    }
  }
  await Promise.all(
    resolved.map(async (r) => {
      if (!r || out[r.id]) return;
      try {
        const { candles } = await getCandles(r.id, "1D", 3);
        const last = candles.at(-1),
          prev = candles.at(-2);
        out[r.id] = {
          price: last.close,
          changePct: prev ? ((last.close - prev.close) / prev.close) * 100 : 0,
          volume: last.volume,
        };
      } catch (e) {
        out[r.id] = { error: e.message };
      }
    }),
  );
  return out;
}

// Live bid and ask for the tester's spread setting. Only the crypto exchanges publish one for free.
export async function getSpread(rawSymbol) {
  const sym = await resolve(rawSymbol);
  let bid, ask, source;
  if (sym.exchange === "BINANCE" && sym.ticker.endsWith(".P")) {
    const r = await binanceFuturesGet(`/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(sym.ticker.slice(0, -2))}`);
    [bid, ask, source] = [+r.bidPrice, +r.askPrice, "Binance futures"];
  } else if (sym.exchange === "BINANCE") {
    const r = await binanceGet(`/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(sym.ticker)}`);
    [bid, ask, source] = [+r.bidPrice, +r.askPrice, "Binance"];
  } else if (sym.exchange === "COINBASE") {
    const r = await getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(sym.ticker)}/ticker`);
    [bid, ask, source] = [+r.bid, +r.ask, "Coinbase"];
  } else if (sym.exchange === "KRAKEN") {
    const j = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(sym.ticker)}`);
    if (j.error?.length) throw new Error(`Kraken: ${j.error.join(", ")}`);
    const r = Object.values(j.result)[0];
    [bid, ask, source] = [+r.b[0], +r.a[0], "Kraken"];
  } else throw badInput("A live spread is only published for crypto (Binance, Coinbase and Kraken). Enter one by hand for this market.");
  if (!(bid > 0 && ask >= bid)) throw new Error(`${source} sent no usable bid and ask`);
  return { symbol: sym.id, bid, ask, spreadPct: (200 * (ask - bid)) / (ask + bid), source };
}

export async function search(q) {
  const query = String(q || "")
    .trim()
    .toUpperCase();
  if (!query) return [];
  const results = [];
  for (const f of imports.listImports())
    if (!f.error && (f.name.includes(query.replace(/^CSV:/, "")) || query === "CSV"))
      results.push({
        symbol: f.symbol,
        name: `Your file, ${f.bars.toLocaleString()} ${f.tf} bars`,
        type: "your data",
        exchange: "CSV",
      });
  if (query.startsWith("OANDA:") && query.length > 6)
    results.push({
      symbol: query,
      name: "From your OANDA token",
      type: "your feed",
      exchange: "OANDA",
    });
  const root = query.replace(/^CME(_MINI)?:/, "").replace(/1!?$/, "");
  for (const [t, f] of Object.entries(FUTURES))
    if (
      (root.length >= 2 && t.startsWith(root)) ||
      (query.length >= 4 && f.name.toUpperCase().includes(query))
    )
      results.push({
        symbol: `CME:${t}1!`,
        name: f.name,
        type: "futures",
        exchange: "CME",
      });
  for (const [t, m] of Object.entries(METALS))
    if (
      query.length >= 2 &&
      (t.startsWith(query.replace("/", "")) || m.word.startsWith(query))
    )
      results.push({
        symbol: `FX:${t}`,
        name: m.name,
        type: "commodity",
        exchange: "FX",
      });
  const bin = await binanceSymbolMap();
  // what was typed without a perpetual's .P or PERP, then Kraken's XBT and XDG as everyone else names them
  const typed = query.replace(/^BINANCE:/, "").replace(/[-/]?(\.P|PERP)$/, "");
  const coin = commonCoin(typed);
  const cryptoHits = [...bin.entries()]
    .filter(([t, s]) => t.startsWith(coin) || s.base === coin)
    .sort(
      (a, b) =>
        (a[1].quote === "USDT" ? -1 : 0) - (b[1].quote === "USDT" ? -1 : 0) ||
        a[0].length - b[0].length,
    )
    .slice(0, 8)
    .map(([t, s]) => ({
      symbol: `BINANCE:${t}`,
      name: `${s.base} / ${s.quote}`,
      type: "crypto",
      exchange: "Binance",
    }));
  // The same coin on Coinbase's and Kraken's own feeds, the way TradingView lists one row per exchange,
  // straight after the main Binance pair.
  const feeds = [];
  const bases = [
    ...new Set(cryptoHits.map((h) => h.name.split(" / ")[0])),
  ].slice(0, 3);
  if (bases.length && !OFFLINE) {
    const [cb, kr] = await Promise.all([coinbaseProducts(), krakenPairs()]);
    for (const b of bases) {
      if (cb.has(`${b}-USD`))
        feeds.push({
          symbol: `COINBASE:${b}-USD`,
          name: `${b} / USD`,
          type: "crypto",
          exchange: "Coinbase",
        });
      if (kr.has(`${b}USD`))
        feeds.push({
          symbol: `KRAKEN:${kr.get(`${b}USD`)}`,
          name: `${b} / USD`,
          type: "crypto",
          exchange: "Kraken",
        });
    }
  }
  // The perpetual future for the same coin, as TradingView lists BTCUSDT.P under BTCUSDT.
  const perps = bases.length ? await perpSymbols() : new Set();
  for (const b of bases)
    if (perps.has(`${b}USDT`))
      feeds.push({
        symbol: `BINANCE:${b}USDT.P`,
        name: `${b} / USDT perpetual`,
        type: "futures",
        exchange: "Binance",
      });
  const perpFirst = typed !== query.replace(/^BINANCE:/, "");
  const isPerp = (f) => f.symbol.endsWith(".P");
  results.push(
    ...(perpFirst ? feeds.filter(isPerp) : []),
    ...cryptoHits.slice(0, 1),
    ...feeds.filter((f) => !perpFirst || !isPerp(f)),
    ...cryptoHits.slice(1),
  );
  for (const a of FIAT)
    for (const b of FIAT) {
      if (a !== b && `${a}${b}`.startsWith(query.replace("/", "")))
        results.push({
          symbol: `FX:${a}${b}`,
          name: `${a} / ${b}`,
          type: "forex",
          exchange: "FX",
        });
    }
  if (!OFFLINE) {
    const tasks = [
      getJson(
        `https://api.nasdaq.com/api/autocomplete/slookup/10?search=${encodeURIComponent(q)}`,
        NQ,
      )
        .then((j) =>
          // Nasdaq also lists coins (asset CRYPTO, no exchange). As US:XRP they load nothing and
          // hide a real stock or ETF with the same ticker; coins come from the crypto exchanges.
          (j?.data || []).filter((r) => String(r.asset || "").toUpperCase() !== "CRYPTO").map((r) => ({
            symbol: `US:${r.symbol}`,
            name: r.name,
            type: (r.asset || r.subCategory || "stock").toLowerCase(),
            exchange: r.exchange || "US",
          })),
        )
        .catch(() => []),
      yahooAvailable()
        ? getJson(
            `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
            YAHOO,
          )
            .then((j) =>
              (j?.quotes || [])
                .filter(
                  (r) =>
                    r.symbol &&
                    !/^[A-Z]+$/.test(r.symbol) &&
                    r.quoteType !== "CRYPTOCURRENCY",
                )
                .map((r) => ({
                  symbol: `YAHOO:${r.symbol}`,
                  name: r.shortname || r.longname || r.symbol,
                  type: (r.quoteType || "").toLowerCase(),
                  exchange: r.exchDisp || "Yahoo",
                })),
            )
            .catch((e) => {
              if (e.status === 429) yahooDownUntil = Date.now() + 10 * 60e3;
              return [];
            })
        : Promise.resolve([]),
    ];
    for (const list of await Promise.all(tasks)) results.push(...list);
  }
  // What was typed in full goes first: AMD the stock before AMDBUSDT, Binance's AMD token. Forex and metals lead
  // the exact matches (EURUSD the pair before Kraken's EUR/USD, GOLD and XAU as gold); otherwise exact matches
  // keep their order (BTC: Bitcoin's pairs, then the US fund whose ticker is BTC), and so does the rest.
  const exact = (r) => {
    const t = r.symbol.slice(r.symbol.indexOf(":") + 1).replace(/1!$/, ""),
      base = r.name.split(" / ")[0].toUpperCase();
    if (r.exchange === "FX") return t === query || t === `${query}USD` || base === query ? 2 : 0;
    return t === query || (r.type === "crypto" && base === coin) ? 1 : 0;
  };
  const seen = new Set();
  return results
    .filter((r) => !seen.has(r.symbol) && seen.add(r.symbol))
    .sort((a, b) => exact(b) - exact(a))
    .slice(0, 30);
}

export async function cryptoScreener() {
  if (OFFLINE) return fixture("screener-crypto.json");
  return cached("screener:crypto", 20e3, async () => {
    try {
      const bin = await binanceSymbolMap();
      const rows = await binanceGet("/api/v3/ticker/24hr");
      return rows
        .filter(
          (r) =>
            bin.get(r.symbol)?.quote === "USDT" &&
            !/(UP|DOWN|BULL|BEAR)USDT$/.test(r.symbol) &&
            +r.quoteVolume > 0,
        )
        .map((r) => ({
          ticker: r.symbol,
          symbol: `BINANCE:${r.symbol}`,
          name: bin.get(r.symbol).base,
          price: +r.lastPrice,
          changePct: +r.priceChangePercent,
          volume: +r.quoteVolume,
          high: +r.highPrice,
          low: +r.lowPrice,
          sector: "Crypto",
        }));
    } catch {
      // Binance blocked: Kraken's ticker (change measured from today's UTC open)
      const j = await getJson("https://api.kraken.com/0/public/Ticker");
      return Object.entries(j.result || {})
        .filter(
          ([k]) => /USD$/.test(k) && !/USDT?USD$|^Z|EURUSD|GBPUSD/.test(k),
        )
        .map(([k, v]) => ({
          ticker: k,
          symbol: `KRAKEN:${k}`,
          name: k.replace(/USD$/, "").replace(/^X(?=[A-Z]{3}$)/, ""),
          price: +v.c[0],
          changePct: ((+v.c[0] - +v.o) / +v.o) * 100,
          volume: +v.v[1] * +v.p[1],
          sector: "Crypto",
        }));
    }
  });
}

// The calendar's feed answers 429 when it's asked too often, and then every panel and chart asked again. So the
// last good copy is kept on disk (data/calendar-cache.json) and served while the feed fails, and after a failure
// the feed isn't asked again for a while: 15 minutes after a 429, 5 after anything else.
let calendarWaitUntil = 0;
export async function economicCalendar() {
  if (OFFLINE) return [];
  const last = () => store.read("calendar-cache", null)?.rows;
  if (Date.now() < calendarWaitUntil) {
    const rows = last();
    if (rows) return rows;
    throw upstreamError("the economic calendar is busy; trying again in a few minutes", 503);
  }
  try {
    return await cached("calendar", 30 * 60e3, async () => {
      const rows = (
        await getJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json")
      ).map((r) => ({
        title: r.title,
        country: r.country,
        date: r.date,
        impact: r.impact,
        forecast: r.forecast,
        previous: r.previous,
      }));
      mark("calendar", true);
      try {
        store.write("calendar-cache", { at: new Date().toISOString(), rows });
      } catch {
        /* a full disk: this copy still serves until the next one */
      }
      return rows;
    });
  } catch (e) {
    calendarWaitUntil = Date.now() + (e.status === 429 ? 15 : 5) * 60e3;
    mark("calendar", false, e);
    const rows = last();
    if (rows) return rows;
    throw e;
  }
}

export async function probeAll() {
  const checks = {
    "Binance (crypto)": () => binanceGet("/api/v3/ping"),
    "Coinbase (crypto fallback)": () =>
      getJson("https://api.exchange.coinbase.com/products/BTC-USD/ticker"),
    "Kraken (crypto + forex)": () =>
      getJson("https://api.kraken.com/0/public/Time"),
    "Nasdaq (US stocks)": () =>
      getJson(
        "https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks",
        NQ,
      ),
    "Yahoo (global, intraday stocks)": () =>
      getJson(
        "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d",
        YAHOO,
      ),
    "Economic calendar": () =>
      getJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
    ...feeds.probes(),
  };
  const out = {};
  await Promise.all(
    Object.entries(checks).map(async ([name, fn]) => {
      const t = Date.now();
      try {
        await fn();
        out[name] = { ok: true, ms: Date.now() - t };
      } catch (e) {
        out[name] = { ok: false, error: e.message };
      }
    }),
  );
  return out;
}

export { getJson, cached, NQ };
