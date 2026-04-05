# Phase 1: Vertical Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the architecture end-to-end: an inbound CLI message flows through the bus → dispatch → Coordinator agent → LLM call → response back to CLI, with audit logging and layer enforcement working.

**Architecture:** Message bus with typed events and layer-enforced permissions. Dispatch routes all messages to the Coordinator agent. Coordinator calls Anthropic Claude, responds. Audit logger records every event. CLI channel for I/O.

**Tech Stack:** TypeScript ESM, Node 22+, pnpm, Vitest, pino, PostgreSQL 16+ (via Docker), node-pg-migrate

**Spec References:**
- [00-overview.md](../specs/00-overview.md) — bus, layers, event flow
- [02-agent-system.md](../specs/02-agent-system.md) — Coordinator, agent lifecycle, LLM providers
- [04-channels.md](../specs/04-channels.md) — CLI adapter interface
- [06-audit-and-security.md](../specs/06-audit-and-security.md) — audit log, layer enforcement
- [08-operations.md](../specs/08-operations.md) — project structure, config, Docker Compose, migrations

---

## What This Phase Builds

```
CLI input → Channel Layer → Bus → Dispatch → Bus → Coordinator Agent → Anthropic LLM
                                                                          ↓
CLI output ← Channel Layer ← Bus ← Dispatch ← Bus ← Coordinator Agent (response)
                                        ↓
                                   Audit Logger (every event persisted)
```

## What This Phase Does NOT Build

- Skills/execution layer (no tool use yet)
- Memory system (no knowledge graph, no Bullpen)
- Scheduler
- Other channels (Email, Signal, HTTP API)
- Other LLM providers (OpenAI, Ollama)
- Agent config loading from YAML (Coordinator is hardcoded for now)

---

## File Map

```
curia/
├── package.json                          # NEW — pnpm, ESM, scripts
├── tsconfig.json                         # NEW — Node 22, ESM, strict
├── vitest.config.ts                      # NEW — test config
├── docker-compose.yml                    # NEW — Postgres + pgvector
├── .env.example                          # MODIFY — add DB + Anthropic vars
├── src/
│   ├── index.ts                          # NEW — bootstrap orchestrator
│   ├── config.ts                         # NEW — env var loading + validation
│   ├── logger.ts                         # NEW — pino instance
│   ├── bus/
│   │   ├── events.ts                     # NEW — event type discriminated union
│   │   ├── permissions.ts                # NEW — layer → event authorization map
│   │   └── bus.ts                        # NEW — EventBus class
│   ├── channels/
│   │   └── cli/
│   │       └── cli-adapter.ts            # NEW — readline-based CLI channel
│   ├── dispatch/
│   │   └── dispatcher.ts                 # NEW — routes to Coordinator, translates responses
│   ├── agents/
│   │   ├── runtime.ts                    # NEW — agent execution engine
│   │   └── llm/
│   │       ├── provider.ts               # NEW — LLMProvider interface
│   │       └── anthropic.ts              # NEW — Anthropic Claude provider
│   ├── audit/
│   │   └── logger.ts                     # NEW — write-ahead audit subscriber
│   └── db/
│       ├── connection.ts                 # NEW — pg Pool setup
│       └── migrations/
│           └── 001_create_audit_log.sql  # NEW — audit_log table
├── agents/
│   └── coordinator.yaml                  # NEW — Coordinator agent config
├── config/
│   └── default.yaml                      # NEW — base config
└── tests/
    ├── unit/
    │   ├── bus/
    │   │   ├── events.test.ts            # NEW
    │   │   ├── permissions.test.ts       # NEW
    │   │   └── bus.test.ts               # NEW
    │   ├── dispatch/
    │   │   └── dispatcher.test.ts        # NEW
    │   └── agents/
    │       └── runtime.test.ts           # NEW
    └── integration/
        └── vertical-slice.test.ts        # NEW — end-to-end flow test
```

---

## Task 1: Project Initialization

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-impl-plan
pnpm init
```

Then replace the generated file:

```json
{
  "name": "curia",
  "version": "0.0.1",
  "description": "The AI executive staff your C-Suite will use and your Board will trust",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --dts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ tests/",
    "migrate": "node-pg-migrate up --migrations-dir src/db/migrations --migration-file-language sql"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Install core dependencies**

```bash
pnpm add pino @anthropic-ai/sdk pg node-pg-migrate
pnpm add -D typescript tsx tsup vitest @types/node @types/pg pino-pretty eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser
```

Note: `js-yaml` is deferred to Phase 2 (YAML config loading). `pino-pretty` is a dev dependency for readable logs in dev mode.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

- [ ] **Step 5: Create docker-compose.yml**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: curia
      POSTGRES_USER: ${DB_USER:-curia}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-curia_dev}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-curia}"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

- [ ] **Step 6: Update .env.example**

**Important:** `.env.example` may be a symlink to the main checkout. Remove it first and create a real file:

```bash
rm -f .env.example
```

Then create `.env.example` with this content:

```bash
# Database
DB_USER=curia
DB_PASSWORD=curia_dev
DATABASE_URL=postgres://curia:curia_dev@localhost:5432/curia

# LLM Providers
ANTHROPIC_API_KEY=sk-ant-...

# Logging
LOG_LEVEL=info
```

- [ ] **Step 7: Update CI workflow**

Replace the commented-out steps in `.github/workflows/ci.yml` with real ones:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_DB: curia_test
          POSTGRES_USER: curia
          POSTGRES_PASSWORD: curia_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U curia"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Use Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Type check
        run: pnpm run typecheck

      - name: Lint
        run: pnpm run lint

      - name: Run tests
        run: pnpm test
        env:
          DATABASE_URL: postgres://curia:curia_test@localhost:5432/curia_test
          LOG_LEVEL: error
```

- [ ] **Step 8: Create ESLint config**

Create `eslint.config.js`:

```javascript
import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
```

Note: Install `@eslint/js` as a dev dependency:

```bash
pnpm add -D @eslint/js
```

- [ ] **Step 9: Verify setup**

```bash
pnpm run typecheck    # should pass (no source files yet)
pnpm test             # should pass (no tests yet)
```

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts docker-compose.yml .env.example .github/workflows/ci.yml
git commit -m "chore: initialize project with pnpm, TypeScript, Vitest, Docker Compose"
```

---

## Task 2: Logger & Config

**Files:**
- Create: `src/logger.ts`
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`

- [ ] **Step 1: Write failing test for config**

```typescript
// tests/unit/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads DATABASE_URL from environment', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    const config = loadConfig();
    expect(config.databaseUrl).toBe('postgres://test:test@localhost:5432/test');
  });

  it('throws if DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    expect(() => loadConfig()).toThrow('DATABASE_URL');
  });

  it('loads ANTHROPIC_API_KEY from environment', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe('sk-ant-test');
  });

  it('defaults LOG_LEVEL to info', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    const config = loadConfig();
    expect(config.logLevel).toBe('info');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/config.test.ts
```

Expected: FAIL — `Cannot find module '../../src/config.js'`

- [ ] **Step 3: Implement config and logger**

```typescript
// src/config.ts
export interface Config {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  logLevel: string;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    databaseUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
```

```typescript
// src/logger.ts
import pino from 'pino';

export function createLogger(level: string = 'info'): pino.Logger {
  return pino({
    level,
    transport: level === 'debug'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  });
}

export type Logger = pino.Logger;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- tests/unit/config.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/logger.ts tests/unit/config.test.ts
git commit -m "feat: add config loader and pino logger"
```

---

## Task 3: Event Types

**Files:**
- Create: `src/bus/events.ts`
- Create: `tests/unit/bus/events.test.ts`

- [ ] **Step 1: Write failing test for event creation**

```typescript
// tests/unit/bus/events.test.ts
import { describe, it, expect } from 'vitest';
import {
  createInboundMessage,
  createAgentTask,
  createAgentResponse,
  createOutboundMessage,
  type BusEvent,
} from '../../../src/bus/events.js';

describe('Event Types', () => {
  it('creates an inbound.message event', () => {
    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    expect(event.type).toBe('inbound.message');
    expect(event.sourceLayer).toBe('channel');
    expect(event.payload.content).toBe('Hello');
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('creates an agent.task event with parent reference', () => {
    const parent = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Hello',
      channelId: 'cli',
      senderId: 'user',
      parentEventId: parent.id,
    });
    expect(task.type).toBe('agent.task');
    expect(task.sourceLayer).toBe('dispatch');
    expect(task.parentEventId).toBe(parent.id);
  });

  it('creates an agent.response event', () => {
    const event = createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Hi there!',
      parentEventId: 'parent-1',
    });
    expect(event.type).toBe('agent.response');
    expect(event.sourceLayer).toBe('agent');
  });

  it('creates an outbound.message event', () => {
    const event = createOutboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      content: 'Hi there!',
      parentEventId: 'parent-1',
    });
    expect(event.type).toBe('outbound.message');
    expect(event.sourceLayer).toBe('dispatch');
  });

  it('type narrows via discriminated union', () => {
    const event: BusEvent = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    if (event.type === 'inbound.message') {
      // TypeScript should allow accessing senderId here
      expect(event.payload.senderId).toBe('user');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/bus/events.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement event types**

```typescript
// src/bus/events.ts
import { randomUUID } from 'node:crypto';

// -- Base event shape --

interface BaseEvent {
  id: string;
  timestamp: Date;
  parentEventId?: string;
}

// -- Layer type --

export type Layer = 'channel' | 'dispatch' | 'agent' | 'execution' | 'system';

// -- Event payloads --

interface InboundMessagePayload {
  conversationId: string;
  channelId: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AgentTaskPayload {
  agentId: string;
  conversationId: string;
  channelId: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AgentResponsePayload {
  agentId: string;
  conversationId: string;
  content: string;
}

interface OutboundMessagePayload {
  conversationId: string;
  channelId: string;
  content: string;
}

// -- Discriminated union --

export interface InboundMessageEvent extends BaseEvent {
  type: 'inbound.message';
  sourceLayer: 'channel';
  payload: InboundMessagePayload;
}

export interface AgentTaskEvent extends BaseEvent {
  type: 'agent.task';
  sourceLayer: 'dispatch';
  payload: AgentTaskPayload;
}

export interface AgentResponseEvent extends BaseEvent {
  type: 'agent.response';
  sourceLayer: 'agent';
  payload: AgentResponsePayload;
}

export interface OutboundMessageEvent extends BaseEvent {
  type: 'outbound.message';
  sourceLayer: 'dispatch';
  payload: OutboundMessagePayload;
}

export type BusEvent =
  | InboundMessageEvent
  | AgentTaskEvent
  | AgentResponseEvent
  | OutboundMessageEvent;

export type EventType = BusEvent['type'];

// -- Factory functions --

export function createInboundMessage(
  payload: InboundMessagePayload,
  parentEventId?: string,
): InboundMessageEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'inbound.message',
    sourceLayer: 'channel',
    payload,
    parentEventId,
  };
}

export function createAgentTask(
  payload: AgentTaskPayload & { parentEventId: string },
): AgentTaskEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.task',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}

export function createAgentResponse(
  payload: AgentResponsePayload & { parentEventId: string },
): AgentResponseEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'agent.response',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}

export function createOutboundMessage(
  payload: OutboundMessagePayload & { parentEventId: string },
): OutboundMessageEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'outbound.message',
    sourceLayer: 'dispatch',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- tests/unit/bus/events.test.ts
```

Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bus/events.ts tests/unit/bus/events.test.ts
git commit -m "feat: add typed event definitions with discriminated union"
```

---

## Task 4: Bus Permissions

**Files:**
- Create: `src/bus/permissions.ts`
- Create: `tests/unit/bus/permissions.test.ts`

- [ ] **Step 1: Write failing test for permissions**

```typescript
// tests/unit/bus/permissions.test.ts
import { describe, it, expect } from 'vitest';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('Bus Permissions', () => {
  it('allows channel to publish inbound.message', () => {
    expect(canPublish('channel', 'inbound.message')).toBe(true);
  });

  it('blocks channel from publishing agent.task', () => {
    expect(canPublish('channel', 'agent.task')).toBe(false);
  });

  it('blocks channel from publishing agent.response', () => {
    expect(canPublish('channel', 'agent.response')).toBe(false);
  });

  it('allows dispatch to publish agent.task', () => {
    expect(canPublish('dispatch', 'agent.task')).toBe(true);
  });

  it('allows dispatch to publish outbound.message', () => {
    expect(canPublish('dispatch', 'outbound.message')).toBe(true);
  });

  it('allows agent to publish agent.response', () => {
    expect(canPublish('agent', 'agent.response')).toBe(true);
  });

  it('blocks agent from publishing outbound.message', () => {
    expect(canPublish('agent', 'outbound.message')).toBe(false);
  });

  it('allows system layer to publish anything', () => {
    expect(canPublish('system', 'inbound.message')).toBe(true);
    expect(canPublish('system', 'agent.task')).toBe(true);
    expect(canPublish('system', 'agent.response')).toBe(true);
    expect(canPublish('system', 'outbound.message')).toBe(true);
  });

  it('allows channel to subscribe to outbound.message', () => {
    expect(canSubscribe('channel', 'outbound.message')).toBe(true);
  });

  it('blocks channel from subscribing to agent.task', () => {
    expect(canSubscribe('channel', 'agent.task')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/bus/permissions.test.ts
```

- [ ] **Step 3: Implement permissions**

```typescript
// src/bus/permissions.ts
import type { Layer, EventType } from './events.js';

const publishAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['inbound.message']),
  dispatch: new Set(['agent.task', 'outbound.message']),
  agent: new Set(['agent.response']),
  execution: new Set([]),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'outbound.message']),
};

const subscribeAllowlist: Record<Layer, Set<EventType>> = {
  channel: new Set(['outbound.message']),
  dispatch: new Set(['inbound.message', 'agent.response']),
  agent: new Set(['agent.task']),
  execution: new Set([]),
  system: new Set(['inbound.message', 'agent.task', 'agent.response', 'outbound.message']),
};

export function canPublish(layer: Layer, eventType: EventType): boolean {
  return publishAllowlist[layer].has(eventType);
}

export function canSubscribe(layer: Layer, eventType: EventType): boolean {
  return subscribeAllowlist[layer].has(eventType);
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- tests/unit/bus/permissions.test.ts
```

Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bus/permissions.ts tests/unit/bus/permissions.test.ts
git commit -m "feat: add bus layer permission enforcement"
```

---

## Task 5: Message Bus

**Files:**
- Create: `src/bus/bus.ts`
- Create: `tests/unit/bus/bus.test.ts`

- [ ] **Step 1: Write failing tests for the bus**

```typescript
// tests/unit/bus/bus.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, createAgentTask } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus(createLogger('error'));
  });

  it('delivers events to subscribers', async () => {
    const handler = vi.fn();
    bus.subscribe('inbound.message', 'dispatch', handler);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('rejects publish from unauthorized layer', async () => {
    const event = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-1',
    });

    await expect(bus.publish('channel', event)).rejects.toThrow(
      /not authorized to publish/,
    );
  });

  it('rejects subscribe from unauthorized layer', () => {
    expect(() =>
      bus.subscribe('agent.task', 'channel', vi.fn()),
    ).toThrow(/not authorized to subscribe/);
  });

  it('does not deliver events to non-matching subscribers', async () => {
    const handler = vi.fn();
    bus.subscribe('outbound.message', 'channel', handler);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls onEvent hook for every published event', async () => {
    const onEvent = vi.fn();
    bus = new EventBus(createLogger('error'), onEvent);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(onEvent).toHaveBeenCalledWith(event);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/bus/bus.test.ts
```

- [ ] **Step 3: Implement the bus**

```typescript
// src/bus/bus.ts
import type { BusEvent, EventType, Layer } from './events.js';
import { canPublish, canSubscribe } from './permissions.js';
import type { Logger } from '../logger.js';

type EventHandler = (event: BusEvent) => void | Promise<void>;
type OnEventHook = (event: BusEvent) => void | Promise<void>;

export class EventBus {
  private subscribers = new Map<EventType, EventHandler[]>();
  private logger: Logger;
  private onEvent?: OnEventHook;

  constructor(logger: Logger, onEvent?: OnEventHook) {
    this.logger = logger;
    this.onEvent = onEvent;
  }

  subscribe(eventType: EventType, layer: Layer, handler: EventHandler): void {
    if (!canSubscribe(layer, eventType)) {
      throw new Error(
        `Layer '${layer}' is not authorized to subscribe to '${eventType}'`,
      );
    }

    const handlers = this.subscribers.get(eventType) ?? [];
    handlers.push(handler);
    this.subscribers.set(eventType, handlers);

    this.logger.debug({ layer, eventType }, 'Subscriber registered');
  }

  async publish(layer: Layer, event: BusEvent): Promise<void> {
    if (!canPublish(layer, event.type)) {
      throw new Error(
        `Layer '${layer}' is not authorized to publish '${event.type}'`,
      );
    }

    this.logger.debug(
      { layer, eventType: event.type, eventId: event.id },
      'Event published',
    );

    // Write-ahead hook (for audit logger)
    if (this.onEvent) {
      await this.onEvent(event);
    }

    // Deliver to subscribers
    const handlers = this.subscribers.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(
          { err, eventType: event.type, eventId: event.id },
          'Subscriber error',
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- tests/unit/bus/bus.test.ts
```

Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/bus/bus.ts tests/unit/bus/bus.test.ts
git commit -m "feat: add EventBus with layer-enforced publish/subscribe"
```

---

## Task 6: Database Connection & Audit Log Migration

**Files:**
- Create: `src/db/connection.ts`
- Create: `src/db/migrations/001_create_audit_log.sql`
- Create: `src/audit/logger.ts`

- [ ] **Step 1: Create database connection module**

```typescript
// src/db/connection.ts
import pg from 'pg';
import type { Logger } from '../logger.js';

const { Pool } = pg;

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string, logger: Logger): DbPool {
  const pool = new Pool({ connectionString: databaseUrl });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database pool error');
  });

  return pool;
}
```

- [ ] **Step 2: Create audit log migration**

```sql
-- src/db/migrations/001_create_audit_log.sql

-- Up
CREATE TABLE audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type        TEXT NOT NULL,
  source_layer      TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  payload           JSONB NOT NULL,
  conversation_id   UUID,
  task_id           UUID,
  parent_event_id   UUID,
  acknowledged      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_audit_event_type ON audit_log (event_type);
CREATE INDEX idx_audit_source_id ON audit_log (source_id);
CREATE INDEX idx_audit_conversation ON audit_log (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_audit_timestamp ON audit_log (timestamp);
CREATE INDEX idx_audit_unacknowledged ON audit_log (acknowledged) WHERE acknowledged = false;

-- Down
DROP TABLE IF EXISTS audit_log;
```

Note: `-- Up` and `-- Down` markers are the exact format `node-pg-migrate` expects for SQL files. Column types match the spec (UUID for IDs, no DEFAULT on source_id).

- [ ] **Step 3: Create audit logger**

```typescript
// src/audit/logger.ts
import type { DbPool } from '../db/connection.js';
import type { BusEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';

export class AuditLogger {
  constructor(
    private pool: DbPool,
    private logger: Logger,
  ) {}

  async log(event: BusEvent): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO audit_log (id, timestamp, event_type, source_layer, payload, conversation_id, parent_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          event.id,
          event.timestamp,
          event.type,
          event.sourceLayer,
          JSON.stringify(event.payload),
          'conversationId' in event.payload
            ? (event.payload as Record<string, unknown>).conversationId
            : null,
          event.parentEventId ?? null,
        ],
      );
    } catch (err) {
      // Audit failures must not be silent — log and re-throw
      this.logger.error({ err, eventId: event.id, eventType: event.type }, 'Audit log write failed');
      throw err;
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/db/connection.ts src/db/migrations/001_create_audit_log.sql src/audit/logger.ts
git commit -m "feat: add database connection, audit log migration, and audit logger"
```

---

## Task 7: Anthropic LLM Provider

**Files:**
- Create: `src/agents/llm/provider.ts`
- Create: `src/agents/llm/anthropic.ts`
- Create: `tests/unit/agents/llm/provider.test.ts`

- [ ] **Step 1: Write failing test for provider interface**

```typescript
// tests/unit/agents/llm/provider.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { LLMProvider, Message } from '../../../../src/agents/llm/provider.js';

describe('LLMProvider interface', () => {
  it('can be implemented as a mock', async () => {
    const mockProvider: LLMProvider = {
      id: 'mock',
      async chat({ messages }) {
        return {
          type: 'text',
          content: `Echo: ${messages[messages.length - 1]?.content ?? ''}`,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const result = await mockProvider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.content).toBe('Echo: Hello');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/agents/llm/provider.test.ts
```

- [ ] **Step 3: Implement provider interface and Anthropic provider**

```typescript
// src/agents/llm/provider.ts
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LLMResponse =
  | { type: 'text'; content: string; usage: LLMUsage }
  | { type: 'error'; error: string; usage?: LLMUsage };

export interface LLMProvider {
  id: string;
  chat(params: {
    messages: Message[];
    options?: Record<string, unknown>;
  }): Promise<LLMResponse>;
}
```

```typescript
// src/agents/llm/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMResponse, Message } from './provider.js';
import type { Logger } from '../../logger.js';

export class AnthropicProvider implements LLMProvider {
  id = 'anthropic';
  private client: Anthropic;
  private logger: Logger;

  constructor(apiKey: string, logger: Logger) {
    this.client = new Anthropic({ apiKey });
    this.logger = logger;
  }

  async chat({
    messages,
    options,
  }: {
    messages: Message[];
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
    // Separate system message from conversation
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const model = (options?.model as string) ?? 'claude-sonnet-4-20250514';

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 4096,
        system: systemMessage?.content,
        messages: conversationMessages,
      });

      const textContent = response.content.find((c) => c.type === 'text');

      this.logger.debug(
        {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        'Anthropic API call completed',
      );

      return {
        type: 'text',
        content: textContent?.text ?? '',
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Anthropic error';
      this.logger.error({ err, model }, 'Anthropic API call failed');
      return { type: 'error', error: message };
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- tests/unit/agents/llm/provider.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/llm/provider.ts src/agents/llm/anthropic.ts tests/unit/agents/llm/provider.test.ts
git commit -m "feat: add LLM provider interface and Anthropic implementation"
```

---

## Task 8: Agent Runtime

**Files:**
- Create: `src/agents/runtime.ts`
- Create: `tests/unit/agents/runtime.test.ts`

- [ ] **Step 1: Write failing test for agent runtime**

The agent runtime receives `agent.task` events from the bus, calls the LLM, and publishes `agent.response` back to the bus. It does NOT return a value — everything flows through events.

```typescript
// tests/unit/agents/runtime.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentResponseEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';

function createMockProvider(response: string): LLMProvider {
  return {
    id: 'mock',
    chat: vi.fn().mockResolvedValue({
      type: 'text' as const,
      content: response,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  };
}

describe('AgentRuntime', () => {
  let bus: EventBus;
  let responses: AgentResponseEvent[];

  beforeEach(() => {
    const logger = createLogger('error');
    bus = new EventBus(logger);
    responses = [];

    // Capture agent.response events
    bus.subscribe('agent.response', 'dispatch', (event) => {
      responses.push(event as AgentResponseEvent);
    });
  });

  it('publishes agent.response when receiving agent.task', async () => {
    const provider = createMockProvider('Hello back!');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      bus,
      logger: createLogger('error'),
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

    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload.content).toBe('Hello back!');
    expect(responses[0]?.parentEventId).toBe(task.id);
    expect(provider.chat).toHaveBeenCalledWith({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
    });
  });

  it('publishes error response when LLM fails', async () => {
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'error' as const,
        error: 'API failed',
      }),
    };
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      bus,
      logger: createLogger('error'),
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

    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload.content).toContain('unable to process');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/agents/runtime.test.ts
```

- [ ] **Step 3: Implement agent runtime**

The runtime subscribes to `agent.task` events on the bus and publishes `agent.response` events. The bus's `publish` method awaits all handlers, so the flow is synchronous through the bus — no fire-and-forget, no race conditions.

```typescript
// src/agents/runtime.ts
import type { LLMProvider, Message } from './llm/provider.js';
import type { EventBus } from '../bus/bus.js';
import { createAgentResponse, type AgentTaskEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';

export interface AgentConfig {
  agentId: string;
  systemPrompt: string;
  provider: LLMProvider;
  bus: EventBus;
  logger: Logger;
}

export class AgentRuntime {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  register(): void {
    this.config.bus.subscribe('agent.task', 'agent', async (event) => {
      const taskEvent = event as AgentTaskEvent;
      // Only handle tasks addressed to this agent
      if (taskEvent.payload.agentId !== this.config.agentId) return;
      await this.handleTask(taskEvent);
    });

    this.config.logger.info({ agentId: this.config.agentId }, 'Agent registered');
  }

  private async handleTask(taskEvent: AgentTaskEvent): Promise<void> {
    const { agentId, systemPrompt, provider, bus, logger } = this.config;
    const { content, conversationId } = taskEvent.payload;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ];

    logger.info({ agentId, conversationId }, 'Agent processing task');

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

    // Publish response back to the bus
    const responseEvent = createAgentResponse({
      agentId,
      conversationId,
      content: responseContent,
      parentEventId: taskEvent.id,
    });
    await bus.publish('agent', responseEvent);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- tests/unit/agents/runtime.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agents/runtime.ts tests/unit/agents/runtime.test.ts
git commit -m "feat: add agent runtime with LLM provider integration"
```

---

## Task 9: Dispatcher

**Files:**
- Create: `src/dispatch/dispatcher.ts`
- Create: `tests/unit/dispatch/dispatcher.test.ts`

- [ ] **Step 1: Write failing test**

The dispatcher does two things: (1) converts `inbound.message` → `agent.task`, and (2) converts `agent.response` → `outbound.message`. It never calls the agent runtime directly — everything flows through the bus.

```typescript
// tests/unit/dispatch/dispatcher.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';

describe('Dispatcher', () => {
  let bus: EventBus;
  let outbound: OutboundMessageEvent[];

  beforeEach(() => {
    const logger = createLogger('error');
    bus = new EventBus(logger);
    outbound = [];

    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Response from Coordinator',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };

    // Register coordinator agent (subscribes to agent.task, publishes agent.response)
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();

    // Register dispatcher (subscribes to inbound.message + agent.response)
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    // Capture outbound messages
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });
  });

  it('routes inbound message through coordinator and publishes outbound response', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });

    // Bus awaits all handlers synchronously — no setTimeout needed
    await bus.publish('channel', event);

    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.payload.content).toBe('Response from Coordinator');
    expect(outbound[0]?.payload.channelId).toBe('cli');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test -- tests/unit/dispatch/dispatcher.test.ts
```

- [ ] **Step 3: Implement dispatcher**

The dispatcher subscribes to `inbound.message` (converts to `agent.task`) and `agent.response` (converts to `outbound.message`). It stores a mapping of task IDs to channel metadata so it knows where to send responses.

```typescript
// src/dispatch/dispatcher.ts
import type { EventBus } from '../bus/bus.js';
import type { InboundMessageEvent, AgentResponseEvent } from '../bus/events.js';
import { createAgentTask, createOutboundMessage } from '../bus/events.js';
import type { Logger } from '../logger.js';

export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
}

export class Dispatcher {
  private bus: EventBus;
  private logger: Logger;
  // Maps agent.task event ID → channel routing info
  private taskRouting = new Map<string, { channelId: string; conversationId: string }>();

  constructor(config: DispatcherConfig) {
    this.bus = config.bus;
    this.logger = config.logger;
  }

  register(): void {
    // inbound.message → agent.task
    this.bus.subscribe('inbound.message', 'dispatch', async (event) => {
      await this.handleInbound(event as InboundMessageEvent);
    });

    // agent.response → outbound.message
    this.bus.subscribe('agent.response', 'dispatch', async (event) => {
      await this.handleAgentResponse(event as AgentResponseEvent);
    });

    this.logger.info('Dispatcher registered');
  }

  private async handleInbound(event: InboundMessageEvent): Promise<void> {
    const { payload } = event;
    this.logger.info(
      { channelId: payload.channelId, senderId: payload.senderId },
      'Dispatching to coordinator',
    );

    const taskEvent = createAgentTask({
      agentId: 'coordinator',
      conversationId: payload.conversationId,
      channelId: payload.channelId,
      senderId: payload.senderId,
      content: payload.content,
      parentEventId: event.id,
    });

    // Store routing info so we know where to send the response
    this.taskRouting.set(taskEvent.id, {
      channelId: payload.channelId,
      conversationId: payload.conversationId,
    });

    await this.bus.publish('dispatch', taskEvent);
  }

  private async handleAgentResponse(event: AgentResponseEvent): Promise<void> {
    // Find the task this response belongs to
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

    // Clean up routing entry
    this.taskRouting.delete(event.parentEventId!);

    const outbound = createOutboundMessage({
      conversationId: routing.conversationId,
      channelId: routing.channelId,
      content: event.payload.content,
      parentEventId: event.id,
    });
    await this.bus.publish('dispatch', outbound);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test -- tests/unit/dispatch/dispatcher.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/dispatcher.ts tests/unit/dispatch/dispatcher.test.ts
git commit -m "feat: add dispatcher routing all messages to coordinator"
```

---

## Task 10: CLI Channel Adapter

**Files:**
- Create: `src/channels/cli/cli-adapter.ts`

- [ ] **Step 1: Implement CLI adapter**

The CLI adapter uses Node's `readline` to read from stdin and write to stdout. It's hard to unit test readline interactively, so we'll test it via the integration test in Task 11.

```typescript
// src/channels/cli/cli-adapter.ts
import * as readline from 'node:readline';
import type { EventBus } from '../../bus/bus.js';
import { createInboundMessage } from '../../bus/events.js';
import type { OutboundMessageEvent } from '../../bus/events.js';
import type { Logger } from '../../logger.js';

export class CliAdapter {
  private bus: EventBus;
  private logger: Logger;
  private rl?: readline.Interface;

  constructor(bus: EventBus, logger: Logger) {
    this.bus = bus;
    this.logger = logger;
  }

  start(): void {
    // Subscribe to outbound messages for the CLI channel
    this.bus.subscribe('outbound.message', 'channel', (event) => {
      if (event.type === 'outbound.message' && event.payload.channelId === 'cli') {
        const outbound = event as OutboundMessageEvent;
        process.stdout.write(`\n${outbound.payload.content}\n\n> `);
      }
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    this.rl.prompt();

    this.rl.on('line', (line) => {
      const content = line.trim();
      if (!content) {
        this.rl?.prompt();
        return;
      }

      if (content === '/quit' || content === '/exit') {
        this.logger.info('CLI exit requested');
        this.stop();
        return;
      }

      const event = createInboundMessage({
        conversationId: 'cli:local:default',
        channelId: 'cli',
        senderId: 'local-user',
        content,
      });

      // Fire-and-forget — the bus delivers to dispatch
      void this.bus.publish('channel', event).catch((err) => {
        this.logger.error({ err }, 'Failed to publish CLI message');
      });
    });

    this.logger.info('CLI adapter started');
  }

  stop(): void {
    this.rl?.close();
    this.logger.info('CLI adapter stopped');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/cli/cli-adapter.ts
git commit -m "feat: add CLI channel adapter with readline I/O"
```

---

## Task 11: Bootstrap Orchestrator

**Files:**
- Create: `src/index.ts`
- Create: `agents/coordinator.yaml`
- Create: `config/default.yaml`

- [ ] **Step 1: Create Coordinator agent config**

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
  You are Curia, an AI executive assistant. You are professional,
  concise, and helpful. You handle all communications on behalf of
  the CEO.

  For casual messages, respond naturally and warmly.
  For tasks, acknowledge the request and describe what you would do.

  Keep responses concise — a few sentences unless detail is requested.
```

- [ ] **Step 2: Create default config**

```yaml
# config/default.yaml
channels:
  cli:
    enabled: true

agents:
  coordinator:
    config_path: agents/coordinator.yaml
```

- [ ] **Step 3: Implement bootstrap orchestrator**

```typescript
// src/index.ts
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createPool } from './db/connection.js';
import { EventBus } from './bus/bus.js';
import { AuditLogger } from './audit/logger.js';
import { AnthropicProvider } from './agents/llm/anthropic.js';
import { AgentRuntime } from './agents/runtime.js';
import { Dispatcher } from './dispatch/dispatcher.js';
import { CliAdapter } from './channels/cli/cli-adapter.js';

async function main(): Promise<void> {
  // 1. Config & logging
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info('Curia starting...');

  // 2. Database
  const pool = createPool(config.databaseUrl, logger);

  // Verify connection
  try {
    await pool.query('SELECT 1');
    logger.info('Database connected');
  } catch (err) {
    logger.fatal({ err }, 'Database connection failed');
    process.exit(1);
  }

  // Run migrations
  // TODO: Run node-pg-migrate programmatically on startup

  // 3. Audit logger
  const auditLogger = new AuditLogger(pool, logger);

  // 4. Message bus (with write-ahead audit hook)
  const bus = new EventBus(logger, (event) => auditLogger.log(event));

  // 5. LLM provider
  if (!config.anthropicApiKey) {
    logger.fatal('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger);

  // 6. Coordinator agent — subscribes to agent.task, publishes agent.response
  // TODO: Load from agents/coordinator.yaml — hardcoded for now
  const coordinator = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: `You are Curia, an AI executive assistant. You are professional,
concise, and helpful. You handle all communications on behalf of the CEO.
For casual messages, respond naturally and warmly.
For tasks, acknowledge the request and describe what you would do.
Keep responses concise — a few sentences unless detail is requested.`,
    provider: llmProvider,
    bus,
    logger,
  });
  coordinator.register();

  // 7. Dispatcher — subscribes to inbound.message + agent.response
  const dispatcher = new Dispatcher({ bus, logger });
  dispatcher.register();

  // 8. CLI channel
  const cli = new CliAdapter(bus, logger);
  cli.start();

  logger.info('Curia is ready. Type a message or /quit to exit.');

  // 9. Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    cli.stop();
    await pool.end();
    logger.info('Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Pre-logger fallback — pino isn't initialized yet if main() throws on config load
const fallbackLogger = createLogger('error');
main().catch((err) => {
  fallbackLogger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts agents/coordinator.yaml config/default.yaml
git commit -m "feat: add bootstrap orchestrator with CLI → Coordinator flow"
```

---

## Task 12: Integration Test

**Files:**
- Create: `tests/integration/vertical-slice.test.ts`

- [ ] **Step 1: Write integration test**

This test verifies the full flow without a real LLM call — using a mock provider but real bus, dispatcher, and audit logger (with a real Postgres if available, skipped otherwise).

```typescript
// tests/integration/vertical-slice.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../src/bus/events.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import { createLogger } from '../../src/logger.js';

describe('Vertical Slice: CLI → Dispatch → Coordinator → Response', () => {
  it('routes an inbound message through the full pipeline', async () => {
    const logger = createLogger('error');
    const auditLog: Array<{ type: string; id: string }> = [];

    // Bus with audit capture
    const bus = new EventBus(logger, async (event) => {
      auditLog.push({ type: event.type, id: event.id });
    });

    // Mock LLM
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Hello! How can I help you today?',
        usage: { inputTokens: 20, outputTokens: 10 },
      }),
    };

    // Coordinator — subscribes to agent.task, publishes agent.response
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();

    // Dispatcher — subscribes to inbound.message + agent.response
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    // Capture outbound
    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    // Simulate CLI input
    const inbound = createInboundMessage({
      conversationId: 'cli:local:default',
      channelId: 'cli',
      senderId: 'local-user',
      content: 'Good morning!',
    });

    // Bus awaits all handlers — no setTimeout needed
    await bus.publish('channel', inbound);

    // Verify response arrived
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.payload.content).toBe('Hello! How can I help you today?');
    expect(outbound[0]?.payload.channelId).toBe('cli');
    expect(outbound[0]?.payload.conversationId).toBe('cli:local:default');

    // Verify audit trail captured all 4 events in the correct order
    expect(auditLog).toHaveLength(4);
    expect(auditLog.map((e) => e.type)).toEqual([
      'inbound.message',     // 1. CLI publishes
      'agent.task',          // 2. Dispatcher converts and publishes
      'agent.response',      // 3. Coordinator responds via bus
      'outbound.message',    // 4. Dispatcher converts response
    ]);

    // Verify causal chain is intact
    expect(outbound[0]?.parentEventId).toBeDefined();

    // Verify LLM was called with correct messages
    expect(mockProvider.chat).toHaveBeenCalledWith({
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Good morning!' },
      ],
    });
  });
});
```

- [ ] **Step 2: Run test**

```bash
pnpm test -- tests/integration/vertical-slice.test.ts
```

Expected: PASS

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/integration/vertical-slice.test.ts
git commit -m "test: add end-to-end integration test for vertical slice"
```

---

## Task 13: Manual Smoke Test

- [ ] **Step 1: Start Postgres**

```bash
docker compose up -d postgres
```

- [ ] **Step 2: Run migration**

```bash
pnpm run migrate
```

- [ ] **Step 3: Start Curia in dev mode**

```bash
ANTHROPIC_API_KEY=your-key-here DATABASE_URL=postgres://curia:curia_dev@localhost:5432/curia pnpm run dev
```

- [ ] **Step 4: Test conversation**

```
> Hello, who are you?
(should get a response from Claude identifying as Curia)

> What can you help me with?
(should get a helpful response)

> /quit
(should shut down gracefully)
```

- [ ] **Step 5: Verify audit log**

```bash
docker compose exec postgres psql -U curia -d curia -c "SELECT event_type, source_layer, timestamp FROM audit_log ORDER BY timestamp;"
```

Should show `inbound.message`, `agent.task`, `outbound.message` entries for each conversation turn.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```

---

## Summary

After completing all 13 tasks, you'll have:

1. **Project tooling** — pnpm, TypeScript ESM, Vitest, Docker Compose, CI
2. **Message bus** — typed events, layer-enforced permissions, write-ahead audit hook
3. **Audit logger** — Postgres-backed, append-only, causal tracing
4. **LLM provider** — Anthropic Claude with common interface
5. **Agent runtime** — system prompt + LLM invocation
6. **Dispatcher** — routes all messages to Coordinator
7. **CLI adapter** — readline-based interactive channel
8. **Bootstrap orchestrator** — wires everything in dependency order, graceful shutdown

This is the skeleton. Future phases will add:
- Phase 2: Agent config loading from YAML, memory system (working memory + knowledge graph)
- Phase 3: Skills/execution layer, MCP client
- Phase 4: Additional channels (Email, Signal)
- Phase 5: Scheduler, persistent tasks
- Phase 6: HTTP API, agent status SSE
