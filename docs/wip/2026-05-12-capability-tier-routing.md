# Capability-Tier Model Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-agent model declarations with a capability-tier routing system so agents declare intent (fast/standard/powerful) and the operator maps tiers to models centrally.

**Architecture:** New `ModelRouter` service resolves tier → `{ provider, model }` from operator config. `LLMProvider.chat()` gains a `model` param for per-call model selection. Bootstrap creates a provider registry and wires agents through the router. All agent YAMLs migrated in both curia and curia-deploy repos.

**Tech Stack:** TypeScript, Vitest, js-yaml, Anthropic SDK

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/agents/llm/model-router.ts` | ModelRouter class — resolves tier to provider+model |
| Create | `src/agents/llm/model-router.test.ts` | Unit tests for ModelRouter |
| Modify | `src/agents/llm/provider.ts:108-113` | Add `model?: string` to chat params |
| Modify | `src/agents/llm/anthropic.ts:31-41` | Accept `model` from params (replaces options.model) |
| Modify | `src/agents/llm/anthropic.test.ts` | Update tests for new `model` param |
| Modify | `tests/unit/agents/llm/provider.test.ts` | Update mock to include `model` param |
| Modify | `src/agents/runtime.ts:22-85` | Add `resolvedModel` to AgentConfig |
| Modify | `src/agents/runtime.ts:888-948` | Pass `resolvedModel` in provider.chat() calls |
| Modify | `src/agents/loader.ts:15-64` | Update AgentYamlConfig model type |
| Modify | `tests/unit/agents/loader.test.ts` | Update loader tests for new schema |
| Modify | `src/config.ts:81-239` | Add `model_routing` to YamlConfig |
| Modify | `src/index.ts:265,1043-1046` | Create ModelRouter + provider registry, wire per-agent |
| Modify | `schemas/agent-config.schema.json:21-38` | Replace model schema |
| Modify | `config/default.yaml` | Add `model_routing` section |
| Modify | `agents/coordinator.yaml:4-6` | tier: standard |
| Modify | `agents/contacts.yaml:6-8` | tier: standard |
| Modify | `agents/calendar.yaml:7-9` | tier: standard |
| Modify | `agents/research-analyst.yaml:4-6` | tier: standard |
| Modify | `docs/specs/02-agent-system.md:27-30` | Update model docs |
| Modify | `docs/adr/003-yaml-agent-config-with-typescript-escape-hatch.md` | Cross-ref ADR-014 |

curia-deploy (separate repo, separate PR):

| Action | File | Change |
|--------|------|--------|
| Modify | `custom/agents/ceo-inbox.yaml` | tier: standard |
| Modify | `custom/agents/digest.yaml` | tier: standard |
| Modify | `custom/agents/essay-editor.yaml` | tier: standard |
| Modify | `custom/agents/writing-scout.yaml` | tier: standard |
| Modify | `custom/agents/T2125-expense-tracker.yaml` | tier: standard |
| Modify | `schemas/agent-config.schema.json` | Copy updated schema |

---

### Task 1: ModelRouter — tests

**Files:**
- Create: `src/agents/llm/model-router.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect } from 'vitest';
import { ModelRouter, type ModelRoutingConfig } from './model-router.js';
import { createSilentLogger } from '../../logger.js';

const defaultConfig: ModelRoutingConfig = {
  tiers: {
    fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    powerful: { provider: 'anthropic', model: 'claude-opus-4-6' },
  },
  default_tier: 'standard',
};

describe('ModelRouter', () => {
  it('resolves fast tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve('fast');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'fast' });
  });

  it('resolves standard tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve('standard');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'standard' });
  });

  it('resolves powerful tier to the configured model', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    const result = router.resolve('powerful');
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6', tier: 'powerful' });
  });

  it('throws on unknown tier', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    expect(() => router.resolve('ultra' as any)).toThrow('Unknown model tier');
  });

  it('passes needs through without validation', () => {
    const router = new ModelRouter(defaultConfig, createSilentLogger());
    // Should not throw — needs are documentary-only
    const result = router.resolve('standard', ['vision', 'large_context']);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('works with a non-anthropic provider in config', () => {
    const config: ModelRoutingConfig = {
      tiers: {
        fast: { provider: 'openrouter', model: 'meta-llama/llama-3-8b' },
        standard: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        powerful: { provider: 'anthropic', model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    };
    const router = new ModelRouter(config, createSilentLogger());
    const result = router.resolve('fast');
    expect(result).toEqual({ provider: 'openrouter', model: 'meta-llama/llama-3-8b', tier: 'fast' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/model-router.test.ts`
Expected: FAIL — `model-router.js` does not exist yet

- [ ] **Step 3: Commit failing test**

```bash
git -C /path/to/worktree add src/agents/llm/model-router.test.ts
git -C /path/to/worktree commit -m "test: add ModelRouter unit tests (red)"
```

---

### Task 2: ModelRouter — implementation

**Files:**
- Create: `src/agents/llm/model-router.ts`

- [ ] **Step 1: Write the ModelRouter**

```typescript
// model-router.ts — resolves capability tiers to concrete provider + model pairs.
//
// Agents declare a tier (fast | standard | powerful) in their YAML config.
// The operator maps tiers to models in config/default.yaml. This class
// performs the lookup at startup so the runtime knows which model to use.
//
// Capability needs (vision, large_context, etc.) are accepted but not
// validated in this version — they are documentary-only, logged at debug
// level for observability. Validation is deferred until multi-model
// support lands (#379).

import type { Logger } from '../../logger.js';

export type Tier = 'fast' | 'standard' | 'powerful';

export interface TierConfig {
  provider: string;
  model: string;
}

export interface ModelRoutingConfig {
  tiers: Record<Tier, TierConfig>;
  default_tier: Tier;
}

export interface ResolvedModel {
  provider: string;
  model: string;
  tier: Tier;
}

const VALID_TIERS: ReadonlySet<string> = new Set<string>(['fast', 'standard', 'powerful']);

export class ModelRouter {
  private readonly config: ModelRoutingConfig;
  private readonly logger: Logger;

  constructor(config: ModelRoutingConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Resolve a tier (and optional needs) to a concrete provider + model.
   *
   * Throws if the tier is unknown — this is a startup-fatal misconfiguration.
   * `needs` is accepted but not validated; logged at debug level so operators
   * can see what capabilities agents are requesting.
   */
  resolve(tier: string, needs?: string[]): ResolvedModel {
    if (!VALID_TIERS.has(tier)) {
      throw new Error(`Unknown model tier "${tier}". Valid tiers: ${[...VALID_TIERS].join(', ')}`);
    }

    const tierConfig = this.config.tiers[tier as Tier];

    if (needs && needs.length > 0) {
      // TODO: validate that the resolved model supports the declared needs
      // when capability metadata is available (model registry consolidation).
      this.logger.debug({ tier, needs, model: tierConfig.model }, 'Model tier resolved (needs not validated)');
    } else {
      this.logger.debug({ tier, model: tierConfig.model }, 'Model tier resolved');
    }

    return {
      provider: tierConfig.provider,
      model: tierConfig.model,
      tier: tier as Tier,
    };
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/model-router.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/agents/llm/model-router.ts
git -C /path/to/worktree commit -m "feat: add ModelRouter service for capability-tier resolution"
```

---

### Task 3: Add `model` param to LLMProvider interface

**Files:**
- Modify: `src/agents/llm/provider.ts:99-114`

- [ ] **Step 1: Update the `LLMProvider` interface**

In `src/agents/llm/provider.ts`, add `model?: string` to the chat params. The existing `options` escape hatch stays for other provider-specific knobs.

Replace lines 108-113:

```typescript
  // before
  chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    options?: Record<string, unknown>;
  }): Promise<LLMResponse>;
```

with:

```typescript
  chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): Promise<LLMResponse>;
```

- [ ] **Step 2: Update AnthropicProvider to use `params.model` directly**

In `src/agents/llm/anthropic.ts`, update the chat method signature (lines 31-41) to destructure `model` alongside the other params:

Replace:

```typescript
  async chat({
    messages,
    tools,
    toolResults,
    options,
  }: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
```

with:

```typescript
  async chat({
    messages,
    tools,
    toolResults,
    model: modelOverride,
    options,
  }: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;
    options?: Record<string, unknown>;
  }): Promise<LLMResponse> {
```

Then update line 106 where the model is resolved — replace:

```typescript
    const model = (options?.model as string) ?? 'claude-sonnet-4-6';
```

with:

```typescript
    // Prefer the explicit model param; fall back to options.model for backward
    // compatibility; default to sonnet if neither is provided.
    const model = modelOverride ?? (options?.model as string) ?? 'claude-sonnet-4-6';
```

- [ ] **Step 3: Update provider.test.ts mock to include `model` in the interface**

In `tests/unit/agents/llm/provider.test.ts`, the mock already works because `model` is optional. Verify the test still passes with no changes needed.

Run: `npx --prefix /path/to/worktree vitest run tests/unit/agents/llm/provider.test.ts`
Expected: PASS

- [ ] **Step 4: Update anthropic.test.ts — verify existing tests pass**

The existing test on line 43 already passes `options: { model: 'claude-opus-4-6' }` which will still work via the backward-compatible fallback path. Verify:

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/anthropic.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Add a test for the new `model` param in anthropic.test.ts**

Add this test at the end of the `'AnthropicProvider — provenance and cache tokens'` describe block (after the cache token test around line 101):

```typescript
  it('uses explicit model param over options.model', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'claude-haiku-4-5',
      options: { model: 'claude-opus-4-6' },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.model).toBe('claude-haiku-4-5');
  });

  it('falls back to options.model when model param is not provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      options: { model: 'claude-opus-4-6' },
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.model).toBe('claude-opus-4-6');
  });

  it('defaults to claude-sonnet-4-6 when neither model param nor options.model provided', async () => {
    const provider = new AnthropicProvider('test-key', createSilentLogger());
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0]![0];
    expect(params.model).toBe('claude-sonnet-4-6');
  });
```

- [ ] **Step 6: Run all provider/anthropic tests**

Run: `npx --prefix /path/to/worktree vitest run src/agents/llm/anthropic.test.ts tests/unit/agents/llm/provider.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git -C /path/to/worktree add src/agents/llm/provider.ts src/agents/llm/anthropic.ts src/agents/llm/anthropic.test.ts tests/unit/agents/llm/provider.test.ts
git -C /path/to/worktree commit -m "feat: add explicit model param to LLMProvider.chat()"
```

---

### Task 4: Add `resolvedModel` to AgentConfig and wire it through chatWithRetry

**Files:**
- Modify: `src/agents/runtime.ts:22-85` (AgentConfig interface)
- Modify: `src/agents/runtime.ts:888-990` (chatWithRetry provider.chat() calls)

- [ ] **Step 1: Add `resolvedModel` to AgentConfig**

In `src/agents/runtime.ts`, add the field to the `AgentConfig` interface after the `provider` field (line 25):

After:

```typescript
  provider: LLMProvider;
```

Add:

```typescript
  /** The concrete model ID resolved from the agent's capability tier by the ModelRouter.
   *  Passed to provider.chat() on every call so a single provider instance can serve
   *  multiple tiers. Set by bootstrap — always present for tier-routed agents. */
  resolvedModel: string;
```

- [ ] **Step 2: Pass `resolvedModel` in the provider.chat() calls inside chatWithRetry**

In `chatWithRetry()`, update line 948 where `provider.chat(params)` is called. Replace:

```typescript
    const response = await provider.chat(params);
```

with:

```typescript
    const response = await provider.chat({ ...params, model: this.config.resolvedModel });
```

Similarly, update the retry call at line 990. Replace:

```typescript
      const retryResponse = await provider.chat(params);
```

with:

```typescript
      const retryResponse = await provider.chat({ ...params, model: this.config.resolvedModel });
```

- [ ] **Step 3: Update test helper to include resolvedModel**

In `tests/unit/agents/runtime.test.ts`, the `new AgentRuntime({...})` calls need `resolvedModel`. Update the first test (line 48) — add `resolvedModel: 'mock-model'` to the config:

```typescript
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
    });
```

Apply the same change to every other `new AgentRuntime({...})` call in the file. Search for `new AgentRuntime` and add `resolvedModel: 'mock-model'` to each.

- [ ] **Step 4: Run runtime tests**

Run: `npx --prefix /path/to/worktree vitest run tests/unit/agents/runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/agents/runtime.ts tests/unit/agents/runtime.test.ts
git -C /path/to/worktree commit -m "feat: wire resolvedModel through AgentConfig into provider.chat() calls"
```

---

### Task 5: Update AgentYamlConfig type and JSON schema

**Files:**
- Modify: `src/agents/loader.ts:25-32`
- Modify: `schemas/agent-config.schema.json:21-38`

- [ ] **Step 1: Update the TypeScript type**

In `src/agents/loader.ts`, replace the `model` field in `AgentYamlConfig` (lines 25-32):

Replace:

```typescript
  model: {
    provider: string;
    model: string;
    fallback?: {
      provider: string;
      model: string;
    };
  };
```

with:

```typescript
  model: {
    tier: 'fast' | 'standard' | 'powerful';
    needs?: string[];
  };
```

- [ ] **Step 2: Update the JSON schema**

In `schemas/agent-config.schema.json`, replace the `model` property (lines 21-38):

Replace:

```json
    "model": {
      "type": "object",
      "required": ["provider", "model"],
      "additionalProperties": false,
      "properties": {
        "provider": { "type": "string", "minLength": 1 },
        "model": { "type": "string", "minLength": 1 },
        "fallback": {
          "type": "object",
          "required": ["provider", "model"],
          "additionalProperties": false,
          "properties": {
            "provider": { "type": "string", "minLength": 1 },
            "model": { "type": "string", "minLength": 1 }
          }
        }
      }
    },
```

with:

```json
    "model": {
      "type": "object",
      "required": ["tier"],
      "additionalProperties": false,
      "properties": {
        "tier": {
          "type": "string",
          "enum": ["fast", "standard", "powerful"]
        },
        "needs": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": ["vision", "large_context", "reasoning", "coding", "audio", "image_generation"]
          }
        }
      }
    },
```

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/agents/loader.ts schemas/agent-config.schema.json
git -C /path/to/worktree commit -m "feat: update AgentYamlConfig type and JSON schema for capability tiers"
```

---

### Task 6: Update loader tests

**Files:**
- Modify: `tests/unit/agents/loader.test.ts`

- [ ] **Step 1: Update existing tests to use new schema**

The loader tests create temp YAML files with the old `model.provider` + `model.model` format. Update all of them. Also update the assertion in the first test that checks `config.model.provider`.

In the first test (line 14), replace:

```typescript
    expect(config.model.provider).toBe('anthropic');
```

with:

```typescript
    expect(config.model.tier).toBe('standard');
```

In the `error_budget` test (lines 43-52), replace the YAML content:

```typescript
    const yamlContent = `
name: test-agent
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: "Test agent"
error_budget:
  max_turns: 10
  max_errors: 3
`;
```

with:

```typescript
    const yamlContent = `
name: test-agent
model:
  tier: standard
system_prompt: "Test agent"
error_budget:
  max_turns: 10
  max_errors: 3
`;
```

In the `schedule` test (lines 64-73), replace the YAML:

```typescript
    const yamlContent = `
name: writing-scout
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: "Scout agent"
schedule:
  - cron: "30 8 * * 2"
    agent_id: coordinator
    task: "Run the writing scout"
`;
```

with:

```typescript
    const yamlContent = `
name: writing-scout
model:
  tier: standard
system_prompt: "Scout agent"
schedule:
  - cron: "30 8 * * 2"
    agent_id: coordinator
    task: "Run the writing scout"
`;
```

In the `schedule entry without agent_id` test (lines 89-97), replace the YAML:

```typescript
    const yamlContent = `
name: test-sched
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: "Test"
schedule:
  - cron: "0 9 * * 1"
    task: "weekly task"
`;
```

with:

```typescript
    const yamlContent = `
name: test-sched
model:
  tier: standard
system_prompt: "Test"
schedule:
  - cron: "0 9 * * 1"
    task: "weekly task"
`;
```

- [ ] **Step 2: Add a test for the `needs` field**

Add after the last test:

```typescript
  it('parses model tier with needs array', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-test-'));
    const yamlContent = `
name: vision-agent
model:
  tier: powerful
  needs:
    - vision
    - large_context
system_prompt: "Agent with vision"
`;
    const filePath = path.join(tempDir, 'vision-agent.yaml');
    fs.writeFileSync(filePath, yamlContent);

    const config = loadAgentConfig(filePath);
    expect(config.model.tier).toBe('powerful');
    expect(config.model.needs).toEqual(['vision', 'large_context']);

    fs.rmSync(tempDir, { recursive: true });
  });
```

- [ ] **Step 3: Run loader tests (these will fail until agent YAMLs are updated in Task 7)**

The `loads and parses coordinator.yaml` and `loads all agent configs from a directory` tests read the actual agent YAML files. They will fail until those files are updated in Task 7. That's expected — we'll run the full suite after Task 7.

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add tests/unit/agents/loader.test.ts
git -C /path/to/worktree commit -m "test: update loader tests for capability-tier schema"
```

---

### Task 7: Migrate agent YAML files (curia repo)

**Files:**
- Modify: `agents/coordinator.yaml:4-6`
- Modify: `agents/contacts.yaml:6-8`
- Modify: `agents/calendar.yaml:7-9`
- Modify: `agents/research-analyst.yaml:4-6`

- [ ] **Step 1: Update coordinator.yaml**

Replace:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6
```

with:

```yaml
model:
  tier: standard
```

- [ ] **Step 2: Update contacts.yaml**

Same replacement as Step 1.

- [ ] **Step 3: Update calendar.yaml**

Same replacement as Step 1.

- [ ] **Step 4: Update research-analyst.yaml**

Same replacement as Step 1.

- [ ] **Step 5: Run loader tests**

Run: `npx --prefix /path/to/worktree vitest run tests/unit/agents/loader.test.ts`
Expected: All tests PASS (including the ones that read actual agent YAML files)

- [ ] **Step 6: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml agents/contacts.yaml agents/calendar.yaml agents/research-analyst.yaml
git -C /path/to/worktree commit -m "feat: migrate agent YAMLs to capability-tier schema"
```

---

### Task 8: Add `model_routing` to config

**Files:**
- Modify: `src/config.ts:81-239` (YamlConfig interface)
- Modify: `config/default.yaml`

- [ ] **Step 1: Add `model_routing` to the YamlConfig interface**

In `src/config.ts`, add the following field to the `YamlConfig` interface. Place it after the `contact_creation_limits` block (around line 238, just before the closing `}`):

```typescript
  /** Capability-tier model routing (ADR-014).
   *  Maps tier names to provider + model pairs. Agents declare a tier
   *  in their YAML; the operator controls which model each tier resolves to. */
  model_routing?: {
    tiers: {
      fast: { provider: string; model: string };
      standard: { provider: string; model: string };
      powerful: { provider: string; model: string };
    };
    default_tier: 'fast' | 'standard' | 'powerful';
  };
```

- [ ] **Step 2: Add `model_routing` section to `config/default.yaml`**

Add the following block at the top of `config/default.yaml` (before the `channels:` block, line 1). This makes it the first thing an operator sees — model routing is a top-level operational concern:

```yaml
# Capability-tier model routing (ADR-014).
# Agents declare a tier (fast | standard | powerful) — this config maps each
# tier to a concrete provider + model. Change these values to upgrade all
# agents of a tier in one place, or route tiers through different providers.
model_routing:
  tiers:
    fast:
      provider: anthropic
      model: claude-haiku-4-5
    standard:
      provider: anthropic
      model: claude-sonnet-4-6
    powerful:
      provider: anthropic
      model: claude-opus-4-6
  default_tier: standard

```

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/config.ts config/default.yaml
git -C /path/to/worktree commit -m "feat: add model_routing config section for capability-tier routing"
```

---

### Task 9: Wire ModelRouter into bootstrap

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports**

At the top of `src/index.ts` (near line 32 where other agent imports are), add:

```typescript
import { ModelRouter } from './agents/llm/model-router.js';
```

- [ ] **Step 2: Create ModelRouter and provider registry after llmProvider initialization**

After line 265 (`const llmProvider = new AnthropicProvider(config.anthropicApiKey, logger);`), add:

```typescript

  // Capability-tier model routing (ADR-014).
  // The ModelRouter resolves tier declarations from agent YAML to concrete
  // provider + model pairs. The provider registry maps provider names to
  // LLMProvider instances. Today only 'anthropic' exists; when OpenRouter
  // lands (#379), a second entry is added here.
  const modelRoutingConfig = yamlConfig.model_routing;
  if (!modelRoutingConfig) {
    logger.fatal('model_routing config section is required in config/default.yaml');
    process.exit(1);
  }
  const modelRouter = new ModelRouter(modelRoutingConfig, logger);
  const providerRegistry = new Map<string, LLMProvider>([
    ['anthropic', llmProvider],
  ]);
```

- [ ] **Step 3: Resolve tier per agent and look up provider**

In the agent wiring loop (around line 1043), replace the hard-coded provider reference. Find the section:

```typescript
    const agent = new AgentRuntime({
      agentId: agentConfig.name,
      systemPrompt,
      provider: llmProvider,
```

Before the `new AgentRuntime({` call, add the tier resolution:

```typescript
    // Resolve this agent's capability tier to a concrete provider + model.
    const resolved = modelRouter.resolve(agentConfig.model.tier, agentConfig.model.needs);
    const agentProvider = providerRegistry.get(resolved.provider);
    if (!agentProvider) {
      logger.fatal({ provider: resolved.provider, agent: agentConfig.name, tier: resolved.tier },
        'No provider registered for tier-resolved provider name');
      process.exit(1);
    }
```

Then update the AgentRuntime constructor to use the resolved values:

```typescript
    const agent = new AgentRuntime({
      agentId: agentConfig.name,
      systemPrompt,
      provider: agentProvider,
      resolvedModel: resolved.model,
```

- [ ] **Step 4: Run the full test suite**

Run: `npx --prefix /path/to/worktree vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add src/index.ts
git -C /path/to/worktree commit -m "feat: wire ModelRouter into bootstrap for per-agent tier resolution"
```

---

### Task 10: Update documentation

**Files:**
- Modify: `docs/specs/02-agent-system.md`
- Modify: `docs/adr/003-yaml-agent-config-with-typescript-escape-hatch.md`

- [ ] **Step 1: Update agent system spec**

In `docs/specs/02-agent-system.md`, find the coordinator config example (around lines 27-30) and replace:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6
```

with:

```yaml
model:
  tier: standard
```

Also add a brief section after the coordinator config block explaining the tier system:

```markdown
### Model Routing

Agents declare a capability tier rather than a specific model (see [ADR-014](../adr/014-capability-tier-model-routing.md)):

| Tier | Intended use |
|------|-------------|
| `fast` | Classification, routing, simple extraction |
| `standard` | General-purpose task execution |
| `powerful` | Complex multi-step reasoning, synthesis |

The operator maps tiers to models in `config/default.yaml` → `model_routing`. The `ModelRouter` service resolves each agent's tier to a `{ provider, model }` pair at startup.

Optional `needs` flags (`vision`, `large_context`, `reasoning`, `coding`, `audio`, `image_generation`) are documentary — they inform future routing decisions but are not validated in this version.
```

- [ ] **Step 2: Add cross-reference to ADR-003**

In `docs/adr/003-yaml-agent-config-with-typescript-escape-hatch.md`, add at the end of the document:

```markdown

## Superseded (partial)

The `model.provider` + `model.model` fields originally defined in this ADR have been replaced by capability-tier routing. See [ADR-014](./014-capability-tier-model-routing.md) for the current model declaration schema.
```

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add docs/specs/02-agent-system.md docs/adr/003-yaml-agent-config-with-typescript-escape-hatch.md
git -C /path/to/worktree commit -m "docs: update agent system spec and ADR-003 for capability-tier routing"
```

---

### Task 11: Run full test suite and fix any breakage

- [ ] **Step 1: Run the full test suite**

Run: `npx --prefix /path/to/worktree vitest run`

- [ ] **Step 2: Fix any failures**

Common issues to watch for:
- Other test files that create `new AgentRuntime({...})` without the new `resolvedModel` field — search all test files for `new AgentRuntime` and add `resolvedModel: 'mock-model'` to each
- Integration tests that load real agent YAML files — these should pass since the YAMLs were updated in Task 7
- Any code that reads `agentConfig.model.provider` or `agentConfig.model.model` outside of the files already modified — search for these patterns and update

Run: `npx --prefix /path/to/worktree vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit any fixes**

```bash
git -C /path/to/worktree add -A
git -C /path/to/worktree commit -m "fix: address test breakage from capability-tier schema migration"
```

---

### Task 12: Migrate curia-deploy agent YAMLs (separate PR)

This task runs in a separate worktree on the curia-deploy repo.

**Files:**
- Modify: `custom/agents/ceo-inbox.yaml`
- Modify: `custom/agents/digest.yaml`
- Modify: `custom/agents/essay-editor.yaml`
- Modify: `custom/agents/writing-scout.yaml`
- Modify: `custom/agents/T2125-expense-tracker.yaml`
- Modify: `schemas/agent-config.schema.json` (if present — copy from curia)

- [ ] **Step 1: Create worktree on curia-deploy**

```bash
git -C /path/to/repos/curia-deploy pull --ff-only origin main
git -C /path/to/repos/curia-deploy worktree add ../curia-deploy-capability-tier -b feat/capability-tier-routing
```

Symlink `.env` if needed.

- [ ] **Step 2: Update all 5 agent YAMLs**

In each file, replace:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6   # or claude-sonnet-4-20250514
```

with:

```yaml
model:
  tier: standard
```

- [ ] **Step 3: Copy updated JSON schema if present**

If `schemas/agent-config.schema.json` exists in curia-deploy, update it to match the version from curia (Task 5 Step 2).

- [ ] **Step 4: Commit and create PR**

```bash
git -C /path/to/worktree add custom/agents/ schemas/
git -C /path/to/worktree commit -m "feat: migrate agent YAMLs to capability-tier schema"
```

Create a PR linking to curia #260. This PR should be merged **after** the curia PR, since curia-deploy depends on the new schema at runtime.

---

### Task 13: File follow-up issue for model metadata consolidation

- [ ] **Step 1: Create the GitHub issue**

Create an issue on josephfung/curia with:
- Title: "Consolidate model metadata into a model registry"
- Body: explain that model metadata is scattered across `pricing.ts`, `model_routing` config, context budgeting (#24), and `autonomy_scoring` config. A model registry would unify these.
- Labels: `enhancement`, `optimization`, appropriate size label
- Reference: #260, #24, #379

- [ ] **Step 2: Update issue #379 description**

Add a note to #379 that agents no longer declare `model.provider` + `model.model` directly — the OpenRouter provider will be wired through the tier routing config and provider registry, not per-agent YAML.

---

### Task 14: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

Under `## [Unreleased]`, add to the **Changed** section:

```markdown
- **Model routing** — agents declare a capability tier (`fast`/`standard`/`powerful`) instead of a specific model; operator maps tiers to models centrally in `config/default.yaml`. (#260)
```

- [ ] **Step 2: Commit**

```bash
git -C /path/to/worktree add CHANGELOG.md
git -C /path/to/worktree commit -m "docs: add capability-tier routing changelog entry"
```
