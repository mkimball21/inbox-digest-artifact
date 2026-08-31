# Adversarial review — inbox-digest.jsx

Performed 2026-08-27, after two rounds of "verified" fixes that both turned
out to be incomplete under real conditions (see `test/README.md`: a
token-budget/truncation bug, then a JSON-escaping bug hiding behind it,
both caught only by the user testing the live artifact). This review starts
from the assumption that a similar third or fourth issue is likely present,
and tries to find it by code tracing and, where possible, direct
calculation — not by re-running the same two already-tested dates.

**Scope discipline:** no code was changed for this pass. Every finding
below is either (a) traced through the actual current source with line
references, (b) proven by direct calculation from the actual constants in
the file, or (c) reasoned from the code plus the handoff spec with an
explicit confidence caveat where I have not verified it against a running
instance. Section 7 makes the confidence level explicit for every finding;
nothing here should be read as "verified" unless it says so.

---

## Status update, 2026-08-27 (follow-up pass)

C1, C2, and M4 fixed. M5 decided (kept singleton, fixed the false comment
— see the reasoning below, backed by real computation, not just written
in). M1 and M3 fixed. Several Minors fixed; several explicitly deferred.
Full detail, what's verified vs. still genuinely unverified (notably C2's
live Gmail test — blocked by a real, confirmed environmental limit, not
skipped), and exact commit are in the PR description and `test/README.md`.
This file is left as originally written below — the findings themselves
were accurate at the time and are the record of what was found; do not
edit the sections below to retroactively describe them as fixed.

---

## Critical

### C1. An empty or whitespace-only model-provided summary is silently accepted as success

**Where:** `summarizeBatchRaw`, the `toolUseBlocks` filter:
```js
.filter((b) => b.input && typeof b.input.threadId === "string" && typeof b.input.summary === "string")
```

**Scenario:** The model calls `submit_thread_summary` with
`summary: ""` (or `"   "`) for some thread — plausible whenever the model
decides a thread has nothing worth summarizing but still complies with the
"call it once per thread" instruction literally, or under any decoding
hiccup that produces a technically-valid-but-empty string field.

**Why it's a problem:** `typeof "" === "string"` is `true`, so this passes
the filter, gets mapped into `{ threadId, summary: "" }`, and
`summarizeChunkAdaptive` marks that thread `{status: "done", summary: ""}`.
The card renders `<p>{t.summary}</p>` — a blank paragraph — with **no error
state, no retry link, no distinguishing marker from a genuinely short-but-
real summary**. This is exactly the failure class that caused the last two
"verified" ships to fail in the field: something that looks structurally
correct (a valid string, a successful tool call) but is actually wrong
content, with no signal that anything went wrong. A user skimming 40+ cards
would very plausibly miss one blank card entirely, and — because
`summaryStatus` is `"done"` — this thread would be cached as done and would
**never be retried**, not even on a fresh load (only `"pending"` threads
resume; see H8/caching code).

**Confidence:** High — traced directly, the type check is exactly this
permissive and there is no length/content check anywhere downstream.
Not empirically reproduced (the real API never happened to do this across
94 live calls in this session's testing), but the code path is real and
unguarded regardless of how often the model actually triggers it.

**Fix direction:** Add a minimum-length/non-blank check to the filter
(e.g. `b.input.summary.trim().length > 0`, maybe with a small floor like
`>= 10` chars) and treat a too-short summary as "missing" — i.e., route it
into the same retry-then-error path as a thread the model skipped entirely,
rather than accepting it as done.

---

### C2. Gmail write-action "success" is inferred from `mcp_tool_use` presence only — the actual `mcp_tool_result` is never inspected

**Where:** `runGmailLabelAction` → `runChunk`:
```js
const calls = blocksByType(data.content, "mcp_tool_use").filter((b) => b.name === tool);
const calledIds = new Set(calls.map((c) => c.input && c.input.messageId).filter(Boolean));
chunk.forEach((id) => (calledIds.has(id) ? succeeded.add(id) : failed.add(id)));
```

**Scenario:** The model correctly calls `unlabel_message` (or any of the
four Gmail tools) with a given `messageId` — so an `mcp_tool_use` block
exists for that ID — but the underlying Gmail API call the MCP server
actually performs fails server-side for that specific message (permission
edge case, the message was deleted/moved between page-load and click, a
transient Gmail-side error, rate limiting on Gmail's own API distinct from
Anthropic's). MCP tool invocations return a paired `mcp_tool_result` block
(referenced by `tool_use_id`) that would carry the real outcome — but this
code never reads it.

**Why it's a problem:** The comment on this function claims *"Returns
which IDs the response actually confirms were acted on"* — but calling a
tool is not the same as the tool succeeding. This conflation means a
message ID could be recorded as `succeeded` (no revert, no error shown)
when Gmail's own mutation actually failed, leaving the UI showing "read"
(or "starred") while Gmail still shows the opposite — a silent state
desync in the one place this app is allowed to write to a real inbox. This
is the Gmail-side mirror of C1: a structurally-plausible-looking response
(a tool was called) mistaken for a confirmed outcome.

Notably, this file's own Drive-fetch code (`extractMcpToolResultJson`,
used by `fetchAvailableDates`/`fetchReportForDate`/`fetchFullBody`) *does*
correctly read `mcp_tool_result` blocks as the authoritative result. The
Gmail write path is the one place in the file that doesn't follow the
pattern the file itself establishes elsewhere.

**Confidence:** High on the code gap itself (directly read). **Explicitly
unverified** on real-world impact — this session's live-API testing was
scoped entirely to summarization (`mcpServers: []`); no live Gmail MCP call
was exercised at all in this task, so I cannot say how often (if ever) a
called tool actually fails server-side in practice, or even confirm
`mcp_tool_result` carries an inspectable error field for this connector.
This is a code-structure finding, not an observed failure.

**Fix direction:** Extract and pair `mcp_tool_result` blocks with their
`mcp_tool_use` counterparts via `tool_use_id` (same pattern already used
for Drive), and only count an ID as `succeeded` if its paired result block
doesn't indicate an error. If MCP tool_result blocks for this connector
don't expose a usable error signal, that itself is worth confirming
directly (a targeted live test against one real Gmail message) before
trusting the optimistic-revert logic further.

---

## Moderate

### M1. No error boundary + no cache-shape validation on load = a future schema change can hard-crash a previously-cached date

**Where:** `handleSelectDate`:
```js
if (cached && Array.isArray(cached.threads)) {
  setThreads(cached.threads);
  ...
```
No React error boundary exists anywhere in the file (confirmed:
`grep -n "componentDidCatch\|ErrorBoundary\|getDerivedStateFromError"`
returns nothing).

**Scenario:** This artifact gets updated again (very plausible — it already
has been, twice, in this conversation), and a future change alters the
thread/message object shape (renames a field, changes `messages` to
something else, adds a required field the render code assumes exists).
Mason opens a date he cached under the *old* version. The `Array.isArray`
check passes trivially — it says nothing about the shape of the objects
inside — and the old-shaped objects get set directly into React state and
rendered.

**Why it's a problem:** If the render code dereferences a field the old
cache doesn't have (e.g. `t.messages[0].fromDisplay` when `messages` was
renamed), React throws during render. With no error boundary anywhere in
the tree, **the entire artifact unmounts to a blank/broken page** for that
date — not just that thread's card, the whole app — with no path back
except manually clearing that cache key (which the UI gives no way to do)
or a fresh republish (which loses all cached dates anyway per H7).

**Confidence:** High that both preconditions are true today (verified by
reading). Moderate-to-speculative on whether/when a shape change actually
happens — but given this file's history in this conversation, treating
"another edit is coming" as likely seems reasonable, not alarmist.

**Fix direction:** Two independent, cheap layers: (1) a small
`CACHE_SCHEMA_VERSION` constant written into every cache entry and checked
on read — treat a version mismatch as a cache miss, not a crash; (2) a
minimal error boundary wrapping the `status === "ready"` render tree that
falls back to "something went wrong rendering this date" with a button to
clear that one cache key, rather than a full white-screen crash.

---

### M2. No in-flight guard on read/star toggles or their overlap with "Mark all read" — optimistic UI and Gmail state can diverge under fast/concurrent actions

**Where:** `handleToggleRead`, `handleToggleStar`, `handleMarkAllRead`.

**Scenario A (double-click a status dot):** `onClick={() =>
handleToggleRead(t)}` has no `disabled` state and no in-flight tracking.
Two rapid clicks on the same dot capture `thread.isRead` at two different
render snapshots (`false` then, after the first optimistic update
re-renders, `true`), and fire `markRead` and `markUnread` as two
independent concurrent network calls with no ordering guarantee on which
resolves last. Whichever `patchThread` call lands last wins the final
displayed state, independent of which the user actually intended last —
and if the *earlier* network call is also the *slower* one, its revert (if
it fails) can stomp the second click's already-applied correct state.

**Scenario B ("Mark all read" overlapping an individual toggle):**
`handleMarkAllRead` disables *itself* (`markAllBusy`) but does nothing to
disable the individual per-thread star/read buttons while it's running. A
thread included in the in-flight mark-all-read batch can simultaneously
have its own toggle clicked, firing a second, independent
`runGmailLabelAction` call for overlapping message IDs.

**Why it's a problem:** Neither scenario crashes anything, but both can
leave the UI's optimistic state and Gmail's actual state disagreeing,
silently (no error is shown in either race — both individual calls "succeed"
from the app's point of view, they just target opposite end states).

**Confidence:** High on the mechanism (no disabling anywhere for these
buttons, closures visibly capture point-in-time state — read directly).
Not reproduced live — would need deliberate fast double-clicking against a
real Gmail account to observe the actual divergence, which this session's
testing didn't attempt (all Gmail-path testing so far has been UI-stub-only
via Playwright, per `test/README.md`).

**Fix direction:** Track an in-flight set of thread IDs (or a per-thread
`isSyncing` flag) and disable/ignore repeat clicks on a thread already
mid-toggle; have `handleMarkAllRead` also mark its target thread IDs as
busy so individual toggles on those threads no-op or queue until it
finishes.

---

### M3. Unawaited, unserialized `window.storage.set()` calls to the same key during a summarization sweep

**Where:** `runSummarizationFor`'s `onThreadDone` callback calls
`persistThreads(date, next)` — which calls `storageSet(...)` — on **every
single thread's completion**, without awaiting the write or queuing it
against the previous one:
```js
summarizeAllThreads(threadsNeedingSummary, (threadId, result) => {
  setThreads((prev) => {
    const next = /* ... */;
    persistThreads(date, next);   // fire-and-forget, not awaited
    return next;
  });
});
```

**Scenario:** A 41-thread day (already the real tested case) produces 41+
separate, overlapping `window.storage.set("digest:2026-08-25", ...)` calls
in quick succession as summaries stream in. On a 100+-thread day (see M-
section below on scale) this could be 100+.

**Why it's a problem:** If these writes to the *same key* can complete
out of order (write started later finishes before one started earlier —
entirely plausible for any network- or IndexedDB-backed store under
concurrent unawaited calls), the **last write to actually land**, not the
last one issued, becomes the persisted state. A write carrying fewer
completed summaries could overwrite one carrying more, silently dropping
already-shown-in-the-UI summaries from what's cached. This is partially
self-healing — a reload's `stillPending` resume logic would re-summarize
any threads whose completion got lost this way — but the user would see a
regression (cards that were "done" now "pending" again) with no
explanation.

**Confidence:** High that the code has no awaiting/serialization here
(verified directly — `persistThreads` inside the callback is not
`await`ed and nothing queues these calls). **Unverified** whether
`window.storage`'s actual implementation serializes writes to the same key
internally, which would make this a non-issue in practice — I have no way
to inspect that from here, and it's an important caveat: this finding
could be entirely moot depending on platform internals I can't see.

**Fix direction:** Debounce/coalesce the persist calls (e.g. persist at
most once per N ms, or once per batch-round rather than per-thread), or
maintain a simple promise chain so each write to a given key waits for the
previous one to settle before firing.

---

### M4. A genuinely empty inbox day (`Total Emails: 0`) renders a blank area with no message

**Where:** the render gate for the main content:
```jsx
{status === "ready" && threads.length > 0 && ( /* ... only branch that renders content ... */ )}
```
There is no `status === "ready" && threads.length === 0` branch.

**Scenario:** The upstream Apps Script (`inbox_compilation_updated.gs`,
`renderCompilationBody_`) explicitly has a real, working code path for this:
`if (!messageRecords.length) { lines.push('(no emails found)'); ...
'No emails found for the covered window.' }`. A quiet holiday, a vacation
day, or any day with zero qualifying inbox messages produces exactly this
file. It is not a hypothetical — it's a real, documented output shape of
a script this task was told not to modify.

**Why it's a problem:** `parseReportText` finds zero `EMAIL ... START/END`
marker pairs (correctly — there are none), so `records = []`,
`threads = []`. `status` becomes `"ready"` (the fetch succeeded, parsing
succeeded), but the only content-rendering branch requires
`threads.length > 0`. The result: date picker, jump bar area, and an
otherwise blank page — no "No emails today" message, nothing distinguishing
this from a broken load. This is different from (and less clear than) the
already-handled "not-found" case (no report file exists at all).

**Confidence:** High — traced directly, and cross-checked against the
actual upstream script's own handling of the zero-email case.

**Fix direction:** Add a `status === "ready" && threads.length === 0`
branch with a plain "No emails in the archive for {date}." message,
distinct from the not-found state's "No report found for {date}."

---

### M5. Batching is now mathematically incapable of ever combining more than one thread per call — silently contradicts both the file's own comment and the handoff's H4 design intent

**Where:** `planSummaryBatches` / `estimateThreadOutputTokens`, current
constants: `BASE_OUTPUT_TOKENS_PER_THREAD = 600`,
`JSON_OVERHEAD_TOKENS_PER_THREAD = 40`, `SUMMARY_BATCH_TARGET_OUTPUT_TOKENS
= 900`.

**Proof (not a guess):** the *minimum possible* single-thread estimate,
even for a thread with `combinedChars = 0`, is `600 + 0 + 40 = 640`. Two
such minimum-estimate threads together already sum to `1280`, which
exceeds the `900` batch target. Since `planSummaryBatches` always adds the
first item to a fresh batch unconditionally, then closes the batch before
adding a second item whenever the running total would exceed the target,
and `640 × 2 = 1280 > 900` **for every possible pair of threads under these
constants**, no batch of size 2 or more can ever be produced. This isn't a
tendency observed on two sample days (confirmed independently against both,
41/41 and 6/6 batches were all singleton) — it's a property of the
constants themselves, true for any conceivable input.

**Why it's a problem — two distinct issues:**
1. It directly contradicts the file's own comment, which claims the 900
   target "leaves real headroom under the fixed max_tokens: 1000 cap
   *while still letting more than one small thread share a batch*"
   (lines 38-40). That claim is false as the constants currently stand.
2. It silently abandons the handoff's explicit H4 design intent — "expect
   4-5 threads per call," "~9-11 calls total" for a 43-thread day, aimed
   at wall-clock speed via real batching. The current behavior is ~1 call
   per thread (41 calls for the 41-thread day, confirmed live) — safer,
   but a materially different, undocumented trade of speed for safety
   that nobody explicitly signed off on as a permanent design, only as
   this round's calibration outcome.

This is not a correctness bug (more calls ≠ wrong output) — it costs wall
time and API call volume, not accuracy — which is why it's Moderate, not
Critical. But it's a real, provable drift worth a conscious decision.

**Confidence:** High — this is arithmetic on the actual constants in the
file, not an inference.

**Fix direction:** Either (a) update the comment to accurately describe
current (effectively singleton) behavior and accept the speed trade-off
explicitly, or (b) if genuine batching is wanted back, lower
`BASE_OUTPUT_TOKENS_PER_THREAD` (real p75 was 386, well under 600) and/or
raise the target closer to 1000, leaning more on
`summarizeChunkAdaptive`'s already-verified split/retry recovery as the
safety net rather than trying to make the upfront estimate itself
conservative enough to never need it.

---

## Minor

### N1. Low-text detection is a fragile exact-string match with no fallback to the already-parsed body length

`lowText: body === LOW_TEXT_PLACEHOLDER` (`inbox-digest.jsx:196`) depends
on an exact literal match against a string also hard-coded in the separate
`inbox_compilation_updated.gs` file. `bodyLength` is already parsed
per-message and available, and the upstream threshold (120 chars,
`LOW_TEXT_THRESHOLD`) is documented — a redundant check like `bodyLength <
120` would catch a drift between the two files' literal strings instead of
silently sending placeholder text into a real summarization call (which
would then plausibly write a nonsense "summary" of the placeholder
sentence itself, violating the explicit "never invent content for a
low-text email" requirement). High confidence on the coupling; low
likelihood of it breaking *today* since both strings currently match
exactly.

### N2. `headerTotalEmails`/`headerTotalThreads` are parsed, returned, and never used anywhere

`parseReportText`'s own doc comment says the header counts are "(used for
a sanity check)" — they are computed and returned but no caller reads
them. Cheap to either wire up (compare against `records.length` /
unique-thread count and surface a warning on mismatch) or remove the
now-inaccurate comment. High confidence, directly verified.

### N3. Retry budget resets on every split in `summarizeChunkAdaptive`

The half-split recursive calls don't pass `retriesLeft` through
(`summarizeChunkAdaptive(threadsBatch.slice(0, mid), onThreadDone, {
forceShort })` — no `retriesLeft` key), so each split subtree gets a fresh
default of 2. This doesn't create a hang (splitting strictly shrinks batch
size every time, so the whole recursion tree is still finite and bounded),
but worst-case total API call count for a pathological batch is higher
than the `retriesLeft` constant by itself would suggest. High confidence
on the mechanism; low practical impact.

### N4. Retry-stacking: an outer retry re-triggers the inner `callWithRetry`'s own up-to-3-attempt retry, with no delay at the outer layer

A single persistently-failing thread can accumulate up to ~2 (outer
`retriesLeft`) × 3 (inner `callWithRetry`) ≈ 6+ real network attempts, and
the outer layer adds no backoff of its own between its retries (only the
inner layer backs off). Bounded, not a hang, but more aggressive than the
constants suggest at a glance, and worth tightening given it's spending
real API budget on likely-deterministic failures (e.g. a genuine content
refusal will probably fail identically on every attempt). Moderate
confidence — the mechanism is verified; how often a genuinely
non-transient failure occurs in practice is unknown.

### N5. `SUMMARY_CONCURRENCY_DEFAULT` step-down never recovers within one run

Once a 429/529 drops concurrency toward `SUMMARY_CONCURRENCY_MIN` (1) for
one date's summarization sweep, it stays low for the rest of that sweep
even if the underlying rate-limit condition was transient and has cleared.
It does reset to the default on the *next* `summarizeAllThreads` call
(each date load starts fresh), which limits the blast radius to a single
run rather than the whole session. High confidence, low-to-moderate
practical impact.

### N6. No CSS truncation on sender display names

`formatParticipantsLine` truncates the *count* of participants shown
(first 2 + "+N"), but no individual name — including the primary sender
line shown on every summary card — has a `max-width`/`text-overflow:
ellipsis` or similar. An unusually long display name (a company's
auto-generated "Team Name <department> Notifications" style sender, which
real marketing mail does produce) could overflow or wrap awkwardly,
especially on a narrow viewport. Moderate-low confidence — reasoned from
CSS inspection, not rendered and visually confirmed against a crafted long
name.

### N7. `rawContent` field is computed and returned but never consumed

`summarizeBatchRaw` returns `rawContent: data.content` (`inbox-
digest.jsx:664`); no caller reads it. Harmless, but dead weight — either
use it for the error diagnostics (it's redundant with the separate
`textFallback` extraction already done for that purpose one level up in the
error case) or drop it.

### N8. No progress indicator across a large summarization sweep beyond individual card status

For a very large day (see the "at scale" section below), there's no
running "N of M summarized" indicator — only each card's own
Summarizing→done/error transition. This may be intentional (the handoff
explicitly rejected an "X of Y read progress counter" for the *reading*
progress), but that item was specifically about read-state, not
summarization-generation progress, so it's not clearly the same thing.
Low confidence this is even a gap worth closing — flagging for Mason's
judgment rather than asserting it's wrong.

### N9. `Mark all read (N)` button label functions as an implicit unread counter

Borderline against the explicitly out-of-scope "X of Y read progress
counter." The button's count is operational (it tells you what clicking it
will do) rather than a standing progress display, which is arguably a
different thing — but it does continuously show an unread tally on
screen. Low confidence this crosses the line the handoff meant to draw;
noting it so it's a deliberate call rather than an accidental one.

---

## At scale: what a 100+-thread day would actually do

Traced, not tested (no real day this large was available to test against):

- **Batch count / call volume:** given M5's finding that batching is
  currently always-singleton, a 100-thread day means **~100 individual
  Messages API calls**, at `SUMMARY_CONCURRENCY_DEFAULT = 3` concurrent →
  roughly 34 sequential rounds. Extrapolating from the real observed
  timing (206s for 41 calls at concurrency 3, live-verified), a 100-thread
  day would plausibly take somewhere in the 8-10 minute range end to end.
  Not a hang, but a real, un-signaled wait with no progress indicator
  (N8) beyond individual card status.
- **Retry ceiling:** bounded per-thread (see N3/N4 above) — no infinite
  loop risk was found anywhere in the retry/split logic; every path either
  terminates on success, on a strictly-shrinking split, or on a
  `retriesLeft` count reaching zero.
- **Concurrency floor:** per N5, one early rate-limit burst (more likely
  at higher call volume, i.e. more likely on a large day) permanently
  slows the *rest* of that one day's sweep to `SUMMARY_CONCURRENCY_MIN`.
- **Cache write volume:** M3's finding gets strictly worse at scale — 100+
  unawaited overlapping writes to the same storage key instead of 41.

**Confidence:** the mechanisms above are all directly traced from the
actual code and constants. The specific wall-clock estimate is an
extrapolation from one real data point (206s/41 calls), not a
measurement — treat it as an order-of-magnitude guess, not a benchmark.

---

## Requirements diff against the handoff's "Required behavior" section

Went through sections 1-9 and the Technical Constraints section point by
point against the current code. Everything matches except where noted:

- **Section 4 (Summarization), "one batched call per chunk... never one
  call per email/thread":** technically still true in the letter (each
  call is per-*thread*, and a thread can be multiple emails) but the
  *spirit* — real multi-thread batching for speed — is gone under current
  calibration. See M5. Not a violation of the literal requirement, but
  worth flagging as the requirement's intent has quietly drifted.
- **Everything else in sections 1, 2, 3, 5, 6, 7, 8, 9, and Technical
  Constraints:** checked directly against the code (date-selection blank
  state, Drive fetch via `download_file_content` only, thread grouping and
  day-scoping labels, the three-section layout and all its links, the
  four Gmail actions and their exact tool/labelId mapping, unread-by-
  default with no fetch-on-load, on-demand full-body fetch with read-only
  MCP scoping, `window.storage`-only caching, no `<form>`, no arbitrary
  Tailwind values, no API key in the request) — all present and matching.
  No other silent drops or simplifications found.
- **Out of scope items (search/filter, "X of Y read" counter):** neither
  is present. See N9 above for one borderline case worth a human judgment
  call, not a violation.

---

## 7. Honest confidence summary

Rated per finding above inline, collected here for a quick scan:

| Finding | Confidence in the code-level claim | Confidence in real-world impact |
|---|---|---|
| C1 (empty summary accepted) | High — read directly | Unverified — never observed live, but the gate is objectively this permissive |
| C2 (Gmail success unconfirmed) | High — read directly | **Unverified** — zero live Gmail MCP testing was done this session |
| M1 (cache crash risk) | High — both preconditions confirmed | Speculative — depends on a future edit happening |
| M2 (toggle races) | High — no guards exist, confirmed by reading | Unverified — not reproduced against a live account |
| M3 (unserialized cache writes) | High — code has no await/queue | **Unverified** — depends on `window.storage`'s internal semantics, which I cannot inspect |
| M4 (empty-inbox blank page) | High — traced against both this file and the upstream script | High — this is a real, working upstream code path |
| M5 (batching is dead) | **High — proven by arithmetic on the real constants**, not inferred | High — also confirmed empirically on both live-tested dates (all-singleton) |
| N1-N9 | Mostly high on the code-level claim (each states its own caveats above) | Mostly low-to-moderate; several are explicitly "reasoned, not observed" |

The two findings I'd stake the most on are **M5** (arithmetic proof, not
speculation) and **M4** (traced against a real, documented upstream code
path, not a hypothetical). The two I'd most want a second, live check on
before trusting either way are **C2** and **M3** — both depend on platform
behavior (real Gmail MCP result semantics; `window.storage`'s write
ordering) that this session had no way to observe directly.
