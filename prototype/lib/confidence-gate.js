/**
 * Confidence gate — Layer 3 from the Experimentation doc Part II.
 *
 * Scrubs the LLM's reply for the failure modes that destroy user trust:
 *  1. Asserting a biometric value not in the user's actual signature.
 *  2. Citing biometric numbers in states that explicitly forbid it.
 *  3. Using clinical / diagnostic language — wellness-not-diagnosis line.
 *  4. Exceeding hard length cap (watch UI is small).
 *
 * Returns { ok: true } if the reply passes. Otherwise { ok: false, reason }.
 * The server falls back to the template-based reply on any reason.
 */

// Sprint 2.2: Loop Closure committed state needs ~3 short sentences;
// negotiating_pivot may include a systemic recommendation. Cap raised.
const HARD_CHAR_CAP = 320;
const CLINICAL_PATTERNS = [
  /\b(diagnos(e|is|ed))\b/i,
  /\b(disorder|disease|illness|syndrome)\b/i,
  /\b(prescri(be|ption|bing))\b/i,
  /\b(medication|medicine|drug)\b/i,
  /\b(doctor (recommends|prescribes)|clinician (recommends|prescribes))\b/i,
  /\byou (have|are suffering from|appear to have) (a )?\w+ (disorder|condition|disease)\b/i,
];

const STATES_FORBIDDING_RAW_NUMBERS = new Set([
  "offered",
  "negotiating",
  "committed",
  "checking_in",
  "done",
  "backed_out",
]);

function gateLLMReply({ reply, signature, state }) {
  if (typeof reply !== "string" || !reply.trim()) {
    return { ok: false, reason: "empty_reply" };
  }
  const text = reply.trim();

  // Hard length cap
  if (text.length > HARD_CHAR_CAP) {
    return { ok: false, reason: "exceeds_length_cap", detail: `${text.length} chars` };
  }

  // Clinical / diagnostic language
  for (const re of CLINICAL_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, reason: "clinical_language", detail: re.source };
    }
  }

  // Raw biometric values forbidden in non-greeting states
  if (STATES_FORBIDDING_RAW_NUMBERS.has(state)) {
    if (/\b\d+\s*ms\b/i.test(text)) {
      return { ok: false, reason: "biometric_number_in_forbidden_state", detail: "ms" };
    }
    if (/sleep fragmentation is\s+(low|medium|high)/i.test(text)) {
      return { ok: false, reason: "biometric_number_in_forbidden_state", detail: "sleep" };
    }
    if (/arousal (is|was)\s+(elevated|normal)/i.test(text)) {
      return { ok: false, reason: "biometric_number_in_forbidden_state", detail: "arousal" };
    }
  }

  // Greeting state: numbers ARE allowed but they must match the signature.
  if (state === "greeting") {
    const msMatch = text.match(/(\d+)\s*ms/);
    if (msMatch) {
      const claimed = Number(msMatch[1]);
      if (Math.abs(claimed - signature.hrv) > 2) {
        return {
          ok: false,
          reason: "fabricated_biometric_value",
          detail: `claimed HRV ${claimed}ms vs signature ${signature.hrv}ms`,
        };
      }
    }
    const sleepClaim = text.match(/sleep fragmentation (?:is|was)\s+(low|medium|high)/i);
    if (sleepClaim && sleepClaim[1].toLowerCase() !== signature.sleep.toLowerCase()) {
      return {
        ok: false,
        reason: "fabricated_biometric_value",
        detail: `claimed sleep ${sleepClaim[1]} vs signature ${signature.sleep}`,
      };
    }
    const arousalClaim = text.match(/arousal (?:is|was)\s+(elevated|normal)/i);
    if (
      arousalClaim &&
      arousalClaim[1].toLowerCase() !== signature.arousal.toLowerCase()
    ) {
      return {
        ok: false,
        reason: "fabricated_biometric_value",
        detail: `claimed arousal ${arousalClaim[1]} vs signature ${signature.arousal}`,
      };
    }
  }

  // Sprint 2.2 Loop Closure: committed state must include the timeline
  // acknowledgement AND the overnight-HRV review promise. The state machine
  // produces these reliably; the gate enforces the LLM does too.
  if (state === "committed") {
    const hasTimeline = /\b(logged|log)\b.*\btimeline\b/i.test(text) ||
                        /\btimeline\b.*\b(logged|log)\b/i.test(text);
    const hasOvernight = /\bovernight\s+hrv\b/i.test(text) && /\btomorrow\b/i.test(text);
    if (!hasTimeline) {
      return { ok: false, reason: "committed_state_missing_timeline_log" };
    }
    if (!hasOvernight) {
      return { ok: false, reason: "committed_state_missing_overnight_review" };
    }
  }

  return { ok: true };
}

module.exports = {
  gateLLMReply,
  HARD_CHAR_CAP,
  CLINICAL_PATTERNS,
};
