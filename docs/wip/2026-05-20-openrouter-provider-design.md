# OpenRouter Provider for Multi-Model Support

**Issue:** #379
**Date:** 2026-05-20
**Milestone:** v0.30 (cost optimization)

## Problem

Curia's `LLMProvider` abstraction has one implementation: `AnthropicProvider`. To
support cost savings and capability diversity, we need a second provider that
routes to non-Claude models. OpenRouter provides an OpenAI-compatible API that
gives access to 300+ models with a single API key.

## Design Principles

- Claude stays on the direct Anthropic SDK (prompt caching, cost, reliability)
- OpenRouter handles all non-Claude models
- The coordinator stays on `provider: anthropic`
- No changes to `AnthropicProvider` or the existing production Claude path
- Supported models are defined in code (model registry); tier-to-model mapping
  is defined in deployment config (YAML)

## Model Selection

Three models ship on day one, chosen for tool-calling reliability, cost, and
context window:

| Registry key | OpenRouter model ID | Provider | Context | Max output | Pricing (input/output per 1M) | Capabilities |
|---|---|---|---|---|---|---|
| `google/gemini-2.0-flash-001` | same | openrouter | 1,000,000 | 8,192 | $0.10 / $0.40 | vision, coding |
| `deepseek/deepseek-chat-v3-0324` | same | openrouter | 128,000 | 8,192 | $0.27 / $1.10 | coding |
| `openai/gpt-4o` | same | openrouter | 128,000 | 16,384 | $2.50 / $10.00 | vision, coding, reasoning |

**Registry key convention:** The registry key is the model ID that the
provider's API expects. For Anthropic this is `claude-sonnet-4-6`; for
OpenRouter it's `google/gemini-2.0-flash-001`. Different formats because
different APIs, but uniform meaning: "the string you send to the provider."

**Why these models:**
- **Gemini 2.0 Flash** — cheapest option with strong tool use, 1M context window.
  Suitable for simple routing, classification, low-stakes tasks.
- **DeepSeek V3** — best quality-per-dollar ratio. Competes with GPT-4o at
  ~1/10th the cost. Solid tool calling. Primary cost-optimization target.
- **GPT-4o** — most reliable non-Claude model for complex tool use. Chosen over
  reasoning models (o3, DeepSeek R1) because reasoning models have unreliable
  tool-calling behavior, and Curia agents are fundamentally tool-calling agents.

**Pricing note:** The rates above are approximate and should be verified against
OpenRouter's current pricing page at implementation time. The model registry
entries should reflect actual rates.

## Architecture

### OpenRouterProvider class

**File:** `src/agents/llm/openrouter.ts`

Implements the `LLMProvider` interface with the same contract as
`AnthropicProvider`.

**Constructor:** `new OpenRouterProvider(apiKey, logger, modelRegistry)`
- Same injection shape as `AnthropicProvider`
- Uses the `openai` npm package configured with `baseURL: 'https://openrouter.ai/api/v1'`

**`chat()` method flow:**

1. Extract system messages from the message array, concatenate with `\n\n`,
   pass as a single `role: 'system'` message (OpenAI format)
2. Map Curia's `ContentBlock[]` to OpenAI SDK shapes:
   - `TextContent` → `{ type: 'text', text }`
   - `ToolUseContent` → mapped to `tool_calls` on the assistant message
   - `ToolResultContent` → `{ role: 'tool', tool_call_id, content }`
   - `ImageContent` → `{ type: 'image_url', image_url: { url } }` (base64
     data URIs and URLs both supported)
3. Map Curia's `ToolDefinition[]` to OpenAI function-calling format
4. Call `openai.chat.completions.create()` with the resolved model string
5. Map response back to `LLMResponse`:
   - Text content → `{ type: 'text', content, usage, provenance }`
   - Tool calls → `{ type: 'tool_use', toolCalls, content?, usage, provenance }`
6. Build `LLMUsage`:
   - `prompt_tokens` → `inputTokens`
   - `completion_tokens` → `outputTokens`
   - `cacheCreationInputTokens: 0` (OpenRouter doesn't support Anthropic-style
     prompt caching)
   - `cacheReadInputTokens: 0`
7. Build `LLMCallProvenance`:
   - `requestedModel`: the model string passed to the provider
   - `actualModel`: `response.model` (OpenRouter may return a different string)
   - `providerRequestId`: `response.id`

**Error handling:** All exceptions caught and returned as
`{ type: 'error', error: classifyError(...) }`. Never throws. Same pattern as
`AnthropicProvider`.

**No streaming.** Matches current non-streaming architecture.

### Model registry entries

**File:** `src/agents/llm/model-registry.ts`

Three new `ModelMetadata` entries added with `provider: 'openrouter'`. Pricing
includes `cacheCreationRate: 0` and `cacheReadRate: 0` since OpenRouter doesn't
support prompt caching. All other fields follow the existing pattern.

### Wiring and startup

**File:** `src/index.ts`

- If `OPENROUTER_API_KEY` is present in env, instantiate `OpenRouterProvider`
  and add to `providerRegistry` under `'openrouter'`
- If absent, skip — no fatal error. The system only fails if an agent's
  resolved model references a provider that isn't registered. This matches
  the existing pattern for optional integrations (e.g., `OPENAI_API_KEY` for
  embeddings).

**File:** `src/startup/validator.ts`

No changes. Agent YAML validates `model.tier`, not `model.provider`. Provider
resolution happens at runtime through the existing registry chain, which already
validates that every registered model's provider has a `providerRegistry` entry.

**File:** `.env.example`

Add `OPENROUTER_API_KEY=sk-or-...` in the LLM Providers section.

### Token tracking

No changes needed. The existing `llm.call` event and `estimateCostUsd()`
function already consume `LLMUsage` and `LLMCallProvenance` generically. The
OpenRouter models' pricing entries in the model registry feed into cost
estimation automatically.

## Testing

**File:** `src/agents/llm/openrouter.test.ts`

Unit tests following `anthropic.test.ts` patterns:

- Mock the `openai` SDK at module level with `vi.mock()`, intercept
  `chat.completions.create()` calls
- Test cases:
  1. Text response — correct `LLMResponse` shape, content, usage, provenance
  2. Tool use response — tool calls mapped to Curia's `ToolCall` shape
  3. Mixed response (text + tool calls) — both content and toolCalls populated
  4. Error handling — exceptions caught and classified
  5. Usage mapping — `prompt_tokens`/`completion_tokens` to
     `inputTokens`/`outputTokens`, cache fields are `0`
  6. Provenance — `requestedModel` vs `actualModel`, `providerRequestId`
  7. System message handling — extracted and passed as `role: 'system'`
  8. Image content — mapped to OpenAI's `image_url` content part format

## Out of Scope

- Changes to `AnthropicProvider`
- Streaming support
- OpenRouter-specific features (fallback routing, model rankings)
- Agent YAML schema changes
- Default tier remapping — `default.yaml` ships unchanged (all tiers still
  point to Claude). Operators opt in by editing their tier config.

## Dependencies

- **npm:** `openai` package (OpenRouter's recommended SDK)
- **Sequencing:** After #326 (per-skill token tracking) so instrumentation
  covers both providers from day one
- **Informs:** #24 (context budgeting needs variable context window sizes)
