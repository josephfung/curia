### Changed

- **Send stakes** — re-confirming an agreed time and offering open slots now send as routine at 80+.
- **Band gating** — a direct instruction from the principal counts as approval; Curia picks open details itself.
- **Sender authentication** — the web console (chat and voice) and Signal calls now authenticate the principal.

### Fixed

- **Send review grounding** — the principal's own message and this turn's lookups now count as support.
- **Send review** — a send blocked after its rewrite is held for the principal instead of looping.
- **Held sends** — only an identical resend reuses a hold; other messages get their own review.
- **Outbound filter** — principal-directed sends may carry the financial or ID data asked for; secrets stay blocked.
- **Outbound filter** — an unauthenticated follow-up or an uncut forward never counts as the principal's request.
- **Disclosure asks** — a "may I share?" question survives a steering hold; approvals name the contact.
- **Content-block rewrites** — keep the original sender's trust context, so the principal is never answered as an outsider.
- **`ceo-inbox-send-draft`** — refuses an unconfirmed batch send until the drafts are read back.
- **Behavior gate cases** — fixed stale dates, a judge misread, an over-strict triage check, and the reschedule case.
- **Scenario principal** — gains a permanent verified Signal number, so Signal turns reach the principal.
