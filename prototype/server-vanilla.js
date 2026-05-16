/**
 * Apple Health Coach — Vanilla-Node fallback server
 *
 * Why this exists: the agent sandbox cannot reach the npm registry, so the
 * Express-based `server.js` cannot be booted there. This file is identical in
 * behaviour but uses only Node's built-in http and fs modules — zero deps.
 *
 * In production we still ship the Express version (per spec.md). This is a
 * verification shim. Run with:  `node server-vanilla.js`
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const { loadEnv } = require("./lib/env");
loadEnv();

const {
  validateContext,
  synthesizeSignature,
  buildNudge,
  buildMedicalReport,
  processChatRequest,
  buildGreeting,
} = require("./lib/signature");
const { generateReply, isLLMConfigured, DEFAULT_MODEL } = require("./lib/llm");
const { applySafetyGate } = require("./lib/safety");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  let safe = path.normalize(pathname).replace(/^([/\\])+/, "");
  if (safe === "" || safe === ".") safe = "index.html";
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  try {
    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, {
        status: "ok",
        phase: 1,
        name: "Apple Health Coach Prototype",
        runtime: "vanilla-node",
      });
    }

    if (req.method === "GET" && pathname === "/api/nudge") {
      const ctx = {
        hrv: Number(parsed.query.hrv),
        sleep: parsed.query.sleep,
        arousal: parsed.query.arousal,
      };
      const err = validateContext(ctx);
      if (err) return sendJson(res, 400, { error: err });
      const signature = synthesizeSignature(ctx);
      const nudge = buildNudge(signature);
      return sendJson(res, 200, { signature, nudge });
    }

    if (req.method === "POST" && pathname === "/api/chat/greeting") {
      const t0 = Date.now();
      const body = await readBody(req);
      const ctxErr = validateContext(body && body.context);
      if (ctxErr) return sendJson(res, 400, { error: ctxErr });
      const turn = buildGreeting(body.context);
      const llm = await generateReply({
        state: turn.intentState,
        signature: turn.signature,
        intervention: turn.intervention,
        history: [],
        userMessage: "(opening)",
        templateReply: turn.reply,
        calendarEvent: (body.context && body.context.calendarEvent) || "none",
        negotiationAttempt: 0,
      });
      return sendJson(res, 200, {
        ...turn,
        reply: llm.text,
        usedFallback: llm.usedFallback,
        fallbackReason: llm.fallbackReason,
        model: llm.model || (llm.usedFallback ? null : DEFAULT_MODEL),
        llmLatencyMs: llm.latencyMs,
        latencyMs: Date.now() - t0,
      });
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const t0 = Date.now();
      const body = await readBody(req);
      const { message, context, history } = body || {};
      if (typeof message !== "string" || !message.trim()) {
        return sendJson(res, 400, { error: "message (string) is required" });
      }
      const ctxErr = validateContext(context);
      if (ctxErr) return sendJson(res, 400, { error: ctxErr });
      if (history !== undefined && !Array.isArray(history)) {
        return sendJson(res, 400, { error: "history must be an array if provided" });
      }

      // Phase 2.3 safety gate
      const safety = applySafetyGate({ message });
      if (safety.intercepted) {
        return sendJson(res, 200, {
          reply: safety.response,
          signature: synthesizeSignature(context),
          intent: "SAFETY_INTERCEPT",
          intentState: "safety_refused",
          intervention: null,
          negotiationAttempt: 0,
          safetyHardcoded: true,
          safetyClass: safety.safetyClass,
          usedFallback: false,
          fallbackReason: null,
          model: null,
          latencyMs: Date.now() - t0,
        });
      }

      const turn = processChatRequest({ message, context, history: history || [] });
      const llm = await generateReply({
        state: turn.intentState,
        signature: turn.signature,
        intervention: turn.intervention,
        history: history || [],
        userMessage: message,
        templateReply: turn.reply,
        calendarEvent: (context && context.calendarEvent) || "none",
        negotiationAttempt: turn.negotiationAttempt || 0,
      });
      return sendJson(res, 200, {
        ...turn,
        reply: llm.text,
        usedFallback: llm.usedFallback,
        fallbackReason: llm.fallbackReason,
        model: llm.model || (llm.usedFallback ? null : DEFAULT_MODEL),
        llmLatencyMs: llm.latencyMs,
        latencyMs: Date.now() - t0,
      });
    }

    if (req.method === "POST" && pathname === "/api/medical-report") {
      const body = await readBody(req);
      const ctxErr = validateContext(body && body.context);
      if (ctxErr) return sendJson(res, 400, { error: ctxErr });
      return sendJson(res, 200, buildMedicalReport(body.context));
    }

    // Phase 3 polish: PM Interview Feedback
    if (req.method === "POST" && pathname === "/api/notes") {
      const body = await readBody(req);
      const text = body && body.text;
      if (typeof text !== "string" || !text.trim()) {
        return sendJson(res, 400, { error: "text (string) is required" });
      }
      try {
        const dir = path.join(__dirname, "interviews");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "session_notes.json");
        let notes = [];
        if (fs.existsSync(file)) {
          try { notes = JSON.parse(fs.readFileSync(file, "utf8")); } catch { notes = []; }
        }
        if (!Array.isArray(notes)) notes = [];
        const entry = { ts: new Date().toISOString(), text: text.trim() };
        notes.push(entry);
        fs.writeFileSync(file, JSON.stringify(notes, null, 2));
        return sendJson(res, 200, { ok: true, count: notes.length, entry });
      } catch (e) {
        return sendJson(res, 500, { error: "write_failed", detail: e && e.message });
      }
    }

    if (req.method === "GET") {
      return serveStatic(req, res, pathname);
    }

    sendJson(res, 405, { error: "method_not_allowed" });
  } catch (e) {
    console.error("[server-vanilla] error:", e);
    sendJson(res, 400, { error: e.message || "bad_request" });
  }
});

server.listen(PORT, () => {
  const llmStatus = isLLMConfigured()
    ? `LLM: ON (${DEFAULT_MODEL})`
    : "LLM: OFF (template fallback) — set OPENAI_API_KEY to enable";
  console.log(
    `[Apple Health Coach Prototype — vanilla] listening on http://localhost:${PORT}\n  ${llmStatus}`
  );
});
