### Added

- **`pnpm changelog:assemble`** — merges per-PR fragments from `changes/` into CHANGELOG.md at release. (#2484)
- **Release skill** — the release procedure moves from CLAUDE.md into `.claude/skills/release`. (#2484)

### Changed

- **Changelog entries** — each PR adds `changes/<branch>.md` instead of editing CHANGELOG.md, ending merge conflicts. (#2484)
