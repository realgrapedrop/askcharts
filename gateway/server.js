// Sign-in gateway for AskCharts on a server (Quant Terminal underneath). Everything is closed by
// default: only the sign-in page, its files and the /auth routes answer without a session. A
// signed-in request is passed through to the app on loopback with Host and Origin rewritten to what
// it expects, after this gateway has checked that any write came from our own origin.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openAuth, httpError } from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");

export function configFromEnv(env = process.env) {
  const port = Number(env.PORT || 3778);
  return {
    host: env.HOST || "127.0.0.1",
    port,
    upstream: env.UPSTREAM || "127.0.0.1:3777",
    origin: env.ORIGIN || `http://localhost:${port}`,
    rpID: env.RP_ID || "localhost",
    email: env.ALLOWED_EMAIL || "",
    sessionDays: Number(env.SESSION_DAYS || 7),
    linkMinutes: Number(env.LINK_MINUTES || 15),
    dataDir: env.DATA_DIR || path.join(here, "data"),
    // What sits in front, so the limits count real visitors: cloudflare (a Cloudflare tunnel),
    // forwarded (Caddy, nginx and the like), or empty (nothing: visitors connect straight here).
    trustProxy: env.TRUST_PROXY || "",
  };
}
const PROXIES = ["", "cloudflare", "forwarded"];

// ---------- small helpers ----------
const STATIC = {
  "/auth/static/login.css": ["login.css", "text/css; charset=utf-8"],
  "/auth/static/login.js": ["login.js", "text/javascript; charset=utf-8"],
  "/auth/static/simplewebauthn.js": ["vendor/simplewebauthn-browser-13.3.0.umd.min.js", "text/javascript; charset=utf-8"],
};
const PAGE_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};
// The terminal's own pages. Scripts load only from this site and inline script never runs, so text
// a chart script supplies can't run as code even where a screen forgets to escape it. Inline styles
// stay allowed: the terminal sets style= throughout. Binance's spot and futures streams feed live crypto bars.
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'report-sample'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss://stream.binance.com:9443 wss://data-stream.binance.vision wss://fstream.binance.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "report-uri /csp-report",
].join("; ");
// Cloudflare adds its analytics beacon and an inline bot check to every page it serves. The CSP
// blocks both, which breaks nothing, so their reports stay out of the log. The bot check is known
// by the start of its code ('report-sample' sends the first 40 characters).
const CLOUDFLARE_BEACON = "https://static.cloudflareinsights.com/";
const CLOUDFLARE_BOT_CHECK = "(function(){function c(){var b=a.conte";
const HOP =new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...PAGE_HEADERS, ...extra });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, "Request too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(httpError(400, "Bad request.")); }
    });
    req.on("error", reject);
  });
}

// Fixed-window counters, in memory. Enough for one person and the odd stranger.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
    return ++h.n <= max;
  };
}

// Writes that make the terminal run JavaScript on the server: saving or deleting a custom indicator,
// and importing a signal (the terminal turns it into one). The path is already decoded, as the
// terminal decodes it before routing.
const runsCode = (p) => p === "/api/custom" || p.startsWith("/api/custom/") || p === "/api/import/signal";
// The terminal's strategy research: Pine it runs on the server, in workers with time and memory caps,
// mostly for the AI. No passkey (one AI answer makes 10 to 20 of these), a cap per account instead.
const runsResearch = (p) => p.startsWith("/api/pine/") || p === "/api/market/profile";

// ---------- the gateway ----------
export function createGateway(cfg, { verifyPasskey } = {}) {
  const trustProxy = cfg.trustProxy || "";
  // A typo must not quietly put every visitor in one bucket, where a stranger's tries lock the owner out.
  if (!PROXIES.includes(trustProxy)) throw new Error(`TRUST_PROXY is "${trustProxy}": use cloudflare, forwarded, or leave it empty`);
  const secure = cfg.origin.startsWith("https://");
  const COOKIE = secure ? "__Host-qt" : "qt_session";
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const auth = openAuth({
    dataDir: cfg.dataDir, rpID: cfg.rpID, rpName: "AskCharts", origin: cfg.origin,
    email: cfg.email, sessionDays: cfg.sessionDays, linkMinutes: cfg.linkMinutes,
  });
  const [upHost, upPort] = cfg.upstream.split(":");
  const agent = new http.Agent({ keepAlive: true });
  const authLimit = limiter(30, 10 * 60_000);
  const cspLimit = limiter(20, 10 * 60_000);
  // A fresh passkey check buys one grant: one code-running write, from the same session, within
  // two minutes. A session alone isn't enough, so script in the page can't reach those writes.
  const verifyStepUp = verifyPasskey || ((body) => auth.authenticationVerify(body));
  const stepUpLimit = limiter(60, 10 * 60_000); // two calls a save: room to work on an indicator
  const stepUpMs = cfg.stepUpMs ?? 2 * 60_000;
  const researchMax = cfg.researchMax ?? 120;
  const researchLimit = limiter(researchMax, 10 * 60_000);
  const grants = new Map(); // grant -> { idHash, expires }
  setInterval(() => { const t = Date.now(); for (const [k, g] of grants) if (g.expires < t) grants.delete(k); }, 60_000).unref();

  // Who's asking, for the limits. Anyone can send CF-Connecting-IP or X-Forwarded-For, so a header
  // counts only when TRUST_PROXY says what's in front: Cloudflare sets CF-Connecting-IP itself, and a
  // proxy like Caddy or nginx adds the address it saw to the end of X-Forwarded-For (the start is
  // whatever the visitor sent). Otherwise only the connection's own address counts.
  let warnedHeaders = false;
  const clientIp = (req) => {
    const h = req.headers;
    if (trustProxy === "cloudflare" && h["cf-connecting-ip"]) return String(h["cf-connecting-ip"]);
    if (trustProxy === "forwarded" && h["x-forwarded-for"]) {
      const last = String(h["x-forwarded-for"]).split(",").pop().trim();
      if (last) return last;
    }
    if (!trustProxy && !warnedHeaders && (h["cf-connecting-ip"] || h["x-forwarded-for"])) {
      warnedHeaders = true;
      console.warn("[gateway] requests come through a proxy but TRUST_PROXY is empty, so all visitors share one set of limits. Set TRUST_PROXY to cloudflare or forwarded.");
    }
    return String(req.socket.remoteAddress || "");
  };
  const sessionOf = (req) => auth.readSession(parseCookies(req.headers.cookie)[COOKIE]);
  const sessionCookie = (s) => `${COOKIE}=${s.id}; ${cookieAttrs}; Max-Age=${s.maxAge}`;
  const clearCookie = `${COOKIE}=; ${cookieAttrs}; Max-Age=0`;

  function sendPage(res) {
    fs.readFile(path.join(PUBLIC, "login.html"), (err, buf) => {
      if (err) return sendJson(res, 500, { error: "Sign-in page missing." });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...PAGE_HEADERS });
      res.end(buf);
    });
  }
  function sendStatic(res, [file, type]) {
    fs.readFile(path.join(PUBLIC, file), (err, buf) => {
      if (err) return sendJson(res, 404, { error: "Not found." });
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", ...PAGE_HEADERS });
      res.end(buf);
    });
  }

  // Sends on the path as parsed here, so the terminal routes exactly what the checks above saw.
  function proxy(req, res, url) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== "cookie" && k !== "x-step-up") headers[k] = v;
    headers.host = cfg.upstream;
    if (headers.origin) headers.origin = `http://${cfg.upstream}`;
    if (headers.referer) headers.referer = `http://${cfg.upstream}/`;
    const up = http.request({ host: upHost, port: Number(upPort), method: req.method, path: url.pathname + url.search, headers, agent }, (ur) => {
      const out = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
      out["x-frame-options"] = "DENY";
      out["content-security-policy"] = APP_CSP;
      out["x-content-type-options"] = "nosniff";
      // Nothing behind the sign-in may sit in Cloudflare's cache, where it would be served to
      // anyone. The terminal marks vendor files "public"; make every response private.
      const cc = String(out["cache-control"] || "no-cache").replace(/\bpublic\b/gi, "private");
      out["cache-control"] = /\b(private|no-store)\b/i.test(cc) ? cc : `private, ${cc}`;
      out.vary = out.vary ? `${out.vary}, Cookie` : "Cookie";
      // Cloudflare swaps a 502 or 504 from the tunnel for its own HTML error page, which the terminal
      // then prints as text. Send those as 500 so the terminal's own message gets through.
      let status = ur.statusCode || 500;
      if (status === 502 || status === 504) { out["x-upstream-status"] = String(status); status = 500; }
      res.writeHead(status, out);
      res.flushHeaders(); // event streams start right away
      ur.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) sendJson(res, 503, { error: "AskCharts isn't running." });
      else res.destroy();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  }

  async function route(req, res) {
    const url = new URL(req.url, cfg.origin);
    const p = url.pathname;
    const isRead = req.method === "GET" || req.method === "HEAD";

    // The browser reports anything the terminal's CSP blocked, so a broken screen shows up in the
    // journal. Reports may come without an Origin or cookie; they're only logged, short and capped.
    if (p === "/csp-report" && req.method === "POST") {
      if (!cspLimit(clientIp(req))) return sendJson(res, 429, { error: "Too many reports." });
      const body = await readJson(req, 8 * 1024).catch(() => ({}));
      const r = body["csp-report"] || {};
      const clean = (s) => String(s || "-").replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
      // URLs lose their query and hash before logging, in case either carries something private.
      let page = "-";
      try { page = new URL(r["document-uri"]).pathname; } catch { /* not a URL */ }
      let blocked = r["blocked-uri"];
      try { const u = new URL(blocked); blocked = u.origin === "null" ? u.protocol : u.origin + u.pathname; } catch { /* a keyword such as inline or eval */ }
      const fromCloudflare = String(blocked).startsWith(CLOUDFLARE_BEACON) || String(r["script-sample"] || "").startsWith(CLOUDFLARE_BOT_CHECK);
      if (!fromCloudflare) console.log(`[csp] blocked ${clean(r["violated-directive"] || r["effective-directive"])} ${clean(blocked)} on ${clean(page)}${r["line-number"] ? ` line ${clean(r["line-number"])}` : ""}`);
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }

    // Any write, to us or to the terminal, must come from our own page.
    if (!isRead && req.headers.origin !== cfg.origin) return sendJson(res, 403, { error: "Blocked: wrong origin." });

    // ----- public: the sign-in page and its files -----
    if (isRead && STATIC[p]) return sendStatic(res, STATIC[p]);
    if (isRead && p === "/login") {
      if (sessionOf(req)) { res.writeHead(302, { Location: "/", "Cache-Control": "no-store" }); return res.end(); }
      return sendPage(res);
    }
    if (isRead && /^\/link\/[A-Za-z0-9_-]{30,100}$/.test(p)) return sendPage(res); // opening the link uses nothing up
    if (isRead && p === "/logout") {
      // Only when opened by hand or from our own page, so another site can't sign me out.
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") { res.writeHead(302, { Location: "/", "Cache-Control": "no-store" }); return res.end(); }
      auth.deleteSession(parseCookies(req.headers.cookie)[COOKIE]);
      res.writeHead(302, { Location: "/login", "Set-Cookie": clearCookie, "Cache-Control": "no-store" });
      return res.end();
    }

    // ----- public: the /auth API -----
    if (p.startsWith("/auth/")) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      if (!authLimit(clientIp(req))) return sendJson(res, 429, { error: "Too many tries. Wait a few minutes." });
      const body = await readJson(req);

      if (p === "/auth/login/options") return sendJson(res, 200, await auth.authenticationOptions());
      if (p === "/auth/login/verify") {
        const { userId } = await auth.authenticationVerify({ challengeId: body.challengeId, response: body.response });
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(auth.createSession(userId)) });
      }
      if (p === "/auth/enrol/options") return sendJson(res, 200, await auth.registrationOptions(body.token));
      if (p === "/auth/enrol/verify") {
        const { userId } = await auth.registrationVerify({ challengeId: body.challengeId, response: body.response });
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(auth.createSession(userId)) });
      }
      if (p === "/auth/logout") {
        auth.deleteSession(parseCookies(req.headers.cookie)[COOKIE]);
        return sendJson(res, 200, { ok: true }, { "Set-Cookie": clearCookie });
      }
      return sendJson(res, 404, { error: "Not found." });
    }

    // ----- everything else needs a session -----
    const session = sessionOf(req);
    if (!session) {
      const wantsPage = isRead && String(req.headers.accept || "").includes("text/html");
      if (wantsPage) { res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }); return res.end(); }
      return sendJson(res, 401, { error: "Sign in first." });
    }
    // Who is signed in, for the terminal's logo (its tooltip and Sign out). Answered here, not sent on.
    if (isRead && p === "/session") return sendJson(res, 200, { email: session.email });

    // The fresh passkey check, answered here and never sent on.
    if (p.startsWith("/step-up/")) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });
      if (!stepUpLimit(clientIp(req))) return sendJson(res, 429, { error: "Too many passkey checks. Wait a few minutes." });
      if (p === "/step-up/options") return sendJson(res, 200, await auth.authenticationOptions());
      if (p === "/step-up/verify") {
        const body = await readJson(req);
        const { userId } = await verifyStepUp({ challengeId: body.challengeId, response: body.response });
        if (userId !== session.userId) return sendJson(res, 401, { error: "That passkey isn't for this account." });
        const grant = crypto.randomBytes(32).toString("base64url");
        grants.set(grant, { idHash: session.idHash, expires: Date.now() + stepUpMs });
        return sendJson(res, 200, { grant });
      }
      return sendJson(res, 404, { error: "Not found." });
    }
    if (!isRead) {
      let decoded;
      try { decoded = decodeURIComponent(p); } catch { return sendJson(res, 400, { error: "Bad request." }); }
      if (runsCode(decoded)) {
        // Used up here, whatever the terminal answers.
        const key = String(req.headers["x-step-up"] || "");
        const g = grants.get(key);
        grants.delete(key);
        if (!g || g.idHash !== session.idHash || g.expires < Date.now())
          return sendJson(res, 428, { error: "Saving code that runs on the server needs your passkey. Reload the page and try again.", stepUp: true });
      }
      if (runsResearch(decoded) && !researchLimit(session.idHash))
        return sendJson(res, 429, { error: `That's ${researchMax} strategy tests in 10 minutes, the most allowed. Wait a few minutes.` });
    }
    return proxy(req, res, url);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? "Something went wrong." : e.message });
      else res.destroy();
    });
  });
  server.auth = auth;
  server.on("close", () => { agent.destroy(); auth.close(); });
  return server;
}

// ---------- run ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // started by AskCharts' runner (Docker): stop with it, even if it's killed outright
  if (process.send) process.on("disconnect", () => process.exit(0));
  const cfg = configFromEnv();
  const server = createGateway(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`gateway on http://${cfg.host}:${cfg.port} origin=${cfg.origin} rpID=${cfg.rpID} upstream=${cfg.upstream} proxy=${cfg.trustProxy || "none"}`);
    if (server.auth.passkeyCount() === 0)
      console.log("No passkey yet. Run node gateway/link.mjs (in Docker: docker compose exec askcharts node gateway/link.mjs) and open the link it prints.");
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
}
