# Inbox Digest

A single-file Claude.ai artifact (`inbox-digest.jsx`) that turns one day's
archived inbox report into a scrollable digest with inline Gmail actions.
Built against `inbox_digest_handoff.md`; see that document for full
requirements, the "Known hazards" (H1–H8), and the decisions log this
implementation follows.

`inbox_compilation_updated.gs`, the upstream Apps Script that writes the
daily report to Drive, was **not modified** — H2 (below) passed, so the
pre-approved chunked-file fallback was never needed.

## How to use it

Paste `inbox-digest.jsx` into a Claude.ai artifact with the Google Drive and
Gmail connectors enabled. Pick a date; the digest generates once. Bookmark
that specific artifact URL — per H7, republishing forks to a new URL with
empty `window.storage`, so a re-publish means regenerating every date you
care about again.

## H2 verification (done first, before any other code)

`daily_inbox_report_2026-08-25.txt` was fetched from the "Inbox Reports"
Drive folder (`1bZFXxjhcpSSYShN03YSiZbuhBIoqno5C`) via `download_file_content`
— never `read_file_content`, per H1 — and base64-decoded.

- Drive reported the file at **209,969 bytes**; the decoded content was
  **exactly** 209,969 bytes.
- All **62/62** `===== EMAIL n OF 62 START/END =====` marker pairs were
  present, and the final marker, `===== EMAIL 62 OF 62 END =====`, was
  intact.
- No truncation occurred anywhere in the round trip.

Result: the fetch is reliable at this size. The chunked-file Apps Script
fallback was **not** applied.

Thread grouping was then cross-checked against the same real data: the
"[DIG] HVAC referral - lower Bucks" chain has 6 messages, 6 distinct
Message IDs, and one shared Thread ID (`1a03a26a4fc841ef`) — confirming
Message ID and Thread ID do diverge in practice and that grouping must key
on Thread ID (section 3 of the handoff).

## Architecture notes

The artifact never calls Drive or Gmail directly. It POSTs to
`https://api.anthropic.com/v1/messages` with an `mcp_servers` entry pointing
at the relevant MCP connector, and a tightly-scoped instruction telling the
model exactly which tool to call and with what arguments; the actual data
comes back in `mcp_tool_result` content blocks, which are extracted by
`type`, never by array position.

- **H3 (prompt injection):** summarization calls (`summarizeBatchRaw`) pass
  `mcpServers: []`. `callMessagesAPI` only ever sets the request's
  `mcp_servers` key when a non-empty array is passed in — so a
  summarization request never carries `mcp_servers` at all, Gmail included.
  This is enforced by the call-construction code itself, not by convention;
  see the comments at both call sites in `inbox-digest.jsx`. Every Gmail
  action prompt (`buildGmailActionPrompt`) interpolates only message IDs and
  the fixed tool/labelIds constants — never a subject, sender, or body.
- **H4 (batching/concurrency):** batches are sized to an *estimated
  output-token budget* (`planSummaryBatches`/`estimateThreadOutputTokens`,
  calibrated 2026-08-27 against 47 real Messages API calls — see
  `test/README.md`), not a flat thread count. Summarization uses
  Anthropic's `tools` param with a forced `tool_choice`
  (`submit_thread_summary`, called once per thread) rather than asking the
  model to hand-write a JSON array as text — a real, live-verified failure
  was a well-formed-looking response that still broke `JSON.parse` because
  the model quoted source text without escaping the inner quotes;
  structured tool output can't have that failure mode. (`tools` here is
  unrelated to `mcp_servers`/H3 — it grants the model no external
  capability, only a local output-format contract, and is never combined
  with `mcp_servers` in the same request.) Any threadId missing from a
  batch's result — including a partial miss, where some but not all
  per-thread tool calls landed before `max_tokens` cut the rest — is
  retried automatically: as a half-split if the whole batch overflowed
  with nothing back, or as a same-size retry of just the missing subset
  otherwise, bounded so a persistently-uncooperative thread can't loop
  forever. Concurrency starts at 3 (not 4) and steps down toward 1 if
  429/529 is observed; `callWithRetry` retries 429/500/502/503/529 and
  network errors with jittered backoff. Low-text placeholder bodies are
  skipped client-side before ever reaching a summarization call. A failed
  summary's card shows the actual captured error, not just "failed to
  generate."
- **H5 (navigation):** all jump links use React refs + `scrollIntoView`,
  never hash anchors. Verified in both directions — see `test/README.md`.
- **H6 (bulk Gmail actions):** message IDs for every action are filtered
  against the set of IDs the parser actually extracted from the report
  before firing, chunked into batches of 15, run 3-way concurrent, and
  cross-checked against the response's own `mcp_tool_use` blocks — an ID
  that isn't confirmed called is treated as failed, not assumed to have
  succeeded.
- **H7 / H8 (storage):** `window.storage` only, keyed `digest:YYYY-MM-DD`.
  `localStorage`/`sessionStorage` do not appear anywhere in the file. Every
  read is wrapped in try/catch, since a missing key throws rather than
  returning null.

## Verification performed

Because this file targets Claude.ai's own artifact runtime (which this
session can't launch directly), verification split three ways:

1. **Real data, real MCP calls** — H2's fetch test above ran against the
   live Drive folder via this session's own Google Drive connector.
2. **Real component tree, stubbed network** — `test/` bundles the identical
   component (parser, grouping, refs, scroll nav, optimistic UI, caching
   logic unchanged) with only the five Messages-API-calling functions
   swapped for deterministic stubs, and drives it with Playwright against
   the real 2026-08-25 report text. See `test/README.md` for exactly what
   was run and what passed — 43/43 threads, correct HVAC thread collapse,
   two-directional scroll nav, "Mark all read" including a starred thread,
   zero re-fetch/re-summarization on a second load, and on-demand full-body
   load all confirmed there.
3. **Real summarization pipeline, real Messages API, real spend** — given a
   temporary API key for testing only (never committed), `test/live-verify.mjs`
   runs the actual, unmodified summarization code (sliced live out of
   `inbox-digest.jsx`, never a hand copy) against the real API for a real
   43-thread day and a real 7-thread day. This is what caught a second,
   distinct failure mode a mock could not have (a JSON-escaping bug in
   freeform model output) and confirmed the fix: **41/41 and 6/6
   summarized, 0 failures, both dates, real API.** Full writeup in
   `test/README.md`.

What is **not** independently verified: the exact shape Claude.ai's
`mcp_servers` / `mcp_tool_result` wire format takes at runtime for the
Drive/Gmail calls specifically (this was built to the handoff's
description of that contract — only the summarization path, which doesn't
use `mcp_servers` at all, was live-API-verified) and Anthropic API rate
limiting under real 4-5-way concurrent load (mitigated by the concurrency
step-down and broadened retry, but not stress-tested at that volume).

## Out of scope (per the handoff)

Search/filter, a read-progress counter, any email-sending behavior, and any
Apps Script changes beyond the pre-approved (and, per H2 above, unused)
chunking fallback.
