## Added

- **ADR-070** — skills load on demand behind a temporary `skill_loading` switch. (#2764)

## Changed

- **Skill pins** — `on_demand` lists name + description; bodies and tools load on activation. (#2764)
- **`skill-activate`** — accepts `skills[]` and delivers bodies append-only in the tool result. (#2764)
- **Pre-activation** — shared entry point for wake, conversation, jobs, bullpen, and digests. (#2764)
- **Scheduled jobs** — model activations persist for job-learned pre-activation on later runs. (#2764)
