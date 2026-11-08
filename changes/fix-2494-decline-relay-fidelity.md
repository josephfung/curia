### Fixed

- **Specialist decline relay** — cause and finished work travel as data; replies no longer contradict the specialist. (#2494)

### Added

- **`ToolResult.gate`** — **public API:** execution-layer access-gate refusals are tagged, so declines report permission, not capability. (#2494)
- **`agent.response.gateRefusals`** — **public API:** bus event field listing a task's gate-refused tool calls. (#2494)
