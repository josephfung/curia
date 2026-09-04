/**
 * Unit tests for dispatcher relay Gate C (#1733).
 *
 * Covers: known-tier third-party-axis relay escalates, principal relay allows,
 * and a skill-blocked turn does not deliver via relay.
 */

import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import {
  createAgentResponse,
  createAuthorizationDecision,
  createToolResult,
  type AuthorizationDecisionEvent,
  type BusEvent,
  type OutboundMessageEvent,
} from '../../../src/bus/events.js';
import type { ContactTier, TaskOriginator } from '../../../src/contacts/types.js';
import {
  decideRelayGateC,
  isGateCBlockError,
  RELAY_GATE_C_ACTION,
} from '../../../src/dispatch/relay-gate-c.js';
import type { ApprovalTriggerService } from '../../../src/autonomy/approval-trigger.js';

function makeOriginator(tier: ContactTier | null, systemRole: TaskOriginator['systemRole'] = null): TaskOriginator {
  return {
    contactId: 'contact-1',
    systemRole,
    channel: 'email',
    initiatedAt: new Date().toISOString(),
    tier,
  };
}

describe('decideRelayGateC', () => {
  it('escalates known-tier relay (third-party axis ambiguous → fail closed)', () => {
    const outcome = decideRelayGateC(makeOriginator('known'));
    expect(outcome).toEqual({
      kind: 'decide',
      decision: 'escalate',
      tier: 'known',
      reason: 'third_party_axis_ambiguous_fail_closed',
    });
  });

  it('escalates unknown-tier relay', () => {
    const outcome = decideRelayGateC(makeOriginator('unknown'));
    expect(outcome.kind).toBe('decide');
    if (outcome.kind !== 'decide') return;
    expect(outcome.decision).toBe('escalate');
    expect(outcome.tier).toBe('unknown');
  });

  it('allows principal-tier relay', () => {
    const outcome = decideRelayGateC(makeOriginator('principal', 'principal'));
    expect(outcome).toEqual({
      kind: 'decide',
      decision: 'allow',
      tier: 'principal',
      reason: 'tier_permits_external_send',
    });
  });

  it('allows trusted-tier relay', () => {
    const outcome = decideRelayGateC(makeOriginator('trusted'));
    expect(outcome.kind).toBe('decide');
    if (outcome.kind !== 'decide') return;
    expect(outcome.decision).toBe('allow');
  });

  it('skips system-originated tasks', () => {
    const outcome = decideRelayGateC(makeOriginator(null, 'system'));
    expect(outcome).toEqual({ kind: 'skip', reason: 'system_or_agent' });
  });

  it('skips when originator is absent', () => {
    expect(decideRelayGateC(undefined)).toEqual({
      kind: 'skip',
      reason: 'no_external_originator',
    });
  });
});

describe('isGateCBlockError', () => {
  it('recognizes tier-gate error strings', () => {
    expect(isGateCBlockError("Tool 'email-reply' blocked — the initiating contact's tier ('known') does not permit")).toBe(true);
    expect(isGateCBlockError('external originator has no resolved tier')).toBe(true);
    expect(isGateCBlockError('failed to audit Gate C authorization.decision')).toBe(true);
  });

  it('ignores score-gate and unrelated errors', () => {
    expect(isGateCBlockError("Tool 'email-reply' blocked — autonomy score is 50")).toBe(false);
    expect(isGateCBlockError('Nylas API error')).toBe(false);
    expect(isGateCBlockError(undefined)).toBe(false);
  });
});

type RoutingEntry = {
  channelId: string;
  conversationId: string;
  senderId: string;
  humanReplySent: boolean;
  replySkillGateCBlocked: boolean;
  originator?: TaskOriginator;
};

function makeStubs(opts: { approvalTrigger?: ApprovalTriggerService } = {}) {
  const publishedEvents: BusEvent[] = [];
  const subscribeHandlers = new Map<string, (event: BusEvent) => void | Promise<void>>();

  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: BusEvent) => void | Promise<void>) => {
      subscribeHandlers.set(eventType, handler);
    }),
    publish: vi.fn(async (_layer: string, event: BusEvent) => {
      publishedEvents.push(event);
    }),
  } as unknown as EventBus;

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;

  const dispatcher = new Dispatcher({
    bus,
    logger,
    approvalTrigger: opts.approvalTrigger,
  });

  return { dispatcher, bus, publishedEvents, subscribeHandlers };
}

function seedRouting(
  dispatcher: Dispatcher,
  taskEventId: string,
  opts: Partial<RoutingEntry> = {},
) {
  (dispatcher as unknown as { taskRouting: Map<string, RoutingEntry> }).taskRouting.set(taskEventId, {
    channelId: opts.channelId ?? 'email',
    conversationId: opts.conversationId ?? 'conv-1',
    senderId: opts.senderId ?? 'dana@example.com',
    humanReplySent: opts.humanReplySent ?? false,
    replySkillGateCBlocked: opts.replySkillGateCBlocked ?? false,
    originator: opts.originator,
  });
}

describe('Dispatcher relay Gate C (#1733)', () => {
  it('withholds outbound.message and emits authorization.decision escalate for known-tier relay', async () => {
    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-known', {
      originator: makeOriginator('known'),
    });

    const handler = subscribeHandlers.get('agent.response')!;
    await handler(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Thanks for the update.',
      parentEventId: 'task-known',
    }));

    expect(publishedEvents.filter((e): e is OutboundMessageEvent => e.type === 'outbound.message')).toHaveLength(0);

    const authz = publishedEvents.filter(
      (e): e is AuthorizationDecisionEvent => e.type === 'authorization.decision',
    );
    expect(authz).toHaveLength(1);
    expect(authz[0]!.payload).toMatchObject({
      decision: 'escalate',
      gate: 'gate_c',
      action: RELAY_GATE_C_ACTION,
      tier: 'known',
    });
    expect(authz[0]!.sourceLayer).toBe('dispatch');
  });

  it('allows principal-tier relay and emits authorization.decision allow', async () => {
    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-principal', {
      senderId: 'ceo@example.com',
      originator: makeOriginator('principal', 'principal'),
    });

    const handler = subscribeHandlers.get('agent.response')!;
    await handler(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Here is your briefing.',
      parentEventId: 'task-principal',
    }));

    const outbound = publishedEvents.filter(
      (e): e is OutboundMessageEvent => e.type === 'outbound.message',
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.payload.content).toBe('Here is your briefing.');

    const authz = publishedEvents.filter(
      (e): e is AuthorizationDecisionEvent => e.type === 'authorization.decision',
    );
    expect(authz).toHaveLength(1);
    expect(authz[0]!.payload).toMatchObject({
      decision: 'allow',
      gate: 'gate_c',
      action: RELAY_GATE_C_ACTION,
      tier: 'principal',
    });
  });

  it('does not deliver via relay when a reply skill was Gate C blocked on the same turn', async () => {
    const approvalRequest = vi.fn();
    const approvalTrigger = {
      request: approvalRequest,
    } as unknown as ApprovalTriggerService;

    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs({ approvalTrigger });
    dispatcher.register();

    seedRouting(dispatcher, 'task-blocked', {
      conversationId: 'conv-blocked',
      originator: makeOriginator('known'),
    });

    // Simulate email-reply Gate C failure via tool.result (conversationId match).
    const toolHandler = subscribeHandlers.get('tool.result')!;
    await toolHandler(createToolResult({
      agentId: 'coordinator',
      conversationId: 'conv-blocked',
      toolName: 'email-reply',
      result: {
        success: false,
        error: "Tool 'email-reply' blocked — the initiating contact's tier ('known') does not permit medium-risk actions without approval.",
      },
      durationMs: 5,
      parentEventId: 'invoke-1',
    }));

    const responseHandler = subscribeHandlers.get('agent.response')!;
    await responseHandler(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-blocked',
      content: 'Thanks — I will follow up.',
      parentEventId: 'task-blocked',
    }));

    expect(publishedEvents.filter((e) => e.type === 'outbound.message')).toHaveLength(0);
    // Skill path already owns the approval — relay must not create another.
    expect(approvalRequest).not.toHaveBeenCalled();
    // No new Gate C decision from the relay either (skill already audited the escalate).
    expect(publishedEvents.filter((e) => e.type === 'authorization.decision')).toHaveLength(0);
  });

  it('marks replySkillGateCBlocked from authorization.decision escalate on a reply skill', async () => {
    const { dispatcher, subscribeHandlers } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-authz', {
      originator: makeOriginator('known'),
    });

    const authHandler = subscribeHandlers.get('authorization.decision')!;
    await authHandler(createAuthorizationDecision({
      decision: 'escalate',
      gate: 'gate_c',
      tier: 'known',
      action: 'email-reply',
      subjectSummary: 'Gate C escalate',
      taskEventId: 'task-authz',
      sourceLayer: 'execution',
    }));

    const routing = (dispatcher as unknown as {
      taskRouting: Map<string, RoutingEntry>;
    }).taskRouting.get('task-authz')!;
    expect(routing.replySkillGateCBlocked).toBe(true);
  });

  it('joins an existing pending approval instead of creating a duplicate on relay escalate', async () => {
    const approvalRequest = vi.fn().mockResolvedValue({
      created: false,
      reason: 'duplicate',
      existingShortRef: 'abc12def',
    });
    const approvalTrigger = {
      request: approvalRequest,
    } as unknown as ApprovalTriggerService;

    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs({ approvalTrigger });
    dispatcher.register();

    seedRouting(dispatcher, 'task-dup', {
      originator: makeOriginator('unknown'),
    });

    const handler = subscribeHandlers.get('agent.response')!;
    await handler(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Hello stranger.',
      parentEventId: 'task-dup',
    }));

    expect(publishedEvents.filter((e) => e.type === 'outbound.message')).toHaveLength(0);
    expect(approvalRequest).toHaveBeenCalledOnce();
    expect(approvalRequest.mock.calls[0]![0]).toMatchObject({
      taskId: 'task-dup',
      toolName: RELAY_GATE_C_ACTION,
      dedupeAnyPendingOnTask: true,
    });
  });
});
