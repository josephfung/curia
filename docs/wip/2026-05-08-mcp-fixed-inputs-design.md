# MCP `fixed_inputs` — Design

**Issue:** [#432](https://github.com/josephfung/curia/issues/432)
**Date:** 2026-05-08

## Problem

`workspace-mcp` exposes `user_google_email` as a parameter on every tool. Curia
surfaces this to agents as something they must provide, then relies on system
prompt injection to tell agents what value to use. This fails because:

1. The `channel_accounts.google_workspace` config was never populated in
   `default.yaml`, so the injection never fires — agents hallucinate the email.
2. Even when populated, LLM instruction-following is not a reliable enforcement
   mechanism for an identity constant.

The root cause is that `user_google_email` is a multi-tenant feature of the MCP
server. Curia is single-identity and always acts as one account. This is a
deployment fact, not a per-call decision, and should not be in the agent
reasoning layer at all.

## Solution: `fixed_inputs` on MCP server config

Introduce a `fixed_inputs` field on MCP server entries in `skills.yaml`. These
are parameter values resolved once at startup and applied to every tool call for
that server — invisible to agents.

```yaml
- name: google-workspace
  transport: stdio
  command: uvx
  args:
    - workspace-mcp
    - --tool-tier
    - extended
  env:
    GOOGLE_OAUTH_CLIENT_ID: ""
    GOOGLE_OAUTH_CLIENT_SECRET: ""
  fixed_inputs:
    user_google_email: "env:CURIA_GOOGLE_EMAIL"
  action_risk: low
  sensitivity: normal
  timeout_ms: 60000
```

### Design decisions

- **String-only values.** `fixed_inputs` values are strings — either literal or
  `env:VAR_NAME` references. No JSON types. YAGNI; MCP tool arguments are
  typically strings, and the existing `resolveEnvValue()` handles this pattern.
- **Resolve at load time, inject at call time.** Values are resolved once during
  `loadMcpServers()` startup. Resolved values are captured in closures and merged
  into `ctx.input` on every `callTool`. This matches the existing `buildChildEnv()`
  pattern — env vars are resolved once, not per-call.
- **Fail fast.** If an `env:` reference can't be resolved at startup, the error
  propagates and the server fails to load. Same behavior as missing credentials
  in `config.ts`.

## Changes

### 1. Config types (`src/skills/mcp-loader.ts`)

Add `fixed_inputs` to `McpStdioServerEntry` and `McpSseServerEntry`:

```typescript
fixed_inputs?: Record<string, string>;
```

### 2. Resolution at load time (`src/skills/mcp-loader.ts`)

At the top of the server loop in `loadMcpServers()`, resolve all `fixed_inputs`
entries using the existing `resolveEnvValue()` from `config.ts`. Store the
resolved map in a local `const` captured by tool handler closures.

`resolveEnvValue()` is currently module-private in `config.ts`. It will be
exported so `mcp-loader.ts` can use it.

### 3. Schema stripping (`src/skills/mcp-loader.ts`)

After receiving `tool.inputSchema` from MCP but before registration, strip
`fixed_inputs` keys from the schema:

- Delete keys from `properties`
- Filter keys from `required` array

This makes the parameters invisible to agents.

```typescript
if (Object.keys(resolvedFixedInputs).length > 0) {
  const schema = structuredClone(tool.inputSchema);
  if (schema.properties) {
    for (const key of Object.keys(resolvedFixedInputs)) {
      delete schema.properties[key];
    }
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter(
      (r: string) => !(r in resolvedFixedInputs)
    );
  }
}
```

### 4. Call-time injection (`src/skills/mcp-loader.ts`)

In the `execute` handler, merge resolved values into `ctx.input` before
`callTool`. Fixed inputs take precedence over any agent-supplied values:

```typescript
const mergedInput = { ...ctx.input, ...resolvedFixedInputs };
const rawResult = await capturedSession.client.callTool({
  name: toolName,
  arguments: mergedInput,
});
```

### 5. `config/skills.yaml`

Add `fixed_inputs` to the google-workspace entry:

```yaml
fixed_inputs:
  user_google_email: "env:CURIA_GOOGLE_EMAIL"
```

### 6. Cleanup — remove prompt injection path

| File | What to remove |
|---|---|
| `src/agents/runtime.ts` | `googleWorkspaceAccounts` field from `AgentConfig`; the "Your Google Workspace Accounts" system prompt injection block (lines 268–285) |
| `src/config.ts` | `RawGoogleWorkspaceAccountConfig` and `ResolvedGoogleWorkspaceAccount` interfaces; `resolveGoogleWorkspaceAccounts()` function; `google_workspace` validation block |
| `config/default.yaml` | `channel_accounts.google_workspace` section and comments |
| `src/index.ts` | `resolveGoogleWorkspaceAccounts()` call and `googleWorkspaceAccounts` wiring to agent configs |

Ensure no agent YAML, task payload, or system prompt contains a reference to
`nathancuria1@gmail.com` or any account-specific Google Workspace email.

### 7. Deployment

Add `CURIA_GOOGLE_EMAIL=nathancuria1@gmail.com` to production `.env`. Without
this, `resolveEnvValue()` throws at startup (by design).

### 8. Testing (`src/skills/mcp-loader.test.ts`)

| Test case | What it verifies |
|---|---|
| Schema stripping | A tool with `user_google_email` in its input schema has that key removed from `properties` and `required` after `fixed_inputs` processing |
| Call-time injection | `callTool` receives resolved `fixed_inputs` values merged into arguments |
| Agent override blocked | If `ctx.input` contains a `fixed_inputs` key, the fixed value wins (spread order) |
| Startup failure on missing env | `loadMcpServers` throws with a clear message if `fixed_inputs` references `env:MISSING_VAR` |

## Out of scope

- Non-string `fixed_inputs` values (numbers, booleans, objects)
- Per-tool `fixed_inputs` (all tools on a server share the same fixed inputs)
- Runtime hot-reload of `fixed_inputs` values (consistent with `env` behavior)
