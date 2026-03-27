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
  "infrastructure": true,
  "inputs": { "to": "string", "subject": "string", "body": "string", "cc": "string?" },
  "outputs": { "messageId": "string", "threadId": "string" },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

- `sensitivity`: `"normal"` (auto-approvable) or `"elevated"` (requires human approval on first use)
- `secrets`: declares which secrets the skill will request via `ctx.secret()`
- `permissions`: declared capabilities, validated at load time
- `timeout`: per-invocation timeout in ms; exceeded invocations return a failure result

### Skill Handler Interface

```typescript
interface SkillHandler {
  execute(ctx: SkillContext): Promise<SkillResult>;
}

interface SkillContext {
  input: Record<string, unknown>;     // validated against manifest inputs
  secret(name: string): Promise<string>;  // scoped secret access
  log: Logger;                         // scoped pino child logger
}

type SkillResult =
  | { success: true; data: unknown }
  | { success: false; error: string };
```

Skills cannot access the bus directly — they receive inputs and return outputs. The execution layer wraps invocations in `skill.invoke`/`skill.result` events. Skills are sandboxed to their declared I/O.

---

## MCP Skills (external servers)

The framework acts as an MCP client connecting to external MCP servers:

```yaml
# config/skills.yaml
mcp_servers:
  - name: filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    permissions: ["filesystem:read", "filesystem:write"]

  - name: github
    transport: sse
    url: https://mcp-github.example.com/sse
    permissions: ["network:github"]
```

At startup, the framework connects to each MCP server, discovers tools via `tools/list`, and registers them in the skill registry alongside local skills. Agents don't know or care whether a tool is local or MCP.

---

## Skill Discovery

Two-tier access:

### Pinned Skills
Explicitly listed in agent config (`pinned_skills`). Always available to the agent, always included in the LLM's tool list.

### Discoverable Skills
All registered skills (local + MCP) are listed in a **skill registry**. A built-in `skill-registry` skill is available to all agents with `allow_discovery: true`. When an agent's LLM determines it needs a capability not in its pinned skills, it invokes:

```
skill-registry.search({ query: "send email" })
```

This returns matching skill descriptions. The LLM can then request to use a discovered skill by name.

### Safety Gate for First-Time Use

- Skills tagged `sensitivity: "normal"`: auto-approved if the agent allows discovery
- Skills tagged `sensitivity: "elevated"` (e.g., payment, deletion, external communication): require human approval via the alert channel before first use by that agent
- Approval is persisted in `skill_approvals` table — only asked once per agent-skill pair
- All discovery and first-use events are audit-logged

---

## Execution Layer

When `skill.invoke` arrives on the bus:

1. **Resolve** — look up skill in registry (local directory or MCP server)
2. **Validate permissions** — is this skill in scope for the requesting agent? (pinned, or discovered + approved)
3. **Validate secrets** — does the skill's manifest declare only secrets it's authorized for?
4. **Execute** — call local handler or MCP `tools/call`
5. **Sanitize output** — see below
6. **Publish `skill.result`** with the response

### Output Sanitization

*Lesson from Zora: tool outputs can contain injection vectors when fed back to the LLM.*

All skill results are sanitized before being included in the agent's LLM context:
- Strip any XML/HTML tags that could be interpreted as system instructions
- Truncate excessively long outputs to a configurable limit (default: 10,000 chars) with a `[truncated]` marker
- Redact patterns matching known secret formats (API keys, tokens) using a configurable regex list
- Error strings are wrapped in a structured format (`<tool_error>...</tool_error>`) to prevent them from being interpreted as instructions

### Resource Boundaries

*Lesson from Zora: unbounded operations exhaust memory and block the system.*

- **Buffer limits**: Streaming skill responses are capped at 1MB per invocation
- **Concurrent invocations**: Max 5 concurrent skill invocations per agent task (prevents runaway parallelism)
- **Timeout enforcement**: Every skill invocation has a timeout (from manifest or default 30s). Exceeded invocations are killed and return a failure result.

---

## Secrets Access

Skills access secrets via `ctx.secret("name")`:

- **Launch implementation:** Environment variables behind a scoped accessor. Secret names map to env var names (e.g., `ctx.secret("telegram_bot_token")` reads `TELEGRAM_BOT_TOKEN` from the environment). Note: Email skills use infrastructure access via `ctx.nylasClient` rather than the secret accessor — the Nylas API key is configured at bootstrap, not per-skill.
- The execution layer validates that the calling skill's manifest declares the requested secret in its `secrets` array
- Agents/LLMs never see secret values — only skills access them internally
- All secret access is audit-logged (which skill, when, from which task) but values are never logged
- **Future:** Swap env var backend for HashiCorp Vault or similar without changing skill code

---

## Built-in Skills

The framework ships with these skills (in `skills/` but part of core):

- `skill-registry` — search for available skills by description
- `scheduler` — create/list/cancel scheduled jobs
- `memory-query` — search entity memory and knowledge graph
- `memory-store` — write facts to entity memory (with validation gates)
- `web-fetch` — HTTP GET with configurable timeouts and size limits
- `file-reader` — read files from a configured data directory (not arbitrary filesystem)
- `file-writer` — write files to a configured output directory

---

## Recommended MCP Servers

These are not bundled but documented as recommended integrations:

| Server | Purpose | Link |
|---|---|---|
| **Filesystem** | Scoped file access (read/write/search) | [modelcontextprotocol/servers/filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) |
| **Google Drive** | Read/search Google Docs and Sheets | [modelcontextprotocol/servers/gdrive](https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive) |
| **GitHub** | Repo management, issues, PRs | [modelcontextprotocol/servers/github](https://github.com/modelcontextprotocol/servers/tree/main/src/github) |
| **Brave Search** | Web search for research agents | [modelcontextprotocol/servers/brave-search](https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search) |
| **Fetch** | Web fetching with robots.txt compliance | [modelcontextprotocol/servers/fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) |

Custom MCP servers will be needed for Google Calendar and expense platforms (Expensify, QuickBooks). These can be built as local skills initially and promoted to MCP servers when the protocol stabilizes for those APIs.
