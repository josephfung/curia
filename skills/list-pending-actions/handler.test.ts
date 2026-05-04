// handler.test.ts — unit tests for list-pending-actions skill.

import { describe, it, expect, vi } from 'vitest';
import { ListPendingActionsHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: {},
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    taskMetadata: { ceoInitiated: true, senderId: 'ceo-1', channelId: 'cli' },
    taskEventId: 'task-1',
    timezone: 'UTC',
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    findAllPending: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ActionLogRepo;
}

describe('ListPendingActionsHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ taskMetadata: {} }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
  });

  it('returns error when actionLogRepo is not available', async () => {
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns empty list with message when no pending rows', async () => {
    const repo = makeMockRepo();
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo }));
    expect(result.success).toBe(true);
    expect(result).toHaveProperty('data');
    const data = (result as { success: true; data: unknown }).data as { pending: unknown[]; message: string; displayTimezone?: string };
    expect(data.pending).toEqual([]);
    expect(data.message).toContain('No pending');
    // displayTimezone should be present when timezone is set
    expect(data.displayTimezone).toBeDefined();
  });

  it('returns pending rows mapped to summary fields', async () => {
    const now = new Date();
    const expires = new Date(Date.now() + 86_400_000);
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockResolvedValue([
        {
          id: 1, shortRef: 'cal-1', description: 'Create calendar event: Lunch',
          skillName: 'calendar-create-event', createdAt: now, expiresAt: expires,
        },
        {
          id: 2, shortRef: 'email-1', description: 'Send email reply: Re: Budget',
          skillName: 'email-reply', createdAt: now, expiresAt: expires,
        },
      ]),
    });
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, timezone: 'UTC' }));
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: unknown }).data as { pending: Array<Record<string, unknown>>; displayTimezone?: string };
    expect(data.pending).toHaveLength(2);
    expect(data.pending[0]).toMatchObject({
      short_ref: 'cal-1',
      description: 'Create calendar event: Lunch',
      skill_name: 'calendar-create-event',
    });
    // Timestamps should be localized ISO strings (not raw UTC Z-suffix)
    expect(data.pending[0]!.created_at).toBeDefined();
    expect(data.pending[0]!.expires_at).toBeDefined();
    // displayTimezone should be present
    expect(data.displayTimezone).toBe('UTC');
  });

  it('returns SkillResult error when findAllPending throws', async () => {
    const repo = makeMockRepo({
      findAllPending: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });
    const handler = new ListPendingActionsHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('Unable to list'));
  });
});
