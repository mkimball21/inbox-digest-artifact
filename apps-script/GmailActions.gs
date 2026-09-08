/**
 * Gmail read/star actions — native GmailApp calls exposed to the web app
 * via google.script.run. No MCP layer, no connector auth, no
 * mcp_tool_result pairing logic: each call is a direct, synchronous Apps
 * Script API call that either succeeds or throws. This is the single
 * biggest simplification in this rebuild — REVIEW.md's finding C2 (Gmail
 * "success" inferred from a tool being called, never from the actual
 * result) cannot recur here, because there is no model and no tool call in
 * this path at all.
 *
 * IMPORTANT — verification status of THIS file specifically: these
 * GmailApp calls themselves are code-complete but NOT live-verified,
 * because GmailApp only runs inside Apps Script's own execution context,
 * which this coding session cannot reach.
 *
 * What WAS verified, as an explicit stand-in (not the same code path):
 * using this session's live Gmail MCP connector against a real message
 * (19fbeca6904ee7fa, the Aug 1 "Your July Flow State recap" email):
 *   - Its real starting label state was fetched (["INBOX"] — read, unstarred).
 *   - The UNREAD label was added, and a re-fetch confirmed it stuck.
 *   - UNREAD was removed, re-fetch confirmed read again.
 *   - STARRED was added, re-fetch confirmed it stuck.
 *   - STARRED was removed, re-fetch confirmed back to the original
 *     ["INBOX"] state exactly — no lasting change was left on the real
 *     inbox.
 * This confirms Gmail's read/star state is backed by the UNREAD/STARRED
 * system labels — the same underlying mechanism GmailMessage.markRead() /
 * .markUnread() / .star() / .unstar() manipulate — and that toggling a
 * real message's state and reading it back actually works end-to-end
 * against this account. It does NOT confirm GmailApp's specific method
 * signatures behave identically; that requires a real Apps Script run.
 *
 * Also verified (read-only, no mutation): the real "[DIG] HVAC referral -
 * lower Bucks" thread (threadId 1a03a26a4fc841ef) has 6 distinct Message
 * IDs, and two of them were fetched independently and confirmed to carry
 * independent label state — i.e. a bulk "mark thread read" action MUST
 * loop over every message ID in the thread, never just the first or last.
 * markThreadRead/markThreadUnread/starThread/unstarThread below do exactly
 * that.
 *
 * See /apps-script/VERIFICATION.md for the full record.
 */

function markThreadRead(messageIds) {
  return runPerMessage_(messageIds, (msg) => msg.markRead());
}

function markThreadUnread(messageIds) {
  return runPerMessage_(messageIds, (msg) => msg.markUnread());
}

function starThread(messageIds) {
  return runPerMessage_(messageIds, (msg) => msg.star());
}

function unstarThread(messageIds) {
  return runPerMessage_(messageIds, (msg) => msg.unstar());
}

/**
 * Bulk "mark all read" — applies to EVERY thread on the page, including
 * starred ones. This is an explicit, deliberate decision carried over from
 * the original spec (starring a thread does not exempt it from bulk
 * mark-as-read), not an oversight.
 *
 * @param {string[]} allMessageIds - every message ID across every thread
 *   currently rendered on the page.
 */
function markAllRead(allMessageIds) {
  return runPerMessage_(allMessageIds, (msg) => msg.markRead());
}

/**
 * Applies `action` to each message ID individually and reports back which
 * ones actually succeeded vs. threw — never assumes success. Because this
 * is a direct Apps Script API call (not a model deciding whether to call a
 * tool), "the call didn't throw" IS the real confirmation of success, not
 * an inference — this is exactly the property C2 in REVIEW.md identified
 * as missing from the old MCP-based approach.
 *
 * @return {{succeeded: string[], failed: Array<{messageId: string, error: string}>}}
 */
function runPerMessage_(messageIds, action) {
  const succeeded = [];
  const failed = [];
  (messageIds || []).forEach((id) => {
    try {
      const msg = GmailApp.getMessageById(id);
      if (!msg) throw new Error("Message not found (deleted or moved?).");
      action(msg);
      succeeded.push(id);
    } catch (err) {
      failed.push({ messageId: id, error: String((err && err.message) || err) });
    }
  });
  return { succeeded, failed };
}

/**
 * Real-time read/star state for a set of threads, used on page load
 * (replaces the old artifact's "assume every thread starts unread"
 * fallback — that constraint was specific to the MCP layer's cost and does
 * NOT apply here; native GmailApp calls are cheap and direct).
 *
 * @param {Array<{threadId: string, messageIds: string[]}>} threadRefs
 * @return {Object<string, {isRead: boolean, isStarred: boolean}>} keyed by
 *   threadId. A thread's isRead is true only if EVERY message in it is
 *   read (mirrors Gmail's own inbox-list unread-count semantics); isStarred
 *   is true if ANY message in it is starred.
 */
function getReadStarStateForThreads(threadRefs) {
  const result = {};
  (threadRefs || []).forEach(({ threadId, messageIds }) => {
    let allRead = true;
    let anyStarred = false;
    let anyFound = false;
    messageIds.forEach((id) => {
      try {
        const msg = GmailApp.getMessageById(id);
        if (!msg) return;
        anyFound = true;
        if (msg.isUnread()) allRead = false;
        if (msg.isStarred()) anyStarred = true;
      } catch (err) {
        // A message that can no longer be fetched (deleted) shouldn't crash
        // the whole state fetch — it's simply excluded from this thread's
        // read/star computation.
      }
    });
    result[threadId] = anyFound ? { isRead: allRead, isStarred: anyStarred } : { isRead: false, isStarred: false };
  });
  return result;
}

/**
 * On-demand full (untruncated) body fetch, for a message whose digest JSON
 * `truncated` flag is true. Mirrors the old artifact's on-demand
 * truncated-body pattern, but via native GmailApp.getPlainBody() instead of
 * an MCP call.
 */
function getFullMessageBody(messageId) {
  const msg = GmailApp.getMessageById(messageId);
  if (!msg) throw new Error("Message not found (deleted or moved?).");
  return msg.getPlainBody();
}
