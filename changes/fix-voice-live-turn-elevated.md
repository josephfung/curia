### Fixed

- **Voice elevated actions** — principal-directed elevated tools now run on a live call through `async-offramp`. (#2495)

### Security

- **Live-turn grants** — a call's live turn ends with the call; later elevated actions request principal confirmation. (#2495)

### Changed

- **public API: `agent.task` / `ToolContext`** — new `liveTurnGrantId` field bounds `liveTurn` to an active voice grant. (#2495)
