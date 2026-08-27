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
// the fixed max_tokens: 1000 cap while still letting more than one small
// thread share a batch. SUMMARY_BATCH_MAX_THREADS is a secondary cap.
// Concurrency starts at 3 (not 4) and steps down toward 1 if 429/529
// responses are observed (H4's "untested" concurrency risk).
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

async function storageSet(key, value) {
  try {
    await window.storage.set(key, value);
  } catch (err) {
    console.error("digest: storage write failed for", key, err);
  }
}

function cacheKeyForDate(date) {
  return `digest:${date}`;
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

  return {
    messageId,
    threadId,
    timestampFull: (fields["Timestamp"] || "").trim(),
    subject: (fields["Subject"] || "(no subject)").trim(),
    fromDisplay: fromDisplay || "(unknown sender)",
    fromName,
    fromEmail,
    bodyLength: parseInt(fields["Body Length"] || "0", 10) || 0,
    truncated: (fields["Truncated"] || "").trim().toLowerCase() === "yes",
    lowText: body === LOW_TEXT_PLACEHOLDER,
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

window.__test = window.__test || { fetchReportCalls: 0, gmailActionCalls: [], summarizeCalls: 0 };

async function fetchAvailableDates() {
  return ["2026-08-25", "2026-08-24"];
}

async function fetchReportForDate(date) {
  window.__test.fetchReportCalls++;
  if (date !== "2026-08-25") return null;
  const res = await fetch("/daily_inbox_report_2026-08-25.txt");
  return res.text();
}

// ---------------------------------------------------------------------------
// Summarization (section 4; H3, H4)
// ---------------------------------------------------------------------------

async function summarizeAllThreads(threads, onThreadDone) {
  window.__test.summarizeCalls++;
  for (const t of threads) {
    await new Promise((r) => setTimeout(r, 5));
    onThreadDone(t.threadId, {
      status: "done",
      summary: `[test summary] ${t.messages.length} message(s), subject "${t.subject}".`,
    });
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
 * actually confirms were acted on (via mcp_tool_use blocks naming that exact
 * tool + messageId) vs which are unconfirmed/failed — a network or parse
 * failure marks its whole chunk as failed rather than assumed-successful.
 */
async function runGmailLabelAction(actionKey, messageIds) {
  window.__test.gmailActionCalls.push({ actionKey, messageIds: [...messageIds] });
  await new Promise((r) => setTimeout(r, 5));
  return { succeeded: new Set(messageIds), failed: new Set() };
}

async function fetchFullBody(messageId) {
  await new Promise((r) => setTimeout(r, 5));
  return `[test full body for ${messageId}] `.repeat(50);
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
      storageSet(cacheKeyForDate(date), { threads: nextThreads, savedAt: Date.now() });
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

      if (cached && Array.isArray(cached.threads)) {
        // Requirement 6: a second load of an already-generated date renders
        // instantly with no re-fetch and no re-summarization.
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

        {status === "ready" && threads.length > 0 && (
          <>
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
                          <div className="digest-mono" style={{ color: COLORS.textSecondary, fontSize: "0.85rem", marginTop: "0.15rem" }}>
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
          </>
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
