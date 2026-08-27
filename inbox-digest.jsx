import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

// =============================================================================
// Inbox Digest — daily archive reader with inline Gmail actions
//
// Built from inbox_digest_handoff.md against the live Apps Script output
// (inbox_compilation_updated.gs — untouched; see H2 note below).
//
// H2 verification (performed before any other code was written, 2026-08-27):
// daily_inbox_report_2026-08-25.txt (209,969 bytes per Drive metadata) was
// fetched end-to-end via download_file_content, base64-decoded, and the
// decoded byte length matched Drive's reported file size exactly. All 62
// "===== EMAIL n OF 62 START/END =====" marker pairs were present, and the
// final marker "===== EMAIL 62 OF 62 END =====" was intact. Thread grouping
// was cross-checked against the real "[DIG] HVAC referral - lower Bucks"
// chain: 6 messages, 6 distinct Message IDs, one shared Thread ID
// (1a03a26a4fc841ef). No truncation occurred, so the H2 chunked-file
// fallback was NOT applied — the Apps Script is untouched.
// =============================================================================

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRIVE_MCP_URL = "https://drivemcp.googleapis.com/mcp/v1";
const GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
const MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;
const DRIVE_FOLDER_ID = "1bZFXxjhcpSSYShN03YSiZbuhBIoqno5C";

// H4: batches are sized to an ESTIMATED OUTPUT-TOKEN BUDGET (see
// planSummaryBatches / estimateThreadOutputTokens), not a flat thread count.
// A flat 5-threads-per-batch looked safe on paper but doesn't hold on real
// data. The estimator itself and this target were both calibrated
// 2026-08-27 against 47 real single-thread Messages API calls (see the
// comment above estimateThreadOutputTokens) — real per-thread output
// topped out at 828 tokens with p95=523, so 900 leaves real headroom under
// the fixed max_tokens: 1000 cap.
//
// IMPORTANT, decided 2026-08-27 (adversarial review finding M5): under
// these constants, planSummaryBatches produces a batch of exactly 1 thread
// on effectively every real call — verified both empirically (all 47
// batches on the two live-tested dates were singleton) AND by direct
// arithmetic (the minimum possible single-thread estimate, 640, already
// exceeds half of 900, so no two threads can ever combine). A materially
// looser, still-principled calibration was computed and tested against the
// same real 47-thread dataset before deciding this: even BASE lowered to
// match the real p75 (386) with TARGET raised to 950 (still real headroom
// under 1000) produced ZERO batching improvement (0% fewer calls) on the
// actual data — real adjacent thread pairs are rarely small enough
// together. Only a much more aggressive base (~250-300, below the real
// *median* of 209) produced meaningful batching (~30-40% fewer calls),
// which trades materially more reliance on the split/retry safety net for
// an uncertain, non-guaranteed win — exactly the kind of speculative
// retuning that caused the two prior rounds of failures. Given
// singleton-per-thread calling is proven reliable (0 failures across 47
// real calls on two real dates), this file keeps it as the real, deliberate
// behavior rather than gambling on a bigger loosening for unproven benefit.
// SUMMARY_BATCH_MAX_THREADS and the batching-by-token-budget structure are
// kept as-is (harmless, and correctly handle a future recalibration if
// real data ever justifies revisiting this). Concurrency starts at 3 (not
// 4) and steps down toward 1 if 429/529 responses are observed (H4's
// "untested" concurrency risk).
const SUMMARY_BATCH_MAX_THREADS = 5;
const SUMMARY_BATCH_TARGET_OUTPUT_TOKENS = 900; // headroom under the 1000 cap
const JSON_OVERHEAD_TOKENS_PER_THREAD = 40;
const SUMMARY_CONCURRENCY_DEFAULT = 3;
const SUMMARY_CONCURRENCY_MIN = 1;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

// H6: chunk bulk Gmail actions into small batches with mechanically-supplied
// IDs rather than one call per message or one giant call.
const GMAIL_BATCH_SIZE = 15;
const GMAIL_CONCURRENCY = 3;

const RECENT_DATE_CHIP_COUNT = 14;

// Archive-ledger design tokens (see "Design direction" in the handoff).
const COLORS = {
  bg: "#EDEEEA",
  text: "#23241F",
  textSecondary: "#6B6A63",
  accent: "#1D3557",
  signal: "#C98A2D",
  cardBorder: "#B4B2A9",
};

const GMAIL_ACTION_CONFIG = {
  markRead: { tool: "unlabel_message", labelIds: ["UNREAD"] },
  markUnread: { tool: "label_message", labelIds: ["UNREAD"] },
  star: { tool: "label_message", labelIds: ["STARRED"] },
  unstar: { tool: "unlabel_message", labelIds: ["STARRED"] },
};

const LOW_TEXT_PLACEHOLDER = "Low text content / possibly image-heavy email";
// Mirrors inbox_compilation_updated.gs's CONFIG.LOW_TEXT_THRESHOLD — see N1
// in the adversarial review for why this is used as a fallback alongside
// the exact placeholder-string match above.
const LOW_TEXT_THRESHOLD = 120;

// ---------------------------------------------------------------------------
// window.storage helpers (H7, H8)
//
// Storage lives at the artifact's URL and resets on republish (H7 — nothing
// to code around, just a fact to tell Mason). Reads throw on a missing key
// rather than returning null/undefined (H8) — every read is wrapped.
// window.storage is used exclusively; localStorage/sessionStorage are never
// referenced anywhere in this file.
// ---------------------------------------------------------------------------

async function storageGet(key) {
  try {
    const value = await window.storage.get(key);
    return value;
  } catch (err) {
    // H8: a throw here means "cache miss", not a real error.
    return undefined;
  }
}

// M3 (adversarial review, 2026-08-27): callers fire storageSet for the same
// key repeatedly in quick succession (once per thread completing during a
// summarization sweep) without awaiting each other. Left unserialized, an
// earlier write that happens to resolve later than a subsequent one could
// overwrite it, silently dropping already-shown data from the persisted
// cache. This keeps one pending-write chain per key so writes to the same
// key always apply in the order they were issued; different keys are
// unaffected and still run independently.
const pendingWritesByKey = new Map();

async function storageSet(key, value) {
  const previous = pendingWritesByKey.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {}) // a prior failure shouldn't block this write from attempting
    .then(async () => {
      try {
        await window.storage.set(key, value);
      } catch (err) {
        console.error("digest: storage write failed for", key, err);
      }
    });
  pendingWritesByKey.set(key, next);
  return next;
}

function cacheKeyForDate(date) {
  return `digest:${date}`;
}

// M1 (adversarial review, 2026-08-27): a bare `Array.isArray(cached.threads)`
// check says nothing about whether the objects INSIDE that array match the
// shape this version of the code expects. If a future edit changes the
// thread/message shape, an old cache entry could otherwise be loaded
// directly into state and crash the render for that date (no error
// boundary previously existed either — see ErrorBoundary below). Bumping
// this on any future breaking change to the persisted shape makes a
// mismatched old entry a clean cache miss instead.
const CACHE_SCHEMA_VERSION = 1;

function isValidCachedThreads(cached) {
  if (!cached || cached.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(cached.threads)) return false;
  return cached.threads.every(
    (t) =>
      t &&
      typeof t.threadId === "string" &&
      Array.isArray(t.messages) &&
      t.messages.length > 0 &&
      typeof t.summaryStatus === "string"
  );
}

// ---------------------------------------------------------------------------
// Base64 decoding (H1: only ever used on download_file_content output, never
// on read_file_content, which mangles/truncates content)
// ---------------------------------------------------------------------------

function decodeBase64Utf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// ---------------------------------------------------------------------------
// Report parsing (plain JS — the format is regular, no LLM involved)
// ---------------------------------------------------------------------------

/**
 * Parses one daily_inbox_report_YYYY-MM-DD.txt body into flat email records.
 *
 * Anchors strictly on the exact "===== EMAIL n OF m START/END =====" marker
 * lines rather than scanning for dashes, because quoted replies and ASCII
 * rules inside bodies can otherwise look like section delimiters.
 *
 * Only the DETAILED APPENDIX is parsed for data. The HEADER is read only for
 * the Total Emails / Total Threads counts (used for a sanity check); the
 * INVENTORY section is not parsed at all — its pipe-delimited sender field
 * is fragile and the appendix already carries everything it does.
 */
function parseReportText(rawText) {
  const headerMatch = rawText.match(/Total Emails:\s*(\d+)/);
  const threadHeaderMatch = rawText.match(/Total Threads:\s*(\d+)/);
  const headerTotalEmails = headerMatch ? parseInt(headerMatch[1], 10) : null;
  const headerTotalThreads = threadHeaderMatch ? parseInt(threadHeaderMatch[1], 10) : null;

  const blockRe = /===== EMAIL (\d+) OF (\d+) START =====\n([\s\S]*?)\n===== EMAIL \1 OF \2 END =====/g;
  const records = [];
  let match;
  while ((match = blockRe.exec(rawText)) !== null) {
    const record = parseEmailBlock(match[3]);
    if (record) records.push(record);
  }

  return { records, headerTotalEmails, headerTotalThreads };
}

function parseEmailBlock(blockText) {
  const lines = blockText.split("\n");
  const fields = {};
  let i = 0;

  // Consume "Key: value" metadata lines until the first blank line.
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      break;
    }
    const sep = line.indexOf(": ");
    if (sep === -1) {
      i++;
      continue;
    }
    fields[line.slice(0, sep).trim()] = line.slice(sep + 2);
    i++;
  }

  // Skip the literal "Body:" label line if present.
  if (lines[i] !== undefined && lines[i].trim() === "Body:") i++;

  const body = lines.slice(i).join("\n").trim();

  const messageId = (fields["Message ID"] || "").trim();
  const threadId = (fields["Thread ID"] || "").trim();
  if (!messageId || !threadId) return null; // malformed block, drop defensively

  const fromDisplay = (fields["From"] || "").trim();
  const { name: fromName, email: fromEmail } = parseFromDisplay(fromDisplay);

  const bodyLength = parseInt(fields["Body Length"] || "0", 10) || 0;

  return {
    messageId,
    threadId,
    timestampFull: (fields["Timestamp"] || "").trim(),
    subject: (fields["Subject"] || "(no subject)").trim(),
    fromDisplay: fromDisplay || "(unknown sender)",
    fromName,
    fromEmail,
    bodyLength,
    truncated: (fields["Truncated"] || "").trim().toLowerCase() === "yes",
    // N1 (adversarial review, 2026-08-27): the exact-string match against
    // LOW_TEXT_PLACEHOLDER is coupled to a literal defined separately in
    // inbox_compilation_updated.gs — if the two ever drift, this silently
    // stops detecting low-text bodies and a placeholder sentence could get
    // sent to summarization as if it were real content. bodyLength (the
    // report's own field, independent of the placeholder string) mirrors
    // the upstream script's own LOW_TEXT_THRESHOLD (120) as a fallback
    // signal that doesn't depend on the two literals staying in sync.
    lowText: body === LOW_TEXT_PLACEHOLDER || bodyLength < LOW_TEXT_THRESHOLD,
    body,
  };
}

function parseFromDisplay(display) {
  const angle = display.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1].trim();
    return { name: name || angle[2].trim(), email: angle[2].trim() };
  }
  return { name: display.trim() || "(unknown sender)", email: "" };
}

function stripReplyPrefix(subject) {
  let s = subject;
  let stripped = false;
  while (/^re:\s*/i.test(s)) {
    s = s.replace(/^re:\s*/i, "");
    stripped = true;
  }
  return stripped && s ? s : subject;
}

/**
 * Groups flat email records into threads by Thread ID (section 3 — NOT
 * Message ID; the two often differ even for a message's own row). Sorts
 * threads by earliest message and messages within a thread chronologically.
 */
function groupIntoThreads(records) {
  const byThread = new Map();
  records.forEach((rec) => {
    if (!byThread.has(rec.threadId)) byThread.set(rec.threadId, []);
    byThread.get(rec.threadId).push(rec);
  });

  const threads = [];
  byThread.forEach((messages, threadId) => {
    const sorted = [...messages].sort((a, b) =>
      a.timestampFull < b.timestampFull ? -1 : a.timestampFull > b.timestampFull ? 1 : 0
    );
    const earliest = sorted[0];

    const participants = [];
    const seen = new Set();
    sorted.forEach((m) => {
      const key = m.fromEmail || m.fromName;
      if (!seen.has(key)) {
        seen.add(key);
        participants.push(m.fromName || m.fromEmail || "(unknown sender)");
      }
    });

    const allLowText = sorted.every((m) => m.lowText);

    threads.push({
      threadId,
      subject: stripReplyPrefix(earliest.subject),
      messages: sorted,
      earliestTimestamp: earliest.timestampFull,
      participants,
      isRead: false, // section 7 (Decisions log #3): everything starts unread, no Gmail fetch-on-load
      isStarred: false,
      summary: null,
      summaryStatus: allLowText ? "skipped-low-text" : "pending",
      summaryError: null,
      actionError: null,
    });
  });

  threads.sort((a, b) =>
    a.earliestTimestamp < b.earliestTimestamp ? -1 : a.earliestTimestamp > b.earliestTimestamp ? 1 : 0
  );
  return threads;
}

function formatParticipantsLine(thread) {
  const count = thread.messages.length;
  if (count <= 1) return null;
  const names = thread.participants;
  const shown = names.slice(0, 2).join(", ");
  const rest = names.length - 2;
  const who = rest > 0 ? `${shown}, +${rest}` : shown;
  return `${count} messages · ${who}`;
}

function dayScopingLabel(thread) {
  const count = thread.messages.length;
  return `${count} message${count === 1 ? "" : "s"} on this date`;
}

// ---------------------------------------------------------------------------
// Messages API / MCP plumbing
//
// The artifact never calls Drive/Gmail directly — it asks the Claude
// Messages API to do so via the `mcp_servers` param, then reads the result
// back out of the response's `mcp_tool_result` content blocks. Response
// content mixes block types (`text`, `mcp_tool_use`, `mcp_tool_result`);
// every extraction here filters explicitly by `type`, never by array index.
// ---------------------------------------------------------------------------

async function callMessagesAPI({ userText, mcpServers, tools, toolChoice }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: userText }],
  };
  // H3, verified by construction: `mcp_servers` is only ever set when the
  // caller passes a non-empty array. Every summarization call in this file
  // passes `mcpServers: []`, so the key is omitted entirely from the request
  // body below — there is no code path where a summarization call can carry
  // any MCP server, Gmail included.
  if (mcpServers && mcpServers.length > 0) {
    body.mcp_servers = mcpServers;
  }
  // `tools` here is the ordinary Messages API structured-output mechanism
  // (a local JSON schema the model fills in) — unrelated to `mcp_servers`
  // and the H3 hazard. It grants the model no external capability at all,
  // only a formatting contract for its own reply. Summarization uses it to
  // get guaranteed-valid JSON back (see summarizeBatchRaw); it is never
  // combined with mcp_servers in the same request.
  if (tools) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  const res = await fetch(MESSAGES_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Messages API ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function callWithRetry(fn, { retries = 3, baseDelayMs = 800 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err && err.status;
      const isRetryableHttp = status !== undefined && RETRYABLE_STATUS_CODES.has(status);
      // A network-level fetch failure (dropped connection, transient DNS/TLS
      // hiccup) rejects with a plain TypeError and no .status — that's just
      // as transient as a 429/5xx and deserves the same retry treatment.
      const isNetworkError = !status && err instanceof TypeError;
      if (!(isRetryableHttp || isNetworkError) || attempt >= retries) throw err;
      const jitter = Math.random() * 200;
      const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt++;
    }
  }
}

function blocksByType(content, type) {
  return Array.isArray(content) ? content.filter((b) => b && b.type === type) : [];
}

function textFromMcpResultBlock(block) {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((c) => (c && c.type === "text" ? c.text : "")).join("");
  }
  if (block.output !== undefined) {
    return typeof block.output === "string" ? block.output : JSON.stringify(block.output);
  }
  return "";
}

/**
 * C2 (adversarial review, 2026-08-27): whether a paired mcp_tool_result
 * block indicates the underlying tool call actually failed. Calling a
 * tool (an mcp_tool_use block existing) is not the same as it succeeding
 * — the result block is the one that carries the real outcome. Checked
 * defensively against a few plausible field shapes (is_error being the
 * most standard, matching the ordinary tool_result content-block schema)
 * since this file's own live testing never exercised a real Gmail-side
 * failure to confirm the exact shape; see the note on runGmailLabelAction.
 */
function isMcpResultError(block) {
  if (!block) return true; // no paired result at all — can't confirm success, don't assume it
  if (block.is_error === true || block.isError === true) return true;
  const text = textFromMcpResultBlock(block);
  const parsed = tryParseJsonLoose(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.error || parsed.isError === true || parsed.is_error === true) return true;
  }
  return false;
}

function tryParseJsonLoose(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return undefined;
  }
}

function extractMcpToolResultJson(content, toolName) {
  const results = blocksByType(content, "mcp_tool_result");
  for (const block of results) {
    if (toolName && block.tool_name && block.tool_name !== toolName) continue;
    const parsed = tryParseJsonLoose(textFromMcpResultBlock(block));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Drive fetch (section 2)
// ---------------------------------------------------------------------------

async function fetchAvailableDates() {
  const data = await callWithRetry(() =>
    callMessagesAPI({
      userText:
        `Call the search_files tool exactly once with query: "title contains 'daily_inbox_report_' and parentId = '${DRIVE_FOLDER_ID}'" ` +
        `and pageSize 50. Do not describe, summarize, or list the results in your reply — only call the tool. Do not call any other tool.`,
      mcpServers: [
        {
          type: "url",
          url: DRIVE_MCP_URL,
          name: "drive",
          tool_configuration: { enabled: true, allowed_tools: ["search_files"] },
        },
      ],
    })
  );

  const json = extractMcpToolResultJson(data.content, "search_files");
  const files = (json && json.files) || [];
  const dates = files
    .map((f) => {
      const m = String(f.title || "").match(/daily_inbox_report_(\d{4}-\d{2}-\d{2})\.txt/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  return Array.from(new Set(dates)).sort().reverse();
}

/**
 * Returns the raw decoded report text for `date`, or null if no report
 * exists for that date (a clean empty state, not an error — section 1).
 */
async function fetchReportForDate(date) {
  const fileName = `daily_inbox_report_${date}.txt`;

  const searchData = await callWithRetry(() =>
    callMessagesAPI({
      userText:
        `Call the search_files tool exactly once with query: "title = '${fileName}' and parentId = '${DRIVE_FOLDER_ID}'". ` +
        `Do not describe or summarize the results in your reply — only call the tool. Do not call any other tool.`,
      mcpServers: [
        {
          type: "url",
          url: DRIVE_MCP_URL,
          name: "drive",
          tool_configuration: { enabled: true, allowed_tools: ["search_files"] },
        },
      ],
    })
  );

  const searchJson = extractMcpToolResultJson(searchData.content, "search_files");
  const files = (searchJson && searchJson.files) || [];
  if (!files.length) return null;

  const fileId = files[0].id;

  // H1: download_file_content only, never read_file_content.
  const downloadData = await callWithRetry(() =>
    callMessagesAPI({
      userText:
        `Call the download_file_content tool exactly once with fileId "${fileId}". ` +
        `Do not transcribe, describe, or summarize its content in your reply — only call the tool. Do not call any other tool.`,
      mcpServers: [
        {
          type: "url",
          url: DRIVE_MCP_URL,
          name: "drive",
          tool_configuration: { enabled: true, allowed_tools: ["download_file_content"] },
        },
      ],
    })
  );

  const downloadJson = extractMcpToolResultJson(downloadData.content, "download_file_content");
  if (!downloadJson || !downloadJson.content) {
    throw new Error("download_file_content returned no content block");
  }
  return decodeBase64Utf8(downloadJson.content);
}

// ---------------------------------------------------------------------------
// Summarization (section 4; H3, H4)
// ---------------------------------------------------------------------------

function buildSummaryPrompt(threadsBatch, { forceShort = false } = {}) {
  const parts = threadsBatch.map((t) => {
    const bodyText = t.messages
      .map(
        (m, mi) =>
          `Message ${mi + 1} of ${t.messages.length}${m.truncated ? " (TRUNCATED at 5000 characters)" : ""} — from ${m.fromDisplay} at ${m.timestampFull}:\n${m.body}`
      )
      .join("\n---\n");
    return `Thread (threadId: ${t.threadId}, subject: "${t.subject}"):\n${bodyText}`;
  });

  // forceShort is only used for a single-thread retry after that thread's
  // own summary alone overflowed the output budget (see
  // summarizeChunkAdaptive) — there's nothing left to split at that point,
  // so the ask changes from "25-50%" to "as much as fits."
  const lengthInstruction = forceShort
    ? '- This thread\'s full source is too long to summarize at 25-50% length within the available space — instead write the most complete, useful summary that fits, and end it with the exact text "[summary shortened due to length]".'
    : "- Is roughly 25-50% of that thread's combined source length by word count — a short source gets a short summary, a long/dense source gets a longer one. Do not pad short emails or force long ones down to a uniform length.";

  return (
    "You are writing digest summaries of email threads for someone who will read ONLY your summary, never the original. " +
    "For EACH thread below, write a summary that:\n" +
    "- Replaces the need to read the original: include concrete details, figures, actions, and deadlines explicitly.\n" +
    "- Covers every message in the thread, not just the first.\n" +
    "- Explicitly notes if any message in the thread was truncated at 5,000 characters.\n" +
    lengthInstruction +
    "\n" +
    "- Never invents content that is not in the source.\n\n" +
    "Threads:\n\n" +
    parts.join("\n\n=====\n\n") +
    "\n\n" +
    `Call submit_thread_summary once for each of the ${threadsBatch.length} thread(s) above (${threadsBatch.length} call(s) total), each with that thread's exact threadId.`
  );
}

// Local structured-output schema for summarization — see the H3 comment on
// callMessagesAPI's `tools` param. Forcing this tool via tool_choice means
// the model's reply is generated as a schema-conformant object by the API
// itself, not hand-typed JSON text — which is what H3's "parse defensively"
// approach in the original design could not prevent: a real failure seen in
// live verification (2026-08-27) was a well-formed-looking response that
// broke JSON.parse because the model quoted a phrase from the source
// ("...the commonly cited "300,000 property management companies" figure...")
// without escaping the inner quotes.
//
// The schema is deliberately FLAT (two plain string fields) and called once
// PER THREAD, rather than one call taking an array of {threadId, summary}
// objects — also live-verified, and for a subtler reason: with an array
// parameter, the model sometimes serialized the whole array as a JSON
// string value instead of using the nested-array type, reintroducing the
// exact same hand-typed-JSON escaping bug one level deeper (still
// live-reproduced with quotes inside quoted text). Two flat string fields
// give the model nothing to hand-serialize — Claude can and does call the
// same tool multiple times in one turn (see the note above
// summarizeBatchRaw's tool_use extraction), one call per thread.
const SUMMARY_TOOL = {
  name: "submit_thread_summary",
  description: "Submit the digest summary for ONE email thread. Call this once per thread you were given — for N threads, call it N times in this turn.",
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
// C1 (adversarial review, 2026-08-27): the floor below which a returned
// summary is treated as missing rather than done. Deliberately low — this
// isn't trying to judge quality, only to catch the degenerate empty/
// whitespace-only case a bare `typeof === "string"` check let through.
const MIN_SUMMARY_CHARS = 10;

/**
 * Estimates the output tokens one thread's summary will need, so batches can
 * be sized to the fixed max_tokens: 1000 budget (H4) instead of a flat
 * thread count.
 *
 * Calibrated 2026-08-27 against 47 REAL single-thread summary calls to the
 * live Messages API (not a mock), spanning a busy day (2026-08-25, 41
 * threads) and a quiet day (2026-08-01, 6 threads), each measured at a
 * generous non-truncating max_tokens so the true required length was
 * visible. Findings that shaped this formula:
 *
 * - Real output tokens ranged 71-828, with p75=386, p90=480, p95=523 — the
 *   828 case was a single outlier (a dense newsletter).
 * - combinedChars is a WEAK predictor (Pearson r=0.33): the largest thread
 *   in the sample, 32,039 combinedChars, only needed 349 real output
 *   tokens (most of those chars were unsubscribe links/tracking URLs the
 *   model correctly ignored), while a compact 1,515-char thread needed
 *   407. An earlier version of this formula (chars*0.5/4) scaled almost
 *   entirely off chars and was accordingly wrong in both directions: e.g.
 *   estimate=4045 vs real=349 for the 32k-char thread (a 12x overestimate
 *   that forced an unnecessary singleton batch) and estimate=58 vs
 *   real=102 for a very short one (an underestimate).
 *
 * So this is a generous flat base (comfortably above the observed p95),
 * plus a capped, deliberately minor char-based adjustment — not a tight
 * fit to this sample's exact shape, since batch content varies day to day.
 * Any single-thread miss is still caught by summarizeChunkAdaptive's
 * truncation-triggered split/retry (see below); this formula only needs to
 * be "usually right," not exact.
 *
 * Note (2026-08-27, decided in M5 of the adversarial review): at these
 * constants, planSummaryBatches ends up producing a batch of exactly one
 * thread on effectively every real call — the math is unambiguous (2 ×
 * the minimum possible estimate already exceeds the batch target), and a
 * looser, still-real-data-grounded calibration was computed and tested
 * without producing a meaningfully better result (see the CONFIG-section
 * comment above SUMMARY_BATCH_TARGET_OUTPUT_TOKENS for the numbers). This
 * is accepted as the real, deliberate behavior — one call per thread,
 * not per email — rather than an oversight; do not read this file's
 * function/section names ("batches", "chunk") as a claim that multiple
 * threads usually share a call in practice.
 */
const BASE_OUTPUT_TOKENS_PER_THREAD = 600; // comfortably above the observed p95 (523)
const CHAR_SCALING_RATE = 0.05; // minor secondary signal — correlation was weak (r=0.33)
const CHAR_SCALING_CAP = 400; // caps the char contribution so one very long thread doesn't force a needless singleton batch

function estimateThreadOutputTokens(thread) {
  const combinedChars = thread.messages.reduce((sum, m) => sum + (m.lowText ? 0 : m.body.length), 0);
  const charComponent = Math.min(combinedChars * CHAR_SCALING_RATE, CHAR_SCALING_CAP);
  return Math.ceil(BASE_OUTPUT_TOKENS_PER_THREAD + charComponent) + JSON_OVERHEAD_TOKENS_PER_THREAD;
}

/**
 * Builds variable-size batches bounded by SUMMARY_BATCH_TARGET_OUTPUT_TOKENS
 * (primary bound) and SUMMARY_BATCH_MAX_THREADS (secondary bound), instead
 * of a flat SUMMARY_BATCH_SIZE. This is the actual fix for the max_tokens
 * truncation bug — see the comment above estimateThreadOutputTokens.
 */
function planSummaryBatches(threads) {
  const batches = [];
  let current = [];
  let currentEstTokens = 0;

  for (const t of threads) {
    const est = estimateThreadOutputTokens(t);
    const wouldOverflow = currentEstTokens + est > SUMMARY_BATCH_TARGET_OUTPUT_TOKENS;
    const atCountLimit = current.length >= SUMMARY_BATCH_MAX_THREADS;
    if (current.length > 0 && (wouldOverflow || atCountLimit)) {
      batches.push(current);
      current = [];
      currentEstTokens = 0;
    }
    current.push(t);
    currentEstTokens += est;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * One batched call per chunk of threads. Never one call per email/thread.
 * Uses forced tool-use (SUMMARY_TOOL/SUMMARY_TOOL_CHOICE) rather than
 * asking the model to hand-write a JSON array as text — see the comment on
 * SUMMARY_TOOL for why: a live-verified failure (2026-08-27) showed the
 * model producing well-formed-looking output that still broke JSON.parse
 * because it quoted source text without escaping the inner quotes.
 * Structured tool output is generated by the API against a schema and
 * cannot have that failure mode.
 */
async function summarizeBatchRaw(threadsBatch, { forceShort = false } = {}) {
  const data = await callWithRetry(() =>
    callMessagesAPI({
      userText: buildSummaryPrompt(threadsBatch, { forceShort }),
      // H3, hard architectural rule: summarization calls attach NO MCP
      // server — not Gmail, not Drive, nothing. `mcpServers: []` above means
      // `callMessagesAPI` never sets `mcp_servers` on this request at all.
      mcpServers: [],
      tools: [SUMMARY_TOOL],
      toolChoice: SUMMARY_TOOL_CHOICE,
    })
  );
  // One tool_use block per thread (see the note on SUMMARY_TOOL for why
  // this is flat/per-thread rather than one call with an array). Each
  // block's `input.threadId` / `input.summary` are plain strings assembled
  // by the API's own JSON generation for the call, not hand-typed by the
  // model as freeform text, so they cannot carry the unescaped-quote bug
  // that broke the original text-based approach.
  //
  // Adversarial review finding C1 (2026-08-27): `typeof "" === "string"`,
  // so an empty (or whitespace-only) summary string previously passed this
  // filter unchanged and was accepted as a successful, "done" summary —
  // silently, with no error and no retry, since a valid-but-blank string
  // is indistinguishable from a real one by type alone. MIN_SUMMARY_CHARS
  // below routes anything that isn't a real, substantive summary into the
  // same "missing" path as a thread the model skipped entirely, so it goes
  // through the existing retry-then-error handling in
  // summarizeChunkAdaptive instead of silently succeeding.
  const toolUseBlocks = blocksByType(data.content, "tool_use").filter((b) => b.name === "submit_thread_summary");
  const summaries = toolUseBlocks
    .filter(
      (b) =>
        b.input &&
        typeof b.input.threadId === "string" &&
        typeof b.input.summary === "string" &&
        b.input.summary.trim().length >= MIN_SUMMARY_CHARS
    )
    .map((b) => ({ threadId: b.input.threadId, summary: b.input.summary }));

  // Deliberately never throws for "fewer summaries than threads requested"
  // — including zero. A multi-thread batch can overflow max_tokens after
  // some (not all) of its per-thread tool calls already landed
  // (live-verified: 2 of 3 came back before stop_reason: "max_tokens" cut
  // the 3rd short); the caller needs to know which threadIds are actually
  // missing and whether it was budget-related, not just get an exception.
  return { summaries, truncated: data.stop_reason === "max_tokens", stopReason: data.stop_reason };
}

/**
 * Summarizes one batch. Any threadId missing from the result (including a
 * fully-empty result) is retried — as a half-split if the WHOLE batch
 * overflowed max_tokens with nothing back (a batch that overflowed once
 * will overflow again unchanged, so only a smaller batch fixes it); as a
 * same-size retry of just the missing subset, bounded by `retriesLeft`,
 * for a partial miss (some threads' calls landed before the budget ran
 * out) or a non-truncated miss (the model simply skipped a thread). A
 * single thread that overflows on its own gets one retry asking for a
 * best-effort shortened summary instead of splitting further. Returns
 * { sawRateLimit } so the caller can step down concurrency across rounds
 * (H4).
 */
async function summarizeChunkAdaptive(threadsBatch, onThreadDone, opts = {}) {
  const { forceShort = false, retriesLeft = 2 } = opts;
  try {
    const { summaries, truncated } = await summarizeBatchRaw(threadsBatch, { forceShort });
    const byId = new Map(summaries.map((p) => [p.threadId, p.summary]));
    threadsBatch.forEach((t) => {
      if (byId.has(t.threadId)) onThreadDone(t.threadId, { status: "done", summary: byId.get(t.threadId) });
    });
    const missing = threadsBatch.filter((t) => !byId.has(t.threadId));
    if (missing.length === 0) return { sawRateLimit: false };

    if (truncated && missing.length === threadsBatch.length && threadsBatch.length > 1) {
      // N3 (adversarial review, 2026-08-27): retriesLeft is threaded
      // through here (it previously wasn't, silently resetting to the
      // default on every split). Splitting still can't loop forever
      // regardless — batch size strictly shrinks every time — but not
      // threading the budget through let a pathological batch accumulate
      // more total attempts across its split subtrees than retriesLeft by
      // itself would suggest.
      const mid = Math.ceil(threadsBatch.length / 2);
      const [a, b] = await Promise.all([
        summarizeChunkAdaptive(threadsBatch.slice(0, mid), onThreadDone, { forceShort, retriesLeft }),
        summarizeChunkAdaptive(threadsBatch.slice(mid), onThreadDone, { forceShort, retriesLeft }),
      ]);
      return { sawRateLimit: a.sawRateLimit || b.sawRateLimit };
    }
    if (truncated && threadsBatch.length === 1 && !forceShort) {
      return summarizeChunkAdaptive(threadsBatch, onThreadDone, { forceShort: true, retriesLeft });
    }
    if (retriesLeft > 0) {
      return summarizeChunkAdaptive(missing, onThreadDone, { forceShort, retriesLeft: retriesLeft - 1 });
    }
    missing.forEach((t) =>
      onThreadDone(t.threadId, {
        status: "error",
        error: `Thread ${t.threadId} was not present in the summary response after retries (stop_reason: ${truncated ? "max_tokens" : "other"}).`,
      })
    );
    return { sawRateLimit: false };
  } catch (err) {
    // callMessagesAPI/callWithRetry throw here only for real HTTP/network
    // failures — summarizeBatchRaw itself never throws (see above).
    const sawRateLimit = err.status === 429 || err.status === 529;
    if (retriesLeft > 0) {
      return summarizeChunkAdaptive(threadsBatch, onThreadDone, { forceShort, retriesLeft: retriesLeft - 1 });
    }
    threadsBatch.forEach((t) => onThreadDone(t.threadId, { status: "error", error: String(err.message || err) }));
    return { sawRateLimit };
  }
}

/**
 * Summarizes `threads` (already filtered to those needing it) in batches
 * planned by planSummaryBatches, running batches concurrently (H4) and
 * streaming each thread's result in via onThreadDone as soon as its batch
 * resolves — never blocking the whole view on the full set. Steps
 * concurrency down toward SUMMARY_CONCURRENCY_MIN, one step per round, if
 * 429/529 responses are observed.
 */
async function summarizeAllThreads(threads, onThreadDone) {
  const chunks = planSummaryBatches(threads);

  let concurrency = SUMMARY_CONCURRENCY_DEFAULT;
  let cursor = 0;

  while (cursor < chunks.length) {
    const round = chunks.slice(cursor, cursor + concurrency);
    const results = await Promise.all(round.map((chunk) => summarizeChunkAdaptive(chunk, onThreadDone)));
    const sawRateLimit = results.some((r) => r.sawRateLimit);

    if (sawRateLimit && concurrency > SUMMARY_CONCURRENCY_MIN) {
      concurrency -= 1;
    }
    cursor += round.length;
  }
}

// ---------------------------------------------------------------------------
// Gmail actions (section 6; H3, H6)
// ---------------------------------------------------------------------------

function buildGmailActionPrompt(tool, labelIds, messageIds) {
  // H3: only message IDs travel in this prompt — never subjects, senders, or
  // body text. The model is told exactly which IDs to act on; it never
  // chooses.
  return (
    `Call the tool "${tool}" once for EACH of the following Gmail message IDs, passing messageId set to that exact ID and labelIds set to ${JSON.stringify(labelIds)}. ` +
    `Call it exactly ${messageIds.length} time(s) total, once per ID listed below, and do not call it for any ID not listed here. Do not call any other tool. Do not add commentary.\n\n` +
    `Message IDs:\n${messageIds.map((id) => `- ${id}`).join("\n")}`
  );
}

/**
 * Fires a Gmail label/unlabel action for a flat list of message IDs, chunked
 * (H6) and run with bounded concurrency. Returns which IDs the response
 * actually confirms succeeded vs which are unconfirmed/failed.
 *
 * C2 (adversarial review, 2026-08-27): "confirms succeeded" now means the
 * matching mcp_tool_use block has a paired mcp_tool_result (via
 * tool_use_id) that doesn't indicate an error — not just that a
 * mcp_tool_use block naming that ID exists. The model calling the tool is
 * not the same as the tool succeeding; this file's own Drive-fetch path
 * already reads mcp_tool_result as the authoritative outcome
 * (extractMcpToolResultJson) — this brings the Gmail write path in line
 * with that same pattern instead of only checking tool_use presence. A
 * network/parse failure still marks the whole chunk failed rather than
 * assumed-successful.
 */
async function runGmailLabelAction(actionKey, messageIds) {
  const { tool, labelIds } = GMAIL_ACTION_CONFIG[actionKey];
  const chunks = [];
  for (let i = 0; i < messageIds.length; i += GMAIL_BATCH_SIZE) {
    chunks.push(messageIds.slice(i, i + GMAIL_BATCH_SIZE));
  }

  const succeeded = new Set();
  const failed = new Set();
  let cursor = 0;

  async function runChunk(chunk) {
    try {
      const data = await callWithRetry(() =>
        callMessagesAPI({
          userText: buildGmailActionPrompt(tool, labelIds, chunk),
          mcpServers: [
            {
              type: "url",
              url: GMAIL_MCP_URL,
              name: "gmail",
              // Only the single write tool this action needs is even exposed
              // to the model — extra H3 hardening on top of the prompt.
              tool_configuration: { enabled: true, allowed_tools: [tool] },
            },
          ],
        })
      );
      const calls = blocksByType(data.content, "mcp_tool_use").filter((b) => b.name === tool);
      const results = blocksByType(data.content, "mcp_tool_result");
      const resultByToolUseId = new Map(results.map((r) => [r.tool_use_id, r]));

      // Group calls by the message ID they targeted (normally 1:1 with the
      // requested IDs, but tolerate the model calling the same ID more than
      // once — succeed if ANY of its calls has a non-error paired result).
      const callsByMessageId = new Map();
      calls.forEach((c) => {
        const id = c.input && c.input.messageId;
        if (!id) return;
        if (!callsByMessageId.has(id)) callsByMessageId.set(id, []);
        callsByMessageId.get(id).push(c);
      });

      chunk.forEach((id) => {
        const callsForId = callsByMessageId.get(id) || [];
        const confirmed = callsForId.some((c) => !isMcpResultError(resultByToolUseId.get(c.id)));
        (confirmed ? succeeded : failed).add(id);
      });
    } catch (err) {
      chunk.forEach((id) => failed.add(id));
    }
  }

  async function worker() {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      await runChunk(chunk);
    }
  }

  const workers = Array.from({ length: Math.min(GMAIL_CONCURRENCY, chunks.length) }, () => worker());
  await Promise.all(workers);

  return { succeeded, failed };
}

/** H3: read-only call — Gmail MCP is attached with ONLY get_message allowed, no write tools in this request. */
async function fetchFullBody(messageId) {
  const data = await callWithRetry(() =>
    callMessagesAPI({
      userText:
        `Call the tool "get_message" exactly once with id "${messageId}" and messageFormat "PLAIN_TEXT". ` +
        `Do not transcribe, summarize, or comment on its content in your reply — only call the tool. Do not call any other tool.`,
      mcpServers: [
        {
          type: "url",
          url: GMAIL_MCP_URL,
          name: "gmail",
          tool_configuration: { enabled: true, allowed_tools: ["get_message"] },
        },
      ],
    })
  );
  const json = extractMcpToolResultJson(data.content, "get_message");
  if (!json) throw new Error("get_message returned no result");
  const body =
    typeof json === "string"
      ? json
      : json.body || json.plainTextBody || json.content || json.text;
  if (!body) throw new Error("get_message result had no recognizable body field");
  return body;
}

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

function StatusDot({ isRead }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle
        cx="5"
        cy="5"
        r="4"
        fill={isRead ? "none" : COLORS.signal}
        stroke={COLORS.signal}
        strokeWidth="1.5"
      />
    </svg>
  );
}

function StarIcon({ filled }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9-6.3 3.9 1.7-7-5.4-4.7 7.1-.6z"
        fill={filled ? COLORS.signal : "none"}
        stroke={COLORS.signal}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function scrollToRef(ref) {
  if (ref && ref.current) ref.current.scrollIntoView({ behavior: "smooth", block: "start" });
}

// M1 (adversarial review, 2026-08-27): with no error boundary anywhere,
// any render-time throw (a malformed cache entry that slipped past
// isValidCachedThreads, an unexpected data shape) previously unmounted the
// entire artifact to a blank/broken page. This contains a crash to just
// the date's content area and offers a way back out — clearing that one
// cached entry — rather than losing the whole app.
class DigestErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("digest: render error", error);
  }
  handleClearAndReload = () => {
    const key = this.props.cacheKey;
    (async () => {
      try {
        if (key) await window.storage.set(key, null);
      } catch (err) {
        // best-effort — window.storage may not support deleting a key at
        // all; a null value is still a safe, valid-looking "no cache" for
        // isValidCachedThreads to reject on the next load either way.
      }
      this.setState({ error: null });
      if (this.props.onClear) this.props.onClear();
    })();
  };
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: "#8B3A3A", padding: "3rem 1.5rem", textAlign: "center" }}>
          <p>Something went wrong rendering this date's digest.</p>
          <p
            className="digest-link"
            style={{ display: "inline-block", marginTop: "0.5rem" }}
            onClick={this.handleClearAndReload}
          >
            Clear this date's cache and try again
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function InboxDigest() {
  const [selectedDate, setSelectedDate] = useState("");
  const [status, setStatus] = useState("blank"); // blank | loading | ready | not-found | error
  const [errorMessage, setErrorMessage] = useState("");
  const [threads, setThreads] = useState([]);
  const [availableDates, setAvailableDates] = useState([]);
  const [markAllBusy, setMarkAllBusy] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);

  const contentsRef = useRef(null);
  const summariesRef = useRef(null);
  const fullEmailsRef = useRef(null);
  const topRef = useRef(null);
  const summaryRefsMap = useRef(new Map());
  const fullEmailRefsMap = useRef(new Map());

  function getSummaryRef(threadId) {
    if (!summaryRefsMap.current.has(threadId)) summaryRefsMap.current.set(threadId, React.createRef());
    return summaryRefsMap.current.get(threadId);
  }
  function getFullEmailRef(threadId) {
    if (!fullEmailRefsMap.current.has(threadId)) fullEmailRefsMap.current.set(threadId, React.createRef());
    return fullEmailRefsMap.current.get(threadId);
  }

  // H6: the known-good ID set every Gmail action is validated against before
  // firing. IDs only ever come from the parsed report to begin with, but
  // this filter is an explicit second gate rather than relying on that
  // being true by construction.
  const knownMessageIds = useMemo(
    () => new Set(threads.flatMap((t) => t.messages.map((m) => m.messageId))),
    [threads]
  );
  function validateIds(ids) {
    return ids.filter((id) => knownMessageIds.has(id));
  }

  // Best-effort archive listing so Mason isn't guessing which dates exist.
  // Failure here is silent-degrade: the date input still works standalone.
  useEffect(() => {
    let cancelled = false;
    fetchAvailableDates()
      .then((dates) => {
        if (!cancelled) setAvailableDates(dates);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onScroll() {
      setShowBackToTop(window.scrollY > 400);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const persistThreads = useCallback(
    (date, nextThreads) => {
      storageSet(cacheKeyForDate(date), { schemaVersion: CACHE_SCHEMA_VERSION, threads: nextThreads, savedAt: Date.now() });
    },
    []
  );

  const patchThread = useCallback(
    (threadId, patch) => {
      setThreads((prev) => {
        const next = prev.map((t) => (t.threadId === threadId ? { ...t, ...patch } : t));
        if (selectedDate) persistThreads(selectedDate, next);
        return next;
      });
    },
    [selectedDate, persistThreads]
  );

  const runSummarizationFor = useCallback(
    (date, threadsNeedingSummary) => {
      if (!threadsNeedingSummary.length) return;
      summarizeAllThreads(threadsNeedingSummary, (threadId, result) => {
        setThreads((prev) => {
          const next = prev.map((t) =>
            t.threadId === threadId
              ? { ...t, summaryStatus: result.status, summary: result.summary ?? t.summary, summaryError: result.error || null }
              : t
          );
          persistThreads(date, next);
          return next;
        });
      });
    },
    [persistThreads]
  );

  const handleSelectDate = useCallback(
    async (date) => {
      if (!date) return;
      setSelectedDate(date);
      setErrorMessage("");
      setThreads([]);
      setStatus("loading");
      summaryRefsMap.current = new Map();
      fullEmailRefsMap.current = new Map();

      const key = cacheKeyForDate(date);
      const cached = await storageGet(key);

      if (isValidCachedThreads(cached)) {
        // Requirement 6: a second load of an already-generated date renders
        // instantly with no re-fetch and no re-summarization. M1: a
        // schema-version mismatch or malformed entry is treated as a clean
        // cache miss here (falls through to a normal fetch below) rather
        // than being loaded and risking a render crash.
        setThreads(cached.threads);
        setStatus("ready");
        const stillPending = cached.threads.filter((t) => t.summaryStatus === "pending");
        if (stillPending.length) runSummarizationFor(date, stillPending); // resume an interrupted prior run only
        return;
      }

      try {
        const rawText = await fetchReportForDate(date);
        if (rawText === null) {
          setStatus("not-found");
          return;
        }
        const { records } = parseReportText(rawText);
        const grouped = groupIntoThreads(records);
        setThreads(grouped);
        setStatus("ready");
        persistThreads(date, grouped);

        const needSummary = grouped.filter((t) => t.summaryStatus === "pending");
        runSummarizationFor(date, needSummary);
      } catch (err) {
        setErrorMessage(String((err && err.message) || err));
        setStatus("error");
      }
    },
    [persistThreads, runSummarizationFor]
  );

  const handleRetrySummary = useCallback(
    (thread) => {
      patchThread(thread.threadId, { summaryStatus: "pending", summaryError: null });
      runSummarizationFor(selectedDate, [{ ...thread, summaryStatus: "pending" }]);
    },
    [patchThread, runSummarizationFor, selectedDate]
  );

  const handleToggleRead = useCallback(
    async (thread) => {
      const wasRead = thread.isRead;
      const ids = validateIds(thread.messages.map((m) => m.messageId));
      patchThread(thread.threadId, { isRead: !wasRead, actionError: null }); // optimistic
      try {
        const { failed } = await runGmailLabelAction(wasRead ? "markUnread" : "markRead", ids);
        if (failed.size > 0) {
          patchThread(thread.threadId, {
            isRead: wasRead,
            actionError: `Gmail sync failed for ${failed.size} of ${ids.length} message(s). Try again.`,
          });
        }
      } catch (err) {
        patchThread(thread.threadId, { isRead: wasRead, actionError: String((err && err.message) || err) });
      }
    },
    [patchThread, knownMessageIds] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleToggleStar = useCallback(
    async (thread) => {
      const wasStarred = thread.isStarred;
      const ids = validateIds(thread.messages.map((m) => m.messageId));
      patchThread(thread.threadId, { isStarred: !wasStarred, actionError: null }); // optimistic
      try {
        const { failed } = await runGmailLabelAction(wasStarred ? "unstar" : "star", ids);
        if (failed.size > 0) {
          patchThread(thread.threadId, {
            isStarred: wasStarred,
            actionError: `Gmail sync failed for ${failed.size} of ${ids.length} message(s). Try again.`,
          });
        }
      } catch (err) {
        patchThread(thread.threadId, { isStarred: wasStarred, actionError: String((err && err.message) || err) });
      }
    },
    [patchThread, knownMessageIds] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleMarkAllRead = useCallback(async () => {
    // Decisions log #1: applies to every thread, including starred ones —
    // starring is never an exemption from bulk mark-as-read.
    const targets = threads.filter((t) => !t.isRead);
    if (!targets.length) return;

    setMarkAllBusy(true);
    const previousRead = new Map(targets.map((t) => [t.threadId, t.isRead]));
    const idToThread = new Map();
    targets.forEach((t) => t.messages.forEach((m) => idToThread.set(m.messageId, t.threadId)));
    const allIds = validateIds(targets.flatMap((t) => t.messages.map((m) => m.messageId)));

    setThreads((prev) => {
      const next = prev.map((t) => (previousRead.has(t.threadId) ? { ...t, isRead: true, actionError: null } : t));
      if (selectedDate) persistThreads(selectedDate, next);
      return next;
    });

    try {
      const { failed } = await runGmailLabelAction("markRead", allIds);
      if (failed.size > 0) {
        const failedThreadIds = new Set(Array.from(failed).map((id) => idToThread.get(id)));
        setThreads((prev) => {
          const next = prev.map((t) =>
            failedThreadIds.has(t.threadId)
              ? { ...t, isRead: previousRead.get(t.threadId), actionError: "Gmail sync failed for some messages in this thread." }
              : t
          );
          if (selectedDate) persistThreads(selectedDate, next);
          return next;
        });
      }
    } catch (err) {
      setThreads((prev) => {
        const next = prev.map((t) =>
          previousRead.has(t.threadId) ? { ...t, isRead: previousRead.get(t.threadId), actionError: String((err && err.message) || err) } : t
        );
        if (selectedDate) persistThreads(selectedDate, next);
        return next;
      });
    } finally {
      setMarkAllBusy(false);
    }
  }, [threads, selectedDate, persistThreads, knownMessageIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoadFullBody = useCallback(
    async (threadId, messageId) => {
      setThreads((prev) =>
        prev.map((t) =>
          t.threadId === threadId
            ? { ...t, messages: t.messages.map((m) => (m.messageId === messageId ? { ...m, loadingFull: true, loadError: null } : m)) }
            : t
        )
      );
      try {
        const fullBody = await fetchFullBody(messageId);
        setThreads((prev) => {
          const next = prev.map((t) =>
            t.threadId === threadId
              ? {
                  ...t,
                  messages: t.messages.map((m) =>
                    m.messageId === messageId ? { ...m, body: fullBody, truncated: false, loadingFull: false } : m
                  ),
                }
              : t
          );
          if (selectedDate) persistThreads(selectedDate, next);
          return next;
        });
      } catch (err) {
        setThreads((prev) =>
          prev.map((t) =>
            t.threadId === threadId
              ? {
                  ...t,
                  messages: t.messages.map((m) =>
                    m.messageId === messageId ? { ...m, loadingFull: false, loadError: String((err && err.message) || err) } : m
                  ),
                }
              : t
          )
        );
      }
    },
    [selectedDate, persistThreads]
  );

  const unreadCount = threads.filter((t) => !t.isRead).length;
  const recentDates = availableDates.slice(0, RECENT_DATE_CHIP_COUNT);

  return (
    <div className="digest-root" style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text }}>
      <style>{`
        .digest-serif { font-family: Newsreader, Georgia, "Times New Roman", serif; }
        .digest-mono { font-family: "IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace; }
        .digest-card { background: #ffffff; border: 1px solid ${COLORS.cardBorder}; border-radius: 0.375rem; }
        .digest-card.is-read { opacity: 0.55; }
        .digest-link { color: ${COLORS.accent}; cursor: pointer; text-decoration: none; }
        .digest-link:hover { text-decoration: underline; }
        .digest-stamp {
          display: inline-block;
          transform: rotate(-6deg);
          border: 2px solid ${COLORS.accent};
          color: ${COLORS.accent};
          padding: 0.25rem 0.65rem;
          border-radius: 0.25rem;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          font-size: 0.7rem;
          white-space: nowrap;
        }
        .digest-chip {
          border: 1px solid ${COLORS.cardBorder};
          background: #ffffff;
          border-radius: 0.25rem;
          cursor: pointer;
        }
        .digest-chip:hover { border-color: ${COLORS.accent}; }
        .digest-input {
          border: 1px solid ${COLORS.cardBorder};
          background: #ffffff;
          border-radius: 0.25rem;
        }
        .digest-jumpbar { position: sticky; top: 0; z-index: 20; background: ${COLORS.bg}; border-bottom: 1px solid ${COLORS.cardBorder}; }
        .digest-backtotop { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 30; }
      `}</style>

      <div ref={topRef} />

      {/* Header */}
      <header className="flex items-start justify-between gap-4 p-6 flex-wrap">
        <div>
          <h1 className="digest-serif" style={{ fontSize: "1.75rem", margin: 0 }}>
            Inbox Digest
          </h1>
          <p style={{ color: COLORS.textSecondary, marginTop: "0.25rem" }}>
            One day of inbox, read as summaries — drop into full text only when it warrants it.
          </p>
        </div>
        {selectedDate && status === "ready" && (
          <div className="digest-stamp digest-mono">Archive · {selectedDate}</div>
        )}
      </header>

      {/* Date picker */}
      <div className="p-6 pt-0 flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="digest-date-input" style={{ color: COLORS.textSecondary }}>
            Date:
          </label>
          <input
            id="digest-date-input"
            type="date"
            className="digest-input digest-mono p-2"
            value={selectedDate}
            onChange={(e) => handleSelectDate(e.target.value)}
          />
        </div>
        {recentDates.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ color: COLORS.textSecondary, fontSize: "0.85rem" }}>Recent archives:</span>
            {recentDates.map((d) => (
              <button
                key={d}
                className="digest-chip digest-mono px-2 py-1"
                style={{ fontSize: "0.8rem" }}
                onClick={() => handleSelectDate(d)}
              >
                {d}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Body by status */}
      <main className="px-6 pb-24">
        {status === "blank" && (
          <div style={{ color: COLORS.textSecondary, padding: "3rem 0", textAlign: "center" }}>
            Pick a date above to generate its digest.
          </div>
        )}

        {status === "loading" && (
          <div style={{ color: COLORS.textSecondary, padding: "3rem 0", textAlign: "center" }}>
            Fetching and parsing the archive for {selectedDate}…
          </div>
        )}

        {status === "not-found" && (
          <div style={{ color: COLORS.textSecondary, padding: "3rem 0", textAlign: "center" }}>
            No report found for {selectedDate}.
          </div>
        )}

        {status === "error" && (
          <div style={{ color: "#8B3A3A", padding: "3rem 0", textAlign: "center" }}>
            Couldn't load {selectedDate}: {errorMessage}
          </div>
        )}

        {/* M4 (adversarial review, 2026-08-27): a real, working upstream
            code path (inbox_compilation_updated.gs writes "(no emails
            found)" / zero EMAIL blocks for a genuinely quiet day) produced
            a blank page here with no message — distinct from, and easily
            confused with, a broken load. This is a real report that
            parsed successfully to zero threads, not a missing report
            (that's the separate not-found state above). */}
        {status === "ready" && threads.length === 0 && (
          <div style={{ color: COLORS.textSecondary, padding: "3rem 0", textAlign: "center" }}>
            No emails in the archive for {selectedDate}.
          </div>
        )}

        {status === "ready" && threads.length > 0 && (
          <DigestErrorBoundary
            key={selectedDate}
            cacheKey={cacheKeyForDate(selectedDate)}
            onClear={() => {
              setSelectedDate("");
              setStatus("blank");
              setThreads([]);
            }}
          >
            {/* Sticky jump bar */}
            <div className="digest-jumpbar flex gap-4 py-3 mb-6">
              <span className="digest-link" onClick={() => scrollToRef(contentsRef)}>
                Contents
              </span>
              <span className="digest-link" onClick={() => scrollToRef(summariesRef)}>
                Summaries
              </span>
              <span className="digest-link" onClick={() => scrollToRef(fullEmailsRef)}>
                Full emails
              </span>
            </div>

            {/* Contents */}
            <section ref={contentsRef} className="mb-10">
              <h2 className="digest-serif" style={{ fontSize: "1.4rem" }}>
                Contents
              </h2>
              <ol className="flex flex-col gap-2 mt-3">
                {threads.map((t, idx) => (
                  <li key={t.threadId}>
                    <span className="digest-link" onClick={() => scrollToRef(getSummaryRef(t.threadId))}>
                      {idx + 1}. {t.subject}
                    </span>{" "}
                    <span className="digest-mono" style={{ color: COLORS.textSecondary, fontSize: "0.85rem" }}>
                      — {t.messages[0].fromDisplay} · {t.earliestTimestamp}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            {/* Summaries */}
            <section ref={summariesRef} className="mb-10">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h2 className="digest-serif" style={{ fontSize: "1.4rem", margin: 0 }}>
                  Summaries
                </h2>
                <button
                  className="digest-chip digest-mono px-3 py-1"
                  disabled={markAllBusy || unreadCount === 0}
                  onClick={handleMarkAllRead}
                  style={{ opacity: markAllBusy || unreadCount === 0 ? 0.5 : 1 }}
                >
                  {markAllBusy ? "Marking all read…" : `Mark all read (${unreadCount})`}
                </button>
              </div>

              <div className="flex flex-col gap-4">
                {threads.map((t, idx) => {
                  const participantsLine = formatParticipantsLine(t);
                  return (
                    <div
                      key={t.threadId}
                      ref={getSummaryRef(t.threadId)}
                      className={`digest-card p-4${t.isRead ? " is-read" : ""}`}
                    >
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleToggleRead(t)}
                              title={t.isRead ? "Mark unread" : "Mark read"}
                              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 0 }}
                            >
                              <StatusDot isRead={t.isRead} />
                            </button>
                            <span style={{ fontWeight: 600 }}>
                              {idx + 1}. {t.subject}
                            </span>
                          </div>
                          <div
                            className="digest-mono"
                            style={{
                              color: COLORS.textSecondary,
                              fontSize: "0.85rem",
                              marginTop: "0.15rem",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={`${t.messages[0].fromDisplay} · ${t.earliestTimestamp}`}
                          >
                            {t.messages[0].fromDisplay} · {t.earliestTimestamp}
                          </div>
                          {participantsLine && (
                            <div style={{ color: COLORS.textSecondary, fontSize: "0.8rem", marginTop: "0.15rem" }}>
                              {participantsLine}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => handleToggleStar(t)}
                          title={t.isStarred ? "Unstar" : "Star"}
                          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 0 }}
                        >
                          <StarIcon filled={t.isStarred} />
                        </button>
                      </div>

                      <div className="mt-3">
                        {t.summaryStatus === "pending" && (
                          <p style={{ color: COLORS.textSecondary, fontStyle: "italic" }}>Summarizing…</p>
                        )}
                        {t.summaryStatus === "skipped-low-text" && (
                          <p style={{ color: COLORS.textSecondary, fontStyle: "italic" }}>
                            No readable content — image-heavy or very short message(s).
                          </p>
                        )}
                        {t.summaryStatus === "error" && (
                          <div>
                            <p style={{ color: "#8B3A3A" }}>
                              Summary failed to generate.{" "}
                              <span className="digest-link" onClick={() => handleRetrySummary(t)}>
                                Retry
                              </span>
                            </p>
                            {t.summaryError && (
                              <p
                                className="digest-mono"
                                style={{ color: COLORS.textSecondary, fontSize: "0.75rem", marginTop: "0.25rem" }}
                              >
                                {t.summaryError}
                              </p>
                            )}
                          </div>
                        )}
                        {t.summaryStatus === "done" && <p style={{ lineHeight: 1.5 }}>{t.summary}</p>}
                      </div>

                      {t.actionError && (
                        <p style={{ color: "#8B3A3A", fontSize: "0.85rem", marginTop: "0.5rem" }}>{t.actionError}</p>
                      )}

                      <div className="flex gap-4 mt-3">
                        <span className="digest-link" style={{ fontSize: "0.85rem" }} onClick={() => scrollToRef(getFullEmailRef(t.threadId))}>
                          Read full email ↓
                        </span>
                        <span className="digest-link" style={{ fontSize: "0.85rem" }} onClick={() => scrollToRef(contentsRef)}>
                          Back to contents ↑
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Full emails */}
            <section ref={fullEmailsRef} className="mb-10">
              <h2 className="digest-serif" style={{ fontSize: "1.4rem" }}>
                Full emails
              </h2>
              <div className="flex flex-col gap-6 mt-3">
                {threads.map((t, idx) => (
                  <div key={t.threadId} ref={getFullEmailRef(t.threadId)} className="digest-card p-4">
                    <div className="flex items-baseline justify-between flex-wrap gap-2">
                      <h3 style={{ margin: 0, fontWeight: 600 }}>
                        {idx + 1}. {t.subject}
                      </h3>
                      <span className="digest-link" style={{ fontSize: "0.85rem" }} onClick={() => scrollToRef(getSummaryRef(t.threadId))}>
                        Back to summary ↑
                      </span>
                    </div>
                    <div style={{ color: COLORS.textSecondary, fontSize: "0.8rem", marginBottom: "0.75rem" }}>
                      {dayScopingLabel(t)} — the archive only covers messages received on {selectedDate}; a thread spanning other days shows partial history.
                    </div>

                    <div className="flex flex-col gap-4">
                      {t.messages.map((m) => (
                        <div key={m.messageId} style={{ borderTop: `1px solid ${COLORS.cardBorder}`, paddingTop: "0.75rem" }}>
                          <div className="digest-mono" style={{ fontSize: "0.8rem", color: COLORS.textSecondary }}>
                            {m.timestampFull} · {m.fromDisplay}
                          </div>
                          <div className="digest-mono" style={{ fontSize: "0.7rem", color: COLORS.textSecondary }}>
                            Message ID: {m.messageId} · Thread ID: {m.threadId}
                          </div>
                          <p style={{ marginTop: "0.5rem", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.body}</p>
                          {m.truncated && (
                            <div style={{ marginTop: "0.5rem" }}>
                              <span style={{ color: COLORS.signal, fontSize: "0.85rem" }}>
                                Body truncated at 5,000 characters —{" "}
                              </span>
                              <span
                                className="digest-link"
                                style={{ fontSize: "0.85rem" }}
                                onClick={() => handleLoadFullBody(t.threadId, m.messageId)}
                              >
                                {m.loadingFull ? "loading…" : "load full email"}
                              </span>
                              {m.loadError && <div style={{ color: "#8B3A3A", fontSize: "0.8rem" }}>{m.loadError}</div>}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </DigestErrorBoundary>
        )}
      </main>

      {showBackToTop && status === "ready" && (
        <button
          className="digest-backtotop digest-chip digest-mono px-3 py-2"
          onClick={() => scrollToRef(topRef)}
        >
          ↑ Top
        </button>
      )}
    </div>
  );
}
