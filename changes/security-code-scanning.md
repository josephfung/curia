### Security

- **OKF link extraction** — wikilink and markdown-link regexes no longer go quadratic on unclosed brackets (CodeQL).
- **Console build** — service-worker stamping reads `dist/sw.js` directly instead of check-then-read (CodeQL).
- **Prompt-text test** — probe file now lives in a private `mkdtemp` directory, not shared tmp (CodeQL).
