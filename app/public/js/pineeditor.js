// TradingView's Pine Editor, docked in the right panel: the script name and its menu, Add to chart,
// save, a console for errors and warnings, line numbers, highlighting, and the cursor position.
// Scripts run through the interpreter in lib/pine.js and join the chart as indicators; a
// strategy's trades go to the Strategy tester.
import { esc } from "./api.js";
import { compilePine, runPine, pineIndicator, PineError } from "../lib/pine.js";
import { registerIndicator, BY_ID, INDICATORS } from "../lib/indicators.js";
import { TEMPLATES, templateCode } from "../lib/pinetemplates.js";
import { PRODUCTS } from "./products.js";

const svg = (b) => `<svg viewBox="0 0 24 24">${b}</svg>`;
const I = {
  pine: svg('<path d="M12 3l7 11H5zM8.5 14L5 20h14l-3.5-6M12 20v-6"/>'),
  min: svg('<path d="M6 17h12"/>'),
  max: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  restore: svg('<path d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  script: svg('<path d="M4 18l5-6 4 3 7-9"/>'),
  run: svg('<path d="M8 5.5l11 6.5-11 6.5z"/>'),
  save: svg('<path d="M7.5 18.5H6a4 4 0 0 1-.6-7.96A6 6 0 0 1 17 8.6a4.5 4.5 0 0 1 .5 9.9H16.5M12 12v8M8.8 15.2L12 12l3.2 3.2"/>'),
  warn: svg('<path d="M12 4l9 16H3zM12 10v4.5M12 17.2v.3"/>'),
  more: svg('<circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/>'),
  console: svg('<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10l3 2-3 2M13 15h3"/>'),
  chev: '<svg viewBox="0 0 18 18" class="pe-chev"><path d="M5 7.5l4 4 4-4"/></svg>',
  // AskCharts AI's robot, as on its button
  ai: `<svg viewBox="-1.5 0 31 28">${PRODUCTS.find((p) => p.id === "copilot").icon}</svg>`,
};
// the name in a new script's header, as TradingView puts your username there
const AUTHOR = "you";
const NEW_INDICATOR = `// This Pine Script® code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// © ${AUTHOR}

//@version=6
indicator("My script")
plot(close)
`;
const NEW_STRATEGY = `// This Pine Script® code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// © ${AUTHOR}

//@version=6
strategy("My strategy", overlay=true)

longCondition = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))
if (longCondition)
    strategy.entry("My Long Entry Id", strategy.long)

shortCondition = ta.crossunder(ta.sma(close, 14), ta.sma(close, 28))
if (shortCondition)
    strategy.entry("My Short Entry Id", strategy.short)
`;
const SUPPORTED = `<b>What runs here.</b> Pine v5 and v6 indicator() and strategy() scripts: variables, var, if, for, while, switch, your own functions, tuples and history with []. Built-ins: ta.* (moving averages, RSI, MACD, stochastic, ATR, Bollinger, Keltner, Supertrend, DMI, SAR, pivots, crosses, highest/lowest, valuewhen, barssince, VWAP and more), math.*, str.*, color.*, input.*, plot, plotshape, plotchar, hline, and strategy.entry, close, close_all, exit and cancel. Orders fill at the next bar's open, as on TradingView.
<b>Not yet.</b> request.security (other symbols or timeframes), arrays, matrices and maps, methods, user types and libraries stop with a message. Labels, lines, boxes, tables, fill(), bgcolor() and barcolor() are skipped, so a script that only decorates with them still runs.`;

const KW = /\b(if|else|for|to|by|while|switch|var|varip|and|or|not|true|false|na|break|continue|import|export|method|type|int|float|bool|color|string|series|simple|const)\b/;

// Pine highlighted as HTML (comments, strings, numbers, colours, keywords, built-in namespaces).
function highlight(code) {
  const re = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(#[0-9a-fA-F]{6,8}\b)|(\b\d+\.?\d*(?:[eE][+-]?\d+)?\b)|(\b(?:ta|math|str|color|input|strategy|request|array|matrix|map|plot|shape|location|size|hline|display|barstate|syminfo|timeframe|label|line|box|table|chart|ticker|format|extend|xloc|yloc|position|text|dayofweek|currency|session|barmerge|alert|log)\.[A-Za-z_][\w.]*)|(\b[A-Za-z_]\w*(?=\s*\())|(\b[A-Za-z_]\w*\b)/g;
  let out = "",
    last = 0,
    m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [t] = m;
    const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "h" : m[4] ? "n" : m[5] ? "b" : m[6] ? "f" : KW.test(t) && t.match(KW)[0] === t ? "k" : "";
    out += cls ? `<span class="pe-${cls}">${esc(t)}</span>` : esc(t);
    last = m.index + t.length;
  }
  return `${out}${esc(code.slice(last))}\n`;
}

export class PineEditor {
  constructor(app) {
    this.app = app;
    this.maxed = false;
  }
  scripts() {
    return (this.app.state.pineScripts ||= {});
  }
  // The script open in the editor: saved ones by id; a new one is a draft until saved.
  draft() {
    let d = this.app.state.pineDraft;
    if (!d) {
      const first = Object.entries(this.scripts()).sort((a, b) => b[1].saved - a[1].saved)[0];
      d = this.app.state.pineDraft = first ? { id: first[0], name: first[1].name, code: first[1].code } : { id: null, name: "Untitled script", code: NEW_INDICATOR };
    }
    return d;
  }
  dirty() {
    const d = this.draft(),
      s = d.id && this.scripts()[d.id];
    return !s || s.code !== d.code || s.name !== d.name;
  }

  // A script gone from My scripts (an AI step undone): off the indicator list too.
  forget(id) {
    const k = INDICATORS.findIndex((x) => x.id === `pine:${id}`);
    if (k >= 0) INDICATORS.splice(k, 1);
    delete BY_ID[`pine:${id}`];
  }

  // ---- startup: every saved script joins the indicator list (silently skipping broken ones)
  registerAll() {
    for (const [id, s] of Object.entries(this.scripts())) {
      try {
        this.register(id, s.code);
      } catch {
        /* shows when opened */
      }
    }
  }
  register(id, code) {
    const compiled = compilePine(code);
    const def = pineIndicator(`pine:${id}`, compiled, () => ({ symbol: this.app.active?.cfg.symbol, tf: this.app.active?.cfg.tf, theme: this.app.settings.theme }));
    // the name it's saved under in My scripts (Rename…, a numbered copy) for the lists; the legend keeps its title
    const saved = this.scripts()[id]?.name;
    if (saved) def.saved = String(saved).slice(0, 80);
    registerIndicator(def);
    return { compiled, def };
  }
  // a new name shows at once in the Indicators dialog and the strategy report, without running it again
  relist(id) {
    const def = BY_ID[`pine:${id}`];
    if (!def) return;
    def.saved = String(this.scripts()[id]?.name || "").slice(0, 80) || undefined;
    for (const q of this.app.panes) if (q.cfg.indicators.some((x) => x.id === def.id)) q.render(false);
  }

  // ---- the panel
  mount(el) {
    this.el = el;
    el.innerHTML = `<div class="pe">
      <div class="pe-head">${I.pine}<span>Pine Editor</span><span class="spacer"></span><button data-a="min" title="Minimize">${I.min}</button><button data-a="max" title="Maximize">${this.maxed ? I.restore : I.max}</button><button data-a="close" title="Close">${I.close}</button></div>
      <div class="pe-bar"><button class="pe-name" data-a="menu" title="Script menu">${I.script}<b></b>${I.chev}</button><button class="pe-ic pe-run" data-a="run">${I.run}</button><button class="pe-ic" data-a="save" title="Save script (Ctrl+S)">${I.save}</button><span class="spacer"></span><button class="pe-ic pe-warn" data-a="console" title="Errors and warnings">${I.warn}</button><button class="pe-ic" data-a="more" title="More">${I.more}</button></div>
      <div class="pe-ed"><div class="pe-gutter"></div><div class="pe-code"><pre class="pe-hl" aria-hidden="true"></pre><textarea spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea></div></div>
      <div class="pe-console" hidden></div>
      <div class="pe-status"><button data-a="console" title="Console">${I.console}</button><span class="pe-msg"></span><span class="spacer"></span><span class="pe-pos">Line 1, Col 1</span></div>
    </div>`;
    this.ta = el.querySelector("textarea");
    this.hl = el.querySelector(".pe-hl");
    this.gutter = el.querySelector(".pe-gutter");
    this.con = el.querySelector(".pe-console");
    const d = this.draft();
    this.ta.value = d.code;
    this.paint();
    this.title();
    this.bind();
    if (this.lastLog) this.log(...this.lastLog);
  }
  title() {
    const d = this.draft(),
      el = this.el;
    if (!el) return;
    el.querySelector(".pe-name b").textContent = `${d.name}${this.dirty() ? " •" : ""}`;
    const on = this.onChart();
    const run = el.querySelector(".pe-run");
    run.title = `${on ? "Update on chart" : "Add to chart"} (Ctrl+Enter)`;
    run.classList.toggle("on", !!on);
  }
  onChart() {
    const d = this.draft();
    return d.id && this.app.active?.cfg.indicators.find((x) => x.id === `pine:${d.id}`);
  }
  paint() {
    const code = this.ta.value;
    this.hl.innerHTML = highlight(code);
    const lines = code.split("\n").length;
    if (this.gutter.childElementCount !== lines)
      this.gutter.innerHTML = Array.from({ length: lines }, (_, k) => `<div data-l="${k + 1}">${k + 1}</div>`).join("");
    this.gutter.querySelectorAll(".err").forEach((x) => x.classList.remove("err"));
    if (this.errLine) this.gutter.querySelector(`[data-l="${this.errLine}"]`)?.classList.add("err");
    this.sync();
  }
  sync() {
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
    this.gutter.scrollTop = this.ta.scrollTop;
  }
  pos() {
    const v = this.ta.value.slice(0, this.ta.selectionStart).split("\n");
    this.el.querySelector(".pe-pos").textContent = `Line ${v.length}, Col ${v.at(-1).length + 1}`;
  }
  changed() {
    const d = this.draft();
    d.code = this.ta.value;
    this.paint();
    this.title();
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.app.persist(), 800);
  }
  bind() {
    const ta = this.ta;
    ta.oninput = () => this.changed();
    ta.onscroll = () => this.sync();
    ta.onkeyup = ta.onclick = () => this.pos();
    ta.onkeydown = (e) => this.keys(e);
    this.el.querySelector(".pe").onclick = (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a) return;
      if (a === "min") return this.app.panels.showSide(null);
      if (a === "close") return this.app.panels.showSide(null);
      if (a === "max") {
        this.maxed = !this.maxed;
        this.app.panels.sizeSide();
        return this.mount(this.el);
      }
      if (a === "run") return this.addToChart();
      if (a === "save") return this.save();
      if (a === "console") return this.toggleConsole();
      if (a === "menu") return this.menu(e.target.closest("[data-a]"));
      if (a === "more") return this.moreMenu(e.target.closest("[data-a]"));
    };
    this.con.onclick = (e) => {
      const l = Number(e.target.closest("[data-line]")?.dataset.line);
      if (l) this.goto(l);
    };
  }
  keys(e) {
    const ta = this.ta,
      mod = e.metaKey || e.ctrlKey;
    e.stopPropagation();
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      return this.save();
    }
    if (mod && e.key === "Enter") {
      e.preventDefault();
      return this.addToChart();
    }
    if (mod && e.key === "/") {
      e.preventDefault();
      return this.toggleComment();
    }
    const { selectionStart: s, selectionEnd: z, value: v } = ta;
    if (e.key === "Tab") {
      e.preventDefault();
      const a = v.lastIndexOf("\n", s - 1) + 1;
      if (s === z && !e.shiftKey) ta.setRangeText("    ", s, z, "end");
      else {
        const block = v.slice(a, z);
        const next = e.shiftKey ? block.replace(/^ {1,4}/gm, "") : block.replace(/^/gm, "    ");
        ta.setRangeText(next, a, z, "select");
      }
      return this.changed();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const a = v.lastIndexOf("\n", s - 1) + 1,
        line = v.slice(a, s);
      let ind = /^\s*/.exec(line)[0];
      if (/=>\s*$/.test(line) || /^\s*(if|else|for|while|switch)\b/.test(line)) ind += "    ";
      ta.setRangeText(`\n${ind}`, s, z, "end");
      this.changed();
      return this.pos();
    }
  }
  toggleComment() {
    const ta = this.ta,
      v = ta.value,
      a = v.lastIndexOf("\n", ta.selectionStart - 1) + 1,
      z = ta.selectionEnd;
    const block = v.slice(a, z);
    const all = block.split("\n").every((l) => /^\s*\/\//.test(l) || !l.trim());
    ta.setRangeText(all ? block.replace(/^(\s*)\/\/ ?/gm, "$1") : block.replace(/^/gm, "// "), a, z, "select");
    this.changed();
  }
  goto(line) {
    const lines = this.ta.value.split("\n");
    const at = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
    this.ta.focus();
    this.ta.setSelectionRange(at, at + (lines[line - 1] || "").length);
    this.ta.scrollTop = Math.max(0, (line - 5) * 19);
    this.pos();
  }

  // ---- console
  toggleConsole(show) {
    this.con.hidden = show === undefined ? !this.con.hidden : !show;
  }
  log(kind, html, warnings = []) {
    this.lastLog = [kind, html, warnings];
    if (!this.el) return;
    this.con.innerHTML = `<div class="pe-log ${kind}">${html}</div>${warnings.map((w) => `<div class="pe-log warn">${esc(w)}</div>`).join("")}`;
    const msg = this.el.querySelector(".pe-msg");
    msg.textContent = kind === "err" ? "1 error" : warnings.length ? `${warnings.length} warning${warnings.length > 1 ? "s" : ""}` : "";
    msg.classList.toggle("warn", kind !== "err");
    this.el.querySelector(".pe-warn").classList.toggle("bad", kind === "err");
    this.toggleConsole(kind === "err" || warnings.length > 0 || kind === "ok");
  }
  fail(e) {
    const line = e instanceof PineError ? e.line : 0;
    this.errLine = line;
    this.paint();
    this.log("err", `${line ? `<button class="pe-at" data-line="${line}">Line ${line}</button> ` : ""}${esc(e.plain || e.message)}`);
    if (line) this.goto(line);
  }

  // ---- saving
  // A script is saved under an id; its indicator on the chart is pine:<id>.
  save(quiet = false) {
    const d = this.draft();
    d.code = this.ta ? this.ta.value : d.code;
    if (!d.id) d.id = `s${Date.now().toString(36)}`;
    this.scripts()[d.id] = { name: d.name, code: d.code, saved: Date.now() };
    this.app.persist();
    this.title();
    if (!quiet) this.app.toast(`Saved "${esc(d.name)}"`);
  }
  addToChart() {
    const d = this.draft(),
      p = this.app.active;
    d.code = this.ta.value;
    this.errLine = 0;
    let compiled;
    try {
      compiled = compilePine(d.code);
    } catch (e) {
      return this.fail(e);
    }
    // a first run on this chart's bars, so a mistake that only shows when running keeps its line
    if (p?.shown.length) {
      try {
        runPine(compiled, p.shown.slice(-500), {}, { symbol: p.cfg.symbol, tf: p.cfg.tf, theme: this.app.settings.theme });
      } catch (e) {
        return this.fail(e);
      }
    }
    // a new script takes the name from its indicator() or strategy() line
    if (d.name === "Untitled script" || d.name === "Untitled strategy" || !d.id) d.name = String(compiled.meta.title || d.name).slice(0, 60);
    this.save(true);
    let def;
    try {
      ({ def } = this.register(d.id, d.code));
    } catch (e) {
      if (e instanceof PineError) return this.fail(e);
      const msg = String(e.message).replace(/^This indicator doesn't follow the format[^\n]*\n- /, "").replace(/calc\(\) stopped with an error on test bars: /, "");
      const at = /^line (\d+): (.*)$/s.exec(msg);
      return this.fail(at ? new PineError(at[2], Number(at[1])) : new PineError(msg));
    }
    this.paint();
    if (!p) return;
    let ind = p.cfg.indicators.find((x) => x.id === def.id);
    const was = !!ind;
    if (ind) for (const q of this.app.panes) if (q.cfg.indicators.some((x) => x.id === def.id)) q.render(false);
    if (!ind) {
      p.addIndicator(def.id);
      ind = p.cfg.indicators.find((x) => x.id === def.id);
    }
    const res = p.indResults[ind.uid] || {};
    if (res.error) return this.fail(new PineError(res.error));
    this.log("ok", `${was ? "Updated on the chart" : "Added to the chart"}: <b>${esc(def.name)}</b>${def.strategy ? ' · results in the <button class="pe-at" data-tester>Strategy tester</button>' : ""}`, res.pineWarnings || []);
    this.con.querySelector("[data-tester]")?.addEventListener("click", () => this.showStrategy(p, ind.uid));
    this.title();
    if (def.strategy) this.showStrategy(p, ind.uid);
  }
  // A strategy's trades in the Strategy tester, and its orders on the chart.
  showStrategy(p, uid) {
    this.app.panels.showStrategyReport(p, uid);
  }

  // ---- menus
  menu(btn) {
    const tb = this.app.drawToolbar,
      d = this.draft();
    // TradingView's order: save, copy, rename, create new, open, then recently used scripts
    const recent = Object.entries(this.scripts())
      .filter(([sid]) => sid !== d.id)
      .sort((a, b) => b[1].saved - a[1].saved)
      .slice(0, 5);
    const pop = tb.openPopover(
      btn,
      `<button data-m="save"><span>Save script</span><kbd>Ctrl+S</kbd></button><button data-m="copy" ${d.id ? "" : "disabled"}><span>Make a copy…</span></button><button data-m="rename"><span>Rename…</span></button><hr><div class="pe-mh">Create new</div><button data-m="new-ind">${I.script}<span>Indicator</span></button><button data-m="new-strat">${I.run}<span>Strategy</span></button><button data-m="new-tpl">${I.run}<span>Strategy from a template…</span></button><button data-m="new-ai">${I.ai}<span>Write with AI…</span></button><button disabled title="Libraries aren't supported here yet"><span>Library</span></button><hr><button data-m="open"><span>Open script…</span></button>${recent.length ? `<div class="pe-mh">Recently used</div>${recent.map(([sid, sc]) => `<button data-recent="${esc(sid)}"><span>${esc(sc.name)}</span></button>`).join("")}` : ""}<hr><button data-m="delete" ${d.id ? "" : "disabled"}><span>Delete script</span></button>`,
      "pe-menu",
    );
    pop.classList.add("dtb-list", "pe-pop");
    this.placeUnder(pop, btn);
    pop.onclick = (e) => {
      const rid = e.target.closest("[data-recent]")?.dataset.recent;
      if (rid) {
        tb.closePopover();
        return this.openScript(rid);
      }
      const m = e.target.closest("[data-m]")?.dataset.m;
      if (!m) return;
      tb.closePopover();
      if (m === "new-ind" || m === "new-strat") this.fresh(m === "new-ind" ? NEW_INDICATOR : NEW_STRATEGY, m === "new-ind" ? "Untitled script" : "Untitled strategy");
      if (m === "open") this.openDialog();
      if (m === "new-tpl") this.templateDialog();
      // AskCharts AI opens with the request started, for them to finish
      if (m === "new-ai") this.app.copilot.compose("Write a Pine strategy that ");
      if (m === "save") this.save();
      if (m === "rename") this.nameDialog("Rename script", d.name, (n) => {
        d.name = n;
        if (d.id) {
          this.save(true);
          this.relist(d.id);
        }
        this.title();
      });
      if (m === "copy") this.nameDialog("Make a copy", `${d.name} copy`, (n) => {
        this.app.state.pineDraft = { id: null, name: n, code: this.ta.value };
        this.save(true);
        this.mount(this.el);
      });
      if (m === "delete") this.confirmDelete();
    };
  }
  moreMenu(btn) {
    const tb = this.app.drawToolbar;
    const pop = tb.openPopover(btn, `<button data-m="console"><span>${this.con.hidden ? "Show" : "Hide"} console</span></button><button data-m="help"><span>What runs here</span></button><a class="pe-link" href="https://www.tradingview.com/pine-script-reference/v6/" target="_blank" rel="noopener"><span>Pine Script reference</span></a>`, "pe-more");
    pop.classList.add("dtb-list", "pe-pop");
    this.placeUnder(pop, btn, true);
    pop.onclick = (e) => {
      const m = e.target.closest("[data-m]")?.dataset.m;
      if (!m) return;
      tb.closePopover();
      if (m === "console") this.toggleConsole();
      if (m === "help") this.log("info", SUPPORTED.replace(/\n/g, "<br>"));
    };
  }
  placeUnder(pop, btn, right = false) {
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.max(4, right ? r.right - pop.offsetWidth : r.left)}px`;
    pop.style.top = `${r.bottom + 4}px`;
  }
  fresh(code, name) {
    this.app.state.pineDraft = { id: null, name, code };
    this.errLine = 0;
    this.lastLog = null;
    this.mount(this.el);
    this.app.persist();
  }
  nameDialog(title, value, done) {
    const tb = this.app.drawToolbar,
      btn = this.el.querySelector(".pe-name");
    const pop = tb.openPopover(btn, `<div class="pe-form"><div class="pe-mh">${esc(title)}</div><input class="in" maxlength="60" value="${esc(value)}"><div class="pe-form-b"><button class="btn small" data-x="no">Cancel</button><button class="btn small primary" data-x="ok">Save</button></div></div>`, "pe-name-form");
    pop.classList.add("pe-pop");
    this.placeUnder(pop, btn);
    const inp = pop.querySelector("input");
    inp.focus();
    inp.select();
    const ok = () => {
      const n = inp.value.trim();
      if (!n) return inp.focus();
      tb.closePopover();
      done(n);
    };
    pop.querySelector("[data-x=ok]").onclick = ok;
    pop.querySelector("[data-x=no]").onclick = () => tb.closePopover();
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") ok();
      if (e.key === "Escape") tb.closePopover();
    };
  }
  confirmDelete() {
    const tb = this.app.drawToolbar,
      btn = this.el.querySelector(".pe-name"),
      d = this.draft();
    const used = this.app.panes.some((p) => p.cfg.indicators.some((x) => x.id === `pine:${d.id}`));
    const pop = tb.openPopover(btn, `<div class="pe-form"><div>Delete <b>${esc(d.name)}</b>?${used ? " It comes off the charts too." : ""}</div><div class="pe-form-b"><button class="btn small" data-x="no">Cancel</button><button class="btn small danger" data-x="ok">Delete</button></div></div>`, "pe-del");
    pop.classList.add("pe-pop");
    this.placeUnder(pop, btn);
    pop.querySelector("[data-x=no]").onclick = () => tb.closePopover();
    pop.querySelector("[data-x=ok]").onclick = () => {
      tb.closePopover();
      delete this.scripts()[d.id];
      for (const p of this.app.panes) {
        const before = p.cfg.indicators.length;
        p.cfg.indicators = p.cfg.indicators.filter((x) => x.id !== `pine:${d.id}`);
        if (p.cfg.indicators.length !== before) p.render(false);
      }
      const k = INDICATORS.findIndex((x) => x.id === `pine:${d.id}`);
      if (k >= 0) INDICATORS.splice(k, 1);
      delete BY_ID[`pine:${d.id}`];
      this.app.state.pineDraft = null;
      this.lastLog = null;
      this.app.persist();
      this.mount(this.el);
    };
  }
  // Strategy from a template: the ready-made strategies in plain words. One click puts it in the
  // editor, saves it to My scripts, adds it to the chart and opens its report in the Strategy tester.
  templateDialog() {
    const card = this.app.modal(
      "Strategy from a template",
      `<p class="hint-text">Ready-made strategies to add to the chart and backtest, no AI key needed. Each one trades the whole account from 10,000, with the fee for this chart's market, and every number is a setting you can change on the chart.</p><div class="pe-open">${TEMPLATES.map((t) => `<div class="pe-trow" data-tpl="${esc(t.id)}"><div><b>${esc(t.name)}</b><span class="pe-tabout">${esc(t.about[0].toUpperCase() + t.about.slice(1))}</span></div><span class="pe-okind">${esc(t.kind)}</span></div>`).join("")}</div>`,
    );
    card.classList.add("pe-open-card");
    card.querySelector(".pe-open").onclick = (e) => {
      const t = TEMPLATES.find((x) => x.id === e.target.closest("[data-tpl]")?.dataset.tpl);
      if (!t) return;
      this.app.closeModal();
      this.fromTemplate(t);
    };
  }
  fromTemplate(t) {
    const symbol = this.app.active?.cfg.symbol;
    const code = templateCode(t, { symbol });
    const saved = Object.entries(this.scripts());
    // the same template already in My scripts, unchanged: that one, not a copy
    const same = saved.find(([, s]) => s.name === t.name && s.code === code);
    if (same) {
      this.openScript(same[0]);
      return this.addToChart();
    }
    // the name taken (an edited copy, or the other market's fee): the next free number
    let name = t.name;
    for (let k = 2; saved.some(([, s]) => s.name === name); k++) name = `${t.name} ${k}`;
    this.fresh(name === t.name ? code : code.replace(`strategy("${t.name}"`, `strategy("${name}"`), name);
    this.addToChart();
  }
  openScript(id) {
    const s = this.scripts()[id];
    if (!s) return;
    this.app.state.pineDraft = { id, name: s.name, code: s.code };
    this.errLine = 0;
    this.lastLog = null;
    this.mount(this.el);
    this.app.persist();
  }
  openDialog() {
    const list = () => Object.entries(this.scripts()).sort((a, b) => b[1].saved - a[1].saved);
    const card = this.app.modal("Open script", `<div class="ss-box"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/></svg><input id="peQ" placeholder="Search your scripts" autocomplete="off"></div><div class="pe-open"></div>`);
    card.classList.add("pe-open-card");
    const box = card.querySelector(".pe-open"),
      q = card.querySelector("#peQ");
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const rows = list().filter(([, s]) => !t || s.name.toLowerCase().includes(t));
      box.innerHTML =
        rows
          .map(([id, s]) => {
            const kind = /\bstrategy\s*\(/.test(s.code) ? "strategy" : "indicator";
            return `<div class="pe-orow" data-id="${esc(id)}"><span class="pe-oname">${esc(s.name)}</span><span class="pe-okind">${kind}</span><span class="pe-odate">${new Date(s.saved).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></div>`;
          })
          .join("") || `<div class="ix-empty">${t ? "No scripts match." : "No saved scripts yet. Write one and press Save or Add to chart."}</div>`;
    };
    q.oninput = draw;
    box.onclick = (e) => {
      const id = e.target.closest("[data-id]")?.dataset.id;
      if (!id) return;
      this.app.closeModal();
      this.openScript(id);
    };
    draw();
    q.focus();
  }
}
