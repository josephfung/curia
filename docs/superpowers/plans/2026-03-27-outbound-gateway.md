# Outbound Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all direct `nylasClient.sendMessage()` calls with a single `OutboundGateway` that enforces contact blocked checks and content filtering before any email leaves the system.

**Architecture:** A new `OutboundGateway` class in the execution layer owns all outbound external communication. Skills, the email adapter, and CEO notifications all route through it. The dispatcher's filter gate is removed — the gateway is the single enforcement point.

**Tech Stack:** TypeScript/ESM, Vitest, pino, existing EventBus + NylasClient + OutboundContentFilter + ContactService

**Spec:** `docs/superpowers/specs/2026-03-27-outbound-gateway-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/skills/outbound-gateway.ts` | Gateway: blocked check → content filter → channel dispatch |
| Create | `tests/unit/skills/outbound-gateway.test.ts` | Unit tests for gateway pipeline |
| Modify | `src/skills/types.ts` | Add `outboundGateway` to `SkillContext` interface |
| Modify | `src/skills/execution.ts` | Inject gateway instead of nylasClient |
| Modify | `skills/email-send/handler.ts` | Use `ctx.outboundGateway` instead of `ctx.nylasClient` |
| Modify | `skills/email-reply/handler.ts` | Use `ctx.outboundGateway` instead of `ctx.nylasClient` |
| Modify | `src/channels/email/email-adapter.ts` | Use gateway for outbound sends |
| Modify | `src/dispatch/dispatcher.ts` | Remove filter gate, CEO notification, related config |
| Modify | `src/index.ts` | Wire gateway into bootstrap, simplify dispatcher construction |
| Modify | `tests/unit/dispatch/dispatcher.test.ts` | Update for simplified dispatcher |
| Modify | `tests/unit/dispatch/dispatcher-filter.test.ts` | Move filter tests to gateway tests |

---

### Task 1: Create OutboundGateway with Contact Blocked Check

**Files:**
- Create: `src/skills/outbound-gateway.ts`
- Create: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write failing tests for blocked contact check**

Create `tests/unit/skills/outbound-gateway.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { createLogger } from '../../../src/logger.js';

function createMocks() {
  const logger = createLogger('error');

  const nylasClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
    getMessage: vi.fn().mockResolvedValue({
      id: 'orig-1',
      from: [{ email: 'sender@example.com' }],
      subject: 'Test Subject',
    }),
    listMessages: vi.fn().mockResolvedValue([]),
  } as unknown as NylasClient;

  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService;

  const contentFilter = {
    check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
  } as unknown as OutboundContentFilter;

  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as EventBus;

  return { logger, nylasClient, contactService, contentFilter, bus };
}

describe('OutboundGateway', () => {
  describe('contact blocked check', () => {
    it('rejects sends to blocked contacts', async () => {
      const mocks = createMocks();
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ contactId: 'c-1', status: 'blocked' });

      const gateway = new OutboundGateway({
        nylasClient: mocks.nylasClient,
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send({
        channel: 'email',
        to: 'blocked@example.com',
        subject: 'Test',
        body: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.blockedReason).toContain('blocked');
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
      expect(mocks.contentFilter.check).not.toHaveBeenCalled();
    });

    it('allows sends to non-blocked contacts', async () => {
      const mocks = createMocks();
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ contactId: 'c-1', status: 'confirmed' });

      const gateway = new OutboundGateway({
        nylasClient: mocks.nylasClient,
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send({
        channel: 'email',
        to: 'alice@example.com',
        subject: 'Test',
        body: 'Hello',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-123');
    });

    it('allows sends when contact does not exist yet', async () => {
      const mocks = createMocks();
      // resolveByChannelIdentity returns null for unknown contacts

      const gateway = new OutboundGateway({
        nylasClient: mocks.nylasClient,
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send({
        channel: 'email',
        to: 'new-person@example.com',
        subject: 'Test',
        body: 'Hello',
      });

      expect(result.success).toBe(true);
    });

    it('proceeds when contact resolution fails (does not block on DB errors)', async () => {
      const mocks = createMocks();
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('DB connection failed'));

      const gateway = new OutboundGateway({
        nylasClient: mocks.nylasClient,
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send({
        channel: 'email',
        to: 'someone@example.com',
        subject: 'Test',
        body: 'Hello',
      });

      // Should proceed despite resolution failure
      expect(result.success).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/skills/outbound-gateway.test.ts`
Expected: FAIL — `OutboundGateway` does not exist

- [ ] **Step 3: Implement OutboundGateway with blocked check and channel dispatch**

Create `src/skills/outbound-gateway.ts`:

```typescript
// outbound-gateway.ts — single point of outbound external communication.
//
// All outbound messages (email, future Signal/Telegram) pass through this
// gateway. It enforces security policy (blocked contacts, content filter)
// before dispatching to the appropriate channel client.
//
// Skills receive this gateway via their SkillContext instead of raw channel
// clients. The email adapter also routes through it. This ensures no code
// path can bypass security checks.

import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { NylasClient, NylasMessage } from '../channels/email/nylas-client.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import { createOutboundBlocked } from '../bus/events.js';

export interface OutboundSendRequest {
  channel: 'email';
  to: string;
  subject?: string;
  body: string;
  cc?: string[];
  replyToMessageId?: string;
}

export interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  blockedReason?: string;
}

export interface OutboundGatewayConfig {
  nylasClient: NylasClient;
  contactService: ContactService;
  contentFilter: OutboundContentFilter;
  bus: EventBus;
  ceoEmail: string;
  logger: Logger;
}

export class OutboundGateway {
  private nylasClient: NylasClient;
  private contactService: ContactService;
  private contentFilter: OutboundContentFilter;
  private bus: EventBus;
  private ceoEmail: string;
  private logger: Logger;

  constructor(config: OutboundGatewayConfig) {
    this.nylasClient = config.nylasClient;
    this.contactService = config.contactService;
    this.contentFilter = config.contentFilter;
    this.bus = config.bus;
    this.ceoEmail = config.ceoEmail;
    this.logger = config.logger.child({ component: 'outbound-gateway' });
  }

  /**
   * Send an outbound message through the security pipeline.
   *
   * Pipeline:
   * 1. Contact blocked check — reject if recipient is blocked
   * 2. Content filter — reject if content triggers filter rules
   * 3. Channel dispatch — send via the appropriate channel client
   */
  async send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    // Step 1: Contact blocked check
    // Resolve the recipient and check if they're blocked.
    // If resolution fails (DB error), proceed — do not block on infra failures.
    // If contact doesn't exist, proceed — new recipients are allowed.
    try {
      const resolved = await this.contactService.resolveByChannelIdentity(
        request.channel,
        request.to,
      );
      if (resolved && resolved.status === 'blocked') {
        this.logger.warn(
          { channel: request.channel, to: request.to },
          'Outbound send rejected — recipient is blocked',
        );
        return { success: false, blockedReason: 'Recipient is blocked' };
      }
    } catch (err) {
      // Contact resolution failure — log and proceed.
      // The recipient may not have a contact record (new address).
      // Blocking on DB errors would be a denial-of-service on email.
      this.logger.warn(
        { err, channel: request.channel, to: request.to },
        'Contact resolution failed during outbound send — proceeding',
      );
    }

    // Step 2: Content filter (added in Task 2)

    // Step 3: Channel dispatch
    return this.dispatchEmail(request);
  }

  /**
   * Fetch a single email message by ID. Used by email-reply to get the
   * original message for thread resolution (sender address, subject line).
   * This is a read-only operation that doesn't need filtering.
   */
  async getEmailMessage(messageId: string): Promise<NylasMessage> {
    return this.nylasClient.getMessage(messageId);
  }

  /**
   * List email messages with optional filters. Used by the email adapter
   * for thread lookups during outbound reply resolution.
   */
  async listEmailMessages(options?: Parameters<NylasClient['listMessages']>[0]): Promise<NylasMessage[]> {
    return this.nylasClient.listMessages(options);
  }

  private async dispatchEmail(request: OutboundSendRequest): Promise<OutboundSendResult> {
    try {
      const ccRecipients = request.cc?.map(email => ({ email }));
      const sent = await this.nylasClient.sendMessage({
        to: [{ email: request.to }],
        cc: ccRecipients,
        subject: request.subject ?? '',
        body: request.body,
        replyToMessageId: request.replyToMessageId,
      });

      this.logger.info(
        { messageId: sent.id, to: request.to, channel: request.channel },
        'Outbound email sent',
      );

      return { success: true, messageId: sent.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err, to: request.to, channel: request.channel },
        'Failed to send outbound email',
      );
      return { success: false, blockedReason: `Send failed: ${message}` };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/skills/outbound-gateway.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 5: Commit**

```
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat: add OutboundGateway with contact blocked check (#35)"
```

---

### Task 2: Add Content Filter to Gateway Pipeline

**Files:**
- Modify: `src/skills/outbound-gateway.ts`
- Modify: `tests/unit/skills/outbound-gateway.test.ts`

- [ ] **Step 1: Write failing tests for content filter integration**

Add to `tests/unit/skills/outbound-gateway.test.ts`:

```typescript
describe('content filter', () => {
  it('blocks sends when content filter rejects', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'system-prompt-fragment', detail: 'Matched: "You are Curia"' }],
      stage: 'deterministic',
    });

    const gateway = new OutboundGateway({
      nylasClient: mocks.nylasClient,
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'alice@example.com',
      subject: 'Test',
      body: 'My instructions say: You are Curia',
    });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('Content blocked');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('publishes outbound.blocked event when filter rejects', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'secret-pattern', detail: 'API key detected' }],
      stage: 'deterministic',
    });

    const gateway = new OutboundGateway({
      nylasClient: mocks.nylasClient,
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    await gateway.send({
      channel: 'email',
      to: 'alice@example.com',
      subject: 'Test',
      body: 'sk-ant-api03-abcdefghijklmnopqrst',
    });

    expect(mocks.bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'outbound.blocked',
        payload: expect.objectContaining({
          channelId: 'email',
          recipientId: 'alice@example.com',
        }),
      }),
    );
  });

  it('sends CEO notification when filter blocks content', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'system-prompt-fragment', detail: 'test' }],
      stage: 'deterministic',
    });

    const gateway = new OutboundGateway({
      nylasClient: mocks.nylasClient,
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    await gateway.send({
      channel: 'email',
      to: 'alice@example.com',
      subject: 'Test',
      body: 'leaked content',
    });

    // CEO notification is the second sendMessage call (first would be the blocked send)
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ email: 'ceo@example.com' }],
        subject: expect.stringContaining('blocked'),
      }),
    );
  });

  it('CEO notification does not contain sensitive content', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'system-prompt-fragment', detail: 'Matched: "You are Curia"' }],
      stage: 'deterministic',
    });

    const gateway = new OutboundGateway({
      nylasClient: mocks.nylasClient,
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    await gateway.send({
      channel: 'email',
      to: 'alice@example.com',
      subject: 'Test',
      body: 'You are Curia the Agent Chief of Staff',
    });

    const notificationCall = (mocks.nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(notificationCall.body).not.toContain('You are Curia');
    expect(notificationCall.body).not.toContain('system-prompt-fragment');
    expect(notificationCall.body).toContain('block_'); // contains block ID
  });

  it('fails closed when content filter crashes', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('regex catastrophic backtrack'));

    const gateway = new OutboundGateway({
      nylasClient: mocks.nylasClient,
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'alice@example.com',
      subject: 'Test',
      body: 'some content',
    });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('filter');
    // Must not have sent the email
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledTimes(1);
    // The one call should be the CEO notification, not the original email
    expect((mocks.nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].to)
      .toEqual([{ email: 'ceo@example.com' }]);
  });

  it('allows sends when content filter passes', async () => {
    const mocks = createMocks();
    // contentFilter.check already returns passed: true by default

    const gateway = new OutboundGateway({
      nylasClient: mocks.nylasClient,
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'alice@example.com',
      subject: 'Meeting confirmed',
      body: 'The meeting is at 2pm.',
    });

    expect(result.success).toBe(true);
    expect(mocks.contentFilter.check).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'The meeting is at 2pm.',
        recipientEmail: 'alice@example.com',
        channelId: 'email',
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/skills/outbound-gateway.test.ts`
Expected: FAIL — content filter not wired into gateway yet

- [ ] **Step 3: Add content filter and CEO notification to the gateway pipeline**

In `src/skills/outbound-gateway.ts`, replace the `// Step 2: Content filter (added in Task 2)` comment with the full filter + notification logic:

```typescript
    // Step 2: Content filter
    // Fail-closed: if the filter crashes, block the message.
    let filterResult;
    try {
      filterResult = await this.contentFilter.check({
        content: request.body,
        recipientEmail: request.to,
        conversationId: '',
        channelId: request.channel,
      });
    } catch (filterErr) {
      this.logger.error(
        { err: filterErr, channel: request.channel, to: request.to },
        'Outbound content filter crashed — blocking message (fail-closed)',
      );
      filterResult = {
        passed: false,
        findings: [{ rule: 'filter-error', detail: `Filter threw: ${filterErr instanceof Error ? filterErr.message : String(filterErr)}` }],
      };
    }

    if (!filterResult.passed) {
      const reason = filterResult.findings
        .map(f => `${f.rule}: ${f.detail}`)
        .join('; ');

      const ruleNames = filterResult.findings.map(f => f.rule).join(', ');
      this.logger.warn(
        { channel: request.channel, to: request.to, rules: ruleNames, findingCount: filterResult.findings.length },
        'Outbound content blocked by filter',
      );

      const blockId = `block_${randomUUID()}`;

      // Publish outbound.blocked event for audit logging
      try {
        await this.bus.publish('dispatch', createOutboundBlocked({
          blockId,
          conversationId: '',
          channelId: request.channel,
          content: request.body,
          recipientId: request.to,
          reason,
          findings: filterResult.findings,
          parentEventId: `gateway_${randomUUID()}`,
        }));
      } catch (publishErr) {
        this.logger.error(
          { err: publishErr, blockId },
          'Failed to publish outbound.blocked event — block is still enforced',
        );
      }

      // Send opaque CEO notification email.
      // This calls dispatchEmail directly (skipping the filter) because:
      // 1. The notification is a fixed template with no sensitive content
      // 2. Running the filter on the notification would create infinite recursion
      // The only dynamic values are a UUID blockId and a recipient email address.
      try {
        await this.dispatchEmail({
          channel: 'email',
          to: this.ceoEmail,
          subject: 'Action needed — blocked outbound reply',
          body: [
            'An outbound email was blocked by the content filter.',
            '',
            `Intended recipient: ${request.to}`,
            `Block reference: ${blockId}`,
            '',
            'Please review this blocked message via CLI or web app using the reference above.',
          ].join('\n'),
        });
      } catch (notifyErr) {
        this.logger.error(
          { err: notifyErr, blockId },
          'Failed to send CEO notification for blocked outbound content',
        );
      }

      return { success: false, blockedReason: 'Content blocked by filter' };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/skills/outbound-gateway.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```
git add src/skills/outbound-gateway.ts tests/unit/skills/outbound-gateway.test.ts
git commit -m "feat: add content filter and CEO notification to OutboundGateway (#35)"
```

---

### Task 3: Add Gateway to SkillContext and Execution Layer

**Files:**
- Modify: `src/skills/types.ts:54-55` (replace `nylasClient` with `outboundGateway`)
- Modify: `src/skills/execution.ts:22,31,34,40,106-110` (replace nylasClient with gateway)

- [ ] **Step 1: Update SkillContext interface**

In `src/skills/types.ts`, replace the nylasClient field:

Change line 54-55 from:
```typescript
  /** Nylas email client — only available to infrastructure skills */
  nylasClient?: import('../channels/email/nylas-client.js').NylasClient;
```
To:
```typescript
  /** Outbound gateway — only available to infrastructure skills. All external
   *  communication (email, future Signal/Telegram) goes through the gateway,
   *  which enforces contact blocked checks and content filtering. */
  outboundGateway?: import('./outbound-gateway.js').OutboundGateway;
```

- [ ] **Step 2: Update ExecutionLayer**

In `src/skills/execution.ts`:

Replace the NylasClient import (line 22):
```typescript
import type { NylasClient } from '../channels/email/nylas-client.js';
```
With:
```typescript
import type { OutboundGateway } from './outbound-gateway.js';
```

Replace the private field (line 31):
```typescript
  private nylasClient?: NylasClient;
```
With:
```typescript
  private outboundGateway?: OutboundGateway;
```

Update the constructor options type (line 34): replace `nylasClient?: NylasClient` with `outboundGateway?: OutboundGateway`.

Update the constructor assignment (line 40): replace `this.nylasClient = options?.nylasClient;` with `this.outboundGateway = options?.outboundGateway;`.

Update the infrastructure skill context injection (lines 106-110). Replace:
```typescript
      // nylasClient is optional — only email skills need it, so we inject it
      // when available but don't gate on it (other infra skills don't need it)
      if (this.nylasClient) {
        ctx.nylasClient = this.nylasClient;
      }
```
With:
```typescript
      // outboundGateway is optional — only skills that send external messages need it.
      // All outbound communication goes through the gateway, which enforces contact
      // blocked checks and content filtering before dispatch.
      if (this.outboundGateway) {
        ctx.outboundGateway = this.outboundGateway;
      }
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Type errors in email skill handlers (they still reference `ctx.nylasClient`). This is expected — we fix them in Task 4.

- [ ] **Step 4: Commit**

```
git add src/skills/types.ts src/skills/execution.ts
git commit -m "feat: replace nylasClient with outboundGateway in SkillContext and ExecutionLayer (#35)"
```

---

### Task 4: Refactor Email Skills to Use Gateway

**Files:**
- Modify: `skills/email-send/handler.ts`
- Modify: `skills/email-reply/handler.ts`

- [ ] **Step 1: Refactor email-send handler**

Replace the full content of `skills/email-send/handler.ts`:

```typescript
// handler.ts — email-send skill implementation.
//
// Sends a new email via the OutboundGateway. The gateway enforces contact
// blocked checks and content filtering before dispatch — this handler
// focuses on input validation and formatting.
//
// sensitivity: "elevated" — enforced by the gateway's security pipeline.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Input length limits — prevent oversized payloads reaching the email API
const MAX_TO_LENGTH = 1000;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 50000;

// Minimal RFC-5321-style check: requires at least one non-whitespace/@ char on
// each side of @ and a dot in the domain. Rejects plain strings, IP-only domains
// that lack a dot, and values with embedded spaces.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse a comma-separated list of email addresses into individual strings.
 * Trims whitespace from each address. Skips empty segments (e.g., trailing comma).
 * Throws if any segment fails the basic email format check.
 */
function parseRecipients(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((email) => {
      if (!EMAIL_REGEX.test(email)) {
        throw new Error(`Invalid email address: ${email}`);
      }
      return email;
    });
}

export class EmailSendHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { to, cc, subject, body } = ctx.input as {
      to?: string;
      cc?: string;
      subject?: string;
      body?: string;
    };

    // Validate required inputs
    if (!to || typeof to !== 'string') {
      return { success: false, error: 'Missing required input: to (string)' };
    }
    if (!subject || typeof subject !== 'string') {
      return { success: false, error: 'Missing required input: subject (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    // Length limits
    if (to.length > MAX_TO_LENGTH) {
      return { success: false, error: `to must be ${MAX_TO_LENGTH} characters or fewer` };
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      return { success: false, error: `subject must be ${MAX_SUBJECT_LENGTH} characters or fewer` };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    // Parse recipients
    let toAddresses: string[];
    try {
      toAddresses = parseRecipients(to);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
    if (toAddresses.length === 0) {
      return { success: false, error: 'to field contains no valid email addresses' };
    }

    // cc length check
    if (cc && cc.length > MAX_TO_LENGTH) {
      return { success: false, error: `cc must be ${MAX_TO_LENGTH} characters or fewer` };
    }

    // Parse optional cc
    let ccAddresses: string[] | undefined;
    try {
      ccAddresses = cc && typeof cc === 'string' ? parseRecipients(cc) : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-send skill requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }

    ctx.log.info(
      { to: toAddresses, subject },
      'Sending email via gateway',
    );

    // Send each recipient through the gateway individually.
    // The gateway checks each recipient against the blocked list and content filter.
    // For simplicity, we send to the first recipient with CC on the same message.
    const result = await ctx.outboundGateway.send({
      channel: 'email',
      to: toAddresses[0]!,
      subject,
      body,
      cc: ccAddresses,
    });

    if (!result.success) {
      return { success: false, error: result.blockedReason ?? 'Email send failed' };
    }

    return {
      success: true,
      data: {
        message_id: result.messageId,
        to: toAddresses.join(', '),
        subject,
      },
    };
  }
}
```

- [ ] **Step 2: Refactor email-reply handler**

Replace the full content of `skills/email-reply/handler.ts`:

```typescript
// handler.ts — email-reply skill implementation.
//
// Replies to an existing email thread via the OutboundGateway. The gateway
// enforces contact blocked checks and content filtering before dispatch.
// This handler focuses on thread resolution (fetching the original message
// to extract the sender address and subject line).
//
// sensitivity: "elevated" — enforced by the gateway's security pipeline.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Input length limit — prevent oversized payloads reaching the email API
const MAX_BODY_LENGTH = 50000;

export class EmailReplyHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { reply_to_message_id: replyToMessageId, body } = ctx.input as {
      reply_to_message_id?: string;
      body?: string;
    };

    // Validate required inputs
    if (!replyToMessageId || typeof replyToMessageId !== 'string') {
      return { success: false, error: 'Missing required input: reply_to_message_id (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    // Length limit
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-reply skill requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }

    ctx.log.info({ replyToMessageId }, 'Replying to email via gateway');

    try {
      // Fetch the original message to get the sender and subject for threading
      const original = await ctx.outboundGateway.getEmailMessage(replyToMessageId);

      // Extract the original sender's email — this is who we're replying to
      const originalFrom = original.from[0]?.email;
      if (!originalFrom) {
        return {
          success: false,
          error: `Original message ${replyToMessageId} has no sender address — cannot reply`,
        };
      }

      // Strip any existing "Re:" prefix (case-insensitive) before prepending our own,
      // so we never produce "Re: Re: Re: ..." subject lines.
      const baseSubject = original.subject.replace(/^Re:\s*/i, '');
      const replySubject = `Re: ${baseSubject}`;

      const result = await ctx.outboundGateway.send({
        channel: 'email',
        to: originalFrom,
        subject: replySubject,
        body,
        replyToMessageId,
      });

      if (!result.success) {
        return { success: false, error: result.blockedReason ?? 'Email reply failed' };
      }

      ctx.log.info(
        { messageId: result.messageId, to: originalFrom, subject: replySubject },
        'Email reply sent successfully',
      );

      return {
        success: true,
        data: {
          message_id: result.messageId,
          to: originalFrom,
          subject: replySubject,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, replyToMessageId }, 'Failed to reply to email');
      return { success: false, error: `Failed to reply to email: ${message}` };
    }
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean (email skills now use `ctx.outboundGateway`, type matches `SkillContext`)

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: Some existing tests may fail if they mock `ctx.nylasClient` — note failures for Task 7.

- [ ] **Step 5: Commit**

```
git add skills/email-send/handler.ts skills/email-reply/handler.ts
git commit -m "feat: refactor email skills to use OutboundGateway (#35)"
```

---

### Task 5: Refactor Email Adapter to Use Gateway

**Files:**
- Modify: `src/channels/email/email-adapter.ts:9,15-23,31,160-201`

- [ ] **Step 1: Update EmailAdapter to use gateway**

In `src/channels/email/email-adapter.ts`:

Replace the NylasClient import and config references with OutboundGateway.

Change the import (line 9):
```typescript
import type { NylasClient } from './nylas-client.js';
```
To:
```typescript
import type { OutboundGateway } from '../../skills/outbound-gateway.js';
```

Update `EmailAdapterConfig` (lines 15-23). Replace `nylasClient: NylasClient` with `outboundGateway: OutboundGateway`:

```typescript
export interface EmailAdapterConfig {
  bus: EventBus;
  logger: Logger;
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  pollingIntervalMs: number;
  selfEmail: string;
}
```

In the `poll()` method, the adapter uses `nylasClient.listMessages()` for inbound polling. This needs to use the gateway's `listEmailMessages()` method instead. Update line 83:
```typescript
messages = await this.config.outboundGateway.listEmailMessages({
```

Replace `sendOutboundReply()` (lines 160-201) to use the gateway:

```typescript
  private async sendOutboundReply(outbound: OutboundMessageEvent): Promise<void> {
    const { outboundGateway, logger } = this.config;
    const conversationId = outbound.payload.conversationId;

    if (!conversationId.startsWith('email:')) {
      logger.warn({ conversationId }, 'Cannot send email reply — conversation ID not in email format');
      return;
    }
    const threadId = conversationId.slice('email:'.length);

    try {
      const messages = await outboundGateway.listEmailMessages({ limit: 1, threadId });
      const threadMessage = messages[0];
      if (!threadMessage) {
        logger.warn({ threadId }, 'Cannot find message to reply to in thread');
        return;
      }

      const fromEmail = threadMessage.from[0]?.email;
      if (!fromEmail) {
        logger.warn({ threadId, messageId: threadMessage.id }, 'Cannot reply — original message has no from address');
        return;
      }

      const baseSubject = threadMessage.subject.replace(/^Re:\s*/i, '');

      // Route through the gateway — this enforces blocked check + content filter
      const result = await outboundGateway.send({
        channel: 'email',
        to: fromEmail,
        subject: `Re: ${baseSubject}`,
        body: outbound.payload.content,
        replyToMessageId: threadMessage.id,
      });

      if (result.success) {
        logger.info({ to: fromEmail, threadId }, 'Email reply sent via gateway');
      } else {
        logger.warn({ to: fromEmail, threadId, reason: result.blockedReason }, 'Email reply blocked by gateway');
      }
    } catch (err) {
      logger.error({ err, threadId }, 'Failed to send email reply');
    }
  }
```

Also update `extractParticipants` and `poll` — anywhere `this.config.nylasClient` is used, replace with `this.config.outboundGateway` for reads, or keep the same pattern using the gateway's list/get methods.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```
git add src/channels/email/email-adapter.ts
git commit -m "feat: refactor EmailAdapter to use OutboundGateway (#35)"
```

---

### Task 6: Simplify Dispatcher (Remove Filter Gate)

**Files:**
- Modify: `src/dispatch/dispatcher.ts`

- [ ] **Step 1: Remove filter-related code from dispatcher**

In `src/dispatch/dispatcher.ts`:

Remove these imports:
- `import { randomUUID } from 'node:crypto';`
- `import { createOutboundBlocked } from '../bus/events.js';`
- `import type { OutboundContentFilter } from './outbound-filter.js';`

Remove from `DispatcherConfig`:
- `outboundFilter?: OutboundContentFilter;`
- `externalChannels?: Set<string>;`
- `ceoNotification?: { nylasClient: ...; ceoEmail: string; };`

Remove private fields:
- `private outboundFilter?: OutboundContentFilter;`
- `private externalChannels: Set<string>;`
- `private ceoNotification?: DispatcherConfig['ceoNotification'];`

Remove from constructor:
- `this.outboundFilter = config.outboundFilter;`
- `this.externalChannels = config.externalChannels ?? new Set();`
- `this.ceoNotification = config.ceoNotification;`
- The three misconfiguration warnings (`if (this.externalChannels.size > 0 && ...)`)

Replace `handleAgentResponse` with the simplified version (no filter, no notification):

```typescript
  private async handleAgentResponse(event: AgentResponseEvent): Promise<void> {
    const routing = event.parentEventId
      ? this.taskRouting.get(event.parentEventId)
      : undefined;

    if (!routing) {
      this.logger.warn(
        { parentEventId: event.parentEventId },
        'No routing info for agent response — cannot deliver',
      );
      return;
    }

    this.taskRouting.delete(event.parentEventId!);

    const outbound = createOutboundMessage({
      conversationId: routing.conversationId,
      channelId: routing.channelId,
      content: event.payload.content,
      parentEventId: event.id,
    });
    await this.bus.publish('dispatch', outbound);
  }
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```
git add src/dispatch/dispatcher.ts
git commit -m "refactor: remove filter gate from Dispatcher — now handled by OutboundGateway (#35)"
```

---

### Task 7: Update Bootstrap Wiring

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Wire OutboundGateway into bootstrap**

In `src/index.ts`:

Add import:
```typescript
import { OutboundGateway } from './skills/outbound-gateway.js';
```

After the outbound filter is constructed (around line 302), create the gateway:

```typescript
  // Outbound gateway — single point for all external communication.
  // Skills and the email adapter send through the gateway, which enforces
  // contact blocked checks and content filtering before dispatch.
  let outboundGateway: OutboundGateway | undefined;
  if (nylasClient && outboundFilter) {
    outboundGateway = new OutboundGateway({
      nylasClient,
      contactService,
      contentFilter: outboundFilter,
      bus,
      ceoEmail: config.nylasSelfEmail ?? '',
      logger,
    });
    logger.info('Outbound gateway initialized');
  } else {
    logger.warn('Outbound gateway not initialized — email sending will not be available');
  }
```

Update the `ExecutionLayer` constructor (line 180) to pass gateway instead of nylasClient:
```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages });
```

Update the `EmailAdapter` constructor to pass gateway instead of nylasClient:
```typescript
      emailAdapter = new EmailAdapter({
        bus,
        logger,
        outboundGateway: outboundGateway!,
        contactService,
        pollingIntervalMs: config.nylasPollingIntervalMs,
        selfEmail: config.nylasSelfEmail,
      });
```

Simplify the `Dispatcher` construction — remove `outboundFilter`, `externalChannels`, `ceoNotification`:
```typescript
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver,
    heldMessages,
    channelPolicies: authConfig?.channelPolicies,
  });
```

Remove the `OutboundContentFilter` import if it's no longer used directly in index.ts (it's used by the gateway now, but the construction still happens in index.ts, so keep it).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: May have test failures from the dispatcher filter tests — addressed in Task 8.

- [ ] **Step 4: Commit**

```
git add src/index.ts
git commit -m "feat: wire OutboundGateway into bootstrap, simplify Dispatcher construction (#35)"
```

---

### Task 8: Update Existing Tests

**Files:**
- Modify: `tests/unit/dispatch/dispatcher.test.ts`
- Delete or heavily modify: `tests/unit/dispatch/dispatcher-filter.test.ts`

- [ ] **Step 1: Update dispatcher test**

The existing `tests/unit/dispatch/dispatcher.test.ts` creates a `Dispatcher` with no filter config — this should still work since we removed the filter from the dispatcher. Verify it passes as-is.

Run: `npx vitest run tests/unit/dispatch/dispatcher.test.ts`
Expected: PASS (no changes needed — the simplified dispatcher is backwards-compatible)

- [ ] **Step 2: Remove or repurpose dispatcher-filter tests**

The tests in `tests/unit/dispatch/dispatcher-filter.test.ts` test the filter gate that was in the dispatcher. This logic now lives in the gateway. Since the gateway already has its own comprehensive tests (Tasks 1-2), remove the dispatcher filter test file:

```
git rm tests/unit/dispatch/dispatcher-filter.test.ts
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "test: update tests for dispatcher simplification, remove dispatcher-filter tests (#35)"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Run linter**

Run: `npx eslint src/skills/outbound-gateway.ts src/skills/types.ts src/skills/execution.ts src/dispatch/dispatcher.ts src/channels/email/email-adapter.ts src/index.ts skills/email-send/handler.ts skills/email-reply/handler.ts`
Expected: No lint errors

- [ ] **Step 4: Verify no direct nylasClient.sendMessage calls remain outside the gateway**

Run: `grep -r 'nylasClient.sendMessage\|nylasClient\.send' src/ skills/ --include='*.ts' | grep -v 'outbound-gateway.ts' | grep -v '.test.' | grep -v 'nylas-client.ts'`
Expected: No matches — all send calls should be in the gateway or the NylasClient itself.

- [ ] **Step 5: Verify SECURITY TODOs are removed**

Run: `grep -r 'SECURITY TODO' skills/ --include='*.ts'`
Expected: No matches — both email skill handlers should have had their SECURITY TODOs removed.

- [ ] **Step 6: Review commit log**

Run: `git log --oneline feat/outbound-gateway ^main`
Expected: 8-9 commits covering spec, gateway, context, skills, adapter, dispatcher, bootstrap, tests.
