// Quant checks for a Pine strategy: the checks in quant.js (walk-forward, overfitting, deflated
// Sharpe, cost stress, nearby settings, 3 months at a time, Monte Carlo) on the script's own number inputs, in the same
// shape as quantChecks(), so the Strategy tester shows them the same way. Each version is one full
// run of the script on the same bars. Its equity is marked to market every bar, so slicing its
// per-bar returns is look-ahead free, as in quant.js. Versions run one at a time with a pause
// between them, so the page keeps responding and Stop is seen. The server's Pine runs use it too.
import { sharpe, moments, psr, expectedMaxSharpe, pbo, monteCarlo, periodsPerYear, byQuarter } from "./quant.js";
import { guessMintick } from "./pine.js";

const MULT = [0.6, 0.8, 1, 1.2, 1.4];
// fewer closed trades than this and a result says little, whatever the checks say
export const THIN_TRADES = 30;

// The inputs the checks can vary: whole numbers and decimals.
export const numberInputs = (inputs) => (inputs || []).filter((x) => x.type === "int" || x.type === "float");

// A setting and four nearby values (60% to 140% of it), kept to the input's step, min and max.
function nearby(inp, base) {
  const fit = (v) => {
    if (inp.type === "int") v = Math.round(v);
    else if (inp.step > 0) v = Math.round(v / inp.step) * inp.step;
    else v = Number(v.toPrecision(3));
    if (inp.min !== undefined) v = Math.max(inp.min, v);
    else if (inp.type === "int") v = Math.max(1, v);
    if (inp.max !== undefined) v = Math.min(inp.max, v);
    return Number(v.toFixed(10));
  };
  return [...new Set(MULT.map((m) => (m === 1 ? base : fit(base * m))))].sort((a, b) => a - b);
}

// Up to two settings to vary: the keys asked for, else the first two number inputs above 0.
export function pineTunables(inputs, params = {}, keys = null) {
  const list = numberInputs(inputs)
    .map((x) => ({ ...x, base: Number(params[x.key] ?? x.default) }))
    .filter((x) => x.base > 0);
  const picked = keys ? keys.map((k) => list.find((x) => x.key === k)).filter(Boolean) : list;
  return picked.slice(0, 2).map((x) => ({ key: x.key, label: x.label, base: x.base, values: nearby(x, x.base) }));
}

// The cost stress: double the script's commission, and three times its slippage but at least about
// 0.05% of the price a side (in ticks, as Pine counts slippage), so none isn't left at none.
export function stressProps(opts, bars, mintick) {
  const closes = bars.map((b) => b.close).sort((a, b) => a - b);
  const mid = closes[Math.floor(closes.length / 2)] || 0,
    tick = mintick || guessMintick(bars);
  const floor = tick > 0 ? Math.ceil((mid * 0.0005) / tick) : 0;
  const slippage = Math.max((Number(opts?.slippage) || 0) * 3, floor);
  // what those ticks are as a share of a typical price, for the report
  return { commission_value: (Number(opts?.commission_value) || 0) * 2, slippage, pct: mid > 0 ? (slippage * tick * 100) / mid : 0 };
}

// The net return, not rounded: a script that trades a sliver of its capital (Pine's default is 1
// contract against 1,000,000) makes returns of a few thousandths of a percent.
const netOf = (r) => (r.initialCapital > 0 && r.equity?.length ? ((r.equity.at(-1).value - r.initialCapital) / r.initialCapital) * 100 : r.stats.netProfitPct);
// two decimals, or two significant digits under 0.1%
const pctText = (v) =>
  `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v) >= 0.1 || v === 0 ? Math.abs(v).toFixed(2) : Number(Math.abs(v).toPrecision(2)).toLocaleString("en-US", { maximumFractionDigits: 12 })}%`;
// a blown account (equity at or under 0) has no return to measure after it
const returnsOf = (equity) => equity.slice(1).map((e, i) => (equity[i].value > 0 ? e.value / equity[i].value - 1 : 0));
const pause = () => new Promise((r) => setTimeout(r, 0));

// run(params, props): the strategy result of one run on fixed bars, with the input values and any
// Properties (commission, slippage) given. bars: those bars. progress(done, total) after each run;
// stopped() is asked between runs.
export async function pineChecks({ inputs, params = {}, run, bars, mintick, keys = null, mcRuns = 2000, progress, stopped }) {
  const tun = pineTunables(inputs, params, keys);
  const grid =
    tun.length === 0 ? [[]] : tun.length === 1 ? tun[0].values.map((v) => [v]) : tun[0].values.flatMap((a) => tun[1].values.map((b) => [a, b]));
  const total = grid.length + 1;
  let done = 0;
  const next = async () => {
    progress?.(++done, total);
    await pause();
    if (stopped?.()) throw Object.assign(new Error("Stopped"), { stopped: true });
  };
  const base = run(params);
  if (!(base?.equity?.length > 2)) throw new Error("The strategy needs more bars in its testing period to check");
  await next();
  const ann = Math.sqrt(periodsPerYear(base.equity));
  const baseR = returnsOf(base.equity);
  const variants = [];
  for (const vals of grid) {
    const isBase = tun.every((t, k) => vals[k] === t.base);
    let r = base;
    if (!isBase) {
      try {
        r = run({ ...params, ...Object.fromEntries(tun.map((t, k) => [t.key, vals[k]])) });
      } catch (e) {
        r = { error: e.message || String(e) };
      }
      await next();
    }
    // a version that stops with an error, or has a different number of bars, is left out of the maths
    if (r.error || r.equity?.length !== base.equity.length) {
      variants.push({ values: vals, isBase, error: r.error || "no result", returns: null, sharpe: null, netPct: null, trades: null });
      continue;
    }
    const ret = returnsOf(r.equity);
    variants.push({ values: vals, isBase, returns: ret, sharpe: sharpe(ret), netPct: netOf(r), trades: r.stats.totalTrades });
  }
  const ok = variants.filter((v) => v.returns);
  const matrix = ok.map((v) => v.returns);
  const gates = [];

  // walk-forward: anchored, 5 test windows after the first 30% of the testing period
  let walkForward = null;
  if (ok.length > 1 && baseR.length > 100) {
    const T = baseR.length,
      start = Math.floor(T * 0.3),
      folds = 5,
      size = Math.floor((T - start) / folds);
    const oos = [],
      isChosen = [],
      rows = [];
    for (let k = 0; k < folds; k++) {
      const s = start + k * size,
        e = k === folds - 1 ? T : s + size;
      const trainS = matrix.map((r) => sharpe(r.slice(0, s)) ?? -Infinity);
      const best = trainS.indexOf(Math.max(...trainS));
      const test = matrix[best].slice(s, e);
      oos.push(...test);
      isChosen.push(trainS[best]);
      rows.push({
        from: base.equity[s + 1]?.time,
        to: base.equity[e]?.time,
        chosen: ok[best].values,
        testSharpe: (sharpe(test) ?? 0) * ann,
        testReturnPct: (test.reduce((acc, x) => acc * (1 + x), 1) - 1) * 100,
      });
    }
    const oosS = (sharpe(oos) ?? 0) * ann,
      isS = (isChosen.reduce((a, b) => a + b, 0) / folds) * ann;
    walkForward = {
      folds: rows,
      oosSharpe: oosS,
      isSharpe: isS,
      efficiency: isS > 0 ? oosS / isS : null,
      positiveFolds: rows.filter((r) => r.testReturnPct > 0).length,
    };
    gates.push({
      key: "wf",
      label: "Walk-forward",
      value: `${oosS.toFixed(2)} Sharpe on data the settings were never picked on (needs above 0)`,
      pass: oosS > 0,
    });
  }

  // overfitting
  const overfit = ok.length > 2 ? pbo(matrix) : null;
  if (overfit)
    gates.push({
      key: "pbo",
      label: "Overfitting (PBO)",
      value: `${(overfit.pbo * 100).toFixed(1)}% chance the best-looking settings are below average on unseen data (needs under 50%)`,
      pass: overfit.pbo < 0.5,
    });

  // Sharpe significance
  const srs = ok.map((v) => v.sharpe).filter((x) => x != null);
  const varSr = srs.length > 1 ? moments(srs).sd ** 2 * (srs.length / (srs.length - 1)) : 0;
  const sr0 = expectedMaxSharpe(Math.max(srs.length, 1), varSr);
  const probSharpe = psr(baseR, 0),
    deflated = psr(baseR, sr0);
  if (deflated != null)
    gates.push({
      key: "dsr",
      label: "Deflated Sharpe",
      value: `${deflated.toFixed(3)} probability the edge is real after ${srs.length} version${srs.length === 1 ? "" : "s"} tried (needs above 0.95)`,
      pass: deflated > 0.95,
    });

  // costs
  const { pct: slipPct, ...stress } = stressProps(base.opts, bars, mintick);
  let stressed;
  try {
    stressed = run(params, stress);
  } catch (e) {
    stressed = null;
  }
  await next();
  if (stressed) {
    const net = netOf(stressed);
    gates.push({
      key: "cost",
      label: "Cost stress",
      value: `${pctText(net)} with double the commission and ${+slipPct.toFixed(3)}% slippage a side, ${stress.slippage} tick${stress.slippage === 1 ? "" : "s"} (needs above 0)`,
      pass: net > 0,
    });
  }

  // robustness: share of neighbouring settings that keep at least half the base Sharpe
  let robustness = null;
  if (variants.length > 1) {
    const b = variants.find((v) => v.isBase)?.sharpe ?? 0;
    const others = variants.filter((v) => !v.isBase);
    const good = others.filter((v) => v.sharpe != null && b > 0 && v.sharpe >= b * 0.5).length;
    robustness = {
      share: (good / others.length) * 100,
      params: tun.map((t) => ({ label: t.label, values: t.values, base: t.base })),
    };
    gates.push({
      key: "robust",
      label: "Nearby settings",
      value: `${robustness.share.toFixed(0)}% of nearby settings keep at least half the Sharpe (needs 60%+)`,
      pass: robustness.share >= 60,
    });
  }

  const quarters = byQuarter(base.equity, bars, base.trades);
  if (quarters) gates.push(quarters.gate);

  // a trade's share of the account when it closed: its profit over the capital plus what closed before
  let account = base.initialCapital;
  const tradePcts = base.trades.map((t) => {
    const p = account > 0 ? (t.pnl / account) * 100 : 0;
    account += t.pnl;
    return p;
  });
  const mc = monteCarlo(tradePcts, mcRuns);
  const trades = base.stats.totalTrades;
  // how much of the starting capital a typical trade puts to work
  const sizes = base.trades.map((t) => (t.entryPrice * t.qty * 100) / base.initialCapital).filter(Number.isFinite).sort((a, b) => a - b);
  const sizePct = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null;
  return {
    base: { sharpe: (sharpe(baseR) ?? 0) * ann, netPct: netOf(base), trades },
    variants: variants.map(({ returns, ...v }) => ({ ...v, sharpe: v.sharpe == null ? null : v.sharpe * ann })),
    tunables: tun.map((t) => ({ key: t.key, label: t.label, base: t.base, values: t.values })),
    walkForward,
    pbo: overfit,
    psr: probSharpe,
    dsr: deflated,
    sr0: sr0 * ann,
    trials: srs.length,
    costStress: stressed ? netOf(stressed) : null,
    robustness,
    quarters,
    monteCarlo: mc,
    gates,
    passed: gates.filter((g) => g.pass).length,
    thin: trades < THIN_TRADES,
    sizePct,
    failed: variants.filter((v) => v.error).length,
    bars: base.equity.length,
    from: base.equity[0].time,
    to: base.equity.at(-1).time,
  };
}
