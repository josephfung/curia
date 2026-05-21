# contact-list Status Filter & Limit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `status` and `limit` parameters to the `contact-list` skill so the contacts agent can query provisional contacts directly instead of enumerating all contacts through entity-context.

**Architecture:** Extend the existing `ContactServiceBackend` interface with optional filters on `listContacts()`. Both Postgres and InMemory backends implement the filters. The skill handler validates and passes them through.

**Tech Stack:** TypeScript (ESM), PostgreSQL, Vitest

**Spec:** `docs/wip/2026-05-21-contact-list-filters-design.md`
**Issue:** [#644](https://github.com/josephfung/curia/issues/644)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/contacts/contact-service.ts:42-48` | `ContactServiceBackend` interface — add filters to `listContacts` |
| Modify | `src/contacts/contact-service.ts:314-317` | `ContactService.listContacts()` — pass through filters |
| Modify | `src/contacts/contact-service.ts:952-974` | `PostgresContactBackend.listContacts()` — dynamic WHERE/LIMIT |
| Modify | `src/contacts/contact-service.ts:1486-1488` | `InMemoryContactBackend.listContacts()` — filter/limit in memory |
| Modify | `skills/contact-list/skill.json` | Add `status` and `limit` inputs, update description |
| Modify | `skills/contact-list/handler.ts` | Validate new inputs, route to `listContacts(filters)` |
| Create | `skills/contact-list/handler.test.ts` | Unit tests for handler with all filter combinations |

---

### Task 1: Add filters to ContactServiceBackend interface and implementations

**Files:**
- Modify: `src/contacts/contact-service.ts:48` (interface)
- Modify: `src/contacts/contact-service.ts:314-317` (public API)
- Modify: `src/contacts/contact-service.ts:952-974` (Postgres backend)
- Modify: `src/contacts/contact-service.ts:1486-1488` (InMemory backend)

- [ ] **Step 1: Update the `ContactServiceBackend` interface**

In `src/contacts/contact-service.ts`, change line 48 from:

```typescript
listContacts(): Promise<Contact[]>;
```

to:

```typescript
listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]>;
```

`ContactStatus` is already imported in this file from `./types.js`.

- [ ] **Step 2: Update the `ContactService` public method**

In `src/contacts/contact-service.ts`, replace lines 314–317:

```typescript
  /** List all contacts. */
  async listContacts(): Promise<Contact[]> {
    return this.backend.listContacts();
  }
```

with:

```typescript
  /** List contacts, optionally filtered by status and/or capped by limit. */
  async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
    return this.backend.listContacts(filters);
  }
```

- [ ] **Step 3: Update `PostgresContactBackend.listContacts()`**

In `src/contacts/contact-service.ts`, replace the `listContacts()` method (lines 952–974) with:

```typescript
  async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
    const cols = 'id, kg_node_id, display_name, role, system_role, status, contact_confidence, trust_level, last_seen_at, inbound_message_count, outbound_message_count, notes, created_at, updated_at';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT ${cols} FROM contacts${where} ORDER BY created_at ASC`;

    if (filters?.limit != null) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
    }

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
    }>(sql, params);

    return result.rows.map((row) => this.rowToContact(row));
  }
```

Note: The `conditions` array pattern supports future filters without restructuring. Only `status` is added now — YAGNI for anything else.

- [ ] **Step 4: Update `InMemoryContactBackend.listContacts()`**

In `src/contacts/contact-service.ts`, replace the `listContacts()` method (lines 1486–1488) with:

```typescript
  async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
    let results = [...this.contacts.values()];

    if (filters?.status) {
      results = results.filter((c) => c.status === filters.status);
    }

    // Sort by createdAt ascending to match Postgres ORDER BY created_at ASC
    results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    if (filters?.limit != null) {
      results = results.slice(0, filters.limit);
    }

    return results;
  }
```

- [ ] **Step 5: Verify the project compiles**

Run: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters tsc --noEmit`

Expected: no type errors. If there are callers of `listContacts()` that pass no arguments, they're still valid because the parameter is optional.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters add src/contacts/contact-service.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters commit -m "feat(contacts): add status and limit filters to listContacts backend"
```

---

### Task 2: Update skill manifest and handler

**Files:**
- Modify: `skills/contact-list/skill.json`
- Modify: `skills/contact-list/handler.ts`

- [ ] **Step 1: Update the skill manifest**

Replace the contents of `skills/contact-list/skill.json` with:

```json
{
  "name": "contact-list",
  "description": "List contacts, optionally filtered by role or status, with optional result limit.",
  "version": "1.1.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "role": "string?",
    "status": "string? (confirmed | provisional | blocked)",
    "limit": "number?"
  },
  "outputs": {
    "contacts": "array",
    "count": "number"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

Changes: description updated, version bumped to 1.1.0, `status` and `limit` inputs added.

- [ ] **Step 2: Update the handler**

Replace the contents of `skills/contact-list/handler.ts` with:

```typescript
// handler.ts — contact-list skill implementation.
//
// Lists contacts, optionally filtered by role or status, with optional result limit.
// Returns an array of contact summaries.
//
// This skill uses contactService, which is a universal service.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ContactStatus } from '../../src/contacts/types.js';

const VALID_STATUSES: readonly string[] = ['confirmed', 'provisional', 'blocked'];

export class ContactListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { role, status, limit } = ctx.input as {
      role?: string;
      status?: string;
      limit?: number;
    };

    // Input validation
    if (role && typeof role === 'string' && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }

    if (status != null && !VALID_STATUSES.includes(status)) {
      return { success: false, error: `Invalid status: "${status}". Must be one of: ${VALID_STATUSES.join(', ')}` };
    }

    if (limit != null) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        return { success: false, error: 'Limit must be a positive integer' };
      }
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-list: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ role: role ?? '(all)', status: status ?? '(all)', limit: limit ?? '(none)' }, 'Listing contacts');

    try {
      // Role filter uses the dedicated findContactByRole path (no change from existing behavior)
      const contacts = role && typeof role === 'string'
        ? await ctx.contactService.findContactByRole(role)
        : await ctx.contactService.listContacts({
            status: status as ContactStatus | undefined,
            limit,
          });

      return {
        success: true,
        data: {
          contacts: contacts.map((c) => ({
            contact_id: c.id,
            display_name: c.displayName,
            role: c.role,
            status: c.status,
            kg_node_id: c.kgNodeId,
          })),
          count: contacts.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, role, status, limit }, 'Failed to list contacts');
      return { success: false, error: `Failed to list contacts: ${message}` };
    }
  }
}
```

Key changes from the original:
- Imports `ContactStatus` type for the cast
- Validates `status` against the allowed enum values
- Validates `limit` is a positive integer
- Passes `{ status, limit }` to `listContacts()` when `role` is not provided
- Adds `status` to the output payload per contact (was missing before — useful for the agent to see)
- Logs the new parameters

- [ ] **Step 3: Verify the project compiles**

Run: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters tsc --noEmit`

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters add skills/contact-list/skill.json skills/contact-list/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters commit -m "feat(contact-list): add status and limit parameters to skill"
```

---

### Task 3: Write tests

**Files:**
- Create: `skills/contact-list/handler.test.ts`

- [ ] **Step 1: Write the test file**

Create `skills/contact-list/handler.test.ts`:

```typescript
// handler.test.ts — tests for contact-list skill.
// Covers: no filters, status filter, limit, status+limit, role (existing),
// invalid status, invalid limit.
import { describe, it, expect, vi } from 'vitest';
import { ContactListHandler } from './handler.js';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import type { Contact } from '../../src/contacts/types.js';
import { createSilentLogger } from '../../src/logger.js';

// Factory for minimal Contact objects — only fields the handler reads
function makeContact(overrides: Partial<Contact> & { id: string; displayName: string }): Contact {
  return {
    kgNodeId: null,
    role: null,
    systemRole: null,
    status: 'confirmed',
    contactConfidence: 0.5,
    trustLevel: null,
    lastSeenAt: null,
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    notes: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const alice = makeContact({ id: 'a1', displayName: 'Alice', status: 'confirmed', createdAt: new Date('2026-01-01') });
const bob = makeContact({ id: 'b2', displayName: 'Bob', status: 'provisional', createdAt: new Date('2026-02-01') });
const carol = makeContact({ id: 'c3', displayName: 'Carol', status: 'provisional', createdAt: new Date('2026-03-01') });
const dave = makeContact({ id: 'd4', displayName: 'Dave', status: 'blocked', createdAt: new Date('2026-04-01') });

const allContacts = [alice, bob, carol, dave];

function makeCtx(input: Record<string, unknown> = {}, contacts: Contact[] = allContacts): SkillContext {
  return {
    input,
    log: createSilentLogger(),
    contactService: {
      listContacts: vi.fn().mockImplementation((filters?: { status?: string; limit?: number }) => {
        let results = [...contacts];
        if (filters?.status) {
          results = results.filter((c) => c.status === filters.status);
        }
        // Sort ascending by createdAt to match real backend
        results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (filters?.limit != null) {
          results = results.slice(0, filters.limit);
        }
        return Promise.resolve(results);
      }),
      findContactByRole: vi.fn().mockResolvedValue([]),
    },
  } as unknown as SkillContext;
}

/** Extract contacts array from a successful result. */
function getContacts(result: SkillResult): Array<{ contact_id: string; display_name: string; status: string }> {
  if (!result.success) throw new Error(`Expected success, got: ${result.error}`);
  return (result.data as { contacts: Array<{ contact_id: string; display_name: string; status: string }> }).contacts;
}

describe('ContactListHandler', () => {
  const handler = new ContactListHandler();

  // --- No filters (existing behavior) ---

  it('returns all contacts when no filters provided', async () => {
    const ctx = makeCtx();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(4);
    expect(ctx.contactService!.listContacts).toHaveBeenCalledWith({
      status: undefined,
      limit: undefined,
    });
  });

  // --- Status filter ---

  it('filters by status=provisional', async () => {
    const ctx = makeCtx({ status: 'provisional' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(2);
    expect(contacts.every((c) => c.status === 'provisional')).toBe(true);
  });

  it('filters by status=confirmed', async () => {
    const ctx = makeCtx({ status: 'confirmed' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].display_name).toBe('Alice');
  });

  it('filters by status=blocked', async () => {
    const ctx = makeCtx({ status: 'blocked' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].display_name).toBe('Dave');
  });

  // --- Limit ---

  it('caps results with limit', async () => {
    const ctx = makeCtx({ limit: 2 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(2);
  });

  it('returns all contacts when limit exceeds total', async () => {
    const ctx = makeCtx({ limit: 100 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(4);
  });

  // --- Status + limit combined ---

  it('filters by status and caps with limit', async () => {
    const ctx = makeCtx({ status: 'provisional', limit: 1 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].status).toBe('provisional');
  });

  // --- Role filter (existing behavior, regression check) ---

  it('uses findContactByRole when role is provided', async () => {
    const cfo = makeContact({ id: 'r1', displayName: 'CFO Person', role: 'CFO' });
    const ctx = makeCtx({ role: 'CFO' }, allContacts);
    (ctx.contactService!.findContactByRole as ReturnType<typeof vi.fn>).mockResolvedValue([cfo]);
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(1);
    expect(getContacts(result)[0].display_name).toBe('CFO Person');
    // Should NOT have called listContacts
    expect(ctx.contactService!.listContacts).not.toHaveBeenCalled();
  });

  // --- Validation ---

  it('rejects invalid status value', async () => {
    const ctx = makeCtx({ status: 'invalid' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid status');
  });

  it('rejects limit of zero', async () => {
    const ctx = makeCtx({ limit: 0 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('rejects negative limit', async () => {
    const ctx = makeCtx({ limit: -5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('rejects non-integer limit', async () => {
    const ctx = makeCtx({ limit: 2.5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('rejects role exceeding 200 characters', async () => {
    const ctx = makeCtx({ role: 'x'.repeat(201) });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('200 characters');
  });

  // --- Output shape ---

  it('includes status field in each contact output', async () => {
    const ctx = makeCtx();
    const result = await handler.execute(ctx);
    const contacts = getContacts(result);
    expect(contacts[0]).toHaveProperty('status');
    expect(contacts[0].status).toBe('confirmed');
  });

  // --- Error handling ---

  it('returns error when contactService throws', async () => {
    const ctx = makeCtx();
    (ctx.contactService!.listContacts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB down'));
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('DB down');
  });

  it('returns error when contactService is missing', async () => {
    const ctx = {
      input: {},
      log: createSilentLogger(),
      contactService: undefined,
    } as unknown as SkillContext;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('contactService not available');
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters vitest run skills/contact-list/handler.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters add skills/contact-list/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters commit -m "test(contact-list): add handler tests for status, limit, and validation"
```

---

### Task 4: Update CHANGELOG and run full test suite

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add CHANGELOG entry**

Add the following under `## [Unreleased]` in the appropriate section (create `### Fixed` if it doesn't exist under Unreleased, or add to existing):

```markdown
### Fixed

- **`contact-list`** — accepts optional `status` and `limit` parameters; contacts agent can now query provisional contacts directly instead of enumerating all contacts through entity-context. (#644)
```

- [ ] **Step 2: Run the full test suite**

Run: `npx --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters vitest run`

Expected: all tests pass, including the new `handler.test.ts` and all existing tests (no regressions).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-list-filters commit -m "docs: add changelog entry for contact-list filters (#644)"
```
