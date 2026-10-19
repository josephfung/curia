// handler.test.ts — unit tests for deny-action skill.

import { describe, it, expect, vi } from 'vitest';
import { DenyActionHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { ActionLogRepo } from '../../../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { Logger } from '../../../../src/logger.js';

const PENDING_ROW = {
  id: 10,
  taskId: 't1',
  conversationId: 'conv-1',
  toolName: 'calendar-create-event',
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

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
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
  } as ToolContext;
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
  // #1126: authorization is enforced solely by the execution-layer live-principal gate
  // (covered in tests/unit/skills/execution.policy.test.ts); the handler no longer re-checks origination.

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
    expect(repo.resolveRow).toHaveBeenCalledWith(10, 'denied', 'coordinator');
    expect(bus.publish).toHaveBeenCalledOnce();
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(event.type).toBe('human.decision');
    expect(event.payload.decision).toBe('deny');
    expect(event.payload.deciderId).toBe('ceo-1');
    expect(event.payload.deciderChannel).toBe('email');
  });

  it('skips human.decision and logs error when originator contact/channel is absent', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handler = new DenyActionHandler();

    const result = await handler.execute(makeCtx({
      log: mockLog as unknown as Logger,
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

  // #2159 Phase 3: "deny 3" passes the approval number through short_ref; resolvePending
  // resolves it to the one live row carrying that number.
  it('denies the row numbered 3 when short_ref is "3"', async () => {
    const numbered = { ...PENDING_ROW, id: 33, shortRef: 'a3f7c12b', approvalNumber: 3 };
    const repo = makeMockRepo({ resolvePending: vi.fn().mockResolvedValue({ found: true, row: numbered }) });
    const handler = new DenyActionHandler();
    const result = await handler.execute(makeCtx({ input: { short_ref: ' 3 ' }, actionLogRepo: repo, bus: makeMockBus() }));
    expect(result.success).toBe(true);
    expect(repo.resolvePending).toHaveBeenCalledWith('3');
    expect(repo.resolveRow).toHaveBeenCalledWith(33, 'denied', 'coordinator');
  });

  // Review fix F1 (#2159 Phase 3): a model may relay "approve 3" as the JSON number 3. Reading
  // only strings dropped it to undefined, and resolvePending(undefined) then picked the SOLE
  // pending approval, which could be a different one. A present short_ref must never fall back.
  describe('short_ref input handling', () => {
    const SOLE = { ...PENDING_ROW, id: 50, shortRef: 'b5e1d9a0', approvalNumber: 5 };
    const NUMBERED = { ...PENDING_ROW, id: 33, shortRef: 'a3f7c12b', approvalNumber: 3 };
    // resolvePending stand-in: no ref means "the sole pending row", '3' means approval 3.
    function routingRepo(): ActionLogRepo {
      return makeMockRepo({
        resolvePending: vi.fn().mockImplementation(async (ref?: string) => {
          if (ref === undefined) return { found: true, row: SOLE };
          if (ref === '3') return { found: true, row: NUMBERED };
          return { found: false, reason: 'not_found', error: `No approval request found with number ${ref}` };
        }),
      });
    }

    it('resolves a numeric short_ref (3) to approval 3, not the sole pending row', async () => {
      const repo = routingRepo();
      const result = await new DenyActionHandler().execute(makeCtx({
        input: { short_ref: 3 }, actionLogRepo: repo, bus: makeMockBus(),
      }));
      expect(result.success).toBe(true);
      expect(repo.resolvePending).toHaveBeenCalledWith('3');
      expect(repo.resolveRow).toHaveBeenCalledWith(33, 'denied', 'coordinator');
    });

    it.each([
      ['an empty string', ''],
      ['whitespace', '   '],
      ['an object', {}],
      ['a boolean', true],
      ['a negative number', -1],
      ['a fractional number', 2.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('fails closed on %s, resolving nothing', async (_label, shortRef) => {
      const repo = routingRepo();
      const result = await new DenyActionHandler().execute(makeCtx({
        input: { short_ref: shortRef }, actionLogRepo: repo, bus: makeMockBus(),
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/short_ref/);
      expect(repo.resolvePending).not.toHaveBeenCalled();
      expect(repo.resolveRow).not.toHaveBeenCalled();
    });

    it('falls back to the sole pending row only when short_ref is null', async () => {
      const repo = routingRepo();
      const result = await new DenyActionHandler().execute(makeCtx({
        input: { short_ref: null }, actionLogRepo: repo, bus: makeMockBus(),
      }));
      expect(result.success).toBe(true);
      expect(repo.resolvePending).toHaveBeenCalledWith(undefined);
      expect(repo.resolveRow).toHaveBeenCalledWith(50, 'denied', 'coordinator');
    });
  });

  // Review fix F5 (#2159 Phase 3): the confirmation names the approval the way the principal saw
  // it: "Approval 3" when the row has a number, the short_ref only for rows without one.
  describe('confirmation label', () => {
    it('names a numbered approval as "Approval N"', async () => {
      const numbered = { ...PENDING_ROW, id: 33, shortRef: 'a3f7c12b', approvalNumber: 3 };
      const repo = makeMockRepo({ resolvePending: vi.fn().mockResolvedValue({ found: true, row: numbered }) });
      const result = await new DenyActionHandler().execute(makeCtx({
        input: { short_ref: '3' }, actionLogRepo: repo, bus: makeMockBus(),
      }));
      expect(result.success).toBe(true);
      expect((result as { data: string }).data).toBe('Denied: Create calendar event: Lunch (Approval 3)');
    });

    it('names an unnumbered approval by its reference', async () => {
      const repo = makeMockRepo({ resolvePending: vi.fn().mockResolvedValue({ found: true, row: { ...PENDING_ROW, approvalNumber: null } }) });
      const result = await new DenyActionHandler().execute(makeCtx({
        actionLogRepo: repo, bus: makeMockBus(),
      }));
      expect(result.success).toBe(true);
      expect((result as { data: string }).data).toBe('Denied: Create calendar event: Lunch (cal-1)');
    });

    it('names a numbered approval as "Approval N" when it was already resolved', async () => {
      const numbered = { ...PENDING_ROW, id: 33, shortRef: 'a3f7c12b', approvalNumber: 3 };
      const repo = makeMockRepo({
        resolvePending: vi.fn().mockResolvedValue({ found: true, row: numbered }),
        resolveRow: vi.fn().mockResolvedValue(false),
      });
      const result = await new DenyActionHandler().execute(makeCtx({
        input: { short_ref: '3' }, actionLogRepo: repo, bus: makeMockBus(),
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Approval 3');
        expect(result.error).not.toContain('a3f7c12b');
      }
    });
  });
});
