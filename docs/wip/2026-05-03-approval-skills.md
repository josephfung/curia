# Approval Management Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four CEO-facing skills (approve-action, deny-action, dismiss-action, list-pending-actions) that resolve pending approval requests created by the autonomy gate trigger (#427).

**Architecture:** Skills follow the existing `skill.json` + handler class pattern. All are `sensitivity: "elevated"` (CEO-only), `action_risk: "none"`. `approve-action` re-executes blocked skills via a new `executionLayer` capability. All four skills access `ActionLogRepo` via a new `actionLogRepo` capability. A UNIQUE constraint on `(task_id, short_ref)` fixes the race condition from #436 review.

**Tech Stack:** TypeScript (ESM), Postgres, vitest, node-pg-migrate

**Worktree:** `/Users/josephfung/Projects/worktrees/curia-approval-skills` (branch `feat/approval-skills`)

**Spec:** `docs/wip/2026-05-03-approval-skills-design.md`

---

## File Structure

**Create:**
- `src/db/migrations/032_unique_task_short_ref.sql` — UNIQUE constraint migration
- `skills/approve-action/skill.json` — manifest
- `skills/approve-action/handler.ts` — handler
- `skills/approve-action/handler.test.ts` — tests
- `skills/deny-action/skill.json` — manifest
- `skills/deny-action/handler.ts` — handler
- `skills/deny-action/handler.test.ts` — tests
- `skills/dismiss-action/skill.json` — manifest
- `skills/dismiss-action/handler.ts` — handler
- `skills/dismiss-action/handler.test.ts` — tests
- `skills/list-pending-actions/skill.json` — manifest
- `skills/list-pending-actions/handler.ts` — handler
- `skills/list-pending-actions/handler.test.ts` — tests

**Modify:**
- `src/autonomy/action-log-types.ts` — add `parentActionId` to `ActionLogInsert`, export `ResolveResult` type
- `src/autonomy/action-log-repo.ts` — add `resolvePending()`, `findAllPending()`, `resolveRow()`, extend `insert()` for `parentActionId`
- `src/autonomy/action-log-repo.test.ts` — tests for new methods
- `src/autonomy/approval-trigger.ts` — retry loop on unique violation in `request()`
- `src/autonomy/approval-trigger.test.ts` — test for retry
- `src/skills/types.ts` — add `executionLayer` and `actionLogRepo` to `SkillContext`
- `src/skills/loader.ts` — add `executionLayer` and `actionLogRepo` to `VALID_CAPABILITIES`
- `src/skills/execution.ts` — add `actionLogRepo` to constructor options and `capabilityServices`, add `executionLayer: this`
- `src/bus/events.ts` — add `'dismiss'` to `HumanDecisionPayload.decision`
- `src/index.ts` — pass `actionLogRepo` to `ExecutionLayer`
- `agents/coordinator.yaml` — pin skills, add prompt guidance

---

### Task 1: Migration — UNIQUE constraint on `(task_id, short_ref)`

**Files:**
- Create: `src/db/migrations/032_unique_task_short_ref.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 032_unique_task_short_ref.sql
--
-- Adds a UNIQUE constraint on (task_id, short_ref) to prevent race conditions
-- in short_ref generation. Null short_ref values (non-approval rows) do not
-- violate the constraint — Postgres treats nulls as never equal.
--
-- See issue #428 and the #436 review discussion.

ALTER TABLE autonomy_action_log
  ADD CONSTRAINT uq_aal_task_short_ref UNIQUE (task_id, short_ref);
```

- [ ] **Step 2: Verify the migration file exists and is valid SQL**

Run: `cat src/db/migrations/032_unique_task_short_ref.sql`
Expected: The SQL above, no syntax errors.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/032_unique_task_short_ref.sql
git commit -m "feat(db): add UNIQUE(task_id, short_ref) constraint on autonomy_action_log (#428)"
```

---

### Task 2: Extend `ActionLogInsert` with `parentActionId` and update `insert()`

**Files:**
- Modify: `src/autonomy/action-log-types.ts:61-74`
- Modify: `src/autonomy/action-log-repo.ts:23-45`
- Modify: `src/autonomy/action-log-repo.test.ts`

- [ ] **Step 1: Write the failing test for `insert()` with `parentActionId`**

Add to the `describe('insert', ...)` block in `src/autonomy/action-log-repo.test.ts`:

```typescript
it('includes parent_action_id in INSERT when provided', async () => {
  const { pool, queries } = makePool([{ id: 99 }]);
  const repo = new ActionLogRepo(pool, createSilentLogger());
  const id = await repo.insert({
    taskId: 'task-1',
    skillName: 'calendar-create-event',
    actionRisk: 'high',
    outcome: 'success',
    parentActionId: 42,
  });
  expect(id).toBe(99);
  expect(queries[0]!.sql).toContain('parent_action_id');
  expect(queries[0]!.params).toContain(42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: FAIL — `parentActionId` does not exist on `ActionLogInsert`

- [ ] **Step 3: Add `parentActionId` to `ActionLogInsert`**

In `src/autonomy/action-log-types.ts`, add to the `ActionLogInsert` interface after the existing approval lifecycle fields comment:

```typescript
/** Fields required to insert a new autonomy_action_log row. */
export interface ActionLogInsert {
  taskId: string;
  conversationId?: string;
  skillName: string;
  actionRisk: string;
  outcome: ActionLogOutcome;
  taskSummary?: string;

  // Approval lifecycle fields (optional — used by #427/#428)
  payload?: Record<string, unknown>;
  expiresAt?: Date;
  shortRef?: string;
  description?: string;
  /** Links a re-execution row back to the approved row. Used by approve-action (#428). */
  parentActionId?: number;
}
```

- [ ] **Step 4: Update `insert()` to include `parent_action_id`**

In `src/autonomy/action-log-repo.ts`, replace the `insert` method:

```typescript
/** Insert a new row and return the generated id. */
async insert(row: ActionLogInsert): Promise<number> {
  const result = await this.pool.query<{ id: number }>(
    `INSERT INTO autonomy_action_log
       (task_id, conversation_id, skill_name, action_risk, outcome, task_summary,
        payload, expires_at, short_ref, description, parent_action_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      row.taskId,
      row.conversationId ?? null,
      row.skillName,
      row.actionRisk,
      row.outcome,
      row.taskSummary ?? null,
      row.payload ? JSON.stringify(row.payload) : null,
      row.expiresAt ?? null,
      row.shortRef ?? null,
      row.description ?? null,
      row.parentActionId ?? null,
    ],
  );
  this.logger.debug({ id: result.rows[0]!.id, skillName: row.skillName, outcome: row.outcome }, 'action-log-repo: inserted row');
  return result.rows[0]!.id;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/autonomy/action-log-types.ts src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git commit -m "feat(autonomy): add parentActionId to ActionLogInsert and insert() (#428)"
```

---

### Task 3: Add `ResolveResult` type, `findAllPending()`, `resolveRow()`, and `resolvePending()` to `ActionLogRepo`

**Files:**
- Modify: `src/autonomy/action-log-types.ts`
- Modify: `src/autonomy/action-log-repo.ts`
- Modify: `src/autonomy/action-log-repo.test.ts`

- [ ] **Step 1: Add `ResolveResult` type to `action-log-types.ts`**

Append after the `DETERMINISTIC_SCORES` block:

```typescript
/** Result of resolving a short_ref to a pending_approval row. */
export type ResolveResult =
  | { found: true; row: ActionLogRow }
  | { found: false; reason: 'not_found'; error: string }
  | { found: false; reason: 'ambiguous'; error: string; pending: ActionLogRow[] }
  | { found: false; reason: 'expired'; error: string }
  | { found: false; reason: 'already_resolved'; error: string };
```

- [ ] **Step 2: Write the failing tests for `findAllPending()`**

Add to `src/autonomy/action-log-repo.test.ts`:

```typescript
describe('findAllPending', () => {
  it('returns pending rows ordered by created_at asc', async () => {
    const now = new Date();
    const { pool } = makePool([
      {
        id: 1, task_id: 't1', conversation_id: null, skill_name: 'calendar-create-event',
        action_risk: 'high', outcome: 'pending_approval', task_summary: null,
        competence_flag: null, commitment_flag: null, compatibility: null,
        scored_by: null, payload: { title: 'Lunch' }, notification_sent_at: null,
        resolved_at: null, resolved_by: null, expires_at: new Date(Date.now() + 86_400_000),
        parent_action_id: null, short_ref: 'cal-1', description: 'Create calendar event: Lunch',
        created_at: now,
      },
    ]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const rows = await repo.findAllPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shortRef).toBe('cal-1');
  });

  it('uses the correct SQL filter for pending + non-expired', async () => {
    const { pool, queries } = makePool([]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    await repo.findAllPending();
    expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
    expect(queries[0]!.sql).toContain('expires_at > now()');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: FAIL — `findAllPending` is not a function

- [ ] **Step 4: Implement `findAllPending()`**

Add to `ActionLogRepo` class in `src/autonomy/action-log-repo.ts`, after `setNotificationSentAt()`:

```typescript
/**
 * Return all non-expired pending_approval rows, oldest first.
 * Used by list-pending-actions and by resolvePending() when no short_ref is given.
 */
async findAllPending(): Promise<ActionLogRow[]> {
  const result = await this.pool.query(
    `SELECT * FROM autonomy_action_log
     WHERE outcome = 'pending_approval'
       AND expires_at > now()
     ORDER BY created_at ASC`,
  );
  return result.rows.map(mapRow);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Write the failing tests for `resolveRow()`**

Add to `src/autonomy/action-log-repo.test.ts`:

```typescript
describe('resolveRow', () => {
  it('updates outcome, resolved_at, and resolved_by for a pending row', async () => {
    const { pool, queries } = makePool([], 1);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    await repo.resolveRow(42, 'approved', 'ceo');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('UPDATE autonomy_action_log');
    expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
    expect(queries[0]!.params).toContain(42);
    expect(queries[0]!.params).toContain('approved');
    expect(queries[0]!.params).toContain('ceo');
  });

  it('accepts denied outcome', async () => {
    const { pool, queries } = makePool([], 1);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    await repo.resolveRow(10, 'denied', 'ceo');
    expect(queries[0]!.params).toContain('denied');
  });

  it('accepts resolved_externally outcome', async () => {
    const { pool, queries } = makePool([], 1);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    await repo.resolveRow(10, 'resolved_externally', 'ceo');
    expect(queries[0]!.params).toContain('resolved_externally');
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: FAIL — `resolveRow` is not a function

- [ ] **Step 8: Implement `resolveRow()`**

Add to `ActionLogRepo` class, after `findAllPending()`:

```typescript
/**
 * Transition a pending_approval row to a terminal outcome.
 * Only updates if the current outcome is still pending_approval —
 * silently no-ops on double-resolve (idempotent).
 */
async resolveRow(
  id: number,
  outcome: 'approved' | 'denied' | 'resolved_externally',
  resolvedBy: string,
): Promise<void> {
  await this.pool.query(
    `UPDATE autonomy_action_log
     SET outcome = $2, resolved_at = now(), resolved_by = $3
     WHERE id = $1 AND outcome = 'pending_approval'`,
    [id, outcome, resolvedBy],
  );
  this.logger.debug({ id, outcome, resolvedBy }, 'action-log-repo: row resolved');
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: ALL PASS

- [ ] **Step 10: Write the failing tests for `resolvePending()`**

Add to `src/autonomy/action-log-repo.test.ts`. These tests need a `makePool` that can return different results per call, so add a multi-call helper first:

```typescript
function makeSequentialPool(
  callResults: Array<Record<string, unknown>[]>,
): { pool: Pool; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let callIndex = 0;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });
      const rows = callResults[callIndex] ?? [];
      callIndex++;
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    }),
  } as unknown as Pool;
  return { pool, queries };
}
```

Then the tests:

```typescript
describe('resolvePending', () => {
  const pendingRow = {
    id: 10, task_id: 't1', conversation_id: null, skill_name: 'calendar-create-event',
    action_risk: 'high', outcome: 'pending_approval', task_summary: null,
    competence_flag: null, commitment_flag: null, compatibility: null,
    scored_by: null, payload: { title: 'Lunch' }, notification_sent_at: null,
    resolved_at: null, resolved_by: null, expires_at: new Date(Date.now() + 86_400_000),
    parent_action_id: null, short_ref: 'cal-1', description: 'Create calendar event: Lunch',
    created_at: new Date(),
  };

  it('resolves by short_ref when provided', async () => {
    const { pool } = makePool([pendingRow]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const result = await repo.resolvePending('cal-1');
    expect(result.found).toBe(true);
    if (result.found) expect(result.row.id).toBe(10);
  });

  it('returns not_found when short_ref does not match any row', async () => {
    const { pool } = makePool([]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const result = await repo.resolvePending('cal-99');
    expect(result).toEqual({
      found: false,
      reason: 'not_found',
      error: expect.stringContaining('cal-99'),
    });
  });

  it('returns already_resolved when row exists but is not pending', async () => {
    const resolvedRow = { ...pendingRow, outcome: 'approved' };
    // First query (by short_ref, pending only) returns nothing;
    // second query (by short_ref, any outcome) returns the resolved row.
    const { pool } = makeSequentialPool([[], [resolvedRow]]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const result = await repo.resolvePending('cal-1');
    expect(result).toEqual({
      found: false,
      reason: 'already_resolved',
      error: expect.stringContaining('already resolved'),
    });
  });

  it('returns expired when row is pending but past expires_at', async () => {
    const expiredRow = { ...pendingRow, expires_at: new Date(Date.now() - 1000) };
    // First query (pending + non-expired) returns nothing;
    // second query (any outcome) returns the expired row.
    const { pool } = makeSequentialPool([[], [expiredRow]]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const result = await repo.resolvePending('cal-1');
    expect(result).toEqual({
      found: false,
      reason: 'expired',
      error: expect.stringContaining('expired'),
    });
  });

  it('resolves to sole pending row when no short_ref provided', async () => {
    // findAllPending returns one row
    const { pool } = makePool([pendingRow]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const result = await repo.resolvePending();
    expect(result.found).toBe(true);
    if (result.found) expect(result.row.id).toBe(10);
  });

  it('returns not_found when no short_ref and no pending rows', async () => {
    const { pool } = makePool([]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const result = await repo.resolvePending();
    expect(result).toEqual({
      found: false,
      reason: 'not_found',
      error: expect.stringContaining('No pending'),
    });
  });

  it('returns ambiguous when no short_ref and multiple pending rows', async () => {
    const row2 = { ...pendingRow, id: 11, short_ref: 'email-1', skill_name: 'email-reply' };
    const { pool } = makePool([pendingRow, row2]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const result = await repo.resolvePending();
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe('ambiguous');
      expect((result as { pending: unknown[] }).pending).toHaveLength(2);
    }
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: FAIL — `resolvePending` is not a function

- [ ] **Step 12: Implement `resolvePending()`**

Add to `ActionLogRepo` class, after `resolveRow()`. Also add the import for `ResolveResult` at the top of the file:

At the top of `action-log-repo.ts`, update the import:

```typescript
import type {
  ActionLogRow,
  ActionLogInsert,
  ScoringFlags,
  ResolveResult,
} from './action-log-types.js';
```

Then add the method:

```typescript
/**
 * Resolve a short_ref (or the sole pending row) to a single ActionLogRow.
 *
 * When short_ref is provided: look up by short_ref. If the row is not
 * pending_approval, check whether it's already resolved or expired.
 * When omitted: fetch all non-expired pending rows. If exactly one,
 * return it. If multiple, return ambiguous with the list.
 */
async resolvePending(shortRef?: string): Promise<ResolveResult> {
  if (shortRef !== undefined) {
    // Look up by short_ref — pending + non-expired only
    const pending = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE short_ref = $1
         AND outcome = 'pending_approval'
         AND expires_at > now()
       LIMIT 1`,
      [shortRef],
    );
    if (pending.rows.length > 0) {
      return { found: true, row: mapRow(pending.rows[0]) };
    }

    // Not found as pending — check if it exists at all (any outcome)
    const any = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE short_ref = $1
       LIMIT 1`,
      [shortRef],
    );
    if (any.rows.length === 0) {
      return { found: false, reason: 'not_found', error: `No approval request found with reference '${shortRef}'` };
    }

    const row = mapRow(any.rows[0]);
    if (row.outcome !== 'pending_approval') {
      return { found: false, reason: 'already_resolved', error: `Request '${shortRef}' has already been resolved (outcome: ${row.outcome})` };
    }
    // outcome is pending_approval but expires_at <= now()
    return { found: false, reason: 'expired', error: `Request '${shortRef}' has expired` };
  }

  // No short_ref — resolve to the sole pending row
  const allPending = await this.findAllPending();
  if (allPending.length === 0) {
    return { found: false, reason: 'not_found', error: 'No pending approval requests' };
  }
  if (allPending.length === 1) {
    return { found: true, row: allPending[0]! };
  }
  const refs = allPending.map(r => `${r.shortRef}: ${r.description}`).join(', ');
  return {
    found: false,
    reason: 'ambiguous',
    error: `Multiple pending requests — specify a short_ref. Pending: ${refs}`,
    pending: allPending,
  };
}
```

- [ ] **Step 13: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/action-log-repo.test.ts`
Expected: ALL PASS

- [ ] **Step 14: Run full test suite to check for regressions**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test`
Expected: ALL PASS

- [ ] **Step 15: Commit**

```bash
git add src/autonomy/action-log-types.ts src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git commit -m "feat(autonomy): add resolvePending, findAllPending, resolveRow to ActionLogRepo (#428)"
```

---

### Task 4: Retry loop in `ApprovalTriggerService.request()`

**Files:**
- Modify: `src/autonomy/approval-trigger.ts:155-173`
- Modify: `src/autonomy/approval-trigger.test.ts`

- [ ] **Step 1: Write the failing test for retry on unique violation**

Add to `src/autonomy/approval-trigger.test.ts` inside the `describe('ApprovalTriggerService.request()', ...)` block:

```typescript
it('retries on unique_violation (23505) and succeeds with incremented counter', async () => {
  // First insert throws unique_violation; second succeeds.
  const insertMock = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('unique_violation'), { code: '23505' }))
    .mockResolvedValueOnce(2);
  // countShortRefsForTask returns 0 first, then 1 after retry.
  const countMock = vi.fn()
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)  // second call during retry re-counts
    .mockResolvedValueOnce(1);
  const repo = makeMockRepo({
    insert: insertMock,
    countShortRefsForTask: countMock,
  });
  const gateway = makeMockGateway();
  const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

  const result = await service.request(BASE_OPTS);

  expect(result.created).toBe(true);
  if (result.created) {
    expect(result.shortRef).toBe('cal-2'); // counter was 1 on retry
  }
  expect(insertMock).toHaveBeenCalledTimes(2);
});

it('gives up after 3 retries on persistent unique_violation', async () => {
  const insertMock = vi.fn().mockRejectedValue(
    Object.assign(new Error('unique_violation'), { code: '23505' }),
  );
  const repo = makeMockRepo({ insert: insertMock });
  const gateway = makeMockGateway();
  const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

  await expect(service.request(BASE_OPTS)).rejects.toThrow('unique_violation');
  expect(insertMock).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/approval-trigger.test.ts`
Expected: FAIL — no retry logic, first insert failure propagates

- [ ] **Step 3: Add retry loop to `request()`**

In `src/autonomy/approval-trigger.ts`, replace the Step 2 + Step 3 block (lines ~154–173) with:

```typescript
    // Step 2 + 3: Generate short_ref, description, and insert row.
    // Retry on unique_violation (23505) — the countShortRefsForTask + 1 pattern
    // can race under concurrency. The UNIQUE(task_id, short_ref) constraint (#428)
    // catches the collision; we re-count and retry.
    const MAX_INSERT_RETRIES = 3;
    let rowId!: number;
    let shortRef!: string;
    let description!: string;
    let expiresAt!: Date;

    for (let attempt = 1; attempt <= MAX_INSERT_RETRIES; attempt++) {
      const counter = await this.actionLogRepo.countShortRefsForTask(taskId);
      shortRef = `${shortRefPrefix(skillName)}-${counter + 1}`;
      // Sanitize description before storing and sending — the input fields come from
      // LLM-generated skill arguments and may contain dangerous tags.
      description = sanitizeOutput(buildDescription(skillName, input));
      expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now

      try {
        rowId = await this.actionLogRepo.insert({
          taskId,
          conversationId,
          skillName,
          actionRisk,
          outcome: 'pending_approval',
          payload: input,
          expiresAt,
          shortRef,
          description,
        });
        break; // Insert succeeded
      } catch (err) {
        const isUniqueViolation = (err as { code?: string }).code === '23505';
        if (isUniqueViolation && attempt < MAX_INSERT_RETRIES) {
          this.logger.warn(
            { taskId, shortRef, attempt },
            'approval-trigger: short_ref collision — retrying with new counter',
          );
          continue;
        }
        throw err; // Non-unique error, or exhausted retries
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test src/autonomy/approval-trigger.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/autonomy/approval-trigger.ts src/autonomy/approval-trigger.test.ts
git commit -m "fix(autonomy): retry ApprovalTriggerService insert on short_ref collision (#428)"
```

---

### Task 5: Add `executionLayer` and `actionLogRepo` capabilities

**Files:**
- Modify: `src/skills/loader.ts:27-31`
- Modify: `src/skills/types.ts:113-192`
- Modify: `src/skills/execution.ts:63-128` (constructor + capabilityServices)
- Modify: `src/bus/events.ts:405-424`
- Modify: `src/index.ts:859`

- [ ] **Step 1: Add to `VALID_CAPABILITIES`**

In `src/skills/loader.ts`, update the `VALID_CAPABILITIES` set:

```typescript
export const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'bus', 'agentRegistry', 'outboundGateway', 'heldMessages',
  'schedulerService', 'entityMemory', 'nylasCalendarClient',
  'autonomyService', 'executiveProfileService', 'browserService', 'bullpenService', 'skillSearch',
  'actionLogRepo', 'executionLayer',
]);
```

- [ ] **Step 2: Add to `SkillContext`**

In `src/skills/types.ts`, add two fields to the `SkillContext` interface (after the `timezone` field):

```typescript
  /** Action log repo — available to skills declaring 'actionLogRepo' in capabilities.
   *  Provides read/write access to the autonomy_action_log table for approval lifecycle
   *  management. Used by approve-action, deny-action, dismiss-action, list-pending-actions. */
  actionLogRepo?: import('../autonomy/action-log-repo.js').ActionLogRepo;
  /** Execution layer — available to skills declaring 'executionLayer' in capabilities.
   *  Allows re-invocation of skills with humanApproved bypass. Only approve-action (#428)
   *  should declare this capability; it is sensitivity: "elevated" (CEO-only). */
  executionLayer?: import('./execution.js').ExecutionLayer;
```

- [ ] **Step 3: Add to `ExecutionLayer` constructor and `capabilityServices`**

In `src/skills/execution.ts`, add `actionLogRepo` to the constructor options interface (after `approvalTrigger`):

```typescript
    actionLogRepo?: import('../autonomy/action-log-repo.js').ActionLogRepo;
```

Add the field to the class:

```typescript
  private actionLogRepo?: import('../autonomy/action-log-repo.js').ActionLogRepo;
```

Add the assignment in the constructor:

```typescript
    this.actionLogRepo = options?.actionLogRepo;
```

In the `capabilityServices` map inside `invoke()`, add:

```typescript
      actionLogRepo: this.actionLogRepo,
      executionLayer: this,
```

- [ ] **Step 4: Add `'dismiss'` to `HumanDecisionPayload.decision`**

In `src/bus/events.ts`, update the `decision` field:

```typescript
  decision: 'approve' | 'deny' | 'dismiss' | 'modify' | 'escalate' | 'timeout';
```

- [ ] **Step 5: Wire `actionLogRepo` in `index.ts`**

In `src/index.ts`, add `actionLogRepo` to the `ExecutionLayer` constructor call. Find the line:

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService, entityMemory, agentPersona, nylasCalendarClient, entityContextAssembler, agentContactId: agentIdentityContactId, autonomyService, executiveProfileService, browserService, bullpenService, approvalTrigger, timezone: config.timezone, skillOutputMaxLength: yamlConfig.skillOutput?.maxLength });
```

Add `actionLogRepo` to the options object (after `approvalTrigger`):

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService, entityMemory, agentPersona, nylasCalendarClient, entityContextAssembler, agentContactId: agentIdentityContactId, autonomyService, executiveProfileService, browserService, bullpenService, approvalTrigger, actionLogRepo, timezone: config.timezone, skillOutputMaxLength: yamlConfig.skillOutput?.maxLength });
```

- [ ] **Step 6: Run typecheck**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills run typecheck`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 7: Run full test suite**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/skills/loader.ts src/skills/types.ts src/skills/execution.ts src/bus/events.ts src/index.ts
git commit -m "feat(skills): add executionLayer and actionLogRepo capabilities; add dismiss decision type (#428)"
```

---

### Task 6: `list-pending-actions` skill

**Files:**
- Create: `skills/list-pending-actions/skill.json`
- Create: `skills/list-pending-actions/handler.ts`
- Create: `skills/list-pending-actions/handler.test.ts`

- [ ] **Step 1: Write the test file**

Create `skills/list-pending-actions/handler.test.ts`:

```typescript
// handler.test.ts — unit tests for list-pending-actions skill.

import { describe, it, expect, vi } from 'vitest';
import { ListPendingActionsHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {},
    secret: () => '',
    log: createSilentLogger(),
    taskMetadata: { ceoInitiated: true, senderId: 'ceo-1', channelId: 'cli' },
    taskEventId: 'task-1',
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    findAllPending: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ActionLogRepo;
}

describe('ListPendingActionsHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ taskMetadata: {} }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
  });

  it('returns error when actionLogRepo is not available', async () => {
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns empty list with message when no pending rows', async () => {
    const repo = makeMockRepo();
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo }));
    expect(result.success).toBe(true);
    expect(result).toHaveProperty('data');
    const data = (result as { success: true; data: unknown }).data as { pending: unknown[]; message: string };
    expect(data.pending).toEqual([]);
    expect(data.message).toContain('No pending');
  });

  it('returns pending rows mapped to summary fields', async () => {
    const now = new Date();
    const expires = new Date(Date.now() + 86_400_000);
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([
        {
          id: 1, shortRef: 'cal-1', description: 'Create calendar event: Lunch',
          skillName: 'calendar-create-event', createdAt: now, expiresAt: expires,
        },
        {
          id: 2, shortRef: 'email-1', description: 'Send email reply: Re: Budget',
          skillName: 'email-reply', createdAt: now, expiresAt: expires,
        },
      ]),
    });
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo }));
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: unknown }).data as { pending: Array<Record<string, unknown>> };
    expect(data.pending).toHaveLength(2);
    expect(data.pending[0]).toEqual({
      short_ref: 'cal-1',
      description: 'Create calendar event: Lunch',
      skill_name: 'calendar-create-event',
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/list-pending-actions/handler.test.ts`
Expected: FAIL — file not found or module not found

- [ ] **Step 3: Create manifest**

Create `skills/list-pending-actions/skill.json`:

```json
{
  "name": "list-pending-actions",
  "description": "List all pending approval requests awaiting CEO decision. Returns short_ref, description, skill name, and expiry for each.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "none",
  "inputs": {},
  "outputs": {
    "pending": "object[] (list of pending approval requests)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "capabilities": ["actionLogRepo"]
}
```

- [ ] **Step 4: Implement handler**

Create `skills/list-pending-actions/handler.ts`:

```typescript
// handler.ts — list-pending-actions skill implementation.
//
// Returns all non-expired pending approval requests so the CEO can see what's
// waiting for their decision. Read-only — no state changes.
//
// SECURITY: sensitivity: "elevated" ensures only the CEO can call this.
// The ceoInitiated check is a defense-in-depth secondary gate.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ListPendingActionsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // CEO-origin check — defense-in-depth (elevated gate is primary)
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn('list-pending-actions: rejected — ceoInitiated flag absent or false');
      return { success: false, error: 'This skill requires direct CEO authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'list-pending-actions requires actionLogRepo capability' };
    }

    const rows = await ctx.actionLogRepo.findAllPending();

    const pending = rows.map((row) => ({
      short_ref: row.shortRef,
      description: row.description,
      skill_name: row.skillName,
      created_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt?.toISOString() ?? null,
    }));

    if (pending.length === 0) {
      return { success: true, data: { pending: [], message: 'No pending approval requests.' } };
    }

    return { success: true, data: { pending } };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/list-pending-actions/handler.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add skills/list-pending-actions/
git commit -m "feat(skills): add list-pending-actions skill (#428)"
```

---

### Task 7: `deny-action` skill

**Files:**
- Create: `skills/deny-action/skill.json`
- Create: `skills/deny-action/handler.ts`
- Create: `skills/deny-action/handler.test.ts`

- [ ] **Step 1: Write the test file**

Create `skills/deny-action/handler.test.ts`:

```typescript
// handler.test.ts — unit tests for deny-action skill.

import { describe, it, expect, vi } from 'vitest';
import { DenyActionHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import { createSilentLogger } from '../../src/logger.js';

const PENDING_ROW = {
  id: 10,
  taskId: 't1',
  conversationId: 'conv-1',
  skillName: 'calendar-create-event',
  actionRisk: 'high',
  outcome: 'pending_approval' as const,
  shortRef: 'cal-1',
  description: 'Create calendar event: Lunch',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  payload: { title: 'Lunch' },
  taskSummary: null,
  competenceFlag: null,
  commitmentFlag: null,
  compatibility: null,
  scoredBy: null,
  notificationSentAt: null,
  resolvedAt: null,
  resolvedBy: null,
  parentActionId: null,
};

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: { short_ref: 'cal-1' },
    secret: () => '',
    log: createSilentLogger(),
    taskMetadata: { ceoInitiated: true, senderId: 'ceo-1', channelId: 'cli' },
    taskEventId: 'task-1',
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    resolvePending: vi.fn().mockResolvedValue({ found: true, row: PENDING_ROW }),
    resolveRow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
}

describe('DenyActionHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ taskMetadata: {} }));
    expect(result.success).toBe(false);
  });

  it('returns error when actionLogRepo is missing', async () => {
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns error when bus is missing', async () => {
    const repo = makeMockRepo();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus: undefined }));
    expect(result.success).toBe(false);
  });

  it('denies a pending row and publishes human.decision', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    expect(result.success).toBe(true);
    expect(repo.resolveRow).toHaveBeenCalledWith(10, 'denied', 'ceo');
    expect(bus.publish).toHaveBeenCalledOnce();
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(event.type).toBe('human.decision');
    expect(event.payload.decision).toBe('deny');
  });

  it('forwards resolvePending errors', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: false, reason: 'not_found', error: 'No approval request found',
      }),
    });
    const bus = makeMockBus();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', 'No approval request found');
  });

  it('resolves sole pending row when short_ref is omitted', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ input: {}, actionLogRepo: repo, bus }));
    expect(result.success).toBe(true);
    expect(repo.resolvePending).toHaveBeenCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/deny-action/handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create manifest**

Create `skills/deny-action/skill.json`:

```json
{
  "name": "deny-action",
  "description": "Deny a pending approval request. The blocked action will not be executed. Specify short_ref to target a specific request, or omit when only one is pending.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "none",
  "inputs": {
    "short_ref": "string? (reference code from the approval notification, e.g. 'cal-1')"
  },
  "outputs": {
    "result": "string (confirmation message)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "capabilities": ["bus", "actionLogRepo"]
}
```

- [ ] **Step 4: Implement handler**

Create `skills/deny-action/handler.ts`:

```typescript
// handler.ts — deny-action skill implementation.
//
// Denies a pending approval request: transitions the autonomy_action_log row
// to outcome = 'denied' and publishes a human.decision audit event.
// No re-execution — the originally blocked skill stays blocked.
//
// SECURITY: sensitivity: "elevated" + ceoInitiated check.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';

export class DenyActionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn('deny-action: rejected — ceoInitiated flag absent or false');
      return { success: false, error: 'This skill requires direct CEO authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'deny-action requires actionLogRepo capability' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'deny-action requires bus capability' };
    }

    const shortRef = typeof ctx.input.short_ref === 'string' && ctx.input.short_ref.trim()
      ? ctx.input.short_ref.trim()
      : undefined;

    const resolved = await ctx.actionLogRepo.resolvePending(shortRef);
    if (!resolved.found) {
      return { success: false, error: resolved.error };
    }

    const { row } = resolved;

    await ctx.actionLogRepo.resolveRow(row.id, 'denied', 'ceo');

    // Publish human.decision audit event (best-effort)
    const senderId = typeof ctx.taskMetadata?.senderId === 'string' ? ctx.taskMetadata.senderId : 'unknown';
    const channelId = typeof ctx.taskMetadata?.channelId === 'string' ? ctx.taskMetadata.channelId : 'unknown';
    try {
      await ctx.bus.publish(
        'dispatch',
        createHumanDecision({
          decision: 'deny',
          deciderId: senderId,
          deciderChannel: channelId,
          subjectEventId: row.taskId,
          subjectSummary: `CEO denied: ${row.description ?? row.skillName}`,
          contextShown: ['short_ref', 'description', 'skill_name'],
          presentedAt: row.createdAt,
          decidedAt: new Date(),
          defaultAction: 'block',
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error({ err, rowId: row.id }, 'deny-action: failed to publish human.decision event');
    }

    ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'deny-action: request denied');
    return { success: true, data: `Denied: ${row.description ?? row.skillName} (${row.shortRef})` };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/deny-action/handler.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add skills/deny-action/
git commit -m "feat(skills): add deny-action skill (#428)"
```

---

### Task 8: `dismiss-action` skill

**Files:**
- Create: `skills/dismiss-action/skill.json`
- Create: `skills/dismiss-action/handler.ts`
- Create: `skills/dismiss-action/handler.test.ts`

- [ ] **Step 1: Write the test file**

Create `skills/dismiss-action/handler.test.ts`:

```typescript
// handler.test.ts — unit tests for dismiss-action skill.

import { describe, it, expect, vi } from 'vitest';
import { DismissActionHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import { createSilentLogger } from '../../src/logger.js';

const PENDING_ROW = {
  id: 10,
  taskId: 't1',
  conversationId: 'conv-1',
  skillName: 'calendar-create-event',
  actionRisk: 'high',
  outcome: 'pending_approval' as const,
  shortRef: 'cal-1',
  description: 'Create calendar event: Lunch',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  payload: { title: 'Lunch' },
  taskSummary: null,
  competenceFlag: null,
  commitmentFlag: null,
  compatibility: null,
  scoredBy: null,
  notificationSentAt: null,
  resolvedAt: null,
  resolvedBy: null,
  parentActionId: null,
};

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: { short_ref: 'cal-1' },
    secret: () => '',
    log: createSilentLogger(),
    taskMetadata: { ceoInitiated: true, senderId: 'ceo-1', channelId: 'cli' },
    taskEventId: 'task-1',
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    resolvePending: vi.fn().mockResolvedValue({ found: true, row: PENDING_ROW }),
    resolveRow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
}

describe('DismissActionHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ taskMetadata: {} }));
    expect(result.success).toBe(false);
  });

  it('dismisses a pending row with resolved_externally', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    expect(result.success).toBe(true);
    expect(repo.resolveRow).toHaveBeenCalledWith(10, 'resolved_externally', 'ceo');
  });

  it('publishes human.decision with dismiss decision type', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(event.type).toBe('human.decision');
    expect(event.payload.decision).toBe('dismiss');
  });

  it('forwards resolvePending errors', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: false, reason: 'expired', error: 'Request has expired',
      }),
    });
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', 'Request has expired');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/dismiss-action/handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create manifest**

Create `skills/dismiss-action/skill.json`:

```json
{
  "name": "dismiss-action",
  "description": "Dismiss a pending approval request because the CEO handled the action outside Curia (e.g. created the calendar event directly). Specify short_ref to target a specific request, or omit when only one is pending.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "none",
  "inputs": {
    "short_ref": "string? (reference code from the approval notification, e.g. 'cal-1')"
  },
  "outputs": {
    "result": "string (confirmation message)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "capabilities": ["bus", "actionLogRepo"]
}
```

- [ ] **Step 4: Implement handler**

Create `skills/dismiss-action/handler.ts`:

```typescript
// handler.ts — dismiss-action skill implementation.
//
// Dismisses a pending approval request: transitions to outcome = 'resolved_externally'.
// Used when the CEO handled the action outside Curia.
//
// SECURITY: sensitivity: "elevated" + ceoInitiated check.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';

export class DismissActionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn('dismiss-action: rejected — ceoInitiated flag absent or false');
      return { success: false, error: 'This skill requires direct CEO authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'dismiss-action requires actionLogRepo capability' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'dismiss-action requires bus capability' };
    }

    const shortRef = typeof ctx.input.short_ref === 'string' && ctx.input.short_ref.trim()
      ? ctx.input.short_ref.trim()
      : undefined;

    const resolved = await ctx.actionLogRepo.resolvePending(shortRef);
    if (!resolved.found) {
      return { success: false, error: resolved.error };
    }

    const { row } = resolved;

    await ctx.actionLogRepo.resolveRow(row.id, 'resolved_externally', 'ceo');

    // Publish human.decision audit event (best-effort)
    const senderId = typeof ctx.taskMetadata?.senderId === 'string' ? ctx.taskMetadata.senderId : 'unknown';
    const channelId = typeof ctx.taskMetadata?.channelId === 'string' ? ctx.taskMetadata.channelId : 'unknown';
    try {
      await ctx.bus.publish(
        'dispatch',
        createHumanDecision({
          decision: 'dismiss',
          deciderId: senderId,
          deciderChannel: channelId,
          subjectEventId: row.taskId,
          subjectSummary: `CEO dismissed (handled externally): ${row.description ?? row.skillName}`,
          contextShown: ['short_ref', 'description', 'skill_name'],
          presentedAt: row.createdAt,
          decidedAt: new Date(),
          defaultAction: 'block',
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error({ err, rowId: row.id }, 'dismiss-action: failed to publish human.decision event');
    }

    ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'dismiss-action: request dismissed');
    return { success: true, data: `Dismissed: ${row.description ?? row.skillName} (${row.shortRef})` };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/dismiss-action/handler.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add skills/dismiss-action/
git commit -m "feat(skills): add dismiss-action skill (#428)"
```

---

### Task 9: `approve-action` skill

**Files:**
- Create: `skills/approve-action/skill.json`
- Create: `skills/approve-action/handler.ts`
- Create: `skills/approve-action/handler.test.ts`

- [ ] **Step 1: Write the test file**

Create `skills/approve-action/handler.test.ts`:

```typescript
// handler.test.ts — unit tests for approve-action skill.

import { describe, it, expect, vi } from 'vitest';
import { ApproveActionHandler } from './handler.js';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { ExecutionLayer } from '../../src/skills/execution.js';
import { createSilentLogger } from '../../src/logger.js';

const PENDING_ROW = {
  id: 10,
  taskId: 't1',
  conversationId: 'conv-1',
  skillName: 'calendar-create-event',
  actionRisk: 'high',
  outcome: 'pending_approval' as const,
  shortRef: 'cal-1',
  description: 'Create calendar event: Lunch',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  payload: { title: 'Lunch with Dana' },
  taskSummary: null,
  competenceFlag: null,
  commitmentFlag: null,
  compatibility: null,
  scoredBy: null,
  notificationSentAt: null,
  resolvedAt: null,
  resolvedBy: null,
  parentActionId: null,
};

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: { short_ref: 'cal-1' },
    secret: () => '',
    log: createSilentLogger(),
    taskMetadata: { ceoInitiated: true, senderId: 'ceo-1', channelId: 'cli' },
    taskEventId: 'task-1',
    caller: { contactId: 'ceo-1', role: 'ceo', channel: 'cli' },
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    resolvePending: vi.fn().mockResolvedValue({ found: true, row: PENDING_ROW }),
    resolveRow: vi.fn().mockResolvedValue(undefined),
    insert: vi.fn().mockResolvedValue(99),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
}

function makeMockExecutionLayer(result?: SkillResult): ExecutionLayer {
  return {
    invoke: vi.fn().mockResolvedValue(result ?? { success: true, data: { event_id: 'evt-123' } }),
  } as unknown as ExecutionLayer;
}

describe('ApproveActionHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({ taskMetadata: {} }));
    expect(result.success).toBe(false);
  });

  it('returns error when executionLayer is missing', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: undefined,
    }));
    expect(result.success).toBe(false);
  });

  it('approves, re-executes, writes child row, publishes audit event', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const handler = new ApproveActionHandler();

    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));

    // Verify approval transition
    expect(repo.resolveRow).toHaveBeenCalledWith(10, 'approved', 'ceo');

    // Verify re-execution
    expect(execLayer.invoke).toHaveBeenCalledOnce();
    const invokeArgs = (execLayer.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(invokeArgs[0]).toBe('calendar-create-event'); // skillName
    expect(invokeArgs[1]).toEqual({ title: 'Lunch with Dana' }); // payload
    expect(invokeArgs[3]).toMatchObject({ humanApproved: true }); // options

    // Verify child row
    expect(repo.insert).toHaveBeenCalledOnce();
    const childRow = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(childRow.parentActionId).toBe(10);
    expect(childRow.outcome).toBe('success');

    // Verify audit event
    expect(bus.publish).toHaveBeenCalledOnce();
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(event.type).toBe('human.decision');
    expect(event.payload.decision).toBe('approve');

    // Verify return
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toHaveProperty('reExecutionResult');
  });

  it('writes failure child row when re-execution fails', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer({ success: false, error: 'Calendar slot taken' });
    const handler = new ApproveActionHandler();

    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));

    // Child row records the failure
    const childRow = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(childRow.outcome).toBe('failure');
    expect(childRow.taskSummary).toBe('Calendar slot taken');

    // Still returns success — the approval itself succeeded, re-execution failed
    expect(result.success).toBe(true);
    const data = (result as { data: unknown }).data as Record<string, unknown>;
    expect(data.reExecutionSuccess).toBe(false);
  });

  it('forwards resolvePending ambiguous error with pending list', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: false, reason: 'ambiguous',
        error: 'Multiple pending requests — specify a short_ref.',
        pending: [PENDING_ROW, { ...PENDING_ROW, id: 11, shortRef: 'email-1' }],
      }),
    });
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('Multiple pending'));
  });

  it('returns error when row has null payload', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: true,
        row: { ...PENDING_ROW, payload: null },
      }),
    });
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('payload'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/approve-action/handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create manifest**

Create `skills/approve-action/skill.json`:

```json
{
  "name": "approve-action",
  "description": "Approve a pending approval request. Re-executes the originally blocked skill with CEO authorization. Specify short_ref to target a specific request, or omit when only one is pending.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "none",
  "inputs": {
    "short_ref": "string? (reference code from the approval notification, e.g. 'cal-1')"
  },
  "outputs": {
    "result": "object (re-execution result and approval status)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 60000,
  "capabilities": ["bus", "actionLogRepo", "executionLayer"]
}
```

- [ ] **Step 4: Implement handler**

Create `skills/approve-action/handler.ts`:

```typescript
// handler.ts — approve-action skill implementation.
//
// Approves a pending approval request: transitions the row to 'approved',
// re-executes the originally blocked skill with humanApproved: true,
// writes a child autonomy_action_log row for the re-execution result,
// and publishes a human.decision audit event.
//
// SECURITY: sensitivity: "elevated" + ceoInitiated check.
// executionLayer capability is restricted to this skill.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';

export class ApproveActionHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // CEO-origin check
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn('approve-action: rejected — ceoInitiated flag absent or false');
      return { success: false, error: 'This skill requires direct CEO authorization.' };
    }

    if (!ctx.actionLogRepo) {
      return { success: false, error: 'approve-action requires actionLogRepo capability' };
    }
    if (!ctx.bus) {
      return { success: false, error: 'approve-action requires bus capability' };
    }
    if (!ctx.executionLayer) {
      return { success: false, error: 'approve-action requires executionLayer capability' };
    }

    // Resolve the pending row
    const shortRef = typeof ctx.input.short_ref === 'string' && ctx.input.short_ref.trim()
      ? ctx.input.short_ref.trim()
      : undefined;

    const resolved = await ctx.actionLogRepo.resolvePending(shortRef);
    if (!resolved.found) {
      return { success: false, error: resolved.error };
    }

    const { row } = resolved;

    // Validate payload exists — re-execution needs the original skill input
    if (!row.payload) {
      ctx.log.error({ rowId: row.id }, 'approve-action: row has null payload — cannot re-execute');
      return { success: false, error: `Cannot approve request '${row.shortRef}': no stored payload for re-execution` };
    }

    // Step 1: Transition to approved
    await ctx.actionLogRepo.resolveRow(row.id, 'approved', 'ceo');
    ctx.log.info({ rowId: row.id, shortRef: row.shortRef }, 'approve-action: row transitioned to approved');

    // Step 2: Re-execute the original skill with humanApproved bypass
    const reResult = await ctx.executionLayer.invoke(
      row.skillName,
      row.payload,
      ctx.caller,
      {
        humanApproved: true,
        taskEventId: ctx.taskEventId,
        conversationId: row.conversationId ?? undefined,
      },
    );

    // Step 3: Write child row for the re-execution result
    const childOutcome = reResult.success ? 'success' : 'failure';
    try {
      await ctx.actionLogRepo.insert({
        taskId: row.taskId,
        conversationId: row.conversationId ?? undefined,
        skillName: row.skillName,
        actionRisk: row.actionRisk,
        outcome: childOutcome,
        taskSummary: reResult.success ? null : (reResult as { error: string }).error,
        parentActionId: row.id,
      });
    } catch (err) {
      // Child row failure is non-fatal — the re-execution already happened.
      ctx.log.error({ err, rowId: row.id }, 'approve-action: failed to insert child action_log row');
    }

    // Step 4: Publish human.decision audit event (best-effort)
    const senderId = typeof ctx.taskMetadata?.senderId === 'string' ? ctx.taskMetadata.senderId : 'unknown';
    const channelId = typeof ctx.taskMetadata?.channelId === 'string' ? ctx.taskMetadata.channelId : 'unknown';
    try {
      await ctx.bus.publish(
        'dispatch',
        createHumanDecision({
          decision: 'approve',
          deciderId: senderId,
          deciderChannel: channelId,
          subjectEventId: row.taskId,
          subjectSummary: `CEO approved: ${row.description ?? row.skillName}`,
          contextShown: ['short_ref', 'description', 'skill_name', 'payload'],
          presentedAt: row.createdAt,
          decidedAt: new Date(),
          defaultAction: 'block',
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error({ err, rowId: row.id }, 'approve-action: failed to publish human.decision event');
    }

    ctx.log.info(
      { rowId: row.id, shortRef: row.shortRef, reExecutionSuccess: reResult.success },
      'approve-action: completed',
    );

    return {
      success: true,
      data: {
        approved: row.shortRef,
        description: row.description,
        reExecutionSuccess: reResult.success,
        reExecutionResult: reResult.success ? reResult.data : (reResult as { error: string }).error,
      },
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test skills/approve-action/handler.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add skills/approve-action/
git commit -m "feat(skills): add approve-action skill with re-execution (#428)"
```

---

### Task 10: Coordinator changes — pin skills and add prompt guidance

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Pin the four new skills**

In `agents/coordinator.yaml`, add after the `skill-registry` entry in `pinned_skills`:

```yaml
  - approve-action
  - deny-action
  - dismiss-action
  - list-pending-actions
```

- [ ] **Step 2: Add prompt guidance**

In the `system_prompt` section of `agents/coordinator.yaml`, add the following after the `## Data Protection` section (before `## Guidelines`):

```yaml
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

- [ ] **Step 3: Run full test suite to verify nothing broke**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test`
Expected: ALL PASS

- [ ] **Step 4: Run typecheck**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills run typecheck`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add agents/coordinator.yaml
git commit -m "feat(coordinator): pin approval skills and add prompt guidance (#428)"
```

---

### Task 11: Final integration check

- [ ] **Step 1: Run full test suite**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills test`
Expected: ALL PASS — all existing tests plus new ones

- [ ] **Step 2: Run typecheck**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-skills run typecheck`
Expected: No errors

- [ ] **Step 3: Review commit log**

Run: `git -C /Users/josephfung/Projects/worktrees/curia-approval-skills log --oneline feat/approval-skills --not main`

Expected commits (newest first):
1. `feat(coordinator): pin approval skills and add prompt guidance (#428)`
2. `feat(skills): add approve-action skill with re-execution (#428)`
3. `feat(skills): add dismiss-action skill (#428)`
4. `feat(skills): add deny-action skill (#428)`
5. `feat(skills): add list-pending-actions skill (#428)`
6. `feat(skills): add executionLayer and actionLogRepo capabilities; add dismiss decision type (#428)`
7. `fix(autonomy): retry ApprovalTriggerService insert on short_ref collision (#428)`
8. `feat(autonomy): add resolvePending, findAllPending, resolveRow to ActionLogRepo (#428)`
9. `feat(autonomy): add parentActionId to ActionLogInsert and insert() (#428)`
10. `feat(db): add UNIQUE(task_id, short_ref) constraint on autonomy_action_log (#428)`
11. `docs: approval management skills design spec (#428)`
