// Phase 2/3 (and the repeatable regression test for task #5): runs the
// REAL, unmodified summarization pipeline straight out of inbox-digest.jsx
// (planSummaryBatches -> summarizeAllThreads -> summarizeChunkAdaptive ->
// summarizeBatchRaw -> callMessagesAPI -> callWithRetry, at the real
// shipped MAX_TOKENS and concurrency) against the real Messages API for
// one or more real report files, and reports failure counts plus the real
// stop_reason/usage logged for every call.
//
// Usage: ANTHROPIC_API_KEY=... node test/live-verify.mjs <report1.txt> [report2.txt ...]
//
// Exit code is 0 only if every report produced zero failures; non-zero
// (and a clear listing of what failed and why) otherwise — this is what
// makes it usable as a regression gate on future changes, not just a
// one-off script.

import { loadCore, installLoggingFetch, loadReport } from "./live-api-lib.mjs";

async function verifyOneReport(core, reportPath) {
  const raw = loadReport(reportPath);
  const { records } = core.parseReportText(raw);
  const threads = core.groupIntoThreads(records);
  const needSummary = threads.filter((t) => t.summaryStatus === "pending");
  const skipped = threads.filter((t) => t.summaryStatus === "skipped-low-text");

  console.log(`\n=== ${reportPath} ===`);
  console.log(`${threads.length} threads total, ${needSummary.length} need summarizing, ${skipped.length} skipped (low-text)`);

  const results = new Map(); // threadId -> {status, summary?, error?}
  const startedAt = Date.now();

  await core.summarizeAllThreads(needSummary, (threadId, result) => {
    results.set(threadId, result);
  });

  const elapsedMs = Date.now() - startedAt;
  const done = [...results.values()].filter((r) => r.status === "done");
  const failed = [...results.entries()].filter(([, r]) => r.status === "error");

  console.log(`Completed in ${(elapsedMs / 1000).toFixed(1)}s: ${done.length} done, ${failed.length} failed (of ${needSummary.length})`);
  if (failed.length) {
    failed.forEach(([threadId, r]) => {
      const t = needSummary.find((x) => x.threadId === threadId);
      console.log(`  FAILED ${threadId} ("${t ? t.subject.slice(0, 60) : "?"}"): ${r.error}`);
    });
  }

  return { reportPath, threadCount: threads.length, needSummaryCount: needSummary.length, doneCount: done.length, failedCount: failed.length, elapsedMs };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY in the environment first.");
    process.exit(1);
  }
  const reportPaths = process.argv.slice(2);
  if (!reportPaths.length) {
    console.error("Usage: node test/live-verify.mjs <report1.txt> [report2.txt ...]");
    process.exit(1);
  }

  const core = loadCore();
  const { calls } = installLoggingFetch(apiKey);

  const summaries = [];
  for (const p of reportPaths) {
    summaries.push(await verifyOneReport(core, p));
  }

  console.log("\n=== ALL MESSAGES API CALLS (this run) — status / stop_reason / usage ===");
  calls.forEach((c, i) =>
    console.log(
      `  call ${i + 1}: status=${c.status} stop_reason=${c.stopReason ?? "(n/a)"} ` +
        `output_tokens=${c.usage ? c.usage.output_tokens : "?"} threadCount=${c.threadCount} maxTokens=${c.maxTokens}` +
        (c.errorType ? ` errorType=${c.errorType}` : "")
    )
  );

  console.log("\n=== SUMMARY ===");
  let allPassed = true;
  summaries.forEach((s) => {
    const pass = s.failedCount === 0;
    if (!pass) allPassed = false;
    console.log(`${pass ? "PASS" : "FAIL"}  ${s.reportPath}: ${s.doneCount}/${s.needSummaryCount} summarized, ${s.failedCount} failed, ${(s.elapsedMs / 1000).toFixed(1)}s`);
  });

  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
