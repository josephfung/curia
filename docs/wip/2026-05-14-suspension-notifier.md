# SuspensionNotifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a CEO email notification whenever a scheduled job is suspended, bypassing the LLM pipeline so alerts arrive even when Anthropic is the thing that's down.

**Architecture:** A new `SuspensionNotifier` class subscribes to `schedule.suspended` on the system layer and calls `outboundGateway.sendNotification()` directly. The notification routes through the existing `outbound.notification` → EmailAdapter → Nylas path — no LLM, no autonomy gate. The notifier is registered at startup in `index.ts` alongside other bus subscribers.

**Tech Stack:** TypeScript (ESM), Vitest, existing `EventBus`, `OutboundGateway`, and `OutboundNotificationPayload` types.

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier`

---

## File map

| File | Action | Role |
|---|---|---|
| `src/bus/events.ts` | Modify | Add `'schedule_suspended'` to `OutboundNotificationPayload.notificationType` |
| `src/scheduler/suspension-notifier.ts` | Create | `SuspensionNotifier` class — the sole new component |
| `src/index.ts` | Modify | Instantiate and register `SuspensionNotifier` at startup |
| `tests/unit/scheduler/suspension-notifier.test.ts` | Create | Unit tests (written before the implementation — TDD) |
| `CHANGELOG.md` | Modify | Add entry under `[Unreleased]` |

---

## Task 1: Extend the notification type union

**Files:**
- Modify: `src/bus/events.ts`

- [ ] **Step 1.1: Add `'schedule_suspended'` to `OutboundNotificationPayload.notificationType`**

Open `src/bus/events.ts`. Find `OutboundNotificationPayload` (around line 138). The `notificationType` field currently ends with `'pending_actions_digest'`. Add `'schedule_suspended'` as the last variant and update the inline comment:

```typescript
export interface OutboundNotificationPayload {
  notificationType:
    | 'blocked_content'
    | 'group_held'
    | 'contact_rate_limited'
    | 'approval_requested'
    | 'approval_expired'        // batched expiry notification (approval-expiry-sweep)
    | 'pending_actions_digest'  // daily pending-actions summary (pending-actions-digest)
    | 'schedule_suspended';     // scheduled job auto-suspended after consecutive failures (#538)
  /** Recipient email for this notification (always the CEO email today). */
  ceoEmail: string;
  subject: string;
  body: string;
  /** Present for blocked_content notifications — links back to the outbound.blocked event. */
  blockId?: string;
  /** Channel of the original blocked or held message (e.g. 'email', 'signal'). */
  originalChannel?: string;
  /** Intended recipient of the original blocked or held message. */
  originalRecipientId?: string;
}
```

- [ ] **Step 1.2: Verify TypeScript compiles**

```bash
npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 1.3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier add src/bus/events.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier commit -m "feat: add schedule_suspended notification type (#538)"
```

---

## Task 2: Write failing tests for SuspensionNotifier

**Files:**
- Create: `tests/unit/scheduler/suspension-notifier.test.ts`

- [ ] **Step 2.1: Create the test file**

Create `tests/unit/scheduler/suspension-notifier.test.ts` with the following content:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SuspensionNotifier } from '../../../src/scheduler/suspension-notifier.js';
import type { ScheduleSuspendedEvent } from '../../../src/bus/events.js';

// -- Mock helpers --

function mockBus() {
  return {
    subscribe: vi.fn(),
    publish: vi.fn(),
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function mockOutboundGateway() {
  return {
    sendNotification: vi.fn(),
  };
}

function makeEvent(overrides: Partial<ScheduleSuspendedEvent['payload']> = {}): ScheduleSuspendedEvent {
  return {
    id: 'evt-1',
    timestamp: new Date(),
    type: 'schedule.suspended',
    sourceLayer: 'system',
    payload: {
      jobId: 'job-abc123',
      agentId: 'ceo-inbox',
      lastError: '400 — credit balance is too low to access the Anthropic API',
      consecutiveFailures: 3,
      ...overrides,
    },
  };
}

describe('SuspensionNotifier', () => {
  let bus: ReturnType<typeof mockBus>;
  let gateway: ReturnType<typeof mockOutboundGateway>;
  let logger: ReturnType<typeof mockLogger>;
  let notifier: SuspensionNotifier;

  beforeEach(() => {
    bus = mockBus();
    gateway = mockOutboundGateway();
    logger = mockLogger();
    notifier = new SuspensionNotifier({
      bus: bus as never,
      outboundGateway: gateway as never,
      ceoEmail: 'ceo@example.com',
      logger: logger as never,
    });
  });

  it('registers on schedule.suspended at the system layer', () => {
    notifier.register();
    expect(bus.subscribe).toHaveBeenCalledWith(
      'schedule.suspended',
      'system',
      expect.any(Function),
    );
  });

  it('sends a notification with correct fields when a job is suspended', async () => {
    gateway.sendNotification.mockResolvedValue(true);

    // Call handle() directly so the test is synchronous and deterministic.
    // The public register() path (fire-and-forget void) is covered by the test above.
    await (notifier as never as { handle(e: ScheduleSuspendedEvent): Promise<void> })
      .handle(makeEvent());

    expect(gateway.sendNotification).toHaveBeenCalledOnce();
    const call = gateway.sendNotification.mock.calls[0][0];
    expect(call.notificationType).toBe('schedule_suspended');
    expect(call.ceoEmail).toBe('ceo@example.com');
    expect(call.subject).toContain('ceo-inbox');
    expect(call.body).toContain('ceo-inbox');       // agentId
    expect(call.body).toContain('3');               // consecutiveFailures
    expect(call.body).toContain('400 — credit balance is too low to access the Anthropic API'); // lastError
    expect(call.body).toContain('job-abc123');      // jobId
    expect(call.body).toContain('web app');         // resume instructions
  });

  it('logs an error and resolves when sendNotification returns false', async () => {
    gateway.sendNotification.mockResolvedValue(false);

    await expect(
      (notifier as never as { handle(e: ScheduleSuspendedEvent): Promise<void> })
        .handle(makeEvent()),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2.2: Run tests and confirm they fail with "module not found"**

```bash
npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier vitest run tests/unit/scheduler/suspension-notifier.test.ts 2>&1 | tail -20
```

Expected: error along the lines of `Cannot find module '../../../src/scheduler/suspension-notifier.js'`.

- [ ] **Step 2.3: Commit the tests**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier add tests/unit/scheduler/suspension-notifier.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier commit -m "test: failing tests for SuspensionNotifier (#538)"
```

---

## Task 3: Implement SuspensionNotifier

**Files:**
- Create: `src/scheduler/suspension-notifier.ts`

- [ ] **Step 3.1: Create the implementation**

Create `src/scheduler/suspension-notifier.ts`:

```typescript
// src/scheduler/suspension-notifier.ts
//
// SuspensionNotifier — system-layer bus subscriber that emails the CEO whenever
// a scheduled job is auto-suspended after 3 consecutive failures.
//
// Design constraint: this path MUST NOT touch the LLM pipeline. The most
// common trigger for a suspension is the Anthropic API being down, so any
// notification path that calls the LLM would fail in exactly that scenario.
// Instead we call outboundGateway.sendNotification() directly, which routes
// through the outbound.notification → EmailAdapter → Nylas path.

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { ScheduleSuspendedEvent, BusEvent } from '../bus/events.js';

export interface SuspensionNotifierConfig {
  bus: EventBus;
  outboundGateway: OutboundGateway;
  ceoEmail: string;
  logger: Logger;
}

export class SuspensionNotifier {
  private readonly log: Logger;

  constructor(private readonly config: SuspensionNotifierConfig) {
    this.log = config.logger.child({ component: 'suspension-notifier' });
  }

  /**
   * Subscribe to schedule.suspended on the system layer.
   * Call once at startup, after the bus and outbound gateway are ready.
   */
  register(): void {
    this.config.bus.subscribe('schedule.suspended', 'system', (event: BusEvent) => {
      // Fire-and-forget — the bus subscriber must be synchronous; async work is
      // handled internally. The outer .catch() is a backstop for unexpected throws
      // not covered by handle()'s own error handling.
      void this.handle(event as ScheduleSuspendedEvent).catch((err: unknown) => {
        this.log.error({ err }, 'SuspensionNotifier: unexpected error in handler');
      });
    });
    this.log.info('SuspensionNotifier registered');
  }

  private async handle(event: ScheduleSuspendedEvent): Promise<void> {
    const { jobId, agentId, lastError, consecutiveFailures } = event.payload;

    const subject = `Scheduled job suspended: ${agentId}`;
    const body = [
      'Scheduled job suspended.',
      '',
      `Agent:    ${agentId}`,
      `Failures: ${consecutiveFailures}`,
      `Error:    ${lastError}`,
      '',
      `Job ID: ${jobId}`,
      '',
      'To resume this job, open the web app and navigate to Scheduler → Jobs.',
    ].join('\n');

    // sendNotification() catches its own errors and returns false on failure —
    // it does not throw. We log at error if it returns false so the anomaly is
    // visible in alerting.
    const sent = await this.config.outboundGateway.sendNotification({
      notificationType: 'schedule_suspended',
      ceoEmail: this.config.ceoEmail,
      subject,
      body,
    });

    if (!sent) {
      this.log.error(
        { jobId, agentId },
        'SuspensionNotifier: failed to publish notification — suspension already recorded in audit log',
      );
    }
  }
}
```

- [ ] **Step 3.2: Run the tests and confirm they pass**

```bash
npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier vitest run tests/unit/scheduler/suspension-notifier.test.ts 2>&1 | tail -20
```

Expected: all 3 tests pass.

- [ ] **Step 3.3: Run the full unit test suite to confirm no regressions**

```bash
npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier vitest run tests/unit 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 3.4: Commit the implementation**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier add src/scheduler/suspension-notifier.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier commit -m "feat: SuspensionNotifier — email CEO when scheduled job suspends (#538)"
```

---

## Task 4: Wire SuspensionNotifier into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 4.1: Add the import**

Open `src/index.ts`. Find the existing scheduler imports (around line 72):

```typescript
import { SchedulerService } from './scheduler/scheduler-service.js';
import { Scheduler } from './scheduler/scheduler.js';
import { DriftDetector } from './scheduler/drift-detector.js';
```

Add `SuspensionNotifier` on the line after:

```typescript
import { SchedulerService } from './scheduler/scheduler-service.js';
import { Scheduler } from './scheduler/scheduler.js';
import { DriftDetector } from './scheduler/drift-detector.js';
import { SuspensionNotifier } from './scheduler/suspension-notifier.js';
```

- [ ] **Step 4.2: Register the notifier at startup**

In `src/index.ts`, find the block where `scheduler` is constructed (around line 965):

```typescript
const scheduler = new Scheduler({ pool, bus, logger, schedulerService, driftDetector, dreamEngine });
```

Immediately after that line, add the SuspensionNotifier wiring:

```typescript
const scheduler = new Scheduler({ pool, bus, logger, schedulerService, driftDetector, dreamEngine });

// SuspensionNotifier — emails the CEO when a scheduled job is auto-suspended.
// Bypasses the LLM pipeline: notifies even when Anthropic is the thing that's down.
// Skipped (with a warning) if outboundGateway or ceoPrimaryEmail is absent.
if (outboundGateway && config.ceoPrimaryEmail) {
  const suspensionNotifier = new SuspensionNotifier({
    bus,
    outboundGateway,
    ceoEmail: config.ceoPrimaryEmail,
    logger,
  });
  suspensionNotifier.register();
} else {
  logger.warn(
    { hasGateway: !!outboundGateway, hasCeoEmail: !!config.ceoPrimaryEmail },
    'SuspensionNotifier not registered — outboundGateway or ceoPrimaryEmail absent; suspended jobs will not trigger CEO email alerts',
  );
}
```

- [ ] **Step 4.3: Verify TypeScript compiles**

```bash
npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4.4: Run the full unit test suite**

```bash
npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier vitest run tests/unit 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 4.5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier commit -m "feat: wire SuspensionNotifier at startup (#538)"
```

---

## Task 5: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 5.1: Add entry under `[Unreleased]`**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add to the **Added** section:

```markdown
### Added
- **`SuspensionNotifier`** — emails the CEO when a scheduled job is auto-suspended after 3 consecutive failures, bypassing the LLM pipeline so alerts arrive even when Anthropic is down. (#538)
```

- [ ] **Step 5.2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-suspension-notifier commit -m "chore: changelog for SuspensionNotifier (#538)"
```

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Add `'schedule_suspended'` to `notificationType` | Task 1 |
| `SuspensionNotifier` subscribes to `schedule.suspended` on `system` layer | Task 3, Task 2 (test) |
| Notification sends correct fields (agentId, error, jobId, resume instructions) | Task 3, Task 2 (test) |
| LLM-free notification path | Task 3 (design — calls gateway, not coordinator) |
| Delivery failure logged, does not block suspension | Task 3 (returns boolean check), Task 2 (test) |
| Conditional startup wiring with warning when unconfigured | Task 4 |
| Unit tests | Task 2 + Task 3 |
| CHANGELOG | Task 5 |

**Placeholder scan:** No TBD, no "implement later", no "add error handling" — all code is complete.

**Type consistency:** `SuspensionNotifierConfig` defined once in Task 3 and used as-is in Task 4. `ScheduleSuspendedEvent` imported from `../bus/events.js` consistently. `sendNotification` signature matches `OutboundGateway.sendNotification(payload: OutboundNotificationPayload, parentEventId?: string): Promise<boolean>` confirmed from source.
