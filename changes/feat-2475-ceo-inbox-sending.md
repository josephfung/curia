### Added

- **ceo-inbox `mailbox` input** — every ceo-inbox tool takes an optional mailbox; Curia finds the object's account. (#2475)
- **Cross-mailbox list and search** — listing and searching cover every principal mailbox, newest first. (#2475)
- **Compose account choice** — `ceo-inbox-draft-compose` returns per-account evidence and needs a mailbox once more than one exists. (#2475)
- **Move a draft between accounts** — `ceo-inbox-draft-edit` takes `move_to_mailbox`; moved drafts keep their authorship class. (#2475)
- **Scenario cases 46a–46h** — account choice, send-my-draft across mailboxes, move correction, standing preference. (#2475)

### Changed

- **Sending (spec 15)** — sends go from the draft's mailbox at that mailbox's own `ceo_inbox/sending` level. (#2475)
- **Autonomous limits** — the 10-a-day cap and thread cooldown now span every mailbox and conversation. (#2475)
- **Limit holds** — daily-limit and cooldown waits are reported apart from judgement holds. (#2475)
- **Acquaintance** — a contact counts as known when any principal mailbox has sent to them. (#2475)
- **`principalMailboxes` (public API)** — narrowed for skills: no member returns credentials. (#2475)
- **Operational stops** — a failed check no longer starts a thread cooldown or reads as held. (#2475)
- **Reply-all** — excludes every principal address, not just the sending mailbox's. (#2475)
- **Principal-address refusals** — autonomous replies to or from another principal address stay drafts. (#2475)
- **`ceo_inbox/sending` writes** — config-store refuses keys that are not live mailbox ids. (#2475)
