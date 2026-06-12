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

- `sensitivity`: `"normal"` (auto-approvable) or `"elevated"` — **target behaviour**: requires human approval on first use by that agent; **current behaviour**: not yet enforced — the execution layer applies role-gating instead (caller must have `role: ceo`); the persist-once-ask-once flow is deferred (see Safety Gate section below)
- `action_risk`: required on all manifests. Named labels — `none`, `low`, `medium`, `high`, `critical` — map to minimum autonomy score thresholds. Raw integers (0–100) are also accepted for precision. Enforced by the execution layer against the live autonomy score.
- `secrets`: declares which vault secret keys the skill will request via `ctx.secret()` (vault-first, env fallback at bootstrap)
- `permissions`: declared capabilities, validated at load time
- `timeout`: per-invocation timeout in ms; exceeded invocations return a failure result (default 30000)
- `install.requires_secrets` (optional): vault secret keys that must already exist before the skill can be **installed or enabled** in the registry. `RegistryService` rejects install/enable until every listed key is present in the vault. This is the install/enable gate, distinct from the runtime `secrets` allowlist above. Example: `web-search` declares `"install": { "requires_secrets": ["tavily_api_key"] }`. (An `uninstall` block is parsed but currently inert.)

**Privilege access** — skills declare which privileged services they need via `"capabilities": [...]` in `skill.json`. The loader validates names against a fixed allowlist (`VALID_CAPABILITIES` in `src/skills/loader.ts`) at startup and rejects unknown names. The manifest is frozen after loading. The execution layer injects only declared services into `SkillContext` — skills cannot self-escalate at runtime. Universal services (`contactService`, `entityContextAssembler`, `agentPersona`) are available to all skills without declaration. See the `capabilities` section in `docs/dev/adding-a-skill.md` for the full capability reference.

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
  caller?: CallerContext;          // caller identity (guaranteed for elevated skills)
  contactService?: ContactService; // read-only contact lookups — available to all skills
  infraLlm?: InfraLlm;            // constrained LLM access (classify/extract only, no raw chat)
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
```

Supported transports: `stdio` (local subprocess) and `http` (StreamableHTTP — the current MCP SDK recommended transport for hosted servers). The deprecated `sse` transport has been migrated.

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

Tool-list expansion is **per-task**: each task gets a local copy of the startup tool list, so concurrent tasks never see each other's discoveries. Multiple `skill-registry` calls within one task accumulate — the runtime deduplicates by name. Discovered skills flow through the same `ExecutionLayer.invoke()` path as pinned skills, including the existing elevation gate (`sensitivity: elevated` skills still require `caller.role === 'ceo'`).

`skill-registry` itself is excluded from its own search results to avoid circular self-discovery.

### Safety Gate for First-Time Use

- Skills tagged `sensitivity: "normal"`: auto-approved if the agent allows discovery
- Skills tagged `sensitivity: "elevated"` (e.g., payment, deletion, external communication): require human approval via the alert channel before first use by that agent — **not yet implemented** (per-agent-skill `skill_approvals` table with persist-once-ask-once flow is deferred)
- The current elevation gate in the execution layer is role-based: the caller must have `role: ceo`
- All discovery and first-use events will be audit-logged when the full gate is built

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
3. **Validate elevation** — if `sensitivity: elevated`, reject if the task was not principal-originated
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
- `web-browser` — Playwright-backed browser for JS-rendered pages
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

## Implementation Status

| Item | Status |
|---|---|
| Local skill directory structure — `skill.json` manifest + `handler.ts` loading | Done |
| `action_risk` field — required on all manifests, validated at load time | Done |
| Startup schema validation — `skill.json` validated via Ajv at boot | Done |
| Execution layer — resolve, validate elevation, build context, execute, sanitize, return result | Done |
| Output sanitization — tag stripping, secret redaction, truncation, error wrapping | Done |
| Resource boundaries — per-invocation timeout enforcement from manifest | Done |
| Secrets access — `ctx.secret()` scoped to manifest `secrets` array, audit-logged | Done |
| Encrypted secrets vault — AES-256-GCM, `secrets` table, vault-first resolution (ADR-020/021) | Done |
| Vault seeding (`seed-vault`) and key rotation (`rotate-secret-key.ts`) scripts | Done |
| Skill registry — `skill_registry` table, install/enable lifecycle, restart-based loading | Done |
| Agent registry — `agent_registry` table, install/enable lifecycle, restart-based loading | Done |
| `install.requires_secrets` gate — `RegistryService` blocks install/enable until declared vault keys exist | Done |
| Registry HTTP API — list/install/enable/install-enable/disable/delete routes | Done |
| MCP skills — MCP client, stdio/StreamableHTTP transport, `tools/list` discovery | Done |
| MCP `headers` config field — per-server auth headers for hosted MCP servers | Done |
| Built-in skill: `skill-registry` (agent-invocable search) | Done |
| Skill discovery — `allow_discovery: true` wired to runtime tool-list builder | Done |
| Skill discovery — dynamic tool-list expansion for discovered skills | Done |
| Safety gate for first-time elevated skill use — per-agent-skill `skill_approvals` table | Partial — role-based elevation gate exists; persist-once-ask-once flow not yet built |
| Privilege scoping — per-skill `capabilities` array, load-time validation, frozen manifest | Done |
| `allowed_callers` enforcement — restrict skill invocation to named agents, validated at startup | Done |
| `infraLlm` capability — constrained LLM access (classify/extract) for infrastructure skills | Done |
| Resource boundaries — max 5 concurrent skill invocations per agent task | Not Done |
| Resource boundaries — 1MB buffer cap on streaming skill responses | Not Done |
| Built-in skill: `config-store` (generic namespaced agent config store) | Done |
| Built-in skill: `image-generate` (DALL-E 3 image generation) | Done |
| Built-in skill: `memory-query` (freeform KG search) | Done |
| Built-in skill: `memory-store` (write-with-validation) | Done |
| `outboundContext` capability — pre-scoped `ScopedOutboundContext` injected into send skills for context-bridge registration (see [spec 11](11-entity-context-enrichment.md#outbound-context-bridge)) | Done |
| Two-tier `allowed_callers` pattern — coordinator-only restrictions for governance skills (e.g. `context-bridge-release`); validator tests enforce manifest correctness at load time | Done |
| Built-in skill: `request-clarification` — multi-turn clarification systemized as a reusable skill | Done |
| Built-in skill: `file-parse` — accepts `temp_file_url` as an alternative to `content_base64`, with `CURIA_TEMPFILE_DIR` path validation | Done |
| Built-in skill: `context-bridge-release` — coordinator-only, marks outbound context entries released | Done |
