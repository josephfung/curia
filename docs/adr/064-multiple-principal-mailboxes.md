# ADR-064: Multiple principal mailboxes are a registry; the account follows the object

Date: 2026-11-12
Status: Accepted

## Context

The principal has more than one Gmail account, for example a personal one and a work one (Google Workspace). Curia managed exactly one, held as two flat settings (`ceo_nylas_grant_id`, `ceo_self_email`) that every ceo-inbox handler, the calendar bootstrap and the outbound gateway read directly. Forwarding one account into the other is not a workaround: it is a poor experience and often blocked by workplace policy.

An EA with delegate access works across both accounts as one job. The hard part is not a second grant. Every action against the principal's mail or calendar now has an account, and the wrong account is a real mistake: personal mail sent from the work address, a work meeting booked on the personal calendar, a draft saved where the principal will not look.

The principal decided that both mailboxes are triaged on an ongoing basis (cadence tunable per mailbox), that calendars are in scope, that choosing the account is an inference from context rather than a rule, and that memory stays shared. Gmail only; the registry must not preclude another provider.

Alternatives considered:

- **A second pair of flat settings** (`ceo_nylas_grant_id_2`). Every handler would need to know how many there are, and nothing would tie a grant to its address, its triage state or its send level.
- **Choosing the account with a rule in code** ("work domain means work"). Real choices are not that regular: the same accountant gets corporate-audit mail at work and tax mail at home.
- **Falling back to the default mailbox when the account is unclear.** The cheapest code, and the exact failure the feature exists to prevent.

## Decision

**A registry.** Mailboxes are rows in `principal_mailboxes` (id, label, address, provider, default flag, triage start, removed-at). The Nylas grant stays a vault secret per mailbox, `principal.mailbox.<id>.nylas_grant_id`; the shared API key is unchanged. The address is read from Nylas when a mailbox is added, never typed by the operator, so a mailbox cannot be wired to the wrong account.

**One service resolves every client.** `PrincipalMailboxes` lists mailboxes and builds the email and calendar client for one of them, on each call, so a grant change needs no restart. An **unknown or removed id is an error, never a fallback to the default.** Callers that pass an existing object id (a draft, a message, an event) get the account from the object: code locates it, and an explicit mailbox that does not hold it is a 404, not a search elsewhere.

**Ids are immutable and never reused.** Removal is a tombstone (the grant is deleted, the row keeps `removed_at`), so everything keyed by an id (send level, cadence, ledger and dedupe records, rules, per-contact preferences) can never attach to a later mailbox, even one labelled "Work" again. The id is a slug (`^[a-z][a-z0-9-]{0,31}$`); `primary` and `default` are reserved.

**Evidence-based choice for new objects.** For a new draft or event, code computes per-mailbox evidence from the recipients (history of sent and received mail, whether the domain matches the mailbox) and the tool refuses to act without a stated `mailbox` once there is more than one. The agent decides from the principal's words, preferences and that evidence; it says which account only when the choice was a real judgement call, and asks when the evidence is split. A correction is cheap (a draft can be moved).

**Upgrade.** A single-mailbox install is migrated at boot from the flat grant into one default row. If neither the grant lookup nor `ceo_self_email` yields an address, the flat grant is served as an in-memory mailbox until the migration succeeds, and the migration is retried on each health-canary tick.

**Health.** Each live mailbox has its own canary (`principal_mailbox:<id>`: grant lookup, one message, calendar list). The default mailbox's result also drives the existing `nylas_calendar` heartbeat, so a deployment's monitor keeps pinging. An outage alerts the principal once per episode, naming the mailbox by label only (never its address or grant), and suggests removing the mailbox if the account is gone.

## Consequences

- Adding, relabelling, defaulting and removing a mailbox is a console list, not a settings edit, and the setup catalog reports the capability done once one mailbox passes its canary.
- Every handler that used the flat grant must go through the service. A call that cannot name an account fails loudly instead of acting on the wrong one; that is an accepted cost.
- Removal cannot be undone by re-adding the same address: it gets a new id and a clean slate. Stale keyed state is left to age out.
- The registry is capped at one live mailbox by a code constant until every handler is converted, so no intermediate release runs a second mailbox through half-converted code.
- The principal's memory is not partitioned by mailbox. Confidentiality is about the recipient and the data, not the source account.
- The per-mailbox canary adds three Nylas calls per mailbox per day.
