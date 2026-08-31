// One-off diagnostic: re-sends the summarization prompt for a single named
// thread and prints the FULL raw response text plus the exact JSON.parse
// error location, so a malformed-JSON failure (not a max_tokens
// truncation) can be pinpointed precisely.
//
// Usage: ANTHROPIC_API_KEY=... node test/live-debug-one.mjs <report.txt> <threadId>

import { loadCore, installLoggingFetch, loadReport } from "./live-api-lib.mjs";

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY in the environment first.");
    process.exit(1);
  }
  const [reportPath, threadId] = process.argv.slice(2);
  if (!reportPath || !threadId) {
    console.error("Usage: node test/live-debug-one.mjs <report.txt> <threadId>");
    process.exit(1);
  }

  const core = loadCore();
  const { calls } = installLoggingFetch(apiKey);

  const raw = loadReport(reportPath);
  const { records } = core.parseReportText(raw);
  const threads = core.groupIntoThreads(records);
  const t = threads.find((x) => x.threadId === threadId);
  if (!t) {
    console.error("thread not found:", threadId);
    process.exit(1);
  }
  console.log("Thread:", t.subject, "| messages:", t.messages.length);

  try {
    const { summaries, truncated, stopReason } = await core.summarizeBatchRaw([t]);
    console.log(`\nsummarizeBatchRaw returned ${summaries.length} summaries (truncated=${truncated}, stopReason=${stopReason}):`);
    console.log(JSON.stringify(summaries, null, 2));
  } catch (e) {
    console.log("\nsummarizeBatchRaw threw (real HTTP/network failure):", e.message);
  }
  const last = calls[calls.length - 1];
  console.log("\nLogged call: status=", last?.status, "stop_reason=", last?.stopReason, "usage=", JSON.stringify(last?.usage));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
