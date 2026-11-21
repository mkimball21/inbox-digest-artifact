# Polish round 1 — apps-script/Index.html only

No server (.gs) changes; every google.script.run name and argument is unchanged.

- **B1** Contents numbering — before: "1. 1. Subject" (the `<ol>` number plus a manual number). After: the `<ol>` number only.
- **F1** Contents sender — before: subject only. After: "Subject — Sender", with the display name only (no `<email>`, no trailing " via X" / " (via X)"); several senders show as "First +N"; "(N messages on this date)" is kept.
- **B5** Summary markdown — before: literal `**Key messages**`. After: `**` is stripped when the page displays it; stored digests are unchanged.
- **B6** Read toggle — before: one badge showed the state and was also the toggle. After: a non-clickable "● Unread"/"Read" chip plus a separate "Mark read"/"Mark unread" button. Star works as before. Both buttons are disabled while their request runs, and they now also revert when the server returns `{failed:[…]}`, not only when it throws.
- **F2** Mark all read — before: no feedback, failure handler only. After: the button is disabled with "Marking N threads read…", then "Done: N threads marked read", or a red error that names the failed thread(s) and the Gmail error. Threads that failed are reverted. No confirmation dialog.
- **B7** Back-to-top — before: a 48px button over the text on phones. After: 32–36px, and below 900px it sits in a reserved right gutter so it never covers text.
- **B2** Horizontal scroll — before: the page was up to 5,600px wide, caused by unbroken tracking URLs of up to ~1,500 characters in `pre-wrap` email bodies; this also made the navy jump bar stop short. After: text containers use `overflow-wrap:anywhere`, and scrollWidth equals clientWidth at 390px and 1280px.

# Polish round 2 — apps-script/Index.html only

No server (.gs) changes; every google.script.run name and argument is unchanged.

- **#1 Counts line** — before: none. After: "N emails across M threads" under the title, read from the digest's `totalEmails` / `totalThreads` (falls back to counting if an older digest lacks them).
- **#2 Contents time** — before: "Subject — Sender". After: "Subject — Sender 07:22" (time of the thread's earliest message); the "(N messages on this date)" note is kept.
- **#3 Summary From/Received** — before: `participantsLine()`, multi-message threads only, raw names with quotes and "via …". After: labeled "From: Name" (+N for more senders) and "Received: 07:22" or "Received: 07:22 to 17:40 (5 messages)" on every card, using the same `senderDisplayName()` as Contents. `participantsLine()` is removed.
- **#4 Full-email sender** — before: raw "Name <email>" only. After: the clean name in bold with HH:MM, and the raw "Name <email>" kept below it, small and muted.
- **#5 Item numbers** — before: summary and full-email titles had no number. After: "7. Subject" in both, matching the Contents `<ol>`. Contents still shows one number per item.
- **#6 Jump targets** — before: jumps landed under the sticky navy bar. After: `scroll-margin-top` puts the card or section heading about 15px below the bar.

# Polish round 3 — apps-script/Index.html only

No server (.gs) changes; every google.script.run name and argument is unchanged.

- **Open in Gmail** — before: no link to the original email. After: a small "Open in Gmail ↗" link on every message's sender line in Full emails, and on every summary card, which opens the thread's latest message. The link is `https://mail.google.com/mail/?authuser=mkimball1021@gmail.com#all/thread-f:<thread ID as decimal>|msg-f:<message ID as decimal>`, converted from hex with BigInt. It opens in a new tab (`target="_blank" rel="noopener"`) and never toggles, scrolls or calls the server. It is hidden when an ID isn't valid hex.
- **Mark all read confirmation** — before: it ran immediately. After: an inline "Mark N threads read? Yes / Cancel" appears first, with no browser dialog. Cancel sends nothing, and switching dates closes an open confirm. Starred threads are still marked read.
