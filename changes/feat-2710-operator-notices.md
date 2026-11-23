### Added

- **Operator notices** — technical alerts go to the operator Setup recorded, one audience per type. (#2710)
- **Operator settings page** — view, change or clear the operator in the console, with its history. (#2710)

### Changed

- **`outbound.notification`** — **public API:** the payload carries a resolved `recipient` and `audience`; `ceoEmail` is gone. (#2710)
- **Scheduler and outage alerts** — suspended jobs, recovered jobs and mailbox outages now reach the operator, not the executive. (#2710)

### Fixed

- **System notices** — a notice no longer records its recipient as a known-tier contact. (#2710)
