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
      { subject: 'Jane Doe', subjectType: 'person', attribute: 'home_city', value: 'Toronto', confidence: 0.9, decayClass: 'slow_decay' },
    ]);
    const anthropic = makeMockAnthropicClient(['yes', facts]);
    const handler = new ExtractFactsHandler(anthropic as never);
    const ctx = makeCtx(entityMemory, 'Joseph lives in Toronto.');

    const result = await handler.execute(ctx);

    expect(result).toMatchObject({ success: true, data: { stored: 1, skipped: false } });

    // Verify the entity node and fact node exist in Postgres
    const josephNodes = await entityMemory.findEntities('Jane Doe');
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
