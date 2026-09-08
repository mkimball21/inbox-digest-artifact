/**
 * Serves the web app and exposes the google.script.run server functions the
 * client-side JS in Index.html calls.
 *
 * VERIFICATION STATUS: this entire file is code-complete but NOT
 * live-verified. doGet/HtmlService/google.script.run only run inside a real
 * Apps Script web app deployment, which this coding session cannot reach
 * (see the split-responsibility plan in this build's history). Mason: this
 * is the first thing to test after deploying — see VERIFICATION.md's
 * "What you need to verify live, in order" checklist.
 */

function doGet(e) {
  const template = HtmlService.createTemplateFromFile("Index");
  return template
    .evaluate()
    .setTitle("Inbox Digest")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    // AS3/mobile: without this, a bookmarked /exec link can fail to render
    // correctly when opened outside the Apps Script editor's own preview.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Lists dates with a digest_YYYY-MM-DD.json already generated, newest
 * first — scans the Inbox Reports Drive folder rather than maintaining a
 * separate index.
 */
function listAvailableDates() {
  const folder = DriveApp.getFolderById(INBOX_REPORTS_FOLDER_ID);
  const files = folder.getFiles();
  const dates = [];
  while (files.hasNext()) {
    const name = files.next().getName();
    const m = name.match(/^digest_(\d{4}-\d{2}-\d{2})\.json$/);
    if (m) dates.push(m[1]);
  }
  dates.sort().reverse();
  return dates;
}

/**
 * Primary data call for a selected date. Returns the full digest JSON
 * (schema in apps_script_digest_handoff.md) plus real-time read/star state
 * per thread, or a typed not-found/empty marker — M4: a report that exists
 * but has zero threads is a DIFFERENT state from no report existing at all,
 * and the client must render a different message for each.
 *
 * PAYLOAD SIZE — flagged, not resolved, by real measurement in this
 * rebuild: the real Aug 25 (43-thread, busy day) digest JSON serializes to
 * ~207KB. That is a real number from real data, not an estimate, and it is
 * close enough to the handoff's called-out risk zone (200KB+) that it
 * should be the FIRST thing tested live. If a ~200KB+ google.script.run
 * response proves unreliable or slow in practice:
 *   1. Change this function to strip `body` out of each message before
 *      returning (keep messageId/timestamp/from/truncated/lowText/summary
 *      — everything needed for Contents+Summaries).
 *   2. Add a second client-side call, once, right after the first
 *      resolves: getFullBodiesForDate(date) → { [messageId]: body },
 *      which is used to populate the Full Emails section a beat later.
 *      The page can still render as one continuous scroll — the Full
 *      Emails section just fills in slightly after Contents/Summaries do.
 * Both functions' underlying data (the digest JSON already on Drive) is
 * unaffected either way — this is purely a decision about how much of it
 * crosses the google.script.run boundary in one call.
 */
function getDigestForDate(dateStr) {
  const folder = DriveApp.getFolderById(INBOX_REPORTS_FOLDER_ID);
  const fileName = `digest_${dateStr}.json`;
  const files = folder.getFilesByName(fileName);
  if (!files.hasNext()) {
    return { status: "not-found", date: dateStr };
  }

  const digest = JSON.parse(files.next().getBlob().getDataAsString("UTF-8"));

  if (!digest.threads || digest.threads.length === 0) {
    return { status: "empty", date: dateStr, generatedAt: digest.generatedAt };
  }

  const threadRefs = digest.threads.map((t) => ({
    threadId: t.threadId,
    messageIds: t.messages.map((m) => m.messageId),
  }));
  const readStarState = getReadStarStateForThreads(threadRefs);

  return { status: "ok", digest, readStarState };
}

/** Fallback split-call path — see the size note on getDigestForDate above. */
function getFullBodiesForDate(dateStr) {
  const folder = DriveApp.getFolderById(INBOX_REPORTS_FOLDER_ID);
  const fileName = `digest_${dateStr}.json`;
  const files = folder.getFilesByName(fileName);
  if (!files.hasNext()) return {};
  const digest = JSON.parse(files.next().getBlob().getDataAsString("UTF-8"));
  const bodies = {};
  digest.threads.forEach((t) => t.messages.forEach((m) => (bodies[m.messageId] = m.body)));
  return bodies;
}

/** AS8: manual retry for a failed/partial day, without touching the script directly. */
function regenerateDigest(dateStr) {
  const digest = regenerateDigestForDate(dateStr);
  const threadRefs = digest.threads.map((t) => ({
    threadId: t.threadId,
    messageIds: t.messages.map((m) => m.messageId),
  }));
  const readStarState = getReadStarStateForThreads(threadRefs);
  return { status: digest.threads.length ? "ok" : "empty", date: dateStr, digest, readStarState };
}
