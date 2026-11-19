### Added

- **Setup checklist API** — console and setup agent share one checklist; `setup_complete` gates Start onboarding. (#2358)

### Changed

- **`ToolContext` (breaking)** — `phoneAppReady`, `emailChannelStatus`, `principalMailboxReady`, `nylasSignInReadiness` replaced by `setupChecklist`. (#2358)
- **Setup catalog** — operator steps only; persona, debrief and inbox sending move to onboarding. (#2358)
