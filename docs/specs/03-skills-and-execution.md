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
- `action_risk`: required on all manifests. Named labels — `none`, `low`, `medium`, `high`, `critical` — map to minimum autonomy score thresholds. Raw integers (0–100) are also accepted for precision.
- `secrets`: declares which env-var-backed secrets the skill will request via `ctx.secret()`
- `permissions`: declared capabilities, validated at load time
- `timeout`: per-invocation timeout in ms; exceeded invocations return a failure result (default 30000)

**Privilege access** — skills declare which privileged services they need via `"capabilities": [...]` in `skill.json`. The loader validates names against a fixed allowlist (`VALID_CAPABILITIES` in `src/skills/loader.ts`) at startup and rejects unknown names. The manifest is frozen after loading. The execution layer injects only declared services into `SkillContext` — skills cannot self-escalate at runtime. Universal services (`contactService`, `entityContextAssembler`, `agentPersona`) are available to all skills without declaration. See the `capabilities` section in `docs/dev/adding-a-skill.md` for the full capability reference.

### Skill Handler Interface

```typescript
interface SkillHandler {
  execute(ctx: SkillContext): Promise<SkillResult>;
}

interface SkillContext {
  input: Record<string, unknown>;  // validated against manifest inputs
  secret(name: string): string;    // scoped secret access (reads env vars)
  log: Logger;                     // scoped pino child logger
  agentPersona?: AgentPersona;     // display name, title, email signature — available to all skills
  caller?: CallerContext;          // caller identity (guaranteed for elevated skills)
  contactService?: ContactService; // read-only contact lookups — available to all skills
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

## Execution Layer

Skills are invoked directly by `AgentRuntime` via `ExecutionLayer.invoke(skillName, input, caller, options)`. The execution layer is constructed once per process and shared across all agents.

Invocation flow:

1. **Resolve** — look up skill in registry by name (local or MCP)
2. **Normalize inputs** — convert timestamp inputs to UTC-offset ISO strings using the configured local timezone
3. **Validate elevation** — if `sensitivity: elevated`, reject if caller is missing or role is not `ceo`
4. **Build context** — assemble `SkillContext` with scoped secrets, logger, and per-skill service grants
5. **Execute** — call `handler.execute(ctx)` with a timeout wrapper (local), or `tools/call` (MCP)
6. **Sanitize output** — strip injection vectors, redact secrets, truncate, wrap errors
7. **Return `SkillResult`** to the agent runtime for inclusion in the LLM's next turn

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

---

## Secrets Access

Skills access secrets via `ctx.secret("name")`:

- **Implementation:** Environment variables behind a scoped accessor. Secret names map to env var names (e.g., `ctx.secret("signal_phone_number")` reads `SIGNAL_PHONE_NUMBER` from the environment).
- The execution layer validates that the calling skill's manifest declares the requested secret in its `secrets` array
- Agents/LLMs never see secret values — only skills access them internally
- All secret access is audit-logged (which skill, when, from which task) but values are never logged
- **Future:** Swap env var backend for HashiCorp Vault or similar without changing skill code

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
- Knowledge skills (`knowledge-company-overview`, `knowledge-meeting-links`, etc.) — structured KG queries (legacy pattern — use `config-store` for new agents)
- `config-store` — generic namespaced key-value store for persistent agent configuration; backs writing-config, travel preferences, and any future per-agent config needs
- `entity-context` — assemble full context for a list of contacts/entities
- `get-autonomy` / `set-autonomy` — read and write the global autonomy score (CEO only)
- `bullpen` — inter-agent discussion threads
- Template skills (`template-meeting-request`, `template-reschedule`, etc.) — structured outbound templates
- `image-generate` — generate an image from a text prompt via DALL-E 3; returns a temporary CDN URL (~1hr TTL)

**Not yet built:** `memory-query` (freeform KG search), `memory-store` (write-with-validation), `file-reader`, `file-writer`

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
| MCP skills — MCP client, stdio/StreamableHTTP transport, `tools/list` discovery | Done — `config/skills.yaml`, `src/skills/mcp-client.ts`, `src/skills/mcp-loader.ts`; closes #270 |
| MCP `headers` config field — per-server auth headers for hosted MCP servers | Done |
| Built-in skill: `skill-registry` (agent-invocable search) | Done — `skills/skill-registry/`; closes #274 |
| Skill discovery — `allow_discovery: true` wired to runtime tool-list builder | Done — closes #274 |
| Skill discovery — make discovered-but-not-pinned skills callable (dynamic tool-list expansion) | Done — `AgentRuntime` expands `workingToolDefs` per-task after each `skill-registry` success; `ExecutionLayer.getToolDefinitions()` provides schemas; closes #291 |
| Safety gate for first-time elevated skill use — per-agent-skill `skill_approvals` table | Partial — role-based elevation gate exists (`caller.role === 'ceo'`); persist-once-ask-once flow not yet built |
| Privilege scoping — per-skill `capabilities` array, load-time validation, frozen manifest | Done — `src/skills/loader.ts` (`VALID_CAPABILITIES`), `src/skills/execution.ts` (capabilities loop); closes #119 |
| Resource boundaries — max 5 concurrent skill invocations per agent task | Not Done |
| Resource boundaries — 1MB buffer cap on streaming skill responses | Not Done |
| Built-in skill: `config-store` (generic namespaced agent config store) | Done — `skills/config-store/` |
| Built-in skill: `image-generate` (DALL-E 3 image generation) | Done — `skills/image-generate/`; closes #354 |
| Built-in skill: `memory-query` | Not Done |
| Built-in skill: `memory-store` | Not Done |
| Built-in skill: `file-reader` | Not Done |
| Built-in skill: `file-writer` | Not Done |
