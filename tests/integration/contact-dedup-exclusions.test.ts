// Integration test — contact_dedup_exclusions against a live Postgres (#1625, ADR-039).
//
// Covers the parts unit tests with the in-memory backend cannot prove:
//   - the ordered-pair CHECK and primary key actually reject bad rows
//   - ON DELETE CASCADE really removes exclusions with their contacts
//   - the Postgres backend's merge re-point + renormalize SQL
//   - migration 084's backfill of legacy KG dedup_exclusion facts
//
// Every fixture row is created by this suite and deleted by id in afterEach, so the
// suite never touches pre-existing contacts, KG nodes, or exclusions.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { ContactService } from '../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { DedupService } from '../../src/contacts/dedup-service.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL_URL = new URL(
  '../../src/db/migrations/084_contact_dedup_exclusions.sql',
  import.meta.url,
);

describeIf('contact_dedup_exclusions (migration 084)', () => {
  let pool: pg.Pool;
  let contactService: ContactService;
  let backfillSql: string;

  // Fixtures created per test, torn down in afterEach. Contacts cascade to their
  // exclusion rows; KG nodes are removed explicitly.
  const createdContactIds: string[] = [];
  const createdKgNodeIds: string[] = [];

  /** Insert a contact directly so we control kg_node_id (including NULL) exactly. */
  async function makeContact(displayName: string, kgNodeId: string | null = null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name, kg_node_id) VALUES ($1, $2) RETURNING id`,
      [displayName, kgNodeId],
    );
    const id = rows[0]!.id;
    createdContactIds.push(id);
    return id;
  }

  async function makeKgNode(type: string, label: string, properties: Record<string, unknown> = {}): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, source) VALUES ($1, $2, $3::jsonb, 'itest-1625') RETURNING id`,
      [type, label, JSON.stringify(properties)],
    );
    const id = rows[0]!.id;
    createdKgNodeIds.push(id);
    return id;
  }

  async function exclusionRows(): Promise<Array<{ a: string; b: string; decidedBy: string }>> {
    if (createdContactIds.length === 0) return [];
    const { rows } = await pool.query<{ contact_a_id: string; contact_b_id: string; decided_by: string }>(
      `SELECT contact_a_id, contact_b_id, decided_by FROM contact_dedup_exclusions
       WHERE contact_a_id = ANY($1::uuid[]) OR contact_b_id = ANY($1::uuid[])
       ORDER BY contact_a_id, contact_b_id`,
      [createdContactIds],
    );
    return rows.map(r => ({ a: r.contact_a_id, b: r.contact_b_id, decidedBy: r.decided_by }));
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // The backfill assertions below re-run migration 084's UNSCOPED INSERT...SELECT over
    // every kg_nodes row, so this suite must never point at a real database. (The insert
    // is idempotent, but it is still a table-wide write.) Everything else in this file is
    // scoped to ids it created.
    await requireCuriaTestDatabase(pool);

    const logger = createSilentLogger();
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    const entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);
    contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
      dedupService: new DedupService(),
    });

    // Fails fast when migration 084 has not been applied.
    await pool.query('SELECT 1 FROM contact_dedup_exclusions LIMIT 0');

    // Isolate the backfill half of the migration so it can be re-run standalone.
    // The CREATE TABLE half would fail on an already-migrated database.
    const full = await readFile(MIGRATION_SQL_URL, 'utf8');
    const begin = full.indexOf('-- >>> BEGIN BACKFILL');
    const end = full.indexOf('-- <<< END BACKFILL');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    backfillSql = full.slice(begin, end);
  });

  afterEach(async () => {
    // Contacts cascade to contact_dedup_exclusions; delete edges before their nodes.
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

  // -- Schema constraints --

  it('rejects a row whose pair is not in ascending order', async () => {
    const a = await makeContact('Ordered A');
    const b = await makeContact('Ordered B');
    const [lo, hi] = a < b ? [a, b] : [b, a];

    await expect(
      pool.query(
        `INSERT INTO contact_dedup_exclusions (contact_a_id, contact_b_id, decided_by) VALUES ($1, $2, 'itest')`,
        [hi, lo],
      ),
    ).rejects.toThrow(/contact_dedup_exclusions_ordered_pair/);
  });

  it('rejects a self-pair', async () => {
    const a = await makeContact('Self Pair');
    await expect(
      pool.query(
        `INSERT INTO contact_dedup_exclusions (contact_a_id, contact_b_id, decided_by) VALUES ($1, $1, 'itest')`,
        [a],
      ),
    ).rejects.toThrow(/contact_dedup_exclusions_ordered_pair/);
  });

  it('rejects blank provenance', async () => {
    // decided_by is the only audit trail a row carries; NOT NULL alone would let '' through.
    const a = await makeContact('Blank A');
    const b = await makeContact('Blank B');
    const [lo, hi] = a < b ? [a, b] : [b, a];
    await expect(
      pool.query(
        `INSERT INTO contact_dedup_exclusions (contact_a_id, contact_b_id, decided_by) VALUES ($1, $2, '')`,
        [lo, hi],
      ),
    ).rejects.toThrow(/decided_by/);
  });

  it('rejects an exclusion naming a contact that does not exist', async () => {
    const a = await makeContact('Real Contact');
    const ghost = '00000000-0000-4000-8000-000000000000';
    const [lo, hi] = a < ghost ? [a, ghost] : [ghost, a];
    await expect(
      pool.query(
        `INSERT INTO contact_dedup_exclusions (contact_a_id, contact_b_id, decided_by) VALUES ($1, $2, 'itest')`,
        [lo, hi],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  // -- Service behaviour on real Postgres --

  it('excludes a pair where BOTH contacts have kg_node_id = NULL (#1623 regression)', async () => {
    const a = await makeContact('Seth Berman');
    const b = await makeContact('Seth Berman');

    const { created } = await contactService.addDedupExclusion(a, b, 'itest-ceo');

    expect(created).toBe(true);
    expect(await contactService.hasDedupExclusion(a, b)).toBe(true);
    expect(await contactService.hasDedupExclusion(b, a)).toBe(true);
    expect(await exclusionRows()).toHaveLength(1);
  });

  it('is idempotent across argument orders', async () => {
    const a = await makeContact('Idem A');
    const b = await makeContact('Idem B');

    expect((await contactService.addDedupExclusion(a, b, 'itest-ceo')).created).toBe(true);
    expect((await contactService.addDedupExclusion(b, a, 'itest-again')).created).toBe(false);

    const rows = await exclusionRows();
    expect(rows).toHaveLength(1);
    // The first write's provenance is preserved — a repeat call does not overwrite it.
    expect(rows[0]!.decidedBy).toBe('itest-ceo');
  });

  it('cascades exclusion rows away when a contact is deleted', async () => {
    const a = await makeContact('Cascade A');
    const b = await makeContact('Cascade B');
    await contactService.addDedupExclusion(a, b, 'itest-ceo');
    expect(await exclusionRows()).toHaveLength(1);

    await pool.query(`DELETE FROM contacts WHERE id = $1`, [b]);

    expect(await exclusionRows()).toHaveLength(0);
  });

  // -- Merge re-pointing --

  it('re-points the loser exclusions onto the survivor, renormalized', async () => {
    const primary = await makeContact('Merge Primary');
    const secondary = await makeContact('Merge Secondary');
    const other = await makeContact('Unrelated Other');

    await contactService.addDedupExclusion(secondary, other, 'itest-ceo');

    await contactService.mergeContacts(primary, secondary, false);

    expect(await contactService.hasDedupExclusion(primary, other)).toBe(true);
    const rows = await exclusionRows();
    expect(rows).toHaveLength(1);
    // Still stored ascending after the swap — the CHECK would have rejected it otherwise.
    expect(rows[0]!.a < rows[0]!.b).toBe(true);
  });

  it('drops the exclusion between the two merged contacts', async () => {
    const primary = await makeContact('Same Person A');
    const secondary = await makeContact('Same Person B');
    await contactService.addDedupExclusion(primary, secondary, 'itest-ceo');

    await contactService.mergeContacts(primary, secondary, false);

    expect(await exclusionRows()).toHaveLength(0);
  });

  it('collapses duplicates when both merged contacts excluded the same counterparty', async () => {
    const primary = await makeContact('Dup Primary');
    const secondary = await makeContact('Dup Secondary');
    const other = await makeContact('Dup Other');

    await contactService.addDedupExclusion(primary, other, 'itest-primary');
    await contactService.addDedupExclusion(secondary, other, 'itest-secondary');
    expect(await exclusionRows()).toHaveLength(2);

    await contactService.mergeContacts(primary, secondary, false);

    const rows = await exclusionRows();
    expect(rows).toHaveLength(1);
    // The survivor's own row wins — the ON CONFLICT DO NOTHING branch.
    expect(rows[0]!.decidedBy).toBe('itest-primary');
  });

  // -- Migration 084 backfill --

  it('backfills a legacy KG dedup_exclusion fact into a normalized row', async () => {
    const holderNode = await makeKgNode('person', 'Backfill Holder');
    const holder = await makeContact('Backfill Holder', holderNode);
    const other = await makeContact('Backfill Other');

    const factNode = await makeKgNode('fact', `dedup_exclusion: ${other}`, {
      attribute: 'dedup_exclusion',
      value: other,
      multi_valued: true,
    });
    await pool.query(
      `INSERT INTO kg_edges (source_node_id, target_node_id, type, source)
       VALUES ($1, $2, 'relates_to', 'itest-1625')`,
      [holderNode, factNode],
    );

    await pool.query(backfillSql);

    const rows = await exclusionRows();
    expect(rows).toHaveLength(1);
    const [lo, hi] = holder < other ? [holder, other] : [other, holder];
    expect(rows[0]).toEqual({ a: lo, b: hi, decidedBy: 'migration-084-backfill' });
  });

  it('collapses the two mirrored facts of one pair into a single row', async () => {
    // The old writeExclusion path wrote one fact on each side of the pair.
    const nodeA = await makeKgNode('person', 'Mirror A');
    const nodeB = await makeKgNode('person', 'Mirror B');
    const a = await makeContact('Mirror A', nodeA);
    const b = await makeContact('Mirror B', nodeB);

    const factOnA = await makeKgNode('fact', `dedup_exclusion: ${b}`, { attribute: 'dedup_exclusion', value: b });
    const factOnB = await makeKgNode('fact', `dedup_exclusion: ${a}`, { attribute: 'dedup_exclusion', value: a });
    await pool.query(
      `INSERT INTO kg_edges (source_node_id, target_node_id, type, source)
       VALUES ($1, $2, 'relates_to', 'itest-1625'), ($3, $4, 'relates_to', 'itest-1625')`,
      [nodeA, factOnA, nodeB, factOnB],
    );

    await pool.query(backfillSql);

    expect(await exclusionRows()).toHaveLength(1);
  });

  it('is safe to re-run — a second pass adds no duplicate rows', async () => {
    const holderNode = await makeKgNode('person', 'Rerun Holder');
    await makeContact('Rerun Holder', holderNode);
    const other = await makeContact('Rerun Other');
    const factNode = await makeKgNode('fact', `dedup_exclusion: ${other}`, { attribute: 'dedup_exclusion', value: other });
    await pool.query(
      `INSERT INTO kg_edges (source_node_id, target_node_id, type, source)
       VALUES ($1, $2, 'relates_to', 'itest-1625')`,
      [holderNode, factNode],
    );

    await pool.query(backfillSql);
    await pool.query(backfillSql);

    expect(await exclusionRows()).toHaveLength(1);
  });

  it('skips a fact whose value names a contact that no longer exists', async () => {
    const holderNode = await makeKgNode('person', 'Dangling Holder');
    await makeContact('Dangling Holder', holderNode);
    const factNode = await makeKgNode('fact', 'dedup_exclusion: gone', {
      attribute: 'dedup_exclusion',
      value: '00000000-0000-4000-8000-000000000000',
    });
    await pool.query(
      `INSERT INTO kg_edges (source_node_id, target_node_id, type, source)
       VALUES ($1, $2, 'relates_to', 'itest-1625')`,
      [holderNode, factNode],
    );

    await pool.query(backfillSql);

    expect(await exclusionRows()).toHaveLength(0);
  });

  it('does not abort on a fact whose value is not a UUID', async () => {
    // A malformed value would blow up the ::uuid cast and take the whole migration
    // (and therefore process startup) down — the regex guard must filter it first.
    const holderNode = await makeKgNode('person', 'Malformed Holder');
    await makeContact('Malformed Holder', holderNode);
    const factNode = await makeKgNode('fact', 'dedup_exclusion: junk', {
      attribute: 'dedup_exclusion',
      value: 'not-a-uuid-at-all',
    });
    await pool.query(
      `INSERT INTO kg_edges (source_node_id, target_node_id, type, source)
       VALUES ($1, $2, 'relates_to', 'itest-1625')`,
      [holderNode, factNode],
    );

    await expect(pool.query(backfillSql)).resolves.toBeDefined();
    expect(await exclusionRows()).toHaveLength(0);
  });
});
