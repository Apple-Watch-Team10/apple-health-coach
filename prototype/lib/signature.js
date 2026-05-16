/**
 * Pure logic for the Apple Health Coach prototype.
 * No Express dependency — extracted so it can be unit-tested in any
 * environment, including offline sandboxes.
 */

const crypto = require("crypto");

const SLEEP_VALUES = ["Low", "Medium", "High"];
const AROUSAL_VALUES = ["Normal", "Elevated"];

const INTERVENTIONS = {
  box_breathing: {
    label: "Box Breathing",
    type: "Mindfulness",
    durationSec: 180,
    instructions: "Inhale 4s, hold 4s, exhale 4s, hold 4s. Follow the bubble.",
  },
  stretching: {
    label: "Quick Stretch",
    type: "Physical",
    durationSec: 120,
    instructions: "Slowly roll your shoulders. Reach for your toes, then reach high.",
  },
  journaling: {
    label: "Brief Journal",
    type: "Reflection",
    durationSec: 300,
    instructions: "Note one thing you're grateful for and one thing you're letting go of.",
  },
  cold_water: {
    label: "Sensory Reset",
    type: "Sensory",
    durationSec: 30,
    instructions: "Splash cold water on your face. This triggers a calming reflex.",
  },
};

function validateContext(context) {
  if (!context || typeof context !== "object") {
    return "context object is required";
  }
  const { hrv, sleep, arousal } = context;
  if (typeof hrv !== "number" || hrv < 0 || hrv > 100) {
    return "context.hrv must be a number 0-100";
  }
  if (!SLEEP_VALUES.includes(sleep)) {
    return `context.sleep must be one of ${SLEEP_VALUES.join(", ")}`;
  }
  if (!AROUSAL_VALUES.includes(arousal)) {
    return `context.arousal must be one of ${AROUSAL_VALUES.join(", ")}`;
  }
  return null;
}

/**
 * The core S9/S10 Neural Engine "Stress Signature" mock.
 * Collapses three biometric markers (HRV, sleep fragmentation, overnight
 * arousal proxy) into one classification: optimal | caution | elevated.
 */
function synthesizeSignature(context) {
  const { hrv, sleep, arousal } = context;
  let score = 0;
  if (hrv < 30) score += 2;
  else if (hrv < 50) score += 1;
  if (sleep === "High") score += 2;
  else if (sleep === "Medium") score += 1;
  if (arousal === "Elevated") score += 2;

  let stressLevel, burnoutRisk, recoveryTier;
  if (score >= 4) {
    stressLevel = "elevated";
    burnoutRisk = "high";          // deprecated: kept for backward compat only
    recoveryTier = "priority";     // Sprint 3.1 (A3) — user-facing tier
  } else if (score >= 2) {
    stressLevel = "caution";
    burnoutRisk = "moderate";      // deprecated
    recoveryTier = "attention";
  } else {
    stressLevel = "optimal";
    burnoutRisk = "low";           // deprecated
    recoveryTier = "optimal";
  }
  return { stressLevel, burnoutRisk, recoveryTier, score, hrv, sleep, arousal };
}

// Sprint 3.1 (A3) — single source for user-facing recovery-tier copy.
// Internal value → user-facing label. Used by both the 30-day report panel
// and the PM dashboard pill.
const RECOVERY_TIER_LABEL = {
  optimal:   "Recovery Optimal",
  attention: "Recovery Attention",
  priority:  "Recovery Priority",
};
function recoveryTierLabel(tier) {
  return RECOVERY_TIER_LABEL[tier] || "Recovery —";
}

function buildNudge(signature) {
  if (signature.stressLevel === "elevated") {
    return {
      headline: "Recovery Recommended",
      body: `Your stress signature is elevated — HRV is at ${signature.hrv}ms, sleep fragmentation is ${signature.sleep.toLowerCase()}, and overnight arousal is ${signature.arousal.toLowerCase()}. These markers are converging.`,
      tone: "concerned",
      intervention: { label: "Start 3-min Box Breathing", durationMin: 3, type: "breathing" },
    };
  }
  if (signature.stressLevel === "caution") {
    return {
      headline: "Heightened Stress Signal",
      body: `Your stress signature is trending up — HRV ${signature.hrv}ms, sleep fragmentation ${signature.sleep.toLowerCase()}, arousal ${signature.arousal.toLowerCase()}. Consider a recovery break this afternoon.`,
      tone: "supportive",
      intervention: { label: "5-min Mindful Walk", durationMin: 5, type: "movement" },
    };
  }
  return {
    headline: "Recovery on Track",
    body: `Your stress signature is in your optimal range — HRV ${signature.hrv}ms, sleep fragmentation ${signature.sleep.toLowerCase()}, arousal ${signature.arousal.toLowerCase()}.`,
    tone: "affirming",
    intervention: { label: "Maintain Routine", durationMin: 0, type: "none" },
  };
}

// Legacy single-turn reply (kept for backward compat / reference). Used only
// by the old /api/chat shape. New code path is buildConversationTurn().
function buildChatReply(message, signature) {
  const lower = (message || "").toLowerCase();
  const wantsShorter = /no time|short|quick|busy|don't have time|dont have time|too long/.test(lower);
  const wantsAlt = /something else|alternative|instead|different/.test(lower);
  const refuses = /\bno\b|skip|not now|later/.test(lower);

  if (signature.stressLevel === "elevated") {
    if (wantsShorter || wantsAlt) {
      return `I hear you — your HRV is ${signature.hrv}ms which is a strong stress signal, so let's pick something that fits the moment. Try 60 seconds of 4-7-8 breathing right where you are. That alone moves the needle.`;
    }
    if (refuses) {
      return `Understood. I'll hold off. Just know your stress signature is elevated today — even one slow exhale before your next meeting helps. I'll check back tomorrow.`;
    }
    return `Your stress signature is elevated — HRV ${signature.hrv}ms, ${signature.sleep.toLowerCase()} sleep fragmentation, ${signature.arousal.toLowerCase()} overnight arousal. A 3-minute box breathing exercise now is the highest-leverage move.`;
  }
  if (signature.stressLevel === "caution") {
    if (wantsShorter || wantsAlt) {
      return `Quick option: a 90-second physiological sigh. Two short inhales, one long exhale. That's it. Your HRV at ${signature.hrv}ms suggests it'll land.`;
    }
    return `You're trending up but not in the red. A 5-minute mindful walk before your next block of work would help reset the signal.`;
  }
  return `You're in your optimal recovery range — HRV ${signature.hrv}ms looks great. No intervention needed; keep doing what you're doing.`;
}

// =============================================================
// Conversation state machine (Path A)
// =============================================================
//
// States walk the user through the action-plan funnel:
//
//   greeting   → user just opened chat from the nudge
//   offered    → Siri has proposed an intervention
//   negotiating→ user pushed back; Siri is offering alternatives
//   committed  → user agreed to a specific intervention
//   checking_in→ user reported back on how it went
//   done       → conversation is closed
//   backed_out → user declined firmly; Siri stepped back
//
// Server is fully stateless: derives current state from history (last Siri
// turn's `intentState`), classifies user intent from the new message, and
// returns the next reply + new state.

const INTENT_STATES = [
  "greeting",
  "offered",
  "negotiating",
  "committed",
  "checking_in",
  "done",
  "backed_out",
];

function deriveCurrentState(history) {
  if (!Array.isArray(history) || history.length === 0) return "greeting";
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn && turn.role === "siri" && turn.intentState) {
      return turn.intentState;
    }
  }
  return "greeting";
}

function countNegotiationAttempts(history) {
  if (!Array.isArray(history)) return 0;
  return history.filter(
    (t) => t && t.role === "siri" && t.intentState === "negotiating"
  ).length;
}

function detectIntent(message) {
  const lower = (message || "").toLowerCase().trim();
  if (!lower) return "EMPTY";

  // Order matters: more specific patterns first.
  // AFFIRM goes BEFORE COMPLETED_* so "sounds good" / "ok" / "sure" don't
  // get misread as a completion report.
  if (/\b(yes|yeah|yep|sure|ok|okay|alright|let'?s (do|go) (it|this)|sounds (good|right)|i'?ll do it|got it|deal|fine)\b/.test(lower))
    return "AFFIRM";
  if (/\b(better|great|helped|calmer|calm|works?|useful|nice|relaxed|finished|finished it|did it|completed)\b/.test(lower))
    return "COMPLETED_GOOD";
  if (/\b(worse|same|nothing|didn'?t (help|work)|useless|pointless|not (working|helping))\b/.test(lower))
    return "COMPLETED_BAD";
  if (/\b(no time|short(er)?|too long|busy|quick(er)?|don'?t have time|less time|brief|too much)\b/.test(lower))
    return "DECLINE_SHORT";
  if (/\b(something else|alternative|instead|different|other option|not (that|breathing|walking))\b/.test(lower))
    return "DECLINE_ALT";
  if (/\b(no|skip|not now|later|pass|cancel|forget it|nope|nah)\b/.test(lower))
    return "DECLINE_REFUSE";
  if (/^\s*(why|what|how|when|am i|do i|is (this|that|my)|tell me|explain)/.test(lower))
    return "INFO_QUESTION";

  return "OPEN";
}

// What intervention belongs to which signature class?
function defaultIntervention(stressLevel) {
  if (stressLevel === "elevated") return INTERVENTIONS.box_breathing;
  if (stressLevel === "caution") return INTERVENTIONS.stretching;
  return INTERVENTIONS.journaling;
}

function alternativeIntervention(stressLevel, attempt) {
  // If the user pushes back, we now pivot to Sensory (Cold Water) 
  // or Reflection (Journaling) to provide true variety
  if (stressLevel === "elevated") {
    if (attempt <= 1) return INTERVENTIONS.cold_water; // Now cold water is visible!
    return INTERVENTIONS.journaling;
  }
  if (stressLevel === "caution") {
    if (attempt <= 1) return INTERVENTIONS.cold_water;
    return INTERVENTIONS.journaling;
  }
  return INTERVENTIONS.journaling;
}

function greetingTextFor(signature) {
  const sig = signature.stressLevel;
  if (sig === "elevated") {
    return `I see — your stress signature is elevated. HRV ${signature.hrv}ms, sleep fragmentation ${signature.sleep.toLowerCase()}, arousal ${signature.arousal.toLowerCase()}. What feels doable in the next few minutes?`;
  }
  if (sig === "caution") {
    return `Your signal is trending up — HRV ${signature.hrv}ms, sleep ${signature.sleep.toLowerCase()}, arousal ${signature.arousal.toLowerCase()}. Want to head it off with a quick reset?`;
  }
  return `You're in a good range right now — HRV ${signature.hrv}ms, sleep ${signature.sleep.toLowerCase()}. Want to lock that in with a maintenance habit?`;
}

function offerText(intervention, stressLevel, isFirstOffer) {
  // After the greeting, deliberately do NOT re-cite HRV/sleep/arousal numbers.
  if (stressLevel === "elevated") {
    return isFirstOffer
      ? `Try ${Math.round(intervention.durationSec / 60)} minutes of ${intervention.label.toLowerCase()} — ${intervention.instructions} I'll pace it on the watch. Sound good?`
      : `${intervention.label}: ${intervention.instructions} ${intervention.durationSec < 60 ? `${intervention.durationSec} seconds` : `${Math.round(intervention.durationSec / 60)} minutes`}. Doable?`;
  }
  if (stressLevel === "caution") {
    return isFirstOffer
      ? `How about a ${Math.round(intervention.durationSec / 60)}-minute ${intervention.label.toLowerCase()} before your next block? ${intervention.instructions} Sound right?`
      : `Smaller option — ${intervention.label.toLowerCase()}: ${intervention.instructions} Doable?`;
  }
  return `A quick ${intervention.label.toLowerCase()} keeps you in this groove. ${intervention.instructions} Want to start?`;
}

function commitText(intervention, stressLevel) {
  if (intervention.type === "breathing") {
    return `Starting ${intervention.label.toLowerCase()} now. Follow the haptic on the watch — I'll check in when it ends.`;
  }
  if (intervention.type === "movement") {
    return `${intervention.label} timer set. I'll ping you when you're back.`;
  }
  return `Logged. Tap "I did it" when you've finished — one line is plenty.`;
}

function checkInPrompt() {
  return `How did it feel?`;
}

function checkInCloseText(intent, signature) {
  if (intent === "COMPLETED_GOOD") {
    if (signature.stressLevel === "elevated") {
      return `Good — your HRV often takes a few hours to lift, but the parasympathetic effect is immediate. I'll keep watching. Same time tomorrow if the signal stays high?`;
    }
    return `Nice. I'll keep that as your default for next time.`;
  }
  if (intent === "COMPLETED_BAD") {
    return `Thanks for telling me — that's data. Some people respond better to somatic options than breathing. Want me to try a movement-based default for next time?`;
  }
  return `Got it. I'll check the signal again later.`;
}

function backOutText() {
  return `Got it. No pressure. I'll check back later — and remember, even a single slow exhale counts.`;
}

function infoAnswerText(message, signature, currentState) {
  // Lightweight Q&A inside an active conversation — does NOT advance state.
  const lower = (message || "").toLowerCase();
  if (/why|reason|what.*mean/.test(lower)) {
    return signature.stressLevel === "elevated"
      ? `Three markers are converging: HRV is suppressed, sleep is fragmented, and overnight arousal is elevated. Together they read as sustained stress, not a one-off bad night.`
      : `Your sliders haven't crossed the threshold for a strong stress signal — but the trend is one to watch. We're being preventative, not reactive.`;
  }
  if (/how/.test(lower)) {
    return `On-device on the S9/S10 Neural Engine. Your raw biometric data never leaves the watch.`;
  }
  return `Short answer: I'm reading your signature on-device and offering one specific next move. Want to try the option I suggested?`;
}

/**
 * Main entry: given the user's new message + history + biometric context,
 * return the next conversation turn.
 */
function buildConversationTurn({ message, history, signature }) {
  const currentState = deriveCurrentState(history);
  const intent = detectIntent(message);
  const negotiationsSoFar = countNegotiationAttempts(history);

  // ---- GREETING → first user reply moves us to OFFERED ----
  if (currentState === "greeting") {
    const intervention = defaultIntervention(signature.stressLevel);
    if (intent === "DECLINE_REFUSE") {
      return {
        reply: backOutText(),
        intent,
        intentState: "backed_out",
        intervention: null,
        negotiationAttempt: 0,
      };
    }
    if (intent === "INFO_QUESTION") {
      return {
        reply: infoAnswerText(message, signature, currentState) +
          " " + offerText(intervention, signature.stressLevel, true),
        intent,
        intentState: "offered",
        intervention,
        negotiationAttempt: 0,
      };
    }
    return {
      reply: offerText(intervention, signature.stressLevel, true),
      intent,
      intentState: "offered",
      intervention,
      negotiationAttempt: 0,
    };
  }

  // ---- OFFERED → negotiate, commit, refuse, or info ----
  if (currentState === "offered") {
    if (intent === "AFFIRM") {
      const intervention = defaultIntervention(signature.stressLevel);
      return {
        reply: commitText(intervention, signature.stressLevel),
        intent,
        intentState: "committed",
        intervention,
        negotiationAttempt: negotiationsSoFar,
      };
    }
    if (intent === "DECLINE_REFUSE") {
      return {
        reply: backOutText(),
        intent,
        intentState: "backed_out",
        intervention: null,
        negotiationAttempt: negotiationsSoFar,
      };
    }
    if (intent === "DECLINE_SHORT" || intent === "DECLINE_ALT") {
      const alt = alternativeIntervention(signature.stressLevel, 1);
      return {
        reply: `Okay, simpler — ${offerText(alt, signature.stressLevel, false)}`,
        intent,
        intentState: "negotiating",
        intervention: alt,
        negotiationAttempt: 1,
      };
    }
    if (intent === "INFO_QUESTION") {
      return {
        reply: infoAnswerText(message, signature, currentState),
        intent,
        intentState: "offered", // stay
        intervention: defaultIntervention(signature.stressLevel),
        negotiationAttempt: negotiationsSoFar,
      };
    }
    // OPEN/ambiguous → re-offer same intervention with a softer ask
    const intervention = defaultIntervention(signature.stressLevel);
    return {
      reply: `Want to try the ${intervention.label.toLowerCase()}? Even a shorter version counts.`,
      intent,
      intentState: "offered",
      intervention,
      negotiationAttempt: negotiationsSoFar,
    };
  }

  // ---- NEGOTIATING → keep shrinking the ask, or commit, or back out ----
  if (currentState === "negotiating") {
    if (intent === "AFFIRM") {
      // commit to the most recent alternative offered
      const intervention = alternativeIntervention(signature.stressLevel, negotiationsSoFar);
      return {
        reply: commitText(intervention, signature.stressLevel),
        intent,
        intentState: "committed",
        intervention,
        negotiationAttempt: negotiationsSoFar,
      };
    }
    if (intent === "DECLINE_REFUSE" || negotiationsSoFar >= 2) {
      return {
        reply: backOutText(),
        intent,
        intentState: "backed_out",
        intervention: null,
        negotiationAttempt: negotiationsSoFar,
      };
    }
    if (intent === "INFO_QUESTION") {
      return {
        reply: infoAnswerText(message, signature, currentState),
        intent,
        intentState: "negotiating",
        intervention: alternativeIntervention(signature.stressLevel, negotiationsSoFar),
        negotiationAttempt: negotiationsSoFar,
      };
    }
    // shrink further
    const next = alternativeIntervention(signature.stressLevel, negotiationsSoFar + 1);
    return {
      reply: `Even smaller — ${next.instructions} Can you?`,
      intent,
      intentState: "negotiating",
      intervention: next,
      negotiationAttempt: negotiationsSoFar + 1,
    };
  }

  // ---- COMMITTED → next user message is the check-in trigger ----
  if (currentState === "committed") {
    return {
      reply: checkInPrompt(),
      intent,
      intentState: "checking_in",
      intervention: null,
      negotiationAttempt: negotiationsSoFar,
    };
  }

  // ---- CHECKING_IN → close out ----
  if (currentState === "checking_in") {
    // State-aware override: in this state, completion phrasing should win
    // over a generic "yes/ok" because the user is reporting on the action.
    const lower = (message || "").toLowerCase();
    let resolvedIntent = intent;
    if (intent === "AFFIRM" && /\b(better|helped|calm(er)?|works?|useful|nice|relaxed)\b/.test(lower)) {
      resolvedIntent = "COMPLETED_GOOD";
    } else if (intent === "AFFIRM" && /\b(worse|same|nothing|didn'?t (help|work))\b/.test(lower)) {
      resolvedIntent = "COMPLETED_BAD";
    }
    return {
      reply: checkInCloseText(resolvedIntent, signature),
      intent: resolvedIntent,
      intentState: "done",
      intervention: null,
      negotiationAttempt: negotiationsSoFar,
    };
  }

  // ---- BACKED_OUT / DONE → polite no-op ----
  return {
    reply:
      currentState === "done"
        ? `We're good for now. I'll check the signal again later.`
        : `I'll hold off. Open the watch when you'd like to try something small.`,
    intent,
    intentState: currentState,
    intervention: null,
    negotiationAttempt: negotiationsSoFar,
  };
}

/**
 * Public entry used by the server's POST /api/chat.
 * Returns the bundle the client renders + persists in history.
 */
function processChatRequest({ message, context, history }) {
  const signature = synthesizeSignature(context);
  const turn = buildConversationTurn({ message, history, signature });
  return {
    reply: turn.reply,
    signature,
    intent: turn.intent,
    intentState: turn.intentState,
    intervention: turn.intervention,
    negotiationAttempt: turn.negotiationAttempt,
  };
}

/**
 * Public entry for the initial nudge → chat opener. Used to seed history with
 * Siri's first turn when the user taps "Talk to Siri."
 */
function buildGreeting(context) {
  const signature = synthesizeSignature(context);
  return {
    reply: greetingTextFor(signature),
    signature,
    intent: null,
    intentState: "greeting",
    intervention: null,
    negotiationAttempt: 0,
  };
}

function buildMedicalReport(context) {
  const signature = synthesizeSignature(context);
  const seed = `${context.hrv}|${context.sleep}|${context.arousal}`;
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const offset = parseInt(hash.slice(0, 4), 16) % 10;

  const hrvAvg = Math.max(10, Math.min(95, context.hrv + offset - 5));
  const arousalDays =
    context.arousal === "Elevated" ? 18 + (offset % 6) : 4 + (offset % 4);
  const fragmentationLabel = context.sleep;

  return {
    reportId: hash.slice(0, 12),
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    patientFacing: false,
    clinicianFormatted: true,
    summary: {
      stressLevel: signature.stressLevel,
      // Sprint 3.1 (A3): retired binary burnoutRisk from user-visible report
      // copy in favor of a three-tier recovery framing that doesn't carry
      // the clinical anxiety load of "Burnout Risk: High."
      recoveryTier: signature.recoveryTier,                       // "optimal" | "attention" | "priority"
      recoveryTierLabel: recoveryTierLabel(signature.recoveryTier), // user-facing
      burnoutRisk: signature.burnoutRisk,                         // deprecated; kept for back-compat
      hrvAvgMs: hrvAvg,
      sleepFragmentation: fragmentationLabel,
      elevatedArousalDays: arousalDays,
    },
    longitudinal: {
      hrvTrend: signature.stressLevel === "elevated" ? "declining" : "stable",
      sleepTrend:
        fragmentationLabel === "High"
          ? "fragmented (>=3 awakenings/night avg)"
          : "consolidated",
      arousalTrend:
        context.arousal === "Elevated"
          ? "elevated overnight temp >50% of nights"
          : "within personal baseline",
    },
    narrative:
      signature.stressLevel === "elevated"
        ? `Patient shows convergent stress markers across the 30-day window: HRV averaging ${hrvAvg}ms (below 50ms baseline), ${fragmentationLabel.toLowerCase()} sleep fragmentation, and elevated arousal on ${arousalDays}/30 nights. This pattern is consistent with sustained sympathetic activation. Recommend wellness-grade intervention (paced breathing, sleep hygiene review) and re-assessment at 30 days.`
        : signature.stressLevel === "caution"
        ? `Patient shows mixed signals: HRV ${hrvAvg}ms, ${fragmentationLabel.toLowerCase()} fragmentation, ${arousalDays}/30 elevated-arousal nights. No acute concern, but trend warrants monitoring.`
        : `Patient is in their personal optimal range across all measured markers (HRV ${hrvAvg}ms, ${fragmentationLabel.toLowerCase()} fragmentation, ${arousalDays}/30 elevated-arousal nights). No intervention indicated.`,
    disclaimer:
      "This report is generated by Apple Health Coach as a wellness-guidance summary. It is not a clinical diagnosis. Apple Watch is not intended to diagnose, treat, or prevent any disease.",
  };
}

module.exports = {
  SLEEP_VALUES,
  AROUSAL_VALUES,
  INTENT_STATES,
  validateContext,
  synthesizeSignature,
  buildNudge,
  buildChatReply,            // legacy single-turn (kept)
  buildMedicalReport,
  recoveryTierLabel,         // Sprint 3.1 (A3) — user-facing tier copy
  // Conversation state machine
  detectIntent,
  deriveCurrentState,
  countNegotiationAttempts,
  defaultIntervention,
  alternativeIntervention,
  buildConversationTurn,
  buildGreeting,
  processChatRequest,
};
