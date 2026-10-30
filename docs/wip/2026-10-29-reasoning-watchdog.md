# Reasoning Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop runaway reasoning inside a single LLM call. When the call runs too long, make one "forced" attempt that carries the reasoning so far and asks the model to act, instead of a blind retry.

**Architecture:**
- **One wrapper does all the watchdog work.** `ReasoningWatchdogProvider` wraps any `LLMProvider`, in the same style as `TelemetryLlmProvider`. It runs a call through `inner.stream()`, counts reasoning as it arrives, stops early, appends the forced message to Curia's own `Message[]`, and makes the forced attempt through `inner.chat()`.
- **Providers only implement a stream contract.** A provider's `stream()` emits two new events:
  - `request_started { maxTokens }`: the cap the request actually sent.
  - `reasoning_delta { text }`: one event per reasoning delta.
  - The provider must also honor `options.signal`.
- **A provider without `stream()` isn't watched.** Bedrock has none today, so the wrapper passes its `chat()` through.
- **Each turn's deadline reaches the call as `options.deadlineAt`.** The delegate skill and the scheduler stamp a new `agent.task.turnDeadlineAt`, and the runtime forwards it to the provider.

**Tech Stack:** TypeScript (ESM, Node 24), `openai` SDK against OpenRouter, `@anthropic-ai/sdk`, Vitest. Also curia-docs (Mintlify `.mdx`) for one page.

**Spec:** GitHub issue #2371 ("Bound runaway reasoning: watchdog and forced attempt, scaled to the call's cap and deadline"), plus the plan-review decisions of 2026-10-29:
- one generic wrapper;
- a per-provider stream contract;
- a guide for adding a provider.

## Global Constraints

- **No model-registry changes and no per-model configuration.** Thresholds come from the request's actual `max_tokens` (reported by `request_started`) and the turn's deadline.
- **Never send `reasoning.effort` and `reasoning.max_tokens` together** (OpenRouter returns a 400). This plan sends neither.
- **Named constants**, all in `src/agents/llm/reasoning-watchdog.ts`:
  - `REASONING_WATCHDOG_TOKEN_FRACTION = 0.5`
  - `REASONING_WATCHDOG_TIME_FRACTION = 0.5`
  - `FORCED_ATTEMPT_RESERVE_MS = 60_000`
  - `FORCED_REASONING_TAIL_CHARS = 16_000`
  - `WATCHDOG_REQUEST_TIMEOUT_MS = 600_000`. Shared with OpenRouter via `LLM_REQUEST_TIMEOUT_MS` in `request-timeout.ts` (not imported from a concrete provider).
- **Reasoning is counted in tokens:** one per `reasoning_delta`, never by character count.
- **At most one forced attempt per call.** The watched attempt is the only one that streams. The forced attempt goes through `inner.chat()` with that provider's normal retries.
- **Turns stay non-cancellable.** `deadlineAt` only sets when the watchdog fires; it never aborts a call or a turn.
- **The forced message is a `user`-role `Message`** whose text opens with the exact line `[Runtime note from Curia, not from the principal]`.
- **Repo rules:**
  - ESM `.js` imports and no `any`.
  - Run `pnpm -C <wt> run typecheck` before each commit that touches `.ts`.
  - Commits use `git commit -s` with no AI attribution lines.
  - CHANGELOG bullets are at most 15 words after the dash, and changes to bus event types are called out as public API.

## Review Focus

1. **Output has already started when a threshold is reached.** The watchdog stands down on the first `text_delta`, `tool_use` or `message_end`, and never cuts a reply that's in progress. (Task 3 test.)
2. **The caller aborts** (voice barge-in, a caller `signal`). That surfaces as the provider's cancellation error, never as a forced attempt or a `chat()` fallback. (Task 3 test.)
3. **`deadlineAt` is already past, or closer than `FORCED_ATTEMPT_RESERVE_MS`** (a late run). The time trigger falls back to the request-timeout basis instead of firing at once. (Task 1 test.)
4. **The stream errors** (upstream idle timeout, a reset) before or after reasoning has arrived. The wrapper falls back to `inner.chat(params)` once, keeping #2247's counted retries. (Task 3 test.)
5. **The stream finishes empty at the cap** (`message_end` with no content and no tool calls), because the token estimate was too low. This counts as a watchdog stop: one forced attempt, `trigger: 'cap'`. It is not returned as an empty answer. (Task 3 test.)

---

### Task 1: Watchdog limits and forced message (pure module)

**Files:**
- Create: `src/agents/llm/reasoning-watchdog.ts`
- Test: `tests/unit/agents/llm/reasoning-watchdog.test.ts`

**Interfaces:**
- Produces:
  - `export interface WatchdogLimits { tokenThreshold: number; fireAtMs: number }`. `fireAtMs` is epoch ms.
  - `export function watchdogLimits(args: { maxTokens: number; callStartMs: number; deadlineAt?: number; requestTimeoutMs?: number }): WatchdogLimits`. `requestTimeoutMs` defaults to `WATCHDOG_REQUEST_TIMEOUT_MS`.
  - `export function forcedAttemptMessage(reasoningSoFar: string): string`
  - `export type WatchdogTrigger = 'tokens' | 'time' | 'cap'`
  - `export interface ReasoningWatchdogRecord { trigger: WatchdogTrigger; firedAtReasoningTokens: number; firedAfterMs: number; forcedOutcome: 'acted' | 'empty' | 'error' }`
  - The five constants above.

- [ ] **Step 1: Write the failing tests.**

```ts
it('fires tokens at half the call cap', () => {
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0 }).tokenThreshold).toBe(16_384);
  expect(watchdogLimits({ maxTokens: 4_000, callStartMs: 0 }).tokenThreshold).toBe(2_000);
});
it('fires time at half the window before the deadline, after the reserve', () => {
  // window = min(563s, 600s) - 60s = 503s → fire at 251.5s
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 1_000, deadlineAt: 564_000 }).fireAtMs).toBe(252_500);
});
it('caps the window at the request timeout when the deadline is further out', () => {
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0, deadlineAt: 4_500_000 }).fireAtMs).toBe(270_000);
});
it('falls back to the request timeout when the deadline is past or inside the reserve', () => {
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 100_000, deadlineAt: 90_000 }).fireAtMs).toBe(370_000);
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0, deadlineAt: 59_000 }).fireAtMs).toBe(270_000);
});
it('forced message: marker first, tail of the reasoning, act-now instruction', () => {
  const msg = forcedAttemptMessage('x'.repeat(20_000) + 'END');
  expect(msg.startsWith('[Runtime note from Curia, not from the principal]\n')).toBe(true);
  expect(msg).toContain('END');
  expect(msg).not.toContain('x'.repeat(FORCED_REASONING_TAIL_CHARS + 1));
  expect(msg).toContain('Take your next step now: call the tool you need, or write your reply.');
});
it('forced message with no reasoning text still asks to act', () => {
  expect(forcedAttemptMessage('')).toContain('Take your next step now');
});
```

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/reasoning-watchdog.test.ts`. Expected: FAIL, because the module doesn't exist.
- [ ] **Step 3: Implement.**
  - The window is `min(deadlineAt, callStartMs + requestTimeoutMs) - callStartMs - FORCED_ATTEMPT_RESERVE_MS`. When the deadline is absent, past, or the result is ≤ 0, use `requestTimeoutMs - FORCED_ATTEMPT_RESERVE_MS` instead.
  - `fireAtMs = callStartMs + window * REASONING_WATCHDOG_TIME_FRACTION`.
  - `tokenThreshold = Math.floor(maxTokens * REASONING_WATCHDOG_TOKEN_FRACTION)`.
  - The forced message copy is fixed. Leave out the `…` when the reasoning fits in the tail, and leave out the whole `<previous_reasoning>` block when the reasoning is empty:

```
[Runtime note from Curia, not from the principal]
Your previous attempt at this step was stopped after a long stretch of reasoning with no action. The end of that reasoning is below.
<previous_reasoning>
…{last FORCED_REASONING_TAIL_CHARS chars}
</previous_reasoning>
You have already thought this through. Do not start over or re-derive it.
Take your next step now: call the tool you need, or write your reply.
```

- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(llm): reasoning watchdog limits and forced-attempt message (#2371)"`

---

### Task 2: The stream contract: `request_started` and `reasoning_delta`, emitted by OpenRouter and Anthropic

**Files:**
- Modify:
  - `src/agents/llm/provider.ts`: the `LLMStreamEvent` union (~:194) and the `stream?` doc comment (~:222)
  - `src/agents/llm/openrouter.ts`: `stream()`, which already accumulates `delta.reasoning` (~:1017)
  - `src/agents/llm/anthropic.ts`: `stream()` (~:530-545)
- Test:
  - `tests/unit/agents/llm/openrouter.test.ts` (the `stream` describe block)
  - `tests/unit/agents/llm/anthropic.test.ts`
  - `tests/unit/agents/llm/streaming-turn.test.ts`

**Interfaces:**
- Produces two new members of `LLMStreamEvent`:
  - `{ type: 'request_started'; maxTokens: number }`. Emitted exactly once, before any other event, with the `max_tokens` the request actually sent.
  - `{ type: 'reasoning_delta'; text: string }`. One per reasoning delta that carries non-empty text.

- [ ] **Step 1: Write the failing tests.**
  - OpenRouter: `stream emits request_started with the sent max_tokens, then one reasoning_delta per delta.reasoning or reasoning_details text`. Use a 3-reasoning-chunk fixture through `makeStream`. The event sequence must start with `request_started` (`maxTokens: 32_768` for a registry model at its cap) and contain 3 `reasoning_delta` events in order, ahead of the final `tool_use` event.
  - Anthropic:
    - `stream emits request_started with the sent max_tokens and a reasoning_delta per non-empty thinking_delta`.
    - `empty thinking deltas (display omitted) emit no reasoning_delta`.
  - streaming-turn: `ignores request_started and reasoning_delta events`. Feed a stream with both new events. The assembled turn result equals the one from the same stream without them.
- [ ] **Step 2: Run the tests and confirm they fail.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/openrouter.test.ts tests/unit/agents/llm/anthropic.test.ts tests/unit/agents/llm/streaming-turn.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - Add the two union members, with doc comments that state the contract. That contract is what Task 6's guide describes.
  - OpenRouter: yield `request_started` from `createParams.max_tokens` right after `buildCreateParams`, and yield `reasoning_delta` wherever it already appends to `reasoningDirect`, or adds `reasoning_details` text.
  - Anthropic: yield `request_started` from `createParams.max_tokens`, and yield `reasoning_delta` on `content_block_delta` events whose `delta.type === 'thinking_delta'` and whose `delta.thinking` is non-empty.
  - Change nothing else in either `stream()`.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command, plus `pnpm -C <wt> run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(llm): stream request_started and reasoning_delta events (#2371)"`

---

### Task 3: `ReasoningWatchdogProvider`, the generic wrapper

**Files:**
- Create: `src/agents/llm/reasoning-watchdog-provider.ts`
- Modify:
  - `src/agents/llm/provider.ts`: add `reasoningWatchdog?: ReasoningWatchdogRecord` to `LLMCallProvenance` (~:125)
  - `src/index.ts`: wrap each `providerRegistry.set(...)` value, at :551, :560 and :568
- Test: `tests/unit/agents/llm/reasoning-watchdog-provider.test.ts`. Use a hand-written fake `LLMProvider` whose `stream()` yields scripted events and whose `chat()` returns scripted responses.

**Interfaces:**
- Consumes: Task 1 (`watchdogLimits`, `forcedAttemptMessage`, `ReasoningWatchdogRecord`) and Task 2 (the events). `options.deadlineAt?: number` and `options.signal?: AbortSignal` are read from `params.options`.
- Produces: `export class ReasoningWatchdogProvider implements LLMProvider`, constructed as `constructor(inner: LLMProvider, logger: Logger, now: () => number = Date.now)`.
  - `id` equals `inner.id`.
  - `stream` exists exactly when `inner.stream` does, and passes through unchanged. Voice checks for `stream` before it starts, so the wrapper must not add one the inner provider lacks.
  - `chat()` is watched when `inner.stream` exists, and passed through when it doesn't.

- [ ] **Step 1: Write the failing tests:**
  - `passes chat through untouched when the inner provider has no stream()`.
  - `does not add a stream method the inner provider lacks`.
  - `a watched call that finishes normally returns the same LLMResponse inner.chat would`. A `tool_use` final event maps to `type: 'tool_use'` (with toolCalls, content, reasoningBlocks, usage, provenance and reasoning fields), and `message_end` maps to `type: 'text'`. There's no `reasoningWatchdog` on provenance.
  - `token trigger:`
    - With `request_started { maxTokens: 10 }` and 5 `reasoning_delta`s, the stream's signal is aborted after the 5th.
    - `inner.chat` is called once, with `messages` equal to the original plus one `{ role: 'user', content }` message that starts with the marker and contains the deltas' text.
    - The result is `inner.chat`'s response, with `provenance.reasoningWatchdog` matching `{ trigger: 'tokens', firedAtReasoningTokens: 5, forcedOutcome: 'acted' }`.
  - `time trigger:` with fake timers and a fake `now`, a stream that stalls after one `reasoning_delta` is aborted at `fireAtMs`, and the record says `trigger: 'time'`.
  - `deadlineAt moves fireAtMs`. Two runs with different `options.deadlineAt` fire at the times `watchdogLimits` gives.
  - `stands down on the first text_delta` (Review Focus 1). Reasoning goes past the threshold after a `text_delta`, and there's no abort.
  - `a caller abort returns the stream's error and never calls inner.chat` (Review Focus 2).
  - `a stream error falls back to inner.chat(params) once with the original params` (Review Focus 4). There's no forced message and no record.
  - `message_end empty at the cap is a watchdog stop with trigger "cap"` (Review Focus 5).
  - `the forced response comes back empty: forcedOutcome "empty"`. `inner.chat` is called exactly once by the wrapper.
  - `the forced response is an error: returned as-is, warn logged with forcedOutcome "error"`.
  - `usage adds the stopped attempt's reasoning-delta count to outputTokens and reasoningTokens`.
  - `the forced attempt keeps the caller's options (reasoning, max_tokens, model, signal) and drops deadlineAt`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/reasoning-watchdog-provider.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Combine the caller signal with an internal `AbortController` using `AbortSignal.any`. Tell a watchdog stop from a caller abort by checking `internal.signal.aborted` and the caller signal's `aborted`.
  - Arm a `setTimeout(fireAtMs - now())` once `request_started` arrives, and clear it in `finally`.
  - Log a `warn` on every firing: `'Reasoning watchdog fired — forced attempt'`, with the record, model and `inner.id`.
  - Wrap at all three registry sites in `index.ts`: `new ReasoningWatchdogProvider(provider, logger)`.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command, plus `pnpm -C <wt> run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(llm): ReasoningWatchdogProvider wraps every provider with a reasoning watchdog (#2371)"`

---

### Task 4: `reasoningWatchdog` on `llm.call`

**Files:**
- Modify:
  - `src/agents/llm/llm-call-reasoning.ts` (:12-35)
  - `src/bus/events.ts` (`LlmCallPayload` ~:817-878)
- Test: `tests/unit/agents/llm/llm-call-reasoning.test.ts`

**Interfaces:**
- Produces:
  - `LlmCallPayload.reasoningWatchdog?: ReasoningWatchdogRecord | null`
  - `llmCallReasoningFields()` returns `reasoningWatchdog: provenance.reasoningWatchdog ?? null`

- [ ] **Step 1: Write the failing test.** `maps reasoningWatchdog through, and null when absent`.
- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/llm-call-reasoning.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the field and its doc comment, in the style of the `attempts` field.
- [ ] **Step 4: Run the test, then the runtime and telemetry tests that cover `llm.call`, and typecheck.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm tests/unit/agents/runtime` and `pnpm -C <wt> run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(audit): record reasoningWatchdog on llm.call (#2371)"`

---

### Task 5: `turnDeadlineAt` from the delegate skill and scheduler to `options.deadlineAt`

**Files:**
- Modify:
  - `src/bus/events.ts` (`AgentTaskPayload` :54-110, `createAgentTask` ~:2190)
  - `skills/delegate/handler.ts` (`createAgentTask` call ~:689)
  - `src/scheduler/scheduler.ts` (`agent.task` publish ~:1214-1229)
  - `src/agents/runtime.ts`: `agentTurnOptions` (:173); `chatWithRetry` (:3436) and its `provider.chat` calls at :3498, :3538 and :3648; and `composeDelegationFailureReply` at :3207
- Test:
  - `skills/delegate/handler.test.ts`
  - The scheduler test that covers fire payloads (`grep -rln "expectedDurationSeconds" tests/unit/scheduler`)
  - The runtime test that covers `chatWithRetry` options (`grep -rln "agentTurnOptions\|reasoning:" tests/unit/agents`)

**Interfaces:**
- Produces:
  - `AgentTaskPayload.turnDeadlineAt?: number` (epoch ms). Like `liveTurn`, it's a distinct top-level field, not a `metadata` key, so a skill that forwards the metadata bag can't copy it.
  - `agentTurnOptions(reasoning, deadlineAt?: number)` returns `{ options: { reasoning?, deadlineAt? } }`, or `{}` when both are absent.

- [ ] **Step 1: Write the failing tests.**
  - Delegate: `the published agent.task carries turnDeadlineAt = dispatch time + the resolved wait`. Under fake time, a 563,000 ms wait gives `now + 563_000`.
  - Scheduler: `a fired agent.task carries turnDeadlineAt = fire time + slotTimeoutMs(job)`, both with a hint and without one.
  - Runtime: `chatWithRetry passes options.deadlineAt from turnDeadlineAt on the primary, retry and fallback calls`, and `omits deadlineAt when the task has none`.
  - Events: `createAgentTask passes turnDeadlineAt through and never reads it from metadata`.
- [ ] **Step 2: Run them and confirm they fail.** Run the four files with `pnpm -C <wt> exec vitest run <files>`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The delegate skill sets `turnDeadlineAt: Date.now() + specialistTimeoutMs`.
  - The scheduler sets `turnDeadlineAt: Date.now() + this.slotTimeoutMs(job)`.
  - The runtime reads `taskEvent.payload.turnDeadlineAt` once in `chatWithRetry`, and threads it through `agentTurnOptions` at the four call sites.
  - Leave the `turnAbort` placeholder as it is.
- [ ] **Step 4: Run the tests and confirm they pass, then typecheck.** Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(dispatch): carry each turn's deadline to the LLM call as deadlineAt (#2371)"`

---

### Task 6: Provider guide, spec, ADR, CHANGELOG

**Files:**
- Create: `docs/dev/adding-an-llm-provider.md`
- Modify:
  - `docs/specs/02-agent-system.md`, section "LLM Provider Abstraction" (~:356-400)
  - `docs/adr/048-reasoning-policy.md`: a dated amendment section
  - `CHANGELOG.md`, under `## [Unreleased]`

- [ ] **Step 1: Write `docs/dev/adding-an-llm-provider.md`.** Follow the shape of `docs/dev/adding-a-channel.md`: numbered steps plus a checklist. It covers:
  1. Registry entries (`model-registry.ts`): `provider`, `maxOutputTokens`, `reasoning` and `thinksByDefault`.
  2. `chat()`, the core of the contract: never throw for API errors, map `max_tokens` (capped at the registry value), `signal`, `temperature` and `reasoning` (via `sampling-options.ts`), and fill `LLMCallProvenance` (`upstreamProvider` and `attempts` where they apply).
  3. `stream()`, optional but needed for voice and the watchdog: it emits `request_started` first, `reasoning_delta` per reasoning delta, `text_delta`, then `tool_use` or `message_end`; it honors `options.signal`; and it releases the SDK stream on every exit.
  4. Reasoning pass-back (`reasoning-blocks.ts`, ADR-048).
  5. Registration in `src/index.ts`, wrapped in `ReasoningWatchdogProvider`.
  6. The tests to copy: `openrouter.test.ts` and `anthropic.test.ts`.

  State plainly that a provider without `stream()` works, but isn't watched and can't serve voice.
- [ ] **Step 2: Update spec 02.** Name the three chat providers (Anthropic, OpenRouter, Bedrock); the OpenRouter route is how Curia reaches OpenAI and Google models. Add the two stream events and the wrapper, and link the guide.
- [ ] **Step 3: Write the ADR-048 amendment.** It covers:
  - the 2026-10-29 probe: no DeepSeek endpoint enforces `reasoning.max_tokens`; effort and budget together are a 400; and Claude 5.x models reject `budget_tokens`;
  - the watchdog and forced attempt;
  - the two fractions;
  - that no budget is ever sent.

  Cite #2371 and #1915.
- [ ] **Step 4: Add the CHANGELOG bullets.**
  - Added: `- **Reasoning watchdog** — runaway reasoning stops early and gets one forced attempt, on every streaming provider. (#2371)`
  - Added: `- **Provider guide** — \`docs/dev/adding-an-llm-provider.md\` documents the provider and stream contract. (#2371)`
  - Changed: `- **agent.task / llm.call / LLMStreamEvent** — **public API:** \`turnDeadlineAt\`, \`reasoningWatchdog\`, \`request_started\` and \`reasoning_delta\` added. (#2371)`
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "docs: LLM provider guide, spec 02, ADR-048 amendment, changelog (#2371)"`

---

### Task 7: curia-docs PR

**Files** (in a new curia-docs worktree, `~/Projects/curia/worktrees/curia-docs-llm-providers`, created from a freshly pulled `repos/curia-docs`):
- Modify: `references/configuration.mdx`, "model routing" section (~:384-410)

- [ ] **Step 1: Edit the section.**
  - Add Bedrock to the providers it describes, with the `global.anthropic.*` / `us.anthropic.*` / `eu.anthropic.*` prefixes, alongside `claude-*` (Anthropic) and `vendor/model` (OpenRouter).
  - Add a short note on the reasoning watchdog: when a model reasons for too long without acting, Curia stops it and asks it to act, and each firing is recorded on `llm.call` as `reasoningWatchdog`.
  - Follow the repo's `AGENTS.md` style rules.
- [ ] **Step 2: Run the docs checks.** Run whatever `curia-docs/CONTRIBUTING.md` names, for example `mint broken-links`. Expected: no new errors.
- [ ] **Step 3: Commit, push, and open the PR.** Reference curia#2371. Note that it should merge after the curia PR ships.

---

### Task 8: Verification

- [ ] **Step 1: Typecheck and the unit suite.**
  - Run: `pnpm -C <wt> run typecheck`. Expected: exit 0.
  - Run: `pnpm -C <wt> exec vitest run tests/unit skills`. Expected: PASS. A known parallel-load timeout in `small-cap-models.test.ts` gets re-run alone before it counts as a failure.
- [ ] **Step 2: Run the replay gate.** **Ask the maintainer first, with a cost estimate of about $1.**
  - Replay the archived long-reasoning turns through `new ReasoningWatchdogProvider(new OpenRouterProvider(...))` on this branch, using the 2026-10-29 replay recipe.
  - It passes if forced attempts act at least as often as plain retries and finish faster.
  - Hand-check a sample of tool calls against prod's.
  - Delete the exported prompts afterwards.
- [ ] **Step 3: Run the live Anthropic probe** (under $0.10; mention it rather than gate on it). Call the wrapped `AnthropicProvider.chat()` on `claude-haiku-5-5` and `claude-sonnet-5-5` with a forced-attempt message appended after a short tool loop. It passes if both return a `tool_use` or text response, not a 400.
- [ ] **Step 4: Open the curia PR** with `Closes #2371`. The body notes the public API additions and links the curia-docs PR.
- [ ] **Step 5: After deploy, record in #1915:** how often the watchdog fired in the soak window, and the `forcedOutcome` counts (from `llm.call.reasoningWatchdog`).
