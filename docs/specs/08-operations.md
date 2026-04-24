# 08 — Operations

## Configuration

### Layered YAML Config

```
config/
  default.yaml        # base config (checked into git)
  local.yaml          # local overrides (gitignored)
  production.yaml     # production overrides (gitignored or in ceo-deploy)
```

Config is merged in order: `default.yaml` ← `local.yaml` or `production.yaml` (based on `NODE_ENV`). Later files override earlier ones.

### Secret References

Secrets are never stored in config files. Reference them via environment variable interpolation:

```yaml
channels:
  signal:
    phone_number: ${SIGNAL_PHONE_NUMBER}
```

### Config Validation

The merged config is validated against a TypeScript-derived JSON Schema at startup. Missing required fields, unknown properties, and type mismatches produce clear error messages and prevent startup.

---

## Onboarding (New Instance Setup)

Setting up a new Curia deployment requires configuring channels, skills, and their secrets (API keys, OAuth tokens, Nylas credentials).

### `curia setup` CLI

A guided CLI command walks through each configured channel and skill, prompting for credentials:

```
$ curia setup
Curia Setup
===========

Coordinator persona:
  Display name [Curia]: Alex
  Tone [professional]: professional but warm

Setting up email channel (via Nylas)...
  Nylas API key: ********
  Nylas grant ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  Curia's email address: curia@yourdomain.com
  Testing connection... ✓ Connected (14 unread messages)
  Stored as NYLAS_API_KEY, NYLAS_GRANT_ID, NYLAS_SELF_EMAIL.

Setting up Google Calendar skill...
  This requires OAuth. Opening browser...
  ✓ Authorized. Token stored as GOOGLE_OAUTH_REFRESH_TOKEN.

Summary:
  ✓ Email channel ready
  ✗ Signal channel not configured (skipped)
  ✓ Google Calendar skill ready

Run 'docker compose up' to start Curia.
```

**How it works:** The CLI reads all channel adapter configs and skill manifests, identifies which secrets are required, checks which are already set, and prompts for the missing ones. It validates connectivity for each service before storing the secret. Adding a new integration = declaring `secrets` in a skill manifest, and `curia setup` automatically picks it up.

**Future:** A web-based onboarding wizard (via the HTTP API dashboard) with OAuth redirect flows and a visual status page.

---

## Deployment

### Local Development

```bash
docker compose up
```

Starts Postgres (with pgvector) + the framework. Config from `default.yaml` + `local.yaml`. Hot-reload in dev mode (restart on file change via `tsx --watch`).

### Production VPS

Docker container deployed via the existing `ceo-deploy` repo:
- Config from `default.yaml` + `production.yaml` + env vars from `.env`
- Single Docker image containing the framework + built-in skills
- MCP servers as separate containers if needed
- Caddy reverse proxy for HTTPS (already configured in ceo-deploy)

### Docker Compose Structure

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: curia
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 5s

  curia:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://${DB_USER}:${DB_PASSWORD}@postgres:5432/curia
      NODE_ENV: ${NODE_ENV:-development}
    env_file: .env
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s

volumes:
  pgdata:
```

---

## Health & Monitoring

### Health Endpoint

`GET /health` returns JSON:

```json
{
  "status": "healthy",
  "uptime_seconds": 86400,
  "database": { "connected": true, "latency_ms": 2 },
  "channels": {
    "signal": "connected",
    "email": "connected",
    "cli": "disabled"
  },
  "scheduler": {
    "active_jobs": 5,
    "suspended_jobs": 0,
    "next_due": "2026-03-25T09:00:00Z"
  },
  "last_audit_write": "2026-03-24T17:30:00Z"
}
```

Docker HEALTHCHECK uses this endpoint. Caddy can use it for upstream health.

### Structured Logging

All logging via pino (structured JSON):

```json
{
  "level": 30,
  "time": 1711300000000,
  "msg": "Agent task completed",
  "agent": "expense-tracker",
  "task_id": "abc-123",
  "duration_ms": 1250,
  "tokens": { "input": 1500, "output": 300 },
  "cost_usd": 0.003
}
```

**Log levels:**
- `error` — failures requiring attention
- `warn` — degraded but operational (channel reconnecting, budget nearing limit)
- `info` — lifecycle events (task started, task completed, channel connected)
- `debug` — detailed execution (LLM calls, skill invocations) — disabled in production by default

**No `console.log`** anywhere in the codebase. Enforced by lint rule.

### Graceful Shutdown

On SIGTERM/SIGINT:
1. Stop accepting new inbound messages
2. Wait for in-flight agent tasks to complete (up to 30s timeout)
3. Disconnect channel adapters
4. Close database connections
5. Exit

This ensures Docker stop and process managers don't lose in-flight work.

---

## Data Retention

A single-user CEO assistant generates ~425 audit log events/day (~850 KB). At this rate, the audit log reaches ~310 MB/year and ~1.5 GB after 5 years. All other tables combined add ~50 MB/year. On a 40 GB VPS disk, this is negligible.

**Strategy:**

- **Years 1-2:** No retention action needed. Let everything grow.
- **When `audit_log` exceeds 1 GB (~3 years):** Partition by month using Postgres declarative partitioning. Archive partitions older than 12 months to compressed JSONL files on disk. Archived data is still queryable via `COPY` or re-import — just not indexed for fast lookup.
- **`working_memory`:** Self-cleaning via TTL expiry. No retention concern.
- **`bullpen_threads` / `bullpen_messages`:** Low volume (~15 MB/year). Keep indefinitely — historical inter-agent discussions have reference value.
- **`kg_nodes` / `kg_edges`:** High-value data that only grows more useful over time. Never auto-delete. The temporal metadata (`confidence`, `decay_class`) handles staleness at the query layer, not the storage layer.
- **`scheduled_jobs`:** Recurring jobs update in place. Completed one-shot jobs can be cleaned up after 90 days (low priority, minimal space).

This is a conscious decision to defer retention infrastructure. The trigger to revisit is `audit_log` exceeding 1 GB, which won't happen before 2029 at current usage patterns.

---

## Database Migrations

Using `node-pg-migrate` with plain SQL migration files:

```
src/db/migrations/
  001_create_audit_log.sql
  002_create_kg_nodes.sql
  003_create_kg_edges.sql
  004_create_working_memory.sql
  005_create_bullpen.sql
  006_create_scheduled_jobs.sql
  007_create_agent_tasks.sql
  008_create_skill_approvals.sql
```

Migrations run automatically on startup (before the bus starts accepting events). Failed migrations prevent startup with a clear error.

---

## Project Structure

```
curia/
├── src/
│   ├── bus/                    # Message bus, event types, layer permissions
│   │   ├── bus.ts
│   │   ├── events.ts           # typed event definitions (discriminated union)
│   │   └── permissions.ts      # layer → event authorization map
│   ├── channels/               # Channel adapters
│   │   ├── cli/
│   │   ├── email/
│   │   ├── signal/
│   │   └── http-api/
│   ├── dispatch/               # Routing, policy enforcement
│   │   ├── router.ts
│   │   └── policy.ts
│   ├── agents/                 # Agent runtime, loader, LLM providers
│   │   ├── runtime.ts          # agent execution engine
│   │   ├── loader.ts           # YAML + handler loading, validation
│   │   ├── context.ts          # context assembly + budget management
│   │   ├── recovery.ts         # error recovery, pattern detection
│   │   └── llm/
│   │       ├── provider.ts     # common interface
│   │       ├── anthropic.ts
│   │       ├── openai.ts
│   │       └── ollama.ts
│   ├── execution/              # Skill invocation, MCP client, permission validation
│   │   ├── executor.ts
│   │   ├── mcp-client.ts
│   │   ├── sanitizer.ts       # output sanitization
│   │   └── secrets.ts          # ctx.secret() implementation
│   ├── memory/                 # All memory subsystems
│   │   ├── knowledge-graph.ts
│   │   ├── entity-memory.ts
│   │   ├── working-memory.ts
│   │   ├── bullpen.ts
│   │   ├── embeddings.ts       # pgvector integration
│   │   └── validation.ts       # dedup, contradiction, rate limit gates
│   ├── scheduler/
│   │   └── scheduler.ts
│   ├── audit/
│   │   ├── logger.ts           # write-ahead audit subscriber
│   │   └── redaction.ts        # payload redaction
│   ├── db/
│   │   ├── connection.ts
│   │   └── migrations/
│   └── index.ts                # bootstrap & startup orchestrator
├── agents/                     # Agent config files (YAML + optional handlers)
├── skills/                     # Local skill directories
├── config/                     # Layered YAML config
├── tests/
│   ├── unit/
│   └── integration/
├── docker-compose.yml
├── Dockerfile
├── package.json
└── tsconfig.json
```

### Key Files

- `src/index.ts` — Bootstrap orchestrator. Initializes all services in dependency order: DB → migrations → bus → audit → memory → scheduler → execution → agents → channels → dispatch. This is the single place where everything is wired together.
- `src/bus/events.ts` — The event type registry. All event types as a TypeScript discriminated union. This file is the source of truth for what flows through the system.
- `src/bus/permissions.ts` — The layer-to-event authorization map. Defines the hard security boundary.

---

## Implementation Status

| Item | Status |
|---|---|
| Layered YAML config — `default.yaml` / `local.yaml` / `production.yaml` with env var interpolation | Done |
| `docker-compose.yml` — postgres (pgvector) + curia services with healthchecks | Done |
| `Dockerfile` — multi-stage build, Node 22, tsx at runtime | Done |
| `GET /health` endpoint — database, agents, skills, uptime | Done |
| Structured logging via pino — correct log levels, no `console.log` | Done |
| No-`console.log` lint rule (ESLint `no-console: error`) | Done |
| Graceful shutdown — SIGTERM/SIGINT handler with ordered cleanup sequence | Done |
| DB migrations via `node-pg-migrate` — auto-run on startup | Done |
| Project directory structure — matches spec layout | Done |
| Config validation against JSON Schema at startup | Done |
| `curia setup` CLI — guided onboarding wizard for credentials and channel setup | Not Done |
