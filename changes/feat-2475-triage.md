### Added

- **Reply from the addressed copy** — drafts go from the mailbox the sender wrote to, if verified. (#2475)
- **Extraction provenance** — checkpoint facts and relationships record the mailboxes a conversation touched. (#2475)
- **Mailbox-scoped inbox rules** — an optional `Mailbox:` line limits a rule to named mailboxes. (#2475)
- **Rules on mailbox removal** — rules scoped only to a removed mailbox are deleted or moved. (#2475)
- **Mailbox admin audit** — console mailbox add, default, grant, relabel and removal publish `principal_mailbox.changed` audit events. (#2475)

### Changed

- **Sent-observe and learning state** — per-mailbox state; three failed runs in a row fail the health check. (#2475)
- **Urgent, digest and consult lines** — name the mailbox when there is more than one. (#2475)
- **Mail from the principal's other address** — only marked Seen, never drafted, sent to or escalated. (#2475)
