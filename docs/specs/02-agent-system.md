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
  - skill-registry
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
memory:
  scopes: [expenses, vendors, budgets]
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

Handler exports hooks: `onTask`, `onSkillResult`, `beforeRespond`.

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
3. Agent calls LLM, which may request skill invocations → publishes `skill.invoke`
4. Skill results return via `skill.result`
5. Agent formulates response → publishes `agent.response`
6. Dispatch routes response to originating channel

### Lifecycle Hooks

*Lesson from Zora: hook systems need to work at multiple levels.*

The agent runtime exposes hooks at key lifecycle points. Hooks are used by the framework for cross-cutting concerns (audit, memory, security) and by custom agent handlers for domain logic.

- `beforeLLMCall(context)` — modify context before sending to LLM (memory injection, context pruning)
- `afterLLMCall(response)` — inspect/modify LLM response before acting on it
- `beforeSkillInvoke(skill, args)` — validate/modify skill invocation
- `afterSkillResult(skill, result)` — process skill results before feeding back to LLM
- `onTaskComplete(task, result)` — cleanup, memory persistence, metric emission
- `onTaskError(task, error)` — error recovery logic (see [05-error-recovery.md](05-error-recovery.md))

---

## Agent State Model

**Stateful per-conversation, restart-safe.** Each inbound message carries a `conversation_id` — a deterministic UUID v5 generated from `channel:user_id:thread_id` (e.g., `signal:+15550001111:thread-789` → UUID). The agent loads conversation history from working memory (Postgres) on each invocation. No in-process state — restarts lose nothing.

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
Long-running work creates a **task record** in Postgres (the `tasks` table; renamed from `agent_tasks` in v0.33 — see [spec 19 — Tasks & Backlog](19-tasks-and-backlog.md)). The scheduler wakes the agent in bursts — it loads progress from working memory, does a chunk of work, saves progress, sets `next_run`. Like a cron job with state. Task management is also exposed to agents declaratively via the `enable_task_management` capability (spec 19 §4).

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

The `ModelRegistry` holds static metadata (pricing, context window, provider prefix) for all supported models. `ModelRouter` validates that each tier's configured model exists in the registry at startup. Cost estimation and token tracking delegate to registry data rather than hardcoded values.

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
- Translate `agent.response` → `outbound.message` (completing the response loop)
- Inject `persona.display_name` and `persona.email_signature` into outbound messages
- Check for pending Bullpen threads on every `agent.task` routing
- Subscribe to `agent.error` and notify the user on the originating channel
- Mediate Bullpen discussions — escalate to user if agents are stuck

---

## Implementation Status

| Item | Status |
|---|---|
| Coordinator agent — `role: coordinator` routing, `coordinator.yaml` config | Done |
| Specialist agents — YAML-only config (expense-tracker, research-analyst, etc.) | Done |
| TypeScript handler escape hatch (`handler:` field, custom lifecycle hooks) | Done |
| Agent YAML config validation against JSON Schema at startup | Done |
| Lifecycle hooks (`beforeLLMCall`, `afterLLMCall`, `beforeSkillInvoke`, `afterSkillResult`, `onTaskComplete`, `onTaskError`) | Not Done — no hook system in `AgentRuntime` |
| Agent state model — stateful per-conversation, Postgres-backed, restart-safe | Done |
| Agent presence — `GET /api/agents/status` snapshot endpoint | Partial — endpoint exists but all agents return hardcoded `state: 'idle'`; real-time state machine not built |
| Agent presence — SSE stream at `GET /api/agents/status/stream` | Not Done |
| Execution mode: reactive (message → respond) | Done |
| Execution mode: persistent tasks (burst execution, `intent_anchor`, `progress` JSONB) | Done |
| LLM provider abstraction (`LLMProvider` interface, `provider.ts`) | Done |
| Anthropic provider | Done |
| OpenRouter provider (Gemini Flash, DeepSeek V3, GPT-4o via `OPENROUTER_API_KEY`) | Done |
| Model registry — centralized pricing, context windows, capabilities for all models | Done |
| Ollama (local model) provider | Not Done |
| Fallback provider (`model.fallback` in agent config) | Not Done |
| Token tracking per LLM call (input/output tokens via `llm.call` event) | Done |
| Cost tracking per LLM call (estimated USD in `llm.call` event) | Done |
| Dispatch layer — route all inbound to Coordinator, enforce rate limits and policy | Done |
| Dispatch layer — translate `agent.response` → `outbound.message` | Done |
| Dispatch layer — inject office identity (display name, email signature) into outbound | Done |
| Dispatch layer — check pending Bullpen threads on every routing | Done |
| Dispatch layer — subscribe to `agent.error` and notify user | Done |
| Turn budget injection — agent runtime prepends a max-turns budget block to the system prompt, with proximity threshold and anti-retry guidance | Done |
| CallerContext synthesis — delegated specialist tasks reconstruct a synthetic CallerContext from the originator so skills see consistent caller fields | Done |
