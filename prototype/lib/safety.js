/**
 * Pre-flight safety classifier — Phase 2.3 (the "Hard-Coded Safety Redline").
 *
 * Rationale: the full 300-row eval surfaced 10 safety failures concentrated
 * in `self_harm` (3/6) and `clinical_diagnosis` (6/15). Routing those through
 * the same state machine that handles legitimate wellness requests is wrong:
 * a wellness coach cannot trust LLM inference on life-safety boundaries.
 *
 * This module runs a deterministic regex/keyword classifier BEFORE the state
 * machine. If a redline pattern hits, the LLM is bypassed entirely and a
 * hardcoded refusal/redirect template fires.
 *
 * Three classes (per PM directive 2026-05-03):
 *   1. self_harm           → 988 Suicide & Crisis Lifeline redirect
 *   2. clinical_diagnosis  → "I'm a wellness coach, not a clinician — see your doctor"
 *   3. medication_request  → "I can't recommend meds — that's between you and a clinician"
 *
 * Other adversarial classes (jailbreak, fictional_biometric, hostile) continue
 * to flow through the normal pipeline; the existing system prompt + confidence
 * gate handle them.
 *
 * Order matters: self_harm checks FIRST so phrases like "I can't take this
 * anymore" can't be downgraded by a coincidental clinical-keyword match.
 */

// ---- Templates (hardcoded, watch-readable) ----

const TEMPLATE_SELF_HARM =
  "I hear you, and I want to slow down. I'm a wellness coach, not a crisis counselor — for what you're carrying, please reach out to the 988 Suicide & Crisis Lifeline right now (call or text 988). It's free, confidential, and available 24/7.";

const TEMPLATE_CLINICAL_DIAGNOSIS =
  "I'm a wellness coach, not a clinician — I can't diagnose conditions or interpret symptoms medically. Please bring this to your doctor; they can review it with the clinical context I don't have.";

const TEMPLATE_MEDICATION_REQUEST =
  "I can't recommend medications, dosages, or substances — that's strictly between you and a clinician. I can stick to behavioural options like paced breathing or a short walk if that would help.";

// ---- Patterns ----
//
// Each pattern set is checked in order against a normalized lowercase message.
// First match wins; we never report multiple classes for the same input.

const SELF_HARM_PATTERNS = [
  /\b(hurt|harm)\s+(myself|me)\b/i,
  /\b(kill|end)\s+(myself|my\s+life|it\s+all)\b/i,
  /\bsuicid(e|al|ality)\b/i,
  /\bwhat'?s?\s+the\s+point\b/i,
  /\b(don'?t|dont)\s+want\s+to\s+(live|be\s+here|go\s+on|do\s+this|exist)\b/i,
  /\b(can'?t|cant)\s+(take\s+(this|it|anymore)|live|go\s+on|do\s+this\s+anymore)\b/i,
  /\bnothing\s+matters\b/i,
  /\bgive\s+up\s+on\s+(life|everything)\b/i,
  /\b(self[\s-]?harm|hurting\s+myself|cutting\s+myself)\b/i,
  /\b(better\s+off\s+(without\s+me|dead)|burden\s+to\s+everyone)\b/i,
];

const CLINICAL_DIAGNOSIS_PATTERNS = [
  // "Am I X?" — direct diagnostic question
  /\bam\s+i\s+(depress(ed|ive)?|anxious|bipolar|adhd|burnt\s+out|burning\s+out|having\s+a\s+(heart\s+attack|stroke|panic\s+attack))\b/i,
  // "Do I have X?" — diagnostic question
  /\b(do|did)\s+i\s+have\s+(a|an|some|any)?\s*(depression|anxiety|disorder|disease|condition|adhd|ptsd|burnout|insomnia|bipolar|panic\s+attacks?)\b/i,
  // "Have I got X?"
  /\bhave\s+i\s+got\s+(a|an|some|any)?\s*(disorder|disease|condition|depression|anxiety)\b/i,
  // "Is this X?" — diagnostic interpretation
  /\bis\s+this\s+(ptsd|depression|anxiety|burnout|adhd|insomnia|a\s+(panic\s+attack|heart\s+attack|stroke|disorder|condition))\b/i,
  // Direct demands to diagnose
  /\b(diagnose|diagnosis)\s+(me|that\s+for\s+me|my\s+(symptoms|condition))\b/i,
  /\btell\s+me\s+(what|if)\s+i\s+have\b/i,
  // "Heart disease based on my HRV?" / "do I have heart disease..."
  /\b(heart\s+disease|cancer|tumor|diabetes)\s+based\s+on\b/i,
  /\bdo\s+i\s+have\s+heart\s+disease\b/i,
];

const MEDICATION_PATTERNS = [
  // "Should I take/stop X?" with named meds
  /\bshould\s+i\s+(take|stop|use|try)\s+(?:.{0,40}?\b)?(xanax|prozac|zoloft|lexapro|adderall|ritalin|valium|ativan|klonopin|ssri|snri|benzo|antidepressant|sleep\s+aid|melatonin|cbd|kratom)\b/i,
  // "Recommend X" / "Recommend an SSRI"
  /\brecommend(?:\s+(?:me|a|an))?\s+(?:.{0,30}?\b)?(xanax|prozac|zoloft|lexapro|adderall|ritalin|valium|ativan|klonopin|ssri|snri|benzo|antidepressant|sleep\s+aid|medication|drug)\b/i,
  // "What drugs..." / "What medication..."
  /\bwhat\s+(drugs?|medications?|pills?|prescriptions?|antidepressants?)\b/i,
  // Prescription-related
  /\b(prescri(be|ption|bing|ber))\b/i,
  // Substance dose questions
  /\b(melatonin|cbd|kratom|nicotine|caffeine\s+pills?|alcohol|adderall)\s+(safe|dose|dosage|how\s+much|recommend(ed)?|take|use)\b/i,
  /\bhow\s+much\s+(cbd|melatonin|caffeine|kratom|nicotine|alcohol|xanax|adderall)\b/i,
  // "Drugs help with stress" general
  /\b(drugs?|meds?|pills?)\s+(help|that\s+help|to\s+help)\s+with\b/i,
];

// ---- Classification ----

function classify(message) {
  if (typeof message !== "string" || !message.trim()) return null;
  const text = message.toLowerCase().trim();

  // Self-harm has highest priority — life safety beats everything else.
  for (const re of SELF_HARM_PATTERNS) {
    if (re.test(text)) return { class: "self_harm", pattern: re.source };
  }
  for (const re of CLINICAL_DIAGNOSIS_PATTERNS) {
    if (re.test(text)) return { class: "clinical_diagnosis", pattern: re.source };
  }
  for (const re of MEDICATION_PATTERNS) {
    if (re.test(text)) return { class: "medication_request", pattern: re.source };
  }
  return null;
}

function templateFor(safetyClass) {
  if (safetyClass === "self_harm") return TEMPLATE_SELF_HARM;
  if (safetyClass === "clinical_diagnosis") return TEMPLATE_CLINICAL_DIAGNOSIS;
  if (safetyClass === "medication_request") return TEMPLATE_MEDICATION_REQUEST;
  return null;
}

/**
 * Public entry: applySafetyGate({ message })
 *   → { intercepted: true, safetyClass, response, matchedPattern }
 *   → { intercepted: false }
 *
 * Callers should run this BEFORE the state machine + LLM. If intercepted, return
 * the templated response immediately without touching processChatRequest or the
 * LLM. The whole point is to remove LLM inference from the life-safety path.
 */
function applySafetyGate({ message }) {
  const hit = classify(message);
  if (!hit) return { intercepted: false };
  return {
    intercepted: true,
    safetyClass: hit.class,
    matchedPattern: hit.pattern,
    response: templateFor(hit.class),
  };
}

module.exports = {
  applySafetyGate,
  classify,
  templateFor,
  TEMPLATE_SELF_HARM,
  TEMPLATE_CLINICAL_DIAGNOSIS,
  TEMPLATE_MEDICATION_REQUEST,
  // exposed for tests
  SELF_HARM_PATTERNS,
  CLINICAL_DIAGNOSIS_PATTERNS,
  MEDICATION_PATTERNS,
};
