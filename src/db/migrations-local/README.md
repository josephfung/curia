# Local migrations (for forks)

This directory is the **local migration track**. Upstream Curia never ships a migration
here — only this README. If you run a fork, put every schema change of your own here
instead of in `src/db/migrations/`. See [ADR-061](../../../docs/adr/061-two-track-migrations.md)
for the reasoning and [docs/dev/fork-migrations.md](../../../docs/dev/fork-migrations.md)
for moving migrations you have already applied.

## How it runs

At boot (and in `pnpm migrate`, `install.sh` and CI) Curia runs two node-pg-migrate passes:

1. **Upstream:** `src/db/migrations/`, recorded in `pgmigrations`.
2. **Local:** this directory, recorded in `pgmigrations_local`. Skipped when the directory
   has no migrations.

Each track keeps node-pg-migrate's order check, so a migration that sorts before one
already applied *on the same track* still stops the boot. The two tracks never compare
against each other, so new upstream migrations can't land behind yours.

To keep local migrations somewhere else (for example, per deployment), set
`CURIA_LOCAL_MIGRATIONS_DIR`. A relative path is resolved from the project root, and the
directory must exist: a set but missing directory stops the boot rather than skipping your
migrations.

## Rules

- **Dependency rule.** A local migration may use upstream tables. An upstream migration
  never depends on a local one. Upstream always runs first.
- **Numbering.** Use any numeric prefix you like (`001_…`, or a timestamp). The order only
  has to be consistent within this directory. Never reuse a name that exists in
  `src/db/migrations/`: boot refuses a name that is in both.
- **Naming.** Prefix your own tables and columns, for example `fork_…` or your
  organisation's short name, so a future upstream table or column is unlikely to collide
  with yours.
- **Files.** `.sql` (or `.js` when you need `pgm.noTransaction()`), as upstream does.
  Markdown and dotfiles here are ignored.
- **Promoting a feature upstream.** Write a fresh upstream migration, guarded and
  shape-checked as ADR-061 requires, so it does nothing on your instance where your local
  migration already created the same thing. Keep the local migration file: it is in
  `pgmigrations_local`, and deleting it makes boot refuse to start.
