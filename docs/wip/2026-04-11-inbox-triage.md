# Inbox Triage — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the observation-mode "summarise everything" directive with a 4-way email triage protocol (URGENT / ACTIONABLE / NEEDS DRAFT / NOISE), backed by a new `email-archive` skill for the NOISE path.

**Architecture:** Three layers of change: (1) `NylasClient.archiveMessage()` → `OutboundGateway.archiveEmailMessage()` → `EmailArchiveHandler` (same infrastructure skill pattern as `email-reply`); (2) the dispatcher observation-mode preamble gains the Nylas message ID, account ID, and the triage protocol text; (3) `coordinator.yaml` is updated to pin the skill and replace the "Observation Mode" section with triage-aware guidance.

**Tech Stack:** TypeScript ESM, Nylas SDK v8 (existing), Vitest, existing `OutboundGateway` / `NylasClient` pattern.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/channels/email/nylas-client.ts` | Add `update` to `NylasLike`, add `archiveMessage(messageId)` |
| Modify | `src/skills/outbound-gateway.ts` | Add public `archiveEmailMessage(messageId, accountId?)` |
| Create | `skills/email-archive/skill.json` | Skill manifest |
| Create | `skills/email-archive/handler.ts` | Skill handler — delegates to `ctx.outboundGateway.archiveEmailMessage` |
| Create | `tests/unit/channels/email/nylas-client-archive.test.ts` | NylasClient archive unit tests |
| Create | `tests/unit/dispatch/outbound-gateway-archive.test.ts` | Gateway archive unit tests |
| Create | `tests/unit/skills/email-archive.test.ts` | Handler unit tests |
| Modify | `src/dispatch/dispatcher.ts` | Replace old preamble with 4-way triage preamble (includes messageId + accountId) |
| Modify | `tests/unit/dispatch/dispatcher.test.ts` | Update preamble assertions to match new text |
| Modify | `agents/coordinator.yaml` | Pin `email-archive`; rewrite "Observation Mode" section |
| Modify | `CHANGELOG.md` | Add entry, bump to `0.17.10` |
| Modify | `package.json` | Bump version to `0.17.10` |

---

### Task 1: Add `archiveMessage` to `NylasClient`

**Files:**
- Modify: `src/channels/email/nylas-client.ts`
- Create: `tests/unit/channels/email/nylas-client-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/channels/email/nylas-client-archive.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the nylas module BEFORE importing NylasClient (vitest hoists vi.mock)
const mockMessages = {
  list: vi.fn(),
  find: vi.fn(),
  send: vi.fn(),
  update: vi.fn(),
};
const mockDrafts = { create: vi.fn() };

vi.mock('nylas', () => ({
  default: vi.fn(() => ({ messages: mockMessages, drafts: mockDrafts })),
}));

import { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

/** Minimal NylasSdkMessage-like object for mocking Nylas responses. */
function mockMsg(overrides: { folders?: string[] } = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Test subject',
    from: [{ name: 'Sender', email: 'sender@example.com' }],
    to: [{ email: 'ceo@example.com' }],
    cc: [],
    bcc: [],
    body: 'Body text',
    snippet: 'Body text',
    date: 1744000000,
    unread: true,
    starred: false,
    folders: overrides.folders ?? ['INBOX', 'IMPORTANT'],
    headers: undefined,
  };
}

describe('NylasClient.archiveMessage', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('test-api-key', 'test-grant-id', logger);
  });

  it('fetches the message then updates folders with INBOX removed', async () => {
    mockMessages.find.mockResolvedValue({ data: mockMsg({ folders: ['INBOX', 'IMPORTANT'] }) });
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: ['IMPORTANT'] }) });

    await client.archiveMessage('msg-1');

    expect(mockMessages.find).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
    });
    expect(mockMessages.update).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
      requestBody: { folders: ['IMPORTANT'] },
    });
  });

  it('archives a message that is only in INBOX (resulting in empty folder list)', async () => {
    mockMessages.find.mockResolvedValue({ data: mockMsg({ folders: ['INBOX'] }) });
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: [] }) });

    await client.archiveMessage('msg-1');

    expect(mockMessages.update).toHaveBeenCalledWith({
      identifier: 'test-grant-id',
      messageId: 'msg-1',
      requestBody: { folders: [] },
    });
  });

  it('preserves case of non-INBOX folder labels', async () => {
    // Nylas returns folder IDs that may be uppercase, mixed, or provider-specific strings.
    // We filter by uppercased comparison but preserve the original strings in the update.
    mockMessages.find.mockResolvedValue({ data: mockMsg({ folders: ['INBOX', 'Label_123', 'STARRED'] }) });
    mockMessages.update.mockResolvedValue({ data: mockMsg({ folders: ['Label_123', 'STARRED'] }) });

    await client.archiveMessage('msg-1');

    expect(mockMessages.update).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: { folders: ['Label_123', 'STARRED'] },
      }),
    );
  });

  it('throws if the Nylas find call fails (no update attempted)', async () => {
    mockMessages.find.mockRejectedValue(new Error('Nylas API 404'));

    await expect(client.archiveMessage('msg-1')).rejects.toThrow('Nylas API 404');
    expect(mockMessages.update).not.toHaveBeenCalled();
  });

  it('throws if the Nylas update call fails', async () => {
    mockMessages.find.mockResolvedValue({ data: mockMsg() });
    mockMessages.update.mockRejectedValue(new Error('Nylas API 500'));

    await expect(client.archiveMessage('msg-1')).rejects.toThrow('Nylas API 500');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix /path/to/worktree test tests/unit/channels/email/nylas-client-archive.test.ts
```

Expected: FAIL — `archiveMessage` not defined on `NylasClient`.

- [ ] **Step 3: Add `update` to `NylasLike` and implement `archiveMessage` in `NylasClient`**

In `src/channels/email/nylas-client.ts`, extend the `NylasLike` interface to declare `messages.update`:

```typescript
interface NylasLike {
  messages: {
    list(params: {
      identifier: string;
      queryParams?: ListMessagesQueryParams;
    }): Promise<NylasListResponse<NylasSdkMessage>>;

    find(params: {
      identifier: string;
      messageId: string;
    }): Promise<NylasResponse<NylasSdkMessage>>;

    send(params: {
      identifier: string;
      requestBody: SendMessageRequest;
    }): Promise<NylasResponse<NylasSdkMessage>>;

    /**
     * Update message properties (folders, starred, unread).
     * Used by archiveMessage() to remove the INBOX label.
     */
    update(params: {
      identifier: string;
      messageId: string;
      requestBody: { folders?: string[]; starred?: boolean; unread?: boolean };
    }): Promise<NylasResponse<NylasSdkMessage>>;
  };
  drafts: {
    create(params: {
      identifier: string;
      requestBody: CreateDraftRequest;
    }): Promise<NylasResponse<NylasDraft>>;
  };
}
```

Then add the `archiveMessage` method to `NylasClient` after `createDraft`:

```typescript
/**
 * Archive a message by removing it from the INBOX folder.
 *
 * For Gmail (via Nylas), removing INBOX moves the message to "All Mail" —
 * the standard archive. Other providers remove the INBOX folder equivalently.
 *
 * Two API calls: getMessage (to read current folders) then messages.update
 * (to write back folders without INBOX). The fetch-then-update approach
 * preserves non-INBOX labels (STARRED, IMPORTANT, custom labels) that
 * would be lost if we blindly set folders: [].
 */
async archiveMessage(messageId: string): Promise<void> {
  this.log.debug({ messageId }, 'archiving message');

  try {
    const current = await this.getMessage(messageId);
    // Filter by uppercase so we catch 'inbox', 'Inbox', 'INBOX' consistently
    const updatedFolders = current.folders.filter((f) => f.toUpperCase() !== 'INBOX');

    await this.nylas.messages.update({
      identifier: this.grantId,
      messageId,
      requestBody: { folders: updatedFolders },
    });

    this.log.info({ messageId, updatedFolders }, 'message archived successfully');
  } catch (err) {
    this.log.error({ err, grantId: this.grantId, messageId }, 'Nylas archiveMessage failed');
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm --prefix /path/to/worktree test tests/unit/channels/email/nylas-client-archive.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
npm --prefix /path/to/worktree test
```

Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/channels/email/nylas-client.ts tests/unit/channels/email/nylas-client-archive.test.ts
git -C /path/to/worktree commit -m "feat: add NylasClient.archiveMessage — removes INBOX label via Nylas update API"
```

---

### Task 2: Add `archiveEmailMessage` to `OutboundGateway`

**Files:**
- Modify: `src/skills/outbound-gateway.ts`
- Create: `tests/unit/dispatch/outbound-gateway-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dispatch/outbound-gateway-archive.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import { EventBus } from '../../../../src/bus/bus.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

/** Build a gateway with the given NylasClient map (all other deps are stubs). */
function makeGateway(nylasClients: Map<string, NylasClient>): OutboundGateway {
  const bus = new EventBus(logger);
  return new OutboundGateway({
    nylasClients,
    contactService: {} as ContactService,
    contentFilter: { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as never,
    bus,
    logger,
  });
}

function makeMockNylasClient(): NylasClient {
  return {
    archiveMessage: vi.fn().mockResolvedValue(undefined),
    getMessage: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    createDraft: vi.fn(),
  } as unknown as NylasClient;
}

describe('OutboundGateway.archiveEmailMessage', () => {
  it('calls archiveMessage on the correct account client', async () => {
    const mockClient = makeMockNylasClient();
    const gateway = makeGateway(new Map([['joseph', mockClient]]));

    const result = await gateway.archiveEmailMessage('msg-1', 'joseph');

    expect(result.success).toBe(true);
    expect(mockClient.archiveMessage).toHaveBeenCalledWith('msg-1');
  });

  it('uses the primary client when accountId is omitted', async () => {
    const mockClient = makeMockNylasClient();
    const gateway = makeGateway(new Map([['curia', mockClient]]));

    const result = await gateway.archiveEmailMessage('msg-1');

    expect(result.success).toBe(true);
    expect(mockClient.archiveMessage).toHaveBeenCalledWith('msg-1');
  });

  it('returns failure when the accountId is not found in the map', async () => {
    const gateway = makeGateway(new Map([['curia', makeMockNylasClient()]]));

    const result = await gateway.archiveEmailMessage('msg-1', 'unknown-account');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No email client configured');
  });

  it('returns failure when no clients are configured at all', async () => {
    const gateway = makeGateway(new Map());

    const result = await gateway.archiveEmailMessage('msg-1');

    expect(result.success).toBe(false);
  });

  it('returns failure when archiveMessage throws', async () => {
    const mockClient = makeMockNylasClient();
    (mockClient.archiveMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Nylas 503'));
    const gateway = makeGateway(new Map([['joseph', mockClient]]));

    const result = await gateway.archiveEmailMessage('msg-1', 'joseph');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Archive failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix /path/to/worktree test tests/unit/dispatch/outbound-gateway-archive.test.ts
```

Expected: FAIL — `archiveEmailMessage` not defined on `OutboundGateway`.

- [ ] **Step 3: Add `archiveEmailMessage` to `OutboundGateway`**

In `src/skills/outbound-gateway.ts`, add after the `createEmailDraft` method (before the private helpers section):

```typescript
/**
 * Archive an email message by removing it from the INBOX folder.
 *
 * Routes to the NylasClient for the given accountId (primary account when absent).
 * Does NOT run the content filter or blocked-contact check — archiving is a
 * read-move operation, not an outbound communication.
 *
 * @param messageId  Nylas message ID to archive
 * @param accountId  Named account (e.g. "joseph"). Defaults to the primary account.
 */
async archiveEmailMessage(
  messageId: string,
  accountId?: string,
): Promise<{ success: boolean; error?: string }> {
  const client = this.getNylasClient(accountId);
  if (!client) {
    return {
      success: false,
      error: `No email client configured for account: ${accountId ?? 'primary'}`,
    };
  }

  try {
    await client.archiveMessage(messageId);
    this.log.info({ messageId, accountId }, 'outbound-gateway: message archived');
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.log.error({ err, messageId, accountId }, 'outbound-gateway: archiveEmailMessage failed');
    return { success: false, error: `Archive failed: ${message}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm --prefix /path/to/worktree test tests/unit/dispatch/outbound-gateway-archive.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Run full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/skills/outbound-gateway.ts tests/unit/dispatch/outbound-gateway-archive.test.ts
git -C /path/to/worktree commit -m "feat: add OutboundGateway.archiveEmailMessage — routes archive calls to per-account NylasClient"
```

---

### Task 3: Create `email-archive` skill

**Files:**
- Create: `skills/email-archive/skill.json`
- Create: `skills/email-archive/handler.ts`
- Create: `tests/unit/skills/email-archive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/skills/email-archive.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EmailArchiveHandler } from '../../../skills/email-archive/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return { input, secret: () => { throw new Error('no secrets'); }, log: logger, ...overrides };
}

describe('EmailArchiveHandler', () => {
  const handler = new EmailArchiveHandler();

  it('returns failure when message_id is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when message_id is not a string', async () => {
    const result = await handler.execute(makeCtx({ message_id: 42 }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('archives successfully and returns { archived: true }', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1', account: 'joseph' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as { archived: boolean }).archived).toBe(true);
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', 'joseph');
  });

  it('passes undefined accountId when account is absent', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('passes undefined accountId when account is an empty string', async () => {
    const gateway = { archiveEmailMessage: vi.fn().mockResolvedValue({ success: true }) };
    await handler.execute(
      makeCtx({ message_id: 'msg-1', account: '' }, { outboundGateway: gateway as never }),
    );
    expect(gateway.archiveEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('returns failure when gateway returns an error', async () => {
    const gateway = {
      archiveEmailMessage: vi.fn().mockResolvedValue({ success: false, error: 'Nylas 503' }),
    };
    const result = await handler.execute(
      makeCtx({ message_id: 'msg-1' }, { outboundGateway: gateway as never }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Nylas 503');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm --prefix /path/to/worktree test tests/unit/skills/email-archive.test.ts
```

Expected: FAIL — `skills/email-archive/handler.ts` does not exist.

- [ ] **Step 3: Create `skills/email-archive/skill.json`**

```json
{
  "name": "email-archive",
  "description": "Archive an email by removing it from the inbox. Use for observation-mode emails that need no action — receipts, newsletters, automated notifications. Silently moves the message out of INBOX without notifying the CEO.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "message_id": "string — Nylas message ID of the email to archive",
    "account": "string (optional) — named account to archive from (e.g. 'curia', 'joseph'). Defaults to the primary account if omitted."
  },
  "outputs": {
    "archived": "boolean — true when the message was successfully archived"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

- [ ] **Step 4: Create `skills/email-archive/handler.ts`**

```typescript
// handler.ts — email-archive skill implementation.
//
// Archives an email by removing it from INBOX via the OutboundGateway.
// Used by the coordinator's observation-mode triage flow for emails that need
// no action (receipts, newsletters, automated notifications).
//
// Does NOT run through the outbound content filter — this is a folder-move
// operation, not an outbound communication.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailArchiveHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { message_id: messageId, account } = ctx.input as {
      message_id?: string;
      account?: string;
    };

    if (!messageId || typeof messageId !== 'string') {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error:
          'email-archive skill requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }

    // Treat an empty string as "no account specified" so the gateway uses the primary client.
    const accountId = typeof account === 'string' && account.length > 0 ? account : undefined;

    ctx.log.info({ messageId, accountId }, 'Archiving email');

    const result = await ctx.outboundGateway.archiveEmailMessage(messageId, accountId);

    if (!result.success) {
      ctx.log.error({ messageId, accountId, error: result.error }, 'Failed to archive email');
      return { success: false, error: result.error ?? 'Archive failed' };
    }

    ctx.log.info({ messageId, accountId }, 'Email archived successfully');
    return { success: true, data: { archived: true } };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm --prefix /path/to/worktree test tests/unit/skills/email-archive.test.ts
```

Expected: 7 passing.

- [ ] **Step 6: Run full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all previously-passing tests still pass.

- [ ] **Step 7: Commit**

```bash
git -C /path/to/worktree add skills/email-archive/ tests/unit/skills/email-archive.test.ts
git -C /path/to/worktree commit -m "feat: add email-archive skill — archives observation-mode noise emails via Nylas"
```

---

### Task 4: Replace the observation-mode preamble in `dispatcher.ts`

**Files:**
- Modify: `src/dispatch/dispatcher.ts`
- Modify: `tests/unit/dispatch/dispatcher.test.ts`

The preamble is the `if (isObservationMode)` block that prepends text to `taskContent`. Find it by searching for `[OBSERVATION MODE`.

- [ ] **Step 1: Update the dispatcher preamble**

Find the existing `if (isObservationMode)` block that starts with the comment `// Observation-mode preamble:` and replace the block's body with:

```typescript
if (isObservationMode) {
  // Surface the Nylas message ID and account ID in the preamble so the coordinator
  // can pass them directly to email-archive when classifying the email as NOISE.
  const nylasMessageId = (payload.metadata as Record<string, unknown> | undefined)
    ?.nylasMessageId as string | undefined;
  const obsAccountId = payload.accountId;

  const msgIdLine = nylasMessageId ? `\nNylas message ID (for email-archive): ${nylasMessageId}` : '';
  const accountLine = obsAccountId ? `\nAccount: ${obsAccountId}` : '';

  taskContent =
    `[OBSERVATION MODE — monitored inbox]${accountLine}${msgIdLine}\n` +
    `This email arrived in a monitored inbox. You watch it on the CEO's behalf.\n` +
    `You are NOT the recipient. NEVER reply to the sender as yourself or sign with your name.\n` +
    `\n` +
    `TRIAGE — evaluate in order:\n` +
    `\n` +
    `1. STANDING INSTRUCTIONS: use entity-context to look up the sender. If the CEO has\n` +
    `   given you a standing instruction for this sender or email type, follow it.\n` +
    `\n` +
    `2. CLASSIFY and act:\n` +
    `   - URGENT — time-sensitive, requires CEO decision, from a known contact:\n` +
    `     Send the CEO a message on a high-urgency channel (e.g. Signal): sender,\n` +
    `     subject, one-sentence summary, key ask. Do NOT reply to the sender.\n` +
    `   - ACTIONABLE — calendar booking, add attendee, change location, clear task:\n` +
    `     Do it using your existing skills. No notification. It will appear in the weekly log.\n` +
    `   - NEEDS DRAFT — a reply is warranted and you can write it:\n` +
    `     Save a draft with email-reply. The CEO will review before it sends.\n` +
    `   - NOISE — receipt, newsletter, automated notification, no action needed:\n` +
    `     Call email-archive with the Nylas message ID and account shown above.\n` +
    `     No notification.\n` +
    `\n` +
    `3. WHEN IN DOUBT: default to URGENT (notify) rather than acting silently.\n` +
    `   It is better to surface something than to quietly act on it incorrectly.\n` +
    `\n` +
    `--- Original message ---\n` +
    taskContent;
}
```

- [ ] **Step 2: Update the preamble assertions in `tests/unit/dispatch/dispatcher.test.ts`**

Find the `describe('Dispatcher — observation mode preamble', ...)` block. The existing assertions that no longer match the new text need to be updated. Change:

```typescript
// OLD:
expect(content).toContain('Do NOT sign as yourself');

// NEW:
expect(content).toContain('sign with your name');
```

Also add assertions that cover the new triage keywords:

```typescript
expect(content).toContain('TRIAGE');
expect(content).toContain('URGENT');
expect(content).toContain('NOISE');
expect(content).toContain('email-archive');
```

The assertions `expect(content).toContain('[OBSERVATION MODE')`, `expect(content).toContain('testing if you read this')`, and `expect(content).toContain('Do NOT reply')` all still match and need no changes.

Also add a new test case that verifies the Nylas message ID and account ID appear in the preamble when present in the event metadata:

```typescript
it('includes nylasMessageId and accountId in preamble when present', async () => {
  const logger = createLogger('error');
  const bus = new EventBus(logger);

  const tasks: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'agent', (e) => tasks.push(e as AgentTaskEvent));

  const dispatcher = new Dispatcher({ bus, logger });
  dispatcher.register();

  const event = createInboundMessage({
    conversationId: 'email:thread-obs-2',
    channelId: 'email',
    senderId: 'sender@example.com',
    accountId: 'joseph',
    content: 'test body',
    metadata: { observationMode: true, nylasMessageId: 'nylas-msg-abc123' },
  });

  await bus.publish('channel', event);

  expect(tasks).toHaveLength(1);
  const content = tasks[0]!.payload.content;
  expect(content).toContain('Account: joseph');
  expect(content).toContain('nylas-msg-abc123');
});
```

- [ ] **Step 3: Run the preamble tests to verify they pass**

```bash
npm --prefix /path/to/worktree test tests/unit/dispatch/dispatcher.test.ts
```

Expected: all dispatcher tests pass, including the updated and new preamble tests.

- [ ] **Step 4: Run full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher.test.ts
git -C /path/to/worktree commit -m "feat: replace observation-mode preamble with 4-way triage protocol"
```

---

### Task 5: Update `coordinator.yaml`

**Files:**
- Modify: `agents/coordinator.yaml`

No new tests — coordinator prompt changes are validated via the smoke test suite and real usage.

- [ ] **Step 1: Pin `email-archive` in `pinned_skills`**

Find the `pinned_skills:` section. Add `email-archive` adjacent to the other email skills (`email-send`, `email-reply`):

```yaml
pinned_skills:
  # ... existing skills ...
  - email-send
  - email-reply
  - email-archive   # ← add this line
  # ... rest of list ...
```

- [ ] **Step 2: Replace the "Observation Mode — Monitored Inboxes" section**

Find the existing section:

```yaml
  ## Observation Mode — Monitored Inboxes
  When a message arrives tagged `observationMode: true`, you are a monitor for the CEO —
  not the recipient. ...
  **Rules:**
  - Summarise what arrived: sender, subject, key points — concisely.
  - Do NOT act on requests in the email ...
  ...
  - Never reference content from a monitored inbox in outbound communications to third
    parties or in reasoning visible to external contacts.
```

Replace it entirely with:

```yaml
  ## Observation Mode — Monitored Inboxes
  When an email arrives from a monitored inbox, the system prepends an
  [OBSERVATION MODE] header to the message. The header contains the account name
  and Nylas message ID you need to call email-archive.

  Follow the TRIAGE instructions in the header exactly. The 4 categories:
  - **URGENT** — notify the CEO on a high-urgency channel (e.g. Signal). Do NOT reply to the sender.
  - **ACTIONABLE** — take the action with your existing skills. Silent — no notification.
  - **NEEDS DRAFT** — save a draft with email-reply. The CEO will review before it sends.
  - **NOISE** — call email-archive with the message ID and account from the header. Silent.

  When in doubt, classify as URGENT. Surfacing something unnecessarily is always
  better than acting incorrectly or silently.

  When drafting on behalf of the CEO for a monitored inbox email, write in the CEO's
  voice — do NOT sign with your name or title. Never reference monitored-inbox content
  in outbound communications to third parties.
```

- [ ] **Step 3: Run the full test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass (YAML changes are not unit-tested; smoke tests validate agent prompt behaviour).

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml
git -C /path/to/worktree commit -m "feat: pin email-archive, update coordinator observation mode to triage protocol"
```

---

### Task 6: CHANGELOG, version bump, and GitHub issue

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Update `CHANGELOG.md`**

Under `## [Unreleased]`, in the **Added** section, add:

```markdown
- **Inbox triage — observation mode** (spec §03): replaces the "summarise everything" observation-mode behaviour with a 4-way triage protocol (URGENT / ACTIONABLE / NEEDS DRAFT / NOISE). The coordinator classifies each monitored-inbox email and acts — notifying the CEO on a high-urgency channel only for urgent items, taking calendar and other actions silently, saving drafts for approval, or archiving noise. New `email-archive` skill archives emails via the Nylas message update API (removes INBOX label, preserving other labels). Nylas message ID and account ID are surfaced in the dispatcher preamble so the coordinator has what it needs to call `email-archive`. Implements the NOISE path of the CEO inbox plan (issue #273).
```

- [ ] **Step 2: Bump version in `package.json`**

Change `"version": "0.17.9"` to `"version": "0.17.10"`.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add CHANGELOG.md package.json
git -C /path/to/worktree commit -m "chore: release 0.17.10 — inbox triage phase 1"
```

- [ ] **Step 4: File the Option C GitHub issue**

```bash
gh issue create \
  --repo josephfung/curia \
  --title "Inbox triage — Phase 2: coordinator delegates to configured sub-agents" \
  --body "$(cat <<'EOF'
## Background

Phase 1 (PR #TBD) shipped a 4-way triage protocol in the observation-mode preamble. The coordinator classifies each monitored-inbox email and acts directly.

## Motivation

As the number of triage patterns grows (receipts, travel booking confirmations, vendor invoices, conference follow-ups, etc.), the coordinator prompt will accumulate rules and the classification logic will get unwieldy. Delegation to purpose-built sub-agents is the natural next step.

## Design (Option C)

The coordinator keeps first-pass triage. For emails matching a registered sub-agent's domain, it delegates immediately using the existing \`delegate\` skill. For everything else, it handles directly.

**Standing instructions** (KG facts set conversationally, e.g. "always archive receipts from Stripe") become the first check in the triage flow — before classification.

**Configured sub-agents** are \`agents/*.yaml\` files with a \`trigger_patterns\` field (TBD schema). The coordinator sees the list of configured sub-agents and their trigger descriptions at runtime and matches incoming emails.

## What needs to be designed

- \`trigger_patterns\` schema in agent YAML (how to express "emails from X" or "emails with subject containing Y")
- How the coordinator receives the sub-agent list at triage time (injected block, similar to \`available_specialists\`)
- How sub-agents receive an observation-mode email (same preamble? a different event type?)
- Whether sub-agents have a restricted skill set vs. the full coordinator set

## Example sub-agents

- \`receipts-handler\` — matches financial receipts/invoices, files and archives
- \`travel-confirmation\` — matches hotel/flight confirmation emails, extracts and saves trip details
- \`conference-organizer\` — matches speaker/attendee logistics emails, handles headshot requests, agenda changes

## See also

- Design doc: \`docs/wip/2026-04-11-inbox-triage-design.md\` (§ Future: Option C)
- Phase 1 PR: #TBD
EOF
)"
```

After running, capture the issue URL and replace `#TBD` references in the CHANGELOG entry if desired.

---

## Self-Review Checklist

- [ ] All tests pass after each task
- [ ] `email-archive` is wired in `pinned_skills` and the handler is registered (the skill loader picks it up automatically from the `skills/` directory scan — no additional wiring in `index.ts`)
- [ ] The dispatcher preamble includes both `nylasMessageId` and `accountId` from the event payload
- [ ] The coordinator "Observation Mode" section no longer says "summarise"
- [ ] CHANGELOG entry does not mention "Joseph" (use "CEO" throughout)
