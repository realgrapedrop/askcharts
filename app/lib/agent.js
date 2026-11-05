// AskCharts AI on the server: one round with the model. The page sends the conversation in a shared
// form ({role: user | assistant (text and the tools it called) | tool (their results)}); this adds the
// guide and the chart (cached by the provider), the tool list, and relays the model's answer as it's
// written: text, then the tools it wants run. The page runs them and comes back for the next round.
// The key stays here (lib/copilot.js); it is only ever sent to the provider. OpenAI and xAI get the
// same conversation, turned into their own form by lib/ai-openai.js.
import { agentConfig, apiError, readEvents } from "./copilot.js";
import { systemBlocks } from "./copilot-guide.js";
import { toolSpecs, AGENT_TOOL_BY_NAME } from "../public/lib/agent-tools.js";
import * as oai from "./ai-openai.js";

const API_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;
const MAX_MESSAGES = 120;
const MAX_TEXT = 30000;
const MAX_IMAGES = 3;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// The tools as the provider sees them; the last one marks the end of what's cached (tools, then guide).
let specs = null;
const tools = () => {
  if (!specs) {
    specs = toolSpecs();
    specs[specs.length - 1] = { ...specs.at(-1), cache_control: { type: "ephemeral" } };
  }
  return specs;
};
// models that turned down a chart picture (provider:model), sent text only from then on
const noImages = new Set();

// The shared form into Anthropic's: tool calls are tool_use blocks, their results tool_result blocks in
// a user turn (first in it), turns of the same role merge, and the conversation starts with a user.
export function toAnthropic(list) {
  if (!Array.isArray(list)) throw bad("Send the conversation as a list.");
  if (list.length > MAX_MESSAGES) list = list.slice(-MAX_MESSAGES);
  const out = [];
  let images = 0;
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const prev = out.at(-1);
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  // images count from the newest back, so the latest pictures are the ones kept
  for (const m of [...list].reverse()) if (m?.role === "tool") for (const r of m.results || []) if (r?.image) r._keep = ++images <= MAX_IMAGES;
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user" && typeof m.content === "string" && m.content.trim()) push("user", [{ type: "text", text: m.content.slice(0, MAX_TEXT) }]);
    else if (m.role === "assistant") {
      const blocks = [];
      if (typeof m.content === "string" && m.content.trim()) blocks.push({ type: "text", text: m.content.slice(0, MAX_TEXT) });
      for (const c of Array.isArray(m.calls) ? m.calls : []) {
        if (!ID.test(String(c?.id)) || !AGENT_TOOL_BY_NAME[c?.name]) continue;
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input && typeof c.input === "object" && !Array.isArray(c.input) ? c.input : {} });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      const blocks = [];
      for (const r of Array.isArray(m.results) ? m.results : []) {
        if (!ID.test(String(r?.id))) continue;
        let content;
        if (r.image && r._keep && /^image\/(jpeg|png)$/.test(r.mediaType) && typeof r.image === "string" && r.image.length < 2_000_000 && /^[A-Za-z0-9+/=]+$/.test(r.image))
          content = [{ type: "text", text: String(r.text || "A picture of the chart.").slice(0, 500) }, { type: "image", source: { type: "base64", media_type: r.mediaType, data: r.image } }];
        else content = r.image ? "[a picture of the chart, left out]" : String(r.content ?? "").slice(0, MAX_TEXT);
        blocks.push({ type: "tool_result", tool_use_id: r.id, content, ...(r.error ? { is_error: true } : {}) });
      }
      push("user", blocks);
    }
  }
  for (const m of out) if (m.role === "user") m.content.sort((a, b) => (a.type === "tool_result" ? 0 : 1) - (b.type === "tool_result" ? 0 : 1));
  // a tool_use must be answered by a tool_result in the next turn: drop calls left hanging, and
  // results whose call isn't there
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== "assistant") continue;
    const next = out[i + 1];
    const answered = new Set((next?.role === "user" ? next.content : []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id));
    m.content = m.content.filter((b) => b.type !== "tool_use" || answered.has(b.id));
    if (next?.role === "user") {
      const asked = new Set(m.content.filter((b) => b.type === "tool_use").map((b) => b.id));
      next.content = next.content.filter((b) => b.type !== "tool_result" || asked.has(b.tool_use_id));
    }
  }
  const clean = out.filter((m) => m.content.length);
  // Anthropic wants a user first, with no tool results in it
  while (clean.length && (clean[0].role !== "user" || clean[0].content.some((b) => b.type === "tool_result"))) clean.shift();
  if (!clean.length || clean.at(-1).role !== "user") throw bad("Ask a question first.");
  return clean;
}

// One round at a time (one person uses this app); Stop or a closed tab ends it upstream too.
let busy = false;
export async function step(input, res, fetchImpl = fetch) {
  const c = agentConfig();
  if (!c.key) throw bad("Add an API key in Settings, AskCharts AI first.");
  if (!c.model) throw bad("Pick a model in Settings, AskCharts AI first.");
  const messages = toAnthropic(input?.messages);
  const p = c.provider,
    openai = p.kind === "openai";
  const system = systemBlocks(c.context ? input?.context : null);
  // OpenAI's form; pictures only to a model that takes them
  const seen = `${p.id}:${c.model}`;
  const ask = (images) =>
    openai
      ? oai.request(c, { system, messages, tools: toolSpecs(), images })
      : {
          url: `${c.base}/v1/messages`,
          headers: { "x-api-key": c.key, "anthropic-version": API_VERSION, "content-type": "application/json" },
          body: { model: c.model, max_tokens: MAX_TOKENS, tools: tools(), system, messages, stream: true },
        };
  if (busy) throw bad("AskCharts AI is still working. Wait for it, or press Stop.", 429);
  busy = true;
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  // The answer starts at once, not when the provider's does: Cloudflare cuts one that sends nothing for 100 s,
  // and a model can think that long over a big tool result (a strategy scan) before its first word. A comment
  // line every 15 s keeps it open (the page reads only data lines); a provider's refusal comes as an error.
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ t: "start", model: c.modelName || c.model });
  const beat = setInterval(() => res.writableEnded || res.write(": thinking\n\n"), Number(process.env.QT_AI_BEAT_MS) || 15_000);
  try {
    let r;
    const post = (q) => fetchImpl(q.url, { method: "POST", headers: q.headers, body: JSON.stringify(q.body), signal: ac.signal });
    try {
      let images = c.images && !noImages.has(seen),
        q = ask(images);
      r = await post(q);
      // a server that won't take the usage option, or a model that won't take a chart picture: once more
      // without it, and without it from then on
      for (let tries = 0; openai && r.status === 400 && tries < 2; tries++) {
        const why = JSON.stringify(await r.clone().json().catch(() => ({})));
        if (q.body.stream_options && /stream_options|include_usage/i.test(why)) oai.noUsage.add(p.id);
        else if (/"(image_url|input_image)"/.test(JSON.stringify(q.body)) && /image/i.test(why)) {
          noImages.add(seen);
          images = false;
        } else break;
        q = ask(images);
        r = await post(q);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      throw bad(`Couldn't reach ${p.label}: ${e.message}`, 502);
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw bad(apiError(r.status, body, c.key, p), r.status === 429 ? 429 : 502);
    }
    if (openai) {
      let done = null;
      try {
        done = await oai.read(c, r.body, readEvents, {
          text: (v) => send({ t: "text", v }),
          call: (x) => send({ t: "call", ...x }),
          error: (d) => send({ t: "error", message: apiError(0, d, c.key, p) }),
        });
      } catch (e) {
        if (!ac.signal.aborted) send({ t: "error", message: `The answer broke off: ${e.message}` });
      }
      if (!res.writableEnded) {
        if (done?.empty && done.stop === "max_tokens") send({ t: "error", message: oai.THOUGHT_OUT });
        send({ t: "done", stop: done?.stop || null, usage: done?.usage || { input: 0, output: 0, cached: 0 } });
        res.end();
      }
      return;
    }
    const blocks = {};
    let stop = null,
      usage = {};
    try {
      await readEvents(r.body, (type, data) => {
        if (type === "content_block_start" && data.content_block?.type === "tool_use") blocks[data.index] = { id: data.content_block.id, name: data.content_block.name, json: "" };
        else if (type === "content_block_delta") {
          if (data.delta?.type === "text_delta") send({ t: "text", v: data.delta.text });
          else if (data.delta?.type === "input_json_delta" && blocks[data.index]) blocks[data.index].json += data.delta.partial_json || "";
        } else if (type === "content_block_stop" && blocks[data.index]) {
          const b = blocks[data.index];
          let input = {};
          try {
            input = b.json.trim() ? JSON.parse(b.json) : {};
          } catch {
            input = { _unreadable: true };
          }
          send({ t: "call", id: b.id, name: b.name, input });
          delete blocks[data.index];
        } else if (type === "message_start") usage = { ...usage, ...(data.message?.usage || {}) };
        else if (type === "message_delta") {
          stop = data.delta?.stop_reason || stop;
          usage = { ...usage, ...(data.usage || {}) };
        } else if (type === "error") send({ t: "error", message: apiError(0, data, c.key, p) });
      });
    } catch (e) {
      if (!ac.signal.aborted) send({ t: "error", message: `The answer broke off: ${e.message}` });
    }
    if (!res.writableEnded) {
      send({ t: "done", stop, usage: { input: usage.input_tokens || 0, output: usage.output_tokens || 0, cached: usage.cache_read_input_tokens || 0 } });
      res.end();
    }
  } catch (e) {
    if (!res.writableEnded) {
      send({ t: "error", message: e.message });
      send({ t: "done", stop: null, usage: { input: 0, output: 0, cached: 0 } });
      res.end();
    }
  } finally {
    clearInterval(beat);
    busy = false;
  }
}
