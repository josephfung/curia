### Fixed

- **`contact-link-identity`** — re-stating a sourced address stored by `contact-register` verifies it, instead of requiring the console. (#2498)

### Changed

- **`web-browser` provenance** — a page read in the browser can verify an address the agent didn't type. (#2498)

### Security

- **Web identifier provenance** — `web-fetch` and `web-browser` results no longer verify addresses the agent itself supplied. (#2498)
