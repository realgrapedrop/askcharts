// Alerts run on the server, so they keep firing while the browser tab is closed (as long as the
// app is running). An alert is a condition in the same format the strategy tester uses:
//
// { symbol: 'BINANCE:BTCUSDT', tf: '1h', left: 'close', op: 'crossesAbove', right: 100000,
//   indicators: {}, trigger: 'once' | 'oncePerBar' | 'oncePerBarClose', webhook: 'https://...',
//   message: 'BTC broke 100k' }
//
// Give `watchlist: 'Main'` instead of a symbol and the alert checks every symbol on that list
// (read fresh each time, so edits to the list count). "Only once" then means once per symbol, and the alert
// stops when every symbol on the list has fired, as on TradingView.

import crypto from "node:crypto";
import { getCandles } from "./providers.js";
import { conditionFn } from "../public/lib/backtest.js";
import { BY_ID } from "../public/lib/indicators.js";
import { parseTf } from "../public/lib/series.js";
import * as onchain from "./onchain.js";
import * as store from "./store.js";

let alerts = store.read("alerts", []);
let log = store.read("alert-log", []);
let listeners = new Set();
let timer = null;

export const list = () => alerts;
export const history = () => log;
export function onFire(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const save = () => store.write("alerts", alerts);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const OPS = [">", "<", ">=", "<=", "crossesAbove", "crossesBelow", "crosses", "enteringChannel", "exitingChannel", "insideChannel", "outsideChannel", "movingUp", "movingDown", "movingUpPct", "movingDownPct"];
const CHANNEL = ["enteringChannel", "exitingChannel", "insideChannel", "outsideChannel"];
const TRIGGERS = ["once", "oncePerBar", "oncePerBarClose", "oncePerMinute"];
// A short synthetic series is enough to check that every operand and indicator in a rule exists.
const PROBE = Array.from({ length: 300 }, (_, t) => {
  const c = 100 + 10 * Math.sin(t / 7);
  return { time: t * 60, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1000 + t };
});

// Up to five conditions (TradingView's multi-condition alerts); `match` says whether all or any
// must hold. Older alerts with a single left/op/right still work.
export const conditionsOf = (a) =>
  Array.isArray(a.conditions) && a.conditions.length ? a.conditions : [{ left: a.left, op: a.op, right: a.right }];

function validate(a) {
  if (a.watchlist !== undefined && (typeof a.watchlist !== "string" || !a.watchlist))
    throw bad("watchlist must be the name of one of your watchlists");
  if (!a.watchlist && (!a.symbol || typeof a.symbol !== "string")) throw bad("An alert needs a symbol or a watchlist");
  const conds = conditionsOf(a);
  if (conds.length > 5) throw bad("An alert can have up to 5 conditions");
  if (!["all", "any"].includes(a.match || "all")) throw bad('match must be "all" or "any"');
  if (!TRIGGERS.includes(a.trigger || "once")) throw bad(`Unknown trigger "${a.trigger}"`);
  if (a.expires != null && !Number.isFinite(Number(a.expires))) throw bad("expires must be a time in milliseconds");
  if (a.webhook && !/^https?:\/\/\S+$/i.test(a.webhook)) throw bad("Webhook must be an http(s) URL");
  for (const c of conds) {
    if (c.right === undefined || c.right === null || c.right === "")
      throw bad("An alert needs something to compare against");
    if (!OPS.includes(c.op)) throw bad(`Unknown operator "${c.op}". Use one of ${OPS.join(", ")}`);
    if (CHANNEL.includes(c.op) && (c.right2 === undefined || c.right2 === null || c.right2 === ""))
      throw bad("A channel condition needs an upper and a lower bound");
    try {
      conditionFn(PROBE, a.indicators || {})(c)(299);
    } catch (e) {
      throw bad(e.message);
    }
  }
}

export function add(input) {
  if (!input || typeof input !== "object") throw bad("Send the alert as a JSON object");
  const a = {
    id: crypto.randomUUID(),
    symbol: input.watchlist ? "" : input.symbol,
    watchlist: input.watchlist || undefined,
    tf: input.tf || "1m",
    left: input.left ?? input.conditions?.[0]?.left ?? "close",
    op: input.op || input.conditions?.[0]?.op || "crossesAbove",
    right: input.right ?? input.conditions?.[0]?.right,
    conditions: Array.isArray(input.conditions) ? input.conditions : undefined,
    match: input.match || "all",
    indicators: input.indicators || {},
    trigger: input.trigger || "once",
    webhook: input.webhook || "",
    message: input.message || "",
    name: input.name || "",
    expires: input.expires ?? null,
    notify: input.notify || { toast: true, sound: true, desktop: true },
    active: true,
    createdAt: new Date().toISOString(),
    lastBar: null,
    fired: 0,
  };
  validate(a);
  alerts.push(a);
  save();
  return a;
}

export function update(id, patch) {
  const a = alerts.find((x) => x.id === id);
  if (!a) throw bad("No such alert", 404);
  // watchlist: null turns a list's alert back into one symbol's
  const next = { ...a, ...patch };
  if (patch?.watchlist === null) delete next.watchlist;
  validate(next);
  Object.assign(a, patch, { id });
  if (patch?.watchlist === null) delete a.watchlist;
  save();
  return a;
}

export function remove(id) {
  alerts = alerts.filter((a) => a.id !== id);
  save();
}

export function describe(a, symbol = a.symbol) {
  const ops = {
    ">": "is above",
    "<": "is below",
    ">=": "is at or above",
    "<=": "is at or below",
    crossesAbove: "crosses above",
    crossesBelow: "crosses below",
    crosses: "crosses",
  };
  Object.assign(ops, {
    enteringChannel: "enters the channel",
    exitingChannel: "exits the channel",
    insideChannel: "is inside the channel",
    outsideChannel: "is outside the channel",
    movingUp: "moves up by",
    movingDown: "moves down by",
    movingUpPct: "moves up % by",
    movingDownPct: "moves down % by",
  });
  const name = (o) => (o && typeof o === "object" && o.line ? "your drawn line" : o);
  const parts = conditionsOf(a).map((c) =>
    CHANNEL.includes(c.op)
      ? `${name(c.left)} ${ops[c.op]} ${name(c.right2)} to ${name(c.right)}`
      : `${name(c.left)} ${ops[c.op] || c.op} ${name(c.right)}${/^moving/.test(c.op) ? ` within ${c.bars || 1} bars` : ""}`,
  );
  if (a.message) return a.watchlist ? `${symbol}: ${a.message}` : a.message;
  return `${symbol} ${a.tf}: ${parts.join(a.match === "any" ? " or " : " and ")}`;
}

async function sendWebhook(url, text, payload) {
  let body;
  const host = new URL(url).host;
  if (host.includes("discord")) body = { content: text };
  else if (host.includes("slack.com")) body = { text };
  else if (host.includes("telegram.org")) body = { text };
  else body = { text, content: text, ...payload };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
}

// TradingView's placeholders in an alert's message: {{ticker}}, {{close}}, {{interval}} and so on.
function fillIn(text, a, bar, symbol = a.symbol) {
  const t = String(symbol).split(":").pop();
  return String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    ({ ticker: t, exchange: String(symbol).split(":")[0], interval: a.tf, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, time: new Date(bar.time * 1000).toISOString(), timenow: new Date().toISOString() })[k] ?? m,
  );
}

async function fire(a, bar, price, symbol = a.symbol) {
  // a watchlist alert says which of its symbols fired
  const text = a.message
    ? `${a.name ? `${a.name}: ` : ""}${a.watchlist ? `${symbol}: ` : ""}${fillIn(a.message, a, bar, symbol)}`
    : `${a.name || "Alert"}: ${describe(a, symbol)} (price ${price})`;
  const event = {
    id: crypto.randomUUID(),
    alertId: a.id,
    symbol,
    tf: a.tf,
    name: a.name || "",
    text,
    notify: a.notify || null,
    price,
    barTime: bar.time,
    at: new Date().toISOString(),
  };
  a.fired += 1;
  a.lastFiredAt = event.at;
  if (a.trigger === "once" && !a.watchlist) a.active = false;
  if (a.webhook) {
    try {
      await sendWebhook(a.webhook, text, { alert: a, event });
      event.webhook = "sent";
    } catch (e) {
      event.webhook = `failed: ${e.message}`;
    }
  }
  log.unshift(event);
  log = log.slice(0, 500);
  store.write("alert-log", log);
  for (const fn of listeners) fn(event);
}

// One evaluation at a time: the timer and a manual "check now" must not both fire a "once" alert.
let running = null;
// XRPL On chain indicators read the XRP Ledger store. The chart hands them its buckets (one per bar, an hour
// at most, summed into longer bars); an alert gets the same buckets for its own bars, read from the store here.
// One read per chain for every alert on those bars (`cache`).
export function withOnchain(bars, tf, indicators = {}, cache = {}) {
  if (!bars.length || !Object.values(indicators).some((s) => BY_ID[s?.id]?.onchain)) return indicators;
  const sec = parseTf(tf).seconds,
    step = Math.min(sec, 3600);
  const data = (chain) => {
    if (!cache[chain]) {
      const r = onchain.xrpl({ from: bars[0].time - (bars[0].time % step), to: bars.at(-1).time + sec, step, min: 100000 });
      cache[chain] = { cols: r.cols, rows: r.buckets, whales: r.whales, tf: sec, first: r.first, reason: r.reason };
    }
    return cache[chain];
  };
  return Object.fromEntries(
    Object.entries(indicators).map(([k, s]) => {
      const chain = BY_ID[s?.id]?.onchain;
      return [k, chain ? { ...s, params: { ...(s.params || {}), __onchain: data(chain) } } : s];
    }),
  );
}

export function evaluate() {
  running ||= evaluateOnce().finally(() => {
    running = null;
  });
  return running;
}

async function evaluateOnce() {
  // an alert past its expiry stops, as on TradingView
  for (const a of alerts)
    if (a.active && a.expires && Date.now() > a.expires) {
      a.active = false;
      a.expired = true;
    }
  const active = alerts.filter((a) => a.active);
  const lists = store.read("state", {}).watchlists || {};
  const groups = new Map();
  for (const a of active) {
    for (const symbol of a.watchlist ? [...new Set(lists[a.watchlist] || [])] : [a.symbol]) {
      const k = `${symbol}|${a.tf}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
  }
  for (const [k, group] of groups) {
    const [symbol, tf] = k.split("|");
    let bars;
    try {
      ({ candles: bars } = await getCandles(symbol, tf, 400));
    } catch {
      continue;
    }
    if (bars.length < 3) continue;
    const chains = {};
    for (const a of group) {
      try {
        const make = conditionFn(bars, withOnchain(bars, tf, a.indicators, chains));
        const tests = conditionsOf(a).map((c) => make(c));
        const test = (k) => (a.match === "any" ? tests.some((t) => t(k)) : tests.every((t) => t(k)));
        // it runs again (XRPL data arrived, say): last time's error is over
        delete a.error;
        const i =
          a.trigger === "oncePerBarClose" ? bars.length - 2 : bars.length - 1;
        const bar = bars[i];
        if (a.watchlist) {
          // each symbol on the list on its own: "once" is once per symbol, the others per symbol's bar
          // (once a minute: the time it last fired for that symbol)
          a.lastBars ||= {};
          const last = a.lastBars[symbol];
          if (a.trigger === "once" ? symbol in a.lastBars : a.trigger === "oncePerMinute" ? last && Date.now() - last < 60000 : last === bar.time) continue;
          if (!test(i)) continue;
          a.lastBars[symbol] = a.trigger === "oncePerMinute" ? Date.now() : bar.time;
          await fire(a, bar, bar.close, symbol);
          continue;
        }
        if (!a.active) continue;
        if (a.trigger === "oncePerMinute") {
          if (a.lastFiredAt && Date.now() - Date.parse(a.lastFiredAt) < 60000) continue;
        } else if (a.trigger !== "once" && a.lastBar === bar.time) continue;
        if (test(i)) {
          a.lastBar = bar.time;
          await fire(a, bar, bar.close);
        }
      } catch (e) {
        a.error = e.message;
      }
    }
  }
  // a list's "Only once" alert stops once it has fired for every symbol on the list
  for (const a of active)
    if (a.watchlist && a.trigger === "once" && a.active) {
      const syms = [...new Set(lists[a.watchlist] || [])];
      if (syms.length && syms.every((s) => s in (a.lastBars || {}))) a.active = false;
    }
  save();
}

export function start(intervalMs = 15000) {
  if (timer) return;
  const tick = () =>
    evaluate()
      .catch(() => {})
      .finally(() => {
        timer = setTimeout(tick, intervalMs);
      });
  timer = setTimeout(tick, 2000);
}

export function stop() {
  clearTimeout(timer);
  timer = null;
}
