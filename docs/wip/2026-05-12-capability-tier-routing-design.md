# Capability-Tier Model Routing — Design Spec

Implements [#260](https://github.com/josephfung/curia/issues/260).
Follows [ADR-014](../adr/014-capability-tier-model-routing.md).

## Problem

Every agent YAML declares `model.provider` + `model.model`, but the runtime
ignores these values — bootstrap creates a single global `AnthropicProvider`
and passes it to every agent. The per-agent declarations are dead config that
creates a false sense of control, blocks portability, and prevents centralized
model management.

## Goals

1. Agents declare **what they need** (a capability tier), not which model to use
2. The operator maps tiers to models in one place (`config/default.yaml`)
3. The runtime resolves tier to model at startup and passes it per-call
4. Clean cutover — remove old `model.provider` + `model.model` from all agent
   YAMLs in both `curia` and `curia-deploy`
5. Set up the right seams for future multi-provider routing (#379 OpenRouter)

## Non-Goals

- Capability validation (checking that a model supports declared `needs` flags)
- Multi-provider routing (only `AnthropicProvider` exists today)
- Runtime model switching or hot-reload of tier mappings
- Per-call tier override by agents at runtime

## Schema Changes

### Agent YAML — `model` field

```yaml
# Before
model:
  provider: anthropic
  model: claude-sonnet-4-6

# After
model:
  tier: standard          # required: fast | standard | powerful
  needs: []               # optional, documentary-only for now
```

- `tier` is required. One of `fast`, `standard`, `powerful`.
- `needs` is optional, defaults to `[]`. Accepted values: `vision`,
  `large_context`, `reasoning`, `coding`, `audio`, `image_generation`.
  Not validated against model capabilities in this version — purely
  documentary to inform future routing decisions.

### Operator config — new `model_routing` section in `config/default.yaml`

```yaml
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

- `tiers` maps each tier name to a `{ provider, model }` pair.
- `default_tier` is the fallback if an agent YAML somehow omits the tier
  (shouldn't happen with schema validation, but belt-and-suspenders).
- All three tiers must be defined. Missing tiers cause a startup error.

### Tier semantics

| Tier | Intended use | Cost profile |
|------|-------------|--------------|
| `fast` | Classification, routing, simple extraction, triage | Lowest cost, fastest response |
| `standard` | General-purpose task execution, most agent work | Balanced cost and capability |
| `powerful` | Complex multi-step reasoning, synthesis, research | Highest cost, most capable |

### TypeScript types

In `src/agents/loader.ts`, `AgentYamlConfig.model` changes:

```typescript
// Before
model: {
  provider: string;
  model: string;
  fallback?: { provider: string; model: string };
};

// After
model: {
  tier: 'fast' | 'standard' | 'powerful';
  needs?: string[];
};
```

### JSON schema

`schemas/agent-config.schema.json` — the `model` object changes from requiring
`provider` + `model` to requiring `tier`, with optional `needs` array. The
`fallback` field is removed (fallback is an operator concern, not an agent
concern — future work if needed).

## ModelRouter Service

New file: `src/agents/llm/model-router.ts`

```typescript
import type { Logger } from '../../logger.js';

type Tier = 'fast' | 'standard' | 'powerful';

interface TierConfig {
  provider: string;
  model: string;
}

interface ModelRoutingConfig {
  tiers: Record<Tier, TierConfig>;
  default_tier: Tier;
}

interface ResolvedModel {
  provider: string;
  model: string;
  tier: Tier;
}

class ModelRouter {
  private readonly config: ModelRoutingConfig;
  private readonly logger: Logger;

  constructor(config: ModelRoutingConfig, logger: Logger) { ... }

  /**
   * Resolve a tier (and optional needs) to a concrete provider + model.
   *
   * Throws if the tier is unknown. `needs` is accepted but not validated
   * in this version — logged at debug level for observability.
   */
  resolve(tier: Tier, needs?: string[]): ResolvedModel { ... }
}
```

The class is intentionally small — a lookup with logging. It exists as a named
concept so that:
- Resolution logic is testable in isolation
- Future capability validation and multi-provider routing have a home
- The runtime can log `tier → resolved_model` at agent startup for auditability

## LLMProvider Interface Change

`src/agents/llm/provider.ts` — add an explicit `model` field to the chat params:

```typescript
export interface LLMProvider {
  id: string;
  chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
    model?: string;           // new: override the provider's default model
    options?: Record<string, unknown>;
  }): Promise<LLMResponse>;
}
```

`AnthropicProvider.chat()` uses `params.model` when provided, falling back to
its current hardcoded default. This is a backward-compatible change — existing
callers that don't pass `model` continue to work.

This design means a single `AnthropicProvider` instance serves all tiers. The
provider is a stateless API client; the model varies per call.

## Bootstrap Integration

`src/index.ts` changes:

1. **Load `model_routing`** from the parsed config.
2. **Create `ModelRouter`** instance.
3. **Create provider registry** — a `Map<string, LLMProvider>`. Today this has
   one entry: `{ 'anthropic': anthropicProvider }`. When #379 (OpenRouter)
   lands, a second entry is added here — no other changes needed.
4. **Per-agent wiring** — for each loaded agent YAML:
   - Call `router.resolve(agent.model.tier, agent.model.needs)`
   - Look up the provider instance from the registry using `resolved.provider`
   - Store the resolved model ID alongside the provider for use in
     `runtime.chatWithRetry()`
5. **Pass model per-call** — `AgentRuntime` receives the resolved model ID
   (e.g., as a field on `AgentConfig`) and includes it in every `provider.chat()`
   call.

### AgentConfig update

The `AgentConfig` interface in `runtime.ts` gains a `resolvedModel` field:

```typescript
export interface AgentConfig {
  // ... existing fields ...
  resolvedModel: string;  // set by bootstrap from ModelRouter; always present
}
```

`chatWithRetry()` passes `this.config.resolvedModel` as `params.model` to the
provider. This field is required — bootstrap always resolves the tier before
constructing the runtime. The `model` param on `LLMProvider.chat()` remains
optional so the interface stays usable outside the agent bootstrap path.

## Agent YAML Migration

All 9 agent YAMLs across both repos get updated. No agent currently needs
anything other than `standard` tier.

### curia repo (4 agents)

| File | Current model | New tier |
|------|--------------|----------|
| `agents/coordinator.yaml` | `claude-sonnet-4-6` | `standard` |
| `agents/contacts.yaml` | `claude-sonnet-4-6` | `standard` |
| `agents/calendar.yaml` | `claude-sonnet-4-6` | `standard` |
| `agents/research-analyst.yaml` | `claude-sonnet-4-6` | `standard` |

### curia-deploy repo (5 agents)

| File | Current model | New tier |
|------|--------------|----------|
| `custom/agents/ceo-inbox.yaml` | `claude-sonnet-4-6` | `standard` |
| `custom/agents/digest.yaml` | `claude-sonnet-4-20250514` | `standard` |
| `custom/agents/essay-editor.yaml` | `claude-sonnet-4-20250514` | `standard` |
| `custom/agents/writing-scout.yaml` | `claude-sonnet-4-20250514` | `standard` |
| `custom/agents/T2125-expense-tracker.yaml` | `claude-sonnet-4-6` | `standard` |

Note: three curia-deploy agents are on the older `claude-sonnet-4-20250514`
model ID. The tier system normalizes them all to whatever `standard` maps to
in the operator config.

## Documentation Updates

1. **`docs/specs/02-agent-system.md`** — update the model section to show the
   new tier-based schema, add a brief description of the ModelRouter concept
2. **`docs/adr/003-yaml-agent-config-with-typescript-escape-hatch.md`** — add
   a cross-reference noting that ADR-014 supersedes the model declaration
   pattern from ADR-003
3. **Issue #379** — update description post-merge; agents no longer declare
   `provider` + `model` directly, so OpenRouter integration routes through
   tier config rather than per-agent YAML

## Future Work: Model Metadata Consolidation

Model metadata is currently scattered across multiple locations:

| Location | What it stores |
|----------|---------------|
| `src/agents/llm/pricing.ts` | Per-model token costs (input, output, cache) |
| `config/default.yaml` → `model_routing` | Tier-to-model mapping (new in this spec) |
| Context budgeting (#24) | Max context window per model (planned) |
| `config/default.yaml` → `autonomy_scoring` | Hardcoded `claude-haiku-4-5` for scoring (line 255) |

A natural consolidation would be a **model registry** — a config-driven source
mapping model IDs to their properties (pricing, context window, capabilities).
`ModelRouter` would reference it, `pricing.ts` would query it, and context
budgeting would use it for window limits.

This is out of scope for #260 but should be tracked as a follow-up issue.
The `autonomy_scoring` model reference in `config/default.yaml` is also a
candidate for tier-based routing (it could use `fast` tier instead of a
hardcoded model ID).

## Testing

- **Unit tests for `ModelRouter`** — resolve each tier, unknown tier throws,
  needs are passed through without validation, default_tier fallback
- **Unit test for `AnthropicProvider.chat()`** — verify `params.model`
  override is respected when present, default used when absent
- **Integration: bootstrap validation** — startup fails if `model_routing`
  config is missing required tiers
- **Integration: agent loading** — agents with `tier` field load correctly;
  agents with old `provider`+`model` fields fail schema validation

## Acceptance Criteria

- [ ] Agent YAML files declare `model.tier` (not `model.provider` + `model.model`)
- [ ] `config/default.yaml` has a `model_routing` section mapping all three tiers
- [ ] `ModelRouter` resolves tier to `{ provider, model }` at startup
- [ ] `LLMProvider.chat()` accepts a `model` parameter; `AnthropicProvider` uses it
- [ ] Bootstrap creates a provider registry and wires agents through `ModelRouter`
- [ ] All 4 curia agent YAMLs updated to new schema
- [ ] All 5 curia-deploy agent YAMLs updated to new schema
- [ ] JSON schema (`schemas/agent-config.schema.json`) updated
- [ ] `docs/specs/02-agent-system.md` updated
- [ ] ADR-003 cross-references ADR-014
- [ ] Unit tests for `ModelRouter` pass
- [ ] Unit test for provider `model` override passes
- [ ] Startup succeeds with new config; agents resolve to correct models
- [ ] Follow-up issue filed for model metadata consolidation
