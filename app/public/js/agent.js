// AskCharts AI in the page: it carries out the AI's tools with the app's own functions (so what it does
// looks and behaves exactly like what a person does), keeps an undo point before every change, asks
// first before big removals, and runs the conversation: ask the model (through the server, which holds
// the key), do the tools it calls, send back what happened, until it answers.
import { api } from "./api.js";
import { BY_ID, INDICATORS, compute, defaults } from "../lib/indicators.js";
import { newUid } from "./chart.js";
import { indicatorFavs } from "./indicatorpicker.js";
import { THEME_KEYS } from "./chartsettings.js";
import { parseTf } from "../lib/series.js";
import { AGENT_TOOL_BY_NAME, DRAWABLE, sameIndicator } from "../lib/agent-tools.js";
import { iso, round, parseWhen, barIndexAt, summary, levels } from "../lib/agent-analysis.js";
import { compilePine } from "../lib/pine.js";

export const MAX_CALLS = 20; // tool calls in one answer
const MAX_ROUNDS = 12;
const DRAWABLE_BY_ID = Object.fromEntries(DRAWABLE.map((t) => [t.id, t]));
const CHART_TYPES = new Set(AGENT_TOOL_BY_NAME.chart_set.input_schema.properties.type.enum);
const LAYOUTS = new Set(AGENT_TOOL_BY_NAME.chart_set.input_schema.properties.layout.enum);
const HEX = /^#[0-9a-f]{6}$/i;
const shortName = (def) => /\(([^)]+)\)$/.exec(def?.name || "")?.[1].split(" / ")[0] || def?.name || "indicator";
const fail = (msg) => {
  throw new Error(msg);
};

export class AgentTools {
  constructor(app) {
    this.app = app;
  }

  // ---------- helpers ----------
  pane(input) {
    const n = input?.chart;
    if (n == null) return this.app.active;
    const p = this.app.panes[n - 1];
    if (!p) fail(`There's no chart ${n}: the layout has ${this.app.panes.length}.`);
    return p;
  }
  chartNo(p) {
    return this.app.panes.indexOf(p) + 1;
  }
  // "the chart" with one chart on screen, "chart 2" with several
  which(p) {
    return this.app.panes.length > 1 ? `chart ${this.chartNo(p)}` : "the chart";
  }
  bars(p) {
    return p.shown?.length ? p.shown : p.bars || [];
  }
  // "XRP / USD (Kraken)" when the app knows the name, else "XRPUSD (Kraken)"
  name(sym) {
    const [ex, t] = String(sym).includes(":") ? String(sym).split(":") : ["", String(sym)];
    const known = this.app.symbolName?.(sym);
    const where = ex ? ` (${ex === "US" ? "US" : ex[0] + ex.slice(1).toLowerCase()})` : "";
    return `${known && known !== sym ? known : t}${where}`;
  }
  // An exact EXCHANGE:TICKER, or a ticker the search finds exactly; anything else names the candidates.
  async symbol(s) {
    const q = String(s || "").trim();
    if (!q) fail("Give a symbol from market_search.");
    if (/^[A-Z0-9_.]+:[A-Z0-9_.!/-]+$/i.test(q)) return q.toUpperCase();
    const found = await api.search(q).catch(() => []);
    const exact = found.filter((r) => r.symbol.split(":")[1]?.toUpperCase() === q.toUpperCase());
    if (exact.length === 1) return exact[0].symbol;
    fail(`"${q}" isn't an exact symbol. Use one of: ${(exact.length ? exact : found).slice(0, 6).map((r) => r.symbol).join(", ") || "nothing found (try market_search)"}.`);
  }
  // An anchor: bars_ago or a time, with a price or a bar's own high, low, open or close.
  anchor(p, spec, k) {
    const bars = this.bars(p);
    if (!bars.length) fail("The chart has no bars yet.");
    let time, bar;
    if (Number.isInteger(spec?.bars_ago)) {
      const i = bars.length - 1 - spec.bars_ago;
      if (i < 0) fail(`Point ${k + 1}: bars_ago ${spec.bars_ago} is before the first bar on the chart (${bars.length} bars).`);
      if (i < bars.length) {
        bar = bars[i];
        time = bar.time;
      } else {
        // into the future: the bar spacing carries on
        const step = bars.length > 1 ? bars.at(-1).time - bars.at(-2).time : 60;
        time = bars.at(-1).time + (i - (bars.length - 1)) * step;
        bar = null;
      }
    } else if (spec?.time) {
      const t = parseWhen(spec.time);
      if (!Number.isFinite(t)) fail(`Point ${k + 1}: "${spec.time}" isn't a date like 2026-10-19 or 2026-10-19T14:30.`);
      const i = barIndexAt(bars, t);
      bar = i >= 0 ? bars[i] : null;
      time = bar && bar.time === t ? bar.time : t;
    } else fail(`Point ${k + 1}: give bars_ago or time.`);
    let price = spec?.price;
    if (!Number.isFinite(price)) {
      const at = spec?.at || "close";
      if (!bar) fail(`Point ${k + 1}: give a price (there's no bar there to take ${at} from).`);
      price = bar[at];
      if (!Number.isFinite(price)) fail(`Point ${k + 1}: at must be high, low, open or close.`);
    }
    return { time, price };
  }
  latest(p, ind) {
    const def = BY_ID[ind.id],
      res = p.indResults?.[ind.uid] || {},
      out = {};
    for (const o of def?.outputs || []) {
      const arr = res[o.key];
      for (let i = (arr?.length || 0) - 1; i >= Math.max(0, (arr?.length || 0) - 3); i--)
        if (Number.isFinite(arr[i])) {
          out[o.label || o.key] = round(arr[i]);
          break;
        }
    }
    if (res.strategy?.stats) {
      const s = res.strategy.stats;
      out.strategy = { trades: s.totalTrades ?? s.trades, netProfit: round(s.netProfit), winRatePct: round(s.winRatePct ?? s.percentProfitable), maxDrawdown: round(s.maxDrawdown) };
    }
    return out;
  }
  // Inputs checked against the indicator's own list, each turned into the type it takes.
  inputs(def, given = {}) {
    const out = {};
    const known = Object.fromEntries((def.inputs || []).map((i) => [i.key, i]));
    for (const [k, v] of Object.entries(given || {})) {
      const inp = known[k];
      if (!inp) fail(`${shortName(def)} has no input "${k}". Its inputs: ${Object.keys(known).join(", ") || "none"}.`);
      if (inp.type === "int" || inp.type === "float") {
        const n = Number(v);
        if (!Number.isFinite(n)) fail(`${k} must be a number.`);
        out[k] = inp.type === "int" ? Math.round(n) : n;
        if (inp.min != null && out[k] < inp.min) fail(`${k} must be at least ${inp.min}.`);
        if (inp.max != null && out[k] > inp.max) fail(`${k} must be at most ${inp.max}.`);
      } else if (inp.type === "bool") out[k] = v === true || v === "true";
      else if (inp.type === "time") {
        const t = typeof v === "number" ? v : parseWhen(v);
        if (!Number.isFinite(t)) fail(`${k} is a time: give a date like 2026-10-19T14:30.`);
        out[k] = t;
      } else if (inp.type === "select" || inp.type === "source") {
        const opts = (inp.options || []).map((o) => (Array.isArray(o) ? o[0] : o?.value ?? o));
        if (opts.length && !opts.map(String).includes(String(v))) fail(`${k} must be one of: ${opts.join(", ")}.`);
        out[k] = opts.find((o) => String(o) === String(v)) ?? v;
      } else out[k] = typeof v === "string" ? v.slice(0, 200) : v;
    }
    return out;
  }
  colors(def, given = {}) {
    const out = {};
    const keys = new Set((def.outputs || []).map((o) => o.key));
    for (const [k, v] of Object.entries(given || {})) {
      if (!keys.has(k)) fail(`${shortName(def)} has no line "${k}". Its lines: ${[...keys].join(", ")}.`);
      if (!HEX.test(String(v))) fail(`${k}: colors are #rrggbb.`);
      out[k] = v;
    }
    return out;
  }
  async loadAll(panes) {
    await Promise.all(panes.map((p) => p.load()));
  }
  setTheme(theme) {
    const a = this.app;
    if (a.settings.theme === theme) return;
    a.settings.theme = theme;
    document.documentElement.dataset.theme = theme;
    for (const k of THEME_KEYS) a.settings.chart[k] = "";
    a.panes.forEach((p) => p.applyTheme());
    a.panels?.onTheme?.();
  }
  refreshLists() {
    if (this.app.settings.sidePanel === "watchlist") this.app.panels?.showSide?.("watchlist");
  }

  // ---------- undo points ----------
  snapshot() {
    const a = this.app;
    return {
      layout: String(a.state.layout),
      panes: a.panes.map((p) => structuredClone(p.cfg)),
      active: a.panes.indexOf(a.active),
      drawings: structuredClone(a.state.drawings || {}),
      favs: [...indicatorFavs(a)],
      watchlists: structuredClone(a.state.watchlists || {}),
      activeWatchlist: a.state.activeWatchlist,
      pineScripts: structuredClone(a.state.pineScripts || {}),
      theme: a.settings.theme,
      replay: a.panes.map((p) => !!p.replay),
    };
  }
  // Whether two undo points hold the same charts and lists (the zoom and replay don't count)
  same(x, y) {
    const key = (s) => JSON.stringify({ ...s, replay: null, active: null, panes: s.panes.map(({ barSpacing, ...cfg }) => cfg) });
    return key(x) === key(y);
  }
  async restore(s) {
    const a = this.app;
    this.setTheme(s.theme);
    if (String(a.state.layout) !== s.layout) a.setLayout(s.layout, false);
    const loads = [];
    s.panes.forEach((cfg, i) => {
      const p = a.panes[i];
      if (!p) return;
      if (p.replay && !s.replay[i]) p.stopReplay();
      if (JSON.stringify(p.cfg) === JSON.stringify(cfg)) return;
      for (const k of Object.keys(p.cfg)) delete p.cfg[k];
      Object.assign(p.cfg, structuredClone(cfg));
      loads.push(p.load());
    });
    a.setActive(a.panes[s.active] || a.panes[0]);
    a.state.drawings = structuredClone(s.drawings);
    for (const p of a.panes) p.drawings.setItems(a.getDrawings(p.drawKey()));
    a.settings.indicatorFavs = [...s.favs];
    a.state.watchlists = structuredClone(s.watchlists);
    a.state.activeWatchlist = s.activeWatchlist;
    // a script the AI saved since goes from My scripts and the indicator list
    if (s.pineScripts) {
      for (const id of Object.keys(a.state.pineScripts || {})) if (!s.pineScripts[id]) a.pineEditor?.forget(id);
      a.state.pineScripts = structuredClone(s.pineScripts);
    }
    await Promise.all(loads);
    a.syncToolbar();
    a.persist();
    a.panels?.onObjectsChange?.();
    this.refreshLists();
  }

  // What to ask the person before a tool runs, or null.
  question(name, input, askFirst) {
    const n = (x) => (Array.isArray(x) ? x.length : 0);
    if (name === "indicator_remove" && (input.all || n(input.uids) > 1)) return input.all ? "Remove every indicator from the chart?" : `Remove ${n(input.uids)} indicators?`;
    if (name === "drawing_remove" && (input.all || n(input.ids) > 3)) return input.all ? "Remove every drawing on this symbol?" : `Remove ${n(input.ids)} drawings?`;
    if (name === "watchlist_edit" && n(input.remove) > 3) return `Remove ${n(input.remove)} symbols from the watchlist?`;
    const def = AGENT_TOOL_BY_NAME[name];
    if (askFirst && def && !def.read && !def.view) return `Go ahead: ${this.preview(name, input)}?`;
    return null;
  }
  preview(name, i) {
    if (name === "chart_set") return `change ${[i.layout && `the layout to ${i.layout}`, i.symbol, i.interval, i.type && `${i.type} chart`, i.theme && `${i.theme} theme`].filter(Boolean).join(", ") || "the chart"}`;
    if (name === "indicator_add") return `add ${shortName(BY_ID[i.id]) || i.id}`;
    if (name === "drawing_add") return `draw a ${DRAWABLE_BY_ID[i.type]?.label || i.type}`;
    return name.replace(/_/g, " ");
  }

  // Run one tool call: { result, label, snap?, error?, declined? }.
  async run(call, { confirm, askFirst, choose, offer } = {}) {
    const def = AGENT_TOOL_BY_NAME[call.name];
    if (!def || typeof this[call.name] !== "function") return { error: `There's no tool called ${call.name}.`, label: `Unknown tool ${call.name}` };
    const input = call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input : {};
    const q = this.question(call.name, input, askFirst);
    if (q && confirm && !(await confirm(q))) return { result: "The person said no, so nothing changed. Don't try again unless they ask.", declined: true, label: `Not done: ${q.replace(/\?$/, "")}` };
    const snap = def.read || def.view ? null : this.snapshot();
    try {
      const r = await this[call.name](input, { choose, offer });
      // nothing changed (it was already there): shown as a look, with nothing to undo
      if (r.unchanged) return { ...r, snap: null, read: true, view: !!def.view };
      return { ...r, snap, read: !!def.read, view: !!def.view };
    } catch (e) {
      // a change that broke halfway goes back to where it started
      if (snap) await this.restore(snap).catch(() => {});
      return { error: e.message || String(e), label: `${this.preview(call.name, input)}: ${e.message || e}`, read: !!def.read };
    }
  }

  // ---------- read ----------
  async chart_read(input) {
    const a = this.app;
    const panes = input.chart ? [this.pane(input)] : a.panes;
    return {
      label: "Read the chart",
      result: { layout: a.state.layout, activeChart: this.chartNo(a.active), theme: a.settings.theme, charts: panes.map((p) => this.describe(p, input.drawings !== false)) },
    };
  }
  describe(p, withDrawings) {
    const bars = this.bars(p),
      last = bars.at(-1),
      r = p.chart.timeScale().getVisibleLogicalRange();
    const items = p.drawings?.items || [];
    return {
      chart: this.chartNo(p),
      symbol: p.cfg.symbol,
      name: this.name(p.cfg.symbol),
      interval: p.cfg.tf,
      type: p.cfg.type,
      source: p.provider || "",
      logScale: !!p.cfg.log,
      compare: p.cfg.compare || [],
      replay: p.replay ? { at: iso(bars.at(-1)?.time) } : null,
      bars: bars.length,
      visible: r && bars.length ? { from: iso(p.timeOfLogical(Math.max(0, r.from))), to: iso(p.timeOfLogical(Math.min(bars.length - 1, r.to))) } : null,
      lastBar: last ? { time: iso(last.time), open: round(last.open), high: round(last.high), low: round(last.low), close: round(last.close), volume: round(last.volume) } : null,
      indicators: (p.cfg.indicators || []).map((ind, k, all) => {
        // a second copy of one listed before it (same inputs), often left from earlier
        const twin = all.slice(0, k).find((x) => sameIndicator(BY_ID[ind.id], x, ind));
        return {
          uid: ind.uid,
          id: ind.id,
          name: BY_ID[ind.id]?.saved || BY_ID[ind.id]?.name || ind.id,
          inputs: ind.params || {},
          latest: this.latest(p, ind),
          ...(ind.hidden ? { hidden: true } : {}),
          ...(twin ? { sameAs: twin.uid } : {}),
          ...(p.indResults?.[ind.uid]?.error ? { error: String(p.indResults[ind.uid].error).slice(0, 160) } : {}),
        };
      }),
      drawings: withDrawings
        ? items.slice(0, 40).map((d) => ({
            id: d.id,
            type: d.type,
            points: (d.points || []).map((q) => ({ time: iso(q.time), price: round(q.price) })),
            ...(d.text ? { text: String(d.text).slice(0, 120) } : {}),
            ...(d.locked ? { locked: true } : {}),
            ...(d.hidden ? { hidden: true } : {}),
          }))
        : items.length,
    };
  }
  async chart_snapshot(input) {
    const p = this.pane(input);
    const src = await p.screenshot();
    const w = Math.min(1280, src.width),
      h = Math.round((src.height * w) / src.width);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(src, 0, 0, w, h);
    const data = c.toDataURL("image/jpeg", 0.82).split(",")[1];
    return { label: `Looked at ${this.which(p)}`, result: { image: data, mediaType: "image/jpeg", text: `Chart ${this.chartNo(p)}: ${p.cfg.symbol}, ${p.cfg.tf}` } };
  }
  async market_search(input) {
    const q = String(input.query || "").trim();
    if (!q) fail("Give something to search for.");
    const rows = await api.search(q);
    // the names found, for the steps that follow ("BTC / USD (Kraken)", not Kraken's XBTUSD)
    const names = (this.app.names ||= {});
    for (const r of rows) if (r.name && !names[r.symbol]) names[r.symbol] = r.name;
    return { label: `Looked up ${q}`, result: rows.slice(0, 10).map((r) => ({ symbol: r.symbol, name: r.name, type: r.type, exchange: r.exchange })) };
  }
  async barsFor(symbol, interval, count) {
    const a = this.app;
    const sym = symbol ? await this.symbol(symbol) : a.active.cfg.symbol;
    const tf = interval || a.active.cfg.tf;
    parseTf(tf);
    const open = a.panes.find((p) => p.cfg.symbol === sym && p.cfg.tf === tf && this.bars(p).length);
    if (open) return { sym, tf, bars: this.bars(open), source: open.provider };
    const r = await api.candles(sym, tf, Math.max(count, 300));
    return { sym, tf, bars: r.candles || [], source: r.provider };
  }
  async market_bars(input) {
    const count = Math.min(200, Math.max(1, input.count || 60));
    const { sym, tf, bars, source } = await this.barsFor(input.symbol, input.interval, count);
    if (!bars.length) fail(`No bars for ${sym} on ${tf}.`);
    return {
      label: `Read ${sym} ${tf} bars`,
      result: { symbol: sym, interval: tf, source, summary: summary(bars), bars: bars.slice(-count).map((b) => [iso(b.time), round(b.open), round(b.high), round(b.low), round(b.close), round(b.volume)]) },
    };
  }
  async market_levels(input) {
    const p = this.pane(input);
    const r = levels(this.bars(p), { strength: input.strength || 5, lookback: input.lookback || 300 });
    return { label: `Found swings and levels on ${this.name(p.cfg.symbol)}, ${p.cfg.tf}`, result: { symbol: p.cfg.symbol, interval: p.cfg.tf, ...r } };
  }
  async indicator_catalog(input) {
    const q = String(input.query || "").trim().toLowerCase();
    const all = Object.values(BY_ID);
    const brief = (d) => ({
      id: d.id,
      name: d.name,
      group: d.group || (d.id.startsWith("pine:") ? "My Pine scripts" : d.id.startsWith("custom:") ? "My indicators" : ""),
      ...(d.strategy ? { strategy: true } : {}),
      inputs: (d.inputs || []).map((i) => ({ key: i.key, label: i.label, type: i.type, default: i.default, ...(i.options ? { options: i.options.map((o) => (Array.isArray(o) ? o[0] : o?.value ?? o)).slice(0, 20) } : {}), ...(i.min != null ? { min: i.min } : {}), ...(i.max != null ? { max: i.max } : {}) })),
      lines: (d.outputs || []).map((o) => o.key),
    });
    if (!q) {
      const groups = {};
      for (const d of INDICATORS) (groups[d.group || "Other"] ||= []).push(`${d.id} (${d.name})`);
      const mine = all.filter((d) => d.id.startsWith("pine:") || d.id.startsWith("custom:")).map((d) => `${d.id} (${d.name})`);
      return { label: "Read the indicator list", result: { groups, mine } };
    }
    const words = q.split(/\s+/);
    const hits = all
      .map((d) => {
        const hay = `${d.id} ${d.name} ${d.group || ""}`.toLowerCase();
        const score = words.every((w) => hay.includes(w)) ? (d.id.toLowerCase() === q ? 3 : hay.startsWith(q) ? 2 : 1) : 0;
        return { d, score };
      })
      .filter((x) => x.score)
      .sort((x, y) => y.score - x.score)
      .slice(0, 12)
      .map((x) => brief(x.d));
    return { label: `Looked for "${input.query}" indicators`, result: hits.length ? hits : `Nothing matches "${input.query}". Try indicator_catalog with no query for the full list.` };
  }
  async indicator_values(input) {
    const count = Math.min(100, Math.max(1, input.count || 10));
    if (input.uid) {
      const p = this.pane(input);
      const ind = p.cfg.indicators.find((x) => x.uid === input.uid) || fail(`No indicator ${input.uid} on chart ${this.chartNo(p)}; chart_read lists them.`);
      const def = BY_ID[ind.id],
        res = p.indResults?.[ind.uid] || {},
        bars = this.bars(p);
      const lines = {};
      for (const o of def?.outputs || []) lines[o.label || o.key] = (res[o.key] || []).slice(-count).map(round);
      return { label: `Read ${shortName(def)} values`, result: { indicator: def?.name, times: bars.slice(-count).map((b) => iso(b.time)), lines } };
    }
    const def = BY_ID[input.id] || fail(`Unknown indicator id "${input.id}"; indicator_catalog lists them.`);
    if (input.id.startsWith("pine:") || input.id.startsWith("custom:")) fail("For my own scripts, add them to a chart and read them by uid.");
    if (def.onchain) fail("XRPL On chain reads the XRP Ledger store through the chart: add it with indicator_add, then read it by uid.");
    const { sym, tf, bars } = await this.barsFor(input.symbol, input.interval, 300);
    const out = compute(def.id, bars, { ...defaults(def.id), ...this.inputs(def, input.inputs) });
    const lines = {};
    for (const o of def.outputs || []) lines[o.label || o.key] = (out[o.key] || []).slice(-count).map(round);
    return { label: `Worked out ${shortName(def)} on ${sym} ${tf}`, result: { indicator: def.name, symbol: sym, interval: tf, times: bars.slice(-count).map((b) => iso(b.time)), lines } };
  }

  // ---------- the chart ----------
  async chart_set(input) {
    const a = this.app,
      done = [];
    if (input.layout != null) {
      if (!LAYOUTS.has(String(input.layout))) fail(`layout must be one of ${[...LAYOUTS].join(", ")}.`);
      if (String(a.state.layout) !== String(input.layout)) {
        a.setLayout(String(input.layout));
        done.push(`layout ${input.layout}`);
      }
    }
    const p = this.pane(input);
    if (p !== a.active) a.setActive(p);
    if (input.symbol) {
      const sym = await this.symbol(input.symbol);
      const before = p.cfg.symbol;
      const targets = a.settings.syncSymbol ? a.panes : [p];
      for (const t of targets) {
        t.cfg.symbol = sym;
        t.cfg.currency = null;
        t.cfg.compare = (t.cfg.compare || []).filter((s) => s !== sym);
      }
      await this.loadAll(targets);
      if (!this.bars(p).length) {
        for (const t of targets) t.cfg.symbol = before;
        await this.loadAll(targets);
        fail(`No data came back for ${sym}. Check the symbol with market_search.`);
      }
      done.push(this.name(sym));
    }
    if (input.interval) {
      parseTf(input.interval);
      p.cfg.tf = input.interval;
      await p.load();
      done.push(input.interval);
    }
    if (input.type) {
      if (!CHART_TYPES.has(input.type)) fail(`type must be one of ${[...CHART_TYPES].join(", ")}.`);
      p.cfg.type = input.type;
      p.render(true);
      a.chartTypes?.render?.();
      done.push(`${input.type} chart`);
    }
    if (input.theme) {
      if (!["dark", "light"].includes(input.theme)) fail("theme is dark or light.");
      this.setTheme(input.theme);
      done.push(`${input.theme} theme`);
    }
    a.syncToolbar();
    a.persist();
    if (!done.length) return { label: `Picked ${this.which(p)}`, result: `Chart ${this.chartNo(p)} is active.` };
    return { label: `Changed ${this.which(p)} to ${done.join(", ")}`, result: { chart: this.chartNo(p), symbol: p.cfg.symbol, interval: p.cfg.tf, type: p.cfg.type, layout: a.state.layout, bars: this.bars(p).length } };
  }
  async chart_view(input) {
    const p = this.pane(input),
      ts = p.chart.timeScale(),
      n = this.bars(p).length,
      did = [];
    const margin = this.app.settings.chart?.marginRight ?? 10;
    if (input.reset) {
      p.resetView();
      did.push("reset the view");
    }
    if (input.last_bars) {
      ts.setVisibleLogicalRange({ from: n - 1 - input.last_bars, to: n - 1 + margin });
      did.push(`showed the last ${input.last_bars} bars`);
    }
    if (input.from || input.to) {
      const t0 = input.from ? parseWhen(input.from) : NaN,
        t1 = input.to ? parseWhen(input.to) : NaN;
      if ((input.from && !Number.isFinite(t0)) || (input.to && !Number.isFinite(t1))) fail("Dates are like 2026-10-19 or 2026-10-19T14:30.");
      const l0 = Number.isFinite(t0) ? p.logicalOf(t0) : 0,
        l1 = Number.isFinite(t1) ? p.logicalOf(t1) : n - 1;
      if (!(l1 > l0)) fail("from must be before to.");
      ts.setVisibleLogicalRange({ from: l0, to: l1 });
      did.push(`showed ${input.from || "the start"} to ${input.to || "now"}`);
    }
    if (input.go_to) {
      const t = parseWhen(input.go_to);
      if (!Number.isFinite(t)) fail("go_to is a date like 2026-10-19.");
      const r = ts.getVisibleLogicalRange(),
        w = r ? r.to - r.from : 100,
        l = p.logicalOf(t);
      ts.setVisibleLogicalRange({ from: l - w / 2, to: l + w / 2 });
      did.push(`went to ${input.go_to}`);
    }
    if (input.log != null) {
      p.cfg.log = !!input.log;
      p.render(false);
      this.app.persist();
      did.push(`log scale ${input.log ? "on" : "off"}`);
    }
    if (input.auto_scale) {
      p.main?.priceScale().applyOptions({ autoScale: true });
      did.push("auto scale on");
    }
    if (!did.length) fail("Say what to show: last_bars, from and to, go_to, log, auto_scale or reset.");
    return { label: `${this.which(p)[0].toUpperCase()}${this.which(p).slice(1)}: ${did.join(", ")}`, result: "Done." };
  }
  async chart_compare(input) {
    const p = this.pane(input);
    if (!input.add && !input.remove) fail("Give add or remove.");
    let label = "";
    if (input.add) {
      const sym = await this.symbol(input.add);
      if (sym === p.cfg.symbol) fail("That's the chart's own symbol.");
      if (!p.cfg.compare.includes(sym)) p.cfg.compare.push(sym);
      label = `Compared ${this.name(sym)} on ${this.which(p)}`;
    }
    if (input.remove) {
      const before = p.cfg.compare.length;
      p.cfg.compare = p.cfg.compare.filter((s) => s !== input.remove);
      if (p.cfg.compare.length === before) fail(`${input.remove} isn't compared on this chart.`);
      label = `Stopped comparing ${input.remove}`;
    }
    this.app.persist();
    await p.load({ keepView: true });
    return { label, result: { compare: p.cfg.compare } };
  }
  async chart_replay(input) {
    const p = this.pane(input);
    const act = input.action;
    if (act === "start") {
      const bars = p.bars || [];
      let i;
      if (input.start) {
        const t = parseWhen(input.start);
        if (!Number.isFinite(t)) fail("start is a date like 2026-10-19.");
        i = barIndexAt(bars, t);
      } else i = bars.length - 1 - (input.bars_ago || 100);
      if (i < 1) fail("That's before the chart's first bar.");
      p.startReplay(i);
      return { label: `Started bar replay at ${iso(bars[i].time)}`, result: "Replay started." };
    }
    if (!p.replay) fail("Bar replay isn't running; start it first.");
    if (act === "step") {
      const n = input.steps || 1;
      for (let k = 0; k < Math.abs(n); k++) p.replayStep(Math.sign(n));
      return { label: `Replay ${n > 0 ? "forward" : "back"} ${Math.abs(n)} bar${Math.abs(n) === 1 ? "" : "s"}`, result: `At ${iso(this.bars(p).at(-1)?.time)}.` };
    }
    if (act === "play" || act === "pause") {
      if (!!p.replay.playing !== (act === "play")) p.toggleReplay();
      return { label: act === "play" ? "Replay playing" : "Replay paused", result: "Done." };
    }
    if (act === "stop") {
      p.stopReplay();
      return { label: "Back to live", result: "Replay stopped." };
    }
    fail("action is start, step, play, pause or stop.");
  }

  // ---------- indicators ----------
  async indicator_add(input) {
    const p = this.pane(input);
    const def = BY_ID[input.id] || INDICATORS.find((d) => d.name.toLowerCase() === String(input.id).toLowerCase()) || fail(`Unknown indicator id "${input.id}"; indicator_catalog finds the right one.`);
    const params = this.inputs(def, input.inputs);
    for (const inp of def.inputs || []) if (inp.type === "time" && params[inp.key] == null && !inp.default) fail(`${shortName(def)} needs ${inp.key}, a time to start from (like 2026-10-19T14:30).`);
    // the same indicator with the same inputs is already on this chart (say, kept from before the symbol
    // changed): it isn't added twice
    const want = { id: def.id, params: { ...(this.app.settings.indDefaults?.[def.id]?.params || {}), ...params } };
    const same = (p.cfg.indicators || []).find((x) => sameIndicator(def, x, want));
    if (same) {
      const was = `${shortName(def)} ${p.indicatorParamsLabel?.(same) || ""}`.trim();
      return {
        unchanged: true,
        label: `${was} was already on the chart${same.hidden ? ", hidden" : ""}`,
        result: { uid: same.uid, id: def.id, already: true, ...(same.hidden ? { hidden: true } : {}), note: `It was already on this chart with these inputs, so it wasn't added again. Tell the person it's there.${same.hidden ? " It's hidden: indicator_edit with hidden false shows it." : ""}` },
      };
    }
    const colors = this.colors(def, input.colors);
    const uid = p.addIndicator(def.id, params);
    const ind = p.cfg.indicators.find((x) => x.uid === uid);
    if (Object.keys(colors).length) ind.colors = { ...(ind.colors || {}), ...colors };
    p.render(false);
    this.app.persist();
    const shown = `${shortName(def)} ${p.indicatorParamsLabel?.(ind) || ""}`.trim();
    return { label: `Added ${shown}${this.app.panes.length > 1 ? ` to chart ${this.chartNo(p)}` : ""}`, result: { uid, id: def.id, name: def.name } };
  }
  async indicator_edit(input) {
    const p = this.pane(input);
    const ind = p.cfg.indicators.find((x) => x.uid === input.uid) || fail(`No indicator ${input.uid} on chart ${this.chartNo(p)}; chart_read lists them.`);
    const def = BY_ID[ind.id];
    if (input.inputs) ind.params = { ...(ind.params || {}), ...this.inputs(def, input.inputs) };
    if (input.colors) ind.colors = { ...(ind.colors || {}), ...this.colors(def, input.colors) };
    if (input.hidden != null) ind.hidden = !!input.hidden || undefined;
    p.render(false);
    this.app.persist();
    return { label: `Changed ${shortName(def)} ${p.indicatorParamsLabel?.(ind) || ""}`.trim(), result: { uid: ind.uid, inputs: ind.params, hidden: !!ind.hidden } };
  }
  async indicator_remove(input) {
    const p = this.pane(input);
    const list = input.all ? p.cfg.indicators.map((x) => x.uid) : input.uids || [];
    if (!list.length) fail("Give uids (from chart_read) or all.");
    const names = [];
    for (const uid of list) {
      const ind = p.cfg.indicators.find((x) => x.uid === uid) || fail(`No indicator ${uid} on chart ${this.chartNo(p)}.`);
      names.push(shortName(BY_ID[ind.id]));
    }
    for (const uid of list) p.removeIndicator(uid);
    return { label: `Removed ${names.join(", ")}`, result: { removed: list.length } };
  }
  async favorite_set(input) {
    const def = BY_ID[input.id] || fail(`Unknown indicator id "${input.id}".`);
    const favs = indicatorFavs(this.app);
    const has = favs.includes(def.id);
    if (input.on && !has) favs.push(def.id);
    if (!input.on && has) favs.splice(favs.indexOf(def.id), 1);
    this.app.persist();
    return { label: `${input.on ? "Made" : "Took"} ${shortName(def)} ${input.on ? "a favorite" : "off the favorites"}`, result: { favorites: favs.length } };
  }

  // ---------- drawings ----------
  async drawing_add(input) {
    const p = this.pane(input),
      a = this.app;
    const tool = DRAWABLE_BY_ID[input.type] || fail(`"${input.type}" isn't a drawing tool I can place.`);
    const pts = Array.isArray(input.points) ? input.points : fail("Give the points.");
    if (tool.points ? pts.length !== tool.points : pts.length < 2) fail(`${tool.label} takes ${tool.points || "2 or more"} point${tool.points === 1 ? "" : "s"}; got ${pts.length}.`);
    const points = pts.map((q, k) => this.anchor(p, q, k));
    if (input.color && !HEX.test(input.color)) fail("color is #rrggbb.");
    const item = { id: newUid(), type: tool.id, points, ...a.drawingDefaults(tool.id), ...p.ownTag() };
    if (input.text) item.text = String(input.text).slice(0, 500);
    if (input.color) item.color = input.color;
    if ((tool.id === "long" || tool.id === "short") && Number.isFinite(input.risk_reward) && input.risk_reward > 0) item.rr = input.risk_reward;
    p.drawings.items.push(item);
    a.saveDrawings(p.drawKey(), p.drawings.items);
    p.drawings.update();
    const at = points.map((q) => round(q.price)).join(" to ");
    return { label: `Drew a ${tool.label}${points.length <= 2 ? ` (${at})` : ""}`, result: { id: item.id, type: tool.id, points: points.map((q) => ({ time: iso(q.time), price: round(q.price) })) } };
  }
  async drawing_edit(input) {
    const p = this.pane(input),
      a = this.app;
    const d = p.drawings.items.find((x) => x.id === input.id) || fail(`No drawing ${input.id} on chart ${this.chartNo(p)}; chart_read lists them.`);
    if (a.isLocked(d) && input.locked !== false) fail("That drawing is locked. Unlock it first (locked: false), or leave it.");
    if (input.points) {
      const tool = DRAWABLE_BY_ID[d.type];
      if (tool?.points && input.points.length !== tool.points) fail(`${tool.label} takes ${tool.points} points.`);
      d.points = input.points.map((q, k) => this.anchor(p, q, k));
    }
    if (input.text != null) d.text = String(input.text).slice(0, 500);
    if (input.color) {
      if (!HEX.test(input.color)) fail("color is #rrggbb.");
      d.color = input.color;
    }
    if (input.locked != null) d.locked = input.locked ? true : undefined;
    if (input.hidden != null) d.hidden = input.hidden ? true : undefined;
    a.saveDrawings(p.drawKey(), p.drawings.items);
    p.drawings.update();
    return { label: `Changed the ${DRAWABLE_BY_ID[d.type]?.label || d.type}`, result: { id: d.id } };
  }
  async drawing_remove(input) {
    const p = this.pane(input),
      a = this.app;
    const items = p.drawings.items;
    const ids = input.all ? items.map((d) => d.id) : input.ids || [];
    if (!ids.length) fail("Give ids (from chart_read) or all.");
    for (const id of ids) if (!items.some((d) => d.id === id)) fail(`No drawing ${id} on chart ${this.chartNo(p)}.`);
    const locked = items.filter((d) => ids.includes(d.id) && a.isLocked(d));
    p.drawings.items = items.filter((d) => !ids.includes(d.id) || a.isLocked(d));
    if (p.drawings.selected && !p.drawings.items.includes(p.drawings.selected)) p.drawings.selected = null;
    a.saveDrawings(p.drawKey(), p.drawings.items);
    p.drawings.update();
    const n = ids.length - locked.length;
    return { label: `Removed ${n} drawing${n === 1 ? "" : "s"}${locked.length ? ` (${locked.length} locked, kept)` : ""}`, result: { removed: n, keptLocked: locked.length } };
  }

  // ---------- lists ----------
  async watchlist_edit(input) {
    const a = this.app;
    const lists = (a.state.watchlists ||= {});
    let name = input.list || a.state.activeWatchlist;
    if (input.create) {
      name = String(input.list || "").trim().slice(0, 40) || fail("Give the new list a name (list).");
      if (lists[name]) fail(`There's already a list called ${name}.`);
      lists[name] = [];
      a.state.activeWatchlist = name;
    }
    const list = lists[name] || fail(`There's no list called ${name}. Lists: ${Object.keys(lists).join(", ")}.`);
    const added = [],
      removed = [];
    for (const s of input.add || []) {
      const sym = await this.symbol(s);
      if (!list.includes(sym)) {
        list.push(sym);
        added.push(sym);
      }
    }
    for (const s of input.remove || []) {
      const i = list.indexOf(s);
      if (i >= 0) {
        list.splice(i, 1);
        removed.push(s);
      }
    }
    a.persist();
    this.refreshLists();
    const parts = [input.create && `started the list ${name}`, added.length && `added ${added.join(", ")}`, removed.length && `removed ${removed.join(", ")}`].filter(Boolean);
    if (!parts.length) fail("Nothing to change: give add, remove or create.");
    return { label: `Watchlist ${name}: ${parts.join("; ")}`, result: { list: name, symbols: list } };
  }

  // ---------- questions ----------
  // The person clicks an answer in the panel; Stop, or no panel to ask in, is no answer.
  async ask_person(input, { choose } = {}) {
    const q = String(input.question || "").trim().slice(0, 300);
    const choices = (Array.isArray(input.choices) ? input.choices : []).map((c) => String(c).trim().slice(0, 80)).filter(Boolean);
    if (!q || choices.length < 2 || choices.length > 5) fail("Ask one question with 2 to 5 short answers.");
    if (!choose) fail("There's no panel to ask in here: ask in your text instead.");
    const answer = await choose(q, choices);
    if (answer == null) return { label: `Asked: ${q}`, result: "The person didn't answer. Stop here and wait for them." };
    return { label: `Asked: ${q} (${answer})`, result: { answer } };
  }
  // Buttons under the answer; a click sends one as the person's next message.
  async next_steps(input, { offer } = {}) {
    const steps = [...new Set((Array.isArray(input.steps) ? input.steps : []).map((s) => String(s).trim().slice(0, 80)).filter(Boolean))];
    if (!steps.length || steps.length > 3) fail("Give 1 to 3 short next steps.");
    if (!offer) fail("There's no panel to show buttons in here: offer them in your text instead.");
    offer(steps);
    return { label: "Offered next steps", result: "Shown as buttons under your answer." };
  }

  // ---------- Pine strategies: written by the AI, run and tested on the server (lib/pinerun.js) ----------
  // the symbol and interval to run on: the ones given, else the active chart's
  async target(input) {
    const p = this.app.active;
    const symbol = input.symbol ? await this.symbol(input.symbol) : p.cfg.symbol;
    return { symbol, tf: this.interval(input.interval || p.cfg.tf) };
  }
  interval(tf) {
    try {
      parseTf(String(tf));
    } catch {
      fail(`"${tf}" isn't an interval: use one like 1h, 4h or 1D.`);
    }
    return String(tf);
  }
  async research(path, body) {
    try {
      return await api.post(path, body);
    } catch (e) {
      fail(e.status === 503 ? "Two strategy tests are already running. Wait a moment and try once more." : e.message || String(e));
    }
  }
  // what the research covered, read first: a long answer is cut short in later turns
  // the first and last bar: a date, with the time (UTC) on an intraday chart, so script_save can start the
  // report on the same bar; then how far back that is against the years asked (w: the server's years, short)
  span(b, source, w) {
    if (!b) return null;
    const [from, to] = [iso(b.from), iso(b.to)].map((s) => s?.replace(/ 00:00$/, ""));
    const reach = !w?.years
      ? ""
      : w.short === "bars"
        ? `, under the ${w.years} years asked: 19,500 bars is the most`
        : w.short === "history"
          ? `, all the history there is: under the ${w.years} years asked`
          : `, the last ${w.years} year${w.years === 1 ? "" : "s"}`;
    return `${b.count} bars from ${from} to ${to}${/:/.test(from + to) ? " UTC" : ""}${source ? ` (${source})` : ""}${reach}`;
  }
  // how long a typical trade lasted, from its median hours
  hold(h) {
    if (h == null) return null;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes` : h < 48 ? `${+h.toFixed(1)} hours` : `${+(h / 24).toFixed(1)} days`;
  }
  // one stretch, short: return and buy and hold in %, trades, win rate, typical hold, worst drop, Sharpe
  stretch(x) {
    return x ? { from: iso(x.from), to: iso(x.to), returnPct: x.returnPct, buyHoldPct: x.buyHoldPct, trades: x.trades, winRatePct: x.winRatePct, typicalHold: this.hold(x.holdHours), worstDropPct: x.maxDrawdownPct, sharpe: x.sharpe } : null;
  }
  // the years asked, the same on every research tool (the server's 2 when left out)
  years(input) {
    const y = Number(input.years);
    return y > 0 ? y : undefined;
  }
  pct(v) {
    return v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v}%`;
  }

  async market_character(input) {
    const { symbol, tf } = await this.target(input);
    const r = await this.research("/api/market/profile", { symbol, tf, years: this.years(input) });
    if (!r.ok) fail(r.error?.message || "No profile came back.");
    const { ok, bars, source, symbol: s, tf: _t, years, short, ...rest } = r;
    return { label: `Profiled ${this.name(symbol)} ${tf}: ${r.character}`, result: { symbol, interval: tf, bars: this.span(bars, source, r), ...rest } };
  }

  async script_check(input) {
    const { symbol, tf } = await this.target(input);
    const r = await this.research("/api/pine/check", { code: String(input.code || ""), symbol, tf, params: input.inputs || {}, years: this.years(input) });
    if (!r.ok) {
      const at = r.error?.line ? `line ${r.error.line}: ` : "";
      return { label: `Checked the script: ${at}${r.error?.message}`, result: { ok: false, error: r.error, note: "Fix it and check again. After two tries on the same error, explain the problem instead." } };
    }
    const s = r.strategy;
    const head = { ok: true, kind: r.kind, title: r.title, symbol, interval: tf, bars: this.span(r.bars, r.source, r) };
    if (!s) return { label: `Checked ${r.title} on ${this.name(symbol)} ${tf}`, result: { ...head, plots: r.plots, markers: r.markers, inputs: r.inputs, warnings: r.warnings } };
    return {
      label: `Checked ${r.title} on ${this.name(symbol)} ${tf}: ${s.closedTrades} trades, ${this.pct(s.whole?.returnPct)} against ${this.pct(s.whole?.buyHoldPct)} buy and hold`,
      result: {
        ...head,
        closedTrades: s.closedTrades,
        whole: this.stretch(s.whole),
        first70: this.stretch(s.train),
        last30: this.stretch(s.test),
        fees: s.fees,
        sizePct: s.sizePct,
        ...(s.tinyOrder ? { tinyOrder: true, note: "Each trade uses under 1% of the account, so returns are tiny: add default_qty_type=strategy.percent_of_equity, default_qty_value=100 to strategy()." } : {}),
        ...(s.thin ? { thin: true } : {}),
        inputs: r.inputs,
        warnings: r.warnings,
      },
    };
  }

  async strategy_sweep(input) {
    const { symbol, tf } = await this.target(input);
    const r = await this.research("/api/pine/sweep", { code: String(input.code || ""), symbol, tf, params: input.inputs || {}, sweep: input.sweep || {}, years: this.years(input) });
    if (!r.ok) fail(`${r.error?.line ? `line ${r.error.line}: ` : ""}${r.error?.message || "The sweep didn't run."}`);
    const pick = r.picked;
    const set = (v) => Object.entries(v || {}).map(([k, x]) => `${k} ${x}`).join(", ");
    return {
      label: `Tried ${r.tried} versions of ${r.title} on ${this.name(symbol)} ${tf}${pick ? `: picked ${set(pick.values)}, ${r.checks?.passed} of ${r.checks?.of} checks passed` : ": none picked"}`,
      result: {
        title: r.title,
        symbol,
        interval: tf,
        bars: this.span(r.bars, r.source, r),
        versionsTried: r.tried,
        picked: pick ? { settings: pick.values, inputs: pick.inputs, first70: this.stretch(pick.train), last30: this.stretch(pick.test) } : null,
        checks: r.checks ? { ...r.checks, ...(r.checks.quarters ? { quarters: r.checks.quarters.map((q) => ({ ...q, from: iso(q.from)?.slice(0, 10), to: iso(q.to)?.slice(0, 10) })) } : {}) } : null,
        ...(r.note ? { note: r.note } : {}),
        ...(r.failed ? { failed: r.failed } : {}),
        bestOnFirst70: (r.best || []).map((x) => ({ settings: x.values, returnPct: x.train?.returnPct, trades: x.train?.trades, sharpe: x.train?.sharpe })),
      },
    };
  }

  async strategy_scan(input) {
    const p = this.app.active;
    const symbol = input.symbol ? await this.symbol(input.symbol) : p.cfg.symbol;
    const tfs = (Array.isArray(input.intervals) && input.intervals.length ? input.intervals : ["1h", "4h", "1D"]).slice(0, 3).map((t) => this.interval(t));
    const r = await this.research("/api/pine/scan", { symbol, tfs, shorts: input.shorts === true, years: this.years(input) });
    if (!r.ok) fail(r.error?.message || "The scan didn't run.");
    return {
      label: `Tested 8 kinds of strategy on ${this.name(symbol)} ${tfs.join(", ")}${r.shorts ? ", long and short" : ""}: ${r.trials} versions`,
      result: {
        symbol,
        intervals: r.intervals.map((x) => ({ interval: x.tf, bars: this.span(x.bars, r.source, { years: r.years, short: x.short }), buyHoldFirst70Pct: x.buyHold?.train, buyHoldLast30Pct: x.buyHold?.test })),
        versionsTried: r.trials,
        feePct: r.fee,
        ...(r.shorts ? { shorts: "The trend kinds (Moving average cross, MACD cross, Supertrend) went long and short. The other five only buy: they have no short side." } : {}),
        note: "Ranked on the last 30%: a kind picked from this ranking was chosen on those bars, so its last-30% figure is optimistic. Add these versions to any sweep's when you say how many were tried, and let the quant checks decide.",
        ranked: r.results.map((x) => ({ kind: x.name, template: x.template, interval: x.tf, ...(r.shorts ? { sides: x.shorts ? "long and short" : "long only" } : {}), settings: x.picked, first70: this.stretch(x.train), last30: this.stretch(x.test) })),
      },
    };
  }

  async script_save(input) {
    const a = this.app,
      p = a.active;
    const code = String(input.code || "");
    if (!code.trim()) fail("Give the script's code.");
    // the report runs on the chart's symbol and interval: they must be the ones the script was checked on
    if (input.symbol) {
      const sym = await this.symbol(input.symbol);
      if (sym !== p.cfg.symbol) fail(`The active chart shows ${this.name(p.cfg.symbol)}, not ${this.name(sym)}. Put ${sym} on it with chart_set first, so the report runs on the bars you checked.`);
    }
    if (input.interval && this.interval(input.interval) !== p.cfg.tf) fail(`The active chart is on ${p.cfg.tf}, not ${input.interval}. Change it with chart_set first.`);
    let compiled;
    try {
      compiled = compilePine(code);
    } catch (e) {
      fail(`It doesn't compile (${e.message}). Fix it with script_check first.`);
    }
    const name = String(input.name || compiled.meta.title || "My script").trim().slice(0, 60);
    const scripts = (a.state.pineScripts ||= {});
    // the same name and code is that saved script, not a copy; a name in use gets the next number
    let id = Object.entries(scripts).find(([, s]) => s.name === name && s.code === code)?.[0];
    const reused = !!id;
    if (!id) {
      let free = name;
      for (let k = 2; Object.values(scripts).some((s) => s.name === free); k++) free = `${name} ${k}`;
      id = `s${Date.now().toString(36)}`;
      scripts[id] = { name: free, code, saved: Date.now() };
    }
    const saved = scripts[id].name;
    const { def } = a.pineEditor.register(id, code);
    const favs = indicatorFavs(a);
    if (!favs.includes(def.id)) favs.push(def.id);
    let uid = null;
    const from = input.testing_from ? parseWhen(input.testing_from) : null;
    if (input.testing_from && !Number.isFinite(from)) fail("testing_from is a date like 2023-11-02.");
    if (input.add_to_chart !== false) {
      uid = p.cfg.indicators.find((x) => x.id === def.id)?.uid || p.addIndicator(def.id);
      const ind = p.cfg.indicators.find((x) => x.uid === uid);
      if (def.strategy && Number.isFinite(from)) ind.range = { kind: "custom", from, to: null };
      p.render(false);
      if (def.strategy) a.panels?.showStrategyReport?.(p, uid);
    }
    a.persist();
    const where = uid ? ` and added it to ${this.which(p)}` : "";
    return {
      label: `${reused ? "Used" : "Saved"} ${saved} in My scripts${where}`,
      script: { id, name: saved, code, symbol: p.cfg.symbol, tf: p.cfg.tf, strategy: !!def.strategy, uid },
      result: {
        id,
        name: saved,
        indicatorId: def.id,
        ...(uid ? { uid, chart: this.chartNo(p) } : {}),
        ...(reused ? { reused: true } : {}),
        ...(def.strategy && uid
          ? { report: `The Strategy tester shows its report${Number.isFinite(from) ? ` from ${iso(from).slice(0, 10)}` : " on the chart's bars"}: one figure for the whole period, where your research also split it 70/30. Say so.` }
          : {}),
      },
    };
  }
}

// ---------- the conversation ----------
// One answer: ask the model (the server adds the guide and holds the key), do the tools it calls, send
// back what happened, until it answers or the limits are reached. `history` is the earlier turns in the
// shared form ({role: user|assistant|tool}); returns this answer's exchanges in the same form.
export async function converse({ tools, history, context, signal, onText, onStep, confirm, askFirst, choose, offer }) {
  const exchanges = [];
  let calls = 0,
    usage = { input: 0, output: 0, cached: 0 },
    stop = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const step = await askModel([...history, ...exchanges], context, signal, onText);
    usage = { input: usage.input + step.usage.input, output: usage.output + step.usage.output, cached: usage.cached + step.usage.cached };
    stop = step.stop;
    exchanges.push({ role: "assistant", content: step.text, calls: step.calls });
    if (!step.calls.length) break;
    const results = [];
    for (const call of step.calls) {
      if (signal?.aborted) {
        results.push({ id: call.id, content: "The person pressed Stop.", error: true });
        continue;
      }
      if (++calls > MAX_CALLS) {
        results.push({ id: call.id, content: `Stopped: at most ${MAX_CALLS} actions in one answer. Tell the person what's left to do.`, error: true });
        continue;
      }
      const done = await tools.run(call, { confirm, askFirst, choose, offer });
      onStep?.(call, done);
      const r = done.result;
      if (done.error) results.push({ id: call.id, content: done.error, error: true });
      else if (r && typeof r === "object" && r.image) results.push({ id: call.id, image: r.image, mediaType: r.mediaType, text: r.text || "" });
      else results.push({ id: call.id, content: typeof r === "string" ? r : JSON.stringify(r ?? "Done.").slice(0, 30000) });
    }
    exchanges.push({ role: "tool", results });
    if (signal?.aborted) break;
    // only tools that end the answer (next_steps), and they worked: no round just to hear it's done
    if (step.calls.every((c) => AGENT_TOOL_BY_NAME[c.name]?.ends) && results.every((r) => !r.error)) break;
  }
  return { exchanges, usage, stop };
}

// One round with the model: streams its text to onText, collects the tools it calls.
async function askModel(messages, context, signal, onText) {
  const res = await fetch("/api/agent/step", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-qt": "1" },
    body: JSON.stringify({ messages, context }),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader(),
    dec = new TextDecoder();
  let buf = "",
    text = "",
    stop = null,
    usage = { input: 0, output: 0, cached: 0 },
    error = null;
  const calls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, k);
      buf = buf.slice(k + 2);
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.t === "text") {
        text += ev.v;
        onText?.(ev.v);
      } else if (ev.t === "call") calls.push({ id: ev.id, name: ev.name, input: ev.input || {} });
      else if (ev.t === "error") error = ev.message;
      else if (ev.t === "done") {
        stop = ev.stop;
        usage = { input: ev.usage?.input || 0, output: ev.usage?.output || 0, cached: ev.usage?.cached || 0 };
      }
    }
  }
  if (error) throw new Error(error);
  return { text, calls, stop, usage };
}

// Earlier turns for the model: text as it was, tool results cut short and pictures left out, so a long
// chat stays cheap. An answer stopped between a call and its result gets a result saying so.
export function historyFor(messages, turns = 10) {
  const out = [];
  let users = 0;
  for (let i = messages.length - 1; i >= 0 && users < turns; i--) if (messages[i].role === "user") users++;
  const start = (() => {
    let n = 0;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && ++n === users) return i;
    return 0;
  })();
  for (const m of messages.slice(start)) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (Array.isArray(m.api) && m.api.length) {
      for (let k = 0; k < m.api.length; k++) {
        const x = m.api[k];
        if (x.role === "assistant") {
          out.push({ role: "assistant", content: x.content || "", calls: x.calls || [] });
          if (x.calls?.length && m.api[k + 1]?.role !== "tool") out.push({ role: "tool", results: x.calls.map((c) => ({ id: c.id, content: "The person stopped this.", error: true })) });
        } else if (x.role === "tool")
          out.push({ role: "tool", results: x.results.map((r) => ({ id: r.id, error: !!r.error, content: r.image ? "[a picture of the chart]" : String(r.content ?? "").slice(0, 1500) })) });
      }
    } else if (m.content && !m.error) out.push({ role: "assistant", content: m.content });
  }
  return out;
}
