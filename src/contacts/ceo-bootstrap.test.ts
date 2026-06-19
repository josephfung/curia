// src/contacts/ceo-bootstrap.test.ts
//
// Unit tests for bootstrapCeoContact.
//
// Strategy: mock pool/client to run without Docker/Postgres.
// Assertions focus on:
//   1. No `status` or `trust_level` writes in any SQL.
//   2. The "already confirmed" gate uses tier='principal', not status='confirmed'.
//   3. No UPDATE contacts SET status=... anywhere.

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import { bootstrapCeoContact } from './ceo-bootstrap.js';
import type { Logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  fatal: vi.fn(),
  silent: vi.fn(),
  level: 'info',
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Pool/client factory helpers
// ---------------------------------------------------------------------------

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

interface MockClient {
  query: MockedFunction<QueryFn>;
  release: MockedFunction<() => void>;
}

function makeClient(): MockClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Scenario 1: No existing contact → fresh INSERT path
// ---------------------------------------------------------------------------

describe('bootstrapCeoContact: fresh INSERT path', () => {
  it('INSERT does NOT write status or trust_level', async () => {
    const client = makeClient();
    // BEGIN, INSERT contacts, INSERT cci, COMMIT
    client.query.mockResolvedValue({ rows: [] });

    const pool = {
      // First call: SELECT (existing check) → no rows
      // Second call: INSERT kg_nodes → returns id
      // Then pool.connect() gives client
      query: vi.fn<QueryFn>()
        .mockResolvedValueOnce({ rows: [] }) // existing SELECT → no rows
        .mockResolvedValueOnce({ rows: [{ id: 'kg-node-new' }] }) // insertKgPersonNode
      ,
      connect: vi.fn().mockResolvedValue(client),
    };

    await bootstrapCeoContact('ceo@example.com', 'CEO', pool as never, mockLogger);

    // Collect all SQL from both pool.query and client.query
    const allSql = [
      ...pool.query.mock.calls.map((c) => (c[0] as string).toLowerCase()),
      ...client.query.mock.calls.map((c) => (c[0] as string).toLowerCase()),
    ];

    for (const sql of allSql) {
      // No writes of legacy columns
      if (sql.includes('insert') || sql.includes('update')) {
        expect(sql, `Write SQL should not reference status: ${sql}`).not.toMatch(/\bstatus\b/);
        expect(sql, `Write SQL should not reference trust_level: ${sql}`).not.toContain('trust_level');
      }
    }
  });

  it('INSERT sets tier=principal, kind=principal, system_role=principal', async () => {
    const client = makeClient();
    client.query.mockResolvedValue({ rows: [] });

    const pool = {
      query: vi.fn<QueryFn>()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'kg-node-new' }] }),
      connect: vi.fn().mockResolvedValue(client),
    };

    await bootstrapCeoContact('ceo@example.com', 'CEO', pool as never, mockLogger);

    const insertCall = client.query.mock.calls.find(
      (c) => (c[0] as string).toLowerCase().includes('insert into contacts'),
    );
    expect(insertCall, 'Should have executed INSERT INTO contacts').toBeDefined();

    const insertSql = (insertCall![0] as string).toLowerCase();
    expect(insertSql).toContain('tier');
    expect(insertSql).toContain('kind');
    expect(insertSql).toContain('system_role');
    expect(insertSql).toContain("'principal'");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Existing contact already at tier='principal' + identity verified
// ---------------------------------------------------------------------------

describe('bootstrapCeoContact: existing contact already at principal tier', () => {
  it('returns early without writing status', async () => {
    const existingRow = {
      contact_id: 'contact-abc',
      contact_tier: 'principal',
      identity_verified: true,
      kg_node_id: 'kg-node-abc',
      display_name: 'CEO',
    };

    const pool = {
      query: vi.fn<QueryFn>()
        // SELECT existing
        .mockResolvedValueOnce({ rows: [existingRow] })
        // repairPrincipalMetadata UPDATE (no-op when already correct)
        .mockResolvedValueOnce({ rows: [] }),
      connect: vi.fn(),
    };

    const result = await bootstrapCeoContact('ceo@example.com', 'CEO', pool as never, mockLogger);

    expect(result.alreadyExisted).toBe(true);
    expect(result.contactId).toBe('contact-abc');

    // No status writes should have occurred
    const allSql = pool.query.mock.calls.map((c) => (c[0] as string).toLowerCase());
    for (const sql of allSql) {
      if (sql.includes('update') || sql.includes('insert')) {
        expect(sql, `Write SQL should not reference status: ${sql}`).not.toMatch(/set\s+status/);
      }
    }
  });

  it('does NOT call pool.connect() (no transaction needed)', async () => {
    const existingRow = {
      contact_id: 'contact-abc',
      contact_tier: 'principal',
      identity_verified: true,
      kg_node_id: 'kg-node-abc',
      display_name: 'CEO',
    };

    const pool = {
      query: vi.fn<QueryFn>()
        .mockResolvedValueOnce({ rows: [existingRow] })
        .mockResolvedValueOnce({ rows: [] }),
      connect: vi.fn(),
    };

    await bootstrapCeoContact('ceo@example.com', 'CEO', pool as never, mockLogger);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Existing contact at lower tier (needs promotion)
// ---------------------------------------------------------------------------

describe('bootstrapCeoContact: existing contact needs promotion', () => {
  it('does NOT write SET status=confirmed when promoting', async () => {
    // Contact exists but at tier='unknown' (not yet principal)
    const existingRow = {
      contact_id: 'contact-xyz',
      contact_tier: 'unknown',
      identity_verified: false,
      kg_node_id: 'kg-node-xyz',
      display_name: 'CEO',
    };

    const pool = {
      query: vi.fn<QueryFn>()
        .mockResolvedValueOnce({ rows: [existingRow] }) // SELECT existing
        .mockResolvedValueOnce({ rows: [] })            // repairPrincipalMetadata (sets tier='principal')
        .mockResolvedValueOnce({ rows: [] })            // UPDATE contact_channel_identities (verified)
      ,
      connect: vi.fn(),
    };

    await bootstrapCeoContact('ceo@example.com', 'CEO', pool as never, mockLogger);

    const allSql = pool.query.mock.calls.map((c) => (c[0] as string).toLowerCase());
    for (const sql of allSql) {
      if (sql.includes('update') || sql.includes('insert')) {
        expect(sql, `Write SQL should not write status: ${sql}`).not.toMatch(/set\s+status/);
        expect(sql, `Write SQL should not reference trust_level: ${sql}`).not.toContain('trust_level');
      }
    }
  });
});
