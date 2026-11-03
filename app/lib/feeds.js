// Your own market data keys, optional. The free public sources stay the default; a key you add
// takes over the charts it covers, and the public sources stay behind it as the fallback.
//
// Keys live in data/feeds.json on this computer (the data folder is never in git and an update
// keeps it). Each key is only ever sent to its own provider, in a request header:
//
//   {
//     "alpaca":  { "keyId": "PK...", "secretKey": "...", "feed": "iex" },
//     "polygon": { "apiKey": "..." },
//     "oanda":   { "token": "...", "account": "practice" }
//   }
//
//   Alpaca   US stocks. A free Alpaca account gives live prices on the IEX feed ("feed": "sip" if
//            you pay for Alpaca's full feed).
//   Polygon  US stocks, and CME futures (NQ, MNQ, ES, MES) on a Polygon futures plan. Polygon is
//            now called Massive; same keys. Live or delayed depends on your Polygon plan: the free
//            plan is end-of-day only.
//   OANDA    Forex and metals, plus anything your account lists as OANDA:XAU_USD or OANDA:NAS100_USD.
//            These are OANDA's own prices, not exchange data. "account" is "practice" for a free
//            demo account's token or "live" for a real account's; each only works on its own server.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./store.js";
import {
  parseTf,
  resample,
  nativeBase,
  isIntraday,
} from "../public/lib/series.js";

export const FEEDS_FILE = path.join(DATA_DIR, "feeds.json");
const TIMEOUT_MS = Number(process.env.QT_TIMEOUT_MS) || 10000;
// (the tests point these at a stand-in)
const ALPACA = process.env.QT_ALPACA_BASE || "https://data.alpaca.markets";
const POLYGON = process.env.QT_POLYGON_BASE || "https://api.massive.com";
const OANDA = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

// Re-read when the file changes, so a key you add works without a restart.
let memo = { mtime: -1, value: {} };
export function feedConfig() {
  let st;
  try {
    st = fs.statSync(FEEDS_FILE);
  } catch {
    return {};
  }
  if (st.mtimeMs !== memo.mtime) {
    let value = {};
    try {
      value = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8")) || {};
    } catch (e) {
      console.error(
        `data/feeds.json isn't valid JSON, so your own keys are off: ${e.message}`,
      );
    }
    memo = { mtime: st.mtimeMs, value };
  }
  return memo.value;
}
const alpacaCfg = () => {
  const a = feedConfig().alpaca;
  return a?.keyId && a?.secretKey ? a : null;
};
const polygonCfg = () => {
  const c = feedConfig();
  const p = c.polygon || c.massive;
  return p?.apiKey ? p : null;
};
const oandaCfg = () => {
  const o = feedConfig().oanda;
  return o?.token ? o : null;
};
const oandaHost = () => (oandaCfg()?.account === "live" ? OANDA.live : OANDA.practice);
export const hasOanda = () => Boolean(oandaCfg());
// Names only: the keys themselves never leave this module.
export const configured = () =>
  [alpacaCfg() && "alpaca", polygonCfg() && "polygon", oandaCfg() && "oanda"].filter(Boolean);

// ---------- Settings, Stock data: your own keys, saved, checked and removed from the page ----------
// The page only ever learns whether a key is saved and its last 4 characters; a key goes from the page
// to this file and to its own provider, never back.
const KEY_RE = /^[A-Za-z0-9_\-+/=.]{8,200}$/;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
export function keysStatus() {
  const a = alpacaCfg(),
    p = polygonCfg();
  return {
    alpaca: a ? { set: true, hint: String(a.keyId).slice(-4), feed: a.feed === "sip" ? "sip" : "iex" } : { set: false },
    polygon: p ? { set: true, hint: String(p.apiKey).slice(-4) } : { set: false },
  };
}

// One cheap request each provider refuses with 401 or 403 for a bad key (or, on Alpaca, a feed the
// account doesn't have). ok, or bad (refused: not saved), or unreachable (saved, with a note).
async function checkKey(provider, k, fetchImpl) {
  const req =
    provider === "alpaca"
      ? [`${ALPACA}/v2/stocks/AAPL/bars/latest?feed=${k.feed}`, { "APCA-API-KEY-ID": k.keyId, "APCA-API-SECRET-KEY": k.secretKey }]
      : [`${POLYGON}/v2/aggs/ticker/AAPL/prev`, { Authorization: `Bearer ${k.apiKey}` }];
  const name = provider === "alpaca" ? "Alpaca" : "Polygon (Massive)";
  let r;
  try {
    r = await fetchImpl(req[0], { headers: req[1], signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, unreachable: true, message: `Couldn't reach ${name} to check it (${e.message}).` };
  }
  if (r.ok) return { ok: true };
  const body = await r.json().catch(() => ({}));
  // the provider's own words, never the key
  let msg = String(body.message || body.error || `HTTP ${r.status}`);
  for (const v of Object.values(k)) if (v && String(v).length > 5) msg = msg.split(String(v)).join("…");
  if (r.status === 401 || r.status === 403) return { ok: false, message: `${name} didn't accept it: ${msg}` };
  return { ok: false, unreachable: true, message: `${name} answered ${r.status} (${msg}), so it couldn't be checked.` };
}

function writeKeys(change) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8")) || {};
  } catch {
    /* none yet, or unreadable: start again */
  }
  change(raw);
  fs.mkdirSync(path.dirname(FEEDS_FILE), { recursive: true });
  const tmp = `${FEEDS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FEEDS_FILE);
  fs.chmodSync(FEEDS_FILE, 0o600);
  // read afresh next time, even if two saves land in the same millisecond
  memo = { mtime: -1, value: {} };
}

// Save a key after its provider has checked it. Refused: nothing is saved. Unreachable: saved anyway,
// with a note, so a provider being down doesn't stop you.
export async function saveKey(body = {}, { fetchImpl = fetch } = {}) {
  const provider = body.provider;
  let k;
  if (provider === "alpaca") {
    k = { keyId: String(body.keyId || "").trim(), secretKey: String(body.secretKey || "").trim(), feed: body.feed === "sip" ? "sip" : "iex" };
    // only the feed changed: the saved key stays
    const saved = alpacaCfg();
    if (!k.keyId && !k.secretKey && saved) Object.assign(k, { keyId: saved.keyId, secretKey: saved.secretKey });
    if (!KEY_RE.test(k.keyId) || !KEY_RE.test(k.secretKey)) throw bad("Paste Alpaca's key ID and secret key, as Alpaca shows them.");
  } else if (provider === "polygon") {
    k = { apiKey: String(body.apiKey || "").trim() };
    if (!KEY_RE.test(k.apiKey)) throw bad("Paste the API key, as Polygon (Massive) shows it.");
  } else throw bad("Pick a provider: alpaca or polygon.");
  const check = await checkKey(provider, k, fetchImpl);
  if (!check.ok && !check.unreachable) throw bad(check.message);
  writeKeys((raw) => {
    raw[provider] = k;
    if (provider === "polygon") delete raw.massive;
  });
  return { ...keysStatus(), note: check.ok ? "" : check.message };
}

export async function testKey(provider, { fetchImpl = fetch } = {}) {
  const k = provider === "alpaca" ? alpacaCfg() : provider === "polygon" ? polygonCfg() : null;
  if (!k) throw bad("There's no saved key for that provider.");
  const check = await checkKey(provider, { ...k, feed: k.feed === "sip" ? "sip" : "iex" }, fetchImpl);
  return { ok: check.ok, message: check.ok ? "It works." : check.message };
}

export function removeKey(provider) {
  if (provider !== "alpaca" && provider !== "polygon") throw bad("Pick a provider: alpaca or polygon.");
  writeKeys((raw) => {
    delete raw[provider];
    if (provider === "polygon") delete raw.massive;
  });
  return keysStatus();
}
export const alpacaName = () =>
  `Alpaca (${String(alpacaCfg()?.feed || "iex").toUpperCase()})`;
// Every name a key provider can show on a chart, so fallback notes can say "your key".
export const isKeyProvider = (name) => /^(Alpaca|Polygon|OANDA)\b/.test(String(name));

// ---------- requests ----------
const feedError = (message, status) =>
  Object.assign(new Error(message), { status, upstream: true });
// A provider that rate limits or refuses the key is skipped for a minute, so every chart on screen
// doesn't hit it again; the public sources carry the charts meanwhile.
const resting = new Map(); // name -> { until, why }

async function getFeed(name, url, headers) {
  const rest = resting.get(name);
  if (rest && rest.until > Date.now()) throw feedError(rest.why, rest.status);
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw feedError(`${name} couldn't be reached`, e.name === "TimeoutError" ? "timeout" : e.cause?.code);
  }
  if (!res.ok) {
    // Plain words for the chart; the provider's own message stays on the error for logs.
    let detail = "";
    try {
      const j = await res.json();
      detail = String(j.message || j.errorMessage || j.error || "").slice(0, 200);
    } catch {
      /* no body */
    }
    const why =
      res.status === 401
        ? `${name} refused your key`
        : res.status === 403
          ? `your ${name} plan doesn't include this`
          : res.status === 429
            ? `${name} is rate limiting your key`
            : `${name} returned an error`;
    if (res.status === 401 || res.status === 429)
      resting.set(name, { until: Date.now() + 60e3, why, status: res.status });
    throw Object.assign(feedError(why, res.status), { detail });
  }
  return res.json();
}

// ---------- shared ----------
// New York's UTC offset for each day, worked out once per day rather than once per bar.
const nyOffset = new Map();
function nyOffsetHours(sec) {
  const day = Math.floor(sec / 86400);
  if (!nyOffset.has(day)) {
    const h = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hourCycle: "h23",
      }).format(new Date((day * 86400 + 12 * 3600) * 1000)),
    );
    nyOffset.set(day, 12 - h);
  }
  return nyOffset.get(day);
}
// 09:30 to 16:00 New York, the same session the free sources chart.
export function inUsSession(sec) {
  const local = (((sec - nyOffsetHours(sec) * 3600) % 86400) + 86400) % 86400;
  return local >= 34200 && local < 57600;
}

// How far back to ask for `want` bars of `base`, with room for weekends, holidays and a stock's
// 6.5-hour day.
function startFor(base, want, earliest) {
  const sec = parseTf(base).seconds;
  const tradingDays = isIntraday(base) ? want / (23400 / sec) : want;
  const days = Math.ceil(tradingDays * 1.5) + 5;
  const t = Math.max(Date.now() - days * 86400e3, earliest);
  return new Date(t).toISOString().slice(0, 10);
}

// Daily bars carry the trading date as UTC midnight, like every other source in the app.
const dayOf = (sec) => Math.floor(sec / 86400) * 86400;

function finish(bars, base, tf, limit) {
  const asc = bars.sort((a, b) => a.time - b.time);
  const out = [];
  for (const b of asc) if (!out.length || b.time > out.at(-1).time) out.push(b);
  return base === tf ? out.slice(-limit) : resample(out, tf).slice(-limit);
}

// ---------- Alpaca (US stocks) ----------
const ALPACA_TF = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "30m": "30Min",
  "1D": "1Day",
};

export async function alpacaCandles(ticker, tf, limit) {
  const k = alpacaCfg();
  if (!k) throw new Error("No Alpaca key in data/feeds.json");
  if (parseTf(tf).seconds < 60) return alpacaTradeCandles(ticker, tf, limit, k);
  const base = nativeBase(tf, Object.keys(ALPACA_TF));
  if (!base) throw new Error(`Alpaca can't build a ${tf} chart`);
  const intraday = isIntraday(base);
  const ratio = Math.max(
    1,
    Math.round(parseTf(tf).seconds / parseTf(base).seconds),
  );
  const want = Math.min(limit * ratio + ratio, 60000);
  const headers = {
    "APCA-API-KEY-ID": k.keyId,
    "APCA-API-SECRET-KEY": k.secretKey,
  };
  const out = [];
  let token = null;
  for (let page = 0; page < 12 && out.length < want; page++) {
    const q = new URLSearchParams({
      symbols: ticker,
      timeframe: ALPACA_TF[base],
      start: startFor(base, want, Date.UTC(2016, 0, 1)),
      limit: "10000",
      feed: String(k.feed || "iex"),
      adjustment: "split",
      sort: "desc",
    });
    if (token) q.set("page_token", token);
    const j = await getFeed("Alpaca", `${ALPACA}/v2/stocks/bars?${q}`, headers);
    for (const b of j?.bars?.[ticker] || []) {
      const t = Math.floor(Date.parse(b.t) / 1000);
      if (intraday && !inUsSession(t)) continue;
      out.push({
        time: intraday ? t : dayOf(t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v || 0,
      });
    }
    token = j?.next_page_token;
    if (!token) break;
  }
  return finish(out, base, tf, limit);
}

// Sub-minute stock bars (1s, 5s, 15s...), built from Alpaca's IEX trades: Alpaca has no bars under a
// minute. The first load pages back through recent trades; a live poll (a handful of bars) takes
// only the latest 500, newest first, so a chart polling every second costs one small call and
// always gets an answer the cache can keep, even when the market is closed. IEX is one exchange (a
// few percent of US volume), so quiet seconds have no trade and no bar.
async function alpacaTradeCandles(ticker, tf, limit, k) {
  const sec = parseTf(tf).seconds;
  const headers = {
    "APCA-API-KEY-ID": k.keyId,
    "APCA-API-SECRET-KEY": k.secretKey,
  };
  const live = limit <= 20;
  const pageSize = live ? 500 : 10000;
  const buckets = new Map();
  let token = null;
  let cutOff = false; // the oldest bar may be missing trades from before the last page
  for (let page = 0; page < (live ? 1 : 6); page++) {
    const q = new URLSearchParams({
      symbols: ticker,
      start: new Date(Date.now() - 5 * 86400e3).toISOString(),
      limit: String(pageSize),
      feed: "iex",
      sort: "desc",
    });
    if (token) q.set("page_token", token);
    const j = await getFeed("Alpaca", `${ALPACA}/v2/stocks/trades?${q}`, headers);
    const trades = j?.trades?.[ticker] || [];
    token = j?.next_page_token;
    cutOff = Boolean(token) || (live && trades.length >= pageSize);
    for (const tr of trades) {
      const ms = Date.parse(tr.t);
      if (!inUsSession(ms / 1000)) continue;
      const time = Math.floor(ms / 1000 / sec) * sec;
      const b = buckets.get(time);
      if (!b) buckets.set(time, { time, first: ms, last: ms, open: tr.p, high: tr.p, low: tr.p, close: tr.p, volume: tr.s || 0 });
      else {
        if (ms < b.first) { b.first = ms; b.open = tr.p; }
        if (ms >= b.last) { b.last = ms; b.close = tr.p; }
        b.high = Math.max(b.high, tr.p);
        b.low = Math.min(b.low, tr.p);
        b.volume += tr.s || 0;
      }
    }
    if (!token || buckets.size > limit) break;
  }
  if (cutOff && buckets.size > 1) buckets.delete(Math.min(...buckets.keys()));
  const out = [...buckets.values()].map(({ first, last, ...bar }) => bar);
  return finish(out, tf, tf, limit);
}

// True while US stocks trade (weekdays 9:30-16:00 New York; holidays not counted).
export function usMarketOpen(sec = Date.now() / 1000) {
  const day = new Date((sec - nyOffsetHours(sec) * 3600) * 1000).getUTCDay();
  return day >= 1 && day <= 5 && inUsSession(sec);
}

// ---------- Polygon / Massive (US stocks) ----------
const POLYGON_TF = {
  "1m": [1, "minute"],
  "5m": [5, "minute"],
  "15m": [15, "minute"],
  "30m": [30, "minute"],
  "1D": [1, "day"],
};

async function polygonPages(firstUrl, want, eachRow) {
  const headers = { Authorization: `Bearer ${polygonCfg().apiKey}` };
  let url = firstUrl,
    n = 0;
  for (let page = 0; url && page < 6 && n < want; page++) {
    const j = await getFeed("Polygon", url, headers);
    for (const r of j?.results || []) if (eachRow(r)) n++;
    // next_url is Polygon's own link to the next page; the key goes in the header, never the URL.
    url =
      j?.next_url && new URL(j.next_url).host === new URL(POLYGON).host
        ? j.next_url
        : null;
  }
}

export async function polygonCandles(ticker, tf, limit) {
  if (!polygonCfg()) throw new Error("No Polygon key in data/feeds.json");
  const base = nativeBase(tf, Object.keys(POLYGON_TF));
  if (!base) throw new Error(`Polygon can't build a ${tf} chart`);
  const intraday = isIntraday(base);
  const ratio = Math.max(
    1,
    Math.round(parseTf(tf).seconds / parseTf(base).seconds),
  );
  const want = Math.min(limit * ratio + ratio, 60000);
  const [mult, span] = POLYGON_TF[base];
  const from = startFor(base, want, Date.UTC(2003, 0, 1));
  const to = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const out = [];
  await polygonPages(
    `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=desc&limit=50000`,
    want,
    (r) => {
      const t = Math.floor(r.t / 1000);
      if (intraday && !inUsSession(t)) return false;
      out.push({
        time: intraday ? t : dayOf(t),
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v || 0,
      });
      return true;
    },
  );
  return finish(out, base, tf, limit);
}

// Sources to try before the public ones for a US stock, in this order.
export function stockChain(ticker, tf, limit) {
  const chain = [];
  if (alpacaCfg())
    chain.push([alpacaName(), () => alpacaCandles(ticker, tf, limit)]);
  if (polygonCfg())
    chain.push(["Polygon", () => polygonCandles(ticker, tf, limit)]);
  return chain;
}

// ---------- Polygon / Massive (CME futures) ----------
// Equity index futures expire on the third Friday of March, June, September and December. Trading
// moves to the next contract 8 days before expiry (CME's roll date), so that's when the front contract changes.
const MONTH_CODES = "FGHJKMNQUVXZ";
const thirdFriday = (y, m) => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return Date.UTC(y, m, 1 + ((12 - first) % 7) + 14, 13, 30);
};
export function frontContract(root, now = Date.now()) {
  let y = new Date(now).getUTCFullYear();
  for (let k = 0; k < 12; k++) {
    const m = 2 + 3 * (k % 4);
    if (k && k % 4 === 0) y++;
    if (now < thirdFriday(y, m) - 8 * 86400e3) return `${root}${MONTH_CODES[m]}${y % 10}`;
  }
  return null;
}

const FUT_RES = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "1D": "1session" };

export async function polygonFuturesCandles(contract, tf, limit) {
  if (!polygonCfg()) throw new Error("No Polygon key in data/feeds.json");
  const base = nativeBase(tf, Object.keys(FUT_RES));
  if (!base) throw new Error(`Polygon can't build a ${tf} futures chart`);
  const intraday = isIntraday(base);
  const sec = parseTf(base).seconds;
  const ratio = Math.max(1, Math.round(parseTf(tf).seconds / sec));
  const want = Math.min(limit * ratio + ratio, 60000);
  // Futures trade about 23 hours a day, 5 days a week.
  const days = intraday ? Math.ceil(((want * sec) / 82800) * 1.5) + 4 : Math.ceil(want * 1.5) + 5;
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const out = [];
  await polygonPages(
    `${POLYGON}/futures/v1/aggs/${encodeURIComponent(contract)}?resolution=${FUT_RES[base]}&window_start.gte=${since}&sort=window_start.desc&limit=50000`,
    want,
    (r) => {
      const t = intraday
        ? Math.floor(Number(r.window_start) / 1e9)
        : Date.parse(`${r.session_end_date}T00:00:00Z`) / 1000;
      if (!Number.isFinite(t) || r.close == null) return false;
      out.push({ time: t, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume || 0 });
      return true;
    },
  );
  return finish(out, base, tf, limit);
}

// Sources to try before Yahoo's delayed chart for a CME future. The provider name carries the
// contract, so the chart's legend shows which one it is.
export function futuresChain(root, tf, limit) {
  if (!polygonCfg()) return [];
  const contract = frontContract(root);
  return [[`Polygon ${contract}`, () => polygonFuturesCandles(contract, tf, limit)]];
}

// ---------- OANDA (forex, metals, your account's other instruments) ----------
const OANDA_TF = { "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1D": "D" };

export async function oandaCandles(instrument, tf, limit) {
  const k = oandaCfg();
  if (!k) throw new Error("No OANDA token in data/feeds.json");
  const base = nativeBase(tf, Object.keys(OANDA_TF));
  if (!base) throw new Error(`OANDA can't build a ${tf} chart`);
  const ratio = Math.max(1, Math.round(parseTf(tf).seconds / parseTf(base).seconds));
  const q = new URLSearchParams({
    price: "M",
    granularity: OANDA_TF[base],
    count: String(Math.min(limit * ratio + ratio, 5000)), // OANDA's most per request
  });
  // Daily bars start at UTC midnight, like every other source, rather than OANDA's 5pm New York.
  if (base === "1D") {
    q.set("dailyAlignment", "0");
    q.set("alignmentTimezone", "UTC");
  }
  const j = await getFeed(
    "OANDA",
    `${oandaHost()}/v3/instruments/${encodeURIComponent(instrument)}/candles?${q}`,
    { Authorization: `Bearer ${k.token}` },
  );
  const out = [];
  for (const c of j?.candles || []) {
    const t = Math.floor(Date.parse(c.time) / 1000);
    if (!Number.isFinite(t) || !c.mid) continue;
    out.push({ time: t, open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, volume: c.volume || 0 });
  }
  return finish(out, base, tf, limit);
}

// Your OANDA key in front of the public sources for a forex pair or metal: EURUSD is EUR_USD there.
export function fxChain(pair, tf, limit) {
  if (!oandaCfg()) return [];
  const instrument = `${pair.slice(0, 3)}_${pair.slice(3)}`;
  return [["OANDA", () => oandaCandles(instrument, tf, limit)]];
}

// For `npm run doctor`: does each key you added work?
export function probes() {
  const out = {};
  const since = new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10);
  const k = alpacaCfg();
  if (k)
    out["Alpaca (your key)"] = () =>
      getFeed(
        "Alpaca",
        `${ALPACA}/v2/stocks/bars?symbols=SPY&timeframe=1Day&limit=1&start=${since}&feed=${encodeURIComponent(k.feed || "iex")}`,
        {
          "APCA-API-KEY-ID": k.keyId,
          "APCA-API-SECRET-KEY": k.secretKey,
        },
      );
  if (polygonCfg())
    out["Polygon (your key)"] = () =>
      getFeed(
        "Polygon",
        `${POLYGON}/v2/aggs/ticker/SPY/range/1/day/${since}/${new Date().toISOString().slice(0, 10)}?limit=1`,
        {
          Authorization: `Bearer ${polygonCfg().apiKey}`,
        },
      );
  if (oandaCfg())
    out["OANDA (your key)"] = () =>
      getFeed("OANDA", `${oandaHost()}/v3/instruments/EUR_USD/candles?granularity=D&count=1`, {
        Authorization: `Bearer ${oandaCfg().token}`,
      });
  return out;
}
