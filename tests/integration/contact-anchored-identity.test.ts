// Migration 085 / ADR-040 — the halves that only a real Postgres can prove.
//
// The unit suite (tests/unit/contacts/contact-anchored-identity.test.ts) covers the
// service behaviour against the in-memory backend. What is checked here is the part the
// in-memory backend can only imitate: that the partial indexes really carry the predicates
// ADR-040 specifies, that ON CONFLICT still infers them, and that DreamEngine's SQL
// actually leaves anchored nodes alone.
//
// Column-drop / index-swap migrations are a repeat offender for passing locally and
// failing in CI (see the note in CLAUDE.md), which is exactly why the index assertions
// read pg_indexes rather than inferring the shape from behaviour.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requireCuriaTestDatabase } from './require-test-db.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { DreamEngine } from '../../src/memory/dream-engine.js';
import { createSilentLogger } from '../../src/logger.js';
import type { EventBus } from '../../src/bus/bus.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

function makeBus(): EventBus {
  return { publish: async () => {}, subscribe: () => {} } as unknown as EventBus;
}

const decayConfig = {
  intervalMs: 86400000,
  archiveThreshold: 0.05,
  halfLifeDays: { permanent: null as null, slow_decay: 180, fast_decay: 21 },
  edgeCountPercentile: 0.95,
  edgeCountFloor: 5,
  warnHoldBackDays: 30,
};

describeIf('contact-anchored KG node identity (ADR-040, migration 085)', () => {
  let pool: pg.Pool;
  let store: KnowledgeGraphStore;

  // Track what each test creates so cleanup touches only those rows, leaving any
  // unrelated data in the shared test database intact.
  const nodeIds: string[] = [];
  const contactIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // The backfill suite below re-runs migration 085's own arms, which are scoped only by
    // "kg_node_id IS NULL" and so are table-wide. Refuse to run anywhere but curia_test.
    await requireCuriaTestDatabase(pool);
    store = KnowledgeGraphStore.createWithPostgres(pool, EmbeddingService.createForTesting(), createSilentLogger());
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterEach(async () => {
    if (contactIds.length > 0) {
      await pool.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [contactIds]);
      contactIds.length = 0;
    }
    if (nodeIds.length > 0) {
      await pool.query('DELETE FROM kg_nodes WHERE id = ANY($1::uuid[])', [nodeIds]);
      nodeIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  /**
   * Anything that can run a query: the pool, or a transaction client. The backfill suite
   * passes a client so its table-wide statements can be rolled back.
   */
  type Queryable = Pick<pg.Pool, 'query'>;

  /** Insert a node directly so the test controls identity_source and confidence exactly.
   *  Rows created on a transaction client are not tracked for cleanup — the rollback is
   *  the cleanup, and recording them would make afterEach chase ids that never committed. */
  async function insertNode(opts: {
    label: string;
    type?: string;
    identitySource?: 'label' | 'contact';
    confidence?: number;
    decayClass?: string;
    properties?: Record<string, unknown>;
  }, tx: Queryable = pool): Promise<string> {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO kg_nodes (type, label, properties, source, confidence, decay_class, sensitivity, identity_source,
                             created_at, last_confirmed_at, last_decayed_at)
       VALUES ($1, $2, $3, 'test', $4, $5, 'internal', $6, now() - INTERVAL '400 days', now() - INTERVAL '400 days', now() - INTERVAL '400 days')
       RETURNING id`,
      [
        opts.type ?? 'person',
        opts.label,
        JSON.stringify(opts.properties ?? {}),
        opts.confidence ?? 0.5,
        opts.decayClass ?? 'slow_decay',
        opts.identitySource ?? 'label',
      ],
    );
    const id = rows[0]!.id;
    if (tx === pool) nodeIds.push(id);
    return id;
  }

  async function insertContact(opts: {
    displayName: string;
    kgNodeId?: string | null;
    kind?: string;
    primaryEmail?: string | null;
  }, tx: Queryable = pool): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO contacts (id, kg_node_id, display_name, tier, kind, primary_email, created_at, updated_at)
       VALUES ($1, $2, $3, 'known', $4, $5, now(), now())`,
      [id, opts.kgNodeId ?? null, opts.displayName, opts.kind ?? 'person', opts.primaryEmail ?? null],
    );
    if (tx === pool) contactIds.push(id);
    return id;
  }

  describe('schema', () => {
    it('adds identity_source defaulting to label, constrained to the two tiers', async () => {
      const { rows } = await pool.query<{ column_default: string | null; is_nullable: string }>(
        `SELECT column_default, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'kg_nodes' AND column_name = 'identity_source'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.is_nullable).toBe('NO');
      expect(rows[0]!.column_default).toContain('label');

      await expect(
        pool.query(
          `INSERT INTO kg_nodes (type, label, properties, source, identity_source)
           VALUES ('person', $1, '{}', 'test', 'nonsense')`,
          [`bad-tier-${randomUUID()}`],
        ),
      ).rejects.toThrow();
    });

    it('narrows idx_kg_nodes_unique to the label tier', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_kg_nodes_unique'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toContain("identity_source = 'label'");
    });

    it('exempts organization contacts from idx_contacts_kg_node_unique', async () => {
      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_contacts_kg_node_unique'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toContain("kind <> 'organization'");
    });
  });

  describe('label uniqueness', () => {
    it('still rejects a second label-tier node with the same (label, type)', async () => {
      const label = `Dupe Person ${randomUUID()}`;
      await insertNode({ label });

      await expect(insertNode({ label })).rejects.toThrow(/idx_kg_nodes_unique|unique/i);
    });

    it('accepts any number of anchored nodes sharing a label', async () => {
      const label = `Seth Berman ${randomUUID()}`;
      const a = await insertNode({ label, identitySource: 'contact' });
      const b = await insertNode({ label, identitySource: 'contact' });
      const c = await insertNode({ label, identitySource: 'contact' });

      expect(new Set([a, b, c]).size).toBe(3);
    });

    it('accepts an anchored node alongside a label-tier node of the same name', async () => {
      const label = `Seth Berman ${randomUUID()}`;
      await insertNode({ label });
      await expect(insertNode({ label, identitySource: 'contact' })).resolves.toBeTruthy();
    });
  });

  describe('upsertNode (ADR-040 invariant 1)', () => {
    it('inserts alongside an anchored node rather than merging onto it', async () => {
      // The seam the two tiers would leak through: a name-only write landing on
      // somebody's contact identity. ON CONFLICT must not see the anchored row at all.
      const label = `Seth Berman ${randomUUID()}`;
      const anchored = await insertNode({ label, identitySource: 'contact' });

      const { node, created } = await store.upsertNode({
        type: 'person', label, properties: {}, source: 'test', confidence: 0.7,
      });
      nodeIds.push(node.id);

      expect(created).toBe(true);
      expect(node.id).not.toBe(anchored);
      expect(node.identitySource).toBe('label');
    });

    it('still deduplicates label-tier nodes — ON CONFLICT infers the narrowed index', async () => {
      // If the predicate ever drifts from the index, Postgres raises 42P10 here rather
      // than silently inserting, so this also guards the inference itself.
      const label = `Dana Wu ${randomUUID()}`;
      const first = await insertNode({ label, confidence: 0.4 });

      const { node, created } = await store.upsertNode({
        type: 'person', label, properties: {}, source: 'test', confidence: 0.9,
      });

      expect(created).toBe(false);
      expect(node.id).toBe(first);
      expect(node.temporal.confidence).toBeCloseTo(0.9, 5);
    });
  });

  describe('contact links', () => {
    it('still allows at most one non-organization contact per node', async () => {
      const nodeId = await insertNode({ label: `Solo ${randomUUID()}`, identitySource: 'contact' });
      await insertContact({ displayName: 'Solo A', kgNodeId: nodeId });

      await expect(insertContact({ displayName: 'Solo B', kgNodeId: nodeId }))
        .rejects.toThrow(/idx_contacts_kg_node_unique|unique/i);
    });

    it('lets several organization contacts share one organization node', async () => {
      const nodeId = await insertNode({
        label: `Acme ${randomUUID()}`, type: 'organization', properties: { domain: 'acme.test' },
      });
      await insertContact({ displayName: 'Acme info', kind: 'organization', kgNodeId: nodeId });

      await expect(
        insertContact({ displayName: 'Acme support', kind: 'organization', kgNodeId: nodeId }),
      ).resolves.toBeTruthy();
    });
  });

  describe('anchorNode', () => {
    it('promotes a label-tier node exactly once', async () => {
      const nodeId = await insertNode({ label: `Dana Wu ${randomUUID()}` });

      expect(await store.anchorNode(nodeId)).toBe(true);
      expect(await store.anchorNode(nodeId)).toBe(false);

      const { rows } = await pool.query<{ identity_source: string }>(
        'SELECT identity_source FROM kg_nodes WHERE id = $1', [nodeId],
      );
      expect(rows[0]!.identity_source).toBe('contact');
    });

    it('refuses an archived node', async () => {
      const nodeId = await insertNode({ label: `Gone ${randomUUID()}` });
      await pool.query('UPDATE kg_nodes SET archived_at = now() WHERE id = $1', [nodeId]);

      expect(await store.anchorNode(nodeId)).toBe(false);
    });

    it('clears a pending decay warning on adoption', async () => {
      // Adopting a node is a promise to keep it, so the "confirm this or lose it" prompt is
      // void. Without this the node would sit warned forever, since Pass 2a now skips it.
      const nodeId = await insertNode({ label: `Warned ${randomUUID()}` });
      await pool.query(
        `UPDATE kg_nodes SET warned_at = now(), warn_reason = 'high_sensitivity' WHERE id = $1`,
        [nodeId],
      );

      expect(await store.anchorNode(nodeId)).toBe(true);

      const { rows } = await pool.query<{ warned_at: Date | null; warn_reason: string | null }>(
        'SELECT warned_at, warn_reason FROM kg_nodes WHERE id = $1', [nodeId],
      );
      expect(rows[0]!.warned_at).toBeNull();
      expect(rows[0]!.warn_reason).toBeNull();
    });
  });

  describe('migration 085 backfill', () => {
    // Re-runs the migration's own two arms rather than a paraphrase of them, so the test
    // fails if the shipped SQL changes shape.
    //
    // Both arms are scoped only by "kg_node_id IS NULL", which makes them table-wide: run
    // against the shared curia_test database they would link any nodeless contact another
    // suite happens to own, and arm B would mint a node this suite never records. So every
    // case here runs inside a transaction that is always rolled back — the fixtures, the
    // replay and the assertions all see the same uncommitted state, and nothing survives.
    // (The arms do take row locks on other suites' nodeless contacts for the life of each
    // transaction; these are short, so that is contention, not corruption.)
    let backfillArms: string[];

    beforeAll(async () => {
      const sql = await readFile(
        new URL('../../src/db/migrations/085_contact_anchored_kg_identity.sql', import.meta.url),
        'utf8',
      );
      const up = sql.split('-- Down Migration')[0] ?? '';

      // Match each arm from its WITH clause to the terminating semicolon. Deliberately NOT
      // a split(';'): this file has semicolons inside `--` comments and inside the
      // COMMENT ON string literal, and a naive split cuts straight through them. An earlier
      // version did exactly that and lost arm B the moment a comment gained a semicolon.
      // Neither arm contains a semicolon of its own, so first-semicolon is the real end.
      backfillArms = (['candidates', 'minted'] as const).map((cte) => {
        const match = new RegExp(`^WITH\\s+${cte}\\s+AS\\b[\\s\\S]*?;`, 'm').exec(up);
        if (!match) {
          // Loud rather than silent: a renamed CTE would otherwise reduce this whole suite
          // to asserting nothing while still reporting green.
          throw new Error(
            `migration 085: could not locate backfill arm "WITH ${cte} AS ..." — if the CTE `
            + 'was renamed, update this extractor; do not let the suite run without it.',
          );
        }
        return match[0];
      });

      // Arm A ("candidates") and arm B ("minted").
      expect(backfillArms).toHaveLength(2);
      expect(backfillArms[0]).toContain('kind = \'organization\'');
      expect(backfillArms[1]).toContain('migration_085');
    });

    /** Run `body` on a dedicated client in a transaction that is always rolled back. */
    async function inRolledBackTransaction(
      body: (tx: pg.PoolClient) => Promise<void>,
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await body(client);
      } finally {
        // Not swallowed: a ROLLBACK that fails means the connection is in a state the next
        // test would inherit, and that should be loud even though it masks a body error.
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    }

    async function runBackfill(tx: pg.PoolClient): Promise<void> {
      for (const stmt of backfillArms) {
        await tx.query(stmt);
      }
    }

    it('gives two nodeless same-name contacts a node each, never a shared one', async () => {
      // The #1623 population. Migration 056 minted one node per distinct display_name,
      // which is exactly why the namesakes were left nodeless.
      await inRolledBackTransaction(async (tx) => {
        const label = `Seth Berman ${randomUUID()}`;
        const a = await insertContact({ displayName: label }, tx);
        const b = await insertContact({ displayName: label }, tx);

        await runBackfill(tx);

        const { rows } = await tx.query<{ id: string; kg_node_id: string | null }>(
          'SELECT id, kg_node_id FROM contacts WHERE id = ANY($1::uuid[])', [[a, b]],
        );
        const links = new Map(rows.map(r => [r.id, r.kg_node_id]));
        expect(links.get(a)).not.toBeNull();
        expect(links.get(b)).not.toBeNull();
        expect(links.get(a)).not.toBe(links.get(b));
      });
    });

    it('anchors what it mints, at migration 056 confidence', async () => {
      await inRolledBackTransaction(async (tx) => {
        const contactId = await insertContact({ displayName: `Solo ${randomUUID()}` }, tx);

        await runBackfill(tx);

        const { rows } = await tx.query<{
          identity_source: string; confidence: number; source: string; type: string;
        }>(
          `SELECT n.identity_source, n.confidence, n.source, n.type
             FROM contacts c JOIN kg_nodes n ON n.id = c.kg_node_id
            WHERE c.id = $1`,
          [contactId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.identity_source).toBe('contact');
        expect(rows[0]!.type).toBe('person');
        expect(rows[0]!.source).toBe('migration_085');
        expect(rows[0]!.confidence).toBeCloseTo(0.5, 5);
      });
    });

    it('arm A re-links a nodeless organization contact to its domain node', async () => {
      await inRolledBackTransaction(async (tx) => {
        const domain = `acme-${randomUUID().slice(0, 8)}.test`;
        const orgNode = await insertNode({
          label: `Acme ${randomUUID()}`, type: 'organization', properties: { domain },
        }, tx);
        // The role address that minted the node, and the one the old index turned away.
        await insertContact({
          displayName: 'Acme info', kind: 'organization', kgNodeId: orgNode, primaryEmail: `info@${domain}`,
        }, tx);
        const support = await insertContact({
          displayName: 'Acme support', kind: 'organization', primaryEmail: `support@${domain}`,
        }, tx);

        await runBackfill(tx);

        const { rows } = await tx.query<{ kg_node_id: string | null }>(
          'SELECT kg_node_id FROM contacts WHERE id = $1', [support],
        );
        expect(rows[0]!.kg_node_id).toBe(orgNode);
      });
    });

    it('does not link an organization contact whose domain matches nothing', async () => {
      // Arm B then mints it one, rather than guessing at an unrelated organization.
      await inRolledBackTransaction(async (tx) => {
        const orphan = await insertContact({
          displayName: `Nowhere Inc ${randomUUID()}`,
          kind: 'organization',
          primaryEmail: `hello@nowhere-${randomUUID().slice(0, 8)}.test`,
        }, tx);

        await runBackfill(tx);

        const { rows } = await tx.query<{ type: string; identity_source: string; source: string }>(
          `SELECT n.type, n.identity_source, n.source
             FROM contacts c JOIN kg_nodes n ON n.id = c.kg_node_id
            WHERE c.id = $1`,
          [orphan],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.type).toBe('organization');
        expect(rows[0]!.identity_source).toBe('contact');
        expect(rows[0]!.source).toBe('migration_085');
      });
    });

    it('leaves already-linked contacts untouched', async () => {
      await inRolledBackTransaction(async (tx) => {
        const nodeId = await insertNode({ label: `Linked ${randomUUID()}`, identitySource: 'contact' }, tx);
        const contactId = await insertContact({ displayName: 'Linked', kgNodeId: nodeId }, tx);

        await runBackfill(tx);

        const { rows } = await tx.query<{ kg_node_id: string | null }>(
          'SELECT kg_node_id FROM contacts WHERE id = $1', [contactId],
        );
        expect(rows[0]!.kg_node_id).toBe(nodeId);
      });
    });

    it('leaves nothing behind — the replay is rolled back', async () => {
      // Guards the isolation itself: if the transaction wrapper regressed, this suite
      // would start linking other suites' fixtures and minting untracked nodes.
      let contactId = '';
      await inRolledBackTransaction(async (tx) => {
        contactId = await insertContact({ displayName: `Ephemeral ${randomUUID()}` }, tx);
        await runBackfill(tx);
      });

      const { rows } = await pool.query('SELECT 1 FROM contacts WHERE id = $1', [contactId]);
      expect(rows).toHaveLength(0);
      const minted = await pool.query(
        `SELECT 1 FROM kg_nodes WHERE properties->>'backfilled_for_contact' = $1`, [contactId],
      );
      expect(minted.rows).toHaveLength(0);
    });
  });

  describe('DreamEngine — identity does not decay', () => {
    let engine: DreamEngine;

    beforeAll(() => {
      engine = new DreamEngine(pool, makeBus(), createSilentLogger(), decayConfig);
    });

    it('leaves an anchored node at full confidence while a label-tier twin decays', async () => {
      // Both are slow_decay, both last decayed 400 days ago. Only the tier differs.
      const anchored = await insertNode({
        label: `Anchored ${randomUUID()}`, identitySource: 'contact', confidence: 0.5,
      });
      const labelTier = await insertNode({
        label: `LabelTier ${randomUUID()}`, identitySource: 'label', confidence: 0.5,
      });

      await engine.runDecayPass();

      const { rows } = await pool.query<{ id: string; confidence: number; archived_at: Date | null }>(
        'SELECT id, confidence, archived_at FROM kg_nodes WHERE id = ANY($1::uuid[])',
        [[anchored, labelTier]],
      );
      const byId = new Map(rows.map(r => [r.id, r]));

      expect(byId.get(anchored)!.confidence).toBeCloseTo(0.5, 5);
      expect(byId.get(labelTier)!.confidence).toBeLessThan(0.5);
    });

    it('never archives an anchored node that has decayed below the threshold', async () => {
      // A node already under archiveThreshold — the pre-085 population, where 478 of 532
      // contact nodes were silently archivable. Pass 2b must skip it now.
      const anchored = await insertNode({
        label: `Faded ${randomUUID()}`, identitySource: 'contact', confidence: 0.01,
      });
      const labelTier = await insertNode({
        label: `FadedTwin ${randomUUID()}`, identitySource: 'label', confidence: 0.01,
      });

      await engine.runDecayPass();

      const { rows } = await pool.query<{ id: string; archived_at: Date | null }>(
        'SELECT id, archived_at FROM kg_nodes WHERE id = ANY($1::uuid[])',
        [[anchored, labelTier]],
      );
      const byId = new Map(rows.map(r => [r.id, r]));

      expect(byId.get(anchored)!.archived_at).toBeNull();
      expect(byId.get(labelTier)!.archived_at).not.toBeNull();
    });

    it('never warns an anchored node, however sensitive', async () => {
      // The hole an earlier version of this change left open. Freezing decay does not RAISE
      // confidence, so a node anchored while already below archiveThreshold stays below it.
      // Without the filter on the warn pass, high sensitivity alone re-warns it every run.
      const anchored = await insertNode({
        label: `Sensitive ${randomUUID()}`, identitySource: 'contact', confidence: 0.01,
      });
      await pool.query(`UPDATE kg_nodes SET sensitivity = 'restricted' WHERE id = $1`, [anchored]);
      const labelTier = await insertNode({
        label: `SensitiveTwin ${randomUUID()}`, identitySource: 'label', confidence: 0.01,
      });
      await pool.query(`UPDATE kg_nodes SET sensitivity = 'restricted' WHERE id = $1`, [labelTier]);

      await engine.runDecayPass();

      const { rows } = await pool.query<{ id: string; warned_at: Date | null }>(
        'SELECT id, warned_at FROM kg_nodes WHERE id = ANY($1::uuid[])', [[anchored, labelTier]],
      );
      const byId = new Map(rows.map(r => [r.id, r]));
      expect(byId.get(anchored)!.warned_at).toBeNull();
      // The label-tier control proves the warn pass fired at all this run.
      expect(byId.get(labelTier)!.warned_at).not.toBeNull();
    });

    it('does not archive an anchored node whose warning has already expired', async () => {
      // Pass 2a, reached across a second decay pass. A warning raised before the node was
      // anchored (anchorNode clears warned_at, migration 085 clears the legacy rows, but a
      // concurrent pass could still land one) must not become the surviving archival path.
      const anchored = await insertNode({
        label: `StaleWarned ${randomUUID()}`, identitySource: 'contact', confidence: 0.01,
      });
      const labelTier = await insertNode({
        label: `StaleWarnedTwin ${randomUUID()}`, identitySource: 'label', confidence: 0.01,
      });
      // warnHoldBackDays is 30 in this suite's config, so 60 days is comfortably expired.
      await pool.query(
        `UPDATE kg_nodes
            SET warned_at = now() - INTERVAL '60 days', warn_reason = 'high_sensitivity'
          WHERE id = ANY($1::uuid[])`,
        [[anchored, labelTier]],
      );

      await engine.runDecayPass();
      await engine.runDecayPass();

      const { rows } = await pool.query<{ id: string; archived_at: Date | null }>(
        'SELECT id, archived_at FROM kg_nodes WHERE id = ANY($1::uuid[])', [[anchored, labelTier]],
      );
      const byId = new Map(rows.map(r => [r.id, r]));
      expect(byId.get(anchored)!.archived_at).toBeNull();
      // The label-tier control proves Pass 2a ran and did archive an expired warning.
      expect(byId.get(labelTier)!.archived_at).not.toBeNull();
    });

    it('keeps decaying facts hanging off an anchored node', async () => {
      // The exclusion protects the container, not its contents — otherwise it would
      // freeze memory rather than stop the anchor evaporating.
      const anchored = await insertNode({
        label: `Anchored ${randomUUID()}`, identitySource: 'contact', confidence: 0.5,
      });
      const fact = await insertNode({
        label: `Fact about them ${randomUUID()}`, type: 'fact', identitySource: 'label', confidence: 0.5,
      });
      await pool.query(
        `INSERT INTO kg_edges (source_node_id, target_node_id, type, properties, source, confidence, decay_class,
                               created_at, last_confirmed_at)
         VALUES ($1, $2, 'knows', '{}', 'test', 0.5, 'slow_decay', now(), now())`,
        [anchored, fact],
      );

      await engine.runDecayPass();

      const { rows } = await pool.query<{ confidence: number }>(
        'SELECT confidence FROM kg_nodes WHERE id = $1', [fact],
      );
      expect(rows[0]!.confidence).toBeLessThan(0.5);
    });
  });
});
