### Fixed

- **Contact timezones** — calendar labels map to IANA zones; unrecognized values are rejected; stored ones repaired at boot.
- **Principal timezone** — only the principal or console changes it; email-extracted facts no longer stop inbox triage.
- **Inbox triage** — an unusable principal timezone falls back to the instance zone; heartbeat errors now log messages.
