# Entity-Context Email Address Resolution — Design

**Issue:** [#461](https://github.com/josephfung/curia/issues/461)
**Date:** 2026-05-11

## Problem

`resolveKgNodeId()` in `src/entity-context/assembler.ts` only handles UUID inputs
(contact IDs and KG node IDs). When an email address is passed — which happens in
CC flows (coordinator) and CEO inbox triage (ceo-inbox agent) — PostgreSQL throws
error `22P02` (invalid text representation for UUID). The catch block logs a warning
and returns `undefined`, so no KG context is assembled for that entity.

Two code paths are affected:

1. **CC flow**: The dispatcher injects a `[OWNER CC —]` preamble containing raw
   primary recipient email addresses. The coordinator extracts these and passes them
   to entity-context — the email is the only identifier available.
2. **CEO-inbox triage**: The ceo-inbox agent prompt (line 145) instructs the LLM to
   "call entity-context on the sender's email address."

## Design

### Code change: `resolveKgNodeId()` in assembler.ts

Add email address detection before the existing UUID-based queries:

1. Check if `id` contains `@` with non-whitespace on both sides (simple email pattern).
2. If yes, query `contact_channel_identities JOIN contacts` to resolve:
   email → contact.id → contact.kg_node_id.
3. If the email resolves to a contact with a kg_node_id, return it.
4. If the email resolves to a contact without a kg_node_id, log debug and return
   undefined (matches existing contact-without-kg-node behavior).
5. If the email doesn't match any contact, return undefined (genuinely unknown).
6. Existing UUID queries become an `else` branch — unchanged for non-email inputs.

Resolution query:

```sql
SELECT c.id, c.kg_node_id
FROM contact_channel_identities cci
JOIN contacts c ON c.id = cci.contact_id
WHERE cci.channel = 'email' AND LOWER(cci.channel_identifier) = LOWER($1)
```

Case-insensitive match per RFC 5321. This eliminates the `22P02` error path for
email addresses since they never reach a UUID column.

The `22P02` catch block remains for other non-UUID strings (LLM hallucinations like
`'primary-user'`).

### Prompt clarification: ceo-inbox.yaml (curia-deploy)

Line 145 currently says:

> Call entity-context on the sender's email address.

Update to:

> Call entity-context with contactIds set to the sender's email address.

Guides the LLM toward the correct input parameter. The code fix handles resolution
regardless, but the prompt should be semantically accurate.

### Cache interaction

No changes. The cache keys are entity/contact UUIDs. Email lookups resolve to UUIDs
before caching applies. If the same email is passed twice within the TTL, the email
resolution query runs again (cheap SELECT), then hits the UUID-keyed cache for the
full assembly. Adding email-as-cache-key is not worth the invalidation complexity.

### Error handling

No new error paths. The email query is a simple SELECT JOIN. If it fails (DB error),
the existing catch block propagates it. No new catch blocks needed.

## Testing

- `resolveKgNodeId` with a registered email address → returns correct kg_node_id
- `resolveKgNodeId` with a registered email that has no kg_node_id → returns undefined
- `resolveKgNodeId` with an unregistered email → returns undefined
- Existing UUID paths still work unchanged (regression)
- `assembleMany` with mixed email + UUID inputs → resolves both correctly

## Acceptance Criteria (from issue)

- [x] When entity-context receives an email address, it resolves to a contact UUID
  via the identity index before calling UUID-based queries
- [x] No `non-UUID id passed to resolveKgNodeId` warning for registered contacts
- [x] KG context (facts, relationships, history) correctly assembled for primary
  recipient in CC flows
- [x] Unregistered addresses still degrade gracefully with the unresolved path

## Files Changed

| File | Change |
|------|--------|
| `src/entity-context/assembler.ts` | Add email detection + resolution in `resolveKgNodeId()` |
| `src/entity-context/assembler.test.ts` (new or existing) | Unit tests for email resolution |
| `curia-deploy: custom/agents/ceo-inbox.yaml` | Prompt clarification (line 145) |
| `CHANGELOG.md` | Entry under `## [Unreleased]` |
