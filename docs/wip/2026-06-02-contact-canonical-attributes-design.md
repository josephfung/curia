# Contact Canonical Attributes — Design

**Issue:** #829
**Date:** 2026-06-02
**Branch:** `feat/contact-canonical-attributes`
**Follow-up:** #830 (wire enrichment + agents + stop new KG fact writes)

## Problem

The `contacts` table is thin by design. Everything the system "knows" about a person
lives as `kg_nodes` of `type='fact'` linked via `relates_to` edges, surfaced by
`EntityContextAssembler` as confidence-scored bullet points. This causes two problems:

1. **Hallucinations.** Agents fabricate values (e.g. calendar IDs, email addresses) when
   the KG fact list is thin. Even when the KG holds the truth, presenting it as a scored
   fact list invites the LLM to "reason" instead of read a structured field.
2. **Specialist friction.** Calendar, email composition, and research-analyst skills all
   need the same canonical attributes. Each ends up parsing fact bullets or guessing.

## Goal (this issue — foundation)

Persist 12 canonical attributes directly on the `contacts` row. Backfill from KG once.
Issue #830 wires these into agents/skills and stops new KG fact writes for them.

## Fields Added

All columns are `TEXT`, nullable. Added to `contacts` via `ALTER TABLE`.

| Column | Notes |
|---|---|
| `preferred_name` | Short/familiar form; falls back to `display_name` |
| `title` | Current job title |
| `organization` | Current employer, free-text |
| `primary_email` | Lowercased; app-layer validated against `contact_channel_identities` |
| `primary_phone` | E.164-formatted (free-text, no DB constraint) |
| `timezone` | IANA tz string (e.g. `America/New_York`) |
| `locale` | BCP 47 (e.g. `en-US`) |
| `location` | City/region, free-text |
| `pronouns` | Free-text |
| `linkedin_url` | Must start with `https?://` |
| `bio` | Short narrative, max 500 chars |
| `birthday` | ISO `YYYY-MM-DD` or `--MM-DD` (year-omitted) |

## Architecture

### Approach chosen: Approach B — Node.js backfill script

The backfill logic is a 3-hop join (contacts → kg person node → kg_edges → fact nodes)
with per-column highest-confidence tiebreaking. Implementing this as a standalone Node.js
script rather than a SQL migration gives:
- Structured logging (which contacts were updated, which columns changed)
- Safe re-runs (only touches NULL columns)
- Easier debugging if the KG schema has edge cases in prod

The ALTER TABLE migration ships as `048_add_contact_canonical_attributes.sql`.
The backfill runs separately via `npm run backfill:contact-attributes` during deploy.

### Layer summary

```
Migration 048        → ALTER TABLE contacts ADD COLUMN × 12 + CHECK constraints
Backfill script      → scripts/backfill-contact-attributes.ts
Contact interface    → 12 new nullable string fields on Contact + ContactCanonicalFields type
ContactService       → createContact accepts new fields; new public updateContactFields()
  Postgres backend   → createContact INSERT, updateContact UPDATE, all SELECT lists updated
  In-memory backend  → no changes (stores full Contact object)
HTTP API (kg.ts)     → GET list + POST + PATCH accept/return all 12 new fields
Console UI           → Contact interface widens; table replaces Role with Title+Organization;
                       drawer gets 6 grouped sections
Tests                → unit (service), integration (HTTP), unit (backfill script)
```

## Database Migration (`048_add_contact_canonical_attributes.sql`)

```sql
-- Up Migration

ALTER TABLE contacts ADD COLUMN preferred_name  TEXT;
ALTER TABLE contacts ADD COLUMN title           TEXT;
ALTER TABLE contacts ADD COLUMN organization    TEXT;
ALTER TABLE contacts ADD COLUMN primary_email   TEXT;
ALTER TABLE contacts ADD COLUMN primary_phone   TEXT;
ALTER TABLE contacts ADD COLUMN timezone        TEXT;
ALTER TABLE contacts ADD COLUMN locale          TEXT;
ALTER TABLE contacts ADD COLUMN location        TEXT;
ALTER TABLE contacts ADD COLUMN pronouns        TEXT;
ALTER TABLE contacts ADD COLUMN linkedin_url    TEXT;
ALTER TABLE contacts ADD COLUMN bio             TEXT;
ALTER TABLE contacts ADD COLUMN birthday        TEXT;

ALTER TABLE contacts ADD CONSTRAINT contacts_primary_email_format_check
  CHECK (primary_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
ALTER TABLE contacts ADD CONSTRAINT contacts_linkedin_url_format_check
  CHECK (linkedin_url ~ '^https?://');
ALTER TABLE contacts ADD CONSTRAINT contacts_bio_length_check
  CHECK (length(bio) <= 500);
ALTER TABLE contacts ADD CONSTRAINT contacts_birthday_format_check
  CHECK (birthday ~ '^\d{4}-\d{2}-\d{2}$' OR birthday ~ '^--\d{2}-\d{2}$');

-- Rollback:
-- ALTER TABLE contacts DROP COLUMN preferred_name, DROP COLUMN title, ...
-- (drop all 12 columns)
```

## Backfill Script (`scripts/backfill-contact-attributes.ts`)

**Entry point:** `npm run backfill:contact-attributes` (added to `package.json`)

**Algorithm:**
1. Connect to Postgres via `DATABASE_URL`
2. Fetch all contacts where `kg_node_id IS NOT NULL`
3. For each contact:
   a. Find all `kg_nodes` of `type='fact'` reachable via a single `relates_to` edge
      from the contact's KG person node (either direction)
   b. For each fact node, read `properties->>'attribute'` (case-insensitive) and
      `properties->>'value'`
   c. Map attribute keys to contact columns using the table below
   d. For each target column that is currently NULL: pick the matching fact with the
      highest `confidence`; tiebreak on most recent `last_confirmed_at`
   e. Write the value; log column name, fact node ID, confidence used
4. Print summary: contacts processed / columns written / already-populated / errors

**Attribute key → column mapping:**

| Contact column | Attribute keys matched (case-insensitive) |
|---|---|
| `preferred_name` | `preferred_name`, `nickname` |
| `title` | `job_title`, `title`, `role` *(only when contact's `system_role` IS NULL)* |
| `organization` | `organization`, `employer`, `company`, `current_employer` |
| `primary_email` | `email`, `primary_email` |
| `primary_phone` | `phone`, `phone_number`, `mobile` |
| `timezone` | `timezone`, `tz` |
| `locale` | `locale`, `language` |
| `location` | `home_city`, `current_location`, `location`, `city` |
| `pronouns` | `pronouns` |
| `linkedin_url` | `linkedin`, `linkedin_url` |
| `bio` | `bio`, `biography` |
| `birthday` | `birthday`, `birthdate`, `dob` |

**Safety:** Script is idempotent — a NULL check guards every write. Re-running
after a partial failure produces the same result. KG fact nodes are not deleted.

## TypeScript Types (`src/contacts/types.ts`)

### `Contact` interface additions

```typescript
// Canonical profile attributes (migration 048). All nullable — populated by
// backfill script or via updateContactFields(). Source of truth for specialists.
preferredName: string | null;
title: string | null;
organization: string | null;
primaryEmail: string | null;
primaryPhone: string | null;
timezone: string | null;
locale: string | null;
location: string | null;
pronouns: string | null;
linkedinUrl: string | null;
bio: string | null;
birthday: string | null;
```

### New `ContactCanonicalFields` type

```typescript
export interface ContactCanonicalFields {
  preferredName?: string | null;
  title?: string | null;
  organization?: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  timezone?: string | null;
  locale?: string | null;
  location?: string | null;
  pronouns?: string | null;
  linkedinUrl?: string | null;
  bio?: string | null;
  birthday?: string | null;
}
```

`CreateContactOptions` also gets these 12 as optional fields for CRM import paths.

## ContactService

### `createContact`

Spreads `ContactCanonicalFields` from `options` onto the `Contact` object, defaulting
each to `null`. Postgres backend INSERT includes all 12 new columns.

### `updateContactFields(contactId, fields)` (new public method)

```typescript
async updateContactFields(
  contactId: string,
  fields: ContactCanonicalFields,
): Promise<Contact>
```

1. Fetches the contact; throws if not found
2. If `fields.primaryEmail` is non-null, validates it exists in
   `contact_channel_identities` for this contact with `channel = 'email'`.
   Uses `backend.getIdentitiesForContact(contactId)` + in-memory filter
   (works for both Postgres and in-memory backends). Comparison is
   case-insensitive — both sides lowercased before comparing.
   Throws a descriptive error if not found (caller maps to 400).
3. Spreads `fields` onto the fetched contact, stamps `updatedAt`
4. Calls `updateStoredContact` (which sanitizes display name and calls backend)
5. Returns the updated contact

### Postgres backend changes

- `createContact`: INSERT adds all 12 columns
- `updateContact`: UPDATE SET adds all 12 columns
- All SELECT lists that return `Contact` (`getContact`, `listContacts`,
  `findContactByName/Role/SystemRole`): add the 12 columns.
  `resolveByChannelIdentity` is excluded — it returns `ResolvedSender`, not `Contact`,
  and doesn't need the canonical fields.
- `rowToContact`: maps the 12 new columns (all `string | null`, no parsing needed)

### In-memory backend

No changes. The backend stores and retrieves the full `Contact` object; the new fields
ride along automatically once the interface is extended.

## HTTP API (`src/channels/http/routes/kg.ts`)

### `GET /api/kg/contacts`

Serialization adds all 12 new fields to each contact in the response array.

### `POST /api/kg/contacts`

Body type widens to accept 12 optional fields. Validation before calling `createContact`:

| Field | Validation |
|---|---|
| `primaryEmail` | Regex `^[^@\s]+@[^@\s]+` + CCI existence check (same as service) |
| `linkedinUrl` | Must start with `https?://` if provided |
| `bio` | Max 500 chars if provided |
| `birthday` | Must match `YYYY-MM-DD` or `--MM-DD` if provided |
| All others | Accepted as-is (free-text strings); trimmed, empty string → null |

Response includes all 12 new fields.

### `PATCH /api/kg/contacts/:id`

Body type widens to accept 12 optional canonical fields. After existing field mutations
(`displayName`, `role`, `status`, `trustLevel`, `notes`, `kgNodeId`), calls
`contactService.updateContactFields(id, canonicalFields)` if any canonical fields are
present in the body. Same format validation as POST. Response includes all 12 fields.

### No new endpoints

The list endpoint carries the full payload. No `GET /api/kg/contacts/:id` detail
endpoint is added in this issue.

## Console UI (`apps/console/src/pages/ContactsPage.tsx`)

### `Contact` interface

All 12 new fields added as `string | null`.

### Table

`Role` column replaced with `Title` and `Organization`. Role remains editable in the
drawer. Sort works the same way (string comparison on the field value).

### Drawer form — 6 sections

| Section | Fields |
|---|---|
| **Identity** | `displayName` (existing), `preferredName`, `pronouns` |
| **Work** | `role` (existing, moved here), `title`, `organization` |
| **Contact info** | `primaryEmail`, `primaryPhone` |
| **Location & locale** | `timezone`, `locale`, `location` |
| **Links & bio** | `linkedinUrl`, `bio` (textarea), `birthday` |
| **System** | `status`, `trustLevel`, `kgNodeId`, `notes` (existing) |

Each section gets a small section header. All new inputs use `type="text"` except
`bio` (textarea). `birthday` placeholder: `YYYY-MM-DD or --MM-DD`. `primaryEmail`
placeholder: lowercased on save.

`handleSave` sends all 12 canonical fields in the POST/PATCH body (empty string → null).

## Tests

### `tests/unit/contacts/contact-service.test.ts` (extend)

- `createContact` with canonical fields → fetched contact has all 12 fields populated
- `updateContactFields` round-trip → field persists, `updatedAt` bumps
- `updateContactFields` with `primaryEmail` lacking a matching CCI row → throws
- `updateContactFields` with `primaryEmail` matching a CCI row → succeeds
- `updateContactFields` only touches provided fields → unprovided fields unchanged

### `tests/integration/contacts.test.ts` (extend)

- POST with canonical fields → 201, fields returned in response
- POST with invalid `primaryEmail` format → 400
- POST with `bio` over 500 chars → 400
- POST with invalid `linkedinUrl` → 400
- PATCH with canonical fields → 200, fields updated
- GET list → response includes `title`, `organization`, and all other new fields

### `scripts/backfill-contact-attributes.test.ts` (new, unit)

- Contact with linked KG node + fact nodes → correct columns populated
- Two competing facts for same column → highest confidence wins; `last_confirmed_at` tiebreak
- Already-populated column is skipped
- Contact with no `kg_node_id` is skipped
- `role` KG fact not applied to `title` when contact has a `system_role`

## Out of Scope (Issue #830)

- `EntityContextAssembler` changes
- Stopping fact-node creation from agents/skills
- Specialist agent prompt updates

## Acceptance Criteria

- [ ] Migration adds the 12 columns with CHECK constraints; rolls back cleanly
- [ ] Backfill script populates Contact columns from KG facts; re-run is idempotent
- [ ] `ContactService` CRUD covers all new fields with `primaryEmail` validation
- [ ] HTTP API exposes all new fields; rejects invalid input with 400 + field-level error
- [ ] Console table replaces `Role` with `Title` + `Organization`
- [ ] Console drawer shows all new fields in 6 grouped sections
- [ ] All existing tests pass; new tests cover validation and backfill
- [ ] Typecheck and lint clean
