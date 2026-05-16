#!/usr/bin/env node
/**
 * Merge multiple chunked eval reports into a single full report.
 *
 * Reads all `dataset/eval-report-chunk-off*-lim*.json` files (sorted by offset),
 * concatenates the row arrays, recomputes the aggregate, writes a single final
 * `dataset/eval-report-full-merged-<ts>.json`.
 *
 * Used in the agent sandbox where each bash call has a 45s timeout, so the
 * 300-row eval has to be split into ~38 chunks of 8 rows each. On the user's
 * Mac the unchunked `npm run eval` is preferred — this is a sandbox utility.
 */

const fs = require("fs");
const path = require("path");

const datasetDir = path.join(__dirname, "..", "dataset");

// CLI: --prefix <str> (default: "eval-report-chunk-"), --out <filename>
const argv = process.argv.slice(2);
function arg(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fb;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const PREFIX = arg("prefix", "eval-report-chunk-");
const OUT_NAME = arg("out", null);

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function aggregate(results) {
  const total = results.length;
  const realFlow = results.filter((r) => r.category === "real_flow");
  const adv = results.filter((r) => r.category === "adversarial");
  const edge = results.filter((r) => r.category === "synthetic_edge");
  const coachLatencies = results.map((r) => r.coach.latencyMs);
  const tier1Caught = results.filter((r) => r.tier1.hallucinationCaught).length;
  const tier2Graded = results.filter((r) => r.tier2 && r.tier2.ok !== false);
  const tier2GradedHall = tier2Graded.filter((r) => r.tier2.hallucination === true).length;
  const correctnessScores = tier2Graded
    .filter((r) => typeof r.tier2.correctness === "number")
    .map((r) => r.tier2.correctness);
  const safetyFails = tier2Graded.filter((r) => r.tier2.safety === "fail").length;
  const fp = realFlow.filter((r) => r.tier1.looksLikeRefusal).length;
  const advRefused = adv.filter((r) => r.tier1.looksLikeRefusal).length;

  const byStratum = (cat) => {
    const set = results.filter((r) => r.category === cat);
    const t2 = set.filter((r) => r.tier2 && r.tier2.ok !== false);
    const scores = t2.filter((r) => typeof r.tier2.correctness === "number").map((r) => r.tier2.correctness);
    return {
      n: set.length,
      meanCorrectness: mean(scores),
      passRate_ge_2_5: scores.length ? scores.filter((s) => s >= 2.5).length / scores.length : null,
      hallucinationRate: t2.length ? t2.filter((r) => r.tier2.hallucination === true).length / t2.length : null,
      safetyFails: t2.filter((r) => r.tier2.safety === "fail").length,
      refusalRate: set.length ? set.filter((r) => r.tier1.looksLikeRefusal).length / set.length : null,
      coachP50_ms: percentile(set.map((r) => r.coach.latencyMs), 50),
      coachP95_ms: percentile(set.map((r) => r.coach.latencyMs), 95),
      fallbackRate: set.length ? set.filter((r) => r.coach.usedFallback).length / set.length : null,
    };
  };

  return {
    totalRows: total,
    counts: { real_flow: realFlow.length, synthetic_edge: edge.length, adversarial: adv.length },
    coachLatency: {
      p50_ms: percentile(coachLatencies, 50),
      p95_ms: percentile(coachLatencies, 95),
      mean_ms: Math.round(mean(coachLatencies) || 0),
      max_ms: Math.max(...coachLatencies),
    },
    hallucination: {
      tier1_caught: tier1Caught,
      tier1_caught_rate: total ? tier1Caught / total : null,
      tier2_judged_hallucinations: tier2GradedHall,
      tier2_judged_rate: tier2Graded.length ? tier2GradedHall / tier2Graded.length : null,
    },
    correctness: {
      mean: mean(correctnessScores),
      n: correctnessScores.length,
      passRate_ge_2_5: correctnessScores.length ? correctnessScores.filter((s) => s >= 2.5).length / correctnessScores.length : null,
    },
    safety: {
      tier2_fails: safetyFails,
      tier2_fail_rate: tier2Graded.length ? safetyFails / tier2Graded.length : null,
      adversarial_refusal_rate: adv.length ? advRefused / adv.length : null,
      false_positive_rate_real_flow: realFlow.length ? fp / realFlow.length : null,
    },
    coach: {
      fallback_rate: total ? results.filter((r) => r.coach.usedFallback).length / total : null,
    },
    byStratum: {
      real_flow: byStratum("real_flow"),
      synthetic_edge: byStratum("synthetic_edge"),
      adversarial: byStratum("adversarial"),
    },
  };
}

function main() {
  const files = fs
    .readdirSync(datasetDir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(".json"))
    .map((f) => {
      const m = f.match(/off(\d+)-lim(\d+)/);
      return { file: f, offset: m ? Number(m[1]) : 0, limit: m ? Number(m[2]) : 0 };
    })
    .sort((a, b) => a.offset - b.offset);

  if (files.length === 0) {
    console.error(`No chunk reports matching prefix "${PREFIX}" in ${datasetDir}`);
    process.exit(2);
  }

  console.log(`Merging ${files.length} chunk(s):`);
  for (const f of files) {
    console.log(`  ${f.file} (offset ${f.offset}, limit ${f.limit})`);
  }

  const allRows = [];
  let coachModel = null;
  let judgeModel = null;
  let datasetPath = null;
  for (const f of files) {
    const report = JSON.parse(fs.readFileSync(path.join(datasetDir, f.file), "utf8"));
    if (!coachModel) coachModel = report.meta.coachModel;
    if (!judgeModel) judgeModel = report.meta.judgeModel;
    if (!datasetPath) datasetPath = report.meta.datasetPath;
    for (const r of report.rows) {
      if (!r.error) allRows.push(r);
    }
  }

  const agg = aggregate(allRows);
  agg.coach.model = coachModel;
  agg.judge = { model: judgeModel };

  const merged = {
    meta: {
      generatedAt: new Date().toISOString(),
      datasetPath,
      coachModel,
      judgeModel,
      rowsRun: allRows.length,
      mergedFromChunks: files.length,
      sourceChunks: files.map((f) => f.file),
    },
    aggregate: agg,
    rows: allRows,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(datasetDir, OUT_NAME || `eval-report-full-merged-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
  console.log(`\nMerged ${allRows.length} rows → ${outPath}`);
  console.log("\n=== Aggregate ===");
  console.log(JSON.stringify(agg, null, 2));
}

main();
