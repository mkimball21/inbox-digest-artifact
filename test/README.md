# Verification harness (not part of the artifact)

`harness.jsx` is a byte-for-byte copy of `../inbox-digest.jsx` with only the
five functions that call the real Messages API / MCP servers
(`fetchAvailableDates`, `fetchReportForDate`, `summarizeAllThreads`,
`runGmailLabelAction`, `fetchFullBody`) replaced with deterministic local
stubs, so the exact component tree — parser, thread grouping, refs, scroll
navigation, optimistic UI, caching — can be exercised in a plain Chromium
browser via Playwright instead of inside Claude.ai's artifact sandbox.

It exists to empirically check the things a code read can't confirm on its
own, especially H5 (does `scrollIntoView` + refs actually navigate both
directions) and requirement 6 (does a second load of a cached date really
skip re-fetch/re-summarization).

## What it does NOT include

`daily_inbox_report_2026-08-25.txt`, the real report fetched from the
"Inbox Reports" Drive folder during H2 verification, is deliberately **not**
committed here — it contains real people's names, email addresses, and
personal/financial details from Mason's actual inbox. It was used locally
only, from the session's private scratch directory, and discarded from the
repo.

To rerun this harness yourself, fetch your own report via `download_file_content`
(see H1/H2 in `inbox_digest_handoff.md`), decode it, and drop it in this
folder as `daily_inbox_report_2026-08-25.txt` (or edit the date in
`harness.jsx`'s `fetchReportForDate` stub and the two test scripts).

## Running it

```sh
cd test
npm install
npx esbuild entry.jsx --bundle --outfile=bundle.js --loader:.jsx=jsx --jsx=automatic
npx http-server -p 8934 -c-1 &
node nav-test.js       # scroll nav, thread grouping, read/star, mark-all-read, caching
node fullbody-test.js  # on-demand full-body load for a truncated message
```

Both scripts need `playwright` (pre-installed globally in this environment)
and a real report fixture in place, as above.

## What passed, last run

- 43 summary cards / 43 contents entries rendered for the 2026-08-25 report
  (matches `Total Threads: 43` in the report header).
- The "[DIG] HVAC referral - lower Bucks" thread collapsed to one card with
  "6 messages · …", and its Full emails section showed exactly 6 distinct
  Message IDs under one Thread ID — confirms grouping is by Thread ID, not
  Message ID.
- Clicking "Read full email ↓" scrolled that thread's full-email block to
  the top of the viewport; clicking "Back to summary ↑" scrolled back to
  the same summary card — both via `scrollIntoView` on React refs, no hash
  anchors anywhere in the DOM.
- Clicking a Contents entry jumped to the matching summary card.
- Toggling a card's status dot flipped `is-read` optimistically and
  instantly.
- Starring a still-unread thread, then clicking "Mark all read", left it
  starred but marked it read — starring is not an exemption.
- A second selection of an already-generated date fired zero fetch calls
  and zero summarization calls (both counters stayed at their prior value),
  and the cached read/star state rendered immediately.
- Selecting a date with no report showed the clean "No report found for …"
  state, not an error.
- Clicking "load full email" on a truncated message replaced its body in
  place with the fetched full text.
- No page errors during any of the above.
