# Reasoning Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop runaway reasoning inside a single LLM call. When it runs too long, replace the plain empty-at-cap retry with one forced attempt that carries the reasoning so far and asks the model to act.

**Architecture:**
- A provider-agnostic module computes the trigger points:
  - a fraction of the call's own `max_tokens`;
  - a fraction of the time left before the turn's deadline, capped by the per-request timeout.
- It also builds the forced-attempt message.
- The OpenRouter chat path streams internally, so it can count reasoning as it arrives and stop early. The runtime still receives one complete `LLMResponse`.
- A new `turnDeadlineAt` on `agent.task` carries each turn's deadline from the delegate skill and the scheduler. The runtime passes it to the provider as `options.deadlineAt`.
- The Anthropic provider gets the same treatment. Its token trigger only counts when thinking text actually streams.

**Tech Stack:** TypeScript (ESM, Node 24), `openai` SDK against OpenRouter, `@anthropic-ai/sdk`, Vitest.

**Spec:** GitHub issue #2371 ("Bound runaway reasoning: watchdog and forced attempt, scaled to the call's cap and deadline"). Background is in #1915's 2026-10-29 comments.

## Global Constraints

- No model-registry changes and no per-model configuration. Every threshold is derived from the request's `max_tokens` and the turn's deadline.
- Never send `reasoning.effort` and `reasoning.max_tokens` together; OpenRouter returns a 400. This plan sends neither.
- Named constants, all in `src/agents/llm/reasoning-watchdog.ts`:
  - `REASONING_WATCHDOG_TOKEN_FRACTION = 0.5`
  - `REASONING_WATCHDOG_TIME_FRACTION = 0.5`
  - `FORCED_ATTEMPT_RESERVE_MS = 60_000`
  - `FORCED_REASONING_TAIL_CHARS = 16_000`
- The watchdog counts reasoning in tokens, not characters. The estimate is one per reasoning-bearing stream delta, which is how OpenRouter and Anthropic stream.
- At most one forced attempt per call. The forced attempt runs with the watchdog off.
- Turns stay non-cancellable. `deadlineAt` sets when the watchdog fires; it never aborts a call or a turn.
- The forced message is a `user`-role message whose text opens with the exact marker line `[Runtime note from Curia, not from the principal]`.
- Repo rules apply: ESM `.js` imports, no `any`, `pnpm -C <worktree> run typecheck` before each commit, and commits signed off with `-s` and no AI attribution lines. Public API changes (bus event types) are called out in CHANGELOG, at 15 words or fewer after the dash.

## Review Focus

1. **The answer has already started when a threshold is reached.** The watchdog must disarm on the first content or tool-call delta and never cut a reply that's in progress. (Task 2 test.)
2. **The caller aborts.** A voice barge-in or caller `signal` abort mid-reasoning must surface as today's cancellation, never as a forced attempt. (Task 2 test.)
3. **`deadlineAt` is already past, or less than `FORCED_ATTEMPT_RESERVE_MS` away** (a late or near-late run). The time trigger falls back to the request-timeout basis instead of firing at once. (Task 1 test.)
4. **The stream fails mid-reasoning** (upstream idle timeout, a reset). That's today's retryable error, with its attempt counting, not a forced attempt. (Task 2 test.)
5. **The forced attempt itself comes back empty at the cap.** The call returns that empty response, so the runtime's existing empty-response handling runs. `reasoningWatchdog.forcedOutcome` is `'empty'`, and there's no further retry. (Task 3 test.)

---

### Task 1: Watchdog limits and forced message (pure module)

**Files:**
- Create: `src/agents/llm/reasoning-watchdog.ts`
- Test: `tests/unit/agents/llm/reasoning-watchdog.test.ts`

**Interfaces:**
- Produces:
  - `export interface WatchdogLimits { tokenThreshold: number; fireAtMs: number }`. `fireAtMs` is an epoch-ms time.
  - `export function watchdogLimits(args: { maxTokens: number; callStartMs: number; deadlineAt?: number; requestTimeoutMs: number }): WatchdogLimits`
  - `export function forcedAttemptMessage(reasoningSoFar: string): string`
  - `export type WatchdogTrigger = 'tokens' | 'time'`
  - `export interface ReasoningWatchdogRecord { trigger: WatchdogTrigger; firedAtReasoningTokens: number; firedAfterMs: number; forcedOutcome: 'acted' | 'empty' | 'error' }`
  - The four constants from Global Constraints.

- [ ] **Step 1: Write the failing tests**

```ts
it('fires tokens at half the call cap', () => {
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0, requestTimeoutMs: 600_000 }).tokenThreshold).toBe(16_384);
  expect(watchdogLimits({ maxTokens: 4_000, callStartMs: 0, requestTimeoutMs: 600_000 }).tokenThreshold).toBe(2_000);
});
it('fires time at half the window left before the deadline, after the reserve', () => {
  // window = min(deadline 563s, request 600s) - reserve 60s = 503s → fire at 251.5s
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 1_000, deadlineAt: 1_000 + 563_000, requestTimeoutMs: 600_000 }).fireAtMs).toBe(1_000 + 251_500);
});
it('caps the window at the request timeout when the deadline is further out', () => {
  // window = 600s - 60s = 540s → fire at 270s
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0, deadlineAt: 4_500_000, requestTimeoutMs: 600_000 }).fireAtMs).toBe(270_000);
});
it('falls back to the request timeout when the deadline is past or inside the reserve', () => {
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 100_000, deadlineAt: 90_000, requestTimeoutMs: 600_000 }).fireAtMs).toBe(100_000 + 270_000);
  expect(watchdogLimits({ maxTokens: 32_768, callStartMs: 0, deadlineAt: 59_000, requestTimeoutMs: 600_000 }).fireAtMs).toBe(270_000);
});
it('forced message carries the marker, the tail of the reasoning, and the act-now instruction', () => {
  const long = 'x'.repeat(20_000) + 'END';
  const msg = forcedAttemptMessage(long);
  expect(msg.startsWith('[Runtime note from Curia, not from the principal]')).toBe(true);
  expect(msg).toContain('END');
  expect(msg).not.toContain('x'.repeat(FORCED_REASONING_TAIL_CHARS + 1));
  expect(msg).toContain('Take your next step now: call the tool you need, or write your reply.');
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/reasoning-watchdog.test.ts`. Expected: FAIL (the module doesn't exist).

- [ ] **Step 3: Implement.** The window is `min(deadlineAt ?? Infinity, callStartMs + requestTimeoutMs) - callStartMs - FORCED_ATTEMPT_RESERVE_MS`. If the deadline is absent, already past, or less than the reserve away, use `requestTimeoutMs - FORCED_ATTEMPT_RESERVE_MS` instead. Then `fireAtMs = callStartMs + window * REASONING_WATCHDOG_TIME_FRACTION`. Round `tokenThreshold` down with `Math.floor`. The forced message copy is fixed:

```
[Runtime note from Curia, not from the principal]
Your previous attempt at this step was stopped after a long stretch of reasoning with no action. The end of that reasoning is below.
<previous_reasoning>
…{last FORCED_REASONING_TAIL_CHARS chars}
</previous_reasoning>
You have already thought this through. Do not start over or re-derive it.
Take your next step now: call the tool you need, or write your reply.
```

  Leave out the leading `…` when the reasoning is shorter than the tail.

- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(llm): watchdog limits and forced-attempt message (#2371)"`

---

### Task 2: OpenRouter non-streaming attempts stream internally, with the watchdog

**Files:**
- Create: `src/agents/llm/openrouter-stream-assembly.ts`
- Modify: `src/agents/llm/openrouter.ts`. `createWithRetries` (~:741-821) sends each attempt through the new function instead of `client.chat.completions.create(createParams)`.
- Test: `tests/unit/agents/llm/openrouter-stream-assembly.test.ts`. Also adapt `tests/unit/agents/llm/openrouter.test.ts`.

**Interfaces:**
- Consumes: `WatchdogLimits` and `WatchdogTrigger` (Task 1), and `mergeReasoningDetailDeltas` / `upstreamProviderFrom` (existing, openrouter.ts).
- Produces:
  - `export type StreamedAttempt = { kind: 'complete'; completion: ChatCompletion } | { kind: 'stopped'; trigger: WatchdogTrigger; reasoningText: string; reasoningTokensEstimated: number; elapsedMs: number }`
  - `export async function streamCompletion(client: OpenAI, params: ChatCompletionCreateParamsNonStreaming, opts: { signal?: AbortSignal; limits?: WatchdogLimits; now?: () => number }): Promise<StreamedAttempt>`
  - `limits` absent means no watchdog. The forced attempt uses that path.
  - The function throws exactly what `create` throws today: SDK errors, including the caller's abort.

- [ ] **Step 1: Write the failing assembly tests**, using the chunk-stream helper pattern already in `openrouter.test.ts` (`makeStream`).
  - `assembles text, reasoning, reasoning_details, tool calls, finish_reason, usage, id, model and provider into a ChatCompletion equal to the non-streamed shape`. Assert that `choices[0].message.tool_calls[0].function.arguments` is joined across deltas, `(completion as {provider}).provider === 'CoreWeave'`, `usage.completion_tokens_details.reasoning_tokens` is passed through, and `isEmptyAtOutputCap(completion)` matches for a length-capped empty stream.
  - `stops with trigger "tokens" once reasoning deltas reach tokenThreshold`. Feed 10 reasoning deltas with `tokenThreshold: 5`. Expect `kind: 'stopped'`, `reasoningTokensEstimated: 5`, `reasoningText` equal to the 5 joined deltas, and the SDK stream's `controller.abort` called.
  - `stops with trigger "time" when fireAtMs passes before any output`. Use a fake `now` and vi fake timers. A stream that stalls after one reasoning delta stops at `fireAtMs`.
  - `disarms on the first content or tool-call delta`. Feed reasoning past the threshold, but put a content delta first. Expect `kind: 'complete'`. (Review Focus 1.)
  - `a caller abort mid-reasoning rejects with the SDK abort error, not a stop`. (Review Focus 2.)
  - `a mid-stream error rejects as create would`. A stream that throws after 3 reasoning deltas rejects with that error. (Review Focus 4.)
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/openrouter-stream-assembly.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `streamCompletion`.** Send `{ ...params, stream: true, stream_options: { include_usage: true } }` with `{ maxRetries: 0, signal }`, where `signal` combines the caller's signal and an internal `AbortController` through `AbortSignal.any`. A time stop arms a `setTimeout` at `fireAtMs - now()`, clears it in `finally`, and aborts the internal controller. It's told apart from a caller abort by checking which controller fired. Reasoning text comes from `delta.reasoning` (string) or the `reasoning_details[].text` fields.
- [ ] **Step 4: Wire it into `createWithRetries`.**
  - It gains a `limits?: WatchdogLimits` argument. A `stopped` attempt ends the loop and returns a new outcome variant: `{ ok: true; stopped: Extract<StreamedAttempt, { kind: 'stopped' }>; attempts; failedAttemptsMs; discardedUsage }`.
  - A `complete` attempt follows today's code unchanged, including the empty-at-cap retry. That retry still covers calls where the watchdog never fired.
- [ ] **Step 5: Adapt the existing `openrouter.test.ts`.** Add a `completionAsStream(completion)` test helper. Make `mockCreate`'s implementation return `completionAsStream(...)` whenever `params.stream === true`, so existing non-streamed fixtures keep working unchanged. Every existing test must still pass with its assertions untouched.
- [ ] **Step 6: Run** `pnpm -C <wt> exec vitest run tests/unit/agents/llm/openrouter-stream-assembly.test.ts tests/unit/agents/llm/openrouter.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit.** `git -C <wt> commit -s -m "feat(openrouter): stream chat attempts so a reasoning watchdog can stop them (#2371)"`

---

### Task 3: Forced attempt in OpenRouter `chat()`, with its record on `llm.call`

**Files:**
- Modify:
  - `src/agents/llm/openrouter.ts` (`chat()` ~:823)
  - `src/agents/llm/provider.ts` (`LLMCallProvenance` ~:125)
  - `src/agents/llm/llm-call-reasoning.ts` (:12-35)
  - `src/bus/events.ts` (`LlmCallPayload` ~:817-878)
- Test:
  - `tests/unit/agents/llm/openrouter.test.ts`
  - `tests/unit/agents/llm/llm-call-reasoning.test.ts`

**Interfaces:**
- Consumes: `watchdogLimits` and `forcedAttemptMessage` (Task 1); `streamCompletion` and the `stopped` outcome (Task 2).
- Produces:
  - `LLMCallProvenance.reasoningWatchdog?: ReasoningWatchdogRecord`
  - `LlmCallPayload.reasoningWatchdog?: ReasoningWatchdogRecord | null`
  - `llmCallReasoningFields(...)` returns `reasoningWatchdog: provenance.reasoningWatchdog ?? null`
  - `chat()` reads `options.deadlineAt` (a finite number, otherwise ignored), which Task 4 supplies.

- [ ] **Step 1: Write the failing tests** in `openrouter.test.ts`:
  - `a stopped attempt triggers one forced attempt with the tail of the reasoning appended as a user message`:
    - The second `mockCreate` call's `messages.at(-1)` is `{ role: 'user', content: <starts with the marker> }`. Its `messages.slice(0, -1)` deep-equals the first call's messages.
    - The forced call sends no `reasoning` key unless the caller set an effort.
    - The result is the forced attempt's tool call.
    - `provenance.reasoningWatchdog` matches `{ trigger: 'tokens', firedAtReasoningTokens: 16_384, forcedOutcome: 'acted' }`.
  - `the forced attempt runs with the watchdog off`. The second call runs to completion even past the threshold.
  - `a forced attempt that comes back empty at the cap returns it as-is with forcedOutcome "empty" and no further attempts`. `mockCreate` is called exactly twice. (Review Focus 5.)
  - `a forced attempt that errors returns the error response with forcedOutcome recorded in the log, attempts counted`.
  - `deadlineAt in options moves fireAtMs`. Spy on `watchdogLimits`, or assert the stop time with fake timers.
  - `usage counts the stopped attempt's estimated reasoning as output tokens`. `usage.outputTokens` is at least the forced attempt's tokens plus `reasoningTokensEstimated`.
- [ ] **Step 2:** Add a `llm-call-reasoning.test.ts` case: `maps reasoningWatchdog through, null when absent`.
- [ ] **Step 3: Run them and confirm they fail.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/openrouter.test.ts tests/unit/agents/llm/llm-call-reasoning.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - In `chat()`, compute `limits` from `createParams.max_tokens`, `Date.now()`, `options.deadlineAt` and `OPENROUTER_REQUEST_TIMEOUT_MS`, and pass them to `createWithRetries`.
  - On a `stopped` outcome:
    - Build `forcedParams = { ...createParams, messages: [...createParams.messages, { role: 'user', content: forcedAttemptMessage(stopped.reasoningText) }] }`.
    - Make one call through `streamCompletion` with no `limits`.
    - Then continue through the existing response mapping.
  - Fold `reasoningTokensEstimated` into `usage.outputTokens` and `usage.reasoningTokens`. The stopped stream returned no usage, so its input tokens can't be known; say so in a code comment.
  - Log a `warn` with the record: `'OpenRouter reasoning watchdog fired — forced attempt'`.
  - Add the field to the three types, with doc comments in the style of the neighbouring fields.
- [ ] **Step 5: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 6: Commit.** `git -C <wt> commit -s -m "feat(openrouter): forced attempt after the reasoning watchdog fires, recorded on llm.call (#2371)"`

---

### Task 4: `turnDeadlineAt` from delegate and scheduler to `options.deadlineAt`

**Files:**
- Modify:
  - `src/bus/events.ts` (`AgentTaskPayload` :54-110, `createAgentTask` ~:2190)
  - `skills/delegate/handler.ts` (`createAgentTask` call ~:689)
  - `src/scheduler/scheduler.ts` (`agent.task` publish ~:1214-1229)
  - `src/agents/runtime.ts`: `agentTurnOptions` (:173); `chatWithRetry` (:3436) and its `provider.chat` calls at :3498, :3538 and :3648; `composeDelegationFailureReply` at :3207
- Test:
  - `skills/delegate/handler.test.ts`
  - `tests/unit/scheduler/scheduler.test.ts` (or the file that covers fire payloads; find it with `grep -rln "expectedDurationSeconds" tests/unit/scheduler`)
  - `tests/unit/agents/runtime*.test.ts` (whichever covers `chatWithRetry` options; find it with `grep -rln "agentTurnOptions\|reasoning: " tests/unit/agents`)

**Interfaces:**
- Produces:
  - `AgentTaskPayload.turnDeadlineAt?: number` (epoch ms). Like `liveTurn`, it's a distinct top-level field, not part of `metadata`, so no skill forwarding the metadata bag can copy it.
  - `agentTurnOptions(reasoning, deadlineAt?: number)` returns `{ options: { reasoning?, deadlineAt? } }`, or `{}` when both are absent.

- [ ] **Step 1: Write the failing tests.**
  - Delegate: `the published agent.task carries turnDeadlineAt = dispatch time + the resolved wait`. Use fake time: with a 563,000 ms wait, the value is `now + 563_000`.
  - Scheduler: `a fired agent.task carries turnDeadlineAt = fire time + slotTimeoutMs(job)`, both for a job with a hint and for one without (the default-duration path).
  - Runtime: `chatWithRetry passes options.deadlineAt from the task's turnDeadlineAt on the primary, retry and fallback calls`, and `omits deadlineAt when the task has none`.
  - Events: `createAgentTask passes turnDeadlineAt through`, and `does not read it from metadata`.
- [ ] **Step 2: Run them and confirm they fail.** Run the four test files with `pnpm -C <wt> exec vitest run <files>`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The delegate handler sets `turnDeadlineAt: Date.now() + specialistTimeoutMs`.
  - The scheduler sets `turnDeadlineAt: Date.now() + this.slotTimeoutMs(job)`.
  - The runtime reads `taskEvent.payload.turnDeadlineAt` once in `chatWithRetry` and threads it through `agentTurnOptions` at the four call sites.
  - Remove nothing. The `turnAbort` placeholder stays as it is, because turns stay non-cancellable.
- [ ] **Step 4: Run the tests and confirm they pass.** Then run `pnpm -C <wt> run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(dispatch): carry each turn's deadline to the LLM call as deadlineAt (#2371)"`

---

### Task 5: Anthropic provider watchdog

**Files:**
- Modify: `src/agents/llm/anthropic.ts` (`chat()` :441, which calls `messages.create` :454)
- Test: `tests/unit/agents/llm/anthropic.test.ts`

**Interfaces:**
- Consumes: `watchdogLimits`, `forcedAttemptMessage` and `ReasoningWatchdogRecord` (Task 1); `options.deadlineAt` (Task 4).
- Produces: the same `provenance.reasoningWatchdog` record as OpenRouter.

- [ ] **Step 1: Write the failing tests**, mocking `messages.stream` the same way the existing stream tests in `anthropic.test.ts` do.
  - `stops on the time trigger when no text or tool_use block has started` and makes one forced attempt with the marker message appended as a user turn. The thinking blocks from the stopped attempt are **not** passed back.
  - `counts thinking_delta events toward the token threshold when thinking text streams` (display `summarized`).
  - `with display omitted, only the time trigger can fire`. Empty thinking deltas don't count.
  - `disarms on the first text or tool_use content block`.
  - `a caller abort is a cancellation, not a forced attempt`.
- [ ] **Step 2: Run them and confirm they fail.** Run: `pnpm -C <wt> exec vitest run tests/unit/agents/llm/anthropic.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `chat()` uses `this.client.messages.stream(createParams, { signal })` and `finalMessage()` on the normal path. The response mapping stays the same.
  - The watchdog observes `content_block_start` and `content_block_delta` events.
  - On a stop, the forced attempt appends `{ role: 'user', content: forcedAttemptMessage(thinkingTextSoFar) }`, which may be empty, and runs once with no watchdog.
  - Use a `requestTimeoutMs` of 600,000, the Anthropic SDK default. Name it locally with a comment citing the SDK default.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git -C <wt> commit -s -m "feat(anthropic): reasoning watchdog and forced attempt (#2371)"`

---

### Task 6: Docs, CHANGELOG and verification

**Files:**
- Modify:
  - `docs/adr/048-reasoning-policy.md`: add a dated amendment section. It covers: no provider budget is enforced (from the 2026-10-29 probe); the watchdog and forced attempt; the two fractions; and the fact that no budget is ever sent.
  - `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Add the CHANGELOG bullets.**
  - Added: `- **Reasoning watchdog** — runaway reasoning stops early and gets one forced attempt instead of a blind retry. (#2371)`
  - Changed: `- **agent.task / llm.call** — **public API:** \`turnDeadlineAt\` and \`reasoningWatchdog\` fields added. (#2371)`
- [ ] **Step 2: Write the ADR-048 amendment.** Cite #2371 and #1915.
- [ ] **Step 3: Run the full unit and typecheck pass.**
  - Run: `pnpm -C <wt> run typecheck`. Expected: exit 0.
  - Run: `pnpm -C <wt> exec vitest run tests/unit skills`. Expected: PASS. A known parallel-load timeout in `small-cap-models.test.ts` gets re-run alone before it counts as a failure.
- [ ] **Step 4: Run the replay gate (#2371's acceptance criterion). Ask the maintainer first, with a cost estimate of about $1.**
  - Replay the archived long-reasoning turns through the real `OpenRouterProvider.chat()` on this branch, using the 2026-10-29 replay recipe.
  - It passes if forced attempts act at least as often as plain retries and finish faster.
  - Hand-check a sample of tool calls against prod's.
  - Delete the exported prompts afterwards, because they hold principal content.
- [ ] **Step 5: Run the live Anthropic probe (#2371's acceptance criterion; under $0.10, so mention it rather than gate on it).**
  - Call `AnthropicProvider.chat()` on `claude-haiku-5-5` and `claude-sonnet-5-5` with a small tool set and a forced-attempt message appended after a short tool loop.
  - It passes if both return a `tool_use` or text response, not a 400.
- [ ] **Step 6: Commit.** `git -C <wt> commit -s -m "docs: ADR-048 amendment and changelog for the reasoning watchdog (#2371)"`
- [ ] **Step 7: After deploy, record in #1915:** how often the watchdog fired in the soak window, and the `forcedOutcome` counts (from `llm.call.reasoningWatchdog`).
