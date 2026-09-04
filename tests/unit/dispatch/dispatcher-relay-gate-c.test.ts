/**
 * Unit tests for dispatcher relay Gate C (#1733).
 *
 * Covers: EscalationJudge on the known-tier ambiguous cell, principal allow,
 * skill-blocked suppress via authorization.decision + conversationId, HTTP
 * pending-status settlement, approve-path approval payload, and an end-to-end
 * known-tier inbound → escalate path (not hand-seeded routing alone).
 */

import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import {
  createAgentResponse,
  createAuthorizationDecision,
  createInboundMessage,
  type AuthorizationDecisionEvent,
  type BusEvent,
  type OutboundMessageEvent,
} from '../../../src/bus/events.js';
import type { ContactTier, TaskOriginator } from '../../../src/contacts/types.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import {
  decideRelayGateC,
  RELAY_GATE_C_ACTION,
  RELAY_GATE_C_HTTP_PENDING_MESSAGE,
  REPLY_SKILLS_GATE_C,
} from '../../../src/dispatch/relay-gate-c.js';
import type { ApprovalTriggerService } from '../../../src/autonomy/approval-trigger.js';
import type { EscalationJudge } from '../../../src/autonomy/escalation-judge.js';

function makeOriginator(tier: ContactTier | null, systemRole: TaskOriginator['systemRole'] = null): TaskOriginator {
  return {
    contactId: 'contact-1',
    systemRole,
    channel: 'email',
    initiatedAt: new Date().toISOString(),
    tier,
  };
}

function makeJudge(verdict: {
  isThirdPartyFacing?: boolean;
  actionClass?: 'read' | 'reversible-external' | 'irreversible';
}): EscalationJudge {
  return {
    isEnabled: () => true,
    classifyAction: vi.fn().mockResolvedValue({
      actionClass: verdict.actionClass ?? 'reversible-external',
      isThirdPartyFacing: verdict.isThirdPartyFacing,
    }),
  } as unknown as EscalationJudge;
}

describe('decideRelayGateC', () => {
  const base = {
    content: 'Thanks for the update.',
    conversationId: 'conv-1',
    channelId: 'email' as const,
  };

  it('escalates known-tier when no judge is wired (ambiguous cell fail-closed)', async () => {
    const outcome = await decideRelayGateC({
      originator: makeOriginator('known'),
      ...base,
    });
    expect(outcome).toEqual({
      kind: 'decide',
      decision: 'escalate',
      tier: 'known',
      reason: 'third_party_axis_ambiguous_no_judge',
    });
  });

  it('allows known-tier when the judge says reply-to-sender', async () => {
    const outcome = await decideRelayGateC({
      originator: makeOriginator('known'),
      ...base,
      escalationJudge: makeJudge({ isThirdPartyFacing: false }),
    });
    expect(outcome).toEqual({
      kind: 'decide',
      decision: 'allow',
      tier: 'known',
      reason: 'judge_reply_to_sender',
    });
  });

  it('escalates known-tier when the judge says third-party-facing', async () => {
    const outcome = await decideRelayGateC({
      originator: makeOriginator('known'),
      ...base,
      escalationJudge: makeJudge({ isThirdPartyFacing: true }),
    });
    expect(outcome).toEqual({
      kind: 'decide',
      decision: 'escalate',
      tier: 'known',
      reason: 'judge_third_party_facing',
    });
  });

  it('escalates unknown-tier relay', async () => {
    const outcome = await decideRelayGateC({
      originator: makeOriginator('unknown'),
      ...base,
    });
    expect(outcome.kind).toBe('decide');
    if (outcome.kind !== 'decide') return;
    expect(outcome.decision).toBe('escalate');
    expect(outcome.tier).toBe('unknown');
  });

  it('allows principal-tier relay', async () => {
    const outcome = await decideRelayGateC({
      originator: makeOriginator('principal', 'principal'),
      ...base,
    });
    expect(outcome).toEqual({
      kind: 'decide',
      decision: 'allow',
      tier: 'principal',
      reason: 'tier_permits_external_send',
    });
  });

  it('allows trusted-tier relay', async () => {
    const outcome = await decideRelayGateC({
      originator: makeOriginator('trusted'),
      ...base,
    });
    expect(outcome.kind).toBe('decide');
    if (outcome.kind !== 'decide') return;
    expect(outcome.decision).toBe('allow');
  });

  it('skips system-originated tasks', async () => {
    const outcome = await decideRelayGateC({
      originator: makeOriginator(null, 'system'),
      ...base,
    });
    expect(outcome).toEqual({ kind: 'skip', reason: 'system_or_agent' });
  });

  it('skips when originator is absent (reason: originator_absent)', async () => {
    expect(
      await decideRelayGateC({
        originator: undefined,
        ...base,
      }),
    ).toEqual({
      kind: 'skip',
      reason: 'originator_absent',
    });
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

function makeStubs(opts: {
  approvalTrigger?: ApprovalTriggerService;
  escalationJudge?: EscalationJudge;
  contactResolver?: ContactResolver;
} = {}) {
  const publishedEvents: BusEvent[] = [];
  const subscribeHandlers = new Map<string, (event: BusEvent) => void | Promise<void>>();

  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: BusEvent) => void | Promise<void>) => {
      subscribeHandlers.set(eventType, handler);
    }),
    publish: vi.fn(async (_layer: string, event: BusEvent) => {
      publishedEvents.push(event);
      // Deliver to in-process subscribers so inbound → agent.task → response chaining works.
      const handler = subscribeHandlers.get(event.type);
      if (handler) await handler(event);
    }),
  } as unknown as EventBus;

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;

  const dispatcher = new Dispatcher({
    bus,
    logger,
    approvalTrigger: opts.approvalTrigger,
    escalationJudge: opts.escalationJudge,
    contactResolver: opts.contactResolver,
    channelPolicies: {
      email: { trust: 'medium', unknownSender: 'allow', threaded: true },
      http: { trust: 'medium', unknownSender: 'allow', threaded: false },
    },
  });

  return { dispatcher, bus, publishedEvents, subscribeHandlers, logger };
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

function makeKnownContactResolver(): ContactResolver {
  return {
    resolve: async () => ({
      resolved: true,
      contactId: 'known-contact-1',
      displayName: 'Dana Known',
      role: null,
      systemRole: null,
      tier: 'known' as ContactTier,
      kind: 'person',
      verified: true,
      kgNodeId: null,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: 0.7,
    }),
  } as unknown as ContactResolver;
}

describe('Dispatcher relay Gate C (#1733)', () => {
  it('withholds outbound.message and emits authorization.decision escalate for known-tier (no judge)', async () => {
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
      conversationId: 'conv-1',
    });
    expect(authz[0]!.sourceLayer).toBe('dispatch');
  });

  it('allows known-tier relay when EscalationJudge says reply-to-sender', async () => {
    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs({
      escalationJudge: makeJudge({ isThirdPartyFacing: false }),
    });
    dispatcher.register();

    seedRouting(dispatcher, 'task-known-allow', {
      originator: makeOriginator('known'),
    });

    await subscribeHandlers.get('agent.response')!(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Thanks — see you Thursday.',
      parentEventId: 'task-known-allow',
    }));

    const outbound = publishedEvents.filter(
      (e): e is OutboundMessageEvent => e.type === 'outbound.message',
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.payload.content).toBe('Thanks — see you Thursday.');
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

  it('suppresses relay when authorization.decision escalate matches by conversationId', async () => {
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

    // Skill path audited Gate C via authorization.decision (structured — not error prose).
    await subscribeHandlers.get('authorization.decision')!(createAuthorizationDecision({
      decision: 'escalate',
      gate: 'gate_c',
      tier: 'known',
      action: 'email-reply',
      subjectSummary: 'Gate C escalate',
      conversationId: 'conv-blocked',
      // Deliberately omit taskEventId — delegated specialist case.
      sourceLayer: 'execution',
    }));

    await subscribeHandlers.get('agent.response')!(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-blocked',
      content: 'Thanks — I will follow up.',
      parentEventId: 'task-blocked',
    }));

    expect(publishedEvents.filter((e) => e.type === 'outbound.message')).toHaveLength(0);
    expect(approvalRequest).not.toHaveBeenCalled();
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
      conversationId: 'conv-1',
      sourceLayer: 'execution',
    }));

    const routing = (dispatcher as unknown as {
      taskRouting: Map<string, RoutingEntry>;
    }).taskRouting.get('task-authz')!;
    expect(routing.replySkillGateCBlocked).toBe(true);
  });

  it('requests approval with dispatcher-relay payload suitable for approve-action re-exec', async () => {
    const approvalRequest = vi.fn().mockResolvedValue({
      created: true,
      shortRef: 'abcd1234',
      rowId: 1,
    });
    const approvalTrigger = {
      request: approvalRequest,
    } as unknown as ApprovalTriggerService;

    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs({ approvalTrigger });
    dispatcher.register();

    seedRouting(dispatcher, 'task-approve', {
      conversationId: 'conv-approve',
      senderId: 'dana@example.com',
      originator: makeOriginator('unknown'),
    });

    await subscribeHandlers.get('agent.response')!(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-approve',
      content: 'Hello stranger.',
      parentEventId: 'task-approve',
    }));

    expect(publishedEvents.filter((e) => e.type === 'outbound.message')).toHaveLength(0);
    expect(approvalRequest).toHaveBeenCalledOnce();
    expect(approvalRequest.mock.calls[0]![0]).toMatchObject({
      taskId: 'task-approve',
      toolName: RELAY_GATE_C_ACTION,
      dedupePendingSkillsOnTask: expect.arrayContaining([...REPLY_SKILLS_GATE_C]),
      input: {
        channelId: 'email',
        to: 'dana@example.com',
        body: 'Hello stranger.',
        conversationId: 'conv-approve',
      },
    });
  });

  it('settles HTTP waiter with pending-approval status on escalate', async () => {
    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-http', {
      channelId: 'http',
      conversationId: 'http-conv-1',
      senderId: 'http-user',
      originator: makeOriginator('unknown'),
    });

    await subscribeHandlers.get('agent.response')!(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'http-conv-1',
      content: 'Secret reply that must not leak.',
      parentEventId: 'task-http',
    }));

    const outbound = publishedEvents.filter(
      (e): e is OutboundMessageEvent => e.type === 'outbound.message',
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.payload.content).toBe(RELAY_GATE_C_HTTP_PENDING_MESSAGE);
    expect(outbound[0]!.payload.content).not.toContain('Secret reply');
  });

  it('end-to-end: known-tier inbound through handleInbound escalates the relay', async () => {
    const approvalRequest = vi.fn().mockResolvedValue({ created: true, shortRef: 'e2e00001', rowId: 9 });
    const { dispatcher, publishedEvents, subscribeHandlers } = makeStubs({
      approvalTrigger: { request: approvalRequest } as unknown as ApprovalTriggerService,
      contactResolver: makeKnownContactResolver(),
    });
    dispatcher.register();

    // Real inbound path — stamps originator via stampOriginator, not hand-seeded routing.
    await subscribeHandlers.get('inbound.message')!(createInboundMessage({
      conversationId: 'email:thread-e2e',
      channelId: 'email',
      senderId: 'dana@example.com',
      content: 'Can we meet Thursday?',
      metadata: { trustLevel: 'medium' },
    }));

    const tasks = publishedEvents.filter((e) => e.type === 'agent.task');
    expect(tasks).toHaveLength(1);
    const taskId = tasks[0]!.id;
    const originator = (tasks[0] as { payload: { metadata?: { originator?: TaskOriginator } } })
      .payload.metadata?.originator;
    expect(originator?.tier).toBe('known');

    await subscribeHandlers.get('agent.response')!(createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-e2e',
      content: 'Thursday works — I will send a hold.',
      parentEventId: taskId,
    }));

    expect(publishedEvents.filter((e) => e.type === 'outbound.message')).toHaveLength(0);
    const authz = publishedEvents.filter((e) => e.type === 'authorization.decision');
    expect(authz.some((e) =>
      e.type === 'authorization.decision' &&
      e.payload.action === RELAY_GATE_C_ACTION &&
      e.payload.decision === 'escalate',
    )).toBe(true);
    expect(approvalRequest).toHaveBeenCalledOnce();
    expect(approvalRequest.mock.calls[0]![0].input.body).toBe('Thursday works — I will send a hold.');
  });
});
