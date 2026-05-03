# Gate-level approval trigger + humanApproved on execution layer

Issue: #427
ADR: 018 (Curia-initiated approval requests)
Date: 2026-05-03

## Summary

When the autonomy gate blocks a skill, the execution layer writes a
`pending_approval` row to `autonomy_action_log`, notifies the CEO, and returns
an enriched advisory failure to the coordinator. This also adds
`humanApproved` to `InvokeOptions` — the mechanism the `approve-action` skill
(#428) uses to re-execute approved skills past the gate.

## Decisions from brainstorming

1. **Every gate block creates an approval request** — no minimum action_risk
   threshold. Gate A (score < 60) and Gate B (per action_risk) both trigger the
   same approval flow. The CEO set a low score because they want visibility.
2. **Email-only notifications** via `outboundGateway.sendNotification()`. Signal
   notification routing deferred to a future issue.
3. **Email adapter integration deferred** to #435 — no `autonomy_action_log`
   writes from `dispatchByPolicy()` in this issue.
4. **Approach A: dedicated ApprovalTriggerService** rather than inline logic in
   execution.ts. Clean separation of concerns, independently testable, reusable
   by #435 later.

## Section 1: `humanApproved` on InvokeOptions

Add `humanApproved?: boolean` to `InvokeOptions` in `src/skills/execution.ts`.

When `humanApproved` is `true`:

- Gates A and B are skipped entirely. The guard condition becomes:
  ```typescript
  if (this.autonomyService
      && manifest.sensitivity !== 'elevated'
      && !options?.humanApproved) {
    // ... gate logic
  }
  ```
- The elevated-skill gate still runs — `approve-action` is
  `sensitivity: 'elevated'`, so it must pass the CEO caller check.
- All other checks run normally: capability injection, content filter,
  blocked-contact, timeout.
- Every `humanApproved` invocation is logged at info level:
  `"autonomy gates skipped — humanApproved flag set (CEO-authorized re-execution)"`

Only the `approve-action` skill (#428) sets this flag. The runtime's `invoke()`
call in `runtime.ts` passes `InvokeOptions` through unchanged — no runtime
changes needed.

## Section 2: ApprovalTriggerService

New file: `src/autonomy/approval-trigger.ts`

### Constructor dependencies

- `ActionLogRepo` — dedup queries and row insertion
- `OutboundGateway` — `sendNotification()` to the CEO
- `Logger`
- `ceoEmail?: string` — needed in the `OutboundNotificationPayload` sent to
  `sendNotification()`. If absent, notification is skipped (same as if
  notification fails — row still created, `notification_sent_at` stays null).
  Sourced from the same config value that the gateway uses.

### Primary method

```typescript
async request(opts: {
  taskId: string;
  conversationId?: string;
  skillName: string;
  actionRisk: string;
  input: Record<string, unknown>;
  currentScore: number;
  requiredScore: number;
}): Promise<ApprovalRequestResult>
```

Return type:
```typescript
type ApprovalRequestResult =
  | { created: true; shortRef: string; notificationSent: boolean }
  | { created: false; reason: 'duplicate'; existingShortRef: string }
```

### Flow inside `request()`

1. **Dedup check** — query `autonomy_action_log` for an existing
   `pending_approval` row with the same `skill_name` and `task_id` where
   `payload::jsonb = $1::jsonb` (value-level comparison, key-order
   independent). If found, return `{ created: false, reason: 'duplicate',
   existingShortRef }`.

2. **Generate `short_ref`** — abbreviate the skill name to a prefix and
   append a sequential counter scoped to the task. Query
   `countShortRefsForTask(taskId)`, use count + 1. Produces refs like
   `cal-1`, `email-2`.

3. **Generate `description`** — human-readable one-liner from skill name +
   key input fields. See Section 5 for details.

4. **Insert row** — call `ActionLogRepo.insert()` with
   `outcome: 'pending_approval'`, `payload: input`,
   `expiresAt: now + 24h`, the generated `shortRef` and `description`.

5. **Notify CEO** — if `ceoEmail` is configured, call
   `outboundGateway.sendNotification()` with payload:
   - `notificationType: 'approval_requested'` (new value — add to
     `OutboundNotificationPayload.notificationType` union in `events.ts`)
   - `ceoEmail`: from constructor
   - `subject: 'Approval needed — {description}'`
   - `body`: includes description, current score vs required, short_ref,
     expiry time, and a note to reply to approve/deny/dismiss

   If notification succeeds, update the row with
   `setNotificationSentAt(id)`. If notification fails or `ceoEmail` is not
   configured, log a warning — `notification_sent_at` stays null, the row
   still exists, and the CEO will see it in the daily digest (#429).

## Section 3: Execution layer integration

`ApprovalTriggerService` is injected as a new optional constructor dependency
on `ExecutionLayer`, same pattern as `autonomyService`.

### Gate A and Gate B modification

Both gates follow the same flow after detecting a block:

1. Gate detects the block (existing logic, unchanged).
2. Publish `autonomy.skill_blocked` event (existing logic, unchanged).
3. If `approvalTrigger` is wired and `options?.taskEventId` is present, call
   `approvalTrigger.request()` with skill name, input, task context, scores.
4. Build the error message based on the result:
   - **Created + notification sent:**
     `"Skill '{name}' blocked — autonomy score is {current}, requires
     {required}. An approval request has been sent to the CEO (ref:
     {shortRef})."`
   - **Created + notification failed:**
     `"Skill '{name}' blocked — autonomy score is {current}, requires
     {required}. An approval request was created (ref: {shortRef}) but
     notification could not be delivered — the CEO will see it in the next
     digest."`
   - **Duplicate:**
     `"Skill '{name}' blocked — an approval request for this action is
     already pending (ref: {existingShortRef})."`
5. If `approvalTrigger` is not wired or `taskEventId` is missing, fall through
   to the existing error message unchanged (fail-open).

Gate A and Gate B call the same `approvalTrigger.request()` — no branching by
gate type. The only difference is how `requiredScore` is determined (60 for
Gate A, `minScoreForActionRisk()` for Gate B), which is already computed before
the trigger call.

## Section 4: ActionLogRepo additions

Three new methods in `src/autonomy/action-log-repo.ts`:

### `findPendingByTaskAndSkill(taskId, skillName, payload)`

```sql
SELECT * FROM autonomy_action_log
WHERE task_id = $1
  AND skill_name = $2
  AND outcome = 'pending_approval'
  AND payload::jsonb = $3::jsonb
LIMIT 1
```

Returns `ActionLogRow | null`. Uses JSONB equality for key-order-independent
payload comparison.

### `countShortRefsForTask(taskId)`

```sql
SELECT COUNT(*) FROM autonomy_action_log
WHERE task_id = $1
  AND short_ref IS NOT NULL
```

Returns `number`. Used for sequential short_ref counter generation.

### `setNotificationSentAt(id)`

```sql
UPDATE autonomy_action_log
SET notification_sent_at = now()
WHERE id = $1
```

Called after successful `sendNotification()`. If notification fails, this is
never called — the column stays null.

The existing `insert()` method already accepts all needed fields via
`ActionLogInsert` — no changes needed.

## Section 5: Short ref generation and description building

Both are pure functions inside `approval-trigger.ts`.

### Short ref prefixes

| Skill name pattern | Prefix |
|---|---|
| `calendar-*` | `cal` |
| `email-*` | `email` |
| `signal-*` | `signal` |
| `store-fact`, `*-memory-*` | `mem` |
| `*-contact*` | `contact` |
| `schedule-*` | `sched` |
| Everything else | first word of skill name, truncated to 6 chars |

Combined with per-task counter: `cal-1`, `email-2`, `contact-3`.

### Description generation

Builds a human-readable one-liner from skill name and input fields:

- Look for common input fields (`title`, `subject`, `to`, `body`, `name`,
  `start`, `query`) and include their values
- Truncate any single value to 80 chars
- Truncate the full description to 200 chars
- Format: `"{verb} {context}"` where the verb derives from the skill name
  (e.g., `calendar-create-event` -> "Create calendar event",
  `email-reply` -> "Send email reply")
- Fallback: `"Run {skill_name}"`

Examples:

- `calendar-create-event` + `{ title: "Lunch with Dana", start: "..." }`
  -> `"Create calendar event: Lunch with Dana, Tue May 6 at 12:00"`
- `email-reply` + `{ to: "dana@example.com", subject: "Re: Budget" }`
  -> `"Send email reply to dana@example.com: Re: Budget"`
- `store-fact` + `{ label: "Dana prefers mornings" }`
  -> `"Store fact: Dana prefers mornings"`
- `some-unknown-skill` + `{}`
  -> `"Run some-unknown-skill"`

Neither function needs to be perfect — the description is for human readability
in notifications and coordinator context. The `payload` column stores the full
input for re-execution.

## Section 6: Wiring and testing

### Wiring in `src/index.ts`

Construct `ApprovalTriggerService` after `ActionLogRepo` and
`OutboundGateway` are created (both already exist at that point). Pass it
into `ExecutionLayer`'s constructor options as `approvalTrigger`. Same
optional pattern as other services — if not wired, the execution layer skips
the trigger (fail-open).

### Test plan

**`approval-trigger.test.ts`** (unit, new file) — bulk of coverage:

- Happy path: creates row, generates short_ref, sends notification, returns
  `{ created: true }`
- Dedup: returns `{ created: false, reason: 'duplicate' }` when matching
  pending row exists
- Dedup allows different payloads for same skill in same task (separate
  approval requests)
- Notification failure: row still created, `notification_sent_at` stays null,
  returns `{ notificationSent: false }`
- Short ref counter increments correctly across multiple requests in same task
- Description generation for known skill patterns + generic fallback
- Missing `ceoEmail` on gateway (notification fails gracefully)

**`execution.test.ts`** (extend existing):

- Gate A block with trigger wired -> error message includes "approval request
  sent" + short_ref
- Gate B block with trigger wired -> same enriched error message
- Gate block with trigger not wired -> existing error message unchanged
  (backwards compatible)
- `humanApproved: true` -> gates skipped, trigger never called, info log
  emitted
- `humanApproved: true` + elevated skill -> elevated gate still runs (not
  bypassed)
- Missing `taskEventId` -> trigger skipped, existing error message returned

**`action-log-repo.test.ts`** (extend existing):

- `findPendingByTaskAndSkill` returns matching row / null
- `findPendingByTaskAndSkill` uses JSONB equality (key order independent)
- `countShortRefsForTask` returns correct count
- `setNotificationSentAt` updates the timestamp

### Out of scope for #427

- `approve-action` / `deny-action` / `dismiss-action` skills (#428)
- Expiry sweep and daily digest (#429)
- Email adapter draft -> action log integration (#435)
- `autonomy_action_log` row transitions (approved/denied/expired) — #428/#429

## Files touched

| File | Change |
|---|---|
| `src/skills/execution.ts` | Add `humanApproved` to `InvokeOptions`, gate bypass, approval trigger call |
| `src/autonomy/approval-trigger.ts` | **New** — ApprovalTriggerService |
| `src/autonomy/action-log-repo.ts` | Add `findPendingByTaskAndSkill`, `countShortRefsForTask`, `setNotificationSentAt` |
| `src/bus/events.ts` | Add `'approval_requested'` to `OutboundNotificationPayload.notificationType` union |
| `src/index.ts` | Wire ApprovalTriggerService into ExecutionLayer |
| `src/autonomy/approval-trigger.test.ts` | **New** — unit tests |
| `src/skills/execution.test.ts` | Extend with humanApproved + trigger integration tests |
| `src/autonomy/action-log-repo.test.ts` | Extend with new method tests |
