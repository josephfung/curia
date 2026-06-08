# ADR-021: Vault-only secret resolution (no env fallback)

Date: 2026-06-08
Status: Accepted

## Context

[ADR-020](020-secrets-vault.md) shipped the encrypted secrets vault (#542) with a
deliberate env-var fallback: `ctx.secret()` and the bootstrap config readers checked
the vault first, then fell back to `process.env`. That fallback was a rollout
affordance — it let the vault land without simultaneously moving every secret out of
`.env`, so a half-migrated install still booted.

The fallback was always meant to be temporary. As long as it exists:

- Plaintext secrets keep living in `.env`, which is the exposure ADR-020 set out to
  remove. A compromised host still reads every credential from the process environment.
- A value can silently diverge between the vault and `.env` — the vault has the new
  key, `.env` still has the old one, and the fallback masks which one actually wins.
  That is a genuine debugging hazard ("why is it still using the old key?").

#911 removes the payoff: migrate every secret into the vault and delete the env
fallback. The open question this ADR settles is **what stays in `.env`** and **how
fresh installs avoid an empty-vault boot failure** once there's no fallback to cushion
them.

**Alternative considered — overlay with env fallback (vault-first, then `?? process.env`):**
Keep reading the vault first but retain the env fallback indefinitely. Rejected. It
perpetuates exactly the two problems above: plaintext lingers in `.env`, and a
vault/env divergence stays invisible because the fallback quietly resolves it. The
debuggability cost ("which copy am I actually using?") outweighs the small convenience
of a soft landing on a missing secret.

## Decision

**Vault-only resolution. No env fallback for any secret** — except the four values
that bootstrap the vault itself:

- `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` — needed to connect to the Postgres
  instance that *hosts* the vault.
- `SECRET_ENCRYPTION_KEY` — the AES-256-GCM key that *decrypts* the vault.

A secret cannot live in the vault it unlocks, so these four remain in `.env` by
necessity. (Non-secret config — `HTTP_PORT`, `LOG_LEVEL`, `TIMEZONE` — and identity
config — `CEO_PRIMARY_EMAIL`, `CEO_SIGNAL_NUMBER` — also stay in `.env`, but they are
not secrets and are out of scope here.)

Every other secret resolves from the vault only. There is no `?? process.env`.

**Two consumption paths:**

1. **Skill secrets via `ctx.secret()`** — already vault-first from ADR-020. #911 drops
   its env fallback so it is now vault-only. Skill reads still emit the
   `secret.accessed` audit event with `source: 'vault'`.
2. **Bootstrap/config secrets via `applyVaultSecrets(config, secretsService, logger)`**
   (`src/secrets/apply-vault-secrets.ts`). It runs in `src/index.ts` immediately after
   the vault is constructed and migrations have run, and overwrites the config secret
   fields (Anthropic, OpenAI, OpenRouter, API token, web-app bootstrap secret, Nylas
   trio, Signal number) from the vault. `loadConfig()` no longer reads any of these
   from env — `applyVaultSecrets` is the single place they enter `Config`.

**Seeding.** `scripts/seed-vault.ts` (`pnpm run seed-vault`) reads the current env
values and upserts every present one into the vault (`set()` is an idempotent upsert;
absent/empty values are skipped, never cleared). `setup.sh` runs it after migrations,
so a fresh install seeds the vault before the app's first boot and never faces an
empty vault. To add or update one secret later, supply it as a transient env var:
`VAR=value pnpm run seed-vault`.

**Why `ANTHROPIC_API_KEY` is not a special env exception.** It's tempting to keep
Anthropic in `.env` since "the app is useless without it." But it doesn't need to be:
the vault is constructed (and seeded, on fresh installs, by `setup.sh`) *before*
`applyVaultSecrets` reads Anthropic and before any provider consumes it. The
fresh-boot concern that would justify an exception is already solved by setup-time
seeding, so Anthropic lives in the vault like every other secret.

## Consequences

**Easier / safer:**

- `.env` shrinks to the four bootstrap values plus non-secret config. A compromised
  host no longer leaks API keys from the process environment — only the encryption key
  and DB credentials (which a host already needs to reach the data).
- No silent vault/env divergence. There is exactly one source of truth per secret, so
  "which copy is it using?" stops being a question.

**Accepted trade-offs / risks:**

- **Fresh installs must seed the vault before first boot.** Handled automatically by
  `setup.sh` (seed runs after migrations, before `docker compose up`). A from-scratch
  boot that skips `setup.sh` will fail closed on the first required secret.
- **Rollout order matters for existing deployments.** With no fallback to cushion an
  empty vault, you must run `seed-vault` (populating the vault from the live `.env`)
  *before* deploying the vault-only code. Deploy-then-seed would crash on boot.
- **Bootstrap (non-skill) secret reads are not audited.** This is a deliberate choice:
  `applyVaultSecrets` runs once at boot and is not part of the per-invocation skill
  path that the `secret.accessed` event covers. Bootstrap-only secrets are verified by
  checking the vault row exists, not via an audit event. Skill reads still audit with
  `source: 'vault'`.
- **A missing required secret fails closed.** Most secrets fail at their consumer (e.g.
  `anthropic_api_key`'s startup check). `api_token` is the exception that needed an
  explicit boot guard: its HTTP-auth consumer (`validateBearerToken`) fails *open* —
  no token configured means auth is disabled — so under vault-only resolution an absent
  row would silently expose the API. `src/index.ts` therefore refuses to boot when
  `api_token` is absent. As a second layer, `setup.sh` runs `seed-vault` with
  `SEED_VAULT_VERIFY=1`, which confirms the required rows (`anthropic_api_key`,
  `api_token`, `web_app_bootstrap_secret`) were actually persisted and aborts the install
  otherwise — closing the resume-path gap where a secret could be skipped. Optional
  secrets (OpenAI, OpenRouter, Signal) stay feature-gated by their existing `if (config.x)`
  guards, so their absence disables a feature rather than failing the boot.

## Known limitations

- **Multi-account YAML email is not covered.** When `channel_accounts.email` is
  configured in `config/local.yaml`, `resolveChannelAccounts()` (`src/config.ts`)
  resolves each account's `nylas_grant_id` / `self_email` via `resolveEnvValue()`,
  which reads `env:VAR` references straight from `process.env` — bypassing the vault.
  #911 only migrates the legacy single-account path (`config.nylasGrantId`). So
  "vault-only" is not whole-system true for multi-account YAML deployments. No such
  deployment is live yet; routing the `env:VAR` resolver through the vault is tracked
  as follow-up in #920.
- **Google Workspace OAuth secrets are deferred to #913.** They are not part of #911's
  migration and are tracked separately.
