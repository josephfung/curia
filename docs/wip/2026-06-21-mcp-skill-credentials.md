# MCP Skill Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP servers declare required secrets in `skills.yaml`; the web console presents credential fields, writes to the vault, and gates enable/disable on resolution — mirroring the existing Channels registry.

**Architecture:** A new `mcp_server_registry` table and `McpRegistryService` parallel `channel_registry` + `ChannelRegistryService` exactly. Config types are extracted to a shared `mcp-config-types.ts` so both the loader and registry service can import them without a circular dependency. `loadMcpServers` gains two new behaviors: (1) resolve secrets from the `secrets:` declaration block via `resolveSecretsBlock()`, and (2) skip servers not in the enabled set from the registry.

**Tech Stack:** TypeScript/ESM, Fastify, node-postgres, Vitest, React + TanStack Router (console), `js-yaml` (already used by mcp-loader)

## Global Constraints

- ESM only: `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`
- Parameterized SQL only — never interpolate variables into queries
- Vault keys are flat (e.g. `google_oauth_client_id`) — no `mcp.*` namespace
- No `any` types — use generics or proper discriminated unions
- Pino logger everywhere; no `console.log`
- Migration numbering: latest is `062_*`; next is `063_*`. After any rebase, run `ls src/db/migrations/ | sort` and verify no prefix collision
- Commit style: `feat:` / `fix:` / `chore:` — no Co-Authored-By, no Claude credits
- Run `pnpm -C <worktree> run typecheck` before every commit touching `.ts` files
- Worktree path: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds`

---

### Task 1: Extract + extend MCP config types

Extract the private config types from `mcp-loader.ts` into a shared module and add the new `McpSecretDeclaration` / `McpSecretInject` types. Export `loadSkillsConfig` so `index.ts` can call it independently.

**Files:**
- Create: `src/skills/mcp-config-types.ts`
- Modify: `src/skills/mcp-loader.ts` (remove inline type defs, import from mcp-config-types, export `loadSkillsConfig`)
- Modify: `src/skills/mcp-loader.test.ts` (add parsing tests for `secrets:` block)

**Interfaces:**
- Produces: `McpSecretDeclaration`, `McpSecretInject`, `McpStdioServerEntry` (with `secrets?:`), `McpSseServerEntry`, `McpServerEntry`, `SkillsConfig`, `loadSkillsConfig()` — all exported from `src/skills/mcp-config-types.ts` and re-exported or imported in `mcp-loader.ts`

- [ ] **Step 1: Create `src/skills/mcp-config-types.ts`**

```typescript
// src/skills/mcp-config-types.ts
// Shared config types for MCP server entries (skills.yaml schema).
// Imported by both mcp-loader.ts and mcp-registry-service.ts.
import type { ActionRisk } from './types.js';

/** Wiring: how a resolved vault value is delivered to the MCP subprocess. */
export type McpSecretInject =
  | { env: string; fixed_input?: never }        // inject as env var named `env`
  | { fixed_input: string; env?: never };        // inject as fixed_inputs param named `fixed_input`

/** A single declared credential on an MCP server. */
export interface McpSecretDeclaration {
  /** Flat vault key — shareable across skills and MCP servers (e.g. `google_oauth_client_id`). */
  key: string;
  /** Human-readable label for the console credential form. */
  label: string;
  /** True = blocks enable until vault has a non-empty value for this key. */
  required: boolean;
  /** True = masked input in the console UI (passwords); false = plain text (handles, IDs). */
  secret: boolean;
  /** How the resolved vault value reaches the subprocess at spawn time. */
  inject: McpSecretInject;
}

export interface McpStdioServerEntry {
  name: string;
  transport: 'stdio';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  command: string;
  args?: string[];
  /** Non-secret env var literals only. Use secrets[] + inject:{env:} for vault-backed values. */
  env?: Record<string, string>;
  /** Constant tool-call parameters. Use secrets[] + inject:{fixed_input:} for vault-backed values. */
  fixed_inputs?: Record<string, string>;
  /** Declared credentials. Each entry names a flat vault key, provides console metadata,
   *  and specifies how the resolved value is injected into the subprocess. */
  secrets?: McpSecretDeclaration[];
}

export interface McpSseServerEntry {
  name: string;
  transport: 'sse';
  action_risk: ActionRisk;
  sensitivity?: 'normal' | 'elevated';
  timeout_ms?: number;
  url: string;
  headers?: Record<string, string>;
  fixed_inputs?: Record<string, string>;
}

export type McpServerEntry = McpStdioServerEntry | McpSseServerEntry;

export interface SkillsConfig {
  servers?: McpServerEntry[];
}
```

- [ ] **Step 2: Update `src/skills/mcp-loader.ts` — import types, export `loadSkillsConfig`**

At the top of the file, replace the four private interface definitions (`McpStdioServerEntry`, `McpSseServerEntry`, `McpServerEntry`, `SkillsConfig`) with:

```typescript
import type {
  McpServerEntry,
  McpStdioServerEntry,
  McpSecretDeclaration,
  SkillsConfig,
} from './mcp-config-types.js';
```

Change `function loadSkillsConfig` to `export function loadSkillsConfig` (no other changes to the function body).

- [ ] **Step 3: Write failing tests for `loadSkillsConfig` with `secrets:` block**

In `src/skills/mcp-loader.test.ts`, add a `describe('loadSkillsConfig')` block using `tmp` yaml files (the existing test file shows how the suite handles config files via temp dirs):

```typescript
import { loadSkillsConfig } from './mcp-loader.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('loadSkillsConfig', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cfg-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });

  it('parses a server entry with a secrets: block', () => {
    fs.writeFileSync(path.join(tmpDir, 'skills.yaml'), `
servers:
  - name: atproto-mcp
    transport: stdio
    command: ./node_modules/.bin/atproto-mcp
    action_risk: medium
    secrets:
      - key: atproto_identifier
        label: "Bluesky handle"
        required: true
        secret: false
        inject:
          env: ATPROTO_IDENTIFIER
      - key: atproto_password
        label: "Bluesky app password"
        required: true
        secret: true
        inject:
          env: ATPROTO_PASSWORD
`);
    const config = loadSkillsConfig(tmpDir);
    const server = config.servers![0]! as import('./mcp-config-types.js').McpStdioServerEntry;
    expect(server.secrets).toHaveLength(2);
    expect(server.secrets![0]!.key).toBe('atproto_identifier');
    expect(server.secrets![0]!.inject).toEqual({ env: 'ATPROTO_IDENTIFIER' });
    expect(server.secrets![1]!.secret).toBe(true);
  });

  it('returns empty config when secrets: block is absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'skills.yaml'), `
servers:
  - name: legacy-server
    transport: stdio
    command: ./cmd
    action_risk: low
    env:
      SOME_KEY: ""
`);
    const config = loadSkillsConfig(tmpDir);
    const server = config.servers![0]! as import('./mcp-config-types.js').McpStdioServerEntry;
    expect(server.secrets).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run tests — verify new tests fail (loadSkillsConfig not yet exported)**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/skills/mcp-loader.test.ts 2>&1 | tail -20
```
Expected: import error or "loadSkillsConfig is not a function" for the new tests; existing tests still pass.

- [ ] **Step 5: Run tests — verify all tests pass after the edits in Steps 1–2**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/skills/mcp-loader.test.ts 2>&1 | tail -20
```
Expected: all tests PASS including the two new parsing tests.

- [ ] **Step 6: Typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run typecheck 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add src/skills/mcp-config-types.ts src/skills/mcp-loader.ts src/skills/mcp-loader.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "feat: extract MCP config types, add McpSecretDeclaration, export loadSkillsConfig"
```

---

### Task 2: `resolveSecretsBlock()` + loader integration

Add the new declarative resolution helper and update `loadMcpServers` to use it for servers that have a `secrets:` block. Servers without a `secrets:` block continue using the legacy `env:""` / `fixed_inputs:"env:VAR"` paths unchanged.

**Files:**
- Modify: `src/skills/mcp-loader.ts`
- Modify: `src/skills/mcp-loader.test.ts`

**Interfaces:**
- Produces: `resolveSecretsBlock(declarations, secrets, serverName) → Promise<{env, fixedInputs}>` — exported from `mcp-loader.ts`
- Consumes: `McpSecretDeclaration[]`, `SecretsService` (already imported)

- [ ] **Step 1: Write failing tests for `resolveSecretsBlock`**

Add to `src/skills/mcp-loader.test.ts`:

```typescript
import { resolveSecretsBlock } from './mcp-loader.js';
import type { McpSecretDeclaration } from './mcp-config-types.js';

describe('resolveSecretsBlock', () => {
  const makeSecrets = (map: Record<string, string | null>) => ({
    get: async (key: string) => map[key] ?? null,
  });

  it('injects resolved value into env when inject.env is set', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'atproto_identifier', label: 'Handle', required: true, secret: false,
      inject: { env: 'ATPROTO_IDENTIFIER' },
    }];
    const result = await resolveSecretsBlock(decls, makeSecrets({ atproto_identifier: 'user.bsky.social' }), 'test-server');
    expect(result.env).toEqual({ ATPROTO_IDENTIFIER: 'user.bsky.social' });
    expect(result.fixedInputs).toEqual({});
  });

  it('injects resolved value into fixedInputs when inject.fixed_input is set', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'curia_google_email', label: 'Email', required: true, secret: false,
      inject: { fixed_input: 'user_google_email' },
    }];
    const result = await resolveSecretsBlock(decls, makeSecrets({ curia_google_email: 'me@example.com' }), 'test-server');
    expect(result.fixedInputs).toEqual({ user_google_email: 'me@example.com' });
    expect(result.env).toEqual({});
  });

  it('throws when a required secret is missing from the vault', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'atproto_password', label: 'Password', required: true, secret: true,
      inject: { env: 'ATPROTO_PASSWORD' },
    }];
    await expect(resolveSecretsBlock(decls, makeSecrets({}), 'atproto-mcp'))
      .rejects.toThrow('atproto-mcp');
  });

  it('silently skips optional secrets that are absent', async () => {
    const decls: McpSecretDeclaration[] = [{
      key: 'optional_key', label: 'Optional', required: false, secret: false,
      inject: { env: 'OPTIONAL_VAR' },
    }];
    const result = await resolveSecretsBlock(decls, makeSecrets({}), 'test-server');
    expect(result.env).toEqual({});
  });

  it('returns empty maps when declarations array is empty', async () => {
    const result = await resolveSecretsBlock([], makeSecrets({}), 'test-server');
    expect(result).toEqual({ env: {}, fixedInputs: {} });
  });

  it('does not fall back to process.env', async () => {
    process.env['SHOULD_NOT_READ'] = 'leaked';
    const decls: McpSecretDeclaration[] = [{
      key: 'should_not_read', label: 'Test', required: false, secret: false,
      inject: { env: 'SHOULD_NOT_READ' },
    }];
    const result = await resolveSecretsBlock(decls, makeSecrets({}), 'test-server');
    expect(result.env['SHOULD_NOT_READ']).toBeUndefined();
    delete process.env['SHOULD_NOT_READ'];
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/skills/mcp-loader.test.ts 2>&1 | tail -20
```
Expected: `resolveSecretsBlock is not a function` errors on the new tests.

- [ ] **Step 3: Implement `resolveSecretsBlock` in `src/skills/mcp-loader.ts`**

Add this export after the existing `resolveFixedInputFromVault` function:

```typescript
/**
 * Resolve all credentials declared in a server's `secrets:` block from the vault.
 * For each declaration: reads `key` from vault; if `inject.env`, places the value in
 * the returned `env` map under that var name; if `inject.fixed_input`, places it in
 * `fixedInputs`. A missing required secret throws so the caller can skip the server.
 * Missing optional secrets are silently skipped. Vault-only — no process.env fallback.
 */
export async function resolveSecretsBlock(
  declarations: McpSecretDeclaration[],
  secrets: SecretsService,
  serverName: string,
): Promise<{ env: Record<string, string>; fixedInputs: Record<string, string> }> {
  const env: Record<string, string> = {};
  const fixedInputs: Record<string, string> = {};

  for (const decl of declarations) {
    const value = (await secrets.get(decl.key))?.trim();
    if (!value) {
      if (decl.required) {
        throw new Error(
          `MCP server '${serverName}': required secret "${decl.key}" is not set in the vault`,
        );
      }
      continue;
    }
    if (decl.inject.env) {
      env[decl.inject.env] = value;
    } else {
      // inject.fixed_input is the only other option per the discriminated union
      fixedInputs[decl.inject.fixed_input!] = value;
    }
  }

  return { env, fixedInputs };
}
```

- [ ] **Step 4: Update `loadMcpServers` to use the new path**

In the per-server loop, replace the two existing blocks (the `rawFixedInputs` block and the `connectEntry` stdio-env block) with the unified block below. The new code goes in the same position — after the transport-field validation checks and before the `connectStdio`/`connectSse` call:

```typescript
    // Resolve credentials and build the env for the subprocess.
    // New path: if the server declares a secrets: block, resolve from it and merge with
    // any non-secret env literals. Legacy path: resolve env: "" sentinels and
    // fixed_inputs: "env:VAR" references from the vault (kept for backward-compat).
    const declarations = serverEntry.transport === 'stdio' ? (serverEntry.secrets ?? []) : [];
    const resolvedFixedInputs: Record<string, string> = {};
    let connectEntry: McpServerEntry = serverEntry;

    if (declarations.length > 0) {
      let secretsResult: { env: Record<string, string>; fixedInputs: Record<string, string> };
      try {
        secretsResult = await resolveSecretsBlock(declarations, secrets, serverEntry.name);
      } catch (err) {
        logger.error(
          { err, server: serverEntry.name },
          'secrets block resolution failed — skipping this MCP server',
        );
        continue;
      }
      // Non-secret literals in env: pass through; secrets block env values overlay them.
      const literalEnv = serverEntry.transport === 'stdio' ? (serverEntry.env ?? {}) : {};
      connectEntry = { ...serverEntry, env: { ...literalEnv, ...secretsResult.env } };
      // Any old literal fixed_inputs + secrets block fixed_inputs.
      const literalFixed = 'fixed_inputs' in serverEntry ? (serverEntry.fixed_inputs ?? {}) : {};
      Object.assign(resolvedFixedInputs, literalFixed, secretsResult.fixedInputs);
      logger.info(
        { server: serverEntry.name, envKeys: Object.keys(secretsResult.env), fixedKeys: Object.keys(secretsResult.fixedInputs) },
        'MCP server secrets block resolved',
      );
    } else {
      // Legacy path: env: "" sentinels and fixed_inputs: "env:VAR" references.
      const rawFixedInputs = 'fixed_inputs' in serverEntry ? serverEntry.fixed_inputs : undefined;
      if (rawFixedInputs) {
        let resolutionFailed = false;
        for (const [key, value] of Object.entries(rawFixedInputs)) {
          try {
            resolvedFixedInputs[key] = await resolveFixedInputFromVault(
              value,
              secrets,
              `MCP server '${serverEntry.name}' fixed_inputs.${key}`,
            );
          } catch (err) {
            logger.error(
              { err, server: serverEntry.name, key },
              'fixed_inputs resolution failed — skipping this MCP server',
            );
            resolutionFailed = true;
            break;
          }
        }
        if (resolutionFailed) continue;
        logger.info(
          { server: serverEntry.name, keys: Object.keys(resolvedFixedInputs) },
          'MCP server fixed_inputs resolved',
        );
      }
      if (serverEntry.transport === 'stdio' && serverEntry.env) {
        try {
          const resolvedEnv = await resolveStdioEnvFromVault(
            serverEntry.env,
            secrets,
            serverEntry.name,
          );
          connectEntry = { ...serverEntry, env: resolvedEnv };
        } catch (err) {
          logger.error(
            { err, server: serverEntry.name },
            'env secret resolution from vault failed — skipping this MCP server',
          );
          continue;
        }
      }
    }
```

Remove the old `const rawFixedInputs = ...` block and old `let connectEntry: McpServerEntry = serverEntry; if (serverEntry.transport === 'stdio' && serverEntry.env) {` block that were previously in their place.

- [ ] **Step 5: Run all mcp-loader tests**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/skills/mcp-loader.test.ts 2>&1 | tail -30
```
Expected: all tests PASS. The six new `resolveSecretsBlock` tests should now pass.

- [ ] **Step 6: Typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run typecheck 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add src/skills/mcp-loader.ts src/skills/mcp-loader.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "feat: add resolveSecretsBlock, update loader to use secrets: block when present"
```

---

### Task 3: Migration + registry repo

Create the `mcp_server_registry` table and its Postgres-backed accessor.

**Files:**
- Create: `src/db/migrations/063_create_mcp_server_registry.sql`
- Create: `src/registry/mcp-registry-types.ts`
- Create: `src/registry/mcp-registry-repo.ts`

**Interfaces:**
- Produces: `McpDerivedState`, `McpSecretFieldStatus`, `McpRegistryRow`, `McpRegistryEntry`, `McpGuardError`, `IMcpRegistryRepo` — from `mcp-registry-types.ts`
- Produces: `McpRegistryRepo implements IMcpRegistryRepo` — from `mcp-registry-repo.ts`

- [ ] **Step 1: Create the migration**

```sql
-- src/db/migrations/063_create_mcp_server_registry.sql
-- Tracks the install/enable lifecycle for MCP servers declared in skills.yaml.
-- Mirrors channel_registry; no is_toggleable column (all MCP servers are toggleable).

CREATE TABLE mcp_server_registry (
  name          TEXT        NOT NULL PRIMARY KEY,
  enabled       BOOLEAN     NOT NULL DEFAULT false,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by  TEXT        NOT NULL,
  enabled_at    TIMESTAMPTZ,
  enabled_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Create `src/registry/mcp-registry-types.ts`**

```typescript
// src/registry/mcp-registry-types.ts
// Types for the MCP server registry. Mirrors channel-registry-types.ts.
// All MCP servers are toggleable — there is no is_toggleable column.

export type McpDerivedState = 'uninstalled' | 'installed' | 'enabled';

/** Per-secret status returned to the console. Mirrors CredentialFieldStatus. */
export interface McpSecretFieldStatus {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
}

/** A row in mcp_server_registry, mapped to camelCase. */
export interface McpRegistryRow {
  name: string;
  enabled: boolean;
  installedAt: string;
  installedBy: string;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

/** Fully-resolved API entry: config × row × credential status → state. */
export interface McpRegistryEntry {
  name: string;
  state: McpDerivedState;
  secretFields: McpSecretFieldStatus[];
  requiredResolvable: boolean;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

/** Thrown for expected guard rejections. Routes catch this to return HTTP 400. */
export class McpGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpGuardError';
  }
}

/** DB-access contract. Postgres impl is McpRegistryRepo; tests use an in-memory fake. */
export interface IMcpRegistryRepo {
  listRows(): Promise<McpRegistryRow[]>;
  getRow(name: string): Promise<McpRegistryRow | null>;
  install(name: string, actor: string): Promise<McpRegistryRow>;
  enable(name: string, actor: string): Promise<McpRegistryRow>;
  disable(name: string, actor: string): Promise<McpRegistryRow>;
  uninstall(name: string): Promise<void>;
}
```

- [ ] **Step 3: Create `src/registry/mcp-registry-repo.ts`**

```typescript
// src/registry/mcp-registry-repo.ts
// Postgres-backed mcp_server_registry access. Parameterized queries only.
import type { DbPool } from '../db/connection.js';
import type { McpRegistryRow, IMcpRegistryRepo } from './mcp-registry-types.js';

const COLS = 'name, enabled, installed_at, installed_by, enabled_at, enabled_by, updated_at';

interface DbRow {
  name: string;
  enabled: boolean;
  installed_at: string;
  installed_by: string;
  enabled_at: string | null;
  enabled_by: string | null;
  updated_at: string;
}

function mapRow(r: DbRow): McpRegistryRow {
  return {
    name: r.name,
    enabled: r.enabled,
    installedAt: r.installed_at,
    installedBy: r.installed_by,
    enabledAt: r.enabled_at,
    enabledBy: r.enabled_by,
    updatedAt: r.updated_at,
  };
}

export class McpRegistryRepo implements IMcpRegistryRepo {
  constructor(private readonly pool: DbPool) {}

  async listRows(): Promise<McpRegistryRow[]> {
    const { rows } = await this.pool.query<DbRow>(`SELECT ${COLS} FROM mcp_server_registry`);
    return rows.map(mapRow);
  }

  async getRow(name: string): Promise<McpRegistryRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT ${COLS} FROM mcp_server_registry WHERE name = $1`,
      [name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async install(name: string, actor: string): Promise<McpRegistryRow> {
    const { rows } = await this.pool.query<DbRow>(
      `INSERT INTO mcp_server_registry (name, installed_by)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING ${COLS}`,
      [name, actor],
    );
    return mapRow(rows[0]!);
  }

  async enable(name: string, actor: string): Promise<McpRegistryRow> {
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE mcp_server_registry
          SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name, actor],
    );
    if (!rows[0]) throw new Error(`enable: no mcp_server_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async disable(name: string, _actor: string): Promise<McpRegistryRow> {
    // Clears enabled_at/enabled_by on disable, same as channel_registry pattern.
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE mcp_server_registry
          SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name],
    );
    if (!rows[0]) throw new Error(`disable: no mcp_server_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async uninstall(name: string): Promise<void> {
    await this.pool.query(`DELETE FROM mcp_server_registry WHERE name = $1`, [name]);
  }
}
```

- [ ] **Step 4: Typecheck (no test runner step — types only)**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run typecheck 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add src/db/migrations/063_create_mcp_server_registry.sql src/registry/mcp-registry-types.ts src/registry/mcp-registry-repo.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "feat: add mcp_server_registry migration, types, and repo"
```

---

### Task 4: Registry service + boot-time reconcile

`McpRegistryService` drives the install/enable lifecycle and credential gating. `reconcileMcpRegistry` auto-installs and auto-enables at boot so existing running servers aren't disrupted.

**Files:**
- Create: `src/registry/mcp-registry-service.ts`
- Create: `src/registry/mcp-reconcile.ts`
- Create: `src/registry/mcp-registry-service.test.ts`

**Interfaces:**
- Consumes: `McpServerEntry` (from `mcp-config-types.ts`), `IMcpRegistryRepo`, `McpGuardError`, `McpRegistryEntry` (from `mcp-registry-types.ts`), `normalizeSecretValue` (from `channels/credential-resolver.ts`)
- Produces: `McpRegistryService` with `list()`, `install()`, `enable()`, `disable()`, `uninstall()`, `declaredSecretKeys()`, `enabledServerNames()`; `reconcileMcpRegistry()` function

- [ ] **Step 1: Write failing tests for `McpRegistryService`**

Create `src/registry/mcp-registry-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpRegistryService } from './mcp-registry-service.js';
import { McpGuardError } from './mcp-registry-types.js';
import type { IMcpRegistryRepo, McpRegistryRow } from './mcp-registry-types.js';
import type { McpStdioServerEntry } from '../skills/mcp-config-types.js';

// Fake in-memory repo
function makeRepo(rows: McpRegistryRow[] = []): IMcpRegistryRepo {
  const store = new Map(rows.map(r => [r.name, r]));
  const now = '2026-06-21T00:00:00Z';
  return {
    listRows: async () => [...store.values()],
    getRow: async (name) => store.get(name) ?? null,
    install: async (name, actor) => {
      if (!store.has(name)) {
        const row: McpRegistryRow = { name, enabled: false, installedAt: now, installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: now };
        store.set(name, row);
        return row;
      }
      return store.get(name)!;
    },
    enable: async (name, actor) => {
      const row = store.get(name);
      if (!row) throw new Error(`no row for '${name}'`);
      const updated = { ...row, enabled: true, enabledAt: now, enabledBy: actor };
      store.set(name, updated);
      return updated;
    },
    disable: async (name) => {
      const row = store.get(name);
      if (!row) throw new Error(`no row for '${name}'`);
      const updated = { ...row, enabled: false, enabledAt: null, enabledBy: null };
      store.set(name, updated);
      return updated;
    },
    uninstall: async (name) => { store.delete(name); },
  };
}

const ATPROTO: McpStdioServerEntry = {
  name: 'atproto-mcp',
  transport: 'stdio',
  command: './cmd',
  action_risk: 'medium',
  secrets: [
    { key: 'atproto_identifier', label: 'Handle', required: true, secret: false, inject: { env: 'ATPROTO_IDENTIFIER' } },
    { key: 'atproto_password',   label: 'Password', required: true, secret: true, inject: { env: 'ATPROTO_PASSWORD' } },
  ],
};

const GOOGLE: McpStdioServerEntry = {
  name: 'google-workspace',
  transport: 'stdio',
  command: 'uvx',
  action_risk: 'low',
  secrets: [
    { key: 'google_oauth_client_id', label: 'Client ID', required: true, secret: false, inject: { env: 'GOOGLE_OAUTH_CLIENT_ID' } },
  ],
};

function makeSecrets(map: Record<string, string | null>) {
  return {
    get: async (key: string) => map[key] ?? null,
    delete: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
  };
}

describe('McpRegistryService', () => {
  it('list(): shows uninstalled state for servers with no registry row', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({}));
    const entries = await svc.list();
    expect(entries[0]!.state).toBe('uninstalled');
  });

  it('list(): shows installed state for servers with row but enabled=false', async () => {
    const now = '2026-06-21T00:00:00Z';
    const repo = makeRepo([{ name: 'atproto-mcp', enabled: false, installedAt: now, installedBy: 'test', enabledAt: null, enabledBy: null, updatedAt: now }]);
    const svc = new McpRegistryService(repo, [ATPROTO], makeSecrets({}));
    const entries = await svc.list();
    expect(entries[0]!.state).toBe('installed');
  });

  it('list(): secretFields shows configured=true when vault has value', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'secret' }));
    const entries = await svc.list();
    const field = entries[0]!.secretFields.find(f => f.key === 'atproto_identifier')!;
    expect(field.configured).toBe(true);
  });

  it('list(): requiredResolvable=false when a required secret is missing', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({}));
    const entries = await svc.list();
    expect(entries[0]!.requiredResolvable).toBe(false);
  });

  it('list(): requiredResolvable=true when all required secrets are present', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'secret' }));
    const entries = await svc.list();
    expect(entries[0]!.requiredResolvable).toBe(true);
  });

  it('install(): throws McpGuardError for unknown server name', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({}));
    await expect(svc.install('nonexistent', 'actor')).rejects.toBeInstanceOf(McpGuardError);
  });

  it('enable(): throws McpGuardError when not installed', async () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'secret' }));
    await expect(svc.enable('atproto-mcp', 'actor')).rejects.toBeInstanceOf(McpGuardError);
  });

  it('enable(): throws McpGuardError when required secret is missing', async () => {
    const repo = makeRepo();
    const svc = new McpRegistryService(repo, [ATPROTO], makeSecrets({}));
    await svc.install('atproto-mcp', 'actor');
    await expect(svc.enable('atproto-mcp', 'actor')).rejects.toBeInstanceOf(McpGuardError);
  });

  it('enable(): succeeds when all required secrets resolve', async () => {
    const repo = makeRepo();
    const svc = new McpRegistryService(repo, [ATPROTO], makeSecrets({ atproto_identifier: 'me.bsky.social', atproto_password: 'pw' }));
    await svc.install('atproto-mcp', 'actor');
    const entry = await svc.enable('atproto-mcp', 'actor');
    expect(entry.state).toBe('enabled');
  });

  it('uninstall(): deletes exclusively-owned vault keys', async () => {
    const secrets = makeSecrets({});
    const repo = makeRepo();
    const svc = new McpRegistryService(repo, [ATPROTO], secrets);
    await svc.install('atproto-mcp', 'actor');
    await svc.uninstall('atproto-mcp', 'actor');
    expect(secrets.delete).toHaveBeenCalledWith('atproto_identifier');
    expect(secrets.delete).toHaveBeenCalledWith('atproto_password');
  });

  it('uninstall(): does not delete vault keys shared by another server', async () => {
    const SHARED: McpStdioServerEntry = {
      name: 'other-server', transport: 'stdio', command: './cmd', action_risk: 'low',
      secrets: [{ key: 'google_oauth_client_id', label: 'ID', required: true, secret: false, inject: { env: 'GID' } }],
    };
    const secrets = makeSecrets({});
    const svc = new McpRegistryService(makeRepo(), [GOOGLE, SHARED], secrets);
    await svc.install('google-workspace', 'actor');
    await svc.uninstall('google-workspace', 'actor');
    // google_oauth_client_id is also in SHARED → should NOT be deleted
    expect(secrets.delete).not.toHaveBeenCalledWith('google_oauth_client_id');
  });

  it('declaredSecretKeys(): returns union of all declared keys across servers', () => {
    const svc = new McpRegistryService(makeRepo(), [ATPROTO, GOOGLE], makeSecrets({}));
    const keys = svc.declaredSecretKeys();
    expect(keys).toContain('atproto_identifier');
    expect(keys).toContain('atproto_password');
    expect(keys).toContain('google_oauth_client_id');
  });

  it('enabledServerNames(): returns only names of enabled servers', async () => {
    const now = '2026-06-21T00:00:00Z';
    const repo = makeRepo([
      { name: 'atproto-mcp', enabled: true, installedAt: now, installedBy: 'test', enabledAt: now, enabledBy: 'test', updatedAt: now },
      { name: 'google-workspace', enabled: false, installedAt: now, installedBy: 'test', enabledAt: null, enabledBy: null, updatedAt: now },
    ]);
    const svc = new McpRegistryService(repo, [ATPROTO, GOOGLE], makeSecrets({}));
    const names = await svc.enabledServerNames();
    expect(names.has('atproto-mcp')).toBe(true);
    expect(names.has('google-workspace')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/registry/mcp-registry-service.test.ts 2>&1 | tail -20
```
Expected: import errors / module not found for `mcp-registry-service.ts`.

- [ ] **Step 3: Create `src/registry/mcp-registry-service.ts`**

```typescript
// src/registry/mcp-registry-service.ts
// Drives the MCP server install/enable lifecycle, mirroring ChannelRegistryService.
// All MCP servers are toggleable; there is no non-toggleable equivalent.
import { normalizeSecretValue } from '../channels/credential-resolver.js';
import type { McpServerEntry } from '../skills/mcp-config-types.js';
import {
  McpGuardError,
  type McpRegistryEntry,
  type McpRegistryRow,
  type McpSecretFieldStatus,
  type IMcpRegistryRepo,
} from './mcp-registry-types.js';

type SecretStore = {
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
};

export class McpRegistryService {
  constructor(
    private readonly repo: IMcpRegistryRepo,
    private readonly servers: McpServerEntry[],
    private readonly secrets: SecretStore,
  ) {}

  private descriptor(name: string): McpServerEntry {
    const d = this.servers.find(s => s.name === name);
    if (!d) throw new McpGuardError(`Unknown MCP server '${name}'.`);
    return d;
  }

  private async secretStatus(server: McpServerEntry): Promise<{ fields: McpSecretFieldStatus[]; requiredResolvable: boolean }> {
    const decls = server.transport === 'stdio' ? (server.secrets ?? []) : [];
    const fields: McpSecretFieldStatus[] = [];
    let requiredResolvable = true;

    for (const decl of decls) {
      let configured = false;
      try {
        const raw = await this.secrets.get(decl.key);
        configured = !!normalizeSecretValue(raw);
      } catch {
        // Vault read failure → treat as unconfigured; don't crash the list endpoint.
        configured = false;
      }
      if (decl.required && !configured) requiredResolvable = false;
      fields.push({ key: decl.key, label: decl.label, secret: decl.secret, configured });
    }

    return { fields, requiredResolvable };
  }

  async list(): Promise<McpRegistryEntry[]> {
    const rows = await this.repo.listRows();
    const rowByName = new Map(rows.map(r => [r.name, r]));
    const entries: McpRegistryEntry[] = [];

    for (const server of this.servers) {
      const row = rowByName.get(server.name);
      const { fields, requiredResolvable } = await this.secretStatus(server);
      entries.push({
        name: server.name,
        state: !row ? 'uninstalled' : row.enabled ? 'enabled' : 'installed',
        secretFields: fields,
        requiredResolvable,
        installedAt: row?.installedAt ?? null,
        installedBy: row?.installedBy ?? null,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ?? null,
      });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async install(name: string, actor: string): Promise<McpRegistryEntry> {
    this.descriptor(name); // throws McpGuardError if unknown
    await this.repo.install(name, actor);
    return this.entry(name);
  }

  async enable(name: string, actor: string): Promise<McpRegistryEntry> {
    const server = this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new McpGuardError(`Cannot enable '${name}': not installed. Install it first.`);
    const { requiredResolvable } = await this.secretStatus(server);
    if (!requiredResolvable) {
      throw new McpGuardError(`Cannot enable '${name}': required credentials are not configured.`);
    }
    await this.repo.enable(name, actor);
    return this.entry(name);
  }

  async disable(name: string, actor: string): Promise<McpRegistryEntry> {
    this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new McpGuardError(`Cannot disable '${name}': no registry row.`);
    await this.repo.disable(name, actor);
    return this.entry(name);
  }

  async uninstall(name: string, _actor: string): Promise<void> {
    const server = this.descriptor(name);
    // Delete only vault keys exclusively owned by this server — flat keys may be
    // shared by other servers or local skills, and deleting them would break those.
    const ownKeys = new Set(
      server.transport === 'stdio' ? (server.secrets ?? []).map(d => d.key) : [],
    );
    for (const other of this.servers) {
      if (other.name === name) continue;
      for (const d of other.transport === 'stdio' ? (other.secrets ?? []) : []) {
        ownKeys.delete(d.key);
      }
    }
    for (const key of ownKeys) {
      await this.secrets.delete(key);
    }
    await this.repo.uninstall(name);
  }

  /** All vault keys declared across all configured servers. Used by vault.ts allowlist. */
  declaredSecretKeys(): string[] {
    const keys = new Set<string>();
    for (const server of this.servers) {
      for (const d of server.transport === 'stdio' ? (server.secrets ?? []) : []) {
        keys.add(d.key);
      }
    }
    return [...keys];
  }

  /** Names of currently enabled servers. Used by loadMcpServers to filter at boot. */
  async enabledServerNames(): Promise<Set<string>> {
    const rows = await this.repo.listRows();
    return new Set(rows.filter(r => r.enabled).map(r => r.name));
  }

  private async entry(name: string): Promise<McpRegistryEntry> {
    const server = this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new Error(`entry: '${name}' missing registry row after mutation`);
    const { fields, requiredResolvable } = await this.secretStatus(server);
    return {
      name: server.name,
      state: row.enabled ? 'enabled' : 'installed',
      secretFields: fields,
      requiredResolvable,
      installedAt: row.installedAt,
      installedBy: row.installedBy,
      enabledAt: row.enabledAt,
      enabledBy: row.enabledBy,
    };
  }
}
```

- [ ] **Step 4: Create `src/registry/mcp-reconcile.ts`**

```typescript
// src/registry/mcp-reconcile.ts
// Boot-time reconciliation for the MCP server registry. Mirrors channel-reconcile.ts.
// Auto-installs every configured server; auto-enables those whose required secrets resolve.
// Existing admin state is never overwritten — if an operator disabled a server, it stays
// disabled after a restart.
import type { Logger } from '../logger.js';
import type { McpServerEntry } from '../skills/mcp-config-types.js';
import type { McpRegistryService } from './mcp-registry-service.js';
import { McpGuardError } from './mcp-registry-types.js';

export interface ReconcileMcpDeps {
  service: McpRegistryService;
  servers: McpServerEntry[];
  logger: Logger;
}

export async function reconcileMcpRegistry(deps: ReconcileMcpDeps): Promise<void> {
  const { service, servers, logger } = deps;
  const existing = new Map(
    (await service.list()).map(e => [e.name, e]),
  );

  for (const server of servers) {
    const entry = existing.get(server.name);

    // If already in the registry (any state), leave admin state alone.
    if (entry && entry.state !== 'uninstalled') continue;

    // First time seeing this server: install it.
    await service.install(server.name, 'reconciliation');
    logger.info({ server: server.name }, 'mcp registry: enrolled new server');

    // Attempt to auto-enable if all required secrets already resolve.
    try {
      await service.enable(server.name, 'reconciliation');
      logger.info({ server: server.name }, 'mcp registry: auto-enabled server with resolvable credentials');
    } catch (err) {
      if (err instanceof McpGuardError) {
        // Required credentials not yet configured — stays installed but not enabled.
        logger.info({ server: server.name }, 'mcp registry: server installed but not auto-enabled (credentials not yet configured)');
      } else {
        throw err;
      }
    }
  }
}
```

- [ ] **Step 5: Run service tests**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/registry/mcp-registry-service.test.ts 2>&1 | tail -30
```
Expected: all 12 tests PASS.

- [ ] **Step 6: Typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run typecheck 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add src/registry/mcp-registry-service.ts src/registry/mcp-registry-service.test.ts src/registry/mcp-reconcile.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "feat: add McpRegistryService, reconcileMcpRegistry"
```

---

### Task 5: Vault allowlist + MCP registry API routes

Extend `vault.ts` to accept declared MCP keys. Add the five `GET/POST/DELETE /api/registry/mcp/*` routes mirroring `channel-registry.ts`.

**Files:**
- Modify: `src/channels/http/routes/vault.ts`
- Create: `src/channels/http/routes/mcp-registry.ts`
- Create: `src/channels/http/routes/mcp-registry.test.ts`

**Interfaces:**
- Consumes: `McpRegistryService` (from `mcp-registry-service.ts`), `McpGuardError` (from `mcp-registry-types.ts`)
- Produces: routes `GET /api/registry/mcp`, `POST /api/registry/mcp/:name/install`, `POST /api/registry/mcp/:name/enable`, `POST /api/registry/mcp/:name/disable`, `DELETE /api/registry/mcp/:name`; updated vault route that accepts declared MCP keys

- [ ] **Step 1: Update `vault.ts` — extend allowlist with MCP declared keys**

In `VaultRouteOptions`, add an optional `mcpRegistryService` field:

```typescript
import type { McpRegistryService } from '../../../registry/mcp-registry-service.js';

export interface VaultRouteOptions {
  secretsService: VaultSecretsPort;
  registryService: RegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  /** Optional: when present, declared MCP secret keys are added to the write allowlist. */
  mcpRegistryService?: McpRegistryService;
}
```

In the `PUT /api/vault/secrets/:name` handler, update the scope guard (around line 109):

```typescript
    const isSkillDeclared = registryService.declaredSecretNames().includes(name);
    const isMcpDeclared = options.mcpRegistryService?.declaredSecretKeys().includes(name) ?? false;
    if (!isSkillDeclared && !isChannelCredentialKey(name) && !isMcpDeclared) {
      request.log.info({ name }, 'vault set rejected: name not declared by any skill, MCP server, or channel');
      return reply.status(400).send({
        error: `'${name}' is not a required secret declared by any skill or MCP server, ` +
          `nor a known channel credential. Only declared secrets can be set here.`,
      });
    }
```

- [ ] **Step 2: Create `src/channels/http/routes/mcp-registry.ts`**

```typescript
// src/channels/http/routes/mcp-registry.ts — HTTP routes for the MCP server registry UI.
// Session-cookie or x-web-bootstrap-secret auth, same pattern as channel-registry.ts.
//
//   GET    /api/registry/mcp                  — list all declared servers with derived state
//   POST   /api/registry/mcp/:name/install
//   POST   /api/registry/mcp/:name/enable     — gated on requiredResolvable
//   POST   /api/registry/mcp/:name/disable
//   DELETE /api/registry/mcp/:name            — uninstall; cascade-deletes exclusive vault keys

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpRegistryService } from '../../../registry/mcp-registry-service.js';
import { McpGuardError } from '../../../registry/mcp-registry-types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface McpRegistryRouteOptions {
  mcpRegistryService: McpRegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

const ACTOR = 'web-console';

export async function mcpRegistryRoutes(
  app: FastifyInstance,
  options: McpRegistryRouteOptions,
): Promise<void> {
  const { mcpRegistryService: svc, webAppBootstrapSecret, sessions } = options;
  const AUTH_RATE = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  app.get('/api/registry/mcp', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ servers: await svc.list() });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/mcp failed');
      return reply.status(500).send({ error: 'Failed to list MCP servers. Check server logs.' });
    }
  });

  const action = (op: 'install' | 'enable' | 'disable' | 'uninstall') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!requireAuth(request, reply)) return;
      const { name } = request.params as { name: string };
      try {
        if (op === 'uninstall') {
          await svc.uninstall(name, ACTOR);
          return reply.send({ ok: true });
        }
        const entry =
          op === 'install' ? await svc.install(name, ACTOR)
          : op === 'enable' ? await svc.enable(name, ACTOR)
          : await svc.disable(name, ACTOR);
        return reply.send({ entry });
      } catch (err) {
        if (err instanceof McpGuardError) {
          request.log.info({ err, name, op }, `MCP server ${op} rejected: guard`);
          return reply.status(400).send({ error: err.message });
        }
        request.log.error({ err, name, op }, `MCP server ${op} failed unexpectedly`);
        return reply.status(500).send({ error: 'Operation failed. Check server logs.' });
      }
    };

  app.post('/api/registry/mcp/:name/install', AUTH_RATE, action('install'));
  app.post('/api/registry/mcp/:name/enable',  AUTH_RATE, action('enable'));
  app.post('/api/registry/mcp/:name/disable', AUTH_RATE, action('disable'));
  app.delete('/api/registry/mcp/:name',       AUTH_RATE, action('uninstall'));
}
```

- [ ] **Step 3: Write tests for the MCP registry routes**

Create `src/channels/http/routes/mcp-registry.test.ts`. Look at `channel-registry.test.ts` for the test harness pattern (it uses `buildTestApp` or similar). Mirror it exactly:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { mcpRegistryRoutes } from './mcp-registry.js';
import { McpGuardError } from '../../../registry/mcp-registry-types.js';

function makeSvc() {
  return {
    list: vi.fn().mockResolvedValue([]),
    install: vi.fn().mockResolvedValue({ name: 'atproto-mcp', state: 'installed', secretFields: [], requiredResolvable: false, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null }),
    enable: vi.fn().mockResolvedValue({ name: 'atproto-mcp', state: 'enabled', secretFields: [], requiredResolvable: true, installedAt: 'now', installedBy: 'actor', enabledAt: 'now', enabledBy: 'actor' }),
    disable: vi.fn().mockResolvedValue({ name: 'atproto-mcp', state: 'installed', secretFields: [], requiredResolvable: false, installedAt: 'now', installedBy: 'actor', enabledAt: null, enabledBy: null }),
    uninstall: vi.fn().mockResolvedValue(undefined),
    declaredSecretKeys: vi.fn().mockReturnValue([]),
    enabledServerNames: vi.fn().mockResolvedValue(new Set()),
  };
}

async function buildApp(svc = makeSvc()) {
  const app = Fastify({ logger: false });
  await app.register(mcpRegistryRoutes, {
    mcpRegistryService: svc as never,
    webAppBootstrapSecret: 'test-secret',
    sessions: { get: () => null, set: () => {}, delete: () => {} } as never,
  });
  return { app, svc };
}

const AUTH = { 'x-web-bootstrap-secret': 'test-secret' };

describe('GET /api/registry/mcp', () => {
  it('returns 200 with servers list', async () => {
    const { app, svc } = await buildApp();
    svc.list.mockResolvedValue([{ name: 'atproto-mcp', state: 'uninstalled', secretFields: [], requiredResolvable: false, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null }]);
    const res = await app.inject({ method: 'GET', url: '/api/registry/mcp', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ servers: expect.arrayContaining([expect.objectContaining({ name: 'atproto-mcp' })]) });
  });

  it('returns 401 without auth', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/registry/mcp' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/registry/mcp/:name/enable', () => {
  it('returns 400 with McpGuardError message', async () => {
    const { app, svc } = await buildApp();
    svc.enable.mockRejectedValue(new McpGuardError('Cannot enable: not installed.'));
    const res = await app.inject({ method: 'POST', url: '/api/registry/mcp/atproto-mcp/enable', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Cannot enable');
  });

  it('returns 200 on success', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/registry/mcp/atproto-mcp/enable', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().entry.state).toBe('enabled');
  });
});

describe('DELETE /api/registry/mcp/:name', () => {
  it('returns 200 on successful uninstall', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/registry/mcp/atproto-mcp', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/channels/http/routes/mcp-registry.test.ts 2>&1 | tail -20
```
Expected: all tests PASS.

- [ ] **Step 5: Run vault tests to confirm the allowlist change doesn't break anything**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test src/channels/http/routes/vault.test.ts 2>&1 | tail -20
```
Expected: all existing tests PASS (the new `mcpRegistryService` field is optional).

- [ ] **Step 6: Typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run typecheck 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add src/channels/http/routes/vault.ts src/channels/http/routes/mcp-registry.ts src/channels/http/routes/mcp-registry.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "feat: add MCP registry API routes, extend vault allowlist for MCP keys"
```

---

### Task 6: Bootstrap wiring — http-adapter, index.ts, loadMcpServers filter

Wire the registry service into the HTTP adapter. In `index.ts`, instantiate `McpRegistryRepo` + `McpRegistryService`, run `reconcileMcpRegistry`, and pass the enabled set to `loadMcpServers`. Add the `enabledServerNames` filter to `loadMcpServers`.

**Files:**
- Modify: `src/channels/http/http-adapter.ts` (add `mcpRegistryService?` to config, mount routes)
- Modify: `src/index.ts` (instantiate, reconcile, wire)
- Modify: `src/skills/mcp-loader.ts` (add `enabledServerNames?` param to `loadMcpServers`)
- Modify: `tests/unit/skills/mcp-loader.test.ts` (add `enabledServerNames` arg to all existing `loadMcpServers` calls that need it; they can pass `undefined`)

**Interfaces:**
- Consumes: `McpRegistryRepo`, `McpRegistryService`, `reconcileMcpRegistry`, `loadSkillsConfig`, `mcpRegistryRoutes`, `McpRegistryService.enabledServerNames()`
- Produces: updated `loadMcpServers(configDir, registry, logger, secrets, enabledServerNames?)` signature; updated `HttpAdapterConfig` with `mcpRegistryService?`

- [ ] **Step 1: Add `enabledServerNames` filter param to `loadMcpServers`**

In `src/skills/mcp-loader.ts`, update the function signature:

```typescript
export async function loadMcpServers(
  configDir: string,
  registry: SkillRegistry,
  logger: Logger,
  secrets: SecretsService,
  /** When provided, only servers whose name is in this set are spawned.
   *  Servers absent from the set are skipped with a debug log (not an error).
   *  Pass undefined to skip the filter (legacy / test behavior). */
  enabledServerNames?: Set<string>,
): Promise<McpSession[]>
```

At the top of the per-server loop, add the filter check (after the transport-field validation checks):

```typescript
    // Registry filter: skip servers not in the enabled set.
    if (enabledServerNames !== undefined && !enabledServerNames.has(serverEntry.name)) {
      logger.debug(
        { server: serverEntry.name },
        'MCP server not in enabled registry set — skipping',
      );
      continue;
    }
```

- [ ] **Step 2: Update `tests/unit/skills/mcp-loader.test.ts` — add `enabledServerNames` arg if needed**

Open `tests/unit/skills/mcp-loader.test.ts` and check every `loadMcpServers(...)` call. The new parameter is optional, so no changes are strictly required — but verify the tests still pass as-is.

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test tests/unit/skills/mcp-loader.test.ts 2>&1 | tail -20
```
Expected: all existing tests PASS.

- [ ] **Step 3: Add `mcpRegistryService?` to `HttpAdapterConfig` and mount routes**

In `src/channels/http/http-adapter.ts`, add to the config interface (near `channelRegistryService?`):

```typescript
  /** Backs the /api/registry/mcp/* routes (MCP server install/enable lifecycle).
   *  Mounted only when webAppBootstrapSecret is also configured. */
  mcpRegistryService?: import('../../registry/mcp-registry-service.js').McpRegistryService;
```

In the `start()` method, after the `channelRegistryRoutes` block (around line 377), add:

```typescript
    if (webAppBootstrapSecret && this.config.mcpRegistryService) {
      await this.app.register(mcpRegistryRoutes, {
        mcpRegistryService: this.config.mcpRegistryService,
        webAppBootstrapSecret,
        sessions,
      });
    }
```

Add the import at the top of the file:

```typescript
import { mcpRegistryRoutes } from './routes/mcp-registry.js';
```

Also extend the `vaultRoutes` registration to pass `mcpRegistryService` (around line 359):

```typescript
      if (this.config.secretsService) {
        await this.app.register(vaultRoutes, {
          secretsService: this.config.secretsService,
          registryService: this.config.registryService,
          mcpRegistryService: this.config.mcpRegistryService,
          webAppBootstrapSecret,
          sessions,
        });
      }
```

- [ ] **Step 4: Wire `McpRegistryRepo`, `McpRegistryService`, and `reconcileMcpRegistry` in `src/index.ts`**

Add imports near the channel registry imports (around line 131–133):

```typescript
import { McpRegistryRepo } from './registry/mcp-registry-repo.js';
import { McpRegistryService } from './registry/mcp-registry-service.js';
import { reconcileMcpRegistry } from './registry/mcp-reconcile.js';
```

After the `channelRegistryService` block (around line 1354), add:

```typescript
  // ── MCP server registry ────────────────────────────────────────────────────
  // Auto-installs all declared servers; auto-enables those whose required secrets resolve.
  // Drives the /api/registry/mcp/* routes and gates which servers loadMcpServers spawns.
  const mcpRegistryRepo = new McpRegistryRepo(pool);
  const mcpConfig = loadSkillsConfig(configDir);
  const mcpRegistryService = new McpRegistryService(mcpRegistryRepo, mcpConfig.servers ?? [], secretsService);

  try {
    await reconcileMcpRegistry({ service: mcpRegistryService, servers: mcpConfig.servers ?? [], logger });
  } catch (err) {
    logger.fatal({ err }, 'MCP server registry reconciliation failed');
    process.exit(1);
  }

  const enabledMcpServers = await mcpRegistryService.enabledServerNames();
  // ───────────────────────────────────────────────────────────────────────────
```

Add `loadSkillsConfig` to the mcp-loader import at the top of `index.ts`:

```typescript
import { loadMcpServers, loadSkillsConfig } from './skills/mcp-loader.js';
```

Update the `loadMcpServers` call (search for `loadMcpServers(configDir`) to pass the enabled set:

```typescript
  mcpSessions = await loadMcpServers(configDir, skillRegistry, logger, secretsService, enabledMcpServers);
```

Update the `HttpAdapter` instantiation to pass `mcpRegistryService`:

```typescript
    mcpRegistryService,
```
(Add it alongside `channelRegistryService` in the `HttpAdapter` config object.)

- [ ] **Step 5: Typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run typecheck 2>&1 | tail -20
```
Expected: no errors. Fix any type errors before committing.

- [ ] **Step 6: Run full test suite to catch regressions**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test 2>&1 | tail -30
```
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add src/skills/mcp-loader.ts src/channels/http/http-adapter.ts src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "feat: wire McpRegistryService into bootstrap and HTTP adapter"
```

---

### Task 7: Config YAML updates + CHANGELOG

Migrate `config/skills.yaml` (google-workspace) and `curia-deploy/custom/config/skills.yaml` (atproto-mcp + google-workspace mirror) to use the new `secrets:` block, removing old `env:""` sentinels and `fixed_inputs:"env:VAR"` wiring.

**Files:**
- Modify: `config/skills.yaml` (in the curia worktree)
- Modify: `repos/curia-deploy/custom/config/skills.yaml` (in the curia-deploy repo — separate git repo)
- Modify: `CHANGELOG.md` (in the curia worktree)

- [ ] **Step 1: Update `config/skills.yaml` — google-workspace `secrets:` block**

Replace the `google-workspace` entry. The `env:` block keeps only the non-secret `ALLOWED_FILE_DIRS` literal. The three vault-backed values move to `secrets:`.

The new entry:

```yaml
  - name: google-workspace
    transport: stdio
    command: uvx
    args:
      - workspace-mcp
      - --tool-tier
      - complete
    secrets:
      - key: google_oauth_client_id
        label: "Google OAuth client ID"
        required: true
        secret: false
        inject:
          env: GOOGLE_OAUTH_CLIENT_ID
      - key: google_oauth_client_secret
        label: "Google OAuth client secret"
        required: true
        secret: true
        inject:
          env: GOOGLE_OAUTH_CLIENT_SECRET
      - key: curia_google_email
        label: "Curia Google account email"
        required: true
        secret: false
        inject:
          fixed_input: user_google_email
    env:
      # Allow the workspace-mcp subprocess to read files from the TempFileStore
      # directory. Without this, create_drive_file rejects file:// URLs pointing
      # to /run/curia-tempfiles/ because validate_file_path only allows reads
      # from its own STORAGE_DIR by default.
      ALLOWED_FILE_DIRS: "/run/curia-tempfiles"
    action_risk: low
    sensitivity: normal
    timeout_ms: 60000
```

Update the comment block above the entry to describe the new `secrets:` block pattern (remove the old `env: ""` / `fixed_inputs` references from the comment).

- [ ] **Step 2: Update `repos/curia-deploy/custom/config/skills.yaml` — both servers**

This file is in a separate git repo. Read it first, then apply both changes.

For `google-workspace`: apply the same `secrets:` block as Step 1 (this file is a full override of core's `skills.yaml`). Also update the header comment block for the google-workspace entry to match.

For `atproto-mcp`: replace the `env: ""` sentinels with a `secrets:` block:

```yaml
  - name: atproto-mcp
    transport: stdio
    command: ./node_modules/.bin/atproto-mcp
    secrets:
      - key: atproto_identifier
        label: "Bluesky handle (e.g. you.bsky.social)"
        required: true
        secret: false
        inject:
          env: ATPROTO_IDENTIFIER
      - key: atproto_password
        label: "Bluesky app password (revocable; never the account password)"
        required: true
        secret: true
        inject:
          env: ATPROTO_PASSWORD
    action_risk: medium
    sensitivity: normal
    timeout_ms: 30000
```

- [ ] **Step 3: Update CHANGELOG.md — add entry under `## [Unreleased]`**

```markdown
### Added
- **MCP skill credentials** — MCP servers declare required secrets in `skills.yaml` via a `secrets:` block; the web console presents credential fields (masked or plain), writes to the encrypted vault, and gates enable/disable on whether required secrets resolve. Mirrors the Channels registry pattern. New `mcp_server_registry` table, `McpRegistryService`, `reconcileMcpRegistry`, and `/api/registry/mcp/*` routes. `loadMcpServers` now filters to enabled servers only. (#1100 or the PR number for this branch)
```

- [ ] **Step 4: Commit config changes in the curia worktree**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add config/skills.yaml CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "chore: migrate google-workspace to secrets: block, update CHANGELOG"
```

- [ ] **Step 5: Commit config change in curia-deploy**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy add custom/config/skills.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-deploy commit -m "chore: migrate google-workspace and atproto-mcp to secrets: block"
```

---

### Task 8: Frontend — MCP Skills page

Add an "MCP Skills" section to the console that lists declared servers, shows credential fields, and drives the install/enable lifecycle — reusing the channel components verbatim where possible.

**Files:**
- Create: `apps/console/src/pages/McpSkillsPage.tsx`
- Modify: `apps/console/src/router.tsx` (add `/mcp-skills` route)
- Modify: `apps/console/src/components/Sidebar.tsx` (add "MCP Skills" nav item)

**Interfaces:**
- Consumes: `GET /api/registry/mcp` → `{ servers: McpEntry[] }`, `POST /api/registry/mcp/:name/{install,enable,disable}`, `DELETE /api/registry/mcp/:name`, `PUT /api/vault/secrets/:key`
- Produces: `McpSkillsPage` (default export from `McpSkillsPage.tsx`)

- [ ] **Step 1: Create `apps/console/src/pages/McpSkillsPage.tsx`**

This page is structurally identical to `ChannelSettings.tsx`. Copy the structure, replace:
- API endpoint `channels` → `mcp`
- Type name `ChannelEntry` → `McpEntry`
- Vault key format: `channel.${channel}.${field.key}` → `${field.key}` (flat key, no namespacing)
- `isToggleable` field: all MCP servers are toggleable, so drop the "always on" branch
- `credentialFields` → `secretFields`
- Sidebar `activeView`: `'channels'` → `'mcp-skills'`
- Topbar title: `'Channels'` → `'MCP Skills'`

```typescript
import { useState, useEffect, useCallback, useMemo } from 'react';
import { MobileMenuContext } from '../context/MobileMenu.js';
import { Sidebar } from '../components/Sidebar.js';
import { Topbar } from '../components/Topbar.js';
import { apiFetch } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

type McpState = 'uninstalled' | 'installed' | 'enabled';

interface McpSecretField {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
}

interface McpEntry {
  name: string;
  state: McpState;
  secretFields: McpSecretField[];
  requiredResolvable: boolean;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

const STATE_PILL: Record<McpState, string> = {
  enabled:     'confirmed',
  installed:   'provisional',
  uninstalled: '',
};

const STATE_LABEL: Record<McpState, string> = {
  uninstalled: 'not installed',
  installed:   'installed',
  enabled:     'enabled',
};

async function errorMessage(res: Response): Promise<string> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      const d = await res.json() as { error?: string };
      if (d.error) return d.error;
    } catch (err) {
      console.error('[errorMessage] failed to parse JSON error body:', err);
    }
  }
  return `HTTP ${res.status}`;
}

// Credential row — identical to ChannelSettings.CredentialRow but uses the flat vault key directly.
function SecretRow({ field, onSaved }: { field: McpSecretField; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      // MCP secrets are stored under the flat vault key (no channel.* namespace).
      const res = await apiFetch(`/api/vault/secrets/${encodeURIComponent(field.key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setValue('');
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save credential');
    } finally {
      setBusy(false);
    }
  }, [field.key, value, onSaved]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`status-pill ${field.configured ? 'confirmed' : 'blocked'}`}>
          {field.configured ? 'configured' : 'missing'}
        </span>
        <code style={{ fontSize: 13 }}>{field.label}</code>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type={field.secret ? 'password' : 'text'}
          autoComplete="off"
          value={value}
          placeholder={field.configured ? 'Enter a new value to replace' : `Enter ${field.label}`}
          aria-label={`Value for ${field.label}`}
          onChange={e => setValue(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || value.length === 0}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      {err && <p className="autonomy-error" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}

function McpDrawer({ entry, onClose, onChanged }: { entry: McpEntry; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = useCallback(async (method: 'POST' | 'DELETE', suffix: string) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch(
        `/api/registry/mcp/${encodeURIComponent(entry.name)}${suffix}`,
        { method },
      );
      if (!res.ok) throw new Error(await errorMessage(res));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [entry.name, onChanged]);

  const confirmUninstall = () => {
    if (window.confirm(`Uninstall "${entry.name}"? This clears its exclusively-owned vault secrets and removes its registry row.`)) {
      void act('DELETE', '');
    }
  };

  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div className="drawer-header-top">
          <span>mcp server</span>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
        <h2 className="drawer-title-h2">{entry.name}</h2>
      </div>

      <div className="drawer-body">
        <div className="edit-drawer-form">
          <p className="settings-page-sub" style={{ margin: 0 }}>
            Enable/disable changes take effect on the next restart.
          </p>
          {err && <p className="autonomy-error">{err}</p>}

          <div className="form-field">
            <label>State</label>
            <span className={`status-pill ${STATE_PILL[entry.state]}`}>{STATE_LABEL[entry.state]}</span>
          </div>

          {entry.secretFields.length > 0 && (
            <div className="form-field">
              <label>Credentials</label>
              <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
                Saved credentials take effect on the next restart.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {entry.secretFields.map(field => (
                  <SecretRow key={field.key} field={field} onSaved={onChanged} />
                ))}
              </div>
            </div>
          )}

          <div className="form-field">
            <label>Installed</label>
            <div>{entry.installedAt ? `${entry.installedAt} by ${entry.installedBy}` : '—'}</div>
          </div>
          <div className="form-field">
            <label>Enabled</label>
            <div>{entry.enabledAt ? `${entry.enabledAt} by ${entry.enabledBy}` : '—'}</div>
          </div>
        </div>
      </div>

      <div className="drawer-footer">
        {entry.state === 'uninstalled' && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => void act('POST', '/install')}>Install</button>
        )}
        {entry.state === 'installed' && (
          <button type="button" className="btn btn-primary btn-sm"
            disabled={busy || !entry.requiredResolvable}
            title={entry.requiredResolvable ? undefined : 'Configure the required credentials first'}
            onClick={() => void act('POST', '/enable')}>Enable</button>
        )}
        {entry.state === 'enabled' && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => void act('POST', '/disable')}>Disable</button>
        )}
        {entry.state !== 'uninstalled' && (
          <button type="button" className="btn btn-danger btn-sm" disabled={busy}
            onClick={confirmUninstall}>Uninstall</button>
        )}
      </div>
    </aside>
  );
}

type McpSortKey = 'name' | 'state';

function serverSortValue(e: McpEntry, key: McpSortKey): string {
  return key === 'name' ? e.name : e.state;
}

export default function McpSkillsPage() {
  const [theme, setTheme] = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [entries, setEntries] = useState<McpEntry[]>([]);
  const [selected, setSelected] = useState<McpEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: McpSortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [stateFilter, setStateFilter] = useState<'all' | McpState>('all');

  useEffect(() => {
    document.documentElement.dataset['mobileSidebar'] = mobileOpen ? 'open' : '';
  }, [mobileOpen]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/registry/mcp');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { servers: McpEntry[] };
      const list = data.servers ?? [];
      setEntries(list);
      setLoadError(null);
      setSelected(prev => prev ? list.find(e => e.name === prev.name) ?? null : null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    all:         entries.length,
    enabled:     entries.filter(e => e.state === 'enabled').length,
    installed:   entries.filter(e => e.state === 'installed').length,
    uninstalled: entries.filter(e => e.state === 'uninstalled').length,
  }), [entries]);

  const filtered = useMemo(() => {
    const rows = stateFilter === 'all' ? entries : entries.filter(e => e.state === stateFilter);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = serverSortValue(a, sort.key);
      const bv = serverSortValue(b, sort.key);
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
  }, [entries, stateFilter, sort]);

  function toggleSort(key: McpSortKey) {
    setSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  }
  const sortArrow = (key: McpSortKey) => sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '';

  return (
    <MobileMenuContext.Provider value={{ open: mobileOpen, setOpen: setMobileOpen }}>
      <div className="app-root">
        <Sidebar activeView="mcp-skills" theme={theme} onThemeChange={setTheme} />
        {mobileOpen && (
          <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
        )}
        <main className="main">
          <Topbar crumb="Settings" title="MCP Skills" />
          {loadError ? (
            <div style={{ padding: 32, color: 'var(--app-destructive)', fontSize: 13 }}>{loadError}</div>
          ) : (
            <>
              <div className="records-toolbar">
                <div className="records-toolbar-left">
                  {(['all', 'enabled', 'installed', 'uninstalled'] as const).map(v => (
                    <button key={v} className={`records-filter-chip${stateFilter === v ? ' active' : ''}`}
                      onClick={() => setStateFilter(v)}>
                      {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>
                        {counts[v as keyof typeof counts]}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="records-toolbar-right">
                  <span className="topbar-meta">{filtered.length} of {entries.length}</span>
                </div>
              </div>
              <div className="records-layout">
                <div className="records-main">
                  <div className="records-table-wrap">
                    <table className="records-table">
                      <thead>
                        <tr>
                          <th className="sortable" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('name')}>
                              Name <span className="sort-arrow">{sortArrow('name')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'state' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('state')}>
                              State <span className="sort-arrow">{sortArrow('state')}</span>
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map(e => (
                          <tr key={e.name} className={selected?.name === e.name ? 'active' : undefined}
                            onClick={() => setSelected(e)} style={{ cursor: 'pointer' }}>
                            <td>{e.name}</td>
                            <td><span className={`status-pill ${STATE_PILL[e.state]}`}>{STATE_LABEL[e.state]}</span></td>
                          </tr>
                        ))}
                        {filtered.length === 0 && (
                          <tr>
                            <td colSpan={2} style={{ textAlign: 'center', padding: 40, color: 'var(--app-fg-muted)' }}>
                              No MCP servers configured.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                {selected && (
                  <McpDrawer key={selected.name} entry={selected} onClose={() => setSelected(null)} onChanged={() => { void load(); }} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </MobileMenuContext.Provider>
  );
}
```

- [ ] **Step 2: Add `/mcp-skills` route in `apps/console/src/router.tsx`**

Add the lazy import alongside the other lazy imports:

```typescript
const McpSkillsPage = lazy(() => import('./pages/McpSkillsPage'));
```

Add the route definition alongside `channelsRoute`:

```typescript
const mcpSkillsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/mcp-skills',
  component: McpSkillsPage,
});
```

Add it to `routeTree`:

```typescript
  authedRoute.addChildren([
    dashboardRoute,
    chatRoute,
    setupRoute,
    contactsRoute,
    jobsRoute,
    tasksRoute,
    skillsRoute,
    agentsRoute,
    channelsRoute,
    mcpSkillsRoute,   // ← add here
    kgRoute,
    settingsRoute.addChildren([autonomyRoute, workspaceRoute, skillsSettingsRedirect, agentsSettingsRedirect]),
  ]),
```

- [ ] **Step 3: Add "MCP Skills" nav item in `apps/console/src/components/Sidebar.tsx`**

In `Sidebar.tsx`, the `ROUTES` map (or equivalent) lists path strings. Find the `channels` entry and add `'mcp-skills'` immediately after it:

```typescript
  'mcp-skills': '/mcp-skills',
```

In the nav item rendering block (near where `channels` nav sub-item is rendered), add:

```typescript
              <button
                className={`nav-sub-item${activeView === 'mcp-skills' ? ' active' : ''}`}
                onClick={() => go('mcp-skills')}
              >
                MCP Skills
              </button>
```

Also update the `isSettingsGroup` check to include `'mcp-skills'`:

```typescript
    activeView === 'settings' || activeView === 'skills' || activeView === 'agents' || activeView === 'channels' || activeView === 'mcp-skills',
```

And update the `activeView` type if it's explicitly typed in Sidebar.tsx (add `'mcp-skills'` to the union).

- [ ] **Step 4: Typecheck the console app**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run typecheck 2>&1 | tail -20
```
Expected: no errors.

- [ ] **Step 5: Run the full test suite one final time**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds run test 2>&1 | tail -30
```
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds add apps/console/src/pages/McpSkillsPage.tsx apps/console/src/router.tsx apps/console/src/components/Sidebar.tsx
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds commit -m "feat: add MCP Skills console page with credential form and lifecycle actions"
```

---

## Pre-PR checklist

Before creating the PR, run the parallel auto-review agents per `CLAUDE.md`:

- [ ] Run `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` in parallel against the branch
- [ ] Address any HIGH priority findings
- [ ] Verify migration prefix uniqueness: `git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-mcp-skill-creds ls-files src/db/migrations/ | sort`
- [ ] Create PR with `Closes #<issue-number>` in body
- [ ] Run `gh run list --branch feat/mcp-skill-credentials --limit 1` to confirm CI started
