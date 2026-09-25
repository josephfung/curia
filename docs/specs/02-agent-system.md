# 02 — Agent System

## Coordinator Agent & Unified Persona

All external communication flows through a single **Coordinator agent** — the user's unified point of contact. The Coordinator is a persona (e.g., "Alex") that the CEO names and configures. Specialist agents (expense-tracker, research-analyst, etc.) work internally but never communicate directly with the outside world.

### How It Works

1. Every inbound message routes to the Coordinator — no exceptions
2. The Coordinator decides: handle it directly (small talk, acknowledgments) or delegate to specialists
3. Specialist agents return results to the Coordinator via the Bullpen or `agent.response`
4. The Coordinator synthesizes results and responds in its own voice
5. The external recipient never knows multiple agents were involved

As of v0.35.0 the Coordinator prompt was re-derived around an explicit three-way routing decision — handle directly, borrow-then-answer (pull work from a specialist, then reply in its own voice), or transfer-ownership (hand the whole interaction to a specialist that owns its lifecycle). The keystone rule: a reply to anything the Coordinator sent on a specialist's behalf (a delegation-hinted outbound) is always transfer-ownership and is routed back to that specialist, never answered directly. Tool-specific mechanics were relocated out of the prompt into the relevant skill manifests (`config-store`, `email-send`/`email-reply`, `signal-send`, `decay-warnings-list`), and the vestigial executive-voice block was removed — CEO-voice drafting lives in the ceo-inbox specialist.

### Delegated specialist context (#1871)

A delegated specialist does not re-decide whether the requester may ask. The
dispatcher and the coordinator already did that. `delegate` publishes the
specialist task with `metadata.delegationOrigin`, the validated
`metadata.originator`, and no `senderContext`. The runtime renders two
different blocks:

- **Requester identity** — who asked, on which channel, with what system role
  and tier. Any internal-channel task that carries a validated originator gets
  this, including a coordinator task such as the voice off-ramp (channel
  `internal`, originator, no `delegationOrigin`). The identity is context for
  the work. It is not a permission input, and this block does not say
  authorization was settled.
- **Delegated-specialist addendum** — only when `delegationOrigin` is set.
  States that the task is authorized, and that authorization is not
  identification: a missing identity or tier `unknown` is not a further
  clearance. Includes the `<specialist_decline>` instructions. The coordinator
  does not receive this addendum; it still adjudicates senders.

Detection keys off `delegationOrigin`, not `channelId`. A new internal-channel
caller does not inherit specialist framing. Channel `internal` with neither a
validated originator nor `delegationOrigin` still receives the unresolved-sender
low-trust block.

Sender judgment that remains in a specialist prompt is task quality scoped to
that decision. Calendar RSVP policy applies only to a formal-invite CONSULT
REQUEST. A day brief has no invite sender.

A specialist that cannot do the task ends its reply with
`<specialist_decline>`. A marker quoted earlier in the answer is not a refusal.
`delegate` returns `declined: true` rather than prose,
and `DelegationGuard` blocks further attempts to that specialist for the turn
even when the coordinator rewords the brief.

### Late delegation delivery (#1799)

A `delegate` wait that times out does not stop the specialist — by design (#1288): cancelling an
in-flight run risks a half-completed side effect, so the run is left alone and the coordinator's
turn ends. The specialist then finishes minutes later and publishes an `agent.response` whose
originating turn no longer exists. Before v0.44 nothing consumed it, and the work was silently
lost: the weekly travel sweep timed out four weeks running while the calendar agent delivered a
full result each time, and no trip task was created for a month.

The lifecycle now:

1. On timeout, the runtime publishes `delegation.timed_out` carrying the delegate `agent.task`
   event id — the value the specialist stamps as `parentEventId` on its eventual response — plus
   the originating routing and the id of the CEO review task the escalation created.
2. `LateDelegationSubscriber` (system layer) persists that as a row in `pending_delegations`,
   or promotes the dispatch-time `running` claim for the same `delegate_event_id` in place.
   `UNIQUE (delegate_event_id)` makes the handle idempotent, and `status` is a lease
   (`running` → `pending` → `claimed` + `claim_token` → `resolved`) so an actor that crashes
   mid-delivery leaves recoverable work rather than a row claiming work that never happened.
3. When the late response arrives, it is classified. A usable result re-enters the **originating
   agent in its original conversation** with a brief carrying the specialist's output, and the
   review task is closed. Every other outcome — the specialist ultimately failed, came back with a
   question, paused, has no routable origin, or a human already closed the review — is recorded on
   that review task and left open for the principal.
4. `LateDelegationSweep` (default every 5 min) covers what an in-process subscriber cannot: a
   response that landed while the process was down or before the handle was written (recovered from
   `audit_log.parent_event_id`), an abandoned lease, and a handle whose specialist never delivered
   (abandoned after `delegate.lateDelivery.ttlMinutes`).

Waking is idempotent by construction, not by lock. `EventBus.publish()` awaits its subscribers, and
one of those is the woken agent's entire turn — minutes of LLM rounds, easily longer than the 120s
claim lease — so another actor can re-claim the row while that turn is still running. The wake's
event id is therefore *derived* from the delegate event id, so any second attempt carries the same
id and the audit logger's write-ahead insert rejects it on `audit_log`'s primary key before a single
subscriber sees it. The stored `wake_task_event_id` is a record of what happened; the derived id is
the guarantee.

Two further invariants govern the wake:

- **Re-delegation is blocked structurally.** The wake carries `metadata.lateDelegation`, and the
  runtime seeds `DelegationGuard` from it, so a model that tries to re-fetch a result it was just
  handed is short-circuited rather than talked out of it (#1310's guard behaviour is preserved).
- **The brief never restates the original delegated instruction.** #1064 is the precedent: a notify
  `agent.task` that echoed the original intent made the coordinator re-execute it and send a
  duplicate. The original brief is already in the conversation the wake re-enters.
- **A specialist is claimed when the run is published, not only after the wait expires
  (#1893, #1858).** Before publishing, and only after a `resume_token` has been validated,
  `delegate` inserts a `pending_delegations` row with `status = 'running'` for that target
  agent and originating conversation. A partial unique index makes the insert the claim: a
  second call, whatever its brief says, returns `already_in_flight` with the existing
  `delegate_event_id` and `open_handle_age_ms` and does not dispatch. A call with no
  origin to store — the turn never supplied a sender — logs the gap and publishes
  without a claim, so voice and an approval re-invoke still start the specialist.
  An insert that throws still does not dispatch. Age on a running row
  is time since dispatch; age on a pending row starts when the wait expires (or when that
  claim is promoted). Every return except the wait-timer timeout deletes the running row.
  A specialist that reports `reason: 'timeout'` has already finished, so that row is
  released too. If the delete throws, the row is marked resolved as `delivered` so the
  sweep does not send the same result again. The running row stores the validated
  originator, so a claim recovered after a crash wakes with its lineage. A wait-timer
  timeout does not delete the row: the same row becomes the `pending` handle, and the
  lookup matches both statuses. The running row's `expires_at` is the wait plus a short
  grace, so the sweep abandons a claim orphaned by a crash in about the wait, not the
  late-delivery hour. A pending row still blocks until the sweep abandons it
  (`delegate.lateDelivery.ttlMinutes`, default 60). A claimed or resolved handle does not
  block the next delegation. A brief that never dispatched — claim conflict,
  `already_in_flight`, or a later call skipped after escalation — is stored as a backlog
  task that wakes the originating agent in the originating conversation. A brief
  blocked by a `running` claim waits out that claim's delegate wait. A brief
  blocked by a `pending` handle waits until that row's `expires_at` plus one sweep
  interval — the wait is far shorter than the late-delivery TTL, and waking on it
  burns the retry cap while the handle is still open. A later call skipped after
  the wait-timer timeout of the same specialist uses the expiry the timeout
  subscriber will write. A specialist that reports `timeout` has already finished
  and released its claim, so that skip uses the delegate wait. The task is closed
  when that wake is dispatched, so the
  heartbeat does not re-run the brief. A timeout is not queued again. Retries of one
  busy specialist are capped. A wake missing its channel or sender is not written.
  The result is not a failure, so a coordinator that ignores the prompt can call `delegate`
  again in the same turn; the prompt is what stops that loop.

The wake restores the stored `originator` (so the follow-up steps still clear the autonomy gate),
marks itself `derived` via `wakeContext` (so the standing ladder can only downgrade authority), and
deliberately does not carry `liveTurn` — it crosses an async boundary (#1126).

`delegate.lateDelivery.enabled: false` disables the whole mechanism, including the in-flight
lookup. Open handles are then neither resolved nor consulted, so turning the knob off does not
leave a permanent block behind.

### Coordinator Config

```yaml
# agents/coordinator.yaml
name: coordinator
role: coordinator                # special role — dispatch always routes here
persona:
  display_name: Alex             # what end-users see in emails, messages
  tone: professional but warm
  email_signature: |
    Alex
    Office of the CEO
model:
  tier: standard
system_prompt: |
  You are ${persona.display_name}, executive assistant to the CEO.
  You are the single point of contact for all communications.
  You have a team of specialists you can delegate to, but you always
  respond in your own voice. The sender should never know multiple
  agents were involved.

  For casual messages, respond naturally as yourself.
  For tasks, delegate to the appropriate specialist and synthesize
  their work into your response.
pinned_skills:
  - tool-registry
  - scheduler
  - memory-query
allow_discovery: true
```

The `role: coordinator` field tells the dispatch layer to route all inbound messages here. There is exactly one coordinator per deployment.

### Model Routing

Agents declare a capability tier rather than a specific model (see [ADR-014](../adr/014-capability-tier-model-routing.md)):

| Tier | Intended use |
|------|-------------|
| `fast` | Classification, routing, simple extraction |
| `standard` | General-purpose task execution |
| `powerful` | Complex multi-step reasoning, synthesis |

The operator maps tiers to models in `config/default.yaml` → `model_routing`. The `ModelRouter` service resolves each agent's tier to a concrete model at startup; the provider is inferred automatically from the `ModelRegistry` based on the model name prefix (e.g., `claude-*` → Anthropic, `google/gemini-*` or `openai/gpt-*` → OpenRouter).

Optional `needs` flags (`vision`, `large_context`, `reasoning`, `coding`, `audio`, `image_generation`) are documentary — they inform future routing decisions but are not validated in this version.

### Internal Agent Handles

Specialist agents have internal handles (e.g., `@expense-tracker`, `@research-analyst`) used in the Bullpen and audit log. These are never exposed to external users — they're internal identifiers for the Coordinator and other agents to reference.

---

## Agent Definition (Hybrid: YAML + optional TypeScript)

### Simple Agents (YAML config)

```yaml
# agents/expense-tracker.yaml
name: expense-tracker
description: Tracks and categorizes expenses from receipts and emails
model:
  tier: standard
system_prompt: |
  You are an expense tracking assistant for a CEO.
  Extract amounts, vendors, categories, and dates from receipts.
pinned_skills:
  - email-parser
  - spreadsheet-writer
allow_discovery: true    # can discover and use non-pinned skills
schedule:
  - cron: "0 9 * * 1"
    task: "Generate weekly expense summary"
error_budget:
  max_turns: 20          # max LLM round-trips per task
  max_cost_usd: 1.00     # max spend per task execution
```

### Complex Agents (TypeScript handler escape hatch)

```yaml
name: research-analyst
handler: ./research-analyst.handler.ts
# ... same config fields plus custom logic
```

Handler exports hooks: `onTask`, `onToolResult`, `beforeRespond`.

### Config Validation

Agent YAML files are validated against a JSON Schema at load time. Invalid configs (missing required fields, unknown properties) cause a startup error with a clear message pointing to the offending file and field. Schema is generated from the TypeScript `AgentConfig` type to keep them in sync.

### Runtime Template Variables

Agent system prompts can reference a small set of runtime placeholders that the runtime interpolates when materializing the prompt (`interpolateRuntimeContext()` in `src/agents/loader.ts`):

| Placeholder | Resolves to | Notes |
|---|---|---|
| `${agent_contact_id}` | The agent's own `contacts.id` | Opt-in. Used by agents that need to act in their own identity. |
| `${principal_contact_id}` | The principal's `contacts.id` (the CEO/operator the deployment serves) | Opt-in. See [spec 09 — Principal Contact Resolution](09-contacts-and-identity.md). Use this in any prompt that needs to reach the principal — do not hardcode addresses or call `contact-lookup`-by-role for the principal. |
| `${office_identity_block}` | The office identity prose block | See [spec 13 — Office Identity](13-office-identity.md). |

Both `${agent_contact_id}` and `${principal_contact_id}` are guarded by a UUID-format check — non-UUID values resolve to an empty string and emit a one-time warning at boot. This prevents future changes to the ID source from accidentally injecting arbitrary text into a prompt.

---

## Agent Lifecycle

1. Dispatch layer receives `inbound.message`, routes to agent
2. Agent loads system prompt + relevant memory (entity facts, knowledge graph context, Bullpen status)
3. Agent calls LLM, which may request skill invocations → publishes `tool.invoke`
4. Skill results return via `tool.result`
5. Agent formulates response → publishes `agent.response`
6. Dispatch routes response to originating channel

### Lifecycle Hooks

*Lesson from Zora: hook systems need to work at multiple levels.*

The agent runtime exposes hooks at key lifecycle points. Hooks are used by the framework for cross-cutting concerns (audit, memory, security) and by custom agent handlers for domain logic.

- `beforeLLMCall(context)` — modify context before sending to LLM (memory injection, context pruning)
- `afterLLMCall(response)` — inspect/modify LLM response before acting on it
- `beforeSkillInvoke(skill, args)` — validate/modify skill invocation
- `afterToolResult(skill, result)` — process skill results before feeding back to LLM
- `onTaskComplete(task, result)` — cleanup, memory persistence, metric emission
- `onTaskError(task, error)` — error recovery logic (see [05-error-recovery.md](05-error-recovery.md))

---

## Agent State Model

**Stateful per-conversation, restart-safe.** Each inbound message carries a `conversation_id` — a deterministic, human-readable key derived from the channel and its native thread/sender identity (e.g., `signal:+15550001111`, `email:<threadId>`, `cli:local:default`). It is deliberately *reversible*: outbound adapters parse it back to recover the reply target (thread id, phone number, group id). Stored as TEXT, not a UUID. See ADR-025. The agent loads conversation history from working memory (Postgres) on each invocation. No in-process state — restarts lose nothing.

---

## Agent Presence & Status

Each agent maintains a lightweight status that reflects what it's doing right now. This powers real-time monitoring UIs (e.g., a visual "office" showing agents at their desks, in conversation, or working).

### Status Values

```typescript
type AgentStatus =
  | { state: 'idle' }
  | { state: 'thinking'; task_id: string }
  | { state: 'using_tool'; task_id: string; skill: string }
  | { state: 'discussing'; thread_id: string; with: string[] }
  | { state: 'waiting'; task_id: string; reason: string }  // e.g., awaiting human approval
  | { state: 'error'; task_id: string; error_type: string }
  | { state: 'offline'; reason: string };
```

### How It Works

- The agent runtime updates status at each lifecycle transition (task received → thinking → tool call → response → idle)
- Status is published on the bus as `agent.status` events — lightweight, high-frequency, not persisted to audit log (too noisy)
- Current status for all agents is held in an in-memory map and exposed via:
  - `GET /api/agents/status` — snapshot of all agent statuses
  - SSE stream at `GET /api/agents/status/stream` — real-time updates as they happen
- On restart, all agents start as `idle` (correct, since no tasks are in-flight)

### What a Monitoring UI Gets

A frontend subscribing to the SSE stream receives events like:

```json
{ "agent": "expense-tracker", "state": "thinking", "task_id": "abc-123" }
{ "agent": "research-analyst", "state": "discussing", "thread_id": "t-456", "with": ["expense-tracker"] }
{ "agent": "general-assistant", "state": "idle" }
```

This is everything needed to render agents as characters in a visual office: who's at their desk, who's talking to whom, who's on the phone (tool call), who's waiting for approval.

---

## Execution Modes

### Reactive (default)
Agent receives message, responds, done. Working memory for the conversation is kept for a configurable TTL (default: 1 hour of inactivity).

### Persistent Tasks
Long-running work creates a **task record** in Postgres (the `tasks` table; renamed from `agent_tasks` in v0.33 — see [spec 19 — Tasks & Backlog](19-tasks-and-backlog.md)). The scheduler wakes the agent in bursts — it loads progress from working memory, does a chunk of work, saves progress, sets `next_run`. Like a cron job with state. Task management is also exposed to agents by pinning the `tasks` skill (spec 19 §4); document workspace is the separate `documents` skill.

Each persistent task carries:
- `intent_anchor` — the original task description, included in every burst's system prompt to prevent drift
- `progress` JSONB — structured summary of what's been accomplished
- `error_budget_remaining` — tracked across bursts

---

## LLM Provider Abstraction

Multi-provider from day one:

```
src/agents/llm/
  provider.ts      # common interface
  anthropic.ts     # Claude API (Anthropic)
  openrouter.ts    # OpenRouter API (Gemini Flash, DeepSeek V3, GPT-4o, etc.)
  ollama.ts        # local models
  model-registry.ts # ModelRegistry — centralized model metadata
```

Each provider implements:

```typescript
interface LLMProvider {
  id: string;
  chat(params: {
    messages: Message[];
    tools?: ToolDefinition[];
    options?: LLMOptions;
  }): Promise<LLMResponse>;
}
```

### Provider Configuration

Agents declare a capability tier, and the system resolves it to a concrete model via `ModelRouter`. The provider is inferred from the `ModelRegistry` — a centralized registry of all known models with their pricing, context windows, and capabilities. Tier-to-model mapping is configured in `config/default.yaml`:

```yaml
model_routing:
  tiers:
    fast:
      model: claude-haiku-4-5
    standard:
      model: claude-sonnet-4-6
    powerful:
      model: claude-sonnet-4-6
```

Agent YAML declares only the tier:

```yaml
model:
  tier: standard
  needs: [vision, large_context]  # optional hints for routing decisions
```

The `ModelRegistry` holds static metadata (pricing, context window, provider prefix, and declared capabilities) for all supported models. `ModelRouter` validates that each tier's configured model exists in the registry at startup. Cost estimation and token tracking delegate to registry data rather than hardcoded values.

**Lookup is exact-first, then prefix (#1804).** A model id that is a registry key resolves to its own entry. Otherwise the longest registered prefix matches — `claude-haiku-4-5-20251001` → `claude-haiku-4-5` — and the hit is logged at `warn`, naming both ids, once per distinct model id. A prefix hit means the model is being priced and sized as a *different* model, which is only a guess: `deepseek/deepseek-v4-pro-0813` prefix-matched `deepseek/deepseek-v4-pro` and inherited its rates, booting cleanly while reporting costs that were wrong by roughly 3x. Register a dated snapshot in its own right whenever its metadata differs from the base model's.

**Capabilities are the gate for capability-dependent subsystems (#1553).** A model declares what it can do (e.g. `streaming`, `tools`) and callers preflight against that, not against the provider interface. Voice is the first consumer: a spoken turn needs true streaming (ADR-037) and tool calls, and a provider merely *exposing* `stream()` does not prove either — OpenRouter implements `stream()` for every routed model, including ones that neither stream nor tool-call. Voice boot therefore resolves its model and refuses to start when the registry entry is missing `streaming` or `tools` (or when the model is unknown to the registry at all).

### Response Normalization

All providers normalize their responses into a common `LLMResponse` type (discriminated union: `TextResponse | ToolCallResponse | ErrorResponse`). No `any` types in the response path — provider-specific quirks are handled inside the provider implementation, never leaked to the agent runtime.

### Token & Cost Tracking

Every LLM call records: provider, model, input tokens, output tokens, estimated cost, latency. Cost estimation delegates to the `ModelRegistry` — pricing data lives there, not in provider implementations. This data feeds into:
- Error budget enforcement (per-task cost caps)
- Audit log (for billing visibility)
- Health endpoint (for monitoring)

### Time Context Injection

All agents receive a `## Current Date & Time` block in their system prompt on every task turn. This enables reliable time-sensitive reasoning in scheduled agents — specialists now have the same temporal context that was previously available only to the Coordinator.

---

## Dispatch Layer

**All inbound messages route to the Coordinator.** The dispatch layer does not classify or route messages to specialist agents — that's the Coordinator's job. The dispatcher's responsibilities are:

- Route every `inbound.message` to the Coordinator agent
- Enforce policy: rate limits, blocked senders, required approvals
- Translate `agent.response` → `outbound.message` (completing the response loop), unless the agent returns the `NO_REPLY` sentinel (or `suppressDelivery`) — then publish `outbound.no_reply` and send nothing (#1732). The sentinel is interpreted only by the agent runtime (which blanks `content` and sets `suppressDelivery`) and by dispatch. Other `agent.response` subscribers (scheduler job summary, resumable-continuation) must not parse `content` as a control token.
- Inject `persona.display_name` and `persona.email_signature` into outbound messages
- Check for pending Bullpen threads on every `agent.task` routing
- Subscribe to `agent.error` and notify the user on the originating channel
- Mediate Bullpen discussions — escalate to user if agents are stuck

---

## Known Deficiencies

- **Lifecycle hooks** — no hook system in `AgentRuntime`; `beforeLLMCall`, `afterLLMCall`, `beforeSkillInvoke`, `afterToolResult`, `onTaskComplete`, and `onTaskError` are not implemented.
- **Agent presence snapshot** — the `GET /api/agents/status` endpoint exists but all agents return hardcoded `state: 'idle'`; a real-time state machine has not been built.
- **Agent presence SSE stream** — the `GET /api/agents/status/stream` endpoint is not implemented.
- **Ollama provider** — the local-model provider is not implemented; no `ollama.ts` provider file exists.
