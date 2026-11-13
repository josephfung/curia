// A new event that is going to answer needs_mailbox never raises an approval first (#2475,
// BR-m5): with several principal mailboxes and no `mailbox`, the execution layer answers
// needs_mailbox before its autonomy gates, so the principal is not asked to approve a call that
// would create nothing and then asked again for the retry with `mailbox`.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolHandler, ToolManifest } from '../../../src/skills/types.js';
import { calendarMailbox, routerFixture, TEST_PRINCIPAL_CONTACT_ID } from '../../../skills/_shared/calendar-router-test-helpers.js';

const logger = pino({ level: 'silent' });

function manifest(): ToolManifest {
  return {
    name: 'calendar-create-event',
    description: 'test tool',
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: 'high',
    inputs: { calendarId: 'string', title: 'string', mailbox: 'string?' },
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
  };
}

function setup(mailboxes = [calendarMailbox('work', 'Work', 'ceo@work.example.com', true), calendarMailbox('personal', 'Personal', 'ceo@personal.example.com')]) {
  const registry = new ToolRegistry();
  const execute = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: {} }));
  registry.register(manifest(), { execute });
  const request = vi.fn(async (_opts: Record<string, unknown>) => ({ created: true as const, rowId: 1, shortRef: 'ab12cd34', approvalNumber: 3 }));
  const autonomyService = {
    // Below the high-risk floor: Gate B would queue an approval.
    getConfig: vi.fn(async () => ({ score: 65, band: 'draft-only', updatedAt: new Date(), updatedBy: 'test' })),
  } as unknown as AutonomyService;
  const calendarRouter = routerFixture({
    mailboxes,
    clients: { work: {}, personal: {} },
    registry: { 'cal-work': { principalMailboxId: 'work', contactId: TEST_PRINCIPAL_CONTACT_ID } },
  });
  const layer = new ExecutionLayer(registry, logger, {
    autonomyService,
    approvalTrigger: { request } as never,
    bus: { publish: vi.fn(async () => undefined) } as unknown as EventBus,
    calendarRouter,
  });
  return { layer, execute, request };
}

describe('calendar mailbox pre-gate (BR-m5)', () => {
  it('answers needs_mailbox before the autonomy gates: no approval, no handler run', async () => {
    const { layer, execute, request } = setup();
    const r = await layer.invoke('calendar-create-event', { calendarId: 'cal-work', title: 'Q3' }, undefined, { taskEventId: 'task-1' });
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('needs_mailbox: nothing was created') });
    // Wrapped like every other execution-layer refusal (N1).
    if (!r.success) expect(r.error).toMatch(/^<skill_error>[\s\S]*<\/skill_error>$/);
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('mailbox null or empty is absent: answered before the gates too (N2)', async () => {
    for (const mailbox of [null, '']) {
      const { layer, request } = setup();
      const r = await layer.invoke('calendar-create-event', { calendarId: 'cal-work', title: 'Q3', mailbox }, undefined, { taskEventId: 'task-1' });
      expect(r).toMatchObject({ success: false, error: expect.stringContaining('needs_mailbox') });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("a non-principal calendar with several mailboxes passes straight to the gates", async () => {
    const { layer, request } = setup();
    await layer.invoke('calendar-create-event', { calendarId: 'someone@partner.example', title: 'Q3' }, undefined, { taskEventId: 'task-1' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('with mailbox stated, the gate asks for approval once, as before', async () => {
    const { layer, request } = setup();
    const r = await layer.invoke('calendar-create-event', { calendarId: 'cal-work', title: 'Q3', mailbox: 'work' }, undefined, { taskEventId: 'task-1' });
    expect(r.success).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it('with one mailbox, nothing changes: the gate asks for approval', async () => {
    const { layer, request } = setup([calendarMailbox('work', 'Work', 'ceo@work.example.com', true)]);
    await layer.invoke('calendar-create-event', { calendarId: 'cal-work', title: 'Q3' }, undefined, { taskEventId: 'task-1' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('an approved replay skips the pre-gate and reaches the handler', async () => {
    const { layer, execute } = setup();
    await layer.invoke('calendar-create-event', { calendarId: 'cal-work', title: 'Q3' }, undefined, { taskEventId: 'task-1', humanApproved: true });
    expect(execute).toHaveBeenCalledOnce();
  });
});
