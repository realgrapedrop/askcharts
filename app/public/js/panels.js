// Side panel (watchlist, alerts, calendar) and bottom panel (tester, screener, heatmap, paper, editor).
import {
  api,
  download,
  esc,
  fetchStepUp,
  fmtPrice,
  fmtPct,
  fmtNum,
  ticker,
  exchange,
} from "./api.js";
import { INDICATORS, BY_ID, registerIndicator } from "../lib/indicators.js";
import { renderNews, renderSeasonals, renderFinancials } from "./research.js";
import { mountQuantChecks } from "./quantui.js";
import { StrategyReport, strategiesOn } from "./strategyreport.js";
import {
  backtest,
  tradesCsv,
  EXAMPLE_STRATEGIES,
  OPS,
  magnifierTf,
} from "../lib/backtest.js";
import { parseTf } from "../lib/series.js";
import { TOOL_BY_ID } from "./drawings.js";
import { playSound, zoneOf, tzOffset, fmtClock } from "./chartsettings.js";
import { openAlertDialog as openAlertCard, isChannel, isMoving } from "./alertdialog.js";
import { PRODUCTS, SOCIAL, ALL_PRODUCTS, DEFAULT_FAVORITES } from "./products.js";

const $ = (s, el = document) => el.querySelector(s);
const LW = window.LightweightCharts;
const css = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();


// ---------- operand picker (shared by tester, alerts, screener scans) ----------
const PRICE = [
  "close",
  "open",
  "high",
  "low",
  "volume",
  "hl2",
  "hlc3",
  "ohlc4",
];
const OP_LABEL = {
  ">": "is above",
  "<": "is below",
  ">=": "is at or above",
  "<=": "is at or below",
  crossesAbove: "crosses above",
  crossesBelow: "crosses below",
  crosses: "crosses",
  enteringChannel: "enters the channel",
  exitingChannel: "exits the channel",
  insideChannel: "is inside the channel",
  outsideChannel: "is outside the channel",
  movingUp: "moves up by",
  movingDown: "moves down by",
  movingUpPct: "moves up % by",
  movingDownPct: "moves down % by",
};
const outputsOf = (def) => [
  ...def.outputs.map((o) => o.key),
  ...(def.id === "supertrend" ? ["direction"] : []),
];
const mainInput = (def) =>
  (def.inputs || []).find((i) => i.type === "int" || i.type === "float");

function operandHtml(o) {
  const val =
    o.kind === "line"
      ? "l"
      : o.kind === "value"
        ? "v"
        : o.kind === "price"
          ? `p:${o.field}`
          : `i:${o.id}`;
  const opts = [
    o.kind === "line" ? `<option value="l" selected>${esc(o.label || "Drawn line")}</option>` : "",
    `<optgroup label="Price">${PRICE.map((f) => `<option value="p:${f}" ${val === `p:${f}` ? "selected" : ""}>${f === "close" ? "Price (close)" : f}</option>`).join("")}</optgroup>`,
    `<option value="v" ${val === "v" ? "selected" : ""}>Value</option>`,
    `<optgroup label="Indicators">${INDICATORS.filter((d) => d.outputs.length)
      .map(
        (d) =>
          `<option value="i:${esc(d.id)}" ${val === `i:${d.id}` ? "selected" : ""}>${esc(d.name)}</option>`,
      )
      .join("")}</optgroup>`,
  ].join("");
  let extra = "";
  if (o.kind === "value")
    extra = `<input class="num" data-v type="number" step="any" value="${esc(o.v ?? 0)}">`;
  if (o.kind === "ind") {
    const def = BY_ID[o.id];
    const mi = def && mainInput(def);
    if (mi)
      extra += `<input class="num" data-p="${esc(mi.key)}" type="number" step="any" title="${esc(mi.label)}" value="${esc(o.params?.[mi.key] ?? mi.default)}">`;
    const outs = def ? outputsOf(def) : [];
    if (outs.length > 1)
      extra += `<select data-out>${outs.map((k) => `<option ${k === o.output ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>`;
  }
  const lineData = o.kind === "line" ? ` data-line="${esc(JSON.stringify(o.line))}" data-label="${esc(o.label || "Drawn line")}"` : "";
  return `<span class="operand"${lineData}><select data-kind>${opts}</select>${extra}</span>`;
}

function readOperand(span) {
  const k = span.querySelector("[data-kind]").value;
  if (k === "l") return { kind: "line", line: JSON.parse(span.dataset.line), label: span.dataset.label };
  if (k === "v")
    return {
      kind: "value",
      v: Number(span.querySelector("[data-v]")?.value || 0),
    };
  if (k.startsWith("p:")) return { kind: "price", field: k.slice(2) };
  const id = k.slice(2),
    def = BY_ID[id];
  const params = {};
  const p = span.querySelector("[data-p]");
  if (p) params[p.dataset.p] = Number(p.value);
  return {
    kind: "ind",
    id,
    params,
    output: span.querySelector("[data-out]")?.value || outputsOf(def)[0],
  };
}

function ruleHtml(r) {
  return `<div class="rule">${operandHtml(r.left)}<select data-op>${OPS.map((o) => `<option value="${o}" ${o === r.op ? "selected" : ""}>${OP_LABEL[o]}</option>`).join("")}</select>${operandHtml(r.right)}<button class="x" title="Remove">&times;</button></div>`;
}

function bindRules(container, onChange = () => {}) {
  container.addEventListener("change", (e) => {
    const span = e.target.closest(".operand");
    if (span && e.target.matches("[data-kind]")) {
      const k = e.target.value;
      const o =
        k === "v"
          ? { kind: "value", v: 0 }
          : k.startsWith("p:")
            ? { kind: "price", field: k.slice(2) }
            : {
                kind: "ind",
                id: k.slice(2),
                params: {},
                output: outputsOf(BY_ID[k.slice(2)])[0],
              };
      span.outerHTML = operandHtml(o);
    }
    onChange();
  });
  container.addEventListener("click", (e) => {
    if (e.target.matches(".rule .x")) {
      e.target.closest(".rule").remove();
      onChange();
    }
  });
}

const readRules = (container) =>
  [...container.querySelectorAll(".rule")].map((r) => {
    const ops = r.querySelectorAll(".operand");
    return {
      left: readOperand(ops[0]),
      op: r.querySelector("[data-op]").value,
      right: readOperand(ops[1]),
    };
  });

function compileRules(groups) {
  const indicators = {};
  const ref = (o) => {
    if (o.kind === "line") return { line: o.line };
    if (o.kind === "value") return Number(o.v);
    if (o.kind === "price") return o.field;
    const key = `${o.id}_${Object.values(o.params || {}).join("_")}`.replace(
      /[^a-z0-9_]/gi,
      "_",
    );
    indicators[key] = { id: o.id, params: o.params || {} };
    return `${key}.${o.output}`;
  };
  const out = { indicators };
  for (const [name, rules] of Object.entries(groups))
    out[name] = rules.map((r) => ({
      left: ref(r.left),
      op: r.op,
      right: ref(r.right),
    }));
  return out;
}

function toOperand(x, indicators) {
  if (x && typeof x === "object" && x.line) return { kind: "line", line: x.line, label: "Drawn line" };
  if (typeof x === "number") return { kind: "value", v: x };
  if (PRICE.includes(x)) return { kind: "price", field: x };
  const [k, out] = String(x).split(".");
  const s = indicators[k];
  const def = BY_ID[s?.id];
  if (!def) return { kind: "value", v: 0 };
  return {
    kind: "ind",
    id: s.id,
    params: { ...(s.params || {}) },
    output: out || s.output || outputsOf(def)[0],
  };
}

const defaultRule = () => ({
  left: { kind: "price", field: "close" },
  op: "crossesAbove",
  right: { kind: "ind", id: "ema", params: { length: 50 }, output: "value" },
});

// ==========================================================================================
export function initPanels(app) {
  const side = $("#sideBody"),
    bottom = $("#bottomBody"),
    bottomEl = $("#bottom");
  // The right side works like TradingView's: an icon rail, and a click on an icon opens its panel
  // or, if it's already open, folds the panel away so the charts get the room. A narrow screen
  // starts folded and the panel floats over the chart.
  const sideEl = $("#side"),
    rail = $("#rail");
  const saved = app.settings.sidePanel;
  let sideTab = window.innerWidth <= 900 ? null : saved === undefined ? "watchlist" : saved || null,
    bottomTab = "tester";
  const P = {};

  // ---------- the right toolbar ----------
  // Watchlist, Alerts and Object tree at the top; at the bottom the starred products, the Products
  // menu (star or unstar each one) and Help. Each button has TradingView's dark tooltip to its left.
  const favorites = () => (Array.isArray(app.settings.railFavorites) ? app.settings.railFavorites : DEFAULT_FAVORITES);
  const svg28 = (body) => `<svg viewBox="0 0 28 28">${body}</svg>`;
  const openProduct = (p) => (p.panel ? showSide(p.panel, true) : showBottom(p.bottom));
  function renderRail() {
    const box = rail.querySelector("#railFavs");
    if (!box) return;
    const favs = favorites();
    box.innerHTML = ALL_PRODUCTS.filter((p) => favs.includes(p.id))
      .map((p) => `<button ${p.panel ? `data-panel="${p.panel}"` : `data-bottom="${p.bottom}"`} data-tip="${esc(p.tip || p.label)}">${svg28(p.icon)}${p.id === "notifications" ? '<span class="rail-badge" hidden></span>' : ""}</button>`)
      .join("");
    rail.querySelectorAll("[data-panel]").forEach((b) => b.classList.toggle("active", b.dataset.panel === sideTab));
    if (typeof updateBadge === "function") updateBadge();
  }
  rail.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    hideRailTip();
    if (b.dataset.panel) return showSide(b.dataset.panel, true);
    if (b.dataset.bottom) return showBottom(b.dataset.bottom);
    if (b.dataset.act === "products") return productsMenu(b);
  };
  let railTip = null,
    railReopen = null;
  const hideRailTip = () => {
    railTip?.remove();
    railTip = null;
  };
  rail.addEventListener("pointerover", (e) => {
    const b = e.target.closest("button[data-tip]");
    if (!b || railTip?._for === b) return;
    hideRailTip();
    railTip = document.createElement("div");
    railTip.className = "tv-tip";
    railTip.textContent = b.dataset.tip;
    document.body.appendChild(railTip);
    const r = b.getBoundingClientRect();
    railTip.style.left = `${Math.max(4, r.left - railTip.offsetWidth - 8)}px`;
    railTip.style.top = `${Math.round(r.top + r.height / 2 - railTip.offsetHeight / 2)}px`;
    railTip._for = b;
  });
  rail.addEventListener("pointerout", (e) => {
    const b = e.target.closest("button[data-tip]");
    if (b && !b.contains(e.relatedTarget)) hideRailTip();
  });
  // A second click on Tools or Help closes its menu (the menu's own outside click closes it first).
  window.addEventListener(
    "pointerdown",
    (e) => {
      const b = e.target.closest?.("#rail [data-act]");
      railReopen = b && app.drawToolbar?.pop?.dataset.for === `rail-${b.dataset.act}` ? b.dataset.act : null;
    },
    true,
  );
  // TradingView's rail menus: dark, flush against the toolbar, their bottom level with the last button's.
  const railMenu = (btn, html, act) => {
    const tb = app.drawToolbar;
    if (railReopen === act) return null;
    tb.closePopover();
    const pop = tb.openPopover(btn, html, `rail-${act}`);
    // sized as it will show (the .pm rows and rules) before it is placed
    pop.classList.add("rail-menu", "pm");
    const rr = rail.getBoundingClientRect(),
      last = rail.querySelector('[data-act="products"]').getBoundingClientRect();
    pop.style.maxHeight = `${innerHeight - 8}px`;
    pop.style.left = `${Math.max(4, rr.left - pop.offsetWidth - 2)}px`;
    pop.style.top = `${Math.max(4, Math.min(last.bottom - pop.offsetHeight, innerHeight - pop.offsetHeight - 4))}px`;
    return pop;
  };
  const STAR = '<svg viewBox="0 0 18 18"><path d="M9 1.8l2.2 4.6 5 .7-3.6 3.5.9 5L9 13.2l-4.5 2.4.9-5L1.8 7.1l5-.7z"/></svg>';
  function productsMenu(btn) {
    const favs = favorites();
    const row = (p) =>
      `<div class="pm-row"><button class="pm-open" data-open="${p.id}">${svg28(p.icon)}<span>${esc(p.label)}</span>${p.id === "notifications" ? '<span class="pm-badge" hidden></span>' : ""}</button><button class="pm-star${favs.includes(p.id) ? " on" : ""}" data-star="${p.id}" title="${favs.includes(p.id) ? "Remove from the toolbar" : "Add to the toolbar"}">${STAR}</button></div>`;
    const pop = railMenu(btn, `<div class="pm-h">Products</div>${PRODUCTS.map(row).join("")}<hr><div class="pm-h">Social</div>${SOCIAL.map(row).join("")}`, "products");
    if (!pop) return;
    updateBadge();
    pop.onclick = (e) => {
      const star = e.target.closest("[data-star]");
      if (star) {
        // a star adds the product to the toolbar or takes it off; the menu stays open
        const id = star.dataset.star,
          cur = favorites();
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        app.settings.railFavorites = ALL_PRODUCTS.map((p) => p.id).filter((x) => next.includes(x));
        app.persist();
        star.classList.toggle("on", next.includes(id));
        star.title = next.includes(id) ? "Remove from the toolbar" : "Add to the toolbar";
        renderRail();
        return;
      }
      const id = e.target.closest("[data-open]")?.dataset.open;
      const p = ALL_PRODUCTS.find((x) => x.id === id);
      if (!p) return;
      app.drawToolbar.closePopover();
      openProduct(p);
    };
  }
  // The Pine Editor gets a wider panel of its own (and can fill most of the window).
  const clampWidth = (w) => Math.round(sideTab === "pine" ? Math.min(Math.max(w, 360), Math.max(420, innerWidth - 300)) : Math.min(Math.max(w, 260), 560));
  const applyWidth = () =>
    sideEl.style.setProperty("--side-w", `${sideTab === "pine" ? (app.pineEditor?.maxed ? Math.max(600, innerWidth - 420) : clampWidth(app.settings.pineWidth || 560)) : clampWidth(app.settings.sideWidth || 340)}px`);
  applyWidth();
  $("#sideResize").onpointerdown = (e) => {
    e.preventDefault();
    const grip = e.currentTarget,
      x0 = e.clientX,
      w0 = sideEl.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("drag");
    grip.onpointermove = (m) => sideEl.style.setProperty("--side-w", `${clampWidth(w0 + x0 - m.clientX)}px`);
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      grip.classList.remove("drag");
      if (sideTab === "pine" && app.pineEditor) app.pineEditor.maxed = false;
      app.settings[sideTab === "pine" ? "pineWidth" : "sideWidth"] = clampWidth(sideEl.getBoundingClientRect().width);
      app.persist();
    };
  };
  // The bottom panel's height: drag its top edge, as on TradingView. The charts keep at least 160px.
  const clampHeight = (h) => Math.round(Math.min(Math.max(h, 160), Math.max(200, (bottomEl.parentElement?.getBoundingClientRect().height || innerHeight) - 200)));
  const applyHeight = () => {
    if (app.settings.bottomHeight) bottomEl.style.setProperty("--bottom-h", `${clampHeight(app.settings.bottomHeight)}px`);
  };
  applyHeight();
  addEventListener("resize", applyHeight);
  $("#bottomResize").onpointerdown = (e) => {
    if (bottomEl.classList.contains("collapsed")) return;
    e.preventDefault();
    const grip = e.currentTarget,
      y0 = e.clientY,
      h0 = bottomEl.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("drag");
    grip.onpointermove = (m) => bottomEl.style.setProperty("--bottom-h", `${clampHeight(h0 + y0 - m.clientY)}px`);
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      grip.classList.remove("drag");
      app.settings.bottomHeight = clampHeight(bottomEl.getBoundingClientRect().height);
      app.persist();
    };
  };
  $("#bottomTabs").onclick = (e) => {
    const t = e.target.closest("[data-tab]")?.dataset.tab;
    if (t) showBottom(t, true);
  };
  $("#bottomToggle").onclick = () => {
    bottomEl.classList.toggle("collapsed");
    if (!bottomEl.classList.contains("collapsed")) renderBottom();
  };

  // `save` keeps the choice for the next visit (the rail, and closing the Pine Editor, do).
  function showSide(t, fromRail = false, save = fromRail) {
    if (fromRail && t === sideTab) t = null;
    closeMenu();
    sideTab = t;
    applyWidth();
    sideEl.classList.toggle("collapsed", !t);
    rail
      .querySelectorAll("[data-panel]")
      .forEach((b) => b.classList.toggle("active", b.dataset.panel === t));
    if (t) renderSide();
    else side.innerHTML = "";
    if (save) {
      app.settings.sidePanel = t || "";
      app.persist();
    }
  }
  function showBottom(t, toggle = false) {
    if (
      toggle &&
      t === bottomTab &&
      !bottomEl.classList.contains("collapsed")
    ) {
      bottomEl.classList.add("collapsed");
      return;
    }
    bottomTab = t;
    bottomEl.classList.remove("collapsed");
    document
      .querySelectorAll("#bottomTabs [data-tab]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    renderBottom();
  }
  const renderSide = () =>
    ({
      watchlist: renderWatchlist,
      alerts: renderAlerts,
      objects: renderObjects,
      calendar: renderCalendar,
      pine: () => app.pineEditor.mount(side),
      copilot: () => app.copilot.mount(side),
      notifications: renderNotifications,
      news: () => {
        side.innerHTML = '<div class="sp-head"><span class="sp-name">News</span></div><div id="newsBody"></div>';
        renderNews($("#newsBody"), app);
      },
    })[sideTab]();
  const renderBottom = () => {
    if (bottomTab !== "tester") report.destroy();
    if (!bottomEl.classList.contains("collapsed"))
      ({
        tester: renderTester,
        screener: renderScreener,
        heatmap: renderHeatmap,
        seasonals: () => renderSeasonals(bottom, app),
        financials: () => renderFinancials(bottom, app),
        paper: renderPaper,
        editor: renderEditor,
      })[bottomTab]();
  };

  // ======================= WATCHLIST =======================
  let quotes = {};
  function wlSymbols() {
    return app.state.watchlists[app.state.activeWatchlist] || [];
  }

  // "Add symbol": search as you type, filter by kind, + on each row (TradingView's pattern). A click
  // adds and keeps the dialog open for the next one; Shift + click or Shift + Enter adds and closes.
  // A row already in the list shows a tick, and clicking it takes the symbol out again.
  const ADD_KINDS = [
    ["all", "All", null],
    ["stocks", "Stocks", ["stock", "stocks", "equity"]],
    ["funds", "Funds", ["etf", "mutualfunds", "mutualfund", "fund"]],
    ["futures", "Futures", ["futures", "future"]],
    ["forex", "Forex", ["forex", "currency", "commodity"]],
    ["crypto", "Crypto", ["crypto", "cryptocurrency"]],
    ["indices", "Indices", ["index"]],
  ];
  const ICON_ADD = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  const ICON_IN = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
  function openAddSymbol(initial = "") {
    let kind = "all",
      results = [],
      rows = [],
      sel = 0,
      timer,
      seq = 0;
    const card = app.modal(
      "Add symbol",
      `<input class="search-in" id="asQ" placeholder="Symbol or company name" autocomplete="off" value="${esc(initial)}"><div class="as-kinds" id="asKinds">${ADD_KINDS.map(([k, label]) => `<button data-kind="${k}" class="${k === kind ? "on" : ""}">${label}</button>`).join("")}</div><div class="list as-list" id="asList"></div>`,
      {
        wide: true,
        foot: `<span class="hint-text" style="margin-right:auto">Adding to <b>${esc(app.state.activeWatchlist)}</b>. Click to add and keep searching; Shift + Click or Shift + Enter adds and closes.</span>`,
      },
    );
    const q = card.querySelector("#asQ"),
      box = card.querySelector("#asList");
    const draw = () => {
      const types = ADD_KINDS.find(([k]) => k === kind)[2];
      const v = q.value.trim().toUpperCase();
      const rank = (r) => {
        const t = ticker(r.symbol).toUpperCase();
        return t === v ? 0 : t.startsWith(v) ? 1 : 2;
      };
      rows = results
        .map((r, i) => [r, i])
        .filter(([r]) => !types || types.includes(String(r.type || "").toLowerCase()))
        .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
        .map(([r]) => r);
      sel = Math.min(sel, Math.max(rows.length - 1, 0));
      const have = new Set(wlSymbols());
      box.innerHTML =
        rows
          .map((r, i) => {
            const isIn = have.has(r.symbol);
            return `<div class="item ${i === sel ? "sel" : ""}" data-i="${i}"><span class="as-sym"><b>${esc(ticker(r.symbol))}</b> <span class="muted">${esc(r.name || "")}</span></span><span class="meta">${esc(r.type || "")} · ${esc(r.exchange || "")}</span><span class="as-add ${isIn ? "in" : ""}" title="${isIn ? "In this list. Click to remove" : "Add to this list"}">${isIn ? ICON_IN : ICON_ADD}</span></div>`;
          })
          .join("") ||
        `<div class="hint-text as-empty">${
          !q.value.trim()
            ? "Type a symbol or a company name, for example SPCX, Tesla, XRP or EURUSD."
            : results.length
              ? "Nothing in this category. Try All."
              : `No matches. Press Enter to try <b>${esc(q.value.trim().toUpperCase())}</b> as typed.`
        }</div>`;
      box.querySelector(".item.sel")?.scrollIntoView({ block: "nearest" });
    };
    const changed = (msg) => {
      app.persist();
      drawRows();
      refreshQuotes();
      app.toast(msg);
    };
    const toggle = (sym, close) => {
      const list = wlSymbols();
      if (list.includes(sym)) {
        if (close) return app.closeModal(); // Shift on a symbol already there just closes
        app.state.watchlists[app.state.activeWatchlist] = list.filter((s) => s !== sym);
        changed(`Removed ${esc(ticker(sym))}`);
      } else {
        list.push(sym);
        changed(`Added ${esc(ticker(sym))}`);
      }
      if (close) app.closeModal();
      else draw();
    };
    const addTyped = async (close) => {
      try {
        const r = await api.get(`/api/resolve?symbol=${encodeURIComponent(q.value.trim())}`);
        if (!wlSymbols().includes(r.id)) toggle(r.id, close);
        else if (close) app.closeModal();
      } catch (err) {
        app.toast(esc(err.message), "err");
      }
    };
    const run = async () => {
      const v = q.value.trim();
      const mine = ++seq;
      if (!v) {
        results = [];
        return draw();
      }
      box.classList.add("busy");
      let found = [];
      try {
        found = await api.search(v);
      } catch {
        /* show no matches */
      }
      if (mine !== seq) return;
      box.classList.remove("busy");
      results = found;
      sel = 0;
      draw();
    };
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(run, 150);
    };
    q.onkeydown = (e) => {
      if (e.key === "ArrowDown") {
        sel = Math.min(sel + 1, rows.length - 1);
        draw();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        sel = Math.max(sel - 1, 0);
        draw();
        e.preventDefault();
      } else if (e.key === "Enter" && q.value.trim()) {
        e.preventDefault();
        if (rows[sel]) toggle(rows[sel].symbol, e.shiftKey);
        else addTyped(e.shiftKey);
      }
    };
    card.querySelector("#asKinds").onclick = (e) => {
      const b = e.target.closest("button[data-kind]");
      if (!b) return;
      kind = b.dataset.kind;
      card.querySelectorAll("#asKinds button").forEach((x) => x.classList.toggle("on", x === b));
      sel = 0;
      draw();
      q.focus();
    };
    box.onclick = (e) => {
      const it = e.target.closest(".item[data-i]");
      if (!it) return;
      toggle(rows[Number(it.dataset.i)].symbol, e.shiftKey);
      q.focus();
    };
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    if (initial) run();
    else draw();
  }
  // A coloured disc with the first letter stands in for TradingView's logos (no outside images).
  const badge = (sym) => {
    const t = ticker(sym);
    let h = 0;
    for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<span class="wl-badge" style="--h:${h}">${esc((t.match(/[A-Z0-9]/i) || ["?"])[0].toUpperCase())}</span>`;
  };
  // Last, Chg and Chg% all come from one live price against the quote's previous close, so the
  // three columns agree between quote refreshes.
  function figures(s) {
    const q = quotes[s] || {};
    const last = app.prices[s] ?? q.price;
    const prev = !Number.isFinite(q.price)
      ? null
      : Number.isFinite(q.change)
        ? q.price - q.change
        : Number.isFinite(q.changePct) && q.changePct > -100
          ? q.price / (1 + q.changePct / 100)
          : null;
    const chg = prev && Number.isFinite(last) ? last - prev : null;
    return { q, last, chg, pct: chg == null ? null : (chg / prev) * 100 };
  }
  // A change shows as many decimals as the price it belongs to, and two for US stocks.
  const signed = (v, s, ref) => {
    if (v == null || !Number.isFinite(v)) return "—";
    const a = Math.abs(ref ?? v);
    const d = exchange(s) === "US" || a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
    return `${v > 0 ? "+" : ""}${v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  };
  const dir = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
  function rowHtml(s, cur) {
    const f = figures(s);
    return `<div class="wl-row ${s === cur ? "current" : ""}" data-sym="${esc(s)}" title="${esc(s)}"><span class="sym">${badge(s)}<b>${esc(ticker(s))}</b></span><span class="px">${fmtPrice(f.last)}</span><span class="chg ${dir(f.chg)}">${signed(f.chg, s, f.last)}</span><span class="pct ${dir(f.chg)}">${fmtPct(f.pct)}</span><button class="x" title="Remove from list"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
  }
  function renderWatchlist() {
    side.innerHTML = `<div class="sp-fill"><div class="sp-head"><button class="sp-title" id="wlMenu" title="Switch, create, rename or delete lists"><span>${esc(app.state.activeWatchlist)}</span><svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg></button><span class="spacer"></span><button class="sp-icon" id="wlAdd" title="Add symbol">${ICON_ADD}</button></div>
      <div class="wl-cols"><span>Symbol</span><span>Last</span><span>Chg</span><span>Chg%</span></div><div class="wl-body" id="wlRows"></div><div class="wl-details" id="wlDetails"></div></div>`;
    $("#wlMenu").onclick = (e) => listMenu(e.currentTarget);
    $("#wlAdd").onclick = () => openAddSymbol();
    $("#wlRows").onclick = (e) => {
      const row = e.target.closest(".wl-row");
      if (!row) return;
      if (e.target.closest(".x")) {
        app.state.watchlists[app.state.activeWatchlist] = wlSymbols().filter(
          (s) => s !== row.dataset.sym,
        );
        app.persist();
        return drawRows();
      }
      app.setSymbol(row.dataset.sym);
    };
    drawRows();
    detailsFor = null;
    drawDetails();
  }
  // The list name opens a menu: switch list, or create, rename or delete one.
  let menuEl = null;
  const closeMenu = () => {
    menuEl?.remove();
    menuEl = null;
    document.removeEventListener("pointerdown", onOutside, true);
  };
  const onOutside = (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  };
  function listMenu(anchor) {
    if (menuEl) return closeMenu();
    const names = Object.keys(app.state.watchlists),
      cur = app.state.activeWatchlist;
    menuEl = document.createElement("div");
    menuEl.className = "sp-menu";
    menuEl.innerHTML =
      names
        .map((n) => `<button data-list="${esc(n)}" class="${n === cur ? "on" : ""}"><span>${esc(n)}</span><span class="muted">${app.state.watchlists[n].length}</span></button>`)
        .join("") +
      '<hr><button data-act="alert">Add alert on the list…</button><hr><button data-act="new">Create new list…</button><button data-act="rename">Rename list…</button><button data-act="del" class="down">Delete list</button>';
    const a = anchor.getBoundingClientRect(),
      s = sideEl.getBoundingClientRect();
    menuEl.style.left = `${a.left - s.left}px`;
    menuEl.style.top = `${a.bottom - s.top + 4}px`;
    sideEl.appendChild(menuEl);
    document.addEventListener("pointerdown", onOutside, true);
    menuEl.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      closeMenu();
      // TradingView's watchlist alert: one alert that checks every symbol on this list
      if (b.dataset.act === "alert") return openAlertCard(app, { watchlist: cur });
      const lists = app.state.watchlists;
      if (b.dataset.list != null) app.state.activeWatchlist = b.dataset.list;
      else if (b.dataset.act === "new") {
        const n = prompt("Name for the new list:")?.trim();
        if (!n || lists[n]) return;
        lists[n] = [];
        app.state.activeWatchlist = n;
      } else if (b.dataset.act === "rename") {
        const n = prompt("New name for this list:", cur)?.trim();
        if (!n || n === cur || lists[n]) return;
        app.state.watchlists = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k === cur ? n : k, v]));
        app.state.activeWatchlist = n;
        // alerts on the list follow its new name
        api
          .get("/api/alerts")
          .then((all) => Promise.all(all.filter((a) => a.watchlist === cur).map((a) => api.patch(`/api/alerts/${a.id}`, { watchlist: n }))))
          .then(() => sideTab === "alerts" && renderAlerts())
          .catch(() => {});
      } else if (b.dataset.act === "del") {
        if (names.length < 2) return app.toast("Keep at least one list.");
        if (!confirm(`Delete the list "${cur}"?`)) return;
        delete lists[cur];
        app.state.activeWatchlist = Object.keys(lists)[0];
      }
      app.persist();
      renderWatchlist();
      refreshQuotes();
    };
  }
  function drawRows() {
    const box = $("#wlRows");
    if (!box) return;
    const cur = app.active?.cfg.symbol;
    box.innerHTML =
      wlSymbols().map((s) => rowHtml(s, cur)).join("") ||
      '<div class="pad hint-text">Empty list. Add a symbol with +.</div>';
  }
  // Charts report every live price; update just those cells, at most once a frame.
  const ticked = new Set();
  let tickFrame = 0;
  app.priceListeners.add((sym) => {
    if (sideTab !== "watchlist") return;
    ticked.add(sym);
    tickFrame ||= requestAnimationFrame(() => {
      tickFrame = 0;
      const box = $("#wlRows");
      for (const s of ticked) {
        const row = box?.querySelector(`.wl-row[data-sym="${CSS.escape(s)}"]`);
        if (row) {
          const f = figures(s);
          row.querySelector(".px").textContent = fmtPrice(f.last);
          row.querySelector(".chg").textContent = signed(f.chg, s, f.last);
          row.querySelector(".pct").textContent = fmtPct(f.pct);
          row.querySelector(".chg").className = `chg ${dir(f.chg)}`;
          row.querySelector(".pct").className = `pct ${dir(f.chg)}`;
        }
        if (s === detailsFor) drawDetailsPrice();
      }
      ticked.clear();
    });
  });

  // Details for the chart's symbol, under the list: name, price, change, session, key stats.
  let detailsFor = null;
  const nameCache = {},
    statsCache = {};
  const nameOf = (s) =>
    (nameCache[s] ??= api
      .search(ticker(s))
      .then((r) => r.find((x) => x.symbol === s) || null)
      .catch(() => null));
  const statsOf = (s) =>
    (statsCache[s] ??= api
      .get(`/api/financials?symbol=${encodeURIComponent(s)}&frequency=annual`)
      .then((f) => f.stats || [])
      .catch(() => []));
  const CRYPTO_EX = ["BINANCE", "COINBASE", "KRAKEN"];
  const currencyOf = (s) =>
    exchange(s) === "US"
      ? "USD"
      : (/(USDT|USDC|USD|EUR|GBP|JPY|CAD|AUD|CHF|BTC|ETH)$/.exec(ticker(s).replace(/[-_/]/g, "")) || [""])[0];
  const KEY_STATS = ["Market Cap", "Previous Close", "52 Week High/Low", "Average Volume", "1 Year Target", "Current Yield", "Sector", "Industry"];
  async function drawDetails() {
    const box = $("#wlDetails"),
      s = app.active?.cfg.symbol;
    if (!box || !s) return;
    if (s === detailsFor) return drawDetailsPrice();
    detailsFor = s;
    box.innerHTML = `<div class="wd-top">${badge(s)}<b>${esc(ticker(s))}</b></div><div class="wd-name muted" id="wdName">${esc(exchange(s))}</div><div class="wd-px" id="wdPx"></div><div class="wd-status" id="wdStatus"></div><div class="wd-stats" id="wdStats"></div>`;
    drawDetailsPrice();
    const n = await nameOf(s);
    if (detailsFor !== s || !$("#wdName")) return;
    const kind = { stocks: "Stock", stock: "Stock", etf: "ETF", crypto: "Crypto", forex: "Forex", index: "Index", futures: "Futures" }[String(n?.type || "").toLowerCase()] || n?.type;
    $("#wdName").textContent = [n?.name, n?.exchange || exchange(s), kind].filter(Boolean).join(" · ");
    if (exchange(s) !== "US") return;
    const stats = await statsOf(s);
    if (detailsFor !== s || !$("#wdStats")) return;
    const big = (v) => {
      const x = Number(String(v).replace(/[$,]/g, ""));
      return Number.isFinite(x) && x >= 1e4 ? fmtNum(x) : v;
    };
    const rows = KEY_STATS.map((k) => stats.find((x) => x.label === k))
      .filter((x) => x && x.value && !/^(N\/A|NA|--)$/i.test(x.value))
      .map((x) => `<div class="wd-stat"><span class="muted">${esc(x.label)}</span><span>${esc(big(x.value))}</span></div>`)
      .join("");
    $("#wdStats").innerHTML = rows ? `<div class="wd-stats-h">Key stats</div>${rows}` : "";
  }
  function drawDetailsPrice() {
    const s = detailsFor,
      px = $("#wdPx");
    if (!px || !s) return;
    const f = figures(s);
    px.innerHTML = `<span class="wd-last">${fmtPrice(f.last)}</span><span class="muted wd-cur">${esc(currencyOf(s))}</span><span class="${dir(f.chg)}">${signed(f.chg, s, f.last)}</span><span class="${dir(f.chg)}">${fmtPct(f.pct)}</span>`;
    const status = CRYPTO_EX.includes(exchange(s)) ? "Open 24/7" : f.q.status || "";
    $("#wdStatus").innerHTML = [
      status ? `<span class="wd-dot ${/open/i.test(status) && !/closed/i.test(status) ? "on" : ""}"></span>${esc(status)}` : "",
      f.q.volume ? `<span class="muted">Volume</span> ${fmtNum(f.q.volume)}` : "",
    ].filter(Boolean).join('<span class="muted"> · </span>');
  }
  async function refreshQuotes() {
    const base = [...new Set([...wlSymbols(), ...paperSymbols()])];
    const cur = app.active?.cfg.symbol;
    const syms = cur && !base.includes(cur) && !cur.startsWith("SPREAD:") ? [...base, cur] : base;
    if (!syms.length) return;
    try {
      const q = await api.quotes(syms);
      Object.assign(quotes, q);
      for (const [s, v] of Object.entries(q))
        if (v.price && base.includes(s)) app.onPrice(s, v.price);
      if (sideTab === "watchlist") {
        drawRows();
        drawDetailsPrice();
      }
    } catch {
      /* offline */
    }
  }
  setInterval(refreshQuotes, 5000);
  refreshQuotes();

  // ======================= ALERTS =======================
  // TradingView's alerts panel: Alerts and Log tabs, + to create, a search box, and stop, restart
  // or delete on hover.
  let alView = "alerts",
    alQuery = "";
  const ICON_BELL = '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20h4"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>';
  const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M15 5l4 4L8 20H4v-4zM13 7l4 4"/></svg>';
  async function renderAlerts() {
    const notify = "Notification" in window && Notification.permission !== "granted";
    side.innerHTML = `<div class="sp-fill"><div class="sp-head"><div class="seg" id="alSeg"><button data-v="alerts" class="${alView === "alerts" ? "on" : ""}">Alerts</button><button data-v="log" class="${alView === "log" ? "on" : ""}">Log</button></div></div>
      <div class="sp-tools"><button class="sp-icon" id="alNew" title="Create alert">${ICON_ADD}</button><label class="sp-search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="alQ" placeholder="Search" autocomplete="off" value="${esc(alQuery)}"></label>${notify ? `<button class="sp-icon" id="alPerm" title="Turn on desktop notifications">${ICON_BELL}</button>` : ""}</div>
      <div class="sp-scroll" id="alList"><div class="pad hint-text">Loading…</div></div></div>`;
    $("#alSeg").onclick = (e) => {
      const v = e.target.closest("[data-v]")?.dataset.v;
      if (v && v !== alView) {
        alView = v;
        renderAlerts();
      }
    };
    $("#alNew").onclick = () => openAlertDialog();
    if ($("#alPerm")) $("#alPerm").onclick = () => Notification.requestPermission().then(() => renderAlerts());
    let list = [],
      log = [];
    try {
      [list, log] = await Promise.all([api.get("/api/alerts"), api.get("/api/alerts/log")]);
      app.setAlertList?.(list);
    } catch {
      /* server down */
    }
    const box = $("#alList");
    if (!box || sideTab !== "alerts") return;
    const draw = () => {
      const q = alQuery.trim().toLowerCase();
      const hit = (...parts) => !q || parts.join(" ").toLowerCase().includes(q);
      if (alView === "log") {
        box.innerHTML =
          log
            .filter((e) => hit(e.text, e.webhook))
            .slice(0, 100)
            .map((e) => `<div class="al-item"><div class="al-title">${esc(e.text)}</div><div class="al-meta">${new Date(e.at).toLocaleString()}${e.webhook ? ` · webhook ${esc(e.webhook)}` : ""}</div></div>`)
            .join("") || `<div class="pad hint-text">${q ? "No matches." : "Nothing has fired yet."}</div>`;
        return;
      }
      box.innerHTML =
        list
          .filter((a) => hit(a.symbol, a.watchlist, a.name, a.message, describeAlert(a, false)))
          .map((a) => {
            const cond = describeAlert(a, false);
            const trig = { once: "once only", oncePerBar: "every time", oncePerBarClose: "once per bar close", oncePerMinute: "once per minute" }[a.trigger] || a.trigger;
            const title = a.name || a.message || cond;
            // a watchlist alert has no symbol of its own (the vendor's alerts.js sets it to "")
            const where = a.watchlist ? `Watchlist: ${a.watchlist}${app.state.watchlists?.[a.watchlist] ? "" : " (deleted)"}` : ticker(a.symbol);
            const state = a.active ? '<span class="up">Active</span>' : a.expired ? '<span class="down">Expired</span>' : '<span class="muted">Stopped</span>';
            const until = a.expires && !a.expired ? ` · until ${new Date(a.expires).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "";
            return `<div class="al-item" data-id="${a.id}"><div class="al-title">${esc(title)}</div>${title !== cond ? `<div class="al-cond">${esc(where)} ${esc(cond)}</div>` : ""}<div class="al-meta">${badge(a.watchlist || a.symbol)}<span>${esc(where)}</span> · ${state} · ${esc(a.tf)} · ${esc(trig)}${until}${a.webhook ? " · webhook" : ""}${a.fired ? ` · fired ${a.fired}x` : ""}</div><div class="al-acts"><button data-act="edit" title="Edit">${ICON_EDIT}</button><button data-act="toggle" title="${a.active ? "Stop" : "Restart"}">${a.active ? ICON_PAUSE : ICON_PLAY}</button><button data-act="del" title="Delete">${ICON_TRASH}</button></div></div>`;
          })
          .join("") ||
        `<div class="pad hint-text">${q ? "No matches." : "No alerts yet. Press + to create one. They run inside the app, so they keep firing with this tab closed as long as the app is running."}</div>`;
    };
    draw();
    $("#alQ").oninput = (e) => {
      alQuery = e.target.value;
      draw();
    };
    box.onclick = async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const id = btn.closest("[data-id]").dataset.id;
      const a = list.find((x) => x.id === id);
      // an expired alert would stop again at once, so restarting one opens it to pick a new expiry
      if (btn.dataset.act === "edit" || (btn.dataset.act === "toggle" && !a.active && a.expires && a.expires <= Date.now()))
        return openAlertDialog({ edit: a });
      if (btn.dataset.act === "del") await api.del(`/api/alerts/${id}`);
      if (btn.dataset.act === "toggle")
        await api.patch(`/api/alerts/${id}`, {
          active: !a.active,
          lastBar: null,
          lastBars: {},
        });
      renderAlerts();
    };
  }
  function describeAlert(a, useMessage = true) {
    if (a.message && useMessage) return a.message;
    const name = (x) => {
      if (typeof x === "number") return fmtPrice(x);
      if (PRICE.includes(x)) return x === "close" ? "Price" : x;
      const [k, out] = String(x).split(".");
      const s = a.indicators?.[k];
      const def = BY_ID[s?.id];
      return def
        ? `${def.name.replace(/ \(.*\)$/, "")} ${Object.values(s.params || {}).join(" ")}${out && outputsOf(def).length > 1 ? ` ${out}` : ""}`
        : x;
    };
    const conds = a.conditions?.length ? a.conditions : [{ left: a.left, op: a.op, right: a.right }];
    const nm = (x) => (x && typeof x === "object" && x.line ? "your drawn line" : name(x));
    return conds
      .map((c) =>
        isChannel(c.op)
          ? `${nm(c.left)} ${OP_LABEL[c.op]} ${nm(c.right2)} to ${nm(c.right)}`
          : isMoving(c.op)
            ? `${nm(c.left)} ${OP_LABEL[c.op].replace(" %", "")} ${c.right}${/Pct$/.test(c.op) ? "%" : ""} within ${c.bars || 1} bar${(c.bars || 1) === 1 ? "" : "s"}`
            : `${nm(c.left)} ${OP_LABEL[c.op] || c.op} ${nm(c.right)}`,
      )
      .join(a.match === "any" ? " or " : " and ");
  }
  // TradingView's Create alert dialog (alertdialog.js). `preset.rules` come from the chart's plus
  // menu and from a selected drawing; `preset.edit` is an alert from this list.
  function openAlertDialog(preset = {}) {
    // As on TradingView, no new alerts from a chart shown in another currency: alerts watch the
    // symbol's own prices. Editing an existing one is fine.
    const to = app.active?.convTo?.();
    if (to && !preset.edit) return app.toast(`Alerts can't be created on a chart shown in ${to}. Switch the price scale back to ${app.active.ownCurrency()} first.`);
    openAlertCard(app, preset);
  }

  // ======================= OBJECT TREE / DATA WINDOW =======================
  // What's on the selected chart (series, compare symbols, indicators, drawings), and the values
  // under the crosshair.
  let obView = "tree",
    obSig = "";
  const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/></svg>';
  const ICON_GEAR = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>';
  const ICON_CANDLE = '<svg viewBox="0 0 24 24"><path d="M8 3v3M8 16v5M16 3v6M16 17v4"/><rect x="5.5" y="6" width="5" height="10" rx="1"/><rect x="13.5" y="9" width="5" height="8" rx="1"/></svg>';
  const ICON_LINE = '<svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 6-8 3 3"/></svg>';
  const ICON_VOL = '<svg viewBox="0 0 24 24"><path d="M5 20v-6M10 20V9M15 20v-4M20 20V6"/></svg>';
  const shortName = (def) => /\(([^)]+)\)$/.exec(def.name)?.[1].split(" / ")[0] || def.name;
  function renderObjects() {
    side.innerHTML = `<div class="sp-fill"><div class="sp-head"><div class="seg" id="obSeg"><button data-v="tree" class="${obView === "tree" ? "on" : ""}">Object tree</button><button data-v="data" class="${obView === "data" ? "on" : ""}">Data window</button></div></div><div class="sp-scroll" id="obBody"></div></div>`;
    $("#obSeg").onclick = (e) => {
      const v = e.target.closest("[data-v]")?.dataset.v;
      if (v && v !== obView) {
        obView = v;
        renderObjects();
      }
    };
    $("#obBody").onclick = onObjectClick;
    obSig = "";
    drawObjects();
  }
  const objectsSig = (p) =>
    JSON.stringify([
      p.cfg.symbol, p.cfg.tf, p.provider, p.cfg.compare, !!p.volume,
      p.cfg.indicators.map((i) => [i.uid, i.hidden, i.params, i.tf]),
      p.drawings.items.map((d) => [d.id, d.type, d.text, d === p.drawings.selected, !!d.hidden, !!d.locked]),
    ]);
  function drawObjects(index = null) {
    const box = $("#obBody"),
      p = app.active;
    if (!box || !p) return;
    if (obView === "data") return drawDataWindow(p, index);
    const sig = objectsSig(p);
    if (sig === obSig) return;
    obSig = sig;
    const row = (cls, icon, label, acts = "", attrs = "") =>
      `<div class="ob-row ${cls}" ${attrs}><span class="ob-ic">${icon}</span><span class="ob-label">${label}</span><span class="ob-acts">${acts}</span></div>`;
    let html = row("ob-main", ICON_CANDLE, `<b>${esc(ticker(p.cfg.symbol))}</b> <span class="muted">· ${esc(p.provider || exchange(p.cfg.symbol))}, ${esc(p.cfg.tf)}</span>`);
    if (p.volume) html += row("", ICON_VOL, "Volume");
    for (const sym of p.cfg.compare)
      html += row("", ICON_LINE, `${esc(ticker(sym))} <span class="muted">(compare)</span>`, `<button data-act="rmcompare" title="Remove">${ICON_X}</button>`, `data-compare="${esc(sym)}"`);
    for (const ind of p.cfg.indicators) {
      const def = BY_ID[ind.id];
      if (!def) continue;
      html += row(
        ind.hidden ? "off" : "",
        ICON_LINE,
        `${esc(shortName(def))} <span class="muted">${esc(p.indicatorParamsLabel(ind))}</span>`,
        `<button data-act="settings" title="Settings">${ICON_GEAR}</button><button data-act="hide" title="${ind.hidden ? "Show" : "Hide"}">${ind.hidden ? ICON_EYE_OFF : ICON_EYE}</button><button data-act="remove" title="Remove">${ICON_X}</button>`,
        `data-uid="${esc(ind.uid)}"`,
      );
    }
    p.drawings.items.forEach((d, i) => {
      if (d.pane && d.pane !== p.cfg.pid) return; // kept to another chart
      const t = TOOL_BY_ID[d.type];
      html += row(
        `${d === p.drawings.selected ? "sel" : ""} ${d.hidden ? "off" : ""}`,
        `<svg viewBox="0 0 24 24">${t?.icon || ""}</svg>`,
        `${esc(t?.label || d.type)}${d.text ? ` <span class="muted">${esc(d.text.slice(0, 24))}</span>` : ""}`,
        `<button data-act="hidedraw" title="${d.hidden ? "Show" : "Hide"}">${d.hidden ? ICON_EYE_OFF : ICON_EYE}</button><button data-act="rmdraw" title="Remove">${ICON_X}</button>`,
        `data-draw="${i}"`,
      );
    });
    if (!p.cfg.indicators.length && !p.drawings.items.length && !p.cfg.compare.length)
      html += '<div class="pad hint-text">Indicators, compare symbols and drawings on the selected chart show up here.</div>';
    box.innerHTML = html;
  }
  function onObjectClick(e) {
    const p = app.active,
      row = e.target.closest(".ob-row");
    if (!p || !row) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (row.dataset.uid) {
      const ind = p.cfg.indicators.find((x) => x.uid === row.dataset.uid);
      if (!ind) return;
      if (app.settings.lockIndicators && ["remove", "settings", "hide"].includes(act)) return app.toast("Indicators are locked. Unlock them from the lock button on the left.");
      if (act === "remove") p.removeIndicator(ind.uid);
      if (act === "settings") app.openIndicatorSettings(p, ind);
      if (act === "hide") {
        ind.hidden = !ind.hidden;
        p.render(false);
        app.persist();
      }
    } else if (row.dataset.compare && act === "rmcompare") {
      p.cfg.compare = p.cfg.compare.filter((s) => s !== row.dataset.compare);
      app.persist();
      p.load({ keepView: true });
    } else if (row.dataset.draw != null) {
      const d = p.drawings.items[Number(row.dataset.draw)];
      if (!d) return;
      if (act === "rmdraw") {
        if (app.isLocked(d)) return app.toast("Unlock the drawing to remove it.");
        p.drawings.items = p.drawings.items.filter((x) => x !== d);
        if (p.drawings.selected === d) p.drawings.selected = null;
        app.saveDrawings(p.drawKey(), p.drawings.items);
      } else if (act === "hidedraw") {
        d.hidden = !d.hidden || undefined;
        if (d.hidden && p.drawings.selected === d) p.drawings.selected = null;
        app.saveDrawings(p.drawKey(), p.drawings.items);
      } else if (!d.hidden) p.drawings.selected = d;
      p.drawings.update();
    }
    drawObjects();
  }
  function drawDataWindow(p, index) {
    const box = $("#obBody"),
      i = index ?? p.shown.length - 1,
      b = p.shown[i],
      prev = p.shown[i - 1];
    if (!b) {
      box.innerHTML = '<div class="pad hint-text">No bars on this chart yet.</div>';
      return;
    }
    const secs = parseTf(p.cfg.tf).seconds,
      d = new Date(b.time * 1000),
      chg = prev ? b.close - prev.close : null;
    const line = (k, v, cls = "", color = "") =>
      `<div class="dw-row"><span class="muted">${color ? `<i class="dw-sw" style="background:${esc(color)}"></i>` : ""}${k}</span><span class="${cls}">${v}</span></div>`;
    let html =
      `<div class="dw-group"><div class="dw-h">${esc(ticker(p.cfg.symbol))} <span class="muted">· ${esc(p.cfg.tf)}</span></div>` +
      line("Date", d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })) +
      (secs < 86400 ? line("Time", d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...(secs < 60 ? { second: "2-digit" } : {}) })) : "") +
      line("Open", fmtPrice(b.open)) +
      line("High", fmtPrice(b.high)) +
      line("Low", fmtPrice(b.low)) +
      line("Close", fmtPrice(b.close), dir(chg)) +
      line("Change", chg == null ? "—" : `${signed(chg, p.cfg.symbol, b.close)} (${fmtPct((chg / prev.close) * 100)})`, dir(chg)) +
      (b.volume != null ? line("Volume", fmtNum(b.volume)) : "") +
      "</div>";
    for (const ind of p.cfg.indicators) {
      const def = BY_ID[ind.id];
      if (!def || ind.hidden) continue;
      const res = p.indResults?.[ind.uid] || {};
      const vals = def.outputs
        .filter((o) => Array.isArray(res[o.key]))
        .map((o) => line(esc(o.label || o.key), fmtPrice(res[o.key][i]), "", ind.colors?.[o.key] || o.color))
        .join("");
      html += `<div class="dw-group"><div class="dw-h">${esc(shortName(def))} <span class="muted">${esc(p.indicatorParamsLabel(ind))}</span></div>${vals || line(res.error ? esc(res.error) : "No values", "")}</div>`;
    }
    box.innerHTML = html;
  }

  // ======================= NOTIFICATIONS =======================
  // Alerts that fired (the server's log) and the app's own notices, newest first. The bell counts
  // what arrived since the panel was last open.
  let ntView = "all",
    ntLog = null;
  const notices = [];
  if (app.settings.notifSeen === undefined) app.settings.notifSeen = Date.now();
  const ntItems = () =>
    [
      ...(ntLog || []).map((e) => ({ kind: "alert", at: e.at, title: e.name || "Alert", text: e.name && e.text.startsWith(`${e.name}: `) ? e.text.slice(e.name.length + 2) : e.text, symbol: e.symbol, tf: e.tf })),
      ...notices,
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  // The count goes on the bell; when the bell isn't on the toolbar, on Products and its menu row.
  function updateBadge() {
    const seen = app.settings.notifSeen || 0;
    const n = ntItems().filter((i) => Date.parse(i.at) > seen).length;
    const text = n > 99 ? "99+" : String(n);
    const bell = rail.querySelector('[data-panel="notifications"] .rail-badge');
    const set = (el, on) => {
      if (!el) return;
      el.hidden = !on;
      el.textContent = on ? text : "";
    };
    set(bell, n > 0);
    set(rail.querySelector('[data-act="products"] .rail-badge'), n > 0 && !bell);
    set(document.querySelector(".pm .pm-badge"), n > 0);
  }
  async function loadNotifications() {
    try {
      ntLog = await api.get("/api/alerts/log");
    } catch {
      ntLog ||= [];
    }
    if (sideTab === "notifications") renderNotifications();
    else updateBadge();
  }
  const ago = (iso) => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (!(s >= 0)) return "";
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const NT_ICON = {
    alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 2M5 3.5L2.5 6M19 3.5L21.5 6"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l3 3 5-6"/></svg>',
    bell: '<svg viewBox="0 0 28 28"><path d="M8 19.5v-7a6 6 0 0 1 12 0v7l2 2.5H6z"/><path d="M11.5 22.5a2.5 2.5 0 0 0 5 0"/></svg>',
  };
  function renderNotifications() {
    const seen = app.settings.notifSeen || 0;
    const items = ntItems().filter((i) => ntView === "all" || i.kind === ntView);
    const row = (i) => {
      const ico = i.kind === "alert" ? "alert" : i.level || "warn";
      return `<div class="nt-item${Date.parse(i.at) > seen ? " new" : ""}"${i.symbol ? ` data-sym="${esc(i.symbol)}"` : ""}><span class="nt-ico ${ico}">${NT_ICON[ico]}</span><div class="nt-body"><div class="nt-top"><b>${esc(i.title)}</b><span class="nt-time" title="${esc(new Date(i.at).toLocaleString())}">${esc(ago(i.at))}</span></div><div class="nt-text">${esc(i.text)}</div>${i.symbol ? `<div class="nt-meta">${badge(i.symbol)}<span>${esc(ticker(i.symbol))}</span>${i.tf ? `<span class="muted"> · ${esc(i.tf)}</span>` : ""}</div>` : ""}</div></div>`;
    };
    const empty = `<div class="nt-empty">${NT_ICON.bell}<b>${ntView === "all" ? "No notifications yet" : "Nothing here yet"}</b><span>Alerts that fire and notices from the app show up here.</span></div>`;
    side.innerHTML = `<div class="sp-fill"><div class="sp-head"><span class="sp-name">Notifications</span><span class="spacer"></span><button class="sp-icon" id="ntGear" title="Alert notification settings">${ICON_GEAR}</button></div>
      <div class="sp-tools"><div class="seg" id="ntSeg">${[["all", "All"], ["alert", "Alerts"], ["system", "System"]].map(([k, l]) => `<button data-v="${k}" class="${ntView === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div class="sp-scroll" id="ntList">${ntLog === null ? '<div class="pad hint-text">Loading…</div>' : items.map(row).join("") || empty}</div></div>`;
    $("#ntSeg").onclick = (e) => {
      const v = e.target.closest("[data-v]")?.dataset.v;
      if (v && v !== ntView) {
        ntView = v;
        renderNotifications();
      }
    };
    $("#ntGear").onclick = () => app.openSettings("alerts");
    $("#ntList").onclick = (e) => {
      const s = e.target.closest("[data-sym]")?.dataset.sym;
      if (s) app.setSymbol(s);
    };
    if (ntLog === null) return loadNotifications();
    // opening the panel reads everything; the new ones keep their mark until the next visit
    if (ntItems().some((i) => Date.parse(i.at) > seen)) {
      app.settings.notifSeen = Date.now();
      app.persist();
    }
    updateBadge();
  }
  // From the app: a notice of its own ("warn", or "ok" when it's resolved).
  P.notice = (text, level = "warn") => {
    notices.unshift({ kind: "system", at: new Date().toISOString(), title: level === "ok" ? "Resolved" : "Notice", text, level });
    notices.length = Math.min(notices.length, 50);
    if (sideTab === "notifications") renderNotifications();
    else updateBadge();
  };
  loadNotifications();

  // ======================= CALENDARS =======================
  // TradingView's Calendars: Economic, Earnings, Dividends and IPO. Economic events cover this week
  // (filter by importance and country), earnings and dividends the next five trading days, IPOs
  // this month and next. Times and days are in the chart's time zone.
  const CAL_TABS = [["economic", "Economic"], ["earnings", "Earnings"], ["dividends", "Dividends"], ["ipo", "IPO"]];
  const IMP = { Low: 1, Medium: 2, High: 3 };
  const IMP_OPTS = [["all", "All"], ["medium", "Medium and high"], ["high", "High"]];
  const calOpts = () => {
    const c = (app.settings.calendar ||= {});
    return Object.assign(c, { tab: c.tab || "economic", day: c.day || "week", imp: c.imp || "all", countries: Array.isArray(c.countries) ? c.countries : [], mine: !!c.mine, ipo: c.ipo || "upcoming" });
  };
  const calCache = {};
  let calSeq = 0;
  async function calData(tab) {
    const hit = calCache[tab];
    if (hit && Date.now() - hit.at < 10 * 60e3) return hit.rows;
    const url = { economic: "/api/calendar", earnings: "/api/earnings?days=5", dividends: "/api/dividends?days=5", ipo: "/api/ipos" }[tab];
    const rows = await api.get(url);
    calCache[tab] = { at: Date.now(), rows };
    return rows;
  }
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function calClock() {
    const tz = zoneOf(app.settings.chart, app.active?.cfg.symbol);
    const wall = (sec) => sec + tzOffset(tz, sec);
    return { wall, today: Math.floor(wall(Date.now() / 1000) / 86400) };
  }
  const dayName = (d, today) => {
    const t = new Date(d * 86400e3),
      date = `${DOW[t.getUTCDay()]} ${t.getUTCDate()} ${MON[t.getUTCMonth()]}`;
    return d === today ? `Today, ${date}` : d === today + 1 ? `Tomorrow, ${date}` : d === today - 1 ? `Yesterday, ${date}` : date;
  };
  const dayOk = (c, d, today) => (c.day === "today" ? d === today : c.day === "tomorrow" ? d === today + 1 : true);
  function calBar(c) {
    const chip = (k, l, cur, attr = "data-day") => `<button class="cl-chip${cur === k ? " on" : ""}" ${attr}="${k}">${l}</button>`;
    if (c.tab === "ipo") return `<div class="cl-chips">${[["upcoming", "Upcoming"], ["priced", "Priced"], ["filed", "Filed"]].map(([k, l]) => chip(k, l, c.ipo, "data-ipo")).join("")}</div>`;
    const days = `<div class="cl-chips">${chip("today", "Today", c.day)}${chip("tomorrow", "Tomorrow", c.day)}${chip("week", c.tab === "economic" ? "This week" : "Next 5 days", c.day)}</div>`;
    if (c.tab === "economic")
      return `${days}<div class="cl-filters"><button class="cl-dd" data-x="imp" title="Importance">${IMP_BARS(c.imp === "high" ? 3 : c.imp === "medium" ? 2 : 1)}<span>${esc(IMP_OPTS.find(([k]) => k === c.imp)[1])}</span>${CAL_CHEV}</button><button class="cl-dd" data-x="cty" title="Countries"><span>${c.countries.length ? esc(c.countries.join(", ")) : "All countries"}</span>${CAL_CHEV}</button></div>`;
    return `${days}<label class="cl-mine"><input type="checkbox" id="clMine" ${c.mine ? "checked" : ""}> My watchlists</label>`;
  }
  const CAL_CHEV = '<svg viewBox="0 0 18 18" class="cs-chev"><path d="M5 7.5l4 4 4-4"/></svg>';
  const IMP_BARS = (n) => `<span class="cl-imp i${n}"><i></i><i></i><i></i></span>`;
  const big = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v ?? ""));
  function calRows(c, data) {
    const { wall, today } = calClock();
    const h12 = app.settings.chart.hours === "12";
    const mine = new Set(Object.values(app.state.watchlists || {}).flat());
    let day = null,
      html = "";
    const head = (d) => (d !== day ? `<div class="cl-day">${esc(dayName((day = d), today))}</div>` : "");
    if (c.tab === "economic") {
      const now = Date.now() / 1000;
      const rows = data
        .map((r) => ({ ...r, sec: Date.parse(r.date) / 1000 }))
        .filter((r) => Number.isFinite(r.sec))
        .filter((r) => c.imp === "all" || r.impact === "High" || (c.imp === "medium" && r.impact === "Medium"))
        .filter((r) => !c.countries.length || c.countries.includes(r.country))
        .filter((r) => dayOk(c, Math.floor(wall(r.sec) / 86400), today))
        .sort((a, b) => a.sec - b.sec);
      let nowShown = false;
      for (const r of rows) {
        const d = Math.floor(wall(r.sec) / 86400);
        html += head(d);
        if (!nowShown && d === today && r.sec > now) {
          nowShown = true;
          html += '<div class="cl-now"><span>Now</span></div>';
        }
        const vals = [r.forecast && `Forecast <b>${esc(r.forecast)}</b>`, r.previous && `Prior <b>${esc(r.previous)}</b>`].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
        const imp = r.impact === "Holiday" ? '<span class="cl-hol">Holiday</span>' : `<span title="${esc(r.impact)} importance">${IMP_BARS(IMP[r.impact] || 1)}</span>`;
        html += `<div class="cl-row${r.sec < now ? " past" : ""}"><span class="cl-time">${esc(fmtClock(wall(r.sec), h12))}</span><span class="cl-cty">${esc(r.country)}</span><span class="cl-name">${esc(r.title)}${vals ? `<span class="cl-vals">${vals}</span>` : ""}</span>${imp}</div>`;
      }
      return html || `<div class="cl-empty">No events ${c.day === "today" ? "today" : c.day === "tomorrow" ? "tomorrow" : "this week"} at this importance${c.countries.length ? " for these countries" : ""}.</div>`;
    }
    if (c.tab === "ipo") {
      const rows = (data[c.ipo] || []).slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
      for (const r of rows) {
        const vals = [r.exchange && esc(r.exchange), r.price && `Price <b>$${esc(r.price)}</b>`, r.shares && `Shares <b>${big(r.shares)}</b>`, r.value && `Value <b>$${big(r.value)}</b>`].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
        const sym = c.ipo === "priced" && r.symbol ? ` data-sym="${esc(r.symbol)}"` : "";
        html += `<div class="cl-row cl-co${sym ? " link" : ""}"${sym}><span class="cl-logo">${r.ticker ? badge(r.symbol) : '<span class="wl-badge" style="--h:220">?</span>'}</span><span class="cl-name"><b>${esc(r.ticker || "No ticker yet")}</b> <span class="muted">${esc(r.name)}</span>${vals ? `<span class="cl-vals">${vals}</span>` : ""}</span><span class="cl-date">${esc(r.date)}</span></div>`;
      }
      return html || `<div class="cl-empty">No ${c.ipo} IPOs listed this month or next.</div>`;
    }
    const rows = data
      .filter((r) => !c.mine || mine.has(r.symbol))
      .map((r) => ({ ...r, d: Math.floor(Date.parse(`${r.date}T00:00:00Z`) / 86400e3) }))
      .filter((r) => dayOk(c, r.d, today))
      .sort((x, y) => x.d - y.d || mine.has(y.symbol) - mine.has(x.symbol) || (y.marketCap || 0) - (x.marketCap || 0))
      .slice(0, 250);
    for (const r of rows) {
      html += head(r.d);
      const star = mine.has(r.symbol) ? ' <span class="up" title="On your watchlist">●</span>' : "";
      let vals, side2;
      if (c.tab === "earnings") {
        vals = [r.epsForecast && `EPS estimate <b>${esc(r.epsForecast)}</b>`, r.lastYearEps && `Last year <b>${esc(r.lastYearEps)}</b>`, r.marketCap && `Cap <b>${big(r.marketCap)}</b>`].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
        const pre = r.when === "Before the open",
          post = r.when === "After the close";
        side2 = `<span class="cl-when" title="${esc(r.when)}">${pre ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>' : post ? '<svg viewBox="0 0 24 24"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/></svg>' : ""}</span>`;
      } else {
        vals = [r.amount != null && `Dividend <b>${fmtPrice(r.amount)}</b>`, r.exDate && `Ex-date <b>${esc(r.exDate)}</b>`, r.payDate && `Paid <b>${esc(r.payDate)}</b>`, r.annual && `Yearly <b>${fmtPrice(r.annual)}</b>`].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
        side2 = "";
      }
      html += `<div class="cl-row cl-co link" data-sym="${esc(r.symbol)}"><span class="cl-logo">${badge(r.symbol)}</span><span class="cl-name"><b>${esc(r.ticker)}</b>${star} <span class="muted">${esc((r.name || "").slice(0, 40))}</span>${vals ? `<span class="cl-vals">${vals}</span>` : ""}</span>${side2}</div>`;
    }
    return html || `<div class="cl-empty">${c.mine ? "None of your watchlist symbols" : "Nothing listed"} ${c.day === "today" ? "today" : c.day === "tomorrow" ? "tomorrow" : "in the next five trading days"}.</div>`;
  }
  async function renderCalendar() {
    const c = calOpts(),
      seq = ++calSeq;
    side.innerHTML = `<div class="sp-fill"><div class="sp-head"><span class="sp-name">Calendars</span></div>
      <div class="cl-tabs" id="clTabs">${CAL_TABS.map(([k, l]) => `<button data-t="${k}" class="${c.tab === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="cl-bar" id="clBar">${calBar(c)}</div>
      <div class="sp-scroll cl-list" id="calList"><div class="pad hint-text">Loading…</div></div></div>`;
    const again = () => {
      app.persist();
      renderCalendar();
    };
    $("#clTabs").onclick = (e) => {
      const t = e.target.closest("[data-t]")?.dataset.t;
      if (t && t !== c.tab) {
        c.tab = t;
        again();
      }
    };
    $("#clBar").onchange = (e) => {
      if (e.target.id === "clMine") {
        c.mine = e.target.checked;
        again();
      }
    };
    $("#clBar").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.day) return ((c.day = b.dataset.day), again());
      if (b.dataset.ipo) return ((c.ipo = b.dataset.ipo), again());
      const tb = app.drawToolbar;
      if (b.dataset.x === "imp") {
        const pop = tb.openPopover(b, IMP_OPTS.map(([k, l], i) => `<button data-v="${k}" class="${c.imp === k ? "on" : ""}">${IMP_BARS(i + 1)}<span>${l}</span></button>`).join(""), "cl-imp");
        pop.classList.add("dtb-list", "cl-pop");
        pop.onclick = (ev) => {
          const v = ev.target.closest("[data-v]")?.dataset.v;
          if (!v) return;
          tb.closePopover();
          c.imp = v;
          again();
        };
      }
      if (b.dataset.x === "cty") {
        const codes = [...new Set((calCache.economic?.rows || []).map((r) => r.country).filter(Boolean))].sort();
        const pop = tb.openPopover(
          b,
          `<button data-v="" class="${c.countries.length ? "" : "on"}">All countries</button><hr>${codes.map((k) => `<label class="cl-cbox"><input type="checkbox" value="${esc(k)}" ${c.countries.includes(k) ? "checked" : ""}><span>${esc(k)}</span></label>`).join("")}`,
          "cl-cty",
        );
        pop.classList.add("dtb-list", "cl-pop");
        pop.onclick = (ev) => {
          if (ev.target.closest('[data-v=""]')) {
            tb.closePopover();
            c.countries = [];
            again();
          }
        };
        pop.onchange = () => {
          c.countries = [...pop.querySelectorAll("input:checked")].map((x) => x.value);
          app.persist();
          const list = $("#calList");
          if (list && calCache.economic) list.innerHTML = calRows(c, calCache.economic.rows);
          const lab = b.querySelector("span");
          if (lab) lab.textContent = c.countries.length ? c.countries.join(", ") : "All countries";
        };
      }
    };
    const list = $("#calList");
    list.onclick = (e) => {
      const s = e.target.closest("[data-sym]")?.dataset.sym;
      if (s) app.setSymbol(s);
    };
    try {
      const data = await calData(c.tab);
      if (seq !== calSeq || !list.isConnected) return;
      list.innerHTML = calRows(c, data);
    } catch (e) {
      if (seq === calSeq && list.isConnected) list.innerHTML = `<div class="cl-empty">Calendar unavailable: ${esc(e.message)}</div>`;
    }
  }

  // ======================= STRATEGY TESTER =======================
  let lastResult = null,
    equityChart = null;
  // TradingView's report for a Pine strategy on the chart; the rule builder for strategies without code
  const report = new StrategyReport(app);
  let tMode = "report";
  const toBuilder = () => {
    tMode = "builder";
    renderTester();
  };
  const tState = {
    groups: null,
    settings: {
      direction: "long",
      stopLossPct: 0,
      takeProfitPct: 0,
      trailingStopPct: 0,
      exitMatch: "all",
      maxBarsInTrade: 0,
      initialCapital: 10000,
      positionPct: 100,
      feePct: 0.1,
      slippagePct: 0.05,
      spreadPct: 0,
      intrabar: "worst",
    },
  };
  function strategyToUi(s) {
    const ind = s.indicators || {};
    const g = (k) =>
      (s[k] || []).map((r) => ({
        left: toOperand(r.left, ind),
        op: r.op,
        right: toOperand(r.right, ind),
      }));
    tState.groups = {
      entryLong: g("entryLong"),
      exitLong: g("exitLong"),
      entryShort: g("entryShort"),
      exitShort: g("exitShort"),
    };
    for (const k of ["stopLossPct", "takeProfitPct", "trailingStopPct", "maxBarsInTrade"])
      tState.settings[k] = s[k] || 0;
    tState.settings.exitMatch = s.exitMatch === "any" ? "any" : "all";
  }
  if (!tState.groups) strategyToUi(EXAMPLE_STRATEGIES["EMA cross (9/21)"]);

  function readTester() {
    const groups = {};
    for (const k of ["entryLong", "exitLong", "entryShort", "exitShort"])
      groups[k] = readRules(bottom.querySelector(`[data-g="${k}"]`));
    tState.groups = groups;
    bottom.querySelectorAll("[data-s]").forEach((el) => {
      tState.settings[el.dataset.s] =
        el.type === "number" ? Number(el.value) : el.value;
    });
    return { ...compileRules(groups), ...tState.settings };
  }

  function renderTester() {
    if (tMode === "report" && strategiesOn(app.active).length) {
      report.render(bottom, app.active, toBuilder);
      return;
    }
    report.destroy();
    const pineStrats = strategiesOn(app.active).length;
    const group = (k, title) =>
      `<h4>${title}</h4><div class="rules" data-g="${k}">${(tState.groups[k] || []).map(ruleHtml).join("")}</div><button class="btn small" data-add="${k}">+ Condition</button>`;
    const num = (k, label, step = "any") =>
      `<label class="field">${label}<input data-s="${k}" type="number" step="${step}" value="${tState.settings[k]}"></label>`;
    const saved = Object.keys(app.state.strategies || {});
    bottom.innerHTML = `<div class="tester"><div class="left">
      <div class="row-flex"><select class="in" id="tPreset"><option value="">Load a strategy…</option><optgroup label="Examples">${Object.keys(
        EXAMPLE_STRATEGIES,
      )
        .map((n) => `<option value="ex:${esc(n)}">${esc(n)}</option>`)
        .join(
          "",
        )}</optgroup>${saved.length ? `<optgroup label="Saved">${saved.map((n) => `<option value="sv:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : ""}</select><button class="btn primary" id="tRun">Run on chart</button>${pineStrats ? '<button class="btn small" id="tReport" title="The report of the Pine strategy on this chart">Strategy report</button>' : ""}</div>
      <p class="hint-text">Entry conditions must all be true. Exits can need all of theirs or just one. Leave a section empty to skip it. Signals use the bar's close and fill at the next bar's open.</p>
      ${group("entryLong", "Buy (enter long) when")}${group("exitLong", "Sell (exit long) when")}${group("entryShort", "Enter short when")}${group("exitShort", "Exit short when")}
      <h4>Exits</h4><div class="row-flex"><label class="field">Exit when<select class="in" data-s="exitMatch"><option value="all"${tState.settings.exitMatch === "any" ? "" : " selected"}>all exit conditions are true</option><option value="any"${tState.settings.exitMatch === "any" ? " selected" : ""}>any one exit condition is true</option></select></label>${num("maxBarsInTrade", "Exit after this many bars (0 = off)", 1)}</div>
      <h4>Risk</h4><div class="row-flex">${num("stopLossPct", "Stop loss %")}${num("takeProfitPct", "Take profit %")}${num("trailingStopPct", "Trailing stop %")}</div>
      <h4>Money</h4><div class="row-flex">${num("initialCapital", "Starting capital")}${num("positionPct", "Position size %")}${num("feePct", "Fee % per side")}${num("slippagePct", "Slippage % per side")}${num("spreadPct", "Spread % (bid to ask)")}<button class="btn small" id="tSpread" title="Read the live bid and ask (crypto)">Live spread</button></div>
      <h4>Fills inside a bar</h4><div class="row-flex"><label class="field">Stops and targets<select class="in" data-s="intrabar">${[
        ["worst", "Stop first when a bar touches both (cautious)"],
        ["ohlc", "TradingView's path: open, nearer extreme, far extreme, close"],
        ["magnifier", "Bar magnifier: real lower-timeframe bars inside each bar"],
      ]
        .map(([v, t]) => `<option value="${v}"${tState.settings.intrabar === v ? " selected" : ""}>${t}</option>`)
        .join("")}</select></label></div>
      <h4>Your own data</h4><div class="row-flex"><button class="btn small" id="tImpBars">Import bars (CSV)</button><button class="btn small" id="tImpSig">Import signal (CSV)</button><input type="file" id="tImpFile" accept=".csv,.txt,text/csv" hidden></div>
      <p class="hint-text">Bars: time, open, high, low, close and volume, one symbol per file (an Alpaca export works as it is). They chart as CSV:NAME on their own timeframe and longer. Signal: time and position, 1 long, 0 flat, -1 short, from that bar's close. It loads here as rules, so Run on chart and the quant checks test your strategy as written.</p>
      <div class="row-flex" style="margin-top:12px"><button class="btn" id="tSave">Save strategy</button><button class="btn" id="tJson">Edit as JSON</button></div>
    </div><div class="right" id="tOut"><div class="hint-text">Pick or build a strategy, then press <b>Run on chart</b>. It runs on the active chart's symbol and timeframe.</div></div></div>`;
    for (const k of ["entryLong", "exitLong", "entryShort", "exitShort"])
      bindRules(bottom.querySelector(`[data-g="${k}"]`));
    bottom.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => {
        bottom
          .querySelector(`[data-g="${b.dataset.add}"]`)
          .insertAdjacentHTML("beforeend", ruleHtml(defaultRule()));
      };
    });
    $("#tPreset").onchange = (e) => {
      const v = e.target.value;
      if (!v) return;
      const s = v.startsWith("ex:")
        ? EXAMPLE_STRATEGIES[v.slice(3)]
        : app.state.strategies[v.slice(3)];
      strategyToUi(s);
      tState.name = v.slice(3);
      for (const k of [
        "initialCapital",
        "positionPct",
        "feePct",
        "slippagePct",
        "spreadPct",
        "intrabar",
      ])
        if (s[k] != null) tState.settings[k] = s[k];
      renderTester();
    };
    $("#tRun").onclick = runTester;
    if ($("#tReport"))
      $("#tReport").onclick = () => {
        tMode = "report";
        renderTester();
      };
    let impKind = "bars";
    const pickFile = (kind) => {
      impKind = kind;
      $("#tImpFile").value = "";
      $("#tImpFile").click();
    };
    $("#tImpBars").onclick = () => pickFile("bars");
    $("#tImpSig").onclick = () => pickFile("signal");
    $("#tImpFile").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        app.toast(`Reading ${esc(f.name)}…`);
        const res = await fetchStepUp(`/api/import/${impKind}?name=${encodeURIComponent(f.name)}`, {
          method: "POST",
          headers: { "x-qt": "1", "Content-Type": "text/csv" },
          body: await f.text(),
        });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
        if (impKind === "bars") {
          const pane = app.active;
          if (pane && parseTf(pane.cfg.tf).seconds < parseTf(r.tf).seconds) pane.cfg.tf = r.tf;
          app.setSymbol(r.symbol);
          app.toast(`Imported ${r.bars.toLocaleString()} ${esc(r.tf)} bars as ${esc(r.symbol)}${r.skipped ? ` (skipped ${r.skipped} rows with no price)` : ""}. Pick any timeframe from ${r.tf} up.`);
        } else {
          if (!(await app.importCustom(r.file))) return;
          strategyToUi(r.strategy);
          tState.name = `Signal ${r.name}`;
          renderTester();
          app.toast(`Loaded your signal ${esc(r.name)}: ${r.changes.toLocaleString()} position changes. Open the bars it was made on, then press Run on chart.`);
        }
      } catch (err) {
        app.toast(esc(err.message), "err");
      }
    };
    $("#tSpread").onclick = async () => {
      const sym = app.active?.cfg.symbol;
      try {
        const r = await api.get(`/api/spread?symbol=${encodeURIComponent(sym)}`);
        bottom.querySelector('[data-s="spreadPct"]').value = Number(r.spreadPct.toPrecision(2));
        app.toast(`${ticker(r.symbol)} on ${r.source}: bid ${fmtPrice(r.bid)}, ask ${fmtPrice(r.ask)}. Spread set to ${Number(r.spreadPct.toPrecision(2))}%.`);
      } catch (e) {
        app.toast(esc(e.message), "err");
      }
    };
    $("#tSave").onclick = () => {
      const name = prompt("Name this strategy:");
      if (!name) return;
      app.state.strategies = {
        ...(app.state.strategies || {}),
        [name]: readTester(),
      };
      app.persist();
      app.toast(`Saved "${esc(name)}".`);
    };
    $("#tJson").onclick = () => {
      const card = app.modal(
        "Strategy JSON",
        `<p class="hint-text">The same format your AI agent can write. Operands: numbers, price fields, indicator keys, or key.output.</p><textarea class="in" id="tJ" rows="22">${esc(JSON.stringify(readTester(), null, 2))}</textarea>`,
        {
          foot: '<button class="btn primary" id="tJOk">Apply</button>',
          wide: true,
        },
      );
      card.querySelector("#tJOk").onclick = () => {
        try {
          const s = JSON.parse(card.querySelector("#tJ").value);
          strategyToUi(s);
          for (const k of [
            "initialCapital",
            "positionPct",
            "feePct",
            "slippagePct",
            "spreadPct",
            "intrabar",
          ])
            if (s[k] != null) tState.settings[k] = s[k];
          app.closeModal();
          renderTester();
        } catch (e) {
          app.toast(`Invalid JSON: ${esc(e.message)}`, "err");
        }
      };
    };
    if (lastResult) showResult(lastResult);
  }

  async function runTester() {
    const p = app.active;
    if (!p?.bars.length)
      return app.toast("The active chart has no data yet.", "err");
    let strat;
    try {
      strat = readTester();
    } catch (e) {
      return app.toast(esc(e.message), "err");
    }
    if (!strat.entryLong.length && !strat.entryShort.length)
      return app.toast("Add at least one entry condition.", "err");
    try {
      const bars = p.replay ? p.bars.slice(0, p.replay.index + 1) : p.bars;
      let subBars = null;
      if (strat.intrabar === "magnifier") {
        const sec = parseTf(p.cfg.tf).seconds;
        const m = magnifierTf(sec, bars.at(-1).time - bars[0].time + sec);
        if (!m) app.toast("This chart is already as fine as the bar magnifier goes, so it uses the OHLC path.");
        else {
          app.toast(`Loading ${m.tf} bars for the bar magnifier…`);
          const span = bars.at(-1).time - bars[0].time + sec;
          const r = await api.candles(p.cfg.symbol, m.tf, Math.ceil(span / m.seconds) + 10);
          subBars = r.candles.filter((c) => c.time >= bars[0].time && c.time < bars.at(-1).time + sec);
        }
      }
      const r = backtest(bars, strat, { subBars });
      lastResult = { ...r, symbol: p.cfg.symbol, tf: p.cfg.tf, bars, strat, subBars };
      p.extraMarkers = r.trades.flatMap((t) => [
        {
          time: t.entryTime,
          position: t.side === "long" ? "belowBar" : "aboveBar",
          shape: t.side === "long" ? "arrowUp" : "arrowDown",
          color: t.side === "long" ? "#2962ff" : "#ff6d00",
          text: t.side === "long" ? "Buy" : "Short",
        },
        {
          time: t.exitTime,
          position: t.side === "long" ? "aboveBar" : "belowBar",
          shape: "circle",
          color: t.pnl >= 0 ? "#089981" : "#f23645",
          text: `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%`,
        },
      ]);
      p.render(false);
      showResult(lastResult);
    } catch (e) {
      app.toast(esc(e.message), "err");
    }
  }

  function showResult(r) {
    const out = $("#tOut");
    if (!out) return;
    const s = r.stats;
    const stat = (k, v, cls = "") =>
      `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v ?? "—"}</div></div>`;
    const pc = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`);
    // a Pine strategy trades fixed sizes against large capital, so its report shows money too
    const money = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 10 ? 4 : 2 })}`);
    out.innerHTML = `<div class="row-flex"><b>${r.pine ? `${esc(r.name)} · ` : ""}${esc(ticker(r.symbol))} ${esc(r.tf)}</b><span class="hint-text">${r.bars.length} bars · ${new Date(r.bars[0].time * 1000).toLocaleDateString()} to ${new Date(r.bars.at(-1).time * 1000).toLocaleDateString()} · ${esc(s.feesAndSlippage)} · ${esc(s.fills)}</span><span class="spacer"></span><button class="btn small" id="tCsv">Export trades (CSV)</button><button class="btn small" id="tClear">Clear chart marks</button></div>
      <div class="stats">${stat("Net profit", r.pine ? `${money(s.netProfit)} (${pc(s.netProfitPct)})` : pc(s.netProfitPct), s.netProfitPct >= 0 ? "up" : "down")}${stat("Buy and hold", pc(s.buyHoldPct), s.buyHoldPct >= 0 ? "up" : "down")}${stat("Max drawdown", s.maxDrawdownPct == null ? "—" : r.pine ? `${money(-(r.maxDrawdown || 0))} (-${s.maxDrawdownPct}%)` : `-${s.maxDrawdownPct}%`, "down")}${stat("Trades", s.totalTrades)}${stat("Win rate", s.winRatePct == null ? "—" : `${s.winRatePct}%`)}${stat("Profit factor", s.profitFactor)}${stat("Sharpe", s.sharpe)}${stat("Sortino", s.sortino)}${stat("Avg trade", pc(s.avgTradePct))}${stat("Time in market", s.exposurePct == null ? "—" : `${s.exposurePct}%`)}</div>
      <div class="equity" id="tEq"></div>
      <div id="tQuant"></div>
      <table class="t"><thead><tr><th>Side</th><th>Entry</th><th>Exit</th><th>Entry price</th><th>Exit price</th><th>P&amp;L %</th><th>Bars</th><th class="l">Exit reason</th></tr></thead><tbody>${r.trades
        .slice()
        .reverse()
        .slice(0, 300)
        .map(
          (t) =>
            `<tr data-t="${t.entryTime}"><td>${t.side}</td><td>${new Date(t.entryTime * 1000).toLocaleString()}</td><td>${new Date(t.exitTime * 1000).toLocaleString()}</td><td>${fmtPrice(t.entryPrice)}</td><td>${fmtPrice(t.exitPrice)}</td><td class="${t.pnl >= 0 ? "up" : "down"}">${t.pnlPct.toFixed(2)}%</td><td>${t.bars}</td><td class="l">${esc(t.exitReason)}</td></tr>`,
        )
        .join("")}</tbody></table>`;
    $("#tCsv").onclick = () =>
      download(`${ticker(r.symbol)}-${r.tf}-trades.csv`, tradesCsv(r.trades));
    $("#tClear").onclick = () => {
      app.active.extraMarkers = [];
      app.active.render(false);
    };
    equityChart?.remove();
    const el = $("#tEq");
    equityChart = LW.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: css("--bg") },
        textColor: css("--text"),
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: css("--grid") },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
    });
    const eq = equityChart.addSeries(LW.AreaSeries, {
      lineColor: "#2962ff",
      topColor: "rgba(41,98,255,.3)",
      bottomColor: "rgba(41,98,255,0)",
      lineWidth: 2,
      title: "Strategy",
    });
    eq.setData(r.equity.map((e) => ({ time: e.time, value: e.value })));
    const bh = equityChart.addSeries(LW.LineSeries, {
      color: "#787b86",
      lineWidth: 1,
      title: "Buy & hold",
      priceLineVisible: false,
    });
    const c0 = r.bars[0].close;
    bh.setData(
      r.bars.map((b) => ({
        time: b.time,
        value: (r.strat.initialCapital * b.close) / c0,
      })),
    );
    equityChart.timeScale().fitContent();
    if (r.pine) {
      $("#tQuant").innerHTML = '<p class="hint-text">The quant checks rerun rule-based strategies, so they are off for a Pine script.</p>';
      return;
    }
    mountQuantChecks($("#tQuant"), r);
  }

  // ======================= SCREENER =======================
  const sc = {
    universe: "crypto",
    rows: [],
    sort: "volume",
    dir: -1,
    filters: {},
    scan: null,
    rule: {
      left: { kind: "ind", id: "rsi", params: { length: 14 }, output: "value" },
      op: "<",
      right: { kind: "value", v: 30 },
    },
    tf: "1D",
  };
  async function loadScreener() {
    $("#scTable").innerHTML = '<div class="pad hint-text">Loading…</div>';
    try {
      sc.rows = await api.get(`/api/screener?universe=${sc.universe}`);
      sc.scan = null;
    } catch (e) {
      sc.rows = [];
      app.toast(esc(e.message), "err");
    }
    drawScreener();
  }
  function filtered() {
    const f = sc.filters;
    const term = (f.q || "").toLowerCase();
    return sc.rows
      .filter(
        (r) =>
          (!term || `${r.ticker} ${r.name}`.toLowerCase().includes(term)) &&
          (f.minPrice == null || r.price >= f.minPrice) &&
          (f.maxPrice == null || r.price <= f.maxPrice) &&
          (f.minChg == null || r.changePct >= f.minChg) &&
          (f.maxChg == null || r.changePct <= f.maxChg) &&
          (f.minVol == null || r.volume >= f.minVol) &&
          (f.minCap == null || (r.marketCap || 0) >= f.minCap) &&
          (!f.sector || r.sector === f.sector) &&
          (!sc.scan || sc.scan[r.symbol]?.pass),
      )
      .sort(
        (a, b) =>
          sc.dir *
          (typeof a[sc.sort] === "string"
            ? a[sc.sort].localeCompare(b[sc.sort])
            : (a[sc.sort] || 0) - (b[sc.sort] || 0)),
      );
  }
  function renderScreener() {
    const sectors = [
      ...new Set(sc.rows.map((r) => r.sector).filter(Boolean)),
    ].sort();
    const n = (k, label, w = 80) =>
      `<label class="field">${label}<input data-f="${k}" type="number" step="any" style="width:${w}px" value="${sc.filters[k] ?? ""}"></label>`;
    bottom.innerHTML = `<div class="pad"><div class="row-flex">
      <label class="field">Market<select id="scU"><option value="crypto">Crypto (USDT pairs)</option><option value="us">US stocks</option><option value="etf">US ETFs</option></select></label>
      <label class="field">Search<input data-f="q" value="${esc(sc.filters.q || "")}" style="width:120px"></label>
      ${n("minPrice", "Price from")}${n("maxPrice", "Price to")}${n("minChg", "Change % from", 70)}${n("maxChg", "Change % to", 70)}${n("minVol", "Min volume", 100)}${sc.universe !== "crypto" ? n("minCap", "Min market cap", 110) : ""}
      ${sectors.length > 1 ? `<label class="field">Sector<select data-f="sector"><option value="">All</option>${sectors.map((s) => `<option ${s === sc.filters.sector ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>` : ""}
      <button class="btn" id="scRefresh" style="align-self:end">Refresh</button></div>
      <div class="row-flex" style="margin-top:8px"><span class="hint-text">Technical filter:</span><div class="rules" id="scRule" style="margin:0">${ruleHtml(sc.rule)}</div><label class="field">On<select id="scTf">${["1h", "4h", "1D", "1W"].map((t) => `<option ${t === sc.tf ? "selected" : ""}>${t}</option>`).join("")}</select></label><button class="btn primary" id="scScan" style="align-self:end">Scan top 100</button>${sc.scan ? '<button class="btn" id="scClear" style="align-self:end">Clear scan</button>' : ""}</div></div>
      <div id="scTable"></div>`;
    $("#scU").value = sc.universe;
    $("#scU").onchange = (e) => {
      sc.universe = e.target.value;
      sc.filters = {};
      renderScreener();
      loadScreener();
    };
    bottom.querySelectorAll("[data-f]").forEach((el) => {
      el.oninput = () => {
        const v = el.value.trim();
        sc.filters[el.dataset.f] =
          v === "" ? null : el.type === "number" ? Number(v) : v;
        drawScreener();
      };
    });
    bindRules($("#scRule"));
    $("#scRule .x")?.remove();
    $("#scRefresh").onclick = loadScreener;
    $("#scClear") &&
      ($("#scClear").onclick = () => {
        sc.scan = null;
        renderScreener();
      });
    $("#scScan").onclick = async () => {
      const [rule] = readRules($("#scRule"));
      sc.rule = rule;
      sc.tf = $("#scTf").value;
      const c = compileRules({ rules: [rule] });
      const prev = sc.scan;
      sc.scan = null;
      const targets = filtered()
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 100)
        .map((r) => r.symbol);
      sc.scan = prev;
      $("#scScan").textContent = `Scanning ${targets.length}…`;
      try {
        const res = await api.post("/api/scan", {
          symbols: targets,
          tf: sc.tf,
          indicators: c.indicators,
          rules: c.rules,
        });
        sc.scan = Object.fromEntries(res.map((x) => [x.symbol, x]));
        const hits = res.filter((x) => x.pass).length;
        app.toast(`${hits} of ${targets.length} match.`);
      } catch (e) {
        app.toast(esc(e.message), "err");
      }
      renderScreener();
    };
    if (!sc.rows.length) loadScreener();
    else drawScreener();
  }
  function drawScreener() {
    const box = $("#scTable");
    if (!box) return;
    const rows = filtered();
    const cols = [
      ["ticker", "Symbol"],
      ["name", "Name"],
      ["price", "Price"],
      ["changePct", "Change %"],
      ["volume", sc.universe === "crypto" ? "Volume (USDT)" : "Volume"],
      ...(sc.universe !== "crypto"
        ? [
            ["marketCap", "Market cap"],
            ["sector", "Sector"],
          ]
        : []),
    ];
    box.innerHTML = `<table class="t"><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === "name" || k === "sector" ? "l" : ""}">${l}${sc.sort === k ? (sc.dir < 0 ? " ↓" : " ↑") : ""}</th>`).join("")}</tr></thead><tbody>${rows
      .slice(0, 500)
      .map(
        (r) =>
          `<tr data-s="${esc(r.symbol)}"><td><b>${esc(r.ticker)}</b></td><td class="l muted">${esc((r.name || "").slice(0, 40))}</td><td>${fmtPrice(r.price)}</td><td class="${r.changePct >= 0 ? "up" : "down"}">${fmtPct(r.changePct)}</td><td>${fmtNum(r.volume, 0)}</td>${sc.universe !== "crypto" ? `<td>${fmtNum(r.marketCap, 0)}</td><td class="l muted">${esc(r.sector)}</td>` : ""}</tr>`,
      )
      .join(
        "",
      )}</tbody></table><div class="pad hint-text">${rows.length} match${rows.length === 1 ? "" : "es"}${rows.length > 500 ? " (showing 500)" : ""}. Click a row to open its chart.${sc.universe !== "crypto" ? " Live prices for the 200 largest companies; the rest show the last close." : ""}</div>`;
    box.querySelector("thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.k;
      if (!k) return;
      sc.dir = sc.sort === k ? -sc.dir : -1;
      sc.sort = k;
      drawScreener();
    };
    box.querySelector("tbody").onclick = (e) => {
      const s = e.target.closest("tr")?.dataset.s;
      if (s) app.setSymbol(s);
    };
  }

  // ======================= HEATMAP =======================
  const hm = { universe: "us", size: "marketCap", color: "session", stables: false, data: null, timer: 0 };
  // TradingView's heatmap. US stocks: the 200 largest by sector, coloured by the regular session's
  // change (today's once the market opens), or by the pre-market or after-hours move. Crypto: the
  // 100 largest coins by market cap, coloured by the 24h change. Refreshes every 30 seconds while
  // it's on screen. Data: /api/heatmap (lib/heatmap.js).
  const HM_CAP = 3;
  const HM_BASE = [66, 69, 80],
    HM_UP = [8, 153, 129],
    HM_DN = [242, 54, 69];
  const hmColor = (ch) => {
    const t = Math.max(-1, Math.min(1, ch / HM_CAP)),
      tgt = t >= 0 ? HM_UP : HM_DN,
      k = Math.abs(t);
    return `rgb(${HM_BASE.map((b, i) => Math.round(b + (tgt[i] - b) * k)).join(",")})`;
  };
  const hmChange = (r) => (hm.universe === "us" && hm.color === "ext" ? r.extChangePct : r.changePct);
  function hmNote() {
    const d = hm.data;
    if (!d) return "Loading…";
    const at = d.asOf ? ` Updated ${new Date(d.asOf).toLocaleTimeString()}.` : "";
    if (d.universe === "crypto") {
      if (d.sizedBy === "volume") return `${d.note}${at}`;
      const stale = d.capsAt && Date.now() - d.capsAt > 10 * 60e3 ? ` Market caps from ${new Date(d.capsAt).toLocaleTimeString()} (CoinGecko isn't answering).` : "";
      return `Largest coins by market cap (CoinGecko). Price and 24h change live from Binance where the coin trades there.${hm.stables ? "" : " Stablecoins hidden."}${at}${stale}`;
    }
    const s = String(d.session || "");
    if (d.open) return `US market open: colour is today's change, live.${at}`;
    const ext = /after/i.test(s) ? "after-hours" : "pre-market";
    if (hm.color === "ext") return `Colour is the ${ext} move since the last close.${at}`;
    return `${/pre/i.test(s) ? "Before the open" : /after/i.test(s) ? "After the close" : "Market closed"}: colour is the last regular session's change${d.lastSession ? ` (${d.lastSession})` : ""}. Choose ${ext === "pre-market" ? "Pre-market" : "After-hours"} change to see moves since.${at}`;
  }
  async function renderHeatmap() {
    const us = hm.universe === "us",
      d = hm.data?.universe === hm.universe ? hm.data : null;
    const extLabel = /after/i.test(d?.session || "") ? "After-hours change %" : "Pre-market change %";
    bottom.innerHTML = `<div class="pad row-flex hm-bar"><label class="field">Market<select id="hmU"><option value="us">US stocks (200 largest)</option><option value="crypto">Crypto (100 largest)</option></select></label><label class="field">Size by<select id="hmS"><option value="marketCap">Market cap</option><option value="volume">Volume</option></select></label>${
      us ? `<label class="field">Colour by<select id="hmCol"><option value="session">Change %</option><option value="ext" ${d && d.open ? "disabled" : ""}>${extLabel}</option></select></label>` : `<label class="field">Colour by<select disabled><option>24h change %</option></select></label><label class="hm-stable"><input type="checkbox" id="hmStable" ${hm.stables ? "checked" : ""}> Stablecoins</label>`
    }<div class="hm-legend" title="Grey means little change"><span>-${HM_CAP}%</span><i style="background:linear-gradient(90deg, ${hmColor(-HM_CAP)}, ${hmColor(0)}, ${hmColor(HM_CAP)})"></i><span>+${HM_CAP}%</span></div></div><div class="hm-note hint-text" id="hmNote">${esc(hmNote())}</div><div class="heatmap-wrap" style="height:calc(100% - 86px)"><canvas id="hmC"></canvas></div>`;
    $("#hmU").value = hm.universe;
    $("#hmS").value = hm.size;
    if ($("#hmCol")) $("#hmCol").value = hm.color === "ext" && !(d && d.open) ? "ext" : "session";
    $("#hmU").onchange = (e) => {
      hm.universe = e.target.value;
      hm.data = null;
      renderHeatmap();
    };
    $("#hmS").onchange = (e) => {
      hm.size = e.target.value;
      drawHeatmap();
    };
    if ($("#hmCol"))
      $("#hmCol").onchange = (e) => {
        hm.color = e.target.value;
        $("#hmNote").textContent = hmNote();
        drawHeatmap();
      };
    if ($("#hmStable"))
      $("#hmStable").onchange = (e) => {
        hm.stables = e.target.checked;
        loadHeatmap();
      };
    if (d) drawHeatmap();
    await loadHeatmap();
    // one refresh timer, only while the heatmap is on screen and the tab is visible
    clearInterval(hm.timer);
    hm.timer = setInterval(() => {
      if (bottomTab !== "heatmap" || bottomEl.classList.contains("collapsed") || !$("#hmC")) {
        clearInterval(hm.timer);
        hm.timer = 0;
        return;
      }
      if (!document.hidden) loadHeatmap();
    }, 30000);
  }
  async function loadHeatmap() {
    const u = hm.universe;
    try {
      const d = await api.get(`/api/heatmap?universe=${u}${u === "crypto" && hm.stables ? "&stables=1" : ""}`);
      if (u !== hm.universe || !$("#hmC")) return;
      const firstUs = u === "us" && hm.data?.universe !== "us";
      hm.data = d;
      if (d.open && hm.color === "ext") hm.color = "session";
      // the colour menu's wording depends on the session, so draw the bar again the first time
      if (firstUs && $("#hmCol") && /after/i.test(d.session || "")) return renderHeatmap();
      const sel = $("#hmCol");
      if (sel) sel.querySelector('[value="ext"]').disabled = !!d.open;
      $("#hmNote").textContent = hmNote();
      drawHeatmap();
    } catch (e) {
      const n = $("#hmNote");
      if (n) n.textContent = `Heatmap data unavailable: ${e.message}`;
    }
  }
  function squarify(items, x, y, w, h) {
    const out = [];
    let rest = items.filter((i) => i.value > 0);
    const total = rest.reduce((a, i) => a + i.value, 0);
    if (!total) return out;
    const scale = (w * h) / total;
    let rx = x,
      ry = y,
      rw = w,
      rh = h;
    while (rest.length) {
      const short = Math.min(rw, rh);
      const row = [];
      let best = Infinity;
      for (const it of rest) {
        const test = [...row, it];
        const s = test.reduce((a, i) => a + i.value * scale, 0);
        const max = Math.max(...test.map((i) => i.value * scale)),
          min = Math.min(...test.map((i) => i.value * scale));
        const worst = Math.max(
          (short * short * max) / (s * s),
          (s * s) / (short * short * min),
        );
        if (worst > best) break;
        best = worst;
        row.push(it);
      }
      const area = row.reduce((a, i) => a + i.value * scale, 0);
      const thick = area / short;
      let off = 0;
      for (const it of row) {
        const len = (it.value * scale) / thick;
        if (rw >= rh) out.push({ ...it, x: rx, y: ry + off, w: thick, h: len });
        else out.push({ ...it, x: rx + off, y: ry, w: len, h: thick });
        off += len;
      }
      if (rw >= rh) {
        rx += thick;
        rw -= thick;
      } else {
        ry += thick;
        rh -= thick;
      }
      rest = rest.slice(row.length);
    }
    return out;
  }
  function drawHeatmap() {
    const c = $("#hmC"),
      d = hm.data;
    if (!c || !d || d.universe !== hm.universe) return;
    const dpr = window.devicePixelRatio || 1,
      W = c.clientWidth,
      H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const us = d.universe === "us";
    // crypto volume is in dollars already; a stock's is in shares
    const val = (r) => Math.max(1, hm.size === "volume" || d.sizedBy === "volume" ? r.volume * (us ? r.price : 1) : r.marketCap || r.volume);
    let tiles = [];
    if (us) {
      const bySector = {};
      for (const r of d.rows) (bySector[r.sector || "Other"] ||= []).push(r);
      const groups = Object.entries(bySector)
        .map(([name, rs]) => ({ name, value: rs.reduce((a, r) => a + val(r), 0), rs }))
        .sort((a, b) => b.value - a.value);
      for (const g of squarify(groups, 0, 0, W, H)) {
        tiles.push(...squarify(g.rs.map((r) => ({ ...r, value: val(r) })).sort((a, b) => b.value - a.value), g.x + 1, g.y + 14, g.w - 2, g.h - 15));
        ctx.fillStyle = css("--panel");
        ctx.fillRect(g.x, g.y, g.w, g.h);
        ctx.fillStyle = css("--muted");
        ctx.font = "600 10px -apple-system, Segoe UI, sans-serif";
        ctx.textBaseline = "top";
        if (g.w > 50) ctx.fillText(g.name.toUpperCase().slice(0, Math.floor(g.w / 7)), g.x + 4, g.y + 2);
      }
    } else tiles = squarify(d.rows.map((r) => ({ ...r, value: val(r) })).sort((a, b) => b.value - a.value), 0, 0, W, H);
    for (const t of tiles) {
      const ch = hmChange(t),
        known = Number.isFinite(ch);
      // no change data looks different from a small move (grey)
      ctx.fillStyle = known ? hmColor(ch) : "#26272b";
      ctx.fillRect(t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1);
      if (t.w > 34 && t.h > 22) {
        const fs = Math.max(10, Math.min(22, Math.sqrt(t.w * t.h) / 5));
        ctx.fillStyle = known ? "#fff" : "#9598a1";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `600 ${fs}px -apple-system, Segoe UI, sans-serif`;
        ctx.fillText(t.ticker, t.x + t.w / 2, t.y + t.h / 2 - (t.h > 40 ? fs * 0.45 : 0));
        if (t.h > 40) {
          ctx.font = `${fs * 0.75}px -apple-system, Segoe UI, sans-serif`;
          ctx.fillText(known ? fmtPct(ch) : "no data", t.x + t.w / 2, t.y + t.h / 2 + fs * 0.6);
        }
        ctx.textAlign = "left";
      }
    }
    hm.tiles = tiles;
    const at = (e) => {
      const r = c.getBoundingClientRect(),
        x = e.clientX - r.left,
        y = e.clientY - r.top;
      return tiles.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
    };
    let tip = document.querySelector(".tip");
    c.onmousemove = (e) => {
      const t = at(e);
      if (!t) {
        tip?.remove();
        tip = null;
        return;
      }
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "tip";
        document.body.appendChild(tip);
      }
      const pct = (v) => (Number.isFinite(v) ? `<span class="${v >= 0 ? "up" : "down"}">${fmtPct(v)}</span>` : '<span class="muted">no data</span>');
      const ext = us && Number.isFinite(t.extChangePct) ? `<br>${/after/i.test(d.session) ? "After hours" : "Pre-market"} ${fmtPrice(t.extPrice)} ${pct(t.extChangePct)}` : "";
      tip.innerHTML = `<b>${esc(t.ticker)}</b> ${esc(t.name || "")}<br>${fmtPrice(t.price)} ${pct(t.changePct)}${us ? "" : " in 24h"}${ext}${t.marketCap ? `<br>Market cap ${fmtNum(t.marketCap)}` : ""}${!us && t.source === "coingecko" ? '<br><span class="muted">Price from CoinGecko (not on Binance)</span>' : ""}`;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    };
    c.onmouseleave = () => {
      tip?.remove();
      tip = null;
    };
    c.onclick = (e) => {
      const t = at(e);
      if (!t) return;
      if (t.symbol) app.setSymbol(t.symbol);
      else app.openSymbolSearch(t.ticker);
    };
  }
  window.addEventListener("resize", () => {
    if (bottomTab === "heatmap") drawHeatmap();
  });

  // ======================= PAPER TRADING =======================
  // While the active chart is in bar replay, paper trading uses a separate practice account that
  // fills at the replayed bar's prices, so replay trades never mix with the live paper account.
  const replayPane = () => (app.active?.replay ? app.active : null);
  const freshAccount = () => ({ initial: 100000, cash: 100000, feePct: 0.05, positions: {}, orders: [], history: [] });
  const paper = () => (replayPane() ? (app.state.replayPaper ||= freshAccount()) : livePaper());
  const livePaper = () =>
    (app.state.paper ||= {
      initial: 100000,
      cash: 100000,
      feePct: 0.05,
      positions: {},
      orders: [],
      history: [],
    });
  const price = (s) => {
    const rp = replayPane();
    if (rp && s === rp.cfg.symbol) return rp.bars[rp.replay.index]?.close;
    return rp ? null : app.prices[s];
  };
  function paperSymbols() {
    const p = app.state.paper;
    return p
      ? [...Object.keys(p.positions), ...p.orders.map((o) => o.symbol)]
      : [];
  }
  function fill(sym, side, qty, px, note = "", acct = null) {
    const p = acct || paper();
    const rp = acct ? null : replayPane();
    const signed = side === "buy" ? qty : -qty;
    const pos = p.positions[sym] || { qty: 0, avg: 0 };
    const fee = Math.abs(qty * px) * (p.feePct / 100);
    let realized = 0;
    if (pos.qty !== 0 && Math.sign(pos.qty) !== Math.sign(signed)) {
      const closing =
        Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(pos.qty));
      realized = -closing * (px - pos.avg);
    }
    const nq = pos.qty + signed;
    if (nq === 0) delete p.positions[sym];
    else if (pos.qty === 0 || Math.sign(nq) !== Math.sign(pos.qty))
      p.positions[sym] = { qty: nq, avg: px };
    else if (Math.sign(signed) === Math.sign(pos.qty))
      p.positions[sym] = {
        qty: nq,
        avg: (pos.qty * pos.avg + signed * px) / nq,
      };
    else p.positions[sym] = { qty: nq, avg: pos.avg };
    p.cash -= signed * px + fee;
    p.history.unshift({
      time: rp ? rp.bars[rp.replay.index].time * 1000 : Date.now(),
      symbol: sym,
      side,
      qty,
      price: px,
      fee,
      realized: realized - fee,
      note,
    });
    p.history = p.history.slice(0, 500);
    app.persist();
    // Chart settings, Trading: the execution sound, and fills shown unless only rejections are.
    const cs = app.settings.chart || {};
    if (cs.execSound) playSound(cs.execSoundName, cs.execVolume);
    if (!cs.rejectOnly)
      app.toast(
        `Paper ${side} ${fmtNum(qty, 4)} ${ticker(sym)} at ${fmtPrice(px)}`,
      );
    paperChanged();
  }
  // The charts draw positions, orders and fills, so they hear about every change.
  function paperChanged() {
    for (const pane of app.panes) pane.extras?.tradeChanged();
  }
  function checkOrders(sym, px) {
    const p = app.state.paper;
    if (!p?.orders.length) return;
    let changed = false;
    for (const o of [...p.orders]) {
      if (o.symbol !== sym) continue;
      const hit =
        o.type === "limit"
          ? o.side === "buy"
            ? px <= o.price
            : px >= o.price
          : o.side === "buy"
            ? px >= o.price
            : px <= o.price;
      if (!hit) continue;
      p.orders = p.orders.filter((x) => x !== o && (!o.oco || x.oco !== o.oco));
      fill(
        sym,
        o.side,
        o.qty,
        o.type === "limit" ? o.price : px,
        o.note || `${o.type} order`,
        p,
      );
      changed = true;
    }
    if (changed && bottomTab === "paper") renderPaper();
  }
  app.priceListeners.add((sym, px) => {
    checkOrders(sym, px);
    if (
      bottomTab === "paper" &&
      !bottomEl.classList.contains("collapsed") &&
      app.state.paper?.positions[sym]
    )
      drawPaperNumbers();
  });
  function equity() {
    const p = paper();
    return (
      p.cash +
      Object.entries(p.positions).reduce(
        (a, [s, pos]) => a + pos.qty * (price(s) ?? pos.avg),
        0,
      )
    );
  }
  function drawPaperNumbers() {
    const p = paper();
    const eq = equity();
    const el = $("#ppEq");
    if (el) {
      el.innerHTML = `<div class="stat"><div class="k">Equity</div><div class="v">${fmtPrice(eq)}</div></div><div class="stat"><div class="k">Cash</div><div class="v">${fmtPrice(p.cash)}</div></div><div class="stat"><div class="k">Total P&amp;L</div><div class="v ${eq >= p.initial ? "up" : "down"}">${fmtPrice(eq - p.initial)} (${fmtPct(((eq - p.initial) / p.initial) * 100)})</div></div>`;
    }
    const pos = $("#ppPos");
    if (pos) {
      pos.innerHTML =
        Object.entries(p.positions)
          .map(([s, x]) => {
            const px = price(s) ?? x.avg,
              pnl = x.qty * (px - x.avg);
            return `<tr data-s="${esc(s)}"><td><b>${esc(ticker(s))}</b></td><td>${x.qty > 0 ? "Long" : "Short"}</td><td>${fmtNum(Math.abs(x.qty), 4)}</td><td>${fmtPrice(x.avg)}</td><td>${fmtPrice(px)}</td><td class="${pnl >= 0 ? "up" : "down"}">${fmtPrice(pnl)} (${fmtPct(((px - x.avg) / x.avg) * 100 * Math.sign(x.qty))})</td><td><button class="btn small" data-close="${esc(s)}">Close</button></td></tr>`;
          })
          .join("") ||
        '<tr><td colspan="7" class="l muted">No open positions.</td></tr>';
    }
  }
  function renderPaper() {
    const p = paper();
    const sym = app.active?.cfg.symbol || "";
    const px = price(sym) ?? app.active?.bars.at(-1)?.close;
    bottom.innerHTML = `<div class="tester"><div class="left">
      <h4 style="margin-top:0">Order ticket · ${esc(ticker(sym))} ${px ? `<span class="muted">${fmtPrice(px)}</span>` : ""}</h4>
      <div class="row-flex"><label class="field">Type<select id="ppType"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option></select></label><label class="field">Price<input id="ppPrice" type="number" step="any" value="${px ? Number(px.toPrecision(6)) : ""}" style="width:110px"></label><label class="field">Amount ($)<input id="ppAmt" type="number" step="any" value="${app.settings.orderAmount || 1000}" style="width:100px"></label></div>
      <div class="row-flex" style="margin-top:6px"><label class="field">Stop loss % (optional)<input id="ppSl" type="number" step="any" style="width:90px"></label><label class="field">Take profit % (optional)<input id="ppTp" type="number" step="any" style="width:90px"></label></div>
      <div class="row-flex" style="margin-top:10px"><button class="btn primary" id="ppBuy" style="background:var(--up);border-color:var(--up)">Buy</button><button class="btn primary" id="ppSell" style="background:var(--down);border-color:var(--down)">Sell / short</button></div>
      <h4>Account</h4><div class="row-flex"><label class="field">Starting balance<input id="ppInit" type="number" value="${p.initial}" style="width:110px"></label><label class="field">Fee % per trade<input id="ppFee" type="number" step="any" value="${p.feePct}" style="width:80px"></label><button class="btn danger" id="ppReset" style="align-self:end">Reset account</button></div>
      <p class="hint-text">${replayPane() ? `<b>Replay trading.</b> Orders fill at the replayed bars' prices in a separate practice account. Step or play the replay to fill limit and stop orders. Exit replay to go back to your live paper account.` : "Simulated fills at the live price. No real money, no exchange connection."}</p>
    </div><div class="right"><div class="stats" id="ppEq"></div>
      <h4>Positions</h4><table class="t"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg price</th><th>Last</th><th>P&amp;L</th><th></th></tr></thead><tbody id="ppPos"></tbody></table>
      <h4>Working orders</h4><table class="t"><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Price</th><th>Qty</th><th></th></tr></thead><tbody>${p.orders.map((o) => `<tr><td><b>${esc(ticker(o.symbol))}</b></td><td>${o.side}</td><td>${o.type}${o.oco ? " (bracket)" : ""}</td><td>${fmtPrice(o.price)}</td><td>${fmtNum(o.qty, 4)}</td><td><button class="btn small" data-cancel="${o.id}">Cancel</button></td></tr>`).join("") || '<tr><td colspan="6" class="l muted">None.</td></tr>'}</tbody></table>
      <h4>History</h4><table class="t"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Realised</th></tr></thead><tbody>${p.history
        .slice(0, 100)
        .map(
          (h) =>
            `<tr><td>${new Date(h.time).toLocaleString()}</td><td>${esc(ticker(h.symbol))}</td><td>${h.side}</td><td>${fmtNum(h.qty, 4)}</td><td>${fmtPrice(h.price)}</td><td class="${h.realized >= 0 ? "up" : "down"}">${h.realized ? fmtPrice(h.realized) : ""}</td></tr>`,
        )
        .join("")}</tbody></table>
    </div></div>`;
    drawPaperNumbers();
    const place = async (side) => {
      const type = $("#ppType").value,
        amt = Number($("#ppAmt").value);
      let cur = price(sym) ?? app.active?.bars.at(-1)?.close;
      if (!cur) {
        try {
          cur = (await api.quotes([sym]))[sym]?.price;
        } catch {
          /* none */
        }
      }
      if (!cur || !(amt > 0))
        return app.toast("Need a live price and an amount.", "err");
      app.settings.orderAmount = amt;
      const qty = amt / cur;
      const sl = Number($("#ppSl").value),
        tp = Number($("#ppTp").value);
      const entry = type === "market" ? cur : Number($("#ppPrice").value);
      const exitSide = side === "buy" ? "sell" : "buy",
        dir = side === "buy" ? 1 : -1;
      const addBracket = () => {
        const oco = sl > 0 && tp > 0 ? `oco${Date.now()}` : null;
        if (sl > 0)
          paper().orders.push({
            id: `o${Date.now()}s`,
            symbol: sym,
            side: exitSide,
            type: "stop",
            price: entry * (1 - (dir * sl) / 100),
            qty,
            oco,
            note: "stop loss",
          });
        if (tp > 0)
          paper().orders.push({
            id: `o${Date.now()}t`,
            symbol: sym,
            side: exitSide,
            type: "limit",
            price: entry * (1 + (dir * tp) / 100),
            qty,
            oco,
            note: "take profit",
          });
      };
      if (type === "market") {
        fill(sym, side, qty, cur);
        addBracket();
      } else {
        if (!(entry > 0)) return app.toast("Set a price for the order.", "err");
        paper().orders.push({
          id: `o${Date.now()}`,
          symbol: sym,
          side,
          type,
          price: entry,
          qty: amt / entry,
        });
        addBracket();
        app.toast(`${type} ${side} order placed.`);
      }
      app.persist();
      renderPaper();
      refreshQuotes();
      paperChanged();
    };
    $("#ppBuy").onclick = () => place("buy");
    $("#ppSell").onclick = () => place("sell");
    $("#ppReset").onclick = () => {
      if (
        !confirm(
          "Reset the paper account? Positions, orders and history are cleared.",
        )
      )
        return;
      app.state[replayPane() ? "replayPaper" : "paper"] = {
        initial: Number($("#ppInit").value) || 100000,
        cash: Number($("#ppInit").value) || 100000,
        feePct: Number($("#ppFee").value) || 0,
        positions: {},
        orders: [],
        history: [],
      };
      app.persist();
      renderPaper();
      paperChanged();
    };
    $("#ppFee").onchange = (e) => {
      paper().feePct = Number(e.target.value) || 0;
      app.persist();
    };
    bottom.onclick = (e) => {
      const close = e.target.closest("[data-close]")?.dataset.close;
      if (close) {
        const pos = paper().positions[close];
        const px2 = price(close) ?? pos.avg;
        fill(
          close,
          pos.qty > 0 ? "sell" : "buy",
          Math.abs(pos.qty),
          px2,
          "closed",
        );
        paper().orders = paper().orders.filter((o) => o.symbol !== close);
        app.persist();
        renderPaper();
        paperChanged();
      }
      const cancel = e.target.closest("[data-cancel]")?.dataset.cancel;
      if (cancel) {
        paper().orders = paper().orders.filter((o) => o.id !== cancel);
        app.persist();
        renderPaper();
        paperChanged();
      }
    };
  }

  // ======================= INDICATOR EDITOR =======================
  const TEMPLATE = `export default {
  name: 'EMA ribbon squeeze',
  overlay: true, // true = drawn on the price chart, false = its own pane
  inputs: [
    { key: 'fast', label: 'Fast EMA', type: 'int', default: 8 },
    { key: 'slow', label: 'Slow EMA', type: 'int', default: 34 },
  ],
  outputs: [
    { key: 'fast', label: 'Fast', kind: 'line', color: '#26a69a' },
    { key: 'slow', label: 'Slow', kind: 'line', color: '#ef5350' },
  ],
  // bars: [{ time, open, high, low, close, volume }], p: your inputs,
  // ta: sma, ema, rma, wma, hma, rsi, atr, stdev, highest, lowest, crossover, crossunder, source, compute(...)
  calc(bars, p, ta) {
    const close = ta.source(bars, 'close');
    const fast = ta.ema(close, p.fast), slow = ta.ema(close, p.slow);
    const up = ta.crossover(fast, slow);
    return {
      fast,
      slow,
      markers: bars.filter((b, i) => up[i]).map((b) => ({ time: b.time, position: 'belowBar', shape: 'arrowUp', color: '#26a69a', text: 'Cross' })),
    };
  },
};
`;
  let edFile = null;
  let edOpen = null; // a file the legend's Source code button asked for
  const edListHtml = (list) =>
    list.map((c) => `<div class="card" data-file="${esc(c.file)}"><div class="top"><span>${esc(c.file)}</span><span class="row-flex"><button class="btn small" data-act="open">Edit</button><button class="btn small" data-act="add">Add to chart</button><button class="btn small danger" data-act="del">Delete</button></span></div>${c.error ? `<div class="sub down" style="white-space:pre-line">${esc(c.error)}</div>` : ""}</div>`).join("") || '<p class="hint-text">None yet.</p>';
  async function renderEditor() {
    let list = [];
    try {
      list = await api.get("/api/custom");
    } catch {
      /* none */
    }
    bottom.innerHTML = `<div class="tester"><div class="left"><div class="row-flex"><button class="btn primary" id="edNew">New indicator</button></div>
      <h4>Your indicators</h4><div id="edList">${edListHtml(list)}</div>
      <p class="hint-text">Each indicator is a small JavaScript file in the app's <code>custom</code> folder, in the format in <code>docs/custom-indicators.md</code> (start from <code>docs/indicator-template.js</code>). Each one is checked before it's saved. You can also ask your AI agent: "add an indicator to AskCharts that…" and it will write the file for you.</p></div>
      <div class="right"><div class="row-flex"><input class="in" id="edName" placeholder="Indicator name" style="flex:1"><button class="btn" id="edSave">Save</button><button class="btn primary" id="edSaveAdd">Save and add to chart</button></div><textarea class="in" id="edCode" spellcheck="false" style="flex:1;min-height:220px"></textarea><div id="edErr" class="down" style="white-space:pre-line"></div></div></div>`;
    const code = $("#edCode");
    code.value = TEMPLATE;
    $("#edName").value = "EMA ribbon squeeze";
    if (edOpen) {
      const file = edOpen;
      edOpen = null;
      code.value = await (await fetch(`/custom/${encodeURIComponent(file)}?v=${Date.now()}`)).text();
      $("#edName").value = file.replace(/\.js$/, "").replace(/-/g, " ");
      edFile = file;
    }
    code.onkeydown = (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const s = code.selectionStart;
      code.setRangeText("  ", s, code.selectionEnd, "end");
    };
    $("#edNew").onclick = () => {
      edFile = null;
      code.value = TEMPLATE.replace("'EMA ribbon squeeze'", "'My indicator'");
      $("#edName").value = "My indicator";
    };
    const save = async (add) => {
      $("#edErr").textContent = "";
      const name = $("#edName").value.trim() || "indicator";
      let src = code.value;
      try {
        const r = await api.post("/api/custom", { name, code: src });
        const def = await app.importCustom(r.file);
        if (!def)
          throw new Error(
            "Saved, but the browser could not load it. Check the code.",
          );
        app.toast(`Saved ${esc(r.file)}`);
        if (add) app.active.addIndicator(def.id);
        else app.panes.forEach((p) => p.render(false));
        edFile = r.file;
        renderEditorList();
      } catch (e) {
        $("#edErr").textContent = e.message;
      }
    };
    $("#edSave").onclick = () => save(false);
    $("#edSaveAdd").onclick = () => save(true);
    $("#edList").onclick = async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const file = btn.closest("[data-file]").dataset.file;
      if (btn.dataset.act === "open") {
        code.value = await (
          await fetch(`/custom/${encodeURIComponent(file)}?v=${Date.now()}`)
        ).text();
        $("#edName").value = file.replace(/\.js$/, "").replace(/-/g, " ");
        edFile = file;
      }
      if (btn.dataset.act === "add") {
        const def = await app.importCustom(file);
        if (def) app.active.addIndicator(def.id);
      }
      if (btn.dataset.act === "del" && confirm(`Delete ${file}?`)) {
        await api.del(`/api/custom/${encodeURIComponent(file)}`);
        renderEditor();
      }
    };
  }
  const renderEditorList = async () => {
    const box = $("#edList");
    if (box) box.innerHTML = edListHtml(await api.get("/api/custom").catch(() => []));
  };

  // Limit and stop orders in the replay account fill when a replayed bar's range reaches them.
  function checkReplayOrders(pane, bar) {
    const p = app.state.replayPaper;
    if (!p?.orders.length) return;
    for (const o of [...p.orders]) {
      if (o.symbol !== pane.cfg.symbol) continue;
      let px = null;
      if (o.type === "limit" && o.side === "buy" && bar.low <= o.price) px = Math.min(o.price, bar.open);
      if (o.type === "limit" && o.side === "sell" && bar.high >= o.price) px = Math.max(o.price, bar.open);
      if (o.type === "stop" && o.side === "buy" && bar.high >= o.price) px = Math.max(o.price, bar.open);
      if (o.type === "stop" && o.side === "sell" && bar.low <= o.price) px = Math.min(o.price, bar.open);
      if (px == null) continue;
      p.orders = p.orders.filter((x) => x !== o && (!o.oco || x.oco !== o.oco));
      fill(o.symbol, o.side, o.qty, px, o.note || `${o.type} order`);
    }
  }
  let paperRenderAt = 0;
  P.onReplayBar = (pane, bar) => {
    if (pane !== app.active || !bar) return;
    checkReplayOrders(pane, bar);
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed") && Date.now() - paperRenderAt > 250) { paperRenderAt = Date.now(); renderPaper(); }
  };
  P.onReplayChange = () => {
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed")) renderPaper();
  };

  // ---------- hooks for the app ----------
  P.showBottom = showBottom;
  // the legend's Source code button on a custom indicator: open it in the Indicator editor
  P.editCustom = (file) => {
    edOpen = file;
    showBottom("editor");
  };
  P.showSide = (t) => showSide(t, false, true);
  P.alertsChanged = () => {
    if (sideTab === "alerts") renderAlerts();
    else app.refreshAlerts();
  };
  P.sizeSide = applyWidth;
  // A Pine strategy's report in the Strategy tester, as TradingView opens it when one is added.
  P.showStrategyReport = (pane, uid) => {
    tMode = "report";
    report.uid = uid;
    if (pane === app.active) showBottom("tester");
  };
  // The chart recomputed its strategies: the report follows (only redrawn when a result changed).
  P.onStrategies = (pane) => {
    if (pane !== app.active || bottomTab !== "tester" || bottomEl.classList.contains("collapsed") || tMode !== "report") return;
    if (!report.refresh(bottom, pane, toBuilder) && bottom.querySelector(".sr")) renderTester();
  };
  // Strategies for the Indicators dialog: the tester's examples and the ones you saved. Picking
  // one loads it in the Strategy tester and runs it on the chart, as TradingView adds a strategy.
  P.strategyList = () => [
    ...Object.keys(EXAMPLE_STRATEGIES).map((name) => ({ src: `ex:${name}`, name, saved: false })),
    ...Object.keys(app.state.strategies || {}).map((name) => ({ src: `sv:${name}`, name, saved: true })),
  ];
  P.runStrategy = (src) => {
    tMode = "builder";
    showBottom("tester");
    const pick = $("#tPreset");
    if (!pick) return;
    pick.value = src;
    pick.dispatchEvent(new Event("change"));
    $("#tRun")?.click();
  };
  // Paper trading from the chart: its Buy and Sell buttons, the + menu, and position and order
  // labels (close, reverse, cancel).
  const refreshPaper = () => {
    app.persist();
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed")) renderPaper();
    paperChanged();
  };
  P.paper = {
    account: () => paper(),
    place({ symbol, side, type, price: px, qty }) {
      if (!(qty > 0) || !(px > 0)) return app.toast("Need a price and an amount.", "err");
      if (type === "market") fill(symbol, side, qty, px);
      else {
        paper().orders.push({ id: `o${Date.now()}`, symbol, side, type, price: px, qty });
        if (!(app.settings.chart || {}).rejectOnly) app.toast(`${type} ${side} order placed.`);
      }
      refreshPaper();
    },
    close(symbol) {
      const pos = paper().positions[symbol];
      if (pos) fill(symbol, pos.qty > 0 ? "sell" : "buy", Math.abs(pos.qty), price(symbol) ?? pos.avg, "closed");
      paper().orders = paper().orders.filter((o) => o.symbol !== symbol);
      refreshPaper();
    },
    reverse(symbol) {
      const pos = paper().positions[symbol];
      if (!pos) return;
      fill(symbol, pos.qty > 0 ? "sell" : "buy", Math.abs(pos.qty) * 2, price(symbol) ?? pos.avg, "reversed");
      paper().orders = paper().orders.filter((o) => o.symbol !== symbol || !/stop loss|take profit/.test(o.note || ""));
      refreshPaper();
    },
    cancel(id) {
      paper().orders = paper().orders.filter((o) => o.id !== id);
      refreshPaper();
    },
  };
  P.openAlertDialog = openAlertDialog;
  let lastSymbol = null;
  P.onActiveChange = () => {
    const sym = app.active?.cfg.symbol;
    if (sideTab === "watchlist") {
      drawRows();
      drawDetails();
      if (sym && !quotes[sym]) refreshQuotes();
    }
    if (sideTab === "objects") {
      obSig = "";
      drawObjects();
    }
    if (sym !== lastSymbol) {
      lastSymbol = sym;
      if (sideTab === "news") renderSide();
      if (!bottomEl.classList.contains("collapsed") && bottomTab === "seasonals") renderSeasonals(bottom, app);
      if (!bottomEl.classList.contains("collapsed") && bottomTab === "financials") renderFinancials(bottom, app);
    }
    if (bottomTab === "paper" && !bottomEl.classList.contains("collapsed"))
      renderPaper();
    if (bottomTab === "tester" && tMode === "report" && !bottomEl.classList.contains("collapsed")) renderTester();
  };
  P.onAlertFired = (e) => {
    if (sideTab === "alerts") renderAlerts();
    if (e && ntLog) ntLog.unshift(e);
    if (sideTab === "notifications") renderNotifications();
    else updateBadge();
  };
  P.onTheme = () => {
    renderBottom();
  };
  // From the charts: the legend moved (crosshair or a live bar), or drawings were saved.
  P.onLegend = (pane, index) => {
    if (sideTab === "objects" && pane === app.active) drawObjects(index);
  };
  P.onObjectsChange = () => {
    if (sideTab === "objects") drawObjects();
  };
  renderRail();
  showSide(sideTab);
  return P;
}
