# Sender Trust Routing Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `routingDecision` to the `contact.unknown` event payload and add both unit and integration test coverage for the unknown-sender → hold_and_notify path.

**Architecture:** Three isolated changes in dependency order: event schema first, then dispatcher restructure to populate the new field, then tests. No new files — all changes are additions to existing files.

**Tech Stack:** TypeScript (ESM), Vitest, Node.js 22+

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust`
**Branch:** `feat/sender-trust`

---

## File Map

| File | Change |
|---|---|
| `src/bus/events.ts` | Add `routingDecision` field to `ContactUnknownPayload` |
| `src/dispatch/dispatcher.ts` | Import `UnknownSenderPolicy`; determine routing decision before publishing `contact.unknown` |
| `tests/unit/dispatch/dispatcher.test.ts` | Add 3 unit tests verifying `contact.unknown` payload for each routing policy |
| `tests/integration/vertical-slice.test.ts` | Add end-to-end scenario for unknown sender → hold_and_notify |

---

## Task 1: Add `routingDecision` to `ContactUnknownPayload`

**Files:**
- Modify: `src/bus/events.ts:127-134`

- [ ] **Step 1: Update the payload interface**

Open `src/bus/events.ts`. Find `ContactUnknownPayload` (around line 127). Replace it with:

```typescript
interface ContactUnknownPayload {
  channel: string;
  senderId: string;
  /** Channel trust level — required for trust score audit trail. */
  channelTrustLevel: 'low' | 'medium' | 'high';
  /** Computed message trust score for this unknown sender's message. */
  messageTrustScore: number;
  /** Routing decision applied to this unknown sender — mirrors the configured per-channel policy. */
  routingDecision: 'allow' | 'hold_and_notify' | 'ignore';
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust run build 2>&1
```

Expected: compile error — `createContactUnknown` call sites in `dispatcher.ts` are missing the new required field. This confirms the type is enforced. Proceed to Task 2.

---

## Task 2: Populate `routingDecision` in the dispatcher

**Files:**
- Modify: `src/dispatch/dispatcher.ts:7` (import line)
- Modify: `src/dispatch/dispatcher.ts:239-316` (unknown-sender branch)

- [ ] **Step 1: Add `UnknownSenderPolicy` to the type import**

Find line 7 in `src/dispatch/dispatcher.ts`:

```typescript
import type { InboundSenderContext, ChannelPolicyConfig, TrustLevel } from '../contacts/types.js';
```

Replace with:

```typescript
import type { InboundSenderContext, ChannelPolicyConfig, TrustLevel, UnknownSenderPolicy } from '../contacts/types.js';
```

- [ ] **Step 2: Restructure the unknown-sender branch**

Find the `} else {` block that begins with the comment `// Unknown sender — publish audit event and check channel policy.` (around line 235). Replace the entire block up to (but not including) the outer `} catch (err) {`) with:

```typescript
        } else {
          // Unknown sender — determine routing decision first so the audit event is self-contained.
          // Compute a preliminary trust score (injection risk not yet available — the unknown-sender
          // branch returns early before the scanner runs).
          const prelimChannelTrust = (this.channelPolicies?.[payload.channelId]?.trust ?? 'low') as TrustLevel;
          const prelimScore = computeTrustScore({
            channelTrustLevel: prelimChannelTrust,
            contactConfidence: 0.0,  // unknown sender has no confidence
            injectionRiskScore: 0,
            trustLevel: null,
            weights: this.trustScorerWeights,
          });

          const policy = this.channelPolicies?.[payload.channelId];

          // Routing decision reflects the configured policy intent. When hold_and_notify is
          // configured but heldMessages is not wired, the decision still says 'hold_and_notify'
          // so the audit trail is accurate — execution may degrade but the intent is recorded.
          const routingDecision: UnknownSenderPolicy =
            policy?.unknownSender === 'hold_and_notify' ? 'hold_and_notify'
            : policy?.unknownSender === 'ignore' ? 'ignore'
            : 'allow';

          await this.bus.publish('dispatch', createContactUnknown({
            channel: senderContext.channel,
            senderId: senderContext.senderId,
            channelTrustLevel: prelimChannelTrust,
            messageTrustScore: prelimScore,
            routingDecision,
            parentEventId: event.id,
          }));

          if (policy?.unknownSender === 'hold_and_notify' && this.heldMessages) {
            try {
              // Hold the message instead of routing to coordinator
              const subject = (payload.metadata as Record<string, unknown> | undefined)?.subject as string | null ?? null;
              const heldId = await this.heldMessages.hold({
                channel: payload.channelId,
                senderId: payload.senderId,
                conversationId: payload.conversationId,
                content: payload.content,
                subject,
                metadata: payload.metadata ?? {},
              });

              // Publish held event so CLI can notify and audit can log
              await this.bus.publish('dispatch', createMessageHeld({
                heldMessageId: heldId,
                channel: payload.channelId,
                senderId: payload.senderId,
                subject,
                parentEventId: event.id,
              }));

              this.logger.info(
                { heldMessageId: heldId, channel: payload.channelId, senderId: payload.senderId },
                'Message held from unknown sender',
              );
            } catch (holdErr) {
              // Fail closed: if we can't hold the message, drop it rather than
              // routing an unknown sender's message to the coordinator.
              // This is a security boundary — prefer message loss over policy bypass.
              this.logger.error(
                { err: holdErr, channel: payload.channelId, senderId: payload.senderId },
                'Failed to hold unknown sender message — dropping (fail-closed)',
              );
            }
            return; // Always return — whether hold succeeded or failed
          }

          if (policy?.unknownSender === 'ignore') {
            this.logger.info(
              { channel: payload.channelId, senderId: payload.senderId },
              'Rejected message from unknown sender',
            );
            try {
              await this.bus.publish('dispatch', createMessageRejected({
                conversationId: payload.conversationId,
                channelId: payload.channelId,
                senderId: payload.senderId,
                reason: 'unknown_sender',
                parentEventId: event.id,
              }));
            } catch (publishErr) {
              this.logger.error(
                { err: publishErr, channel: payload.channelId, senderId: payload.senderId },
                'Failed to publish unknown-sender rejection event — dropping (fail-closed)',
              );
            }
            return;
          }

          // 'allow' policy or no policy configured — fall through to normal routing
        }
```

- [ ] **Step 3: Verify TypeScript compiles cleanly**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust run build 2>&1
```

Expected: no errors.

- [ ] **Step 4: Run existing dispatcher tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust run test -- tests/unit/dispatch/dispatcher.test.ts 2>&1
```

Expected: all existing tests pass (the new field is additive — existing call sites in tests that build events via the bus don't assert on `contact.unknown` payload shape yet).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust add src/bus/events.ts src/dispatch/dispatcher.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust commit -m "feat: add routingDecision to contact.unknown event payload"
```

---

## Task 3: Unit tests — `contact.unknown` payload verification

**Files:**
- Modify: `tests/unit/dispatch/dispatcher.test.ts`

- [ ] **Step 1: Add the import for `ContactUnknownEvent`**

Find the existing import at the top of `tests/unit/dispatch/dispatcher.test.ts`:

```typescript
import { createInboundMessage, createAgentError, type OutboundMessageEvent, type MessageRejectedEvent, type AgentTaskEvent, type MessageHeldEvent } from '../../../src/bus/events.js';
```

Add `type ContactUnknownEvent` to it:

```typescript
import { createInboundMessage, createAgentError, type OutboundMessageEvent, type MessageRejectedEvent, type AgentTaskEvent, type MessageHeldEvent, type ContactUnknownEvent } from '../../../src/bus/events.js';
```

- [ ] **Step 2: Add the three payload tests**

Append a new `describe` block after the closing `});` of `describe('Dispatcher — messageTrustScore', ...)`:

```typescript
describe('Dispatcher — contact.unknown event payload', () => {
  it('contact.unknown includes routingDecision: hold_and_notify for email channel', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const heldMessages = makeInMemoryHeldMessages();
    const resolver = makeResolverWithNoContact();
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      heldMessages,
      channelPolicies: { email: { trust: 'low', unknownSender: 'hold_and_notify' } },
    });
    dispatcher.register();

    const unknownEvents: ContactUnknownEvent[] = [];
    bus.subscribe('contact.unknown', 'system', (e) => { unknownEvents.push(e as ContactUnknownEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-cu-hold',
      channelId: 'email',
      senderId: 'stranger@example.com',
      content: 'Hello',
    }));

    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]!.payload.channel).toBe('email');
    expect(unknownEvents[0]!.payload.senderId).toBe('stranger@example.com');
    expect(unknownEvents[0]!.payload.channelTrustLevel).toBe('low');
    // email low=0.3*0.4=0.12, unknown=0.0 → 0.12
    expect(unknownEvents[0]!.payload.messageTrustScore).toBeCloseTo(0.12);
    expect(unknownEvents[0]!.payload.routingDecision).toBe('hold_and_notify');
  });

  it('contact.unknown includes routingDecision: ignore for http channel', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const resolver = makeResolverWithNoContact();
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      channelPolicies: { http: { trust: 'medium', unknownSender: 'ignore' } },
    });
    dispatcher.register();

    const unknownEvents: ContactUnknownEvent[] = [];
    bus.subscribe('contact.unknown', 'system', (e) => { unknownEvents.push(e as ContactUnknownEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-cu-ignore',
      channelId: 'http',
      senderId: 'api-caller',
      content: 'Hello',
    }));

    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]!.payload.channelTrustLevel).toBe('medium');
    // http medium=0.6*0.4=0.24, unknown=0.0 → 0.24
    expect(unknownEvents[0]!.payload.messageTrustScore).toBeCloseTo(0.24);
    expect(unknownEvents[0]!.payload.routingDecision).toBe('ignore');
  });

  it('contact.unknown includes routingDecision: allow for high-trust allow channel', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const resolver = makeResolverWithNoContact();
    // Use a mock provider so the agent.task that flows through doesn't error
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'OK',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow' } },
    });
    dispatcher.register();

    const unknownEvents: ContactUnknownEvent[] = [];
    bus.subscribe('contact.unknown', 'system', (e) => { unknownEvents.push(e as ContactUnknownEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-cu-allow',
      channelId: 'signal',
      senderId: '+15550001234',
      content: 'Hello',
    }));

    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]!.payload.channelTrustLevel).toBe('high');
    // signal high=1.0*0.4=0.40, unknown=0.0 → 0.40
    expect(unknownEvents[0]!.payload.messageTrustScore).toBeCloseTo(0.40);
    expect(unknownEvents[0]!.payload.routingDecision).toBe('allow');
  });
});
```

- [ ] **Step 3: Run the new tests**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust run test -- tests/unit/dispatch/dispatcher.test.ts 2>&1
```

Expected: all tests pass including the three new ones.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust add tests/unit/dispatch/dispatcher.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust commit -m "test: verify contact.unknown routingDecision payload for all three policies"
```

---

## Task 4: Integration scenario — unknown sender → hold_and_notify

**Files:**
- Modify: `tests/integration/vertical-slice.test.ts`

- [ ] **Step 1: Add imports**

Find the existing import block at the top of `tests/integration/vertical-slice.test.ts`:

```typescript
import { createInboundMessage, type OutboundMessageEvent } from '../../src/bus/events.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
```

Replace with:

```typescript
import { createInboundMessage, type OutboundMessageEvent, type ContactUnknownEvent, type MessageHeldEvent, type AgentTaskEvent } from '../../src/bus/events.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { InboundSenderContext } from '../../src/contacts/types.js';
import { HeldMessageService } from '../../src/contacts/held-messages.js';
```

- [ ] **Step 2: Add the integration scenario**

Append a new `describe` block after the closing `});` of the existing describe block:

```typescript
describe('Vertical Slice: Unknown sender email → hold_and_notify', () => {
  it('holds the message, fires contact.unknown with correct routingDecision and score, suppresses agent.task', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // In-memory held messages — same interface as the real Postgres backend.
    const heldMessages = HeldMessageService.createInMemory();

    // Mock resolver: always returns unknown sender.
    // We test the dispatcher + HeldMessageService interaction here, not contact resolution.
    const mockResolver: ContactResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: false,
        channel: 'email',
        senderId: 'stranger@example.com',
      } satisfies InboundSenderContext),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: mockResolver,
      heldMessages,
      channelPolicies: { email: { trust: 'low', unknownSender: 'hold_and_notify' } },
    });
    dispatcher.register();

    // Capture events
    const unknownEvents: ContactUnknownEvent[] = [];
    const heldEvents: MessageHeldEvent[] = [];
    const taskEvents: AgentTaskEvent[] = [];

    bus.subscribe('contact.unknown', 'system', (e) => { unknownEvents.push(e as ContactUnknownEvent); });
    bus.subscribe('message.held', 'channel', (e) => { heldEvents.push(e as MessageHeldEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { taskEvents.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'email:stranger:1',
      channelId: 'email',
      senderId: 'stranger@example.com',
      content: 'Hey, can we talk?',
    }));

    // Message must NOT reach the coordinator
    expect(taskEvents).toHaveLength(0);

    // contact.unknown event must carry the correct audit fields
    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]!.payload.channel).toBe('email');
    expect(unknownEvents[0]!.payload.senderId).toBe('stranger@example.com');
    expect(unknownEvents[0]!.payload.channelTrustLevel).toBe('low');
    // email low channel (0.3 * 0.4 = 0.12) + unknown sender (0.0 * 0.4 = 0.0) = 0.12
    expect(unknownEvents[0]!.payload.messageTrustScore).toBeCloseTo(0.12);
    expect(unknownEvents[0]!.payload.routingDecision).toBe('hold_and_notify');

    // message.held event must fire with correct identifiers
    expect(heldEvents).toHaveLength(1);
    expect(heldEvents[0]!.payload.channel).toBe('email');
    expect(heldEvents[0]!.payload.senderId).toBe('stranger@example.com');

    // The message must be retrievable from the held messages store
    const pending = await heldMessages.listPending('email');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.senderId).toBe('stranger@example.com');
    expect(pending[0]!.content).toBe('Hey, can we talk?');
  });
});
```

- [ ] **Step 3: Run the new scenario**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust run test -- tests/integration/vertical-slice.test.ts 2>&1
```

Expected: both scenarios pass — the existing CLI slice and the new unknown-sender hold scenario.

- [ ] **Step 4: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust run test 2>&1
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust add tests/integration/vertical-slice.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust commit -m "test: add vertical-slice scenario for unknown sender hold_and_notify path"
```

---

## Task 5: Update CHANGELOG and close the loop

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry under `## [Unreleased]`**

```markdown
### Added
- **Sender trust routing** (spec §06): `contact.unknown` event now includes `routingDecision` field (`allow` | `hold_and_notify` | `ignore`), making the unknown-sender audit trail self-contained without requiring correlation with downstream events.

### Changed
- **Dispatcher**: unknown-sender branch now determines routing policy before publishing `contact.unknown`, ensuring the event accurately reflects the configured intent even when the `heldMessages` service is not wired.
```

- [ ] **Step 2: Check current version and bump**

```bash
cat /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust/package.json | grep '"version"'
```

This is completing a partially-shipped spec feature → patch bump. Update `package.json` version field: e.g., `0.14.0` → `0.14.1`.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-sender-trust commit -m "chore: bump to 0.14.1, update changelog for sender trust routing completion"
```
