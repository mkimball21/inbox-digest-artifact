// Phase 1: calibration. Measures REAL output tokens for individual thread
// summaries at a generous, non-truncating max_tokens, using the real
// buildSummaryPrompt() straight out of inbox-digest.jsx, against the real
// Messages API. Prints (combinedChars, realOutputTokens, stopReason) for
// every thread across every report file given, plus a fitted calibration.
//
// Usage: ANTHROPIC_API_KEY=... node test/live-calibrate.mjs <report1.txt> [report2.txt ...]
//
// Never writes the API key anywhere; reads it once from the environment.

import { loadCore, installLoggingFetch, loadReport } from "./live-api-lib.mjs";

const CALIBRATION_MAX_TOKENS = 2200; // generous ceiling so nothing here truncates
const CONCURRENCY = 4;

/**
 * Fires one Messages API request directly at a caller-chosen max_tokens
 * (bypassing the shipped callMessagesAPI's hardcoded MAX_TOKENS), through
 * globalThis.fetch — which installLoggingFetch has wrapped — so this call
 * is logged identically to a real app call, and the real x-api-key header
 * gets attached the same way.
 */
async function calibrationCall(core, userText, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": "mcp-client-2025-04-04" },
    body: JSON.stringify({ model: core.MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: userText }] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Messages API ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY in the environment first.");
    process.exit(1);
  }
  const reportPaths = process.argv.slice(2);
  if (!reportPaths.length) {
    console.error("Usage: node test/live-calibrate.mjs <report1.txt> [report2.txt ...]");
    process.exit(1);
  }

  const core = loadCore();
  const { calls } = installLoggingFetch(apiKey);

  const allThreads = [];
  for (const p of reportPaths) {
    const raw = loadReport(p);
    const { records } = core.parseReportText(raw);
    const threads = core.groupIntoThreads(records);
    const needSummary = threads.filter((t) => t.summaryStatus === "pending");
    console.log(`${p}: ${threads.length} threads, ${needSummary.length} need summarizing`);
    needSummary.forEach((t) => allThreads.push({ ...t, __source: p }));
  }
  console.log(`\nCalibrating ${allThreads.length} threads individually at max_tokens=${CALIBRATION_MAX_TOKENS}...\n`);

  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < allThreads.length) {
      const t = allThreads[cursor++];
      const combinedChars = t.messages.reduce((sum, m) => sum + (m.lowText ? 0 : m.body.length), 0);
      const currentEstimate = core.estimateThreadOutputTokens(t);

      // NOTE: the real callMessagesAPI hardcodes max_tokens to the shipped
      // MAX_TOKENS constant (1000) — not useful for calibration, where we
      // need a generous, non-truncating ceiling. calibrationCall below
      // fires the request directly at CALIBRATION_MAX_TOKENS instead, but
      // still uses the real, unmodified buildSummaryPrompt() for the
      // prompt itself, and goes through the same installLoggingFetch
      // wrapper (global fetch), so it's still logged identically.
      const userText = core.buildSummaryPrompt([t]);
      let record;
      try {
        await core.callWithRetry(() => calibrationCall(core, userText, CALIBRATION_MAX_TOKENS));
      } catch (e) {
        record = { threadId: t.threadId, error: String(e.message || e) };
        results.push(record);
        continue;
      }

      const lastCall = calls[calls.length - 1];
      record = {
        threadId: t.threadId,
        source: t.__source,
        combinedChars,
        currentEstimate,
        realOutputTokens: lastCall && lastCall.usage ? lastCall.usage.output_tokens : null,
        stopReason: lastCall ? lastCall.stopReason : null,
        status: lastCall ? lastCall.status : null,
      };
      results.push(record);
      process.stdout.write(
        `  ${record.status === 200 ? "ok " : "ERR"} chars=${String(combinedChars).padStart(6)} ` +
          `estimate=${String(currentEstimate).padStart(5)} realTokens=${String(record.realOutputTokens).padStart(5)} ` +
          `stop=${record.stopReason}  (${t.subject.slice(0, 50)})\n`
      );
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, allThreads.length) }, () => worker());
  await Promise.all(workers);

  const clean = results.filter((r) => r.realOutputTokens != null && r.stopReason !== "max_tokens");
  const truncatedEvenAt2200 = results.filter((r) => r.stopReason === "max_tokens");
  console.log(`\n${clean.length}/${results.length} threads measured cleanly (not truncated even at ${CALIBRATION_MAX_TOKENS}).`);
  if (truncatedEvenAt2200.length) {
    console.log(`${truncatedEvenAt2200.length} threads truncated even at ${CALIBRATION_MAX_TOKENS} tokens:`, truncatedEvenAt2200.map((r) => r.threadId));
  }

  // Fit tokens ~= slope * chars + intercept via simple OLS, then report
  // percentile ratios of real/estimate so we can pick a conservative
  // (not tightly-fit) correction factor.
  const n = clean.length;
  const sumX = clean.reduce((s, r) => s + r.combinedChars, 0);
  const sumY = clean.reduce((s, r) => s + r.realOutputTokens, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  clean.forEach((r) => {
    num += (r.combinedChars - meanX) * (r.realOutputTokens - meanY);
    den += (r.combinedChars - meanX) ** 2;
  });
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanY - slope * meanX;

  const ratios = clean
    .filter((r) => r.currentEstimate > 0)
    .map((r) => r.realOutputTokens / r.currentEstimate)
    .sort((a, b) => a - b);
  const pct = (p) => ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))];

  console.log("\n=== CALIBRATION SUMMARY ===");
  console.log(`OLS fit:  realOutputTokens ≈ ${slope.toFixed(4)} * combinedChars + ${intercept.toFixed(1)}`);
  console.log(`Current estimator: chars*0.5/4 + 40  (i.e. slope=0.125, intercept=40)`);
  console.log(`real/currentEstimate ratio — min=${ratios[0]?.toFixed(2)} p25=${pct(0.25)?.toFixed(2)} median=${pct(0.5)?.toFixed(2)} p75=${pct(0.75)?.toFixed(2)} p90=${pct(0.9)?.toFixed(2)} max=${ratios[ratios.length - 1]?.toFixed(2)}`);
  console.log("\nRaw data points (chars, realTokens):");
  console.log(clean.map((r) => `[${r.combinedChars},${r.realOutputTokens}]`).join(", "));

  console.log("\n=== ALL MESSAGES API CALLS LOGGED (status/stop_reason/usage) ===");
  calls.forEach((c, i) => console.log(`  call ${i + 1}: status=${c.status} stop_reason=${c.stopReason} usage=${JSON.stringify(c.usage)} threadCount=${c.threadCount} maxTokens=${c.maxTokens}`));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
