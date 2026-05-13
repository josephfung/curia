# Design: Context Budget Layer (Issue #24)

**Branch:** `feat/context-budget`
**Date:** 2026-05-12
**Issue:** josephfung/curia#24
**Milestone:** v0.28

---

## Problem

The agent runtime assembles context in priority order (spec 01, lines 137–158) but has no token awareness. It loads system prompt, sender context, bullpen, and conversation history without measuring their size against the model's context window. If the total exceeds the window, the API call fails or gets truncated silently. There's also no visibility into how close we are to the limit on a typical call, making it impossible to evaluate performance or know when tuning is needed.

## Goal

Add a token-aware budgeting layer that wraps the existing context assembly. It measures each tier's token cost, enforces inclusion/exclusion based on available budget, and emits observability events so we can monitor utilization over time.

**Non-goals:**
- Changing the existing assembly order or tier construction logic
- Building dashboards (the events enable them; building them is separate)
- Multi-provider context window handling (designed for, but #379 is not yet implemented)
- Replacing the existing turn-based summarization (it stays as-is; the budget is a separate layer)

---

## Approach

**Budget wrapper around existing assembly (Approach A).** The existing assembly code in `runtime.ts` is already well-structured and priority-ordered. The budget is a measurement and enforcement concern layered on top — not a rewrite of assembly logic.

---

## Design

### 1. Token Estimator

**Module:** `src/agents/llm/token-estimator.ts`

A local function that estimates token count for a string without an API call.

```typescript
export function estimateTokens(text: string): number;
```

Uses a character-ratio heuristic (~3.5 characters per token for Claude's BPE tokenizer). This is adequate for budgeting decisions where the safety margin absorbs estimation error. Exact token counts come back in the API response and land in `llm.call` events, so estimates can be validated against actuals over time.

Handles both plain strings and `ContentBlock[]` arrays (serializes structured content before measuring).

**Safety margin:** A system-wide constant (default: 5%) applied at the budget level. This compensates for estimator inaccuracy and is a property of the estimator, not individual agents.

**Model-to-context-window map:** A lookup from model ID to context window size, similar to the existing pricing map in `pricing.ts`. Initial values:

| Model | Context Window |
|-------|---------------|
| `claude-opus-4-6` | 200,000 |
| `claude-sonnet-4-6` | 200,000 |
| `claude-haiku-4-5` | 200,000 |

When multi-provider support (#379) lands, this map extends to cover models with different windows (e.g., `gpt-4o: 128,000`).

### 2. Context Budget Module

**Module:** `src/agents/llm/context-budget.ts`

**Class:** `ContextBudget`

Manages the token accounting for a single context assembly.

**Construction:**

```typescript
const budget = new ContextBudget({
  contextWindow: 200_000,    // from model lookup
  responseReserve: 8_192,    // from agent YAML config
  safetyMargin: 0.05,        // system-wide constant
});
// availableBudget = contextWindow - responseReserve - (contextWindow * safetyMargin)
```

**Tier registration API:**

- `allocate(tierName: string, messages: Message[]): boolean` — estimates tokens for the messages. If they fit in the remaining budget, marks the tier as included and deducts from remaining. If not, marks as dropped and returns false. System prompt tier is always included.
- `allocateHistory(turns: Message[], minKeep?: number): Message[]` — special handling for conversation history. If full history doesn't fit, truncates oldest turns until it fits, keeping at least `minKeep` most recent turns (default: 2). Returns the included subset.
- `getReport(): ContextBudgetReport` — returns the full budget breakdown for event emission.

**System prompt overflow:** If the system prompt alone exceeds the available budget, logs an error but proceeds. The LLM API will reject the call, which is the correct failure mode for a misconfigured system prompt — the budget layer shouldn't mask it.

**Tier drop policy:** Hard drop, bottom-up. When a tier doesn't fit, it's excluded entirely and all lower-priority tiers are also skipped. The exception is conversation history, which supports partial inclusion via oldest-turn truncation.

### 3. Agent YAML Configuration

Budget settings in the agent YAML config under `context_budget`:

```yaml
# agents/coordinator.yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6

context_budget:
  response_reserve: 8192    # tokens reserved for model response
```

**Per-agent:** `response_reserve` — how many tokens to hold back for the response. Default: 8192. The coordinator may want more (longer responses with tool calls); a specialist may need less.

**System-wide (not per-agent):** Safety margin (5%) — lives with the token estimator as it compensates for estimator inaccuracy, not agent-specific behavior.

**Derived (not configurable):** Context window size — looked up from the model-to-context-window map.

If an agent YAML omits `context_budget`, it gets `{ response_reserve: 8192 }`. Budgeting applies to all agents automatically.

### 4. Observability

**Event:** `context.budget` on the bus, emitted after each context assembly.

**Payload:**

```typescript
interface ContextBudgetPayload {
  agentId: string;
  conversationId: string;
  model: string;
  contextWindow: number;         // model's total context window
  responseReserve: number;       // tokens reserved for response
  availableBudget: number;       // after reserve + safety margin deducted
  totalUsed: number;             // sum of all included tiers
  utilizationPct: number;        // totalUsed / availableBudget (0.0–1.0)
  tiers: Array<{
    name: string;                // 'system_prompt', 'sender_context', etc.
    estimatedTokens: number;     // local estimate
    included: boolean;
    droppedReason?: string;      // 'budget_exceeded' | 'empty'
  }>;
  historyTurnsTotal: number;     // total turns available
  historyTurnsIncluded: number;  // turns included after truncation
}
```

Lands in `audit_log` via existing audit infrastructure, co-located with `llm.call` events from #326.

**Key questions this data answers:**
- How often are we dropping tiers? → filter where `tiers[].included === false`
- Average budget utilization by agent? → aggregate `utilizationPct` by `agentId`
- Is history getting truncated? → compare `historyTurnsTotal` vs `historyTurnsIncluded`
- How accurate is the estimator? → compare `totalUsed` against `inputTokens` from the subsequent `llm.call` event

**Emission timing:** After assembly, before the LLM call. Budget data is captured even if the LLM call subsequently fails.

### 5. Integration with runtime.ts

The budget wraps the existing assembly flow in `runtime.ts`. No changes to tier construction logic, message formatting, sanitization, prompt caching breakpoints, the tool-use loop, or error handling.

**Modified flow:**

1. **Before assembly:** Create a `ContextBudget` instance using the model's context window (from map lookup) and `response_reserve` (from agent YAML, defaulting to 8192).

2. **System prompt:** Assemble as today (office identity, executive voice, autonomy, time context, contact details, intent anchor). Register with budget via `allocate('system_prompt', ...)`. Always included. If it exceeds available budget, log error and proceed without enforcement.

3. **Sender context:** Assemble as today. Call `budget.allocate('sender_context', ...)`. Include if true, skip if false.

4. **Conversation history:** Load from working memory as today. Pass through `budget.allocateHistory(turns)`. Use the returned (possibly truncated) subset.

5. **Bullpen:** Refresh and format as today. Call `budget.allocate('bullpen', ...)`. Include if true, skip if false.

6. **KG context (future):** Same pattern when implemented.

7. **After assembly:** Publish `context.budget` event with `budget.getReport()`.

8. **LLM call:** Pass assembled messages as today — unchanged.

### 6. Tier Priority Order

Fixed in code, matching spec 01:

| Priority | Tier | Drop Policy |
|----------|------|-------------|
| 1 (highest) | System prompt + intent anchor | Never dropped |
| 2 | Sender context | Hard drop |
| 3 | Conversation history | Partial (truncate oldest) |
| 4 | Bullpen threads | Hard drop |
| 5 (lowest) | Knowledge graph context | Hard drop (future) |

When budget is tight, tiers are dropped bottom-up: KG first, then bullpen, then history truncation, then sender context. In practice, system prompt + sender context + reasonable history should fit comfortably in 200k tokens — tier dropping is a safety net, not the normal path.

---

## Testing Strategy

**Unit tests — token estimator:**
- Accuracy within 10% of actual Anthropic token counts (reference pairs captured from `llm.call` events as fixtures)
- Edge cases: empty string, very long strings, non-ASCII text, `ContentBlock[]` arrays

**Unit tests — ContextBudget:**
- Budget arithmetic: context window − reserve − safety margin = correct available budget
- Tier inclusion: tiers that fit are included, tiers that don't are dropped
- Priority enforcement: lower-priority tiers dropped before higher when budget is tight
- History truncation: oldest turns removed first, at least `minKeep` recent turns preserved
- System prompt overflow: logs error, doesn't throw
- Report generation: correct per-tier stats, utilization percentage, included/dropped flags

**Integration tests:**
- Wire up budget in a test harness with realistic tier sizes (actual system prompt templates, sample sender context, sample bullpen threads). Verify correct assembly at various budget sizes.
- Verify `context.budget` event is emitted with expected payload shape and values

**Estimator calibration (ongoing, post-deploy):**
- Compare `estimatedTokens` from budget events against `inputTokens` from `llm.call` events for the same calls. If drift exceeds 10%, adjust the character ratio.

---

## Dependencies

- **#326 (per-skill token tracking)** ✅ — provides real usage data and the `llm.call` event infrastructure this builds on
- **#379 (multi-provider)** — not blocking; design accommodates variable context windows via the model map, but only Anthropic models are populated initially

## Files Changed

| File | Change |
|------|--------|
| `src/agents/llm/token-estimator.ts` | New — token estimation function + model context window map |
| `src/agents/llm/context-budget.ts` | New — `ContextBudget` class |
| `src/agents/runtime.ts` | Modified — wrap assembly with budget, emit event |
| `src/agents/loader.ts` | Modified — validate `context_budget` in agent YAML |
| `src/bus/events.ts` | Modified — add `ContextBudgetPayload` to event union |
| `agents/coordinator.yaml` | Modified — add `context_budget` config |
| `tests/unit/agents/llm/token-estimator.test.ts` | New |
| `tests/unit/agents/llm/context-budget.test.ts` | New |
| `tests/unit/agents/runtime.test.ts` | Modified — budget integration tests |
