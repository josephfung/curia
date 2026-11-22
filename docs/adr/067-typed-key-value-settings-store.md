# ADR-067: A typed key-value settings store for instance admin settings

Date: 2026-11-22
Status: Accepted

## Context

Curia had no general home for instance-level admin settings. Each one got a purpose-built
table, and the newest, `setup_state` (migration 130, #2358), mixed two kinds of data under a
name that only described the first:

- Setup progress: `phase`, `completed_at`.
- Durable admin settings that outlive Setup: `setup_for`, `operator_name`, `operator_email`,
  `messaging_route`, `voice_route`.

The operator's email is about to become routing Curia reads for the life of an install
(#2365), so a table named and documented as Setup state is the wrong home for it. The next
admin setting would face the same choice, and a new single-row table each time does not
scale.

Three alternatives were considered and rejected:

- **The config store** (`src/memory/config-store.ts`). It is built on the knowledge graph and
  agents reach it through the `config-store` skill. Admin settings must not be
  agent-writable, and #2358 deliberately kept the operator out of the knowledge graph.
- **Keeping purpose-built tables.** Each new setting adds a migration, a reader, and a
  naming decision. The set is independent, so there is no shared structure worth a table.
- **A versioned typed record** (`office_identity_versions` / `_current`). These settings are
  independent of each other, so whole-set snapshots add nothing, and read-modify-write on one
  shared record loses updates when two console tabs save different settings.

## Decision

One `settings` table, `key TEXT PRIMARY KEY`, `value JSONB NOT NULL`, `updated_at`,
`updated_by`, with a typed registry in front of it (`src/settings/registry.ts`). A missing row
means the key's declared default applies. Reads validate against the key's schema and never
trust a stored value: one that fails its schema is logged at error level and read as unset.

A second table, `settings_history`, is append-only (a database trigger rejects `UPDATE` and
`DELETE`, as `audit_log` does) and records one row per write: key, old value, new value,
`updated_by`, `changed_at`. It is written in the same transaction as the value, so the value
and its provenance cannot disagree. It answers "who changed X, and when", which no
purpose-built table did.

The store is out of the knowledge graph. No agent tool writes settings or imports the store.
Two tools (`setup-status`, `onboarding-progress`) see a read-only Setup projection through
injected services, and a unit test fails if any file under `skills/` imports `src/settings/`.

Setup's keys come over from `setup_state` (migration 132): `operator`, `messaging_route`,
`voice_route`, `setup.completed_at`. Two former columns are derived instead of stored:

- `setup_for`: an `operator` value means "someone else"; absent means "myself".
- The phase: `in_progress` until `setup.completed_at` is set.

The console's response shape is unchanged; `src/setup/setup-settings.ts` projects the keys
back into it.

## Consequences

- **One place to add an admin setting.** A new setting is one registry entry (schema, default,
  purpose) plus the code that reads it. It gets validation, a default, and an audit trail
  without a migration.
- **An incorrect stored value is visible, not trusted.** A hand-written `psql` value logs at
  error level and reads as unset, so the install falls back to the documented default instead
  of behaving unpredictably.
- **There is no separate "Setup has not started" state.** With the phase derived from
  `setup.completed_at`, a database with no settings at all reads as in progress. This drops
  `setup_state`'s carve-out for a database whose principal a script created: it already saw
  the console's Setup page, and now its web chat reaches the setup guide too. A scripted
  bootstrap (the KG demo, a scenario database) that needs web chat to stay with the
  coordinator must write `setup.completed_at`. `POST /api/setup/start` writes nothing and so
  can never reopen a finished Setup.
- **`setup_for` has no "not chosen" value.** An absent operator means "myself", so a fresh
  install starts there and the checklist no longer asks. `POST /api/setup/start` runs when the
  page opens, which is before the first render of the step, so a stored "not chosen" state
  could never be shown anyway.
- **A migration-marked completion is not a page completion.** Migration 132 also sets
  `setup.completed_at` on installs that predate the Setup page (`phase = 'complete'` with no
  completion time), so a non-null completion time alone no longer says Setup finished on the
  page. Those rows, and only those, carry `updated_by = 'migration:132:pre-setup-page'`. A
  Setup the page finished before the upgrade keeps its completion time and is copied under
  the plain `migration:132` actor, so it still counts as a page completion. `readSetupState`
  exposes `completedOnPage` from that `updated_by`, and onboarding uses it twice: the
  prior-principal-tasks signal passes `null` for a pre-Setup-page install (counting every
  task), and the dashboard alert is only for a page completion. That keeps the alert
  independent of which catalog steps are required.
- **A write commits on its own connection.** `setSetting`/`writeSettings` take a pool, not a
  queryable, because the value and the history row share one transaction. That transaction is
  the store's own: if a caller's transaction later rolls back, the setting stays set. A caller
  that needs a setting write to succeed or fail with its own work cannot wrap it in that
  work's transaction.
- **The registry is the schema.** There is no database `CHECK` that would duplicate it: adding
  a key is a code change by design, and a value written by hand is rejected on read.
