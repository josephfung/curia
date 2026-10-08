# Contact-first outreach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the raw-address send fields. Cold outreach then creates a contact first, and addresses an agent enters get their own source, `agent_stated`, which is verified only after a duplicate check that runs before anything is written (#2041).

**Architecture:** The work goes bottom-up:
1. Two pure modules, an identifier normalizer and a near-miss matcher.
2. A `ContactService.findLikelyDuplicates` read that both contact skills call before writing.
3. The contact skills, then the resolver and execution layer, the Gate C parsers, the four send skills and `email-draft-save`, in that order. Each moves to references only.
4. The coordinator pin, the end-to-end tests and scenarios, and the docs.

The OutboundGateway still takes addresses. Only skill inputs change.

**Tech Stack:** TypeScript (ESM, Node 24), Vitest, pino, PostgreSQL (`node-pg-migrate`; this plan adds no migration), libphonenumber-js via `normalizePhone`.

**Spec:** `docs/wip/2026-10-07-contact-first-outreach-design.md`. Read it before starting. ADR-047 (`docs/adr/047-send-skills-address-recipients-by-reference.md`) is the background.

## Global Constraints

- Worktree: `/Users/josephfung/Projects/curia/worktrees/curia-feat-contact-first-outreach`, branch `feat/contact-first-outreach`. Run every command from there with `-C` (`git -C <wt>`, `pnpm -C <wt>`).
- A shell hook blocks `&&`, `||` and `xargs`. Run commands separately or join them with `;`.
- **Commits:**
  - Every commit uses `git commit -s` (DCO `Signed-off-by` is required by CI).
  - Never add a `Co-Authored-By` trailer or any AI attribution, in commits or PR bodies.
  - Commit subjects follow the repo's `type(scope): summary (#2041)` style.
- **Run tests:** `pnpm -C <wt> exec vitest run <path>`.
- **Typecheck:** `pnpm -C <wt> run typecheck`. Run it before every commit that touches `.ts`.
- **Lint:** `pnpm -C <wt> run lint`. It covers `src/`, `tests/` and `apps/`.
- **Code style:**
  - ESM, with `.js` on relative imports.
  - No `any`.
  - Skills return `{ success: true, data }` or `{ success: false, error }` and never throw.
  - No `console.log`; use pino.
  - No empty `catch {}`: every catch logs and propagates or returns an error.
- **Agent-facing error rules:**
  - Never include a stored address or number. A model handed one will retype it.
  - Never include the principal's contact ID. Name the principal as `the principal`, with the alias `principal` (spec 09).
- **Manifests:**
  - No `${...}` anywhere in a `tool.json` (a test fails the build).
  - Version bumps: a new or removed input field is a **minor** bump. A description-only change is a **patch** bump.
- **CHANGELOG bullets:** `- **Name** — description. (#2041)`, with at most **15 words** after the em-dash.

## Review Focus

Five inputs or failure modes that no ordinary happy-path test exercises, but a real agent will produce. Each has a test in the task that owns the code:

1. **A blank retired field.** For example `{ to: "<id>", to_address: "" }`. Models fill unused optional fields with `""`. It must not be refused. *(Task 5, Task 7)*
2. **An approval stored before the deploy, replayed with `to_address`.** It must be refused with the retired-field message, and nothing sent, even with `humanApproved: true`. *(Task 5)*
3. **A duplicate candidate whose display name is an address.** Gateway-created contacts are named after their address. The refusal must list the candidate by ID only, never echoing the address. *(Task 3)*
4. **A number in the fictional 555 area code** (`+15555550199`). `normalizePhone` returns `null` for it, but it is valid E.164 and must be kept as typed, not refused. *(Task 1)*
5. **Re-stating a number in a different format** (`+1 (416) 555-0100` when `+14165550100` is stored). It must find the stored identity, not create a second one. *(Task 4)*

---

## Task 1: Identifier normalizer and near-miss matcher

Two pure modules with no I/O. Both contact skills normalize agent input with `normalizeAgentIdentifier`. The duplicate check (Task 2) compares identifiers with `sameIdentifier` and `isNearMiss`.

**Files:**
- Create: `src/contacts/identifier-near-miss.ts`
- Create: `src/contacts/agent-identifier.ts`
- Test: `tests/unit/contacts/identifier-near-miss.test.ts`
- Test: `tests/unit/contacts/agent-identifier.test.ts`

**Interfaces:**
- Consumes: `normalizePhone(value: string): string | null` from `src/contacts/canonical-attribute-guard.ts`.
- Produces:
  - `PHONE_CHANNELS: ReadonlySet<string>`
  - `identifierFamily(channel: string): 'email' | 'phone' | 'opaque'`
  - `comparableChannels(channel: string): string[]`
  - `phoneDigits(value: string): string`
  - `osaDistance(a: string, b: string, max: number): number`
  - `isNearMiss(channel: string, candidate: string, existing: string): boolean`
  - `sameIdentifier(channel: string, a: string, b: string): boolean`
  - `normalizeAgentIdentifier(channel: string, raw: string): { ok: true; identifier: string } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing near-miss tests**

`tests/unit/contacts/identifier-near-miss.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  comparableChannels,
  identifierFamily,
  isNearMiss,
  osaDistance,
  sameIdentifier,
} from '../../../src/contacts/identifier-near-miss.js';

describe('osaDistance', () => {
  it('counts substitutions, insertions, deletions and adjacent swaps', () => {
    expect(osaDistance('abc', 'abc', 2)).toBe(0);
    expect(osaDistance('abc', 'abd', 2)).toBe(1);
    expect(osaDistance('abc', 'abcd', 2)).toBe(1);
    expect(osaDistance('abc', 'acb', 2)).toBe(1);
    expect(osaDistance('kitten', 'sitting', 3)).toBe(3);
  });

  it('returns max + 1 when the lengths alone rule it out', () => {
    expect(osaDistance('a', 'abcd', 2)).toBe(3);
  });

  it('never reports more than max + 1', () => {
    expect(osaDistance('abcdef', 'uvwxyz', 2)).toBe(3);
  });
});

describe('identifierFamily / comparableChannels', () => {
  it('groups the phone channels and keeps the others apart', () => {
    expect(identifierFamily('email')).toBe('email');
    expect(identifierFamily('sms')).toBe('phone');
    expect(identifierFamily('slack')).toBe('opaque');
    expect(comparableChannels('signal').sort()).toEqual(['phone', 'signal', 'sms']);
    expect(comparableChannels('email')).toEqual(['email']);
    expect(comparableChannels('slack')).toEqual(['slack']);
  });
});

describe('isNearMiss', () => {
  it('catches both ADR-047 email incidents', () => {
    // .com for .ca: distance 2 on a 20-character address.
    expect(isNearMiss('email', 'joseph@josephfung.com', 'joseph@josephfung.ca')).toBe(true);
    // A dot inserted into the domain: distance 1.
    expect(isNearMiss('email', 'joseph@joseph.fung.ca', 'joseph@josephfung.ca')).toBe(true);
  });

  it('is case-insensitive for email and never matches an identical address', () => {
    expect(isNearMiss('email', 'Joseph@JosephFung.ca', 'joseph@josephfung.ca')).toBe(false);
  });

  it('allows only one edit when the shorter address has fewer than 12 characters', () => {
    expect(isNearMiss('email', 'el@x.io', 'al@x.io')).toBe(true);
    expect(isNearMiss('email', 'ed@x.io', 'al@x.io')).toBe(false);
  });

  it('does not match addresses three edits apart', () => {
    expect(isNearMiss('email', 'pat@example.test', 'priya@example.test')).toBe(false);
  });

  it('catches a one-digit number slip across the phone channels, and ignores formatting', () => {
    expect(isNearMiss('sms', '+14165550101', '+14165550100')).toBe(true);
    expect(isNearMiss('signal', '+14165550010', '+14165550100')).toBe(true); // adjacent swap
    expect(isNearMiss('sms', '+1 (416) 555-0100', '+14165550100')).toBe(false); // same number
    expect(isNearMiss('sms', '+14165559999', '+14165550100')).toBe(false);
  });

  it('never flags opaque ids', () => {
    expect(isNearMiss('slack', 'U012ABCDEG', 'U012ABCDEF')).toBe(false);
    expect(isNearMiss('telegram', 'patp', 'pat')).toBe(false);
  });
});

describe('sameIdentifier', () => {
  it('compares email case-insensitively, numbers by digits, and other ids exactly', () => {
    expect(sameIdentifier('email', 'Pat@Example.test', 'pat@example.test')).toBe(true);
    expect(sameIdentifier('sms', '+1 (416) 555-0100', '+14165550100')).toBe(true);
    expect(sameIdentifier('slack', 'U012ABCDEF', 'u012abcdef')).toBe(false);
    expect(sameIdentifier('sms', '', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing normalizer tests**

`tests/unit/contacts/agent-identifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeAgentIdentifier } from '../../../src/contacts/agent-identifier.js';

describe('normalizeAgentIdentifier', () => {
  it('lowercases and trims an email address', () => {
    expect(normalizeAgentIdentifier('email', '  Dana.Whitfield@NewCo.example ')).toEqual({
      ok: true,
      identifier: 'dana.whitfield@newco.example',
    });
  });

  it('refuses something that is not an email address, without echoing it', () => {
    const result = normalizeAgentIdentifier('email', 'dana at newco');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/email address/);
      expect(result.error).not.toContain('dana at newco');
    }
  });

  it.each(['phone', 'signal', 'sms'])('normalizes a %s number to E.164', (channel) => {
    expect(normalizeAgentIdentifier(channel, '(416) 555-0100')).toEqual({ ok: true, identifier: '+14165550100' });
    expect(normalizeAgentIdentifier(channel, '+44 20 7946 0958')).toEqual({ ok: true, identifier: '+442079460958' });
  });

  it('keeps a valid E.164 number the phone library does not recognise (Review Focus 4)', () => {
    // normalizePhone() returns null for the fictional 555 area code.
    expect(normalizeAgentIdentifier('sms', '+15555550199')).toEqual({ ok: true, identifier: '+15555550199' });
  });

  it('refuses a value that is not a phone number', () => {
    const result = normalizeAgentIdentifier('sms', 'call me');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/international form/);
  });

  it('accepts Slack user ids (U… and W…) and refuses names and handles', () => {
    expect(normalizeAgentIdentifier('slack', 'U012ABCDEF')).toEqual({ ok: true, identifier: 'U012ABCDEF' });
    expect(normalizeAgentIdentifier('slack', 'W012ABCDEF')).toEqual({ ok: true, identifier: 'W012ABCDEF' });
    expect(normalizeAgentIdentifier('slack', '@pat').ok).toBe(false);
    expect(normalizeAgentIdentifier('slack', 'u012abcdef').ok).toBe(false);
  });

  it('passes other channels through trimmed, and refuses a blank value', () => {
    expect(normalizeAgentIdentifier('telegram', ' patp ')).toEqual({ ok: true, identifier: 'patp' });
    expect(normalizeAgentIdentifier('email', '   ').ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run both test files to see them fail**

Run: `pnpm -C <wt> exec vitest run tests/unit/contacts/identifier-near-miss.test.ts tests/unit/contacts/agent-identifier.test.ts`
Expected: FAIL. Both modules are missing ("Failed to load url" / "Cannot find module").

- [ ] **Step 4: Implement `src/contacts/identifier-near-miss.ts`**

```ts
// identifier-near-miss.ts — is a new channel identifier a likely mistyping of one
// already on file? (#2041)
//
// contact-create and contact-link-identity run this before an agent-entered address
// is stored. A hit is not a refusal on its own: the agent is shown the contact it
// resembles and decides (distinct_from). The bounds catch the ADR-047 incidents —
// `.com` for `.ca` is distance 2, an inserted dot distance 1 — while two short
// addresses at one domain (al@x.io, ed@x.io) stay apart.
//
// Slack and Telegram ids are opaque: one character different is a different
// account, not a typo worth flagging. They are only ever matched exactly.

/** Channels whose identifiers are phone numbers. A number is compared across all of them. */
export const PHONE_CHANNELS: ReadonlySet<string> = new Set(['phone', 'signal', 'sms']);

/** Email addresses shorter than this tolerate one edit, not two. */
const SHORT_EMAIL_CHARS = 12;

export type IdentifierFamily = 'email' | 'phone' | 'opaque';

export function identifierFamily(channel: string): IdentifierFamily {
  if (channel === 'email') return 'email';
  if (PHONE_CHANNELS.has(channel)) return 'phone';
  return 'opaque';
}

/** The channels an identifier on `channel` is compared against for duplicates. */
export function comparableChannels(channel: string): string[] {
  return identifierFamily(channel) === 'phone' ? [...PHONE_CHANNELS] : [channel];
}

/** Digits only, so `+1 (416) 555-0100` and `+14165550100` compare equal. */
export function phoneDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Optimal string alignment distance: Levenshtein plus one adjacent transposition.
 * Returns `max + 1` when the length difference alone exceeds `max`, and never more
 * than `max + 1`, so callers compare against `max`.
 */
export function osaDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  // d[i][j] is the distance between a's first i characters and b's first j.
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j++) d[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
    }
  }
  return Math.min(d[rows - 1]![cols - 1]!, max + 1);
}

/**
 * True when `candidate` is within a typo of `existing` and not the same identifier.
 * Both must be in the same family (the caller compares within comparableChannels).
 * An identical identifier is an exact match, which the caller handles separately.
 */
export function isNearMiss(channel: string, candidate: string, existing: string): boolean {
  const family = identifierFamily(channel);
  if (family === 'email') {
    const a = candidate.toLowerCase();
    const b = existing.toLowerCase();
    if (a === b) return false;
    const max = Math.min(a.length, b.length) < SHORT_EMAIL_CHARS ? 1 : 2;
    return osaDistance(a, b, max) <= max;
  }
  if (family === 'phone') {
    const a = phoneDigits(candidate);
    const b = phoneDigits(existing);
    if (a.length === 0 || b.length === 0 || a === b) return false;
    return osaDistance(a, b, 1) <= 1;
  }
  return false;
}

/** The same identifier for duplicate purposes: email ignoring case, numbers by digits, the rest exactly. */
export function sameIdentifier(channel: string, a: string, b: string): boolean {
  const family = identifierFamily(channel);
  if (family === 'email') return a.toLowerCase() === b.toLowerCase();
  if (family === 'phone') {
    const digits = phoneDigits(a);
    return digits.length > 0 && digits === phoneDigits(b);
  }
  return a === b;
}
```

- [ ] **Step 5: Implement `src/contacts/agent-identifier.ts`**

```ts
// agent-identifier.ts — validate and normalize an identifier an agent typed into
// contact-create or contact-link-identity (#2041).
//
// Normalizing before the duplicate check means `+1 (416) 555-0100` finds the stored
// `+14165550100`. It also stores the identifier in the shape the send skills
// address: a number kept as `(416) 555-0100` would be skipped as unsendable at the
// first send.

import { normalizePhone } from './canonical-attribute-guard.js';
import { PHONE_CHANNELS } from './identifier-near-miss.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;
/** Slack user ids: U… (standard) or W… (Enterprise Grid). Case-sensitive, as Slack issues them. */
const SLACK_USER_ID_REGEX = /^[UW][A-Z0-9]+$/;

export type NormalizedIdentifier =
  | { ok: true; identifier: string }
  | { ok: false; error: string };

/**
 * The stored form of `raw` on `channel`, or an agent-facing error. The error names
 * the input and the expected shape, never the value.
 */
export function normalizeAgentIdentifier(channel: string, raw: string): NormalizedIdentifier {
  const value = raw.trim();
  if (!value) return { ok: false, error: `${channel} is empty.` };

  if (channel === 'email') {
    const lower = value.toLowerCase();
    return EMAIL_REGEX.test(lower)
      ? { ok: true, identifier: lower }
      : { ok: false, error: 'email must be an email address (name@domain).' };
  }

  if (PHONE_CHANNELS.has(channel)) {
    // A valid E.164 number the phone library does not recognise (a new range, a
    // fictional 555 area code) is kept as typed rather than refused.
    const normalized = normalizePhone(value) ?? (E164_REGEX.test(value) ? value : null);
    return normalized
      ? { ok: true, identifier: normalized }
      : { ok: false, error: `${channel} must be a phone number in international form, such as +14155552671.` };
  }

  if (channel === 'slack') {
    return SLACK_USER_ID_REGEX.test(value)
      ? { ok: true, identifier: value }
      : { ok: false, error: 'slack must be a Slack user id (U… or W…), not a name or handle.' };
  }

  return { ok: true, identifier: value };
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm -C <wt> exec vitest run tests/unit/contacts/identifier-near-miss.test.ts tests/unit/contacts/agent-identifier.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm -C <wt> run typecheck
pnpm -C <wt> run lint
git -C <wt> add src/contacts/identifier-near-miss.ts src/contacts/agent-identifier.ts tests/unit/contacts/identifier-near-miss.test.ts tests/unit/contacts/agent-identifier.test.ts
git -C <wt> commit -s -m "feat(contacts): normalize agent-entered identifiers and detect near-miss ones (#2041)"
```

---

## Task 2: `agent_stated` source and `ContactService.findLikelyDuplicates`

This task adds the provenance source and the read that both contact skills run before writing. It also adds a backend method that lists identities on a set of channels, in both backends (Postgres and in-memory are the only implementers of `ContactServiceBackend`).

**Files:**
- Modify: `src/contacts/types.ts`
  - add `'agent_stated'` to `IdentitySource` (after `'agent_called'`);
  - add the `DuplicateReason`, `DuplicateCandidate` and `DuplicateCheck` types.
- Modify: `src/contacts/contact-service.ts`
  - add `'agent_stated'` to `AUTO_VERIFIED_SOURCES` (around line 276) and update the comment above it;
  - add `listIdentitiesOnChannels` to the `ContactServiceBackend` interface (around line 164), to `PostgresContactBackend` (after `getIdentitiesForContact`, around line 2344) and to `InMemoryContactBackend` (after `getIdentitiesForContact`, around line 3184);
  - add `findLikelyDuplicates` to `ContactService` (after `findDuplicates`, around line 920).
- Test: `tests/unit/contacts/find-likely-duplicates.test.ts` (new)
- Test: `tests/integration/contacts.test.ts`: add one Postgres case.

**Interfaces:**
- Consumes (Task 1): `comparableChannels`, `isNearMiss`, `sameIdentifier` from `src/contacts/identifier-near-miss.ts`.
- Produces:
  - `IdentitySource` gains `'agent_stated'`, auto-verified.
  - `ContactService.findLikelyDuplicates(input: { displayName?: string; identities: ReadonlyArray<{ channel: string; identifier: string }>; excludeContactId?: string }): Promise<DuplicateCheck>`
  - Types from `src/contacts/types.ts`:
    ```ts
    export type DuplicateReason =
      | { kind: 'same_name' }
      | { kind: 'similar_address'; channel: string }
      | { kind: 'same_number'; channel: string };
    export interface DuplicateCandidate { contact: Contact; reasons: DuplicateReason[] }
    export interface DuplicateCheck {
      taken: Array<{ contact: Contact; channel: string }>;
      candidates: DuplicateCandidate[];
    }
    ```

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/contacts/find-likely-duplicates.test.ts`:

```ts
// The duplicate check contact-create and contact-link-identity run before an
// agent-entered address is stored (#2041). One test per row of the spec's table.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';

describe('ContactService.findLikelyDuplicates', () => {
  let contacts: ContactService;
  let priyaId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya@example.test', source: 'ceo_stated' });
    await contacts.linkIdentity({ contactId: priya.id, channel: 'signal', channelIdentifier: '+14165550100', source: 'ceo_stated' });
  });

  it('reports an identifier another contact holds on the same channel as taken (email ignores case)', async () => {
    const check = await contacts.findLikelyDuplicates({ identities: [{ channel: 'email', identifier: 'PRIYA@example.test' }] });
    expect(check.taken).toHaveLength(1);
    expect(check.taken[0]!.contact.id).toBe(priyaId);
    expect(check.taken[0]!.channel).toBe('email');
    // A taken contact is reported once, as taken, not also as a candidate.
    expect(check.candidates).toEqual([]);
  });

  it('compares numbers by digits, so formatting does not hide a taken number', async () => {
    const check = await contacts.findLikelyDuplicates({ identities: [{ channel: 'signal', identifier: '+1 (416) 555-0100' }] });
    expect(check.taken.map((t) => t.contact.id)).toEqual([priyaId]);
  });

  it('reports the same number on a sibling phone channel as a candidate', async () => {
    const check = await contacts.findLikelyDuplicates({ identities: [{ channel: 'sms', identifier: '+14165550100' }] });
    expect(check.taken).toEqual([]);
    expect(check.candidates).toEqual([
      { contact: expect.objectContaining({ id: priyaId }), reasons: [{ kind: 'same_number', channel: 'signal' }] },
    ]);
  });

  it('reports a near-miss email and a near-miss number as similar_address', async () => {
    const email = await contacts.findLikelyDuplicates({ identities: [{ channel: 'email', identifier: 'priya@exmaple.test' }] });
    expect(email.candidates[0]?.reasons).toEqual([{ kind: 'similar_address', channel: 'email' }]);
    const number = await contacts.findLikelyDuplicates({ identities: [{ channel: 'sms', identifier: '+14165550101' }] });
    expect(number.candidates[0]?.reasons).toEqual([{ kind: 'similar_address', channel: 'signal' }]);
  });

  it('reports the same display name, ignoring case and spacing', async () => {
    const check = await contacts.findLikelyDuplicates({ displayName: '  priya   NATARAJAN ', identities: [] });
    expect(check.candidates).toEqual([
      { contact: expect.objectContaining({ id: priyaId }), reasons: [{ kind: 'same_name' }] },
    ]);
  });

  it('does not report a name that only contains the other', async () => {
    const check = await contacts.findLikelyDuplicates({ displayName: 'Priya', identities: [] });
    expect(check.candidates).toEqual([]);
  });

  it('collects every reason for one contact in one candidate', async () => {
    const check = await contacts.findLikelyDuplicates({
      displayName: 'Priya Natarajan',
      identities: [{ channel: 'email', identifier: 'priya@exmaple.test' }],
    });
    expect(check.candidates).toHaveLength(1);
    expect(check.candidates[0]!.reasons).toEqual([
      { kind: 'similar_address', channel: 'email' },
      { kind: 'same_name' },
    ]);
  });

  it('never reports the contact being added to', async () => {
    const check = await contacts.findLikelyDuplicates({
      identities: [{ channel: 'email', identifier: 'priya@example.test' }],
      excludeContactId: priyaId,
    });
    expect(check).toEqual({ taken: [], candidates: [] });
  });

  it('matches Slack ids exactly and never as a near miss', async () => {
    await contacts.linkIdentity({ contactId: priyaId, channel: 'slack', channelIdentifier: 'U012ABCDEF', source: 'ceo_stated' });
    const near = await contacts.findLikelyDuplicates({ identities: [{ channel: 'slack', identifier: 'U012ABCDEG' }] });
    expect(near).toEqual({ taken: [], candidates: [] });
    const exact = await contacts.findLikelyDuplicates({ identities: [{ channel: 'slack', identifier: 'U012ABCDEF' }] });
    expect(exact.taken.map((t) => t.contact.id)).toEqual([priyaId]);
  });

  it('returns nothing for a name-less, identity-less check', async () => {
    expect(await contacts.findLikelyDuplicates({ identities: [] })).toEqual({ taken: [], candidates: [] });
  });
});

describe('agent_stated identities', () => {
  it('are verified on link', async () => {
    const contacts = ContactService.createInMemory();
    const c = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'agent_stated' });
    const identity = await contacts.linkIdentity({
      contactId: c.id, channel: 'email', channelIdentifier: 'dana@newco.example', source: 'agent_stated',
    });
    expect(identity).toMatchObject({ source: 'agent_stated', verified: true });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm -C <wt> exec vitest run tests/unit/contacts/find-likely-duplicates.test.ts`
Expected: FAIL with `contacts.findLikelyDuplicates is not a function`. This step also produces a typecheck error on `'agent_stated'`.

- [ ] **Step 3: Add the source and the types to `src/contacts/types.ts`**

In `IdentitySource`, after the `'agent_called'` member:

```ts
  // Contact or address an agent entered with contact-create or contact-link-identity
  // (#2041). An agent typed it, so it is not the principal's own statement (ceo_stated).
  // Auto-verified once the duplicate check before the write passes; see ADR-047.
  | 'agent_stated'
```

After the `DuplicatePair` interface, add:

```ts
/** Why an existing contact may be the person an agent is about to add (#2041). */
export type DuplicateReason =
  | { kind: 'same_name' }
  | { kind: 'similar_address'; channel: string }
  | { kind: 'same_number'; channel: string };

export interface DuplicateCandidate {
  contact: Contact;
  /** In the order found: identity reasons first, then the name. */
  reasons: DuplicateReason[];
}

/**
 * Result of ContactService.findLikelyDuplicates. `taken` blocks the write outright:
 * another contact already holds the identifier on that channel. `candidates` block
 * it until the agent names each one in distinct_from.
 */
export interface DuplicateCheck {
  taken: Array<{ contact: Contact; channel: string }>;
  candidates: DuplicateCandidate[];
}
```

- [ ] **Step 4: Auto-verify `agent_stated` in `src/contacts/contact-service.ts`**

Replace the `AUTO_VERIFIED_SOURCES` comment block and set (around lines 265–284) with:

```ts
// -- Auto-verification sources --
// Per spec: ceo_stated, email_participant, crm_import, calendar_attendee are auto-verified.
// signal_participant is also auto-verified — Signal's phone-number identity is stronger than
// email (no header spoofing), so we trust the source number at the same level as email_participant.
// slack_participant is auto-verified — Slack user ids from the principal's workspace (ADR-033).
// sms_participant is NOT auto-verified — SMS From is spoofable (ADR-036); principal must verify.
// agent_called is auto-verified — the agent extracted the identifier mechanically from the channel
// (e.g. an email sender address), not from LLM-generated content. Same trust level as email_participant.
// agent_stated is auto-verified — contact-create and contact-link-identity write it only after the
// duplicate check passes (findLikelyDuplicates), and every send reaches it by reference afterwards,
// so the agent types it once, in a checked place (#2041, ADR-047).
// outbound_recipient is NOT auto-verified — the address came from LLM-generated tool input on a
// first-time send, the opposite of a mechanical extraction (#2033, ADR-047). An agent re-stating it
// with contact-link-identity verifies it (#2041).
// Only self_claimed cannot be force-verified.
const AUTO_VERIFIED_SOURCES: ReadonlySet<IdentitySource> = new Set([
  'ceo_stated',
  'email_participant',
  'signal_participant',
  'slack_participant',
  'crm_import',
  'calendar_attendee',
  'agent_called',
  'agent_stated',
]);
```

- [ ] **Step 5: Add `listIdentitiesOnChannels` to the backend interface and both backends**

In `interface ContactServiceBackend`, after `getIdentitiesForContact(contactId: string): Promise<ChannelIdentity[]>;`:

```ts
  /** Every identity on any of these channels, for the duplicate check (#2041). */
  listIdentitiesOnChannels(channels: string[]): Promise<ChannelIdentity[]>;
```

In `PostgresContactBackend`, after `getIdentitiesForContact`:

```ts
  async listIdentitiesOnChannels(channels: string[]): Promise<ChannelIdentity[]> {
    if (channels.length === 0) return [];
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
       FROM contact_channel_identities WHERE channel = ANY($1::text[])`,
      [channels],
    );
    return result.rows.map((row) => this.rowToIdentity(row));
  }
```

In `InMemoryContactBackend`, after `getIdentitiesForContact`:

```ts
  async listIdentitiesOnChannels(channels: string[]): Promise<ChannelIdentity[]> {
    const wanted = new Set(channels);
    return [...this.identities.values()].filter((identity) => wanted.has(identity.channel));
  }
```

- [ ] **Step 6: Add `findLikelyDuplicates` to `ContactService`**

Add these imports at the top of `contact-service.ts`, next to the existing `./types.js` imports:

```ts
import { comparableChannels, isNearMiss, sameIdentifier } from './identifier-near-miss.js';
```

Add `DuplicateCandidate`, `DuplicateCheck` and `DuplicateReason` to the existing `import type { … } from './types.js'` list.

Add the method after `findDuplicates`:

```ts
  /**
   * Contacts that an agent-entered contact or address may duplicate (#2041).
   * contact-create and contact-link-identity call this before writing anything.
   *
   * - taken: an identifier is already on another contact on the same channel (email
   *   ignoring case, numbers by digits). The write is refused outright.
   * - candidates: the same number on a sibling phone channel, a near-miss identifier
   *   (identifier-near-miss.ts), or the same display name ignoring case and spacing.
   *   The write is refused until the agent names each one in distinct_from.
   *
   * `identities` must already be normalized (normalizeAgentIdentifier).
   * `excludeContactId` is the contact being added to, which is never its own duplicate.
   * Errors propagate: callers refuse the write rather than skip the check.
   */
  async findLikelyDuplicates(input: {
    displayName?: string;
    identities: ReadonlyArray<{ channel: string; identifier: string }>;
    excludeContactId?: string;
  }): Promise<DuplicateCheck> {
    const channels = new Set(input.identities.flatMap((wanted) => comparableChannels(wanted.channel)));
    const onFile = channels.size > 0 ? await this.backend.listIdentitiesOnChannels([...channels]) : [];

    const takenChannel = new Map<string, string>();
    const reasons = new Map<string, DuplicateReason[]>();
    const addReason = (contactId: string, reason: DuplicateReason): void => {
      const list = reasons.get(contactId) ?? [];
      const key = (r: DuplicateReason): string => `${r.kind}:${'channel' in r ? r.channel : ''}`;
      if (!list.some((existing) => key(existing) === key(reason))) list.push(reason);
      reasons.set(contactId, list);
    };

    for (const wanted of input.identities) {
      const family = comparableChannels(wanted.channel);
      for (const held of onFile) {
        if (held.contactId === input.excludeContactId || !family.includes(held.channel)) continue;
        if (sameIdentifier(wanted.channel, wanted.identifier, held.channelIdentifier)) {
          if (held.channel === wanted.channel) {
            if (!takenChannel.has(held.contactId)) takenChannel.set(held.contactId, wanted.channel);
          } else {
            addReason(held.contactId, { kind: 'same_number', channel: held.channel });
          }
        } else if (isNearMiss(wanted.channel, wanted.identifier, held.channelIdentifier)) {
          addReason(held.contactId, { kind: 'similar_address', channel: held.channel });
        }
      }
    }

    if (input.displayName !== undefined) {
      const comparable = (name: string): string => name.toLowerCase().replace(/\s+/g, ' ').trim();
      const wantedName = comparable(sanitizeDisplayName(input.displayName));
      if (wantedName) {
        // findContactByName is a substring match; keep exact (normalized) names only.
        for (const contact of await this.backend.findContactByName(wantedName)) {
          if (contact.id !== input.excludeContactId && comparable(contact.displayName) === wantedName) {
            addReason(contact.id, { kind: 'same_name' });
          }
        }
      }
    }

    const taken: DuplicateCheck['taken'] = [];
    for (const [contactId, channel] of takenChannel) {
      // A taken contact is reported once, as taken.
      reasons.delete(contactId);
      const contact = await this.backend.getContact(contactId);
      if (contact) taken.push({ contact, channel });
    }
    const candidates: DuplicateCandidate[] = [];
    for (const [contactId, list] of reasons) {
      const contact = await this.backend.getContact(contactId);
      if (contact) candidates.push({ contact, reasons: list });
    }
    return { taken, candidates };
  }
```

- [ ] **Step 7: Add the Postgres case to `tests/integration/contacts.test.ts`**

Add this inside the top-level `describeIf('Contacts Integration', …)` block, after the existing tests:

```ts
  it('findLikelyDuplicates reads identities across channels from Postgres (#2041)', async () => {
    const holder = await contactService.createContact({ displayName: 'Dup Check Holder', source: 'integration-test' });
    await contactService.linkIdentity({
      contactId: holder.id, channel: 'email', channelIdentifier: 'dup.check.holder@example.test', source: 'ceo_stated',
    });
    await contactService.linkIdentity({
      contactId: holder.id, channel: 'signal', channelIdentifier: '+14165550177', source: 'ceo_stated',
    });

    const check = await contactService.findLikelyDuplicates({
      identities: [
        { channel: 'email', identifier: 'dup.check.holder@example.tset' },
        { channel: 'sms', identifier: '+14165550177' },
      ],
    });

    expect(check.taken).toEqual([]);
    const candidate = check.candidates.find((c) => c.contact.id === holder.id);
    expect(candidate?.reasons).toEqual([
      { kind: 'similar_address', channel: 'email' },
      { kind: 'same_number', channel: 'signal' },
    ]);
  });
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm -C <wt> exec vitest run tests/unit/contacts/find-likely-duplicates.test.ts`
Expected: PASS.

Run: `pnpm -C <wt> exec vitest run tests/integration/contacts.test.ts`
Expected: PASS when `DATABASE_URL` is set to a migrated database. Otherwise the suite reports as skipped. If it is skipped, say so in the task report; do not claim it passed.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm -C <wt> run typecheck
pnpm -C <wt> run lint
git -C <wt> add src/contacts/types.ts src/contacts/contact-service.ts tests/unit/contacts/find-likely-duplicates.test.ts tests/integration/contacts.test.ts
git -C <wt> commit -s -m "feat(contacts): agent_stated source and a duplicate check before agent writes (#2041)"
```

---

## Task 3: `contact-create` refuses likely duplicates and records `agent_stated`

**Files:**
- Create: `src/skills/_shared/duplicate-refusal.ts`
- Modify: `skills/contacts/tools/contact-create/handler.ts` (full rewrite below)
- Modify: `skills/contacts/tools/contact-create/tool.json`
- Test: `skills/contacts/tools/contact-create/handler.test.ts` (new)

**Interfaces:**
- Consumes:
  - `normalizeAgentIdentifier` (Task 1);
  - `ContactService.findLikelyDuplicates`, `DuplicateCheck`, `DuplicateCandidate`, `DuplicateReason` (Task 2);
  - `ContactService.createContactWithKgOutcome(options): Promise<{ contact: Contact; kgNodeCreated: boolean }>`;
  - `ContactService.deleteContact(id, { archiveAnchoredNode?: boolean })`;
  - `PRINCIPAL_RECIPIENT_ALIAS` from `src/skills/_shared/recipient-reference.ts`.
- Produces (used by Task 4):
  - `isPrincipalContact(contact: Contact): boolean`
  - `distinctFromToken(contact: Contact): string`
  - `parseDistinctFrom(value: unknown): { ok: true; tokens: Set<string> } | { ok: false; error: string }`
  - `uncoveredCandidates(candidates: readonly DuplicateCandidate[], tokens: ReadonlySet<string>): DuplicateCandidate[]`
  - `takenError(taken: { contact: Contact; channel: string }, action: string): string`
  - `candidatesError(candidates: readonly DuplicateCandidate[], action: string, next: string): string`

- [ ] **Step 1: Write the failing handler tests**

`skills/contacts/tools/contact-create/handler.test.ts`:

```ts
// contact-create (#2041): agent-entered contacts carry agent_stated, and nothing is
// written until the duplicate check passes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { ContactCreateHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(contactService: ContactService, input: Record<string, unknown>): ToolContext {
  return { input, secret: () => 'unused', log: silentLog, contactService } as unknown as ToolContext;
}

describe('ContactCreateHandler', () => {
  let contacts: ContactService;
  let handler: ContactCreateHandler;
  let priyaId: string;
  let principalId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    handler = new ContactCreateHandler();
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya.natarajan@example.test', source: 'ceo_stated' });
    const principal = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated' });
    await contacts.saveContact({ ...principal, systemRole: 'principal' });
    principalId = principal.id;
    await contacts.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'pat@principal.example', source: 'ceo_stated' });
  });

  async function count(): Promise<number> {
    return (await contacts.listContacts()).length;
  }

  it('creates a contact whose identities are agent_stated, verified and normalized', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Dana Whitfield', email: 'Dana.Whitfield@NewCo.example', sms: '(416) 555-0100',
    }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as { contact_id: string; identities_added: number };
    expect(data.identities_added).toBe(2);
    const found = await contacts.getContactWithIdentities(data.contact_id);
    expect(found!.identities.map((i) => [i.channel, i.channelIdentifier, i.source, i.verified])).toEqual([
      ['email', 'dana.whitfield@newco.example', 'agent_stated', true],
      ['sms', '+14165550100', 'agent_stated', true],
    ]);
  });

  it('creates a name-only contact', async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Morgan Lee' }));
    expect(result.success).toBe(true);
  });

  it('refuses a malformed identifier and writes nothing', async () => {
    const before = await count();
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana at newco' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/email must be an email address.*No contact was created/s);
    expect(await count()).toBe(before);
  });

  it('refuses an address another contact holds, naming that contact, with no override', async () => {
    const before = await count();
    const result = await handler.execute(makeCtx(contacts, {
      name: 'P. Natarajan', email: 'PRIYA.NATARAJAN@example.test', distinct_from: [priyaId],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(priyaId);
      expect(result.error).toContain('Priya Natarajan');
      expect(result.error).not.toContain('priya.natarajan@example.test');
    }
    expect(await count()).toBe(before);
  });

  it("refuses the principal's own address with the alias, never their contact ID", async () => {
    const result = await handler.execute(makeCtx(contacts, { name: 'Pat', email: 'pat@principal.example' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/principal's/);
      expect(result.error).toContain('"principal"');
      expect(result.error).not.toContain(principalId);
    }
  });

  it('refuses a near-miss of an existing address until distinct_from names that contact', async () => {
    const input = { name: 'Priya N', email: 'priya.natarajan@exmaple.test' };
    const refused = await handler.execute(makeCtx(contacts, input));
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain(`"Priya Natarajan" (${priyaId}): similar email address`);
      expect(refused.error).toContain('distinct_from');
      expect(refused.error).not.toContain('priya.natarajan@example.test');
    }
    const retried = await handler.execute(makeCtx(contacts, { ...input, distinct_from: [priyaId] }));
    expect(retried.success).toBe(true);
  });

  it('accepts distinct_from as one comma-separated string', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Priya Natarajan', email: 'pn@other.example', distinct_from: ` ${priyaId} `,
    }));
    expect(result.success).toBe(true);
  });

  it('still refuses when distinct_from covers only some candidates', async () => {
    const second = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    const result = await handler.execute(makeCtx(contacts, {
      name: 'Priya Natarajan', distinct_from: [priyaId],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(priyaId);
      expect(result.error).toContain(second.id);
    }
  });

  it('lists the principal as a candidate by alias, and "principal" in distinct_from clears it', async () => {
    const refused = await handler.execute(makeCtx(contacts, { name: 'Pat Vendor', email: 'pat@principal.exmaple' }));
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error).toContain('the principal');
      expect(refused.error).not.toContain(principalId);
    }
    const retried = await handler.execute(makeCtx(contacts, {
      name: 'Pat Vendor', email: 'pat@principal.exmaple', distinct_from: ['principal'],
    }));
    expect(retried.success).toBe(true);
  });

  it('lists a contact named after its address by ID only (Review Focus 3)', async () => {
    const gatewayMade = await contacts.createContact({ displayName: 'sam.rivera@vendor.example', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: gatewayMade.id, channel: 'email', channelIdentifier: 'sam.rivera@vendor.example', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, { name: 'Sam Rivera', email: 'sam.rivera@vendor.exmaple' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(`contact ${gatewayMade.id}`);
      expect(result.error).not.toContain('sam.rivera@vendor.example');
    }
  });

  it('refuses, and writes nothing, when the duplicate check fails', async () => {
    vi.spyOn(contacts, 'findLikelyDuplicates').mockRejectedValueOnce(new Error('db down'));
    const before = await count();
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana@newco.example' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/duplicate check could not run/);
    expect(await count()).toBe(before);
  });

  it('removes the contact it created when a concurrent create wins the address', async () => {
    const before = await count();
    vi.spyOn(contacts, 'linkIdentity').mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const result = await handler.execute(makeCtx(contacts, { name: 'Dana Whitfield', email: 'dana@newco.example' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/just added to another contact/);
    expect(await count()).toBe(before);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm -C <wt> exec vitest run skills/contacts/tools/contact-create/handler.test.ts`
Expected: FAIL. The old handler records `ceo_stated`, never refuses a near miss, and leaves the contact behind on a link failure.

- [ ] **Step 3: Create `src/skills/_shared/duplicate-refusal.ts`**

```ts
// duplicate-refusal.ts — what contact-create and contact-link-identity tell the agent
// when the duplicate check (ContactService.findLikelyDuplicates) stops a write (#2041).
//
// Messages name contacts and reasons, never an address or number: a model handed
// one will retype it. The principal is named by the alias; their contact ID stays
// out of the model's context (spec 09).

import type { Contact, DuplicateCandidate, DuplicateReason } from '../../contacts/types.js';
import { PRINCIPAL_RECIPIENT_ALIAS } from './recipient-reference.js';

export function isPrincipalContact(contact: Contact): boolean {
  return contact.systemRole === 'principal';
}

/** What distinct_from takes for a candidate: its contact ID, or "principal". */
export function distinctFromToken(contact: Contact): string {
  return isPrincipalContact(contact) ? PRINCIPAL_RECIPIENT_ALIAS : contact.id;
}

/**
 * distinct_from as the agent passed it: a list of strings, or one comma-separated
 * string. Tokens are trimmed and lowercased (contact IDs compare case-insensitively).
 */
export function parseDistinctFrom(
  value: unknown,
): { ok: true; tokens: Set<string> } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, tokens: new Set() };
  const entries: unknown[] | null = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
  if (entries === null || entries.some((entry) => typeof entry !== 'string')) {
    return { ok: false, error: `distinct_from must be a list of contact IDs (or "${PRINCIPAL_RECIPIENT_ALIAS}").` };
  }
  const tokens = (entries as string[]).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
  return { ok: true, tokens: new Set(tokens) };
}

/** Candidates the agent has not named in distinct_from. */
export function uncoveredCandidates(
  candidates: readonly DuplicateCandidate[],
  tokens: ReadonlySet<string>,
): DuplicateCandidate[] {
  return candidates.filter((candidate) => !tokens.has(distinctFromToken(candidate.contact).toLowerCase()));
}

/**
 * How to name a contact to the agent. Display names come from inbound headers, and a
 * contact the gateway created is named after its address, so a name that looks like
 * an address or a number is left out.
 */
function who(contact: Contact): string {
  const name = contact.displayName
    .replace(/[\u0000-\u001F\u007F-\u009F  "]+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!name || name.includes('@') || /\d{7,}/.test(name)) return `contact ${contact.id}`;
  return `"${name}" (${contact.id})`;
}

function describeReason(reason: DuplicateReason): string {
  switch (reason.kind) {
    case 'same_name':
      return 'same name';
    case 'similar_address':
      return reason.channel === 'email' ? 'similar email address' : `similar ${reason.channel} number`;
    case 'same_number':
      return `same number on ${reason.channel}`;
  }
}

/**
 * Another contact already holds this identifier on this channel. Not overridable:
 * the store cannot hold it twice. `action` says what did not happen.
 */
export function takenError(taken: { contact: Contact; channel: string }, action: string): string {
  if (isPrincipalContact(taken.contact)) {
    return `That ${taken.channel} address is the principal's. ${action} To reach them, send to "${PRINCIPAL_RECIPIENT_ALIAS}".`;
  }
  return (
    `That ${taken.channel} address is already on ${who(taken.contact)}. ${action} ` +
    `Use that contact's ID; contact-link-identity adds another address to it.`
  );
}

/**
 * Every candidate, by name, ID and reason. Overridable with distinct_from.
 * `action` says what did not happen; `next` says how to continue.
 */
export function candidatesError(candidates: readonly DuplicateCandidate[], action: string, next: string): string {
  const lines = candidates.map((candidate) => {
    const reasons = candidate.reasons.map(describeReason).join(', ');
    return isPrincipalContact(candidate.contact)
      ? `- the principal ("${PRINCIPAL_RECIPIENT_ALIAS}" in distinct_from): ${reasons}`
      : `- ${who(candidate.contact)}: ${reasons}`;
  });
  return [`This may be someone already in contacts. ${action}`, ...lines, next].join('\n');
}
```

- [ ] **Step 4: Rewrite `skills/contacts/tools/contact-create/handler.ts`**

```ts
// handler.ts — contact-create skill implementation.
//
// Creates a new contact and optionally links channel identities (email, phone,
// signal, sms, slack, telegram). Automatically creates a knowledge graph person node
// via the ContactService.
//
// Cold outreach starts here (#2041). The send skills take a contact ID, so an agent
// adds someone new with this skill and sends to the contact_id it returns. Nothing
// is written until the duplicate check passes:
//   - an address another contact holds is refused;
//   - a contact that may be the same person (similar address, same number on another
//     channel, same name) is listed until the agent names it in distinct_from.
// Identities are recorded as agent_stated: an agent typed them, so they are not
// presented as the principal's own statement (ceo_stated).
//
// This skill uses contactService, which is a universal service.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { Contact, DuplicateCheck } from '../../../../src/contacts/types.js';
import { normalizeAgentIdentifier } from '../../../../src/contacts/agent-identifier.js';
import {
  candidatesError,
  parseDistinctFrom,
  takenError,
  uncoveredCandidates,
} from '../../../../src/skills/_shared/duplicate-refusal.js';

// Optional inputs, each linked as an identity on the channel of the same name.
const CHANNEL_INPUTS = ['email', 'phone', 'signal', 'sms', 'slack', 'telegram'] as const;

const NOT_CREATED = 'No contact was created.';
const NEXT =
  "If one of them is this person, use their contact ID instead (contact-link-identity adds a new address to it). " +
  'If you are sure this is someone new, call contact-create again with distinct_from listing every ID above.';

export class ContactCreateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as Record<string, unknown>;
    const { name, role, notes } = input as { name?: string; role?: string; notes?: string };

    // Validate required inputs
    if (!name || typeof name !== 'string') {
      return { success: false, error: 'Missing required input: name (string)' };
    }

    // Input length limits — prevent oversized payloads reaching the DB or LLM context
    if (name.length > 500) {
      return { success: false, error: 'Name must be 500 characters or fewer' };
    }
    if (role && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }
    if (notes && notes.length > 5000) {
      return { success: false, error: 'Notes must be 5000 characters or fewer' };
    }

    // Normalize every identifier before the duplicate check, so `(416) 555-0100`
    // finds a stored `+14165550100` and is stored in a shape the send skills reach.
    const identities: Array<{ channel: string; identifier: string }> = [];
    for (const channel of CHANNEL_INPUTS) {
      const raw = input[channel];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw !== 'string') {
        return { success: false, error: `${channel} must be a string` };
      }
      if (raw.length > 500) {
        return { success: false, error: `${channel} identifier must be 500 characters or fewer` };
      }
      const normalized = normalizeAgentIdentifier(channel, raw);
      if (!normalized.ok) return { success: false, error: `${normalized.error} ${NOT_CREATED}` };
      identities.push({ channel, identifier: normalized.identifier });
    }

    const distinctFrom = parseDistinctFrom(input['distinct_from']);
    if (!distinctFrom.ok) return { success: false, error: distinctFrom.error };

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-create: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    let check: DuplicateCheck;
    try {
      check = await ctx.contactService.findLikelyDuplicates({ displayName: name, identities });
    } catch (err) {
      // Fail closed: creating without the check is the transcription risk it exists for.
      ctx.log.error({ err }, 'contact-create: duplicate check failed — refusing (#2041)');
      return { success: false, error: `The duplicate check could not run. ${NOT_CREATED} Try again.` };
    }

    const taken = check.taken[0];
    if (taken) {
      ctx.log.info({ channel: taken.channel }, 'contact-create: refused — identifier held by another contact (#2041)');
      return { success: false, error: takenError(taken, NOT_CREATED) };
    }
    if (uncoveredCandidates(check.candidates, distinctFrom.tokens).length > 0) {
      ctx.log.info({ candidates: check.candidates.length }, 'contact-create: refused — likely duplicate (#2041)');
      return { success: false, error: candidatesError(check.candidates, NOT_CREATED, NEXT) };
    }

    ctx.log.info({ name, role, channels: identities.map((identity) => identity.channel) }, 'Creating contact');

    let created: { contact: Contact; kgNodeCreated: boolean };
    try {
      // Creates a KG person node too when entityMemory is available.
      created = await ctx.contactService.createContactWithKgOutcome({
        displayName: name,
        role: role ?? undefined,
        notes: notes ?? undefined,
        source: 'agent_stated',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, name }, 'Failed to create contact');
      return { success: false, error: `Failed to create contact: ${message}` };
    }
    const { contact, kgNodeCreated } = created;

    for (const identity of identities) {
      try {
        await ctx.contactService.linkIdentity({
          contactId: contact.id,
          channel: identity.channel,
          channelIdentifier: identity.identifier,
          source: 'agent_stated',
        });
      } catch (err) {
        // Leave nothing half-made: remove the contact this call created. Retire its KG
        // node only if this call minted it (an adopted node predates us; ADR-040).
        try {
          await ctx.contactService.deleteContact(contact.id, { archiveAnchoredNode: kgNodeCreated });
        } catch (cleanupErr) {
          ctx.log.error(
            { err: cleanupErr, orphanId: contact.id },
            'contact-create: could not remove the contact after a failed link — orphan left for cleanup',
          );
        }
        if ((err as { code?: string }).code === '23505') {
          // Another create won the address between the check and this link.
          ctx.log.info({ channel: identity.channel }, 'contact-create: identifier claimed concurrently — refused');
          return {
            success: false,
            error: `That ${identity.channel} address was just added to another contact. ${NOT_CREATED} Look the person up and use their contact ID.`,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error({ err, channel: identity.channel }, 'contact-create: failed to link identity');
        return { success: false, error: `Failed to create contact: ${message}` };
      }
    }

    ctx.log.info({ contactId: contact.id, identitiesAdded: identities.length }, 'Contact created successfully');

    return {
      success: true,
      data: {
        contact_id: contact.id,
        display_name: contact.displayName,
        role: contact.role,
        kg_node_id: contact.kgNodeId,
        identities_added: identities.length,
      },
    };
  }
}
```

- [ ] **Step 5: Update `skills/contacts/tools/contact-create/tool.json`**

Keep this manifest short: the coordinator pins this tool (Task 9), and its definition counts against the coordinator's 77,000-byte tool budget.

```json
{
  "name": "contact-create",
  "description": "Add a person to contacts. Returns contact_id, which the send skills take as the recipient: to message someone who is not a contact yet, create them here, then send to that ID. Refuses an address another contact has, and lists contacts that may be the same person: use one of them, or retry with distinct_from naming each.",
  "version": "1.1.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "name": "string",
    "role": "string?",
    "notes": "string?",
    "email": "string?",
    "phone": "string? (CRM number; to text them use sms or signal)",
    "signal": "string? (phone number)",
    "sms": "string? (phone number)",
    "slack": "string? (Slack user id U…)",
    "telegram": "string?",
    "distinct_from": "string[]? (IDs from a refusal that you checked are different people)"
  },
  "outputs": {
    "contact_id": "string",
    "display_name": "string",
    "role": "string?",
    "kg_node_id": "string?",
    "identities_added": "number"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000,
  "capabilities": []
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm -C <wt> exec vitest run skills/contacts/tools/contact-create/handler.test.ts tests/unit/skills/manifest-placeholder-free.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, commit**

```bash
pnpm -C <wt> run typecheck
git -C <wt> add src/skills/_shared/duplicate-refusal.ts skills/contacts/tools/contact-create/handler.ts skills/contacts/tools/contact-create/tool.json skills/contacts/tools/contact-create/handler.test.ts
git -C <wt> commit -s -m "feat(contact-create): refuse likely duplicates; record agent_stated (#2041)"
```

---

## Task 4: `contact-link-identity`: agent_stated, the duplicate check, and re-stating

**Files:**
- Modify: `skills/contacts/tools/contact-link-identity/handler.ts` (full rewrite below)
- Modify: `skills/contacts/tools/contact-link-identity/tool.json`
- Test: `skills/contacts/tools/contact-link-identity/handler.test.ts` (new)
- Modify: `src/skills/outbound-gateway.ts`: the comment at lines ~2018–2021 in `promoteOrCreateRecipientContact`.

**Interfaces:**
- Consumes:
  - Task 1: `normalizeAgentIdentifier`, `sameIdentifier`;
  - Task 2: `findLikelyDuplicates`;
  - Task 3: `candidatesError`, `parseDistinctFrom`, `takenError`, `uncoveredCandidates`;
  - `ContactService.getContactWithIdentities(id)` and `ContactService.verifyIdentity(identityId)`.
- Produces: output adds `already_linked: boolean`.

- [ ] **Step 1: Write the failing handler tests**

`skills/contacts/tools/contact-link-identity/handler.test.ts`:

```ts
// contact-link-identity (#2041): agent-entered addresses carry agent_stated, pass the
// duplicate check first, and re-stating an address an agent typed earlier verifies it.

import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactLinkIdentityHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(contactService: ContactService, input: Record<string, unknown>): ToolContext {
  return { input, secret: () => 'unused', log: silentLog, contactService } as unknown as ToolContext;
}

describe('ContactLinkIdentityHandler', () => {
  let contacts: ContactService;
  let handler: ContactLinkIdentityHandler;
  let danaId: string;
  let priyaId: string;

  beforeEach(async () => {
    contacts = ContactService.createInMemory();
    handler = new ContactLinkIdentityHandler();
    const dana = await contacts.createContact({ displayName: 'Dana Whitfield', source: 'ceo_stated' });
    danaId = dana.id;
    const priya = await contacts.createContact({ displayName: 'Priya Natarajan', source: 'ceo_stated' });
    priyaId = priya.id;
    await contacts.linkIdentity({ contactId: priya.id, channel: 'email', channelIdentifier: 'priya@example.test', source: 'ceo_stated' });
  });

  it('links a new address as agent_stated and verified', async () => {
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: danaId, channel: 'email', identifier: 'Dana@NewCo.example', label: 'work',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: false } });
    const found = await contacts.getContactWithIdentities(danaId);
    expect(found!.identities[0]).toMatchObject({
      channelIdentifier: 'dana@newco.example', source: 'agent_stated', verified: true, label: 'work',
    });
  });

  it('refuses an address another contact holds, naming that contact', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'email', identifier: 'priya@example.test' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(priyaId);
      expect(result.error).toMatch(/Nothing was linked/);
      expect(result.error).not.toContain('priya@example.test');
    }
  });

  it('refuses a near-miss of another contact address until distinct_from names that contact', async () => {
    const input = { contact_id: danaId, channel: 'email', identifier: 'priya@exmaple.test' };
    const refused = await handler.execute(makeCtx(contacts, input));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error).toContain(`"Priya Natarajan" (${priyaId}): similar email address`);
    const retried = await handler.execute(makeCtx(contacts, { ...input, distinct_from: [priyaId] }));
    expect(retried.success).toBe(true);
  });

  it('re-stating a verified address on this contact changes nothing', async () => {
    const result = await handler.execute(makeCtx(contacts, { contact_id: priyaId, channel: 'email', identifier: 'Priya@Example.test' }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    expect((await contacts.getContactWithIdentities(priyaId))!.identities).toHaveLength(1);
  });

  it('re-stating an unverified outbound_recipient address verifies it, keeping its source', async () => {
    const recipient = await contacts.createContact({ displayName: 'new.person@cold.example', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: recipient.id, channel: 'email', channelIdentifier: 'new.person@cold.example', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: recipient.id, channel: 'email', identifier: 'new.person@cold.example',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    const identity = (await contacts.getContactWithIdentities(recipient.id))!.identities[0];
    expect(identity).toMatchObject({ source: 'outbound_recipient', verified: true });
  });

  it('finds a stored number when it is re-stated in another format (Review Focus 5)', async () => {
    const recipient = await contacts.createContact({ displayName: 'Text Only', source: 'outbound_recipient' });
    await contacts.linkIdentity({
      contactId: recipient.id, channel: 'sms', channelIdentifier: '+14165550100', source: 'outbound_recipient',
    });
    const result = await handler.execute(makeCtx(contacts, {
      contact_id: recipient.id, channel: 'sms', identifier: '+1 (416) 555-0100',
    }));
    expect(result).toMatchObject({ success: true, data: { verified: true, already_linked: true } });
    expect((await contacts.getContactWithIdentities(recipient.id))!.identities).toHaveLength(1);
  });

  it.each(['self_claimed', 'sms_participant'] as const)('will not vouch for an unverified %s address', async (source) => {
    await contacts.linkIdentity({ contactId: danaId, channel: 'sms', channelIdentifier: '+14165550199', source });
    const result = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'sms', identifier: '+14165550199' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Only the principal can verify it/);
    expect((await contacts.getContactWithIdentities(danaId))!.identities[0]!.verified).toBe(false);
  });

  it('refuses an unknown contact ID and a malformed identifier', async () => {
    const missing = await handler.execute(makeCtx(contacts, {
      contact_id: '00000000-0000-4000-8000-000000000000', channel: 'email', identifier: 'x@y.example',
    }));
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error).toMatch(/No contact has ID/);
    const malformed = await handler.execute(makeCtx(contacts, { contact_id: danaId, channel: 'sms', identifier: 'call me' }));
    expect(malformed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm -C <wt> exec vitest run skills/contacts/tools/contact-link-identity/handler.test.ts`
Expected: FAIL. The old handler records `ceo_stated`, never returns `already_linked`, and throws a unique violation on a re-statement.

- [ ] **Step 3: Rewrite `skills/contacts/tools/contact-link-identity/handler.ts`**

```ts
// handler.ts — contact-link-identity skill implementation.
//
// Adds a channel identity (email, phone, Signal, SMS, Telegram, Slack) to an existing
// contact. The identity is recorded as agent_stated (#2041): an agent typed it. It is
// verified, as contact-create's are, once the duplicate check passes:
//   - an address another contact holds is refused;
//   - an address resembling another contact's is listed until the agent names that
//     contact in distinct_from.
//
// Re-stating an address already on this contact is how an agent vouches for one it
// typed earlier. An unverified outbound_recipient identity (recorded by the gateway
// after a first-time send) is verified in place. Other unverified sources
// (self_claimed, sms_participant) need the principal.
//
// This skill uses contactService, which is a universal service.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { DuplicateCheck } from '../../../../src/contacts/types.js';
import { LINKABLE_CHANNEL_IDENTITY_SET } from '../../../../src/contacts/linkable-channels.js';
import { normalizeAgentIdentifier } from '../../../../src/contacts/agent-identifier.js';
import { sameIdentifier } from '../../../../src/contacts/identifier-near-miss.js';
import {
  candidatesError,
  parseDistinctFrom,
  takenError,
  uncoveredCandidates,
} from '../../../../src/skills/_shared/duplicate-refusal.js';

const NOT_LINKED = 'Nothing was linked.';
const NEXT =
  'Check the address: it resembles theirs. If it is right, call contact-link-identity again with distinct_from listing every ID above.';

export class ContactLinkIdentityHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as Record<string, unknown>;
    const { contact_id, channel, identifier, label } = input as {
      contact_id?: string;
      channel?: string;
      identifier?: string;
      label?: string;
    };

    // Validate required inputs
    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!channel || typeof channel !== 'string') {
      return { success: false, error: 'Missing required input: channel (string)' };
    }
    if (!identifier || typeof identifier !== 'string') {
      return { success: false, error: 'Missing required input: identifier (string)' };
    }

    // Input length limits — prevent oversized payloads reaching the DB
    if (identifier.length > 500) {
      return { success: false, error: 'Identifier must be 500 characters or fewer' };
    }
    if (label && label.length > 200) {
      return { success: false, error: 'Label must be 200 characters or fewer' };
    }

    // Channel allowlist — single shared constant with the console HTTP API (#1514).
    if (!LINKABLE_CHANNEL_IDENTITY_SET.has(channel)) {
      return {
        success: false,
        error: `Invalid channel '${channel}'. Allowed: ${[...LINKABLE_CHANNEL_IDENTITY_SET].join(', ')}`,
      };
    }

    const normalized = normalizeAgentIdentifier(channel, identifier);
    if (!normalized.ok) return { success: false, error: `${normalized.error} ${NOT_LINKED}` };

    const distinctFrom = parseDistinctFrom(input['distinct_from']);
    if (!distinctFrom.ok) return { success: false, error: distinctFrom.error };

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-link-identity: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    try {
      const target = await ctx.contactService.getContactWithIdentities(contact_id);
      if (!target) {
        return { success: false, error: `No contact has ID ${contact_id}. ${NOT_LINKED} contact-lookup returns the ID.` };
      }

      // Re-statement: the address is already on this contact.
      const existing = target.identities.find(
        (identity) => identity.channel === channel && sameIdentifier(channel, identity.channelIdentifier, normalized.identifier),
      );
      if (existing) {
        if (existing.verified) {
          return { success: true, data: { identity_id: existing.id, verified: true, already_linked: true } };
        }
        if (existing.source === 'outbound_recipient') {
          // An agent typed it on a first-time send; an agent re-stating it vouches for it.
          const verified = await ctx.contactService.verifyIdentity(existing.id);
          ctx.log.info(
            { identityId: existing.id, contactId: contact_id },
            'contact-link-identity: re-stated outbound_recipient address verified (#2041)',
          );
          return { success: true, data: { identity_id: verified.id, verified: verified.verified, already_linked: true } };
        }
        return {
          success: false,
          error: 'That address is already on this contact, unverified. Only the principal can verify it, in the console. Nothing changed.',
        };
      }

      let check: DuplicateCheck;
      try {
        check = await ctx.contactService.findLikelyDuplicates({
          identities: [{ channel, identifier: normalized.identifier }],
          excludeContactId: contact_id,
        });
      } catch (err) {
        ctx.log.error({ err, contact_id }, 'contact-link-identity: duplicate check failed — refusing (#2041)');
        return { success: false, error: `The duplicate check could not run. ${NOT_LINKED} Try again.` };
      }
      const taken = check.taken[0];
      if (taken) return { success: false, error: takenError(taken, NOT_LINKED) };
      if (uncoveredCandidates(check.candidates, distinctFrom.tokens).length > 0) {
        ctx.log.info({ candidates: check.candidates.length }, 'contact-link-identity: refused — likely duplicate (#2041)');
        return { success: false, error: candidatesError(check.candidates, NOT_LINKED, NEXT) };
      }

      ctx.log.info({ contact_id, channel }, 'Linking identity to contact');
      const identity = await ctx.contactService.linkIdentity({
        contactId: contact_id,
        channel,
        channelIdentifier: normalized.identifier,
        label: label ?? undefined,
        source: 'agent_stated',
      });

      ctx.log.info(
        { identityId: identity.id, contactId: contact_id, verified: identity.verified },
        'Identity linked successfully',
      );

      return { success: true, data: { identity_id: identity.id, verified: identity.verified, already_linked: false } };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Another contact took the address between the check and this link.
        return { success: false, error: `That ${channel} address was just added to another contact. ${NOT_LINKED}` };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, channel }, 'Failed to link identity');
      return { success: false, error: `Failed to link identity: ${message}` };
    }
  }
}
```

- [ ] **Step 4: Update `skills/contacts/tools/contact-link-identity/tool.json`**

```json
{
  "name": "contact-link-identity",
  "description": "Add a channel identity (email, phone, Signal, SMS, Telegram, Slack) to an existing contact. Refuses an address another contact has, and lists contacts with a similar one: retry with distinct_from if the address is right. Re-stating an unverified address this contact got from an earlier first-time send verifies it. To update profile attributes (title, organization, timezone, etc.), use contact-update instead.",
  "version": "1.2.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "contact_id": "string",
    "channel": "string",
    "identifier": "string",
    "label": "string?",
    "distinct_from": "string[]? (IDs from a refusal that you checked are different people)"
  },
  "outputs": {
    "identity_id": "string",
    "verified": "boolean",
    "already_linked": "boolean"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

- [ ] **Step 5: Update the gateway comment**

In `src/skills/outbound-gateway.ts`, in `promoteOrCreateRecipientContact`, replace:

```ts
        // outbound_recipient is not auto-verified, so this identity lands unverified.
        // A send by reference to this contact therefore fails closed until someone
        // verifies the address; the raw-address field still reaches it.
```

with:

```ts
        // outbound_recipient is not auto-verified, so this identity lands unverified.
        // A send by reference to this contact therefore fails closed until the
        // principal verifies the address or an agent re-states it with
        // contact-link-identity (#2041).
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm -C <wt> exec vitest run skills/contacts/tools/contact-link-identity/handler.test.ts skills/contacts/tools/contact-create/handler.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, commit**

```bash
pnpm -C <wt> run typecheck
git -C <wt> add skills/contacts/tools/contact-link-identity src/skills/outbound-gateway.ts
git -C <wt> commit -s -m "feat(contact-link-identity): duplicate check, agent_stated, and re-stating verifies (#2041)"
```

---
## Task 5: The resolver and the execution layer take references only

After this task the execution layer refuses a retired raw-address input before any gate runs, and the resolver's error points at `contact-create`. Handlers keep their raw-field code until Task 7. They are only reachable directly, in handler tests, and those tests keep passing until then.

**Files:**
- Modify: `src/skills/_shared/recipient-reference.ts`
- Modify: `src/skills/execution.ts`: the import list (~line 120), `approvalDisplayInput` (~872–935), `resolveSendSkillReferences` (~937–1028), `confirmPinnedSendResolution` (~1034–1054), and `invoke` (~1532–1540).
- Modify (call arguments only): `skills/email/tools/email-send/handler.ts`, `skills/signal-send/handler.ts`, `skills/sms-send/handler.ts`, `skills/slack-send/handler.ts`
- Tests:
  - `tests/unit/skills/recipient-reference.test.ts`
  - `tests/unit/skills/execution.policy.test.ts`
  - `tests/unit/skills/send-by-reference.test.ts` (lines 180–188 only)
  - `tests/unit/dispatch/bullpen-origin-reply.test.ts`
  - `tests/integration/outbound-delivered-emission.test.ts`, `relayed-send-attribution.test.ts`, `research-analyst-multi-turn.test.ts`, `test-mode-stack.test.ts`
  - the `toHaveBeenCalledWith(…, { field, rawField })` assertions in the four handler test files

**Interfaces:**
- Produces (replaces `SEND_SKILL_RECIPIENT_FIELDS`, which is deleted):
  ```ts
  export interface RecipientReferenceFields { field: string }
  export interface RecipientReferenceSkill {
    channel: string;
    references: readonly string[];
    retired: Readonly<Record<string, string>>; // retired input → the reference input that replaced it
  }
  export const RECIPIENT_REFERENCE_SKILLS: Readonly<Record<string, RecipientReferenceSkill>>;
  export function findRetiredRecipientField(skill: RecipientReferenceSkill, input: Record<string, unknown>): string | null;
  export function retiredRecipientFieldError(skill: RecipientReferenceSkill, field: string): string;
  ```
- `OutboundGateway.resolveRecipientReference(channel, value, fields: RecipientReferenceFields)` keeps its signature. Only the type narrows.

- [ ] **Step 1: Write the failing resolver tests**

In `tests/unit/skills/recipient-reference.test.ts`:
- line 15: `const FIELDS = { field: 'to', rawField: 'to_address' };` becomes `const FIELDS = { field: 'to' };`
- lines ~173–180: rename the test to `rejects an address in the reference field and points at contact-create`. Keep the assertion on the first sentence. Replace the `/to_address/` assertion with:
  ```ts
  expect(result.error).toMatch(/contact-create/);
  expect(result.error).not.toMatch(/to_address/);
  ```
- lines ~319 and ~388: `toMatch(/to_address/)` becomes `toMatch(/contact-create/)`.

Add this block, adding `RECIPIENT_REFERENCE_SKILLS`, `findRetiredRecipientField` and `retiredRecipientFieldError` to the file's import from `recipient-reference.js`:

```ts
describe('retired raw-address inputs (#2041)', () => {
  const email = RECIPIENT_REFERENCE_SKILLS['email-send']!;

  it('finds a present retired input and ignores blank ones (Review Focus 1)', () => {
    expect(findRetiredRecipientField(email, { to: 'principal', cc_addresses: 'ops@example.com' })).toBe('cc_addresses');
    expect(findRetiredRecipientField(email, { to: 'principal', to_address: '', cc_addresses: '  ' })).toBeNull();
    expect(findRetiredRecipientField(email, { to_address: null, cc_addresses: [] })).toBeNull();
    expect(findRetiredRecipientField(RECIPIENT_REFERENCE_SKILLS['signal-send']!, { recipient_number: 15551234567 })).toBe('recipient_number');
  });

  it('names the input that replaced it and contact-create', () => {
    const message = retiredRecipientFieldError(email, 'cc_addresses');
    expect(message).toMatch(/^cc_addresses is no longer accepted/);
    expect(message).toMatch(/contact ID in cc/);
    expect(message).toMatch(/contact-create/);
    expect(message).toMatch(/Nothing was sent\.$/);
  });

  it('covers the four send skills', () => {
    expect(Object.keys(RECIPIENT_REFERENCE_SKILLS).sort()).toEqual(['email-send', 'signal-send', 'slack-send', 'sms-send']);
  });
});
```

- [ ] **Step 2: Write the failing execution-layer tests**

In `tests/unit/skills/execution.policy.test.ts`, inside `describe('send recipients are checked before any gate files an approval (#2033)', …)`:

First, `layerWithTrigger` also registers the other send skills:

```ts
      registry.register(makeRiskyManifest('sms-send', 'medium'), handler);
      registry.register(makeRiskyManifest('slack-send', 'medium'), handler);
```

Then add these tests after the existing `it.each`:

```ts
    it.each([
      ['to_address', 'email-send', { to_address: 'bob@example.com', subject: 'x', body: 'y' }],
      // Checked before reference resolution: "principal" cannot resolve with this layer's stub.
      ['to_address beside a reference', 'email-send', { to: 'principal', to_address: 'bob@example.com', subject: 'x', body: 'y' }],
      ['to_address as an array', 'email-send', { to_address: ['bob@example.com'], subject: 'x', body: 'y' }],
      ['cc_addresses', 'email-send', { cc_addresses: 'ops@example.com', subject: 'x', body: 'y' }],
      ['signal recipient_number', 'signal-send', { recipient_number: '+15551234567', message: 'm' }],
      ['recipient_number as a number', 'signal-send', { recipient_number: 15551234567, message: 'm' }],
      ['sms recipient_number', 'sms-send', { recipient_number: '+15551234567', message: 'm' }],
      ['slack recipient_user_id', 'slack-send', { recipient_user_id: 'U012ABCDEF', message: 'm' }],
    ])('refuses a retired raw input (%s) before any gate files an approval (#2041)', async (_label, tool, input) => {
      const { layer, handler, trigger } = layerWithTrigger();
      const result = await layer.invoke(tool as string, input as Record<string, unknown>, undefined, { taskEventId: 'task-1' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/no longer accepted/);
        expect(result.error).toMatch(/contact-create/);
      }
      expect(trigger.request).not.toHaveBeenCalled();
      expect(handler.execute).not.toHaveBeenCalled();
    });

    it('refuses a retired raw input on an approval replay too (Review Focus 2)', async () => {
      const { layer, handler } = layerWithTrigger();
      const result = await layer.invoke(
        'email-send',
        { to_address: 'bob@example.com', subject: 'x', body: 'y' },
        undefined,
        { taskEventId: 'task-1', humanApproved: true },
      );
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no longer accepted/);
      expect(handler.execute).not.toHaveBeenCalled();
    });

    const DANA = '88888888-8888-4888-8888-888888888888';
    function danaContacts(): ContactService {
      const identity = (channel: string, address: string): ChannelIdentity => ({
        id: `i-${channel}`, contactId: DANA, channel, channelIdentifier: address, label: null,
        verified: true, verifiedAt: new Date(), status: 'active', source: 'ceo_stated',
        createdAt: new Date(), updatedAt: new Date(),
      });
      return {
        getContactWithIdentities: vi.fn(async (id: string) => (id === DANA ? {
          contact: { id: DANA, displayName: 'Dana Lee', primaryEmail: null, primaryPhone: null },
          identities: [identity('email', 'dana@example.com'), identity('signal', '+15550001111')],
        } : undefined)),
      } as unknown as ContactService;
    }

    it.each([
      ['to_address: ""', 'email-send', { to: DANA, to_address: '', subject: 'x', body: 'y' }],
      ['to_address: "  "', 'email-send', { to: DANA, to_address: '  ', subject: 'x', body: 'y' }],
      ['to_address: null', 'email-send', { to: DANA, to_address: null, subject: 'x', body: 'y' }],
      ['cc_addresses: []', 'email-send', { to: DANA, cc_addresses: [], subject: 'x', body: 'y' }],
      ['recipient_number: ""', 'signal-send', { recipient: DANA, recipient_number: '', message: 'm' }],
    ])('does not refuse a blank retired input (%s): the send reaches Gate B (Review Focus 1)', async (_label, tool, input) => {
      const { layer, trigger } = layerWithTrigger(danaContacts());
      const result = await layer.invoke(tool as string, input as Record<string, unknown>, undefined, { taskEventId: 'task-1' });
      expect(result.success).toBe(false); // score 65: held for approval
      if (!result.success) expect(result.error).not.toMatch(/no longer accepted/);
      expect(trigger.request).toHaveBeenCalledOnce();
    });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm -C <wt> exec vitest run tests/unit/skills/recipient-reference.test.ts tests/unit/skills/execution.policy.test.ts`
Expected: FAIL. The helpers are not exported, the resolver message still names `to_address`, and retired inputs are not refused.

- [ ] **Step 4: Change `src/skills/_shared/recipient-reference.ts`**

(a) Add to the header comment, after the paragraph that ends `…the approval display cannot choose different addresses.`:

```ts
//
// There is no raw-address path (#2041). Someone who is not a contact yet is added
// first with contact-create, which returns the contact ID to send to. The retired
// raw-address inputs are refused, never ignored.
```

(b) Add this import below the existing imports:

```ts
import { hasPresentValue } from '../../contacts/principal-carveout-parse.js';
```

(c) Replace the `RecipientReferenceFields` interface with:

```ts
export interface RecipientReferenceFields {
  /** The reference input's name in tool.json (e.g. `to`, `recipient`). */
  field: string;
}
```

(d) Replace the whole `SEND_SKILL_RECIPIENT_FIELDS` block (its doc comment and the constant) with:

```ts
export interface RecipientReferenceSkill {
  channel: string;
  /** Inputs that take a reference. On email each is a comma-separated list. */
  references: readonly string[];
  /** Raw-address inputs retired in #2041, each mapped to the reference input that replaced it. */
  retired: Readonly<Record<string, string>>;
}

/**
 * Skills that address a recipient by reference. The execution layer resolves these
 * inputs before any gate and shows the resolved address in an approval. Code that
 * reads one of these skills' recipient inputs uses this map, not hard-coded names.
 */
export const RECIPIENT_REFERENCE_SKILLS: Readonly<Record<string, RecipientReferenceSkill>> = {
  'email-send': { channel: 'email', references: ['to', 'cc'], retired: { to_address: 'to', cc_addresses: 'cc' } },
  'signal-send': { channel: 'signal', references: ['recipient'], retired: { recipient_number: 'recipient' } },
  'sms-send': { channel: 'sms', references: ['recipient'], retired: { recipient_number: 'recipient' } },
  'slack-send': { channel: 'slack', references: ['recipient'], retired: { recipient_user_id: 'recipient' } },
};

/**
 * The first retired raw-address input present in `input`, or null. A blank value
 * (`to_address: ""`, `[]`, null) is not present: models fill unused optional inputs
 * with one, and refusing those would refuse ordinary sends.
 */
export function findRetiredRecipientField(skill: RecipientReferenceSkill, input: Record<string, unknown>): string | null {
  return Object.keys(skill.retired).find((field) => hasPresentValue(input[field])) ?? null;
}

/**
 * Refusal for a retired raw-address input. It is refused rather than ignored: a
 * dropped cc list would send to fewer people than asked and report success.
 */
export function retiredRecipientFieldError(skill: RecipientReferenceSkill, field: string): string {
  const reference = skill.retired[field] ?? skill.references[0] ?? 'to';
  return (
    `${field} is no longer accepted: sends go to contacts. Pass the person's contact ID in ${reference} ` +
    `("${PRINCIPAL_RECIPIENT_ALIAS}" for the principal). Someone who is not a contact yet must be added first ` +
    `with contact-create, which returns their contact ID. Nothing was sent.`
  );
}
```

(e) In `resolveRecipientReference`, replace the not-a-reference error:

```ts
      error:
        `${fields.field} takes a contact ID or "${PRINCIPAL_RECIPIENT_ALIAS}", not "${safeName(value)}". ` +
        `Send to a known person by their contact ID; the address is looked up for you. ` +
        `Someone who is not a contact yet must be added first with contact-create, which returns their contact ID.`,
```

(f) In the same function, in the `usable.length === 0` branch, replace the non-principal `next` text:

```ts
      : 'Reach them on another channel, or add (or re-state) an address you are sure of with contact-link-identity.';
```

- [ ] **Step 5: Change `src/skills/execution.ts`**

(a) In the import list from `./_shared/recipient-reference.js`, replace `SEND_SKILL_RECIPIENT_FIELDS,` with:

```ts
  RECIPIENT_REFERENCE_SKILLS,
  findRetiredRecipientField,
  retiredRecipientFieldError,
```

(b) Replace `approvalDisplayInput`, including its doc comment, with:

```ts
  /**
   * The copy of a send skill's input that an approval shows the principal (#2033).
   *
   * Each reference is resolved to "address (contact "Name")". The stored payload
   * stays the agent's own input, so approval re-runs the skill as called (and
   * re-resolves the reference then). Display only: a failed lookup shows the
   * reference as written and never blocks the approval. Raw-address inputs are
   * retired and refused before any gate (#2041), so none reaches an approval.
   */
  private async approvalDisplayInput(
    toolName: string,
    input: Record<string, unknown>,
    skillLogger: Logger,
  ): Promise<Record<string, unknown>> {
    const skill = RECIPIENT_REFERENCE_SKILLS[toolName];
    if (!skill) return input;
    const shown: Record<string, unknown> = { ...input };

    // References were checked before the gates, so a failure here is a lookup
    // error or a change since then.
    for (const field of skill.references) {
      const value = input[field];
      if (typeof value !== 'string' || !value.trim() || !this.contactService) continue;
      const entries = skill.channel === 'email' ? splitCommaSeparatedAddresses(value) : [value.trim()];
      const parts: string[] = [];
      for (const entry of entries) {
        if (parseRecipientReference(entry) === null) {
          parts.push(entry);
          continue;
        }
        const resolved = await resolveRecipientReference(
          entry,
          skill.channel,
          { field },
          { contactService: this.contactService, principalContactId: this.principalIdentities[0]?.contactId },
        );
        if (resolved.ok) {
          parts.push(formatResolvedRecipient(resolved));
        } else if (resolved.cause !== undefined) {
          skillLogger.warn({ err: resolved.cause, toolName }, 'approval display: recipient reference lookup failed — showing it unresolved');
          parts.push(`${entry} (contact lookup failed)`);
        } else {
          parts.push(`${entry} (could not be resolved)`);
        }
      }
      shown[field] = parts.join(', ');
    }
    return shown;
  }
```

(c) Replace `resolveSendSkillReferences`, including its doc comment, with:

```ts
  /**
   * Check and resolve a send skill's recipient references (#2033, ADR-047), before
   * any gate runs.
   *
   * - A retired raw-address input (#2041) is refused. It is not ignored: dropping a
   *   cc list would send to fewer people than the agent asked for.
   * - Every entry in a reference input (`to`, `cc`, `recipient`) must be a contact
   *   UUID or "principal". An address or a template token there is refused with the
   *   resolver's message, before any lookup.
   * - References resolve through the same resolver the skill uses, including a
   *   `#label` hint (`principal#personal`, #2047), so the gate sees the address the
   *   skill will send to.
   *
   * Returns reference → address. Without a contact service the map is empty: the
   * skill still resolves (and fails closed) itself, and Gate C refuses any reference
   * it cannot look up.
   */
  private async resolveSendSkillReferences(
    toolName: string,
    input: Record<string, unknown>,
    skillLogger: Logger,
  ): Promise<
    | { ok: true; resolved: Map<string, string>; pins: SendRecipientPin[] }
    | { ok: false; error: string; errorType?: ErrorType }
  > {
    const resolved = new Map<string, string>();
    const pins: SendRecipientPin[] = [];
    const skill = RECIPIENT_REFERENCE_SKILLS[toolName];
    if (!skill) return { ok: true, resolved, pins };
    const entriesOf = (value: unknown): string[] => {
      if (typeof value !== 'string' || !value.trim()) return [];
      return skill.channel === 'email' ? splitCommaSeparatedAddresses(value) : [value.trim()];
    };

    const retired = findRetiredRecipientField(skill, input);
    if (retired) {
      skillLogger.info({ toolName, field: retired }, 'send recipient refused: a retired raw-address input (#2041)');
      return { ok: false, error: retiredRecipientFieldError(skill, retired) };
    }

    // Each reference costs a contact read before any gate. Bound the fan-out from a
    // long list; the handler's own length cap runs later.
    const referenceCount = new Set(skill.references.flatMap((field) => entriesOf(input[field]))).size;
    if (referenceCount > MAX_SEND_REFERENCES) {
      return { ok: false, error: `Too many recipients (${referenceCount}); the limit is ${MAX_SEND_REFERENCES}. Nothing was sent.` };
    }

    for (const field of skill.references) {
      for (const entry of entriesOf(input[field])) {
        if (resolved.has(entry.trim())) continue;
        const parsed = parseRecipientReference(entry);
        const isReference = parsed !== null;
        if (isReference && !this.contactService) continue;
        const result = await resolveRecipientReference(entry, skill.channel, { field }, {
          // Never called for a reference without a contact service (skipped above);
          // a non-reference returns its error before any lookup.
          contactService: this.contactService ?? { getContactWithIdentities: async () => undefined },
          principalContactId: this.principalIdentities[0]?.contactId,
        });
        if (!result.ok) {
          if (result.cause !== undefined) {
            skillLogger.warn(
              { err: result.cause, toolName, field },
              'send recipient reference lookup failed — refusing (fail-closed, #2033)',
            );
            return {
              ok: false,
              error: result.error,
              ...(isDbUnavailableError(result.cause) ? { errorType: 'DATABASE_UNAVAILABLE' as const } : {}),
            };
          }
          skillLogger.info({ toolName, field, isReference }, 'send recipient reference refused before the gates (#2033)');
          return { ok: false, error: result.error };
        }
        resolved.set(entry.trim(), result.identifier);
        if (parsed?.label) {
          pins.push({
            ref: entry.trim(),
            identityId: result.identityId,
            identityName: result.identityName,
          });
        }
      }
    }
    return { ok: true, resolved, pins };
  }
```

(d) In `confirmPinnedSendResolution`, replace:

```ts
    const fields = SEND_SKILL_RECIPIENT_FIELDS[toolName];
    if (!fields || !this.contactService) return { ok: false, error: STALE_SEND_APPROVAL_ERROR };
```

with:

```ts
    const skill = RECIPIENT_REFERENCE_SKILLS[toolName];
    if (!skill || !this.contactService) return { ok: false, error: STALE_SEND_APPROVAL_ERROR };
```

Then change its `resolveRecipientReference` call arguments from `fields.channel, { field: fields.reference, rawField: fields.raw }` to:

```ts
        skill.channel,
        { field: skill.references[0] ?? 'to' },
```

(e) In `invoke`, replace `if (SEND_SKILL_RECIPIENT_FIELDS[toolName]) {` with `if (RECIPIENT_REFERENCE_SKILLS[toolName]) {`. Change the first sentence of the comment above it to: `// Send-skill recipient references (#2033, #2041): check and resolve them once, before any gate can file an approval. A retired raw-address input, an address in a reference input, or a reference that does not resolve is refused here with the skill's own message,` and keep the rest of that comment.

- [ ] **Step 6: Narrow the handlers' resolver calls**

- `skills/signal-send/handler.ts` (~184–187), `skills/sms-send/handler.ts` (~73–76), `skills/slack-send/handler.ts` (~82–85): replace each `{ field: 'recipient', rawField: '…' }` with `{ field: 'recipient' }`.
- `skills/email/tools/email-send/handler.ts`:
  - delete the `rawField: string,` parameter from `resolveReferenceList`;
  - inside it, call `gateway.resolveRecipientReference('email', entry, { field })`;
  - change its two call sites to `resolveReferenceList(ctx.outboundGateway, to, 'to', ctx.log)` and `resolveReferenceList(ctx.outboundGateway, cc, 'cc', ctx.log)`.
- In the handler tests, change each `toHaveBeenCalledWith(…, { field: 'x', rawField: 'y' })` to `{ field: 'x' }`:
  - `skills/email/tools/email-send/handler.test.ts` lines ~344 and ~364;
  - `skills/signal-send/handler.test.ts` ~92;
  - `skills/sms-send/handler.test.ts` ~54;
  - `skills/slack-send/handler.test.ts` ~89.

- [ ] **Step 7: Convert the existing tests that invoke send skills through the ExecutionLayer with raw inputs**

These would otherwise now be refused before the behaviour they test. Line numbers are from the pre-change file; find each test by its name.

**`tests/unit/skills/execution.policy.test.ts`**

Extend `makeReferenceContacts` (~1532–1560, Gate C describe). It now takes the originator's identities, and holds two more contacts. Add these consts beside `ALICE_REF`/`BOB_REF`:

```ts
    const OLD_ALICE_REF = '44444444-4444-4444-8444-444444444444';
    const UNVERIFIED_ALICE_REF = '55555555-5555-4555-8555-555555555555';
```

```ts
    function makeReferenceContacts(originatorIdentities: ChannelIdentity[] = []) {
      // …identity() helper unchanged…
      const byId: Record<string, { contact: Record<string, unknown>; identities: ChannelIdentity[] }> = {
        // …'principal-1', ALICE_REF, BOB_REF unchanged…
        [OLD_ALICE_REF]: {
          contact: { id: OLD_ALICE_REF, displayName: 'Alice (old address)', primaryEmail: null, primaryPhone: null },
          identities: [identity(OLD_ALICE_REF, 'email', 'alice@oldcorp.com')],
        },
        [UNVERIFIED_ALICE_REF]: {
          contact: { id: UNVERIFIED_ALICE_REF, displayName: 'Alice (unverified)', primaryEmail: null, primaryPhone: null },
          identities: [identity(UNVERIFIED_ALICE_REF, 'email', 'alice@unverified.com')],
        },
      };
      return {
        getContactWithIdentities: vi.fn(async (id: string) => byId[id]),
        getIdentitiesForContact: vi.fn().mockResolvedValue(originatorIdentities),
      } as unknown as ContactService;
    }
```

Each conversion below must keep the original test's assertions on the gate's decision. Only the input and the layer's contact service change.

| Test (pre-change line) | Verdict | Change |
|---|---|---|
| "blocks a known contact send to a third party…" (~1323) | **Delete** | It duplicates "escalates a reference to a third party…" (~1668). Add `if (!result.success) expect(result.error).toContain('known');` to that test. |
| "fails closed … when no judge is configured" (~1390) | Convert | `makeLayerWithScore100(undefined, undefined, TEST_PRINCIPAL_IDENTITIES, { contactService: makeReferenceContacts() })`; input `{ to: BOB_REF }` |
| "… judge configured but disabled" (~1401) | Convert | Same, passing `judge`; input `{ to: BOB_REF }` |
| "allows signal-send to the principal…" with `recipient_number` (~1440) | **Delete** | Covered by reference at ~1582 |
| "escalates email-send with unparsed bcc…" (~1476) | Convert | Layer with `{ contactService: makeReferenceContacts() }`; input `{ to: 'principal', bcc: 'other@example.com', subject: 'x', body: 'y' }` |
| "rejects spoofed principal display name…" (~1494) | Convert to a pre-gate refusal | Keep the setup. Input `{ to: 'CEO', subject: 'x', body: 'y' }`. Rename to `refuses a spoofed principal display name in to before Gate C (#1815, #2041)`. Assert `success: false`, an error matching `/contact-create/`, and neither `handler.execute` nor `classifyAction` called. |
| "escalates principal + non-principal mixed recipient set…" (~1512) | Convert | Layer with `{ contactService: makeReferenceContacts() }`; input `{ to: 'principal', cc: BOB_REF, subject: 'x', body: 'y' }` |
| "keeps the principal carve-out on the raw to_address path" (~1627) | **Delete** | — |
| "defunct identity" (~2254) | Convert | `contactService = makeReferenceContacts([<the test's existing defunct alice@oldcorp.com row>])`; input `{ to: OLD_ALICE_REF }` |
| "unverified identity" (~2291) | Convert | `makeReferenceContacts([<the test's existing unverified row>])`; input `{ to: UNVERIFIED_ALICE_REF }` |
| "cross-channel identity" (~2328) | Convert | `makeReferenceContacts([<the test's existing slack row>])`; input `{ to: ALICE_REF }` |
| "structural path from contactId alone" (~2376) | Convert | `makeReferenceContacts()`; input `{ to: ALICE_REF }` |
| The two delegated-specialist tests with `to_address: 'vendor@example.com'` and `'stranger@example.com'` (~2878, ~2928) | Convert | Add the `vendorContacts()` helper below inside the `delegated specialist task` describe. Add `contactService: vendorContacts(),` to both `new ExecutionLayer(...)` options, and use input `{ to: VENDOR_REF }`. |
| "shows the approver the resolved recipient…" (~3374) | Convert | Code below |
| `it.each` rows "a reference in to_address" / "a labelled reference in to_address" / "a reference in recipient_number" (~3434, 3435, 3437) | **Delete rows** | — |
| `it.each` rows "an address in to" and "an address whose local part contains #…" (~3432, 3436) | Change regex | `/contact-create/` |
| "does not refuse an address whose local part contains # in to_address" (~3501) | **Delete** | Row 3436 covers `principal#ops@…` in `to` |

`vendorContacts` (for the delegated describe):

```ts
    const VENDOR_REF = '66666666-6666-4666-8666-666666666666';
    function vendorContacts(): ContactService {
      return {
        getContactWithIdentities: vi.fn(async (id: string) => (id === VENDOR_REF ? {
          contact: { id, displayName: 'Vendor', primaryEmail: null, primaryPhone: null },
          identities: [{ id: 'id-vendor', contactId: id, channel: 'email', channelIdentifier: 'vendor@example.com',
            label: null, verified: true, verifiedAt: new Date(), status: 'active', source: 'ceo_stated',
            createdAt: new Date(), updatedAt: new Date() }],
        } : undefined)),
        getIdentitiesForContact: vi.fn().mockResolvedValue([]),
      } as unknown as ContactService;
    }
```

The approver-display test becomes:

```ts
    const ref = '44444444-4444-4444-8444-444444444444';
    const opsRef = '77777777-7777-4777-8777-777777777777';
    const entry = (id: string, displayName: string, address: string) => ({
      contact: { id, displayName, primaryEmail: null, primaryPhone: null },
      identities: [{ id: `i-${id}`, contactId: id, channel: 'email', channelIdentifier: address, label: null,
        verified: true, verifiedAt: new Date(), status: 'active', source: 'email_participant',
        createdAt: new Date(), updatedAt: new Date() }],
    });
    const contactService = {
      getContactWithIdentities: vi.fn(async (id: string) =>
        id === ref ? entry(ref, 'Dana Lee', 'dana@example.com') : id === opsRef ? entry(opsRef, 'Ops', 'ops@example.com') : undefined),
    } as unknown as ContactService;
    // …layer setup unchanged; drop the second (raw-path) invoke…
    await layer.invoke('email-send', { to: ref, cc: `${ref}, ${opsRef}`, subject: 'Hi', body: 'Hello' }, undefined, { taskEventId: 'task-1' });
    // …calls extraction unchanged…
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.to).toBe(ref);
    expect(calls[0]!.displayInput.to).toBe('dana@example.com (contact "Dana Lee")');
    expect(calls[0]!.displayInput.cc).toBe('dana@example.com (contact "Dana Lee"), ops@example.com (contact "Ops")');
```

**`tests/unit/skills/send-by-reference.test.ts`, lines ~180–188** ("an address in the reference field is rejected, not sent"): change both `toMatch(/to_address/)` and `toMatch(/recipient_number/)` to `toMatch(/contact-create/)`.

**`tests/unit/dispatch/bullpen-origin-reply.test.ts`.** The layer has no contact service, so the pre-gate check leaves `"principal"` to the skill. There is no autonomy service, so no gate runs. The origin-turn refusal still runs first.
- Replace `executionWith`:
  ```ts
  function executionWith(send: ReturnType<typeof vi.fn>): ExecutionLayer {
    const registry = new ToolRegistry();
    registry.register(signalManifest(), new SignalSendHandler());
    // signal-send takes a reference (#2041). No contact service on the layer, so the
    // pre-gate check leaves "principal" to the skill, which resolves it via the gateway.
    const resolveRecipientReference = vi.fn(async () => ({
      ok: true, kind: 'principal', contactId: originator.contactId, identifier: PRINCIPAL,
      displayName: 'Principal', identityName: 'primary', identityId: 'principal-signal',
    }));
    const gateway = { send, resolveRecipientReference } as unknown as OutboundGateway;
    return new ExecutionLayer(registry, logger, { outboundGateway: gateway });
  }
  ```
- Change every `{ recipient_number: PRINCIPAL, … }` (lines ~154, 172, 234, 325, 342) to `{ recipient: 'principal', … }`.
- If `signalManifest()` declares `recipient_number` in `inputs`, replace it with `recipient`.
- The assertion that `send` was called with `recipient: PRINCIPAL` stands.

**`tests/integration/outbound-delivered-emission.test.ts`** (mocked ContactService):
- Add `const RECIPIENT_ID = '44444444-4444-4444-8444-444444444444';`.
- Add a `getContactWithIdentities` to the existing contactService mock:
  ```ts
    getContactWithIdentities: vi.fn(async (id: string) => (id === RECIPIENT_ID ? {
      contact: { id, displayName: 'Integration Test Recipient', primaryEmail: null, primaryPhone: '+15555550199', tier: 'known' },
      identities: [{ id: 'identity-int-1', contactId: id, channel: 'signal', channelIdentifier: '+15555550199', label: null,
        verified: true, verifiedAt: new Date(), status: 'active', source: 'ceo_stated', createdAt: new Date(), updatedAt: new Date() }],
    } : undefined)),
  ```
- Make the existing `resolveByChannelIdentity` mock return `contactId: RECIPIENT_ID`.
- Invoke with `{ recipient: RECIPIENT_ID, message: 'audit emission test body' }`.
- Assert `recipientContactId: RECIPIENT_ID`.

**`tests/integration/relayed-send-attribution.test.ts`:** add the same `RECIPIENT_ID` and `getContactWithIdentities` to `setup()`'s contactService, and use `recipient: RECIPIENT_ID` in the three tests (~83, 108, 121).

**`tests/integration/research-analyst-multi-turn.test.ts:216`:** `recipient_number: '+15551234567'` becomes `recipient: 'principal'`. The handler is mocked and the layer has no contact service.

**`tests/integration/test-mode-stack.test.ts`**, the test "fails email-send and signal-send invoked the way the coordinator would" (~168–185). The pre-gate check now runs before the capability check, so seed a throwaway contact:

```ts
  it('fails email-send and signal-send invoked the way the coordinator would', async () => {
    const opts = { agentId: 'coordinator', channelId: 'cli', conversationId: 'test-mode-no-send' };
    // Send skills take a contact reference (#2041): the pre-gate check must pass so the
    // capability check is what refuses. Unique identifiers: the database is shared.
    const contact = await stack.contactService.createContact({ displayName: 'Test-mode no-send recipient', source: 'ceo_stated' });
    try {
      await stack.contactService.linkIdentity({ contactId: contact.id, channel: 'email',
        channelIdentifier: `no-send-${randomUUID()}@example.com`, source: 'ceo_stated' });
      await stack.contactService.linkIdentity({ contactId: contact.id, channel: 'signal',
        channelIdentifier: `+1555${String(Date.now()).slice(-7)}`, source: 'ceo_stated' });
      const email = await stack.executionLayer.invoke('email-send', { to: contact.id, subject: 'Hi', body: 'Hello' }, undefined, opts);
      const signal = await stack.executionLayer.invoke('signal-send', { recipient: contact.id, message: 'Hello' }, undefined, opts);
      expect(email).toMatchObject({ success: false, error: expect.stringMatching(/requires capabilities/) });
      expect(signal).toMatchObject({ success: false, error: expect.stringMatching(/requires capabilities/) });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await stack.pool.query('DELETE FROM contacts WHERE id = $1', [contact.id]);
      if (contact.kgNodeId) await stack.pool.query('DELETE FROM kg_nodes WHERE id = $1', [contact.kgNodeId]);
    }
  });
```

Add `import { randomUUID } from 'node:crypto';` if the file lacks it. Leave the `ceo-inbox-draft-compose` call (~198) alone: that skill is #2053's.

- [ ] **Step 8: Run the tests**

Run:

```bash
pnpm -C <wt> exec vitest run tests/unit/skills/recipient-reference.test.ts tests/unit/skills/execution.policy.test.ts tests/unit/skills/send-by-reference.test.ts tests/unit/dispatch/bullpen-origin-reply.test.ts tests/integration/outbound-delivered-emission.test.ts tests/integration/relayed-send-attribution.test.ts tests/integration/research-analyst-multi-turn.test.ts skills/email skills/signal-send skills/sms-send skills/slack-send
```

Expected: PASS.

Run `tests/integration/test-mode-stack.test.ts` too. It needs `DATABASE_URL`. If it is skipped, say so.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm -C <wt> run typecheck
pnpm -C <wt> run lint
git -C <wt> add -A src/skills tests skills
git -C <wt> commit -s -m "feat(gate)!: refuse retired raw-address inputs before any gate (#2041)"
```

Check `git -C <wt> status` before `add -A`, so nothing unrelated is staged.

---

## Task 6: Gate C parsers and export controls read reference inputs only

The pre-gate check refuses retired inputs first. These readers fail closed on one anyway, as a second layer.

**Files:**
- Modify: `src/contacts/principal-carveout-parse.ts` (`parseOneRecipient`)
- Modify: `src/channels/email/principal-rules.ts` (`parseEmailSendRecipients`)
- Modify: `src/channels/signal/principal-rules.ts`, `src/channels/sms/principal-rules.ts`, `src/channels/slack/principal-rules.ts`
- Modify: `src/security/export-controls.ts` (`presentOr` and `extractDestinationFromInput`)
- Test: `tests/unit/contacts/principal-recipient.test.ts`, `tests/unit/security/export-controls.test.ts`

**Interfaces:** `parseOneRecipient(input: Record<string, unknown>): string[] | null`. It loses the `rawKey` parameter.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/contacts/principal-recipient.test.ts`:
- Replace "reads the raw-address fields of each send skill" (~213–225) and delete "counts cc_addresses toward the email-send recipient set" (~239–245).
- Keep the "both set" test (~227–237): it still returns false.

```ts
  // Retired raw inputs (#2041): a present one fails the parser closed, even with the principal's own address.
  it('fails closed when a retired raw-address input is present', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['email-send', { to_address: 'ceo@example.com', subject: 'x', body: 'y' }],
      ['email-send', { to: 'ceo@example.com', cc_addresses: 'ceo@example.com', subject: 'x', body: 'y' }],
      ['signal-send', { recipient_number: '+15551234567', message: 'hi' }],
      ['sms-send', { recipient_number: '+15559876543', message: 'hi' }],
      ['slack-send', { recipient_user_id: 'U_CEO', message: 'hi' }],
    ];
    for (const [tool, input] of cases) {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(tool, input, PRINCIPAL_IDENTITIES), tool).toBe(false);
    }
  });

  it('ignores a blank retired input', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['email-send', { to: 'ceo@example.com', to_address: '', cc_addresses: '  ', subject: 'x', body: 'y' }],
      ['signal-send', { recipient: '+15551234567', recipient_number: '', message: 'hi' }],
      ['sms-send', { recipient: '+15559876543', recipient_number: null, message: 'hi' }],
      ['slack-send', { recipient: 'U_CEO', recipient_user_id: '', message: 'hi' }],
    ];
    for (const [tool, input] of cases) {
      expect(resolvePrincipalIsSoleRecipientFromSkillInput(tool, input, PRINCIPAL_IDENTITIES), tool).toBe(true);
    }
  });
```

In `tests/unit/security/export-controls.test.ts`, replace the test at ~207–217:

```ts
  it('reads the reference inputs of email-send and signal-send only (#2041)', () => {
    expect(extractDestinationFromInput('email-send', { to: 'principal' })).toEqual({ kind: 'email', address: 'principal' });
    expect(extractDestinationFromInput('signal-send', { recipient: 'principal' })).toEqual({ kind: 'signal', address: 'principal' });
    // Retired raw inputs are not read (the pre-gate check refuses them first).
    expect(extractDestinationFromInput('email-send', { to_address: 'new@cold.example' })).toBeNull();
    expect(extractDestinationFromInput('email-send', { to: '  ', to_address: 'new@cold.example' })).toBeNull();
    expect(extractDestinationFromInput('signal-send', { recipient_number: '+15551234567' })).toBeNull();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm -C <wt> exec vitest run tests/unit/contacts/principal-recipient.test.ts tests/unit/security/export-controls.test.ts`
Expected: FAIL. The parsers still read the raw inputs.

- [ ] **Step 3: Implement**

`src/contacts/principal-carveout-parse.ts`. Replace `parseOneRecipient` and its doc comment:

```ts
/**
 * Parse a 1:1 send skill's single recipient: the `recipient` reference input
 * (#2033). Null when it is absent, blank, or not a string — fail closed. The
 * retired raw-address inputs (#2041) are each parser's unparsed keys.
 */
export function parseOneRecipient(input: Record<string, unknown>): string[] | null {
  const reference = input['recipient'];
  if (reference !== undefined && reference !== null && typeof reference !== 'string') return null;
  if (!hasPresentValue(reference)) return null;
  return [(reference as string).trim()];
}
```

`src/channels/email/principal-rules.ts`. Replace `parseEmailSendRecipients` and its doc comment:

```ts
/**
 * Parse email-send recipients from skill input. Returns null when the input contains
 * recipient-shaped keys this parser does not model (fail closed).
 *
 * `to` / `cc` hold contact references (a contact UUID or "principal"); Gate C
 * resolves them to addresses before comparing. The retired raw-address inputs
 * (#2041) are refused before any gate; one that reaches this parser fails it closed.
 */
function parseEmailSendRecipients(input: Record<string, unknown>): string[] | null {
  const unparsedRecipientKeys = [
    'bcc', 'recipients', 'recipient', 'group_id', 'groupId', 'to_address', 'cc_addresses',
  ] as const;
  for (const key of unparsedRecipientKeys) {
    if (hasPresentValue(input[key])) return null;
  }

  for (const key of ['to', 'cc'] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && typeof value !== 'string') return null;
  }
  const to = input['to'];
  if (!hasPresentValue(to) || typeof to !== 'string') return null;

  const emails = splitCommaSeparatedAddresses(to);
  const cc = input['cc'];
  if (typeof cc === 'string' && cc.trim().length > 0) {
    emails.push(...splitCommaSeparatedAddresses(cc));
  }
  return emails;
}
```

Signal, SMS and Slack parsers: add the retired key to each `unparsedRecipientKeys` list, with the comment `// retired raw input (#2041): fail closed`. Signal and SMS get `'recipient_number'`; Slack gets `'recipient_user_id'`. Replace each `return parseOneRecipient(input, '…');` with `return parseOneRecipient(input);`. Update the doc-comment line that says `recipient_number` / `recipient_user_id` holds a raw value: it now reads `` `recipient` holds a contact reference (#2033); Gate C resolves it before comparing. ``

`src/security/export-controls.ts`:
- Delete `presentOr`; it has no other caller.
- In `extractDestinationFromInput`, use `const to = input['to'];` and `const recipient = input['recipient'];`.
- Replace the four-line comment above `to` with:
  ```ts
    // email-send: `to` is a contact reference, shown as written; the gateway's own
    // export gate sees the resolved address (#2033). Raw-address inputs are retired (#2041).
  ```

- [ ] **Step 4: Run tests**

Run: `pnpm -C <wt> exec vitest run tests/unit/contacts/principal-recipient.test.ts tests/unit/security/export-controls.test.ts tests/unit/skills/execution.policy.test.ts tests/unit/skills/send-by-reference.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm -C <wt> run typecheck
pnpm -C <wt> run lint
git -C <wt> add src/contacts/principal-carveout-parse.ts src/channels src/security/export-controls.ts tests/unit/contacts/principal-recipient.test.ts tests/unit/security/export-controls.test.ts
git -C <wt> commit -s -m "fix(gate-c): parse send recipients from reference inputs only (#2041)"
```

---

## Task 7: The four send skills drop their raw-address inputs

**Files:**
- Modify: `skills/email/tools/email-send/handler.ts` + `tool.json`
- Modify: `skills/signal-send/handler.ts` + `tool.json`
- Modify: `skills/sms-send/handler.ts` + `tool.json`
- Modify: `skills/slack-send/handler.ts` + `tool.json`
- Test: the four `handler.test.ts` files, `tests/unit/skills/email-send.test.ts`, `tests/unit/skills/send-by-reference.test.ts`

**Interfaces:**
- Consumes (Task 5): `RECIPIENT_REFERENCE_SKILLS`, `findRetiredRecipientField`, `retiredRecipientFieldError` from `src/skills/_shared/recipient-reference.ts`.
- Produces: the handlers refuse any present retired input, as a third layer.

- [ ] **Step 1: Convert and add handler tests (they fail until Step 3)**

**`skills/email/tools/email-send/handler.test.ts`**
- Add `const MACHINE_ID = '22222222-2222-4222-8222-222222222222';`.
- Add this line to the `resolveRecipientReference` stub, before its fallback:
  `if (value === MACHINE_ID) return { ok: true, kind: 'contact', contactId: MACHINE_ID, identifier: 'machine@exchange.example', displayName: 'Exchange' };`
- Change every `to_address: 'alice@example.com'` to `to: ALICE_ID` (lines ~55, 62, 83, 91, 112, 143, 157, 171, 193, 209, 224, 241, 280, 313). The assertions stand: the stub resolves ALICE_ID to `alice@example.com`.
- Delete "returns error when to_address is an invalid email" (~68).
- Delete "returns error when multiple to addresses are provided" (~75); "rejects more than one reference in to" covers it.
- "resolves cc references and appends cc_addresses" (~352): rename to "resolves cc references", drop `cc_addresses`, and expect `cc: ['alice@example.com']`.
- "rejects to and to_address together" (~390): replace with
  ```ts
    it('refuses a retired input beside to (#2041)', async () => {
      const ctx = makeCtx({ to: 'principal', to_address: 'alice@example.com', subject: 'Hello', body: 'Hi' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/no longer accepted/);
        expect(result.error).toMatch(/contact-create/);
      }
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });
  ```
- "omits contact_id on the raw path" (~409): becomes `omits contact_id for the principal alias`, with `makeCtx({ to: 'principal', subject: 'Hello', body: 'Hi' })`. Keep only the `not.toHaveProperty('contact_id')` assertion.
- The auto-generated suppress test (~423): change `to_address: 'machine@exchange.example'` to `to: MACHINE_ID`.
- Add:
  ```ts
    it.each([
      ['to_address', { to_address: 'a@x.example' }],
      ['cc_addresses', { to: ALICE_ID, cc_addresses: 'b@x.example' }],
      ['cc_addresses as an array', { to: ALICE_ID, cc_addresses: ['b@x.example'] }],
    ])('refuses retired %s (#2041)', async (_label, fields) => {
      const ctx = makeCtx({ ...fields, subject: 'S', body: 'B' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no longer accepted/);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it.each([[{ to_address: '' }], [{ cc_addresses: '  ' }], [{ cc_addresses: [] }], [{ to_address: null }]])(
      'ignores a blank retired input %o (Review Focus 1)',
      async (fields) => {
        expect((await handler.execute(makeCtx({ to: ALICE_ID, ...fields, subject: 'S', body: 'B' }))).success).toBe(true);
      },
    );
  ```

**`skills/signal-send/handler.test.ts`**
- Add `BOB_ID = '22222222-2222-4222-8222-222222222222'` to the stub, resolving to identifier `'+14155551234'`.
- Change `recipient_number: '+14155551234'` to `recipient: BOB_ID` everywhere (~55, 135, 142, 151, 168, 254, 295, 325, 351).
- The "more than one destination" test (~69): input `{ recipient: 'principal', group_id: 'grpABC==', message: 'hi' }`, regex `/exactly one of recipient or group_id/`.
- The test at ~75–80 becomes a retired refusal: `{ recipient_number: '+14155551234', message: 'hi' }` matches `/no longer accepted/`, and send is not called.
- Delete the raw E.164 validation test (~127–132).
- Add a blank-ignored case: `{ recipient: BOB_ID, recipient_number: '', message: 'hi' }` succeeds.
- Add a retired-as-number case: `{ recipient_number: 14155551234, message: 'hi' }` is refused.

**`skills/sms-send/handler.test.ts`**
- Hoist the `resolveRecipientReference` stub to module scope, and add `BOB_ID` resolving to `'4155552671'`, which is not E.164.
- In the test at ~16–24, keep the `{ message: 'hi' }` (missing recipient) half. Replace the raw half with `{ recipient: BOB_ID, message: 'hi' }` and gateway `{ send, resolveRecipientReference }`. Expect `/E\.164/` and send not called.
- Delete the test at ~26–39; ~47 covers it.
- The test at ~72–78 becomes the retired refusal (`/no longer accepted/` and `/contact-create/`).
- Add a blank-ignored case.

**`skills/slack-send/handler.test.ts`**
- Hoist the stub to module scope.
- In ~16–33, keep the first assertion and delete the raw-id half. Turn ~100 into `it.each(['W012ABCDEF', 'C012CHANNEL', 'u012abcdef'])`, with the stub mapping a reference to each, expecting the "not a U… user id" refusal.
- ~35–42: use `recipient: 'principal'`.
- Delete ~44–62; ~82 covers it.
- ~64–73: `{ recipient: 'principal', … }` with gateway `{ send, resolveRecipientReference }`.
- Add a retired refusal (`recipient_user_id: 'U012ABCDEF'`) and a blank-ignored case.

**`tests/unit/skills/email-send.test.ts`** (reply-quote tests):
- Add after `logger`:
  ```ts
  const ALICE_ID = '11111111-1111-4111-8111-111111111111';
  const resolveRecipientReference = vi.fn().mockResolvedValue({
    ok: true, kind: 'contact', contactId: ALICE_ID, identifier: 'alice@example.com',
    displayName: 'Alice', identityName: 'primary', identityId: 'id-alice',
  });
  ```
- In `makeCtx`, add `resolveRecipientReference: (...args: unknown[]) => unknown;` to the gateway `Partial<{…}>` type, and build the gateway as `(gateway && { resolveRecipientReference, ...gateway }) as never`.
- Change `to_address: 'alice@example.com'` (lines ~46, 70, 89) to `to: ALICE_ID`.

**`tests/unit/skills/send-by-reference.test.ts`:** the raw-path tests become direct gateway sends. What they test is gateway behaviour on an address no contact holds, and the gateway still takes addresses. Rename "raw-path" to "gateway" in the test names.
- ~200–222: call `const result = await h.gateway.send({ channel: 'email', to: 'pat@home.exampl', subject: 'Drafts', body: 'Here are the drafts.' });` and assert on `result.success` / `result.blockedReason` instead of `result.error`. The FYI-notification assertions stand.
- ~224–237: `h.gateway.send({ channel: 'email', to: 'pat@home.example', cc: ['sam@home.exampl'], subject: 'Drafts', body: 'Here are the drafts.' })`, with `blockedReason` assertions.
- ~241, 244, 275, 291: `h.gateway.send({ channel: 'email', to: <address>, subject, body })`. The provenance assertions stand.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm -C <wt> exec vitest run skills/email skills/signal-send skills/sms-send skills/slack-send tests/unit/skills/email-send.test.ts tests/unit/skills/send-by-reference.test.ts`
Expected: FAIL. The retired-input refusals and the blank-input cases fail against the old handlers.

- [ ] **Step 3: Implement the handlers**

**`skills/email/tools/email-send/handler.ts`**

(a) Replace header-comment lines 7–11 with:

```ts
// Recipients are references (#2033, #2041, ADR-047): `to` and `cc` take a contact ID
// or "principal", and the gateway looks the address up from that contact's verified
// identities. A `#label` hint (`principal#personal`, or on each cc entry) asks for
// that labelled identity (#2047). Someone who is not a contact yet is added first with
// contact-create. The retired raw-address inputs (to_address, cc_addresses) are
// refused, never ignored.
```

(b) Add the import:

```ts
import {
  RECIPIENT_REFERENCE_SKILLS,
  findRetiredRecipientField,
  retiredRecipientFieldError,
} from '../../../../src/skills/_shared/recipient-reference.js';
```

(c) Delete `parseRecipients`. Keep `splitList`, `optionalString`, `resolveReferenceList` (as narrowed in Task 5) and `EMAIL_REGEX`.

(d) In `execute`, replace everything from `const fields: Record<'to' | 'to_address' | 'cc' | 'cc_addresses', …` through the end of the `if (cc) { … }` resolution block with:

```ts
    const skill = RECIPIENT_REFERENCE_SKILLS['email-send']!;
    const retired = findRetiredRecipientField(skill, ctx.input);
    if (retired) return { success: false, error: retiredRecipientFieldError(skill, retired) };

    const fields: Record<'to' | 'cc', string | undefined> = { to: undefined, cc: undefined };
    for (const field of Object.keys(fields) as Array<keyof typeof fields>) {
      const parsed = optionalString(ctx.input, field);
      if (typeof parsed === 'object') return { success: false, error: parsed.error };
      fields[field] = parsed;
    }
    const { to, cc } = fields;

    if (!to) {
      return {
        success: false,
        error: 'Missing recipient: pass to (a contact ID, or "principal" for the principal). Someone who is not a contact yet must be added first with contact-create, which returns their contact ID.',
      };
    }
    if (!subject || typeof subject !== 'string') {
      return { success: false, error: 'Missing required input: subject (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }

    if (subject.length > MAX_SUBJECT_LENGTH) {
      return { success: false, error: `subject must be ${MAX_SUBJECT_LENGTH} characters or fewer` };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }

    // Only a single To recipient is supported. Multiple references in to would
    // silently drop all but the first while reporting success for all of them.
    if (splitList(to).length > 1) {
      return { success: false, error: 'email-send supports a single To recipient. Use cc for additional recipients.' };
    }
    if (splitList(to).length === 0) {
      return { success: false, error: 'to contains no contact reference' };
    }

    if (accountId && !replyToMessageId) {
      return {
        success: false,
        error: 'account is only supported when reply_to_message_id is set. Omit account to send from the primary mailbox.',
      };
    }

    const attachmentsParsed = parseAttachmentInputs(attachmentsRaw);
    if (typeof attachmentsParsed === 'string') {
      return { success: false, error: attachmentsParsed };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'email-send skill requires outboundGateway access. Declare "outboundGateway" in capabilities.',
      };
    }

    // Resolve references to addresses (#2033). Every failure is closed: no send.
    const resolvedTo = await resolveReferenceList(ctx.outboundGateway, to, 'to', ctx.log);
    if ('error' in resolvedTo) return { success: false, error: resolvedTo.error };
    const toAddresses = resolvedTo.addresses;
    const toContactId = resolvedTo.contactIds[0];
    const toIdentity = resolvedTo.identityNames[0];
    let ccAddresses: string[] = [];
    let ccIdentities: string[] = [];
    if (cc) {
      const resolved = await resolveReferenceList(ctx.outboundGateway, cc, 'cc', ctx.log);
      if ('error' in resolved) return { success: false, error: resolved.error };
      ccAddresses = resolved.addresses;
      ccIdentities = resolved.identityNames;
    }
```

(If `ctx.input` is not typed `Record<string, unknown>`, pass `ctx.input as Record<string, unknown>`. `optionalString(ctx.input, …)` already takes it that way.)

**`skills/signal-send/handler.ts`**

(a) Replace header-comment lines 3 and 13–15. The first header line becomes `// Sends a Signal message to a 1:1 recipient (by contact reference) or to a`. The last paragraph becomes:

```ts
// 1:1 recipients are references (#2033, #2041, ADR-047): `recipient` takes a contact ID
// or "principal", resolved to that contact's verified Signal number. Someone who is not
// a contact yet is added first with contact-create. The retired raw input
// (recipient_number) is refused, never ignored.
```

(b) Add the same `recipient-reference.js` import as email-send.

(c) Replace the start of `execute`, from the destructuring through the deleted raw E.164 check (keep the message-length check after it), with:

```ts
    const skill = RECIPIENT_REFERENCE_SKILLS['signal-send']!;
    const retired = findRetiredRecipientField(skill, ctx.input);
    if (retired) return { success: false, error: retiredRecipientFieldError(skill, retired) };

    const { recipient, group_id, message, context_bridge: contextBridgeRaw } = ctx.input as {
      recipient?: string;
      group_id?: string;
      message?: string;
      context_bridge?: string;
    };

    // --- Input validation ---

    if (!message || typeof message !== 'string') {
      return { success: false, error: 'Missing required input: message (string)' };
    }

    // Exactly one of recipient / group_id must be provided.
    const destinations = [recipient, group_id].filter((v) => v !== undefined && v !== null && v !== '');
    if (destinations.length === 0) {
      return {
        success: false,
        error: 'Missing destination: pass recipient (a contact ID, or "principal" for the principal), or group_id. Someone who is not a contact yet must be added first with contact-create, which returns their contact ID.',
      };
    }
    if (destinations.length > 1) {
      return { success: false, error: 'Provide exactly one of recipient or group_id' };
    }
    if (recipient !== undefined && typeof recipient !== 'string') {
      return { success: false, error: 'recipient must be a string' };
    }
```

(d) In the 1:1 section, replace the `if (recipient) { … } else { destination = recipientNumber!; }` block with the body of its `if` branch alone. `recipient` is the destination here, because a group send returned above. Resolve with `ctx.outboundGateway.resolveRecipientReference('signal', recipient as string, { field: 'recipient' })`. In the log line, change `byReference: !!recipient` to `byReference: true`, or drop the field.

**`skills/sms-send/handler.ts`.** Same pattern:
- Header lines 7–9 become the reference paragraph (`recipient_number` retired).
- Add the retired check first (skill `'sms-send'`).
- Destructure `recipient`, `message` and `context_bridge` only.
- `if (recipient !== undefined && recipient !== null && typeof recipient !== 'string') → 'recipient must be a string'`.
- `if (!recipient) → 'Missing recipient: pass recipient (a contact ID, or "principal" for the principal). Someone who is not a contact yet must be added first with contact-create, which returns their contact ID.'`
- Delete the both-present and raw E.164 checks.
- Resolution runs unconditionally, with `{ field: 'recipient' }` and `recipient as string`.

**`skills/slack-send/handler.ts`.** Same pattern with skill `'slack-send'` and retired `recipient_user_id`. Delete the raw `SLACK_USER_ID_REGEX` check on `recipientUserId`, but keep the regex for the resolved identifier. Header lines 10–12 become the reference paragraph.

- [ ] **Step 4: Update the manifests**

These definitions count toward the coordinator's tool budget. Keep the added text to the phrases below.
- **`email-send/tool.json`:**
  - delete the `to_address` and `cc_addresses` inputs;
  - `to` becomes `"string (contact ID or \"principal\", optional #label hint such as principal#personal — a hint, not an address. Not a contact yet: contact-create first)"`;
  - the `cc_identities` output becomes `"string[]? (one per distinct cc address, in that order; repeated references are omitted)"`;
  - `"version": "1.6.0"`.
- **`signal-send/tool.json`:**
  - delete `recipient_number`;
  - `recipient` becomes `"string? (contact ID or \"principal\", optional #label hint such as principal#personal — a hint, not a phone number. Not a contact yet: contact-create first)"`;
  - `"version": "1.4.0"`.
- **`sms-send/tool.json`:**
  - delete `recipient_number`;
  - `recipient` becomes `"string (contact ID or \"principal\", optional #label hint such as principal#personal — a hint, not a phone number. Not a contact yet: contact-create first)"`;
  - `"version": "0.4.0"`.
- **`slack-send/tool.json`:**
  - delete `recipient_user_id`;
  - `recipient` becomes `"string (contact ID or \"principal\", optional #label hint such as principal#personal — a hint, not a user id. Not a contact yet: contact-create first)"`;
  - `"version": "0.4.0"`.

- [ ] **Step 5: Run the tests**

Run: `pnpm -C <wt> exec vitest run skills/email skills/signal-send skills/sms-send skills/slack-send tests/unit/skills tests/unit/dispatch/bullpen-origin-reply.test.ts`
Expected: PASS.

Then run `pnpm -C <wt> exec vitest run tests/unit` to confirm that nothing else used the raw inputs.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm -C <wt> run typecheck
pnpm -C <wt> run lint
git -C <wt> add skills/email/tools/email-send skills/signal-send skills/sms-send skills/slack-send tests/unit/skills
git -C <wt> commit -s -m "feat(skills)!: send skills drop their raw-address inputs (#2041)"
```

---

## Task 8: `email-draft-save` takes a reference

**Files:**
- Modify: `skills/email/tools/email-draft-save/handler.ts` + `tool.json`
- Modify: `src/skills/_shared/recipient-reference.ts`: add `email-draft-save` to `RECIPIENT_REFERENCE_SKILLS`, so the execution layer resolves its `to` before any gate, pins a hinted approval, and shows the resolved address in an approval.
- Test: `skills/email/tools/email-draft-save/handler.test.ts`, `tests/unit/skills/email-draft-save.test.ts`, `tests/unit/skills/recipient-reference.test.ts` (the "covers the send skills" test), `tests/unit/skills/execution.policy.test.ts`

**Interfaces:**
- Consumes: `OutboundGateway.resolveRecipientReference('email', to, { field: 'to' })`.
- Produces: outputs `draft_id`, `to_identity`, and `contact_id?` (only for a UUID reference).

- [ ] **Step 1: Write and convert the tests**

**`skills/email/tools/email-draft-save/handler.test.ts`**
- `BASE_INPUT.to` becomes `ALICE_ID` (`'11111111-1111-4111-8111-111111111111'`).
- `makeMockGateway` gains a resolver:
  ```ts
  const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
    if (value === ALICE_ID) {
      return { ok: true, kind: 'contact', contactId: ALICE_ID, identifier: 'alice@example.com', displayName: 'Alice', identityName: 'work', identityId: 'id-a' };
    }
    if (value === 'principal') {
      return { ok: true, kind: 'principal', contactId: 'p-1', identifier: 'ceo@example.com', displayName: 'P', identityName: 'primary', identityId: 'id-p' };
    }
    return { ok: false, error: `to takes a contact ID or "principal", not "${value}". Someone who is not a contact yet must be added first with contact-create, which returns their contact ID.` };
  });
  ```
  The returned object becomes `{ createEmailDraft: …, resolveRecipientReference }`.
- The "creates a draft" test expects `data` to equal `{ draft_id: 'draft-abc', to_identity: 'work', contact_id: ALICE_ID }`, and `createEmailDraft` to be called with `expect.objectContaining({ to: 'alice@example.com' })`.
- Add:
  ```ts
  describe('EmailDraftSaveHandler — recipient reference (#2041)', () => {
    it('refuses a typed address and saves nothing', async () => {
      const create = vi.fn();
      const result = await new EmailDraftSaveHandler().execute(makeCtx({
        input: { ...BASE_INPUT, to: 'alice@example.com' },
        outboundGateway: makeMockGateway({ createEmailDraft: create }),
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/contact-create/);
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses more than one recipient', async () => {
      const result = await new EmailDraftSaveHandler().execute(makeCtx({ input: { ...BASE_INPUT, to: `${ALICE_ID}, principal` } }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/single recipient/);
    });

    it('omits contact_id for the principal alias', async () => {
      const result = await new EmailDraftSaveHandler().execute(makeCtx({ input: { ...BASE_INPUT, to: 'principal' } }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ draft_id: 'draft-abc', to_identity: 'primary' });
      }
    });
  });
  ```

**`tests/unit/skills/email-draft-save.test.ts`**
- Add `const R_ID = '33333333-3333-4333-8333-333333333333';` and a module-level stub:
  `const resolveRecipientReference = vi.fn().mockResolvedValue({ ok: true, kind: 'contact', contactId: R_ID, identifier: 'r@example.com', displayName: 'R', identityName: 'primary', identityId: 'id-r' });`
- In `makeCtx`, add `resolveRecipientReference` to the gateway type's `Partial<{…}>`, and build `outboundGateway: (gateway && { resolveRecipientReference, ...gateway }) as never`.
- Change every **input** `to: 'r@example.com'` to `to: R_ID`. Leave assertions on what the gateway received (`expect.objectContaining({ … to: 'r@example.com' … })`) and the stubbed message headers (`to: [{ email: 'r@example.com' }]`) unchanged.

**`tests/unit/skills/execution.policy.test.ts`**
- In `layerWithTrigger`, add `registry.register(makeRiskyManifest('email-draft-save', 'low'), handler);`.
- Add this row to the refusal `it.each`: `['an address in email-draft-save to', 'email-draft-save', { to: 'bob@example.com', subject: 'x', body: 'y' }, /contact-create/]`.
- Add this test in the same describe. It uses Task 5's `DANA` and `danaContacts()`:
  ```ts
    it('shows the resolved address when an email-draft-save is held for approval (#2041)', async () => {
      const registry = new ToolRegistry();
      // medium (not the manifest's real low) so Gate B holds it at score 65.
      registry.register(makeRiskyManifest('email-draft-save', 'medium'), makeHandler('should not run'));
      const trigger = makeApprovalTrigger({ created: true, shortRef: 'x', notificationSent: true });
      const layer = new ExecutionLayer(registry, logger, {
        autonomyService: makeAutonomyService(65),
        bus: { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus,
        approvalTrigger: trigger,
        contactService: danaContacts(),
      });

      await layer.invoke('email-draft-save', { to: DANA, subject: 'x', body: 'y' }, undefined, { taskEventId: 'task-1' });

      expect(trigger.request).toHaveBeenCalledOnce();
      const call = (trigger.request as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        input: { to: string };
        displayInput: { to: string };
      };
      expect(call.input.to).toBe(DANA);
      expect(call.displayInput.to).toBe('dana@example.com (contact "Dana Lee")');
    });
  ```

**`tests/unit/skills/recipient-reference.test.ts`:** the key list becomes `['email-draft-save', 'email-send', 'signal-send', 'slack-send', 'sms-send']`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm -C <wt> exec vitest run skills/email/tools/email-draft-save tests/unit/skills/email-draft-save.test.ts tests/unit/skills/recipient-reference.test.ts tests/unit/skills/execution.policy.test.ts`
Expected: FAIL. The handler still saves to the typed address, and the map has no `email-draft-save` entry.

- [ ] **Step 3: Implement**

In `RECIPIENT_REFERENCE_SKILLS`, add after `email-send`:

```ts
  'email-draft-save': { channel: 'email', references: ['to'], retired: {} },
```

Then update the map's doc comment: `Skills that address a recipient by reference (the four send skills and email-draft-save). …`

In `skills/email/tools/email-draft-save/handler.ts`:

(a) Append to the header comment:

```ts
//
// `to` is a contact reference (#2041, ADR-047): a contact ID or "principal", with an
// optional #label hint, resolved by the gateway to a verified address. A draft is
// never addressed to a typed address, so send-draft never sends to one.
```

(b) Add a module constant: `const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;`.

(c) Replace the `to` validation line with:

```ts
    const to = typeof rawTo === 'string' ? rawTo.trim() : undefined;
    if (!to) return { success: false, error: 'Missing required input: to (a contact ID, or "principal" for the principal)' };
    if (to.includes(',')) return { success: false, error: 'email-draft-save takes a single recipient in to.' };
```

(d) After the subject, body and `accountId`/`replyToMessageId` parsing, and before the "no account" warning, add:

```ts
    // Resolve the reference (#2041). Every failure is closed: no draft is saved.
    const resolved = await ctx.outboundGateway.resolveRecipientReference('email', to, { field: 'to' });
    if (!resolved.ok) return { success: false, error: resolved.error };
    if (!EMAIL_REGEX.test(resolved.identifier)) {
      // A stored identity Nylas cannot address: a data defect. Never echo the ID (it may be the principal's).
      ctx.log.warn({ field: 'to' }, 'email-draft-save: verified email identity is not a valid address — refusing (#2041)');
      return {
        success: false,
        error: "The to contact's verified email identity is not a valid address, so no draft was saved. It needs correcting in Contacts.",
      };
    }
    const address = resolved.identifier;
```

(e) Use `address` instead of `to`:
- in `createEmailDraft({ channel: 'email', to: address, … })`;
- in every log line that logged `to`.

(f) The success return becomes:

```ts
    return {
      success: true,
      data: {
        draft_id: result.draftId,
        to_identity: resolved.identityName,
        // Only a UUID the agent passed is echoed; the principal's ID stays out (spec 09).
        ...(resolved.kind === 'contact' ? { contact_id: resolved.contactId } : {}),
      },
    };
```

In `skills/email/tools/email-draft-save/tool.json`:
- `"description"` gains the sentence ` to takes a contact ID, or "principal"; the address comes from their verified identities.`
- `"version": "1.2.0"`
- the `to` input becomes `"string (contact ID or \"principal\", optional #label hint such as principal#personal — a hint, not an address. Not a contact yet: contact-create first)"`
- outputs:
  ```json
  "outputs": {
    "draft_id": "string",
    "to_identity": "string (label of the address used, or \"primary\" or \"unlabelled\")",
    "contact_id": "string? (when to was a contact ID)"
  }
  ```

- [ ] **Step 4: Run tests, typecheck, lint, commit**

```bash
pnpm -C <wt> exec vitest run skills/email tests/unit/skills
pnpm -C <wt> run typecheck
pnpm -C <wt> run lint
git -C <wt> add skills/email/tools/email-draft-save src/skills/_shared/recipient-reference.ts tests/unit/skills
git -C <wt> commit -s -m "feat(email-draft-save): address the draft by contact reference (#2041)"
```

---

## Task 9: The coordinator pins `contact-create`, plus the end-to-end cold-outreach tests

**Files:**
- Modify: `agents/coordinator.yaml`: the pin list (~lines 287–309) and `version`
- Maybe modify: `tests/unit/agents/prompt-budget.test.ts` (only if Step 4 requires it)
- Test: `tests/unit/skills/send-by-reference.test.ts` (new describe block)

**Interfaces:**
- Consumes: `ContactCreateHandler` (Task 3), `ContactLinkIdentityHandler` (Task 4), and the send handlers (Task 7).

- [ ] **Step 1: Write the end-to-end tests**

Append to `tests/unit/skills/send-by-reference.test.ts`. Add the imports at the top:

```ts
import { ContactCreateHandler } from '../../../skills/contacts/tools/contact-create/handler.js';
import { ContactLinkIdentityHandler } from '../../../skills/contacts/tools/contact-link-identity/handler.js';
```

```ts
function contactCtx(h: Harness, input: Record<string, unknown>): ToolContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: h.contacts,
  } as unknown as ToolContext;
}

describe('cold outreach creates a contact first (#2041)', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('contact-create, then email-send to the returned ID, reaches the address that was entered', async () => {
    const created = await new ContactCreateHandler().execute(contactCtx(h, {
      name: 'Dana Whitfield', email: 'Dana.Whitfield@NewCo.example',
    }));
    expect(created.success).toBe(true);
    if (!created.success) return;
    const contactId = (created.data as { contact_id: string }).contact_id;

    const sent = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(contactId)));

    expect(sent.success).toBe(true);
    expect(delivered(h)).toEqual(['dana.whitfield@newco.example']);
    if (sent.success) expect(sent.data).toMatchObject({ contact_id: contactId });
  });

  it('a number entered in local form is stored as E.164 and reachable by sms-send', async () => {
    const created = await new ContactCreateHandler().execute(contactCtx(h, { name: 'Lee Park', sms: '(416) 555-0123' }));
    expect(created.success).toBe(true);
    if (!created.success) return;
    const contactId = (created.data as { contact_id: string }).contact_id;

    const sent = await SKILLS.sms.handler.execute(ctx(h, SKILLS.sms.input(contactId)));

    expect(sent.success).toBe(true);
    expect(delivered(h)).toEqual(['+14165550123']);
  });

  it('a near-miss of a known address is refused, naming that contact, and nothing is sent', async () => {
    const created = await new ContactCreateHandler().execute(contactCtx(h, { name: 'Sam P', email: 'sam@home.exampel' }));
    expect(created.success).toBe(false);
    if (!created.success) {
      expect(created.error).toContain(h.spouseId);
      expect(created.error).toContain('similar email address');
      expect(created.error).not.toContain('sam@home.example');
    }
    expect(delivered(h)).toEqual([]);
  });

  it("a typo of the principal's address is caught as the principal, without the principal's contact ID", async () => {
    const principal = await h.contacts.getContact(h.principalId);
    await h.contacts.saveContact({ ...principal!, systemRole: 'principal' });

    const created = await new ContactCreateHandler().execute(contactCtx(h, { name: 'Pat', email: 'pat@home.exampel' }));

    expect(created.success).toBe(false);
    if (!created.success) {
      expect(created.error).toContain('the principal');
      expect(created.error).not.toContain(h.principalId);
    }
  });

  it('re-stating a first-time recipient makes it reachable by reference', async () => {
    await h.gateway.send({ channel: 'email', to: 'new.person@cold.example', subject: 'Hi', body: 'Hello.' });
    const resolved = await h.contacts.resolveByChannelIdentity('email', 'new.person@cold.example');
    h.nylasSend.mockClear();

    const before = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(resolved!.contactId)));
    expect(before.success).toBe(false);

    const restated = await new ContactLinkIdentityHandler().execute(contactCtx(h, {
      contact_id: resolved!.contactId, channel: 'email', identifier: 'new.person@cold.example',
    }));
    expect(restated).toMatchObject({ success: true, data: { already_linked: true, verified: true } });

    const after = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(resolved!.contactId)));
    expect(after.success).toBe(true);
    expect(delivered(h)).toEqual(['new.person@cold.example']);
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm -C <wt> exec vitest run tests/unit/skills/send-by-reference.test.ts`
Expected: PASS, since Tasks 3, 4 and 7 have landed. If any test fails, fix the code, not the test, unless the test contradicts the spec.

- [ ] **Step 3: Pin `contact-create` to the coordinator**

In `agents/coordinator.yaml`:
- Set `version: "0.25.0"`; a new pinned tool is a minor bump.
- In the "Narrow / standalone pins" list, add `  - contact-create` on the line after `  - contact-update`.
- Add to the comment block above the list, after the `contact-update records…` sentence:

```yaml
  # contact-create adds someone who is not a contact yet: the send skills take a
  # contact ID only, so a cold outreach is contact-create, then the send to the
  # contact_id it returns, in one turn (#2041).
```

Do not add any `system_prompt` text (ADR-046). The rule lives in the tool descriptions from Tasks 3 and 7.

- [ ] **Step 4: Check the coordinator's context budget**

Run: `pnpm -C <wt> exec vitest run tests/unit/agents/prompt-budget.test.ts`

The baseline before this branch was 76,028 bytes over 65 tools, against a 77,000-byte budget.
- If the test passes, go on.
- If `local tool definitions` is over budget, first shorten the `contact-create` description and input strings, without dropping what they say.
- If it is still over, raise `localToolDefinitionBytes` for the coordinator to the measured value rounded up to the next 500. Add a comment line above `AGENT_BUDGETS` like the existing ones: `// Contact-first outreach (#2041): contact-create pinned, since the send skills take a contact ID only and a cold outreach needs it in the same turn; the four send skills' raw-address input descriptions were removed. N bytes over 66 local tools.` Fill in the measured N.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <wt> add agents/coordinator.yaml tests/unit/skills/send-by-reference.test.ts tests/unit/agents/prompt-budget.test.ts
git -C <wt> commit -s -m "feat(coordinator): pin contact-create for cold outreach; end-to-end tests (#2041)"
```

---

## Task 10: Behavior scenarios

**Files:**
- Create: `tests/scenarios/cases/14d-cold-outreach-creates-contact.yaml`
- Modify: `tests/scenarios/cases/14a-send-to-principal-by-alias.yaml`, `14b-send-to-contact-by-id.yaml`, `14c-signal-to-contact-by-id.yaml`, `03b-no-reply-calendar-decline.yaml`, `07-direct-email-reply-as-text.yaml`
- Modify: `tests/scenarios/stub-coverage.json`

The scenario CLI rejects a `with`/`contains` key that is not a real input of the tool. So every `to_address` / `recipient_number` key in these cases must go. The CLI also rejects a `called`/`not_called` tool the coordinator is not offered, which is why this task comes after Task 9.

- [ ] **Step 1: Create the cold-outreach case**

`tests/scenarios/cases/14d-cold-outreach-creates-contact.yaml`:

```yaml
# Case 14d (#2041): cold outreach creates a contact first. Rule: the `to` description in
# skills/email/tools/email-send/tool.json and contact-create's description
# (skills/contacts/tools/contact-create/tool.json): the send skills take a contact ID only,
# so someone who is not a contact yet is added with contact-create and sent to by the
# contact_id it returns. Both routes to an ID are stubbed to return the same one: the
# coordinator's own contact-create, and the contacts specialist.
name: cold outreach creates a contact
description: >
  The principal asks the coordinator to email someone who is not in contacts yet, giving
  the address. The coordinator sends from its own account with email-send, which takes
  only a contact ID.
tags: [email, recipient, contacts]
stub_sets: [human-channels]
inbound:
  from: principal
  channel: cli
  content: >
    Email Dana Whitfield at dana.whitfield@newco.example.test from your account. Tell her
    I'd like 30 minutes next week to talk about the pilot, and ask which times work for her.
tool_stubs:
  contact-create:
    - match: {}
      return:
        contact_id: 6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b
        display_name: Dana Whitfield
        role: null
        kg_node_id: 0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b
        identities_added: 1
  delegate:
    - match: { agent: contacts }
      return:
        agent: contacts
        response: |
          Dana Whitfield was not in contacts, so I added her with the email you gave.

          <resolved_entities>
            <contact name="Dana Whitfield" id="6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b"/>
          </resolved_entities>
    - match: {}
      return: { agent: ceo-inbox, response: Done. }
expected_behaviors:
  - id: sends_to_new_contact_id
    weight: critical
    description: Calls email-send with `to` set to the contact ID that contact-create, or the contacts specialist, returned.
    check:
      called: email-send
      with: { to: 6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b }
  - id: no_address_in_to
    weight: critical
    description: Does not type Dana's address into `to`, which the skill refuses.
    check:
      not_called: [email-send]
      contains: { to: dana.whitfield@newco.example.test }
  - id: message_in_body
    weight: important
    description: The email asks Dana for 30 minutes next week about the pilot and asks which times work.
failure_modes:
  - Passes Dana's address in `to`, which the skill refuses
  - Tells the principal it cannot email someone who is not a contact
  - Delegates to ceo-inbox to draft from the principal's account
```

- [ ] **Step 2: Update the existing cases**

**`14b-send-to-contact-by-id.yaml`**
- Replace header comment lines 2–5 with: `# copied from context. Rule: the \`to\` description in skills/email/tools/email-send/tool.json. The resolved-entity card shows both the contact's id and its email, so typing the email into \`to\` is available and attractive.`
- Add a `contact-create` stub under `tool_stubs`, so the wrong path is available (`return: { contact_id: 9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d, display_name: Priya Natarajan, role: null, kg_node_id: null, identities_added: 1 }`).
- Replace the `no_raw_address` behavior with:
  ```yaml
    - id: no_address_in_to
      weight: critical
      description: Does not email Priya by typing her address into `to`.
      check:
        not_called: [email-send]
        contains: { to: priya.natarajan@example.test }
    - id: no_duplicate_contact
      weight: critical
      description: Does not create a new contact for Priya, who is already one.
      check:
        not_called: [contact-create]
  ```
- `failure_modes`: replace the first two lines with `- Copies Priya's email from her contact card into \`to\`, which the skill refuses` and `- Creates a second contact for Priya instead of using her ID`.

**`14a-send-to-principal-by-alias.yaml`**
- Header line 5 becomes `# typing one into \`to\` is available and attractive (the skill refuses an address there).`
- Keep `no_raw_address`'s check (`with: { to: null }` still catches any call without `to`). Change its description to `Does not call email-send without \`to\` (an address in a retired raw input is refused).`
- `failure_modes` line 1 becomes `- Copies the principal's address from the contact block into \`to\` or a retired raw input`.

**`14c-signal-to-contact-by-id.yaml`**
- Header lines 2–3 become `# number. Rule: the \`recipient\` description in skills/signal-send/tool.json.`
- Keep `no_raw_number`'s check. Its description becomes `Does not call signal-send without \`recipient\` (a number in a retired raw input is refused).`
- `failure_modes` line 1 becomes `- Looks up Daniel's number and types it into \`recipient\``.

**`03b-no-reply-calendar-decline.yaml`.** `does_not_email_the_decliner_by_address` becomes:
```yaml
  - id: does_not_email_the_decliner_by_address
    weight: critical
    description: Does not email Marcus a new message by typing his address into `to` (the skill refuses it; the attempt is the failure).
    check:
      not_called: [email-send]
      contains: { to: marcus.lindqvist@example.test }
```

**`07-direct-email-reply-as-text.yaml`.** `no_send_to_sender_by_address` becomes the same shape, with `contains: { to: tomas.reyes@example.test }` and the description `Does not email Tomas through email-send by typing his address into \`to\`.`

- [ ] **Step 3: Run the case-loader test**

Run: `pnpm -C <wt> exec vitest run tests/unit/scenarios`
Expected: it FAILS only on the missing `stub-coverage.json` entry for "cold outreach creates a contact".

- [ ] **Step 4: Record stub coverage**

The scenario run is a paid behaviour run. It needs `.env` with the OpenRouter key and the local dev database. It also refuses to run beside a live local instance: `docker stop curia-curia-1`.

**Ask the user before running it.** It stops their local dev container and spends money: about $0.10–0.30 for these six cases × 5 runs.
- **If they agree:** link `.env` into the worktree if it is missing (`ln -sf /Users/josephfung/Projects/curia/repos/curia/.env <wt>/.env`). Then run, for each changed case:
  ```bash
  pnpm -C <wt> scenarios --case "cold outreach" --model deepseek/deepseek-v4.1-flash
  ```
  Then `"send to contact by id"`, `"send to principal by alias"`, `"signal to contact by id"`, `"no-reply calendar decline"`, `"direct email reply as text"`. The CLI records each case in `stub-coverage.json`. Report each case's gate result. A critical behaviour below threshold is a finding to fix, not to wave through.
- **If they decline**, add this entry under `"cases"` in `tests/scenarios/stub-coverage.json`, and say in the report that the scenarios were not run:
  ```json
      "cold outreach creates a contact": {
        "unstubbed": null,
        "reason": "Added in #2041; not yet run. Run pnpm scenarios --case \"cold outreach\" to record it."
      },
  ```

Then run `pnpm -C <wt> exec vitest run tests/unit/scenarios`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C <wt> add tests/scenarios
git -C <wt> commit -s -m "test(scenarios): cold outreach creates a contact; drop raw-field checks (#2041)"
```

---

## Task 11: Documentation

**Files:**
- Modify: `docs/adr/047-send-skills-address-recipients-by-reference.md`
- Modify: `docs/specs/09-contacts-and-identity.md`
- Modify: `CLAUDE.md` ("Reaching the principal")
- Modify: `CHANGELOG.md`
- Modify: `docs/wip/2026-10-07-contact-first-outreach-design.md` (status line)

- [ ] **Step 1: ADR-047**

- Under `Status: Accepted`, add the line `Amended: 2026-10-07 — no raw-address path; agent-entered contacts (#2041)`.
- In the Alternatives list, replace the bullet `**No raw path at all; cold outreach creates a contact first** (#727's design). Deferred to #2041. …` with:
  `- **No raw path at all; cold outreach creates a contact first** (#727's design). Deferred from #2033 as a product decision, then adopted in #2041: see "No raw path" below.`
- Replace the whole section `### The raw path is separate and deliberate` with:

```markdown
### No raw path: cold outreach creates a contact first (#2041)

The send skills take references only. `to_address`, `cc_addresses`, `recipient_number` and `recipient_user_id` are retired, and so is `email-draft-save`'s typed `to`, which is now a reference too. Someone who is not a contact yet is added with `contact-create`, which returns the contact ID to send to. The coordinator pins `contact-create`, so a cold outreach is two calls in one turn.

A call that still passes a retired input is refused, not ignored. A dropped `cc_addresses` would send to fewer people than asked and report success. The pre-gate check refuses it, the handler refuses it, and the Gate C parsers treat it as an unparsed recipient key and fail closed. The message names the input, the reference input that replaced it, and `contact-create`. A blank value (`""`, `[]`, null) is not present: models fill unused optional inputs with one.

`send-draft` is unchanged. It sends a draft's envelope as stored, behind its principal-origin gate (ADR-017). Once `email-draft-save` addresses drafts by reference, every draft it sends was addressed by reference or by a person in their own mail client. `ceo-inbox-draft-compose` and `ceo-inbox-draft-edit` still take typed addresses. Their drafts sit in the principal's Gmail and Curia cannot send them. #2053 covers them.

### Agent-entered addresses: `agent_stated`, verified after a duplicate check (#2041)

`contact-create` and `contact-link-identity` used to record `ceo_stated`, so an address an agent typed looked like the principal's own statement. They now record `agent_stated`. `ceo_stated` stays where the principal entered the data: the console and the setup wizard.

`agent_stated` is auto-verified, because otherwise "create, then send by ID" could not work: the resolver sends only to verified identities. The verification is earned by a duplicate check that runs before anything is written (`ContactService.findLikelyDuplicates`):

| Finding | Result |
|---|---|
| The identifier is already on another contact, same channel (email ignoring case, numbers by digits) | Refused, naming that contact. No override |
| The same number on a sibling phone channel (`phone`, `signal`, `sms`) | Candidate |
| A near-miss email: optimal-string-alignment distance 1–2, or 1 when the shorter address has fewer than 12 characters | Candidate |
| A near-miss number: distance 1 on the digits | Candidate |
| The same display name, ignoring case and spacing (`contact-create` only) | Candidate |

A candidate blocks the write until the agent passes `distinct_from` listing every candidate's ID. The list is a statement, "I checked these and they are different people". A boolean override was rejected because a model learns to set a flag before it has seen anything. Refusals name contacts and reasons, never an address. The principal is listed as `the principal`, with `principal` as its `distinct_from` token, so their contact ID stays out of the model's context. A check that cannot run refuses the write.

Identifiers are normalized first:
- email is lowercased;
- numbers are converted to E.164, and a valid E.164 value the phone library does not recognise is kept as typed;
- Slack ids must be `U…` or `W…`.

This makes the comparison meaningful, and stores the identifier in the shape the send skills address.

Rejected verification rules:
- **Unverified, with principal approval on the first send.** A person sees every new address once, but every cold outreach waits on the principal, and #2040 already weighed that friction as a product change.
- **Unverified but sendable.** The resolver would special-case a source, breaking the rule that only verified addresses are sendable.

This is not the near-miss rule rejected below (Option A). It covers every contact, not only the principal. It runs once, when an address is first stored, not on every send. A hit asks the agent rather than blocks the send.

Re-stating an address already on the same contact:
- a verified identity: unchanged;
- an unverified `outbound_recipient` identity: verified in place, keeping its source;
- anything else unverified (`self_claimed`, `sms_participant`): refused, because only the principal can verify those.

An agent may vouch only for what an agent typed. This is how agents reach contacts that a raw send created before this change.
```

- Edit the section `### References are checked before any gate, and Gate C uses the result`:
  - Its sentence `It refuses an address or template token in a reference field, a reference in a raw field, a reference that does not resolve, and more than 25 references, each with the skill's own message.` becomes `It refuses a retired raw-address input, an address or template token in a reference field, a reference that does not resolve, and more than 25 references, each with the skill's own message (#2041).`
  - In the next paragraph, drop the clause about carve-out parsers reading "both fields". They read the reference inputs only.
- Edit the section `### Gateway-created contacts get honest provenance`. Append: `With the raw inputs retired (#2041), the gateway creates such a contact only when send-draft sends a draft a person addressed. An agent re-stating the address with contact-link-identity verifies it.`
- In the section `### No principal-specific similarity rule`, replace the bullet `**A typo in a raw-address field still sends.** …` with:
  `- **A typo in a brand-new address is stored and verified** when it resembles nothing on file (#2041). The principal's message is the only check on that transcription. It now happens once, in a checked and recorded place, instead of on every send.`
- In **Consequences**:
  - Replace the bullet starting `Raw-address paths remain:` with: `- **Breaking change (#2041):** the four send skills' raw-address inputs and email-draft-save's typed to are gone. An approval stored before the deploy with a raw input fails when approved, with a message naming contact-create. That window is 48 hours.`
  - In the bullet starting `A contact the gateway created after a cold send has an unverified identity`, replace `The agent uses the raw field again, or the principal verifies the address.` with `An agent re-states the address with contact-link-identity, or the principal verifies it.`

- [ ] **Step 2: Spec 09**

- Source table (~line 111): add a row after `ceo_stated`:
  `| \`agent_stated\` | An agent entered the identifier with contact-create or contact-link-identity, after the duplicate check before the write (#2041, ADR-047) | Yes |`
- Change the `ceo_stated` row's meaning to `CEO explicitly provided the identifier, through the console or setup ("Jenna's email is jenna@acme.com")`.
- Change the `outbound_recipient` row's Verified cell to `No; verified when the principal confirms it or an agent re-states it`.
- In the paragraph under the table, add after its first sentence: `Agent-stated identities are verified because the duplicate check runs before they are written; see ADR-047.`
- Path 1 (~line 264): `(source: \`ceo_stated\`)` becomes `(source: \`agent_stated\`, after the duplicate check; ADR-047)`.
- Path 2, step 3 (~line 278): `(source: \`ceo_stated\`, verified: \`true\`)` becomes `(source: \`agent_stated\`, verified: \`true\`)`.
- Replace the paragraph at ~line 336 (`Someone with no contact record is reached through a separate raw-address field…`) with:
  `There is no raw-address path (#2041). Someone with no contact record is added first with \`contact-create\`, which refuses an address another contact holds and lists contacts that may be the same person until the agent names them in \`distinct_from\`. The send skills then take the returned contact ID. \`email-draft-save\` takes a reference too.`

- [ ] **Step 3: CLAUDE.md**

In "Reaching the principal", replace:

```
their addresses. Send skills take the contact's UUID; the raw-address fields
(`to_address`, `recipient_number`, …) are only for someone with no contact record.
```

with:

```
their addresses. Send skills and `email-draft-save` take the contact's UUID; there is no
raw-address path. Someone with no contact record is added first with `contact-create`,
which returns the UUID (#2041, ADR-047).
```

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]`, add the bullets below to the matching sections. Create `### Changed`, `### Removed` and `### Security` only if they do not exist yet, in the order Added, Changed, Fixed, Removed, Security. Count the words: at most 15 after the em-dash.

```markdown
### Changed
- **`contact-create`, `contact-link-identity`** — record `agent_stated`; refuse likely duplicates until `distinct_from` names them. (#2041)
- **`email-draft-save` (public API)** — `to` takes a contact reference, not an address. (#2041)
- **Coordinator** — pins `contact-create`, so cold outreach is create then send. (#2041)

### Removed
- **Send skills (public API)** — `to_address`, `cc_addresses`, `recipient_number`, `recipient_user_id` removed; passing one is refused. (#2041)

### Security
- **Agent-entered contacts** — no longer recorded as principal-stated; near-miss addresses are flagged before storing. (#2041)
```

- [ ] **Step 5: Design doc status**

In `docs/wip/2026-10-07-contact-first-outreach-design.md`, change the status line to `**Status:** implemented on branch feat/contact-first-outreach (#2041).`

- [ ] **Step 6: Check, commit**

```bash
grep -rn "to_address\|cc_addresses\|recipient_number\|recipient_user_id" <wt>/CLAUDE.md <wt>/docs/specs <wt>/agents <wt>/skills <wt>/src
```

Expected: only the deliberate mentions remain. These are the retired-input names in `recipient-reference.ts`, the Gate C parsers' unparsed-key lists, the handlers' comments, and the tests.

```bash
git -C <wt> add docs CLAUDE.md CHANGELOG.md
git -C <wt> commit -s -m "docs: ADR-047, spec 09, CLAUDE.md and CHANGELOG for contact-first outreach (#2041)"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full checks**

```bash
pnpm -C <wt> run typecheck
pnpm -C <wt> run lint
pnpm -C <wt> exec vitest run tests/unit skills
```

Expected: all green.

Also run the integration suite if `DATABASE_URL` is set: `pnpm -C <wt> exec vitest run tests/integration`. The local integration suite is known to flake from shared-database contention. A failure in a file this branch did not touch must be re-run on a pristine database before it is attributed to this change.

- [ ] **Step 2: Migrations untouched**

Run `git -C <wt> diff --stat origin/main -- src/db/migrations`. Expected: no output. This plan adds no migration, because `contact_channel_identities.source` has no CHECK constraint.

- [ ] **Step 3: The issue's acceptance criteria, each with its evidence**

| #2041 criterion | Evidence |
|---|---|
| Decision recorded in ADR-047 | Task 11, Step 1 |
| Cold outreach works end to end through contact creation; the raw fields are gone from the four send skills and `email-draft-save` | Task 9's end-to-end tests; Tasks 7 and 8; the grep in Task 11, Step 6 |
| Agent-created contacts carry their own source, and its verification rule is documented | Tasks 2–4 (`agent_stated`); ADR-047 and spec 09 (Task 11) |
| A behavior test covers a cold outreach request | Scenario 14d (Task 10). State whether it was run, and its result. |

- [ ] **Step 4: Review**

Request a whole-branch review (superpowers:requesting-code-review). Point the reviewer at the spec and at this plan's Review Focus section.
