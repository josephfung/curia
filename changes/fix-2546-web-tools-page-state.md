### Fixed

- **`web-browser` element list** — leaves out controls the page hasn't rendered, so agents stop clicking hidden buttons. (#2546)
- **`web-browser` `url`** — refused on anything but `navigate`; reading an empty session now says no page is open. (#2546)
- **`web-fetch`** — flags pages with no readable text and points agents to `web-browser`. (#2546)
