// AuditLogRepo.findToolResultsForTasks (#2159) — the band brief's evidence read.
//
// tool.result rows are children of their tool.invoke, which is the child of the agent.task
// (runtime.ts), so the read walks two levels. Newest first, so a limit keeps the lookups
// closest to the send.
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { AuditLogRepo } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

function makeRepo(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { repo: new AuditLogRepo({ query } as unknown as Pool, createSilentLogger()), query };
}

describe('AuditLogRepo.findToolResultsForTasks', () => {
  it('reads results under the tasks\' invokes, newest first, parameterized', async () => {
    const { repo, query } = makeRepo([]);

    await repo.findToolResultsForTasks(['task-1', 'task-2'], 50);

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toMatch(/event_type = ANY\(ARRAY\['tool\.result', 'skill\.result'\]::text\[\]\)/);
    expect(sql).toMatch(/SELECT id::text FROM audit_log\s+WHERE parent_event_id = ANY\(\$1::text\[\]\)\s+AND event_type = ANY\(ARRAY\['tool\.invoke', 'skill\.invoke'\]::text\[\]\)/);
    expect(sql).toMatch(/ORDER BY timestamp DESC, id DESC/);
    expect(params).toEqual([['task-1', 'task-2'], 50]);
  });

  it('does not query for no tasks', async () => {
    const { repo, query } = makeRepo([]);
    await expect(repo.findToolResultsForTasks([], 50)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('clamps the limit', async () => {
    const { repo, query } = makeRepo([]);
    await repo.findToolResultsForTasks(['t'], 100_000);
    expect(query.mock.calls[0]![1]).toEqual([['t'], 500]);
  });
});
