# Entity-Context Email Address Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `resolveKgNodeId()` in `EntityContextAssembler` resolve email addresses to contact UUIDs via `contact_channel_identities`, so CC flows and ceo-inbox triage get KG context for known contacts instead of "unresolved."

**Architecture:** Add an email-detection branch at the top of `resolveKgNodeId()`. When the input contains `@`, query `contact_channel_identities JOIN contacts` to resolve email → contact.id → kg_node_id. Existing UUID paths are unchanged (wrapped in an `else` branch). One prompt clarification in curia-deploy's ceo-inbox agent.

**Tech Stack:** TypeScript, PostgreSQL, Vitest (unit tests with mock pool)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/entity-context/assembler.ts` | Modify (lines 254-305) | Add email detection + resolution in `resolveKgNodeId()` |
| `tests/unit/entity-context/assembler.test.ts` | Modify (append new describe block) | Tests for email resolution path |
| `CHANGELOG.md` | Modify (line 14, under `## [Unreleased]`) | Add `### Fixed` entry |

The ceo-inbox.yaml prompt clarification is in curia-deploy (separate repo). It will be noted in the PR description but not included in this PR.

---

### Task 1: Write failing tests for email resolution

**Files:**
- Modify: `tests/unit/entity-context/assembler.test.ts`

The existing tests use `makeSequentialPool()` to return canned DB responses in order. The email resolution path adds one new query before the existing UUID-based queries. Tests need to account for this new query position.

- [ ] **Step 1: Add test fixtures at the top of the file**

Add these fixtures after the existing `relationshipRow` fixture (after line 81):

```typescript
// -- Channel identity fixture for email resolution --
const channelIdentityRow = {
  contact_id: 'contact-1',
  kg_node_id: 'node-1',
};
```

- [ ] **Step 2: Write the test for a registered email that resolves to a KG node**

Add a new `describe` block after the existing `describe('fact value extraction', ...)` block (after line 344):

```typescript
describe('resolveKgNodeId — email address resolution', () => {
  it('resolves a registered email address to a KG node via contact_channel_identities', async () => {
    // Query order for email path:
    // 1. resolveKgNodeId: email → contact_channel_identities JOIN contacts → contact_id + kg_node_id
    // 2. getKgNode
    // 3. getFacts
    // 4. getContactByKgNodeId
    // 5. getConnectedAccounts
    // 6. getRelationships
    const pool = makeSequentialPool([
      { rows: [channelIdentityRow] },   // email resolution: found
      { rows: [personNodeRow] },         // getKgNode
      { rows: [timezoneFactRow] },       // getFacts
      { rows: [contactRow] },            // getContactByKgNodeId
      { rows: [calendarRow] },           // getConnectedAccounts
      { rows: [relationshipRow] },       // getRelationships
    ]);

    const assembler = new EntityContextAssembler(pool, logger);
    const ctx = await assembler.assembleOne('jenna@example.com');

    expect(ctx).toBeDefined();
    expect(ctx!.entityId).toBe('node-1');
    expect(ctx!.entityType).toBe('person');
    expect(ctx!.label).toBe('Jenna Smith');
    expect(ctx!.contact).toEqual({
      contactId: 'contact-1',
      displayName: 'Jenna Smith',
      role: null,
    });
  });
});
```

- [ ] **Step 3: Write the test for a registered email with no KG node**

Add inside the same `describe` block:

```typescript
  it('returns undefined when email resolves to a contact with no KG node', async () => {
    const pool = makeSequentialPool([
      { rows: [{ contact_id: 'contact-1', kg_node_id: null }] }, // email found, no KG node
    ]);

    const assembler = new EntityContextAssembler(pool, logger);
    const ctx = await assembler.assembleOne('jenna@example.com');
    expect(ctx).toBeUndefined();
  });
```

- [ ] **Step 4: Write the test for an unregistered email**

Add inside the same `describe` block:

```typescript
  it('returns undefined for an unregistered email address', async () => {
    const pool = makeSequentialPool([
      { rows: [] }, // email not found in contact_channel_identities
    ]);

    const assembler = new EntityContextAssembler(pool, logger);
    const ctx = await assembler.assembleOne('stranger@unknown.com');
    expect(ctx).toBeUndefined();
  });
```

- [ ] **Step 5: Write the test for assembleMany with mixed email + UUID inputs**

Add inside the same `describe` block:

```typescript
  it('assembleMany resolves a mix of email addresses and contact UUIDs', async () => {
    // putInCache stores under all aliases: inputId ('jenna@example.com'),
    // entityId ('node-1'), and contactId ('contact-1'). So the second
    // lookup for 'contact-1' is a cache hit — no extra DB queries needed.
    const pool = makeSequentialPool([
      // First ID: email address — full resolution + assembly
      { rows: [channelIdentityRow] },    // email resolution
      { rows: [personNodeRow] },          // getKgNode
      { rows: [] },                       // getFacts
      { rows: [contactRow] },             // getContactByKgNodeId
      { rows: [] },                       // getConnectedAccounts
      { rows: [] },                       // getRelationships
      // Second ID 'contact-1': cache hit, no DB queries
    ]);

    const assembler = new EntityContextAssembler(pool, logger);
    const { entities, unresolved } = await assembler.assembleMany([
      'jenna@example.com',
      'contact-1',
    ]);

    expect(entities).toHaveLength(2);
    expect(unresolved).toHaveLength(0);
    expect(entities[0].entityId).toBe('node-1');
    // Second entity served from cache — same underlying contact
    expect(entities[1].entityId).toBe('node-1');
  });
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve test -- tests/unit/entity-context/assembler.test.ts`

Expected: All four new tests FAIL. The email address `'jenna@example.com'` goes through the UUID path, hits the sequential pool in the wrong order, and throws `Unexpected query call` or returns the wrong result.

- [ ] **Step 7: Commit the failing tests**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve add tests/unit/entity-context/assembler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve commit -m "test: add failing tests for email address resolution in resolveKgNodeId (#461)"
```

---

### Task 2: Implement email resolution in resolveKgNodeId()

**Files:**
- Modify: `src/entity-context/assembler.ts` (lines 254-305)

- [ ] **Step 1: Update the JSDoc comment on resolveKgNodeId**

Replace lines 254-257:

```typescript
  /**
   * Resolve an input ID to a KG node ID.
   * Tries contacts.id first, then kg_nodes.id directly.
   */
```

With:

```typescript
  /**
   * Resolve an input ID to a KG node ID.
   *
   * Resolution priority:
   *   1. Email address → contact_channel_identities → contacts.kg_node_id
   *   2. Contact UUID → contacts.kg_node_id
   *   3. KG node UUID → kg_nodes.id directly
   *
   * Email detection uses a simple @ check. This handles the common case where
   * LLMs pass raw email addresses from CC preambles or inbox triage rather than
   * resolving to a contact UUID first.
   */
```

- [ ] **Step 2: Add email detection and resolution branch**

Replace the body of `resolveKgNodeId` (lines 258-305) with:

```typescript
  private async resolveKgNodeId(id: string): Promise<string | undefined> {
    // Email address detection: if the input contains '@' with non-whitespace on
    // both sides, resolve via contact_channel_identities instead of UUID columns.
    // This handles CC flows and ceo-inbox triage where the LLM passes a raw email.
    if (/^\S+@\S+$/.test(id)) {
      const emailResult = await this.pool.query<{ contact_id: string; kg_node_id: string | null }>(
        `SELECT c.id AS contact_id, c.kg_node_id
         FROM contact_channel_identities cci
         JOIN contacts c ON c.id = cci.contact_id
         WHERE cci.channel = 'email' AND LOWER(cci.channel_identifier) = LOWER($1)`,
        [id],
      );
      if (emailResult.rows.length > 0) {
        const row = emailResult.rows[0];
        const kgNodeId = row?.kg_node_id;
        if (!kgNodeId) {
          this.logger.debug({ email: id, contactId: row?.contact_id }, 'entity-context: email resolved to contact with no linked KG node');
          return undefined;
        }
        return kgNodeId;
      }
      // Email not found in contact_channel_identities — genuinely unknown contact
      return undefined;
    }

    try {
      // Try as a contact ID first
      const contactResult = await this.pool.query<{ kg_node_id: string | null }>(
        'SELECT kg_node_id FROM contacts WHERE id = $1',
        [id],
      );
      if (contactResult.rows.length > 0) {
        const row = contactResult.rows[0];
        const kgNodeId = row?.kg_node_id;
        // Contact found but has no linked KG node — return undefined (unresolved)
        if (!kgNodeId) {
          this.logger.debug({ contactId: id }, 'entity-context: contact has no linked KG node');
          return undefined;
        }
        return kgNodeId;
      }

      // Try as a KG node ID directly
      const nodeResult = await this.pool.query<{ id: string }>(
        'SELECT id FROM kg_nodes WHERE id = $1',
        [id],
      );
      if (nodeResult.rows.length > 0) {
        return nodeResult.rows[0]?.id;
      }

      return undefined;
    } catch (err) {
      // PostgreSQL error 22P02 = invalid_text_representation: the ID is not a valid UUID.
      // This happens when the LLM passes a hallucinated or synthetic string (e.g.
      // 'joseph-fung-contact-id', 'primary-user') to a UUID column. Treat as unresolved
      // rather than letting the error bubble up and surface to the caller.
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === '22P02'
      ) {
        // Warn rather than debug: after the contact-resolver fix ships, this path should be
        // unreachable in production. If it fires, something upstream is still leaking a
        // synthetic/hallucinated ID and operators need a searchable signal to trace it.
        this.logger.warn({ id }, 'entity-context: non-UUID id passed to resolveKgNodeId — treating as unresolved');
        return undefined;
      }
      throw err;
    }
  }
```

- [ ] **Step 3: Run the tests**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve test -- tests/unit/entity-context/assembler.test.ts`

Expected: All tests pass — both the new email resolution tests and the existing UUID-path tests.

- [ ] **Step 4: Commit the implementation**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve add src/entity-context/assembler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve commit -m "fix: resolve email addresses in entity-context via contact_channel_identities (#461)"
```

---

### Task 3: Update CHANGELOG and run full test suite

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a Fixed section to the changelog**

Under `## [Unreleased]`, after the existing `### Changed` section (after line 28, before the `---` separator), add:

```markdown
### Fixed

- **Entity-context email resolution** — `resolveKgNodeId` now resolves email addresses via `contact_channel_identities` before attempting UUID-based queries, fixing missing KG context in CC flows and ceo-inbox triage for known contacts ([#461](https://github.com/josephfung/curia/issues/461))
```

- [ ] **Step 2: Run the full test suite**

Run: `npm --prefix /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve test`

Expected: All tests pass. No regressions.

- [ ] **Step 3: Commit the changelog**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/repos/worktrees/curia-email-resolve commit -m "chore: changelog entry for entity-context email resolution (#461)"
```

---

## Follow-up (separate PR in curia-deploy)

Update `custom/agents/ceo-inbox.yaml` line 145 from:

> Call entity-context on the sender's email address.

To:

> Call entity-context with contactIds set to the sender's email address.

This is a prompt clarification — the code fix in this PR makes it work either way, but the prompt should guide the LLM toward the correct input parameter.
