import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ReactionApprovalMapper,
  UNRECOGNIZED_REACTION_HINT,
} from './reaction-approval-mapper.js';
import { createInboundReaction, createOutboundDelivered } from '../bus/events.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { ActionLogRow } from './action-log-types.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { ExecutionLayer } from '../skills/execution.js';
import type { EventBus } from '../bus/bus.js';
import type { ChannelIdentity } from '../contacts/types.js';
import { createSilentLogger } from '../logger.js';

function makeRow(overrides: Partial<ActionLogRow> = {}): ActionLogRow {
  return {
    id: 42,
    taskId: 'task-1',
    conversationId: 'slack:D123',
    toolName: 'calendar-create-event',
    actionRisk: 'high',
    outcome: 'pending_approval',
    taskSummary: null,
    competenceFlag: null,
    commitmentFlag: null,
    compatibility: null,
    scoredBy: null,
    payload: { title: 'Board sync' },
    notificationSentAt: null,
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    parentActionId: null,
    shortRef: 'abcd1234',
    description: 'Create calendar event: Board sync',
    createdAt: new Date('2026-07-01T12:00:00Z'),
    ...overrides,
  };
}

function makePrincipal(channel: string, identifier: string): ChannelIdentity {
  return {
    id: 'id-1',
    contactId: 'principal-1',
    channel,
    channelIdentifier: identifier,
    label: null,
    verified: true,
    verifiedAt: new Date(),
    status: 'active',
    source: channel === 'slack' ? 'slack_participant' : 'signal_participant',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('ReactionApprovalMapper', () => {
  let actionLogRepo: {
    findPendingByDeliveryMessage: ReturnType<typeof vi.fn>;
    findPendingByShortRef: ReturnType<typeof vi.fn>;
    bindDeliveryMessage: ReturnType<typeof vi.fn>;
    resolveRow: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  let contactService: { resolveByChannelIdentity: ReturnType<typeof vi.fn> };
  let executionLayer: { invoke: ReturnType<typeof vi.fn> };
  let bus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  let mapper: ReactionApprovalMapper;

  beforeEach(() => {
    actionLogRepo = {
      findPendingByDeliveryMessage: vi.fn(),
      findPendingByShortRef: vi.fn(),
      bindDeliveryMessage: vi.fn().mockResolvedValue(true),
      resolveRow: vi.fn().mockResolvedValue(true),
      insert: vi.fn().mockResolvedValue(99),
    };
    contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'principal-1',
        displayName: 'CEO',
        role: 'ceo',
        systemRole: 'principal',
        tier: 'principal',
        kind: 'person',
        kgNodeId: null,
        verified: true,
        contactConfidence: 1,
      }),
    };
    executionLayer = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
    };
    bus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    };
    mapper = new ReactionApprovalMapper({
      bus: bus as unknown as EventBus,
      logger: createSilentLogger(),
      actionLogRepo: actionLogRepo as unknown as ActionLogRepo,
      contactService: contactService as unknown as ContactService,
      executionLayer: executionLayer as unknown as ExecutionLayer,
      principalIdentities: [
        makePrincipal('slack', 'U_CEO'),
        makePrincipal('signal', '+15551234567'),
      ],
    });
  });

  it('approves when principal reacts 👍 on a bound Slack approval message', async () => {
    const row = makeRow();
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(row);

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D999:1.0', // deliberately different from approval conversation
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: 'thumbsup',
      targetMessageId: '1710000000.000100',
    }));

    expect(actionLogRepo.findPendingByDeliveryMessage).toHaveBeenCalledWith(
      'slack',
      '1710000000.000100',
    );
    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'approved', 'ceo');
    expect(executionLayer.invoke).toHaveBeenCalledWith(
      'calendar-create-event',
      { title: 'Board sync' },
      expect.objectContaining({ contactId: 'principal-1', channel: 'slack' }),
      expect.objectContaining({ humanApproved: true, liveTurn: true }),
    );
    expect(bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'human.decision',
        payload: expect.objectContaining({ decision: 'approve' }),
      }),
    );
  });

  it('approves skin-toned Slack shortcode (thumbsup::skin-tone-3)', async () => {
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(makeRow());

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: 'thumbsup::skin-tone-3',
      targetMessageId: '1710000000.000100',
    }));

    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'approved', 'ceo');
  });

  it('approves skin-toned unicode 👍🏽', async () => {
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(
      makeRow({ conversationId: 'signal:+15551234567' }),
    );

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'signal:+15551234567',
      channelId: 'signal',
      senderId: '+15551234567',
      emoji: '👍🏽',
      targetMessageId: '1699999999999',
    }));

    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'approved', 'ceo');
  });

  it('approves Signal 👍 via targetMessageId correlation (unicode emoji)', async () => {
    const row = makeRow({ conversationId: 'signal:+15551234567' });
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(row);

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'signal:+15551234567',
      channelId: 'signal',
      senderId: '+15551234567',
      emoji: '👍',
      targetMessageId: '1699999999999',
    }));

    expect(actionLogRepo.findPendingByDeliveryMessage).toHaveBeenCalledWith(
      'signal',
      '1699999999999',
    );
    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'approved', 'ceo');
  });

  it('denies on 👎', async () => {
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(makeRow());

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: 'thumbsdown',
      targetMessageId: '1710000000.000100',
    }));

    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'denied', 'ceo');
    expect(executionLayer.invoke).not.toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'human.decision',
        payload: expect.objectContaining({ decision: 'deny' }),
      }),
    );
  });

  it('still resolves + publishes when re-execution fails (invoke returns success:false)', async () => {
    // ExecutionLayer.invoke never throws — it returns { success: false } on
    // failure. The row must still transition to approved, a child action_log
    // row must record the failure, and the human.decision must still publish.
    const row = makeRow();
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(row);
    executionLayer.invoke.mockResolvedValue({ success: false, error: 'boom' });

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: 'thumbsup',
      targetMessageId: '1710000000.000100',
    }));

    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'approved', 'ceo');
    expect(actionLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', parentActionId: 42 }),
    );
    expect(bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'human.decision',
        payload: expect.objectContaining({ decision: 'approve' }),
      }),
    );
  });

  it('fails closed to deny when an approved row has a null payload', async () => {
    // A pending approval with no stored payload can't be re-executed; approving
    // must not leave the row stuck in pending_approval. It fails closed to deny.
    const row = makeRow({ payload: null });
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(row);

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: 'thumbsup',
      targetMessageId: '1710000000.000100',
    }));

    expect(executionLayer.invoke).not.toHaveBeenCalled();
    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'denied', 'ceo');
    expect(bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'human.decision',
        payload: expect.objectContaining({ decision: 'deny' }),
      }),
    );
  });

  it('looks up binding before principal check; ignores non-principal on bound message', async () => {
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(makeRow());

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_STRANGER',
      emoji: 'thumbsup',
      targetMessageId: '1710000000.000100',
    }));

    expect(actionLogRepo.findPendingByDeliveryMessage).toHaveBeenCalledWith(
      'slack',
      '1710000000.000100',
    );
    expect(actionLogRepo.resolveRow).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('exits before principal check when targetMessageId has no binding', async () => {
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(null);

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: 'thumbsup',
      targetMessageId: 'wrong-id',
    }));

    expect(actionLogRepo.findPendingByDeliveryMessage).toHaveBeenCalled();
    expect(actionLogRepo.resolveRow).not.toHaveBeenCalled();
    expect(contactService.resolveByChannelIdentity).not.toHaveBeenCalled();
  });

  it('correlates via targetMessageId even when conversationId diverges', async () => {
    const row = makeRow({ conversationId: 'slack:C999:111.222' });
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(row);

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:C999:999.888', // reply-ts keyed — different from thread root
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: '+1',
      targetMessageId: '111.222',
    }));

    expect(actionLogRepo.findPendingByDeliveryMessage).toHaveBeenCalledWith('slack', '111.222');
    expect(actionLogRepo.resolveRow).toHaveBeenCalledWith(42, 'approved', 'ceo');
  });

  it('no-ops isRemove reactions without binding lookup', async () => {
    await mapper.handleReaction(createInboundReaction({
      conversationId: 'signal:+15551234567',
      channelId: 'signal',
      senderId: '+15551234567',
      emoji: '👍',
      targetMessageId: '1699999999999',
      metadata: { isRemove: true },
    }));

    expect(actionLogRepo.findPendingByDeliveryMessage).not.toHaveBeenCalled();
    expect(actionLogRepo.resolveRow).not.toHaveBeenCalled();
  });

  it('sends hint when principal uses unrecognized emoji on a pending approval', async () => {
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(makeRow());

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: 'heart',
      targetMessageId: '1710000000.000100',
    }));

    expect(actionLogRepo.resolveRow).not.toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'outbound.message',
        payload: expect.objectContaining({
          conversationId: 'slack:D123',
          channelId: 'slack',
          recipientId: 'U_CEO',
          content: UNRECOGNIZED_REACTION_HINT,
        }),
      }),
    );
  });

  it('does not send hint for unrecognized emoji on unbound messages', async () => {
    actionLogRepo.findPendingByDeliveryMessage.mockResolvedValue(null);

    await mapper.handleReaction(createInboundReaction({
      conversationId: 'slack:D123',
      channelId: 'slack',
      senderId: 'U_CEO',
      emoji: '🎉',
      targetMessageId: 'unrelated',
    }));

    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('binds outbound.delivered messageId when content embeds Reference: short_ref', async () => {
    actionLogRepo.findPendingByShortRef.mockResolvedValue(makeRow());

    await mapper.handleDelivered(createOutboundDelivered({
      channel: 'slack',
      recipientId: 'U_CEO',
      content: 'Approval needed\n\nReference: abcd1234\nExpires: 2026-07-02T00:00:00.000Z',
      messageId: '1710000000.000100',
    }));

    expect(actionLogRepo.findPendingByShortRef).toHaveBeenCalledWith('abcd1234');
    expect(actionLogRepo.bindDeliveryMessage).toHaveBeenCalledWith(
      42,
      'slack',
      '1710000000.000100',
    );
  });
});
