// tests/integration/ensure-principal.test.ts
//
// Integration tests for ensurePrincipalContact — the name-only principal helper
// used by the in-app onboarding wizard's "About you" step (issue #771). Unlike
// bootstrapCeoContact, this helper takes no channel identity: the principal is
// created as a named entity that channel identities will be bound to later via
// the verification flows.
//
// Requires a running Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is not set.
//
// IMPORTANT: requires a DB with NO pre-existing principal contact. The partial
// unique index on system_role='principal' means the "creates" case will 23505
// if any other principal already exists. CI runs against a fresh container;
// for local dev runs, point DATABASE_URL at an empty test database.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { ensurePrincipalContact } from '../../src/contacts/ensure-principal.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('ensurePrincipalContact', () => {
  let pool: pg.Pool;
  const logger = createLogger('silent');
  const TEST_LABEL_PREFIX = 'Ensure-Principal Test';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');

    // Other test files (notably ceo-bootstrap.test.ts) may leave a principal contact
    // behind. The partial unique index `idx_contacts_system_role_principal` would
    // then cause every "create" test here to 23505. Clear any pre-existing principal
    // so this file owns that slot for the duration of its run.
    //
    // Destructive against a working operator DB by design — the file header documents
    // that these integration tests must point at an empty test database, never at
    // production or a developer's local dev environment with real data.
    await pool.query(
      `DELETE FROM contact_channel_identities WHERE contact_id IN
         (SELECT id FROM contacts WHERE system_role = 'principal')`,
    );
    await pool.query(`DELETE FROM contacts WHERE system_role = 'principal'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Clean up any contacts + KG nodes created by these tests so cases don't leak.
  // The partial unique index on system_role='principal' would otherwise cause case
  // 'creates a new principal' to fail on a second run.
  beforeEach(async () => {
    // Wipe channel identities first to satisfy the FK cascade ordering.
    await pool.query(
      `DELETE FROM contact_channel_identities
       WHERE contact_id IN (SELECT id FROM contacts WHERE display_name LIKE $1)`,
      [`${TEST_LABEL_PREFIX}%`],
    );
    await pool.query(`DELETE FROM contacts WHERE display_name LIKE $1`, [`${TEST_LABEL_PREFIX}%`]);
    await pool.query(
      `DELETE FROM kg_nodes WHERE source = 'bootstrap' AND label LIKE $1`,
      [`${TEST_LABEL_PREFIX}%`],
    );
  });

  it('creates a new principal contact with a KG person node and no channel identity', async () => {
    const displayName = `${TEST_LABEL_PREFIX} Alice`;
    const result = await ensurePrincipalContact({ displayName }, pool, logger);

    expect(result.alreadyExisted).toBe(false);
    expect(result.contactId).toBeTruthy();
    expect(result.kgNodeId).toBeTruthy();

    // Contact row was created with the principal fields the readiness gate expects.
    const contact = await pool.query<{
      display_name: string;
      role: string;
      tier: string;
      system_role: string;
      kg_node_id: string;
    }>(
      `SELECT display_name, role, tier, system_role, kg_node_id
       FROM contacts WHERE id = $1`,
      [result.contactId],
    );
    expect(contact.rows[0]).toBeDefined();
    expect(contact.rows[0]!.display_name).toBe(displayName);
    expect(contact.rows[0]!.role).toBe('ceo');
    expect(contact.rows[0]!.tier).toBe('principal');
    expect(contact.rows[0]!.system_role).toBe('principal');
    expect(contact.rows[0]!.kg_node_id).toBe(result.kgNodeId);

    // KG person node was created with the same metadata as bootstrapCeoContact's nodes.
    const node = await pool.query<{
      type: string;
      label: string;
      decay_class: string;
      source: string;
      confidence: number;
    }>(
      `SELECT type, label, decay_class, source, confidence
       FROM kg_nodes WHERE id = $1`,
      [result.kgNodeId],
    );
    expect(node.rows[0]).toBeDefined();
    expect(node.rows[0]!.type).toBe('person');
    expect(node.rows[0]!.label).toBe(displayName);
    expect(node.rows[0]!.decay_class).toBe('permanent');
    expect(node.rows[0]!.source).toBe('bootstrap');
    expect(Number(node.rows[0]!.confidence)).toBe(1);

    // No channel identities should exist — that's the whole point of this helper.
    const identities = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM contact_channel_identities WHERE contact_id = $1`,
      [result.contactId],
    );
    expect(Number(identities.rows[0]!.count)).toBe(0);
  });

  it('returns the existing principal when one already exists (idempotent)', async () => {
    const displayName = `${TEST_LABEL_PREFIX} Beth`;
    const first = await ensurePrincipalContact({ displayName }, pool, logger);
    expect(first.alreadyExisted).toBe(false);

    // Second call with the SAME name — should be a no-op.
    const second = await ensurePrincipalContact({ displayName }, pool, logger);
    expect(second.alreadyExisted).toBe(true);
    expect(second.contactId).toBe(first.contactId);
    expect(second.kgNodeId).toBe(first.kgNodeId);

    // Even if the caller passes a DIFFERENT name, the helper should refuse to rename
    // — the principal is a named entity and the existing display_name wins. This is
    // a small but important invariant: the wizard's Step 1 must not accidentally
    // overwrite a name set elsewhere.
    const third = await ensurePrincipalContact(
      { displayName: `${TEST_LABEL_PREFIX} Renamed` },
      pool,
      logger,
    );
    expect(third.alreadyExisted).toBe(true);
    expect(third.contactId).toBe(first.contactId);

    const after = await pool.query<{ display_name: string }>(
      `SELECT display_name FROM contacts WHERE id = $1`,
      [first.contactId],
    );
    expect(after.rows[0]!.display_name).toBe(displayName);
  });

  it('backfills kg_node_id when an existing principal has none', async () => {
    // Seed: a principal contact created by hand (or by old code) with kg_node_id = NULL.
    const contactId = crypto.randomUUID();
    const displayName = `${TEST_LABEL_PREFIX} Carol`;
    await pool.query(
      `INSERT INTO contacts
         (id, display_name, role, tier, kind, system_role, created_at, updated_at)
       VALUES ($1, $2, 'ceo', 'principal', 'principal', 'principal', now(), now())`,
      [contactId, displayName],
    );

    const before = await pool.query<{ kg_node_id: string | null }>(
      `SELECT kg_node_id FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(before.rows[0]!.kg_node_id).toBeNull();

    const result = await ensurePrincipalContact({ displayName }, pool, logger);

    expect(result.alreadyExisted).toBe(true);
    expect(result.contactId).toBe(contactId);
    expect(result.kgNodeId).toBeTruthy();

    const after = await pool.query<{ kg_node_id: string }>(
      `SELECT kg_node_id FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(after.rows[0]!.kg_node_id).toBe(result.kgNodeId);
  });

  it('rejects an empty display name at the helper boundary', async () => {
    await expect(
      ensurePrincipalContact({ displayName: '' }, pool, logger),
    ).rejects.toThrow(/displayName/i);

    await expect(
      ensurePrincipalContact({ displayName: '   ' }, pool, logger),
    ).rejects.toThrow(/displayName/i);
  });
});
