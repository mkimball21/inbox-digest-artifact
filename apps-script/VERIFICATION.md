# Verification record — Apps Script digest rebuild

Written under the split-responsibility plan: this coding session wrote and
tested all logic it could reach; deployment and live-environment testing
(Apps Script itself, the real web app, a real phone) are the user's to run.
No Apps Script API / clasp access was available in this session (see the
session history — clasp login was attempted, hit a real sandbox lifecycle
limitation, then a direct-token-exchange approach was attempted and
correctly blocked by this environment's own permission classifier when it
tried to write OAuth credentials to disk; that boundary was accepted, not
worked around).

Every claim below is labeled with exactly one of three levels — per your
instruction, these are never blurred together:

- **✅ FULLY VERIFIED** — real data and/or the real Anthropic API, exercised
  directly against the actual file that will be pasted into Apps Script.
- **🟡 LOGIC-VERIFIED VIA STAND-IN** — real data, real external state, but
  through a mechanism that is NOT the final code path (Node's `fetch`
  standing in for `UrlFetchApp`, the Gmail MCP connector standing in for
  `GmailApp`).
- **⚪ CODE-COMPLETE, NOT LIVE-VERIFIED** — the code exists and was read
  carefully, but nothing in this session could execute it, because it only
  runs inside a real Apps Script project/deployment.

## Build sequence, step by step

### 1. Report parsing — ✅ FULLY VERIFIED

`DigestParsing.gs`'s exact file content (not a paraphrase — the literal
file, executed) was run against both real files fetched from the "Inbox
Reports" Drive folder:

- `daily_inbox_report_2026-08-25.txt` — fetched via `download_file_content`
  (base64), decoded, and the decoded byte count matched Drive's reported
  file size **exactly** (209,969 bytes). Parsed 62/62 records, matching the
  header's `Total Emails: 62`; grouped into 43 threads, matching
  `Total Threads: 43`.
- `daily_inbox_report_2026-08-01.txt` — same exact-match round trip
  (23,564 bytes). Parsed 7/7 records, grouped into 7 threads.
- **A real bug was caught and fixed in this session's own process**: an
  initial hand-transcription of this file's base64 content produced a
  423-byte-short decode. It was only caught because of exactly this kind
  of byte-count check — the same discipline this file's own header
  describes. The file was re-fetched programmatically (extracted from this
  session's own tool-call transcript rather than retyped) and the byte
  count then matched exactly. This is direct, self-referential evidence for
  why the "verify against real data, not assumption" standard matters.
- Message ID vs. Thread ID divergence: message `19fbf1666f90c7df` (Aug 1,
  "Re: philadelphia restaurants list") groups under Thread ID
  `19fbed9450b89e4d` — confirmed not equal, confirming grouping must key on
  Thread ID.
- HVAC thread collapse: thread `1a03a26a4fc841ef` ("[DIG] HVAC referral -
  lower Bucks", Aug 25) correctly collapsed 6 distinct Message IDs into one
  thread.
- Low-text placeholder, truncated flag, and chronological-sort-within-thread
  were each checked against specific real records and passed.

### 2. Thread grouping + digest JSON writer — ✅ FULLY VERIFIED

`buildDigestJson()` (in `DigestBuilder.gs`) was run against both real
reports. Output was round-tripped through `JSON.stringify`/`JSON.parse` and
checked field-by-field against the handoff's schema — every thread and
message on every real record carried every required field, and
`summaryStatus` only ever took one of the four valid values. Thread/message
counts matched the header counts in both files.

The `spansMultipleDays` branch has no real example in either designated
report (neither Aug 25 nor Aug 1 happens to contain a thread crossing a
calendar boundary), so its true-branch was checked with one small,
explicitly constructed (not real) synthetic report — this is disclosed as
synthetic, not claimed as real-data evidence. The false-branch (the normal
case) is real-data-verified on all 50 real threads across both reports.

**Real, load-bearing measurement from this step**: the real Aug 25 digest
JSON serializes to **~207KB**. This is exactly the kind of measurement the
handoff asked for instead of an assumption, and it lands close enough to
the handoff's own called-out 200KB risk zone that it's flagged prominently
in `WebApp.gs` and in the live-verification checklist below.

### 3. Summarization — ✅ FULLY VERIFIED (real Anthropic API)

Two layers of real verification, both against the real API with a
temporary key (never written to any file — confirmed by scanning the
scratchpad and the repo for the key's prefix after the session, zero
matches):

1. `summarize_lib.mjs` (an equivalent standalone implementation) was run
   first against all 47 real threads needing summarization across both
   reports (41 of Aug 25's 43, 6 of Aug 1's 7) — **47/47 succeeded, 0
   failures**. Real output-token usage ranged 85-636, consistent with the
   handoff's own historical calibration (71-828, p95=523).
2. The **exact function bodies** in the real `Summarize.gs` file
   (`buildSummaryRequest_`, `parseSummaryResponse_`) were then extracted
   and executed (via evaluating the literal file source, not a rewrite)
   against the real API for Aug 1's 6 threads, through a thin
   `UrlFetchApp`-shaped shim over real `fetch` — **6/6 succeeded**.

23 of the 47 real summaries in run (1) contained a literal `"` character in
the generated text, with zero JSON-parse failures — direct evidence the
forced tool-use approach doesn't carry the original artifact's hand-typed-
JSON escaping bug, because the API generates the JSON structure itself; the
model never hand-types it.

**What is NOT verified**: real `UrlFetchApp.fetchAll` execution
characteristics inside actual Apps Script. Node's `Promise.all`+`fetch`
completed all 41 Aug-25 concurrent calls in ~12 seconds of real network+API
time — this is real evidence that the API itself is fast, but Apps Script's
own quota/scheduling overhead for `fetchAll` is a different runtime and was
not measured. Combined with the handoff's own baseline (report generation
alone: 7.6-76.9s in real logged runs), a combined single-trigger run seems
very likely to fit inside the 6-minute ceiling (AS1) with wide margin — but
"very likely, extrapolated from partial real evidence" is a different, and
weaker, claim than "measured." **This is the first thing to watch in the
Apps Script execution log after the first real trigger run.**

### 4. Served web page — ⚪ CODE-COMPLETE, NOT LIVE-VERIFIED (with two real-data checks alongside it)

`WebApp.gs` and `Index.html` cannot run outside a real Apps Script
deployment — `doGet`, `HtmlService`'s sandboxed iframe, and
`google.script.run`'s callback model don't exist anywhere this session
could reach.

Two things WERE checked against real data as a partial substitute:

- `Index.html`'s embedded `<script>` block passes a plain syntax check.
- The pure rendering functions (`renderSummaryCard`, `renderFullEmailCard`,
  `participantsLine`, `escapeHtml`) were extracted from the real file and
  executed — not simulated — against the real, fully-summarized digest
  JSON for both Aug 25 (43 threads) and Aug 1 (7 threads): all 86 cards
  rendered without throwing, no `undefined` leaked into any card's HTML,
  and every real subject/summary containing a literal `&` (13 real
  instances across both days) was confirmed HTML-escaped correctly.

This proves the string-building logic is sound against real content
shapes. It does **not** prove anything about real DOM rendering, real
`google.script.run` round-trips, real scroll/jump-bar behavior, or the
real sandboxed-iframe environment — those need the real deployment.

### 5. Gmail actions — 🟡 LOGIC-VERIFIED VIA STAND-IN

`GmailActions.gs` uses native `GmailApp` calls, which only run inside real
Apps Script. What was verified instead, using this session's live Gmail
MCP connector (a structurally different mechanism — label manipulation via
a different API surface, not `GmailApp`) against a real message
(`19fbeca6904ee7fa`, the real Aug 1 "Your July Flow State recap" email):

1. Fetched its real starting state: `labelIds: ["INBOX"]` (read, unstarred).
2. Added `UNREAD` → re-fetched → confirmed present.
3. Removed `UNREAD` → re-fetched → confirmed gone (read again).
4. Added `STARRED` → re-fetched → confirmed present.
5. Removed `STARRED` → re-fetched → confirmed gone.
6. Final state re-fetched: `["INBOX"]` — **exactly the original state**, no
   lasting change left on the real inbox.

This confirms Gmail's read/star state is backed by the `UNREAD`/`STARRED`
system labels — the same mechanism `GmailMessage.markRead()`/
`.markUnread()`/`.star()`/`.unstar()` operate on — and that toggling a real
message's state and reading it back actually works against this account.
It does not confirm `GmailApp`'s own method behavior; that needs a real
Apps Script execution.

Separately (read-only, no mutation): the real 6-message HVAC thread's two
distinct Message IDs (`1a03a26a4fc841ef`, `1a03b11abb9988a6`) were each
fetched independently and confirmed to carry independently queryable label
state — concrete confirmation that a bulk "mark thread read" action must
loop over every message ID in a thread, never just one.

### 6. Real-time read/star state on load — 🟡 LOGIC-VERIFIED VIA STAND-IN

Same evidence as step 5 — the label-state-in/state-out round trip above is
exactly the mechanism `getReadStarStateForThreads()` relies on
(`isUnread()`/`isStarred()` read the same underlying labels). No additional
separate test was run for this step; it shares its verification with step
5.

### 7. Mobile pass — entirely yours (per the split-responsibility plan)

Viewport meta tag and `setXFrameOptionsMode(ALLOWALL)` are in
`WebApp.gs`/`Index.html` (code-complete), but an actual phone browser
against a real bookmarked `/exec` URL cannot be tested from here.

### 8. Deployment stability (AS9) — entirely yours

Requires an actual deployment and a second code push to confirm the URL
stays constant. See the deployment steps in `apps-script/README.md`.

## What you need to verify live, in order

1. **Paste the files in, set the Script Property, run
   `generateDigestForDate('2026-08-25')` manually once** from the Apps
   Script editor (not via the trigger yet). Confirm it completes, check the
   real execution time in the execution log against the 6-minute ceiling
   (AS1) — this is the single most important number neither of us has seen
   yet.
2. **Deploy the web app** (see README's deployment steps) and open the
   `/exec` URL. Confirm the 43-thread Aug 25 digest actually loads — this
   is where the ~207KB payload finding either turns out fine or doesn't. If
   it's slow or fails, switch `getDigestForDate` to the stripped-body +
   `getFullBodiesForDate` split described in that function's own comment.
3. **Test Gmail actions for real**: star a thread, mark one read/unread,
   confirm the toggle sticks in the actual Gmail inbox (not just the page).
4. **Test "Mark all read"** including a thread you've starred — confirm
   starring did not exempt it.
5. **Open the bookmarked `/exec` URL on your phone.** Confirm the jump bar,
   back-to-top button, and scroll navigation all work in a real mobile
   browser — this was designed to the spec but never tested at a real small
   viewport.
6. **Make one small code change, redeploy under the same deployment
   (Manage deployments → edit → New version), and confirm the `/exec` URL
   does not change.**
7. Only after all of that: point the real 4am trigger at
   `generateDigestForDate` for real, and check the next morning's actual
   digest.
