# 03 — Skills & Execution Layer

## Overview

Skills are the framework's extension mechanism — how agents interact with the outside world. The execution layer handles skill invocation, permission validation, and MCP protocol.

---

## Local Skills (directory-based)

```
skills/
  email-parser/
    skill.json      # manifest
    handler.ts      # implementation
    handler.test.ts # tests
```

### Skill Manifest (`skill.json`)

```json
{
  "name": "email-send",
  "description": "Send an email via the Nylas API",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "medium",
  "inputs": { "to": "string", "subject": "string", "body": "string", "cc": "string?" },
  "outputs": { "messageId": "string", "threadId": "string" },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

- `sensitivity`: `"normal"` or `"elevated"`. **`elevated` means the skill requires a *live principal turn*** — the current turn must have originated from a fresh principal inbound. The signal is a **distinct `liveTurn` field** on the `agent.task` payload (not a metadata-bag key, so it can never be swept into a persisted/wakeable row): the dispatcher stamps it on principal inbounds, and the `delegate` skill forwards it across a **synchronous** delegation, so "the CEO is live" spans the whole synchronous call tree — a delegated specialist acting inside the CEO's turn qualifies, but a wake, scheduler fire, or persisted task never does. It is the live-principal authority primitive: only the CEO, acting now (directly or through a synchronous delegate), may invoke it. System, agent, and woken/inherited principal-*lineage* contexts all fail, with zero per-skill exceptions — this closes the self-approval hole (a woken principal-lineage task cannot approve its own pending action). Enforced **solely** at the execution-layer gate (`isLivePrincipalTurn`); elevated skills carry no handler-level origination re-check (#1126). The elevated set is the CEO-authority primitives: the approval-queue + autonomy controls, the grant-recommendation decisions, the authorization-altering contact skills (`contact-set-tier`/`contact-set-role`/`contact-grant-permission`/`contact-revoke-permission`), and `system-secret-capture-request`. Consequential *mutations* that are not authority primitives are `normal` + `action_risk` instead, governed by the autonomy engine and inheriting the ADR-018 approval flow. See ADR-017.
- `action_risk`: required on all manifests. Named labels — `none`, `low`, `medium`, `high`, `critical` — map to minimum autonomy score thresholds. Raw integers (0–100) are also accepted for precision. Enforced by the execution layer against the live autonomy score.
- `secrets`: declares which vault secret keys the skill will request via `ctx.secret()` (vault-first, env fallback at bootstrap)
- `permissions`: declared capabilities, validated at load time
- `timeout`: per-invocation timeout in ms; exceeded invocations return a failure result (default 30000)
- `install.requires_secrets` (optional): vault secret keys that must already exist before the skill can be **installed or enabled** in the registry. `RegistryService` rejects install/enable until every listed key is present in the vault. This is the install/enable gate, distinct from the runtime `secrets` allowlist above. Example: `web-search` declares `"install": { "requires_secrets": ["tavily_api_key"] }`. (An `uninstall` block is parsed but currently inert.)
- `skip_secret_redaction` (optional, boolean): opts the skill's output out of **only** the broad generic-long-hex secret scrub in output sanitization — the structured credential patterns (API keys, JWT/Bearer, AWS) still apply, as do tag-stripping and truncation. Gated at startup to skills that declare the `secretCapture` capability. Exists so a skill whose output legitimately carries a high-entropy capability token (e.g. the secret-capture one-time link) can relay it to the LLM intact. Default false.

**Privilege access** — skills declare which privileged services they need via `"capabilities": [...]` in `skill.json`. The loader validates names against a fixed allowlist (`VALID_CAPABILITIES` in `src/skills/loader.ts`) at startup and rejects unknown names. The manifest is frozen after loading. The execution layer injects only declared services into `SkillContext` — skills cannot self-escalate at runtime. Universal services (`contactService`, `entityContextAssembler`, `agentPersona`) are available to all skills without declaration. Two capabilities were added in v0.35.0: `secretCapture` (grants `ctx.secretCapture` to mint one-time vault capture links) and `secretResolver` (grants `ctx.resolveSecretRef` to resolve a `user.*` secret by reference at runtime — additionally hard-allowlisted to `web-browser` in the execution layer). See the `capabilities` section in `docs/dev/adding-a-skill.md` for the full capability reference.

**Caller restrictions** — skills can declare `"allowed_callers": ["agent-name", ...]` in `skill.json` to restrict which agents may invoke them. The execution layer checks the calling agent's name against this list after the elevated-skill gate but before score-based autonomy gates — this avoids creating pointless approval requests for structurally forbidden callers. If the caller is not in the list, the invocation is rejected with a structured failure. The special value `"system"` matches system-layer invocations (checkpoint processor, etc.). CEO-approved re-executions (`humanApproved: true`) bypass the caller gate. Names in `allowed_callers` are validated against known agent names at startup — unknown names cause a hard startup failure.

### Skill Handler Interface

```typescript
interface SkillHandler {
  execute(ctx: SkillContext): Promise<SkillResult>;
}

interface SkillContext {
  input: Record<string, unknown>;  // validated against manifest inputs
  secret(name: string): string;    // scoped secret access (resolves a vault secret key)
  log: Logger;                     // scoped pino child logger
  agentPersona?: AgentPersona;     // display name, title, email signature — available to all skills
  caller?: CallerContext;          // caller identity (audit/context; not the elevated-gate signal — see sensitivity)
  contactService?: ContactService; // read-only contact lookups — available to all skills
  infraLlm?: InfraLlm;            // constrained LLM access (classify/extract only, no raw chat)
  secretCapture?: SecretCaptureMinter;            // capability-gated by `secretCapture` — mints one-time vault capture links
  resolveSecretRef?(ref: string): Promise<string>; // capability-gated by `secretResolver` — resolves a `user.*` secret server-side; value never enters LLM context; hard-allowlisted to web-browser
  appOrigin?: string;            // available to all skills — public origin used to build capture-link URLs
  httpPort?: number;             // available to all skills — local HTTP port, dev fallback origin for capture-link URLs
  // ...plus service-specific fields injected per-skill by name (bus, entityMemory, etc.)
}

type SkillResult =
  | { success: true; data: unknown }
  | { success: false; error: string };
```

Skills cannot self-grant privileges — all service access (bus, entityMemory, calendar client, etc.) must come from the injected `SkillContext` via explicit per-skill grants in the execution layer. Skills are invoked synchronously within the agent turn via `ExecutionLayer.invoke()`. Skills are sandboxed to their declared I/O and must never throw — all error paths return `{ success: false, error: '...' }`.

---

## MCP Skills (external servers)

The framework acts as an MCP client connecting to external MCP servers:

```yaml
# config/skills.yaml
mcp_servers:
  - name: google-workspace
    transport: http
    url: https://mcp-server.example.com/mcp
    headers:
      Authorization: "Bearer <token>"
    action_risk: low
    permissions: ["workspace:read", "workspace:write"]
    secrets:                             # optional — declares vault keys this server needs
      - key: google_oauth_client_id      # vault key name
        label: "Google OAuth Client ID"
        masked: false
      - key: google_oauth_client_secret
        label: "Google OAuth Client Secret"
        masked: true
```

Supported transports: `stdio` (local subprocess) and `http` (StreamableHTTP — the current MCP SDK recommended transport for hosted servers). The deprecated `sse` transport has been migrated.

**MCP credential management.** MCP servers may declare required secrets via a `secrets:` block (`McpSecretDeclaration[]` — `key`, `label`, `masked`). The web console's **Settings → MCP Skills** page presents credential fields for each declaration, writes values to the encrypted vault, and gates enable/disable on whether all required secrets resolve. This mirrors the Channels registry pattern. Internally, `McpRegistryService` (`mcp_server_registry` table, `reconcileMcpRegistry` bootstrap step) tracks install/enable state for each MCP server. `loadMcpServers` filters to enabled servers only.

At startup, the framework connects to each MCP server, discovers tools via `tools/list`, and registers them in the skill registry alongside local skills. Agents don't know or care whether a tool is local or MCP.

---

## Skill Discovery

Two-tier access:

### Pinned Skills
Explicitly listed in agent config (`pinned_skills`). Always available to the agent, always included in the LLM's tool list.

### Discoverable Skills
All registered skills (local + MCP) are searchable via the built-in `skill-registry` skill. Agents with `allow_discovery: true` in their YAML automatically receive `skill-registry` in their tool list. When the LLM determines it needs a capability not in its pinned skills, it invokes:

```text
skill-registry({ query: "send email" })
```

This returns a list of matching skill names and descriptions. **Discovered skills are immediately callable** — after `skill-registry` succeeds, `AgentRuntime` calls `ExecutionLayer.getToolDefinitions()` with the returned names and appends the full tool schemas to the per-task working tool list before the next LLM call. The LLM can then call any discovered skill natively, with its real input schema, in the same or subsequent turns.

Tool-list expansion is **per-task**: each task gets a local copy of the startup tool list, so concurrent tasks never see each other's discoveries. Multiple `skill-registry` calls within one task accumulate — the runtime deduplicates by name. Discovered skills flow through the same `ExecutionLayer.invoke()` path as pinned skills, including the elevation gate (`sensitivity: elevated` skills require a live principal turn — see Safety Gate below).

`skill-registry` itself is excluded from its own search results to avoid circular self-discovery.

### Safety Gate for First-Time Use

- Skills tagged `sensitivity: "normal"`: auto-approvable; governed by the autonomy engine via `action_risk` (and `allowed_callers` where set)
- Skills tagged `sensitivity: "elevated"` (CEO-authority primitives — approve/deny/dismiss actions, set-autonomy, grant-recommendation decisions): require a **live principal turn**, enforced at the execution-layer gate (`isLivePrincipalTurn`). Not a per-agent first-use approval — every invocation must be a fresh principal turn (#1126)
- The deferred per-agent-skill `skill_approvals` "ask once on first use by that agent" flow is a separate, still-unbuilt concern (persist-once-ask-once); it would layer on top of, not replace, the elevation gate
- Elevation rejections and autonomy-gate blocks are audit-logged

---

## Skill & Agent Registry

Skills (and agents) are not enabled merely by existing on disk — they are tracked in registry tables with an explicit install/enable lifecycle. The skill and agent registries share one migration (`051_create_skill_agent_registry.sql`) and the same column shape: `name` (PK), `enabled` (bool), `installed_at`, `installed_by`, `enabled_at`, `enabled_by`, `updated_at`.

- **Disabled by default.** A newly added skill or agent is registered at startup but starts **disabled**.
- **Restart-based enforcement.** Enabled items are loaded/registered at startup; disabled items are skipped. Changing enable state takes effect on the next restart — there is no live reload.
- **Secret gating.** `RegistryService` enforces `install.requires_secrets`: install/enable is rejected until every declared vault secret key exists in the vault. `web-search` is the first consumer (`requires_secrets: ["tavily_api_key"]`).

Lifecycle is driven via the registry HTTP routes (`src/channels/http/routes/registry.ts`):

```
GET    /api/registry/skills
GET    /api/registry/agents
POST   /api/registry/:kind/:name/install
POST   /api/registry/:kind/:name/enable
POST   /api/registry/:kind/:name/install-enable
POST   /api/registry/:kind/:name/disable
DELETE /api/registry/:kind/:name
```

Channels have their own parallel registry — see [spec 04 — Channels](04-channels.md).

---

## Execution Layer

Skills are invoked directly by `AgentRuntime` via `ExecutionLayer.invoke(skillName, input, caller, options)`. The execution layer is constructed once per process and shared across all agents.

Invocation flow:

1. **Resolve** — look up skill in registry by name (local or MCP)
2. **Normalize inputs** — convert timestamp inputs to UTC-offset ISO strings using the configured local timezone
3. **Validate elevation** — if `sensitivity: elevated`, reject unless this is a **live principal turn** (`isLivePrincipalTurn`: the distinct `options.liveTurn` flag — forwarded from `agent.task.payload.liveTurn` — plus principal lineage on the effective metadata). System, agent, scheduled, and woken/inherited principal-lineage contexts all fail — a wake is never a live turn; a synchronous delegation inside a live turn is (#1126). This is the sole enforcement point; no handler re-check duplicates it. (Distinct from the autonomy principal-bypass, which uses *lineage* via the ladder — see [14-autonomy-engine.md](14-autonomy-engine.md#effective-standing--the-bypass-ladder-wokenderived-tasks).)
4. **Validate caller** — if `allowed_callers` is set on the manifest, reject unless the calling agent is in the list (CEO-approved re-executions bypass this gate)
5. **Build context** — assemble `SkillContext` with scoped secrets, logger, and per-skill service grants
6. **Execute** — call `handler.execute(ctx)` with a timeout wrapper (local), or `tools/call` (MCP)
7. **Sanitize output** — strip injection vectors, redact secrets, truncate, wrap errors
8. **Return `SkillResult`** to the agent runtime for inclusion in the LLM's next turn

### Output Sanitization

*Lesson from Zora: tool outputs can contain injection vectors when fed back to the LLM.*

All skill results are sanitized before being included in the agent's LLM context:
- Strip any XML/HTML tags that could be interpreted as system instructions
- Truncate excessively long outputs (default: 200,000 chars) with a `[truncated]` marker
- Redact patterns matching known secret formats (API keys, tokens) using a configurable regex list
- Error strings are wrapped in a structured format (`<tool_error>...</tool_error>`) to prevent them from being interpreted as instructions

**Value-aware secret redaction (v0.35.0).** Secrets injected into the browser by reference (`web-browser` `secret_ref`) are tracked per browser session and scrubbed — both the raw value and its URL- and HTML-encoded variants — from returned content, the page URL, and error messages, so a hostile page cannot reflect an injected credential back into the LLM. Screenshots are suppressed on any action that fills a secret (an image cannot be value-redacted). The manifest field `skip_secret_redaction` is a narrow opt-out of only the broad generic-hex scrub (see Skill Manifest above) — it does not affect value-aware redaction or the structured credential patterns.

### Resource Boundaries

*Lesson from Zora: unbounded operations exhaust memory and block the system.*

- **Timeout enforcement**: Every skill invocation has a timeout (from manifest or default 30s). Exceeded invocations are killed and return a failure result.
- **Concurrent invocations**: Max 5 concurrent skill invocations per agent task — not yet implemented
- **Buffer limits**: Streaming skill responses capped at 1MB — not yet implemented

#### Timeout safety: handlers must be at-most-once

Skill timeouts are enforced via `Promise.race` against the handler. On timeout, the in-flight handler is **not** cancelled — any side effects it has already committed (DB writes, bus publishes, outbound sends) persist, and the caller sees a `<skill_error>Skill 'X' timed out after Yms</skill_error>` result.

This means a "timed out" result is **not the same as "no work happened"**. Callers cannot safely retry on timeout unless the skill is genuinely idempotent (e.g. accepts an idempotency key, or only reads).

Skill handlers should be designed so that a timeout leaves no half-committed visible state:

- If the skill's purpose is to **create a thing** (a thread, a draft, a message), persist that thing as the first awaited step, then make every downstream step fire-and-forget. `bullpen` follows this pattern: `openThread()` (synchronous, awaited) followed by `bus.publish(agent.discuss)` (fire-and-forget, with a `.catch` for logging) — agents see the new thread via pending-thread context injection even if the publish never fires.
- If the skill's purpose is to **deliver a side effect that cannot be made fire-and-forget** (a wire-level send), the timeout must be set comfortably above the channel's p99 latency, and callers must be instructed not to retry.
- Skills that internally `await` long-running infrastructure (e.g. an LLM call as part of `infraLlm`) must propagate timeouts so the skill's own timeout is the effective deadline.

---

## Secrets Access

Skills access secrets via `ctx.secret("name")`:

- **Implementation:** An **encrypted application-layer vault** backs the accessor. Secrets are stored AES-256-GCM-encrypted in the `secrets` table (one row per secret: `name`, `value_format`, `encrypted_value`, `iv`, timestamps) and decrypted on read by `SecretsService` using `SECRET_ENCRYPTION_KEY`. See [ADR-020](../adr/020-secrets-vault.md) (app-layer AES-256-GCM vault) and [ADR-021](../adr/021-vault-only-secret-resolution.md) (vault-only resolution).
- **Resolution order:** vault-first. `SecretsService.get(name)` returns `Promise<string | null>` and reads only the vault — there is no env fallback inside the service. The vault-first-then-env fallback happens once at bootstrap via `applyVaultSecrets()`. The only secrets that remain in `.env` are the four bootstrap values needed to reach and unlock the vault: `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`, `DB_USER`, `DB_PASSWORD`.
- `SecretsService.list()` returns `Promise<string[]>` — secret **names only**, never values.
- The execution layer validates that the calling skill's manifest declares the requested secret in its `secrets` array.
- Agents/LLMs never see secret values — only skills access them internally.
- All secret access is audit-logged (the `secret.accessed` event records which secret, when, and the resolution source `vault | env`) but values are never logged.
- **Seeding & rotation:** `pnpm run seed-vault` upserts secrets (transient-env usage, e.g. `NYLAS_API_KEY=nyk_... pnpm run seed-vault`); `scripts/rotate-secret-key.ts` re-encrypts every row under a new key in a single transaction. See [Configuration → Secrets](../dev/configuration.md#secrets).

---

## Built-in Skills

The framework ships with these skills (in `skills/` as part of core):

- `skill-registry` — search for available skills by keyword; injected into tool list for agents with `allow_discovery: true`
- `delegate` — route a sub-task to a specialist agent via the bus
- `web-fetch` — HTTP GET with configurable timeouts and size limits
- `web-browser` — Playwright-backed browser for JS-rendered pages. v0.35.0 added: secret-by-reference fill (`secret_ref` — a `user.*` secret name; the value is filled server-side and never shown to the LLM), incognito sessions (`incognito: true` — ephemeral, isolated context off the principal's persistent profile), opt-in ad-blocking (`block_ads: true`, off by default — keep off for auth/login/form-fill flows), new interaction actions (`scroll`, `hover`, `press_key`, `wait_for`), iframe awareness with per-frame SSRF gating (private/internal child frames are skipped), a persistent profile (shared cookies/storage across sessions), and fingerprint hardening (real Chrome channel + stealth, no stale UA override)
- `web-search` — web search via Tavily API
- `scheduler-create` / `scheduler-list` / `scheduler-cancel` — create and manage scheduled jobs
- `email-send` / `email-reply` — outbound email via Nylas (multi-account aware)
- `held-messages-list` / `held-messages-process` — review and act on held/deferred messages
- Calendar skills (`calendar-list-calendars`, `calendar-list-events`, `calendar-create-event`, etc.) — Nylas calendar CRUD
- Contact skills (`contact-create`, `contact-lookup`, `contact-merge`, etc.) — contact management and KG linking
- `config-store` — generic namespaced key-value store for persistent agent configuration; backs `company`, `meeting_links`, `travel_preferences`, `loyalty_programs`, `writing_config`, and any future per-agent config needs
- `entity-context` — assemble full context for a list of contacts/entities
- `get-autonomy` / `set-autonomy` — read and write the global autonomy score (CEO only)
- `bullpen` — inter-agent discussion threads; `post`/`reply` persist the thread/message synchronously and fire-and-forget the `agent.discuss` publish so a slow subscriber can't push the handler past its timeout (see *Timeout safety* above)
- `template-doc-request` — structured document request template (scheduling templates retired; calendar specialist composes scheduling email text directly)
- `image-generate` — generate an image from a text prompt via DALL-E 3; returns a temporary CDN URL (~1hr TTL)
- `setup-status` — read-only (`action_risk: none`); returns the setup catalog (`skills/setup-status/catalog.yaml`) with each task's live-derived status (`done` / `pending` / `deferred`). The catalog is owned by the skill bundle, not core.
- `setup-defer` — write (`action_risk: low`); persists or clears a setup task deferral in config-store (`setup_wizard/deferrals`). Pinned to `setup-wizard`.
- `context-bridge-clear` — write (`action_risk: low`); bulk-releases active outbound-context entries matching a list of meeting subjects across the full active window (not just the injected slice). Pinned to coordinator, contacts, ceo-inbox, and meeting-debrief.

> **Removed from scope:** `file-reader` and `file-writer` were originally planned but removed after security review. General-purpose filesystem access from LLM-driven agents on a single-tenant VPS creates an unacceptable prompt-injection-to-file-exfiltration attack vector. Email attachments (the primary use case) are handled in-memory via the Nylas SDK's streaming/buffer APIs. Agent-created documents should use the knowledge graph. If a narrowly-scoped filesystem need arises later, build a purpose-specific skill rather than a general reader/writer.

---

## Recommended MCP Servers

These are not bundled but documented as recommended integrations:

| Server | Purpose | Link |
|---|---|---|
| **Google Workspace** | Drive, Docs, Sheets, Gmail read/search/write | [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) |
| **Filesystem** | Scoped file access (read/write/search) | [modelcontextprotocol/servers/filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) |
| **GitHub** | Repo management, issues, PRs | [modelcontextprotocol/servers/github](https://github.com/modelcontextprotocol/servers/tree/main/src/github) |
| **Brave Search** | Web search for research agents | [modelcontextprotocol/servers/brave-search](https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search) |
| **Fetch** | Web fetching with robots.txt compliance | [modelcontextprotocol/servers/fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) |

---

## Known Deficiencies

- **`skill_approvals` persist-once-ask-once flow** — the per-agent-skill "ask once on first use by that agent" safety gate is still unbuilt (deferred), separate from the live-principal elevation gate.
- **Max-5 concurrent invocations limit** — the per-agent-task cap on concurrent skill invocations is not yet implemented.
- **1MB streaming buffer cap** — the buffer limit on streaming skill responses is not yet implemented.
