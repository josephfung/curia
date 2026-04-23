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
import { createSilentLogger } from '../../src/logger.js';
import { ExtractRelationshipsHandler } from './handler.js';
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

    expect(result).toEqual({ success: true, data: { extracted: 1, confirmed: 0, failed: 0, skipped: false } });

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
      { subject: 'Jane Doe', subjectType: 'person', predicate: 'spouse', object: 'John Smith', objectType: 'person', confidence: 0.95 },
    ]);

    // First invocation — creates the edge
    const anthropic1 = makeMockAnthropicClient(['yes', triple]);
    const handler1 = new ExtractRelationshipsHandler(anthropic1 as never);
    const ctx1 = makeCtx(entityMemory, { text: 'John Smith is Bob\'s wife.', source: 'test' });
    await handler1.execute(ctx1);

    // Second invocation with same text — should confirm, not duplicate
    const anthropic2 = makeMockAnthropicClient(['yes', triple]);
    const handler2 = new ExtractRelationshipsHandler(anthropic2 as never);
    const ctx2 = makeCtx(entityMemory, { text: 'John Smith is Bob\'s wife.', source: 'test' });
    const result = await handler2.execute(ctx2);

    expect(result).toEqual({ success: true, data: { extracted: 0, confirmed: 1, failed: 0, skipped: false } });

    // Exactly two person nodes, one edge — no duplicate
    const josephNodes = await entityMemory.findEntities('Jane Doe');
    const xiaopuNodes = await entityMemory.findEntities('John Smith');
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

  it('acceptance criterion: "John Smith is Bob\'s wife" creates a spouse edge', async () => {
    const entityMemory = makeEntityMemory();
    const triple = JSON.stringify([
      { subject: 'John Smith', subjectType: 'person', predicate: 'spouse', object: 'Jane Doe', objectType: 'person', confidence: 0.95 },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', triple]);
    const handler = new ExtractRelationshipsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, {
      text: 'John Smith is Bob\'s wife.',
      source: 'test',
    });

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { extracted: 1, confirmed: 0, failed: 0, skipped: false } });

    const xiaopuNodes = await entityMemory.findEntities('John Smith');
    const josephNodes = await entityMemory.findEntities('Jane Doe');
    expect(xiaopuNodes).toHaveLength(1);
    expect(josephNodes).toHaveLength(1);

    const queryResult = await entityMemory.query(xiaopuNodes[0]!.id);
    const spouseRel = queryResult.relationships.find(r => r.edge.type === 'spouse');
    expect(spouseRel).toBeDefined();
    expect(spouseRel!.node.label).toBe('Jane Doe');
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
    expect(aliceNodes).toHaveLength(1);
    const queryResult = await entityMemory.query(aliceNodes[0]!.id);
    expect(queryResult.relationships[0]!.edge.type).toBe('relates_to');
  });
});
