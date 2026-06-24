# Health Monitoring

Curia exposes a three-state health endpoint and a daily credential canary that feed external uptime monitors. This guide covers setup for operators.

## The `/api/health` endpoint

`GET https://<your-domain>/api/health` — unauthenticated. Rate-limited to 60 req/min.

### Response

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

### Status values

| `status` | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | All enabled checks pass |
| `degraded` | 200 | A non-critical service is down (signal, email, browser, MCP, scheduler) |
| `down` | 503 | A critical service is unreachable (db or bus) — Curia cannot function |

`skipped` means a check's underlying service is not configured (e.g. Signal is disabled). Skipped checks never affect the overall status.

### Which checks are critical vs. non-critical

**Critical (down → 503):** `db`, `bus`
**Non-critical (degraded → 200):** `signal`, `email`, `browser`, `mcp.*`, `scheduler`

Rationale: a dead Signal socket should not page as a full outage when email still works.

## Setting up an uptime monitor (Better Stack / Healthchecks.io / etc.)

1. Create an **uptime monitor** pointing at `https://<your-domain>/api/health`.
2. Set the alert condition to **HTTP status != 200** (triggers on `down`/503).
3. Optionally, add a second **keyword check** monitor that alerts when the response body contains `"status":"degraded"` — this gives a softer warning for non-critical failures.

## Daily canary job + heartbeat URLs

The canary job runs daily (default 06:00 server time, configurable via `health.canary_schedule` in `config/default.yaml`) and:

1. Checks that each enabled credential/dependency is valid
2. On success, GETs a heartbeat URL — the monitoring service pages on missed pings

To configure, add URLs to the `health.heartbeats` block in `config/default.yaml`:

```yaml
health:
  heartbeats:
    llm_fast: "https://uptime.betterstack.com/api/v1/heartbeat/<token>"
    nylas:    "https://uptime.betterstack.com/api/v1/heartbeat/<token>"
    # etc.
```

Each URL must be `https://`. Non-https URLs are silently ignored at startup.

### Why LLM keys are tier-named (`llm_fast`, `llm_standard`, `llm_powerful`)

The heartbeat key identifies the capability tier, not the vendor. If you remap `standard` from Claude to an OpenRouter model, the heartbeat URL for `llm_standard` still works correctly — the canary queries the model routing config to find the current provider.

### What each canary checks

| Key | Probe | Skipped when |
|---|---|---|
| `llm_fast/standard/powerful` | Last recorded call outcome for that tier (no billed probe call) | No model configured for that tier in `modelRoutingConfig.tiers` |
| `embeddings` | Last recorded embedding call outcome | No `OPENAI_API_KEY` |
| `image_gen` | Last `image-generate` skill outcome | No `OPENAI_API_KEY` |
| `nylas` | `listMessages(limit=1)` via the injected Nylas client | Email not configured (no `NylasClient` provided) |
| `signal` | Signal-cli socket ping | Signal not configured |
| `google_workspace` | Credential file readable + refresh token not expired | MCP server not registered |
| `tavily` | `TAVILY_API_KEY` present in environment | Key not injected into `HealthService` (not yet wired from vault; always skipped in current build) |

### LLM canaries make no billed calls

The LLM tier canaries read the outcome of the most recent *real* call to that tier (recorded by the telemetry layer). An idle tier (key configured, no calls made yet, no errors) is always `ok`. The canary only fails if the most recent recorded call was an error.
