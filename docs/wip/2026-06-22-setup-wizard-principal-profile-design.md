# Setup wizard — principal operational profile

**Issue:** [#392](https://github.com/josephfung/curia/issues/392) — feat: augment setup wizard with principal operational profile
**Date:** 2026-06-22
**Status:** Design approved

## Summary

The form-based setup wizard (`apps/console/src/pages/WizardPage.tsx`) currently captures the
principal's name (Step 1) and the assistant's identity/tone/posture (Steps 2–4). This change
adds a **principal operational profile** step that captures the timezone, email, preferred name,
title, and working hours Curia needs to function well from day one, and fixes a bug where the
name step can never be re-edited once a principal exists.

## Findings that reshaped the issue

The issue text was written against an older architecture. Two premises are stale; the design
reflects current reality:

1. **`CEO_PRIMARY_EMAIL` env bootstrap is gone** (removed in #1049). The principal is now created
   **only** by the wizard (`POST /api/setup/principal`), and the principal's email is derived at
   startup from a **verified + active email channel identity** (`contact_channel_identities`),
   not an env var. There is no code path that creates a principal with `display_name = 'CEO'`.
   - The *real* current bug behind the issue's "auto-skip" item: Step 1 hard-skips whenever a
     principal exists (it only checks a `principalExists` boolean), so once a principal is created
     its display name can **never** be corrected via the wizard.

2. **No new table or column is needed.** The `contacts` table already has canonical columns
   `timezone`, `preferred_name`, `title`, `primary_email`, `locale` (migration 048). The
   `canonical-attribute-guard` enforces a single read path: canonical attributes live on contact
   columns and are surfaced to agents by the entity-context assembler; non-canonical attributes
   (like working hours) flow to the KG as facts.

## Storage model

All profile data lives on the principal **contact** or its **KG node** — no migration.

| Field | Storage | Mechanism |
|-------|---------|-----------|
| Timezone | `contacts.timezone` (canonical column) | `ContactService.updateContactFields` |
| Preferred name | `contacts.preferred_name` (canonical) | `updateContactFields` |
| Title | `contacts.title` (canonical) | `updateContactFields` |
| Email | `contact_channel_identities` (verified) + `contacts.primary_email` | `linkIdentity(source='ceo_stated', verified=true)`, then `updateContactFields({ primaryEmail })` |
| Working hours | KG **fact** on the principal's `kg_node_id` | `EntityMemory.storeFact` |

### Email ordering constraint

`updateContactFields` validates `primaryEmail` against existing channel identities
([contact-service.ts:917](../../src/contacts/contact-service.ts)). So the email must be linked
**first** via `linkIdentity`, then written to `primary_email`. Source `ceo_stated` is in
`AUTO_VERIFIED_SOURCES`, so the identity is created `verified=true`. After the wizard-end restart,
`index.ts` resolves `principalEmail` from this identity immediately — email-dependent features
(outbound allow-list, CEO notifiers) work from day one instead of waiting for first inbound.

### Working hours as a KG fact

`working_hours` is **not** in `CANONICAL_ATTRIBUTE_MAP`, so it survives the assembler's canonical
filter and surfaces to agents through entity-context enrichment. Stored as:

```
storeFact({
  entityNodeId: principalContact.kgNodeId,
  label: 'Working hours',
  properties: { attribute: 'working_hours', value: '<readable string>', category: 'preference' },
  confidence: 1.0,
  decayClass: 'permanent',
  source: 'system:setup-wizard',
})
```

The value is a natural-language string (e.g. `"Mon–Fri, 9:00 AM–5:00 PM"`) — richer for KG
browsing and better for LLM consumption than raw JSON. The wizard collects it structured
(time range + weekday toggles) and serializes. Because the fact carries `properties.attribute`,
`storeFact` runs contradiction detection, so re-running the wizard updates the existing fact
rather than accumulating duplicates.

## Timezone behavior (system clock untouched)

`config.timezone` is read once at boot from `process.env.TIMEZONE ?? 'America/Toronto'`
([config.ts:819](../../src/config.ts)) and consumed by reference (scheduler, runtime, task repo,
skill registry). It is **not** persisted to any DB-backed config and is **not** reloaded at runtime.

This change stores the principal's timezone on `contacts.timezone`, which the entity-context
assembler surfaces to agents **live** ([assembler.ts:170](../../src/entity-context/assembler.ts)) —
agents become timezone-aware of the principal with no restart.

**Explicitly out of scope (deferred to a follow-up issue):** overriding `config.timezone` /
the system clock / cron scheduler from the principal's contact timezone. The system timezone
stays env-driven. Rationale: principals travel, so a contact-timezone → system-clock override is
an unnatural patch; making the system timezone dynamic deserves its own design.

**AC impact (stated honestly):** "selected timezone … used by the runtime" is satisfied for agent
*reasoning* (enrichment, live, no restart) but **not** the cron scheduler / system clock, which
remains env-bound. This split is called out in the PR and the follow-up issue.

## Wizard step structure

`apps/console/src/pages/WizardPage.tsx`, `wizard-utils.ts`. `TOTAL_STEPS` 5 → 6.

- **Step 1 "About you"** — principal name. **Never auto-skips.** On mount, load the existing
  principal (if any) and pre-populate the input so the deployer can confirm/correct it. Removes
  the auto-skip effect ([WizardPage.tsx:214](../../apps/console/src/pages/WizardPage.tsx)).
- **Step 2 "Your details" (NEW)** — operational profile:
  - **Timezone** (required) — IANA dropdown, pre-filled from
    `Intl.DateTimeFormat().resolvedOptions().timeZone`.
  - **Email** (optional) — text input, pre-filled from the existing verified principal email.
  - **Preferred name** (optional).
  - **Title** (optional).
  - **Working hours** (optional, skippable) — start/end time + weekday toggles.
- **Steps 3–6** — existing Assistant identity / Tone / Posture / Review, renumbered from 2–5,
  otherwise unchanged.

A dedicated step (vs. merging into Step 1) keeps the existing name-create POST flow isolated and
the new fields independently testable.

## API surface

`src/channels/http/routes/setup.ts`.

- **`GET /api/setup/principal`** (new) → `{ exists, displayName, timezone, preferredName, title,
  email, workingHours }` (nulls when absent). Wizard mount uses it to pre-populate Steps 1 & 2.
- **`POST /api/setup/principal`** (existing) → extended: when the principal already exists,
  **update** `display_name` (and the linked KG node label) instead of no-op'ing. Still creates on
  first call. Enables the name correction.
- **`POST /api/setup/principal/profile`** (new) → body
  `{ timezone, email?, preferredName?, title?, workingHours? }`. Requires the principal to exist.
  1. Validate `timezone` is a real IANA zone (`Intl.DateTimeFormat` guard) → 422 otherwise.
  2. If `email` present and syntactically valid → `linkIdentity(ceo_stated, verified=true)`.
  3. `updateContactFields({ timezone, preferredName?, title?, primaryEmail? })` — only defined fields.
  4. If `workingHours` present → serialize + `storeFact` on the principal KG node.
  Step 2 "Continue" calls this.

### `workingHours` request shape

```ts
{ start: string /* "09:00" */, end: string /* "17:00" */, days: number[] /* 0=Sun..6=Sat */ }
```

Serialized server-side to the readable string stored in the fact.

## Error handling

- Timezone: server-side `Intl.DateTimeFormat` validation (mirrors config.ts); 422 on bad zone.
- Email: syntactic address validation; 422 on malformed. Lower-cased before linking (matches
  existing identity normalization).
- Optional fields: skipped/empty → no write (never clobber an existing value with an empty one).
- Working hours: validate `start`/`end` are `HH:MM` and `days` are 0–6; 422 otherwise.
- Name update: when the new name equals the current display name, skip the write (idempotent).
  KG node label rename handled defensively (conflict on `lower(label)` logged, contact name still
  updated — the contact column is the authoritative display name).

## Testing (TDD)

Integration (real Postgres):
- `POST /api/setup/principal` creates a principal; second call with a different name **updates**
  display name + KG label.
- `GET /api/setup/principal` returns persisted profile (incl. verified email + working-hours fact)
  and `{ exists: false }` when none.
- `POST /api/setup/principal/profile`: writes canonical fields; links a verified `ceo_stated`
  email then sets `primary_email`; stores a `working_hours` fact retrievable via the assembler;
  rejects an invalid timezone (422); leaves omitted optional fields untouched.

Unit:
- Working-hours serializer (structured → readable string) incl. all-days, weekdays-only, single day.
- Wizard step gating: Step 1 shows pre-populated (no skip); Step 2 timezone required to continue;
  optional fields skippable.

## Out of scope

- Overriding the system timezone / cron scheduler from the contact (follow-up issue).
- `ExecutiveProfile` writing-voice fields.
- Calendar (Nylas) and Signal channel setup — separate post-wizard flows.
- Email *mailbox* (which inbox Curia polls) — that's `email_accounts` + Nylas grant, configured in
  the console, distinct from the principal's own address captured here.

## Documentation

- `docs/dev/setup.md` — reference the wizard for operational-profile configuration (AC).
- CHANGELOG.md — Added entry under `[Unreleased]`.
- File a follow-up issue: "make system timezone track the principal's contact timezone".
