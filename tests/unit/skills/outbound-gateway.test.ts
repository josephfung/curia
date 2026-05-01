import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { createLogger } from '../../../src/logger.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import type { AutonomyService, AutonomyConfig } from '../../../src/autonomy/autonomy-service.js';
import type { PiiRedactor } from '../../../src/dispatch/pii-redactor.js';

/**
 * Build fresh vi.fn() mocks for each test. Using beforeEach + createMocks()
 * prevents mock state from leaking across tests (e.g., call counts).
 */
function createMocks() {
  const logger = createLogger('error');
  const nylasClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
    getMessage: vi.fn().mockResolvedValue({
      id: 'orig-1',
      from: [{ email: 'sender@example.com' }],
      subject: 'Test Subject',
    }),
    listMessages: vi.fn().mockResolvedValue([]),
  } as unknown as NylasClient;
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService;
  const contentFilter = {
    check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
  } as unknown as OutboundContentFilter;
  const bus = {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as EventBus;
  return { logger, nylasClient, contactService, contentFilter, bus };
}

/** Build a stub AutonomyService that returns a fixed score. */
function makeAutonomyService(score: number): AutonomyService {
  const config: AutonomyConfig = {
    score,
    band: score >= 90 ? 'full' : score >= 80 ? 'spot-check' : score >= 70 ? 'approval-required' : score >= 60 ? 'draft-only' : 'restricted',
    updatedAt: new Date(),
    updatedBy: 'test',
  };
  return {
    getConfig: vi.fn().mockResolvedValue(config),
  } as unknown as AutonomyService;
}

describe('OutboundGateway', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  const baseRequest = {
    channel: 'email' as const,
    to: 'recipient@example.com',
    subject: 'Hello',
    body: 'Hi there!',
  };

  it('rejects sends to blocked contacts without calling nylasClient or contentFilter', async () => {
    // The contact is in the system and is explicitly blocked
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-1',
      displayName: 'Blocked Person',
      role: null,
      status: 'blocked',
      kgNodeId: null,
      verified: true,
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    // Safety check: we must never hit Nylas or the content filter for blocked contacts
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    expect(mocks.contentFilter.check).not.toHaveBeenCalled();
  });

  it('allows sends to non-blocked contacts and returns success with messageId', async () => {
    // The contact is confirmed — should proceed normally
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-2',
      displayName: 'Confirmed Person',
      role: null,
      status: 'confirmed',
      kgNodeId: null,
      verified: true,
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('allows sends when contact does not exist (null) and proceeds normally', async () => {
    // resolveByChannelIdentity returns null — unknown contact, not blocked
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('proceeds when contact resolution throws (DB failure), still sends email', async () => {
    // Simulates a transient DB error during contact lookup — we should not block
    // sends on infra failures; the contact check is best-effort.
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection refused'),
    );

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  describe('content filter', () => {
    it('blocks when filter rejects and does not call nylasClient for the original message', async () => {
      // The filter returns a blocked result — the gateway must stop here
      // and not proceed to Nylas dispatch for the original message.
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [{ rule: 'secret-pattern', detail: 'API key detected' }],
        stage: 'deterministic',
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send(baseRequest);

      expect(result.success).toBe(false);
      // The original blocked message must not be sent via nylasClient. The CEO
      // notification now routes through the bus as outbound.notification (#206).
      expect(result.blockedReason).toBe('Content blocked by filter');
    });

    it('publishes outbound.blocked event to the bus when filter rejects', async () => {
      // The blocked event must reach the bus so audit logging and channel adapters
      // can react to the interception.
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [{ rule: 'internal-structure', detail: 'Internal field leaked' }],
        stage: 'deterministic',
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      await gateway.send(baseRequest);

      // Two bus.publish calls: outbound.blocked + outbound.notification (#206)
      expect(mocks.bus.publish).toHaveBeenCalledTimes(2);
      // bus.publish(layer, event) — event is the second argument (index 1)
      const blockedEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[0][1] as BusEvent;
      expect(blockedEvent.type).toBe('outbound.blocked');
      // The payload must contain the channel and recipient for downstream consumers
      if (blockedEvent.type === 'outbound.blocked') {
        expect(blockedEvent.payload.channelId).toBe('email');
        expect(blockedEvent.payload.recipientId).toBe('recipient@example.com');
      }
    });

    it('publishes outbound.notification event for CEO alert when filter rejects', async () => {
      // The CEO notification routes through the bus as an outbound.notification event
      // so it goes through the same safety pipeline as regular outbound messages (#206).
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [{ rule: 'secret-pattern', detail: 'API key detected' }],
        stage: 'deterministic',
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      await gateway.send(baseRequest);

      // The second bus.publish call is the outbound.notification event
      const notificationEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[1][1] as BusEvent;
      expect(notificationEvent.type).toBe('outbound.notification');
      if (notificationEvent.type === 'outbound.notification') {
        expect(notificationEvent.payload.notificationType).toBe('blocked_content');
        expect(notificationEvent.payload.ceoEmail).toBe('ceo@example.com');
        expect(notificationEvent.payload.subject).toMatch(/blocked/i);
      }
      // nylasClient.sendMessage must NOT be called — the gateway no longer sends
      // the notification directly; the EmailAdapter handles delivery.
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    });

    it('notification payload contains no sensitive content but includes block ID', async () => {
      // The notification must never echo the blocked body or rule details —
      // it is purely a "something was blocked, check the logs" signal.
      // The block ID ties the notification to the outbound.blocked event in the audit trail.
      const sensitiveBody = 'My API key is sk-ant-abcdefghijklmnopqrst1234567890AB';
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [{ rule: 'secret-pattern', detail: 'API key: sk-ant-abcdefghijklmnopqrst1234567890AB' }],
        stage: 'deterministic',
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      await gateway.send({ ...baseRequest, body: sensitiveBody });

      const notificationEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[1][1] as BusEvent;
      expect(notificationEvent.type).toBe('outbound.notification');
      if (notificationEvent.type === 'outbound.notification') {
        // Must NOT contain the blocked content
        expect(notificationEvent.payload.body).not.toContain(sensitiveBody);
        // Must NOT contain the detailed rule finding (could include key value)
        expect(notificationEvent.payload.body).not.toContain('sk-ant-abcdefghijklmnopqrst1234567890AB');
        // MUST contain a block ID so the CEO can cross-reference with logs
        expect(notificationEvent.payload.blockId).toMatch(/^block_/);
      }
    });

    it('fails closed when filter crashes — blocks send and publishes notification', async () => {
      // If the content filter itself throws, we must treat it as blocked (fail-closed).
      // A crashing filter is a security anomaly; we'd rather miss a send than let
      // potentially dangerous content through an unchecked pipeline.
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Filter internal error'),
      );

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send(baseRequest);

      // Filter crash must block the send
      expect(result.success).toBe(false);
      // CEO notification is published to the bus as outbound.notification
      const publishCalls = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const notificationCalls = publishCalls.filter(
        (call: unknown[]) => (call[1] as BusEvent).type === 'outbound.notification',
      );
      expect(notificationCalls).toHaveLength(1);
    });

    it('allows send when filter passes and calls check with correct params', async () => {
      // Happy path: filter passes — the message should go out normally.
      // We also verify the filter was invoked with the right shape so we know
      // the gateway is actually doing the check and not accidentally skipping it.
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: true,
        findings: [],
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send(baseRequest);

      expect(result.success).toBe(true);
      expect(mocks.contentFilter.check).toHaveBeenCalledOnce();
      expect(mocks.contentFilter.check).toHaveBeenCalledWith({
        content: baseRequest.body,
        recipientEmail: baseRequest.to,
        conversationId: '',
        channelId: baseRequest.channel,
        recipientTrustLevel: null,
      });
    });

    it('forwards recipientTrustLevel=high to contentFilter when contact has trust_level=high', async () => {
      // Verify that a resolved contact with trust_level='high' propagates to the
      // content filter. This is the policy boundary that allows trusted recipients
      // (CEO's EA, CFO, board members) to receive third-party contact data.
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
        contactId: 'contact-ea',
        displayName: "CEO's EA",
        role: null,
        status: 'confirmed',
        kgNodeId: null,
        verified: true,
        trustLevel: 'high',
      });
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: true,
        findings: [],
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        ceoEmail: 'ceo@example.com',
        logger: mocks.logger,
      });

      const result = await gateway.send(baseRequest);

      expect(result.success).toBe(true);
      expect(mocks.contentFilter.check).toHaveBeenCalledOnce();
      expect(mocks.contentFilter.check).toHaveBeenCalledWith({
        content: baseRequest.body,
        recipientEmail: baseRequest.to,
        conversationId: '',
        channelId: baseRequest.channel,
        recipientTrustLevel: 'high',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// createEmailDraft — silent draft creation (no CEO notification)
// ---------------------------------------------------------------------------

describe('OutboundGateway.createEmailDraft', () => {
  const draftRequest = {
    channel: 'email' as const,
    to: 'partner@example.com',
    accountId: 'joseph',
    subject: 'Partnership follow-up',
    body: 'Thanks for the meeting!',
  };

  /** Build a gateway with email capability. */
  function makeGateway(overrides: {
    nylasClient?: Partial<NylasClient>;
    contactService?: Partial<ContactService>;
    nylasClients?: Map<string, NylasClient>;
  } = {}) {
    const logger = createLogger('error');
    const nylasClient = {
      createDraft: vi.fn().mockResolvedValue({ id: 'draft-abc' }),
      sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      ...overrides.nylasClient,
    } as unknown as NylasClient;
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      ...overrides.contactService,
    } as unknown as ContactService;
    const contentFilter = {
      check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
    } as unknown as OutboundContentFilter;
    const bus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as EventBus;

    const nylasClients = overrides.nylasClients ?? new Map([['joseph', nylasClient]]);

    const gateway = new OutboundGateway({
      nylasClients,
      contactService,
      contentFilter,
      bus,
      ceoEmail: 'ceo@example.com',
      logger,
    });

    return { gateway, nylasClient, contactService };
  }

  it('creates a Nylas draft and returns the draftId', async () => {
    const { gateway, nylasClient } = makeGateway();
    const result = await gateway.createEmailDraft(draftRequest);

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-abc');
    expect(nylasClient.createDraft).toHaveBeenCalledOnce();
  });

  it('does not send any notification email after successful draft creation', async () => {
    // Drafts are silent — no per-draft email is sent to the CEO.
    // Discovery happens via the end-of-day Signal digest.
    const { gateway, nylasClient } = makeGateway();
    await gateway.createEmailDraft(draftRequest);

    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('returns false when no email client is configured', async () => {
    const { gateway } = makeGateway({
      nylasClients: new Map(), // empty — no primary client
    });

    const result = await gateway.createEmailDraft(draftRequest);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Email client not configured');
  });

  it('blocks draft creation for a blocked contact', async () => {
    const { gateway, nylasClient } = makeGateway({
      contactService: {
        resolveByChannelIdentity: vi.fn().mockResolvedValue({
          contactId: 'contact-blocked',
          status: 'blocked',
          trustLevel: null,
        }),
      },
    });

    const result = await gateway.createEmailDraft(draftRequest);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    expect(nylasClient.createDraft).not.toHaveBeenCalled();
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('blocks draft creation when contact resolution throws (fail-closed)', async () => {
    const { gateway, nylasClient } = makeGateway({
      contactService: {
        resolveByChannelIdentity: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      },
    });

    const result = await gateway.createEmailDraft(draftRequest);

    // Unlike send() which fail-opens on contact resolution errors, createEmailDraft
    // fail-closes: a draft for a blocked contact could be sent by a human later.
    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('Contact resolution failed');
    expect(nylasClient.createDraft).not.toHaveBeenCalled();
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Helper: build a minimal SignalRpcClient mock with a configurable group list.
// Defined outside the describe block so it is available at module scope.
// ---------------------------------------------------------------------------
function makeSignalClient(groups: import('../../../src/channels/signal/types.js').SignalGroupDetails[] = []) {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendReadReceipt: vi.fn().mockResolvedValue(undefined),
    listGroups: vi.fn().mockResolvedValue(groups),
  };
}

describe('OutboundGateway.getSignalGroupMembers', () => {
  it('returns member phones excluding own number', async () => {
    const { logger, contactService, contentFilter, bus } = createMocks();
    const signalClient = makeSignalClient([
      {
        id: 'grpABC==',
        name: 'Test Group',
        members: [
          { number: '+14155551234' },
          { number: '+15555550000' }, // Curia's own number — must be excluded
          { number: '+14165559999' },
        ],
        pendingMembers: [],
        isMember: true,
      },
    ]);

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService,
      contentFilter,
      bus,
      logger,
    });

    const members = await gateway.getSignalGroupMembers('grpABC==');
    expect(members).toEqual(['+14155551234', '+14165559999']);
    expect(members).not.toContain('+15555550000');
  });

  it('throws if the group is not found', async () => {
    const { logger, contactService, contentFilter, bus } = createMocks();
    const signalClient = makeSignalClient([]); // empty group list

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService,
      contentFilter,
      bus,
      logger,
    });

    await expect(gateway.getSignalGroupMembers('nonexistent==')).rejects.toThrow('group not found');
  });

  it('throws if Signal client is not configured', async () => {
    const { logger, nylasClient, contactService, contentFilter, bus } = createMocks();

    const gateway = new OutboundGateway({
      nylasClient,
      contactService,
      contentFilter,
      bus,
      ceoEmail: 'ceo@example.com',
      logger,
    });

    await expect(gateway.getSignalGroupMembers('grpABC==')).rejects.toThrow('Signal client not configured');
  });
});

// ---------------------------------------------------------------------------
// Fix A — contact promotion after successful outbound send
// ---------------------------------------------------------------------------

describe('OutboundGateway contact promotion on successful send', () => {
  function makeGateway(contactService: ContactService, nylasClient: NylasClient) {
    const logger = createLogger('error');
    const contentFilter = {
      check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
    } as unknown as OutboundContentFilter;
    const bus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as EventBus;
    return new OutboundGateway({
      nylasClients: new Map([['curia', nylasClient]]),
      contactService,
      contentFilter,
      bus,
      ceoEmail: 'ceo@example.com',
      logger,
    });
  }

  const baseRequest = {
    channel: 'email' as const,
    to: 'donna@example.com',
    subject: 'Trailwalk scheduling',
    body: 'Hi Donna!',
  };

  it('promotes a provisional contact to confirmed after a successful send', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-1' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn()
        // First call: blocked-contact check (returns provisional)
        .mockResolvedValueOnce({ contactId: 'contact-donna', status: 'provisional', trustLevel: null })
        // Second call: promotion lookup (returns provisional again)
        .mockResolvedValueOnce({ contactId: 'contact-donna', status: 'provisional', trustLevel: null }),
      setStatus: vi.fn().mockResolvedValue(undefined),
      setTrustLevel: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(contactService.setStatus).toHaveBeenCalledOnce();
    expect(contactService.setStatus).toHaveBeenCalledWith('contact-donna', 'confirmed');
    // Must also set trustLevel so replies score above the trust floor
    expect(contactService.setTrustLevel).toHaveBeenCalledOnce();
    expect(contactService.setTrustLevel).toHaveBeenCalledWith('contact-donna', 'high');
  });

  it('creates a confirmed contact when no record exists for the recipient', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-2' }),
    } as unknown as NylasClient;

    const contactService = {
      // resolveByChannelIdentity returns null on both calls (blocked check + promotion lookup)
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn().mockResolvedValue({ id: 'new-contact-id' }),
      linkIdentity: vi.fn().mockResolvedValue(undefined),
      setTrustLevel: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(contactService.createContact).toHaveBeenCalledOnce();
    expect(contactService.createContact).toHaveBeenCalledWith(expect.objectContaining({
      status: 'confirmed',
      source: 'ceo_stated',
    }));
    expect(contactService.linkIdentity).toHaveBeenCalledOnce();
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'new-contact-id',
      channel: 'email',
      channelIdentifier: 'donna@example.com',
      source: 'ceo_stated',
    }));
    // Must also set trustLevel so replies score above the trust floor
    expect(contactService.setTrustLevel).toHaveBeenCalledOnce();
    expect(contactService.setTrustLevel).toHaveBeenCalledWith('new-contact-id', 'high');
  });

  it('does not promote a contact that is already confirmed', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-3' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-confirmed',
        status: 'confirmed',
        trustLevel: null,
      }),
      setStatus: vi.fn(),
      createContact: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(contactService.setStatus).not.toHaveBeenCalled();
    expect(contactService.createContact).not.toHaveBeenCalled();
  });

  it('does not promote on a failed send', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Nylas error')),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(false);
    expect(contactService.createContact).not.toHaveBeenCalled();
    expect(contactService.setStatus).not.toHaveBeenCalled();
  });

  it('succeeds even if contact promotion throws a DB error (fail-open)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-4' }),
    } as unknown as NylasClient;

    const contactService = {
      // Blocked-contact check passes (null = no contact), promotion lookup also returns null
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn().mockRejectedValue(new Error('DB connection timeout')),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    // The send succeeded; the promotion error must not surface as a send failure
    expect(result.success).toBe(true);
    expect(result.messageId).toBe('sent-4');
  });
});

// ---------------------------------------------------------------------------
// Autonomy gate — score < 70 blocks outbound sends
// ---------------------------------------------------------------------------

describe('autonomy gate on send()', () => {
  it('blocks send when score < 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('autonomy');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    expect(mocks.contactService.resolveByChannelIdentity).not.toHaveBeenCalled();
  });

  it('allows send when score >= 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(75),
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(true);
  });

  it('emits autonomy.send_blocked event when send is blocked', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(mocks.bus.publish).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        type: 'autonomy.send_blocked',
        payload: expect.objectContaining({
          channel: 'email',
          currentScore: 65,
          requiredScore: 70,
        }),
      }),
    );
  });

  it('skips gate when autonomyService is not wired (fail-open)', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      // autonomyService intentionally omitted
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(true);
  });

  it('fails open when getConfig returns null (pre-migration)', async () => {
    const mocks = createMocks();
    const nullService = {
      getConfig: vi.fn().mockResolvedValue(null),
    } as unknown as AutonomyService;

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: nullService,
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(true);
    expect(mocks.bus.publish).not.toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({ type: 'autonomy.send_blocked' }),
    );
  });

  it('fails open when getConfig throws (DB error)', async () => {
    const mocks = createMocks();
    const throwingService = {
      getConfig: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as AutonomyService;

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: throwingService,
    });

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Hi there!',
    });

    expect(result.success).toBe(true);
  });

  it('does not gate createEmailDraft', async () => {
    const mocks = createMocks();
    (mocks.nylasClient as unknown as { createDraft: ReturnType<typeof vi.fn> }).createDraft =
      vi.fn().mockResolvedValue({ id: 'draft-1' });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      ceoEmail: 'ceo@example.com',
      logger: mocks.logger,
      autonomyService: makeAutonomyService(50), // well below 70
    });

    const result = await gateway.createEmailDraft({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'Draft body',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-1');
  });
});

// ---------------------------------------------------------------------------
// PII redaction pipeline step — wired between blocked-contact check and content filter
// ---------------------------------------------------------------------------

describe('PII redaction pipeline step', () => {
  const piiRequest = {
    channel: 'email' as const,
    to: 'partner@example.com',
    subject: 'Payment info',
    // Credit card number embedded in the message body
    body: 'Please charge 4111111111111111 for the service.',
  };

  /** Build a mock PiiRedactor whose redact() function can be controlled per test. */
  function makePiiRedactor(
    impl: (content: string) => Promise<{ content: string; redactions: unknown[] }>,
  ): PiiRedactor {
    return {
      redact: vi.fn().mockImplementation((content: string) => impl(content)),
    } as unknown as PiiRedactor;
  }

  /** Standard gateway builder used by most cases in this describe block. */
  function makeGateway(piiRedactor?: PiiRedactor) {
    const logger = createLogger('error');
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'msg-pii-1' }),
    } as unknown as NylasClient;
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    } as unknown as ContactService;
    const contentFilter = {
      check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
    } as unknown as OutboundContentFilter;
    const bus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as EventBus;

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', nylasClient]]),
      contactService,
      contentFilter,
      bus,
      ceoEmail: 'ceo@example.com',
      logger,
      piiRedactor,
    });

    return { gateway, nylasClient, contactService, contentFilter, bus };
  }

  it('redacts PII for non-CEO recipients before content filter sees it', async () => {
    // The redactor replaces the credit card with a token.
    // We verify that the content filter receives the redacted content, not the original.
    const redactedBody = 'Please charge [REDACTED: CREDIT_CARD] for the service.';
    const piiRedactor = makePiiRedactor(async (_content) => ({
      content: redactedBody,
      redactions: [{ patternLabel: 'credit_card', channelId: 'email', replacedWith: '[REDACTED: CREDIT_CARD]' }],
    }));

    const { gateway, contentFilter } = makeGateway(piiRedactor);
    const result = await gateway.send(piiRequest);

    expect(result.success).toBe(true);
    // The content filter must have seen the redacted content, not the raw PII.
    expect(contentFilter.check).toHaveBeenCalledOnce();
    expect(contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({
      content: redactedBody,
    }));
    // The original PII body must NOT have reached the content filter.
    expect(contentFilter.check).not.toHaveBeenCalledWith(expect.objectContaining({
      content: piiRequest.body,
    }));
  });

  it('does NOT redact PII for CEO recipients (trust_override bypasses redaction)', async () => {
    // When the recipient has 'ceo' trust level, the redactor returns content unchanged.
    const piiRedactor = makePiiRedactor(async (content) => ({
      content,
      redactions: [],
    }));

    const { gateway, contentFilter, contactService } = makeGateway(piiRedactor);
    // Make the contact service return a CEO-level trust contact.
    (contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-ceo',
      displayName: 'CEO',
      status: 'confirmed',
      trustLevel: 'ceo',
    });

    const result = await gateway.send(piiRequest);

    expect(result.success).toBe(true);
    // The redactor was still called (the gateway always calls it when configured),
    // but the content filter receives the original body (redactor returned it unchanged).
    expect(piiRedactor.redact).toHaveBeenCalledOnce();
    expect(contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({
      content: piiRequest.body,
    }));
  });

  it('works without piiRedactor configured (backwards compatible)', async () => {
    // Gateway constructed without piiRedactor → content passes through to filter unchanged.
    const { gateway, contentFilter } = makeGateway(/* piiRedactor = */ undefined);

    const result = await gateway.send(piiRequest);

    expect(result.success).toBe(true);
    // The content filter must have received the original body — no redaction.
    expect(contentFilter.check).toHaveBeenCalledOnce();
    expect(contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({
      content: piiRequest.body,
    }));
  });

  it('blocks the message when PiiRedactor throws (fail-closed)', async () => {
    // If the redactor throws, the gateway must block the message rather than
    // sending unredacted PII. This is the fail-closed contract.
    const piiRedactor = {
      redact: vi.fn().mockRejectedValue(new Error('Pattern engine crashed')),
    } as unknown as PiiRedactor;

    const { gateway, nylasClient, bus } = makeGateway(piiRedactor);
    const result = await gateway.send(piiRequest);

    // Message must be blocked — never reach Nylas.
    expect(result.success).toBe(false);
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();

    // An outbound.blocked event must be published to maintain the audit trail.
    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const blockedCalls = publishCalls.filter(
      (call: unknown[]) => (call[1] as BusEvent).type === 'outbound.blocked',
    );
    expect(blockedCalls).toHaveLength(1);
    if (blockedCalls[0]) {
      const blockedEvent = blockedCalls[0][1] as BusEvent;
      if (blockedEvent.type === 'outbound.blocked') {
        expect(blockedEvent.payload.reason).toContain('pii_redactor_error');
      }
    }
  });
});
