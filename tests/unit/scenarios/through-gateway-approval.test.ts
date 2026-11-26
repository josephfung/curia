// Review Focus 4 end to end, without a database (#2312): in a through-gateway run a send
// gated on a third party's turn raises an approval row; the principal's later turn (an
// `inbound.then`, its own conversation filed under the run) approves it through the real
// approve-action and the execution layer's elevated gate; the replay goes through the
// recording gateway; the delivery lands in the run that made it, and no other.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApproveActionHandler } from '../../../skills/approvals/tools/approve-action/handler.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ActionLogInsert, ActionLogRow, ResolveResult } from '../../../src/autonomy/action-log-types.js';
import { ApprovalTriggerService } from '../../../src/autonomy/approval-trigger.js';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import { EventBus } from '../../../src/bus/bus.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import { createLogger } from '../../../src/logger.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import { createRecordingOutboundGateway } from '../../../src/startup/test-mode-sends.js';
import { createCaseContext, newAttempt, type CaseAttempt } from '../../shared/case-scope.js';
import { scopedActionLog, SeedScope } from '../../scenarios/seed.js';
import { createStubController } from '../../scenarios/stub-layer.js';

const logger = createLogger('error');
const REPO = path.resolve(import.meta.dirname, '../../..');

/** An in-memory action log with the methods the gate, the trigger and approve-action call. */
function memoryActionLog() {
  const rows: ActionLogRow[] = [];
  let next = 1;
  const pending = () => rows.filter(r => r.outcome === 'pending_approval');
  const repo = {
    rows,
    insert: async (row: ActionLogInsert): Promise<number> => {
      const id = next++;
      rows.push({
        id, taskId: row.taskId, conversationId: row.conversationId ?? null, toolName: row.toolName,
        actionRisk: row.actionRisk, outcome: row.outcome, shortRef: row.shortRef ?? null,
        approvalNumber: row.outcome === 'pending_approval' ? id : null, description: row.description ?? null,
        payload: row.payload ?? null, createdAt: new Date(), expiresAt: row.expiresAt ?? null, notificationSentAt: null,
        parentActionId: row.parentActionId ?? null,
      } as ActionLogRow);
      return id;
    },
    findApprovalNumber: async (id: number) => rows.find(r => r.id === id)?.approvalNumber ?? null,
    findPendingByTaskAndSkill: async () => null,
    findPendingByTaskAndSkills: async () => [],
    findAllPending: async () => pending(),
    findPendingByShortRef: async (ref: string) => pending().find(r => r.shortRef === ref) ?? null,
    findPendingByApprovalNumber: async (n: number) => pending().find(r => r.approvalNumber === n) ?? null,
    resolvePending: async (ref?: string): Promise<ResolveResult> => {
      const hit = ref === undefined ? pending() : pending().filter(r => r.shortRef === ref || String(r.approvalNumber) === ref);
      if (hit.length === 1) return { found: true, row: hit[0]! };
      if (hit.length > 1) return { found: false, reason: 'ambiguous', error: 'Multiple pending requests', pending: hit };
      return { found: false, reason: 'not_found', error: `No approval request found with reference '${ref}'.` };
    },
    resolveRow: async (id: number, outcome: string) => {
      const row = rows.find(r => r.id === id && r.outcome === 'pending_approval');
      if (!row) return false;
      (row as { outcome: string }).outcome = outcome;
      return true;
    },
    rejectStaleApproval: async () => true,
    insertSampled: async () => 0,
    claimNotification: vi.fn(async () => true),
    releaseNotification: vi.fn(async () => {}),
    bindDeliveryMessage: vi.fn(async () => true),
  };
  return repo;
}

function manifestFrom(tool: string): ToolManifest {
  return JSON.parse(readFileSync(path.join(REPO, 'skills/autonomy/tools', tool, 'tool.json'), 'utf-8')) as ToolManifest;
}

type RunState = CaseAttempt & { scope: SeedScope };

describe('a held send approved on a later principal turn (inbound.then)', () => {
  it('holds, records the approval row, approves it from the second turn, and records the replayed delivery in the run', async () => {
    const context = createCaseContext<RunState>();
    const currentScope = () => context.current()?.scope;
    const bus = new EventBus(logger);
    const memory = memoryActionLog();
    const actionLog = scopedActionLog(memory as unknown as ActionLogRepo, currentScope);
    const displays: string[] = [];
    const approvalDelivery = { registerDisplay: (ref: string) => { displays.push(ref); } };

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      getContact: vi.fn().mockResolvedValue(null),
    } as unknown as ContactService;
    const gateway = createRecordingOutboundGateway({
      recorder: {
        record: (send) => {
          const scope = currentScope();
          if (!scope) throw new Error('a send outside every run');
          scope.deliveries.push(send);
        },
        message: () => undefined,
      },
      emailAccounts: [{ name: 'curia', selfEmail: 'curia@example.test' }],
      contactService,
      bus,
      logger,
      principalIdentities: [],
      review: { contentFilter: new OutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '' }), actionLogRepo: actionLog },
    });

    // A score below 60: Gate A holds every non-read tool a non-principal started.
    const autonomy = { getConfig: async () => ({ score: 50, band: 'restricted', updatedAt: new Date(), updatedBy: 'test', gating: 'tier' }) } as unknown as AutonomyService;
    const registry = new ToolRegistry();
    registry.register(manifestFrom('approve-action'), new ApproveActionHandler());
    const sendManifest: ToolManifest = {
      name: 'email-send', description: 'send', version: '0.1.0', action_risk: 'medium', sensitivity: 'normal',
      permissions: [], secrets: [], timeout: 5000, inputs: {}, outputs: {}, capabilities: ['outboundGateway'],
    };
    registry.register(sendManifest, {
      execute: async (ctx) => {
        const result = await ctx.outboundGateway!.send(
          { channel: 'email', to: 'pat@vendorco.test', subject: 'Forms', body: 'Here are the forms.' },
          { taskEventId: ctx.taskEventId, conversationId: ctx.conversationId, humanApproved: ctx.humanApproved },
        );
        return result.success ? { success: true, data: { sent: true } } : { success: false, error: result.blockedReason ?? 'blocked' };
      },
    });
    const layerOptions = { bus, autonomyService: autonomy };
    const base = new ExecutionLayer(registry, logger, layerOptions);
    const review = new ExecutionLayer(registry, logger, {
      ...layerOptions,
      outboundGateway: gateway,
      actionLogRepo: actionLog,
      approvalTrigger: new ApprovalTriggerService(actionLog, logger, bus, approvalDelivery),
      disclosureDecisions: { recordForApproval: vi.fn(async () => {}) },
    });
    const controller = createStubController(() => registry, () => new Set(['approve-action']));
    const layer = controller.wrap(base, review);

    const state: RunState = { ...newAttempt('A'), scope: new SeedScope() };
    state.scope.rootConversation = 'scenario-a';
    // Another run's pending approval: a bare "approve" must never pick it.
    await memory.insert({ taskId: 'other', conversationId: 'scenario-b', toolName: 'email-send', actionRisk: 'medium', outcome: 'pending_approval', shortRef: 'bbbb2222', payload: {} });

    await context.run(state, async () => {
      controller.beginRun({}, 'scenario-a', { throughGateway: true });
      // Turn 1: a known contact's email starts the send.
      const held = await layer.invoke('email-send', { to: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', subject: 'Forms', body: 'Here are the forms.' }, undefined, {
        agentId: 'coordinator', conversationId: 'scenario-a', taskEventId: 'task-1',
        taskMetadata: { originator: { contactId: 'pat-1', systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'known' } },
      });
      expect(held.success).toBe(false);
      if (!held.success) expect(held.error).toMatch(/blocked/);
      expect(state.scope.deliveries).toEqual([]);
      const row = memory.rows.find(r => r.conversationId === 'scenario-a')!;
      expect(row).toMatchObject({ outcome: 'pending_approval', toolName: 'email-send' });
      expect(displays).toEqual([row.shortRef]);

      // Turn 2: the principal's own message, a conversation filed under the run.
      state.scope.followOnConversations.add('scenario-then-1');
      controller.attach('scenario-a', 'scenario-then-1');
      const approved = await layer.invoke('approve-action', {}, undefined, {
        agentId: 'coordinator', conversationId: 'scenario-then-1', taskEventId: 'task-2', liveTurn: true,
        taskMetadata: { originator: { contactId: 'principal-1', systemRole: 'principal', channel: 'signal', initiatedAt: new Date().toISOString(), tier: 'principal', authenticated: true } },
      });
      expect(approved).toMatchObject({ success: true, data: { reExecutionSuccess: true } });
      expect(row.outcome).toBe('approved');
      // The foreign row is untouched.
      expect(memory.rows.find(r => r.shortRef === 'bbbb2222')!.outcome).toBe('pending_approval');

      const calls = controller.endRun('scenario-a');
      expect(calls.map(c => [c.toolName, c.disposition])).toEqual([['email-send', 'passthrough'], ['approve-action', 'passthrough']]);
    });
    // The replay went through the recording gateway, into this run.
    expect(state.scope.deliveries).toEqual([expect.objectContaining({ channel: 'email', kind: 'send', to: ['pat@vendorco.test'], subject: 'Forms' })]);
  });

  it('refuses approve-action without a live principal turn, even in a through-gateway run', async () => {
    const registry = new ToolRegistry();
    registry.register(manifestFrom('approve-action'), new ApproveActionHandler());
    const review = new ExecutionLayer(registry, logger, { bus: new EventBus(logger), actionLogRepo: memoryActionLog() as unknown as ActionLogRepo, disclosureDecisions: { recordForApproval: async () => {} } });
    const controller = createStubController(() => registry);
    const layer = controller.wrap(new ExecutionLayer(registry, logger), review);
    controller.beginRun({}, 'scenario-a', { throughGateway: true });
    const result = await layer.invoke('approve-action', {}, undefined, { agentId: 'coordinator', conversationId: 'scenario-a', taskEventId: 't' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/live principal turn/);
    controller.endRun('scenario-a');
  });
});
