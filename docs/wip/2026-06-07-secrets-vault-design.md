# Design: Encrypted secrets vault backed by PostgreSQL

**Issue:** [#542](https://github.com/josephfung/curia/issues/542)
**Date:** 2026-06-07
**Status:** Approved — ready for implementation plan

---

## Summary

Replace the env-var-per-secret pattern with a general-purpose, application-encrypted
secrets vault stored in PostgreSQL. The vault serves channels, skills, and any future
feature needing secure credential storage. A single `SECRET_ENCRYPTION_KEY` env var
unlocks all stored secrets; a DB dump without the key reveals nothing.

The existing `ctx.secret('name')` API is **unchanged** (stays synchronous), and an
env-var fallback allows incremental migration with no big-bang cutover.

---

## Key design decisions

These were settled during brainstorming and shape everything below:

1. **Structural typing, not semantic typing.** The vault stores values by *encoding*
   (`string` | `json`), never by *purpose* (no `oauth` type). OAuth token sets and
   browser sessions are both just `json` secrets whose shape is a convention owned by
   the consumer (a future OAuth channel, the browser channel) — the vault never names
   them. This means new structured-secret kinds need **no migration**.

2. **No OAuth logic in this PR.** There are no live OAuth channels yet. The vault stores
   and retrieves token sets as JSON; refresh is the future consumer's responsibility.
   We do not build a generic OAuth2 refresh flow against a consumer that doesn't exist.

3. **`ctx.secret()` stays synchronous** via a per-invocation pre-warm cache. A DB read is
   async; rather than break ~15 skill handlers by making `secret()` return a Promise, we
   async-load all manifest-declared secrets into an in-memory map at the start of each
   `invoke()`, and `ctx.secret()` reads that map synchronously with the exact current
   throw semantics.

4. **Key required at every startup.** Missing/malformed `SECRET_ENCRYPTION_KEY` is a
   hard startup failure in every environment (fail closed). Dev/test/CI set a fixed key.

5. **Env fallback during transition, with an audit `source` tag.** If a secret has no
   vault row, fall back to `process.env`. The `secret.accessed` audit event gains an
   optional `source: 'vault' | 'env'` field so the audit trail shows migration progress.

6. **Defer binary.** `value_format` is `CHECK (value_format IN ('string','json'))`.
   `string` + `json` covers every secret we can name today (API keys, PEM keys, OAuth
   token sets, browser sessions, service-account blobs). A true binary blob, if it ever
   appears, is a one-line `ALTER ... DROP/ADD CONSTRAINT` migration plus base64 handling.

---

## Architecture

A small new `src/secrets/` module with two units, wired into the existing bootstrap and
execution path. No changes to the five-layer bus architecture.

```
src/secrets/
  crypto.ts            # pure AES-256-GCM encrypt/decrypt + key loading
  secrets-service.ts   # DB-backed CRUD over the encrypted `secrets` table
```

### Component 1: crypto (`src/secrets/crypto.ts`)

Pure, dependency-free functions over `node:crypto`. No DB, no logging, no global state —
trivially unit-testable.

- **`loadEncryptionKey(env = process.env): Buffer`**
  Reads `SECRET_ENCRYPTION_KEY`, base64-decodes, asserts the result is exactly 32 bytes.
  Throws a clear, actionable error on missing/wrong-length input, including the hint
  `openssl rand -base64 32`. Called once at startup so a bad key kills the process early.

- **`encrypt(plaintext: string, key: Buffer): { ciphertext: string; iv: string }`**
  Generates a fresh random 12-byte IV per call. AES-256-GCM. The 16-byte GCM auth tag is
  appended to the ciphertext bytes before base64-encoding (stored together in
  `encrypted_value`); `iv` is returned base64 separately.

- **`decrypt(ciphertext: string, iv: string, key: Buffer): string`**
  Splits the auth tag off the end, sets it on the decipher, verifies, returns plaintext.
  A wrong key or tampered ciphertext throws (GCM auth failure) — never returns garbage.

**Dependencies:** `node:crypto` only.

### Component 2: SecretsService (`src/secrets/secrets-service.ts`)

DB-backed store. Constructor-injected `(pool: DbPool, key: Buffer, logger: Logger)`,
matching the existing `AutonomyService` pattern. All queries parameterized.

| Method | Behavior |
|---|---|
| `get(name): Promise<string \| null>` | Fetch row, decrypt, return raw string. `null` if no row. Works for any `value_format` (a `json` row returns its serialized text). |
| `getJSON<T>(name): Promise<T \| null>` | Fetch row; assert `value_format = 'json'` (throw if mismatch); decrypt + `JSON.parse`. `null` if no row. |
| `set(name, value: string): Promise<void>` | Encrypt; upsert with `value_format='string'` (fresh IV each write); bump `updated_at`. |
| `setJSON(name, obj): Promise<void>` | `JSON.stringify`; encrypt; upsert with `value_format='json'`. |
| `delete(name): Promise<void>` | Delete row. |

No OAuth/browser vocabulary anywhere in the service. The service **does not** fire audit
events — the execution-layer closure remains the single audit boundary (see below).

**Dependencies:** `crypto.ts`, `DbPool`, `Logger`.

### Component 3: execution-layer bridge (`src/skills/execution.ts`)

The only change to the existing hot path. `SecretsService` is injected into
`ExecutionLayer`'s constructor options (optional, for test friendliness).

At the **top of `invoke()`**, pre-warm a per-invocation cache:

```text
warmCache: Map<string, { value: string; source: 'vault' | 'env' }>
for each name in manifest.secrets:
    v = await secretsService?.get(name)        // vault first
    if v != null:  warmCache.set(name, { value: v, source: 'vault' })
    else:
        envVal = process.env[name.toUpperCase()]
        if envVal:  warmCache.set(name, { value: envVal, source: 'env' })
        // missing in both → not added; ctx.secret throws lazily on access (current behavior)
```

`ctx.secret(name)` stays **synchronous** with semantics identical to today:

- `name` not in `manifest.secrets` → throw `Secret '<name>' is not declared in the manifest...` (unchanged)
- `name` in `warmCache` → return `value`; fire `secret.accessed` with `source` (fire-and-forget, unchanged failure logging)
- `name` declared but not in `warmCache` (missing in both vault and env) → throw `Secret '<name>' is declared but not set in the environment` (unchanged)

This preserves the lazy-throw-on-access contract exactly, so the deliberate
`process.env` bypass in `approval-expiry-sweep` (which never calls `ctx.secret()`) is
unaffected, and skills that declare-but-conditionally-use a secret keep working.

### Component 4: audit event (`src/bus/events.ts`)

Add an **optional** `source?: 'vault' | 'env'` to `SecretAccessedPayload` and the
`createSecretAccessed()` factory. Backward-compatible (existing callers omit it). The
execution closure passes the source from the warm-cache entry. This is a public
API-surface change to a bus event type — note it in the changelog.

### Component 5: startup wiring (`src/index.ts`, `src/config.ts`)

- Call `loadEncryptionKey()` early in bootstrap (alongside other hard-fail checks like
  `ANTHROPIC_API_KEY`). On failure: `logger.fatal(...); process.exit(1)`.
- Construct `SecretsService(pool, key, logger)` after the DB pool, before `ExecutionLayer`.
- Inject it into `ExecutionLayer`.

### Component 6: setup script + env example

Auto-generate the key during first-time setup, exactly like `API_TOKEN`:

- `scripts/setup.sh` → `generate_secrets()`: add
  `SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)` (base64, not hex — matches the
  32-byte key format the loader expects).
- `scripts/setup.sh` → `write_env()`: add a sed substitution line for
  `SECRET_ENCRYPTION_KEY`.
- `.env.example`: add a `SECRET_ENCRYPTION_KEY=` line with a comment
  (`# 32 random bytes, base64. Generate: openssl rand -base64 32`).
- Test/CI env: add a fixed, non-secret test key so the suite boots.

---

## Data schema

Migration `050_create_secrets_vault.sql` (verify `050` is still the next free prefix at
merge time — see the migration-numbering rebase hazard in CLAUDE.md).

```sql
-- Up Migration
CREATE TABLE secrets (
  name            TEXT PRIMARY KEY,
  value_format    TEXT NOT NULL CHECK (value_format IN ('string', 'json')),
  encrypted_value TEXT NOT NULL,  -- base64( AES-256-GCM ciphertext || 16-byte auth tag )
  iv              TEXT NOT NULL,  -- base64, fresh 12 bytes per write
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE secrets;
```

No plaintext expiry column, no separate `oauth_tokens` table — both rejected in favor of
the structural-typing design (an OAuth token set is a `json` secret whose
`{ access_token, refresh_token, expiry, scope }` shape lives with its consumer).

---

## Data flow

**Skill reads a secret (steady state):**
```
agent invokes skill
  → ExecutionLayer.invoke() pre-warms cache: secretsService.get(name) for each declared secret
  → handler calls ctx.secret('nylas_api_key')
  → closure returns cached value + publishes secret.accessed { source: 'vault' }
  → AuditLogger persists the event to audit_log (write-ahead)
```

**Migrating a secret from env to vault:** operator calls `secretsService.set('nylas_api_key', value)`
once (via install flow / script / REPL). Next invocation, the pre-warm finds the vault row,
`source` flips from `env` to `vault` in the audit trail. The env var can then be removed.

**Storing a structured secret (future OAuth channel / browser session):**
`secretsService.setJSON('curia_browser_session', storageState)` →
`getJSON('curia_browser_session')` returns the parsed object. The vault is agnostic to
the shape.

---

## Key rotation

`scripts/rotate-secret-key.ts`:
- Reads `OLD` and `NEW` base64 keys from env (or args).
- In a single transaction: for every row, decrypt with old key, re-encrypt with new key
  (fresh IV), update `encrypted_value` + `iv`.
- Idempotent-safe: if interrupted, the transaction rolls back; rerun.

Documented in a short runbook note: generate new key → run script → swap
`SECRET_ENCRYPTION_KEY` in `.env` → restart.

---

## Error handling

- **Missing/bad key at startup:** hard fail, `process.exit(1)`, clear message + generate hint.
- **Decrypt failure (wrong key / tampered row):** GCM throws; `SecretsService.get` lets it
  propagate (do not swallow — a decryption failure is a real, loud problem). Logged with
  the secret `name` (never the value).
- **Secret missing in vault and env:** unchanged behavior — `ctx.secret()` throws the
  existing "declared but not set" error lazily on access.
- **`getJSON` on a `string` row (or vice versa):** throw a clear type-mismatch error.
- No empty catches; no silent fallbacks beyond the explicit, audited env fallback.

---

## Testing (TDD — tests first)

**Unit — `src/secrets/crypto.test.ts`:**
- `encrypt` → `decrypt` round-trip returns original plaintext.
- Different IV per call (two encrypts of same plaintext differ).
- `decrypt` with wrong key throws (GCM auth failure), does not return garbage.
- `decrypt` of tampered ciphertext throws.
- `loadEncryptionKey`: valid 32-byte base64 → Buffer; missing → throws with hint;
  wrong-length → throws.

**Integration — `tests/integration/secrets-service.test.ts`** (`describeIf(DATABASE_URL)`):
- `set` then `get` round-trips a string; stored `encrypted_value` ≠ plaintext.
- `setJSON` then `getJSON` round-trips an object (incl. an OAuth-shaped and a
  browser-session-shaped object, to prove generality).
- `get` on `json` row returns serialized text; `getJSON` on `string` row throws.
- `delete` removes the row; `get` then returns `null`.
- Cleanup: `DELETE FROM secrets` in `afterAll`.

**Unit — execution layer (`src/skills/execution.ts` tests):**
- Pre-warm reads from vault when present (`source: 'vault'`).
- Falls back to env when no vault row (`source: 'env'`).
- `secret.accessed` fires with the correct `source`.
- Undeclared secret throws; declared-but-absent throws lazily on access.

---

## Out of scope (unchanged from issue)

- Web UI for managing vault entries (handled via channel/skill install flows).
- Multi-key / envelope encryption (single key sufficient for v1).
- HashiCorp Vault / KMS integration (the `SecretsService` interface keeps it swappable).
- Migrating existing secrets in this PR (env fallback enables incremental migration).
- Any OAuth refresh logic (the future OAuth channel owns it).

---

## Changelog / versioning notes

- **Added** — secrets vault (`secrets` table, `SecretsService`, AES-256-GCM crypto),
  `SECRET_ENCRYPTION_KEY` auto-generated by setup.
- **Changed** — `secret.accessed` event gains optional `source` field (public bus-event
  surface; called out per CLAUDE.md).
- An **ADR** is warranted: "application-layer AES-256-GCM vault in PostgreSQL over
  env-vars / external KMS" documents the choice and the structural-typing rationale.
