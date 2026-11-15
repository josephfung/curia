### Fixed

- **Content-block rewrite** — rewrite turns run without tools and see what their turn already did. (#2615)

### Changed

- **`agent.task` `toolAllowlist`** — **public API:** an empty or malformed list now means no tools, not the full set. (#2615)
- **`agent.task` `priorTurnActions`** — **public API:** new field; a rewrite's prior tool calls, rendered into its prompt only. (#2615)
