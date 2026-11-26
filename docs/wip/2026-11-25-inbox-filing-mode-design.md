# Inbox filing mode: leave triaged mail in the inbox (#2699)

## Why

Triage archives Cleared, Handled and Drafted mail. A principal nervous about mail
"disappearing" has no middle ground between that and switching triage off. Onboarding's
inbox topic is where they hear what triage will do, so the choice belongs there.

## Today

- Archived: ✔️ Cleared, ✅ Handled, ✍️ Drafted (`agents/ceo-inbox.yaml`, steps 4h and 5).
- Stays in the inbox, marked read: 📌 Seen (always labelled), 🚨 Urgent (starred), ⚠️ Stuck
  (labelled).
- Archiving doubles as the drain's "done" marker: triage lists unread INBOX mail, so
  anything left in the inbox must be marked read or it is triaged again.
- The playbook and onboarding skill wrongly say Seen mail "leaves your inbox".

## Goals

- A per-mailbox setting `ceo_inbox/filing`: `{"<mailbox id>": "archive" | "leave_in_inbox"}`.
  Unlisted mailbox (or no setting) = `archive`, so existing installs are unchanged.
- Under `leave_in_inbox`, a triage run archives nothing in that mailbox: every message it
  would archive is marked read instead, and labelled exactly as today when labels are on.
- The principal can change it in conversation.
- Onboarding's inbox topic offers the choice and describes the chosen behaviour.
- curia-docs describes it.

## Non-goals

- Console UI (dropped from the issue).
- Updating prod's seeded playbook copy (onboarding already ran there).
- Changing what happens to Seen, Urgent or Stuck mail.

## Anti-goals

- A principal who asked to "archive that email" in conversation finds it still in the
  inbox. The setting governs triage only.
- A triaged message left in the inbox unread (endless re-triage).

## Approaches

1. **Code enforcement in `ceo-inbox-archive` (chosen).** On a turn of system lineage
   (`hasSystemLineage`: the drain, and the calendar-consult resume it parks, which inherits the
   drain's originator through the bullpen thread), the handler reads the mailbox's filing mode; under `leave_in_inbox` it marks the message read instead of removing INBOX
   and returns `left_in_inbox: true`. Deterministic, unit-testable, works whatever the model
   does, and keeps prompt growth to a line or two (ADR-046's top rung).
2. Prompt-only: pin the setting and branch the triage steps. Model-dependent, testable only
   by a paid scenario, and grows a budgeted prompt. Rejected.
3. Skip the archive call in code before the model sees it. No such hook point; rejected.

## Design

- **Setting module** (beside `src/principal-mailboxes/triage-cadence.ts` /
  `src/skills/principal-send/send-level.ts`): parse the value, resolve a mailbox's mode
  (default `archive`, bad JSON or unknown value → `archive` with a warn log), and
  `checkFilingWrite(value, liveMailboxes)` for config-store.
- **config-store:** `ceo_inbox/filing` joins the mailbox-keyed settings: refused unless keyed
  by live mailbox ids with valid values; success carries the mailbox ids and labels, like
  `sending`.
- **`ceo-inbox-archive`:** on a system-lineage (triage) turn with `leave_in_inbox` for the located
  mailbox, mark read (unread=false, folders untouched) and return
  `{ message_id, left_in_inbox: true, … }`. If reading the setting fails, fall back to
  archiving and log it (today's behaviour; still settles the drain). On a principal- or
  agent-lineage turn ("archive that"), always archive. Manifest output gains `left_in_inbox`.
- **Agent prompt (`ceo-inbox.yaml`):** pin `ceo_inbox/filing` with a short description;
  step 5 notes a `left_in_inbox` result is already settled; Rule Management gains one line
  for changing it. Stay within the prompt budget.
- **Mailbox removal:** a removed mailbox's entry is dropped or ignored the way `sending`
  and `triage` entries are (builder to follow the existing cleanup path).
- **Onboarding:** in `config/onboarding/playbook.md` and `skills/onboarding/SKILL.md`, fix the
  category descriptions (Seen stays in the inbox), add the choice ("Should mail I've dealt
  with leave your inbox, or stay there marked read?", `ceo_inbox/filing`), and have the
  read-back reflect it. With several mailboxes, ask per mailbox only if the principal wants
  them to differ.
- **Docs:** the curia-docs email triage page describes the setting.

## Tests

- Unit: setting parse/resolve/check; config-store accepts and refuses writes; archive
  handler — drain turn or consult resume + `leave_in_inbox` marks read and never removes
  INBOX; drain turn + `archive` or unset archives; principal or agent lineage archives
  regardless; setting read failure archives.
- No paid scenario runs; the behaviour lives in code.

## Left to the builder

- Exact module location and names; the Nylas call for mark-read (reuse `ceo-inbox-mark-read`'s).
- Whether the `left_in_inbox` result also reports `already_read`.
