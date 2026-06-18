# Automated/Bulk Sender Class (#953) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify automated/bulk email senders as `kind='automated'`, bypass the dispatcher tier gate for them, exclude them from the People view, and feed `kind` context to the ceo-inbox agent.

**Architecture:** Extend `classifyEmailSender()` to return `'automated'` as a first-class type; short-circuit `createContact()` to skip org KG node resolution for automated addresses; add a `kind` bypass in the dispatcher's tier gate; update the ceo-inbox agent with a low-salience handling rule; add a `kind` filter to `listContacts()` and the `contact-list` skill handler (defaulting to exclude `'automated'` and `'agent'`).

**Tech Stack:** TypeScript (ESM, `.js` imports), Vitest, node-postgres, node-pg-migrate (plain SQL)

## Global Constraints

- All imports use `.js` extensions on relative paths (`./contact-service.js`, not `./contact-service`)
- No `any` — use `ContactKind`, `ContactTier`, `ContactStatus` from `src/contacts/types.ts`
- All SQL uses parameterized queries (`$N` placeholders, never string interpolation)
- Run `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender run typecheck` before every commit that touches `.ts` files
- Run `pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test` after each task to confirm no regressions
- Working directory for all commands is the worktree: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender`
- Branch: `feat/automated-sender-class`

---

### Task 1: Extend `classifyEmailSender()` to detect automated senders

**Files:**
- Modify: `src/contacts/contact-service.ts` (lines 133–163)
- Modify: `src/contacts/email-sender-classifier.test.ts`

**Interfaces:**
- Produces: `classifyEmailSender(email: string): 'person' | 'organization' | 'automated'`

---

- [ ] **Step 1: Update the test file with failing assertions**

Replace the existing content of `src/contacts/email-sender-classifier.test.ts` with:

```typescript
// src/contacts/email-sender-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { classifyEmailSender } from './contact-service.js';

describe('classifyEmailSender', () => {
  // ---- Automated senders (checked first — before webmail domain and name patterns) ----

  it('classifies noreply variants as automated', () => {
    expect(classifyEmailSender('noreply@github.com')).toBe('automated');
    expect(classifyEmailSender('no-reply@stripe.com')).toBe('automated');
    expect(classifyEmailSender('no_reply@acme.com')).toBe('automated');
    expect(classifyEmailSender('donotreply@shopify.com')).toBe('automated');
    expect(classifyEmailSender('do-not-reply@acme.com')).toBe('automated');
    expect(classifyEmailSender('do_not_reply@acme.com')).toBe('automated');
  });

  it('classifies mailer-daemon as automated', () => {
    expect(classifyEmailSender('mailer-daemon@mailserver.example')).toBe('automated');
    expect(classifyEmailSender('mailerdaemon@example.com')).toBe('automated');
  });

  it('classifies notification/alert/newsletter local-parts as automated', () => {
    expect(classifyEmailSender('notifications@slack.com')).toBe('automated');
    expect(classifyEmailSender('notification@github.com')).toBe('automated');
    expect(classifyEmailSender('alerts@monitoring.io')).toBe('automated');
    expect(classifyEmailSender('alert@pagerduty.com')).toBe('automated');
    expect(classifyEmailSender('newsletter@substack.com')).toBe('automated');
    expect(classifyEmailSender('newsletters@acme.com')).toBe('automated');
    expect(classifyEmailSender('updates@stripe.com')).toBe('automated');
    expect(classifyEmailSender('update@github.com')).toBe('automated');
  });

  it('classifies bounce/unsubscribe/postmaster as automated', () => {
    expect(classifyEmailSender('bounce@amazonses.com')).toBe('automated');
    expect(classifyEmailSender('bounces@sendgrid.net')).toBe('automated');
    expect(classifyEmailSender('bounced@mailchimp.com')).toBe('automated');
    expect(classifyEmailSender('unsubscribe@acme.com')).toBe('automated');
    expect(classifyEmailSender('postmaster@example.com')).toBe('automated');
  });

  it('classifies automated/auto as automated', () => {
    expect(classifyEmailSender('automated@system.example')).toBe('automated');
    expect(classifyEmailSender('auto@system.example')).toBe('automated');
  });

  // AUTOMATED CHECK RUNS BEFORE WEBMAIL DOMAIN CHECK — this is the critical ordering test.
  // noreply@gmail.com should be 'automated', not 'person'.
  it('classifies noreply on personal webmail domain as automated (not person)', () => {
    expect(classifyEmailSender('noreply@gmail.com')).toBe('automated');
    expect(classifyEmailSender('mailer-daemon@googlemail.com')).toBe('automated');
    expect(classifyEmailSender('bounce@yahoo.com')).toBe('automated');
  });

  // ---- Organization addresses (stay as organization, not promoted to automated) ----

  it('classifies org role addresses as organization', () => {
    expect(classifyEmailSender('info@startup.io')).toBe('organization');
    expect(classifyEmailSender('support@cloudflare.com')).toBe('organization');
    expect(classifyEmailSender('admin@company.com')).toBe('organization');
    expect(classifyEmailSender('billing@shopify.com')).toBe('organization');
    expect(classifyEmailSender('team@acme.com')).toBe('organization');
    expect(classifyEmailSender('help@acme.com')).toBe('organization');
    expect(classifyEmailSender('hello@startup.io')).toBe('organization');
    expect(classifyEmailSender('sales@company.com')).toBe('organization');
    expect(classifyEmailSender('news@bbc.com')).toBe('organization');
  });

  // ---- Personal webmail domains → always person (for non-automated local-parts) ----

  it('classifies gmail addresses as person', () => {
    expect(classifyEmailSender('john@gmail.com')).toBe('person');
    expect(classifyEmailSender('alice.smith@googlemail.com')).toBe('person');
  });

  it('classifies common webmail domains as person', () => {
    expect(classifyEmailSender('user@yahoo.com')).toBe('person');
    expect(classifyEmailSender('user@hotmail.com')).toBe('person');
    expect(classifyEmailSender('user@outlook.com')).toBe('person');
    expect(classifyEmailSender('user@icloud.com')).toBe('person');
    expect(classifyEmailSender('user@protonmail.com')).toBe('person');
    expect(classifyEmailSender('user@live.com')).toBe('person');
  });

  // ---- Personal name patterns → person ----

  it('classifies first.last patterns as person', () => {
    expect(classifyEmailSender('john.doe@company.com')).toBe('person');
    expect(classifyEmailSender('alice.smith@bigcorp.com')).toBe('person');
  });

  it('classifies first_last and first-last patterns as person', () => {
    expect(classifyEmailSender('john_doe@company.com')).toBe('person');
    expect(classifyEmailSender('john-doe@company.com')).toBe('person');
  });

  // ---- Default (ambiguous single-word) → person (conservative) ----

  it('defaults ambiguous single-word local parts to person', () => {
    expect(classifyEmailSender('alex@startup.io')).toBe('person');
    expect(classifyEmailSender('dana@company.com')).toBe('person');
  });

  // ---- Malformed ----

  it('returns person for malformed email with no @ sign', () => {
    expect(classifyEmailSender('notanemail')).toBe('person');
  });
});
```

- [ ] **Step 2: Run tests and confirm the new assertions fail**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test src/contacts/email-sender-classifier.test.ts
```

Expected: failures on all the new `'automated'` assertions (they currently return `'organization'` or `'person'`).

- [ ] **Step 3: Split the regex constants and update the function**

In `src/contacts/contact-service.ts`, replace lines 129–163 (the two regex constants and the `classifyEmailSender` function) with:

```typescript
/**
 * Local-part prefixes that are unambiguously machine-generated: no-reply addresses,
 * mailing-system roles, bounce handlers, unsubscribe addresses.
 * Checked first — before the webmail-domain check — so noreply@gmail.com is
 * correctly classified as automated rather than person.
 */
const AUTOMATED_LOCAL_RE =
  /^(no[_.-]?reply|noreply|donotreply|do[_.-]not[_.-]?reply|mailer[_.-]?daemon|mailerdaemon|notifications?|alerts?|newsletters?|updates?|bounced?|bounces?|unsubscribe|postmaster|automated|auto)$/i;

/**
 * Local-part prefixes that belong to an org role address (support, billing, etc.)
 * but are NOT unambiguously automated. Matches → classify as organization.
 * hello/news kept here: too ambiguous to call automated (could be a real team).
 */
const NON_PERSON_LOCAL_RE =
  /^(info|support|hello|help|admin|contact|billing|feedback|news|team|sales|marketing|legal|security|service|services|order|orders|invoice|invoices|accounts?|system)$/i;

/**
 * Local-part pattern for a personal name address (first.last or first_last).
 * Two alphabetic words separated by a dot, underscore, or hyphen.
 */
const PERSON_LOCAL_RE = /^[a-zA-Z]+[._-][a-zA-Z]+$/;

/**
 * Classify an email sender as a person, an organization role address, or an
 * automated/bulk sender.
 *
 * Rules applied in order:
 * 1. Automated local-part pattern → 'automated' (checked BEFORE webmail domain
 *    so noreply@gmail.com is automated, not person)
 * 2. Personal webmail domain → 'person'
 * 3. Org/system role local-part pattern → 'organization'
 * 4. Local part looks like first.last name → 'person'
 * 5. Default → 'person' (conservative; false negative on org is less harmful
 *    than merging a real person under an org node)
 */
export function classifyEmailSender(email: string): 'person' | 'organization' | 'automated' {
  const atIdx = email.indexOf('@');
  if (atIdx === -1) return 'person'; // malformed — safe default

  const localPart = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1).toLowerCase();

  if (AUTOMATED_LOCAL_RE.test(localPart)) return 'automated';
  if (PERSONAL_EMAIL_DOMAINS.has(domain)) return 'person';
  if (NON_PERSON_LOCAL_RE.test(localPart)) return 'organization';
  if (PERSON_LOCAL_RE.test(localPart)) return 'person';
  return 'person'; // default
}
```

- [ ] **Step 4: Run tests and confirm all pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test src/contacts/email-sender-classifier.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender run typecheck
```

Expected: no errors. If TypeScript complains that `'automated'` is not assignable to `'person' | 'organization'` anywhere else, those call sites need updating in their respective tasks.

- [ ] **Step 6: Run the full test suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test
```

Expected: all tests pass (no regressions).

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender add src/contacts/contact-service.ts src/contacts/email-sender-classifier.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender commit -m "feat: extend classifyEmailSender to detect automated senders (#953)

Split NON_PERSON_LOCAL_RE into AUTOMATED_LOCAL_RE (noreply/bounce/daemon/etc)
and a trimmed org-role set. Return type gains 'automated' as a third value.
Automated check runs before the webmail-domain check so noreply@gmail.com
is classified automated, not person."
```

---

### Task 2: Short-circuit `createContact()` for automated senders

**Files:**
- Modify: `src/contacts/contact-service.ts` (lines 417–444)

**Interfaces:**
- Consumes: `classifyEmailSender(email): 'person' | 'organization' | 'automated'` from Task 1
- Produces: `createContact({ primaryEmail: 'noreply@github.com', ... })` → `Contact` with `kind: 'automated'`

---

- [ ] **Step 1: Write a failing test**

Create or add to a contact service unit test. Check for an existing test file:

```bash
find /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender/src/contacts -name "contact-service*.test.ts" | head -5
```

If `src/contacts/contact-service.test.ts` exists, add to it. If not, create it. Add:

```typescript
// In contact-service.test.ts (new describe block or new file)
import { describe, it, expect, vi } from 'vitest';
import { ContactService } from './contact-service.js';
import { InMemoryContactBackend } from './contact-service.js'; // adjust import if needed

describe('createContact — automated sender', () => {
  it('sets kind=automated for noreply email and does not create org KG node', async () => {
    // Mock entityMemory: if resolveOrCreateOrgNode is called, it would invoke
    // entityMemory.findEntitiesByProperty or similar. We verify it is NOT called
    // by recording calls on the mock.
    const mockEntityMemory = {
      createEntity: vi.fn().mockResolvedValue({
        entity: { id: 'kg-person-1', type: 'person', label: 'GitHub Notifications', properties: {}, aliases: [] },
        created: true,
      }),
      updateNode: vi.fn(),
      findEntitiesByProperty: vi.fn(),
      // add any other methods the type requires with vi.fn()
    };

    const backend = new InMemoryContactBackend();
    const service = new ContactService({ backend, entityMemory: mockEntityMemory as any });

    const contact = await service.createContact({
      displayName: 'GitHub Notifications',
      primaryEmail: 'noreply@github.com',
      source: 'test',
    });

    expect(contact.kind).toBe('automated');
    // resolveOrCreateOrgNode calls entityMemory.findEntitiesByProperty to look up
    // the org node by domain — it must NOT have been called for automated senders.
    expect(mockEntityMemory.findEntitiesByProperty).not.toHaveBeenCalled();
  });

  it('still creates org KG node for org-role email (regression guard)', async () => {
    const mockEntityMemory = {
      createEntity: vi.fn().mockResolvedValue({
        entity: { id: 'kg-org-1', type: 'organization', label: 'Stripe', properties: {}, aliases: [] },
        created: true,
      }),
      updateNode: vi.fn(),
      findEntitiesByProperty: vi.fn().mockResolvedValue([]), // no existing org found
    };

    const backend = new InMemoryContactBackend();
    const service = new ContactService({ backend, entityMemory: mockEntityMemory as any });

    const contact = await service.createContact({
      displayName: 'Stripe Billing',
      primaryEmail: 'billing@stripe.com',
      source: 'test',
    });

    // billing@ is org, not automated — org node resolution should have been attempted
    expect(contact.kind).toBe('organization');
  });
});
```

> **Note:** The exact mock shape depends on `EntityMemory`'s interface. If the mock type doesn't align with what `ContactService` expects, cast to `any` (with a comment noting the test-only cast) and confirm the test fails correctly before the implementation change.

- [ ] **Step 2: Run tests and confirm the first test fails**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test src/contacts/contact-service.test.ts
```

Expected: `kind=automated` assertion fails (returns `'organization'` currently).

- [ ] **Step 3: Add the automated branch in `createContact()`**

In `src/contacts/contact-service.ts`, find the block starting at line 417:

```typescript
    if (!kgNodeId && this.entityMemory) {
      if (options.primaryEmail) {
        const orgResult = await this.resolveOrCreateOrgNode(
```

Replace that inner `if (options.primaryEmail)` block with:

```typescript
    if (!kgNodeId && this.entityMemory) {
      if (options.primaryEmail) {
        // Automated senders (noreply, mailer-daemon, etc.) have no org node worth linking.
        // Skip resolveOrCreateOrgNode entirely and set kind directly.
        if (classifyEmailSender(options.primaryEmail) === 'automated') {
          resolvedKind = 'automated';
        } else {
          const orgResult = await this.resolveOrCreateOrgNode(
            options.primaryEmail,
            safeName,
            options.displayName,
            options.source,
          );
          if (orgResult) {
            kgNodeId = orgResult.kgNodeId;
            resolvedKind = orgResult.kind;
            if (options.kind && options.kind !== orgResult.kind) {
              this.logger?.warn(
                { requestedKind: options.kind, resolvedKind: orgResult.kind, email: options.primaryEmail },
                'createContact: org routing overrode caller-supplied kind',
              );
            } else {
              this.logger?.debug(
                { resolvedKind: orgResult.kind, email: options.primaryEmail },
                'createContact: org routing applied',
              );
            }
          }
        }
      }
```

The rest of the block (person-node fallback, kind downgrade warning) remains unchanged.

- [ ] **Step 4: Run tests and confirm they pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test src/contacts/contact-service.test.ts
```

Expected: both assertions PASS.

- [ ] **Step 5: Run typecheck and full suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender run typecheck
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test
```

Expected: no errors, no regressions.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender add src/contacts/contact-service.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender commit -m "feat: skip org KG node creation for automated email senders (#953)

createContact() now short-circuits resolveOrCreateOrgNode when the email
classifies as 'automated'. The contact gets kind='automated' with no
org KG node linked."
```

---

### Task 3: Migration 057 — backfill automated contacts

**Files:**
- Create: `src/db/migrations/057_backfill_automated_kind.sql`

**Interfaces:**
- Independent of Tasks 1–2 (pure SQL, no app-layer dependencies)

---

- [ ] **Step 1: Check the next available migration number**

```bash
ls /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender/src/db/migrations/ | sort | tail -5
```

Confirm `057_` is not taken. If a collision exists, use the next available prefix.

- [ ] **Step 2: Create the migration file**

Create `src/db/migrations/057_backfill_automated_kind.sql`:

```sql
-- Migration 057: backfill kind='automated' for existing contacts whose primary
-- email address matches known automated sender patterns.
--
-- Touches both kind='organization' rows (noreply addresses classified as org
-- before this migration) and kind='person' rows (contacts created before the
-- classifier existed). Idempotent: contacts already at kind='automated' are
-- skipped via the WHERE clause.
--
-- The regex mirrors AUTOMATED_LOCAL_RE in contact-service.ts exactly.
-- Keep both in sync if patterns are ever extended.

UPDATE contacts
SET kind = 'automated', updated_at = now()
WHERE id IN (
  SELECT c.id
  FROM contacts c
  JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE cci.channel = 'email'
    AND cci.identity_value ~* '^(noreply|no[_.-]?reply|donotreply|do[_.-]not[_.-]?reply|mailer[_.-]?daemon|mailerdaemon|notifications?|alerts?|newsletters?|updates?|bounced?|bounces?|unsubscribe|postmaster|automated|auto)@'
    AND c.kind != 'automated'
);
```

- [ ] **Step 3: Spot-check the regex locally**

Run a dry-run query against the dev DB to see which contacts would be reclassified:

```bash
# Open a psql session against your dev DB and run:
SELECT c.id, c.display_name, c.kind, cci.identity_value
FROM contacts c
JOIN contact_channel_identities cci ON cci.contact_id = c.id
WHERE cci.channel = 'email'
  AND cci.identity_value ~* '^(noreply|no[_.-]?reply|donotreply|do[_.-]not[_.-]?reply|mailer[_.-]?daemon|mailerdaemon|notifications?|alerts?|newsletters?|updates?|bounced?|bounces?|unsubscribe|postmaster|automated|auto)@'
  AND c.kind != 'automated';
```

Verify the result set matches expected automated senders (Google doc-comment noreply, Cloudflare notify, etc.) and does not include real-person contacts.

- [ ] **Step 4: Run the migration**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender run db:migrate
```

Check startup logs confirm migration 057 applied cleanly.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender add src/db/migrations/057_backfill_automated_kind.sql
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender commit -m "chore: migration 057 — backfill kind=automated for existing contacts (#953)

Reclassifies contacts whose email matches AUTOMATED_LOCAL_RE from
kind='organization' or kind='person' to kind='automated'. Idempotent."
```

---

### Task 4: Bypass dispatcher tier gate for automated senders

**Files:**
- Modify: `src/dispatch/dispatcher.ts` (line 293)

**Interfaces:**
- Consumes: `isAutomatedKind(kind: ContactKind): boolean` from `src/contacts/types.ts` (already exported, line 350)
- `SenderContext.kind: ContactKind` is already populated by the contact resolver (confirmed at `src/contacts/types.ts` line 190)

---

- [ ] **Step 1: Determine the dispatcher test approach**

The dispatcher is tested at integration level, not unit level. Check for an integration test harness:

```bash
find /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender/tests -name "*dispatch*" -o -name "*integration*" | head -10
find /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender/src/dispatch -name "*.test.ts" | head -10
```

**If an integration test harness exists:** Add a test case that wires a dispatcher with `unknownSender='ignore'` channel policy, resolves a sender with `tier='unknown'` and `kind='automated'`, dispatches an inbound message, and asserts no `message-rejected` event was published (i.e., the message reached the coordinator). Use the same setup pattern found in the existing tests.

**If no dispatcher integration test harness exists:** Skip the automated test for this task. The acceptance criteria checklist at the end of the plan covers this functionally — verify manually by checking the dispatcher logs after applying the code change.

- [ ] **Step 2: Apply the code change first, then run tests**

Make the code change (Step 3 below), then run any test you wrote.

- [ ] **Step 3: Add the bypass to the tier gate**

In `src/dispatch/dispatcher.ts`, find line 293:

```typescript
            if (senderContext.tier === 'unknown' || senderContext.tier === 'blocked') {
```

The import for `isAutomatedKind` may not exist yet. First, confirm the import at the top of the file:

```typescript
import type { InboundSenderContext, ChannelPolicyConfig, TrustLevel, UnknownSenderPolicy, TaskOriginator } from '../contacts/types.js';
```

Add `isAutomatedKind` to that import:

```typescript
import type { InboundSenderContext, ChannelPolicyConfig, TrustLevel, UnknownSenderPolicy, TaskOriginator } from '../contacts/types.js';
import { isAutomatedKind } from '../contacts/types.js';
```

> **Note:** If `types.ts` uses only `export type` for `isAutomatedKind`, change it to `export function` (it already is a function, not a type, at line 350).

Then change line 293:

```typescript
            // Automated senders (kind='automated') bypass the tier gate entirely —
            // they have no standing in the trust/action system and should always
            // reach the coordinator. The coordinator uses kind='automated' context
            // to treat them as low-salience machine mail.
            if ((senderContext.tier === 'unknown' || senderContext.tier === 'blocked') && !isAutomatedKind(senderContext.kind)) {
```

- [ ] **Step 4: Run test and confirm it passes**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test src/dispatch/dispatcher-automated.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck and full suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender run typecheck
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test
```

Expected: no errors, no regressions.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender add src/dispatch/dispatcher.ts src/dispatch/dispatcher-automated.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender commit -m "feat: bypass dispatcher tier gate for kind=automated senders (#953)

Automated senders always reach the coordinator regardless of tier or
unknownSender channel policy. kind='automated' means the sender has no
standing in the trust/action system, not that it should be blocked."
```

---

### Task 5: Update ceo-inbox agent instructions for automated senders

**Files:**
- Modify: `agents/ceo-inbox.yaml`

**Interfaces:**
- Consumes: `kind: 'automated'` field in `senderContext` passed to the coordinator (already flows through `SenderContext.kind`)

---

- [ ] **Step 1: Find the correct insertion point in ceo-inbox.yaml**

The triage categories in the `system_prompt` are at lines ~331–466. The `✔️ Cleared` category (line 455) already covers "receipt, newsletter, automated notification" — we're adding a more specific rule that fires before the general classification.

Find the `### 4e. Classify into one of five categories` header and locate the `**🚨 Urgent**` block (first category). The automated-sender rule should be added as a **pre-classification check** immediately above the five-category block.

- [ ] **Step 2: Add the automated sender handling rule**

In `agents/ceo-inbox.yaml`, find the line that starts `### 4e. Classify into one of five categories` and insert the following block immediately before it:

```yaml
  ### 4e-pre. Automated sender check

  Before evaluating the five categories below, check the sender's `kind`
  field in the senderContext. If `kind` is `automated`:

  **Default to low-salience.** Most machine mail is noise. Apply ✔️ Cleared
  unless the content contains a genuinely actionable signal:
    - Account suspension or access termination
    - Payment failure or successful payout
    - Fraud or security alert requiring a response
    - Bounce notification (delivery failure)
    - Hard deadline or expiry embedded in the content

  If any of those signals are present, escalate normally using the
  five-category rules below regardless of sender kind.

  Do **not** draft replies to automated senders.

```

- [ ] **Step 3: Bump the agent version**

In `agents/ceo-inbox.yaml`, find `version: "0.7.0"` (line 2) and change it to:

```yaml
version: "0.8.0"
```

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender add agents/ceo-inbox.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender commit -m "feat: teach ceo-inbox to de-prioritize automated senders (#953)

Adds a pre-classification check for kind=automated senders: default to
Cleared (noise), but still escalate fraud alerts, payment failures,
bounces, and hard deadlines. No replies to automated senders."
```

---

### Task 6: Add `kind` filter to `listContacts()` and `contact-list` skill

**Files:**
- Modify: `src/contacts/contact-service.ts`
  - Backend interface at line 183
  - `ContactService.listContacts()` wrapper at line 634
  - `PostgresContactBackend.listContacts()` at line 1408
  - `InMemoryContactBackend.listContacts()` at line 2056
- Modify: `skills/contact-list/handler.ts`
- Modify: `skills/contact-list/skill.json`

**Interfaces:**
- Produces: `listContacts(filters?: { ..., kind?: ContactKind[] })` — accepts array of kinds to include; when omitted defaults to `['person', 'principal', 'organization']` at the skill handler level (not the service level, to avoid breaking other callers)

---

- [ ] **Step 1: Write a failing test for the contact-list skill**

Find the skill test file:

```bash
find /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender/skills/contact-list -name "*.test.ts" | head -5
```

If `skills/contact-list/handler.test.ts` exists, add to it. If not, create it. Add:

```typescript
// skills/contact-list/handler.test.ts
import { describe, it, expect } from 'vitest';
import { ContactListHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeCtx(input: Record<string, unknown>, contacts: unknown[]): SkillContext {
  return {
    input,
    log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    contactService: {
      findContactByRole: async () => [],
      listContacts: async (filters?: { kind?: string[]; status?: string; limit?: number; offset?: number }) => {
        // Return only contacts whose kind is in the filter (or all if no filter)
        return contacts.filter((c: any) =>
          !filters?.kind || filters.kind.includes(c.kind)
        );
      },
    },
  } as unknown as SkillContext;
}

const personContact = { id: '1', displayName: 'Alice', role: null, status: 'confirmed', kgNodeId: null, kind: 'person' };
const automatedContact = { id: '2', displayName: 'GitHub Notifications', role: null, status: 'confirmed', kgNodeId: null, kind: 'automated' };
const agentContact = { id: '3', displayName: 'Curia Agent', role: null, status: 'confirmed', kgNodeId: null, kind: 'agent' };
const orgContact = { id: '4', displayName: 'Stripe', role: null, status: 'confirmed', kgNodeId: null, kind: 'organization' };

describe('ContactListHandler — kind filter', () => {
  it('excludes automated and agent contacts by default (no kind param)', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeCtx({}, [personContact, automatedContact, agentContact, orgContact]));
    expect(result.success).toBe(true);
    const ids = (result as any).data.contacts.map((c: any) => c.contact_id);
    expect(ids).toContain('1'); // person
    expect(ids).toContain('4'); // organization
    expect(ids).not.toContain('2'); // automated excluded
    expect(ids).not.toContain('3'); // agent excluded
  });

  it('returns automated contacts when kind=automated is explicitly requested', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeCtx({ kind: 'automated' }, [personContact, automatedContact]));
    expect(result.success).toBe(true);
    const ids = (result as any).data.contacts.map((c: any) => c.contact_id);
    expect(ids).toContain('2');
    expect(ids).not.toContain('1'); // person not in automated filter
  });

  it('rejects an invalid kind value', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeCtx({ kind: 'invisible' }, []));
    expect(result.success).toBe(false);
    expect((result as any).error).toMatch(/Invalid kind/);
  });
});
```

- [ ] **Step 2: Run test and confirm it fails**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test skills/contact-list/handler.test.ts
```

Expected: failures (handler doesn't know about `kind` yet).

- [ ] **Step 3: Add `kind` to the backend interface and both backend implementations**

In `src/contacts/contact-service.ts`, make three changes:

**3a. Backend interface at line 183** — add `kind?: ContactKind[]`:

```typescript
  listContacts(filters?: { status?: ContactStatus; tier?: ContactTier; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]>;
```

**3b. `PostgresContactBackend.listContacts()` at line 1408** — add the kind condition:

```typescript
  async listContacts(filters?: { status?: ContactStatus; tier?: ContactTier; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status != null) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    if (filters?.tier != null) {
      params.push(filters.tier);
      conditions.push(`tier = $${params.length}`);
    }

    // kind filter: pass as a Postgres array and use = ANY($N) for inclusion.
    if (filters?.kind != null && filters.kind.length > 0) {
      params.push(filters.kind);
      conditions.push(`kind = ANY($${params.length})`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT ${CONTACT_COLS} FROM contacts${where} ORDER BY created_at ASC`;

    if (filters?.limit != null) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
    }

    if (filters?.offset != null && filters.offset > 0) {
      params.push(filters.offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await this.pool.query<ContactRow>(sql, params);
    return result.rows.map((row) => this.rowToContact(row));
  }
```

**3c. `InMemoryContactBackend.listContacts()` at line 2056** — add the kind filter after the tier filter:

```typescript
  async listContacts(filters?: { status?: ContactStatus; tier?: ContactTier; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]> {
    let results = [...this.contacts.values()];

    if (filters?.status != null) {
      results = results.filter((c) => c.status === filters.status);
    }

    if (filters?.tier != null) {
      results = results.filter((c) => c.tier === filters.tier);
    }

    if (filters?.kind != null && filters.kind.length > 0) {
      results = results.filter((c) => filters.kind!.includes(c.kind));
    }

    results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const offset = filters?.offset != null && filters.offset > 0 ? filters.offset : 0;
    const end = filters?.limit != null ? offset + filters.limit : undefined;
    results = results.slice(offset, end);

    return results;
  }
```

- [ ] **Step 4: Update the `ContactService.listContacts()` wrapper at line 634**

```typescript
  /** List contacts, optionally filtered by status, kind, and/or capped by limit with offset for pagination. */
  async listContacts(filters?: { status?: ContactStatus; kind?: ContactKind[]; limit?: number; offset?: number }): Promise<Contact[]> {
    return this.backend.listContacts(filters);
  }
```

You will need to add `ContactKind` to the import from `./types.js` at the top of `contact-service.ts` if it is not already imported in the service class section. Check the existing imports and add if missing.

- [ ] **Step 5: Update the `contact-list` skill handler**

Replace the content of `skills/contact-list/handler.ts` with:

```typescript
// handler.ts — contact-list skill implementation.
//
// Lists contacts, optionally filtered by role, status, or kind, with optional
// result limit. Returns an array of contact summaries.
//
// Default behavior: excludes kind='automated' and kind='agent' from results.
// Pass kind='automated' or kind='agent' explicitly to include them.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ContactStatus, ContactKind } from '../../src/contacts/types.js';

const VALID_STATUSES: readonly ContactStatus[] = ['confirmed', 'provisional', 'blocked'];
const VALID_KINDS: readonly ContactKind[] = ['person', 'organization', 'automated', 'principal', 'agent'];

// Default People-view filter: excludes automated and agent contacts.
const DEFAULT_KIND_FILTER: ContactKind[] = ['person', 'principal', 'organization'];

export class ContactListHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { role, status, kind: kindInput, limit, offset } = ctx.input as unknown as {
      role?: string;
      status?: string;
      kind?: string | string[];
      limit?: number;
      offset?: number;
    };

    // ---- Input validation ----

    if (role && typeof role === 'string' && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }

    // Guard against LLM mistake: passing a lifecycle status as the role param.
    const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : undefined;
    if (normalizedRole && (VALID_STATUSES as readonly string[]).includes(normalizedRole)) {
      return {
        success: false,
        error: `"${role}" is a contact lifecycle status, not a job title. Use the status parameter instead: { status: "${normalizedRole}" }`,
      };
    }

    if (status != null && !(VALID_STATUSES as readonly string[]).includes(status)) {
      return { success: false, error: `Invalid status: "${status}". Must be one of: ${VALID_STATUSES.join(', ')}` };
    }

    // Parse kind: accept a single string or comma-separated list.
    let kindFilter: ContactKind[] | undefined;
    if (kindInput != null) {
      const rawKinds = Array.isArray(kindInput)
        ? kindInput
        : String(kindInput).split(',').map((k) => k.trim());
      for (const k of rawKinds) {
        if (!(VALID_KINDS as readonly string[]).includes(k)) {
          return { success: false, error: `Invalid kind: "${k}". Must be one of: ${VALID_KINDS.join(', ')}` };
        }
      }
      kindFilter = rawKinds as ContactKind[];
    }

    if (limit != null) {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        return { success: false, error: 'Limit must be a positive integer' };
      }
    }

    if (offset != null) {
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        return { success: false, error: 'Offset must be a non-negative integer' };
      }
      if (offset > 0 && limit == null) {
        return { success: false, error: 'Offset requires limit to be set. Use limit together with offset for pagination.' };
      }
    }

    if (role && typeof role === 'string' && (status != null || limit != null || offset != null)) {
      return { success: false, error: 'Cannot combine role filter with status, limit, or offset. Use role alone, or status/limit/offset without role.' };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-list: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    // When no kind is specified, default to the People view (excludes automated and agent).
    const effectiveKindFilter = kindFilter ?? DEFAULT_KIND_FILTER;

    ctx.log.info(
      { role: role ?? '(all)', status: status ?? '(all)', kind: effectiveKindFilter, limit: limit ?? '(none)', offset: offset ?? 0 },
      'Listing contacts',
    );

    try {
      const contacts = role && typeof role === 'string'
        ? await ctx.contactService.findContactByRole(role)
        : await ctx.contactService.listContacts({
            status: status as ContactStatus | undefined,
            kind: effectiveKindFilter,
            limit,
            offset,
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
      ctx.log.error({ err, role, status, limit, offset }, 'Failed to list contacts');
      return { success: false, error: `Failed to list contacts: ${message}` };
    }
  }
}
```

- [ ] **Step 6: Update `skill.json` to document the `kind` input and bump version**

In `skills/contact-list/skill.json`, update `inputs` and bump `version`:

```json
{
  "name": "contact-list",
  "description": "List contacts, optionally filtered by role, status, or kind, with optional result limit and offset for pagination. By default returns only person, principal, and organization contacts (excludes automated senders and agents).",
  "version": "1.3.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "role": "string? (filter by job title / professional role, e.g. 'CEO', 'CFO', 'Engineer'; mutually exclusive with status, limit, and offset; this is NOT a lifecycle status)",
    "status": "string? (confirmed | provisional | blocked)",
    "kind": "string? (person | organization | automated | principal | agent, or comma-separated list; defaults to person,principal,organization — pass kind=automated to see automated senders)",
    "limit": "number?",
    "offset": "number? (skip this many contacts; use with limit for cursor-based pagination)"
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

- [ ] **Step 7: Run tests and confirm they pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test skills/contact-list/handler.test.ts
```

Expected: all three new assertions PASS.

- [ ] **Step 8: Run typecheck and full suite**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender run typecheck
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test
```

Expected: no errors, no regressions.

- [ ] **Step 9: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender add src/contacts/contact-service.ts skills/contact-list/handler.ts skills/contact-list/skill.json skills/contact-list/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender commit -m "feat: add kind filter to contact-list skill; exclude automated by default (#953)

listContacts() gains a kind[] filter at the backend, service, and skill handler
layers. The contact-list skill defaults to kind=[person,principal,organization],
so automated senders and agents are excluded from the People view unless
explicitly requested with kind=automated."
```

---

### Task 7: CHANGELOG and final verification

**Files:**
- Modify: `CHANGELOG.md`

---

- [ ] **Step 1: Add entries under `## [Unreleased]` in CHANGELOG.md**

```markdown
### Added
- **Automated sender classification** — `classifyEmailSender()` now returns `'automated'` for noreply, mailer-daemon, bounce, newsletter, and related machine-address patterns; classified at contact-creation time so they never appear as people in the contact ledger. (#953)
- **`contact-list` skill `kind` filter** — skill now accepts `kind` to filter by contact kind; default view excludes `automated` and `agent` contacts. (#953)

### Changed
- **ceo-inbox agent** (v0.7.0 → v0.8.0) — automated senders (`kind: automated`) default to ✔️ Cleared; still escalated on actionable signals (fraud, payment failure, bounce, hard deadline). (#953)
- **`contact-list` skill** (v1.2.1 → v1.3.0) — default result set now excludes automated and agent contacts; pass `kind=automated` to see them. (#953)
```

- [ ] **Step 2: Final typecheck across the entire worktree**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Final full test run**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-automated-sender commit -m "chore: CHANGELOG entries for #953 automated sender class"
```

---

## Acceptance criteria checklist

Before creating the PR, verify:

- [ ] `noreply@github.com`, `no-reply@stripe.com`, `mailer-daemon@googlemail.com`, `notifications@slack.com` all return `'automated'` from `classifyEmailSender()`
- [ ] A new contact created with a noreply email has `kind='automated'` and no org KG node linked
- [ ] Migration 057 ran clean; `SELECT COUNT(*) FROM contacts WHERE kind='automated'` shows the expected backfill count
- [ ] An automated sender with `tier='unknown'` reaches the coordinator even when `unknownSender='ignore'` channel policy is set
- [ ] Calling the `contact-list` skill with no params does not return automated contacts
- [ ] Calling the `contact-list` skill with `kind=automated` returns automated contacts
- [ ] ceo-inbox YAML version is `0.8.0`
- [ ] Typecheck and full test suite pass
