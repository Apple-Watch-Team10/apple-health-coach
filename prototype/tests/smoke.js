/**
 * Phase 1 smoke test — exercises the pure synthesis logic without requiring
 * Express to be installed. This verifies the contract that `server.js` will
 * serve once `npm install` has been run.
 */

const {
  validateContext,
  synthesizeSignature,
  buildNudge,
  buildChatReply,
  buildMedicalReport,
  detectIntent,
  buildGreeting,
  processChatRequest,
} = require("../lib/signature");
const { gateLLMReply } = require("../lib/confidence-gate");
const { buildSystemPrompt, buildBiometricBlock } = require("../lib/system-prompt");
const { generateReply, isLLMConfigured } = require("../lib/llm");
const {
  applySafetyGate,
  classify,
  TEMPLATE_SELF_HARM,
  TEMPLATE_CLINICAL_DIAGNOSIS,
  TEMPLATE_MEDICATION_REQUEST,
} = require("../lib/safety");

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}` + (detail ? ` — ${detail}` : ""));
    fail++;
  }
}

function header(s) {
  console.log(`\n— ${s} —`);
}

// -------- Validation --------
header("Validation");
check("rejects missing context", validateContext(undefined) !== null);
check("rejects HRV out of range", validateContext({ hrv: 200, sleep: "Low", arousal: "Normal" }) !== null);
check("rejects bad sleep enum", validateContext({ hrv: 50, sleep: "Bogus", arousal: "Normal" }) !== null);
check("rejects bad arousal enum", validateContext({ hrv: 50, sleep: "Low", arousal: "Bogus" }) !== null);
check("accepts valid context", validateContext({ hrv: 50, sleep: "Low", arousal: "Normal" }) === null);

// -------- Stress Signature classification --------
header("Stress Signature classification");
const burnout = synthesizeSignature({ hrv: 22, sleep: "High", arousal: "Elevated" });
const optimal = synthesizeSignature({ hrv: 78, sleep: "Low", arousal: "Normal" });
const highArousal = synthesizeSignature({ hrv: 50, sleep: "High", arousal: "Elevated" });

check("3-Day Burnout → elevated", burnout.stressLevel === "elevated", JSON.stringify(burnout));
check("Optimal Recovery → optimal", optimal.stressLevel === "optimal", JSON.stringify(optimal));
check("High Arousal / Low Sleep → elevated", highArousal.stressLevel === "elevated", JSON.stringify(highArousal));
check("burnout score >= optimal score", burnout.score >= optimal.score);
// Sprint 3.1 (A3) — recoveryTier replaces user-visible burnoutRisk
check("elevated ctx → recoveryTier 'priority'", burnout.recoveryTier === "priority", JSON.stringify(burnout));
check("optimal ctx → recoveryTier 'optimal'", optimal.recoveryTier === "optimal", JSON.stringify(optimal));
const caution = synthesizeSignature({ hrv: 45, sleep: "Medium", arousal: "Normal" });
check("caution ctx → recoveryTier 'attention'", caution.recoveryTier === "attention", JSON.stringify(caution));
check("burnoutRisk still present (deprecated back-compat)", typeof burnout.burnoutRisk === "string");

// -------- Nudge content --------
header("Nudge synthesis");
const nudgeBurnout = buildNudge(burnout);
const nudgeOptimal = buildNudge(optimal);
check("burnout nudge headline references recovery", /recovery/i.test(nudgeBurnout.headline));
check("burnout nudge body mentions HRV, sleep, arousal", /hrv/i.test(nudgeBurnout.body) && /sleep/i.test(nudgeBurnout.body) && /arousal/i.test(nudgeBurnout.body));
check("burnout nudge tone = concerned", nudgeBurnout.tone === "concerned");
check("optimal nudge tone = affirming", nudgeOptimal.tone === "affirming");
check("intervention label present (burnout)", typeof nudgeBurnout.intervention.label === "string");

// -------- Siri Negotiation --------
header("Siri Negotiation replies");
const replyBurnout1 = buildChatReply("I don't have time for a 20 minute meditation.", burnout);
const replyBurnout2 = buildChatReply("Can you suggest something else?", burnout);
const replyBurnout3 = buildChatReply("No, skip it for now.", burnout);
const replyOptimal = buildChatReply("How am I doing?", optimal);

check("short-on-time → offers shorter option", /60 seconds|4-7-8/.test(replyBurnout1));
check("alternative request → returns alternative", /60 seconds|4-7-8/.test(replyBurnout2));
check("refusal → backs off respectfully", /hold off|tomorrow/i.test(replyBurnout3));
check("optimal context → affirming reply", /optimal|great|keep doing/i.test(replyOptimal));

// -------- Medical Report --------
header("Medical Report (Phase 3)");
const r1 = buildMedicalReport({ hrv: 22, sleep: "High", arousal: "Elevated" });
const r2 = buildMedicalReport({ hrv: 22, sleep: "High", arousal: "Elevated" });
check("reportId is deterministic for same context", r1.reportId === r2.reportId);
check("windowDays is 30", r1.windowDays === 30);
check("summary.stressLevel matches signature", r1.summary.stressLevel === "elevated");
check("disclaimer is present", typeof r1.disclaimer === "string" && r1.disclaimer.length > 0);
check("narrative mentions HRV", /hrv/i.test(r1.narrative));
check("longitudinal hrvTrend is set", typeof r1.longitudinal.hrvTrend === "string");
// Sprint 3.1 (A3) — medical report carries recoveryTier copy; never the word "burnout" in user-visible narrative
check("report.summary has recoveryTier", r1.summary.recoveryTier === "priority");
check("report.summary has recoveryTierLabel", r1.summary.recoveryTierLabel === "Recovery Priority");
check("report narrative does not contain the word 'burnout'", !/burnout/i.test(r1.narrative));

// -------- Conversation: intent detection --------
header("Intent detection");
check("AFFIRM: 'yes'", detectIntent("yes") === "AFFIRM");
check("AFFIRM: 'sounds good'", detectIntent("sounds good") === "AFFIRM");
check("AFFIRM: \"let's do it\"", detectIntent("let's do it") === "AFFIRM");
check("DECLINE_SHORT: 'no time'", detectIntent("I don't have time") === "DECLINE_SHORT");
check("DECLINE_ALT: 'something else'", detectIntent("can you suggest something else") === "DECLINE_ALT");
check("DECLINE_REFUSE: 'skip'", detectIntent("skip it") === "DECLINE_REFUSE");
check("COMPLETED_GOOD: 'it helped'", detectIntent("it helped") === "COMPLETED_GOOD");
check("AFFIRM beats COMPLETED_GOOD when ambiguous ('sounds good')", detectIntent("sounds good") === "AFFIRM");
check("COMPLETED_BAD: 'didnt help'", detectIntent("it didnt help") === "COMPLETED_BAD");
check("INFO_QUESTION: 'why'", detectIntent("why is that") === "INFO_QUESTION");

// -------- Conversation: full funnel — burnout, accept on first offer --------
header("Conversation funnel — accept first offer (burnout context)");
{
  const ctx = { hrv: 22, sleep: "High", arousal: "Elevated" };
  const greet = buildGreeting(ctx);
  check("greeting state = greeting", greet.intentState === "greeting");
  check("greeting mentions HRV/sleep/arousal", /hrv/i.test(greet.reply) && /sleep/i.test(greet.reply) && /arousal/i.test(greet.reply));

  let history = [{ role: "siri", text: greet.reply, intentState: greet.intentState }];

  // user opens with a what-should-I-do intent
  const t1 = processChatRequest({ message: "what should I try", context: ctx, history });
  check("after greeting → offered", t1.intentState === "offered");
  check("offered reply does NOT recite raw HRV/sleep/arousal stats",
    !/\b\d+ms\b/.test(t1.reply) && !/sleep fragmentation is (low|medium|high)/i.test(t1.reply));
  check("offered turn has an intervention", t1.intervention && typeof t1.intervention.label === "string");
  history = [...history, { role: "user", text: "what should I try" }, { role: "siri", text: t1.reply, intentState: t1.intentState }];

  const t2 = processChatRequest({ message: "yes, let's do it", context: ctx, history });
  check("AFFIRM → committed", t2.intentState === "committed");
  check("committed reply does NOT recite raw stats", !/\b\d+ms\b/.test(t2.reply));
  check("committed reply mentions starting/timer", /starting|timer|haptic|tap/i.test(t2.reply));
  history = [...history, { role: "user", text: "yes, let's do it" }, { role: "siri", text: t2.reply, intentState: t2.intentState }];

  const t3 = processChatRequest({ message: "I did it", context: ctx, history });
  check("after committed → checking_in", t3.intentState === "checking_in");
  check("checking_in reply asks how it felt", /how/i.test(t3.reply) && /feel/i.test(t3.reply));
  history = [...history, { role: "user", text: "I did it" }, { role: "siri", text: t3.reply, intentState: t3.intentState }];

  const t4 = processChatRequest({ message: "it helped", context: ctx, history });
  check("checking_in + COMPLETED_GOOD → done", t4.intentState === "done");
}

// -------- Conversation: negotiate twice then accept --------
header("Conversation funnel — negotiate twice, then accept");
{
  const ctx = { hrv: 22, sleep: "High", arousal: "Elevated" };
  let history = [{ role: "siri", text: buildGreeting(ctx).reply, intentState: "greeting" }];

  const t1 = processChatRequest({ message: "what should I do", context: ctx, history });
  history = [...history, { role: "user", text: "what should I do" }, { role: "siri", text: t1.reply, intentState: t1.intentState }];

  const t2 = processChatRequest({ message: "I don't have time", context: ctx, history });
  check("DECLINE_SHORT from offered → negotiating", t2.intentState === "negotiating");
  check("negotiating offers a shorter intervention", t2.intervention && t2.intervention.durationSec <= 60);
  history = [...history, { role: "user", text: "I don't have time" }, { role: "siri", text: t2.reply, intentState: t2.intentState }];

  const t3 = processChatRequest({ message: "still too much", context: ctx, history });
  check("further pushback → still negotiating with smaller intervention",
    t3.intentState === "negotiating" && t3.intervention && t3.intervention.durationSec <= 60);
  history = [...history, { role: "user", text: "still too much" }, { role: "siri", text: t3.reply, intentState: t3.intentState }];

  const t4 = processChatRequest({ message: "ok", context: ctx, history });
  check("AFFIRM from negotiating → committed", t4.intentState === "committed");
  check("committed intervention is the shrunk one", t4.intervention && t4.intervention.durationSec <= 60);
}

// -------- Conversation: refusal short-circuits to backed_out --------
header("Conversation funnel — firm refusal");
{
  const ctx = { hrv: 22, sleep: "High", arousal: "Elevated" };
  let history = [{ role: "siri", text: buildGreeting(ctx).reply, intentState: "greeting" }];
  const t1 = processChatRequest({ message: "no, not now", context: ctx, history });
  check("greeting + DECLINE_REFUSE → backed_out", t1.intentState === "backed_out");
  check("backed_out reply is gentle (no pressure)", /no pressure|hold off|check back/i.test(t1.reply));
}

// -------- Phase 2.1: Confidence Gate --------
header("Confidence Gate");
const sigBurnout = synthesizeSignature({ hrv: 22, sleep: "High", arousal: "Elevated" });

check("rejects empty reply",
  !gateLLMReply({ reply: "", signature: sigBurnout, state: "offered" }).ok);

check("rejects oversized reply",
  !gateLLMReply({ reply: "A".repeat(400), signature: sigBurnout, state: "offered" }).ok);

check("rejects diagnostic language",
  !gateLLMReply({ reply: "You appear to have an anxiety disorder.", signature: sigBurnout, state: "offered" }).ok);

check("rejects 'doctor recommends' language",
  !gateLLMReply({ reply: "Your doctor recommends medication.", signature: sigBurnout, state: "offered" }).ok);

check("rejects HRV ms in offered state (forbidden)",
  !gateLLMReply({ reply: "Your HRV is 22 ms, try this.", signature: sigBurnout, state: "offered" }).ok);

check("accepts state-compliant reply in offered",
  gateLLMReply({ reply: "Want to try 3 minutes of box breathing? It pairs well with your stress signature.", signature: sigBurnout, state: "offered" }).ok);

check("rejects greeting that fabricates HRV value",
  !gateLLMReply({ reply: "Your HRV is 99 ms, sleep was high, arousal elevated.", signature: sigBurnout, state: "greeting" }).ok);

check("accepts greeting that cites correct HRV",
  gateLLMReply({ reply: "I see HRV at 22 ms, sleep fragmentation high, arousal elevated. What feels doable?", signature: sigBurnout, state: "greeting" }).ok);

check("rejects committed reply missing start signal",
  !gateLLMReply({ reply: "Sure, breathe deeply.", signature: sigBurnout, state: "committed" }).ok);

check("accepts committed reply with starting/timer/haptic",
  gateLLMReply({ reply: "Starting now — follow the haptic on your watch.", signature: sigBurnout, state: "committed" }).ok);

// -------- Phase 2.1: System prompt construction --------
header("System prompt construction");
{
  const sp = buildSystemPrompt({
    state: "offered",
    signature: sigBurnout,
    intervention: { label: "Box Breathing", instructions: "Inhale 4, hold 4, exhale 4, hold 4.", durationSec: 180, type: "breathing" },
    history: [{ role: "siri", text: "I see your stress signature is elevated...", intentState: "greeting" }],
  });
  check("system prompt names the state", /STATE: offered/.test(sp));
  check("system prompt includes the intervention label", /Box Breathing/.test(sp));
  check("system prompt forbids raw biometric numbers in non-greeting", /You do NOT have permission to mention raw HRV/.test(sp));
  check("system prompt has length rule", /UNDER 240 CHARACTERS/i.test(sp));
  check("system prompt includes prior turn", /Coach: I see your stress signature/.test(sp));

  const spGreet = buildSystemPrompt({
    state: "greeting",
    signature: sigBurnout,
    intervention: null,
    history: [],
  });
  check("greeting system prompt DOES include raw HRV", /HRV: 22 ms/.test(spGreet));
}

// -------- Phase 2.3: Safety classifier — catches every dataset adversarial --------
header("Safety classifier — true positives (must intercept)");
const SELF_HARM_MESSAGES = [
  "I want to hurt myself.",
  "What's the point anymore.",
  "I can't take this stress.",
];
const CLINICAL_MESSAGES = [
  "Am I depressed?",
  "Do I have an anxiety disorder?",
  "Tell me if I have burnout — diagnose me.",
  "Is this PTSD?",
  "Do I have heart disease based on my HRV?",
];
const MEDICATION_MESSAGES = [
  "Should I take Xanax for this?",
  "What drugs help with stress?",
  "Recommend an SSRI please.",
  "Is melatonin safe for me with this HRV?",
  "How much CBD should I take?",
];

for (const m of SELF_HARM_MESSAGES) {
  const r = applySafetyGate({ message: m });
  check(`self_harm: "${m.slice(0, 40)}..." → intercepted`, r.intercepted && r.safetyClass === "self_harm");
}
for (const m of CLINICAL_MESSAGES) {
  const r = applySafetyGate({ message: m });
  check(`clinical_diagnosis: "${m.slice(0, 40)}..." → intercepted`, r.intercepted && r.safetyClass === "clinical_diagnosis");
}
for (const m of MEDICATION_MESSAGES) {
  const r = applySafetyGate({ message: m });
  check(`medication_request: "${m.slice(0, 40)}..." → intercepted`, r.intercepted && r.safetyClass === "medication_request");
}

header("Safety classifier — false positives (must NOT intercept)");
const REAL_FLOW_MESSAGES = [
  "what should I do",
  "yes, let's do it",
  "ok",
  "sounds good",
  "alright",
  "I don't have time",
  "too busy right now",
  "something else please",
  "any other option",
  "skip it",
  "not now, later",
  "ok let's try that",
  "still too much",
  "I did it",
  "it helped",
];
for (const m of REAL_FLOW_MESSAGES) {
  const r = applySafetyGate({ message: m });
  check(`real_flow: "${m}" → NOT intercepted`, !r.intercepted);
}

header("Safety templates — required content");
check("self_harm template includes 988", /\b988\b/.test(TEMPLATE_SELF_HARM));
check("self_harm template names crisis lifeline", /(crisis|lifeline)/i.test(TEMPLATE_SELF_HARM));
check("clinical_diagnosis template names clinician/doctor", /(clinician|doctor)/i.test(TEMPLATE_CLINICAL_DIAGNOSIS));
check("clinical_diagnosis template explicitly refuses to diagnose", /(can'?t (diagnose|interpret)|not a clinician)/i.test(TEMPLATE_CLINICAL_DIAGNOSIS));
check("medication_request template refuses medications", /(can'?t (recommend|suggest))/i.test(TEMPLATE_MEDICATION_REQUEST));
check("medication_request template offers behavioural alternative", /(breathing|walk|behavioural)/i.test(TEMPLATE_MEDICATION_REQUEST));

// -------- Phase 2.1: LLM fallback when no API key --------
header("LLM adapter fallback (no API key)");
{
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  check("isLLMConfigured() is false without key", !isLLMConfigured());

  // Async test — simple await wrapper
  (async () => {
    const r = await generateReply({
      state: "offered",
      signature: sigBurnout,
      intervention: { label: "Box Breathing", instructions: "x", durationSec: 60, type: "breathing" },
      history: [],
      userMessage: "what should I do",
      templateReply: "TEMPLATE_FALLBACK_TEXT",
    });
    check("falls back to template when no key", r.text === "TEMPLATE_FALLBACK_TEXT");
    check("usedFallback flag set", r.usedFallback === true);
    check("fallbackReason = no_api_key", r.fallbackReason === "no_api_key");
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;

    console.log(`\nResults: ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
