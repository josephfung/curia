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
  const layer = new ExecutionLayer(registry, logger, {
    autonomyService,
    approvalTrigger: { request } as never,
    bus: { publish: vi.fn(async () => undefined) } as unknown as EventBus,
  });
  return { layer, execute, request };
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
});
