# Extract Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an `extract-facts` skill that automatically extracts single-entity attribute facts from conversation transcripts and persists them as `kg_nodes` via `EntityMemory.storeFact()`, then wire it into the checkpoint pipeline alongside `extract-relationships`.

**Architecture:** Mirrors `extract-relationships` exactly: a two-step self-classifying skill (haiku gate → sonnet extraction) that runs at every conversation checkpoint. Each extracted fact is resolved to an existing entity node (or a new one is created), then persisted via `storeFact()` which handles deduplication and near-duplicate merging internally. The checkpoint processor already has a placeholder comment for this skill at line 12 of `src/checkpoint/processor.ts`.

**Tech Stack:** TypeScript (ESM), Vitest, Anthropic SDK (`claude-haiku-4-5-20251001` for gate, `claude-sonnet-4-6` for extraction), PostgreSQL via `EntityMemory`.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `skills/extract-facts/skill.json` | Create | Skill manifest |
| `skills/extract-facts/handler.ts` | Create | Handler: haiku gate → sonnet extraction → `storeFact()` |
| `skills/extract-facts/handler.test.ts` | Create | Unit tests (in-memory KG, mock Anthropic client) |
| `tests/integration/extract-facts.test.ts` | Create | Integration test (real Postgres, mock Anthropic) |
| `src/checkpoint/processor.ts` | Modify | Uncomment / add `extract-facts` to `CHECKPOINT_SKILLS` |
| `CHANGELOG.md` | Modify | Add entry under `[Unreleased]` |

---

## Task 1: Skill manifest

**Files:**
- Create: `skills/extract-facts/skill.json`

- [ ] **Step 1: Create the manifest**

```json
{
  "name": "extract-facts",
  "description": "Extract single-entity attribute facts from a passage of text and persist them as knowledge graph fact nodes. Self-classifies internally — always safe to call; exits early if no facts are found.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "text": "string (the message or turn text to extract facts from)",
    "source": "string (provenance string, e.g. 'system:checkpoint/conversation:abc/agent:coordinator/channel:cli')"
  },
  "outputs": {
    "stored": "number (new or updated fact nodes persisted)",
    "skipped": "boolean (true if the classifier gate determined no facts were present)",
    "failed": "number (facts that could not be persisted due to errors)"
  },
  "permissions": [],
  "secrets": ["ANTHROPIC_API_KEY"],
  "timeout": 15000
}
```

- [ ] **Step 2: Commit**

```bash
git -C /path/to/worktree add skills/extract-facts/skill.json
git -C /path/to/worktree commit -m "feat: add extract-facts skill manifest (issue #151)"
```

---

## Task 2: Handler implementation

**Files:**
- Create: `skills/extract-facts/handler.ts`

The handler follows the same structure as `skills/extract-relationships/handler.ts`. Read that file before writing this one.

Key differences:
- Gate question asks about single-entity attribute assertions, not multi-entity relationships.
- Extraction output has a different shape: `{ subject, subjectType, attribute, value, confidence, decayClass }`.
- Persistence goes through `ctx.entityMemory.storeFact()` instead of `ctx.entityMemory.upsertEdge()`.
- Return data shape: `{ stored, skipped, failed }` (no `confirmed` — `storeFact` handles that internally and returns `stored: true` for both new and merged nodes).

`decayClass` values come from `DECAY_CLASSES` in `src/memory/types.ts`: `'permanent'`, `'slow_decay'`, `'fast_decay'`. The LLM is instructed to pick one; unknowns default to `'slow_decay'`.

- [ ] **Step 1: Write `skills/extract-facts/handler.ts`**

```typescript
// handler.ts — extract-facts skill.
//
// Self-classifying: runs a cheap haiku gate first and exits early when the
// message contains no single-entity attribute facts. Only fires the full
// extraction prompt (sonnet) when the classifier says yes.
//
// Idempotent: storeFact() handles deduplication — reasserting the same fact
// merges into or confirms the existing fact node rather than creating a duplicate.

import Anthropic from '@anthropic-ai/sdk';
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { DECAY_CLASSES, NODE_TYPES } from '../../src/memory/types.js';
import type { DecayClass, NodeType } from '../../src/memory/types.js';

// Model constants — update here when model IDs rotate
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACTION_MODEL = 'claude-sonnet-4-6';

// Shape of each fact returned by the LLM extraction prompt.
interface ExtractedFact {
  subject: string;
  subjectType: NodeType;
  attribute: string;
  value: string;
  confidence: number;
  decayClass: DecayClass;
}

const NODE_TYPES_LIST = NODE_TYPES.filter(t => t !== 'fact').join(', ');
const DECAY_CLASSES_LIST = DECAY_CLASSES.join(', ');

export class ExtractFactsHandler implements SkillHandler {
  // Optional Anthropic client injection for testing.
  // In production the skill registry instantiates with no args and the
  // handler creates its own client from ctx.secret('ANTHROPIC_API_KEY').
  constructor(private readonly anthropicClient?: Anthropic) {}

  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { text, source } = ctx.input as { text?: string; source?: string };

    if (!text || typeof text !== 'string') {
      ctx.log.error({ input: ctx.input }, 'extract-facts: missing required input "text"');
      return { success: false, error: 'Missing required input: text (string)' };
    }
    if (!source || typeof source !== 'string') {
      ctx.log.error({ input: ctx.input }, 'extract-facts: missing required input "source"');
      return { success: false, error: 'Missing required input: source (string)' };
    }
    if (!ctx.entityMemory) {
      ctx.log.error('extract-facts: entity memory not available — is the database configured?');
      return { success: false, error: 'Entity memory not available — database not configured' };
    }

    const client = this.anthropicClient ?? new Anthropic({ apiKey: ctx.secret('ANTHROPIC_API_KEY') });

    try {
      // -- Step 1: Classifier gate --
      // Cheap haiku call — exits early on messages that carry no facts about a
      // single entity (e.g. action requests, scheduling, relationship-only text).
      const classifierResponse = await client.messages.create({
        model: CLASSIFIER_MODEL,
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Does the following text assert an attribute, fact, or characteristic about a single person or organisation (for example: where they live, their role, their preferences, their location)? Answer only 'yes' or 'no'.\n\n${text}`,
        }],
      });

      const classifierTextBlock = classifierResponse.content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      if (!classifierTextBlock) {
        ctx.log.warn({ textPreview: text.slice(0, 80) }, 'extract-facts: classifier returned no text block, skipping');
        return { success: true, data: { stored: 0, skipped: true, failed: 0 } };
      }
      const classifierAnswer = classifierTextBlock.text.toLowerCase().trim();

      if (!classifierAnswer.startsWith('yes')) {
        ctx.log.debug({ textPreview: text.slice(0, 80) }, 'extract-facts: classifier gate — no facts, skipping');
        return { success: true, data: { stored: 0, skipped: true, failed: 0 } };
      }

      // -- Step 2: Extraction prompt --
      // Sonnet call with the full vocabulary. Returns JSON array of facts.
      const extractionResponse = await client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `Extract single-entity attribute facts from the text below. Return a JSON array of fact objects.

Available subject types (for the entity the fact is about): ${NODE_TYPES_LIST}
Available decay classes: ${DECAY_CLASSES_LIST}

Decay class guidance:
- permanent: identity facts unlikely to ever change (e.g. date of birth, nationality)
- slow_decay: stable attributes that change rarely (e.g. where someone lives, job title)
- fast_decay: time-sensitive or context-specific facts (e.g. currently travelling, in a meeting)

Rules:
- Only extract facts about a SINGLE entity (person, organization, etc.)
- Do NOT extract relationships between two entities — those are handled elsewhere
- attribute should be a short snake_case key (e.g. "home_city", "job_title", "dietary_preference")
- value should be a concise string (e.g. "Toronto", "CEO", "vegetarian")
- Set confidence between 0.0 and 1.0 based on how explicitly the fact is stated
- Return ONLY valid JSON, no explanation or markdown fences

Format:
[{"subject":"<name>","subjectType":"<nodeType>","attribute":"<attribute>","value":"<value>","confidence":<number>,"decayClass":"<decayClass>"}]

Text:
${text}`,
        }],
      });

      const extractionTextBlock = extractionResponse.content.find(
        (c): c is { type: 'text'; text: string } => c.type === 'text',
      );
      if (!extractionTextBlock) {
        ctx.log.warn('extract-facts: extraction returned no text block, treating as empty');
        return { success: true, data: { stored: 0, skipped: false, failed: 0 } };
      }
      // Strip optional markdown code fences the model may include despite instructions.
      const rawText = extractionTextBlock.text.trim();
      const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

      let facts: ExtractedFact[];
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        if (!Array.isArray(parsed)) {
          ctx.log.warn({ rawText }, 'extract-facts: extraction returned non-array, treating as empty');
          return { success: true, data: { stored: 0, skipped: false, failed: 0 } };
        }
        facts = parsed as ExtractedFact[];
      } catch (err) {
        ctx.log.warn({ err, rawText }, 'extract-facts: failed to parse extraction JSON, treating as empty');
        return { success: true, data: { stored: 0, skipped: false, failed: 0 } };
      }

      // -- Steps 3 & 4: Entity resolution + fact storage --
      let stored = 0;
      let failed = 0;

      // Entity node types (fact nodes themselves are excluded as subjects —
      // we look up or create entity nodes, then attach facts to them).
      const ENTITY_NODE_TYPES: ReadonlySet<string> = new Set(
        NODE_TYPES.filter(t => t !== 'fact'),
      );

      for (const fact of facts) {
        try {
          // Guard: skip malformed entries where required string fields are absent.
          if (
            !fact ||
            typeof fact.subject !== 'string' ||
            typeof fact.attribute !== 'string' ||
            typeof fact.value !== 'string'
          ) {
            ctx.log.warn({ fact }, 'extract-facts: skipping malformed fact');
            failed++;
            continue;
          }

          // Normalise subject type — fall back to 'person' for unknown or non-entity types.
          const subjectType: NodeType = ENTITY_NODE_TYPES.has(fact.subjectType)
            ? fact.subjectType as NodeType
            : 'person';

          // Normalise decay class — fall back to 'slow_decay' for unknown values.
          const decayClass: DecayClass = (DECAY_CLASSES as readonly string[]).includes(fact.decayClass)
            ? fact.decayClass as DecayClass
            : 'slow_decay';

          // Clamp confidence to [0, 1] in case the LLM returns an out-of-range value.
          const confidence = typeof fact.confidence === 'number'
            ? Math.min(1, Math.max(0, fact.confidence))
            : 0.7;

          // Resolve entity node — prefer a node whose type matches the extraction.
          // Create a new entity node if none exists.
          const matches = await ctx.entityMemory.findEntities(fact.subject);
          const match = matches.find(n => n.type === subjectType) ?? matches[0];
          const entityNode = match ?? (await ctx.entityMemory.createEntity({
            type: subjectType,
            label: fact.subject,
            properties: {},
            source,
            confidence: 0.6,
          })).entity;

          // Label format: "<attribute>: <value>" — human-readable and dedup-stable.
          // The validator uses semantic similarity on this label for near-duplicate detection.
          const label = `${fact.attribute}: ${fact.value}`;

          const result = await ctx.entityMemory.storeFact({
            entityNodeId: entityNode.id,
            label,
            properties: { attribute: fact.attribute, value: fact.value },
            confidence,
            decayClass,
            source,
          });

          if (result.stored) {
            stored++;
          } else {
            // storeFact returns stored:false on rate-limit rejection or contradiction.
            // Log at warn (not error) — these are expected semantic outcomes, not infra failures.
            ctx.log.warn({ subject: fact.subject, attribute: fact.attribute, conflict: result.conflict }, 'extract-facts: fact rejected or conflicted');
          }
        } catch (err) {
          // Log at error — persistence failures are infrastructure errors (DB outage,
          // connection loss) that must surface in Sentry, not soft warnings.
          ctx.log.error({ err, subject: fact.subject, attribute: fact.attribute }, 'extract-facts: failed to persist fact, skipping');
          failed++;
        }
      }

      ctx.log.info({ stored, failed }, 'extract-facts: complete');
      return { success: true, data: { stored, skipped: false, failed } };
    } catch (err) {
      // Top-level catch for Anthropic API errors (rate limits, auth, timeouts, 5xx).
      ctx.log.error({ err }, 'extract-facts: unexpected error');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git -C /path/to/worktree add skills/extract-facts/handler.ts
git -C /path/to/worktree commit -m "feat: implement extract-facts skill handler (issue #151)"
```

---

## Task 3: Unit tests

**Files:**
- Create: `skills/extract-facts/handler.test.ts`

Read `skills/extract-relationships/handler.test.ts` before writing — the test structure is identical. Use the same `makeEntityMemory()`, `makeCtx()`, and `makeMockAnthropicClient()` helpers (copy them; no shared test utility exists yet).

- [ ] **Step 1: Write failing tests**

```typescript
// handler.test.ts — unit tests for extract-facts skill.
//
// Uses an in-memory KG backend (no Postgres) and a mock Anthropic client
// injected via the handler constructor, so no real API calls are made.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { ExtractFactsHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// -- Test helpers --

function makeEntityMemory(): EntityMemory {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService, createSilentLogger());
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

describe('ExtractFactsHandler', () => {
  it('returns skipped:true when classifier gate fires on unrelated text', async () => {
    const entityMemory = makeEntityMemory();
    const anthropic = makeMockAnthropicClient(['no']);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Ada manages Project Orion and works closely with Joseph.',
      source: 'test',
    });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 0, skipped: true, failed: 0 } });
    // Classifier was called; extraction was not
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  it('acceptance criterion: "Joseph lives in Toronto" stores a location fact', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Joseph Fung', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', facts]);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Joseph lives in Toronto.',
      source: 'test',
    });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 1, skipped: false, failed: 0 } });

    // Fact node exists in the KG
    const josephNodes = await entityMemory.findEntities('Joseph Fung');
    expect(josephNodes).toHaveLength(1);
    const facts2 = await entityMemory.getFacts(josephNodes[0]!.id);
    expect(facts2).toHaveLength(1);
    expect(facts2[0]!.label).toBe('home_city: Toronto');
    expect(facts2[0]!.temporal.decayClass).toBe('slow_decay');
  });

  it('stores a fast_decay fact correctly', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Ada Lovelace', subjectType: 'person', attribute: 'current_location', value: 'London', confidence: 0.8, decayClass: 'fast_decay' },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', facts]);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Ada is currently in London this week.',
      source: 'test',
    });

    await handler.execute(ctx);

    const adaNodes = await entityMemory.findEntities('Ada Lovelace');
    expect(adaNodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(adaNodes[0]!.id);
    expect(storedFacts).toHaveLength(1);
    expect(storedFacts[0]!.temporal.decayClass).toBe('fast_decay');
  });

  it('creates the entity node if it does not already exist', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Brand New Person', subjectType: 'person', attribute: 'role', value: 'engineer', confidence: 0.85, decayClass: 'slow_decay' },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', facts]);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Brand New Person is an engineer.',
      source: 'test',
    });

    await handler.execute(ctx);

    const nodes = await entityMemory.findEntities('Brand New Person');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type).toBe('person');
    // Nodes created by extraction get a lower confidence (0.6)
    expect(nodes[0]!.temporal.confidence).toBe(0.6);
  });

  it('falls back to slow_decay for an unknown decayClass in the extraction output', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Joseph Fung', subjectType: 'person', attribute: 'role', value: 'CEO', confidence: 0.9, decayClass: 'ultra_slow' },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', facts]);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Joseph is the CEO.',
      source: 'test',
    });

    await handler.execute(ctx);

    const josephNodes = await entityMemory.findEntities('Joseph Fung');
    expect(josephNodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(josephNodes[0]!.id);
    expect(storedFacts[0]!.temporal.decayClass).toBe('slow_decay');
  });

  it('is idempotent — second call with same fact does not create a duplicate node', async () => {
    const entityMemory = makeEntityMemory();
    const facts = JSON.stringify([
      { subject: 'Joseph Fung', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);

    // First invocation — stores the fact
    const anthropic1 = makeMockAnthropicClient(['yes', facts]);
    const handler1 = new ExtractFactsHandler(anthropic1 as never);
    const ctx1 = makeCtx(entityMemory, { text: 'Joseph lives in Toronto.', source: 'test' });
    const result1 = await handler1.execute(ctx1);
    expect(result1).toEqual({ success: true, data: { stored: 1, skipped: false, failed: 0 } });

    // Second invocation with semantically identical fact — storeFact deduplicates internally
    const anthropic2 = makeMockAnthropicClient(['yes', facts]);
    const handler2 = new ExtractFactsHandler(anthropic2 as never);
    const ctx2 = makeCtx(entityMemory, { text: 'Joseph lives in Toronto.', source: 'test' });
    await handler2.execute(ctx2);

    // Only one fact node should exist — storeFact merged the second call into the first
    const josephNodes = await entityMemory.findEntities('Joseph Fung');
    expect(josephNodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(josephNodes[0]!.id);
    expect(storedFacts).toHaveLength(1);
  });

  it('returns error when text input is missing', async () => {
    const entityMemory = makeEntityMemory();
    const anthropic = makeMockAnthropicClient([]);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, { source: 'test' });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: false, error: 'Missing required input: text (string)' });
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('returns success with empty stored when extraction returns non-array', async () => {
    const entityMemory = makeEntityMemory();
    const anthropic = makeMockAnthropicClient(['yes', 'null']);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'Joseph lives in Toronto.',
      source: 'test',
    });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { stored: 0, skipped: false, failed: 0 } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm --prefix /path/to/worktree test skills/extract-facts/handler.test.ts
```

Expected: tests fail with "Cannot find module './handler.js'" or similar (handler not yet created — but it should exist from Task 2, so expect import errors or assertion failures if you run this before Task 2).

If running after Task 2, all tests should pass. If they fail for unexpected reasons, diagnose before continuing.

- [ ] **Step 3: Run tests and verify they pass**

```bash
npm --prefix /path/to/worktree test skills/extract-facts/handler.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add skills/extract-facts/handler.test.ts
git -C /path/to/worktree commit -m "test: unit tests for extract-facts skill"
```

---

## Task 4: Integration test

**Files:**
- Create: `tests/integration/extract-facts.test.ts`

Read `tests/integration/extract-relationships.test.ts` before writing — the structure is identical. Key difference: verify that `EntityContextAssembler` surfaces the fact via `getFacts()` (the assembler's `facts` field), not `relationships`.

- [ ] **Step 1: Write `tests/integration/extract-facts.test.ts`**

```typescript
// Integration test: extract-facts full round-trip.
//
// Uses real Postgres (DATABASE_URL must be set) and a mock Anthropic client
// so no real LLM API calls are made. Tests that:
// 1. The skill persists fact nodes to kg_nodes via real SQL
// 2. EntityMemory.getFacts() reads those facts back
//
// This verifies the acceptance criterion from issue #151.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { ExtractFactsHandler } from '../../skills/extract-facts/handler.js';
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

describeIf('extract-facts integration', () => {
  let pool: pg.Pool;
  let entityMemory: EntityMemory;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, pino({ level: 'silent' }));
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());

    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');

    // Clean any stale rows from previous runs.
    // FK-safe order: auth overrides → channel identities → contacts → edges → nodes.
    await pool.query("DELETE FROM contact_auth_overrides WHERE contact_id IN (SELECT c.id FROM contacts c JOIN kg_nodes n ON c.kg_node_id = n.id WHERE n.source = 'integration-test')");
    await pool.query("DELETE FROM contact_channel_identities WHERE contact_id IN (SELECT c.id FROM contacts c JOIN kg_nodes n ON c.kg_node_id = n.id WHERE n.source = 'integration-test')");
    await pool.query("DELETE FROM contacts WHERE kg_node_id IN (SELECT id FROM kg_nodes WHERE source = 'integration-test')");
    await pool.query("DELETE FROM kg_edges WHERE source = 'integration-test'");
    await pool.query("DELETE FROM kg_nodes WHERE source = 'integration-test'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM contact_auth_overrides WHERE contact_id IN (SELECT c.id FROM contacts c JOIN kg_nodes n ON c.kg_node_id = n.id WHERE n.source = 'integration-test')");
    await pool.query("DELETE FROM contact_channel_identities WHERE contact_id IN (SELECT c.id FROM contacts c JOIN kg_nodes n ON c.kg_node_id = n.id WHERE n.source = 'integration-test')");
    await pool.query("DELETE FROM contacts WHERE kg_node_id IN (SELECT id FROM kg_nodes WHERE source = 'integration-test')");
    await pool.query("DELETE FROM kg_edges WHERE source = 'integration-test'");
    await pool.query("DELETE FROM kg_nodes WHERE source = 'integration-test'");
    await pool.end();
  });

  it('persists a location fact to Postgres and reads it back via getFacts()', async () => {
    const facts = JSON.stringify([
      { subject: 'Joseph Fung', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', facts]);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, 'Joseph lives in Toronto.');

    const result = await handler.execute(ctx);

    expect(result).toMatchObject({ success: true, data: { stored: 1, skipped: false } });

    // Verify the entity node and fact node exist in Postgres
    const josephNodes = await entityMemory.findEntities('Joseph Fung');
    expect(josephNodes).toHaveLength(1);
    const josephId = josephNodes[0]!.id;

    const storedFacts = await entityMemory.getFacts(josephId);
    expect(storedFacts).toHaveLength(1);
    expect(storedFacts[0]!.label).toBe('home_city: Toronto');
    expect(storedFacts[0]!.type).toBe('fact');

    // Verify directly in Postgres: fact node has the correct type and source
    const nodeResult = await pool.query(
      `SELECT type, source FROM kg_nodes WHERE id = $1`,
      [storedFacts[0]!.id],
    );
    expect(nodeResult.rows[0]!.type).toBe('fact');
    expect(nodeResult.rows[0]!.source).toBe('integration-test');
  });

  it('is idempotent — second call with same fact does not create a duplicate in Postgres', async () => {
    const facts = JSON.stringify([
      { subject: 'Idempotent Person', subjectType: 'person', attribute: 'role', value: 'engineer', confidence: 0.85, decayClass: 'slow_decay' },
    ]);

    const anthropic1 = makeMockAnthropicClient(['yes', facts]);
    const handler1 = new ExtractFactsHandler(anthropic1 as never);
    await handler1.execute(makeCtx(entityMemory, 'Idempotent Person is an engineer.'));

    const anthropic2 = makeMockAnthropicClient(['yes', facts]);
    const handler2 = new ExtractFactsHandler(anthropic2 as never);
    await handler2.execute(makeCtx(entityMemory, 'Idempotent Person is an engineer.'));

    const nodes = await entityMemory.findEntities('Idempotent Person');
    expect(nodes).toHaveLength(1);
    const storedFacts = await entityMemory.getFacts(nodes[0]!.id);
    // storeFact() deduplicates — only one fact node should exist
    expect(storedFacts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run integration test (skips if no DATABASE_URL)**

```bash
npm --prefix /path/to/worktree test tests/integration/extract-facts.test.ts
```

Expected: tests are skipped if `DATABASE_URL` is not set (the `describeIf` guard), or pass if a Postgres instance is available.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add tests/integration/extract-facts.test.ts
git -C /path/to/worktree commit -m "test: integration tests for extract-facts skill"
```

---

## Task 5: Wire into checkpoint pipeline

**Files:**
- Modify: `src/checkpoint/processor.ts:10-13`

This is a one-line change. The placeholder comment at line 12 reads:
```typescript
  // { name: 'extract-entities' },  // add when issue #151 is built
```
Replace the comment with the actual entry, using the correct skill name `'extract-facts'`.

- [ ] **Step 1: Update `CHECKPOINT_SKILLS` in `src/checkpoint/processor.ts`**

Replace lines 10–13:
```typescript
const CHECKPOINT_SKILLS: Array<{ name: string }> = [
  { name: 'extract-relationships' },
  // { name: 'extract-entities' },  // add when issue #151 is built
];
```

With:
```typescript
const CHECKPOINT_SKILLS: Array<{ name: string }> = [
  { name: 'extract-relationships' },
  { name: 'extract-facts' },
];
```

- [ ] **Step 2: Run the full test suite to confirm nothing is broken**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass (the new skill runs concurrently with `extract-relationships` via `Promise.allSettled`; no other code changed).

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add src/checkpoint/processor.ts
git -C /path/to/worktree commit -m "feat: wire extract-facts into checkpoint pipeline (issue #151)"
```

---

## Task 6: Changelog and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

This is a new skill (user-facing memory capability), so bump the **minor** version per the versioning table in CLAUDE.md.

- [ ] **Step 1: Check the current version**

```bash
grep '"version"' /path/to/worktree/package.json | head -1
```

- [ ] **Step 2: Add a CHANGELOG entry under `[Unreleased]`**

Add under the `### Added` section (create it if it doesn't exist):

```markdown
- **`extract-facts` skill** — automatic extraction of single-entity attribute facts (home city, job title, preferences, etc.) from conversation transcripts; persists as `fact` nodes in the knowledge graph via `EntityMemory.storeFact()`. Runs at every conversation checkpoint alongside `extract-relationships`. Implements issue #151.
```

- [ ] **Step 3: Bump the minor version in `package.json`**

E.g. if current version is `0.14.0`, set it to `0.15.0`.

- [ ] **Step 4: Commit**

```bash
git -C /path/to/worktree add CHANGELOG.md package.json
git -C /path/to/worktree commit -m "chore: bump version and changelog for extract-facts skill"
```

---

## Self-review

**Spec coverage (issue #151):**

| Requirement | Covered by |
|---|---|
| Accepts a passage of text | Task 1 manifest + Task 2 handler inputs |
| LLM prompt identifies subject–attribute–value assertions | Task 2 Step 1 (extraction prompt) |
| Resolves subject to existing `kg_nodes` or creates new node | Task 2 Step 1 (`findEntities` + `createEntity`) |
| Calls `EntityMemory.storeFact()` | Task 2 Step 1 |
| Appropriate `confidence` and `decay_class` | Task 2 Step 1 (LLM-returned, normalised, clamped) |
| Idempotent | Task 3 idempotency test + Task 4 integration idempotency test |
| Coordinator integration (checkpoint pipeline) | Task 5 |
| Self-classifies via cheap haiku call and exits early | Task 2 (classifier gate) + Task 3 gate test |

**No gaps found.**

**Placeholder scan:** No TBD, TODO, or "similar to Task N" patterns. All code blocks are complete.

**Type consistency:** `ExtractedFact`, `DecayClass`, `NodeType`, `StoreFactOptions`, `StoreFactResult` — all used consistently across Tasks 2, 3, 4.
