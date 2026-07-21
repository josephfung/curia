// skills/ops-lookup/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { OpsLookupHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type {
  DiagnosticsRepo,
  ScheduledJobRow,
  WorkingMemoryRow,
  OutboundContextRow,
} from '../../../../src/diagnostics/diagnostics-repo.js';
import { createSilentLogger } from '../../../../src/logger.js';

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    input: {},
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    timezone: 'America/New_York',
    ...overrides,
  } as ToolContext;
}

function job(id: string, nextRunIso: string): ScheduledJobRow {
  return {
    id,
    agentId: 'coordinator',
    sourceAgentId: null,
    taskId: 'task-b4j3',
    cronExpr: '0 8 * * *',
    runAt: null,
    nextRunAt: new Date(nextRunIso),
    lastRunAt: null,
    runStartedAt: null,
    status: 'pending',
    lastRunOutcome: null,
    lastRunSummary: null,
    lastError: null,
    consecutiveFailures: 0,
    createdBy: 'system',
    createdAt: new Date('2026-07-07T07:00:00.000Z'),
    taskPayload: {},
  };
}

describe('OpsLookupHandler', () => {
  it('errors without diagnosticsRepo', async () => {
    const result = await new OpsLookupHandler().execute(makeCtx({ diagnosticsRepo: undefined, input: { source: 'scheduled_jobs' } }));
    expect(result.success).toBe(false);
  });

  it('rejects an unknown source', async () => {
    const repo = {} as unknown as DiagnosticsRepo;
    const result = await new OpsLookupHandler().execute(makeCtx({ diagnosticsRepo: repo, input: { source: 'nope' } }));
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/source must be one of/);
  });

  // Cross-table correlation: two duplicate scheduled_jobs for one task is the
  // scheduler-double-fire signal an investigator correlates with two audit events.
  it('surfaces the duplicate scheduled_jobs behind a double-fire', async () => {
    const getScheduledJobs = vi.fn().mockResolvedValue([
      job('job-a', '2026-07-07T08:00:00.000Z'),
      job('job-b', '2026-07-07T08:00:00.000Z'),
    ]);
    const repo = { getScheduledJobs } as unknown as DiagnosticsRepo;
    const result = await new OpsLookupHandler().execute(makeCtx({
      diagnosticsRepo: repo,
      input: { source: 'scheduled_jobs', task_id: 'task-b4j3' },
    }));

    expect(getScheduledJobs).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-b4j3' }));
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { rows: Array<Record<string, unknown>>; count: number; available: boolean } }).data;
    expect(data.count).toBe(2);
    expect(data.available).toBe(true);
    expect(data.rows.map((r) => r.id)).toEqual(['job-a', 'job-b']);
    expect(data.rows[0]!.next_run_at).toBe(data.rows[1]!.next_run_at); // same fire time
  });

  it('reports available:false when a source returns nothing for the scope', async () => {
    const repo = { getOutboundContext: vi.fn().mockResolvedValue([] as OutboundContextRow[]) } as unknown as DiagnosticsRepo;
    const result = await new OpsLookupHandler().execute(makeCtx({
      diagnosticsRepo: repo,
      input: { source: 'outbound_context', conversation_id: 'conv-x' },
    }));
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { available: boolean; count: number } }).data;
    expect(data.available).toBe(false);
    expect(data.count).toBe(0);
  });

  it('scrubs and truncates working_memory.content', async () => {
    const longContent = `reasoning for alice@example.com: ${'x'.repeat(800)}`;
    const turn: WorkingMemoryRow = {
      id: 'wm-1',
      conversationId: 'conv-1',
      agentId: 'coordinator',
      role: 'assistant',
      content: longContent,
      archived: false,
      createdAt: new Date('2026-07-07T08:00:00.000Z'),
      expiresAt: null,
    };
    const repo = { getWorkingMemory: vi.fn().mockResolvedValue([turn]) } as unknown as DiagnosticsRepo;
    const result = await new OpsLookupHandler().execute(makeCtx({
      diagnosticsRepo: repo,
      input: { source: 'working_memory', conversation_id: 'conv-1' },
    }));

    expect(result.success).toBe(true);
    const content = (result as { success: true; data: { rows: Array<{ content: string }> } }).data.rows[0]!.content;
    expect(content).not.toContain('alice@example.com');
    expect(content).toMatch(/truncated \d+ chars/);
    expect(content.length).toBeLessThan(longContent.length);
  });

  it('rejects a malformed since timestamp', async () => {
    const repo = { getActionLog: vi.fn() } as unknown as DiagnosticsRepo;
    const result = await new OpsLookupHandler().execute(makeCtx({
      diagnosticsRepo: repo,
      input: { source: 'action_log', since: 'this morning' },
    }));
    expect(result.success).toBe(false);
  });
});
