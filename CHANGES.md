# Polish round 1 — apps-script/Index.html only

No server (.gs) changes; every google.script.run name and argument is unchanged.

- **B1** Contents numbering — before: "1. 1. Subject" (the `<ol>` number plus a manual number). After: the `<ol>` number only.
- **F1** Contents sender — before: subject only. After: "Subject — Sender", with the display name only (no `<email>`, no trailing " via X" / " (via X)"); several senders show as "First +N"; "(N messages on this date)" is kept.
- **B5** Summary markdown — before: literal `**Key messages**`. After: `**` is stripped when the page displays it; stored digests are unchanged.
- **B6** Read toggle — before: one badge showed the state and was also the toggle. After: a non-clickable "● Unread"/"Read" chip plus a separate "Mark read"/"Mark unread" button. Star works as before. Both buttons are disabled while their request runs, and they now also revert when the server returns `{failed:[…]}`, not only when it throws.
- **F2** Mark all read — before: no feedback, failure handler only. After: the button is disabled with "Marking N threads read…", then "Done: N threads marked read", or a red error that names the failed thread(s) and the Gmail error. Threads that failed are reverted. No confirmation dialog.
- **B7** Back-to-top — before: a 48px button over the text on phones. After: 32–36px, and below 900px it sits in a reserved right gutter so it never covers text.
- **B2** Horizontal scroll — before: the page was up to 5,600px wide, caused by unbroken tracking URLs of up to ~1,500 characters in `pre-wrap` email bodies; this also made the navy jump bar stop short. After: text containers use `overflow-wrap:anywhere`, and scrollWidth equals clientWidth at 390px and 1280px.
