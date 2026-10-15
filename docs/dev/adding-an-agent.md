# Adding an Agent

Agents are the LLM-powered workers in Curia. Each agent is defined by a YAML config file in `agents/`. Most agents require only a YAML file; complex agents can optionally add a TypeScript handler for custom lifecycle logic.

See [Adding a Skill](adding-a-tool.md) if you want to add a capability rather than a new agent. Skills are available to all agents.

---

## Quick Start

1. Create `agents/<name>.yaml` with the required fields (see below)
2. If using a custom handler: create `agents/<name>.handler.ts`
3. Restart Curia — agent YAML files are loaded and schema-validated at startup
4. Pin the skills the agent needs (see the [skills directory](../specs/03-tools-and-execution.md#built-in-skills) and browse `skills/` for available options)

> **New agents start disabled in the registry.** Like skills, agents are tracked in a registry (`agent_registry`) with an install/enable lifecycle. A newly added agent is registered at startup but **not enabled** by default — enable it (via the registry HTTP API or admin UI) before it participates in routing. Enable state is **restart-based**: only enabled agents are loaded and registered on the next restart. See [Configuration → registry](configuration.md#skill-agent-and-channel-registry).

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
delegate_when: >-              # optional. The agent's line in the specialist roster; defaults to description
  Receipts, expense reports and spending questions. Forward the receipt with the request.
display_name: expense team     # optional. What a model might call this agent; failure replies reject drafts that use it. Not persona.display_name.

# ------------------------------------------------------------------
# Model (required)
# ------------------------------------------------------------------

model:
  provider: anthropic          # "anthropic" | "openai" | "ollama"
  model: claude-sonnet-4-6

  # Optional: fallback provider if primary is unavailable
  fallback:
    provider: openai
    model: gpt-4o

# ------------------------------------------------------------------
# System Prompt (required)
# ------------------------------------------------------------------

system_prompt: |
  You are an expense tracking assistant for the principal.
  Extract amounts, vendors, categories, and dates from receipts.
  Return structured data — never guess at missing fields.

# ------------------------------------------------------------------
# Skills (optional but almost always needed)
# ------------------------------------------------------------------

pinned_skills:                 # skill bundles always available (expanded to member tools)
  - web-fetch                  # singleton skills still use the tool name
  - tasks                      # heartbeat + task-* + Task Management instructions
  - documents                  # doc-* + Document Workspace instructions
  - scheduler-create

allow_discovery: true          # if true, agent can search tools at runtime
                               # and request tools not in pinned_skills
                               # "normal" sensitivity tools auto-approve; "elevated" ones
                               # require one-time human approval per agent-tool pair

# ------------------------------------------------------------------
# Scheduled Tasks (optional)
# ------------------------------------------------------------------

schedule:
  - cron: "0 9 * * 1"         # standard cron expression (UTC unless agent sets timezone)
    task: "Generate weekly expense summary and email to the principal"

# ------------------------------------------------------------------
# Error Budget (optional)
# ------------------------------------------------------------------

error_budget:
  max_turns: 20               # max LLM round-trips per task execution
  max_cost_usd: 1.00          # max LLM spend per task (across all turns)
                              # exceeded tasks are halted and the principal is notified

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

Plain-language description of what the agent does, for people. This is:
- Shown in the admin dashboard
- Included in audit log metadata
- The agent's line in the specialist roster when it has no `delegate_when`

One or two sentences is enough.

### `delegate_when` (optional)

When to delegate to this agent, for the model. It is the agent's line in the coordinator's `## Available Specialists` roster and in `${available_specialists}`, so the coordinator reads it on every turn. Say which requests go here and, when it matters, how to brief the agent and who replies. Leave how the agent works to its own `system_prompt`.

Keep it to two or three sentences. `tests/unit/agents/prompt-budget.test.ts` holds the roster over the core agents to a budget. Without this field the roster shows `description`.

A roster line suits a specialist the coordinator uses rarely or for one narrow job, such as setup-wizard, diagnostics or meeting-debrief. Routing the coordinator applies on most turns, such as the principal's calendar and inbox, belongs in the coordinator's own prompt: moved into roster lines, those routes changed what it did on everyday requests (#1954, lesson 11 in [Changing an agent's prompt](#changing-an-agents-prompt)). Add a scenario case for the route when you add the line.

### `model` (required)

Specifies which LLM to use.

| Field | Values |
|---|---|
| `provider` | `"anthropic"`, `"openai"`, `"ollama"` |
| `model` | Provider-specific model ID (e.g., `claude-sonnet-4-6`, `gpt-4o`, `llama3.2`) |

The optional `fallback` block specifies an alternate provider+model to use if the primary provider returns an error or is unavailable. The fallback is used transparently — the agent does not need to be aware of the switch.

### `system_prompt` (required)

The LLM instructions for this agent. Written in plain text. Key points:

- The runtime injects additional context automatically (current date/time, autonomy band, memory context) — you do not need to add boilerplate for these
- The Coordinator's system prompt uses `${office_identity_block}` to receive the compiled identity (name, tone, constraints, etc.) from `OfficeIdentityService`. Specialist agents do not need this — identity is a Coordinator concern.
- Write for a single-turn task frame. For deferred or multi-step work, use the task system (pin `tasks` + usually `documents`, see below and [spec 19](../specs/19-tasks-and-backlog.md)) — `task-create` for principal-visible work, `scheduler-create` for operational sweeps. When a task wakes the agent, its `intent_anchor`, title, and progress are supplied as context so the agent resumes where it left off.
- Call the person Curia serves **the principal**. Do not hardcode a job title such as CEO. See [Principal vocabulary](#principal-vocabulary) below.

### Principal vocabulary

Agent prompts, schedule `task` text, skill `SKILL.md` bodies, and `tool.json` descriptions are all shown to the model. Core uses **the principal** for the person the deployment serves. A president, chair, founder, or executive director is still the principal.

Write overlay agents and tools the same way. A prompt that says "email the CEO" while the injected Principal Contact Details block says "the principal" is how a model invents an address that was never on file. Ask for the principal, then use an address from that block. The list is complete: an identifier that is not listed is not the principal's. The email the block lists under "Primary email" is `contacts.primary_email`. To send to the principal, pass the alias `principal` to a send skill rather than copying an address (ADR-047).

Do not rename identifiers to match the prose. Agent names (`ceo-inbox`), secret names, and schema values such as task `owner: "ceo"` stay as they are.

When a human-facing sentence genuinely needs the principal's job title, read `contacts.title` on the principal contact. Do not hardcode one.

### `pinned_skills` (optional)

List of **skill (bundle) names** always included for this agent. Bootstrap expands each pin to its member tools and injects any SKILL.md instruction body.

**Choosing what to pin:**

Browse `skills/*/SKILL.md` (bundles) and flat `skills/<tool>/` (singleton skills). As a heuristic:
- Pin skills the agent needs on *every* task (e.g., `web-fetch` for a research agent, `tasks` for heartbeat-eligible work)
- Don't pin skills that are rarely needed — use `allow_discovery: true` instead
- The Coordinator should pin a broad set since it handles all inbound routing

Unresolved pins are skipped at bootstrap (warn). For **scheduled** agents, unresolved pins are also logged at **error** so monitoring can catch a reduced toolset (#1501) — schedules still load and the agent may try to run; the error is the signal to investigate.

**`allowed_callers` and custom tools:** If a custom tool in your deploy repo has `allowed_callers` set and your new agent needs to use it, add your agent's name to that tool's `allowed_callers` list. This only applies to custom tools in the same deploy repo — core tools should never restrict by deployment-specific agent name. See [Adding a Tool — `allowed_callers`](adding-a-tool.md#allowed_callers-optional) for the full pattern.

Current built-in skills/tools include (see `skills/` for the full list):

| Category | Pin |
|---|---|
| **Email** | `email-send`, `email-reply` (atoms / singleton skills); `drive-download-file` |
| **Tasks** | `tasks` — expands to `task-*`, injects discipline block, heartbeat-eligible; see [spec 19](../specs/19-tasks-and-backlog.md) |
| **Documents** | `documents` — expands to `doc-*`, injects workspace block |
| **Calendar** | `calendar` — expands to all `calendar-*` tools (per-tool `action_risk` preserved) |
| **Contacts** | `contact-lookup`, `contact-create`, `contact-list`, … |
| **Web** | `web-fetch`, `web-search`, `web-browser` |
| **Scheduling** | `scheduler-create`, `scheduler-list`, `scheduler-cancel` |
| **Delegation** | `delegate` |
| **Autonomy** | `get-autonomy`, `set-autonomy` |
| **Context** | `entity-context` |
| **Config** | `config-store` |

This table is hand-maintained — run `ls skills/` for the authoritative current set.

#### Using `config-store` for persistent agent config

If your agent needs to store configuration values that persist across runs — URLs, account
numbers, preferences, or any other settings the principal provides once via chat — pin
`config-store` and use it directly. Do not write a new `knowledge-*` skill.

```yaml
pinned_skills:
  - config-store
```

**Namespace:** pick a short, stable string owned by your agent (e.g. `travel` for a travel
coordinator, `writing_config` for an essay editor). Bake it into your system prompt.

**Store** (coordinator does this when the principal provides a value via chat):
```
config-store { action: "store", namespace: "writing_config", key: "writing_guide_url", value: "https://..." }
```

**Retrieve** (agent does this at the start of each run):
```
config-store { action: "retrieve", namespace: "writing_config", key: "writing_guide_url" }
# → { found: true, value: "https://..." }

config-store { action: "retrieve", namespace: "writing_config" }
# → { entries: [{ key: "writing_guide_url", value: "..." }, ...] }
```

The values are stored with `decayClass: permanent` — they persist across Curia restarts
and are not subject to KG decay.

#### Specialists don't own outbound comms

Do not pin `email-send`, `email-reply`, or `signal-send` on specialist agents. The
coordinator owns all outbound communication — it applies persona, tone, and
audience-awareness logic that specialists are not equipped to replicate. Return
structured findings from your specialist; let the coordinator decide how to present them.

If your specialist runs on a schedule and needs to send output, use `agent_id: coordinator`
in the schedule block (see the schedule section below).

### `expected_duration_seconds` (optional)

Expected wall-clock duration of a delegated task, in seconds. The runtime adds bounded headroom (25%, capped at three minutes) and uses that as the coordinator's wait, unless the waking scheduled job already supplied `expectedDurationSeconds`. Omit it and the agent inherits `delegate.defaultTimeoutMs` (450s, sized to the pooled p99 of delegate runs before 2026-09-20).

Omitting the field is valid: the agent inherits the floor, and startup logs its name at info (an inventory, not a warning). Adding a specialist without a hint also means adding its name to the list in `tests/unit/agents/agent-registry.test.ts`. Set a hint when this specialist's measured p99 is above the floor, or when a shorter wait should catch a hang sooner. The computed wait must stay at or under the 895s clamp ([ADR-044](../adr/044-delegate-wait-clamp-ceiling.md)).

### `allow_discovery` (optional, default: `false`)

When `true`, the agent can call the skill registry at runtime to find and request skills not in its `pinned_skills` list. The runtime handles the approval gate:

- `sensitivity: "normal"` skills → auto-approved on first use
- `sensitivity: "elevated"` skills → requires one-time human approval per agent-skill pair, persisted in `skill_approvals` table

Turn this on for general-purpose agents (like the Coordinator) that may encounter novel tasks. Keep it `false` for focused specialist agents to prevent scope creep.

### Pinning `tasks` and `documents`

Pin these skill bundles to give an agent the platform task system and/or document workspace:

```yaml
pinned_skills:
  - tasks
  - documents
```

- **`tasks`** expands to `task-create` / `task-list` / `task-update` / `task-complete`
  plus the sibling tools `plan` and `checkpoint`,
  injects the discipline block from `skills/tasks/SKILL.md`, and marks the agent
  heartbeat-eligible for `BacklogHeartbeat`.
- **`documents`** expands to `doc-*`, injects the workspace block from
  `skills/documents/SKILL.md`, and enables the document-workspace runtime surface.

Pin both on agents that uncover deferrable, multi-step work (the Coordinator,
`ceo-inbox`, and `contacts` ship with both). Pure act-and-return specialists omit them.
An agent that needs only read-only `task-list` can pin that **tool** name directly
(polymorphic pins, [ADR-032](../adr/032-polymorphic-pins-and-mcp-as-skill.md)) without
the bundle — it won't be heartbeat-eligible or get the injected block, and it will
not receive sibling tools like `plan`/`checkpoint`. See [spec 19 — Tasks & Backlog](../specs/19-tasks-and-backlog.md).

`task-create` accepts an optional `target_agent_id` input that assigns the task (and its
wake-up) to another registered agent — for example, the Coordinator scheduling a debrief task
for the `meeting-debrief` specialist. Omit it and the task is assigned to the calling agent.

### Memory access

Agents do not declare memory scopes. All agents read and write a single shared knowledge graph; there is no per-agent memory isolation. Access is governed by capability gating (whether the agent is granted the `entityMemory` / `workingDocs` surfaces at all), data sensitivity tiers (the `max_sensitivity` ceiling on `memory-query`), and source attribution on writes — not by agent identity. See [ADR-028](../adr/028-shared-unbound-agent-memory.md).

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

#### Targeting the coordinator from a schedule

If your specialist runs on a schedule and its output should be communicated to the principal,
declare `agent_id: coordinator` in the schedule entry. The coordinator receives the
task, delegates to your specialist for the actual work, and handles sending in its own
voice with its persona guardrails intact.

```yaml
# writing-scout.yaml — schedule fires at coordinator, not writing-scout
schedule:
  - cron: "30 8 * * 2"
    agent_id: coordinator
    task: >
      The writing scout has run on schedule. Delegate to @writing-scout to research
      and score 2 high-signal essay ideas for the principal. Email findings to the principal.
```

The `agent_id` field defaults to the agent's own name when omitted — existing schedules
are unaffected.

> **Warning:** If two agents declare schedules that target each other, Curia will log a
> warning at startup. This creates an infinite task loop at runtime — fix it before
> deploying.

### `error_budget` (optional)

Caps resource consumption per task execution:

```yaml
error_budget:
  max_turns: 20        # LLM round-trips before the task is aborted
  max_cost_usd: 1.00   # estimated LLM spend before the task is aborted
  max_errors: 3        # skill invocation failures before the task is aborted
```

All three limits are enforced at task runtime. When any limit is hit, the task is marked as failed, the principal is notified on the originating channel, and the agent returns to idle.


---

## Autonomy Awareness

The autonomy engine injects a global score (0–100) into the Coordinator's system prompt on every task, governing how independently it acts. Specialist agents generally don't need this — the Coordinator handles autonomy gating and only delegates when it decides to proceed.

If your specialist agent needs to make autonomy-gated decisions independently (rare), pass `autonomyService` in its `AgentRuntime` config. See `docs/specs/14-autonomy-engine.md` for the full spec.

---

## Validation

Agent YAML files are validated at startup against a JSON Schema generated from the `AgentConfig` TypeScript type. Startup will fail with a clear error message pointing to the offending file and field if validation fails. There is no runtime YAML reloading — a restart is required after editing agent configs.

---

## Changing an agent's prompt

Decide *where* a rule goes before writing it: code enforcement, then injection with its trigger, then a tool description, then a lazy playbook, and the always-on prompt last ([ADR-046](../adr/046-agent-behavior-fix-placement.md)). These practices come from the 2026-10 coordinator and specialist prompt trim (#1954, #2025).

### Principles

1. **One rule, one place.** Before adding text anywhere, delete every other statement of it.
2. **Say what to do.** Write positive instructions. Don't quote examples of unwanted output — `not "I can use the web-fetch tool"` puts the tool name into the context. Drop capitals and labels like "(mandatory)". Pointing the model at a place for a note worked; the prohibition "add no note" did not (#1990).
3. **One voice.** Address the agent in the second person, the same voice as every code-owned block (identity, security, contact blocks, turn guidance, tool descriptions). First person appears only inside quoted speech: "You speak in the first person singular ('I checked your calendar')". "You" then means the agent everywhere, including in messages people send it.
4. **Policy in the YAML, personality in the identity block.** The YAML says who gets what information, keeps internals out, and says whose instructions count. Warmth, formality, length, directness and how readily to ask questions belong to the office identity, which the principal edits in the console's Personality settings. YAML text that sets any of these overrides the principal's own settings.
5. **Move text to turn guidance only when it has a trigger.** Turn guidance rides in the uncached user message, so moving text that applies on every turn there costs more, not less.
6. **Move the test with the rule.** Replace unit tests that pin prompt text with tests of the mechanism that now carries the rule. Guard a deletion with the "does not restate" table in `tests/unit/agents/loader.test.ts`; each row names where the rule now lives.
7. **A/B every cut on the same day** against `origin/main`'s prompt with `pnpm scenarios` (see `tests/scenarios/README.md`), and **lower the budget** in `tests/unit/agents/prompt-budget.test.ts` when the prompt shrinks.

### Lessons

1. **Rules outlive their causes.** `git log -S` a rule's first line and check whether a later code change already handles the cause.
2. **Prompts and pin comments drift from the toolset.** Cross-check every tool a prompt names against the agent's resolved pins.
3. **"Enforced in code" means reading the enforcement point.** Where enforcement is partial, keep one clause rather than the paragraph.
4. **Specs quote prompt text.** Grep `docs/specs/` before deleting.
5. **A full-suite miss is not a regression until the A/B says so.** Budget a targeted A/B (about 30 minutes, under $2) into the PR rather than reading a single red run.
6. **Size the verification to the change.** A full A/B is for prompt cuts. A moved heading or a lazily loaded reference needs the unit tests and one full-suite run. Stub a case's whole read surface at once, not one tool per failed run.
7. **Examples are instructions.** Check a prompt's examples against the behavior checks — "I'll check with my research team" was offered as good phrasing and is exactly what scenario 10's `no_team_voice` check fails.
8. **A clause that reads as redundant can be the anchor at its trigger.** Delete a restatement only when the general rule reaches that trigger, and let the A/B decide.
9. **When merging lists, keep catch-alls as catch-alls.** Folding "contacts CRUD belongs to the contacts specialist" into a list of named operations left renames and identity links without a route.
10. **A tighter paragraph can change how the model acts on a result, not just what it decides.** When a rewrite misses, look at the calls after the decision too.
11. **Core routes stay in the coordinator's prompt; the roster suits narrow specialists.** See [`delegate_when`](#delegate_when-optional).
12. **Rewrite the prohibition, not the instruction beside it.** The sentence that triggers an action is load-bearing in its exact words; change it only with its own A/B.
13. **A roster line thinner than the description makes the coordinator do the groundwork.** Say what the specialist loads for itself ("a short brief is enough").
14. **Where injected guidance sits can matter as much as what it says.** The same words in a block rebuilt before every model call and in a wake message behaved differently. A/B each placement separately.
15. **On specialists, only removing dead or repeated text was neutral.** Rewrites of live sections changed which tools the model called while pass rates held. Compare call counts over 10 runs, not only behaviors.

### Measuring an agent's context

`scripts/report-agent-context.ts` is a read-only report of an agent's per-call context and tool usage, from `llm.call` and the call archive. In production, `DATABASE_URL` is already in the app container; don't use `pnpm run`, which expects a `.env`:

```bash
ssh -p 2222 <host> 'docker exec curia-curia-1 \
  ./node_modules/.bin/tsx scripts/report-agent-context.ts \
  --agent coordinator --days 30 --format markdown'
```

Pass `--since` / `--until` for a window other than the 30 days ending now. What the numbers mean:

- **System-string chars** — every `role=system` message in the archived prompt: the YAML plus the blocks injected on that call. Not the same as the `context.budget` `system_prompt` tier.
- **Tool-definition bytes** — `octet_length` of the stored `tool_definitions`. Source bytes sum each tool object; json-framing is the array punctuation. Percentiles do not sum across rows.
- **Source split** — a tool on disk under `skills/**/tool.json` (or a pinned bundle member) is `local`; when the agent pins exactly one MCP server, every other tool is charged to it.
- **Provider input tokens** — `llm.call` `inputTokens`, p50 and p95.
- **Context budget tiers** — estimated tokens of each injected block where included, and how often it was dropped.
- **Pinned tools with zero calls** — expanded pins plus MCP tools offered in the window, minus that agent's `tool.invoke` / `skill.invoke` rows.
- **Modal tool count** — the most common tool-list size; later calls in a task grow when `skill-activate` adds tools.

---

## Testing Your Agent

Behavior is tested with the two suites in the release gate: `pnpm scenarios` scores agent decisions against stubbed tools (cases can target a specialist with `agent:`; see `tests/scenarios/README.md`), and `pnpm smoke` runs end-to-end turns against a fixture office (see [smoke-tests.md](smoke-tests.md)). Add a case when you add a route or a behavior. For hands-on checks:

1. Start Curia with `docker compose up`
2. Send a message on the CLI channel: `pnpm cli "your test message"`
3. Watch the pino logs (structured JSON) — filter by `agent: "your-agent-name"` to see its activity
4. Check the audit log in Postgres for the full event chain

For skill-level testing, write `handler.test.ts` in the skill directory instead.

---

## Related Docs

- [Adding a Skill](adding-a-tool.md) — write a new skill for your agent to use

### Key Specs
- [Architecture Overview](../specs/00-overview.md) — five-layer bus model
- [Agent System Spec](../specs/02-agent-system.md) — agent lifecycle, state model, status API
- [Skills & Execution](../specs/03-tools-and-execution.md) — how skills work, discovery, approval gate
- [Audit & Security](../specs/06-audit-and-security.md) — what gets logged and how
