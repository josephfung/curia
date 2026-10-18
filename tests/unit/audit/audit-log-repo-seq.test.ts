// AuditLogRepo seq-keyed reads (#2159) — the report queue's cursor.
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { AuditLogRepo } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

function dbRow(id: string, seq: string) {
  return {
    id, seq, timestamp: '2026-10-18T09:00:00.000Z', event_type: 'principal.report', source_layer: 'dispatch',
    source_id: 'dispatch', conversation_id: null, task_id: null, parent_event_id: 't', payload: { summary: 'x' },
    action: null, outcome: null, target_type: null, target_id: null, initiator_type: null, initiator_id: null, entry_hash: null,
  };
}

function makeRepo(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { repo: new AuditLogRepo({ query } as unknown as Pool, createSilentLogger()), query };
}

describe('AuditLogRepo.findByEventTypeAfterSeq', () => {
  it('reads strictly after the seq, in seq order, parameterized, one extra row for hasMore', async () => {
    const { repo, query } = makeRepo([dbRow('a', '11'), dbRow('b', '12'), dbRow('c', '13')]);

    const page = await repo.findByEventTypeAfterSeq('principal.report', '10', 2);

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/seq > \$2::bigint/);
    expect(sql).toMatch(/ORDER BY seq ASC/);
    expect(params).toEqual(['principal.report', '10', 3]);
    expect(page.rows.map((r) => [r.seq, r.row.id])).toEqual([['11', 'a'], ['12', 'b']]);
    expect(page.hasMore).toBe(true);
  });

  it('reads from the start when there is no seq', async () => {
    const { repo, query } = makeRepo([]);

    const page = await repo.findByEventTypeAfterSeq('principal.report', null, 5);

    expect(query.mock.calls[0]![1]).toEqual(['principal.report', null, 6]);
    expect(page).toEqual({ rows: [], hasMore: false });
  });
});

describe('AuditLogRepo.hasEventAtSeq', () => {
  it('is true only when a row of that type has that seq', async () => {
    const yes = makeRepo([{ exists: true }]);
    await expect(yes.repo.hasEventAtSeq('principal.report', '12')).resolves.toBe(true);
    expect(yes.query.mock.calls[0]![1]).toEqual(['principal.report', '12']);

    const no = makeRepo([]);
    await expect(no.repo.hasEventAtSeq('principal.report', '99')).resolves.toBe(false);
  });
});
