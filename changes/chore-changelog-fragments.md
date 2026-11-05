### Added

- **`pnpm changelog:assemble`** — merges per-PR fragments from `changes/` into CHANGELOG.md at release.
- **Release skill** — the release procedure moves from CLAUDE.md into `.claude/skills/release`.

### Changed

- **Changelog entries** — each PR adds `changes/<branch>.md` instead of editing CHANGELOG.md, ending merge conflicts.
