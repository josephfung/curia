### Security

- **Browser egress** — the browser container refuses requests to private, loopback and link-local addresses, by resolved address. (#2521)
- **`web-browser`** — navigation and frame reads refuse public names that resolve to private addresses. (#2521)
- **`web-fetch`** — connects each hop, redirects included, only to addresses vetted just before. (#2521)
- **HTTP server** — refuses requests from the browser container's address. (#2521)
