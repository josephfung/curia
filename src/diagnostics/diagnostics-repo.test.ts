// src/diagnostics/diagnostics-repo.test.ts

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { DiagnosticsRepo } from './diagnostics-repo.js';
import { createSilentLogger } from '../logger.js';

interface Captured {
  text: string;
  params: unknown[];
}

function repoWithRows(rows: Array<Record<string, unknown>>): { repo: DiagnosticsRepo; calls: Captured[] } {
  const calls: Captured[] = [];
  const query = vi.fn(async (text: string, params: unknown[]) => {
    calls.push({ text, params });
    return { rows };
  });
  const pool = { query } as unknown as Pool;
  return { repo: new DiagnosticsRepo(pool, createSilentLogger()), calls };
}

describe('DiagnosticsRepo', () => {
  it('getScheduledJobs filters by task_id with a bound parameter and maps to camelCase', async () => {
    const { repo, calls } = repoWithRows([
      {
        id: 'job-1', agent_id: 'coordinator', source_agent_id: null, task_id: 'task-b4j3',
        cron_expr: '0 8 * * *', run_at: null, next_run_at: '2026-07-07T08:00:00.000Z',
        last_run_at: null, run_started_at: null, status: 'pending', last_run_outcome: null,
        last_run_summary: null, last_error: null, consecutive_failures: 0, created_by: 'system',
        created_at: '2026-07-07T07:00:00.000Z', task_payload: { kind: 'wake' },
      },
    ]);

    const jobs = await repo.getScheduledJobs({ taskId: 'task-b4j3' });
    expect(calls[0]!.text).toContain('FROM scheduled_jobs');
    expect(calls[0]!.text).toContain('task_id = $1');
    expect(calls[0]!.params).toContain('task-b4j3');
    expect(jobs[0]).toMatchObject({ id: 'job-1', taskId: 'task-b4j3', status: 'pending' });
    expect(jobs[0]!.nextRunAt).toBeInstanceOf(Date);
  });

  it('getOutboundContext returns released/expired rows too (no active-only filter) and surfaces `expired`', async () => {
    const { repo, calls } = repoWithRows([
      {
        id: 'oc-1', conversation_id: 'conv-1', channel_id: 'signal', agent_id: 'coordinator',
        content_preview: 'hi', expected_reply: null, delegation_hint: '', metadata: {},
        released: true, created_at: '2026-07-07T08:00:00.000Z', expires_at: '2026-07-07T09:00:00.000Z',
        expired: true,
      },
    ]);

    const rows = await repo.getOutboundContext({ conversationId: 'conv-1' });
    // The diagnostic value is in released/expired rows, so the query must NOT exclude them.
    expect(calls[0]!.text).not.toContain('released = false');
    expect(calls[0]!.text).not.toContain('expires_at > now()');
    expect(rows[0]).toMatchObject({ id: 'oc-1', released: true, expired: true, delegationHint: '' });
  });

  it('getWorkingMemory includes archived rows (no archived filter) for post-hoc reads', async () => {
    const { repo, calls } = repoWithRows([
      {
        id: 'wm-1', conversation_id: 'conv-1', agent_id: 'coordinator', role: 'assistant',
        content: 'scratch', archived: true, created_at: '2026-07-07T08:00:00.000Z', expires_at: null,
      },
    ]);

    const rows = await repo.getWorkingMemory({ conversationId: 'conv-1' });
    expect(calls[0]!.text).not.toContain('archived = false');
    expect(rows[0]).toMatchObject({ id: 'wm-1', archived: true, role: 'assistant' });
  });

  it('getActionLog matches an id via id::text so a numeric bigserial id resolves', async () => {
    const { repo, calls } = repoWithRows([]);
    await repo.getActionLog({ id: '42' });
    expect(calls[0]!.text).toContain('id::text = $1');
    expect(calls[0]!.params).toContain('42');
  });
});
