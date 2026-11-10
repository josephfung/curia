// A send from the principal's own mailbox is never queued for approval (#2474, design D5):
// when a gate blocks ceo-inbox-send-draft, no approval row is created and the draft stays in
// the principal's Drafts folder.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { ExecutionLayer, NO_APPROVAL_FOR_PRINCIPAL_MAILBOX_SEND } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolHandler, ToolManifest } from '../../../src/skills/types.js';

const logger = pino({ level: 'silent' });

function manifest(name: string): ToolManifest {
  return {
    name,
    description: 'test tool',
    version: '1.0.0',
    sensitivity: 'normal',
    action_risk: 80,
    inputs: { draft_id: 'string' },
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
  };
}

function setup(toolName: string, score: number) {
  const registry = new ToolRegistry();
  const execute = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: {} }));
  registry.register(manifest(toolName), { execute });
  const request = vi.fn(async (_opts: Record<string, unknown>) => ({ created: true as const, rowId: 1, shortRef: 'ab12cd34', approvalNumber: 3 }));
  const autonomyService = {
    getConfig: vi.fn(async () => ({ score, band: 'draft-only', updatedAt: new Date(), updatedBy: 'test' })),
  } as unknown as AutonomyService;
  const publish = vi.fn(async (..._args: unknown[]) => undefined);
  const layer = new ExecutionLayer(registry, logger, {
    autonomyService,
    approvalTrigger: { request } as never,
    bus: { publish } as unknown as EventBus,
  });
  return { layer, execute, request, publish };
}

// An outside originator with no tier standing: Gate C escalates a high-risk action.
const unknownOriginator = {
  taskEventId: 'task-1',
  taskMetadata: {
    originator: { contactId: 'c-1', systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'unknown' },
  },
};

describe('gate blocks on ceo-inbox-send-draft queue no approval (#2474)', () => {
  it('Gate B block on ceo-inbox-send-draft creates no approval row', async () => {
    const { layer, execute, request } = setup('ceo-inbox-send-draft', 65);
    const result = await layer.invoke('ceo-inbox-send-draft', { draft_id: 'd-1' }, undefined, { taskEventId: 'task-1' });
    expect(result.success).toBe(false);
    // The advisory ends with the constant, inside the wrapper every skill error gets.
    if (!result.success) expect(result.error.endsWith(`${NO_APPROVAL_FOR_PRINCIPAL_MAILBOX_SEND}</skill_error>`)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('Gate C (tier) block on ceo-inbox-send-draft creates no approval row', async () => {
    const { layer, execute, request } = setup('ceo-inbox-send-draft', 100);
    const result = await layer.invoke('ceo-inbox-send-draft', { draft_id: 'd-1' }, undefined, unknownOriginator);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('initiating contact\'s tier');
      expect(result.error.endsWith(`${NO_APPROVAL_FOR_PRINCIPAL_MAILBOX_SEND}</skill_error>`)).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('another tool blocked the same way still queues an approval', async () => {
    const { layer, request } = setup('email-send', 65);
    const result = await layer.invoke('email-send', { draft_id: 'd-1' }, undefined, { taskEventId: 'task-1' });
    expect(result.success).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it('files a digest item when Gate B refuses an autonomous ceo-inbox send', async () => {
    const { layer, publish } = setup('ceo-inbox-send-draft', 65);
    await layer.invoke('ceo-inbox-send-draft', { draft_id: 'd-1' }, undefined, { taskEventId: 'task-1' });
    const reports = publish.mock.calls
      .map((c) => c[1] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === 'principal.report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.payload).toMatchObject({
      urgency: 'digest',
      source: 'principal_mailbox',
      summary: 'Left as a draft in your mailbox: a reply Curia wanted to send on its own. Autonomy is 65; sending on its own needs 80.',
    });
  });

  it('files no digest item when an outsider-originated call is refused at Gate B', async () => {
    const { layer, publish } = setup('ceo-inbox-send-draft', 65);
    const outsider = {
      taskEventId: 'task-1',
      taskMetadata: { originator: { contactId: 'c-x', systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'unknown' } },
    };
    const r = await layer.invoke('ceo-inbox-send-draft', { draft_id: 'd-1' }, undefined, outsider);
    expect(r.success).toBe(false);
    expect(publish.mock.calls.filter((c) => (c[1] as { type: string }).type === 'principal.report')).toHaveLength(0);
  });

  it('a live principal turn skips the gates, so no refusal and no digest item', async () => {
    const { layer, execute, publish } = setup('ceo-inbox-send-draft', 65);
    const principal = {
      taskEventId: 'task-1',
      taskMetadata: { originator: { contactId: 'p-1', systemRole: 'principal', channel: 'signal', initiatedAt: new Date().toISOString(), tier: 'principal' } },
    };
    await layer.invoke('ceo-inbox-send-draft', { draft_id: 'd-1' }, undefined, principal);
    expect(execute).toHaveBeenCalledOnce();
    expect(publish.mock.calls.filter((c) => (c[1] as { type: string }).type === 'principal.report')).toHaveLength(0);
  });

  it('files one digest item when the ladder demotes a woken principal task and Gate B refuses', async () => {
    const { layer, execute, publish } = setup('ceo-inbox-send-draft', 65);
    // Raw lineage says principal, but a heartbeat wake with a score below the ladder threshold
    // is demoted to agent, so the gate refuses it.
    const woken = {
      taskEventId: 'task-1',
      taskMetadata: {
        wakeContext: { derived: false },
        originator: { contactId: 'p-1', systemRole: 'principal', channel: 'signal', initiatedAt: new Date().toISOString(), tier: 'principal' },
      },
    };
    const result = await layer.invoke('ceo-inbox-send-draft', { draft_id: 'd-1' }, undefined, woken);
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    const reports = publish.mock.calls.filter((c) => (c[1] as { type: string }).type === 'principal.report');
    expect(reports).toHaveLength(1);
  });

  it('a failed digest publish is logged and the gate error is unchanged', async () => {
    const { layer, publish } = setup('ceo-inbox-send-draft', 65);
    publish.mockRejectedValueOnce(new Error('bus down'));
    const result = await layer.invoke('ceo-inbox-send-draft', { draft_id: 'd-1' }, undefined, { taskEventId: 'task-1' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.endsWith(`${NO_APPROVAL_FOR_PRINCIPAL_MAILBOX_SEND}</skill_error>`)).toBe(true);
  });
});
