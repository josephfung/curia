# Gateway Draft-Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift autonomy draft-fallback from email adapter to OutboundGateway, unify draft tracking for autonomy-gated and observation-mode drafts.

**Architecture:** Two-step gated pattern — gateway gates sends and writes action_log, adapter creates draft and links it back. Observation-mode skills write action_log directly. send-draft transitions rows on approval. All tracked drafts appear in pending-actions-digest.

**Tech Stack:** TypeScript ESM, Vitest, PostgreSQL (JSONB), Nylas API

---

## File Map

| File | Responsibility | Action |
|------|---------------|--------|
| `src/bus/events.ts` | Event type definitions | Modify: add `taskEventId` to OutboundMessagePayload |
| `src/config.ts` | Shared config types | Modify: remove `autonomy_gated` from OutboundPolicy |
| `src/skills/outbound-gateway.ts` | Outbound safety pipeline | Modify: gated result, linkGatedAction(), derive threshold |
| `src/autonomy/action-log-repo.ts` | Action log persistence | Modify: add `linkPayload()` method |
| `src/channels/email/email-adapter.ts` | Email channel transport | Modify: remove autonomy logic, add gated-fallback |
| `src/dispatch/dispatcher.ts` | Message routing | Modify: stamp taskEventId on outbound.message |
| `skills/send-draft/handler.ts` | CEO draft approval | Modify: transition action_log on send |
| `skills/email-draft-save/handler.ts` | Observation-mode drafts | Modify: write action_log on draft creation |
| `skills/pending-actions-digest/handler.ts` | Daily pending summary | Modify: shortRef at end of line |
| `tests/unit/skills/outbound-gateway.test.ts` | Gateway unit tests | Modify: add gated-result tests |
| `tests/unit/channels/email/email-adapter.test.ts` | Adapter unit tests | Modify: add gated-fallback tests |
| `skills/send-draft/handler.test.ts` | send-draft tests | Modify: add action_log transition tests |
| `skills/email-draft-save/handler.test.ts` | Draft-save tests | Modify: add action_log tests |
| `skills/pending-actions-digest/handler.test.ts` | Digest tests | Modify: update format assertion |
| `tests/integration/draft-fallback-flow.test.ts` | Integration test | Create: full flow test |

---

### Task 1: Type and Interface Changes

**Files:**
- Modify: `src/skills/outbound-gateway.ts:89-94`
- Modify: `src/bus/events.ts:76-94`
- Modify: `src/config.ts:10-18`
- Modify: `src/channels/email/email-adapter.ts:20-76`

- [ ] **Step 1: Extend OutboundSendResult with gated fields**

In `src/skills/outbound-gateway.ts`, update the interface:

```typescript
export interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  /** Human-readable reason when success is false */
  blockedReason?: string;
  /** True when the autonomy gate blocked this send */
  gated?: boolean;
  /** Short reference for the action_log row (e.g. 'email-1'). Present when gated is true. */
  actionRef?: string;
}
```

- [ ] **Step 2: Add taskEventId to OutboundMessagePayload**

In `src/bus/events.ts`, add the field to `OutboundMessagePayload` (after `recipientId`):

```typescript
interface OutboundMessagePayload {
  conversationId: string;
  channelId: string;
  accountId?: string;
  content: string;
  recipientId?: string;
  /** The agent.task event ID that originated this outbound message.
   *  Stamped by the dispatcher for traceability and action_log context. */
  taskEventId?: string;
}
```

- [ ] **Step 3: Remove `autonomy_gated` from OutboundPolicy**

In `src/config.ts`, update the type:

```typescript
/**
 * Outbound send policy for a named email account.
 *
 * - direct:      send via OutboundGateway (autonomy gate applied at gateway level)
 * - draft_gate:  create a Nylas draft silently; CEO discovers pending drafts via the
 *                end-of-day Signal digest and reviews in Gmail (#403, #278)
 */
export type OutboundPolicy = 'direct' | 'draft_gate';
```

- [ ] **Step 4: Remove autonomy fields from EmailAdapterConfig**

In `src/channels/email/email-adapter.ts`, remove `autonomyThreshold` and `autonomyService` from the interface:

```typescript
export interface EmailAdapterConfig {
  accountId: string;
  outboundPolicy: OutboundPolicy;
  // REMOVED: autonomyThreshold?: number;
  // REMOVED: autonomyService?: AutonomyService;
  bus: EventBus;
  logger: Logger;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  pollingIntervalMs: number;
  selfEmail: string;
  observationMode: boolean;
  excludedSenderEmails: string[];
  ceoEmail?: string;
  contactCreationMaxPerMessage: number;
  contactCreationMaxPerHour: number;
}
```

Also remove the `AutonomyService` import at the top of the file.

- [ ] **Step 5: Add send() context options**

In `src/skills/outbound-gateway.ts`, extend the options parameter type on `send()`:

```typescript
async send(
  request: OutboundSendRequest,
  options?: {
    skipNotificationOnBlock?: boolean;
    humanApproved?: boolean;
    /** Task event ID for action_log traceability. Provided by the email adapter from
     *  the outbound.message event payload. */
    taskEventId?: string;
    /** Conversation ID for action_log context. */
    conversationId?: string;
  },
): Promise<OutboundSendResult> {
```

- [ ] **Step 6: Commit**

```bash
git add src/skills/outbound-gateway.ts src/bus/events.ts src/config.ts src/channels/email/email-adapter.ts
git commit -m "feat(#435): extend types for gated draft-fallback pattern"
```

---

### Task 2: ActionLogRepo.linkPayload()

**Files:**
- Modify: `src/autonomy/action-log-repo.ts`
- Modify: `src/autonomy/action-log-repo.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/autonomy/action-log-repo.test.ts`, add to the existing describe block:

```typescript
describe('linkPayload', () => {
  it('merges additional payload into existing row by short_ref', async () => {
    const { pool, queries } = makePool([{ id: 1, payload: { source: 'autonomy_gate' } }]);
    const repo = new ActionLogRepo(pool);

    const result = await repo.linkPayload('email-1', { draftId: 'draft-abc', accountId: 'curia' });

    expect(result).toBe(true);
    expect(queries[0].sql).toContain('UPDATE');
    expect(queries[0].sql).toContain('short_ref');
    expect(queries[0].sql).toContain('jsonb');
    expect(queries[0].params).toContain('email-1');
  });

  it('returns false when no row matches the short_ref', async () => {
    const { pool } = makePool([]);  // empty result
    const repo = new ActionLogRepo(pool);

    const result = await repo.linkPayload('unknown-ref', { draftId: 'draft-xyz' });

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree run test -- src/autonomy/action-log-repo.test.ts --run`
Expected: FAIL — `linkPayload is not a function`

- [ ] **Step 3: Implement linkPayload()**

In `src/autonomy/action-log-repo.ts`, add the method:

```typescript
/**
 * Merge additional payload fields into an existing action_log row identified
 * by short_ref. Used by the gateway's two-step draft-fallback pattern: the
 * initial row is created on gate (with source/context), then the adapter
 * links the draft ID after creating the draft.
 *
 * Returns true if a row was updated, false if no matching pending row exists.
 */
async linkPayload(shortRef: string, additionalPayload: Record<string, unknown>): Promise<boolean> {
  const result = await this.pool.query(
    `UPDATE autonomy_action_log
     SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
     WHERE short_ref = $1
       AND outcome = 'pending_approval'`,
    [shortRef, JSON.stringify(additionalPayload)],
  );
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix /path/to/worktree run test -- src/autonomy/action-log-repo.test.ts --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/autonomy/action-log-repo.ts src/autonomy/action-log-repo.test.ts
git commit -m "feat(#435): add ActionLogRepo.linkPayload() for two-step draft pattern"
```

---

### Task 3: Gateway Infrastructure — Wire actionLogRepo and Derive Threshold

**Files:**
- Modify: `src/skills/outbound-gateway.ts:130-225`
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write failing test for threshold derivation**

In `tests/unit/skills/outbound-gateway.test.ts`, find the autonomy gate describe block and add:

```typescript
it('uses AutonomyService.minScoreForActionRisk(medium) as threshold, not hardcoded 70', async () => {
  // Score 69 should be blocked (minScoreForActionRisk('medium') = 70)
  const gateway = makeGateway({ autonomyService: makeAutonomyService(69) });
  const result = await gateway.send(makeEmailRequest());
  expect(result.success).toBe(false);
  expect(result.gated).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/outbound-gateway.test.ts --run -t "minScoreForActionRisk"`
Expected: FAIL — `result.gated` is undefined (current code doesn't set it)

- [ ] **Step 3: Add actionLogRepo to OutboundGatewayConfig**

In `src/skills/outbound-gateway.ts`, add to the config interface (around line 155):

```typescript
/**
 * Action log repository — used to write pending_approval rows when the
 * autonomy gate blocks a send and the channel falls back to draft creation.
 * Optional — when absent, gated sends still return { gated: true } but no
 * action_log row is written.
 */
actionLogRepo?: ActionLogRepo;
```

Add import at the top:
```typescript
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
```

In the constructor, store it:
```typescript
this.actionLogRepo = config.actionLogRepo;
```

And add as a class field:
```typescript
private actionLogRepo?: ActionLogRepo;
```

- [ ] **Step 4: Replace hardcoded 70 with derived threshold**

In `send()` (line 267), replace:
```typescript
if (autonomyConfig !== null && autonomyConfig.score < 70) {
```
with:
```typescript
const sendThreshold = AutonomyService.minScoreForActionRisk('medium');
if (autonomyConfig !== null && autonomyConfig.score < sendThreshold) {
```

Similarly in `sendEmailDraft()` (line 832), apply the same change.

Update the log messages to reference `sendThreshold` instead of the literal `70`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/outbound-gateway.test.ts --run`
Expected: Existing tests still pass (threshold is still 70 via the service). The new test still fails because `gated` isn't returned yet — that's Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat(#435): wire actionLogRepo into gateway, derive threshold from AutonomyService"
```

---

### Task 4: Gateway Gated Result + Action Log Write

**Files:**
- Modify: `src/skills/outbound-gateway.ts` (send() method, lines 264-288)
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write failing tests for gated result and action_log write**

In `tests/unit/skills/outbound-gateway.test.ts`:

```typescript
describe('gated draft-fallback (two-step pattern)', () => {
  it('returns { gated: true, actionRef } when score < threshold', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gateway = makeGateway({
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const result = await gateway.send(
      makeEmailRequest({ to: 'kevin@example.com', subject: 'Hello' }),
      { taskEventId: 'task-001', conversationId: 'email:thread-abc' },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(result.actionRef).toMatch(/^email-/);
  });

  it('writes action_log row with pending_approval on gate', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gateway = makeGateway({
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    await gateway.send(
      makeEmailRequest({ to: 'kevin@example.com', subject: 'Hello' }),
      { taskEventId: 'task-001', conversationId: 'email:thread-abc' },
    );

    expect(actionLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-001',
        conversationId: 'email:thread-abc',
        outcome: 'pending_approval',
        skillName: 'outbound-send',
        shortRef: expect.stringMatching(/^email-/),
        payload: expect.objectContaining({ source: 'autonomy_gate' }),
      }),
    );
  });

  it('action_log row includes recipient and subject in payload', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gateway = makeGateway({
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    await gateway.send(
      makeEmailRequest({ to: 'kevin@example.com', subject: 'Quarterly review' }),
      { taskEventId: 'task-001', conversationId: 'email:thread-abc' },
    );

    expect(actionLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          source: 'autonomy_gate',
          recipientEmail: 'kevin@example.com',
          subject: 'Quarterly review',
        }),
      }),
    );
  });

  it('skips action_log write when actionLogRepo is not wired', async () => {
    const gateway = makeGateway({
      autonomyService: makeAutonomyService(65),
      // no actionLogRepo
    });

    const result = await gateway.send(
      makeEmailRequest(),
      { taskEventId: 'task-001', conversationId: 'conv-1' },
    );

    expect(result.gated).toBe(true);
    // No crash — graceful when repo absent
  });

  it('skips action_log write when taskEventId is missing', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gateway = makeGateway({
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const result = await gateway.send(makeEmailRequest());
    // No taskEventId in options — cannot write meaningful row

    expect(result.gated).toBe(true);
    expect(actionLogRepo.insert).not.toHaveBeenCalled();
  });
});
```

Add this helper to the test file:
```typescript
function makeActionLogRepo() {
  return {
    insert: vi.fn().mockResolvedValue(1),
    linkPayload: vi.fn().mockResolvedValue(true),
    countShortRefsForTask: vi.fn().mockResolvedValue(0),
  } as unknown as ActionLogRepo;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/outbound-gateway.test.ts --run -t "gated draft-fallback"`
Expected: FAIL — `result.gated` is undefined

- [ ] **Step 3: Implement gated result + action_log write in send()**

In `src/skills/outbound-gateway.ts`, replace the autonomy gate block (lines 264-288) with:

```typescript
} else if (this.autonomyService) {
  try {
    const autonomyConfig = await this.autonomyService.getConfig();
    const sendThreshold = AutonomyService.minScoreForActionRisk('medium');
    if (autonomyConfig !== null && autonomyConfig.score < sendThreshold) {
      this.log.info(
        { channel: request.channel, currentScore: autonomyConfig.score, sendThreshold },
        'outbound-gateway: send blocked by autonomy gate — score below threshold',
      );
      this.bus.publish('dispatch', createAutonomySendBlocked({
        channel: request.channel,
        currentScore: autonomyConfig.score,
        requiredScore: sendThreshold,
        parentEventId: options?.taskEventId ?? 'unknown',
      }));

      // Write action_log row if we have enough context
      let actionRef: string | undefined;
      if (this.actionLogRepo && options?.taskEventId) {
        const counter = await this.actionLogRepo.countShortRefsForTask(options.taskEventId);
        actionRef = `email-${counter + 1}`;
        const recipientEmail = request.channel === 'email' ? request.to : undefined;
        const subject = request.channel === 'email' ? request.subject : undefined;
        const description = recipientEmail
          ? `Draft reply to ${recipientEmail}${subject ? ` — "${subject}"` : ''}. Use send-draft to approve.`
          : 'Outbound message gated by autonomy. Use send-draft to approve.';

        await this.actionLogRepo.insert({
          taskId: options.taskEventId,
          conversationId: options.conversationId ?? null,
          skillName: 'outbound-send',
          actionRisk: 'medium',
          outcome: 'pending_approval',
          shortRef: actionRef,
          description,
          payload: {
            source: 'autonomy_gate',
            recipientEmail,
            subject,
            channel: request.channel,
          },
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h expiry
        });
      }

      return {
        success: false,
        gated: true,
        actionRef,
        blockedReason: `Autonomy score ${autonomyConfig.score} is below send threshold ${sendThreshold}`,
      };
    }
  } catch (err) {
    this.log.warn(
      { err, channel: request.channel },
      'outbound-gateway: autonomy gate failed to read config — proceeding without gate (fail-open)',
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/outbound-gateway.test.ts --run`
Expected: All new and existing tests pass

- [ ] **Step 5: Commit**

```bash
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat(#435): gateway writes action_log and returns gated result on autonomy block"
```

---

### Task 5: Gateway linkGatedAction()

**Files:**
- Modify: `src/skills/outbound-gateway.ts`
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('linkGatedAction', () => {
  it('delegates to actionLogRepo.linkPayload with the actionRef and payload', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gateway = makeGateway({ actionLogRepo });

    await gateway.linkGatedAction('email-1', { draftId: 'draft-abc', accountId: 'curia' });

    expect(actionLogRepo.linkPayload).toHaveBeenCalledWith('email-1', {
      draftId: 'draft-abc',
      accountId: 'curia',
    });
  });

  it('is a no-op when actionLogRepo is not wired', async () => {
    const gateway = makeGateway({}); // no actionLogRepo

    // Should not throw
    await gateway.linkGatedAction('email-1', { draftId: 'draft-abc' });
  });

  it('logs warn and does not throw when linkPayload returns false (unknown ref)', async () => {
    const actionLogRepo = makeActionLogRepo();
    actionLogRepo.linkPayload = vi.fn().mockResolvedValue(false);
    const gateway = makeGateway({ actionLogRepo });

    await gateway.linkGatedAction('unknown-ref', { draftId: 'draft-abc' });

    // Should not throw, just log
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/outbound-gateway.test.ts --run -t "linkGatedAction"`
Expected: FAIL — `gateway.linkGatedAction is not a function`

- [ ] **Step 3: Implement linkGatedAction()**

In `src/skills/outbound-gateway.ts`, add the method to the class:

```typescript
/**
 * Link a draft (or other fallback result) to a gated action_log row.
 * Called by channel adapters after they create their fallback artifact
 * in response to a gated send() result.
 *
 * No-op when actionLogRepo is not wired or the actionRef doesn't match
 * a pending row (graceful — the row may have expired or been cleaned up).
 */
async linkGatedAction(actionRef: string, payload: Record<string, unknown>): Promise<void> {
  if (!this.actionLogRepo) return;
  const updated = await this.actionLogRepo.linkPayload(actionRef, payload);
  if (!updated) {
    this.log.warn(
      { actionRef },
      'outbound-gateway: linkGatedAction found no pending row for actionRef — may have expired',
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/skills/outbound-gateway.test.ts --run -t "linkGatedAction"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat(#435): add gateway.linkGatedAction() for two-step draft-fallback"
```

---

### Task 6: Thread taskEventId Through Dispatcher → Email Adapter

**Files:**
- Modify: `src/dispatch/dispatcher.ts:888-897`
- Modify: `src/channels/email/email-adapter.ts` (outbound subscriber + sendOutboundReply)

- [ ] **Step 1: Stamp taskEventId in dispatcher**

In `src/dispatch/dispatcher.ts`, at line 888, add `taskEventId` to the `createOutboundMessage` call. The agent.response event's `parentEventId` is the agent.task event's ID:

```typescript
const outbound = createOutboundMessage({
  conversationId: routing.conversationId,
  channelId: routing.channelId,
  accountId: routing.accountId,
  content: event.payload.content,
  recipientId: routing.senderId,
  taskEventId: event.parentEventId ?? undefined,  // agent.task event ID
  parentEventId: event.id,
});
```

- [ ] **Step 2: Pass context from email adapter to gateway.send()**

In `src/channels/email/email-adapter.ts`, modify `sendOutboundReply()` to accept and pass task context. The outbound event has `payload.taskEventId` and `payload.conversationId`:

Update `sendOutboundReply` to extract and thread the context:

```typescript
private async sendOutboundReply(outbound: OutboundMessageEvent): Promise<void> {
  const { conversationId, content, taskEventId } = outbound.payload;
  // ... existing logic to resolve threadId, recipient, etc. ...

  await this.dispatchByPolicy(sendRequest, {
    taskEventId,
    conversationId,
  });
}
```

Update `dispatchByPolicy` signature to accept context:

```typescript
private async dispatchByPolicy(
  sendRequest: EmailSendRequest,
  context: { taskEventId?: string; conversationId?: string },
): Promise<void> {
```

And pass context to `gateway.send()`:

```typescript
const result = await this.config.outboundGateway.send(sendRequest, {
  taskEventId: context.taskEventId,
  conversationId: context.conversationId,
});
```

- [ ] **Step 3: Commit**

```bash
git add src/dispatch/dispatcher.ts src/channels/email/email-adapter.ts
git commit -m "feat(#435): thread taskEventId from dispatcher through adapter to gateway"
```

---

### Task 7: Email Adapter Simplification — Remove Autonomy, Add Gated Fallback

**Files:**
- Modify: `src/channels/email/email-adapter.ts` (dispatchByPolicy, lines 429-514)
- Modify: `tests/unit/channels/email/email-adapter.test.ts`

- [ ] **Step 1: Write failing tests for new adapter behavior**

In `tests/unit/channels/email/email-adapter.test.ts`:

```typescript
describe('dispatchByPolicy gated-fallback', () => {
  it('calls gateway.send() for direct policy', async () => {
    const gateway = {
      send: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }),
      createEmailDraft: vi.fn(),
      linkGatedAction: vi.fn(),
    };
    const adapter = makeAdapter({ outboundPolicy: 'direct', outboundGateway: gateway });
    const handler = captureHandler('outbound.message', adapter);

    await handler(makeOutboundEvent({ taskEventId: 'task-1', conversationId: 'conv-1' }));

    expect(gateway.send).toHaveBeenCalled();
    expect(gateway.createEmailDraft).not.toHaveBeenCalled();
  });

  it('creates draft and links action when gateway returns gated', async () => {
    const gateway = {
      send: vi.fn().mockResolvedValue({ success: false, gated: true, actionRef: 'email-1' }),
      createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-abc' }),
      linkGatedAction: vi.fn(),
    };
    const adapter = makeAdapter({ outboundPolicy: 'direct', outboundGateway: gateway });
    const handler = captureHandler('outbound.message', adapter);

    await handler(makeOutboundEvent({ taskEventId: 'task-1', conversationId: 'conv-1' }));

    expect(gateway.createEmailDraft).toHaveBeenCalled();
    expect(gateway.linkGatedAction).toHaveBeenCalledWith('email-1', expect.objectContaining({
      draftId: 'draft-abc',
    }));
  });

  it('draft_gate policy calls createEmailDraft directly without send()', async () => {
    const gateway = {
      send: vi.fn(),
      createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-xyz' }),
      linkGatedAction: vi.fn(),
    };
    const adapter = makeAdapter({ outboundPolicy: 'draft_gate', outboundGateway: gateway });
    const handler = captureHandler('outbound.message', adapter);

    await handler(makeOutboundEvent({}));

    expect(gateway.send).not.toHaveBeenCalled();
    expect(gateway.createEmailDraft).toHaveBeenCalled();
    expect(gateway.linkGatedAction).not.toHaveBeenCalled();
  });

  it('draft_gate does NOT write action_log', async () => {
    const gateway = {
      send: vi.fn(),
      createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-xyz' }),
      linkGatedAction: vi.fn(),
    };
    const adapter = makeAdapter({ outboundPolicy: 'draft_gate', outboundGateway: gateway });
    const handler = captureHandler('outbound.message', adapter);

    await handler(makeOutboundEvent({}));

    expect(gateway.linkGatedAction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/channels/email/email-adapter.test.ts --run -t "gated-fallback"`
Expected: FAIL

- [ ] **Step 3: Rewrite dispatchByPolicy()**

Replace the full `dispatchByPolicy()` method in `email-adapter.ts`:

```typescript
/**
 * Route an outbound email through the configured policy.
 *
 * - direct:     send via gateway (autonomy gate applied at gateway level).
 *               If gated, fall back to draft creation and link the action_log row.
 * - draft_gate: create draft directly (config-level choice, no action_log).
 */
private async dispatchByPolicy(
  sendRequest: EmailSendRequest,
  context: { taskEventId?: string; conversationId?: string },
): Promise<void> {
  const { outboundPolicy, outboundGateway, logger, accountId } = this.config;

  if (outboundPolicy === 'draft_gate') {
    // Config-level always-draft — no autonomy decision, no action_log
    await outboundGateway.createEmailDraft(sendRequest);
    return;
  }

  // Policy: 'direct' — send through gateway, handle gated fallback
  const result = await outboundGateway.send(sendRequest, {
    taskEventId: context.taskEventId,
    conversationId: context.conversationId,
  });

  if (result.success) return;

  if (result.gated) {
    // Gateway blocked the send — create draft as fallback
    const draftResult = await outboundGateway.createEmailDraft(sendRequest);

    if (draftResult.success && draftResult.draftId && result.actionRef) {
      await outboundGateway.linkGatedAction(result.actionRef, {
        draftId: draftResult.draftId,
        accountId,
        recipientEmail: sendRequest.to,
        subject: sendRequest.subject,
      });
    }

    logger.info(
      { accountId, actionRef: result.actionRef, draftId: draftResult.draftId },
      'email-adapter: send gated by autonomy — draft created as fallback',
    );
    return;
  }

  // Non-gated failure (blocked contact, content filter, etc.) — already logged by gateway
}
```

- [ ] **Step 4: Remove the AutonomyService import and any remaining references**

Remove `import type { AutonomyService }` from the top of the file. Remove any references to `this.config.autonomyService` or `this.config.autonomyThreshold`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree run test -- tests/unit/channels/email/email-adapter.test.ts --run`
Expected: All new and existing tests pass

- [ ] **Step 6: Commit**

```bash
git add src/channels/email/email-adapter.ts tests/unit/channels/email/email-adapter.test.ts
git commit -m "feat(#435): simplify email adapter — remove autonomy logic, add gated-fallback"
```

---

### Task 8: Observation-Mode Draft Tracking

**Files:**
- Modify: `skills/email-draft-save/handler.ts`
- Modify: `skills/email-draft-save/handler.test.ts`

- [ ] **Step 1: Write failing test**

In `skills/email-draft-save/handler.test.ts`:

```typescript
describe('observation-mode action_log tracking', () => {
  it('writes action_log row with source observation_mode when draft is created in obs mode', async () => {
    const actionLogRepo = {
      insert: vi.fn().mockResolvedValue(1),
      countShortRefsForTask: vi.fn().mockResolvedValue(0),
    };
    const ctx = makeCtx({
      taskMetadata: { observationMode: true },
      taskEventId: 'task-obs-1',
      conversationId: 'email:thread-xyz',
      actionLogRepo,
      // ... other required ctx fields for a successful draft save
    });

    await handler.execute(ctx);

    expect(actionLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-obs-1',
        conversationId: 'email:thread-xyz',
        outcome: 'pending_approval',
        payload: expect.objectContaining({
          source: 'observation_mode',
          draftId: expect.any(String),
        }),
        shortRef: expect.stringMatching(/^email-/),
      }),
    );
  });

  it('does NOT write action_log when not in observation mode', async () => {
    const actionLogRepo = { insert: vi.fn(), countShortRefsForTask: vi.fn() };
    const ctx = makeCtx({
      taskMetadata: {},  // no observationMode
      actionLogRepo,
    });

    await handler.execute(ctx);

    expect(actionLogRepo.insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree run test -- skills/email-draft-save/handler.test.ts --run -t "observation-mode action_log"`
Expected: FAIL

- [ ] **Step 3: Implement action_log write in email-draft-save handler**

In `skills/email-draft-save/handler.ts`, after the successful `createEmailDraft()` call, add:

```typescript
// Track observation-mode drafts in action_log for pending-actions-digest
if (ctx.taskMetadata?.observationMode === true && ctx.actionLogRepo && ctx.taskEventId) {
  const counter = await ctx.actionLogRepo.countShortRefsForTask(ctx.taskEventId);
  const shortRef = `email-${counter + 1}`;
  const recipientEmail = /* extract from draft request */;
  const subject = /* extract from draft request */;
  const description = recipientEmail
    ? `Draft reply to ${recipientEmail}${subject ? ` — "${subject}"` : ''} (${accountId}). Use send-draft to approve.`
    : `Observation-mode draft created (${accountId}). Use send-draft to approve.`;

  await ctx.actionLogRepo.insert({
    taskId: ctx.taskEventId,
    conversationId: ctx.conversationId ?? null,
    skillName: 'email-draft-save',
    actionRisk: 'medium',
    outcome: 'pending_approval',
    shortRef,
    description,
    payload: {
      source: 'observation_mode',
      draftId: draftResult.id,  // from createEmailDraft() result
      accountId,
      recipientEmail,
      subject,
    },
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  });
}
```

(Exact variable names depend on how the handler structures the draft request — adapt to match the existing handler's variable names.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix /path/to/worktree run test -- skills/email-draft-save/handler.test.ts --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/email-draft-save/handler.ts skills/email-draft-save/handler.test.ts
git commit -m "feat(#435): observation-mode drafts write action_log for pending-actions tracking"
```

---

### Task 9: send-draft Action Log Transition

**Files:**
- Modify: `skills/send-draft/handler.ts`
- Modify: `skills/send-draft/handler.test.ts`

- [ ] **Step 1: Write failing tests**

In `skills/send-draft/handler.test.ts`:

```typescript
describe('action_log transition on approval', () => {
  it('transitions matching action_log row to approved on successful send', async () => {
    const actionLogRepo = {
      findPendingByPayloadField: vi.fn().mockResolvedValue({
        id: 42,
        shortRef: 'email-1',
        outcome: 'pending_approval',
      }),
      resolveById: vi.fn().mockResolvedValue(true),
    };
    const ctx = makeCtx({
      actionLogRepo,
      gateway: { sendEmailDraft: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }) },
    });

    await handler.execute(ctx);

    expect(actionLogRepo.findPendingByPayloadField).toHaveBeenCalledWith('draftId', 'draft-abc123');
    expect(actionLogRepo.resolveById).toHaveBeenCalledWith(42, 'approved', 'ceo');
  });

  it('still succeeds when no action_log row exists (pre-existing draft)', async () => {
    const actionLogRepo = {
      findPendingByPayloadField: vi.fn().mockResolvedValue(null),
      resolveById: vi.fn(),
    };
    const ctx = makeCtx({
      actionLogRepo,
      gateway: { sendEmailDraft: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }) },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(actionLogRepo.resolveById).not.toHaveBeenCalled();
  });

  it('still succeeds when actionLogRepo is not available', async () => {
    const ctx = makeCtx({
      // no actionLogRepo
      gateway: { sendEmailDraft: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-1' }) },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /path/to/worktree run test -- skills/send-draft/handler.test.ts --run -t "action_log transition"`
Expected: FAIL

- [ ] **Step 3: Add findPendingByPayloadField to ActionLogRepo**

In `src/autonomy/action-log-repo.ts`:

```typescript
/**
 * Find a pending_approval row where a specific field in the JSONB payload
 * matches the given value. Used by send-draft to find the action_log row
 * associated with a draft being approved.
 */
async findPendingByPayloadField(
  field: string,
  value: string,
): Promise<ActionLogRow | null> {
  const result = await this.pool.query(
    `SELECT * FROM autonomy_action_log
     WHERE outcome = 'pending_approval'
       AND payload->>$1 = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [field, value],
  );
  return result.rows[0] ? this.mapRow(result.rows[0]) : null;
}
```

Also add a `resolve()` method if one doesn't exist (check — `resolvePending` exists but operates on shortRef. We need one that operates by row ID):

```typescript
/**
 * Transition a specific action_log row to a terminal outcome.
 */
async resolveById(id: number, outcome: string, resolvedBy: string): Promise<boolean> {
  const result = await this.pool.query(
    `UPDATE autonomy_action_log
     SET outcome = $2, resolved_at = NOW(), resolved_by = $3
     WHERE id = $1 AND outcome = 'pending_approval'`,
    [id, outcome, resolvedBy],
  );
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Implement transition in send-draft handler**

In `skills/send-draft/handler.ts`, after the successful `sendEmailDraft()` call (around line 116), add:

```typescript
// Transition action_log row from pending_approval → approved (best-effort)
if (ctx.actionLogRepo) {
  try {
    const row = await ctx.actionLogRepo.findPendingByPayloadField('draftId', draftId);
    if (row) {
      await ctx.actionLogRepo.resolveById(row.id, 'approved', 'ceo');
    }
  } catch (err) {
    // Best-effort — don't fail the send if action_log transition fails
    ctx.log.warn({ err, draftId }, 'send-draft: failed to transition action_log row');
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix /path/to/worktree run test -- skills/send-draft/handler.test.ts --run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add skills/send-draft/handler.ts skills/send-draft/handler.test.ts src/autonomy/action-log-repo.ts
git commit -m "feat(#435): send-draft transitions action_log row to approved on CEO send"
```

---

### Task 10: Pending-Actions-Digest Format — shortRef at End

**Files:**
- Modify: `skills/pending-actions-digest/handler.ts:71-79`
- Modify: `skills/pending-actions-digest/handler.test.ts`

- [ ] **Step 1: Write failing test**

In `skills/pending-actions-digest/handler.test.ts`, find the test that asserts on the bullet format and update:

```typescript
it('formats each pending row with shortRef at end of line', async () => {
  const pending = [
    makeRow({ shortRef: 'email-1', description: 'Draft reply to kevin@example.com', skillName: 'outbound-send', expiresAt: futureDate(12) }),
  ];
  const ctx = makeCtx({ actionLogRepo: { findAllPending: vi.fn().mockResolvedValue(pending) } });

  await handler.execute(ctx);

  const body = getNotificationBody(ctx);
  expect(body).toContain('Draft reply to kevin@example.com [outbound-send] — 12h remaining [email-1]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /path/to/worktree run test -- skills/pending-actions-digest/handler.test.ts --run`
Expected: FAIL — current format puts shortRef first (`email-1: Draft reply...`)

- [ ] **Step 3: Update the line format**

In `skills/pending-actions-digest/handler.ts`, change line 77:

From:
```typescript
return `• ${r.shortRef ?? '(no ref)'}: ${r.description ?? '(no description)'} [${r.skillName}] — ${timeRemaining}`;
```

To:
```typescript
return `• ${r.description ?? '(no description)'} [${r.skillName}] — ${timeRemaining} [${r.shortRef ?? '—'}]`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix /path/to/worktree run test -- skills/pending-actions-digest/handler.test.ts --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/pending-actions-digest/handler.ts skills/pending-actions-digest/handler.test.ts
git commit -m "feat(#435): move shortRef to end of digest line for readability"
```

---

### Task 11: Flow Integration Test

**Files:**
- Create: `tests/integration/draft-fallback-flow.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/draft-fallback-flow.test.ts
//
// Integration test: validates the full autonomy gate → draft fallback → approval flow.
// Exercises the contracts between OutboundGateway, EmailAdapter, ActionLogRepo, and send-draft.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import { EmailAdapter } from '../../src/channels/email/email-adapter.js';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { EventBus } from '../../src/bus/bus.js';

describe('draft-fallback flow integration', () => {
  let bus: EventBus;
  let actionLogRepo: ActionLogRepo;
  let gateway: OutboundGateway;

  beforeEach(() => {
    bus = new EventBus(createSilentLogger());
    // Use mock pool for action_log
    actionLogRepo = makeMockActionLogRepo();
  });

  describe('autonomy-gated flow', () => {
    it('full path: gate → draft → link → approve', async () => {
      // Setup: score below threshold
      const autonomyService = makeAutonomyService(65);
      const nylasClient = makeMockNylasClient({ draftId: 'draft-abc' });

      gateway = new OutboundGateway({
        autonomyService,
        actionLogRepo,
        nylasClients: new Map([['curia', nylasClient]]),
        bus,
        logger: createSilentLogger(),
        contactService: makeMockContactService(),
      });

      const adapter = new EmailAdapter({
        accountId: 'curia',
        outboundPolicy: 'direct',
        bus,
        logger: createSilentLogger(),
        outboundGateway: gateway,
        contactService: makeMockContactService(),
        pollingIntervalMs: 60000,
        selfEmail: 'curia@example.com',
        observationMode: false,
        excludedSenderEmails: [],
        contactCreationMaxPerMessage: 5,
        contactCreationMaxPerHour: 100,
      });

      await adapter.start();

      // Trigger outbound.message
      await bus.publish('dispatch', createOutboundMessage({
        conversationId: 'email:thread-1',
        channelId: 'email',
        accountId: 'curia',
        content: 'Hello Kevin',
        taskEventId: 'task-001',
        parentEventId: 'response-001',
      }));

      // Assert: action_log row created with pending_approval
      expect(actionLogRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'pending_approval',
          payload: expect.objectContaining({ source: 'autonomy_gate' }),
        }),
      );

      // Assert: draft was created
      expect(nylasClient.createDraft).toHaveBeenCalled();

      // Assert: action_log was linked with draftId
      expect(actionLogRepo.linkPayload).toHaveBeenCalledWith(
        expect.stringMatching(/^email-/),
        expect.objectContaining({ draftId: 'draft-abc', accountId: 'curia' }),
      );
    });

    it('score >= threshold sends directly without draft or action_log', async () => {
      const autonomyService = makeAutonomyService(85);
      const nylasClient = makeMockNylasClient({});

      gateway = new OutboundGateway({
        autonomyService,
        actionLogRepo,
        nylasClients: new Map([['curia', nylasClient]]),
        bus,
        logger: createSilentLogger(),
        contactService: makeMockContactService(),
      });

      // ... trigger outbound.message ...

      expect(actionLogRepo.insert).not.toHaveBeenCalled();
      expect(nylasClient.sendEmail).toHaveBeenCalled();  // direct send
    });
  });

  describe('multi-account', () => {
    it('two accounts gated — each creates draft on its own account', async () => {
      const autonomyService = makeAutonomyService(65);
      const curiaNylas = makeMockNylasClient({ draftId: 'draft-curia' });
      const josephNylas = makeMockNylasClient({ draftId: 'draft-joseph' });

      gateway = new OutboundGateway({
        autonomyService,
        actionLogRepo,
        nylasClients: new Map([['curia', curiaNylas], ['joseph', josephNylas]]),
        bus,
        logger: createSilentLogger(),
        contactService: makeMockContactService(),
      });

      // Create two adapters with different accounts
      const curiaAdapter = new EmailAdapter({
        accountId: 'curia',
        outboundPolicy: 'direct',
        // ... config ...
      });
      const josephAdapter = new EmailAdapter({
        accountId: 'joseph',
        outboundPolicy: 'direct',
        // ... config ...
      });

      await curiaAdapter.start();
      await josephAdapter.start();

      // Trigger outbound for each account
      // Assert: curiaNylas.createDraft called, josephNylas.createDraft called
      // Assert: two separate action_log rows with different accountIds
    });
  });

  describe('draft_gate policy', () => {
    it('creates draft without action_log or gateway.send()', async () => {
      const nylasClient = makeMockNylasClient({ draftId: 'draft-cfg' });
      gateway = new OutboundGateway({
        nylasClients: new Map([['curia', nylasClient]]),
        bus,
        logger: createSilentLogger(),
        contactService: makeMockContactService(),
      });

      const adapter = new EmailAdapter({
        accountId: 'curia',
        outboundPolicy: 'draft_gate',
        // ... config ...
      });

      await adapter.start();

      // Trigger outbound.message
      // Assert: createDraft called, send NOT called, no action_log
      expect(actionLogRepo.insert).not.toHaveBeenCalled();
    });
  });
});
```

(Adapt helper functions to match the existing test utility patterns in the codebase.)

- [ ] **Step 2: Run integration test**

Run: `npm --prefix /path/to/worktree run test -- tests/integration/draft-fallback-flow.test.ts --run`
Expected: PASS (if all previous tasks are implemented correctly)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/draft-fallback-flow.test.ts
git commit -m "test(#435): add flow integration test for draft-fallback path"
```

---

### Task 12: Housekeeping — CHANGELOG and Config Cleanup

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `config/default.yaml` (if it references `autonomy_gated`)
- Modify: `src/index.ts` (if it wires autonomyService into email adapter)

- [ ] **Step 1: Update CHANGELOG**

Add under `## [Unreleased]`:

```markdown
### Changed

- **Outbound autonomy gate** — draft-fallback logic lifted from email adapter to OutboundGateway;
  email adapter simplified to pure transport. Gateway now writes `autonomy_action_log` rows on
  gated sends and supports two-step draft linkage. Observation-mode drafts also tracked in
  action_log for unified pending-actions surface. (#435)
- **Pending-actions-digest** — short reference codes moved to end of each line for readability

### Removed

- **`autonomy_gated` outbound policy** — replaced by gateway-level autonomy gate on `direct`
  policy. Deployments using `autonomy_gated` must switch to `direct`.
```

- [ ] **Step 2: Update config/default.yaml if needed**

Check if `config/default.yaml` references `autonomy_gated`. If so, change to `direct`.

- [ ] **Step 3: Update src/index.ts bootstrap**

Remove `autonomyService` from EmailAdapter construction (it's no longer in the config interface). Ensure `actionLogRepo` is wired into `OutboundGateway` construction.

- [ ] **Step 4: Run full test suite**

Run: `npm --prefix /path/to/worktree test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md config/default.yaml src/index.ts
git commit -m "chore(#435): update changelog, remove autonomy_gated from config, wire actionLogRepo"
```

---

## Verification

After all tasks are complete:

1. `npm --prefix /path/to/worktree test` — all unit and integration tests pass
2. `npm --prefix /path/to/worktree run build` — TypeScript compiles cleanly
3. `npm --prefix /path/to/worktree run lint` — no lint errors
4. Manual grep: confirm no remaining references to `autonomy_gated` in source (excluding CHANGELOG/docs)
5. Manual grep: confirm no remaining hardcoded `70` in outbound-gateway.ts or email-adapter.ts
