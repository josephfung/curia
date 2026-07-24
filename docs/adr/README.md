# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Curia project.

ADRs document the reasoning behind key technical decisions — who made them, why, and what trade-offs were accepted. They prevent relitigating settled decisions and give future contributors context that isn't visible in the code.

## Format

Each ADR follows the [Nygard format](https://adr.github.io/):

- **Context** — what problem or question prompted the decision
- **Decision** — what was chosen and why
- **Consequences** — what becomes easier or harder as a result

## Status values

- **Accepted** — in force; the current approach
- **Deprecated** — no longer relevant but kept for historical record
- **Superseded by ADR-NNN** — replaced by a later decision

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [001](001-postgres-over-sqlite.md) | Postgres over SQLite | Accepted |
| [002](002-message-bus-over-direct-calls.md) | Message bus over direct calls | Accepted |
| [003](003-yaml-agent-config-with-typescript-escape-hatch.md) | YAML agent config with TypeScript escape hatch | Accepted |
| [004](004-pgvector-over-dedicated-vector-db.md) | pgvector over dedicated vector DB | Accepted |
| [005](005-node-pg-migrate-over-knex.md) | node-pg-migrate over Knex for migrations | Accepted |
| [006](006-custom-framework-over-existing-agents.md) | Build custom framework over adopting existing agent frameworks | Accepted |
| [007](007-anthropic-primary-llm-provider-agnostic-interface.md) | Anthropic as primary LLM with provider-agnostic interface | Accepted |
| [008](008-openai-embeddings-for-knowledge-graph.md) | OpenAI text-embedding-3-small for knowledge graph embeddings | Accepted |
| [009](009-nylas-for-email.md) | Nylas as email integration layer | Accepted |
| [010](010-signal-over-telegram.md) | Signal as high-trust messaging channel, rejecting Telegram | Accepted |
| [011](011-score-based-autonomy-engine.md) | Score-based autonomy engine over capability-based permissions | Accepted |
| [012](012-llm-as-judge-evaluation.md) | LLM-as-judge for outbound safety and smoke test evaluation | Accepted |
| [013](013-signal-cli-daemon-mode.md) | signal-cli daemon socket mode for Signal integration | Accepted |
| [014](014-capability-tier-model-routing.md) | Capability-tier model routing over per-agent model declarations | Accepted |
| [015](015-llm-as-judge-intent-drift.md) | LLM-as-judge for intent drift detection | Accepted |
| [016](016-mcp-sdk-dependency.md) | Official MCP SDK over hand-rolled transport; registry-transparent skill integration | Accepted |
| [017](017-ceo-authorized-action-pattern.md) | CEO-authorized action pattern: task-origin check + `humanApproved` flag over per-action gateway methods | Accepted |
| [018](018-curia-initiated-approval-requests.md) | Curia-initiated approval requests via unified `autonomy_action_log` state machine | Accepted |
| [019](019-delegation-aware-outbound-context.md) | Delegation-aware outbound context via a dedicated registry (replaces v1 context-memo) | Accepted |
| [020](020-secrets-vault.md) | Application-layer AES-256-GCM secrets vault in PostgreSQL — structural typing, per-invocation pre-warm cache, env-var fallback for incremental migration | Accepted |
| [021](021-vault-only-secret-resolution.md) | Vault-only secret resolution — remove the env fallback; only the four vault-bootstrap values stay in `.env`, everything else seeds via `seed-vault` | Accepted |
| [022](022-skill-agent-registry.md) | DB-gated skill/agent registry — install/enable lifecycle with startup reconciliation and restart-based enforcement | Accepted |
| [023](023-bullpen-consult-and-resume.md) | Async bullpen consult-and-resume convention — tap/park/resume over existing bullpen primitives, no new event types | Accepted |
| [024](024-plan-rows-direct.md) | Plan primitive writes child rows directly (rows-direct) — not coordinator-proposed trees | Accepted |
| [025](025-conversation-id-reversible-text-key.md) | `conversation_id` is a reversible TEXT key, not a UUID v5 — reject the #16 migration, reconcile specs to reality | Accepted |
| [027](027-structured-secret-subfield-addressing.md) | Structured secrets with schema-tagged sub-field addressing — `secret_ref#field` projections gated to a registered schema, shipping `credit_card` first | Accepted |
| [028](028-shared-unbound-agent-memory.md) | Shared, unbound agent memory — remove the inert `memory.scopes` field; govern access by capability gating + sensitivity tiers + provenance, not per-agent scopes | Accepted |
| [029](029-passive-email-observation-and-counterfactual-competence.md) | Passive email observation with counterfactual (shadow) competence as a Phase 3 input — reuse existing stores, no new memory types | Accepted |
| [030](030-per-task-warm-browser-session.md) | Opt-in, per-task warm browser session (`keep_warm`) — reject a global canonical session (collision); profile-level warmth stays always-on | Accepted |
| [031](031-tools-vs-skills-vocabulary.md) | Tools vs skills vocabulary — atom rename to **tool**; free **skill** for collections (Phase 1 of #1436) | Accepted |
| [032](032-polymorphic-pins-and-mcp-as-skill.md) | Polymorphic capability pins (skill \| tool \| future MCP) + MCP servers project skills into `SkillRegistry` — prerequisites for #1494 | Accepted |
| [033](033-slack-channel-socket-mode.md) | Slack via Socket Mode — workspace-owned app, DMs + @mentions + in-thread continuation, sender-identity trust, `inbound.reaction` | Accepted |
| [034](034-channel-contributed-principal-carveout-registry.md) | Channel-contributed principal carve-out registry — Gate C opt-in without scattering fail-closed logic | Accepted |
| [035](035-channel-owned-outbound-recipient-projection.md) | Channel-owned outbound recipient projection — request variants + `extractRecipients` so the gateway needs no per-channel projection edit | Accepted |

## Adding new ADRs

1. Copy `template.md` to `NNN-short-title.md` (zero-pad to three digits)
2. Fill in Context, Decision, and Consequences
3. Add a row to the index above
4. If the ADR supersedes an earlier one, update the earlier ADR's status
