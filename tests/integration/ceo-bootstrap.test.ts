// tests/integration/ceo-bootstrap.test.ts
//
// Integration tests for the principal/KG utilities in src/contacts/ceo-bootstrap.ts.
//
// The env-var-driven bootstrapCeoContact was removed in #1049 — these tests now cover
// the surviving, shared helpers that the onboarding-wizard path (ensure-principal.ts)
// and the startup principal resolution (src/index.ts) both depend on:
//   - insertKgPersonNode: adopt-or-mint a permanent, contact-anchored person node (ADR-040)
//   - createAndLinkKgNode: link a freshly created node to a contact with kg_node_id = NULL
//   - repairPrincipalMetadata: idempotent self-heal of role/system_role/tier/kind
//
// Requires a running Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  insertKgPersonNode,
  createAndLinkKgNode,
  repairPrincipalMetadata,
} from '../../src/contacts/ceo-bootstrap.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('ceo-bootstrap principal/KG utilities', () => {
  let pool: pg.Pool;
  const logger = createLogger('silent');
  // Distinct labels per concern so cleanup with a single LIKE prefix catches them all.
  const LABEL = 'Bootstrap Test CEO';
  const OTHER_LABEL = 'Bootstrap Test Other Person';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Order matters: contacts reference kg_nodes via kg_node_id, so clear contacts first.
    await pool.query(`DELETE FROM contacts WHERE display_name LIKE 'Bootstrap Test%'`);
    await pool.query(`DELETE FROM kg_nodes WHERE label LIKE 'Bootstrap Test%'`);
  });

  describe('insertKgPersonNode', () => {
    it('creates a permanent person node from scratch', async () => {
      const { id, created } = await insertKgPersonNode(LABEL, pool);
      expect(id).toBeTruthy();
      expect(created).toBe(true);

      const node = await pool.query<{
        type: string; label: string; decay_class: string; source: string; confidence: number;
        identity_source: string;
      }>(
        `SELECT type, label, decay_class, source, confidence, identity_source FROM kg_nodes WHERE id = $1`,
        [id],
      );
      expect(node.rows[0]).toBeDefined();
      expect(node.rows[0]!.type).toBe('person');
      expect(node.rows[0]!.label).toBe(LABEL);
      expect(node.rows[0]!.decay_class).toBe('permanent');
      expect(node.rows[0]!.source).toBe('bootstrap');
      expect(node.rows[0]!.confidence).toBe(1);
      // The principal is a contact, so its node is contact-anchored like any other
      // (ADR-040) — not left in the label tier where a namesake would collide with it.
      expect(node.rows[0]!.identity_source).toBe('contact');
    });

    it('promotes a pre-existing slow_decay person node to permanent on conflict', async () => {
      // Simulate what email-based extraction creates before any bootstrap runs:
      // a person node with the default slow_decay for the principal's display name.
      const preExistingNodeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO kg_nodes (id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at)
         VALUES ($1, 'person', $2, '{}', 0.7, 'slow_decay', 'extraction', now(), now())`,
        [preExistingNodeId, LABEL],
      );

      const { id, created } = await insertKgPersonNode(LABEL, pool);
      expect(id).toBe(preExistingNodeId);
      // Adopted, not minted — the caller must be able to tell, because only a node this
      // call created is safe to delete on a lost race (ADR-040, PR #1712 review).
      expect(created).toBe(false);

      const node = await pool.query<{
        decay_class: string; confidence: number; source: string; identity_source: string;
      }>(
        `SELECT decay_class, confidence, source, identity_source FROM kg_nodes WHERE id = $1`,
        [preExistingNodeId],
      );
      expect(node.rows[0]).toBeDefined();
      expect(node.rows[0]!.decay_class).toBe('permanent');
      expect(node.rows[0]!.confidence).toBeGreaterThanOrEqual(1.0);
      // source is preserved (not overwritten) to keep the audit trail intact
      expect(node.rows[0]!.source).toBe('extraction');
      // Adoption, not a second node: the extraction node becomes the principal's identity.
      expect(node.rows[0]!.identity_source).toBe('contact');
    });

    it('does not demote confidence when the conflicting node already has confidence >= 1.0', async () => {
      const preExistingNodeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO kg_nodes (id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at)
         VALUES ($1, 'person', $2, '{}', 1.0, 'permanent', 'bootstrap', now(), now())`,
        [preExistingNodeId, LABEL],
      );

      const { id, created } = await insertKgPersonNode(LABEL, pool);
      expect(id).toBe(preExistingNodeId);
      expect(created).toBe(false);

      const node = await pool.query<{ decay_class: string; confidence: number }>(
        `SELECT decay_class, confidence FROM kg_nodes WHERE id = $1`,
        [preExistingNodeId],
      );
      expect(node.rows[0]).toBeDefined();
      expect(node.rows[0]!.decay_class).toBe('permanent');
      expect(node.rows[0]!.confidence).toBe(1.0);
    });

    it('does not affect person nodes with a different label', async () => {
      const unrelatedNodeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO kg_nodes (id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at)
         VALUES ($1, 'person', $2, '{}', 0.7, 'slow_decay', 'extraction', now(), now())`,
        [unrelatedNodeId, OTHER_LABEL],
      );

      await insertKgPersonNode(LABEL, pool);

      const node = await pool.query<{ decay_class: string }>(
        `SELECT decay_class FROM kg_nodes WHERE id = $1`,
        [unrelatedNodeId],
      );
      expect(node.rows[0]).toBeDefined();
      expect(node.rows[0]!.decay_class).toBe('slow_decay');
    });
  });

  describe('createAndLinkKgNode', () => {
    it('creates a node and links it to a contact whose kg_node_id is NULL', async () => {
      const contactId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO contacts (id, display_name, role, tier, kind, created_at, updated_at)
         VALUES ($1, $2, 'ceo', 'principal', 'principal', now(), now())`,
        [contactId, LABEL],
      );

      const kgNodeId = await createAndLinkKgNode(contactId, LABEL, pool);
      expect(kgNodeId).toBeTruthy();

      const contact = await pool.query<{ kg_node_id: string }>(
        `SELECT kg_node_id FROM contacts WHERE id = $1`,
        [contactId],
      );
      expect(contact.rows[0]!.kg_node_id).toBe(kgNodeId);
    });
  });

  describe('repairPrincipalMetadata', () => {
    it('repairs a contact left at migration-default capability metadata', async () => {
      // Simulate a row written by older code / auto-creation: unknown tier, person kind, no role.
      const contactId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO contacts (id, display_name, role, system_role, tier, kind, created_at, updated_at)
         VALUES ($1, $2, null, null, 'unknown', 'person', now(), now())`,
        [contactId, LABEL],
      );

      await repairPrincipalMetadata(contactId, pool, logger);

      const contact = await pool.query<{
        role: string; system_role: string; tier: string; kind: string;
      }>(
        `SELECT role, system_role, tier, kind FROM contacts WHERE id = $1`,
        [contactId],
      );
      expect(contact.rows[0]!.role).toBe('ceo');
      expect(contact.rows[0]!.system_role).toBe('principal');
      expect(contact.rows[0]!.tier).toBe('principal');
      expect(contact.rows[0]!.kind).toBe('principal');
    });

    it('is an idempotent no-op when the row is already canonical', async () => {
      const contactId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO contacts (id, display_name, role, system_role, tier, kind, created_at, updated_at)
         VALUES ($1, $2, 'ceo', 'principal', 'principal', 'principal', now(), now() - interval '1 hour')`,
        [contactId, LABEL],
      );
      const before = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM contacts WHERE id = $1`,
        [contactId],
      );

      await repairPrincipalMetadata(contactId, pool, logger);

      // The WHERE guard makes a correct row a no-op, so updated_at must not change.
      const after = await pool.query<{ updated_at: Date }>(
        `SELECT updated_at FROM contacts WHERE id = $1`,
        [contactId],
      );
      expect(after.rows[0]!.updated_at.getTime()).toBe(before.rows[0]!.updated_at.getTime());
    });
  });
});
