import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { createLogger } from '../../../src/logger.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';

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
      // nylasClient.sendMessage may be called once for the CEO notification, but
      // NOT for the original blocked message. We verify the result is blocked.
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

      expect(mocks.bus.publish).toHaveBeenCalledOnce();
      // bus.publish(layer, event) — event is the second argument (index 1)
      const publishedEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[0][1] as BusEvent;
      expect(publishedEvent.type).toBe('outbound.blocked');
      // The payload must contain the channel and recipient for downstream consumers
      if (publishedEvent.type === 'outbound.blocked') {
        expect(publishedEvent.payload.channelId).toBe('email');
        expect(publishedEvent.payload.recipientId).toBe('recipient@example.com');
      }
    });

    it('sends CEO notification via nylasClient when filter rejects', async () => {
      // The CEO notification is the human-in-the-loop safety signal. It must
      // be sent directly (not through the filter pipeline) to avoid recursion.
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

      // nylasClient.sendMessage should be called exactly once — for the CEO notification
      expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
      const sendArgs = (mocks.nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendArgs.to).toEqual([{ email: 'ceo@example.com' }]);
      expect(sendArgs.subject).toMatch(/blocked/i);
    });

    it('sends CEO notification body with no sensitive content but includes block ID', async () => {
      // The notification must never echo the blocked body or rule details back to
      // any inbox — it is purely a "something was blocked, check the logs" signal.
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

      const sendArgs = (mocks.nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // Must NOT contain the blocked content
      expect(sendArgs.body).not.toContain(sensitiveBody);
      // Must NOT contain the detailed rule finding (could include key value)
      expect(sendArgs.body).not.toContain('sk-ant-abcdefghijklmnopqrst1234567890AB');
      // MUST contain the block ID so the CEO can cross-reference with logs
      expect(sendArgs.body).toMatch(/block_[0-9a-f-]{36}/);
    });

    it('fails closed when filter crashes — blocks send and notifies CEO', async () => {
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
      // CEO notification is sent even when the filter crashes
      expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
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
// createEmailDraft + CEO notification
// ---------------------------------------------------------------------------

describe('OutboundGateway.createEmailDraft', () => {
  // The notification is fire-and-forget (.catch(), not await). After
  // createEmailDraft returns, the notification promise is still in-flight.
  // Flushing a macrotask ensures all pending microtasks (mock promise chains
  // inside notifyCeoDraftCreated → dispatchEmail → sendMessage) have settled.
  const flushNotification = () => new Promise<void>((r) => setTimeout(r, 0));

  const draftRequest = {
    channel: 'email' as const,
    to: 'partner@example.com',
    accountId: 'joseph',
    subject: 'Partnership follow-up',
    body: 'Thanks for the meeting!',
  };

  /** Build a gateway with full email + CEO notification capability. */
  function makeGateway(overrides: {
    nylasClient?: Partial<NylasClient>;
    contactService?: Partial<ContactService>;
    ceoEmail?: string;
    nylasClients?: Map<string, NylasClient>;
  } = {}) {
    const logger = createLogger('error');
    const nylasClient = {
      createDraft: vi.fn().mockResolvedValue({ id: 'draft-abc' }),
      sendMessage: vi.fn().mockResolvedValue({ id: 'notif-1' }),
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
      ceoEmail: overrides.ceoEmail ?? 'ceo@example.com',
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

  it('sends CEO a notification email after successful draft creation', async () => {
    const { gateway, nylasClient } = makeGateway();
    await gateway.createEmailDraft(draftRequest);
    await flushNotification();

    // sendMessage is called once — for the CEO notification (not for the draft itself,
    // which goes through createDraft). Verify the notification targets the CEO.
    expect(nylasClient.sendMessage).toHaveBeenCalledOnce();
    const sendArgs = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendArgs.to).toEqual([{ email: 'ceo@example.com' }]);
    expect(sendArgs.subject).toContain('Draft reply awaiting review');
    expect(sendArgs.subject).toContain('Partnership follow-up');
  });

  it('notification body includes recipient, subject, account, and draft ID', async () => {
    const { gateway, nylasClient } = makeGateway();
    await gateway.createEmailDraft(draftRequest);
    await flushNotification();

    const sendArgs = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Body is HTML (markdownToHtml converts the plain-text template), so check
    // for the key content fragments without assuming exact HTML structure.
    expect(sendArgs.body).toContain('partner@example.com');
    expect(sendArgs.body).toContain('Partnership follow-up');
    expect(sendArgs.body).toContain('joseph');
    expect(sendArgs.body).toContain('draft-abc');
  });

  it('returns success even when the CEO notification email fails to send', async () => {
    const { gateway } = makeGateway({
      nylasClient: {
        createDraft: vi.fn().mockResolvedValue({ id: 'draft-456' }),
        // Notification send fails — must not affect the draft result
        sendMessage: vi.fn().mockRejectedValue(new Error('SMTP timeout')),
      },
    });

    const result = await gateway.createEmailDraft(draftRequest);
    await flushNotification();

    // Draft creation succeeded — the notification failure is swallowed
    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-456');
  });

  it('returns success even when notification sendMessage resolves with no messageId', async () => {
    const { gateway } = makeGateway({
      nylasClient: {
        createDraft: vi.fn().mockResolvedValue({ id: 'draft-789' }),
        // sendMessage resolves but returns no id — dispatchEmail treats this as
        // { success: true, messageId: undefined }, so the notification "succeeds"
        // with a missing id. Draft result must still be unaffected.
        sendMessage: vi.fn().mockResolvedValue({ id: undefined }),
      },
    });

    const result = await gateway.createEmailDraft(draftRequest);
    await flushNotification();

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-789');
  });

  it('skips CEO notification when ceoEmail is not configured', async () => {
    const { gateway, nylasClient } = makeGateway({ ceoEmail: '' });

    const result = await gateway.createEmailDraft(draftRequest);
    await flushNotification();

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-abc');
    // sendMessage should never be called — notification was skipped
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('skips CEO notification when no email client is configured', async () => {
    const { gateway } = makeGateway({
      nylasClients: new Map(), // empty — no primary client
    });

    const result = await gateway.createEmailDraft(draftRequest);
    await flushNotification();

    // Draft creation fails (no client) — notification never attempted
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
    await flushNotification();

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    // Neither draft nor notification should be attempted
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
    await flushNotification();

    // Unlike send() which fail-opens on contact resolution errors, createEmailDraft
    // fail-closes: a draft for a blocked contact could be sent by a human later.
    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('Contact resolution failed');
    expect(nylasClient.createDraft).not.toHaveBeenCalled();
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses the actual primary account name when request.accountId is absent', async () => {
    const nylasClient = {
      createDraft: vi.fn().mockResolvedValue({ id: 'draft-no-acct' }),
      sendMessage: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    } as unknown as NylasClient;
    // Primary account is named "curia" — this is what should appear in the notification
    const nylasClients = new Map([['curia', nylasClient]]);
    const { gateway } = makeGateway({ nylasClients });

    const requestWithoutAccountId = { ...draftRequest, accountId: undefined };
    await gateway.createEmailDraft(requestWithoutAccountId);
    await flushNotification();

    const sendArgs = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The notification body should say "curia" not "primary" or "unknown"
    expect(sendArgs.body).toContain('curia');
    expect(sendArgs.body).not.toContain('"primary"');
    expect(sendArgs.body).not.toContain('"unknown"');
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
