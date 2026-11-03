// TradingView's Create alert dialog: one to five conditions (a source, an operator and what it's
// compared with), the trigger, an expiry, the message and where the alert goes. Alerts run on the
// server (lib/alerts.js), so the sources are the ones it can compute: price and the chart's own
// indicators (not Pine scripts, which live in the browser). An alert is on one symbol or on a watchlist, which
// checks every symbol on the list on its own (TradingView's watchlist alerts).
import { api, esc, ticker } from "./api.js";
import { BY_ID } from "../lib/indicators.js";
import { playSound, SOUNDS } from "./chartsettings.js";

const $ = (s, el = document) => el.querySelector(s);
const CHEVRON = '<svg viewBox="0 0 18 18" class="cs-chev"><path d="M5 7.5l4 4 4-4"/></svg>';
const icon = (d) => `<svg viewBox="0 0 18 18" class="ad-ico"><path d="${d}"/></svg>`;
const LINES2 = "M1 4.5h16M1 13.5h16";
// [operator, TradingView's label, icon]
export const ALERT_OPS = [
  ["crosses", "Crossing", "M3 15L15 3M10 3h5v5M3 3l12 12"],
  ["crossesAbove", "Crossing Up", "M1 10h16M9 16V3M5.5 6.5L9 3l3.5 3.5"],
  ["crossesBelow", "Crossing Down", "M1 8h16M9 2v13M5.5 11.5L9 15l3.5-3.5"],
  [">", "Greater Than", "M1 14h16M9 11V3M6 6l3-3 3 3"],
  ["<", "Less Than", "M1 4h16M9 7v8M6 12l3 3 3-3"],
  ["enteringChannel", "Entering Channel", `${LINES2}M9 0.5v8M6.5 6l2.5 2.5L11.5 6`],
  ["exitingChannel", "Exiting Channel", `${LINES2}M9 9.5v-9M6.5 3L9 0.5 11.5 3`],
  ["insideChannel", "Inside Channel", `${LINES2}M7 9h4M9 7v4`],
  ["outsideChannel", "Outside Channel", `${LINES2}M7 1.5h4M7 16.5h4`],
  ["movingUp", "Moving Up", "M2 14l5-5 3 3 6-7M12 5h4v4"],
  ["movingDown", "Moving Down", "M2 4l5 5 3-3 6 7M12 13h4V9"],
  ["movingUpPct", "Moving Up %", "M2 14l5-5 3 3 6-7M12 5h4v4M3 3l3 3"],
  ["movingDownPct", "Moving Down %", "M2 4l5 5 3-3 6 7M12 13h4V9M3 12l3 3"],
];
const OLD_OPS = { ">=": ["Greater Than or Equal", "M1 14h16M1 16h16M9 11V3M6 6l3-3 3 3"], "<=": ["Less Than or Equal", "M1 2h16M1 4h16M9 7v8M6 12l3 3 3-3"] };
const OP = Object.fromEntries(ALERT_OPS.map(([k, l, d]) => [k, [l, d]]));
export const opLabel = (op) => (OP[op] || OLD_OPS[op])?.[0] || op;
const opIcon = (op) => icon((OP[op] || OLD_OPS[op])?.[1] || "");
export const isChannel = (op) => /Channel$/.test(op);
export const isMoving = (op) => /^moving/.test(op);
const isPct = (op) => /Pct$/.test(op);

// TradingView's triggers on the server's four: once, once per bar, once per bar close, once a minute.
export const TRIGGERS = [
  ["once", "Once only", "Fires one time, then stops."],
  ["oncePerBar", "Every time", "Fires each time the condition is met, up to once per bar."],
  ["oncePerBarClose", "Once per bar close", "Fires when a bar closes with the condition met."],
  ["oncePerMinute", "Once per minute", "Fires at most once a minute while the condition holds."],
];
const EXPIRY = [
  [0, "Open-ended"],
  [86400e3, "In 1 day"],
  [7 * 86400e3, "In 1 week"],
  [30 * 86400e3, "In 1 month"],
  [90 * 86400e3, "In 3 months"],
];
const PLACEHOLDERS = ["ticker", "exchange", "interval", "close", "open", "high", "low", "volume", "time", "timenow"];
const PRICE_FIELDS = ["close", "open", "high", "low", "volume", "hl2", "hlc3", "ohlc4"];

const shortName = (def) => /\(([^)]+)\)$/.exec(def.name)?.[1].split(" / ")[0] || def.name;
// an indicator that computes only some outputs for its settings (XRPL Network: the one Show picks) offers those
const outputsOf = (def, params = {}) => [
  ...def.outputs.filter((o) => !def.outputsFor || def.outputsFor(params).includes(o.key)).map((o) => [o.key, o.label || o.key]),
  ...(def.id === "supertrend" ? [["direction", "Direction"]] : []),
];
const filled = (id, params) => {
  const def = BY_ID[id];
  return JSON.stringify(Object.fromEntries((def?.inputs || []).map((i) => [i.key, params?.[i.key] ?? i.default])));
};
const badge = (sym) => {
  const t = ticker(sym);
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="wl-badge" style="--h:${h}">${esc((t.match(/[A-Z0-9]/i) || ["?"])[0].toUpperCase())}</span>`;
};
const LIST_ICON = '<svg viewBox="0 0 18 18" class="ad-ico ad-listico"><path d="M6.5 4.5h9M6.5 9h9M6.5 13.5h9M2.5 4.5h1M2.5 9h1M2.5 13.5h1"/></svg>';

// The chart's indicators an alert can use. Pine scripts, indicators on another indicator and ones on
// another interval are left out: the server can't compute those. XRPL On chain is in: the server reads the
// same store the chart does.
function chartSources(p) {
  const out = [];
  for (const ind of p?.cfg.indicators || []) {
    const def = BY_ID[ind.id];
    if (!def?.outputs?.length || String(ind.id).startsWith("pine:")) continue;
    if (String(ind.params?.source || "").startsWith("ind:") || (ind.tf && ind.tf !== p.cfg.tf)) continue;
    const outs = outputsOf(def, ind.params || {});
    // one value picked by a setting the legend doesn't show (XRPL Network's Show): the name says which
    const which = def.outputsFor && outs.length === 1 ? `: ${outs[0][1]}` : "";
    out.push({ uid: ind.uid, id: ind.id, params: { ...(ind.params || {}) }, label: `${shortName(def)} ${p.indicatorParamsLabel(ind)}`.trim() + which, outs });
  }
  return out;
}

// ---------- operands: {kind: price|value|ind|line} to and from the server's form ----------
function compile(conds) {
  const indicators = {};
  const ref = (o) => {
    if (o.kind === "line") return { line: o.line };
    if (o.kind === "value") return Number(o.v);
    if (o.kind === "price") return o.field;
    const key = `${o.id}_${Object.values(o.params || {}).join("_")}`.replace(/[^a-z0-9_]/gi, "_");
    indicators[key] = { id: o.id, params: o.params || {} };
    return `${key}.${o.output}`;
  };
  const conditions = conds.map((c) => ({
    left: ref(c.left),
    op: c.op,
    right: isMoving(c.op) ? Number(c.right.v) : ref(c.right),
    ...(isChannel(c.op) ? { right2: ref(c.right2) } : {}),
    ...(isMoving(c.op) ? { bars: Math.max(1, Math.round(Number(c.bars) || 1)) } : {}),
  }));
  return { conditions, indicators };
}
function toOperand(x, indicators = {}) {
  if (x && typeof x === "object" && x.line) return { kind: "line", line: x.line, label: "Drawn line" };
  if (typeof x === "number") return { kind: "value", v: x };
  if (PRICE_FIELDS.includes(x)) return { kind: "price", field: x };
  const [k, out] = String(x).split(".");
  const s = indicators[k];
  const def = BY_ID[s?.id];
  if (!def) return { kind: "value", v: 0 };
  return { kind: "ind", id: s.id, params: { ...(s.params || {}) }, output: out || outputsOf(def, s.params || {})[0][0] };
}
const conditionsOf = (a) => (Array.isArray(a.conditions) && a.conditions.length ? a.conditions : [{ left: a.left, op: a.op, right: a.right }]);

export function openAlertDialog(app, preset = {}) {
  const p = app.active;
  if (!p) return;
  const srcs = chartSources(p);
  const edit = preset.edit || null;
  const tb = app.drawToolbar;

  // ---- values on the chart, for the defaults ----
  const lastOf = (o) => {
    const bar = p.shown?.at(-1);
    if (o?.kind === "ind") {
      const s = srcFor(o);
      const arr = s && p.indResults?.[s.uid]?.[o.output];
      for (let i = (arr?.length || 0) - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
      return NaN;
    }
    if (o?.kind === "price" && bar && Number.isFinite(bar[o.field])) return bar[o.field];
    return bar?.close ?? NaN;
  };
  const nice = (v, o) => {
    if (!Number.isFinite(v)) return 0;
    if (o?.kind === "price" && o.field !== "volume") {
      const n = Number(String(p.formatPrice(v)).replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
    return Number(v.toPrecision(6));
  };
  const valueNear = (o, k = 1) => ({ kind: "value", v: nice(lastOf(o) * k, o) });
  const freshCond = (c = {}) => {
    const left = c.left || { kind: "price", field: "close" };
    return {
      left,
      op: c.op || "crosses",
      right: c.right || valueNear(left),
      right2: c.right2 || valueNear(left, 0.99),
      bars: c.bars || 1,
    };
  };

  // ---- the dialog's state; sub-pages and a symbol change all work from this ----
  const st = preset.state || (() => {
    if (edit) {
      const conds = conditionsOf(edit).map((c) =>
        freshCond({
          left: toOperand(c.left, edit.indicators),
          op: c.op,
          right: typeof c.right === "number" ? { kind: "value", v: c.right } : toOperand(c.right, edit.indicators),
          right2: c.right2 != null ? toOperand(c.right2, edit.indicators) : null,
          bars: c.bars,
        }),
      );
      return {
        editId: edit.id,
        symbol: edit.symbol || p.cfg.symbol,
        watchlist: edit.watchlist || null,
        tf: edit.tf,
        conds,
        match: edit.match || "all",
        trigger: edit.trigger || "once",
        expires: edit.expires && edit.expires > Date.now() ? edit.expires : null,
        name: edit.name || "",
        message: edit.message || "",
        autoMsg: null,
        notify: { toast: true, sound: true, desktop: true, soundName: "ding", ...(edit.notify || {}) },
        webhook: edit.webhook || "",
        hookOn: !!edit.webhook,
        page: "main",
      };
    }
    return {
      editId: null,
      symbol: preset.symbol || p.cfg.symbol,
      watchlist: preset.watchlist || null,
      tf: p.cfg.tf,
      conds: (preset.rules || [{}]).map(freshCond),
      match: "all",
      trigger: "once",
      expires: null,
      name: "",
      message: "",
      autoMsg: true,
      notify: { toast: true, sound: true, desktop: true, soundName: "ding" },
      webhook: "",
      hookOn: false,
      page: "main",
    };
  })();

  // ---- names ----
  function srcFor(o) {
    if (o?.kind !== "ind") return null;
    return srcs.find((s) => s.uid === o.uid) || srcs.find((s) => s.id === o.id && filled(s.id, s.params) === filled(o.id, o.params)) || null;
  }
  const indName = (o) => {
    const s = srcFor(o),
      def = BY_ID[o.id];
    const base = s ? s.label : def ? `${shortName(def)} ${Object.values(o.params || {}).join(" ")}`.trim() : o.id;
    const outs = def ? outputsOf(def, o.params || {}) : [];
    return outs.length > 1 ? `${base}: ${outs.find(([k]) => k === o.output)?.[1] || o.output}` : base;
  };
  const fmtV = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : "?");
  const nameOf = (o) =>
    o.kind === "price" ? (o.field === "close" ? "Price" : `Price (${o.field})`) : o.kind === "value" ? fmtV(o.v) : o.kind === "line" ? o.label || "Drawn line" : indName(o);
  const condText = (c) => {
    const left = c.left.kind === "price" && c.left.field === "close" ? "" : `${nameOf(c.left)} `;
    if (isChannel(c.op)) return `${left}${opLabel(c.op)} ${nameOf(c.right)} and ${nameOf(c.right2)}`;
    if (isMoving(c.op)) return `${left}${opLabel(c.op).replace(" %", "")} ${fmtV(c.right.v)}${isPct(c.op) ? "%" : ""} in ${c.bars} bar${Number(c.bars) === 1 ? "" : "s"}`;
    return `${left}${opLabel(c.op)} ${nameOf(c.right)}`;
  };
  const listSyms = (n = st.watchlist) => [...new Set(app.state.watchlists?.[n] || [])];
  const symHtml = () =>
    st.watchlist
      ? `${LIST_ICON}<b>${esc(st.watchlist)}</b><small>${listSyms().length} symbols</small>${CHEVRON}`
      : `${badge(st.symbol)}<b>${esc(ticker(st.symbol))}</b>${CHEVRON}`;
  // TradingView's default message: "XRPUSD Crossing 1.31334"; on a list the server puts each symbol in front
  const autoText = () => `${st.watchlist ? "" : `${ticker(st.symbol)} `}${st.conds.map(condText).join(st.match === "any" ? " or " : ", ")}`;
  if (st.autoMsg === null) st.autoMsg = !st.message || st.message === autoText();
  const message = () => (st.autoMsg ? autoText() : st.message);
  const notifyText = () =>
    ["App", st.notify.toast && "Toasts", st.notify.sound && "Sound", st.notify.desktop && "Desktop", st.hookOn && st.webhook.trim() && "Webhook"].filter(Boolean).join(", ");
  const expiryText = () =>
    st.expires ? new Date(st.expires).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Open-ended";

  // ---- the card ----
  const card = app.modal("Create alert", "", {
    foot: `<span class="spacer"></span><button class="btn ad-cancel" data-x="cancel">Cancel</button><button class="btn ad-ok" data-x="ok">${edit ? "Save" : "Create"}</button>`,
  });
  card.classList.add("ad-card");
  $("#modal").classList.add("ad-clear");
  app.onModalClose = () => $("#modal").classList.remove("ad-clear");
  const head = card.querySelector(".modal-head"),
    body = card.querySelector(".modal-body");
  head.innerHTML = `<div class="ad-title"><span>${edit ? "Edit alert on" : "Create alert on"}</span><button class="ad-sym" data-x="sym" title="Change the symbol, or alert on a watchlist">${symHtml()}</button></div>
    <button class="ad-hbtn" data-x="manager" title="Open the alerts list"><svg viewBox="0 0 18 18"><rect x="2.5" y="2.5" width="5" height="5" rx="1"/><rect x="10.5" y="2.5" width="5" height="5" rx="1"/><rect x="2.5" y="10.5" width="5" height="5" rx="1"/><path d="M13 10.5v5M10.5 13h5"/></svg></button>
    <button class="ad-hbtn" data-close title="Close"><svg viewBox="0 0 18 18"><path d="M4 4l10 10M14 4L4 14"/></svg></button>`;
  head.querySelector("[data-close]").onclick = () => app.closeModal();

  const dd = (x, label, i = "", extra = "", ico = "") =>
    `<button class="cs-dd ad-dd${extra}" data-dd="${x}"${i !== "" ? ` data-i="${i}"` : ""}>${ico}<span>${esc(label)}</span>${CHEVRON}</button>`;
  const num = (f, i, v, step = "any", min = "") => `<input class="cs-num ad-num" type="number" step="${step}"${min !== "" ? ` min="${min}"` : ""} data-f="${f}" data-i="${i}" value="${esc(v)}">`;
  const operandRow = (c, i, side, caption = "") => {
    const o = c[side];
    return `${caption ? `<div class="ad-cap">${caption}</div>` : ""}<div class="ad-pair">${dd(side, o.kind === "value" ? "Value" : nameOf(o), i, " ad-half")}${o.kind === "value" ? num(side, i, o.v) : ""}</div>`;
  };
  const condHtml = (c, i) => {
    const s = c.left.kind === "ind" ? BY_ID[c.left.id] : null;
    const outs = s ? outputsOf(s, c.left.params || {}) : [];
    let rows = `${dd("left", c.left.kind === "ind" ? (srcFor(c.left)?.label || indName(c.left)) : nameOf(c.left), i)}`;
    if (outs.length > 1) rows += dd("out", outs.find(([k]) => k === c.left.output)?.[1] || c.left.output, i);
    rows += dd("op", opLabel(c.op), i, "", opIcon(c.op));
    if (isChannel(c.op)) rows += operandRow(c, i, "right", "Upper bound") + operandRow(c, i, "right2", "Lower bound");
    else if (isMoving(c.op))
      rows += `<div class="ad-pair"><span class="ad-unit">By</span>${num("right", i, c.right.v, "any", "0")}<span class="ad-unit">${isPct(c.op) ? "%" : ""}</span></div><div class="ad-pair"><span class="ad-unit">Within</span>${num("bars", i, c.bars, "1", "1")}<span class="ad-unit">bars</span></div>`;
    else rows += operandRow(c, i, "right");
    const label = i === 0 ? "Condition" : `<button class="ad-match" data-x="match" title="Fire when all conditions hold, or any one">${st.match === "any" ? "Or" : "And"}${CHEVRON}</button>`;
    return `<div class="ad-l">${label}</div><div class="ad-c ad-cond">${rows}${i ? `<button class="ad-rm" data-x="rm" data-i="${i}" title="Remove condition"><svg viewBox="0 0 18 18"><path d="M5 5l8 8M13 5l-8 8"/></svg></button>` : ""}</div>`;
  };
  const row = (label, value, x, arrow = false, cls = "") =>
    `<div class="ad-l">${label}</div><div class="ad-c"><button class="ad-link${cls}" data-x="${x}"><span>${esc(value)}</span>${arrow ? '<svg viewBox="0 0 18 18" class="cs-chev"><path d="M7 4.5l4.5 4.5L7 13.5"/></svg>' : CHEVRON}</button></div>`;

  function render() {
    tb.closePopover();
    head.querySelector(".ad-sym").innerHTML = symHtml();
    if (st.page === "message") {
      body.innerHTML = `<div class="ad-sub"><button class="ad-back" data-x="back" title="Back"><svg viewBox="0 0 18 18"><path d="M11 4.5L6.5 9l4.5 4.5"/></svg></button><span>Message</span></div>
        <label class="ad-field"><span>Alert name</span><input class="cs-num ad-in" data-f="name" maxlength="80" placeholder="Shown in the alerts list and the pop-up" value="${esc(st.name)}"></label>
        <label class="ad-field"><span>Message</span><textarea class="cs-num ad-in ad-ta" data-f="message" rows="5">${esc(message())}</textarea></label>
        <div class="ad-ph"><span>Placeholders</span>${PLACEHOLDERS.map((k) => `<button data-ph="${k}" title="Add {{${k}}}">{{${k}}}</button>`).join("")}</div>
        <p class="ad-hint">Placeholders are filled in when the alert fires, for example {{close}} becomes the closing price.</p>`;
      return;
    }
    if (st.page === "notify") {
      const n = st.notify;
      const chk = (k, label, sub, on, dis = false) =>
        `<label class="ad-opt${dis ? " dis" : ""}"><span class="cs-chk"><input type="checkbox" data-n="${k}" ${on ? "checked" : ""} ${dis ? "disabled" : ""}><span class="cs-box"></span></span><span class="ad-opt-t"><b>${label}</b><small>${sub}</small></span></label>`;
      body.innerHTML = `<div class="ad-sub"><button class="ad-back" data-x="back" title="Back"><svg viewBox="0 0 18 18"><path d="M11 4.5L6.5 9l4.5 4.5"/></svg></button><span>Notifications</span></div>
        ${chk("app", "Notify in app", "Every alert is kept in the Alerts log.", true, true)}
        ${chk("toast", "Show toast notification", "A pop-up in the corner of the screen.", n.toast)}
        <div class="ad-optrow">${chk("sound", "Play sound", "Uses the volume from Settings, Alerts.", n.sound)}<span class="ad-sound">${dd("sound", n.soundName || "ding", "", "", "")}<button class="ad-hbtn" data-x="play" title="Play">▶</button></span></div>
        ${chk("desktop", "Desktop notification", "Your browser's notifications. It asks for permission once.", n.desktop)}
        ${chk("email", "Send email", "Not set up on this install.", false, true)}
        ${chk("hook", "Webhook URL", "Discord, Slack, Telegram or any URL that takes a POST.", st.hookOn)}
        <div class="ad-pair ad-hookrow"><input class="cs-num ad-in" data-f="webhook" placeholder="https://" value="${esc(st.webhook)}" ${st.hookOn ? "" : "disabled"}><button class="btn" data-x="test" ${st.hookOn ? "" : "disabled"}>Test</button></div>`;
      return;
    }
    const expired = edit && edit.expires && edit.expires <= Date.now() && !st.expires;
    const n = st.watchlist ? listSyms().length : 0;
    const note = st.watchlist
      ? `<p class="ad-hint ad-listnote">${n ? `Checks each of the ${n} symbol${n === 1 ? "" : "s"} on ${esc(st.watchlist)} on its own, with these conditions. A value is the same number for every symbol.` : `${esc(st.watchlist)} is empty, so this alert has nothing to check until you add symbols to it.`}</p>`
      : "";
    body.innerHTML = `${note}<div class="ad-grid">${st.conds.map(condHtml).join("")}
      <div class="ad-l"></div><div class="ad-c"><div class="ad-add">${st.conds.length < 5 ? '<button class="ad-plus" data-x="add">+ Add condition</button>' : ""}<span class="cs-help q" title="Up to 5 conditions. The alert fires when all of them hold, or any one of them (pick And or Or).">?</span></div></div>
      <div class="ad-sep"></div>
      ${row("Trigger", TRIGGERS.find(([k]) => k === st.trigger)?.[1] || st.trigger, "trigger")}
      ${row("Expiration", expired ? "Open-ended (the old date has passed)" : expiryText(), "expires", false, expired ? " down" : "")}
      ${row("Message", st.name || message(), "message", true)}
      ${row("Notifications", notifyText(), "notify", true)}
      </div>`;
  }
  // The message row follows the condition while it's the default text.
  const refreshMessageRow = () => {
    const el = body.querySelector('[data-x="message"] span');
    if (el) el.textContent = st.name || message();
  };

  // ---- popover lists (the floating toolbar's, so Esc and outside clicks close them the same way) ----
  function list(btn, items, cur, pick, cls = "") {
    const pop = tb.openPopover(
      btn,
      items.map(([v, html, sub]) => `<button data-v="${esc(v)}" class="${String(v) === String(cur) ? "on" : ""}">${html}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`).join(""),
      "ad-dd",
    );
    pop.classList.add("dtb-list", "cs-ddlist", "ad-list");
    if (cls) pop.classList.add(cls);
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${r.width}px`;
    const h = pop.offsetHeight,
      below = innerHeight - r.bottom - 8,
      above = r.top - 8;
    const room = below >= Math.min(h, 260) || below >= above ? below : above;
    pop.style.maxHeight = `${Math.max(120, room)}px`;
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 4))}px`;
    pop.style.top = `${room === below ? r.bottom + 4 : Math.max(4, r.top - 4 - pop.offsetHeight)}px`;
    pop.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    pop.onclick = (e) => {
      const it = e.target.closest("[data-v]");
      if (!it) return;
      tb.closePopover();
      pick(it.dataset.v);
    };
    return pop;
  }
  const keyOf = (o) => (o.kind === "price" ? `p:${o.field}` : o.kind === "value" ? "v" : o.kind === "line" ? "l" : srcFor(o) ? `i:${srcFor(o).uid}:${o.output}` : "x");
  // What a condition's left side can be: price and each indicator (its plot is picked below it).
  function leftItems(c) {
    const items = [["p:close", "Price"]];
    if (c.left.kind === "price" && c.left.field !== "close") items.push([`p:${c.left.field}`, esc(nameOf(c.left))]);
    for (const s of srcs) items.push([`i:${s.uid}`, esc(s.label)]);
    if (c.left.kind === "ind" && !srcFor(c.left)) items.push(["x", `${esc(indName(c.left))} <em>(not on this chart)</em>`]);
    return items;
  }
  // What it's compared with: a value, price, or any plot on the chart.
  function rightItems(o, left) {
    const items = [["v", "Value"]];
    if (!(left.kind === "price" && left.field === "close")) items.push(["p:close", "Price"]);
    if (o.kind === "price" && o.field !== "close") items.push([`p:${o.field}`, esc(nameOf(o))]);
    for (const s of srcs) for (const [k, l] of s.outs) items.push([`i:${s.uid}:${k}`, esc(s.outs.length > 1 ? `${s.label}: ${l}` : s.label)]);
    if (o.kind === "line") items.push(["l", esc(o.label || "Drawn line")]);
    if (o.kind === "ind" && !srcFor(o)) items.push(["x", `${esc(indName(o))} <em>(not on this chart)</em>`]);
    return items;
  }
  const fromKey = (k, prev) => {
    if (k === "x" || k === "l") return prev;
    if (k === "v") return prev.kind === "value" ? prev : null;
    if (k.startsWith("p:")) return { kind: "price", field: k.slice(2) };
    const [, uid, out] = k.split(":");
    const s = srcs.find((x) => x.uid === uid);
    return { kind: "ind", id: s.id, params: { ...s.params }, uid, output: out || s.outs[0][0] };
  };

  function openDd(btn) {
    const x = btn.dataset.dd,
      i = Number(btn.dataset.i),
      c = st.conds[i];
    if (x === "left") {
      const cur = c.left.kind === "ind" ? (srcFor(c.left) ? `i:${srcFor(c.left).uid}` : "x") : keyOf(c.left);
      return list(btn, leftItems(c), cur, (k) => {
        const o = fromKey(k, c.left);
        if (!o || keyOf(o) === keyOf(c.left)) return;
        c.left = o;
        // TradingView puts the new source's current value in the value box
        if (c.right.kind === "value" && !isMoving(c.op)) c.right = valueNear(o);
        if (c.right2?.kind === "value") c.right2 = valueNear(o, 0.99);
        render();
      });
    }
    if (x === "out") {
      const def = BY_ID[c.left.id];
      return list(btn, outputsOf(def, c.left.params || {}).map(([k, l]) => [k, esc(l)]), c.left.output, (k) => {
        c.left = { ...c.left, output: k };
        if (c.right.kind === "value" && !isMoving(c.op)) c.right = valueNear(c.left);
        render();
      });
    }
    if (x === "op") {
      const items = ALERT_OPS.map(([k, l, d]) => [k, `${icon(d)}<span>${esc(l)}</span>`]);
      if (OLD_OPS[c.op]) items.push([c.op, `${opIcon(c.op)}<span>${esc(opLabel(c.op))}</span>`]);
      return list(btn, items, c.op, (k) => {
        const was = c.op;
        c.op = k;
        if (isMoving(k) && !isMoving(was)) c.right = { kind: "value", v: isPct(k) ? 1 : nice(Math.abs(lastOf(c.left)) * 0.01, c.left) };
        else if (isMoving(k) && isPct(k) !== isPct(was)) c.right = { kind: "value", v: isPct(k) ? 1 : nice(Math.abs(lastOf(c.left)) * 0.01, c.left) };
        else if (!isMoving(k) && isMoving(was)) c.right = valueNear(c.left, isChannel(k) ? 1.01 : 1);
        else if (isChannel(k) && !isChannel(was) && c.right.kind === "value") c.right = valueNear(c.left, 1.01);
        if (isChannel(k) && !c.right2) c.right2 = valueNear(c.left, 0.99);
        render();
      }, "ad-oplist");
    }
    if (x === "right" || x === "right2") {
      const o = c[x];
      return list(btn, rightItems(o, c.left), keyOf(o), (k) => {
        const n = fromKey(k, o) || valueNear(c.left, x === "right2" ? 0.99 : isChannel(c.op) ? 1.01 : 1);
        c[x] = n;
        render();
      });
    }
    if (x === "sound")
      return list(btn, Object.keys(SOUNDS).map((k) => [k, k]), st.notify.soundName, (k) => {
        st.notify.soundName = k;
        playSound(k, app.settings.chart.alertVolume ?? 50);
        render();
      });
  }

  function expiryPop(btn) {
    const pad = (n) => String(n).padStart(2, "0");
    const d = new Date(st.expires || Date.now() + 30 * 86400e3);
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const pop = list(btn, EXPIRY.map(([ms, l]) => [ms, esc(l)]), st.expires ? -1 : 0, (v) => {
      st.expires = Number(v) ? Date.now() + Number(v) : null;
      render();
    });
    pop.insertAdjacentHTML("beforeend", `<hr><div class="ad-custom"><input type="datetime-local" class="cs-num" value="${local}"><button class="btn ad-ok">Set</button></div>`);
    const inp = pop.querySelector("input");
    pop.querySelector(".ad-custom button").onclick = () => {
      const t = new Date(inp.value).getTime();
      if (!Number.isFinite(t) || t <= Date.now()) return app.toast("Pick a time in the future.", "err");
      st.expires = t;
      tb.closePopover();
      render();
    };
  }

  async function save() {
    for (const c of st.conds) {
      const vals = [c.right, isChannel(c.op) ? c.right2 : null].filter((o) => o && o.kind === "value");
      if (vals.some((o) => !Number.isFinite(Number(o.v)))) return app.toast("Enter a number for each value.", "err");
      if (isMoving(c.op) && !(Number(c.right.v) > 0)) return app.toast("Moving Up and Moving Down need an amount above 0.", "err");
    }
    if (st.hookOn && st.webhook.trim() && !/^https?:\/\/\S+$/i.test(st.webhook.trim())) return app.toast("The webhook must be an http(s) URL.", "err");
    // a drawn line belongs to one symbol's chart
    if (st.watchlist && st.conds.some((c) => [c.left, c.right, isChannel(c.op) ? c.right2 : null].some((o) => o?.kind === "line")))
      return app.toast("A drawn line belongs to one chart, so an alert on a list can't use it.", "err");
    const { conditions, indicators } = compile(st.conds);
    const body = {
      ...(st.watchlist ? { watchlist: st.watchlist, symbol: "" } : { symbol: st.symbol, ...(st.editId ? { watchlist: null } : {}) }),
      tf: st.tf,
      left: conditions[0].left,
      op: conditions[0].op,
      right: conditions[0].right,
      conditions,
      match: st.match,
      indicators,
      trigger: st.trigger,
      expires: st.expires,
      name: st.name.trim(),
      message: message().trim(),
      notify: { toast: !!st.notify.toast, sound: !!st.notify.sound, desktop: !!st.notify.desktop, soundName: st.notify.soundName || "ding" },
      webhook: st.hookOn ? st.webhook.trim() : "",
    };
    try {
      if (st.editId) await api.patch(`/api/alerts/${st.editId}`, { ...body, active: true, expired: false, lastBar: null, lastBars: {}, error: null });
      else await api.post("/api/alerts", body);
    } catch (e) {
      return app.toast(esc(e.message), "err");
    }
    app.closeModal();
    app.toast(st.editId ? "Alert saved." : `Alert created on ${st.watchlist ? `the list ${esc(st.watchlist)}` : esc(ticker(st.symbol))}.`);
    if (st.notify.desktop && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
    app.panels?.alertsChanged?.();
  }

  // ---- events ----
  card.onclick = async (e) => {
    const ddBtn = e.target.closest("[data-dd]");
    if (ddBtn) return openDd(ddBtn);
    const ph = e.target.closest("[data-ph]");
    if (ph) {
      const ta = body.querySelector("textarea");
      const at = ta.selectionStart ?? ta.value.length;
      ta.value = `${ta.value.slice(0, at)}{{${ph.dataset.ph}}}${ta.value.slice(ta.selectionEnd ?? at)}`;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      return;
    }
    const b = e.target.closest("[data-x]");
    if (!b) return;
    const x = b.dataset.x;
    if (x === "cancel") return app.closeModal();
    if (x === "ok") return save();
    if (x === "add") {
      if (st.conds.length >= 5) return;
      st.conds.push(freshCond({ op: "crosses" }));
      return render();
    }
    if (x === "rm") {
      st.conds.splice(Number(b.dataset.i), 1);
      return render();
    }
    if (x === "match")
      return list(b, [["all", "And", "Every condition must hold."], ["any", "Or", "Any one condition is enough."]], st.match, (v) => {
        st.match = v;
        render();
      });
    const subOf = (k, sub) => (st.watchlist && k === "once" ? "Fires once for each symbol on the list, then stops when every one has." : sub);
    if (x === "trigger") return list(b, TRIGGERS.map(([k, l, sub]) => [k, `<span>${esc(l)}</span>`, subOf(k, sub)]), st.trigger, (v) => {
      st.trigger = v;
      render();
    }, "ad-triglist");
    if (x === "expires") return expiryPop(b);
    if (x === "message" || x === "notify") {
      st.page = x;
      return render();
    }
    if (x === "back") {
      st.page = "main";
      return render();
    }
    if (x === "play") return playSound(st.notify.soundName || "ding", app.settings.chart.alertVolume ?? 50);
    if (x === "manager") {
      app.closeModal();
      return app.panels?.showSide?.("alerts");
    }
    if (x === "sym") {
      const syms = [...new Set([p.cfg.symbol, st.symbol])];
      const items = [
        ...syms.map((s) => [`s:${s}`, `${badge(s)}<span>${esc(ticker(s))}</span>`]),
        ...Object.keys(app.state.watchlists || {}).map((n) => [`w:${n}`, `${LIST_ICON}<span>Watchlist: ${esc(n)}</span>`, `${listSyms(n).length} symbols, each checked on its own`]),
        ["search", "<span>Other symbol…</span>"],
      ];
      return list(b, items, st.watchlist ? `w:${st.watchlist}` : `s:${st.symbol}`, (v) => {
        if (v === "search") {
          // the symbol search uses this same modal, so the form comes back from `st` afterwards
          const keep = { ...st, page: "main" };
          return app.openSymbolSearch("", (sym) => openAlertDialog(app, { state: { ...keep, symbol: sym, watchlist: null }, edit }), "Alert symbol");
        }
        if (v.startsWith("w:")) st.watchlist = v.slice(2);
        else {
          st.symbol = v.slice(2);
          st.watchlist = null;
        }
        render();
      }, "ad-symlist");
    }
    if (x === "test") {
      try {
        const r = await api.post("/api/webhook-test", { url: st.webhook.trim() });
        app.toast(r.ok ? "Test message sent." : `Webhook replied HTTP ${r.status}`, r.ok ? "" : "err");
      } catch (err) {
        app.toast(esc(err.message), "err");
      }
    }
  };
  card.oninput = (e) => {
    const t = e.target,
      f = t.dataset.f,
      i = Number(t.dataset.i);
    if (f === "right" || f === "right2") {
      st.conds[i][f] = { kind: "value", v: t.value === "" ? NaN : Number(t.value) };
      refreshMessageRow();
    } else if (f === "bars") {
      st.conds[i].bars = Math.max(1, Math.round(Number(t.value) || 1));
      refreshMessageRow();
    } else if (f === "name") st.name = t.value;
    else if (f === "message") {
      st.message = t.value;
      st.autoMsg = !t.value.trim() || t.value === autoText();
    } else if (f === "webhook") st.webhook = t.value;
  };
  card.onchange = (e) => {
    const k = e.target.dataset.n;
    if (!k) return;
    if (k === "hook") {
      st.hookOn = e.target.checked;
      return render();
    }
    st.notify[k] = e.target.checked;
  };
  card.onkeydown = (e) => {
    if (e.key === "Enter" && e.target.matches("input.ad-num")) save();
  };
  render();
  const first = body.querySelector("input.ad-num");
  if (first) {
    first.focus();
    first.select();
  }
}
