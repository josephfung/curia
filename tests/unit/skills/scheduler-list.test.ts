import { describe, it, expect, vi } from 'vitest';
import { SchedulerListHandler } from '../../../skills/scheduler-list/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('SchedulerListHandler', () => {
  const handler = new SchedulerListHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
  });

  it('lists all jobs when no filters provided', async () => {
    const mockJobs = [
      { id: 'job-1', agentId: 'coordinator', status: 'pending' },
      { id: 'job-2', agentId: 'research-analyst', status: 'completed' },
    ];
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue(mockJobs),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      {},
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { jobs: unknown[] };
      expect(data.jobs).toEqual(mockJobs);
    }

    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: undefined,
      agentId: undefined,
    });
  });

  it('passes status and agent_id filters to service', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([]),
      cancelJob: vi.fn(),
    };

    await handler.execute(makeCtx(
      { status: 'pending', agent_id: 'coordinator' },
      { schedulerService: schedulerService as never },
    ));

    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: 'pending',
      agentId: 'coordinator',
    });
  });

  it('returns failure when listJobs throws', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockRejectedValue(new Error('query failed')),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      {},
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('query failed');
    }
  });
});
