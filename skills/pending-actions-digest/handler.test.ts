// handler.test.ts — unit tests for pending-actions-digest skill handler.
//
// Tests cover: no-op on empty pending rows, single digest notification,
// time-remaining formatting, missing CEO email, missing outbound gateway,
// non-fatal sendNotification failure, and unexpected DB errors.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PendingActionsDigestHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { ActionLogRow } from '../../src/autonomy/action-log-types.js';

// --- Fixed time anchor ---
// Pinning Date.now() makes all expiresAt calculations deterministic.
const FIXED_NOW = 1_000_000_000_000;

// --- Fixtures ---

function makeRow(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 1,
    taskId: 'task-1',
    conversationId: null,
    skillName: 'create-calendar-event',
    actionRisk: 'medium',
    outcome: 'pending_approval',
    taskSummary: null,
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: {},
    notificationSentAt: null,
    resolvedAt: null,
    resolvedBy: null,
    // Default: 2 hours in the future from FIXED_NOW
    expiresAt: new Date(FIXED_NOW + 7_200_000),
    parentActionId: null,
    shortRef: 'cal-1',
    description: 'Create event: Lunch',
    createdAt: new Date(FIXED_NOW - 3_600_000),
    ...overrides,
  };
}

function makeCtx(overrides: {
  pendingRows?: ActionLogRow[];
  sendResult?: boolean;
  ceoEmail?: string;
  noOutboundGateway?: boolean;
  ceoTasks?: unknown[];
  externalTasks?: unknown[];
  curiaTasks?: unknown[];
  listTasksError?: boolean;
  contactName?: string;
  noTaskRepo?: boolean;
  contactLookupError?: boolean;
} = {}) {
  const {
    pendingRows = [],
    sendResult = true,
    ceoEmail = 'ceo@example.com',
    noOutboundGateway = false,
    ceoTasks = [],
    externalTasks = [],
    curiaTasks = [],
    listTasksError = false,
    contactName = 'Steve Jobs',
    noTaskRepo = false,
    contactLookupError = false,
  } = overrides;

  process.env['CEO_PRIMARY_EMAIL'] = ceoEmail;

  const findAllPendingMock = vi.fn().mockResolvedValue(pendingRows);
  const sendNotificationMock = vi.fn().mockResolvedValue(sendResult);
  const logWarnMock = vi.fn();
  const logErrorMock = vi.fn();

  // listTasks routes by the `owner` filter so each section gets its own fixture.
  const listTasksMock = vi.fn().mockImplementation(async (filters: { owner?: string }) => {
    if (listTasksError) throw new Error('tasks query failed');
    if (filters.owner === 'ceo') return ceoTasks;
    if (filters.owner === 'external') return externalTasks;
    if (filters.owner === 'curia') return curiaTasks;
    return [];
  });
  const getContactMock = contactLookupError
    ? vi.fn().mockRejectedValue(new Error('contact lookup failed'))
    : vi.fn().mockResolvedValue({ displayName: contactName });

  const ctx: SkillContext = {
    input: {},
    secret: vi.fn().mockImplementation((name: string) => {
      throw new Error(`secret ${name} not configured`);
    }),
    log: { info: vi.fn(), warn: logWarnMock, error: logErrorMock, debug: vi.fn() } as unknown as SkillContext['log'],
    timezone: 'UTC',
    actionLogRepo: { findAllPending: findAllPendingMock } as unknown as ActionLogRepo,
    outboundGateway: noOutboundGateway
      ? undefined
      : ({ sendNotification: sendNotificationMock } as unknown as OutboundGateway),
    taskRepo: noTaskRepo ? undefined : ({ listTasks: listTasksMock } as unknown as SkillContext['taskRepo']),
    contactService: { getContact: getContactMock } as unknown as SkillContext['contactService'],
  } as SkillContext;

  return { ctx, findAllPendingMock, sendNotificationMock, logWarnMock, logErrorMock, listTasksMock, getContactMock };
}

// --- Lifecycle hooks ---

let dateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dateSpy = vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
});

afterEach(() => {
  dateSpy.mockRestore();
  delete process.env['CEO_PRIMARY_EMAIL'];
});

// --- Tests ---

describe('PendingActionsDigestHandler', () => {
  it('returns {pending:0, skipped:true} and sends no notification when no pending rows', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock } = makeCtx({ pendingRows: [] });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 0, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('sends a single digest notification listing all pending rows', async () => {
    const rows = [
      makeRow({ id: 1, shortRef: 'cal-1', description: 'Create event: Lunch', skillName: 'create-calendar-event' }),
      makeRow({ id: 2, shortRef: 'email-2', description: 'Send weekly update', skillName: 'send-email' }),
    ];
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock } = makeCtx({ pendingRows: rows, ceoEmail: 'ceo@example.com' });

    const result = await handler.execute(ctx);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);

    const payload = sendNotificationMock.mock.calls[0][0];
    expect(payload.notificationType).toBe('pending_actions_digest');
    expect(payload.ceoEmail).toBe('ceo@example.com');
    expect(payload.subject).toBe('Pending approvals — 2 request(s) awaiting your decision');

    // Both shortRefs must appear in the digest body
    expect(payload.body).toContain('cal-1');
    expect(payload.body).toContain('email-2');

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 2, skipped: false, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
  });

  it('each entry includes shortRef, description, skillName, and time remaining', async () => {
    const row = makeRow({
      shortRef: 'ref-abc',
      description: 'Book flight to NYC',
      skillName: 'book-travel',
      expiresAt: new Date(FIXED_NOW + 7_200_000), // exactly 2h remaining
    });
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock } = makeCtx({ pendingRows: [row] });

    await handler.execute(ctx);

    const payload = sendNotificationMock.mock.calls[0][0];
    expect(payload.body).toContain('ref-abc');
    expect(payload.body).toContain('Book flight to NYC');
    expect(payload.body).toContain('book-travel');
    expect(payload.body).toContain('2h remaining');
  });

  it('formatTimeRemaining: shows <1h remaining when under 1 hour', async () => {
    const row = makeRow({
      expiresAt: new Date(FIXED_NOW + 1_800_000), // 30 min in the future
    });
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock } = makeCtx({ pendingRows: [row] });

    await handler.execute(ctx);

    const payload = sendNotificationMock.mock.calls[0][0];
    expect(payload.body).toContain('<1h remaining');
  });

  it('skips notification when CEO_PRIMARY_EMAIL is not set', async () => {
    const row = makeRow({ id: 1, shortRef: 'cal-1' });
    const handler = new PendingActionsDigestHandler();
    // Setting ceoEmail: '' causes makeCtx to set process.env['CEO_PRIMARY_EMAIL'] = ''
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({ pendingRows: [row], ceoEmail: '' });

    const result = await handler.execute(ctx);

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalled();

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
  });

  it('skips notification when outboundGateway is not available', async () => {
    const row = makeRow({ id: 1, shortRef: 'cal-1' });
    const handler = new PendingActionsDigestHandler();
    const { ctx, logWarnMock } = makeCtx({ pendingRows: [row], noOutboundGateway: true });

    const result = await handler.execute(ctx);

    // ctx.outboundGateway is undefined — verify no crash and warn emitted
    expect(logWarnMock).toHaveBeenCalled();

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
  });

  it('handles sendNotification returning false gracefully', async () => {
    const row = makeRow({ id: 1, shortRef: 'cal-1' });
    const handler = new PendingActionsDigestHandler();
    // sendResult: false means the gateway accepted the call but returned false
    const { ctx } = makeCtx({ pendingRows: [row], sendResult: false });

    const result = await handler.execute(ctx);

    // Non-fatal — skill should still succeed and report skipped:false (the send was attempted)
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: false, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
  });

  it('returns success:false on unexpected error', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, findAllPendingMock } = makeCtx();

    // Override findAllPending to simulate an unexpected DB error
    findAllPendingMock.mockRejectedValue(new Error('DB error'));

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error).toContain('DB error');
  });

  function makeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: 'id', agentId: 'a', intentAnchor: 'i', status: 'open',
      progress: {}, errorBudget: {}, conversationId: null,
      createdAt: new Date(FIXED_NOW - 3_600_000).toISOString(),
      updatedAt: new Date(FIXED_NOW - 3_600_000).toISOString(),
      title: 'A task', description: null, owner: 'curia',
      waitingOnContactId: null, waitingOnText: null, parentTaskId: null,
      blockedByTaskId: null, priority: 50, dueAt: null, source: 'agent',
      sourceAgentId: null, createdBy: 'system', tags: [], nextWakeAt: null,
      ...overrides,
    };
  }

  it('sends a backlog-only digest with an adaptive subject when there are no approvals', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock } = makeCtx({
      pendingRows: [],
      ceoTasks: [makeTask({ owner: 'ceo', title: 'Review the Acme deck' })],
      externalTasks: [makeTask({ owner: 'external', status: 'waiting', title: 'Signed NDA', waitingOnContactId: 'c1' })],
    });

    const result = await handler.execute(ctx);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.subject).toBe('Your daily brief — 2 item(s) need you');
    expect(payload.body).toContain('For you to do:');
    expect(payload.body).toContain('• Review the Acme deck');
    expect(payload.body).toContain('Waiting on others:');
    expect(payload.body).toContain('• Signed NDA · waiting on Steve Jobs · since');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 0, skipped: false, tasksForCeo: 1, tasksWaiting: 1, tasksWorking: 0 });
  });

  it('keeps the approvals subject and appends backlog when approvals are present', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock } = makeCtx({
      pendingRows: [makeRow({ id: 1, shortRef: 'cal-1' })],
      curiaTasks: [makeTask({ owner: 'curia', title: 'Draft the board email' })],
    });

    await handler.execute(ctx);

    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.subject).toBe('Pending approvals — 1 request(s) awaiting your decision');
    expect(payload.body).toContain('cal-1');
    expect(payload.body).toContain("What I'm working on:");
    expect(payload.body).toContain('• Draft the board email');
  });

  it('does NOT send when only "what I\'m working on" is non-empty', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock } = makeCtx({
      pendingRows: [],
      curiaTasks: [makeTask({ owner: 'curia', title: 'Internal cleanup' })],
    });

    const result = await handler.execute(ctx);

    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 0, skipped: true, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 1 });
  });

  it('degrades to an approvals-only digest when the task query fails', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock, logErrorMock } = makeCtx({
      pendingRows: [makeRow({ id: 1, shortRef: 'cal-1' })],
      listTasksError: true,
    });

    const result = await handler.execute(ctx);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(logErrorMock).toHaveBeenCalled();
    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.body).toContain('cal-1');
    expect(payload.body).not.toContain('For you to do:');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: false, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
  });

  it('degrades to an approvals-only digest when taskRepo is absent', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({
      pendingRows: [makeRow({ id: 1, shortRef: 'cal-1' })],
      noTaskRepo: true,
    });

    const result = await handler.execute(ctx);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalled();
    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.body).toContain('cal-1');
    expect(payload.body).not.toContain('For you to do:');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 1, skipped: false, tasksForCeo: 0, tasksWaiting: 0, tasksWorking: 0 });
  });

  it('still sends the digest and falls back to (unknown) when contact lookup fails', async () => {
    const handler = new PendingActionsDigestHandler();
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({
      pendingRows: [],
      ceoTasks: [],
      externalTasks: [makeTask({ owner: 'external', status: 'waiting', title: 'Signed NDA', waitingOnContactId: 'c1', waitingOnText: null })],
      curiaTasks: [],
      contactLookupError: true,
    });

    const result = await handler.execute(ctx);

    // Digest still sends despite the failed lookup
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // A warn must be emitted for the failed lookup
    expect(logWarnMock).toHaveBeenCalled();
    // Body falls back to '(unknown)' since both contact and waitingOnText are null
    const payload = sendNotificationMock.mock.calls[0]![0];
    expect(payload.body).toContain('• Signed NDA · waiting on (unknown) · since');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data).toEqual({ pending: 0, skipped: false, tasksForCeo: 0, tasksWaiting: 1, tasksWorking: 0 });
  });
});
