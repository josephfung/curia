### Added

- **Scheduled job skills** — contacts and ceo-inbox YAML jobs declare skills for pre-activation. (#2764)
- **Inbox drain** — seeds `tasks` and `executive-profile` on `progress.activeSkills`. (#2764)

### Changed

- **`principalReach` regression** — every shipped agent keeps send reach only via listed skills. (#2764)
