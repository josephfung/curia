# Channel vault → adapter wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make channel credentials saved via the Channels UI (`channel.*` vault keys) actually reach the email/signal adapters, so the registry's `enabled + resolvable` state and real adapter boot agree.

**Architecture:** A new boot-time function `applyChannelVaultSecrets` overlays the five channel-scoped vault keys onto `config.*` (channel-vault ▸ env ▸ current config), run right after `applyVaultSecrets` and before any consumer reads config. Everything downstream (adapters, outbound gateway, calendar client, registry gate) then reads consistent values. No per-construction-site patching.

**Tech Stack:** TypeScript (ESM, Node 24+), Vitest, pino.

## Global Constraints

- ESM only — `.js` extensions on all relative imports; `import type` for type-only imports.
- No `any`. No `console.log` (pino only). No empty catch blocks.
- Never log secret values — log a names-only `present` map.
- The overlay reads a **fixed 5-key allowlist** of `channel.*` keys. NEVER `secrets.list()`, never a prefix scan. (Keeps `user.*` specialist secrets and dot-free skill/system secrets structurally untouchable.)
- Precedence (confirmed): channel-scoped vault ▸ env (`envFallback`) ▸ current config value.
- Apply timing: restart-to-apply. No adapter hot-reload.
- Run typecheck with `pnpm -C <worktree> run typecheck` before each commit touching `.ts`.
- CHANGELOG.md must be updated under `## [Unreleased]` before the PR.

The five mapped credentials (config field ← vault key ▸ env var), per `src/channels/catalog.ts`:

| config field | vault key | env var |
|---|---|---|
| `nylasApiKey` | `channel.email.nylas_api_key` | `NYLAS_API_KEY` |
| `nylasGrantId` | `channel.email.nylas_grant_id` | `NYLAS_GRANT_ID` |
| `nylasSelfEmail` | `channel.email.nylas_self_email` | `NYLAS_SELF_EMAIL` |
| `signalPhoneNumber` | `channel.signal.phone_number` | `SIGNAL_PHONE_NUMBER` |
| `signalSocketPath` | `channel.signal.socket_path` | `SIGNAL_SOCKET_PATH` |

---

## File Structure

- **Create** `src/channels/apply-channel-vault-secrets.ts` — the overlay function (single responsibility: resolve the 5 channel creds onto config).
- **Create** `src/channels/apply-channel-vault-secrets.test.ts` — unit tests + four-combo agreement tests.
- **Modify** `src/index.ts` (~L313) — call the overlay right after `applyVaultSecrets`.
- **Modify** `apps/console/src/pages/ChannelSettings.tsx` (~L218-232) — restart-to-apply hint under Credentials.
- **Modify** `CHANGELOG.md` — Fixed entry.

---

### Task 1: `applyChannelVaultSecrets` overlay function

**Files:**
- Create: `src/channels/apply-channel-vault-secrets.ts`
- Test: `src/channels/apply-channel-vault-secrets.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config.ts`), `Logger` (`src/logger.ts`), `channelCredentialStatus` + `getChannelDescriptor` (`src/channels/credential-resolver.ts`, `src/channels/catalog.ts`) and `resolveChannelAccounts` (`src/config.ts`) — for agreement tests only.
- Produces: `export async function applyChannelVaultSecrets(config: Config, secrets: { get(name: string): Promise<string | null> }, env: Record<string, string | undefined>, logger: Logger): Promise<void>` — mutates `config` in place, returns nothing.

- [ ] **Step 1: Write the failing tests**

Create `src/channels/apply-channel-vault-secrets.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Config } from '../config.js';
import type { YamlConfig } from '../config.js';
import { resolveChannelAccounts } from '../config.js';
import { channelCredentialStatus } from './credential-resolver.js';
import { getChannelDescriptor } from './catalog.js';
import { applyChannelVaultSecrets } from './apply-channel-vault-secrets.js';

const logger = pino({ level: 'silent' });

// Minimal config covering every field the overlay touches (mirrors apply-vault-secrets.test.ts).
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
  } as Config;
}

// A vault fake whose get() is a spy, so tests can assert exactly which keys were read.
function fakeSecrets(values: Record<string, string>) {
  return { get: vi.fn(async (name: string) => values[name] ?? null) };
}

describe('applyChannelVaultSecrets', () => {
  it('populates config from vault-only channel.email.* / channel.signal.* keys', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({
      'channel.email.nylas_api_key': 'nyk_vault',
      'channel.email.nylas_grant_id': 'grant_vault',
      'channel.email.nylas_self_email': 'curia@vault.test',
      'channel.signal.phone_number': '+15550001111',
      'channel.signal.socket_path': '/run/signal/socket',
    });

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    expect(config.nylasApiKey).toBe('nyk_vault');
    expect(config.nylasGrantId).toBe('grant_vault');
    expect(config.nylasSelfEmail).toBe('curia@vault.test');
    expect(config.signalPhoneNumber).toBe('+15550001111');
    expect(config.signalSocketPath).toBe('/run/signal/socket');
  });

  it('falls back to env when the vault is empty', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({});
    const env = {
      NYLAS_API_KEY: 'nyk_env',
      NYLAS_GRANT_ID: 'grant_env',
      NYLAS_SELF_EMAIL: 'curia@env.test',
      SIGNAL_PHONE_NUMBER: '+15550002222',
      SIGNAL_SOCKET_PATH: '/env/signal/socket',
    };

    await applyChannelVaultSecrets(config, secrets, env, logger);

    expect(config.nylasApiKey).toBe('nyk_env');
    expect(config.signalSocketPath).toBe('/env/signal/socket');
  });

  it('channel vault wins over env when both are present', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({ 'channel.email.nylas_api_key': 'nyk_vault' });
    const env = { NYLAS_API_KEY: 'nyk_env' };

    await applyChannelVaultSecrets(config, secrets, env, logger);

    expect(config.nylasApiKey).toBe('nyk_vault');
  });

  it('keeps the current config value when neither vault nor env supplies one', async () => {
    const config = baseConfig();
    config.nylasApiKey = 'nyk_bootstrap'; // e.g. already set by applyVaultSecrets
    const secrets = fakeSecrets({});

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    expect(config.nylasApiKey).toBe('nyk_bootstrap');
    expect(config.nylasGrantId).toBeUndefined();
    expect(config.nylasSelfEmail).toBe(''); // string-typed field stays ''
    expect(config.signalSocketPath).toBeUndefined();
  });

  it('treats a whitespace-only vault value as absent and falls through', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({ 'channel.email.nylas_api_key': '   ' });
    const env = { NYLAS_API_KEY: 'nyk_env' };

    await applyChannelVaultSecrets(config, secrets, env, logger);

    expect(config.nylasApiKey).toBe('nyk_env');
  });

  it('treats a vault read error as absent (no throw)', async () => {
    const config = baseConfig();
    const secrets = {
      get: vi.fn(async (name: string) => {
        if (name === 'channel.email.nylas_api_key') throw new Error('vault down');
        return null;
      }),
    };
    const env = { NYLAS_API_KEY: 'nyk_env' };

    await expect(applyChannelVaultSecrets(config, secrets, env, logger)).resolves.toBeUndefined();
    expect(config.nylasApiKey).toBe('nyk_env');
  });

  it('reads ONLY the five named channel.* keys — never list(), never user.* / dot-free keys', async () => {
    const config = baseConfig();
    const secrets = fakeSecrets({});

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    const readKeys = secrets.get.mock.calls.map(c => c[0]).sort();
    expect(readKeys).toEqual([
      'channel.email.nylas_api_key',
      'channel.email.nylas_grant_id',
      'channel.email.nylas_self_email',
      'channel.signal.phone_number',
      'channel.signal.socket_path',
    ]);
    // No list() method should even be invoked (the fake doesn't have one).
    expect('list' in secrets).toBe(false);
  });
});

// AC1: the registry gate and the adapter wiring agree across all four source combinations.
describe('applyChannelVaultSecrets — gate/adapter agreement (AC1)', () => {
  const emailDesc = getChannelDescriptor('email')!;
  const emptyYaml = {} as unknown as YamlConfig; // resolveChannelAccounts only reads channel_accounts

  it('vault-only email: adapter constructs AND registry reports resolvable', async () => {
    const config = baseConfig();
    const vault = {
      'channel.email.nylas_api_key': 'nyk_vault',
      'channel.email.nylas_grant_id': 'grant_vault',
      'channel.email.nylas_self_email': 'curia@vault.test',
    };
    const secrets = fakeSecrets(vault);

    await applyChannelVaultSecrets(config, secrets, {}, logger);

    // Adapter path: config is populated → legacy single-account synthesis yields one account.
    const accounts = resolveChannelAccounts(emptyYaml, config);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('curia');
    expect(config.nylasApiKey).toBe('nyk_vault');

    // Gate path: registry resolves the same vault keys → resolvable.
    const status = await channelCredentialStatus({ secrets: fakeSecrets(vault), env: {} }, emailDesc);
    expect(status.requiredResolvable).toBe(true);
  });

  it('neither: adapter skips AND registry reports not resolvable', async () => {
    const config = baseConfig();
    await applyChannelVaultSecrets(config, fakeSecrets({}), {}, logger);

    expect(resolveChannelAccounts(emptyYaml, config)).toHaveLength(0);
    const status = await channelCredentialStatus({ secrets: fakeSecrets({}), env: {} }, emailDesc);
    expect(status.requiredResolvable).toBe(false);
  });

  it('both: channel vault wins for the adapter, registry agrees (resolvable)', async () => {
    const config = baseConfig();
    const vault = {
      'channel.email.nylas_api_key': 'nyk_vault',
      'channel.email.nylas_grant_id': 'grant_vault',
      'channel.email.nylas_self_email': 'curia@vault.test',
    };
    const env = { NYLAS_API_KEY: 'nyk_env', NYLAS_GRANT_ID: 'grant_env', NYLAS_SELF_EMAIL: 'curia@env.test' };

    await applyChannelVaultSecrets(config, fakeSecrets(vault), env, logger);

    expect(config.nylasApiKey).toBe('nyk_vault'); // vault wins
    const status = await channelCredentialStatus({ secrets: fakeSecrets(vault), env }, emailDesc);
    expect(status.requiredResolvable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 exec vitest run src/channels/apply-channel-vault-secrets.test.ts`
Expected: FAIL — cannot find module `./apply-channel-vault-secrets.js`.

- [ ] **Step 3: Write the implementation**

Create `src/channels/apply-channel-vault-secrets.ts`:

```ts
// apply-channel-vault-secrets.ts — overlays the channel-scoped vault credentials
// (channel.email.* / channel.signal.*, written by the Channels UI) onto Config, so
// the email/signal adapters actually boot from creds configured entirely through the
// console (#964). Closes the seam where the registry gate read channel.* but the
// adapters read config (populated only from the unprefixed bootstrap keys / env).
//
// Runs right after applyVaultSecrets() and before any config consumer (resolveChannelAccounts,
// nylasClientMap, outbound gateway). Precedence per field mirrors the registry resolver
// (channelCredentialStatus): channel.<name>.<key> (vault) ▸ env (catalog envFallback) ▸
// the current config value (which already carries the bootstrap-vault result). Because the
// precedence matches the gate, "enabled + resolvable" and actual adapter boot agree.
//
// NAMESPACE SAFETY (do not relax): this reads a FIXED allowlist of five channel.* keys.
// It must never call secrets.list() or scan by prefix — that keeps user.* (agent-captured)
// secrets and dot-free skill/system secrets structurally out of reach.
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

/** Narrow view of the vault — only get() is needed (and only get() must ever be called). */
interface ChannelSecretsPort {
  get(name: string): Promise<string | null>;
}

/** Trim; collapse a blank/whitespace-only value to undefined (absent). Matches applyVaultSecrets. */
function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Read one vault key, isolated: a transient failure logs and reads as absent, never aborts boot. */
async function readVaultKey(
  secrets: ChannelSecretsPort,
  key: string,
  logger: Logger,
): Promise<string | undefined> {
  try {
    return clean(await secrets.get(key));
  } catch (err) {
    logger.warn({ err, key }, 'channel credential vault read failed; treating as missing and falling back to env/config');
    return undefined;
  }
}

export async function applyChannelVaultSecrets(
  config: Config,
  secrets: ChannelSecretsPort,
  env: Record<string, string | undefined>,
  logger: Logger,
): Promise<void> {
  // Resolve channel-vault ▸ env ▸ current-config for one field. Reads are concurrent.
  const resolve = async (
    vaultKey: string,
    envVar: string,
    current: string | undefined,
  ): Promise<string | undefined> =>
    (await readVaultKey(secrets, vaultKey, logger)) ?? clean(env[envVar]) ?? clean(current);

  const [nylasApiKey, nylasGrantId, nylasSelfEmail, signalPhoneNumber, signalSocketPath] =
    await Promise.all([
      resolve('channel.email.nylas_api_key', 'NYLAS_API_KEY', config.nylasApiKey),
      resolve('channel.email.nylas_grant_id', 'NYLAS_GRANT_ID', config.nylasGrantId),
      resolve('channel.email.nylas_self_email', 'NYLAS_SELF_EMAIL', config.nylasSelfEmail),
      resolve('channel.signal.phone_number', 'SIGNAL_PHONE_NUMBER', config.signalPhoneNumber),
      resolve('channel.signal.socket_path', 'SIGNAL_SOCKET_PATH', config.signalSocketPath),
    ]);

  config.nylasApiKey = nylasApiKey;
  config.nylasGrantId = nylasGrantId;
  // nylasSelfEmail is typed `string` (defaults to ''), matching loadConfig/applyVaultSecrets.
  config.nylasSelfEmail = nylasSelfEmail ?? '';
  config.signalPhoneNumber = signalPhoneNumber;
  config.signalSocketPath = signalSocketPath;

  // Names only — never values. Lets an operator confirm which channel creds the vault/env
  // supplied vs. which are absent (feature-off), the same debuggability win as applyVaultSecrets.
  const present = {
    'channel.email.nylas_api_key': nylasApiKey !== undefined,
    'channel.email.nylas_grant_id': nylasGrantId !== undefined,
    'channel.email.nylas_self_email': nylasSelfEmail !== undefined,
    'channel.signal.phone_number': signalPhoneNumber !== undefined,
    'channel.signal.socket_path': signalSocketPath !== undefined,
  };
  logger.info({ present }, 'Applied channel credentials onto config (vault ▸ env ▸ config)');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 exec vitest run src/channels/apply-channel-vault-secrets.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 add src/channels/apply-channel-vault-secrets.ts src/channels/apply-channel-vault-secrets.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 commit -m "feat: overlay channel-scoped vault creds onto config (#964)"
```

---

### Task 2: Wire the overlay into bootstrap

**Files:**
- Modify: `src/index.ts` (~L106 import, ~L313 call site)

**Interfaces:**
- Consumes: `applyChannelVaultSecrets` (Task 1).

- [ ] **Step 1: Add the import**

In `src/index.ts`, next to the existing `applyVaultSecrets` import (L106):

```ts
import { applyVaultSecrets } from './secrets/apply-vault-secrets.js';
import { applyChannelVaultSecrets } from './channels/apply-channel-vault-secrets.js';
```

- [ ] **Step 2: Call it right after applyVaultSecrets**

Find the existing block (L312-317):

```ts
  try {
    await applyVaultSecrets(config, secretsService, logger);
  } catch (err) {
    logger.fatal({ err }, 'Failed to resolve bootstrap secrets from vault');
    process.exit(1);
  }
```

Replace with:

```ts
  try {
    await applyVaultSecrets(config, secretsService, logger);
    // Overlay channel-scoped vault creds (channel.email.* / channel.signal.*, written by the
    // Channels UI) onto config so the email/signal adapters boot from console-configured
    // creds. Same fatal-on-error contract as applyVaultSecrets. Must run before
    // resolveChannelAccounts and adapter/gateway construction below. (#964)
    await applyChannelVaultSecrets(config, secretsService, process.env, logger);
  } catch (err) {
    logger.fatal({ err }, 'Failed to resolve bootstrap secrets from vault');
    process.exit(1);
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 run typecheck`
Expected: no errors.

- [ ] **Step 4: Run the full channels test suite (no regressions)**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 exec vitest run src/channels/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 add src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 commit -m "feat: apply channel vault creds at boot before adapter wiring (#964)"
```

---

### Task 3: Console — restart-to-apply hint under Credentials (AC4)

**Files:**
- Modify: `apps/console/src/pages/ChannelSettings.tsx` (~L218-232, the Credentials `form-field`)

**Interfaces:** none (copy-only change).

- [ ] **Step 1: Add the hint line**

In the Credentials `form-field` block, add a sub-note under the `<label>Credentials</label>`:

```tsx
          {/* Credential form — only for toggleable channels that declare fields.
              Always-on channels (http, cli) have no credentials. */}
          {!locked && entry.credentialFields.length > 0 && (
            <div className="form-field">
              <label>Credentials</label>
              <p className="settings-page-sub" style={{ margin: '0 0 4px' }}>
                Saved credentials take effect on the next restart.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {entry.credentialFields.map(field => (
                  <CredentialRow
                    key={field.key}
                    channel={entry.name}
                    field={field}
                    onSaved={onChanged}
                  />
                ))}
              </div>
            </div>
          )}
```

- [ ] **Step 2: Typecheck the console package**

Run: `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964/apps/console run typecheck`
Expected: no errors. (If the console has no `typecheck` script, run the repo-root `pnpm -C <worktree> run typecheck`, which covers the workspace.)

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 add apps/console/src/pages/ChannelSettings.tsx
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 commit -m "feat: note channel creds apply on restart in console (#964)"
```

---

### Task 4: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`, `### Fixed`)

- [ ] **Step 1: Add the entry**

Under `## [Unreleased]` → `### Fixed` (create the `### Fixed` subsection if absent):

```markdown
- **Channel registry** — email/signal creds saved via the Channels UI (`channel.*` vault keys) now actually wire up the adapter at boot; the registry's `enabled + resolvable` state and real adapter boot can no longer disagree. (#964)
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-channel-vault-964 commit -m "docs: changelog for #964"
```

---

## Self-Review

**Spec coverage:**
- Overlay function + precedence + clean/error handling → Task 1.
- Namespace-safety invariant + test → Task 1 (Step 1 "reads ONLY the five named keys" test; Step 3 comment).
- Single source of truth / boot wiring before consumers → Task 2.
- Four-combo gate/adapter agreement (AC1) → Task 1 agreement describe block.
- Existing env/config deployments unchanged (AC2) → Task 1 env-only + neither tests; env tier preserved.
- Unit + integration coverage (AC3) → Task 1.
- Console no-op save path (AC4) → Task 3.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `applyChannelVaultSecrets(config, secrets, env, logger)` signature identical across Tasks 1-2. `clean` / `readVaultKey` are file-private. Config field names (`nylasApiKey`, `nylasGrantId`, `nylasSelfEmail`, `signalPhoneNumber`, `signalSocketPath`) match `src/config.ts`. `nylasSelfEmail` handled as `string` (`?? ''`).

**Note on test runner:** uses `pnpm -C <worktree> exec vitest run <file>` for single files and `pnpm -C <worktree> run typecheck` for types, per project CLAUDE.md (worktree `-C`, never `--prefix`).
