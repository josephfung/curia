### Changed

- **Contacts dedup scan** — merges proven duplicates itself, never on name alone; the principal sees known or trusted people and cross-tier pairs. (#2493)
- **Contacts dedup scan** — closes settled review tasks and stops re-filing decided or deferred pairs for eight weeks. (#2493)
- **`contact-dedup-exclude`** — new `decided_by` input records whether Curia or the principal ruled. (#2493)
- **`contact.merged` event** — **public API:** optional `reason` and `mergedBy` fields audit automatic merges. (#2493)
