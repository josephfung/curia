import { describe, expect, it, vi } from 'vitest';
import { ActivityService, jobLabelFrom, type ActivityServiceDeps } from '../../../src/activity/activity-service.js';
import type { AuditLogRow } from '../../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../../src/logger.js';

const T0 = new Date('2026-10-24T13:00:00.000Z');
const CONTACT_ID = '7f1c0c1e-0000-4000-8000-000000000001';
const JOB_ID = '0b8f2f8e-1f7a-4c3e-9a51-3f0e2a1d4c55';

function row(overrides: Partial<AuditLogRow> & Pick<AuditLogRow, 'id' | 'eventType'>): AuditLogRow {
  return {
    timestamp: T0, sourceLayer: 'agent', sourceId: 'coordinator', conversationId: 'conv-1', taskId: null,
    parentEventId: null, payload: {}, action: null, outcome: null, targetType: null, targetId: null,
    initiatorType: null, initiatorId: null, entryHash: null, ...overrides,
  };
}

function deps(overrides: Partial<ActivityServiceDeps> = {}): ActivityServiceDeps {
  const roots = [
    row({ id: 't1', eventType: 'agent.task', payload: { agentId: 'coordinator', channelId: 'email' } }),
    row({ id: 't2', eventType: 'agent.task', conversationId: `scheduler:${JOB_ID}:r1`, payload: { agentId: 'ceo-inbox', channelId: 'scheduler' } }),
  ];
  const children = [
    row({ id: 'i1', eventType: 'tool.invoke', parentEventId: 't1', payload: { toolName: 'email-send', input: { to: CONTACT_ID } } }),
    row({ id: 'r1', eventType: 'tool.result', parentEventId: 'i1', outcome: 'success', payload: { toolName: 'email-send', result: { success: true, data: {} } } }),
    row({ id: 'i2', eventType: 'tool.invoke', parentEventId: 't1', payload: { toolName: 'ceo-inbox-draft-reply', input: {} } }),
    row({ id: 'r2', eventType: 'tool.result', parentEventId: 'i2', outcome: 'success', payload: { toolName: 'ceo-inbox-draft-reply', result: { success: true, data: { to: [{ email: 'john@example.com' }] } } } }),
    row({ id: 'i3', eventType: 'tool.invoke', parentEventId: 't2', payload: { toolName: 'ceo-inbox-archive', input: {} } }),
    row({ id: 'r3', eventType: 'tool.result', parentEventId: 'i3', outcome: 'success', payload: { toolName: 'ceo-inbox-archive', result: { success: true, data: {} } } }),
  ];
  return {
    auditLogRepo: {
      findActivityJobs: vi.fn().mockResolvedValue({ roots, delegated: [], children, hasMore: false }),
      findActivityJobsByIds: vi.fn().mockResolvedValue({ roots, delegated: [], children }),
    },
    actionLogRepo: { findTerminalBetween: vi.fn().mockResolvedValue([]) },
    contactService: {
      getContact: vi.fn().mockImplementation(async (id: string) => (id === CONTACT_ID ? { displayName: 'Jane Roe' } : undefined)),
      findContactBySystemRole: vi.fn().mockResolvedValue({ displayName: 'Joseph', timezone: 'America/Toronto' }),
      resolveByChannelIdentity: vi.fn().mockImplementation(async (_c: string, addr: string) => (addr === 'john@example.com' ? { displayName: 'John Doe' } : null)),
    } as unknown as ActivityServiceDeps['contactService'],
    schedulerService: { getJob: vi.fn().mockResolvedValue({ taskTitle: null, taskPayload: { task: 'Triage the principal\'s inbox. Archive newsletters.' } }) } as unknown as ActivityServiceDeps['schedulerService'],
    officeTimezone: 'UTC',
    logger: createSilentLogger(),
    ...overrides,
  };
}

describe('ActivityService', () => {
  it('resolves names and job labels, and reports the principal timezone', async () => {
    const d = deps();
    const page = await new ActivityService(d).list({ from: new Date(T0.getTime() - 86_400_000), to: T0, limit: 20 });
    expect(page.timezone).toBe('America/Toronto');
    expect(page.items.map((i) => i.headline)).toEqual([
      'sent an email, drafted a reply',
      "Triage the principal's inbox: archived an email",
    ]);
    expect(page.items[0]!.details).toEqual(['emailed Jane Roe', 'drafted a reply to John Doe']);
    expect(d.contactService.resolveByChannelIdentity).toHaveBeenCalledWith('email', 'john@example.com');
    expect(d.auditLogRepo.findActivityJobs).toHaveBeenCalledWith(expect.objectContaining({ limit: 80 }));
  });

  it('falls back to the office timezone and to addresses when lookups fail', async () => {
    const d = deps({
      contactService: {
        getContact: vi.fn().mockRejectedValue(new Error('db down')),
        findContactBySystemRole: vi.fn().mockRejectedValue(new Error('db down')),
        resolveByChannelIdentity: vi.fn().mockRejectedValue(new Error('db down')),
      } as unknown as ActivityServiceDeps['contactService'],
    });
    const warn = vi.spyOn(d.logger, 'warn');
    const page = await new ActivityService(d).list({ from: new Date(0), to: T0, limit: 20 });
    expect(page.timezone).toBe('UTC');
    expect(page.items[0]!.details).toEqual(['emailed a contact', 'drafted a reply to john@example.com']);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps paging when most roots project to nothing, so the feed fills', async () => {
    // Each page: 49 dropped roots (no tools, no reply) and one archive job.
    const page = (n: number) => {
      const roots: AuditLogRow[] = [];
      const children: AuditLogRow[] = [];
      for (let i = 0; i < 50; i++) {
        const id = `p${n}-t${i}`;
        roots.push(row({ id, eventType: 'agent.task', timestamp: new Date(T0.getTime() - (n * 50 + i) * 60_000), payload: { agentId: 'coordinator', channelId: 'email' } }));
        if (i === 0) {
          children.push(
            row({ id: `${id}-i`, eventType: 'tool.invoke', parentEventId: id, payload: { toolName: 'ceo-inbox-archive', input: {} } }),
            row({ id: `${id}-r`, eventType: 'tool.result', parentEventId: `${id}-i`, outcome: 'success', payload: { toolName: 'ceo-inbox-archive', result: { success: true, data: {} } } }),
          );
        }
      }
      const last = roots[roots.length - 1]!;
      return { roots, delegated: [], children, hasMore: n < 3, nextCursor: n < 3 ? { timestamp: last.timestamp, id: last.id } : undefined };
    };
    const findActivityJobs = vi.fn()
      .mockResolvedValueOnce(page(0)).mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(2)).mockResolvedValueOnce(page(3));
    const result = await new ActivityService(deps({ auditLogRepo: { findActivityJobs, findActivityJobsByIds: vi.fn() } })).list({ from: new Date(0), to: T0, limit: 3 });
    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(true);
    // Stopped once it had more than `limit` items: four pages, each continuing from the last.
    expect(findActivityJobs).toHaveBeenCalledTimes(4);
    expect(findActivityJobs.mock.calls[1]![0]).toMatchObject({ before: page(0).nextCursor });
  });

  it('reports no more once the window is exhausted, even when short', async () => {
    const result = await new ActivityService(deps()).list({ from: new Date(0), to: T0, limit: 20 });
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it('reads autonomy rows for the window plus a day, never past now', async () => {
    const d = deps();
    const to = new Date('2026-10-01T00:00:00.000Z');
    await new ActivityService(d).list({ from: new Date('2026-09-30T00:00:00.000Z'), to, limit: 20 });
    const [since, until, limit] = vi.mocked(d.actionLogRepo!.findTerminalBetween).mock.calls[0]!;
    expect(since).toEqual(new Date('2026-09-30T00:00:00.000Z'));
    expect(until).toEqual(new Date('2026-10-02T00:00:00.000Z'));
    expect(limit).toBe(5000);

    const recent = deps();
    const before = Date.now();
    await new ActivityService(recent).list({ from: new Date(before - 3_600_000), to: new Date(before), limit: 20 });
    const recentUntil = vi.mocked(recent.actionLogRepo!.findTerminalBetween).mock.calls[0]![1];
    expect(recentUntil.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('labels an approval that landed after the window', async () => {
    const d = deps({
      actionLogRepo: {
        findTerminalBetween: vi.fn().mockResolvedValue([
          { taskId: 't1', toolName: 'email-send', outcome: 'approved', conversationId: 'conv-1', createdAt: new Date(T0.getTime() + 3_600_000) },
        ]),
      },
    });
    const page = await new ActivityService(d).list({ from: new Date(0), to: T0, limit: 20 });
    expect(page.items[0]!.autonomy).toBe('approved');
  });

  it('trims to the limit and reports more', async () => {
    const page = await new ActivityService(deps()).list({ from: new Date(0), to: T0, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });
});

describe('ActivityService.listByIds', () => {
  it('projects the named roots, newest first, with names resolved', async () => {
    const d = deps();
    const items = await new ActivityService(d).listByIds(['t1', 't2'], T0);
    expect(d.auditLogRepo.findActivityJobsByIds).toHaveBeenCalledWith(['t1', 't2'], T0);
    expect(items.map((i) => i.id)).toEqual(['t1', 't2']);
    expect(items[0]!.details).toEqual(['emailed Jane Roe', 'drafted a reply to John Doe']);
  });

  it('reads nothing more when no root matched', async () => {
    const d = deps({
      auditLogRepo: {
        findActivityJobs: vi.fn(),
        findActivityJobsByIds: vi.fn().mockResolvedValue({ roots: [], delegated: [], children: [] }),
      },
    });
    expect(await new ActivityService(d).listByIds(['gone'], T0)).toEqual([]);
    expect(d.contactService.findContactBySystemRole).not.toHaveBeenCalled();
  });
});

describe('jobLabelFrom', () => {
  it('prefers the task title, else the first sentence of the task, capped', () => {
    expect(jobLabelFrom({ taskTitle: 'Morning brief', taskPayload: { task: 'x' } })).toBe('Morning brief');
    expect(jobLabelFrom({ taskTitle: null, taskPayload: { task: 'Check the inbox. Then rest.' } })).toBe('Check the inbox');
    expect(jobLabelFrom({ taskTitle: null, taskPayload: {} })).toBeNull();
    expect(jobLabelFrom({ taskTitle: 'x'.repeat(100), taskPayload: {} })!.length).toBe(60);
  });

  it('scrubs contact details from the task-text fallback', () => {
    expect(jobLabelFrom({ taskTitle: null, taskPayload: { task: 'Email jane@acme.com the weekly numbers. Then stop.' } }))
      .toBe('Email the weekly numbers');
  });
});
