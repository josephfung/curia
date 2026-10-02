# 16 — Smoke Test Framework

**Status:** Implemented — a pass/fail release gate since #1956; CI integration and other gaps remain (see [What's Not Here Yet](#whats-not-here-yet))

---

## Overview

Curia's smoke test framework verifies end-to-end behavioral correctness of the full agent stack.
Unlike unit and integration tests, which assert on code-level contracts, smoke tests evaluate
*observable behavior*: does Curia respond the way a thoughtful executive assistant should?

The framework boots the real bus, agents, and skills against a real database — the same components
as production, minus the HTTP and CLI channels. Conversations are replayed against the live
Coordinator, and an LLM judge (GPT-4o, through OpenRouter) evaluates each response against a set of
expected behaviors authored by contributors. The run exits non-zero when any case fails the
[gate](#the-gate), and the release pre-flight in `CLAUDE.md` runs it on the production
standard-tier model.

**Why behavioral tests, not assertion tests?**
LLM outputs are not deterministic and cannot be asserted with `===`. The judge model evaluates
the *meaning* of a response rather than its exact form. This is the only practical way to
regression-test agent behavior at scale.

---

## Design Goals

1. **Real stack, not mocks** — the harness runs the same code path as production; mocked
   components would miss integration failures and prompt-induced regressions.
2. **Observable outcomes, not internal state** — behaviors describe what the user sees, not
   what was written to the DB. The judge sees the conversation, plus each turn's tool calls when a
   case sets `judge_tool_calls` (for behaviors that are actions, not replies).
3. **Contributor-friendly** — adding a test case is writing a YAML file; no code required.
4. **Regression-first** — the primary use case is catching behavioral regressions; discovery
   of new capabilities is secondary.
5. **Fail loudly on systemic errors** — a 401 or structural parse failure should abort the run,
   not silently produce a garbage score.

---

## Architecture

```
tests/smoke/
  cli.ts          — entry point: arg parsing, boot, run, judge, gate, report, exit code
  harness.ts      — headless Curia stack (real bus + components, no HTTP/CLI)
  loader.ts       — YAML test case loader with tag/name filtering
  runner.ts       — plays conversation turns against the live harness
  evaluator.ts    — sends transcripts to the GPT-4o judge and parses judgment
  gate.ts         — the pass/fail rule for a case
  report.ts       — generates self-contained HTML reports with trend charts
  types.ts        — shared types for all modules above
  cases/          — YAML test case files (the living test suite)
  results/        — JSON run results, one file per run (historical tracking)
  reports/        — HTML reports, one file per run
```

The pipeline is linear:

```
CLI args
  └─ loader: reads YAML cases, applies tag/name filters
       └─ harness: boots full Curia stack (bus, agents, skills, DB), sweeps leftovers
            └─ runner: replays turns, captures replies + tool calls, deletes each case's rows
                 └─ evaluator: sends transcripts to the GPT-4o judge (the stack's OpenRouter provider)
                      └─ gate: weighted PASS/PARTIAL/MISS per behavior → pass/fail per case
                           └─ report + results: HTML + JSON output
                                └─ harness.shutdown(), exit 1 if any case failed
```

### Harness

`createHarness()` boots the **test-mode stack** (`src/startup/test-mode-stack.ts`) and adds a
Dispatcher. The stack builds agents through `src/startup/agent-assembly.ts`, the same builder
`src/index.ts` uses, so the coordinator receives the production system prompt: identity,
security, specialist roster, autonomy band, date guardrail, contact details, turn budget and
every pinned SKILL.md body (#1966). There are no channel adapters. The headless harness
exposes a single `sendMessage()` method that publishes an `inbound.message` event to the bus
and resolves when the coordinator's `agent.response` for that `conversationId` arrives. It reads
the turn off the bus as the `system` layer (`tests/shared/turn-capture.ts`, shared with the
scenario suite), so it also records each tool call and its result, and a `NO_REPLY` or a reply
Gate C holds for a non-principal sender still ends the turn.

**Sender.** A case sends as the principal (the `smoke-test` channel, which the contact resolver
treats as a local console session) or as an `unknown` sender: `unknown-sender@example.test` by
email, with no contact record, which the Dispatcher routes in low-trust mode.

`createHarness({ model })` routes every agent to one model id. The provider follows from the
model registry, so this selects Anthropic or OpenRouter.

**Test mode cannot send.** This is by construction, not by configuration:

- The `OutboundGateway` has no Nylas, Signal, Slack or SMS client and no outbound queue, so
  every send and draft fails inside the gateway.
- Skills that call a provider directly with a declared secret (ceo-inbox → Nylas) get a
  "withheld in test mode" error. Only `TEST_MODE_PASSTHROUGH_SECRETS` (read-only lookups such
  as web search) resolve.
- Smoke usually shares the dev database with a real instance, so test mode leaves nothing that
  instance would act on. The ExecutionLayer gets no scheduler, task repo, action log,
  context-bridge, bullpen or working-docs service. Agents get read-only views of the autonomy
  score and office identity, and runtimes never write bullpen read watermarks. Tools that need a
  missing service fail with a missing-capability error.

`tests/unit/startup/test-mode-stack.test.ts` and `tests/integration/test-mode-stack.test.ts`
assert these guarantees.

**Matching production's configuration:** agents, tools and skills load as production would on
its next boot against the same database. That means the registry's enabled rows plus any core
default that has no row yet, from production's own reconcile run without writing. A live run
needs a principal contact, because production serves no agent before onboarding. The boot
header prints every difference that remains: the stack's `warnings` (unresolved pins, no vault
key) and the coordinator tools test mode refuses (`disabledTools`).

**Tool stubs (#1956):** `createHarness({ wrapExecutionLayer })` and
`createTestModeStack({ wrapExecutionLayer })` take a function that wraps the ExecutionLayer before
any agent receives it. Return a Proxy (or subclass) whose `invoke` answers stubbed tools and
delegates every other method to the real layer. `tool.invoke` / `tool.result` bus events and
the runtime's `<task_error>` formatting are unchanged. `wrapBullpenService` narrows what
runtimes read from the bullpen, and `stack.llmProviders` lets test code make its own model
calls without the stack handing out the vault key. `wrapWorkingMemory` lets the scenario suite
withhold contact recent history so a case does not inherit other runs' turns.

**Coordinator scenario suite (#1956):** `pnpm scenarios` (`tests/scenarios/`) is the sibling
of smoke for coordinator *decisions*. It uses the same test-mode stack with a fail-closed stub
layer, seeds outbound-context entries, bullpen threads and contacts as real rows scoped to
each run, asserts tool calls in code, judges prose through the stack's OpenRouter provider, and
exits non-zero when a critical behavior passes fewer than 80% of its runs. See
`tests/scenarios/README.md`.

**Timeout:** Each `sendMessage()` call waits 120 seconds by default (`SMOKE_TIMEOUT_MS`). A turn
that outlives it keeps running; its conversation rows are deleted again when it ends, and
shutdown waits up to a minute for such turns. A case with multiple turns can take several
minutes; no overall run timeout exists today (see [What's Not Here Yet](#whats-not-here-yet)).

**Shared state:** All cases within a run share one harness (and one database). Each case gets
a unique `smoke-<uuid>` (or `email:smoke-<uuid>`) conversation ID. Its conversation rows —
working memory, checkpoints, resolved entities — are deleted after the case, and the CLI sweeps
any a crashed or interrupted run left (by those prefixes) at start-up and on Ctrl-C. Contact
recent history is withheld from the coordinator's prompt. Both matter on the dev database: every
principal turn is attributed to the real principal, and recall would otherwise feed one case's
turns, or the real instance's, into the next prompt. Contacts and knowledge-graph facts a case
writes still accumulate — that reflects production's persistent knowledge base, so test cases
should not assume an empty database.

**Email/Calendar:** No Nylas or calendar client is constructed, so email and calendar tools
fail closed. Email polling never runs, so tests do not trigger on live inbox events.

### Runner

`runTestCases()` processes cases sequentially (one at a time). For each case:
- A unique `conversationId` is allocated, shaped by the case's sender.
- Each turn is sent via `harness.sendMessage()`, optionally preceded by a `delayMs` pause.
- All responses are captured as `CapturedResponse[]`, each with that turn's tool calls.
- The case's conversation rows are deleted. A cleanup failure is recorded on the case and fails it.

**Sequential execution is intentional.** Parallel execution would require multiple harness
instances or careful isolation, since the shared database could produce non-deterministic results.
See [Future Work](#future-work) for planned concurrency improvements.

### Evaluator

`evaluateCases()` sends each case's transcript to `openai/gpt-4o` through the stack's OpenRouter
provider — the scenario suite's judge, so the key stays in the vault (#911). For each case, the
judge receives:
- Who the sender is (the principal, by name, or an unknown external sender)
- Each turn's message and the assistant's response, interleaved; with `judge_tool_calls`, also the
  turn's tool calls, arguments and results (failures marked `FAILED`)
- The list of expected behaviors with their IDs, descriptions, and weights, and the failure modes
- Instructions to rate each behavior as `PASS`, `PARTIAL`, or `MISS` and provide a brief justification

Cases that did not complete are not judged. The judge is called sequentially.

**Error handling:**
- Auth, rate-limit, not-found and validation errors abort the run — they would repeat on every
  case, and an all-MISS run would read as a broken Curia
- Transient errors (provider error, timeout) are retried three times with backoff
- A judge that still fails, an unparseable reply, a skipped behavior or an invalid rating becomes
  the case's **judge error**: its behaviors score `MISS`, and the gate reports it as a judge failure,
  not a model failure

**Weighted score formula:**

```
case_score = Σ(rating_value × weight_value) / Σ(weight_value)

where:
  rating_value: PASS=1.0, PARTIAL=0.5, MISS=0.0
  weight_value: critical=3, important=2, nice-to-have=1
```

The overall run score is the unweighted average of all case scores.

### Reporting

HTML reports are self-contained (no external assets). Each report includes:
- Overall score and duration
- Per-case results with judge justification for every behavior
- Trend chart using historical scores from `tests/smoke/results/*.json`

Reports are named by ISO timestamp: `YYYY-MM-DDTHH-MM-SS-mmmZ.html`.

---

## Test Case Schema

Test cases live in `tests/smoke/cases/<name>.yaml`. Full schema:

```yaml
name: Unique Case Name          # required — globally unique across all cases
description: |                  # required — 1–2 sentences of context for the judge
  What this test verifies and why it matters.
tags: [tag1, tag2]              # required — used for filtering; see canonical tag list below
sender: principal               # optional — principal (default) | unknown
judge_tool_calls: false         # optional — show the judge each turn's tool calls and results

turns:                          # required — at least one turn
  - role: user
    content: "The message text"
    delayMs: 500                # optional — pause before this turn, simulates real pacing (ms)

expected_behaviors:             # required — at least one behavior
  - id: behavior_id             # snake_case, unique within the case
    description: |
      What the agent should do. Write as an observable outcome, not a mechanism.
    weight: critical            # critical | important | nice-to-have

failure_modes:                  # optional — negative constraints, passed to the judge
  - "Should not hallucinate a meeting time"
  - "Should not reveal internal contact IDs"
```

### Behavior Weights

| Weight | Value | Semantics |
|---|---|---|
| `critical` | 3 | Missing this behavior is a meaningful regression |
| `important` | 2 | Core expected behavior (default if omitted) |
| `nice-to-have` | 1 | Desirable, but not a bug if absent |

A case with only `critical` behaviors is strict — a single miss tanks the score. Use
`nice-to-have` for behaviors you want visibility on but wouldn't report as a bug.

### Canonical Tag List

| Tag | Used for |
|---|---|
| `briefing` | Daily briefing, meeting prep, summaries |
| `email-triage` | Inbox reading, thread summaries, urgency detection |
| `calendar` | Scheduling, event operations, timezone handling |
| `meeting-coord` | External scheduling coordination, reschedule flows |
| `contacts` | Contact lookup, identity resolution, profile recall |
| `tracking` | Follow-up tracking, promise detection |
| `proactive` | Agent-initiated behaviors (not just reactive responses) |
| `multi-turn` | Conversations requiring multiple exchanges |
| `single-turn` | One user message, one response |
| `security` | Prompt injection, spoofing, context leakage |
| `edge-case` | Unusual or tricky inputs that expose edge-case handling |

---

## Running the Suite

```bash
# Full suite
pnpm smoke

# Single case (substring match on name)
pnpm smoke --case "urgent"

# Filter by tags (comma-separated, OR semantics)
pnpm smoke --tags email-triage,briefing

# Run every agent on one model (e.g. the production standard tier — the release pre-flight)
pnpm smoke --model deepseek/deepseek-v4.1-flash
```

**Required environment variables:**
- `DATABASE_URL` — PostgreSQL connection (same DB as local dev is fine), with a principal contact
- `SECRET_ENCRYPTION_KEY` — LLM API keys are read from the vault, as at boot (#911). The
  selected model's provider key (`anthropic_api_key` / `openrouter_api_key`) must be in it, and
  `openrouter_api_key` for the judge.

**Output:**
- `tests/smoke/reports/<timestamp>.html` — human-readable report with per-behavior justifications
- `tests/smoke/results/<timestamp>.json` — machine-readable `RunResult` for historical tracking

---

## Data Types

All types are defined in `tests/smoke/types.ts`.

```typescript
// Loaded from YAML
interface TestCase {
  name: string;
  description: string;
  tags: string[];
  sender: 'principal' | 'unknown';
  judgeToolCalls: boolean;
  turns: Turn[];
  expectedBehaviors: ExpectedBehavior[];  // camelCase after YAML load
  failureModes: string[];
}

// Per-turn response from the harness
interface CapturedResponse {
  content: string;
  agentId: string;         // 'coordinator': the capture reads the coordinator's own agent.response
  durationMs: number;
  toolCalls: ObservedToolCall[];
}

// After execution, before judging
interface CaseExecution {
  testCase: TestCase;
  responses: CapturedResponse[];
  error?: string;          // set if a turn timed out or errored
  cleanupError?: string;
}

// After judging and the gate
interface CaseResult {
  testCase: TestCase;
  responses: CapturedResponse[];
  scores: BehaviorScore[];
  weightedScore: number;   // 0–1
  error?: string;
  judgeError?: string;
  cleanupError?: string;
  passed: boolean;
  failures: string[];      // why it did not pass
}

// Full run
interface RunResult {
  timestamp: string;       // ISO 8601
  model: string | null;
  commit: string;
  filtered: boolean;       // --case / --tags narrowed it
  cases: CaseResult[];
  overallScore: number;    // 0–1, unweighted average of case scores
  passed: boolean;
  durationMs: number;
}
```

---

## Scoring Summary

### The gate

`tests/smoke/gate.ts`. A case **passes** when:

- it completed (no timeout, agent error or model fallback);
- it was judged (no judge error);
- its conversation rows were cleaned up;
- its weighted score is **≥ 80%** (`CASE_PASS_THRESHOLD`);
- no `critical` behavior is rated `MISS`.

The weighted score alone is not enough: five critical PASSes and one critical MISS score 83%,
and a critical behavior is by definition one whose absence is a regression.

The **run passes** when every case passes; otherwise the CLI prints each failing case with its
reasons and exits `1`. A run narrowed by `--case` / `--tags` is labelled as such and is not a
release result. Results JSON records the model, the commit the run started on, and `passed`.

Each case runs **once**. A case that passes only some of the time will fail releases at random,
so a new case should be run several times before it lands. For behaviors that need repeated runs
and a pass-rate threshold, use the scenario suite.

---

## Known Constraints

- **Shared database state** — all cases in a run share one database; test cases cannot assume a clean slate. Cases should be written to work against a populated knowledge base.
- **Non-determinism** — LLM outputs vary between runs. A test case with tightly worded behaviors may flip between `PASS` and `PARTIAL` across runs. Prefer behaviors that describe structural outcomes ("includes two options") over wording-dependent ones ("says 'I can help with that'").
- **Judge model dependency** — the judge is `openai/gpt-4o` through OpenRouter. If OpenRouter is unavailable, the evaluation phase fails.
- **Test mode can't reach the outside world** — email, calendar, scheduler, task, document and human-channel tools fail closed. A case about them tests what Curia does when they fail; decisions that need those tools to succeed belong in the scenario suite, where results are stubbed.
- **No case-level parallelism** — cases run sequentially; a 34-case run against the full stack takes several minutes.

---

## Known Deficiencies

- **Anthropic retry/backoff** — no rate limit retry with backoff inside `AnthropicProvider`.
- **Judge rate-limit retry** — a judge rate limit aborts the run; transient errors are retried.
- **CI integration** — no DB isolation + secrets wiring for CI. (#545)
- **Score-trend alerting** — no alerting on score regression between runs.
- **Configurable judge model** — no `--judge-model` flag.
- **Per-case timeout** — no per-case run timeout / circuit breaker.
- **Selective re-run** — no re-run of failures from a prior results file.
- **Parallel execution** — no parallel case execution with schema isolation.

---

## What's Not Here Yet

This section tracks the known gaps. Items are listed in rough priority order.

### Rate Limiting — Anthropic API

**The most pressing gap.** Sequential case execution against the real Claude API hits Anthropic
rate limits when running full suites or running locally alongside other workloads. When a
`429 Too Many Requests` response arrives from Anthropic during a case, the agent currently
fails the turn entirely rather than retrying.

Needed:
- Per-case (or per-turn) configurable delay between Anthropic calls (`--delay-ms` flag or config)
- Exponential backoff with jitter on `429` responses inside `AnthropicProvider`
- Distinguish "transient rate limit" from "sustained overload" — transient should retry, not abort
- Optionally: a `--concurrency 1` mode that adds a floor delay between cases (default 0ms)

Until this is implemented, running the full 34-case suite reliably requires either running at
off-peak times or breaking the suite into smaller filtered runs.

### Rate Limiting — Judge

Transient judge errors are retried, but a rate limit (`RATE_LIMIT`) aborts the run, discarding
all execution results. Needed: retry with backoff before abort.

### CI Integration

Smoke tests are not yet run in CI; the release pre-flight runs them by hand. Blockers:
1. Rate limit reliability (above)
2. A CI-appropriate database fixture (separate DB or schema isolation per run)
3. Secrets provisioning in the CI environment

### Score-Trend Alerting

Historical scores are written to `tests/smoke/results/*.json` and rendered as a trend chart in
the HTML report, but no alert fires when the score drops significantly between runs.

Needed: compare current `overallScore` to the last N runs and warn (or fail) if the delta
exceeds a configurable threshold (e.g., `--regression-threshold 10` to fail on a >10pp drop).

### Configurable Judge Model

`JUDGE_MODEL = 'openai/gpt-4o'` is hardcoded in `tests/scenarios/judge.ts` (shared with the
scenario suite, so scores stay comparable). There is no override for a cheaper model during fast
iteration. Future: a `--judge-model <model-id>` flag.

### Per-Case Run Timeout

There is no overall run timeout. A single hanging turn (e.g., a skill that never responds) will
stall the entire suite indefinitely after the per-`sendMessage` 120-second timeout fires for each
turn in that case. Needed: a per-case wall-clock timeout and a run-level circuit breaker.

### Selective Re-run of Failures

After a run, the operator must manually note which cases failed and pass `--case` filters to
re-run them. Needed: a `--rerun-failures <results-file>` flag that automatically filters to
cases that scored below the threshold in a prior run.

### Parallel Case Execution

Sequential execution is safe but slow. Parallel execution is possible if each worker gets its
own isolated harness instance and database schema. This would require:
- Schema-per-run isolation in Postgres (or in-memory Postgres for CI)
- Multiple harness instances (one per worker)
- A task queue distributing cases to workers

Not prioritized until the rate limit and CI gaps are closed.

---

## Implementation Notes for Future Work

### Anthropic Rate Limit Retry (recommended approach)

The right place to implement retry is inside `AnthropicProvider`, not in the harness or runner.
`AgentRuntime` calls `provider.complete()` and expects either a result or an error. A provider
that transparently retries on `429` is invisible to the rest of the stack and benefits production
as well.

Pseudocode:
```typescript
async complete(params): Promise<AgentResponse> {
  const maxRetries = 3;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await this.client.messages.create(params);
    } catch (err) {
      if (isRateLimitError(err)) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500; // exp backoff + jitter
        await sleep(delay);
        lastError = err;
        continue;
      }
      throw err; // non-rate-limit errors propagate immediately
    }
  }
  throw lastError;
}
```

The inter-case delay for the runner (separate from provider-level retry) can be a simpler
`--delay-ms <ms>` CLI flag that inserts a `setTimeout` between cases in `runTestCases()`.

### Judge Rate Limit Retry

Same pattern as above but in `evaluateCases()`. The evaluator already retries transient errors;
the change is to treat `RATE_LIMIT` as retryable with a longer backoff before aborting.

### Schema Isolation for CI

For CI, each run should operate in an isolated Postgres schema:
1. Create a schema named after the run ID before booting the harness
2. Run migrations into that schema
3. Pass the schema name as a `search_path` option to the pool
4. Drop the schema after the run completes (or on a cron schedule for cleanup)

This allows multiple CI jobs to run smoke tests in parallel against the same database server
without interfering with each other.
