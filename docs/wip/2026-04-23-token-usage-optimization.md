# Token Usage Analysis & Optimization Plan

## Context

Curia's Anthropic API usage shows a 138:1 input-to-output token ratio (38.3M in vs 276K out), and prompt caching is completely unused. This analysis identifies where tokens are being consumed and proposes concrete changes to reduce costs.

## Current Architecture (Token Flow)

Every coordinator LLM call sends:

1. **System prompt (~350 lines, ~5K tokens)** — coordinator.yaml system_prompt, rebuilt fresh every call
2. **Identity block (~30 lines)** — compiled from `OfficeIdentityService.compileSystemPromptBlock()`
3. **Autonomy block** — appended per-task from DB
4. **Time context block** — date/time appended per-task
5. **Intent anchor** — for scheduled tasks
6. **Sender context** — injected as system message (trust scores, authorization, verification)
7. **Bullpen context** — pending inter-agent threads
8. **Conversation history** — up to 50 turns from working memory
9. **48 tool definitions** — all pinned skills, sent as JSON schemas on every call
10. **Observation mode preamble** — ~40 lines of triage protocol injected per monitored email

Additionally, the **tool-use loop** resends the entire growing message array on each iteration (system prompt + history + all prior tool calls/results + tool definitions).

## Identified Cost Drivers

### 1. NO PROMPT CACHING (Highest Impact)

**File:** `src/agents/llm/anthropic.ts`

The `system` parameter is passed as a plain string (line 115). The Anthropic API supports structured system content blocks with `cache_control` markers, but none are used. Every single API call pays full price for the system prompt + tool definitions.

**Impact estimate:** The system prompt (~5K tokens) + 48 tool definitions (~8-12K tokens) = ~15K tokens sent uncached on every call. With prompt caching, repeat calls within 5 minutes would pay 90% less for cached content. Given the 38M input tokens, if even half are from repeated system/tool content, caching could save ~17M tokens worth of cost (cache reads are 90% cheaper).

### 2. 48 PINNED TOOL DEFINITIONS ON EVERY CALL (High Impact)

**File:** `agents/coordinator.yaml` lines 358-406

The coordinator has **48 pinned skills**. Every one of these is serialized as a JSON schema tool definition and sent on **every** LLM call — including simple conversational responses where only 2-3 tools would be relevant.

Each tool definition is roughly 150-300 tokens (name + description + input_schema). 48 tools = ~7,000-14,000 tokens per call, just for tools.

The `allow_discovery: true` flag and `skill-registry` tool exist for dynamic discovery, but aren't being leveraged to reduce the pinned set.

### 3. TOOL-USE LOOP RESENDS EVERYTHING (High Impact)

**File:** `src/agents/runtime.ts` lines 406, 592

The tool-use loop calls `chatWithRetry(provider, { messages, tools: workingToolDefs })` — resending the full messages array (which now includes all prior tool_use and tool_result blocks) plus all tool definitions. A 3-turn tool-use loop means the system prompt and tool definitions are sent 3x, and the conversation grows with each round.

### 4. EXTRACT-FACTS & EXTRACT-RELATIONSHIPS: NO CACHING ON DIRECT API CALLS (Medium Impact)

**Files:** `skills/extract-facts/handler.ts`, `skills/extract-relationships/handler.ts`

These skills make **direct** `client.messages.create()` calls (bypassing the AnthropicProvider), so they also have zero caching. Each checkpoint fires both skills, each making 1-2 API calls (classifier + extraction). The classifier prompts are tiny but the extraction prompts include the full transcript text.

Good news: both use a haiku classifier gate, which is cheap. But the sonnet extraction calls include the full conversation transcript with no caching.

### 5. OBSERVATION MODE PREAMBLE DUPLICATION (Medium Impact)

**File:** `src/dispatch/dispatcher.ts` lines 610-651

The ~40-line triage protocol is injected as **user content** (prepended to taskContent), not as part of the system prompt. This means:
- It's not cacheable even if system prompt caching were enabled
- It's duplicated verbatim for every monitored email
- It should be part of the system prompt (where it can be cached)

### 6. CONVERSATION HISTORY UNBOUNDED IN TOOL-USE LOOPS (Medium Impact)

**File:** `src/agents/runtime.ts`

Working memory returns up to 50 turns. These are loaded into the messages array at the start. During a multi-tool-use task, the messages array grows with each tool call/result pair. A complex task with 5 tool calls could accumulate significant token volume from tool results (entity-context returns full JSON payloads, email-list returns message arrays, etc.).

The summarization threshold is 20 turns with a 10-turn keep window, which is reasonable, but tool results within a single task aren't summarized.

### 7. RESEARCH-ANALYST USES SONNET (Low-Medium Impact)

**File:** `agents/research-analyst.yaml` line 6

The research analyst uses `claude-sonnet-4-20250514` — same as the coordinator. For web research summarization tasks, Haiku 4.5 would likely suffice at ~10% of the cost.

## Recommended Changes (Priority Order)

### P0: Add Prompt Caching to AnthropicProvider

**File to modify:** `src/agents/llm/anthropic.ts`

Change the `system` parameter from a plain string to an array of content blocks with `cache_control` breakpoints. Also add `cache_control` to the last tool definition so the full tool list is cached.

**Expected savings:** 60-80% reduction in effective input token cost for the coordinator. The system prompt + tool definitions (~15K tokens) would be cached across all calls within a 5-min TTL. Cache reads cost 10% of regular input tokens.

### P1: Move Observation Mode Triage to System Prompt

**File to modify:** `src/dispatch/dispatcher.ts`

Move the triage protocol into the coordinator's system prompt (conditional on observation mode), so it benefits from prompt caching. The message-specific identifiers (Message ID, Account) stay in the user content.

### P2: Reduce Pinned Tool Set, Lean on Discovery

Split the 48 pinned skills into tiers:
- **Always pinned (~15):** entity-context, contact-lookup, email-send/reply/list/get, delegate, scheduler-create/list/cancel, calendar core ops
- **Discovered on demand (~33):** templates, contact-merge/find-duplicates, held-messages, knowledge-*, calendar-register, set-autonomy, etc.

This cuts the tool definition payload from ~12K tokens to ~4K tokens per call.

### P3: Add Caching to Extract Skills

**Files:** `skills/extract-facts/handler.ts`, `skills/extract-relationships/handler.ts`

Add `cache_control` to the system/instruction portion of the extraction prompts. The prompt template is static; only the text varies.

### P4: Consider Haiku for Research Analyst

Change `agents/research-analyst.yaml` model to `claude-haiku-4-5-20251001` for routine web research tasks. The coordinator (Sonnet) synthesizes the final response anyway.

### P5: Track Token Usage Per-Skill

Add structured logging of token usage aggregated by skill/agent, so future optimization can be data-driven. The `response.usage` data is already logged (`runtime.ts:603`) but not aggregated.

## Verification

After implementing:
1. Check the Anthropic console for `cache_creation_input_tokens` and `cache_read_input_tokens` in the usage breakdown — cache reads should appear within minutes
2. Compare daily token spend before/after
3. Monitor `inputTokens` in the structured logs to verify per-call reduction
4. Run the test suite to ensure no regressions: `npm test`
