### Added

- **`GET /api/kg/graph?scope=all`** — returns the whole live graph with whole-graph totals; facts on request. (#2479)

### Changed

- **Knowledge Graph counts** — status and filters count against the whole graph; views draw up to 300 nodes. (#2479)

### Fixed

- **Knowledge Graph focal view** — the clicked node and its direct neighbours are kept before farther nodes. (#2479)
