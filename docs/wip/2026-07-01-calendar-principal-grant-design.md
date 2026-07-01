# Calendar operates as the principal (bind the calendar client to the CEO grant)

**Status:** Design memo — awaiting review. Implementation tracked in #1217.
**Date:** 2026-07-01

## Problem

Accepting calendar invites fails in production (#1217). The surface error is a Google
400 `omittedAttendeesSpecified` from `NylasCalendarClient.sendRsvp`. The issue
originally framed this as a malformed RSVP request shape. It is not — the request body
is already the canonical `{ status }` with `calendar_id` in the query string and no
attendee data.

The real cause is **identity**:

1. The calendar client is constructed once at boot and bound to
   `resolvedEmailAccounts[0].nylasGrantId` — the primary `email_accounts` row, i.e.
   **Curia's own mailbox grant** (`src/index.ts:778-782`). It is not the CEO's grant.
2. The `ceo-inbox-*` skills authenticate with a separate, dedicated secret,
   `ceo_nylas_grant_id` — the **CEO's personal grant** (`skills/_shared/ceo-nylas-client.ts`,
   `scripts/seed-vault.ts:36`).

These are two different Google identities. So today the calendar operates as a
**third-party delegate** on the CEO's calendar, while the CEO's inbox operates as the CEO.

RSVP is inherently first-person: Nylas/Google `sendRsvp` records the response status of
the attendee whose identity matches the authenticated grant. When an invite is addressed
to the CEO, Curia's grant is not an attendee, so Google rejects the RSVP
(`omittedAttendeesSpecified`). No request-shape change can make a delegate RSVP on behalf
of the invited person; the provider ties RSVP to the invited identity.

Nylas resource IDs are also grant-scoped: the event the CEO's inbox sees under
`ceo_nylas_grant_id` has a different Nylas ID than the same event seen via Curia's
delegated grant. Reading the invite under one grant and RSVPing under another is the exact
"cross-grant Nylas ID" failure class the ceo-inbox redesign (v0.25.0) was built to eliminate.

## Decision

**Bind the calendar client to the principal's grant, and reuse the existing `calendar-*`
skills unchanged.** Resolve the calendar grant at boot as:

```
principalCalendarGrant = (await secretsService.get('ceo_nylas_grant_id'))
                         ?? resolvedEmailAccounts[0]?.nylasGrantId
```

and construct `new NylasCalendarClient(config.nylasApiKey, principalCalendarGrant, logger)`.

Consequences:

- Every existing calendar skill (`calendar-respond-to-invite`, `-create-hold`,
  `-holds-sweep`, `-create-event`, `-update-event`, `-delete-event`, `-check-conflicts`,
  `-find-free-time`, `-list-events`, `-list-calendars`, `-register`) now runs as the CEO.
  RSVP works because the CEO is the attendee. Holds and events on "the CEO's calendar"
  are genuinely the CEO's, with the CEO as organizer — not Curia-the-delegate.
- No new skills and no new client class. The calendar domain becomes single-identity
  (the principal), so a dedicated client (as ceo-inbox needed for email) is unnecessary —
  there is no second calendar identity to multiplex against.
- The manifest text that already claims the client is "bound to the configured principal
  grant" (`calendar-respond-to-invite/skill.json:11`) becomes true.

**Curia's own calendar** is dropped from this skill surface. Curia has no current need to
operate its own calendar; if that changes, the workspace-mcp calendar tools can serve it
independently, without disturbing this single-identity model.

## Alternatives considered (and why not)

- **New `ceo-calendar-*` skill family (mirror ceo-inbox):** correct but duplicative. The
  ceo-inbox split existed because email serves two live identities (Curia's mailbox + the
  CEO's) simultaneously and had to avoid multiplexing. Calendar serves only the CEO, so a
  second client/family adds surface with no identity to separate from.
- **Fix only the `sendRsvp` request shape:** cannot work. The grant is provably not the
  CEO's; a delegate cannot RSVP for the invited party regardless of payload.
- **Route only RSVP through a CEO grant; keep holds/CRUD delegated:** reintroduces two
  grant identities in one domain (cross-grant IDs) — the precise thing ceo-inbox
  consolidated away — and holds/CRUD are also more correct under the CEO's grant anyway.

## Scope of change (for #1217)

1. **Boot wiring** (`src/index.ts` ~774-782): resolve `principalCalendarGrant` with the
   fallback above; construct the client with it; update the comment. Decide whether to
   relax the construction gate so the calendar can run on a CEO grant even without any
   `email_accounts` row (`config.nylasApiKey && principalCalendarGrant`) rather than
   requiring `resolvedEmailAccounts.length > 0`.
2. **Manifest cleanup:** correct the "account is informational / configured principal grant"
   wording in `calendar-respond-to-invite/skill.json` and the matching handler warning so
   they describe the real (now-CEO) identity.
3. **Agent prompt** (`agents/calendar.yaml`): collapse the "my calendar (CEO) vs your
   calendar (Curia)" disambiguation — the client is unconditionally the principal's. Verify
   first that nothing actively writes to Curia's own calendar (the 01:00 holds-sweep already
   runs CEO-scoped, a good sign).
4. **Registry-defaults** (`config/registry-defaults.yaml`): add `calendar-respond-to-invite`,
   `calendar-create-hold`, `calendar-holds-sweep` so a fresh boot enrolls them (the issue's
   layer-1 "skill not loaded at boot" fix).
5. **RSVP verification + test:** keep the `{ status }` shape; prove accept/decline/tentative
   against a real invite under the CEO grant; pin a unit test on the request shape (fails if
   attendee data leaks into the body).
6. **Versions:** bump `calendar-respond-to-invite/skill.json` and `agents/calendar.yaml`
   versions; add a CHANGELOG entry.

## Migration / operations

- **One-time re-registration:** calendar IDs are grant-scoped, so after the flip the CEO's
  `contact_calendars` entry must be re-registered under the new grant. Tooling exists:
  `calendar-list-calendars` (now enumerates the CEO's own calendars) + `calendar-register`.
  Under the CEO's own grant this is typically their primary calendar — simpler and more
  stable than a shared-calendar ID.
- **Orphaned holds:** holds created under the old grant's calendar ID orphan after the flip.
  `holds-sweep` tolerates staleness; a manual sweep can clear them at cutover.
- **Deployments without a CEO grant:** the fallback preserves today's behavior (primary
  account), so single-identity / self-host setups are unaffected.

## Verification / open items to confirm at implementation

- `secretsService.get('ceo_nylas_grant_id')` is reachable at the construction point
  (secretsService is already used at `src/index.ts:721`; accessor is
  `get(name): Promise<string | null>`). Confirmed.
- Only calendar skills consume `nylasCalendarClient` — no coordinator/scheduler dependence
  on a Curia-identity calendar — so the blast radius is the single construction site. Confirmed.
- One Nylas app / one API key hosts both grants (`migration 064` comment), so the existing
  constructor works with a swapped grant arg. Confirmed.
- If the Nylas **SDK** `sendRsvp` still misbehaves under the CEO grant (e.g. it PATCHes the
  full event rather than hitting the dedicated send-rsvp endpoint), fall back to a raw
  `fetch` RSVP mirroring the `CeoNylasClient` approach.
