# Console-managed email accounts (retire YAML `channel_accounts`)

Supersedes: #920 · Builds on: #964, #911 · Refs: ADR-021, ADR-020 · Milestone: v0.37

## Problem

Email accounts can be configured three different ways today, and none of them lets an
operator manage *multiple* mailboxes from the console:

| Path | Source | Secrets read from | Multi-account? |
|---|---|---|---|
| YAML multi-account | `channel_accounts.email` in `local.yaml` | `process.env` (via `env:VAR` refs in `resolveEnvValue`) | yes |
| Console single-account | Channels UI → vault `channel.email.*` | vault (overlaid onto `config.*` by `applyChannelVaultSecrets`, #964) | **no** — fixed key names, one grant |
| Legacy single-account | `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` env | `process.env` | no |

The YAML path is the only multi-account one, and it reads secrets straight from
`process.env`, bypassing the vault. This is the gap #920 was filed to close (route those
secrets through the vault) and the limitation called out in ADR-021's "Known limitations"
and `docs/dev/configuration.md`.

**It is not latent.** Prod runs the YAML path today with a single account named `curia`
(`channel_accounts.email.curia` → `env:NYLAS_GRANT_ID` / `env:NYLAS_SELF_EMAIL`). Because
that path reads env, `NYLAS_GRANT_ID` and `NYLAS_SELF_EMAIL` are **pinned in prod `.env`** —
they are the last two secrets blocking the final `.env` trim from #911 (every other migrated
secret has already been removed).

#964 made the console single-account path actually take effect at runtime (overlay
`channel.email.*` → `config.*`), but explicitly left **per-account vault provisioning for
multi-account email out of scope** — "YAML remains the multi-account path; vault provides the
single-account default." This design is that deferred piece.

## Goal

Configure one or many agent-owned email mailboxes entirely from the console, with all
secrets in the encrypted vault. Retire the `channel_accounts` YAML path entirely. Deliver
#920's actual outcome — multi-account secrets out of `.env`, vault-resolved — via a
console + DB model rather than routing YAML `env:` refs through the vault.

**Account model:** each account is a mailbox the agent owns; it polls it and replies from it.
No CEO-inbox unification, no cross-channel binding, no in-app OAuth (all out of scope below).

## Design

### Data model

A new `email_accounts` table — provider-agnostic, the stable identity of a mailbox:

| column | type | notes |
|---|---|---|
| `name` | `text` PK | logical account id, stamped on `inbound.message` for reply routing; the poll high-water-mark key (`<name>.last_seen_at`) |
| `self_email` | `text not null` | mailbox address; not a secret |
| `provider` | `text not null default 'nylas'` | transport discriminator; `'nylas'` is the only value today |
| `enabled` | `boolean not null default true` | per-account on/off, beneath the channel-level gate |
| `created_at` | `timestamptz not null default now()` | audit |
| `created_by` | `text not null default 'web-console'` | audit, matching `channel_registry`'s actor convention |
| `updated_at` | `timestamptz not null default now()` | audit |

It is deliberately named `email_accounts`, **not** `nylas_grants`: the table is the account
identity, independent of transport. Adding IMAP later is "new `provider` value + new adapter
+ new vault-key convention" with zero churn to this table or the console account list.

**Grants stay in the vault, namespaced per account:** `channel.email.<name>.nylas_grant_id`.
The grant is the sensitive bit, so it belongs in the encrypted vault (ADR-020), not the row.
The shared `nylas_api_key` stays single — one Nylas app underlies all grants — so it remains
`channel.email.nylas_api_key` (already handled by #964's overlay), not per-account.

No `provider_config jsonb` column yet. When IMAP lands it will need non-secret transport
config (host/port), and that column earns its place then. Adding it now would be speculative
(YAGNI).

Migration number: next available (currently `063` — **verify at merge** against the
duplicate-prefix hazard in CLAUDE.md).

### Resolver rewrite

`resolveChannelAccounts()` (`src/config.ts`) currently branches on `channel_accounts.email`
YAML and resolves `env:` refs. Rewrite it to read the table and pull each grant from the
vault:

```ts
// async now — reads the email_accounts table + vault
async function resolveChannelAccounts(
  db: Pool,
  secrets: SecretsService,
  logger: Logger,
): Promise<ResolvedEmailAccount[]>
```

For each `enabled` row: read `channel.email.<name>.nylas_grant_id` from the vault. If the
grant is missing, **skip the account with a loud warning** (do not abort boot, do not boot a
grant-less adapter) — same fail-closed posture as `resolveEnvValue` had, but per-account and
non-fatal.

`ResolvedEmailAccount` keeps its current shape **minus `excludedSenderEmails`** (see
self-suppression below): `{ name, nylasGrantId, selfEmail }`.

**Deleted:** `RawEmailAccountConfig`, the `channel_accounts` field in the YAML schema and its
validation block, and the `env:`-ref resolution for channel accounts. The legacy
single-account synthesis (`config.nylasGrantId` → synthetic `curia`) is also removed — the
backfill (below) turns that same data into a real `email_accounts` row, so the fallback is no
longer needed.

**Bootstrap sequencing:** `resolveChannelAccounts` already runs after the vault exists
(`src/index.ts`, after `applyVaultSecrets` / `applyChannelVaultSecrets`). It becomes `await`ed
and takes `db` + `secretsService`, both already in scope at that point. `nylasClientMap`,
`EmailAdapter` construction, the calendar client, and `OutboundGateway` wiring downstream are
unchanged — they still consume `ResolvedEmailAccount[]` and the per-account `accountId`.

### Self-suppression (drop `excluded_sender_emails`)

Today each account carries an `excluded_sender_emails` list, hand-maintained, doing two jobs:
muting external automated senders (`noreply@`) and stopping the agent replying to its own
other mailboxes. The second job is a footgun that scales badly with multiple accounts.

We drop the column. The adapter's self-suppression set becomes the **auto-derived union of
every account's `self_email`**, computed once from the resolved accounts and passed to each
`EmailAdapter`. The agent can never reply to any mailbox it owns, with zero operator config.

Net effect: the existing `self_email` filter is generalized from per-account to
all-agent-mailboxes; the manual exclude list goes away entirely. (External automated-sender
muting is not reintroduced in v1 — if it's wanted later it returns as an explicit, separate
feature, not smuggled into the account row.)

### Console UX

An account list under the existing email channel in `ChannelSettings.tsx`:

- **Add:** form with `name`, `self_email`, `provider` (a select showing **Nylas** as the
  single option — visible on purpose, so the seam is unambiguous and signals where future
  providers slot in), and a pasted `grant_id`. On save: insert the row, write the grant to
  `channel.email.<name>.nylas_grant_id` via the existing vault write path.
- **Edit:** `self_email` / `enabled`; re-paste grant (re-writes the vault key).
- **Remove:** delete the row and the per-account vault key.
- **Restart banner:** after any mutation, the same "takes effect on next restart" hint #964
  added for credentials. The row is durable immediately; only live polling waits for the
  bounce.

Backend routes follow the existing console patterns (session/bootstrap auth, the
`/api/registry/channels` + `/api/vault/secrets/:name` style): CRUD for `email_accounts` plus
the per-account grant write. Per-account grant keys (`channel.email.<name>.nylas_grant_id`)
must be accepted by the vault write scope-guard, which today allows catalog channel-credential
keys — extend it to admit the per-account email-grant convention (and nothing broader).

### Lifecycle

`channel_registry` stays the **channel-level** on/off. The new table is the per-account layer
beneath it. An adapter boots for account *A* iff: email channel enabled (registry) **and**
`email_accounts.A.enabled` **and** `channel.email.A.nylas_grant_id` resolves **and** the
shared `nylas_api_key` resolves. Restart-to-apply — no hot-reload of adapters in v1 (that is a
much larger lifecycle change; see out of scope).

### Migration (live prod, no polling gap)

Prod is live and polling on the YAML path right now, so the cutover must seed the new table
before the new resolver runs, with no manual re-entry.

1. **SQL migration** creates `email_accounts`.
2. **Idempotent boot-time backfill**, immediately before `resolveChannelAccounts`: if
   `email_accounts` is empty **and** legacy single-account creds resolve **from the vault**
   (`nylas_self_email` + `nylas_grant_id`, already seeded by #911), insert
   `('curia', <self_email>, 'nylas', true)` and copy the grant to
   `channel.email.curia.nylas_grant_id`. Reads the **vault, never env** — so it does not
   reintroduce the dependency we are removing.
   - **Preserve the name `curia`** so the poll high-water mark (`curia.last_seen_at`) and
     `accountId` reply-routing survive untouched — no re-poll of old mail, no routing break.
   - **No-silent-miss guard:** if a `channel_accounts.email` YAML block is still present with
     more than one account, log a loud warning naming the accounts that cannot be
     auto-migrated (their grants were never vaulted) and instruct the operator to re-add them
     in the console. We never report a migration we did not perform. (Prod has one account, so
     this is defensive.)
   - Idempotent: empty-table guard means re-deploys are no-ops. Mark with a `TODO` to remove
     the backfill a release or two out, once every deployment has run it.
3. **Unpin `.env`:** remove `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` from prod `.env` and the
   deploy `.env.example`. The backfill reads the vault, so the pin is finally gone. The vault
   bootstrap exceptions (`SECRET_ENCRYPTION_KEY`, DB creds) are untouched.

### Docs & issue disposition

- ADR-021: drop the multi-account `resolveEnvValue` entry from "Known limitations."
- `docs/dev/configuration.md`: replace the `channel_accounts.email` YAML section with the
  console account-management flow.
- Close **#920 as superseded** by this work, noting it delivers #920's acceptance criteria
  (multi-account secrets vault-resolved, absent from `.env`) through the console + DB model.

## Testing (TDD)

Tests first, then implementation.

**Resolver** (`src/config.*` unit, injected fake `db` + `secrets`):
- multi-account: two enabled rows → two `ResolvedEmailAccount`s, each grant from its
  per-account vault key.
- disabled row → excluded.
- missing per-account grant → account skipped + warning, boot continues, other accounts
  unaffected.
- self-suppression union: resolved set's `self_email`s are unioned and applied to every
  adapter (no account replies to any owned mailbox).

**Backfill** (unit, injected fakes):
- empty table + vault single-account creds → one `curia` row + `channel.email.curia.nylas_grant_id`.
- name preserved as `curia` (high-water-mark continuity).
- idempotency: non-empty table → no-op.
- >1-account residual YAML → loud warning naming the un-migratable accounts.
- reads only vault keys, never `process.env` (assert the env object is never touched).

**Boot without env** (integration): `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` absent from env,
account seeded → email channel boots and polls. This is #920's core acceptance criterion.

**Console routes** (handler tests): add / edit / remove `email_accounts`; per-account grant
write hits the vault scope-guard allowlist (and a non-email-grant key is still rejected).

Migrations: integration tests run real Postgres in CI (raw SQL only fails there, not locally
without Docker) — treat CI as the gate for the migration + backfill SQL.

## Out of scope

- **In-app Nylas hosted OAuth** — grants are still minted on the Nylas side and pasted in.
  A "Connect a mailbox" flow is a separate, larger follow-up that populates the same row.
- **IMAP / non-Nylas providers** — the `provider` column is the seam; no second adapter now.
- **Hot-reload of adapters** on account add/remove — restart-to-apply, matching the existing
  setup-required model.
- **CEO-inbox unification** — the `ceo_nylas_grant_id` / `ceo_self_email` skill-scoped
  identity stays separate; folding it into `email_accounts` is a later decision.
- **External automated-sender muting** — the dropped `excluded_sender_emails` capability is
  not reintroduced in v1; if wanted it returns as an explicit feature.

## Acceptance criteria

- [ ] Multi-account email resolves each account from `email_accounts` + per-account vault
      grant, not `process.env` and not YAML.
- [ ] An operator can add / edit / remove email accounts entirely from the console; grants
      land in the vault per-account.
- [ ] Self-suppression is auto-derived from the union of all accounts' `self_email`; no
      per-account exclude list remains.
- [ ] Boot-time backfill seeds prod's `curia` account from the vault (name preserved), is
      idempotent, and warns loudly on un-migratable multi-account YAML.
- [ ] A deployment boots and polls with `NYLAS_GRANT_ID` / `NYLAS_SELF_EMAIL` absent from
      `.env`; both are removed from `.env` / `.env.example`.
- [ ] `channel_accounts` YAML path (`RawEmailAccountConfig`, schema, `env:` resolution) is
      deleted.
- [ ] ADR-021 limitation removed; `docs/dev/configuration.md` rewritten to the console flow;
      #920 closed as superseded.
- [ ] Full test suite green (incl. CI Postgres integration for the migration + backfill).
