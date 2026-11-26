### Added

- **`skill.activated` (public API)** — bus event for each skill activation with its `by` path. (#2764)

### Fixed

- **`scenarios:compare`** — scheduled gates key off `inbound.from: scheduler`, not the tag; pass-rate flags per behaviour. (#2764)
