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

## Adding new ADRs

1. Copy `template.md` to `NNN-short-title.md` (zero-pad to three digits)
2. Fill in Context, Decision, and Consequences
3. Add a row to the index above
4. If the ADR supersedes an earlier one, update the earlier ADR's status
