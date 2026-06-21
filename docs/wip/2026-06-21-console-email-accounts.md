# Console-managed email accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage one or many agent-owned email mailboxes entirely from the console, with per-account Nylas grants in the encrypted vault, and retire the YAML `channel_accounts` path.

**Architecture:** A new `email_accounts` table holds provider-agnostic account identity (name, self_email, provider, enabled). Each account's Nylas grant lives in the vault at `channel.email.<name>.nylas_grant_id`; the shared `nylas_api_key` is unchanged. A rewritten async `resolveChannelAccounts()` reads the table + vault instead of YAML/env. A one-time idempotent boot backfill seeds the existing single account from vault-overlaid config so the live deployment cuts over with no polling gap. Self-suppression is auto-derived from the union of all accounts' `self_email`. Console CRUD lives under the existing email channel.

**Tech Stack:** TypeScript (ESM, Node 24+), Fastify (HTTP), PostgreSQL 16 + node-pg-migrate, React 19 + Vite (console), Vitest.

## Global Constraints

- ESM only — `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`.
- No `any` — proper types / discriminated unions. Cast `Record<string, unknown>` → interface through `unknown` first.
- Parameterized queries only — `$1`/`$2` placeholders + param array; never interpolate into SQL.
- Strict null checks: `array[0]` is `T | undefined` — use `array[0]!` when guaranteed, or guard.
- pino logging only — no `console.log`. Levels: error/warn/info/debug. Never log secret values.
- No empty `catch {}` — every catch logs and handles.
- Typecheck via `pnpm -C <worktree> run typecheck` (not bare `tsc`) before every commit touching `.ts`.
- Migrations: plain SQL, `-- Up Migration` / `-- Down Migration` headers, both directions. Verify the numeric prefix is unique (`ls src/db/migrations/ | sort`) before committing — current max is `062`, this plan uses `063`.
- Integration tests use real Postgres (Docker), run in CI. Raw-SQL migrations only fail in CI, so treat CI as the gate.
- Every PR updates `CHANGELOG.md` under `## [Unreleased]`. Do not bump the version number.
- Vault-key convention (single source of truth): `channel.email.<name>.nylas_grant_id`. Account `name` is constrained to `^[a-z0-9][a-z0-9_-]*$` (no dots — names appear inside the dotted vault key).
- Worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts`, branch `feat/console-email-accounts`. All `git`/`pnpm` use `-C <worktree>`.

---

### Task 1: Migration — `email_accounts` table

**Files:**
- Create: `src/db/migrations/063_create_email_accounts.sql`

**Interfaces:**
- Produces: table `email_accounts (name PK, self_email, provider, enabled, created_at, created_by, updated_at)`.

- [ ] **Step 1: Verify the next migration number is free**

Run: `ls src/db/migrations/ | sort | tail -3`
Expected: highest prefix is `062_*`; `063` is unused. If `063` is taken, use the next free number and update all references in this plan.

- [ ] **Step 2: Write the migration**

Create `src/db/migrations/063_create_email_accounts.sql`:

```sql
-- Up Migration
--
-- Issue #1101: email_accounts — console-managed, provider-agnostic email mailboxes.
--
-- Replaces the YAML channel_accounts.email path. Each row is a mailbox the agent owns,
-- polls, and replies from. The row holds only the non-secret identity of the account;
-- the Nylas grant is sensitive and lives in the secrets vault at
-- channel.email.<name>.nylas_grant_id (ADR-020), not here. The shared nylas_api_key is
-- one-per-Nylas-app and stays at channel.email.nylas_api_key.
--
-- provider is the transport discriminator ('nylas' today). It is the seam for future
-- IMAP/other providers — adding one is a new provider value + adapter + vault-key
-- convention, with no change to this table.

CREATE TABLE email_accounts (
  -- Logical account id. Stamped onto inbound.message as accountId for reply routing,
  -- and used as the poll high-water-mark key (<name>.last_seen_at). Constrained to
  -- [a-z0-9][a-z0-9_-]* at the application layer because it is embedded in the dotted
  -- vault key channel.email.<name>.nylas_grant_id.
  name        TEXT        PRIMARY KEY,
  self_email  TEXT        NOT NULL,
  provider    TEXT        NOT NULL DEFAULT 'nylas',
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT        NOT NULL DEFAULT 'web-console',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS email_accounts;
```

- [ ] **Step 3: Run migrations to verify the SQL applies**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run migrate` (or the repo's migrate script — check `package.json` scripts; common name is `migrate` / `db:migrate`).
Expected: migration `063_create_email_accounts` applies cleanly (requires local Postgres; if unavailable locally, rely on CI per Global Constraints).

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/db/migrations/063_create_email_accounts.sql
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: add email_accounts table (#1101)"
```

---

### Task 2: Per-account vault-key helper

**Files:**
- Create: `src/channels/email/email-account-secrets.ts`
- Test: `src/channels/email/email-account-secrets.test.ts`

**Interfaces:**
- Produces:
  - `emailAccountGrantSecretName(name: string): string` → `channel.email.<name>.nylas_grant_id`
  - `isPerAccountEmailGrantKey(name: string): boolean` → true iff matches `^channel\.email\.[^.]+\.nylas_grant_id$`
  - `EMAIL_ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/` and `isValidEmailAccountName(name: string): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/channels/email/email-account-secrets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  emailAccountGrantSecretName,
  isPerAccountEmailGrantKey,
  isValidEmailAccountName,
} from './email-account-secrets.js';

describe('email-account-secrets', () => {
  it('builds the per-account grant vault key', () => {
    expect(emailAccountGrantSecretName('curia')).toBe('channel.email.curia.nylas_grant_id');
  });

  it('recognizes per-account grant keys', () => {
    expect(isPerAccountEmailGrantKey('channel.email.curia.nylas_grant_id')).toBe(true);
    expect(isPerAccountEmailGrantKey('channel.email.sales-eu.nylas_grant_id')).toBe(true);
  });

  it('rejects the shared/single-account and unrelated keys', () => {
    expect(isPerAccountEmailGrantKey('channel.email.nylas_grant_id')).toBe(false);
    expect(isPerAccountEmailGrantKey('channel.email.nylas_api_key')).toBe(false);
    expect(isPerAccountEmailGrantKey('channel.email.curia.nylas_api_key')).toBe(false);
    expect(isPerAccountEmailGrantKey('channel.email.a.b.nylas_grant_id')).toBe(false);
    expect(isPerAccountEmailGrantKey('user.foo')).toBe(false);
  });

  it('validates account names', () => {
    expect(isValidEmailAccountName('curia')).toBe(true);
    expect(isValidEmailAccountName('sales-eu_2')).toBe(true);
    expect(isValidEmailAccountName('Curia')).toBe(false);   // uppercase
    expect(isValidEmailAccountName('a.b')).toBe(false);      // dot
    expect(isValidEmailAccountName('-lead')).toBe(false);    // leading dash
    expect(isValidEmailAccountName('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/email-account-secrets.test.ts`
Expected: FAIL — cannot find module `./email-account-secrets.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/channels/email/email-account-secrets.ts`:

```typescript
// Single source of truth for the per-account email-grant vault-key convention.
// The grant for account <name> is stored encrypted at channel.email.<name>.nylas_grant_id.
// Imported by the resolver, the backfill, the console route, and the vault scope-guard so
// the convention is defined exactly once.

/**
 * Account names are embedded in the dotted vault key channel.email.<name>.nylas_grant_id,
 * so they must not contain dots (which would make the key ambiguous) and are kept to a
 * conservative lowercase slug charset.
 */
export const EMAIL_ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidEmailAccountName(name: string): boolean {
  return EMAIL_ACCOUNT_NAME_RE.test(name);
}

export function emailAccountGrantSecretName(name: string): string {
  return `channel.email.${name}.nylas_grant_id`;
}

const PER_ACCOUNT_GRANT_KEY_RE = /^channel\.email\.[^.]+\.nylas_grant_id$/;

export function isPerAccountEmailGrantKey(name: string): boolean {
  return PER_ACCOUNT_GRANT_KEY_RE.test(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/email-account-secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/channels/email/email-account-secrets.ts src/channels/email/email-account-secrets.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: per-account email grant vault-key helper (#1101)"
```

---

### Task 3: `EmailAccountsRepo`

**Files:**
- Create: `src/channels/email/email-accounts-repo.ts`
- Test: `tests/integration/email-accounts-repo.test.ts` (real Postgres)

**Interfaces:**
- Consumes: `DbPool` from `src/db/connection.js`.
- Produces:
  - `interface EmailAccountRow { name: string; selfEmail: string; provider: string; enabled: boolean; createdAt: Date; createdBy: string; updatedAt: Date }`
  - `class EmailAccountsRepo { constructor(pool: DbPool); list(): Promise<EmailAccountRow[]>; get(name): Promise<EmailAccountRow | null>; count(): Promise<number>; create(input: { name; selfEmail; provider?; enabled?; createdBy? }): Promise<EmailAccountRow>; update(name, patch: { selfEmail?; enabled? }): Promise<EmailAccountRow | null>; delete(name): Promise<boolean> }`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/email-accounts-repo.test.ts`. Follow the existing integration-test harness in `tests/integration/` for obtaining a `DbPool` against the test database (mirror a sibling repo test, e.g. how `channel_registry` or another repo integration test sets up/tears down its pool). The assertions:

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { EmailAccountsRepo } from '../../src/channels/email/email-accounts-repo.js';
// import { getTestPool } from the existing integration harness used by sibling tests.

describe('EmailAccountsRepo (integration)', () => {
  const pool = getTestPool();
  const repo = new EmailAccountsRepo(pool);

  beforeEach(async () => { await pool.query('DELETE FROM email_accounts'); });
  afterAll(async () => { await pool.query('DELETE FROM email_accounts'); });

  it('starts empty', async () => {
    expect(await repo.count()).toBe(0);
    expect(await repo.list()).toEqual([]);
  });

  it('creates and reads back an account with defaults', async () => {
    const row = await repo.create({ name: 'curia', selfEmail: 'curia@example.com' });
    expect(row.name).toBe('curia');
    expect(row.selfEmail).toBe('curia@example.com');
    expect(row.provider).toBe('nylas');
    expect(row.enabled).toBe(true);
    expect(row.createdBy).toBe('web-console');
    expect(await repo.count()).toBe(1);
    expect((await repo.get('curia'))?.selfEmail).toBe('curia@example.com');
  });

  it('updates self_email and enabled', async () => {
    await repo.create({ name: 'curia', selfEmail: 'a@example.com' });
    const updated = await repo.update('curia', { selfEmail: 'b@example.com', enabled: false });
    expect(updated?.selfEmail).toBe('b@example.com');
    expect(updated?.enabled).toBe(false);
  });

  it('update of a missing row returns null', async () => {
    expect(await repo.update('nope', { enabled: false })).toBeNull();
  });

  it('deletes', async () => {
    await repo.create({ name: 'curia', selfEmail: 'a@example.com' });
    expect(await repo.delete('curia')).toBe(true);
    expect(await repo.delete('curia')).toBe(false);
    expect(await repo.count()).toBe(0);
  });

  it('list returns rows ordered by name', async () => {
    await repo.create({ name: 'beta', selfEmail: 'b@example.com' });
    await repo.create({ name: 'alpha', selfEmail: 'a@example.com' });
    expect((await repo.list()).map(r => r.name)).toEqual(['alpha', 'beta']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run tests/integration/email-accounts-repo.test.ts`
Expected: FAIL — cannot find module `email-accounts-repo.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/channels/email/email-accounts-repo.ts`:

```typescript
import type { DbPool } from '../../db/connection.js';

export interface EmailAccountRow {
  name: string;
  selfEmail: string;
  provider: string;
  enabled: boolean;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
}

interface DbEmailAccount {
  name: string;
  self_email: string;
  provider: string;
  enabled: boolean;
  created_at: Date;
  created_by: string;
  updated_at: Date;
}

const COLS = 'name, self_email, provider, enabled, created_at, created_by, updated_at';

function mapRow(r: DbEmailAccount): EmailAccountRow {
  return {
    name: r.name,
    selfEmail: r.self_email,
    provider: r.provider,
    enabled: r.enabled,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };
}

export interface CreateEmailAccountInput {
  name: string;
  selfEmail: string;
  provider?: string;
  enabled?: boolean;
  createdBy?: string;
}

export class EmailAccountsRepo {
  constructor(private readonly pool: DbPool) {}

  async list(): Promise<EmailAccountRow[]> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `SELECT ${COLS} FROM email_accounts ORDER BY name ASC`,
    );
    return rows.map(mapRow);
  }

  async get(name: string): Promise<EmailAccountRow | null> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `SELECT ${COLS} FROM email_accounts WHERE name = $1`,
      [name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      'SELECT count(*)::int AS count FROM email_accounts',
    );
    return rows[0] ? Number(rows[0].count) : 0;
  }

  async create(input: CreateEmailAccountInput): Promise<EmailAccountRow> {
    const { rows } = await this.pool.query<DbEmailAccount>(
      `INSERT INTO email_accounts (name, self_email, provider, enabled, created_by)
       VALUES ($1, $2, COALESCE($3, 'nylas'), COALESCE($4, true), COALESCE($5, 'web-console'))
       RETURNING ${COLS}`,
      [input.name, input.selfEmail, input.provider ?? null, input.enabled ?? null, input.createdBy ?? null],
    );
    if (!rows[0]) throw new Error(`create: insert returned no row for email account '${input.name}'`);
    return mapRow(rows[0]);
  }

  async update(name: string, patch: { selfEmail?: string; enabled?: boolean }): Promise<EmailAccountRow | null> {
    // COALESCE keeps the existing value when a patch field is undefined (passed as null).
    const { rows } = await this.pool.query<DbEmailAccount>(
      `UPDATE email_accounts
          SET self_email = COALESCE($2, self_email),
              enabled    = COALESCE($3, enabled),
              updated_at = now()
        WHERE name = $1
        RETURNING ${COLS}`,
      [name, patch.selfEmail ?? null, patch.enabled ?? null],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async delete(name: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM email_accounts WHERE name = $1', [name]);
    return (res.rowCount ?? 0) > 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run tests/integration/email-accounts-repo.test.ts`
Expected: PASS (requires Postgres; otherwise rely on CI).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/channels/email/email-accounts-repo.ts tests/integration/email-accounts-repo.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: EmailAccountsRepo CRUD over email_accounts (#1101)"
```

---

### Task 4: Rewrite the resolver (table + vault), drop `excludedSenderEmails`

Moves the resolver out of `config.ts` (which should not depend on DB/vault) into a focused module, makes it async, and reads the table + per-account vault grant. Also narrows `ResolvedEmailAccount`.

**Files:**
- Create: `src/channels/email/resolve-email-accounts.ts`
- Test: `src/channels/email/resolve-email-accounts.test.ts`
- Modify: `src/config.ts` — narrow `ResolvedEmailAccount` (drop `excludedSenderEmails`); remove the old `resolveChannelAccounts` function, `RawEmailAccountConfig`, the `channel_accounts` validation block, and (if now unused) `resolveEnvValue`. Keep `channel_accounts?` as a loosely-typed detection-only field on `YamlConfig` (see Task 6 backfill).

**Interfaces:**
- Consumes: `EmailAccountsRepo` (Task 3), `SecretsService` (`get(name): Promise<string | null>`), `emailAccountGrantSecretName` (Task 2), `ResolvedEmailAccount` from `config.js`.
- Produces: `resolveEmailAccounts(repo: EmailAccountsRepo, secrets: { get(name: string): Promise<string | null> }, logger: Logger): Promise<ResolvedEmailAccount[]>` where `ResolvedEmailAccount = { name: string; nylasGrantId: string; selfEmail: string }`.

- [ ] **Step 1: Narrow `ResolvedEmailAccount` in `config.ts`**

In `src/config.ts`, change the interface (lines 27-34) to drop `excludedSenderEmails`:

```typescript
/**
 * Fully resolved per-account email config. Account identity comes from the
 * email_accounts table; the grant is read from the vault. (#1101)
 */
export interface ResolvedEmailAccount {
  /** Logical account name (e.g. "curia"). */
  name: string;
  nylasGrantId: string;
  selfEmail: string;
}
```

- [ ] **Step 2: Write the failing test for the new resolver**

Create `src/channels/email/resolve-email-accounts.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveEmailAccounts } from './resolve-email-accounts.js';
import type { EmailAccountsRepo, EmailAccountRow } from './email-accounts-repo.js';

function row(over: Partial<EmailAccountRow>): EmailAccountRow {
  return {
    name: 'curia', selfEmail: 'curia@example.com', provider: 'nylas', enabled: true,
    createdAt: new Date(0), createdBy: 'web-console', updatedAt: new Date(0), ...over,
  };
}

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

function fakeRepo(rows: EmailAccountRow[]): EmailAccountsRepo {
  return { list: async () => rows } as unknown as EmailAccountsRepo;
}

describe('resolveEmailAccounts', () => {
  it('resolves each enabled account from the table + per-account vault grant', async () => {
    const repo = fakeRepo([row({ name: 'curia', selfEmail: 'c@x.com' }), row({ name: 'sales', selfEmail: 's@x.com' })]);
    const secrets = { get: async (n: string) =>
      n === 'channel.email.curia.nylas_grant_id' ? 'grant-c'
      : n === 'channel.email.sales.nylas_grant_id' ? 'grant-s' : null };
    const result = await resolveEmailAccounts(repo, secrets, logger);
    expect(result).toEqual([
      { name: 'curia', nylasGrantId: 'grant-c', selfEmail: 'c@x.com' },
      { name: 'sales', nylasGrantId: 'grant-s', selfEmail: 's@x.com' },
    ]);
  });

  it('excludes disabled accounts', async () => {
    const repo = fakeRepo([row({ name: 'curia' }), row({ name: 'off', enabled: false })]);
    const secrets = { get: async () => 'grant' };
    const result = await resolveEmailAccounts(repo, secrets, logger);
    expect(result.map(a => a.name)).toEqual(['curia']);
  });

  it('skips an account whose grant is missing, with a warning, and continues', async () => {
    const repo = fakeRepo([row({ name: 'curia', selfEmail: 'c@x.com' }), row({ name: 'sales' })]);
    const secrets = { get: async (n: string) =>
      n === 'channel.email.curia.nylas_grant_id' ? 'grant-c' : null };
    const warn = vi.fn();
    const result = await resolveEmailAccounts(repo, { get: secrets.get }, { ...logger, warn } as never);
    expect(result.map(a => a.name)).toEqual(['curia']);
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/resolve-email-accounts.test.ts`
Expected: FAIL — cannot find module `./resolve-email-accounts.js`.

- [ ] **Step 4: Write the resolver**

Create `src/channels/email/resolve-email-accounts.ts`:

```typescript
import type { Logger } from '../../logger.js';
import type { ResolvedEmailAccount } from '../../config.js';
import type { EmailAccountsRepo } from './email-accounts-repo.js';
import { emailAccountGrantSecretName } from './email-account-secrets.js';

/**
 * Resolve the email accounts to bootstrap from the email_accounts table, reading each
 * enabled account's Nylas grant from the vault at channel.email.<name>.nylas_grant_id.
 * (#1101 — replaces the YAML channel_accounts + env path.)
 *
 * Fail-closed per account: an account whose grant is absent is skipped with a warning
 * (never booted grant-less), and the remaining accounts are unaffected. Boot does not abort.
 */
export async function resolveEmailAccounts(
  repo: EmailAccountsRepo,
  secrets: { get(name: string): Promise<string | null> },
  logger: Logger,
): Promise<ResolvedEmailAccount[]> {
  const rows = await repo.list();
  const resolved: ResolvedEmailAccount[] = [];
  for (const acct of rows) {
    if (!acct.enabled) continue;
    const grant = await secrets.get(emailAccountGrantSecretName(acct.name));
    if (!grant) {
      logger.warn(
        { account: acct.name },
        'Email account has no nylas_grant_id in the vault — skipping (re-add the grant in the console)',
      );
      continue;
    }
    resolved.push({ name: acct.name, nylasGrantId: grant, selfEmail: acct.selfEmail });
  }
  return resolved;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/resolve-email-accounts.test.ts`
Expected: PASS.

- [ ] **Step 6: Remove the dead YAML resolver path from `config.ts`**

In `src/config.ts`:
- Delete the `resolveChannelAccounts` function (old lines ~886-929) and `RawEmailAccountConfig` (lines 13-21).
- Delete the `channel_accounts` validation block (lines ~593-624).
- Replace the typed `channel_accounts?` field on `YamlConfig` (lines 126-128) with a detection-only loose type (read solely by the Task 6 backfill to warn; removed when the backfill is removed):

```typescript
  /**
   * @deprecated Removed as a configuration path (#1101). Retained as a loosely-typed
   * field ONLY so the one-time email-accounts backfill can detect a residual block and
   * warn about accounts it cannot auto-migrate. Remove together with the backfill.
   */
  channel_accounts?: { email?: Record<string, unknown> };
```

- Check whether `resolveEnvValue` is referenced anywhere else: `grep -rn "resolveEnvValue" src/ tests/`. If the only references were the deleted resolver + its tests, delete the function (lines ~859-869); otherwise leave it.
- Old resolver tests live in `tests/unit/config.channel-accounts.test.ts` — delete that file (its behavior is replaced by `resolve-email-accounts.test.ts` and the backfill tests).

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts rm tests/unit/config.channel-accounts.test.ts
```

- [ ] **Step 7: Typecheck (expect index.ts errors — fixed in Task 7)**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run typecheck`
Expected: errors ONLY in `src/index.ts` (it still calls the old `resolveChannelAccounts` and references `account.excludedSenderEmails`) and possibly `email-adapter.ts`. Those are fixed in Tasks 5 and 7. No errors in `config.ts` or the new module. If other files reference the removed symbols, note them for Task 7.

- [ ] **Step 8: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add -A
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: resolve email accounts from table+vault; drop YAML channel_accounts resolver (#1101)"
```

---

### Task 5: EmailAdapter self-suppression (rename `excludedSenderEmails` → `suppressedSenderEmails`)

The adapter's suppression list is no longer per-account config; it is the auto-derived union of all owned mailbox addresses, computed in the wiring (Task 7) and passed in. The filter logic is unchanged; only the field name and its doc change.

**Files:**
- Modify: `src/channels/email/email-adapter.ts` (interface line ~71-76; usage lines ~417-429)
- Modify: `src/channels/email/email-adapter.test.ts` (rename the field in any fixtures)

**Interfaces:**
- Produces: `EmailAdapterConfig.suppressedSenderEmails: string[]` replaces `excludedSenderEmails: string[]`.

- [ ] **Step 1: Update the failing test fixtures**

In `src/channels/email/email-adapter.test.ts`, rename every `excludedSenderEmails:` key in adapter-config fixtures to `suppressedSenderEmails:`. If there is a test asserting the exclusion-filter behavior, keep it and confirm it now reads from `suppressedSenderEmails` (the assertion logic is unchanged). If no such test exists, add one:

```typescript
it('suppresses inbound mail from any address in suppressedSenderEmails', async () => {
  // ...construct EmailAdapter with suppressedSenderEmails: ['other@example.com'] and a
  // fake Nylas message from other@example.com; assert it is skipped (skipped.excluded++).
  // Mirror the existing self-email-skip test in this file for harness setup.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/email-adapter.test.ts`
Expected: FAIL — `suppressedSenderEmails` not on `EmailAdapterConfig`.

- [ ] **Step 3: Rename the field in the adapter**

In `src/channels/email/email-adapter.ts`, change the interface field (lines ~71-76):

```typescript
  /**
   * Addresses to suppress on inbound, in addition to this account's own selfEmail.
   * Auto-derived (#1101) from the union of every configured account's self_email, so the
   * agent never replies to a mailbox it owns. Case-insensitive.
   */
  suppressedSenderEmails: string[];
```

And the usage (lines ~417-429): replace `this.config.excludedSenderEmails` with `this.config.suppressedSenderEmails` (the surrounding filter logic and the `skipped.excluded++` counter are unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/email-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/channels/email/email-adapter.ts src/channels/email/email-adapter.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "refactor: EmailAdapter suppressedSenderEmails (auto-derived self-suppression) (#1101)"
```

---

### Task 6: One-time boot backfill

Seeds the existing single account into `email_accounts` + the per-account vault key, from the vault-overlaid `config` values, so the live deployment cuts over with no manual re-entry and no polling gap. Idempotent (empty-table guard). Warns loudly on residual multi-account YAML it cannot migrate.

**Files:**
- Create: `src/channels/email/backfill-email-accounts.ts`
- Test: `src/channels/email/backfill-email-accounts.test.ts`

**Interfaces:**
- Consumes: `EmailAccountsRepo` (`count`, `create`), `SecretsService` (`set`), `emailAccountGrantSecretName`, `Config` (`nylasGrantId`, `nylasSelfEmail`), `YamlConfig` (`channel_accounts.email` detection-only), `Logger`.
- Produces: `backfillEmailAccounts(deps: { repo: EmailAccountsRepo; secrets: { set(name: string, value: string): Promise<void> }; config: Pick<Config, 'nylasGrantId' | 'nylasSelfEmail'>; channelAccountsBlock: Record<string, unknown> | undefined; logger: Logger }): Promise<void>`

Note: at this point in boot (after `applyVaultSecrets` + `applyChannelVaultSecrets`), `config.nylasGrantId` / `config.nylasSelfEmail` already hold the vault-resolved single-account values (#911 seeded them; the overlay applied them). The backfill reads `config`, never `process.env`.

- [ ] **Step 1: Write the failing test**

Create `src/channels/email/backfill-email-accounts.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { backfillEmailAccounts } from './backfill-email-accounts.js';

const baseLogger = () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });

function deps(over: Record<string, unknown> = {}) {
  const created: unknown[] = [];
  const setCalls: Array<[string, string]> = [];
  const logger = baseLogger();
  return {
    created, setCalls, logger,
    arg: {
      repo: {
        count: async () => 0,
        create: async (input: unknown) => { created.push(input); return input; },
      },
      secrets: { set: async (n: string, v: string) => { setCalls.push([n, v]); } },
      config: { nylasGrantId: 'grant-x', nylasSelfEmail: 'curia@example.com' },
      channelAccountsBlock: undefined,
      logger,
      ...over,
    } as never,
  };
}

describe('backfillEmailAccounts', () => {
  it('seeds the curia account + per-account vault grant from config when the table is empty', async () => {
    const d = deps();
    await backfillEmailAccounts(d.arg);
    expect(d.created).toEqual([{ name: 'curia', selfEmail: 'curia@example.com' }]);
    expect(d.setCalls).toEqual([['channel.email.curia.nylas_grant_id', 'grant-x']]);
  });

  it('is a no-op when the table is already populated', async () => {
    const d = deps({ repo: { count: async () => 2, create: vi.fn() } });
    await backfillEmailAccounts(d.arg);
    expect(d.created).toEqual([]);
    expect(d.setCalls).toEqual([]);
  });

  it('does nothing (no row) when there are no legacy single-account creds', async () => {
    const d = deps({ config: { nylasGrantId: undefined, nylasSelfEmail: '' } });
    await backfillEmailAccounts(d.arg);
    expect(d.created).toEqual([]);
  });

  it('warns loudly about residual multi-account YAML it cannot migrate', async () => {
    const d = deps({ channelAccountsBlock: { curia: {}, sales: {}, eu: {} } });
    await backfillEmailAccounts(d.arg);
    // still seeds the single curia account from config
    expect(d.created).toEqual([{ name: 'curia', selfEmail: 'curia@example.com' }]);
    // warns and names the accounts beyond the auto-migrated one
    expect(d.logger.warn).toHaveBeenCalled();
    const msg = JSON.stringify(d.logger.warn.mock.calls);
    expect(msg).toContain('sales');
    expect(msg).toContain('eu');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/backfill-email-accounts.test.ts`
Expected: FAIL — cannot find module `./backfill-email-accounts.js`.

- [ ] **Step 3: Write the backfill**

Create `src/channels/email/backfill-email-accounts.ts`:

```typescript
import type { Logger } from '../../logger.js';
import type { Config } from '../../config.js';
import type { EmailAccountsRepo } from './email-accounts-repo.js';
import { emailAccountGrantSecretName } from './email-account-secrets.js';

/** The account name the legacy single-account deployment is migrated to. */
const LEGACY_ACCOUNT_NAME = 'curia';

export interface BackfillDeps {
  repo: Pick<EmailAccountsRepo, 'count' | 'create'>;
  secrets: { set(name: string, value: string): Promise<void> };
  config: Pick<Config, 'nylasGrantId' | 'nylasSelfEmail'>;
  /**
   * The raw channel_accounts.email block, if any, from YAML — read ONLY to warn about
   * accounts this single-account backfill cannot migrate. Detection-only (#1101).
   */
  channelAccountsBlock: Record<string, unknown> | undefined;
  logger: Logger;
}

/**
 * One-time, idempotent migration from the legacy single-account email config to the
 * email_accounts table. Seeds the existing account (name preserved as "curia" so the poll
 * high-water mark and reply routing survive) and copies its grant to the per-account vault
 * key. Reads vault-overlaid config, never process.env.
 *
 * @TODO Remove this backfill once every deployment has run it (a release or two out, #1101).
 */
export async function backfillEmailAccounts(deps: BackfillDeps): Promise<void> {
  const { repo, secrets, config, channelAccountsBlock, logger } = deps;

  // Idempotent: once the table has any rows, the console is the source of truth.
  if ((await repo.count()) > 0) return;

  // No-silent-miss: a residual multi-account YAML block had grants that were never vaulted
  // and cannot be reconstructed here. Name the ones we cannot migrate.
  if (channelAccountsBlock) {
    const names = Object.keys(channelAccountsBlock);
    const unmigratable = names.filter(n => n !== LEGACY_ACCOUNT_NAME);
    if (unmigratable.length > 0) {
      logger.warn(
        { accounts: unmigratable },
        `channel_accounts.email had ${names.length} accounts; only the legacy single-account ` +
          `creds can be auto-migrated. Re-add these in the console: ${unmigratable.join(', ')}`,
      );
    }
  }

  const grant = config.nylasGrantId;
  const selfEmail = config.nylasSelfEmail;
  if (!grant || !selfEmail) {
    // No legacy email account configured — nothing to migrate (fresh install).
    return;
  }

  await secrets.set(emailAccountGrantSecretName(LEGACY_ACCOUNT_NAME), grant);
  await repo.create({ name: LEGACY_ACCOUNT_NAME, selfEmail });
  logger.info({ account: LEGACY_ACCOUNT_NAME }, 'Backfilled legacy email account into email_accounts');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/email/backfill-email-accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run typecheck
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/channels/email/backfill-email-accounts.ts src/channels/email/backfill-email-accounts.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: one-time backfill of legacy email account into email_accounts (#1101)"
```

---

### Task 7: Wire it into `index.ts`

Replace the YAML resolver call with the new async resolver, run the backfill first, build the repo, and pass the auto-derived suppression union to each adapter.

**Files:**
- Modify: `src/index.ts` (imports; the resolver call site ~706; EmailAdapter block ~1361-1394)

**Interfaces:**
- Consumes: `EmailAccountsRepo`, `resolveEmailAccounts`, `backfillEmailAccounts`. In scope at the call site: `pool`, `secretsService`, `config`, `yamlConfig`, `logger` (confirmed).

- [ ] **Step 1: Update imports in `index.ts`**

Remove `resolveChannelAccounts` from the `./config.js` import. Add:

```typescript
import { EmailAccountsRepo } from './channels/email/email-accounts-repo.js';
import { resolveEmailAccounts } from './channels/email/resolve-email-accounts.js';
import { backfillEmailAccounts } from './channels/email/backfill-email-accounts.js';
```

- [ ] **Step 2: Replace the resolver call site**

Replace line ~706 (`const resolvedEmailAccounts = resolveChannelAccounts(yamlConfig, config);`) with:

```typescript
// Email accounts are managed in the email_accounts table + vault (#1101). Backfill the
// legacy single-account config on first boot (idempotent), then resolve from the table.
const emailAccountsRepo = new EmailAccountsRepo(pool);
await backfillEmailAccounts({
  repo: emailAccountsRepo,
  secrets: secretsService,
  config,
  channelAccountsBlock: yamlConfig.channel_accounts?.email,
  logger,
});
const resolvedEmailAccounts = await resolveEmailAccounts(emailAccountsRepo, secretsService, logger);
```

- [ ] **Step 3: Compute the suppression union and pass it to each adapter**

In the EmailAdapter construction block (lines ~1361-1394), before the `for` loop add:

```typescript
  // Auto-derived self-suppression (#1101): the agent must never act on mail from any
  // mailbox it owns. Union of every resolved account's self_email, passed to all adapters.
  const ownedMailboxAddresses = resolvedEmailAccounts.map(a => a.selfEmail);
```

Then change the adapter options: replace `excludedSenderEmails: account.excludedSenderEmails,` with:

```typescript
      suppressedSenderEmails: ownedMailboxAddresses,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run typecheck`
Expected: PASS (no remaining references to `resolveChannelAccounts`, `excludedSenderEmails`, or `RawEmailAccountConfig`). If anything else referenced the removed symbols, fix those references now.

- [ ] **Step 5: Run the full unit suite**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run test` (or the unit subset)
Expected: green (integration tests needing Postgres may be skipped locally — rely on CI).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: wire email_accounts resolver + backfill into bootstrap (#1101)"
```

---

### Task 8: Extend the vault scope-guard for per-account grant keys

`PUT /api/vault/secrets/:name` currently allows only exact catalog keys. Allow `channel.email.<name>.nylas_grant_id` too (and nothing broader).

**Files:**
- Modify: `src/channels/http/routes/vault.ts` (the `isChannelCredentialKey` guard, used at lines ~105-118)
- Test: the existing `vault` route test file (search `vault.test` / `vault.*.test`), add cases.

**Interfaces:**
- Consumes: `isPerAccountEmailGrantKey` (Task 2).

- [ ] **Step 1: Add failing tests**

In the vault route test file, add cases asserting:

```typescript
it('accepts a per-account email grant key', async () => {
  // PUT /api/vault/secrets/channel.email.curia.nylas_grant_id with a value → 200/ok
});
it('still rejects an undeclared, non-credential key', async () => {
  // PUT /api/vault/secrets/random_key → 400
});
it('rejects a per-account key for a non-grant field', async () => {
  // PUT /api/vault/secrets/channel.email.curia.nylas_api_key → 400 (api_key is shared, not per-account)
});
```

(Mirror the existing vault route test harness for building the Fastify instance and auth.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/http/routes/vault.test.ts` (adjust path to the actual test file)
Expected: FAIL — the per-account key is rejected.

- [ ] **Step 3: Extend the guard**

In `src/channels/http/routes/vault.ts`, import the helper and widen the check (around lines 40 / 105-118):

```typescript
import { isPerAccountEmailGrantKey } from '../../email/email-account-secrets.js';
```

Change the scope-guard condition from:

```typescript
if (!isSkillDeclared && !isChannelCredentialKey(name)) {
```

to:

```typescript
// Per-account email grants (channel.email.<name>.nylas_grant_id) are written by the
// email-accounts console flow (#1101); accept them alongside the static catalog keys.
if (!isSkillDeclared && !isChannelCredentialKey(name) && !isPerAccountEmailGrantKey(name)) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/http/routes/vault.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/channels/http/routes/vault.ts src/channels/http/routes/vault.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: allow per-account email grant keys in vault scope-guard (#1101)"
```

---

### Task 9: Email-accounts route module

CRUD over `email_accounts` + the per-account grant write, mirroring the `channel-registry.ts` route shape and the `identity.ts` dependency-injection pattern.

**Files:**
- Create: `src/channels/http/routes/email-accounts.ts`
- Test: `src/channels/http/routes/email-accounts.test.ts`
- Modify: `src/channels/http/http-adapter.ts` (register the route; add `EmailAccountsRepo` to `HttpAdapterConfig` and construct/inject it)

**Interfaces:**
- Consumes: `EmailAccountsRepo`, `SecretsService` (`set`, `delete`), `assertSecret`/`SessionStore`, `emailAccountGrantSecretName`, `isValidEmailAccountName`, `EMAIL_ACCOUNT_NAME_RE`.
- Produces routes (all under `/api/registry/email-accounts`, so the existing `startsWith('/api/registry')` auth bypass already covers them):
  - `GET /api/registry/email-accounts` → `{ accounts: Array<{ name, selfEmail, provider, enabled, createdAt, createdBy, updatedAt, hasGrant: boolean }> }`
  - `POST /api/registry/email-accounts` body `{ name, selfEmail, provider?, grantId }` → create row + write grant
  - `PATCH /api/registry/email-accounts/:name` body `{ selfEmail?, enabled?, grantId? }` → update row and/or re-write grant
  - `DELETE /api/registry/email-accounts/:name` → delete row + delete grant key

- [ ] **Step 1: Write failing handler tests**

Create `src/channels/http/routes/email-accounts.test.ts`. Mirror the harness in `channel-registry.test.ts` / `vault.test.ts` (build a Fastify app, register the route with a fake repo + fake secrets + a session that authenticates). Assertions:

```typescript
// GET returns accounts with hasGrant derived from secrets.get
// POST with a valid body creates the row (repo.create called) and writes the grant
//   (secrets.set called with channel.email.<name>.nylas_grant_id)
// POST with an invalid name (e.g. 'Bad.Name') → 400, repo.create NOT called
// POST with a duplicate name → 409 (repo.create throws unique-violation; map to 409)
// PATCH updates self_email/enabled; PATCH with grantId re-writes the vault key
// DELETE removes the row and deletes the grant key (secrets.delete called)
// every route returns 401 without a valid session/bootstrap secret
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/http/routes/email-accounts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the route module**

Create `src/channels/http/routes/email-accounts.ts`:

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import type { SessionStore } from '../session-auth.js';
import { assertSecret } from '../session-auth.js';
import { EmailAccountsRepo } from '../../email/email-accounts-repo.js';
import {
  emailAccountGrantSecretName,
  isValidEmailAccountName,
  EMAIL_ACCOUNT_NAME_RE,
} from '../../email/email-account-secrets.js';

const ACTOR = 'web-console';

export interface EmailAccountsRouteOptions {
  pool: Pool;
  secretsService: { get(name: string): Promise<string | null>; set(name: string, value: string): Promise<void>; delete(name: string): Promise<void> };
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function emailAccountsRoutes(
  app: FastifyInstance,
  options: EmailAccountsRouteOptions,
): Promise<void> {
  const { pool, secretsService, webAppBootstrapSecret, sessions } = options;
  const repo = new EmailAccountsRepo(pool);

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  app.get('/api/registry/email-accounts', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const rows = await repo.list();
    const accounts = await Promise.all(rows.map(async r => ({
      name: r.name,
      selfEmail: r.selfEmail,
      provider: r.provider,
      enabled: r.enabled,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      updatedAt: r.updatedAt,
      // Status only — never the grant value.
      hasGrant: (await secretsService.get(emailAccountGrantSecretName(r.name))) !== null,
    })));
    return reply.send({ accounts });
  });

  app.post('/api/registry/email-accounts', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as { name?: unknown; selfEmail?: unknown; provider?: unknown; grantId?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const selfEmail = typeof body.selfEmail === 'string' ? body.selfEmail.trim() : '';
    const grantId = typeof body.grantId === 'string' ? body.grantId.trim() : '';
    const provider = typeof body.provider === 'string' && body.provider ? body.provider : 'nylas';

    if (!isValidEmailAccountName(name)) {
      return reply.status(400).send({ error: `name must match ${EMAIL_ACCOUNT_NAME_RE.source}` });
    }
    if (!selfEmail) return reply.status(400).send({ error: 'selfEmail is required' });
    if (!grantId) return reply.status(400).send({ error: 'grantId is required' });
    if (provider !== 'nylas') return reply.status(400).send({ error: `unsupported provider '${provider}'` });

    if (await repo.get(name)) return reply.status(409).send({ error: `account '${name}' already exists` });

    // Write the grant first; if the row insert fails we have a harmless orphan secret that
    // the next create overwrites, rather than a row with no resolvable grant.
    await secretsService.set(emailAccountGrantSecretName(name), grantId);
    const row = await repo.create({ name, selfEmail, provider, createdBy: ACTOR });
    request.log.info({ account: name }, 'email account created');
    return reply.status(201).send({ account: { ...row, hasGrant: true } });
  });

  app.patch('/api/registry/email-accounts/:name', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };
    const body = (request.body ?? {}) as { selfEmail?: unknown; enabled?: unknown; grantId?: unknown };

    if (!(await repo.get(name))) return reply.status(404).send({ error: `account '${name}' not found` });

    const patch: { selfEmail?: string; enabled?: boolean } = {};
    if (typeof body.selfEmail === 'string' && body.selfEmail.trim()) patch.selfEmail = body.selfEmail.trim();
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.grantId === 'string' && body.grantId.trim()) {
      await secretsService.set(emailAccountGrantSecretName(name), body.grantId.trim());
    }
    const row = await repo.update(name, patch);
    if (!row) return reply.status(404).send({ error: `account '${name}' not found` });
    request.log.info({ account: name }, 'email account updated');
    return reply.send({ account: row });
  });

  app.delete('/api/registry/email-accounts/:name', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const { name } = request.params as { name: string };
    const deleted = await repo.delete(name);
    if (!deleted) return reply.status(404).send({ error: `account '${name}' not found` });
    await secretsService.delete(emailAccountGrantSecretName(name));
    request.log.info({ account: name }, 'email account deleted');
    return reply.send({ ok: true });
  });
}
```

Note: confirm `SecretsService` exposes `delete(name)` (the explorer's API listing includes `delete`). If the method name differs, adjust the `secretsService` option type and the DELETE handler accordingly.

- [ ] **Step 4: Register the route in `http-adapter.ts`**

Add `emailAccountsRoutes` import. Register it next to the vault/channel-registry registrations (after line ~377). It needs `pool`, `secretsService`, `webAppBootstrapSecret`, `sessions` — all already in scope where the other routes register:

```typescript
if (webAppBootstrapSecret && this.config.secretsService) {
  await this.app.register(emailAccountsRoutes, {
    pool,
    secretsService: this.config.secretsService,
    webAppBootstrapSecret,
    sessions,
  });
}
```

(`/api/registry/email-accounts` is covered by the existing `routeUrl.startsWith('/api/registry')` auth bypass, so the bearer-token hook does not need changes.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts exec vitest run src/channels/http/routes/email-accounts.test.ts`
Then: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add src/channels/http/routes/email-accounts.ts src/channels/http/routes/email-accounts.test.ts src/channels/http/http-adapter.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: /api/registry/email-accounts CRUD route (#1101)"
```

---

### Task 10: Console UI — email accounts section

Add an accounts sub-list to the email channel's detail drawer in `ChannelSettings.tsx`: list existing accounts (name, address, provider, enabled, grant status), an add form (name, self_email, provider select [Nylas], paste grant), and edit/disable/remove. Use the existing `apiFetch` helper and the `errorMessage` pattern already in the file.

**Files:**
- Create: `apps/console/src/components/EmailAccountsSection.tsx`
- Modify: `apps/console/src/pages/ChannelSettings.tsx` (render `<EmailAccountsSection/>` inside the drawer when `entry.name === 'email'`)

**Interfaces:**
- Consumes: `apiFetch` from `../api.js`; endpoints from Task 9.

- [ ] **Step 1: Write the component**

Create `apps/console/src/components/EmailAccountsSection.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api.js';

interface EmailAccount {
  name: string;
  selfEmail: string;
  provider: string;
  enabled: boolean;
  hasGrant: boolean;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json() as { error?: string };
    return data.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export function EmailAccountsSection(): JSX.Element {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-form state
  const [name, setName] = useState('');
  const [selfEmail, setSelfEmail] = useState('');
  const [grantId, setGrantId] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/registry/email-accounts');
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json() as { accounts: EmailAccount[] };
      setAccounts(data.accounts ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load accounts');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch('/api/registry/email-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, selfEmail, provider: 'nylas', grantId }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      setName(''); setSelfEmail(''); setGrantId('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add account');
    } finally { setBusy(false); }
  }, [name, selfEmail, grantId, load]);

  const toggle = useCallback(async (acct: EmailAccount) => {
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/registry/email-accounts/${encodeURIComponent(acct.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !acct.enabled }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to update account');
    } finally { setBusy(false); }
  }, [load]);

  const remove = useCallback(async (acct: EmailAccount) => {
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/registry/email-accounts/${encodeURIComponent(acct.name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await errorMessage(res));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to remove account');
    } finally { setBusy(false); }
  }, [load]);

  return (
    <div className="form-field">
      <label>Email accounts</label>
      <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
        Mailboxes the agent polls and replies from. Adding or removing an account takes effect on the next restart.
      </p>
      {err && <p className="autonomy-error">{err}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {accounts.map(a => (
          <div key={a.name} className="status-pill" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>
              <strong>{a.name}</strong> — {a.selfEmail} ({a.provider})
              {!a.hasGrant && ' ⚠ no grant'}{!a.enabled && ' · disabled'}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button disabled={busy} onClick={() => void toggle(a)}>{a.enabled ? 'Disable' : 'Enable'}</button>
              <button disabled={busy} onClick={() => void remove(a)}>Remove</button>
            </span>
          </div>
        ))}
        {accounts.length === 0 && <span className="settings-page-sub">No accounts yet.</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        <input placeholder="account name (e.g. curia)" value={name} onChange={e => setName(e.target.value)} />
        <input placeholder="mailbox address" value={selfEmail} onChange={e => setSelfEmail(e.target.value)} />
        <label style={{ fontSize: 12 }}>
          Provider
          <select value="nylas" disabled style={{ marginLeft: 6 }}>
            <option value="nylas">Nylas</option>
          </select>
        </label>
        <input placeholder="Nylas grant ID (paste from Nylas dashboard)" value={grantId} onChange={e => setGrantId(e.target.value)} />
        <button disabled={busy || !name || !selfEmail || !grantId} onClick={() => void add()}>Add account</button>
      </div>
    </div>
  );
}
```

Match the surrounding styling conventions in `ChannelSettings.tsx` (class names like `form-field`, `status-pill`, `settings-page-sub`, `autonomy-error`). Adjust class usage to fit the existing CSS rather than inventing new classes.

- [ ] **Step 2: Render it in the email channel drawer**

In `apps/console/src/pages/ChannelSettings.tsx`, import the component and render it inside the drawer body, immediately after the Credentials `form-field`, gated to the email channel:

```tsx
import { EmailAccountsSection } from '../components/EmailAccountsSection.js';
```

```tsx
{entry.name === 'email' && <EmailAccountsSection />}
```

- [ ] **Step 3: Build the console to verify it compiles**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run build:console` (confirm the script name in `package.json`)
Expected: build succeeds (TS + Vite). Fix any type errors (e.g. `JSX.Element` import expectations) to match the console's tsconfig.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add apps/console/src/components/EmailAccountsSection.tsx apps/console/src/pages/ChannelSettings.tsx
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "feat: console email-accounts management UI (#1101)"
```

---

### Task 11: Docs, config cleanup, CHANGELOG

**Files:**
- Modify: `docs/adr/021-vault-only-secret-resolution.md` (remove the multi-account limitation)
- Modify: `docs/dev/configuration.md` (replace the `channel_accounts.email` YAML section with the console flow)
- Modify: `config/default.yaml` (remove the `channel_accounts` example block + its comments)
- Modify: `.env.example` (remove `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` if present; leave `NYLAS_API_KEY`)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Update ADR-021**

In `docs/adr/021-vault-only-secret-resolution.md`, remove the "Known limitations" entry describing the multi-account `resolveEnvValue` / `channel_accounts.email` env gap. Add a one-line note that #1101 resolved it (email accounts are vault + `email_accounts`-table managed).

- [ ] **Step 2: Rewrite the configuration.md section**

In `docs/dev/configuration.md`, replace the multi-account `channel_accounts.email` YAML subsection with: email accounts are managed in the console (Settings → Channels → Email → Email accounts); each account stores its Nylas grant in the vault at `channel.email.<name>.nylas_grant_id`; `NYLAS_API_KEY` remains the shared app key; changes take effect on restart.

- [ ] **Step 3: Remove the YAML example**

In `config/default.yaml`, delete the `channel_accounts:` block and its explanatory comments (the example referencing `env:NYLAS_GRANT_ID`).

- [ ] **Step 4: Trim `.env.example`**

In `.env.example` (repo root), remove `NYLAS_GRANT_ID` and `NYLAS_SELF_EMAIL` lines if present; keep `NYLAS_API_KEY`. Add a short comment that per-account grants are configured in the console and stored in the vault.

Note (not a code change): the **prod `.env`** and the **curia-deploy `.env.example`** also pin these two vars — removing them there is a deployment step, called out in the PR description and the rollout checklist below, not in this repo's diff.

- [ ] **Step 5: CHANGELOG entry**

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added
- **Email accounts** — manage one or many agent-owned mailboxes from the console; per-account Nylas grants stored in the vault. (#1101)

### Removed
- **`channel_accounts` YAML** — email accounts are no longer configured via `config/local.yaml`; the env-backed multi-account path is retired (supersedes #920). (#1101)
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts add docs/adr/021-vault-only-secret-resolution.md docs/dev/configuration.md config/default.yaml .env.example CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts commit -m "docs: console email accounts; retire channel_accounts YAML (#1101)"
```

---

### Task 12: Full suite, review, PR

- [ ] **Step 1: Run the full test suite + typecheck**

Run:
```
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run typecheck
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts run test
```
Expected: green. Integration tests (`email-accounts-repo`, migration) require Postgres; if not available locally, confirm they run in CI.

- [ ] **Step 2: Migration-prefix collision check (rebase hazard)**

Run: `ls src/db/migrations/ | sort | uniq -w3 -D`
Expected: no duplicate 3-char prefixes. If `063` collides after a rebase, renumber this migration to the next free slot and update Task 1 references.

- [ ] **Step 3: Pre-PR review subagents (per global workflow)**

Dispatch in parallel: `pr-review-toolkit:code-reviewer` (branch vs `main`), `pr-review-toolkit:silent-failure-hunter`, and a security review (this touches vault/credentials). Address high-priority findings.

- [ ] **Step 4: Push + open PR**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-console-email-accounts push -u origin feat/console-email-accounts
```
Open the PR with `Closes #1101` in the Summary. Include a **Rollout checklist** in the body:
- Deploy carries migration `063` (table created before new resolver runs).
- First boot runs the backfill: confirm logs show "Backfilled legacy email account" and the email channel polls.
- After confirming, remove `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` from prod `.env` and the curia-deploy `.env.example`; restart; confirm the channel still polls (now fully vault + table sourced).

- [ ] **Step 5: Confirm CI**

Run: `gh run list --branch feat/console-email-accounts --limit 1`
Report the PR URL + CI status.

---

## Self-Review

**Spec coverage** (design doc → tasks):
- `email_accounts` table → Task 1. Per-account vault key convention → Task 2. Repo → Task 3.
- Async resolver reading table+vault, drop `excludedSenderEmails`, delete YAML path → Task 4.
- Self-suppression union → Tasks 5 (adapter field) + 7 (union computed in wiring).
- Backfill (idempotent, name-preserving, no-silent-miss warning) → Task 6; wired in Task 7.
- Vault scope-guard for per-account grants → Task 8.
- Console CRUD route → Task 9; UI → Task 10.
- `.env` unpin + ADR-021 + configuration.md + #920 disposition → Task 11 (code) + Task 12 (deploy steps, #1101 closed via PR).
- Tests: resolver, backfill, repo (integration), adapter suppression, vault guard, route handlers, boot-without-env covered across Tasks 3-9; the boot-without-env acceptance criterion is exercised by the resolver+backfill unit tests (no `process.env` reads) and the rollout checklist's live confirmation.

**Placeholder scan:** No "TBD"/"add error handling"-style gaps; every code step shows real code. UI class names are flagged as "match existing CSS," which is concrete guidance, not a placeholder. Two confirm-the-script-name notes (migrate, build:console) are verification steps, not missing content.

**Type consistency:** `ResolvedEmailAccount = { name, nylasGrantId, selfEmail }` used identically in Tasks 4 and 7. `EmailAccountRow` fields consistent across Tasks 3, 4, 9. `emailAccountGrantSecretName` / `isPerAccountEmailGrantKey` / `isValidEmailAccountName` (Task 2) used in Tasks 4, 6, 8, 9. `suppressedSenderEmails` consistent across Tasks 5 and 7. Route option shapes match the `identity.ts` injection pattern.

**Open verification items for the implementer** (call out, don't block): exact `migrate` / `build:console` script names in `package.json`; the integration-test pool harness used by sibling repo tests; the exact vault route test file path; that `SecretsService` exposes `delete(name)`.
