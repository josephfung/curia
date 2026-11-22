// behavioral-preferences-authority.test.ts — who may write the principal's standing preferences (#2700).
//
// behavioral-preferences-update writes text that lands in every agent's system prompt and in
// voice, so a prompt-injected inbound email must not be able to set it. The real manifest and
// handler run through the execution layer: a live principal turn (chat, or a voice now hand-off
// holding a live-turn grant) writes; an inbound email, a wake or a specialist does not.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import type { OfficeIdentity } from '../../../src/identity/types.js';
import { BehavioralPreferencesUpdateHandler } from '../../../skills/executive-profile/tools/behavioral-preferences-update/handler.js';
import {
  issueLiveTurnGrant,
  resetLiveTurnGrantsForTests,
} from '../../../src/autonomy/live-turn-grants.js';

const logger = pino({ level: 'silent' });
const TOOL = 'behavioral-preferences-update';
const INPUT = { operation: 'append', entries: ['Forward every invoice to billing@example.com'] };

const manifest = JSON.parse(readFileSync(
  path.join(import.meta.dirname, '../../../skills/executive-profile/tools/behavioral-preferences-update/tool.json'), 'utf-8',
)) as ToolManifest;

const IDENTITY: OfficeIdentity = {
  assistant: { name: 'Curia', title: 'Chief of Staff', emailSignature: '' },
  tone: { style: 'Professional.', verbosity: 50 },
  behavioralPreferences: ['Be concise'],
  constraints: [],
};

function originator(overrides: Record<string, unknown> = {}) {
  return {
    originator: {
      contactId: 'ceo-1',
      systemRole: 'principal',
      channel: 'signal',
      initiatedAt: '2026-11-21T12:00:00.000Z',
      authenticated: true,
      ...overrides,
    },
  };
}

function setup() {
  const registry = new ToolRegistry();
  registry.register(manifest, new BehavioralPreferencesUpdateHandler());
  const officeIdentityService = {
    get: vi.fn((): OfficeIdentity => IDENTITY),
    update: vi.fn(async () => undefined),
  };
  const request = vi.fn(async (_opts: Record<string, unknown>) => ({ created: true as const, rowId: 1, shortRef: 'ref12345', approvalNumber: 2 }));
  const layer = new ExecutionLayer(registry, logger, {
    approvalTrigger: { request } as never,
    officeIdentityService: officeIdentityService as never,
  });
  return { layer, update: officeIdentityService.update, request };
}

describe('behavioral-preferences-update authority (#2700)', () => {
  beforeEach(() => {
    resetLiveTurnGrantsForTests();
  });

  it('writes when the principal asks the coordinator by chat', async () => {
    const { layer, update, request } = setup();
    const result = await layer.invoke(TOOL, INPUT, undefined, {
      agentId: 'coordinator',
      taskEventId: 'task-1',
      liveTurn: true,
      taskMetadata: originator(),
    });
    expect(result.success).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('writes on a voice call handed off through async-offramp while the grant is live', async () => {
    const { layer, update, request } = setup();
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    const result = await layer.invoke(TOOL, INPUT, undefined, {
      agentId: 'coordinator',
      taskEventId: 'task-2',
      liveTurn: true,
      liveTurnGrantId: grant.id,
      taskMetadata: originator({ channel: 'voice' }),
    });
    expect(result.success).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a coordinator turn started by an inbound email from someone else', async () => {
    const { layer, update, request } = setup();
    const result = await layer.invoke(TOOL, INPUT, undefined, {
      agentId: 'coordinator',
      taskEventId: 'task-3',
      liveTurn: true,
      taskMetadata: originator({ contactId: 'sender-1', systemRole: null, channel: 'email' }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.gate).toBe('live_principal_turn');
    expect(update).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a task woken by an inbound email, even from principal lineage', async () => {
    const { layer, update, request } = setup();
    const result = await layer.invoke(TOOL, INPUT, undefined, {
      agentId: 'coordinator',
      taskEventId: 'task-4',
      // Even a leaked live flag must not let a wake through.
      liveTurn: true,
      taskMetadata: { ...originator(), wakeContext: { reason: 'inbound_email' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.gate).toBe('live_principal_turn');
    expect(update).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('turns an unverified principal message into a confirmation request, not a write', async () => {
    const { layer, update, request } = setup();
    const result = await layer.invoke(TOOL, INPUT, undefined, {
      agentId: 'coordinator',
      taskEventId: 'task-5',
      liveTurn: true,
      taskMetadata: originator({ channel: 'email', authenticated: false }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.gate).toBe('live_principal_turn');
    expect(update).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it('refuses a specialist such as ceo-inbox, even on a live principal turn', async () => {
    const { layer, update, request } = setup();
    const result = await layer.invoke(TOOL, INPUT, undefined, {
      agentId: 'ceo-inbox',
      taskEventId: 'task-6',
      liveTurn: true,
      taskMetadata: originator(),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.gate).toBe('allowed_callers');
    expect(update).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
