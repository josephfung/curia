# Identity Status Field — Design Spec

**Issue:** [#377](https://github.com/josephfung/curia/issues/377)
**Date:** 2026-05-11
**Status:** Draft

## Problem

Contact identities (email addresses, phone numbers) have no concept of validity
status. All stored addresses are treated as equally valid by contact-lookup and
context-for-email. The coordinator can suggest defunct, bounced, or otherwise
unusable addresses without any signal that they shouldn't be used.

## Decision: Approach A — Column + Agent Visibility (No Gateway Filtering)

Add the `status` column and surface it in skill outputs so agents can see the
status and make informed decisions. No automatic filtering or blocking in the
outbound gateway. The contacts specialist prompt teaches the agent to warn on
non-active identities.

**Why not gateway filtering?** Auto-bounce detection is out of scope (separate
issue), so the only status data comes from manual updates. Hard-blocking sends
based on manual-only data risks false positives with no recovery path. Gateway
filtering is a natural follow-up once bounce webhooks provide high-confidence
signals.

## Design

### Status Enum

```
status: 'active' | 'defunct' | 'bounced'
```

- **active** — address is believed to be valid and usable (default for all
  existing and new identities)
- **defunct** — address is known to be no longer in use (e.g. person left the
  company, address was decommissioned)
- **bounced** — delivery to this address has failed

### Relationship to `verified`

Orthogonal. `verified` answers "have we confirmed this address belongs to this
contact?" while `status` answers "should we use this address?" An address can be
verified-but-bounced, or unverified-but-active. No changes to the `verified`
field or `verified_at` timestamp.

### 1. Schema Migration — `036_add_identity_status.sql`

```sql
ALTER TABLE contact_channel_identities
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'defunct', 'bounced'));
```

- Default `'active'` backfills all existing rows with zero data loss
- `CHECK` constraint enforces the enum at the DB level
- No index on `status` — queries don't filter by status; agents read it inline

### 2. TypeScript Types — `src/contacts/types.ts`

New type:
```typescript
export type IdentityStatus = 'active' | 'defunct' | 'bounced';
```

Updated `ChannelIdentity` interface — add:
```typescript
status: IdentityStatus;
```

Updated `LinkIdentityOptions` — add optional field:
```typescript
status?: IdentityStatus;  // defaults to 'active'
```

### 3. Contact Service — `src/contacts/contact-service.ts`

#### New backend interface method
```typescript
setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity>;
```

#### Postgres backend changes
- `createIdentity()` — add `status` to the INSERT column list (11th column)
- `getIdentitiesForContact()` — add `status` to the SELECT column list
- `rowToIdentity()` — map `row.status` to `ChannelIdentity.status`
- New method `setIdentityStatus()`:
  ```sql
  UPDATE contact_channel_identities
  SET status = $1, updated_at = now()
  WHERE id = $2
  RETURNING *
  ```
  Throws if no row matches (identity not found).

#### In-memory backend changes
- Already stores full `ChannelIdentity` objects — picks up `status` automatically
  from the interface change
- New method `setIdentityStatus()` — find identity by ID in the map, update
  `status` and `updatedAt`, return the updated object

#### `linkIdentity()` business logic
- Pass `options.status ?? 'active'` when constructing the `ChannelIdentity`
  object before calling `backend.createIdentity()`

### 4. contact-lookup Skill

`enrichContact()` in `skills/contact-lookup/handler.ts` currently maps
identities to `{ id, channel, identifier, label, verified }`.

Add `status` to the output:
```typescript
identities: data.identities.map(i => ({
  id: i.id,
  channel: i.channel,
  identifier: i.channelIdentifier,
  label: i.label,
  verified: i.verified,
  status: i.status,
})),
```

### 5. context-for-email Skill

`lookupRecipient()` in `skills/context-for-email/handler.ts` picks the first
email identity. Update to prefer `active` identities:

```typescript
const emailIdentity = withIdentities.identities
  .filter(id => id.channel === 'email')
  .sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return 0;
  })[0];
```

Add `identity_status` to the returned recipient object so the LLM sees the
status of the email address being suggested.

### 6. New Skill: `contact-set-identity-status`

#### Manifest (`skills/contact-set-identity-status/skill.json`)
```json
{
  "name": "contact-set-identity-status",
  "description": "Set the status of a contact's channel identity (email or phone). status must be 'active', 'defunct', or 'bounced'. identity_id must be a UUID from contact-lookup.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "identity_id": "string (UUID from contact-lookup identities list)",
    "status": "string (one of 'active', 'defunct', 'bounced')"
  },
  "outputs": {
    "identity_id": "string",
    "channel": "string",
    "identifier": "string",
    "status": "string",
    "contact_id": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "capabilities": []
}
```

#### Handler (`skills/contact-set-identity-status/handler.ts`)

Follows the `contact-set-trust` pattern:
1. Validate `identity_id` is a UUID
2. Validate `status` is one of the three allowed values
3. Check `ctx.contactService` is available
4. Call `ctx.contactService.setIdentityStatus(identity_id, status)`
5. Return the updated identity fields

#### Agent pinning

Add `contact-set-identity-status` to `pinned_skills` in `agents/contacts.yaml`
under the "Identity & CRUD" group.

### 7. Contacts Agent System Prompt Update

Add a new section to `agents/contacts.yaml` system prompt after "Contact Lookup
Best Practices":

```
## Identity Status
Contact identities (email, phone) have a status field: active, defunct, or bounced.
This is distinct from the contact-level status (confirmed/provisional/blocked).

- active: address is believed to be valid and usable (default)
- defunct: address is known to be no longer in use (e.g. left the company)
- bounced: delivery to this address failed

When preparing a briefing:
- Call out any non-active identities alongside the contact's details
  (e.g. "Note: sarah@oldco.com is marked as defunct")

When the coordinator asks to send to or suggests using a defunct or bounced identity:
- Warn the coordinator that the identity is not active rather than surfacing it
  as a usable address
- Suggest active alternatives if the contact has other identities on file

Use contact-set-identity-status to update an identity's status when instructed.
```

### 8. Testing

#### Unit tests
- `skills/contact-set-identity-status/handler.test.ts` — input validation
  (missing identity_id, invalid UUID, invalid status enum), success path with
  mock contactService, not-found error
- Update `skills/contact-lookup/handler.test.ts` — verify `status` appears in
  enriched identity output
- Update `skills/context-for-email/handler.test.ts` — verify active-preference
  sorting and `identity_status` in output

#### Integration tests
- `tests/integration/contacts.test.ts` — verify `setIdentityStatus()` persists
  and the CHECK constraint rejects invalid values

### 9. What's NOT Changing

- **Outbound gateway** — no filtering or blocking on identity status
- **`verified` field** — orthogonal, untouched
- **`resolveByChannelIdentity` return type** — returns contact-level data;
  identity status is surfaced through `getContactWithIdentities`
- **Bus events** — no new event types

### 10. Out of Scope

- Automatic bounce detection via Nylas webhooks (separate issue)
- UI for managing identity status
- Gateway hard-blocking on defunct/bounced (future, after auto-bounce detection)

## Acceptance Criteria (from issue)

- [ ] Contact identities have a `status` field with valid enum values
- [ ] contact-lookup returns status alongside each identity
- [ ] context-for-email surfaces identity status
- [ ] Existing identities default to `active` with no data loss
- [ ] `contact-set-identity-status` skill exists, is pinned to the contacts
      agent, and correctly persists status changes to the DB
- [ ] The contacts specialist warns the coordinator when a non-`active` identity
      is about to be suggested or used
