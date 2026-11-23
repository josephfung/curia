### Changed

- **Setup guide** — during Setup, web chat reaches the setup agent, kept out of the principal's memory. (#2358)
- **`setup-wizard` agent** — explains and checks only; preference, memory, profile, contact and scheduler tools removed. (#2358)
- **Start onboarding** — the principal gets a fresh web thread; the Setup chat stays archived. (#2358)

### Added

- **`AgentTaskPayload.setupStep`** — bus field naming the open Setup step on a setup guide turn. (#2358)
