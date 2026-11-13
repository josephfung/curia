### Added

- **Several principal mailboxes** — the one-mailbox cap is lifted; connect work and personal accounts together. (#2475)
- **Calendar per mailbox** — each mailbox's calendar is registered on add; calendars record their mailbox. (#2475)
- **Availability across accounts** — `calendar-find-free-time` and `calendar-check-conflicts` read every account's calendar. (#2475)
- **`calendar-find-free-time` (public API)** — new `treat_as_free` input; outputs `blocking`, `treated_as_free`, `treat_as_free_unmatched`, `note`. (#2475)
- **Availability outputs (public API)** — both availability tools add `partial`, `removed` and `freebusy_via` (with `fell_back_from`). (#2475)
- **`calendar-check-conflicts` (public API)** — conflicts add `eventId`, `title`, `calendar_label`; `clear` is false when a calendar is unread. (#2475)
- **Event identity (public API)** — calendar events now carry `icalUid` and `organizerEmail`. (#2475)
- **`calendar-list-events` (public API)** — a meeting on two accounts lists once, with `calendars`; events add `meetingKey`. (#2475)
- **Account choice for meetings** — `calendar-create-event` and `calendar-create-hold` return `needs_mailbox` with evidence when unsure. (#2475)
- **Scenario cases 46k–46m** — meeting on the work calendar, cleaner not a conflict, availability across calendars. (#2475)

### Changed

- **`calendarRouter` (public API)** — ToolContext capability `calendarRouter` replaces `nylasCalendarClient`; calls route through each calendar's mailbox. (#2475)
- **Calendar `mailbox` input (public API)** — every calendar tool takes `mailbox`; bare `primary` needs one with several accounts. (#2475)
- **`calendar-register`** — needs a connected principal mailbox; registers through that mailbox. (#2475)
- **Calendar without restart** — calendar tools work as soon as a principal mailbox is added; no restart. (#2475)
- **Setup wizard** — the principal mailboxes task covers several accounts and points to Email & Calendar. (#2475)
- **`calendar-respond-to-invite` (public API)** — `account` is replaced by `mailbox`, required with several accounts. (#2475)
- **RSVP account** — invites are answered from the arrival mailbox, matched by iCal UID and details. (#2475)
- **Calendar writes** — a stated mailbox that does not own the calendar is refused; nothing changes. (#2475)
- **Holds** — placed on the chosen account's calendar; release and the nightly sweep cover every account. (#2475)
- **Meeting debrief (spec 17)** — guards key on the meeting, so one meeting on two calendars debriefs once. (#2475)
- **Calendar agent** — works across the principal's calendars; conflicts are judged against calendaring preferences. (#2475)
- **Mailbox add refusal (public API)** — `cap_reached` is now `migration_pending`, returned only while the upgrade finishes. (#2475)

### Removed

- **Flat mailbox vault keys** — `ceo_nylas_grant_id` and `ceo_self_email` are deleted at boot; the registry replaces them. (#2475)
- **Secrets page flat keys** — the Secrets page no longer accepts the two retired mailbox keys. (#2475)
- **Mailbox removal `restart_required`** — the remove route and console drop it; no change needs a restart. (#2475)

### Fixed

- **`calendar-holds-sweep`** — a mailbox-scoped sweep no longer counts other accounts' failures or removed mailboxes twice. (#2475)
