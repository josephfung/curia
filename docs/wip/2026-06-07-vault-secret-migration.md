# Vault Secret Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every secret except the four that bootstrap the vault out of plaintext `.env` and into the encrypted secrets vault (#542), with vault-only resolution and no env fallback.

**Architecture:** Skill secrets already resolve vault-first via `ctx.secret()` (#542), so they need only seeding + `.env` removal. Bootstrap/config secrets (read by `loadConfig()` before the vault exists) move to a new `applyVaultSecrets()` step that runs right after the vault is constructed and overwrites those config fields from the vault — vault-only, no `?? process.env`. A `seed-vault` script writes current env values into the vault and is invoked by `setup.sh` after migrations so fresh installs never face an empty vault.

**Tech Stack:** TypeScript (ESM, Node 22+), PostgreSQL (pg), AES-256-GCM vault (`SecretsService`), vitest, pino, bash (`setup.sh`).

**Issue:** #911. Google Workspace OAuth secrets are out of scope (split to #913).

---

## The four env-only values (everything else → vault)

| Stays in `.env` | Why |
|---|---|
| `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` | needed to connect to the DB that hosts the vault |
| `SECRET_ENCRYPTION_KEY` | decrypts the vault; cannot live in it |

Non-secret config (`HTTP_PORT`, `POSTGRES_PORT`, `LOG_LEVEL`, `TIMEZONE`, `NYLAS_POLL_INTERVAL_MS`, `APP_ORIGIN`, `NODE_EXTRA_CA_CERTS`) and identity config (`CEO_PRIMARY_EMAIL`, `CEO_SIGNAL_NUMBER`) also stay in `.env` — they are not secrets and are out of scope.

## The 12 migrated secrets (vault name → env var, mapped by `name.toUpperCase()`)

**Bootstrap/config-scoped** (resolved by `applyVaultSecrets`):
`anthropic_api_key`, `openai_api_key`, `openrouter_api_key`, `api_token`, `web_app_bootstrap_secret`, `nylas_api_key`, `nylas_grant_id`, `nylas_self_email`, `signal_phone_number`

**Skill-scoped** (resolved by existing `ctx.secret()`, no code change):
`ceo_nylas_grant_id`, `ceo_self_email`, `tavily_api_key`

The three dual-consumed secrets (`nylas_api_key`, `nylas_self_email`, `openai_api_key`) are a single vault row each, read by both paths.

## CRITICAL — rollout ordering (no fallback means order matters)

Because there is **no env fallback**, booting the new vault-only code against an **empty vault wipes every secret**. The vault MUST be seeded before the new code resolves secrets. Order, for both fresh installs and the existing deployment:

1. Migrations run (creates/has the `secrets` table).
2. `seed-vault` runs while the values are still available in env (fresh: prompted/generated in `setup.sh`; existing box: current `.env`).
3. Only then does the app boot on the new `applyVaultSecrets` path.
4. Remove the migrated vars from `.env` **after** verifying the vault is seeded.

`setup.sh` enforces this for fresh installs (seed between migrate and stack-start). The existing-deployment runbook (Task 7) does it manually.

## File Structure

- `scripts/seed-vault.ts` — **new.** Canonical migrated-secret list + `seedVault()` (testable) + CLI entry. Reads env, upserts into the vault.
- `tests/integration/seed-vault.test.ts` — **new.** Real-Postgres test of `seedVault()` (gated on `DATABASE_URL`, like `secrets-service.test.ts`).
- `src/secrets/apply-vault-secrets.ts` — **new.** `applyVaultSecrets(config, secrets, logger)` overwrites the nine config secret fields from the vault (vault-only).
- `src/secrets/apply-vault-secrets.test.ts` — **new.** Unit test with a fake `SecretsService`.
- `src/config.ts` — **modify.** `loadConfig()` stops reading the nine secret fields from env (they become `undefined`/`''`, resolved later by `applyVaultSecrets`).
- `tests/unit/config.test.ts` — **modify.** Drop the "loads ANTHROPIC_API_KEY from environment" test; add a test asserting `loadConfig()` no longer reads it from env.
- `src/index.ts` — **modify.** Call `await applyVaultSecrets(config, secretsService, logger)` immediately after migrations (after line 263), before any consumer.
- `scripts/setup.sh` — **modify.** `write_env` stops writing the three migrated generated/prompted secrets; add a seed-vault invocation after `pnpm run migrate`.
- `package.json` — **modify.** Add `"seed-vault"` script.
- `.env.example` — **modify.** Remove the 12 migrated secrets; document vault-only.
- `docs/dev/setup.md`, `docs/dev/configuration.md` — **modify.** Describe vault-only resolution + how to add a secret post-setup.
- `docs/adr/021-vault-only-secret-resolution.md` + `docs/adr/README.md` — **new/modify.** Record the no-fallback decision.
- `CHANGELOG.md` — **modify.** `Security` entry under `[Unreleased]`.

---

### Task 1: `seed-vault` script + integration test

**Files:**
- Create: `scripts/seed-vault.ts`
- Create: `tests/integration/seed-vault.test.ts`
- Modify: `package.json` (scripts block, after line 29)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/seed-vault.test.ts`. This mirrors the gating pattern in `tests/integration/secrets-service.test.ts` (real Postgres, skipped when `DATABASE_URL` is unset).

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { loadEncryptionKey } from '../../src/secrets/crypto.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { seedVault, SEED_SECRET_NAMES } from '../../scripts/seed-vault.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL && process.env.SECRET_ENCRYPTION_KEY ? describe : describe.skip;

describeIf('seedVault', () => {
  const logger = pino({ level: 'silent' });
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const secrets = new SecretsService(pool, loadEncryptionKey(), logger);

  beforeEach(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[...SEED_SECRET_NAMES]]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM secrets WHERE name = ANY($1)', [[...SEED_SECRET_NAMES]]);
    await pool.end();
  });

  it('seeds present env values into the vault and skips absent ones', async () => {
    const env = { NYLAS_API_KEY: 'nyk_test_123', TAVILY_API_KEY: 'tvly_test_456' };
    const { seeded, skipped } = await seedVault(secrets, env, logger);

    expect(seeded.sort()).toEqual(['nylas_api_key', 'tavily_api_key']);
    expect(skipped).toContain('anthropic_api_key');
    expect(await secrets.get('nylas_api_key')).toBe('nyk_test_123');
    expect(await secrets.get('tavily_api_key')).toBe('tvly_test_456');
    expect(await secrets.get('anthropic_api_key')).toBeNull();
  });

  it('treats empty-string env values as absent (skipped)', async () => {
    const { seeded, skipped } = await seedVault(secrets, { NYLAS_API_KEY: '' }, logger);
    expect(seeded).not.toContain('nylas_api_key');
    expect(skipped).toContain('nylas_api_key');
  });

  it('is idempotent — re-running upserts the same value', async () => {
    await seedVault(secrets, { TAVILY_API_KEY: 'tvly_v1' }, logger);
    await seedVault(secrets, { TAVILY_API_KEY: 'tvly_v2' }, logger);
    expect(await secrets.get('tavily_api_key')).toBe('tvly_v2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration test tests/integration/seed-vault.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/seed-vault.js'` (or the suite is skipped if `DATABASE_URL`/`SECRET_ENCRYPTION_KEY` are unset; in that case confirm it imports without a resolution error once Step 3 exists).

- [ ] **Step 3: Write the script**

Create `scripts/seed-vault.ts`:

```typescript
// seed-vault.ts — one-time / idempotent migration of plaintext env secrets into
// the encrypted vault (#911). The vault `set()` is an upsert, so re-running is safe.
//
// Run for a manual migration (reads the current .env):
//   pnpm run seed-vault
// Add a single secret later (transient env var, then run):
//   NYLAS_API_KEY=nyk_... pnpm run seed-vault
//
// Invoked by scripts/setup.sh after migrations for fresh installs.
import pg from 'pg';
import pino from 'pino';
import { loadEncryptionKey } from '../src/secrets/crypto.js';
import { SecretsService } from '../src/secrets/secrets-service.js';

const logger = pino({ name: 'seed-vault' });

// Canonical list of secrets migrated into the vault (#911). Each vault key is
// snake_case; its env var is the UPPER_SNAKE_CASE form (the same name.toUpperCase()
// convention used by the execution layer's ctx.secret() and by applyVaultSecrets()).
// Order is irrelevant — set() is an upsert.
export const SEED_SECRET_NAMES = [
  // bootstrap/config-scoped (resolved at boot by applyVaultSecrets)
  'anthropic_api_key',
  'openai_api_key',
  'openrouter_api_key',
  'api_token',
  'web_app_bootstrap_secret',
  'nylas_api_key',
  'nylas_grant_id',
  'nylas_self_email',
  'signal_phone_number',
  // skill-scoped (resolved at call time by ctx.secret)
  'ceo_nylas_grant_id',
  'ceo_self_email',
  'tavily_api_key',
] as const;

/**
 * Read each migrated secret from `env` (by its UPPER_SNAKE_CASE name) and upsert any
 * present, non-empty value into the vault. Absent/empty values are skipped, never
 * cleared — this is additive so a partial env (e.g. no Signal configured) is fine.
 * Never logs secret values, only their names.
 */
export async function seedVault(
  secrets: SecretsService,
  env: NodeJS.ProcessEnv,
  log: pino.Logger,
): Promise<{ seeded: string[]; skipped: string[] }> {
  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const name of SEED_SECRET_NAMES) {
    const value = env[name.toUpperCase()];
    if (value === undefined || value === '') {
      skipped.push(name);
      continue;
    }
    await secrets.set(name, value);
    seeded.push(name);
  }
  log.info({ seeded, skipped }, 'Vault seeding complete');
  return { seeded, skipped };
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error('seed-vault: DATABASE_URL is not set');
    process.exit(1);
  }
  let key: Buffer;
  try {
    key = loadEncryptionKey();
  } catch (err) {
    logger.error({ err }, 'seed-vault: SECRET_ENCRYPTION_KEY is missing or invalid');
    process.exit(1);
    throw new Error('unreachable'); // guards against process.exit mocks
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const secrets = new SecretsService(pool, key, logger);
  seedVault(secrets, process.env, logger)
    .then(async () => { await pool.end(); process.exit(0); })
    .catch(async (err) => {
      logger.error({ err }, 'seed-vault: fatal error');
      await pool.end();
      process.exit(1);
    });
}
```

Add to `package.json` scripts (after the `backfill:contact-attributes` line, keep the trailing comma rules valid):

```json
    "backfill:contact-attributes": "tsx --env-file=.env scripts/backfill-contact-attributes.ts",
    "seed-vault": "tsx --env-file=.env scripts/seed-vault.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration test tests/integration/seed-vault.test.ts`
Expected: PASS (or SKIP if no `DATABASE_URL` — run against a local Postgres + a 32-byte `SECRET_ENCRYPTION_KEY` to actually exercise it).

- [ ] **Step 5: Typecheck + commit**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration run typecheck`
Expected: no errors.

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration add scripts/seed-vault.ts tests/integration/seed-vault.test.ts package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration commit -m "feat: add seed-vault script to migrate env secrets into the vault (#911)"
```

---

### Task 2: `applyVaultSecrets` + bootstrap wiring + `loadConfig` env removal

**Files:**
- Create: `src/secrets/apply-vault-secrets.ts`
- Create: `src/secrets/apply-vault-secrets.test.ts`
- Modify: `src/config.ts:944-968` (the nine secret fields in the `loadConfig()` return)
- Modify: `src/index.ts` (insert call after line 263)
- Modify: `tests/unit/config.test.ts:26-31`

- [ ] **Step 1: Write the failing unit test for `applyVaultSecrets`**

Create `src/secrets/apply-vault-secrets.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Config } from '../config.js';
import type { SecretsService } from './secrets-service.js';
import { applyVaultSecrets } from './apply-vault-secrets.js';

const logger = pino({ level: 'silent' });

// Minimal config with only the fields applyVaultSecrets touches (plus required others).
function baseConfig(): Config {
  return {
    databaseUrl: 'postgres://x',
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    openrouterApiKey: undefined,
    logLevel: 'info',
    httpPort: 3000,
    apiToken: undefined,
    webAppBootstrapSecret: undefined,
    appOrigin: undefined,
    timezone: 'UTC',
    nylasApiKey: undefined,
    nylasGrantId: undefined,
    nylasPollingIntervalMs: 30000,
    nylasSelfEmail: '',
    ceoPrimaryEmail: undefined,
    ceoSignalNumber: undefined,
    signalSocketPath: undefined,
    signalPhoneNumber: undefined,
  };
}

function fakeSecrets(values: Record<string, string>): SecretsService {
  return { get: vi.fn(async (name: string) => values[name] ?? null) } as unknown as SecretsService;
}

describe('applyVaultSecrets', () => {
  it('overwrites config secret fields from the vault', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({
      anthropic_api_key: 'sk-ant-vault',
      api_token: 'tok-vault',
      nylas_grant_id: 'grant-vault',
      nylas_self_email: 'curia@vault.test',
    });

    await applyVaultSecrets(config, secrets, logger);

    expect(config.anthropicApiKey).toBe('sk-ant-vault');
    expect(config.apiToken).toBe('tok-vault');
    expect(config.nylasGrantId).toBe('grant-vault');
    expect(config.nylasSelfEmail).toBe('curia@vault.test');
  });

  it('sets undefined for absent secrets (no env fallback)', async () => {
    const config = baseConfig();
    // Even if process.env had a value, applyVaultSecrets must NOT read it.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-should-be-ignored';
    const secrets = fakeSecrets({}); // vault empty

    await applyVaultSecrets(config, secrets, logger);

    expect(config.anthropicApiKey).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('defaults nylasSelfEmail to empty string when absent (type is string, not undefined)', async () => {
    const config = baseConfig();
    await applyVaultSecrets(config, fakeSecrets({}), logger);
    expect(config.nylasSelfEmail).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration test src/secrets/apply-vault-secrets.test.ts`
Expected: FAIL — `Cannot find module './apply-vault-secrets.js'`.

- [ ] **Step 3: Write `applyVaultSecrets`**

Create `src/secrets/apply-vault-secrets.ts`:

```typescript
// apply-vault-secrets.ts — resolves the bootstrap/config-scoped secrets from the
// vault and writes them onto the Config object (#911). Vault-only: there is NO env
// fallback. loadConfig() no longer reads these from process.env; this is the single
// place they enter Config. Must run after the vault is constructed and migrations
// have run, and before any consumer reads config (anthropic provider, openai
// embeddings, nylas/signal channels). Reads run concurrently; values are never logged.
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { SecretsService } from './secrets-service.js';

export async function applyVaultSecrets(
  config: Config,
  secrets: SecretsService,
  logger: Logger,
): Promise<void> {
  const [
    anthropicApiKey,
    openaiApiKey,
    openrouterApiKey,
    apiToken,
    webAppBootstrapSecret,
    nylasApiKey,
    nylasGrantId,
    nylasSelfEmail,
    signalPhoneNumber,
  ] = await Promise.all([
    secrets.get('anthropic_api_key'),
    secrets.get('openai_api_key'),
    secrets.get('openrouter_api_key'),
    secrets.get('api_token'),
    secrets.get('web_app_bootstrap_secret'),
    secrets.get('nylas_api_key'),
    secrets.get('nylas_grant_id'),
    secrets.get('nylas_self_email'),
    secrets.get('signal_phone_number'),
  ]);

  // `?? undefined` converts the service's `null` (absent) to the Config field's
  // `undefined`. nylasSelfEmail is typed `string`, so it defaults to '' — matching
  // the previous `process.env.NYLAS_SELF_EMAIL ?? ''` behavior, not an env read.
  config.anthropicApiKey = anthropicApiKey ?? undefined;
  config.openaiApiKey = openaiApiKey ?? undefined;
  config.openrouterApiKey = openrouterApiKey ?? undefined;
  config.apiToken = apiToken ?? undefined;
  config.webAppBootstrapSecret = webAppBootstrapSecret ?? undefined;
  config.nylasApiKey = nylasApiKey ?? undefined;
  config.nylasGrantId = nylasGrantId ?? undefined;
  config.nylasSelfEmail = nylasSelfEmail ?? '';
  config.signalPhoneNumber = signalPhoneNumber ?? undefined;

  // Names only — never values. Lets an operator confirm what the vault supplied
  // vs. what's absent (feature-disabled), which is the whole debuggability win.
  const present = {
    anthropic_api_key: anthropicApiKey !== null,
    openai_api_key: openaiApiKey !== null,
    openrouter_api_key: openrouterApiKey !== null,
    api_token: apiToken !== null,
    web_app_bootstrap_secret: webAppBootstrapSecret !== null,
    nylas_api_key: nylasApiKey !== null,
    nylas_grant_id: nylasGrantId !== null,
    nylas_self_email: nylasSelfEmail !== null,
    signal_phone_number: signalPhoneNumber !== null,
  };
  logger.info({ present }, 'Resolved bootstrap secrets from vault (vault-only, no env fallback)');
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration test src/secrets/apply-vault-secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Stop reading the nine secrets from env in `loadConfig()`**

In `src/config.ts`, the `loadConfig()` return object (lines 944-968) currently reads each from `process.env`. Replace the nine secret lines with vault-resolved-later defaults. Edit each:

```typescript
    // Bootstrap/config secrets are resolved from the vault by applyVaultSecrets()
    // after the vault is constructed (#911). loadConfig() no longer reads them from
    // env — vault-only, no fallback. They are undefined here and overwritten at boot.
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    openrouterApiKey: undefined,
```
```typescript
    apiToken: undefined,
    webAppBootstrapSecret: undefined,
```
```typescript
    nylasApiKey: undefined,
    nylasGrantId: undefined,
    nylasPollingIntervalMs,
    nylasSelfEmail: '',
```
```typescript
    signalPhoneNumber: undefined,
```

Leave `databaseUrl`, `logLevel`, `httpPort`, `appOrigin`, `timezone`, `nylasPollingIntervalMs`, `ceoPrimaryEmail`, `ceoSignalNumber`, `signalSocketPath` exactly as they are (not migrated).

- [ ] **Step 6: Update the config test that asserted env reading**

In `tests/unit/config.test.ts`, replace the test at lines 26-31:

```typescript
  it('does not read ANTHROPIC_API_KEY from environment (vault-only, resolved by applyVaultSecrets)', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const config = loadConfig();
    expect(config.anthropicApiKey).toBeUndefined();
  });
```

- [ ] **Step 7: Run the config test to verify it passes**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration test tests/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 8: Verify no stray direct `process.env` reads of migrated secrets remain**

Run this and confirm the only hits are the skill `ctx.secret()` paths, `seed-vault.ts`, and tests — NOT a live consumer reading env directly (which would bypass the vault):

```bash
grep -rnE "process\.env(\.|\[['\"])(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|API_TOKEN|WEB_APP_BOOTSTRAP_SECRET|NYLAS_API_KEY|NYLAS_GRANT_ID|NYLAS_SELF_EMAIL|SIGNAL_PHONE_NUMBER|CEO_NYLAS_GRANT_ID|CEO_SELF_EMAIL|TAVILY_API_KEY)" --include='*.ts' /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration/src
```
Expected: no consumer in `src/` reads these directly after the change (config.ts no longer does). If a hit appears (e.g. an embeddings module reading `process.env.OPENAI_API_KEY` directly), route it through `config.openaiApiKey` instead — add a follow-up step here for that file.

- [ ] **Step 9: Wire `applyVaultSecrets` into bootstrap**

In `src/index.ts`, add the import near the existing secrets imports (after line 99):

```typescript
import { applyVaultSecrets } from './secrets/apply-vault-secrets.js';
```

Insert the call immediately after the migration `try/catch` closes (after line 263, before the `// 3. Audit logger` comment on line 265):

```typescript

  // Resolve bootstrap/config secrets from the vault now that migrations have run
  // (the `secrets` table exists) and before any consumer reads config (#911).
  // Vault-only: a missing required secret leaves config undefined, failing closed at
  // its consumer exactly as an unset env var did — there is no env fallback.
  await applyVaultSecrets(config, secretsService, logger);
```

- [ ] **Step 10: Typecheck + full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration run typecheck`
Expected: no errors.
Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration test`
Expected: green (DB-gated suites may skip without `DATABASE_URL`).

- [ ] **Step 11: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration add src/secrets/apply-vault-secrets.ts src/secrets/apply-vault-secrets.test.ts src/config.ts src/index.ts tests/unit/config.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration commit -m "feat: resolve bootstrap secrets from vault, drop env reads in loadConfig (#911)"
```

---

### Task 3: `setup.sh` — seed vault after migrate; stop writing migrated secrets to `.env`

**Files:**
- Modify: `scripts/setup.sh` — `write_env` (lines 134-145) and the post-migrate flow (after line 390)

- [ ] **Step 1: Trim `write_env` to only the four env-only values**

Replace the `write_env` function body (lines 134-145) so it no longer writes `ANTHROPIC_API_KEY`, `API_TOKEN`, or `WEB_APP_BOOTSTRAP_SECRET` to `.env` (those now go to the vault). It keeps the anthropic key as a parameter only to pass it onward to the seed step via the caller.

```bash
write_env() {
    # ANTHROPIC_API_KEY / API_TOKEN / WEB_APP_BOOTSTRAP_SECRET are NOT written here —
    # they are seeded into the encrypted vault after migrations (#911). Only the four
    # values needed to reach and unlock the vault live in .env.
    sed \
        -e "s|^DB_USER=.*|DB_USER=${DB_USER}|" \
        -e "s|^DB_PASSWORD=.*|DB_PASSWORD=${DB_PASSWORD}|" \
        -e "s|^DATABASE_URL=.*|DATABASE_URL=${DATABASE_URL}|" \
        -e "s|^SECRET_ENCRYPTION_KEY=.*|SECRET_ENCRYPTION_KEY=${SECRET_ENCRYPTION_KEY}|" \
        "$ENV_EXAMPLE" > "$ENV_FILE"
}
```

- [ ] **Step 2: Seed the vault after migrations, before the stack starts**

Find the migrate block (lines 385-391, ends with `success "Migrations applied"`). Immediately after it, add a seed step. The generated/prompted secrets are in shell scope (`API_TOKEN`, `WEB_APP_BOOTSTRAP_SECRET` from `generate_secrets`; the Anthropic key must be threaded in — see Step 3). Export them so `seed-vault` (which reads from `process.env`) picks them up. `.env` already supplies `DATABASE_URL` + `SECRET_ENCRYPTION_KEY` via `--env-file`.

```bash
    success "Migrations applied"

    # Seed the encrypted vault with the prompted/generated secrets (#911). Must run
    # after migrations (the `secrets` table exists) and before the app boots, because
    # the app resolves these vault-only with no env fallback. seed-vault reads values
    # from process.env, so export them here; absent ones are simply skipped.
    info "Seeding secrets vault..."
    if ! ANTHROPIC_API_KEY="$SEED_ANTHROPIC_KEY" \
         API_TOKEN="$API_TOKEN" \
         WEB_APP_BOOTSTRAP_SECRET="$WEB_APP_BOOTSTRAP_SECRET" \
         pnpm --prefix "$REPO_ROOT" run seed-vault; then
        error "Vault seeding failed. See the output above."
        hint "To retry: pnpm run setup  (choose option 2 — Resume setup)"
        exit 1
    fi
    success "Secrets vault seeded"
```

- [ ] **Step 3: Thread the prompted Anthropic key to the seed step**

The seed step runs inside `run_infra` (which contains the migrate block), but the Anthropic key is prompted in `main()` (line 454) and only passed to `write_env`. Make it available to the seed step via a global. In `main()`, after `anthropic_key=$(prompt_anthropic_key)` (line 454), add:

```bash
        SEED_ANTHROPIC_KEY="$anthropic_key"
```

And declare it with the other globals near the top of the script (alongside `PRESERVED_ENCRYPTION_KEY=""` at line 29):

```bash
SEED_ANTHROPIC_KEY=""
```

Note for the **resume** path (option 2): if `.env` already exists and setup is resumed, `SEED_ANTHROPIC_KEY` is empty, so `ANTHROPIC_API_KEY` is exported empty and skipped by seed-vault — correct, because a resume assumes the vault was already seeded on the original run. Document this in the runbook (Task 7).

- [ ] **Step 4: Manually verify setup.sh syntax**

Run: `bash -n /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration/scripts/setup.sh`
Expected: no output (valid syntax).

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration add scripts/setup.sh
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration commit -m "feat: seed vault during setup; stop writing migrated secrets to .env (#911)"
```

---

### Task 4: `.env.example` cleanup

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Remove the 12 migrated secrets and document vault-only**

Edit `.env.example`:
- Delete the assignment lines for `ANTHROPIC_API_KEY` (12), `OPENAI_API_KEY` (16), `NYLAS_API_KEY` (58), `NYLAS_GRANT_ID` (59), `NYLAS_SELF_EMAIL` (60), `API_TOKEN` (33), `WEB_APP_BOOTSTRAP_SECRET` (45), `TAVILY_API_KEY` (101). (`OPENROUTER_API_KEY`, `GOOGLE_*`, `SIGNAL_PHONE_NUMBER` are already commented out; leave Google for #913, and remove the commented `OPENROUTER_API_KEY` / `SIGNAL_PHONE_NUMBER` example lines too since they're vault-managed now.)
- Keep `DB_USER`, `DB_PASSWORD`, `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`, `HTTP_PORT`, `POSTGRES_PORT` (commented), `LOG_LEVEL`, `TIMEZONE`, `NYLAS_POLL_INTERVAL_MS` (commented), `CEO_PRIMARY_EMAIL` (commented), `CEO_SIGNAL_NUMBER`, `APP_ORIGIN`, `NODE_EXTRA_CA_CERTS` (commented), `SIGNAL_SOCKET_PATH` notes.
- Convert the explanatory comment blocks (e.g. the Nylas block at 52-57, Tavily at 98-100) to point at the vault. Add a header block near the top:

```bash
# === Secrets: managed in the encrypted vault, NOT here ===
#
# All API keys and tokens (Anthropic, OpenAI, OpenRouter, Nylas, Tavily, the HTTP
# API_TOKEN, WEB_APP_BOOTSTRAP_SECRET, Signal number, CEO inbox grant) live in the
# encrypted secrets vault, not in this file. `pnpm run setup` seeds them after
# migrations. To add or update one later, set it transiently and seed it:
#
#   NYLAS_API_KEY=nyk_... pnpm run seed-vault
#
# Only the four values below — needed to reach and unlock the vault itself — and
# non-secret config live in .env.
```

- [ ] **Step 2: Confirm only the four secrets + non-secret config remain**

Run: `grep -nE '^[A-Z]' /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration/.env.example`
Expected: only `DB_USER`, `DB_PASSWORD`, `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`, `LOG_LEVEL`, `TIMEZONE`, `CEO_SIGNAL_NUMBER` as active (uncommented) keys; the rest commented or removed.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration add .env.example
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration commit -m "chore: remove migrated secrets from .env.example, document vault-only (#911)"
```

---

### Task 5: Docs + ADR

**Files:**
- Modify: `docs/dev/setup.md`, `docs/dev/configuration.md`
- Create: `docs/adr/021-vault-only-secret-resolution.md`
- Modify: `docs/adr/README.md`

- [ ] **Step 1: Update `docs/dev/configuration.md`**

Add a "Secrets (vault-only)" section stating: secrets resolve from the encrypted vault only — there is no env fallback; the four bootstrap values (`DB_USER`, `DB_PASSWORD`, `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`) stay in `.env`; everything else is seeded via `pnpm run setup` (fresh) or `pnpm run seed-vault` (add/update one secret with a transient env var); a missing required secret fails closed at its consumer, an optional one disables its feature.

- [ ] **Step 2: Update `docs/dev/setup.md`**

Note that setup auto-seeds the vault after migrations, and how to add a secret afterward (`VAR=value pnpm run seed-vault`).

- [ ] **Step 3: Write the ADR**

Create `docs/adr/021-vault-only-secret-resolution.md` from `docs/adr/template.md`. Context: #542 shipped the vault with an env fallback for safe rollout; #911 removes the plaintext. Decision: vault-only resolution with no env fallback for all secrets except the four that bootstrap the vault; rejected the overlay-with-env-fallback because a silent vault/env divergence is a debugging hazard and leaves plaintext on disk. Consequences: fresh installs must seed the vault before first boot (handled by setup.sh); rollout order matters for existing deployments (seed before deploying vault-only code); bootstrap secret reads are not audited (verified by row existence).

- [ ] **Step 4: Add the ADR row**

Add a row for ADR-021 to `docs/adr/README.md`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration add docs/dev/setup.md docs/dev/configuration.md docs/adr/021-vault-only-secret-resolution.md docs/adr/README.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration commit -m "docs: vault-only secret resolution + ADR-021 (#911)"
```

---

### Task 6: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Add a Security entry**

Under `## [Unreleased]`, in a `### Security` subsection:

```markdown
- **Secrets vault migration** — API keys and tokens now resolve from the encrypted vault only (no `.env` fallback); a `seed-vault` script and `setup.sh` seed it, and only the four DB/encryption bootstrap values remain in `.env`. (#911)
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-vault-migration commit -m "docs: changelog for vault secret migration (#911)"
```

---

### Task 7: Existing-deployment migration runbook + live verification

This task is operational — performed once against the running deployment by Joseph (devops; needs step-by-step). Capture it as a runbook section in `docs/dev/setup.md` (or a `docs/runbooks/` doc if that's the convention) and execute it with him.

- [ ] **Step 1: Document the ordered migration runbook**

```
1. Deploy the new build to a place where `pnpm run seed-vault` can run, but DO NOT
   restart the app on the new vault-only code yet. The current .env still holds all secrets.
2. With the existing .env present, run:  pnpm run seed-vault
   (reads current env values → upserts into the vault). Confirm the logged `seeded`
   list contains all 12 names you expect; `skipped` should only be genuinely-unset ones.
3. Verify the vault rows exist (bootstrap-only secrets are not audited, so check rows):
     SELECT name FROM secrets ORDER BY name;
4. Restart the app on the new code. applyVaultSecrets now sources config from the vault.
   Confirm the boot log "Resolved bootstrap secrets from vault" shows the expected
   `present` map, and that email/Signal/agents work.
5. Confirm a skill read flips to vault in the audit log:
     SELECT payload->>'source' FROM events
      WHERE type='secret.accessed' AND payload->>'secretName'='nylas_api_key'
      ORDER BY created_at DESC LIMIT 1;   -- expect 'vault'
6. Only now, remove the 12 migrated vars from .env. Restart once more and reconfirm.
   (Rollback: if anything is wrong before step 6, the old .env still has every value —
   redeploy the previous build to restore env-based resolution.)
```

- [ ] **Step 2: Execute with Joseph and verify**

Run the runbook against the live deployment; confirm steps 3-5 outputs. Do not delete from the live `.env` until the audit `source: 'vault'` check passes.

---

## Self-Review

**Spec coverage (issue #911 acceptance criteria):**
- Four env-only secrets documented → Task 4, Task 5 (ADR), Task 1 list. ✅
- Skill secrets in vault + removed from `.env`/`.env.example` → Task 1 (seed), Task 4. ✅
- Bootstrap secrets via `applyVaultSecrets`, removed from env; `loadConfig` no longer reads them → Task 2. ✅
- `secret.accessed` source='vault' for skill secrets → Task 7 step 5 verification (no code change needed; #542 already emits it). ✅
- Bootstrap-only secrets verified by row existence, unaudited → Task 7 step 3. ✅
- seed-vault committed, registered, run by setup.sh; write_env trimmed → Task 1, Task 3. ✅
- Setup/config docs + ADR → Task 5. ✅
- No skill/channel regresses, suite green → Task 2 step 10, Task 7. ✅
- `approval-expiry-sweep` bypass unaffected → CEO_PRIMARY_EMAIL stays in `.env`; no change. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code. Docs tasks (5) describe content rather than full prose — acceptable for doc edits, but the ADR/section intent is specified.

**Type consistency:** `SEED_SECRET_NAMES` (Task 1) used in Task 1 test. `applyVaultSecrets(config, secrets, logger)` signature consistent across Task 2 test, impl, and the index.ts call. `seedVault(secrets, env, log)` consistent between script and test. Config field names match `src/config.ts:36-69`. ✅

**Known risk flagged:** rollout ordering (seed before vault-only boot) is the one operational footgun — called out at the top and in Task 7.
