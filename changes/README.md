# Changelog fragments

Every PR that changes shipped behavior adds **one file here** instead of editing
`CHANGELOG.md`. Two PRs never touch the same file, so there are no changelog merge
conflicts and no changelog-only commits.

## File

- Path: `changes/<branch-name>.md`, with `/` in the branch name written as `-`
  (branch `fix/foo-bar` becomes `changes/fix-foo-bar.md`).
- Content: the same `### Added` / `### Changed` / `### Fixed` / `### Removed` /
  `### Security` headings and bullets `CHANGELOG.md` uses. No `## [Unreleased]` heading.
- One single-line bullet per logical change: `- **Feature name** — what changed. (#123)`.
- **15 words maximum after the em-dash** (a trailing `(#123)` does not count). The
  mechanism and the "how" belong in the PR body.
- Call out public API changes explicitly, e.g. `**public API:**` in the bullet.

```markdown
### Fixed

- **`extract-facts`** — programming errors in the per-fact loop now re-throw instead of incrementing `failed`. (#493)
```

ADR-only and comment-only PRs, which change nothing that ships, add no fragment.

## Checks and release

- `tests/unit/changelog-fragments.test.ts` validates every fragment (allowed headings,
  bullet shape, word cap), so a malformed one fails the PR that adds it.
- At release time the release skill runs `pnpm changelog:assemble`, which merges all
  fragments into `CHANGELOG.md` and deletes them. Preview with `--dry-run`.
