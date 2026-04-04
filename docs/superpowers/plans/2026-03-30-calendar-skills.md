# Calendar Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-agnostic calendar management to Curia via 7 skills pinned to the Coordinator, backed by a Nylas calendar client and a contact-system calendar registry.

**Architecture:** All calendar operations go through a new NylasCalendarClient (sibling to the existing NylasClient for email). Calendar ownership is tracked in a new `contact_calendars` table linked to the contact system. Seven infrastructure skills give the Coordinator CRUD, free/busy, conflict-check, and discovery capabilities.

**Tech Stack:** TypeScript/ESM, Nylas SDK v8, PostgreSQL, Vitest, pino

**Spec:** `docs/superpowers/specs/2026-03-30-calendar-skills-design.md`

---

## File Map

### New Files

| File | Purpose |
|---|---|
| `src/db/migrations/009_create_contact_calendars.sql` | Migration: contact_calendars table |
| `src/channels/calendar/nylas-calendar-client.ts` | Thin wrapper around Nylas SDK calendar endpoints |
| `src/contacts/calendar-types.ts` | Types for ContactCalendar and related interfaces |
| `skills/calendar-list-calendars/skill.json` | Manifest for discovery skill |
| `skills/calendar-list-calendars/handler.ts` | Discovery skill handler |
| `skills/calendar-list-events/skill.json` | Manifest for list-events skill |
| `skills/calendar-list-events/handler.ts` | List-events skill handler |
| `skills/calendar-create-event/skill.json` | Manifest for create-event skill |
| `skills/calendar-create-event/handler.ts` | Create-event skill handler |
| `skills/calendar-update-event/skill.json` | Manifest for update-event skill |
| `skills/calendar-update-event/handler.ts` | Update-event skill handler |
| `skills/calendar-delete-event/skill.json` | Manifest for delete-event skill |
| `skills/calendar-delete-event/handler.ts` | Delete-event skill handler |
| `skills/calendar-find-free-time/skill.json` | Manifest for find-free-time skill |
| `skills/calendar-find-free-time/handler.ts` | Find-free-time skill handler |
| `skills/calendar-check-conflicts/skill.json` | Manifest for check-conflicts skill |
| `skills/calendar-check-conflicts/handler.ts` | Check-conflicts skill handler |
| `tests/unit/channels/nylas-calendar-client.test.ts` | Unit tests for calendar client |
| `tests/unit/contacts/contact-calendar-service.test.ts` | Unit tests for calendar registry methods |
| `tests/unit/skills/calendar-list-calendars.test.ts` | Unit tests for discovery skill |
| `tests/unit/skills/calendar-list-events.test.ts` | Unit tests for list-events skill |
| `tests/unit/skills/calendar-create-event.test.ts` | Unit tests for create-event skill |
| `tests/unit/skills/calendar-update-event.test.ts` | Unit tests for update-event skill |
| `tests/unit/skills/calendar-delete-event.test.ts` | Unit tests for delete-event skill |
| `tests/unit/skills/calendar-find-free-time.test.ts` | Unit tests for find-free-time skill |
| `tests/unit/skills/calendar-check-conflicts.test.ts` | Unit tests for check-conflicts skill |

### Modified Files

| File | Change |
|---|---|
| `src/contacts/types.ts` | Add ContactCalendar interface and CreateCalendarLinkOptions |
| `src/contacts/contact-service.ts` | Add calendar registry methods + backend interface extensions |
| `src/skills/types.ts` | Add `nylasCalendarClient?` to SkillContext |
| `src/skills/execution.ts` | Inject nylasCalendarClient into infrastructure skill context |
| `src/index.ts` | Construct NylasCalendarClient, pass to ExecutionLayer |
| `agents/coordinator.yaml` | Add 7 calendar skills to pinned_skills |

---

## Task 1: Database Migration — contact_calendars Table

**Files:**
- Create: `src/db/migrations/009_create_contact_calendars.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Up Migration

-- Calendar registry: maps Nylas calendar IDs to contacts.
-- A contact can have multiple calendars (work, personal, etc.).
-- Nullable contact_id supports org-wide calendars (holidays, rooms).
CREATE TABLE contact_calendars (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nylas_calendar_id TEXT NOT NULL UNIQUE,
  contact_id        UUID REFERENCES contacts(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  read_only         BOOLEAN NOT NULL DEFAULT false,
  timezone          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one primary calendar per contact.
-- Partial unique index: only rows where is_primary = true participate.
CREATE UNIQUE INDEX idx_contact_calendars_primary
  ON contact_calendars (contact_id) WHERE is_primary = true;

-- Fast lookup by contact for "get calendars for this person" queries.
CREATE INDEX idx_contact_calendars_contact
  ON contact_calendars (contact_id) WHERE contact_id IS NOT NULL;
```

- [ ] **Step 2: Verify migration applies cleanly**

Run: `npx tsx src/index.ts`

Expected: Startup log shows `Database migrations applied` with `009_create_contact_calendars` in the list. The process starts normally. Ctrl+C to exit.

If the database isn't available locally, run: `npx node-pg-migrate up --database-url "$DATABASE_URL" --migrations-dir src/db/migrations`

- [ ] **Step 3: Commit**

```
git add src/db/migrations/009_create_contact_calendars.sql
git commit -m "feat: add contact_calendars migration for calendar registry"
```

---

## Task 2: Calendar Types

**Files:**
- Create: `src/contacts/calendar-types.ts`
- Modify: `src/contacts/types.ts`

- [ ] **Step 1: Create calendar-types.ts**

```typescript
// src/contacts/calendar-types.ts
//
// Types for the calendar registry — maps Nylas calendar IDs to contacts.
// A contact can have multiple calendars (work, personal, etc.).
// Org-wide calendars (holidays, rooms) have null contact_id.

export interface ContactCalendar {
  id: string;
  nylasCalendarId: string;
  contactId: string | null;
  label: string;
  isPrimary: boolean;
  readOnly: boolean;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCalendarLinkOptions {
  nylasCalendarId: string;
  /** null for org-wide calendars (holidays, conference rooms) */
  contactId: string | null;
  label: string;
  isPrimary?: boolean;
  readOnly?: boolean;
  timezone?: string;
}
```

- [ ] **Step 2: Re-export from types.ts**

Add to the end of `src/contacts/types.ts`:

```typescript
// -- Calendar registry types --
export type { ContactCalendar, CreateCalendarLinkOptions } from './calendar-types.js';
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 4: Commit**

```
git add src/contacts/calendar-types.ts src/contacts/types.ts
git commit -m "feat: add ContactCalendar types for calendar registry"
```

---

## Task 3: ContactService Calendar Methods — Tests First

**Files:**
- Create: `tests/unit/contacts/contact-calendar-service.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/contacts/contact-calendar-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import type { Contact } from '../../../src/contacts/types.js';

describe('ContactService — calendar methods', () => {
  let service: ContactService;
  let ceoContact: Contact;

  beforeEach(async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const entityMemory = new EntityMemory(store, validator, embeddingService);
    service = ContactService.createInMemory(entityMemory);

    ceoContact = await service.createContact({
      displayName: 'the CEO',
      role: 'ceo',
      source: 'test',
    });
  });

  describe('linkCalendar', () => {
    it('links a calendar to a contact', async () => {
      const cal = await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      expect(cal.id).toBeDefined();
      expect(cal.nylasCalendarId).toBe('nylas-cal-123');
      expect(cal.contactId).toBe(ceoContact.id);
      expect(cal.label).toBe('Work');
      expect(cal.isPrimary).toBe(false);
      expect(cal.readOnly).toBe(false);
    });

    it('links a calendar with isPrimary flag', async () => {
      const cal = await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });

      expect(cal.isPrimary).toBe(true);
    });

    it('links an org-wide calendar with null contactId', async () => {
      const cal = await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-holidays',
        contactId: null,
        label: 'Company Holidays',
      });

      expect(cal.contactId).toBeNull();
      expect(cal.label).toBe('Company Holidays');
    });

    it('rejects duplicate nylas_calendar_id', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      await expect(
        service.linkCalendar({
          nylasCalendarId: 'nylas-cal-123',
          contactId: ceoContact.id,
          label: 'Duplicate',
        }),
      ).rejects.toThrow();
    });

    it('enforces at most one primary per contact', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-1',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });

      await expect(
        service.linkCalendar({
          nylasCalendarId: 'nylas-cal-2',
          contactId: ceoContact.id,
          label: 'Personal',
          isPrimary: true,
        }),
      ).rejects.toThrow();
    });

    it('rejects link to nonexistent contact', async () => {
      await expect(
        service.linkCalendar({
          nylasCalendarId: 'nylas-cal-999',
          contactId: 'nonexistent-uuid',
          label: 'Ghost',
        }),
      ).rejects.toThrow('Contact not found');
    });
  });

  describe('unlinkCalendar', () => {
    it('removes a calendar association', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      const removed = await service.unlinkCalendar('nylas-cal-123');
      expect(removed).toBe(true);

      const calendars = await service.getCalendarsForContact(ceoContact.id);
      expect(calendars).toHaveLength(0);
    });

    it('returns false for unknown calendar ID', async () => {
      const removed = await service.unlinkCalendar('nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('getCalendarsForContact', () => {
    it('returns all calendars for a contact', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-work',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-personal',
        contactId: ceoContact.id,
        label: 'Personal',
      });

      const calendars = await service.getCalendarsForContact(ceoContact.id);
      expect(calendars).toHaveLength(2);
      expect(calendars.map(c => c.label).sort()).toEqual(['Personal', 'Work']);
    });

    it('returns empty array for contact with no calendars', async () => {
      const calendars = await service.getCalendarsForContact(ceoContact.id);
      expect(calendars).toHaveLength(0);
    });
  });

  describe('resolveCalendar', () => {
    it('returns the contact for a registered calendar', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      const result = await service.resolveCalendar('nylas-cal-123');
      expect(result).toBeDefined();
      expect(result!.contactId).toBe(ceoContact.id);
      expect(result!.label).toBe('Work');
    });

    it('returns null for unregistered calendar', async () => {
      const result = await service.resolveCalendar('unknown-cal');
      expect(result).toBeNull();
    });

    it('returns null contactId for org-wide calendar', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-holidays',
        contactId: null,
        label: 'Company Holidays',
      });

      const result = await service.resolveCalendar('nylas-cal-holidays');
      expect(result).toBeDefined();
      expect(result!.contactId).toBeNull();
      expect(result!.label).toBe('Company Holidays');
    });
  });

  describe('getPrimaryCalendar', () => {
    it('returns the primary calendar for a contact', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-secondary',
        contactId: ceoContact.id,
        label: 'Personal',
      });
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-primary',
        contactId: ceoContact.id,
        label: 'Work',
        isPrimary: true,
      });

      const primary = await service.getPrimaryCalendar(ceoContact.id);
      expect(primary).toBeDefined();
      expect(primary!.nylasCalendarId).toBe('nylas-cal-primary');
      expect(primary!.label).toBe('Work');
    });

    it('returns null when no primary is set', async () => {
      await service.linkCalendar({
        nylasCalendarId: 'nylas-cal-123',
        contactId: ceoContact.id,
        label: 'Work',
      });

      const primary = await service.getPrimaryCalendar(ceoContact.id);
      expect(primary).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/contacts/contact-calendar-service.test.ts`

Expected: Failures — `linkCalendar`, `unlinkCalendar`, `getCalendarsForContact`, `resolveCalendar`, `getPrimaryCalendar` do not exist on ContactService.

- [ ] **Step 3: Commit failing tests**

```
git add tests/unit/contacts/contact-calendar-service.test.ts
git commit -m "test: add failing tests for ContactService calendar methods"
```

---

## Task 4: ContactService Calendar Methods — Implementation

**Files:**
- Modify: `src/contacts/contact-service.ts`

- [ ] **Step 1: Add calendar methods to the backend interface**

At the end of the `ContactServiceBackend` interface (around line 43), add:

```typescript
  createCalendarLink(calendar: import('./calendar-types.js').ContactCalendar): Promise<void>;
  deleteCalendarLink(nylasCalendarId: string): Promise<boolean>;
  getCalendarsForContact(contactId: string): Promise<import('./calendar-types.js').ContactCalendar[]>;
  resolveCalendar(nylasCalendarId: string): Promise<{ contactId: string | null; label: string; isPrimary: boolean; readOnly: boolean } | null>;
  getPrimaryCalendar(contactId: string): Promise<import('./calendar-types.js').ContactCalendar | null>;
```

- [ ] **Step 2: Add imports at the top of contact-service.ts**

Add to the imports from `'./types.js'`:

```typescript
import type { ContactCalendar, CreateCalendarLinkOptions } from './calendar-types.js';
```

- [ ] **Step 3: Add public methods to ContactService class**

After the `revokePermission` method (around line 316), add:

```typescript
  /**
   * Link a calendar to a contact (or null for org-wide calendars).
   * Validates the contact exists (if contactId is non-null) and enforces
   * uniqueness on nylas_calendar_id and at-most-one-primary-per-contact.
   */
  async linkCalendar(options: CreateCalendarLinkOptions): Promise<ContactCalendar> {
    // Validate the contact exists if a contactId is provided
    if (options.contactId !== null) {
      const contact = await this.backend.getContact(options.contactId);
      if (!contact) {
        throw new Error(`Contact not found: ${options.contactId}`);
      }
    }

    const now = new Date();
    const calendar: ContactCalendar = {
      id: randomUUID(),
      nylasCalendarId: options.nylasCalendarId,
      contactId: options.contactId,
      label: options.label,
      isPrimary: options.isPrimary ?? false,
      readOnly: options.readOnly ?? false,
      timezone: options.timezone ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.backend.createCalendarLink(calendar);
    return calendar;
  }

  /** Remove a calendar association by its Nylas calendar ID. */
  async unlinkCalendar(nylasCalendarId: string): Promise<boolean> {
    return this.backend.deleteCalendarLink(nylasCalendarId);
  }

  /** Get all calendars linked to a contact. */
  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    return this.backend.getCalendarsForContact(contactId);
  }

  /** Resolve a Nylas calendar ID to its registry entry. Returns null if unregistered. */
  async resolveCalendar(nylasCalendarId: string): Promise<{ contactId: string | null; label: string; isPrimary: boolean; readOnly: boolean } | null> {
    return this.backend.resolveCalendar(nylasCalendarId);
  }

  /** Get the primary calendar for a contact. Returns null if no primary is set. */
  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    return this.backend.getPrimaryCalendar(contactId);
  }
```

- [ ] **Step 4: Implement calendar methods in InMemoryContactBackend**

Add a new Map and implement the methods at the end of the `InMemoryContactBackend` class:

```typescript
  private calendars = new Map<string, ContactCalendar>();

  async createCalendarLink(calendar: ContactCalendar): Promise<void> {
    // Enforce UNIQUE(nylas_calendar_id)
    for (const existing of this.calendars.values()) {
      if (existing.nylasCalendarId === calendar.nylasCalendarId) {
        throw new Error(`Calendar already registered: ${calendar.nylasCalendarId}`);
      }
    }
    // Enforce at-most-one-primary per contact
    if (calendar.isPrimary && calendar.contactId !== null) {
      for (const existing of this.calendars.values()) {
        if (existing.contactId === calendar.contactId && existing.isPrimary) {
          throw new Error(`Contact ${calendar.contactId} already has a primary calendar`);
        }
      }
    }
    this.calendars.set(calendar.id, calendar);
  }

  async deleteCalendarLink(nylasCalendarId: string): Promise<boolean> {
    for (const [id, cal] of this.calendars) {
      if (cal.nylasCalendarId === nylasCalendarId) {
        this.calendars.delete(id);
        return true;
      }
    }
    return false;
  }

  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    const results: ContactCalendar[] = [];
    for (const cal of this.calendars.values()) {
      if (cal.contactId === contactId) {
        results.push(cal);
      }
    }
    return results;
  }

  async resolveCalendar(nylasCalendarId: string): Promise<{ contactId: string | null; label: string; isPrimary: boolean; readOnly: boolean } | null> {
    for (const cal of this.calendars.values()) {
      if (cal.nylasCalendarId === nylasCalendarId) {
        return {
          contactId: cal.contactId,
          label: cal.label,
          isPrimary: cal.isPrimary,
          readOnly: cal.readOnly,
        };
      }
    }
    return null;
  }

  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    for (const cal of this.calendars.values()) {
      if (cal.contactId === contactId && cal.isPrimary) {
        return cal;
      }
    }
    return null;
  }
```

- [ ] **Step 5: Implement calendar methods in PostgresContactBackend**

Add the methods at the end of the `PostgresContactBackend` class (before the row mapping helpers):

```typescript
  async createCalendarLink(calendar: ContactCalendar): Promise<void> {
    this.logger.debug({ calendarId: calendar.id, nylasCalendarId: calendar.nylasCalendarId }, 'contacts: linking calendar');
    await this.pool.query(
      `INSERT INTO contact_calendars (id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [calendar.id, calendar.nylasCalendarId, calendar.contactId, calendar.label, calendar.isPrimary, calendar.readOnly, calendar.timezone, calendar.createdAt, calendar.updatedAt],
    );
  }

  async deleteCalendarLink(nylasCalendarId: string): Promise<boolean> {
    this.logger.debug({ nylasCalendarId }, 'contacts: unlinking calendar');
    const result = await this.pool.query(
      'DELETE FROM contact_calendars WHERE nylas_calendar_id = $1',
      [nylasCalendarId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getCalendarsForContact(contactId: string): Promise<ContactCalendar[]> {
    const result = await this.pool.query<{
      id: string;
      nylas_calendar_id: string;
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
      timezone: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at
       FROM contact_calendars WHERE contact_id = $1 ORDER BY created_at ASC`,
      [contactId],
    );
    return result.rows.map((row) => this.rowToCalendar(row));
  }

  async resolveCalendar(nylasCalendarId: string): Promise<{ contactId: string | null; label: string; isPrimary: boolean; readOnly: boolean } | null> {
    const result = await this.pool.query<{
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
    }>(
      `SELECT contact_id, label, is_primary, read_only
       FROM contact_calendars WHERE nylas_calendar_id = $1`,
      [nylasCalendarId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      contactId: row.contact_id,
      label: row.label,
      isPrimary: row.is_primary,
      readOnly: row.read_only,
    };
  }

  async getPrimaryCalendar(contactId: string): Promise<ContactCalendar | null> {
    const result = await this.pool.query<{
      id: string;
      nylas_calendar_id: string;
      contact_id: string | null;
      label: string;
      is_primary: boolean;
      read_only: boolean;
      timezone: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, nylas_calendar_id, contact_id, label, is_primary, read_only, timezone, created_at, updated_at
       FROM contact_calendars WHERE contact_id = $1 AND is_primary = true`,
      [contactId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToCalendar(row);
  }
```

- [ ] **Step 6: Add rowToCalendar helper to PostgresContactBackend**

Add after the existing `rowToIdentity` helper:

```typescript
  private rowToCalendar(row: {
    id: string;
    nylas_calendar_id: string;
    contact_id: string | null;
    label: string;
    is_primary: boolean;
    read_only: boolean;
    timezone: string | null;
    created_at: Date;
    updated_at: Date;
  }): ContactCalendar {
    return {
      id: row.id,
      nylasCalendarId: row.nylas_calendar_id,
      contactId: row.contact_id,
      label: row.label,
      isPrimary: row.is_primary,
      readOnly: row.read_only,
      timezone: row.timezone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
```

- [ ] **Step 7: Add ContactCalendar import to PostgresContactBackend**

Add at the top of the file with the other contact type imports:

```typescript
import type { ContactCalendar } from './calendar-types.js';
```

(This import is needed by both the backend methods and the `rowToCalendar` helper.)

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/unit/contacts/contact-calendar-service.test.ts`

Expected: All tests pass.

- [ ] **Step 9: Run the full test suite to verify nothing broke**

Run: `npx vitest run`

Expected: All existing tests still pass.

- [ ] **Step 10: Commit**

```
git add src/contacts/contact-service.ts src/contacts/calendar-types.ts src/contacts/types.ts tests/unit/contacts/contact-calendar-service.test.ts
git commit -m "feat: add calendar registry methods to ContactService"
```

---

## Task 5: NylasCalendarClient — Tests First

**Files:**
- Create: `tests/unit/channels/nylas-calendar-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/channels/nylas-calendar-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';

// We test via the public interface, mocking the Nylas SDK at the instance level.
// The NylasCalendarClient constructor creates a Nylas SDK instance internally,
// so we test by constructing the client and then overriding the internal SDK.
// Since the SDK is a private field, we test through the public methods and
// verify behavior via the mock SDK's method calls.

// For testability, NylasCalendarClient accepts an optional NylasLike override
// (same pattern as the email NylasClient could use, but we add it fresh here).

import { NylasCalendarClient } from '../../../src/channels/calendar/nylas-calendar-client.js';
import type { NylasCalendarLike } from '../../../src/channels/calendar/nylas-calendar-client.js';

const logger = pino({ level: 'silent' });

function makeMockSdk(): NylasCalendarLike {
  return {
    calendars: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      find: vi.fn(),
    },
    events: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
      update: vi.fn().mockResolvedValue({ data: { id: 'evt-1' } }),
      destroy: vi.fn().mockResolvedValue(undefined),
    },
    calendars_free_busy: {
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
  };
}

describe('NylasCalendarClient', () => {
  let client: NylasCalendarClient;
  let sdk: NylasCalendarLike;

  beforeEach(() => {
    sdk = makeMockSdk();
    client = NylasCalendarClient.createWithSdk(sdk, 'grant-123', logger);
  });

  describe('listCalendars', () => {
    it('calls SDK calendars.list with correct grant identifier', async () => {
      await client.listCalendars();

      expect(sdk.calendars.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
      });
    });

    it('returns normalized calendar objects', async () => {
      (sdk.calendars.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{
          id: 'cal-1',
          name: 'Jane Work',
          description: 'Main calendar',
          timezone: 'America/Toronto',
          is_primary: true,
          read_only: false,
          is_owned_by_user: false,
        }],
      });

      const calendars = await client.listCalendars();

      expect(calendars).toHaveLength(1);
      expect(calendars[0]).toEqual({
        id: 'cal-1',
        name: 'Jane Work',
        description: 'Main calendar',
        timezone: 'America/Toronto',
        isPrimary: true,
        readOnly: false,
        isOwnedByUser: false,
      });
    });
  });

  describe('listEvents', () => {
    it('calls SDK events.list with correct params', async () => {
      await client.listEvents('cal-1', '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z');

      expect(sdk.events.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
        queryParams: {
          calendar_id: 'cal-1',
          start: '2026-04-01T00:00:00Z',
          end: '2026-04-02T00:00:00Z',
          limit: 200,
        },
      });
    });
  });

  describe('createEvent', () => {
    it('calls SDK events.create with calendarId and event data', async () => {
      const eventData = {
        title: 'Team Standup',
        start: '2026-04-01T09:00:00Z',
        end: '2026-04-01T09:30:00Z',
      };

      await client.createEvent('cal-1', eventData);

      expect(sdk.events.create).toHaveBeenCalledWith({
        identifier: 'grant-123',
        queryParams: { calendar_id: 'cal-1' },
        requestBody: expect.objectContaining({
          title: 'Team Standup',
        }),
      });
    });
  });

  describe('updateEvent', () => {
    it('calls SDK events.update with eventId and changes', async () => {
      await client.updateEvent('cal-1', 'evt-1', { title: 'Updated' });

      expect(sdk.events.update).toHaveBeenCalledWith({
        identifier: 'grant-123',
        eventId: 'evt-1',
        queryParams: { calendar_id: 'cal-1' },
        requestBody: expect.objectContaining({
          title: 'Updated',
        }),
      });
    });
  });

  describe('deleteEvent', () => {
    it('calls SDK events.destroy with eventId', async () => {
      await client.deleteEvent('cal-1', 'evt-1');

      expect(sdk.events.destroy).toHaveBeenCalledWith({
        identifier: 'grant-123',
        eventId: 'evt-1',
        queryParams: { calendar_id: 'cal-1' },
      });
    });
  });

  describe('getFreeBusy', () => {
    it('calls SDK free-busy endpoint with calendar IDs and time range', async () => {
      await client.getFreeBusy(
        ['cal-1', 'cal-2'],
        '2026-04-01T00:00:00Z',
        '2026-04-02T00:00:00Z',
      );

      expect(sdk.calendars_free_busy.list).toHaveBeenCalledWith({
        identifier: 'grant-123',
        requestBody: {
          start_time: '2026-04-01T00:00:00Z',
          end_time: '2026-04-02T00:00:00Z',
          emails: ['cal-1', 'cal-2'],
        },
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/channels/nylas-calendar-client.test.ts`

Expected: Failure — module not found.

- [ ] **Step 3: Commit failing tests**

```
git add tests/unit/channels/nylas-calendar-client.test.ts
git commit -m "test: add failing tests for NylasCalendarClient"
```

---

## Task 6: NylasCalendarClient — Implementation

**Files:**
- Create: `src/channels/calendar/nylas-calendar-client.ts`

- [ ] **Step 1: Write the client**

```typescript
// src/channels/calendar/nylas-calendar-client.ts
//
// Thin wrapper around the Nylas SDK's calendar endpoints.
// Same constructor pattern as NylasClient (email) — takes apiKey, grantId, logger.
// Uses the same Nylas SDK with the same workaround for CJS type declarations.
//
// Provider-agnostic: works with Google Calendar, Microsoft 365/Outlook, or
// any other provider connected through Nylas.

import NylasDefault from 'nylas';
import type { Logger } from '../../logger.js';

/**
 * Minimal typed interface for the Nylas SDK calendar surface.
 * We only declare the subset we use — keeps the CJS workaround small.
 */
export interface NylasCalendarLike {
  calendars: {
    list(params: {
      identifier: string;
    }): Promise<{ data: NylasRawCalendar[] }>;

    find(params: {
      identifier: string;
      calendarId: string;
    }): Promise<{ data: NylasRawCalendar }>;
  };

  events: {
    list(params: {
      identifier: string;
      queryParams?: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent[] }>;

    create(params: {
      identifier: string;
      queryParams?: Record<string, unknown>;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent }>;

    update(params: {
      identifier: string;
      eventId: string;
      queryParams?: Record<string, unknown>;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: NylasRawEvent }>;

    destroy(params: {
      identifier: string;
      eventId: string;
      queryParams?: Record<string, unknown>;
    }): Promise<void>;
  };

  calendars_free_busy: {
    list(params: {
      identifier: string;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: NylasRawFreeBusy[] }>;
  };
}

// -- Raw Nylas SDK types (subset we use) --

interface NylasRawCalendar {
  id: string;
  name?: string;
  description?: string;
  timezone?: string;
  is_primary?: boolean;
  read_only?: boolean;
  is_owned_by_user?: boolean;
}

interface NylasRawEvent {
  id: string;
  title?: string;
  description?: string;
  location?: string;
  when?: {
    start_time?: number;
    end_time?: number;
    start_date?: string;
    end_date?: string;
    object?: string;
  };
  participants?: Array<{
    email: string;
    name?: string;
    status?: string;
  }>;
  conferencing?: Record<string, unknown>;
  status?: string;
  calendar_id?: string;
  busy?: boolean;
  metadata?: Record<string, string>;
}

interface NylasRawFreeBusy {
  email: string;
  time_slots?: Array<{
    start_time: number;
    end_time: number;
    status: string;
  }>;
}

// -- Normalized types --

export interface NylasCalendar {
  id: string;
  name: string;
  description: string;
  timezone: string;
  isPrimary: boolean;
  readOnly: boolean;
  isOwnedByUser: boolean;
}

export interface NylasCalendarEvent {
  id: string;
  title: string;
  description: string;
  location: string;
  startTime: number | null;
  endTime: number | null;
  startDate: string | null;
  endDate: string | null;
  participants: Array<{ email: string; name: string; status: string }>;
  conferencing: Record<string, unknown> | null;
  status: string;
  calendarId: string;
  busy: boolean;
}

export interface NylasFreeBusyResult {
  email: string;
  timeSlots: Array<{
    startTime: number;
    endTime: number;
    status: string;
  }>;
}

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: Array<{ email: string; name?: string }>;
  conferencing?: Record<string, unknown>;
}

// -- SDK constructor workaround (same as email NylasClient) --

const NylasSDK = NylasDefault as unknown as new (config: { apiKey: string }) => NylasCalendarLike;

// ---------------------------------------------------------------------------
// NylasCalendarClient
// ---------------------------------------------------------------------------

export class NylasCalendarClient {
  private readonly nylas: NylasCalendarLike;
  private readonly grantId: string;
  private readonly log: Logger;

  constructor(apiKey: string, grantId: string, logger: Logger) {
    this.nylas = new NylasSDK({ apiKey });
    this.grantId = grantId;
    this.log = logger.child({ component: 'nylas-calendar-client' });
  }

  /** Create an instance with a pre-built SDK (for testing). */
  static createWithSdk(sdk: NylasCalendarLike, grantId: string, logger: Logger): NylasCalendarClient {
    const instance = Object.create(NylasCalendarClient.prototype) as NylasCalendarClient;
    // Bypass the constructor to inject the mock SDK
    Object.assign(instance, {
      nylas: sdk,
      grantId,
      log: logger.child({ component: 'nylas-calendar-client' }),
    });
    return instance;
  }

  /** List all calendars visible to this grant (owned + shared). */
  async listCalendars(): Promise<NylasCalendar[]> {
    this.log.debug('Listing calendars');
    try {
      const response = await this.nylas.calendars.list({
        identifier: this.grantId,
      });
      return response.data.map((cal) => this.normalizeCalendar(cal));
    } catch (err) {
      this.log.error({ err }, 'Nylas listCalendars failed');
      throw err;
    }
  }

  /** List events for a calendar within a time range. */
  async listEvents(
    calendarId: string,
    timeMin: string,
    timeMax: string,
    opts?: { limit?: number },
  ): Promise<NylasCalendarEvent[]> {
    this.log.debug({ calendarId, timeMin, timeMax }, 'Listing events');
    try {
      const response = await this.nylas.events.list({
        identifier: this.grantId,
        queryParams: {
          calendar_id: calendarId,
          start: timeMin,
          end: timeMax,
          limit: opts?.limit ?? 200,
        },
      });
      return response.data.map((evt) => this.normalizeEvent(evt));
    } catch (err) {
      this.log.error({ err, calendarId }, 'Nylas listEvents failed');
      throw err;
    }
  }

  /** Create a new event on a calendar. */
  async createEvent(calendarId: string, event: CreateEventInput): Promise<NylasCalendarEvent> {
    this.log.debug({ calendarId, title: event.title }, 'Creating event');
    try {
      const requestBody: Record<string, unknown> = {
        title: event.title,
        when: {
          start_time: Math.floor(new Date(event.start).getTime() / 1000),
          end_time: Math.floor(new Date(event.end).getTime() / 1000),
        },
      };
      if (event.description) requestBody.description = event.description;
      if (event.location) requestBody.location = event.location;
      if (event.attendees) {
        requestBody.participants = event.attendees.map((a) => ({
          email: a.email,
          name: a.name ?? '',
        }));
      }
      if (event.conferencing) requestBody.conferencing = event.conferencing;

      const response = await this.nylas.events.create({
        identifier: this.grantId,
        queryParams: { calendar_id: calendarId },
        requestBody,
      });
      return this.normalizeEvent(response.data);
    } catch (err) {
      this.log.error({ err, calendarId }, 'Nylas createEvent failed');
      throw err;
    }
  }

  /** Update an existing event. */
  async updateEvent(
    calendarId: string,
    eventId: string,
    changes: Partial<CreateEventInput>,
  ): Promise<NylasCalendarEvent> {
    this.log.debug({ calendarId, eventId }, 'Updating event');
    try {
      const requestBody: Record<string, unknown> = {};
      if (changes.title !== undefined) requestBody.title = changes.title;
      if (changes.description !== undefined) requestBody.description = changes.description;
      if (changes.location !== undefined) requestBody.location = changes.location;
      if (changes.start !== undefined || changes.end !== undefined) {
        requestBody.when = {
          ...(changes.start ? { start_time: Math.floor(new Date(changes.start).getTime() / 1000) } : {}),
          ...(changes.end ? { end_time: Math.floor(new Date(changes.end).getTime() / 1000) } : {}),
        };
      }
      if (changes.attendees) {
        requestBody.participants = changes.attendees.map((a) => ({
          email: a.email,
          name: a.name ?? '',
        }));
      }
      if (changes.conferencing !== undefined) requestBody.conferencing = changes.conferencing;

      const response = await this.nylas.events.update({
        identifier: this.grantId,
        eventId,
        queryParams: { calendar_id: calendarId },
        requestBody,
      });
      return this.normalizeEvent(response.data);
    } catch (err) {
      this.log.error({ err, calendarId, eventId }, 'Nylas updateEvent failed');
      throw err;
    }
  }

  /** Delete an event. */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    this.log.debug({ calendarId, eventId }, 'Deleting event');
    try {
      await this.nylas.events.destroy({
        identifier: this.grantId,
        eventId,
        queryParams: { calendar_id: calendarId },
      });
    } catch (err) {
      this.log.error({ err, calendarId, eventId }, 'Nylas deleteEvent failed');
      throw err;
    }
  }

  /** Get free/busy data for one or more calendar IDs across a time range. */
  async getFreeBusy(
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ): Promise<NylasFreeBusyResult[]> {
    this.log.debug({ calendarIds, timeMin, timeMax }, 'Getting free/busy');
    try {
      const response = await this.nylas.calendars_free_busy.list({
        identifier: this.grantId,
        requestBody: {
          start_time: timeMin,
          end_time: timeMax,
          emails: calendarIds,
        },
      });
      return response.data.map((fb) => ({
        email: fb.email,
        timeSlots: (fb.time_slots ?? []).map((ts) => ({
          startTime: ts.start_time,
          endTime: ts.end_time,
          status: ts.status,
        })),
      }));
    } catch (err) {
      this.log.error({ err, calendarIds }, 'Nylas getFreeBusy failed');
      throw err;
    }
  }

  // -- Normalizers --

  private normalizeCalendar(cal: NylasRawCalendar): NylasCalendar {
    return {
      id: cal.id,
      name: cal.name ?? '',
      description: cal.description ?? '',
      timezone: cal.timezone ?? '',
      isPrimary: cal.is_primary ?? false,
      readOnly: cal.read_only ?? false,
      isOwnedByUser: cal.is_owned_by_user ?? true,
    };
  }

  private normalizeEvent(evt: NylasRawEvent): NylasCalendarEvent {
    return {
      id: evt.id,
      title: evt.title ?? '',
      description: evt.description ?? '',
      location: evt.location ?? '',
      startTime: evt.when?.start_time ?? null,
      endTime: evt.when?.end_time ?? null,
      startDate: evt.when?.start_date ?? null,
      endDate: evt.when?.end_date ?? null,
      participants: (evt.participants ?? []).map((p) => ({
        email: p.email,
        name: p.name ?? '',
        status: p.status ?? 'noreply',
      })),
      conferencing: evt.conferencing ?? null,
      status: evt.status ?? 'confirmed',
      calendarId: evt.calendar_id ?? '',
      busy: evt.busy ?? true,
    };
  }
}
```

- [ ] **Step 2: Run the calendar client tests**

Run: `npx vitest run tests/unit/channels/nylas-calendar-client.test.ts`

Expected: All tests pass.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```
git add src/channels/calendar/nylas-calendar-client.ts tests/unit/channels/nylas-calendar-client.test.ts
git commit -m "feat: add NylasCalendarClient with calendar API wrapper"
```

---

## Task 7: Wire NylasCalendarClient into Bootstrap and Execution Layer

**Files:**
- Modify: `src/skills/types.ts`
- Modify: `src/skills/execution.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add nylasCalendarClient to SkillContext**

In `src/skills/types.ts`, add after the `entityMemory?` line (around line 94):

```typescript
  /** Nylas calendar client — only available to infrastructure skills.
   *  Provides CRUD operations on calendar events and free/busy queries
   *  via the Nylas unified API (provider-agnostic). */
  nylasCalendarClient?: import('../channels/calendar/nylas-calendar-client.js').NylasCalendarClient;
```

- [ ] **Step 2: Add nylasCalendarClient to ExecutionLayer**

In `src/skills/execution.ts`:

Add the import:
```typescript
import type { NylasCalendarClient } from '../channels/calendar/nylas-calendar-client.js';
```

Add a private field after `private entityMemory?`:
```typescript
  private nylasCalendarClient?: NylasCalendarClient;
```

Add to the constructor options type (the `options?` parameter):
```typescript
nylasCalendarClient?: NylasCalendarClient;
```

Add assignment in the constructor body after `this.entityMemory = options?.entityMemory;`:
```typescript
    this.nylasCalendarClient = options?.nylasCalendarClient;
```

Add injection in the `invoke` method, inside the `if (manifest.infrastructure)` block, after the entityMemory injection:
```typescript
      // nylasCalendarClient is optional — only calendar skills need it
      if (this.nylasCalendarClient) {
        ctx.nylasCalendarClient = this.nylasCalendarClient;
      }
```

- [ ] **Step 3: Construct and wire in index.ts**

In `src/index.ts`, add the import near the other channel imports:
```typescript
import { NylasCalendarClient } from './channels/calendar/nylas-calendar-client.js';
```

After the NylasClient construction (around line 169), add:
```typescript
  // Calendar client — uses the same Nylas credentials as email.
  // Independent instance, no shared state with the email client.
  let nylasCalendarClient: NylasCalendarClient | undefined;
  if (config.nylasApiKey && config.nylasGrantId) {
    nylasCalendarClient = new NylasCalendarClient(config.nylasApiKey, config.nylasGrantId, logger);
    logger.info('Nylas calendar client initialized');
  }
```

Modify the ExecutionLayer constructor call (around line 301) to include `nylasCalendarClient`:
```typescript
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages, schedulerService, entityMemory, agentPersona, nylasCalendarClient });
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```
git add src/skills/types.ts src/skills/execution.ts src/index.ts
git commit -m "feat: wire NylasCalendarClient into execution layer and bootstrap"
```

---

## Task 8: calendar-list-calendars Skill (Discovery)

**Files:**
- Create: `skills/calendar-list-calendars/skill.json`
- Create: `skills/calendar-list-calendars/handler.ts`
- Create: `tests/unit/skills/calendar-list-calendars.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/skills/calendar-list-calendars.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CalendarListCalendarsHandler } from '../../../skills/calendar-list-calendars/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('CalendarListCalendarsHandler', () => {
  const handler = new CalendarListCalendarsHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Calendar not configured');
    }
  });

  it('returns calendars annotated with registry info', async () => {
    const nylasCalendarClient = {
      listCalendars: vi.fn().mockResolvedValue([
        { id: 'cal-1', name: 'CEO Work', description: '', timezone: 'America/Toronto', isPrimary: true, readOnly: false, isOwnedByUser: false },
        { id: 'cal-2', name: 'Holidays', description: 'Company holidays', timezone: 'America/Toronto', isPrimary: false, readOnly: true, isOwnedByUser: false },
      ]),
    };
    const contactService = {
      resolveCalendar: vi.fn()
        .mockResolvedValueOnce({ contactId: 'contact-1', label: 'Work', isPrimary: true, readOnly: false })
        .mockResolvedValueOnce(null),
      getContact: vi.fn().mockResolvedValue({ id: 'contact-1', displayName: 'the CEO' }),
    };

    const result = await handler.execute(makeCtx(
      {},
      { nylasCalendarClient: nylasCalendarClient as never, contactService: contactService as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { calendars: Array<{ id: string; registered: boolean; contactName?: string }> };
      expect(data.calendars).toHaveLength(2);
      expect(data.calendars[0].registered).toBe(true);
      expect(data.calendars[0].contactName).toBe('the CEO');
      expect(data.calendars[1].registered).toBe(false);
    }
  });

  it('handles Nylas API errors gracefully', async () => {
    const nylasCalendarClient = {
      listCalendars: vi.fn().mockRejectedValue(new Error('Nylas 500')),
    };

    const result = await handler.execute(makeCtx(
      {},
      { nylasCalendarClient: nylasCalendarClient as never, contactService: {} as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Nylas 500');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/skills/calendar-list-calendars.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the skill manifest**

```json
{
  "name": "calendar-list-calendars",
  "description": "List all calendars visible to the agent (owned and shared), annotated with which contact each is registered to. Use this to discover new calendars or verify calendar assignments.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {},
  "outputs": {
    "calendars": "array"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

- [ ] **Step 4: Write the handler**

```typescript
// skills/calendar-list-calendars/handler.ts
//
// Lists all calendars visible to the Nylas grant, annotated with
// registration status from the contact system calendar registry.
// Unregistered calendars are flagged so the agent can ask the CEO
// who they belong to.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class CalendarListCalendarsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'calendar-list-calendars requires infrastructure access (contactService)' };
    }

    try {
      const nylasCalendars = await ctx.nylasCalendarClient.listCalendars();

      const calendars = await Promise.all(
        nylasCalendars.map(async (cal) => {
          const registry = await ctx.contactService!.resolveCalendar(cal.id);

          let contactName: string | undefined;
          if (registry?.contactId) {
            const contact = await ctx.contactService!.getContact(registry.contactId);
            contactName = contact?.displayName;
          }

          return {
            id: cal.id,
            name: cal.name,
            description: cal.description,
            timezone: cal.timezone,
            isPrimary: cal.isPrimary,
            readOnly: cal.readOnly,
            isOwnedByUser: cal.isOwnedByUser,
            registered: registry !== null,
            contactId: registry?.contactId ?? null,
            contactName: contactName ?? null,
            registryLabel: registry?.label ?? null,
          };
        }),
      );

      ctx.log.info({ count: calendars.length }, 'Listed calendars');
      return { success: true, data: { calendars } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'Failed to list calendars');
      return { success: false, error: `Failed to list calendars: ${message}` };
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/skills/calendar-list-calendars.test.ts`

Expected: All pass.

- [ ] **Step 6: Commit**

```
git add skills/calendar-list-calendars/ tests/unit/skills/calendar-list-calendars.test.ts
git commit -m "feat: add calendar-list-calendars discovery skill"
```

---

## Task 9: calendar-list-events Skill

**Files:**
- Create: `skills/calendar-list-events/skill.json`
- Create: `skills/calendar-list-events/handler.ts`
- Create: `tests/unit/skills/calendar-list-events.test.ts`

This task follows the same TDD pattern. The test file and skill are the most complex because of client-side filtering.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/skills/calendar-list-events.test.ts
import { describe, it, expect, vi } from 'vitest';
import { CalendarListEventsHandler } from '../../../skills/calendar-list-events/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

const mockEvents = [
  { id: 'evt-1', title: 'Team Standup', description: 'Daily sync', participants: [{ email: 'alice@co.com', name: 'Alice', status: 'accepted' }], startTime: 1000, endTime: 2000, startDate: null, endDate: null, location: '', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true },
  { id: 'evt-2', title: 'Chiropractor', description: 'Appointment at 2pm', participants: [], startTime: 3000, endTime: 4000, startDate: null, endDate: null, location: '123 Main St', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true },
  { id: 'evt-3', title: 'Board Meeting', description: '', participants: [{ email: 'bob@co.com', name: 'Bob', status: 'accepted' }], startTime: 5000, endTime: 6000, startDate: null, endDate: null, location: '', conferencing: null, status: 'confirmed', calendarId: 'cal-1', busy: true },
];

describe('CalendarListEventsHandler', () => {
  const handler = new CalendarListEventsHandler();

  it('returns failure when nylasCalendarClient is not available', async () => {
    const result = await handler.execute(makeCtx({ calendarId: 'cal-1', timeMin: 'a', timeMax: 'b' }));
    expect(result.success).toBe(false);
  });

  it('returns failure when required inputs are missing', async () => {
    const nylasCalendarClient = { listEvents: vi.fn() };
    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('timeMin');
  });

  it('returns all events in range when no filters provided', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: '2026-04-01T00:00:00Z', timeMax: '2026-04-02T00:00:00Z' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: unknown[]; count: number };
      expect(data.events).toHaveLength(3);
      expect(data.count).toBe(3);
    }
  });

  it('filters by query (case-insensitive substring on title)', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', query: 'chiropractor' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }>; count: number };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].id).toBe('evt-2');
    }
  });

  it('filters by query matching description', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', query: 'daily sync' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }> };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].id).toBe('evt-1');
    }
  });

  it('filters by attendeeEmail', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', attendeeEmail: 'bob@co.com' },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: Array<{ id: string }> };
      expect(data.events).toHaveLength(1);
      expect(data.events[0].id).toBe('evt-3');
    }
  });

  it('respects maxResults limit', async () => {
    const nylasCalendarClient = {
      listEvents: vi.fn().mockResolvedValue(mockEvents),
    };

    const result = await handler.execute(makeCtx(
      { calendarId: 'cal-1', timeMin: 'a', timeMax: 'b', maxResults: 2 },
      { nylasCalendarClient: nylasCalendarClient as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { events: unknown[]; count: number };
      expect(data.events).toHaveLength(2);
      expect(data.count).toBe(2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/skills/calendar-list-events.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write the skill manifest**

`skills/calendar-list-events/skill.json`:
```json
{
  "name": "calendar-list-events",
  "description": "Fetch events from a calendar within a date range. Supports filtering by text query (title/description) and attendee email. Use for checking schedules, finding specific appointments, or reviewing upcoming events.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "calendarId": "string",
    "timeMin": "string",
    "timeMax": "string",
    "maxResults": "number?",
    "query": "string?",
    "attendeeEmail": "string?"
  },
  "outputs": {
    "events": "array",
    "count": "number"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

- [ ] **Step 4: Write the handler**

```typescript
// skills/calendar-list-events/handler.ts
//
// Fetches events for a date range from a specific calendar, with optional
// client-side filtering by text query or attendee email.
// Nylas doesn't support server-side text search on event fields, so
// the skill fetches all events in range and filters locally.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class CalendarListEventsHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    if (!ctx.nylasCalendarClient) {
      return { success: false, error: 'Calendar not configured — Nylas credentials missing' };
    }

    const { calendarId, timeMin, timeMax, maxResults, query, attendeeEmail } = ctx.input as {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
      query?: string;
      attendeeEmail?: string;
    };

    if (!calendarId || typeof calendarId !== 'string') {
      return { success: false, error: 'Missing required input: calendarId' };
    }
    if (!timeMin || typeof timeMin !== 'string') {
      return { success: false, error: 'Missing required input: timeMin' };
    }
    if (!timeMax || typeof timeMax !== 'string') {
      return { success: false, error: 'Missing required input: timeMax' };
    }

    try {
      let events = await ctx.nylasCalendarClient.listEvents(calendarId, timeMin, timeMax);

      // Client-side filtering: query matches title or description (case-insensitive)
      if (query && typeof query === 'string') {
        const lowerQuery = query.toLowerCase();
        events = events.filter(
          (evt) =>
            evt.title.toLowerCase().includes(lowerQuery) ||
            evt.description.toLowerCase().includes(lowerQuery),
        );
      }

      // Client-side filtering: attendee email
      if (attendeeEmail && typeof attendeeEmail === 'string') {
        const lowerEmail = attendeeEmail.toLowerCase();
        events = events.filter(
          (evt) => evt.participants.some((p) => p.email.toLowerCase() === lowerEmail),
        );
      }

      // Truncate if maxResults is set
      if (typeof maxResults === 'number' && maxResults > 0) {
        events = events.slice(0, maxResults);
      }

      ctx.log.info({ calendarId, count: events.length }, 'Listed events');
      return { success: true, data: { events, count: events.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, calendarId }, 'Failed to list events');
      return { success: false, error: `Failed to list events: ${message}` };
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/skills/calendar-list-events.test.ts`

Expected: All pass.

- [ ] **Step 6: Commit**

```
git add skills/calendar-list-events/ tests/unit/skills/calendar-list-events.test.ts
git commit -m "feat: add calendar-list-events skill with client-side filtering"
```

---

## Task 10: calendar-create-event Skill

Follow the same TDD pattern. Detailed test + manifest + handler.

- [ ] **Step 1: Write test, manifest, and handler** (full code provided in the task)
- [ ] **Step 2: Run tests, verify pass**
- [ ] **Step 3: Commit**

The handler validates required inputs (`calendarId`, `title`, `start`, `end`), checks the calendar is not read-only via `ctx.contactService.resolveCalendar()`, then calls `ctx.nylasCalendarClient.createEvent()`. The test covers: missing inputs, read-only calendar rejection, successful creation, and Nylas error handling.

> **Implementation note for the agentic worker:** Model this skill on the `calendar-list-events` handler structure. The key difference is the read-only check: before calling `createEvent`, resolve the calendar from the registry and check `readOnly`. If the calendar isn't in the registry, proceed anyway (it might be the agent's own calendar). If it is registered and `readOnly` is true, return `{ success: false, error: "Calendar is read-only" }`.

Manifest: `skills/calendar-create-event/skill.json`
```json
{
  "name": "calendar-create-event",
  "description": "Create a new calendar event with title, time, attendees, and optional description/location/conferencing. Attendees will receive invitation emails automatically.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "calendarId": "string",
    "title": "string",
    "start": "string",
    "end": "string",
    "description": "string?",
    "location": "string?",
    "attendees": "array?",
    "conferencing": "object?",
    "colorId": "string?",
    "reminders": "object?"
  },
  "outputs": {
    "event": "object"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

---

## Task 11: calendar-update-event Skill

Same TDD pattern. The handler validates `calendarId` and `eventId` are present, checks read-only, then calls `updateEvent` with whatever partial fields were provided.

Manifest: `skills/calendar-update-event/skill.json`
```json
{
  "name": "calendar-update-event",
  "description": "Modify an existing calendar event. Supports partial updates — only provide the fields that need changing (title, time, description, location, attendees, conferencing). Attendee changes trigger invitation updates.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "calendarId": "string",
    "eventId": "string",
    "title": "string?",
    "start": "string?",
    "end": "string?",
    "description": "string?",
    "location": "string?",
    "attendees": "array?",
    "conferencing": "object?",
    "colorId": "string?",
    "reminders": "object?"
  },
  "outputs": {
    "event": "object"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

---

## Task 12: calendar-delete-event Skill

Validates `calendarId` and `eventId`, checks read-only, calls `deleteEvent`.

Manifest: `skills/calendar-delete-event/skill.json`
```json
{
  "name": "calendar-delete-event",
  "description": "Delete a calendar event. By default, attendees receive cancellation emails. Set notifyAttendees to false to suppress cancellation notifications.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "calendarId": "string",
    "eventId": "string",
    "notifyAttendees": "boolean?"
  },
  "outputs": {
    "deleted": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

---

## Task 13: calendar-find-free-time Skill

Calls `getFreeBusy`, inverts busy periods to compute free windows. Optional `duration` filter for minimum slot size.

Manifest: `skills/calendar-find-free-time/skill.json`
```json
{
  "name": "calendar-find-free-time",
  "description": "Find available time windows across one or more calendars. Returns free slots within a date range. Use duration (minutes) to filter to slots at least that long. Supports checking multiple people's availability at once.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "calendarIds": "array",
    "timeMin": "string",
    "timeMax": "string",
    "duration": "number?"
  },
  "outputs": {
    "freeWindows": "array"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

---

## Task 14: calendar-check-conflicts Skill

Calls `getFreeBusy` for the proposed time range, returns any busy periods that overlap. Annotates each conflict with the calendar owner's name from the registry.

Manifest: `skills/calendar-check-conflicts/skill.json`
```json
{
  "name": "calendar-check-conflicts",
  "description": "Check whether a proposed time slot conflicts with existing events on one or more calendars. Returns conflicting events with details so you can assess severity (hard conflict vs tentative hold).",
  "version": "1.0.0",
  "sensitivity": "normal",
  "infrastructure": true,
  "inputs": {
    "calendarIds": "array",
    "proposedStart": "string",
    "proposedEnd": "string"
  },
  "outputs": {
    "conflicts": "array",
    "clear": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

---

## Task 15: Add Calendar Skills to Coordinator

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Add calendar skills to pinned_skills**

In `agents/coordinator.yaml`, add these 7 entries to the `pinned_skills` list (after the existing entries, before `allow_discovery`):

```yaml
  - calendar-list-calendars
  - calendar-list-events
  - calendar-create-event
  - calendar-update-event
  - calendar-delete-event
  - calendar-find-free-time
  - calendar-check-conflicts
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```
git add agents/coordinator.yaml
git commit -m "feat: pin calendar skills to coordinator agent"
```

---

## Task 16: Full Test Suite and Final Verification

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`

Expected: No errors.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`

Expected: All tests pass (existing + new).

- [ ] **Step 3: Verify skill loading**

Run: `npx tsx src/index.ts`

Expected: Startup log shows all 7 new calendar skills loaded. Look for `Skills loaded` with a count 7 higher than before. Ctrl+C to exit.

- [ ] **Step 4: Commit any remaining changes**

If any fixes were needed, commit them now.

---

## Notes for the Implementing Engineer

1. **Tasks 10-14 follow the same TDD pattern as Tasks 8-9.** Each has: test file, skill.json, handler.ts. The test file uses `makeCtx()` with mocked `nylasCalendarClient` and `contactService`. The handler validates inputs, checks infrastructure availability, calls the client, and returns structured data.

2. **The Nylas SDK's CJS type workaround** is documented in the existing `nylas-client.ts`. The calendar client uses the same workaround — the `NylasCalendarLike` interface and `NylasSDK` cast are the same pattern.

3. **The free/busy API** in Nylas uses email addresses (not calendar IDs) to identify calendars in some configurations. The `calendarIds` parameter in `find-free-time` and `check-conflicts` may need to be email addresses depending on the Nylas provider configuration. The LLM resolves this at runtime — the skill just passes through what it receives.

4. **Read-only check pattern** for write skills (create, update, delete): call `ctx.contactService.resolveCalendar(calendarId)` — if it returns a result with `readOnly: true`, return `{ success: false, error: "Calendar is read-only" }`. If it returns `null` (unregistered calendar), proceed anyway — the Nylas API will enforce its own permissions.

5. **Do not modify the Coordinator's system prompt.** The skill descriptions in the manifests are sufficient for the LLM to discover and use the skills correctly. The `pinned_skills` list in the YAML is all that's needed.
