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
    "nylas_calendar": "ok | fail | skipped",
    "slack":     "ok | fail | skipped",
    "sms":       "ok | fail | skipped",
    "voice":     "ok | fail | skipped",
    "signal_voice": "ok | fail | skipped",
    "scheduler": "ok | fail"
  }
}
```

### Status values

| `status` | HTTP | Meaning |
|---|---|---|
| `ok` | 200 | All enabled checks pass |
| `degraded` | 200 | A non-critical service is down — that is, anything except `db` and `bus` |
| `down` | 503 | A critical service is unreachable (db or bus) — Curia cannot function |

`skipped` means a check's underlying service is not configured (e.g. Signal is disabled). Skipped checks never affect the overall status.

### Liveness probes

| Check | Probe | Skipped when |
|---|---|---|
| `signal` | Signal-cli RPC `listGroups()` | Signal client not configured |
| `email` | Last successful Nylas poll within stall window | Email adapter not constructed |
| `slack` | Socket Mode `connected` (with short boot grace) | Slack adapter not constructed (disabled / no tokens) |
| `sms` | Telnyx webhook handler installed | SMS adapter not constructed (disabled / no credentials) |
| `voice` | LiveKit RoomService `listRooms()` on the **management** URL | Voice adapter not constructed (disabled / incomplete credentials) |
| `signal_voice` | **Connects** to the shared PulseAudio socket (2s budget) | No `SIGNAL_PULSE_SOCKET_PATH` — the Signal call bridge was not constructed |
| `browser` | Bounded `cookies()` round-trip against Chrome (3s budget) | Browser service not constructed. `fail` when the context is null (stopped, or a failed crash-recovery relaunch) |
| `mcp.<server>` | `ping()` per enabled server (3s budget each, run concurrently) | Server disabled, so never attempted at boot |
| `nylas_calendar` | `listCalendars()` via the principal calendar grant | Calendar not configured |
| `scheduler` | Watchdog: last tick within `schedulerMaxTickS`, with a boot grace window | Never skipped |

**Three separate voice-adjacent probes, deliberately.** `signal` covers Signal *messaging*
(the JSON-RPC socket), `voice` covers *console* WebRTC (LiveKit), and `signal_voice` covers
Signal *calls* (the PulseAudio audio path). They fail independently and a green one tells you
nothing about the others.

**Probes assert a response, not existence.** `signal_voice` connects rather than stat'ing the
socket, because a socket inode outlives the daemon that created it — a dead PulseAudio daemon
left `/api/health` fully green for hours while Signal calls carried no audio. `browser` uses a
`cookies()` round-trip rather than the synchronous `isConnected()`, which reads cached
transport state and reports `true` for a wedged renderer. `mcp` uses `ping()` rather than
`listTools()`, which recompiled the MCP SDK's Ajv validators on every 30-second healthcheck and
leaked roughly 145 MB/hr into an OOM restart loop.

**Still shallow, and worth knowing:** `slack` reads cached socket state, and `sms` only asserts
the Telnyx webhook handler is installed — neither proves inbound reachability. Proving that
would mean adding a third-party network dependency to an endpoint hit every 30 seconds, so it
belongs in a periodic canary instead. A health check must never cost money or emit traffic.

### Which checks are critical vs. non-critical

**Critical (down → 503):** `db`, `bus`
**Non-critical (degraded → 200):** `signal`, `email`, `browser`, `mcp.*`, `nylas_calendar`, `slack`, `sms`, `voice`, `signal_voice`, `scheduler`

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
| `nylas_calendar` | `listCalendars()` via the principal calendar client (`ceo_nylas_grant_id`) | Calendar not configured (no `NylasCalendarClient`) |
| `signal` | Signal-cli socket ping | Signal not configured |
| `google_workspace` | Credential file readable + refresh token not expired | MCP server not registered |
| `tavily` | `TAVILY_API_KEY` present in environment | Key not injected into `HealthService` (not yet wired from vault; always skipped in current build) |

### LLM canaries make no billed calls

The LLM tier canaries read the outcome of the most recent *real* call to that tier (recorded by the telemetry layer). An idle tier (key configured, no calls made yet, no errors) is always `ok`. The canary only fails if the most recent recorded call was an error.
