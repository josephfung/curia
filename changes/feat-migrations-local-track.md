### Added

- **Local migration track** — forks' own migrations run from `src/db/migrations-local/` into `pgmigrations_local`, after upstream. (#2465)
- **`pnpm migrate --dry-run`** — previews moving a fork's applied migrations onto the local track; writes nothing. (#2465)

### Changed

- **Upstream migrations** — from 118 on, DDL must be guarded and shape-checked; a CI lint enforces it. (#2465)
