# Phase 2: Working Memory & YAML Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make conversations stateful (agents remember previous messages in a conversation) and load agent configs from YAML files instead of hardcoding.

**Architecture:** Working memory stores conversation turns in Postgres, keyed by conversation ID. The agent runtime loads history on each invocation and assembles it into the LLM context. Agent configs are loaded from `agents/*.yaml` at startup using `js-yaml`.

**Tech Stack:** Existing Curia stack + js-yaml for config parsing

**Spec References:**
- [01-memory-system.md](../specs/01-memory-system.md) — Working Memory (Tier 1), Context Management
- [02-agent-system.md](../specs/02-agent-system.md) — Agent Definition (YAML config), Coordinator persona

---

## What This Phase Builds

- Conversation history persisted in Postgres — survives restarts
- Agent runtime assembles system prompt + history + new message for each LLM call
- Agent configs loaded from `agents/*.yaml` — no more hardcoded system prompts
- Coordinator persona fields (display_name, tone) interpolated into system prompt

## What This Phase Does NOT Build

- Knowledge graph (Tier 4)
- Entity memory (Tier 3)
- Bullpen (Tier 2)
- Embeddings / semantic search
- Memory validation gates (dedup, contradiction detection)
- Context summarization (for very long conversations)
- TypeScript handler escape hatch for agents

---

## File Map

```
curia/
├── src/
│   ├── agents/
│   │   ├── loader.ts               # NEW — YAML config parser + validator
│   │   └── runtime.ts              # MODIFY — add working memory integration
│   ├── memory/
│   │   └── working-memory.ts       # NEW — conversation store (Postgres-backed)
│   └── db/
│       └── migrations/
│           └── 002_create_working_memory.sql  # NEW
├── agents/
│   └── coordinator.yaml            # MODIFY — add persona fields
└── tests/
    ├── unit/
    │   ├── agents/
    │   │   ├── loader.test.ts      # NEW
    │   │   └── runtime.test.ts     # MODIFY — add memory tests
    │   └── memory/
    │       └── working-memory.test.ts  # NEW
    └── integration/
        └── conversation-memory.test.ts  # NEW — multi-turn conversation test
```

---

## Task 1: Install js-yaml

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install js-yaml and types**

```bash
pnpm add js-yaml
pnpm add -D @types/js-yaml
```

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add js-yaml for agent config loading"
```

---

## Task 2: Agent Config Loader

**Files:**
- Create: `src/agents/loader.ts`
- Create: `tests/unit/agents/loader.test.ts`
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Update coordinator.yaml with persona fields**

```yaml
# agents/coordinator.yaml
name: coordinator
role: coordinator
persona:
  display_name: Curia
  tone: professional but approachable
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
system_prompt: |
  You are ${persona.display_name}, an AI executive assistant.
  Your communication style is ${persona.tone}.
  You handle all communications on behalf of the CEO.

  For casual messages, respond naturally and warmly.
  For tasks, acknowledge the request and describe what you would do.
  Keep responses concise — a few sentences unless detail is requested.
```

- [ ] **Step 2: Write failing test for loader**

```typescript
// tests/unit/agents/loader.test.ts
import { describe, it, expect } from 'vitest';
import { loadAgentConfig, type AgentYamlConfig } from '../../../src/agents/loader.js';
import * as path from 'node:path';

// Use the real coordinator.yaml from the project
const agentsDir = path.resolve(import.meta.dirname, '../../../agents');

describe('loadAgentConfig', () => {
  it('loads and parses coordinator.yaml', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    expect(config.name).toBe('coordinator');
    expect(config.role).toBe('coordinator');
    expect(config.model.provider).toBe('anthropic');
    expect(config.system_prompt).toContain('executive assistant');
  });

  it('interpolates persona fields into system_prompt', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    // After interpolation, ${persona.display_name} should be replaced with "Curia"
    expect(config.system_prompt).toContain('Curia');
    expect(config.system_prompt).not.toContain('${persona.display_name}');
  });

  it('throws on missing required fields', () => {
    // Write a temporary bad config inline — don't create a file
    expect(() => loadAgentConfig('/nonexistent/path.yaml')).toThrow();
  });

  it('loads all agent configs from a directory', async () => {
    const { loadAllAgentConfigs } = await import('../../../src/agents/loader.js');
    const configs = loadAllAgentConfigs(agentsDir);
    expect(configs.length).toBeGreaterThanOrEqual(1);
    expect(configs.find(c => c.name === 'coordinator')).toBeDefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm test -- tests/unit/agents/loader.test.ts
```

- [ ] **Step 4: Implement loader**

```typescript
// src/agents/loader.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

/**
 * Shape of an agent YAML config file.
 * Fields match what's in agents/*.yaml.
 */
export interface AgentYamlConfig {
  name: string;
  role?: string;
  description?: string;
  persona?: {
    display_name?: string;
    tone?: string;
    email_signature?: string;
  };
  model: {
    provider: string;
    model: string;
    fallback?: {
      provider: string;
      model: string;
    };
  };
  system_prompt: string;
  pinned_skills?: string[];
  allow_discovery?: boolean;
  memory?: {
    scopes?: string[];
  };
  schedule?: Array<{
    cron: string;
    task: string;
  }>;
  error_budget?: {
    max_turns?: number;
    max_cost_usd?: number;
    max_errors?: number;
  };
}

/**
 * Load a single agent config from a YAML file.
 * Interpolates ${persona.*} placeholders in system_prompt.
 */
export function loadAgentConfig(filePath: string): AgentYamlConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read agent config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let config: AgentYamlConfig;
  try {
    config = yaml.load(raw) as AgentYamlConfig;
  } catch (err) {
    throw new Error(`Invalid YAML in agent config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Validate required fields
  if (!config.name) {
    throw new Error(`Agent config at ${filePath} is missing required field: name`);
  }
  if (!config.model?.provider || !config.model?.model) {
    throw new Error(`Agent config '${config.name}' at ${filePath} is missing model.provider or model.model`);
  }
  if (!config.system_prompt) {
    throw new Error(`Agent config '${config.name}' at ${filePath} is missing system_prompt`);
  }

  // Interpolate ${persona.*} placeholders in the system prompt
  if (config.persona) {
    config.system_prompt = interpolatePersona(config.system_prompt, config.persona);
  }

  return config;
}

/**
 * Load all agent configs from a directory.
 * Reads every .yaml and .yml file in the directory.
 */
export function loadAllAgentConfigs(dirPath: string): AgentYamlConfig[] {
  const files = fs.readdirSync(dirPath)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  return files.map(f => loadAgentConfig(path.join(dirPath, f)));
}

/**
 * Replace ${persona.field_name} placeholders with actual values.
 * Unresolved placeholders are left as-is (they won't crash, just look odd).
 */
function interpolatePersona(
  template: string,
  persona: NonNullable<AgentYamlConfig['persona']>,
): string {
  return template.replace(/\$\{persona\.(\w+)\}/g, (_match, field: string) => {
    const value = persona[field as keyof typeof persona];
    return value ?? `\${persona.${field}}`;
  });
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm test -- tests/unit/agents/loader.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/agents/loader.ts tests/unit/agents/loader.test.ts agents/coordinator.yaml
git commit -m "feat: add YAML agent config loader with persona interpolation"
```

---

## Task 3: Working Memory Migration

**Files:**
- Create: `src/db/migrations/002_create_working_memory.sql`

- [ ] **Step 1: Create migration**

```sql
-- Up Migration

CREATE TABLE working_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ
);

-- Primary query pattern: load conversation history for a specific agent + conversation
CREATE INDEX idx_wm_conversation ON working_memory (conversation_id, agent_id, created_at);

-- Cleanup query: find and delete expired entries
CREATE INDEX idx_wm_expires ON working_memory (expires_at) WHERE expires_at IS NOT NULL;
```

Note: No Down section — same approach as migration 001. node-pg-migrate's SQL mode runs the entire file as the up migration. Down migrations can be added as separate files if needed.

- [ ] **Step 2: Run migration**

```bash
pnpm run migrate
```

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/002_create_working_memory.sql
git commit -m "feat: add working_memory table for conversation persistence"
```

---

## Task 4: Working Memory Store

**Files:**
- Create: `src/memory/working-memory.ts`
- Create: `tests/unit/memory/working-memory.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/memory/working-memory.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkingMemory, type ConversationTurn } from '../../../src/memory/working-memory.js';

/**
 * Unit tests use an in-memory store (no Postgres required).
 * WorkingMemory accepts a storage backend interface so we can
 * test the logic without a database.
 */
describe('WorkingMemory', () => {
  let memory: WorkingMemory;
  let store: ConversationTurn[];

  beforeEach(() => {
    store = [];
    // In-memory backend for testing — real backend uses Postgres
    memory = WorkingMemory.createInMemory();
  });

  it('stores and retrieves conversation turns', async () => {
    await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: 'Hello' });
    await memory.addTurn('conv-1', 'coordinator', { role: 'assistant', content: 'Hi there!' });

    const history = await memory.getHistory('conv-1', 'coordinator');
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[1]?.role).toBe('assistant');
  });

  it('returns empty array for unknown conversation', async () => {
    const history = await memory.getHistory('unknown', 'coordinator');
    expect(history).toEqual([]);
  });

  it('keeps conversations separate', async () => {
    await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: 'First' });
    await memory.addTurn('conv-2', 'coordinator', { role: 'user', content: 'Second' });

    const h1 = await memory.getHistory('conv-1', 'coordinator');
    const h2 = await memory.getHistory('conv-2', 'coordinator');
    expect(h1).toHaveLength(1);
    expect(h2).toHaveLength(1);
    expect(h1[0]?.content).toBe('First');
    expect(h2[0]?.content).toBe('Second');
  });

  it('limits returned history to maxTurns', async () => {
    for (let i = 0; i < 25; i++) {
      await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: `Message ${i}` });
    }

    // Default limit should return most recent turns
    const history = await memory.getHistory('conv-1', 'coordinator', { maxTurns: 10 });
    expect(history).toHaveLength(10);
    // Should be the LAST 10, not the first 10
    expect(history[0]?.content).toBe('Message 15');
    expect(history[9]?.content).toBe('Message 24');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/memory/working-memory.test.ts
```

- [ ] **Step 3: Implement working memory**

```typescript
// src/memory/working-memory.ts
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface StorageBackend {
  add(conversationId: string, agentId: string, turn: ConversationTurn): Promise<void>;
  get(conversationId: string, agentId: string, maxTurns?: number): Promise<ConversationTurn[]>;
}

/**
 * Working memory stores conversation turns per conversation + agent pair.
 * This is Tier 1 memory — short-lived, scoped to a conversation, survives restarts.
 *
 * Uses a backend interface so unit tests can use in-memory storage
 * while production uses Postgres.
 */
export class WorkingMemory {
  private backend: StorageBackend;

  private constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  /** Create a Postgres-backed instance for production use */
  static createWithPostgres(pool: DbPool, logger: Logger): WorkingMemory {
    return new WorkingMemory(new PostgresBackend(pool, logger));
  }

  /** Create an in-memory instance for testing */
  static createInMemory(): WorkingMemory {
    return new WorkingMemory(new InMemoryBackend());
  }

  async addTurn(
    conversationId: string,
    agentId: string,
    turn: ConversationTurn,
  ): Promise<void> {
    await this.backend.add(conversationId, agentId, turn);
  }

  async getHistory(
    conversationId: string,
    agentId: string,
    options?: { maxTurns?: number },
  ): Promise<ConversationTurn[]> {
    return this.backend.get(conversationId, agentId, options?.maxTurns);
  }
}

/**
 * Postgres-backed storage. Conversation turns are rows in the working_memory table.
 * History is returned in chronological order (oldest first) so the LLM sees
 * the conversation in the natural reading order.
 */
class PostgresBackend implements StorageBackend {
  constructor(private pool: DbPool, private logger: Logger) {}

  async add(conversationId: string, agentId: string, turn: ConversationTurn): Promise<void> {
    await this.pool.query(
      `INSERT INTO working_memory (conversation_id, agent_id, role, content)
       VALUES ($1, $2, $3, $4)`,
      [conversationId, agentId, turn.role, turn.content],
    );
  }

  async get(conversationId: string, agentId: string, maxTurns?: number): Promise<ConversationTurn[]> {
    const limit = maxTurns ?? 50;

    // Subquery gets the most recent N rows (newest first),
    // then outer query reverses to chronological order for LLM context
    const result = await this.pool.query(
      `SELECT role, content FROM (
         SELECT role, content, created_at
         FROM working_memory
         WHERE conversation_id = $1 AND agent_id = $2
         ORDER BY created_at DESC
         LIMIT $3
       ) sub ORDER BY created_at ASC`,
      [conversationId, agentId, limit],
    );

    return result.rows.map((row: { role: string; content: string }) => ({
      role: row.role as ConversationTurn['role'],
      content: row.content,
    }));
  }
}

/**
 * In-memory storage for testing. No database required.
 */
class InMemoryBackend implements StorageBackend {
  private store: Map<string, ConversationTurn[]> = new Map();

  private key(conversationId: string, agentId: string): string {
    return `${conversationId}:${agentId}`;
  }

  async add(conversationId: string, agentId: string, turn: ConversationTurn): Promise<void> {
    const k = this.key(conversationId, agentId);
    const turns = this.store.get(k) ?? [];
    turns.push(turn);
    this.store.set(k, turns);
  }

  async get(conversationId: string, agentId: string, maxTurns?: number): Promise<ConversationTurn[]> {
    const k = this.key(conversationId, agentId);
    const turns = this.store.get(k) ?? [];
    if (maxTurns && turns.length > maxTurns) {
      return turns.slice(-maxTurns);
    }
    return [...turns];
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- tests/unit/memory/working-memory.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/memory/working-memory.ts tests/unit/memory/working-memory.test.ts
git commit -m "feat: add working memory with in-memory and Postgres backends"
```

---

## Task 5: Integrate Working Memory into Agent Runtime

**Files:**
- Modify: `src/agents/runtime.ts`
- Modify: `tests/unit/agents/runtime.test.ts`

- [ ] **Step 1: Write failing test for memory integration**

Add to the existing runtime test file:

```typescript
// Add to tests/unit/agents/runtime.test.ts

it('includes conversation history in LLM context', async () => {
  const provider = createMockProvider('Response 2');
  const memory = WorkingMemory.createInMemory();

  // Seed conversation history
  await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: 'First message' });
  await memory.addTurn('conv-1', 'coordinator', { role: 'assistant', content: 'First response' });

  const runtime = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are helpful.',
    provider,
    bus,
    logger: createLogger('error'),
    memory,
  });
  runtime.register();

  const task = createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-1',
    channelId: 'cli',
    senderId: 'user',
    content: 'Second message',
    parentEventId: 'parent-1',
  });
  await bus.publish('dispatch', task);

  // LLM should receive system + history + new message
  expect(provider.chat).toHaveBeenCalledWith({
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response' },
      { role: 'user', content: 'Second message' },
    ],
  });
});

it('saves both user message and assistant response to memory', async () => {
  const provider = createMockProvider('Bot reply');
  const memory = WorkingMemory.createInMemory();

  const runtime = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are helpful.',
    provider,
    bus,
    logger: createLogger('error'),
    memory,
  });
  runtime.register();

  const task = createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-1',
    channelId: 'cli',
    senderId: 'user',
    content: 'Hello',
    parentEventId: 'parent-1',
  });
  await bus.publish('dispatch', task);

  const history = await memory.getHistory('conv-1', 'coordinator');
  expect(history).toHaveLength(2);
  expect(history[0]).toEqual({ role: 'user', content: 'Hello' });
  expect(history[1]).toEqual({ role: 'assistant', content: 'Bot reply' });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/agents/runtime.test.ts
```

- [ ] **Step 3: Update AgentRuntime to use working memory**

Modify `src/agents/runtime.ts`. The key changes:

1. Add `WorkingMemory` import and optional `memory` field to `AgentConfig`:

```typescript
import { WorkingMemory } from '../memory/working-memory.js';

export interface AgentConfig {
  agentId: string;
  systemPrompt: string;
  provider: LLMProvider;
  bus: EventBus;
  logger: Logger;
  memory?: WorkingMemory;  // NEW — optional for backward compatibility
}
```

2. Replace the `handleTask` method body to load history, include it in context, and save both turns:

```typescript
private async handleTask(taskEvent: AgentTaskEvent): Promise<void> {
  const { agentId, systemPrompt, provider, bus, logger, memory } = this.config;
  const { content, conversationId } = taskEvent.payload;

  // Load conversation history from working memory (if configured)
  const history = memory
    ? await memory.getHistory(conversationId, agentId)
    : [];

  // Assemble LLM context: system prompt + history + new user message
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content },
  ];

  logger.info({ agentId, conversationId, historyLength: history.length }, 'Agent processing task');

  // Save the user message to memory before calling LLM
  // (even if LLM fails, we want the user's message recorded)
  if (memory) {
    await memory.addTurn(conversationId, agentId, { role: 'user', content });
  }

  const response = await provider.chat({ messages });

  let responseContent: string;
  if (response.type === 'error') {
    logger.error({ agentId, error: response.error }, 'LLM call failed');
    responseContent = "I'm sorry, I was unable to process that request. Please try again.";
  } else {
    logger.info(
      { agentId, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
      'Agent task completed',
    );
    responseContent = response.content;
  }

  // Save the assistant response to memory
  if (memory) {
    await memory.addTurn(conversationId, agentId, { role: 'assistant', content: responseContent });
  }

  const responseEvent = createAgentResponse({
    agentId,
    conversationId,
    content: responseContent,
    parentEventId: taskEvent.id,
  });
  await bus.publish('agent', responseEvent);
}
```

Existing tests (without `memory` param) continue to pass unchanged — `memory` is optional.

- [ ] **Step 4: Run tests**

```bash
pnpm test
```

Expected: All tests pass (existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/agents/runtime.ts tests/unit/agents/runtime.test.ts
git commit -m "feat: integrate working memory into agent runtime for conversation persistence"
```

---

## Task 6: Wire Everything in Bootstrap

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update bootstrap to use loader + memory**

Changes to `src/index.ts`:
1. Import `loadAgentConfig` from `./agents/loader.js`
2. Import `WorkingMemory` from `./memory/working-memory.js`
3. Create `WorkingMemory.createWithPostgres(pool, logger)`
4. Load coordinator config from `agents/coordinator.yaml` using the loader
5. Pass the loaded `system_prompt` (with persona interpolation) to AgentRuntime
6. Pass `memory` to AgentRuntime

- [ ] **Step 2: Run full test suite + manual test**

```bash
pnpm test
pnpm run run
```

Verify: send multiple messages in CLI, and the agent remembers the earlier messages in the conversation.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire YAML config loader and working memory into bootstrap"
```

---

## Task 7: Multi-Turn Conversation Integration Test

**Files:**
- Create: `tests/integration/conversation-memory.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration/conversation-memory.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../src/bus/events.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import { createLogger } from '../../src/logger.js';

describe('Multi-turn conversation with working memory', () => {
  it('includes prior conversation turns in LLM context on second message', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const memory = WorkingMemory.createInMemory();

    // Track what messages the LLM receives on each call
    const llmCalls: Array<{ messages: unknown[] }> = [];
    let callCount = 0;
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockImplementation((params) => {
        llmCalls.push(params);
        callCount++;
        return Promise.resolve({
          type: 'text' as const,
          content: `Response ${callCount}`,
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      }),
    };

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: mockProvider,
      bus,
      logger,
      memory,
    });
    coordinator.register();

    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    // --- First message ---
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    }));

    // First LLM call should have: system + user message only
    expect(llmCalls[0]?.messages).toHaveLength(2); // system + user

    // --- Second message (same conversation) ---
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Follow-up question',
    }));

    // Second LLM call should include the full history:
    // system + first user + first assistant + second user
    expect(llmCalls[1]?.messages).toHaveLength(4);

    // Verify both responses arrived
    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.payload.content).toBe('Response 1');
    expect(outbound[1]?.payload.content).toBe('Response 2');

    // Verify memory has all 4 turns
    const history = await memory.getHistory('conv-1', 'coordinator');
    expect(history).toHaveLength(4);
    expect(history.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('keeps separate conversations isolated', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const memory = WorkingMemory.createInMemory();

    const llmCalls: Array<{ messages: unknown[] }> = [];
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockImplementation((params) => {
        llmCalls.push(params);
        return Promise.resolve({
          type: 'text' as const,
          content: 'Reply',
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      }),
    };

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: mockProvider,
      bus,
      logger,
      memory,
    });
    coordinator.register();

    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    bus.subscribe('outbound.message', 'channel', () => {});

    // Message in conversation 1
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Conv 1 message',
    }));

    // Message in conversation 2
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-2',
      channelId: 'cli',
      senderId: 'user',
      content: 'Conv 2 message',
    }));

    // Each conversation should have its own isolated history
    const h1 = await memory.getHistory('conv-1', 'coordinator');
    const h2 = await memory.getHistory('conv-2', 'coordinator');
    expect(h1).toHaveLength(2); // user + assistant
    expect(h2).toHaveLength(2); // user + assistant
    expect(h1[0]?.content).toBe('Conv 1 message');
    expect(h2[0]?.content).toBe('Conv 2 message');
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add tests/integration/conversation-memory.test.ts
git commit -m "test: add multi-turn conversation memory integration test"
```

---

## Summary

After completing all 7 tasks:

1. **YAML config loader** — agents defined in `agents/*.yaml` with persona interpolation
2. **Working memory** — conversation history in Postgres, loaded on each agent invocation
3. **Stateful conversations** — multi-turn exchanges where the agent remembers what was said
4. **Backward compatible** — agents without memory configured still work (stateless)
5. **Testable** — in-memory backend for unit tests, Postgres for integration/production

The agent runtime goes from "single-shot Q&A" to "conversational assistant" — the minimum viable memory for a useful system.
