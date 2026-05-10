# Principal Identity & Task Originator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate fragmented CEO identity into a database-driven `system_role` column, replace `ceoInitiated` with `TaskOriginator`, and move OutboundGateway to DB lookups.

**Architecture:** A new `system_role` column on `contacts` separates system designation (`'principal'`/`'agent'`) from the free-text `role` field. The dispatcher stamps a `TaskOriginator` on every task (replacing the `ceoInitiated` boolean). All layers query the DB contact — the OutboundGateway stops reading flat config fields. A startup readiness check gates the system on principal contact existence.

**Tech Stack:** TypeScript (ESM), PostgreSQL 16+, Vitest, node-pg-migrate

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/db/migrations/035_add_system_role.sql` | Add `system_role` column, unique indexes, backfill |
| Create | `src/contacts/principal.ts` | Helper functions: `isPrincipalOriginated`, `isAgentOriginated`, `getPrincipalContact`, `loadPrincipalIdentities` |
| Create | `src/startup/readiness.ts` | `ReadinessCheck` interface and `runReadinessChecks()` runner |
| Create | `tests/unit/contacts/principal.test.ts` | Unit tests for principal helpers |
| Create | `tests/unit/startup/readiness.test.ts` | Unit tests for readiness checks |
| Modify | `src/contacts/types.ts` | Add `systemRole` to `Contact` interface, add `SystemRole` type, add `TaskOriginator` interface |
| Modify | `src/contacts/contact-service.ts` | Add `system_role` to all SELECT/INSERT/UPDATE queries, `rowToContact`, `findContactBySystemRole()` |
| Modify | `src/contacts/ceo-bootstrap.ts` | Set `system_role = 'principal'` in INSERT and UPDATE |
| Modify | `src/entity-context/bootstrap.ts` | Set `system_role = 'agent'` in INSERT and ON CONFLICT UPDATE |
| Modify | `src/dispatch/dispatcher.ts` | Replace `ceoMeta`/`ceoInitiated` with `TaskOriginator` stamping |
| Modify | `src/skills/execution.ts` | Switch elevated gate from `caller.role` to `isPrincipalOriginated` |
| Modify | `src/skills/outbound-gateway.ts` | Remove `ceoEmail`/`ceoSignalNumber` config fields, add DB-driven `isPrincipalRecipient()` |
| Modify | `src/agents/runtime.ts` | Include `system_role` in sender context injection |
| Modify | `src/index.ts` | Wire readiness checks, remove `ceoEmail`/`ceoSignalNumber` from OutboundGateway constructor |
| Modify | `skills/send-draft/handler.ts` | Switch `ceoInitiated` check to `isPrincipalOriginated` |
| Modify | `skills/approve-action/handler.ts` | Switch `ceoInitiated` check to `isPrincipalOriginated` |
| Modify | `skills/deny-action/handler.ts` | Switch `ceoInitiated` check to `isPrincipalOriginated` |
| Modify | `skills/dismiss-action/handler.ts` | Switch `ceoInitiated` check to `isPrincipalOriginated` |
| Modify | `skills/list-pending-actions/handler.ts` | Switch `ceoInitiated` check to `isPrincipalOriginated` |
| Modify | `src/contacts/contact-resolver.ts` | Switch `findContactByRole('ceo')` to `findContactBySystemRole('principal')` |
| Modify | `src/contacts/confidence-pipeline.ts` | Switch `role === 'ceo'` to `systemRole === 'principal'` |
| Modify | `tests/integration/ceo-bootstrap.test.ts` | Assert `system_role = 'principal'` |
| Modify | `tests/unit/dispatch/dispatcher.test.ts` | Update ceoMeta assertions to TaskOriginator |
| Modify | `tests/unit/skills/execution.test.ts` | Update elevated gate tests |

---

### Task 1: Database Migration

**Files:**
- Create: `src/db/migrations/035_add_system_role.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 035_add_system_role.sql
--
-- Adds a system_role column to contacts to separate system designation
-- ('principal', 'agent') from the free-text descriptive role field.
-- See design doc: docs/wip/2026-05-10-principal-identity-design.md

-- Add column with check constraint
ALTER TABLE contacts
  ADD COLUMN system_role TEXT
  CHECK (system_role IN ('principal', 'agent'));

-- Only one principal (the human Curia serves)
CREATE UNIQUE INDEX idx_contacts_system_role_principal
  ON contacts (system_role)
  WHERE system_role = 'principal';

-- Only one agent (Curia itself)
CREATE UNIQUE INDEX idx_contacts_system_role_agent
  ON contacts (system_role)
  WHERE system_role = 'agent';

-- Backfill from existing data.
-- Production has exactly one role='ceo' and one role='agent'.
UPDATE contacts SET system_role = 'principal' WHERE role = 'ceo';
UPDATE contacts SET system_role = 'agent' WHERE role = 'agent';
```

- [ ] **Step 2: Verify migration numbering is unique**

Run: `ls src/db/migrations/ | sort`

Expected: `035_add_system_role.sql` is the only file with prefix `035`. If there's a collision, renumber to the next available slot.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/035_add_system_role.sql
git commit -m "feat: add system_role column to contacts (migration 035)"
```

---

### Task 2: Type Definitions

**Files:**
- Modify: `src/contacts/types.ts`

- [ ] **Step 1: Add SystemRole type and update Contact interface**

In `src/contacts/types.ts`, add the `SystemRole` type after the existing `TrustLevel` type definition, and add `systemRole` to the `Contact` interface.

Add `SystemRole` type near the other type definitions (after line 19, near the `TrustLevel` definition):

```typescript
/** System designation — drives authorization. Separate from the free-text `role` field. */
export type SystemRole = 'principal' | 'agent';
```

Add `systemRole` field to the `Contact` interface (after the `role` field, around line 7):

```typescript
  systemRole: SystemRole | null;
```

- [ ] **Step 2: Add TaskOriginator interface**

Add after the `InboundSenderContext` type (after line 124):

```typescript
/**
 * Identifies who originally initiated a task chain. Stamped by the dispatcher
 * on every task — not just principal-originated ones. Survives task delegation
 * when the creating code copies originator from the parent task.
 *
 * See docs/wip/2026-05-10-principal-identity-design.md
 */
export interface TaskOriginator {
  /** Contact ID of the person or agent that started this chain */
  contactId: string;
  /** System designation at the time the task was created */
  systemRole: SystemRole | null;
  /** Channel the task was initiated from (email, signal, cli, scheduler, etc.) */
  channel: string;
  /** ISO timestamp — when the chain started */
  initiatedAt: string;
}
```

- [ ] **Step 3: Verify the types compile**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/contacts/types.ts
git commit -m "feat: add SystemRole type, TaskOriginator interface, systemRole to Contact"
```

---

### Task 3: Contact Service — Add system_role to Queries

**Files:**
- Modify: `src/contacts/contact-service.ts`

This task updates every SQL query and the `rowToContact` mapper to include the `system_role` column. It also adds a `findContactBySystemRole()` method to both the Postgres backend and the InMemoryContactService.

- [ ] **Step 1: Add findContactBySystemRole to the ContactBackend interface**

Around line 44 (after `findContactByRole`), add:

```typescript
  findContactBySystemRole(systemRole: string): Promise<Contact | null>;
```

- [ ] **Step 2: Update rowToContact in the Postgres backend**

The `rowToContact` method at line 1233 needs `system_role` in its input type and output mapping.

Add to the row parameter type:

```typescript
    system_role: string | null;
```

Add to the returned object (after the `role` mapping):

```typescript
      systemRole: (row.system_role === 'principal' || row.system_role === 'agent') ? row.system_role : null,
```

- [ ] **Step 3: Add system_role to every SELECT query**

Every SQL query that selects from `contacts` and calls `rowToContact` needs `system_role` in its column list. These are in:

- `getContact` (~line 841): add `system_role` to the SELECT and the row type
- `findContactByName` (~line 872): add `system_role` to the SELECT and the row type
- `findContactByRole` (~line 896): add `system_role` to the SELECT and the row type
- `listContacts` (~line 920): add `system_role` to the SELECT and the row type
- `resolveByChannelIdentity` (search for the method): add `system_role` to the SELECT and the row type

For each, add `system_role` to:
1. The row type definition: `system_role: string | null;`
2. The SQL SELECT column list: `, system_role`

- [ ] **Step 4: Add system_role to INSERT and UPDATE queries**

- `createContact` (~line 818): add `system_role` to the INSERT column list and values
  ```sql
  INSERT INTO contacts (id, kg_node_id, display_name, role, system_role, status, notes, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ```
  Add `contact.systemRole` to the parameter array.

- `updateContact` (~line 931): add `system_role` to the UPDATE SET clause
  ```sql
  UPDATE contacts SET kg_node_id = $2, display_name = $3, role = $4, system_role = $5, status = $6, notes = $7, trust_level = $8, updated_at = $9
  WHERE id = $1
  ```
  Add `contact.systemRole` to the parameter array.

- [ ] **Step 5: Implement findContactBySystemRole in the Postgres backend**

Add after `findContactByRole` (~line 901):

```typescript
  async findContactBySystemRole(systemRole: string): Promise<Contact | null> {
    const result = await this.pool.query<{
      id: string;
      kg_node_id: string | null;
      display_name: string;
      role: string | null;
      system_role: string | null;
      status: string;
      contact_confidence: string;
      trust_level: string | null;
      last_seen_at: Date | null;
      inbound_message_count: string;
      outbound_message_count: string;
      notes: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kg_node_id, display_name, role, system_role, status, contact_confidence, trust_level, last_seen_at, inbound_message_count, outbound_message_count, notes, created_at, updated_at
       FROM contacts WHERE system_role = $1 LIMIT 1`,
      [systemRole],
    );

    const row = result.rows[0];
    if (!row) return null;
    return this.rowToContact(row);
  }
```

- [ ] **Step 6: Update InMemoryContactService**

The `InMemoryContactService` (starts around line 1310) needs:

1. Update `createContact` to enforce the system_role unique constraint (after the existing `kgNodeId` check at line 1338):

```typescript
    // Enforce system_role uniqueness to match Postgres partial unique indexes
    if (contact.systemRole) {
      for (const existing of this.contacts.values()) {
        if (existing.systemRole === contact.systemRole) {
          const err = Object.assign(
            new Error(`duplicate key value violates unique constraint "idx_contacts_system_role_${contact.systemRole}"`),
            { code: '23505', constraint: `idx_contacts_system_role_${contact.systemRole}` },
          );
          throw err;
        }
      }
    }
```

2. Add `findContactBySystemRole`:

```typescript
  async findContactBySystemRole(systemRole: string): Promise<Contact | null> {
    for (const contact of this.contacts.values()) {
      if (contact.systemRole === systemRole) return contact;
    }
    return null;
  }
```

- [ ] **Step 7: Expose findContactBySystemRole on the ContactService facade**

Add to the `ContactService` class (after `findContactByRole` at ~line 298):

```typescript
  /** Find the single contact with the given system role, or null. */
  async findContactBySystemRole(systemRole: string): Promise<Contact | null> {
    return this.backend.findContactBySystemRole(systemRole);
  }
```

- [ ] **Step 8: Verify it compiles**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 9: Commit**

```bash
git add src/contacts/contact-service.ts
git commit -m "feat: add system_role to contact queries, add findContactBySystemRole"
```

---

### Task 4: Principal Helper Module

**Files:**
- Create: `src/contacts/principal.ts`
- Create: `tests/unit/contacts/principal.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/contacts/principal.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isPrincipalOriginated, isAgentOriginated } from '../../../src/contacts/principal.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';

describe('isPrincipalOriginated', () => {
  it('returns true when originator systemRole is principal', () => {
    const metadata = {
      originator: {
        contactId: 'c-1',
        systemRole: 'principal',
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isPrincipalOriginated(metadata)).toBe(true);
  });

  it('returns false when originator systemRole is agent', () => {
    const metadata = {
      originator: {
        contactId: 'c-2',
        systemRole: 'agent',
        channel: 'cli',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isPrincipalOriginated(metadata)).toBe(false);
  });

  it('returns false when originator systemRole is null', () => {
    const metadata = {
      originator: {
        contactId: 'c-3',
        systemRole: null,
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isPrincipalOriginated(metadata)).toBe(false);
  });

  it('returns false when originator is missing', () => {
    expect(isPrincipalOriginated({})).toBe(false);
    expect(isPrincipalOriginated(undefined)).toBe(false);
  });
});

describe('isAgentOriginated', () => {
  it('returns true when originator systemRole is agent', () => {
    const metadata = {
      originator: {
        contactId: 'c-2',
        systemRole: 'agent',
        channel: 'scheduler',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isAgentOriginated(metadata)).toBe(true);
  });

  it('returns false when originator systemRole is principal', () => {
    const metadata = {
      originator: {
        contactId: 'c-1',
        systemRole: 'principal',
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      } satisfies TaskOriginator,
    };
    expect(isAgentOriginated(metadata)).toBe(false);
  });

  it('returns false when metadata is missing', () => {
    expect(isAgentOriginated(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix . vitest run tests/unit/contacts/principal.test.ts`

Expected: FAIL — module `../../../src/contacts/principal.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/contacts/principal.ts`:

```typescript
// src/contacts/principal.ts
//
// Helper functions for principal (CEO) identity checks.
// Centralizes all principal-related queries so authorization logic
// lives in one place without over-abstracting into a service class.
//
// See docs/wip/2026-05-10-principal-identity-design.md

import type { TaskOriginator } from './types.js';

/**
 * Check whether a task was originated by the principal (the human Curia serves).
 * Used by the execution layer's elevated skill gate and CEO-authorized skill handlers.
 *
 * @param metadata  Task metadata (from ctx.taskMetadata or agent.task payload)
 */
export function isPrincipalOriginated(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  const originator = metadata.originator as TaskOriginator | undefined;
  return originator?.systemRole === 'principal';
}

/**
 * Check whether a task was originated by the agent (Curia itself).
 * Used when the coordinator needs to know "did I start this myself?"
 *
 * @param metadata  Task metadata (from ctx.taskMetadata or agent.task payload)
 */
export function isAgentOriginated(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  const originator = metadata.originator as TaskOriginator | undefined;
  return originator?.systemRole === 'agent';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix . vitest run tests/unit/contacts/principal.test.ts`

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/contacts/principal.ts tests/unit/contacts/principal.test.ts
git commit -m "feat: add principal helper module with isPrincipalOriginated and isAgentOriginated"
```

---

### Task 5: Bootstrap Updates

**Files:**
- Modify: `src/contacts/ceo-bootstrap.ts`
- Modify: `src/entity-context/bootstrap.ts`

- [ ] **Step 1: Update CEO bootstrap — UPDATE query**

In `src/contacts/ceo-bootstrap.ts`, the UPDATE query at ~line 71 sets `role` and `trust_level`. Add `system_role`:

Change the UPDATE query from:

```sql
UPDATE contacts
 SET role = 'ceo',
     trust_level = 'ceo',
     updated_at = now()
 WHERE id = $1
   AND (role IS DISTINCT FROM 'ceo' OR trust_level IS DISTINCT FROM 'ceo')
```

To:

```sql
UPDATE contacts
 SET role = 'ceo',
     trust_level = 'ceo',
     system_role = 'principal',
     updated_at = now()
 WHERE id = $1
   AND (role IS DISTINCT FROM 'ceo' OR trust_level IS DISTINCT FROM 'ceo' OR system_role IS DISTINCT FROM 'principal')
```

- [ ] **Step 2: Update CEO bootstrap — INSERT query**

The INSERT at ~line 151 creates a new CEO contact. Add `system_role`:

Change:

```sql
INSERT INTO contacts (id, kg_node_id, display_name, role, status, trust_level, created_at, updated_at)
VALUES ($1, $2, $3, 'ceo', 'confirmed', 'ceo', now(), now())
```

To:

```sql
INSERT INTO contacts (id, kg_node_id, display_name, role, status, trust_level, system_role, created_at, updated_at)
VALUES ($1, $2, $3, 'ceo', 'confirmed', 'ceo', 'principal', now(), now())
```

- [ ] **Step 3: Update agent identity bootstrap**

In `src/entity-context/bootstrap.ts`, the INSERT at ~line 76 creates the agent contact. Add `system_role`:

Change:

```sql
INSERT INTO contacts (kg_node_id, display_name, role, status, created_at, updated_at)
VALUES ($1, $2, 'agent', 'confirmed', now(), now())
ON CONFLICT (kg_node_id) WHERE kg_node_id IS NOT NULL
DO UPDATE SET role = 'agent', updated_at = now()
RETURNING id
```

To:

```sql
INSERT INTO contacts (kg_node_id, display_name, role, status, system_role, created_at, updated_at)
VALUES ($1, $2, 'agent', 'confirmed', 'agent', now(), now())
ON CONFLICT (kg_node_id) WHERE kg_node_id IS NOT NULL
DO UPDATE SET role = 'agent', system_role = 'agent', updated_at = now()
RETURNING id
```

- [ ] **Step 4: Verify it compiles**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/contacts/ceo-bootstrap.ts src/entity-context/bootstrap.ts
git commit -m "feat: set system_role in CEO and agent bootstrap"
```

---

### Task 6: Dispatcher — TaskOriginator Stamping

**Files:**
- Modify: `src/dispatch/dispatcher.ts`

- [ ] **Step 1: Update mergeTaskMetadata to strip originator instead of ceoInitiated**

Change `mergeTaskMetadata` at line 29 from:

```typescript
function mergeTaskMetadata(
  channelMetadata: Record<string, unknown> | undefined,
  injectionMetadata: Record<string, unknown> | undefined,
  ceoMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!channelMetadata && !injectionMetadata && !ceoMeta) return undefined;
  return {
    ...(channelMetadata ?? {}),
    ceoInitiated: undefined,          // strip untrusted channel value
    ...(injectionMetadata ?? {}),
    ...(ceoMeta ?? {}),               // ceoMeta.ceoInitiated wins if present
  };
}
```

To:

```typescript
/**
 * Merge channel-supplied metadata with injection findings and originator context.
 * SECURITY: strips both `ceoInitiated` (legacy) and `originator` from channel-supplied
 * metadata — originator is stamped exclusively by this function from the contact resolver.
 * A crafted inbound with a forged originator must never propagate. See ADR-017.
 */
function mergeTaskMetadata(
  channelMetadata: Record<string, unknown> | undefined,
  injectionMetadata: Record<string, unknown> | undefined,
  originatorMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!channelMetadata && !injectionMetadata && !originatorMeta) return undefined;
  return {
    ...(channelMetadata ?? {}),
    ceoInitiated: undefined,          // strip legacy untrusted channel value
    originator: undefined,            // strip untrusted channel value
    ...(injectionMetadata ?? {}),
    ...(originatorMeta ?? {}),        // originatorMeta.originator wins if present
  };
}
```

- [ ] **Step 2: Add TaskOriginator import**

Add at the top of the file with the other imports from contacts:

```typescript
import type { TaskOriginator } from '../contacts/types.js';
```

- [ ] **Step 3: Replace ceoMeta stamping with TaskOriginator**

Change the block at ~line 844 from:

```typescript
    const ceoMeta = senderContext?.resolved && senderContext.role === 'ceo'
      ? { ceoInitiated: true as const, senderId: payload.senderId, channelId: payload.channelId }
      : undefined;
```

To:

```typescript
    // Stamp TaskOriginator on every task — not just principal-originated ones.
    // The originator tracks who started this task chain. For inbound messages,
    // that's the sender. For self-initiated tasks (scheduler, proactive), the
    // caller sets originator before invoking createAgentTask.
    // SECURITY: originator is the ONLY source of systemRole for downstream
    // authorization. See ADR-017 and docs/wip/2026-05-10-principal-identity-design.md.
    const originator: TaskOriginator | undefined = senderContext?.resolved
      ? {
          contactId: senderContext.contactId,
          systemRole: senderContext.systemRole ?? null,
          channel: payload.channelId,
          initiatedAt: new Date().toISOString(),
        }
      : undefined;
    const originatorMeta = originator ? { originator } : undefined;
```

Note: this requires `systemRole` to be on `SenderContext`. See Task 7.

- [ ] **Step 4: Update the createAgentTask call**

Change the metadata argument at ~line 866 from:

```typescript
      metadata: mergeTaskMetadata(
        payload.metadata as Record<string, unknown> | undefined,
        injectionMetadata,
        ceoMeta,
      ),
```

To:

```typescript
      metadata: mergeTaskMetadata(
        payload.metadata as Record<string, unknown> | undefined,
        injectionMetadata,
        originatorMeta,
      ),
```

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/dispatcher.ts
git commit -m "feat: replace ceoInitiated with TaskOriginator stamping in dispatcher"
```

---

### Task 7: Contact Resolver & Sender Context — Add systemRole

**Files:**
- Modify: `src/contacts/types.ts`
- Modify: `src/contacts/contact-resolver.ts`

The `SenderContext` and `ResolvedSender` interfaces need `systemRole` so the dispatcher can read it when stamping `TaskOriginator`.

- [ ] **Step 1: Add systemRole to ResolvedSender and SenderContext**

In `src/contacts/types.ts`:

Add to `ResolvedSender` (after `role` at ~line 93):

```typescript
  systemRole: SystemRole | null;
```

Add to `SenderContext` (after `role` at ~line 106):

```typescript
  systemRole: SystemRole | null;
```

- [ ] **Step 2: Update contact-resolver to populate systemRole**

In `src/contacts/contact-resolver.ts`, find the CLI/web channel resolution at ~line 46 where `findContactByRole('ceo')` is called. Change this to use `findContactBySystemRole('principal')`:

Change:

```typescript
        const ceoContacts = await this.contactService.findContactByRole('ceo');
        const ceo = ceoContacts[0];
        if (ceo) {
          return {
            resolved: true,
            contactId: ceo.id,
            displayName: ceo.displayName,
            role: 'ceo',
```

To:

```typescript
        const principal = await this.contactService.findContactBySystemRole('principal');
        if (principal) {
          return {
            resolved: true,
            contactId: principal.id,
            displayName: principal.displayName,
            role: principal.role,
            systemRole: principal.systemRole,
```

- [ ] **Step 3: Add systemRole to all other SenderContext/ResolvedSender construction sites**

Search for all places that construct a `SenderContext` or `ResolvedSender` object and add `systemRole`. The contact resolver's `resolveByChannelIdentity` path also builds these — find it and add `systemRole: contact.systemRole` to the returned object.

The email/signal channel resolution path (the one that calls `this.contactService.backend.resolveByChannelIdentity()`) returns a `ResolvedSender`. That resolver method already reads from the `contacts` table — after Task 3, `rowToContact` populates `systemRole`, so `ResolvedSender` should include it.

Check: search for `resolved: true` in the contact-resolver file and ensure every occurrence includes `systemRole`.

- [ ] **Step 4: Verify it compiles**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add src/contacts/types.ts src/contacts/contact-resolver.ts
git commit -m "feat: add systemRole to SenderContext and contact resolver"
```

---

### Task 8: Execution Layer — Switch Elevated Gate

**Files:**
- Modify: `src/skills/execution.ts`

- [ ] **Step 1: Add import for isPrincipalOriginated**

Add at the top of the file:

```typescript
import { isPrincipalOriginated } from '../contacts/principal.js';
```

- [ ] **Step 2: Replace the elevated skill gate**

Change the block at ~line 304 from:

```typescript
    if (manifest.sensitivity === 'elevated') {
      if (!caller) {
        this.logger.warn({ skillName }, 'Elevated skill blocked: no caller context (fail-closed)');
        return {
          success: false,
          error: this.wrapSkillError(`Skill '${skillName}' requires elevated privileges — no caller context provided (fail-closed)`),
        };
      }
      if (caller.role !== 'ceo') {
        this.logger.warn({ skillName, role: caller.role, channel: caller.channel }, 'Elevated skill blocked: unauthorized caller');
        return {
          success: false,
          error: this.wrapSkillError(`Skill '${skillName}' requires elevated privileges — caller role '${caller.role ?? 'none'}' on channel '${caller.channel}' is not authorized`),
        };
      }
    }
```

To:

```typescript
    // Elevated-skill gate: require principal origination, not just caller role.
    // The originator (who started the task chain) is the authorization signal,
    // not the caller (who is executing this specific skill call).
    // See docs/wip/2026-05-10-principal-identity-design.md
    if (manifest.sensitivity === 'elevated') {
      if (!isPrincipalOriginated(taskMetadata)) {
        this.logger.warn(
          { skillName, caller: caller ? { role: caller.role, channel: caller.channel } : null },
          'Elevated skill blocked: task not originated by principal',
        );
        return {
          success: false,
          error: this.wrapSkillError(`Skill '${skillName}' requires elevated privileges — task was not originated by the principal`),
        };
      }
    }
```

Note: `taskMetadata` is already available in the `execute` method — find it in the method signature or the `SkillContext` construction. If it's on `ctx.taskMetadata`, extract it before this check.

- [ ] **Step 3: Verify it compiles**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/skills/execution.ts
git commit -m "feat: switch elevated skill gate from caller.role to isPrincipalOriginated"
```

---

### Task 9: Skill Handlers — Switch ceoInitiated Checks

**Files:**
- Modify: `skills/send-draft/handler.ts`
- Modify: `skills/approve-action/handler.ts`
- Modify: `skills/deny-action/handler.ts`
- Modify: `skills/dismiss-action/handler.ts`
- Modify: `skills/list-pending-actions/handler.ts`

All five handlers have the same pattern: `ctx.taskMetadata?.ceoInitiated !== true`. Replace with `isPrincipalOriginated`.

- [ ] **Step 1: Update send-draft/handler.ts**

Add import at the top:

```typescript
import { isPrincipalOriginated } from '../../src/contacts/principal.js';
```

Change the check at ~line 32 from:

```typescript
  if (ctx.taskMetadata?.ceoInitiated !== true) {
    ctx.log.warn(
      { ceoInitiated: ctx.taskMetadata?.ceoInitiated },
      'send-draft: rejected — ceoInitiated flag absent or false in task metadata',
    );
    return {
      success: false,
      error: 'send-draft requires direct CEO authorization. This skill can only be called from a task initiated by the CEO.',
    };
  }
```

To:

```typescript
  if (!isPrincipalOriginated(ctx.taskMetadata)) {
    ctx.log.warn('send-draft: rejected — task not originated by principal');
    return {
      success: false,
      error: 'send-draft requires principal authorization. This skill can only be called from a task initiated by the principal.',
    };
  }
```

- [ ] **Step 2: Update approve-action/handler.ts**

Add import:

```typescript
import { isPrincipalOriginated } from '../../src/contacts/principal.js';
```

Change:

```typescript
  if (ctx.taskMetadata?.ceoInitiated !== true) {
    ctx.log.warn('approve-action: rejected — ceoInitiated flag absent or false');
    return { success: false, error: 'This skill requires direct CEO authorization.' };
  }
```

To:

```typescript
  if (!isPrincipalOriginated(ctx.taskMetadata)) {
    ctx.log.warn('approve-action: rejected — task not originated by principal');
    return { success: false, error: 'This skill requires principal authorization.' };
  }
```

- [ ] **Step 3: Update deny-action/handler.ts**

Same pattern. Add import, change check:

```typescript
  if (!isPrincipalOriginated(ctx.taskMetadata)) {
    ctx.log.warn('deny-action: rejected — task not originated by principal');
```

- [ ] **Step 4: Update dismiss-action/handler.ts**

Same pattern. Add import, change check:

```typescript
  if (!isPrincipalOriginated(ctx.taskMetadata)) {
    ctx.log.warn('dismiss-action: rejected — task not originated by principal');
```

- [ ] **Step 5: Update list-pending-actions/handler.ts**

Same pattern. Add import, change check:

```typescript
  if (!isPrincipalOriginated(ctx.taskMetadata)) {
    ctx.log.warn('list-pending-actions: rejected — task not originated by principal');
```

- [ ] **Step 6: Verify it compiles**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add skills/send-draft/handler.ts skills/approve-action/handler.ts skills/deny-action/handler.ts skills/dismiss-action/handler.ts skills/list-pending-actions/handler.ts
git commit -m "feat: switch CEO-authorized skills from ceoInitiated to isPrincipalOriginated"
```

---

### Task 10: OutboundGateway — DB-Driven Principal Check

**Files:**
- Modify: `src/skills/outbound-gateway.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add principalIdentities to OutboundGatewayConfig**

Replace the `ceoEmail` and `ceoSignalNumber` fields on `OutboundGatewayConfig` (at ~lines 151 and 158):

Remove:

```typescript
  ceoEmail?: string;
  ceoSignalNumber?: string;
```

Add:

```typescript
  /**
   * Cached channel identities of the principal contact (the human Curia serves).
   * Loaded at startup from the database. Used by isPrincipalRecipient() to
   * determine whether an outbound message is directed at the principal —
   * principal-bound messages bypass the autonomy gate.
   *
   * When empty (no principal contact exists), the principal bypass does not fire.
   */
  principalIdentities?: import('../contacts/types.js').ChannelIdentity[];
```

- [ ] **Step 2: Update the constructor**

Change the constructor (at ~line 247) to store principal identities instead of flat fields:

Remove:

```typescript
    this.ceoEmail = config.ceoEmail ?? '';
    this.ceoSignalNumber = config.ceoSignalNumber ?? '';
    if (this.ceoSignalNumber && !/^\+\d{7,15}$/.test(this.ceoSignalNumber)) {
      this.log.warn(
        { ceoSignalNumber: this.ceoSignalNumber },
        'outbound-gateway: ceoSignalNumber does not look like E.164 format (expected +digits) — CEO Signal bypass may not match',
      );
    }
```

Add:

```typescript
    this.principalIdentities = config.principalIdentities ?? [];
```

Also add the property declaration on the class (near the other private fields):

```typescript
  private readonly principalIdentities: import('../contacts/types.js').ChannelIdentity[];
```

And remove the old property declarations for `ceoEmail` and `ceoSignalNumber`.

- [ ] **Step 3: Replace isCeoRecipient with isPrincipalRecipient**

Change the method at ~line 801 from:

```typescript
  private isCeoRecipient(request: OutboundSendRequest): boolean {
    if (request.channel === 'email') {
      return this.isCeoEmail(request.to);
    }
    if (request.channel === 'signal' && 'recipient' in request && request.recipient) {
      return this.ceoSignalNumber !== '' && request.recipient === this.ceoSignalNumber;
    }
    return false;
  }
```

To:

```typescript
  /**
   * Check whether the recipient is the principal (the human Curia serves).
   * Resolves against the principal contact's verified channel identities,
   * loaded from the database at startup.
   */
  private isPrincipalRecipient(request: OutboundSendRequest): boolean {
    if (this.principalIdentities.length === 0) return false;

    if (request.channel === 'email' && request.to) {
      const normalized = request.to.toLowerCase();
      return this.principalIdentities.some(
        (id) => id.channel === 'email' && id.channelIdentifier.toLowerCase() === normalized,
      );
    }
    if (request.channel === 'signal' && 'recipient' in request && request.recipient) {
      return this.principalIdentities.some(
        (id) => id.channel === 'signal' && id.channelIdentifier === request.recipient,
      );
    }
    return false;
  }
```

- [ ] **Step 4: Replace isCeoEmail with isPrincipalEmail**

Change the method at ~line 819 from:

```typescript
  private isCeoEmail(email: string | undefined | null): boolean {
    if (!email || this.ceoEmail === '') return false;
    return email.toLowerCase() === this.ceoEmail.toLowerCase();
  }
```

To:

```typescript
  /**
   * Check whether an email address belongs to the principal.
   * Used by sendEmailDraft() for the autonomy bypass.
   */
  private isPrincipalEmail(email: string | undefined | null): boolean {
    if (!email || this.principalIdentities.length === 0) return false;
    const normalized = email.toLowerCase();
    return this.principalIdentities.some(
      (id) => id.channel === 'email' && id.channelIdentifier.toLowerCase() === normalized,
    );
  }
```

- [ ] **Step 5: Update all call sites**

Search for `isCeoRecipient` and `isCeoEmail` in `outbound-gateway.ts` and replace:

- `this.isCeoRecipient(request)` at ~line 355 → `this.isPrincipalRecipient(request)`
- Update the log message: `'recipient is CEO'` → `'recipient is principal'`
- `this.isCeoEmail(draftMeta.recipientEmail)` at ~line 1074 → `this.isPrincipalEmail(draftMeta.recipientEmail)`
- Update the log message: `'draft recipient is CEO'` → `'draft recipient is principal'`

Also update the comment at ~line 355:

```typescript
  // Agent-to-principal communication — the autonomy gate must not silence
  // the agent's ability to communicate with its oversight authority.
```

- [ ] **Step 6: Update the ceoEmail usage for blocked-content notifications**

The `ceoEmail` config field is also used as the To address for blocked-content CEO notifications (search for `this.ceoEmail` outside of `isCeoEmail`). This needs to be changed to query the principal's email identity from the cached identities:

```typescript
    // Find principal's email for notification
    const principalEmail = this.principalIdentities.find((id) => id.channel === 'email')?.channelIdentifier;
```

Replace any reference to `this.ceoEmail` for notification sending with `principalEmail`.

- [ ] **Step 7: Update src/index.ts — load principal identities and pass to gateway**

In `src/index.ts`, before the OutboundGateway construction (~line 719), load the principal's identities:

```typescript
  // Load principal's channel identities for outbound gateway recipient check.
  // These are cached for the lifetime of the process — the gateway uses them
  // to determine whether an outbound message is directed at the principal.
  let principalIdentities: import('./contacts/types.js').ChannelIdentity[] = [];
  if (contactService) {
    const principal = await contactService.findContactBySystemRole('principal');
    if (principal) {
      principalIdentities = await contactService.backend.getIdentitiesForContact(principal.id);
    }
  }
```

Then update the OutboundGateway constructor call: remove `ceoEmail` and `ceoSignalNumber`, add `principalIdentities`:

Change:

```typescript
      ceoEmail: config.ceoPrimaryEmail || undefined,
      ceoSignalNumber: config.ceoSignalNumber,
```

To:

```typescript
      principalIdentities,
```

- [ ] **Step 8: Verify it compiles**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 9: Commit**

```bash
git add src/skills/outbound-gateway.ts src/index.ts
git commit -m "feat: replace OutboundGateway flat CEO fields with DB-driven principal identity lookup"
```

---

### Task 11: Coordinator Runtime — System Role in Sender Context

**Files:**
- Modify: `src/agents/runtime.ts`

- [ ] **Step 1: Update sender context injection**

In `src/agents/runtime.ts`, the sender context injection block (~line 307) builds a `senderInfo` string. Where it adds the role, also include the system role:

Change:

```typescript
  let senderInfo = `Current sender: ${safeName}`;
  if (safeRole) senderInfo += ` (${safeRole})`;
  senderInfo += senderCtx.verified ? ' [verified]' : ' [unverified]';
```

To:

```typescript
  let senderInfo = `Current sender: ${safeName}`;
  // Show system role first (deterministic system designation), then descriptive role
  if (senderCtx.systemRole) senderInfo += ` (${senderCtx.systemRole})`;
  else if (safeRole) senderInfo += ` (${safeRole})`;
  senderInfo += senderCtx.verified ? ' [verified]' : ' [unverified]';
```

- [ ] **Step 2: Verify it compiles**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/agents/runtime.ts
git commit -m "feat: show system_role in coordinator sender context injection"
```

---

### Task 12: Confidence Pipeline — Switch to systemRole

**Files:**
- Modify: `src/contacts/confidence-pipeline.ts`

- [ ] **Step 1: Replace role checks with systemRole**

Find the two CEO checks at ~lines 48 and 119:

Change both instances of:

```typescript
if (contact.role === 'ceo') return;
```

To:

```typescript
if (contact.systemRole === 'principal') return;
```

And:

```typescript
if (contact.role === 'ceo') return 1.0;
```

To:

```typescript
if (contact.systemRole === 'principal') return 1.0;
```

- [ ] **Step 2: Commit**

```bash
git add src/contacts/confidence-pipeline.ts
git commit -m "fix: switch confidence pipeline CEO check to systemRole"
```

---

### Task 13: Startup Readiness Checks

**Files:**
- Create: `src/startup/readiness.ts`
- Create: `tests/unit/startup/readiness.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/startup/readiness.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runReadinessChecks } from '../../../src/startup/readiness.js';
import type { ReadinessCheck } from '../../../src/startup/readiness.js';

describe('runReadinessChecks', () => {
  it('returns ready when all checks pass', async () => {
    const checks: ReadinessCheck[] = [
      { name: 'test-check', check: async () => ({ ready: true }) },
    ];
    const result = await runReadinessChecks(checks);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('returns not ready when a check fails', async () => {
    const checks: ReadinessCheck[] = [
      { name: 'passing', check: async () => ({ ready: true }) },
      { name: 'failing', check: async () => ({ ready: false, reason: 'missing principal contact' }) },
    ];
    const result = await runReadinessChecks(checks);
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('failing');
    expect(result.failures[0].reason).toBe('missing principal contact');
  });

  it('returns not ready when a check throws', async () => {
    const checks: ReadinessCheck[] = [
      { name: 'exploding', check: async () => { throw new Error('boom'); } },
    ];
    const result = await runReadinessChecks(checks);
    expect(result.ready).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('exploding');
    expect(result.failures[0].reason).toContain('boom');
  });

  it('returns ready when checks array is empty', async () => {
    const result = await runReadinessChecks([]);
    expect(result.ready).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx --prefix . vitest run tests/unit/startup/readiness.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/startup/readiness.ts`:

```typescript
// src/startup/readiness.ts
//
// Startup readiness check runner. After bootstrap completes, the system
// runs all registered checks. If any fail, the system enters setup-required
// mode and refuses to accept inbound messages.
//
// See docs/wip/2026-05-10-principal-identity-design.md

export interface ReadinessCheck {
  /** Short name for logging (e.g. 'principal-contact') */
  name: string;
  /** Returns { ready: true } or { ready: false, reason } */
  check: () => Promise<ReadinessResult>;
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
}

export interface ReadinessReport {
  ready: boolean;
  failures: Array<{ name: string; reason: string }>;
}

/**
 * Run all readiness checks and return a report.
 * Checks run sequentially (they may share DB connections).
 * A check that throws is treated as a failure.
 */
export async function runReadinessChecks(
  checks: ReadinessCheck[],
): Promise<ReadinessReport> {
  const failures: Array<{ name: string; reason: string }> = [];

  for (const check of checks) {
    try {
      const result = await check.check();
      if (!result.ready) {
        failures.push({ name: check.name, reason: result.reason ?? 'check failed' });
      }
    } catch (err) {
      failures.push({
        name: check.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ready: failures.length === 0,
    failures,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx --prefix . vitest run tests/unit/startup/readiness.test.ts`

Expected: All 4 tests PASS.

- [ ] **Step 5: Wire readiness checks into src/index.ts**

In `src/index.ts`, after the bootstrap section (after ~line 404) and before the dispatcher/gateway setup, add:

```typescript
  // --- Startup readiness checks ---
  // All checks must pass before the system accepts inbound messages.
  // See docs/wip/2026-05-10-principal-identity-design.md
  const { runReadinessChecks } = await import('./startup/readiness.js');
  const readinessReport = await runReadinessChecks([
    {
      name: 'principal-contact',
      check: async () => {
        const principal = await contactService.findContactBySystemRole('principal');
        return principal
          ? { ready: true }
          : { ready: false, reason: 'No contact with system_role=principal exists. Run setup to configure the principal user.' };
      },
    },
  ]);

  if (!readinessReport.ready) {
    for (const failure of readinessReport.failures) {
      logger.error({ check: failure.name, reason: failure.reason }, 'Startup readiness check failed');
    }
    throw new Error(`Startup readiness failed: ${readinessReport.failures.map((f) => f.name).join(', ')}`);
  }
  logger.info('All startup readiness checks passed');
```

- [ ] **Step 6: Commit**

```bash
git add src/startup/readiness.ts tests/unit/startup/readiness.test.ts src/index.ts
git commit -m "feat: add startup readiness checks with principal-contact gate"
```

---

### Task 14: Update Existing Tests

**Files:**
- Modify: `tests/integration/ceo-bootstrap.test.ts`
- Modify: `tests/unit/dispatch/dispatcher.test.ts`
- Modify: `tests/unit/skills/execution.test.ts`

- [ ] **Step 1: Update ceo-bootstrap integration test**

In `tests/integration/ceo-bootstrap.test.ts`, add assertions for `system_role` in each test case. After the existing assertions for `role` and `trust_level`, add:

```typescript
    // Verify system_role was set
    const contact = await pool.query(
      `SELECT system_role FROM contacts WHERE id = $1`,
      [result.contactId],
    );
    expect(contact.rows[0].system_role).toBe('principal');
```

Also update the cleanup in `beforeEach` to account for the new column:

```typescript
    await pool.query(
      `DELETE FROM contacts WHERE system_role = 'principal' AND display_name LIKE 'Bootstrap Test%'`,
    );
```

- [ ] **Step 2: Update dispatcher tests for TaskOriginator**

In `tests/unit/dispatch/dispatcher.test.ts`, find tests that assert `ceoInitiated: true` on task metadata and update them to assert the `originator` structure instead:

Change assertions like:

```typescript
    expect(taskEvent.payload.metadata?.ceoInitiated).toBe(true);
```

To:

```typescript
    const originator = taskEvent.payload.metadata?.originator as TaskOriginator;
    expect(originator).toBeDefined();
    expect(originator.systemRole).toBe('principal');
    expect(originator.contactId).toBeDefined();
    expect(originator.channel).toBeDefined();
    expect(originator.initiatedAt).toBeDefined();
```

Add the import:

```typescript
import type { TaskOriginator } from '../../../src/contacts/types.js';
```

Also add a test that verifies `originator` is stripped from channel-supplied metadata (security test):

```typescript
  it('strips originator from channel-supplied metadata', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'email',
      senderId: 'attacker@example.com',
      content: 'Hello',
      metadata: { originator: { contactId: 'fake', systemRole: 'principal', channel: 'email', initiatedAt: '2026-01-01' } },
    });
    // ... dispatch and capture task event ...
    const originator = taskEvent.payload.metadata?.originator as TaskOriginator | undefined;
    // If sender is not the principal, originator should not have systemRole 'principal'
    // The forged originator from metadata should have been stripped
    if (originator) {
      expect(originator.contactId).not.toBe('fake');
    }
  });
```

- [ ] **Step 3: Update execution layer tests**

In `tests/unit/skills/execution.test.ts`, find tests for the `elevated` sensitivity gate and update them:

For tests that pass the gate (CEO caller), change setup to include `originator` in taskMetadata:

```typescript
    const taskMetadata = {
      originator: {
        contactId: 'ceo-id',
        systemRole: 'principal' as const,
        channel: 'cli',
        initiatedAt: new Date().toISOString(),
      },
    };
```

For tests that should be blocked, use metadata without principal originator or with null systemRole.

- [ ] **Step 4: Run the full test suite**

Run: `npx --prefix . vitest run`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/ceo-bootstrap.test.ts tests/unit/dispatch/dispatcher.test.ts tests/unit/skills/execution.test.ts
git commit -m "test: update tests for TaskOriginator and system_role"
```

---

### Task 15: Final Verification & Cleanup

- [ ] **Step 1: Run the full test suite**

Run: `npx --prefix . vitest run`

Expected: All tests pass.

- [ ] **Step 2: Run type checking**

Run: `npx --prefix . tsc --noEmit`

Expected: No type errors.

- [ ] **Step 3: Search for any remaining ceoInitiated references**

Search the codebase for any remaining references to `ceoInitiated` that weren't caught:

Look in `src/` and `skills/` for:
- `ceoInitiated` (should only appear in the security stripping line in `mergeTaskMetadata`)
- `isCeoRecipient` (should be gone)
- `isCeoEmail` (should be gone)
- `ceoEmail` (should only appear in `OutboundGatewayConfig` comments or the bootstrap)
- `ceoSignalNumber` (should only appear in bootstrap)

Any remaining references (outside of bootstrap and the security stripping line) need to be updated.

- [ ] **Step 4: Verify migration numbering**

Run: `ls src/db/migrations/ | sort`

Verify `035_add_system_role.sql` has a unique prefix. If another branch landed a `035` migration since we started, renumber.

- [ ] **Step 5: Commit any final cleanup**

If any stray references were found and fixed in Step 3:

```bash
git add -A
git commit -m "chore: clean up remaining ceoInitiated references"
```
