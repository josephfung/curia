### Added

- **Several principal mailboxes** — the one-mailbox cap is lifted; connect work and personal accounts together. (#2475)
- **Availability across accounts** — `calendar-find-free-time` and `calendar-check-conflicts` read every account's calendar. (#2475)
- **`calendar-find-free-time` (public API)** — new `treat_as_free` input; outputs `blocking`, `treated_as_free`, `treat_as_free_unmatched`, `note`. (#2475)
- **Availability outputs (public API)** — both availability tools add `partial`, `removed` and `freebusy_via` (with `fell_back_from`). (#2475)
- **`calendar-check-conflicts` (public API)** — conflicts add `eventId`, `title`, `calendar_label`; adds `note` and `ignore_holds_unchecked`. (#2475)
- **`calendar-list-events` (public API)** — adds `meetingKey`, `partial`, `warnings` and `removed`; the principal's listing covers every account. (#2475)
- **Home calendar at boot** — every live mailbox, the migrated one included, gets its home calendar registered. (#2475)
- **Email & Calendar settings page** — Settings → Personality page for the principal's mailboxes; alerts when the Nylas key is missing. (#2475)
- **Scenario cases 46k–46m** — meeting on the work calendar, cleaner not a conflict, availability across calendars. (#2475)

### Changed

- **Calendar without restart** — calendar tools work as soon as a principal mailbox is added; no restart. (#2475)
- **Availability `calendarIds` (public API)** — `calendar-find-free-time` and `calendar-check-conflicts` refuse more than 20 calendars. (#2475)
- **Setup wizard** — the principal mailboxes task covers several accounts and points to Email & Calendar. (#2475)
- **Meeting debrief (spec 17)** — guards key on the meeting, so one meeting on two calendars debriefs once. (#2475)
- **Meeting debrief key** — iCal UID and occurrence only, so a renamed or moved meeting debriefs once. (#2475)
- **Meeting debrief scope** — only meetings the principal accepted or organised are judged; declined or tentative never prompt. (#2475)
- **Calendar agent** — works across the principal's calendars; conflicts are judged against calendaring preferences. (#2475)
- **Principal's mailboxes moved** — out of the Channels → Email drawer, which now links to Email & Calendar. (#2475)
- **No-mailbox answers** — every tool needing a principal mailbox names Settings → Personality → Email & Calendar. (#2475)
- **Mailbox add refusal (public API)** — `cap_reached` is now `migration_pending`, returned only while the upgrade finishes. (#2475)
- **`nylas_calendar` health check** — lists every live mailbox's calendars, so one broken account fails it. (#2475)
- **Account mentions** — an account the evidence clearly favours comes back unlabelled, so replies stop naming it. (#2475)

### Removed

- **Flat mailbox vault keys** — `ceo_nylas_grant_id` and `ceo_self_email` are deleted at boot; the registry replaces them. (#2475)
- **Secrets page flat keys** — the Secrets page no longer accepts the two retired mailbox keys. (#2475)
- **Mailbox `restart_required` (public API)** — removal route, console and `principalMailboxReady` drop it; nothing needs a restart. (#2475)

### Fixed

- **`calendar-holds-sweep`** — a mailbox-scoped sweep no longer counts other accounts' failures or removed mailboxes twice. (#2475)
- **Availability** — a removed calendar the caller named, or an unanswered free/busy, never reads as free. (#2475)
- **Meeting debrief** — a partly read calendar listing no longer closes a real meeting as not held. (#2475)
- **Removed mailbox calendars** — listed once as removed, not as daily fetch failures. (#2475)
- **Calendar backfill** — one conflicting row no longer fails the whole boot backfill every boot. (#2475)
- **Scenario sends** — test mode wires the principal's mailbox, so through-gateway `ceo-inbox-send-draft` reaches the gateway. (#2475)

### Security

- **Secret capture** — an agent's capture link can no longer write the retired flat mailbox grant. (#2475)
