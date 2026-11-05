// TradingView's "Indicators, metrics, and strategies": a search box, a list on the left (Favorites,
// My scripts, Technicals, Fundamentals, On chain, and the community sections, from the Pine catalog),
// rows with a star, and the Favorite indicators dropdown beside the toolbar's Indicators button.
import { api, esc } from "./api.js";
import { INDICATORS, BY_ID } from "../lib/indicators.js";

const svg = (b) => `<svg viewBox="0 0 24 24">${b}</svg>`;
const STAR = '<svg viewBox="0 0 18 18"><path d="M9 2.6l1.9 4 4.3.5-3.2 2.9.9 4.3L9 12.2l-3.9 2.1.9-4.3-3.2-2.9 4.3-.5z"/></svg>';
const STRAT = svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>');
const NAV = [
  ["Personal", [
    ["favorites", "Favorites", svg('<path d="M12 3.5l2.6 5.4 5.9.7-4.4 4 1.2 5.8L12 16.5l-5.3 2.9 1.2-5.8-4.4-4 5.9-.7z"/>')],
    ["mine", "My scripts", svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>')],
    ["purchased", "Purchased", svg('<rect x="4" y="8" width="16" height="12" rx="1.5"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'), "Nothing is sold here: every script is built in or yours."],
  ]],
  ["Built-in", [
    ["technicals", "Technicals", svg('<path d="M3 19l5-6 4 3 4-7 5 5M3 21h18"/>')],
    ["fundamentals", "Fundamentals", svg('<path d="M5 20V12M10 20V7M15 20v-5M20 20V4"/>')],
    ["onchain", "On chain", svg('<path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>')],
  ]],
  ["Community", [
    ["picks", "Editors' picks", svg('<path d="M7 4h10v16l-5-3.5L7 20z"/>')],
    ["top", "Top", svg('<path d="M4 20h4v-6H4zM10 20h4V8h-4zM16 20h4V4h-4z"/>')],
    ["trending", "Trending", svg('<path d="M12 21c-4 0-7-2.8-7-6.5 0-3 2-4.6 3.2-6.5.4 1.6 1.3 2.6 2.3 2.6 0-3 1.2-5.6 3.5-7.6.2 3.2 1.6 4.8 3 6.6 1 1.3 2 2.8 2 4.9 0 3.7-3 6.5-7 6.5z"/>')],
    ["market", "Marketplace", svg('<path d="M4 9h16l-1 11H5zM8 9V7a4 4 0 0 1 8 0v2"/>')],
  ]],
];
const TECH_TABS = [["indicators", "Indicators"], ["strategies", "Strategies"], ["profiles", "Profiles"], ["patterns", "Patterns"]];
const PROFILES = ["vpvr", "svp"];
// From the TradingView favourites shown to us, the ones this app also has.
const SEED = ["macd", "netvol", "psar", "rsi", "sma", "stochrsi", "volume", "vwap", "wma"];
const GROUP_ORDER = ["Quant (bonus)", "Moving averages", "Momentum", "Trend", "Volatility", "Volume", "Patterns", "Custom"];
// XRPL On chain: built in, listed under On chain by chain, not with the technicals
const CHAINS = [["xrpl", "XRP Ledger", "Each bar sums the XRP Ledger's ledgers that closed in it, from the collector on this server."]];

export function indicatorFavs(app) {
  if (!app.settings.indicatorFavs) app.settings.indicatorFavs = SEED.filter((id) => BY_ID[id]);
  return app.settings.indicatorFavs;
}
// Every row the dialog can show: indicators (built in and yours) and tester strategies. A script
// added from the catalog is yours to keep but shows its own author.
function items(app) {
  const source = (d) => (d.pine ? app.state.pineScripts?.[d.id.slice(5)]?.source : null);
  const ind = INDICATORS.map((d) => ({ key: d.id, kind: "ind", name: d.saved || d.name, group: d.group || "Other", author: d.id.startsWith("custom:") || d.pine ? source(d)?.author || "You" : "", mine: d.id.startsWith("custom:") || !!d.pine, where: d.strategy ? "strategy" : d.overlay ? "on price" : "own pane", d }));
  const strat = (app.panels?.strategyList?.() || []).map((s) => ({ key: `strategy:${s.src}`, kind: "strat", name: s.name, group: s.saved ? "Saved" : "Examples", author: s.saved ? "You" : "", mine: !!s.saved, where: "strategy", src: s.src, saved: s.saved }));
  return [...ind, ...strat];
}
// The community menus, from the Pine catalog (GET /api/catalog): fetched once per page load.
const CATALOG = ["picks", "top", "trending", "market"];
const catalogLists = {};
const catalogLoading = {};
let catalogAdding = false;
// A catalog script is saved as one of your Pine scripts (cat_<key>, so adding it again reuses it),
// then added to the chart like any other; a strategy's report opens in the Strategy tester.
async function addFromCatalog(app, r) {
  if (catalogAdding) return;
  catalogAdding = true;
  const id = `cat_${r.key}`;
  try {
    const scripts = app.pineEditor.scripts();
    if (!scripts[id]) {
      const s = await api.get(`/api/catalog/${r.key}`);
      app.pineEditor.register(id, s.code);
      scripts[id] = { name: s.title, code: s.code, saved: Date.now(), source: { repo: s.repo, path: s.path, author: s.author, license: s.license } };
      app.persist();
    } else if (!BY_ID[`pine:${id}`]) app.pineEditor.register(id, scripts[id].code);
    app.addIndicatorById(`pine:${id}`);
  } catch (e) {
    app.toast(`Couldn't add ${esc(r.title)}: ${esc(e.message)}`, "err");
  } finally {
    catalogAdding = false;
  }
}

// Adding from a row: an indicator goes on the chart, a strategy loads in the tester and runs.
function use(app, it) {
  if (it.kind === "cat") return addFromCatalog(app, it.r);
  if (it.kind === "strat") {
    app.closeModal();
    app.drawToolbar.closePopover();
    return app.panels.runStrategy(it.src);
  }
  app.addIndicatorById(it.key);
}

export function openIndicatorDialog(app) {
  let nav = app.settings.indicatorNav || "technicals",
    tab = "all",
    tech = "indicators",
    rows = [],
    sel = -1;
  if (!NAV.some(([, list]) => list.some(([k, , , off]) => k === nav && !off))) nav = "technicals";
  const card = app.modal(
    "Indicators, metrics, and strategies",
    `<div class="ss-box ix-box"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5l5 5"/></svg><input id="ixQ" placeholder="Search" autocomplete="off" spellcheck="false"></div>
    <div class="ix-wrap"><nav class="ix-nav">${NAV.map(([h, list]) => `<div class="ix-navh">${h}</div>${list.map(([k, label, icon, off]) => `<button data-nav="${k}" ${off ? `disabled title="${esc(off)}"` : ""}>${icon}<span>${label}</span></button>`).join("")}`).join("")}</nav><div class="ix-main"><div class="ix-chips"></div><div class="ix-list"></div></div></div>`,
    { foot: '<span class="hint-text" style="margin-right:auto">No limit per chart. Write your own in the Indicator editor tab.</span><button class="btn" data-new>New custom indicator</button>' },
  );
  card.classList.add("ix-card");
  const q = card.querySelector("#ixQ"),
    chips = card.querySelector(".ix-chips"),
    list = card.querySelector(".ix-list");

  const favs = () => indicatorFavs(app);
  const row = (it, i) => {
    const fav = favs().includes(it.key);
    return `<div class="ix-row${i === sel ? " sel" : ""}" data-i="${i}"><button class="ix-star${fav ? " fav" : ""}" data-star="${esc(it.key)}" title="${fav ? "Remove from favorites" : "Add to favorites"}">${STAR}</button><span class="ix-name">${esc(it.name)}${it.kind === "strat" || it.d?.strategy ? `<i class="ix-strat" title="Strategy: runs in the Strategy tester">${STRAT}</i>` : ""}</span><span class="ix-author">${esc(it.author)}</span><span class="ix-where">${esc(it.where)}</span></div>`;
  };
  const head = '<div class="ix-head"><span>Name</span><span>Author</span><span></span></div>';
  // Catalog rows: no star until the script is yours; the licence on hover, and a note when there's none.
  const catHead = '<div class="ix-head"><span>Script name</span><span>Author</span><span>Stars</span></div>';
  const catRow = (it, i) => {
    const r = it.r;
    const tip = `${r.repo}, ${r.path}. ${r.license ? `Licence: ${r.license}.` : "No licence: for your own use only."}`;
    return `<div class="ix-row${i === sel ? " sel" : ""}" data-i="${i}" title="${esc(tip)}"><span></span><span class="ix-name">${esc(r.title)}${r.kind === "strategy" ? `<i class="ix-strat" title="Strategy: runs in the Strategy tester">${STRAT}</i>` : ""}${r.license ? "" : '<i class="ix-lic">no licence</i>'}</span><span class="ix-author">${esc(r.author)}</span><span class="ix-where">${esc(r.stars.toLocaleString())}</span></div>`;
  };
  const loadCatalog = async (n) => {
    if (catalogLoading[n]) return;
    catalogLoading[n] = true;
    try {
      catalogLists[n] = await api.get(`/api/catalog?nav=${n}`);
    } catch (e) {
      catalogLists[n] = { rows: [], reason: `Couldn't load the catalog: ${e.message}` };
    }
    catalogLoading[n] = false;
    if (nav === n && card.isConnected) draw();
  };
  const draw = () => {
    const term = q.value.trim().toLowerCase(),
      all = items(app);
    const inCatalog = CATALOG.includes(nav);
    card.querySelectorAll(".ix-nav [data-nav]").forEach((b) => b.classList.toggle("on", (!term || inCatalog) && b.dataset.nav === nav));
    let html = "";
    rows = [];
    const add = (list2) => {
      const start = rows.length;
      rows.push(...list2);
      return list2.map((it, j) => row(it, start + j)).join("");
    };
    const kindChips = () => (chips.innerHTML = [["all", "All"], ["ind", "Indicators"], ["strat", "Strategies"]].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join(""));
    const byKind = (l) => (tab === "all" ? l : l.filter((it) => it.kind === tab));
    if (inCatalog) {
      // The search box filters this list, not the whole app.
      kindChips();
      const c = catalogLists[nav];
      if (!c) {
        loadCatalog(nav);
        html = '<div class="ix-empty">Loading…</div>';
      } else {
        const hits = c.rows
          .filter((r) => tab === "all" || (tab === "strat") === (r.kind === "strategy"))
          .filter((r) => !term || `${r.title} ${r.author} ${r.repo}`.toLowerCase().includes(term))
          .map((r) => ({ key: `cat:${r.key}`, kind: "cat", name: r.title, r }));
        const start = rows.length;
        rows.push(...hits);
        html = hits.length
          ? catHead + hits.map((it, j) => catRow(it, start + j)).join("")
          : `<div class="ix-empty">${esc(term ? `Nothing here matches ${term}.` : c.rows.length ? "Nothing of this kind here." : c.reason || "Nothing here yet.")}</div>`;
      }
    } else if (term) {
      kindChips();
      // a saved script answers to its saved name and to the title in its code
      const hits = byKind(all.filter((it) => `${it.name} ${it.d?.name || ""} ${it.key} ${it.group}`.toLowerCase().includes(term)));
      html = hits.length ? head + add(hits) : `<div class="ix-empty">No indicators or strategies match <b>${esc(term)}</b>.</div>`;
    } else if (nav === "favorites") {
      kindChips();
      const f = favs();
      const hits = byKind(all.filter((it) => f.includes(it.key)).sort((a, b) => a.name.localeCompare(b.name)));
      html = hits.length ? head + add(hits) : '<div class="ix-empty">No favorites yet. Click the star on any indicator or strategy to keep it here and in the dropdown beside the Indicators button.</div>';
    } else if (nav === "mine") {
      chips.innerHTML = "";
      const hits = all.filter((it) => it.mine);
      html = hits.length ? head + add(hits) : '<div class="ix-empty">Nothing of yours yet. Write an indicator in the Indicator editor tab, or save a strategy in the Strategy tester, and it shows here.</div>';
    } else if (nav === "onchain") {
      chips.innerHTML = "";
      html = head + CHAINS.map(([k, label, note]) => `<div class="ix-group">${esc(label)}</div>${add(all.filter((it) => it.kind === "ind" && it.d.onchain === k))}<div class="ix-empty small">${esc(note)}</div>`).join("");
    } else if (nav === "fundamentals") {
      chips.innerHTML = "";
      html = '<div class="ix-empty">Company figures (income statement, balance sheet, cash flow and key stats) are in the Financials tab under the chart, for US stocks.<div><button class="btn" data-fin>Open Financials</button></div></div>';
    } else {
      chips.innerHTML = TECH_TABS.map(([k, l]) => `<button data-tech="${k}" class="${tech === k ? "on" : ""}">${l}</button>`).join("");
      if (tech === "strategies") html = head + add(all.filter((it) => it.kind === "strat"));
      else if (tech === "profiles") html = head + add(all.filter((it) => PROFILES.includes(it.key)));
      else if (tech === "patterns") html = head + add(all.filter((it) => it.kind === "ind" && it.group === "Patterns"));
      else {
        const groups = {};
        for (const it of all) if (it.kind === "ind" && !it.author && !PROFILES.includes(it.key) && it.group !== "Patterns" && !it.d.onchain) (groups[it.group] ||= []).push(it);
        html = head + Object.keys(groups)
          .sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99))
          .map((g) => `<div class="ix-group${g === "Quant (bonus)" ? " gold-text" : ""}">${esc(g)}</div>${add(groups[g])}`)
          .join("");
      }
    }
    list.innerHTML = html;
    list.querySelector(".ix-row.sel")?.scrollIntoView({ block: "nearest" });
  };

  card.querySelector(".ix-nav").onclick = (e) => {
    const b = e.target.closest("[data-nav]");
    if (!b || b.disabled) return;
    nav = b.dataset.nav;
    app.settings.indicatorNav = nav;
    q.value = "";
    sel = -1;
    tab = "all";
    draw();
  };
  chips.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tab) tab = b.dataset.tab;
    if (b.dataset.tech) tech = b.dataset.tech;
    sel = -1;
    draw();
  };
  list.onclick = (e) => {
    const star = e.target.closest("[data-star]")?.dataset.star;
    if (star) {
      const f = favs();
      app.settings.indicatorFavs = f.includes(star) ? f.filter((x) => x !== star) : [...f, star];
      app.persist();
      return draw();
    }
    if (e.target.closest("[data-fin]")) {
      app.closeModal();
      return app.panels.showBottom("financials");
    }
    const r = e.target.closest(".ix-row");
    if (r) use(app, rows[Number(r.dataset.i)]);
  };
  q.oninput = () => {
    sel = q.value.trim() ? 0 : -1;
    draw();
  };
  q.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = e.key === "ArrowDown" ? Math.min(sel + 1, rows.length - 1) : Math.max(sel - 1, 0);
      draw();
    } else if (e.key === "Enter" && rows[sel]) {
      e.preventDefault();
      use(app, rows[sel]);
    }
  };
  card.querySelector("[data-new]").onclick = () => {
    app.closeModal();
    app.panels.showBottom("editor");
  };
  draw();
  q.focus();
}

// The dropdown beside Indicators: your favourites, A to Z; a click adds one.
export function openFavoritesMenu(app, btn) {
  const all = items(app),
    f = indicatorFavs(app);
  const hits = all.filter((it) => f.includes(it.key)).sort((a, b) => a.name.localeCompare(b.name));
  const tb = app.drawToolbar;
  const pop = tb.openPopover(
    btn,
    `<div class="ix-favh">Favorite indicators</div>${hits.map((it, i) => `<button data-i="${i}">${esc(it.name)}${it.kind === "strat" ? `<i class="ix-strat">${STRAT}</i>` : ""}</button>`).join("") || '<div class="ix-empty small">No favorites yet. Star indicators in the Indicators dialog to list them here.</div>'}`,
    "ix-fav",
  );
  pop.classList.add("dtb-list", "ix-favpop");
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(r.left - 20, innerWidth - pop.offsetWidth - 4))}px`;
  pop.style.top = `${r.bottom + 4}px`;
  pop.style.maxHeight = `${innerHeight - r.bottom - 12}px`;
  pop.onclick = (e) => {
    const b = e.target.closest("[data-i]");
    if (!b) return;
    tb.closePopover();
    use(app, hits[Number(b.dataset.i)]);
  };
}
