# Migrations in a fork

Curia runs two migration tracks ([ADR-061](../adr/061-two-track-migrations.md)):

| Track | Directory | History table |
|---|---|---|
| Upstream | `src/db/migrations/` | `pgmigrations` |
| Local (yours) | `src/db/migrations-local/`, or `CURIA_LOCAL_MIGRATIONS_DIR` | `pgmigrations_local` |

Upstream runs first, then local. Each track keeps node-pg-migrate's order check on its own,
so new upstream migrations never land behind yours.

The local track is in use once the local directory holds a migration or `pgmigrations_local`
has a row. From then on boot checks that every recorded migration still has its file, so a
local directory that goes missing (a typo in `CURIA_LOCAL_MIGRATIONS_DIR`, a volume that
isn't mounted) stops the boot instead of quietly skipping your migrations. If you set
`CURIA_LOCAL_MIGRATIONS_DIR`, the directory must exist even before you have any migrations.
Boot logs `Local migration track in use` with the directory and file count.

Upstream's test `tests/unit/db/migration-guards.test.ts` has one check that only upstream
can pass (its `migrations-local/` holds nothing but the README). It runs only when
`GITHUB_REPOSITORY` is `josephfung/curia`, so your fork's CI skips it.

**From now on, every schema change of your own goes in `src/db/migrations-local/`.** Number
it however you like, never reuse an upstream filename, and prefix your own tables and
columns (`fork_…`) so a future upstream object is unlikely to collide with yours. See the
[directory README](../../src/db/migrations-local/README.md) for the rules.

If your fork has never added a migration, there is nothing else to do.

## Moving migrations you have already applied

If your fork has its own migrations in `src/db/migrations/`, move them once. It takes two
steps: one in git, once per fork, and one on each database, which happens automatically.

### Step 1 — in git, once

With upstream as a remote (`git remote add upstream https://github.com/josephfung/curia.git`
and `git fetch upstream`), list the migrations your fork added:

```bash
git diff --name-only --diff-filter=A upstream/main...HEAD -- src/db/migrations
```

Then check that you have not edited, renamed or deleted any upstream migration:

```bash
git diff --name-only --diff-filter=MRD upstream/main...HEAD -- src/db/migrations
```

**This second list must be empty.** If it is not, stop: an upstream migration whose schema
came from your version has to be reconciled by hand before you go on.

The three-dot diff compares against the merge base, so both commands give the same answer
before or after you merge upstream.

Move each file from the first list into the local directory, keeping its name, and commit:

```bash
git mv src/db/migrations/118_fork_books.sql src/db/migrations-local/
git mv src/db/migrations/119_fork_farm.sql src/db/migrations-local/
git commit -m "Move fork migrations to the local track"
```

### Step 2 — on each database

Try it on a copy of the database first. The dry run reads the database and writes nothing:

```bash
DATABASE_URL=postgres://…/copy_of_prod pnpm migrate --dry-run
# in a container: ./node_modules/.bin/tsx scripts/migrate.ts --dry-run
```

It prints:

- A note if `pgmigrations` doesn't exist: the database has never been migrated, so check
  `DATABASE_URL`.
- **Planned moves:** the `pgmigrations` rows that will move to `pgmigrations_local`, keeping
  their `id`, `name` and `run_on`.
- **Order check after the moves**, on each track.
- **Objects the local migrations create**, and any **created on both tracks**. A warning
  here means your fork may have built something upstream also built under its own name;
  check each one by hand.
- Whether boot **would go ahead** or **stop**, and why.

Before step 1, with nothing in the local directory yet, it shows the order check
node-pg-migrate will run at boot. A fork that has merged new upstream migrations sees here
the failure this guide fixes.

Exit codes, for scripting: `0` boot would go ahead; `1` boot would stop; `2` boot would go
ahead but the report has warnings (objects created on both tracks); `3` the dry run itself
failed (no `DATABASE_URL`, can't connect).

When the dry run is clean, deploy and boot as usual (or run `pnpm migrate`). The move
happens in one transaction before the upstream migrations run, then any pending upstream and
local migrations apply. Running it again moves nothing.

### When it refuses

Nothing is written when it refuses. The cases:

- **A name in both directories.** You copied a migration instead of moving it. Delete one copy.
- **A history row with no file.** A row in `pgmigrations` matches no file on either track,
  or a row in `pgmigrations_local` matches no local file. Restore the file; if it is your
  fork's, put it in the local directory. If every local file is missing, check that the
  local directory is where boot is looking.
- **The local track is out of order.** Your migrations were applied in a different order
  from their filenames (for example, you renumbered one after it ran). The dry run proposes
  renames: `git mv` lines for the files and `UPDATE` statements for their rows. Apply both
  together, on every instance, then boot.
- **The upstream track is out of order.** An upstream migration sorts before one already
  applied. This is the old `checkOrder` error, now caught before anything moves; usually a
  file is missing from step 1.
- **A name recorded on both tracks.** Someone edited the history tables by hand. Delete the
  wrong row.
- **An id already taken in `pgmigrations_local`.** The two tables number their rows
  independently, so moving a migration you applied from `src/db/migrations` after local
  migrations have run can collide. Give the `pgmigrations` row an unused id by hand, keeping
  its `run_on`, then boot.
- **`pgmigrations_local` is not a history table.** A table by that name exists without
  node-pg-migrate's columns (`id` with a sequence, `name`, `run_on`). Curia didn't create
  it; rename or drop it.

Two cases the tool cannot detect by name, so check them yourself:

- **You edited an upstream migration in place.** The second git command in step 1 catches it.
- **You reimplemented an upstream migration under your own name.** The dry run's "created on
  both tracks" list is the guard. Upstream migrations from 118 on are guarded and
  shape-checked, so they skip an identical object and stop with a clear message on a
  different one; older upstream migrations are not.
