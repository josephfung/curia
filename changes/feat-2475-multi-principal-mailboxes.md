### Added

- **Principal mailboxes** — mailboxes are now a registry, upgraded automatically and managed as a list in the console. (#2475)
- **Mailbox health canary** — each principal mailbox gets its own check; an outage alerts you once. (#2475)
- **Setup catalog** — new "Principal mailboxes and calendars" entry reports done once a mailbox is healthy. (#2475)

### Changed

- **`nylas_calendar` canary** — replaced by per-mailbox checks; the default mailbox still drives its heartbeat. (#2475)
- **System notices** — now go to the principal's primary email, not the first verified address. (#2475)
- **Console principal mailbox** — the single grant and address fields became a list of mailboxes. (#2475)

### Security

- **Principal identity** — a defunct or bounced principal address no longer resolves with principal standing. (#2475)
