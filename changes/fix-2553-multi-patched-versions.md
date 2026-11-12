### Fixed

- **Override-floor audit** — reads advisories listing one patched version per release line instead of failing. (#2553)

### Security

- **Dependency floors** — raise `hono`, `@hono/node-server` and `brace-expansion` past upstream-only advisories, one HIGH. (#2553)
