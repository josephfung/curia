# Adding an LLM Provider

A **provider** is the adapter between Curia's agent layer and one LLM backend. Agents talk only to the `LLMProvider` interface in `src/agents/llm/provider.ts`. Everything specific to a backend (request shape, auth, error mapping, reasoning controls) lives inside the provider. Curia has three chat providers today: `AnthropicProvider` (`anthropic.ts`), `OpenRouterProvider` (`openrouter.ts`, which is also how Curia reaches OpenAI and Google models) and `BedrockProvider` (`bedrock.ts`).

See [Adding a Channel](adding-a-channel.md), [Adding a Tool](adding-a-tool.md) and [Adding an Agent](adding-an-agent.md) for the sibling guides. The policy behind the reasoning rules below is [ADR-048](../adr/048-reasoning-policy.md).

---

## Quick Start

1. **Registry entries** — add each model to `src/agents/llm/model-registry.ts`.
2. **`chat()`** — implement it in `src/agents/llm/<name>.ts`. This is the core of the contract.
3. **`stream()`** — optional, but voice and the reasoning watchdog need it.
4. **Reasoning pass-back** — carry reasoning through tool loops.
5. **Registration** — construct the provider in `src/index.ts` and wrap it in `ReasoningWatchdogProvider`.
6. **Tests** — copy the shape of `openrouter.test.ts` and `anthropic.test.ts`.

> **A provider without `stream()` works.** It serves agent turns through `chat()`. It is not watched for runaway reasoning, and it cannot serve voice, which refuses to start without `stream()`. Bedrock is in this position today.

---

## 1. Registry entries

Every model a tier can name must have an entry in `model-registry.ts` (`ModelMetadata`). The router rejects an unknown model at boot. The fields a new provider cares about:

- `provider` — the id the router uses to pick your provider. It must equal the key you register in `src/index.ts` (step 5).
- `maxOutputTokens` — the model's output cap. Default 4,096 when unset. Your `chat()` must never send more (step 2).
- `reasoning` — how the model takes a reasoning effort: `{ control, efforts }`. `control` is a `ReasoningControl` (`'openrouter-effort'` or `'anthropic-adaptive'`); a new backend with its own mapping adds a value. Leave `reasoning` off if Curia should send the model no reasoning setting. A tier effort on such a model fails at boot, and a call site's effort is not sent. List `none` in `efforts` only if it turns reasoning off cleanly.
- `thinksByDefault` — set when the model reasons if the request leaves reasoning unset. It is a fact about the model, not a request rule. It decides whether a small-cap call site can use the model (`small-cap-models.ts`) and sizes `max_tokens` on providers that need room for thinking.
- Pricing, `contextWindow` and `capabilities` (`streaming`, `tools`, `vision`). Voice preflights on `streaming` and `tools`.

Register dated snapshots in their own right. Lookup is exact-first, then longest prefix, and a prefix hit prices and sizes the model as a different one.

---

## 2. `chat()`

`chat(params)` takes `messages`, optional `tools`, `toolResults`, `model` and an `options` bag, and returns an `LLMResponse`: `text`, `tool_use` or `error`. The rules:

- **Never throw for an API error.** Return `{ type: 'error', error }` with an `AgentError` from `classifyError` (`src/errors/classify.js`). Throw only for programmer errors, such as a missing model.
- **`max_tokens`.** Use the caller's `options.max_tokens`, otherwise a default, and cap it at the registry's `maxOutputTokens`. If the model reasons and the cap is too small to leave room for an answer, raise it the way `AnthropicProvider` does (ADR-048 §2).
- **`signal`.** Pass `options.signal` (an `AbortSignal`) to the SDK call. Barge-in and the watchdog both cancel through it. An aborted call returns an `error` response; it does not retry.
- **`temperature`.** Read it with `resolveTemperature(options, logger)` from `sampling-options.ts`. Send nothing when it is unset. Omit it for a model with `rejectsSamplingParams`. Record what you sent with `sentTemperature()` semantics, so the `llm.call` audit row matches the request.
- **`reasoning`.** Read it with `resolveReasoning(options, logger)`, then check it against the model's registry `reasoning.efforts`. If the model does not list the effort, send nothing and log with `logUnsentReasoningEffort`. Never send both an effort and a token budget. Curia sends no reasoning budget to any provider (ADR-048 amendment, 2026-10-29).
- **Provenance.** Every successful response carries `LLMCallProvenance`: `requestedModel`, `actualModel`, `providerRequestId`, and where they apply `upstreamProvider`, `reasoningEffort` (what the request actually carried), `reasoningBlocksDropped`, and `attempts` / `failedAttemptsMs` if your `chat()` retries. Leave a field unset rather than inventing a value. `reasoningWatchdog` is set by the wrapper, never by a provider.
- **Usage.** Fill `LLMUsage`, including `reasoningTokens` when the backend reports them. They are already inside `outputTokens`.
- **Retries.** Retry transient failures inside `chat()` (resets, 429, 5xx, idle timeouts) with backoff, as `OpenRouterProvider` does. The watchdog's forced attempt goes through `chat()` and relies on these retries.

---

## 3. `stream()` (optional)

`stream(params)` returns an `AsyncIterable<LLMStreamEvent>` for the same parameters as `chat()`. Implement it when the backend can truly stream. Never buffer the full reply and yield it at the end. The event order:

1. `request_started { maxTokens }` — exactly once, first, before any other event. `maxTokens` is the value the request actually sent, after the model cap and any thinking floor. The watchdog arms its thresholds from it.
2. `reasoning_delta { text }` — one per reasoning delta that carries non-empty readable text. Never emit one for encrypted or omitted thinking. The watchdog counts one token per event.
3. `output_started` — at most once, on the first chunk of a tool call (OpenRouter's first `delta.tool_calls` entry, Anthropic's `content_block_start` of type `tool_use`). Tool-call argument chunks produce no other event, so without it the watchdog cannot tell a model writing a long tool call from one still thinking, and the time trigger would cut the call. Text needs no `output_started`: `text_delta` signals it.
4. `text_delta { text }` — one per piece of the reply.
5. A terminal event: `tool_use` (with `toolCalls`, `usage`, `provenance`, and `reasoningBlocks` if any), or `message_end` (with `content`, `usage`, `provenance`), or `error`.

Four more rules:

- **Yield `error` events** for API failures, as `chat()` returns them. Do not throw mid-stream.
- **No SDK retries.** Send the stream request with the SDK's retries off (`maxRetries: 0`). A failed watched stream falls back to `chat()`, which retries and counts each attempt; SDK retries underneath would be hidden and multiply the requests.
- **Honor `options.signal`.** A cancelled stream ends promptly, with an `error` event or by throwing the SDK's abort error.
- **Release the SDK stream on every exit.** Close it in a `finally`, so a consumer that stops early (the watchdog does, and so does barge-in) frees the response buffers. A consumer calling `return()` on your iterator must reach that `finally`.

Voice and the watchdog both skip a provider whose `stream` property is absent. Do not define `stream` as an empty stub; omit it.

Set `readonly acceptsReasoningInForcedAttempt = false` if your models refuse having their own reasoning quoted back. The watchdog's forced attempt then omits the `<previous_reasoning>` block. Anthropic does: Sonnet 5.5 returns a `reasoning_extraction` refusal. Leave it unset otherwise.

---

## 4. Reasoning pass-back

If the backend returns reasoning beside tool calls, it must go back verbatim on the next request of the same tool loop (ADR-048 §1). Return it on the `tool_use` response as `reasoningBlocks: ReasoningContent[]`, with your provider id in `provider`, the requested model in `model`, and the backend's native payload, untouched, in `data`. `ReasoningContent.provider` is currently `'openrouter' | 'anthropic'`; widen it for a new backend.

On the next request, filter the history with `sendableReasoningBlocks` from `src/agents/llm/reasoning-blocks.ts`, which drops blocks that came from another provider or model. Then serialize the remainder in the backend's native shape. If the backend binds reasoning to the request prefix (Anthropic does, flagged `thinkingBoundToPrefix`), record a `prefixHash` on each block and drop stale ones before sending, as `AnthropicProvider` does.

Never rebuild reasoning from the archive. The prompt archive replaces each block with a marker (`markReasoningBlocksForArchive`), so encrypted reasoning and signatures never reach `llm_call_archive`.

---

## 5. Registration

Construct the provider in `src/index.ts` next to the others, add it to `providerRegistry` under the registry's `provider` id, and **wrap it with `watchProvider`**, which returns a `ReasoningWatchdogProvider` (`reasoning-watchdog-provider.ts`):

```typescript
providerRegistry.set('my-provider', watchProvider(new MyProvider(config.myKey, logger, modelRegistry), logger));
```

The wrapper does nothing for a provider that has no `stream()`: it passes `chat()` straight through. For one that does, it runs each `chat()` through `inner.stream()` and:

- counts reasoning tokens (one per `reasoning_delta`) and watches the clock;
- stops the stream when reasoning reaches half of the request's `maxTokens`, or half of the usable time window passes, before any output starts (`text_delta`, `output_started` or a terminal event), or when the reply ends empty after reasoning;
- makes one forced attempt through `inner.chat()` with the tail of the reasoning appended as a runtime note;
- falls back to a plain `inner.chat()` once if the stream fails with a retryable error, or ends empty with no readable reasoning (so `chat()`'s own empty-reply retry runs); a non-retryable error event is returned as is;
- passes a caller's abort straight through, and never cuts a reply once output has started.

The thresholds are in `reasoning-watchdog.ts`. The stopped call is recorded on `llm.call` as `reasoningWatchdog` (`null` when it did not fire). The test-mode stack, `src/startup/test-mode-stack.ts`, wraps each provider the same way, so wrap yours there too if the behavior suites should be able to run on it.

Do not import the wrapper from your provider, or your provider from the wrapper. The wrapper imports no concrete provider class.

---

## 6. Tests

Copy the shape of `tests/unit/agents/llm/openrouter.test.ts` (HTTP-style backend, retries, `upstreamProvider`) and `tests/unit/agents/llm/anthropic.test.ts` (SDK backend, thinking blocks, prefix guard). Cover at least:

- a text response and a tool-use response, with usage and provenance filled;
- an API error returned as an `error` response, not thrown;
- `max_tokens` capped at the registry value;
- `signal` abort: the call stops and returns an `error`;
- `temperature` and `reasoning` mapping, including a model that does not list the effort;
- reasoning blocks returned, passed back, and dropped for a different model;
- for `stream()`: `request_started` first and once, `reasoning_delta` per readable delta (none for encrypted thinking), `output_started` once on the first tool-call chunk, the terminal event, and the SDK stream released when the consumer stops early.

Also add the models to the checks in `model-registry.test.ts` and `provider-router.test.ts` if they cover the new `provider` id.

---

## Checklist Before Opening a PR

- [ ] Each model has a registry entry with `provider`, `maxOutputTokens`, `reasoning` (or none, deliberately) and `thinksByDefault` where known
- [ ] `chat()` never throws for API errors; it returns `{ type: 'error' }`
- [ ] `max_tokens` is capped at the registry value; `signal`, `temperature` and `reasoning` go through `sampling-options.ts`
- [ ] No reasoning budget is sent, and never an effort together with a budget
- [ ] `LLMCallProvenance` and `LLMUsage` are filled, including `reasoningTokens` where reported
- [ ] If `stream()` exists: `request_started` first and once, `reasoning_delta` per readable delta, `output_started` on the first tool-call chunk, then `tool_use` or `message_end`; SDK retries off; it honors `options.signal` and releases the SDK stream on every exit
- [ ] If `stream()` is omitted, it is omitted entirely (no stub), and the docs note that the provider is unwatched and cannot serve voice
- [ ] Reasoning blocks are returned and passed back verbatim, filtered with `sendableReasoningBlocks`
- [ ] Registered in `src/index.ts` (and the test-mode stack) wrapped with `watchProvider`
- [ ] Tests follow `openrouter.test.ts` and `anthropic.test.ts`
- [ ] Spec 02's provider list and `CHANGELOG.md` are updated

---

## Related Docs

- [ADR-048](../adr/048-reasoning-policy.md) — reasoning policy: pass-back, one effort per tier, and the watchdog amendment
- [Spec 02 — Agent System](../specs/02-agent-system.md#llm-provider-abstraction) — the provider abstraction in context
- [ADR-041](../adr/041-aws-bedrock-llm-provider.md) — the Bedrock provider decision
- [ADR-037](../adr/037-voice-channel-livekit-duplex.md) — why voice needs `stream()`
