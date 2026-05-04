# Approval Lifecycle Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement two scheduler jobs — an hourly expiry sweep and a daily pending-actions digest — that close the approval request lifecycle (issue #429).

**Architecture:** Two standalone skills (`approval-expiry-sweep` and `pending-actions-digest`) invoked by the coordinator via declarative YAML schedule entries. Both use `ActionLogRepo` for data access and `OutboundGateway.sendNotification()` for CEO notifications. Two new notification types are added to the event bus union.

**Tech Stack:** TypeScript (ESM), Vitest, Postgres (via `ActionLogRepo`), pino logging

---

### Task 1: Add `findExpired()` to `ActionLogRepo`

**Files:**
- Modify: `src/autonomy/action-log-repo.ts` (after `findAllPending` method, ~line 194)
- Modify: `src/autonomy/action-log-repo.test.ts` (new describe block)

- [ ] **Step 1: Write the failing tests**

Add to `src/autonomy/action-log-repo.test.ts` at the end of the `ActionLogRepo` describe block (before the closing `});`):

```typescript
  describe('findExpired', () => {
    it('returns expired pending_approval rows ordered by created_at asc', async () => {
      const now = new Date();
      const { pool } = makePool([
        {
          id: 5, task_id: 't1', conversation_id: null, skill_name: 'email-send',
          action_risk: 'medium', outcome: 'pending_approval', task_summary: null,
          competence_flag: null, commitment_flag: null, compatibility: null,
          scored_by: null, payload: { to: 'a@b.com' }, notification_sent_at: null,
          resolved_at: null, resolved_by: null, expires_at: new Date(Date.now() - 1000),
          parent_action_id: null, short_ref: 'email-1', description: 'Send email to a@b.com',
          created_at: now,
        },
      ]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const rows = await repo.findExpired();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(5);
      expect(rows[0]!.shortRef).toBe('email-1');
    });

    it('uses correct SQL filter for pending + expired', async () => {
      const { pool, queries } = makePool([]);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      await repo.findExpired();
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.sql).toContain('expires_at <= now()');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle test src/autonomy/action-log-repo.test.ts`

Expected: FAIL — `repo.findExpired is not a function`

- [ ] **Step 3: Implement `findExpired()`**

Add to `src/autonomy/action-log-repo.ts` after the `findAllPending()` method (after line 194):

```typescript
  /**
   * Return all pending_approval rows that have passed their expiry time.
   * These are the inverse of findAllPending() — rows where expires_at <= now().
   * Used by the approval-expiry-sweep skill to transition stale requests.
   */
  async findExpired(): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE outcome = 'pending_approval'
         AND expires_at <= now()
       ORDER BY created_at ASC`,
    );
    return result.rows.map(mapRow);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle test src/autonomy/action-log-repo.test.ts`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "feat(action-log): add findExpired() method for approval expiry sweep"
```

---

### Task 2: Add `expireRows()` to `ActionLogRepo`

**Files:**
- Modify: `src/autonomy/action-log-repo.ts` (after `findExpired` method)
- Modify: `src/autonomy/action-log-repo.test.ts` (new describe block)

- [ ] **Step 1: Write the failing tests**

Add to `src/autonomy/action-log-repo.test.ts` after the `findExpired` describe block:

```typescript
  describe('expireRows', () => {
    it('batch-transitions rows to expired and returns count', async () => {
      const { pool, queries } = makePool([], 3);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const count = await repo.expireRows([1, 2, 3]);
      expect(count).toBe(3);
      expect(queries[0]!.sql).toContain("outcome = 'expired'");
      expect(queries[0]!.sql).toContain("resolved_by = 'system'");
      expect(queries[0]!.sql).toContain('resolved_at = now()');
      expect(queries[0]!.sql).toContain("outcome = 'pending_approval'");
      expect(queries[0]!.params[0]).toEqual([1, 2, 3]);
    });

    it('returns 0 for empty ids array', async () => {
      const { pool, queries } = makePool([], 0);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const count = await repo.expireRows([]);
      expect(count).toBe(0);
      // Should still issue the query (Postgres handles ANY('{}') gracefully)
      expect(queries).toHaveLength(1);
    });

    it('only updates rows still in pending_approval state (idempotency)', async () => {
      // rowCount 0 means no rows matched the WHERE clause
      const { pool } = makePool([], 0);
      const repo = new ActionLogRepo(pool, createSilentLogger());
      const count = await repo.expireRows([42]);
      expect(count).toBe(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle test src/autonomy/action-log-repo.test.ts`

Expected: FAIL — `repo.expireRows is not a function`

- [ ] **Step 3: Implement `expireRows()`**

Add to `src/autonomy/action-log-repo.ts` after the `findExpired()` method:

```typescript
  /**
   * Batch-transition pending_approval rows to expired state.
   * Sets outcome = 'expired', resolved_by = 'system', resolved_at = now().
   * Returns the count of rows actually updated.
   *
   * The WHERE outcome = 'pending_approval' guard ensures idempotency — if a row
   * was concurrently resolved (approved/denied/dismissed), it won't be
   * double-transitioned.
   */
  async expireRows(ids: number[]): Promise<number> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET outcome = 'expired', resolved_by = 'system', resolved_at = now()
       WHERE id = ANY($1) AND outcome = 'pending_approval'`,
      [ids],
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      this.logger.info({ count, ids }, 'action-log-repo: expired rows');
    }
    return count;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle test src/autonomy/action-log-repo.test.ts`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "feat(action-log): add expireRows() method for batch expiry transitions"
```

---

### Task 3: Add new notification types to event bus

**Files:**
- Modify: `src/bus/events.ts` (~line 134, the `notificationType` union)

- [ ] **Step 1: Update the `OutboundNotificationPayload` type**

In `src/bus/events.ts`, find the `notificationType` field on `OutboundNotificationPayload` (line 134) and add two new union members. Change:

```typescript
  notificationType: 'blocked_content' | 'group_held' | 'contact_rate_limited' | 'approval_requested';
```

to:

```typescript
  notificationType: 'blocked_content' | 'group_held' | 'contact_rate_limited' | 'approval_requested' | 'approval_expired' | 'pending_actions_digest';
```

- [ ] **Step 2: Update the comment block above the interface**

In `src/bus/events.ts`, find the comment block above `OutboundNotificationPayload` (lines 123-132) and add two new lines to the notificationType listing. After the `'approval_requested'` line, add:

```typescript
//   - 'approval_expired':      CEO alert that pending approval requests expired without response
//   - 'pending_actions_digest': Daily summary of open approval requests awaiting CEO decision
```

- [ ] **Step 3: Run type check to verify no breakage**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle run typecheck`

If no `typecheck` script exists, run: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle tsc --noEmit`

Expected: No errors (additive change to a union — backwards compatible)

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add src/bus/events.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "feat(events): add approval_expired and pending_actions_digest notification types"
```

---

### Task 4: Create `approval-expiry-sweep` skill — manifest + handler

**Files:**
- Create: `skills/approval-expiry-sweep/skill.json`
- Create: `skills/approval-expiry-sweep/handler.ts`

- [ ] **Step 1: Create the skill manifest**

Create `skills/approval-expiry-sweep/skill.json`:

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

- [ ] **Step 2: Create the handler**

Create `skills/approval-expiry-sweep/handler.ts`:

```typescript
// handler.ts — approval-expiry-sweep skill implementation.
//
// Runs hourly via the coordinator's declarative schedule. Finds all
// pending_approval rows that have passed their expires_at, transitions
// them to 'expired', and sends a single batched notification to the CEO
// for any high/critical tier expirations.
//
// Low/medium tier expirations are silent — at low autonomy scores the
// volume would be noisy.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

/** Risk tiers that warrant a CEO notification on expiry. */
const NOTIFIABLE_TIERS = new Set(['high', 'critical']);

export class ApprovalExpirySweepHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.actionLogRepo) {
      return { success: false, error: 'approval-expiry-sweep requires actionLogRepo capability' };
    }

    try {
      const expired = await ctx.actionLogRepo.findExpired();
      if (expired.length === 0) {
        ctx.log.info('approval-expiry-sweep: no expired rows found');
        return { success: true, data: { expired: 0, notified: 0 } };
      }

      // Batch-transition all expired rows
      const ids = expired.map((row) => row.id);
      const transitioned = await ctx.actionLogRepo.expireRows(ids);

      // Log each expiry at info level
      for (const row of expired) {
        ctx.log.info(
          { id: row.id, shortRef: row.shortRef, skillName: row.skillName, actionRisk: row.actionRisk },
          'approval-expiry-sweep: row expired',
        );
      }

      // Partition by tier — only high/critical get notified
      const notifiable = expired.filter((row) => NOTIFIABLE_TIERS.has(row.actionRisk));

      if (notifiable.length > 0 && ctx.outboundGateway) {
        let ceoEmail: string | undefined;
        try {
          ceoEmail = ctx.secret('CEO_PRIMARY_EMAIL');
        } catch {
          // secret() throws if the env var is not set
        }

        if (ceoEmail) {
          const lines = notifiable.map(
            (row) => `- ${row.shortRef ?? '(no ref)'}: ${row.description ?? row.skillName}`,
          );
          const subject = notifiable.length === 1
            ? `Approval expired — ${notifiable[0]!.description ?? notifiable[0]!.skillName}`
            : `Approval expired — ${notifiable.length} request(s) expired without response`;
          const body =
            'The following approval request(s) expired without a response:\n\n' +
            lines.join('\n') +
            '\n\nThese requests have been automatically closed.';

          const sent = await ctx.outboundGateway.sendNotification({
            notificationType: 'approval_expired',
            ceoEmail,
            subject,
            body,
          });

          if (!sent) {
            // Non-fatal — the rows are already expired. CEO will see them in next digest.
            ctx.log.warn('approval-expiry-sweep: notification send failed — CEO will see expired items in next digest');
          }
        } else {
          ctx.log.warn('approval-expiry-sweep: CEO_PRIMARY_EMAIL not configured — skipping expiry notification');
        }
      }

      return {
        success: true,
        data: { expired: transitioned, notified: notifiable.length },
      };
    } catch (err) {
      ctx.log.error({ err }, 'approval-expiry-sweep: unexpected failure');
      return { success: false, error: 'approval-expiry-sweep failed unexpectedly' };
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add skills/approval-expiry-sweep/skill.json skills/approval-expiry-sweep/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "feat: add approval-expiry-sweep skill — manifest + handler"
```

---

### Task 5: Write tests for `approval-expiry-sweep`

**Files:**
- Create: `skills/approval-expiry-sweep/handler.test.ts`

- [ ] **Step 1: Write the test file**

Create `skills/approval-expiry-sweep/handler.test.ts`:

```typescript
// handler.test.ts — unit tests for approval-expiry-sweep skill.

import { describe, it, expect, vi } from 'vitest';
import { ApprovalExpirySweepHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import { createSilentLogger } from '../../src/logger.js';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    taskId: 't1',
    conversationId: null,
    skillName: 'calendar-create-event',
    actionRisk: 'high',
    outcome: 'pending_approval' as const,
    shortRef: 'cal-1',
    description: 'Create calendar event: Lunch',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() - 3600_000), // expired 1h ago
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
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {},
    secret: (name: string) => {
      if (name === 'CEO_PRIMARY_EMAIL') return 'ceo@example.com';
      throw new Error(`secret '${name}' not configured in test`);
    },
    log: createSilentLogger(),
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    findExpired: vi.fn().mockResolvedValue([]),
    expireRows: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockGateway(sendResult = true): OutboundGateway {
  return {
    sendNotification: vi.fn().mockResolvedValue(sendResult),
  } as unknown as OutboundGateway;
}

describe('ApprovalExpirySweepHandler', () => {
  it('returns error when actionLogRepo is missing', async () => {
    const handler = new ApprovalExpirySweepHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns early with expired: 0 when no expired rows exist', async () => {
    const repo = makeMockRepo();
    const handler = new ApprovalExpirySweepHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo }));
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ expired: 0, notified: 0 });
    expect(repo.expireRows).not.toHaveBeenCalled();
  });

  it('expires rows and sends batched notification for high/critical tiers', async () => {
    const highRow = makeRow({ id: 1, actionRisk: 'high', shortRef: 'cal-1', description: 'Create event' });
    const criticalRow = makeRow({ id: 2, actionRisk: 'critical', shortRef: 'pay-1', description: 'Process payment', skillName: 'process-payment' });
    const repo = makeMockRepo({
      findExpired: vi.fn().mockResolvedValue([highRow, criticalRow]),
      expireRows: vi.fn().mockResolvedValue(2),
    });
    const gateway = makeMockGateway();
    const handler = new ApprovalExpirySweepHandler();

    const result = await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ expired: 2, notified: 2 });
    expect(repo.expireRows).toHaveBeenCalledWith([1, 2]);
    expect(gateway.sendNotification).toHaveBeenCalledOnce();

    const payload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.notificationType).toBe('approval_expired');
    expect(payload.ceoEmail).toBe('ceo@example.com');
    expect(payload.subject).toContain('2 request(s)');
    expect(payload.body).toContain('cal-1');
    expect(payload.body).toContain('pay-1');
  });

  it('expires low/medium rows silently — no notification', async () => {
    const lowRow = makeRow({ id: 3, actionRisk: 'low', shortRef: 'mem-1' });
    const medRow = makeRow({ id: 4, actionRisk: 'medium', shortRef: 'email-1' });
    const repo = makeMockRepo({
      findExpired: vi.fn().mockResolvedValue([lowRow, medRow]),
      expireRows: vi.fn().mockResolvedValue(2),
    });
    const gateway = makeMockGateway();
    const handler = new ApprovalExpirySweepHandler();

    const result = await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ expired: 2, notified: 0 });
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('handles mixed tiers — only high/critical in notification', async () => {
    const lowRow = makeRow({ id: 1, actionRisk: 'low', shortRef: 'mem-1' });
    const highRow = makeRow({ id: 2, actionRisk: 'high', shortRef: 'cal-1', description: 'Create event' });
    const repo = makeMockRepo({
      findExpired: vi.fn().mockResolvedValue([lowRow, highRow]),
      expireRows: vi.fn().mockResolvedValue(2),
    });
    const gateway = makeMockGateway();
    const handler = new ApprovalExpirySweepHandler();

    const result = await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ expired: 2, notified: 1 });
    expect(gateway.sendNotification).toHaveBeenCalledOnce();
    const payload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.body).toContain('cal-1');
    expect(payload.body).not.toContain('mem-1');
  });

  it('still succeeds when notification send fails (non-fatal)', async () => {
    const highRow = makeRow({ id: 1, actionRisk: 'high', shortRef: 'cal-1', description: 'Create event' });
    const repo = makeMockRepo({
      findExpired: vi.fn().mockResolvedValue([highRow]),
      expireRows: vi.fn().mockResolvedValue(1),
    });
    const gateway = makeMockGateway(false); // sendNotification returns false
    const handler = new ApprovalExpirySweepHandler();

    const result = await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    // Expiry still succeeded even though notification failed
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ expired: 1, notified: 1 });
  });

  it('skips notification when CEO_PRIMARY_EMAIL is not configured', async () => {
    const highRow = makeRow({ id: 1, actionRisk: 'high', shortRef: 'cal-1', description: 'Create event' });
    const repo = makeMockRepo({
      findExpired: vi.fn().mockResolvedValue([highRow]),
      expireRows: vi.fn().mockResolvedValue(1),
    });
    const gateway = makeMockGateway();
    const handler = new ApprovalExpirySweepHandler();

    const result = await handler.execute(makeCtx({
      actionLogRepo: repo,
      outboundGateway: gateway,
      secret: () => { throw new Error('not configured'); },
    }));

    expect(result.success).toBe(true);
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('uses singular subject when only one high/critical row expires', async () => {
    const highRow = makeRow({ id: 1, actionRisk: 'high', shortRef: 'cal-1', description: 'Create event: Lunch' });
    const repo = makeMockRepo({
      findExpired: vi.fn().mockResolvedValue([highRow]),
      expireRows: vi.fn().mockResolvedValue(1),
    });
    const gateway = makeMockGateway();
    const handler = new ApprovalExpirySweepHandler();

    await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    const payload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.subject).toBe('Approval expired — Create event: Lunch');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle test skills/approval-expiry-sweep/handler.test.ts`

Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add skills/approval-expiry-sweep/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "test: add tests for approval-expiry-sweep skill"
```

---

### Task 6: Create `pending-actions-digest` skill — manifest + handler

**Files:**
- Create: `skills/pending-actions-digest/skill.json`
- Create: `skills/pending-actions-digest/handler.ts`

- [ ] **Step 1: Create the skill manifest**

Create `skills/pending-actions-digest/skill.json`:

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

- [ ] **Step 2: Create the handler**

Create `skills/pending-actions-digest/handler.ts`:

```typescript
// handler.ts — pending-actions-digest skill implementation.
//
// Runs daily at 8 AM via the coordinator's declarative schedule. Queries
// all non-expired pending_approval rows and sends a single digest email
// to the CEO listing each request with its short_ref, description, skill
// name, and time remaining before expiry.
//
// This is the safety net for notification failures (ADR-018 §3c): even if
// the original notification didn't reach the CEO, the daily digest will.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

/**
 * Format milliseconds remaining as a human-readable string.
 * Examples: "23h remaining", "2h remaining", "<1h remaining"
 */
function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'expiring now';
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return '<1h remaining';
  return `${hours}h remaining`;
}

export class PendingActionsDigestHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.actionLogRepo) {
      return { success: false, error: 'pending-actions-digest requires actionLogRepo capability' };
    }

    try {
      const pending = await ctx.actionLogRepo.findAllPending();
      if (pending.length === 0) {
        ctx.log.info('pending-actions-digest: no pending rows — skipping digest');
        return { success: true, data: { pending: 0, skipped: true } };
      }

      const now = Date.now();
      const lines = pending.map((row) => {
        const remaining = row.expiresAt
          ? formatTimeRemaining(row.expiresAt.getTime() - now)
          : 'no expiry';
        return `- ${row.shortRef ?? '(no ref)'}: ${row.description ?? row.skillName} [${row.skillName}] (${remaining})`;
      });

      if (!ctx.outboundGateway) {
        ctx.log.warn('pending-actions-digest: outboundGateway not available — cannot send digest');
        return { success: true, data: { pending: pending.length, skipped: true } };
      }

      let ceoEmail: string | undefined;
      try {
        ceoEmail = ctx.secret('CEO_PRIMARY_EMAIL');
      } catch {
        // secret() throws if the env var is not set
      }

      if (!ceoEmail) {
        ctx.log.warn('pending-actions-digest: CEO_PRIMARY_EMAIL not configured — skipping digest');
        return { success: true, data: { pending: pending.length, skipped: true } };
      }

      const subject = pending.length === 1
        ? 'Pending approval — 1 request awaiting your decision'
        : `Pending approvals — ${pending.length} request(s) awaiting your decision`;
      const body =
        'The following approval request(s) are waiting for your decision:\n\n' +
        lines.join('\n') +
        '\n\nReply with the short reference code to approve, deny, or dismiss each request.';

      const sent = await ctx.outboundGateway.sendNotification({
        notificationType: 'pending_actions_digest',
        ceoEmail,
        subject,
        body,
      });

      if (!sent) {
        ctx.log.warn('pending-actions-digest: notification send failed');
      }

      ctx.log.info({ count: pending.length }, 'pending-actions-digest: digest sent');
      return { success: true, data: { pending: pending.length, skipped: false } };
    } catch (err) {
      ctx.log.error({ err }, 'pending-actions-digest: unexpected failure');
      return { success: false, error: 'pending-actions-digest failed unexpectedly' };
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add skills/pending-actions-digest/skill.json skills/pending-actions-digest/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "feat: add pending-actions-digest skill — manifest + handler"
```

---

### Task 7: Write tests for `pending-actions-digest`

**Files:**
- Create: `skills/pending-actions-digest/handler.test.ts`

- [ ] **Step 1: Write the test file**

Create `skills/pending-actions-digest/handler.test.ts`:

```typescript
// handler.test.ts — unit tests for pending-actions-digest skill.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PendingActionsDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import { createSilentLogger } from '../../src/logger.js';

// Fix Date.now() for deterministic time-remaining calculations
const FIXED_NOW = new Date('2026-05-04T12:00:00Z').getTime();

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    taskId: 't1',
    conversationId: null,
    skillName: 'calendar-create-event',
    actionRisk: 'high',
    outcome: 'pending_approval' as const,
    shortRef: 'cal-1',
    description: 'Create calendar event: Lunch',
    createdAt: new Date('2026-05-04T08:00:00Z'),
    expiresAt: new Date('2026-05-05T08:00:00Z'), // 20h from FIXED_NOW
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
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {},
    secret: (name: string) => {
      if (name === 'CEO_PRIMARY_EMAIL') return 'ceo@example.com';
      throw new Error(`secret '${name}' not configured in test`);
    },
    log: createSilentLogger(),
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    findAllPending: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockGateway(sendResult = true): OutboundGateway {
  return {
    sendNotification: vi.fn().mockResolvedValue(sendResult),
  } as unknown as OutboundGateway;
}

describe('PendingActionsDigestHandler', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when actionLogRepo is missing', async () => {
    const handler = new PendingActionsDigestHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('skips digest when no pending rows exist', async () => {
    const repo = makeMockRepo();
    const gateway = makeMockGateway();
    const handler = new PendingActionsDigestHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ pending: 0, skipped: true });
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('sends digest with all pending rows', async () => {
    const row1 = makeRow({ id: 1, shortRef: 'cal-1', description: 'Create event: Lunch', skillName: 'calendar-create-event' });
    const row2 = makeRow({ id: 2, shortRef: 'email-1', description: 'Send follow-up email', skillName: 'email-send' });
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([row1, row2]),
    });
    const gateway = makeMockGateway();
    const handler = new PendingActionsDigestHandler();

    const result = await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ pending: 2, skipped: false });
    expect(gateway.sendNotification).toHaveBeenCalledOnce();

    const payload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.notificationType).toBe('pending_actions_digest');
    expect(payload.ceoEmail).toBe('ceo@example.com');
    expect(payload.subject).toContain('2 request(s)');
    expect(payload.body).toContain('cal-1');
    expect(payload.body).toContain('email-1');
    expect(payload.body).toContain('calendar-create-event');
    expect(payload.body).toContain('email-send');
  });

  it('includes correct time remaining in digest body', async () => {
    // expiresAt is 20h from FIXED_NOW
    const row = makeRow({ expiresAt: new Date(FIXED_NOW + 20 * 60 * 60 * 1000) });
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([row]),
    });
    const gateway = makeMockGateway();
    const handler = new PendingActionsDigestHandler();

    await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    const payload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.body).toContain('20h remaining');
  });

  it('shows <1h remaining for rows expiring within the hour', async () => {
    const row = makeRow({ expiresAt: new Date(FIXED_NOW + 30 * 60 * 1000) }); // 30 min
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([row]),
    });
    const gateway = makeMockGateway();
    const handler = new PendingActionsDigestHandler();

    await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    const payload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.body).toContain('<1h remaining');
  });

  it('uses singular subject when only one pending row', async () => {
    const row = makeRow();
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([row]),
    });
    const gateway = makeMockGateway();
    const handler = new PendingActionsDigestHandler();

    await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    const payload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload.subject).toBe('Pending approval — 1 request awaiting your decision');
  });

  it('skips digest when CEO_PRIMARY_EMAIL is not configured', async () => {
    const row = makeRow();
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([row]),
    });
    const gateway = makeMockGateway();
    const handler = new PendingActionsDigestHandler();

    const result = await handler.execute(makeCtx({
      actionLogRepo: repo,
      outboundGateway: gateway,
      secret: () => { throw new Error('not configured'); },
    }));

    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ pending: 1, skipped: true });
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('handles notification send failure gracefully', async () => {
    const row = makeRow();
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([row]),
    });
    const gateway = makeMockGateway(false); // returns false
    const handler = new PendingActionsDigestHandler();

    const result = await handler.execute(makeCtx({ actionLogRepo: repo, outboundGateway: gateway }));

    // Still succeeds — notification failure is non-fatal
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ pending: 1, skipped: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle test skills/pending-actions-digest/handler.test.ts`

Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add skills/pending-actions-digest/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "test: add tests for pending-actions-digest skill"
```

---

### Task 8: Add declarative schedule entries to coordinator YAML

**Files:**
- Modify: `agents/coordinator.yaml` (add `schedule:` block at the end of the file)

- [ ] **Step 1: Add the schedule block**

Append to the end of `agents/coordinator.yaml`:

```yaml
schedule:
  - cron: "0 * * * *"
    task: "Run the approval expiry sweep — find and expire any pending approval requests that have passed their expiry time."
    expectedDurationSeconds: 120
  - cron: "0 8 * * *"
    task: "Run the pending-actions digest — if any approval requests are still awaiting a decision, send a summary to the CEO."
    expectedDurationSeconds: 120
```

- [ ] **Step 2: Verify YAML is valid**

Run: `node -e "const fs = require('fs'); const yaml = require('yaml'); yaml.parse(fs.readFileSync('/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle/agents/coordinator.yaml', 'utf8')); console.log('YAML valid')"`

If `yaml` is not installed, use: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle yaml-cli lint agents/coordinator.yaml` or verify by reading the file and checking structure visually.

Expected: No parse errors

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "feat: add approval expiry sweep and daily digest to coordinator schedule"
```

---

### Task 9: Run full test suite + update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (add entry under `## [Unreleased]`)

- [ ] **Step 1: Run the full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle test`

Expected: ALL PASS. If any tests fail, fix them before proceeding.

- [ ] **Step 2: Run type check**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle run typecheck`

Or: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle tsc --noEmit`

Expected: No errors

- [ ] **Step 3: Update CHANGELOG.md**

Add under `## [Unreleased]` in the **Added** section:

```markdown
### Added

- **Approval expiry sweep** scheduled job — hourly sweep that transitions stale `pending_approval` rows to `expired` and sends a batched CEO notification for high/critical tier expirations (#429)
- **Pending-actions daily digest** scheduled job — morning digest that surfaces all open approval requests to the CEO as a safety net for missed notifications (#429)
- `findExpired()` and `expireRows()` methods on `ActionLogRepo` for approval lifecycle management
- `approval_expired` and `pending_actions_digest` notification types on the event bus
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-approval-lifecycle commit -m "docs: update CHANGELOG for approval lifecycle jobs (#429)"
```
