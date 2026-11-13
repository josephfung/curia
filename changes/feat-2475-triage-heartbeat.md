### Added

- **Triage heartbeat** — a 15-minute code heartbeat replaces the hourly cron and starts the inbox drain. (#2475)
- **Per-mailbox cadence and windows** — each mailbox gets its own interval and weekday window. (#2475)
- **Triage start line** — mail older than a mailbox's start line is never triaged. (#2475)
- **Backlog alarm** — over 100 untriaged messages in a mailbox alerts the principal once. (#2475)
- **Daily triage ceiling** — a drain stops after 120 batches in a day. (#2475)
- **Triage-paused notice** — new `inbox_triage_paused` notification emails the principal once a day when the ceiling stops triage. (#2475)
- **Triage health check** — `principal_mailbox_triage` fails when inbox triage stops, stalls or keeps failing. (#2475)
- **Triage capability** — skills get `ToolContext.triageServices` for cadences, triage state and dedupe claims. (#2475)
- **Cross-mailbox dedupe** — a message delivered to two mailboxes is triaged once. (#2475)

### Changed

- **Triage cadence** — `ceo_inbox/triage` is pinned for ceo-inbox, validated and changeable in conversation. (#2475)
- **Triage window** — triage follows each mailbox's window; drains pause at window end. (#2475)

### Security

- **Code-owned inbox state** — config-store refuses writes to triage, sent-observe and voice-learning state keys. (#2475)
