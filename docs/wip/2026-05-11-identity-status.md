# Identity Status Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `status` field (`active`/`defunct`/`bounced`) to contact channel identities so agents can see validity and make informed decisions about which addresses to use.

**Architecture:** New DB column with CHECK constraint, new TypeScript type, new `setIdentityStatus` backend method, one new skill (`contact-set-identity-status`), and updates to two existing skills (`contact-lookup`, `context-for-email`) and the contacts agent prompt.

**Tech Stack:** PostgreSQL, TypeScript (ESM), Vitest, pino

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/db/migrations/036_add_identity_status.sql` | Schema migration |
| Modify | `src/contacts/types.ts` | Add `IdentityStatus` type, update `ChannelIdentity` and `LinkIdentityOptions` |
| Modify | `src/contacts/contact-service.ts` | Update backend interface, Postgres backend, in-memory backend, `linkIdentity()` |
| Modify | `tests/unit/contacts/contact-service.test.ts` | Tests for new `setIdentityStatus` method and `linkIdentity` status default |
| Modify | `skills/contact-lookup/handler.ts` | Surface `status` in identity output |
| Modify | `skills/context-for-email/handler.ts` | Prefer active identities, surface `identity_status` |
| Create | `skills/contact-set-identity-status/skill.json` | Skill manifest |
| Create | `skills/contact-set-identity-status/handler.ts` | Skill handler |
| Create | `skills/contact-set-identity-status/handler.test.ts` | Unit tests |
| Modify | `agents/contacts.yaml` | Pin new skill, add Identity Status section to system prompt |
| Modify | `CHANGELOG.md` | Unreleased entry |

---

## Task 1: Schema Migration

**Files:**
- Create: `src/db/migrations/036_add_identity_status.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 036_add_identity_status.sql
--
-- Add status column to contact_channel_identities.
-- Tracks whether an identity (email, phone) is usable: active, defunct, or bounced.
-- Orthogonal to the existing `verified` boolean (which tracks ownership confirmation).
-- See: https://github.com/josephfung/curia/issues/377

ALTER TABLE contact_channel_identities
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'defunct', 'bounced'));
```

- [ ] **Step 2: Verify migration numbering**

Run: `ls src/db/migrations/ | sort`

Expected: `036_add_identity_status.sql` appears with no duplicate `036_` prefix. The previous migration is `035_add_system_role.sql`.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/036_add_identity_status.sql
git commit -m "feat: add identity status column to contact_channel_identities (#377)"
```

---

## Task 2: TypeScript Types

**Files:**
- Modify: `src/contacts/types.ts`

- [ ] **Step 1: Add `IdentityStatus` type**

After the `IdentitySource` type (around line 46), add:

```typescript
// -- Identity status --
// active: address is believed to be valid and usable (default)
// defunct: address is known to be no longer in use (e.g. left the company)
// bounced: delivery to this address has failed
// Orthogonal to `verified` — an address can be verified-but-bounced.
export type IdentityStatus = 'active' | 'defunct' | 'bounced';
```

- [ ] **Step 2: Add `status` to `ChannelIdentity`**

In the `ChannelIdentity` interface, add `status: IdentityStatus;` after the `verified` / `verifiedAt` fields and before `source`:

```typescript
export interface ChannelIdentity {
  id: string;
  contactId: string;
  channel: string;
  channelIdentifier: string;
  label: string | null;
  verified: boolean;
  verifiedAt: Date | null;
  status: IdentityStatus;
  source: IdentitySource;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 3: Add optional `status` to `LinkIdentityOptions`**

In the `LinkIdentityOptions` interface, add after `verified?`:

```typescript
export interface LinkIdentityOptions {
  contactId: string;
  channel: string;
  channelIdentifier: string;
  label?: string;
  source: IdentitySource;
  verified?: boolean;
  status?: IdentityStatus;
}
```

- [ ] **Step 4: Run type check**

Run: `npx --prefix . tsc --noEmit 2>&1 | head -40`

Expected: Type errors in `contact-service.ts` (missing `status` field in identity construction and row mapping). These are expected — we fix them in Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/contacts/types.ts
git commit -m "feat: add IdentityStatus type and status field to ChannelIdentity (#377)"
```

---

## Task 3: Contact Service — Backend Interface & Implementation

**Files:**
- Modify: `src/contacts/contact-service.ts`

This task has several sub-steps. Each modifies a different section of the file.

### 3a: Backend interface

- [ ] **Step 1: Add `setIdentityStatus` to the backend interface**

In the `ContactServiceBackend` interface (around line 40), add after `unlinkIdentity`:

```typescript
  setIdentityStatus(identityId: string, status: import('./types.js').IdentityStatus): Promise<ChannelIdentity>;
```

### 3b: Postgres backend — rowToIdentity

- [ ] **Step 2: Update `rowToIdentity` to include `status`**

In the `PostgresContactBackend` class, find the `rowToIdentity` method (around line 1321). Update the row type parameter to include `status: string;` and add the mapping:

Update the row type parameter — add `status: string;` after `verified_at`:
```typescript
  private rowToIdentity(row: {
    id: string;
    contact_id: string;
    channel: string;
    channel_identifier: string;
    label: string | null;
    verified: boolean;
    verified_at: Date | null;
    status: string;
    source: string;
    created_at: Date;
    updated_at: Date;
  }): ChannelIdentity {
    return {
      id: row.id,
      contactId: row.contact_id,
      channel: row.channel,
      channelIdentifier: row.channel_identifier,
      label: row.label,
      verified: row.verified,
      verifiedAt: row.verified_at,
      status: row.status as IdentityStatus,
      source: row.source as IdentitySource,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
```

Add the `IdentityStatus` import — find the existing import from `'./types.js'` at the top of the file and add `IdentityStatus` to it.

### 3c: Postgres backend — createIdentity

- [ ] **Step 3: Update `createIdentity` INSERT to include `status`**

Find the `createIdentity` method in `PostgresContactBackend` (around line 1005). Update the INSERT to include `status` as the 11th column:

```typescript
    await this.pool.query(
      `INSERT INTO contact_channel_identities
         (id, contact_id, channel, channel_identifier, label, verified, verified_at, source, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        identity.id,
        identity.contactId,
        identity.channel,
        identity.channelIdentifier,
        identity.label,
        identity.verified,
        identity.verifiedAt,
        identity.source,
        identity.status,
        identity.createdAt,
        identity.updatedAt,
      ],
    );
```

### 3d: Postgres backend — getIdentitiesForContact

- [ ] **Step 4: Update `getIdentitiesForContact` SELECT to include `status`**

Find the `getIdentitiesForContact` method in `PostgresContactBackend` (around line 1032). Add `status` to the SELECT and the row type:

```typescript
  async getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]> {
    const result = await this.pool.query<{
      id: string;
      contact_id: string;
      channel: string;
      channel_identifier: string;
      label: string | null;
      verified: boolean;
      verified_at: Date | null;
      status: string;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, contact_id, channel, channel_identifier, label, verified, verified_at, status, source, created_at, updated_at
       FROM contact_channel_identities WHERE contact_id = $1 ORDER BY created_at ASC`,
      [contactId],
    );

    return result.rows.map((row) => this.rowToIdentity(row));
  }
```

### 3e: Postgres backend — setIdentityStatus (new method)

- [ ] **Step 5: Add `setIdentityStatus` to `PostgresContactBackend`**

Add this method after `unlinkIdentity` in the Postgres backend:

```typescript
  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    const result = await this.pool.query<{
      id: string;
      contact_id: string;
      channel: string;
      channel_identifier: string;
      label: string | null;
      verified: boolean;
      verified_at: Date | null;
      status: string;
      source: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `UPDATE contact_channel_identities
       SET status = $1, updated_at = now()
       WHERE id = $2
       RETURNING id, contact_id, channel, channel_identifier, label, verified, verified_at, status, source, created_at, updated_at`,
      [status, identityId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Identity not found: ${identityId}`);
    }
    return this.rowToIdentity(row);
  }
```

### 3f: In-memory backend — setIdentityStatus (new method)

- [ ] **Step 6: Add `setIdentityStatus` to `InMemoryContactBackend`**

Add this method after `unlinkIdentity` in the in-memory backend:

```typescript
  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    const identity = this.identities.get(identityId);
    if (!identity) {
      throw new Error(`Identity not found: ${identityId}`);
    }
    const updated: ChannelIdentity = {
      ...identity,
      status,
      updatedAt: new Date(),
    };
    this.identities.set(identityId, updated);
    return updated;
  }
```

Add `IdentityStatus` to the in-memory backend's import from `'./types.js'` if not already imported (it should be picked up from the `ChannelIdentity` re-export, but if `IdentityStatus` is needed directly, add it).

### 3g: linkIdentity — pass status

- [ ] **Step 7: Update `linkIdentity` to set `status` on the new identity**

Find the `linkIdentity` method in `ContactService` (around line 440). In the identity object construction (around line 465), add `status`:

```typescript
    const identity: ChannelIdentity = {
      id: randomUUID(),
      contactId: options.contactId,
      channel: options.channel,
      channelIdentifier: options.channelIdentifier,
      label: options.label ?? null,
      verified,
      verifiedAt: verified ? now : null,
      status: options.status ?? 'active',
      source: options.source,
      createdAt: now,
      updatedAt: now,
    };
```

### 3h: Public setIdentityStatus method

- [ ] **Step 8: Add public `setIdentityStatus` method to `ContactService`**

Add this public method after `getContactWithIdentities` (around line 524):

```typescript
  /** Update the status of a channel identity (active, defunct, bounced). */
  async setIdentityStatus(identityId: string, status: IdentityStatus): Promise<ChannelIdentity> {
    return this.backend.setIdentityStatus(identityId, status);
  }
```

Add `IdentityStatus` to the import from `'./types.js'` at the top of the file if not already there.

- [ ] **Step 9: Run type check**

Run: `npx --prefix . tsc --noEmit 2>&1 | head -20`

Expected: Clean compile (no errors), or errors only in test files or skill handlers (those are fixed in later tasks).

- [ ] **Step 10: Commit**

```bash
git add src/contacts/contact-service.ts
git commit -m "feat: add setIdentityStatus to contact service backends (#377)"
```

---

## Task 4: Contact Service Tests

**Files:**
- Modify: `tests/unit/contacts/contact-service.test.ts`

- [ ] **Step 1: Write test for `linkIdentity` default status**

Add a new test inside the existing `describe('linkIdentity')` block:

```typescript
    it('defaults status to active', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', source: 'test' });
      const identity = await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'jenna-status@acme.com',
        source: 'ceo_stated',
      });
      expect(identity.status).toBe('active');
    });
```

- [ ] **Step 2: Write test for `linkIdentity` with explicit status**

```typescript
    it('respects explicit status', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', source: 'test' });
      const identity = await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'jenna-bounced@acme.com',
        source: 'ceo_stated',
        status: 'bounced',
      });
      expect(identity.status).toBe('bounced');
    });
```

- [ ] **Step 3: Write tests for `setIdentityStatus`**

Add a new `describe('setIdentityStatus')` block after the `linkIdentity` block:

```typescript
  describe('setIdentityStatus', () => {
    it('updates an identity status from active to defunct', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', source: 'test' });
      const identity = await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'jenna-set@acme.com',
        source: 'ceo_stated',
      });
      expect(identity.status).toBe('active');

      const updated = await service.setIdentityStatus(identity.id, 'defunct');
      expect(updated.status).toBe('defunct');
      expect(updated.id).toBe(identity.id);
    });

    it('updates an identity status to bounced', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', source: 'test' });
      const identity = await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'jenna-bounce@acme.com',
        source: 'ceo_stated',
      });

      const updated = await service.setIdentityStatus(identity.id, 'bounced');
      expect(updated.status).toBe('bounced');
    });

    it('throws for non-existent identity', async () => {
      await expect(
        service.setIdentityStatus('00000000-0000-0000-0000-000000000000', 'defunct'),
      ).rejects.toThrow(/not found/i);
    });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix . vitest run tests/unit/contacts/contact-service.test.ts 2>&1 | tail -30`

Expected: All tests pass, including the new ones.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/contacts/contact-service.test.ts
git commit -m "test: add setIdentityStatus and linkIdentity status tests (#377)"
```

---

## Task 5: Update contact-lookup Skill

**Files:**
- Modify: `skills/contact-lookup/handler.ts`

- [ ] **Step 1: Add `status` to the identity map in `enrichContact()`**

Find the `enrichContact` function (around line 124). In the `identities.map()` call (around line 134), add `status`:

Change:
```typescript
      return {
        ...summary,
        identities: data.identities.map(i => ({
          id: i.id,
          channel: i.channel,
          identifier: i.channelIdentifier,
          label: i.label,
          verified: i.verified,
        })),
      };
```

To:
```typescript
      return {
        ...summary,
        identities: data.identities.map(i => ({
          id: i.id,
          channel: i.channel,
          identifier: i.channelIdentifier,
          label: i.label,
          verified: i.verified,
          status: i.status,
        })),
      };
```

- [ ] **Step 2: Run type check**

Run: `npx --prefix . tsc --noEmit 2>&1 | head -10`

Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add skills/contact-lookup/handler.ts
git commit -m "feat: surface identity status in contact-lookup output (#377)"
```

---

## Task 6: Update context-for-email Skill

**Files:**
- Modify: `skills/context-for-email/handler.ts`

- [ ] **Step 1: Update `lookupRecipient` to prefer active identities and surface status**

Find the `lookupRecipient` method (around line 152). Replace the email identity selection logic (around line 166-170):

Change:
```typescript
        const emailIdentity = withIdentities.identities.find(
          (id) => id.channel === 'email',
        );
        if (emailIdentity) email = emailIdentity.channelIdentifier;
```

To:
```typescript
        // Prefer active identities over defunct/bounced ones
        const emailIdentity = withIdentities.identities
          .filter((id) => id.channel === 'email')
          .sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (a.status !== 'active' && b.status === 'active') return 1;
            return 0;
          })[0];
        if (emailIdentity) {
          email = emailIdentity.channelIdentifier;
          identityStatus = emailIdentity.status;
        }
```

Also add a `let identityStatus: string | undefined;` declaration alongside the existing `let email: string | undefined;` (around line 165).

- [ ] **Step 2: Include `identity_status` in the return value**

In the same method, update the return statement (around line 175):

Change:
```typescript
      return {
        displayName: contact.displayName,
        role: contact.role ?? undefined,
        email,
      };
```

To:
```typescript
      return {
        displayName: contact.displayName,
        role: contact.role ?? undefined,
        email,
        identityStatus,
      };
```

- [ ] **Step 3: Update the recipient assembly in `execute()` to pass through identity_status**

Find where `recipientResult` is assembled into the `recipient` object (around line 117-123). Add after the email line:

```typescript
      if (recipientResult.identityStatus) recipient.identity_status = recipientResult.identityStatus;
```

- [ ] **Step 4: Run type check**

Run: `npx --prefix . tsc --noEmit 2>&1 | head -10`

Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
git add skills/context-for-email/handler.ts
git commit -m "feat: prefer active identities and surface identity_status in context-for-email (#377)"
```

---

## Task 7: New Skill — contact-set-identity-status

**Files:**
- Create: `skills/contact-set-identity-status/skill.json`
- Create: `skills/contact-set-identity-status/handler.ts`
- Create: `skills/contact-set-identity-status/handler.test.ts`

### 7a: Skill manifest

- [ ] **Step 1: Create the skill manifest**

Create `skills/contact-set-identity-status/skill.json`:

```json
{
  "name": "contact-set-identity-status",
  "description": "Set the status of a contact's channel identity (email or phone). status must be 'active', 'defunct', or 'bounced'. identity_id must be a UUID from contact-lookup. Use when the CEO reports an address is no longer valid, or to mark a bounced address.",
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

### 7b: Skill handler

- [ ] **Step 2: Create the skill handler**

Create `skills/contact-set-identity-status/handler.ts`:

```typescript
// handler.ts — contact-set-identity-status skill implementation.
//
// Sets the status of a contact's channel identity (email, phone, etc.).
// Status is orthogonal to the verified flag — an address can be
// verified-but-bounced or unverified-but-active.
//
// See: https://github.com/josephfung/curia/issues/377

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { IdentityStatus } from '../../src/contacts/types.js';

const VALID_STATUSES = new Set<string>(['active', 'defunct', 'bounced']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContactSetIdentityStatusHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { identity_id, status } = ctx.input as {
      identity_id?: string;
      status?: string;
    };

    // -- Input validation --

    if (!identity_id || typeof identity_id !== 'string') {
      return { success: false, error: 'Missing required input: identity_id (string)' };
    }
    if (!UUID_RE.test(identity_id)) {
      return {
        success: false,
        error: "identity_id must be a valid UUID. Use contact-lookup to obtain identity UUIDs.",
      };
    }

    if (!status || typeof status !== 'string') {
      return { success: false, error: 'Missing required input: status (string)' };
    }
    if (!VALID_STATUSES.has(status)) {
      return {
        success: false,
        error: `status must be 'active', 'defunct', or 'bounced'. Got: '${status}'`,
      };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-set-identity-status: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ identity_id, status }, 'Setting identity status');

    try {
      const updated = await ctx.contactService.setIdentityStatus(
        identity_id,
        status as IdentityStatus,
      );

      ctx.log.info(
        { identityId: updated.id, contactId: updated.contactId, status: updated.status },
        'Identity status updated',
      );

      return {
        success: true,
        data: {
          identity_id: updated.id,
          channel: updated.channel,
          identifier: updated.channelIdentifier,
          status: updated.status,
          contact_id: updated.contactId,
        },
      };
    } catch (err) {
      // setIdentityStatus throws when the identity is not found
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        return {
          success: false,
          error: `No identity exists with id ${identity_id}. Use contact-lookup to verify the UUID.`,
        };
      }
      ctx.log.error({ err, identity_id }, 'Failed to set identity status');
      return { success: false, error: 'Failed to set identity status. See logs for details.' };
    }
  }
}
```

### 7c: Skill tests

- [ ] **Step 3: Write the skill handler tests**

Create `skills/contact-set-identity-status/handler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactSetIdentityStatusHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { ChannelIdentity } from '../../src/contacts/types.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

function makeIdentity(overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  return {
    id: VALID_UUID,
    contactId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    channel: 'email',
    channelIdentifier: 'jenna@acme.com',
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: 'ceo_stated',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  contactService?: Partial<ContactService>;
}): SkillContext {
  const contactService = {
    setIdentityStatus: vi.fn().mockResolvedValue(makeIdentity({ status: 'defunct' })),
    ...overrides.contactService,
  } as unknown as ContactService;

  return {
    input: overrides.input ?? {},
    secret: () => '',
    log: makeLogger(),
    contactService,
  } as unknown as SkillContext;
}

describe('ContactSetIdentityStatusHandler', () => {
  let handler: ContactSetIdentityStatusHandler;

  beforeEach(() => {
    handler = new ContactSetIdentityStatusHandler();
  });

  it('returns error when identity_id is missing', async () => {
    const ctx = makeCtx({ input: { status: 'defunct' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/identity_id/);
  });

  it('returns error when identity_id is not a valid UUID', async () => {
    const ctx = makeCtx({ input: { identity_id: 'not-a-uuid', status: 'defunct' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/UUID/);
  });

  it('returns error when status is missing', async () => {
    const ctx = makeCtx({ input: { identity_id: VALID_UUID } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/status/);
  });

  it('returns error when status is invalid', async () => {
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'invalid' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/active.*defunct.*bounced/);
  });

  it('returns error when contactService is not available', async () => {
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'defunct' } });
    (ctx as Record<string, unknown>).contactService = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/contactService/);
  });

  it('returns error when identity is not found', async () => {
    const contactService = {
      setIdentityStatus: vi.fn().mockRejectedValue(new Error('Identity not found: ' + VALID_UUID)),
    };
    const ctx = makeCtx({ input: { identity_id: VALID_UUID, status: 'defunct' }, contactService });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/No identity exists/);
  });

  it('successfully updates identity status', async () => {
    const updatedIdentity = makeIdentity({ status: 'defunct' });
    const contactService = {
      setIdentityStatus: vi.fn().mockResolvedValue(updatedIdentity),
    };
    const ctx = makeCtx({
      input: { identity_id: VALID_UUID, status: 'defunct' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.identity_id).toBe(VALID_UUID);
      expect(data.status).toBe('defunct');
      expect(data.channel).toBe('email');
      expect(data.identifier).toBe('jenna@acme.com');
      expect(data.contact_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    }
    expect(contactService.setIdentityStatus).toHaveBeenCalledWith(VALID_UUID, 'defunct');
  });

  it('successfully updates to bounced', async () => {
    const updatedIdentity = makeIdentity({ status: 'bounced' });
    const contactService = {
      setIdentityStatus: vi.fn().mockResolvedValue(updatedIdentity),
    };
    const ctx = makeCtx({
      input: { identity_id: VALID_UUID, status: 'bounced' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).status).toBe('bounced');
    }
  });

  it('successfully updates back to active', async () => {
    const updatedIdentity = makeIdentity({ status: 'active' });
    const contactService = {
      setIdentityStatus: vi.fn().mockResolvedValue(updatedIdentity),
    };
    const ctx = makeCtx({
      input: { identity_id: VALID_UUID, status: 'active' },
      contactService,
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).status).toBe('active');
    }
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix . vitest run skills/contact-set-identity-status/handler.test.ts 2>&1 | tail -20`

Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add skills/contact-set-identity-status/
git commit -m "feat: add contact-set-identity-status skill (#377)"
```

---

## Task 8: Contacts Agent — Pin Skill & Prompt Update

**Files:**
- Modify: `agents/contacts.yaml`

- [ ] **Step 1: Add the new skill to `pinned_skills`**

Find the `pinned_skills` list. Add `contact-set-identity-status` under the "Identity & CRUD" group, after `contact-unlink-identity`:

```yaml
pinned_skills:
  # Identity & CRUD
  - contact-create
  - contact-lookup
  - contact-link-identity
  - contact-unlink-identity
  - contact-set-identity-status
  - contact-set-role
  - contact-set-trust
  - contact-rename
  - contact-list
```

- [ ] **Step 2: Add Identity Status section to the system prompt**

Find the "Contact Lookup Best Practices" section (ends around "The lookup returns channel identities..."). Add the following new section immediately after it, before "## Contact Deduplication":

```yaml
  ## Identity Status
  Contact identities (email, phone) have a status field distinct from the
  contact-level status (confirmed/provisional/blocked):
  - **active** — address is believed to be valid and usable (default)
  - **defunct** — address is known to be no longer in use (e.g. left the company)
  - **bounced** — delivery to this address has failed

  When preparing a briefing:
  - Call out any non-active identities alongside the contact's details
    (e.g. "Note: sarah@oldco.com is marked as defunct")

  When the coordinator asks to send to or suggests using a defunct or bounced
  identity:
  - Warn the coordinator that the identity is not active rather than surfacing
    it as a usable address
  - Suggest active alternatives if the contact has other identities on file

  Use contact-set-identity-status to update an identity's status when the
  coordinator relays that an address is defunct, bounced, or back in service.
```

- [ ] **Step 3: Commit**

```bash
git add agents/contacts.yaml
git commit -m "feat: pin contact-set-identity-status and add Identity Status guidance to contacts agent (#377)"
```

---

## Task 9: Changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entries under `## [Unreleased]`**

Add under the `### Added` section (create it if absent):

```markdown
### Added

- **Identity status** — contact channel identities now carry a `status` field (`active`/`defunct`/`bounced`), orthogonal to `verified`. contact-lookup surfaces status alongside each identity. context-for-email prefers active identities and includes `identity_status` in the recipient context. New `contact-set-identity-status` skill (pinned to contacts agent) for manual updates. Contacts specialist warns the coordinator when non-active identities are about to be suggested. (#377)
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add identity status changelog entry (#377)"
```

---

## Task 10: Full Test Suite & Type Check

- [ ] **Step 1: Run full type check**

Run: `npx --prefix . tsc --noEmit 2>&1 | tail -20`

Expected: Clean compile.

- [ ] **Step 2: Run full test suite**

Run: `npx --prefix . vitest run 2>&1 | tail -40`

Expected: All tests pass. No regressions.

- [ ] **Step 3: Fix any failures and commit**

If any tests fail, diagnose and fix. Commit each fix separately.
