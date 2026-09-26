// A specialist that narrates an in-flight delegation in the bullpen wakes the
// delegator onto an outbound-capable task while the originating turn is still
// going to answer. Reference trace: audit_log seq 1064595-1064698 (2026-09-25).
// The wake must not deliver a second confirmation. The originating conversation
// still does. A bullpen wake with no open delegation may still send. (#1917)

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { BullpenDispatcher } from '../../../src/dispatch/bullpen-dispatcher.js';
import { BullpenService } from '../../../src/memory/bullpen.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import { createAgentDiscuss } from '../../../src/bus/events.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolHandler, ToolManifest } from '../../../src/skills/types.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { SignalSendHandler } from '../../../skills/signal-send/handler.js';
import signalSendManifest from '../../../skills/signal-send/tool.json' with { type: 'json' };
import {
  isHumanReplySkill,
  parseOriginTurnOwnsReply,
} from '../../../src/dispatch/origin-turn-reply.js';

const logger = pino({ level: 'silent' });
const allowAllAgents = { has: () => true } as unknown as AgentRegistry;

const PRINCIPAL = '+15551234567';
const ORIGIN_CONVERSATION = `signal:${PRINCIPAL}`;

const originator = {
  contactId: 'ceo-contact-id',
  systemRole: 'principal' as const,
  channel: 'signal',
  initiatedAt: '2026-09-25T12:49:00.000Z',
};

const runningClaim = {
  originAgentId: 'coordinator',
  delegateEventId: 'delegate-evt-1064602',
  originConversationId: ORIGIN_CONVERSATION,
  originChannelId: 'signal',
};

function makeBus() {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  return {
    subscribe: vi.fn((type: string, _layer: string, handler: (event: unknown) => void) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    }),
    publish: vi.fn(async (_layer: string, _event: unknown) => {}),
    _trigger: async (type: string, event: unknown) => {
      for (const h of handlers.get(type) ?? []) await h(event);
    },
  };
}

function publishedTasks(bus: ReturnType<typeof makeBus>) {
  return (bus.publish as ReturnType<typeof vi.fn>).mock.calls
    .filter(([_layer, event]) => (event as { type: string }).type === 'agent.task')
    .map(([_layer, event]) => event as {
      payload: {
        agentId: string;
        channelId: string;
        conversationId: string;
        content: string;
        metadata: Record<string, unknown>;
      };
    });
}

function signalManifest(): ToolManifest {
  return {
    ...(signalSendManifest as ToolManifest),
    // Registration runs only after a successful send. This seam cares whether
    // send is reached, and the real manifest's outboundContext capability
    // refuses the skill when that service is unwired.
    capabilities: ['outboundGateway'],
  };
}

function executionWith(send: ReturnType<typeof vi.fn>): ExecutionLayer {
  const registry = new ToolRegistry();
  registry.register(signalManifest(), new SignalSendHandler());
  const gateway = { send } as unknown as OutboundGateway;
  return new ExecutionLayer(registry, logger, { outboundGateway: gateway });
}

describe('bullpen mention wake vs originating reply (#1917)', () => {
  it('delivers exactly one principal message, on the originating conversation', async () => {
    const bus = makeBus();
    const bullpenService = BullpenService.createInMemory();
    const findRunning = vi.fn(async () => [runningClaim]);
    const dispatcher = new BullpenDispatcher(
      bus as unknown as EventBus,
      logger,
      bullpenService,
      allowAllAgents,
      { findRunning },
    );
    dispatcher.register();

    const { thread } = await bullpenService.openThread(
      'Bluesky batch actioned',
      'social-media',
      ['social-media', 'coordinator', 'research-analyst'],
      'Held batch is in and the new batch is out.',
      ['coordinator'],
      originator,
    );
    const event = createAgentDiscuss({
      threadId: thread.id,
      messageId: 'msg-1',
      topic: 'Bluesky batch actioned',
      senderAgentId: 'social-media',
      participants: ['social-media', 'coordinator', 'research-analyst'],
      mentionedAgentIds: ['coordinator'],
      content: 'Held batch is in and the new batch is out.',
      originator,
      parentEventId: 'task-social',
    });
    await bus._trigger('agent.discuss', event);

    const tasks = publishedTasks(bus);
    const coordinator = tasks.find((task) => task.payload.agentId === 'coordinator');
    const analyst = tasks.find((task) => task.payload.agentId === 'research-analyst');
    expect(coordinator).toBeDefined();
    expect(analyst).toBeDefined();

    // Originator propagation and the #1126 liveTurn exclusion stay as they are.
    expect(coordinator!.payload.metadata.originator).toEqual(originator);
    expect(coordinator!.payload.metadata).not.toHaveProperty('liveTurn');
    expect(coordinator!.payload.channelId).toBe('bullpen');
    expect(coordinator!.payload.metadata.originTurnOwnsReply).toEqual({
      delegateEventId: runningClaim.delegateEventId,
      originConversationId: ORIGIN_CONVERSATION,
      originChannelId: 'signal',
    });
    expect(coordinator!.payload.content).toContain('will answer the principal');
    expect(analyst!.payload.content).not.toContain('will answer the principal');
    // A participant who is not waiting on this specialist can still be woken,
    // and is not told the principal reply belongs to someone else's turn.
    expect(analyst!.payload.metadata).not.toHaveProperty('originTurnOwnsReply');
    expect(findRunning).toHaveBeenCalledWith('social-media', ['coordinator', 'research-analyst']);

    const send = vi.fn().mockResolvedValue({ success: true });
    const execution = executionWith(send);

    const bullpenSend = await execution.invoke(
      'signal-send',
      { recipient: PRINCIPAL, message: 'Bluesky batch is actioned, boss.' },
      undefined,
      {
        agentId: 'coordinator',
        channelId: 'bullpen',
        conversationId: thread.id,
        taskEventId: 'wake-1064647',
        taskMetadata: coordinator!.payload.metadata,
      },
    );
    expect(bullpenSend.success).toBe(false);
    if (!bullpenSend.success) {
      expect(bullpenSend.error).toMatch(/originating conversation/i);
      expect(bullpenSend.error).toMatch(/not sent/i);
    }

    const originSend = await execution.invoke(
      'signal-send',
      { recipient: PRINCIPAL, message: 'Held batch is in and the new batch is out.' },
      undefined,
      {
        agentId: 'coordinator',
        channelId: 'signal',
        conversationId: ORIGIN_CONVERSATION,
        taskEventId: 'origin-1064595',
        taskMetadata: { originator },
      },
    );
    expect(originSend.success).toBe(true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'signal',
        recipient: PRINCIPAL,
        message: 'Held batch is in and the new batch is out.',
      }),
      expect.objectContaining({ conversationId: ORIGIN_CONVERSATION }),
    );
  });

  it('still sends when the bullpen wake has no open delegation', async () => {
    const bus = makeBus();
    const bullpenService = BullpenService.createInMemory();
    const dispatcher = new BullpenDispatcher(
      bus as unknown as EventBus,
      logger,
      bullpenService,
      allowAllAgents,
      { findRunning: async () => [] },
    );
    dispatcher.register();

    const { thread } = await bullpenService.openThread(
      'New urgent item',
      'research-analyst',
      ['research-analyst', 'coordinator'],
      'The filing deadline moved to Friday.',
      ['coordinator'],
    );
    await bus._trigger('agent.discuss', createAgentDiscuss({
      threadId: thread.id,
      messageId: 'msg-2',
      topic: 'New urgent item',
      senderAgentId: 'research-analyst',
      participants: ['research-analyst', 'coordinator'],
      mentionedAgentIds: ['coordinator'],
      content: 'The filing deadline moved to Friday.',
      originator,
      parentEventId: 'task-research',
    }));

    const coordinator = publishedTasks(bus).find((task) => task.payload.agentId === 'coordinator');
    expect(coordinator!.payload.metadata).not.toHaveProperty('originTurnOwnsReply');
    expect(coordinator!.payload.metadata.originator).toEqual(originator);
    expect(coordinator!.payload.metadata).not.toHaveProperty('liveTurn');

    const send = vi.fn().mockResolvedValue({ success: true });
    const result = await executionWith(send).invoke(
      'signal-send',
      { recipient: PRINCIPAL, message: 'The filing deadline moved to Friday.' },
      undefined,
      {
        agentId: 'coordinator',
        channelId: 'bullpen',
        conversationId: thread.id,
        taskMetadata: coordinator!.payload.metadata,
      },
    );
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still runs a non-send skill on a wake whose originating turn owns the reply', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn<ToolHandler['execute']>(async () => ({ success: true, data: { ok: true } }));
    registry.register(
      {
        name: 'bullpen',
        description: 'reply in thread',
        version: '0.0.0',
        sensitivity: 'normal',
        action_risk: 'low',
        inputs: {},
        outputs: {},
        permissions: [],
        secrets: [],
        timeout: 5000,
      },
      { execute },
    );
    const execution = new ExecutionLayer(registry, logger);
    const result = await execution.invoke('bullpen', { action: 'reply' }, undefined, {
      agentId: 'coordinator',
      channelId: 'bullpen',
      taskMetadata: {
        taskOrigin: 'bullpen',
        originator,
        originTurnOwnsReply: {
          delegateEventId: runningClaim.delegateEventId,
          originConversationId: ORIGIN_CONVERSATION,
          originChannelId: 'signal',
        },
      },
    });
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('dispatches the wake without the stamp when the origin-turn lookup fails', async () => {
    const bus = makeBus();
    const bullpenService = BullpenService.createInMemory();
    const error = vi.fn();
    const spyLogger = { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() } as unknown as Logger;
    const dispatcher = new BullpenDispatcher(
      bus as unknown as EventBus,
      spyLogger,
      bullpenService,
      allowAllAgents,
      { findRunning: async () => { throw new Error('db down'); } },
    );
    dispatcher.register();

    const { thread } = await bullpenService.openThread(
      'Lookup down',
      'social-media',
      ['social-media', 'coordinator'],
      'Done.',
      ['coordinator'],
    );
    await bus._trigger('agent.discuss', createAgentDiscuss({
      threadId: thread.id,
      messageId: 'msg-3',
      topic: 'Lookup down',
      senderAgentId: 'social-media',
      participants: ['social-media', 'coordinator'],
      mentionedAgentIds: ['coordinator'],
      content: 'Done.',
      parentEventId: 'task-social',
    }));

    const coordinator = publishedTasks(bus).find((task) => task.payload.agentId === 'coordinator');
    expect(coordinator).toBeDefined();
    expect(coordinator!.payload.metadata).not.toHaveProperty('originTurnOwnsReply');
    expect(error).toHaveBeenCalled();
  });

  it('does not suppress a send when the ownership stamp is malformed', async () => {
    const send = vi.fn().mockResolvedValue({ success: true });
    const result = await executionWith(send).invoke(
      'signal-send',
      { recipient: PRINCIPAL, message: 'Still goes out.' },
      undefined,
      {
        agentId: 'coordinator',
        channelId: 'bullpen',
        conversationId: 'thread-1',
        taskMetadata: { originTurnOwnsReply: { delegateEventId: 'only-one-field' } },
      },
    );
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lets a CEO-approved re-execution send even when the stamp is present', async () => {
    const send = vi.fn().mockResolvedValue({ success: true });
    const result = await executionWith(send).invoke(
      'signal-send',
      { recipient: PRINCIPAL, message: 'Approved.' },
      undefined,
      {
        agentId: 'coordinator',
        channelId: 'bullpen',
        conversationId: 'thread-1',
        humanApproved: true,
        taskMetadata: {
          originTurnOwnsReply: {
            delegateEventId: runningClaim.delegateEventId,
            originConversationId: ORIGIN_CONVERSATION,
            originChannelId: 'signal',
          },
        },
      },
    );
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('parseOriginTurnOwnsReply', () => {
  it('keeps a complete stamp and drops anything else', () => {
    expect(parseOriginTurnOwnsReply({
      delegateEventId: 'evt',
      originConversationId: ORIGIN_CONVERSATION,
      originChannelId: 'signal',
      extra: true,
    })).toEqual({
      delegateEventId: 'evt',
      originConversationId: ORIGIN_CONVERSATION,
      originChannelId: 'signal',
    });
    expect(parseOriginTurnOwnsReply(null)).toBeNull();
    expect(parseOriginTurnOwnsReply({ delegateEventId: '' })).toBeNull();
    expect(isHumanReplySkill('signal-send')).toBe(true);
    expect(isHumanReplySkill('send-draft')).toBe(true);
    expect(isHumanReplySkill('bullpen')).toBe(false);
  });
});
