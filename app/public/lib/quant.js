// Quant checks for a strategy tester result: is the backtest real, or luck and overfitting?
// The methods are the published ones quant desks use :
//   - walk-forward: pick the best settings on the past only, then score them on the next stretch
//   - probability of backtest overfitting (PBO) by combinatorially symmetric cross-validation
//   - probabilistic and deflated Sharpe ratio (Bailey & Lopez de Prado), for skew, fat tails and
//     the number of versions tried
//   - cost stress: double the fees, triple the slippage (at least 0.05% a side, so zero isn't left at zero)
//   - Monte Carlo: reshuffle the trades thousands of times to see the spread of outcomes
//   - parameter robustness: do nearby settings hold up, or is it one lucky number?
//   - 3 months at a time: did it make money in most stretches, or all of it in one run?
// Each variant's returns come from one full backtest: signals only use past bars, so a variant's
// return on any bar is the same whether or not later bars exist. Slicing them is look-ahead free.
import { backtest } from "./backtest.js";
import { BY_ID, defaults } from "./indicators.js";

// ---------- maths ----------
export function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 on erf, accurate to about 1e-7
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function normInv(p) {
  // Acklam's rational approximation, accurate to about 1e-9
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
    -30.66479806614716, 2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866,
    66.80131188771972, -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    0.007784695709041462, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const lo = 0.02425,
    hi = 1 - lo;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > hi) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5,
    r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export function moments(r) {
  const n = r.length;
  const mean = r.reduce((s, x) => s + x, 0) / n;
  let m2 = 0,
    m3 = 0,
    m4 = 0;
  for (const x of r) {
    const d = x - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const sd = Math.sqrt(m2);
  return {
    mean,
    sd,
    skew: sd > 0 ? m3 / sd ** 3 : 0,
    kurt: sd > 0 ? m4 / sd ** 4 : 3,
  };
}

export const sharpe = (r) => {
  if (r.length < 2) return null;
  const { mean, sd } = moments(r);
  return sd > 0 ? mean / sd : null;
};

// Probability the true (per-period) Sharpe beats `benchmark`, given the sample's skew and kurtosis.
export function psr(r, benchmark = 0) {
  if (r.length < 10) return null;
  const { mean, sd, skew, kurt } = moments(r);
  if (!(sd > 0)) return null;
  const sr = mean / sd;
  const denom = Math.sqrt(
    Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr),
  );
  return normCdf(((sr - benchmark) * Math.sqrt(r.length - 1)) / denom);
}

// The best Sharpe you'd expect from n tries of pure noise with this spread of Sharpes.
export function expectedMaxSharpe(n, variance) {
  if (n < 2 || !(variance > 0)) return 0;
  const g = 0.5772156649015329;
  return (
    Math.sqrt(variance) *
    ((1 - g) * normInv(1 - 1 / n) + g * normInv(1 - 1 / (n * Math.E)))
  );
}

// Probability of backtest overfitting: split the history into `blocks`, try every half/half split,
// pick the best variant on one half and see where it ranks on the other.
export function pbo(matrix, blocks = 8) {
  const V = matrix.length,
    T = matrix[0]?.length || 0;
  if (V < 2 || T < blocks * 5) return null;
  const size = Math.floor(T / blocks);
  const slice = (r, ids) =>
    ids.flatMap((b) => r.slice(b * size, (b + 1) * size));
  const combos = [];
  const pick = (start, chosen) => {
    if (chosen.length === blocks / 2) {
      combos.push([...chosen]);
      return;
    }
    for (let b = start; b < blocks; b++) {
      chosen.push(b);
      pick(b + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  let below = 0,
    counted = 0;
  for (const is of combos) {
    const oos = [...Array(blocks).keys()].filter((b) => !is.includes(b));
    const isS = matrix.map((r) => sharpe(slice(r, is)) ?? -Infinity);
    const best = isS.indexOf(Math.max(...isS));
    const oosS = matrix.map((r) => sharpe(slice(r, oos)) ?? -Infinity);
    const rank = oosS.filter((s) => s < oosS[best]).length + 1; // 1 = worst
    const w = rank / (V + 1);
    counted++;
    if (Math.log(w / (1 - w)) <= 0) below++;
  }
  return { pbo: below / counted, splits: counted };
}

// Seeded random numbers, so the same strategy always shows the same Monte Carlo.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function monteCarlo(tradePcts, runs = 2000, seed = 7) {
  if (tradePcts.length < 5) return null;
  const rand = rng(seed),
    finals = [],
    dds = [];
  for (let k = 0; k < runs; k++) {
    let eq = 1,
      peak = 1,
      dd = 0;
    for (let i = 0; i < tradePcts.length; i++) {
      eq *= 1 + tradePcts[Math.floor(rand() * tradePcts.length)] / 100;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, (peak - eq) / peak);
    }
    finals.push((eq - 1) * 100);
    dds.push(dd * 100);
  }
  const q = (arr, p) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  return {
    runs,
    p5: q(finals, 0.05),
    p50: q(finals, 0.5),
    p95: q(finals, 0.95),
    ddP50: q(dds, 0.5),
    ddP95: q(dds, 0.95),
    lossProb: (finals.filter((x) => x < 0).length / runs) * 100,
  };
}

// The testing period 3 months at a time (a quarter of a year each; a last piece under half that joins the
// one before): in each stretch the strategy's return, buy and hold over the same bars, and the trades that
// closed there. It passes when it made money in most of them. Losing less than holding doesn't count: a
// strategy that made its money in one run and lost or sat still the rest of the time fails. Null under 4.
export const QUARTER = (365.25 / 4) * 86400;
export function byQuarter(equity, bars, trades = []) {
  if (!(equity?.length > 2)) return null;
  const close = new Map(bars.map((b) => [b.time, b.close]));
  const t0 = equity[0].time;
  // the last equity point of each quarter that has any
  const ends = [];
  for (let i = 1; i < equity.length; i++) {
    const k = Math.floor((equity[i].time - t0) / QUARTER);
    if (ends.length && ends.at(-1).k === k) ends.at(-1).i = i;
    else ends.push({ k, i });
  }
  if (ends.length > 1 && equity.at(-1).time - equity[ends.at(-2).i].time < QUARTER / 2) ends.splice(-2, 1);
  const rows = ends.map(({ i: e }, n) => {
    const a = equity[n ? ends[n - 1].i : 0],
      b = equity[e];
    const c0 = close.get(a.time),
      c1 = close.get(b.time);
    const returnPct = a.value > 0 ? (b.value / a.value - 1) * 100 : null;
    const buyHoldPct = c0 > 0 && c1 != null ? (c1 / c0 - 1) * 100 : null;
    return {
      from: a.time,
      to: b.time,
      returnPct,
      buyHoldPct,
      trades: trades.filter((t) => t.exitTime > a.time && t.exitTime <= b.time).length,
    };
  });
  if (rows.length < 4) return null;
  const made = rows.filter((r) => r.returnPct > 0).length;
  return {
    rows,
    made,
    of: rows.length,
    gate: {
      key: "quarters",
      label: "3 months at a time",
      value: `Made money in ${made} of ${rows.length} three-month stretches (needs 60%+)`,
      pass: made / rows.length >= 0.6,
    },
  };
}

// ---------- the checks ----------
const perBar = (equity) =>
  equity.slice(1).map((e, i) => e.value / equity[i].value - 1);
export const periodsPerYear = (bars) =>
  bars.length > 1
    ? (365 * 86400 * (bars.length - 1)) / (bars.at(-1).time - bars[0].time)
    : 252;

// Up to two whole-number settings to vary (indicator lengths and the like).
function tunables(strategy) {
  const out = [];
  for (const [key, spec] of Object.entries(strategy.indicators || {})) {
    const def = BY_ID[spec.id];
    if (!def) continue;
    const p = { ...defaults(spec.id), ...(spec.params || {}) };
    for (const inp of def.inputs || []) {
      if (inp.type !== "int" || !(p[inp.key] >= 2)) continue;
      out.push({
        key,
        param: inp.key,
        base: p[inp.key],
        label: `${def.name.replace(/ \(.*\)$/, "")} ${inp.label.toLowerCase()}`,
      });
      if (out.length === 2) return out;
    }
  }
  return out;
}

function withParams(strategy, settings) {
  const s = structuredClone(strategy);
  for (const { key, param, value } of settings)
    s.indicators[key].params = {
      ...(s.indicators[key].params || {}),
      [param]: value,
    };
  return s;
}

export function quantChecks(bars, strategy, { mcRuns = 2000, subBars = null } = {}) {
  const ppy = periodsPerYear(bars),
    ann = Math.sqrt(ppy);
  const base = backtest(bars, strategy, { subBars });
  const baseR = perBar(base.equity);
  const tun = tunables(strategy);
  const MULT = [0.6, 0.8, 1, 1.2, 1.4];
  const axis = (t) => [
    ...new Set(MULT.map((m) => Math.max(2, Math.round(t.base * m)))),
  ];
  const axes = tun.map(axis);
  const variants = [];
  const grid =
    tun.length === 0
      ? [[]]
      : tun.length === 1
        ? axes[0].map((v) => [v])
        : axes[0].flatMap((a) => axes[1].map((b) => [a, b]));
  for (const vals of grid) {
    const settings = tun.map((t, k) => ({ ...t, value: vals[k] }));
    const isBase = settings.every((x) => x.value === x.base);
    const r = isBase ? base : backtest(bars, withParams(strategy, settings), { subBars });
    const ret = perBar(r.equity);
    variants.push({
      values: vals,
      isBase,
      returns: ret,
      sharpe: sharpe(ret),
      netPct: r.stats.netProfitPct,
      trades: r.stats.totalTrades,
    });
  }
  const matrix = variants.map((v) => v.returns);
  const gates = [];

  // walk-forward: anchored, 5 test windows after the first 30% of history
  let walkForward = null;
  if (variants.length > 1 && baseR.length > 100) {
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
        from: bars[s + 1]?.time,
        to: bars[e]?.time,
        chosen: variants[best].values,
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
  const overfit = variants.length > 2 ? pbo(matrix) : null;
  if (overfit)
    gates.push({
      key: "pbo",
      label: "Overfitting (PBO)",
      value: `${(overfit.pbo * 100).toFixed(1)}% chance the best-looking settings are below average on unseen data (needs under 50%)`,
      pass: overfit.pbo < 0.5,
    });

  // Sharpe significance
  const srs = variants.map((v) => v.sharpe).filter((x) => x != null);
  const varSr =
    srs.length > 1 ? moments(srs).sd ** 2 * (srs.length / (srs.length - 1)) : 0;
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
  const stressSlip = Math.max((strategy.slippagePct ?? 0.05) * 3, 0.05);
  const stressed = backtest(
    bars,
    {
      ...strategy,
      feePct: (strategy.feePct ?? 0.1) * 2,
      slippagePct: stressSlip,
      spreadPct: (strategy.spreadPct ?? 0) * 2,
    },
    { subBars },
  );
  gates.push({
    key: "cost",
    label: "Cost stress",
    value: `${stressed.stats.netProfitPct >= 0 ? "+" : ""}${stressed.stats.netProfitPct}% with double fees and ${+stressSlip.toFixed(3)}% slippage a side${strategy.spreadPct ? " and double the spread" : ""} (needs above 0)`,
    pass: stressed.stats.netProfitPct > 0,
  });

  // robustness: share of neighbouring settings that keep at least half the base Sharpe
  let robustness = null;
  if (variants.length > 1) {
    const b = variants.find((v) => v.isBase)?.sharpe ?? 0;
    const others = variants.filter((v) => !v.isBase);
    const ok = others.filter(
      (v) => v.sharpe != null && b > 0 && v.sharpe >= b * 0.5,
    ).length;
    robustness = {
      share: (ok / others.length) * 100,
      params: tun.map((t, k) => ({
        label: t.label,
        values: axes[k],
        base: t.base,
      })),
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

  // a trade's % is on the money in it; the account only moves by the share positionPct put in
  const sizePct = strategy.positionPct ?? 100;
  const mc = monteCarlo(
    base.trades.map((t) => (t.pnlPct * sizePct) / 100),
    mcRuns,
  );
  return {
    base: {
      sharpe: (sharpe(baseR) ?? 0) * ann,
      netPct: base.stats.netProfitPct,
      trades: base.stats.totalTrades,
    },
    variants: variants.map(({ returns, ...v }) => ({
      ...v,
      sharpe: v.sharpe == null ? null : v.sharpe * ann,
    })),
    tunables: tun.map((t, k) => ({
      label: t.label,
      base: t.base,
      values: axes[k],
    })),
    walkForward,
    pbo: overfit,
    psr: probSharpe,
    dsr: deflated,
    sr0: sr0 * ann,
    trials: srs.length,
    costStress: stressed.stats.netProfitPct,
    robustness,
    quarters,
    monteCarlo: mc,
    gates,
    passed: gates.filter((g) => g.pass).length,
  };
}
