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
    const storedFacts = await entityMemory.getFacts(josephNodes[0]!.id);
    expect(storedFacts).toHaveLength(1);
    expect(storedFacts[0]!.label).toBe('home_city: Toronto');
    expect(storedFacts[0]!.temporal.decayClass).toBe('slow_decay');
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
