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
vault** (vault-first; see [spec 03 — Secrets Access](03-tools-and-execution.md#secrets-access)
and ADR-020/021). Only four bootstrap values live in `.env`, because they are needed to reach
and unlock the vault itself: `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`, `DB_USER`, `DB_PASSWORD`.
(Alongside these, `.env` also holds non-secret operational config such as `HTTP_PORT`,
`POSTGRES_PORT`, `NYLAS_POLL_INTERVAL_MS`, `TIMEZONE`, and the Google OAuth client settings.
The principal's email is not env config — it lives in the contacts store, resolved via
`system_role = 'principal'`, since #1049.)

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

### Self-Host (Published Images)

Each Curia release is published as signed, multi-arch container images to the GitHub Container
Registry, so operators can run a released Curia with no source checkout and no Node/pnpm/openssl
toolchain on the host — Docker (with the Compose plugin) and `curl` are the only requirements.

**Published images** (`.github/workflows/docker-publish.yml`):

- `ghcr.io/josephfung/curia` — the app image (built from `Dockerfile`).
- `ghcr.io/josephfung/curia-postgres` — Postgres 16 with pgvector + pgAudit and the
  init SQL baked in (built from `docker/postgres.Dockerfile`), so the hardened DB is
  source-free and unified with dev/prod.

Both images are built for `linux/amd64` + `linux/arm64` and signed with **cosign**
(keyless, via GitHub OIDC — no long-lived signing key). Tagging:

- **Push to `main`** → `:edge` on both images (for dogfood use).
- **Release published** → app gets `vX.Y.Z`, `vX.Y`, and `latest`; the DB image gets
  `pg16` and `latest` (versioned by Postgres major, not app semver).
- **Manual dispatch** with a `tag` input → that release's source is rebuilt and pushed
  under its semver tags **only**. `edge`, `latest`, and `pg16` are floating "newest"
  pointers, and a re-publish names an arbitrary older tag, so a dispatch never moves
  them — doing so shipped old code past migrations that had already run (#1715). A
  dispatch with **no** `tag`, launched from `main`, behaves exactly like a push to
  `main`; from any other branch it is refused (see *Re-publishing a release by hand*
  below).
- The tag being built is resolved once (in the `resolve` job) and validated against
  strict semver before checkout, and every downstream tag decision keys off that rather
  than off `github.ref`, which on a dispatch names the launch branch and not the built
  source (mirrors `release.yml`).

**Re-publishing a release by hand.** There are two ways to name the tag, and they are
equivalent — `resolve` normalises both to one publish target (#1718):

1. Leave "Use workflow from" on `main` and type the tag into the `tag` input.
2. Select the tag itself in the "Use workflow from" dropdown and leave `tag` empty.

**Prefer (1).** The dropdown also chooses which *version of the workflow file* runs, so
(2) re-publishes an old release using that release's copy of `docker-publish.yml`,
missing every fix landed since — the wrong direction on an incident-response path.

`resolve` refuses anything outside those two shapes, rather than publishing on a guess:

- both boxes filled with **different** tags — ambiguous;
- a `tag` input dispatched from a **branch other than `main`** — it would publish a real
  release image while running that branch's unreviewed copy of the workflow, and the
  branch most likely to be selected is one editing that very file;
- a **bare dispatch from a branch other than `main`** — `edge` may only ever mean main and
  no tag was named, so the run has nothing it could publish. This was previously a green
  run that skipped both images with a notice, which is a publish workflow reporting
  success having published nothing (#1718).

A rejection fails `resolve` and leaves `build` *skipped*, so no publish-failure issue is
filed — an operator mis-click is a typo, not an incident.

Concurrency groups keep a release in its own namespace. A release publishes `latest` and
`pg16`; a re-publish of that same tag deliberately does not. With `cancel-in-progress`,
sharing a group would let an impatient re-publish cancel the release build still in
flight and strand the floating pointers on the previous version, with no alert —
`notify-failure` excludes cancellation. Only a run publishing a superset may cancel one
publishing a subset.

**`install.sh` — the supported self-host path** (`install.sh`, download-then-run; it uses
interactive `read` prompts, so `curl … | bash` does not work). The script:

1. Verifies prereqs (Docker daemon, Compose plugin, `curl`) — no Node/pnpm/openssl.
2. Fetches the compose bundle next to itself, skipping files already present:
   `docker-compose.yml`, `docker-compose.tls.yml`, `.env.example`, `deploy/Caddyfile`,
   and `scripts/setup-common.sh` (shared helpers).
3. Creates `.env` from the example and **generates secrets** for placeholder values
   (`DB_PASSWORD`, `SECRET_ENCRYPTION_KEY`; an existing real DB password or encryption
   key is preserved, never rotated). `api_token` and the web-app bootstrap secret are
   generated too but passed only as transient env vars — never written to `.env`.
4. Prompts for an Anthropic API key (format-validated, 3 retries; passed transiently).
5. Prompts for **deployment topology**: local/eval (HTTP on `:3000`), public domain +
   HTTPS (Caddy + Let's Encrypt), or public IP / own upstream proxy. The HTTPS choice
   requires a `DOMAIN` and sets `COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml`
   durably in `.env` so the overlay is applied on every subsequent `docker compose`.
6. Starts Postgres, then runs **migrations and vault-seed *inside* the pulled image**
   via `docker compose run --rm curia ./node_modules/.bin/tsx …` (tsx invoked directly —
   the runtime image deliberately ships no corepack/pnpm). Vault-seed runs with
   `SEED_VAULT_VERIFY=1`, so a partial seed fails loudly instead of booting a
   half-configured instance.
7. Brings the full stack up, waits for `/api/health`, writes a `SETUP_COMPLETE` marker
   to `.env`, and **prints a summary box** with the bootstrap secret the operator uses
   to sign in.

Re-running against a completed install (detected via the `SETUP_COMPLETE` marker) takes a
non-rotating upgrade path: no secrets are regenerated, migrations re-apply idempotently,
and vault-seed runs verify-only.

The **optional Caddy TLS overlay** (`docker-compose.tls.yml`) adds a `caddy:2-alpine`
service that terminates HTTPS with automatic Let's Encrypt certificates, reading `DOMAIN`
from `.env` and the `deploy/Caddyfile`. TLS matters because Curia auth (bootstrap secret,
API token, session cookies) must not cross the wire in cleartext on a public host.

### Runtime

- Config merges `default.yaml` + `production.yaml` + env vars from `.env`, selected by `NODE_ENV`.
- **Node 24 (Active LTS).** Both the Dockerfile build and runtime stages use `node:24-slim` (digest-pinned). The global `npm install` step was removed — bundled npm is unused (corepack/pnpm handle the build, tsx runs the app), so there is nothing to install globally.
- **Non-root execution** — the image runs as a dedicated `curia` user, not root. The Dockerfile creates the user in the build stage and pre-creates any directories the process needs at runtime (e.g., `/tmp/.google_workspace_mcp`).
- MCP servers run as separate containers where needed.
- HTTPS is terminated by the Caddy TLS overlay (see *Self-Host* above).

### Docker Compose Structure

`docker-compose.yml` references the **published GHCR images by default** (no `build:`), so an
operator pulls rather than builds. Developers restore local source builds by layering
`docker-compose.dev.yml` (which re-adds `build:` for both services); `pnpm run setup` does this
automatically.

```yaml
services:
  postgres:
    # Published pgvector + pgAudit image (init SQL baked in)
    image: ghcr.io/josephfung/curia-postgres:${CURIA_POSTGRES_TAG:-pg16}
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
    # Published app image (developers override with docker-compose.dev.yml → build: .)
    image: ghcr.io/josephfung/curia:${CURIA_IMAGE_TAG:-latest}
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://${DB_USER}:${DB_PASSWORD}@postgres:5432/curia
      NODE_ENV: ${NODE_ENV:-development}
    env_file: .env
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s

volumes:
  pgdata:
```

The optional `docker-compose.tls.yml` overlay adds a `caddy` service for automatic HTTPS
(see *Self-Host* above), selected durably via `COMPOSE_FILE` in `.env`.

The base compose also includes an independent `livekit` service for the Voice
channel behind the Compose `voice` profile (`docker compose --profile voice up`).
Plain `docker compose up` does not start it. Curia does not depend on it at
container startup; operators enable the profile only when Voice is configured.

---

## Health & Monitoring

### Health Endpoint

`GET /api/health` (unauthenticated, rate-limited to 60 req/min) returns a three-state status with per-check detail:

```json
{
  "status": "ok",
  "uptime_s": 3812,
  "checks": {
    "db": "ok",
    "bus": "ok",
    "signal": "ok",
    "email": "ok",
    "browser": "skipped",
    "mcp": { "google_workspace": "ok" },
    "scheduler": "ok"
  }
}
```

`status` is one of:
- `ok` (HTTP 200) — all enabled checks pass.
- `degraded` (HTTP 200) — a *non-critical* service is down (`signal`, `email`, `browser`, `mcp.*`, or `scheduler`). A dead Signal socket should not page as a full outage when email still works.
- `down` (HTTP 503) — a *critical* service is unreachable (`db` or `bus`); Curia cannot function.

A `skipped` check means its underlying service is not configured (e.g. Signal disabled) and never affects the overall status. Docker HEALTHCHECK and Caddy upstream health both use this endpoint.

A daily credential **canary** job complements the endpoint: it validates each enabled LLM tier, credential, and external dependency, then pings configured heartbeat URLs on success (a missed ping pages the monitoring service). The LLM tier canaries read the most recent recorded call outcome rather than making a billed probe. See [../dev/health-monitoring.md](../dev/health-monitoring.md) for the full check list, status semantics, and uptime-monitor setup.

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

### Web Console Chat API

As of v0.35.0, `POST /api/kg/chat/messages` acknowledges with `202 { conversationId }` immediately after publishing the inbound message, rather than blocking on a synchronous wait for the agent's reply. The reply and intermediate progress events stream back over the existing `GET /api/kg/chat/stream` SSE endpoint. This removes the old 120s synchronous wait, so long agent tasks (browser automation, multi-agent delegation chains, research) no longer hit a 504 timeout. Rate-limited chat requests return `429`.

---

## CI Security Scanning

Automated security scanning runs on every pull request and on a weekly schedule:

- **Trivy** — filesystem scan (npm dependencies and leaked secrets) runs on every PR and push to main. Docker image scan runs on a weekly schedule only (building the image on every PR is too slow). Results are uploaded as SARIF to GitHub's Security tab.
- **Semgrep CE** — pattern-based SAST for JavaScript/TypeScript. Initial triage suppressed 28 false positives; ongoing results appear in the Security tab.
- **CodeQL** — weekly JS/TS semantic analysis.
- **Gitleaks** — blocks merge if hardcoded secrets are detected in the diff.
- **OpenSSF Scorecard** — `.github/workflows/scorecard.yml` runs weekly and on push. It publishes SARIF to GitHub's Security tab and to securityscorecards.dev, and the score is surfaced via an OpenSSF badge in the README.
- **SBOM + DAST** — `sbom.yml` generates a dependency SBOM, and `dast.yml` runs an OWASP ZAP passive scan against the booted HTTP API. Together with the on-demand Docker image scan, a fresh CodeQL pass, and Scorecard, these form the pre-release security gate run against `main` before cutting a release (`docker-publish.yml` also emits provenance + an SBOM per published image).

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
