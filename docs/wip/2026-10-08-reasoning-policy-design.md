# Reasoning policy — design (#2044)

The decisions and the evidence for them are in [ADR-048](../adr/048-reasoning-policy.md).
This document covers how they are built, in what order, and how each change is A/B-tested.

**Updated 2026-10-20** for ADR-048's amendment: Haiku 5.5 became the fast tier (#2157), the
Anthropic budget control is dropped, unset means the provider default on every model (so
call sites state `none`), and Anthropic pass-back gains a prefix guard. Code
references were rechecked against `main` at `957838a8`.

**Scope.** #2044 delivers the ADR, the `llm.call` telemetry, reasoning pass-back, the
per-tier reasoning setting, and the effort A/B, in sequenced PRs. PR 0 (this design) lands
first; the implementation PRs start when they are scheduled.

## PR sequence

| PR | Delivers | A/B |
|---|---|---|
| 0 | ADR-048, this design, and the trim plan's temperature note (#2079, merged) | none (docs only) |
| 0b | ADR-048's 2026-10-20 amendment and this update | none (docs only) |
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
  - Anthropic: `usage.output_tokens_details.thinking_tokens`, typed in `@anthropic-ai/sdk` 0.133 (`OutputTokensDetails`, nullable). It reads 0 while thinking is off.
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
  /**
   * Anthropic only: hash of the request this block answered (system, tools and every
   * message), as the provider sent it. Set only for models whose thinking is bound to
   * the prefix. See the prefix guard below.
   */
  prefixHash?: string;
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
- **Prefix guard** (ADR-048 §1, amended). The registry gains `thinkingBoundToPrefix: true`, set on `claude-haiku-5-5`.
  - **Capture:** for a flagged model, every captured block gets `prefixHash`, the SHA-256 of the mapped `system`, `tools` and `messages` the request sent.
  - **Send:** for a flagged model, walk the assistant turns that carry Anthropic blocks in order. For the turn at index `i`, hash the mapped `system`, `tools` and `messages[0..i)` of the request being built. At the first turn whose hash differs from its block's `prefixHash` (or has none), drop that turn's blocks and every later turn's blocks.
  - **Log:** one `info` line per request that drops blocks, with the model, the number dropped and `reason: 'prefix_changed'`.
  - **Today's triggers:** `refreshBullpenContext` replacing the Bullpen system message, and tool discovery adding tools. Both change the prefix, so the turns after them lose the earlier reasoning.
  - **Not flagged:** the 4.6 models do not run the check, so their blocks always go back.

Until PR 3 there is nothing to capture here, because thinking is off. The code ships now so that turning thinking on cannot produce the 400 that a missing or stale thinking block causes.

**Context budget** (`token-estimator.ts`). Count a reasoning block by the length of its readable text. Encrypted `data` is counted by length as an upper bound.

**Archive** (`llm-call-archive.ts`).
- Before redaction, the prompt side replaces every `reasoning` block with `{ type: 'reasoning', provider, model, omitted: true }`. The readable text is already in the response row of the call that produced it.
- Encrypted data and signatures are never stored.
- `includeReasoning: false` covers the prompt side too.

**Tests.**
- The OpenRouter round trip, streamed and not: captured details come back unmodified on the next request.
- The Anthropic round trip keeps the order of `thinking` and `redacted_thinking`.
- The prefix guard: an unchanged prefix sends every block; a changed system message or tool list drops the block at the change and all later ones; an unflagged model is not checked.
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
  control: 'openrouter-effort' | 'anthropic-adaptive';
  /** Efforts a tier may set for this model. */
  efforts: ReasoningEffort[];
};
```

Initial entries:

| Model | Control | Efforts | Basis |
|---|---|---|---|
| `deepseek/deepseek-v4.1-flash` | openrouter-effort | low, high, max | OpenRouter `supported_efforts`, probe 2026-10-08 |
| `google/gemini-3.1-flash-lite` | openrouter-effort | low, medium, high | OpenRouter `supported_efforts` |
| `claude-haiku-5-5` | anthropic-adaptive | none, low, medium, high, max | Anthropic effort docs, 2026-10-20 (`xhigh` left out, ADR-048) |
| `claude-sonnet-4-6`, `claude-opus-4-6` | anthropic-adaptive | none, low, medium, high, max | Anthropic effort docs |
| `claude-haiku-4-5` | none | — | budget-only; the budget control was dropped (ADR-048 §2, amended) |

`none` is listed only where it turns reasoning off cleanly (ADR-048 §2, amended). Every other
OpenRouter reasoning model in the registry gets an entry from its OpenRouter metadata, without
`none`, or no entry. `openai/gpt-4o` gets none.

`thinksByDefault` stays on `claude-haiku-5-5` as a fact about the model. The provider no longer
turns it into `thinking: disabled`; it only decides the `max_tokens` cap below.

Its loose `capabilities: ['reasoning']` tag is wrong, and Haiku lacks the tag. Both are noted
here and left alone: `needs` is documentary only (#379), and the structured entry is what
the code reads.

**Config.**
- `TierConfig` gains `reasoning?: ReasoningSetting`. `schemas/default-config.schema.json` and the `config.ts` types follow.
- `config/default.yaml` sets nothing.
- `ModelRouter` validates each tier at construction. A tier's effort, `none` included, must appear in its model's `reasoning.efforts` (ADR-048 §3, amended).
- `ResolvedModel` carries the tier's `reasoning`.

**Runtime.**
- `AgentConfig` gains `reasoning?` and `fallbackReasoning?`, set at bootstrap from the primary and fallback tiers.
- `chatWithRetry` sends `options: { reasoning }` on agent turns, and the fallback call sends `fallbackReasoning`.
- The other call sites (both judges, `infra-llm`'s classify and extract, working-memory summarization, the drift detector, the scoring pass, voice) send `options: { reasoning: { effort: 'none' } }`. One shared constant, `NO_REASONING`, so a test can find every site.
  - On Haiku 5.5 that sends the `thinking: disabled` #2077 sends today.
  - On models that do not list `none` (production's Gemini judges, DeepSeek) nothing is sent.
  - Either way the request matches `main`'s; a call-site test asserts it for each site on Haiku 5.5 and on Gemini.

**Provider mapping.**
- **Both providers:** an effort the model's registry entry does not list is not sent. `none` gets a debug log (it is the expected case for the judges on Gemini); any other effort gets a warning. A model with no registry `reasoning` entry gets the same treatment.
- **OpenRouter:** `reasoning: { effort }`, where `none` becomes `{ enabled: false }`.
- **Anthropic** (the only control is adaptive):
  - An effort sends `thinking: { type: 'adaptive', display: 'summarized' }` and `output_config: { effort }`.
  - `none` sends `thinking: { type: 'disabled' }` and no effort.
  - Unset sends neither key. #2157's `thinksByDefault → disabled` rule is removed, so Haiku 5.5 thinks adaptively at `medium`.
  - **`max_tokens`:** a request will think when it sends an effort, or when it is unset on a model flagged `thinksByDefault`. If it will think and the caller set no `max_tokens`, the cap is 32,768 instead of the registry's (or the 4,096 fallback).
  - A caller that sends an effort with `max_tokens` below 1,024 keeps thinking off, with a warning. An unset request with `max_tokens` below 1,024 on a `thinksByDefault` model is sent as-is with a warning: the call site should send `none`, and the call-site test catches the ones in `src/`.
  - **Temperature:** a finite `temperature` that would actually be sent (the model does not reject sampling parameters) wins over thinking. Thinking is omitted and a warning is logged. On Haiku 5.5 no temperature is sent, so thinking goes on.
  - **A model without a registry `reasoning` entry** gets a warning and nothing is sent, as on OpenRouter.
- The SDK types (`ThinkingConfigAdaptive`, `OutputConfig.effort`) exist in `@anthropic-ai/sdk` 0.133, so no local cast is needed.

**`llm.call`.** `reasoningEffort` records the effort actually sent, or `null` when it was omitted for any reason above.

**Suites.**
- `pnpm smoke` and `pnpm scenarios` take `--reasoning-effort <level>`.
- `routingFor` in `test-mode-stack.ts` already routes every tier to `--model`. It also sets each tier's `reasoning`, and validates the effort against the model like `ModelRouter` does.
- Each run header prints the effort, so saved results say which arm they were.

**Tests.**
- Parse and resolve helpers.
- `ModelRouter` rejects an effort a model does not list, including `none` on DeepSeek, and accepts `none` on Haiku 5.5.
- Unset sends no `reasoning` and no `thinking` key, on both providers, Haiku 5.5 included.
- The OpenRouter params shape.
- The Anthropic adaptive shape, `display: 'summarized'`, the 32,768 cap and the 1,024 floor.
- Haiku 5.5: unset sends no `thinking` key and gets the 32,768 cap; an effort sends adaptive; `none` sends disabled with the registry cap.
- The temperature conflict.
- Fallback uses the fallback tier's setting.
- Every non-agent call site sends `NO_REASONING`, and its request on Haiku 5.5 and on Gemini equals `main`'s.

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

**Runs.** Two runs per arm. `main`'s two runs set the noise floor. PR 2's A/B is four runs, about $16 and two and a half hours.

**Who runs them.** The maintainer, locally: the suites need provider keys and a populated dev
database. Each PR lists the exact commands for its arms and a results table to fill in.

**PR 3 (fast tier, before release).** Removing #2077's rule changes production's fast-tier
agent turns, so PR 3 does not ship in a release until this passes.
- Arms: `tiers.fast.reasoning.effort: none` (today's requests) and unset (Haiku 5.5 adaptive at
  `medium`), both on the PR 3 branch. Only `tiers.fast` differs; no `--model`, which would set
  every tier.
- Command: `pnpm scenarios --tags specialist-contacts --runs 3` per arm, as #2077 describes.
- **Unset ships if** every run clears the gate within `none`'s spread and contacts' latency
  p50/p90 is acceptable to the principal. Otherwise curia-deploy sets
  `tiers.fast.reasoning.effort: none` in the same deploy.
- **Also reported:** the prefix guard's drop count per run, and reasoning tokens per call.

**PR 2 (pass-back).**
- Arms: `main` and the branch.
- **Ships if** both branch runs clear the gate, with no critical behavior below `main`'s worse run and weighted scores within `main`'s spread.
- **Also reported:** reasoning tokens on steps 2 and later. A drop is the expected effect, but it is not a gate.

**PR 4 (effort).**
- Arms: unset (`high`), `low` and `max`, all on `main` after PR 3. Six runs. At the 2026-10-14 scenario cost (77 cases, about 38 minutes and $2.87 estimated per run) plus smoke, budget about $25 and four hours.
- **`low` ships** under PR 2's rule. Its benefit is latency and cost.
- **`max` ships** only if it beats unset beyond `main`'s spread (for example, a `known_failure` flips to pass) and the latency per agent is acceptable to the principal.
- **Otherwise** the tier stays unset, and ADR-048's consequences record the result.
- A winning value ships as a curia-deploy change to `model_routing.tiers.standard.reasoning`.

**Fast tier efforts beyond the default.** Optional, and not part of #2044's acceptance: the PR 3
check above compares only unset and `none`. Other efforts on Haiku 5.5 use the same command.

## Out of scope

- **The judges' `temperature: 0` on Gemini 3.1 Flash-Lite**, against Google's guidance. It is recorded as a risk in ADR-048. No failures were seen in 14 days.
- **Anthropic's API reference** says models released after Opus 4.6 reject `temperature`. A call site that sets temperature (the judges) should not be pointed at such a model without checking.
- **A per-agent effort in agent YAML.** Rejected by ADR-048 unless PR 4 shows agents on one tier diverge.
- **An append-only tool loop** (Bullpen updates as appended messages, discovered tools as inline additions), which would keep Anthropic reasoning after a change. A follow-up issue.
- **Reasoning on the Bedrock provider** (#2148). Its registry entries carry no `reasoning` entry, so a tier effort on them fails at boot.
