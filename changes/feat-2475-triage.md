### Added

- **Mailbox-scoped inbox rules** — an optional `Mailbox:` line limits a rule to named mailboxes. (#2475)
- **Rules on mailbox removal** — rules scoped only to a removed mailbox are deleted or moved. (#2475)

### Changed

- **Sent-observe and learning state** — watermarks and learning keys are per mailbox; a failing mailbox moves no other. (#2475)
- **Urgent, digest and consult lines** — name the mailbox when there is more than one. (#2475)
- **Mail from the principal's other address** — only marked Seen, never drafted, sent to or escalated. (#2475)
