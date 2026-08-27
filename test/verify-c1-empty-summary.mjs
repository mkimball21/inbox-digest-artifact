// Proves the C1 fix (empty/whitespace-only summary no longer silently
// accepted as done) against the REAL, unmodified summarization pipeline —
// summarizeAllThreads / summarizeChunkAdaptive / summarizeBatchRaw, sliced
// live out of inbox-digest.jsx, completely unchanged for this test. Only
// the network transport is faked, since provoking the real model into a
// degenerate empty response isn't reliably repeatable — this instead
// injects a synthetic API response containing an empty-string
// `submit_thread_summary` tool call and observes exactly what the real
// extraction/retry code does with it.
//
// No API key needed — this never touches the network.
//
// Three scenarios:
//   THREAD_EMPTY_THEN_VALID — returns "" on the first call, a real
//     summary on retry. Proves: the empty response does NOT get accepted
//     as done, the retry path fires, and the eventual real text wins.
//   THREAD_ALWAYS_EMPTY — returns "" on every call. Proves: it terminates
//     as a status "error" (not an infinite retry, not a false "done").
//   THREAD_NORMAL — a real, valid summary from the first call, batched
//     alongside the above. Proves: a good result in the same batch as a
//     bad one is unaffected — selectivity, not just "something changed."

import { loadCore } from "./live-api-lib.mjs";

const core = loadCore();

let callCount = 0;
const callLog = [];

globalThis.fetch = async function (url, options) {
  if (typeof url !== "string" || !url.includes("/v1/messages")) {
    throw new Error("verify-c1: unexpected non-Messages-API fetch — this test should never touch the network");
  }
  callCount++;
  const body = JSON.parse(options.body);
  const promptText = body.messages[0].content;
  const requestedIds = [...promptText.matchAll(/threadId: ([^,]+),/g)].map((m) => m[1]);
  callLog.push({ call: callCount, requestedIds: [...requestedIds] });

  const toolUseBlocks = requestedIds.map((id, i) => {
    let summaryText;
    if (id === "THREAD_EMPTY_THEN_VALID") {
      summaryText = callCount === 1 ? "" : "This is a valid, non-empty retry summary for THREAD_EMPTY_THEN_VALID.";
    } else if (id === "THREAD_ALWAYS_EMPTY") {
      summaryText = ""; // never becomes valid — should terminate as an error, not hang or false-succeed
    } else {
      summaryText = `Valid real summary text for ${id}, well over the minimum length.`;
    }
    return {
      type: "tool_use",
      id: `toolu_call${callCount}_${i}`,
      name: "submit_thread_summary",
      input: { threadId: id, summary: summaryText },
    };
  });

  const payload = { content: toolUseBlocks, stop_reason: "tool_use" };
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

function makeThread(threadId, subject) {
  return {
    threadId,
    subject,
    messages: [
      {
        fromDisplay: "Test Sender <test@example.com>",
        timestampFull: "2026-01-01 00:00:00",
        truncated: false,
        lowText: false,
        body: "A short test email body, long enough to not be flagged low-text by the real threshold check.",
      },
    ],
    summaryStatus: "pending",
  };
}

const threads = [
  makeThread("THREAD_EMPTY_THEN_VALID", "Returns empty on first call, valid on retry"),
  makeThread("THREAD_ALWAYS_EMPTY", "Always returns empty — must terminate as error"),
  makeThread("THREAD_NORMAL", "Returns a valid summary immediately"),
];

const events = []; // every onThreadDone invocation, in order
const finalByThread = new Map();

await core.summarizeAllThreads(threads, (threadId, result) => {
  events.push({ threadId, status: result.status, summary: result.summary, error: result.error });
  finalByThread.set(threadId, result);
});

console.log("=== call log ===");
callLog.forEach((c) => console.log(`  call ${c.call}: requested ${JSON.stringify(c.requestedIds)}`));

console.log("\n=== every onThreadDone event, in order ===");
events.forEach((e, i) =>
  console.log(`  ${i + 1}. ${e.threadId} -> status=${e.status} summary=${JSON.stringify(e.summary)} error=${e.error || ""}`)
);

console.log("\n=== assertions ===");
let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
  } else {
    console.log(`  FAIL: ${message}`);
    failures++;
  }
}

// The critical proof for C1: no event EVER reports "done" with a
// blank/whitespace-only summary. This is the exact bug — before the fix,
// call 1's empty string for THREAD_EMPTY_THEN_VALID would have produced
// exactly such an event.
const anyDoneWithBlankSummary = events.some((e) => e.status === "done" && (!e.summary || e.summary.trim().length === 0));
assert(!anyDoneWithBlankSummary, "no event ever reports status=done with a blank/whitespace-only summary");

// THREAD_EMPTY_THEN_VALID must have needed more than one call (proving the
// empty first response did NOT get accepted, forcing a retry) and must
// have ended up done with the real retried text.
assert(callCount > 1, "more than one Messages API call was made (proves a retry actually happened)");
const finalEmptyThenValid = finalByThread.get("THREAD_EMPTY_THEN_VALID");
assert(
  finalEmptyThenValid && finalEmptyThenValid.status === "done" && finalEmptyThenValid.summary.includes("valid, non-empty retry"),
  "THREAD_EMPTY_THEN_VALID ends up done with the real retried (non-empty) text"
);

// THREAD_ALWAYS_EMPTY must terminate as an error (not stuck retrying
// forever, not falsely marked done).
const finalAlwaysEmpty = finalByThread.get("THREAD_ALWAYS_EMPTY");
assert(
  finalAlwaysEmpty && finalAlwaysEmpty.status === "error",
  "THREAD_ALWAYS_EMPTY terminates as status=error, not done and not an infinite retry"
);

// THREAD_NORMAL should succeed on the very first call, proving a good
// result in the same batch as a bad one is unaffected by the fix.
const normalEvents = events.filter((e) => e.threadId === "THREAD_NORMAL");
assert(normalEvents.length === 1 && normalEvents[0].status === "done", "THREAD_NORMAL succeeds cleanly, unaffected by its batch-mates' problems");

console.log(`\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`} — total real Messages API calls made: ${callCount}`);
process.exit(failures === 0 ? 0 : 1);
