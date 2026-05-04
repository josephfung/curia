# Approval Management Skills — Design Spec

**Issue:** #428
**Depends on:** #427 (approval trigger — merged as PR #436)
**ADR:** 018 (Curia-initiated approval requests via unified autonomy action log)

## Goal

Implement the CEO-facing side of the approval flow: four skills that let the
CEO approve, deny, dismiss, or list pending approval requests created by the
autonomy gate trigger (#427). Also fix the `short_ref` race condition
identified during #436 review.

## Out of scope

- `send-draft` integration with `autonomy_action_log` — deferred to #435
- Expiry sweep (scheduler job that transitions expired rows) — separate issue
- Daily pending-actions digest — separate issue

## Architecture

The four skills follow established patterns: `skill.json` manifest + handler
class + handler tests, registered via the standard loader. All four are
`sensitivity: "elevated"` (CEO-only) and `action_risk: "none"`.

The `approve-action` skill re-executes the original blocked skill by calling
`ExecutionLayer.invoke()` with `humanApproved: true`. This requires adding
`executionLayer` as a new capability in `SkillContext`.

All four skills need `ActionLogRepo` for row lookups and state transitions.
`actionLogRepo` is added as a new capability in `SkillContext`.

## Changes

### 1. Migration 032: UNIQUE constraint on `short_ref`

```sql
ALTER TABLE autonomy_action_log
  ADD CONSTRAINT uq_aal_task_short_ref UNIQUE (task_id, short_ref);
```

Partial uniqueness is not needed — `short_ref` is only non-null for approval
rows, and null values do not violate UNIQUE constraints in Postgres (nulls are
never equal to each other).

### 2. Retry in `ApprovalTriggerService.request()`

After the UNIQUE constraint lands, the `countShortRefsForTask + 1` pattern can
collide under concurrency. Wrap the insert block in a retry loop (max 3
attempts) that catches Postgres error code `23505` (unique_violation) and
re-counts before retrying.

### 3. New `ActionLogRepo` methods

**`resolvePending(shortRef?: string): Promise<ResolveResult>`**

Discriminated union return type:
- `{ found: true; row: ActionLogRow }` — single row resolved
- `{ found: false; reason: 'not_found'; error: string }` — no matching row
- `{ found: false; reason: 'ambiguous'; error: string; pending: ActionLogRow[] }` — multiple pending, no `short_ref` provided or no match
- `{ found: false; reason: 'expired'; error: string }` — row exists but past `expires_at`
- `{ found: false; reason: 'already_resolved'; error: string }` — row already transitioned

When `short_ref` is provided: look up by `short_ref` (uses `idx_aal_short_ref`).
If the row exists but `outcome` is not `pending_approval`, return
`already_resolved`. If the row exists but `expires_at <= now()`, return
`expired`. When omitted: fetch all non-expired `pending_approval` rows — if
exactly one, resolve to it; if multiple, return `ambiguous` with the list.

**`findAllPending(): Promise<ActionLogRow[]>`**

Returns all `pending_approval` rows where `expires_at > now()`, ordered by
`created_at ASC`. Used by `list-pending-actions` and internally by
`resolvePending` when no `short_ref` is provided.

**`resolveRow(id: number, outcome: 'approved' | 'denied' | 'resolved_externally', resolvedBy: string): Promise<void>`**

Sets `outcome`, `resolved_at = now()`, `resolved_by` on the given row. Only
updates rows where current `outcome = 'pending_approval'` (guard against
double-resolve — silently no-ops if already resolved).

**Extend `ActionLogInsert`** to include optional `parentActionId?: number`.
Update `insert()` to write `parent_action_id` when provided. This is used by
`approve-action` to record the re-execution result linked to the approved row.

### 4. New capabilities

**`executionLayer`**
- Add `'executionLayer'` to `VALID_CAPABILITIES` in `loader.ts`
- Add `executionLayer?: ExecutionLayer` to `SkillContext` in `types.ts`
- In `execution.ts`, add `executionLayer: this` to the `capabilityServices` map
- Security: only `approve-action` declares this capability; it is `sensitivity: "elevated"` (CEO-only)

**`actionLogRepo`**
- Add `'actionLogRepo'` to `VALID_CAPABILITIES` in `loader.ts`
- Add `actionLogRepo?: ActionLogRepo` to `SkillContext` in `types.ts`
- Add `actionLogRepo` to the `ExecutionLayer` constructor options and `capabilityServices` map
- Wire in `index.ts` — pass the existing `ActionLogRepo` instance

### 5. New event type: `'dismiss'`

Add `'dismiss'` to the `HumanDecisionPayload.decision` union in
`src/bus/events.ts`:

```typescript
decision: 'approve' | 'deny' | 'dismiss' | 'modify' | 'escalate' | 'timeout';
```

Used by `dismiss-action` when the CEO handled the action outside Curia.

### 6. Skills

#### `approve-action`

- **Directory:** `skills/approve-action/`
- **Manifest:** `action_risk: "none"`, `sensitivity: "elevated"`, `capabilities: ["bus", "executionLayer", "actionLogRepo"]`
- **Input:** `short_ref: "string?"`
- **Output:** `result: "object"` (re-execution result)

Handler flow:
1. CEO-origin check: `ctx.taskMetadata?.ceoInitiated === true` (same as `send-draft`)
2. Validate `ctx.executionLayer` and `ctx.actionLogRepo` are present
3. Call `ctx.actionLogRepo.resolvePending(shortRef)`
   - On `found: false` → return `{ success: false, error }` with the reason
4. Call `ctx.actionLogRepo.resolveRow(row.id, 'approved', 'ceo')`
5. Re-execute: `ctx.executionLayer.invoke(row.skillName, row.payload!, ctx.caller, { humanApproved: true, taskEventId: ctx.taskEventId, conversationId: row.conversationId })`
6. Write child row: `ctx.actionLogRepo.insert({ taskId: row.taskId, conversationId: row.conversationId, skillName: row.skillName, actionRisk: row.actionRisk, outcome: reResult.success ? 'success' : 'failure', taskSummary: reResult.success ? null : reResult.error, parentActionId: row.id })`
7. Publish `human.decision` via `ctx.bus`: `decision: 'approve'`, `subjectSummary` from `row.description`
8. Return the re-execution result (success or failure with reason — so the CEO gets immediate feedback)

#### `deny-action`

- **Directory:** `skills/deny-action/`
- **Manifest:** `action_risk: "none"`, `sensitivity: "elevated"`, `capabilities: ["bus", "actionLogRepo"]`
- **Input:** `short_ref: "string?"`
- **Output:** `result: "string"` (confirmation message)

Handler flow:
1. CEO-origin check
2. Validate `ctx.actionLogRepo` and `ctx.bus` are present
3. Call `ctx.actionLogRepo.resolvePending(shortRef)` — fail on not-found/ambiguous
4. Call `ctx.actionLogRepo.resolveRow(row.id, 'denied', 'ceo')`
5. Publish `human.decision`: `decision: 'deny'`
6. Return success with the denied action's description

#### `dismiss-action`

- **Directory:** `skills/dismiss-action/`
- **Manifest:** `action_risk: "none"`, `sensitivity: "elevated"`, `capabilities: ["bus", "actionLogRepo"]`
- **Input:** `short_ref: "string?"`
- **Output:** `result: "string"` (confirmation message)

Handler flow:
1. CEO-origin check
2. Validate `ctx.actionLogRepo` and `ctx.bus` are present
3. Call `ctx.actionLogRepo.resolvePending(shortRef)` — fail on not-found/ambiguous
4. Call `ctx.actionLogRepo.resolveRow(row.id, 'resolved_externally', 'ceo')`
5. Publish `human.decision`: `decision: 'dismiss'`
6. Return success with the dismissed action's description

#### `list-pending-actions`

- **Directory:** `skills/list-pending-actions/`
- **Manifest:** `action_risk: "none"`, `sensitivity: "elevated"`, `capabilities: ["actionLogRepo"]`
- **Input:** (none)
- **Output:** `pending: "object[]"`

Handler flow:
1. CEO-origin check
2. Validate `ctx.actionLogRepo` is present
3. Call `ctx.actionLogRepo.findAllPending()`
4. Return the list, mapping each row to: `{ short_ref, description, skill_name, created_at, expires_at }`
5. If no pending rows, return success with empty list and a message

### 7. Coordinator changes

**Pin skills** — add to `pinned_skills` in `agents/coordinator.yaml`:
- `approve-action`
- `deny-action`
- `dismiss-action`
- `list-pending-actions`

**Prompt guidance** — add after the existing "Audience Awareness" section:

```
## Pending Approval Requests
When the autonomy gate blocks a skill, Curia creates a pending approval
request and notifies the CEO. Each request has a short_ref (e.g. "cal-1",
"email-2") and a human-readable description.

When the CEO responds to an approval notification (or asks about pending
requests):
- Use list-pending-actions to see all pending requests
- Match the CEO's natural language to a specific short_ref using the
  description (e.g. "approve the calendar event" → the cal-* request)
- When only one request is pending, short_ref can be omitted
- Use approve-action to approve, deny-action to deny, dismiss-action
  when the CEO handled it outside Curia
- If the CEO's intent is ambiguous and multiple requests are pending,
  show the list and ask which one they mean
```

### 8. Test coverage

Each skill gets a handler test file covering:
- Happy path (single pending row, with and without explicit `short_ref`)
- Ambiguous resolution (multiple pending, no `short_ref` → error listing them)
- Not-found / expired / already-resolved cases
- CEO-origin gate rejection (non-CEO caller blocked)
- Missing capability graceful error

`approve-action` additionally:
- Re-execution success → child row with `outcome: 'success'`
- Re-execution failure → child row with `outcome: 'failure'`, CEO gets error
- `human.decision` event published with correct payload

`ActionLogRepo` new methods:
- `resolvePending` with each discriminated union case
- `resolveRow` idempotency (double-resolve is a no-op)
- `findAllPending` excludes expired rows
- `insert` with `parentActionId`

Migration 032:
- Unique constraint prevents duplicate `short_ref` within same `task_id`

`ApprovalTriggerService`:
- Retry on unique violation succeeds with incremented counter
