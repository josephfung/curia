# Model Registry Consolidation

**Issue:** [#556](https://github.com/josephfung/curia/issues/556)
**Related:** [#379](https://github.com/josephfung/curia/issues/379) (OpenRouter multi-model support)
**Date:** 2026-05-19

## Problem

Model metadata is scattered across five independent locations:

| Location | What it stores |
|----------|---------------|
| `src/agents/llm/pricing.ts` | Per-model token costs (input, output, cache creation, cache read) |
| `src/agents/llm/token-estimator.ts` | Context window sizes, `DEFAULT_MODEL_NAME` constant |
| `config/default.yaml` → `model_routing.tiers` | Tier-to-model mapping with redundant `provider` field |
| `config/default.yaml` → `autonomy_scoring.model` | Hardcoded model ID outside the tier system |
| `src/agents/llm/anthropic.ts` line 109 | Hardcoded sonnet fallback |

Additionally, three skill handlers (`extract-facts`, `extract-relationships`, `file-parse`)
construct their own raw `Anthropic` SDK clients with hardcoded model IDs, bypassing the
`LLMProvider` abstraction and cost telemetry entirely.

The same three model IDs (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`) appear
independently in each location. A model rename requires touching all of them. There is no
cross-check that pricing and context window maps cover the same models.

## Decision

### Separation of concerns

- **TypeScript registry** = what models Curia officially supports (developer concern, compile-time safety)
- **YAML config** = which models this deployment uses for which tiers (operator concern, runtime config)

### New module: `src/agents/llm/model-registry.ts`

Single source of truth for model metadata. Defines the following types and exports:

```typescript
interface ModelPricing {
  inputPerMToken: number;
  outputPerMToken: number;
  cacheCreationPerMToken?: number;  // undefined = model doesn't support caching
  cacheReadPerMToken?: number;      // undefined = model doesn't support caching
}

interface ModelMetadata {
  provider: string;              // 'anthropic', 'openrouter', etc.
  contextWindow: number;         // max tokens
  pricing: ModelPricing;
  capabilities: string[];        // 'vision', 'reasoning', 'coding', etc.
  maxOutputTokens?: number;      // default 4096 if unset
}
```

The `MODEL_REGISTRY` constant is a `Record<string, ModelMetadata>` keyed by base model name
prefix. It contains the three current Anthropic models. Entries are pre-sorted by key length
descending at module level to preserve the existing prefix-match strategy (longer, more specific
prefixes win — so `claude-haiku-4-5-20251001` matches `claude-haiku-4-5`).

The `ModelRegistry` class wraps lookup methods:

- `getModel(modelId: string): ModelMetadata | undefined` — prefix-match lookup
- `getContextWindow(modelId: string): number` — replaces `token-estimator.ts`'s function
- `getPricing(modelId: string): ModelPricing | undefined` — replaces `pricing.ts`'s internal lookup
- `getProvider(modelId: string): string | undefined` — resolves provider from model name
- `isKnownModel(modelId: string): boolean` — replaces `isKnownContextWindowModel()`

Instantiated once at startup, passed to consumers via constructor injection.

### Capabilities schema

The registry includes a `capabilities` string array per model, populated with what is true
today (e.g., all Anthropic models get `vision`, none get `image_generation`). The capability
vocabulary follows ADR-014: `vision`, `large_context`, `reasoning`, `coding`, `audio`,
`image_generation`.

The `needs`-based validation in `ModelRouter.resolve()` is **not** implemented in this issue —
the data structure is ready for #379 to wire up enforcement. The existing TODO stays.

### YAML config changes

`config/default.yaml` `model_routing` section simplifies:

```yaml
model_routing:
  tiers:
    fast:
      model: claude-haiku-4-5
    standard:
      model: claude-sonnet-4-6
    powerful:
      model: claude-opus-4-6
  default_tier: standard
```

Changes from current config:
- **`provider` field removed from tier config.** Provider is a property of the model in the
  registry, not declared per-tier. Eliminates the possibility of a provider/model mismatch.
- **`autonomy_scoring.model` becomes `autonomy_scoring.model_tier: fast`.** Resolved through
  `ModelRouter` like everything else. Named `model_tier` (not just `tier`) for clarity in
  a config file that also defines tier mappings elsewhere.

### Consumer migration

**`pricing.ts`** — `ANTHROPIC_PRICING` constant and prefix-match logic deleted.
`estimateCostUsd()` is rewritten to look up pricing from a `ModelRegistry` instance. The
registry is injected at module level (the function is constructed with a registry reference
at startup), not passed per-call — so the call signature for callers (`estimateCostUsd(model,
usage, logger)`) stays the same.

**`token-estimator.ts`** — `CONTEXT_WINDOWS`, `getContextWindow()`,
`isKnownContextWindowModel()`, and `DEFAULT_MODEL_NAME` all deleted. Callers switch to
`modelRegistry.getContextWindow(modelId)`. The `DEFAULT_MODEL_NAME` concept goes away — the
default is `modelRouter.resolve()` with no tier argument (uses `default_tier` from config).

**`anthropic.ts`** — hardcoded `'claude-sonnet-4-6'` fallback on line 109 removed. Model is
always passed explicitly by the runtime (which already does this). Hardcoded `maxTokens: 4096`
becomes `modelRegistry.getModel(model)?.maxOutputTokens ?? 4096`.

**`model-router.ts`** — `TierConfig` drops the `provider` field. `resolve()` returns
`{ model, tier }` and the runtime looks up the provider from the registry. The `needs`
validation TODO gets the data structure it needs but enforcement is deferred to #379.

**`runtime.ts`** — minimal changes. Already calls `getContextWindow()` and
`estimateCostUsd()` — those get backed by the registry. Provider lookup changes from
`providerRegistry.get('anthropic')` to
`providerRegistry.get(modelRegistry.getProvider(resolvedModel))`.

**Skill handlers (`extract-facts`, `extract-relationships`, `file-parse`)** — these three
infrastructure skills currently construct their own raw `Anthropic` SDK clients via
`ctx.secret('ANTHROPIC_API_KEY')` and hardcode model IDs. The migration uses Curia's existing
SkillContext capability system:

1. Add `llmProvider` and `modelRouter` as new capabilities in the `SkillContext` interface
   and the `capabilities` allowlist in the skill manifest schema.
2. Only these three infrastructure skills' `skill.json` files declare
   `"capabilities": ["llmProvider", "modelRouter"]`. No other skills need or should
   request these capabilities.
3. The execution layer injects the shared `LLMProvider` instance and `ModelRouter` into
   `SkillContext` at invocation time (same pattern as `bus`, `agentRegistry`, etc.).
4. Handlers replace `new Anthropic()` + hardcoded model IDs with:
   ```typescript
   const classifierModel = ctx.modelRouter!.resolve('fast').model;
   const extractionModel = ctx.modelRouter!.resolve('standard').model;
   const response = await ctx.llmProvider!.chat({ model: classifierModel, messages: [...] });
   ```
5. The `@anthropic-ai/sdk` import and `CLASSIFIER_MODEL` / `EXTRACTION_MODEL` constants
   are removed from each handler.

This brings all three skills' LLM calls into the telemetry/cost-tracking path (they currently
bypass `llm.call` bus events entirely).

Note: `llmProvider` and `modelRouter` are new additions to the SkillContext public API surface.
This is a backwards-compatible addition (new optional properties). However, exposing direct
LLM access through the skill capability system is a pragmatic choice, not an ideal one —
any skill author could declare these capabilities and get unsandboxed LLM access. A follow-up
issue will explore redesigning these three infrastructure skills to eliminate the need for
`llmProvider` and `modelRouter` on the SkillContext surface (e.g., promoting them out of the
skill system, or providing a more constrained LLM access pattern). See the follow-up issue
linked in the Out of Scope section.

**`autonomy/scoring-pass.ts`** — stops accepting a model string. Receives a `model_tier`
(from config) and resolves via `ModelRouter`.

**`memory/working-memory.ts` and `scheduler/drift-detector.ts`** — currently call
`provider.chat()` with no model override. They get an explicit tier config (defaulting to
`standard`) so the model is intentional rather than an implicit provider default.

### Startup wiring and validation

In `src/index.ts`, the startup sequence becomes:

1. **Instantiate `ModelRegistry`** — `new ModelRegistry(logger)`. Static TypeScript data,
   no config needed.
2. **Instantiate `ModelRouter`** — `new ModelRouter(yamlConfig.model_routing, modelRegistry, logger)`.
   At construction, validates every tier's `model` exists in the registry. Unknown model →
   fail-fast.
3. **Build `providerRegistry`** — `Map<string, LLMProvider>` keyed by provider IDs from the
   registry (currently just `'anthropic'`). When #379 lands, `'openrouter'` gets a second entry.
4. **Validate completeness** — after building the provider registry, check that every provider
   referenced by any model in the registry has a corresponding entry in `providerRegistry`.
   Catches the case where a model declares `provider: 'openrouter'` but the API key is missing
   or the provider isn't instantiated.
5. **Resolve agents** — same loop. `modelRouter.resolve(tier, needs)` → `{ model, tier }`.
   Runtime looks up provider via `modelRegistry.getProvider(model)` → `providerRegistry.get(id)`.

Validation order: registry (static) → router (tiers against registry) → provider registry
(providers instantiated) → agent resolution (needs against capabilities, deferred to #379).

### Prefix-match strategy

The existing prefix-matching behavior from `pricing.ts` and `token-estimator.ts` is preserved.
Registry keys are base model names (`claude-haiku-4-5`). Lookups use `startsWith` matching,
with entries pre-sorted by key length descending so longer prefixes win. This allows versioned
model IDs (`claude-haiku-4-5-20251001`) to resolve without being listed explicitly.

## Out of scope

- **`needs` enforcement in `ModelRouter.resolve()`** — registry provides capabilities data,
  but warning/failing on unmet needs is deferred to #379.
- **OpenRouter models in the registry** — no entries until #379 adds the provider. Schema
  supports `provider: 'openrouter'` from day one.
- **OpenAI direct usages** (DALL-E image generation, text-embedding-3-small for knowledge
  graph, GPT-4o smoke test judge) — different API surfaces, not part of the
  `LLMProvider.chat()` path. These stay as-is.
- **Skill handler logic changes beyond model migration** — `extract-facts`,
  `extract-relationships`, and `file-parse` get migrated to shared provider and tier routing
  but no other changes to their logic.
- **`maxOutputTokens` per-model tuning** — field exists in `ModelMetadata`, all models start
  at 4096. Per-model tuning is a future concern.
- **Redesigning infrastructure skill LLM access (#637)** — the `llmProvider` and `modelRouter`
  SkillContext capabilities are a pragmatic stopgap. #637 will explore better patterns
  (e.g., promoting these skills out of the skill system, or a constrained LLM access layer)
  to avoid exposing direct LLM access on the public skill API surface.

## Files affected

### New files
- `src/agents/llm/model-registry.ts` — registry module, types, and class
- `src/agents/llm/model-registry.test.ts` — unit tests

### Modified files
- `src/agents/llm/pricing.ts` — delete `ANTHROPIC_PRICING`, rewrite `estimateCostUsd()` to use registry
- `src/agents/llm/token-estimator.ts` — delete `CONTEXT_WINDOWS`, `getContextWindow()`, `isKnownContextWindowModel()`, `DEFAULT_MODEL_NAME`
- `src/agents/llm/model-router.ts` — drop `provider` from `TierConfig`, accept `ModelRegistry` in constructor
- `src/agents/llm/anthropic.ts` — remove hardcoded model fallback, use registry for `maxOutputTokens`
- `src/agents/runtime.ts` — switch to registry-backed lookups, provider resolution via registry
- `src/index.ts` — new startup wiring, validation chain, autonomy scoring tier config
- `src/config.ts` — update `YamlConfig` types (`TierConfig` without `provider`, `autonomy_scoring.model_tier` replacing `.model`)
- `config/default.yaml` — simplify tier config, change `autonomy_scoring.model` to `.model_tier`
- `src/skills/types.ts` — add `llmProvider` and `modelRouter` optional properties to `SkillContext`
- `src/skills/execution-layer.ts` (or equivalent) — inject `llmProvider` and `modelRouter` into context for capable skills
- `skills/extract-facts/handler.ts` — remove raw SDK client, use `ctx.llmProvider` + `ctx.modelRouter`
- `skills/extract-facts/skill.json` — add `capabilities: ["llmProvider", "modelRouter"]`
- `skills/extract-relationships/handler.ts` — same migration
- `skills/extract-relationships/skill.json` — add capabilities
- `skills/file-parse/handler.ts` — same migration
- `skills/file-parse/skill.json` — add capabilities
- `src/autonomy/scoring-pass.ts` — accept tier instead of model string
- `src/memory/working-memory.ts` — add explicit tier/model config
- `src/scheduler/drift-detector.ts` — add explicit tier/model config
