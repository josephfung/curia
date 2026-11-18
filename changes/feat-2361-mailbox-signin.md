### Added

- **Mailbox sign-in** — add Curia's and the principal's Gmail mailboxes by signing in with Google. (#2361)
- **Nylas sign-in setup** — Settings registers the callback and creates the Google connector from the saved API key. (#2361)
- **Nylas region** — choose US or EU, or detect it, instead of the hardcoded US API. (#2361)
- **Mailbox outage email** — reconnect link only on grant auth failures when sign-in is ready; else manual steps. (#2361)
- **Connect a new address** — the principal can add a new mailbox address by asking Curia directly. (#2361)

### Changed

- **Public API: bus event types** — new `principal_mailbox.connected` and `mailbox_signin.finished` events. (#2361)
- **Public API: `secret.changed` actions** — gains `nylas_region`, `nylas_callback` and `nylas_connector`. (#2361)
- **Public API: `initiatedBy`** — gains `signin_callback` on `principal_mailbox.changed` and `secret.changed`. (#2361)
- **Public API: `notificationType`** — gains `mailbox_signin_admin_blocked`. (#2361)
- **Public API: `ToolContext`** — new `mailboxSignIn` and `nylasSignInReadiness` capability fields. (#2361)
