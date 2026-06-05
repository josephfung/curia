/**
 * Integration tests for the dispatcher reply-lock feature (#847).
 *
 * These tests exercise the full in-process flow: skill.result fires → reply-lock
 * flag is set on the routing entry → handleAgentResponse sees the flag and
 * suppresses the duplicate outbound.message.
 *
 * Two cases per the acceptance criteria:
 *   1. Direct-coordinator: coordinator itself calls email-reply, then agent.response fires.
 *   2. Delegated-specialist: T2125 (specialist) calls email-reply inside the same
 *      conversation; coordinator's agent.response is suppressed via conversationId match.
 *
 * No database required — the reply-lock operates entirely in the in-memory taskRouting map.
 */

import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';
import {
  createAgentResponse,
  createSkillResult,
  type BusEvent,
  type OutboundMessageEvent,
  type OutboundSuppressedDuplicateEvent,
} from '../../src/bus/events.js';

function isOutboundMessage(e: BusEvent): e is OutboundMessageEvent {
  return e.type === 'outbound.message';
}

function isOutboundSuppressedDuplicate(e: BusEvent): e is OutboundSuppressedDuplicateEvent {
  return e.type === 'outbound.suppressed_duplicate';
}

function makeStubs() {
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

  const dispatcher = new Dispatcher({ bus, logger });

  return { dispatcher, publishedEvents, subscribeHandlers };
}

/** Seeds the routing map (without humanReplySent so handleSkillResult must set it). */
function seedRouting(
  dispatcher: Dispatcher,
  taskEventId: string,
  { conversationId = 'email:thread-abc', senderId = 'external@example.com' }: {
    conversationId?: string;
    senderId?: string;
  } = {},
) {
  (dispatcher as unknown as {
    taskRouting: Map<string, { channelId: string; conversationId: string; senderId: string; humanReplySent: boolean }>;
  }).taskRouting.set(taskEventId, {
    channelId: 'email',
    conversationId,
    senderId,
    humanReplySent: false,
  });
}

async function fireSkillResult(
  subscribeHandlers: Map<string, (event: BusEvent) => void | Promise<void>>,
  {
    agentId,
    conversationId,
    skillName,
    to,
    invokeEventId = 'invoke-1',
  }: {
    agentId: string;
    conversationId: string;
    skillName: string;
    to: string;
    invokeEventId?: string;
  },
) {
  const event = createSkillResult({
    agentId,
    conversationId,
    skillName,
    result: { success: true, data: { message_id: 'msg-1', to, subject: 'Re: Test' } },
    durationMs: 100,
    parentEventId: invokeEventId,
  });
  const handler = subscribeHandlers.get('skill.result');
  if (!handler) throw new Error('No skill.result handler registered');
  await handler(event);
}

async function fireAgentResponse(
  subscribeHandlers: Map<string, (event: BusEvent) => void | Promise<void>>,
  { taskEventId, conversationId = 'email:thread-abc', agentId = 'coordinator' }: {
    taskEventId: string;
    conversationId?: string;
    agentId?: string;
  },
) {
  const event = createAgentResponse({ agentId, conversationId, content: 'ok', parentEventId: taskEventId });
  const handler = subscribeHandlers.get('agent.response');
  if (!handler) throw new Error('No agent.response handler registered');
  await handler(event);
}

describe('Dispatcher reply-lock — integration', () => {
  describe('Case 1: direct-coordinator calls email-reply', () => {
    it('suppresses outbound.message when coordinator called email-reply during the task', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-coord', {
        conversationId: 'email:thread-abc',
        senderId: 'client@example.com',
      });

      // Coordinator called email-reply — skill.result fires before agent.response
      await fireSkillResult(subscribeHandlers, {
        agentId: 'coordinator',
        conversationId: 'email:thread-abc',
        skillName: 'email-reply',
        to: 'client@example.com',
      });

      // Coordinator wrap-up: agent.response fires
      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-coord',
        conversationId: 'email:thread-abc',
        agentId: 'coordinator',
      });

      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(1);
    });

    it('does NOT suppress when the skill failed', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-coord-fail', {
        conversationId: 'email:conv-fail',
        senderId: 'client@example.com',
      });

      // email-reply failed — should not trigger reply-lock
      const failEvent = createSkillResult({
        agentId: 'coordinator',
        conversationId: 'email:conv-fail',
        skillName: 'email-reply',
        result: { success: false, error: 'Gateway rejected' },
        durationMs: 50,
        parentEventId: 'invoke-fail',
      });
      const skillHandler = subscribeHandlers.get('skill.result');
      if (!skillHandler) throw new Error('No skill.result handler registered');
      await skillHandler(failEvent);

      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-coord-fail',
        conversationId: 'email:conv-fail',
      });

      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(0);
    });

    it('does NOT suppress when a different conversation sent email-reply', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-coord-other', {
        conversationId: 'email:thread-abc',
        senderId: 'client@example.com',
      });

      // email-reply in a DIFFERENT conversation — should not affect this routing entry
      await fireSkillResult(subscribeHandlers, {
        agentId: 'coordinator',
        conversationId: 'email:thread-different',
        skillName: 'email-reply',
        to: 'client@example.com',
      });

      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-coord-other',
        conversationId: 'email:thread-abc',
      });

      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(0);
    });

    it('does NOT suppress when email-reply went to a different recipient', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-coord-diff-recip', {
        conversationId: 'email:thread-abc',
        senderId: 'client@example.com',
      });

      // email-reply to a different person in the same conversation
      await fireSkillResult(subscribeHandlers, {
        agentId: 'coordinator',
        conversationId: 'email:thread-abc',
        skillName: 'email-reply',
        to: 'someone-else@example.com',
      });

      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-coord-diff-recip',
        conversationId: 'email:thread-abc',
      });

      // Not suppressed — reply was to a different address than senderId
      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(0);
    });

    it('works with email-send (single recipient)', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-send', {
        conversationId: 'email:thread-send',
        senderId: 'client@example.com',
      });

      await fireSkillResult(subscribeHandlers, {
        agentId: 'coordinator',
        conversationId: 'email:thread-send',
        skillName: 'email-send',
        to: 'client@example.com',
      });

      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-send',
        conversationId: 'email:thread-send',
      });

      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(1);
    });

    it('works with email-send when senderId is one of multiple comma-joined recipients', async () => {
      // email-send returns { to: "addr1, addr2" } when there are multiple recipients.
      // The reply-lock must still fire when senderId is among them.
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-send-multi', {
        conversationId: 'email:thread-multi',
        senderId: 'client@example.com',
      });

      await fireSkillResult(subscribeHandlers, {
        agentId: 'coordinator',
        conversationId: 'email:thread-multi',
        skillName: 'email-send',
        // Simulate email-send returning comma-joined recipients
        to: 'client@example.com, ops@example.com',
      });

      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-send-multi',
        conversationId: 'email:thread-multi',
      });

      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(1);
    });
  });

  describe('Case 2: delegated specialist (T2125-style) calls email-reply', () => {
    it('suppresses coordinator wrap-up when specialist sent reply in same conversation', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      // Only the coordinator's task has a routing entry (specialist task was spawned internally)
      seedRouting(dispatcher, 'task-coordinator', {
        conversationId: 'email:reconciliation-thread',
        senderId: 'reconciliation@client.com',
      });

      // T2125 specialist calls email-reply — skill.result fires with specialist agentId
      // but same conversationId as the coordinator's routing entry
      await fireSkillResult(subscribeHandlers, {
        agentId: 'T2125-expense-tracker',
        conversationId: 'email:reconciliation-thread',
        skillName: 'email-reply',
        to: 'reconciliation@client.com',
      });

      // Coordinator wrap-up agent.response fires after specialist finishes
      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-coordinator',
        conversationId: 'email:reconciliation-thread',
        agentId: 'coordinator',
      });

      // Coordinator's outbound.message should be suppressed
      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);

      const suppressed = publishedEvents.filter(isOutboundSuppressedDuplicate);
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0]!.payload.reason).toBe('human_reply_already_sent');
      expect(suppressed[0]!.payload.routingTaskId).toBe('task-coordinator');
      expect(suppressed[0]!.payload.agentId).toBe('coordinator');
      expect(suppressed[0]!.payload.conversationId).toBe('email:reconciliation-thread');
    });

    it('does not interfere with a second independent conversation', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      // Two routing entries for two different conversations
      seedRouting(dispatcher, 'task-A', {
        conversationId: 'email:conv-A',
        senderId: 'alice@example.com',
      });
      seedRouting(dispatcher, 'task-B', {
        conversationId: 'email:conv-B',
        senderId: 'bob@example.com',
      });

      // Specialist fires email-reply for conv-A only
      await fireSkillResult(subscribeHandlers, {
        agentId: 'specialist',
        conversationId: 'email:conv-A',
        skillName: 'email-reply',
        to: 'alice@example.com',
      });

      // Both coordinators respond
      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-A',
        conversationId: 'email:conv-A',
      });
      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-B',
        conversationId: 'email:conv-B',
      });

      // Only conv-A is suppressed; conv-B fires normally
      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(1);

      const outbound = publishedEvents.filter(isOutboundMessage)[0]!;
      expect(outbound.payload.conversationId).toBe('email:conv-B');
    });
  });

  describe('unchanged behavior when no reply skill fires', () => {
    it('publishes outbound.message normally when no email-reply was called', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-normal', {
        conversationId: 'email:thread-normal',
        senderId: 'user@example.com',
      });

      // No skill.result fires — coordinator responds via agent.response only
      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-normal',
        conversationId: 'email:thread-normal',
      });

      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(0);
    });

    it('non-email skills (e.g. list-calendar) do not trigger reply-lock', async () => {
      const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
      dispatcher.register();

      seedRouting(dispatcher, 'task-calendar', {
        conversationId: 'email:thread-cal',
        senderId: 'user@example.com',
      });

      await fireSkillResult(subscribeHandlers, {
        agentId: 'coordinator',
        conversationId: 'email:thread-cal',
        skillName: 'list-calendar',
        to: 'user@example.com',
      });

      await fireAgentResponse(subscribeHandlers, {
        taskEventId: 'task-calendar',
        conversationId: 'email:thread-cal',
      });

      expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
      expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(0);
    });
  });
});
