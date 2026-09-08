# Handoff: Inbox Digest as an Apps Script Web App

## What you're building

A rebuild of an existing Claude.ai artifact (`inbox-digest.jsx`, in this
same repo) as a **Google Apps Script web app** instead. Same purpose, same
user (Mason), same daily reading workflow — different, simpler
architecture that removes an entire category of bugs the artifact version
could never fully solve.

**Read "Why this rebuild exists" before writing any code.** It explains
which problems are structural (and therefore worth a rebuild) versus
which were just implementation bugs (already fixed, and whose fixes you
should port forward, not rediscover).

---

## Why this rebuild exists

The artifact version works, after four rounds of real-API-verified fixes
(see `test/README.md` and `REVIEW.md` in this repo for the full history).
But three problems turned out to be structural, not fixable within the
artifact model:

1. **Every summarization call ran through Claude.ai's own managed API
   access — you cannot substitute a personal API key inside an artifact.**
   This meant every digest generation consumed Mason's personal Claude Pro
   5-hour usage window, not a separate pay-per-token bill. Generating one
   busy day's digest could meaningfully eat into that window.

2. **Gmail actions went through an MCP connector, which only authenticates
   from inside Claude.ai's own artifact runtime.** This was proven,
   directly, during the last debugging round: a bare Anthropic API key
   gets `"Authentication error while communicating with MCP server"`
   against both the Gmail and Drive MCP endpoints. That meant the Gmail
   read/star fix (`REVIEW.md` finding C2) could be fixed in code but never
   actually verified against a real Gmail action from a coding session —
   only Mason testing the live artifact could confirm it, and even then,
   only by trial and error.

3. **`window.storage` forks to a new, empty URL on every republish.** Every
   fix shipped meant Mason had to re-bookmark a new artifact link and lose
   his cache. Combined with no real mobile access (reopening a specific
   claude.ai conversation on a phone and hoping the cache survived), this
   made the tool considerably less durable than it should be for daily use.

An Apps Script web app resolves all three at once:

- Summarization calls use Mason's own Anthropic API key, billed
  separately and cheaply — real per-call cost estimate revised below in
  "New consideration" (roughly $0.20–0.40/day is a more honest range than
  a single confident number; either way, well under $10/month) —
  **zero impact on his Claude.ai Pro usage.**
- Gmail actions use `GmailApp`, Apps Script's **native** Gmail library —
  no MCP layer, no connector auth, no `mcp_tool_result` pairing logic
  needed at all. The hardest-to-verify part of the old build simply
  doesn't exist in the new one.
- The web app has a URL that **can** stay stable across every future
  update — but only if deployments are managed correctly (see AS9 below,
  this is not automatic).

None of this means the artifact build was wrong to attempt — it was the
right first architecture to try, and its debugging history (documented
below) contains real, hard-won logic you should carry forward rather than
rediscover.

---

## What carries over from the artifact build — port, don't rebuild

These were proven correct through real API testing in the artifact's
history. Reimplement the *logic*, not the React/browser-specific
mechanics, in Apps Script's plain JavaScript (V8 runtime):

- **Report parsing** — the HEADER/INVENTORY/DETAILED APPENDIX format,
  and the exact `===== EMAIL n OF m START/END =====` marker-based
  parsing approach (not delimiter-splitting). See "Source data format"
  below for the format itself; the parsing *approach* (anchor on the
  literal markers, derive everything from the appendix, ignore the
  inventory section) is proven and should be kept.
- **Thread grouping by Thread ID, not Message ID** — these differ in real
  data (verified example: Message ID `19fbf1666f90c7df` under Thread ID
  `19fbed9450b89e4d`).
- **The forced tool-use fix for summarization.** The original build had
  the model hand-write JSON as free text, which broke whenever a summary
  quoted source text containing quote marks (a real, reproduced bug — see
  `test/README.md` round 2). The fix was switching to Anthropic's `tools`
  parameter with forced `tool_choice`, one tool call per thread with two
  plain string fields (not a nested array — an array-wrapping attempt
  reproduced the same escaping bug one level deeper). **Reimplement this
  exact approach.** Do not go back to asking the model to type raw JSON.
- **`MIN_SUMMARY_CHARS` validation** (REVIEW.md finding C1) — an empty or
  whitespace-only summary must be treated as a failed result and retried,
  not silently accepted because it's technically a non-null string.
- **Real token calibration data**: per-thread output tokens in real
  testing ranged 71–828 (p95=523) across a busy day (43 threads) and a
  quiet day (7 threads). Character count was a **weak predictor** of
  summary length (r=0.33). This data's relevance in this rebuild is
  narrower than it was in the artifact: it explains real-world output
  size for cost estimation, but per the next section, you no longer need
  it for batch-sizing decisions.
- **Empty-inbox-day handling** (REVIEW.md finding M4) — a day with zero
  emails must render a clear message, not a blank page.

## What does NOT carry over — genuinely different in this architecture

- No React, no `window.storage`, no artifact sandbox constraints.
- No MCP servers, no `mcp_servers`/`mcp_tool_use`/`mcp_tool_result`
  handling anywhere. Gmail and Drive access are native Apps Script calls.
- **No `max_tokens: 1000` ceiling, and no batching at all.** This was an
  artifact-imposed limit, not an API limit. You control `max_tokens`
  directly now, and each summarization call is already one call per
  thread (per the carried-over forced tool-use fix) — there is no
  batch-size math to do in this architecture at all. Set `max_tokens` to
  something like 1500–2000 per call and move on; the real calibration
  data above is useful for cost estimation, not for a sizing decision
  that no longer exists.
- No republish-forking storage. Persistent state lives in Drive (see
  "Storage" below), which is stable across every future script edit.

---

## Architecture

Three pieces, all within the existing Apps Script project
(`Gmail Daily Archive Script` — the same project that already runs
`sendYesterdayInboxCompilation` on request. that function currently
saves the .txt report to Drive; this rebuild adds to that project rather
than replacing it):

### 1. Extend the existing 4am trigger

After the existing report-generation step (unchanged — do not touch the
report format or the Drive save logic), add:

- Call the Anthropic Messages API directly via `UrlFetchApp`, using
  Mason's own API key (see "API key storage" below).
- Use `UrlFetchApp.fetchAll()` to run summarization calls concurrently
  rather than sequentially. **Real baseline, not an estimate: report
  generation alone (before any summarization) has taken 7.6–76.9 seconds
  in actual logged runs, well within the 6-minute ceiling on its own —
  but that headroom is not automatically enough once summarization calls
  are added.** Measure the actual combined runtime against the real
  43-thread Aug 25 report before assuming concurrent batching fits
  comfortably. If it doesn't leave a safe margin, split report-generation
  and summarization into two separate triggers (e.g. 4:00am and 4:10am)
  rather than risk one long run hitting the ceiling.
- Group into threads, summarize each (one call per thread, forced
  tool-use, per the carried-over fix above).
- Write the result as `digest_YYYY-MM-DD.json` to the same "Inbox
  Reports" Drive folder (ID `1bZFXxjhcpSSYShN03YSiZbuhBIoqno5C`),
  alongside the existing `.txt` file for that date, in the schema defined
  below.
- On any summarization failure for a given thread, store the failure
  state in the JSON (with the real error, not a generic message — this
  was itself a bug in the old build, REVIEW.md's broader theme) rather
  than crashing the whole run. One bad thread should not lose the rest
  of the day.

### Digest JSON schema — defined here so both halves agree on it

The 4am trigger writes this; the web app reads it. Don't let each side
invent its own shape independently.

```json
{
  "date": "2026-08-25",
  "generatedAt": "2026-08-26T04:06:51-04:00",
  "totalEmails": 62,
  "totalThreads": 43,
  "threads": [
    {
      "threadId": "1a03751d21b2221c",
      "subject": "New Pennsylvania Department of Revenue Correspondence",
      "messages": [
        {
          "messageId": "1a03751d21b2221c",
          "timestamp": "2026-08-25 01:08:22",
          "from": "myPATH <RV-DoNotReply@pa.gov>",
          "body": "...",
          "truncated": false,
          "lowText": false
        }
      ],
      "summary": "...",
      "summaryStatus": "ok",
      "summaryError": null,
      "spansMultipleDays": false
    }
  ]
}
```

- `summaryStatus` is one of `"ok"`, `"failed"`, `"skipped-low-text"` — the
  UI branches on this, not on whether `summary` happens to be null.
- `summaryError` carries the real error string when `summaryStatus` is
  `"failed"` — never a generic placeholder (this exact mistake was a real
  bug in the artifact build; don't repeat it).
- `spansMultipleDays` is `true` when a thread's messages don't all fall
  on the covered date — see "Day-scoping" below for why this matters and
  how the UI should use it.
- This schema can and should evolve, but any change to it is a change to
  a **contract**, not just to one file — update both the writer and the
  reader together, and note the change in the repo's README.

### 2. `doGet(e)` — serves the web app

Returns an `HtmlService` page. On load, the page's client-side JS calls
back into the server (via `google.script.run`) to list available dates
(scan the Drive folder for `digest_*.json` files) and, once a date is
selected, fetch that date's JSON.

**Payload size — test this explicitly, don't assume it's fine.** A busy
day's digest with full bodies can exceed 200KB. Returning that in a
single `google.script.run` response is a real risk area, not a detail —
if a full-payload return proves unreliable in testing, split into two
calls (thread list + summaries first, on-demand full-body fetch per
thread second, mirroring the old artifact's on-demand truncated-body
pattern) rather than fighting a large single response.

**Real-time read/star state — this is a genuine improvement over the old
build, not a limitation to carry forward.** The original artifact had to
assume every thread starts unread, because checking real Gmail state
through the MCP layer was expensive and its own decision log explicitly
chose to skip it. That constraint **does not apply here** — native
`GmailApp` calls (`isUnread()`, `isStarred()` on a `GmailMessage`) are
cheap and direct. On load, fetch and display Mason's actual current
Gmail read/star state for each thread, rather than assuming unread. This
also means "assume unread" from the old decisions log is superseded —
don't port that assumption forward.

**`google.script.run` round-trip latency** is typically 1–3 seconds per
call, noticeably slower than the artifact's in-browser interactions.
Optimistic UI (flip the dot/star instantly, revert on failure) still
applies and still matters — arguably more here, since the visible lag
without it would be worse than it was before.

Layout requirements are unchanged from the original spec — **continuous
scroll, three sections (Contents / Summaries / Full Emails), NOT a
two-pane click-through interface.** This was an explicit, deliberate
design decision from the original project (an earlier two-pane mockup was
built and rejected specifically because it broke Mason's actual reading
pattern: skim Contents, scroll Summaries top to bottom, jump down to a
full email only when warranted, jump back up). Keep:

- Sticky jump bar (Contents / Summaries / Full emails)
- Floating back-to-top control
- Inline read/star status on each summary card, no click-through —
  reflecting real fetched Gmail state, not an assumption
- "Mark all read" bulk action, applies to every thread including starred
  ones (this was an explicit decision, not an oversight — starring does
  not exempt a thread from bulk mark-as-read)
- Archive-ledger visual design: warm stone background (`#EDEEEA`), warm
  near-black text (`#23241F`), deep ink navy accent (`#1D3557`), muted
  mustard signal color for unread/star (`#C98A2D`), serif section
  headings, monospace metadata (timestamps, message IDs, thread IDs),
  rotated rubber-stamp-style date badge
- Day-scoping label: when `spansMultipleDays` is true for a thread, show
  something like "3 messages on this date" rather than implying the
  displayed messages are the thread's complete history. The report only
  ever contains messages received on the covered calendar day, so a
  thread that continues from a prior day or into the next will otherwise
  read as if it were the whole conversation.

**Mobile, since real phone access is a headline reason for this
rebuild** — don't leave it implicit:
- Include a proper viewport meta tag
  (`<meta name="viewport" content="width=device-width, initial-scale=1">`)
  in the served HTML.
- Call `HtmlService`'s `setXFrameOptionsMode` appropriately for the
  deployment so it actually renders correctly when opened from a
  bookmarked link on a phone, not just inside the Apps Script editor's
  preview.
- Test the actual scroll/jump navigation on a real phone browser before
  calling this done — small-viewport behavior for the sticky jump bar and
  back-to-top control was designed and tested for desktop originally.

### 3. `google.script.run` server functions for Gmail actions

- `markThreadRead(messageIds)` — `GmailApp.getMessageById(id).markRead()`
  for each ID in the thread
- `markThreadUnread(messageIds)` — `.markUnread()`
- `starThread(messageIds)` — `.star()`
- `unstarThread(messageIds)` — `.unstar()`
- `markAllRead(allMessageIds)` — same as above across every thread on
  the page

These are **native Apps Script Gmail calls** — no external auth flow, no
connector, no result-pairing logic. This is the single biggest
simplification in this rebuild: REVIEW.md's finding C2 (Gmail action
"success" was inferred from the model calling a tool, never from
checking whether Gmail's actual response indicated success) cannot
recur here, because there's no model, no tool call, and no MCP layer in
this path at all — just a direct, synchronous Apps Script API call that
either succeeds or throws.

Client-side: keep the optimistic-UI pattern (flip the dot/star instantly,
revert on a thrown error from the server call) — this was correct in the
original build and the pattern still applies.

---

## Source data format (unchanged — reference only)

```
HEADER
Run Timestamp: 2026-08-26 04:06:51
Date Covered: 2026-08-25
Time Window: 2026-08-25 00:00:00 to 2026-08-25 23:59:59
Total Emails: 62
Total Threads: 43

INVENTORY
1 | 2026-08-25 01:08 | myPATH <RV-DoNotReply@pa.gov> | New Pennsylvania Department of Revenue Correspondence
...

--------------------------------------------------

DETAILED APPENDIX

===== EMAIL 1 OF 62 START =====
Timestamp: 2026-08-25 01:08:22
From: myPATH <RV-DoNotReply@pa.gov>
Subject: New Pennsylvania Department of Revenue Correspondence
Message ID: 1a03751d21b2221c
Thread ID: 1a03751d21b2221c
Body Length: 412
Truncated: no

Body:
<body text, may span many lines>

===== EMAIL 1 OF 62 END =====

--------------------------------------------------
```

- Bodies are truncated at 5,000 chars by the existing Apps Script
  (`MAX_BODY_CHARS`). `Truncated: yes` should trigger the same on-demand
  full-body fetch pattern as before — but now via native
  `GmailApp.getMessageById(id).getPlainBody()`, not an MCP call.
- Bodies under 120 chars arrive as the literal string
  `Low text content / possibly image-heavy email` — skip these
  client-side without a summarization call, same as before.

---

## New consideration specific to this architecture

**Cost estimate — revised, and stated as a range rather than a false-precise
number.** Bodies truncate at 5,000 chars (~1,500 tokens), and each
summarization call also carries the tool schema and instructions as
input, so per-call input is realistically 1,500–2,500 tokens, not the
~800 originally assumed. Output is the real measured 71–828 tokens
(p95=523). On Haiku 4.5 ($1/$5 per million input/output tokens), a busy
43-thread day is roughly:
- Input: 43 × ~2,000 tokens ≈ 86,000 tokens → ~$0.09
- Output: 43 × ~400 tokens ≈ 17,000 tokens → ~$0.09
- **Roughly $0.15–0.20/day, ~$5–6/month** run daily.

Still cheap, still far under any real budget concern — but stated
honestly as an estimate with real assumptions shown, not as a single
confident figure. Actual cost should be checked against the real
Anthropic Console usage dashboard after the first week of real runs.

**Should summarization use the standard (synchronous) API or the Batch
API?**

The Batch API is a flat 50% discount, but batch jobs are asynchronous —
results aren't available immediately, which doesn't fit neatly into a
single 4am trigger run expecting to finish and have the digest ready.
Using it would require a second trigger (submit at 4am, poll and finalize
later, e.g. 4:30am), adding real complexity for a savings of roughly
$2–3/month at current usage.

**Recommendation: skip the Batch API for the initial build.** Use the
standard synchronous API with `UrlFetchApp.fetchAll()` for concurrency.
Revisit Batch only if cost becomes a real concern later — it isn't, at
these volumes.

**Model choice: decided — start with Haiku 4.5**
(`claude-haiku-4-5-20251001`) for summarization, not Sonnet. This is a
straightforward extraction/summary task well within Haiku's capability,
at roughly a fifth the cost. Still validate summary quality against a
real day's data as part of verification — if quality is genuinely
inadequate (not just "slightly different from Sonnet's style," but
missing real information a summary needs), flag it to Mason with
concrete examples rather than silently switching models. Sonnet is the
fallback if needed, at a higher but still small monthly cost.

**Prompt caching:** likely not usable here. Cached prefixes have a
minimum length (~1,024 tokens standard, ~2,048 for Haiku specifically),
and this task's system prompt plus tool schema probably won't clear that
bar. Don't build caching logic on the assumption it will trigger — verify
the actual prompt token count first if you want to pursue this at all.

---

## Known hazards for this architecture

### AS1. Apps Script execution time limit

**Confirmed: this is a personal/free Gmail account, so the limit is
6 minutes per execution** (not the 30-minute Workspace limit — that does
not apply here). Summarization across ~40+ threads must run concurrently
via `fetchAll()`, not sequentially. **Test against the real, largest
known report (`daily_inbox_report_2026-08-25.txt`, 43 threads) and
confirm total execution time with real API calls, not an estimate.** If
concurrent batching still risks the 6-minute ceiling on the busiest
realistic day, consider splitting report-generation and summarization
into two separate triggers (e.g. 4:00am and 4:10am) so each stays well
under the limit independently, rather than trying to fit both in one run.

### AS2. `PropertiesService` storage limits

`ScriptProperties`/`UserProperties` cap at 9KB per value and 500KB total.
Digest JSON for a busy day will exceed this easily. **Use Drive for
digest storage, not PropertiesService.** Reserve PropertiesService for
small values only — specifically the API key (see AS4).

### AS3. Web app access control

A web app serving inbox contents is sensitive by nature. Deploy with:
- **Execute as:** Me
- **Who has access:** Only myself

This gates access behind Mason's Google login — functionally equivalent
to how the artifact was already private to his account, but now
enforced by Google's own auth rather than claude.ai's session model.
Confirm this setting explicitly during deployment; don't rely on the
default.

### AS4. API key storage

Store the Anthropic API key in `PropertiesService.getScriptProperties()`,
set once via the Apps Script editor's Project Settings UI (not
hardcoded in source, not stored in a Drive file, not logged anywhere).
This is private to the script owner, unlike, notably, the environment
variable field Mason encountered in a different tool during this
project's earlier debugging, which explicitly warned that values there
were visible to anyone using that environment — Apps Script's
`ScriptProperties` doesn't have that exposure.

### AS5. Re-authorization required

Adding `UrlFetchApp` calls to external domains (`api.anthropic.com`) and
publishing a web app both require Mason to go through a fresh OAuth
consent screen the first time. This is expected, one-time, not a bug.

### AS6. `HtmlService` sandbox and `google.script.run` are callback-based

Client-side code runs in a sandboxed iframe. `google.script.run` calls
use `.withSuccessHandler()`/`.withFailureHandler()` callbacks, not
Promises natively (though wrapping in a Promise is a common, fine
pattern if preferred for readability). This is a real API difference
from `fetch()`-based calls in the old artifact — don't assume
async/await drops in unchanged.

### AS7. Daily trigger quota

Apps Script enforces a 90-minutes-per-day total trigger execution quota
across all triggers in a project. A ~1-minute daily run is nowhere near
this, but worth knowing as a ceiling if this system grows.

### AS8. Silent 4am failures

If the summarization step fails partway (network error, API outage,
quota exhausted), the digest JSON should reflect that state honestly —
per-thread error info, not a missing file with no explanation. Add a
manual "regenerate" action in the web app so Mason can retry a failed or
partial day without needing to touch the script directly.

### AS9. Deployment URL stability — this requires a specific action, it is not automatic

**Apps Script generates a brand-new `/exec` URL every time you create a
new deployment.** Simply publishing more code does not keep the URL
stable by default — if Claude Code (or a future session) creates a fresh
deployment for each change, Mason ends up with the exact same
bookmark-churn problem this rebuild is meant to solve (see H7 in the
original artifact's history).

**The correct pattern:** create one deployment, then for every future
code change, use "Manage deployments" → edit the existing deployment →
select "New version" and deploy **under that same deployment ID**. This
keeps the `/exec` URL constant indefinitely. Document the deployment ID
somewhere Mason can find it, and make this the explicit, only way updates
get shipped going forward — not something left to whoever happens to be
doing the next update.

---

## Technical constraints

- Apps Script V8 runtime (modern JS features available: arrow functions,
  `const`/`let`, template literals, destructuring — but no ES modules;
  everything is global-scope function declarations across script files).
- `UrlFetchApp.fetch()` / `.fetchAll()` for all external HTTP calls
  (Anthropic API). No `fetch()` global — that's a browser/Node API,
  unavailable in the server-side Apps Script context.
- `HtmlService.createTemplateFromFile()` or
  `HtmlService.createHtmlOutputFromFile()` for the served page.
- try/catch around every `UrlFetchApp` call and every `GmailApp` call —
  both can throw (network issues, deleted messages, permission changes).

---

## Build sequence

Work through this in order, verifying each checkpoint against real data
before moving to the next — this sequencing is what made the original
build's verification actually catch real bugs, rather than everything
being reviewed only once at the very end.

1. **Report parsing**, ported from the artifact's proven logic. Test
   against both the real Aug 25 (43-thread) and Aug 1 (7-thread) reports
   already in Drive.
2. **Thread grouping and the digest JSON writer**, producing output
   matching the schema above. Verify the schema is actually valid JSON
   and matches the spec, before wiring up summarization.
3. **Summarization**, one call per thread via forced tool-use, writing
   into the schema's `summary`/`summaryStatus`/`summaryError` fields.
   Measure real execution time against the full Aug 25 report per AS1
   before considering this step done.
4. **The served web page** (`doGet`), reading a real digest JSON produced
   by step 3 — not a hand-crafted test fixture — and rendering the
   three-section scroll layout with real data.
5. **Gmail actions** (`google.script.run` functions), tested against real
   messages in the real inbox.
6. **Real-time read/star state on load**, verified by manually starring
   or reading a message directly in Gmail beforehand and confirming the
   digest reflects it correctly.
7. **Mobile pass** — viewport meta tag, `setXFrameOptionsMode`, and an
   actual test on a phone browser via the bookmarked deployment URL.
8. **Deployment stability check (AS9)** — make one small code change
   after the initial deployment and confirm the URL does not change.

## Verification standard — carry this forward, it's non-negotiable

The single most important lesson from this project's history: **every
previous "fix" that was only verified by code review or simulation
turned out to be wrong once tested against the real API and real data.**
Two full rounds of bugs (token-budget truncation, then a JSON-escaping
bug hiding behind it) were only caught because Mason tested the live
artifact and reported real failure counts back — not because any
automated check caught them first.

For this rebuild:

- Test the real 4am trigger flow against **actual Drive files**,
  including the real 43-thread Aug 25 report and a real quiet day (Aug 1,
  7 threads) — both already exist in the "Inbox Reports" Drive folder.
- Test Gmail actions against **real messages** in the real inbox, not
  just code review of the `GmailApp` calls. This is now actually possible
  to do end-to-end, from within Apps Script's own test-execution
  environment, which was never true for the old MCP-based approach.
- Do not report any part of this as "done" without real evidence.
  Simulated or assumed-correct claims are exactly what caused the
  previous two rounds of failures.

---

## Out of scope for this rebuild

Same exclusions as the original project:

- Search / filter across the digest
- "X of Y read" progress counter
- Batch API (deferred — see "New consideration" above)
- Any email-sending behavior

## Status of the old artifact

**Decided: the Claude.ai artifact (`inbox-digest.jsx`) is abandoned, not
kept as a fallback.** Full focus is on this rebuild. Its code and full
debugging history remain in this repo as reference material (per "What
carries over" above) but no further work should go into maintaining or
fixing the artifact itself going forward.
