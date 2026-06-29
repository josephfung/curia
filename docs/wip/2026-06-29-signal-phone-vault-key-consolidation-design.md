# Signal phone number — vault key consolidation

**Issue:** [#1140](https://github.com/josephfung/curia/issues/1140) — Signal phone number has two divergent vault keys (`signal_phone_number` vs `channel.signal.phone_number`)
**Date:** 2026-06-29
**Status:** Approved — ready for implementation plan

## Problem

The Signal phone number is read from two different vault keys by two different
code paths, and the two paths feed two different runtime *gates*:

| Gate | What it decides | Phone-number source |
| --- | --- | --- |
| **Registry gate** — `channelCredentialStatus()` → `channelShouldStart` (`src/channels/credential-resolver.ts`, `src/index.ts:1353,1375`) | Whether the **inbound** Signal adapter starts | `channel.signal.phone_number` (vault) ▸ `SIGNAL_PHONE_NUMBER` (env). **Never sees the flat key.** |
| **Adapter / outbound boot** — `config.signalPhoneNumber` (`src/index.ts:752,1305,1454`) | The Signal RPC client + OutboundGateway egress + agent context | flat `signal_phone_number` (vault, via `applyVaultSecrets`) ▸ `channel.signal.phone_number` ▸ `SIGNAL_PHONE_NUMBER` env (via `applyChannelVaultSecrets`) |

`applyChannelVaultSecrets` runs immediately after `applyVaultSecrets` and
overwrites `config.signalPhoneNumber` with precedence
`channel.signal.phone_number ▸ env ▸ current-config` — so the *field* is
reconciled. The divergence is that the legacy flat key influences **only** the
adapter/outbound boot, never the registry gate.

### Concrete failure

A deployment whose number lives **only** under the legacy flat
`signal_phone_number`:

- the inbound Signal adapter does **not** start (the gate never sees the flat
  key, so `channelShouldStart` excludes `signal`), yet
- the OutboundGateway **can** still send Signal, because it reads
  `config.signalPhoneNumber` which the flat key populated
  (`src/index.ts:1305-1306`).

That is the silent, registry-invisible misconfiguration the issue describes:
the console/registry reports Signal as unconfigured while outbound Signal egress
silently works.

### Root asymmetry

For **email**, `src/index.ts:1338` (`channelConfigKeys`) feeds config-resolved
keys into the registry gate, so the gate and the adapter agree. For **Signal**,
`channelConfigKeys` returns an empty set, so the flat-key-derived config value is
invisible to the gate.

A second, narrower asymmetry sits inside the Signal channel itself: of the two
Signal credential fields, only `phone_number` has a flat-key seeder path
(`signal_phone_number` in `SEED_SECRET_NAMES`). Its sibling `socket_path` was
**never** seeded — it relies on the console-written `channel.signal.socket_path`
or the `SIGNAL_SOCKET_PATH` env fallback. The fix makes `phone_number` behave
exactly like `socket_path`.

## Goal

Exactly one authoritative vault key for the Signal phone number —
`channel.signal.phone_number` — read by every runtime path. The console alone
is sufficient to activate Signal. `SIGNAL_PHONE_NUMBER` remains only as
documented env back-compat (symmetric with `socket_path`).

## Canonical key

`channel.signal.phone_number` — consistent with the channel-registry model, it
is what the console credential flow writes and what the registry gate already
reads.

## Changes

### 1. Remove the flat-key read — `src/secrets/apply-vault-secrets.ts`

Remove `signal_phone_number` from the `Promise.all` destructure, the
`secrets.get(...)` list, the `config.signalPhoneNumber = clean(...)` assignment,
and the `present` log object. Update the comment block that uses a blank Signal
phone number as the motivating example for `clean()` (the helper still serves
`anthropic_api_key`, `api_token`, etc. — re-anchor the example on those) and the
header comment that lists "nylas/signal channels" as consumers.

After this, `config.signalPhoneNumber` is set **only** by
`applyChannelVaultSecrets`. Both the registry gate and the adapter/outbound boot
then resolve `channel.signal.phone_number ▸ SIGNAL_PHONE_NUMBER env` and agree.
No change to `channelConfigKeys` is needed.

### 2. Backfill migration — `src/db/migrations/068_consolidate_signal_phone_number.sql`

Forward-only data migration (the repo's migrations are plain forward-only SQL):

- `INSERT INTO secrets (name, value_format, encrypted_value, iv, created_at, updated_at)
  SELECT 'channel.signal.phone_number', value_format, encrypted_value, iv, now(), now()
  FROM secrets WHERE name = 'signal_phone_number'
  AND NOT EXISTS (SELECT 1 FROM secrets WHERE name = 'channel.signal.phone_number');`
  — copy the legacy row's ciphertext+iv verbatim. This is safe because the vault's
  AES-256-GCM encryption uses **no per-name AAD** (`src/secrets/crypto.ts`), so the
  ciphertext decrypts identically under the new key name. The `NOT EXISTS` guard
  never clobbers an existing console-written value.
- `DELETE FROM secrets WHERE name = 'signal_phone_number';` — remove the legacy
  row so exactly one key remains.

Idempotent: re-running is a no-op (the copy is guarded; the delete is a no-op
once the row is gone). No-op for env-only or console-only deployments that never
had the flat key.

**Migration numbering:** `068` is the next free slot after `067`. Re-verify
uniqueness (`ls src/db/migrations/ | sort`) at PR time per the rebase-hazard note
in CLAUDE.md.

### 3. Drop the flat key from the seeder — `scripts/seed-vault.ts`

Remove `'signal_phone_number'` from `SEED_SECRET_NAMES`. This matches
`socket_path` (never seeded) and is **required** for the migration's delete to
stick: the seeder runs after migrations in `setup.sh`, so a retained entry would
re-create the flat key from `SIGNAL_PHONE_NUMBER` right after the migration
deleted it.

### 4. Keep env fallback (no change)

`SIGNAL_PHONE_NUMBER` stays as `envFallback` in `src/channels/catalog.ts` and as
the env read in `src/channels/apply-channel-vault-secrets.ts` — documented
back-compat, symmetric with `socket_path`, and the safety net for any deployment
that configures the number via env rather than the vault.

## Tests (TDD)

- **`src/channels/apply-channel-vault-secrets.test.ts`** — console-only entry:
  `channel.signal.phone_number` set, no flat key, no env ⇒ `config.signalPhoneNumber`
  populated. (Extends the existing channel-only test.)
- **`src/channels/credential-resolver.test.ts`** — console-only Signal:
  `channel.signal.phone_number` + `channel.signal.socket_path` set ⇒
  `requiredResolvable === true`. (Already present at line 21; assert it remains
  the only path needed.)
- **Migration test** (integration, real Postgres) — seed a flat
  `signal_phone_number`, run the migration, assert: the namespaced key now exists
  and decrypts to the same value, the flat key is gone, an existing namespaced
  value is never clobbered, and a second run is a no-op.
- **`tests/unit/apply-vault-secrets.test.ts`** — drop the `signal_phone_number`
  assertions (lines 49, 60-62); assert `applyVaultSecrets` no longer sets
  `config.signalPhoneNumber`.
- **`tests/integration/seed-vault.test.ts`** — update expectations now that
  `signal_phone_number` is no longer in `SEED_SECRET_NAMES`.

## Out of scope (noted, not touched)

- **Email's identical dual-key shape** — email keeps flat `nylas_*` keys plus
  `channel.email.*`, but its registry gate already accounts for config-resolved
  keys (`channelConfigKeys`), so no divergence. Left as-is per issue scope.
- **Broader "kill all env fallbacks"** — removing env fallback for email and
  `socket_path` to go fully vault/console-only is a larger change with a higher
  deployment blast radius; deferred to its own issue.

## Docs / admin

- **CHANGELOG.md** — `Fixed` entry under `## [Unreleased]`.
- **curia-docs** — separate PR referencing only `channel.signal.phone_number`,
  drafted as markdown for human approval first; closes
  [curia-docs#26](https://github.com/josephfung/curia-docs/issues/26).
- **No version bump** — regular PR (per CLAUDE.md, version bumps happen only at
  release time).

## Acceptance criteria mapping

| Acceptance criterion (#1140) | Addressed by |
| --- | --- |
| Exactly one authoritative key, all runtime paths read it | §1 (remove flat read) + §2 (migration) |
| Console-only entry activates Signal, no second write | §1 makes gate + boot agree on `channel.signal.phone_number` |
| Legacy read removed (not a silent divergent source) | §1 |
| Existing-deployment migration path addressed | §2 (backfill + delete) + §3 (seeder) |
| curia-docs references only the canonical key | Docs/admin |
| Tests cover console-only entry activating Signal | Tests |
