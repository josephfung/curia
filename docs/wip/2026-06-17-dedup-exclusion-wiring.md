# Dedup Exclusion Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the anti-nag loop by wiring `writeExclusion()` into the contacts agent's decline paths, so that an explicit "not a duplicate" from the CEO writes a permanent `dedup_exclusion` KG fact and prevents the pair from resurfacing.

**Architecture:** Extract `writeExclusion`/`hasExclusion` from `scripts/dedup-contacts.ts` into `src/contacts/dedup-exclusions.ts` so both the sweep script and the new agent skill share one implementation. A new `contact-dedup-exclude` skill exposes the exclusion write to the contacts agent. The agent YAML gains three explicit decline branches — duplicate notification, dedup review task, and weekly scan — each calling the skill when the CEO says "not a duplicate". "Skip this one" remains a temporary defer with no write.

**Tech Stack:** TypeScript ESM, Vitest, PostgreSQL via `pg`, KG facts via `EntityMemory.storeFact()`

## Global Constraints

- ESM only: `.js` extensions on all relative imports; `import.meta.dirname` if dirname is needed
- No `any` — use proper types, generics, or discriminated unions; cast through `unknown` when narrowing `Record<string, unknown>`
- Array element access (`calls[0]`) is `T | undefined` under strict null checks — use non-null assertion `calls[0]!` when element is guaranteed
- All skills return `{ success: true, data }` or `{ success: false, error }` — never throw
- Run `pnpm -C <worktree> run typecheck` before every commit touching `.ts` files
- Test command: `pnpm -C <worktree> run test`
- Worktree path: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/contacts/dedup-exclusions.ts` | Shared `writeExclusion` / `hasExclusion` helpers |
| Create | `src/contacts/dedup-exclusions.test.ts` | Unit tests for shared helpers (moved from script) |
| Modify | `scripts/dedup-contacts.ts` | Remove local definitions; import from shared module |
| Create | `skills/contact-dedup-exclude/skill.json` | Skill manifest |
| Create | `skills/contact-dedup-exclude/handler.ts` | Skill handler — looks up contacts, calls `writeExclusion` twice |
| Create | `tests/unit/skills/contact-dedup-exclude.test.ts` | Skill unit tests |
| Modify | `agents/contacts.yaml` | Add three decline paths; pin `contact-dedup-exclude`; bump version |
| Modify | `CHANGELOG.md` | Entry under `[Unreleased]` |

---

## Task 1: Extract shared exclusion helpers

**Files:**
- Create: `src/contacts/dedup-exclusions.ts`
- Create: `src/contacts/dedup-exclusions.test.ts`
- Modify: `scripts/dedup-contacts.ts:122–210` (remove local definitions, add import)

**Interfaces:**
- Produces: `WriteExclusionOptions`, `HasExclusionOptions`, `writeExclusion()`, `hasExclusion()` — consumed by Task 2 (handler) and the sweep script

- [ ] **Step 1: Create the shared module**

Create `src/contacts/dedup-exclusions.ts` with the type definitions and both helpers. This is a direct extraction from `scripts/dedup-contacts.ts` lines 122–210, with one addition: an optional `source` field on `WriteExclusionOptions` (default `'contacts-dedup'`) so the skill can pass `ctx.memoryWriteSource` for correct per-task rate-limit tracking.

```typescript
// src/contacts/dedup-exclusions.ts
import type { StoreFactOptions } from '../memory/types.js';
import type { KgNode } from '../memory/types.js';

export interface WriteExclusionOptions {
  /** The contact whose KG node will receive the fact. */
  kgNodeId: string;
  /** The other contact's ID that this node is excluding. */
  contactBId: string;
  storeFact: (options: StoreFactOptions) => Promise<unknown>;
  /** Source key for the storeFact call. Skills should pass ctx.memoryWriteSource.
   *  Defaults to 'contacts-dedup' for backward compatibility with the sweep script. */
  source?: string;
}

/**
 * Record a dedup_exclusion KG fact on kgNodeId naming contactBId.
 *
 * Uses permanent decay so the exclusion survives the normal decay schedule.
 * Format: label "dedup_exclusion: <contactBId>", properties.attribute = 'dedup_exclusion',
 * properties.value = contactBId — matching what hasExclusion() queries for.
 */
export async function writeExclusion(opts: WriteExclusionOptions): Promise<void> {
  const { contactBId, kgNodeId, storeFact, source = 'contacts-dedup' } = opts;
  await storeFact({
    entityNodeId: kgNodeId,
    label: `dedup_exclusion: ${contactBId}`,
    properties: { attribute: 'dedup_exclusion', value: contactBId },
    decayClass: 'permanent',
    confidence: 1.0,
    source,
    sensitivity: 'internal',
  });
}

export interface HasExclusionOptions {
  contactAId: string;
  contactBId: string;
  kgNodeIdA: string | null;
  kgNodeIdB: string | null;
  getFacts: (kgNodeId: string) => Promise<KgNode[]>;
}

/**
 * Check whether either contact has a dedup_exclusion fact naming the other.
 * Returns true if an exclusion exists in either direction (A→B or B→A).
 */
export async function hasExclusion(opts: HasExclusionOptions): Promise<boolean> {
  const { contactAId, contactBId, kgNodeIdA, kgNodeIdB, getFacts } = opts;

  if (kgNodeIdA === null && kgNodeIdB === null) return false;

  if (kgNodeIdA !== null) {
    const factsA = await getFacts(kgNodeIdA);
    for (const fact of factsA) {
      const props = fact.properties as Record<string, unknown>;
      if (props.attribute === 'dedup_exclusion' && props.value === contactBId) {
        return true;
      }
    }
  }

  if (kgNodeIdB !== null) {
    const factsB = await getFacts(kgNodeIdB);
    for (const fact of factsB) {
      const props = fact.properties as Record<string, unknown>;
      if (props.attribute === 'dedup_exclusion' && props.value === contactAId) {
        return true;
      }
    }
  }

  return false;
}
```

- [ ] **Step 2: Create the test file for the shared module**

Move the `writeExclusion` and `hasExclusion` tests from `scripts/dedup-contacts.test.ts` (lines 657–787) to a new colocated test file. The test structure is identical — the only change is the import path.

```typescript
// src/contacts/dedup-exclusions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { writeExclusion, hasExclusion } from './dedup-exclusions.js';
import type { KgNode } from '../memory/types.js';

// Minimal KgNode shape that satisfies the KgNode type for test fixtures
function makeFactNode(overrides: { attribute: string; value: string; id?: string }): KgNode {
  return {
    id: overrides.id ?? 'fn-1',
    type: 'fact' as const,
    label: `dedup_exclusion: ${overrides.value}`,
    properties: { attribute: overrides.attribute, value: overrides.value },
    aliases: [],
    embedding: null,
    confidence: 1.0,
    sensitivity: 'internal' as const,
    decayClass: 'permanent' as const,
    source: 'contacts-dedup',
    temporal: { createdAt: new Date(), lastConfirmedAt: new Date() },
  };
}

describe('writeExclusion', () => {
  it('calls storeFact with the correct attribute and value for a dedup_exclusion', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({
      contactBId: 'c2',
      kgNodeId: 'kg-c1',
      storeFact: storeFactMock,
    });

    expect(storeFactMock).toHaveBeenCalledOnce();
    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.entityNodeId).toBe('kg-c1');
    expect((args.properties as Record<string, unknown>).attribute).toBe('dedup_exclusion');
    expect((args.properties as Record<string, unknown>).value).toBe('c2');
    expect(args.decayClass).toBe('permanent');
  });

  it('writes the exclusion label in the expected format', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({ contactBId: 'c2', kgNodeId: 'kg-c1', storeFact: storeFactMock });

    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.label).toBe('dedup_exclusion: c2');
  });

  it('defaults source to contacts-dedup when not provided', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({ contactBId: 'c2', kgNodeId: 'kg-c1', storeFact: storeFactMock });

    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.source).toBe('contacts-dedup');
  });

  it('uses the provided source when supplied', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });

    await writeExclusion({
      contactBId: 'c2',
      kgNodeId: 'kg-c1',
      storeFact: storeFactMock,
      source: 'agent:contacts/task:t1/channel:cli',
    });

    const args = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.source).toBe('agent:contacts/task:t1/channel:cli');
  });
});

describe('hasExclusion', () => {
  it('returns true when the KG node has a dedup_exclusion fact for the other contact', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([
      makeFactNode({ attribute: 'dedup_exclusion', value: 'c2' }),
    ]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(true);
  });

  it('returns false when no dedup_exclusion fact exists', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(false);
  });

  it('returns false when neither contact has a kg_node_id', async () => {
    const getFactsMock = vi.fn().mockResolvedValue([]);

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: null,
      kgNodeIdB: null,
      getFacts: getFactsMock,
    });

    expect(result).toBe(false);
    expect(getFactsMock).not.toHaveBeenCalled();
  });

  it('checks both sides when both contacts have kg_node_ids', async () => {
    const getFactsMock = vi.fn().mockImplementation(async (kgNodeId: string) => {
      if (kgNodeId === 'kg-c2') {
        return [makeFactNode({ attribute: 'dedup_exclusion', value: 'c1', id: 'fn-2' })];
      }
      return [];
    });

    const result = await hasExclusion({
      contactAId: 'c1',
      contactBId: 'c2',
      kgNodeIdA: 'kg-c1',
      kgNodeIdB: 'kg-c2',
      getFacts: getFactsMock,
    });

    expect(result).toBe(true);
  });
});
```

- [ ] **Step 3: Run the new tests to verify they pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring run test src/contacts/dedup-exclusions.test.ts
```

Expected: all 8 tests pass (6 writeExclusion + hasExclusion, plus 2 new source tests).

- [ ] **Step 4: Update `scripts/dedup-contacts.ts` to import from the shared module**

Remove lines 119–210 (the `WriteExclusionOptions`, `HasExclusionOptions`, `writeExclusion`, and `hasExclusion` definitions). Replace the existing type import block at the top with imports from the shared module:

At the top of `scripts/dedup-contacts.ts`, after the existing imports, add:

```typescript
import {
  writeExclusion,
  hasExclusion,
} from '../src/contacts/dedup-exclusions.js';
import type {
  WriteExclusionOptions,
  HasExclusionOptions,
} from '../src/contacts/dedup-exclusions.js';
```

Then delete lines 119–210 (the local interface and function definitions, starting with `// ---------------------------------------------------------------------------` through the closing `}` of `hasExclusion`).

Also remove the comment on the existing `writeExclusion` call site note (the "NOTE: This function is intentionally NOT called" block is deleted since the function itself is gone). Keep the `storeFact` parameter on `RunDedupOptions` — it's still needed by the sweep for the KG fact cache, just not for exclusion writes.

- [ ] **Step 5: Remove the tests for writeExclusion/hasExclusion from the script test file**

Delete lines 657–787 from `scripts/dedup-contacts.test.ts` (the `describe('writeExclusion')` and `describe('hasExclusion')` blocks and the `// ---------------------------------------------------------------------------` separator above them). They now live in `src/contacts/dedup-exclusions.test.ts`.

- [ ] **Step 6: Run the full test suite and typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring run test
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring add \
  src/contacts/dedup-exclusions.ts \
  src/contacts/dedup-exclusions.test.ts \
  scripts/dedup-contacts.ts \
  scripts/dedup-contacts.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring commit -m "refactor: extract writeExclusion/hasExclusion to shared src/contacts/dedup-exclusions module"
```

---

## Task 2: Create `contact-dedup-exclude` skill

**Files:**
- Create: `skills/contact-dedup-exclude/skill.json`
- Create: `skills/contact-dedup-exclude/handler.ts`
- Create: `tests/unit/skills/contact-dedup-exclude.test.ts`

**Interfaces:**
- Consumes: `writeExclusion`, `WriteExclusionOptions` from `../../src/contacts/dedup-exclusions.js`
- Consumes: `SkillHandler`, `SkillContext`, `SkillResult` from `../../src/skills/types.js`
- Consumes: `ctx.contactService.getContact(id)` → `Promise<Contact | undefined>` where `Contact` has `kgNodeId: string | null`
- Consumes: `ctx.entityMemory.storeFact` (bound) as the `storeFact` callback
- Consumes: `ctx.memoryWriteSource?: string` — falls back to `'contacts-dedup'`
- Produces: `{ success: true, data: { contact_a_id, contact_b_id, contact_a_excluded, contact_b_excluded } }` or `{ success: false, error }`

- [ ] **Step 1: Write the failing skill tests**

```typescript
// tests/unit/skills/contact-dedup-exclude.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ContactDedupExcludeHandler } from '../../../skills/contact-dedup-exclude/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '550e8400-e29b-41d4-a716-446655440001';

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('ContactDedupExcludeHandler', () => {
  const handler = new ContactDedupExcludeHandler();

  it('fails when contact_a_id is missing', async () => {
    const result = await handler.execute(makeCtx({ contact_b_id: UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contact_a_id');
  });

  it('fails when contact_b_id is missing', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: UUID_A }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contact_b_id');
  });

  it('fails when contact_a_id is not a valid UUID', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: 'not-a-uuid', contact_b_id: UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('UUID');
  });

  it('fails when both IDs are the same', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: UUID_A, contact_b_id: UUID_A }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('different');
  });

  it('fails when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: UUID_A, contact_b_id: UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('fails when entityMemory is not available', async () => {
    const contactService = { getContact: vi.fn() } as unknown as SkillContext['contactService'];
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('entityMemory');
  });

  it('fails when contact A is not found', async () => {
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) =>
        id === UUID_B ? { id: UUID_B, kgNodeId: 'kg-b' } : undefined,
      ),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: vi.fn() } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(UUID_A);
  });

  it('fails when contact B is not found', async () => {
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) =>
        id === UUID_A ? { id: UUID_A, kgNodeId: 'kg-a' } : undefined,
      ),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: vi.fn() } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(UUID_B);
  });

  it('writes exclusion facts on both KG nodes when both contacts have KG nodes', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) => ({
        id,
        kgNodeId: id === UUID_A ? 'kg-a' : 'kg-b',
        displayName: id === UUID_A ? 'Alice' : 'Bob',
      })),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: storeFactMock } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contact_a_excluded).toBe(true);
      expect(result.data.contact_b_excluded).toBe(true);
    }

    expect(storeFactMock).toHaveBeenCalledTimes(2);
    // A's node names B
    const callA = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callA.entityNodeId).toBe('kg-a');
    expect((callA.properties as Record<string, unknown>).value).toBe(UUID_B);
    // B's node names A
    const callB = storeFactMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(callB.entityNodeId).toBe('kg-b');
    expect((callB.properties as Record<string, unknown>).value).toBe(UUID_A);
  });

  it('skips writing on contacts with no KG node', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) => ({
        id,
        kgNodeId: id === UUID_A ? 'kg-a' : null, // B has no KG node
      })),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: storeFactMock } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contact_a_excluded).toBe(true);
      expect(result.data.contact_b_excluded).toBe(false);
    }
    expect(storeFactMock).toHaveBeenCalledTimes(1);
  });

  it('uses ctx.memoryWriteSource as the storeFact source', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) => ({
        id,
        kgNodeId: id === UUID_A ? 'kg-a' : 'kg-b',
      })),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: storeFactMock } as unknown as SkillContext['entityMemory'];

    await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory, memoryWriteSource: 'agent:contacts/task:t1/channel:cli' },
    ));

    const call = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.source).toBe('agent:contacts/task:t1/channel:cli');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (handler doesn't exist yet)**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring run test tests/unit/skills/contact-dedup-exclude.test.ts
```

Expected: FAIL — `Cannot find module '../../../skills/contact-dedup-exclude/handler.js'`

- [ ] **Step 3: Create the skill manifest**

```json
// skills/contact-dedup-exclude/skill.json
{
  "name": "contact-dedup-exclude",
  "description": "Record a permanent dedup_exclusion KG fact on both contacts, naming each other as not-a-duplicate. Call this when the CEO explicitly confirms two contacts are not the same person. Prevents the pair from being proposed as duplicates again on future sweeps.",
  "version": "0.1.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "contact_a_id": "string (UUID of the first contact)",
    "contact_b_id": "string (UUID of the second contact)"
  },
  "outputs": {
    "contact_a_id": "string — echoed back",
    "contact_b_id": "string — echoed back",
    "contact_a_excluded": "boolean — true if an exclusion fact was written on contact A's KG node",
    "contact_b_excluded": "boolean — true if an exclusion fact was written on contact B's KG node"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000,
  "capabilities": [
    "entityMemory"
  ]
}
```

- [ ] **Step 4: Create the skill handler**

```typescript
// skills/contact-dedup-exclude/handler.ts
import { validate as uuidValidate } from 'uuid';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { writeExclusion } from '../../src/contacts/dedup-exclusions.js';

export class ContactDedupExcludeHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as Record<string, unknown>;
    const contactAId = input['contact_a_id'];
    const contactBId = input['contact_b_id'];

    if (typeof contactAId !== 'string' || !uuidValidate(contactAId)) {
      return { success: false, error: 'contact_a_id must be a valid UUID' };
    }
    if (typeof contactBId !== 'string' || !uuidValidate(contactBId)) {
      return { success: false, error: 'contact_b_id must be a valid UUID' };
    }
    if (contactAId === contactBId) {
      return { success: false, error: 'contact_a_id and contact_b_id must be different' };
    }
    if (!ctx.contactService) {
      return { success: false, error: 'contactService not available' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'entityMemory not available' };
    }

    const [contactA, contactB] = await Promise.all([
      ctx.contactService.getContact(contactAId),
      ctx.contactService.getContact(contactBId),
    ]);

    if (!contactA) {
      return { success: false, error: `Contact not found: ${contactAId}` };
    }
    if (!contactB) {
      return { success: false, error: `Contact not found: ${contactBId}` };
    }

    const source = ctx.memoryWriteSource ?? 'contacts-dedup';
    const storeFact = ctx.entityMemory.storeFact.bind(ctx.entityMemory);
    let contactAExcluded = false;
    let contactBExcluded = false;

    // Write exclusion on A's node naming B
    if (contactA.kgNodeId !== null) {
      await writeExclusion({ contactBId, kgNodeId: contactA.kgNodeId, storeFact, source });
      contactAExcluded = true;
    }

    // Write exclusion on B's node naming A (bidirectional — hasExclusion checks both sides,
    // but writing both ensures the exclusion is found regardless of which contact's node
    // is queried first and handles any edge case where one node is later created)
    if (contactB.kgNodeId !== null) {
      await writeExclusion({ contactBId: contactAId, kgNodeId: contactB.kgNodeId, storeFact, source });
      contactBExcluded = true;
    }

    return {
      success: true,
      data: {
        contact_a_id: contactAId,
        contact_b_id: contactBId,
        contact_a_excluded: contactAExcluded,
        contact_b_excluded: contactBExcluded,
      },
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring run test tests/unit/skills/contact-dedup-exclude.test.ts
```

Expected: all 10 tests pass.

- [ ] **Step 6: Run full suite and typecheck**

```bash
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring run test
pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring run typecheck
```

Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring add \
  skills/contact-dedup-exclude/skill.json \
  skills/contact-dedup-exclude/handler.ts \
  tests/unit/skills/contact-dedup-exclude.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring commit -m "feat: add contact-dedup-exclude skill to write permanent dedup_exclusion KG facts"
```

---

## Task 3: Update `agents/contacts.yaml`

**Files:**
- Modify: `agents/contacts.yaml`

Three changes in one edit: (1) add the new dedup task handling section, (2) add decline branch to the duplicate notification section, (3) add explicit rejection branch to weekly scan section. Also pin the new skill and bump the agent version.

- [ ] **Step 1: Read the current contacts.yaml dedup section**

Read `agents/contacts.yaml` lines 140–185 to confirm the current text before editing.

- [ ] **Step 2: Add `contact-dedup-exclude` to `pinned_skills`**

Find the `pinned_skills:` block (around line 218) and add the new skill alongside the other contact skills:

```yaml
  - contact-dedup-exclude
```

Add it after `contact-find-duplicates` to keep contact skills grouped.

- [ ] **Step 3: Replace the duplicate notification section**

Find and replace the section from `### When you receive a contact.duplicate_detected notification` through `6. Never auto-merge without CEO confirmation.`

Replace with:

```yaml
  ### When you receive a contact.duplicate_detected notification
  A background check found that a newly-created contact may be a duplicate of an
  existing one. Handle this at the next natural opportunity (not as an interrupt):
  1. Use contact-lookup to load both contacts in full (IDs are in the notification).
  2. Identify the primary contact using this heuristic (in priority order):
     - Most verified channel identities
     - Has a role assigned
     - Older created_at (established contact wins)
  3. Call contact-merge with dry_run: true to get the golden record preview.
  4. Present both contacts side-by-side, show what will change, and ask the
     coordinator to confirm with the CEO before merging. Example:
     "I noticed two contacts that look like the same person:
     - Jenna Torres (CFO, verified email jenna@acme.com)
     - J. Torres (no role, email jenna@acme.com)
     I'd merge them into Jenna Torres (CFO). Want me to proceed?"
  5. On confirmation: call contact-merge with dry_run: false.
  6. If the CEO explicitly says they are not the same person ("not a duplicate",
     "different people", "don't merge them"): call contact-dedup-exclude with both
     contact IDs. This prevents the pair from being proposed again.
  7. Never auto-merge without CEO confirmation.
```

- [ ] **Step 4: Add the new dedup review task section**

Insert a new section immediately after the duplicate notification section (before `### Weekly contacts dedup scan`):

```yaml
  ### When you have a dedup review task
  The weekly dedup sweep creates tasks like "Review possible duplicate: Alice / A. Smith"
  with both contact IDs in the task description. Work through them the same way as
  duplicate_detected notifications:
  1. Use contact-lookup to load both contacts in full (IDs are in the task description).
  2. Apply the primary heuristic above to identify which would be primary.
  3. Call contact-merge dry_run: true to preview the golden record.
  4. Present both contacts side-by-side and ask the CEO whether to merge.
  5. On confirmation: call contact-merge with dry_run: false.
  6. If the CEO explicitly says they are not the same person ("not a duplicate",
     "different people", "don't merge them"): call contact-dedup-exclude with both
     contact IDs. This prevents the pair from resurfacing on future sweeps.
  7. If the CEO defers or wants to decide later: close the task without calling
     contact-dedup-exclude. The pair may resurface on a future sweep.
```

- [ ] **Step 5: Replace the weekly scan section**

Find and replace from `### Weekly contacts dedup scan` through `4. After finishing: summarize what was merged.`

Replace with:

```yaml
  ### Weekly contacts dedup scan
  When the scheduler sends "Run your weekly contacts dedup scan":
  1. Call contact-find-duplicates (default min_confidence: probable).
  2. If no pairs found: confirm that no duplicates were detected.
  3. If pairs found: work through them one at a time.
     - For each pair: use the primary heuristic above, call contact-merge dry_run: true,
       present the preview, get confirmation, then merge.
     - If the CEO defers a pair ("skip this one", "not now", "later"): move on without
       merging or recording anything. The pair will resurface next sweep.
     - If the CEO explicitly says they are not the same person ("not a duplicate",
       "different people", "don't merge them"): call contact-dedup-exclude with both
       contact IDs, then move on. The pair will not resurface.
     - Continue until all pairs are reviewed or the CEO ends the session.
  4. After finishing: summarize what was merged and what was permanently excluded.
```

- [ ] **Step 6: Bump the contacts agent version**

Find `version:` in `agents/contacts.yaml` and bump it by a minor increment (new capability added). If current is `0.X.Y`, change to `0.(X+1).0`.

- [ ] **Step 7: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring add agents/contacts.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring commit -m "feat: wire contact-dedup-exclude into contacts agent decline paths"
```

---

## Task 4: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under `[Unreleased]`**

Open `CHANGELOG.md` and add under the `## [Unreleased]` heading:

```markdown
### Added
- **`contact-dedup-exclude` skill** — writes permanent `dedup_exclusion` KG facts on both contacts when the CEO says they are not duplicates, closing the anti-nag loop for the dedup sweep. (#1027)
- **Dedup exclusion helpers** — `writeExclusion`/`hasExclusion` extracted from `scripts/dedup-contacts.ts` to `src/contacts/dedup-exclusions.ts` for shared use between the sweep and the new skill.
- **Contacts agent decline paths** — three explicit "not a duplicate" branches added to `agents/contacts.yaml`: duplicate notification, dedup review task, and weekly scan. "Skip" remains a temporary defer. (#1027)
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-dedup-exclusion-wiring commit -m "chore: update CHANGELOG for dedup exclusion wiring (#1027)"
```
