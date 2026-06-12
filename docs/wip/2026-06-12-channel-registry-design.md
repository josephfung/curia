# Channel Registry — Design

**Date:** 2026-06-12
**Issue:** [#543 — feat: database-layer registry for channels with credential management](https://github.com/josephfung/curia/issues/543)
**Depends on:** #542 (secrets vault) — **merged** (`050_create_secrets_vault.sql`, `src/secrets/secrets-service.ts`)
**Status:** Design approved, pending spec review

---

## 1. Summary

Add a database-backed registry that governs the install/enable lifecycle of Curia's
channels, paralleling the existing skills/agents registry (#541). Channel credentials
move into the encrypted secrets vault under a `channel.<name>.<field>` naming
convention, resolved **vault-first with env/config fallback** so running deployments
are untouched. A formal `Channel` TypeScript interface replaces the current duck-typed
adapter pattern, and the web console gains a **Channels** management page mirroring the
Skills/Agents list+drawer pattern.

This is a channel-layer **lifecycle + credentials** concern only. Two pieces from the
original issue are deliberately deferred (see §10): the in-app OAuth flow, and
DB-backed channel *policy* (trust / unknown_sender / threaded).

---

## 2. Key decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Defer in-app OAuth** to a follow-up issue | No in-app OAuth flow exists anywhere in the codebase, and none of the four current channels need one (Nylas = externally-obtained grant ID; Signal = socket path + phone number). Building a generic OAuth redirect/callback subsystem with no consumer is speculative. |
| D2 | **Separate `ChannelRegistryService`** + `channel_registry` table | Channels differ structurally from skills/agents: code-defined (not disk-manifest-discovered), carry an `is_toggleable` flag, and HTTP/CLI must always start. Cleaner than forcing channel-specific conditionals into the shared `RegistryService`. |
| D3 | **Vault-first, env/config fallback** | Credentials resolve from the vault first, then existing env var, then `config/default.yaml`. Reconcile auto-seeds enabled rows for channels whose credentials already resolve, so existing installs light up unchanged. No forced migration. |
| D4 | **Policy stays out of the registry** (deferred) | `trust` / `unknown_sender` are dispatch-layer security policy (consumed by `trust-scorer.ts`, `dispatcher.ts` via `contacts/config-loader.ts`), not channel-layer lifecycle. Mixing them couples two layers across a security boundary and is security-sensitive enough to warrant its own design + ADR. See §10 and the follow-up issue draft. |

---

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│ Web Console (apps/console)                                      │
│   Channels page → list + detail drawer (credential form)        │
└───────────────┬──────────────────────────────────────────────┘
                │ REST  /api/registry/channels/*   +   PUT /api/vault/secrets/:name
┌───────────────▼──────────────────────────────────────────────┐
│ Backend (src)                                                   │
│   ChannelRegistryService ──► channel_registry table            │
│         │                                                       │
│         ├── catalog (src/channels/catalog.ts)  ← source of truth│
│         │      for which channels exist + their cred fields     │
│         ├── credential resolution (vault ▸ env ▸ config)        │
│         │      └── SecretsService (vault)                       │
│         └── startup loader (index.ts): start enabled channels   │
│                                                                 │
│   Channel interface ◄── email / signal / http / cli adapters    │
└────────────────────────────────────────────────────────────────┘
```

The **catalog** is the static, code-defined list of known channels and is the single
source of truth for: which channels exist, whether each is toggleable, what credential
fields it needs, and which of those are required to enable it. The `channel_registry`
table holds only the *mutable lifecycle state* (installed/enabled + timestamps/actors).

---

## 4. The `Channel` interface + catalog

### 4.1 Interface

Replaces the implicit duck-typed pattern (today adapters only expose `start()`; there is
no `ChannelAdapter` interface in code despite CLAUDE.md referencing one).

```typescript
// src/channels/channel.ts
export interface Channel {
  readonly name: string;          // 'email' | 'signal' | 'http' | 'cli'
  readonly isToggleable: boolean; // false for http, cli
  start(): Promise<void>;
  stop(): Promise<void>;          // graceful shutdown
}
```

All four adapters implement it. Changes per adapter:
- **CLI**: `start()` becomes `async` (currently synchronous); add `stop()`.
- **Email / Signal / HTTP**: add `stop()` (graceful teardown of poller / RPC socket /
  Fastify server). No change to message handling.

`stop()` is wired into the existing process-shutdown path. Because hot-reload is out of
scope (§10), enabling/disabling a channel via the UI takes effect at the **next
restart** — `stop()` is used for clean shutdown, not live toggling.

### 4.2 Catalog

```typescript
// src/channels/catalog.ts
export interface ChannelCredentialField {
  key: string;            // vault suffix, e.g. 'nylas_grant_id'
  label: string;          // form label
  secret: boolean;        // render as password input + never echo back
  envFallback?: string;   // legacy env var checked during resolution, e.g. 'NYLAS_API_KEY'
  configPath?: string;    // dotted path into config/default.yaml, for back-compat resolution
}

export interface ChannelDescriptor {
  name: string;
  description: string;
  isToggleable: boolean;
  credentialFields: ChannelCredentialField[]; // [] for http/cli
  requiredSecretKeys: string[];               // subset of field keys required before enable
}

export const CHANNEL_CATALOG: ChannelDescriptor[] = [ /* email, signal, http, cli */ ];
```

Representative field definitions:

| Channel | Fields (`key`) | Required | envFallback / configPath |
|---|---|---|---|
| `email` | `nylas_api_key`, `nylas_grant_id`, `nylas_self_email` | all three | `NYLAS_API_KEY`; `channel_accounts.email[]` (see §6) |
| `signal` | `socket_path`, `phone_number` | both | `SIGNAL_SOCKET_PATH`, `SIGNAL_PHONE_NUMBER` |
| `http` | — | — | `isToggleable: false` |
| `cli` | — | — | `isToggleable: false` |

Vault keys follow the issue's convention: `channel.<name>.<field.key>`
(e.g. `channel.email.nylas_grant_id`, `channel.signal.phone_number`).

---

## 5. Data model

`channel_registry` mirrors `skill_registry`/`agent_registry`, plus an `is_toggleable`
column.

```sql
-- src/db/migrations/052_create_channel_registry.sql
-- (verify 052 is still the next free prefix at implementation time; renumber if a
--  collision landed first — see CLAUDE.md migration-numbering hazard)
CREATE TABLE channel_registry (
  name          TEXT PRIMARY KEY,           -- matches catalog descriptor name
  enabled       BOOLEAN     NOT NULL DEFAULT false,
  is_toggleable BOOLEAN     NOT NULL DEFAULT true,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by  TEXT        NOT NULL DEFAULT 'system',
  enabled_at    TIMESTAMPTZ,                -- set when enabled=true, cleared on disable
  enabled_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Derived state** (not stored as an enum):

| State | Condition |
|---|---|
| `uninstalled` | catalog entry exists, no DB row |
| `installed` (disabled) | DB row, `enabled = false` |
| `enabled` | DB row, `enabled = true`, `enabled_at` set |

"Not present" never applies — the catalog always lists all four channels.

---

## 6. Credential resolution

A single helper resolves each credential field across sources, vault-first:

```typescript
// resolveChannelCredential(descriptor, field) →
//   vault.get(`channel.${name}.${field.key}`)
//     ?? process.env[field.envFallback]
//     ?? lookup(config, field.configPath)
//     ?? null
```

- The existing **multi-account email** path (`config/default.yaml` →
  `channel_accounts.email[]`, shared `NYLAS_API_KEY`) is **preserved unchanged**. The
  vault/UI path is the single-account setup for fresh installs.
- A channel's credentials are considered **resolvable** if every `requiredSecretKeys`
  field resolves from *any* source. The UI surfaces *where* each field resolved from
  (vault / environment / config / missing) so an operator understands the live state
  without the registry having to import existing env/config values.
- `secret: true` fields are write-only over the API: the form can submit a new value
  (`PUT /api/vault/secrets/channel.<name>.<key>`) but the value is never echoed back;
  status is reported as configured/missing only.

---

## 7. Startup behaviour (in `src/index.ts`, after DB + vault are ready)

1. **Reconcile.** For each catalog channel with no DB row whose required credentials
   already resolve (vault or env/config), insert an `enabled` row — existing
   deployments come up unchanged. HTTP and CLI rows are always ensured present with
   `is_toggleable = false, enabled = true`.
2. **Load.** Start only channels with `enabled = true`. HTTP and CLI always start
   regardless of DB state (operator-lockout safeguard).
3. **Missing secrets.** If an `enabled` channel's required credentials do not resolve,
   log a warning and skip starting that adapter — **never crash**.

Adapter instantiation order is unchanged from today (adapters start after the
`OutboundGateway` and dispatcher are wired). Started adapters are tracked in a map keyed
by channel name so `stop()` can be called on shutdown.

---

## 8. Backend API

New routes backed by `ChannelRegistryService`, alongside the existing registry routes,
same auth (session cookie / `x-web-bootstrap-secret`):

```
GET    /api/registry/channels                    list catalog ⨝ DB ⨝ resolution status
POST   /api/registry/channels/:name/install      create row (enabled=false)
POST   /api/registry/channels/:name/enable        gated: required creds must resolve
POST   /api/registry/channels/:name/disable        409 if !is_toggleable
DELETE /api/registry/channels/:name                 clears channel.<name>.* vault keys; 409 if !is_toggleable
```

Credential writes reuse the existing `PUT /api/vault/secrets/:name` endpoint.

`ChannelRegistryService` public API:

```typescript
class ChannelRegistryService {
  list(): Promise<ChannelRegistryEntry[]>;           // catalog + row + resolution status + derived state
  install(name: string, actor: string): Promise<ChannelRegistryEntry>;
  enable(name: string, actor: string): Promise<ChannelRegistryEntry>;   // throws if required creds unresolved
  disable(name: string, actor: string): Promise<ChannelRegistryEntry>;  // throws if !is_toggleable
  uninstall(name: string, actor: string): Promise<void>;                // clears vault keys; throws if !is_toggleable
}
```

---

## 9. Frontend (`apps/console`)

A **Channels** entry in the Settings sidebar group (peer to Skills/Agents), reusing the
`RegistrySettings`/drawer components:

- **List view:** one row per catalog channel; state pill (uninstalled / installed /
  enabled); enable/disable toggle, **locked + greyed for `http` and `cli`**.
- **Detail drawer:** channel name, description, derived state; a credential form
  generated from the catalog's `credentialFields` (password inputs for `secret` fields,
  showing configured/missing + source per field); Install / Enable–Disable /
  Uninstall (confirm-required) controls. Enable is disabled until required creds resolve.

No net-new visual design — the existing registry components are reused.

---

## 10. Out of scope (this issue)

Carried over from the issue, plus deferrals from design:

- **In-app OAuth flow** (D1). No in-app OAuth exists yet and no current channel needs
  one. Split into its own follow-up issue, to be built when a channel actually requires
  it. The catalog/drawer are structured so an OAuth field type can be added later
  without reshaping the registry.
- **DB-backed channel policy — `trust` / `unknown_sender` / `threaded`** (D4).
  Currently defaulted in `config/channel-trust.yaml` and consumed by the **dispatch
  layer** (`src/contacts/config-loader.ts` → `src/dispatch/trust-scorer.ts`,
  `dispatcher.ts`). Deferred to a separate, lower-priority issue because:
  - it's a different layer/concern from channel lifecycle;
  - making `trust` runtime-editable from the console is security-sensitive (console
    compromise → trust escalation) and deserves its own design + ADR;
  - membership differs — `channel-trust.yaml` includes `web` (the KG app, bootstrap-secret
    authenticated), which has no startable adapter and is not in the registry catalog;
  - `threaded` is an adapter *capability*, not a policy — its natural home is a
    `readonly threaded` property on the `Channel` interface, which that follow-up should
    do first.

  **Filed as follow-up issue
  [#962](https://github.com/josephfung/curia/issues/962)** (draft at
  [`docs/wip/2026-06-12-channel-policy-registry-issue.md`](./2026-06-12-channel-policy-registry-issue.md)).
- **Hot-reload** of channel adapters without restart. Enable/disable applies at next
  restart.
- **Multi-account management in the UI.** The existing config-driven multi-account email
  path is retained; the UI/vault handles the single-account case only.
- **OAuth token-refresh UI** (moot once OAuth itself is deferred).

---

## 11. Testing (TDD — tests first)

- **`ChannelRegistryService`**: install → enable → disable → uninstall lifecycle;
  enable gating when required creds unresolved (rejects); `is_toggleable` locks
  (disable/uninstall of http/cli → error); uninstall clears `channel.<name>.*` vault keys.
- **Credential resolution**: precedence (vault ▸ env ▸ config); per-field source
  reporting; required-set resolvable logic.
- **Reconcile**: seeds `enabled` rows for channels with resolvable creds; http/cli always
  present, locked, enabled; does not overwrite operator-set state on subsequent boots.
- **Startup loader**: only `enabled` channels start; http/cli always start; an `enabled`
  channel with missing required creds logs a warning and is skipped (no crash).
- **Routes**: auth required; `is_toggleable` 409s; enable-gating 4xx.
- **Interface conformance**: all four adapters implement `Channel` (`start`/`stop`,
  `name`, `isToggleable`).

Integration tests use real Postgres per project convention.

---

## 12. Acceptance criteria (adjusted for deferrals)

- [ ] `channel_registry` table created via migration.
- [ ] `Channel` TypeScript interface defined; all four adapters implement it (incl. `stop()`).
- [ ] At startup, only `enabled = true` channels start, except HTTP and CLI which always start.
- [ ] HTTP and CLI appear in the registry with `is_toggleable = false` and cannot be disabled/uninstalled.
- [ ] Channel credentials stored in the secrets vault under `channel.<name>.<field>`.
- [ ] Credential resolution is vault-first with env/config fallback; existing deployments start unchanged.
- [ ] An enabled channel with missing required credentials produces a startup warning (not a crash) and does not start.
- [ ] Web console shows a Channels list with state indicators and enable/disable toggles (locked for HTTP/CLI).
- [ ] Detail drawer shows a credential form appropriate to each channel, with per-field configured/missing status.
- [ ] Static credential install: form submission → vault → channel marked installed.
- [ ] Uninstall clears the channel's vault entries and removes the registry row (confirm required).
- [ ] **Deferred** (tracked in follow-up issues): in-app OAuth flow; DB-backed channel policy.
```
