// AskCharts AI, on the right toolbar: a chat panel that answers questions about this app and the
// chart on screen, and does things on the chart when asked (agent.js runs its tools). It runs on your
// own API key, set in Settings, AskCharts AI; the key stays on the server (lib/copilot.js) and never
// comes back to the browser.
import { api, esc, ticker } from "./api.js";
import { BY_ID } from "../lib/indicators.js";
import { PRODUCTS } from "./products.js";
import { sameIndicator } from "../lib/agent-tools.js";
// agent.js (the AI's tools) loads on the first question: it imports the chart, which only runs in a
// browser, and the server's guide imports this file through Settings.
const loadAgent = () => import("./agent.js");

const $ = (s, el = document) => el.querySelector(s);
const STORE = "qt-copilot-chat";
// The same robot as AskCharts AI's button on the right toolbar, in a box wide enough for its ears
const ROBOT = `<svg viewBox="-1.5 0 31 28">${PRODUCTS.find((p) => p.id === "copilot").icon}</svg>`;
const I = {
  newChat: '<svg viewBox="0 0 24 24"><path d="M13 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V11"/><path d="M17.5 4.5l2 2L12 14l-2.5.5.5-2.5z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" class="fill"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  done: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  look: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 2.5l6 11H2z"/><path d="M8 7v3M8 11.6v.4"/></svg>',
};
// Starter prompts: things to do on the chart, and things to learn.
const SUGGEST = [
  "Show me XRP on the 4 hour with RSI and a 50 EMA",
  "Draw support and resistance on this chart",
  "Put a Fibonacci retracement on the last swing",
  "Compare BTC and ETH on the daily",
  "Explain the indicators on my chart",
  "How do I set an alert when the price crosses a level?",
  "Find a strategy for XRP that held up on bars it never saw",
  "Which indicators work best on BTC on the 4 hour?",
  "Build me an RSI strategy and backtest it",
];

// ---------- a small, safe markdown subset: everything is escaped first ----------
function inline(s) {
  return s
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.length > 1 && part.startsWith("`") && part.endsWith("`")
        ? `<code>${part.slice(1, -1)}</code>`
        : part
            .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
            .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<i>$2</i>")
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'),
    )
    .join("");
}
// a table: a row of cells (| a | b |), a row of dashes under it (|---|--:|, a colon on the right sets
// the column right, on both sides centred), then its rows. Rows without the dashes stay text.
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRow = (line) => /^\s*\|.*\|\s*$/.test(line || "");
const isRule = (line) => isRow(line) && cells(line).every((c) => /^:?-+:?$/.test(c));
function table(rows) {
  const head = cells(rows[0]),
    align = cells(rows[1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? ' class="c"' : ' class="r"') : ""));
  const row = (tag, cs) => `<tr>${head.map((_, k) => `<${tag}${align[k] || ""}>${inline(cs[k] ?? "")}</${tag}>`).join("")}</tr>`;
  return `<div class="cp-table"><table><thead>${row("th", head)}</thead><tbody>${rows
    .slice(2)
    .map((r) => row("td", cells(r)))
    .join("")}</tbody></table></div>`;
}
export function md(src) {
  const lines = esc(src).split("\n");
  let out = "",
    para = [],
    list = null,
    code = null;
  const endPara = () => {
    if (para.length) out += `<p>${para.map(inline).join("<br>")}</p>`;
    para = [];
  };
  const endList = () => {
    if (list) out += `<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`;
    list = null;
  };
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (code) {
      if (/^\s*```/.test(line)) {
        out += `<div class="cp-code"><button class="cp-copy" data-copy title="Copy">Copy</button><pre><code>${code.join("\n")}</code></pre></div>`;
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      endPara();
      endList();
      code = [];
      continue;
    }
    if (isRow(line) && isRule(lines[k + 1])) {
      endPara();
      endList();
      let end = k + 2;
      while (end < lines.length && isRow(lines[end])) end++;
      out += table(lines.slice(k, end));
      k = end - 1;
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      endPara();
      endList();
      out += `<div class="cp-h">${inline(h[1])}</div>`;
    } else if (ul || ol) {
      endPara();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) endList();
      list ||= { tag, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) {
      endPara();
      endList();
    } else {
      endList();
      para.push(line);
    }
  }
  if (code) out += `<div class="cp-code"><pre><code>${code.join("\n")}</code></pre></div>`;
  endPara();
  endList();
  return out;
}

const shortName = (def) => /\(([^)]+)\)$/.exec(def.name)?.[1].split(" / ")[0] || def.name;
const iso = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") : null);
const round = (v) => (Number.isFinite(v) ? Number(v.toPrecision(7)) : null);

export class Copilot {
  constructor(app) {
    this.app = app;
    this.cfg = null;
    this.busy = false;
    this.ctrl = null;
    this.el = null;
    this.tools = null;
    // undo points of each answer this session (not kept across a reload), the state each answer left,
    // and the open question
    this.undos = new WeakMap();
    this.after = new WeakMap();
    this.asking = null;
    // words put in the box from elsewhere (compose), kept until a panel can take them, and the cursor with them
    this.boxText = null;
    this.take = null;
    try {
      this.messages = JSON.parse(localStorage.getItem(STORE) || "[]").filter((m) => m && typeof m.content === "string");
    } catch {
      this.messages = [];
    }
  }
  save() {
    try {
      // chart pictures aren't kept: they're large, and the model doesn't need old ones
      const slim = this.messages.slice(-40).map((m) =>
        m.api ? { ...m, api: m.api.map((x) => (x.role === "tool" ? { ...x, results: x.results.map((r) => (r.image ? { id: r.id, content: "[a picture of the chart]" } : { ...r, content: String(r.content ?? "").slice(0, 1500) })) } : x)) } : m,
      );
      localStorage.setItem(STORE, JSON.stringify(slim));
    } catch {
      /* private window */
    }
  }
  async refreshConfig() {
    try {
      this.cfg = await api.get("/api/copilot/config");
    } catch {
      this.cfg = this.cfg || { hasKey: false };
    }
    if (this.el?.isConnected) this.render();
    return this.cfg;
  }

  // What's on the chart, for questions about it (only when sharing is on in Settings).
  context() {
    const app = this.app,
      p = app.active;
    if (!p) return null;
    const bars = p.shown || [],
      bar = bars.at(-1),
      prev = bars.at(-2);
    const indicators = (p.cfg.indicators || [])
      .map((ind, k, all) => {
        const def = BY_ID[ind.id];
        if (!def) return null;
        const res = p.indResults?.[ind.uid] || {},
          values = {};
        for (const o of def.outputs || []) {
          const arr = res[o.key];
          for (let i = (arr?.length || 0) - 1; i >= Math.max(0, (arr?.length || 0) - 3); i--)
            if (Number.isFinite(arr[i])) {
              values[o.label || o.key] = round(arr[i]);
              break;
            }
        }
        const twin = all.slice(0, k).some((x) => sameIndicator(def, x, ind));
        return { name: `${shortName(def)} ${p.indicatorParamsLabel?.(ind) || ""}`.trim(), values, ...(ind.hidden ? { hidden: true } : {}), ...(twin ? { duplicate: true } : {}), ...(res.error ? { error: String(res.error).slice(0, 120) } : {}) };
      })
      .filter(Boolean);
    const r = p.chart.timeScale().getVisibleLogicalRange();
    return {
      symbol: p.cfg.symbol,
      name: app.symbolName?.(p.cfg.symbol) || "",
      interval: p.cfg.tf,
      chartType: p.cfg.type,
      lastBar: bar ? { time: iso(bar.time), open: round(bar.open), high: round(bar.high), low: round(bar.low), close: round(bar.close), volume: round(bar.volume) } : null,
      previousClose: prev ? round(prev.close) : null,
      barsLoaded: bars.length,
      visible: r ? { from: iso(p.timeOfLogical(Math.max(0, r.from))), to: iso(p.timeOfLogical(Math.min(bars.length - 1, r.to))) } : null,
      indicators,
      compare: p.cfg.compare || [],
      drawings: p.drawings?.items?.length || 0,
      charts: app.panes.length,
      activeAlerts: (app.alertList || []).filter((a) => a.active).length,
      replay: !!p.replay,
      source: p.provider || "",
      theme: document.documentElement.dataset.theme || "dark",
    };
  }

  // Its own element inside the side panel, so an answer still streaming after you switch panels
  // doesn't draw into the next one.
  mount(side) {
    this.el = document.createElement("div");
    this.el.className = "cp-root";
    side.replaceChildren(this.el);
    this.render();
    this.refreshConfig();
    loadAgent().catch(() => {}); // ready before the first question
  }
  // Words from elsewhere in the app (Write with AI…, the Strategy tester's box): the panel opens and they go in
  // its box, or are sent with `send` when it can answer now. Busy, or no model yet, they wait in the box.
  async compose(text, { send = false } = {}) {
    this.app.panels.showSide("copilot");
    // on a fresh page the panel doesn't know yet whether a model is set up
    if (!this.cfg) await this.refreshConfig();
    // the cursor follows the words into the panel
    this.take = true;
    if (send && this.cfg?.hasKey && this.cfg?.model && !this.busy) return this.ask(text);
    this.boxText = text;
    this.render();
  }

  render() {
    const el = this.el;
    if (!el?.isConnected) return;
    const cfg = this.cfg;
    const ready = cfg?.hasKey && cfg?.model;
    const body = !cfg
      ? '<div class="pad hint-text">Loading…</div>'
      : !ready
        ? `<div class="cp-empty">${ROBOT}<div class="cp-hello">AskCharts AI</div><p>Ask anything about AskCharts or the chart on screen, or tell it what to put on the chart. It runs on your own API key.</p><button class="btn cp-cta" data-x="settings">Connect a model</button><p class="cp-small">Settings, AskCharts AI: pick the provider, paste the key, Test, choose a model.</p></div>`
        : this.messages.length
          ? this.messages.map((m, i) => this.bubble(m, i)).join("")
          : `<div class="cp-empty">${ROBOT}<div class="cp-hello">How can I help?</div><p>Ask about the chart, or tell me what to put on it. Every change can be undone.</p><div class="cp-sugg">${SUGGEST.map((s) => `<button data-ask="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>`;
    // what's in the box lives through a redraw (the config coming back, an answer ending) until it's sent
    const typed = this.boxText ?? $("textarea", el)?.value ?? "";
    // and the redraw leaves the cursor where you're typing outside the panel (the Pine Editor, the Strategy
    // tester's box), unless the words just came from there
    const at = document.activeElement,
      elsewhere = !!at && !el.contains(at) && (at.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName));
    el.innerHTML = `<div class="sp-fill cp">
      <div class="sp-head"><span class="cp-mark">${ROBOT}</span><span class="sp-name">AskCharts AI</span><span class="spacer"></span><button class="sp-icon" data-x="new" title="New chat">${I.newChat}</button><button class="sp-icon" data-x="settings" title="AskCharts AI settings">${I.gear}</button></div>
      <div class="sp-scroll cp-log">${body}</div>
      <div class="cp-foot">
        <div class="cp-box"><textarea rows="1" placeholder="${ready ? "Ask, or tell me what to put on the chart" : "Connect a model in Settings first"}" ${ready ? "" : "disabled"}></textarea><button class="cp-send" data-x="${this.busy ? "stop" : "send"}" title="${this.busy ? "Stop" : "Ask (Enter)"}" ${ready ? "" : "disabled"}>${this.busy ? I.stop : I.send}</button></div>
        <div class="cp-note">${ready ? `${esc(cfg.modelName || cfg.model)}. Answers can be wrong. Not financial advice.` : "&nbsp;"}</div>
      </div></div>`;
    const log = $(".cp-log", el),
      ta = $("textarea", el);
    log.scrollTop = log.scrollHeight;
    el.onclick = (e) => {
      const b = e.target.closest("[data-x],[data-ask],[data-copy],[data-retry],[data-undo],[data-answer],[data-choice],[data-script]");
      if (!b) return;
      if (b.dataset.ask) return this.ask(b.dataset.ask);
      if (b.dataset.undo) return this.undo(b.dataset.undo);
      if (b.dataset.answer) return this.answer(b.dataset.answer === "yes");
      if (b.dataset.choice) return this.answer(this.asking?.part.choices?.[Number(b.dataset.choice)] ?? null);
      if (b.dataset.script) return this.scriptAction(b.dataset.script, b.dataset.act);
      if (b.hasAttribute("data-copy")) {
        const t = b.parentElement.querySelector("code")?.textContent || "";
        navigator.clipboard?.writeText(t).then(() => this.app.toast("Copied."), () => this.app.toast("Couldn't copy.", "err"));
        return;
      }
      if (b.hasAttribute("data-retry")) return this.retry();
      const x = b.dataset.x;
      if (x === "settings") return this.app.openSettings("ai");
      if (x === "new") {
        this.stop();
        this.answer(false);
        this.messages = [];
        this.save();
        return this.render();
      }
      if (x === "send") return this.ask(ta.value);
      if (x === "stop") return this.stop();
    };
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
    };
    ta.oninput = grow;
    ta.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.busy) this.ask(ta.value);
      }
    };
    if (ready && (this.take || !elsewhere)) ta.focus();
    if (ready && typed) {
      ta.value = typed;
      grow();
      ta.setSelectionRange(typed.length, typed.length);
    }
    if (ready) this.boxText = this.take = null;
  }

  bubble(m, i) {
    if (m.role === "user") return `<div class="cp-msg cp-user" data-i="${i}"><div class="cp-bub">${esc(m.content).replace(/\n/g, "<br>")}</div></div>`;
    const tail = m.error
      ? `<div class="cp-err">${esc(m.error)} <button class="cp-retry" data-retry>Try again</button></div>`
      : m.stopped
        ? '<div class="cp-meta">Stopped.</div>'
        : "";
    if (!m.parts) {
      const typing = m.pending && !m.content ? '<div class="cp-typing"><i></i><i></i><i></i></div>' : "";
      return `<div class="cp-msg cp-ai" data-i="${i}"><div class="cp-md">${md(m.content)}${typing}</div>${tail}</div>`;
    }
    // an answer that acted: its text, and each step with Undo (this session only)
    const snaps = this.undos.get(m);
    let html = "",
      undoable = 0;
    for (const part of m.parts) {
      if (part.t === "text") html += `<div class="cp-md">${md(part.v)}</div>`;
      else if (part.t === "look") html += `<div class="cp-look">${I.look}<span>${esc(part.label)}</span></div>`;
      else if (part.t === "ask" && part.choices) {
        // a question with answers to click (ask_person)
        const open = part.answer === undefined && this.asking?.part === part;
        html += `<div class="cp-ask cp-choice"><span>${esc(part.q)}</span>${open ? `<span class="cp-ask-btns">${part.choices.map((c, k) => `<button class="btn" data-choice="${k}">${esc(c)}</button>`).join("")}</span>` : `<span class="cp-meta">${part.answer == null ? "No answer" : esc(part.answer)}</span>`}</div>`;
      } else if (part.t === "script") {
        // a script the AI saved: open it, see its report, or read its code here
        const ref = `${i}:${m.parts.indexOf(part)}`;
        html += `<div class="cp-card"><div class="cp-card-h"><b>${esc(part.name)}</b><span class="cp-meta">${esc(part.symbol)} · ${esc(part.tf)} · in My scripts</span></div><div class="cp-card-b"><button class="btn" data-script="${ref}" data-act="open">Open in Pine Editor</button>${part.strategy && part.uid ? `<button class="btn" data-script="${ref}" data-act="report">Strategy tester</button>` : ""}<button class="btn" data-script="${ref}" data-act="code">${part.showCode ? "Hide the code" : "Show the code"}</button></div>${part.showCode ? `<div class="cp-code"><button class="cp-copy" data-copy title="Copy">Copy</button><pre><code>${esc(part.code)}</code></pre></div>` : ""}</div>`;
      } else if (part.t === "ask") {
        const open = part.answer == null && this.asking?.part === part;
        html += `<div class="cp-ask"><span>${esc(part.q)}</span>${open ? '<span class="cp-ask-btns"><button class="btn" data-answer="yes">Yes</button><button class="btn" data-answer="no">No</button></span>' : `<span class="cp-meta">${part.answer ? "Yes" : "No"}</span>`}</div>`;
      } else if (part.t === "step") {
        const can = snaps && part.k != null && !part.undone && !part.error && !part.declined;
        if (can) undoable++;
        const cls = part.error ? " err" : part.undone ? " undone" : part.declined ? " declined" : "";
        html += `<div class="cp-step${cls}">${part.error ? I.warn : I.done}<span>${esc(part.label)}</span>${can ? `<button class="cp-undo" data-undo="${i}:${part.k}" title="Put this back, and anything after it">Undo</button>` : part.undone ? '<span class="cp-meta">Undone</span>' : ""}</div>`;
      }
    }
    const typing = m.pending ? '<div class="cp-typing"><i></i><i></i><i></i></div>' : "";
    const all = !m.pending && undoable > 1 ? `<button class="cp-undo cp-undo-all" data-undo="${i}:0">Undo all</button>` : "";
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const used = m.usage && !m.pending && m.usage.input + m.usage.cached + m.usage.output > 0 ? `<div class="cp-meta cp-used">${k(m.usage.input + m.usage.cached + m.usage.output)} tokens${m.usage.cached ? ` (${k(m.usage.cached)} from cache)` : ""}</div>` : "";
    // the next steps it offered (next_steps), as boxes to click under the last answer only
    const steps = !m.pending && !m.error && !m.stopped && i === this.messages.length - 1 && m.parts.filter((x) => x.t === "next").at(-1)?.steps;
    const next = steps ? `<div class="cp-sugg cp-next">${steps.map((s) => `<button data-ask="${esc(s)}">${esc(s)}</button>`).join("")}</div>` : "";
    return `<div class="cp-msg cp-ai" data-i="${i}">${html}${typing}${all}${tail}${next}${used}</div>`;
  }
  paintLast() {
    const log = this.el?.isConnected && $(".cp-log", this.el);
    if (!log) return;
    const i = this.messages.length - 1,
      node = log.querySelector(`.cp-msg[data-i="${i}"]`);
    const html = this.bubble(this.messages[i], i);
    if (node) node.outerHTML = html;
    else log.insertAdjacentHTML("beforeend", html);
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (near) log.scrollTop = log.scrollHeight;
  }

  stop() {
    if (this.ctrl) this.ctrl.abort();
    this.answer(false);
  }
  // Yes or No to the question the AI asked before a big change, or the answer picked from its choices
  // (Stop or a new chat is no answer).
  answer(yes) {
    const q = this.asking;
    if (!q) return;
    this.asking = null;
    const v = q.part.choices ? (typeof yes === "string" ? yes : null) : yes;
    q.part.answer = v;
    q.resolve(v);
    this.render();
  }
  // The buttons on a saved script's card ("i:k": message i, part k).
  scriptAction(ref, act) {
    const [i, k] = ref.split(":").map(Number);
    const part = this.messages[i]?.parts?.[k];
    if (!part) return;
    const a = this.app;
    if (act === "code") {
      part.showCode = !part.showCode;
      return this.render();
    }
    if (!a.state.pineScripts?.[part.id]) return a.toast("That script isn't in My scripts any more.", "err");
    if (act === "open") {
      a.panels.showSide("pine");
      return a.pineEditor.openScript(part.id);
    }
    if (act === "report") {
      const p = a.panes.find((x) => x.cfg.indicators.some((ind) => ind.uid === part.uid));
      if (!p) return a.toast("That strategy isn't on a chart any more.", "err");
      a.setActive(p);
      a.panels.showStrategyReport(p, part.uid);
    }
  }
  // Undo a step and everything after it in that answer ("i:k": message i, undo point k).
  async undo(ref) {
    const [i, k] = ref.split(":").map(Number);
    const m = this.messages[i],
      snaps = m && this.undos.get(m);
    if (!snaps?.[k] || this.busy || !this.tools) return;
    // Undo puts the whole view back as it was: say so if things changed after this answer
    const after = this.after.get(m);
    if (after && !this.tools.same(after, this.tools.snapshot()) && !confirm("This also undoes the changes made since this answer. Undo anyway?")) return;
    await this.tools.restore(snaps[k]);
    this.after.set(m, this.tools.snapshot());
    for (const part of m.parts || []) if (part.t === "step" && part.k != null && part.k >= k) part.undone = true;
    this.save();
    this.render();
    this.app.toast(k === 0 ? "Undid every change in that answer." : "Undone.");
  }
  async retry() {
    const last = this.messages.at(-1);
    // a failed answer may have changed things before it broke: put them back, so trying again can't double them
    const snaps = last && this.undos.get(last);
    if (last?.role === "assistant" && snaps?.length && this.tools) await this.tools.restore(snaps[0]);
    if (last?.role === "assistant") this.messages.pop();
    const q = this.messages.at(-1);
    if (q?.role === "user") {
      this.messages.pop();
      this.ask(q.content);
    }
  }

  async ask(text) {
    const q = String(text || "").trim();
    if (!q || this.busy) return;
    if (!this.cfg?.hasKey) return this.app.openSettings("ai");
    // busy before anything waits, so a second Enter can't start a second answer
    this.busy = true;
    // the question leaves the box (a suggestion clicked leaves what was typed there)
    const box = this.el?.isConnected && $("textarea", this.el);
    if (box && box.value.trim() === q) box.value = "";
    let mod;
    try {
      mod = await loadAgent();
    } catch (e) {
      this.busy = false;
      return this.app.toast(`AskCharts AI couldn't load: ${esc(e.message)}`, "err");
    }
    const { AgentTools, converse, historyFor } = mod;
    this.tools ||= new AgentTools(this.app);
    const earlier = historyFor(this.messages.filter((m) => !m.error));
    this.messages.push({ role: "user", content: q });
    const a = { role: "assistant", content: "", parts: [], pending: true };
    this.messages.push(a);
    const snaps = [];
    this.undos.set(a, snaps);
    this.render();
    this.ctrl = new AbortController();
    let frame = 0;
    const paint = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          this.paintLast();
        });
    };
    const textPart = () => {
      const last = a.parts.at(-1);
      if (last?.t === "text") return last;
      const p = { t: "text", v: "" };
      a.parts.push(p);
      return p;
    };
    try {
      const { exchanges, stop, usage } = await converse({
        tools: this.tools,
        history: [...earlier, { role: "user", content: q }],
        context: this.cfg.context ? this.context() : null,
        signal: this.ctrl.signal,
        askFirst: !!this.cfg.askFirst,
        onText: (v) => {
          textPart().v += v;
          a.content += v;
          paint();
        },
        onStep: (call, done) => {
          // a question with answers to click, and the next steps offered, show as themselves
          if ((call.name === "ask_person" || call.name === "next_steps") && !done.error) return paint();
          if (done.read && !done.error) a.parts.push({ t: "look", label: done.label });
          else {
            const part = { t: "step", label: done.label || call.name };
            if (done.error) part.error = true;
            if (done.declined) part.declined = true;
            if (done.snap) {
              part.k = snaps.length;
              snaps.push(done.snap);
            }
            a.parts.push(part);
            if (done.script) a.parts.push({ t: "script", ...done.script });
          }
          paint();
        },
        confirm: (question) =>
          new Promise((resolve) => {
            const part = { t: "ask", q: question, answer: null };
            a.parts.push(part);
            this.asking = { part, resolve };
            this.render();
          }),
        choose: (question, choices) =>
          new Promise((resolve) => {
            const part = { t: "ask", q: question, choices, answer: undefined };
            a.parts.push(part);
            this.asking = { part, resolve };
            this.render();
          }),
        offer: (steps) => a.parts.push({ t: "next", steps }),
      });
      a.api = exchanges;
      a.usage = usage;
      if (stop === "max_tokens") textPart().v += "\n\n(The answer hit its length limit. Ask me to continue.)";
    } catch (e) {
      if (e.name === "AbortError") a.stopped = true;
      else a.error = e.message;
    } finally {
      this.answer(false);
      if (snaps.length) this.after.set(a, this.tools.snapshot());
      a.pending = false;
      this.busy = false;
      this.ctrl = null;
      if (!a.parts.length && !a.error && !a.stopped) a.error = "No answer came back.";
      this.save();
      this.render();
    }
  }
}

// ---------- Settings, AskCharts AI: provider, key, Test, model ----------
// The typed key lives only in this dialog and in the requests that test and save it. Each provider keeps
// its own saved key and model; the one picked here is the one AskCharts AI uses after Ok.
// A first pick for each provider's list: a mid-size Claude, the newest full GPT, the newest full Grok.
const PREFER = { anthropic: /sonnet/i, openai: /^gpt-\d+(\.\d+)?$/i, xai: /^grok-\d+(\.\d+)?(-\d{4})?$/i };
export function aiSettings(app) {
  const st = { cfg: null, provider: "anthropic", key: "", reveal: false, models: null, model: "", context: true, askFirst: false, status: "", tone: "", remove: false };
  const prov = (id = st.provider) => (st.cfg?.providers || []).find((p) => p.id === id) || { id, name: id, label: id, hasKey: false, keyHint: "", model: "", modelName: "" };
  const pick = (models) => {
    const keep = models.find((m) => m.id === (st.model || prov().model));
    const like = PREFER[st.provider];
    return (keep || (like && models.find((m) => like.test(m.id) && !m.deprecated)) || models.find((m) => !m.deprecated && !/mini|nano/i.test(m.id)) || models[0])?.id || "";
  };
  return {
    async load() {
      try {
        st.cfg = await api.get("/api/copilot/config");
      } catch {
        st.cfg = { providers: [{ id: "anthropic", name: "Anthropic (Claude, hosted)", label: "Anthropic" }], provider: "anthropic", hasKey: false, context: true };
      }
      st.provider = st.cfg.provider || "anthropic";
      st.model = st.cfg.model || "";
      st.context = st.cfg.context !== false;
      st.askFirst = st.cfg.askFirst === true;
    },
    html() {
      const c = st.cfg;
      if (!c) return '<div class="cs-sec">ASKCHARTS AI</div><div class="cs-l span">Loading…</div>';
      const pv = prov();
      const hasKey = pv.hasKey && !st.remove;
      const models = st.models
        ? st.models.map((m) => `<option value="${esc(m.id)}" ${m.id === st.model ? "selected" : ""}>${esc(m.name)}${m.deprecated ? " (deprecated)" : ""}</option>`).join("")
        : `<option>${esc(hasKey && pv.modelName ? pv.modelName : "Test the key first")}</option>`;
      // picking another provider: Ok moves AskCharts AI over to it, once it has a key
      const other = st.provider !== c.provider ? `AskCharts AI uses ${prov(c.provider).label} now. ${hasKey || st.key.trim() ? "" : `Paste your ${pv.label} key and Test it, then `}Ok switches it to ${pv.label}.` : "";
      return `<div class="cs-sec">ASKCHARTS AI</div><div class="ai-wrap">
        <p class="ai-lead">AskCharts AI answers questions about the app and the chart on screen, and does things on the chart when you ask, in the panel on the right toolbar. It runs on your own API key.</p>
        <label class="ai-f"><span>Provider</span><select class="cs-num ai-in" data-ai="provider">${(c.providers || []).map((p) => `<option value="${esc(p.id)}" ${p.id === st.provider ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        ${other ? `<div class="ai-sub">${esc(other)}</div>` : ""}
        <div class="ai-f"><span>API key</span><div class="ai-row"><div class="ai-key"><input class="cs-num ai-in" data-ai="key" type="${st.reveal ? "text" : "password"}" autocomplete="off" spellcheck="false" placeholder="${hasKey ? `Saved key ending in ${esc(pv.keyHint)}. Paste a new one to replace it` : `Paste your ${esc(pv.label)} API key`}" value="${esc(st.key)}"><button class="ai-eye" data-ai="eye" title="${st.reveal ? "Hide" : "Show"} what you typed">${I.eye}</button></div><button class="btn ai-test" data-ai="test">Test</button></div></div>
        ${hasKey ? "" : `<div class="ai-sub">Make one in your ${esc(pv.label)} account, under API keys.</div>`}
        <label class="ai-f"><span>Model</span><select class="cs-num ai-in" data-ai="model" ${st.models ? "" : "disabled"}>${models}</select></label>
        <div class="ai-status ${st.tone}">${esc(st.status)}</div>
        <label class="cs-chk"><input type="checkbox" data-ai="context" ${st.context ? "checked" : ""}><span class="cs-box"></span><span>Share the chart with AskCharts AI</span></label>
        <div class="ai-sub">Sends the symbol, interval, last bar, indicator values and what's in view with each question.</div>
        <label class="cs-chk"><input type="checkbox" data-ai="askFirst" ${st.askFirst ? "checked" : ""}><span class="cs-box"></span><span>Ask before each change</span></label>
        <div class="ai-sub">Off: it makes the changes you ask for and lists each one with Undo. It always asks before removing several things.</div>
        ${hasKey ? `<button class="ai-remove" data-ai="remove">Remove the saved ${esc(pv.label)} key</button>` : st.remove ? `<div class="ai-sub">The saved ${esc(pv.label)} key will be removed when you press Ok.</div>` : ""}
        <p class="ai-note">The key stays on this computer, in a file only this account can read. It's sent only to the provider, never back to the browser. Questions are billed to your provider account.</p>
      </div>`;
    },
    bind(page, redraw) {
      const key = page.querySelector('[data-ai="key"]');
      if (!key) return;
      key.oninput = () => {
        st.key = key.value;
        if (st.models) {
          st.models = null;
          st.status = "Test the new key.";
          st.tone = "";
          redraw();
          page.querySelector('[data-ai="key"]')?.focus();
        }
      };
      key.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") page.querySelector('[data-ai="test"]')?.click();
      };
      page.querySelector('[data-ai="provider"]').onchange = (e) => {
        Object.assign(st, { provider: e.target.value, key: "", models: null, status: "", tone: "", remove: false });
        st.model = prov().model;
        redraw();
      };
      page.querySelector('[data-ai="model"]').onchange = (e) => (st.model = e.target.value);
      page.querySelector('[data-ai="context"]').onchange = (e) => (st.context = e.target.checked);
      page.querySelector('[data-ai="askFirst"]').onchange = (e) => (st.askFirst = e.target.checked);
      page.querySelector('[data-ai="eye"]').onclick = () => {
        st.reveal = !st.reveal;
        redraw();
      };
      const rm = page.querySelector('[data-ai="remove"]');
      if (rm)
        rm.onclick = () => {
          st.remove = true;
          st.models = null;
          st.status = "";
          redraw();
        };
      page.querySelector('[data-ai="test"]').onclick = async (e) => {
        const btn = e.currentTarget;
        if (!st.key.trim() && !(prov().hasKey && !st.remove)) {
          st.status = "Paste a key first.";
          st.tone = "err";
          return redraw();
        }
        btn.disabled = true;
        btn.textContent = "Testing…";
        try {
          const models = await api.post("/api/copilot/models", { provider: st.provider, key: st.key.trim() });
          if (!models.length) throw new Error("The key works, but no models came back.");
          st.models = models;
          st.model = pick(models);
          st.status = `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available. Pick one, then press Ok to save.`;
          st.tone = "ok";
        } catch (err) {
          st.models = null;
          st.status = err.message;
          st.tone = "err";
        }
        redraw();
      };
    },
    pending: () => (st.key.trim() && !st.models ? "Test the new AI key first (or clear it) before pressing Ok." : ""),
    // On Ok. A new key is checked again by the server before it's saved. A provider without a key stays
    // unpicked: AskCharts AI keeps the one it has.
    async commit() {
      const c = st.cfg;
      if (!c) return "";
      const provider = st.provider,
        pv = prov();
      const typed = st.key.trim();
      let msg = "";
      if (st.remove && !typed) {
        await api.del(`/api/copilot/key?provider=${encodeURIComponent(provider)}`);
        msg = `Removed the ${pv.label} key.`;
      }
      if (typed) {
        if (!st.models) throw new Error("Test the new key before saving it.");
        const r = await api.put("/api/copilot/config", { provider, key: typed, model: st.model, context: st.context, askFirst: st.askFirst });
        msg = `AskCharts AI connected (${r.modelName || r.model}).`;
      } else if (!st.remove && pv.hasKey && ((st.model && st.model !== pv.model) || provider !== c.provider)) {
        const r = await api.put("/api/copilot/config", { provider, model: st.model || pv.model, context: st.context, askFirst: st.askFirst });
        msg = `AskCharts AI now uses ${r.modelName || r.model}.`;
      } else if (!st.remove && (st.context !== (c.context !== false) || st.askFirst !== (c.askFirst === true))) {
        await api.put("/api/copilot/config", { provider: c.provider, context: st.context, askFirst: st.askFirst });
      }
      await app.copilot?.refreshConfig();
      return msg;
    },
  };
}
