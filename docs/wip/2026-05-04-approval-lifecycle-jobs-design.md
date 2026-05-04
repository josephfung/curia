# Approval Lifecycle Jobs — Design Spec

**Issue:** [#429](https://github.com/josephfung/curia/issues/429)
**Depends on:** #427 (approval trigger), #428 (approval management skills)
**Date:** 2026-05-04

## Summary

Two background scheduler jobs that close the approval request lifecycle:

1. **Expiry sweep** — hourly job that transitions stale `pending_approval` rows to
   `expired` and sends a batched notification for high/critical tier expirations.
2. **Pending-actions digest** — daily morning job that surfaces all open approval
   requests to the CEO as a single summary email.

Both run as declarative YAML-based scheduler jobs on the coordinator agent. The
coordinator receives a task description, discovers the corresponding skill via
`allow_discovery: true`, and invokes it. This keeps the pattern consistent with
all other scheduled work — no new execution model.

## Approach

Two standalone skills (`approval-expiry-sweep` and `pending-actions-digest`),
each with its own manifest + handler + tests. Both consume existing repo-layer
methods on `ActionLogRepo` plus two new query methods. Notifications go through
the existing `OutboundGateway.sendNotification()` pipeline.

Alternatives considered and rejected:
- **Single skill with sub-actions** — muddies responsibility, fragile parameter
  inference from task description.
- **Shared service layer + thin skill wrappers** — over-abstraction for logic
  this simple; the repo layer already provides the shared data access.

## Detailed Design

### 1. Repo Layer — New Methods on `ActionLogRepo`

**File:** `src/autonomy/action-log-repo.ts`

#### `findExpired(): Promise<ActionLogRow[]>`

Returns all rows where `outcome = 'pending_approval' AND expires_at <= now()`,
ordered by `created_at ASC`. These are the inverse of `findAllPending()` which
filters `expires_at > now()`.

```sql
SELECT * FROM autonomy_action_log
WHERE outcome = 'pending_approval'
  AND expires_at <= now()
ORDER BY created_at ASC
```

#### `expireRows(ids: number[]): Promise<number>`

Batch-transitions the given rows to expired state. Returns the count of rows
actually updated.

```sql
UPDATE autonomy_action_log
SET outcome = 'expired', resolved_by = 'system', resolved_at = now()
WHERE id = ANY($1) AND outcome = 'pending_approval'
```

The `AND outcome = 'pending_approval'` guard ensures idempotency — if a row was
concurrently resolved (approved/denied/dismissed), it won't be double-transitioned.
Empty `ids` array is a no-op (returns 0).

### 2. Expiry Sweep Skill

**Files:**
- `skills/approval-expiry-sweep/skill.json`
- `skills/approval-expiry-sweep/handler.ts`
- `skills/approval-expiry-sweep/handler.test.ts`

#### Manifest

```json
{
  "name": "approval-expiry-sweep",
  "description": "Expire stale pending approval requests and notify the CEO of high/critical expirations.",
  "version": "1.0.0",
  "action_risk": "none",
  "inputs": {},
  "outputs": {
    "expired": "number (count of rows transitioned to expired)",
    "notified": "number (count of high/critical expirations included in notification)"
  },
  "permissions": [],
  "secrets": ["CEO_PRIMARY_EMAIL"],
  "timeout": 30000,
  "capabilities": ["actionLogRepo", "outboundGateway"]
}
```

No `sensitivity: "elevated"` — this is a system job, not CEO-initiated. No pinning
to coordinator's `pinned_skills` — it's a system infrastructure skill discovered via
the scheduler task description (same pattern as `extract-facts`, `scheduler-report`).

`outboundGateway` is a valid skill capability (declared in `SkillContext` and the
loader's allowlist). The gateway's `sendNotification()` handles try/catch internally
and returns a boolean — cleaner than publishing raw bus events.

The `ceoEmail` field required by `OutboundNotificationPayload` comes from
`ctx.secret('CEO_PRIMARY_EMAIL')`. If not configured, the handler skips notification
(same pattern as approval-trigger: rows are expired regardless, CEO sees them in
next digest).

#### Handler Flow

1. `actionLogRepo.findExpired()` — get all stale rows.
2. Early return if none: `{ success: true, data: { expired: 0, notified: 0 } }`.
3. `actionLogRepo.expireRows(ids)` — batch transition.
4. Log each expired row at info level: `{ id, shortRef, skillName, actionRisk }`.
5. Partition by `actionRisk`:
   - **`high` / `critical`**: collect into a notification list.
   - **`low` / `medium`**: no notification.
6. If any high/critical rows exist, send a **single batched notification** via
   `ctx.outboundGateway.sendNotification()`:
   - `notificationType: 'approval_expired'`
   - `ceoEmail`: from `ctx.secret('CEO_PRIMARY_EMAIL')`
   - Subject: `"Approval expired — {count} request(s) expired without response"`
   - Body: bullet list of each expired request with `shortRef`, `description`,
     and `skillName`.
7. Return `{ success: true, data: { expired: totalCount, notified: highCriticalCount } }`.

### 3. Pending-Actions Digest Skill

**Files:**
- `skills/pending-actions-digest/skill.json`
- `skills/pending-actions-digest/handler.ts`
- `skills/pending-actions-digest/handler.test.ts`

#### Manifest

```json
{
  "name": "pending-actions-digest",
  "description": "Send a daily digest of open approval requests awaiting CEO decision.",
  "version": "1.0.0",
  "action_risk": "none",
  "inputs": {},
  "outputs": {
    "pending": "number (count of open requests included in digest)",
    "skipped": "boolean (true if no open requests — digest not sent)"
  },
  "permissions": [],
  "secrets": ["CEO_PRIMARY_EMAIL"],
  "timeout": 30000,
  "capabilities": ["actionLogRepo", "outboundGateway"]
}
```

Same rationale as expiry sweep — no sensitivity, no pinning, system infrastructure.
Same `outboundGateway` capability and `CEO_PRIMARY_EMAIL` secret for notifications.

#### Handler Flow

1. `actionLogRepo.findAllPending()` — get all non-expired pending rows (existing method).
2. Early return if empty: `{ success: true, data: { pending: 0, skipped: true } }`.
3. For each row, compute time remaining: `row.expiresAt - Date.now()`, formatted as
   human-readable (e.g. "14h remaining", "2h remaining", "<1h remaining").
4. Format a digest body as a list, each entry showing:
   - `shortRef` (e.g. "cal-1")
   - `description` (e.g. "Create calendar event: Lunch with Dana")
   - `skillName`
   - Time remaining before expiry
5. Send a single notification via `ctx.outboundGateway.sendNotification()`:
   - `notificationType: 'pending_actions_digest'`
   - `ceoEmail`: from `ctx.secret('CEO_PRIMARY_EMAIL')`
   - Subject: `"Pending approvals — {count} request(s) awaiting your decision"`
   - Body: the formatted list.
6. Return `{ success: true, data: { pending: count, skipped: false } }`.

### 4. Declarative Schedule Entries

**File:** `agents/coordinator.yaml` — new top-level `schedule:` block.

```yaml
schedule:
  - cron: "0 * * * *"
    task: "Run the approval expiry sweep — find and expire any pending approval requests that have passed their expiry time."
    expectedDurationSeconds: 120

  - cron: "0 8 * * *"
    task: "Run the pending-actions digest — if any approval requests are still awaiting a decision, send a summary to the CEO."
    expectedDurationSeconds: 120
```

- Cron times resolve using the per-job timezone (defaults to system timezone,
  which is configured as the CEO's timezone).
- `expectedDurationSeconds: 120` — generous for simple DB + notification ops.
  Watchdog timeout: `min(120 * 7.5, 120 + 3600)` = 900s (15 minutes).
- The coordinator has `allow_discovery: true`, so it discovers the skills by
  name from the natural-language task description.

### 5. Event Type Changes

**File:** `src/bus/events.ts`

Add two new values to the `OutboundNotificationPayload.notificationType` union:

```typescript
notificationType:
  | 'blocked_content'
  | 'group_held'
  | 'contact_rate_limited'
  | 'approval_requested'
  | 'approval_expired'          // NEW — batched expiry notification
  | 'pending_actions_digest';   // NEW — daily digest
```

Backwards-compatible additive change — no existing values modified.

### 6. Testing

#### Repo layer (`src/autonomy/action-log-repo.test.ts`)

- `findExpired()` returns only rows where `expires_at <= now()` and
  `outcome = 'pending_approval'`
- `findExpired()` excludes rows already resolved to other outcomes
- `expireRows([])` with empty array returns 0
- `expireRows(ids)` only updates rows still in `pending_approval` state
- `expireRows(ids)` is idempotent — second call returns 0

#### Expiry sweep (`skills/approval-expiry-sweep/handler.test.ts`)

- No expired rows -> returns `{ expired: 0, notified: 0 }`, no notification sent
- Mixed tiers: `low`/`medium` expire silently; `high`/`critical` appear in a
  single batched notification
- All rows transition to `outcome = 'expired'`, `resolved_by = 'system'`
- Notification body contains all high/critical items as a list
- Handles `sendNotification()` returning `false` gracefully (non-fatal — expiry
  still happened)

#### Digest (`skills/pending-actions-digest/handler.test.ts`)

- No pending rows -> returns `{ pending: 0, skipped: true }`, no notification sent
- Multiple pending rows -> single digest notification listing all
- Each entry includes `shortRef`, `description`, `skillName`, time remaining
- Time remaining calculation is correct (mock `Date.now()`)
- Handles notification failure gracefully

## File Change Summary

| File | Change |
|------|--------|
| `src/autonomy/action-log-repo.ts` | Add `findExpired()` and `expireRows()` |
| `src/autonomy/action-log-repo.test.ts` | Tests for new repo methods |
| `src/bus/events.ts` | Add `'approval_expired'`, `'pending_actions_digest'` to notification type union |
| `skills/approval-expiry-sweep/skill.json` | New manifest |
| `skills/approval-expiry-sweep/handler.ts` | New handler |
| `skills/approval-expiry-sweep/handler.test.ts` | New tests |
| `skills/pending-actions-digest/skill.json` | New manifest |
| `skills/pending-actions-digest/handler.ts` | New handler |
| `skills/pending-actions-digest/handler.test.ts` | New tests |
| `agents/coordinator.yaml` | Add `schedule:` block with two cron entries |
