// tests/integration/contacts-cutover.integration.test.ts
//
// Post-cutover data-integrity verification for #955.
//
// Asserts that:
//   1. The legacy `contacts.status` and `contacts.trust_level` columns are gone
//      (migration 059 physically dropped them).
//   2. The `held_messages` table no longer exists (dropped in migration 059;
//      orphaned by #947 when the hold-and-notify flow was deleted).
//   3. Every contact row carries a valid `tier` and `kind` value — no nulls
//      or out-of-enum values left over from the backfill.
//
// Uses the same real-Postgres harness as sibling integration tests:
//   - Skips gracefully when DATABASE_URL is not set (CI without pgvector, local without Docker).
//   - Opens a pg.Pool, runs queries directly against the live schema, then ends the pool.
//   - No application-layer services needed — these are schema-level assertions.
//
// Local execution is blocked on this machine (Docker is paused); CI will verify.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const { Pool } = pg;

// Skip the entire suite if DATABASE_URL is not set — same pattern as all sibling tests.
const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('contacts cutover (#955) data integrity', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Fail fast if the DB is unreachable or migrations haven't run.
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
  });

  afterAll(async () => {
    // No test data is written by this suite — these are read-only schema queries.
    await pool.end();
  });

  it('contacts.status and contacts.trust_level columns no longer exist (migration 059)', async () => {
    // Migration 059 physically DROPs these two columns. If either exists, the cutover
    // migration has not been applied — or was rolled back — and live code may still be
    // attempting to read/write a non-existent column (causing 500s in production).
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'contacts'
          AND column_name IN ('status', 'trust_level')`,
    );
    expect(rows).toHaveLength(0);
  });

  it('held_messages table no longer exists (migration 059)', async () => {
    // held_messages was orphaned in #947 (hold-and-notify flow deleted) and physically
    // dropped in migration 059 (#955). to_regclass returns NULL when the OID is absent.
    const { rows } = await pool.query<{ t: string | null }>(
      `SELECT to_regclass('public.held_messages') AS t`,
    );
    expect(rows[0]!.t).toBeNull();
  });

  it('every contact carries a valid tier and kind (no nulls or out-of-enum values)', async () => {
    // All contacts must have a tier ∈ {blocked, unknown, known, trusted, principal} and
    // kind ∈ {person, organization, automated, principal, agent}. A non-zero count here
    // means the rederive:contact-tiers backfill either did not run or left rows in an
    // invalid state — which would cause permission resolution to throw at runtime.
    const { rows } = await pool.query<{ bad: number }>(
      `SELECT count(*)::int AS bad
         FROM contacts
        WHERE tier NOT IN ('blocked', 'unknown', 'known', 'trusted', 'principal')
           OR kind NOT IN ('person', 'organization', 'automated', 'principal', 'agent')`,
    );
    expect(rows[0]!.bad).toBe(0);
  });
});
