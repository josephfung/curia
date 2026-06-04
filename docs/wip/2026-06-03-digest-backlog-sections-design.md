# Design: Backlog sections in `pending-actions-digest`

**Status:** Design, pre-implementation
**Date:** 2026-06-03
**Issue:** [josephfung/curia#838](https://github.com/josephfung/curia/issues/838) — Tasks v1 (5/7)
**Parent design:** [2026-06-01-tasks-and-backlog-design.md](2026-06-01-tasks-and-backlog-design.md) (§6, §9 issue 5)

---

## 1. Context

Tasks & Backlog v1 (issues 1–4) has landed: migration 049 promoted `agent_tasks` →
`tasks` with CEO-visible columns, and the four `task-*` skills exist
(`task-create`, `task-list`, `task-update`, `task-complete`). This issue is the
read-side surface: let the CEO *see* the backlog in a channel they already read.

### The surface decision

The parent design (§6) names `src/digests/pending-actions-digest.ts` as the target.
That path is stale. The actual module is the **code skill**
`skills/pending-actions-digest/handler.ts`: a deterministic skill that loads
non-expired `pending_approval` rows via `actionLogRepo`, formats a plain-text body,
and sends a single email to the CEO via `outboundGateway`. It is triggered by the
coordinator's declarative job `cron: "0 8 * * *"` (8am).

There is a *second*, unrelated digest in this deployment: the `digest.yaml` agent in
`curia-deploy` (5pm Toronto), an LLM agent that lists unsent **email drafts** over
**Signal**. It is a different channel, a different payload, and LLM-rendered.

**This issue extends the code skill only.** The `digest.yaml` Signal agent is
explicitly out of scope and stays drafts-only. A future issue could let it consume
`task-list`, but that path cannot satisfy this issue's snapshot-test acceptance
criteria (only the deterministic code path can), so it is deliberately deferred.

---

## 2. Goals & Non-Goals

### Goals
- Surface the three-way task backlog (`for-you-to-do` / `waiting-on-others` /
  `what-I'm-working-on`) in the existing daily approvals email.
- Keep the approvals block byte-for-byte unchanged.
- Make the rendered body snapshot-testable via a pure function.

### Non-Goals (this issue)
- Any change to the `digest.yaml` Signal agent.
- Interactive controls (snooze / done / reassign) — deferred to v1.5+ per parent §6.
- A separate "backlog digest" or new channel.
- Touching the task skills, the scheduler, or the coordinator.

---

## 3. Data Sources (all already exist)

| Need | Source | Notes |
|---|---|---|
| Three task lists | `ctx.taskRepo.listTasks({ owner, statuses, limit })` | Already orders by `priority DESC, due_at ASC NULLS LAST`. |
| Contact name for `waiting_on` | `ctx.contactService.getContact(id)` → `displayName` | Ambient on `SkillContext` (not capability-gated). Returns `Contact \| undefined`. |
| Approvals (unchanged) | `ctx.actionLogRepo.findAllPending()` | Existing behavior, untouched. |

Section → query mapping:

- **For you to do** — `owner='ceo'`, `statuses=['open','in_progress']`
- **Waiting on others** — `owner='external'`, `statuses=['waiting']`
- **What I'm working on** — `owner='curia'`, `statuses=['open','in_progress']`

Each fetched with `limit: 50` (see §5 for the `+N more` rationale).

The only manifest capability change: add `"taskRepo"` to `capabilities`
(currently `["actionLogRepo","outboundGateway"]`). `contactService` needs no
declaration — it is populated whenever the execution layer has an instance.

---

## 4. Send Gate & Subject

Compute all three lists first, then decide whether to send:

- **Send if** `approvals.length > 0 || ceo.length > 0 || external.length > 0`.
- **Skip** (`{ skipped: true }`, no email) when all three are empty — *even if*
  `curia` ("what I'm working on") has items. Curia's own in-progress work never
  triggers a send on its own; it is informational ride-along content.

**Adaptive subject:**

- Approvals present → `Pending approvals — N request(s) awaiting your decision`
  (unchanged from today).
- Zero approvals, backlog present → `Your daily brief — N item(s) need you`,
  where **N = ceo.length + external.length** (the items that actually need the CEO;
  "what I'm working on" is not counted).

The existing graceful-skip paths are preserved verbatim: missing
`CEO_PRIMARY_EMAIL` or absent `outboundGateway` → `{ skipped: true }`. If
`ctx.taskRepo` is absent, the three lists are empty and the skill behaves exactly
as today (approvals-only, no throw).

---

## 5. Rendering & Line Formats

Body layout: **approvals block (unchanged)**, then each non-empty backlog section in
this order: For you to do, Waiting on others, What I'm working on.

Line formats (one bullet per task):

| Section | Format |
|---|---|
| For you to do | `• <title> · due <date\|—> · age <duration>` |
| Waiting on others | `• <title> · waiting on <name> · since <duration>` |
| What I'm working on | `• <title> · age <duration>` |

Field rules:

- `<date>` — `due_at` rendered in the CEO's local timezone via the existing
  `toLocalIso()` convention (date portion only); `—` when `due_at` is null.
- `<duration>` (age / since) — short humanized span from `created_at`
  (e.g. `3d`, `5h`, `2w`). New helper `humanizeAge()` next to the existing
  `formatTimeRemaining()` in the handler module.
- `<name>` — `getContact(waiting_on_contact_id)?.displayName`, falling back to
  `waiting_on_text`, then `(unknown)` when both are null/unresolved.

**Truncation / `+N more`:** each section caps its rendered bullets at **5**. To show
an exact remainder, each section is fetched with `limit: 50`; render the first 5 and
compute `N = fetched − 5`. At v1 task volumes (well under 50) this is exact. If a
section ever returns the full 50, the footer shows `+45 more` and the handler logs a
`warn` — so silent truncation cannot hide a runaway backlog. (Exact N is capped at
45 by construction.)

---

## 6. Testability & Refactor

Body construction is extracted into a **pure function**:

```ts
renderDigestBody(input: {
  approvals: ApprovalLine[];   // already-shaped approval rows
  ceo: TaskListRow[];
  external: TaskListRow[];
  curia: TaskListRow[];
  resolveName: (id: string) => string | undefined; // contact display name
  now: Date;                    // for deterministic age in tests
  timezone: string;
}): string
```

This returns the complete email body. The snapshot test seeds realistic tasks and
asserts the rendered string directly — no gateway mocking. The existing approvals
bullet logic moves into this function **unchanged**, and the existing
`handler.test.ts` stays green, which is the proof that the approvals block is
untouched.

`now` and `timezone` are injected so age/date rendering is deterministic under test.

---

## 7. Housekeeping

- `skill.json` `version` `1.0.0` → **`1.1.0`** (new capability + new output fields =
  minor bump per CLAUDE.md).
- Manifest `outputs`: add `tasksForCeo`, `tasksWaiting`, `tasksWorking` counts
  alongside existing `pending` / `skipped`.
- `CHANGELOG.md` under `[Unreleased]` → **Added**:
  `**pending-actions-digest** — daily digest now surfaces the task backlog
  (for-you-to-do, waiting-on-others, what-I'm-working-on). (#838)`
- TDD: helper and pure-function tests written before the handler is wired.

---

## 8. Build Sequence

1. `humanizeAge()` helper + unit tests.
2. `renderDigestBody()` pure function + snapshot tests: all three sections, the
   `+N more` truncation case, empty-section cases, and approvals-block-unchanged.
3. Wire `taskRepo` into the handler: fetch three lists (`limit: 50`), apply the send
   gate, build the adaptive subject, call `renderDigestBody()`.
4. Manifest (`capabilities`, `version`, `outputs`) + CHANGELOG entry.
5. `pnpm run typecheck` + full test suite green.

---

## 9. Acceptance Criteria (from issue #838)

- [ ] Snapshot test renders all three sections correctly with realistic seeded data,
      including the `+N more` truncation case.
- [ ] Snapshot test verifies the existing approvals block is unchanged.
- [ ] The CEO receives the next day's digest in staging with the new sections
      populated (manual verification).
- [ ] Owner resolution: `waiting_on_contact_id` resolves to display name when
      present; falls back to `waiting_on_text`; renders `(unknown)` if both null.
- [ ] No new permission / outbound surface introduced (the email send path is the
      existing `outboundGateway.sendNotification`).
