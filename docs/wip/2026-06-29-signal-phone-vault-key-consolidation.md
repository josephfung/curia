# Signal Phone Vault Key Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `channel.signal.phone_number` the single authoritative vault key for the Signal phone number, removing the divergent legacy flat `signal_phone_number` read.

**Architecture:** Remove the flat-key read from the bootstrap secrets resolver so both the registry gate and the adapter/outbound boot resolve the same key (`channel.signal.phone_number ▸ SIGNAL_PHONE_NUMBER` env). A forward-only SQL migration backfills any existing flat value onto the namespaced key (copying ciphertext verbatim — no per-name AAD) and drops the flat row. The seeder stops writing the flat key so the migration's delete sticks.

**Tech Stack:** TypeScript (ESM, Node 24+), PostgreSQL 16 (node-pg-migrate, plain SQL), Vitest (unit + real-Postgres integration), pino, AES-256-GCM vault.

## Global Constraints

- ESM only — `.js` extensions on all relative imports; no `__dirname` (use `import.meta.*`). (CLAUDE.md)
- No `any`; parameterized SQL only; no `console.log` (pino only). (CLAUDE.md)
- Run `pnpm -C <worktree> run typecheck` before every commit touching `.ts`. (CLAUDE.md)
- Conventional commits (`fix:` / `test:` / `docs:`); **no** `Co-Authored-By` trailers; **no** Claude/AI attribution anywhere. (global CLAUDE.md)
- Migration prefix must be unique — re-verify `ls src/db/migrations/ | sort` before merge; `068` is the next free slot after `067`. (CLAUDE.md)
- Every PR updates `CHANGELOG.md` under `## [Unreleased]`. No version bump (regular PR). (CLAUDE.md)
- Integration tests skip without `DATABASE_URL` (and `SECRET_ENCRYPTION_KEY` where the vault is used); they connect to a real Postgres, never mocks. (CLAUDE.md)
- Worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key`, branch `fix/signal-phone-vault-key`. All commands use `pnpm -C <worktree>` / `git -C <worktree>`.
- Test DB env (from memory `reference_curia_test_db`): `DATABASE_URL=postgres://curia:curia@localhost:5433/curia_test`, `SECRET_ENCRYPTION_KEY` must be set for vault integration tests.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/db/migrations/068_consolidate_signal_phone_number.sql` | One-time backfill flat→namespaced + drop flat row | **Create** |
| `tests/integration/migrate-signal-phone-consolidation.test.ts` | Verifies the migration SQL (backfill, no-clobber, no-op, idempotent) | **Create** |
| `src/secrets/apply-vault-secrets.ts` | Bootstrap secrets resolver — remove flat `signal_phone_number` read + stale comments | **Modify** |
| `tests/unit/apply-vault-secrets.test.ts` | Unit cover that the resolver no longer touches `signalPhoneNumber` | **Modify** |
| `scripts/seed-vault.ts` | Drop `signal_phone_number` from `SEED_SECRET_NAMES` | **Modify** |
| `tests/integration/seed-vault.test.ts` | Update expectations (signal no longer seeded) | **Modify** |
| `src/channels/apply-channel-vault-secrets.test.ts` | Add console-only Signal activation test | **Modify** |
| `src/channels/credential-resolver.test.ts` | Assert console-only resolvable against the real catalog descriptor | **Modify** |
| `CHANGELOG.md` | `Fixed` entry | **Modify** |

---

## Task 1: Backfill migration + integration test

**Files:**
- Create: `src/db/migrations/068_consolidate_signal_phone_number.sql`
- Test: `tests/integration/migrate-signal-phone-consolidation.test.ts`

**Interfaces:**
- Consumes: `SecretsService` (`set(name, value)`, `get(name)`), `loadEncryptionKey()` from `src/secrets/`.
- Produces: vault key `channel.signal.phone_number` populated from legacy `signal_phone_number`; flat row removed. No code symbols.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/migrate-signal-phone-consolidation.test.ts`:

```ts
// Integration test — runs the 068 migration SQL against a live Postgres and asserts the
// flat→namespaced Signal phone consolidation. Skips without DATABASE_URL + SECRET_ENCRYPTION_KEY.
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { readFile } from 'node:fs/promises';
import { loadEncryptionKey } from '../../src/secrets/crypto.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL && process.env.SECRET_ENCRYPTION_KEY ? describe : describe.skip;
const logger = pino({ level: 'silent' });

const MIGRATION_SQL_URL = new URL(
  '../../src/db/migrations/068_consolidate_signal_phone_number.sql',
  import.meta.url,
);
const FLAT = 'signal_phone_number';
const NAMESPACED = 'channel.signal.phone_number';

describeIf('migration 068: consolidate signal phone number', () => {
  let pool: pg.Pool;
  let secrets: SecretsService;
  let migrationSql: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    secrets = new SecretsService(pool, loadEncryptionKey(), logger);
    migrationSql = await readFile(MIGRATION_SQL_URL, 'utf8');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[FLAT, NAMESPACED]]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('backfills the namespaced key from the legacy flat key, then drops the flat row', async () => {
    await secrets.set(FLAT, '+12223334444');
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBe('+12223334444');
    expect(await secrets.get(FLAT)).toBeNull();
  });

  it('never clobbers an existing console-written namespaced value', async () => {
    await secrets.set(FLAT, '+19999999999');      // stale legacy value
    await secrets.set(NAMESPACED, '+12223334444'); // console entry must win
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBe('+12223334444');
    expect(await secrets.get(FLAT)).toBeNull();    // flat row still removed
  });

  it('is a no-op when neither key exists (env-only / unconfigured deployment)', async () => {
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBeNull();
    expect(await secrets.get(FLAT)).toBeNull();
  });

  it('is idempotent — a second run changes nothing', async () => {
    await secrets.set(FLAT, '+12223334444');
    await pool.query(migrationSql);
    await pool.query(migrationSql);
    expect(await secrets.get(NAMESPACED)).toBe('+12223334444');
    expect(await secrets.get(FLAT)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key exec vitest run tests/integration/migrate-signal-phone-consolidation.test.ts`
Expected: FAIL — `readFile` rejects with `ENOENT` (the migration file does not exist yet). (If `DATABASE_URL`/`SECRET_ENCRYPTION_KEY` are unset the suite is skipped — set the test-DB env from Global Constraints so it actually runs and fails.)

- [ ] **Step 3: Create the migration**

Create `src/db/migrations/068_consolidate_signal_phone_number.sql`:

```sql
-- Migration 068: consolidate the Signal phone number onto one authoritative vault key,
-- channel.signal.phone_number (#1140).
--
-- The number was read from two divergent vault keys: the legacy flat `signal_phone_number`
-- (read by applyVaultSecrets) and the namespaced `channel.signal.phone_number` (written by
-- the console, read by the registry gate and applyChannelVaultSecrets). Only the namespaced
-- key gates inbound Signal activation, so a flat-key-only deployment could enable outbound
-- Signal egress while the registry reported Signal unconfigured. We standardize on the
-- namespaced key and remove the flat-key read in the same change.
--
-- This migration backfills any existing flat value onto the namespaced key, then drops the
-- flat row. Safe to run on every deployment:
--   * Copies encrypted_value + iv verbatim — the vault's AES-256-GCM encryption uses no
--     per-name AAD (src/secrets/crypto.ts), so the ciphertext decrypts identically under the
--     new name. No encryption key is needed here.
--   * The NOT EXISTS guard never clobbers a value already written via the console.
--   * Idempotent: a second run copies nothing (guard) and deletes nothing (row already gone).
--   * No-op for env-only or console-only deployments that never had the flat key.

INSERT INTO secrets (name, value_format, encrypted_value, iv)
SELECT 'channel.signal.phone_number', value_format, encrypted_value, iv
FROM secrets
WHERE name = 'signal_phone_number'
  AND NOT EXISTS (
    SELECT 1 FROM secrets WHERE name = 'channel.signal.phone_number'
  );

DELETE FROM secrets WHERE name = 'signal_phone_number';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key exec vitest run tests/integration/migrate-signal-phone-consolidation.test.ts`
Expected: PASS — all four cases green.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key add src/db/migrations/068_consolidate_signal_phone_number.sql tests/integration/migrate-signal-phone-consolidation.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key commit -m "feat: migration to consolidate signal phone onto channel.signal.phone_number (#1140)"
```

---

## Task 2: Remove the flat-key read from `apply-vault-secrets.ts`

**Files:**
- Modify: `src/secrets/apply-vault-secrets.ts`
- Test: `tests/unit/apply-vault-secrets.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyVaultSecrets(config, secrets, logger)` no longer reads `signal_phone_number` nor writes `config.signalPhoneNumber` (now owned solely by `applyChannelVaultSecrets`).

- [ ] **Step 1: Update the unit test to express the new contract (failing)**

In `tests/unit/apply-vault-secrets.test.ts`:

Replace the "trims surrounding whitespace" test (currently lines 45–54) so it no longer references signal:

```ts
  it('trims surrounding whitespace from vault values', async () => {
    const config = blankConfig();
    await applyVaultSecrets(
      config,
      stubSecrets({ anthropic_api_key: '  sk-ant-x\n', api_token: '  tok-x \n' }),
      logger,
    );
    expect(config.anthropicApiKey).toBe('sk-ant-x');
    expect(config.apiToken).toBe('tok-x');
  });
```

Replace the "collapses a whitespace-only value" test (currently lines 56–67) to drop the signal example:

```ts
  it('collapses a whitespace-only value to undefined so feature/boot guards stay honest', async () => {
    const config = blankConfig();
    await applyVaultSecrets(
      config,
      // A blank api_token must trip the !config.apiToken boot guard rather than read as present.
      stubSecrets({ api_token: ' ', nylas_api_key: '   ' }),
      logger,
    );
    expect(config.apiToken).toBeUndefined();
    expect(config.nylasApiKey).toBeUndefined();
  });
```

Add a regression test asserting the flat key is no longer read (place after the test above):

```ts
  it('does not read or write signalPhoneNumber — that key is owned by applyChannelVaultSecrets', async () => {
    const config = blankConfig();
    // Even with a legacy flat signal_phone_number present in the vault, applyVaultSecrets
    // must leave config.signalPhoneNumber untouched (#1140 consolidation).
    await applyVaultSecrets(
      config,
      stubSecrets({ signal_phone_number: '+12223334444' }),
      logger,
    );
    expect(config.signalPhoneNumber).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key exec vitest run tests/unit/apply-vault-secrets.test.ts`
Expected: FAIL — the new regression test fails because the current code sets `config.signalPhoneNumber = '+12223334444'`.

- [ ] **Step 3: Remove the flat-key read from the implementation**

In `src/secrets/apply-vault-secrets.ts`:

(a) Header comment — the consumers list no longer includes Signal. Change line 6:

```ts
// embeddings, nylas/signal channels). Reads run concurrently; values are never logged.
```
to:
```ts
// embeddings, nylas channel). Reads run concurrently; values are never logged.
// Note: the Signal phone number is NOT resolved here — it is owned by applyChannelVaultSecrets
// under the canonical channel.signal.phone_number key (#1140).
```

(b) Remove `signalPhoneNumber,` from the destructure (current line 25).

(c) Remove `secrets.get('signal_phone_number'),` from the `Promise.all` (current line 35).

(d) Replace the `clean()` comment block (current lines 38–49) so it no longer uses Signal as the example:

```ts
  // Normalize each vault value: trim surrounding whitespace (copy-paste artifacts) and
  // collapse a blank/whitespace-only result to `undefined` (absent). A whitespace-only
  // secret is unusable at runtime — the Anthropic client and HTTP auth both reject it — so
  // it must read as absent here, keeping the boot guard (`if (!config.apiToken)`) and the
  // feature-on checks honest rather than letting a truthy-but-empty string slip through.
  // The seeder already trims on write; this is the matching read-side guard for rows set by
  // any other path.
  const clean = (value: string | null): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
```

(e) Remove the assignment `config.signalPhoneNumber = clean(signalPhoneNumber);` (current line 61).

(f) Remove the `signal_phone_number: clean(signalPhoneNumber) !== undefined,` entry from the `present` object (current line 76).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key exec vitest run tests/unit/apply-vault-secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key run typecheck`
Expected: no errors (the now-unused `signalPhoneNumber` binding is gone, so no unused-var failure).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key add src/secrets/apply-vault-secrets.ts tests/unit/apply-vault-secrets.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key commit -m "fix: stop reading legacy flat signal_phone_number key (#1140)"
```

---

## Task 3: Drop the flat key from the seeder

**Files:**
- Modify: `scripts/seed-vault.ts`
- Test: `tests/integration/seed-vault.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SEED_SECRET_NAMES` no longer contains `'signal_phone_number'`; the seeder never writes the flat key.

- [ ] **Step 1: Add a failing test**

In `tests/integration/seed-vault.test.ts`, add inside the `describeIf('seedVault', …)` block:

```ts
  it('does not seed the legacy signal_phone_number key (consolidated to channel.signal.phone_number, #1140)', async () => {
    expect([...SEED_SECRET_NAMES]).not.toContain('signal_phone_number');
    const { seeded, skipped } = await seedVault(secrets, { SIGNAL_PHONE_NUMBER: '+12223334444' }, logger);
    expect(seeded).not.toContain('signal_phone_number');
    expect(skipped).not.toContain('signal_phone_number');
    expect(await secrets.get('signal_phone_number')).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key exec vitest run tests/integration/seed-vault.test.ts`
Expected: FAIL — `SEED_SECRET_NAMES` still contains `'signal_phone_number'`, so the first `expect(...).not.toContain` fails (and the seeder would seed it).

- [ ] **Step 3: Remove the flat key from the seeder**

In `scripts/seed-vault.ts`, delete the `'signal_phone_number',` line from `SEED_SECRET_NAMES` (current line 32). Add a short comment in its place so a future reader knows why Signal's number is absent:

```ts
  'nylas_self_email',
  // Signal phone number is NOT seeded — it is the canonical channel.signal.phone_number key
  // written via the console (or read from SIGNAL_PHONE_NUMBER env as back-compat), the same
  // as signal_socket_path which was never seeded (#1140).
  // skill-scoped (resolved at call time by ctx.secret)
  'ceo_nylas_grant_id',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key exec vitest run tests/integration/seed-vault.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key add scripts/seed-vault.ts tests/integration/seed-vault.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key commit -m "fix: stop seeding legacy flat signal_phone_number key (#1140)"
```

---

## Task 4: Cover the console-only activation path

**Files:**
- Modify: `src/channels/apply-channel-vault-secrets.test.ts`
- Modify: `src/channels/credential-resolver.test.ts`

**Interfaces:**
- Consumes: `applyChannelVaultSecrets`, `channelCredentialStatus`, `getChannelDescriptor` from `src/channels/`.
- Produces: tests only.

- [ ] **Step 1: Write the failing/clarifying tests**

In `src/channels/apply-channel-vault-secrets.test.ts`, add inside the `describe('applyChannelVaultSecrets', …)` block:

```ts
  it('activates Signal from a console-only entry — channel.signal.phone_number alone, no flat bootstrap, no env', async () => {
    // baseConfig().signalPhoneNumber is undefined: there is no flat-key bootstrap value to
    // fall back on, so this proves the console-written key alone populates config (#1140).
    const config = baseConfig();
    const secrets = fakeSecrets({
      'channel.signal.phone_number': '+15550009999',
      'channel.signal.socket_path': '/run/signal/socket',
    });

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    expect(config.signalPhoneNumber).toBe('+15550009999');
    expect(config.signalSocketPath).toBe('/run/signal/socket');
  });
```

In `src/channels/credential-resolver.test.ts`, add an import for the real catalog at the top (after the existing imports):

```ts
import { getChannelDescriptor } from './catalog.js';
```

Then add inside `describe('channelCredentialStatus', …)`:

```ts
  it('reports the real Signal catalog descriptor resolvable from console-only vault keys (#1140)', async () => {
    const descriptor = getChannelDescriptor('signal')!;
    const secrets = fakeSecrets({
      'channel.signal.socket_path': '/run/sig.sock',
      'channel.signal.phone_number': '+15551234567',
    });
    const res = await channelCredentialStatus({ secrets, env: {} }, descriptor);
    expect(res.requiredResolvable).toBe(true);
    expect(res.fields.map(f => f.source)).toEqual(['vault', 'vault']);
  });
```

- [ ] **Step 2: Run the tests**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key exec vitest run src/channels/apply-channel-vault-secrets.test.ts src/channels/credential-resolver.test.ts`
Expected: PASS — the runtime overlay and the gate already resolve the console-written key; these tests lock that behavior in. (They are characterization tests for the now-canonical path; they pass against the unchanged channel code, which is the point — console-only is sufficient.)

- [ ] **Step 3: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key add src/channels/apply-channel-vault-secrets.test.ts src/channels/credential-resolver.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key commit -m "test: cover console-only Signal activation via channel.signal.phone_number (#1140)"
```

---

## Task 5: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the entry**

Under `## [Unreleased]`, in the `### Fixed` section (create the section if absent), add:

```markdown
- **Signal phone number** — consolidated onto a single canonical vault key, `channel.signal.phone_number`; the divergent legacy flat `signal_phone_number` read is removed and an existing value is backfilled by migration. Console-only entry now activates Signal. (#1140)
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key commit -m "docs: changelog for signal phone vault key consolidation (#1140)"
```

---

## Final verification (run after all tasks)

- [ ] **Migration numbering unique:** `ls /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key/src/db/migrations/ | sort` — confirm `068` appears exactly once.
- [ ] **Full typecheck:** `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key run typecheck` — no errors.
- [ ] **Full test suite:** `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key test` — all green (integration suites need the test-DB env from Global Constraints; otherwise they skip).
- [ ] **Grep for stragglers:** `grep -rn "signal_phone_number" /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key/src /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key/scripts /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-signal-phone-vault-key/tests` — the only remaining hits should be the migration `068` SQL (and its test) that intentionally reference the legacy name during backfill.

## Out of scope (do NOT touch)

- Email's flat `nylas_*` + `channel.email.*` dual-key shape (its gate already accounts for config-resolved keys via `channelConfigKeys` in `src/index.ts`).
- The broader "remove all channel env fallbacks" cleanup (`SIGNAL_SOCKET_PATH`, `NYLAS_*`) — deferred to its own issue. `SIGNAL_PHONE_NUMBER` env fallback is deliberately **kept** as documented back-compat.
- Version bump (release-time only).

## Follow-up (separate repo, separate PR — not part of this plan's tasks)

- **curia-docs** — update any page referencing `signal_phone_number` to use only `channel.signal.phone_number`; close [curia-docs#26](https://github.com/josephfung/curia-docs/issues/26). Draft as markdown for human approval first (per the upstream-workflow rule).
```
