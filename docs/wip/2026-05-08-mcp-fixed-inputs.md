# MCP `fixed_inputs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind constant MCP tool parameters (like `user_google_email`) at the config/tool layer so agents never see or reason about them, replacing the fragile system prompt injection approach.

**Architecture:** Add a `fixed_inputs` field to MCP server entries in `skills.yaml`. Values are resolved once at startup (supporting `env:VAR_NAME` references). The MCP loader strips these keys from tool schemas before registration and merges resolved values into every `callTool` invocation. The entire Google Workspace prompt injection path is then deleted.

**Tech Stack:** TypeScript, Vitest, YAML config

---

### Task 1: Export `resolveEnvValue` from `config.ts`

**Files:**
- Modify: `src/config.ts:646`

The `resolveEnvValue()` function is currently module-private. The MCP loader needs it to resolve `env:VAR_NAME` references in `fixed_inputs`. Export it without changing its signature or behavior.

- [ ] **Step 1: Add `export` keyword**

In `src/config.ts`, line 646, change:

```typescript
function resolveEnvValue(value: string, context: string): string {
```

to:

```typescript
export function resolveEnvValue(value: string, context: string): string {
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `npm --prefix <worktree> test -- src/config`

Expected: all existing config tests pass (no behavior change, just visibility).

- [ ] **Step 3: Commit**

```bash
git -C <worktree> add src/config.ts
git -C <worktree> commit -m "refactor: export resolveEnvValue from config.ts for reuse in mcp-loader"
```

---

### Task 2: Add `fixed_inputs` to MCP config types and resolve at load time

**Files:**
- Modify: `src/skills/mcp-loader.ts:24-49` (config types) and `src/skills/mcp-loader.ts:161` (server loop)

- [ ] **Step 1: Add `fixed_inputs` to both server entry interfaces**

In `src/skills/mcp-loader.ts`, add the field to `McpStdioServerEntry` (after line 32) and `McpSseServerEntry` (after line 42):

```typescript
interface McpStdioServerEntry {
  name: string;
  transport: 'stdio';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Constant parameter values injected into every tool call from this server.
   *  Keys are parameter names; values are literal strings or "env:VAR_NAME" references.
   *  Listed parameters are stripped from the tool schema — agents never see them. */
  fixed_inputs?: Record<string, string>;
}

interface McpSseServerEntry {
  name: string;
  transport: 'sse';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  url: string;
  headers?: Record<string, string>;
  /** Constant parameter values injected into every tool call from this server.
   *  Keys are parameter names; values are literal strings or "env:VAR_NAME" references.
   *  Listed parameters are stripped from the tool schema — agents never see them. */
  fixed_inputs?: Record<string, string>;
}
```

- [ ] **Step 2: Add import for `resolveEnvValue`**

At the top of `src/skills/mcp-loader.ts`, add to the existing config import:

```typescript
import { resolveEnvValue } from '../config.js';
```

- [ ] **Step 3: Resolve `fixed_inputs` at the top of the server loop**

In `loadMcpServers()`, immediately after the transport validation block (after line 177), add resolution logic:

```typescript
    // Resolve fixed_inputs once at startup. These values are captured in closures
    // and merged into every callTool invocation for this server's tools.
    // Env-var references (e.g. "env:CURIA_GOOGLE_EMAIL") are resolved here —
    // a missing env var causes a startup failure with a clear error message.
    const rawFixedInputs = 'fixed_inputs' in serverEntry ? serverEntry.fixed_inputs : undefined;
    const resolvedFixedInputs: Record<string, string> = {};
    if (rawFixedInputs) {
      for (const [key, value] of Object.entries(rawFixedInputs)) {
        resolvedFixedInputs[key] = resolveEnvValue(
          value,
          `MCP server '${serverEntry.name}' fixed_inputs.${key}`,
        );
      }
      logger.info(
        { server: serverEntry.name, keys: Object.keys(resolvedFixedInputs) },
        'MCP server fixed_inputs resolved',
      );
    }
```

- [ ] **Step 4: Verify the project compiles**

Run: `npm --prefix <worktree> run build`

Expected: clean compilation, no type errors.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/skills/mcp-loader.ts
git -C <worktree> commit -m "feat: add fixed_inputs config type and env-var resolution to MCP loader"
```

---

### Task 3: Strip `fixed_inputs` keys from tool schemas and inject at call time

**Files:**
- Modify: `src/skills/mcp-loader.ts:270-276` (schema construction and handler)

This is the core behavior change: agents never see `fixed_inputs` parameters, and every `callTool` receives the resolved values.

- [ ] **Step 1: Add schema stripping before registration**

In the tool registration loop, replace the current `mcpInputSchema` assignment (line 273) and the `registry.register` call (line 276) with logic that strips fixed_inputs keys:

Replace lines 270–276:

```typescript
      // Build the raw MCP input schema for the fast-path in toToolDefinitions.
      // The MCP SDK returns `inputSchema` as a full JSON Schema object; we cast
      // it to the ToolDefinition input_schema shape which shares the same structure.
      const mcpInputSchema = tool.inputSchema as import('./types.js').ToolDefinition['input_schema'];
```

With:

```typescript
      // Build the raw MCP input schema for the fast-path in toToolDefinitions.
      // The MCP SDK returns `inputSchema` as a full JSON Schema object; we cast
      // it to the ToolDefinition input_schema shape which shares the same structure.
      //
      // When fixed_inputs are configured, strip those keys from the schema so
      // agents never see them as tool parameters. The values are injected
      // server-side in the execute handler below.
      let mcpInputSchema = tool.inputSchema as import('./types.js').ToolDefinition['input_schema'];
      const fixedKeys = Object.keys(resolvedFixedInputs);
      if (fixedKeys.length > 0) {
        mcpInputSchema = structuredClone(mcpInputSchema);
        for (const key of fixedKeys) {
          delete mcpInputSchema.properties[key];
        }
        if (mcpInputSchema.required) {
          mcpInputSchema.required = mcpInputSchema.required.filter(
            r => !fixedKeys.includes(r),
          );
        }
      }
```

- [ ] **Step 2: Inject `fixed_inputs` into `callTool` arguments**

In the `execute` handler, replace the `arguments: ctx.input` line (line 251) with a merge that gives fixed_inputs precedence:

Replace:

```typescript
            const rawResult = await capturedSession.client.callTool({
              name: toolName,
              arguments: ctx.input,
            });
```

With:

```typescript
            // Merge fixed_inputs into the tool call arguments. Fixed values take
            // precedence — even if an agent somehow passed a value for a stripped
            // parameter (e.g. via prompt injection), the config value wins.
            const mergedInput = Object.keys(resolvedFixedInputs).length > 0
              ? { ...ctx.input, ...resolvedFixedInputs }
              : ctx.input;
            const rawResult = await capturedSession.client.callTool({
              name: toolName,
              arguments: mergedInput,
            });
```

- [ ] **Step 3: Verify the project compiles**

Run: `npm --prefix <worktree> run build`

Expected: clean compilation.

- [ ] **Step 4: Commit**

```bash
git -C <worktree> add src/skills/mcp-loader.ts
git -C <worktree> commit -m "feat: strip fixed_inputs from tool schemas and inject at call time"
```

---

### Task 4: Write unit tests for `fixed_inputs` behavior

**Files:**
- Create: `src/skills/mcp-loader.test.ts`

These tests exercise the three key behaviors: schema stripping, call-time injection, and startup failure on missing env vars. Since `loadMcpServers` connects to real MCP servers, we need to test the extracted logic. The simplest approach: extract the schema-stripping and input-merging logic into testable pure functions, or test via the full `loadMcpServers` path with a mock MCP server.

Given the codebase pattern (loader.test.ts uses real filesystem + registry), the cleanest approach is to test the schema stripping and merging as isolated logic. We'll extract two small helpers from the inline code in Task 3 and test them directly.

- [ ] **Step 1: Extract `stripFixedInputsFromSchema` and `mergeFixedInputs` helpers**

In `src/skills/mcp-loader.ts`, add two exported helper functions after the `mapMcpResult` function (after line 131):

```typescript
// ---------------------------------------------------------------------------
// fixed_inputs helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Remove fixed_inputs keys from an MCP tool's JSON Schema so agents never see
 * them as tool parameters. Returns a deep clone; the original is not mutated.
 */
export function stripFixedInputsFromSchema(
  schema: import('./types.js').ToolDefinition['input_schema'],
  fixedKeys: string[],
): import('./types.js').ToolDefinition['input_schema'] {
  if (fixedKeys.length === 0) return schema;
  const stripped = structuredClone(schema);
  for (const key of fixedKeys) {
    delete stripped.properties[key];
  }
  if (stripped.required) {
    stripped.required = stripped.required.filter(r => !fixedKeys.includes(r));
  }
  return stripped;
}

/**
 * Merge resolved fixed_inputs into tool call arguments. Fixed values take
 * precedence over agent-supplied values to prevent prompt injection overrides.
 */
export function mergeFixedInputs(
  agentInput: Record<string, unknown>,
  fixedInputs: Record<string, string>,
): Record<string, unknown> {
  if (Object.keys(fixedInputs).length === 0) return agentInput;
  return { ...agentInput, ...fixedInputs };
}
```

- [ ] **Step 2: Update the inline code in `loadMcpServers` to use the helpers**

Replace the inline schema-stripping code from Task 3 Step 1 with:

```typescript
      let mcpInputSchema = tool.inputSchema as import('./types.js').ToolDefinition['input_schema'];
      const fixedKeys = Object.keys(resolvedFixedInputs);
      if (fixedKeys.length > 0) {
        mcpInputSchema = stripFixedInputsFromSchema(mcpInputSchema, fixedKeys);
      }
```

Replace the inline merge code from Task 3 Step 2 with:

```typescript
            const mergedInput = mergeFixedInputs(ctx.input, resolvedFixedInputs);
            const rawResult = await capturedSession.client.callTool({
              name: toolName,
              arguments: mergedInput,
            });
```

- [ ] **Step 3: Write the test file**

Create `src/skills/mcp-loader.test.ts`:

```typescript
// mcp-loader.test.ts — tests for fixed_inputs schema stripping and call-time injection.
//
// These test the pure helper functions extracted from loadMcpServers. The full
// integration path (YAML → connect → register) is covered by startup smoke tests;
// these unit tests verify the mechanical correctness of schema manipulation and
// argument merging.

import { describe, it, expect } from 'vitest';
import { stripFixedInputsFromSchema, mergeFixedInputs } from './mcp-loader.js';

// ---------------------------------------------------------------------------
// stripFixedInputsFromSchema
// ---------------------------------------------------------------------------

describe('stripFixedInputsFromSchema', () => {
  it('removes fixed keys from properties and required', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string', description: 'The user email' },
        query: { type: 'string', description: 'Search query' },
      },
      required: ['user_google_email', 'query'],
    };

    const result = stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(result.properties).toEqual({
      query: { type: 'string', description: 'Search query' },
    });
    expect(result.required).toEqual(['query']);
  });

  it('does not mutate the original schema', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['user_google_email', 'query'],
    };

    stripFixedInputsFromSchema(schema, ['user_google_email']);

    // Original must be unchanged
    expect(schema.properties).toHaveProperty('user_google_email');
    expect(schema.required).toContain('user_google_email');
  });

  it('returns schema unchanged when fixedKeys is empty', () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    };

    const result = stripFixedInputsFromSchema(schema, []);

    // Same reference — no clone needed when there's nothing to strip
    expect(result).toBe(schema);
  });

  it('handles schema with no required array', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        user_google_email: { type: 'string' },
        query: { type: 'string' },
      },
    };

    const result = stripFixedInputsFromSchema(schema, ['user_google_email']);

    expect(result.properties).toEqual({ query: { type: 'string' } });
    expect(result.required).toBeUndefined();
  });

  it('handles stripping a key not present in schema (no-op)', () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    };

    const result = stripFixedInputsFromSchema(schema, ['nonexistent_key']);

    expect(result.properties).toEqual({ query: { type: 'string' } });
    expect(result.required).toEqual(['query']);
  });
});

// ---------------------------------------------------------------------------
// mergeFixedInputs
// ---------------------------------------------------------------------------

describe('mergeFixedInputs', () => {
  it('merges fixed values into agent input', () => {
    const agentInput = { query: 'quarterly report' };
    const fixedInputs = { user_google_email: 'curia@example.com' };

    const result = mergeFixedInputs(agentInput, fixedInputs);

    expect(result).toEqual({
      query: 'quarterly report',
      user_google_email: 'curia@example.com',
    });
  });

  it('fixed values override agent-supplied values', () => {
    const agentInput = {
      query: 'quarterly report',
      user_google_email: 'attacker@evil.com',
    };
    const fixedInputs = { user_google_email: 'curia@example.com' };

    const result = mergeFixedInputs(agentInput, fixedInputs);

    expect(result.user_google_email).toBe('curia@example.com');
  });

  it('returns original reference when fixedInputs is empty', () => {
    const agentInput = { query: 'test' };

    const result = mergeFixedInputs(agentInput, {});

    expect(result).toBe(agentInput);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix <worktree> test -- src/skills/mcp-loader.test.ts`

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/skills/mcp-loader.ts src/skills/mcp-loader.test.ts
git -C <worktree> commit -m "test: add unit tests for fixed_inputs schema stripping and merging"
```

---

### Task 5: Test startup failure on missing env var

**Files:**
- Modify: `src/skills/mcp-loader.test.ts`

This tests that `resolveEnvValue` throws when a `fixed_inputs` value references an unset env var. Since `resolveEnvValue` is already unit-tested implicitly via config tests, we add a focused test that exercises the integration point in the MCP loader context.

- [ ] **Step 1: Add a test for `resolveEnvValue` with `env:` prefix**

Append to `src/skills/mcp-loader.test.ts`:

```typescript
// ---------------------------------------------------------------------------
// resolveEnvValue integration (imported from config.ts)
// ---------------------------------------------------------------------------

import { resolveEnvValue } from '../config.js';

describe('resolveEnvValue (fixed_inputs context)', () => {
  it('resolves env:VAR_NAME from process.env', () => {
    const original = process.env.TEST_FIXED_INPUT_EMAIL;
    try {
      process.env.TEST_FIXED_INPUT_EMAIL = 'curia@example.com';
      const result = resolveEnvValue('env:TEST_FIXED_INPUT_EMAIL', 'test context');
      expect(result).toBe('curia@example.com');
    } finally {
      if (original === undefined) {
        delete process.env.TEST_FIXED_INPUT_EMAIL;
      } else {
        process.env.TEST_FIXED_INPUT_EMAIL = original;
      }
    }
  });

  it('throws with a clear message when env var is not set', () => {
    delete process.env.DEFINITELY_NOT_SET_VAR;
    expect(() =>
      resolveEnvValue('env:DEFINITELY_NOT_SET_VAR', "MCP server 'google-workspace' fixed_inputs.user_google_email"),
    ).toThrow(/env var "DEFINITELY_NOT_SET_VAR" is not set/);
  });

  it('passes through literal strings unchanged', () => {
    const result = resolveEnvValue('literal@example.com', 'test context');
    expect(result).toBe('literal@example.com');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm --prefix <worktree> test -- src/skills/mcp-loader.test.ts`

Expected: all 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git -C <worktree> add src/skills/mcp-loader.test.ts
git -C <worktree> commit -m "test: add resolveEnvValue integration tests for fixed_inputs startup failure"
```

---

### Task 6: Update `skills.yaml` with `fixed_inputs`

**Files:**
- Modify: `config/skills.yaml:57-69`

- [ ] **Step 1: Add `fixed_inputs` to the google-workspace entry**

In `config/skills.yaml`, after the `env` block (after line 66), add:

```yaml
    # Bind the Google Workspace user email at the tool layer so agents never see
    # or reason about it. Resolved from CURIA_GOOGLE_EMAIL env var at startup.
    # This replaces the system prompt injection approach (#387) which was fragile
    # because LLMs could hallucinate different email addresses.
    fixed_inputs:
      user_google_email: "env:CURIA_GOOGLE_EMAIL"
```

The full entry should now read:

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
    # Bind the Google Workspace user email at the tool layer so agents never see
    # or reason about it. Resolved from CURIA_GOOGLE_EMAIL env var at startup.
    # This replaces the system prompt injection approach (#387) which was fragile
    # because LLMs could hallucinate different email addresses.
    fixed_inputs:
      user_google_email: "env:CURIA_GOOGLE_EMAIL"
    action_risk: low
    sensitivity: normal
    timeout_ms: 60000
```

- [ ] **Step 2: Update the `skills.yaml` header comments to document `fixed_inputs`**

Add a new field description block after the `env` documentation (after line 18):

```yaml
#   fixed_inputs Optional. Constant parameter values injected into every tool call.
#                Keys are parameter names; values are literal strings or "env:VAR"
#                references. Listed parameters are stripped from the tool schema —
#                agents never see them. Use for deployment constants like account
#                identity that should not be in the agent reasoning layer.
```

- [ ] **Step 3: Commit**

```bash
git -C <worktree> add config/skills.yaml
git -C <worktree> commit -m "feat: add fixed_inputs.user_google_email to google-workspace MCP config"
```

---

### Task 7: Remove Google Workspace prompt injection from `runtime.ts`

**Files:**
- Modify: `src/agents/runtime.ts:19` (import), `src/agents/runtime.ts:64-68` (AgentConfig field), `src/agents/runtime.ts:268-285` (injection block)

- [ ] **Step 1: Remove the `ResolvedGoogleWorkspaceAccount` import**

In `src/agents/runtime.ts`, line 19, delete:

```typescript
import type { ResolvedGoogleWorkspaceAccount } from '../config.js';
```

- [ ] **Step 2: Remove the `googleWorkspaceAccounts` field from `AgentConfig`**

In `src/agents/runtime.ts`, delete lines 64–68:

```typescript
  /** Resolved Google Workspace accounts from config. When provided, a "Your Google Workspace
   *  Accounts" block is appended to the system prompt so agents know which account to use when
   *  Google Workspace MCP tools require a `user_google_email` parameter. Injected into all
   *  agents to prevent LLM hallucination of email addresses (#387). */
  googleWorkspaceAccounts?: ResolvedGoogleWorkspaceAccount[];
```

- [ ] **Step 3: Remove the prompt injection block**

In `src/agents/runtime.ts`, delete lines 268–285 (the entire `googleWorkspaceAccounts` injection block):

```typescript
    // Append Google Workspace account details so agents know which account to use when
    // Google Drive, Docs, or other Workspace MCP tools require a `user_google_email` param.
    // Without this, the LLM hallucinates email addresses (#387 root cause 1).
    // Injected into ALL agents — specialists like essay-editor need this too.
    const { googleWorkspaceAccounts } = this.config;
    if (googleWorkspaceAccounts && googleWorkspaceAccounts.length > 0) {
      const lines: string[] = ['## Your Google Workspace Accounts'];
      lines.push('When calling Google Drive, Google Docs, or other Google Workspace tools that');
      lines.push('require a `user_google_email` parameter, use your primary account. If the tool');
      lines.push('returns an authentication error, retry with the next available account before');
      lines.push('reporting failure.');
      lines.push('');
      for (const acct of googleWorkspaceAccounts) {
        const marker = acct.primary ? ' (primary)' : '';
        lines.push(`- ${acct.name}: ${acct.googleEmail}${marker}`);
      }
      effectiveSystemPrompt += '\n\n' + lines.join('\n');
    }
```

- [ ] **Step 4: Verify the project compiles**

Run: `npm --prefix <worktree> run build`

Expected: compilation may fail due to `index.ts` still referencing `googleWorkspaceAccounts`. That's expected — it will be fixed in Task 8. If it compiles clean, even better.

- [ ] **Step 5: Commit**

```bash
git -C <worktree> add src/agents/runtime.ts
git -C <worktree> commit -m "fix: remove Google Workspace prompt injection block from runtime (#432)"
```

---

### Task 8: Remove Google Workspace config types, validation, and wiring

**Files:**
- Modify: `src/config.ts:19,44-61,133-135,487-517,718-750`
- Modify: `src/index.ts:22,439-445,985-988`
- Modify: `config/default.yaml:42-62`

- [ ] **Step 1: Remove types from `config.ts`**

Delete the `RawGoogleWorkspaceAccountConfig` interface (lines 44–48) and the `ResolvedGoogleWorkspaceAccount` interface (lines 55–61), along with their section comment (lines 36–38):

```typescript
// ---------------------------------------------------------------------------
// Google Workspace account config types
// ---------------------------------------------------------------------------

/**
 * Raw per-account Google Workspace entry as read from config/default.yaml.
 * Values may be literal strings or "env:VAR_NAME" env-var references.
 */
export interface RawGoogleWorkspaceAccountConfig {
  google_email: string;
  /** When true, this is the default account for Google Workspace MCP tools. */
  primary?: boolean;
}

/**
 * Fully resolved Google Workspace account config with env-var references expanded.
 * Injected into all agent system prompts so LLMs know which account to use when
 * Google Workspace tools require a `user_google_email` parameter.
 */
export interface ResolvedGoogleWorkspaceAccount {
  /** Logical name for this account as declared in the YAML (e.g. "curia", "joseph"). */
  name: string;
  googleEmail: string;
  /** When true, this is the default account for Google Workspace MCP tools. */
  primary: boolean;
}
```

- [ ] **Step 2: Remove `google_workspace` from `YamlConfig.channel_accounts`**

In the `channel_accounts` type (around line 133-135), remove the `google_workspace` field:

```typescript
  channel_accounts?: {
    email?: Record<string, RawEmailAccountConfig>;
    google_workspace?: Record<string, RawGoogleWorkspaceAccountConfig>;
  };
```

Becomes:

```typescript
  channel_accounts?: {
    email?: Record<string, RawEmailAccountConfig>;
  };
```

- [ ] **Step 3: Remove `google_workspace` validation block**

Delete lines 487–517 (the entire `// Validate channel_accounts.google_workspace if present` block).

- [ ] **Step 4: Remove `resolveGoogleWorkspaceAccounts` function**

Delete lines 718–750 (the entire function and its JSDoc).

- [ ] **Step 5: Remove wiring from `index.ts`**

In `src/index.ts`, line 22, remove `resolveGoogleWorkspaceAccounts` from the import:

```typescript
import { loadConfig, loadYamlConfig, resolveChannelAccounts, resolveGoogleWorkspaceAccounts } from './config.js';
```

Becomes:

```typescript
import { loadConfig, loadYamlConfig, resolveChannelAccounts } from './config.js';
```

Delete lines 439–445 (the `resolveGoogleWorkspaceAccounts` call and logging block):

```typescript
  const resolvedGoogleWorkspaceAccounts = resolveGoogleWorkspaceAccounts(yamlConfig);
  if (resolvedGoogleWorkspaceAccounts.length > 0) {
    logger.info(
      { accounts: resolvedGoogleWorkspaceAccounts.map(a => ({ name: a.name, primary: a.primary })) },
      `Google Workspace: ${resolvedGoogleWorkspaceAccounts.length} account(s) configured`,
    );
  }
```

Delete lines 985–988 (the `googleWorkspaceAccounts` wiring in the agent config object):

```typescript
      // Google Workspace accounts — injected into ALL agents so they know which account
      // to use for Google Drive/Docs MCP tools, preventing email hallucination (#387).
      googleWorkspaceAccounts: resolvedGoogleWorkspaceAccounts.length > 0
        ? resolvedGoogleWorkspaceAccounts : undefined,
```

- [ ] **Step 6: Remove Google Workspace comments from `default.yaml`**

In `config/default.yaml`, delete lines 42–62 (the entire commented-out `google_workspace` documentation block):

```yaml
# Google Workspace account configuration.
#
# channel_accounts.google_workspace defines one or more named Google Workspace accounts
# ...
# deployment-specific names (no personal names) in env vars.
```

- [ ] **Step 7: Verify the project compiles**

Run: `npm --prefix <worktree> run build`

Expected: clean compilation with no references to the removed types.

- [ ] **Step 8: Run the full test suite**

Run: `npm --prefix <worktree> test`

Expected: all tests pass. If any test references `googleWorkspaceAccounts` or the removed types, update it.

- [ ] **Step 9: Commit**

```bash
git -C <worktree> add src/config.ts src/index.ts config/default.yaml
git -C <worktree> commit -m "fix: remove Google Workspace config types, validation, and wiring (#432)"
```

---

### Task 9: Verify no account-specific email references remain

**Files:** None (read-only verification)

- [ ] **Step 1: Search for hardcoded Google Workspace email addresses**

Run: `grep -r "nathancuria1@gmail.com" <worktree>/src <worktree>/config <worktree>/agents`

Expected: zero matches. If any are found, remove them.

- [ ] **Step 2: Search for the old prompt injection pattern**

Run: `grep -r "googleWorkspaceAccounts\|google_workspace\|Your Google Workspace Accounts" <worktree>/src <worktree>/config <worktree>/agents`

Expected: zero matches in code. The only match should be in the design doc in `docs/wip/`.

- [ ] **Step 3: Search for any remaining `user_google_email` in agent prompts**

Run: `grep -r "user_google_email" <worktree>/agents`

Expected: zero matches. Agent YAML files should not reference this parameter.

---

### Task 10: Update CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entries under `## [Unreleased]`**

Add the following under the appropriate sections in `## [Unreleased]`:

Under `### Added`:
```markdown
- **MCP `fixed_inputs`** — MCP server entries in `skills.yaml` now support a `fixed_inputs` field that binds constant parameter values at the tool layer. Values are resolved from env vars or literals at startup, stripped from tool schemas (invisible to agents), and merged into every `callTool` invocation (#432)
```

Under `### Removed`:
```markdown
- **Google Workspace prompt injection** — removed the `googleWorkspaceAccounts` system prompt injection block, the `channel_accounts.google_workspace` config schema, and all related types/wiring. Google Workspace account identity is now handled via `fixed_inputs` on the MCP server config (#432)
```

- [ ] **Step 2: Commit**

```bash
git -C <worktree> add CHANGELOG.md
git -C <worktree> commit -m "docs: update CHANGELOG for MCP fixed_inputs (#432)"
```

---

### Task 11: Add `CURIA_GOOGLE_EMAIL` to `.env.example` (deployment documentation)

**Files:**
- Modify: `.env.example` (or equivalent deployment doc)

- [ ] **Step 1: Check if `.env.example` exists**

Run: `ls <worktree>/.env.example`

If it exists, add:

```bash
# Google Workspace email for MCP tools (required if google-workspace MCP server is configured)
CURIA_GOOGLE_EMAIL=
```

If no `.env.example` exists, add a note to the PR description instead:

> **Deployment step:** Add `CURIA_GOOGLE_EMAIL=nathancuria1@gmail.com` to production `.env`. Without this, the google-workspace MCP server will fail to load at startup.

- [ ] **Step 2: Commit (if file was modified)**

```bash
git -C <worktree> add .env.example
git -C <worktree> commit -m "docs: add CURIA_GOOGLE_EMAIL to .env.example"
```
