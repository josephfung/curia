// handler.test.ts — unit tests for dismiss-action skill.

import { describe, it, expect, vi } from 'vitest';
import { DismissActionHandler } from './handler.js';
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
    taskMetadata: {
      originator: {
        contactId: 'ceo-1',
        systemRole: 'principal' as const,
        channel: 'email',
        initiatedAt: new Date().toISOString(),
      },
    },
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

describe('DismissActionHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ taskMetadata: {} }));
    expect(result.success).toBe(false);
  });

  it('returns error when actionLogRepo is missing', async () => {
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: undefined }));
    expect(result.success).toBe(false);
  });

  it('returns error when bus is missing', async () => {
    const repo = makeMockRepo();
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus: undefined }));
    expect(result.success).toBe(false);
  });

  it('dismisses a pending row with resolved_externally', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    expect(result.success).toBe(true);
    expect(repo.resolveRow).toHaveBeenCalledWith(10, 'resolved_externally', 'ceo');
  });

  it('publishes human.decision with dismiss decision type', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    expect(bus.publish).toHaveBeenCalledOnce();
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(event.type).toBe('human.decision');
    expect(event.payload.decision).toBe('dismiss');
    expect(event.payload.deciderId).toBe('ceo-1');
    expect(event.payload.deciderChannel).toBe('email');
  });

  it('skips human.decision and logs error when originator contact/channel is absent', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handler = new DismissActionHandler();

    const result = await handler.execute(makeCtx({
      log: mockLog,
      taskMetadata: {
        originator: { systemRole: 'principal' as const, initiatedAt: new Date().toISOString() },
      },
      actionLogRepo: repo,
      bus,
    }));

    expect(result.success).toBe(true);
    expect(bus.publish).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('returns error when resolveRow returns false (concurrent resolve)', async () => {
    const repo = makeMockRepo({
      resolveRow: vi.fn().mockResolvedValue(false),
    });
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));

    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('already resolved'));
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('forwards resolvePending errors', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: false, reason: 'expired', error: 'Request has expired',
      }),
    });
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ actionLogRepo: repo, bus }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', 'Request has expired');
  });

  it('resolves sole pending row when short_ref is omitted', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new DismissActionHandler();
    const result = await handler.execute(makeCtx({ input: {}, actionLogRepo: repo, bus }));
    expect(result.success).toBe(true);
    expect(repo.resolvePending).toHaveBeenCalledWith(undefined);
  });
});
