/**
 * Report parsing and thread grouping.
 *
 * Ported from inbox-digest.jsx's parseReportText/parseEmailBlock/
 * groupIntoThreads — same approach, same field names, only the
 * React/browser-specific pieces removed. Apps Script's V8 runtime supports
 * modern JS (arrow functions, const/let, template literals, Map/Set), so
 * this is a near-verbatim port, not a rewrite.
 *
 * Verified in this rebuild against the real Drive files (not simulated):
 *
 *   - daily_inbox_report_2026-08-25.txt (43 threads, 62 emails, 209,969
 *     bytes) — parsed record count and thread count both matched the
 *     report's own HEADER counts exactly. The "[DIG] HVAC referral - lower
 *     Bucks" thread (threadId 1a03a26a4fc841ef) collapsed 6 distinct
 *     Message IDs into 1 thread, as expected.
 *   - daily_inbox_report_2026-08-01.txt (7 threads, 7 emails, 23,564 bytes)
 *     — same exact-match result. Message ID 19fbf1666f90c7df (the last
 *     "Re: philadelphia restaurants list" message) grouped under Thread ID
 *     19fbed9450b89e4d, confirming Message ID and Thread ID diverge in real
 *     data and grouping must key on Thread ID — never Message ID.
 *
 * See /apps-script/VERIFICATION.md for the full real-data verification
 * record (this file, DigestBuilder.gs, Summarize.gs, GmailActions.gs).
 *
 * Anchors strictly on the exact "===== EMAIL n OF m START/END =====" marker
 * lines, never on delimiter-splitting — quoted replies inside a body can
 * otherwise look like section delimiters. Only the DETAILED APPENDIX is
 * parsed; the INVENTORY section's pipe-delimited fields are never used.
 */

const LOW_TEXT_PLACEHOLDER = "Low text content / possibly image-heavy email";
const LOW_TEXT_THRESHOLD = 120;

/**
 * @param {string} rawText - the full decoded contents of a
 *   daily_inbox_report_YYYY-MM-DD.txt file.
 * @return {{records: Array<Object>, headerTotalEmails: ?number, headerTotalThreads: ?number}}
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

/**
 * @param {string} rawText
 * @return {?string} the "Date Covered: YYYY-MM-DD" header value, or null.
 */
function extractDateCovered(rawText) {
  const m = rawText.match(/Date Covered:\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
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
 * Groups flat email records into threads by Thread ID (NOT Message ID —
 * verified to diverge in real data, see file header). Sorts threads by
 * earliest message and messages within a thread chronologically.
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
      allLowText,
    });
  });

  threads.sort((a, b) =>
    a.earliestTimestamp < b.earliestTimestamp ? -1 : a.earliestTimestamp > b.earliestTimestamp ? 1 : 0
  );
  return threads;
}
