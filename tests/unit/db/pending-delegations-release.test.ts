// A failed delete must not leave a completed delegation for the sweep to re-deliver.

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { releaseRunningDelegation } from '../../../src/db/queries/pending-delegations.js';

function poolWith(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

describe('releaseRunningDelegation', () => {
  it('deletes a running claim', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1 }));
    await releaseRunningDelegation(poolWith(query), 'evt-1');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![0]).toContain('DELETE FROM pending_delegations');
  });

  it('marks the row delivered when the delete fails', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 0 }))
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ rowCount: 1 });
    await releaseRunningDelegation(poolWith(query), 'evt-1');
    const sql = query.mock.calls[1]![0];
    expect(sql).toContain("status = 'resolved'");
    expect(sql).toContain("resolution = 'delivered'");
    expect(query.mock.calls[1]![1]).toEqual(['evt-1']);
  });

  it('throws when the delete and the delivered mark both fail', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('still down'));
    await expect(releaseRunningDelegation(poolWith(query), 'evt-1')).rejects.toThrow(
      /marking it delivered failed/,
    );
  });
});
