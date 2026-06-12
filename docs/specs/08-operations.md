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

Secrets are never stored in config files. Application secrets resolve from the **encrypted
vault** (vault-first; see [spec 03 — Secrets Access](03-skills-and-execution.md#secrets-access)
and ADR-020/021). Only four bootstrap values live in `.env`, because they are needed to reach
and unlock the vault itself: `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`, `DB_USER`, `DB_PASSWORD`.
(Alongside these, `.env` also holds non-secret operational config such as `HTTP_PORT`,
`POSTGRES_PORT`, `NYLAS_POLL_INTERVAL_MS`, `TIMEZONE`, `CEO_PRIMARY_EMAIL`, and the Google OAuth
client settings.)

Config files may still reference an env var via interpolation where the value is genuinely an
environment value rather than a secret:

```yaml
channels:
  signal:
    phone_number: ${SIGNAL_PHONE_NUMBER}
```

> **Note:** A value like `signal_phone_number` is a *secret* and is read from the vault at
> runtime. The env-var form is a bootstrap fallback / seeding affordance, not the primary
> resolution path.

**Seeding the vault:** `pnpm run setup` seeds the vault automatically after migrations on a fresh
install. To add or update a single secret later, supply it as a transient env var and run the
seeder: `VAR=value pnpm run seed-vault` (e.g. `NYLAS_API_KEY=nyk_... pnpm run seed-vault`).
`setup.sh` runs the seeder with `SEED_VAULT_VERIFY=1`, which aborts the install if a required
secret did not land. To rotate the encryption key, re-encrypt every row with
`SECRET_ENCRYPTION_KEY_OLD=<b64> SECRET_ENCRYPTION_KEY_NEW=<b64> DATABASE_URL=<url> pnpm exec tsx scripts/rotate-secret-key.ts`.

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
- **Non-root execution** — the production image runs as a dedicated `curia` user, not root. The Dockerfile creates the user in the build stage and pre-creates any directories the process needs at runtime (e.g., `/tmp/.google_workspace_mcp`).
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

## CI Security Scanning

Automated security scanning runs on every pull request and on a weekly schedule:

- **Trivy** — filesystem scan (npm dependencies and leaked secrets) runs on every PR and push to main. Docker image scan runs on a weekly schedule only (building the image on every PR is too slow). Results are uploaded as SARIF to GitHub's Security tab.
- **Semgrep CE** — pattern-based SAST for JavaScript/TypeScript. Initial triage suppressed 28 false positives; ongoing results appear in the Security tab.
- **CodeQL** — weekly JS/TS semantic analysis.
- **Gitleaks** — blocks merge if hardcoded secrets are detected in the diff.
- **OpenSSF Scorecard** — `.github/workflows/scorecard.yml` runs weekly and on push. It publishes SARIF to GitHub's Security tab and to securityscorecards.dev, and the score is surfaced via an OpenSSF badge in the README.

### Supply-Chain Hardening

- **SHA-pinned GitHub Actions** — every action in every workflow is pinned to a full 40-character commit SHA (not a floating tag). Dependabot keeps these pins current.
- **Least-privilege `GITHUB_TOKEN`** — token permissions are scoped at the job level rather than granted broadly at the workflow level.
- **SHA-pinned Docker base images** — base images in the Dockerfile are pinned by SHA-256 digest, and the `docker` ecosystem is enabled in Dependabot so digest bumps are proposed automatically.

### Branch Protection

The `main` branch requires:
- Pull request review before merge
- Status checks to pass (CI, security scans)

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

Using `node-pg-migrate` with plain SQL migration files in `src/db/migrations/`, numbered
sequentially with a three-digit prefix (`NNN_<description>.sql`). Run `ls src/db/migrations/`
for the authoritative, current list rather than relying on a snapshot here — the set grows
with every schema change (recent examples: `048_add_contact_canonical_attributes.sql`,
`049_promote_agent_tasks_to_tasks.sql`).

> **Prefix uniqueness is load-bearing.** `node-pg-migrate` sorts alphabetically within a
> prefix, so two branches landing the same number cause a `checkOrder` failure on startup.
> See the migration-numbering note in [CLAUDE.md](../../CLAUDE.md).

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
│   │       ├── openrouter.ts   # OpenRouter API (Gemini Flash, DeepSeek, GPT-4o)
│   │       ├── model-registry.ts # ModelRegistry — centralized model metadata
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
| Non-root container — production image runs as `curia` user | Done |
| Trivy scanning — filesystem (npm deps + secrets) on every PR; Docker image scan weekly | Done |
| OpenSSF Scorecard workflow (`scorecard.yml`) — weekly + push, SARIF to Security tab + securityscorecards.dev, README badge | Done |
| GitHub Actions pinned to 40-char commit SHAs (Dependabot-maintained) | Done |
| `GITHUB_TOKEN` permissions scoped at job level (least privilege) | Done |
| Docker base images pinned by SHA-256 digest; `docker` ecosystem added to Dependabot | Done |
| Encrypted secrets vault for application secrets; 4 bootstrap env vars in `.env`; `seed-vault` seeding | Done |
| Branch protection on `main` — required PR review + passing status checks | Done |
| `CURIA_TEMPFILE_DIR` env var — base directory for the `file-parse` `temp_file_url` path validation (see [spec 03](03-skills-and-execution.md)) | Done |
| `qs` pinned to ≥ 6.15.2 — closes CVE-2026-8723 | Done |
| `package-lock.json` (and `yarn.lock`) gitignored — pnpm is the source of truth | Done |
| `workspace-mcp` upgraded to the `complete` tier — Sheets `create_sheet` and `append_table_rows` available | Done |
| `curia setup` CLI — guided onboarding wizard for credentials and channel setup | Not Done |
