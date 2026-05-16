/**
 * LLM adapter — Anthropic Claude Messages API.
 *
 * The state machine in lib/signature.js still picks state + intervention.
 * The LLM only generates the reply *text* under tight constraints.
 * Falls back to the deterministic template generator on:
 *   missing API key, network error, non-2xx, malformed body, empty content,
 *   or confidence-gate rejection.
 * Always returns { text, usedFallback, fallbackReason?, model?, latencyMs }.
 */

const { buildSystemPrompt } = require("./system-prompt");
const { gateLLMReply } = require("./confidence-gate");
const { postAnthropic, backendInUse } = require("./anthropic-http");

const COACH_MODEL = process.env.COACH_MODEL || "claude-haiku-4-5-20251001";
// Sprint 2.2: bumped from 150 → 200 to leave room for 3-step inline
// instructions + Loop Closure 3-sentence committed-state structure.
const MAX_TOKENS = Number(process.env.COACH_MAX_TOKENS) || 200;
const TEMPERATURE = 0.4;
const REQUEST_TIMEOUT_MS = 10000;

function isLLMConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function generateReply({
  state,
  signature,
  intervention,
  history,
  userMessage,
  templateReply,
  // Sprint 2.2 — calendar context + negotiation depth for prompt branching.
  calendarEvent = "none",
  negotiationAttempt = 0,
}) {
  const t0 = Date.now();

  if (!isLLMConfigured()) {
    return {
      text: templateReply,
      usedFallback: true,
      fallbackReason: "no_api_key",
      latencyMs: Date.now() - t0,
    };
  }

  const systemPrompt = buildSystemPrompt({
    state,
    signature,
    intervention,
    history,
    calendarEvent,
    negotiationAttempt,
  });

  const result = await postAnthropic({
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage || "(opening)" }],
    model: COACH_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (result.error) {
    return {
      text: templateReply,
      usedFallback: true,
      fallbackReason: result.error,
      detail: result.detail,
      latencyMs: Date.now() - t0,
    };
  }

  const gate = gateLLMReply({ reply: result.text, signature, state });
  if (!gate.ok) {
    return {
      text: templateReply,
      usedFallback: true,
      fallbackReason: `gate_${gate.reason}`,
      gateDetail: gate.detail,
      llmText: result.text,
      model: result.model,
      latencyMs: Date.now() - t0,
    };
  }

  return {
    text: result.text,
    usedFallback: false,
    model: result.model,
    latencyMs: Date.now() - t0,
  };
}

module.exports = {
  isLLMConfigured,
  backendInUse,
  generateReply,
  COACH_MODEL,
  DEFAULT_MODEL: COACH_MODEL,
};
