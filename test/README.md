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

## Summarization failure investigation (2026-08-27 field report: 24/43 failed)

Real-world use against 2026-08-25 showed 24 of 43 summaries as "Summary
failed to generate." Two things followed from that report:

1. **The generic message itself was a bug.** `t.summaryError` was already
   being captured into state on every failure but the JSX never rendered
   it — the detailed cause (HTTP status/body, or a JSON-parse diagnostic)
   existed the whole time and was just never shown. Fixed: the error text
   now renders (mono, small) under "Summary failed to generate."

2. **The likely root cause, quantified against the real report before
   writing any fix code:** the original `SUMMARY_BATCH_SIZE = 5` batches 5
   threads per call at the spec'd 25-50%-of-source summary length, but
   `max_tokens` is fixed at 1000 (Technical constraints). Estimating real
   output tokens per thread from the actual 2026-08-25 body lengths (at the
   *midpoint* of the 25-50% range) put **8 of the 9 batches at
   ~1,400-4,400 estimated output tokens** — 1.4x to 4.4x over budget. That
   points to `max_tokens` truncation producing invalid/incomplete JSON
   (which fails every thread in that batch at once), not primarily rate
   limiting, though H4 already flagged concurrency as a secondary,
   untested risk worth hardening regardless.

   `inbox-digest.jsx` was then changed to: size batches by an estimated
   output-token budget instead of a flat thread count
   (`planSummaryBatches`/`estimateThreadOutputTokens`); detect a
   `stop_reason: "max_tokens"` truncation and automatically split the
   batch in half and retry (a batch that overflowed once will overflow
   again unchanged — only a smaller batch fixes it, not a retry); broaden
   `callWithRetry` beyond 429 to 500/502/503/529 and network errors, with
   jitter; and drop default concurrency from 4 to 3, stepping toward 1.

   This session has no Anthropic API key available to it (confirmed: a
   direct call to the real Messages API returns `401 x-api-key header is
   required`), so the fix could not be verified against the literal live
   endpoint. Instead, `mockAnthropicFetch.js` monkey-patches `window.fetch`
   to simulate the one behavior in question — max_tokens truncation — by
   parsing the **real** prompt text the app actually sends (same
   `buildSummaryPrompt` output, same real 2026-08-25 thread bodies) and
   truncating the JSON response exactly the way a real completion would
   when the simulated output would exceed `max_tokens`. Every other line of
   `summarizeBatchRaw`/`summarizeChunkAdaptive`/`planSummaryBatches`/
   `callWithRetry` runs completely unmodified against it.

   - `harness-summary-before.jsx` / `harness-summary-after.jsx`: copies of
     the pre-fix and post-fix `inbox-digest.jsx`, each with only the same
     four non-summarization network functions stubbed as in `harness.jsx`.
   - `summary-fix-test.js` loads the real 2026-08-25 report through both,
     under the identical mock, and counts outcomes.

   **Result, last run:**

   | | failed | skipped (low-text) | total |
   |---|---|---|---|
   | Before fix | **40 / 43** | 2 | 43 |
   | After fix | **0 / 43** | 2 | 43 |

   40/43 (not 24/43) is expected, not a discrepancy: the mock assumes a
   uniform ~40%-of-source output for every thread in every batch (a
   deliberate worst case), where a real model likely writes shorter
   summaries for simple newsletters some of the time, so fewer real
   batches tip over the edge than in this simulation. Same mechanism, same
   order of magnitude, worse in the simulation because the simulation is
   worse-case-biased on purpose.

   `summary-retry-test.js` separately verifies the broadened retry: with
   `mockAnthropicFetch` injecting a 429/529 on every 4th call (11 injected
   errors across 46 total fetch attempts in the run recorded here), final
   failures were still 0/43 — the retries absorbed them.

   Rerun with:
   ```sh
   cd test
   npm install
   npx esbuild entry-summary-before.jsx --bundle --outfile=bundle-summary-before.js --loader:.jsx=jsx --jsx=automatic
   npx esbuild entry-summary-after.jsx --bundle --outfile=bundle-summary-after.js --loader:.jsx=jsx --jsx=automatic
   npx esbuild entry-summary-retry.jsx --bundle --outfile=bundle-summary-retry.js --loader:.jsx=jsx --jsx=automatic
   npx http-server -p 8934 -c-1 &
   node summary-fix-test.js
   node summary-retry-test.js
   ```
   (needs the same real report fixture as above, dropped in as
   `daily_inbox_report_2026-08-25.txt`).

   **What this does not prove:** that `max_tokens` truncation is the
   *only* thing that produced the field's 24/43, or the exact wire
   behavior of a real truncated Anthropic response body under this
   specific artifact runtime's `mcp_servers`/streaming setup. The
   estimation-based batch sizing and the truncation-triggered auto-split
   are both defensive regardless of the exact real number, and the
   broadened retry covers the rate-limiting hypothesis too — but a live
   re-test against 2026-08-25 in the actual Claude.ai artifact remains the
   final confirmation this session can't perform itself.
