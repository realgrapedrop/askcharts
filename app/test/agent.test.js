// AskCharts AI's server side and helpers, offline: the conversation in Anthropic's form, the tool
// catalog's rules, and the swing levels the AI anchors drawings to. Run: node --test test/agent.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropic } from "../lib/agent.js";
import { AGENT_TOOLS, toolSpecs } from "../public/lib/agent-tools.js";
import { levels, parseWhen, barIndexAt, summary } from "../public/lib/agent-analysis.js";
import { md } from "../public/js/copilot.js";

test("a table in an answer is drawn as one; rows without the dashes under the head stay text", () => {
  const html = md("Before\n\n| | Strategy | Holding |\n|---|--:|:-:|\n| First 70% | **+294%** | +165% |\n| Last 30% | +11.7% |\nAfter");
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.match(html, /<p>Before<\/p><div class="cp-table"><table><thead><tr><th><\/th><th class="r">Strategy<\/th><th class="c">Holding<\/th><\/tr><\/thead>/);
  assert.match(html, /<td class="r"><b>\+294%<\/b><\/td>/);
  // a short row is filled out to the head's columns
  assert.match(html, /<tr><td>Last 30%<\/td><td class="r">\+11\.7%<\/td><td class="c"><\/td><\/tr><\/tbody><\/table><\/div><p>After<\/p>$/);
  assert.equal(md("| a | b |\n| <i>x</i> |"), "<p>| a | b |<br>| &lt;i&gt;x&lt;/i&gt; |</p>");
  assert.equal(md("text\n| a |\n|---|"), '<p>text</p><div class="cp-table"><table><thead><tr><th>a</th></tr></thead><tbody></tbody></table></div>');
});

test("the conversation in Anthropic's form: calls, results first in the user turn, same roles merged", () => {
  const out = toAnthropic([
    { role: "user", content: "Show XRP" },
    { role: "assistant", content: "Looking.", calls: [{ id: "a1", name: "market_search", input: { query: "XRP" } }] },
    { role: "tool", results: [{ id: "a1", content: "[KRAKEN:XRPUSD]" }] },
    { role: "assistant", content: "Done." },
    { role: "user", content: "Thanks" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.deepEqual(out[1].content.map((b) => b.type), ["text", "tool_use"]);
  assert.equal(out[2].content[0].type, "tool_result");
  assert.equal(out[2].content[0].tool_use_id, "a1");
});

test("a call left hanging, an unknown tool and a stray result are dropped", () => {
  const out = toAnthropic([
    { role: "user", content: "Go" },
    { role: "assistant", content: "", calls: [{ id: "x1", name: "chart_set", input: {} }, { id: "x2", name: "delete_everything", input: {} }] },
    { role: "user", content: "Stop" },
    { role: "tool", results: [{ id: "zz", content: "stray" }] },
  ]);
  assert.ok(!JSON.stringify(out).includes("delete_everything"));
  assert.ok(!JSON.stringify(out).includes('"x1"'), "a call without a result in the next turn goes");
  assert.ok(!JSON.stringify(out).includes("stray"));
  assert.equal(out.at(-1).role, "user");
});

test("only the newest three chart pictures are sent", () => {
  const img = "A".repeat(100);
  const list = [{ role: "user", content: "Look" }];
  for (let k = 0; k < 5; k++) {
    list.push({ role: "assistant", content: "", calls: [{ id: `s${k}`, name: "chart_snapshot", input: {} }] });
    list.push({ role: "tool", results: [{ id: `s${k}`, image: img, mediaType: "image/jpeg" }] });
  }
  const out = toAnthropic(list);
  const images = JSON.stringify(out).match(/"type":"image"/g) || [];
  assert.equal(images.length, 3);
});

test("the catalog: names every provider takes, flat inputs, and nothing dangerous", () => {
  for (const t of AGENT_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(!/oneOf|anyOf|allOf|\$ref/.test(JSON.stringify(t.input_schema)), t.name);
    assert.ok(["page", "server"].includes(t.runs));
  }
  const names = AGENT_TOOLS.map((t) => t.name).join(" ");
  for (const banned of ["custom", "javascript", "key", "webhook", "order", "trade", "ptq", "file", "fetch"]) assert.ok(!names.includes(banned), banned);
  assert.equal(toolSpecs().length, AGENT_TOOLS.length);
});

test("dates, bar lookup and a summary", () => {
  assert.equal(parseWhen("2026-10-19"), Date.UTC(2026, 9, 19) / 1000);
  assert.equal(parseWhen("2026-10-19T14:30"), Date.UTC(2026, 9, 19, 14, 30) / 1000);
  assert.ok(Number.isNaN(parseWhen("yesterday")));
  const bars = [100, 160, 220].map((t) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }));
  assert.equal(barIndexAt(bars, 170), 1);
  assert.equal(barIndexAt(bars, 50), -1);
  assert.equal(summary(bars).bars, 3);
});

test("swings and the last swing on a zigzag", () => {
  // up to 20, down to 5, up to 30: the last swing runs from the low at 5 to the high at 30
  const path = [10, 12, 14, 16, 18, 20, 18, 15, 12, 9, 7, 5, 7, 10, 14, 18, 22, 26, 30, 28, 26, 25, 24, 23, 22];
  const bars = path.map((v, i) => ({ time: 1000 + i * 60, open: v, high: v + 0.5, low: v - 0.5, close: v, volume: 1 }));
  const r = levels(bars, { strength: 3, lookback: 300 });
  assert.equal(r.lastSwing.direction, "up");
  assert.equal(r.lastSwing.from.price, 4.5);
  assert.equal(r.lastSwing.to.price, 30.5);
  assert.equal(r.lastSwing.to.bars_ago, 6);
});

test("the strategy tools: research reads, saving a script is a change with Undo, the guide knows the templates", async () => {
  const by = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t]));
  for (const n of ["ask_person", "next_steps", "market_character", "script_check", "strategy_sweep", "strategy_scan"]) assert.equal(by[n]?.read, true, n);
  // only the next steps end an answer
  assert.deepEqual(AGENT_TOOLS.filter((t) => t.ends).map((t) => t.name), ["next_steps"]);
  assert.ok(by.script_save && !by.script_save.read && !by.script_save.view);
  const { guideText } = await import("../lib/copilot-guide.js");
  const g = guideText();
  assert.ok(!g.includes("%TEMPLATES%"));
  for (const id of ["ma-cross", "supertrend", "trend-pullback"]) assert.ok(g.includes(`--- ${id} (`), id);
  assert.match(g, /chosen on that same 30%, so its last-30% figure is optimistic/);
  assert.match(g, /6\. End with next_steps: "Put it on the chart"/);
  assert.match(g, /Create new, Write with AI… opens this panel/);
  assert.match(g, /then Build a strategy for me \(that box\) and Pick the rules myself/);
});
