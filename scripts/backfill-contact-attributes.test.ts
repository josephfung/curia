import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { runBackfill } from './backfill-contact-attributes.js';

// A minimal pool mock: query() returns different results based on which call it is.
function makeMockPool(queryResponses: Array<{ rows: Record<string, unknown>[] }>): Pool {
  let callIndex = 0;
  return {
    query: vi.fn(() => {
      const response = queryResponses[callIndex++] ?? { rows: [] };
      return Promise.resolve(response);
    }),
  } as unknown as Pool;
}

describe('runBackfill', () => {
  it('skips contacts with no kg_node_id', async () => {
    const pool = makeMockPool([
      // contacts query: returns one contact with null kg_node_id
      { rows: [{ id: 'c1', kg_node_id: null, system_role: null }] },
    ]);

    const result = await runBackfill(pool);
    expect(result.processed).toBe(0);
    expect(result.columnsWritten).toBe(0);
  });

  it('populates columns from matching KG fact nodes', async () => {
    const updateMock = vi.fn().mockResolvedValue({ rows: [] });
    const pool = {
      query: vi.fn()
        // Call 1: contacts with kg_node_id
        .mockResolvedValueOnce({
          rows: [{ id: 'c1', kg_node_id: 'kg1', system_role: null,
                   preferred_name: null, title: null, organization: null,
                   primary_email: null, primary_phone: null, timezone: null,
                   locale: null, location: null, pronouns: null,
                   linkedin_url: null, bio: null, birthday: null }],
        })
        // Call 2: fact nodes for this contact
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'job_title', value: 'CTO' }, confidence: 0.9, last_confirmed_at: '2026-01-01' },
            { id: 'f2', properties: { attribute: 'organization', value: 'Acme' }, confidence: 0.8, last_confirmed_at: '2026-01-01' },
          ],
        })
        // Call 3: UPDATE contacts
        .mockImplementation(updateMock),
    } as unknown as Pool;

    const result = await runBackfill(pool);
    expect(result.processed).toBe(1);
    expect(result.columnsWritten).toBeGreaterThan(0);

    // Verify the UPDATE was called with expected values
    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2]!;
    const sql = updateCall[0] as string;
    const params = updateCall[1] as unknown[];
    expect(sql).toContain('UPDATE contacts SET');
    // title = 'CTO' should be in the params
    expect(params).toContain('CTO');
    // organization = 'Acme' should be in the params
    expect(params).toContain('Acme');
  });

  it('prefers higher confidence when two facts target same column', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: 'c1', kg_node_id: 'kg1', system_role: null,
                   preferred_name: null, title: null, organization: null,
                   primary_email: null, primary_phone: null, timezone: null,
                   locale: null, location: null, pronouns: null,
                   linkedin_url: null, bio: null, birthday: null }],
        })
        .mockResolvedValueOnce({
          rows: [
            // Two facts for title — higher confidence wins
            { id: 'f1', properties: { attribute: 'title', value: 'VP' }, confidence: 0.7, last_confirmed_at: '2025-12-01' },
            { id: 'f2', properties: { attribute: 'title', value: 'CTO' }, confidence: 0.95, last_confirmed_at: '2025-11-01' },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2]!;
    const params = updateCall[1] as unknown[];
    expect(params).toContain('CTO');
    expect(params).not.toContain('VP');
  });

  it('uses last_confirmed_at as tiebreaker when confidence is equal', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: 'c1', kg_node_id: 'kg1', system_role: null,
                   preferred_name: null, title: null, organization: null,
                   primary_email: null, primary_phone: null, timezone: null,
                   locale: null, location: null, pronouns: null,
                   linkedin_url: null, bio: null, birthday: null }],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'title', value: 'VP' }, confidence: 0.8, last_confirmed_at: '2025-06-01' },
            { id: 'f2', properties: { attribute: 'title', value: 'CTO' }, confidence: 0.8, last_confirmed_at: '2026-01-01' }, // more recent
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const updateCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls[2]!;
    const params = updateCall[1] as unknown[];
    expect(params).toContain('CTO'); // more recent wins
    expect(params).not.toContain('VP');
  });

  it('skips already-populated columns (idempotency)', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'c1', kg_node_id: 'kg1', system_role: null,
            preferred_name: null,
            title: 'Existing Title',  // already populated
            organization: null, primary_email: null, primary_phone: null,
            timezone: null, locale: null, location: null, pronouns: null,
            linkedin_url: null, bio: null, birthday: null,
          }],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'job_title', value: 'New Title' }, confidence: 0.99, last_confirmed_at: '2026-01-01' },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    // The UPDATE call should NOT include title since it was already populated.
    // If no columns change, no UPDATE is issued at all.
    const updateCall = calls.find(c => (c[0] as string).includes('UPDATE contacts SET'));
    if (updateCall) {
      const params = updateCall[1] as unknown[];
      expect(params).not.toContain('New Title');
    }
  });

  it('does not apply role KG fact to title when contact has a system_role', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            id: 'c1', kg_node_id: 'kg1',
            system_role: 'principal',  // has system_role — role fact should not apply to title
            preferred_name: null, title: null, organization: null,
            primary_email: null, primary_phone: null, timezone: null,
            locale: null, location: null, pronouns: null,
            linkedin_url: null, bio: null, birthday: null,
          }],
        })
        .mockResolvedValueOnce({
          rows: [
            { id: 'f1', properties: { attribute: 'role', value: 'Principal' }, confidence: 0.99, last_confirmed_at: '2026-01-01' },
          ],
        })
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await runBackfill(pool);

    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = calls.find(c => (c[0] as string).includes('UPDATE contacts SET'));
    // No update should be issued because the only fact was 'role' which is skipped
    // when system_role is set, and no other columns changed.
    expect(updateCall).toBeUndefined();
  });
});
