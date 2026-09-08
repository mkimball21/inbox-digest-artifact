/**
 * Builds the digest JSON (schema defined in apps_script_digest_handoff.md)
 * and writes it to the "Inbox Reports" Drive folder, alongside the existing
 * .txt report for that date. Also drives the daily generation entry point
 * that hooks into the existing 4am trigger.
 *
 * Schema verified in this rebuild: buildDigestJson() was run against both
 * real reports and the result round-tripped through JSON.stringify/parse
 * with every required field present on every thread/message, and the
 * spansMultipleDays branch was confirmed with a constructed (non-real)
 * two-day thread — see /apps-script/VERIFICATION.md.
 */

const INBOX_REPORTS_FOLDER_ID = "1bZFXxjhcpSSYShN03YSiZbuhBIoqno5C";

/**
 * Pure function: report text in, digest object out. No Drive/network I/O,
 * so it's the same function under test in Node during this rebuild and in
 * Apps Script at runtime.
 *
 * @param {string} rawText
 * @param {string} generatedAtIso - pass this in rather than computing
 *   `new Date()` inside here, so the function stays pure/testable.
 */
function buildDigestJson(rawText, generatedAtIso) {
  const dateCovered = extractDateCovered(rawText);
  const { records, headerTotalEmails, headerTotalThreads } = parseReportText(rawText);
  const threads = groupIntoThreads(records);

  // M4 (ported from REVIEW.md): a zero-email day must still produce a valid,
  // clearly-shaped digest — never let the web app confuse "no report file"
  // with "report file exists, zero threads."
  const digestThreads = threads.map((t) => {
    const spansMultipleDays = t.messages.some((m) => m.timestampFull.slice(0, 10) !== dateCovered);
    return {
      threadId: t.threadId,
      subject: t.subject,
      messages: t.messages.map((m) => ({
        messageId: m.messageId,
        timestamp: m.timestampFull,
        from: m.fromDisplay,
        body: m.body,
        truncated: m.truncated,
        lowText: m.lowText,
      })),
      summary: null,
      // C1 (ported): "skipped-low-text" and "pending" are distinct statuses
      // the UI branches on — never inferred from summary being null.
      summaryStatus: t.allLowText ? "skipped-low-text" : "pending",
      summaryError: null,
      spansMultipleDays,
    };
  });

  return {
    date: dateCovered,
    generatedAt: generatedAtIso,
    totalEmails: headerTotalEmails,
    totalThreads: headerTotalThreads,
    threads: digestThreads,
  };
}

/**
 * Entry point to hook into the existing 4am trigger.
 *
 * Call this ONE of two ways:
 *
 *   A) Preferred (per the handoff) — at the end of your existing report
 *      function, right after it saves the .txt to Drive, call:
 *        generateDigestForDate(dateStr, rawReportText);
 *      reusing the date string and report text your existing code already
 *      has in scope. This avoids re-reading the .txt back from Drive.
 *
 *   B) Decoupled fallback — a SEPARATE time-driven trigger (e.g. 4:10am,
 *      ten minutes after the existing one) that calls:
 *        generateDigestForDate();
 *      with no arguments. This reads yesterday's .txt back from Drive
 *      itself. Use this if you'd rather not touch the existing function's
 *      body at all, or if AS1's combined-runtime concern turns out to be
 *      real on your account (see VERIFICATION.md's note on this — it is
 *      UNVERIFIED in real Apps Script, only Node's fetch concurrency was
 *      measured).
 *
 * Either way, one bad thread's summarization failure never aborts the
 * whole run — REVIEW.md's broader theme (a failure must be visible in the
 * output, never silent) applies here via summaryStatus/summaryError on
 * that one thread.
 *
 * @param {string=} dateStr - "YYYY-MM-DD". Defaults to yesterday in the
 *   script's timezone.
 * @param {string=} rawReportText - if omitted, reads
 *   daily_inbox_report_<dateStr>.txt from the Inbox Reports folder.
 */
function generateDigestForDate(dateStr, rawReportText) {
  const tz = Session.getScriptTimeZone();

  if (!dateStr) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = Utilities.formatDate(yesterday, tz, "yyyy-MM-dd");
  }

  const folder = DriveApp.getFolderById(INBOX_REPORTS_FOLDER_ID);

  if (!rawReportText) {
    const txtFileName = `daily_inbox_report_${dateStr}.txt`;
    const files = folder.getFilesByName(txtFileName);
    if (!files.hasNext()) {
      throw new Error(`No report file found for ${dateStr}: ${txtFileName}`);
    }
    rawReportText = files.next().getBlob().getDataAsString("UTF-8");
  }

  const generatedAtIso = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
  const digest = buildDigestJson(rawReportText, generatedAtIso);

  // Summarize every thread that needs it (Summarize.gs). Each thread's
  // outcome — including a real failure — is written back into the digest
  // object before it's saved, per AS8 (silent-failure hazard).
  summarizeDigestThreads(digest);

  const jsonFileName = `digest_${dateStr}.json`;
  writeDigestJsonToDrive(folder, jsonFileName, digest);

  return digest;
}

/**
 * Overwrites any existing digest_<date>.json — used both by the daily
 * trigger and by the web app's manual "regenerate" action (AS8).
 */
function writeDigestJsonToDrive(folder, fileName, digest) {
  const jsonText = JSON.stringify(digest);
  const existing = folder.getFilesByName(fileName);
  if (existing.hasNext()) {
    const file = existing.next();
    file.setContent(jsonText);
    // Guard against a duplicate-named file left over from a previous bug —
    // never silently pick "whichever one" on the next read.
    while (existing.hasNext()) {
      existing.next().setTrashed(true);
    }
  } else {
    folder.createFile(fileName, jsonText, MimeType.PLAIN_TEXT);
  }
}

/**
 * Manual regenerate action exposed to the web app (AS8) — re-runs the full
 * pipeline for a date the user is currently looking at, e.g. after a
 * partial/failed 4am run.
 */
function regenerateDigestForDate(dateStr) {
  return generateDigestForDate(dateStr);
}
