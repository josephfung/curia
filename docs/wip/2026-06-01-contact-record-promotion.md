# Promote canonical contact attributes onto the Contact record

**Tracked by:** #829 (foundation), #830 (integration). Milestone: v0.33.

## Context

Today, the `contacts` table is intentionally thin (`displayName`, `role`, `status`, trust/confidence fields, message counts, notes). Everything else the system "knows" about a person (email, phone, title, organization, timezone, location) lives as `kg_nodes` of `type='fact'` linked to the contact's KG person node via `relates_to` edges. Specialist agents enrich via `EntityContextAssembler` ([src/entity-context/assembler.ts](../../src/entity-context/assembler.ts)), which surfaces facts with `confidence` and `last_confirmed_at` metadata for the LLM to weigh.

This indirection is causing two real problems:

1. **Hallucinations.** Spec [docs/specs/11-entity-context-enrichment.md](../specs/11-entity-context-enrichment.md) (line 8) acknowledges agents fabricate values (e.g., calendar IDs) when the structured context is thin. Even when the KG holds the truth, presenting it as a confidence-scored fact list invites the LLM to "reason" instead of read.
2. **Specialist friction.** Skills like calendar, email composition, and research-analyst all need the same handful of canonical attributes. Each ends up parsing fact bullets or guessing. The data is theoretically present but operationally fragile.

The fix is to treat identity-defining attributes as structured first-class columns on the `contacts` record. Relationships, historical facts, and preferences stay in the KG (that's what it's good at). Canonical "who is this person right now" attributes get promoted.

Design choices: **Essentials + relational hints** field set, **backfill from KG once then deprecate** fact-node writes for these attributes, split into foundation + integration issues.

## Recommended fields

Added as nullable columns on the `contacts` table:

| Column | Type | Notes |
|---|---|---|
| `preferred_name` | TEXT | Short/familiar form ("Jen" for Jennifer). Falls back to `display_name`. |
| `title` | TEXT | Current job title. Free-text. |
| `organization` | TEXT | Current employer name. Free-text now; later may FK to KG org node. |
| `primary_email` | TEXT | Display/composition address. Lower-cased. Must match one of the contact's `contact_channel_identities` rows where channel='email' (FK or trigger-validated). |
| `primary_phone` | TEXT | E.164-formatted phone for messaging/calls. |
| `timezone` | TEXT | IANA tz (`America/New_York`). Critical for scheduling skills. |
| `locale` | TEXT | BCP 47 (`en-US`). For outbound language. |
| `location` | TEXT | City/region, free-text (`Toronto, ON`). |
| `pronouns` | TEXT | Free-text. |
| `linkedin_url` | TEXT | Validated as URL on write. |
| `bio` | TEXT | Short narrative summary. Free-text, length-capped (~500 chars). |
| `birthday` | TEXT | ISO `YYYY-MM-DD` or `--MM-DD` (year-omitted). Stored as TEXT for that flexibility. |

CHECK constraints on `primary_email` format, `linkedin_url` format, `bio` length. `timezone` against IANA without validation initially (revisit if needed).

**What stays in the KG:**
- Relationships (`works_at`, `reports_to`, `attends`) as edges
- Historical facts ("used to work at X", "moved from NYC in 2024")
- Preferences (dietary, scheduling, communication style) could later get their own table, but not in this work
- Anything multi-valued at the same point in time (primary lives on Contact; others remain channel identities or KG)

## Issue A (#829) — Foundation: schema, service, API, console

### Goal
Persist canonical attributes on the Contact record. Backfill from KG once. Stop writing these attributes as KG fact nodes going forward.

### Files to modify

**Migration (new):**
- `src/db/migrations/0NN_add_contact_canonical_attributes.sql` — `ALTER TABLE contacts ADD COLUMN` for each field listed above, plus CHECK constraints
- `src/db/migrations/0NN+1_backfill_contact_attributes_from_kg.sql` — one-shot data migration: for each contact with a `kg_node_id`, read linked `type='fact'` nodes whose `label` matches a known attribute key (case-insensitive: `email`, `phone`, `title`, `organization`/`employer`/`company`, `timezone`/`tz`, `pronouns`, `linkedin`, `location`/`city`, `birthday`/`birthdate`, `bio`) and write into the corresponding column when the column is NULL. Leave the KG fact nodes in place for audit (do not delete).

**Backend types & service:**
- [src/contacts/types.ts](../../src/contacts/types.ts) — extend the `Contact` interface with the new fields (all nullable)
- [src/contacts/contact-service.ts](../../src/contacts/contact-service.ts) — update `createContact`, `updateContact`, row-mapping, and any insert/select SQL to include the new columns
- Validation helpers (new file `src/contacts/contact-validation.ts` or inline): email format, E.164 phone, URL, IANA tz allowlist check, bio length cap

**HTTP API:**
- [src/channels/http/routes/kg.ts](../../src/channels/http/routes/kg.ts) (GET/POST/PATCH `/api/kg/contacts`) — add new fields to the request schemas and response payloads. Return validation errors with field-level detail.

**Console UI:**
- [apps/console/src/pages/ContactsPage.tsx](../../apps/console/src/pages/ContactsPage.tsx) — extend the edit drawer with form inputs for each new field, grouped into sections (Identity / Contact info / Location & locale / Links). Replace `Role` column in the list with `Title` and `Organization`.

**Tests:**
- Service-level: round-trip create then fetch then update for each new field; validation rejections
- HTTP-level: API contract tests for create/patch with the new fields
- Migration test: verify backfill picks up matching KG facts and skips when Contact column already has a value

### Out of scope for Issue A
- Entity-context assembler changes (Issue B)
- Stopping fact-node creation from agents/skills (Issue B)
- Specialist agent prompt updates (Issue B)

### Acceptance criteria
- [ ] Migration adds the columns with constraints; rolls back cleanly
- [ ] Backfill populates non-null Contact columns from KG facts on a snapshot of prod-like data; no data loss
- [ ] ContactService CRUD covers all new fields with validation
- [ ] HTTP API exposes new fields; rejects invalid input with 400 + field-level error
- [ ] Console drawer can view and edit every new field
- [ ] Console list view replaces the `Role` column with `Title` and `Organization` columns (Role still editable in the drawer; just not surfaced in the table)
- [ ] All existing tests still pass; new tests cover validation and backfill
- [ ] Typecheck and lint clean

---

## Issue B (#830) — Integration: enrichment, agent reliance, stop KG fact writes

### Goal
Make `EntityContextAssembler` surface these attributes as structured Contact properties (not bulleted facts). Update specialist agents to read from Contact. Stop writing canonical attributes as new KG fact nodes.

### Files to modify

**Entity context:**
- [src/entity-context/types.ts](../../src/entity-context/types.ts) — extend `EntityContext.contact` to include the new fields
- [src/entity-context/assembler.ts](../../src/entity-context/assembler.ts) — populate the new fields from the Contact row; filter out KG facts whose `label` matches a canonical attribute (so they don't show up duplicated in the fact list). Keep facts for non-canonical labels.

**Skill consumers:**
- [skills/entity-context/handler.ts](../../skills/entity-context/handler.ts) — confirm the new fields propagate through the skill response shape
- Audit calendar skills (`skills/calendar-list-events/`, `skills/calendar-create-event/`) — prefer `contact.timezone` from the structured field over fact bullets in prompts/formatters
- Email composition skills — use `contact.primaryEmail` and `contact.preferredName` directly

**Memory-store skill / write paths:**
- [skills/memory-store/handler.ts](../../skills/memory-store/handler.ts) (or wherever fact nodes are written) — add a deny-list of canonical labels. When an agent tries to write a fact with one of these labels for a contact, redirect to `ContactService.updateContact` instead of creating a KG fact node. Audit-log the redirect.

**Agent prompts:**
- [agents/research-analyst.yaml](../../agents/research-analyst.yaml) and other agent configs — document that canonical attributes live on the Contact record. Update prompts to call `update-contact` (or equivalent skill) for these fields rather than `memory-store`.
- Coordinator prompt — same guidance.

**Tests:**
- Assembler test: structured Contact fields populate; KG facts with canonical labels don't double-up in the fact list
- Memory-store integration: writing a "title" fact about a contact redirects to ContactService and updates the Contact row
- End-to-end smoke test: an agent learning a new title from an email signature updates Contact, not KG

### Acceptance criteria
- [ ] `EntityContext` payload exposes the new fields as structured properties
- [ ] Canonical labels are filtered out of the facts list (no duplication)
- [ ] `memory-store` (and any other fact-write path) refuses canonical-label writes and routes them to ContactService
- [ ] At least two specialist skills (calendar + email composition) demonstrably read from the new Contact fields in their prompts
- [ ] Agent configs updated with guidance for writing canonical attributes
- [ ] Smoke tests pass; no regressions
- [ ] Typecheck, lint, all tests green

---

## Reused patterns / utilities

- **ContactService backend-interface pattern** — extend, don't replace ([src/contacts/contact-service.ts](../../src/contacts/contact-service.ts))
- **HTTP route validation** — follow existing zod/fastify schema patterns in [src/channels/http/routes/kg.ts](../../src/channels/http/routes/kg.ts)
- **Migration numbering** — sequential under [src/db/migrations/](../../src/db/migrations/), pick the next two free integers
- **Entity context cache invalidation** — the assembler already has TTL + invalidation on contact mutations; the new fields ride that for free
- **Console form patterns** — reuse the existing edit drawer in [ContactsPage.tsx](../../apps/console/src/pages/ContactsPage.tsx) (trust-level dropdown, notes textarea) for the new inputs

## Verification plan

**Issue A:**
1. Run migrations forward and back on a local DB; verify schema and constraints
2. Run backfill against a seeded DB with KG facts; spot-check 5+ contacts
3. CRUD via console: create a contact with all fields, edit each, confirm persistence
4. CRUD via HTTP: same flow with curl/Bruno, including invalid inputs (bad email, bad tz, oversized bio)
5. `npm test` clean

**Issue B:**
1. Trigger the entity-context skill for a contact with structured fields and KG facts; verify response separates them correctly
2. Run a smoke test where the agent learns a new title from an email signature; assert the Contact row updated, not the KG
3. Manually trigger calendar-list-events and confirm timezone comes from `contact.timezone`
4. Run the full smoke-test suite (`npm run smoke`) and confirm no judge-flagged hallucinations of contact details
5. `npm test` clean
