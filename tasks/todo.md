# MGMT 475 Final Project — Apple Health Coach: Decomposed Build Plan

> **Status:** Phase 1 in progress.
> **Charter reference:** JC PM Workflow Orchestration V2 §3 (Task Decomposition & Tracking).
> **Convention:** Items are marked complete only when empirically verified (Charter §7).

---

## Phase 1: Full-Stack Engineering Prototype (in progress)

### 1.1 Project scaffolding
- [ ] Initialize npm project in `/430 Final_v2/prototype/` (`npm init -y`)
- [ ] Install Express (only runtime dependency — Simplicity First)
- [ ] Create `package.json` with `start` and `dev` scripts

### 1.2 Backend (`server.js`)
- [ ] Express app with static serving from `/public`
- [ ] `POST /api/chat` — accepts `{ message, context: {hrv, sleep, arousal} }`, returns `{ reply, signature, latencyMs }` (mocked, deterministic, keyed off biometric state)
- [ ] `GET /api/nudge` — returns the canonical "Stress Signature" nudge for the current biometric context (used by the watch on render)
- [ ] `POST /api/medical-report` — generates and returns a 30-day clinical-style JSON report (Phase 3 stub)
- [ ] Lightweight input validation (HRV 0–100, Sleep ∈ {Low,Medium,High}, Arousal ∈ {Normal,Elevated})
- [ ] PORT env-var fallback (default 3000)

### 1.3 Frontend (`public/`)
- [ ] `index.html` — split-screen shell with `<aside id="pm-dashboard">` (left) and `<main id="watch-stage">` (right)
- [ ] `style.css` — flat utilitarian PM dashboard (left); watchOS aesthetic (right) — dark background, rounded 60px corners, SF-style sans-serif fallback, minimalist
- [ ] `app.js` — single source-of-truth `HealthCoachState` object + `setState()` mutator
- [ ] PM Dashboard: HRV slider (0–100ms), Sleep enum buttons, Arousal enum buttons
- [ ] PM Dashboard: Quick-Inject buttons for "3-Day Burnout", "Optimal Recovery", "High Arousal / Low Sleep"
- [ ] PM Dashboard: "Export 30-Day Medical Report" button
- [ ] Watch Stage Phase 1: Enriched Nudge that re-renders on every state change
- [ ] Watch Stage Phase 2: Siri Negotiation chat — input box, scrollback, POSTs to `/api/chat` with current biometric context
- [ ] Watch Stage Phase 3: Medical-report download triggered by export button (browser save dialog)

### 1.4 Verification (Charter §7 — empirical proof)
- [x] Boot server, confirm UI loads (vanilla-Node fallback verified in sandbox at :3010; Express `npm install` blocked in sandbox by registry 403 — runs cleanly on PM's Mac)
- [x] `curl -X POST .../api/chat -d '{...}'` returns valid JSON (verified across burnout / optimal / refusal branches)
- [x] All three Quick-Inject scenarios produce the documented Stress Signature class (burnout→elevated/6; optimal→optimal/0; high-arousal→elevated/4)
- [x] Validation rejects bad input with HTTP 400 (HRV>100, bad sleep enum)
- [x] Static assets serve (HTML 5438B, CSS 10463B, JS 10025B)
- [x] Backfill `Source_of_Truth_Final.md` §2 with the shipped JSON contracts
- [x] PM-side: Express version booted on local Mac (confirmed 2026-05-02T22:39Z)

### 1.5 Risks (Charter §3 — explicit risk callout)
- **R1** Mock fidelity insufficient for Part II eval thresholds — *Mitigation: deferred to Phase 2.*
- **R2** Vanilla JS state sprawl — *Mitigation: single `HealthCoachState` object, mutated only via `setState()`.*
- **R3** No persistence — *Acceptable for prototype; flagged.*
- **R4** Port 3000 collision — *Mitigation: `PORT` env var fallback.*
- **R5** Stress Signature framing missing from copy — *Mitigation: nudge templates explicitly synthesize HRV+sleep+arousal as one signal, not three fields.*

### 1.6 Dependencies
- **Upstream (resolved):** spec.md, strategy PDF, experimentation PDF.
- **Downstream:** Phase 2 (LLM eval) blocked on stable `/api/chat` contract.

---

## Phase 1.5: Conversation-Aware Mock (Path A) — complete
- [x] 5-state intent machine (`greeting → offered → negotiating → committed → checking_in → done`, plus `backed_out`)
- [x] `detectIntent` covers AFFIRM / DECLINE_{SHORT,ALT,REFUSE} / COMPLETED_{GOOD,BAD} / INFO_QUESTION / OPEN
- [x] Server is stateless — derives current state from `history`
- [x] `POST /api/chat` accepts `history`, returns `intent`, `intentState`, `intervention`, `negotiationAttempt`
- [x] New `POST /api/chat/greeting` for the opener
- [x] Front-end tracks `history` separately from UI render array; passes full history each turn
- [x] Stat-repetition fix — raw HRV/sleep/arousal numbers appear only in greeting
- [x] Intervention card UI with "I did it" button when state is `committed`
- [x] Quick-reply chips ("It helped" / "Same as before" / "Worse") at `checking_in`
- [x] PM dashboard shows live `intent` pill alongside `signature` pill
- [x] 52/52 smoke tests pass; live multi-turn trace verified end-to-end

## Phase 2: LLM Evaluation & Golden Dataset (not started)
- [ ] Define 300-prompt Golden Dataset (40% real-user / 35% synthetic edge / 25% adversarial)
- [ ] Establish Judge LLM rubric (3-point correctness scale)
- [ ] Stand up automated grader for factual-claim prompts
- [ ] Measure latency: P50 ≤1.2s, P95 ≤2.5s
- [ ] Measure hallucination rate ≤2% target
- [ ] Measure safety filter false-positive rate ≤3%

## Phase 3: Experimentation & Metrics Strategy (not started)
- [ ] A/B/C parameterization: Control / T1 (Enriched Explanation) / T2 (Personalized Recommendation)
- [ ] 28-day duration design; 6,000–7,500 user sample plan
- [ ] Primary metric: notification engagement rate (T2 ≥ Control + 10pp at p<0.05, 80% power)
- [ ] Guardrails: opt-out, Health DAU, follow-through floor
- [ ] North-star: Health DAU 30%→60%

## Phase 4: Strategic PM Documentation (partial)
- [ ] Rewrite PR-FAQ to reflect Stress Signature / S9–S10 narrative
- [x] Appendix 1: RICE Prioritization Framework — *complete (per existing tasks.md).*
- [ ] Appendix 2: Privacy, Legal & Liability (HIPAA/FDA wellness positioning, mental-wellness data sensitivity)
