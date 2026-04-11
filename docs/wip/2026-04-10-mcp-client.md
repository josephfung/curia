# MCP Client Layer — Implementation Plan

**Branch:** `feat/mcp-client`
**Issue:** josephfung/curia#270
**Date:** 2026-04-10

---

## What We're Building

Implements the MCP (Model Context Protocol) client layer from spec 03. Allows any
MCP-compatible server (Google Drive, GitHub, filesystem, etc.) to be wired in via
a config entry. Agents don't know or care whether a tool is local or MCP.

Capabilities:
- **stdio transport**: spawn an MCP server process, communicate via stdin/stdout
- **SSE transport**: connect to an HTTP SSE endpoint for remote MCP servers
- At startup: connect to each configured server, run `tools/list`, register discovered
  tools in `SkillRegistry` alongside local skills
- `tools/call` routes through the existing `ExecutionLayer` — sanitization, timeouts,
  and audit logging are inherited automatically

---

## Design Decisions

1. **SDK**: Use `@modelcontextprotocol/sdk` — not hand-rolled
2. **Config**: `config/skills.yaml` (new file, separate from `config/default.yaml`)
3. **Schema translation**: `RegisteredSkill.mcpInputSchema` — stores raw MCP JSON Schema;
   `toToolDefinitions` fast-paths it directly to the LLM without shorthand conversion
4. **`action_risk`**: Required on each server config entry — no default, no silent fallback
5. **`sensitivity`**: `normal` by default for MCP tools; can be overridden per-server
6. **Connection failures**: warn + continue (not crash) — a missing MCP server shouldn't
   take down the system
7. **Startup validation**: `config/skills.yaml` validated via `runStartupValidation` using
   a new `schemas/skills-config.json` Ajv schema

---

## `config/skills.yaml` Shape

```yaml
servers:
  - name: gdrive
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-gdrive"]
    action_risk: low        # required — no default
    sensitivity: normal     # optional, default: normal
    timeout_ms: 30000       # optional, default: 30000
    env:                    # optional — extra env vars for spawned process
      GDRIVE_CREDENTIALS: /run/secrets/gdrive.json

  - name: github
    transport: sse
    url: https://mcp-github.example.com/sse
    action_risk: medium
```

---

## Files

### New Files

| File | Purpose |
|---|---|
| `src/skills/mcp-client.ts` | SDK transport connections. `connectStdio()`, `connectSse()`, `McpSession` type. Zero knowledge of SkillRegistry. |
| `src/skills/mcp-loader.ts` | Config reader + registry integrator. Reads `config/skills.yaml`, connects, runs `tools/list`, synthesizes manifests + handlers, registers. Returns `McpSession[]` for shutdown. |
| `schemas/skills-config.json` | Ajv JSON Schema for `config/skills.yaml` startup validation. |
| `src/skills/mcp-loader.test.ts` | Tests: absent file, connection failure (warn only), tool registration, tools/call round-trip. |
| `docs/adr/016-mcp-sdk-dependency.md` | ADR documenting choice of official SDK and registry-transparent design. |

### Modified Files

| File | Change |
|---|---|
| `package.json` | Add `@modelcontextprotocol/sdk` to dependencies |
| `src/skills/types.ts` | Add `mcpInputSchema?: ToolDefinition['input_schema']` to `RegisteredSkill` |
| `src/skills/registry.ts` | Fast-path in `toToolDefinitions`: if `skill.mcpInputSchema` is set, emit it directly |
| `src/startup/validator.ts` | Add `skills.yaml` validation step using `schemas/skills-config.json`; absent file = skip silently |
| `src/index.ts` | Call `loadMcpServers()` after `loadSkillsFromDirectory()`; capture sessions; close in shutdown |
| `CHANGELOG.md` | Add entry under `[Unreleased]` |

---

## Data Flow

### Startup (config → connect → register)

```
config/skills.yaml
  ↓ (parsed by js-yaml in mcp-loader.ts)
servers[]
  ↓ for each server:
mcp-client.ts: connectStdio() or connectSse()
  → spawns process / opens SSE connection
  → Client.connect()
  → returns McpSession { serverId, client, close() }
  ↓
McpSession.client.listTools()
  → Tool[] { name, description, inputSchema }
  ↓ for each tool:
synthesize SkillManifest (action_risk, sensitivity from server config; name/description from tool)
synthesize SkillHandler (execute() → client.callTool({ name, arguments: ctx.input }))
  ↓
registry.register(manifest, handler)  ← with mcpInputSchema: tool.inputSchema
```

### Runtime (tools/call)

```
AgentRuntime → ExecutionLayer.invoke('tool-name', input)
  → registry.get('tool-name')        # finds MCP-registered entry
  → sensitivity / timeout / sanitize  # all inherited, unchanged
  → SkillHandler.execute(ctx)
    → client.callTool({ name, arguments: ctx.input })
    → maps MCP result → SkillResult
  → sanitizeOutput applied
  → SkillResult returned to AgentRuntime
```

### toToolDefinitions fast-path

```
skillRegistry.toToolDefinitions(pinnedSkills)
  ↓ for each name:
registry.get(name)
  → if skill.mcpInputSchema:
      push { name, description, input_schema: mcpInputSchema }  ← fast-path
  → else:
      shorthand parsing loop (existing behavior, local skills)
```

---

## Implementation Notes

- **Handler result mapping**: MCP `callTool` returns `{ content: Array<{type, text}>, isError? }`.
  Map `isError: true` → `{ success: false, error }`, else → `{ success: true, data: content.map(c=>c.text).join('') }`.
  The handler must never throw — catch all SDK errors and return `{ success: false, error }`.

- **Timeout**: `manifest.timeout` set from server config's `timeout_ms`. ExecutionLayer's
  existing `Promise.race` gate applies unchanged.

- **`inputs: {}`** on synthesized manifests: ExecutionLayer's timestamp normalization loop
  runs zero iterations. Correct — MCP args are passed verbatim.

- **`action_risk` double-validation**: Ajv validates in YAML; `registry.register()` validates
  again. Harmless defense-in-depth.

- **Absent `skills.yaml`**: Both the validator and `loadMcpServers` treat absence as
  "no MCP servers configured" — ENOENT → return early, no error.

---

## Build Sequence

- [x] Create git worktree (`feat/mcp-client`)
- [ ] Save this plan to `docs/wip/`
- [ ] Add `@modelcontextprotocol/sdk` to `package.json`, run `pnpm install`
- [ ] Create `schemas/skills-config.json`
- [ ] Add `mcpInputSchema` to `RegisteredSkill` in `src/skills/types.ts`
- [ ] Add fast-path in `SkillRegistry.toToolDefinitions` in `src/skills/registry.ts`
- [ ] Create `src/skills/mcp-client.ts`
- [ ] Create `src/skills/mcp-loader.ts`
- [ ] Add `skills.yaml` validation to `src/startup/validator.ts`
- [ ] Wire `loadMcpServers` + shutdown into `src/index.ts`
- [ ] Write `src/skills/mcp-loader.test.ts`
- [ ] Write ADR `docs/adr/016-mcp-sdk-dependency.md`
- [ ] Update `CHANGELOG.md` and bump `package.json` version to `0.17.0`

---

## Version

Minor bump to `0.17.0` — new capability (MCP client layer, first MCP server support).
