### Added

- **Finesse scenario cases** — 46 cases test recipient-aware decisions and voice, from a casebook six EAs reviewed. (#2556)
- **Scenario behavior layers** — decision and voice behaviors are scored and reported separately. (#2556)
- **Blind identification** — a judge matches each contrast group's messages to recipients; tracked, not gated. (#2556)
- **`pnpm rejudge --from-cases`** — re-scores saved transcripts against edited case files; refuses cases whose setup changed. (#2556)
- **Scenario judge per case** — a case or tag can choose its judge model. (#2556)
- **`pnpm grading`** — samples a blind grading sheet from a run and measures judges' agreement with it. (#2556)
- **Scenario reply from a contact** — `inbound.then` can script the other person's reply to what Curia sent. (#2556)
- **Seeded contact profile** — scenario contacts take a title and organization. (#2556)
- **`pnpm scenarios --case`** — takes a comma-separated list, picking every case matching any part. (#2556)

### Fixed

- **Scenario judge** — a reply with text after its JSON is read; unreadable replies are retried. (#2556)
