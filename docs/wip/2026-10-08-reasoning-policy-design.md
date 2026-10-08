# Reasoning policy — design (#2044)

The decisions and the evidence for them are in [ADR-048](../adr/048-reasoning-policy.md).
This document covers how they are built, in what order, and how each change is A/B-tested.

**Scope.** #2044 delivers the ADR, the `llm.call` telemetry, reasoning pass-back, the
per-tier reasoning setting, and the effort A/B, in sequenced PRs. PR 0 (this design) lands
first; the implementation PRs start when they are scheduled.

## PR sequence

| PR | Delivers | A/B |
|---|---|---|
| 0 | ADR-048, this design, and the trim plan's temperature note | none (docs only) |
| 1 | `llm.call` gains `reasoningTokens`, `reasoningEffort`, `upstreamProvider`; the suites print reasoning tokens and latency per agent | none (telemetry only; no request changes) |
| 2 | Reasoning pass-back on both providers | main vs branch |
| 3 | The `reasoning.effort` setting: registry, config, providers, runtime, and the suites' `--reasoning-effort` flag | none (no default changes; unit tests prove an unset setting sends nothing) |
| 4 | The effort A/B on the standard tier, and the ADR's consequences updated with the result | unset vs `low` vs `max` |

Each PR updates `CHANGELOG.md`. PR 1 calls out the bus-event change as a public API change.

## PR 1 — telemetry

**`llm.call` payload** (`src/bus/events.ts`, `LlmCallPayload`). Three optional fields sit
next to `outputTokens` and `temperature`:

```ts
/** Reasoning tokens the provider reported (a subset of outputTokens). null when not reported. */
reasoningTokens?: number | null;
/** Reasoning effort sent on the request. null when the request sent none (provider default). */
reasoningEffort?: ReasoningEffort | null;
/** Upstream endpoint that served an OpenRouter call (OpenRouter's `provider` field). null elsewhere. */
upstreamProvider?: string | null;
```

**Sources.**
- **`reasoningTokens`.**
  - OpenRouter: `LLMUsage.reasoningTokens`, set by `usageFromOpenRouter`.
  - Anthropic: the thinking-token count in the response usage, once thinking can be on. Check the field name against the installed `@anthropic-ai/sdk` types; the docs name `usage.output_tokens_details.thinking_tokens`.
- **`upstreamProvider`.** The OpenRouter response body carries a top-level `provider` string, which the OpenAI SDK type does not declare. Read it defensively in `chat()` and from stream chunks, and carry it on `LLMCallProvenance`.
- **`reasoningEffort`.** Comes from `parseReasoning(options)` (PR 3). Until PR 3 lands, every publisher writes `null`.

**Publishers.** Five sites publish `llm.call`, and all of them set the new fields:
- `AgentRuntime.publishLlmCall`
- `TelemetryLlmProvider`
- the outbound judge
- the escalation judge
- `infra-llm`

`createLlmCall` keeps them optional for test fixtures, the same pattern as `temperature`.

**Suites** (`tests/shared/usage.ts`).
- `CallUsage` and `UsageTotals` gain `reasoningTokens`.
- The ledger also keeps per-agent latency samples, so `formatUsageLines` can print `reasoning` and `p50/p90 latency` for each agent.
- The harness reads both from the `llm.call` payload it already consumes.

## PR 2 — reasoning pass-back

**Neutral block** (`src/agents/llm/provider.ts`). Add a `ContentBlock` variant:

```ts
/**
 * Reasoning a provider returned beside tool calls, carried back verbatim on the next
 * request of the same tool loop (ADR-048). `data` is provider-native and opaque:
 * OpenRouter's `reasoning_details` array, or one Anthropic `thinking` /
 * `redacted_thinking` block. Never rebuilt from the archive.
 */
export interface ReasoningContent {
  type: 'reasoning';
  provider: 'openrouter' | 'anthropic';
  /** Model that produced it. A provider drops blocks from any other model. */
  model: string;
  data: unknown;
}
```

The `tool_use` variants of `LLMResponse` and `LLMStreamEvent` gain
`reasoningBlocks?: ReasoningContent[]`. `llmResponseAsStream` forwards them.

**Tool loop.**
- `buildAssistantToolUseMessage(toolCalls, content, reasoningBlocks)` puts reasoning blocks **first**. Anthropic requires the assistant turn to begin with its thinking block.
- `runStreamingToolLoop` passes the event's blocks through.
- Final `message_end` turns carry none.
- `memory.addTurn` stores text only, so no reasoning reaches conversation history.

**OpenRouter** (`openrouter.ts`).
- **Capture, non-streaming:** keep `choice.message.reasoning_details` as received: one block, with `data` set to the array. The existing `absorbReasoningDetail` stays for the readable-text summary only.
- **Capture, streaming:** rebuild the array from `delta.reasoning_details` fragments. Merge by `index`, falling back to `id`, concatenate `text`/`summary`/`data`, and keep `signature`, `format` and `id`. A unit test compares the rebuilt array with the non-streamed shape for the same recorded response.
- **Send back:** an assistant message whose blocks include an OpenRouter reasoning block for the request's model gets `reasoning_details: data`. That is a typed extension of `ChatCompletionAssistantMessageParam`. Blocks for another model or provider are dropped, with a debug log.

**Anthropic** (`anthropic.ts`).
- **Capture:** keep every `thinking` and `redacted_thinking` block from `response.content` (or `finalMessage()` when streaming), in order, one `ReasoningContent` each.
- **Send back:** map them before the turn's text and `tool_use` blocks.
- **Model mismatch:** blocks from another model are dropped.

Until PR 3 there is nothing to capture here, because thinking is off. The code ships now so that turning thinking on cannot produce the 400 that a missing thinking block causes.

**Context budget** (`token-estimator.ts`). Count a reasoning block by the length of its readable text. Encrypted `data` is counted by length as an upper bound.

**Archive** (`llm-call-archive.ts`).
- Before redaction, the prompt side replaces every `reasoning` block with `{ type: 'reasoning', provider, model, omitted: true }`. The readable text is already in the response row of the call that produced it.
- Encrypted data and signatures are never stored.
- `includeReasoning: false` covers the prompt side too.

**Tests.**
- The OpenRouter round trip, streamed and not: captured details come back unmodified on the next request.
- The Anthropic round trip keeps the order of `thinking` and `redacted_thinking`.
- Blocks are dropped on a model mismatch.
- `buildAssistantToolUseMessage` puts blocks first.
- The archive marker replaces each block.
- The token estimator counts reasoning blocks.

## PR 3 — the reasoning setting

**Types** (`src/agents/llm/sampling-options.ts`).

```ts
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max';
export interface ReasoningSetting { effort: ReasoningEffort }
```

- `parseReasoning(options)` returns `unset`, `set` or `invalid`.
- `resolveReasoning(options, logger)` warns on an invalid value and returns `undefined`.
- Both mirror the temperature helpers.
- `options.reasoning === undefined` counts as unset, so `{ reasoning: tierCfg.reasoning }` never warns.

**Registry** (`model-registry.ts`). `ModelMeta` gains an optional structured entry:

```ts
reasoning?: {
  /** How the provider expresses it. */
  control: 'openrouter-effort' | 'anthropic-adaptive' | 'anthropic-budget';
  /** Efforts a tier may set for this model. */
  efforts: ReasoningEffort[];
};
```

Initial entries:

| Model | Control | Efforts | Basis |
|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` | openrouter-effort | low, high, max | OpenRouter `supported_efforts`, probe 2026-10-08 |
| `google/gemini-3.1-flash-lite` | openrouter-effort | low, medium, high | OpenRouter `supported_efforts` |
| `claude-haiku-4-5` | anthropic-budget | low, medium, high, max | budget-only, no adaptive |
| `claude-sonnet-4-6`, `claude-opus-4-6` | anthropic-adaptive | low, medium, high, max | Anthropic effort docs |

Every other OpenRouter reasoning model in the registry gets an entry from its OpenRouter
metadata, or none. `openai/gpt-4o` gets none.

Its loose `capabilities: ['reasoning']` tag is wrong, and Haiku lacks the tag. Both are noted
here and left alone: `needs` is documentary only (#379), and the structured entry is what
the code reads.

**Config.**
- `TierConfig` gains `reasoning?: ReasoningSetting`. `schemas/default-config.schema.json` and the `config.ts` types follow.
- `config/default.yaml` sets nothing.
- `ModelRouter` validates each tier at construction. A tier's effort must appear in its model's `reasoning.efforts`, and `none` is rejected on a tier (ADR-048 §3).
- `ResolvedModel` carries the tier's `reasoning`.

**Runtime.**
- `AgentConfig` gains `reasoning?` and `fallbackReasoning?`, set at bootstrap from the primary and fallback tiers.
- `chatWithRetry` sends `options: { reasoning }` on agent turns, and the fallback call sends `fallbackReasoning`.
- The other call sites (judges, `infra-llm`, working-memory summarization, drift detector, scoring pass, voice) pass nothing. That is the current behavior.

**Provider mapping.**
- **OpenRouter:**
  - `reasoning: { effort }`, where `none` becomes `{ enabled: false }`.
  - Only sent when the model has a registry `reasoning` entry. A call site that sets it for a model without one gets a warning, and nothing is sent.
- **Anthropic, adaptive control:** `thinking: { type: 'adaptive' }` plus `output_config: { effort }`.
- **Anthropic, budget control:** `thinking: { type: 'enabled', budget_tokens }`.
  - `budget_tokens = clamp(round(max_tokens × ratio), 1024, max_tokens − 1)`, capped at 128,000. The ratios are low 0.2, medium 0.5, high 0.8 and max 0.95.
  - If `max_tokens` ≤ 1,024, thinking is omitted and a warning is logged.
- **Anthropic conflicts and defaults:**
  - A finite `temperature` together with thinking: temperature wins, thinking is omitted, and a warning is logged.
  - `none` means thinking is omitted, which is Anthropic's default.
- Check the SDK types for `adaptive` and `output_config` in the installed `@anthropic-ai/sdk`. Cast through a documented local type if they are missing.

**`llm.call`.** `reasoningEffort` records the effort actually sent, or `null` when it was omitted for any reason above.

**Suites.**
- `pnpm smoke` and `pnpm scenarios` take `--reasoning-effort <level>`.
- `routingFor` in `test-mode-stack.ts` already routes every tier to `--model`. It also sets each tier's `reasoning`, and validates the effort against the model like `ModelRouter` does.
- Each run header prints the effort, so saved results say which arm they were.

**Tests.**
- Parse and resolve helpers.
- `ModelRouter` rejects an effort a model does not list, and rejects `none`.
- Unset sends no `reasoning` and no `thinking` key, on both providers.
- The OpenRouter params shape.
- The Anthropic adaptive and budget shapes, including the budget clamp and the 1,024 floor.
- The temperature conflict.
- Fallback uses the fallback tier's setting.
- Voice and the judges send none.

## A/B protocol

Both A/Bs follow the trim plan's principle 6: every arm runs against `main` on the same day.
The model is production's standard-tier model, `deepseek/deepseek-v4.1-flash`.

**Setup.**
- Run on a throwaway database, as in the scenario recipe, never beside a live instance.
- Run smoke and scenarios side by side, smoke first, as the release behavior gate does.

**Endpoint.**
- Note which upstream endpoint served the calls, from PR 1's `upstreamProvider`.
- Arms are compared only within one endpoint. If the routing pin changes between arms, rerun the earlier arm.

**Recorded per arm.**
- Gate result, critical behaviors, and weighted score per scenario.
- Smoke cases, including `PASS*` and `KNOWN`.
- Reasoning tokens, latency p50/p90 and estimated cost per agent.

**Runs.** Two runs per arm. `main`'s two runs set the noise floor.

**PR 2 (pass-back).**
- Arms: `main` and the branch.
- **Ships if** both branch runs clear the gate, with no critical behavior below `main`'s worse run and weighted scores within `main`'s spread.
- **Also reported:** reasoning tokens on steps 2 and later. A drop is the expected effect, but it is not a gate.

**PR 4 (effort).**
- Arms: unset (`high`), `low` and `max`, all on `main` after PR 3. About $12 and 75 minutes in total.
- **`low` ships** under PR 2's rule. Its benefit is latency and cost.
- **`max` ships** only if it beats unset beyond `main`'s spread (for example, a `known_failure` flips to pass) and the latency per agent is acceptable to the principal.
- **Otherwise** the tier stays unset, and ADR-048's consequences record the result.
- A winning value ships as a curia-deploy change to `model_routing.tiers.standard.reasoning`.

**Fast tier.** This is optional and not part of #2044's acceptance. A fast-tier thinking A/B
would use the same harness with `--model claude-haiku-4-5`, but the suites mostly exercise
standard-tier agents.

## Out of scope

- **The judges' `temperature: 0` on Gemini 3.1 Flash-Lite**, against Google's guidance. It is recorded as a risk in ADR-048. No failures were seen in 14 days.
- **Anthropic's API reference** says models released after Opus 4.6 reject `temperature`. A call site that sets temperature (the judges) should not be pointed at such a model without checking.
- **A per-agent effort in agent YAML.** Rejected by ADR-048 unless PR 4 shows agents on one tier diverge.
