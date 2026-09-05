# 05 — Error Recovery

*This section is heavily informed by Zora's gap analysis (ERR-01 through ERR-12) and its competitive analysis of error recovery patterns. Error recovery is what separates toy agents from production systems.*

## Principle

**Errors are input to the next attempt, not chain-breakers.** Every failure preserves context, and the system learns from repeated failures rather than retrying blindly.

---

## Layer 1: Error Budgets

Every agent task has a hard budget that prevents infinite loops and runaway costs:

```yaml
# In agent config
error_budget:
  max_turns: 20          # max LLM round-trips per task execution
  max_cost_usd: 1.00     # max dollar spend per task execution
  max_errors: 5           # max consecutive errors before aborting
```

**Enforcement:**
- The agent runtime tracks turns, cost, and consecutive errors per task
- When a budget is exceeded, the task is aborted with a structured error
- For persistent tasks (burst execution), budgets are per-burst, with a separate lifetime budget on the task record
- Budget state is persisted in working memory — survives restarts
- Auth errors (401/403) count double against the error budget and are never retried (they won't self-heal)

---

## Layer 2: State Continuity

*Lesson from Zora: reconstructing context from scratch after a failure is fragile and lossy. Resume with the full TaskContext instead.*

When an error occurs during agent execution:

1. **Preserve full context** — the agent's working memory (conversation turns, intermediate results, tool outputs) is already in Postgres. Nothing is lost.
2. **Inject error context** — the error is added to the conversation as a structured message, not a raw string:
   ```
   <task_error>
     <tool>email-parser</tool>
     <error_type>TIMEOUT</error_type>
     <message>Nylas API request timed out after 30s</message>
     <attempt>2 of 3</attempt>
     <suggestion>Consider using a different mailbox or retrying later</suggestion>
     <reporting_constraint>This call did not succeed. Do not state or imply to the user that this action was completed unless a later attempt at it succeeds. Work that did succeed in this turn may be reported normally.</reporting_constraint>
   </task_error>
   ```
   <!-- TODO: Evaluate TOON (Token-Oriented Object Notation) as a more token-efficient
        alternative to XML for this structured block. See #55. -->
3. **Resume, don't restart** — the LLM sees the full history including the error, and can make an informed decision: retry with different parameters, try an alternative skill, or report to the user.

### Action-reporting honesty (#1546)

A failed tool call must not be reported to the user as a completed action. In the
incident behind #1546 the coordinator called `resolve-learning-digest`, got
`success: false`, and thirteen seconds later told the CEO "Got it — I've noted the
dismissal." The item stayed pending.

**This was not a missing-information failure.** The `<task_error>` block was in
context with `is_error: true` when the reply was written. The model had the
evidence and did not weight it — an attention failure, not a knowledge gap.

**Mechanism: `<reporting_constraint>`, carried by every `<task_error>`.** The
constraint states the rule at the point of maximum salience — the last line of the
error block, immediately before generation resumes — instead of relying on a rule
several hundred lines up in the system prompt. It is scoped in two directions: a
later successful attempt at the same action is reportable as success, and other
work in the same turn is unaffected. Both carve-outs matter; a blanket "never
claim success" rule suppresses honest reporting of the work that did land.

`coordinator.yaml` carries a matching prose rule. Prompt and constraint are the
same control at two altitudes, not a primary and a backstop.

**There is no outbound truthfulness gate, by design.** The two-stage outbound
filter (`src/dispatch/outbound-filter.ts`) is a *disclosure* control — Stage 2
returns `{"leak": true|false}` and Stage 2.5 classifies tier-sensitive disclosure.
Neither evaluates whether a claim is true, for any recipient. Its
principal-sole-recipient bypass is correct for that purpose and is not a coverage
gap in honesty.

A runtime guard that inspected the finished reply and rewrote suspected
success-claims was built and rejected (#1579). Detecting a false success claim
means classifying English prose, and the words that carry the claim — "noted",
"done", "confirmed", "completed" — are also ordinary state description ("standup
confirmed", "4 tasks completed") and plain acknowledgement ("noted — I'll hold
off"). A keyword rule fired on roughly 40% of honest replies in a turn that had
any tool failure, and because the guard replaced the whole reply it destroyed
correct content on every false positive: a turn that returned the CEO's schedule
and honestly flagged one failed sync became "I wasn't able to complete that."
Prevention at generation time is cheaper and has no such failure mode. Revisit
only with production evidence that the constraint is insufficient, and prefer
a correction that adds to the reply over one that replaces it.

**Root cause of the incident itself** was a skill contract violation, fixed
separately in #1545: `resolve-learning-digest`'s manifest advertised
`task_id` as "full UUID or unique prefix", but the handler did an exact-key
lookup. The coordinator supplied the documented short prefix and the call failed.

Prod forensic: conversation `email:19f843bdadc2eb85`, `2026-07-21T13:11Z`.

### Progress Extraction

*Lesson from Zora: when a long-running task fails mid-way, don't lose what was accomplished.*

Before aborting a task (budget exceeded, unrecoverable error), the agent runtime:
1. Summarizes what was accomplished (from working memory)
2. Stores the summary in the task record's `progress` field
3. Includes the summary in the error notification to the user

This means a research task that completed 7 of 10 subtasks before failing can be resumed from subtask 8, not from scratch.

---

## Layer 3: Error Pattern Detection

*Lesson from Zora: retrying the same failing operation with the same parameters is waste.*

### Per-Task Pattern Detection

The agent runtime maintains a sliding window of the last 10 tool invocations per task. If the same tool + similar arguments produce the same error type 3 times:

1. **Inject a steering hint** into the next LLM call: "Tool X has failed 3 times with error Y. Consider an alternative approach."
2. **Log the pattern** to the audit log
3. **Do not block the agent** — the LLM may have a valid reason to retry (e.g., transient network issue)

### Cross-Task Error Learning (Future)

A `known_failures` table records tool + error-type combinations that consistently fail across tasks. When an agent is about to invoke a tool that has a known failure pattern, the runtime injects a warning. This prevents different agents from hitting the same broken tool repeatedly.

**Not yet implemented:** Per-task pattern detection (sliding window of last 10 tool invocations) is not yet built — the runtime tracks `consecutiveErrors` against the error budget, but has no sliding-window tool-pattern logic. Cross-task learning (`known_failures` table) is also not yet implemented. Both are planned for a future iteration.

---

## Per-Layer Failure Handling

### LLM Call Failures

| Failure Type | Action |
|---|---|
| Rate limit (429) | Retry with backoff: 1s, 5s, 15s. Respect `Retry-After` header. |
| Timeout | Retry once with 2x timeout. If still fails, try fallback provider. |
| Auth error (401/403) | Do NOT retry. Publish `agent.error`. Count double against error budget. |
| Server error (500/502/503) | Retry with backoff (3 attempts). Then try fallback provider. |
| All providers fail | Publish `agent.error`. Dispatch notifies user: "I wasn't able to process that." |
| Malformed response | Log the raw response. Retry once. If still malformed, publish `agent.error`. |

### Skill Invocation Failures

- Skills return structured results: `{ success: true, data }` or `{ success: false, error }`
- The agent LLM sees the error and decides how to proceed (retry, alternative skill, or report)
- Skill timeouts (from `tool.json`) trigger an automatic failure result — no hanging
- MCP server disconnections: mark the server's tools as unavailable, notify agent, try reconnecting in background

### Channel Adapter Failures

- Each adapter implements reconnection with exponential backoff (see [04-channels.md](04-channels.md))
- If an adapter can't reconnect: publishes `channel.disconnected`, stops, health endpoint reports it
- Outbound messages for queueable channels (Signal, Slack, SMS, email — `Channel.supportsOutboundQueue`) are queued in Postgres (max 100 per channel, 24h TTL) both when the transport is unavailable and when a send hits a transient provider failure (timeout, HTTP 429/5xx, network error — `queueable: true`). Queued messages flush in order on `channel.reconnect`; when the channel is still up, a scheduled timer retry (~30s, notably SMS) drains them (#1380). Voice does not queue.

### Scheduled Job Failures

- Failed jobs are marked `status: failed` with error details in `last_error`
- Recurring jobs continue on their next schedule despite failures (don't block the cron)
- After 3 consecutive failures, the job is marked `status: suspended` and the user is notified via the alert channel
- Manual resume: user can unsuspend via CLI or HTTP API

### Database Unavailable

- The framework requires Postgres at startup — fails fast with a clear error if unreachable
- During operation:
  - **Critical paths** (write-ahead audit insert, working-memory load/persist, bus publish that depends on audit) fail fast with a retryable `DATABASE_UNAVAILABLE` `AgentError` — no silent hangs (`connectionTimeoutMillis` on the pool)
  - **Non-critical paths** (audit acknowledgement, working-memory summary *persistence*) retry with bounded exponential backoff via `withDbRetry`. Skill handlers are **not** retried wholesale (side-effect duplication risk) — they classify the fault and return `{ success: false, errorType: 'DATABASE_UNAVAILABLE' }`
- Task error budgets track DB failures on a separate `dbFailures` counter — temporary outages do **not** burn `consecutiveErrors`
- The health endpoint detects DB connectivity issues immediately (`checkDb`)
- `DbAvailabilityMonitor` probes every 30s; after **>5 minutes** of continuous unavailability it escalates to the CEO via `outbound.notification` (`database_unavailable`), retrying until delivery succeeds (typically once Postgres recovers)

---

## Resilience Patterns

Beyond per-layer failure handling, several subsystems ship with targeted resilience patterns.
A recurring theme: **state that controls whether work re-runs is managed in code, not by the
LLM** — an LLM-managed watermark or counter can hallucinate a value and either skip work or
re-do it.

### Channel poll watchdog (`channel.stalled`)

The email adapter persists its poll high-water mark in code (via `ConfigStore`) and runs a
watchdog on each tick. If no successful poll completes within `5 × pollingIntervalMs`, it emits
a `channel.stalled` audit event (at most once per adapter lifecycle) so a silently wedged poll
loop becomes visible to operators. See [spec 04 — Channels](04-channels.md).

### Duplicate outbound suppression (#847)

When an agent's `agent.response` would translate into an outbound message, the dispatcher
suppresses it if a human-facing reply (`email-reply` / `email-send`) has already shipped for the
same routing task. The suppression emits an `outbound.suppressed_duplicate` audit event with
reason `'human_reply_already_sent'`, preventing the principal (or an external recipient) from
receiving the same content twice.

### Explicit no-reply (#1732, #1734)

Silence is a first-class outcome. Dispatch publishes `outbound.no_reply` instead of
`outbound.message` when:

- the agent's entire response is the sentinel `NO_REPLY` (optional wrapping quotes,
  backticks, markdown fence, or trailing punctuation), or
- `AgentResponsePayload.suppressDelivery` is set (the runtime lifts the sentinel out of
  `content` before publish so scheduler summaries and working-memory turns never store
  a control token), or
- the response is whitespace-only (`empty_response` — a blank email is not a reply), or
- the response is a near-miss (starts with the token plus prose, or contains it as a
  standalone word) — `ambiguous_decline`, send suppressed, email draft salvaged, or
- inbound email was classified as **auto-generated** from message signals (headers,
  explicit calendar `method=REPLY`/`CANCEL`, OOO subject, etc.) and the agent still
  produced relay text — `auto_generated`. Dispatch always creates `agent.task` for
  non-principal auto-generated mail (so bounce/payment/security/deadline can still
  escalate) but suppresses the relay. Principal-originated mail that merely *looks*
  auto-generated (e.g. a forwarded OOO) is dispatched normally. Body-keyword
  "carve-outs" do not select a privileged path at dispatch. When the agent
  returns `NO_REPLY`, the audit reason is `agent_declined` (preamble worked);
  when it narrates a reply the backstop catches, the reason is `auto_generated`
  with the narrated body on `abandonedContent` — so "how often does the
  coordinator ignore the preamble" is answerable from the audit log.

This is distinct from `outbound.suppressed_duplicate`: the reply-lock fires after a
human-facing skill already succeeded; no-reply means this turn sent nothing.

The content-block rewrite prompt (#1355) offers the same sentinel as an abandon-send
option. Exact `NO_REPLY` on a rewrite task does **not** salvage a draft: a draft is an
invitation to send the blocked text, and the point of abandon is that the message should
not exist. The blocked body is copied into `outbound.no_reply.abandonedContent` so it is
recoverable from the audit row without a log dig. The `outbound.blocked` CEO notification
at block time remains the human-visible signal.

The sentinel is interpreted by the agent runtime (to set `suppressDelivery` and blank
content) and by dispatch (to skip the send). Other `agent.response` subscribers must not
parse `content` for the token.

A live principal turn that declines is still honoured (the CEO saying "thanks" and Curia
correctly saying nothing is a real case) but dispatch publishes `outbound.notification`
(`no_reply_principal`) so silence toward the principal is not invisible. Prompt-only
"do not use NO_REPLY with the CEO" remains as guidance; the notification is the
code-level guard.

Use `NO_REPLY` when nothing should go out (automated notification, archive-only FYI).
Do not narrate that decision — narration that does not start with the token is still
payload. Near-miss narration that *does* start with the token is salvaged, not sent.

### Triage watermark moved to code (#866)

The ceo-inbox triage `last_processed_at` watermark is managed in code (via `ConfigStore`) rather
than by the LLM. Future timestamps are clamped to `now()` so a bad value cannot push the watermark
ahead and cause messages to be skipped on the next run.

### Contacts promotion sweep batching (#884)

The provisional-contact promotion sweep is batched to 10 contacts per run using offset pagination,
with the cursor persisted in `last_run_context` so successive runs advance through the backlog
without re-scanning. The contacts agent's `error_budget` is raised to 30 turns to accommodate the
batched work. See [spec 09 — Contacts & Identity](09-contacts-and-identity.md).

### Provider model fallback (#813)

When OpenRouter (or another provider) removes a model from its catalog, every agent
using that tier starts returning `NOT_FOUND` errors until the operator manually remaps
the tier — typically hours later, with silent `agent.error` accumulation in between.

The runtime handles this transparently: on a `NOT_FOUND` response from the primary
model, it automatically re-routes to the **fallback tier's** model before surfacing
the error. Fallback rules are fixed and require no configuration:

| Primary tier | Fallback tier |
|---|---|
| `fast` | `standard` |
| `standard` | `powerful` |
| `powerful` | `standard` |

When the fallback succeeds, the agent completes normally and the caller sees no error.
If the fallback also fails, the fallback's error is surfaced (not the original NOT_FOUND).

Fallback engagement is always logged: a pino `warn` fires immediately, and a durable
`model.fallback` bus event is written to the audit log with the agent ID, tier, failed
model, fallback model, and reason. This gives operators a grep-able signal without
requiring an emergency page. The `model.fallback` event appears in the audit dashboard
alongside `llm.call` events so the pattern is visible at a glance.

**Out of scope:** only `NOT_FOUND` triggers fallback. `AUTH_FAILURE`, `VALIDATION_ERROR`,
and other non-retryable errors still fail hard — they indicate caller or config problems,
not model availability.

---

## Error Classification

*Lesson from Zora: string-matching error messages for classification is fragile.*

All errors are normalized into a structured `AgentError` type:

```typescript
interface AgentError {
  type: ErrorType;          // discriminated union, not a string
  source: string;           // which component (provider, skill, channel)
  message: string;          // human-readable description
  retryable: boolean;       // can this be retried?
  context: Record<string, unknown>;  // structured metadata
  timestamp: Date;
}

type ErrorType =
  | 'AUTH_FAILURE'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PROVIDER_ERROR'
  | 'DATABASE_UNAVAILABLE'  // Postgres / pool unreachable — retryable (#1381)
  | 'SKILL_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'UNKNOWN';
```

Provider-specific errors are mapped to `ErrorType` inside the provider implementation — never leaked as raw strings to the agent runtime. This prevents the fragile string-matching pattern Zora suffered from. Database connection failures (pg SQLSTATE class `08` / `57P0x`, Node `ECONNREFUSED` / `ETIMEDOUT`, pool acquire timeouts) map to `DATABASE_UNAVAILABLE` rather than `PROVIDER_ERROR`.

---

## The "Never Swallow" Rule

*Lesson from Zora: 6+ silent failure points (empty catch blocks) caused invisible production issues.*

**Every `catch` block in the framework must:**
1. Log the error with full context (structured, via pino)
2. Emit to the audit log
3. Either re-throw, return a structured error, or publish an error event
4. Never: empty catch `{}`, `catch(e) { /* ignore */ }`, or `catch(e) { console.log(e) }`

This is enforced by code review convention. A lint rule (`no-empty-catch` + custom rule requiring structured error handling) is planned but not yet implemented.

---

## Known Deficiencies

- **`max_cost_usd` tracking** — error budget dimension for per-task cost is not yet implemented.
- **Progress extraction before aborting** — summary stored in task record is not yet implemented.
- **Per-task error pattern detection** — sliding window of last 10 tool invocations is not yet implemented.
- **Cross-task `known_failures` table** — data collection for future warnings is not yet implemented.
- **`no-empty-catch` ESLint rule** — the "Never Swallow" rule is enforced by convention only; the rule is absent from `eslint.config.js`.

Outbound messages for queueable channels (Signal, Slack, SMS, email — see `Channel.supportsOutboundQueue`) are persisted in Postgres (max 100 per channel, 24h TTL) both while the transport is unavailable and on transient provider failures (timeout, HTTP 429/5xx, network error — `queueable: true`). They flush in order on `channel.reconnect`, or via a scheduled ~30s timer retry when the channel is still up (notably SMS) (#1380). Voice does not queue.
