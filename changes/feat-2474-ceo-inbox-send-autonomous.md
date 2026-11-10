### Added

- **Autonomous inbox replies** — under routine or all, triage sends low-stakes replies from the principal's mailbox. (#2474)
- **Left-as-draft digest items** — every autonomous reply Curia didn't send is reported with the reason. (#2474)
- **Setup: replies from your mailbox** — optional setup step for choosing the `ceo_inbox/sending` level. (#2474)

### Security

- **Autonomous replies never share new information** — Curia's own replies sharing anything not already on the thread are held as drafts. (#2474)
- **Autonomous reply limits** — daily cap of 10, latest message only, no bank or card details, stricter list detection. (#2474)
- **Send ledger protection** — agents can't write the mailbox send ledger; it stores reason codes, not text. (#2474)
