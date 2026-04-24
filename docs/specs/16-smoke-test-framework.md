# 16 — Smoke Test Framework

**Status:** Implemented — core pipeline complete; several gaps remain (see [What's Not Here Yet](#whats-not-here-yet))

---

## Overview

Curia's smoke test framework verifies end-to-end behavioral correctness of the full agent stack.
Unlike unit and integration tests, which assert on code-level contracts, smoke tests evaluate
*observable behavior*: does Curia respond the way a thoughtful executive assistant should?

The framework boots the real bus, agents, and skills against a real database — the same components
as production, minus the HTTP and CLI channels. Conversations are replayed against the live
Coordinator, and an LLM judge (currently GPT-4o) evaluates each response against a set of
expected behaviors authored by contributors.

**Why behavioral tests, not assertion tests?**
LLM outputs are not deterministic and cannot be asserted with `===`. The judge model evaluates
the *meaning* of a response rather than its exact form. This is the only practical way to
regression-test agent behavior at scale.

---

## Design Goals

1. **Real stack, not mocks** — the harness runs the same code path as production; mocked
   components would miss integration failures and prompt-induced regressions.
2. **Observable outcomes, not internal state** — behaviors describe what the user sees, not
   which skills were called or what was written to the DB. The judge has no access to internal state.
3. **Contributor-friendly** — adding a test case is writing a YAML file; no code required.
4. **Regression-first** — the primary use case is catching behavioral regressions; discovery
   of new capabilities is secondary.
5. **Fail loudly on systemic errors** — a 401 or structural parse failure should abort the run,
   not silently produce a garbage score.

---

## Architecture

```
tests/smoke/
  cli.ts          — entry point: arg parsing, boot, run, judge, report
  harness.ts      — headless Curia stack (real bus + components, no HTTP/CLI)
  loader.ts       — YAML test case loader with tag/name filtering
  runner.ts       — plays conversation turns against the live harness
  evaluator.ts    — sends transcripts to GPT-4o and parses judgment
  report.ts       — generates self-contained HTML reports with trend charts
  types.ts        — shared types for all modules above
  cases/          — 34+ YAML test case files (the living test suite)
  results/        — JSON run results, one file per run (historical tracking)
  reports/        — HTML reports, one file per run
```

The pipeline is linear:

```
CLI args
  └─ loader: reads YAML cases, applies tag/name filters
       └─ harness: boots full Curia stack (bus, agents, skills, DB)
            └─ runner: replays turns, captures responses
                 └─ harness.shutdown()
                      └─ evaluator: sends transcripts to GPT-4o judge
                           └─ scoring: weighted PASS/PARTIAL/MISS per behavior
                                └─ report + results: HTML + JSON output
```

### Harness

`createHarness()` boots the same component graph as `src/index.ts`, skipping only the
channel adapters that poll for external input (HTTP, CLI, Email polling). The headless harness
exposes a single `sendMessage()` method that publishes an `inbound.message` event to the bus
and resolves when the matching `outbound.message` arrives for that `conversationId`.

**Timeout:** Each `sendMessage()` call has a hard 60-second timeout. A case with multiple turns
can take several minutes; no overall run timeout exists today (see [What's Not Here Yet](#whats-not-here-yet)).

**Shared state:** All cases within a run share one harness (and one database). Each case gets
a unique `smoke-<uuid>` conversation ID to prevent cross-contamination at the conversation level.
Memory, contacts, and knowledge graph accumulate across the run — this is intentional, as it
reflects how the system operates in production (with a persistent knowledge base). Test cases
should not assume an empty database.

**Email/Calendar:** The NylasClient is initialized if credentials are present in the environment,
enabling email and calendar skills. Email polling is intentionally skipped during smoke runs —
the email adapter is not registered — so tests do not trigger on live inbox events.

### Runner

`runTestCases()` processes cases sequentially (one at a time). For each case:
- A unique `conversationId` is allocated.
- Each turn is sent via `harness.sendMessage()`, optionally preceded by a `delayMs` pause.
- All responses are captured as `CapturedResponse[]`.

**Sequential execution is intentional.** Parallel execution would require multiple harness
instances or careful isolation, since the shared database could produce non-deterministic results.
See [Future Work](#future-work) for planned concurrency improvements.

### Evaluator

`evaluateCases()` sends each case's full transcript to GPT-4o for judgment. For each case,
the judge receives:
- The full conversation transcript (all user turns and all assistant responses)
- The list of expected behaviors with their IDs, descriptions, and weights
- Instructions to rate each behavior as `PASS`, `PARTIAL`, or `MISS` and provide a brief justification

The judge is called sequentially to avoid hammering the OpenAI API. Temperature is set to 0.1
for near-deterministic scoring.

**Error handling:**
- Auth failures (401/403): abort the run immediately — a misconfigured key would corrupt all scores
- Rate limit (429): abort the run — the operator should wait and retry
- Per-case failures: fall back to all-MISS for that case, emit a stderr warning, continue

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
```

**Required environment variables:**
- `DATABASE_URL` — PostgreSQL connection (same DB as local dev is fine)
- `ANTHROPIC_API_KEY` — for the real Coordinator and skill execution
- `OPENAI_API_KEY` — for the GPT-4o judge

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
  turns: Turn[];
  expectedBehaviors: ExpectedBehavior[];  // camelCase after YAML load
  failureModes: string[];
}

// Per-turn response from the harness
interface CapturedResponse {
  content: string;
  agentId: string;         // always 'coordinator' today — see TODO in runner.ts
  durationMs: number;
}

// After execution, before judging
interface CaseExecution {
  testCase: TestCase;
  responses: CapturedResponse[];
  error?: string;          // set if all turns timed out or the harness threw
}

// After judging
interface CaseResult {
  testCase: TestCase;
  responses: CapturedResponse[];
  scores: BehaviorScore[];
  weightedScore: number;   // 0–1
  error?: string;
}

// Full run
interface RunResult {
  timestamp: string;       // ISO 8601
  cases: CaseResult[];
  overallScore: number;    // 0–1, unweighted average of case scores
  durationMs: number;
}
```

---

## Scoring Summary

| Score | Label | Meaning |
|---|---|---|
| ≥ 80% | `PASS` | Case meets expectations |
| 40–79% | `PARTIAL` | Case partially meets expectations |
| < 40% | `FAIL` | Case significantly misses expectations |

These labels appear in the CLI summary output. **No pass threshold is currently enforced** — the
run exits 0 regardless of score. See [What's Not Here Yet](#whats-not-here-yet).

---

## Known Constraints

- **Shared database state** — all cases in a run share one database; test cases cannot assume a clean slate. Cases should be written to work against a populated knowledge base.
- **Non-determinism** — LLM outputs vary between runs. A test case with tightly worded behaviors may flip between `PASS` and `PARTIAL` across runs. Prefer behaviors that describe structural outcomes ("includes two options") over wording-dependent ones ("says 'I can help with that'").
- **Judge model dependency** — the framework requires `OPENAI_API_KEY`. If OpenAI is unavailable, the entire evaluation phase fails.
- **No case-level parallelism** — cases run sequentially; a 34-case run against the full stack takes several minutes.

---

## Implementation Status

| Item | Status |
|---|---|
| Harness — boots real bus, agents, skills, DB; exposes `sendMessage()` | Done |
| Loader — YAML test case parsing with tag/name filtering | Done |
| Runner — sequential turn replay against live harness | Done |
| Evaluator — GPT-4o judge with weighted PASS/PARTIAL/MISS scoring | Done |
| Reporter — self-contained HTML reports with trend charts | Done |
| Test cases — 34+ YAML case files covering core behaviors | Done |
| CLI entry point (`pnpm smoke`, `--case`, `--tags` flags) | Done |
| Per-`sendMessage` 60-second timeout | Done |
| `agentId` captured from bus events (not hardcoded) | Not Done — hardcoded to `'coordinator'` |
| Anthropic API rate limit retry with backoff inside `AnthropicProvider` | Not Done |
| OpenAI judge rate limit retry before abort | Not Done |
| Exit code enforcement (`--pass-threshold` flag, exit 1 on failure) | Not Done |
| CI integration (exit codes + DB isolation + secrets) | Not Done |
| Score-trend alerting on regression between runs | Not Done |
| Configurable judge model (`--judge-model` flag) | Not Done |
| Per-case run timeout / circuit breaker | Not Done |
| Selective re-run of failures from prior results file | Not Done |
| Parallel case execution with schema isolation | Not Done |

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

### Rate Limiting — OpenAI Judge

The evaluator already aborts on `429` from the judge model rather than silently scoring zero.
However, there is no retry logic — a transient rate limit during judging aborts the entire
evaluation phase and discards all execution results. Needed: retry with backoff before abort.

### Exit Code Enforcement

The run currently exits `0` regardless of overall score. CI pipelines cannot use the smoke suite
as a gate without a configurable pass threshold.

Needed: `--pass-threshold <0–100>` flag; exit `1` if `overallScore < threshold`.

### CI Integration

Smoke tests are not yet run in CI. Blockers:
1. Exit code enforcement (above)
2. Rate limit reliability (above)
3. A CI-appropriate database fixture (separate DB or schema isolation per run)
4. Secrets provisioning in the CI environment

### Agent ID Capture

`runner.ts` has a `// TODO: capture actual agent from bus events` comment. The `agentId` field
in `CapturedResponse` is hardcoded to `'coordinator'`. When multi-agent delegation is exercised
in a test, the report cannot show which agent produced which turn of the response.

Fix: subscribe to `agent.response` events on the bus and correlate by `conversationId`/`taskId`
to populate `agentId` correctly.

### Score-Trend Alerting

Historical scores are written to `tests/smoke/results/*.json` and rendered as a trend chart in
the HTML report, but no alert fires when the score drops significantly between runs.

Needed: compare current `overallScore` to the last N runs and warn (or fail) if the delta
exceeds a configurable threshold (e.g., `--regression-threshold 10` to fail on a >10pp drop).

### Configurable Judge Model

`JUDGE_MODEL = 'gpt-4o'` is hardcoded in `evaluator.ts`. There are two gaps here:

1. **No override** — cannot use a cheaper model (e.g., `gpt-4o-mini`) for fast iteration runs
2. **OpenAI dependency** — contributors who want to avoid OpenAI have no alternative

Future: a `--judge-model <model-id>` flag and, eventually, support for Claude as the judge
(which would eliminate the `OPENAI_API_KEY` requirement).

### Per-Case Run Timeout

There is no overall run timeout. A single hanging turn (e.g., a skill that never responds) will
stall the entire suite indefinitely after the per-`sendMessage` 60-second timeout fires for each
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

Same pattern as above but in `evaluateCases()`. The evaluator already distinguishes `429` from
other errors (it aborts); the change is to retry up to N times with backoff before aborting.

### Schema Isolation for CI

For CI, each run should operate in an isolated Postgres schema:
1. Create a schema named after the run ID before booting the harness
2. Run migrations into that schema
3. Pass the schema name as a `search_path` option to the pool
4. Drop the schema after the run completes (or on a cron schedule for cleanup)

This allows multiple CI jobs to run smoke tests in parallel against the same database server
without interfering with each other.
