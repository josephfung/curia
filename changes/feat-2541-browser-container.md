### Added

- **Browser container** — `docker compose up` now includes a working `web-browser`, via a separate `curia-browser` image. (#2541)
- **Setup wizard** — new "Web browser" task, done while the browser container is attached. (#2541)

### Changed

- **`web-browser`** — Curia boots without the browser container and reconnects when it returns. (#2541)

### Security

- **Browser isolation** — Chrome runs without Curia's secrets or database route; only its container relaxes seccomp. (#2541)
