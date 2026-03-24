# Curia — Claude Code Instructions

## Project Overview

Curia is a multi-agent AI platform for executives. Architecture specs are in `docs/specs/`. Read `docs/specs/00-overview.md` first for the full picture.

## Architecture

Four hard-separated layers connected by a message bus. Every component declares its layer at startup; the bus enforces which event types each layer can publish/subscribe to.

- **Channel Layer** — translates platform messages (Telegram, Email, etc.) into normalized bus events
- **Dispatch Layer** — routes messages to agents, enforces policy, translates responses back
- **Agent Layer** — LLM-powered agents with isolated memory scopes
- **Execution Layer** — runs skills (local or MCP), validates permissions, sanitizes outputs

Cross-cutting: Audit Logger, Memory Engine, Scheduler.

## Code Conventions

### TypeScript
- ESM only (`"type": "module"`, `.js` extensions on all relative imports)
- Node 22+, use `import.meta.dirname` instead of `__dirname`
- No `any` — use proper types, generics, or discriminated unions
- All event types defined as discriminated unions in `src/bus/events.ts`
- All errors normalized to `AgentError` type (see `docs/specs/05-error-recovery.md`)

### Database
- PostgreSQL 16+ with pgvector
- Parameterized queries only — never interpolate variables into SQL strings
- Migrations in `src/db/migrations/` using node-pg-migrate (plain SQL)

### Error Handling
- No empty `catch {}` blocks — every catch must log, audit, and propagate
- Use structured `AgentError` types, not string matching
- Skills return `{ success: true, data }` or `{ success: false, error }` — never throw

### Logging
- pino for all logging (structured JSON)
- No `console.log` anywhere — enforced by lint rule
- Log levels: error, warn, info, debug

### Testing
- Vitest for unit and integration tests
- Integration tests use real Postgres (via Docker), not mocks
- Tests live next to the code they test, or in `tests/unit/` and `tests/integration/`

## Key Files

- `src/index.ts` — bootstrap orchestrator, wires everything in dependency order
- `src/bus/events.ts` — event type registry (discriminated union), source of truth
- `src/bus/permissions.ts` — layer-to-event authorization map (security boundary)
- `agents/*.yaml` — agent configuration files
- `skills/*/skill.json` — skill manifests
- `config/default.yaml` — base configuration

## Adding Things

### New Channel Adapter
1. Create `src/channels/<name>/` implementing `ChannelAdapter` interface
2. Register as `layer: "channel"` with the bus
3. Add config section to `config/default.yaml`
4. Write tests

### New Skill
1. Create `skills/<name>/skill.json` (manifest) + `handler.ts`
2. Declare permissions and secrets in the manifest
3. Write `handler.test.ts`

### New Agent
1. Create `agents/<name>.yaml` with required fields (name, description, model, system_prompt)
2. Optionally add `handler: ./<name>.handler.ts` for custom logic

## Scope Discipline

- Fix what was asked. Don't refactor surrounding code.
- If you spot issues nearby, mention them — don't touch them.
- No drive-by type annotations on code you didn't change.
