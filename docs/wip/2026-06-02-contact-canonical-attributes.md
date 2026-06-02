# Contact Canonical Attributes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 12 canonical profile attributes to the `contacts` table, backfill from KG facts, and expose them via ContactService, HTTP API, and Console UI.

**Architecture:** Migration 048 adds 12 nullable TEXT columns with CHECK constraints. `ContactService` gains `updateContactFields()` which validates `primaryEmail` against `contact_channel_identities` before writing. A standalone `scripts/backfill-contact-attributes.ts` reads KG fact nodes and writes NULL columns only (idempotent). HTTP API exposes all 12 fields on all three contact endpoints. Console UI replaces the Role column with Title + Organization and rewrites the drawer with 6 grouped sections.

**Tech Stack:** PostgreSQL 16+ (node-pg-migrate plain SQL), TypeScript ESM with `tsx`, Vitest, React + TypeScript (Console UI)

---

## File Map

| Action | Path |
|---|---|
| **Create** | `src/db/migrations/048_add_contact_canonical_attributes.sql` |
| **Modify** | `src/contacts/types.ts` |
| **Modify** | `src/contacts/contact-service.ts` |
| **Modify** | `src/channels/http/routes/kg.ts` |
| **Modify** | `apps/console/src/pages/ContactsPage.tsx` |
| **Create** | `scripts/backfill-contact-attributes.ts` |
| **Modify** | `package.json` |
| **Modify** | `tests/unit/contacts/contact-service.test.ts` |
| **Modify** | `tests/integration/contacts.test.ts` |
| **Create** | `scripts/backfill-contact-attributes.test.ts` |

---

## Task 1: Database Migration

**Files:**
- Create: `src/db/migrations/048_add_contact_canonical_attributes.sql`

- [ ] **Step 1: Verify migration numbering**

Run:
```bash
ls src/db/migrations/ | sort | tail -5
```
Expected: `047_create_sessions.sql` is the last file. Confirm `048` is not yet taken.

- [ ] **Step 2: Create the migration file**

Create `src/db/migrations/048_add_contact_canonical_attributes.sql` with:

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

-- Rollback: ALTER TABLE contacts
--   DROP COLUMN preferred_name, DROP COLUMN title, DROP COLUMN organization,
--   DROP COLUMN primary_email, DROP COLUMN primary_phone, DROP COLUMN timezone,
--   DROP COLUMN locale, DROP COLUMN location, DROP COLUMN pronouns,
--   DROP COLUMN linkedin_url, DROP COLUMN bio, DROP COLUMN birthday;
```

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/db/migrations/048_add_contact_canonical_attributes.sql
git -C /path/to/worktree commit -m "feat: migration 048 — add 12 canonical columns to contacts"
```

---

## Task 2: TypeScript Types

**Files:**
- Modify: `src/contacts/types.ts`

- [ ] **Step 1: Add `ContactCanonicalFields` interface and extend `Contact` and `CreateContactOptions`**

In `src/contacts/types.ts`, make three edits:

**Edit 1:** After the `notes: string | null;` line (line 17) in the `Contact` interface, add the 12 new fields:

```typescript
  notes: string | null;
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
  createdAt: Date;
  updatedAt: Date;
```

(Replace the existing `notes: string | null;` through `updatedAt: Date;` block.)

**Edit 2:** Export a new `ContactCanonicalFields` interface. Add it right after the `Contact` interface closing brace:

```typescript
/** Subset of Contact fields that can be written via updateContactFields(). */
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

**Edit 3:** In `CreateContactOptions` (line 72), add the 12 optional canonical fields before the closing brace:

```typescript
  /** If provided, links to this existing KG node. Otherwise auto-creates one. */
  kgNodeId?: string;
  source: string;
  // Canonical profile attributes — optional on create, used by CRM import paths.
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

- [ ] **Step 2: Typecheck**

```bash
pnpm --prefix /path/to/worktree run typecheck
```
Expected: No errors. (The service implementation in Task 4 will satisfy the new `Contact` shape.)

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/contacts/types.ts
git -C /path/to/worktree commit -m "feat: add ContactCanonicalFields type and extend Contact + CreateContactOptions"
```

---

## Task 3: ContactService Unit Tests (write first — they will fail)

**Files:**
- Modify: `tests/unit/contacts/contact-service.test.ts`

- [ ] **Step 1: Add a `describe('canonical fields')` block to the test file**

Append to the bottom of `tests/unit/contacts/contact-service.test.ts` (inside the outer `describe('ContactService')` block):

```typescript
  describe('canonical fields', () => {
    it('createContact stores canonical fields when provided', async () => {
      const contact = await service.createContact({
        displayName: 'Canonical Test',
        source: 'test',
        title: 'VP Engineering',
        organization: 'Acme Corp',
        timezone: 'America/New_York',
        bio: 'A short bio.',
      });
      expect(contact.title).toBe('VP Engineering');
      expect(contact.organization).toBe('Acme Corp');
      expect(contact.timezone).toBe('America/New_York');
      expect(contact.bio).toBe('A short bio.');
      // Unprovided fields default to null
      expect(contact.preferredName).toBeNull();
      expect(contact.primaryEmail).toBeNull();
    });

    it('createContact defaults unprovided canonical fields to null', async () => {
      const contact = await service.createContact({
        displayName: 'No Canonical',
        source: 'test',
      });
      expect(contact.preferredName).toBeNull();
      expect(contact.title).toBeNull();
      expect(contact.organization).toBeNull();
      expect(contact.primaryEmail).toBeNull();
      expect(contact.primaryPhone).toBeNull();
      expect(contact.timezone).toBeNull();
      expect(contact.locale).toBeNull();
      expect(contact.location).toBeNull();
      expect(contact.pronouns).toBeNull();
      expect(contact.linkedinUrl).toBeNull();
      expect(contact.bio).toBeNull();
      expect(contact.birthday).toBeNull();
    });

    it('updateContactFields round-trip: field persists and updatedAt bumps', async () => {
      const contact = await service.createContact({
        displayName: 'Update Test',
        source: 'test',
      });
      const before = contact.updatedAt;

      // Advance time so updatedAt will differ
      await new Promise(r => setTimeout(r, 5));

      const updated = await service.updateContactFields(contact.id, {
        title: 'Director',
        organization: 'Globex',
      });
      expect(updated.title).toBe('Director');
      expect(updated.organization).toBe('Globex');
      expect(updated.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    });

    it('updateContactFields only touches provided fields', async () => {
      const contact = await service.createContact({
        displayName: 'Partial Test',
        source: 'test',
        title: 'CEO',
        organization: 'StartupCo',
        timezone: 'Europe/London',
      });
      const updated = await service.updateContactFields(contact.id, {
        title: 'CTO',
        // organization and timezone NOT provided
      });
      expect(updated.title).toBe('CTO');
      expect(updated.organization).toBe('StartupCo'); // unchanged
      expect(updated.timezone).toBe('Europe/London'); // unchanged
    });

    it('updateContactFields throws when contact not found', async () => {
      await expect(
        service.updateContactFields('non-existent-id', { title: 'X' }),
      ).rejects.toThrow('not found');
    });

    it('updateContactFields with primaryEmail validates against CCI', async () => {
      const contact = await service.createContact({
        displayName: 'Email Test',
        source: 'test',
      });
      // No CCI row exists — should throw
      await expect(
        service.updateContactFields(contact.id, { primaryEmail: 'test@example.com' }),
      ).rejects.toThrow(/not found.*contact_channel_identities|contact_channel_identities.*not found/i);
    });

    it('updateContactFields with primaryEmail succeeds when CCI row exists', async () => {
      const contact = await service.createContact({
        displayName: 'Email Match Test',
        source: 'test',
      });
      // Add the matching CCI row
      await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'match@example.com',
        source: 'ceo_stated',
      });
      // Case-insensitive comparison — provide uppercase
      const updated = await service.updateContactFields(contact.id, {
        primaryEmail: 'MATCH@EXAMPLE.COM',
      });
      // Stored as-is (lowercasing is app responsibility, not enforced here)
      expect(updated.primaryEmail).toBe('MATCH@EXAMPLE.COM');
    });
  });
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
pnpm --prefix /path/to/worktree run test -- tests/unit/contacts/contact-service.test.ts
```
Expected: FAIL — `service.updateContactFields is not a function` or similar, and `contact.title` is undefined.

---

## Task 4: ContactService Implementation

**Files:**
- Modify: `src/contacts/contact-service.ts`

This task touches five areas of the file. Make each edit in order.

### 4a: Add `ContactCanonicalFields` import

- [ ] **Step 1: Update the import from `./types.js`**

In the `import type { ... } from './types.js'` block, add `ContactCanonicalFields`:

```typescript
import type {
  AuthOverride,
  Contact,
  ContactCanonicalFields,
  ContactStatus,
  ChannelIdentity,
  ContactServiceOptions,
  CreateContactOptions,
  DedupConfidence,
  DuplicatePair,
  LinkIdentityOptions,
  MergeGoldenRecord,
  MergeProposal,
  MergeResult,
  ResolvedSender,
  IdentitySource,
  IdentityStatus,
  SystemRole,
  TrustLevel,
} from './types.js';
```

### 4b: Add a shared `ContactRow` type and `CONTACT_COLS` constant

- [ ] **Step 2: Add a `ContactRow` type and `CONTACT_COLS` constant before the `PostgresContactBackend` class**

Insert this block immediately before the `// -- Postgres backend --` comment:

```typescript
// -- Postgres-specific row shape (all 26 columns) --
// Shared across all queries that return a full Contact record.
// The 12 canonical fields (added in migration 048) are always
// null-safe — they default to null when the column was added after
// the row was first written.
type ContactRow = {
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
  // Canonical fields (migration 048)
  preferred_name: string | null;
  title: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedin_url: string | null;
  bio: string | null;
  birthday: string | null;
};

// Column list for all SELECT queries that return a full Contact row.
const CONTACT_COLS =
  'id, kg_node_id, display_name, role, system_role, status, contact_confidence, trust_level, ' +
  'last_seen_at, inbound_message_count, outbound_message_count, notes, created_at, updated_at, ' +
  'preferred_name, title, organization, primary_email, primary_phone, timezone, locale, location, ' +
  'pronouns, linkedin_url, bio, birthday';
```

### 4c: Update `PostgresContactBackend` — SELECT queries + rowToContact

- [ ] **Step 3: Replace `getContact` query to use `ContactRow` and `CONTACT_COLS`**

Replace the entire `getContact` method body:

```typescript
  async getContact(id: string): Promise<Contact | undefined> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return this.rowToContact(row);
  }
```

- [ ] **Step 4: Replace `findContactByName` query**

```typescript
  async findContactByName(name: string): Promise<Contact[]> {
    // Substring match (case-insensitive) so partial names like "Jo" match "Jo Brennan".
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE display_name ILIKE $1`,
      [`%${name}%`],
    );
    return result.rows.map((row) => this.rowToContact(row));
  }
```

- [ ] **Step 5: Replace `findContactByRole` query**

```typescript
  async findContactByRole(role: string): Promise<Contact[]> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE role = $1 ORDER BY created_at ASC`,
      [role],
    );
    return result.rows.map((row) => this.rowToContact(row));
  }
```

- [ ] **Step 6: Replace `findContactBySystemRole` query**

```typescript
  async findContactBySystemRole(systemRole: SystemRole): Promise<Contact | null> {
    const result = await this.pool.query<ContactRow>(
      `SELECT ${CONTACT_COLS} FROM contacts WHERE system_role = $1 LIMIT 1`,
      [systemRole],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToContact(row);
  }
```

- [ ] **Step 7: Replace `listContacts` to use `CONTACT_COLS`**

Replace the body of `listContacts`. The key change is replacing the `cols` variable with `CONTACT_COLS` and updating the query type:

```typescript
  async listContacts(filters?: { status?: ContactStatus; limit?: number }): Promise<Contact[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status != null) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT ${CONTACT_COLS} FROM contacts${where} ORDER BY created_at ASC`;

    if (filters?.limit != null) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const result = await this.pool.query<ContactRow>(sql, params);
    return result.rows.map((row) => this.rowToContact(row));
  }
```

- [ ] **Step 8: Update `rowToContact` to map all 26 columns**

Replace the entire `rowToContact` private method with:

```typescript
  private rowToContact(row: ContactRow): Contact {
    return {
      id: row.id,
      kgNodeId: row.kg_node_id,
      displayName: row.display_name,
      role: row.role,
      systemRole: (row.system_role === 'principal' || row.system_role === 'agent' || row.system_role === 'system')
        ? row.system_role
        : null,
      status: row.status as ContactStatus,
      contactConfidence: (() => {
        const v = parseFloat(row.contact_confidence);
        return isFinite(v) ? v : 0.0;
      })(),
      trustLevel: (Object.keys(TRUST_RANK) as TrustLevel[]).includes(row.trust_level as TrustLevel)
        ? row.trust_level as TrustLevel
        : null,
      lastSeenAt: row.last_seen_at,
      inboundMessageCount: parseInt(row.inbound_message_count, 10) || 0,
      outboundMessageCount: parseInt(row.outbound_message_count, 10) || 0,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // Canonical fields (migration 048)
      preferredName: row.preferred_name,
      title: row.title,
      organization: row.organization,
      primaryEmail: row.primary_email,
      primaryPhone: row.primary_phone,
      timezone: row.timezone,
      locale: row.locale,
      location: row.location,
      pronouns: row.pronouns,
      linkedinUrl: row.linkedin_url,
      bio: row.bio,
      birthday: row.birthday,
    };
  }
```

### 4d: Update Postgres `createContact` and `updateContact`

- [ ] **Step 9: Update `PostgresContactBackend.createContact` INSERT**

Replace the `createContact` method body in the Postgres backend class:

```typescript
  async createContact(contact: Contact): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: creating contact');
    await this.pool.query(
      `INSERT INTO contacts (
         id, kg_node_id, display_name, role, system_role, status, notes, created_at, updated_at,
         preferred_name, title, organization, primary_email, primary_phone, timezone, locale,
         location, pronouns, linkedin_url, bio, birthday
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.systemRole,
        contact.status, contact.notes, contact.createdAt, contact.updatedAt,
        contact.preferredName, contact.title, contact.organization, contact.primaryEmail,
        contact.primaryPhone, contact.timezone, contact.locale, contact.location,
        contact.pronouns, contact.linkedinUrl, contact.bio, contact.birthday,
      ],
    );
  }
```

- [ ] **Step 10: Update `PostgresContactBackend.updateContact` SET clause**

Replace the `updateContact` method body in the Postgres backend class:

```typescript
  async updateContact(contact: Contact): Promise<void> {
    this.logger.debug({ contactId: contact.id }, 'contacts: updating contact');
    await this.pool.query(
      `UPDATE contacts SET
         kg_node_id = $2, display_name = $3, role = $4, system_role = $5, status = $6,
         notes = $7, trust_level = $8, updated_at = $9,
         preferred_name = $10, title = $11, organization = $12, primary_email = $13,
         primary_phone = $14, timezone = $15, locale = $16, location = $17,
         pronouns = $18, linkedin_url = $19, bio = $20, birthday = $21
       WHERE id = $1`,
      [
        contact.id, contact.kgNodeId, contact.displayName, contact.role, contact.systemRole,
        contact.status, contact.notes, contact.trustLevel, contact.updatedAt,
        contact.preferredName, contact.title, contact.organization, contact.primaryEmail,
        contact.primaryPhone, contact.timezone, contact.locale, contact.location,
        contact.pronouns, contact.linkedinUrl, contact.bio, contact.birthday,
      ],
    );
  }
```

### 4e: Update `ContactService.createContact` and add `updateContactFields`

- [ ] **Step 11: Spread canonical fields in `ContactService.createContact`**

In `ContactService.createContact`, replace the `const contact: Contact = { ... }` object literal. Add the 12 canonical fields after `notes`:

```typescript
    const contact: Contact = {
      id: randomUUID(),
      kgNodeId,
      displayName: safeName,
      role: options.role ?? null,
      systemRole: null,
      status: options.status ?? 'confirmed',
      contactConfidence: 0,
      trustLevel: null,
      lastSeenAt: null,
      inboundMessageCount: 0,
      outboundMessageCount: 0,
      notes: options.notes ?? null,
      createdAt: now,
      updatedAt: now,
      // Canonical fields (migration 048)
      preferredName: options.preferredName ?? null,
      title: options.title ?? null,
      organization: options.organization ?? null,
      primaryEmail: options.primaryEmail ?? null,
      primaryPhone: options.primaryPhone ?? null,
      timezone: options.timezone ?? null,
      locale: options.locale ?? null,
      location: options.location ?? null,
      pronouns: options.pronouns ?? null,
      linkedinUrl: options.linkedinUrl ?? null,
      bio: options.bio ?? null,
      birthday: options.birthday ?? null,
    };
```

- [ ] **Step 12: Add `updateContactFields` public method to `ContactService`**

Add this method immediately after the `setStatus` method (around line 560), before `promoteToConfirmed`:

```typescript
  /**
   * Update canonical profile attributes on a contact.
   *
   * Only fields present in `fields` are changed — absent keys leave the current
   * value untouched. If `fields.primaryEmail` is non-null, validates that the
   * email exists in `contact_channel_identities` for this contact (channel = 'email'),
   * case-insensitively. Throws with a descriptive message if not found.
   */
  async updateContactFields(
    contactId: string,
    fields: ContactCanonicalFields,
  ): Promise<Contact> {
    const contact = await this.backend.getContact(contactId);
    if (!contact) {
      throw new Error(`Contact not found: ${contactId}`);
    }

    // Validate primaryEmail against channel identities before writing.
    if (fields.primaryEmail != null) {
      const identities = await this.backend.getIdentitiesForContact(contactId);
      const emailLower = fields.primaryEmail.toLowerCase();
      const match = identities.find(
        (i) => i.channel === 'email' && i.channelIdentifier.toLowerCase() === emailLower,
      );
      if (!match) {
        throw new Error(
          `primaryEmail '${fields.primaryEmail}' not found in contact_channel_identities for contact ${contactId}`,
        );
      }
    }

    const updated: Contact = {
      ...contact,
      ...fields,
      updatedAt: new Date(),
    };

    return this.updateStoredContact(updated);
  }
```

- [ ] **Step 13: Run unit tests — all canonical field tests should pass**

```bash
pnpm --prefix /path/to/worktree run test -- tests/unit/contacts/contact-service.test.ts
```
Expected: All tests PASS including the new `describe('canonical fields')` block.

- [ ] **Step 14: Commit**

```bash
git -C /path/to/worktree add src/contacts/contact-service.ts
git -C /path/to/worktree commit -m "feat: ContactService canonical fields — SELECT lists, INSERT/UPDATE, updateContactFields()"
```

---

## Task 5: HTTP API Integration Tests (write first — they will fail)

**Files:**
- Modify: `tests/integration/contacts.test.ts`

The integration test file uses a real Postgres pool and requires `DATABASE_URL` in the environment. Tests are skipped when `DATABASE_URL` is unset.

- [ ] **Step 1: Add HTTP API canonical field tests**

Append a new `describe` block to `tests/integration/contacts.test.ts`. This block tests the HTTP API directly against a real DB via the service (not via Fastify — that integration is in a separate HTTP test suite). For these tests we verify the service layer behavior that the HTTP routes depend on.

Add these tests inside the existing `describeIf('Contacts Integration', ...)` block:

```typescript
  describe('canonical fields — service layer', () => {
    it('createContact stores and retrieves canonical fields', async () => {
      const contact = await contactService.createContact({
        displayName: 'Integration Canonical',
        source: 'integration-test',
        title: 'Principal Engineer',
        organization: 'Acme Corp',
        timezone: 'America/Chicago',
        bio: 'Integration bio.',
      });

      const fetched = await contactService.getContact(contact.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('Principal Engineer');
      expect(fetched!.organization).toBe('Acme Corp');
      expect(fetched!.timezone).toBe('America/Chicago');
      expect(fetched!.bio).toBe('Integration bio.');
    });

    it('updateContactFields round-trips through Postgres', async () => {
      const contact = await contactService.createContact({
        displayName: 'Update Integration',
        source: 'integration-test',
      });

      const updated = await contactService.updateContactFields(contact.id, {
        title: 'Senior Engineer',
        linkedinUrl: 'https://linkedin.com/in/testperson',
        birthday: '1990-04-15',
      });

      const fetched = await contactService.getContact(updated.id);
      expect(fetched!.title).toBe('Senior Engineer');
      expect(fetched!.linkedinUrl).toBe('https://linkedin.com/in/testperson');
      expect(fetched!.birthday).toBe('1990-04-15');
    });

    it('listContacts returns canonical fields for all contacts', async () => {
      const contact = await contactService.createContact({
        displayName: 'List Canonical',
        source: 'integration-test',
        organization: 'TestOrg',
      });

      const all = await contactService.listContacts();
      const found = all.find(c => c.id === contact.id);
      expect(found).toBeDefined();
      expect(found!.organization).toBe('TestOrg');
      // Unprovided fields are null
      expect(found!.preferredName).toBeNull();
    });

    it('updateContactFields primaryEmail validation rejects unknown email', async () => {
      const contact = await contactService.createContact({
        displayName: 'Email Reject',
        source: 'integration-test',
      });
      await expect(
        contactService.updateContactFields(contact.id, { primaryEmail: 'nobody@example.com' }),
      ).rejects.toThrow(/not found.*contact_channel_identities|contact_channel_identities.*not found/i);
    });

    it('updateContactFields primaryEmail accepts email that exists in CCI', async () => {
      const contact = await contactService.createContact({
        displayName: 'Email Accept',
        source: 'integration-test',
      });
      await contactService.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'cci-test@example.com',
        source: 'ceo_stated',
      });
      const updated = await contactService.updateContactFields(contact.id, {
        primaryEmail: 'CCI-TEST@EXAMPLE.COM',
      });
      expect(updated.primaryEmail).toBe('CCI-TEST@EXAMPLE.COM');
    });
  });
```

- [ ] **Step 2: Run integration tests — confirm new tests fail or are skipped (if no DB)**

```bash
pnpm --prefix /path/to/worktree run test -- tests/integration/contacts.test.ts
```
Expected: Tests pass if `DATABASE_URL` is set and migration 048 has been applied. Skipped if `DATABASE_URL` unset.

---

## Task 6: HTTP API Implementation

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

The three contact endpoints need updating. Make edits in the order below.

### 6a: Helpers

- [ ] **Step 1: Add a `serializeContact` helper near the top of the kg.ts contact section**

Find the `GET /api/kg/contacts` handler. Just before it, add a local helper function:

```typescript
  // Serialize a Contact object to the HTTP response shape.
  // Returns all canonical fields so the Console UI can display them
  // without a separate detail fetch.
  function serializeContact(c: Contact) {
    return {
      id: c.id,
      kgNodeId: c.kgNodeId,
      displayName: c.displayName,
      role: c.role,
      status: c.status,
      trustLevel: c.trustLevel,
      systemRole: c.systemRole,
      notes: c.notes,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      // Canonical fields (migration 048)
      preferredName: c.preferredName,
      title: c.title,
      organization: c.organization,
      primaryEmail: c.primaryEmail,
      primaryPhone: c.primaryPhone,
      timezone: c.timezone,
      locale: c.locale,
      location: c.location,
      pronouns: c.pronouns,
      linkedinUrl: c.linkedinUrl,
      bio: c.bio,
      birthday: c.birthday,
    };
  }
```

(You'll also need to import `Contact` from contacts/types — check whether it's already imported in this file, and add it to the import if not.)

### 6b: Validation helper

- [ ] **Step 2: Add a `validateCanonicalFields` helper**

Add this function in the same local scope, after `serializeContact`:

```typescript
  // Validate canonical fields from a POST/PATCH body.
  // Returns an error string if invalid, or null if all checks pass.
  // `fields` entries are trimmed and empty-string-coerced to null.
  function extractAndValidateCanonicalFields(body: Record<string, unknown>): {
    error: string | null;
    fields: import('../../../contacts/types.js').ContactCanonicalFields;
  } {
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

    const fields: import('../../../contacts/types.js').ContactCanonicalFields = {};

    if ('preferredName' in body) fields.preferredName = str(body.preferredName);
    if ('title' in body) fields.title = str(body.title);
    if ('organization' in body) fields.organization = str(body.organization);
    if ('primaryPhone' in body) fields.primaryPhone = str(body.primaryPhone);
    if ('timezone' in body) fields.timezone = str(body.timezone);
    if ('locale' in body) fields.locale = str(body.locale);
    if ('location' in body) fields.location = str(body.location);
    if ('pronouns' in body) fields.pronouns = str(body.pronouns);
    if ('birthday' in body) fields.birthday = str(body.birthday);
    if ('linkedinUrl' in body) fields.linkedinUrl = str(body.linkedinUrl);
    if ('bio' in body) fields.bio = str(body.bio);
    if ('primaryEmail' in body) fields.primaryEmail = str(body.primaryEmail);

    // Format validation
    if (fields.primaryEmail != null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.primaryEmail)) {
      return { error: 'Invalid primaryEmail format.', fields };
    }
    if (fields.linkedinUrl != null && !/^https?:\/\//.test(fields.linkedinUrl)) {
      return { error: 'linkedinUrl must start with http:// or https://.', fields };
    }
    if (fields.bio != null && fields.bio.length > 500) {
      return { error: 'bio must be 500 characters or fewer.', fields };
    }
    if (fields.birthday != null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(fields.birthday) &&
        !/^--\d{2}-\d{2}$/.test(fields.birthday)) {
      return { error: 'birthday must be YYYY-MM-DD or --MM-DD.', fields };
    }

    return { error: null, fields };
  }
```

### 6c: Update GET endpoint

- [ ] **Step 3: Replace the GET /api/kg/contacts response to use `serializeContact`**

Find the GET handler body:
```typescript
      return reply.send({
        contacts: contacts.map((contact) => ({
          id: contact.id,
          ...
        })),
      });
```

Replace the map with:
```typescript
      return reply.send({
        contacts: contacts.map(serializeContact),
      });
```

### 6d: Update POST endpoint

- [ ] **Step 4: Update POST /api/kg/contacts to extract + validate canonical fields**

In the POST handler, after the existing `displayName` / `status` / `trustLevel` / `kgNodeId` validation block, add:

```typescript
    const { error: canonicalError, fields: canonicalFields } = extractAndValidateCanonicalFields(body as Record<string, unknown>);
    if (canonicalError) {
      return reply.status(400).send({ error: canonicalError });
    }
```

Then update the `createContact` call to spread the canonical fields:

```typescript
    const created = await contactService.createContact({
      displayName: body.displayName,
      role: typeof body.role === 'string' && body.role.trim().length > 0 ? body.role : undefined,
      status: status as ContactStatus,
      notes: typeof body.notes === 'string' && body.notes.trim().length > 0 ? body.notes : undefined,
      kgNodeId,
      source: 'kg_web_ui',
      ...canonicalFields,
    });
```

Replace the final `return reply.status(201).send(...)` to use `serializeContact`:

```typescript
    return reply.status(201).send({ contact: serializeContact(freshCreated) });
```

### 6e: Update PATCH endpoint

- [ ] **Step 5: Update PATCH /api/kg/contacts/:id to handle canonical fields**

In the PATCH handler, after the existing `kgNodeId` / `displayName` validation block, add the canonical fields extraction:

```typescript
    const { error: canonicalError, fields: canonicalFields } = extractAndValidateCanonicalFields(body as Record<string, unknown>);
    if (canonicalError) {
      return reply.status(400).send({ error: canonicalError });
    }
```

After all the existing mutations (`displayName`, `role`, `status`, `trustLevel`, `notes`, `kgNodeId`), add a call to `updateContactFields` if any canonical fields were present in the body:

```typescript
    // Apply canonical fields if any were included in the request body.
    const CANONICAL_KEYS: Array<keyof typeof canonicalFields> = [
      'preferredName', 'title', 'organization', 'primaryEmail', 'primaryPhone',
      'timezone', 'locale', 'location', 'pronouns', 'linkedinUrl', 'bio', 'birthday',
    ];
    const hasCanonicalFields = CANONICAL_KEYS.some(k => k in (body as Record<string, unknown>));
    if (hasCanonicalFields) {
      try {
        await contactService.updateContactFields(id, canonicalFields);
      } catch (err) {
        // updateContactFields throws for primaryEmail CCI mismatch
        return reply.status(400).send({ error: (err as Error).message });
      }
    }
```

Replace the final response to use `serializeContact`:

```typescript
    const updated = await contactService.getContact(id);
    if (!updated) {
      return reply.status(404).send({ error: 'Contact not found after update.' });
    }
    return reply.send({ contact: serializeContact(updated) });
```

- [ ] **Step 6: Run typecheck**

```bash
pnpm --prefix /path/to/worktree run typecheck
```
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git -C /path/to/worktree add src/channels/http/routes/kg.ts
git -C /path/to/worktree commit -m "feat: HTTP API exposes canonical fields on GET/POST/PATCH contacts"
```

---

## Task 7: Console UI

**Files:**
- Modify: `apps/console/src/pages/ContactsPage.tsx`

### 7a: Widen `Contact` interface

- [ ] **Step 1: Add 12 new nullable string fields to the local `Contact` interface**

Replace the current `Contact` interface (lines 14–25) with:

```typescript
interface Contact {
  id: string;
  kgNodeId: string | null;
  displayName: string;
  role: string | null;
  status: ContactStatus;
  notes: string | null;
  trustLevel: TrustLevel;
  systemRole: SystemRole;
  createdAt: string;
  updatedAt: string;
  // Canonical fields (migration 048)
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
}
```

### 7b: Replace Role column with Title + Organization in the table

- [ ] **Step 2: Update the table header — replace `Role` with `Title` and `Organization`**

Find the thead row. Replace the `Role` `<th>`:
```tsx
                          <th className="sortable" aria-sort={sort.key === 'role' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('role')}>
                              Role <span className="sort-arrow">{sortArrow('role')}</span>
                            </button>
                          </th>
```

with:
```tsx
                          <th className="sortable" aria-sort={sort.key === 'title' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('title')}>
                              Title <span className="sort-arrow">{sortArrow('title')}</span>
                            </button>
                          </th>
                          <th className="sortable" aria-sort={sort.key === 'organization' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                            <button className="sort-btn" onClick={() => toggleSort('organization')}>
                              Org <span className="sort-arrow">{sortArrow('organization')}</span>
                            </button>
                          </th>
```

Also update the `colSpan` on the empty-state `<td>` from `5` to `6`.

- [ ] **Step 3: Update the table body — replace `{c.role ?? ''}` with Title + Org cells**

Find the tbody row. Replace:
```tsx
                            <td>{c.role ?? ''}</td>
```

with:
```tsx
                            <td>{c.title ?? ''}</td>
                            <td>{c.organization ?? ''}</td>
```

### 7c: Rewrite the drawer with 6 sections

- [ ] **Step 4: Add state variables for the 12 new fields in `ContactEditDrawer`**

In the `ContactEditDrawer` function, after the existing `useState` declarations, add:

```typescript
  const [preferredName, setPreferredName] = useState(contact?.preferredName ?? '');
  const [pronouns, setPronouns] = useState(contact?.pronouns ?? '');
  const [title, setTitle] = useState(contact?.title ?? '');
  const [organization, setOrganization] = useState(contact?.organization ?? '');
  const [primaryEmail, setPrimaryEmail] = useState(contact?.primaryEmail ?? '');
  const [primaryPhone, setPrimaryPhone] = useState(contact?.primaryPhone ?? '');
  const [timezone, setTimezone] = useState(contact?.timezone ?? '');
  const [locale, setLocale] = useState(contact?.locale ?? '');
  const [location, setLocation] = useState(contact?.location ?? '');
  const [linkedinUrl, setLinkedinUrl] = useState(contact?.linkedinUrl ?? '');
  const [bio, setBio] = useState(contact?.bio ?? '');
  const [birthday, setBirthday] = useState(contact?.birthday ?? '');
```

- [ ] **Step 5: Update `handleSave` to include canonical fields in the request body**

Replace the `const body = { ... }` block inside `handleSave`:

```typescript
      const body = {
        displayName: displayName.trim(),
        role: role.trim() || null,
        status,
        trustLevel: trustLevel ?? null,
        notes: notes.trim() || null,
        kgNodeId: kgNodeId.trim() || null,
        // Canonical fields
        preferredName: preferredName.trim() || null,
        pronouns: pronouns.trim() || null,
        title: title.trim() || null,
        organization: organization.trim() || null,
        primaryEmail: primaryEmail.trim() || null,
        primaryPhone: primaryPhone.trim() || null,
        timezone: timezone.trim() || null,
        locale: locale.trim() || null,
        location: location.trim() || null,
        linkedinUrl: linkedinUrl.trim() || null,
        bio: bio.trim() || null,
        birthday: birthday.trim() || null,
      };
```

- [ ] **Step 6: Replace the drawer form body with 6 grouped sections**

Replace the entire `<div className="drawer-body"> ... </div>` block with:

```tsx
      <div className="drawer-body">
        <div className="edit-drawer-form">
          {error && <p style={{ color: 'var(--app-destructive)', margin: 0, fontSize: 13 }}>{error}</p>}

          {/* Section: Identity */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '0 0 6px' }}>Identity</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-name">Display name</label>
              <input id="cf-name" type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-preferred-name">Preferred name</label>
              <input id="cf-preferred-name" type="text" value={preferredName} onChange={e => setPreferredName(e.target.value)} placeholder="Nickname or short form" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-pronouns">Pronouns</label>
              <input id="cf-pronouns" type="text" value={pronouns} onChange={e => setPronouns(e.target.value)} placeholder="they/them" />
            </div>
          </div>

          {/* Section: Work */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Work</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-role">Role</label>
              <input id="cf-role" type="text" value={role} onChange={e => setRole(e.target.value)} placeholder="Internal role label" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-title">Title</label>
              <input id="cf-title" type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Current job title" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-org">Organization</label>
              <input id="cf-org" type="text" value={organization} onChange={e => setOrganization(e.target.value)} placeholder="Employer" />
            </div>
          </div>

          {/* Section: Contact info */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Contact info</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-email">Primary email</label>
              <input id="cf-email" type="text" value={primaryEmail} onChange={e => setPrimaryEmail(e.target.value)} placeholder="Lowercased on save" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-phone">Primary phone</label>
              <input id="cf-phone" type="text" value={primaryPhone} onChange={e => setPrimaryPhone(e.target.value)} placeholder="+1 555 000 0000" />
            </div>
          </div>

          {/* Section: Location & locale */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Location &amp; locale</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-tz">Timezone</label>
              <input id="cf-tz" type="text" value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="America/New_York" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-locale">Locale</label>
              <input id="cf-locale" type="text" value={locale} onChange={e => setLocale(e.target.value)} placeholder="en-US" />
            </div>
            <div className="form-field">
              <label htmlFor="cf-location">Location</label>
              <input id="cf-location" type="text" value={location} onChange={e => setLocation(e.target.value)} placeholder="City, region" />
            </div>
          </div>

          {/* Section: Links & bio */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>Links &amp; bio</p>
          <div className="form-field">
            <label htmlFor="cf-linkedin">LinkedIn URL</label>
            <input id="cf-linkedin" type="text" value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)} placeholder="https://linkedin.com/in/…" />
          </div>
          <div className="form-field">
            <label htmlFor="cf-bio">Bio</label>
            <textarea id="cf-bio" rows={3} value={bio} onChange={e => setBio(e.target.value)} placeholder="Short narrative (max 500 chars)" />
          </div>
          <div className="form-field">
            <label htmlFor="cf-birthday">Birthday</label>
            <input id="cf-birthday" type="text" value={birthday} onChange={e => setBirthday(e.target.value)} placeholder="YYYY-MM-DD or --MM-DD" />
          </div>

          {/* Section: System */}
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--app-fg-muted)', margin: '16px 0 6px' }}>System</p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="cf-status">Status</label>
              <select id="cf-status" value={status} onChange={e => setStatus(e.target.value as ContactStatus)}>
                <option value="confirmed">Confirmed</option>
                <option value="provisional">Provisional</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="cf-trust">Trust level</label>
              <select id="cf-trust" value={trustLevel ?? ''} onChange={e => setTrustLevel((e.target.value || null) as TrustLevel)}>
                <option value="">None</option>
                <option value="ceo">CEO</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="cf-kg">KG node ID</label>
            <input id="cf-kg" type="text" value={kgNodeId} onChange={e => setKgNodeId(e.target.value)} placeholder="UUID — optional" />
          </div>
          <div className="form-field">
            <label htmlFor="cf-notes">Notes</label>
            <textarea id="cf-notes" rows={4} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>
      </div>
```

- [ ] **Step 7: Run Console TypeScript typecheck**

```bash
pnpm --prefix /path/to/worktree/apps/console run typecheck
```
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git -C /path/to/worktree add apps/console/src/pages/ContactsPage.tsx
git -C /path/to/worktree commit -m "feat: Console UI — Title+Org table columns, 6-section canonical drawer"
```

---

## Task 8: Backfill Script Tests (write first — they will fail)

**Files:**
- Create: `scripts/backfill-contact-attributes.test.ts`

The backfill script will export a testable `runBackfill(pool)` function. These tests mock the pool's `query` method.

- [ ] **Step 1: Create the test file**

Create `scripts/backfill-contact-attributes.test.ts`:

```typescript
// scripts/backfill-contact-attributes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { runBackfill } from './backfill-contact-attributes.js';

// A minimal pool mock: query() returns different results based on which call it is.
function makeMockPool(queryResponses: Array<{ rows: Record<string, unknown>[] }>): Pool {
  let callIndex = 0;
  return {
    query: vi.fn(() => {
      const response = queryResponses[callIndex++] ?? { rows: [] };
      return Promise.resolve(response);
    }),
  } as unknown as Pool;
}

describe('runBackfill', () => {
  it('skips contacts with no kg_node_id', async () => {
    const pool = makeMockPool([
      // contacts query: returns one contact with null kg_node_id
      { rows: [{ id: 'c1', kg_node_id: null, system_role: null }] },
    ]);

    const result = await runBackfill(pool);
    expect(result.processed).toBe(0);
    expect(result.written).toBe(0);
  });

  it('populates columns from matching KG fact nodes', async () => {
    const updateMock = vi.fn().mockResolvedValue({ rows: [] });
    const pool = {
      query: vi.fn()
        // Call 1: contacts with kg_node_id
        .mockResolvedValueOnce({
          rows: [{ id: 'c1', kg_node_id: 'kg1', system_role: null,
                   preferred_name: null, title: null, organization: null,
                   primary_email: null, primary_phone: null, timezone: null,
                   locale: null, location: null, pronouns: null,
                   linkedin_url: null, bio: null, birthday: null }],
        })
        // Call 2: fact nodes for this contact
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'job_title', value: 'CTO' }, confidence: 0.9, last_confirmed_at: '2026-01-01' },
            { id: 'f2', properties: { attribute: 'organization', value: 'Acme' }, confidence: 0.8, last_confirmed_at: '2026-01-01' },
          ],
        })
        // Call 3: UPDATE contacts
        .mockImplementation(updateMock),
    } as unknown as Pool;

    const result = await runBackfill(pool);
    expect(result.processed).toBe(1);
    expect(result.written).toBeGreaterThan(0);

    // Verify the UPDATE was called with expected values
    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2]!;
    const sql = updateCall[0] as string;
    const params = updateCall[1] as unknown[];
    expect(sql).toContain('UPDATE contacts SET');
    // title = 'CTO' should be in the params
    expect(params).toContain('CTO');
    // organization = 'Acme' should be in the params
    expect(params).toContain('Acme');
  });

  it('prefers higher confidence when two facts target same column', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: 'c1', kg_node_id: 'kg1', system_role: null,
                   preferred_name: null, title: null, organization: null,
                   primary_email: null, primary_phone: null, timezone: null,
                   locale: null, location: null, pronouns: null,
                   linkedin_url: null, bio: null, birthday: null }],
        })
        .mockResolvedValueOnce({
          rows: [
            // Two facts for title — higher confidence wins
            { id: 'f1', properties: { attribute: 'title', value: 'VP' }, confidence: 0.7, last_confirmed_at: '2025-12-01' },
            { id: 'f2', properties: { attribute: 'title', value: 'CTO' }, confidence: 0.95, last_confirmed_at: '2025-11-01' },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2]!;
    const params = updateCall[1] as unknown[];
    expect(params).toContain('CTO');
    expect(params).not.toContain('VP');
  });

  it('uses last_confirmed_at as tiebreaker when confidence is equal', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: 'c1', kg_node_id: 'kg1', system_role: null,
                   preferred_name: null, title: null, organization: null,
                   primary_email: null, primary_phone: null, timezone: null,
                   locale: null, location: null, pronouns: null,
                   linkedin_url: null, bio: null, birthday: null }],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'title', value: 'VP' }, confidence: 0.8, last_confirmed_at: '2025-06-01' },
            { id: 'f2', properties: { attribute: 'title', value: 'CTO' }, confidence: 0.8, last_confirmed_at: '2026-01-01' }, // more recent
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2]!;
    const params = updateCall[1] as unknown[];
    expect(params).toContain('CTO'); // more recent wins
    expect(params).not.toContain('VP');
  });

  it('skips already-populated columns (idempotency)', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'c1', kg_node_id: 'kg1', system_role: null,
            preferred_name: null,
            title: 'Existing Title',  // already populated
            organization: null, primary_email: null, primary_phone: null,
            timezone: null, locale: null, location: null, pronouns: null,
            linkedin_url: null, bio: null, birthday: null,
          }],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'job_title', value: 'New Title' }, confidence: 0.99, last_confirmed_at: '2026-01-01' },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    // The UPDATE call should NOT include title since it was already populated.
    // If no columns change, no UPDATE is issued at all.
    const updateCall = calls.find(c => (c[0] as string).includes('UPDATE contacts SET'));
    if (updateCall) {
      const params = updateCall[1] as unknown[];
      expect(params).not.toContain('New Title');
    }
  });

  it('does not apply role KG fact to title when contact has a system_role', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'c1', kg_node_id: 'kg1',
            system_role: 'principal',  // has system_role — role fact should not apply to title
            preferred_name: null, title: null, organization: null,
            primary_email: null, primary_phone: null, timezone: null,
            locale: null, location: null, pronouns: null,
            linkedin_url: null, bio: null, birthday: null,
          }],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'role', value: 'Principal' }, confidence: 0.99, last_confirmed_at: '2026-01-01' },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = calls.find(c => (c[0] as string).includes('UPDATE contacts SET'));
    // No update should be issued because the only fact was 'role' which is skipped
    // when system_role is set, and no other columns changed.
    expect(updateCall).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
pnpm --prefix /path/to/worktree run test -- scripts/backfill-contact-attributes.test.ts
```
Expected: FAIL — `Cannot find module './backfill-contact-attributes.js'`.

---

## Task 9: Backfill Script Implementation

**Files:**
- Create: `scripts/backfill-contact-attributes.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the backfill script**

Create `scripts/backfill-contact-attributes.ts`:

```typescript
// scripts/backfill-contact-attributes.ts
//
// Backfills contact canonical columns from KG fact nodes.
// Each contact's kg_node_id is used to find related fact nodes via
// 'relates_to' edges. For each NULL column, the fact with the highest
// confidence (tiebreak: most recent last_confirmed_at) is written.
//
// Run: pnpm run backfill:contact-attributes
// Safety: idempotent — only writes to NULL columns.

import pg from 'pg';

const { Pool } = pg;

// Mapping from KG fact attribute keys to contact columns.
// Keys are compared case-insensitively.
const ATTRIBUTE_MAP: Record<string, string> = {
  preferred_name: 'preferred_name',
  nickname: 'preferred_name',
  job_title: 'title',
  title: 'title',
  // 'role' maps to title only when contact.system_role IS NULL (handled in code)
  organization: 'organization',
  employer: 'organization',
  company: 'organization',
  current_employer: 'organization',
  email: 'primary_email',
  primary_email: 'primary_email',
  phone: 'primary_phone',
  phone_number: 'primary_phone',
  mobile: 'primary_phone',
  timezone: 'timezone',
  tz: 'timezone',
  locale: 'locale',
  language: 'locale',
  home_city: 'location',
  current_location: 'location',
  location: 'location',
  city: 'location',
  pronouns: 'pronouns',
  linkedin: 'linkedin_url',
  linkedin_url: 'linkedin_url',
  bio: 'bio',
  biography: 'bio',
  birthday: 'birthday',
  birthdate: 'birthday',
  dob: 'birthday',
};

// All 12 canonical column names (snake_case, matching DB columns).
const CANONICAL_COLUMNS = [
  'preferred_name', 'title', 'organization', 'primary_email', 'primary_phone',
  'timezone', 'locale', 'location', 'pronouns', 'linkedin_url', 'bio', 'birthday',
];

type ContactRowForBackfill = {
  id: string;
  kg_node_id: string;
  system_role: string | null;
  preferred_name: string | null;
  title: string | null;
  organization: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  timezone: string | null;
  locale: string | null;
  location: string | null;
  pronouns: string | null;
  linkedin_url: string | null;
  bio: string | null;
  birthday: string | null;
};

type FactRow = {
  id: string;
  properties: { attribute?: string; value?: string };
  confidence: number;
  last_confirmed_at: string | null;
};

export async function runBackfill(pool: pg.Pool): Promise<{
  processed: number;
  written: number;
  skipped: number;
  errors: number;
}> {
  // Fetch all contacts that have a KG node linked.
  const contactsResult = await pool.query<ContactRowForBackfill>(
    `SELECT id, kg_node_id, system_role,
            preferred_name, title, organization, primary_email, primary_phone,
            timezone, locale, location, pronouns, linkedin_url, bio, birthday
     FROM contacts WHERE kg_node_id IS NOT NULL`,
  );

  const contacts = contactsResult.rows;
  let processed = 0;
  let written = 0;
  let skipped = 0;
  let errors = 0;

  for (const contact of contacts) {
    try {
      // Fetch all fact nodes reachable via a single 'relates_to' edge
      // from this contact's KG person node (either direction).
      const factsResult = await pool.query<FactRow>(
        `SELECT n.id, n.properties, n.confidence, n.last_confirmed_at
         FROM kg_nodes n
         JOIN kg_edges e ON (
           (e.source_id = $1 AND e.target_id = n.id)
           OR (e.target_id = $1 AND e.source_id = n.id)
         )
         WHERE e.relationship = 'relates_to'
           AND n.type = 'fact'`,
        [contact.kg_node_id],
      );

      const facts = factsResult.rows;

      // Group facts by target column. For each column collect all candidates,
      // then pick the one with highest confidence (tiebreak: most recent last_confirmed_at).
      const candidates: Record<string, Array<{ value: string; confidence: number; confirmedAt: number }>> = {};

      for (const fact of facts) {
        const attrRaw = fact.properties?.attribute;
        const value = fact.properties?.value;
        if (!attrRaw || !value) continue;

        const attr = attrRaw.toLowerCase();

        // 'role' only maps to 'title' when system_role IS NULL
        if (attr === 'role' && contact.system_role != null) continue;

        const col = attr === 'role' ? 'title' : ATTRIBUTE_MAP[attr];
        if (!col) continue;

        const confirmedAt = fact.last_confirmed_at
          ? new Date(fact.last_confirmed_at).getTime()
          : 0;

        if (!candidates[col]) candidates[col] = [];
        candidates[col].push({ value, confidence: Number(fact.confidence), confirmedAt });
      }

      // Determine which NULL columns have a candidate value.
      const updates: Record<string, string> = {};
      for (const col of CANONICAL_COLUMNS) {
        // Only write to NULL columns (idempotent safety)
        if (contact[col as keyof ContactRowForBackfill] != null) {
          skipped++;
          continue;
        }

        const colCandidates = candidates[col];
        if (!colCandidates || colCandidates.length === 0) continue;

        // Sort: highest confidence first; tiebreak on most recent last_confirmed_at
        colCandidates.sort((a, b) =>
          b.confidence !== a.confidence
            ? b.confidence - a.confidence
            : b.confirmedAt - a.confirmedAt,
        );

        updates[col] = colCandidates[0]!.value;
      }

      if (Object.keys(updates).length === 0) {
        processed++;
        continue;
      }

      // Build a parameterized UPDATE for only the changed columns.
      const setClauses: string[] = [];
      const params: unknown[] = [contact.id];
      for (const [col, val] of Object.entries(updates)) {
        params.push(val);
        setClauses.push(`${col} = $${params.length}`);
      }

      await pool.query(
        `UPDATE contacts SET ${setClauses.join(', ')} WHERE id = $1`,
        params,
      );

      written += Object.keys(updates).length;
      processed++;
      console.log(
        `[backfill] contact ${contact.id}: wrote ${Object.keys(updates).join(', ')}`,
      );
    } catch (err) {
      console.error(`[backfill] contact ${contact.id} failed:`, err);
      errors++;
    }
  }

  console.log(
    `[backfill] done — processed: ${processed}, written: ${written}, skipped: ${skipped}, errors: ${errors}`,
  );
  return { processed, written, skipped, errors };
}

// CLI entry point — only runs when executed directly
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[backfill] DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl });
  runBackfill(pool)
    .then(({ errors }) => {
      void pool.end();
      process.exit(errors > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('[backfill] fatal error:', err);
      void pool.end();
      process.exit(1);
    });
}
```

- [ ] **Step 2: Run backfill unit tests**

```bash
pnpm --prefix /path/to/worktree run test -- scripts/backfill-contact-attributes.test.ts
```
Expected: All tests PASS.

- [ ] **Step 3: Add the npm script to `package.json`**

In `package.json`, find the `"scripts"` block. Add the backfill entry:

```json
"backfill:contact-attributes": "tsx scripts/backfill-contact-attributes.ts",
```

(Add it alongside the other script entries.)

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add scripts/backfill-contact-attributes.ts scripts/backfill-contact-attributes.test.ts package.json
git -C /path/to/worktree commit -m "feat: backfill script for contact canonical attributes"
```

---

## Task 10: Final Typecheck + Full Test Run

- [ ] **Step 1: Run full typecheck**

```bash
pnpm --prefix /path/to/worktree run typecheck
```
Expected: No errors.

- [ ] **Step 2: Run all unit tests**

```bash
pnpm --prefix /path/to/worktree run test -- tests/unit/
```
Expected: All tests PASS.

- [ ] **Step 3: Run integration tests (requires DATABASE_URL)**

```bash
pnpm --prefix /path/to/worktree run test -- tests/integration/contacts.test.ts
```
Expected: All tests PASS (or gracefully skipped if DATABASE_URL unset).

- [ ] **Step 4: Update CHANGELOG.md**

Add to the `## [Unreleased]` section in `CHANGELOG.md`:

```markdown
### Added
- **Contact canonical attributes** — 12 structured profile fields (`title`, `organization`, `primary_email`, etc.) persisted directly on the `contacts` row; backfill script populates from KG facts. (#829)
```

- [ ] **Step 5: Final commit**

```bash
git -C /path/to/worktree add CHANGELOG.md
git -C /path/to/worktree commit -m "chore: CHANGELOG for contact canonical attributes (#829)"
```

---

## Acceptance Criteria Checklist

- [ ] Migration 048 adds 12 columns with CHECK constraints; rolls back cleanly
- [ ] Backfill script populates columns from KG facts; re-run is idempotent
- [ ] `ContactService.createContact` stores all 12 fields; `updateContactFields()` validates primaryEmail
- [ ] HTTP API: GET list returns all 12 fields; POST/PATCH accept and validate them (400 on invalid input)
- [ ] Console table: Role column replaced with Title + Organization
- [ ] Console drawer: 6 grouped sections covering all 12 new fields
- [ ] All existing tests pass; new unit + integration + backfill tests all green
- [ ] Typecheck and lint clean
