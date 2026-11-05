// Pine on the server (phase 2 of the AI plan): a script checked on a symbol, its settings swept, the
// template kinds scanned on a symbol, and a symbol's character, for /api/pine/* and /api/market/profile.
// The bars come from the same sources as the chart (the history store first), without one still forming.
// At most two jobs at once, counted from before their bars are fetched. Each runs in a worker thread of its
// own with a memory cap and a hard time limit, and stops when its request closes, so a script that never
// ends or eats memory is stopped and the app keeps answering. The interpreter walks the script itself and
// never turns it into JavaScript.
import { Worker } from "node:worker_threads";
import * as data from "./providers.js";
import { parseTf } from "../public/lib/series.js";
import { TEMPLATES, feeFor } from "../public/lib/pinetemplates.js";
import { MAX_COMBOS } from "./pinework.js";

const MAX_RUNNING = 2;
// under the sign-in tunnel's 100 s, so a result can still reach the page; QT_PINE_LIMIT_MS for tests
const limitMs = () => Number(process.env.QT_PINE_LIMIT_MS) || 90000;
const MAX_CODE = 100000;
const MAX_BARS = 20000;
// bars fetched before the window only to warm the indicators up, so its first bar reads as in the Strategy
// tester, which has the bars before its testing period too; both inside the 20,000 a fetch gives
const WARM_BARS = 500;
const MAX_WINDOW = MAX_BARS - WARM_BARS;
// how far back a test reaches unless asked otherwise: recent enough to leave old runs out, long enough to
// hold a rise and a fall. Counted in time, not bars, so stocks (fewer bars a year) get the same span.
const YEARS = 2;
const YEAR = 365.25 * 86400;
const bad = (status, message) => Object.assign(new Error(message), { status });
let running = 0;

export const busy = () => running;

// One of the two places, held from the bar fetch to the end of the run, whatever happens in between.
async function withSlot(job) {
  if (running >= MAX_RUNNING) throw bad(503, "Two strategy tests are already running here. Try again in a moment.");
  running++;
  try {
    return await job();
  } finally {
    running--;
  }
}

function inWorker(kind, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(bad(499, "The request was closed"));
    let w;
    try {
      w = new Worker(new URL("./pine-worker.mjs", import.meta.url), {
        workerData: { kind, args },
        resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
      });
    } catch (e) {
      console.error("pine run didn't start:", e?.message || e);
      return reject(bad(500, "The run couldn't start"));
    }
    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      w.terminate();
      if (err) reject(err);
      else resolve(result);
    };
    const stop = () => finish(bad(499, "The request was closed"));
    signal?.addEventListener("abort", stop, { once: true });
    const ms = limitMs();
    const timer = setTimeout(() => finish(bad(504, `Stopped after ${ms / 1000} s: fewer bars, intervals or versions run faster`)), ms);
    w.once("message", (m) => (m.error ? finish(bad(500, m.error)) : finish(null, m.result)));
    w.once("error", (e) => {
      if (/memory/i.test(e?.message)) return finish(bad(500, "The script used too much memory and was stopped"));
      console.error("pine run failed:", e?.message || e);
      finish(bad(500, "The run stopped with an error"));
    });
    w.once("exit", (code) => finish(bad(500, `The run stopped (${code})`)));
  });
}

// The bars to test on: the last `years` (2 unless asked), at most 19,500 of them (fewer with `limit`), without
// the last one while it's still forming, and up to 500 before them for the indicators to warm up on. `short`
// says why the window covers less than the years asked: the bar cap, or the history starting later.
async function barsFor(symbol, tf, limit, years) {
  if (typeof symbol !== "string" || !symbol.trim()) throw bad(400, "Send a symbol");
  let sec;
  try {
    sec = parseTf(tf).seconds;
  } catch (e) {
    throw bad(400, e.message);
  }
  const want = Math.min(Math.max(Number(limit) || MAX_WINDOW, 100), MAX_WINDOW);
  const yrs = Number(years) > 0 ? Math.min(Math.max(Number(years), 0.25), 20) : YEARS;
  const r = await data.getCandles(symbol, tf, want + WARM_BARS);
  let bars = r.candles || [];
  if (bars.length && bars.at(-1).time + sec > Date.now() / 1000) bars = bars.slice(0, -1);
  const name = r.symbol || symbol;
  if (bars.length < 60) throw bad(422, `${name} on ${tf} has only ${bars.length} bars to test on`);
  // the window starts at the later of: `yrs` years back (its first bar j), and `want` bars back (cap)
  const since = bars.at(-1).time - yrs * YEAR;
  let j = 0;
  while (j < bars.length - 1 && bars[j].time < since) j++;
  const cap = Math.max(0, bars.length - want),
    i = Math.max(j, cap);
  if (bars.length - i < 60) throw bad(422, `${name} on ${tf} has only ${bars.length - i} bars in the last ${+yrs.toFixed(2)} years: ask for more years or a shorter interval`);
  // a gap at the start (a weekend, a holiday) isn't a shorter history: a week is
  const short = cap > j ? "bars" : j === 0 && bars[0].time > since + 7 * 86400 ? "history" : null;
  bars = bars.slice(Math.max(0, i - WARM_BARS));
  const from = bars[Math.min(i, WARM_BARS)].time;
  return { bars, from, range: { from, to: null }, symbol: name, source: r.provider || null, years: yrs, short };
}

// what a request may set: the script's inputs (in1, in2...) and the Properties a backtest uses (only these
// keys: no prototype, so "constructor" and the like aren't found)
const PROPS = Object.assign(Object.create(null), {
  commission_value: (v) => Number.isFinite(v) && v >= 0 && v <= 100,
  commission_type: (v) => ["percent", "cash_per_order", "cash_per_contract"].includes(v),
  slippage: (v) => Number.isInteger(v) && v >= 0 && v <= 1e6,
  initial_capital: (v) => Number.isFinite(v) && v > 0 && v <= 1e12,
  default_qty_type: (v) => ["fixed", "cash", "percent_of_equity"].includes(v),
  default_qty_value: (v) => Number.isFinite(v) && v > 0 && v <= 1e12,
  pyramiding: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
});
const paramsOf = (p) =>
  Object.fromEntries(Object.entries(p && typeof p === "object" ? p : {}).filter(([k, v]) => /^in\d{1,3}$/.test(k) && ["number", "string", "boolean"].includes(typeof v) && String(v).length <= 200));
function propsOf(p) {
  const out = Object.fromEntries(Object.entries(p && typeof p === "object" ? p : {}).filter(([k, v]) => Object.hasOwn(PROPS, k) && PROPS[k](v)));
  return Object.keys(out).length ? out : null;
}
function codeOf(code) {
  if (typeof code !== "string" || !code.trim()) throw bad(400, "Send the Pine script as code");
  if (code.length > MAX_CODE) throw bad(413, `The script is over ${MAX_CODE.toLocaleString("en-US")} characters`);
  return code;
}
const tfOf = (tf) => (typeof tf === "string" && tf ? tf : "1D");
const about = (b) => ({ symbol: b.symbol, source: b.source, years: b.years, short: b.short });

// POST /api/pine/check { code, symbol, tf, limit, years, params, props }
export async function check(body, signal) {
  const code = codeOf(body.code),
    tf = tfOf(body.tf);
  return withSlot(async () => {
    const b = await barsFor(body.symbol, tf, body.limit, body.years);
    const r = await inWorker("check", { code, bars: b.bars, ctx: { symbol: b.symbol, tf, range: b.range }, params: paramsOf(body.params), props: propsOf(body.props) }, signal);
    return { ...about(b), tf, ...r };
  });
}

// POST /api/pine/sweep { code, symbol, tf, limit, years, params, props, sweep: { in1: [10, 20, 30], in2: [...] } }
export async function sweep(body, signal) {
  const code = codeOf(body.code),
    tf = tfOf(body.tf);
  const s = body.sweep && typeof body.sweep === "object" ? body.sweep : null;
  const keys = s ? Object.keys(s) : [];
  if (!keys.length || keys.length > 3 || keys.some((k) => !/^in\d{1,3}$/.test(k) || !Array.isArray(s[k]) || !s[k].length || s[k].length > 10 || s[k].some((v) => !Number.isFinite(v))))
    throw bad(400, "Send sweep as up to 3 inputs (in1, in2...) with up to 10 numbers each");
  const n = keys.reduce((a, k) => a * s[k].length, 1);
  if (n > MAX_COMBOS) throw bad(400, `That's ${n} versions; at most ${MAX_COMBOS}`);
  return withSlot(async () => {
    const b = await barsFor(body.symbol, tf, body.limit, body.years);
    const r = await inWorker("sweep", { code, bars: b.bars, ctx: { symbol: b.symbol, tf, range: b.range }, params: paramsOf(body.params), props: propsOf(body.props), sweep: s }, signal);
    return { ...about(b), tf, ...r };
  });
}

// POST /api/pine/scan { symbol, tfs: ["4h", "1D"], limit, years, templates: [ids], fee, shorts }
export async function scan(body, signal) {
  const tfs = Array.isArray(body.tfs) && body.tfs.length ? body.tfs : ["1D"];
  if (tfs.length > 3 || tfs.some((t) => typeof t !== "string")) throw bad(400, "Send up to 3 intervals as tfs");
  const ids = Array.isArray(body.templates) ? body.templates.filter((id) => TEMPLATES.some((t) => t.id === id)) : null;
  return withSlot(async () => {
    const barsByTf = {},
      fromByTf = {},
      shortByTf = {};
    let b;
    for (const tf of [...new Set(tfs)]) {
      b = await barsFor(body.symbol, tf, body.limit, body.years);
      barsByTf[tf] = b.bars;
      fromByTf[tf] = b.from;
      shortByTf[tf] = b.short;
    }
    const fee = Number.isFinite(body.fee) && body.fee >= 0 && body.fee <= 5 ? body.fee : feeFor(b.symbol);
    const r = await inWorker("scan", { barsByTf, fromByTf, symbol: b.symbol, fee, templates: ids?.length ? ids : null, shorts: body.shorts === true }, signal);
    return { source: b.source, years: b.years, ...r, intervals: r.intervals?.map((x) => ({ ...x, short: shortByTf[x.tf] })) };
  });
}

// POST /api/market/profile { symbol, tf, limit } (a POST like the others, so another site can't start one)
export async function profile(body, signal) {
  const tf = tfOf(body.tf);
  return withSlot(async () => {
    const b = await barsFor(body.symbol, tf, body.limit, body.years);
    const r = await inWorker("profile", { bars: b.bars.filter((x) => x.time >= b.from), tf }, signal);
    return { ...about(b), ...r };
  });
}

// the routes, each given the request's body and a signal that fires when the request closes
export const ROUTES = new Map([
  ["/api/pine/check", check],
  ["/api/pine/sweep", sweep],
  ["/api/pine/scan", scan],
  ["/api/market/profile", profile],
]);
