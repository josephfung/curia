# Deep dive: history scan and summary (#2362)

The deep dive reads the principal's mail and calendar **once**, turns it into a stored summary,
and every later step (contacts backfill, the three drafts) reads only that summary. This file
documents the scan and each heuristic exactly as implemented; it is reviewed with the code.
Defaults live in `limits.ts`; design background is `docs/wip/2026-11-23-deep-dive-design.md`
§2 and §2a.

| File | What it does |
|---|---|
| `scan.ts` | `scanHistory`: the Nylas I/O. Returns raw messages, sent bodies, events, principal addresses, coverage. |
| `history-summary.ts` | Types and the pure `summarise`; the mail heuristics and `timeSpent`. |
| `history-calendar.ts` | The calendar heuristics (recurring meetings, meeting shape, calendar hours). |
| `voice-sample.ts` | Which sent messages form the voice sample, and how their bodies are cleaned. |
| `summary-util.ts` | Evidence, median, ordering helpers. |

## The scan (`scanHistory`)

- **Window:** `WINDOW_DAYS` (90) back from `now`. Mail uses `receivedAfter`/`receivedBefore`
  (Unix seconds); the calendar uses ISO bounds.
- **Only the given mailbox ids.** Ids no longer connected are skipped with a warning and
  mark the scan truncated.
- **Pace:** `PAGE_DELAY_MS` before every call the scan makes except its first, across steps
  and mailboxes; `listAllMessages` paces its own later pages.
- **Order** (the request and message budgets are shared across the whole run):
  1. Each mailbox's calendar: `listCalendars()` (1 request), then the primary calendar
     (`isPrimary`) listed in `CALENDAR_WINDOW_DAYS` (7-day) windows, `expandRecurring: true`,
     `limit` 1,000 per window. 90 days is 13 windows. Each of a
     window's page requests (up to 25) is counted as it goes out, through `listEvents`'
     `beforePage`, and pages after the first wait `PAGE_DELAY_MS`. No primary
     calendar: warn, skip that calendar and mark the scan truncated. A window that hit 1,000
     events or reported `onIncomplete` marks the scan truncated.
  2. Each mailbox's `SENT` folder via `listAllMessages`, with `VOICE_SAMPLE_SIZE` requests held
     back for step 3.
  3. Up to `VOICE_SAMPLE_SIZE` sent bodies via `getMessage` (1 request each), chosen as in *Voice sample* below. A body that is gone (404) is skipped with a warning.
  4. Each mailbox's received mail via `listAllMessages` with no folder filter — the bulk, so it
     goes last. Everything in the window counts except messages in `SENT`, `DRAFT`, `SPAM` or
     `TRASH`, so archived mail (Gmail mail out of `INBOX`) is received mail too.
- **Listing:** `listAllMessages({ folder?, receivedAfter, receivedBefore, maxScan, pageDelayMs: PAGE_DELAY_MS, onPage })`.
  `maxScan` is what is left of `MAX_MESSAGES`. `onPage` adds each page's requests (retries
  included) to the count, counts rate-limited pages, and returns `false` once the request count
  reaches the step's limit, which stops paging while keeping the messages already read.
- **Caps end a step, not the run.** Reaching `MAX_MESSAGES` or `MAX_REQUESTS` (or a listing
  that reports `truncated`) skips the rest of that step and marks `coverage.truncated`; later
  steps still run if budget remains (so the voice bodies get their reserved requests). The only
  overshoot is the retries inside the final page.
- **Transient failures are scoped to a step.** The steps are: each mailbox's calendar, each
  mailbox's Sent listing, the voice bodies, each mailbox's received listing. `listAllMessages`
  retries 429s and 5xx and doubles its page delay after a 429. The calendar client (Nylas SDK)
  does not retry, so each calendar call gets one retry after a pause that starts at
  2 × `PAGE_DELAY_MS` and doubles, up to 30 s, with every calendar 429 or status-0 error in the
  scan (the SDK's `NylasSdkTimeoutError` counts as status 0; each
  counted in `rateLimited`; a retried listing's pages are counted again). A transient error that outlasts the retries — 429,
  5xx, or status 0 (the fetch itself failed: DNS, a reset, a timeout) — ends only the step it
  happened in: the scan is marked truncated with a warning and the next step runs. A listing
  keeps the pages it read before the failing one (`listAllMessages` returns them with `endedOn`
  when `onPage` is set); a listing whose first page fails reads nothing. Events from earlier
  calendar windows are kept.
- **A total outage fails the run.** When the scan read no message and no event, and at least
  one step ended on a transient error, it throws instead of returning an empty summary. An
  empty mailbox with no errors still succeeds.
- **Deduplication:** a message listed twice (self-sent mail is in both the Sent and the received
  listing) is kept and counted once.
- **Any other error propagates** (auth 401/403, a bad grant): the run fails.
- **Principal addresses:** the scanned mailboxes' non-empty `address` values, plus every sender
  of a `SENT`-folder message (send-as aliases), lower-cased.
- **Coverage:** `messagesRead` and `eventsRead` are what was returned (events deduplicated by
  id); `requests`, `rateLimited` (pages that saw a 429), `errors` (steps ended by a 5xx or a
  failed fetch) and `truncated` as above. One info line
  logs the coverage and duration.

## The summary (`summarise`)

Pure: no I/O, no clock. `generatedAt` is the window's end, which also stands in for "now". The
input `timezone` is the principal's IANA zone (the caller resolves it with `usableTimezone`, as
inbox triage does); an unusable zone throws. Messages and events are deduplicated by id and
every list is sorted with explicit tie-breakers (code-point string order, never locale), so the
same input — in any order — gives the same summary.

**Evidence** on every item: up to 10 ids, newest first (ties by id).

**Principal addresses** = the given addresses plus every sender of a `SENT`-folder message,
lower-cased. A principal address is never a correspondent, attendee, `timeSpent` key or
hand-off target: self-sent mail, CC to self and alias mailboxes all drop out. A message whose
sender is a principal address is *principal-sent*; any other message is *received*.

### Correspondents

- Received: the sender (`from[0]`) gets `received + 1`. Sent: every distinct non-principal
  address in To and Cc gets `sent + 1`.
- `name`: the first non-empty display name seen (oldest message first); `null` if none.
- `domain`: the part after `@`. `kind`: `classifyEmailSender(email)`.
- `twoWay`: `received ≥ 1` and `sent ≥ 1` and `received + sent ≥ TWO_WAY_MIN_MESSAGES` (3).
- `medianReplyMinutes`: for each received message, the minutes until the next principal-sent
  message in the same `threadId` (to anyone; a message with no `threadId` has no reply time); the median per sender, rounded; `null` when no
  received message was followed by one.
- Sorted by `received + sent` descending, then address. Not capped.

### Unopened

Received messages still in `INBOX` that are `unread` and older than 7 days before the window's
end, grouped by sender domain (unread archived mail was dealt with, so it is not unopened). Sorted by count descending, then domain.

### Handed off

Principal-sent messages whose subject starts `Fwd:`, `Fw:` or `FW:` (any case, optional space
before the colon), to the first non-principal recipient (To, then Cc). Forwards to no one but
the principal are skipped. One item per (thread, recipient), or per message when it has no `threadId`; newest first.

### Calendar

Cancelled events are ignored. *Timed* events have both start and end. *Declined* means a
principal participant's status is `no`. *Attended* = timed and not declined. All-day events
count for nothing except declined/moved.

- **Recurring meetings:** timed events grouped by `masterEventId`, or by their own id when
  they carry `recurrence` (a master). A group with ≥ 3 distinct start times in the window
  counts. `cadence` from the median gap between consecutive starts: ≤ 1.5 days `daily`,
  5.5–8.5 `weekly`, 12.5–15.5 `biweekly`, 26–35 `monthly`, else `every N days`.
  `minutesPerOccurrence` = median duration. `title` = the latest occurrence's title.
  `attendees` = non-principal, non-declining participants across occurrences, sorted. Ordered
  by total attended minutes, descending, then series id.
- **`medianMinutes`:** median length of attended events (0 when none).
- **`bufferMinutesMedian`:** attended events grouped by principal-local start date; the gap
  from each event's start back to the latest end so far that day (overlap = 0); gaps over 120
  minutes are not buffers. Median, 0 when none.
- **`keptClearBlocks`:** principal-local Monday–Friday, 08:00–18:00, in 30-minute slots, over
  the dates whose whole 08:00–18:00 lies inside the window. A slot is busy on a date when an
  attended event with `busy !== false` overlaps it. A slot is kept clear for a weekday when it
  is free on ≥ 75% of that weekday's dates. Consecutive clear slots merge; blocks under 60
  minutes are dropped. `weekday` is ISO (1 = Monday). Not computed (empty) when the calendar
  has fewer attended busy events than weeks in the window — a near-empty calendar would
  otherwise call every weekday kept clear.
- **`declinedOrMoved`:** events (not cancelled) the principal declined, or whose
  `originalStartTime` differs from `startTime`.
- **`meetingShape.evidence`:** declined/moved event ids first, then attended ones, newest first
  within each, 10 at most.

### Time spent

Three groupings, each sorted by `calendarHours` descending, then `messages`, then key, and
capped at 25 rows:

- **person** (`classifyEmailSender` = `person`): `calendarHours` = attended hours of events the
  address attended (not declining); `messages` = its `received + sent`.
- **organization**, key = domain, excluding automated addresses and personal-webmail or shared
  domains (`isNonOrgDomain`): `calendarHours` = attended hours of events with anyone from that
  domain (once per event); `messages` = distinct messages with anyone from that domain.
- **series**, key = series id (see `recurringMeetings` for its title): attended hours of each
  recurring series; `messages` = 0.

Hours are rounded to two decimals.

### Voice sample

From the principal-sent messages: skip forwards and mail to no one but the principal; newest
first, one message per distinct first recipient, then the rest newest first, up to
`VOICE_SAMPLE_SIZE` (60). The scan fetches bodies for exactly these candidates. Bodies are
HTML-stripped with the repo's `htmlToPlainText`, then quoted history is cut (at the first
`On … wrote:`, `-----Original Message-----`, `---------- Forwarded message`, or an Outlook
`From:` line followed by `Sent:`/`Date:`; lines starting with `>` are dropped), then capped at
2,000 characters. An empty result is skipped.
