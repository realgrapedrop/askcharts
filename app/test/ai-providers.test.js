// AskCharts AI on OpenAI and xAI (Grok), beside Anthropic, against stand-in servers: no real key, nothing
// billed. Each provider keeps its own key, and a key only ever goes to its own provider.
// Run: node --test test/ai-providers.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KEYS = { anthropic: "sk-ant-test-3333", openai: "sk-test-openai-1111", xai: "xai-test-2222" };
const seen = [];
let reply = () => null; // a test's own answer for the next chat request, or null for the default
// one stand-in server per provider, so each request shows which provider it went to
const answer = (at) => (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const r = { at, url: req.url, auth: req.headers.authorization || "", xkey: req.headers["x-api-key"] || "", body: body ? JSON.parse(body) : null };
    seen.push(r);
    const json = (status, o) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(o));
    const own = r.auth === `Bearer ${KEYS[at]}` || r.xkey === KEYS[at];
    if (!own) return at === "xai" ? json(400, { code: "Client specified an invalid argument", error: `Incorrect API key provided: ${r.auth.slice(7)}` }) : json(401, { error: { message: `Incorrect API key provided: ${r.auth.slice(7) || r.xkey}`, type: "invalid_request_error" } });
    if (req.url.startsWith("/v1/models") && at === "openai")
      return json(200, {
        data: [
          { id: "gpt-4.1", created: 1744000000 },
          { id: "gpt-5", created: 1754000000 },
          { id: "gpt-5-mini", created: 1754000001 },
          { id: "gpt-4o-realtime-preview", created: 1760000000 },
          { id: "gpt-image-1", created: 1760000000 },
          { id: "text-embedding-3-small", created: 1700000000 },
          { id: "o3-deep-research", created: 1760000000 },
          { id: "chatgpt-4o-latest", created: 1760000000 },
          { id: "whisper-1", created: 1700000000 },
        ],
      });
    if (req.url === "/v1/language-models" && at === "xai")
      return json(200, {
        models: [
          { id: "grok-3", created: 1740000000, input_modalities: ["text"], output_modalities: ["text"] },
          { id: "grok-4", created: 1752000000, input_modalities: ["text", "image"], output_modalities: ["text"] },
          { id: "grok-2-image", created: 1750000000, input_modalities: ["text"], output_modalities: ["image"] },
        ],
      });
    if (req.url.startsWith("/v1/models") && at === "anthropic") return json(200, { data: [{ type: "model", id: "claude-test", display_name: "Claude Test" }] });
    const custom = reply(r);
    if (custom) return custom(res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (at === "anthropic") {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Hi" } })}\n\n`);
      return res.end(`event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`);
    }
    if (at === "openai") return res.end(events$([["response.output_text.delta", { output_index: 0, item_id: "msg_1", content_index: 0, delta: "Hi" }], completed()]));
    res.end(chunks([{ delta: { content: "Hi" } }, { delta: {}, finish_reason: "stop" }]));
  });
};
// OpenAI's Responses stream, in the shapes of its API reference: "event: <type>" and the event as data
const events$ = (list) => list.map(([type, d]) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: 0, ...d })}\n\n`).join("");
const completed = (usage = { input_tokens: 120, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 129 }) => [
  "response.completed",
  { response: { id: "resp_1", status: "completed", usage } },
];
const chunks = (list, usage = { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 100 } }) =>
  [...list.map((ch) => `data: ${JSON.stringify({ choices: [{ index: 0, ...ch }] })}\n\n`), `data: ${JSON.stringify({ choices: [], usage })}\n\n`, "data: [DONE]\n\n"].join("");
const servers = {};
for (const at of Object.keys(KEYS)) {
  servers[at] = http.createServer(answer(at));
  await new Promise((ok) => servers[at].listen(0, "127.0.0.1", ok));
}
const base = (at) => `http://127.0.0.1:${servers[at].address().port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-providers-"));
Object.assign(process.env, { QT_DATA_DIR: dir, QT_AI_BASE: base("anthropic"), QT_AI_BASE_OPENAI: base("openai"), QT_AI_BASE_XAI: base("xai") });
// a copilot.json from before 0.1.17: one key, Anthropic's, at the top
fs.writeFileSync(path.join(dir, "copilot.json"), JSON.stringify({ provider: "anthropic", key: KEYS.anthropic, model: "claude-test", modelName: "Claude Test", context: false, askFirst: true }));
const copilot = await import("../lib/copilot.js");
const { step } = await import("../lib/agent.js");
const { toolSpecs } = await import("../public/lib/agent-tools.js");
const oai = await import("../lib/ai-openai.js");
after(() => {
  for (const s of Object.values(servers)) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const fakeRes = () => ({ chunks: [], on() {}, writeHead() {}, write(c) { this.chunks.push(c); }, end() { this.writableEnded = true; }, writableEnded: false });
const events = (res) => res.chunks.map((c) => JSON.parse(c.slice(6)));
const leaks = () => {
  for (const r of seen) for (const [id, k] of Object.entries(KEYS)) if (id !== r.at) assert.ok(!JSON.stringify(r).includes(k), `${id}'s key went to ${r.at}`);
};

test("a copilot.json from before 0.1.17 moves in under keys.anthropic; the rest is kept", () => {
  const c = copilot.upgrade({ provider: "anthropic", key: "k1", model: "m1", modelName: "M 1", context: false, askFirst: true });
  assert.deepEqual(c, { provider: "anthropic", context: false, askFirst: true, keys: { anthropic: { key: "k1", model: "m1", modelName: "M 1" } } });
  assert.deepEqual(copilot.upgrade({}), { provider: "anthropic", context: true, keys: {} });
  assert.equal(copilot.upgrade({ provider: "nobody", keys: { openai: { key: "k2", model: "gpt-5" } } }).provider, "anthropic");
  assert.deepEqual(copilot.upgrade({ provider: "xai", keys: { xai: { key: "k3", model: "grok-3", modelName: "grok-3", images: false }, openai: { key: "" } } }).keys, { xai: { key: "k3", model: "grok-3", modelName: "grok-3", images: false } });
  const pub = copilot.publicConfig();
  assert.equal(pub.provider, "anthropic");
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keyHint, "3333");
  assert.equal(pub.context, false);
  assert.deepEqual(pub.providers.map((p) => [p.id, p.hasKey]), [["anthropic", true], ["openai", false], ["xai", false]]);
  assert.ok(!JSON.stringify(pub).includes(KEYS.anthropic));
});

test("models: OpenAI's chat models only, newest first; xAI's text models, with which take pictures", async () => {
  const o = await copilot.listModels({ provider: "openai", key: KEYS.openai });
  assert.deepEqual(o.map((m) => m.id), ["gpt-5-mini", "gpt-5", "gpt-4.1"]);
  const x = await copilot.listModels({ provider: "xai", key: KEYS.xai });
  assert.deepEqual(x.map((m) => [m.id, m.images]), [["grok-4", true], ["grok-3", false]]);
  assert.equal(seen.at(-2).url, "/v1/models");
  assert.equal(seen.at(-1).url, "/v1/language-models");
  assert.equal(seen.at(-1).auth, `Bearer ${KEYS.xai}`);
  leaks();
});

test("no key typed: only that provider's own saved key is used, never another's", async () => {
  const before = seen.length;
  await assert.rejects(copilot.listModels({ provider: "openai" }), /Paste an API key first/);
  await assert.rejects(copilot.setConfig({ provider: "xai", model: "grok-4" }), /Paste an API key first/);
  await assert.rejects(copilot.setConfig({ provider: "openai", context: true }), /Paste your OpenAI key and Test it first/);
  assert.equal(seen.length, before, "nothing was sent anywhere");
  assert.equal(copilot.publicConfig().provider, "anthropic");
});

test("a wrong key says which provider turned it down, without repeating the key", async () => {
  await assert.rejects(copilot.listModels({ provider: "openai", key: "sk-wrong-openai-0000" }), (e) => /^OpenAI didn't accept that key/.test(e.message) && !e.message.includes("sk-wrong-openai-0000"));
  await assert.rejects(copilot.listModels({ provider: "xai", key: "xai-wrong-0000" }), (e) => /^xAI didn't accept that key/.test(e.message) && !e.message.includes("xai-wrong-0000"));
  assert.match(copilot.apiError(400, { error: { message: "This model is only supported in v1/responses and not in v1/chat/completions." } }, "", copilot.PROVIDERS[1]), /^That model doesn't work here/);
  assert.match(copilot.apiError(429, { error: "slow" }, "", copilot.PROVIDERS[2]), /^xAI says slow down/);
});

test("saving an OpenAI key keeps the Anthropic one, switches to OpenAI, and the file stays private", async () => {
  const pub = await copilot.setConfig({ provider: "openai", key: KEYS.openai, model: "gpt-5" });
  assert.equal(pub.provider, "openai");
  assert.equal(pub.model, "gpt-5");
  assert.equal(pub.keyHint, "1111");
  assert.deepEqual(pub.providers.map((p) => [p.id, p.hasKey, p.model]), [["anthropic", true, "claude-test"], ["openai", true, "gpt-5"], ["xai", false, ""]]);
  const file = path.join(dir, "copilot.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.keys.anthropic.key, KEYS.anthropic);
  assert.equal(saved.keys.openai.key, KEYS.openai);
  assert.ok(!("key" in saved), "the old top-level key is gone");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(pub).includes(KEYS.openai));
  // back to Anthropic with its saved key and model: nothing to type
  assert.equal((await copilot.setConfig({ provider: "anthropic", model: "claude-test" })).provider, "anthropic");
  assert.equal((await copilot.setConfig({ provider: "openai", model: "gpt-5" })).provider, "openai");
  leaks();
});

test("OpenAI: the conversation goes over in its Responses form, and text and tool calls stream back", async () => {
  await copilot.setConfig({ provider: "openai", key: KEYS.openai, model: "gpt-5", context: true });
  reply = (r) =>
    r.url === "/v1/responses" &&
    ((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // its thinking, its words, then two calls: one's arguments in pieces, the other's only when it's done
      const fc = (n, id, name) => ({ type: "function_call", id: `fc_${n}`, call_id: id, name, arguments: "", status: "in_progress" });
      res.end(
        events$([
          ["response.created", { response: { id: "resp_1", status: "in_progress" } }],
          ["response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } }],
          ["response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } }],
          ["response.output_item.added", { output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } }],
          ["response.output_text.delta", { output_index: 1, item_id: "msg_1", content_index: 0, delta: "Look" }],
          ["response.output_text.delta", { output_index: 1, item_id: "msg_1", content_index: 0, delta: "ing." }],
          ["response.output_item.added", { output_index: 2, item: fc(1, "call_A1", "market_search") }],
          ["response.function_call_arguments.delta", { output_index: 2, item_id: "fc_1", delta: '{"que' }],
          ["response.output_item.added", { output_index: 3, item: fc(2, "call_B2", "chart_snapshot") }],
          ["response.function_call_arguments.delta", { output_index: 2, item_id: "fc_1", delta: 'ry":"XRP"}' }],
          ["response.function_call_arguments.done", { output_index: 2, item_id: "fc_1", arguments: '{"query":"XRP"}' }],
          ["response.output_item.done", { output_index: 2, item: { ...fc(1, "call_A1", "market_search"), arguments: '{"query":"XRP"}', status: "completed" } }],
          ["response.output_item.done", { output_index: 3, item: { ...fc(2, "call_B2", "chart_snapshot"), arguments: "{}", status: "completed" } }],
          completed(),
        ]),
      );
    });
  const res = fakeRes();
  await step(
    {
      messages: [
        { role: "user", content: "Show XRP" },
        { role: "assistant", content: "On it.", calls: [{ id: "c1", name: "market_search", input: { query: "XRP" } }, { id: "c2", name: "chart_snapshot", input: {} }] },
        { role: "tool", results: [{ id: "c1", content: "[KRAKEN:XRPUSD]" }, { id: "c2", image: "QUJD", mediaType: "image/png", text: "The chart." }] },
        { role: "user", content: "Now on 1h" },
      ],
      context: { symbol: "KRAKEN:XRPUSD" },
    },
    res,
  );
  reply = () => null;
  const r = seen.at(-1);
  assert.equal(r.url, "/v1/responses");
  assert.equal(r.auth, `Bearer ${KEYS.openai}`);
  assert.equal(r.body.model, "gpt-5");
  assert.equal(r.body.store, false, "nothing kept at OpenAI");
  assert.equal(r.body.stream, true);
  assert.equal(r.body.max_output_tokens, 16000);
  for (const k of ["max_tokens", "max_completion_tokens", "stream_options", "reasoning", "messages", "temperature"]) assert.ok(!(k in r.body), k);
  assert.match(r.body.instructions, /You are AskCharts AI/);
  assert.match(r.body.instructions, /KRAKEN:XRPUSD/);
  assert.ok(r.body.tools.length > 10 && r.body.tools.every((t) => t.type === "function" && t.name && t.parameters?.type === "object" && t.strict === false && !t.function));
  assert.ok(!JSON.stringify(r.body).includes("cache_control"));
  assert.deepEqual(r.body.input, [
    { role: "user", content: "Show XRP" },
    { role: "assistant", content: "On it." },
    // no item id on a call sent back: nothing is stored at OpenAI for it to point to
    { type: "function_call", call_id: "c1", name: "market_search", arguments: '{"query":"XRP"}' },
    { type: "function_call", call_id: "c2", name: "chart_snapshot", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "[KRAKEN:XRPUSD]" },
    { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "The chart." }, { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "auto" }] },
    { role: "user", content: "Now on 1h" },
  ]);
  const ev = events(res);
  assert.deepEqual(ev[0], { t: "start", model: "gpt-5" });
  assert.equal(ev.filter((e) => e.t === "text").map((e) => e.v).join(""), "Looking.");
  assert.deepEqual(ev.filter((e) => e.t === "call"), [{ t: "call", id: "call_A1", name: "market_search", input: { query: "XRP" } }, { t: "call", id: "call_B2", name: "chart_snapshot", input: {} }]);
  assert.deepEqual(ev.at(-1), { t: "done", stop: "tool_use", usage: { input: 20, output: 9, cached: 100 } });
  leaks();
});

test("xAI stays on chat completions: tool calls in pieces by index, results as tool messages", async () => {
  await copilot.setConfig({ provider: "xai", key: KEYS.xai, model: "grok-4" });
  reply = (r) =>
    r.url === "/v1/chat/completions" &&
    ((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        chunks([
          { delta: { role: "assistant", content: "Look" } },
          { delta: { content: "ing." } },
          { delta: { tool_calls: [{ index: 0, id: "call_A1", type: "function", function: { name: "market_search", arguments: "" } }] } },
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } },
          { delta: { tool_calls: [{ index: 1, id: "call_B2", type: "function", function: { name: "chart_snapshot", arguments: "{}" } }] } },
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"XRP"}' } }] } },
          { delta: {}, finish_reason: "tool_calls" },
        ]),
      );
    });
  const res = fakeRes();
  await step(
    {
      messages: [
        { role: "user", content: "Show XRP" },
        { role: "assistant", content: "On it.", calls: [{ id: "c1", name: "market_search", input: { query: "XRP" } }, { id: "c2", name: "chart_snapshot", input: {} }] },
        { role: "tool", results: [{ id: "c1", content: "[KRAKEN:XRPUSD]" }, { id: "c2", image: "QUJD", mediaType: "image/png", text: "The chart." }] },
        { role: "user", content: "Now on 1h" },
      ],
    },
    res,
  );
  reply = () => null;
  const r = seen.at(-1);
  assert.equal(r.at, "xai");
  assert.equal(r.url, "/v1/chat/completions");
  assert.equal(r.body.tools[0].type, "function");
  assert.ok(r.body.tools.every((t) => t.function.name && t.function.parameters));
  const m = r.body.messages;
  assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(m[2].tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]), [["c1", "market_search", '{"query":"XRP"}'], ["c2", "chart_snapshot", "{}"]]);
  assert.deepEqual([m[3].tool_call_id, m[3].content], ["c1", "[KRAKEN:XRPUSD]"]);
  // the picture and what was typed after it come in one user message, after every tool message
  assert.deepEqual(m[5].content.map((p) => p.type), ["text", "image_url", "text"]);
  assert.equal(m[5].content[1].image_url.url, "data:image/png;base64,QUJD");
  assert.equal(m[5].content[2].text, "Now on 1h");
  const ev = events(res);
  assert.equal(ev.filter((e) => e.t === "text").map((e) => e.v).join(""), "Looking.");
  assert.deepEqual(ev.filter((e) => e.t === "call").map((e) => e.id), ["call_A1", "call_B2"]);
  assert.deepEqual(ev.at(-1), { t: "done", stop: "tool_use", usage: { input: 20, output: 9, cached: 100 } });
  leaks();
});

test("xAI: max_tokens, usage asked for, and no picture to a model that doesn't take one", async () => {
  await copilot.setConfig({ provider: "xai", key: KEYS.xai, model: "grok-3" });
  const res = fakeRes();
  await step({ messages: [{ role: "user", content: "Look" }, { role: "assistant", content: "", calls: [{ id: "s1", name: "chart_snapshot", input: {} }] }, { role: "tool", results: [{ id: "s1", image: "QUJD", mediaType: "image/jpeg" }] }] }, res);
  const r = seen.at(-1);
  assert.equal(r.at, "xai");
  assert.equal(r.auth, `Bearer ${KEYS.xai}`);
  assert.equal(r.body.max_tokens, 16000);
  assert.deepEqual(r.body.stream_options, { include_usage: true }, "usage at the end, for the token count");
  assert.ok(!("max_completion_tokens" in r.body));
  assert.ok(!JSON.stringify(r.body).includes("image_url"));
  assert.match(r.body.messages.at(-1).content, /doesn't take pictures/);
  assert.deepEqual(events(res).at(-1).t, "done");
  leaks();
});

test("xAI turning the usage option down: asked once more without it, and without it from then on", async () => {
  await copilot.setConfig({ provider: "xai", model: "grok-4" });
  let refused = 0;
  reply = (r) =>
    r.url === "/v1/chat/completions" &&
    r.body.stream_options &&
    ((res) => {
      refused++;
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ code: "Client specified an invalid argument", error: "Unknown field: stream_options" }));
    });
  const ask = () => {
    const res = fakeRes();
    return step({ messages: [{ role: "user", content: "Hi" }] }, res).then(() => res);
  };
  const first = seen.length;
  assert.equal(events(await ask()).at(-1).t, "done");
  assert.equal(refused, 1);
  assert.equal(seen.length - first, 2);
  assert.ok(!("stream_options" in seen.at(-1).body));
  assert.equal(events(await ask()).at(-1).t, "done");
  assert.equal(refused, 1, "the second time it isn't sent at all");
  reply = () => null;
  oai.noUsage.clear();
});

test("a model that turns a picture down: asked once more without it, and text only from then on", async () => {
  await copilot.setConfig({ provider: "openai", model: "gpt-4.1" });
  let refused = 0;
  reply = (r) =>
    r.url === "/v1/responses" &&
    JSON.stringify(r.body).includes("input_image") &&
    ((res) => {
      refused++;
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid content type. input_image is only supported by certain models.", type: "invalid_request_error" } }));
    });
  const ask = () => {
    const res = fakeRes();
    return step({ messages: [{ role: "user", content: "Look" }, { role: "assistant", content: "", calls: [{ id: "s1", name: "chart_snapshot", input: {} }] }, { role: "tool", results: [{ id: "s1", image: "QUJD", mediaType: "image/jpeg" }] }] }, res).then(() => res);
  };
  const first = seen.length;
  assert.equal(events(await ask()).at(-1).t, "done");
  assert.equal(refused, 1);
  assert.equal(seen.length - first, 2);
  assert.equal(events(await ask()).at(-1).t, "done");
  assert.equal(refused, 1, "the second time it isn't sent at all");
  reply = () => null;
});

test("the tools as OpenAI checks them: an object each, every list says what's in it", () => {
  const problems = [];
  const walk = (n, at) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "array" && !n.items) problems.push(`${at}: a list without items`);
    if (Array.isArray(n.type)) problems.push(`${at}: more than one type`);
    for (const r of n.required || []) if (!n.properties?.[r]) problems.push(`${at}: requires ${r}, which isn't there`);
    for (const [k, v] of Object.entries(n.properties || {})) walk(v, `${at}.${k}`);
    walk(n.items, `${at}[]`);
  };
  for (const t of toolSpecs()) {
    if (t.input_schema?.type !== "object") problems.push(`${t.name}: not an object`);
    walk(t.input_schema, t.name);
  }
  assert.deepEqual(problems, []);
});

test("a save that names no provider keeps the one in use", async () => {
  const was = copilot.publicConfig().provider;
  assert.notEqual(was, "anthropic");
  assert.equal((await copilot.setConfig({ askFirst: true })).provider, was);
  assert.equal((await copilot.setConfig({ askFirst: false })).provider, was);
});

test("a reasoning model that runs out of room before writing anything says so", async () => {
  reply = (r) =>
    r.url === "/v1/responses" &&
    ((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events$([["response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1" } }], ["response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 50, output_tokens: 16000 } } }]]));
    });
  let res = fakeRes();
  await step({ messages: [{ role: "user", content: "Think hard" }] }, res);
  let ev = events(res);
  assert.match(ev.find((e) => e.t === "error").message, /whole allowance thinking/);
  assert.deepEqual(ev.at(-1), { t: "done", stop: "max_tokens", usage: { input: 50, output: 16000, cached: 0 } });
  // and on xAI
  await copilot.setConfig({ provider: "xai", model: "grok-4" });
  reply = (r) =>
    r.url === "/v1/chat/completions" &&
    ((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunks([{ delta: { role: "assistant" } }, { delta: {}, finish_reason: "length" }]));
    });
  res = fakeRes();
  await step({ messages: [{ role: "user", content: "Think hard" }] }, res);
  reply = () => null;
  ev = events(res);
  assert.match(ev.find((e) => e.t === "error").message, /whole allowance thinking/);
  assert.equal(ev.at(-1).stop, "max_tokens");
  await copilot.setConfig({ provider: "openai", model: "gpt-4.1" });
});

test("an error mid-answer is passed on in plain words; chat works on OpenAI too", async () => {
  // OpenAI's two ways: an error event (its message at the top), and a failed response
  for (const [type, d] of [["error", { code: "server_error", message: "The server had an error", param: null }], ["response.failed", { response: { status: "failed", error: { code: "server_error", message: "The server had an error" } } }]]) {
    reply = (r) =>
      r.url === "/v1/responses" &&
      ((res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(events$([[type, d]]));
      });
    const res = fakeRes();
    await step({ messages: [{ role: "user", content: "Hi" }] }, res);
    assert.equal(events(res).find((e) => e.t === "error")?.message, "OpenAI replied: The server had an error", type);
  }
  // xAI's, inside the stream
  await copilot.setConfig({ provider: "xai", model: "grok-4" });
  reply = (r) =>
    r.url === "/v1/chat/completions" &&
    ((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ error: "The server had an error" })}\n\n`);
    });
  let res = fakeRes();
  await step({ messages: [{ role: "user", content: "Hi" }] }, res);
  reply = () => null;
  assert.equal(events(res).find((e) => e.t === "error").message, "xAI replied: The server had an error");
  await copilot.setConfig({ provider: "openai", model: "gpt-4.1" });
  res = fakeRes();
  await copilot.chat({ messages: [{ role: "user", content: "What is RSI?" }] }, res);
  assert.equal(seen.at(-1).url, "/v1/responses");
  assert.equal(seen.at(-1).body.tools, undefined);
  assert.deepEqual(seen.at(-1).body.input, [{ role: "user", content: "What is RSI?" }]);
  assert.equal(events(res).filter((e) => e.t === "text").map((e) => e.v).join(""), "Hi");
  leaks();
});

test("Anthropic is spoken to as before, and removing one provider's key leaves the others", async () => {
  await copilot.setConfig({ provider: "anthropic", model: "claude-test" });
  const res = fakeRes();
  await step({ messages: [{ role: "user", content: "Hi" }] }, res);
  const r = seen.at(-1);
  assert.equal(r.at, "anthropic");
  assert.equal(r.url, "/v1/messages");
  assert.equal(r.xkey, KEYS.anthropic);
  assert.equal(r.auth, "");
  assert.equal(r.body.max_tokens, 4096);
  assert.ok(r.body.tools.at(-1).cache_control);
  assert.deepEqual(events(res).at(-1), { t: "done", stop: "end_turn", usage: { input: 0, output: 1, cached: 0 } });
  const pub = copilot.removeKey("openai");
  assert.deepEqual(pub.providers.map((p) => [p.id, p.hasKey]), [["anthropic", true], ["openai", false], ["xai", true]]);
  assert.equal(pub.provider, "anthropic");
  assert.equal(pub.hasKey, true);
  leaks();
});

test("a model thinking a long time: comment lines keep the answer open (the tunnel cuts a quiet one), none after the end", async () => {
  // xAI and Anthropic, each quiet for a while before its first word
  const late = (url, body) => (r) =>
    r.url === url &&
    ((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      setTimeout(() => res.end(body), 150);
    });
  process.env.QT_AI_BEAT_MS = "30";
  try {
    for (const [provider, model, url, body] of [
      ["xai", "grok-4", "/v1/chat/completions", chunks([{ delta: { role: "assistant", content: "Done." } }, { delta: {}, finish_reason: "stop" }])],
      ["anthropic", "claude-test", "/v1/messages", `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Done." } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`],
    ]) {
      await copilot.setConfig({ provider, model });
      reply = late(url, body);
      const res = fakeRes();
      await step({ messages: [{ role: "user", content: "Think it over" }] }, res);
      const quiet = res.chunks.filter((c) => c.startsWith(":"));
      assert.ok(quiet.length >= 2, `${provider}: ${quiet.length} comment lines`);
      assert.ok(quiet.every((c) => !c.includes("data:") && c.endsWith("\n\n")));
      // the page reads only the data lines, as before
      const ev = res.chunks.filter((c) => c.startsWith("data:")).map((c) => JSON.parse(c.slice(5)));
      assert.equal(ev.filter((e) => e.t === "text").map((e) => e.v).join(""), "Done.");
      assert.equal(ev.at(-1).t, "done");
      const n = res.chunks.length;
      await new Promise((ok) => setTimeout(ok, 90));
      assert.equal(res.chunks.length, n, `${provider}: nothing after the end`);
    }
  } finally {
    delete process.env.QT_AI_BEAT_MS;
    reply = () => null;
  }
});

test("a provider turning the question down, once the answer has started: its words as an error, then done", async () => {
  await copilot.setConfig({ provider: "xai", model: "grok-4" });
  reply = (r) => r.url === "/v1/chat/completions" && ((res) => res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ code: "Too many requests", error: "slow" })));
  const res = fakeRes();
  try {
    await step({ messages: [{ role: "user", content: "Hi" }] }, res);
  } finally {
    reply = () => null;
  }
  const ev = events(res);
  assert.equal(ev[0].t, "start");
  assert.match(ev.find((e) => e.t === "error").message, /^xAI says slow down/);
  assert.equal(ev.at(-1).t, "done");
  assert.ok(res.writableEnded);
  // and the next question isn't refused as still working
  const again = fakeRes();
  await step({ messages: [{ role: "user", content: "Hi" }] }, again);
  assert.equal(events(again).at(-1).t, "done");
});
