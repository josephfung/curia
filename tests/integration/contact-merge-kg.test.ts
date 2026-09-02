// Integration test — ContactService.mergeContacts folds KG memory (#1711).
//
// mergeEntities hard-deletes the secondary node. contacts.kg_node_id is a NO ACTION
// foreign key, so that delete used to raise 23503 while the secondary contact still
// pointed at the node. The failure was swallowed as "KG node merge failed (non-fatal)",
// and the secondary's facts, aliases and edges never reached the survivor.
//
// In-memory tests cannot catch this: they have no FK. This suite uses real Postgres.
//
// Every fixture row is created by this suite and deleted by id in afterEach.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createSilentLogger } from '../../src/logger.js';
import type { Logger } from '../../src/logger.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

function mockLogger(): Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const error = vi.fn();
  const logger = {
    info: vi.fn(),
    warn,
    error,
    debug: vi.fn(),
    child() { return this; },
  };
  return logger as unknown as Logger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

describeIf('mergeContacts KG memory (#1711)', () => {
  let pool: pg.Pool;
  let entityMemory: EntityMemory;

  const createdContactIds: string[] = [];
  const createdKgNodeIds: string[] = [];

  function trackContact(id: string, kgNodeId?: string | null): void {
    createdContactIds.push(id);
    if (kgNodeId) createdKgNodeIds.push(kgNodeId);
  }

  function trackNode(id: string | null | undefined): void {
    if (id) createdKgNodeIds.push(id);
  }

  async function makeNodelessContact(displayName: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name, kg_node_id) VALUES ($1, NULL) RETURNING id`,
      [displayName],
    );
    const id = rows[0]!.id;
    createdContactIds.push(id);
    return id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = createSilentLogger();
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterEach(async () => {
    if (createdContactIds.length > 0) {
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [createdContactIds]);
      createdContactIds.length = 0;
    }
    if (createdKgNodeIds.length > 0) {
      await pool.query(
        `DELETE FROM kg_edges WHERE source_node_id = ANY($1::uuid[]) OR target_node_id = ANY($1::uuid[])`,
        [createdKgNodeIds],
      );
      await pool.query(`DELETE FROM kg_nodes WHERE id = ANY($1::uuid[])`, [createdKgNodeIds]);
      createdKgNodeIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('folds the secondary\'s facts, aliases and edges into the survivor when both have a node', async () => {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const logger = mockLogger();
    const contactService = ContactService.createWithPostgres(pool, entityMemory, logger);

    const primary = await contactService.createContact({
      displayName: `KG Merge Primary ${runId}`,
      source: 'ceo_stated',
      tier: 'known',
    });
    trackContact(primary.id, primary.kgNodeId);
    const secondary = await contactService.createContact({
      displayName: `KG Merge Secondary ${runId}`,
      source: 'email_participant',
      tier: 'unknown',
    });
    trackContact(secondary.id, secondary.kgNodeId);

    expect(primary.kgNodeId).toBeTruthy();
    expect(secondary.kgNodeId).toBeTruthy();
    expect(primary.kgNodeId).not.toBe(secondary.kgNodeId);

    await entityMemory.storeFact({
      entityNodeId: primary.kgNodeId!,
      label: `Prefers morning meetings ${runId}`,
      source: 'itest-1711',
    });
    await entityMemory.storeFact({
      entityNodeId: secondary.kgNodeId!,
      label: `Allergic to shellfish ${runId}`,
      source: 'itest-1711',
    });
    for (const fact of await entityMemory.getFacts(primary.kgNodeId!)) trackNode(fact.id);
    for (const fact of await entityMemory.getFacts(secondary.kgNodeId!)) trackNode(fact.id);

    await entityMemory.addAlias(secondary.kgNodeId!, `j. merge ${runId}`);

    const { entity: org } = await entityMemory.createEntity({
      type: 'organization',
      label: `KG Merge Org ${runId}`,
      properties: {},
      source: 'itest-1711',
    });
    trackNode(org.id);
    await entityMemory.upsertEdge(secondary.kgNodeId!, org.id, 'member_of', {}, 'itest-1711', 0.8);

    await contactService.mergeContacts(primary.id, secondary.id, false);

    expect(logger.warn.mock.calls.some(([, msg]) => String(msg).includes('KG node merge failed'))).toBe(false);

    expect(await contactService.getContact(secondary.id)).toBeUndefined();
    const survivor = await contactService.getContact(primary.id);
    expect(survivor?.kgNodeId).toBe(primary.kgNodeId);

    const survivorNode = await entityMemory.getEntity(primary.kgNodeId!);
    expect(survivorNode).toBeDefined();
    expect(survivorNode!.aliases).toContain(`j. merge ${runId}`);

    const factLabels = (await entityMemory.getFacts(primary.kgNodeId!)).map(f => f.label);
    expect(factLabels).toContain(`Prefers morning meetings ${runId}`);
    expect(factLabels).toContain(`Allergic to shellfish ${runId}`);
    for (const fact of await entityMemory.getFacts(primary.kgNodeId!)) trackNode(fact.id);

    const edges = await entityMemory.findEdges(primary.kgNodeId!);
    expect(edges.some(e => e.node.id === org.id && e.edge.type === 'member_of')).toBe(true);

    expect(await entityMemory.getEntity(secondary.kgNodeId!)).toBeUndefined();
  });

  it('merges successfully when only the primary has a KG node', async () => {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const contactService = ContactService.createWithPostgres(pool, entityMemory, createSilentLogger());

    const primary = await contactService.createContact({
      displayName: `KG One-Side Primary ${runId}`,
      source: 'ceo_stated',
    });
    trackContact(primary.id, primary.kgNodeId);
    expect(primary.kgNodeId).toBeTruthy();

    const secondaryId = await makeNodelessContact(`KG One-Side Secondary ${runId}`);

    await contactService.mergeContacts(primary.id, secondaryId, false);

    expect(await contactService.getContact(secondaryId)).toBeUndefined();
    expect((await contactService.getContact(primary.id))?.kgNodeId).toBe(primary.kgNodeId);
    expect(await entityMemory.getEntity(primary.kgNodeId!)).toBeDefined();
  });

  it('merges successfully when only the secondary has a KG node', async () => {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const contactService = ContactService.createWithPostgres(pool, entityMemory, createSilentLogger());

    const primaryId = await makeNodelessContact(`KG Secondary-Only Primary ${runId}`);
    const secondary = await contactService.createContact({
      displayName: `KG Secondary-Only Secondary ${runId}`,
      source: 'email_participant',
    });
    trackContact(secondary.id, secondary.kgNodeId);
    expect(secondary.kgNodeId).toBeTruthy();

    await contactService.mergeContacts(primaryId, secondary.id, false);

    expect(await contactService.getContact(secondary.id)).toBeUndefined();
    // No fold is possible without a survivor node; the secondary's anchored node is archived.
    expect(await entityMemory.getEntity(secondary.kgNodeId!)).toBeUndefined();
  });

  it('merges successfully when neither contact has a KG node', async () => {
    const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const contactService = ContactService.createWithPostgres(pool, entityMemory, createSilentLogger());

    const primaryId = await makeNodelessContact(`KG Neither Primary ${runId}`);
    const secondaryId = await makeNodelessContact(`KG Neither Secondary ${runId}`);

    await contactService.mergeContacts(primaryId, secondaryId, false);

    expect(await contactService.getContact(secondaryId)).toBeUndefined();
    expect(await contactService.getContact(primaryId)).toBeDefined();
  });
});
