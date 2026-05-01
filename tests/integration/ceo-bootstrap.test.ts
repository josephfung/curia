// tests/integration/ceo-bootstrap.test.ts
//
// Integration tests for bootstrapCeoContact.
// Verifies that the CEO contact is created with a linked KG person node in all
// three cases, and that existing contacts with kg_node_id = NULL are backfilled.
//
// Requires a running Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { bootstrapCeoContact } from '../../src/contacts/ceo-bootstrap.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('bootstrapCeoContact', () => {
  let pool: pg.Pool;
  const testEmail = 'ceo-bootstrap-test@example.com';
  const logger = createLogger('silent');

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Verify required tables exist
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    await pool.end();
  });

  // Clean up test rows before each test so cases don't bleed into each other
  beforeEach(async () => {
    await pool.query(
      `DELETE FROM contact_channel_identities WHERE channel = 'email' AND channel_identifier = $1`,
      [testEmail],
    );
    await pool.query(
      `DELETE FROM contacts WHERE role = 'ceo' AND display_name LIKE 'Bootstrap Test%'`,
    );
    // kg_nodes rows created during tests are cleaned up via FK cascade when contacts are deleted
    // (if kg_node_id FK has ON DELETE SET NULL we need to clean separately)
    await pool.query(
      `DELETE FROM kg_nodes WHERE source = 'bootstrap' AND label LIKE 'Bootstrap Test%'`,
    );
  });

  it('case 3: creates contact, channel identity, and KG person node from scratch', async () => {
    const result = await bootstrapCeoContact(testEmail, 'Bootstrap Test CEO', pool, logger);

    expect(result.alreadyExisted).toBe(false);
    expect(result.contactId).toBeTruthy();
    expect(result.kgNodeId).toBeTruthy();

    // Verify the contact row was created with the correct fields
    const contact = await pool.query<{
      id: string; display_name: string; role: string; status: string; trust_level: string; kg_node_id: string;
    }>(
      `SELECT id, display_name, role, status, trust_level, kg_node_id FROM contacts WHERE id = $1`,
      [result.contactId],
    );
    expect(contact.rows[0]).toBeDefined();
    expect(contact.rows[0].display_name).toBe('Bootstrap Test CEO');
    expect(contact.rows[0].role).toBe('ceo');
    expect(contact.rows[0].status).toBe('confirmed');
    expect(contact.rows[0].trust_level).toBe('ceo');
    expect(contact.rows[0].kg_node_id).toBe(result.kgNodeId);

    // Verify the KG node was created with correct metadata
    const node = await pool.query<{
      id: string; type: string; label: string; decay_class: string; source: string; confidence: number;
    }>(
      `SELECT id, type, label, decay_class, source, confidence FROM kg_nodes WHERE id = $1`,
      [result.kgNodeId],
    );
    expect(node.rows[0]).toBeDefined();
    expect(node.rows[0].type).toBe('person');
    expect(node.rows[0].label).toBe('Bootstrap Test CEO');
    expect(node.rows[0].decay_class).toBe('permanent');
    expect(node.rows[0].source).toBe('bootstrap');
    expect(node.rows[0].confidence).toBe(1);

    // Verify the channel identity was created and verified
    const identity = await pool.query<{ verified: boolean; source: string }>(
      `SELECT verified, source FROM contact_channel_identities
       WHERE contact_id = $1 AND channel = 'email' AND channel_identifier = $2`,
      [result.contactId, testEmail],
    );
    expect(identity.rows[0]).toBeDefined();
    expect(identity.rows[0].verified).toBe(true);
    expect(identity.rows[0].source).toBe('bootstrap');
  });

  it('case 1: returns existing IDs when contact is already confirmed + verified', async () => {
    // Seed via the first call
    const first = await bootstrapCeoContact(testEmail, 'Bootstrap Test CEO', pool, logger);
    expect(first.alreadyExisted).toBe(false);

    // Second call should be a no-op
    const second = await bootstrapCeoContact(testEmail, 'Bootstrap Test CEO', pool, logger);
    expect(second.alreadyExisted).toBe(true);
    expect(second.contactId).toBe(first.contactId);
    expect(second.kgNodeId).toBe(first.kgNodeId);

    // No duplicate KG nodes should exist for this contact
    const nodeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM kg_nodes WHERE label = 'Bootstrap Test CEO' AND source = 'bootstrap'`,
    );
    expect(Number(nodeCount.rows[0].count)).toBe(1);
  });

  it('case 2: promotes provisional contact and assigns KG node', async () => {
    // Insert a provisional contact + unverified identity directly (simulates
    // the auto-creation path from extractParticipants)
    const contactId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO contacts (id, display_name, role, status, trust_level, created_at, updated_at)
       VALUES ($1, 'Bootstrap Test CEO', null, 'provisional', null, now(), now())`,
      [contactId],
    );
    await pool.query(
      `INSERT INTO contact_channel_identities (id, contact_id, channel, channel_identifier, verified, source, created_at, updated_at)
       VALUES ($1, $2, 'email', $3, false, 'auto', now(), now())`,
      [crypto.randomUUID(), contactId, testEmail],
    );

    const result = await bootstrapCeoContact(testEmail, 'Bootstrap Test CEO', pool, logger);

    expect(result.alreadyExisted).toBe(true);
    expect(result.contactId).toBe(contactId);
    expect(result.kgNodeId).toBeTruthy();

    // Contact should now be confirmed + ceo trust
    const contact = await pool.query<{ status: string; trust_level: string; kg_node_id: string }>(
      `SELECT status, trust_level, kg_node_id FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(contact.rows[0].status).toBe('confirmed');
    expect(contact.rows[0].trust_level).toBe('ceo');
    expect(contact.rows[0].kg_node_id).toBe(result.kgNodeId);

    // Identity should now be verified
    const identity = await pool.query<{ verified: boolean }>(
      `SELECT verified FROM contact_channel_identities WHERE contact_id = $1 AND channel = 'email'`,
      [contactId],
    );
    expect(identity.rows[0].verified).toBe(true);
  });

  it('backfills kg_node_id on a confirmed contact that has none', async () => {
    // Simulate a contact created by old code: confirmed + verified but kg_node_id = NULL
    const contactId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO contacts (id, display_name, role, status, trust_level, created_at, updated_at)
       VALUES ($1, 'Bootstrap Test CEO', 'ceo', 'confirmed', 'high', now(), now())`,
      [contactId],
    );
    await pool.query(
      `INSERT INTO contact_channel_identities (id, contact_id, channel, channel_identifier, verified, verified_at, source, created_at, updated_at)
       VALUES ($1, $2, 'email', $3, true, now(), 'bootstrap', now(), now())`,
      [crypto.randomUUID(), contactId, testEmail],
    );

    // Confirm kg_node_id starts as NULL
    const before = await pool.query<{ kg_node_id: string | null }>(
      `SELECT kg_node_id FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(before.rows[0].kg_node_id).toBeNull();

    const result = await bootstrapCeoContact(testEmail, 'Bootstrap Test CEO', pool, logger);

    expect(result.alreadyExisted).toBe(true);
    expect(result.contactId).toBe(contactId);
    expect(result.kgNodeId).toBeTruthy();

    // kg_node_id should now be set
    const after = await pool.query<{ kg_node_id: string }>(
      `SELECT kg_node_id FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(after.rows[0].kg_node_id).toBe(result.kgNodeId);

    // KG node should be a permanent bootstrap person node
    const node = await pool.query<{ type: string; decay_class: string; source: string }>(
      `SELECT type, decay_class, source FROM kg_nodes WHERE id = $1`,
      [result.kgNodeId],
    );
    expect(node.rows[0].type).toBe('person');
    expect(node.rows[0].decay_class).toBe('permanent');
    expect(node.rows[0].source).toBe('bootstrap');
  });
});
