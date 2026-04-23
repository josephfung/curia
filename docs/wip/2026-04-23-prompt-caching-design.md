# Prompt Caching Design

**Issue:** josephfung/curia#320
**Status:** Approved, pending implementation

## Problem

`AnthropicProvider.chat()` passes the system prompt as a plain string and maps tool definitions with no cache markers. Every API call pays full input token cost for the system prompt (~5K tokens) and tool definitions (~10K tokens), even when both are identical across calls. Cache reads cost 90% less than regular input tokens.

## Approach

Two cache breakpoints in `src/agents/llm/anthropic.ts` (option B from design discussion):

1. **System breakpoint** — wrap the concatenated system string in a single `TextBlockParam` with `cache_control: { type: 'ephemeral' }`. The Anthropic API accepts `system` as either a string or a `TextBlockParam[]`; we switch to the array form.
2. **Last-tool breakpoint** — after mapping tools to SDK shape, add `cache_control: { type: 'ephemeral' }` to the last element. This marks the full stable tool list as cacheable.

When there is no system content, omit the `system` key (same as today). When there are no tools, nothing changes.

## Scope

- **File modified:** `src/agents/llm/anthropic.ts` only
- **No interface changes:** `LLMProvider`, `LLMUsage`, `chat()` signature all unchanged
- **No logging changes:** cache token counts (`cache_creation_input_tokens`, `cache_read_input_tokens`) are not captured — logging stays as-is

## Cache Invalidation Behaviour

The cached region includes everything up to and including the breakpoint. For the system block, the cache entry is invalidated any time the concatenated system string changes — which happens per-call for the coordinator (due to autonomy block, time context, sender context). This means the system cache hit rate may be lower than expected in practice.

For the tool block, the tool list is stable (48 pinned skills from coordinator.yaml), so cache hits should be near-100% within the 5-minute TTL.

> **Follow-up (P0+):** If cache hit rate data from the Anthropic console shows frequent system-block misses, split system content into a stable block (base prompt + identity) and a dynamic block (per-task injections). This requires a new API surface on `LLMProvider` and is deferred until we have data.

## Expected Impact

60-80% reduction in effective input token cost for the coordinator, driven primarily by caching the tool definitions on every call within the TTL window.

## Verification

1. Check Anthropic console for `cache_creation_input_tokens` and `cache_read_input_tokens` in usage breakdown — cache reads should appear within minutes of deployment
2. Compare daily token spend before/after
3. Run `npm test` — no regressions expected since the API contract for `system` as `TextBlockParam[]` is equivalent to the string form
