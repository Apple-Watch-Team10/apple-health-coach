/**
 * Apple Health Coach — Prototype Front-End
 * MGMT 475 Final Project
 *
 * Architecture (Phase 1 risk R2 mitigation):
 *   - One single source of truth: window.HealthCoachState
 *   - All mutations go through setState({...}) which triggers re-render
 *   - No framework, no virtual DOM. Tiny imperative renderer.
 */
(function () {
  "use strict";

  // -----------------------------------------------------------
  // State
  // -----------------------------------------------------------
  const HealthCoachState = {
    biometric: { hrv: 50, sleep: "Low", arousal: "Normal" },
    calendarEvent: "none",            // Sprint 2.1 — passed in context to /api/chat
    signature: null,                  // populated after first /api/nudge
    nudge: null,
    view: "nudge",                    // "nudge" | "chat"
    chat: [],                         // UI render array — { role, text, intervention?, quickReplies? }
    history: [],                      // server-bound — { role: "user"|"siri", text, intentState? }
    intentState: null,                // "greeting"|"offered"|"negotiating"|"committed"|"checking_in"|"done"|"backed_out"
    activeIntervention: null,
    lastLatencyMs: null,
    isSending: false,
    
    baselines: { hrv: 50, hr: 70 }, 
    activityLog: []
  };
  
  
  function runOnboarding() {
  if (!HealthCoachState.userPreferences) {
    const prefs = window.prompt(
      "Welcome! What recovery types do you prefer? \n(Type any: Physical, Mindfulness, Sensory, Reflection)",
      "Mindfulness"
    );
    HealthCoachState.userPreferences = prefs ? prefs.split(",").map(p => p.trim()) : ["Mindfulness"];
    console.log("User Preferences Set:", HealthCoachState.userPreferences);
  }
}

  // Display labels for the calendar dropdown values (used by the dashboard pill).
  const CALENDAR_LABELS = {
    "none": "None",
    "back-to-back": "Back-to-back Meetings",
    "deep-work": "Deep Work Block",
    "workout": "High-Intensity Workout",
  };
  window.HealthCoachState = HealthCoachState;

  function setState(patch) {
    Object.assign(HealthCoachState, patch);
    render();
  }

  // -----------------------------------------------------------
  // Scenarios (must match the three documented in spec.md §3.1)
  // -----------------------------------------------------------
  const SCENARIOS = {
    burnout:        { hrv: 22, sleep: "High",   arousal: "Elevated" },
    optimal:        { hrv: 78, sleep: "Low",    arousal: "Normal"   },
    "high-arousal": { hrv: 50, sleep: "High",   arousal: "Elevated" },
  };

  // -----------------------------------------------------------
  // Element refs
  // -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const els = {
    hrvSlider: $("hrv"),
    hrvValue: $("hrv-value"),
    sleepValue: $("sleep-value"),
    sleepSegment: $("sleep-segment"),
    arousalValue: $("arousal-value"),
    arousalSegment: $("arousal-segment"),
    calendarSelect: $("calendar-event"),
    calendarValue: $("calendar-value"),
    scenarios: document.querySelectorAll(".scenario"),
    exportBtn: $("export-btn"),
    interviewNoteBtn: $("interview-note-btn"),
    noteStatus: $("note-status"),
    signaturePill: $("signature-pill"),
    intentPill: $("intent-pill"),
    latencyPill: $("latency-pill"),
    nudgeCard: $("nudge-card"),
    nudgeHeadline: $("nudge-headline"),
    nudgeBody: $("nudge-body"),
    nudgeCta: $("nudge-cta"),
    chatCard: $("chat-card"),
    chatLog: $("chat-log"),
    chatForm: $("chat-form"),
    chatInput: $("chat-input"),
    chatBack: $("chat-back"),
    chatMic: $("chat-mic"),
    chatMicTooltip: $("chat-mic-tooltip"),
    watchTime: $("watch-time"),
    // Modal
    reportModal: $("report-modal"),
    modalClose: $("modal-close"),
    modalDownload: $("modal-download"),
    modalSignatureAnalysis: $("signature-analysis"),
    modalMetrics: $("report-metrics"),
    sparkline: $("hrv-sparkline"),
    sparklineAxis: $("hrv-sparkline-axis"),
    correlationGraph: $("correlation-graph"),
    correlationAxis: $("correlation-axis"),
  };

  // Last-fetched medical report cached for the modal "Download JSON" button.
  let lastReport = null;

  // -----------------------------------------------------------
  // Backend helpers
  // -----------------------------------------------------------
  async function fetchNudge() {
    const ctx = HealthCoachState.biometric;
    // /api/nudge is a GET — calendarEvent rides as a query param for the
    // future context-aware nudge story. Backend currently ignores it.
    const params = new URLSearchParams({
      hrv: String(ctx.hrv),
      sleep: ctx.sleep,
      arousal: ctx.arousal,
      calendarEvent: HealthCoachState.calendarEvent,
    });
    try {
      const r = await fetch(`/api/nudge?${params.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setState({ signature: data.signature, nudge: data.nudge });
    } catch (e) {
      console.error("[nudge] failed:", e);
    }
  }

  function buildContextForRequest() {
    // Sprint 2.1: include calendarEvent in the context so the backend has it
    // available for upcoming context-aware nudge logic. Validation only
    // checks hrv/sleep/arousal, so the extra field passes through safely.
    return {
      ...HealthCoachState.biometric,
      calendarEvent: HealthCoachState.calendarEvent,
    };
  }

  async function fetchGreeting() {
    try {
      const r = await fetch("/api/chat/greeting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: buildContextForRequest() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const siriTurn = {
        role: "siri",
        text: data.reply,
        intentState: data.intentState,
      };
      setState({
        chat: [{ role: "siri", text: data.reply }],
        history: [siriTurn],
        signature: data.signature,
        intentState: data.intentState,
        activeIntervention: null,
        lastLatencyMs: data.latencyMs,
      });
    } catch (e) {
      setState({
        chat: [{ role: "system", text: `Error: ${e.message}` }],
        intentState: null,
      });
    }
  }

async function sendChat(message) {
    // 1. Define the user message object ONCE
    const userTurn = { role: "user", text: message };

    // 2. THE GUARD: Check for danger first
    if (HealthCoachState.intentState === "CRITICAL_REDLINE") {
      setState({
        chat: [
          ...HealthCoachState.chat, 
          userTurn, 
          { role: "siri", text: "Coaching is currently disabled due to critical biometrics. Please prioritize rest." }
        ]
      });
      return; // Stop execution here
    }

    // 3. THE NORMAL PATH
    if (HealthCoachState.isSending) return;

    // Optimistic UI: append user message AND a "Thinking..." placeholder
    const placeholderTurn = { role: "siri", text: "Thinking", thinking: true };
    
    setState({
      chat: [...HealthCoachState.chat, userTurn, placeholderTurn],
      history: [...HealthCoachState.history, userTurn],
      isSending: true,
    });

    // Hold the placeholder for simulation latency
    const minWait = new Promise((r) => setTimeout(r, 1200));
    const fetchPromise = fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        context: buildContextForRequest(),
        history: HealthCoachState.history,
      }),
    });

    try {
      const [, r] = await Promise.all([minWait, fetchPromise]);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      const siriUiTurn = {
        role: "siri",
        text: data.reply,
        intervention: data.intervention || null,
        quickReplies:
          data.intentState === "checking_in"
            ? ["It helped", "Same as before", "Worse"]
            : null,
      };
      
      const siriHistoryTurn = {
        role: "siri",
        text: data.reply,
        intentState: data.intentState,
      };

      // Replace the placeholder with the real reply
      const nextChat = HealthCoachState.chat.slice(0, -1).concat([siriUiTurn]);

      setState({
        chat: nextChat,
        history: [...HealthCoachState.history, siriHistoryTurn],
        signature: data.signature,
        intentState: data.intentState,
        activeIntervention: data.intervention || HealthCoachState.activeIntervention,
        lastLatencyMs: data.latencyMs,
        isSending: false,
      });
    } catch (e) {
      const nextChat = HealthCoachState.chat.slice(0, -1).concat([
        { role: "system", text: `Error: ${e.message}` },
      ]);
      setState({ chat: nextChat, isSending: false });
    }
  }

  async function exportMedicalReport() {
    els.exportBtn.disabled = true;
    els.exportBtn.textContent = "Generating…";
    try {
      const r = await fetch("/api/medical-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: HealthCoachState.biometric }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const report = await r.json();
      lastReport = report;
      openReportModal(report);
    } catch (e) {
      alert(`Export failed: ${e.message}`);
    } finally {
      els.exportBtn.disabled = false;
      els.exportBtn.textContent = "Export 30-Day Medical Report";
    }
  }

  // ---------------------------------------------------------
  // Phase 3 Polish: Clinical Report Modal
  // ---------------------------------------------------------

  function buildHrvSeries(hrv, stressLevel) {
    // 7 days, oldest leftmost, today rightmost.
    const series = [];
    const slope = stressLevel === "elevated" ? 2.5 :
                  stressLevel === "caution"  ? 1.0 :
                  -0.4;
    for (let i = 0; i < 7; i++) {
      const dayOffset = 6 - i;
      const wobble = ((i * 7) % 5) - 2; // deterministic small noise
      const v = hrv + slope * dayOffset + wobble;
      series.push(Math.max(10, Math.min(95, Math.round(v))));
    }
    series[series.length - 1] = hrv; // anchor today
    return series;
  }

  // ---------------------------------------------------------
  // Sprint 2.3: Biometric Correlation Graph (HRV / HR / Sleep)
  // Three deterministic series with stress-level-aware coupling:
  //   stress ↑  →  HRV ↓ , Heart Rate ↑ , Sleep score ↓
  // Plus event markers (Heavy Meal, HIIT Workout) drawn as vertical
  // dashed lines to anchor clinical narrative in the modal.
  // ---------------------------------------------------------
  function buildBiometricSeries(hrv, stressLevel) {
    const isElev = stressLevel === "elevated";
    const isCaution = stressLevel === "caution";
    const slope = isElev ? 2.6 : isCaution ? 1.1 : -0.5;
    const hrBase = isElev ? 78 : isCaution ? 72 : 64;
    const sleepBase = isElev ? 60 : isCaution ? 76 : 88;

    const out = { hrv: [], hr: [], sleep: [] };
    for (let i = 0; i < 7; i++) {
      const dayOffset = 6 - i;
      const wob = ((i * 7) % 5) - 2;
      const wobHr = ((i * 11) % 4) - 1;
      const wobSleep = ((i * 13) % 7) - 3;

      const hrvVal = Math.max(10, Math.min(95, Math.round(hrv + slope * dayOffset + wob)));
      const hrVal = Math.max(48, Math.min(110, Math.round(hrBase - slope * dayOffset * 0.7 + wobHr)));
      const sleepVal = Math.max(40, Math.min(100, Math.round(sleepBase - slope * dayOffset * 1.35 + wobSleep)));

      out.hrv.push(hrvVal);
      out.hr.push(hrVal);
      out.sleep.push(sleepVal);
    }
    out.hrv[6] = hrv; // anchor today's HRV to current slider value
    return out;
  }

  function buildEventMarkers() {
    // dayIndex 0..6 (rightmost = today). Heavy Meal placed at day 5 (1d ago)
    // so the post-meal HRV suppression visually precedes today's reading,
    // matching the Dietitian observation in the analysis paragraph.
    return [
      { dayIndex: 5, label: "Heavy Meal", short: "Heavy Meal", color: "#ffd60a" },
      { dayIndex: 3, label: "HIIT Workout", short: "HIIT", color: "#ff453a" },
    ];
  }

  function drawCorrelationGraph(canvas, series, markers) {
    if (!canvas || !canvas.getContext) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 520;
    const H = canvas.clientHeight || 156;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const padX = 16;
    const padTop = 22; // space for marker labels at the top
    const padBot = 14;
    const plotW = W - padX * 2;
    const plotH = H - padTop - padBot;
    const N = series.hrv.length;
    const xAt = (i) => padX + (i / (N - 1)) * plotW;

    // Background gridlines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 3; g++) {
      const y = padTop + (g / 3) * plotH;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(W - padX, y);
      ctx.stroke();
    }

    // Event markers — drawn before lines so the data renders on top
    ctx.font = "10px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
    ctx.textAlign = "center";
    markers.forEach((m) => {
      const x = xAt(m.dayIndex);
      ctx.strokeStyle = m.color;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, padTop - 2);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m.color;
      ctx.fillText(m.short, x, padTop - 8);
    });

    function plotSeries(values, color, opts) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = Math.max(1, max - min);
      const yAt = (v) => padTop + plotH - ((v - min) / range) * plotH;

      // Soft glow under primary series only
      if (opts.glow) {
        ctx.beginPath();
        values.forEach((v, i) => {
          const x = xAt(i);
          const y = yAt(v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.lineTo(xAt(N - 1), padTop + plotH);
        ctx.lineTo(xAt(0), padTop + plotH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, "rgba(90, 200, 250, 0.22)");
        grad.addColorStop(1, "rgba(90, 200, 250, 0.00)");
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = opts.thick ? 2.4 : 1.7;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (opts.dashed) ctx.setLineDash([5, 3]); else ctx.setLineDash([]);
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = xAt(i);
        const y = yAt(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Today dot
      const lastX = xAt(N - 1);
      const lastY = yAt(values[N - 1]);
      ctx.beginPath();
      ctx.arc(lastX, lastY, opts.thick ? 3.6 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (opts.thick) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    // Plot order: secondary lines first, primary HRV last so it sits on top.
    plotSeries(series.hr, "#ff9f0a", { thick: false });
    plotSeries(series.sleep, "#30d158", { thick: false, dashed: true });
    plotSeries(series.hrv, "#5ac8fa", { thick: true, glow: true });

    // Day axis labels
    if (els.correlationAxis) {
      const labels = ["−6d", "−5d", "−4d", "−3d", "−2d", "−1d", "today"];
      els.correlationAxis.innerHTML = labels.map((l) => `<span>${l}</span>`).join("");
    }
  }

  function drawSparkline(canvas, series) {
    if (!canvas || !canvas.getContext) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 520;
    const H = canvas.clientHeight || 96;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const min = Math.min(...series);
    const max = Math.max(...series);
    const range = Math.max(1, max - min);
    const padX = 14;
    const padY = 14;

    // Subtle horizontal mid-line
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, H / 2);
    ctx.lineTo(W - padX, H / 2);
    ctx.stroke();

    // Data line
    ctx.strokeStyle = "#5ac8fa";
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = padX + (i / (series.length - 1)) * (W - padX * 2);
      const y = H - padY - ((v - min) / range) * (H - padY * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Soft fill under the line
    ctx.lineTo(W - padX, H - padY);
    ctx.lineTo(padX, H - padY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(90, 200, 250, 0.25)");
    grad.addColorStop(1, "rgba(90, 200, 250, 0.00)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Data dots, with today highlighted
    series.forEach((v, i) => {
      const x = padX + (i / (series.length - 1)) * (W - padX * 2);
      const y = H - padY - ((v - min) / range) * (H - padY * 2);
      const isToday = i === series.length - 1;
      ctx.beginPath();
      ctx.arc(x, y, isToday ? 4 : 2.4, 0, Math.PI * 2);
      ctx.fillStyle = isToday ? "#ffffff" : "#5ac8fa";
      ctx.fill();
      if (isToday) {
        ctx.strokeStyle = "#5ac8fa";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    // Day labels
    if (els.sparklineAxis) {
      const labels = ["−6d", "−5d", "−4d", "−3d", "−2d", "−1d", "today"];
      els.sparklineAxis.innerHTML = labels
        .map((l, i) => `<span>${l} · ${series[i]}ms</span>`)
        .join("");
    }
  }

  function buildSignatureAnalysis(/* signature */) {
    // Sprint 2.3 — clinical narrative anchored on the Heavy Meal event marker
    // visible in the correlation graph above. PM directive: exact text.
    return "Observation: HRV suppression detected following 'Heavy Meals' logged after 8:00 PM. Recommendation for Dietitian: Adjust macronutrient timing.";
  }

  function renderReportMetrics(report) {
    if (!els.modalMetrics || !report) return;
    const s = report.summary || {};
    // Sprint 3.1 (A3) — replaced "Burnout Risk: High" cell with the softer
    // three-tier "Recovery" framing. Server still returns burnoutRisk for
    // back-compat, but the user-visible report no longer surfaces it.
    const cells = [
      { label: "Stress Level", value: s.stressLevel || "—" },
      { label: "Recovery", value: s.recoveryTierLabel || "—" },
      { label: "HRV Avg (ms)", value: s.hrvAvgMs != null ? s.hrvAvgMs : "—" },
      { label: "Sleep Frag.", value: s.sleepFragmentation || "—" },
      { label: "Elevated Arousal", value: (s.elevatedArousalDays != null ? `${s.elevatedArousalDays} / 30 nights` : "—") },
      { label: "Window", value: `${report.windowDays || 30} days` },
    ];
    els.modalMetrics.innerHTML = cells
      .map(c => `<div class="metric-cell"><div class="metric-label">${c.label}</div><div class="metric-value">${c.value}</div></div>`)
      .join("");
  }

  function openReportModal(report) {
    if (!els.reportModal) return;
    const sig = HealthCoachState.signature || report.summary || {};
    const hrv = HealthCoachState.biometric.hrv;
    const stressLevel = sig.stressLevel || "optimal";

    // Sprint 2.3: Biometric Correlation Graph (HRV + HR + Sleep, with markers)
    const series = buildBiometricSeries(hrv, stressLevel);
    const markers = buildEventMarkers();
    drawCorrelationGraph(els.correlationGraph, series, markers);

    // Backward compat: if the legacy single-line sparkline canvas is still
    // present in the DOM (older index.html), keep it populated too.
    if (els.sparkline) {
      drawSparkline(els.sparkline, buildHrvSeries(hrv, stressLevel));
    }

    els.modalSignatureAnalysis.textContent = buildSignatureAnalysis();
    renderReportMetrics(report);

    els.reportModal.hidden = false;
    els.reportModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeReportModal() {
    if (!els.reportModal) return;
    els.reportModal.hidden = true;
    els.reportModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function downloadLastReport() {
    if (!lastReport) return;
    const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `health-coach-30day-report-${lastReport.reportId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------
  // Phase 3 Polish: Interview Note button
  // ---------------------------------------------------------
  async function captureInterviewNote() {
    const text = window.prompt("Interview observation (will be saved with a UTC timestamp):");
    if (text === null) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const r = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      els.noteStatus.hidden = false;
      els.noteStatus.classList.remove("error");
      els.noteStatus.textContent = `Saved · ${data.count} notes total · ${new Date(data.entry.ts).toLocaleTimeString()}`;
    } catch (e) {
      els.noteStatus.hidden = false;
      els.noteStatus.classList.add("error");
      els.noteStatus.textContent = `Save failed: ${e.message}`;
    }
  }

  // -----------------------------------------------------------
  // Renderers
  // -----------------------------------------------------------
  function render() {
    renderControls();
    renderWatch();
    renderFooter();
  }

  function renderControls() {
    const ctx = HealthCoachState.biometric;

    // HRV slider + label + fill
    if (Number(els.hrvSlider.value) !== ctx.hrv) {
      els.hrvSlider.value = String(ctx.hrv);
    }
    els.hrvValue.textContent = `${ctx.hrv} ms`;
    els.hrvSlider.style.setProperty("--fill", `${ctx.hrv}%`);

    // Sleep segment
    els.sleepValue.textContent = ctx.sleep;
    els.sleepSegment.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.value === ctx.sleep);
    });

    // Arousal segment
    els.arousalValue.textContent = ctx.arousal;
    els.arousalSegment.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.value === ctx.arousal);
    });

    // Calendar dropdown — Sprint 2.1
    if (els.calendarSelect && els.calendarSelect.value !== HealthCoachState.calendarEvent) {
      els.calendarSelect.value = HealthCoachState.calendarEvent;
    }
    if (els.calendarValue) {
      els.calendarValue.textContent =
        CALENDAR_LABELS[HealthCoachState.calendarEvent] || HealthCoachState.calendarEvent;
    }
  }

  function renderWatch() {
    const { view, nudge, chat, isSending } = HealthCoachState;

    // toggle the cards
    els.nudgeCard.hidden = view !== "nudge";
    els.chatCard.hidden = view !== "chat";

    // Nudge card content
    if (nudge) {
      els.nudgeHeadline.textContent = nudge.headline;
      els.nudgeBody.textContent = nudge.body;
      // Sprint 2.1: the watch nudge no longer commits the user to a specific
      // intervention (e.g., "Box Breathing") — instead, the CTA invites the
      // user into the negotiation phase, where Siri proposes options.
      els.nudgeCta.textContent = "Explore Recovery Options";
      els.nudgeCard.dataset.tone = nudge.tone || "supportive";
    }

    // Chat log
    els.chatLog.innerHTML = "";
    chat.forEach((msg) => {
      const div = document.createElement("div");
      div.className = `chat-bubble ${msg.role}`;
      div.textContent = msg.text;
      els.chatLog.appendChild(div);

      // Intervention card lives directly under the Siri bubble that
      // committed it. Sprint 3.1 fix: previously the card rendered on EVERY
      // siri turn whose response carried an `intervention` field, including
      // greeting / offered / negotiating — which surfaced a red "Box Breathing"
      // card before the user had agreed to anything. The card now renders ONLY
      // when (a) this is the latest siri turn AND (b) the conversation state
      // is `committed` or `checking_in` (the active-intervention window).
      const isLatestSiri = msg === chat[chat.length - 1];
      const isActiveInterventionState =
        HealthCoachState.intentState === "committed" ||
        HealthCoachState.intentState === "checking_in";
      if (msg.role === "siri" && msg.intervention && isLatestSiri && isActiveInterventionState) {
        const card = document.createElement("div");
        card.className = "intervention-card";
        const dur = msg.intervention.durationSec;
        const meta = dur >= 60 ? `${Math.round(dur / 60)} min · ${msg.intervention.type}`
          : `${dur} sec · ${msg.intervention.type}`;
        card.innerHTML = `
          <div class="iv-label">${escapeHtml(msg.intervention.label)}</div>
          <div class="iv-instructions">${escapeHtml(msg.intervention.instructions || "")}</div>
          <div class="iv-meta">${escapeHtml(meta)}</div>
        `;
        // If this is box breathing, inject the animated bubble visual
        if (msg.intervention.label === "Box Breathing") {
          const bubbleContainer = document.createElement("div");
          bubbleContainer.className = "breathing-bubble";
          // Add a text label inside the bubble
          bubbleContainer.innerHTML = `<span class="bubble-label"></span>`;
          card.appendChild(bubbleContainer);
        }
        // ---------------------------------

        // "I did it" button is only meaningful in the committed state.
        if (HealthCoachState.intentState === "committed") {
          const btn = document.createElement("button");
          btn.className = "iv-done";
          btn.textContent = "I did it";
          btn.addEventListener("click", () => {
            const logEntry = {
            time: new Date().toLocaleTimeString(),
            type: msg.intervention.label || "Clinical Intervention",
            status: "Completed"
            };
          HealthCoachState.activityLog.push(logEntry);
          console.log("Clinical Log Updated:", HealthCoachState.activityLog);
          sendChat("I did it");
          });
          card.appendChild(btn);
        }
        els.chatLog.appendChild(card);
      }

      // Quick-reply chips at checking_in state
      if (msg.role === "siri" && msg.quickReplies && msg === chat[chat.length - 1]) {
        const wrap = document.createElement("div");
        wrap.className = "quick-replies";
        msg.quickReplies.forEach((label) => {
          const b = document.createElement("button");
          b.textContent = label;
          b.addEventListener("click", () => sendChat(label));
          wrap.appendChild(b);
        });
        els.chatLog.appendChild(wrap);
      }
    });

    if (isSending) {
      const div = document.createElement("div");
      div.className = "chat-bubble system";
      // Now injecting a visual container PLUS the text
      div.innerHTML = `<div class="siri-waveform-dummy"></div> Siri is thinking…`;
      els.chatLog.appendChild(div);
    }
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function renderFooter() {
    const sig = HealthCoachState.signature;
    if (sig) {
      els.signaturePill.textContent = `signature: ${sig.stressLevel}`;
      els.signaturePill.dataset.level = sig.stressLevel;
    }
    if (HealthCoachState.intentState) {
      els.intentPill.hidden = false;
      els.intentPill.textContent = `intent: ${HealthCoachState.intentState}`;
      els.intentPill.dataset.state = HealthCoachState.intentState;
    } else {
      els.intentPill.hidden = true;
    }
    els.latencyPill.textContent =
      HealthCoachState.lastLatencyMs == null
        ? "latency: — ms"
        : `latency: ${HealthCoachState.lastLatencyMs} ms`;
  }

  // -----------------------------------------------------------
  // Event wiring
  // -----------------------------------------------------------
  els.hrvSlider.addEventListener("input", (e) => {
    
    const hrvValue = Number(e.target.value);
    
    // 1. Prepare the updated biometric object
    const updatedBiometric = { 
      ...HealthCoachState.biometric, 
      hrv: hrvValue 
    };
    // --- GAP 2 FIX: MEDICAL REDLINE ---
    if (hrvValue < 15) {
      setState({
        biometric: updatedBiometric,
        view: "chat", // Switch the watch screen to the chat view
        chat: [{
          role: "siri",
          text: "⚠️ CRITICAL ALERT: Your HRV is " + hrvValue + "ms. This indicates severe physiological strain. Please stop current activity and rest. Siri coaching is disabled for safety."
        }],
        intentState: "CRITICAL_REDLINE"
      });
      return; // EXIT the function: this prevents fetchNudge() from calling the AI
    }
    // ----------------------------------
    setState({
      biometric: {
        ...HealthCoachState.biometric,
        hrv: Number(e.target.value),
      },
    });
    fetchNudge();
  });

  function wireSegment(segmentEl, key) {
    segmentEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-value]");
      if (!btn) return;
      setState({
        biometric: {
          ...HealthCoachState.biometric,
          [key]: btn.dataset.value,
        },
      });
      fetchNudge();
    });
  }
  wireSegment(els.sleepSegment, "sleep");
  wireSegment(els.arousalSegment, "arousal");

  els.scenarios.forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = SCENARIOS[btn.dataset.scenario];
      if (!s) return;
      setState({
        biometric: { ...s },
        view: "nudge",
        chat: [],
        history: [],
        intentState: null,
        activeIntervention: null,
      });
      fetchNudge();
    });
  });

  els.nudgeCta.addEventListener("click", () => {
    setState({
      view: "chat",
      chat: [],
      history: [],
      intentState: null,
      activeIntervention: null,
    });
    fetchGreeting().then(() => {
      setTimeout(() => els.chatInput.focus(), 50);
    });
  });

  els.chatBack.addEventListener("click", () => {
    setState({ view: "nudge" });
  });

  els.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.chatInput.value.trim();
    if (!text) return;
    els.chatInput.value = "";
    sendChat(text);
  });

  // els.exportBtn.addEventListener("click", exportMedicalReport);

  // Sprint 2.1 — Calendar dropdown wiring. Calendar context is independent of
  // the biometric scenarios, so Quick-Inject buttons should NOT reset it.
  if (els.calendarSelect) {
    els.calendarSelect.addEventListener("change", (e) => {
      setState({ calendarEvent: e.target.value });
    });
  }

  // Sprint 2.1 — Microphone affordance. Voice input is intentionally
  // simulated; we surface a temporary tooltip so testers know to type.
  let micTooltipTimer = null;
  if (els.chatMic && els.chatMicTooltip) {
    els.chatMic.addEventListener("click", () => {
      els.chatMicTooltip.classList.add("show");
      clearTimeout(micTooltipTimer);
      micTooltipTimer = setTimeout(() => {
        els.chatMicTooltip.classList.remove("show");
      }, 2500);
      // Keep keyboard focus on the input so the user can immediately type.
      if (els.chatInput) els.chatInput.focus();
    });
  }

  // Phase 3 Polish wiring
  if (els.interviewNoteBtn) {
    els.interviewNoteBtn.addEventListener("click", captureInterviewNote);
  }
  if (els.modalClose) {
    els.modalClose.addEventListener("click", closeReportModal);
  }
  if (els.reportModal) {
    els.reportModal.addEventListener("click", (e) => {
      if (e.target.dataset && e.target.dataset.modalDismiss !== undefined) {
        closeReportModal();
      }
    });
  }
  if (els.modalDownload) {
    els.modalDownload.addEventListener("click", downloadLastReport);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.reportModal && !els.reportModal.hidden) closeReportModal();
  });

  // -----------------------------------------------------------
  // Boot
  // -----------------------------------------------------------
  function tickWatchClock() {
    const now = new Date();
    let h = now.getHours();
    const m = now.getMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "" : "";
    h = ((h + 11) % 12) + 1;
    els.watchTime.textContent = `${h}:${m}${ampm}`;
  }
  tickWatchClock();
  setInterval(tickWatchClock, 30000);

  // Sprint 3.2: Trigger personalization before the first render
  runOnboarding(); 
  
  render();
  fetchNudge();

// Sprint 3.3: Clinical Export Logic
  // Connects the 'Export' button to the activity log
  document.getElementById('export-btn').addEventListener('click', () => {
    const log = HealthCoachState.activityLog;
    const analysisElement = document.getElementById('signature-analysis');
    
    if (!log || log.length === 0) {
      analysisElement.innerText = "No clinical sessions recorded yet. Complete an intervention on the watch first.";
    } else {
      // Formats the log into a clean string for medical review
      const history = log.map(e => `[${e.time}] ${e.type}: ${e.status}`).join(' | ');
      analysisElement.innerText = "Clinical Session History: " + history;
    }
    
    // Reveal the report modal
    document.getElementById('report-modal').hidden = false;
    document.getElementById('report-modal').setAttribute('aria-hidden', 'false');
  });

  // Logic to close the Clinical Report Modal
  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('report-modal').hidden = true;
    document.getElementById('report-modal').setAttribute('aria-hidden', 'true');
  });

// Sprint 3.3: Unified Clinical Export Logic
  if (els.exportBtn) {
    els.exportBtn.onclick = async () => {
      // 1. Fetch the medical report data first
      await exportMedicalReport(); 

      // 2. Inject your activityLog into the modal's analysis box
      const log = HealthCoachState.activityLog;
      if (els.modalSignatureAnalysis) {
        if (!log || log.length === 0) {
          els.modalSignatureAnalysis.innerText = "No clinical sessions recorded yet.";
        } else {
          const history = log.map(e => `[${e.time}] ${e.type}`).join(' | ');
          els.modalSignatureAnalysis.innerText = "Clinical Session History: " + history;
        }
      }
    };
  }

  // Ensure the close button works
  if (els.modalClose) {
    els.modalClose.onclick = closeReportModal;
  }
  
  if (els.exportBtn) {
  els.exportBtn.onclick = async () => {
    await exportMedicalReport(); // Fetches server data
    const log = HealthCoachState.activityLog;
    if (els.modalSignatureAnalysis) {
      els.modalSignatureAnalysis.innerText = log.length > 0 
        ? "Clinical Session History: " + log.map(e => `[${e.time}] ${e.type}`).join(' | ')
        : "No clinical sessions recorded yet.";
    }
  };
}
  
})();
