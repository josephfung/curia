### Changed

- **Contacts dedup scan** — auto-merges proven duplicates, never on name alone; principal reviews ambiguous pairs. (#2493)
- **Contacts dedup scan** — closes settled review tasks and stops re-filing decided or deferred pairs for eight weeks. (#2493)
- **`contact-dedup-exclude`** — new `decided_by` input records whether Curia or the principal ruled. (#2493)
- **`contact.merged` event** — **public API:** optional `reason` and `mergedBy` fields audit automatic merges. (#2493)
