// execution-elevated-unverified.test.ts — an unauthenticated principal match (GHSA-p49r-jqh2-v668).
//
// A message that matches the principal's SMS number or email address, but whose channel did not
// prove the principal sent it, keeps the principal's identity and none of their authority. Where
// that authority is needed, the execution layer files a confirmation the principal answers on a
// verified channel, instead of refusing and leaving them to repeat themselves. An answer to an
// approval from such a channel re-sends that approval to a verified channel instead.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolHandler, ToolManifest } from '../../../src/skills/types.js';
import type { ApprovalDelivery } from '../../../src/autonomy/approval-delivery.js';

const logger = pino({ level: 'silent' });

function manifest(name: string, overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name, description: name, version: '1.0.0', sensitivity: 'elevated', action_risk: 'low',
    inputs: {}, outputs: {}, permissions: [], secrets: [], timeout: 5000, ...overrides,
  };
}

const principal = (channel: string, authenticated: boolean) => ({
  originator: { contactId: 'ceo-1', systemRole: 'principal' as const, channel, initiatedAt: '2026-11-17T12:00:00.000Z', tier: 'principal' as const, authenticated },
});

function setup() {
  const registry = new ToolRegistry();
  const execute = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: 'done' }));
  registry.register(manifest('contact-set-tier'), { execute });
  registry.register(manifest('approve-action', { action_risk: 'none', allowed_callers: ['coordinator'] }), { execute });
  registry.register(manifest('send-draft', { sensitivity: 'normal', action_risk: 'none' }), { execute });
  const request = vi.fn(async (_opts: Record<string, unknown>) => ({ created: true as const, rowId: 7, shortRef: 'abcd1234', approvalNumber: 3 }));
  const redeliverForVerification = vi.fn(async () => ({ delivered: true as const, channel: 'signal' as const }));
  const layer = new ExecutionLayer(registry, logger, {
    approvalTrigger: { request } as never,
    approvalDelivery: { redeliverForVerification } as unknown as ApprovalDelivery,
  });
  return { layer, execute, request, redeliverForVerification };
}

const invokeAs = (layer: ExecutionLayer, tool: string, input: Record<string, unknown>, metadata: Record<string, unknown>, liveTurn: boolean) =>
  layer.invoke(tool, input, undefined, { taskEventId: 'task-1', agentId: 'coordinator', liveTurn, taskMetadata: metadata });

describe('elevated gate on an unauthenticated principal turn (GHSA-p49r-jqh2-v668)', () => {
  it.each([['sms', 'SMS number'], ['email', 'email address']])('files a marked confirmation for an elevated tool on %s', async (channel, wording) => {
    const { layer, execute, request } = setup();
    const result = await invokeAs(layer, 'contact-set-tier', { tier: 'blocked' }, principal(channel, false), false);

    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({ taskId: 'task-1', toolName: 'contact-set-tier', input: { tier: 'blocked' }, requesterUnverified: true });
    expect(String(request.mock.calls[0]![0].reason)).toContain(wording);
    if (!result.success) {
      expect(result.gate).toBe('live_principal_turn');
      expect(result.error).toContain('approval 3');
      expect(result.error).toContain('never say Curia cannot do it');
      expect(result.error).not.toContain('ask them to repeat');
    }
  });

  it('runs the same elevated tool on an authenticated principal turn', async () => {
    const { layer, execute, request } = setup();
    const result = await invokeAs(layer, 'contact-set-tier', { tier: 'blocked' }, principal('signal', true), true);
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('re-sends an approval answered by SMS to a verified channel instead of resolving it', async () => {
    const { layer, execute, request, redeliverForVerification } = setup();
    const result = await invokeAs(layer, 'approve-action', { short_ref: '3' }, principal('sms', false), false);

    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(redeliverForVerification).toHaveBeenCalledWith('3', 'sms');
    if (!result.success) expect(result.error).toContain('sent approval 3 to the principal on Signal');
  });

  it('files a confirmation for send-draft on an unverified email turn, and the approved replay runs', async () => {
    const { layer, execute, request } = setup();
    const unverified = await invokeAs(layer, 'send-draft', { draft_id: 'd-1' }, principal('email', false), false);
    expect(unverified.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(request.mock.calls[0]![0]).toMatchObject({ toolName: 'send-draft', requesterUnverified: true });

    const replay = await layer.invoke('send-draft', { draft_id: 'd-1' }, undefined, { humanApproved: true, taskMetadata: principal('web', true) });
    expect(replay.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('when no confirmation can be filed, says nothing is waiting and where to ask again', async () => {
    const { layer, execute, request } = setup();
    request.mockRejectedValueOnce(new Error('db down'));
    const result = await invokeAs(layer, 'contact-set-tier', { tier: 'blocked' }, principal('sms', false), false);
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    if (!result.success) {
      expect(result.error).not.toContain('waiting for their go-ahead');
      expect(result.error).toContain('was not done');
      expect(result.error).toContain('ask again on Signal, Slack or the phone app');
    }
  });

  it('leaves a wake on the plain refusal', async () => {
    const { layer, request } = setup();
    const result = await invokeAs(layer, 'contact-set-tier', { tier: 'blocked' }, { ...principal('sms', false), wakeContext: { derived: false } }, false);
    expect(result.success).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
