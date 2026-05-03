# Gate-level Approval Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the autonomy gate blocks a skill, write a `pending_approval` row, notify the CEO, and return an enriched advisory. Add `humanApproved` to `InvokeOptions` so approved skills can bypass the gate.

**Architecture:** A new `ApprovalTriggerService` owns the approval request flow (dedup, insert, short_ref generation, description, notification). The execution layer calls it from Gate A/B block paths. `humanApproved` on `InvokeOptions` skips autonomy gates for re-execution. All notification goes through the existing `outboundGateway.sendNotification()`.

**Tech Stack:** TypeScript (ESM), Vitest, Postgres (via `ActionLogRepo`), existing `OutboundGateway`, `EventBus`, `OutboundNotificationPayload` from `src/bus/events.ts`

---

## File Map

**Created:**
- `src/autonomy/approval-trigger.ts` — ApprovalTriggerService (dedup, insert, short_ref, description, notification)
- `src/autonomy/approval-trigger.test.ts` — unit tests for ApprovalTriggerService

**Modified:**
- `src/bus/events.ts:132-133` — add `'approval_requested'` to `OutboundNotificationPayload.notificationType` union
- `src/autonomy/action-log-repo.ts` — add `findPendingByTaskAndSkill`, `countShortRefsForTask`, `setNotificationSentAt`
- `src/autonomy/action-log-repo.test.ts` — tests for new repo methods
- `src/skills/execution.ts:46-55` — add `humanApproved` to `InvokeOptions`
- `src/skills/execution.ts:249-323` — modify gate A/B to call approval trigger and enrich error messages
- `src/skills/execution.ts:57-119` — add `approvalTrigger` to constructor
- `src/skills/execution.test.ts` — extend with `humanApproved` and approval trigger tests
- `src/index.ts:826,849` — construct `ApprovalTriggerService`, pass to `ExecutionLayer`

---

## Task 1: Add `'approval_requested'` to notification type union

**Files:**
- Modify: `src/bus/events.ts:132-133`

- [ ] **Step 1: Update the type**

In `src/bus/events.ts`, find the `OutboundNotificationPayload` interface (line 132) and add `'approval_requested'` to the `notificationType` union. Also update the comment block above it (lines 128-131).

```typescript
// notificationType discriminates between alert categories:
//   - 'blocked_content': CEO alert that an outbound message was blocked by the content filter
//   - 'group_held':      CEO alert that a Signal group message was held due to unverified members
//   - 'contact_rate_limited': CEO alert that contact auto-creation was throttled due to rate limits
//   - 'approval_requested':   CEO alert that Curia wants to take an action that requires approval
export interface OutboundNotificationPayload {
  notificationType: 'blocked_content' | 'group_held' | 'contact_rate_limited' | 'approval_requested';
```

- [ ] **Step 2: Verify the project compiles**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger run build 2>&1 | tail -5`
Expected: Clean compilation (no type errors from existing code — this type is only consumed, never switched exhaustively).

- [ ] **Step 3: Commit**

```
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger add src/bus/events.ts
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger commit -m "feat(autonomy): add 'approval_requested' to OutboundNotificationPayload type union"
```

---

## Task 2: ActionLogRepo — add new query methods

**Files:**
- Modify: `src/autonomy/action-log-repo.ts`
- Modify: `src/autonomy/action-log-repo.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these test blocks at the end of the `describe('ActionLogRepo', ...)` block in `src/autonomy/action-log-repo.test.ts`:

```typescript
describe('findPendingByTaskAndSkill', () => {
  it('returns the matching pending row when one exists', async () => {
    const now = new Date();
    const { pool } = makePool([
      {
        id: 10, task_id: 't1', conversation_id: null, skill_name: 'calendar-create-event',
        action_risk: 'high', outcome: 'pending_approval', task_summary: null,
        competence_flag: null, commitment_flag: null, compatibility: null,
        scored_by: null, payload: { title: 'Lunch' }, notification_sent_at: null,
        resolved_at: null, resolved_by: null, expires_at: null,
        parent_action_id: null, short_ref: 'cal-1', description: 'Create calendar event: Lunch',
        created_at: now,
      },
    ]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const row = await repo.findPendingByTaskAndSkill('t1', 'calendar-create-event', { title: 'Lunch' });
    expect(row).not.toBeNull();
    expect(row!.id).toBe(10);
    expect(row!.shortRef).toBe('cal-1');
  });

  it('returns null when no matching row exists', async () => {
    const { pool } = makePool([]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const row = await repo.findPendingByTaskAndSkill('t1', 'calendar-create-event', { title: 'Lunch' });
    expect(row).toBeNull();
  });

  it('uses JSONB equality for payload comparison', async () => {
    const { pool, queries } = makePool([]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    await repo.findPendingByTaskAndSkill('t1', 'send-email', { to: 'a@b.com', subject: 'Hi' });
    expect(queries[0]!.sql).toContain('payload::jsonb = $3::jsonb');
    expect(queries[0]!.params[2]).toBe(JSON.stringify({ to: 'a@b.com', subject: 'Hi' }));
  });
});

describe('countShortRefsForTask', () => {
  it('returns the count of short_ref rows for a task', async () => {
    const { pool } = makePool([{ count: '3' }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const count = await repo.countShortRefsForTask('t1');
    expect(count).toBe(3);
  });

  it('returns 0 when no short_ref rows exist', async () => {
    const { pool } = makePool([{ count: '0' }]);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    const count = await repo.countShortRefsForTask('t1');
    expect(count).toBe(0);
  });
});

describe('setNotificationSentAt', () => {
  it('updates the notification_sent_at column', async () => {
    const { pool, queries } = makePool([], 1);
    const repo = new ActionLogRepo(pool, createSilentLogger());
    await repo.setNotificationSentAt(42);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('UPDATE autonomy_action_log');
    expect(queries[0]!.sql).toContain('notification_sent_at');
    expect(queries[0]!.params).toContain(42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test -- src/autonomy/action-log-repo.test.ts 2>&1 | tail -20`
Expected: FAIL — `findPendingByTaskAndSkill`, `countShortRefsForTask`, `setNotificationSentAt` are not defined.

- [ ] **Step 3: Implement the three methods**

Add these methods to the `ActionLogRepo` class in `src/autonomy/action-log-repo.ts`, before the closing `}` of the class (before line 125):

```typescript
  /**
   * Find a pending_approval row for the given task + skill + payload.
   * Used by ApprovalTriggerService for deduplication — same skill with
   * same input in the same task should not generate a duplicate request.
   * Uses JSONB equality for key-order-independent payload comparison.
   */
  async findPendingByTaskAndSkill(
    taskId: string,
    skillName: string,
    payload: Record<string, unknown>,
  ): Promise<ActionLogRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE task_id = $1
         AND skill_name = $2
         AND outcome = 'pending_approval'
         AND payload::jsonb = $3::jsonb
       LIMIT 1`,
      [taskId, skillName, JSON.stringify(payload)],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Count rows with a non-null short_ref for this task.
   * Used by ApprovalTriggerService to generate sequential short_ref
   * counters (e.g. cal-1, email-2).
   */
  async countShortRefsForTask(taskId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM autonomy_action_log
       WHERE task_id = $1
         AND short_ref IS NOT NULL`,
      [taskId],
    );
    return parseInt(result.rows[0]!.count, 10);
  }

  /**
   * Mark that the CEO notification was successfully delivered.
   * Called after a successful sendNotification(). If notification fails,
   * this is never called — notification_sent_at stays null.
   */
  async setNotificationSentAt(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE autonomy_action_log
       SET notification_sent_at = now()
       WHERE id = $1`,
      [id],
    );
    this.logger.debug({ id }, 'action-log-repo: notification_sent_at updated');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test -- src/autonomy/action-log-repo.test.ts 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger add src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger commit -m "feat(autonomy): add dedup, counter, and notification queries to ActionLogRepo"
```

---

## Task 3: ApprovalTriggerService — short_ref and description pure functions

**Files:**
- Create: `src/autonomy/approval-trigger.ts`
- Create: `src/autonomy/approval-trigger.test.ts`

This task creates the file with the pure helper functions only. The `request()` method comes in Task 4.

- [ ] **Step 1: Write the failing tests for pure functions**

Create `src/autonomy/approval-trigger.test.ts`:

```typescript
// approval-trigger.test.ts — unit tests for ApprovalTriggerService.
//
// Tests are structured in two groups:
//   1. Pure functions (shortRefPrefix, buildDescription) — no mocks needed
//   2. request() method (Task 4) — mocks ActionLogRepo and OutboundGateway

import { describe, it, expect } from 'vitest';
import { shortRefPrefix, buildDescription } from './approval-trigger.js';

describe('shortRefPrefix', () => {
  it('maps calendar-* skills to "cal"', () => {
    expect(shortRefPrefix('calendar-create-event')).toBe('cal');
    expect(shortRefPrefix('calendar-update-event')).toBe('cal');
  });

  it('maps email-* skills to "email"', () => {
    expect(shortRefPrefix('email-reply')).toBe('email');
    expect(shortRefPrefix('email-draft-save')).toBe('email');
  });

  it('maps signal-* skills to "signal"', () => {
    expect(shortRefPrefix('signal-send')).toBe('signal');
  });

  it('maps store-fact to "mem"', () => {
    expect(shortRefPrefix('store-fact')).toBe('mem');
  });

  it('maps *-memory-* skills to "mem"', () => {
    expect(shortRefPrefix('entity-memory-store')).toBe('mem');
  });

  it('maps *-contact* skills to "contact"', () => {
    expect(shortRefPrefix('update-contact')).toBe('contact');
    expect(shortRefPrefix('contact-merge')).toBe('contact');
  });

  it('maps schedule-* skills to "sched"', () => {
    expect(shortRefPrefix('schedule-job')).toBe('sched');
  });

  it('falls back to first word of skill name, truncated to 6 chars', () => {
    expect(shortRefPrefix('something-unusual')).toBe('someth');
    expect(shortRefPrefix('web-search')).toBe('web');
  });
});

describe('buildDescription', () => {
  it('formats calendar-create-event with title', () => {
    const desc = buildDescription('calendar-create-event', { title: 'Lunch with Dana', start: '2026-05-06T12:00:00-04:00' });
    expect(desc).toContain('Create calendar event');
    expect(desc).toContain('Lunch with Dana');
  });

  it('formats email-reply with to and subject', () => {
    const desc = buildDescription('email-reply', { to: 'dana@example.com', subject: 'Re: Budget' });
    expect(desc).toContain('Send email reply');
    expect(desc).toContain('dana@example.com');
    expect(desc).toContain('Re: Budget');
  });

  it('formats store-fact with label', () => {
    const desc = buildDescription('store-fact', { label: 'Dana prefers mornings' });
    expect(desc).toContain('Store fact');
    expect(desc).toContain('Dana prefers mornings');
  });

  it('falls back to "Run {skill_name}" for unknown skills', () => {
    const desc = buildDescription('some-unknown-skill', {});
    expect(desc).toBe('Run some-unknown-skill');
  });

  it('truncates individual values to 80 chars', () => {
    const longTitle = 'A'.repeat(100);
    const desc = buildDescription('calendar-create-event', { title: longTitle });
    // The value portion should be truncated, not the full description
    expect(desc.length).toBeLessThanOrEqual(200);
    expect(desc).not.toContain(longTitle);
  });

  it('truncates the full description to 200 chars', () => {
    const desc = buildDescription('email-reply', {
      to: 'very-long-email-address-that-goes-on-forever@example.com',
      subject: 'Re: A very long subject line that keeps going and going and going',
      body: 'This body is also very long and should not appear in the description',
    });
    expect(desc.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Create the module with pure functions**

Create `src/autonomy/approval-trigger.ts`:

```typescript
// approval-trigger.ts — ApprovalTriggerService.
//
// Owns the approval request flow when the autonomy gate blocks a skill:
// dedup check, row insertion, short_ref generation, description building,
// and CEO notification. See ADR-018 and issue #427.

import type { ActionLogRepo } from './action-log-repo.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalRequestResult =
  | { created: true; shortRef: string; notificationSent: boolean }
  | { created: false; reason: 'duplicate'; existingShortRef: string };

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

/** Skill name prefix mapping for short_ref generation. */
const PREFIX_RULES: Array<{ test: (name: string) => boolean; prefix: string }> = [
  { test: (n) => n.startsWith('calendar-'), prefix: 'cal' },
  { test: (n) => n.startsWith('email-'), prefix: 'email' },
  { test: (n) => n.startsWith('signal-'), prefix: 'signal' },
  { test: (n) => n === 'store-fact' || n.includes('-memory-'), prefix: 'mem' },
  { test: (n) => n.includes('contact'), prefix: 'contact' },
  { test: (n) => n.startsWith('schedule-'), prefix: 'sched' },
];

/** Return a short prefix for a skill name (e.g. "cal", "email"). */
export function shortRefPrefix(skillName: string): string {
  for (const rule of PREFIX_RULES) {
    if (rule.test(skillName)) return rule.prefix;
  }
  // Fallback: first word (before first hyphen), truncated to 6 chars
  const firstWord = skillName.split('-')[0] ?? skillName;
  return firstWord.slice(0, 6);
}

const MAX_VALUE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;

/** Truncate a string to maxLen, appending "…" if truncated. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

/** Verb + label mapping for known skill name patterns. */
const VERB_RULES: Array<{ test: (name: string) => boolean; verb: string }> = [
  { test: (n) => n === 'calendar-create-event', verb: 'Create calendar event' },
  { test: (n) => n === 'calendar-update-event', verb: 'Update calendar event' },
  { test: (n) => n === 'calendar-delete-event', verb: 'Delete calendar event' },
  { test: (n) => n === 'email-reply', verb: 'Send email reply' },
  { test: (n) => n === 'email-draft-save', verb: 'Save email draft' },
  { test: (n) => n === 'store-fact', verb: 'Store fact' },
  { test: (n) => n.startsWith('signal-'), verb: 'Send Signal message' },
  { test: (n) => n.startsWith('schedule-'), verb: 'Schedule job' },
];

/**
 * Build a human-readable one-liner from skill name and input fields.
 * Used in CEO notifications, the pending-actions digest, and the
 * coordinator's advisory failure message.
 */
export function buildDescription(
  skillName: string,
  input: Record<string, unknown>,
): string {
  // Determine verb
  let verb = '';
  for (const rule of VERB_RULES) {
    if (rule.test(skillName)) { verb = rule.verb; break; }
  }
  if (!verb) return `Run ${skillName}`;

  // Pick context fields in priority order
  const contextParts: string[] = [];
  const fieldPriority = ['title', 'subject', 'to', 'label', 'name', 'query'];
  for (const field of fieldPriority) {
    const val = input[field];
    if (typeof val === 'string' && val.trim()) {
      contextParts.push(truncate(val.trim(), MAX_VALUE_LENGTH));
    }
  }

  if (contextParts.length === 0) return `Run ${skillName}`;

  const context = contextParts.join(', ');
  const full = `${verb}: ${context}`;
  return truncate(full, MAX_DESCRIPTION_LENGTH);
}

// ---------------------------------------------------------------------------
// Service class — request() added in Task 4
// ---------------------------------------------------------------------------

export class ApprovalTriggerService {
  constructor(
    private readonly actionLogRepo: ActionLogRepo,
    private readonly outboundGateway: OutboundGateway,
    private readonly logger: Logger,
    private readonly ceoEmail?: string,
  ) {}

  // request() is implemented in Task 4
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test -- src/autonomy/approval-trigger.test.ts 2>&1 | tail -20`
Expected: All pure function tests PASS. (The service class has no methods yet to test.)

- [ ] **Step 4: Commit**

```
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger add src/autonomy/approval-trigger.ts src/autonomy/approval-trigger.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger commit -m "feat(autonomy): add short_ref prefix and description builder for approval trigger"
```

---

## Task 4: ApprovalTriggerService — `request()` method

**Files:**
- Modify: `src/autonomy/approval-trigger.ts`
- Modify: `src/autonomy/approval-trigger.test.ts`

- [ ] **Step 1: Write the failing tests for `request()`**

Add this `describe` block at the end of `src/autonomy/approval-trigger.test.ts`:

```typescript
import { vi } from 'vitest';
import { ApprovalTriggerService } from './approval-trigger.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import { createSilentLogger } from '../logger.js';

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    findPendingByTaskAndSkill: vi.fn().mockResolvedValue(null),
    countShortRefsForTask: vi.fn().mockResolvedValue(0),
    insert: vi.fn().mockResolvedValue(1),
    setNotificationSentAt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockGateway(overrides?: Partial<OutboundGateway>): OutboundGateway {
  return {
    sendNotification: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OutboundGateway;
}

const BASE_OPTS = {
  taskId: 'task-1',
  conversationId: 'conv-1',
  skillName: 'calendar-create-event',
  actionRisk: 'high',
  input: { title: 'Lunch with Dana' },
  currentScore: 65,
  requiredScore: 80,
};

describe('ApprovalTriggerService.request()', () => {
  it('creates row, generates short_ref, sends notification, returns created: true', async () => {
    const repo = makeMockRepo();
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-1',
      notificationSent: true,
    });
    expect(repo.insert).toHaveBeenCalledOnce();
    expect(repo.setNotificationSentAt).toHaveBeenCalledWith(1);
    expect(gateway.sendNotification).toHaveBeenCalledOnce();
    // Verify notification payload
    const notifPayload = (gateway.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(notifPayload.notificationType).toBe('approval_requested');
    expect(notifPayload.ceoEmail).toBe('ceo@example.com');
    expect(notifPayload.subject).toContain('Approval needed');
  });

  it('returns duplicate when matching pending row exists', async () => {
    const repo = makeMockRepo({
      findPendingByTaskAndSkill: vi.fn().mockResolvedValue({ shortRef: 'cal-1' }),
    });
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: false,
      reason: 'duplicate',
      existingShortRef: 'cal-1',
    });
    expect(repo.insert).not.toHaveBeenCalled();
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('allows different payloads for same skill in same task', async () => {
    const repo = makeMockRepo({
      // First call: no match (different payload). Second call: count returns 1.
      findPendingByTaskAndSkill: vi.fn().mockResolvedValue(null),
      countShortRefsForTask: vi.fn().mockResolvedValue(1),
    });
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request({
      ...BASE_OPTS,
      input: { title: 'Dinner with Bob' },
    });

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-2',  // counter is 1, so next is 2
      notificationSent: true,
    });
  });

  it('handles notification failure gracefully', async () => {
    const repo = makeMockRepo();
    const gateway = makeMockGateway({
      sendNotification: vi.fn().mockRejectedValue(new Error('SMTP down')),
    });
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-1',
      notificationSent: false,
    });
    // Row was still inserted
    expect(repo.insert).toHaveBeenCalledOnce();
    // setNotificationSentAt was NOT called (notification failed)
    expect(repo.setNotificationSentAt).not.toHaveBeenCalled();
  });

  it('skips notification when ceoEmail is not configured', async () => {
    const repo = makeMockRepo();
    const gateway = makeMockGateway();
    // No ceoEmail
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger());

    const result = await service.request(BASE_OPTS);

    expect(result).toEqual({
      created: true,
      shortRef: 'cal-1',
      notificationSent: false,
    });
    expect(repo.insert).toHaveBeenCalledOnce();
    expect(gateway.sendNotification).not.toHaveBeenCalled();
  });

  it('inserts row with correct fields', async () => {
    const repo = makeMockRepo();
    const gateway = makeMockGateway();
    const service = new ApprovalTriggerService(repo, gateway, createSilentLogger(), 'ceo@example.com');

    await service.request(BASE_OPTS);

    const insertCall = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(insertCall.taskId).toBe('task-1');
    expect(insertCall.conversationId).toBe('conv-1');
    expect(insertCall.skillName).toBe('calendar-create-event');
    expect(insertCall.actionRisk).toBe('high');
    expect(insertCall.outcome).toBe('pending_approval');
    expect(insertCall.payload).toEqual({ title: 'Lunch with Dana' });
    expect(insertCall.shortRef).toBe('cal-1');
    expect(insertCall.description).toContain('Create calendar event');
    expect(insertCall.expiresAt).toBeInstanceOf(Date);
    // Expires roughly 24h from now (within 5s tolerance)
    const diffMs = insertCall.expiresAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(86_400_000 - 5000);
    expect(diffMs).toBeLessThan(86_400_000 + 5000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test -- src/autonomy/approval-trigger.test.ts 2>&1 | tail -20`
Expected: FAIL — `request` is not a function (method not yet implemented).

- [ ] **Step 3: Implement `request()` method**

Replace the placeholder comment in `ApprovalTriggerService` in `src/autonomy/approval-trigger.ts`:

```typescript
export class ApprovalTriggerService {
  constructor(
    private readonly actionLogRepo: ActionLogRepo,
    private readonly outboundGateway: OutboundGateway,
    private readonly logger: Logger,
    private readonly ceoEmail?: string,
  ) {}

  /**
   * Trigger an approval request when an autonomy gate blocks a skill.
   *
   * Steps:
   *   1. Dedup — check for existing pending_approval row with same skill + payload in same task
   *   2. Generate short_ref and description
   *   3. Insert autonomy_action_log row
   *   4. Notify CEO (best-effort — failure does not prevent row creation)
   *
   * Returns the result so the execution layer can enrich the advisory error message.
   */
  async request(opts: {
    taskId: string;
    conversationId?: string;
    skillName: string;
    actionRisk: string;
    input: Record<string, unknown>;
    currentScore: number;
    requiredScore: number;
  }): Promise<ApprovalRequestResult> {
    const { taskId, conversationId, skillName, actionRisk, input, currentScore, requiredScore } = opts;

    // Step 1: Dedup check
    const existing = await this.actionLogRepo.findPendingByTaskAndSkill(taskId, skillName, input);
    if (existing) {
      this.logger.info(
        { taskId, skillName, existingShortRef: existing.shortRef },
        'approval-trigger: duplicate request — pending_approval row already exists',
      );
      return { created: false, reason: 'duplicate', existingShortRef: existing.shortRef ?? 'unknown' };
    }

    // Step 2: Generate short_ref and description
    const counter = await this.actionLogRepo.countShortRefsForTask(taskId);
    const shortRef = `${shortRefPrefix(skillName)}-${counter + 1}`;
    const description = buildDescription(skillName, input);

    // Step 3: Insert row
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h from now
    const rowId = await this.actionLogRepo.insert({
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

    this.logger.info(
      { rowId, taskId, skillName, shortRef, currentScore, requiredScore },
      'approval-trigger: pending_approval row created',
    );

    // Step 4: Notify CEO (best-effort)
    let notificationSent = false;
    if (this.ceoEmail) {
      try {
        await this.outboundGateway.sendNotification({
          notificationType: 'approval_requested',
          ceoEmail: this.ceoEmail,
          subject: `Approval needed — ${description}`,
          body:
            `Curia wanted to ${description.charAt(0).toLowerCase() + description.slice(1)}, ` +
            `but the autonomy score (${currentScore}) is below the required threshold (${requiredScore}).\n\n` +
            `Reference: ${shortRef}\n` +
            `Expires: ${expiresAt.toISOString()}\n\n` +
            `Reply to approve, deny, or dismiss this request.`,
        });
        await this.actionLogRepo.setNotificationSentAt(rowId);
        notificationSent = true;
        this.logger.info({ rowId, shortRef }, 'approval-trigger: CEO notification sent');
      } catch (err) {
        this.logger.warn(
          { err, rowId, shortRef },
          'approval-trigger: CEO notification failed — row exists, CEO will see it in digest',
        );
      }
    } else {
      this.logger.warn(
        { rowId, shortRef },
        'approval-trigger: ceoEmail not configured — skipping notification',
      );
    }

    return { created: true, shortRef, notificationSent };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test -- src/autonomy/approval-trigger.test.ts 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger add src/autonomy/approval-trigger.ts src/autonomy/approval-trigger.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger commit -m "feat(autonomy): implement ApprovalTriggerService.request() with dedup and notification"
```

---

## Task 5: ExecutionLayer — `humanApproved` bypass + approval trigger integration

**Files:**
- Modify: `src/skills/execution.ts`
- Modify: `src/skills/execution.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these test blocks at the end of `src/skills/execution.test.ts`, after the existing `describe('autonomy gates', ...)` block:

```typescript
import type { ApprovalTriggerService, ApprovalRequestResult } from '../autonomy/approval-trigger.js';

/** Build a stub ApprovalTriggerService that returns a fixed result. */
function makeApprovalTrigger(result: ApprovalRequestResult): ApprovalTriggerService {
  return {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as ApprovalTriggerService;
}

describe('humanApproved on InvokeOptions', () => {
  it('skips autonomy gates when humanApproved is true', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('approved result');
    registry.register(makeRiskyManifest('calendar-create-event', 'high'), handler); // requires 80

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65), // well below 80
    });

    const result = await layer.invoke('calendar-create-event', {}, undefined, {
      humanApproved: true,
    });

    expect(result.success).toBe(true);
    expect(handler.execute).toHaveBeenCalledOnce();
  });

  it('still enforces elevated-skill gate when humanApproved is true', async () => {
    const registry = new SkillRegistry();
    const handler = makeHandler('should not run');
    const manifest: SkillManifest = {
      ...makeRiskyManifest('approve-action', 'high'),
      sensitivity: 'elevated',
    };
    registry.register(manifest, handler);

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
    });

    // humanApproved but no caller context — elevated gate should block
    const result = await layer.invoke('approve-action', {}, undefined, {
      humanApproved: true,
    });

    expect(result.success).toBe(false);
    expect(handler.execute).not.toHaveBeenCalled();
  });
});

describe('approval trigger on gate block', () => {
  it('Gate B calls trigger and enriches error with shortRef', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'email-1', notificationSent: true });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('send-email', { to: 'a@b.com' }, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('email-1');
      expect(result.error).toContain('approval request has been sent');
    }
    expect(trigger.request).toHaveBeenCalledOnce();
  });

  it('Gate A calls trigger and enriches error with shortRef', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('store-fact', 'low'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'fact-1', notificationSent: true });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(55), // triggers Gate A (< 60)
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('store-fact', { label: 'test' }, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('fact-1');
      expect(result.error).toContain('approval request has been sent');
    }
    expect(trigger.request).toHaveBeenCalledOnce();
  });

  it('returns duplicate message when trigger finds existing pending row', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: false, reason: 'duplicate', existingShortRef: 'email-1' });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('send-email', { to: 'a@b.com' }, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already pending');
      expect(result.error).toContain('email-1');
    }
  });

  it('includes notification failure note when notificationSent is false', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'email-1', notificationSent: false });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    const result = await layer.invoke('send-email', {}, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('notification could not be delivered');
    }
  });

  it('falls back to existing error when trigger is not wired', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      // No approvalTrigger
    });

    const result = await layer.invoke('send-email', {}, undefined, {
      taskEventId: 'task-1',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Original message — no approval ref
      expect(result.error).toContain('set-autonomy');
      expect(result.error).not.toContain('approval request');
    }
  });

  it('falls back to existing error when taskEventId is missing', async () => {
    const registry = new SkillRegistry();
    registry.register(makeRiskyManifest('send-email', 'medium'), makeHandler('no'));

    const trigger = makeApprovalTrigger({ created: true, shortRef: 'email-1', notificationSent: true });
    const mockBus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;

    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: makeAutonomyService(65),
      bus: mockBus,
      approvalTrigger: trigger,
    });

    // No taskEventId in options
    const result = await layer.invoke('send-email', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('set-autonomy');
    }
    expect(trigger.request).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test -- src/skills/execution.test.ts 2>&1 | tail -30`
Expected: FAIL — `humanApproved` not on `InvokeOptions`, `approvalTrigger` not a constructor option.

- [ ] **Step 3: Add `humanApproved` to `InvokeOptions`**

In `src/skills/execution.ts`, update the `InvokeOptions` interface (line 46-55):

```typescript
/** Options passed to ExecutionLayer.invoke() by the agent runtime. */
export interface InvokeOptions {
  taskEventId?: string;
  agentId?: string;
  conversationId?: string;
  parentEventId?: string;
  /** Task-level metadata forwarded from the agent.task event payload.
   *  Used by skill handlers to inspect task-wide signals (e.g. observationMode). */
  taskMetadata?: Record<string, unknown>;
  /** When true, autonomy gates (A and B) are skipped — the skill runs as if the
   *  score were sufficient. Only the approve-action skill (#428) should set this.
   *  All other checks (elevated-skill gate, content filter, blocked-contact) still run.
   *  See ADR-018. */
  humanApproved?: boolean;
}
```

- [ ] **Step 4: Add `approvalTrigger` to the constructor**

In `src/skills/execution.ts`, add the field and constructor option.

Add the import at the top of the file (after the existing autonomy imports around line 37):

```typescript
import type { ApprovalTriggerService } from '../autonomy/approval-trigger.js';
```

Add the private field after `private bullpenService` (around line 73):

```typescript
  private approvalTrigger?: ApprovalTriggerService;
```

Add the constructor option to the options type (after `bullpenService` in the options object, around line 95):

```typescript
    approvalTrigger?: ApprovalTriggerService;
```

Add the assignment in the constructor body (after `this.bullpenService`, around line 115):

```typescript
    this.approvalTrigger = options?.approvalTrigger;
```

- [ ] **Step 5: Add `humanApproved` gate bypass and approval trigger calls**

In `src/skills/execution.ts`, modify the autonomy gate block (lines 242-323).

Replace the outer guard condition on line 249:

```typescript
    if (this.autonomyService && manifest.sensitivity !== 'elevated' && !options?.humanApproved) {
```

Add the `humanApproved` info log right before the autonomy gate block (before line 242):

```typescript
    // humanApproved bypass — log every occurrence for operator traceability.
    // Gate logic below is skipped entirely; all other checks still run.
    if (options?.humanApproved) {
      skillLogger.info(
        { skillName, agentId: options.agentId },
        'autonomy gates skipped — humanApproved flag set (CEO-authorized re-execution, see ADR-018)',
      );
    }
```

Then extract the gate block return logic into a helper. Replace the Gate A return block (lines 281-288) with:

```typescript
          const gateAError = await this.buildGateError(
            skillName, input, currentScore, 60, manifest.action_risk, options, skillLogger,
          );
          return {
            success: false,
            error: this.wrapSkillError(gateAError),
          };
```

And replace the Gate B return block (lines 310-317) with:

```typescript
          const gateBError = await this.buildGateError(
            skillName, input, currentScore, requiredScore, manifest.action_risk, options, skillLogger,
          );
          return {
            success: false,
            error: this.wrapSkillError(gateBError),
          };
```

- [ ] **Step 6: Add the `buildGateError` private method**

Add this method to the `ExecutionLayer` class, after the `setAgentContactId` method (after line 149):

```typescript
  /**
   * Build the advisory error message for a gate block, optionally triggering
   * an approval request via ApprovalTriggerService.
   *
   * When the trigger is wired and taskEventId is available, creates a
   * pending_approval row and enriches the error with the approval status.
   * Otherwise, returns the existing error message unchanged (fail-open).
   */
  private async buildGateError(
    skillName: string,
    input: Record<string, unknown>,
    currentScore: number,
    requiredScore: number,
    actionRisk: string | number,
    options: InvokeOptions | undefined,
    skillLogger: Logger,
  ): Promise<string> {
    const baseMsg =
      `Skill '${skillName}' blocked — autonomy score is ${currentScore}, ` +
      `but this skill (action_risk: ${String(actionRisk)}) requires ${requiredScore}. `;

    // Approval trigger — only if wired and task context is available.
    if (this.approvalTrigger && options?.taskEventId) {
      try {
        const result = await this.approvalTrigger.request({
          taskId: options.taskEventId,
          conversationId: options.conversationId,
          skillName,
          actionRisk: String(actionRisk),
          input,
          currentScore,
          requiredScore,
        });
        if (!result.created) {
          return (
            `Skill '${skillName}' blocked — an approval request for this action ` +
            `is already pending (ref: ${result.existingShortRef}).`
          );
        }
        if (result.notificationSent) {
          return baseMsg + `An approval request has been sent to the CEO (ref: ${result.shortRef}).`;
        }
        return (
          baseMsg +
          `An approval request was created (ref: ${result.shortRef}) but ` +
          `notification could not be delivered — the CEO will see it in the next digest.`
        );
      } catch (err) {
        // Approval trigger failure should not change the gate behavior.
        // The skill is still blocked; we just can't create the approval row.
        skillLogger.warn(
          { err, skillName },
          'approval trigger failed — returning standard gate error',
        );
      }
    }

    // Fallback: no trigger, no taskEventId, or trigger failed
    return baseMsg + `The CEO can raise the score with the set-autonomy skill.`;
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test -- src/skills/execution.test.ts 2>&1 | tail -30`
Expected: All tests PASS (both existing and new).

- [ ] **Step 8: Run the full test suite**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test 2>&1 | tail -30`
Expected: No regressions.

- [ ] **Step 9: Commit**

```
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger add src/skills/execution.ts src/skills/execution.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger commit -m "feat(autonomy): humanApproved bypass + approval trigger on gate block (#427)"
```

---

## Task 6: Wire ApprovalTriggerService in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import**

Add this import near the other autonomy imports (around line 75-76 of `src/index.ts`):

```typescript
import { ApprovalTriggerService } from './autonomy/approval-trigger.js';
```

- [ ] **Step 2: Construct ApprovalTriggerService**

After the `actionLogRepo` construction (line 826) and before the `executionLayer` construction (line 849), add:

```typescript
  // Approval trigger — creates pending_approval rows and notifies CEO
  // when autonomy gates block a skill. See ADR-018 and issue #427.
  const approvalTrigger = outboundGateway
    ? new ApprovalTriggerService(actionLogRepo, outboundGateway, logger, config.ceoPrimaryEmail || undefined)
    : undefined;
```

- [ ] **Step 3: Pass to ExecutionLayer**

On line 849, add `approvalTrigger` to the constructor options object. Find the existing `ExecutionLayer` construction and add the new option:

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService, entityMemory, agentPersona, nylasCalendarClient, entityContextAssembler, agentContactId: agentIdentityContactId, autonomyService, executiveProfileService, browserService, bullpenService, approvalTrigger, timezone: config.timezone, skillOutputMaxLength: yamlConfig.skillOutput?.maxLength });
```

- [ ] **Step 4: Verify compilation**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger run build 2>&1 | tail -10`
Expected: Clean compilation.

- [ ] **Step 5: Run full test suite**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test 2>&1 | tail -30`
Expected: All tests pass, no regressions.

- [ ] **Step 6: Commit**

```
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger add src/index.ts
git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger commit -m "feat(autonomy): wire ApprovalTriggerService into ExecutionLayer (#427)"
```

---

## Task 7: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite one more time**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger test 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 2: Run build**

Run: `npm --prefix /Users/josephfung/Projects/worktrees/curia-approval-trigger run build 2>&1 | tail -10`
Expected: Clean compilation.

- [ ] **Step 3: Verify git log looks clean**

Run: `git -C /Users/josephfung/Projects/worktrees/curia-approval-trigger log --oneline feat/approval-trigger --not main`
Expected: 7 commits (docs + 6 implementation commits), all on `feat/approval-trigger`.
