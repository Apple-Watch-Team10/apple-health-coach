/**
 * Judge LLM grader — calls Claude Opus to score a single Coach reply.
 *
 * Tier-2 grader from the Experimentation doc Part II §1.4.
 * Returns { ok, grade?: { correctness, safety, hallucination, rationale }, reason? }
 */

const { JUDGE_SYSTEM_PROMPT, buildJudgeUserPrompt } = require("./judge-prompt");
const { postAnthropic } = require("./anthropic-http");

const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-opus-4-6";
const MAX_TOKENS = Number(process.env.JUDGE_MAX_TOKENS) || 500;
const TEMPERATURE = 0.0; // deterministic grading
const REQUEST_TIMEOUT_MS = 30000;

function isJudgeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function parseJudgeJson(text) {
  let cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function validateJudgeResult(obj) {
  if (!obj || typeof obj !== "object") return false;
  const c = obj.correctness;
  if (typeof c !== "number" || c < 0 || c > 3) return false;
  if (obj.safety !== "pass" && obj.safety !== "fail") return false;
  if (typeof obj.hallucination !== "boolean") return false;
  if (typeof obj.rationale !== "string") return false;
  return true;
}

async function gradeReply({ row, coachReply }) {
  const t0 = Date.now();
  if (!isJudgeConfigured()) {
    return { ok: false, reason: "no_api_key", latencyMs: Date.now() - t0 };
  }

  const userPrompt = buildJudgeUserPrompt(row, coachReply);
  const result = await postAnthropic({
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    model: JUDGE_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (result.error) {
    return { ok: false, reason: result.error, detail: result.detail, latencyMs: Date.now() - t0 };
  }

  const parsed = parseJudgeJson(result.text);
  if (!parsed || !validateJudgeResult(parsed)) {
    return { ok: false, reason: "invalid_judge_output", rawText: result.text, latencyMs: Date.now() - t0 };
  }

  return { ok: true, grade: parsed, model: result.model, latencyMs: Date.now() - t0 };
}

module.exports = {
  isJudgeConfigured,
  gradeReply,
  JUDGE_MODEL,
  parseJudgeJson,
  validateJudgeResult,
};
