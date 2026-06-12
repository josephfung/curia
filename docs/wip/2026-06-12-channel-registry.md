# Channel Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a database-backed install/enable registry for Curia's channels, with credentials in the secrets vault (vault-first, env/config fallback), a formal `Channel` interface, and a Channels management page in the console.

**Architecture:** A code-defined `CHANNEL_CATALOG` is the source of truth for which channels exist and what credentials each needs. A new `channel_registry` table holds mutable lifecycle state (enabled + `is_toggleable` + timestamps). `ChannelRegistryService` (mirroring `RegistryService`) drives install/enable/disable/uninstall; `reconcileChannelRegistry` seeds enabled rows for channels whose credentials already resolve. At startup, only enabled+resolvable channels construct/start their adapters — except HTTP and CLI, which always start and cannot be toggled.

**Tech Stack:** TypeScript (ESM, Node 22), PostgreSQL + node-pg-migrate, Fastify, Vitest, React + TanStack Router (apps/console).

**Spec:** `docs/wip/2026-06-12-channel-registry-design.md`. **Follow-up (out of scope):** #962 (channel policy).

---

## Conventions for every command in this plan

- `WT` = `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-registry` (the worktree you are working in).
- Typecheck: `pnpm --prefix "$WT" run typecheck`
- Run one test file: `pnpm --prefix "$WT" test <path>` (vitest takes a path filter).
- Integration tests need Postgres: ensure `DATABASE_URL` is exported (it's in the symlinked `.env`; the integration `describeIf` skips when unset, so confirm it's set before relying on those tests).
- **Before starting:** run `pnpm --prefix "$WT" install` once so `node_modules` exists in the worktree.
- Commit after each task with the message shown. Conventional commits, no `Co-Authored-By`, no Claude attribution.

---

## File structure

**New files:**
- `src/db/migrations/052_create_channel_registry.sql` — table + updated_at trigger.
- `src/channels/channel.ts` — the `Channel` interface.
- `src/channels/catalog.ts` — `ChannelCredentialField`, `ChannelDescriptor`, `CHANNEL_CATALOG`.
- `src/channels/credential-resolver.ts` — vault-first credential resolution + per-field status.
- `src/registry/channel-registry-types.ts` — row/entry/repo types + `ChannelGuardError`.
- `src/registry/channel-registry-repo.ts` — Postgres `ChannelRegistryRepo`.
- `src/registry/channel-registry-service.ts` — `ChannelRegistryService`.
- `src/registry/channel-reconcile.ts` — `reconcileChannelRegistry`.
- `src/channels/http/routes/channel-registry.ts` — `/api/registry/channels/*` routes.
- `apps/console/src/pages/ChannelSettings.tsx` — Channels page (list + drawer + credential form).
- Tests alongside each (`*.test.ts`) and integration tests under `tests/integration/`.

**Modified files:**
- `src/channels/cli/cli-adapter.ts`, `signal/signal-adapter.ts`, `email/email-adapter.ts`, `http/http-adapter.ts` — implement `Channel`.
- `src/channels/http/http-adapter.ts` — register channel-registry routes; add `channelRegistryService` to config.
- `src/index.ts` — construct repo/service, reconcile, gate adapter construction on enabled state, pass service to HTTP adapter.
- `apps/console/src/components/Sidebar.tsx`, `apps/console/src/router.tsx` — Channels nav + route.
- `CHANGELOG.md`, `config/default.yaml` (doc comment), `CLAUDE.md` ("New Channel Adapter" now references the real interface).

---

## Task 1: `Channel` interface

**Files:**
- Create: `src/channels/channel.ts`

No test (type-only declaration; conformance is verified in Task 3).

- [ ] **Step 1: Create the interface**

```typescript
// src/channels/channel.ts
// Formal contract every channel adapter implements. Replaces the previous duck-typed
// pattern (adapters historically exposed only start()). `isToggleable` is false for the
// always-on safeguard channels (http, cli) which must never be disabled from the UI.

export interface Channel {
  /** Stable identifier: 'email' | 'signal' | 'http' | 'cli'. Matches the catalog + registry row. */
  readonly name: string;
  /** False for http and cli — they always start and cannot be disabled/uninstalled. */
  readonly isToggleable: boolean;
  start(): Promise<void>;
  /** Graceful teardown (used on process shutdown). Idempotent. */
  stop(): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --prefix "$WT" run typecheck`
Expected: PASS (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add src/channels/channel.ts
git -C "$WT" commit -m "feat(channels): add formal Channel interface"
```

---

## Task 2: Channel catalog

**Files:**
- Create: `src/channels/catalog.ts`
- Test: `src/channels/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/channels/catalog.test.ts
import { describe, it, expect } from 'vitest';
import { CHANNEL_CATALOG, getChannelDescriptor } from './catalog.js';

describe('CHANNEL_CATALOG', () => {
  it('contains exactly the four known channels', () => {
    expect(CHANNEL_CATALOG.map(c => c.name).sort()).toEqual(['cli', 'email', 'http', 'signal']);
  });

  it('marks http and cli as non-toggleable with no credential fields', () => {
    for (const name of ['http', 'cli']) {
      const d = getChannelDescriptor(name)!;
      expect(d.isToggleable).toBe(false);
      expect(d.credentialFields).toEqual([]);
      expect(d.requiredSecretKeys).toEqual([]);
    }
  });

  it('marks email and signal as toggleable with required credential fields', () => {
    const email = getChannelDescriptor('email')!;
    expect(email.isToggleable).toBe(true);
    expect(email.requiredSecretKeys).toEqual(['nylas_api_key', 'nylas_grant_id', 'nylas_self_email']);

    const signal = getChannelDescriptor('signal')!;
    expect(signal.isToggleable).toBe(true);
    expect(signal.requiredSecretKeys).toEqual(['socket_path', 'phone_number']);
  });

  it('every requiredSecretKey corresponds to a declared field', () => {
    for (const d of CHANNEL_CATALOG) {
      const fieldKeys = new Set(d.credentialFields.map(f => f.key));
      for (const req of d.requiredSecretKeys) expect(fieldKeys.has(req)).toBe(true);
    }
  });

  it('getChannelDescriptor returns undefined for unknown channels', () => {
    expect(getChannelDescriptor('telegram')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix "$WT" test src/channels/catalog.test.ts`
Expected: FAIL ("Cannot find module './catalog.js'").

- [ ] **Step 3: Implement the catalog**

```typescript
// src/channels/catalog.ts
// Static, code-defined source of truth for which channels exist, whether each is
// toggleable, and what credentials it needs. The channel_registry table holds only
// mutable lifecycle state; this catalog supplies everything structural.

export interface ChannelCredentialField {
  /** Vault key suffix: stored as `channel.<channel>.<key>`. */
  key: string;
  /** Human label for the credential form. */
  label: string;
  /** Render as a password input and never echo the value back over the API. */
  secret: boolean;
  /** Legacy env var checked during resolution (back-compat with pre-vault deployments). */
  envFallback?: string;
}

export interface ChannelDescriptor {
  name: string;
  description: string;
  /** False for http, cli — always-on, cannot be disabled/uninstalled. */
  isToggleable: boolean;
  credentialFields: ChannelCredentialField[];
  /** Subset of credentialFields[].key that must resolve before the channel can be enabled. */
  requiredSecretKeys: string[];
}

export const CHANNEL_CATALOG: ChannelDescriptor[] = [
  {
    name: 'email',
    description: 'Email channel via Nylas. Polls a connected mailbox and replies in-thread.',
    isToggleable: true,
    credentialFields: [
      { key: 'nylas_api_key', label: 'Nylas API key', secret: true, envFallback: 'NYLAS_API_KEY' },
      { key: 'nylas_grant_id', label: 'Nylas grant ID', secret: true, envFallback: 'NYLAS_GRANT_ID' },
      { key: 'nylas_self_email', label: 'Mailbox address', secret: false, envFallback: 'NYLAS_SELF_EMAIL' },
    ],
    requiredSecretKeys: ['nylas_api_key', 'nylas_grant_id', 'nylas_self_email'],
  },
  {
    name: 'signal',
    description: 'Signal channel via signal-cli JSON-RPC over a Unix socket.',
    isToggleable: true,
    credentialFields: [
      { key: 'socket_path', label: 'signal-cli socket path', secret: false, envFallback: 'SIGNAL_SOCKET_PATH' },
      { key: 'phone_number', label: 'Phone number (E.164)', secret: false, envFallback: 'SIGNAL_PHONE_NUMBER' },
    ],
    requiredSecretKeys: ['socket_path', 'phone_number'],
  },
  {
    name: 'http',
    description: 'HTTP API channel. Always on — serves the web console and API.',
    isToggleable: false,
    credentialFields: [],
    requiredSecretKeys: [],
  },
  {
    name: 'cli',
    description: 'Local CLI channel. Always on in interactive sessions; cannot be disabled.',
    isToggleable: false,
    credentialFields: [],
    requiredSecretKeys: [],
  },
];

export function getChannelDescriptor(name: string): ChannelDescriptor | undefined {
  return CHANNEL_CATALOG.find(c => c.name === name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix "$WT" test src/channels/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add src/channels/catalog.ts src/channels/catalog.test.ts
git -C "$WT" commit -m "feat(channels): add channel catalog descriptor"
```

---

## Task 3: Adapters implement `Channel`

Make all four adapters satisfy the interface. CLI's `start()` becomes `async`; email/http gain `stop()`; all gain `readonly name` + `readonly isToggleable`.

**Files:**
- Modify: `src/channels/cli/cli-adapter.ts`
- Modify: `src/channels/signal/signal-adapter.ts`
- Modify: `src/channels/email/email-adapter.ts`
- Modify: `src/channels/http/http-adapter.ts`
- Test: `src/channels/channel-conformance.test.ts`

- [ ] **Step 1: Write the failing conformance test**

```typescript
// src/channels/channel-conformance.test.ts
// Compile-time + light runtime check that each adapter satisfies the Channel interface.
// We assert the static shape (name, isToggleable, start, stop) without constructing the
// adapters (which need live deps) by using `satisfies`-style type assertions in a typed
// helper plus a runtime prototype check.
import { describe, it, expect } from 'vitest';
import type { Channel } from './channel.js';
import { CliAdapter } from './cli/cli-adapter.js';
import { SignalAdapter } from './signal/signal-adapter.js';
import { EmailAdapter } from './email/email-adapter.js';
import { HttpAdapter } from './http/http-adapter.js';

// Type-level assertion: each class's instance type must be assignable to Channel.
// If an adapter is missing a member, this file fails to typecheck.
type AssertChannel<T extends Channel> = T;
type _Cli = AssertChannel<CliAdapter>;
type _Signal = AssertChannel<SignalAdapter>;
type _Email = AssertChannel<EmailAdapter>;
type _Http = AssertChannel<HttpAdapter>;

describe('channel adapters implement Channel', () => {
  it('expose start and stop on their prototypes', () => {
    for (const cls of [CliAdapter, SignalAdapter, EmailAdapter, HttpAdapter]) {
      expect(typeof cls.prototype.start).toBe('function');
      expect(typeof cls.prototype.stop).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix "$WT" test src/channels/channel-conformance.test.ts`
Expected: FAIL — typecheck errors (CLI `start` returns `void` not `Promise<void>`; missing `name`/`isToggleable`; email/http missing `stop`).

- [ ] **Step 3a: CLI adapter — implement Channel**

In `src/channels/cli/cli-adapter.ts`, change the class to declare `implements Channel`, add the two readonly members, and make `start()` async. Import the interface.

```typescript
// at top, add:
import type { Channel } from '../channel.js';

// change the class declaration line to:
export class CliAdapter implements Channel {
  readonly name = 'cli';
  readonly isToggleable = false;
  // ...existing private fields unchanged...

  // change start() signature from `start(): void {` to:
  async start(): Promise<void> {
    // ...existing body unchanged...
  }

  // change stop() from `stop(): void {` to async to match the interface:
  async stop(): Promise<void> {
    this.rl?.close();
  }
}
```

Note: the existing call site `cli.start()` in `index.ts` (around line 2017) does not await — that's fine, `start()` resolves synchronously. Leave it (Task 11 leaves CLI start as-is).

- [ ] **Step 3b: Signal adapter — implement Channel**

In `src/channels/signal/signal-adapter.ts` (`start()` and `stop()` already async):

```typescript
import type { Channel } from '../channel.js';

export class SignalAdapter implements Channel {
  readonly name = 'signal';
  readonly isToggleable = true;
  // ...existing fields/methods unchanged (start/stop already match)...
}
```

- [ ] **Step 3c: Email adapter — implement Channel + add stop()**

In `src/channels/email/email-adapter.ts`. The adapter polls on a timer; `stop()` must halt the poll loop. Add a stop flag + clear the timer handle that `start()` schedules.

```typescript
import type { Channel } from '../channel.js';

export class EmailAdapter implements Channel {
  readonly name = 'email';
  readonly isToggleable = true;
  // Add if not already present:
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;

  // ...existing constructor/start...
  // In start()'s polling scheduler, capture the timer handle into this.pollTimer
  // (e.g. `this.pollTimer = setTimeout(...)`) and check `if (this.stopped) return;`
  // before scheduling the next poll.

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }
}
```

> Implementer note: open `email-adapter.ts`, find where the next poll is scheduled (the `setTimeout`/`setInterval` in the poll loop), assign its handle to `this.pollTimer`, and guard re-scheduling with `this.stopped`. If a timer field already exists, reuse it instead of adding `pollTimer`.

- [ ] **Step 3d: HTTP adapter — implement Channel + add stop()**

In `src/channels/http/http-adapter.ts` (it holds the Fastify instance as `this.app`):

```typescript
import type { Channel } from '../channel.js';

export class HttpAdapter implements Channel {
  readonly name = 'http';
  readonly isToggleable = false;
  // ...existing fields/start unchanged...

  async stop(): Promise<void> {
    await this.app.close();
  }
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `pnpm --prefix "$WT" run typecheck`
Run: `pnpm --prefix "$WT" test src/channels/channel-conformance.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing adapter tests to confirm no regressions**

Run: `pnpm --prefix "$WT" test src/channels/`
Expected: PASS (CLI `start()` now async — verify no existing CLI test asserts a synchronous return; if one does, `await` it).

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add src/channels/cli/cli-adapter.ts src/channels/signal/signal-adapter.ts src/channels/email/email-adapter.ts src/channels/http/http-adapter.ts src/channels/channel-conformance.test.ts
git -C "$WT" commit -m "feat(channels): adapters implement the Channel interface"
```

---

## Task 4: Credential resolver

Resolves each credential vault-first, then env fallback. Config-based resolution (multi-account email) is supplied by the caller as a set of already-satisfied keys, keeping this module pure and testable.

**Files:**
- Create: `src/channels/credential-resolver.ts`
- Test: `src/channels/credential-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/channels/credential-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { channelCredentialStatus } from './credential-resolver.js';
import type { ChannelDescriptor } from './catalog.js';

const signal: ChannelDescriptor = {
  name: 'signal', description: '', isToggleable: true,
  credentialFields: [
    { key: 'socket_path', label: 'Socket', secret: false, envFallback: 'SIGNAL_SOCKET_PATH' },
    { key: 'phone_number', label: 'Phone', secret: false, envFallback: 'SIGNAL_PHONE_NUMBER' },
  ],
  requiredSecretKeys: ['socket_path', 'phone_number'],
};

const fakeSecrets = (present: Record<string, string>) => ({
  async get(name: string) { return present[name] ?? null; },
});

describe('channelCredentialStatus', () => {
  it('resolves from the vault first', async () => {
    const secrets = fakeSecrets({ 'channel.signal.socket_path': '/run/sig.sock', 'channel.signal.phone_number': '+15551234567' });
    const res = await channelCredentialStatus({ secrets, env: {} }, signal);
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields.map(f => f.source)).toEqual(['vault', 'vault']);
  });

  it('falls back to env when vault is empty', async () => {
    const secrets = fakeSecrets({});
    const env = { SIGNAL_SOCKET_PATH: '/run/sig.sock', SIGNAL_PHONE_NUMBER: '+15551234567' };
    const res = await channelCredentialStatus({ secrets, env }, signal);
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields.map(f => f.source)).toEqual(['env', 'env']);
  });

  it('reports missing when neither vault nor env nor config provides a required key', async () => {
    const res = await channelCredentialStatus({ secrets: fakeSecrets({}), env: {} }, signal);
    expect(res.requiredResolvable).toBe(false);
    expect(res.fields.find(f => f.key === 'socket_path')!.source).toBe('missing');
  });

  it('treats caller-supplied config keys as satisfied', async () => {
    const res = await channelCredentialStatus(
      { secrets: fakeSecrets({}), env: {}, configResolvedKeys: new Set(['socket_path', 'phone_number']) },
      signal,
    );
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields.map(f => f.source)).toEqual(['config', 'config']);
  });

  it('a channel with no required keys is always resolvable', async () => {
    const http: ChannelDescriptor = { name: 'http', description: '', isToggleable: false, credentialFields: [], requiredSecretKeys: [] };
    const res = await channelCredentialStatus({ secrets: fakeSecrets({}), env: {} }, http);
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix "$WT" test src/channels/credential-resolver.test.ts`
Expected: FAIL ("Cannot find module './credential-resolver.js'").

- [ ] **Step 3: Implement the resolver**

```typescript
// src/channels/credential-resolver.ts
// Vault-first credential resolution for channels. Precedence per field:
//   vault  (channel.<name>.<key>)  ▸  env (field.envFallback)  ▸  config (caller-supplied)  ▸  missing
// Config resolution lives in the caller (index.ts) because it depends on already-parsed
// config shapes (e.g. multi-account email); the caller passes the satisfied key names in.
import type { ChannelDescriptor } from './catalog.js';

export type CredentialSource = 'vault' | 'env' | 'config' | 'missing';

export interface CredentialFieldStatus {
  key: string;
  label: string;
  secret: boolean;
  configured: boolean;
  source: CredentialSource;
}

export interface CredentialResolverDeps {
  /** Narrow view of the vault — only get() is needed. */
  secrets: { get(name: string): Promise<string | null> };
  /** Defaults to process.env. Injected in tests. */
  env?: Record<string, string | undefined>;
  /** Required keys the caller considers satisfied via config/default.yaml (e.g. email accounts). */
  configResolvedKeys?: Set<string>;
}

export interface ChannelCredentialStatus {
  fields: CredentialFieldStatus[];
  /** True when every requiredSecretKeys entry resolves from some source. */
  requiredResolvable: boolean;
}

export async function channelCredentialStatus(
  deps: CredentialResolverDeps,
  descriptor: ChannelDescriptor,
): Promise<ChannelCredentialStatus> {
  const env = deps.env ?? process.env;
  const configKeys = deps.configResolvedKeys ?? new Set<string>();
  const fields: CredentialFieldStatus[] = [];

  for (const field of descriptor.credentialFields) {
    const vaultVal = await deps.secrets.get(`channel.${descriptor.name}.${field.key}`);
    let source: CredentialSource;
    if (vaultVal) source = 'vault';
    else if (field.envFallback && env[field.envFallback]) source = 'env';
    else if (configKeys.has(field.key)) source = 'config';
    else source = 'missing';

    fields.push({ key: field.key, label: field.label, secret: field.secret, configured: source !== 'missing', source });
  }

  const byKey = new Map(fields.map(f => [f.key, f]));
  const requiredResolvable = descriptor.requiredSecretKeys.every(k => byKey.get(k)?.configured === true);
  return { fields, requiredResolvable };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix "$WT" test src/channels/credential-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add src/channels/credential-resolver.ts src/channels/credential-resolver.test.ts
git -C "$WT" commit -m "feat(channels): add vault-first credential resolver"
```

---

## Task 5: Migration — `channel_registry` table

**Files:**
- Create: `src/db/migrations/052_create_channel_registry.sql`
- Test: `tests/integration/channel-registry-repo.test.ts` (the table-exists assertion lands here in Task 7; this task adds a minimal migration-applied check)

- [ ] **Step 1: Confirm 052 is the next free prefix**

Run: `ls "$WT/src/db/migrations" | sort | tail -4`
Expected: highest is `051_create_skill_agent_registry.sql`. If a `052_*` already exists (a branch landed first), use the next free number everywhere in this plan instead.

- [ ] **Step 2: Write the migration**

```sql
-- src/db/migrations/052_create_channel_registry.sql
-- Up Migration
-- Database-backed registry that gates channel adapter startup on an install/enable
-- lifecycle (spec: docs/wip/2026-06-12-channel-registry-design.md, #543). Mirrors
-- skill_registry/agent_registry, plus is_toggleable: false for http/cli, which always
-- start and cannot be disabled (operator-lockout safeguard). Credentials live in the
-- secrets vault (channel.<name>.<field>); this table stores only lifecycle state.

CREATE TABLE channel_registry (
  name          TEXT PRIMARY KEY,                 -- matches a CHANNEL_CATALOG descriptor name
  enabled       BOOLEAN     NOT NULL DEFAULT false,
  is_toggleable BOOLEAN     NOT NULL DEFAULT true, -- false for http, cli
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by  TEXT        NOT NULL DEFAULT 'system',
  enabled_at    TIMESTAMPTZ,                       -- set when enabled flips true, cleared on disable
  enabled_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION channel_registry_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
$$;

CREATE TRIGGER channel_registry_updated_at
  BEFORE UPDATE ON channel_registry
  FOR EACH ROW EXECUTE FUNCTION channel_registry_set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS channel_registry_updated_at ON channel_registry;
DROP FUNCTION IF EXISTS channel_registry_set_updated_at();
DROP TABLE IF EXISTS channel_registry;
```

- [ ] **Step 3: Apply migrations against the dev DB and verify the table exists**

Run: `pnpm --prefix "$WT" run migrate` (if a migrate script exists; otherwise the table is created at app startup — start the app once, or run the project's migration command). Then verify:
Run: `psql "$DATABASE_URL" -c "\\d channel_registry"`
Expected: the table with columns `name, enabled, is_toggleable, installed_at, installed_by, enabled_at, enabled_by, updated_at`.

> If unsure of the migrate command, check `package.json` scripts for `migrate`/`db:migrate`. The app also runs migrations on boot (`src/index.ts` runner), so launching the app once applies it.

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add src/db/migrations/052_create_channel_registry.sql
git -C "$WT" commit -m "feat(db): add channel_registry table migration"
```

---

## Task 6: Channel registry types

**Files:**
- Create: `src/registry/channel-registry-types.ts`

No standalone test (types + a trivial error class; exercised by Tasks 7–8).

- [ ] **Step 1: Create the types**

```typescript
// src/registry/channel-registry-types.ts
// Types for the channel registry. Mirrors registry/types.ts but channels are
// code-defined (CHANNEL_CATALOG), carry is_toggleable, and never reach a 'ghost' state.
import type { CredentialFieldStatus } from '../channels/credential-resolver.js';

export type ChannelDerivedState = 'uninstalled' | 'installed' | 'enabled';

/** A row in channel_registry, mapped to camelCase. */
export interface ChannelRegistryRow {
  name: string;
  enabled: boolean;
  isToggleable: boolean;
  installedAt: string;
  installedBy: string;
  enabledAt: string | null;
  enabledBy: string | null;
  updatedAt: string;
}

/** A fully-resolved entry the API returns: catalog × row × credential status → state. */
export interface ChannelRegistryEntry {
  name: string;
  description: string;
  state: ChannelDerivedState;
  isToggleable: boolean;
  credentialFields: CredentialFieldStatus[];
  requiredResolvable: boolean;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

/** Thrown for expected guard rejections (unknown channel, not-installed enable,
 *  disable/uninstall of a non-toggleable channel, missing-credential enable).
 *  Routes catch this specifically to return HTTP 400. */
export class ChannelGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelGuardError';
  }
}

/** DB-access contract. Postgres impl is ChannelRegistryRepo; tests use an in-memory fake. */
export interface IChannelRegistryRepo {
  listRows(): Promise<ChannelRegistryRow[]>;
  getRow(name: string): Promise<ChannelRegistryRow | null>;
  /** Insert enabled=false with the given is_toggleable if absent; return existing row if present. */
  install(name: string, actor: string, isToggleable: boolean): Promise<ChannelRegistryRow>;
  enable(name: string, actor: string): Promise<ChannelRegistryRow>;
  disable(name: string, actor: string): Promise<ChannelRegistryRow>;
  uninstall(name: string): Promise<void>;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `pnpm --prefix "$WT" run typecheck`
Expected: PASS.

```bash
git -C "$WT" add src/registry/channel-registry-types.ts
git -C "$WT" commit -m "feat(registry): add channel registry types"
```

---

## Task 7: `ChannelRegistryRepo` (Postgres)

**Files:**
- Create: `src/registry/channel-registry-repo.ts`
- Test: `tests/integration/channel-registry-repo.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/channel-registry-repo.test.ts
// Requires Postgres with migration 052 applied. Skips when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { ChannelRegistryRepo } from '../../src/registry/channel-registry-repo.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('ChannelRegistryRepo', () => {
  let pool: pg.Pool;
  let repo: ChannelRegistryRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM channel_registry LIMIT 0'); // fails loudly if migration 052 not applied
    repo = new ChannelRegistryRepo(pool);
  });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => { await pool.query('DELETE FROM channel_registry'); });

  it('install inserts a disabled row carrying is_toggleable', async () => {
    const row = await repo.install('signal', 'tester', true);
    expect(row.enabled).toBe(false);
    expect(row.isToggleable).toBe(true);
    expect(row.installedBy).toBe('tester');
    expect(row.enabledAt).toBeNull();
  });

  it('install is idempotent and preserves is_toggleable of the existing row', async () => {
    await repo.install('http', 'system', false);
    const again = await repo.install('http', 'someone', true); // should NOT flip to toggleable
    expect(again.isToggleable).toBe(false);
  });

  it('enable then disable toggles enabled + enabled_at', async () => {
    await repo.install('signal', 'tester', true);
    const enabled = await repo.enable('signal', 'admin');
    expect(enabled.enabled).toBe(true);
    expect(enabled.enabledAt).not.toBeNull();
    const disabled = await repo.disable('signal', 'admin');
    expect(disabled.enabled).toBe(false);
    expect(disabled.enabledAt).toBeNull();
  });

  it('uninstall removes the row', async () => {
    await repo.install('signal', 'tester', true);
    await repo.uninstall('signal');
    expect(await repo.getRow('signal')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix "$WT" test tests/integration/channel-registry-repo.test.ts`
Expected: FAIL ("Cannot find module .../channel-registry-repo.js"). (If `DATABASE_URL` is unset the suite skips — set it first so the test actually runs.)

- [ ] **Step 3: Implement the repo**

```typescript
// src/registry/channel-registry-repo.ts
// Postgres-backed channel_registry access. Parameterized queries only.
import type { DbPool } from '../db/pool.js';
import type { ChannelRegistryRow, IChannelRegistryRepo } from './channel-registry-types.js';

const COLS = 'name, enabled, is_toggleable, installed_at, installed_by, enabled_at, enabled_by, updated_at';

interface DbChannelRow {
  name: string;
  enabled: boolean;
  is_toggleable: boolean;
  installed_at: string;
  installed_by: string;
  enabled_at: string | null;
  enabled_by: string | null;
  updated_at: string;
}

function mapRow(r: DbChannelRow): ChannelRegistryRow {
  return {
    name: r.name,
    enabled: r.enabled,
    isToggleable: r.is_toggleable,
    installedAt: r.installed_at,
    installedBy: r.installed_by,
    enabledAt: r.enabled_at,
    enabledBy: r.enabled_by,
    updatedAt: r.updated_at,
  };
}

export class ChannelRegistryRepo implements IChannelRegistryRepo {
  constructor(private readonly pool: DbPool) {}

  async listRows(): Promise<ChannelRegistryRow[]> {
    const { rows } = await this.pool.query<DbChannelRow>(`SELECT ${COLS} FROM channel_registry`);
    return rows.map(mapRow);
  }

  async getRow(name: string): Promise<ChannelRegistryRow | null> {
    const { rows } = await this.pool.query<DbChannelRow>(`SELECT ${COLS} FROM channel_registry WHERE name = $1`, [name]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async install(name: string, actor: string, isToggleable: boolean): Promise<ChannelRegistryRow> {
    // Insert a disabled row; if it already exists, leave it untouched (incl. is_toggleable)
    // and return it. The no-op SET makes ON CONFLICT return the existing row via RETURNING.
    const { rows } = await this.pool.query<DbChannelRow>(
      `INSERT INTO channel_registry (name, enabled, is_toggleable, installed_by)
       VALUES ($1, false, $3, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING ${COLS}`,
      [name, actor, isToggleable],
    );
    return mapRow(rows[0]!);
  }

  async enable(name: string, actor: string): Promise<ChannelRegistryRow> {
    const { rows } = await this.pool.query<DbChannelRow>(
      `UPDATE channel_registry
          SET enabled = true, enabled_at = now(), enabled_by = $2, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name, actor],
    );
    if (!rows[0]) throw new Error(`enable: no channel_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async disable(name: string, actor: string): Promise<ChannelRegistryRow> {
    const { rows } = await this.pool.query<DbChannelRow>(
      `UPDATE channel_registry
          SET enabled = false, enabled_at = NULL, enabled_by = NULL, updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name, actor],
    );
    if (!rows[0]) throw new Error(`disable: no channel_registry row for '${name}'`);
    return mapRow(rows[0]);
  }

  async uninstall(name: string): Promise<void> {
    await this.pool.query(`DELETE FROM channel_registry WHERE name = $1`, [name]);
  }
}
```

> Implementer note: confirm the `DbPool` type import path. Check how `src/registry/registry-repo.ts` imports its pool type and mirror it exactly (it may be `import type { DbPool } from '../db/pool.js'` or a `pg.Pool` alias). The `enable`/`disable` params keep `actor` even though `disable` clears `enabled_by` — `actor` is unused there but kept for interface symmetry; prefix with `_` only if the linter complains.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix "$WT" test tests/integration/channel-registry-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --prefix "$WT" run typecheck`

```bash
git -C "$WT" add src/registry/channel-registry-repo.ts tests/integration/channel-registry-repo.test.ts
git -C "$WT" commit -m "feat(registry): add ChannelRegistryRepo"
```

---

## Task 8: `ChannelRegistryService`

**Files:**
- Create: `src/registry/channel-registry-service.ts`
- Test: `src/registry/channel-registry-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/registry/channel-registry-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelRegistryService } from './channel-registry-service.js';
import { ChannelGuardError } from './channel-registry-types.js';
import type { IChannelRegistryRepo, ChannelRegistryRow } from './channel-registry-types.js';
import type { ChannelDescriptor } from '../channels/catalog.js';
import type { ChannelCredentialStatus } from '../channels/credential-resolver.js';

class FakeRepo implements IChannelRegistryRepo {
  rows = new Map<string, ChannelRegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(n: string) { return this.rows.get(n) ?? null; }
  async install(name: string, actor: string, isToggleable: boolean) {
    const existing = this.rows.get(name);
    if (existing) return existing;
    const row: ChannelRegistryRow = { name, enabled: false, isToggleable, installedAt: 't0', installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: 't0' };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) {
    const row = this.rows.get(name); if (!row) throw new Error('no row');
    const next = { ...row, enabled: true, enabledAt: 't1', enabledBy: actor }; this.rows.set(name, next); return next;
  }
  async disable(name: string, _actor: string) {
    const row = this.rows.get(name); if (!row) throw new Error('no row');
    const next = { ...row, enabled: false, enabledAt: null, enabledBy: null }; this.rows.set(name, next); return next;
  }
  async uninstall(name: string) { this.rows.delete(name); }
}

const CATALOG: ChannelDescriptor[] = [
  { name: 'signal', description: 'sig', isToggleable: true,
    credentialFields: [{ key: 'phone_number', label: 'Phone', secret: false }], requiredSecretKeys: ['phone_number'] },
  { name: 'http', description: 'http', isToggleable: false, credentialFields: [], requiredSecretKeys: [] },
];

// Credential status fn: signal resolvable iff `signalReady`, http always resolvable.
const statusFn = (signalReady: boolean) =>
  async (d: ChannelDescriptor): Promise<ChannelCredentialStatus> => {
    if (d.name === 'signal') {
      return { requiredResolvable: signalReady, fields: [{ key: 'phone_number', label: 'Phone', secret: false, configured: signalReady, source: signalReady ? 'vault' : 'missing' }] };
    }
    return { requiredResolvable: true, fields: [] };
  };

describe('ChannelRegistryService', () => {
  let repo: FakeRepo;
  beforeEach(() => { repo = new FakeRepo(); });

  it('list derives state: no row → uninstalled, row+disabled → installed, row+enabled → enabled', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    let entries = await svc.list();
    expect(entries.find(e => e.name === 'signal')!.state).toBe('uninstalled');
    await svc.install('signal', 'a');
    entries = await svc.list();
    expect(entries.find(e => e.name === 'signal')!.state).toBe('installed');
    await svc.enable('signal', 'a');
    entries = await svc.list();
    expect(entries.find(e => e.name === 'signal')!.state).toBe('enabled');
  });

  it('list surfaces isToggleable and credential field status from the catalog + resolver', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(false));
    const entries = await svc.list();
    const http = entries.find(e => e.name === 'http')!;
    expect(http.isToggleable).toBe(false);
    const signal = entries.find(e => e.name === 'signal')!;
    expect(signal.requiredResolvable).toBe(false);
    expect(signal.credentialFields[0]!.source).toBe('missing');
  });

  it('enable is rejected when required credentials do not resolve', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(false));
    await svc.install('signal', 'a');
    await expect(svc.enable('signal', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('enable of a not-installed channel is rejected', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    await expect(svc.enable('signal', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('install/enable/disable of an unknown channel is rejected', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    await expect(svc.install('telegram', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('disable and uninstall of a non-toggleable channel are rejected', async () => {
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true));
    await repo.install('http', 'system', false);
    await repo.enable('http', 'system');
    await expect(svc.disable('http', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
    await expect(svc.uninstall('http', 'a')).rejects.toBeInstanceOf(ChannelGuardError);
  });

  it('uninstall clears the channel vault keys and removes the row', async () => {
    const deleted: string[] = [];
    const svc = new ChannelRegistryService(repo, CATALOG, statusFn(true), { delete: async (n: string) => { deleted.push(n); } });
    await svc.install('signal', 'a');
    await svc.uninstall('signal', 'a');
    expect(deleted).toContain('channel.signal.phone_number');
    expect(await repo.getRow('signal')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix "$WT" test src/registry/channel-registry-service.test.ts`
Expected: FAIL ("Cannot find module './channel-registry-service.js'").

- [ ] **Step 3: Implement the service**

```typescript
// src/registry/channel-registry-service.ts
// Drives the channel install/enable lifecycle. Channels are code-defined (CHANNEL_CATALOG),
// so there is no on-disk discovery and no 'ghost' state. enable() is gated on the channel's
// required credentials resolving (vault/env/config); disable()/uninstall() are blocked for
// non-toggleable channels (http, cli).
import type { ChannelDescriptor } from '../channels/catalog.js';
import type { ChannelCredentialStatus } from '../channels/credential-resolver.js';
import {
  ChannelGuardError,
  type ChannelRegistryEntry,
  type IChannelRegistryRepo,
} from './channel-registry-types.js';

/** Resolves the live credential status for a descriptor (vault/env/config). Injected so the
 *  service stays decoupled from the vault + config wiring and is trivially fakeable in tests. */
export type CredentialStatusFn = (descriptor: ChannelDescriptor) => Promise<ChannelCredentialStatus>;

export class ChannelRegistryService {
  constructor(
    private readonly repo: IChannelRegistryRepo,
    private readonly catalog: ChannelDescriptor[],
    private readonly credentialStatus: CredentialStatusFn,
    /** Used by uninstall() to clear the channel's vault keys. Optional in tests. */
    private readonly secrets?: { delete(name: string): Promise<void> },
  ) {}

  private descriptor(name: string): ChannelDescriptor {
    const d = this.catalog.find(c => c.name === name);
    if (!d) throw new ChannelGuardError(`Unknown channel '${name}'.`);
    return d;
  }

  async list(): Promise<ChannelRegistryEntry[]> {
    const rows = await this.repo.listRows();
    const rowByName = new Map(rows.map(r => [r.name, r]));
    const entries: ChannelRegistryEntry[] = [];

    for (const d of this.catalog) {
      const row = rowByName.get(d.name);
      const status = await this.credentialStatus(d);
      const state = !row ? 'uninstalled' : row.enabled ? 'enabled' : 'installed';
      entries.push({
        name: d.name,
        description: d.description,
        state,
        isToggleable: d.isToggleable,
        credentialFields: status.fields,
        requiredResolvable: status.requiredResolvable,
        installedAt: row?.installedAt ?? null,
        installedBy: row?.installedBy ?? null,
        enabledAt: row?.enabledAt ?? null,
        enabledBy: row?.enabledBy ?? null,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async install(name: string, actor: string): Promise<ChannelRegistryEntry> {
    const d = this.descriptor(name);
    await this.repo.install(name, actor, d.isToggleable);
    return this.entry(name);
  }

  async enable(name: string, actor: string): Promise<ChannelRegistryEntry> {
    const d = this.descriptor(name);
    const row = await this.repo.getRow(name);
    if (!row) throw new ChannelGuardError(`Cannot enable '${name}': not installed. Install it first.`);
    const status = await this.credentialStatus(d);
    if (!status.requiredResolvable) {
      throw new ChannelGuardError(`Cannot enable '${name}': required credentials are not configured.`);
    }
    await this.repo.enable(name, actor);
    return this.entry(name);
  }

  async disable(name: string, actor: string): Promise<ChannelRegistryEntry> {
    const d = this.descriptor(name);
    if (!d.isToggleable) throw new ChannelGuardError(`Channel '${name}' cannot be disabled.`);
    const row = await this.repo.getRow(name);
    if (!row) throw new ChannelGuardError(`Cannot disable '${name}': no registry row.`);
    await this.repo.disable(name, actor);
    return this.entry(name);
  }

  async uninstall(name: string, _actor: string): Promise<void> {
    const d = this.descriptor(name);
    if (!d.isToggleable) throw new ChannelGuardError(`Channel '${name}' cannot be uninstalled.`);
    // Clear the channel's vault keys (best-effort; delete is a no-op if the key is absent).
    if (this.secrets) {
      for (const field of d.credentialFields) {
        await this.secrets.delete(`channel.${name}.${field.key}`);
      }
    }
    await this.repo.uninstall(name);
  }

  private async entry(name: string): Promise<ChannelRegistryEntry> {
    const entries = await this.list();
    const found = entries.find(e => e.name === name);
    if (!found) throw new Error(`entry: '${name}' not in catalog after mutation`);
    return found;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix "$WT" test src/registry/channel-registry-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --prefix "$WT" run typecheck`

```bash
git -C "$WT" add src/registry/channel-registry-service.ts src/registry/channel-registry-service.test.ts
git -C "$WT" commit -m "feat(registry): add ChannelRegistryService"
```

---

## Task 9: `reconcileChannelRegistry`

Seeds the registry at startup: http/cli always present + enabled (locked); toggleable channels with resolvable credentials and no existing row get installed + enabled.

**Files:**
- Create: `src/registry/channel-reconcile.ts`
- Test: `src/registry/channel-reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/registry/channel-reconcile.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileChannelRegistry } from './channel-reconcile.js';
import type { IChannelRegistryRepo, ChannelRegistryRow } from './channel-registry-types.js';
import type { ChannelDescriptor } from '../channels/catalog.js';
import type { ChannelCredentialStatus } from '../channels/credential-resolver.js';

class FakeRepo implements IChannelRegistryRepo {
  rows = new Map<string, ChannelRegistryRow>();
  async listRows() { return [...this.rows.values()]; }
  async getRow(n: string) { return this.rows.get(n) ?? null; }
  async install(name: string, actor: string, isToggleable: boolean) {
    const e = this.rows.get(name); if (e) return e;
    const row: ChannelRegistryRow = { name, enabled: false, isToggleable, installedAt: 't0', installedBy: actor, enabledAt: null, enabledBy: null, updatedAt: 't0' };
    this.rows.set(name, row); return row;
  }
  async enable(name: string, actor: string) { const r = this.rows.get(name)!; const n = { ...r, enabled: true, enabledAt: 't1', enabledBy: actor }; this.rows.set(name, n); return n; }
  async disable(name: string, _a: string) { const r = this.rows.get(name)!; const n = { ...r, enabled: false, enabledAt: null, enabledBy: null }; this.rows.set(name, n); return n; }
  async uninstall(name: string) { this.rows.delete(name); }
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

const CATALOG: ChannelDescriptor[] = [
  { name: 'email', description: '', isToggleable: true, credentialFields: [], requiredSecretKeys: ['x'] },
  { name: 'signal', description: '', isToggleable: true, credentialFields: [], requiredSecretKeys: ['y'] },
  { name: 'http', description: '', isToggleable: false, credentialFields: [], requiredSecretKeys: [] },
  { name: 'cli', description: '', isToggleable: false, credentialFields: [], requiredSecretKeys: [] },
];

// resolvable: only 'email'
const statusFn = async (d: ChannelDescriptor): Promise<ChannelCredentialStatus> =>
  ({ requiredResolvable: d.name === 'email' || !d.isToggleable, fields: [] });

describe('reconcileChannelRegistry', () => {
  let repo: FakeRepo;
  beforeEach(() => { repo = new FakeRepo(); });

  it('always enrolls http and cli as enabled + non-toggleable', async () => {
    await reconcileChannelRegistry({ repo, catalog: CATALOG, credentialStatus: statusFn, logger: silentLogger });
    for (const name of ['http', 'cli']) {
      const row = repo.rows.get(name)!;
      expect(row.enabled).toBe(true);
      expect(row.isToggleable).toBe(false);
    }
  });

  it('enrolls a toggleable channel as enabled only when its credentials resolve', async () => {
    await reconcileChannelRegistry({ repo, catalog: CATALOG, credentialStatus: statusFn, logger: silentLogger });
    expect(repo.rows.get('email')!.enabled).toBe(true);   // resolvable
    expect(repo.rows.get('signal')).toBeUndefined();       // not resolvable → no row
  });

  it('respects existing admin state and does not overwrite it', async () => {
    await repo.install('email', 'admin', true); // installed but deliberately left disabled
    await reconcileChannelRegistry({ repo, catalog: CATALOG, credentialStatus: statusFn, logger: silentLogger });
    expect(repo.rows.get('email')!.enabled).toBe(false);   // left as-is
  });

  it('re-enables http/cli if a prior run left them disabled (safeguard)', async () => {
    await repo.install('http', 'system', false); // disabled row exists
    await reconcileChannelRegistry({ repo, catalog: CATALOG, credentialStatus: statusFn, logger: silentLogger });
    expect(repo.rows.get('http')!.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix "$WT" test src/registry/channel-reconcile.test.ts`
Expected: FAIL ("Cannot find module './channel-reconcile.js'").

- [ ] **Step 3: Implement reconcile**

```typescript
// src/registry/channel-reconcile.ts
// Startup reconciliation for the channel registry:
//   - http/cli (non-toggleable) are ALWAYS present and enabled — operator-lockout safeguard.
//   - toggleable channels with no row whose credentials resolve are installed + enabled, so
//     existing deployments light up unchanged. Existing admin state is never overwritten.
import type { Logger } from 'pino';
import type { ChannelDescriptor } from '../channels/catalog.js';
import type { CredentialStatusFn } from './channel-registry-service.js';
import type { IChannelRegistryRepo } from './channel-registry-types.js';

export interface ReconcileChannelDeps {
  repo: IChannelRegistryRepo;
  catalog: ChannelDescriptor[];
  credentialStatus: CredentialStatusFn;
  logger: Logger;
}

export async function reconcileChannelRegistry(deps: ReconcileChannelDeps): Promise<void> {
  const { repo, catalog, credentialStatus, logger } = deps;
  const existing = new Map((await repo.listRows()).map(r => [r.name, r]));

  for (const d of catalog) {
    const row = existing.get(d.name);

    // Always-on channels: ensure present + enabled, regardless of prior state.
    if (!d.isToggleable) {
      if (!row) {
        await repo.install(d.name, 'reconciliation', false);
        await repo.enable(d.name, 'reconciliation');
        logger.info({ channel: d.name }, 'channel registry: enrolled always-on channel as enabled');
      } else if (!row.enabled) {
        await repo.enable(d.name, 'reconciliation');
        logger.warn({ channel: d.name }, 'channel registry: re-enabled always-on channel that was disabled');
      }
      continue;
    }

    // Toggleable channels: respect any existing admin state.
    if (row) continue;

    const status = await credentialStatus(d);
    if (status.requiredResolvable) {
      await repo.install(d.name, 'reconciliation', true);
      await repo.enable(d.name, 'reconciliation');
      logger.info({ channel: d.name }, 'channel registry: enrolled channel with resolvable credentials as enabled');
    } else {
      logger.info({ channel: d.name }, 'channel registry: channel has no credentials; left uninstalled');
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --prefix "$WT" test src/registry/channel-reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --prefix "$WT" run typecheck`

```bash
git -C "$WT" add src/registry/channel-reconcile.ts src/registry/channel-reconcile.test.ts
git -C "$WT" commit -m "feat(registry): add channel registry reconciliation"
```

---

## Task 10: HTTP routes `/api/registry/channels/*`

**Files:**
- Create: `src/channels/http/routes/channel-registry.ts`
- Modify: `src/channels/http/http-adapter.ts` (register routes + extend config type)
- Test: `src/channels/http/routes/channel-registry.test.ts`

> First read `src/channels/http/routes/registry.ts` in full to copy the exact `requireAuth`, `AUTH_RATE`, options-type, and `app.register` plugin shape used there. The handlers below follow that pattern; match the real helper names/imports from that file.

- [ ] **Step 1: Write the failing test**

```typescript
// src/channels/http/routes/channel-registry.test.ts
// Spins up a Fastify instance with the channel-registry routes and a fake service,
// bypassing auth via the bootstrap-secret header (mirror how registry.test.ts authenticates).
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { channelRegistryRoutes } from './channel-registry.js';
import { ChannelGuardError } from '../../../registry/channel-registry-types.js';

const BOOTSTRAP = 'test-bootstrap-secret';

function fakeService(overrides: Record<string, any> = {}) {
  return {
    list: async () => [{ name: 'signal', description: '', state: 'uninstalled', isToggleable: true, credentialFields: [], requiredResolvable: false, installedAt: null, installedBy: null, enabledAt: null, enabledBy: null }],
    install: async () => ({ name: 'signal', state: 'installed' }),
    enable: async () => ({ name: 'signal', state: 'enabled' }),
    disable: async () => ({ name: 'signal', state: 'installed' }),
    uninstall: async () => {},
    ...overrides,
  };
}

async function build(service: any): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(channelRegistryRoutes, { channelRegistryService: service, webAppBootstrapSecret: BOOTSTRAP, sessions: { /* minimal stub matching registry.ts */ } as any });
  return app;
}

const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };

describe('channel registry routes', () => {
  let app: FastifyInstance;
  afterEach?.(async () => { await app?.close(); });

  it('GET /api/registry/channels returns the list', async () => {
    app = await build(fakeService());
    const res = await app.inject({ method: 'GET', url: '/api/registry/channels', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().channels[0].name).toBe('signal');
  });

  it('POST enable maps ChannelGuardError to 400', async () => {
    app = await build(fakeService({ enable: async () => { throw new ChannelGuardError('nope'); } }));
    const res = await app.inject({ method: 'POST', url: '/api/registry/channels/signal/enable', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('nope');
  });

  it('rejects unauthenticated requests', async () => {
    app = await build(fakeService());
    const res = await app.inject({ method: 'GET', url: '/api/registry/channels' });
    expect(res.statusCode).toBe(401);
  });
});
```

> The exact auth stub (`sessions`) and the unauth status code (401 vs 403) must match `registry.ts`/`requireAuth`. Adjust the test's `sessions` stub and expected unauth code to whatever `registry.ts` uses; read it first.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --prefix "$WT" test src/channels/http/routes/channel-registry.test.ts`
Expected: FAIL ("Cannot find module './channel-registry.js'").

- [ ] **Step 3: Implement the routes**

```typescript
// src/channels/http/routes/channel-registry.ts
// REST surface for the channel registry, mirroring routes/registry.ts. Session-authed
// (or bootstrap-secret). ChannelGuardError → 400; anything else → 500.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ChannelGuardError } from '../../../registry/channel-registry-types.js';
import type { ChannelRegistryService } from '../../../registry/channel-registry-service.js';
// Reuse the SAME auth helpers/rate config registry.ts uses. Import them from there or the
// shared module registry.ts imports from — do not re-implement auth.
import { requireAuth, AUTH_RATE, type SessionStore } from './registry.js'; // adjust to real exports

const ACTOR = 'web-console';

export interface ChannelRegistryRouteOptions {
  channelRegistryService: ChannelRegistryService;
  webAppBootstrapSecret: string;
  sessions: SessionStore; // match registry.ts's type
}

export async function channelRegistryRoutes(
  app: FastifyInstance,
  options: ChannelRegistryRouteOptions,
): Promise<void> {
  const { channelRegistryService: svc } = options;

  app.get('/api/registry/channels', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send({ channels: await svc.list() });
    } catch (err) {
      request.log.error({ err }, 'GET /api/registry/channels failed');
      return reply.status(500).send({ error: 'Failed to list channels. Check server logs.' });
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
        if (err instanceof ChannelGuardError) {
          request.log.info({ err, name, op }, `channel ${op} rejected: guard`);
          return reply.status(400).send({ error: err.message });
        }
        request.log.error({ err, name, op }, `channel ${op} failed unexpectedly`);
        return reply.status(500).send({ error: 'Operation failed. Check server logs.' });
      }
    };

  app.post('/api/registry/channels/:name/install', AUTH_RATE, action('install'));
  app.post('/api/registry/channels/:name/enable', AUTH_RATE, action('enable'));
  app.post('/api/registry/channels/:name/disable', AUTH_RATE, action('disable'));
  app.delete('/api/registry/channels/:name', AUTH_RATE, action('uninstall'));
}
```

> If `requireAuth`/`AUTH_RATE`/`SessionStore` are not exported from `registry.ts`, find their real source module (they may live in a shared `http/auth.ts` or similar) and import from there. Keeping a single auth implementation is required — do not duplicate it.

- [ ] **Step 4: Register the routes in `http-adapter.ts`**

In `src/channels/http/http-adapter.ts`, extend the config type with `channelRegistryService?` and register the routes next to the existing registry routes (the block around lines 308–327). Add:

```typescript
import { channelRegistryRoutes } from './routes/channel-registry.js';
// ...in HttpAdapterConfig: add
//   channelRegistryService?: ChannelRegistryService;
// ...in the registry-routes registration block, after the vaultRoutes register:
    if (webAppBootstrapSecret && this.config.channelRegistryService) {
      await this.app.register(channelRegistryRoutes, {
        channelRegistryService: this.config.channelRegistryService,
        webAppBootstrapSecret,
        sessions,
      });
    }
```

Add the `ChannelRegistryService` type import at the top of `http-adapter.ts`.

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --prefix "$WT" test src/channels/http/routes/channel-registry.test.ts`
Run: `pnpm --prefix "$WT" run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add src/channels/http/routes/channel-registry.ts src/channels/http/routes/channel-registry.test.ts src/channels/http/http-adapter.ts
git -C "$WT" commit -m "feat(channels): add channel registry HTTP routes"
```

---

## Task 11: Startup wiring in `index.ts`

Construct the repo + service, reconcile, gate adapter construction on enabled state, and pass the service to the HTTP adapter. **This task has no new unit test** — it's integration glue; verify by booting the app and by the existing startup tests. Make the smallest edits that wire the pieces.

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Read the adapter-construction region**

Open `src/index.ts` and locate:
- the email adapter construction loop (~lines 1251–1277),
- the signal adapter construction (~lines 1281–1291),
- the CLI start (~lines 2016–2022),
- where `secretsService`, `resolvedEmailAccounts`, `nylasClientMap`, `signalRpcClient`, `config.signalPhoneNumber`, and the DB `pool` are already in scope (all before line 1251).

- [ ] **Step 2: Insert the channel-registry setup block before adapter construction**

Immediately **before** the email construction loop (~line 1251), insert:

```typescript
  // ── Channel registry ───────────────────────────────────────────────────────
  // Decide which channels start, from DB lifecycle state + resolvable credentials.
  // Credentials resolve vault-first, then env, then config (multi-account email).
  const channelRegistryRepo = new ChannelRegistryRepo(pool);

  // Config-satisfied keys per channel (the messy, config-shape-aware part lives here,
  // keeping the resolver pure). Email is satisfied via config when ≥1 account resolved.
  const channelConfigKeys = (descriptor: ChannelDescriptor): Set<string> => {
    if (descriptor.name === 'email' && resolvedEmailAccounts.length > 0) {
      return new Set(['nylas_api_key', 'nylas_grant_id', 'nylas_self_email']);
    }
    return new Set<string>();
  };

  const channelCredentialStatusFn = (descriptor: ChannelDescriptor) =>
    channelCredentialStatus(
      { secrets: secretsService, configResolvedKeys: channelConfigKeys(descriptor) },
      descriptor,
    );

  try {
    await reconcileChannelRegistry({
      repo: channelRegistryRepo,
      catalog: CHANNEL_CATALOG,
      credentialStatus: channelCredentialStatusFn,
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'Channel registry reconciliation failed');
    process.exit(1);
  }

  // Compute the set of channels that should actually start this boot: enabled in the DB
  // AND credentials currently resolvable. Non-toggleable channels (http/cli) always start.
  const channelRows = await channelRegistryRepo.listRows();
  const enabledByName = new Map(channelRows.map(r => [r.name, r.enabled]));
  const channelShouldStart = new Set<string>();
  for (const descriptor of CHANNEL_CATALOG) {
    if (!descriptor.isToggleable) { channelShouldStart.add(descriptor.name); continue; }
    if (!enabledByName.get(descriptor.name)) continue;
    const status = await channelCredentialStatusFn(descriptor);
    if (status.requiredResolvable) {
      channelShouldStart.add(descriptor.name);
    } else {
      // Enabled but credentials no longer resolve: warn and skip — never crash (spec §7).
      logger.warn({ channel: descriptor.name }, 'channel enabled but required credentials missing; not starting');
    }
  }

  // Service backing /api/registry/channels/* (delete wired for uninstall vault cleanup).
  const channelRegistryService = new ChannelRegistryService(
    channelRegistryRepo,
    CHANNEL_CATALOG,
    channelCredentialStatusFn,
    secretsService,
  );
  // ───────────────────────────────────────────────────────────────────────────
```

Add the imports at the top of `index.ts`:

```typescript
import { CHANNEL_CATALOG, type ChannelDescriptor } from './channels/catalog.js';
import { channelCredentialStatus } from './channels/credential-resolver.js';
import { ChannelRegistryRepo } from './registry/channel-registry-repo.js';
import { ChannelRegistryService } from './registry/channel-registry-service.js';
import { reconcileChannelRegistry } from './registry/channel-reconcile.js';
```

- [ ] **Step 3: Gate email construction on `channelShouldStart`**

In the email construction loop, add the gate. Change the loop guard:

```typescript
  if (outboundGateway && channelShouldStart.has('email')) {
    for (const account of resolvedEmailAccounts) {
      // ...unchanged body...
    }
  }
```

- [ ] **Step 4: Gate signal construction on `channelShouldStart`**

```typescript
  if (outboundGateway && signalRpcClient && config.signalPhoneNumber && channelShouldStart.has('signal')) {
    signalAdapter = new SignalAdapter({ /* ...unchanged... */ });
  }
```

(CLI and HTTP are non-toggleable and always in `channelShouldStart`; leave their existing construction/start untouched.)

- [ ] **Step 5: Pass `channelRegistryService` to the HTTP adapter config**

Find where `new HttpAdapter({ ... })` is constructed and add `channelRegistryService,` to its config object (alongside the existing `registryService` / `secretsService` fields).

- [ ] **Step 6: Typecheck**

Run: `pnpm --prefix "$WT" run typecheck`
Expected: PASS.

- [ ] **Step 7: Boot smoke test**

Start the app once against the dev DB (use the project's dev run command, e.g. `pnpm --prefix "$WT" run dev`), watching `curia.log`/stdout. Confirm:
- migration 052 applies,
- a `channel registry: enrolled ...` line appears for http/cli (and email/signal if their creds resolve),
- the process does not crash if a toggleable channel lacks credentials (warning, not fatal).
Stop the app.

- [ ] **Step 8: Run the broader test suite for regressions**

Run: `pnpm --prefix "$WT" test src/`
Expected: PASS (investigate any startup-related test that asserts adapters always construct — update it to seed/enable the channel or assert the new gated behavior).

- [ ] **Step 9: Commit**

```bash
git -C "$WT" add src/index.ts
git -C "$WT" commit -m "feat(channels): gate adapter startup on the channel registry"
```

---

## Task 12: Console — Channels page

A page mirroring `RegistrySettings.tsx`: list of channels with state pills + a drawer with a credential form (fields from `credentialFields`) and Install/Enable/Disable/Uninstall actions. Toggle/actions locked for non-toggleable channels.

**Files:**
- Create: `apps/console/src/pages/ChannelSettings.tsx`

> Read `apps/console/src/pages/RegistrySettings.tsx` in full first and reuse its layout primitives (the page shell, drawer, state-pill styles, `apiFetch`, `errorMessage`). The component below is the channel-specific core; wrap it in the same page chrome RegistrySettings uses so styling is consistent.

- [ ] **Step 1: Implement the page**

```tsx
// apps/console/src/pages/ChannelSettings.tsx
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

interface CredentialFieldStatus {
  key: string; label: string; secret: boolean; configured: boolean;
  source: 'vault' | 'env' | 'config' | 'missing';
}
interface ChannelEntry {
  name: string; description: string;
  state: 'uninstalled' | 'installed' | 'enabled';
  isToggleable: boolean;
  credentialFields: CredentialFieldStatus[];
  requiredResolvable: boolean;
}

const STATE_LABEL: Record<ChannelEntry['state'], string> = {
  uninstalled: 'Not installed', installed: 'Installed (disabled)', enabled: 'Enabled',
};

export function ChannelsPage() {
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [selected, setSelected] = useState<ChannelEntry | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/registry/channels');
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = await res.json() as { channels: ChannelEntry[] };
      setEntries(data.channels);
      setLoadError(null);
      setSelected(prev => prev ? data.channels.find(c => c.name === prev.name) ?? null : null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (method: 'POST' | 'DELETE', path: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/registry/channels/${selected.name}${path}`, { method });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [selected, load]);

  // Save a credential to the vault under channel.<name>.<key>, then reload status.
  const saveCredential = useCallback(async (channel: string, key: string, value: string) => {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/vault/secrets/channel.${channel}.${key}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setDraft(d => ({ ...d, [key]: '' }));
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <div className="registry-page">
      <h1>Channels</h1>
      {loadError && <div className="error-banner">{loadError}</div>}
      <ul className="registry-list">
        {entries.map(e => (
          <li key={e.name}>
            <button className={`registry-row${selected?.name === e.name ? ' active' : ''}`} onClick={() => setSelected(e)}>
              <span className="registry-name">{e.name}</span>
              <span className={`state-pill state-${e.state}`}>{STATE_LABEL[e.state]}</span>
              {!e.isToggleable && <span className="state-pill state-locked">Always on</span>}
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <aside className="registry-drawer">
          <h2>{selected.name}</h2>
          <p>{selected.description}</p>
          <p className="muted">State: {STATE_LABEL[selected.state]}{!selected.isToggleable && ' (cannot be disabled)'}</p>

          {/* Credential form — only for toggleable channels with fields */}
          {selected.isToggleable && selected.credentialFields.length > 0 && (
            <div className="credential-form">
              <h3>Credentials</h3>
              {selected.credentialFields.map(f => (
                <div key={f.key} className="credential-field">
                  <label>{f.label}</label>
                  <span className={`source-pill source-${f.source}`}>
                    {f.configured ? `configured (${f.source})` : 'missing'}
                  </span>
                  <div className="credential-entry">
                    <input
                      type={f.secret ? 'password' : 'text'}
                      value={draft[f.key] ?? ''}
                      placeholder={f.configured ? '•••• (set — enter to replace)' : 'enter value'}
                      onChange={ev => setDraft(d => ({ ...d, [f.key]: ev.target.value }))}
                    />
                    <button className="btn btn-sm" disabled={busy || !(draft[f.key]?.length)} onClick={() => void saveCredential(selected.name, f.key, draft[f.key]!)}>
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Lifecycle actions — hidden entirely for non-toggleable channels */}
          {selected.isToggleable && (
            <div className="registry-actions">
              {selected.state === 'uninstalled' && (
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('POST', '/install')}>Install</button>
              )}
              {selected.state === 'installed' && (
                <button className="btn btn-primary btn-sm" disabled={busy || !selected.requiredResolvable}
                        title={selected.requiredResolvable ? '' : 'Configure required credentials first'}
                        onClick={() => void act('POST', '/enable')}>Enable</button>
              )}
              {selected.state === 'enabled' && (
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act('POST', '/disable')}>Disable</button>
              )}
              {selected.state !== 'uninstalled' && (
                <button className="btn btn-danger btn-sm" disabled={busy}
                        onClick={() => { if (confirm(`Uninstall ${selected.name}? This clears its stored credentials.`)) void act('DELETE', ''); }}>
                  Uninstall
                </button>
              )}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
```

> Fix-ups while implementing: reuse RegistrySettings' actual class names if they differ from the ones above so the styling matches. The important contract is the API calls and the locked behavior for non-toggleable channels (no actions, no credential form). Required-field marking is intentionally omitted — the Enable button already enforces resolvability.

- [ ] **Step 2: Typecheck the console app**

Run: `pnpm --prefix "$WT/apps/console" run typecheck` (or the console's typecheck script; check `apps/console/package.json`).
Expected: PASS after you resolve the `requiredHint` placeholder.

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add apps/console/src/pages/ChannelSettings.tsx
git -C "$WT" commit -m "feat(console): add Channels management page"
```

---

## Task 13: Console — nav + route

**Files:**
- Modify: `apps/console/src/router.tsx`
- Modify: `apps/console/src/components/Sidebar.tsx`

- [ ] **Step 1: Add the route**

In `apps/console/src/router.tsx`, mirror the skills/agents routes (around lines 151–161 and the route tree at 173–187):

```tsx
import { ChannelsPage } from './pages/ChannelSettings.js'; // add with the other page imports

const channelsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/channels',
  component: ChannelsPage,
});
```

Add `channelsRoute` to the `authedRoute.addChildren([...])` array next to `skillsRoute, agentsRoute`.

- [ ] **Step 2: Add the sidebar entry**

In `apps/console/src/components/Sidebar.tsx`, add a nav-sub-item in the Settings group next to Skills/Agents (around lines 176–189). Use any existing icon import (e.g. reuse one already imported, or `IconWand`):

```tsx
              <button
                className={`nav-sub-item${activeView === 'channels' ? ' active' : ''}`}
                onClick={() => go('channels')}
              >
                <IconWand />
                Channels
              </button>
```

Ensure `'channels'` is a valid value for whatever `activeView`/`go()` typing the sidebar uses (check the `ROUTES`/view-name union near the top of `Sidebar.tsx` and add `channels: '/channels'` if a `ROUTES` map exists).

- [ ] **Step 3: Typecheck + build the console**

Run: `pnpm --prefix "$WT/apps/console" run typecheck`
Run: `pnpm --prefix "$WT/apps/console" run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run the console dev server + backend, log in, open Settings → Channels. Confirm: list shows all four channels; http/cli show "Always on" with no actions; signal/email show credential fields with source pills; entering a credential + Save persists and the source pill flips to "configured (vault)"; Enable is disabled until required creds resolve.

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add apps/console/src/router.tsx apps/console/src/components/Sidebar.tsx
git -C "$WT" commit -m "feat(console): add Channels nav entry and route"
```

---

## Task 14: Docs — CHANGELOG, config comment, CLAUDE.md

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `config/default.yaml` (doc comment only)
- Modify: `CLAUDE.md` ("New Channel Adapter" section)

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]` → `### Added`:

```markdown
- **Channel registry** — database-backed install/enable lifecycle for channels with credentials in the secrets vault (vault-first, env/config fallback); new `Channel` interface, `Channels` console page, and always-on HTTP/CLI safeguard. (#543)
```

- [ ] **Step 2: config/default.yaml comment**

Add a short comment above `channel_accounts.email` noting credentials may now also be supplied via the vault (`channel.email.*`) and managed in the console; the config path remains supported for multi-account setups.

- [ ] **Step 3: CLAUDE.md — update "New Channel Adapter"**

Update step 1 of "Adding Things → New Channel Adapter" to reference the now-real interface: "Create `src/channels/<name>/` implementing the `Channel` interface from `src/channels/channel.ts` (`name`, `isToggleable`, `start()`, `stop()`)", and add a step: "Add a `ChannelDescriptor` to `src/channels/catalog.ts` (credential fields + required secret keys)."

- [ ] **Step 4: Typecheck (sanity) + commit**

```bash
git -C "$WT" add CHANGELOG.md config/default.yaml CLAUDE.md
git -C "$WT" commit -m "docs: document channel registry (changelog, config, CLAUDE.md)"
```

---

## Final verification (before PR)

- [ ] Full typecheck: `pnpm --prefix "$WT" run typecheck` → PASS
- [ ] Backend tests: `pnpm --prefix "$WT" test src/ tests/` → PASS (integration tests need `DATABASE_URL`)
- [ ] Console typecheck + build: `pnpm --prefix "$WT/apps/console" run typecheck` and `run build` → PASS
- [ ] Migration prefix still unique: `ls "$WT/src/db/migrations" | sort` → no duplicate `052_`
- [ ] Boot smoke test passes (Task 11 Step 7): http/cli enrolled, no crash on missing channel creds
- [ ] Run the auto-review subagents (code-reviewer + silent-failure-hunter) per global workflow; address high-priority findings
- [ ] PR body includes `Closes #543` and references follow-up #962

---

## Self-review notes (author)

- **Spec coverage:** every acceptance criterion in the design maps to a task — table (T5), interface (T1/T3), startup gating + always-on http/cli (T9/T11), vault naming + resolution (T2/T4), missing-cred warning-not-crash (T9/T11), console list + drawer + form (T12/T13), static install via form→vault (T12), uninstall clears vault + row (T8/T12). OAuth and policy are explicitly out of scope (#962).
- **Type consistency:** `channelCredentialStatus` / `ChannelCredentialStatus` / `CredentialStatusFn` / `ChannelRegistryEntry` / `ChannelGuardError` names are used identically across Tasks 4, 6, 8, 9, 11. Repo method `install(name, actor, isToggleable)` signature is consistent in the interface (T6), impl (T7), service calls (T8), and reconcile (T9).
- **Known soft spots (flagged inline for the implementer):** EmailAdapter `stop()` timer-field name (T3c); exact auth helper exports for routes (T10); `DbPool` import path (T7); `requiredHint` placeholder + class names in the console page (T12). Each is called out at its step.

---

## Discovered during implementation

Issues found by code review that the plan did not anticipate, and how they were resolved:

- **Vault write scope guard rejected channel keys (gap in T10/T12).** The console saves credentials via `PUT /api/vault/secrets/:name`, but that route's existing scope guard (`registryService.declaredSecretNames()`, from #939) only permits *skill*-declared secret names. Channel keys (`channel.<name>.<key>`) are not skill-declared, so a real save would have returned 400 and the credential-install acceptance criterion would not have worked end to end. **Resolved** by an added unit ("Unit V"): widened the guard in `src/channels/http/routes/vault.ts` to also accept exact channel credential keys derived from `CHANNEL_CATALOG` (skill-declared **or** known-channel-key), preserving the "no arbitrary `channel.*` writes" protection, with a new `vault.test.ts` proving both accept and reject paths. Commit `8dd8dd7f`.
- **Plan's `disable()` SQL bound an extra parameter (T7).** The plan's repo `disable` bound `[name, actor]` for a `$1`-only query, which throws at runtime. Fixed to bind `[name]` (param kept as `_actor` for interface symmetry), matching the sibling `registry-repo.ts`.
- **`DbPool` import path (T7).** The real export is `../db/connection.js`, not the plan's guessed `../db/pool.js`.
- **Auth helpers for routes (T10).** The real auth primitive is `assertSecret` from `../session-auth.js` (wrapped in a local `requireAuth` closure), and `AUTH_RATE` is a local const — not importable from `registry.ts` as the plan sketch assumed.
- **Console page patterns (T12).** RegistrySettings uses concrete class names (`records-layout`, `status-pill`, `drawer-footer`, etc.) and a `SecretRow`-style subcomponent; the plan's placeholder class names were replaced with the real ones.
- **EmailAdapter/HTTP `stop()` already existed (T3).** Both adapters already had working `stop()` implementations; only the `Channel` interface members (`name`, `isToggleable`) needed adding.
```
