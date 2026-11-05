// TradingView's strategy report, in the Strategy tester: the strategy on the chart, then Metrics (Key
// stats and the Performance chart), Trades (every trade, entry and exit) or Quant checks (the tester's
// gold checks, on the script's own settings). It reads the result the
// chart already computed (pane.indResults[uid].strategy), so it follows inputs, symbol and timeframe.
// A testing period that starts before the chart's first bar runs here only, on more bars (TradingView's
// deep backtesting). A script's title, order ids and comments come from strangers' code: they only go
// out through esc().
import { esc, download, ticker, api } from "./api.js";
import { BY_ID } from "../lib/indicators.js";
import { parseTf } from "../lib/series.js";
import { numberInputs, pineChecks } from "../lib/pinequant.js";
import { render as quantHtml } from "./quantui.js";

const LW = window.LightweightCharts;
const svg = (body, cls = "") => `<svg viewBox="0 0 28 28"${cls ? ` class="${cls}"` : ""}>${body}</svg>`;
const ICON = {
  strategy: svg('<path d="M5 21l6-7 4 4 8-10"/><path d="M18 8h5v5"/>'),
  chevron: svg('<path d="M10 12l4 4 4-4"/>', "sr-chev"),
  metrics: svg('<path d="M6 19l5-6 4 4 7-8"/>'),
  trades: svg('<rect x="6" y="7" width="16" height="14" rx="1.5"/><path d="M6 12h16M6 16.5h16M11.5 7v14"/>'),
  checks: svg('<path d="M14 5l8 3v6c0 4.5-3.4 7.6-8 9-4.6-1.4-8-4.5-8-9V8z"/><path d="M10.5 14l2.5 2.5 4.5-5"/>'),
  calendar: svg('<rect x="6" y="8" width="16" height="14" rx="2"/><path d="M6 12.5h16M10.5 6v4M17.5 6v4"/>'),
  money: svg('<circle cx="14" cy="14" r="8.5"/><path d="M16.8 10.8c-.6-.9-1.6-1.3-2.8-1.3-1.6 0-2.8.9-2.8 2.1 0 2.9 5.8 1.5 5.8 4.6 0 1.3-1.3 2.2-3 2.2-1.3 0-2.4-.5-3-1.5M14 8v1.5M14 18.5V20"/>'),
  gear: svg('<path d="M5 14l4.5-7.8h9L23 14l-4.5 7.8h-9z"/><circle cx="14" cy="14" r="2.8"/>'),
  alarm: svg('<circle cx="13" cy="15" r="7"/><path d="M13 11v4l2.5 2M6 7.5L8.5 5M20 7.5L17.5 5M21 19v5M18.5 21.5h5"/>'),
  detail: svg('<path d="M8.5 6.5h8l3 3v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><circle cx="13.5" cy="15" r="3"/><path d="M15.7 17.2l2.3 2.3"/>'),
  exec: svg('<path d="M5 18l4-5 3 3 4-6 3 4 4-4"/><path d="M14 22v-3M12.5 20.5L14 22l1.5-1.5"/>'),
  camera: svg('<path d="M7 10h3l1.5-2h5l1.5 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z"/><circle cx="14" cy="15" r="3.2"/>'),
  download: svg('<path d="M14 6v11M9.5 12.5L14 17l4.5-4.5M7 21h14"/>'),
  columns: svg('<rect x="6" y="8" width="16" height="12" rx="2"/><path d="M10 8v12M14 8v12M18 8v12"/>'),
  eyeOff: svg('<path d="M5 14s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="14" cy="14" r="2.6"/><path d="M6 22L22 6"/>'),
  up: svg('<path d="M9 16l5-5 5 5"/>'),
  help: (tip) => `<span class="sr-help" title="${esc(tip)}">?</span>`,
  info: (tip) => `<span class="cs-help is-info" title="${esc(tip)}">i</span>`,
};
const PERF_TIP = "Cumulative PnL is the change in equity across closed trades. Buy and hold is one long trade held for the whole range. Trades excursions are each trade's best and worst unrealized P&L. Run-ups and drawdowns mark the periods where equity rose or fell.";

// The testing period's choices, as TradingView's
const PERIODS = [
  ["chart", "Available chart range"],
  ["d7", "Last 7 days"],
  ["d30", "Last 30 days"],
  ["d90", "Last 90 days"],
  ["d365", "Last 365 days"],
  ["all", "Entire history"],
];
const DAYS = { d7: 7, d30: 30, d90: 90, d365: 365 };
// The most bars a deep run asks for: the server gives up to 20,000 from an exchange's API, and up to
// 200,000 for a symbol the history store holds (lib/history.js)
const MAX_BARS = 200000;
// Indicators need bars before the period starts to warm up
const WARMUP = 500;
// Trades' columns: Trade number and Type always show
const COLS = [
  ["date", "Date and time", true],
  ["signal", "Signal", false],
  ["price", "Price", true],
  ["size", "Size", true],
  ["pnl", "Net PnL", true],
  ["ret", "Return", true],
  ["fav", "Favorable excursion", false],
  ["adv", "Adverse excursion", false],
  ["cum", "Cumulative PnL", false],
  ["dur", "Duration (bars)", false],
];

// A strategy's testing period as times, or null for the chart's own bars. "Last N days" starts at
// midnight, so the period (and the report's cache of a deep run) holds still through the day; a
// custom end takes its whole day.
export function rangeBounds(r, now = Date.now() / 1000) {
  if (!r || r.kind === "chart" || !r.kind) return null;
  if (DAYS[r.kind]) {
    const d = new Date((now - DAYS[r.kind] * 86400) * 1000);
    d.setHours(0, 0, 0, 0);
    return { from: Math.floor(d.getTime() / 1000), to: null };
  }
  if (r.kind === "all") return { from: 0, to: null, all: true };
  if (r.kind === "custom" && Number.isFinite(r.from)) return { from: r.from, to: Number.isFinite(r.to) ? r.to + 86399 : null };
  return null;
}

const STRATS_OF = (pane) => (pane?.cfg.indicators || []).filter((ind) => BY_ID[ind.id]?.strategy);
export const strategiesOn = STRATS_OF;
// a saved script by the name it's saved under in My scripts (renamed, or a numbered copy)
const nameOf = (def) => def?.saved || def?.name;

// "1000" -> "1K", "2500000" -> "2.5M": the capital in the toolbar
const compact = (v) => {
  const a = Math.abs(v);
  const f = (x, s) => `${+x.toFixed(x < 10 ? 2 : 1)}${s}`;
  return a >= 1e9 ? f(v / 1e9, "B") : a >= 1e6 ? f(v / 1e6, "M") : a >= 1e3 ? f(v / 1e3, "K") : String(+v.toFixed(2));
};
const money = (v, d = 2) => Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(v, d)}`;
const pct = (v, sign = true) => `${sign ? (v > 0 ? "+" : v < 0 ? "−" : "") : ""}${Math.abs(v).toFixed(2)}%`;
const qtyText = (q) => (Math.abs(q) >= 1000 ? q.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(+q.toPrecision(6)));
const priceText = (p) => (Math.abs(p) >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(+p.toPrecision(Math.abs(p) >= 1 ? 6 : 5)));
const dateText = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeText = (t) => new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const isoDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const fromDay = (s) => (s ? Math.floor(new Date(`${s}T00:00:00`).getTime() / 1000) : NaN);
// the account currency: the script's own, else the symbol's quote currency
const currencyOf = (r, symbol) => r.currency || /(USDT|USDC|FDUSD|BUSD|USD|EUR|GBP|JPY|AUD|CAD|CHF|BTC|ETH)$/.exec(ticker(symbol))?.[1] || "USD";
const ctxFor = (pane, ind, bars, range) => ({ symbol: pane.cfg.symbol, tf: pane.cfg.tf, forming: !pane.replay && bars.length > 0 && bars.at(-1).time + parseTf(pane.cfg.tf).seconds > Date.now() / 1000, ...(ind.props ? { strategy: ind.props } : {}), ...(range ? { range } : {}) });

export class StrategyReport {
  constructor(app) {
    this.app = app;
    this.uid = null; // the strategy shown, while it's on the active chart
    this.view = "metrics";
    this.desc = true; // trades, newest first (TradingView's "Trade number ↓")
    this.show = { cum: true, bh: false, exc: true, rud: true };
    this.perfOpen = true;
    this.chart = null;
    this.sig = "";
    this.deep = null; // { key, status, bars, result, error, first, lastTime }
    this.checks = null; // { uid, key, keys, status, done, total, result, error, stop }
    this.cautionOff = false;
  }

  // The strategy to show on `pane`: the one picked, else the first on the chart.
  pick(pane) {
    const list = STRATS_OF(pane);
    return list.find((x) => x.uid === this.uid) || list[0] || null;
  }

  destroy() {
    try { this.chart?.remove(); } catch { /* its element is gone */ }
    this.chart = null;
    this.sig = "";
  }

  // ---- where the result comes from: the chart's run, or a deep run on more bars
  source(pane, ind, host, onBuilder) {
    const bars = pane.shown || [];
    const rb = rangeBounds(ind.range);
    const deep = !!rb && bars.length > 0 && (rb.all || rb.from < bars[0].time);
    if (!deep) {
      const res = pane.indResults?.[ind.uid] || {};
      return { r: res.strategy, error: res.error, pending: res.pending, bars, rb, deep: false };
    }
    const key = [ind.id, pane.cfg.symbol, pane.cfg.tf, JSON.stringify(ind.params || {}), JSON.stringify(ind.props || {}), rb.from, rb.to, rb.all ? 1 : 0].join("|");
    const d = this.deep;
    if (!d || d.key !== key) {
      this.loadDeep(key, pane, ind, rb, host, onBuilder);
      return { pending: true, loading: true, bars, rb, deep: true };
    }
    if (d.status === "loading") return { pending: true, loading: true, bars, rb, deep: true };
    if (d.status === "error") return { error: d.error, bars, rb, deep: true };
    // a new bar on the chart: carry it into the deep run
    const last = bars.at(-1);
    if (last && last.time > d.lastTime) {
      // the deep run's last bar was still forming: the chart's copy of it is final, then the newer ones
      const end = d.bars.at(-1).time;
      d.bars = [...d.bars.filter((b) => b.time < end), ...bars.filter((b) => b.time >= end)];
      d.lastTime = last.time;
      this.runDeep(d, pane, ind, rb);
    }
    return { r: d.result, error: d.error, bars: d.bars, rb, deep: true, first: d.first, cap: d.cap };
  }

  async loadDeep(key, pane, ind, rb, host, onBuilder) {
    const tf = pane.cfg.tf,
      sec = parseTf(tf).seconds;
    const d = (this.deep = { key, status: "loading", bars: [], result: null, error: null, first: null, lastTime: 0 });
    try {
      const want = rb.all ? MAX_BARS : Math.min(MAX_BARS, Math.ceil((Date.now() / 1000 - rb.from) / sec) + WARMUP);
      const r = await api.candles(pane.cfg.symbol, tf, want);
      if (this.deep !== d) return;
      d.bars = pane.convert ? pane.convert(r.candles, tf) : r.candles;
      d.cap = r.maxBars || 20000;
      if (!d.bars.length) throw new Error("The data source sent no bars");
      d.first = d.bars[0].time;
      d.lastTime = d.bars.at(-1).time;
      this.runDeep(d, pane, ind, rb);
      d.status = d.error ? "error" : "ready";
    } catch (e) {
      if (this.deep !== d) return;
      d.status = "error";
      d.error = e.message || String(e);
    }
    // draw it, if the report still shows this strategy
    if (host.isConnected && host.querySelector(".sr") && this.uid === ind.uid && this.app.active === pane) this.render(host, pane, onBuilder);
  }

  runDeep(d, pane, ind, rb) {
    try {
      const def = BY_ID[ind.id];
      const out = def.calc(d.bars, { ...(ind.params || {}), __ctx: ctxFor(pane, ind, d.bars, { from: rb.all ? -Infinity : rb.from, to: rb.to ?? Infinity }) });
      d.result = out.strategy || null;
      d.error = null;
    } catch (e) {
      d.result = null;
      d.error = e.message || String(e);
    }
  }

  // Draw again only when the result changed; a live tick with an open trade only updates that row.
  refresh(host, pane, onBuilder) {
    const ind = this.pick(pane);
    if (!ind) return false;
    // a popover of the report's is open: draw once it closes, not under the pointer
    if (String(this.app.drawToolbar?.pop?.dataset.for || "").startsWith("sr-") && host.querySelector(".sr")) {
      this.stale = { host, pane, onBuilder };
      return true;
    }
    const sig = this.signature(pane, ind, host, onBuilder);
    if (sig !== this.sig || !host.querySelector(".sr")) this.render(host, pane, onBuilder);
    else this.liveOpen(host, pane, ind);
    return true;
  }

  signature(pane, ind, host, onBuilder) {
    const s = this.source(pane, ind, host, onBuilder);
    const r = s.r,
      bars = s.bars || [];
    // the checks run on a copy of the bars: a new bar or tick doesn't change what they show
    if (this.view === "checks") {
      const c = this.checks?.uid === ind.uid ? this.checks : null;
      return [ind.uid, nameOf(BY_ID[ind.id]), this.view, document.documentElement.dataset.theme, s.deep ? 1 : 0, s.error || "", s.pending ? 1 : 0, r ? 1 : 0, this.checksKey(pane, ind), c?.status, c?.key].join("|");
    }
    const t = r?.trades || [];
    return [ind.uid, nameOf(BY_ID[ind.id]), this.view, document.documentElement.dataset.theme, JSON.stringify(ind.range || {}), s.deep ? 1 : 0, s.error || "", s.pending ? 1 : 0, bars.length, bars[0]?.time, t.length, t.at(-1)?.exitTime, t.reduce((a, x) => a + x.pnl, 0).toFixed(6), (r?.open || []).map((o) => o.n).join(","), r?.initialCapital, r?.currency, r?.opts?.calc_on_every_tick ? 1 : 0].join("|");
  }

  render(host, pane, onBuilder) {
    const ind = this.pick(pane);
    if (!ind) return false;
    // the same strategy and view keep their scroll; another one starts at the top
    const keepScroll = this.shownAs === `${ind.uid}|${this.view}` ? host.querySelector(".sr-body")?.scrollTop || 0 : 0;
    this.uid = ind.uid;
    this.shownAs = `${ind.uid}|${this.view}`;
    this.app.drawToolbar?.closePopover?.();
    this.destroy();
    const def = BY_ID[ind.id];
    const s = this.source(pane, ind, host, onBuilder);
    const r = s.r;
    const cur = r ? currencyOf(r, pane.cfg.symbol) : "USD";
    const kind = ind.range?.kind || "chart";
    const chartBars = pane.shown || [];
    const rangeLabel =
      kind === "chart" || !s.rb
        ? chartBars.length
          ? `${dateText(chartBars[0].time)}<i class="sr-dash"></i>${dateText(chartBars.at(-1).time)}`
          : "Available chart range"
        : kind === "custom"
          ? `${dateText(ind.range.from)}<i class="sr-dash"></i>${Number.isFinite(ind.range.to) ? dateText(ind.range.to) : "Now"}`
          : esc(PERIODS.find(([k]) => k === kind)?.[1] || "");
    const exec = 1 + (r?.opts?.calc_on_every_tick ? 1 : 0);
    // the deep run's bars may start later than asked: the data source keeps no older ones
    const short = s.deep && s.first && s.rb && !s.rb.all && s.first > s.rb.from + parseTf(pane.cfg.tf).seconds * (WARMUP + 2);
    const body = s.error
      ? `<div class="sr-empty">This strategy stopped with an error: ${esc(s.error)}</div>`
      : !r
        ? `<div class="sr-empty">${s.loading ? "Loading bars for the testing period…" : s.pending ? "Calculating…" : "No results yet."}</div>`
        : this.view === "trades"
          ? this.tradesHtml(r, cur)
          : this.view === "checks"
            ? this.checksHtml(pane, ind, def)
            : this.metricsHtml(r, cur);
    host.innerHTML = `<div class="sr">
      <div class="sr-bar">
        <button class="sr-name" data-x="pick" title="Strategies on this chart">${ICON.strategy}<span>${esc(nameOf(def) || "Strategy")}</span>${ICON.chevron}</button>
        <span class="sr-sep"></span>
        <div class="sr-seg"><button data-v="metrics" class="${this.view === "metrics" ? "on" : ""}" title="Metrics">${ICON.metrics}</button><button data-v="trades" class="${this.view === "trades" ? "on" : ""}" title="List of trades">${ICON.trades}</button><button data-v="checks" class="${this.view === "checks" ? "on" : ""}" title="Quant checks">${ICON.checks}</button></div>
        <button class="sr-chip" data-m="period" title="Testing period">${ICON.calendar}<span>${rangeLabel}</span>${s.deep ? '<em class="sr-deep">Deep</em>' : ""}${ICON.chevron}</button>
        ${r ? `<button class="sr-chip" data-m="capital" title="Initial capital">${ICON.money}<span>${compact(r.initialCapital)}<small>${esc(cur)}</small></span>${ICON.chevron}</button>` : ""}
        <button class="sr-chip" data-m="detail" title="Bar detalization">${ICON.detail}<span>Default detalization</span>${ICON.chevron}</button>
        <button class="sr-chip" data-m="exec" title="Script execution">${ICON.exec}<span>Script execution</span><b class="sr-count">${exec}</b>${ICON.chevron}</button>
        <span class="sr-sep"></span>
        <button class="sr-ic" data-x="settings" title="Settings">${ICON.gear}</button>
        <button class="sr-ic" disabled title="Alerts on strategies aren't built yet">${ICON.alarm}</button>
      </div>
      <div class="sr-body">${body}${s.deep && !this.cautionOff ? `<div class="sr-caution"><span class="sr-warn">!</span><span><b>Caution!</b> Deep backtesting trades only appear here, in the strategy report, and aren't shown on the chart.${short ? ` Bars from ${dateText(s.first)} on: ${s.bars.length >= (s.cap || 20000) ? `the most this app loads (${(s.cap || 20000).toLocaleString("en-US")} bars)` : "all the data source keeps"}.` : ""}</span><button data-x="caution" title="Close">×</button></div>` : ""}</div>
    </div>`;
    const bodyEl = host.querySelector(".sr-body");
    host.querySelector('[data-x="pick"]').onclick = (e) => this.pickMenu(e.currentTarget, host, pane, onBuilder);
    host.querySelector('[data-x="settings"]').onclick = () => this.app.openIndicatorSettings(pane, ind, "properties");
    host.querySelector('[data-x="caution"]')?.addEventListener("click", () => {
      this.cautionOff = true;
      host.querySelector(".sr-caution")?.remove();
    });
    host.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => this.menu(b, b.dataset.m, host, pane, ind, onBuilder, r)));
    host.querySelectorAll(".sr-seg [data-v]").forEach((b) => {
      b.onclick = () => {
        if (this.view === b.dataset.v) return;
        this.view = b.dataset.v;
        this.render(host, pane, onBuilder);
      };
    });
    if (r && this.view === "trades") {
      host.querySelector('[data-x="csv"]').onclick = () => download(`${ticker(pane.cfg.symbol)}-${pane.cfg.tf}-${(nameOf(def) || "strategy").replace(/[^\w.-]+/g, "_").slice(0, 40)}-trades.csv`, this.csv(r, cur));
      host.querySelector('[data-x="cols"]').onclick = (e) => this.menu(e.currentTarget, "cols", host, pane, ind, onBuilder, r);
      const sort = host.querySelector('[data-x="sort"]');
      if (sort)
        sort.onclick = () => {
          this.desc = !this.desc;
          this.render(host, pane, onBuilder);
        };
    }
    if (r && this.view === "metrics") this.mountChart(host, pane, r, cur, def, s.bars, s.rb);
    if (r && this.view === "checks") {
      host.querySelector('[data-q="run"]').onclick = () => this.runChecks(host, pane, ind, onBuilder);
      const stop = host.querySelector('[data-q="stop"]');
      if (stop) stop.onclick = () => this.checks && (this.checks.stop = true);
    }
    bodyEl.scrollTop = keepScroll;
    this.sig = this.signature(pane, ind, host, onBuilder);
    return true;
  }

  // ---- the toolbar's popovers: Testing period, Initial capital, Bar detalization, Script execution, columns
  menu(btn, which, host, pane, ind, onBuilder, r) {
    const tb = this.app.drawToolbar;
    if (tb.pop?.dataset.for === `sr-${which}`) return tb.closePopover();
    tb.closePopover();
    const redo = () => {
      this.app.persist();
      pane.render(false);
      this.render(host, pane, onBuilder);
    };
    const setProp = (k, v) => {
      ind.props = { ...(ind.props || {}), [k]: v };
      redo();
    };
    const head = (title, tip, reset) => `<div class="sr-mh"><b>${title}</b>${tip ? ICON.help(tip) : ""}<span class="sr-grow"></span>${reset != null ? `<button data-reset ${reset ? "" : "disabled"}>Reset</button>` : ""}</div>`;
    let html = "";
    if (which === "period") {
      const kind = ind.range?.kind || "chart";
      html = `${head("Testing period", null, kind !== "chart")}<div class="sr-ml">${PERIODS.map(([k, l]) => `<button data-p="${k}" class="${k === kind ? "on" : ""}"><span>${l}</span>${k === "chart" ? "<em>Default</em>" : ""}</button>`).join("")}<hr><button data-p="custom" class="${kind === "custom" ? "on" : ""}">${ICON.calendar}<span>Custom date range</span></button></div>
        <div class="sr-custom" hidden><label>From<input type="date" class="cs-num" data-d="from"></label><label>To<input type="date" class="cs-num" data-d="to"></label><button class="btn primary small" data-d="apply">Apply</button></div>`;
    } else if (which === "capital") {
      html = `${head("Initial capital")}<div class="sr-mrow"><input class="cs-num sr-cap" inputmode="decimal" value="${esc((r?.initialCapital ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 }))}"><button class="cs-dd" disabled title="Results stay in the symbol's own currency; converting them isn't built yet"><span>${esc(r ? currencyOf(r, pane.cfg.symbol) : "USD")}</span></button></div>`;
    } else if (which === "detail") {
      html = `${head("Bar detalization", "How the strategy fills orders inside a bar: TradingView's four ticks per bar (open, the nearer extreme, the far one, close).")}<div class="sr-ml"><button class="on"><span>Default detalization</span><em>4 ticks per bar</em></button><button disabled title="Needs lower-timeframe bars, not built yet"><span>High detalization</span><em>~40 ticks per bar</em></button></div>`;
    } else if (which === "exec") {
      const tick = !!ind.props?.calc_on_every_tick || (ind.props?.calc_on_every_tick == null && r?.opts?.calc_on_every_tick === true);
      const row = (label, on, tip, dis, k) => `<label class="cs-chk${dis ? " dis" : ""}"><input type="checkbox" ${on ? "checked" : ""} ${dis ? "disabled" : ""}${k ? ` data-e="${k}"` : ""}><span class="cs-box"></span><span>${label}</span></label>${ICON.info(tip)}`;
      html = `${head("Script execution", "When the script runs. It always runs as each bar closes; these add more runs.", ind.props?.calc_on_every_tick != null)}<div class="sr-mc">${row("On bar close", true, "The script runs as each bar closes. Always on.", true)}${row("On order fill", false, "Run again after an order fills, inside the bar. Not built yet.", true)}${row("On realtime bar tick", tick, "On a live bar, run on every price update, so its orders are placed as it moves. Bars in the past aren't affected.", false, "tick")}</div>`;
    } else if (which === "cols") {
      const shown = this.cols();
      html = `${head("Columns")}<div class="sr-mc">${COLS.map(([k, l]) => `<label class="cs-chk"><input type="checkbox" data-c="${k}" ${shown.includes(k) ? "checked" : ""}><span class="cs-box"></span><span>${l}</span></label><span></span>`).join("")}</div><div class="sr-mnote">Trade number and Type always show.</div>`;
    }
    const pop = tb.openPopover(btn, html, `sr-${which}`);
    pop.classList.add("sr-menu", `sr-menu-${which}`);
    const rect = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(which === "cols" ? rect.right - pop.offsetWidth : rect.left, innerWidth - pop.offsetWidth - 4))}px`;
    // under the button, kept inside the window (the bottom panel sits low)
    const place = () => (pop.style.top = `${Math.max(4, Math.min(rect.bottom + 4, innerHeight - pop.offsetHeight - 4))}px`);
    place();
    btn.classList.add("open");
    const mo = new MutationObserver(() => {
      if (!pop.isConnected) {
        btn.classList.remove("open");
        mo.disconnect();
        // results that came in while it was open
        const st = this.stale;
        this.stale = null;
        if (st && this.app.active === st.pane) this.refresh(st.host, st.pane, st.onBuilder);
      }
    });
    mo.observe(document.body, { childList: true });
    pop.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (which === "period") {
        if (b?.dataset.reset != null) {
          delete ind.range;
          tb.closePopover();
          return redo();
        }
        const p = b?.dataset.p;
        if (p === "custom") {
          const box = pop.querySelector(".sr-custom");
          box.hidden = false;
          const b0 = rangeBounds(ind.range) || { from: pane.shown?.[0]?.time ?? Date.now() / 1000 - 30 * 86400 };
          box.querySelector('[data-d="from"]').value = isoDay(ind.range?.kind === "custom" ? ind.range.from : b0.from);
          box.querySelector('[data-d="to"]').value = isoDay(ind.range?.kind === "custom" && Number.isFinite(ind.range.to) ? ind.range.to : Date.now() / 1000);
          place();
          return;
        }
        if (p) {
          if (p === "chart") delete ind.range;
          else ind.range = { kind: p };
          tb.closePopover();
          return redo();
        }
        if (b?.dataset.d === "apply") {
          const from = fromDay(pop.querySelector('[data-d="from"]').value),
            to = fromDay(pop.querySelector('[data-d="to"]').value);
          if (!Number.isFinite(from)) return this.app.toast("Pick the first day of the period.", "err");
          if (Number.isFinite(to) && to < from) return this.app.toast("The period ends before it starts.", "err");
          ind.range = { kind: "custom", from, ...(Number.isFinite(to) ? { to } : {}) };
          tb.closePopover();
          return redo();
        }
      } else if (which === "exec" && b?.dataset.reset != null) {
        const { calc_on_every_tick, ...rest } = ind.props || {};
        ind.props = Object.keys(rest).length ? rest : undefined;
        if (!ind.props) delete ind.props;
        tb.closePopover();
        redo();
      }
    });
    pop.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.e === "tick") {
        tb.closePopover();
        return setProp("calc_on_every_tick", t.checked);
      }
      if (t.dataset.c) {
        const shown = new Set(this.cols());
        t.checked ? shown.add(t.dataset.c) : shown.delete(t.dataset.c);
        this.app.settings.srCols = COLS.map(([k]) => k).filter((k) => shown.has(k));
        this.app.persist();
        const keep = host.querySelector(".sr-body")?.scrollTop || 0;
        const wrap = host.querySelector(".sr-tradeswrap");
        if (wrap && r) {
          wrap.outerHTML = this.tradesHtml(r, currencyOf(r, pane.cfg.symbol));
          host.querySelector('[data-x="csv"]').onclick = () => download(`${ticker(pane.cfg.symbol)}-${pane.cfg.tf}-trades.csv`, this.csv(r, currencyOf(r, pane.cfg.symbol)));
          host.querySelector('[data-x="cols"]').onclick = (ev) => this.menu(ev.currentTarget, "cols", host, pane, ind, onBuilder, r);
          const sort = host.querySelector('[data-x="sort"]');
          if (sort)
            sort.onclick = () => {
              this.desc = !this.desc;
              this.render(host, pane, onBuilder);
            };
          host.querySelector(".sr-body").scrollTop = keep;
        }
      }
    });
    if (which === "capital") {
      const inp = pop.querySelector(".sr-cap");
      inp.focus();
      inp.select();
      // Enter applies and closes; the field's change on losing focus mustn't apply (or close) it again
      let done = false;
      const apply = () => {
        if (done) return;
        const n = Number(String(inp.value).replace(/[,\s]/g, ""));
        if (!(n > 0) || !Number.isFinite(n)) {
          inp.value = (r?.initialCapital ?? 0).toLocaleString("en-US");
          return this.app.toast("Initial capital is a positive amount.", "err");
        }
        done = true;
        tb.closePopover();
        if (n !== r?.initialCapital) setProp("initial_capital", n);
      };
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply();
        if (e.key === "Escape") tb.closePopover();
      });
      inp.addEventListener("change", apply);
    }
  }

  cols() {
    const saved = this.app.settings.srCols;
    return Array.isArray(saved) ? saved.filter((k) => COLS.some(([c]) => c === k)) : COLS.filter(([, , on]) => on).map(([k]) => k);
  }

  pickMenu(btn, host, pane, onBuilder) {
    const tb = this.app.drawToolbar;
    if (tb.pop?.dataset.for === "sr-pick") return tb.closePopover();
    tb.closePopover();
    const list = STRATS_OF(pane);
    // the strategies on the chart, then the two ways to build one: described to the AI, or rule by rule
    const html = `<div class="sr-ml">${list.map((x) => `<button data-u="${esc(x.uid)}" class="${x.uid === this.uid ? "on" : ""}"><span>${esc(nameOf(BY_ID[x.id]) || x.id)}</span></button>`).join("")}<hr><button data-b="ai"><span>Build a strategy for me</span></button><button data-b="rules"><span>Pick the rules myself</span></button></div>`;
    const pop = tb.openPopover(btn, html, "sr-pick");
    pop.classList.add("sr-menu", "sr-pop");
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(4, r.left)}px`;
    pop.onclick = (e) => {
      const b = e.target.closest("[data-u], [data-b]");
      if (!b) return;
      tb.closePopover();
      if (b.dataset.b) return onBuilder?.(b.dataset.b);
      this.uid = b.dataset.u;
      this.render(host, pane, onBuilder);
    };
  }

  // ---- Metrics: Key stats and the Performance chart
  // ---- Quant checks: what they ran on, so a change of settings, symbol, interval or period shows
  checksKey(pane, ind) {
    return [ind.id, pane.cfg.symbol, pane.cfg.tf, JSON.stringify(ind.params || {}), JSON.stringify(ind.props || {}), JSON.stringify(ind.range || {})].join("|");
  }

  checksHtml(pane, ind, def) {
    const nums = numberInputs(def?.inputs).filter((x) => Number(ind.params?.[x.key] ?? x.default) > 0);
    const c = this.checks?.uid === ind.uid ? this.checks : null;
    const keys = c ? c.keys : nums.slice(0, 2).map((x) => x.key);
    const options = (sel) => `<option value="">Nothing</option>${nums.map((x) => `<option value="${esc(x.key)}"${x.key === sel ? " selected" : ""}>${esc(x.label)}</option>`).join("")}`;
    const running = c?.status === "running";
    let out = "";
    if (running) out = `<p class="hint-text" data-q="msg">${c.total ? `Checking ${c.done} of ${c.total}…` : "Checking…"}</p>`;
    else if (c?.status === "done") {
      const q = c.result,
        n = q.base.trades;
      out =
        (c.key !== this.checksKey(pane, ind) ? `<p class="sr-qnote">The settings, symbol, interval or testing period changed since these checks ran. Run them again to check what's on the chart now.</p>` : "") +
        `<p class="hint-text">Checked on ${q.bars.toLocaleString("en-US")} bars, ${dateText(q.from)} to ${dateText(q.to)}.${q.failed ? ` ${q.failed} version${q.failed === 1 ? "" : "s"} stopped with an error and ${q.failed === 1 ? "was" : "were"} left out.` : ""}</p>` +
        (q.thin ? `<p class="sr-qnote">Only ${n} closed trade${n === 1 ? "" : "s"}. Under 30, a backtest says little whatever these checks say. A longer testing period, or a shorter interval, gives more.</p>` : "") +
        (q.sizePct != null && q.sizePct < 1 ? `<p class="sr-qnote">A trade here puts about ${+q.sizePct.toPrecision(2)}% of the starting capital to work, so the returns are tiny. The checks still compare the versions fairly. For returns that mean something, open Settings (the gear on this bar), Properties, and set Default order size to 100 % of equity.</p>` : "") +
        quantHtml(q);
    } else if (c?.status === "error") out = `<p class="down">${esc(c.error)}</p>`;
    else if (c?.status === "stopped") out = `<p class="hint-text">${c.timedOut ? "Stopped after two minutes: this script is slow to run 25 times. A shorter testing period checks faster." : "Stopped."}</p>`;
    return `<div class="gold-box sr-quant">
      <div class="gold-head"><span class="gold-badge">Bonus</span><b>Quant checks</b></div>
      <p class="hint-text">The checks quant desks run before they trust a backtest: walk-forward, overfitting (PBO), deflated Sharpe, cost stress, nearby settings, 3 months at a time, and a Monte Carlo of the trades. They run this script on its testing period about 25 times with nearby values of the settings picked here, and once with double the commission and more slippage. The chart and its strategy stay as they are.</p>
      ${nums.length ? `<div class="row-flex sr-qpick"><label>Vary <select class="in" data-q="k0"${running ? " disabled" : ""}>${options(keys[0])}</select></label><label>and <select class="in" data-q="k1"${running ? " disabled" : ""}>${options(keys[1])}</select></label></div>` : '<p class="hint-text">This script has no number settings to vary, so only the cost stress and the Monte Carlo can run.</p>'}
      <div class="row-flex"><button class="btn gold" data-q="run"${running ? " disabled" : ""}>${c?.status === "done" ? "Run again" : "Run quant checks"}</button>${running ? '<button class="btn" data-q="stop">Stop</button>' : ""}</div>
      <div data-q="out">${out}</div>
    </div>`;
  }

  // On a copy of the report's bars (without one still forming) and its testing period, one version
  // at a time, so the page keeps working; the chart's own strategy isn't touched.
  async runChecks(host, pane, ind, onBuilder) {
    const def = BY_ID[ind.id];
    const s = this.source(pane, ind, host, onBuilder);
    if (!def || !s.r || !s.bars?.length) return;
    let bars = s.bars;
    if (!pane.replay && bars.at(-1).time + parseTf(pane.cfg.tf).seconds > Date.now() / 1000) bars = bars.slice(0, -1);
    const rb = s.rb;
    const range = s.deep ? { from: rb.all ? -Infinity : rb.from, to: rb.to ?? Infinity } : rb && !rb.all && rb.from >= bars[0].time ? { from: rb.from, to: rb.to ?? Infinity } : null;
    const ctx = { ...ctxFor(pane, ind, bars, range), forming: false };
    const picked = [...host.querySelectorAll(".sr-qpick select")].map((x) => x.value);
    const c = (this.checks = { uid: ind.uid, key: this.checksKey(pane, ind), keys: picked, status: "running", done: 0, total: 0, stop: false, deadline: Date.now() + 120000 });
    this.render(host, pane, onBuilder);
    try {
      c.result = await pineChecks({
        inputs: def.inputs,
        params: ind.params || {},
        bars,
        keys: picked.length ? [...new Set(picked.filter(Boolean))] : null,
        run: (params, props) => {
          const out = def.calc(bars, { ...params, __ctx: props ? { ...ctx, strategy: { ...(ctx.strategy || {}), ...props } } : ctx });
          if (!out.strategy) throw new Error("The script gave no strategy result");
          return out.strategy;
        },
        progress: (done, total) => {
          c.done = done;
          c.total = total;
          const m = host.querySelector('[data-q="msg"]');
          if (m && this.checks === c) m.textContent = `Checking ${done} of ${total}…`;
        },
        stopped: () => {
          if (Date.now() > c.deadline) c.timedOut = true;
          return c.stop || c.timedOut || this.checks !== c;
        },
      });
      c.status = "done";
    } catch (e) {
      c.status = e.stopped ? "stopped" : "error";
      c.error = e.message || String(e);
    }
    if (this.checks === c && host.isConnected && this.view === "checks" && this.uid === ind.uid && this.app.active === pane) this.render(host, pane, onBuilder);
  }

  metricsHtml(r, cur) {
    const t = r.trades;
    const net = t.reduce((a, x) => a + x.pnl, 0);
    const wins = t.filter((x) => x.pnl > 0).length;
    const gp = t.filter((x) => x.pnl > 0).reduce((a, x) => a + x.pnl, 0),
      gl = -t.filter((x) => x.pnl < 0).reduce((a, x) => a + x.pnl, 0);
    const cls = net > 0 ? "up" : net < 0 ? "down" : "";
    const pf = gl > 0 ? (gp / gl).toFixed(3) : gp > 0 ? "∞" : "—";
    const toggle = (k, label) => `<button data-p="${k}" class="${this.show[k] ? "on" : ""}">${label}${this.show[k] ? "" : ICON.eyeOff}</button>`;
    return `<h3 class="sr-h">Key stats</h3>
      <div class="sr-keys">
        <div><div class="k">Total PnL</div><div class="v ${cls}">${signed(net)}<small>${esc(cur)}</small><span>${pct((net / r.initialCapital) * 100)}</span></div></div>
        <div><div class="k">Max drawdown</div><div class="v">${money(r.maxDdIntrabar)}<small>${esc(cur)}</small><span>${pct(r.maxDdIntrabarPct, false)}</span></div></div>
        <div><div class="k">Profitable trades</div><div class="v">${t.length ? pct((wins / t.length) * 100, false) : "—"}<span>${wins}/${t.length}</span></div></div>
        <div><div class="k">Profit factor</div><div class="v">${pf}</div></div>
      </div>
      <div class="sr-perf-h"><h3 class="sr-h">Performance</h3>${ICON.help(PERF_TIP)}<span class="sr-grow"></span><button class="sr-ic sr-box" data-x="shot" title="Take a snapshot of the chart">${ICON.camera}</button></div>
      <div class="sr-perf${this.perfOpen ? "" : " closed"}">
        <div class="sr-legend">${toggle("cum", "Cumulative PnL")}${toggle("bh", "Buy and hold")}${toggle("exc", "Trades excursions")}${toggle("rud", "Run-ups and drawdowns")}<button class="sr-fold" data-x="fold" title="${this.perfOpen ? "Collapse" : "Expand"}">${ICON.up}</button></div>
        ${t.length ? '<div class="sr-chart"></div>' : '<div class="sr-chart sr-none">This strategy made no trades in the testing period.</div>'}
      </div>`;
  }

  mountChart(host, pane, r, cur, def, bars = pane.shown || [], rb = null) {
    host.querySelectorAll(".sr-legend [data-p]").forEach((b) => {
      b.onclick = () => {
        this.show[b.dataset.p] = !this.show[b.dataset.p];
        this.render(host, pane);
      };
    });
    host.querySelector('[data-x="fold"]').onclick = () => {
      this.perfOpen = !this.perfOpen;
      this.render(host, pane);
    };
    const el = host.querySelector(".sr-chart:not(.sr-none)");
    host.querySelector('[data-x="shot"]').onclick = () => {
      if (!this.chart) return;
      this.chart.takeScreenshot().toBlob((b) => b && download(`${(nameOf(def) || "strategy").replace(/[^\w.-]+/g, "_").slice(0, 40)}-performance.png`, b, "image/png"));
    };
    if (!el || !this.perfOpen) return;
    const cs = getComputedStyle(host.querySelector(".sr"));
    const v = (k) => cs.getPropertyValue(k).trim();
    const t = r.trades;
    // one point per closed trade at its exit time, after a start at zero, as TradingView's dates
    const closeAt = new Map(bars.map((b) => [b.time, b.close]));
    const startBar = (rb && Number.isFinite(rb.from) ? bars.find((b) => b.time >= rb.from) : bars[0]) || bars[0];
    const c0 = startBar?.close;
    const times = [];
    let prev = -Infinity;
    for (const x of t) times.push((prev = Math.max(x.exitTime, prev + 1)));
    const t0 = Math.min(startBar?.time ?? times[0] - 1, (times[0] ?? 1) - 1);
    const at = (k) => (k ? times[k - 1] : t0);
    const tradeAt = new Map(times.map((tm, k) => [tm, k]));
    let cum = 0;
    const pts = [{ time: at(0), value: 0 }];
    t.forEach((x, k) => {
      cum += x.pnl;
      pts.push({ time: at(k + 1), value: cum });
    });
    const neg = (p) => (Math.abs(p) < 1e-9 ? "0" : `${p < 0 ? "\u2212" : ""}${Math.abs(p).toFixed(2)}`);
    const chart = (this.chart = LW.createChart(el, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: v("--sr-muted"), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: v("--sr-grid"), style: 1 } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.1 } },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      localization: { priceFormatter: neg },
      crosshair: { horzLine: { labelBackgroundColor: v("--sr-label") }, vertLine: { labelBackgroundColor: v("--sr-label") } },
    }));
    if (this.show.bh && Number.isFinite(c0) && c0 > 0) {
      const bh = chart.addSeries(LW.LineSeries, { color: v("--sr-bh"), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      bh.setData([{ time: at(0), value: 0 }, ...t.map((x, k) => ({ time: at(k + 1), value: r.initialCapital * ((closeAt.get(x.exitTime) ?? x.exitPrice) / c0 - 1) }))]);
    }
    // each trade from zero, as TradingView's: its best and worst unrealized P&L in a dim green and red,
    // and what it closed with over them in a strong one
    if (this.show.exc) {
      const opts = { priceLineVisible: false, lastValueVisible: false, base: 0 };
      chart.addSeries(LW.HistogramSeries, { ...opts, color: "rgba(8,153,129,0.4)" }).setData(t.map((x, k) => ({ time: at(k + 1), value: x.runUp })));
      chart.addSeries(LW.HistogramSeries, { ...opts, color: "rgba(242,54,69,0.27)" }).setData(t.map((x, k) => ({ time: at(k + 1), value: -x.drawdown })));
      chart.addSeries(LW.HistogramSeries, opts).setData(t.map((x, k) => ({ time: at(k + 1), value: x.pnl, color: x.pnl >= 0 ? "rgba(8,153,129,0.65)" : "rgba(242,54,69,0.6)" })));
    }
    if (this.show.cum) {
      const line = chart.addSeries(LW.BaselineSeries, {
        baseValue: { type: "price", price: 0 },
        lineWidth: 2,
        topLineColor: "#089981",
        topFillColor1: "rgba(8,153,129,0.06)",
        topFillColor2: "rgba(8,153,129,0.06)",
        bottomLineColor: "#f23645",
        bottomFillColor1: "rgba(242,54,69,0.07)",
        bottomFillColor2: "rgba(242,54,69,0.07)",
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(pts);
      // a dot per trade only while they have room, as TradingView's
      if (el.clientWidth / pts.length >= 18) {
        const dots = chart.addSeries(LW.LineSeries, { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 3, color: "#089981", priceLineVisible: false, lastValueVisible: false });
        dots.setData(pts.slice(1).map((p) => ({ ...p, color: p.value < 0 ? "#f23645" : "#089981" })));
      }
    }
    // the stretches where equity rose (green) or fell (red), as one band along the bottom: a line's
    // segment takes the colour of the point it starts from
    if (this.show.rud && pts.length > 1) {
      let dir = 0;
      const band = pts.map((p, k) => {
        const next = pts[k + 1];
        dir = (next && Math.sign(next.value - p.value)) || dir;
        return { time: p.time, value: 1, color: dir > 0 ? "rgba(8,153,129,0.5)" : dir < 0 ? "rgba(242,54,69,0.5)" : "rgba(0,0,0,0)" };
      });
      chart.addSeries(LW.LineSeries, { priceScaleId: "rud", lineWidth: 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(band);
      chart.priceScale("rud").applyOptions({ scaleMargins: { top: 0.985, bottom: 0.005 }, visible: false });
    }
    chart.timeScale().fitContent();
    // hovering a trade shows its numbers, as TradingView's tooltip
    const tip = document.createElement("div");
    tip.className = "sr-tip";
    tip.hidden = true;
    el.appendChild(tip);
    let cumAt = 0;
    const cums = t.map((x) => (cumAt += x.pnl));
    chart.subscribeCrosshairMove((p) => {
      const k = typeof p?.time === "number" ? tradeAt.get(p.time) ?? -1 : -1;
      if (!p?.point || k < 0 || !t[k]) {
        tip.hidden = true;
        return;
      }
      const x = t[k];
      const line = (l, val, cls = "") => `<div><span>${l}</span><b class="${cls}">${val} <small>${esc(cur)}</small></b></div>`;
      tip.innerHTML = `<div class="sr-tip-h">Trade #${x.n} · ${x.side === "long" ? "Long" : "Short"}</div>${this.show.cum ? line("Cumulative PnL", signed(cums[k]), cums[k] >= 0 ? "up" : "down") : ""}${line("Net PnL", signed(x.pnl), x.pnl >= 0 ? "up" : "down")}${this.show.exc ? `${line("Favorable excursion", money(x.runUp), "up")}${line("Adverse excursion", `${x.drawdown ? "−" : ""}${money(x.drawdown)}`, "down")}` : ""}`;
      tip.hidden = false;
      const w = tip.offsetWidth,
        h = tip.offsetHeight;
      tip.style.left = `${Math.min(p.point.x + 14, el.clientWidth - w - 70)}px`;
      tip.style.top = `${Math.max(4, Math.min(p.point.y - h / 2, el.clientHeight - h - 4))}px`;
    });
  }

  // ---- Trades: TradingView's List of trades, each trade's exit over its entry
  rows(r) {
    const all = [...r.trades.map((x) => ({ ...x, closed: true })), ...(r.open || []).map((o) => ({ ...o, closed: false, pnl: o.openProfit, pnlPct: (o.openProfit / (o.entryPrice * o.qty || 1)) * 100, exitPrice: o.price }))];
    all.sort((a, b) => a.n - b.n);
    let cum = 0;
    for (const x of all) {
      if (x.closed) cum += x.pnl;
      x.cum = x.closed ? cum : cum + x.pnl;
    }
    return this.desc ? all.reverse() : all;
  }

  tradesHtml(r, cur) {
    const rows = this.rows(r);
    const on = new Set(this.cols());
    const head = `<div class="sr-th"><h3 class="sr-h">List of trades</h3><span class="sr-grow"></span><button class="sr-ic sr-box" data-x="csv" title="Export trades (CSV)">${ICON.download}</button><button class="sr-ic sr-box" data-x="cols" title="Columns">${ICON.columns}</button></div>`;
    if (!rows.length) return `<div class="sr-tradeswrap">${head}<div class="sr-empty">This strategy made no trades in the testing period.</div></div>`;
    const shown = rows.slice(0, 2000);
    const u = `<small>${esc(cur)}</small>`;
    const cc = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
    // a column in both rows (the exit's and the entry's), or one cell across both
    const two = (main, sub = "", cls = "") => `<td rowspan="2" class="r ${cls}"><div>${main}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</td>`;
    const perRow = (x, exit) =>
      [
        on.has("date") ? `<td class="pr">${exit ? (x.closed ? timeText(x.exitTime) : "Open") : timeText(x.entryTime)}</td>` : "",
        on.has("signal") ? `<td class="pr">${esc(exit ? (x.closed ? x.exitSignal || x.exitReason || "" : "") : x.entrySignal || x.entryReason || "")}</td>` : "",
        on.has("price") ? `<td class="pr r"${exit ? ' data-c="px"' : ""}>${priceText(exit ? x.exitPrice : x.entryPrice)} ${u}</td>` : "",
      ].join("");
    const body = shown
      .map((x) => {
        const both = [
          on.has("size") ? two(qtyText(x.qty), `${money(x.entryPrice * x.qty)} ${u}`) : "",
          on.has("pnl") ? two(`${signed(x.pnl)} ${u}`, "", `${cc(x.pnl)} pnl`) : "",
          on.has("ret") ? two(pct(x.pnlPct), "", `${cc(x.pnl)} ret`) : "",
          on.has("fav") ? two(`${money(x.runUp)} ${u}`, pct(x.runUpPct, false)) : "",
          on.has("adv") ? two(`${x.drawdown ? "−" : ""}${money(x.drawdown)} ${u}`, `${x.drawdown ? "−" : ""}${pct(x.drawdownPct, false)}`) : "",
          on.has("cum") ? two(`${signed(x.cum)} ${u}`, pct((x.cum / r.initialCapital) * 100), `${cc(x.cum)} cum`) : "",
          on.has("dur") ? two(String(x.bars)) : "",
        ].join("");
        return `<tr class="sr-ex"${x.closed ? "" : ` data-open="${x.n}"`}><td rowspan="2" class="n">${x.n} <span class="${x.side === "long" ? "sr-long" : "sr-short"}">${x.side === "long" ? "Long" : "Short"}</span></td><td class="pr ty">Exit</td>${perRow(x, true)}${both}</tr><tr class="sr-en"><td class="ty">Entry</td>${perRow(x, false)}</tr>`;
      })
      .join("");
    const th = (k, l) => (on.has(k) ? `<th class="${["date", "signal"].includes(k) ? "" : "r"}">${l}</th>` : "");
    return `<div class="sr-tradeswrap">${head}<table class="sr-t"><thead><tr><th><button data-x="sort" title="Sort by trade number">Trade number <span class="sr-arrow">${this.desc ? "↓" : "↑"}</span></button></th><th>Type</th>${th("date", "Date and time")}${th("signal", "Signal")}${th("price", "Price")}${th("size", "Size")}${th("pnl", "Net PnL")}${th("ret", "Return")}${th("fav", "Favorable excursion")}${th("adv", "Adverse excursion")}${th("cum", "Cumulative PnL")}${th("dur", "Duration (bars)")}</tr></thead><tbody>${body}</tbody></table>${rows.length > shown.length ? `<div class="sr-empty">Showing ${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} trades. Export them all as CSV.</div>` : ""}</div>`;
  }

  // An open trade's row as the price moves, without drawing the report again.
  liveOpen(host, pane, ind) {
    if (this.view !== "trades" || rangeBounds(ind.range)) return;
    const r = pane.indResults?.[ind.uid]?.strategy;
    if (!r) return;
    const cur = currencyOf(r, pane.cfg.symbol);
    const closedCum = r.trades.reduce((a, x) => a + x.pnl, 0);
    for (const o of r.open || []) {
      const tr = host.querySelector(`tr[data-open="${o.n}"]`);
      if (!tr) continue;
      const pnlPct = (o.openProfit / (o.entryPrice * o.qty || 1)) * 100,
        cum = closedCum + o.openProfit;
      const set = (sel, main, sub, v) => {
        const td = tr.querySelector(sel);
        if (!td) return;
        td.className = td.className.replace(/\b(up|down)\b/g, "").trim() + (v > 0 ? " up" : v < 0 ? " down" : "");
        td.innerHTML = `<div>${main}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
      };
      const px = tr.querySelector('[data-c="px"]');
      if (px) px.innerHTML = `${priceText(o.price)} <small>${esc(cur)}</small>`;
      set("td.pnl", `${signed(o.openProfit)} <small>${esc(cur)}</small>`, "", o.openProfit);
      set("td.ret", pct(pnlPct), "", o.openProfit);
      set("td.cum", `${signed(cum)} <small>${esc(cur)}</small>`, pct((cum / r.initialCapital) * 100), cum);
    }
  }

  csv(r, cur) {
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const iso = (t) => new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16);
    const lines = [["Trade number", "Type", "Signal", "Date and time", `Price ${cur}`, "Size (qty)", `Size (value, ${cur})`, `Net PnL ${cur}`, "Return %", `Favorable excursion ${cur}`, "Favorable excursion %", `Adverse excursion ${cur}`, "Adverse excursion %", `Cumulative PnL ${cur}`, "Cumulative PnL %", "Duration (bars)"].map(q).join(",")];
    const desc = this.desc;
    this.desc = false;
    const rows = this.rows(r);
    this.desc = desc;
    for (const x of rows) {
      const common = [x.qty, x.entryPrice * x.qty, x.pnl.toFixed(2), x.pnlPct.toFixed(2), x.runUp.toFixed(2), x.runUpPct.toFixed(2), (-x.drawdown).toFixed(2), (-x.drawdownPct).toFixed(2), x.cum.toFixed(2), ((x.cum / r.initialCapital) * 100).toFixed(2), x.bars];
      lines.push([x.n, `Exit ${x.side}`, x.closed ? x.exitSignal || x.exitReason : "Open", x.closed ? iso(x.exitTime) : "", x.exitPrice, ...common].map(q).join(","));
      lines.push([x.n, `Entry ${x.side}`, x.entrySignal || x.entryReason, iso(x.entryTime), x.entryPrice, ...common].map(q).join(","));
    }
    return lines.join("\n");
  }
}
