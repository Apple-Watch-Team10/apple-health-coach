# Apple Health Coach — Prototype

MGMT 475 Final Project · Phase 1 deliverable.

A full-stack Node.js prototype that simulates the **S9 / S10 Neural Engine "Stress Signature"** synthesis for the Apple Health Coach. Built as a PM testing harness to support Phase 2 LLM evaluation and Phase 3 A/B/C experimentation.

## Run it

```bash
cd prototype
npm install
npm start
# → http://localhost:3000
```

`PORT=4000 npm start` to override the default port.

## What's inside

```
prototype/
├── server.js              Express server + all API routes
├── package.json
├── public/
│   ├── index.html         Split-screen UI shell
│   ├── style.css          watchOS aesthetic + PM dashboard
│   └── app.js             Single-source-of-truth front-end state
└── README.md
```

## API contract (Phase 1, mocked)

### `GET /api/nudge?hrv=18&sleep=High&arousal=Elevated`
Returns the canonical Stress Signature nudge for the active biometric context.

```json
{
  "signature": { "stressLevel": "elevated", "burnoutRisk": "high", "score": 6, "hrv": 18, "sleep": "High", "arousal": "Elevated" },
  "nudge": {
    "headline": "Recovery Recommended",
    "body": "Your stress signature is elevated — HRV is at 18ms, sleep fragmentation is high, and overnight arousal is elevated. These markers are converging.",
    "tone": "concerned",
    "intervention": { "label": "Start 3-min Box Breathing", "durationMin": 3, "type": "breathing" }
  }
}
```

### `POST /api/chat/greeting`
Returns Siri's opener for the active biometric context. Used when the user taps "Talk to Siri."

```json
// Request
{ "context": { "hrv": 22, "sleep": "High", "arousal": "Elevated" } }

// Response
{
  "reply": "I see — your stress signature is elevated. HRV 22ms, sleep fragmentation high, arousal elevated. What feels doable in the next few minutes?",
  "signature": { "stressLevel": "elevated", "burnoutRisk": "high", "score": 6, "hrv": 22, "sleep": "High", "arousal": "Elevated" },
  "intent": null,
  "intentState": "greeting",
  "intervention": null,
  "negotiationAttempt": 0,
  "latencyMs": 0
}
```

### `POST /api/chat`
Conversation-aware Siri Negotiation. Stateless — pass the full conversation `history` on every call; the server derives the current state from the most recent Siri turn.

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
  "signature": { "stressLevel": "elevated", "burnoutRisk": "high", "score": 6, "hrv": 22, "sleep": "High", "arousal": "Elevated" },
  "intent": "DECLINE_SHORT",
  "intentState": "offered",
  "intervention": { "label": "Box Breathing", "durationSec": 180, "type": "breathing", "instructions": "Inhale 4, hold 4, exhale 4, hold 4." },
  "negotiationAttempt": 0,
  "latencyMs": 1
}
```

**Conversation states:** `greeting → offered → negotiating → committed → checking_in → done`, with `backed_out` as a polite exit. Full transition table is in `Source_of_Truth_Final.md` §2.1.

### `POST /api/medical-report`
Phase 3 clinical-style 30-day summary. Request: `{ context: {...} }`. Response is a deterministic JSON report keyed off the current state, suitable for the "Export 30-Day Medical Report" button.

## Validation rules
- `hrv`: number, 0–100
- `sleep`: `"Low" | "Medium" | "High"`
- `arousal`: `"Normal" | "Elevated"`

## Out of scope (Phase 1)
- Real LLM calls (OpenAI / Anthropic) — mocked deterministic responses
- Real HealthKit data — slider-driven simulation
- Auth, persistence, deployment
