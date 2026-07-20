// handler.test.ts — unit tests for ceo-backlog-sweep skill handler.
//
// Covers the acceptance criteria of #1467:
//   - overdue CEO task → nudge with correct counts
//   - nothing overdue/due-today → silent (no send)
//   - the query scopes to owner='ceo' + open statuses (non-CEO/curia tasks ignored)
//   - overdue vs due-today split and body wording
//   - non-fatal skip paths: no gateway, no principal email, sendNotification false
//   - unexpected DB error → { success: false }

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CeoBacklogSweepHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { TaskRepo, TaskListRow } from '../../src/db/task-repo.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';

// Fixed "now" so overdue/due-today classification is deterministic. All fixtures
// below are relative to this instant; ctx.timezone is 'UTC' so day boundaries are
// simple: start of today = 2026-07-20T00:00:00Z, start of tomorrow = 2026-07-21T00:00:00Z.
const NOW = new Date('2026-07-20T15:00:00.000Z');

function makeRow(overrides: Partial<TaskListRow> = {}): TaskListRow {
  return {
    id: 'task-1',
    agentId: 'coordinator',
    intentAnchor: null,
    title: 'Review Q3 board deck',
    description: null,
    status: 'open',
    progress: { notes: [] },
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    owner: 'ceo',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
    blockedByTaskId: null,
    priority: 0,
    dueAt: '2026-07-19T09:00:00.000Z', // yesterday → overdue
    source: null,
    sourceAgentId: null,
    createdBy: null,
    tags: [],
    originator: null,
    nextWakeAt: null,
    ...overrides,
  } as unknown as TaskListRow;
}

function makeCtx(overrides: {
  rows?: TaskListRow[];
  sendNotificationResult?: boolean;
  ceoEmail?: string;
  withoutOutboundGateway?: boolean;
  withoutTaskRepo?: boolean;
  listTasksThrows?: boolean;
} = {}) {
  const {
    rows = [],
    sendNotificationResult = true,
    ceoEmail = 'ceo@example.com',
    withoutOutboundGateway = false,
    withoutTaskRepo = false,
    listTasksThrows = false,
  } = overrides;

  // The handler uses listAllTasks (paginated, exact counts) — not the single-page
  // listTasks — so the reported counts never silently cap. The mock returns the
  // { tasks, truncated } shape listAllTasks resolves to.
  const listAllTasksMock = vi.fn();
  if (listTasksThrows) {
    listAllTasksMock.mockRejectedValue(new Error('db exploded'));
  } else {
    listAllTasksMock.mockResolvedValue({ tasks: rows, truncated: false });
  }
  const sendNotificationMock = vi.fn().mockResolvedValue(sendNotificationResult);
  const logInfoMock = vi.fn();
  const logWarnMock = vi.fn();
  const logErrorMock = vi.fn();

  const findContactBySystemRoleMock = vi
    .fn()
    .mockResolvedValue(ceoEmail ? { id: 'principal-contact-id' } : null);
  const getContactWithIdentitiesMock = vi.fn().mockResolvedValue(
    ceoEmail
      ? { identities: [{ channel: 'email', channelIdentifier: ceoEmail, verified: true, status: 'active' }] }
      : { identities: [] },
  );

  const ctx: SkillContext = {
    skillName: 'ceo-backlog-sweep',
    skillVersion: '0.1.0',
    input: {},
    timezone: 'UTC',
    secret: vi.fn().mockImplementation((name: string) => {
      throw new Error(`secret ${name} not configured`);
    }),
    log: { info: logInfoMock, warn: logWarnMock, error: logErrorMock, debug: vi.fn() } as unknown as SkillContext['log'],
    taskRepo: withoutTaskRepo
      ? undefined
      : ({ listAllTasks: listAllTasksMock } as unknown as TaskRepo),
    contactService: {
      findContactBySystemRole: findContactBySystemRoleMock,
      getContactWithIdentities: getContactWithIdentitiesMock,
    } as unknown as ContactService,
    outboundGateway: withoutOutboundGateway
      ? undefined
      : ({ sendNotification: sendNotificationMock } as unknown as OutboundGateway),
  } as SkillContext;

  return { ctx, listAllTasksMock, sendNotificationMock, logWarnMock, logErrorMock };
}

describe('CeoBacklogSweepHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a nudge with correct counts for an overdue CEO task', async () => {
    const { ctx, sendNotificationMock } = makeCtx({ rows: [makeRow()] });
    const handler = new CeoBacklogSweepHandler();

    const result = await handler.execute(ctx);

    expect(result).toEqual({ success: true, data: { overdue: 1, dueToday: 0, notified: 1 } });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.notificationType).toBe('ceo_backlog_nudge');
    expect(payload.ceoEmail).toBe('ceo@example.com');
    expect(payload.subject).toBe('1 CEO task overdue or due today');
    expect(payload.body).toContain('1 overdue');
    expect(payload.body).toContain("what's open");
  });

  it('scopes the query to owner=ceo, open statuses, and the end-of-today boundary', async () => {
    const { ctx, listAllTasksMock } = makeCtx({ rows: [makeRow()] });
    await new CeoBacklogSweepHandler().execute(ctx);

    expect(listAllTasksMock).toHaveBeenCalledTimes(1);
    const filters = listAllTasksMock.mock.calls[0]![0];
    expect(filters.owner).toBe('ceo');
    expect(filters.statuses).toEqual(['open', 'in_progress', 'blocked', 'waiting']);
    // start of tomorrow (local UTC midnight) — captures everything due today and earlier
    expect((filters.dueBefore as Date).toISOString()).toBe('2026-07-21T00:00:00.000Z');
    // No single-page `limit` — listAllTasks pages through so counts stay exact.
    expect(filters.limit).toBeUndefined();
  });

  it('reports exact counts beyond a single 100-row page (no silent cap)', async () => {
    // 101 overdue tasks — the old single-page listTasks(limit:100) would have
    // under-reported this as "100". listAllTasks returns them all in one { tasks }
    // result here, so the handler must count every one.
    const rows = Array.from({ length: 101 }, (_, i) =>
      makeRow({ id: `overdue-${i}`, dueAt: '2026-07-19T09:00:00.000Z' }),
    );
    const { ctx, sendNotificationMock } = makeCtx({ rows });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result).toEqual({ success: true, data: { overdue: 101, dueToday: 0, notified: 101 } });
    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.subject).toBe('101 CEO tasks overdue or due today');
    expect(payload.body).toContain('101 overdue');
  });

  it('is silent (no send) when no CEO tasks are overdue or due today', async () => {
    const { ctx, sendNotificationMock } = makeCtx({ rows: [] });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result).toEqual({ success: true, data: { overdue: 0, dueToday: 0, notified: 0 } });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('splits overdue and due-today and reports both in the body', async () => {
    const rows = [
      makeRow({ id: 't-overdue', dueAt: '2026-07-19T09:00:00.000Z' }), // yesterday
      makeRow({ id: 't-today-am', dueAt: '2026-07-20T09:00:00.000Z' }), // today
      makeRow({ id: 't-today-pm', dueAt: '2026-07-20T20:00:00.000Z' }), // today
    ];
    const { ctx, sendNotificationMock } = makeCtx({ rows });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result).toEqual({ success: true, data: { overdue: 1, dueToday: 2, notified: 3 } });
    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.subject).toBe('3 CEO tasks overdue or due today');
    expect(payload.body).toContain('1 overdue, 2 due today');
  });

  it('does not send when outboundGateway is unavailable but still reports counts', async () => {
    const { ctx } = makeCtx({ rows: [makeRow()], withoutOutboundGateway: true });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result).toEqual({ success: true, data: { overdue: 1, dueToday: 0, notified: 0 } });
  });

  it('does not send when no principal email is on file', async () => {
    const { ctx, sendNotificationMock } = makeCtx({ rows: [makeRow()], ceoEmail: '' });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result).toEqual({ success: true, data: { overdue: 1, dueToday: 0, notified: 0 } });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('reports notified:0 when sendNotification returns false (non-fatal)', async () => {
    const { ctx } = makeCtx({ rows: [makeRow()], sendNotificationResult: false });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result).toEqual({ success: true, data: { overdue: 1, dueToday: 0, notified: 0 } });
  });

  it('returns failure when taskRepo capability is missing', async () => {
    const { ctx, sendNotificationMock } = makeCtx({ withoutTaskRepo: true });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('returns failure (not throw) on an unexpected DB error', async () => {
    const { ctx, logErrorMock } = makeCtx({ listTasksThrows: true });
    const result = await new CeoBacklogSweepHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('db exploded');
    expect(logErrorMock).toHaveBeenCalled();
  });
});
