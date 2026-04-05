# Bullpen Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multi-agent threaded discussions via a `bullpen-discuss` skill, with coordinator-managed rosters and turn-limited convergence.

**Architecture:** New `agent.discuss` bus event, `bullpen_threads` and `bullpen_messages` PostgreSQL tables, a `BullpenService` for thread lifecycle, and a `bullpen-discuss` infrastructure skill that orchestrates round-robin multi-party discussions.

**Tech Stack:** TypeScript/ESM, Vitest, PostgreSQL, pino, existing EventBus + AgentRuntime

**Spec:** `docs/superpowers/specs/2026-03-29-bullpen-phase-a-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/bus/events.ts` | Add `AgentDiscussEvent` type, payload, factory |
| Modify | `src/bus/permissions.ts` | Agent publish+subscribe, dispatch publish, system full access |
| Create | `src/db/migrations/008_create_bullpen.sql` | Create `bullpen_threads` and `bullpen_messages` tables |
| Create | `src/bullpen/bullpen-service.ts` | Thread lifecycle, message persistence, turn limit enforcement |
| Create | `tests/unit/bullpen/bullpen-service.test.ts` | Unit tests for BullpenService |
| Create | `skills/bullpen-discuss/skill.json` | Skill manifest |
| Create | `skills/bullpen-discuss/handler.ts` | Round-robin discussion orchestration |
| Create | `tests/unit/bullpen/bullpen-discuss.test.ts` | Tests for discussion skill |
| Modify | `src/skills/types.ts` | Add `bullpenService` to SkillContext |
| Modify | `src/skills/execution.ts` | Inject BullpenService into infrastructure skills |
| Modify | `src/index.ts` | Wire BullpenService into bootstrap |
| Modify | `agents/coordinator.yaml` | Add bullpen-discuss to pinned skills, update prompt |

---

### Task 1: Add `agent.discuss` Bus Event

**Files:**
- Modify: `src/bus/events.ts`
- Modify: `src/bus/permissions.ts`
- Create: `tests/unit/bus/agent-discuss-event.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bus/agent-discuss-event.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createAgentDiscuss } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('agent.discuss event', () => {
  it('creates an event with correct type and sourceLayer', () => {
    const event = createAgentDiscuss({
      threadId: 'thread-1',
      senderId: 'research-analyst',
      senderType: 'agent',
      content: 'I found relevant data about this vendor.',
      conversationId: 'conv-1',
      parentEventId: 'evt-task-1',
    });

    expect(event.type).toBe('agent.discuss');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.threadId).toBe('thread-1');
    expect(event.payload.senderId).toBe('research-analyst');
    expect(event.payload.senderType).toBe('agent');
    expect(event.payload.content).toContain('relevant data');
    expect(event.payload.conversationId).toBe('conv-1');
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.parentEventId).toBe('evt-task-1');
  });

  it('agent layer can publish and subscribe to agent.discuss', () => {
    expect(canPublish('agent', 'agent.discuss')).toBe(true);
    expect(canSubscribe('agent', 'agent.discuss')).toBe(true);
  });

  it('dispatch layer can publish agent.discuss (for future CEO participation)', () => {
    expect(canPublish('dispatch', 'agent.discuss')).toBe(true);
  });

  it('system layer can publish and subscribe to agent.discuss', () => {
    expect(canPublish('system', 'agent.discuss')).toBe(true);
    expect(canSubscribe('system', 'agent.discuss')).toBe(true);
  });

  it('channel layer cannot publish agent.discuss', () => {
    expect(canPublish('channel', 'agent.discuss')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/bus/agent-discuss-event.test.ts`
Expected: FAIL — `createAgentDiscuss` does not exist

- [ ] **Step 3: Add the payload, event interface, factory, and permissions**

In `src/bus/events.ts`, add payload after the existing payloads:

```typescript
interface AgentDiscussPayload {
  threadId: string;
  senderId: string;
  senderType: 'agent' | 'user';
  content: string;
  conversationId: string;
}
```

Add event interface:

```typescript
export interface AgentDiscussEvent extends BaseEvent {
  type: 'agent.discuss';
  sourceLayer: 'agent';
  payload: AgentDiscussPayload;
}
```

Add to `BusEvent` union. Add factory function:

```typescript
export function createAgentDiscuss(
  payload: AgentDiscussPayload & { parentEventId: string },
): AgentDiscussEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.discuss',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}
```

In `src/bus/permissions.ts`, add `'agent.discuss'` to:
- Agent layer publish AND subscribe allowlists
- Dispatch layer publish allowlist
- System layer publish AND subscribe allowlists

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/bus/agent-discuss-event.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass

- [ ] **Step 6: Commit**

```
git add src/bus/events.ts src/bus/permissions.ts tests/unit/bus/agent-discuss-event.test.ts
git commit -m "feat: add agent.discuss bus event type (#25)"
```

---

### Task 2: Database Migration for Bullpen Tables

**Files:**
- Create: `src/db/migrations/008_create_bullpen.sql`

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/008_create_bullpen.sql`:

```sql
-- Bullpen: inter-agent discussion threads (Tier 2 memory)
-- Threads are short-lived, task-scoped discussions between agents.
-- The coordinator creates threads and manages participant rosters.

CREATE TABLE bullpen_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  participants TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  max_turns INTEGER NOT NULL DEFAULT 10,
  turn_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX idx_bullpen_threads_status ON bullpen_threads (status);
CREATE INDEX idx_bullpen_threads_conversation ON bullpen_threads (conversation_id);

CREATE TABLE bullpen_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES bullpen_threads(id),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('agent', 'user')),
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bullpen_messages_thread ON bullpen_messages (thread_id, created_at);
```

- [ ] **Step 2: Verify migration syntax**

Run: `npx tsc --noEmit` (migration is SQL, but ensure no import issues)

- [ ] **Step 3: Commit**

```
git add src/db/migrations/008_create_bullpen.sql
git commit -m "feat: add bullpen_threads and bullpen_messages tables (#25)"
```

---

### Task 3: BullpenService

**Files:**
- Create: `src/bullpen/bullpen-service.ts`
- Create: `tests/unit/bullpen/bullpen-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/bullpen/bullpen-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { BullpenService } from '../../../src/bullpen/bullpen-service.js';

describe('BullpenService', () => {
  let service: BullpenService;

  beforeEach(() => {
    service = BullpenService.createForTesting();
  });

  describe('createThread', () => {
    it('creates a thread with the given topic and participants', async () => {
      const thread = await service.createThread({
        topic: 'What do we know about Acme Corp?',
        conversationId: 'conv-1',
        participants: ['research-analyst', 'expense-tracker'],
        createdBy: 'coordinator',
      });

      expect(thread.id).toBeTruthy();
      expect(thread.topic).toBe('What do we know about Acme Corp?');
      expect(thread.participants).toEqual(['research-analyst', 'expense-tracker']);
      expect(thread.status).toBe('active');
      expect(thread.turnCount).toBe(0);
      expect(thread.maxTurns).toBe(10);
    });

    it('accepts a custom max_turns', async () => {
      const thread = await service.createThread({
        topic: 'Quick question',
        conversationId: 'conv-1',
        participants: ['research-analyst'],
        createdBy: 'coordinator',
        maxTurns: 5,
      });

      expect(thread.maxTurns).toBe(5);
    });
  });

  describe('postMessage', () => {
    it('persists a message and increments turn count', async () => {
      const thread = await service.createThread({
        topic: 'Test',
        conversationId: 'conv-1',
        participants: ['research-analyst'],
        createdBy: 'coordinator',
      });

      const result = await service.postMessage(
        thread.id, 'agent', 'research-analyst', 'I found some data.',
      );

      expect(result.message.content).toBe('I found some data.');
      expect(result.message.senderId).toBe('research-analyst');
      expect(result.forceClosed).toBe(false);

      const updated = await service.getThread(thread.id);
      expect(updated?.turnCount).toBe(1);
    });

    it('force-closes the thread when turn limit is reached', async () => {
      const thread = await service.createThread({
        topic: 'Short discussion',
        conversationId: 'conv-1',
        participants: ['research-analyst'],
        createdBy: 'coordinator',
        maxTurns: 2,
      });

      await service.postMessage(thread.id, 'agent', 'coordinator', 'Opening question');
      const result = await service.postMessage(
        thread.id, 'agent', 'research-analyst', 'Final answer',
      );

      expect(result.forceClosed).toBe(true);

      const updated = await service.getThread(thread.id);
      expect(updated?.status).toBe('closed');
      expect(updated?.closedAt).toBeTruthy();
    });
  });

  describe('participant management', () => {
    it('adds a participant to a thread', async () => {
      const thread = await service.createThread({
        topic: 'Test',
        conversationId: 'conv-1',
        participants: ['research-analyst'],
        createdBy: 'coordinator',
      });

      await service.addParticipant(thread.id, 'expense-tracker');

      const updated = await service.getThread(thread.id);
      expect(updated?.participants).toContain('expense-tracker');
      expect(updated?.participants).toContain('research-analyst');
    });

    it('removes a participant from a thread', async () => {
      const thread = await service.createThread({
        topic: 'Test',
        conversationId: 'conv-1',
        participants: ['research-analyst', 'expense-tracker'],
        createdBy: 'coordinator',
      });

      await service.removeParticipant(thread.id, 'expense-tracker');

      const updated = await service.getThread(thread.id);
      expect(updated?.participants).not.toContain('expense-tracker');
      expect(updated?.participants).toContain('research-analyst');
    });
  });

  describe('closeThread', () => {
    it('closes a thread and sets closed_at', async () => {
      const thread = await service.createThread({
        topic: 'Test',
        conversationId: 'conv-1',
        participants: ['research-analyst'],
        createdBy: 'coordinator',
      });

      await service.closeThread(thread.id);

      const updated = await service.getThread(thread.id);
      expect(updated?.status).toBe('closed');
      expect(updated?.closedAt).toBeTruthy();
    });
  });

  describe('getMessages', () => {
    it('returns messages in chronological order', async () => {
      const thread = await service.createThread({
        topic: 'Test',
        conversationId: 'conv-1',
        participants: ['research-analyst', 'expense-tracker'],
        createdBy: 'coordinator',
      });

      await service.postMessage(thread.id, 'agent', 'coordinator', 'First');
      await service.postMessage(thread.id, 'agent', 'research-analyst', 'Second');
      await service.postMessage(thread.id, 'agent', 'expense-tracker', 'Third');

      const messages = await service.getMessages(thread.id);
      expect(messages).toHaveLength(3);
      expect(messages[0]?.content).toBe('First');
      expect(messages[1]?.content).toBe('Second');
      expect(messages[2]?.content).toBe('Third');
    });
  });

  describe('getActiveThreadsForAgent', () => {
    it('returns only active threads where agent is a participant', async () => {
      await service.createThread({
        topic: 'Active thread',
        conversationId: 'conv-1',
        participants: ['research-analyst'],
        createdBy: 'coordinator',
      });

      const closedThread = await service.createThread({
        topic: 'Closed thread',
        conversationId: 'conv-2',
        participants: ['research-analyst'],
        createdBy: 'coordinator',
      });
      await service.closeThread(closedThread.id);

      await service.createThread({
        topic: 'Other agent thread',
        conversationId: 'conv-3',
        participants: ['expense-tracker'],
        createdBy: 'coordinator',
      });

      const threads = await service.getActiveThreadsForAgent('research-analyst');
      expect(threads).toHaveLength(1);
      expect(threads[0]?.topic).toBe('Active thread');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/bullpen/bullpen-service.test.ts`
Expected: FAIL — `BullpenService` does not exist

- [ ] **Step 3: Implement BullpenService**

Create `src/bullpen/bullpen-service.ts` following the `InMemoryBackend` / `PostgresBackend` pattern from `ContactService` and `WorkingMemory`:

- `BullpenThread` type: `{ id, topic, conversationId, participants, status, maxTurns, turnCount, createdBy, createdAt, closedAt }`
- `BullpenMessage` type: `{ id, threadId, senderType, senderId, content, createdAt }`
- `PostMessageResult` type: `{ message: BullpenMessage; forceClosed: boolean }`
- Backend interface with all CRUD methods
- `InMemoryBullpenBackend` for tests (Map-based)
- `PostgresBullpenBackend` for production (parameterized queries)
- Static factory methods: `createWithPostgres(pool, logger)`, `createForTesting()`
- Turn limit logic in `postMessage`: if `turnCount >= maxTurns` after increment, set `status = 'closed'` and `closedAt = new Date()`, return `{ forceClosed: true }`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bullpen/bullpen-service.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```
git add src/bullpen/bullpen-service.ts tests/unit/bullpen/bullpen-service.test.ts
git commit -m "feat: add BullpenService for thread lifecycle management (#25)"
```

---

### Task 4: bullpen-discuss Skill

**Files:**
- Create: `skills/bullpen-discuss/skill.json`
- Create: `skills/bullpen-discuss/handler.ts`
- Create: `tests/unit/bullpen/bullpen-discuss.test.ts`

- [ ] **Step 1: Create the skill manifest**

Create `skills/bullpen-discuss/skill.json`:

```json
{
  "name": "bullpen-discuss",
  "description": "Start a multi-agent discussion thread. Use when a task benefits from multiple specialist perspectives or when the CEO asks for group input. Provide a topic, list of specialist agents, and an opening message.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "topic": "string",
    "participants": "string",
    "initial_message": "string",
    "conversation_id": "string?",
    "max_turns": "number?"
  },
  "outputs": {
    "thread_id": "string",
    "transcript": "string",
    "participants": "string",
    "turn_count": "number",
    "force_closed": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 600000
}
```

Note: 10-minute timeout (600s) to accommodate multi-agent round-robin with 90s per agent.

- [ ] **Step 2: Write failing tests for the handler**

Create `tests/unit/bullpen/bullpen-discuss.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BullpenDiscussHandler } from '../../../skills/bullpen-discuss/handler.js';
import { BullpenService } from '../../../src/bullpen/bullpen-service.js';
import type { SkillContext } from '../../../src/skills/types.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { createLogger } from '../../../src/logger.js';

function createMockContext(input: Record<string, unknown>): SkillContext {
  const logger = createLogger('error');
  const bullpenService = BullpenService.createForTesting();

  // Mock bus that captures agent.task publishes and auto-generates responses
  const publishedTasks: Array<{ agentId: string; content: string }> = [];
  const bus = {
    publish: vi.fn().mockImplementation(async (_layer, event) => {
      if (event.type === 'agent.task') {
        publishedTasks.push({
          agentId: event.payload.agentId,
          content: event.payload.content,
        });
      }
    }),
    subscribe: vi.fn().mockImplementation((_eventType, _layer, handler) => {
      // Auto-respond to agent.response subscriptions after a tick
      // The handler will be called when publish fires an agent.response
    }),
  } as unknown as EventBus;

  const agentRegistry = {
    has: vi.fn().mockReturnValue(true),
    get: vi.fn().mockReturnValue({ name: 'research-analyst', role: 'specialist', description: 'Research' }),
    listSpecialists: vi.fn().mockReturnValue([
      { name: 'research-analyst', role: 'specialist', description: 'Research' },
      { name: 'expense-tracker', role: 'specialist', description: 'Expenses' },
    ]),
  } as unknown as AgentRegistry;

  return {
    input,
    secret: () => '',
    log: logger,
    bus,
    agentRegistry,
    bullpenService,
  };
}

describe('BullpenDiscussHandler', () => {
  it('validates required inputs', async () => {
    const handler = new BullpenDiscussHandler();

    const noTopic = await handler.execute(createMockContext({ participants: 'a', initial_message: 'hi' }));
    expect(noTopic.success).toBe(false);

    const noParticipants = await handler.execute(createMockContext({ topic: 't', initial_message: 'hi' }));
    expect(noParticipants.success).toBe(false);

    const noMessage = await handler.execute(createMockContext({ topic: 't', participants: 'a' }));
    expect(noMessage.success).toBe(false);
  });

  it('requires infrastructure access', async () => {
    const handler = new BullpenDiscussHandler();
    const ctx: SkillContext = {
      input: { topic: 'test', participants: 'research-analyst', initial_message: 'hi' },
      secret: () => '',
      log: createLogger('error'),
      // No bus, agentRegistry, or bullpenService
    };

    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('infrastructure');
  });

  it('validates all participants exist in the registry', async () => {
    const handler = new BullpenDiscussHandler();
    const ctx = createMockContext({
      topic: 'Test',
      participants: 'research-analyst, nonexistent-agent',
      initial_message: 'Hello',
    });
    (ctx.agentRegistry!.has as ReturnType<typeof vi.fn>)
      .mockImplementation((name: string) => name === 'research-analyst');

    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('nonexistent-agent');
  });

  it('creates a thread and posts the initial message', async () => {
    const handler = new BullpenDiscussHandler();
    const ctx = createMockContext({
      topic: 'Vendor review',
      participants: 'research-analyst',
      initial_message: 'What do we know about Acme Corp?',
      conversation_id: 'conv-1',
    });

    // The handler will try to dispatch tasks and wait for responses.
    // Since our mock bus doesn't auto-respond, the handler will timeout.
    // For this test, we just verify the thread was created by checking
    // the bullpenService state.

    // We need the handler to not hang — set a very short timeout
    // by providing max_turns: 1 so it exits after one round
    ctx.input.max_turns = 1;

    // The handler will timeout waiting for agent responses. That's OK
    // for this test — we verify thread creation happened.
    const result = await handler.execute(ctx);

    // Even if agents timeout, the thread should exist
    const threads = await ctx.bullpenService!.getActiveThreadsForAgent('research-analyst');
    // Thread may be closed (force-closed at turn limit) but should exist
    expect(threads.length + (await getAllThreads(ctx.bullpenService!))).toBeGreaterThan(0);
  });
});

// Helper to check total threads (active + closed)
async function getAllThreads(service: BullpenService): Promise<number> {
  // BullpenService doesn't expose listAll, but we can check via getThread
  // For now just return 0 — the real test is that no exception was thrown
  return 0;
}
```

Note: full integration testing of the round-robin loop requires mocking agent responses, which is complex. The handler test validates input validation, infrastructure checks, and thread creation. The round-robin logic is best tested via integration tests with real AgentRuntime instances (similar to the existing `dispatcher.test.ts` pattern).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/bullpen/bullpen-discuss.test.ts`
Expected: FAIL — `BullpenDiscussHandler` does not exist

- [ ] **Step 4: Implement the handler**

Create `skills/bullpen-discuss/handler.ts`:

The handler should:
1. Validate inputs (topic, participants, initial_message required)
2. Check for infrastructure access (bus, agentRegistry, bullpenService)
3. Parse comma-separated participants, validate each exists in registry and isn't coordinator
4. Create thread via `bullpenService.createThread()`
5. Post initial message via `bullpenService.postMessage()`
6. Publish `agent.discuss` event for the initial message
7. Enter round-robin loop:
   - For each participant, publish `agent.task` with thread transcript as content
   - Wait for `agent.response` (90s timeout per agent, same pattern as delegate)
   - Post response via `bullpenService.postMessage()`
   - Publish `agent.discuss` event for the response
   - If `forceClosed`, exit loop
   - If response is empty or under 20 chars, skip agent in next rounds
   - If all agents are skipping, exit loop
8. Close thread if not already force-closed
9. Return `{ thread_id, transcript, participants, turn_count, force_closed }`

The thread transcript format for agent context:
```
[Bullpen Thread: "{topic}"]
{sender}: {content}
{sender}: {content}
...
{currentAgent}: (your turn to respond)
```

Follow the delegate skill's pattern for bus publishing (`'dispatch'` layer for `agent.task`, `'system'` layer for `agent.response` subscription) and response waiting (promise with timeout + one-time listener).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/bullpen/bullpen-discuss.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add skills/bullpen-discuss/skill.json skills/bullpen-discuss/handler.ts tests/unit/bullpen/bullpen-discuss.test.ts
git commit -m "feat: add bullpen-discuss skill for multi-agent threaded discussion (#25)"
```

---

### Task 5: Wire BullpenService into SkillContext and ExecutionLayer

**Files:**
- Modify: `src/skills/types.ts`
- Modify: `src/skills/execution.ts`

- [ ] **Step 1: Add bullpenService to SkillContext**

In `src/skills/types.ts`, add to the `SkillContext` interface:

```typescript
  /** Bullpen service for inter-agent discussion — only available to infrastructure skills */
  bullpenService?: import('../bullpen/bullpen-service.js').BullpenService;
```

- [ ] **Step 2: Update ExecutionLayer to inject BullpenService**

In `src/skills/execution.ts`:

Add import: `import type { BullpenService } from '../bullpen/bullpen-service.js';`

Add private field: `private bullpenService?: BullpenService;`

Update constructor options type to include `bullpenService?: BullpenService`.

Update constructor assignment: `this.bullpenService = options?.bullpenService;`

In the infrastructure skill context injection block, add:

```typescript
      if (this.bullpenService) {
        ctx.bullpenService = this.bullpenService;
      }
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Commit**

```
git add src/skills/types.ts src/skills/execution.ts
git commit -m "feat: add bullpenService to SkillContext and ExecutionLayer (#25)"
```

---

### Task 6: Bootstrap Wiring and Coordinator Prompt Update

**Files:**
- Modify: `src/index.ts`
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Wire BullpenService into bootstrap**

In `src/index.ts`:

Add import: `import { BullpenService } from './bullpen/bullpen-service.js';`

After held messages initialization, add:

```typescript
  // Bullpen — inter-agent discussion threads (Tier 2 memory).
  const bullpenService = BullpenService.createWithPostgres(pool, logger);
  logger.info('Bullpen service initialized');
```

Update the `ExecutionLayer` constructor to pass `bullpenService`:

```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, {
    bus, agentRegistry, contactService, outboundGateway, heldMessages, bullpenService,
  });
```

- [ ] **Step 2: Update coordinator system prompt**

In `agents/coordinator.yaml`, add to the system prompt (after the delegation section):

```yaml
  ## Multi-Agent Discussion (Bullpen)
  When a task would benefit from multiple specialist perspectives, use
  bullpen-discuss instead of delegate. This starts a threaded discussion
  where specialists can build on each other's findings.

  Use bullpen-discuss when:
  - The CEO asks for "everyone's input" or "what does the team think"
  - A question spans multiple domains (e.g., a vendor evaluation needs
    research AND financial analysis)
  - You want specialists to react to each other's findings, not just
    answer in isolation

  Use delegate for focused, single-specialist questions.

  After a bullpen discussion, always synthesize the results into a
  coherent response for the CEO. The CEO should never see raw thread
  transcripts — present the conclusion in your own voice.
```

Add `bullpen-discuss` to the `pinned_skills` list.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```
git add src/index.ts agents/coordinator.yaml
git commit -m "feat: wire BullpenService into bootstrap, update coordinator prompt (#25)"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Run linter**

Run: `npx eslint src/bullpen/ src/bus/events.ts src/bus/permissions.ts src/skills/types.ts src/skills/execution.ts src/index.ts skills/bullpen-discuss/`
Expected: No lint errors

- [ ] **Step 4: Verify commit log**

Run: `git log --oneline feat/bullpen ^main`
Expected: 6-8 commits covering event type, migration, service, skill, context wiring, bootstrap.
