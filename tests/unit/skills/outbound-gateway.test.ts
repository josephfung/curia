import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { createLogger } from '../../../src/logger.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import type { AutonomyService, AutonomyConfig } from '../../../src/autonomy/autonomy-service.js';
import type { PiiRedactor } from '../../../src/dispatch/pii-redactor.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import { readFile, realpath } from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
}));
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockRealpath = realpath as ReturnType<typeof vi.fn>;

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

/**
 * Build a ChannelIdentity fixture for the principal (CEO) contact.
 * Used to populate principalIdentities in OutboundGatewayConfig —
 * the old ceoEmail / ceoSignalNumber string fields were replaced by this
 * structure in Task 7 of the principal-identity feature.
 */
function makePrincipalIdentity(channelIdentifier: string, channel: 'email' | 'signal' = 'email') {
  return {
    id: `pi-${channel}-1`,
    contactId: 'ceo-contact-id',
    channel,
    channelIdentifier,
    label: null,
    verified: true,
    verifiedAt: null,
    source: 'ceo_stated' as const,
    status: 'active' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
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
      tier: 'blocked',       // issue #945
      kind: 'person',
      kgNodeId: null,
      verified: true,
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      tier: 'known',         // issue #945
      kind: 'person',
      kgNodeId: null,
      verified: true,
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('passes the structural recipient set (To + CC) to the content filter', async () => {
    // Unknown external recipient + the principal on CC. The filter must receive the
    // merged To+CC recipient set with isPrincipal computed structurally (via the
    // principal's verified channel identities), not from any contact role field.
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    await gateway.send({
      channel: 'email',
      to: 'armin@external.com',
      cc: ['ceo@example.com'],
      subject: 's',
      body: 'hello',
    });

    const checkSpy = mocks.contentFilter.check as ReturnType<typeof vi.fn>;
    expect(checkSpy).toHaveBeenCalledOnce();
    const arg = checkSpy.mock.calls[0]![0];
    expect(arg.principalIncluded).toBe(true);
    expect(arg.principalIsSoleRecipient).toBe(false);
    expect(arg.recipients).toEqual([
      { email: 'armin@external.com', isPrincipal: false },
      { email: 'ceo@example.com', isPrincipal: true },
    ]);
  });

  it('deduplicates the principal repeated across To+CC so it counts as the sole recipient', async () => {
    // The principal appears in both To and CC (here with differing case). After
    // case-insensitive dedup this is an effectively single-recipient principal-only
    // send, so principalIsSoleRecipient must be true (the judge would then skip).
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    await gateway.send({
      channel: 'email',
      to: 'ceo@example.com',
      cc: ['CEO@example.com'],
      subject: 's',
      body: 'private status for the CEO',
    });

    const checkSpy = mocks.contentFilter.check as ReturnType<typeof vi.fn>;
    expect(checkSpy).toHaveBeenCalledOnce();
    const arg = checkSpy.mock.calls[0]![0];
    expect(arg.recipients).toEqual([{ email: 'ceo@example.com', isPrincipal: true }]);
    expect(arg.principalIncluded).toBe(true);
    expect(arg.principalIsSoleRecipient).toBe(true);
  });

  it('tags a 1:1 Signal message to the principal via the Signal identity (sole recipient)', async () => {
    // A 1:1 Signal reply to the principal must be recognised as principal-sole via the
    // principal's verified SIGNAL identity — NOT the email matcher, which would mis-tag
    // it as a third party and force the judge to run on a private channel.
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const signalClient = makeSignalClient();

    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('+15555551111', 'signal')],
      logger: mocks.logger,
    });

    await gateway.send({ channel: 'signal', recipient: '+15555551111', message: 'private status update' });

    const checkSpy = mocks.contentFilter.check as ReturnType<typeof vi.fn>;
    expect(checkSpy).toHaveBeenCalledOnce();
    const arg = checkSpy.mock.calls[0]![0];
    expect(arg.recipients).toEqual([{ email: '+15555551111', isPrincipal: true }]);
    expect(arg.principalIsSoleRecipient).toBe(true);
  });

  it('allows sends when contact does not exist (null) and proceeds normally', async () => {
    // resolveByChannelIdentity returns null — unknown contact, not blocked
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('publishes outbound.delivered on a successful email send with payload fields populated', async () => {
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-42',
      displayName: 'Rita Recipient',
      role: null,
      status: 'confirmed',
      tier: 'known',         // issue #945
      kind: 'person',
      kgNodeId: null,
      verified: true,
      trustLevel: 'medium',
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest, {
      conversationId: 'conv-99',
      taskEventId: 'task-7',
      parentEventId: 'outbound-msg-1',
    });

    expect(result.success).toBe(true);

    const publishCalls = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const delivered = publishCalls
      .map((call) => call[1] as BusEvent)
      .find((evt) => evt.type === 'outbound.delivered');

    expect(delivered, 'expected exactly one outbound.delivered event').toBeDefined();
    expect(delivered!.payload).toMatchObject({
      channel: 'email',
      recipientId: 'recipient@example.com',
      recipientContactId: 'contact-42',
      content: 'Hi there!',
      conversationId: 'conv-99',
      taskEventId: 'task-7',
      messageId: 'msg-123',
    });
    expect(delivered!.parentEventId).toBe('outbound-msg-1');
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
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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

    it('surfaces the judge\'s abstract reason, a timestamp, and the audit event ID', async () => {
      // The Stage-2 judge reason is abstract by construction (never quotes the
      // offending value), so unlike Stage-1 details it IS safe to give the CEO —
      // it is what makes the notification actionable. The body must also carry a
      // timestamp and the audit event ID so the CEO can find the full record.
      const judgeReason = 'message contains hyper-sensitive financial or credential data';
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [{ rule: 'llm-judge-audience-leak', detail: judgeReason }],
        stage: 'llm',
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger: mocks.logger,
      });

      await gateway.send(baseRequest);

      // The outbound.blocked event is published first, then the notification —
      // grab the blocked event so we can assert the notification echoes its ID.
      const blockedEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[0][1] as BusEvent;
      const notificationEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[1][1] as BusEvent;
      expect(blockedEvent.type).toBe('outbound.blocked');
      expect(notificationEvent.type).toBe('outbound.notification');
      if (notificationEvent.type === 'outbound.notification' && blockedEvent.type === 'outbound.blocked') {
        // The judge's abstract reason IS surfaced (gives the CEO something to act on).
        expect(notificationEvent.payload.body).toContain(judgeReason);
        // A timestamp is present, explicitly labelled UTC.
        expect(notificationEvent.payload.body).toMatch(/Time: .+\(UTC\)/);
        // The audit event ID ties the alert to the full audit record.
        expect(notificationEvent.payload.body).toContain(blockedEvent.id);
      }
    });

    it('still withholds Stage-1 deterministic-rule detail from the notification body', async () => {
      // Regression guard for the per-rule policy: a deterministic finding's detail
      // can embed the matched fragment, so only its rule NAME may appear — never
      // the detail string. (The judge path is covered by the test above.)
      const secretFragment = 'sk-ant-zzzzzzzzzzzzzzzzzzzz0987654321ZZ';
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [{ rule: 'secret-pattern', detail: `API key: ${secretFragment}` }],
        stage: 'deterministic',
      });

      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger: mocks.logger,
      });

      await gateway.send(baseRequest);

      const notificationEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[1][1] as BusEvent;
      expect(notificationEvent.type).toBe('outbound.notification');
      if (notificationEvent.type === 'outbound.notification') {
        // The matched secret must never reach the notification...
        expect(notificationEvent.payload.body).not.toContain(secretFragment);
        // ...but the rule name is fine and tells the CEO which class of rule fired.
        expect(notificationEvent.payload.body).toContain('secret-pattern');
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
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
        recipientTier: 'unknown',
        recipients: [{ email: baseRequest.to, isPrincipal: false }],
        principalIncluded: false,
        principalIsSoleRecipient: false,
      });
    });

    it('forwards recipientTier=trusted to contentFilter when contact has tier=trusted', async () => {
      // Verify that a resolved contact with tier='trusted' propagates to the
      // content filter. This is the policy boundary that allows trusted recipients
      // (CEO's EA, CFO, board members) to receive third-party contact data.
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
        contactId: 'contact-ea',
        displayName: "CEO's EA",
        role: null,
        status: 'confirmed',
        tier: 'trusted',     // trust_level='high' → tier='trusted' (issue #945)
        kind: 'person',
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
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
        recipientTier: 'trusted',
        recipients: [{ email: baseRequest.to, isPrincipal: false }],
        principalIncluded: false,
        principalIsSoleRecipient: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive invariant tests — outbound.delivered must NEVER fire on a blocked
  // or failed send; bus.publish failure must NEVER propagate as a send failure.
  // These tests should pass immediately (no implementation changes needed) because
  // the emission is correctly wired inside `if (result.success)` blocks.
  // ---------------------------------------------------------------------------

  it('does NOT publish outbound.delivered when content filter blocks the send', async () => {
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      passed: false,
      findings: [{ rule: 'pii-credit-card', detail: 'card number detected' }],
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(false);
    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as BusEvent)
      .find((evt) => evt.type === 'outbound.delivered');
    expect(delivered).toBeUndefined();
  });

  it('does NOT publish outbound.delivered when Nylas throws', async () => {
    (mocks.nylasClient.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Nylas down'));

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(false);
    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as BusEvent)
      .find((evt) => evt.type === 'outbound.delivered');
    expect(delivered).toBeUndefined();
  });

  it('returns success even when publishing outbound.delivered throws', async () => {
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation(async (_layer: string, evt: BusEvent) => {
      if (evt.type === 'outbound.delivered') throw new Error('bus down');
    });

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    const result = await gateway.send(baseRequest);

    // The wire send succeeded — bus-publish failure must not surface as a send failure
    expect(result.success).toBe(true);
    // Verify the message ID is still returned (the Nylas send DID succeed)
    expect(result.messageId).toBeDefined();
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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

  it('returns false with available-accounts list when accountId is unknown', async () => {
    // draftRequest has accountId: 'joseph' — not in the map (only 'curia' is).
    const { gateway } = makeGateway({
      nylasClients: new Map([['curia', {} as unknown as NylasClient]]),
    });

    const result = await gateway.createEmailDraft(draftRequest);

    expect(result.success).toBe(false);
    // Must name the unknown account and list what's available so the coordinator can recover.
    expect(result.blockedReason).toContain("unknown account 'joseph'");
    expect(result.blockedReason).toContain('curia');
  });

  it('returns generic error when no email clients are configured at all', async () => {
    const requestWithoutAccount = { ...draftRequest, accountId: undefined };
    const { gateway } = makeGateway({
      nylasClients: new Map(), // empty — no primary client
    });

    const result = await gateway.createEmailDraft(requestWithoutAccount);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Email client not configured');
  });

  it('blocks draft creation for a blocked contact', async () => {
    const { gateway, nylasClient } = makeGateway({
      contactService: {
        resolveByChannelIdentity: vi.fn().mockResolvedValue({
          contactId: 'contact-blocked',
          status: 'blocked',
          tier: 'blocked',   // issue #945
          kind: 'person',
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

describe('OutboundGateway — attachment support', () => {
  function makeGatewayWithAttachments(nylasClientOverrides: Partial<NylasClient> = {}) {
    const logger = createLogger('error');
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'msg-attach-1' }),
      createDraft: vi.fn().mockResolvedValue({ id: 'draft-attach-1' }),
      getMessage: vi.fn().mockResolvedValue({ id: 'm1', from: [{ email: 's@example.com' }], subject: 'S' }),
      listMessages: vi.fn().mockResolvedValue([]),
      ...nylasClientOverrides,
    } as unknown as NylasClient;
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', nylasClient]]),
      contactService: {
        resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      } as unknown as ContactService,
      contentFilter: {
        check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
      } as unknown as OutboundContentFilter,
      bus: {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
      } as unknown as EventBus,
      principalIdentities: [],
      logger,
    });
    return { gateway, nylasClient };
  }

  beforeEach(() => {
    mockReadFile.mockReset();
    mockRealpath.mockReset();
    // Default: realpath is identity (no symlinks to resolve).
    mockRealpath.mockImplementation(async (p: string) => p);
    // readAttachmentFiles reads CURIA_TEMPFILE_DIR lazily; stub it so file:///tmp/... URLs pass
    // the store-dir boundary check without needing a real tmpfs mount.
    vi.stubEnv('CURIA_TEMPFILE_DIR', '/tmp');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads attachment files and passes them to sendMessage', async () => {
    const pdfContent = Buffer.from('fake pdf bytes');
    mockReadFile.mockResolvedValue(pdfContent);

    const { gateway, nylasClient } = makeGatewayWithAttachments();

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'With attachment',
      body: 'See attached.',
      attachments: [
        { fileUrl: 'file:///tmp/report.pdf', filename: 'report.pdf', contentType: 'application/pdf' },
      ],
    });

    expect(result.success).toBe(true);
    const sendArgs = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    const attachments = sendArgs.attachments as Array<{ filename: string; contentType: string; content: Buffer }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe('report.pdf');
    expect(attachments[0]!.contentType).toBe('application/pdf');
    expect(attachments[0]!.content).toEqual(pdfContent);
  });

  it('blocks send and returns error when attachment file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const { gateway, nylasClient } = makeGatewayWithAttachments();

    const result = await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'With attachment',
      body: 'See attached.',
      attachments: [
        { fileUrl: 'file:///tmp/missing.pdf', filename: 'missing.pdf', contentType: 'application/pdf' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('Attachment error');
    expect(nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('reads attachment files and passes them to createDraft', async () => {
    const pdfContent = Buffer.from('fake pdf bytes');
    mockReadFile.mockResolvedValue(pdfContent);

    const { gateway, nylasClient } = makeGatewayWithAttachments();

    const result = await gateway.createEmailDraft({
      channel: 'email',
      to: 'partner@example.com',
      accountId: 'curia',
      subject: 'Draft with attachment',
      body: 'Please review.',
      attachments: [
        { fileUrl: 'file:///tmp/contract.pdf', filename: 'contract.pdf', contentType: 'application/pdf' },
      ],
    });

    expect(result.success).toBe(true);
    expect(nylasClient.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          expect.objectContaining({
            filename: 'contract.pdf',
            contentType: 'application/pdf',
            content: pdfContent,
          }),
        ],
      }),
    );
  });

  it('blocks draft creation when attachment file is missing', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    const { gateway, nylasClient } = makeGatewayWithAttachments();

    const result = await gateway.createEmailDraft({
      channel: 'email',
      to: 'partner@example.com',
      accountId: 'curia',
      subject: 'Draft with attachment',
      body: 'Please review.',
      attachments: [
        { fileUrl: 'file:///tmp/missing.pdf', filename: 'missing.pdf', contentType: 'application/pdf' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('Attachment error');
    expect(nylasClient.createDraft).not.toHaveBeenCalled();
  });

  it('does not set attachments on sendMessage when none are provided', async () => {
    const { gateway, nylasClient } = makeGatewayWithAttachments();

    await gateway.send({
      channel: 'email',
      to: 'recipient@example.com',
      subject: 'No attachments',
      body: 'Hello.',
    });

    const sendArgs = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(sendArgs.attachments).toBeUndefined();
    expect(mockReadFile).not.toHaveBeenCalled();
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger,
    });

    await expect(gateway.getSignalGroupMembers('grpABC==')).rejects.toThrow('Signal client not configured');
  });
});

// ---------------------------------------------------------------------------
// Fix A — contact promotion after successful outbound send
// ---------------------------------------------------------------------------

describe('OutboundGateway contact promotion on successful send', () => {
  type MockPipeline = { incrementalUpdate: ReturnType<typeof vi.fn> };

  function makeGateway(
    contactService: ContactService,
    nylasClient: NylasClient,
    confidencePipeline?: MockPipeline,
  ) {
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger,
      confidencePipeline: confidencePipeline as unknown as import('../../../src/contacts/confidence-pipeline.js').ConfidencePipeline,
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
        // First call: blocked-contact check (returns provisional/unknown)
        .mockResolvedValueOnce({ contactId: 'contact-donna', status: 'provisional', tier: 'unknown', kind: 'person', trustLevel: null })
        // Second call: promotion lookup (returns provisional/unknown again)
        .mockResolvedValueOnce({ contactId: 'contact-donna', status: 'provisional', tier: 'unknown', kind: 'person', trustLevel: null }),
      setStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(contactService.setStatus).toHaveBeenCalledOnce();
    expect(contactService.setStatus).toHaveBeenCalledWith('contact-donna', 'confirmed');
    // trustLevel band-aid removed — confidence pipeline handles scoring now
    // (pipeline is optional and not provided in this test, so no scoring call fires)
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
    // trustLevel band-aid removed — confidence pipeline handles scoring now
    // (pipeline is optional and not provided in this test, so no scoring call fires)
  });

  it('does not promote a contact that is already confirmed', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-3' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-confirmed',
        status: 'confirmed',
        tier: 'known',       // issue #945
        kind: 'person',
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

  it('fires confidencePipeline message_sent for an already-confirmed contact', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-4' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-donna',
        status: 'confirmed',
        tier: 'known',       // issue #945
        kind: 'person',
        trustLevel: null,
      }),
    } as unknown as ContactService;

    const confidencePipeline: MockPipeline = {
      incrementalUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const gateway = makeGateway(contactService, nylasClient, confidencePipeline);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(confidencePipeline.incrementalUpdate).toHaveBeenCalledOnce();
    expect(confidencePipeline.incrementalUpdate).toHaveBeenCalledWith(
      'contact-donna',
      { type: 'message_sent' },
    );
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
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

    const { gateway, contentFilter, nylasClient } = makeGateway(piiRedactor);
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

    // Verify dispatch also received redacted content (not the original with PII).
    // The body goes through markdownToHtml() before reaching Nylas, so we
    // serialise the entire sendMessage call args and check for the redaction
    // marker rather than an exact string match.
    const sendCall = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(sendCall)).toContain('[REDACTED:');
    expect(JSON.stringify(sendCall)).not.toContain('4111');
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
      tier: 'principal',   // trust_level='ceo' → tier='principal' (issue #945)
      kind: 'principal',
      trustLevel: 'ceo',
    });

    const result = await gateway.send(piiRequest);

    expect(result.success).toBe(true);
    // The redactor is called twice for email — once for the body, once for the subject.
    // Both calls return unchanged content (CEO trust bypass), so the content filter
    // receives the original body.
    expect(piiRedactor.redact).toHaveBeenCalledTimes(2);
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

// ---------------------------------------------------------------------------
// sendEmailDraft — send an existing Nylas draft through the safety pipeline
// ---------------------------------------------------------------------------

describe('OutboundGateway.sendEmailDraft', () => {
  const DRAFT_ID = 'draft-abc123';
  const DRAFT_META = {
    recipientEmail: 'partner@example.com',
    body: '<p>Hello</p>',
    subject: 'Re: Project',
  };

  function makeGateway(overrides: {
    nylasClient?: Partial<NylasClient>;
    contactService?: Partial<ContactService>;
    autonomyService?: AutonomyService;
  } = {}) {
    const logger = createLogger('error');
    const nylasClient = {
      sendDraft: vi.fn().mockResolvedValue({ id: 'sent-msg-1' }),
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

    const gateway = new OutboundGateway({
      nylasClients: new Map([['joseph', nylasClient]]),
      contactService,
      contentFilter,
      bus,
      // principalIdentities enables the CEO email bypass check in isPrincipalEmail()
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger,
      autonomyService: overrides.autonomyService,
    });

    return { gateway, nylasClient, contactService, contentFilter, bus };
  }

  it('calls nylasClient.sendDraft with the correct draftId and returns success', async () => {
    const { gateway, nylasClient } = makeGateway();
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('sent-msg-1');
    expect(nylasClient.sendDraft).toHaveBeenCalledWith(DRAFT_ID);
  });

  it('blocks send to a blocked contact before calling nylasClient.sendDraft', async () => {
    const { gateway, nylasClient } = makeGateway({
      contactService: {
        resolveByChannelIdentity: vi.fn().mockResolvedValue({
          contactId: 'contact-blocked',
          status: 'blocked',
          tier: 'blocked',   // issue #945
          kind: 'person',
          trustLevel: null,
        }),
      },
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it('blocks send when content filter rejects the draft body', async () => {
    const { gateway, nylasClient, contentFilter } = makeGateway();
    (contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'secret-pattern', detail: 'Key detected' }],
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Content blocked by filter');
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it('bypasses the autonomy gate when humanApproved: true and score < 70', async () => {
    const { gateway, nylasClient } = makeGateway({
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META, { humanApproved: true });

    expect(result.success).toBe(true);
    expect(nylasClient.sendDraft).toHaveBeenCalledWith(DRAFT_ID);
  });

  it('blocks send when autonomy score < 70 and humanApproved is not set', async () => {
    const { gateway, nylasClient } = makeGateway({
      autonomyService: makeAutonomyService(65),
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toMatch(/autonomy/i);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it('bypasses the autonomy gate when draft recipient is the CEO email and score < 70', async () => {
    const { gateway, nylasClient } = makeGateway({
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', {
      recipientEmail: 'ceo@example.com',
      body: 'Hi CEO!',
      subject: 'Update',
    });

    expect(result.success).toBe(true);
    expect(nylasClient.sendDraft).toHaveBeenCalledWith(DRAFT_ID);
  });

  it('runs the content filter over the full To+CC envelope so a draft To: principal + CC: third party is not treated as sole-principal (#547)', async () => {
    const { gateway, contentFilter } = makeGateway();
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', {
      recipientEmail: 'ceo@example.com',
      body: 'internal note',
      subject: 's',
      // To: principal, CC: external third party.
      allRecipients: ['ceo@example.com', 'armin@external.com'],
    });

    expect(result.success).toBe(true);
    const checkSpy = contentFilter.check as ReturnType<typeof vi.fn>;
    expect(checkSpy).toHaveBeenCalledOnce();
    const arg = checkSpy.mock.calls[0]![0];
    // The judge must RUN: principal is present but NOT the sole recipient.
    expect(arg.principalIncluded).toBe(true);
    expect(arg.principalIsSoleRecipient).toBe(false);
    expect(arg.recipients).toEqual([
      { email: 'ceo@example.com', isPrincipal: true },
      { email: 'armin@external.com', isPrincipal: false },
    ]);
  });

  it('treats a draft addressed solely to the principal as sole-recipient (judge skips)', async () => {
    const { gateway, contentFilter } = makeGateway();
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', {
      recipientEmail: 'ceo@example.com',
      body: 'internal note',
      subject: 's',
      allRecipients: ['ceo@example.com'],
    });

    expect(result.success).toBe(true);
    const checkSpy = contentFilter.check as ReturnType<typeof vi.fn>;
    expect(checkSpy).toHaveBeenCalledOnce();
    const arg = checkSpy.mock.calls[0]![0];
    expect(arg.principalIncluded).toBe(true);
    expect(arg.principalIsSoleRecipient).toBe(true);
    expect(arg.recipients).toEqual([{ email: 'ceo@example.com', isPrincipal: true }]);
  });

  it('returns failure when nylasClient.sendDraft throws', async () => {
    const { gateway } = makeGateway({
      nylasClient: {
        sendDraft: vi.fn().mockRejectedValue(new Error('Nylas API error')),
      },
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toMatch(/draft send failed/i);
  });

  it('publishes outbound.delivered when sendEmailDraft succeeds', async () => {
    const nylasWithSendDraft = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-msg-1' }),
      sendDraft: vi.fn().mockResolvedValue({ id: 'sent-from-draft-1' }),
      getMessage: vi.fn().mockResolvedValue({}),
      listMessages: vi.fn().mockResolvedValue([]),
    } as unknown as NylasClient;

    const logger = createLogger('error');
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'draft-recipient',
        displayName: 'Draft Recipient',
        role: null,
        status: 'confirmed',
        tier: 'known',
        kind: 'person',
        kgNodeId: null,
        verified: true,
        trustLevel: 'medium',
      }),
    } as unknown as ContactService;
    const contentFilter = {
      check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
    } as unknown as OutboundContentFilter;
    const bus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    } as unknown as EventBus;

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', nylasWithSendDraft]]),
      contactService,
      contentFilter,
      bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger,
    });

    const result = await gateway.sendEmailDraft(
      'draft-xyz',
      'curia',
      { recipientEmail: 'reply@example.com', body: 'approved reply', subject: 'Re: hi' },
      { humanApproved: true },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('sent-from-draft-1');

    const delivered = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as BusEvent)
      .find((evt) => evt.type === 'outbound.delivered');

    expect(delivered, 'expected outbound.delivered from sendEmailDraft').toBeDefined();
    expect(delivered!.payload).toMatchObject({
      channel: 'email',
      recipientId: 'reply@example.com',
      recipientContactId: 'draft-recipient',
      content: 'approved reply',
      messageId: 'sent-from-draft-1',
    });
  });
});

describe('humanApproved option on send()', () => {
  it('bypasses the autonomy gate when humanApproved: true and score < 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { humanApproved: true },
    );

    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('still enforces the blocked-contact check when humanApproved: true', async () => {
    const mocks = createMocks();
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-1',
      displayName: 'Blocked Person',
      role: null,
      status: 'blocked',
      tier: 'blocked',
      kind: 'person',
      kgNodeId: null,
      verified: true,
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { humanApproved: true },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('still enforces the content filter when humanApproved: true', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'test-rule', detail: 'blocked in test' }],
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { humanApproved: true },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Content blocked by filter');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gated draft-fallback (two-step pattern) — Task 4
// ---------------------------------------------------------------------------

/** Build a stub ActionLogRepo for testing the two-step draft-fallback pattern. */
function makeActionLogRepo() {
  return {
    insert: vi.fn().mockResolvedValue(1),
    linkPayload: vi.fn().mockResolvedValue(true),
    setNotificationSentAt: vi.fn().mockResolvedValue(undefined),
  } as unknown as ActionLogRepo;
}

describe('gated draft-fallback (two-step pattern)', () => {
  // Standard re-execution recipe the email adapter would pass to gateway.send().
  // Tests that exercise the pending_approval write path must include this to opt in.
  const TEST_RECIPE = {
    skillName: 'send-draft',
    partialPayload: { account: 'curia' },
    description: 'Draft reply to recipient@example.com — "Hello". Use send-draft to approve.',
  } as const;

  it('returns { gated: true, actionRef } when score < threshold and reExecRecipe provided', async () => {
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', conversationId: 'conv-456', reExecRecipe: TEST_RECIPE },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(result.actionRef).toMatch(/^[0-9a-f]{8}$/);
    expect(result.blockedReason).toMatch(/autonomy score.*65.*below.*send threshold/i);
  });

  it('skips action_log write and returns no actionRef when reExecRecipe is not provided', async () => {
    // Adapters opt in to the pending_approval lifecycle by passing reExecRecipe.
    // Without it the gateway gates the send but does not write a row or return an actionRef.
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123' }, // no reExecRecipe
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(result.actionRef).toBeUndefined();
    expect(actionLogRepo.insert).not.toHaveBeenCalled();
  });

  it('writes action_log row using recipe skillName, payload, and description', async () => {
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const recipe = {
      skillName: 'send-draft',
      partialPayload: { account: 'joseph' },
      description: 'Draft reply to partner@example.com — "Project update". Use send-draft to approve.',
    };

    await gateway.send(
      { channel: 'email', to: 'partner@example.com', subject: 'Project update', body: 'Content' },
      { taskEventId: 'task-789', reExecRecipe: recipe },
    );

    expect(actionLogRepo.insert).toHaveBeenCalledOnce();
    const insertArg = (actionLogRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertArg.skillName).toBe('send-draft');
    expect(insertArg.payload).toEqual({ account: 'joseph' });
    expect(insertArg.description).toBe(recipe.description);
    expect(insertArg.taskId).toBe('task-789');
    expect(insertArg.actionRisk).toBe('medium');
    expect(insertArg.outcome).toBe('pending_approval');
    expect(insertArg.shortRef).toMatch(/^[0-9a-f]{8}$/);
  });

  it('skips action_log write when actionLogRepo is not wired', async () => {
    const mocks = createMocks();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      // actionLogRepo intentionally omitted
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    // Still gated, but without actionRef
    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(result.actionRef).toBeUndefined();
  });

  it('skips action_log write when taskEventId is missing', async () => {
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { reExecRecipe: TEST_RECIPE }, // taskEventId intentionally omitted
    );

    // Still gated, but without actionRef — and no insert called
    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(result.actionRef).toBeUndefined();
    expect(actionLogRepo.insert).not.toHaveBeenCalled();
  });

  it('notifies CEO when autonomy gate blocks a send and actionLogRepo + taskEventId are present', async () => {
    // Bug fix: gateway-level gate blocks must notify the CEO — previously only the
    // execution-layer ApprovalTriggerService sent notifications, leaving gateway blocks silent.
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', conversationId: 'conv-456', reExecRecipe: TEST_RECIPE },
    );

    const publishCalls = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const notificationCalls = publishCalls.filter(
      (call: unknown[]) => (call[1] as BusEvent).type === 'outbound.notification',
    );
    expect(notificationCalls).toHaveLength(1);
    const notificationEvent = notificationCalls[0]![1] as BusEvent;
    if (notificationEvent.type === 'outbound.notification') {
      expect(notificationEvent.payload.notificationType).toBe('approval_requested');
      expect(notificationEvent.payload.ceoEmail).toBe('ceo@example.com');
    }
  });

  it('calls setNotificationSentAt with the row id after successful notification', async () => {
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();
    // insert returns row id 42 so we can assert setNotificationSentAt is called with 42
    (actionLogRepo.insert as ReturnType<typeof vi.fn>).mockResolvedValue(42);

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    expect(actionLogRepo.setNotificationSentAt).toHaveBeenCalledOnce();
    expect(actionLogRepo.setNotificationSentAt).toHaveBeenCalledWith(42);
  });

  it('does not throw and still returns gated result when sendNotification fails', async () => {
    // sendNotification() has an internal try-catch, so a bus.publish failure must not
    // surface as a gateway error — the send is still blocked and gated: true is returned.
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Bus error'));

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    // Gate must still fire correctly despite the notification failure
    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    // Notification failed → setNotificationSentAt must NOT be called
    expect(actionLogRepo.setNotificationSentAt).not.toHaveBeenCalled();
  });

  it('returns undefined actionRef when insert throws (no phantom reference)', async () => {
    // HIGH: actionRef must only be set after insert() confirms the DB row exists.
    // If insert throws, the gateway must not return an actionRef pointing to a
    // non-existent DB row (phantom reference).
    const mocks = createMocks();
    const actionLogRepo = {
      insert: vi.fn().mockRejectedValue(new Error('DB connection error')),
      linkPayload: vi.fn(),
      setNotificationSentAt: vi.fn(),
    } as unknown as ActionLogRepo;

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo,
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    // Send is still blocked (gated) but actionRef must be undefined — no DB row was written
    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(result.actionRef).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// linkGatedAction — Task 5
// ---------------------------------------------------------------------------

describe('OutboundGateway.linkGatedAction', () => {
  it('delegates to actionLogRepo.linkPayload', async () => {
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      actionLogRepo,
    });

    await gateway.linkGatedAction('email-1', 'task-evt-001', { draftId: 'draft-abc' });

    expect(actionLogRepo.linkPayload).toHaveBeenCalledOnce();
    expect(actionLogRepo.linkPayload).toHaveBeenCalledWith('email-1', 'task-evt-001', { draftId: 'draft-abc' });
  });

  it('is a no-op when actionLogRepo is not wired', async () => {
    const mocks = createMocks();

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      // actionLogRepo intentionally omitted
    });

    // Should not throw
    await gateway.linkGatedAction('email-1', undefined, { draftId: 'draft-abc' });
  });

  it('logs warn when linkPayload returns false (unknown ref)', async () => {
    const mocks = createMocks();
    const actionLogRepo = makeActionLogRepo();
    (actionLogRepo.linkPayload as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    // Use a logger that captures log calls
    const warnSpy = vi.fn();
    const logger = {
      child: () => ({
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
        debug: vi.fn(),
      }),
    } as unknown as import('../../../src/logger.js').Logger;

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger,
      actionLogRepo,
    });

    await gateway.linkGatedAction('email-99', undefined, { draftId: 'draft-xyz' });

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ actionRef: 'email-99' }),
      expect.stringContaining('no pending row'),
    );
  });
});

// ---------------------------------------------------------------------------
// isSystemNotification option on send() — system alerts bypass the autonomy gate
// ---------------------------------------------------------------------------
// System notifications (e.g. approval_requested, blocked_content alerts sent TO
// the CEO) must never be silenced by the same autonomy gate they are reporting on.
// isSystemNotification: true skips Step 0 only; all other safety checks still run.

describe('isSystemNotification option on send()', () => {
  it('bypasses the autonomy gate when isSystemNotification: true and score < 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Action needed', body: 'Approval required.' },
      { isSystemNotification: true },
    );

    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
    // autonomy.send_blocked must NOT fire — we bypassed the gate
    expect(mocks.bus.publish).not.toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({ type: 'autonomy.send_blocked' }),
    );
  });

  it('still enforces the blocked-contact check when isSystemNotification: true', async () => {
    const mocks = createMocks();
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-1',
      displayName: 'Blocked',
      role: null,
      status: 'blocked',
      tier: 'blocked',
      kind: 'person',
      kgNodeId: null,
      verified: true,
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'blocked@example.com', subject: 'Hi', body: 'Hi.' },
      { isSystemNotification: true },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('still enforces the content filter when isSystemNotification: true', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'test-rule', detail: 'blocked in test' }],
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Hi', body: 'Hi.' },
      { isSystemNotification: true },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Content blocked by filter');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CEO recipient bypass on send() — agent-to-principal communication bypasses
// the autonomy gate. All other safety checks (blocked-contact, content filter)
// still run. See design: docs/wip/2026-05-05-ceo-gate-bypass-design.md
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// outbound.delivered for Signal 1:1 sends — Task 4
// ---------------------------------------------------------------------------

describe('outbound.delivered on Signal send', () => {
  it('publishes outbound.delivered on a successful 1:1 Signal send', async () => {
    const mocks = createMocks();

    const signalClient = {
      send: vi.fn().mockResolvedValue(undefined),
      listGroups: vi.fn().mockResolvedValue([]),
    } as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient;

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-signal-1',
      displayName: 'Phone Friend',
      role: null,
      status: 'confirmed',
      tier: 'known',
      kind: 'person',
      kgNodeId: null,
      verified: true,
      trustLevel: 'medium',
    });

    const gateway = new OutboundGateway({
      signalClient,
      signalPhoneNumber: '+15550001111',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('+15550009999', 'signal')],
      logger: mocks.logger,
    });

    const result = await gateway.send(
      { channel: 'signal', recipient: '+15555550123', message: 'pinging you' },
      { conversationId: 'signal:+15555550123', taskEventId: 'task-99' },
    );

    expect(result.success).toBe(true);

    const publishCalls = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const delivered = publishCalls
      .map((call) => call[1] as BusEvent)
      .find((evt) => evt.type === 'outbound.delivered');

    expect(delivered, 'expected outbound.delivered for 1:1 Signal send').toBeDefined();
    expect(delivered!.payload).toMatchObject({
      channel: 'signal',
      recipientId: '+15555550123',
      recipientContactId: 'contact-signal-1',
      content: 'pinging you',
      conversationId: 'signal:+15555550123',
      taskEventId: 'task-99',
    });
    // messageId is intentionally omitted — signal-cli RPC returns no ID
    expect(delivered!.payload.messageId).toBeUndefined();
  });

  it('publishes outbound.delivered on a successful Signal group send', async () => {
    const mocks = createMocks();

    const signalClient = {
      send: vi.fn().mockResolvedValue(undefined),
      listGroups: vi.fn().mockResolvedValue([
        {
          id: 'group-base64==',
          name: 'Test Group',
          members: [
            { number: '+15555550001' },
            { number: '+15555550002' },
          ],
          pendingMembers: [],
          isMember: true,
        },
      ]),
    } as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient;

    // contactService returns null for the group ID lookup — groups have no individual contact record.
    // The blocked-contact check sees null and proceeds (fail-open / no record = not blocked).
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const gateway = new OutboundGateway({
      signalClient,
      signalPhoneNumber: '+15550001111',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('+15550009999', 'signal')],
      logger: mocks.logger,
    });

    const result = await gateway.send(
      { channel: 'signal', groupId: 'group-base64==', message: 'group ping' },
      { conversationId: 'signal:group=group-base64==' },
    );

    expect(result.success).toBe(true);

    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as BusEvent)
      .find((evt) => evt.type === 'outbound.delivered');

    expect(delivered, 'expected outbound.delivered for Signal group send').toBeDefined();
    expect(delivered!.payload).toMatchObject({
      channel: 'signal',
      recipientId: 'group-base64==',
      content: 'group ping',
      conversationId: 'signal:group=group-base64==',
    });
    // messageId is intentionally omitted — signal-cli RPC returns no ID
    expect(delivered!.payload.messageId).toBeUndefined();
  });
});

describe('CEO recipient bypass on send()', () => {
  it('bypasses the autonomy gate when recipient is the CEO email and score < 70', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65), // below 70 — would normally block
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Status update', body: 'All done.' },
    );

    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
    // autonomy.send_blocked must NOT fire — we bypassed the gate
    const publishedEvents = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map(([, evt]: [string, BusEvent]) => evt.type);
    expect(publishedEvents).not.toContain('autonomy.send_blocked');
  });

  it('bypasses the autonomy gate for case-insensitive CEO email match', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('CEO@Example.COM')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
  });

  it('bypasses the autonomy gate when Signal recipient is the CEO number', async () => {
    const mocks = createMocks();
    const signalClient = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+10000000000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('+14155551234', 'signal')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'signal', recipient: '+14155551234', message: 'Status update' },
    );

    expect(result.success).toBe(true);
    expect(signalClient.send).toHaveBeenCalledOnce();
  });

  it('does NOT bypass for non-CEO recipients — gate still blocks', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'stranger@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('still enforces the content filter when recipient is CEO', async () => {
    const mocks = createMocks();
    (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'test-rule', detail: 'blocked in test' }],
    });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'ceo@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Content blocked by filter');
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not bypass when no principal email identity is configured', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      // principalIdentities intentionally omitted — empty array is the default
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'anyone@example.com', subject: 'Hello', body: 'Hi!' },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
  });

  it('does not bypass Signal when no principal Signal identity is configured', async () => {
    const mocks = createMocks();
    const signalClient = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+10000000000',
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      // principalIdentities intentionally omitted — empty array is the default
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
    });

    const result = await gateway.send(
      { channel: 'signal', recipient: '+14155551234', message: 'Hello' },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
  });
});
