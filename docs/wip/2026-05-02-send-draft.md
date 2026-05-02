# send-draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `send-draft` skill so Curia can honour a CEO's explicit "send it" instruction on a saved draft email, bypassing the autonomy gate via CEO-authorized action pattern (ADR-017).

**Architecture:** Gateway gains a `humanApproved: true` option that skips the autonomy gate only; dispatcher stamps `ceoInitiated: true` into task metadata for CEO-sender messages; the `send-draft` handler hard-gates on that flag, fetches the draft from the Nylas DRAFTS folder, reconstructs threading, and sends via `gateway.send({ humanApproved: true })`.

**Tech Stack:** TypeScript (ESM), Vitest, Nylas SDK v8, existing `OutboundGateway`, `EventBus`, `createHumanDecision` from `src/bus/events.ts`

---

## File Map

**Modified:**
- `tests/unit/skills/outbound-gateway.test.ts` — add `humanApproved` option tests
- `src/skills/outbound-gateway.ts` — add `humanApproved?: boolean` to `send()` options
- `tests/unit/dispatch/dispatcher.test.ts` — add `ceoInitiated` stamping tests
- `src/dispatch/dispatcher.ts` — stamp `ceoInitiated` into task metadata when sender role is `'ceo'`
- `agents/coordinator.yaml` — add `send-draft` to `pinned_skills`
- `CHANGELOG.md` — add `Added` entries

**Created:**
- `skills/send-draft/skill.json` — skill manifest
- `skills/send-draft/handler.ts` — skill handler
- `skills/send-draft/handler.test.ts` — skill handler tests

---

## Task 1: Gateway — add `humanApproved` option

**Files:**
- Modify: `tests/unit/skills/outbound-gateway.test.ts`
- Modify: `src/skills/outbound-gateway.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the bottom of `tests/unit/skills/outbound-gateway.test.ts`, after the existing `describe('autonomy gate on send()', ...)` block:

```typescript
describe('humanApproved option on send()', () => {
  it('bypasses the autonomy gate when humanApproved: true and score < 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { humanApproved: true },
    );

    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('still enforces the blocked-contact check when humanApproved: true', async () => {
    const mocks = createMocks();
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-1',
      displayName: 'Blocked Person',
      role: null,
      status: 'blocked',
      kgNodeId: null,
      verified: true,
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { humanApproved: true },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('still enforces the content filter when humanApproved: true', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'test-rule', detail: 'blocked in test' }],
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { humanApproved: true },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Content blocked by filter');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run test -- tests/unit/skills/outbound-gateway.test.ts
```

Expected: 3 new tests FAIL. The first fails because `humanApproved` doesn't exist yet, so the autonomy gate still blocks. The other two likely pass already (blocked-contact and content filter don't depend on the new option) — if so, that's fine, they become regression guards.

- [ ] **Step 3: Implement the `humanApproved` option**

In `src/skills/outbound-gateway.ts`, make two changes:

**Change 1** — update the `send()` JSDoc and signature (line ~223):

```typescript
  /**
   * Send an outbound message through the gateway pipeline.
   *
   * Pipeline steps (channel-agnostic):
   *   0. Autonomy gate — score < 70 blocks all autonomous sends
   *      (skipped when options.humanApproved is true — CEO is in the loop)
   *   1. Contact blocked check
   *   2. Content filter (fail-closed)
   *   3. Channel dispatch (email → Nylas, signal → signal-cli RPC)
   *
   * @param options.skipNotificationOnBlock  When true, suppress the CEO notification
   *   if the content filter blocks this message.
   * @param options.humanApproved  When true, skip Step 0 (autonomy gate) only.
   *   The CEO is explicitly in the loop. All other safety checks (blocked-contact,
   *   content filter) run normally. See ADR-017.
   */
  async send(
    request: OutboundSendRequest,
    options?: { skipNotificationOnBlock?: boolean; humanApproved?: boolean },
  ): Promise<OutboundSendResult> {
```

**Change 2** — wrap the autonomy gate block (starts at line ~234) with the `!options?.humanApproved` guard:

```typescript
    if (this.autonomyService && !options?.humanApproved) {
```

(Only this one line changes — the rest of the autonomy gate block is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run test -- tests/unit/skills/outbound-gateway.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft commit -m "feat: add humanApproved option to OutboundGateway.send() — skips autonomy gate for CEO-authorized sends (ADR-017)"
```

---

## Task 2: Dispatcher — stamp `ceoInitiated` in task metadata

**Files:**
- Modify: `tests/unit/dispatch/dispatcher.test.ts`
- Modify: `src/dispatch/dispatcher.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the bottom of `tests/unit/dispatch/dispatcher.test.ts`:

```typescript
describe('ceoInitiated metadata stamping', () => {
  it('stamps ceoInitiated: true on agent.task when sender role is ceo', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Resolver returns a confirmed CEO contact
    const ceoResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: true,
        contactId: 'ceo-contact-id',
        displayName: 'The CEO',
        role: 'ceo',
        status: 'confirmed' as ContactStatus,
        verified: true,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
        contactConfidence: 1.0,
        trustLevel: 'high' as TrustLevel,
      } satisfies InboundSenderContext),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: ceoResolver,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow' } },
    });
    dispatcher.register();

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-ceo-1',
      channelId: 'signal',
      senderId: '+14155551234',
      content: 'Send that draft',
    }));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.metadata).toMatchObject({
      ceoInitiated: true,
      senderId: '+14155551234',
      channelId: 'signal',
    });
  });

  it('does NOT stamp ceoInitiated for a non-CEO confirmed sender', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    const nonCeoResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: true,
        contactId: 'vendor-contact-id',
        displayName: 'A Vendor',
        role: 'vendor',
        status: 'confirmed' as ContactStatus,
        verified: true,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
        contactConfidence: 0.5,
        trustLevel: null,
      } satisfies InboundSenderContext),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: nonCeoResolver,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow' } },
    });
    dispatcher.register();

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-nonceo-1',
      channelId: 'signal',
      senderId: '+19998887777',
      content: 'Hello',
    }));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.metadata?.ceoInitiated).toBeUndefined();
  });

  it('does NOT stamp ceoInitiated for observation-mode messages', async () => {
    // Security invariant: external emails in the CEO's monitored inbox must NEVER
    // receive ceoInitiated: true, even if a bug made the contact resolver return
    // role='ceo' for an external sender.
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Resolver is configured but never called for observation-mode messages
    const unusedResolver = {
      resolve: vi.fn(),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: unusedResolver,
    });
    dispatcher.register();

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-obs-1',
      channelId: 'email',
      senderId: 'external@example.com',
      content: 'External email',
      metadata: { observationMode: true, subject: 'Test' },
    }));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.metadata?.ceoInitiated).toBeUndefined();
    // Resolver must never be called for observation-mode messages
    expect(unusedResolver.resolve).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run test -- tests/unit/dispatch/dispatcher.test.ts
```

Expected: the `ceoInitiated: true` test FAILs (stamp not yet implemented); the non-CEO and observation-mode tests likely PASS already (no stamp, which is the expected behaviour even without the change). If the first test fails and the others pass, you're in the right state.

- [ ] **Step 3: Implement `ceoInitiated` stamping in the dispatcher**

In `src/dispatch/dispatcher.ts`, right before the `const taskEvent = createAgentTask({...})` call (around line 725), insert:

```typescript
    // Stamp ceoInitiated when the sender is the CEO directly (not via observation mode).
    // This flag is the hard gate in CEO-authorized skills (e.g. send-draft). It is NOT
    // set for observation-mode tasks so external emails cannot trigger approved actions.
    // See ADR-017 for the full security reasoning.
    const ceoMeta = senderContext?.role === 'ceo' && !isObservationMode
      ? { ceoInitiated: true as const, senderId: payload.senderId, channelId: payload.channelId }
      : undefined;
```

Then update the `metadata` field in the `createAgentTask` call from:

```typescript
      metadata: injectionMetadata
        ? { ...(payload.metadata ?? {}), ...injectionMetadata }
        : payload.metadata,
```

to:

```typescript
      metadata: (injectionMetadata || ceoMeta)
        ? { ...(payload.metadata ?? {}), ...(injectionMetadata ?? {}), ...(ceoMeta ?? {}) }
        : payload.metadata,
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run test -- tests/unit/dispatch/dispatcher.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft commit -m "feat: stamp ceoInitiated into task metadata for CEO-sender messages in dispatcher"
```

---

## Task 3: `send-draft` skill — manifest, handler, tests

**Files:**
- Create: `skills/send-draft/skill.json`
- Create: `skills/send-draft/handler.ts`
- Create: `skills/send-draft/handler.test.ts`

- [ ] **Step 1: Create skill.json**

Create `skills/send-draft/skill.json`:

```json
{
  "name": "send-draft",
  "description": "Send a draft email that the CEO has explicitly authorized. Only call this skill when the CEO has directly instructed Curia to send a specific draft. Do NOT call this autonomously or infer authorization from ambiguous messages. action_risk is 'none' because this is a CEO-directed action, not an autonomous one — the real gate is the task-origin check (ceoInitiated). See ADR-017.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "draft_id": "string (Nylas draft ID to send)",
    "account": "string (named email account the draft lives in, as configured in channel_accounts.email — e.g. the CEO's account name)"
  },
  "outputs": {
    "message_id": "string",
    "to": "string",
    "subject": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000,
  "capabilities": [
    "outboundGateway",
    "bus"
  ]
}
```

- [ ] **Step 2: Write the failing handler tests**

Create `skills/send-draft/handler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendDraftHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { EventBus } from '../../src/bus/bus.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

// Minimal draft fixture — shape matches NylasMessage
const DRAFT_STUB = {
  id: 'draft-abc123',
  threadId: '',
  subject: 'Re: Project Update',
  from: [{ email: 'curia@example.com' }],
  to: [{ email: 'kevin@example.com' }],
  cc: [],
  bcc: [],
  body: '<p>Hello Kevin</p>',
  snippet: 'Hello Kevin',
  date: 1746000000, // epoch seconds
  unread: false,
  folders: ['DRAFTS'],
};

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  taskMetadata?: Record<string, unknown> | undefined;
  gateway?: Partial<OutboundGateway>;
  bus?: Partial<EventBus>;
  taskEventId?: string;
}): SkillContext {
  const gateway = {
    listEmailMessages: vi.fn().mockResolvedValue([DRAFT_STUB]),
    send: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' }),
    ...overrides.gateway,
  } as unknown as OutboundGateway;

  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    ...overrides.bus,
  } as unknown as EventBus;

  const ctx = {
    input: overrides.input ?? { draft_id: 'draft-abc123', account: 'joseph' },
    secret: () => '',
    log: makeLogger(),
    outboundGateway: gateway,
    bus,
    taskMetadata: 'taskMetadata' in overrides
      ? overrides.taskMetadata
      : { ceoInitiated: true, senderId: '+14155551234', channelId: 'signal' },
    taskEventId: overrides.taskEventId ?? 'task-event-1',
  } as unknown as SkillContext;

  return ctx;
}

describe('SendDraftHandler', () => {
  let handler: SendDraftHandler;

  beforeEach(() => {
    handler = new SendDraftHandler();
  });

  // ─── Security gate ────────────────────────────────────────────────────────

  it('rejects when ceoInitiated is absent from taskMetadata', async () => {
    const ctx = makeCtx({ taskMetadata: {} });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/CEO authorization|ceoInitiated/i);
  });

  it('rejects when ceoInitiated is false', async () => {
    const ctx = makeCtx({ taskMetadata: { ceoInitiated: false } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
  });

  it('rejects when taskMetadata is undefined', async () => {
    const ctx = makeCtx({ taskMetadata: undefined });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/CEO authorization|ceoInitiated/i);
  });

  // ─── Capability guards ────────────────────────────────────────────────────

  it('returns error when outboundGateway is missing', async () => {
    const ctx = makeCtx({});
    (ctx as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/i);
  });

  it('returns error when bus is missing', async () => {
    const ctx = makeCtx({});
    (ctx as Record<string, unknown>).bus = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/bus/i);
  });

  // ─── Input validation ─────────────────────────────────────────────────────

  it('returns error when draft_id is missing', async () => {
    const ctx = makeCtx({ input: { account: 'joseph' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/draft_id/i);
  });

  it('returns error when account is missing', async () => {
    const ctx = makeCtx({ input: { draft_id: 'draft-abc123' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/account/i);
  });

  // ─── Draft lookup ─────────────────────────────────────────────────────────

  it('returns error when draft is not found in DRAFTS folder', async () => {
    const ctx = makeCtx({
      gateway: {
        listEmailMessages: vi.fn().mockResolvedValue([]),
        send: vi.fn(),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not found/i);
  });

  it('returns error when draft has no recipient', async () => {
    const draftNoRecipient = { ...DRAFT_STUB, to: [] };
    const ctx = makeCtx({
      gateway: {
        listEmailMessages: vi.fn().mockResolvedValue([draftNoRecipient]),
        send: vi.fn(),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/recipient/i);
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it('sends draft successfully and returns message_id, to, subject', async () => {
    const ctx = makeCtx({});
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.to).toBe('kevin@example.com');
      expect(data.subject).toBe('Re: Project Update');
      expect(data.message_id).toBe('msg-sent-1');
    }
  });

  it('calls gateway.send with humanApproved: true', async () => {
    const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { send: sendMock } });
    await handler.execute(ctx);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: 'kevin@example.com' }),
      { humanApproved: true },
    );
  });

  it('resolves reply threading when draft has a threadId', async () => {
    const draftWithThread = { ...DRAFT_STUB, threadId: 'thread-xyz' };
    const threadMessage = { ...DRAFT_STUB, id: 'latest-thread-msg', threadId: 'thread-xyz' };
    const listMock = vi.fn()
      .mockResolvedValueOnce([draftWithThread])  // first call: DRAFTS folder
      .mockResolvedValueOnce([threadMessage]);   // second call: thread lookup
    const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { listEmailMessages: listMock, send: sendMock } });

    await handler.execute(ctx);

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'latest-thread-msg' }),
      { humanApproved: true },
    );
  });

  it('sends without replyToMessageId when thread lookup fails (non-fatal)', async () => {
    const draftWithThread = { ...DRAFT_STUB, threadId: 'thread-xyz' };
    const listMock = vi.fn()
      .mockResolvedValueOnce([draftWithThread])
      .mockRejectedValueOnce(new Error('Nylas error'));
    const sendMock = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-sent-1' });
    const ctx = makeCtx({ gateway: { listEmailMessages: listMock, send: sendMock } });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true); // thread lookup failure is non-fatal
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: undefined }),
      { humanApproved: true },
    );
  });

  it('returns error when gateway blocks the send', async () => {
    const ctx = makeCtx({
      gateway: {
        send: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }),
      },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  it('publishes a human.decision event after successful send', async () => {
    const publishMock = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ bus: { publish: publishMock } });

    await handler.execute(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'human.decision',
        payload: expect.objectContaining({
          decision: 'approve',
          defaultAction: 'block',
        }),
      }),
    );
  });

  it('still returns success even when human.decision publish fails', async () => {
    // The message was sent — audit event failure must not retroactively fail the skill.
    const publishMock = vi.fn().mockRejectedValue(new Error('bus error'));
    const ctx = makeCtx({ bus: { publish: publishMock } });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run test -- skills/send-draft/handler.test.ts
```

Expected: all tests FAIL (module not found — handler.ts doesn't exist yet).

- [ ] **Step 4: Create handler.ts**

Create `skills/send-draft/handler.ts`:

```typescript
// handler.ts — send-draft skill implementation.
//
// Sends a Nylas draft email on explicit CEO authorization.
//
// SECURITY: The task-origin check (ctx.taskMetadata?.ceoInitiated === true) is the
// primary gate. That flag is stamped by the dispatch layer in TypeScript code before
// the coordinator sees the task — the LLM cannot set it. Observation-mode tasks
// (external emails) explicitly do not receive this flag, preventing prompt injection
// from external sources from triggering approved sends.
//
// See ADR-017 for the full reasoning behind this pattern.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createHumanDecision } from '../../src/bus/events.js';

export class SendDraftHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    // ------------------------------------------------------------------
    // Step 1: Task-origin check — hard gate, must be first
    // ------------------------------------------------------------------
    // ctx.taskMetadata is populated by the agent runtime from the agent.task
    // event payload; the LLM cannot influence it. Observation-mode tasks
    // (triggered by external emails) explicitly do not receive ceoInitiated,
    // so prompt injection from an external email cannot reach this point with
    // the flag set.
    if (ctx.taskMetadata?.ceoInitiated !== true) {
      ctx.log.warn(
        { ceoInitiated: ctx.taskMetadata?.ceoInitiated },
        'send-draft: rejected — ceoInitiated flag absent or false in task metadata',
      );
      return {
        success: false,
        error: 'send-draft requires direct CEO authorization. This skill can only be called from a task initiated by the CEO.',
      };
    }

    if (!ctx.outboundGateway) {
      return { success: false, error: 'send-draft requires outboundGateway (capabilities: ["outboundGateway"])' };
    }

    if (!ctx.bus) {
      return { success: false, error: 'send-draft requires bus (capabilities: ["bus"])' };
    }

    // ------------------------------------------------------------------
    // Step 2: Parse inputs
    // ------------------------------------------------------------------
    const input = ctx.input && typeof ctx.input === 'object'
      ? (ctx.input as Record<string, unknown>)
      : {};
    const { draft_id: rawDraftId, account: rawAccount } = input as {
      draft_id?: string;
      account?: string;
    };

    const draftId = typeof rawDraftId === 'string' && rawDraftId.trim()
      ? rawDraftId.trim()
      : undefined;
    if (!draftId) return { success: false, error: 'Missing required input: draft_id (string)' };

    const account = typeof rawAccount === 'string' && rawAccount.trim()
      ? rawAccount.trim()
      : undefined;
    if (!account) return { success: false, error: 'Missing required input: account (string)' };

    ctx.log.info({ draftId, account }, 'send-draft: fetching draft');

    // ------------------------------------------------------------------
    // Step 3: Fetch draft from Nylas DRAFTS folder
    // ------------------------------------------------------------------
    // The Nylas DRAFTS folder is the source of truth — no shadow PG registry needed.
    // We list all drafts and filter client-side by ID; Nylas doesn't support
    // a direct draft-by-ID lookup via the messages API.
    let drafts: Awaited<ReturnType<typeof ctx.outboundGateway.listEmailMessages>>;
    try {
      drafts = await ctx.outboundGateway.listEmailMessages({ folders: ['DRAFTS'] }, account);
    } catch (err) {
      ctx.log.error({ err, account }, 'send-draft: failed to fetch DRAFTS folder');
      return { success: false, error: 'Failed to fetch drafts folder' };
    }

    const draft = drafts.find((m) => m.id === draftId);
    if (!draft) {
      ctx.log.warn({ draftId, account }, 'send-draft: draft not found in DRAFTS folder');
      return { success: false, error: `Draft not found: ${draftId}` };
    }

    const recipient = draft.to[0]?.email;
    if (!recipient) {
      ctx.log.error({ draftId }, 'send-draft: draft has no recipient address');
      return { success: false, error: 'Draft has no recipient address' };
    }

    // ------------------------------------------------------------------
    // Step 4: Resolve reply threading
    // ------------------------------------------------------------------
    // If the draft belongs to an existing thread, look up the latest message
    // in that thread and pass its ID as replyToMessageId so Nylas threads the
    // outbound message correctly. Same pattern as email-adapter.sendOutboundReply().
    //
    // Thread lookup failure is non-fatal: the email still reaches the recipient;
    // only the In-Reply-To / References headers are missing.
    let replyToMessageId: string | undefined;
    if (draft.threadId) {
      try {
        const threadMessages = await ctx.outboundGateway.listEmailMessages(
          { threadId: draft.threadId, limit: 1 },
          account,
        );
        replyToMessageId = threadMessages[0]?.id;
      } catch (err) {
        ctx.log.warn(
          { err, draftId, threadId: draft.threadId },
          'send-draft: thread lookup failed — sending without replyToMessageId',
        );
      }
    }

    // ------------------------------------------------------------------
    // Step 5: Send via gateway with humanApproved: true
    // ------------------------------------------------------------------
    // humanApproved: true skips the autonomy gate (Step 0) only — the CEO is
    // explicitly in the loop. Blocked-contact check and content filter run normally.
    ctx.log.info({ draftId, account, recipient }, 'send-draft: sending');

    let sendResult: Awaited<ReturnType<typeof ctx.outboundGateway.send>>;
    try {
      sendResult = await ctx.outboundGateway.send(
        {
          channel: 'email',
          accountId: account,
          to: recipient,
          subject: draft.subject,
          body: draft.body,
          replyToMessageId,
        },
        { humanApproved: true },
      );
    } catch (err) {
      ctx.log.error({ err, draftId, account }, 'send-draft: unexpected error during send');
      return { success: false, error: 'Failed to send draft' };
    }

    if (!sendResult.success) {
      ctx.log.warn(
        { draftId, account, reason: sendResult.blockedReason },
        'send-draft: gateway blocked the send',
      );
      return { success: false, error: sendResult.blockedReason ?? 'Send blocked by gateway' };
    }

    // ------------------------------------------------------------------
    // Step 6: Publish human.decision audit event
    // ------------------------------------------------------------------
    // Non-fatal: the message is already sent. If bus publish fails, log at error
    // so the missing audit trail is visible in alerting, but don't fail the skill.
    const senderId = typeof ctx.taskMetadata?.senderId === 'string'
      ? ctx.taskMetadata.senderId
      : 'unknown';
    const channelId = typeof ctx.taskMetadata?.channelId === 'string'
      ? ctx.taskMetadata.channelId
      : 'unknown';

    try {
      await ctx.bus.publish(
        'dispatch',
        createHumanDecision({
          decision: 'approve',
          deciderId: senderId,
          deciderChannel: channelId,
          // subjectEventId: the task event that drove the CEO's "send it" instruction.
          subjectEventId: ctx.taskEventId ?? '',
          subjectSummary: `CEO authorized send of draft '${draft.subject}' to ${recipient}`,
          contextShown: ['draft_id', 'draft_subject', 'draft_recipient'],
          // presentedAt: draft creation time as proxy for when the decision was presented.
          presentedAt: new Date(draft.date * 1000),
          decidedAt: new Date(),
          defaultAction: 'block',
          parentEventId: ctx.taskEventId ?? '',
        }),
      );
    } catch (err) {
      ctx.log.error(
        { err, draftId },
        'send-draft: failed to publish human.decision event — message was sent but audit event is missing',
      );
    }

    ctx.log.info(
      { draftId, messageId: sendResult.messageId, recipient },
      'send-draft: sent successfully',
    );

    return {
      success: true,
      data: {
        message_id: sendResult.messageId ?? '',
        to: recipient,
        subject: draft.subject,
      },
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run test -- skills/send-draft/handler.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft add skills/send-draft/skill.json skills/send-draft/handler.ts skills/send-draft/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft commit -m "feat: add send-draft skill — CEO-authorized draft send with task-origin enforcement (ADR-017)"
```

---

## Task 4: Coordinator YAML — register `send-draft`

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Add `send-draft` to `pinned_skills`**

In `agents/coordinator.yaml`, add `- send-draft` to the `pinned_skills` list. Place it directly after `- email-draft-save` (keeping email-related skills grouped):

```yaml
  - email-draft-save
  - send-draft
```

- [ ] **Step 2: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft run test
```

Expected: all tests PASS (the YAML change itself has no unit tests, but the full suite confirms nothing regressed).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft commit -m "feat: register send-draft in coordinator pinned_skills"
```

---

## Task 5: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entries under `## [Unreleased]`**

Add these bullets under `### Added` in the `## [Unreleased]` section:

```markdown
- **`send-draft` skill** — new skill that sends a CEO-approved Nylas draft email. Requires `ceoInitiated: true` in task metadata (stamped by the dispatch layer for CEO-sender messages); bypasses the autonomy gate via `humanApproved: true` while preserving all other safety checks. Implements the CEO-authorized action pattern from ADR-017.
- **ADR-017** — documents the CEO-authorized action pattern: `action_risk: "none"` + task-origin check + `humanApproved` flag as a reusable recipe for future CEO-directed skills.
- **`humanApproved` option on `OutboundGateway.send()`** — narrow flag that skips Step 0 (autonomy gate) only; blocked-contact check and content filter are unaffected. Part of the ADR-017 pattern.
- **`ceoInitiated` task metadata stamping** — dispatcher now stamps `ceoInitiated: true`, `senderId`, and `channelId` into task metadata when the sender's role is `ceo` and the task is not observation-mode.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-send-draft commit -m "chore: update CHANGELOG for send-draft feature"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task that covers it |
|---|---|
| `send-draft` skill implemented + registered in coordinator `pinned_skills` | Tasks 3 + 4 |
| Task-origin check enforced; non-CEO tasks hard-rejected | Task 3 (handler step 1) |
| `human.decision` event logged with `decision: 'approve'` | Task 3 (handler step 6) |
| Content filter still runs | Task 1 (gateway test) |
| Blocked-contact check still runs | Task 1 (gateway test) |
| `humanApproved: true` added to `OutboundGateway.send()`; autonomy gate skipped; all other checks unaffected | Task 1 |
| `ceoInitiated` stamped into task metadata by dispatch layer for CEO-verified identities | Task 2 |
| ADR-017 written | Already done (docs only) |

All 8 acceptance criteria from the spec are covered. No gaps.

### Placeholder scan

No TBD, TODO, or incomplete sections. All code blocks are complete and self-contained.

### Type consistency

- `humanApproved?: boolean` added to `send()` options — matches usage in handler (`{ humanApproved: true }`)
- `createHumanDecision` called with `{ parentEventId: string, ... }` — matches the factory signature
- `ctx.outboundGateway.listEmailMessages({ folders: ['DRAFTS'] }, account)` — matches `ListMessagesOptions` (the `folders` field is part of that interface; verify with `nylas-client.ts:104` if unsure)
- `ctx.outboundGateway.send(request, { humanApproved: true })` — matches the updated gateway signature from Task 1
