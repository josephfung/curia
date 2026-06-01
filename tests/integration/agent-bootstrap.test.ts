// tests/integration/agent-bootstrap.test.ts
//
// Integration tests for bootstrapAgentIdentity — the agent self-identity helper
// run once at startup. The function must be idempotent across restarts AND must
// reconcile the contact row's display_name when the operator renames the
// assistant via the wizard (PUT /api/identity → version bump → process restart →
// bootstrapAgentIdentity called with the new name).
//
// Without that reconciliation, an assistant renamed in the wizard from "Alex Curia"
// to e.g. "Nate Curia" stays known as "Alex Curia" in the contacts table forever
// (because the contacts INSERT ON CONFLICT clause only updates role / system_role
// / updated_at). The KG node label already updates correctly via its own ON CONFLICT.
//
// Requires a running Postgres with migrations applied.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { bootstrapAgentIdentity } from '../../src/entity-context/bootstrap.js';
import { createLogger } from '../../src/logger.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('bootstrapAgentIdentity', () => {
  let pool: pg.Pool;
  const logger = createLogger('silent');

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    await pool.end();
  });

  // Strip the singleton agent rows before each test. The partial unique indexes
  // (idx_kg_nodes_agent_singleton, idx_contacts_kg_node_unique, idx_contacts_system_role_agent)
  // mean we can only have one agent at a time, so wipe completely before each case.
  beforeEach(async () => {
    await pool.query(`DELETE FROM contacts WHERE system_role = 'agent'`);
    await pool.query(`DELETE FROM kg_nodes WHERE (properties->>'is_agent') = 'true'`);
  });

  it('creates a fresh agent identity (KG node + contact) with the given display name', async () => {
    const result = await bootstrapAgentIdentity('Agent Test First', pool, logger);

    expect(result.contactId).toBeTruthy();
    expect(result.kgNodeId).toBeTruthy();

    const contact = await pool.query<{ display_name: string; role: string; system_role: string }>(
      `SELECT display_name, role, system_role FROM contacts WHERE id = $1`,
      [result.contactId],
    );
    expect(contact.rows[0]?.display_name).toBe('Agent Test First');
    expect(contact.rows[0]?.role).toBe('agent');
    expect(contact.rows[0]?.system_role).toBe('agent');

    const node = await pool.query<{ label: string }>(
      `SELECT label FROM kg_nodes WHERE id = $1`,
      [result.kgNodeId],
    );
    expect(node.rows[0]?.label).toBe('Agent Test First');
  });

  it('is idempotent on repeated calls with the same name (same contact id, no duplicates)', async () => {
    const first = await bootstrapAgentIdentity('Agent Test Idem', pool, logger);
    const second = await bootstrapAgentIdentity('Agent Test Idem', pool, logger);

    expect(second.contactId).toBe(first.contactId);
    expect(second.kgNodeId).toBe(first.kgNodeId);

    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contacts WHERE system_role = 'agent'`,
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('updates the contact display_name when called again with a renamed identity', async () => {
    // First boot — wizard hasn't run yet, so we boot with the default name.
    const first = await bootstrapAgentIdentity('Agent Test Old Name', pool, logger);
    expect(first.contactId).toBeTruthy();

    const before = await pool.query<{ display_name: string }>(
      `SELECT display_name FROM contacts WHERE id = $1`,
      [first.contactId],
    );
    expect(before.rows[0]?.display_name).toBe('Agent Test Old Name');

    // Second boot — operator finished the wizard, identity was renamed, process
    // restarted, bootstrapAgentIdentity is called with the new name. The KG node's
    // ON CONFLICT clause already updates label via DO UPDATE SET label = EXCLUDED.label;
    // the contact's ON CONFLICT clause must mirror that for display_name.
    const second = await bootstrapAgentIdentity('Agent Test New Name', pool, logger);
    expect(second.contactId).toBe(first.contactId);

    const afterContact = await pool.query<{ display_name: string }>(
      `SELECT display_name FROM contacts WHERE id = $1`,
      [first.contactId],
    );
    expect(afterContact.rows[0]?.display_name).toBe('Agent Test New Name');

    const afterNode = await pool.query<{ label: string }>(
      `SELECT label FROM kg_nodes WHERE id = $1`,
      [first.kgNodeId],
    );
    expect(afterNode.rows[0]?.label).toBe('Agent Test New Name');
  });
});
