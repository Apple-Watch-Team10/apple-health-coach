/**
 * Apple Health Coach — Prototype Backend
 * MGMT 475 Final Project
 *
 * Express server. The pure synthesis logic lives in ./lib/signature.js so it
 * can be smoke-tested without npm dependencies.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const { loadEnv } = require("./lib/env");
loadEnv(); // populate process.env from ./.env if present

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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", phase: 1, name: "Apple Health Coach Prototype" });
});

// Stress Signature nudge for the current biometric context.
app.get("/api/nudge", (req, res) => {
  const ctx = {
    hrv: Number(req.query.hrv),
    sleep: req.query.sleep,
    arousal: req.query.arousal,
  };
  const err = validateContext(ctx);
  if (err) return res.status(400).json({ error: err });
  const signature = synthesizeSignature(ctx);
  const nudge = buildNudge(signature);
  res.json({ signature, nudge });
});

// Greeting opener (used when the user taps "Talk to Siri" from the nudge).
app.post("/api/chat/greeting", async (req, res) => {
  const t0 = Date.now();
  const { context } = req.body || {};
  const ctxErr = validateContext(context);
  if (ctxErr) return res.status(400).json({ error: ctxErr });

  const turn = buildGreeting(context);
  const llm = await generateReply({
    state: turn.intentState,
    signature: turn.signature,
    intervention: turn.intervention,
    history: [],
    userMessage: "(opening)",
    templateReply: turn.reply,
    calendarEvent: (context && context.calendarEvent) || "none",
    negotiationAttempt: 0,
  });

  res.json({
    ...turn,
    reply: llm.text,
    usedFallback: llm.usedFallback,
    fallbackReason: llm.fallbackReason,
    model: llm.model || (llm.usedFallback ? null : DEFAULT_MODEL),
    llmLatencyMs: llm.latencyMs,
    latencyMs: Date.now() - t0,
  });
});

// Siri Negotiation — conversation-aware (Path A state machine + Phase 2 LLM
// + Phase 2.3 pre-flight safety classifier).
app.post("/api/chat", async (req, res) => {
  const t0 = Date.now();
  const { message, context, history } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message (string) is required" });
  }
  const ctxErr = validateContext(context);
  if (ctxErr) return res.status(400).json({ error: ctxErr });
  if (history !== undefined && !Array.isArray(history)) {
    return res.status(400).json({ error: "history must be an array if provided" });
  }

  // Phase 2.3: pre-flight safety classifier — bypass LLM entirely on hit.
  const safety = applySafetyGate({ message });
  if (safety.intercepted) {
    const signature = synthesizeSignature(context);
    return res.json({
      reply: safety.response,
      signature,
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
    // Sprint 2.2 — calendar context + negotiation depth flow into the prompt.
    calendarEvent: (context && context.calendarEvent) || "none",
    negotiationAttempt: turn.negotiationAttempt || 0,
  });

  res.json({
    ...turn,
    reply: llm.text,
    usedFallback: llm.usedFallback,
    fallbackReason: llm.fallbackReason,
    model: llm.model || (llm.usedFallback ? null : DEFAULT_MODEL),
    llmLatencyMs: llm.latencyMs,
    latencyMs: Date.now() - t0,
  });
});

// Phase 3: 30-Day Medical Report
app.post("/api/medical-report", (req, res) => {
  const { context } = req.body || {};
  const ctxErr = validateContext(context);
  if (ctxErr) return res.status(400).json({ error: ctxErr });
  res.json(buildMedicalReport(context));
});

app.use((err, req, res, next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  const llmStatus = isLLMConfigured()
    ? `LLM: ON (${DEFAULT_MODEL})`
    : "LLM: OFF (template fallback) — set OPENAI_API_KEY to enable";
  console.log(
    `[Apple Health Coach Prototype] listening on http://localhost:${PORT}\n  ${llmStatus}`
  );
});
