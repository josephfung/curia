# Remove `config.ceoPrimaryEmail` — `findContactBySystemRole('principal')` as single source of truth

Issue: #1049 (closes). Branch: `fix/remove-ceo-primary-email-1049`.

## Problem

`CEO_PRIMARY_EMAIL` / `config.ceoPrimaryEmail` does double duty: a one-time
contact-creation trigger (`bootstrapCeoContact`) *and* a runtime identity source
(PiiRedactor bypass UUID, outbound-filter allow-list, CEO notifiers, EmailAdapter).
The two paths diverge: fresh-setup mode (in-app onboarding #771) skips the env-var
bootstrap, leaving `ceoContactId` undefined so principal-bound messages are
wrongly redacted. Now that #771 creates the principal (`system_role='principal'`),
the env var is redundant.

## Approach

Make `findContactBySystemRole('principal')` the single startup path. Resolve the
principal contact **once, early** (right after agent self-identity bootstrap, where
`bootstrapCeoContact` used to run), derive:

- `principalContactId = principalContact?.id` → passed to `PiiRedactor` (replaces `ceoContactId`)
- `principalEmail` = the principal's verified email channel identity (prefer `active`)
  → replaces every runtime read of `config.ceoPrimaryEmail`

Then call `repairPrincipalMetadata(principalContactId)` (preserved utility) so an
existing principal left at migration-055 defaults self-heals at startup.

The readiness gate (`system_role='principal'` must exist, else setup-required mode)
is unchanged and remains the hard failure. In setup-required mode the principal is
null, so `principalContactId`/`principalEmail` are undefined/'' — identical to
today's "env var unset" skip path. No regression.

## Edits

- **src/config.ts** — remove `ceoPrimaryEmail` field, `normalizeCeoPrimaryEmail`,
  `ceoPrimaryEmailIsPlaceholder`, `CEO_PRIMARY_EMAIL_PLACEHOLDER` (all internal-only).
- **src/index.ts** —
  - drop `bootstrapCeoContact` + `ceoPrimaryEmailIsPlaceholder` imports & placeholder warning;
  - replace the `bootstrapCeoContact` block with early principal resolution
    (contact + identities + `principalEmail` + `repairPrincipalMetadata`);
  - reuse those values at the readiness check (no second DB query);
  - PiiRedactor `ceoContactId: principalContactId`;
  - outbound filter `ceoEmail`, EmailAdapter `ceoEmail`, Suspension/Recovery notifiers,
    ApprovalTriggerService → `principalEmail`.
- **src/contacts/ceo-bootstrap.ts** — delete `bootstrapCeoContact`; keep
  `repairPrincipalMetadata`, `insertKgPersonNode`, `createAndLinkKgNode` (used by
  ensure-principal.ts). Update header comment.
- **skills/approval-expiry-sweep/handler.ts** — resolve principal email via
  `ctx.contactService.findContactBySystemRole('principal')` + identities instead of
  reading `process.env['CEO_PRIMARY_EMAIL']` (would otherwise silently break = lost
  CEO alerts). Bump skill version.
- **scripts/render-coordinator-prompt.ts**, **scripts/inspect-prompts.ts** — resolve
  principal display name via `WHERE system_role='principal'` instead of email lookup.
- **.env.example + docs** (`docs/dev/configuration.md`, `setup.md`,
  `docs/specs/08-operations.md`, `18-onboarding.md`, ADR-021 mention) — remove
  `CEO_PRIMARY_EMAIL`.

## Tests

- `tests/integration/ceo-bootstrap.test.ts` — bootstrapCeoContact removed; migrate the
  KG-node-conflict cases (permanent promotion, no-demote, label isolation) to test
  `insertKgPersonNode` directly (shared, still live).
- `tests/unit/config.test.ts` — drop ceoPrimaryEmail/placeholder cases.
- `src/dispatch/pii-redactor.test.ts` — add: redactor built with principal contact id
  from `findContactBySystemRole` → recipient UUID match → no redaction (AC).
- `skills/approval-expiry-sweep/handler.test.ts` — update to contactService resolution.

## Out of scope (noted, not touched)

- `ceoSignalNumber` / `CEO_SIGNAL_NUMBER` — same dual-duty smell but separate field.
- KG-node backfill that `bootstrapCeoContact` did for pre-#380 email-bootstrapped
  principals: dropped. Acceptable — #771 + migration 062 mean prod principals already
  have permanent KG nodes; ensure-principal backfills the wizard path.
