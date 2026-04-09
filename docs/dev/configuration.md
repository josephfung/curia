# Configuration Reference

Curia is configured through two complementary mechanisms:

- **`.env`** — secrets and environment-specific values (API keys, database URL, port). Never committed to version control.
- **`config/default.yaml`** — tuning knobs and feature flags that are safe to commit. Defaults are set here; `.env` overrides nothing in this file — the two are independent.

Changes to `default.yaml` take effect on restart. Changes to `.env` also require a restart.

---

## `config/default.yaml` — full reference

### `channels`

Controls which channel adapters activate at startup.

```yaml
channels:
  cli:
    enabled: true   # Set to false to disable the terminal CLI entirely
```

Signal and email are **not** controlled here — they activate based on environment variables (`SIGNAL_PHONE_NUMBER`, `NYLAS_API_KEY`, etc.). See [setup.md](setup.md) for details.

---

### `browser`

Controls the lifetime of browser sessions used by skills like `browser-navigate`.

```yaml
browser:
  sessionTtlMs: 600000    # How long a session stays alive after its last action (ms). Default: 10 minutes.
  sweepIntervalMs: 120000 # How often the session cleanup sweep runs (ms). Default: 2 minutes.
```

Raise `sessionTtlMs` if skills that open browser sessions are timing out mid-task. Lower it to free resources faster on memory-constrained deployments.

---

### `agents`

Points to agent YAML config files. Currently only the coordinator is configurable here.

```yaml
agents:
  coordinator:
    config_path: agents/coordinator.yaml
```

You generally don't need to change this unless you're testing a different coordinator config in place.

---

### `dispatch`

Controls the conversation checkpoint pipeline — the debounced background process that runs relationship extraction and other memory tasks after conversations go quiet.

```yaml
dispatch:
  conversationCheckpointDebounceMs: 600000  # Default: 10 minutes
```

Lower this to run memory extraction sooner after conversations end. Raise it on slow or cost-sensitive deployments to batch more activity before triggering extraction.

---

### `workingMemory`

Controls rolling context summarization (spec §01-memory-system.md). Agents that run long conversations will eventually exceed their LLM's context window. Summarization prevents this by condensing old turns into a compact narrative and archiving the originals.

```yaml
workingMemory:
  summarization:
    threshold: 20   # Active turns that trigger a summarization pass. Default: 20.
    keepWindow: 10  # Most-recent turns to retain as active after summarization. Default: 10.
```

**How it works:** After each turn is written to working memory, if the active (non-archived) turn count exceeds `threshold`, the oldest `count - keepWindow` turns are sent to the LLM to condense into a summary. The originals are marked `archived = true` in Postgres (retained for audit) and replaced in active context by a synthetic system turn containing the summary. Subsequent LLM calls see: summary turn → most recent `keepWindow` turns → new user message.

**Tuning guidance:**
- `threshold` should be well below your model's practical context limit. At 20 turns, a typical conversation is 2,000–6,000 tokens of history — comfortable headroom even with large system prompts and tool outputs.
- `keepWindow` controls recency. 10 turns gives the agent immediate conversational context. Lower values reduce context pressure; higher values preserve more recent detail at the cost of a longer active window.
- `keepWindow` must always be less than `threshold` — Curia validates this at startup and exits with an error if violated.

**Disabling:** Remove the `workingMemory` block entirely (or omit `summarization`). Summarization is opt-in by presence of the config block.

---

### `skillOutput`

Controls truncation of skill results before they're included in LLM context.

```yaml
skillOutput:
  maxLength: 200000  # Default: 200,000 characters (~50k tokens at 4 chars/token)
```

Skills that return large payloads (web search results, long calendar lists, crawled pages) are clipped to this length with a truncation note appended. Raise the limit if skills are cutting off important results. Lower it on installations with tight context budgets or many concurrent agents.

---

### `security`

Extra prompt injection detection patterns applied to every inbound message, in addition to the built-in defaults.

```yaml
security:
  extra_injection_patterns:
    - regex: "forget everything above"
      label: "forget everything above"
    - regex: "new\\s+persona"
      label: "new persona"
```

Each entry needs:
- `regex` — a JavaScript regex string (case-insensitive matching is applied automatically)
- `label` — a human-readable name that appears in the audit log when the pattern fires

Built-in defaults already cover the most common injection attempts (`ignore previous instructions`, `you are now`, `act as`, etc.). Add entries here for patterns specific to your deployment or user base.

> **⚠️ ReDoS warning:** Avoid patterns with unbounded nested quantifiers like `(a+)+` or `(.+)+`. These can cause catastrophic backtracking on adversarial input and freeze the Node.js event loop. Prefer simple bounded patterns. These patterns run on every inbound message in the main process.

Changes take effect on restart.

---

## Environment variables (`.env`)

Environment variables control secrets and deployment-specific values that must not be committed. A full list with descriptions lives in `.env.example` at the repo root. Key variables:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string |
| `ANTHROPIC_API_KEY` | Yes | Powers all agents |
| `API_TOKEN` | Yes | Authenticates HTTP API requests |
| `WEB_APP_BOOTSTRAP_SECRET` | Yes | Web app login secret |
| `TIMEZONE` | Yes | IANA timezone (e.g. `America/Toronto`) |
| `CEO_PRIMARY_EMAIL` | Recommended | Prevents first CEO email from being held |
| `OPENAI_API_KEY` | Tier 2 | Enables entity memory and semantic search |
| `NYLAS_API_KEY` | Tier 2 | Email channel |
| `NYLAS_GRANT_ID` | Tier 2 | Email grant (connected account) |
| `NYLAS_SELF_EMAIL` | Tier 2 | Address Curia reads and sends from |
| `SIGNAL_PHONE_NUMBER` | Tier 3 | Enables Signal channel |
| `TAVILY_API_KEY` | Tier 3 | Enables `web-search` skill |

See [setup.md](setup.md) for a step-by-step walkthrough of setting these up.
