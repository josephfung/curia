// handler.test.ts — unit tests for deny-action skill.

import { describe, it, expect, vi } from 'vitest';
import { DenyActionHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import { createSilentLogger } from '../../src/logger.js';

const PENDING_ROW = {
  id: 10,
  taskId: 't1',
  conversationId: 'conv-1',
  skillName: 'calendar-create-event',
  actionRisk: 'high',
  outcome: 'pending_approval' as const,
  shortRef: 'cal-1',
  description: 'Create calendar event: Lunch',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
  payload: { title: 'Lunch' },
  taskSummary: null,
  competenceFlag: null,
  commitmentFlag: null,
  compatibility: null,
  scoredBy: null,
  notificationSentAt: null,
  resolvedAt: null,
  resolvedBy: null,
  parentActionId: null,
};

function makeCtx(overrides?: Partial<SkillContext>): SkillContext {
  return {
    input: { short_ref: 'cal-1' },
    secret: (name: string) => { throw new Error(`secret '${name}' not configured in test`); },
    log: createSilentLogger(),
    taskMetadata: { ceoInitiated: true, senderId: 'ceo-1', channelId: 'cli' },
    taskEventId: 'task-1',
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    resolvePending: vi.fn().mockResolvedValue({ found: true, row: PENDING_ROW }),
    resolveRow: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
}

describe('DenyActionHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ taskMetadata: {} }));
    expect(result.success).toBe(false);
  });

  it('returns error when actionLogRepo is missing', async () => {
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns error when bus is missing', async () => {
    const repo = makeMockRepo();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus: undefined }));
    expect(result.success).toBe(false);
  });

  it('denies a pending row and publishes human.decision', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    expect(result.success).toBe(true);
    expect(repo.resolveRow).toHaveBeenCalledWith(10, 'denied', 'ceo');
    expect(bus.publish).toHaveBeenCalledOnce();
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(event.type).toBe('human.decision');
    expect(event.payload.decision).toBe('deny');
  });

  it('returns error when resolveRow returns false (concurrent resolve)', async () => {
    const repo = makeMockRepo({
      resolveRow: vi.fn().mockResolvedValue(false),
    });
    const bus = makeMockBus();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('already resolved'));
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('forwards resolvePending errors', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: false, reason: 'not_found', error: 'No approval request found',
      }),
    });
    const bus = makeMockBus();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', 'No approval request found');
  });

  it('resolves sole pending row when short_ref is omitted', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ input: {}, actionLogRepo: repo, bus }));
    expect(result.success).toBe(true);
    expect(repo.resolvePending).toHaveBeenCalledWith(undefined);
  });
});
