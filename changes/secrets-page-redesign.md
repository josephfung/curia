### Added

- **Personal secrets in the console** — create, edit and remove website logins; platform keys read-only. (#2478)
- **Secrets page** — one searchable, sortable list of personal, system and platform secrets with drawers. (#2478)
- **`DELETE /api/vault/secrets/:name`** — removes declared, personal and orphaned secrets; refused while required unless forced. (#2478)

### Changed

- **`secret.changed`** — **public API:** audit also covers `details` edits; key names only. (#2478)
