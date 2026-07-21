# Configuration Reference

Curia is configured through two complementary mechanisms:

- **`.env`** — bootstrap values and environment-specific config (database URL, encryption key, port). Never committed to version control. **Application secrets do not live here** — they resolve from the encrypted vault. See [Secrets](#secrets) below.
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

Signal and email are **not** controlled here — they are governed by the channel registry (install/enable lifecycle). Enable them via **Settings → Channels** in the console once their credentials are in the vault. See [setup.md](setup.md) for details.

---

### `browser`

Controls browser sessions used by the `web-browser` skill. As of v0.35.0 these `browser.*` settings actually take effect at startup — they were previously read through a dead cast and silently ignored.

```yaml
browser:
  sessionTtlMs: 600000    # How long a session stays alive after its last action (ms). Default: 10 minutes.
  sweepIntervalMs: 120000 # How often the session cleanup sweep runs (ms). Default: 2 minutes.
  profileDir: ""          # Persistent profile directory. Empty → ${HOME}/.curia/browser-profile. Mount on a volume in production so logins survive restarts.
  channel: ""             # "chrome" for real Chrome (must be installed in the image), empty for the bundled Playwright Chromium.
  locale: "en-US"         # Context locale (BCP 47), part of fingerprint hardening.
```

Raise `sessionTtlMs` if skills that open browser sessions are timing out mid-task. Lower it to free resources faster on memory-constrained deployments. `sessionTtlMs` and `sweepIntervalMs` are validated at startup (a non-positive value is a hard failure); `profileDir`, `channel`, and `locale` must be strings.

> **`block_ads` is not a config knob.** Ad-blocking is a per-call input on the `web-browser` skill (`block_ads`, off by default), not a global `browser.*` setting. Keep it **off** for auth / login / form-fill flows — the blocker is fingerprinted as a privacy extension and triggers bot detection.

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

### `documentWorkspace`

Controls the agent document workspace — the OKF-serialized working-document store injected into task-management agents (spec §21-agent-document-workspace.md). Two independent knobs: how long ephemeral scratch documents live, and whether completed project deliverables are distilled into the knowledge graph.

```yaml
documentWorkspace:
  scratchTtlDays: 7          # Default /scratch inactivity TTL. Positive integer ≤ 36500.
  kgPromotion:
    enabled: true            # Distil a completed plan's deliverable into the KG.
    maxFacts: 50             # Per-project cap on promoted facts.
    maxRelationships: 50     # Per-project cap on promoted relationships.
```

- **`scratchTtlDays`** — days of inactivity (measured from a document's `updated_at`) before the nightly DreamEngine pass purges a `/scratch/<conversation-id>/…` document. `/projects/…` documents are durable and never auto-purged. A per-document `ttl_days` in frontmatter overrides this (`0` opts out; `1`–`36500` sets an explicit window). Validated at startup as a positive integer ≤ 36500.
- **`kgPromotion.enabled`** — when a planned parent completes, distil its curated deliverable into the knowledge graph through the `extract-*` gates (spec §20-resumable-tasks-and-projects.md). Set `false` to disable globally. `maxFacts` / `maxRelationships` cap how much a single project can promote (non-negative integers).

---

### `skillOutput`

Controls truncation of skill results before they're included in LLM context.

```yaml
skillOutput:
  maxLength: 200000  # Default: 200,000 characters (~50k tokens at 4 chars/token)
```

Skills that return large payloads (web search results, long calendar lists, crawled pages) are clipped to this length with a truncation note appended. Raise the limit if skills are cutting off important results. Lower it on installations with tight context budgets or many concurrent agents.

---

### `delegate`

Controls how long the coordinator waits for a delegated specialist's reply before timing out.

```yaml
delegate:
  defaultTimeoutMs: 90000   # 90 seconds — appropriate for interactive Sonnet-class delegations
```

Override in `config/local.yaml` to match the deployment's model latency profile. The value is validated at startup; non-numeric or non-positive values cause a hard startup failure.

---

### `scheduler`

Runtime defaults for the scheduler watchdog and recovery logic.

```yaml
scheduler:
  defaultExpectedDurationSeconds: 600   # 10 minutes
```

`defaultExpectedDurationSeconds` is used by the watchdog to compute a recovery timeout (`LEAST(expected × 7.5, expected + 3600)`) for scheduled jobs that don't declare an explicit `expectedDurationSeconds`. Raise this if you run long-running scheduled jobs without explicit duration hints. Validated at startup.

---

### `debrief`

Configures the meeting-debrief specialist agent (see [spec 17](../specs/17-meeting-debrief.md)). The agent itself is defined in `agents/meeting-debrief.yaml`; this block controls the prompt-channel and reply-correlation knobs.

```yaml
debrief:
  channel: signal               # channel for debrief prompts (signal | email)
  reminderDelayMinutes: 120     # minutes before a reminder is sent for unanswered debriefs
  contextBridgeTtlHours: 48     # TTL for context-bridge entries that link replies back to the debrief agent
```

`contextBridgeTtlHours` is passed through to the outbound-context registration when the agent sends a debrief prompt — it overrides the global `contextBridge.explicitExpiryHours` default below.

---

### `contextBridge`

Controls TTL (time-to-live) for outbound context entries — the records that let the coordinator link incoming replies to messages it previously sent.

```yaml
contextBridge:
  defaultExpiryHours: 6     # TTL for auto-registered entries (no explicit context_bridge param). Default: 6.
  explicitExpiryHours: 24   # TTL for entries with explicit context_bridge delegation metadata. Default: 24.
```

Every outbound message (Signal, email) automatically registers a context entry so that if the recipient replies, the coordinator knows what they're replying to. Entries registered without explicit `context_bridge` metadata get the shorter `defaultExpiryHours` TTL. Entries with delegation hints and expected-reply metadata get the longer `explicitExpiryHours` TTL.

When a caller passes `expires_in_hours` inside the `context_bridge` JSON param, it overrides `explicitExpiryHours` for that individual entry.

Expired entries are cleaned up automatically by the background scheduler. The coordinator can also release entries manually via the `context-bridge-release` skill.

**Tuning guidance:**
- Raise `defaultExpiryHours` if users commonly reply to proactive notifications after more than 6 hours.
- Lower it if the `[ACTIVE OUTBOUND CONTEXT]` block is accumulating too many stale entries and causing noise.
- `explicitExpiryHours` should be higher because explicit entries carry delegation metadata that's expensive to re-derive.

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

## Skill, agent, and channel registry

Skills, agents, and channels are not enabled simply by existing on disk — they are tracked in three registry tables (`tool_registry`, `agent_registry`, `channel_registry`) with an explicit **install → enable** lifecycle.

- **Disabled by default.** A newly added skill or agent is registered at startup but starts **disabled**. It must be enabled before it can be loaded. Toggleable channels (`email`, `signal`) follow the same rule: seeding credentials does **not** install or enable them — use **Settings → Channels** (install, then enable, then restart).
- **Restart-based enforcement.** Enabled items are loaded/registered at startup; disabled items are skipped. Changing enable state takes effect on the next restart.
- **Secret gating (`install.requires_secrets`).** A skill manifest may declare `install: { requires_secrets: [...] }` — vault secret keys that must already exist before the registry will install or enable the skill. `RegistryService` rejects install/enable until every declared key is present in the vault. (`web-search` declares `["tavily_api_key"]`.)
- **Always-on channels.** The `http` and `cli` channels have `isToggleable: false` — they always start and cannot be disabled, an operator-lockout safeguard. `email` and `signal` are toggleable and require explicit install→enable; outbound egress is gated on the same registry state as inbound adapters.

Lifecycle is driven via the registry HTTP API (or the admin UI):

```
GET    /api/registry/tools
GET    /api/registry/agents
POST   /api/registry/:kind/:name/install
POST   /api/registry/:kind/:name/enable
POST   /api/registry/:kind/:name/install-enable
POST   /api/registry/:kind/:name/disable
DELETE /api/registry/:kind/:name
```

### Channel credential vault keys

Channel credentials follow a structured vault-key convention so each channel's secrets are namespaced:

```
channel.<name>.<field>
```

For example, the email channel's Nylas API key is stored under `channel.email.nylas_api_key`. The catalog (`src/channels/catalog.ts`) declares each channel's `credentialFields` and `requiredSecretKeys`; a `ChannelCredentialField` may also name an `envFallback` for bootstrap. See [Channels spec](../specs/04-channels.md) for the full catalog/registry model.

---

## `config/local.yaml` — deployment overrides

`config/local.yaml` is an optional file that, when present, is deep-merged on
top of `default.yaml` at startup. It exists so deployment-specific config can
live in a deployment repo (e.g. `curia-deploy`) rather than in the `curia`
repo itself.

**`config/local.yaml` is gitignored** — it is never committed to the `curia`
repo. Your deployment tooling writes it to the server at deploy time.

### Merge semantics

- **Objects** are merged recursively. A key in `local.yaml` that is a YAML
  mapping is merged into the corresponding mapping in `default.yaml` — only
  the keys you specify are overridden.
- **Scalars and arrays** in `local.yaml` replace the corresponding value in
  `default.yaml`. Arrays are not concatenated — the local value wins wholesale.
- A key present only in `local.yaml` is added. A key present only in
  `default.yaml` is preserved unchanged.

### Email accounts

Email accounts are managed in the console, not in YAML. Go to **Settings → Channels → Email → Email accounts** to add, edit, or remove agent-owned mailboxes. Each account stores its Nylas grant in the vault at `channel.email.<name>.nylas_grant_id`. `NYLAS_API_KEY` remains the shared app-level key and is still seeded via the vault in the usual way. Changes take effect on restart.

The legacy `channel_accounts.email` YAML path (previously configured in `config/local.yaml`) is retired as of #1101. Remove any `channel_accounts:` block from `local.yaml` if upgrading — it will be ignored on startup.

### Error handling

| Situation | Behaviour |
|---|---|
| `local.yaml` absent | Silently ignored — `default.yaml` is used alone |
| `local.yaml` present but empty | Treated as no override |
| `local.yaml` has a YAML syntax error | Hard startup failure with `Failed to load config/local.yaml: ...` |
| `local.yaml` root is not a mapping | Hard startup failure: `config/local.yaml must contain a YAML mapping at the root` |
| Merged value fails validation | Hard startup failure — same messages as a bad `default.yaml` value |

---

## `config/skills.yaml` — MCP servers

MCP servers extend Curia with external tools (Google Drive, GitHub, etc.)
without writing any TypeScript. At startup, Curia connects to each configured
server, discovers its tools via `tools/list`, and registers them in the skill
registry alongside local skills.

The file does not exist by default — its absence means no MCP servers are
configured. Create it when you add the first server.

```yaml
servers:
  - name: gdrive
    transport: stdio          # "stdio" spawns a local process; "http" connects to a StreamableHTTP endpoint
    command: npx
    args: ["-y", "@modelcontextprotocol/server-gdrive"]
    action_risk: low          # required — none | low | medium | high | critical
    sensitivity: normal       # optional — "normal" (default) or "elevated" (CEO-only)
    timeout_ms: 30000         # optional — per-invocation timeout in ms (default: 30000)
    # env:                    # optional — extra env vars for the spawned process only
    #   SOME_VAR: value       # vars already in .env are inherited automatically
    # secrets:                # optional — declare vault keys this server needs
    #   - key: my_api_key     # vault key name (stored encrypted, injected at spawn time)
    #     label: "My API Key"
    #     masked: true        # true → shown as ••••• in the console credential form
```

Connection failures at startup are non-fatal but logged at `error` level — a
missing MCP server won't take Curia down. The failed server's tools will be
unavailable until restart. Search logs for `ERROR Failed to connect to MCP server`
to diagnose.

After adding a server, pin its tools in `agents/coordinator.yaml` under
`pinned_skills` so the coordinator's LLM can call them. Tool names come from
the server's `tools/list` response — check the startup logs to confirm.

See [google-drive.md](google-drive.md) for a full walkthrough of the Google
Drive integration (service account setup, folder sharing, credential wiring).

---

## Secrets

Secrets resolve from the **encrypted vault only** — there is no env-var fallback (see
[ADR-021](../adr/021-vault-only-secret-resolution.md)). Only four bootstrap values stay
in `.env`, because they are needed to reach and unlock the vault itself:

- `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` — connect to the Postgres instance that hosts
  the vault.
- `SECRET_ENCRYPTION_KEY` — decrypts the vault.

Every other secret (Anthropic, OpenAI, OpenRouter, API token, web-app bootstrap secret,
Nylas trio, Signal number, Tavily) lives only in the vault.

**Seeding:**

- **Fresh install** — `pnpm run setup` seeds the vault automatically after migrations,
  so the app never boots against an empty vault.
- **Add or update one secret later** — supply it as a transient env var and run the
  seeder: `VAR=value pnpm run seed-vault`. The seeder upserts present values; absent
  ones are skipped, never cleared.

**Missing secrets:** a missing *required* secret fails closed. Most fail at their consumer
(e.g. `anthropic_api_key`). `api_token` is special-cased with an explicit boot guard that
refuses to start, because its HTTP-auth consumer fails *open* (no token configured = auth
disabled) — an absent token would otherwise silently expose the API. `setup.sh` also runs
`seed-vault` with `SEED_VAULT_VERIFY=1`, which confirms the required rows (`anthropic_api_key`,
`api_token`, `web_app_bootstrap_secret`) landed and aborts the install if any are missing.
A missing *optional* secret (OpenAI, OpenRouter, Signal) disables its feature via the
existing `if (config.x)` guards rather than failing the boot.

---

## Environment variables (`.env`)

Environment variables control bootstrap values and deployment-specific config that must
not be committed. Application secrets are **not** set here — they live in the vault (see
[Secrets](#secrets) above). A full list with descriptions lives in `.env.example` at the
repo root.

The **Stored in** column shows where each value lives: `.env` for the bootstrap and
non-secret config that must be on the host before the vault opens, or **vault** for
secrets that resolve from the encrypted store ([ADR-021](../adr/021-vault-only-secret-resolution.md)).
Vault secrets are listed by their env-var name because that's the name you pass when
seeding (`VAR=value pnpm run seed-vault`); they are read from the vault at runtime, not
from `.env`.

| Variable | Required | Stored in | Description |
|---|---|---|---|
| `SECRET_ENCRYPTION_KEY` | Yes | `.env` | AES-256-GCM key for the secrets vault. Generate with `openssl rand -base64 32`. Changing this without running `scripts/rotate-secret-key.ts` makes stored secrets unreadable. |
| `DATABASE_URL` | Yes | `.env` | Postgres connection string (also reads the vault that hosts the secrets) |
| `DB_USER` / `DB_PASSWORD` | Yes | `.env` | Postgres credentials |
| `TIMEZONE` | Yes | `.env` | IANA timezone (e.g. `America/Toronto`) |
| `ANTHROPIC_API_KEY` | Yes | vault | Powers all agents |
| `API_TOKEN` | Yes | vault | Authenticates HTTP API requests |
| `WEB_APP_BOOTSTRAP_SECRET` | Yes | vault | Web app login secret |
| `OPENAI_API_KEY` | Tier 2 | vault | Enables entity memory and semantic search |
| `OPENROUTER_API_KEY` | Optional | vault | Enables multi-model routing via OpenRouter (Gemini Flash, DeepSeek V3, GPT-4o). When set, tiers can map to OpenRouter-hosted models. |
| `NYLAS_API_KEY` | Tier 2 | vault | Shared Nylas app key for the email channel. Per-account grants are managed in the console (Settings → Channels → Email) and stored in the vault at `channel.email.<name>.nylas_grant_id`. |
| `SIGNAL_PHONE_NUMBER` | Tier 3 | vault | Enables Signal channel |
| `TAVILY_API_KEY` | Tier 3 | vault | Gates `web-search` (`install.requires_secrets`). Provision `tavily_api_key` via the console (Settings → Skills → web-search); the env var is a fallback only and should be unset in production. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional | `.env` | Path to service account JSON for Google Drive |
| `CURIA_TEMPFILE_DIR` | Optional | `.env` | Base directory under which the `file-parse` skill resolves `temp_file_url` inputs. The skill rejects paths that escape this directory. Defaults to the OS temp dir when unset. |

See [setup.md](setup.md) for a step-by-step walkthrough of setting these up.

---

## Rotating the secrets vault key

`SECRET_ENCRYPTION_KEY` encrypts all stored secrets. To rotate it:

1. Generate a new key: `openssl rand -base64 32`
2. Re-encrypt existing rows (single transaction, safe to rerun):
   ```bash
   SECRET_ENCRYPTION_KEY_OLD="$CURRENT_KEY" \
   SECRET_ENCRYPTION_KEY_NEW="$NEW_KEY" \
   DATABASE_URL="$DATABASE_URL" \
   pnpm exec tsx scripts/rotate-secret-key.ts
   ```
3. Set `SECRET_ENCRYPTION_KEY` to the new value in `.env`.
4. Restart the app.

If the process is interrupted, the transaction rolls back — the old key still
decrypts everything. Rerun to retry.
