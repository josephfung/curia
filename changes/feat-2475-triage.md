### Added

- **Triage heartbeat** — a 15-minute code heartbeat replaces the hourly cron and starts the inbox drain. (#2475)
- **Per-mailbox cadence and windows** — each mailbox gets its own interval and weekday window. (#2475)
- **Triage start line** — mail older than a mailbox's start line is never triaged. (#2475)
- **Backlog alarm** — over 100 untriaged messages in a mailbox alerts the principal once. (#2475)
- **Daily triage ceiling** — a drain stops after 120 batches in a day. (#2475)
- **Cross-mailbox dedupe** — a message delivered to two mailboxes is triaged once. (#2475)
- **Reply from the addressed copy** — drafts go from the mailbox the sender wrote to, if verified. (#2475)
- **Extraction provenance** — checkpoint facts and relationships record the mailboxes a conversation touched. (#2475)
- **Mailbox-scoped inbox rules** — an optional `Mailbox:` line limits a rule to named mailboxes. (#2475)
- **Rules on mailbox removal** — rules scoped only to a removed mailbox are deleted or moved. (#2475)

### Changed

- **Triage window** — triage runs around the clock within each mailbox's window; drains pause at window end. (#2475)
- **Sent-observe and learning state** — watermarks and learning keys are per mailbox; a failing mailbox moves no other. (#2475)
- **Urgent, digest and consult lines** — name the mailbox when there is more than one. (#2475)
- **Mail from the principal's other address** — only marked Seen, never drafted, sent to or escalated. (#2475)
