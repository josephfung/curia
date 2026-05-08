# Non-Threaded Channel Context Bridging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge context between outbound and inbound messages on non-threaded channels (Signal, SMS, CLI) so the coordinator knows what the user is replying to.

**Architecture:** The dispatch layer writes structured "outbound context memos" to working memory whenever it routes an outbound message to a non-threaded channel. On inbound, it reads recent memos and prepends them to the coordinator's task content. The coordinator prompt gets a channel-agnostic clarification gate for reply-shaped messages without context.

**Tech Stack:** TypeScript (ESM), Vitest, YAML config, pino logging

**Spec:** `docs/wip/2026-05-08-non-threaded-context-bridging-design.md`
**Issue:** [#431](https://github.com/josephfung/curia/issues/431)
**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging` (branch `feat/non-threaded-context-bridging`)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/contacts/types.ts` | Modify | Add `threaded: boolean` to `ChannelPolicyConfig` |
| `config/channel-trust.yaml` | Modify | Add `threaded` field to each channel entry |
| `src/contacts/config-loader.ts` | Modify | Parse `threaded` from YAML, default `false` |
| `src/dispatch/context-memo.ts` | Create | Pure functions: `formatOutboundMemo()`, `extractRecentMemos()`, `buildContextPreamble()` |
| `src/dispatch/dispatcher.ts` | Modify | Wire `workingMemory`, call memo functions in `handleAgentResponse` and `handleInbound` |
| `src/index.ts` | Modify | Pass `memory` to `Dispatcher` config |
| `agents/coordinator.yaml` | Modify | Add outbound context / clarification gate directive |
| `tests/unit/dispatch/context-memo.test.ts` | Create | Unit tests for memo formatting and extraction |
| `tests/unit/dispatch/dispatcher-context-bridging.test.ts` | Create | Integration tests for the full inbound/outbound flow |

---

### Task 1: Add `threaded` to `ChannelPolicyConfig` and config loader

**Files:**
- Modify: `src/contacts/types.ts:203-206`
- Modify: `config/channel-trust.yaml`
- Modify: `src/contacts/config-loader.ts:77-104`
- Test: `tests/unit/contacts/config-loader.test.ts` (if it exists, otherwise inline verification)

- [ ] **Step 1: Add `threaded` field to the interface**

In `src/contacts/types.ts`, add `threaded` to `ChannelPolicyConfig`:

```typescript
export interface ChannelPolicyConfig {
  trust: TrustLevel;
  unknownSender: UnknownSenderPolicy;
  /** Whether this channel structurally links replies to their parent messages.
   *  Email is threaded (subject + in-reply-to headers); Signal/SMS/CLI are not.
   *  The dispatch layer uses this to decide whether to write/read outbound context memos. */
  threaded: boolean;
}
```

- [ ] **Step 2: Update `channel-trust.yaml`**

Add `threaded` to every channel entry in `config/channel-trust.yaml`:

```yaml
channels:
  cli:
    trust: high
    unknown_sender: allow
    threaded: false
  web:
    trust: high
    unknown_sender: allow
    threaded: false
  signal:
    trust: high
    unknown_sender: hold_and_notify
    threaded: false
  http:
    trust: medium
    unknown_sender: ignore
    threaded: false
  email:
    trust: low
    unknown_sender: hold_and_notify
    threaded: true
```

- [ ] **Step 3: Update config loader to parse `threaded`**

In `src/contacts/config-loader.ts`, update the type assertion on line 77 to include `threaded`:

```typescript
const trustTyped = trustRaw as { channels: Record<string, string | { trust: string; unknown_sender: string; threaded?: boolean }> };
```

In the legacy flat-string branch (line 92), add `threaded: false`:

```typescript
channelPolicies[channel] = { trust, unknownSender: 'allow', threaded: false };
```

In the object branch (line 103), parse `threaded` with a default:

```typescript
const threaded = (config as { threaded?: boolean }).threaded ?? false;
channelPolicies[channel] = { trust, unknownSender, threaded };
```

- [ ] **Step 4: Run the build to verify types compile**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging run build`

Expected: Clean build. Any existing code that constructs `ChannelPolicyConfig` objects (like test helpers) will fail to compile — fix those by adding `threaded: false` (or `true` for email) to each construction site.

- [ ] **Step 5: Fix any compilation errors in tests**

Search for `ChannelPolicyConfig` or `channelPolicies:` in test files and add the `threaded` field to each inline object. For example, in `tests/unit/dispatch/dispatcher.test.ts` line 128:

```typescript
// Before:
channelPolicies: { http: { trust: 'low', unknownSender: 'ignore' } },
// After:
channelPolicies: { http: { trust: 'low', unknownSender: 'ignore', threaded: false } },
```

- [ ] **Step 6: Run tests**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging add src/contacts/types.ts config/channel-trust.yaml src/contacts/config-loader.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging commit -m "feat: add threaded field to ChannelPolicyConfig (#431)"
```

Stage and commit any test files that needed `threaded` added too.

---

### Task 2: Create `context-memo.ts` — pure functions for memo formatting and extraction

**Files:**
- Create: `src/dispatch/context-memo.ts`
- Create: `tests/unit/dispatch/context-memo.test.ts`

This task creates the memo logic as pure functions with no dependencies on the bus or working memory — easy to test in isolation.

- [ ] **Step 1: Write failing tests for `formatOutboundMemo()`**

Create `tests/unit/dispatch/context-memo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatOutboundMemo, extractRecentMemos, buildContextPreamble, OUTBOUND_MEMO_PREFIX } from '../../../src/dispatch/context-memo.js';

describe('formatOutboundMemo', () => {
  it('produces a structured memo with all fields', () => {
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: 'You have 3 held emails. Want me to process them?',
      taskEventId: 'evt-abc123',
    });

    expect(memo).toContain(OUTBOUND_MEMO_PREFIX);
    expect(memo).toContain('source_conversation: signal:+14155552671');
    expect(memo).toContain('message_preview: You have 3 held emails. Want me to process them?');
    expect(memo).toContain('task_type: coordinator-response');
    expect(memo).toContain('key_ids: task:evt-abc123');
    expect(memo).toContain('expected_reply: User may reply to this message');
  });

  it('truncates message_preview at 200 chars with ellipsis', () => {
    const longContent = 'A'.repeat(250);
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: longContent,
      taskEventId: 'evt-1',
    });

    const previewLine = memo.split('\n').find(l => l.startsWith('message_preview:'));
    // "message_preview: " is 17 chars, then 200 chars of 'A', then '…'
    expect(previewLine).toBe(`message_preview: ${'A'.repeat(200)}…`);
  });

  it('does not add ellipsis when content fits within 200 chars', () => {
    const shortContent = 'Hello there';
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: shortContent,
      taskEventId: 'evt-1',
    });

    const previewLine = memo.split('\n').find(l => l.startsWith('message_preview:'));
    expect(previewLine).toBe('message_preview: Hello there');
  });

  it('omits key_ids line when taskEventId is undefined', () => {
    const memo = formatOutboundMemo({
      conversationId: 'signal:+14155552671',
      content: 'Hello',
      taskEventId: undefined,
    });

    expect(memo).not.toContain('key_ids:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/context-memo.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `formatOutboundMemo()`**

Create `src/dispatch/context-memo.ts`:

```typescript
// src/dispatch/context-memo.ts
//
// Pure functions for outbound context memos on non-threaded channels.
// The dispatch layer writes memos to working memory on outbound and reads them
// on inbound. These functions format, parse, and assemble memo content without
// any dependency on the bus, database, or working memory service.
//
// See docs/wip/2026-05-08-non-threaded-context-bridging-design.md

import type { ConversationTurn } from '../memory/working-memory.js';

/** Prefix that identifies outbound context memos in working memory turns. */
export const OUTBOUND_MEMO_PREFIX = '[OUTBOUND CONTEXT — ';

const MAX_PREVIEW_LENGTH = 200;

interface FormatMemoInput {
  conversationId: string;
  content: string;
  taskEventId: string | undefined;
}

/**
 * Format an outbound context memo as a structured text string.
 * Written to working memory as a system-role turn so the coordinator
 * can see what it last sent on a non-threaded channel.
 */
export function formatOutboundMemo(input: FormatMemoInput): string {
  const timestamp = new Date().toISOString();
  const preview = input.content.length > MAX_PREVIEW_LENGTH
    ? input.content.slice(0, MAX_PREVIEW_LENGTH) + '…'
    : input.content;

  const lines = [
    `${OUTBOUND_MEMO_PREFIX}${timestamp}]`,
    `source_conversation: ${input.conversationId}`,
    `message_preview: ${preview}`,
    `task_type: coordinator-response`,
  ];

  if (input.taskEventId) {
    lines.push(`key_ids: task:${input.taskEventId}`);
  }

  lines.push('expected_reply: User may reply to this message');

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/context-memo.test.ts`

Expected: All `formatOutboundMemo` tests PASS.

- [ ] **Step 5: Write failing tests for `extractRecentMemos()`**

Append to `tests/unit/dispatch/context-memo.test.ts`:

```typescript
describe('extractRecentMemos', () => {
  function makeTurn(content: string): ConversationTurn {
    return { role: 'system', content };
  }

  it('extracts memos from system turns matching the prefix', () => {
    const recentMemo = `${OUTBOUND_MEMO_PREFIX}${new Date().toISOString()}]\nsource_conversation: signal:+1\nmessage_preview: hello\ntask_type: coordinator-response\nexpected_reply: User may reply to this message`;
    const turns: ConversationTurn[] = [
      { role: 'user', content: 'Hi' },
      makeTurn(recentMemo),
      { role: 'assistant', content: 'Hello!' },
    ];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(recentMemo);
  });

  it('excludes memos older than the TTL', () => {
    const oldDate = new Date(Date.now() - 2 * 86_400_000).toISOString(); // 2 days ago
    const oldMemo = `${OUTBOUND_MEMO_PREFIX}${oldDate}]\nsource_conversation: signal:+1\nmessage_preview: old\ntask_type: coordinator-response\nexpected_reply: User may reply to this message`;
    const turns: ConversationTurn[] = [makeTurn(oldMemo)];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(0);
  });

  it('excludes non-system turns and system turns without the memo prefix', () => {
    const turns: ConversationTurn[] = [
      { role: 'user', content: `${OUTBOUND_MEMO_PREFIX}fake` },
      { role: 'system', content: '[Conversation summary]\nSome summary text' },
    ];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(0);
  });

  it('returns multiple memos in chronological order', () => {
    const t1 = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
    const t2 = new Date().toISOString(); // now
    const memo1 = `${OUTBOUND_MEMO_PREFIX}${t1}]\nmessage_preview: first`;
    const memo2 = `${OUTBOUND_MEMO_PREFIX}${t2}]\nmessage_preview: second`;
    const turns: ConversationTurn[] = [makeTurn(memo1), makeTurn(memo2)];

    const result = extractRecentMemos(turns, 86_400_000);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('first');
    expect(result[1]).toContain('second');
  });
});
```

- [ ] **Step 6: Implement `extractRecentMemos()`**

Append to `src/dispatch/context-memo.ts`:

```typescript
/**
 * Extract outbound context memos from a working memory turn history.
 * Filters to system-role turns with the memo prefix whose embedded
 * timestamp is within the TTL window.
 *
 * Returns memos in the same order they appear in `turns` (chronological,
 * since working memory returns oldest-first).
 */
export function extractRecentMemos(
  turns: ConversationTurn[],
  ttlMs: number,
): string[] {
  const cutoff = Date.now() - ttlMs;

  return turns.filter((turn) => {
    if (turn.role !== 'system') return false;
    if (!turn.content.startsWith(OUTBOUND_MEMO_PREFIX)) return false;

    // Parse timestamp from the prefix line: [OUTBOUND CONTEXT — <ISO timestamp>]
    const closingBracket = turn.content.indexOf(']');
    if (closingBracket === -1) return false;
    const timestamp = turn.content.slice(OUTBOUND_MEMO_PREFIX.length, closingBracket);
    const memoTime = new Date(timestamp).getTime();
    if (isNaN(memoTime)) return false;

    return memoTime >= cutoff;
  }).map(turn => turn.content);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/context-memo.test.ts`

Expected: All tests PASS.

- [ ] **Step 8: Write failing tests for `buildContextPreamble()`**

Append to `tests/unit/dispatch/context-memo.test.ts`:

```typescript
describe('buildContextPreamble', () => {
  it('wraps memos in preamble header and separator, then appends original content', () => {
    const memos = ['[OUTBOUND CONTEXT — 2026-05-08T14:00:00Z]\nmessage_preview: hello'];
    const result = buildContextPreamble(memos, 'User says hi');

    expect(result).toContain('[PRIOR OUTBOUND CONTEXT — this is what you last sent on this channel]');
    expect(result).toContain('message_preview: hello');
    expect(result).toContain('User says hi');
    // Memo block is separated from user content by ---
    expect(result).toContain('---');
  });

  it('includes multiple memos separated by ---', () => {
    const memos = [
      '[OUTBOUND CONTEXT — 2026-05-08T14:00:00Z]\nmessage_preview: first',
      '[OUTBOUND CONTEXT — 2026-05-08T15:00:00Z]\nmessage_preview: second',
    ];
    const result = buildContextPreamble(memos, 'Reply');

    // Both memos present
    expect(result).toContain('message_preview: first');
    expect(result).toContain('message_preview: second');
  });

  it('returns null when memos array is empty', () => {
    const result = buildContextPreamble([], 'Hello');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 9: Implement `buildContextPreamble()`**

Append to `src/dispatch/context-memo.ts`:

```typescript
/**
 * Build the context preamble that the dispatcher prepends to inbound task content.
 * Returns null if no memos are provided (caller should use original content as-is).
 */
export function buildContextPreamble(
  memos: string[],
  originalContent: string,
): string | null {
  if (memos.length === 0) return null;

  const memoBlock = memos.map(m => `---\n${m}\n---`).join('\n');

  return [
    '[PRIOR OUTBOUND CONTEXT — this is what you last sent on this channel]',
    memoBlock,
    '',
    originalContent,
  ].join('\n');
}
```

- [ ] **Step 10: Run all context-memo tests**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/context-memo.test.ts`

Expected: All tests PASS.

- [ ] **Step 11: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging add src/dispatch/context-memo.ts tests/unit/dispatch/context-memo.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging commit -m "feat: add context-memo pure functions for outbound memo format/extract/preamble (#431)"
```

---

### Task 3: Wire outbound memo write into `handleAgentResponse`

**Files:**
- Modify: `src/dispatch/dispatcher.ts:41-147` (config + constructor) and `811-850` (handleAgentResponse)
- Test: `tests/unit/dispatch/dispatcher-context-bridging.test.ts` (new)

- [ ] **Step 1: Write failing test for outbound memo write**

Create `tests/unit/dispatch/dispatcher-context-bridging.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { createInboundMessage, type OutboundMessageEvent, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';
import { OUTBOUND_MEMO_PREFIX } from '../../../src/dispatch/context-memo.js';

function setupTestBus() {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const memory = WorkingMemory.createInMemory();

  const mockProvider: LLMProvider = {
    id: 'mock',
    chat: vi.fn().mockResolvedValue({
      type: 'text' as const,
      content: 'Response from Coordinator',
      usage: { inputTokens: 10, outputTokens: 5 },
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

  return { bus, logger, memory, mockProvider };
}

describe('Dispatcher context bridging — outbound memo', () => {
  it('writes an outbound context memo to working memory for non-threaded channels', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'hold_and_notify', threaded: false } },
    });
    dispatcher.register();

    // Capture outbound to confirm the message was sent
    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    // Verify outbound was sent
    expect(outbound).toHaveLength(1);

    // Verify memo was written to working memory
    const history = await memory.getHistory('signal:+14155552671', 'coordinator');
    const memoTurns = history.filter(t => t.role === 'system' && t.content.startsWith(OUTBOUND_MEMO_PREFIX));
    expect(memoTurns).toHaveLength(1);
    expect(memoTurns[0].content).toContain('message_preview: Response from Coordinator');
    expect(memoTurns[0].content).toContain('source_conversation: signal:+14155552671');
  });

  it('does NOT write a memo for threaded channels', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { email: { trust: 'low', unknownSender: 'hold_and_notify', threaded: true } },
    });
    dispatcher.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    const event = createInboundMessage({
      conversationId: 'email:alice@example.com',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(outbound).toHaveLength(1);

    const history = await memory.getHistory('email:alice@example.com', 'coordinator');
    const memoTurns = history.filter(t => t.role === 'system' && t.content.startsWith(OUTBOUND_MEMO_PREFIX));
    expect(memoTurns).toHaveLength(0);
  });

  it('does NOT write a memo when workingMemory is not configured', async () => {
    const { bus, logger } = setupTestBus();

    // No workingMemory passed — memo writing should be silently skipped
    const dispatcher = new Dispatcher({
      bus,
      logger,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'hold_and_notify', threaded: false } },
    });
    dispatcher.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello',
    });

    // Should not throw — just skip memo write
    await bus.publish('channel', event);
    expect(outbound).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/dispatcher-context-bridging.test.ts`

Expected: FAIL — `workingMemory` is not a valid property of `DispatcherConfig`.

- [ ] **Step 3: Add `workingMemory` to `DispatcherConfig` and constructor**

In `src/dispatch/dispatcher.ts`, add the import at the top:

```typescript
import type { WorkingMemory } from '../memory/working-memory.js';
import { formatOutboundMemo } from './context-memo.js';
```

Add to `DispatcherConfig` (after `confidencePipeline`):

```typescript
  /** Working memory — used to write outbound context memos on non-threaded channels
   *  and read them back for inbound context injection. When omitted, context
   *  bridging is disabled (e.g. in unit tests that don't exercise it). */
  workingMemory?: WorkingMemory;
  /** TTL for outbound context memos in milliseconds. Memos older than this are
   *  excluded from inbound injection. Default: 86400000 (24 hours). */
  contextMemoTtlMs?: number;
```

Add private fields to the `Dispatcher` class:

```typescript
  private workingMemory?: WorkingMemory;
  private contextMemoTtlMs: number;
```

In the constructor, assign them:

```typescript
    this.workingMemory = config.workingMemory;
    this.contextMemoTtlMs = config.contextMemoTtlMs ?? 86_400_000;
```

- [ ] **Step 4: Add outbound memo write to `handleAgentResponse`**

In `handleAgentResponse`, after `await this.bus.publish('dispatch', outbound);` and before `this.scheduleCheckpoint(...)`, add:

```typescript
    // Write an outbound context memo to working memory for non-threaded channels.
    // When the user replies, the inbound handler reads these memos and prepends
    // them to the coordinator's task content so it knows what it last said.
    // Best-effort: failure is logged but does not block outbound delivery.
    const channelPolicy = this.channelPolicies?.[routing.channelId];
    if (this.workingMemory && channelPolicy && !channelPolicy.threaded) {
      try {
        const memo = formatOutboundMemo({
          conversationId: routing.conversationId,
          content: event.payload.content,
          taskEventId: event.parentEventId ?? undefined,
        });
        await this.workingMemory.addTurn(routing.conversationId, 'coordinator', {
          role: 'system',
          content: memo,
        });
        this.logger.debug(
          { channelId: routing.channelId, conversationId: routing.conversationId },
          'Outbound context memo written to working memory',
        );
      } catch (err) {
        this.logger.warn(
          { err, channelId: routing.channelId, conversationId: routing.conversationId },
          'Failed to write outbound context memo — context bridging degraded for this message',
        );
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/dispatcher-context-bridging.test.ts`

Expected: All 3 tests PASS.

- [ ] **Step 6: Run the full test suite to check for regressions**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test`

Expected: All tests PASS. Existing dispatcher tests should be unaffected since they don't pass `workingMemory`.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher-context-bridging.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging commit -m "feat: write outbound context memos for non-threaded channels (#431)"
```

---

### Task 4: Wire inbound context injection into `handleInbound`

**Files:**
- Modify: `src/dispatch/dispatcher.ts:176-798` (handleInbound, before task creation)
- Test: `tests/unit/dispatch/dispatcher-context-bridging.test.ts` (append)

- [ ] **Step 1: Write failing test for inbound context injection**

Append to `tests/unit/dispatch/dispatcher-context-bridging.test.ts`:

```typescript
describe('Dispatcher context bridging — inbound injection', () => {
  it('prepends outbound context preamble to task content when memos exist', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow', threaded: false } },
    });
    dispatcher.register();

    // Pre-seed working memory with an outbound context memo
    const memoContent = `${OUTBOUND_MEMO_PREFIX}${new Date().toISOString()}]\nsource_conversation: signal:+14155552671\nmessage_preview: You have 3 held emails\ntask_type: coordinator-response\nexpected_reply: User may reply to this message`;
    await memory.addTurn('signal:+14155552671', 'coordinator', {
      role: 'system',
      content: memoContent,
    });

    // Capture the agent.task to inspect the content
    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Yes, process them',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).toContain('[PRIOR OUTBOUND CONTEXT');
    expect(tasks[0].payload.content).toContain('You have 3 held emails');
    expect(tasks[0].payload.content).toContain('Yes, process them');
  });

  it('does NOT inject preamble when no memos exist', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow', threaded: false } },
    });
    dispatcher.register();

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello there',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).toBe('Hello there');
    expect(tasks[0].payload.content).not.toContain('[PRIOR OUTBOUND CONTEXT');
  });

  it('does NOT inject preamble for threaded channels even if memos exist', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    });
    dispatcher.register();

    // Pre-seed a memo (shouldn't happen in practice but tests the guard)
    await memory.addTurn('email:alice@example.com', 'coordinator', {
      role: 'system',
      content: `${OUTBOUND_MEMO_PREFIX}${new Date().toISOString()}]\nmessage_preview: hello`,
    });

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'email:alice@example.com',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Reply to thread',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).not.toContain('[PRIOR OUTBOUND CONTEXT');
  });

  it('excludes memos older than TTL', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow', threaded: false } },
      contextMemoTtlMs: 1000, // 1 second TTL for testing
    });
    dispatcher.register();

    // Pre-seed with a memo timestamped 2 seconds ago (outside TTL)
    const oldDate = new Date(Date.now() - 2000).toISOString();
    await memory.addTurn('signal:+14155552671', 'coordinator', {
      role: 'system',
      content: `${OUTBOUND_MEMO_PREFIX}${oldDate}]\nmessage_preview: old message\ntask_type: coordinator-response\nexpected_reply: User may reply`,
    });

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).toBe('Hello');
    expect(tasks[0].payload.content).not.toContain('[PRIOR OUTBOUND CONTEXT');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/dispatcher-context-bridging.test.ts`

Expected: FAIL — the new inbound injection tests fail because the dispatcher doesn't inject the preamble yet.

- [ ] **Step 3: Add inbound context injection to `handleInbound`**

In `src/dispatch/dispatcher.ts`, add the import for the extraction/preamble functions:

```typescript
import { formatOutboundMemo, extractRecentMemos, buildContextPreamble } from './context-memo.js';
```

(Replace the existing `import { formatOutboundMemo }` from Task 3.)

In `handleInbound`, find the line that sets `taskContent` (look for `let taskContent = payload.content;` or the equivalent — this is the variable that becomes the `agent.task` content). **Before** any existing content modifications (like the CC preamble), add the context injection block:

```typescript
    // Inbound context injection for non-threaded channels.
    // Read recent outbound context memos from working memory and prepend them
    // to the task content so the coordinator knows what it last sent.
    // Best-effort: failure is logged but does not block message routing.
    const inboundPolicy = this.channelPolicies?.[payload.channelId];
    if (this.workingMemory && inboundPolicy && !inboundPolicy.threaded) {
      try {
        const history = await this.workingMemory.getHistory(
          payload.conversationId, 'coordinator',
        );
        const recentMemos = extractRecentMemos(history, this.contextMemoTtlMs);
        const preamble = buildContextPreamble(recentMemos, taskContent);
        if (preamble !== null) {
          taskContent = preamble;
          this.logger.debug(
            { channelId: payload.channelId, conversationId: payload.conversationId, memoCount: recentMemos.length },
            'Injected outbound context preamble into task content',
          );
        }
      } catch (err) {
        this.logger.warn(
          { err, channelId: payload.channelId, conversationId: payload.conversationId },
          'Failed to read outbound context memos — proceeding without context injection',
        );
      }
    }
```

**Placement:** This must go after `let taskContent` is assigned from `payload.content` (or equivalent), and before the `createAgentTask()` call. The exact location depends on where `taskContent` is first assigned — look for the variable declaration in `handleInbound`. Place the injection block right after it, before any other content transformations (CC preamble, injection scanner, etc.). The context preamble should be the outermost wrapper so other preambles (like CC) stack on top of the user content inside it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test tests/unit/dispatch/dispatcher-context-bridging.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher-context-bridging.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging commit -m "feat: inject outbound context memos into inbound tasks for non-threaded channels (#431)"
```

---

### Task 5: Wire `workingMemory` into bootstrap and update coordinator prompt

**Files:**
- Modify: `src/index.ts:1100-1115` (Dispatcher construction)
- Modify: `agents/coordinator.yaml:152` (after Audience Awareness, before Authorization Enforcement)

- [ ] **Step 1: Pass `memory` to Dispatcher in `index.ts`**

In `src/index.ts`, find the `new Dispatcher({` call (around line 1100). Add `workingMemory: memory,` to the config object:

```typescript
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver,
    contactService,
    heldMessages,
    channelPolicies: authConfig?.channelPolicies,
    injectionScanner,
    rateLimiter,
    pool,
    conversationCheckpointDebounceMs: yamlConfig.dispatch?.conversationCheckpointDebounceMs,
    trustScorerWeights,
    trustScoreFloor,
    maxMessageBytes: yamlConfig.channels?.max_message_bytes ?? 102_400,
    confidencePipeline,
    workingMemory: memory,
  });
```

The `memory` variable is already in scope (created around line 226).

- [ ] **Step 2: Add outbound context directive to coordinator prompt**

In `agents/coordinator.yaml`, insert the following block after the "Audience Awareness" section (after line 152, before "## Authorization Enforcement"):

```yaml

  ## Outbound context
  When your input includes a [PRIOR OUTBOUND CONTEXT] section, the user is likely
  replying to that prior message. Use the context memo (message_preview, key_ids,
  expected_reply) to understand what they are referring to and act accordingly.

  When your input does NOT include a [PRIOR OUTBOUND CONTEXT] section, apply this
  two-part test:

  1. Is the message **self-contained** — fully actionable on its own?
     Examples: "Move the weekly team meeting to 4:30", "What's on my calendar tomorrow?"
     → Proceed normally. No clarification needed.

  2. Is the message **reply-shaped** — only makes sense as a response to something prior?
     Examples: "Yes", "The second one", "Sounds good", "Go ahead"
     → Ask the user what they are referring to before acting.
     Keep it brief: "I lost the thread — what are you replying to?"

```

- [ ] **Step 3: Run the build**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging run build`

Expected: Clean build.

- [ ] **Step 4: Run full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging add src/index.ts agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging commit -m "feat: wire context bridging into bootstrap and add coordinator clarification gate (#431)"
```

---

### Task 6: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry under `## [Unreleased]`**

Add under the appropriate section (create `### Added` if it doesn't exist under Unreleased):

```markdown
### Added
- **Non-threaded channel context bridging** — dispatch layer writes outbound context memos to working memory on non-threaded channels (Signal, CLI, HTTP) and injects them as a preamble when the user replies, so the coordinator knows what it last said. Coordinator prompt gains a channel-agnostic clarification gate for reply-shaped messages without context (#431).
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging commit -m "docs: add changelog entry for non-threaded context bridging (#431)"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the full build**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging run build`

Expected: Clean build, no errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging test`

Expected: All tests PASS, including the new context-memo and dispatcher-context-bridging tests.

- [ ] **Step 3: Review all changes on the branch**

Run: `git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-context-bridging diff main...HEAD --stat`

Verify the file list matches the plan's file map. No unexpected files should be changed.

- [ ] **Step 4: Verify acceptance criteria**

Walk through each criterion from the spec:

1. `ChannelPolicyConfig` has `threaded: boolean` — check `src/contacts/types.ts`
2. `channel-trust.yaml` declares threaded per channel — check the YAML
3. Dispatcher writes outbound memos for `threaded: false` — confirmed by tests
4. Memos are structured (timestamp, source_conversation, preview, task_type, key_ids) — confirmed by `formatOutboundMemo` tests
5. Dispatcher reads memos within TTL and injects preamble — confirmed by tests
6. No preamble when no memos exist — confirmed by tests
7. Coordinator prompt has channel-agnostic clarification gate — check `coordinator.yaml`
8. Integration test: outbound-then-reply flow — `dispatcher-context-bridging.test.ts` first test
9. Integration test: cold-start self-contained — second test (no preamble, content passes through unchanged)
10. Integration test: cold-start reply-shaped — covered by coordinator prompt (LLM behavior, not unit-testable)
