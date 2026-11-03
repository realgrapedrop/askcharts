// One chart: candles + volume + any number of indicators, drawings, compare symbols, replay and live data.
import { api, fmtPrice, fmtPct, fmtNum, esc, ticker, exchange } from "./api.js";
import { BY_ID, compute, periodKey, defaults } from "../lib/indicators.js";
import {
  parseTf,
  isIntraday,
  heikinAshi,
  renko,
  lineBreak,
  rangeBars,
  kagi,
  pointFigure,
} from "../lib/series.js";
import { DrawingLayer, TOOL_BY_ID, GLYPHS } from "./drawings.js";
import { VolumeProfile, SessionVolumeProfile } from "./volume-profile.js";
import { PineDrawings } from "./pine-drawings.js";
import { indicatorFavs } from "./indicatorpicker.js";
import { visibleOn } from "./indsettings.js";
import { rangeBounds } from "./strategyreport.js";
import { BandFill } from "./indfill.js";
import { EmptyNote } from "./indempty.js";
import { LINE_STYLE, colorOf, zoneOf, tzOffset, chartTime, chartToUtc, fmtDate, fmtClock, precisionFormatter, minMoveOf, quoteCurrency } from "./chartsettings.js";
import { ChartExtras, marketState } from "./chartextras.js";
import { StyleSeries, CUSTOM_TYPES, TYPE_GROUPS, UNAVAILABLE } from "./charttypes.js";

const LW = window.LightweightCharts;
// A new chart starts with bars 6px apart (the chart library's own default); a zoom of yours is kept.
const BAR_SPACING = 6;

// TradingView's chart types, in its menu's order (charttypes.js has the groups and icons).
export const CHART_TYPES = TYPE_GROUPS.flat();
// Chart types built from price alone, with no meaningful volume per bar.
const PRICE_ONLY = ["renko", "linebreak", "kagi", "pnf"];
const BINANCE_WS_TF = {
  "1s": "1s",
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "2h": "2h",
  "4h": "4h",
  "6h": "6h",
  "8h": "8h",
  "12h": "12h",
  "1D": "1d",
  "3D": "3d",
  "1W": "1w",
  "1M": "1M",
};
const ICON = {
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 20L20 4"/></svg>',
  hexGear: '<svg viewBox="0 0 24 24"><path d="M3.5 12l4.25-7.35h8.5L20.5 12l-4.25 7.35h-8.5z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  braces: '<svg viewBox="0 0 24 24"><path d="M7.5 4.5H5.5a1 1 0 0 0-1 1v5L2.5 12l2 1.5v5a1 1 0 0 0 1 1h2M16.5 4.5h2a1 1 0 0 1 1 1v5l2 1.5-2 1.5v5a1 1 0 0 1-1 1h-2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6 7l1 12.5h10L18 7"/></svg>',
  more: '<svg viewBox="0 0 24 24" class="fill"><circle cx="4" cy="12" r="2.25"/><circle cx="12" cy="12" r="2.25"/><circle cx="20" cy="12" r="2.25"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// A colour at a given opacity (hex or rgba in).
function fade(c, a) {
  const s = String(c || "");
  const m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const r = /^rgba?\(([^,]+),([^,]+),([^,)]+)/i.exec(s);
  return r ? `rgba(${r[1]},${r[2]},${r[3]},${a})` : s;
}
// The status line's logo: a coloured disc with the first letter (no outside images).
function badge(sym) {
  const t = ticker(sym);
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="wl-badge lg-logo" style="--h:${h}">${esc((t.match(/[A-Z0-9]/i) || ["?"])[0].toUpperCase())}</span>`;
}
let uidSeq = 0;
export const newUid = () =>
  `i${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

// A chart line can't skip a blank point: it joins the neighbours. A segment takes the colour of
// the point it starts from, so hiding a gap means making the point before it transparent and
// parking the gap's points (invisibly) at the next real value.
const CLEAR = "rgba(0,0,0,0)";
// A line joined across bars with no value (XRPL On chain on a seconds chart, where many bars hold no
// ledger): those bars get no point at all, so the line runs straight from one value to the next.
// lastColor: the colour of the segment into the newest bar while that bar is still adding up. breakBefore: the
// bars after an outage (XRPL: a jump in ledger index), where the line breaks instead.
function bridgedLineData(vals, timeAt, n, lastColor, breakBefore) {
  const out = [];
  for (let i = 0; i < Math.min(vals.length, n); i++) {
    if (!Number.isFinite(vals[i])) continue;
    if (breakBefore?.[i] && out.length) out.at(-1).color = CLEAR;
    out.push({ time: timeAt(i), value: vals[i] });
  }
  if (lastColor && out.length > 1 && out.at(-1).time === timeAt(n - 1) && !out.at(-2).color) out.at(-2).color = lastColor;
  return out;
}

function lineData(vals, breaks, timeAt, n, colors) {
  const out = [];
  const next = new Array(vals.length);
  let nv = NaN;
  for (let i = vals.length - 1; i >= 0; i--) { if (Number.isFinite(vals[i])) nv = vals[i]; next[i] = nv; }
  let started = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i], time = timeAt(i);
    if (!Number.isFinite(v)) {
      if (i >= n) continue;
      out.push(started && Number.isFinite(next[i]) ? { time, value: next[i], color: CLEAR } : { time });
      continue;
    }
    started = true;
    const gapAhead = i + 1 < vals.length && (!Number.isFinite(vals[i + 1]) || breaks?.[i + 1]);
    // a colour per bar (a Pine plot's color= that changes) colours the segment from that bar
    out.push(gapAhead ? { time, value: v, color: CLEAR } : colors?.[i] ? { time, value: v, color: colors[i] } : { time, value: v });
  }
  return out;
}
function histData(vals, colors, timeAt, n) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (i >= n && !Number.isFinite(v)) continue;
    if (!Number.isFinite(v)) out.push({ time: timeAt(i) });
    else out.push(colors ? { time: timeAt(i), value: v, color: colors[i] } : { time: timeAt(i), value: v });
  }
  return out;
}

// Higher-timeframe values onto chart bars. A chart bar sees a higher-timeframe bar only once that
// bar has finished, except inside the newest one, where it shows the still-forming value (as
// TradingView does in real time).
function mapToChart(res, hb, htf, cb, ctf) {
  const hSec = parseTf(htf).seconds, cSec = parseTf(ctf).seconds;
  const end = (j) => (j + 1 < hb.length ? hb[j + 1].time : hb[j].time + hSec);
  const idx = new Array(cb.length).fill(-1);
  let j = -1;
  for (let i = 0; i < cb.length; i++) {
    const cEnd = cb[i].time + cSec;
    while (j + 1 < hb.length && end(j + 1) <= cEnd) j++;
    idx[i] = j + 1 === hb.length - 1 && cb[i].time >= hb[hb.length - 1].time ? hb.length - 1 : j;
  }
  const out = {};
  for (const [k, v] of Object.entries(res)) {
    if (k === "markers" || k === "pineDrawings") continue;
    out[k] = Array.isArray(v) && v.length >= hb.length ? idx.map((x) => (x >= 0 ? v[x] : NaN)) : v;
  }
  return out;
}

export class ChartPane {
  constructor(app, el, cfg) {
    this.app = app;
    this.el = el;
    this.cfg = {
      symbol: "BINANCE:BTCUSDT",
      tf: "1D",
      type: "candles",
      indicators: [],
      compare: [],
      log: false,
      ...cfg,
    };
    this.bars = this.rawBars = [];
    this.shown = [];
    this.times = [];
    this.indSeries = new Map();
    this.indResults = {};
    this.compareSeries = new Map();
    this.extraMarkers = [];
    this.replay = null;
    el.innerHTML =
      '<div class="chart"></div><div class="legend"><div class="lg-main"></div><div class="lg-trade" hidden></div><div class="lg-rest"></div></div><div class="pane-msg hidden"></div>';
    this.chartEl = el.querySelector(".chart");
    this.legendEl = el.querySelector(".legend");
    this.msgEl = el.querySelector(".pane-msg");
    this.createChart();
    el.addEventListener("mousedown", () => app.setActive(this), true);
  }

  // ---------- setup ----------
  // The chart Settings dialog's values (app.settings.chart), with the theme filling unset colours.
  get cs() {
    return this.app.settings.chart;
  }
  get scaleId() {
    return this.cs.placement === "left" ? "left" : "right";
  }
  // Mouse positions are taken from the chart element; with the price scale on the left the plot
  // starts after it.
  get plotLeft() {
    if (this.cs.placement !== "left") return 0;
    try {
      return this.chart.priceScale("left").width();
    } catch {
      return 0; // not painted yet
    }
  }
  themeOptions() {
    const cs = this.cs,
      c = (k) => colorOf(cs, k),
      left = cs.placement === "left";
    const scale = { borderColor: c("scaleLineColor"), alignLabels: cs.noOverlap };
    return {
      layout: {
        // TradingView's attribution notice and link are in Settings, About, which Lightweight Charts'
        // licence accepts in place of this logo on the chart
        attributionLogo: false,
        background: cs.bgType === "gradient" ? { type: "gradient", topColor: c("bgTop"), bottomColor: c("bgBottom") } : { type: "solid", color: c("bg") },
        textColor: c("scaleTextColor"),
        fontSize: cs.scaleFontSize || 12,
        panes: {
          separatorColor: c("separatorColor"),
          separatorHoverColor: css("--accent-soft"),
          enableResize: true,
        },
      },
      grid: {
        vertLines: { visible: cs.vertGrid, color: c("vertGridColor"), style: LINE_STYLE[cs.vertGridStyle] ?? 0 },
        horzLines: { visible: cs.horzGrid, color: c("horzGridColor"), style: LINE_STYLE[cs.horzGridStyle] ?? 0 },
      },
      rightPriceScale: { ...scale, visible: !left },
      leftPriceScale: { ...scale, visible: left },
      timeScale: { borderColor: c("scaleLineColor"), rightOffset: cs.marginRight, tickMarkFormatter: (t, type) => this.tickLabel(t, type) },
      crosshair: this.crosshairOptions(),
      localization: { timeFormatter: (t) => this.formatTime(t) },
    };
  }
  // The cursor menu decides whether the lines show; Settings decides their colour and style.
  crosshairOptions() {
    const mode = this.app.cursorMode(),
      cs = this.cs;
    const l = { color: colorOf(cs, "crosshairColor"), style: LINE_STYLE[cs.crosshairStyle] ?? 2, width: cs.crosshairWidth || 1, visible: mode === "cross" || mode === "dot", labelVisible: mode !== "demo" && mode !== "magic" };
    return { mode: LW.CrosshairMode.Normal, vertLine: { ...l }, horzLine: { ...l } };
  }
  // Time axis labels in 12 or 24 hours (the date parts keep the library's own labels).
  tickLabel(t, type) {
    if (typeof t !== "number" || type < 3) return null;
    return fmtClock(this.wallOf(t), this.cs.hours === "12", type === 4);
  }

  createChart() {
    const opts = this.themeOptions();
    this.chart = LW.createChart(this.chartEl, {
      autoSize: true,
      ...opts,
      timeScale: { ...opts.timeScale, timeVisible: true, secondsVisible: false },
    });
    this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
    // Your zoom is kept with the chart (as on TradingView): a zoom you make with the wheel, a pinch, by
    // dragging the time scale or with a date range, never one the app makes (loading, Go to).
    const touched = () => (this.zoomedAt = Date.now());
    // capture: heard before the chart library zooms and reports the change
    this.chartEl.addEventListener("wheel", touched, { passive: true, capture: true });
    this.chartEl.addEventListener("pointerdown", touched, { capture: true });
    this.chartEl.addEventListener("touchstart", touched, { passive: true, capture: true });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      this.clampLeft();
      this.noteZoom();
    });
    this.chart.subscribeClick((p) => {
      if (this.app.tool === "cursor") this.onClick(p);
    });
    // Lightweight Charts drops a second click that lands within 500ms of the first (it waits for a
    // double-click), so drawing tools read native clicks instead.
    this.chartEl.addEventListener("click", (e) => {
      // Shift + click measures, as on TradingView
      if (this.app.tool === "cursor" && e.shiftKey && !this.drawings.ruler) this.app.setTool("ruler");
      if (this.app.tool === "cursor") return;
      const r = this.chartEl.getBoundingClientRect();
      const x = e.clientX - r.left - this.plotLeft,
        y = e.clientY - r.top;
      const inPlot =
        x >= 0 &&
        x <= this.chart.timeScale().width() &&
        y >= 0 &&
        y <= this.chart.panes()[0].getHeight();
      this.onClick({
        point: inPlot ? { x, y } : undefined,
        logical: inPlot ? this.chart.timeScale().coordinateToLogical(x) : null,
        paneIndex: 0,
      });
    });
    // Freehand tools (brush, highlighter) draw while the mouse button is held down.
    this.chartEl.addEventListener("pointerdown", (e) => {
      const def = TOOL_BY_ID[this.app.tool];
      const pt = def?.freehand && e.button === 0 ? this.pointAtXY(e) : null;
      if (!pt) return;
      e.preventDefault();
      this.chartEl.setPointerCapture(e.pointerId);
      this.freehand = { x: e.clientX, y: e.clientY };
      this.drawings.temp = { id: newUid(), type: def.id, points: [pt], ...this.app.drawingDefaults(def.id), ...this.ownTag() };
      this.drawings.update();
    });
    this.chartEl.addEventListener("pointermove", (e) => {
      if (!this.freehand || Math.hypot(e.clientX - this.freehand.x, e.clientY - this.freehand.y) < 3) return;
      const pt = this.pointAtXY(e);
      if (!pt) return;
      this.freehand = { x: e.clientX, y: e.clientY };
      this.drawings.temp.points.push(pt);
      this.drawings.update();
    });
    // Double-click a selected drawing: its text box for shapes that hold text, else its settings.
    this.chartEl.addEventListener("dblclick", (e) => {
      // the double-click that just finished a path isn't a request for anything
      if (this.app.tool !== "cursor" || Date.now() - (this.finishedAt || 0) < 600) return;
      const r = this.chartEl.getBoundingClientRect(),
        x = e.clientX - r.left - this.plotLeft,
        y = e.clientY - r.top,
        sel = this.drawings.selected;
      if (sel && this.drawings.hitTest(x, y) === sel) return this.app.drawToolbar?.openForDoubleClick(x, y);
      // TradingView: double-click a pane to maximize it (again to restore), Cmd/Ctrl + double-click
      // to collapse it. Only on the plot, not the scales.
      if (x >= 0 && x <= this.chart.timeScale().width()) this.extras?.paneDoubleClick(e);
    });
    // Values tooltip on long press: hold still on the chart for half a second to see the bar.
    this.chartEl.addEventListener("pointerdown", (e) => {
      if (this.app.tool !== "cursor" || e.button !== 0 || this.app.settings.valuesTooltip === false) return;
      const x0 = e.clientX, y0 = e.clientY;
      clearTimeout(this.pressTimer);
      this.pressTimer = setTimeout(() => this.showValues(x0, y0), 500);
      const cancel = (m) => {
        if (m.type === "pointermove" && Math.hypot(m.clientX - x0, m.clientY - y0) < 6) return;
        clearTimeout(this.pressTimer);
        this.hideValues();
        removeEventListener("pointermove", cancel);
        removeEventListener("pointerup", cancel);
      };
      addEventListener("pointermove", cancel);
      addEventListener("pointerup", cancel);
    });
    const endFreehand = () => {
      if (!this.freehand) return;
      this.freehand = null;
      const d = this.drawings,
        t = d.temp;
      d.temp = null;
      if (t?.points.length >= 2) {
        d.items.push(t);
        d.selected = t;
        this.app.saveDrawings(this.drawKey(), d.items);
      }
      d.update();
      if (!this.app.settings.stayInDrawMode) this.app.setTool("cursor");
    };
    this.chartEl.addEventListener("pointerup", endFreehand);
    this.chartEl.addEventListener("pointercancel", endFreehand);
    // Emojis, stickers and icons, as on TradingView: drag a corner to resize, the middle to move.
    // Every other drawing: drag a handle of the selected one to reshape it, or a drawing to move it.
    // Heard first (capture), so the chart doesn't pan.
    this.chartEl.addEventListener("pointerdown", (e) => this.glyphDrag(e), { capture: true });
    this.chartEl.addEventListener("pointerdown", (e) => this.drawingDrag(e), { capture: true });
    this.chartEl.addEventListener("pointermove", (e) => this.glyphHover(e), { capture: true });
    this.drawings = new DrawingLayer(this);
    this.makeMainSeries();
    this.extras = new ChartExtras(this);
    this.extras.attach(this.main);
  }

  showValues(cx, cy) {
    const r = this.chartEl.getBoundingClientRect(),
      l = Math.round(this.chart.timeScale().coordinateToLogical(cx - r.left - this.plotLeft) ?? NaN),
      b = this.shown[l], prev = this.shown[l - 1];
    if (!b) return;
    const chg = prev ? b.close - prev.close : null,
      when = this.formatTime(this.toChart(b.time)),
      f = (v) => this.formatPrice(v);
    this.hideValues();
    const tip = document.createElement("div");
    tip.className = "values-tip";
    tip.innerHTML = `<b>${esc(when)}</b><span>O</span>${f(b.open)}<span>H</span>${f(b.high)}<span>L</span>${f(b.low)}<span>C</span>${f(b.close)}${chg == null ? "" : `<span>Chg</span><i class="${chg >= 0 ? "up" : "down"}">${chg >= 0 ? "+" : ""}${f(chg)} (${fmtPct((chg / prev.close) * 100)})</i>`}${b.volume ? `<span>Vol</span>${fmtNum(b.volume)}` : ""}`;
    document.body.appendChild(tip);
    tip.style.left = `${Math.min(cx + 14, innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(8, cy - tip.offsetHeight - 14)}px`;
    this.valuesTip = tip;
  }

  hideValues() {
    this.valuesTip?.remove();
    this.valuesTip = null;
  }

  // With drawing sync off (the link button on the left), a new drawing belongs to this chart only.
  ownTag() {
    return this.app.settings.drawingSync === "off" ? { pane: (this.cfg.pid ||= newUid()) } : {};
  }

  // Time and price under a mouse event, if it's over the price pane.
  // ---------- dragging emojis, stickers and icons ----------
  plotXY(e) {
    const r = this.chartEl.getBoundingClientRect();
    return { x: e.clientX - r.left - this.plotLeft, y: e.clientY - r.top };
  }
  // What's under the pointer: a corner of the selected glyph (resize) or a glyph's body (move). `hit`,
  // when given, is the drawing hit test's answer for this spot already.
  glyphUnder(x, y, hit) {
    if (this.app.tool !== "cursor" || this.replay) return null;
    const d = this.drawings,
      sel = d.selected;
    const g = sel && GLYPHS.has(sel.type) && !this.app.isLocked(sel) ? d.glyphGeometry(sel) : null;
    if (g) {
      const corner = g.handles.findIndex((h) => Math.hypot(h.x - x, h.y - y) <= 9);
      if (corner >= 0) return { d: sel, g, corner };
      if (g.inside(x, y)) return { d: sel, g, corner: -1 };
    }
    if (hit === undefined) hit = d.hitTest(x, y);
    if (hit && GLYPHS.has(hit.type) && !this.app.isLocked(hit)) {
      const hg = d.glyphGeometry(hit);
      if (hg?.inside(x, y)) return { d: hit, g: hg, corner: -1 };
    }
    return null;
  }
  glyphHover(e) {
    if (this.glyphDragging || this.drawDragging || e.buttons) return;
    const { x, y } = this.plotXY(e),
      hit = this.app.tool === "cursor" && !this.replay ? this.drawings.hitTest(x, y) : null;
    const u = this.glyphUnder(x, y, hit);
    let cls = !u ? "" : u.corner < 0 ? "dr-move" : u.corner === 0 || u.corner === 3 ? "dr-nwse" : "dr-nesw";
    if (!u) {
      // other drawings: a handle of the selected one shows a pointer (an image's or a table's corner the
      // resize cursor, as an emoji's), a drawing the move cursor
      const v = this.drawingUnder(x, y, hit);
      const box = v?.handle >= 0 && (v.d.type === "image" || v.d.type === "table");
      cls = !v ? "" : box ? (v.handle === 0 || v.handle === 3 ? "dr-nwse" : "dr-nesw") : v.handle >= 0 ? "dr-point" : "dr-move";
    }
    if (cls !== this.glyphCursor) {
      this.chartEl.classList.remove("dr-move", "dr-nwse", "dr-nesw", "dr-point");
      if (cls) this.chartEl.classList.add(cls);
      this.glyphCursor = cls;
    }
  }
  glyphDrag(e) {
    if (e.button !== 0) return;
    const { x, y } = this.plotXY(e),
      u = this.glyphUnder(x, y);
    if (!u) return;
    e.preventDefault();
    e.stopPropagation();
    const dl = this.drawings,
      d = u.d,
      a = u.g.center;
    if (dl.selected !== d) {
      dl.selected = d;
      dl.update();
    }
    this.chartEl.setPointerCapture(e.pointerId);
    this.setInteractive(false);
    this.glyphDragging = true;
    const size0 = d.style?.size || 40,
      reach0 = u.corner >= 0 ? Math.max(4, Math.hypot(u.g.handles[u.corner].x - a.x, u.g.handles[u.corner].y - a.y)) : 0;
    let changed = false;
    const move = (m) => {
      const p = this.plotXY(m);
      if (u.corner >= 0) {
        // the corner follows the pointer; the glyph grows or shrinks about its centre
        const size = Math.max(12, Math.min(256, Math.round((size0 * Math.hypot(p.x - a.x, p.y - a.y)) / reach0)));
        if (size === (d.style?.size || 40)) return;
        d.style = { ...(d.style || {}), size };
      } else {
        const ts = this.chart.timeScale(),
          time = this.timeOfLogical(ts.coordinateToLogical(p.x - (x - a.x))),
          price = this.main.coordinateToPrice(p.y - (y - a.y));
        if (time == null || price == null) return;
        d.points = [{ ...d.points[0], time, price }];
      }
      changed = true;
      dl.update();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      this.glyphDragging = false;
      this.setInteractive(true);
      if (changed) this.app.saveDrawings(this.drawKey(), dl.items);
      dl.update();
      // the floating toolbar's size button shows the new size
      const tb = this.app.drawToolbar;
      if (changed && tb?.d === d) tb.render();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  // ---------- dragging other drawings ----------
  // A handle of the selected drawing (reshape) or a drawing's body (move) under the pointer; not
  // glyphs (above), locked or hidden drawings, or anything while drawing, replaying or typing.
  drawingUnder(x, y, hit) {
    const dl = this.drawings;
    if (this.app.tool !== "cursor" || this.replay || dl.editing || dl.ruler) return null;
    if (x < 0 || x > this.chart.timeScale().width() || y < 0 || y > this.chart.panes()[0].getHeight()) return null;
    const sel = dl.selected;
    if (sel && dl.items.includes(sel) && !GLYPHS.has(sel.type) && !this.app.isLocked(sel) && dl.shows(sel)) {
      const handles = dl.handlesOf(sel);
      const h = handles ? handles.findIndex((p) => Math.hypot(p.x - x, p.y - y) <= 8) : -1;
      if (h >= 0) return { d: sel, handle: h, handles };
    }
    if (hit === undefined) hit = dl.hitTest(x, y);
    return hit && !GLYPHS.has(hit.type) && !this.app.isLocked(hit) ? { d: hit, handle: -1 } : null;
  }
  // A press on the selected drawing (a handle or its body) while it's locked pans the chart instead,
  // which looks broken, so say why, at most every 8 seconds. Other locked drawings stay quiet: they're
  // locked so the chart can be dragged over them.
  lockedHint(x, y) {
    const dl = this.drawings,
      sel = dl.selected;
    if (!sel || !dl.items.includes(sel) || !this.app.isLocked(sel) || this.app.tool !== "cursor" || this.replay || dl.editing) return;
    const onHandle = (dl.handlesOf(sel) || []).some((p) => Math.hypot(p.x - x, p.y - y) <= 8);
    if (!onHandle && dl.hitTest(x, y) !== sel) return;
    if (Date.now() - (this.lockedHintAt || 0) < 8000) return;
    this.lockedHintAt = Date.now();
    this.app.toast(
      this.app.settings.lockDrawings
        ? "All drawings are locked. Unlock them from the lock button on the left."
        : "This drawing is locked. Unlock it from its toolbar to move or resize it.",
    );
  }
  // The time and price at a spot, kept on the price pane, with the magnet as when placing a point.
  dragPoint(p) {
    const ts = this.chart.timeScale(),
      at = { x: Math.max(0, Math.min(ts.width(), p.x)), y: Math.max(0, Math.min(this.chart.panes()[0].getHeight(), p.y)) };
    const time = this.timeOfLogical(ts.coordinateToLogical(at.x)),
      price = this.main.coordinateToPrice(at.y);
    return time == null || price == null ? null : this.snap({ time, price }, at);
  }
  // Pressing on a drawing selects it (as a click does); dragging past a few pixels moves it, or
  // reshapes it from the handle pressed. Moves go a whole bar at a time, as on TradingView.
  drawingDrag(e) {
    if (e.button !== 0 || e.shiftKey || e.defaultPrevented || this.glyphDragging) return;
    const { x, y } = this.plotXY(e),
      u = this.drawingUnder(x, y);
    if (!u) return this.lockedHint(x, y);
    e.preventDefault();
    e.stopPropagation();
    const dl = this.drawings,
      d = u.d;
    if (dl.selected !== d) {
      dl.selected = d;
      dl.update();
    }
    this.chartEl.setPointerCapture(e.pointerId);
    this.setInteractive(false);
    const ts = this.chart.timeScale(),
      l0 = ts.coordinateToLogical(x),
      orig = d.points.map((p) => ({ ...p }));
    const reshape = u.handle >= 0 ? dl.handleDrag(d, u.handle, u.handles) : null;
    let changed = false;
    const move = (m) => {
      const p = this.plotXY(m);
      if (!this.drawDragging && Math.hypot(p.x - x, p.y - y) < 3) return;
      this.drawDragging = true;
      let pts;
      if (reshape) {
        const pt = this.dragPoint(p);
        if (!pt) return;
        pts = reshape(pt, p);
      } else {
        const l1 = ts.coordinateToLogical(p.x);
        if (l0 == null || l1 == null) return;
        const dl1 = Math.round(l1 - l0),
          dy = p.y - y;
        pts = orig.map((q) => {
          const l = this.logicalOf(q.time),
            qy = this.main.priceToCoordinate(q.price);
          return {
            ...q,
            time: l == null ? q.time : (this.timeOfLogical(l + dl1) ?? q.time),
            price: qy == null ? q.price : (this.main.coordinateToPrice(qy + dy) ?? q.price),
          };
        });
      }
      d.points = pts;
      changed = true;
      dl.update();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      this.drawDragging = false;
      this.setInteractive(true);
      if (changed) this.app.saveDrawings(this.drawKey(), dl.items);
      dl.update();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  pointAtXY(e) {
    const r = this.chartEl.getBoundingClientRect(),
      x = e.clientX - r.left - this.plotLeft,
      y = e.clientY - r.top;
    if (x < 0 || x > this.chart.timeScale().width() || y < 0 || y > this.chart.panes()[0].getHeight()) return null;
    const time = this.timeOfLogical(this.chart.timeScale().coordinateToLogical(x)),
      price = this.main.coordinateToPrice(y);
    return time == null || price == null ? null : { time, price };
  }

  applyTheme() {
    this.applySettings();
  }

  // After a change in the chart Settings dialog: chart options, the main series, everything on top.
  applySettings() {
    this.chart.applyOptions(this.themeOptions());
    this.makeMainSeries();
    this.render(false);
    this.extras.refresh();
  }

  // How many bars fit across at a bar spacing.
  barsAcross(spacing = this.cfg.barSpacing || BAR_SPACING) {
    const w = this.chart.timeScale().width() || this.chartEl.clientWidth - 70;
    return Math.max(20, w / spacing);
  }
  // TradingView loads enough history that the lines in the panes below the chart run edge to edge.
  // A feed that stops short (Kraken's free one gives 720 bars) leaves the indicators' first bars
  // (RSI's 14, MACD's 34) blank on the left, so the view stops at the first bar where every one of
  // them has a value: scrolling stops there, and zooming out stops once those bars fill the width.
  clampLeft() {
    if (this.clamping || !this.shown?.length) return;
    const ts = this.chart.timeScale(),
      w = this.replay ? 0 : this.warmup || 0,
      min = w ? Math.max(0.5, ts.width() / (this.shown.length + this.cs.marginRight - w)) : 0.5;
    this.clamping = true;
    try {
      if (Math.abs((ts.options().minBarSpacing ?? 0.5) - min) > 1e-6) ts.applyOptions({ minBarSpacing: min });
      const r = w ? ts.getVisibleLogicalRange() : null;
      if (r && r.from < w - 1e-6) ts.setVisibleLogicalRange({ from: w, to: r.to + w - r.from });
    } finally {
      this.clamping = false;
    }
  }
  noteZoom() {
    if (!(Date.now() - (this.zoomedAt || 0) < 1500)) return;
    const sp = this.chart.timeScale().options().barSpacing;
    if (!(sp > 0) || Math.abs(sp - (this.cfg.barSpacing || BAR_SPACING)) < 0.05) return;
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => {
      this.cfg.barSpacing = Math.round(this.chart.timeScale().options().barSpacing * 100) / 100;
      this.app.persist();
    }, 600);
  }

  resetView() {
    const n = this.shown.length;
    if (!n) return;
    this.chart.timeScale().setVisibleLogicalRange({ from: n - 1 + this.cs.marginRight - this.barsAcross(), to: n - 1 + this.cs.marginRight });
    for (const pn of this.chart.panes())
      try {
        pn.priceScale(this.scaleId).applyOptions({ autoScale: true });
      } catch {
        /* pane without that scale */
      }
  }

  // Up and down by close against open, or against the previous close (a Settings choice).
  isUp(b, prev) {
    return this.cs.prevClose && prev ? b.close >= prev.close : b.close >= b.open;
  }

  makeMainSeries() {
    for (const vp of this.vpPrims || []) { try { this.main?.detachPrimitive(vp); } catch { /* gone */ } }
    this.vpPrims = [];
    this.dropPineDrawings();
    if (this.main) {
      if (this.typePrim) {
        try {
          this.main.detachPrimitive(this.typePrim);
        } catch {
          /* gone */
        }
        this.typePrim = null;
      }
      this.main.detachPrimitive(this.drawings);
      this.chart.removeSeries(this.main);
    }
    if (this.volume) {
      this.chart.removeSeries(this.volume);
      this.volume = null;
    }
    // Colours, the last price label and line, and which scale: all from Settings.
    const cs = this.cs,
      t = UNAVAILABLE[this.cfg.type] || !CHART_TYPES.some(([k]) => k === this.cfg.type) ? "candles" : this.cfg.type;
    const common = {
      priceScaleId: this.scaleId,
      priceLineVisible: !!cs.symLine,
      lastValueVisible: !!(cs.symValue || cs.symName),
      priceLineColor: cs.symLineColor || "",
      priceLineStyle: LINE_STYLE[cs.symLineStyle] ?? 1,
      priceLineWidth: cs.symLineWidth || 1,
      priceFormat: { type: "custom", formatter: (v) => this.formatPrice(v), minMove: 0.01 },
    };
    if (t === "bars")
      this.main = this.chart.addSeries(LW.BarSeries, {
        ...common,
        upColor: cs.barUp,
        downColor: cs.barDown,
        thinBars: !!cs.thinBars,
        openVisible: !cs.hlcBars,
      });
    else if (["line", "linemarkers", "step", "kagi"].includes(t))
      this.main = this.chart.addSeries(LW.LineSeries, {
        ...common,
        color: cs.lineColor,
        lineWidth: cs.lineWidth || 2,
        lineStyle: t === "kagi" ? 0 : LINE_STYLE[cs.lineStyle] ?? 0,
        lineType: t === "step" || t === "kagi" ? 1 : 0,
        pointMarkersVisible: t === "linemarkers",
      });
    else if (t === "area")
      this.main = this.chart.addSeries(LW.AreaSeries, {
        ...common,
        lineColor: cs.areaLine,
        topColor: cs.areaTop,
        bottomColor: cs.areaBottom,
        lineWidth: cs.areaWidth || 2,
      });
    else if (t === "baseline")
      this.main = this.chart.addSeries(LW.BaselineSeries, {
        ...common,
        topLineColor: cs.baseTop,
        bottomLineColor: cs.baseBottom,
        topFillColor1: fade(cs.baseTop, 0.28),
        topFillColor2: fade(cs.baseTop, 0.05),
        bottomFillColor1: fade(cs.baseBottom, 0.05),
        bottomFillColor2: fade(cs.baseBottom, 0.28),
      });
    else if (t === "columns")
      this.main = this.chart.addSeries(LW.HistogramSeries, { ...common });
    else if (CUSTOM_TYPES.includes(t))
      // Volume candles, HLC area, High-low and Session volume profile are drawn in charttypes.js
      this.main = this.chart.addCustomSeries(new StyleSeries(t, this), { ...common });
    else if (t === "hollow")
      // up candles are drawn hollow, so their outline always shows
      this.main = this.chart.addSeries(LW.CandlestickSeries, {
        ...common,
        upColor: CLEAR,
        downColor: cs.body ? cs.bodyDown : CLEAR,
        borderVisible: true,
        borderUpColor: cs.borders ? cs.borderUp : cs.bodyUp,
        borderDownColor: cs.borders ? cs.borderDown : cs.body ? cs.bodyDown : cs.borderDown,
        wickVisible: !!cs.wick,
        wickUpColor: cs.wickUp,
        wickDownColor: cs.wickDown,
      });
    else
      this.main = this.chart.addSeries(LW.CandlestickSeries, {
        ...common,
        upColor: cs.body ? cs.bodyUp : CLEAR,
        downColor: cs.body ? cs.bodyDown : CLEAR,
        borderVisible: !!cs.borders,
        borderUpColor: cs.borderUp,
        borderDownColor: cs.borderDown,
        wickVisible: !!cs.wick,
        wickUpColor: cs.wickUp,
        wickDownColor: cs.wickDown,
      });
    this.main.attachPrimitive(this.drawings);
    if (t === "svp") {
      // the profiles themselves, one per session, from the SVP indicator's drawing
      const sp = new SessionVolumeProfile(this, { period: cs.svpPeriod, rows: cs.svpRows, width: cs.svpWidth, valueArea: cs.svpVA });
      sp.keyOf = periodKey;
      sp.tfSeconds = parseTf(this.cfg.tf).seconds;
      this.main.attachPrimitive(sp);
      this.typePrim = sp;
    }
    this.markers = LW.createSeriesMarkers(this.main, []);
    this.mainType = this.cfg.type;
    this.mainTitle = null;
    this.extras?.attach(this.main);
    this.volUp = fade(cs.bodyUp, 0.45);
    this.volDown = fade(cs.bodyDown, 0.45);
    if (
      !PRICE_ONLY.includes(t) &&
      this.app.settings.volume !== false
    ) {
      this.volume = this.chart.addSeries(LW.HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      this.chart
        .priceScale("vol")
        .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    }
  }

  // ---------- time helpers (drawings, legend, markers all go through these) ----------
  // Bars are kept in UTC. Intraday charts show them in the Settings time zone, each bar with the
  // offset in force at that moment, so daylight saving lands where it should.
  get zone() {
    return zoneOf(this.cs, this.cfg.symbol);
  }
  fromChart(t) {
    return isIntraday(this.cfg.tf) ? chartToUtc(this.zone, t) : t;
  }
  get step() {
    return this.times.length > 1
      ? this.times.at(-1) - this.times.at(-2)
      : parseTf(this.cfg.tf).seconds;
  }
  toChart(t) {
    return isIntraday(this.cfg.tf) ? chartTime(this.zone, t) : t;
  }
  // A chart time as the zone's true wall clock, for labels: the same time except inside the hour the clocks go
  // back, which chartTime squeezes (that hour reads 1:00 to 1:59 twice, as it happened)
  wallOf(t) {
    if (!isIntraday(this.cfg.tf)) return t;
    const u = this.fromChart(t);
    return u + tzOffset(this.zone, u);
  }

  logicalOf(utc) {
    const T = this.times,
      t = this.toChart(utc),
      n = T.length;
    if (!n) return null;
    if (t <= T[0]) return (t - T[0]) / this.step;
    if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / this.step;
    let lo = 0,
      hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    return lo + (t - T[lo]) / (T[hi] - T[lo]);
  }

  timeOfLogical(l) {
    const T = this.times,
      n = T.length;
    if (!n) return null;
    let t;
    if (l <= 0) t = T[0] + l * this.step;
    else if (l >= n - 1) t = T[n - 1] + (l - (n - 1)) * this.step;
    else {
      const i = Math.floor(l);
      t = T[i] + (l - i) * (T[i + 1] - T[i]);
    }
    return this.fromChart(t);
  }

  // The library only places whole bar positions (a fraction comes back as 0), so a time between
  // two bars is placed between their x positions.
  timeToX(utc) {
    const l = this.logicalOf(utc);
    if (l == null) return null;
    const ts = this.chart.timeScale(),
      f = Math.floor(l),
      x0 = ts.logicalToCoordinate(f);
    if (f === l || x0 == null) return x0;
    const x1 = ts.logicalToCoordinate(f + 1);
    return x1 == null ? x0 : x0 + (x1 - x0) * (l - f);
  }

  // The symbol's prices at the Settings precision (Default keeps the app's own rounding).
  formatPrice(v) {
    const p = this.cs.precision;
    if (p !== this.fmtKey) {
      this.fmtKey = p;
      this.fmtFn = precisionFormatter(p);
    }
    if (this.fmtFn) return this.fmtFn(v);
    // a converted price can be tiny (a cheap coin in BTC): its own decimals, past fmtPrice's 8
    if (this.rates && Number.isFinite(v) && Math.abs(v) < 1e-4) return v.toFixed(this.priceDecimals());
    return fmtPrice(v);
  }
  // A chart time (already in the chart's zone) the way the crosshair label shows it.
  formatTime(t) {
    if (typeof t !== "number") return "";
    t = this.wallOf(t);
    const cs = this.cs,
      sec = parseTf(this.cfg.tf).seconds,
      date = fmtDate(t, cs.dateFormat, cs.dayOfWeek);
    return sec < 86400 ? `${date}  ${fmtClock(t, cs.hours === "12", sec < 60)}` : date;
  }
  // Change since the previous session's close (intraday) or the previous bar (daily and up).
  dayChange(i = this.shown.length - 1) {
    const b = this.shown[i];
    if (!b) return null;
    let ref = null;
    if (isIntraday(this.cfg.tf)) {
      const day = Math.floor(this.toChart(b.time) / 86400);
      for (let j = i - 1; j >= 0; j--)
        if (Math.floor(this.toChart(this.shown[j].time) / 86400) < day) {
          ref = this.shown[j].close;
          break;
        }
    } else ref = this.shown[i - 1]?.close;
    return ref > 0 ? { abs: b.close - ref, pct: ((b.close - ref) / ref) * 100 } : null;
  }
  // The name and/or % change beside the last price on the scale (Settings, Scales and lines).
  updateMainTitle() {
    const cs = this.cs;
    let title = cs.symName ? ticker(this.cfg.symbol) : "";
    if (cs.symLabelValue === "percent" && (cs.symValue || cs.symName)) {
      const ch = this.dayChange();
      if (ch) title = `${title}${title ? " " : ""}${ch.pct >= 0 ? "+" : ""}${ch.pct.toFixed(2)}%`;
    }
    if (title !== this.mainTitle) {
      this.mainTitle = title;
      this.main.applyOptions({ title });
    }
  }

  // ---------- data ----------
  async load({ keepView = false } = {}) {
    const token = (this.loadToken = {});
    this.stopLive();
    this.showMsg(`Loading ${ticker(this.cfg.symbol)}…`);
    try {
      const limit = this.app.settings.bars || 3000;
      const r = await api.candles(this.cfg.symbol, this.cfg.tf, limit);
      if (token !== this.loadToken) return;
      this.cfg.symbol = r.symbol;
      this.provider = r.provider;
      this.source = r.source || "";
      this.notes = r.notes || [];
      this.rawBars = r.candles;
      await this.loadRates();
      if (token !== this.loadToken) return;
      this.bars = this.convert(this.rawBars);
      this.mtf = {};
      this.replay = null;
      this.el.querySelector(".replay-bar")?.remove();
      this.drawings.setItems(this.app.getDrawings(this.drawKey()));
      this.showMsg(
        this.bars.length ? "" : "No data for this symbol and timeframe.",
      );
      await this.loadCompare();
      this.render(!keepView);
      this.extras?.refresh();
      this.startLive();
      this.app.onPaneLoaded(this);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.bars = this.rawBars = [];
      this.rates = null;
      this.render(true);
      this.showMsg(
        `Couldn't load ${esc(this.cfg.symbol)} on ${esc(this.cfg.tf)}.\n${esc(e.message)}`,
      );
    }
  }

  // ---------- currency conversion ----------
  // The price scale's currency menu, as on TradingView: the chart in another currency. The provider's
  // bars stay in rawBars (the watchlist, alerts and orders use the symbol's own prices); bars, and
  // everything drawn from them (indicators, the legend, Heikin Ashi...), are in the chart's currency.
  convTo() {
    const own = this.ownCurrency(),
      to = this.cfg.currency;
    return to && own && to !== own && to !== this.convOff ? to : null;
  }
  // The symbol's own currency, when the chart can be converted: not a spread (a ratio of two prices),
  // your own CSV bars, or a Yahoo symbol (its listing's currency isn't known here).
  ownCurrency() {
    return ["SPREAD", "CSV", "YAHOO"].includes(exchange(this.cfg.symbol)) ? "" : quoteCurrency(this.cfg.symbol);
  }
  // Drawings made on a converted chart stay with that currency (TradingView keeps them apart).
  drawKey() {
    const to = this.convTo();
    return to ? `${this.cfg.symbol}@${to}` : this.cfg.symbol;
  }
  async loadRates() {
    this.rates = null;
    this.convOff = null;
    const to = this.convTo(),
      own = this.ownCurrency();
    if (!to || !this.rawBars.length) return;
    try {
      const r = await api.get(`/api/conversion?from=${encodeURIComponent(own)}&to=${encodeURIComponent(to)}&tf=${encodeURIComponent(this.cfg.tf)}&since=${this.rawBars[0].time}`);
      if (!r.rates?.length) throw new Error("no rates came back");
      this.rates = r.rates;
      this.rateEvery = (r.refresh || 60) * 1000;
    } catch (e) {
      // in its own currency for now; the choice stays, so the next load tries again
      this.convOff = to;
      this.app.toast(`Couldn't get ${esc(to)} rates (${esc(e.message)}), so this chart shows ${esc(own)} for now.`, "err");
    }
  }
  // The rate in force at a time: the last one that started by then.
  rateAt(time) {
    const R = this.rates;
    if (!R?.length || R[0].time > time) return null;
    let lo = 0,
      hi = R.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (R[mid].time <= time) lo = mid;
      else hi = mid - 1;
    }
    return R[lo].rate;
  }
  convBar(b, k) {
    return { ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k };
  }
  // Each bar's prices times the rate in force at its close. Bars older than the first rate are left out.
  convert(bars, tf = this.cfg.tf) {
    const R = this.rates;
    if (!R) return bars;
    const sec = parseTf(tf).seconds,
      out = [];
    let j = -1;
    for (const b of bars) {
      while (j + 1 < R.length && R[j + 1].time <= b.time + sec - 1) j++;
      if (j >= 0) out.push(this.convBar(b, R[j].rate));
    }
    return out;
  }
  // Live: the newest rates (see startLive), and the last bar again at the new rate.
  async refreshRates() {
    const to = this.convTo();
    if (!to || !this.rates?.length) return;
    try {
      const own = this.ownCurrency(),
        last = this.rates.at(-1).time;
      const r = await api.get(`/api/conversion?from=${encodeURIComponent(own)}&to=${encodeURIComponent(to)}&tf=${encodeURIComponent(this.cfg.tf)}&since=${last - parseTf(this.cfg.tf).seconds * 3}`);
      if (this.convTo() !== to || !r.rates?.length) return;
      for (const x of r.rates) {
        const R = this.rates;
        if (x.time === R.at(-1).time) R[R.length - 1] = x;
        else if (x.time > R.at(-1).time) R.push(x);
      }
      if (this.rawBars.length) this.merge([this.rawBars.at(-1)]);
    } catch {
      /* keep the last rate */
    }
  }
  // Pick a currency from the price scale's menu (the symbol's own puts it back).
  setCurrency(code) {
    const own = this.ownCurrency();
    this.cfg.currency = code && code !== own ? code : null;
    this.app.persist();
    return this.load({ keepView: true });
  }

  async loadCompare() {
    this.compareData = {};
    await Promise.all(
      this.cfg.compare.map(async (sym) => {
        try {
          this.compareData[sym] = (
            await api.candles(sym, this.cfg.tf, this.app.settings.bars || 3000)
          ).candles;
        } catch {
          this.compareData[sym] = [];
        }
      }),
    );
  }

  showMsg(text) {
    this.msgEl.classList.toggle("hidden", !text);
    this.msgEl.innerHTML = esc(text).replace(/\n/g, "<br>");
  }

  visibleBars() {
    const raw = this.replay
      ? this.bars.slice(0, this.replay.index + 1)
      : this.bars;
    switch (this.cfg.type) {
      case "heikin":
        return heikinAshi(raw);
      case "renko":
        return renko(raw);
      case "linebreak":
        return lineBreak(raw);
      case "range":
        return rangeBars(raw);
      case "kagi":
        return kagi(raw);
      case "pnf":
        return pointFigure(raw);
      default:
        return raw;
    }
  }

  pointFor(b, prev) {
    const time = this.toChart(b.time),
      cs = this.cs;
    switch (this.mainType) {
      case "line":
      case "linemarkers":
      case "step":
      case "area":
      case "baseline":
        return { time, value: b.close };
      case "kagi":
        return { time, value: b.close, color: b.color === "#089981" ? cs.bodyUp : cs.bodyDown };
      case "volcandles":
      case "hlcarea":
      case "highlow":
      case "svp": {
        // the colour sets the last price label's, as on the library's own types
        const up = this.isUp(b, prev),
          color = this.mainType === "hlcarea" ? cs.hlcClose : this.mainType === "highlow" ? cs.hiloColor : up ? cs.bodyUp : cs.bodyDown;
        return { time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0, color };
      }
      case "columns":
        return { time, value: b.close, color: this.isUp(b, prev) ? cs.colUp : cs.colDown };
      default: {
        const pt = { time, open: b.open, high: b.high, low: b.low, close: b.close };
        // "Color bars based on previous close": each bar's colour set on its own
        if (cs.prevClose && prev && this.mainType !== "hollow") {
          const up = b.close >= prev.close;
          if (this.mainType === "bars") pt.color = up ? cs.barUp : cs.barDown;
          else {
            pt.color = cs.body ? (up ? cs.bodyUp : cs.bodyDown) : CLEAR;
            pt.borderColor = up ? cs.borderUp : cs.borderDown;
            pt.wickColor = up ? cs.wickUp : cs.wickDown;
          }
        }
        return pt;
      }
    }
  }

  volPoint(b, prev) {
    return {
      time: this.toChart(b.time),
      value: b.volume || 0,
      color: this.isUp(b, prev) ? this.volUp : this.volDown,
    };
  }

  render(resetView) {
    const prevRange = this.chart.timeScale().getVisibleLogicalRange();
    const atEnd =
      prevRange && this.shown.length && prevRange.to >= this.shown.length - 3;
    if (
      this.mainType !== this.cfg.type ||
      !!this.volume !==
        (!PRICE_ONLY.includes(this.cfg.type) &&
          this.app.settings.volume !== false)
    )
      this.makeMainSeries();
    this.shown = this.visibleBars();
    this.times = this.shown.map((b) => this.toChart(b.time));
    if (this.typePrim) this.typePrim.tfSeconds = parseTf(this.cfg.tf).seconds;
    const last = this.shown.at(-1)?.close || 1;
    const precision = this.rates ? this.priceDecimals() : last >= 100 ? 2 : last >= 1 ? 4 : last >= 0.01 ? 6 : 8,
      pr = this.cs.precision;
    this.main.applyOptions({
      priceFormat: { type: "custom", formatter: (v) => this.formatPrice(v), minMove: pr && pr !== "default" ? minMoveOf(pr) : 1 / 10 ** precision },
    });
    if (this.cfg.type === "baseline" && this.shown.length)
      this.main.applyOptions({
        baseValue: {
          type: "price",
          price: this.shown[Math.max(0, this.shown.length - 150)].close,
        },
      });
    this.main.setData(this.shown.map((b, i) => this.pointFor(b, this.shown[i - 1])));
    this.volume?.setData(this.shown.map((b, i) => this.volPoint(b, this.shown[i - 1])));
    this.chart.applyOptions({
      timeScale: {
        timeVisible: isIntraday(this.cfg.tf),
        secondsVisible: parseTf(this.cfg.tf).seconds < 60,
      },
    });
    this.main.priceScale().applyOptions({
      mode: this.cfg.compare.length
        ? LW.PriceScaleMode.Percentage
        : this.cfg.log
          ? LW.PriceScaleMode.Logarithmic
          : LW.PriceScaleMode.Normal,
      scaleMargins: { top: this.cs.marginTop / 100, bottom: this.cs.marginBottom / 100 },
    });
    this.renderCompare();
    this.renderIndicators();
    this.drawings.update();
    const m = this.cs.marginRight;
    if (resetView && this.shown.length) {
      const keep = this.keepLeft;
      this.keepLeft = null;
      const l0 = keep != null ? this.logicalOf(keep) : null;
      this.chart.timeScale().setVisibleLogicalRange(
        l0 != null && l0 < this.shown.length - 5
          ? { from: Math.max(-m, l0), to: this.shown.length - 1 + m }
          : { from: this.shown.length - 1 + m - this.barsAcross(), to: this.shown.length - 1 + m },
      );
    }
    if (!resetView && this.shown.length && (this.replay || atEnd)) {
      const w = prevRange ? Math.max(20, prevRange.to - prevRange.from) : 160;
      const n = this.shown.length;
      this.chart
        .timeScale()
        .setVisibleLogicalRange({ from: n - 1 + m - w, to: n - 1 + m });
    }
    this.updateMainTitle();
    this.updateLegend();
    this.extras?.update();
    if (!!this.replay !== !!this.wasReplay) {
      this.wasReplay = !!this.replay;
      this.extras?.watermark();
    }
  }

  renderCompare() {
    for (const s of this.compareSeries.values()) this.chart.removeSeries(s);
    this.compareSeries.clear();
    const palette = ["#ff9800", "#e91e63", "#00bcd4", "#8bc34a", "#9c27b0"];
    this.cfg.compare.forEach((sym, k) => {
      const data = (this.compareData?.[sym] || []).filter(
        (b) => !this.replay || b.time <= this.shown.at(-1)?.time,
      );
      const s = this.chart.addSeries(LW.LineSeries, {
        color: palette[k % palette.length],
        lineWidth: 2,
        priceLineVisible: false,
        priceScaleId: this.scaleId,
        priceFormat: { type: "custom", formatter: (v) => fmtPrice(v) },
        title: ticker(sym),
      });
      s.setData(
        data.map((b) => ({ time: this.toChart(b.time), value: b.close })),
      );
      this.compareSeries.set(sym, s);
    });
  }

  // Indicator values for one instance: on the chart's bars, on another indicator's output
  // (source "ind:<uid>:<output>"), or on a higher timeframe mapped back without look-ahead.
  computeIndicator(ind, bars) {
    // XRPL On chain: the XRP Ledger store's buckets for these bars, fetched and kept here
    if (BY_ID[ind.id]?.onchain) {
      const d = this.onchainFor(BY_ID[ind.id].onchain, bars);
      if (!d.rows) return d.error ? { error: d.error } : { pending: true };
      return compute(ind.id, bars, { ...ind.params, __onchain: d });
    }
    // a Pine script reads syminfo and timeframe from the chart it's on
    // a strategy also gets its Properties, and whether the last bar is still forming (live data)
    if (BY_ID[ind.id]?.pine) {
      const forming = !this.replay && bars.length > 0 && bars.at(-1).time + parseTf(this.cfg.tf).seconds > Date.now() / 1000;
      // a testing period inside the chart's bars runs here (and its trades show on the chart); one that
      // starts earlier runs in the Strategy tester's report on more bars
      const rb = rangeBounds(ind.range);
      const range = rb && !rb.all && bars.length && rb.from >= bars[0].time ? { from: rb.from, to: rb.to ?? Infinity } : null;
      ind = { ...ind, params: { ...ind.params, __ctx: { symbol: this.cfg.symbol, tf: ind.tf || this.cfg.tf, forming, ...(ind.props ? { strategy: ind.props } : {}), ...(range ? { range } : {}) } } };
    }
    const src = String(ind.params?.source || "");
    if (ind.tf && ind.tf !== this.cfg.tf) {
      const h = this.mtf[ind.tf];
      if (!h) { this.loadMtf(ind.tf); return { pending: true }; }
      if (h.error) return { error: h.error };
      let hb = h.bars;
      if (this.replay && bars.length) {
        // replay: only higher-timeframe bars that had finished by the replayed bar
        const cEnd = bars.at(-1).time + parseTf(this.cfg.tf).seconds, hs = parseTf(ind.tf).seconds;
        hb = hb.filter((x, j) => (j + 1 < hb.length ? hb[j + 1].time : x.time + hs) <= cEnd);
      }
      if (!hb.length) return {};
      const res = compute(ind.id, hb, src.startsWith("ind:") ? { ...ind.params, source: "close" } : ind.params);
      return mapToChart(res, hb, ind.tf, bars, this.cfg.tf);
    }
    if (src.startsWith("ind:")) {
      const [, uid, key] = src.split(":");
      const vals = this.indResults[uid]?.[key];
      if (!Array.isArray(vals)) return { error: "Its source indicator is missing" };
      const synth = bars.map((x, i) => { const v = vals[i]; return { ...x, open: v, high: v, low: v, close: v }; });
      return compute(ind.id, synth, { ...ind.params, source: "close" });
    }
    return compute(ind.id, bars, ind.params);
  }

  async loadMtf(tf) {
    this.mtfLoading ||= {};
    if (this.mtfLoading[tf]) return;
    this.mtfLoading[tf] = true;
    try {
      if (parseTf(tf).seconds < parseTf(this.cfg.tf).seconds) throw new Error(`Pick a timeframe at or above the chart's (${this.cfg.tf})`);
      const r = await api.candles(this.cfg.symbol, tf, 2000);
      this.mtf[tf] = { bars: this.convert(r.candles, tf), at: Date.now() };
    } catch (e) {
      this.mtf[tf] = { error: e.message, at: Date.now() };
    }
    delete this.mtfLoading[tf];
    this.render(false);
  }

  // XRPL On chain data for this chart: buckets of the bar's length (an hour at most, summed into longer
  // bars), all of them once, then the newest 30 seconds again every 5 seconds (a ledger closes every 3
  // to 4) while the chart reaches the present. While the collector is still filling in the past, all of
  // them again every minute, so older bars fill in too. Big payments come along; the indicators pick their own floor.
  onchainFor(chain, bars) {
    const tf = parseTf(this.cfg.tf).seconds,
      step = Math.min(tf, 3600);
    // 20,000 buckets at most (a seconds chart can hold a few bars from days back): 28 hours at 5s
    const to = bars.at(-1).time + tf,
      start = Math.max(bars[0].time, to - 20000 * step),
      from = start - (start % step);
    this.onchain ||= {};
    let c = this.onchain[chain];
    if (!c || c.step !== step || from < c.from) c = this.onchain[chain] = { step, from, to: from, rows: null, byHash: new Map(), whales: [], at: 0 };
    c.tf = tf;
    if (c.loading) return c;
    if (c.at && c.collector?.toFill > 0 && Date.now() - (c.fullAt || 0) > 60000) this.loadOnchain(chain, c, to, true);
    else if (!c.at || (to > c.to - step && Date.now() - c.at > 5000)) this.loadOnchain(chain, c, to);
    return c;
  }

  // A store time in the chart's zone and clock ("19 Oct '26 4:00 AM"), on a daily chart too (toChart keeps
  // those in UTC)
  onchainTime(utc) {
    const t = utc + tzOffset(this.zone, utc);
    return `${fmtDate(t, this.cs.dateFormat)} ${fmtClock(t, this.cs.hours === "12")}`;
  }
  // When the store's history starts
  onchainSince(c) {
    return c?.first ? this.onchainTime(c.first) : "";
  }

  // On the bars before the store's first ledger, what the legend and the pane say. Not where a seconds
  // chart's fetch stopped short of the store's start (20,000 buckets at most): the store has data there.
  onchainBefore(def) {
    const c = this.onchain?.[def.onchain];
    // XRPL DEX counts from later than the store's start (where the collector began counting it)
    const first = def.onchainFrom ? c?.[def.onchainFrom] : c?.first;
    const what = def.onchainFrom === "dexFirst" ? "DEX" : def.onchain.toUpperCase();
    return first && c.from <= first ? `No ${what} data before ${this.onchainTime(first)}` : "";
  }

  onchainEmptyNote(def, res, bars) {
    const head = this.onchainBefore(def);
    if (!head || res.error || res.pending) return null;
    const starts = def.outputs.map((o) => res[o.key]?.findIndex(Number.isFinite) ?? -1).filter((k) => k >= 0);
    const first = starts.length ? Math.min(...starts) : 0;
    if (first < 1 || first >= bars.length) return null;
    const keep = this.onchain[def.onchain].collector?.keepDays;
    return new EmptyNote(this, first, [head, `The history grows by a day each day${keep ? `, up to ${keep} days` : ""}`]);
  }

  // The "?" on this chart's data: where its history starts, how long it's kept, and how the collector is doing
  onchainLive(def) {
    const c = this.onchain?.[def.onchain];
    if (!c) return [];
    if (!c.first) return [c.reason || "No XRP Ledger data yet."];
    const keep = c.collector?.keepDays,
      st = c.collector;
    const out = [`The history here starts ${this.onchainSince(c)}, and the pane is empty before that. It grows by a day each day${keep ? `, up to ${keep} days` : ""}.`];
    // the shared history (the collector fills in from data.askcharts.pro when it's on)
    const h = st?.history;
    if (h?.error) out.push(`The shared history from ${h.from} couldn't be read last time (${h.error}). The collector fills in ledger by ledger meanwhile.`);
    else if (h?.newest) out.push(`The shared history from ${h.from} is filled in up to ${this.onchainTime(h.newest)}; newer ledgers come straight from the XRP Ledger.`);
    if (st) {
      const quiet = st.updated ? Math.floor((Date.now() - Date.parse(st.updated)) / 60000) : 0;
      out.push(
        !st.connected
          ? "The collector isn't connected right now. New bars fill in once it is."
          : quiet >= 2
            ? `The collector last reported ${quiet} minutes ago. New bars fill in once it's back.`
            : st.behind > 5
              ? `The collector is ${st.behind.toLocaleString("en-US")} ledgers behind and catching up.`
              : st.toFill > 5
                ? `The collector is up to date and still filling in ${st.toFill.toLocaleString("en-US")} older ledgers.`
                : "The collector is up to date.",
      );
    }
    return out;
  }

  async loadOnchain(chain, c, to, full = false) {
    c.loading = true;
    // A new ledger in a rounded close window (10 seconds, 30 at most) moves the window's earlier ledgers
    // back a few seconds, maybe into the bucket before: so from 30 seconds before the newest bucket.
    const since = c.rows?.length && !full ? Math.max(c.from, Math.floor((c.rows.at(-1)[0] - 30) / c.step) * c.step) : c.from;
    try {
      const r = await api.get(`/api/onchain/${chain}?from=${since}&to=${to}&step=${c.step}&min=100000`);
      if (this.onchain?.[chain] !== c) return;
      // the buckets from `since` on come again, grown
      const keep = (c.rows || []).filter((x) => x[0] < since);
      c.rows = [...keep, ...r.buckets];
      for (const w of r.whales) c.byHash.set(w.hash, w);
      c.whales = [...c.byHash.values()].sort((a, b) => a.t - b.t);
      Object.assign(c, { cols: r.cols, reason: r.reason, first: r.first, dexFirst: r.dexFirst ?? null, collector: r.collector, to: Math.max(c.to, to), error: null });
      if (since === c.from) c.fullAt = Date.now();
    } catch (e) {
      c.error = `XRP Ledger data: ${e.message}`;
    } finally {
      c.at = Date.now();
      c.loading = false;
    }
    this.render(false);
    // the ledger moves on whether or not the price does: look again then, while it's on this chart
    clearTimeout(this.onchainTimer);
    if (this.cfg.indicators.some((x) => BY_ID[x.id]?.onchain === chain)) this.onchainTimer = setTimeout(() => this.render(false), 5000);
  }

  dropPineDrawings() {
    for (const [host, prim] of this.pinePrims || []) {
      try {
        host.detachPrimitive(prim);
      } catch {
        /* gone with its series */
      }
    }
    this.pinePrims = [];
  }

  renderIndicators() {
    // a pane's border dragged since the last time: keep that before the panes are rebuilt
    this.keepPaneSizes();
    for (const list of this.indSeries.values())
      for (const s of list) {
        try { this.chart.removeSeries(s); } catch { /* already gone */ }
      }
    this.indSeries.clear();
    for (const vp of this.vpPrims || []) { try { this.main.detachPrimitive(vp); } catch { /* gone with the series */ } }
    this.vpPrims = [];
    this.dropPineDrawings();
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);
    this.paneBuild = (this.paneBuild || 0) + 1;
    this.indResults = {};
    this.mtf ||= {};
    const bars = this.shown, n = bars.length;
    const timeAt = (i) => (i < n ? this.times[i] : this.times[n - 1] + (i - n + 1) * this.step);
    // indicators built on another indicator's output go after their source
    const byUid = new Map(this.cfg.indicators.map((x) => [x.uid, x]));
    const depth = (x, seen = new Set()) => {
      const src = String(x.params?.source || "");
      if (!src.startsWith("ind:") || seen.has(x.uid)) return 0;
      seen.add(x.uid);
      const parent = byUid.get(src.split(":")[1]);
      return parent ? 1 + depth(parent, seen) : 0;
    };
    const ordered = [...this.cfg.indicators].sort((x, y) => depth(x) - depth(y));
    let paneIdx = 0;
    const paneOf = {};
    const markers = [];
    const cs = this.cs;
    this.paneUids = [[]];
    let warm = 0;
    for (const ind of ordered) {
      const def = BY_ID[ind.id];
      if (!def) continue;
      let res;
      try { res = n ? this.computeIndicator(ind, bars) : {}; } catch (e) { res = { error: e.message }; }
      this.indResults[ind.uid] = res;
      if (ind.hidden || this.app.settings.hideIndicators || !n) continue;
      if (!visibleOn(ind, this.cfg.tf)) continue;
      const st = ind.style || {};
      if (res.markers && !ind.tf)
        for (let m of res.markers) {
          // a strategy's trades: Style's Trades on chart, Signal labels and Quantity
          if (m.strat) {
            if (st.trades === false) continue;
            m = { ...m, text: [st.signals !== false ? m.signal : "", st.qty !== false ? m.qty : ""].filter(Boolean).join(" ") };
          }
          const sh = m.plot && st.shapes?.[m.plot];
          if (m.plot && st.off?.[m.plot]) continue;
          markers.push(sh ? { ...m, ...(sh.color ? { color: sh.color } : {}), ...(sh.location ? { position: sh.location } : {}) } : m);
        }
      if (res.volumeProfile) {
        const vp = new VolumeProfile(this, res.volumeProfile);
        this.main.attachPrimitive(vp);
        this.vpPrims.push(vp);
      }
      if (res.sessionProfile) {
        const sp = new SessionVolumeProfile(this, res.sessionProfile);
        sp.keyOf = periodKey;
        sp.tfSeconds = parseTf(this.cfg.tf).seconds;
        this.main.attachPrimitive(sp);
        this.vpPrims.push(sp);
      }
      // a legend-only output (XRPL Activity's ledger number) is read, never drawn
      const outs = def.outputs.filter((o) => Array.isArray(res[o.key]) && !o.legendOnly);
      if (!outs.length) continue;
      const src = String(ind.params?.source || "");
      const parentPane = src.startsWith("ind:") ? paneOf[src.split(":")[1]] : undefined;
      const overlay = ind.overlay ?? def.overlay;
      const pane = parentPane !== undefined ? parentPane : overlay ? 0 : ++paneIdx;
      paneOf[ind.uid] = pane;
      (this.paneUids[pane] ||= []).push(ind.uid);
      const list = [];
      const fmt = this.indFormat(def, ind);
      // a count still adding up (XRPL Activity's Count): the newest bar's segment is faded until it closes
      const tfSec = parseTf(this.cfg.tf).seconds;
      const forming = def.partialNewest?.({ ...defaults(def.id), ...ind.params }) && Date.now() / 1000 < bars[n - 1].time + tfSec;
      for (const out of outs) {
        const color = ind.colors?.[out.key] || out.color;
        // Settings, Scales and lines: "Indicators and financials" labels (name and/or value)
        const opts = {
          ...(def.noAutoscale ? { autoscaleInfoProvider: () => null } : {}),
          priceFormat: def.volumeFormat ? { type: "volume" } : { type: "custom", formatter: fmt, minMove: 10 ** -(this.indPrecision(def, ind)) },
          // an oscillator moved onto the price pane gets its own hidden scale, so the candles keep theirs
          priceScaleId: overlay && !def.overlay ? "" : this.scaleId,
          color,
          priceLineVisible: false,
          lastValueVisible: !!(cs.indValue || cs.indName) && (st.scaleLabels ?? def.scaleLabels) !== false,
          visible: !(st.off?.[out.key] ?? out.off),
          crosshairMarkerVisible: false,
          title: cs.indName ? out.label || "" : "",
        };
        // Style tab: the plot's type and thickness
        const type = st.type?.[out.key] || (out.kind === "histogram" ? "histogram" : out.dots ? "circles" : "line");
        const width = st.width?.[out.key] || out.lineWidth || 1;
        const s = type === "histogram" || type === "columns"
          ? this.chart.addSeries(LW.HistogramSeries, opts, pane)
          : this.chart.addSeries(LW.LineSeries, { ...opts, lineWidth: width, ...(type === "step" ? { lineType: LW.LineType.WithSteps } : {}), ...(type === "circles" || type === "cross" ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1 + width / 2 } : {}) }, pane);
        const vals = res[out.key];
        if (pane) warm = Math.max(warm, vals.slice(0, n).findIndex(Number.isFinite));
        const colorsOf = res.colorsOf?.[out.key];
        s.setData(
          out.kind === "histogram"
            ? histData(vals, colorsOf || res.colors, timeAt, n)
            : def.bridgeGaps && (type === "line" || type === "step")
              ? bridgedLineData(vals, timeAt, n, forming && fade(color, 0.3), res.gaps?.before)
              : lineData(vals, res.breaks, timeAt, n, colorsOf),
        );
        list.push(s);
      }
      // XRPL On chain: the bars before the store's first ledger are empty, and the pane says why
      if (def.onchain && parentPane === undefined) {
        const note = this.onchainEmptyNote(def, res, bars);
        const host = list.find((x) => x.options().visible) || list[0];
        if (note && host) host.attachPrimitive(note);
      }
      // TradingView's shaded band between the levels (RSI's 70 to 30), behind the lines
      if (def.band && parentPane === undefined && list[0]) list[0].attachPrimitive(new BandFill(this, def.band, res[outs[0].key]));
      if (parentPane === undefined)
        // levels, or a Pine script's hline()s with their own colour and style
        (def.hlines || (def.levels || []).map((price) => ({ price }))).forEach((lv, k) => {
          const o = st.hl?.[k] || {};
          if (o.off) return;
          list[0].createPriceLine({ price: lv.price, color: o.color || lv.color || css("--muted"), lineWidth: o.width || lv.width || 1, lineStyle: LINE_STYLE[o.style || lv.style] ?? LW.LineStyle.Dashed, axisLabelVisible: false });
        });
      this.indSeries.set(ind.uid, list);
      // a Pine script's lines, labels, boxes and tables: on the price pane, or on its own pane
      if (res.pineDrawings && !ind.tf) {
        const host = pane === 0 ? this.main : list[0];
        if (host) {
          const prim = new PineDrawings(this, res.pineDrawings, st.objects);
          host.attachPrimitive(prim);
          this.pinePrims.push([host, prim]);
        }
      }
    }
    // the L button on an indicator pane
    this.chart.panes().forEach((pn, i) => {
      if (i && this.cfg.indicators.some((x) => x.log && this.paneUids[i]?.includes(x.uid)))
        pn.priceScale(this.scaleId).applyOptions({ mode: LW.PriceScaleMode.Logarithmic });
    });
    this.applyPaneSizes();
    this.indMarkers = markers;
    // Only a short warm-up against the bars loaded: on a chart that holds the symbol's whole (short)
    // history, a long warm-up stays visible as it is on TradingView, rather than hiding bars.
    this.warmup = warm <= n / 10 ? warm : 0;
    this.clampLeft();
    this.refreshMarkers();
    // the Strategy tester's report follows a strategy's results, and lets go when the last one goes
    const strat = this.cfg.indicators.some((x) => BY_ID[x.id]?.strategy);
    if (strat || this.hadStrategy) this.app.panels?.onStrategies?.(this);
    this.hadStrategy = strat;
  }

  // Indicator markers, the strategy tester's trades and paper fills (the last two follow "Hide
  // positions and orders").
  refreshMarkers() {
    const hide = this.app.settings.hidePositions;
    const all = [...(this.indMarkers || []), ...(hide ? [] : this.extraMarkers), ...(hide ? [] : this.extras?.execMarkers() || [])]
      .map((m) => ({ ...m, time: this.toChart(m.time) }))
      .filter((m) => !this.replay || m.time <= this.times.at(-1));
    all.sort((x, y) => x.time - y.time);
    this.markers.setMarkers(all);
  }

  // A pane's key for its height: the price pane, or the indicator that opened it.
  paneKey(i) {
    return i === 0 ? "price" : this.paneUids?.[i]?.[0] || null;
  }

  // Heights set by dragging a pane's border, as on TradingView: the panes are rebuilt on every live
  // update, so before each rebuild (and before the pane buttons change anything) any open pane whose
  // factor isn't the one last put there was dragged. Every open pane's factor is kept then, by key, in
  // the chart's settings (saved with the layout); an indicator taken off the chart takes its height along.
  keepPaneSizes() {
    const set = this.paneSet,
      panes = this.chart.panes();
    if (!set || set.build !== (this.paneBuild || 0) || set.f.length !== panes.length) return;
    const now = panes.map((pn) => pn.getStretchFactor());
    if (now.every((f, i) => set.shut[i] || Math.abs(f - set.f[i]) < 1e-6)) return;
    const live = new Set(["price", ...this.cfg.indicators.map((x) => x.uid)]);
    const sizes = Object.fromEntries(Object.entries(this.cfg.paneSizes || {}).filter(([k]) => live.has(k)));
    now.forEach((f, i) => {
      const k = this.paneKey(i);
      if (k && !set.shut[i] && f > 0) sizes[k] = Number(f.toFixed(4));
    });
    this.cfg.paneSizes = sizes;
    set.f = now;
    this.app.persist();
  }

  // Pane heights: the price pane, indicator panes (as dragged, or the defaults), and the pane buttons'
  // collapse and maximize.
  applyPaneSizes() {
    this.keepPaneSizes();
    const panes = this.chart.panes(),
      st = (this.paneState ||= { max: null, collapsed: [] });
    if (st.max != null && st.max >= panes.length) st.max = null;
    st.collapsed = st.collapsed.filter((i) => i < panes.length);
    const sizes = this.cfg.paneSizes || {};
    const base = panes.map((_, i) => sizes[this.paneKey(i)] ?? (i === 0 ? 1 : 0.28));
    // The panes' own heights aren't settled here (live updates rebuild the indicator panes, and new
    // ones read 0), so the room is taken from the chart itself.
    let axis = 28;
    try {
      axis = this.chart.timeScale().height() || 28;
    } catch {
      /* not painted yet */
    }
    const H = Math.max(120, this.chartEl.clientHeight - axis);
    const shut = st.max != null ? panes.map((_, i) => i !== st.max) : panes.map((_, i) => st.collapsed.includes(i));
    if (shut.every(Boolean)) shut.fill(false);
    const open = base.reduce((a, f, i) => a + (shut[i] ? 0 : f), 0),
      k = shut.filter(Boolean).length;
    // a closed pane keeps about 26px: room for its scale buttons
    const small = (26 * open) / Math.max(1, H - 26 * k);
    const f = panes.map((_, i) => (shut[i] ? small : base[i]));
    panes.forEach((pn, i) => pn.setStretchFactor(f[i]));
    this.paneSet = { build: this.paneBuild || 0, f, shut };
  }

  // "14 on RSI 14 (1D)": the numeric inputs, what it's built on, and its timeframe.
  // The symbol's decimals, read from its raw prices (not Heikin Ashi or Renko's computed ones).
  priceDecimals() {
    if (this.decFor === this.bars) return this.dec;
    if (this.rates) {
      // converted prices have long expansions: by size instead, about five significant figures
      const v = Math.abs(this.bars.at(-1)?.close || 1);
      this.decFor = this.bars;
      this.dec = Math.max(2, Math.min(12, 4 - Math.floor(Math.log10(v))));
      return this.dec;
    }
    let d = 0;
    for (const b of this.bars.slice(-300))
      for (const v of [b.open, b.high, b.low, b.close]) {
        if (!Number.isFinite(v)) continue;
        const [m, e] = String(v).split("e-");
        const k = (m.split(".")[1] || "").length + (e ? Number(e) : 0);
        if (k > d) d = k;
      }
    this.decFor = this.bars;
    this.dec = Math.min(8, d);
    return this.dec;
  }
  // An indicator's values as TradingView prints them: oscillators with their own decimals (RSI 2),
  // the rest in the symbol's, volume short, and a true minus sign.
  // Style tab, Precision: decimals for one indicator, else its own, else the symbol's
  indPrecision(def, ind) {
    const p = ind?.style?.precision;
    // an indicator can pick its decimals by its inputs (XRPL Activity: one for Per ledger)
    return p !== undefined && p !== "" && Number.isFinite(Number(p)) ? Number(p) : def.precisionOf?.(ind?.params || {}) ?? def.precision ?? this.priceDecimals();
  }
  indFormat(def, ind) {
    if (def.volumeFormat) return (v) => fmtNum(v);
    const dp = this.indPrecision(def, ind);
    // thousands grouped, for counts ("11,242")
    if (def.groupDigits) return (v) => (!Number.isFinite(v) ? "" : v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }).replace(/^-/, "\u2212"));
    return (v) => (!Number.isFinite(v) ? "" : Math.abs(v) >= 1e9 ? fmtNum(v) : v.toFixed(dp).replace(/^-/, "\u2212"));
  }

  // "14 close", "close 12 26 9": the inputs in order, sources by name, as TradingView's status line.
  indicatorParamsLabel(ind) {
    const def = BY_ID[ind.id];
    if (!def) return "";
    const nums = (def.inputs || [])
      // TradingView's status line leaves out a Pine script's true/false inputs
      .filter((x) => !(def.pine && (x.type === "bool" || x.type === "color" || (x.options?.length === 2 && x.options[0] === "true" && x.options[1] === "false"))))
      .filter((x) => x.status !== false && !(x.type === "source" && String(ind.params?.[x.key] ?? x.default).startsWith("ind:")))
      .map((x) => {
        const v = ind.params?.[x.key] ?? x.default;
        if (x.type !== "time") return v;
        return v ? new Date(v * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "pick a bar";
      })
      .join(" ");
    const src = String(ind.params?.source || "");
    let on = "";
    if (src.startsWith("ind:")) {
      const parent = this.cfg.indicators.find((x) => x.uid === src.split(":")[1]);
      const pd = parent && BY_ID[parent.id];
      on = pd ? ` on ${(/\(([^)]+)\)$/.exec(pd.name)?.[1].split(" / ")[0] || pd.name)} ${this.indicatorParamsLabel(parent)}` : " on (missing)";
    }
    return `${nums}${on}${ind.tf && ind.tf !== this.cfg.tf ? ` (${ind.tf})` : ""}`;
  }

  // ---------- legend ----------
  onCrosshair(p) {
    if (this.app.tool !== "cursor" && this.drawings.temp && p.point && !this.freehand) {
      const pt = this.pointAt(p);
      if (pt) {
        this.drawings.temp.points[this.drawings.temp.points.length - 1] = pt;
        this.drawings.update();
      }
    }
    const i =
      p.logical != null && p.point
        ? Math.max(0, Math.min(this.shown.length - 1, Math.round(p.logical)))
        : null;
    this.updateLegend(i);
    if (this.app.settings.syncCrosshair && p.time && p.point)
      this.app.syncCrosshair(this, p);
  }

  updateLegend(index = null) {
    const n = this.shown.length,
      cs = this.cs;
    const i = index ?? n - 1;
    const b = this.shown[i],
      prev = this.shown[i - 1],
      sym = this.cfg.symbol,
      f = (v) => this.formatPrice(v);
    // Settings, Status line: logo, title, market status, values, changes and volume
    const t = ticker(sym),
      name = cs.titleMode === "symbol" ? null : this.app.symbolName?.(sym);
    const label = !name || cs.titleMode === "symbol" ? t : cs.titleMode === "both" ? `${t} · ${name}` : name;
    let html = '<div class="row">';
    if (cs.logo) html += badge(sym);
    // the title's tooltip says where a stored chart's bars came from (Settings, Crypto data)
    if (cs.title) html += `<span class="title" data-act="symbol"${this.source ? ` title="${esc(this.source)}"` : ""}>${esc(`${label} · ${this.cfg.tf} · ${this.provider || exchange(sym)}`)}</span>`;
    const mkt = cs.marketStatus && marketState(sym, tzOffset);
    if (mkt) html += `<span class="lg-dot ${mkt.cls}" title="${esc(mkt.tip)}"></span>`;
    if (b) {
      const cls = this.isUp(b, prev) ? "up" : "down";
      if (cs.chartValues)
        html += `<span class="ohlc ${cls}"><span><b>O</b>${f(b.open)}</span><span><b>H</b>${f(b.high)}</span><span><b>L</b>${f(b.low)}</span><span><b>C</b>${f(b.close)}</span></span>`;
      if (cs.barChange && prev) {
        const ch = b.close - prev.close;
        html += `<span class="${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "+" : "−"}${f(Math.abs(ch))} (${fmtPct((ch / prev.close) * 100)})</span>`;
      }
      if (cs.legendVolume && b.volume) html += `<span class="lg-vol"><b>Vol</b> ${fmtNum(b.volume)}</span>`;
      const day = cs.lastDayChange && this.dayChange(i);
      if (day) html += `<span class="lg-day ${day.abs >= 0 ? "up" : "down"}" title="Change since the previous day's close"><b>1D</b> ${day.abs >= 0 ? "+" : "−"}${f(Math.abs(day.abs))} (${fmtPct(day.pct)})</span>`;
    }
    html += "</div>";
    let rest = "";
    for (const sym of this.cfg.compare) {
      rest += `<div class="row ind" data-compare="${esc(sym)}"><span class="name">${esc(ticker(sym))} (compare)</span><span class="acts"><button data-act="rmcompare" title="Remove">${ICON.x}</button></span></div>`;
    }
    // An indicator drawn in a pane of its own has its row there, at the pane's top left (as on
    // TradingView); hidden ones, ones still loading and ones with an error stay up here.
    const paneOf = {};
    (this.paneUids || []).forEach((uids, k) => {
      if (k) for (const u of uids) paneOf[u] = k;
    });
    const paneRows = {};
    for (const ind of this.cfg.indicators) {
      const def = BY_ID[ind.id];
      if (!def) continue;
      const res = this.indResults[ind.uid] || {};
      const params = this.indicatorParamsLabel(ind);
      const fmtI = this.indFormat(def, ind);
      // XRPL On chain: a ledger closes every 3 to 4 seconds, so on a seconds chart many bars hold none, the
      // newest often among them. Off the crosshair the legend shows the newest bar with ledgers (not
      // values that come and go); on a bar with none, inside the data, it says so.
      let at = i,
        none = false,
        outage = false,
        before = "";
      if (def.onchain && !res.error && !res.pending) {
        const has = (j) => def.outputs.some((o) => Number.isFinite(res[o.key]?.[j]));
        if (index == null) while (at > 0 && !has(at)) at--;
        else if (!has(i)) {
          outage = !!res.gaps?.outage?.[i];
          none = def.outputs.some((o) => res[o.key]?.slice(0, i).some(Number.isFinite));
          if (!none) before = this.onchainBefore(def);
        }
      }
      const vals = res.error
        ? `<span class="down">${esc(res.error)}</span>`
        : res.pending
          ? '<span class="muted">loading…</span>'
          : outage
            ? '<span class="muted">No data here: the collector wasn\'t running</span>'
          : none
            ? '<span class="muted">No ledger closed in this bar</span>'
            : before
              ? `<span class="muted">${esc(before)}</span>`
            : def.outputs
              .map((o) => {
                const v = res[o.key]?.[at];
                if (!Number.isFinite(v)) return "";
                const c = ind.colors?.[o.key] || o.color;
                // XRPL On chain's several counts read better named: "Money 12 Markets 40"
                // a whole-number output (a ledger number) stays whole whatever the indicator's decimals
                const t = o.integer ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : fmtI(v);
                return def.labelValues ? `<span style="color:${c}">${esc(o.label)} ${t}</span>` : `<span style="color:${c}">${t}</span>`;
              })
              // named values get a faint bar between them ("Money 3,318 | Markets 11,209")
              .filter((s) => !def.labelValues || s)
              .join(def.labelValues ? '<span class="lg-sep">|</span>' : " ") +
            // XRPL On chain: a bar with a hole of its own (the collector stopped or started inside it)
            (res.gaps?.partial?.[at] ? '<span class="lg-sep">|</span><span class="muted">some ledgers missing</span>' : "") +
            // an indicator's own word on a bar (XRPL DEX: the bar its counting began in)
            (res.barNote?.[at] ? `<span class="lg-sep">|</span><span class="muted">${esc(res.barNote[at])}</span>` : "");
      const short =
        /\(([^)]+)\)$/.exec(def.name)?.[1].split(" / ")[0] || def.name;
      // Settings, Status line: indicator titles, their inputs, values and the row background
      const ist = ind.style || {};
      const title = cs.indTitles ? `<span class="name">${esc(short)}${cs.indInputs && ist.statusInputs !== false && params ? ` ${esc(params)}` : ""}</span>` : "";
      const shownVals = (cs.indValues && ist.statusValues !== false) || res.error ? `<span class="vals">${vals}</span>` : "";
      // an indicator that explains itself (XRPL Activity) gets a "?" after its name
      const info = def.info ? `<button class="ind-info" data-act="info" aria-label="What this shows and how it counts">?</button>` : "";
      // TradingView's buttons: hide, settings, source code (when there's source to show), remove, more
      const source = this.sourceOf(ind) ? `<button data-act="source" title="Source code">${ICON.braces}</button>` : "";
      const acts = `<button data-act="hide" title="${ind.hidden ? "Show" : "Hide"}">${ind.hidden ? ICON.eyeOff : ICON.eye}</button><button data-act="settings" title="Settings">${ICON.hexGear}</button>${source}<button data-act="remove" title="Remove">${ICON.trash}</button><button data-act="more" title="More">${ICON.more}</button>`;
      const off = !visibleOn(ind, this.cfg.tf);
      const rowHtml = `<div class="row ind${cs.legendBg ? " bg" : ""}${this.selectedInd === ind.uid ? " sel" : ""}" data-uid="${ind.uid}" style="${ind.hidden || off ? "opacity:.45" : ""}"${off ? ' title="Not shown on this interval (Settings, Visibility)"' : ""}>${title}${info}${shownVals}<span class="acts">${acts}</span></div>`;
      const k = !ind.hidden && !res.error && !res.pending ? paneOf[ind.uid] : undefined;
      if (k) paneRows[k] = (paneRows[k] || "") + rowHtml;
      else rest += rowHtml;
    }
    for (const note of this.notes || [])
      rest += `<div class="row note">${esc(note)}</div>`;
    this.legendEl.style.setProperty("--lg-bg", `${cs.legendBg ? cs.legendBgOpacity : 0}%`);
    this.legendEl.querySelector(".lg-main").innerHTML = html;
    this.legendEl.querySelector(".lg-rest").innerHTML = rest;
    // one legend per indicator pane
    const have = new Map([...this.el.querySelectorAll(":scope > .lg-pane")].map((el) => [Number(el.dataset.pane), el]));
    for (const [k, el] of have)
      if (!paneRows[k]) {
        el.remove();
        have.delete(k);
      }
    for (const [k, rows] of Object.entries(paneRows)) {
      let el = have.get(Number(k));
      if (!el) {
        el = document.createElement("div");
        el.className = "legend lg-pane";
        el.dataset.pane = k;
        el.onclick = (e) => this.onLegendClick(e);
        el.onpointerover = (e) => this.onInfoHover(e, true);
        el.onpointerout = (e) => this.onInfoHover(e, false);
        this.el.appendChild(el);
      }
      el.style.setProperty("--lg-bg", `${cs.legendBg ? cs.legendBgOpacity : 0}%`);
      if (el.innerHTML !== rows) el.innerHTML = rows;
    }
    this.placePaneLegends();
    this.legendEl.onclick = (e) => this.onLegendClick(e);
    this.legendEl.onpointerover = (e) => this.onInfoHover(e, true);
    this.legendEl.onpointerout = (e) => this.onInfoHover(e, false);
    this.app.panels?.onLegend?.(this, index);
  }

  // Each indicator pane's legend sits at that pane's top left (hidden when the pane is too small).
  placePaneLegends() {
    const els = this.el.querySelectorAll(":scope > .lg-pane");
    if (!els.length) return;
    const top0 = this.el.getBoundingClientRect().top,
      panes = this.chart.panes();
    for (const el of els) {
      const r = panes[Number(el.dataset.pane)]?.getHTMLElement?.()?.getBoundingClientRect();
      const show = !!r && r.height >= 18;
      el.hidden = !show;
      if (show) el.style.top = `${Math.round(r.top - top0 + 4)}px`;
    }
  }

  // Pine scripts and custom indicators have source to show; built-in ones don't.
  sourceOf(ind) {
    if (String(ind.id).startsWith("pine:")) return this.app.state.pineScripts?.[ind.id.slice(5)] ? { pine: ind.id.slice(5) } : null;
    if (String(ind.id).startsWith("custom:")) return { custom: `${ind.id.slice(7)}.js` };
    return null;
  }

  onLegendClick(e) {
    const btn = e.target.closest("[data-act]");
    // a click on an indicator's row selects it (outlined, buttons kept), as on TradingView
    const row = e.target.closest(".row.ind[data-uid]");
    if (!btn && row) {
      this.selectedInd = this.selectedInd === row.dataset.uid ? null : row.dataset.uid;
      if (e.detail === 2) {
        this.selectedInd = row.dataset.uid;
        const ind = this.cfg.indicators.find((x) => x.uid === row.dataset.uid);
        if (ind && this.app.settings.lockIndicators) this.app.toast("Indicators are locked. Unlock them from the lock button on the left.");
        else if (ind) this.app.openIndicatorSettings(this, ind);
      }
      return this.updateLegend();
    }
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "symbol") return this.app.openSymbolSearch();
    if (act === "rmcompare") {
      this.cfg.compare = this.cfg.compare.filter(
        (s) => s !== btn.closest("[data-compare]").dataset.compare,
      );
      this.app.persist();
      return this.load({ keepView: true });
    }
    const uid = btn.closest("[data-uid]")?.dataset.uid;
    const ind = this.cfg.indicators.find((x) => x.uid === uid);
    if (!ind) return;
    if (act === "info") return this.indicatorInfo(btn, ind);
    if (this.app.settings.lockIndicators && ["remove", "hide", "settings"].includes(act))
      return this.app.toast("Indicators are locked. Unlock them from the lock button on the left.");
    if (act === "source") return this.openSource(ind);
    if (act === "more") return this.indicatorMenu(btn, ind);
    if (act === "remove") this.removeIndicator(uid);
    if (act === "hide") {
      ind.hidden = !ind.hidden;
      this.render(false);
      this.app.persist();
    }
    if (act === "settings") this.app.openIndicatorSettings(this, ind);
  }

  // Source code: a Pine script opens in the Pine Editor, a custom indicator in the Indicator editor.
  openSource(ind) {
    const src = this.sourceOf(ind);
    if (src?.pine) {
      this.app.panels.showSide("pine");
      this.app.pineEditor.openScript(src.pine);
    } else if (src?.custom) this.app.panels.editCustom(src.custom);
  }

  // The "?" beside an indicator that explains itself: what it shows and how it counts, each kind in the
  // colour of its line. The popover closes on a click anywhere else.
  // The "?" opens on hover with a mouse (a tap opens it as a click does). It closes once the mouse has
  // left both the "?" and the explanation, unless a click pinned it open; a click elsewhere closes it.
  onInfoHover(e, over) {
    const q = e.target.closest?.(".ind-info");
    if (!q || e.pointerType !== "mouse" || q.contains(e.relatedTarget)) return;
    clearTimeout(this.infoTimer);
    if (!over) return this.infoHoverEnd();
    const uid = q.closest("[data-uid]")?.dataset.uid;
    if (this.infoPop?.uid === uid && this.app.drawToolbar.pop === this.infoPop.pop) return;
    this.infoTimer = setTimeout(() => {
      // the legend may have been redrawn meanwhile: the "?" now on screen
      const btn = q.isConnected ? q : this.el.querySelector(`.row.ind[data-uid="${uid}"] .ind-info`);
      const ind = this.cfg.indicators.find((x) => x.uid === uid);
      if (btn && ind && btn.matches(":hover")) this.indicatorInfo(btn, ind, true);
    }, 150);
  }

  infoHoverEnd() {
    clearTimeout(this.infoTimer);
    this.infoTimer = setTimeout(() => {
      const s = this.infoPop,
        tb = this.app.drawToolbar;
      if (s && !s.pinned && tb.pop === s.pop && !s.pop.matches(":hover")) tb.closePopover();
    }, 250);
  }

  indicatorInfo(btn, ind, hover = false) {
    const def = BY_ID[ind.id],
      info = def?.info,
      tb = this.app.drawToolbar;
    if (!info) return;
    clearTimeout(this.infoTimer);
    tb.closePopover();
    const colorOf = (k) => ind.colors?.[k] || def.outputs.find((o) => o.key === k)?.color || "inherit";
    const labelOf = (k) => def.outputs.find((o) => o.key === k)?.label || k;
    const rows = info.rows.map(([k, text]) => `<dt style="color:${colorOf(k)}">${esc(labelOf(k))}</dt><dd>${esc(text)}</dd>`).join("");
    // XRPL On chain: this chart's own history and the collector's state close the last section
    const last = info.sections.length - 1;
    const body = info.sections
      .map(([head, ps], k) => `<div class="ii-head">${esc(head)}</div>${[...ps, ...(k === last && def.onchain ? this.onchainLive(def) : [])].map((t) => `<p class="ii-note">${esc(t)}</p>`).join("")}`)
      .join("");
    // never over the "?" itself (it would take the click meant for the "?"): no taller than the room
    // above or below it, whichever is bigger; the rest scrolls
    const r = btn.getBoundingClientRect(),
      room = Math.max(160, Math.floor(Math.max(r.top, innerHeight - r.bottom) - 40));
    const pop = tb.openPopover(btn, `<div class="ind-info-pop" style="max-height:${room}px"><div class="ii-title">${esc(info.title)}</div><p>${esc(info.lead)}</p><dl>${rows}</dl>${body}</div>`, "indinfo");
    this.infoPop = { uid: ind.uid, pop, pinned: !hover };
    pop.addEventListener("pointerenter", () => clearTimeout(this.infoTimer));
    pop.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && this.infoHoverEnd());
  }

  // More (the three dots): the rest of TradingView's indicator menu that applies here.
  indicatorMenu(btn, ind) {
    const def = BY_ID[ind.id];
    if (!def) return;
    const tb = this.app.drawToolbar;
    const locked = !!this.app.settings.lockIndicators;
    const name = /\(([^)]+)\)$/.exec(def.name)?.[1].split(" / ")[0] || def.name;
    const fav = indicatorFavs(this.app).includes(ind.id);
    const overlay = ind.overlay ?? def.overlay;
    const alertable = def.outputs?.length && !def.pine && !def.onchain && !String(ind.params?.source || "").startsWith("ind:") && !(ind.tf && ind.tf !== this.cfg.tf);
    const item = (k, label, { dis = "", hint = "" } = {}) => `<button data-m="${k}" ${dis ? `disabled title="${esc(dis)}"` : hint ? `title="${esc(hint)}"` : ""}><span>${label}</span></button>`;
    const html = [
      item("alert", `Add alert on ${esc(name)}…`, { dis: alertable ? "" : def.pine ? "Alerts run on the server, which doesn't run Pine scripts yet" : def.onchain ? "Alerts on XRPL On chain aren't built yet" : "Alerts need an indicator on this chart's own timeframe" }),
      "<hr>",
      item("settings", "Settings…", { dis: locked ? "Indicators are locked" : "" }),
      this.sourceOf(ind) ? item("source", "Source code") : "",
      item("visibility", "Intervals visibility…", { dis: locked ? "Indicators are locked" : "" }),
      item("move", overlay ? "Move to new pane below" : "Move to the price pane", { dis: locked ? "Indicators are locked" : String(ind.params?.source || "").startsWith("ind:") ? "It follows the indicator it's built on" : "" }),
      item("fav", fav ? "Remove from favorites" : "Add to favorites"),
      "<hr>",
      item("hide", ind.hidden ? "Show" : "Hide", { dis: locked ? "Indicators are locked" : "" }),
      item("remove", "Remove", { dis: locked ? "Indicators are locked" : "" }),
    ].join("");
    const pop = tb.openPopover(btn, html, "ind-more");
    pop.classList.add("dtb-list", "ind-more");
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 4)}px`;
    pop.onclick = (e) => {
      const b = e.target.closest("[data-m]");
      if (!b || b.disabled) return;
      tb.closePopover();
      const m = b.dataset.m;
      if (m === "alert") {
        const right = this.indResults[ind.uid]?.[def.outputs[0].key]?.findLast?.(Number.isFinite);
        return this.app.panels.openAlertDialog({ rules: [{ left: { kind: "ind", id: ind.id, params: { ...(ind.params || {}) }, uid: ind.uid, output: def.outputs[0].key }, op: "crosses", right: { kind: "value", v: Number.isFinite(right) ? Number(right.toPrecision(6)) : 0 } }] });
      }
      if (m === "settings") return this.app.openIndicatorSettings(this, ind);
      if (m === "visibility") return this.app.openIndicatorSettings(this, ind, "visibility");
      if (m === "source") return this.openSource(ind);
      if (m === "move") {
        const to = !overlay;
        ind.overlay = to === !!def.overlay ? undefined : to;
      } else if (m === "fav") {
        const f = indicatorFavs(this.app);
        this.app.settings.indicatorFavs = fav ? f.filter((x) => x !== ind.id) : [...f, ind.id];
      } else if (m === "hide") ind.hidden = !ind.hidden;
      else if (m === "remove") return this.removeIndicator(ind.uid);
      this.render(false);
      this.app.persist();
    };
  }

  // ---------- indicators ----------
  addIndicator(id, params = {}) {
    const uid = newUid();
    const d = this.app.settings.indDefaults?.[id];
    const ind = { uid, id, params: { ...(d?.params || {}), ...params } };
    for (const k of ["colors", "style", "vis", "props"]) if (d?.[k]) ind[k] = structuredClone(d[k]);
    this.cfg.indicators.push(ind);
    this.render(false);
    this.app.persist();
    return uid;
  }
  removeIndicator(uid) {
    this.cfg.indicators = this.cfg.indicators.filter((x) => x.uid !== uid);
    this.render(false);
    this.app.persist();
  }

  // ---------- drawing tools ----------
  pointAt(p) {
    if (p.paneIndex) return null; // drawings live on the price pane only
    if (!p.point || p.logical == null) return null;
    const logical =
      this.chart.timeScale().coordinateToLogical(p.point.x) ?? p.logical;
    const price = this.main.coordinateToPrice(p.point.y);
    const time = this.timeOfLogical(logical);
    return price == null || time == null ? null : this.snap({ time, price }, p.point);
  }

  // The magnet: pull a point onto the nearest open, high, low or close of the bar under it (and
  // onto overlay indicator lines, if chosen). Weak only within a short reach; strong always.
  snap(pt, at) {
    const s = this.app.settings;
    if (!s.magnetOn || !at) return pt;
    const l = Math.round(this.chart.timeScale().coordinateToLogical(at.x) ?? NaN),
      bar = this.shown[l];
    if (!bar) return pt;
    const vals = [bar.open, bar.high, bar.low, bar.close];
    if (s.magnetIndicators)
      for (const ind of this.cfg.indicators) {
        const def = BY_ID[ind.id];
        if (!def?.overlay || ind.hidden) continue;
        for (const o of def.outputs) {
          const v = this.indResults[ind.uid]?.[o.key]?.[l];
          if (Number.isFinite(v)) vals.push(v);
        }
      }
    let best = null,
      gap = Infinity;
    for (const v of vals) {
      const y = this.main.priceToCoordinate(v);
      if (y != null && Math.abs(y - at.y) < gap) {
        gap = Math.abs(y - at.y);
        best = v;
      }
    }
    if (best == null || (s.magnetMode !== "strong" && gap > 14)) return pt;
    return { time: bar.time, price: best };
  }

  // Measure stays on screen until the next click or Esc; Zoom in zooms to the marked span (Zoom
  // out on the left goes back).
  finishEphemeral(item) {
    const d = this.drawings;
    this.app.setTool("cursor");
    if (item.type === "ruler") {
      d.ruler = item;
      this.rulerAt = Date.now();
    } else {
      // Zoom in, as on TradingView: the box's bars across and its prices up and down (the price scale
      // then stops auto scaling, as TradingView's does). A box under 4 px tall zooms the time only.
      const ts = this.chart.timeScale(),
        ps = this.main.priceScale(),
        [l0, l1] = item.points.map((q) => this.logicalOf(q.time)).sort((x, y) => x - y);
      if (Number.isFinite(l0) && Number.isFinite(l1) && l1 - l0 >= 2) {
        const prices = this.zoomPrices(item.points);
        (this.zoomStack ||= []).push({ time: ts.getVisibleLogicalRange(), auto: ps.options().autoScale, price: ps.getVisibleRange() });
        ts.setVisibleLogicalRange({ from: l0, to: l1 });
        if (prices) this.setPriceRange(prices);
      }
      this.app.refreshDrawbar();
    }
    d.update();
  }

  // The price scale range that puts the zoom box's top and bottom where the scale's visible range ends
  // (inside its top and bottom margins), in the scale's own units. On a normal or log scale those are
  // the box's own prices; comparing (percent), they're worked out from where the box sits on screen.
  zoomPrices(points) {
    const ps = this.main.priceScale(),
      h = this.chart.panes()[0].getHeight(),
      ys = points.map((q) => this.main.priceToCoordinate(q.price));
    if (!h || !ys.every(Number.isFinite) || Math.abs(ys[0] - ys[1]) < 4) return null;
    const o = ps.options();
    if (o.mode === LW.PriceScaleMode.Normal || o.mode === LW.PriceScaleMode.Logarithmic) {
      const from = Math.min(...points.map((q) => q.price)),
        to = Math.max(...points.map((q) => q.price));
      return from < to && (o.mode === LW.PriceScaleMode.Normal || from > 0) ? { from, to } : null;
    }
    const vr = ps.getVisibleRange();
    if (!vr) return null;
    const m = o.scaleMargins || { top: 0.1, bottom: 0.08 },
      top = m.top * h,
      bottom = (1 - m.bottom) * h,
      at = (y) => vr.to + ((y - top) / (bottom - top)) * (vr.from - vr.to);
    const to = at(Math.min(...ys)),
      from = at(Math.max(...ys));
    return Number.isFinite(from) && Number.isFinite(to) && from < to ? { from, to } : null;
  }
  // Show this price range on the main price scale (auto scale goes off). The library reads a range
  // back in prices but takes one on a log scale in its own units, log10(price + c) + k, where k and c
  // come from the price span on screen now (Lightweight Charts' logFormulaForPriceRange).
  setPriceRange({ from, to }) {
    const ps = this.main.priceScale();
    if (ps.options().mode !== LW.PriceScaleMode.Logarithmic) return ps.setVisibleRange({ from, to });
    const vr = ps.getVisibleRange(),
      span = vr ? Math.abs(vr.to - vr.from) : 1,
      k = span >= 1 || span < 1e-15 ? 4 : 4 + Math.ceil(Math.abs(Math.log10(span))),
      c = 10 ** -k,
      lib = (v) => Math.sign(v) * (Math.log10(Math.abs(v) + c) + k);
    ps.setVisibleRange({ from: lib(from), to: lib(to) });
  }

  onClick(p) {
    const tool = this.app.tool;
    if (tool === "anchor-pick") {
      const pick = this.app.pendingAnchor;
      const ind = pick?.pane === this && this.cfg.indicators.find((x) => x.uid === pick.uid);
      const pt = this.pointAt(p);
      if (!ind || !pt) return;
      // Snap to the raw bar under the click (works on Renko/Heikin Ashi too).
      let i = this.bars.findIndex((b) => b.time > pt.time) - 1;
      if (i < 0) i = this.bars.length - 1;
      ind.params = { ...ind.params, [pick.key]: this.bars[i].time };
      this.app.pendingAnchor = null;
      this.app.setTool("cursor");
      this.render(false);
      this.app.persist();
      this.app.toast("Anchored.");
      return;
    }
    if (tool === "replay-pick") {
      const pt = this.pointAt(p);
      if (!pt) return;
      // map the clicked time back to the raw bars (works for Renko/Heikin Ashi too)
      let i = this.bars.findIndex((b) => b.time > pt.time) - 1;
      if (i < 0) i = this.bars.length - 1;
      this.app.setTool("cursor");
      this.startReplay(Math.max(1, i));
      return;
    }
    if (tool === "eraser") {
      // the eraser removes the drawing under the click (unless it's locked)
      const hit = p.point && this.drawings.hitTest(p.point.x, p.point.y);
      if (!hit) return;
      if (this.app.isLocked(hit)) return this.app.toast("That drawing is locked.");
      this.drawings.items = this.drawings.items.filter((x) => x !== hit);
      if (this.drawings.selected === hit) this.drawings.selected = null;
      this.app.saveDrawings(this.drawKey(), this.drawings.items);
      this.drawings.update();
      return;
    }
    if (tool === "cursor") {
      // a click clears a finished measurement (not the click that finished it)
      if (this.drawings.ruler && Date.now() - (this.rulerAt || 0) > 350) {
        this.drawings.ruler = null;
        this.drawings.update();
        return;
      }
      if (!p.point) return;
      this.drawings.selected = this.drawings.hitTest(p.point.x, p.point.y);
      this.drawings.update();
      return;
    }
    const def = TOOL_BY_ID[tool];
    const pt = this.pointAt(p);
    if (!def || !pt || def.freehand) return;
    const d = this.drawings;
    // points: 0 is an open-ended path: click on, then click the last point again (a double-click)
    // or press Enter to finish.
    const open = !def.points;
    if (!d.temp) {
      d.temp = { id: newUid(), type: tool, points: [pt], ...this.app.drawingDefaults(tool), ...(def.ephemeral ? {} : this.ownTag()) };
      if (open || def.points > 1) d.temp.points.push({ ...pt });
    } else if (open) {
      const P = d.temp.points;
      const near = (q) => {
        const qx = q && this.timeToX(q.time), qy = q && this.main.priceToCoordinate(q.price);
        return qx != null && qy != null && p.point && Math.hypot(qx - p.point.x, qy - p.point.y) < 6;
      };
      // A polyline closes when you click its first point again (kept as a repeat of it).
      if (def.closable && P.length >= 4 && near(P[0])) {
        P[P.length - 1] = { ...P[0] };
        P.push({ ...P[0] });
        return this.finishOpenDrawing();
      }
      if (near(P[P.length - 2])) return this.finishOpenDrawing();
      P[P.length - 1] = pt;
      P.push({ ...pt });
    } else {
      d.temp.points[d.temp.points.length - 1] = pt;
      if (d.temp.points.length < def.points) d.temp.points.push({ ...pt });
      else d.temp.done = true;
    }
    if (def.points === 1) d.temp.done = true;
    if (d.temp.done) {
      const item = d.temp;
      delete item.done;
      d.temp = null;
      if (def.ephemeral) return this.finishEphemeral(item);
      d.items.push(item);
      d.selected = item;
      this.app.saveDrawings(this.drawKey(), d.items);
      // text tools start typing, Image asks for a file, Post and Idea for a link
      this.app.drawToolbar?.afterPlace(this, item);
      if (!this.app.settings.stayInDrawMode) this.app.setTool("cursor");
    }
    d.update();
  }

  // Ends an open-ended path being drawn (Enter, Esc or a double-click); fewer than two points
  // throws it away. Returns false when there was none.
  finishOpenDrawing() {
    const d = this.drawings,
      t = d.temp;
    if (!t || TOOL_BY_ID[t.type]?.points !== 0) return false;
    this.finishedAt = Date.now();
    t.points.pop();
    d.temp = null;
    if (t.points.length >= 2) {
      d.items.push(t);
      d.selected = t;
      this.app.saveDrawings(this.drawKey(), d.items);
    }
    d.update();
    if (!this.app.settings.stayInDrawMode) this.app.setTool("cursor");
    return true;
  }

  deleteSelectedDrawing() {
    const d = this.drawings;
    if (!d.selected) return false;
    if (this.app.isLocked(d.selected)) {
      this.app.toast("Unlock the drawing to remove it.");
      return true;
    }
    d.items = d.items.filter((x) => x !== d.selected);
    d.selected = null;
    d.update();
    this.app.saveDrawings(this.drawKey(), d.items);
    return true;
  }

  clearDrawings() {
    this.drawings.items = [];
    this.drawings.selected = null;
    this.drawings.temp = null;
    this.drawings.update();
    this.app.saveDrawings(this.drawKey(), []);
  }

  setInteractive(on) {
    this.chart.applyOptions({ handleScroll: on, handleScale: on });
    if (on && this.drawings.temp) {
      this.drawings.temp = null;
      this.drawings.update();
    }
  }

  // ---------- live updates ----------
  startLive() {
    this.stopLive();
    if (this.replay || !this.bars.length) return;
    // every 30 seconds with a coin involved, every 5 minutes between currencies
    if (this.rates) this.rateTimer = setInterval(() => this.refreshRates(), this.rateEvery || 60000);
    const ex = exchange(this.cfg.symbol);
    const wsTf = BINANCE_WS_TF[this.cfg.tf];
    if (ex === "BINANCE" && this.provider === "Binance" && wsTf)
      this.openSocket(ticker(this.cfg.symbol).toLowerCase(), wsTf, 0);
    else if (ex === "BINANCE" && this.provider === "Binance futures" && wsTf && wsTf !== "1s")
      this.openSocket(ticker(this.cfg.symbol).toLowerCase().replace(/\.p$/, ""), wsTf, 0, ["wss://fstream.binance.com/ws/"]);
    else this.poll();
  }

  openSocket(sym, interval, hostIdx, hosts = [
    "wss://stream.binance.com:9443/ws/",
    "wss://data-stream.binance.vision/ws/",
  ]) {
    if (hostIdx >= hosts.length) return this.poll();
    let opened = false;
    const ws = new WebSocket(`${hosts[hostIdx]}${sym}@kline_${interval}`);
    this.ws = ws;
    ws.onopen = () => {
      opened = true;
      this.app.setStatus("ok");
    };
    ws.onmessage = (m) => {
      const k = JSON.parse(m.data).k;
      if (k)
        this.merge([
          {
            time: k.t / 1000,
            open: +k.o,
            high: +k.h,
            low: +k.l,
            close: +k.c,
            volume: +k.v,
          },
        ]);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!opened) this.openSocket(sym, interval, hostIdx + 1, hosts);
      else this.liveTimer = setTimeout(() => this.startLive(), 3000);
    };
  }

  poll() {
    // Second charts poll every second; the server's cache keeps that to one upstream call.
    const kind = parseTf(this.cfg.tf).seconds < 60
      ? 1000
      : ["BINANCE", "COINBASE", "KRAKEN"].includes(exchange(this.cfg.symbol))
        ? 3000
        : 10000;
    const tick = async () => {
      try {
        const r = await api.candles(this.cfg.symbol, this.cfg.tf, 5);
        this.merge(r.candles);
      } catch {
        /* keep trying */
      }
      this.liveTimer = setTimeout(tick, kind);
    };
    this.liveTimer = setTimeout(tick, kind);
  }

  stopLive() {
    clearTimeout(this.liveTimer);
    this.liveTimer = null;
    clearInterval(this.rateTimer);
    this.rateTimer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
  }

  merge(newBars) {
    if (!this.bars.length || this.replay) return;
    // A one-second poll can bring more than one new bar; each needs its time and its candle.
    const touched = [],
      sep = this.rawBars !== this.bars,
      sec = parseTf(this.cfg.tf).seconds;
    for (const raw of newBars) {
      const last = this.bars.at(-1),
        b = this.rates ? this.convBar(raw, this.rateAt(raw.time + sec - 1) ?? this.rates.at(-1).rate) : raw;
      if (b.time === last.time) {
        this.bars[this.bars.length - 1] = b;
        if (sep) this.rawBars[this.rawBars.length - 1] = raw;
        touched.push(b);
      } else if (b.time > last.time) {
        this.bars.push(b);
        if (sep) this.rawBars.push(raw);
        touched.push(b);
      }
    }
    if (!touched.length) return;
    // the watchlist, alerts and orders get the symbol's own price
    this.app.onPrice(this.cfg.symbol, this.rawBars.at(-1).close);
    const simple = [
      "candles",
      "hollow",
      "bars",
      "line",
      "linemarkers",
      "step",
      "area",
      "baseline",
      "columns",
      "volcandles",
      "hlcarea",
      "highlow",
      "svp",
    ].includes(this.cfg.type);
    if (simple) {
      this.shown = this.bars;
      for (const b of touched) {
        if (this.times.at(-1) !== this.toChart(b.time))
          this.times.push(this.toChart(b.time));
        const prev = this.bars[this.bars.lastIndexOf(b) - 1];
        this.main.update(this.pointFor(b, prev));
        this.volume?.update(this.volPoint(b, prev));
      }
    }
    const now = Date.now();
    if (now - (this.mtfCheckedAt || 0) > 60000) {
      this.mtfCheckedAt = now;
      for (const [tf, h] of Object.entries(this.mtf || {})) if (now - h.at > 60000) this.loadMtf(tf);
    }
    if (!simple || now - (this.lastFull || 0) > 1500) {
      this.lastFull = now;
      if (simple) {
        this.renderIndicators();
        this.updateLegend();
      } else this.render(false);
    }
    this.updateMainTitle();
    this.extras?.update();
  }

  // ---------- bar replay ----------
  startReplay(index) {
    if (this.convTo()) return this.app.toast(`Bar Replay isn't available while the chart is shown in ${this.convTo()}. Switch the price scale back to ${this.ownCurrency()} first.`);
    this.stopLive();
    this.replay = {
      index: Math.max(1, Math.min(index, this.bars.length - 1)),
      playing: false,
      speed: 2,
    };
    let bar = this.el.querySelector(".replay-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "replay-bar";
      bar.innerHTML = `<span class="hint">Replay</span>
        <button data-r="back" title="Step back">&#9664;&#9664;</button>
        <button data-r="play" title="Play / pause">&#9654;</button>
        <button data-r="fwd" title="Step forward">&#9654;&#9654;</button>
        <select data-r="speed" title="Speed"><option value="0.5">0.5x</option><option value="1">1x</option><option value="2" selected>2x</option><option value="5">5x</option><option value="10">10x</option></select>
        <button data-r="pick" title="Pick a new start bar">Jump to…</button>
        ${this.app.panes.length > 1 ? `<label class="hint" title="Replay every chart in the layout to the same moment"><input type="checkbox" data-r="sync" ${this.app.settings.syncReplay ? "checked" : ""}> All charts</label>` : ""}
        <button data-r="exit" title="Back to live">Exit</button>`;
      this.el.appendChild(bar);
      bar.addEventListener("click", (e) => {
        const r = e.target.closest("[data-r]")?.dataset.r;
        if (r === "back") this.replayStep(-1);
        if (r === "fwd") this.replayStep(1);
        if (r === "play") this.toggleReplay();
        if (r === "pick") this.app.setTool("replay-pick");
        if (r === "exit") this.stopReplay();
      });
      const sync = bar.querySelector('[data-r="sync"]');
      if (sync)
        sync.onchange = (e) => {
          this.app.settings.syncReplay = e.target.checked;
          this.app.persist();
          if (e.target.checked) this.app.onReplayStart?.(this);
          else this.app.onReplayStop?.(this, { keepSelf: true });
        };
      bar.querySelector('[data-r="speed"]').onchange = (e) => {
        this.replay.speed = Number(e.target.value);
        if (this.replay.playing) {
          this.toggleReplay();
          this.toggleReplay();
        }
      };
    }
    this.render(false);
    this.app.onReplayStart?.(this);
  }

  // Follow another chart's replay: show only the bars that had finished by `endTime`.
  replayTo(endTime) {
    if (this.convTo()) return; // no replay in a converted currency
    const sec = parseTf(this.cfg.tf).seconds;
    let i = this.bars.length - 1;
    while (i > 0 && this.bars[i].time + sec > endTime) i--;
    if (!this.replay) {
      this.stopLive();
      this.replay = { index: i, playing: false, speed: 2, follower: true };
      this.el.querySelector(".replay-bar")?.remove();
      const tag = document.createElement("div");
      tag.className = "replay-bar follower";
      tag.innerHTML = '<span class="hint">Synced replay</span>';
      this.el.appendChild(tag);
    } else this.replay.index = i;
    this.render(false);
  }

  replayStep(dir) {
    if (!this.replay) return;
    const next = this.replay.index + dir;
    if (next < 1 || next >= this.bars.length) {
      if (this.replay.playing) this.toggleReplay();
      return;
    }
    this.replay.index = next;
    this.render(false);
    this.app.onReplayBar?.(this, this.bars[next]);
  }

  toggleReplay() {
    if (!this.replay) return;
    this.replay.playing = !this.replay.playing;
    clearInterval(this.replayTimer);
    if (this.replay.playing)
      this.replayTimer = setInterval(
        () => this.replayStep(1),
        1000 / this.replay.speed,
      );
    const btn = this.el.querySelector('[data-r="play"]');
    if (btn)
      btn.innerHTML = this.replay.playing ? "&#10074;&#10074;" : "&#9654;";
  }

  stopReplay() {
    clearInterval(this.replayTimer);
    const wasFollower = this.replay?.follower;
    this.replay = null;
    this.el.querySelector(".replay-bar")?.remove();
    this.render(true);
    this.startLive();
    if (!wasFollower) this.app.onReplayStop?.(this);
  }

  // ---------- export ----------
  // Settings, Trading: paper positions, orders and fills go into the image only when chosen.
  async screenshot() {
    const hid = this.extras.beforeShot();
    if (hid) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const canvas = this.chart.takeScreenshot(true);
    if (hid) this.extras.afterShot();
    const ctx = canvas.getContext("2d");
    const k = canvas.width / Math.max(1, this.chartEl.clientWidth);
    ctx.save();
    ctx.scale(k, k);
    this.extras.paintBoxes(ctx, this.chartEl.getBoundingClientRect());
    ctx.restore();
    ctx.font = "600 14px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = css("--text");
    ctx.fillText(`${ticker(this.cfg.symbol)} · ${this.cfg.tf}`, 12, 22);
    return canvas;
  }

  destroy() {
    this.extras?.destroy();
    this.stopLive();
    clearInterval(this.replayTimer);
    clearTimeout(this.onchainTimer);
    this.chart.remove();
  }
}
