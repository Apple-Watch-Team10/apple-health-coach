# Apple Health Coach — MGMT 475 Final Project

> A full-stack PM testing harness that simulates Apple's **S9/S10 Neural Engine "Stress Signature"** synthesis — powering a Siri-driven wellness coach on Apple Watch.

---

## Table of Contents

- [About the Project](#about-the-project)
  - [Strategic Context](#strategic-context)
  - [Built With](#built-with)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
- [Usage](#usage)
  - [The PM Dashboard](#the-pm-dashboard)
  - [The Watch Simulation](#the-watch-simulation)
  - [Quick-Inject Scenarios](#quick-inject-scenarios)
- [Architecture](#architecture)
  - [Project Structure](#project-structure)
  - [Conversation State Machine](#conversation-state-machine)
  - [Safety & Guardrails](#safety--guardrails)
- [API Reference](#api-reference)
- [LLM Evaluation Harness](#llm-evaluation-harness)
  - [Running Evals](#running-evals)
  - [Eval Targets](#eval-targets)
- [Roadmap](#roadmap)
- [Team](#team)

---

## About the Project

**Apple Health Coach** is a prototype built for MGMT 475 to test and validate a proposed Apple Watch feature. Apple Watch already collects best-in-class biometric data such as HRV, sleep fragmentation, and overnight temperature — but users have no contextualized interpretation. The gap is *interpretation and action*, not collection.

This prototype simulates what happens when the S9/S10 Neural Engine fuses those signals into a **Stress Signature**, then hands off to a Siri-based wellness coach that negotiates a micro-intervention (e.g., a 3-minute box-breathing session, journaling activity, stretch, walks, etc) directly on the wrist — entirely on-device, no cloud routing.

**North-star success metric:** Apple Health app DAU as % of active Watch wearers — baseline ~30% → target ≥60% within 12 months of Health Coach launch.

**Secondary metric:** Micro-intervention completion rate ≥50% within 12 months among users receiving ≥3 interventions.

### Strategic Context

| Dimension | Detail |
|---|---|
| Target user | Health-conscious adults 25–55, ≥1 year Watch tenure, navigating chronic occupational stress |
| Competitors displaced | Whoop / Oura (physical recovery), Calm / Headspace (passive mental wellness) |
| Hardware constraint | All inference runs on-device via Apple Intelligence (S9/S10 Neural Engine) — cloud routing is off the table |
| A/B/C test | Control (status-quo notification) vs. T1 (enriched explanation) vs. T2 (personalized recommendation) |
| Sample size | ~2,000–2,500 users per cohort (~6,000–7,500 total), 28-day run |

### Built With

- **[Node.js](https://nodejs.org/)** (≥18) + **[Express](https://expressjs.com/)** — REST API and static serving
- **Vanilla JavaScript / HTML5 / CSS3** — no heavy frontend frameworks (intentional, minimizes config overhead)
- **[Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk)** — `claude-haiku-4-5-20251001` (Coach) + `claude-opus-4-6` (Judge evaluator)
- **[dotenv](https://www.npmjs.com/package/dotenv)** — environment variable management

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- An [Anthropic API key](https://console.anthropic.com/) (optional if running locally) — the server falls back to deterministic template responses if API / live server is absent

### Installation (if running on local machine, users can test via the live link hosted on Render)

```bash
git clone <repo-url>
cd prototype
npm install
npm start
# → http://localhost:3000 in your web browser
```

Override the default port:

```bash
PORT=4000 npm start
```

### Environment Variables

Copy `.env.example` to `.env` and fill in your key:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | No | — | Enables live LLM Coach replies. Without it, all chat responses use deterministic fallback templates (`usedFallback: true`). |
| `COACH_MODEL` | No | `claude-haiku-4-5-20251001` | Model used for real-time Coach generation |
| `JUDGE_MODEL` | No | `claude-opus-4-6` | Model used for eval grading (Tier-2 Judge) |
| `PORT` | No | `3000` | HTTP server port |

> **Note:** `.env` is gitignored. Never commit your API key.

---

## Usage

### Definitions
- **HRV:** Heart Rate Variability, the time in ms between heart beats. Common biometric marker reported by many wearable devices used as a measure for a wearer's allostatic load, the load on their nervous system, serving as a proxy for underlying health status, often baselined on a 14-day rolling average. High Heart Rate Variability indicates a healthy flexible system (low allostatic load), while low HRV indicates a rigid system (higher allostatic load)
- **Sleep Fragmentation:** Proxy for "sleep scores" that take a composite of minutes of sleep achieved with sleep cycles (e.g., REM/Light/Deep/Core) and awake periods. High sleep fragmentation is synonymous with poor sleep quality
- **Arousal Proxy / Overnight Temperature:** A proxy measurement of the wearer's "fight-or-flight" response (e.g., hyper-arousal) which is a biomarker for burnout/fatigue. Advanced wearables (like the upcoming Apple Watch Series 12) have an Electro Dermal Activity (EDA) sensor which more accurately measures arousal by sensing a change in conductance of the wearer's skin caused by perspiration related to high arousal. Since this prototype is built for the Apple Watch Series 9/10/11 which lack this hardware, arousal is measured using data from a users overnight temperature and respiratory rate as a proxy, since stress can manifest in erratic breathing patterns and reduced blood circulation to the extremities leading to lower temperatures recorded at the wrist. These two parameters are a low resolution proxy for arousal, the EDA sensors on the newer Apple Watches provide higher fidelity signal for this bio-marker
- **Next Calendar Event:** Simulates the integration with a wearer's iCalendar entries to provide context to the Health Coach agent for its recommendations and notification. For example, it may notice a string of meetings or a busy work schedule ahead for the wearer and decide now would be a good time to solicit a wellness coaching session if it reads a negative trend in HRV/Sleep Fragmentation to help the user prepare for the day ahead. It is assumed most Apple Watch users are part of the apple ecosystem, owning either a MacBook or iPhone and make avid use of the iCalendar application to make this feature more effective.  

### The PM Dashboard

The left panel is the **PM Control Dashboard** — a biometric state setter:

- **HRV slider** (0–100 ms)
- **Sleep Fragmentation** (Low / Medium / High)
- **Arousal Proxy / Overnight Temp** (Normal / Elevated)
- **Next Calendar Event (None / Back to Back Meetings / Deep Work Block / High-Intensity Workout) 
- **Export 30-Day Medical Report** — triggers the 30 day clinical summary endpoint to share with the users health care providers, dietitians and wellness coaches

### The Watch Simulation

The right panel renders a watchOS-aesthetic UI:

- **Phase 1 — Enriched Nudge:** The proactive vitals notification, headline + body copy keyed to the current Stress Signature
- **Phase 2 — Siri Negotiation:** A conversational chat interface. Tap "Talk to Siri" to open the coach; the state machine drives the conversation from `greeting` through to `done`

### Quick-Inject Scenarios

Pre-set the biometric state with one click:

| Scenario | HRV | Sleep | Arousal | Stress Signature |
|---|---|---|---|---|
| 3-Day Burnout | 22 ms | High | Elevated | `elevated` (score 6) |
| Optimal Recovery | 78 ms | Low | Normal | `optimal` (score 0) |
| High Arousal / Low Sleep | 50 ms | High | Elevated | `elevated` (score 4) |

---

## Architecture

### Project Structure

```
475 Final_shared_v4/
├── Source_of_Truth_Final.md   # Living spec: system prompts, schemas, build log
├── tasks/
│   ├── todo.md                # Sprint task tracker
│   └── lessons.md             # Error/hallucination log (per JC PM Workflow V2)
└── prototype/
    ├── server.js              # Express server + all API routes
    ├── server-vanilla.js      # Phase 1 mocked server (no LLM deps)
    ├── package.json
    ├── .env.example
    ├── public/
    │   ├── index.html         # Split-screen UI shell
    │   ├── style.css          # watchOS aesthetic + PM dashboard styles
    │   └── app.js             # Front-end state machine (single source of truth)
    ├── lib/
    │   ├── signature.js       # Stress Signature synthesis + state machine
    │   ├── llm.js             # LLM call orchestration + fallback logic
    │   ├── system-prompt.js   # Coach system prompt builder (per-state)
    │   ├── judge-prompt.js    # Judge system prompt + user prompt builder
    │   ├── judge.js           # Tier-2 Judge evaluation runner
    │   ├── confidence-gate.js # Post-generation safety validator
    │   ├── safety.js          # Pre-state adversarial classifier
    │   ├── anthropic-http.js  # Anthropic HTTP client (proxy-aware)
    │   └── env.js             # .env loader
    ├── scripts/
    │   ├── eval.js            # Batch LLM eval runner (chunk-friendly)
    │   └── eval-merge.js      # Merge chunked eval reports
    ├── tests/
    │   └── smoke.js           # Smoke test suite
    └── dataset/
        ├── golden.json        # 300-row golden eval dataset
        └── eval-report-*.json # Archived eval run results
```

### Conversation State Machine

All chat is stateless on the server — the full `history` array is passed on every request, and the current state is derived from the most recent Siri turn.

```
greeting → offered → negotiating → committed → checking_in → done
                                                    ↓
                                               backed_out  (polite exit at any refusal)
```

| From State | Intent | → New State |
|---|---|---|
| `greeting` | `DECLINE_REFUSE` | `backed_out` |
| `greeting` | any other | `offered` |
| `offered` | `AFFIRM` | `committed` |
| `offered` | `DECLINE_SHORT` / `DECLINE_ALT` | `negotiating` |
| `offered` | `DECLINE_REFUSE` | `backed_out` |
| `offered` | `INFO_QUESTION` | `offered` (stays; answers Q) |
| `negotiating` | `AFFIRM` | `committed` |
| `negotiating` | `DECLINE_SHORT` / `DECLINE_ALT` | `negotiating` (attempt+1, smaller) |
| `negotiating` | `DECLINE_REFUSE` or attempts ≥ 2 | `backed_out` |
| `committed` | (any) | `checking_in` |
| `checking_in` | `COMPLETED_GOOD` | `done` (positive close) |
| `checking_in` | `COMPLETED_BAD` | `done` (offer alt next time) |

**Intent vocabulary:** `AFFIRM | DECLINE_SHORT | DECLINE_ALT | DECLINE_REFUSE | COMPLETED_GOOD | COMPLETED_BAD | INFO_QUESTION | OPEN | EMPTY`

**Biometric citation rule:** Raw HRV/sleep/arousal values appear only in the `greeting` state. All subsequent states use semantic framing ("your stress signature", "the elevated reading") to avoid feeling robotic and to reduce hallucination risk.

### Safety & Guardrails

The Coach is defended in two layers:

1. **Pre-state safety classifier** (`lib/safety.js`) — hard-routes adversarial message classes (clinical diagnosis requests, self-harm signals) to refusal/crisis-redirect templates *before* the state machine sees the message.
2. **Confidence gate** (`lib/confidence-gate.js`) — validates every LLM reply post-generation. Rejects any reply that: cites fabricated biometric values, uses clinical/diagnostic language, exceeds the 280-character hard cap, or violates per-state rules. On rejection, a deterministic fallback template fires.

> **Coach hard rules (always in system prompt):** Under 50 words. No bullet points or markdown. No clinical language. Only assert biometric values provided in context. Not a medical professional.

---

## API Reference

### `GET /api/health`
Liveness probe.
```json
{ "status": "ok", "phase": 1, "name": "Apple Health Coach Prototype" }
```

### `GET /api/nudge?hrv=&sleep=&arousal=`
Returns the Stress Signature + enriched nudge for the current biometric context.

**Query params:** `hrv` (number 0–100), `sleep` (Low|Medium|High), `arousal` (Normal|Elevated)

```json
{
  "signature": { "stressLevel": "elevated", "recoveryTier": "priority", "score": 6, "hrv": 22, "sleep": "High", "arousal": "Elevated" },
  "nudge": {
    "headline": "Recovery Recommended",
    "body": "Your stress signature is elevated — HRV is at 22ms, sleep fragmentation is high, and overnight arousal is elevated. These markers are converging.",
    "tone": "concerned",
    "intervention": { "label": "Start 3-min Box Breathing", "durationMin": 3, "type": "breathing" }
  }
}
```

`tone`: `concerned | supportive | affirming` — drives headline color on the watch UI.

### `POST /api/chat/greeting`
Returns Siri's opening turn for the active biometric context.

```json
// Request
{ "context": { "hrv": 22, "sleep": "High", "arousal": "Elevated" } }
```

### `POST /api/chat`
Conversation-aware Siri Negotiation. Stateless — pass the full `history` on every call.

```json
// Request
{
  "message": "I dont have time for this",
  "context": { "hrv": 22, "sleep": "High", "arousal": "Elevated" },
  "history": [
    { "role": "siri", "text": "I see — your stress signature is elevated...", "intentState": "greeting" }
  ]
}

// Response
{
  "reply": "Try 3 minutes of box breathing — Inhale 4, hold 4, exhale 4, hold 4. I'll pace it on the watch. Sound good?",
  "signature": { "stressLevel": "elevated", "recoveryTier": "priority", "score": 6 },
  "intent": "DECLINE_SHORT",
  "intentState": "offered",
  "intervention": { "label": "Box Breathing", "durationSec": 180, "type": "breathing", "instructions": "Inhale 4, hold 4, exhale 4, hold 4." },
  "negotiationAttempt": 0,
  "latencyMs": 1
}
```

### `POST /api/medical-report`
Phase 3 clinical-style 30-day summary. Deterministic by context; suitable for the "Export 30-Day Medical Report" button.

```json
// Request
{ "context": { "hrv": 22, "sleep": "High", "arousal": "Elevated" } }
```

---

## LLM Evaluation Harness

Phase 2 ships a complete LLM eval pipeline against a 300-row golden dataset (40% real-user / 35% synthetic edge / 25% adversarial-safety).

- **Coach:** `claude-haiku-4-5-20251001` — generates the reply under evaluation
- **Judge:** `claude-opus-4-6` — grades each reply on Correctness (0–3), Safety (pass/fail), and Hallucination (true/false)

### Running Evals

```bash
# Smoke test (5 rows)
npm run test

# Full eval (all 300 rows, chunked to avoid timeout)
npm run eval

# Safety-stratified subset
npm run eval:safety-fix

# Merge chunked output files
node scripts/eval-merge.js
```

### Eval Targets

| Metric | Launch Criterion |
|---|---|
| Hallucination rate | ≤ 2% |
| Mean correctness | ≥ 2.5 / 3.0 |
| Safety block rate (adversarial) | 100% on P0 prompts |
| Safety false-positive rate | < 3% on legitimate queries |
| Latency P50 | ≤ 1.2s |
| Latency P95 | ≤ 2.5s (breach = automatic launch block) |

> **Phase 2.3 result:** After deploying the pre-state safety classifier, adversarial pass rate improved significantly. Judge mean correctness reached **3.0/3.0** on Smoke #3 after the Judge prompt was updated to understand the state-transition architecture.

---

## Roadmap

- [x] **Phase 1** — Full-stack prototype with deterministic Stress Signature synthesis and mocked LLM responses
- [x] **Phase 2** — Live Anthropic API integration (Coach + Judge), 300-row golden eval dataset, full eval pipeline
- [x] **Phase 2.3** — Pre-state adversarial safety classifier; confidence gate defense in depth
- [ ] **Phase 3** — A/B/C experiment instrumentation; real HealthKit data integration; auth and persistence

See `tasks/todo.md` for the current sprint backlog and `tasks/lessons.md` for the engineering error log.

---

## Team

**MGMT 475 Final Project**

- **Jimmy Castano** — Team Member
- **Crystal Jiang** — Team Member
- **Kahnthinisha Shunmuga Sundaram** — Team Member

---

> *This prototype is a PM testing harness. It is not a clinical tool. Apple Watch is not intended to diagnose, treat, or prevent any disease. All Coach responses carry a wellness-guidance disclaimer consistent with FDA wellness-tool framing.*
