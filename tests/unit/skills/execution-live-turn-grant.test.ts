// execution-live-turn-grant.test.ts — the elevated gate under a voice live-turn grant (#2495).
//
// A now hand-off from a live call carries liveTurn with a grant. While the grant is active the
// elevated gate passes. Once it lapses, liveTurn no longer counts, and an elevated call the
// principal directed files a confirmation request instead of failing bare. Wakes and tasks
// without a grant keep the #1126 refusal.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolContext, ToolHandler, ToolManifest } from '../../../src/skills/types.js';
import {
  issueLiveTurnGrant,
  lapsedLiveTurnGrantId,
  resetLiveTurnGrantsForTests,
} from '../../../src/autonomy/live-turn-grants.js';

const logger = pino({ level: 'silent' });

function makeManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: 'contact-set-tier',
    description: 'Set a contact tier',
    version: '1.0.0',
    sensitivity: 'elevated',
    action_risk: 'low',
    inputs: {},
    outputs: {},
    permissions: [],
    secrets: [],
    timeout: 5000,
    ...overrides,
  };
}

const principalMetadata = {
  originator: {
    contactId: 'ceo-1',
    systemRole: 'principal' as const,
    channel: 'voice',
    initiatedAt: '2026-11-06T12:00:00.000Z',
  },
};

function setup() {
  const registry = new ToolRegistry();
  const execute = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: 'tier set' }));
  registry.register(makeManifest(), { execute });
  const request = vi.fn(async (_opts: Record<string, unknown>) => ({ created: true as const, rowId: 7, shortRef: 'abcd1234', approvalNumber: 3 }));
  const layer = new ExecutionLayer(registry, logger, { approvalTrigger: { request } as never });
  return { registry, layer, execute, request };
}

describe('elevated gate under a live-turn grant (#2495)', () => {
  beforeEach(() => {
    resetLiveTurnGrantsForTests();
  });

  it('runs an elevated tool while the grant is active', async () => {
    const { layer, execute, request } = setup();
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    const result = await layer.invoke('contact-set-tier', { tier: 'blocked' }, undefined, {
      taskEventId: 'task-1',
      liveTurn: true,
      liveTurnGrantId: grant.id,
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('files a confirmation request instead of running once the grant is revoked', async () => {
    const { layer, execute, request } = setup();
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    grant.revoke();
    const result = await layer.invoke('contact-set-tier', { tier: 'blocked' }, undefined, {
      taskEventId: 'task-1',
      agentId: 'coordinator',
      liveTurn: true,
      liveTurnGrantId: grant.id,
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({ taskId: 'task-1', toolName: 'contact-set-tier', input: { tier: 'blocked' } });
    if (!result.success) {
      expect(result.error).toContain('needs the principal\'s confirmation');
      expect(result.error).toContain('never say Curia cannot do it');
      expect(result.error).toContain('approval 3');
      expect(result.error).not.toContain('live principal turn');
    }
  });

  it('files a confirmation request for an after_call hand-off (a grant that was never live)', async () => {
    const { layer, execute, request } = setup();
    const result = await layer.invoke('contact-set-tier', { tier: 'blocked' }, undefined, {
      taskEventId: 'task-2',
      liveTurnGrantId: lapsedLiveTurnGrantId(),
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('asks the principal to repeat the request when no approval can be filed', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: 'x' }));
    registry.register(makeManifest(), { execute });
    const layer = new ExecutionLayer(registry, logger);
    const result = await layer.invoke('contact-set-tier', {}, undefined, {
      taskEventId: 'task-3',
      liveTurnGrantId: lapsedLiveTurnGrantId(),
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    if (!result.success) expect(result.error).toContain('waiting for their go-ahead');
  });

  // Regression for #1126: a heartbeat-woken task never runs an elevated tool and never files
  // a confirmation either, even if a grant id somehow leaked onto it.
  it('keeps the bare refusal for a woken task, with or without a grant id', async () => {
    const { layer, execute, request } = setup();
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    const woken = { ...principalMetadata, wakeContext: { derived: true } };
    for (const grantId of [grant.id, lapsedLiveTurnGrantId(), undefined]) {
      const result = await layer.invoke('contact-set-tier', {}, undefined, {
        taskEventId: 'task-w',
        liveTurn: true,
        ...(grantId !== undefined ? { liveTurnGrantId: grantId } : {}),
        taskMetadata: woken,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('live principal turn');
    }
    expect(execute).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  // A scheduled or derived child task builds its own agent.task without the grant: bare refusal.
  it('keeps the bare refusal for a principal-lineage task that carries no grant', async () => {
    const { layer, execute, request } = setup();
    const result = await layer.invoke('contact-set-tier', {}, undefined, {
      taskEventId: 'task-c',
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('live principal turn');
    expect(execute).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('files nothing for a caller without principal lineage', async () => {
    const { layer, request } = setup();
    const result = await layer.invoke('contact-set-tier', {}, undefined, {
      taskEventId: 'task-x',
      liveTurnGrantId: lapsedLiveTurnGrantId(),
      taskMetadata: { originator: { contactId: 'c-9', systemRole: 'external', channel: 'voice', tier: 'known' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('live principal turn');
    expect(request).not.toHaveBeenCalled();
  });

  it('files nothing for a caller outside allowed_callers (bare refusal, nothing queued)', async () => {
    const { registry, layer, execute, request } = setup();
    registry.register(
      makeManifest({ name: 'coordinator-only', allowed_callers: ['coordinator'] }),
      { execute },
    );
    const result = await layer.invoke('coordinator-only', {}, undefined, {
      taskEventId: 'task-c',
      agentId: 'calendar',
      liveTurnGrantId: lapsedLiveTurnGrantId(),
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('still files a confirmation for a caller that is in allowed_callers', async () => {
    const { registry, layer, request, execute } = setup();
    registry.register(
      makeManifest({ name: 'coordinator-only', allowed_callers: ['coordinator'] }),
      { execute },
    );
    await layer.invoke('coordinator-only', {}, undefined, {
      taskEventId: 'task-d',
      agentId: 'coordinator',
      liveTurnGrantId: lapsedLiveTurnGrantId(),
      taskMetadata: principalMetadata,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('never files a confirmation for a tool that resolves approvals', async () => {
    const { registry, layer, request } = setup();
    registry.register(makeManifest({ name: 'approve-action' }), { execute: async () => ({ success: true, data: 'x' }) });
    const result = await layer.invoke('approve-action', { short_ref: 'abcd1234' }, undefined, {
      taskEventId: 'task-a',
      liveTurnGrantId: lapsedLiveTurnGrantId(),
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  // The confirmation is useful only if approving it runs the tool. Every approval path (approve-action,
  // a reaction, the console) replays with humanApproved inside the principal's live turn.
  it('runs the queued elevated tool when the principal approves it', async () => {
    const { layer, execute } = setup();
    const result = await layer.invoke('contact-set-tier', { tier: 'blocked' }, undefined, {
      humanApproved: true,
      liveTurn: true,
      taskEventId: 'task-1',
      taskMetadata: { originator: { contactId: 'ceo-1', systemRole: 'principal', channel: 'slack' } },
    });
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('hands skills a cleared liveTurn and the grant id once the grant lapses', async () => {
    const registry = new ToolRegistry();
    let seen: Pick<ToolContext, 'liveTurn' | 'liveTurnGrantId'> | undefined;
    registry.register(makeManifest({ name: 'delegate', sensitivity: 'normal', action_risk: 'none' }), {
      execute: async (ctx) => {
        seen = { liveTurn: ctx.liveTurn, liveTurnGrantId: ctx.liveTurnGrantId };
        return { success: true, data: 'ok' };
      },
    });
    const layer = new ExecutionLayer(registry, logger);
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });

    await layer.invoke('delegate', {}, undefined, { liveTurn: true, liveTurnGrantId: grant.id, taskMetadata: principalMetadata });
    expect(seen).toEqual({ liveTurn: true, liveTurnGrantId: grant.id });

    grant.revoke();
    await layer.invoke('delegate', {}, undefined, { liveTurn: true, liveTurnGrantId: grant.id, taskMetadata: principalMetadata });
    expect(seen).toEqual({ liveTurn: false, liveTurnGrantId: grant.id });
  });

  it('files a confirmation when the grant lapses between the entry check and the handler', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: 'tier set' }));
    registry.register(makeManifest(), { execute });
    const request = vi.fn(async (_opts: Record<string, unknown>) => ({ created: true as const, rowId: 8, shortRef: 'efgh5678', approvalNumber: 4 }));
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    // The autonomy read happens after the entry check; the call ends while it is in flight.
    const autonomyService = { getConfig: vi.fn(async () => { grant.revoke(); return null; }) };
    const layer = new ExecutionLayer(registry, logger, { approvalTrigger: { request } as never, autonomyService: autonomyService as never });
    const result = await layer.invoke('contact-set-tier', { tier: 'blocked' }, undefined, {
      taskEventId: 'task-4',
      agentId: 'coordinator',
      liveTurn: true,
      liveTurnGrantId: grant.id,
      taskMetadata: principalMetadata,
    });
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });
});
