// handler.test.ts — unit tests for extract-relationships skill.
//
// Uses an in-memory KG backend (no Postgres) and a mock infraLlm
// injected via the skill context, so no real API calls are made.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import { ExtractRelationshipsHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { InfraLlm, InfraLlmResult } from '../../src/skills/infra-llm.js';

// -- Test helpers --

function makeEntityMemory(): EntityMemory {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return new EntityMemory(store, validator, embeddingService, createSilentLogger());
}

// Creates a mock infraLlm for injection into ctx.
// responses: scripted sequence of text responses — first call goes to classify()
// (classifier gate), second call (if triggered) goes to extract().
function makeMockInfraLlm(responses: string[]): InfraLlm {
  let callIndex = 0;

  return {
    classify: vi.fn().mockImplementation((): Promise<InfraLlmResult> => {
      const text = responses[callIndex++] ?? 'no';
      return Promise.resolve({ ok: true, text });
    }),
    extract: vi.fn().mockImplementation((): Promise<InfraLlmResult> => {
      const text = responses[callIndex++] ?? '[]';
      return Promise.resolve({ ok: true, text });
    }),
  };
}

function makeCtx(entityMemory: EntityMemory, input: Record<string, unknown>, infraLlm: InfraLlm): ToolContext {
  return {
    input,
    secret: () => 'test-api-key',
    log: pino({ level: 'silent' }),
    entityMemory,
    infraLlm,
  } as unknown as ToolContext;
}

// -- Tests --

describe('ExtractRelationshipsHandler', () => {
  it('returns skipped:true when classifier gate fires on unrelated text', async () => {
    const entityMemory = makeEntityMemory();
    const infraLlm = makeMockInfraLlm(['no']);
    const handler = new ExtractRelationshipsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Please schedule a call with the engineering team for Thursday.',
      source: 'test',
    }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { extracted: 0, confirmed: 0, failed: 0, ambiguous: 0, skipped: true } });
    // Classifier was called; extraction was not
    expect(infraLlm.classify).toHaveBeenCalledTimes(1);
    expect(infraLlm.extract).not.toHaveBeenCalled();
  });

  it('extracts a single relationship and persists the edge', async () => {
    const entityMemory = makeEntityMemory();
    const triple = JSON.stringify([
      { subject: 'Ada Lovelace', subjectType: 'person', predicate: 'manages', object: 'Project Orion', objectType: 'project', confidence: 0.9 },
    ]);
    const infraLlm = makeMockInfraLlm(['yes', triple]);
    const handler = new ExtractRelationshipsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'Ada Lovelace is the lead on Project Orion.',
      source: 'test',
    }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { extracted: 1, confirmed: 0, failed: 0, ambiguous: 0, skipped: false } });

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
    const infraLlm1 = makeMockInfraLlm(['yes', triple]);
    const handler1 = new ExtractRelationshipsHandler();
    const ctx1 = makeCtx(entityMemory, { text: 'John Smith is Bob\'s wife.', source: 'test' }, infraLlm1);
    await handler1.execute(ctx1);

    // Second invocation with same text — should confirm, not duplicate
    const infraLlm2 = makeMockInfraLlm(['yes', triple]);
    const handler2 = new ExtractRelationshipsHandler();
    const ctx2 = makeCtx(entityMemory, { text: 'John Smith is Bob\'s wife.', source: 'test' }, infraLlm2);
    const result = await handler2.execute(ctx2);

    expect(result).toEqual({ success: true, data: { extracted: 0, confirmed: 1, failed: 0, ambiguous: 0, skipped: false } });

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
    const infraLlm = makeMockInfraLlm(['yes', triple]);
    const handler = new ExtractRelationshipsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'New Person A is collaborating with New Person B.',
      source: 'test',
    }, infraLlm);

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
    const infraLlm = makeMockInfraLlm(['yes', triple]);
    const handler = new ExtractRelationshipsHandler();
    const ctx = makeCtx(entityMemory, {
      text: 'John Smith is Bob\'s wife.',
      source: 'test',
    }, infraLlm);

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { extracted: 1, confirmed: 0, failed: 0, ambiguous: 0, skipped: false } });

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
    const infraLlm = makeMockInfraLlm(['yes', triple]);
    const handler = new ExtractRelationshipsHandler();
    const ctx = makeCtx(entityMemory, { text: 'Alice knows Bob well.', source: 'test' }, infraLlm);

    await handler.execute(ctx);

    const aliceNodes = await entityMemory.findEntities('Alice');
    expect(aliceNodes).toHaveLength(1);
    const queryResult = await entityMemory.query(aliceNodes[0]!.id);
    expect(queryResult.relationships[0]!.edge.type).toBe('relates_to');
  });

  // -- Ambiguity (#1714 / ADR-040) --
  //
  // ADR-040 lets two contacts sharing a display name each hold their own person node, and
  // findNodesByLabel returns both by design. Before this, resolution took matches[0] — a
  // coin flip that attached the relationship to whichever node came back first. Attaching a
  // relationship to the wrong one of two real people is worse than not recording it.

  describe('ambiguous endpoints', () => {
    /** Two anchored person nodes sharing a label, as migration 085 produces. */
    async function twoNamesakes(entityMemory: EntityMemory, label: string): Promise<string[]> {
      const a = await entityMemory.createAnchoredEntity({
        type: 'person', label, properties: {}, source: 'test',
      });
      const b = await entityMemory.createAnchoredEntity({
        type: 'person', label, properties: {}, source: 'test',
      });
      return [a.id, b.id];
    }

    it('skips and counts a triple whose SUBJECT matches two nodes', async () => {
      const entityMemory = makeEntityMemory();
      const [a, b] = await twoNamesakes(entityMemory, 'Seth Berman');
      const infraLlm = makeMockInfraLlm([
        'yes',
        JSON.stringify([{ subject: 'Seth Berman', predicate: 'works_on', object: 'Project Atlas',
                          subjectType: 'person', objectType: 'project', confidence: 0.9 }]),
      ]);
      const handler = new ExtractRelationshipsHandler();

      const result = await handler.execute(
        makeCtx(entityMemory, { text: 'Seth Berman works on Project Atlas.', source: 'test' }, infraLlm),
      );

      expect(result).toEqual({
        success: true,
        data: { extracted: 0, confirmed: 0, failed: 0, ambiguous: 1, skipped: false },
      });
      // Neither namesake picked up the edge.
      expect(await entityMemory.findEdges(a!)).toHaveLength(0);
      expect(await entityMemory.findEdges(b!)).toHaveLength(0);
    });

    it('skips and counts a triple whose OBJECT matches two nodes', async () => {
      // An edge needs both ends; half a relationship is not a relationship.
      const entityMemory = makeEntityMemory();
      const [a, b] = await twoNamesakes(entityMemory, 'Seth Berman');
      const infraLlm = makeMockInfraLlm([
        'yes',
        JSON.stringify([{ subject: 'Dana Wu', predicate: 'reports_to', object: 'Seth Berman',
                          subjectType: 'person', objectType: 'person', confidence: 0.9 }]),
      ]);
      const handler = new ExtractRelationshipsHandler();

      const result = await handler.execute(
        makeCtx(entityMemory, { text: 'Dana Wu reports to Seth Berman.', source: 'test' }, infraLlm),
      );

      expect(result).toEqual({
        success: true,
        data: { extracted: 0, confirmed: 0, failed: 0, ambiguous: 1, skipped: false },
      });
      expect(await entityMemory.findEdges(a!)).toHaveLength(0);
      expect(await entityMemory.findEdges(b!)).toHaveLength(0);
    });

    it('still resolves when exactly one candidate has the requested type', async () => {
      // Cross-type collisions must keep working: "River" the organization is not "River"
      // the person, so the type is a real tiebreaker rather than a guess.
      const entityMemory = makeEntityMemory();
      await entityMemory.createAnchoredEntity({
        type: 'person', label: 'River', properties: {}, source: 'test',
      });
      await entityMemory.createEntity({
        type: 'organization', label: 'River', properties: {}, source: 'test',
      });
      const infraLlm = makeMockInfraLlm([
        'yes',
        JSON.stringify([{ subject: 'River', predicate: 'works_on', object: 'Project Atlas',
                          subjectType: 'person', objectType: 'project', confidence: 0.9 }]),
      ]);
      const handler = new ExtractRelationshipsHandler();

      const result = await handler.execute(
        makeCtx(entityMemory, { text: 'River works on Project Atlas.', source: 'test' }, infraLlm),
      );

      expect(result).toEqual({
        success: true,
        data: { extracted: 1, confirmed: 0, failed: 0, ambiguous: 0, skipped: false },
      });
    });

    it('does not let one ambiguous triple stop the others in the batch', async () => {
      const entityMemory = makeEntityMemory();
      await twoNamesakes(entityMemory, 'Seth Berman');
      const infraLlm = makeMockInfraLlm([
        'yes',
        JSON.stringify([
          { subject: 'Seth Berman', predicate: 'works_on', object: 'Project Atlas',
            subjectType: 'person', objectType: 'project', confidence: 0.9 },
          { subject: 'Dana Wu', predicate: 'works_on', object: 'Project Borealis',
            subjectType: 'person', objectType: 'project', confidence: 0.9 },
        ]),
      ]);
      const handler = new ExtractRelationshipsHandler();

      const result = await handler.execute(
        makeCtx(entityMemory, { text: 'Two relationships.', source: 'test' }, infraLlm),
      );

      expect(result).toEqual({
        success: true,
        data: { extracted: 1, confirmed: 0, failed: 0, ambiguous: 1, skipped: false },
      });
    });

    it('reports the skip at a level production can see, without the raw label', async () => {
      // prod runs at info, so a debug line would be no signal at all. The label is an
      // extracted entity name and therefore PII (#1706) — ids only.
      const entityMemory = makeEntityMemory();
      const [a, b] = await twoNamesakes(entityMemory, 'Seth Berman');
      const infraLlm = makeMockInfraLlm([
        'yes',
        JSON.stringify([{ subject: 'Seth Berman', predicate: 'works_on', object: 'Project Atlas',
                          subjectType: 'person', objectType: 'project', confidence: 0.9 }]),
      ]);
      const warn = vi.fn();
      const ctx = makeCtx(entityMemory, { text: 'x', source: 'test' }, infraLlm);
      (ctx as unknown as { log: unknown }).log = {
        info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(),
      };

      await new ExtractRelationshipsHandler().execute(ctx);

      const call = warn.mock.calls.find(c => /ambiguous endpoint/.test(String(c[1])));
      expect(call).toBeDefined();
      const payload = call![0] as { subjectCandidateIds?: string[] };
      expect(payload.subjectCandidateIds).toEqual(expect.arrayContaining([a, b]));
      expect(JSON.stringify(payload)).not.toContain('Seth Berman');
    });
  });
});
