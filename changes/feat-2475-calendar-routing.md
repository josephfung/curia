### Added

- **Calendar per mailbox** — each mailbox's calendar is registered on add; calendars record their mailbox. (#2475)
- **Event identity (public API)** — calendar events now carry `icalUid` and `organizerEmail`. (#2475)
- **`calendar-list-events` (public API)** — a meeting on two accounts lists once, with `calendars` naming each copy. (#2475)
- **Account choice for meetings** — create-event and create-hold fail with `needs_mailbox` and evidence when unsure, before approval. (#2475)

### Changed

- **`calendarRouter` (public API)** — ToolContext capability `calendarRouter` replaces `nylasCalendarClient`; calls route through each calendar's mailbox. (#2475)
- **Calendar `mailbox` input (public API)** — every calendar tool takes `mailbox`; bare `primary` needs one with several accounts. (#2475)
- **`needs_mailbox` (public API)** — create-event and create-hold return it as an error, no longer a success output. (#2475)
- **`calendar-register`** — needs a connected principal mailbox; registers through that mailbox. (#2475)
- **`calendar-register` and `calendar-list-calendars` (public API)** — outputs now declare `moved_from_mailbox`, `note`, per-calendar mailbox fields and `warnings`. (#2475)
- **`calendar-respond-to-invite` (public API)** — `account` is replaced by `mailbox`, required with several accounts. (#2475)
- **RSVP account** — invites are answered from the arrival mailbox, matched by iCal UID and details. (#2475)
- **Calendar writes** — a stated mailbox that does not own the calendar is refused; nothing changes. (#2475)
- **Holds** — placed on the chosen account's calendar; release and the nightly sweep cover every account. (#2475)

### Fixed

- **`calendar-create-event`** — a hold left in place after a failed release is now reported in `warnings`. (#2475)

### Security

- **Meeting identity** — copies merge only when organizer, location and video link also match; spoofed copies stay separate. (#2475)
- **`calendar-register`** — a principal calendar must be one its mailbox's account can see. (#2475)
- **Calendar writes** — an unregistered calendar another account owns is refused through an account it is shared into. (#2475)
- **`calendar-respond-to-invite`** — the hold cleanup window is capped at 30 days. (#2475)
