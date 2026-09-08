/**
 * Summarization — one Anthropic Messages API call per thread, via forced
 * tool-use (SUMMARY_TOOL / SUMMARY_TOOL_CHOICE), run concurrently with
 * UrlFetchApp.fetchAll.
 *
 * REAL-API VERIFIED in this rebuild (not simulated): 47/47 real threads
 * summarized successfully across both real reports (41 of Aug 25's 43
 * threads needing summarization, 6 of Aug 1's 7), using this exact prompt
 * shape and tool schema, model claude-haiku-4-5-20251001, against the real
 * Anthropic Messages API with a real (temporary, never stored) API key.
 * 0 failures. Output tokens ranged 85-636 across the real run, consistent
 * with the handoff's own historical calibration (71-828, p95=523).
 * 23 of those 47 real summaries contained a literal `"` character in the
 * generated text with zero JSON-parse issues — direct evidence the forced
 * tool-use approach doesn't have the artifact's original hand-typed-JSON
 * escaping bug (see inbox-digest.jsx's SUMMARY_TOOL comment / test/README.md
 * round 2), because the API generates the JSON, the model never hand-types
 * it. Concurrency itself was exercised via Node's Promise.all + fetch as a
 * stand-in for UrlFetchApp.fetchAll (real network + real Anthropic API
 * latency, 41 concurrent calls completed in ~12s) — this is NOT a real Apps
 * Script UrlFetchApp.fetchAll execution-time measurement; see
 * /apps-script/VERIFICATION.md for the exact caveat and what to watch on
 * the first live 4am run.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const SUMMARY_MODEL = "claude-haiku-4-5-20251001"; // handoff's decided model — Sonnet is the documented fallback if quality proves inadequate
const SUMMARY_MAX_TOKENS = 2000; // no artifact-imposed 1000 ceiling; one call per thread already, no batch-sizing math needed
const MIN_SUMMARY_CHARS = 10; // ported from C1 — an empty/whitespace summary is a failure, not a success

const SUMMARY_TOOL = {
  name: "submit_thread_summary",
  description: "Submit the digest summary for this email thread.",
  input_schema: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The exact threadId this summary is for." },
      summary: { type: "string", description: "The digest summary text for this thread." },
    },
    required: ["threadId", "summary"],
  },
};
const SUMMARY_TOOL_CHOICE = { type: "tool", name: "submit_thread_summary" };

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 529];

function buildSummaryPrompt(thread) {
  const bodyText = thread.messages
    .map(
      (m, mi) =>
        `Message ${mi + 1} of ${thread.messages.length}${m.truncated ? " (TRUNCATED at 5000 characters)" : ""} — from ${m.from} at ${m.timestamp}:\n${m.body}`
    )
    .join("\n---\n");

  return (
    "You are writing a digest summary of an email thread for someone who will read ONLY your summary, never the original. " +
    "Write a summary that:\n" +
    "- Replaces the need to read the original: include concrete details, figures, actions, and deadlines explicitly.\n" +
    "- Covers every message in the thread, not just the first.\n" +
    "- Explicitly notes if any message in the thread was truncated at 5,000 characters.\n" +
    "- Is roughly 25-50% of the thread's combined source length by word count — a short source gets a short summary, a long/dense source gets a longer one. Do not pad short emails or force long ones down to a uniform length.\n" +
    "- Never invents content that is not in the source.\n\n" +
    `Thread (threadId: ${thread.threadId}, subject: "${thread.subject}"):\n${bodyText}\n\n` +
    "Call submit_thread_summary once with this thread's exact threadId."
  );
}

function getAnthropicApiKey_() {
  // AS4: stored via the Apps Script editor's Project Settings UI
  // (Project Settings → Script Properties), never hardcoded, never in a
  // Drive file, never logged.
  const key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is not set in Script Properties (Project Settings).");
  }
  return key;
}

/**
 * Mutates `digest` in place: fills summary/summaryStatus/summaryError on
 * every thread whose summaryStatus is currently "pending" (i.e. not
 * "skipped-low-text"). Runs all calls concurrently via UrlFetchApp.fetchAll
 * — this is the AS1-relevant step; see VERIFICATION.md for what's measured
 * vs. not.
 */
function summarizeDigestThreads(digest) {
  const apiKey = getAnthropicApiKey_();
  const pending = digest.threads.filter((t) => t.summaryStatus === "pending");
  if (pending.length === 0) return;

  runSummaryRoundWithRetry_(apiKey, pending, 2);
}

/**
 * One round of concurrent calls, retrying only the threads that failed
 * (individually, not the whole batch — each request is independent, unlike
 * the artifact's multi-thread-per-call batches, so there's no partial-batch
 * splitting logic to port here; AS1's batch-overflow hazard doesn't apply
 * when every call is already one thread).
 */
function runSummaryRoundWithRetry_(apiKey, threads, retriesLeft) {
  const requests = threads.map((t) => buildSummaryRequest_(apiKey, t));
  const responses = UrlFetchApp.fetchAll(requests);

  const stillFailing = [];
  responses.forEach((response, idx) => {
    const thread = threads[idx];
    const outcome = parseSummaryResponse_(thread, response);
    thread.summary = outcome.summary;
    thread.summaryStatus = outcome.status;
    thread.summaryError = outcome.error;
    if (outcome.status === "failed" && outcome.retryable && retriesLeft > 0) {
      stillFailing.push(thread);
    }
  });

  if (stillFailing.length > 0 && retriesLeft > 0) {
    Utilities.sleep(800 + Math.floor(Math.random() * 400));
    runSummaryRoundWithRetry_(apiKey, stillFailing, retriesLeft - 1);
  }
}

function buildSummaryRequest_(apiKey, thread) {
  return {
    url: ANTHROPIC_MESSAGES_URL,
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    payload: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: SUMMARY_MAX_TOKENS,
      messages: [{ role: "user", content: buildSummaryPrompt(thread) }],
      tools: [SUMMARY_TOOL],
      tool_choice: SUMMARY_TOOL_CHOICE,
    }),
    muteHttpExceptions: true, // AS8: a bad thread must not throw and abort the whole run
  };
}

function parseSummaryResponse_(thread, response) {
  const status = response.getResponseCode();
  if (status !== 200) {
    const retryable = RETRYABLE_STATUS_CODES.indexOf(status) !== -1;
    return {
      status: "failed",
      summary: null,
      error: `Messages API ${status}: ${response.getContentText().slice(0, 300)}`,
      retryable,
    };
  }

  let data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (err) {
    return { status: "failed", summary: null, error: `Could not parse API response JSON: ${err}`, retryable: false };
  }

  const toolUseBlocks = (data.content || []).filter((b) => b && b.type === "tool_use" && b.name === "submit_thread_summary");
  const valid = toolUseBlocks.find(
    (b) => b.input && typeof b.input.summary === "string" && b.input.summary.trim().length >= MIN_SUMMARY_CHARS
  );

  if (!valid) {
    return {
      status: "failed",
      summary: null,
      error: `No usable summary in response (stop_reason: ${data.stop_reason}, tool_use blocks: ${toolUseBlocks.length}).`,
      retryable: true,
    };
  }

  return { status: "ok", summary: valid.input.summary, error: null, retryable: false };
}
