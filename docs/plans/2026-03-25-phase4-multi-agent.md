# Phase 4: Dispatcher & Multi-Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the Coordinator to delegate tasks to specialist agents, with multi-agent loading from `agents/` directory, a `delegate` built-in skill, and one sample specialist to prove the flow end-to-end.

**Architecture:** At startup, the bootstrap loads all `agents/*.yaml` files and creates an AgentRuntime for each. A new `delegate` skill allows the Coordinator to send tasks to specialists by name — the skill creates an `agent.task` event on the bus and waits for the specialist's `agent.response`. The Coordinator synthesizes the specialist's result into its own reply, maintaining the unified persona. An `agent-registry` tracks all running agents so the `delegate` skill can verify targets exist and the Coordinator can list available specialists.

**Tech Stack:** TypeScript (ESM), vitest, pino

**Reference specs:**
- `docs/specs/02-agent-system.md` — Coordinator delegation, agent lifecycle, specialist configs
- `docs/specs/01-memory-system.md` — Bullpen (deferred to Phase 5, but informs the delegation pattern)

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/agents/agent-registry.ts` | `AgentRegistry` — tracks registered agents by name, provides lookup and listing |
| `skills/delegate/skill.json` | Manifest for the delegate skill |
| `skills/delegate/handler.ts` | Implementation: publishes `agent.task` for specialist, waits for `agent.response` |
| `agents/research-analyst.yaml` | Sample specialist agent config |
| `tests/unit/agents/agent-registry.test.ts` | Registry tests |
| `tests/unit/skills/delegate.test.ts` | Delegate skill unit tests |
| `tests/integration/multi-agent-delegation.test.ts` | End-to-end: Coordinator delegates to specialist |

### Modified Files

| File | Changes |
|---|---|
| `src/skills/types.ts` | Extend `SkillContext` with optional `bus` and `agentRegistry` for infrastructure skills |
| `src/skills/execution.ts` | Pass bus and agent registry into SkillContext for infrastructure skills |
| `src/agents/runtime.ts` | Accept agentRegistry in AgentConfig |
| `src/index.ts` | Load all agents, create AgentRegistry, pass to execution layer |
| `agents/coordinator.yaml` | Update system prompt to describe available specialists and delegation |

---

## Tasks

### Task 1: Agent Registry

**Files:**
- Create: `src/agents/agent-registry.ts`
- Create: `tests/unit/agents/agent-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/agents/agent-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('registers and retrieves an agent by name', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    const agent = registry.get('coordinator');
    expect(agent).toBeDefined();
    expect(agent!.role).toBe('coordinator');
  });

  it('returns undefined for unknown agent', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists all registered agents', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    registry.register('research-analyst', { role: 'specialist', description: 'Research and analysis' });
    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map(a => a.name)).toEqual(['coordinator', 'research-analyst']);
  });

  it('lists only specialist agents (excludes coordinator)', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    registry.register('research-analyst', { role: 'specialist', description: 'Research' });
    registry.register('expense-tracker', { role: 'specialist', description: 'Expenses' });
    const specialists = registry.listSpecialists();
    expect(specialists).toHaveLength(2);
    expect(specialists.map(a => a.name)).toEqual(['research-analyst', 'expense-tracker']);
  });

  it('throws on duplicate registration', () => {
    registry.register('dup', { role: 'specialist', description: 'First' });
    expect(() => registry.register('dup', { role: 'specialist', description: 'Second' }))
      .toThrow(/already registered/);
  });

  it('checks existence without retrieving', () => {
    registry.register('research-analyst', { role: 'specialist', description: 'Research' });
    expect(registry.has('research-analyst')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('generates a specialist summary for LLM context', () => {
    registry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    registry.register('research-analyst', { role: 'specialist', description: 'Conducts web research and summarizes findings' });
    registry.register('expense-tracker', { role: 'specialist', description: 'Tracks expenses from receipts and emails' });

    const summary = registry.specialistSummary();
    expect(summary).toContain('research-analyst');
    expect(summary).toContain('Conducts web research');
    expect(summary).toContain('expense-tracker');
    expect(summary).not.toContain('coordinator');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/agents/agent-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement AgentRegistry**

Create `src/agents/agent-registry.ts`:

```typescript
// agent-registry.ts — tracks all running agents in the system.
//
// The registry is populated at startup when agent YAML configs are loaded.
// It provides lookup by name (for the delegate skill to verify targets),
// listing (for the Coordinator to know which specialists are available),
// and a summary method (for injecting specialist descriptions into the
// Coordinator's system prompt).

export interface AgentRegistryEntry {
  name: string;
  role: string;
  description: string;
}

export class AgentRegistry {
  private agents = new Map<string, AgentRegistryEntry>();

  /**
   * Register an agent. Called during bootstrap for each loaded agent config.
   * Throws on duplicate names — this is a configuration error.
   */
  register(name: string, info: { role: string; description: string }): void {
    if (this.agents.has(name)) {
      throw new Error(`Agent '${name}' is already registered`);
    }
    this.agents.set(name, { name, ...info });
  }

  /** Look up an agent by name. */
  get(name: string): AgentRegistryEntry | undefined {
    return this.agents.get(name);
  }

  /** Check if an agent exists. */
  has(name: string): boolean {
    return this.agents.has(name);
  }

  /** List all registered agents. */
  list(): AgentRegistryEntry[] {
    return Array.from(this.agents.values());
  }

  /** List only specialist agents (excludes the coordinator). */
  listSpecialists(): AgentRegistryEntry[] {
    return this.list().filter(a => a.role !== 'coordinator');
  }

  /**
   * Generate a human-readable summary of available specialists.
   * Injected into the Coordinator's system prompt so it knows
   * which specialists it can delegate to and what they do.
   */
  specialistSummary(): string {
    const specialists = this.listSpecialists();
    if (specialists.length === 0) {
      return 'No specialist agents are currently available.';
    }
    return specialists
      .map(s => `- @${s.name}: ${s.description}`)
      .join('\n');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/unit/agents/agent-registry.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agents/agent-registry.ts tests/unit/agents/agent-registry.test.ts
git commit -m "feat: add AgentRegistry for tracking running agents"
```

---

### Task 2: Extend SkillContext for Infrastructure Skills

**Files:**
- Modify: `src/skills/types.ts`
- Modify: `src/skills/execution.ts`

Infrastructure skills like `delegate` need access to the bus and agent registry — things that normal skills should never touch. We add optional infrastructure fields to `SkillContext` and have the execution layer conditionally provide them based on a manifest flag.

- [ ] **Step 1: Update SkillManifest and SkillContext in types.ts**

Read `src/skills/types.ts` first. Add to `SkillManifest`:

```typescript
  /** If true, this skill receives bus and agent registry access in its context.
   *  Only for framework-internal skills like 'delegate' — external skills should never set this. */
  infrastructure?: boolean;
```

Add to `SkillContext`:

```typescript
  /** Bus access — only available to infrastructure skills (manifest.infrastructure: true) */
  bus?: import('../bus/bus.js').EventBus;
  /** Agent registry — only available to infrastructure skills */
  agentRegistry?: import('../agents/agent-registry.js').AgentRegistry;
```

- [ ] **Step 2: Update ExecutionLayer to accept and pass infrastructure deps**

Read `src/skills/execution.ts` first. Add constructor params for bus and agent registry:

```typescript
import type { EventBus } from '../bus/bus.js';
import type { AgentRegistry } from '../agents/agent-registry.js';

export class ExecutionLayer {
  private registry: SkillRegistry;
  private logger: Logger;
  private bus?: EventBus;
  private agentRegistry?: AgentRegistry;

  constructor(registry: SkillRegistry, logger: Logger, options?: { bus?: EventBus; agentRegistry?: AgentRegistry }) {
    this.registry = registry;
    this.logger = logger;
    this.bus = options?.bus;
    this.agentRegistry = options?.agentRegistry;
  }
```

In the `invoke` method, after building the `ctx` object, conditionally add infrastructure fields:

```typescript
    // Infrastructure skills get bus and agent registry access.
    // This is intentionally gated behind a manifest flag so normal skills
    // cannot escalate their privileges by accessing the bus directly.
    if (manifest.infrastructure) {
      ctx.bus = this.bus;
      ctx.agentRegistry = this.agentRegistry;
    }
```

- [ ] **Step 3: Run existing tests to verify nothing broke**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/skills/types.ts src/skills/execution.ts
git commit -m "feat: extend SkillContext with optional infrastructure access (bus, agentRegistry)"
```

---

### Task 3: Delegate Skill

**Files:**
- Create: `skills/delegate/skill.json`
- Create: `skills/delegate/handler.ts`
- Create: `tests/unit/skills/delegate.test.ts`

- [ ] **Step 1: Create the skill manifest**

Create `skills/delegate/skill.json`:

```json
{
  "name": "delegate",
  "description": "Delegate a task to a specialist agent. Use this when the user's request requires specialized expertise (research, expense tracking, etc.). Provide the specialist's name and a clear task description.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "agent": "string",
    "task": "string",
    "conversation_id": "string?"
  },
  "outputs": {
    "response": "string",
    "agent": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 120000
}
```

- [ ] **Step 2: Write failing tests for the handler**

Create `tests/unit/skills/delegate.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { DelegateHandler } from '../../../skills/delegate/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { EventBus } from '../../../src/bus/bus.js';
import type { AgentResponseEvent } from '../../../src/bus/events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets needed'); },
    log: logger,
    ...overrides,
  };
}

describe('DelegateHandler', () => {
  const handler = new DelegateHandler();

  it('returns failure when bus is not available', async () => {
    const result = await handler.execute(makeCtx({ agent: 'research-analyst', task: 'do something' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('infrastructure');
    }
  });

  it('returns failure when target agent does not exist', async () => {
    const agentRegistry = new AgentRegistry();
    const bus = new EventBus(logger);

    const result = await handler.execute(makeCtx(
      { agent: 'nonexistent', task: 'do something' },
      { bus, agentRegistry },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
    }
  });

  it('returns failure when trying to delegate to coordinator', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    const bus = new EventBus(logger);

    const result = await handler.execute(makeCtx(
      { agent: 'coordinator', task: 'do something' },
      { bus, agentRegistry },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cannot delegate to the coordinator');
    }
  });

  it('returns failure for missing required inputs', async () => {
    const agentRegistry = new AgentRegistry();
    const bus = new EventBus(logger);

    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst' },
      { bus, agentRegistry },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('task');
    }
  });

  it('delegates to specialist and returns its response', async () => {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research' });
    const bus = new EventBus(logger);

    // Register a mock specialist that responds to agent.task
    bus.subscribe('agent.task', 'agent', async (event) => {
      if (event.type === 'agent.task' && event.payload.agentId === 'research-analyst') {
        const { createAgentResponse } = await import('../../../src/bus/events.js');
        const response = createAgentResponse({
          agentId: 'research-analyst',
          conversationId: event.payload.conversationId,
          content: 'Here are the research findings: ...',
          parentEventId: event.id,
        });
        await bus.publish('agent', response);
      }
    });

    const result = await handler.execute(makeCtx(
      { agent: 'research-analyst', task: 'Research the latest AI trends', conversation_id: 'conv-1' },
      { bus, agentRegistry },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { response: string; agent: string };
      expect(data.agent).toBe('research-analyst');
      expect(data.response).toContain('research findings');
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/unit/skills/delegate.test.ts`
Expected: FAIL — handler not found

- [ ] **Step 4: Implement the delegate handler**

Create `skills/delegate/handler.ts`:

```typescript
// handler.ts — delegate skill implementation.
//
// This is an infrastructure skill — it has bus and agentRegistry access
// that normal skills don't get. It publishes an agent.task event for the
// target specialist, then waits for the specialist's agent.response.
//
// The Coordinator uses this skill to delegate work: it calls
// delegate({ agent: "research-analyst", task: "..." }) and gets back
// the specialist's response, which it can then synthesize into its own reply.

import { randomUUID } from 'node:crypto';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { createAgentTask, type AgentResponseEvent } from '../../src/bus/events.js';

// How long to wait for the specialist to respond before timing out.
// This is separate from the skill-level timeout (which covers the whole
// delegate invocation including this wait). Set slightly shorter so the
// skill can return a clean error message rather than being killed by
// the execution layer's timeout.
const SPECIALIST_TIMEOUT_MS = 90000;

export class DelegateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { agent, task, conversation_id } = ctx.input as {
      agent?: string;
      task?: string;
      conversation_id?: string;
    };

    // Validate required inputs
    if (!agent || typeof agent !== 'string') {
      return { success: false, error: 'Missing required input: agent (string)' };
    }
    if (!task || typeof task !== 'string') {
      return { success: false, error: 'Missing required input: task (string)' };
    }

    // Infrastructure skills need bus and agent registry
    if (!ctx.bus || !ctx.agentRegistry) {
      return {
        success: false,
        error: 'Delegate skill requires infrastructure access (bus, agentRegistry). Is infrastructure: true set in the manifest?',
      };
    }

    // Validate target agent exists and isn't the coordinator
    if (!ctx.agentRegistry.has(agent)) {
      const available = ctx.agentRegistry.listSpecialists().map(a => a.name).join(', ');
      return {
        success: false,
        error: `Agent '${agent}' not found. Available specialists: ${available || 'none'}`,
      };
    }

    const targetAgent = ctx.agentRegistry.get(agent)!;
    if (targetAgent.role === 'coordinator') {
      return {
        success: false,
        error: 'You cannot delegate to the coordinator — that would create a loop. Delegate to a specialist instead.',
      };
    }

    const conversationId = conversation_id ?? `delegate-${randomUUID()}`;

    ctx.log.info({ targetAgent: agent, task: task.slice(0, 100) }, 'Delegating task to specialist');

    // Publish an agent.task event for the specialist.
    // The specialist's AgentRuntime is subscribed to agent.task and will
    // pick it up, process it, and publish an agent.response.
    const taskEvent = createAgentTask({
      agentId: agent,
      conversationId,
      channelId: 'internal',
      senderId: 'coordinator',
      content: task,
      parentEventId: `delegate-${randomUUID()}`,
    });

    // Set up a one-time listener for the specialist's response BEFORE
    // publishing the task, so we don't miss a fast response.
    // TODO: The EventBus has no unsubscribe mechanism, so this subscriber
    // persists after the delegation completes. For Phase 4 this is acceptable
    // (the filter prevents duplicate processing), but Phase 5 should add
    // bus.unsubscribe() or a one-shot subscription pattern.
    const responsePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Specialist '${agent}' did not respond within ${SPECIALIST_TIMEOUT_MS}ms`));
      }, SPECIALIST_TIMEOUT_MS);

      ctx.bus!.subscribe('agent.response', 'system', async (event) => {
        const responseEvent = event as AgentResponseEvent;
        // Match on the task event ID — the specialist sets parentEventId to the task ID
        if (responseEvent.parentEventId === taskEvent.id) {
          clearTimeout(timeout);
          resolve(responseEvent.payload.content);
        }
      });
    });

    // Publish the task to the bus — the specialist will pick it up
    await ctx.bus.publish('dispatch', taskEvent);

    try {
      const response = await responsePromise;
      ctx.log.info({ targetAgent: agent }, 'Specialist responded');

      return {
        success: true,
        data: {
          response,
          agent,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, targetAgent: agent }, 'Delegation failed');
      return { success: false, error: message };
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- tests/unit/skills/delegate.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add skills/delegate/skill.json skills/delegate/handler.ts tests/unit/skills/delegate.test.ts
git commit -m "feat: add delegate skill for Coordinator-to-specialist task delegation"
```

---

### Task 4: Sample Specialist Agent

**Files:**
- Create: `agents/research-analyst.yaml`

- [ ] **Step 1: Create the specialist config**

Create `agents/research-analyst.yaml`:

```yaml
name: research-analyst
role: specialist
description: Conducts web research, summarizes findings, and provides analysis on topics the CEO asks about
model:
  provider: anthropic
  model: claude-sonnet-4-20250514
system_prompt: |
  You are a research analyst working as part of an executive assistant team.
  Your role is to conduct thorough research and provide clear, actionable summaries.

  When given a research task:
  1. Use your available tools to gather information
  2. Synthesize findings into a clear, concise summary
  3. Highlight key takeaways and any concerns
  4. Note your sources when possible

  Keep your responses focused and factual. Your findings will be reviewed
  and presented by the team coordinator — write for a busy executive audience.
pinned_skills:
  - web-fetch
allow_discovery: false
memory:
  scopes: [research]
```

- [ ] **Step 2: Verify the config loads correctly**

Run: `node -e "import('./src/agents/loader.js').then(m => { const c = m.loadAgentConfig('agents/research-analyst.yaml'); console.log(c.name, c.role, c.description?.slice(0, 50)); })"`
Expected: Prints `research-analyst specialist Conducts web research...`

- [ ] **Step 3: Commit**

```bash
git add agents/research-analyst.yaml
git commit -m "feat: add research-analyst specialist agent config"
```

---

### Task 5: Update Coordinator System Prompt

**Files:**
- Modify: `agents/coordinator.yaml`

The Coordinator needs to know about the delegate tool and available specialists. We inject specialist info dynamically at startup, but the system prompt needs the static delegation instructions.

- [ ] **Step 1: Update coordinator.yaml**

Read the existing file first. Replace the system_prompt and add delegate to pinned_skills:

```yaml
name: coordinator
role: coordinator
description: Central coordinator — routes all messages, delegates to specialists, maintains the unified persona
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

  ## Your Team
  You have specialist agents you can delegate to using the "delegate" tool.
  When a request requires specialized expertise, delegate to the right specialist.
  Always synthesize their response into your own voice — the user should never
  know multiple agents were involved.

  Available specialists:
  ${available_specialists}

  ## Guidelines
  - For casual messages, respond naturally and warmly
  - For tasks within your direct capability (using web-fetch, etc.), handle them yourself
  - For tasks that match a specialist's expertise, delegate using the delegate tool
  - Always respond in your own voice, even when relaying a specialist's work
  - Keep responses concise unless detail is requested
pinned_skills:
  - web-fetch
  - delegate
allow_discovery: true
```

- [ ] **Step 2: Update the loader to support `${available_specialists}` interpolation**

Read `src/agents/loader.ts`. Add a new function that interpolates runtime context (not just persona):

```typescript
/**
 * Interpolate runtime context placeholders in the system prompt.
 * Currently supports:
 * - ${available_specialists} — list of specialist agents from the agent registry
 */
export function interpolateRuntimeContext(
  systemPrompt: string,
  context: { availableSpecialists?: string },
): string {
  return systemPrompt.replace(
    /\$\{available_specialists\}/g,
    context.availableSpecialists ?? 'No specialists available yet.',
  );
}
```

- [ ] **Step 3: Run existing loader tests to verify nothing broke**

Run: `pnpm test -- tests/unit/agents/loader.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add agents/coordinator.yaml src/agents/loader.ts
git commit -m "feat: update Coordinator with delegation instructions and specialist awareness"
```

---

### Task 6: Multi-Agent Bootstrap

**Files:**
- Modify: `src/index.ts`

This is the key integration task — the bootstrap loads all agents, creates the registry, and wires everything together.

- [ ] **Step 1: Update index.ts**

Read the existing file. The changes are:

1. Import `AgentRegistry` and `loadAllAgentConfigs` and `interpolateRuntimeContext`
2. After skill registry setup, create the `AgentRegistry`
3. Load all agent configs from `agents/` directory
4. Create `AgentRuntime` for each agent (not just coordinator)
5. Pass bus and agent registry to the execution layer
6. Interpolate `${available_specialists}` in the Coordinator's system prompt

Replace the coordinator-specific block (from "// 6. Coordinator agent" through `coordinator.register()`) and the execution layer creation with:

```typescript
  // Agent registry — tracks all running agents for delegation and listing.
  const agentRegistry = new AgentRegistry();

  // Execution layer — now with bus and agent registry for infrastructure skills.
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

  // Load all agent configs from the agents/ directory.
  const agentsDir = path.resolve(import.meta.dirname, '../agents');
  const agentConfigs = loadAllAgentConfigs(agentsDir);
  logger.info({ agents: agentConfigs.map(c => c.name) }, 'Agent configs loaded');

  // Two-pass agent registration:
  // Pass 1: Register all agents in the registry so specialistSummary() is complete
  //         before the Coordinator's system prompt is interpolated.
  // Pass 2: Create AgentRuntime instances with fully interpolated prompts.
  // Without this split, the coordinator (alphabetically first) would be interpolated
  // before any specialists are registered, resulting in an empty specialist list.

  // Pass 1: Populate registry with all agent names, roles, and descriptions
  for (const agentConfig of agentConfigs) {
    agentRegistry.register(agentConfig.name, {
      role: agentConfig.role ?? 'specialist',
      description: agentConfig.description ?? agentConfig.name,
    });
  }

  // Pass 2: Create AgentRuntime for each config (now all specialists are known)
  for (const agentConfig of agentConfigs) {
    // Build tool definitions from pinned skills
    const agentPinnedSkills = agentConfig.pinned_skills ?? [];
    const agentToolDefs = skillRegistry.toToolDefinitions(agentPinnedSkills);

    // For the coordinator, interpolate runtime context (specialist list).
    // This runs in pass 2 so all specialists are already in the registry.
    let systemPrompt = agentConfig.system_prompt;
    if (agentConfig.role === 'coordinator') {
      systemPrompt = interpolateRuntimeContext(systemPrompt, {
        availableSpecialists: agentRegistry.specialistSummary(),
      });
    }

    const agent = new AgentRuntime({
      agentId: agentConfig.name,
      systemPrompt,
      provider: llmProvider,
      bus,
      logger,
      memory,
      executionLayer,
      pinnedSkills: agentPinnedSkills,
      skillToolDefs: agentToolDefs,
    });
    agent.register();

    if (agentToolDefs.length > 0) {
      logger.info({ agent: agentConfig.name, skills: agentPinnedSkills }, 'Agent tools configured');
    }
  }

  // Verify we have a coordinator — the system requires exactly one.
  if (!agentRegistry.has('coordinator')) {
    logger.fatal('No coordinator agent found in agents/ directory');
    process.exit(1);
  }
```

- [ ] **Step 2: Add missing imports at the top of index.ts**

```typescript
import { loadAgentConfig, loadAllAgentConfigs, interpolateRuntimeContext } from './agents/loader.js';
import { AgentRegistry } from './agents/agent-registry.js';
```

Remove the old single-agent import if it only imported `loadAgentConfig`.

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: Run type check**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: multi-agent bootstrap — load all agents, create registry, wire delegation"
```

---

### Task 7: Integration Test

**Files:**
- Create: `tests/integration/multi-agent-delegation.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/multi-agent-delegation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
import type { SkillManifest } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

describe('Multi-agent delegation integration', () => {
  it('Coordinator delegates to specialist and synthesizes response', async () => {
    // 1. Set up registries
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research and analysis' });

    const skillRegistry = new SkillRegistry();
    const delegateManifest: SkillManifest = {
      name: 'delegate',
      description: 'Delegate a task to a specialist agent',
      version: '1.0.0',
      sensitivity: 'normal',
      infrastructure: true,
      inputs: { agent: 'string', task: 'string', conversation_id: 'string?' },
      outputs: { response: 'string', agent: 'string' },
      permissions: [],
      secrets: [],
      timeout: 120000,
    };
    skillRegistry.register(delegateManifest, new DelegateHandler());

    // 2. Set up bus and execution layer
    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    // 3. Mock Coordinator LLM: first call delegates, second synthesizes
    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          // Coordinator decides to delegate
          return {
            type: 'tool_use' as const,
            toolCalls: [{
              id: 'call-1',
              name: 'delegate',
              input: { agent: 'research-analyst', task: 'Research the latest AI trends', conversation_id: 'test-conv' },
            }],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        // After getting delegation result, synthesize
        // Check if tool results contain the specialist's response
        const hasToolResult = messages.some(m =>
          Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_result'),
        );
        return {
          type: 'text' as const,
          content: `Based on my research team's findings${hasToolResult ? ' (delegation successful)' : ''}: AI is advancing rapidly.`,
          usage: { inputTokens: 200, outputTokens: 60 },
        };
      },
    };

    // 4. Mock Specialist LLM: simple text response (track calls to verify delegation)
    let specialistCalls = 0;
    const specialistProvider: LLMProvider = {
      id: 'mock-specialist',
      chat: async () => {
        specialistCalls++;
        return {
          type: 'text' as const,
          content: 'Key AI trends: LLMs are becoming multimodal, agents are emerging as a paradigm.',
          usage: { inputTokens: 50, outputTokens: 30 },
        };
      },
    };

    // 5. Create both agent runtimes
    const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate'],
      skillToolDefs: toolDefs,
    });
    coordinator.register();

    const specialist = new AgentRuntime({
      agentId: 'research-analyst',
      systemPrompt: 'You are a research analyst.',
      provider: specialistProvider,
      bus,
      logger,
    });
    specialist.register();

    // 6. Capture the final response
    let finalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        finalResponse = event.payload.content;
      }
    });

    // 7. Send a task to the coordinator
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'test-conv',
      channelId: 'test',
      senderId: 'test-user',
      content: 'What are the latest AI trends?',
      parentEventId: 'test-inbound-1',
    });
    await bus.publish('dispatch', task);

    // 8. Verify the full delegation loop
    expect(coordinatorCalls).toBe(2);
    expect(specialistCalls).toBe(1); // Specialist was actually called
    expect(finalResponse).toContain('delegation successful');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `pnpm test -- tests/integration/multi-agent-delegation.test.ts`
Expected: PASS (1 test)

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/integration/multi-agent-delegation.test.ts
git commit -m "test: add multi-agent delegation integration test"
```

---

### Task 8: Final Verification & PR

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 2: Run type check**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 4: Manual smoke test**

Run: `pnpm local` (in the worktree with .env symlinked)

Test delegation:
1. Type: "Can you research what's happening with AI regulation in the EU?"
2. Expected: The Coordinator calls `delegate` with `agent: "research-analyst"`, the specialist uses `web-fetch` to research, returns findings, and the Coordinator synthesizes them in its own voice.
3. Check `curia.log` for `agent.task` events to both coordinator and research-analyst.

- [ ] **Step 5: Push and create PR**

```bash
git push -u origin feat/phase4-multi-agent
```

Then create PR with appropriate title and description.
