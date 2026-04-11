# CEO Inbox Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the coordinator three account-aware email skills — `email-list`, `email-get`, `email-draft-save` — so it can read any monitored inbox and save draft replies without autonomous sending.

**Architecture:** All three skills are thin handlers over methods that already exist on `OutboundGateway` (`listEmailMessages`, `getEmailMessage`, `createEmailDraft`). The gateway owns account resolution (named-client map) so the skills just pass an `account` string through. One preparatory task extends `ListMessagesOptions` with folder/search filters that `listEmailMessages` already accepts but the SDK call doesn't yet surface. No new SkillContext fields, no new config, no new channel adapter.

**Tech Stack:** TypeScript ESM, Nylas SDK v8 (existing), `OutboundGateway` (existing), Vitest.

**Worktree note:** This plan targets a fresh worktree on a new branch. Do not implement on the `fix/observation-mode-preamble` branch (PR #296 in review). Create a new worktree first:

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia worktree add ../curia-ceo-inbox-skills -b feat/ceo-inbox-skills
WORKTREE=/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills MAIN=/Users/josephfung/Projects/office-of-the-ceo/repos/curia; for item in .env; do if [ -e "$MAIN/$item" ]; then ln -sf "$MAIN/$item" "$WORKTREE/$item"; fi; done
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills install
```

All commands below use `WORKTREE=/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills`.

---

## What already exists (no work needed)

- `NylasClient.createDraft()` — implemented, uses `nylas.drafts.create`
- `NylasLike.drafts.create` — interface declaration exists
- `OutboundGateway.listEmailMessages(options?, accountId?)` — routes to per-account NylasClient
- `OutboundGateway.getEmailMessage(messageId, accountId?)` — routes to per-account NylasClient
- `OutboundGateway.createEmailDraft(request: EmailSendRequest)` — runs blocked-contact check then calls `NylasClient.createDraft`
- `OutboundGateway.archiveEmailMessage(messageId, accountId?)` — already built (PR #296)

## What the old plan described that is now obsolete

The original `docs/wip/2026-04-03-ceo-inbox.md` plan was written before PR #294 (observation mode) and the multi-account `OutboundGateway`. The following old tasks are fully superseded and must NOT be implemented:

- **Task 1** (config fields `nylasCeoGrantId`/`nylasCeoSelfEmail`) — no separate CEO adapter needed
- **Task 3** (add `nylasEmailClient`/`nylasCeoEmailClient` to `SkillContext`) — use `outboundGateway` instead
- **Task 4** (channel-trust entry for `email-ceo`) — no separate CEO channel
- **Task 5** (EmailCeoAdapter) — superseded by `observation_mode: true` in channel config
- **Task 6** (wire CEO adapter into `index.ts`) — superseded

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/channels/email/nylas-client.ts` | Add `folders`, `from`, `subject`, `searchQueryNative` to `ListMessagesOptions`; pass them in `listMessages()` |
| Create | `tests/unit/channels/email/nylas-client-list.test.ts` | Verify new filter params are forwarded to the Nylas SDK |
| Create | `skills/email-list/skill.json` | Manifest — `action_risk: "none"`, `infrastructure: true` |
| Create | `skills/email-list/handler.ts` | Calls `ctx.outboundGateway.listEmailMessages(options, accountId)` |
| Create | `tests/unit/skills/email-list.test.ts` | Unit tests for handler |
| Create | `skills/email-get/skill.json` | Manifest — `action_risk: "none"`, `infrastructure: true` |
| Create | `skills/email-get/handler.ts` | Calls `ctx.outboundGateway.getEmailMessage(messageId, accountId)` |
| Create | `tests/unit/skills/email-get.test.ts` | Unit tests for handler |
| Create | `skills/email-draft-save/skill.json` | Manifest — `action_risk: "medium"`, `infrastructure: true` |
| Create | `skills/email-draft-save/handler.ts` | Calls `ctx.outboundGateway.createEmailDraft({channel: 'email', ...})` |
| Create | `tests/unit/skills/email-draft-save.test.ts` | Unit tests for handler |
| Modify | `agents/coordinator.yaml` | Pin three skills; add CEO inbox guidance section |
| Modify | `CHANGELOG.md` | Add entries under `## [Unreleased]` |
| Modify | `package.json` | Bump version `0.17.10` → `0.18.0` (new skills = minor) |

---

### Task 1: Extend `ListMessagesOptions` with folder/search filters

**Files:**
- Modify: `src/channels/email/nylas-client.ts`
- Create: `tests/unit/channels/email/nylas-client-list.test.ts`

The existing `ListMessagesOptions` interface (around line 103 of `nylas-client.ts`) has `receivedAfter`, `unread`, `limit`, `threadId`, `fields`. Four new optional fields are needed so `email-list` can filter by folder, sender, subject, and native search query. The `listMessages()` method then passes them to the Nylas SDK's `ListMessagesQueryParams`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/channels/email/nylas-client-list.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockMessages } = vi.hoisted(() => {
  const mockMessages = { list: vi.fn(), find: vi.fn(), send: vi.fn(), update: vi.fn() };
  return { mockMessages };
});

vi.mock('nylas', () => {
  class MockNylas {
    messages = mockMessages;
    drafts = { create: vi.fn() };
  }
  return { default: MockNylas };
});

import { NylasClient } from '../../../../src/channels/email/nylas-client.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function emptyListResponse(items: unknown[] = []) {
  return { data: items, requestId: 'req-1', nextCursor: undefined };
}

describe('NylasClient.listMessages — folder/search filters', () => {
  let client: NylasClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new NylasClient('api-key', 'grant-id', logger);
    mockMessages.list.mockResolvedValue(emptyListResponse());
  });

  it('passes folders to Nylas as queryParams.in', async () => {
    await client.listMessages({ folders: ['INBOX', 'IMPORTANT'] });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ in: ['INBOX', 'IMPORTANT'] }) }),
    );
  });

  it('passes from to Nylas as queryParams.from array', async () => {
    await client.listMessages({ from: 'sender@example.com' });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ from: ['sender@example.com'] }) }),
    );
  });

  it('passes subject to Nylas queryParams', async () => {
    await client.listMessages({ subject: 'Meeting follow-up' });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ subject: 'Meeting follow-up' }) }),
    );
  });

  it('passes searchQueryNative to Nylas queryParams', async () => {
    await client.listMessages({ searchQueryNative: 'in:inbox is:unread' });
    expect(mockMessages.list).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: expect.objectContaining({ searchQueryNative: 'in:inbox is:unread' }) }),
    );
  });

  it('omits new params from queryParams when not provided', async () => {
    await client.listMessages({ unread: true });
    const callArg = mockMessages.list.mock.calls[0]![0] as { queryParams: Record<string, unknown> };
    expect(callArg.queryParams).not.toHaveProperty('in');
    expect(callArg.queryParams).not.toHaveProperty('from');
    expect(callArg.queryParams).not.toHaveProperty('subject');
    expect(callArg.queryParams).not.toHaveProperty('searchQueryNative');
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/channels/email/nylas-client-list.test.ts
```

Expected: all 5 tests fail — `folders`, `from`, `subject`, `searchQueryNative` are not yet in the interface.

- [ ] **Step 3: Extend `ListMessagesOptions` in `nylas-client.ts`**

Find the `ListMessagesOptions` interface (around line 103) and add the four new fields after `fields`:

```typescript
export interface ListMessagesOptions {
  /** Unix timestamp — only return messages received after this time */
  receivedAfter?: number;
  /** When true, only return unread messages */
  unread?: boolean;
  /** Max number of messages to return (default 50, max 200 per Nylas) */
  limit?: number;
  /** Filter messages to a specific thread ID — used when looking up a reply target */
  threadId?: string;
  /**
   * When set to 'include_headers', the Nylas API returns raw email headers in the response.
   * Required to access Authentication-Results for SPF/DKIM/DMARC sender verification.
   */
  fields?: 'include_headers';
  /** Filter to messages in these folder IDs (maps to Nylas `in` param).
   *  Standard values: INBOX, DRAFTS, SENT, TRASH. Providers may have custom labels. */
  folders?: string[];
  /** Filter to messages from this sender email address */
  from?: string;
  /** Filter to messages with this exact subject line */
  subject?: string;
  /** Provider-native search query (Gmail search syntax, Outlook KQL, etc.) */
  searchQueryNative?: string;
}
```

- [ ] **Step 4: Update `listMessages()` to pass the new params**

In `listMessages()` (around line 142), add four new param mappings after the existing `fields` block:

```typescript
if (options?.folders !== undefined) {
  // Nylas uses `in` for folder filtering — maps to our `folders` option.
  queryParams.in = options.folders;
}
if (options?.from !== undefined) {
  // Nylas expects `from` as an array of email strings.
  queryParams.from = [options.from];
}
if (options?.subject !== undefined) {
  queryParams.subject = options.subject;
}
if (options?.searchQueryNative !== undefined) {
  queryParams.searchQueryNative = options.searchQueryNative;
}
```

- [ ] **Step 5: Run the tests — confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/channels/email/nylas-client-list.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 6: Run the full suite — confirm nothing is broken**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills add src/channels/email/nylas-client.ts tests/unit/channels/email/nylas-client-list.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills commit -m "feat: extend ListMessagesOptions with folders, from, subject, searchQueryNative filters"
```

---

### Task 2: `email-list` skill

**Files:**
- Create: `skills/email-list/skill.json`
- Create: `skills/email-list/handler.ts`
- Create: `tests/unit/skills/email-list.test.ts`

Lists messages from any configured email account. Routes to the named `NylasClient` via `OutboundGateway.listEmailMessages()`. Read-only — `action_risk: "none"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/skills/email-list.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EmailListHandler } from '../../../skills/email-list/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const mockMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  subject: 'Hello',
  from: [{ email: 'sender@example.com', name: 'Sender' }],
  to: [{ email: 'ceo@example.com' }],
  cc: [],
  bcc: [],
  body: 'Full body here',
  snippet: 'Hello...',
  date: 1700000000,
  unread: true,
  folders: ['INBOX'],
};

function makeCtx(input: Record<string, unknown>, gateway?: Partial<{
  listEmailMessages: (...args: unknown[]) => unknown;
}>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
  };
}

describe('EmailListHandler', () => {
  const handler = new EmailListHandler();

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('returns failure when gateway throws (no client configured)', async () => {
    const gateway = { listEmailMessages: vi.fn().mockRejectedValue(new Error('no nylasClient is configured')) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to list');
  });

  it('calls listEmailMessages with no options when no params given', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(true);
    expect(gateway.listEmailMessages).toHaveBeenCalledWith({}, undefined);
  });

  it('passes account param as accountId', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ account: 'joseph' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(expect.anything(), 'joseph');
  });

  it('passes folder param as folders array', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ folder: 'DRAFTS' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ folders: ['DRAFTS'] }),
      undefined,
    );
  });

  it('passes unread_only as unread option', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ unread_only: true }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ unread: true }),
      undefined,
    );
  });

  it('passes from filter', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ from: 'boss@example.com' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'boss@example.com' }),
      undefined,
    );
  });

  it('passes search as searchQueryNative', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ search: 'in:inbox is:unread' }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ searchQueryNative: 'in:inbox is:unread' }),
      undefined,
    );
  });

  it('caps limit at 50 and passes it through', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([]) };
    await handler.execute(makeCtx({ limit: 200 }, gateway));
    expect(gateway.listEmailMessages).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
      undefined,
    );
  });

  it('returns normalised messages array with count', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([mockMessage]) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { messages: unknown[]; count: number };
      expect(data.messages).toHaveLength(1);
      expect(data.count).toBe(1);
    }
  });

  it('omits body from listed messages (snippet only)', async () => {
    const gateway = { listEmailMessages: vi.fn().mockResolvedValue([mockMessage]) };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      const messages = (result.data as { messages: Record<string, unknown>[] }).messages;
      expect(messages[0]).not.toHaveProperty('body');
      expect(messages[0]).toHaveProperty('snippet');
    }
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/skills/email-list.test.ts
```

Expected: all tests fail — module not found.

- [ ] **Step 3: Create the skill manifest**

Create `skills/email-list/skill.json`:

```json
{
  "name": "email-list",
  "description": "List recent emails from any configured email account. Returns message summaries (ID, sender, subject, snippet, date). Use email-get to fetch the full body of a specific message.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "infrastructure": true,
  "inputs": {
    "account": "string (optional) — named account to read from (e.g. 'curia', 'joseph'). Defaults to primary account.",
    "folder": "string (optional) — folder to filter by (e.g. 'INBOX', 'SENT', 'DRAFTS'). Defaults to all folders.",
    "unread_only": "boolean (optional) — when true, only return unread messages.",
    "from": "string (optional) — filter to messages from this email address.",
    "subject": "string (optional) — filter to messages with this subject.",
    "search": "string (optional) — provider-native search query (e.g. Gmail search syntax).",
    "limit": "number (optional) — max results to return. Capped at 50. Default: 20."
  },
  "outputs": {
    "messages": "array of message summaries — each has id, threadId, subject, from, snippet, date, unread, folders",
    "count": "number of messages returned"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 20000
}
```

- [ ] **Step 4: Create the handler**

Create `skills/email-list/handler.ts`:

```typescript
// handler.ts — email-list skill implementation.
//
// Lists messages from any configured email account via OutboundGateway.
// Returns lightweight summaries (no body — use email-get for full content).
// Account resolution is handled by the gateway's named-client map.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ListMessagesOptions } from '../../src/channels/email/nylas-client.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export class EmailListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-list requires outboundGateway (infrastructure: true)' };
    }

    const { account, folder, unread_only, from, subject, search, limit } = ctx.input as {
      account?: string;
      folder?: string;
      unread_only?: boolean;
      from?: string;
      subject?: string;
      search?: string;
      limit?: number;
    };

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;

    const options: ListMessagesOptions = {};
    if (typeof folder === 'string' && folder.trim()) options.folders = [folder.trim()];
    if (unread_only === true) options.unread = true;
    if (typeof from === 'string' && from.trim()) options.from = from.trim();
    if (typeof subject === 'string' && subject.trim()) options.subject = subject.trim();
    if (typeof search === 'string' && search.trim()) options.searchQueryNative = search.trim();
    options.limit = typeof limit === 'number' && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;

    ctx.log.info({ accountId, options }, 'email-list: listing messages');

    let messages: Awaited<ReturnType<typeof ctx.outboundGateway.listEmailMessages>>;
    try {
      messages = await ctx.outboundGateway.listEmailMessages(options, accountId);
    } catch (err) {
      ctx.log.error({ err, accountId }, 'email-list: failed to list messages');
      return { success: false, error: 'Failed to list messages' };
    }

    return {
      success: true,
      data: {
        messages: messages.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          subject: m.subject,
          from: m.from,
          snippet: m.snippet,
          date: m.date,
          unread: m.unread,
          folders: m.folders,
        })),
        count: messages.length,
      },
    };
  }
}
```

- [ ] **Step 5: Run the tests — confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/skills/email-list.test.ts
```

Expected: all 11 tests pass.

- [ ] **Step 6: Run the full suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills add skills/email-list/skill.json skills/email-list/handler.ts tests/unit/skills/email-list.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills commit -m "feat: add email-list skill — lists messages from any configured email account"
```

---

### Task 3: `email-get` skill

**Files:**
- Create: `skills/email-get/skill.json`
- Create: `skills/email-get/handler.ts`
- Create: `tests/unit/skills/email-get.test.ts`

Fetches the full body of a single message by ID. Routes via `OutboundGateway.getEmailMessage()`. Read-only — `action_risk: "none"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/skills/email-get.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EmailGetHandler } from '../../../skills/email-get/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const mockMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  subject: 'Hello',
  from: [{ email: 'sender@example.com', name: 'Sender' }],
  to: [{ email: 'ceo@example.com' }],
  cc: [],
  bcc: [],
  body: '<p>Full body here</p>',
  snippet: 'Full body here',
  date: 1700000000,
  unread: true,
  folders: ['INBOX'],
};

function makeCtx(input: Record<string, unknown>, gateway?: Partial<{
  getEmailMessage: (...args: unknown[]) => unknown;
}>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
  };
}

describe('EmailGetHandler', () => {
  const handler = new EmailGetHandler();

  it('returns failure when message_id is missing', async () => {
    const gateway = { getEmailMessage: vi.fn() };
    const result = await handler.execute(makeCtx({}, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('message_id');
  });

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('fetches message using default (primary) account when account is omitted', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }, gateway));
    expect(result.success).toBe(true);
    expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('passes account as accountId when provided', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    await handler.execute(makeCtx({ message_id: 'msg-1', account: 'joseph' }, gateway));
    expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-1', 'joseph');
  });

  it('trims whitespace from message_id', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    await handler.execute(makeCtx({ message_id: '  msg-1  ' }, gateway));
    expect(gateway.getEmailMessage).toHaveBeenCalledWith('msg-1', undefined);
  });

  it('returns the full message including body', async () => {
    const gateway = { getEmailMessage: vi.fn().mockResolvedValue(mockMessage) };
    const result = await handler.execute(makeCtx({ message_id: 'msg-1' }, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { message: { id: string; body: string } };
      expect(data.message.id).toBe('msg-1');
      expect(data.message.body).toBe('<p>Full body here</p>');
    }
  });

  it('returns failure when gateway throws (message not found)', async () => {
    const gateway = { getEmailMessage: vi.fn().mockRejectedValue(new Error('Nylas 404')) };
    const result = await handler.execute(makeCtx({ message_id: 'msg-missing' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to fetch');
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/skills/email-get.test.ts
```

Expected: all tests fail — module not found.

- [ ] **Step 3: Create the skill manifest**

Create `skills/email-get/skill.json`:

```json
{
  "name": "email-get",
  "description": "Fetch the full content (including body) of a single email message by its Nylas message ID. Use email-list to find message IDs first.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "infrastructure": true,
  "inputs": {
    "message_id": "string — Nylas message ID of the email to fetch",
    "account": "string (optional) — named account to read from (e.g. 'curia', 'joseph'). Defaults to primary account."
  },
  "outputs": {
    "message": "full message object — id, threadId, subject, from, to, cc, body, date, unread, folders"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

- [ ] **Step 4: Create the handler**

Create `skills/email-get/handler.ts`:

```typescript
// handler.ts — email-get skill implementation.
//
// Fetches a single email message (full body) by Nylas message ID.
// Routes via OutboundGateway.getEmailMessage() — account resolution
// is handled by the gateway's named-client map.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailGetHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-get requires outboundGateway (infrastructure: true)' };
    }

    const { message_id: rawId, account } = ctx.input as {
      message_id?: string;
      account?: string;
    };

    const messageId = typeof rawId === 'string' ? rawId.trim() : undefined;
    if (!messageId) {
      return { success: false, error: 'Missing required input: message_id (string)' };
    }

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;

    ctx.log.info({ messageId, accountId }, 'email-get: fetching message');

    let message: Awaited<ReturnType<typeof ctx.outboundGateway.getEmailMessage>>;
    try {
      message = await ctx.outboundGateway.getEmailMessage(messageId, accountId);
    } catch (err) {
      ctx.log.error({ err, messageId, accountId }, 'email-get: failed to fetch message');
      return { success: false, error: 'Failed to fetch message' };
    }

    return {
      success: true,
      data: {
        message: {
          id: message.id,
          threadId: message.threadId,
          subject: message.subject,
          from: message.from,
          to: message.to,
          cc: message.cc,
          body: message.body,
          date: message.date,
          unread: message.unread,
          folders: message.folders,
        },
      },
    };
  }
}
```

- [ ] **Step 5: Run the tests — confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/skills/email-get.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 6: Run the full suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills add skills/email-get/skill.json skills/email-get/handler.ts tests/unit/skills/email-get.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills commit -m "feat: add email-get skill — fetches full message body by Nylas message ID"
```

---

### Task 4: `email-draft-save` skill

**Files:**
- Create: `skills/email-draft-save/skill.json`
- Create: `skills/email-draft-save/handler.ts`
- Create: `tests/unit/skills/email-draft-save.test.ts`

Saves a draft email without sending it. Routes via `OutboundGateway.createEmailDraft()`, which runs the blocked-contact check and converts markdown to HTML before calling Nylas. `action_risk: "medium"` — same as email-send, because drafts can be sent by a human later.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/skills/email-draft-save.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { EmailDraftSaveHandler } from '../../../skills/email-draft-save/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>, gateway?: Partial<{
  createEmailDraft: (...args: unknown[]) => unknown;
}>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: gateway as never,
  };
}

describe('EmailDraftSaveHandler', () => {
  const handler = new EmailDraftSaveHandler();

  it('returns failure when outboundGateway is not configured', async () => {
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('outboundGateway');
  });

  it('returns failure when to is missing', async () => {
    const gateway = { createEmailDraft: vi.fn() };
    const result = await handler.execute(makeCtx({ subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('to');
  });

  it('returns failure when subject is missing', async () => {
    const gateway = { createEmailDraft: vi.fn() };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('subject');
  });

  it('returns failure when body is missing', async () => {
    const gateway = { createEmailDraft: vi.fn() };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('body');
  });

  it('calls createEmailDraft with channel: email and correct fields', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-1' }) };
    await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(gateway.createEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: 'r@example.com', subject: 'Hi', body: 'Hello' }),
    );
  });

  it('passes account as accountId', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-1' }) };
    await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello', account: 'joseph' }, gateway));
    expect(gateway.createEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'joseph' }),
    );
  });

  it('passes reply_to_message_id as replyToMessageId', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'd-1' }) };
    await handler.execute(makeCtx(
      { to: 'r@example.com', subject: 'Re: Hi', body: 'Hello', reply_to_message_id: 'msg-orig' },
      gateway,
    ));
    expect(gateway.createEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: 'msg-orig' }),
    );
  });

  it('returns draft_id on success', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-99' }) };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { draft_id: string }).draft_id).toBe('draft-99');
    }
  });

  it('returns failure when gateway returns success: false (blocked recipient)', async () => {
    const gateway = { createEmailDraft: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }) };
    const result = await handler.execute(makeCtx({ to: 'blocked@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('blocked');
  });

  it('returns failure when gateway throws unexpectedly', async () => {
    const gateway = { createEmailDraft: vi.fn().mockRejectedValue(new Error('Nylas timeout')) };
    const result = await handler.execute(makeCtx({ to: 'r@example.com', subject: 'Hi', body: 'Hello' }, gateway));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Failed to save draft');
  });
});
```

- [ ] **Step 2: Run the tests — confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/skills/email-draft-save.test.ts
```

Expected: all tests fail — module not found.

- [ ] **Step 3: Create the skill manifest**

Create `skills/email-draft-save/skill.json`:

```json
{
  "name": "email-draft-save",
  "description": "Save an email as a draft without sending it. The CEO can review and send the draft from their email client. Use for observation-mode triage (NEEDS DRAFT category) or when composing a reply that needs CEO approval before sending.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "medium",
  "infrastructure": true,
  "inputs": {
    "to": "string — recipient email address",
    "subject": "string — email subject line",
    "body": "string — email body (markdown supported, converted to HTML automatically)",
    "account": "string (optional) — named account to draft from (e.g. 'curia', 'joseph'). Defaults to primary account.",
    "reply_to_message_id": "string (optional) — Nylas message ID to reply to. Threads the draft as a reply when set."
  },
  "outputs": {
    "draft_id": "string — Nylas draft ID of the created draft"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 20000
}
```

- [ ] **Step 4: Create the handler**

Create `skills/email-draft-save/handler.ts`:

```typescript
// handler.ts — email-draft-save skill implementation.
//
// Saves a draft email without sending it. Routes via OutboundGateway.createEmailDraft(),
// which runs the blocked-contact check and converts markdown to HTML.
//
// Use this for the NEEDS DRAFT triage category: coordinator writes the draft,
// the CEO reviews and sends it from their email client.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class EmailDraftSaveHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.outboundGateway) {
      return { success: false, error: 'email-draft-save requires outboundGateway (infrastructure: true)' };
    }

    const { to: rawTo, subject, body, account, reply_to_message_id } = ctx.input as {
      to?: string;
      subject?: string;
      body?: string;
      account?: string;
      reply_to_message_id?: string;
    };

    const to = typeof rawTo === 'string' ? rawTo.trim() : undefined;
    if (!to) return { success: false, error: 'Missing required input: to (string)' };
    if (!subject || typeof subject !== 'string') return { success: false, error: 'Missing required input: subject (string)' };
    if (!body || typeof body !== 'string') return { success: false, error: 'Missing required input: body (string)' };

    const accountId = typeof account === 'string' && account.trim() ? account.trim() : undefined;
    const replyToMessageId = typeof reply_to_message_id === 'string' && reply_to_message_id.trim()
      ? reply_to_message_id.trim()
      : undefined;

    ctx.log.info({ to, subject, accountId, replyToMessageId }, 'email-draft-save: saving draft');

    let result: Awaited<ReturnType<typeof ctx.outboundGateway.createEmailDraft>>;
    try {
      result = await ctx.outboundGateway.createEmailDraft({
        channel: 'email',
        to,
        subject,
        body,
        accountId,
        replyToMessageId,
      });
    } catch (err) {
      ctx.log.error({ err, to, accountId }, 'email-draft-save: unexpected error saving draft');
      return { success: false, error: 'Failed to save draft' };
    }

    if (!result.success) {
      ctx.log.error({ to, accountId, reason: result.blockedReason }, 'email-draft-save: gateway rejected draft');
      return { success: false, error: result.blockedReason ?? 'Failed to save draft' };
    }

    ctx.log.info({ draftId: result.draftId, to, accountId }, 'email-draft-save: draft saved');
    return { success: true, data: { draft_id: result.draftId } };
  }
}
```

- [ ] **Step 5: Run the tests — confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test -- --reporter=verbose tests/unit/skills/email-draft-save.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 6: Run the full suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills add skills/email-draft-save/skill.json skills/email-draft-save/handler.ts tests/unit/skills/email-draft-save.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills commit -m "feat: add email-draft-save skill — saves draft via gateway without sending"
```

---

### Task 5: `coordinator.yaml`, CHANGELOG, version bump

**Files:**
- Modify: `agents/coordinator.yaml`
- Modify: `CHANGELOG.md`
- Modify: `package.json`

Pin the three new skills and replace the "Email" section in the coordinator prompt with account-aware guidance. Bump version to `0.18.0` (three new skills = new capability = minor bump).

- [ ] **Step 1: Add three skills to `pinned_skills` in `agents/coordinator.yaml`**

Find the `pinned_skills` list and add after `email-reply` (keep email skills together):

```yaml
  - email-list
  - email-get
  - email-draft-save
```

- [ ] **Step 2: Update the `## Email` section in the coordinator system prompt**

Find the existing `## Email` section (around line 246) and replace it with:

```yaml
  ## Email

  You have your own email account (Curia's account) and can monitor the CEO's inbox when configured in observation mode.

  ### Sending and replying
  - **Replying to an email you received**: use `email-reply` with the `thread_id`. It threads automatically — no address needed.
  - **Composing a new email**: use `email-send` with a `to` address. Only use this when the CEO asks you to email someone.
  - **Drafting for the CEO's signature**: use `email-draft-save` with `account` set to the CEO's account name (e.g. `joseph`). The CEO reviews and sends from their client.

  ### Reading inboxes
  - Use `email-list` to see recent messages in any account (`account: "joseph"` for the CEO's inbox).
  - Use `email-get` to fetch the full body of a specific message by its `message_id`.
  - Both skills accept an `account` param — omit it to read Curia's inbox, pass the account name to read another.

  ### Account names
  The `account` param on all email skills maps to the account names configured in `channel_accounts.email`. Common values: `curia` (Curia's inbox), `joseph` (CEO's inbox). When in doubt, check the observation-mode preamble — it always includes the `Account:` line for the current monitored inbox.
```

- [ ] **Step 3: Add entry to `CHANGELOG.md` under `## [Unreleased]` → `### Added`**

Insert at the top of the `### Added` section:

```markdown
- **CEO inbox read skills** (`email-list`, `email-get`, `email-draft-save`): account-aware email skills that route through `OutboundGateway`'s named-client map. `email-list` lists messages with folder/sender/search filters; `email-get` fetches the full body of a single message; `email-draft-save` saves a draft (with blocked-contact check) for CEO review. `ListMessagesOptions` extended with `folders`, `from`, `subject`, `searchQueryNative` filters. Coordinator pinned and prompted on all three skills. Closes CEO inbox Tasks 7–9.
```

- [ ] **Step 4: Bump version in `package.json`**

Change `"version": "0.17.10"` to `"version": "0.18.0"`.

- [ ] **Step 5: Run the full suite one final time**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills test 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills add agents/coordinator.yaml CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-ceo-inbox-skills commit -m "chore: pin email-list/get/draft-save in coordinator, bump to 0.18.0"
```

---

## Self-Review

### Spec coverage

- ✅ `email-list` — lists messages with account, folder, unread, from, subject, search, limit filters
- ✅ `email-get` — fetches full message body by ID
- ✅ `email-draft-save` — saves draft (blocked-contact check via gateway), passes account/reply threading
- ✅ `ListMessagesOptions` extended — folders, from, subject, searchQueryNative
- ✅ `coordinator.yaml` — three skills pinned, account-aware email guidance added
- ✅ CHANGELOG + version 0.18.0

### No placeholders found

All steps contain complete code, exact commands, and expected outputs.

### Type consistency

- `emailListHandler` reads `ctx.outboundGateway.listEmailMessages` → returns `NylasMessage[]` ✓
- `emailGetHandler` reads `ctx.outboundGateway.getEmailMessage` → returns `NylasMessage` ✓
- `emailDraftSaveHandler` calls `ctx.outboundGateway.createEmailDraft` with `EmailSendRequest` → returns `OutboundDraftResult` ✓
- `account` param consistently treated as `accountId?: string` across all three skills ✓
- `reply_to_message_id` (skill input snake_case) → `replyToMessageId` (gateway camelCase) ✓
