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
   </task_error>
   ```
   <!-- TODO: Evaluate TOON (Token-Oriented Object Notation) as a more token-efficient
        alternative to XML for this structured block. See #55. -->
3. **Resume, don't restart** — the LLM sees the full history including the error, and can make an informed decision: retry with different parameters, try an alternative skill, or report to the user.

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

**For launch:** Per-task pattern detection is implemented. Cross-task learning is stored (the table exists) but not actively used for warnings — it's data collection for future use.

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
- Skill timeouts (from `skill.json`) trigger an automatic failure result — no hanging
- MCP server disconnections: mark the server's tools as unavailable, notify agent, try reconnecting in background

### Channel Adapter Failures

- Each adapter implements reconnection with exponential backoff (see [04-channels.md](04-channels.md))
- If an adapter can't reconnect: publishes `channel.disconnected`, stops, health endpoint reports it
- Outbound messages to a disconnected channel are queued in Postgres (max 100 per channel). When the channel reconnects, queued messages are delivered in order.

### Scheduled Job Failures

- Failed jobs are marked `status: failed` with error details in `last_error`
- Recurring jobs continue on their next schedule despite failures (don't block the cron)
- After 3 consecutive failures, the job is marked `status: suspended` and the user is notified via the alert channel
- Manual resume: user can unsuspend via CLI or HTTP API

### Database Unavailable

- The framework requires Postgres at startup — fails fast with a clear error if unreachable
- During operation: DB failures in non-critical paths (e.g., audit write) are retried with backoff
- DB failures in critical paths (e.g., loading agent config, reading working memory) bubble up as `agent.error`
- The health endpoint detects DB connectivity issues immediately

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
  | 'SKILL_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'UNKNOWN';
```

Provider-specific errors are mapped to `ErrorType` inside the provider implementation — never leaked as raw strings to the agent runtime. This prevents the fragile string-matching pattern Zora suffered from.

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

## Implementation Status

| Item | Status |
|---|---|
| Error budget: `max_turns` tracking per task | Done |
| Error budget: `max_errors` (consecutive errors) tracking per task | Done |
| Error budget: `max_cost_usd` tracking per task | Not Done |
| State continuity: structured `<task_error>` XML injection into conversation | Done |
| Progress extraction before aborting (summary stored in task record) | Not Done |
| Per-task error pattern detection (sliding window of last 10 tool invocations) | Not Done |
| Cross-task `known_failures` table (data collection for future warnings) | Not Done |
| LLM call failure handling: rate limit retry with backoff | Done |
| LLM call failure handling: timeout retry, auth error no-retry | Done |
| LLM call failure handling: server error retry, fallback provider | Done |
| Skill invocation failure handling (structured results, timeout) | Done |
| Channel adapter failure handling: reconnection with exponential backoff | Partial — Signal only; email uses polling model |
| Channel adapter failure handling: outbound message queue (max 100) for disconnected channels | Not Done |
| Scheduled job failure handling (suspension after 3 failures, user notification) | Done |
| Database unavailable: fail-fast at startup | Done |
| Database unavailable: in-operation handling (retry in non-critical paths, bubble up in critical) | Partial — health check detects it; path-specific handling not verified |
| `AgentError` structured type with `ErrorType` discriminated union | Done |
| "Never Swallow" rule enforced via ESLint rule (`no-empty-catch`) | Not Done — convention only; rule absent from `eslint.config.js` |
