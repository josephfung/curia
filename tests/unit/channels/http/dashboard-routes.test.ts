import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dashboardRoutes } from '../../../../src/channels/http/routes/dashboard.js';
import { BriefingService, type BriefingDeps } from '../../../../src/dashboard/briefing-service.js';
import { TaskTerminalStateError } from '../../../../src/db/task-repo.js';
import { createSilentLogger } from '../../../../src/logger.js';

const SECRET = 'dashboard-secret';
const AUTH = { 'x-web-bootstrap-secret': SECRET };
const TASK_ID = '22222222-2222-2222-2222-222222222222';

let app: FastifyInstance | undefined;

function briefing(overrides: Partial<BriefingDeps> = {}): BriefingService {
  const deps: BriefingDeps = {
    pool: { query: vi.fn().mockResolvedValue({ rows: [{ n: 0 }] }) } as unknown as BriefingDeps['pool'],
    actionLogRepo: {
      findAllPending: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      resolveRow: vi.fn(),
      rejectStaleApproval: vi.fn(),
      insert: vi.fn(),
    },
    taskRepo: { listTasks: vi.fn().mockResolvedValue([]), updateTask: vi.fn() },
    contactService: { findContactBySystemRole: vi.fn().mockResolvedValue({ id: 'p', timezone: 'UTC' }) },
    officeTimezone: 'UTC',
    logger: createSilentLogger(),
    ...overrides,
  };
  return new BriefingService(deps);
}

async function build(service: BriefingService) {
  app = Fastify();
  await app.register(dashboardRoutes, {
    briefing: service,
    webAppBootstrapSecret: SECRET,
    sessions: new Map(),
    logger: createSilentLogger(),
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('dashboard routes', () => {
  it('rejects unauthenticated reads and writes', async () => {
    const updateTask = vi.fn();
    const service = briefing({ taskRepo: { listTasks: vi.fn(), updateTask } });
    const server = await build(service);
    for (const url of [
      '/api/dashboard/waiting',
      '/api/dashboard/stats',
      '/api/dashboard/histogram',
      '/api/dashboard/bullpen',
      '/api/dashboard/hiccups',
      '/api/dashboard/approvals/1/preview',
    ]) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
    const cancel = await server.inject({ method: 'POST', url: `/api/dashboard/tasks/${TASK_ID}/cancel` });
    expect(cancel.statusCode).toBe(401);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('cancels a task through TaskRepo.updateTask', async () => {
    // Wake-up cancellation, child reconciliation and outreach close live in
    // TaskRepo.updateTask (see tests/integration/task-update-wake-reuse.test.ts).
    // This route's job is to get there instead of writing the row itself.
    const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID, status: 'cancelled' });
    const server = await build(briefing({ taskRepo: { listTasks: vi.fn(), updateTask } }));
    const res = await server.inject({
      method: 'POST',
      url: `/api/dashboard/tasks/${TASK_ID}/cancel`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { status: 'cancelled' }, 'console');
  });

  it('marks a task done through the same path', async () => {
    const updateTask = vi.fn().mockResolvedValue({ id: TASK_ID, status: 'done' });
    const server = await build(briefing({ taskRepo: { listTasks: vi.fn(), updateTask } }));
    const res = await server.inject({
      method: 'POST',
      url: `/api/dashboard/tasks/${TASK_ID}/done`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, { status: 'done' }, 'console');
  });

  it('returns 400 for a non-uuid task id and does not touch the repo', async () => {
    const updateTask = vi.fn();
    const server = await build(briefing({ taskRepo: { listTasks: vi.fn(), updateTask } }));
    const res = await server.inject({ method: 'POST', url: '/api/dashboard/tasks/nope/cancel', headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('returns a generic 500 when the waiting query fails', async () => {
    const service = briefing({
      taskRepo: { listTasks: vi.fn().mockRejectedValue(new Error('relation missing')), updateTask: vi.fn() },
    });
    const server = await build(service);
    const res = await server.inject({ method: 'GET', url: '/api/dashboard/waiting', headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to load what is waiting on you' });
  });

  it('passes a hiccup day through and rejects a malformed one', async () => {
    const service = briefing();
    const hiccups = vi.spyOn(service, 'hiccups').mockResolvedValue({ timezone: 'UTC', day: '2026-11-02', total: 0, items: [] });
    const server = await build(service);
    const ok = await server.inject({ method: 'GET', url: '/api/dashboard/hiccups?day=2026-11-02', headers: AUTH });
    expect(ok.statusCode).toBe(200);
    expect(hiccups).toHaveBeenCalledWith(expect.any(Date), '2026-11-02');
    const bad = await server.inject({ method: 'GET', url: '/api/dashboard/hiccups?day=yesterday', headers: AUTH });
    expect(bad.statusCode).toBe(400);
    expect(hiccups).toHaveBeenCalledTimes(1);
  });

  it('reports the hiccup list as an error when there is no activity source', async () => {
    const server = await build(briefing());
    const res = await server.inject({ method: 'GET', url: '/api/dashboard/hiccups', headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to load the hiccups' });
  });

  it('forwards the review flag when the principal approves', async () => {
    const service = briefing();
    const approve = vi.spyOn(service, 'approve').mockResolvedValue({ ok: true, sent: true });
    const server = await build(service);
    const res = await server.inject({
      method: 'POST',
      url: '/api/dashboard/approvals/4/approve',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { shown: true },
    });
    expect(res.statusCode).toBe(200);
    expect(approve).toHaveBeenCalledWith(4, true);
  });

  it('maps a terminal task to 400 and leaves other failures as 500', async () => {
    const terminal = briefing({
      taskRepo: { listTasks: vi.fn(), updateTask: vi.fn().mockRejectedValue(new TaskTerminalStateError('done')) },
    });
    const terminalRes = await (await build(terminal)).inject({
      method: 'POST',
      url: `/api/dashboard/tasks/${TASK_ID}/done`,
      headers: AUTH,
    });
    expect(terminalRes.statusCode).toBe(400);

    await app?.close();
    const other = briefing({
      taskRepo: { listTasks: vi.fn(), updateTask: vi.fn().mockRejectedValue(new Error('terminal state in a log line')) },
    });
    const otherRes = await (await build(other)).inject({
      method: 'POST',
      url: `/api/dashboard/tasks/${TASK_ID}/done`,
      headers: AUTH,
    });
    expect(otherRes.statusCode).toBe(500);
  });

  it('does not report the bullpen as zero when the count query fails', async () => {
    const service = briefing({
      pool: { query: vi.fn().mockRejectedValue(new Error('audit_log missing')) } as unknown as BriefingDeps['pool'],
    });
    const server = await build(service);
    const res = await server.inject({ method: 'GET', url: '/api/dashboard/bullpen', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ available: false, count: 0, agents: [] });
  });
});
