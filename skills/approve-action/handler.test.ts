// handler.test.ts — unit tests for approve-action skill.

import { describe, it, expect, vi } from 'vitest';
import { ApproveActionHandler } from './handler.js';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { ExecutionLayer } from '../../src/skills/execution.js';
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
  payload: { title: 'Lunch with Dana' },
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
    caller: { contactId: 'ceo-1', role: 'ceo', channel: 'cli' },
    ...overrides,
  } as SkillContext;
}

function makeMockRepo(overrides?: Partial<ActionLogRepo>): ActionLogRepo {
  return {
    resolvePending: vi.fn().mockResolvedValue({ found: true, row: PENDING_ROW }),
    resolveRow: vi.fn().mockResolvedValue(true),
    insert: vi.fn().mockResolvedValue(99),
    ...overrides,
  } as unknown as ActionLogRepo;
}

function makeMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventBus;
}

function makeMockExecutionLayer(result?: SkillResult): ExecutionLayer {
  return {
    invoke: vi.fn().mockResolvedValue(result ?? { success: true, data: { event_id: 'evt-123' } }),
  } as unknown as ExecutionLayer;
}

describe('ApproveActionHandler', () => {
  it('rejects non-CEO callers', async () => {
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      taskMetadata: {},
      caller: { contactId: 'user-99', role: 'contact', channel: 'email' },
    }));
    expect(result.success).toBe(false);
  });

  it('returns error when executionLayer is missing', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: undefined,
    }));
    expect(result.success).toBe(false);
  });

  it('approves, re-executes, writes child row, publishes audit event', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const handler = new ApproveActionHandler();

    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));

    // Verify approval transition
    expect(repo.resolveRow).toHaveBeenCalledWith(10, 'approved', 'ceo');

    // Verify re-execution
    expect(execLayer.invoke).toHaveBeenCalledOnce();
    const invokeArgs = (execLayer.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(invokeArgs[0]).toBe('calendar-create-event'); // skillName
    expect(invokeArgs[1]).toEqual({ title: 'Lunch with Dana' }); // payload
    expect(invokeArgs[3]).toMatchObject({ humanApproved: true }); // options

    // Verify child row
    expect(repo.insert).toHaveBeenCalledOnce();
    const childRow = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(childRow.parentActionId).toBe(10);
    expect(childRow.outcome).toBe('success');

    // Verify audit event — deciderId and deciderChannel must come from originator, not 'unknown'
    expect(bus.publish).toHaveBeenCalledOnce();
    const event = (bus.publish as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(event.type).toBe('human.decision');
    expect(event.payload.decision).toBe('approve');
    expect(event.payload.deciderId).toBe('ceo-1');
    expect(event.payload.deciderChannel).toBe('email');

    // Verify return
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toHaveProperty('reExecutionResult');
  });

  it('writes failure child row when re-execution fails', async () => {
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer({ success: false, error: 'Calendar slot taken' });
    const handler = new ApproveActionHandler();

    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));

    // Child row records the failure
    const childRow = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(childRow.outcome).toBe('failure');
    expect(childRow.taskSummary).toBe('Calendar slot taken');

    // Still returns success — the approval itself succeeded, re-execution failed
    expect(result.success).toBe(true);
    const data = (result as { data: unknown }).data as Record<string, unknown>;
    expect(data.reExecutionSuccess).toBe(false);
  });

  it('forwards resolvePending ambiguous error with pending list', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: false, reason: 'ambiguous',
        error: 'Multiple pending requests — specify a short_ref.',
        pending: [PENDING_ROW, { ...PENDING_ROW, id: 11, shortRef: 'email-1' }],
      }),
    });
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('Multiple pending'));
  });

  it('aborts re-execution when resolveRow returns false (concurrent resolve)', async () => {
    const repo = makeMockRepo({
      resolveRow: vi.fn().mockResolvedValue(false),
    });
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));

    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('already resolved'));
    // Critical: re-execution must NOT have fired
    expect(execLayer.invoke).not.toHaveBeenCalled();
    // No child row or audit event either
    expect(repo.insert).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('skips human.decision and logs error when originator contact/channel is absent', async () => {
    // Originator passes isPrincipalOriginated but lacks contactId/channel — dispatch-layer bug.
    // The skill should still succeed (approval happened) but must not publish a counterfeit
    // audit row with deciderId: 'unknown'. Instead it logs an error and skips the event.
    const repo = makeMockRepo();
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handler = new ApproveActionHandler();

    const result = await handler.execute(makeCtx({
      log: mockLog,
      taskMetadata: {
        // systemRole = 'principal' passes isPrincipalOriginated but contactId/channel are absent
        originator: { systemRole: 'principal' as const, initiatedAt: new Date().toISOString() },
      },
      actionLogRepo: repo,
      bus,
      executionLayer: execLayer,
    }));

    expect(result.success).toBe(true);
    // No audit row published — fake IDs are worse than a missing row
    expect(bus.publish).not.toHaveBeenCalled();
    // Error is surfaced so the dispatch-layer bug is visible in alerting
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('returns error when row has null payload', async () => {
    const repo = makeMockRepo({
      resolvePending: vi.fn().mockResolvedValue({
        found: true,
        row: { ...PENDING_ROW, payload: null },
      }),
    });
    const bus = makeMockBus();
    const execLayer = makeMockExecutionLayer();
    const handler = new ApproveActionHandler();
    const result = await handler.execute(makeCtx({
      actionLogRepo: repo, bus, executionLayer: execLayer,
    }));
    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error', expect.stringContaining('payload'));
  });
});
