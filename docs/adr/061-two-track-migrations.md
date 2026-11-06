# ADR-061: Two migration tracks, and guarded, shape-checked upstream migrations

Date: 2026-11-05
Status: Accepted

## Context

Curia runs node-pg-migrate at boot against one directory, `src/db/migrations/`, with the
default `checkOrder: true`, recording applied migrations by name in `pgmigrations`
([ADR-005](005-node-pg-migrate-over-knex.md)). A failed migration stops the boot.

Forks number their own migrations from the same sequence as upstream, so the two collide as
soon as both add one. When a fork that has applied its own `112_…`–`120_…` merges upstream's
new `112_…`–`115_…`, the names differ, so node-pg-migrate treats them as new, but they sort
before migrations the fork has already applied. The order check fails (`Not run migration
112_web_push is preceding already run migration …`) and Curia won't boot. The fork can only
renumber its own history by hand on every instance, or turn the order check off.

A second problem appears when upstream builds something a fork already shipped. A bare
`ADD COLUMN` fails the boot on the fork; a bare `ADD COLUMN IF NOT EXISTS` quietly accepts the
fork's column even if its type or nullability differs, and the code breaks later somewhere
less obvious.

Alternatives considered (#2465):

- **`checkOrder: false` upstream.** Gets forks past the error but hides real ordering
  mistakes in upstream itself. A fork can still turn it off locally if it chooses.
- **Timestamp-prefixed filenames.** Collisions become unlikely, but merged migrations still
  land behind ones already applied, so the order check still fails.
- **Forks renumber after every upstream merge.** Rewriting `pgmigrations` on every instance,
  every time: error-prone, and worse over time.

## Decision

**1. Two tracks.** One shared helper, `src/db/run-migrations.ts`, runs migrations
everywhere: boot, `pnpm migrate` (`scripts/migrate.ts`), `install.sh`, CI, DAST and the test
helpers. It runs:

1. **Upstream:** `src/db/migrations/` into `pgmigrations`.
2. **Local:** `src/db/migrations-local/` (or `CURIA_LOCAL_MIGRATIONS_DIR`) into
   `pgmigrations_local`, when the local track is in use: the directory holds a migration,
   or `pgmigrations_local` has a row. The second half matters: a local directory that goes
   missing must stop the boot, not turn the track off. An explicitly set
   `CURIA_LOCAL_MIGRATIONS_DIR` must exist.

The order check stays on within each track; the tracks are never compared with each other.
Upstream never ships a migration in `migrations-local/`, only its README, so pulling upstream
can't put a migration behind one a fork already ran. Local migrations may depend on upstream
tables; upstream migrations never depend on local ones, and upstream always runs first.

With the local track not in use, the helper is one node-pg-migrate run over
`src/db/migrations/`, exactly as before: nothing is moved, checked or created.

**2. Reconciliation.** A fork that applied its own migrations under upstream-style numbers
moves those files into `migrations-local/` once (a git step; see
[docs/dev/fork-migrations.md](../dev/fork-migrations.md)). On the next migration run the
helper moves their rows from `pgmigrations` to `pgmigrations_local` in one transaction,
under node-pg-migrate's advisory lock, keeping `id`, `name` and `run_on`. It refuses rather
than guesses, writing nothing, when:

- a name is in both directories;
- a history row matches no file on its track;
- a name is already recorded on both tracks, or a moved row's id is taken;
- either track would then fail node-pg-migrate's order check (for example, a fork that
  renumbered a migration after applying it).

A second run finds nothing to move. `pnpm migrate --dry-run` prints the planned moves, the
order check on each track, any refusals, renames that would fix an out-of-order local track,
and the tables, columns and indexes created on both tracks — a fork that reimplemented an
upstream migration under its own name, which matching by name can't detect. It decides
whether the local track is in use exactly as boot does, so the two never disagree, and it
exits 0 (go ahead), 1 (boot would stop), 2 (warnings only) or 3 (the dry run failed).

**3. Guarded, shape-checked upstream migrations.** From migration 118 on, every upstream
DDL change must be safe on a database that already has the object, and must check its shape:

- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP … IF EXISTS`, inside a
  `DO` block or not.
- `ADD COLUMN` and `ADD CONSTRAINT` go in a `DO $$ … $$` block that, when the object exists,
  compares it with what upstream expects (type, nullability and default; for a constraint,
  an equivalent definition) and `RAISE EXCEPTION`s with an actionable message on a mismatch,
  and otherwise creates it. Each SQL file runs in one transaction, so a failed check leaves
  nothing half-applied. A bare `ADD COLUMN IF NOT EXISTS` is not enough: it accepts a
  different shape without a word.

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'scheduled_jobs' AND column_name = 'name') THEN
    IF (SELECT data_type <> 'text' OR is_nullable <> 'YES'
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'scheduled_jobs' AND column_name = 'name') THEN
      RAISE EXCEPTION 'scheduled_jobs.name already exists with an incompatible shape (expected nullable text); reconcile it before upgrading';
    END IF;
  ELSE
    ALTER TABLE scheduled_jobs ADD COLUMN name TEXT;
  END IF;
END $$;
```

`tests/unit/db/migration-guards.test.ts` enforces this in CI from 118 on, along with unique
numeric prefixes across all upstream files and an empty `migrations-local/` upstream (that
last check runs only in upstream's CI, since a fork's directory is meant to hold files).
Migrations 001–117 are exempt and are not rewritten. The lint matches text, not SQL
semantics: it checks that a `DO` block adding a column or constraint can raise, not that its
comparison is right. Reviewers check that.

## Consequences

- A fork can pull upstream without renumbering anything, and the order check still catches
  real ordering mistakes on both tracks.
- Moving an existing fork onto the local track is one git commit plus a boot; anything the
  helper can't decide safely stops the boot with a message naming it, and the dry run shows
  it in advance against a copy of the database.
- Promoting a fork feature upstream means a fresh, guarded upstream migration; on the fork
  it finds the object, checks the shape and does nothing.
- Upstream migrations get longer: a column is a `DO` block instead of one line. That is the
  price of failing loudly instead of drifting quietly on a fork.
- Fork migrations from before the cut-off that recreate an older, unguarded upstream object
  can still collide; the dry run's overlap list is the only guard there.
- A test that applies a fixed number of upstream migrations (`count`) skips the local track,
  since local migrations may depend on any upstream table.
- Down migrations work per track as before; the helper itself only runs `up`.
