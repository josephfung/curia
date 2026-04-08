# Conversation Checkpoint Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a conversation checkpoint pipeline that fires after conversational inactivity, fetches new turns since the last watermark, and fans out to background memory skills (`extract-relationships` and future skills).

**Architecture:** Dispatch maintains an in-memory debounce timer per `(conversationId, agentId)`, reset on every `agent.response`. After inactivity, Dispatch queries working memory for new turns, publishes a `conversation.checkpoint` bus event, then cleans up the timer. A new `ConversationCheckpointProcessor` in the System Layer subscribes to that event, runs registered skills concurrently via `ExecutionLayer`, and advances a per-conversation watermark in a new `conversation_checkpoints` Postgres table.

**Tech Stack:** TypeScript/ESM, Node 22, PostgreSQL 16, Vitest, node-pg-migrate, pino

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/migrations/017_create_conversation_checkpoints.sql` | Create | Watermark table |
| `src/bus/events.ts` | Modify | Add `conversation.checkpoint` event type + factory |
| `src/bus/permissions.ts` | Modify | Allow dispatch to publish, system to subscribe |
| `src/checkpoint/processor.ts` | Create | System Layer subscriber — runs skills, advances watermark |
| `src/dispatch/dispatcher.ts` | Modify | Add debounce timer map + `scheduleCheckpoint` + `fireCheckpoint` |
| `src/config.ts` | Modify | Add `dispatch.conversationCheckpointDebounceMs` config field |
| `config/default.yaml` | Modify | Set default debounce value |
| `src/index.ts` | Modify | Instantiate + register `ConversationCheckpointProcessor` |
| `tests/unit/checkpoint/processor.test.ts` | Create | Unit tests for processor |
| `tests/unit/dispatch/dispatcher-checkpoint.test.ts` | Create | Unit tests for debounce timer |
| `tests/integration/checkpoint.test.ts` | Create | Full round-trip integration test |

---

### Task 1: Database migration — conversation_checkpoints table

**Files:**
- Create: `src/db/migrations/017_create_conversation_checkpoints.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Up Migration
-- Watermark table for the conversation checkpoint pipeline.
-- One row per (conversation_id, agent_id) pair — upserted after each checkpoint run.
-- The primary key enforces at-most-one watermark per pair; there is no delete path.

CREATE TABLE conversation_checkpoints (
  conversation_id    TEXT        NOT NULL,
  agent_id           TEXT        NOT NULL,
  last_checkpoint_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id)
);

-- Down Migration
DROP TABLE IF EXISTS conversation_checkpoints;
```

- [ ] **Step 2: Run the migration against the dev database**

```bash
npm --prefix /path/to/worktree run migrate
```

Expected: migration applies cleanly, `conversation_checkpoints` table visible in psql.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/db/migrations/017_create_conversation_checkpoints.sql
git -C /path/to/worktree commit -m "feat: add conversation_checkpoints watermark table (migration 017)"
```

---

### Task 2: Bus event — `conversation.checkpoint`

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`

- [ ] **Step 1: Write a failing test for the event factory**

In `src/bus/events.ts` there are factory functions like `createAgentTask`, `createOutboundMessage`, etc. Add a test in `tests/unit/bus/events.test.ts` (or the closest existing events test file — check `tests/unit/bus/`):

```typescript
import { describe, it, expect } from 'vitest';
import { createConversationCheckpoint } from '../../../src/bus/events.js';

describe('createConversationCheckpoint', () => {
  it('creates a well-formed conversation.checkpoint event', () => {
    const event = createConversationCheckpoint({
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '2026-04-08T10:00:00Z',
      turns: [
        { role: 'user', content: 'Xiaopu is my wife' },
        { role: 'assistant', content: 'Got it, I will remember that.' },
      ],
    });

    expect(event.type).toBe('conversation.checkpoint');
    expect(event.payload.conversationId).toBe('email:thread-abc');
    expect(event.payload.turns).toHaveLength(2);
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm --prefix /path/to/worktree test tests/unit/bus/events.test.ts
```

Expected: FAIL — `createConversationCheckpoint is not a function` (or similar import error).

- [ ] **Step 3: Add the payload interface and event type to events.ts**

Locate the existing payload interfaces (search for `AgentTaskPayload`). Add after the last payload interface:

```typescript
export interface ConversationCheckpointPayload {
  conversationId: string;
  agentId: string;
  channelId: string;
  /** ISO timestamp — turns created after this point are included. Empty string on first checkpoint. */
  since: string;
  /** Ordered chronologically (oldest first). Contains only turns since `since`. */
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}
```

Add to the `BusEvent` discriminated union (find where `type: 'agent.discuss'` is declared and add after it):

```typescript
export interface ConversationCheckpointEvent extends BaseEvent {
  type: 'conversation.checkpoint';
  payload: ConversationCheckpointPayload;
}
```

Add `ConversationCheckpointEvent` to the `BusEvent` union type.

Add `'conversation.checkpoint'` to the `EventType` union (find the existing string union of all event type strings).

Add the factory function (find `createAgentTask` for the pattern):

```typescript
export function createConversationCheckpoint(
  payload: ConversationCheckpointPayload,
): ConversationCheckpointEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'conversation.checkpoint',
    payload,
  };
}
```

- [ ] **Step 4: Run to confirm test passes**

```bash
npm --prefix /path/to/worktree test tests/unit/bus/events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update permissions.ts**

In `src/bus/permissions.ts`, add `'conversation.checkpoint'` to:
- `publishAllowlist.dispatch` — Dispatch publishes this event
- `subscribeAllowlist.system` — System Layer processor subscribes to it

Find the existing string sets and append:

```typescript
// publishAllowlist (dispatch entry):
'conversation.checkpoint'

// subscribeAllowlist (system entry):
'conversation.checkpoint'
```

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/bus/events.ts src/bus/permissions.ts tests/unit/bus/events.test.ts
git -C /path/to/worktree commit -m "feat: add conversation.checkpoint bus event type and factory"
```

---

### Task 3: Config — debounce window

**Files:**
- Modify: `src/config.ts`
- Modify: `config/default.yaml`

- [ ] **Step 1: Add config field**

In `src/config.ts`, find the `dispatch` config section type (or the top-level config type). Add:

```typescript
dispatch?: {
  /** Milliseconds of inactivity before a conversation.checkpoint event is published.
   *  Defaults to 600000 (10 minutes). */
  conversationCheckpointDebounceMs?: number;
};
```

If `dispatch` already exists in the type, add only the new field.

- [ ] **Step 2: Add default value to config/default.yaml**

```yaml
dispatch:
  conversationCheckpointDebounceMs: 600000   # 10 minutes
```

If `dispatch:` already exists in the file, add only the new key under it.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/config.ts config/default.yaml
git -C /path/to/worktree commit -m "feat: add dispatch.conversationCheckpointDebounceMs config field"
```

---

### Task 4: ConversationCheckpointProcessor

**Files:**
- Create: `src/checkpoint/processor.ts`
- Create: `tests/unit/checkpoint/processor.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/checkpoint/processor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationCheckpointProcessor } from '../../../src/checkpoint/processor.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';
import { createConversationCheckpoint } from '../../../src/bus/events.js';

function makeStubs() {
  const subscribeHandlers = new Map<string, (event: unknown) => Promise<void>>();
  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: unknown) => Promise<void>) => {
      subscribeHandlers.set(eventType, handler);
    }),
  } as unknown as EventBus;

  const executionLayer = {
    invoke: vi.fn().mockResolvedValue({ success: true, data: {} }),
  } as unknown as ExecutionLayer;

  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  const pool = { query: queryMock } as unknown as DbPool;

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;

  return { bus, executionLayer, pool, logger, subscribeHandlers, queryMock };
}

async function fireCheckpoint(
  subscribeHandlers: Map<string, (event: unknown) => Promise<void>>,
  payload: {
    conversationId: string;
    agentId: string;
    channelId: string;
    since: string;
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  },
) {
  const event = createConversationCheckpoint(payload);
  const handler = subscribeHandlers.get('conversation.checkpoint');
  if (!handler) throw new Error('No handler registered for conversation.checkpoint');
  await handler(event);
}

describe('ConversationCheckpointProcessor', () => {
  let stubs: ReturnType<typeof makeStubs>;

  beforeEach(() => {
    stubs = makeStubs();
  });

  it('registers a conversation.checkpoint subscriber on register()', () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();
    expect(stubs.bus.subscribe).toHaveBeenCalledWith(
      'conversation.checkpoint', 'system', expect.any(Function),
    );
  });

  it('calls extract-relationships with concatenated transcript', async () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [
        { role: 'user', content: 'Xiaopu is my wife' },
        { role: 'assistant', content: 'Got it.' },
      ],
    });

    expect(stubs.executionLayer.invoke).toHaveBeenCalledWith(
      'extract-relationships',
      expect.objectContaining({
        text: 'User: Xiaopu is my wife\n\nCuria: Got it.',
        source: expect.stringContaining('email:thread-abc'),
      }),
      expect.anything(),
    );
  });

  it('advances the watermark after skills run', async () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [{ role: 'user', content: 'test' }],
    });

    expect(stubs.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_checkpoints'),
      ['email:thread-abc', 'coordinator'],
    );
  });

  it('advances the watermark even when a skill fails', async () => {
    stubs.executionLayer.invoke = vi.fn().mockRejectedValue(new Error('API timeout'));
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [{ role: 'user', content: 'test' }],
    });

    // Watermark upsert still called despite skill failure
    expect(stubs.queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO conversation_checkpoints'),
      expect.any(Array),
    );
  });

  it('does nothing when turns list is empty', async () => {
    const processor = new ConversationCheckpointProcessor(
      stubs.bus, stubs.executionLayer, stubs.pool, stubs.logger,
    );
    processor.register();

    await fireCheckpoint(stubs.subscribeHandlers, {
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '',
      turns: [],
    });

    expect(stubs.executionLayer.invoke).not.toHaveBeenCalled();
    expect(stubs.queryMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npm --prefix /path/to/worktree test tests/unit/checkpoint/processor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ConversationCheckpointProcessor**

Create `src/checkpoint/processor.ts`:

```typescript
import type { EventBus } from '../bus/bus.js';
import type { ExecutionLayer } from '../skills/execution.js';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import type { ConversationCheckpointEvent } from '../bus/events.js';

// Skills invoked at every checkpoint, in addition to any future skills.
// Add new checkpoint skills here — no changes to Dispatch or the runtime required.
const CHECKPOINT_SKILLS: Array<{ name: string }> = [
  { name: 'extract-relationships' },
  // { name: 'extract-entities' },  // add when issue #151 is built
];

export class ConversationCheckpointProcessor {
  constructor(
    private bus: EventBus,
    private executionLayer: ExecutionLayer,
    private pool: DbPool,
    private logger: Logger,
  ) {}

  register(): void {
    this.bus.subscribe('conversation.checkpoint', 'system', async (event) => {
      await this.handleCheckpoint(event as ConversationCheckpointEvent);
    });
  }

  private async handleCheckpoint(event: ConversationCheckpointEvent): Promise<void> {
    const { conversationId, agentId, channelId, turns } = event.payload;

    if (turns.length === 0) return;

    const transcript = turns
      .map(t => `${t.role === 'user' ? 'User' : 'Curia'}: ${t.content}`)
      .join('\n\n');

    const source = `system:checkpoint/conversation:${conversationId}/agent:${agentId}/channel:${channelId}`;

    // Caller context for ExecutionLayer — system-layer invocations are trusted
    // and have no human sender. Use a minimal CallerContext.
    const callerContext = {
      layer: 'system' as const,
      agentId,
      conversationId,
    };

    // Run all checkpoint skills concurrently. A failure in one must not block the
    // others or prevent the watermark from advancing — hence Promise.allSettled.
    await Promise.allSettled(
      CHECKPOINT_SKILLS.map(skill =>
        this.executionLayer.invoke(skill.name, { text: transcript, source }, callerContext)
          .catch(err =>
            this.logger.error(
              { err, skill: skill.name, conversationId },
              'checkpoint skill failed — watermark will still advance',
            ),
          ),
      ),
    );

    // Advance the watermark. Upsert so first checkpoint creates the row.
    await this.pool.query(
      `INSERT INTO conversation_checkpoints (conversation_id, agent_id, last_checkpoint_at)
       VALUES ($1, $2, now())
       ON CONFLICT (conversation_id, agent_id)
       DO UPDATE SET last_checkpoint_at = now()`,
      [conversationId, agentId],
    );

    this.logger.info({ conversationId, agentId, turnCount: turns.length }, 'Conversation checkpoint complete');
  }
}
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
npm --prefix /path/to/worktree test tests/unit/checkpoint/processor.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/checkpoint/processor.ts tests/unit/checkpoint/processor.test.ts
git -C /path/to/worktree commit -m "feat: add ConversationCheckpointProcessor (System Layer)"
```

---

### Task 5: Dispatcher debounce

**Files:**
- Modify: `src/dispatch/dispatcher.ts`
- Create: `tests/unit/dispatch/dispatcher-checkpoint.test.ts`

- [ ] **Step 1: Write failing tests for the debounce**

Create `tests/unit/dispatch/dispatcher-checkpoint.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';
import { createAgentResponse } from '../../../src/bus/events.js';

function makeStubs(debounceMs = 500) {
  const publishedEvents: unknown[] = [];
  const subscribeHandlers = new Map<string, (event: unknown) => Promise<void>>();

  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: unknown) => Promise<void>) => {
      subscribeHandlers.set(eventType, handler);
    }),
    publish: vi.fn(async (_layer: string, event: unknown) => {
      publishedEvents.push(event);
    }),
  } as unknown as EventBus;

  const queryMock = vi.fn().mockResolvedValue({ rows: [] });
  const pool = { query: queryMock } as unknown as DbPool;

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;

  const dispatcher = new Dispatcher({
    bus,
    logger,
    pool,
    conversationCheckpointDebounceMs: debounceMs,
  });

  return { dispatcher, bus, pool, logger, publishedEvents, subscribeHandlers, queryMock };
}

async function fireAgentResponse(
  subscribeHandlers: Map<string, (event: unknown) => Promise<void>>,
  {
    taskEventId,
    conversationId,
    agentId,
    channelId,
    content = 'ok',
  }: { taskEventId: string; conversationId: string; agentId: string; channelId: string; content?: string },
) {
  const event = createAgentResponse({
    agentId,
    conversationId,
    channelId,
    content,
    parentEventId: taskEventId,
  });
  const handler = subscribeHandlers.get('agent.response');
  if (!handler) throw new Error('No agent.response handler registered');
  await handler(event);
}

describe('Dispatcher checkpoint debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('publishes conversation.checkpoint after debounce window elapses', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(500);
    dispatcher.register();

    // Seed routing so agent.response is handled
    // (pre-seed taskRouting via the internal map — reach in via the response handler)
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
    });

    // No checkpoint yet
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(0);

    // Advance time past debounce
    await vi.advanceTimersByTimeAsync(600);

    const checkpoints = publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint');
    expect(checkpoints).toHaveLength(1);
    expect((checkpoints[0] as any).payload.conversationId).toBe('email:thread-abc');
  });

  it('resets the timer on a second agent.response before debounce elapses', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(500);
    dispatcher.register();

    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
    });

    await vi.advanceTimersByTimeAsync(300); // not yet elapsed

    // Second response — resets timer
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-2',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
    });

    await vi.advanceTimersByTimeAsync(300); // 300ms after reset — still not elapsed
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300); // now past debounce from second response
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(1);
  });

  it('clears all timers on close() — no checkpoint fires after shutdown', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(500);
    dispatcher.register();

    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
    });

    dispatcher.close();

    await vi.advanceTimersByTimeAsync(1000);
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npm --prefix /path/to/worktree test tests/unit/dispatch/dispatcher-checkpoint.test.ts
```

Expected: FAIL — `pool` not in `DispatcherConfig`, `close()` not defined, debounce not implemented.

- [ ] **Step 3: Add pool and debounce config to DispatcherConfig**

In `src/dispatch/dispatcher.ts`, update the `DispatcherConfig` interface:

```typescript
export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
  heldMessages?: HeldMessageService;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
  injectionScanner?: InboundScanner;
  /** Postgres pool — used to query working_memory for checkpoint turns. */
  pool: DbPool;
  /** Milliseconds of inactivity before conversation.checkpoint fires. Default: 600000. */
  conversationCheckpointDebounceMs?: number;
}
```

- [ ] **Step 4: Add the debounce timer map and close() to the Dispatcher class**

In the `Dispatcher` class, add properties after `private taskRouting`:

```typescript
/** Key: `${conversationId}:${agentId}` — reset on every agent.response */
private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
private pool: DbPool;
private conversationCheckpointDebounceMs: number;
```

Update the constructor body to assign them:

```typescript
this.pool = config.pool;
this.conversationCheckpointDebounceMs = config.conversationCheckpointDebounceMs ?? 600_000;
```

Add a `close()` method at the end of the class:

```typescript
/** Clear all pending checkpoint timers. Call during graceful shutdown. */
close(): void {
  for (const timer of this.checkpointTimers.values()) {
    clearTimeout(timer);
  }
  this.checkpointTimers.clear();
}
```

- [ ] **Step 5: Implement scheduleCheckpoint and fireCheckpoint**

Add these two private methods to the `Dispatcher` class:

```typescript
private scheduleCheckpoint(conversationId: string, agentId: string, channelId: string): void {
  const key = `${conversationId}:${agentId}`;
  const existing = this.checkpointTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    this.checkpointTimers.delete(key);
    // Fire-and-forget — errors are logged inside fireCheckpoint
    void this.fireCheckpoint(conversationId, agentId, channelId);
  }, this.conversationCheckpointDebounceMs);

  this.checkpointTimers.set(key, timer);
}

private async fireCheckpoint(conversationId: string, agentId: string, channelId: string): Promise<void> {
  try {
    // Look up the last watermark for this conversation+agent pair
    const watermarkResult = await this.pool.query<{ last_checkpoint_at: string }>(
      `SELECT last_checkpoint_at FROM conversation_checkpoints
       WHERE conversation_id = $1 AND agent_id = $2`,
      [conversationId, agentId],
    );
    const since = watermarkResult.rows[0]?.last_checkpoint_at ?? '';

    // Fetch turns from working memory since the watermark
    const turnsResult = await this.pool.query<{ role: string; content: string }>(
      `SELECT role, content FROM working_memory
       WHERE conversation_id = $1 AND agent_id = $2
         AND role IN ('user', 'assistant')
         ${since ? 'AND created_at > $3' : ''}
       ORDER BY created_at ASC`,
      since ? [conversationId, agentId, since] : [conversationId, agentId],
    );

    if (turnsResult.rows.length === 0) {
      // Nothing new since last checkpoint — skip publishing
      return;
    }

    const turns = turnsResult.rows.map(row => ({
      role: row.role as 'user' | 'assistant',
      content: row.content,
    }));

    const event = createConversationCheckpoint({
      conversationId,
      agentId,
      channelId,
      since,
      turns,
    });

    await this.bus.publish('dispatch', event);
    this.logger.info({ conversationId, agentId, turnCount: turns.length }, 'Conversation checkpoint published');
  } catch (err) {
    this.logger.error({ err, conversationId, agentId }, 'Failed to fire conversation checkpoint');
  }
}
```

Also add the import for `createConversationCheckpoint` at the top of `dispatcher.ts`:

```typescript
import { createConversationCheckpoint } from '../bus/events.js';
```

And add the `DbPool` import:

```typescript
import type { DbPool } from '../db/connection.js';
```

- [ ] **Step 6: Call scheduleCheckpoint from handleAgentResponse**

In the existing `handleAgentResponse` method, after `await this.bus.publish('dispatch', outbound)`, add:

```typescript
// Schedule a checkpoint for this conversation — resets the debounce timer if
// already running, so only fires after a full window of inactivity.
this.scheduleCheckpoint(routing.conversationId, event.payload.agentId, routing.channelId);
```

- [ ] **Step 7: Run tests**

```bash
npm --prefix /path/to/worktree test tests/unit/dispatch/dispatcher-checkpoint.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 8: Commit**

```bash
git -C /path/to/worktree add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher-checkpoint.test.ts
git -C /path/to/worktree commit -m "feat: add conversation checkpoint debounce to Dispatcher"
```

---

### Task 6: Wire ConversationCheckpointProcessor into index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import**

Near the other System Layer imports (audit logger, scheduler), add:

```typescript
import { ConversationCheckpointProcessor } from './checkpoint/processor.js';
```

- [ ] **Step 2: Instantiate and register**

Find where `auditLogger` and `scheduler` are registered. After them, add:

```typescript
// Conversation checkpoint processor — System Layer subscriber that runs
// background memory skills (extract-relationships, etc.) at end of conversation.
const checkpointProcessor = new ConversationCheckpointProcessor(bus, executionLayer, pool, logger);
checkpointProcessor.register();
```

- [ ] **Step 3: Pass pool to Dispatcher**

The `Dispatcher` constructor now requires `pool`. Find the `new Dispatcher({...})` call and add:

```typescript
pool,
```

- [ ] **Step 4: Call dispatcher.close() in shutdown**

Find the graceful shutdown block (where `pool.end()` is called). Add before it:

```typescript
dispatcher.close();
```

- [ ] **Step 5: Run all tests**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add src/index.ts
git -C /path/to/worktree commit -m "feat: register ConversationCheckpointProcessor in bootstrap"
```

---

### Task 7: Integration test — full round-trip

**Files:**
- Create: `tests/integration/checkpoint.test.ts`

This test requires Docker Postgres. Check existing integration tests (e.g. `tests/integration/extract-relationships.test.ts`) for the setup/teardown pattern — connection string, migration runner, and cleanup.

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool } from '../../src/db/connection.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { ConversationCheckpointProcessor } from '../../src/checkpoint/processor.js';
import { createConversationCheckpoint } from '../../src/bus/events.js';
// Import ExecutionLayer, SkillRegistry, EntityMemory — follow pattern from existing integration tests

// Use the same test DB URL pattern as existing integration tests
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/curia_test';

describe('ConversationCheckpointProcessor — integration', () => {
  let pool: ReturnType<typeof createPool>;
  let memory: WorkingMemory;
  const conversationId = `test:checkpoint-${Date.now()}`;
  const agentId = 'coordinator';

  beforeAll(async () => {
    pool = createPool(TEST_DB_URL, { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any);
    memory = WorkingMemory.createWithPostgres(pool, { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as any);
    // Insert test turns
    await memory.addTurn(conversationId, agentId, { role: 'user', content: 'Xiaopu Fung is my wife' });
    await memory.addTurn(conversationId, agentId, { role: 'assistant', content: 'Got it, I will remember that.' });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM conversation_checkpoints WHERE conversation_id = $1', [conversationId]);
    await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [conversationId]);
    await pool.query('DELETE FROM kg_edges WHERE source = $1', [`system:checkpoint/conversation:${conversationId}/agent:${agentId}/channel:test`]);
    await pool.end();
  });

  it('runs extract-relationships and persists a watermark', async () => {
    // Build a minimal ExecutionLayer with real skill registry — follow existing integration test patterns
    // ... (see tests/integration/extract-relationships.test.ts for exact setup)

    const bus = { subscribe: vi.fn(), publish: vi.fn() } as any;
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;

    const processor = new ConversationCheckpointProcessor(bus, executionLayer, pool, logger);
    processor.register();

    // Fire checkpoint directly (bypasses debounce)
    const event = createConversationCheckpoint({
      conversationId,
      agentId,
      channelId: 'test',
      since: '',
      turns: [
        { role: 'user', content: 'Xiaopu Fung is my wife' },
        { role: 'assistant', content: 'Got it, I will remember that.' },
      ],
    });

    const handler = (bus.subscribe as any).mock.calls[0][2];
    await handler(event);

    // Watermark created
    const watermark = await pool.query(
      'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
      [conversationId, agentId],
    );
    expect(watermark.rows).toHaveLength(1);
    expect(new Date(watermark.rows[0].last_checkpoint_at).getTime()).toBeGreaterThan(Date.now() - 5000);

    // Relationship persisted — a spouse edge should exist between Xiaopu and Joseph
    const edges = await pool.query(
      `SELECT e.type FROM kg_edges e
       JOIN kg_nodes n1 ON e.source_node_id = n1.id
       JOIN kg_nodes n2 ON e.target_node_id = n2.id
       WHERE n1.label ILIKE '%xiaopu%' OR n2.label ILIKE '%xiaopu%'`,
    );
    expect(edges.rows.length).toBeGreaterThan(0);
    expect(edges.rows.some((r: any) => r.type === 'spouse')).toBe(true);
  });

  it('respects the watermark on second checkpoint — does not reprocess old turns', async () => {
    // Add new turns after the first checkpoint
    await memory.addTurn(conversationId, agentId, { role: 'user', content: 'Ada Chen is the lead on Project Orion' });
    await memory.addTurn(conversationId, agentId, { role: 'assistant', content: 'Noted.' });

    // Get current watermark
    const before = await pool.query(
      'SELECT last_checkpoint_at FROM conversation_checkpoints WHERE conversation_id = $1 AND agent_id = $2',
      [conversationId, agentId],
    );
    const since = before.rows[0].last_checkpoint_at;

    const invokedTexts: string[] = [];
    const spyLayer = {
      invoke: vi.fn(async (_name: string, input: Record<string, string>) => {
        invokedTexts.push(input.text);
        return { success: true, data: {} };
      }),
    } as any;

    const bus = { subscribe: vi.fn(), publish: vi.fn() } as any;
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any;
    const processor = new ConversationCheckpointProcessor(bus, spyLayer, pool, logger);
    processor.register();

    const event = createConversationCheckpoint({
      conversationId,
      agentId,
      channelId: 'test',
      since,
      turns: [
        { role: 'user', content: 'Ada Chen is the lead on Project Orion' },
        { role: 'assistant', content: 'Noted.' },
      ],
    });

    const handler = (bus.subscribe as any).mock.calls[0][2];
    await handler(event);

    // Only the two new turns in the transcript — not the original spouse turns
    expect(invokedTexts[0]).toContain('Ada Chen');
    expect(invokedTexts[0]).not.toContain('Xiaopu');
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
npm --prefix /path/to/worktree test tests/integration/checkpoint.test.ts
```

Expected: both tests PASS (requires Docker Postgres with migrations applied).

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add tests/integration/checkpoint.test.ts
git -C /path/to/worktree commit -m "test: add conversation checkpoint integration tests"
```

---

### Task 8: CHANGELOG and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

This is a new minor-level feature (new system component, new bus event type, new DB table).

- [ ] **Step 1: Add entry under `## [Unreleased]`**

```markdown
### Added
- **Conversation checkpoint pipeline** — Dispatch publishes a `conversation.checkpoint` event after 10 minutes of inactivity per conversation. A new System Layer `ConversationCheckpointProcessor` subscribes, concatenates new turns since the last watermark, fans out to background memory skills (`extract-relationships`; extensible to future skills), then advances a per-conversation watermark in the new `conversation_checkpoints` table. Adds migration 017.

### Changed
- **`extract-relationships` removed from coordinator tool loop** — extraction now runs via the checkpoint pipeline rather than as an LLM tool call. Fixes Signal and web chat confabulation bugs (see hotfix PR).
```

- [ ] **Step 2: Bump minor version in package.json**

```json
"version": "0.19.0"
```

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add CHANGELOG.md package.json
git -C /path/to/worktree commit -m "chore: release 0.19.0 — conversation checkpoint pipeline"
```
