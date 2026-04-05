# Relationship Edge Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic relationship extraction from conversation — detecting entity-to-entity relationships (e.g. "Xiaopu is Joseph's wife") and persisting them as `kg_edges` so the coordinator's entity context becomes progressively richer.

**Architecture:** A self-classifying `extract-relationships` skill runs a cheap haiku gate first (exits early on non-relational messages), then uses sonnet to extract typed triples, resolves/creates entity nodes by label, and calls a new `EntityMemory.upsertEdge()` for idempotent edge persistence. The coordinator calls it unconditionally after every message.

**Tech Stack:** TypeScript ESM, `@anthropic-ai/sdk` (already a project dependency), Vitest, Postgres via pgvector, in-memory KG backend for unit tests.

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `src/memory/types.ts` | Add 12 new edge types |
| Modify | `src/memory/knowledge-graph.ts` | Add `updateEdge` to interface + both backends + public method |
| Modify | `src/memory/entity-memory.ts` | Add `upsertEdge` method |
| Modify | `vitest.config.ts` | Include `skills/**/*.test.ts` in test discovery |
| Create | `skills/extract-relationships/skill.json` | Skill manifest |
| Create | `skills/extract-relationships/handler.ts` | Skill handler with classifier gate + extraction |
| Create | `skills/extract-relationships/handler.test.ts` | Unit tests (in-memory KG, mock Anthropic) |
| Modify | `agents/coordinator.yaml` | Add Relationship Extraction section to system prompt |
| Create | `tests/integration/extract-relationships.test.ts` | Integration test (real Postgres, mock Anthropic) |

---

### Task 1: Extend EDGE_TYPES

**Files:**
- Modify: `src/memory/types.ts:16-24`

- [ ] **Step 1: Replace the EDGE_TYPES array**

In `src/memory/types.ts`, replace the existing `EDGE_TYPES` constant (lines 16–24) with:

```typescript
// -- Edge types from spec (01-memory-system.md line 72) --
// Original 7 types preserved; 12 new relationship types added per issue #128.
export const EDGE_TYPES = [
  // Structural / generic (original)
  'works_on',
  'decided',
  'attended',
  'relates_to',    // generic fallback — use when no specific type fits
  'belongs_to',
  'authored',
  'mentioned_in',
  // Personal relationships
  'spouse',
  'parent',
  'child',
  'sibling',
  // Professional relationships
  'reports_to',
  'manages',
  'collaborates_with',
  'advises',
  'represents',
  // Organisational membership
  'member_of',
  'founded',
  'invested_in',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-relationship-extraction
npm run build 2>&1 | head -30
```

Expected: no errors (the new types are additive; nothing uses an exhaustive check on `EDGE_TYPES`).

- [ ] **Step 3: Commit**

```bash
git add src/memory/types.ts
git commit -m "feat: extend EDGE_TYPES with personal, professional, and organisational relationships"
```

---

### Task 2: Add `updateEdge` to KnowledgeGraphStore

The idempotency logic in `EntityMemory.upsertEdge` (Task 3) needs to bump `confidence` and `lastConfirmedAt` on an existing edge. `KnowledgeGraphStore` currently has no update path for edges.

**Files:**
- Modify: `src/memory/knowledge-graph.ts`

- [ ] **Step 1: Add `updateEdge` to the `KnowledgeGraphBackend` private interface**

In `src/memory/knowledge-graph.ts`, find the `KnowledgeGraphBackend` interface (around line 46) and add one method after `deleteEdge`:

```typescript
  updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge>;
```

- [ ] **Step 2: Implement `updateEdge` in `PostgresBackend`**

In the `PostgresBackend` class, add after `deleteEdge`:

```typescript
  async updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge> {
    this.logger.debug({ edgeId: id }, 'kg: updating edge');
    const result = await this.pool.query<PgEdgeRow>(
      `UPDATE kg_edges SET confidence = $1, last_confirmed_at = $2 WHERE id = $3 RETURNING *`,
      [updates.confidence, updates.lastConfirmedAt, id],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Edge not found: ${id}`);
    return pgRowToEdge(row);
  }
```

- [ ] **Step 3: Implement `updateEdge` in `InMemoryBackend`**

In the `InMemoryBackend` class, add after `deleteEdge`:

```typescript
  async updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge> {
    const edge = this.edges.get(id);
    if (!edge) throw new Error(`Edge not found: ${id}`);
    const updated: KgEdge = {
      ...edge,
      temporal: {
        ...edge.temporal,
        confidence: updates.confidence,
        lastConfirmedAt: updates.lastConfirmedAt,
      },
    };
    this.edges.set(id, updated);
    return updated;
  }
```

- [ ] **Step 4: Add public method to `KnowledgeGraphStore`**

In the `KnowledgeGraphStore` class, add after `deleteEdge`:

```typescript
  /** Update an edge's confidence and lastConfirmedAt. Used by upsertEdge for idempotency. */
  async updateEdge(id: string, updates: { confidence: number; lastConfirmedAt: Date }): Promise<KgEdge> {
    return this.backend.updateEdge(id, updates);
  }
```

- [ ] **Step 5: Verify build**

```bash
npm run build 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 6: Run existing KG integration test to confirm nothing broke**

```bash
DATABASE_URL=$(grep DATABASE_URL .env | cut -d= -f2-) npx vitest run tests/integration/knowledge-graph.test.ts 2>&1 | tail -20
```

Expected: all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/memory/knowledge-graph.ts
git commit -m "feat: add updateEdge to KnowledgeGraphStore for edge confidence/timestamp updates"
```

---

### Task 3: Add `upsertEdge` to EntityMemory

**Files:**
- Modify: `src/memory/entity-memory.ts`

- [ ] **Step 1: Add the `upsertEdge` method**

In `src/memory/entity-memory.ts`, add this method after `link()`:

```typescript
  /**
   * Idempotent edge creation between two entity nodes.
   *
   * Checks for an existing edge of the same type connecting the same pair of nodes
   * in either direction. If found, bumps lastConfirmedAt and raises confidence
   * (never lowers it). If not found, creates a new edge.
   *
   * The bidirectional check prevents duplicate edges when the same relationship
   * is expressed from different angles ("A is B's spouse" vs "B is A's spouse").
   *
   * Returns the edge and whether it was newly created.
   */
  async upsertEdge(
    sourceId: string,
    targetId: string,
    edgeType: EdgeType,
    properties: Record<string, unknown>,
    source: string,
    confidence: number,
  ): Promise<{ edge: KgEdge; created: boolean }> {
    // getEdgesForNode returns edges where sourceId is on EITHER side of the edge,
    // so a single call covers the bidirectional duplicate check.
    const existingEdges = await this.store.getEdgesForNode(sourceId);
    const match = existingEdges.find(e =>
      e.type === edgeType &&
      (
        (e.sourceNodeId === sourceId && e.targetNodeId === targetId) ||
        (e.sourceNodeId === targetId && e.targetNodeId === sourceId)
      ),
    );

    if (match) {
      // Re-assertion: raise confidence if the new extraction is more confident,
      // and refresh the lastConfirmedAt timestamp.
      const updated = await this.store.updateEdge(match.id, {
        confidence: Math.max(match.temporal.confidence, confidence),
        lastConfirmedAt: new Date(),
      });
      return { edge: updated, created: false };
    }

    const edge = await this.store.createEdge({
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      type: edgeType,
      properties,
      confidence,
      source,
    });
    return { edge, created: true };
  }
```

- [ ] **Step 2: Verify build**

```bash
npm run build 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/memory/entity-memory.ts
git commit -m "feat: add upsertEdge to EntityMemory for idempotent edge creation"
```

---

### Task 4: Enable skill test discovery and create skill manifest

**Files:**
- Modify: `vitest.config.ts`
- Create: `skills/extract-relationships/skill.json`

- [ ] **Step 1: Add skills to vitest test discovery**

In `vitest.config.ts`, update the `include` array:

```typescript
include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'skills/**/*.test.ts'],
```

- [ ] **Step 2: Create `skills/extract-relationships/skill.json`**

```json
{
  "name": "extract-relationships",
  "description": "Extract entity-to-entity relationships from a passage of text and persist them as knowledge graph edges. Self-classifies internally — always safe to call; exits early if no relationships are found.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "text": "string (the message or turn text to extract relationships from)",
    "source": "string (provenance string, e.g. 'agent:coordinator/task:abc123/channel:cli')"
  },
  "outputs": {
    "extracted": "number (new edges created)",
    "confirmed": "number (existing edges re-asserted and updated)",
    "skipped": "boolean (true if the classifier gate determined no relationships were present)"
  },
  "permissions": [],
  "secrets": ["ANTHROPIC_API_KEY"],
  "timeout": 15000
}
```

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts skills/extract-relationships/skill.json
git commit -m "chore: add extract-relationships skill manifest and enable skill test discovery"
```

---

### Task 5: Write failing handler tests

**Files:**
- Create: `skills/extract-relationships/handler.test.ts`
- Create: `skills/extract-relationships/handler.ts` (stub — enough to import, not to pass)

- [ ] **Step 1: Create a stub handler so tests can import it**

Create `skills/extract-relationships/handler.ts`:

```typescript
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ExtractRelationshipsHandler implements SkillHandler {
  async execute(_ctx: SkillContext): Promise<SkillResult> {
    return { success: false, error: 'not implemented' };
  }
}
```

- [ ] **Step 2: Create the test file**

Create `skills/extract-relationships/handler.test.ts`:

```typescript
// handler.test.ts — unit tests for extract-relationships skill.
//
// Uses an in-memory KG backend (no Postgres) and a mock Anthropic client
// injected via the handler constructor, so no real API calls are made.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { ExtractRelationshipsHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// -- Test helpers --

function makeEntityMemory(): EntityMemory {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService);
}

function makeCtx(entityMemory: EntityMemory, input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: () => 'test-api-key',
    log: pino({ level: 'silent' }),
    entityMemory,
  } as unknown as SkillContext;
}

// Creates a mock Anthropic client that returns a scripted sequence of responses.
// First call is the classifier gate; second call (if triggered) is extraction.
function makeMockAnthropicClient(responses: string[]) {
  let callIndex = 0;
  return {
    messages: {
      create: vi.fn().mockImplementation(() => {
        const text = responses[callIndex++] ?? 'no';
        return Promise.resolve({ content: [{ type: 'text', text }] });
      }),
    },
  };
}

// -- Tests --

describe('ExtractRelationshipsHandler', () => {
  it('returns skipped:true when classifier gate fires on unrelated text', async () => {
    const entityMemory = makeEntityMemory();
    const anthropic = makeMockAnthropicClient(['no']);
    const handler = new ExtractRelationshipsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Please schedule a call with the engineering team for Thursday.',
      source: 'test',
    });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { extracted: 0, confirmed: 0, skipped: true } });
    // Classifier was called; extraction was not (only 1 API call made)
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  it('extracts a single relationship and persists the edge', async () => {
    const entityMemory = makeEntityMemory();
    const triple = JSON.stringify([
      { subject: 'Ada Lovelace', subjectType: 'person', predicate: 'manages', object: 'Project Orion', objectType: 'project', confidence: 0.9 },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', triple]);
    const handler = new ExtractRelationshipsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Ada Lovelace is the lead on Project Orion.',
      source: 'test',
    });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { extracted: 1, confirmed: 0, skipped: false } });

    // Verify the edge exists in the KG
    const adaNodes = await entityMemory.findEntities('Ada Lovelace');
    expect(adaNodes).toHaveLength(1);
    const orionNodes = await entityMemory.findEntities('Project Orion');
    expect(orionNodes).toHaveLength(1);

    const queryResult = await entityMemory.query(adaNodes[0]!.id);
    expect(queryResult.relationships).toHaveLength(1);
    expect(queryResult.relationships[0]!.edge.type).toBe('manages');
  });

  it('confirms an existing edge on second call (idempotency)', async () => {
    const entityMemory = makeEntityMemory();
    const triple = JSON.stringify([
      { subject: 'Joseph Fung', subjectType: 'person', predicate: 'spouse', object: 'Xiaopu Fung', objectType: 'person', confidence: 0.95 },
    ]);

    // First invocation — creates the edge
    const anthropic1 = makeMockAnthropicClient(['yes', triple]);
    const handler1 = new ExtractRelationshipsHandler(anthropic1 as never);
    const ctx1 = makeCtx(entityMemory, { text: 'Xiaopu Fung is Joseph\'s wife.', source: 'test' });
    await handler1.execute(ctx1);

    // Second invocation with same text — should confirm, not duplicate
    const anthropic2 = makeMockAnthropicClient(['yes', triple]);
    const handler2 = new ExtractRelationshipsHandler(anthropic2 as never);
    const ctx2 = makeCtx(entityMemory, { text: 'Xiaopu Fung is Joseph\'s wife.', source: 'test' });
    const result = await handler2.execute(ctx2);

    expect(result).toEqual({ success: true, data: { extracted: 0, confirmed: 1, skipped: false } });

    // Exactly two person nodes, one edge — no duplicate
    const josephNodes = await entityMemory.findEntities('Joseph Fung');
    const xiaopuNodes = await entityMemory.findEntities('Xiaopu Fung');
    expect(josephNodes).toHaveLength(1);
    expect(xiaopuNodes).toHaveLength(1);

    const queryResult = await entityMemory.query(josephNodes[0]!.id);
    expect(queryResult.relationships).toHaveLength(1);
  });

  it('creates new nodes for unknown entities', async () => {
    const entityMemory = makeEntityMemory();
    const triple = JSON.stringify([
      { subject: 'New Person A', subjectType: 'person', predicate: 'collaborates_with', object: 'New Person B', objectType: 'person', confidence: 0.8 },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', triple]);
    const handler = new ExtractRelationshipsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'New Person A is collaborating with New Person B.',
      source: 'test',
    });

    await handler.execute(ctx);

    const aNodes = await entityMemory.findEntities('New Person A');
    const bNodes = await entityMemory.findEntities('New Person B');
    expect(aNodes).toHaveLength(1);
    expect(bNodes).toHaveLength(1);
    expect(aNodes[0]!.type).toBe('person');
    expect(bNodes[0]!.type).toBe('person');
    // New nodes created by extraction get a lower confidence (0.6)
    expect(aNodes[0]!.temporal.confidence).toBe(0.6);
  });

  it('acceptance criterion: "Xiaopu Fung is Joseph\'s wife" creates a spouse edge', async () => {
    const entityMemory = makeEntityMemory();
    const triple = JSON.stringify([
      { subject: 'Xiaopu Fung', subjectType: 'person', predicate: 'spouse', object: 'Joseph Fung', objectType: 'person', confidence: 0.95 },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', triple]);
    const handler = new ExtractRelationshipsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Xiaopu Fung is Joseph\'s wife.',
      source: 'test',
    });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { extracted: 1, confirmed: 0, skipped: false } });

    const xiaopuNodes = await entityMemory.findEntities('Xiaopu Fung');
    const josephNodes = await entityMemory.findEntities('Joseph Fung');
    expect(xiaopuNodes).toHaveLength(1);
    expect(josephNodes).toHaveLength(1);

    const queryResult = await entityMemory.query(xiaopuNodes[0]!.id);
    const spouseRel = queryResult.relationships.find(r => r.edge.type === 'spouse');
    expect(spouseRel).toBeDefined();
    expect(spouseRel!.node.label).toBe('Joseph Fung');
  });

  it('falls back to relates_to for an unknown predicate in the extraction output', async () => {
    const entityMemory = makeEntityMemory();
    // LLM returns an edge type not in EDGE_TYPES — should be normalised to relates_to
    const triple = JSON.stringify([
      { subject: 'Alice', subjectType: 'person', predicate: 'knows_well', object: 'Bob', objectType: 'person', confidence: 0.7 },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', triple]);
    const handler = new ExtractRelationshipsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, { text: 'Alice knows Bob well.', source: 'test' });

    await handler.execute(ctx);

    const aliceNodes = await entityMemory.findEntities('Alice');
    const queryResult = await entityMemory.query(aliceNodes[0]!.id);
    expect(queryResult.relationships[0]!.edge.type).toBe('relates_to');
  });
});
```

- [ ] **Step 3: Run tests and confirm they fail**

```bash
npx vitest run skills/extract-relationships/handler.test.ts 2>&1 | tail -20
```

Expected: tests fail with "not implemented" errors.

- [ ] **Step 4: Commit the stub and tests**

```bash
git add skills/extract-relationships/handler.ts skills/extract-relationships/handler.test.ts
git commit -m "test: add failing handler tests for extract-relationships skill"
```

---

### Task 6: Implement the handler

**Files:**
- Modify: `skills/extract-relationships/handler.ts`

- [ ] **Step 1: Replace the stub with the full implementation**

Replace `skills/extract-relationships/handler.ts` entirely:

```typescript
// handler.ts — extract-relationships skill.
//
// Self-classifying: runs a cheap haiku gate first and exits early when the
// message contains no entity-to-entity relationships. Only fires the full
// extraction prompt (sonnet) when the classifier says yes.
//
// Idempotent: calling it twice with the same triple confirms the existing
// edge rather than inserting a duplicate, and may raise its confidence.

import Anthropic from '@anthropic-ai/sdk';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { EDGE_TYPES, NODE_TYPES } from '../../src/memory/types.js';
import type { EdgeType, NodeType } from '../../src/memory/types.js';

// Shape of each triple returned by the LLM extraction prompt.
interface ExtractedTriple {
  subject: string;
  subjectType: NodeType;
  predicate: EdgeType;
  object: string;
  objectType: NodeType;
  confidence: number;
}

const EDGE_TYPES_LIST = EDGE_TYPES.join(', ');
const NODE_TYPES_LIST = NODE_TYPES.join(', ');

export class ExtractRelationshipsHandler implements SkillHandler {
  // Optional Anthropic client injection for testing.
  // In production the skill registry instantiates with no args and the
  // handler creates its own client from ctx.secret('ANTHROPIC_API_KEY').
  constructor(private readonly anthropicClient?: Anthropic) {}

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { text, source } = ctx.input as { text?: string; source?: string };

    if (!text || typeof text !== 'string') {
      return { success: false, error: 'Missing required input: text (string)' };
    }
    if (!source || typeof source !== 'string') {
      return { success: false, error: 'Missing required input: source (string)' };
    }
    if (!ctx.entityMemory) {
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    const client = this.anthropicClient ?? new Anthropic({ apiKey: ctx.secret('ANTHROPIC_API_KEY') });

    // -- Step 1: Classifier gate --
    // Cheap haiku call — exits early on the majority of messages (scheduling,
    // email drafts, lookups) that contain no entity-to-entity relationships.
    const classifierResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Does the following text assert a relationship or connection between two or more people or organisations? Answer only 'yes' or 'no'.\n\n${text}`,
      }],
    });

    const classifierAnswer = (classifierResponse.content[0] as { type: string; text: string }).text
      .toLowerCase()
      .trim();

    if (!classifierAnswer.startsWith('yes')) {
      ctx.log.debug({ textPreview: text.slice(0, 80) }, 'extract-relationships: classifier gate — no relationships, skipping');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: true } };
    }

    // -- Step 2: Extraction prompt --
    // Sonnet call with the full EDGE_TYPES vocabulary. Returns JSON triples.
    const extractionResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Extract entity-to-entity relationships from the text below. Return a JSON array of relationship triples.

Available edge types: ${EDGE_TYPES_LIST}
Available node types: ${NODE_TYPES_LIST}

Rules:
- Only extract relationships between two distinct entities (person, organization, project, etc.)
- Do NOT extract facts about a single entity (e.g. "Joseph lives in Toronto" is a fact about one entity, not a relationship)
- Use 'relates_to' as predicate if no specific edge type fits
- Set confidence between 0.0 and 1.0 based on how explicitly the relationship is stated
- Return ONLY valid JSON, no explanation or markdown fences

Format:
[{"subject":"<name>","subjectType":"<nodeType>","predicate":"<edgeType>","object":"<name>","objectType":"<nodeType>","confidence":<number>}]

Text:
${text}`,
      }],
    });

    // Strip optional markdown code fences the model may include despite instructions
    const rawText = (extractionResponse.content[0] as { type: string; text: string }).text.trim();
    const jsonText = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let triples: ExtractedTriple[];
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!Array.isArray(parsed)) {
        ctx.log.warn({ rawText }, 'extract-relationships: extraction returned non-array, treating as empty');
        return { success: true, data: { extracted: 0, confirmed: 0, skipped: false } };
      }
      triples = parsed as ExtractedTriple[];
    } catch (err) {
      ctx.log.warn({ err, rawText }, 'extract-relationships: failed to parse extraction JSON, treating as empty');
      return { success: true, data: { extracted: 0, confirmed: 0, skipped: false } };
    }

    // -- Steps 3 & 4: Node resolution + edge upsert --
    let extracted = 0;
    let confirmed = 0;

    for (const triple of triples) {
      // Normalise predicate — fall back to 'relates_to' for unknown types
      const predicate: EdgeType = (EDGE_TYPES as readonly string[]).includes(triple.predicate)
        ? triple.predicate as EdgeType
        : 'relates_to';

      // Normalise node types — fall back to 'person' for unknown types
      const subjectType: NodeType = (NODE_TYPES as readonly string[]).includes(triple.subjectType)
        ? triple.subjectType as NodeType
        : 'person';
      const objectType: NodeType = (NODE_TYPES as readonly string[]).includes(triple.objectType)
        ? triple.objectType as NodeType
        : 'person';

      // Resolve subject — find existing node by label or create a new one.
      // New nodes get confidence 0.6 (lower than manually confirmed entities).
      const subjectMatches = await ctx.entityMemory.findEntities(triple.subject);
      const subjectNode = subjectMatches[0] ?? await ctx.entityMemory.createEntity({
        type: subjectType,
        label: triple.subject,
        properties: {},
        source,
      });

      // Resolve object — same pattern
      const objectMatches = await ctx.entityMemory.findEntities(triple.object);
      const objectNode = objectMatches[0] ?? await ctx.entityMemory.createEntity({
        type: objectType,
        label: triple.object,
        properties: {},
        source,
      });

      // Clamp confidence to [0, 1] in case the LLM returns an out-of-range value
      const confidence = typeof triple.confidence === 'number'
        ? Math.min(1, Math.max(0, triple.confidence))
        : 0.7;

      const { created } = await ctx.entityMemory.upsertEdge(
        subjectNode.id,
        objectNode.id,
        predicate,
        {},
        source,
        confidence,
      );

      if (created) {
        extracted++;
      } else {
        confirmed++;
      }
    }

    ctx.log.info({ extracted, confirmed }, 'extract-relationships: complete');
    return { success: true, data: { extracted, confirmed, skipped: false } };
  }
}
```

- [ ] **Step 2: Run tests and confirm they all pass**

```bash
npx vitest run skills/extract-relationships/handler.test.ts 2>&1 | tail -20
```

Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add skills/extract-relationships/handler.ts
git commit -m "feat: implement extract-relationships skill handler"
```

---

### Task 7: Update coordinator system prompt

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Add the Relationship Extraction section**

In `agents/coordinator.yaml`, find the end of the `## Contact Awareness` section (just before `## Audience Awareness`). Insert the following block between them:

```yaml
  ## Relationship Extraction
  After every message, call `extract-relationships` with the full message text
  and your current task source string. You do not need to decide whether the
  message contains relationships — the skill handles that internally and exits
  immediately if there is nothing to extract. Always call it; never skip it.
```

The section in the file should look like this after the edit (showing surrounding context):

```
  When an email arrives from someone not yet in contacts, the system auto-creates
  a contact. You can enrich it with contact-set-role if you learn their role.

  ## Relationship Extraction
  After every message, call `extract-relationships` with the full message text
  and your current task source string. You do not need to decide whether the
  message contains relationships — the skill handles that internally and exits
  immediately if there is nothing to extract. Always call it; never skip it.

  ## Audience Awareness
```

- [ ] **Step 2: Verify YAML is valid**

```bash
node -e "import('js-yaml').then(m => { m.default.load(require('fs').readFileSync('agents/coordinator.yaml','utf8')); console.log('valid'); }).catch(e => console.error(e))" 2>/dev/null || npx js-yaml agents/coordinator.yaml > /dev/null && echo "valid YAML"
```

- [ ] **Step 3: Commit**

```bash
git add agents/coordinator.yaml
git commit -m "feat: add relationship extraction instruction to coordinator system prompt"
```

---

### Task 8: Integration test

**Files:**
- Create: `tests/integration/extract-relationships.test.ts`

- [ ] **Step 1: Create the integration test**

Create `tests/integration/extract-relationships.test.ts`:

```typescript
// Integration test: extract-relationships full round-trip.
//
// Uses real Postgres (DATABASE_URL must be set) and a mock Anthropic client
// so no real LLM API calls are made. Tests that:
// 1. The skill persists edges to kg_edges via real SQL
// 2. EntityContextAssembler reads those edges back on the next turn
//
// This verifies the acceptance criterion from issue #128.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { EntityContextAssembler } from '../../src/entity-context/assembler.js';
import { ExtractRelationshipsHandler } from '../../skills/extract-relationships/handler.js';
import type { SkillContext } from '../../src/skills/types.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

function makeCtx(entityMemory: EntityMemory, text: string): SkillContext {
  return {
    input: { text, source: 'integration-test' },
    secret: () => 'test-api-key',
    log: pino({ level: 'silent' }),
    entityMemory,
  } as unknown as SkillContext;
}

function makeMockAnthropicClient(responses: string[]) {
  let callIndex = 0;
  return {
    messages: {
      create: vi.fn().mockImplementation(() => {
        const text = responses[callIndex++] ?? 'no';
        return Promise.resolve({ content: [{ type: 'text', text }] });
      }),
    },
  };
}

describeIf('extract-relationships integration', () => {
  let pool: pg.Pool;
  let entityMemory: EntityMemory;
  let assembler: EntityContextAssembler;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = pino({ level: 'silent' });
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService);
    assembler = new EntityContextAssembler(pool, logger);

    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    await pool.query("DELETE FROM kg_edges WHERE source = 'integration-test'");
    await pool.query("DELETE FROM kg_nodes WHERE source = 'integration-test'");
    await pool.end();
  });

  it('persists a spouse edge to Postgres and surfaces it via entity context', async () => {
    const triple = JSON.stringify([
      {
        subject: 'Xiaopu Fung',
        subjectType: 'person',
        predicate: 'spouse',
        object: 'Joseph Fung',
        objectType: 'person',
        confidence: 0.95,
      },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', triple]);
    const handler = new ExtractRelationshipsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, 'Xiaopu Fung is Joseph\'s wife.');

    const result = await handler.execute(ctx);

    // Edge was created
    expect(result).toMatchObject({ success: true, data: { extracted: 1, confirmed: 0, skipped: false } });

    // Verify edge exists in Postgres directly
    const josephNodes = await entityMemory.findEntities('Joseph Fung');
    expect(josephNodes).toHaveLength(1);
    const josephId = josephNodes[0]!.id;

    const edgeResult = await pool.query(
      `SELECT type FROM kg_edges WHERE (source_node_id = $1 OR target_node_id = $1) AND type = 'spouse'`,
      [josephId],
    );
    expect(edgeResult.rows).toHaveLength(1);
    expect(edgeResult.rows[0]!.type).toBe('spouse');

    // Round-trip: entity context assembler includes the relationship on the next turn
    const assembled = await assembler.assembleMany([josephId], { includeRelationships: true });
    expect(assembled.entities).toHaveLength(1);
    const josephCtx = assembled.entities[0]!;
    // EntityRelationship uses .type and .relatedEntityLabel (see src/entity-context/types.ts)
    const spouseRel = josephCtx.relationships.find(r => r.type === 'spouse');
    expect(spouseRel).toBeDefined();
    expect(spouseRel!.relatedEntityLabel).toBe('Xiaopu Fung');
  });

  it('is idempotent — second call with same triple confirms the edge, not duplicates it', async () => {
    const triple = JSON.stringify([
      {
        subject: 'Idempotency Person A',
        subjectType: 'person',
        predicate: 'reports_to',
        object: 'Idempotency Person B',
        objectType: 'person',
        confidence: 0.8,
      },
    ]);

    const anthropic1 = makeMockAnthropicClient(['yes', triple]);
    const handler1 = new ExtractRelationshipsHandler(anthropic1 as never);
    await handler1.execute(makeCtx(entityMemory, 'Person A reports to Person B.'));

    const anthropic2 = makeMockAnthropicClient(['yes', triple]);
    const handler2 = new ExtractRelationshipsHandler(anthropic2 as never);
    const result2 = await handler2.execute(makeCtx(entityMemory, 'Person A reports to Person B.'));

    expect(result2).toMatchObject({ success: true, data: { extracted: 0, confirmed: 1, skipped: false } });

    const aNodes = await entityMemory.findEntities('Idempotency Person A');
    const edgeResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM kg_edges WHERE (source_node_id = $1 OR target_node_id = $1) AND type = 'reports_to'`,
      [aNodes[0]!.id],
    );
    expect(edgeResult.rows[0]!.cnt).toBe(1);
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
DATABASE_URL=$(grep DATABASE_URL .env | cut -d= -f2-) npx vitest run tests/integration/extract-relationships.test.ts 2>&1 | tail -30
```

Expected: 2 tests pass.

- [ ] **Step 3: Run the full test suite to confirm nothing regressed**

```bash
DATABASE_URL=$(grep DATABASE_URL .env | cut -d= -f2-) npx vitest run 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/extract-relationships.test.ts
git commit -m "test: add integration test for extract-relationships round-trip"
```

---

## Done

All acceptance criteria from issue #128 are now met:

- [x] `EDGE_TYPES` extended with personal, professional, and organisational relationship types (Task 1)
- [x] `extract-relationships` skill: LLM-powered, takes text, returns typed triples, resolves to existing nodes (or creates new ones), calls `EntityMemory.upsertEdge()` (Tasks 4–6)
- [x] Skill is idempotent — duplicate triple confirms existing edge, does not insert (Task 3 + 6)
- [x] Coordinator prompt updated to invoke extraction after every message (Task 7)
- [x] Integration test: full round-trip — message in → edges in DB → entity context includes relationship on next turn (Task 8)
- [x] "Xiaopu Fung is Joseph's wife" creates a `spouse` edge between their two person nodes (Task 6 unit test + Task 8 integration test)
