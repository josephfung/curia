# Health Observability Design

**Date:** 2026-06-23
**Issue:** [#434](https://github.com/josephfung/curia/issues/434)
**Branch:** `feat/health-observability`
**Status:** Approved — ready for implementation planning

---

## Context

Curia has zero external health visibility. Failures — revoked OAuth tokens, DB connectivity loss, bus stalls, a dead Signal socket, a crashed browser sidecar — are invisible until a user notices. This design adds the infrastructure to surface them before they cause user-visible failures.

This is Fix #3 of the Google Doc comment incident post-mortem. The monitoring layer is vendor-neutral; Better Stack is the recommended uptime monitor but any heartbeat-compatible service works.

---

## Architecture Overview

A new `src/health/` module owns all health logic. The `HealthService` is the single entry point, instantiated at bootstrap and injected with all service references it needs.

```
src/health/
  types.ts               — CheckResult, HealthStatus, HealthResponse, CanaryResult
  llm-outcome-tracker.ts — in-memory per-tier success/error recorder
  health-checks.ts       — individual probe functions (db, bus, email, signal, …)
  health-service.ts      — central class: getStatus(), runCanaries(), start()
```

**Data flow:**

```
Bootstrap → LlmOutcomeTracker (singleton)
              ↓ injected into
           TelemetryLlmProvider (records outcomes per tier on every call)

Bootstrap → HealthService({ db, bus, scheduler, emailAdapter?, signalRpcClient?,
                            browserService?, mcpLoader, llmOutcomeTracker, config.health })
              ↓ passed to
           HTTP adapter → GET /api/health → HealthService.getStatus()
              ↓ also registers
           SchedulerService → daily canary job → HealthService.runCanaries()
```

The existing `src/channels/http/routes/health.ts` becomes a thin shim that calls `getStatus()`. All probe logic moves into `HealthService`.

---

## Section 1: `/api/health` Endpoint

### Response Shape

Replaces the existing `{ status, database, agents, skills, uptime }`:

```json
{
  "status": "ok | degraded | down",
  "uptime_s": 3812,
  "checks": {
    "db":        "ok | fail",
    "bus":       "ok | fail",
    "signal":    "ok | fail | skipped",
    "email":     "ok | fail | skipped",
    "browser":   "ok | fail | skipped",
    "mcp":       { "google_workspace": "ok | fail | skipped" },
    "scheduler": "ok | fail"
  }
}
```

### Three-State Aggregation

| Condition | HTTP status | `status` |
|---|---|---|
| `db` or `bus` is `fail` | 503 | `"down"` |
| Any non-critical check is `fail` | 200 | `"degraded"` |
| All checks are `ok` or `skipped` | 200 | `"ok"` |

Non-critical checks: `signal`, `email`, `browser`, `mcp.*`, `scheduler`.
Critical checks: `db`, `bus`.

`skipped` never affects overall status.

### Boot-Correct State

`HealthService` records `startedAt: Date` on construction. On first request there is no cached optimistic state — every check either runs a live probe or correctly handles a null timestamp.

**Probe-based checks** (db, bus, signal, browser, mcp) — run the probe on every request. No cached state. Boot state is irrelevant.

**Time-based checks** (email, scheduler) — `lastEventAt` starts as `null`. Use `startedAt` as the baseline:
- `lastEventAt === null` AND `now - startedAt < grace_threshold` → `ok` (within startup window)
- `lastEventAt === null` AND `now - startedAt >= grace_threshold` → `fail`
- `lastEventAt !== null` → compare against configured stale threshold

Grace thresholds: `email_stall_factor × pollingIntervalMs` for email; `scheduler_max_tick_s` for scheduler.

---

## Section 2: Liveness Checks

All checks are standalone async functions in `health-checks.ts` with a hard 3s timeout (db: 2s) so a hanging sub-service never blocks the endpoint. Target: < 500ms total for a healthy system.

### `db`
`SELECT 1` against the existing pool with a 2s timeout. Fail on timeout or query error. **Critical.**

### `bus`
Check that the in-process EventEmitter has active listeners (bus not torn down). Synchronous. **Critical.**

### `signal`
`skipped` if signal not configured. Otherwise: call a lightweight RPC method (e.g. `listAccounts`) on `SignalRpcClient` with 3s timeout. Catches EACCES socket failures and hung daemons. **Non-critical.**

### `email`
`skipped` if email not configured. Otherwise: read `emailAdapter.lastSuccessfulPollAt` and apply boot-correct logic (Section 1). Threshold: `pollingIntervalMs × email_stall_factor`. **Non-critical.**

### `browser`
`skipped` if browser not configured. Otherwise: check `browserService.context?.isConnected() === true`. Synchronous Playwright API call. **Non-critical.**

### `mcp.google_workspace`
`skipped` if `google-workspace` not registered in skills config. Otherwise: call `tools/list` on the existing `McpClient` instance from `mcpLoader.getClient('google-workspace')` with 3s timeout. A null client (failed to connect at startup) is immediately `fail`. **Non-critical.**

> **Implementation note:** `McpLoader` may not currently expose a `getClient(name)` method. If not, add one that returns the `Client` instance for a named MCP server (or `null` if not connected).

### `scheduler`
Read `schedulerService.lastTickAt` (new property — see Section 5) and apply boot-correct logic. Threshold: `scheduler_max_tick_s`. **Non-critical.**

---

## Section 3: LLM Tier Outcome Tracking

### `LlmOutcomeTracker`

A new class in `src/health/llm-outcome-tracker.ts`:

```typescript
type Tier = 'fast' | 'standard' | 'powerful'

interface TierOutcome {
  lastSuccessAt: Date | null
  lastErrorAt: Date | null
}

class LlmOutcomeTracker {
  recordSuccess(tier: Tier): void
  recordError(tier: Tier): void
  getOutcome(tier: Tier): TierOutcome
}
```

Internal state: `Map<Tier, TierOutcome>`. All tiers start with `{ lastSuccessAt: null, lastErrorAt: null }`.

### Change to `TelemetryLlmProvider`

Inject `LlmOutcomeTracker` at construction. Add two calls:
- On success (alongside existing `llm.call` bus publish): `tracker.recordSuccess(tier)`
- On error (currently only logged): `tracker.recordError(tier)`

The tier is already available at call time via `model_routing` resolution.

### Canary Logic for LLM Tiers

```
if provider key for tier is missing         → fail
if lastErrorAt > lastSuccessAt              → fail   (most recent outcome was an error)
if lastSuccessAt is null AND lastErrorAt set → fail   (only outcome seen was an error)
otherwise                                   → ok     (idle tier or last call succeeded)
```

No time window. An idle tier (never called, key present, no errors) is `ok` by definition.

---

## Section 4: Daily Canary Job

Registered by `HealthService.start()` as a scheduler job on `canary_schedule` (default `"0 6 * * *"`).

### Canary Pattern

Each canary is independent (one failing doesn't skip the rest):

1. If service not configured → log `skipped`, done
2. Run probe
3. Log structured event at `info` (ok/skipped) or `error` (fail)
4. If `ok` AND heartbeat URL configured → `GET` the URL (5s timeout, no retry, warn on failure)
5. If `fail` → heartbeat service detects missed ping and alerts

### Canaries

| Canary key | Probe | Skipped when |
|---|---|---|
| `llm_fast` | `LlmOutcomeTracker` check for `fast` tier | Provider key for fast tier missing |
| `llm_standard` | `LlmOutcomeTracker` check for `standard` tier | Provider key for standard tier missing |
| `llm_powerful` | `LlmOutcomeTracker` check for `powerful` tier | Provider key for powerful tier missing |
| `embeddings` | `OPENAI_API_KEY` present + tracker outcome for embeddings calls | No `OPENAI_API_KEY` |
| `image_gen` | `OPENAI_API_KEY` present + tracker outcome for image_gen calls | No `OPENAI_API_KEY` |
| `nylas` | `listMessages(limit=1)` per configured grant, 5s timeout | No email configured |
| `signal` | Same lightweight RPC as liveness check | Signal not configured |
| `google_workspace` | Credential file readable + refresh token not expired | MCP server not registered |
| `tavily` | `tavily_api_key` present in config | Key not set |

**Note on embeddings/image_gen:** These use `OPENAI_API_KEY` + outcome tracking the same way LLM tiers do, but keyed by capability rather than tier. The `LlmOutcomeTracker` is extended with additional keys (`'embeddings'`, `'image_gen'`). The recording sites are the OpenAI embedding call site (in the KG semantic-search service, likely `src/memory/`) and the image-generation skill handler (`skills/image-generate/`). Both receive the tracker reference at construction and call `tracker.recordSuccess('embeddings')` / `tracker.recordError('embeddings')` (and equivalent for `image_gen`) on each call outcome. Implementation planning will confirm the exact files.

### Heartbeat Ping

Plain `GET` with 5s timeout, fire-and-forget. The heartbeat service owns alerting on missed pings. Curia only GETs on success.

---

## Section 5: Changes to Existing Services

### `SchedulerService` — add `lastTickAt`

Add `public lastTickAt: Date | null = null` to `SchedulerService`. Update it at the top of each watchdog pass. This is the only change to an existing service required by the liveness layer.

### `TelemetryLlmProvider` — inject `LlmOutcomeTracker`

Inject tracker at construction. Add `recordSuccess`/`recordError` calls on existing success and error paths. Two lines of new code.

### `src/channels/http/routes/health.ts` — thin shim

Replace existing probe logic with a call to `HealthService.getStatus()`. Set HTTP status based on `response.status === 'down'` → 503, otherwise 200.

### Bootstrap (`src/startup/` and `src/index.ts`)

Wire the new dependency chain:
1. Construct `LlmOutcomeTracker`
2. Pass to `TelemetryLlmProvider` constructor
3. Construct `HealthService` with all deps
4. Call `await healthService.start()` (subscribes to bus, registers canary job)
5. Pass `healthService` to HTTP adapter for route registration

---

## Section 6: Configuration

New `health:` block in `config/default.yaml`:

```yaml
health:
  # Thresholds for time-based liveness checks
  liveness:
    email_stall_factor: 3       # fail if last poll older than N × pollingIntervalMs
    scheduler_max_tick_s: 120   # fail if scheduler watchdog last ticked > N seconds ago

  # Cron schedule for the daily credential/dependency canary job (server local time)
  canary_schedule: "0 6 * * *"

  # Heartbeat URLs — GET on successful canary (Better Stack, Healthchecks.io, Cronitor, etc.)
  # LLM keys are tier-named so they survive a model_routing provider swap.
  # Leave empty to skip the ping (canary still runs and logs).
  heartbeats:
    llm_fast: ""
    llm_standard: ""
    llm_powerful: ""
    embeddings: ""
    image_gen: ""
    nylas: ""
    signal: ""
    google_workspace: ""
    tavily: ""
```

**Validation in `src/config.ts`:**
- `email_stall_factor` — positive integer ≥ 1
- `scheduler_max_tick_s` — positive integer
- Each non-empty heartbeat URL — valid `https://` URL; warn and null out if invalid (no startup crash)

---

## Section 7: Documentation

New file: `docs/dev/health-monitoring.md`

Contents:
- How to set up an uptime monitor at `https://office.josephfung.ca/api/health` — alert on 503 (`down`); optional softer alert on `"status":"degraded"` in body
- The three-state model and which checks are critical vs. non-critical
- How to create heartbeat checks in Better Stack (or any compatible service) and populate each `heartbeats.*` key in the env
- Why LLM heartbeat keys are tier-named (`llm_fast/standard/powerful`) not vendor-named
- Which checks/canaries report `skipped` and why

---

## Files Changed

| File | Change type |
|---|---|
| `src/health/types.ts` | New |
| `src/health/llm-outcome-tracker.ts` | New |
| `src/health/health-checks.ts` | New |
| `src/health/health-service.ts` | New |
| `src/channels/http/routes/health.ts` | Modified — thin shim |
| `src/agents/llm/telemetry-provider.ts` | Modified — +2 tracker calls |
| `src/scheduler/scheduler-service.ts` | Modified — +`lastTickAt` property |
| `src/startup/` + `src/index.ts` | Modified — bootstrap wiring |
| `config/default.yaml` | Modified — new `health:` block |
| `src/config.ts` | Modified — schema + validation |
| `docs/dev/health-monitoring.md` | New |

---

## Acceptance Criteria

From issue #434 — all items must pass before PR is merged:

- [ ] `GET /api/health` returns `200 {"status":"ok", ...}` when all enabled checks pass
- [ ] `GET /api/health` returns `200 {"status":"degraded", ...}` when a non-critical check fails but db and bus are healthy
- [ ] `GET /api/health` returns `503 {"status":"down", ...}` when db or bus is unreachable
- [ ] Each sub-service check reports `skipped` when not configured
- [ ] Endpoint responds in < 500ms under normal conditions and makes no billed/external calls
- [ ] signal check detects an unreachable/EACCES signal-cli socket
- [ ] browser check detects a disconnected Playwright service
- [ ] mcp.google_workspace check detects a dead MCP subprocess
- [ ] email check fails when last successful poll is older than `email_stall_factor` intervals
- [ ] scheduler check fails when last tick is older than `scheduler_max_tick_s`
- [ ] System does not report `ok` on boot before checks have run (boot-correct state)
- [ ] `TelemetryLlmProvider` records most-recent-call outcome (success and error) per tier
- [ ] Daily canary job runs on schedule and logs structured output for each enabled canary
- [ ] `llm_fast/standard/powerful` canaries fail when resolved provider key is missing or most recent recorded call was an error; idle tier (key present, no recent error) reports `ok`
- [ ] LLM tier canaries make no billed probe call
- [ ] `embeddings` and `image_gen` canaries key off `OPENAI_API_KEY` presence + most-recent-call outcome
- [ ] nylas, signal, google_workspace, and tavily canaries validate their credential and ping heartbeat on success
- [ ] Each canary pings heartbeat on success; skips ping when no URL configured or service not enabled
- [ ] Invalid heartbeat URL in config logs a warning but does not crash startup
- [ ] `default.yaml` includes `health:` block with liveness thresholds, canary schedule, and vendor-neutral heartbeat keys
- [ ] `docs/dev/health-monitoring.md` covers uptime monitor setup, three-state model, heartbeat config, and skipped checks
