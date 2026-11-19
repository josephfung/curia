### Added

- **Public API: `mailbox_signin.finished`** — new outcome `account_limit` when Nylas refuses a sign-in at its account limit. (#2361)
- **Console mailbox sign-in** — Connect with Google adds a principal mailbox with no address typed; Google supplies it. (#2361)

### Changed

- **Public API: `ToolContext.nylasSignInReadiness`** — reason `sandbox` removed (a sandbox is ready); adds `environment` and `checks`. (#2361)
