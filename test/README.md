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

## Summarization failure investigation (2026-08-27 field report: 24-25/43 failed)

Real-world use against 2026-08-25 showed 24-25 of 43 summaries as "Summary
failed to generate." This took two rounds to actually fix — the first round
was verified only against a simulation and, correctly, was not trusted as
"done" until confirmed against the real API. Both rounds are documented
below since the first round's fixes (error surfacing, calibrated batch
sizing, broadened retry) are still real and still in the shipped code; the
second round found and fixed the failure mode that the first round's
simulation could not have caught, then re-verified everything against the
real Messages API with real spend, on two different real report files.

### Round 1: batch-sizing / max_tokens (simulation-verified only)

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

   **What this did not prove, and correctly wasn't reported as fixed
   pending it:** that `max_tokens` truncation was the *only* thing
   producing the field's 24-25/43, or the exact wire behavior of a real
   Anthropic response under this app's actual request shape. Confirming
   that needed the real API.

### Round 2: real API access, real second failure mode, real fix

Given a real (temporary, session-scoped) `ANTHROPIC_API_KEY` for testing
only — never written to any file, never committed, read once from
`process.env` — this round ran the **actual, unmodified** summarization
pipeline (not a hand re-implementation) straight out of `inbox-digest.jsx`
against the real Messages API. `live-api-lib.mjs` does this by slicing the
plain-JS section of `inbox-digest.jsx` (the `// Config` block through the
end of the Gmail-actions section — no JSX, so it's directly `vm`-evaluable
in Node) at run time on every test run, so these tests can never silently
drift from the shipped source. A `globalThis.fetch` wrapper attaches the
real `x-api-key`/`anthropic-version` headers (the shipped app never sets
these itself — matching the Claude.ai artifact runtime, where auth is
injected transparently) and logs `stop_reason`/`usage` for every call
without altering what the app code sends or receives.

**Step 1 — calibration** (`live-calibrate.mjs`): measured real output
tokens for 47 individual thread summaries, spanning both 2026-08-25 (41
threads) and a quiet day, 2026-08-01 (6 threads), at a generous
non-truncating `max_tokens` so the true required length was visible.
Findings:
- Real output tokens ranged **71-828**, with p75=386, p90=480, p95=523 —
  828 was a single outlier.
- `combinedChars` is a **weak predictor** (Pearson r=0.33): a 32,039-char
  thread needed only 349 real tokens (mostly unsubscribe/tracking-link
  boilerplate the model correctly ignored); a compact 1,515-char thread
  needed 407. Round 1's `chars*0.5/4` formula was consequently wrong in
  both directions on real data (e.g. estimate=4045 vs. real=349 for the
  32k-char thread).

`estimateThreadOutputTokens` was recalibrated to a generous flat base
(600 — comfortably above the observed p95) plus a capped, minor
char-based adjustment, and `SUMMARY_BATCH_TARGET_OUTPUT_TOKENS` raised to
900 — not fit tightly to this sample, since batch content varies day to
day.

**Step 2 — first real-pipeline run, using the recalibrated estimator:**
`live-verify.mjs` against both real dates came back **40/41 done, 1
failed** on 2026-08-25 (0 failed on 2026-08-01) — closer to zero, but not
the zero required, so **not reported as fixed**. The one failure's logged
`stop_reason` was `end_turn` (the model finished normally — NOT a
`max_tokens` truncation), so Round 1's fix categorically could not have
caught it: it was a second, distinct failure mode. Re-sent just that
thread's prompt via `live-debug-one.mjs` to get the full raw response and
found it directly: the model wrote a summary that quoted the source text —

> ...the commonly cited "300,000 property management companies" figure...

— without escaping the inner quotes, breaking `JSON.parse` on an
otherwise complete, well-formed-looking response. This is a fundamentally
different problem than truncation: asking a model to hand-write raw JSON
as free text is fragile whenever the content itself contains quotes, no
matter how much `max_tokens` headroom exists.

**Step 3 — the actual fix:** switched summarization from "ask the model to
write a JSON array as text" to Anthropic's `tools` (function-calling)
parameter with a forced `tool_choice` — a mechanism entirely separate
from `mcp_servers`/H3 (it grants the model no external capability, only a
local output-format contract; never combined with `mcp_servers` in the
same request). First attempt used one tool call with an array parameter;
live-verified that the model sometimes serialized the *array itself* as a
JSON-encoded string value instead of using the nested-array type,
reintroducing the same escaping bug one level deeper (still reproduced,
same quotes). Fixed by flattening the schema to two plain string fields
(`threadId`, `summary`) called **once per thread** — Claude reliably
issues multiple tool calls in one turn, confirmed directly by forcing a
3-thread batch and observing 3 separate `submit_thread_summary` calls
land. Also hardened `summarizeChunkAdaptive` for a related edge live-found
while testing this: a multi-thread batch can overflow `max_tokens` after
*some* (not all) of its per-thread tool calls already landed — confirmed
directly (a forced batch came back 2-of-3, `stop_reason: max_tokens`, and
the missing thread is now retried automatically as its own call rather
than becoming a permanent error — reran the same forced batch and watched
it happen: first call `max_tokens` (partial), a second automatic call for
just the missing thread, all 3 done).

**Step 4 — final real-pipeline re-verification, both dates:**

```
=== 2026-08-25.txt ===  43 threads, 41 need summarizing, 2 skipped (low-text)
Completed in 206.0s: 41 done, 0 failed (of 41)

=== 2026-08-01.txt ===  7 threads, 6 need summarizing, 1 skipped (low-text)
Completed in 19.4s: 6 done, 0 failed (of 6)

=== SUMMARY ===
PASS  2026-08-25.txt: 41/41 summarized, 0 failed, 206.0s
PASS  2026-08-01.txt: 6/6 summarized, 0 failed, 19.4s
```

47 real Messages API calls, every one `stop_reason: tool_use` (no
truncation needed this run) — 0 failures on both dates, against the real
API, running the real shipped pipeline. This is the result this task
required before being reported as fixed.

**Rerun it yourself:**

```sh
ANTHROPIC_API_KEY=sk-ant-... node test/live-calibrate.mjs <report1.txt> [report2.txt ...]   # step 1
ANTHROPIC_API_KEY=sk-ant-... node test/live-verify.mjs <report1.txt> [report2.txt ...]      # steps 2/4 — the regression gate
ANTHROPIC_API_KEY=sk-ant-... node test/live-debug-one.mjs <report.txt> <threadId>           # step-2-style single-thread diagnostic
```

Set `NODE_USE_ENV_PROXY=1` and `NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`
first if you're behind this environment's egress proxy. `live-verify.mjs`
exits non-zero if any report has a failure, so it doubles as the
repeatable regression test for this whole class of bug on any future
change to the summarization pipeline — point it at any real report file
you have locally (never commit one; see above).

### On the Round 1 mock-based tests (`harness-summary-*.jsx`, `mockAnthropicFetch.js`, `summary-fix-test.js`, `summary-retry-test.js`)

Left in place as fast, free, deterministic checks of the retry/backoff and
batch-splitting *mechanics* (e.g. confirming 429/529 injection gets
absorbed without spending real API calls) — genuinely useful for quick
iteration. They are **not sufficient on their own** to certify a
summarization fix, precisely because they simulate the failure mode you
already hypothesized rather than exercising the real API's actual
behavior — which is exactly how Round 1 missed the JSON-escaping bug.
`live-verify.mjs` against a real report file is the authoritative check.

## Round 4: fixing the adversarial review (`REVIEW.md`) findings, 2026-08-27

Full findings and their severity/confidence ratings are in `../REVIEW.md`.
This is what happened to each, in the review's own priority order.

**C1 (empty/blank summary silently accepted as done) — fixed and proven.**
`summarizeBatchRaw`'s filter now requires `summary.trim().length >=
MIN_SUMMARY_CHARS` (10). Proven with `verify-c1-empty-summary.mjs`, which
runs the real, unmodified `summarizeAllThreads` pipeline (no mock of the
retry/extraction logic, only the network transport) against a synthetic
response containing an empty-string tool call — no API key needed, since
provoking the real model into this exact degenerate case isn't reliably
repeatable. All 5 assertions passed: no event ever reports `done` with a
blank summary; a thread that returns empty-then-valid ends up done with
the real retried text; a thread that always returns empty terminates as
`error` (not an infinite retry, not a false success); a good result in the
same batch is unaffected. Also re-confirmed for real via the Round 3
re-run below (0/47 real summaries needed the floor to reject anything,
consistent with the model reliably producing real content — this is a
safety net for the rare case, not something expected to fire every run).

**C2 (Gmail success inferred from tool call, not result) — fixed in code,
live verification blocked by a real, confirmed environmental limit.**
`runGmailLabelAction` now pairs `mcp_tool_use` blocks with their
`mcp_tool_result` via `tool_use_id` and only counts an ID as succeeded if
the paired result doesn't indicate an error (`isMcpResultError`) — the
same pattern the Drive-fetch path already used correctly. This could
**not** be live-tested, for either the success or the failure path: a
direct test against both `gmailmcp.googleapis.com` and
`drivemcp.googleapis.com` with the real API key returned, verbatim,
`"Authentication error while communicating with MCP server. Please check
your authorization token."` — these connector URLs require the Claude.ai
artifact runtime's own injected Google OAuth token, which a bare Anthropic
API key from outside that runtime cannot provide. This is a general
property of every `mcp_servers` call in this file, not specific to Gmail —
confirmed with two independent endpoints. In other words: **no part of
this file's Drive/Gmail MCP code path has ever been live-tested via its
real mechanism**, only reasoned from the handoff's description and (for
H2) verified via a *different* mechanism (this session's own directly
attached Drive connector, not a raw Messages API call with `mcp_servers`).
Separately confirmed the request shape itself is valid and reaches a real
connection attempt (not a validation error) under the beta header this
file uses (`mcp-client-2025-04-04` + inline `tool_configuration`) — a
newer beta variant (`mcp-client-2025-11-20` + `tools: [{type:
"mcp_toolset", ...}]`) exists and uses an incompatible request shape, but
mixing them produces a distinct, different error from the auth failure
above, confirming the file's current shape is a valid (if older) protocol
choice, not malformed.

**M4 (empty inbox day renders blank) — fixed and verified.** Added a
`status === "ready" && threads.length === 0` branch with a distinct "No
emails in the archive for {date}" message. Verified in the browser harness
(`verify-m4-m1.js`) against a synthetic report matching
`inbox_compilation_updated.gs`'s actual zero-email output shape
(`Total Emails: 0`, `(no emails found)`, no `EMAIL` blocks) — confirmed
the new message shows and is distinguishable from the not-found state.

**M5 (batching is mathematically always-singleton) — decided against
loosening, backed by computation.** Computed (not guessed) what a
principled loosening would actually do to the real 47-thread calibration
dataset: `BASE_OUTPUT_TOKENS_PER_THREAD` lowered to match the real p75
(386→400) with `SUMMARY_BATCH_TARGET_OUTPUT_TOKENS` raised to 950 (still
real headroom under 1000) produced **zero** batching improvement — still
47/47 singleton batches, because real adjacent thread pairs are rarely
small enough together even at that lower base. Only a materially more
aggressive base (~250-300, *below* the real median of 209) produced
meaningful batching (~30-40% fewer calls), trading much heavier reliance
on the split/retry safety net for an unproven win — exactly the kind of
speculative retuning that caused the two prior rounds of failures. Kept
singleton-per-thread as the deliberate, real behavior (it's proven
reliable: 0 failures across 94 real calls now, two dates, two rounds) and
fixed the file's own comment, which previously (falsely) claimed the
constants "let more than one small thread share a batch."

**M1 (cache crash risk) — fixed and verified.** Added
`CACHE_SCHEMA_VERSION` + `isValidCachedThreads` (rejects a version
mismatch or malformed shape as a clean cache miss instead of loading it)
and a `DigestErrorBoundary` wrapping the ready-state render tree (contains
a render crash to that date's content area with a "clear this date's cache
and retry" action, instead of a blank white app). Verified in
`verify-m4-m1.js`: a cache entry persisted by the current code carries
`schemaVersion: 1`; an injected old-shape entry (no `schemaVersion`, wrong
object shape) for a fresh date is correctly treated as a cache miss (a
real fetch fires) with no crash. The error boundary itself wasn't
triggered by an actual render throw in testing — the schema-version check
already prevents the specific scenario M1 described from reaching render
at all, so the boundary is a second layer of defense for other failure
modes, verified by code inspection rather than a forced crash.

**M2 (no in-flight guard on toggles/Mark All Read) — deferred.** Real,
code-verified race, but the fix (an in-flight-tracking Set threaded
through every toggle handler and Mark All Read) is a larger, more
invasive change than the time budget for this pass allowed once items
1-3 and their real verification were prioritized, per the task's own
instructions. Left for a follow-up pass.

**M3 (unserialized cache writes) — fixed.** `storageSet` now keeps one
pending-write promise chain per key, so writes to the same key always
apply in the order they were issued regardless of network/timing.
Implemented and correct by construction (a straightforward promise
chain); not stress-tested under real heavy concurrent write load (would
need a very large report and instrumented `window.storage` timing to
observe directly) — the regression suite confirms no behavioral change
for the normal case.

**Minors — N1 (fragile low-text string match), N3 (retry budget not
threaded through splits), N6 (no CSS truncation on long sender names), N7
(dead `rawContent` field) fixed** — all cheap, low-risk, confirmed via the
full regression re-run (`nav-test.js`, `fullbody-test.js`) passing
unchanged afterward. **N2, N4, N5, N8, N9 deferred** — none are
correctness bugs (N2: unused-but-harmless header counts; N4: retry-stacking
without outer backoff, bounded and low-frequency; N5: concurrency doesn't
recover mid-run, scoped to one date-load; N8/N9: UX judgment calls the
review itself flagged as low-confidence) and fixing them would have traded
time against verifying items 1-3, which the task explicitly prioritized.

**Final mandatory re-verification** (`live-verify.mjs`, real API, real
unmodified pipeline, run *after* all the above changes):

```
2026-08-25 (43 threads): 41/41 summarized, 0 failed, 185.3s
2026-08-01 (7 threads):   6/6 summarized, 0 failed, 28.4s
```

47 real calls, all `stop_reason: tool_use`. Combined with the C1 proof
test and the M4/M1 browser verification, this is the evidence behind
every "fixed and verified" claim above; C2 is the one item still
genuinely unverified end-to-end, for the environmental reason explained
above, not because it wasn't attempted.
