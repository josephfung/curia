### Added

- **Scheduled job skills** — contacts and ceo-inbox YAML jobs declare skills for pre-activation. (#2764)
- **Inbox drain** — seeds `tasks` and `executive-profile` on `progress.activeSkills`. (#2764)
- **`files` skill** — `file-parse` and `archive-extract` load on activation. (#2764)
- **`secrets` skill** — vault list/capture tools load on activation. (#2764)
- **Scheduler fire tests** — declared/learned skills and debrief `digest` land on `preActivateSkills`. (#2764)
- **`measure-2764-cache.sql`** — Round-1 cache share and `skill.activated` counts for Layer 3. (#2764)

### Changed

- **`principalReach` regression** — every shipped agent keeps send reach only via listed skills. (#2764)
- **Agent schedule schema** — allows `skills` on declarative jobs for pre-activation. (#2764)
- **Coordinator pins** — lists `files`, `secrets`, `contacts`, `verification`, and `record-outreach` on demand. (#2764)
- **`job-report` skill** — includes `activity-log`; coordinator no longer tool-pins it. (#2764)
- **ADR-046 budget** — always-on is YAML; skill list is its own budget row. (#2764)

### Fixed

- **`skill.activated` tests** — every code pre-activation path asserts `by`. (#2764)
- **Skill exfiltration** — boot walk covers every SKILL.md body and reference. (#2764)
- **Skill descriptions** — CI requires a when-to-load clause on every description. (#2764)
