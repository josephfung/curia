# Adding an Agent

Agents are the LLM-powered workers in Curia. Each agent is defined by a YAML config file in `agents/`. Most agents require only a YAML file; complex agents can optionally add a TypeScript handler for custom lifecycle logic.

See [Adding a Skill](adding-a-skill.md) if you want to add a capability rather than a new agent. Skills are available to all agents.

---

## Quick Start

1. Create `agents/<name>.yaml` with the required fields (see below)
2. If using a custom handler: create `agents/<name>.handler.ts`
3. Restart Curia — agent YAML files are loaded and schema-validated at startup
4. Pin the skills the agent needs (see the [skills directory](../specs/03-skills-and-execution.md#built-in-skills) and browse `skills/` for available options)

---

## YAML Schema Reference

```yaml
# agents/expense-tracker.yaml

# ------------------------------------------------------------------
# Identity (required)
# ------------------------------------------------------------------

name: expense-tracker          # unique identifier; used in logs, delegation, audit trail
description: |                 # human-readable purpose; shown in the admin UI and audit log
  Tracks and categorizes expenses from receipts and emails.

# ------------------------------------------------------------------
# Model (required)
# ------------------------------------------------------------------

model:
  provider: anthropic          # "anthropic" | "openai" | "ollama"
  model: claude-sonnet-4-20250514

  # Optional: fallback provider if primary is unavailable
  fallback:
    provider: openai
    model: gpt-4o

# ------------------------------------------------------------------
# System Prompt (required)
# ------------------------------------------------------------------

system_prompt: |
  You are an expense tracking assistant for a CEO.
  Extract amounts, vendors, categories, and dates from receipts.
  Return structured data — never guess at missing fields.

# ------------------------------------------------------------------
# Skills (optional but almost always needed)
# ------------------------------------------------------------------

pinned_skills:                 # skills always available in the agent's tool list
  - web-fetch                  # see skills/ directory for all options
  - scheduler-create
  - scheduler-list
  - scheduler-cancel

allow_discovery: true          # if true, agent can search the skill registry at runtime
                               # and request skills not in pinned_skills
                               # "normal" sensitivity skills auto-approve; "elevated" ones
                               # require one-time human approval per agent-skill pair

# ------------------------------------------------------------------
# Memory (optional)
# ------------------------------------------------------------------

memory:
  scopes: [expenses, vendors]  # which memory namespaces this agent can read/write
                               # scopes are isolated — an agent only sees its declared scopes

# ------------------------------------------------------------------
# Scheduled Tasks (optional)
# ------------------------------------------------------------------

schedule:
  - cron: "0 9 * * 1"         # standard cron expression (UTC unless agent sets timezone)
    task: "Generate weekly expense summary and email to CEO"

# ------------------------------------------------------------------
# Error Budget (optional)
# ------------------------------------------------------------------

error_budget:
  max_turns: 20               # max LLM round-trips per task execution
  max_cost_usd: 1.00          # max LLM spend per task (across all turns)
                              # exceeded tasks are halted and the CEO is notified

# ------------------------------------------------------------------
# Custom Handler (optional — escape hatch for complex logic)
# ------------------------------------------------------------------

handler: ./expense-tracker.handler.ts
```

---

## Field Reference

### `name` (required)

Unique identifier for the agent. Used in:
- The `@name` handle for delegation via the `delegate` skill
- Audit log entries (`source_id`)
- Agent status SSE stream
- Error notifications ("Agent expense-tracker failed: …")

Use lowercase kebab-case. Must be unique across all agents in the deployment.

### `description` (required)

Plain-language description of what the agent does. This is:
- Shown in the admin dashboard
- Included in audit log metadata
- Used by the Coordinator to decide which specialist to delegate to

Write it from the perspective of "what tasks should be routed here." One or two sentences is enough.

### `model` (required)

Specifies which LLM to use.

| Field | Values |
|---|---|
| `provider` | `"anthropic"`, `"openai"`, `"ollama"` |
| `model` | Provider-specific model ID (e.g., `claude-sonnet-4-20250514`, `gpt-4o`, `llama3.2`) |

The optional `fallback` block specifies an alternate provider+model to use if the primary provider returns an error or is unavailable. The fallback is used transparently — the agent does not need to be aware of the switch.

### `system_prompt` (required)

The LLM instructions for this agent. Written in plain text. Key points:

- The runtime injects additional context automatically (current date/time, autonomy band, memory context) — you do not need to add boilerplate for these
- The Coordinator's system prompt uses `${office_identity_block}` to receive the compiled identity (name, tone, constraints, etc.) from `OfficeIdentityService`. Specialist agents do not need this — identity is a Coordinator concern.
- Write for a single-turn task frame. For persistent tasks, the `intent_anchor` is injected separately to prevent drift.

### `pinned_skills` (optional)

List of skill names always included in this agent's tool list. These are the skills the agent can call without discovery.

**Choosing which skills to pin:**

Browse the `skills/` directory for available skills. As a heuristic:
- Pin skills the agent needs on *every* task (e.g., `web-fetch` for a research agent)
- Don't pin skills that are rarely needed — use `allow_discovery: true` instead so they're available on demand without cluttering the tool list
- The Coordinator should pin a broad set since it handles all inbound routing

Current built-in skills include (see `skills/` for the full list):

| Category | Skills |
|---|---|
| **Email** | `email-send`, `email-reply` |
| **Calendar** | `calendar-list-events`, `calendar-create-event`, `calendar-update-event`, `calendar-delete-event`, `calendar-find-free-time`, `calendar-check-conflicts`, `calendar-list-calendars`, `calendar-register` |
| **Contacts** | `contact-lookup`, `contact-create`, `contact-list`, `contact-link-identity`, `contact-unlink-identity`, `contact-set-role`, `contact-grant-permission`, `contact-revoke-permission` |
| **Web** | `web-fetch`, `web-search`, `web-browser` |
| **Scheduling** | `scheduler-create`, `scheduler-list`, `scheduler-cancel` |
| **Delegation** | `delegate` |
| **Autonomy** | `get-autonomy`, `set-autonomy` |
| **Context** | `entity-context`, `context-for-email`, `held-messages-list`, `held-messages-process` |
| **Templates** | `template-meeting-request`, `template-reschedule`, `template-cancel`, `template-doc-request` |
| **Knowledge** | `knowledge-company-overview`, `knowledge-meeting-links`, `knowledge-travel-preferences`, `knowledge-loyalty-programs` |

### `allow_discovery` (optional, default: `false`)

When `true`, the agent can call the skill registry at runtime to find and request skills not in its `pinned_skills` list. The runtime handles the approval gate:

- `sensitivity: "normal"` skills → auto-approved on first use
- `sensitivity: "elevated"` skills → requires one-time human approval per agent-skill pair, persisted in `skill_approvals` table

Turn this on for general-purpose agents (like the Coordinator) that may encounter novel tasks. Keep it `false` for focused specialist agents to prevent scope creep.

### `memory` (optional)

```yaml
memory:
  scopes: [expenses, vendors, budgets]
```

Memory scopes isolate what an agent can read and write in the knowledge graph. An agent only sees entities within its declared scopes. Scopes are freeform strings — coordinate naming conventions across your agent team to avoid fragmentation.

### `schedule` (optional)

Cron-triggered tasks for this agent. Each entry fires a synthetic inbound task at the specified time:

```yaml
schedule:
  - cron: "0 9 * * 1"
    task: "Generate weekly expense summary"
  - cron: "0 */4 * * *"
    task: "Check for new receipts in email"
```

Uses standard UNIX cron syntax (5 fields). Times are in UTC unless a timezone is specified at the job level via the `scheduler-create` skill.

### `error_budget` (optional)

Caps resource consumption per task execution:

```yaml
error_budget:
  max_turns: 20        # LLM round-trips before the task is aborted
  max_cost_usd: 1.00   # estimated LLM spend before the task is aborted
  max_errors: 3        # skill invocation failures before the task is aborted
```

All three limits are enforced at task runtime. When any limit is hit, the task is marked as failed, the CEO is notified on the originating channel, and the agent returns to idle.


---

## Autonomy Awareness

The autonomy engine injects a global score (0–100) into the Coordinator's system prompt on every task, governing how independently it acts. Specialist agents generally don't need this — the Coordinator handles autonomy gating and only delegates when it decides to proceed.

If your specialist agent needs to make autonomy-gated decisions independently (rare), pass `autonomyService` in its `AgentRuntime` config. See `docs/specs/14-autonomy-engine.md` for the full spec.

---

## Validation

Agent YAML files are validated at startup against a JSON Schema generated from the `AgentConfig` TypeScript type. Startup will fail with a clear error message pointing to the offending file and field if validation fails. There is no runtime YAML reloading — a restart is required after editing agent configs.

---

## Testing Your Agent

There's no agent unit test runner (agents are inherently integration-heavy). Instead:

1. Start Curia with `docker compose up`
2. Send a message on the CLI channel: `pnpm cli "your test message"`
3. Watch the pino logs (structured JSON) — filter by `agent: "your-agent-name"` to see its activity
4. Check the audit log in Postgres for the full event chain

For skill-level testing, write `handler.test.ts` in the skill directory instead.

---

## Related Docs

- [Adding a Skill](adding-a-skill.md) — write a new skill for your agent to use

### Key Specs
- [Architecture Overview](../specs/00-overview.md) — five-layer bus model
- [Agent System Spec](../specs/02-agent-system.md) — agent lifecycle, state model, status API
- [Skills & Execution](../specs/03-skills-and-execution.md) — how skills work, discovery, approval gate
- [Audit & Security](../specs/06-audit-and-security.md) — what gets logged and how
