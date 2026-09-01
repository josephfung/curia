// Integration test — ContactService.mergeContacts is one transaction (#1695).
//
// The in-memory backend cannot prove this: it has no rollback, so a unit test can only
// check that the client is threaded and that the post-commit notifications stay quiet.
// What needs a live Postgres is the guarantee itself — when a write in the middle of the
// sequence fails, every earlier write in it is undone.
//
// The failure is forced with a BEFORE DELETE trigger scoped by id to the secondary
// contact, so the last write in the sequence (deleteContact) raises while the four
// writes before it have already run. Nothing else in the database is affected, and the
// trigger is dropped in afterEach.
//
// Every fixture row is created by this suite and deleted by id in afterEach.
// Skips gracefully when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../src/contacts/contact-service.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

const FAIL_TRIGGER = 'itest_1695_block_secondary_delete';

describeIf('mergeContacts transactionality (#1695)', () => {
  let pool: pg.Pool;
  let contactService: ContactService;

  const createdContactIds: string[] = [];

  /** Insert a contact directly: kg_node_id stays NULL so no KG merge is attempted. */
  async function makeContact(displayName: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name, kg_node_id) VALUES ($1, NULL) RETURNING id`,
      [displayName],
    );
    const id = rows[0]!.id;
    createdContactIds.push(id);
    return id;
  }

  async function addIdentity(contactId: string, channel: string, identifier: string): Promise<void> {
    await pool.query(
      `INSERT INTO contact_channel_identities (contact_id, channel, channel_identifier, source)
       VALUES ($1, $2, $3, 'itest-1695')`,
      [contactId, channel, identifier],
    );
  }

  async function addOverride(contactId: string, permission: string): Promise<void> {
    await pool.query(
      `INSERT INTO contact_auth_overrides (contact_id, permission, granted, granted_by)
       VALUES ($1, $2, true, 'itest-1695')`,
      [contactId, permission],
    );
  }

  /** Identity owner rows for the fixture contacts, ordered so comparisons are stable. */
  async function identityOwners(): Promise<Array<{ contactId: string; identifier: string }>> {
    const { rows } = await pool.query<{ contact_id: string; channel_identifier: string }>(
      `SELECT contact_id, channel_identifier FROM contact_channel_identities
       WHERE contact_id = ANY($1::uuid[]) ORDER BY channel_identifier`,
      [createdContactIds],
    );
    return rows.map(r => ({ contactId: r.contact_id, identifier: r.channel_identifier }));
  }

  async function overrideOwners(): Promise<Array<{ contactId: string; permission: string }>> {
    const { rows } = await pool.query<{ contact_id: string; permission: string }>(
      `SELECT contact_id, permission FROM contact_auth_overrides
       WHERE contact_id = ANY($1::uuid[]) ORDER BY permission`,
      [createdContactIds],
    );
    return rows.map(r => ({ contactId: r.contact_id, permission: r.permission }));
  }

  async function exclusionRows(): Promise<Array<{ a: string; b: string }>> {
    const { rows } = await pool.query<{ contact_a_id: string; contact_b_id: string }>(
      `SELECT contact_a_id, contact_b_id FROM contact_dedup_exclusions
       WHERE contact_a_id = ANY($1::uuid[]) OR contact_b_id = ANY($1::uuid[])
       ORDER BY contact_a_id, contact_b_id`,
      [createdContactIds],
    );
    return rows.map(r => ({ a: r.contact_a_id, b: r.contact_b_id }));
  }

  /**
   * Make DELETE on one specific contact row raise, so the merge's final write fails
   * with the four writes before it already applied inside the transaction.
   */
  async function blockDeleteOf(contactId: string): Promise<void> {
    await pool.query(
      `CREATE OR REPLACE FUNCTION ${FAIL_TRIGGER}() RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'forced merge failure (#1695 integration test)';
       END;
       $$ LANGUAGE plpgsql`,
    );
    // DDL cannot take bind parameters, so the id is quoted by Postgres itself via
    // format(%L) and the resulting statement is then executed — never string-concatenated
    // in JS. The WHEN clause keeps the trigger scoped to this suite's own contact row, so
    // suites running in parallel against the same database are untouched.
    const { rows } = await pool.query<{ sql: string }>(
      `SELECT format(
         $fmt$CREATE TRIGGER ${FAIL_TRIGGER} BEFORE DELETE ON contacts
              FOR EACH ROW WHEN (OLD.id = %L::uuid)
              EXECUTE FUNCTION ${FAIL_TRIGGER}()$fmt$,
         $1::uuid
       ) AS sql`,
      [contactId],
    );
    await pool.query(rows[0]!.sql);
  }

  async function unblockDelete(): Promise<void> {
    await pool.query(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON contacts`);
    await pool.query(`DROP FUNCTION IF EXISTS ${FAIL_TRIGGER}()`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // This suite creates and drops a trigger on the shared `contacts` table, so it must
    // never point at a real database even though every row it writes is its own.
    await requireCuriaTestDatabase(pool);

    // No EntityMemory: the fixtures have kg_node_id = NULL, so mergeContacts skips the
    // KG merge entirely and the suite needs no embedding credentials.
    contactService = ContactService.createWithPostgres(pool, undefined, createSilentLogger());

    // Fails fast when migration 084 has not been applied.
    await pool.query('SELECT 1 FROM contact_dedup_exclusions LIMIT 0');
  });

  afterEach(async () => {
    // Drop the trigger first — otherwise fixture teardown hits it too.
    await unblockDelete();
    if (createdContactIds.length > 0) {
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [createdContactIds]);
      createdContactIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it('rolls the whole write sequence back when the final write fails', async () => {
    const primary = await makeContact('Tx Primary 1695');
    const secondary = await makeContact('Tx Secondary 1695');
    const other = await makeContact('Tx Bystander 1695');

    await addIdentity(primary, 'email', 'tx-primary-1695@example.com');
    await addIdentity(secondary, 'email', 'tx-secondary-1695@example.com');
    await addOverride(primary, 'itest:1695:primary-perm');
    await addOverride(secondary, 'itest:1695:secondary-perm');
    // A CEO ruling held by the secondary: exactly the row #1625 moved into this sequence.
    await contactService.addDedupExclusion(secondary, other, 'itest-1695');

    const identitiesBefore = await identityOwners();
    const overridesBefore = await overrideOwners();
    const exclusionsBefore = await exclusionRows();

    await blockDeleteOf(secondary);

    await expect(contactService.mergeContacts(primary, secondary, false))
      .rejects.toThrow(/forced merge failure/);

    // Both contacts survive — the golden-record update on the primary is rolled back too.
    const { rows: survivors } = await pool.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM contacts WHERE id = ANY($1::uuid[]) ORDER BY display_name`,
      [[primary, secondary]],
    );
    expect(survivors).toHaveLength(2);

    // Identities, overrides and the CEO ruling are all exactly where they were: nothing
    // was left re-pointed onto a survivor whose golden record was never written.
    expect(await identityOwners()).toEqual(identitiesBefore);
    expect(await overrideOwners()).toEqual(overridesBefore);
    expect(await exclusionRows()).toEqual(exclusionsBefore);
    expect(exclusionsBefore).toHaveLength(1);
    expect(exclusionsBefore[0]).toEqual({
      a: secondary < other ? secondary : other,
      b: secondary < other ? other : secondary,
    });
  });

  it('commits the same sequence when nothing fails', async () => {
    // The mirror of the rollback case: without the trigger the identical fixture merges,
    // which is what makes the assertions above evidence of rollback rather than of a
    // merge that never started.
    const primary = await makeContact('Commit Primary 1695');
    const secondary = await makeContact('Commit Secondary 1695');
    const other = await makeContact('Commit Bystander 1695');

    await addIdentity(secondary, 'email', 'commit-secondary-1695@example.com');
    await addOverride(secondary, 'itest:1695:moved-perm');
    await contactService.addDedupExclusion(secondary, other, 'itest-1695');

    await contactService.mergeContacts(primary, secondary, false);

    const { rows: survivors } = await pool.query<{ id: string }>(
      `SELECT id FROM contacts WHERE id = ANY($1::uuid[])`,
      [[primary, secondary]],
    );
    expect(survivors.map(r => r.id)).toEqual([primary]);

    expect(await identityOwners()).toEqual([
      { contactId: primary, identifier: 'commit-secondary-1695@example.com' },
    ]);
    expect(await overrideOwners()).toEqual([
      { contactId: primary, permission: 'itest:1695:moved-perm' },
    ]);
    expect(await exclusionRows()).toEqual([{
      a: primary < other ? primary : other,
      b: primary < other ? other : primary,
    }]);
  });
});
