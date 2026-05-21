# Design: contact-list status filter and result limit

**Issue:** [#644](https://github.com/josephfung/curia/issues/644)
**Date:** 2026-05-21

## Problem

The contacts agent times out when asked to list provisional contacts. With 156+
contacts and no status filter, the agent falls back to enumerating all contacts
via entity-context batched calls (~15 round trips with LLM reasoning), taking
3–5 minutes. The coordinator's 90-second delegate timeout fires first, producing
a misleading "system was unresponsive" message.

Even without the timeout, presenting 40+ provisional contacts in a chat message
is not actionable for a CEO.

## Solution

Add `status` and `limit` parameters to the `contact-list` skill. The contacts
agent can then resolve "list provisional contacts" in a single fast DB query:

```
contact-list({ status: "provisional", limit: 10 })
```

No entity-context enumeration, no timeout, no retry.

## Changes

### 1. Skill manifest (`skills/contact-list/skill.json`)

Add two optional inputs and update the description:

| Input    | Type      | Default | Validation                                    |
|----------|-----------|---------|-----------------------------------------------|
| `role`   | `string?` | null   | Existing — max 200 characters                 |
| `status` | `string?` | null   | Must be `confirmed`, `provisional`, or `blocked` |
| `limit`  | `number?` | null   | Must be a positive integer; null = no limit   |

Description changes from "List all contacts, optionally filtered by role" to
"List contacts, optionally filtered by role or status, with optional result limit."

### 2. ContactServiceBackend interface (`src/contacts/contact-service.ts`)

Update the `listContacts` signature on the interface:

```typescript
listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]>;
```

### 3. PostgresContactBackend

Build a dynamic query from the filters:

```sql
-- No filters (existing behavior)
SELECT ... FROM contacts ORDER BY created_at ASC

-- Status only
SELECT ... FROM contacts WHERE status = $1 ORDER BY created_at ASC

-- Status + limit
SELECT ... FROM contacts WHERE status = $1 ORDER BY created_at ASC LIMIT $2

-- Limit only
SELECT ... FROM contacts ORDER BY created_at ASC LIMIT $1
```

Sort order stays `ORDER BY created_at ASC` — no behavior change from the
current implementation.

The `idx_contacts_status` index already exists (migration 006), so no new
migration is needed.

### 4. InMemoryContactBackend

Apply the same filter and limit logic in memory: filter by status if provided,
sort by `createdAt` ascending (existing behavior), then slice to limit.

### 5. ContactService public API

Update the public `listContacts` method to pass through filters:

```typescript
async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
  return this.backend.listContacts(filters);
}
```

### 6. contact-list handler (`skills/contact-list/handler.ts`)

- Extract `status` and `limit` from `ctx.input`
- Validate `status` is one of the allowed values (if provided)
- Validate `limit` is a positive integer (if provided)
- When `role` is provided, use the existing `findContactByRole()` path (no
  change — role and status are independent filters; combining them is not
  needed for this use case)
- When `status` or `limit` is provided (without role), call
  `listContacts({ status, limit })`
- When neither role, status, nor limit is provided, call `listContacts()`
  (existing behavior)

### 7. Tests

- Status filter returns only matching contacts
- Limit caps results
- Status + limit combined
- No filters returns all contacts (existing behavior preserved)
- Invalid status value rejected
- Invalid limit value rejected (zero, negative, non-integer)
- Role filter still works independently (no regression)

## What this does NOT change

- **No agent prompt changes.** The contacts agent will naturally use the new
  parameters once they appear in the skill manifest.
- **No scheduled job changes in code.** The runtime-created scheduler job will
  be updated operationally to use `contact-list({ status: "provisional", limit: 10 })`.
- **No entity-context changes.** With a limit of 10, entity-context batch
  performance is acceptable (~70 queries, sub-second). Batch optimization is
  deferred until a real workload demands it.
- **No migration needed.** `idx_contacts_status` already exists.
- **No sort order change.** `ORDER BY created_at ASC` is preserved.

## Acceptance criteria (from issue #644)

- [ ] `contact-list` accepts optional `status` (`provisional`, `confirmed`, `blocked`) and filters at DB layer
- [ ] `contact-list` accepts optional `limit` (positive integer, null = no limit)
- [ ] The contacts agent uses `contact-list({ status: "provisional" })` rather than enumerating all contacts — verified by the scheduled job completing within 30 seconds
- [ ] The misleading "system was unresponsive" message no longer appears
