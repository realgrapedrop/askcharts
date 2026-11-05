// The research behind /api/pine/* and /api/market/profile: a script checked on bars, its settings swept, the
// template kinds scanned on a symbol, and a symbol's character. Plain functions of the bars they're given;
// lib/pinerun.js fetches the bars and runs these in a worker thread of their own. The last 30% of the bars is
// kept back: settings are picked on the first 70% only, and only the pick is scored on the rest, so nothing
// here can be tuned on the bars that judge it.
import { compilePine, runPine } from "../public/lib/pine.js";
import { pineChecks, pineTunables, THIN_TRADES } from "../public/lib/pinequant.js";
import { TEMPLATES, templateCode } from "../public/lib/pinetemplates.js";
import { sharpe, periodsPerYear } from "../public/lib/quant.js";

export const HOLDOUT = 0.3;
// closed trades a version needs on the first 70% to be picked, so one that never trades can't win
export const MIN_PICK_TRADES = 3;
export const MAX_COMBOS = 50;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const errOf = (e) => ({ message: String(e?.plain || e?.message || e).slice(0, 300), line: Number.isFinite(e?.line) ? e.line : null });
const span = (bars) => ({ count: bars.length, from: bars[0]?.time ?? null, to: bars.at(-1)?.time ?? null });
// the bars in the testing period; any before it only warm the indicators up
const inRange = (bars, ctx) => (Number.isFinite(ctx?.range?.from) ? bars.filter((b) => b.time >= ctx.range.from) : bars);

// The script's settings, as the AI and the Settings dialog see them.
const inputsOf = (c) =>
  c.inputs
    .filter((x) => x.type)
    .map(({ key, label, type, default: d, min, max, step, options }) => ({ key, label, type, default: d, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}), ...(options ? { options } : {}) }));

// One stretch of a run: its return, buy and hold over the same bars, closed trades, win rate, how long a
// typical trade was held (the median, in hours), worst drop and annualised Sharpe.
function stretch(r, bars, a, b) {
  const e = r.equity.slice(a, b + 1);
  if (e.length < 2) return null;
  const close = new Map(bars.map((x) => [x.time, x.close]));
  const c0 = close.get(e[0].time),
    c1 = close.get(e.at(-1).time);
  const t0 = e[0].time,
    t1 = e.at(-1).time;
  const trades = r.trades.filter((t) => t.exitTime > t0 && t.exitTime <= t1);
  let peak = -Infinity,
    dd = 0;
  for (const x of e) {
    peak = Math.max(peak, x.value);
    if (peak > 0) dd = Math.max(dd, (peak - x.value) / peak);
  }
  const ret = e.slice(1).map((x, i) => (e[i].value > 0 ? x.value / e[i].value - 1 : 0));
  const sr = sharpe(ret);
  const held = trades.map((t) => t.exitTime - t.entryTime).sort((x, y) => x - y);
  return {
    from: t0,
    to: t1,
    returnPct: round(e[0].value > 0 ? (e.at(-1).value / e[0].value - 1) * 100 : null),
    buyHoldPct: round(c0 > 0 && c1 != null ? (c1 / c0 - 1) * 100 : null),
    trades: trades.length,
    winRatePct: trades.length ? round((trades.filter((t) => t.pnl > 0).length / trades.length) * 100, 1) : null,
    holdHours: held.length ? round(held[Math.floor(held.length / 2)] / 3600, 1) : null,
    maxDrawdownPct: round(dd * 100),
    sharpe: sr == null ? null : round(sr * Math.sqrt(periodsPerYear(e))),
  };
}

// The whole run, the first 70% and the last 30% (the trades that close there).
export function split(r, bars) {
  const n = r.equity.length,
    k = Math.floor(n * (1 - HOLDOUT));
  return { whole: stretch(r, bars, 0, n - 1), train: stretch(r, bars, 0, k), test: stretch(r, bars, k, n - 1) };
}

// how much of the starting capital a typical trade puts to work
function sizePct(r) {
  const s = r.trades.map((t) => (t.entryPrice * t.qty * 100) / r.initialCapital).filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? round(s[Math.floor(s.length / 2)], 4) : null;
}

const runner = (c, bars, ctx, props) => (params, extra) => {
  const p = props || extra ? { strategy: { ...(props || {}), ...(extra || {}) } } : {};
  return runPine(c, bars, params, { ...ctx, ...p });
};

// ---- a script on bars: its errors with line numbers, or what it shows and, for a strategy, how it did
export function checkScript({ code, bars, ctx = {}, params = {}, props = null }) {
  let c, r;
  try {
    c = compilePine(code);
  } catch (e) {
    return { ok: false, error: errOf(e) };
  }
  const head = { kind: c.meta.kind, title: c.meta.title, inputs: inputsOf(c) };
  try {
    r = runner(c, bars, ctx, props)(params);
  } catch (e) {
    return { ok: false, ...head, error: errOf(e) };
  }
  const out = { ok: true, ...head, warnings: r.warnings.slice(0, 10), bars: span(inRange(bars, ctx)) };
  if (!r.strategy) {
    out.plots = Object.entries(r.plots)
      .slice(0, 12)
      .map(([key, v]) => {
        const spec = (r.plotSpecs || []).find((p) => p.key === key);
        const last = [...v].reverse().find(Number.isFinite);
        return { title: spec?.title || key, last: round(last, 6) };
      });
    out.markers = r.markers.length;
    return out;
  }
  const s = r.strategy,
    size = sizePct(s);
  out.strategy = {
    ...split(s, bars),
    closedTrades: s.trades.length,
    openTrades: s.open.length,
    initialCapital: s.initialCapital,
    fees: s.stats.feesAndSlippage,
    fills: s.stats.fills,
    sizePct: size,
    // under 1% of the capital a trade, returns are too small to mean anything: set the order size
    tinyOrder: size != null && size < 1,
    thin: s.trades.length < THIN_TRADES,
  };
  return out;
}

// every combination of the values given for each input, in order
function combos(sweep) {
  let out = [{}];
  for (const [key, values] of Object.entries(sweep)) out = out.flatMap((o) => values.map((v) => ({ ...o, [key]: v })));
  return out;
}

// pick on the first 70%: the best Sharpe there among versions with enough closed trades there
function pickOf(rows) {
  const ok = rows.filter((x) => x.train && x.train.trades >= MIN_PICK_TRADES && x.train.sharpe != null);
  return ok.sort((a, b) => b.train.sharpe - a.train.sharpe || b.train.returnPct - a.train.returnPct)[0] || null;
}

// ---- a strategy's settings swept: up to 50 versions picked on the first 70%, the pick scored on the last
// 30%, then the quant checks on the pick. Only the pick's last 30% is returned.
export async function sweepScript({ code, bars, ctx = {}, params = {}, props = null, sweep }) {
  let c;
  try {
    c = compilePine(code);
  } catch (e) {
    return { ok: false, error: errOf(e) };
  }
  if (c.meta.kind !== "strategy") return { ok: false, error: { message: "Only a strategy() script can be swept", line: null } };
  const list = combos(sweep);
  if (list.length > MAX_COMBOS) return { ok: false, error: { message: `${list.length} versions; at most ${MAX_COMBOS}`, line: null } };
  const run = runner(c, bars, ctx, props);
  const rows = list.map((values) => {
    try {
      const sp = split(run({ ...params, ...values }).strategy, bars);
      return { values, train: sp.train, test: sp.test };
    } catch (e) {
      return { values, error: errOf(e).message };
    }
  });
  const pick = pickOf(rows);
  const labels = Object.fromEntries(c.inputs.map((x) => [x.key, x.label]));
  const named = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [labels[k] || k, v]));
  const out = {
    ok: true,
    title: c.meta.title,
    bars: span(inRange(bars, ctx)),
    tried: rows.length,
    failed: rows.filter((x) => x.error).length,
    // the first 70% only: the last 30% of the others stays unseen
    best: rows
      .filter((x) => x.train)
      .sort((a, b) => (b.train.sharpe ?? -Infinity) - (a.train.sharpe ?? -Infinity))
      .slice(0, 8)
      .map((x) => ({ values: named(x.values), train: x.train })),
    picked: null,
  };
  if (!pick) {
    out.note = `No version closed ${MIN_PICK_TRADES} trades on the first 70% of the bars, so none was picked. More bars or a shorter interval give more trades.`;
    return out;
  }
  out.picked = { values: named(pick.values), inputs: pick.values, train: pick.train, test: pick.test };
  const q = await pineChecks({ inputs: c.inputs, params: { ...params, ...pick.values }, keys: Object.keys(sweep).slice(0, 2), run: (p, x) => run(p, x).strategy, bars, mcRuns: 1000 });
  out.checks = { passed: q.passed, of: q.gates.length, gates: q.gates.map(({ label, pass, value }) => ({ label, pass, value })), thin: q.thin, sizePct: q.sizePct };
  // the pick 3 months at a time, so a result made in one run shows
  if (q.quarters) out.checks.quarters = q.quarters.rows.map((x) => ({ from: x.from, to: x.to, returnPct: round(x.returnPct), buyHoldPct: round(x.buyHoldPct), trades: x.trades }));
  return out;
}

// ---- which kinds of strategy suit a symbol: every template on each interval, its two main settings at
// 80%, 100% and 120% (9 versions), picked on the first 70%, the picks ranked on the last 30%.
export function scanSymbol({ barsByTf, fromByTf = {}, symbol, fee, templates = null, shorts = false }) {
  const list = templates ? TEMPLATES.filter((t) => templates.includes(t.id)) : TEMPLATES;
  const results = [],
    intervals = [];
  let trials = 0;
  for (const [tf, bars] of Object.entries(barsByTf)) {
    const ctx = { symbol, tf, ...(Number.isFinite(fromByTf[tf]) ? { range: { from: fromByTf[tf], to: null } } : {}) };
    let hold = null;
    for (const t of list) {
      const c = compilePine(templateCode(t, { symbol, fee }));
      const tun = pineTunables(c.inputs, {});
      const sweep = Object.fromEntries(tun.map((x) => [x.key, x.values.slice(1, 4)]));
      // for someone who trades short too: "Also trade short" on (the trend kinds; the others only buy)
      const sh = shorts ? c.inputs.find((x) => x.type === "bool" && /short/i.test(x.label)) : null;
      const run = runner(c, bars, ctx, null);
      const rows = combos(sweep).map((values) => {
        trials++;
        try {
          const sp = split(run(sh ? { ...values, [sh.key]: true } : values).strategy, bars);
          hold ||= { train: sp.train?.buyHoldPct ?? null, test: sp.test?.buyHoldPct ?? null };
          return { values, train: sp.train, test: sp.test };
        } catch (e) {
          return { values, error: errOf(e).message };
        }
      });
      const pick = pickOf(rows);
      const labels = Object.fromEntries(c.inputs.map((x) => [x.key, x.label]));
      results.push({
        template: t.id,
        name: t.name,
        kind: t.kind,
        tf,
        shorts: !!sh,
        picked: pick ? Object.fromEntries(Object.entries(pick.values).map(([k, v]) => [labels[k] || k, v])) : null,
        train: pick?.train ?? null,
        test: pick?.test ?? null,
      });
    }
    intervals.push({ tf, bars: span(inRange(bars, ctx)), buyHold: hold });
  }
  // ranked on the last 30% by Sharpe; a kind with no pick goes last
  results.sort((a, b) => (b.test?.sharpe ?? -Infinity) - (a.test?.sharpe ?? -Infinity));
  return { ok: true, symbol, fee, shorts: !!shorts, intervals, trials, results };
}

// ---- a symbol's character on an interval: does it trend or snap back, how much it moves, how long the bars go back
export function profileBars(bars, tf) {
  const n = bars.length;
  if (n < 60) return { ok: false, error: { message: `Only ${n} bars; a profile needs at least 60`, line: null } };
  const r = bars.slice(1).map((b, i) => Math.log(b.close / bars[i].close)).filter(Number.isFinite);
  const m = r.length,
    mean = r.reduce((a, b) => a + b, 0) / m;
  const v1 = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (m - 1);
  const ac = r.slice(1).reduce((a, b, i) => a + (b - mean) * (r[i] - mean), 0) / ((m - 1) * v1);
  // Lo and MacKinlay's variance ratio: k-bar moves against k one-bar moves; above 1 trends, below snaps back
  const vr = [2, 5, 10, 20]
    .filter((k) => k * 10 < m)
    .map((k) => {
      let s = 0,
        cnt = 0;
      for (let i = k - 1; i < m; i++) {
        let sum = 0;
        for (let j = i - k + 1; j <= i; j++) sum += r[j];
        s += (sum - k * mean) ** 2;
        cnt++;
      }
      const ratio = s / cnt / (k * v1);
      const se = Math.sqrt((2 * (2 * k - 1) * (k - 1)) / (3 * k * m));
      return { bars: k, ratio: round(ratio, 3), z: round((ratio - 1) / se) };
    });
  const key = vr.find((x) => x.bars === 10) || vr.at(-1);
  const character = !key ? "unclear" : key.z > 2 ? "trending" : key.z < -2 ? "mean reverting" : "neither";
  const atr = [];
  for (let i = 1; i < n; i++) {
    const b = bars[i],
      p = bars[i - 1];
    atr.push((Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) / b.close) * 100);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  let peak = 0,
    dd = 0;
  for (const b of bars) {
    peak = Math.max(peak, b.close);
    dd = Math.max(dd, (peak - b.close) / peak);
  }
  let above = 0,
    seen = 0;
  for (let i = 199; i < n; i++) {
    let s = 0;
    for (let j = i - 199; j <= i; j++) s += bars[j].close;
    seen++;
    if (bars[i].close > s / 200) above++;
  }
  return {
    ok: true,
    tf,
    bars: span(bars),
    character,
    varianceRatios: vr,
    autocorrelation: round(ac, 3),
    volatilityPct: round(Math.sqrt(v1) * Math.sqrt(periodsPerYear(bars)) * 100, 1),
    typicalMovePct: round(med(r.map((x) => Math.abs(x) * 100)), 3),
    typicalRangePct: round(med(atr), 3),
    buyHoldPct: round((bars.at(-1).close / bars[0].close - 1) * 100),
    worstDropPct: round(dd * 100),
    aboveAverage200Pct: seen ? round((above / seen) * 100, 1) : null,
  };
}
