# Channel vault → adapter wiring (close the credential-resolution seam)

Issue: #964 · Refs: #543, #963, #962 · Milestone: v0.37

## Problem

The channel registry resolves credentials **vault-first** (`channel.<name>.<key>` ▸ env ▸
config) to compute `requiredResolvable`, which gates `enable()` and `channelShouldStart`.
But the email and signal **adapters** are constructed from the legacy config/env runtime
objects (`nylasClientMap` / `resolvedEmailAccounts` / `config.nylasApiKey`, and
`signalRpcClient` / `config.signalPhoneNumber` / `config.signalSocketPath`).

These read **two disjoint vault namespaces**:

| Namespace | Keys | Written by | Read by |
|---|---|---|---|
| Channel-scoped | `channel.email.*`, `channel.signal.*` | **Channels UI** (`ChannelSettings.tsx`) | `channelCredentialStatus()` → registry gate |
| Bootstrap-scoped | `nylas_api_key`, `nylas_grant_id`, `nylas_self_email`, `signal_phone_number` | `seed-vault.ts` (from env) | `applyVaultSecrets()` → `config.*` → adapters |

(Signal's `socket_path` has *no* bootstrap-scoped equivalent at all — `config.signalSocketPath`
comes only from env `SIGNAL_SOCKET_PATH`.)

The two namespaces never meet. A credential set saved entirely through the Channels UI
(`channel.email.*`) makes the registry report `enabled + resolvable`, but `config.nylasApiKey`
stays undefined → `nylasClientMap` empty → no adapter constructs. **Silent no-op.** The UI's
save path has zero runtime effect.

## Goal

Make the enablement gate and the adapter wiring share a single source of truth, so that
`enabled + resolvable` always implies the adapter can actually boot — across all four
combinations of `{vault-only, env/config-only, both, neither}`. (Issue option **1**, the
preferred direction: vault-backed provisioning, "configure a channel entirely from the
console.")

## Design

### Single overlay point, before any consumer reads config

Rather than patch each adapter construction site (adapters, `OutboundGateway`, calendar
client, and the principal-contact block all read `config.*`), resolve the channel-scoped
vault values **once, early at boot**, and overlay them onto `config.*`. Everything
downstream then reads consistent values for free.

New function:

```ts
// src/channels/apply-channel-vault-secrets.ts
export async function applyChannelVaultSecrets(
  config: Config,
  secrets: { get(name: string): Promise<string | null> },
  env: Record<string, string | undefined>,
  logger: Logger,
): Promise<void>
```

It resolves each runtime field with the **same precedence the registry resolver uses**, and
writes the result back onto `config`:

| `config` field | precedence (first hit wins) |
|---|---|
| `nylasApiKey`      | `channel.email.nylas_api_key` ▸ env `NYLAS_API_KEY` ▸ current `config.nylasApiKey` |
| `nylasGrantId`     | `channel.email.nylas_grant_id` ▸ env `NYLAS_GRANT_ID` ▸ current `config.nylasGrantId` |
| `nylasSelfEmail`   | `channel.email.nylas_self_email` ▸ env `NYLAS_SELF_EMAIL` ▸ current `config.nylasSelfEmail` |
| `signalPhoneNumber`| `channel.signal.phone_number` ▸ env `SIGNAL_PHONE_NUMBER` ▸ current `config.signalPhoneNumber` |
| `signalSocketPath` | `channel.signal.socket_path` ▸ env `SIGNAL_SOCKET_PATH` ▸ current `config.signalSocketPath` |

**Precedence decision (confirmed):** channel-scoped vault wins. The Channels UI is the
most-specific, most-recently-saved source, and the registry resolver already reads it first,
so the gate and the adapter never disagree.

Resolution rules, matching `applyVaultSecrets` / `channelCredentialStatus`:
- Each vault read is isolated in a `try/catch`; a transient vault failure is logged and
  treated as absent (fall through to env/current-config), never aborting boot.
- Values are `clean()`-normalized (trim; blank-after-trim reads as absent), the same guard
  used by `applyVaultSecrets`, so a whitespace-only row doesn't wire up a broken channel.
- Never log secret values — log a names-only `present` map like `applyVaultSecrets` does.

### Wiring in `index.ts`

Call it immediately after `applyVaultSecrets` (index.ts:313), inside the same fatal-on-error
guard family:

```ts
await applyVaultSecrets(config, secretsService, logger);
await applyChannelVaultSecrets(config, secretsService, process.env, logger);
```

Both run **before** `resolveChannelAccounts` (index.ts:700) and before `nylasClientMap` /
`signalRpcClient` / `outboundGateway` construction. No other change to the construction sites
is required.

### Why email multi-account needs no new machinery

`resolveChannelAccounts` already has a legacy single-account fallback: when
`channel_accounts.email` YAML is absent, it synthesizes a `curia` account from
`config.nylasGrantId` + `config.nylasSelfEmail`. After the overlay populates those from
`channel.email.*`, a **vault-only email setup flows through that existing path** as one
`curia` account. Explicit YAML `channel_accounts.email` still wins when present (power-user
multi-account config); the vault single-account form is the console-config default.

### Why the gate and adapter now agree (AC1)

Because the overlay uses the registry's precedence, any required field the registry reports
`resolvable` now also yields a runtime value in `config`. The four combinations:

| Source of creds | Registry `requiredResolvable` | Adapter constructs | Agree? |
|---|---|---|---|
| vault-only (`channel.*`) | true (vault) | true (overlay → config) | ✓ |
| env/config-only | true (env/config) | true (env/current config) | ✓ |
| both | true | true (channel-vault wins, consistently) | ✓ |
| neither | false | false | ✓ |

### Console UI (AC4)

After the backend fix, the Channels UI save path has real effect (on restart). The drawer
already notes "Enabling or disabling takes effect on the next restart." for lifecycle; the
Credentials section has no such hint. Add a single truthful line under the Credentials label
(e.g. "Saved credentials take effect on the next restart."). No other console change.

**Apply timing (confirmed):** restart-to-apply, matching the existing setup-required model.
No hot-reload of adapters (that would be a much larger lifecycle change, out of scope).

## Testing (TDD)

`src/channels/apply-channel-vault-secrets.test.ts` (unit, injected fake `secrets` + `env`):
- **vault-only** email: `channel.email.*` set, env empty, config undefined → all three
  `config` fields populated from vault.
- **vault-only** signal: `channel.signal.*` set → `signalPhoneNumber` + `signalSocketPath`
  populated.
- **env-only**: vault empty, env set → config takes env values.
- **both**: channel-vault and env differ → channel-vault wins (precedence assertion).
- **neither**: nothing set → config fields stay at their prior values (undefined / '').
- **whitespace-only vault row** → treated as absent (falls through to env/config).
- **vault read throws** → logged, treated as absent, no throw.
- Secret values never appear in logged output (assert on the `present` names-only map).

Integration coverage tying overlay → `resolveChannelAccounts` → registry agreement:
- vault-only email creds → `resolveChannelAccounts` yields one `curia` account **and**
  `channelCredentialStatus` reports `requiredResolvable: true` (the gate and the wiring agree).

## Out of scope

- Hot-reload of adapters on credential save (restart-to-apply is sufficient).
- Per-account vault provisioning for multi-account email (YAML remains the multi-account
  path; vault provides the single-account default).
- Sibling issue #962.

## Acceptance criteria (from #964)

- [x] Vault-only creds for email & signal → constructed, started adapter when enabled
      (overlay → config → existing construction), and gate/adapter agree in all four combos.
- [x] Existing env/config deployments start unchanged (env/current-config is the fallback tier).
- [x] Unit + integration coverage for vault-only and mixed-source cases.
- [x] Channels UI does not advertise a no-op save path (save now has effect; restart hint added).
