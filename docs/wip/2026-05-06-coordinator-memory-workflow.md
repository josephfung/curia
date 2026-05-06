# Coordinator Memory Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix silent memory store failures and add proactive recall guidance to the coordinator by splitting ambiguous action codes, extracting a shared entity resolution method, and adding a `## Memory` section to the coordinator prompt.

**Architecture:** `EntityMemory.resolveOrCreate()` is extracted from `extract-facts` and becomes the shared find-or-create primitive used by both `extract-facts` and `memory-store`. The `ValidationResult` discriminated union gains two distinct action codes (`entity_not_found`, `rate_limited`) in place of the single `rejected` code. The coordinator prompt gains a `## Memory` section covering storing, proactive recall, and entity resolution.

**Tech Stack:** TypeScript ESM, Vitest, in-memory KnowledgeGraphStore for unit tests (no Postgres required).

**Spec:** `docs/wip/2026-05-06-coordinator-memory-workflow-design.md`

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow`
**Branch:** `feat/memory-workflow`

---

## File Map

| File | Change |
|---|---|
| `src/memory/types.ts` | Split `ValidationResult 'rejected'` → `'entity_not_found'` \| `'rate_limited'` |
| `src/memory/validation.ts` | Emit the two new action codes instead of `'rejected'` |
| `src/memory/entity-memory.ts` | Add `resolveOrCreate()` method; update `StoreFactResult.action`; update `storeFact()` switch |
| `src/memory/entity-memory.resolve-or-create.test.ts` | NEW — unit tests for `resolveOrCreate` and new `storeFact` action codes |
| `skills/memory-store/handler.ts` | Use `resolveOrCreate`, add `entity_type` input, handle new action codes; remove local `resolveEntity` |
| `skills/memory-store/skill.json` | Add `entity_type` input; update `action` output docs |
| `skills/memory-store/handler.test.ts` | Update entity-not-found test (now auto-creates); split rejected test into two |
| `skills/extract-facts/handler.ts` | Replace inline find-or-create with `resolveOrCreate()` |
| `agents/coordinator.yaml` | Add `## Memory` section after `## Relationship Management` |

---

## Task 1: Split ValidationResult in types.ts

**Files:**
- Modify: `src/memory/types.ts:123-127`

No test needed — this is a pure type change that will cause TypeScript compilation errors in the callers that still use `'rejected'`, guiding the subsequent tasks.

- [ ] **Step 1: Edit the ValidationResult union**

Replace lines 123–127:
```typescript
// -- Validation result --
export type ValidationResult =
  | { action: 'create'; validated: ValidatedFactData }
  | { action: 'update'; existingNodeId: string; mergedProperties: Record<string, unknown> }
  | { action: 'conflict'; existingNodeId: string; reason: string }
  | { action: 'rejected'; reason: string };
```
With:
```typescript
// -- Validation result --
export type ValidationResult =
  | { action: 'create'; validated: ValidatedFactData }
  | { action: 'update'; existingNodeId: string; mergedProperties: Record<string, unknown> }
  | { action: 'conflict'; existingNodeId: string; reason: string }
  | { action: 'entity_not_found'; reason: string }
  | { action: 'rate_limited'; reason: string };
```

- [ ] **Step 2: Verify TypeScript catches the callers**

Run:
```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow run typecheck 2>&1 | grep "rejected"
```
Expected: errors in `validation.ts` and `entity-memory.ts` referencing `'rejected'` as an unrecognised action. This confirms the cascade is correct.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow add src/memory/types.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow commit -m "feat: split ValidationResult 'rejected' into entity_not_found and rate_limited"
```

---

## Task 2: Update validation.ts to emit distinct action codes

**Files:**
- Modify: `src/memory/validation.ts:69-84`

- [ ] **Step 1: Update the rate-limit return**

In `validate()`, replace the rate-limit check return (lines 69–73):
```typescript
      return {
        action: 'rejected',
        reason: `Memory write rate limit exceeded (${MAX_WRITES_PER_AGENT_TASK} per agent per task)`,
      };
```
With:
```typescript
      return {
        action: 'rate_limited',
        reason: `Memory write rate limit exceeded (${MAX_WRITES_PER_AGENT_TASK} per agent per task)`,
      };
```

- [ ] **Step 2: Update the entity-not-found return**

In `validate()`, replace the entity existence check return (lines 80–85):
```typescript
      return {
        action: 'rejected',
        reason: `Entity node not found: ${options.entityNodeId}`,
      };
```
With:
```typescript
      return {
        action: 'entity_not_found',
        reason: `Entity node not found: ${options.entityNodeId}`,
      };
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow add src/memory/validation.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow commit -m "feat: validation.ts emits entity_not_found and rate_limited instead of rejected"
```

---

## Task 3: Add EntityMemory.resolveOrCreate() and update storeFact()

**Files:**
- Create: `src/memory/entity-memory.resolve-or-create.test.ts`
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/memory/entity-memory.resolve-or-create.test.ts`:

```typescript
// entity-memory.resolve-or-create.test.ts — unit tests for EntityMemory.resolveOrCreate()
// and the updated storeFact() action codes.
//
// Uses the in-memory KG backend — no Postgres required.

import { describe, it, expect } from 'vitest';
import { KnowledgeGraphStore } from './knowledge-graph.js';
import { EmbeddingService } from './embedding.js';
import { EntityMemory } from './entity-memory.js';
import { MemoryValidator } from './validation.js';
import { createSilentLogger } from '../logger.js';

function makeEntityMemory() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return {
    mem: new EntityMemory(store, validator, embeddingService, createSilentLogger()),
    store,
    validator,
  };
}

describe('EntityMemory.resolveOrCreate', () => {
  it('creates a new entity when label has 0 KG matches', async () => {
    const { mem } = makeEntityMemory();
    const result = await mem.resolveOrCreate({
      label: 'Acme Corp',
      type: 'organization',
      source: 'test',
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('narrowing');
    expect(result.node.label).toBe('Acme Corp');
    expect(result.node.type).toBe('organization');
  });

  it('returns found when label has exactly 1 KG match', async () => {
    const { mem } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
    });

    const result = await mem.resolveOrCreate({
      label: 'Jane Doe',
      type: 'person',
      source: 'test',
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(entity.id);
  });

  it('returns the type-matching node when 2+ labels match and one has the right type', async () => {
    // Insert two nodes with the same label but different types via the store directly,
    // bypassing upsert (which would merge them).
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    const personNode = await store.createNode({
      type: 'person', label: 'River', properties: {}, source: 'test',
    });
    await store.createNode({
      type: 'organization', label: 'River', properties: {}, source: 'test',
    });

    const result = await mem.resolveOrCreate({
      label: 'River',
      type: 'person',
      source: 'test',
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') throw new Error('narrowing');
    expect(result.node.id).toBe(personNode.id);
  });

  it('returns ambiguous when 2+ labels match and none has the right type', async () => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const mem = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    await store.createNode({ type: 'person', label: 'River', properties: {}, source: 'test' });
    await store.createNode({ type: 'organization', label: 'River', properties: {}, source: 'test' });

    const result = await mem.resolveOrCreate({
      label: 'River',
      type: 'event',   // no match for this type
      source: 'test',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') throw new Error('narrowing');
    expect(result.candidates).toHaveLength(2);
  });

  it('uses the caller-supplied confidence when auto-creating (defaults to 0.6)', async () => {
    const { mem } = makeEntityMemory();
    const result = await mem.resolveOrCreate({
      label: 'New Concept',
      type: 'concept',
      source: 'test',
      confidence: 0.4,
    });

    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('narrowing');
    expect(result.node.temporal.confidence).toBe(0.4);
  });
});

describe('EntityMemory.storeFact — updated action codes', () => {
  it('returns action:entity_not_found when entity node does not exist', async () => {
    const { mem } = makeEntityMemory();
    const result = await mem.storeFact({
      entityNodeId: '00000000-0000-0000-0000-000000000000',
      label: 'favourite_color: blue',
      properties: { attribute: 'favourite_color', value: 'blue' },
      source: 'test',
    });

    expect(result.stored).toBe(false);
    expect(result.action).toBe('entity_not_found');
  });

  it('returns action:rate_limited when write limit is exhausted', async () => {
    const { mem, validator } = makeEntityMemory();
    const { entity } = await mem.createEntity({
      type: 'person', label: 'Jane', properties: {}, source: 'test',
    });
    const source = 'agent:coordinator/task:limit-test';

    // Exhaust the 50-write limit without touching storeFact's DB path
    for (let i = 0; i < 50; i++) {
      validator.recordWrite(source);
    }

    const result = await mem.storeFact({
      entityNodeId: entity.id,
      label: 'role: engineer',
      properties: { attribute: 'role', value: 'engineer' },
      source,
    });

    expect(result.stored).toBe(false);
    expect(result.action).toBe('rate_limited');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail (resolveOrCreate doesn't exist yet)**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow test -- src/memory/entity-memory.resolve-or-create.test.ts
```
Expected: `TypeError: mem.resolveOrCreate is not a function` (or similar compile error)

- [ ] **Step 3: Add ResolveOrCreateOptions, ResolveOrCreateResult, and resolveOrCreate() to entity-memory.ts**

After the `findEntities()` method (around line 238), add the new exported types and method:

```typescript
// -- resolveOrCreate types --

export interface ResolveOrCreateOptions {
  label: string;
  type: NodeType;
  source: string;
  /** Confidence to use when auto-creating the entity. Defaults to 0.6 — lower than
   *  the createEntity default (0.7) to reflect that an auto-created node has no
   *  prior context confirming its identity. */
  confidence?: number;
}

export type ResolveOrCreateResult =
  | { kind: 'found' | 'created'; node: KgNode }
  | { kind: 'ambiguous'; candidates: KgNode[] };

// (after findEntities method)

  /**
   * Find or create an entity node by label.
   *
   * Resolution logic (in order):
   *   0 matches → create via createEntity(), return { kind: 'created', node }
   *   1 match   → return { kind: 'found', node }
   *   2+ matches, one has the expected type → return { kind: 'found', node: typeMatch }
   *   2+ matches, no type match → return { kind: 'ambiguous', candidates }
   *
   * This is the shared primitive used by both memory-store (agent-directed writes)
   * and extract-facts (background batch extraction). Callers handle 'ambiguous'
   * differently: memory-store surfaces candidates to the agent for disambiguation;
   * extract-facts takes candidates[0] to avoid stalling a batch job.
   */
  async resolveOrCreate(options: ResolveOrCreateOptions): Promise<ResolveOrCreateResult> {
    const matches = await this.store.findNodesByLabel(options.label);

    if (matches.length === 0) {
      const { entity } = await this.createEntity({
        type: options.type,
        label: options.label,
        properties: {},
        source: options.source,
        confidence: options.confidence ?? 0.6,
      });
      return { kind: 'created', node: entity };
    }

    if (matches.length === 1) {
      return { kind: 'found', node: matches[0]! };
    }

    // 2+ matches — prefer a node whose type matches the caller's expected type.
    const typeMatch = matches.find(n => n.type === options.type);
    if (typeMatch) {
      return { kind: 'found', node: typeMatch };
    }

    // No type match — caller must ask the user to pick one.
    return { kind: 'ambiguous', candidates: matches };
  }
```

- [ ] **Step 4: Update StoreFactResult.action and storeFact() switch in entity-memory.ts**

In the `StoreFactResult` interface (around line 47), change:
```typescript
  action: 'created' | 'updated' | 'conflict' | 'rejected';
```
To:
```typescript
  action: 'created' | 'updated' | 'conflict' | 'entity_not_found' | 'rate_limited';
```

In `storeFact()` switch statement, replace the single `'rejected'` case:
```typescript
      case 'rejected':
        return { stored: false, action: 'rejected', conflict: result.reason };
```
With two cases:
```typescript
      case 'entity_not_found':
        return { stored: false, action: 'entity_not_found', conflict: result.reason };

      case 'rate_limited':
        return { stored: false, action: 'rate_limited', conflict: result.reason };
```

- [ ] **Step 5: Run tests — all should pass now**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow test -- src/memory/entity-memory.resolve-or-create.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow add src/memory/entity-memory.ts src/memory/entity-memory.resolve-or-create.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow commit -m "feat: add EntityMemory.resolveOrCreate() and update storeFact action codes"
```

---

## Task 4: Update memory-store handler and manifest

**Files:**
- Modify: `skills/memory-store/handler.ts`
- Modify: `skills/memory-store/skill.json`
- Modify: `skills/memory-store/handler.test.ts`

- [ ] **Step 1: Update handler tests to reflect new behaviour**

Open `skills/memory-store/handler.test.ts`.

**Replace** the entity resolution section (`describe('entity resolution', ...)`) with:

```typescript
  // ── Entity resolution ─────────────────────────────────────────────────────

  describe('entity resolution', () => {
    it('auto-creates entity when label is not found and stores the fact', async () => {
      // resolveOrCreate creates the entity automatically — no pre-existing node needed
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, VALID_INPUT));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
    });

    it('uses entity_type when auto-creating a new entity', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, {
        ...VALID_INPUT,
        entity: 'Q3 Budget',
        entity_type: 'project',
      }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');

      // Verify the auto-created node has the specified type
      const nodes = await mem.findEntities('Q3 Budget');
      expect(nodes[0]?.type).toBe('project');
    });

    it('resolves entity by direct UUID when passed a node ID', async () => {
      const { mem } = makeEntityMemory();
      const { entity } = await mem.createEntity({
        type: 'person', label: 'Jane Doe', properties: {}, source: 'test',
      });

      // Pass the UUID directly — bypasses label lookup, goes through getEntity()
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, entity: entity.id }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('created');
    });

    it('returns entity_not_found when a UUID entity no longer exists', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, {
        ...VALID_INPUT,
        entity: '00000000-0000-0000-0000-000000000000',
      }));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('entity_not_found');
    });

    it('returns ambiguous when multiple nodes share the same label with no type match', async () => {
      const { mem, store } = makeEntityMemory();
      // Insert two nodes with the same label via the store to bypass upsert
      await store.createNode({ type: 'person', label: 'Jane Doe', properties: {}, source: 'test' });
      await store.createNode({ type: 'organization', label: 'Jane Doe', properties: {}, source: 'test' });

      // No type hint provided — falls back to 'concept', which doesn't match either
      const result = await handler.execute(makeCtx(mem, VALID_INPUT));

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { ambiguous: boolean; candidates: unknown[] } }).data;
      expect(data.ambiguous).toBe(true);
      expect(data.candidates).toHaveLength(2);
    });

    it('rejects unknown entity_type', async () => {
      const { mem } = makeEntityMemory();
      const result = await handler.execute(makeCtx(mem, { ...VALID_INPUT, entity_type: 'spaceship' }));
      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/entity_type/i);
    });
  });
```

**Replace** the `describe('action: rejected', ...)` block with two separate describe blocks:

```typescript
  describe('action: rate_limited', () => {
    it('returns rate_limited with reason when storeFact hits the write limit', async () => {
      const mockEntityMemory = {
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'entity-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockResolvedValue({
          stored: false,
          action: 'rate_limited',
          conflict: 'Memory write rate limit exceeded (50 per agent per task)',
        }),
      };
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockEntityMemory,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('rate_limited');
      expect(String(data.reason)).toMatch(/rate limit/i);
    });
  });

  describe('action: entity_not_found (validator race)', () => {
    it('returns entity_not_found when storeFact reports entity gone at write time', async () => {
      const mockEntityMemory = {
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'entity-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockResolvedValue({
          stored: false,
          action: 'entity_not_found',
          conflict: 'Entity node not found: entity-1',
        }),
      };
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockEntityMemory,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(false);
      expect(data.action).toBe('entity_not_found');
    });
  });
```

Also update the `action: updated` mock test — change `findEntities` to `resolveOrCreate`:
```typescript
  describe('action: updated', () => {
    it('returns updated with node_id and sensitivity when storeFact detects a near-duplicate', async () => {
      const mockEntityMemory = {
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'entity-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockResolvedValue({
          stored: true,
          action: 'updated',
          nodeId: 'fact-existing-42',
          sensitivity: 'internal',
        }),
      };
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockEntityMemory,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const data = (result as { success: true; data: Record<string, unknown> }).data;
      expect(data.stored).toBe(true);
      expect(data.action).toBe('updated');
      expect(data.node_id).toBe('fact-existing-42');
      expect(data.sensitivity).toBe('internal');
    });
  });
```

Also update the error handling mock test — change `findEntities` + `getEntity` to `resolveOrCreate`:
```typescript
  describe('error handling', () => {
    it('returns success:false when storeFact throws unexpectedly', async () => {
      const mockEntityMemory = {
        resolveOrCreate: vi.fn().mockResolvedValue({
          kind: 'found',
          node: { id: 'entity-1', label: 'Jane Doe', type: 'person' },
        }),
        storeFact: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      };
      const ctx = {
        input: VALID_INPUT,
        secret: () => 'test-key',
        log: pino({ level: 'silent' }),
        entityMemory: mockEntityMemory,
      } as unknown as SkillContext;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toContain('DB connection lost');
    });
  });
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow test -- skills/memory-store/handler.test.ts
```
Expected: several failures — the handler still uses `resolveEntity`, doesn't know `entity_type`, and emits `rejected` not `rate_limited`/`entity_not_found`.

- [ ] **Step 3: Rewrite skills/memory-store/handler.ts**

Replace the entire file with:

```typescript
// handler.ts — memory-store skill.
//
// Writes a named fact about a known entity to the knowledge graph.
//
// Entity resolution:
//   - If `entity` is a UUID → direct getEntity() lookup; returns entity_not_found if gone.
//   - Otherwise → entityMemory.resolveOrCreate() which finds or auto-creates the entity.
//
// Possible outcomes:
//   created       — new fact node created and linked to the entity
//   updated       — near-duplicate found; existing node merged in place
//   conflict      — contradicts an existing attribute fact; agent should surface to CEO
//   entity_not_found — UUID entity no longer exists, or entity gone between resolution and write
//   rate_limited  — write limit (50 per task) exceeded

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { DECAY_CLASSES, SENSITIVITY_LEVELS, NODE_TYPES } from '../../src/memory/types.js';
import type { DecayClass, Sensitivity, NodeType } from '../../src/memory/types.js';

const DECAY_CLASSES_SET: ReadonlySet<string> = new Set(DECAY_CLASSES);
const SENSITIVITY_LEVELS_SET: ReadonlySet<string> = new Set(SENSITIVITY_LEVELS);
// 'fact' is not a valid entity type — entities hold facts as linked nodes, not as themselves.
const ENTITY_NODE_TYPES = NODE_TYPES.filter(t => t !== 'fact');
const ENTITY_NODE_TYPES_SET: ReadonlySet<string> = new Set(ENTITY_NODE_TYPES);

// UUID v4 pattern — used to detect when the caller is passing a node ID directly.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemoryStoreHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const {
      entity,
      field,
      value,
      source,
      confidence,
      decay_class,
      sensitivity,
      sensitivity_category,
      entity_type,
    } = ctx.input as {
      entity?: string;
      field?: string;
      value?: string;
      source?: string;
      confidence?: number;
      decay_class?: string;
      sensitivity?: string;
      sensitivity_category?: string;
      entity_type?: string;
    };

    // --- Input validation ---

    if (!entity || typeof entity !== 'string') {
      return { success: false, error: 'Missing required input: entity (string)' };
    }
    if (!field || typeof field !== 'string') {
      return { success: false, error: 'Missing required input: field (string)' };
    }
    if (value === undefined || value === null || typeof value !== 'string') {
      return { success: false, error: 'Missing required input: value (string)' };
    }
    if (!source || typeof source !== 'string') {
      return { success: false, error: 'Missing required input: source (string)' };
    }

    if (confidence !== undefined) {
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        return { success: false, error: 'confidence must be a number between 0 and 1' };
      }
    }

    if (decay_class !== undefined && !DECAY_CLASSES_SET.has(decay_class)) {
      return {
        success: false,
        error: `Unknown decay_class: "${decay_class}". Valid values: ${DECAY_CLASSES.join(', ')}`,
      };
    }

    if (sensitivity !== undefined && !SENSITIVITY_LEVELS_SET.has(sensitivity)) {
      return {
        success: false,
        error: `Unknown sensitivity: "${sensitivity}". Valid values: ${SENSITIVITY_LEVELS.join(', ')}`,
      };
    }

    if (entity_type !== undefined && !ENTITY_NODE_TYPES_SET.has(entity_type)) {
      return {
        success: false,
        error: `Unknown entity_type: "${entity_type}". Valid values: ${ENTITY_NODE_TYPES.join(', ')}`,
      };
    }

    if (!ctx.entityMemory) {
      ctx.log.error('memory-store: entity memory not available');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    try {
      // --- Entity resolution ---
      //
      // UUID → direct getEntity() lookup (caller has a specific node ID).
      // Plain name → resolveOrCreate() which finds or auto-creates the entity.
      //
      // This means callers can pass either a human-readable name or a UUID obtained
      // from contact-lookup / a previous KG query. Names always succeed (auto-create
      // if not found); UUIDs return entity_not_found if the node was deleted.

      const resolvedEntityType = (entity_type as NodeType | undefined) ?? 'concept';
      let entityNode: KgNode;

      if (UUID_PATTERN.test(entity)) {
        const byId = await ctx.entityMemory.getEntity(entity);
        if (!byId) {
          ctx.log.debug({ entity }, 'memory-store: entity UUID not found in KG');
          return {
            success: true,
            data: {
              stored: false,
              action: 'entity_not_found',
              reason: `Entity node not found: "${entity}". The entity may have been deleted — retry with the entity name to auto-create it.`,
            },
          };
        }
        entityNode = byId;
      } else {
        const resolved = await ctx.entityMemory.resolveOrCreate({
          label: entity,
          type: resolvedEntityType,
          source,
          confidence: 0.6,
        });

        if (resolved.kind === 'ambiguous') {
          ctx.log.debug({ entity, count: resolved.candidates.length }, 'memory-store: ambiguous entity label');
          return {
            success: true,
            data: {
              ambiguous: true,
              candidates: resolved.candidates.map(n => ({ id: n.id, label: n.label, type: n.type })),
            },
          };
        }

        entityNode = resolved.node;
      }

      // --- Fact storage ---
      //
      // Label format "<field>: <value>" is the canonical convention used by
      // extract-facts and other skills — human-readable and dedup-stable.
      // Properties carry the structured attribute + value so that
      // validateContradiction() can detect same-field conflicts.
      const label = `${field}: ${value}`;

      const result = await ctx.entityMemory.storeFact({
        entityNodeId: entityNode.id,
        label,
        properties: { attribute: field, value },
        confidence: confidence ?? 0.8,
        decayClass: (decay_class as DecayClass | undefined) ?? 'slow_decay',
        source,
        sensitivity: sensitivity as Sensitivity | undefined,
        sensitivityCategory: sensitivity_category,
      });

      if (result.stored) {
        if (result.sensitivityFallback) {
          ctx.log.warn(
            { entity, field, nodeId: result.nodeId, sensitivity: result.sensitivity },
            'memory-store: sensitivity in result may be inaccurate — stored node was unreadable after update (race/transient DB error)',
          );
        }
        ctx.log.info(
          { entity, field, action: result.action, nodeId: result.nodeId },
          'memory-store: fact stored',
        );
        return {
          success: true,
          data: {
            stored: true,
            action: result.action,
            node_id: result.nodeId,
            sensitivity: result.sensitivity,
          },
        };
      }

      if (result.action === 'conflict') {
        ctx.log.warn(
          { entity, field, existingNodeId: result.existingNodeId },
          'memory-store: fact conflicts with existing KG data — surfacing to agent',
        );
        return {
          success: true,
          data: {
            stored: false,
            action: 'conflict',
            reason: result.conflict,
            existing_node_id: result.existingNodeId,
          },
        };
      }

      if (result.action === 'entity_not_found') {
        // Validator race guard — entity existed at resolution time but was deleted before write.
        ctx.log.warn({ entity, field }, 'memory-store: entity node gone at write time — validator race');
        return {
          success: true,
          data: {
            stored: false,
            action: 'entity_not_found',
            reason: result.conflict,
          },
        };
      }

      // action === 'rate_limited'
      ctx.log.warn({ entity, field, reason: result.conflict }, 'memory-store: write rate limit reached');
      return {
        success: true,
        data: {
          stored: false,
          action: 'rate_limited',
          reason: result.conflict,
        },
      };
    } catch (err) {
      ctx.log.error({ err, entity, field }, 'memory-store: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// -- Helpers --

type KgNode = import('../../src/memory/types.js').KgNode;
```

- [ ] **Step 4: Update skill.json**

Replace `skills/memory-store/skill.json` with:

```json
{
  "name": "memory-store",
  "description": "Write a named fact about a known entity to the knowledge graph. Resolves the entity by name (finding or auto-creating the KG node) or by node ID. Returns one of five outcomes: created (new fact node), updated (near-duplicate merged), conflict (contradicts an existing attribute fact — surface to CEO before proceeding), entity_not_found (UUID entity gone — retry with name), or rate_limited (write limit reached for this task). When multiple entities share the same name and none matches the expected type, returns an ambiguous response with candidates for disambiguation.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "inputs": {
    "entity": "string (the entity name or knowledge-graph node ID to attach the fact to, e.g. 'Jane Doe' or 'uuid-...')",
    "field": "string (the attribute name, e.g. 'preferred_airline' or 'current_role')",
    "value": "string (the value to store, e.g. 'Air Canada' or 'VP of Engineering')",
    "source": "string (provenance string, e.g. 'agent:coordinator/task:abc123/channel:cli')",
    "confidence": "number? (confidence score 0–1, defaults to 0.8)",
    "decay_class": "string? (one of: permanent, slow_decay, fast_decay; defaults to slow_decay)",
    "sensitivity": "string? (one of: public, internal, confidential, restricted; when omitted the engine auto-classifies from content and defaults to internal)",
    "sensitivity_category": "string? (optional category hint for the auto-classifier, e.g. 'financial'; only used when sensitivity is omitted)",
    "entity_type": "string? (optional node type hint for auto-creation when the entity does not exist yet — one of: person, organization, project, decision, event, concept; defaults to 'concept'; has no effect if the entity already exists or if entity is a node ID)"
  },
  "outputs": {
    "stored": "boolean — true when the fact was persisted (created or updated)",
    "action": "string — one of: created, updated, conflict, entity_not_found, rate_limited",
    "node_id": "string — ID of the persisted or existing fact node (present when stored is true)",
    "sensitivity": "string — the sensitivity level actually assigned to the node (present when stored is true)",
    "reason": "string — human-readable explanation when action is conflict, entity_not_found, or rate_limited",
    "existing_node_id": "string — ID of the contradicting fact node (present when action is conflict)",
    "ambiguous": "boolean — true when multiple entities matched the given name with no type winner",
    "candidates": "array of {id, label, type} — populated when ambiguous is true"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000,
  "capabilities": [
    "entityMemory"
  ]
}
```

- [ ] **Step 5: Run tests — all should pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow test -- skills/memory-store/handler.test.ts
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow add skills/memory-store/handler.ts skills/memory-store/skill.json skills/memory-store/handler.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow commit -m "feat: memory-store uses resolveOrCreate, adds entity_type input, emits distinct action codes"
```

---

## Task 5: Refactor extract-facts to use resolveOrCreate

**Files:**
- Modify: `skills/extract-facts/handler.ts:206-214`

- [ ] **Step 1: Run existing extract-facts tests before touching anything**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow test -- skills/extract-facts/handler.test.ts
```
Expected: all tests pass. If any fail, stop and investigate before proceeding.

- [ ] **Step 2: Replace the inline find-or-create with resolveOrCreate()**

In `skills/extract-facts/handler.ts`, replace lines 206–214:
```typescript
          // Resolve entity node — require a type match to avoid attaching facts to a
          // same-label entity of the wrong type (e.g. a person named the same as an org).
          // If no same-type match exists, create a new entity node.
          const matches = await ctx.entityMemory.findEntities(subject);
          const match = matches.find(n => n.type === subjectType);
          const entityNode = match ?? (await ctx.entityMemory.createEntity({
            type: subjectType,
            label: subject,
            properties: {},
            source,
            confidence: 0.6,
          })).entity;
```

With:
```typescript
          // Resolve entity node via the shared find-or-create primitive.
          // On ambiguous (2+ same-label nodes, no type match), take candidates[0]
          // rather than stalling a background batch job — the coordinator prompt
          // guards against this scenario for agent-directed writes.
          const resolved = await ctx.entityMemory.resolveOrCreate({
            label: subject,
            type: subjectType,
            source,
            confidence: 0.6,
          });
          const entityNode = resolved.kind === 'ambiguous' ? resolved.candidates[0]! : resolved.node;
```

- [ ] **Step 3: Run extract-facts tests again — all should still pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow test -- skills/extract-facts/handler.test.ts
```
Expected: same test results as Step 1 — no regressions.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow add skills/extract-facts/handler.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow commit -m "refactor: extract-facts uses EntityMemory.resolveOrCreate instead of inline find-or-create"
```

---

## Task 6: Add ## Memory section to coordinator.yaml

**Files:**
- Modify: `agents/coordinator.yaml:49-51` (after `## Relationship Management`)

- [ ] **Step 1: Insert the Memory section**

In `agents/coordinator.yaml`, after the blank line following the `## Relationship Management` section (line 50) and before `## Audience Awareness` (line 51), insert:

```yaml
  ## Memory
  Use `memory-store` to record facts the CEO asks you to remember, and `memory-query`
  to recall stored context before answering questions or performing tasks.

  ### Storing facts
  Trigger: the CEO says "remember that…", "note that…", "keep in mind that…", or
  "make a note that…".

  1. Identify the subject entity (who or what the fact is about).
  2. Resolve the entity:
     - **Known contact** → `contact-lookup` by name → `kg_node_id`. If 0 results,
       `contact-create` (name only) → `kg_node_id`. If 2+ results, ask the CEO to
       disambiguate — do not proceed until resolved.
     - **Non-contact** (business, venue, concept, etc.) → pass the plain name as
       `entity`; `memory-store` finds or creates the KG node automatically.
  3. Choose `decay_class`:
     - `permanent` — deeply stable facts (birthday, legal name)
     - `slow_decay` — preferences and standing facts that change occasionally (default)
     - `fast_decay` — current-situation facts (active project, this week's priority)
  4. Call `memory-store` with the resolved `entity` and chosen `decay_class`.
  5. Handle the outcome:
     - `stored: true` — confirm naturally ("Got it, I have that on file.")
     - `ambiguous` — ask the CEO which entity they meant before writing.
     - `conflict` — surface it: "I already have [field] as [existing value] — which
       is correct?"
     - `rate_limited` — inform the CEO the write limit was reached for this task.
     - `entity_not_found` — the entity UUID is gone; retry by passing the name directly.

  ### Proactive recall
  Memory should inform any task that involves a known person or entity — not only
  when the CEO asks explicitly.

  - **Explicit recall** — "what's my preferred airline?", "what do you have on
    Xiaopu?" → always call `memory-query` before answering.
  - **Task enrichment** — drafting an email, scheduling a meeting, preparing a
    briefing, booking travel → call `memory-query` for relevant people or entities
    and let stored context shape the output (preferences, relationship notes,
    dietary restrictions, standing instructions, etc.).
  - **Preference-sensitive decisions** — any task where a stored preference would
    change the output (tone, format, channel, logistics) → check memory first.

  Query discipline: use descriptive natural-language queries that capture intent
  ("preferred communication style for Xiaopu", "standing travel preferences"), not
  bare names. Specificity improves precision.

  Surface stored context silently — do not announce "I checked my memory" unless the
  CEO asks how you knew something. If nothing is found, answer from other available
  context; never fabricate a stored preference.

  ### Entity resolution quick reference
  | Who | How |
  |---|---|
  | "me / my / I" (CEO) | `contact-lookup` by CEO name from sender context → `kg_node_id` |
  | Named person in contacts | `contact-lookup` by name → `kg_node_id`; disambiguate if 2+ |
  | Named person not in contacts | `contact-create` name only → `kg_node_id` |
  | Non-person entity (org, venue, concept) | Pass name directly to `memory-store`; skill auto-creates |

```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow commit -m "feat: add Memory section to coordinator prompt — storing and proactive recall guidance"
```

---

## Task 7: Full test run and typecheck

- [ ] **Step 1: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow test
```
Expected: all tests pass. If any fail, read the error message — do not proceed to typecheck until clean.

- [ ] **Step 2: Run typecheck**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow run typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Update CHANGELOG.md**

Under `## [Unreleased]`, add:

```markdown
### Added
- **Coordinator memory workflow** — new `## Memory` section in the coordinator prompt with step-by-step guidance on storing facts (`memory-store`) and proactive recall (`memory-query`); covers known contacts, non-contact entities, decay class selection, and disambiguation.
- **`EntityMemory.resolveOrCreate()`** — shared find-or-create primitive extracted from `extract-facts` and now used by both `memory-store` and `extract-facts`, eliminating code duplication and ensuring consistent entity resolution across the system.

### Changed
- **`memory-store`** — entity names that don't exist in the KG are now auto-created (via `resolveOrCreate`) rather than returning a rejection; `entity_type` optional input added to hint the node type on creation.
- **`extract-facts`** — entity resolution refactored to use `EntityMemory.resolveOrCreate()` (no behaviour change).

### Fixed
- **Silent memory store failure** — `memory-store` no longer returns `action: 'rejected'` conflating two unrelated outcomes; distinct codes `entity_not_found` and `rate_limited` are now returned so the coordinator can respond appropriately to each.
```

- [ ] **Step 4: Commit CHANGELOG**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-memory-workflow commit -m "chore: update CHANGELOG for memory workflow PR"
```
