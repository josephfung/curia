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

    // Clean any stale rows from previous runs that crashed before teardown.
    // Without this, leftover 'integration-test' rows cause flaky toHaveLength(1) failures.
    await pool.query("DELETE FROM kg_edges WHERE source = 'integration-test'");
    await pool.query("DELETE FROM kg_nodes WHERE source = 'integration-test'");
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
    expect(aNodes).toHaveLength(1);
    const edgeResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM kg_edges WHERE (source_node_id = $1 OR target_node_id = $1) AND type = 'reports_to'`,
      [aNodes[0]!.id],
    );
    expect(edgeResult.rows[0]!.cnt).toBe(1);
  });
});
