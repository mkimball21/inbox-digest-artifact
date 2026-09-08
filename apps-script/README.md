# Inbox Digest — Apps Script web app

Rebuild of `inbox-digest.jsx` (this repo's original Claude.ai artifact) as a
Google Apps Script web app. Built to `apps_script_digest_handoff.md`'s spec;
see `VERIFICATION.md` for exactly what was and wasn't verified, and how.

**The old artifact is abandoned, per the handoff.** This is the active
version going forward.

## Files

| File | Purpose | Verification |
|---|---|---|
| `DigestParsing.gs` | Report parsing, thread grouping | ✅ Fully verified (real data) |
| `DigestBuilder.gs` | Digest JSON schema + 4am-trigger entry point | ✅ Fully verified (real data) |
| `Summarize.gs` | Forced tool-use summarization via `UrlFetchApp` | ✅ Fully verified (real Anthropic API) |
| `GmailActions.gs` | Native `GmailApp` read/star actions | 🟡 Logic-verified via Gmail MCP stand-in |
| `WebApp.gs` | `doGet` + `google.script.run` server functions | ⚪ Code-complete, not live-verified |
| `Index.html` | The served page | ⚪ Code-complete, not live-verified (rendering logic checked against real data) |
| `example-digest-2026-08-01.json` | A real, real-summarized digest — reference for the schema shape | Real output from steps 1-3 |

## Setup — one-time

### 1. Add the files to your existing "Gmail Daily Archive Script" project

This rebuild adds to the same Apps Script project that already runs
`sendYesterdayInboxCompilation` — it does not touch that function's report
format or Drive-save logic. In the Apps Script editor:

1. For each `.gs` file above, create a new script file (Files → + → Script)
   with the same name and paste in the content.
2. For `Index.html`, create a new HTML file (Files → + → HTML) named
   `Index` and paste in the content.

### 2. Set your Anthropic API key (AS4)

Project Settings (gear icon) → Script Properties → Add script property:

- Property: `ANTHROPIC_API_KEY`
- Value: your own Anthropic API key

This is read by `Summarize.gs` via `PropertiesService.getScriptProperties()`
— private to the script owner, never hardcoded, never in a Drive file,
never logged.

### 3. Hook the digest generation into your existing 4am trigger

At the end of your existing report-generation function — right after it
saves the `.txt` report to Drive — add one line:

```js
generateDigestForDate(dateStr, rawReportText);
```

passing the same date string and report text your existing code already
has in scope (variable names will match whatever your existing function
calls them). If you'd rather not touch that function's body at all, add a
**separate** time-driven trigger a few minutes after the existing one
(e.g. 4:10am) that calls `generateDigestForDate()` with no arguments — it
will read yesterday's `.txt` back from Drive itself. See `DigestBuilder.gs`'s
comment on `generateDigestForDate` for the tradeoffs, and
`VERIFICATION.md`'s AS1 note on why the combined-runtime question is worth
checking on your first real run either way.

### 4. Deploy as a web app

Deploy → New deployment → Select type: **Web app**.

- **Execute as:** Me
- **Who has access:** Only myself

(AS3 — confirm this explicitly; don't rely on whatever the dialog defaults
to.)

Click Deploy. The first deployment will prompt a fresh OAuth consent screen
(AS5 — expected, one-time, because this now calls an external domain
`api.anthropic.com` and publishes a web app). Copy the `/exec` URL it gives
you and bookmark it.

### 5. All future code changes — AS9, read this before you push anything

**Do not create a new deployment for every update.** Apps Script generates
a brand-new `/exec` URL every time you create a new deployment — this is
exactly the bookmark-churn problem this rebuild exists to solve.

The correct pattern, every time, forever:

1. Edit the code in the Apps Script editor.
2. Deploy → **Manage deployments**.
3. Click the pencil/edit icon on your existing (only) deployment.
4. Version: select **New version**.
5. Click Deploy.

This keeps the `/exec` URL constant indefinitely. Write your deployment ID
down somewhere you'll find it — it's the only thing that makes this
guarantee hold.

## Digest JSON schema

Defined in `apps_script_digest_handoff.md`; `example-digest-2026-08-01.json`
in this directory is a real example (real report, real Anthropic API
summaries) matching it exactly. Any change to this schema is a change to a
contract between `DigestBuilder.gs`/`Summarize.gs` (the writer) and
`WebApp.gs`/`Index.html` (the reader) — update both sides together, and
note the change here.

## What to verify live, and in what order

See `VERIFICATION.md`'s "What you need to verify live, in order" section —
it's ordered specifically so an earlier failure (e.g. execution time) is
caught before you spend time on a later step (e.g. mobile) that depends on
it working at all.
