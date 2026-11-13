import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutboundGateway, UnknownEmailAccountError, PRINCIPAL_MAILBOX_ACCOUNT_REFUSAL, PRINCIPAL_SEND_DIGEST_REASONS, PRINCIPAL_SEND_REFUSALS, LIMIT_REFUSALS, refusalKindOf, askPreamble, hasTransientErrorSignal } from '../../../src/skills/outbound-gateway.js';
import { createLogger } from '../../../src/logger.js';
import type { NylasClient, NylasMessage } from '../../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import type { AutonomyService, AutonomyConfig } from '../../../src/autonomy/autonomy-service.js';
import type { PiiRedactor } from '../../../src/dispatch/pii-redactor.js';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import { BLOCK_REASON, BandSendReview } from '../../../src/dispatch/band-send-review.js';
import { FailOpenLimiter } from '../../../src/autonomy/band-policy.js';
import type { OutboundQueueRepo } from '../../../src/skills/outbound-queue-repo.js';
import { readFile, realpath } from 'node:fs/promises';
import { buildReplyQuote, REPLY_QUOTE_HTML_OPEN } from '../../../src/skills/_shared/reply-quote.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
}));
/**
 * A block reason without the recipient note (#2033). These mocks resolve no
 * contact, so every filter block also names its recipient; tests that pin the
 * filter's own reason compare the part before the note.
 */
function reasonBeforeRecipientNote(reason: string | undefined): string | undefined {
  return reason?.split('\n\nRecipient check:')[0];
}

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockRealpath = realpath as ReturnType<typeof vi.fn>;

type DraftMeta = Parameters<OutboundGateway['sendEmailDraft']>[2];
/** The stored draft a send checked, as Nylas returns it. */
function storedDraft(meta: DraftMeta): NylasMessage {
  const to = (meta.allRecipients && meta.allRecipients.length > 0 ? meta.allRecipients : [meta.recipientEmail]).map((email) => ({ email }));
  return { id: 'd', threadId: 't', subject: meta.subject, from: [], to, cc: [], bcc: [], body: meta.body, snippet: '', date: 0, unread: false, folders: [], attachments: [] };
}

// sendEmailDraft re-reads the draft just before sending and refuses one that changed (#2312).
// Unless a test stubs getDraft itself, the re-read serves back the draft that call checked.
const echoedGetDrafts = new WeakSet<object>();
const realSendEmailDraft = OutboundGateway.prototype.sendEmailDraft;
OutboundGateway.prototype.sendEmailDraft = function (this: OutboundGateway, draftId, accountId, meta, options) {
  const client = (this as unknown as { getNylasClient(a?: string): Record<string, unknown> | undefined }).getNylasClient(accountId);
  const own = client?.['getDraft'];
  if (client && (own === undefined || echoedGetDrafts.has(own as object))) {
    const echo = vi.fn().mockResolvedValue(storedDraft(meta));
    echoedGetDrafts.add(echo);
    client['getDraft'] = echo;
  }
  return realSendEmailDraft.call(this, draftId, accountId, meta, options);
};

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
    });

    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toBe('Recipient is blocked');
    // Safety check: we must never hit Nylas or the content filter for blocked contacts
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    expect(mocks.contentFilter.check).not.toHaveBeenCalled();
  });

  describe('every To and CC recipient (#2273)', () => {
    const blockedOnly = (address: string) => (channel: string, identifier: string) => Promise.resolve(
      identifier === address
        ? { contactId: 'blocked-1', displayName: 'Blocked', role: null, tier: 'blocked', kind: 'person', kgNodeId: null, verified: true }
        : null,
    );
    const makeGateway = () => new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });

    it.each([
      ['a CC', { cc: ['blocked@example.com'] }],
      ['a further To', { additionalTo: ['blocked@example.com'] }],
    ])('refuses a send with a blocked contact on %s', async (_label, extra) => {
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>)
        .mockImplementation(blockedOnly('blocked@example.com'));

      const result = await makeGateway().send({ ...baseRequest, ...extra });

      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('Recipient is blocked');
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    });

    it('dispatches every To address to Nylas, primary first', async () => {
      const result = await makeGateway().send({ ...baseRequest, additionalTo: ['second@example.com'], cc: ['cc@example.com'] });

      expect(result.success).toBe(true);
      expect(mocks.nylasClient.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        to: [{ email: 'recipient@example.com' }, { email: 'second@example.com' }],
        cc: [{ email: 'cc@example.com' }],
      }));
    });

    it.each([
      ['a further To', { additionalTo: ['other@example.com'] }],
      ['a CC', { cc: ['other@example.com'] }],
    ])('keeps the autonomy gate when the CEO is on To with %s', async (_label, extra) => {
      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger: mocks.logger,
        autonomyService: makeAutonomyService(65),
      });

      const alone = await gateway.send({ ...baseRequest, to: 'ceo@example.com' });
      expect(alone.success).toBe(true);

      const withOthers = await gateway.send({ ...baseRequest, to: 'ceo@example.com', ...extra });
      expect(withOthers.success).toBe(false);
      expect(withOthers.blockedReason).toContain('autonomy');
      expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
    });

    it('creates no contact for a To copied from Curia\'s own message', async () => {
      const createContact = vi.fn().mockResolvedValue({ id: 'new-contact' });
      Object.assign(mocks.contactService, { createContact, linkIdentity: vi.fn().mockResolvedValue(undefined) });
      const gateway = makeGateway();

      const own = await gateway.send({ ...baseRequest, toFromOwnMessage: true });
      expect(own.success).toBe(true);
      expect(createContact).not.toHaveBeenCalled();

      // Control: the same send without the flag creates the contact.
      const received = await gateway.send(baseRequest);
      expect(received.success).toBe(true);
      expect(createContact).toHaveBeenCalledOnce();
    });

    it('refuses a draft with a blocked contact on a further To, and drafts every To otherwise', async () => {
      const createDraft = vi.fn().mockResolvedValue({ id: 'draft-1' });
      (mocks.nylasClient as unknown as Record<string, unknown>).createDraft = createDraft;
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>)
        .mockImplementation(blockedOnly('blocked@example.com'));
      const gateway = makeGateway();

      const blocked = await gateway.createEmailDraft({ ...baseRequest, additionalTo: ['blocked@example.com'] });
      expect(blocked).toEqual({ success: false, blockedReason: 'Recipient is blocked' });
      expect(createDraft).not.toHaveBeenCalled();

      const drafted = await gateway.createEmailDraft({ ...baseRequest, additionalTo: ['second@example.com'] });
      expect(drafted.success).toBe(true);
      expect(createDraft).toHaveBeenCalledWith(expect.objectContaining({
        to: [{ email: 'recipient@example.com' }, { email: 'second@example.com' }],
      }));
    });
  });

  it('allows sends to non-blocked contacts and returns success with messageId', async () => {
    // The contact is confirmed — should proceed normally
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-2',
      displayName: 'Confirmed Person',
      role: null,
      tier: 'known',
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

  it('converts markdown links to sanitized HTML before sending email', async () => {
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
      ...baseRequest,
      body: 'Please review [the profile](https://example.com/profile).',
    });

    const sendArgs = (mocks.nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
    expect(sendArgs.body).toContain('<a href="https://example.com/profile"');
    expect(sendArgs.body).toContain('>the profile</a>');
    expect(sendArgs.body).not.toContain('[the profile]');
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
      tier: 'known',
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

  // Approval delivery binds it, so a reply on the thread is matched to the approval (#2333).
  it('returns the sent email\'s thread', async () => {
    (mocks.nylasClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'msg-9', threadId: 'thread-9' });
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });
    const result = await gateway.send(baseRequest, { isSystemNotification: true });
    expect(result).toMatchObject({ success: true, messageId: 'msg-9', threadId: 'thread-9' });
  });

  // ------------------------------------------------------------------
  // No-reply / automated recipient guard (#1302)
  // ------------------------------------------------------------------
  // Regression: the coordinator's implicit reply to an inbound automated
  // notification was auto-addressed back to the noreply@ sender, carrying
  // principal-directed status ("pending approval on your end"). A no-reply
  // address is a dead-end *recipient* problem — the gateway hard-blocks the send
  // (like a blocked contact) instead of delivering to a dead address, and does so
  // before the (expensive) content-filter LLM call.
  describe('no-reply / automated recipient guard (#1302)', () => {
    function makeGateway() {
      return new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger: mocks.logger,
      });
    }

    it('blocks an email whose sole recipient is a no-reply address, without hitting Nylas or the filter', async () => {
      const gateway = makeGateway();

      const result = await gateway.send({
        channel: 'email',
        to: 'noreply@external-service.com',
        subject: 'Re: your account',
        body: 'The system put a hold on that. Pending approval on your end.',
      });

      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe(
        'Recipient is a no-reply/automated address; message not deliverable',
      );
      // Hard block, not a content-rewrite affordance: no blockedRules for the agent
      // to retry against (the recipient is immutable — retrying would be futile).
      expect(result.blockedRules).toBeUndefined();
      // Dropped before the transport and before the content-filter LLM call.
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
      expect(mocks.contentFilter.check).not.toHaveBeenCalled();
    });

    it('records an outbound.blocked audit event but does NOT send the CEO an FYI notification', async () => {
      const gateway = makeGateway();

      await gateway.send({
        channel: 'email',
        to: 'noreply@external-service.com',
        subject: 'Re: your account',
        body: 'principal-directed status narration',
      });

      const publishedTypes = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[1] as BusEvent).type,
      );
      // Audit note required by the #1302 acceptance criteria.
      expect(publishedTypes).toContain('outbound.blocked');
      // Routine automated notifications: a per-drop CEO alert would be noise. No FYI.
      expect(publishedTypes).not.toContain('outbound.notification');

      const blocked = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[1] as BusEvent)
        .find((e) => e.type === 'outbound.blocked');
      expect(blocked).toBeDefined();
      if (blocked && blocked.type === 'outbound.blocked') {
        expect(blocked.payload.reason).toBe('no_reply_recipient');
        expect(blocked.payload.findings[0]!.rule).toBe('no-reply-recipient');
      }
    });

    it.each([
      'donotreply@service.com',
      'do-not-reply@service.com',
      'mailer-daemon@service.com',
      'notifications@service.com',
      'alerts@service.com',
      'updates@service.com',
      'bounces@service.com',
    ])('blocks the full automated-classifier breadth: %s', async (address) => {
      const gateway = makeGateway();

      const result = await gateway.send({ channel: 'email', to: address, subject: 'x', body: 'y' });

      expect(result.success).toBe(false);
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    });

    it('does NOT block a normal human recipient (falls through to filter + dispatch)', async () => {
      const gateway = makeGateway();

      const result = await gateway.send({
        channel: 'email',
        to: 'jane.doe@example.com',
        subject: 'Hello',
        body: 'Hi there',
      });

      expect(result.success).toBe(true);
      expect(mocks.contentFilter.check).toHaveBeenCalledOnce();
      expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
    });

    it('does NOT block a mixed send that merely CCs a no-reply address (a human is still on it)', async () => {
      const gateway = makeGateway();

      const result = await gateway.send({
        channel: 'email',
        to: 'jane.doe@example.com',
        cc: ['noreply@external-service.com'],
        subject: 'Hello',
        body: 'Hi there',
      });

      expect(result.success).toBe(true);
      expect(mocks.nylasClient.sendMessage).toHaveBeenCalledOnce();
    });
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
      // The blocked result now carries the principal-safe reason summary and the
      // rule name(s) so the agent's tool loop can self-correct and retry (#1051).
      // For a Stage-1 deterministic rule, the summary is the rule name only.
      expect(reasonBeforeRecipientNote(result.blockedReason)).toBe('secret-pattern');
      expect(result.blockedRules).toEqual(['secret-pattern']);
    });

    it('returns the judge\'s abstract reason and rule name so the agent can self-correct (LLM-judge block)', async () => {
      // #1051: when a Stage-2 LLM judge blocks the send, the skill result must
      // carry the judge's abstract reason (safe to surface — it never quotes the
      // offending value) plus the rule name, giving the agent's tool loop enough
      // signal to rewrite the message and retry organically.
      const judgeReason = 'internal fallback reasoning leaked into the reply body';
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

      const result = await gateway.send(baseRequest);

      expect(result.success).toBe(false);
      // The judge's reason IS surfaced — it's what lets the agent address the root cause.
      expect(result.blockedReason).toContain(judgeReason);
      expect(result.blockedReason).toContain('llm-judge-audience-leak');
      expect(result.blockedRules).toEqual(['llm-judge-audience-leak']);
    });

    it('tells the agent where a note for the principal goes when that rule blocks (prompt trim PR 5)', async () => {
      const detail = 'A <note_for_principal> block goes only in your final response.';
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [{ rule: 'principal-note-markup', detail }],
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
      expect(reasonBeforeRecipientNote(result.blockedReason)).toBe(`principal-note-markup: ${detail}`);
      expect(result.blockedRules).toEqual(['principal-note-markup']);
    });

    it('never leaks a Stage-1 deterministic finding\'s detail into the blocked result', async () => {
      // #1051 safety contract: the blocked result is LLM-facing, so it must obey
      // the same per-rule policy as the CEO notification — a deterministic rule's
      // detail can embed the matched secret, so only its rule NAME may appear.
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

      const result = await gateway.send(baseRequest);

      expect(result.success).toBe(false);
      // The matched secret must never reach the LLM-facing result...
      expect(result.blockedReason).not.toContain(secretFragment);
      // ...but the rule name is safe and tells the agent which class of rule fired.
      expect(reasonBeforeRecipientNote(result.blockedReason)).toBe('secret-pattern');
      expect(result.blockedRules).toEqual(['secret-pattern']);
    });

    it('with mixed findings, surfaces only the judge detail but all rule names (#1051 safety contract)', async () => {
      // When a send trips both a Stage-1 deterministic rule (whose detail embeds a
      // secret) and a Stage-2 judge rule (whose detail is abstract), the LLM-facing
      // reason must surface ONLY the judge's detail — the secret stays hidden — while
      // blockedRules lists every rule so the agent knows the full set it tripped.
      const secretFragment = 'sk-ant-yyyyyyyyyyyyyyyyyyyy1122334455YY';
      const judgeReason = 'reply mixes confidential and external content';
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
        passed: false,
        findings: [
          { rule: 'secret-pattern', detail: `API key: ${secretFragment}` },
          { rule: 'llm-judge-audience-leak', detail: judgeReason },
        ],
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

      const result = await gateway.send(baseRequest);

      expect(result.success).toBe(false);
      // The Stage-1 secret must never appear, even alongside a judge finding.
      expect(result.blockedReason).not.toContain(secretFragment);
      // The judge's abstract reason is surfaced.
      expect(result.blockedReason).toContain(judgeReason);
      // Both rule names land in the structured rules list, order preserved.
      expect(result.blockedRules).toEqual(['secret-pattern', 'llm-judge-audience-leak']);
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

      // Two bus.publish calls: outbound.blocked + the principal.report digest item (#2159)
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

    it('queues a digest item, not an email, when the filter rejects', async () => {
      // Block notices are FYIs (#1051): since #2159 they go to the principal's digest
      // queue as principal.report items instead of a standalone email.
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

      // The second bus.publish call is the principal.report item
      const notificationEvent = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls[1][1] as BusEvent;
      expect(notificationEvent.type).toBe('principal.report');
      if (notificationEvent.type === 'principal.report') {
        expect(notificationEvent.payload.source).toBe('blocked_content');
        expect(notificationEvent.payload.urgency).toBe('digest');
        expect(notificationEvent.payload.summary).toMatch(/blocked/i);
      }
      const publishedTypes = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as BusEvent).type);
      expect(publishedTypes).not.toContain('outbound.notification');
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
      expect(notificationEvent.type).toBe('principal.report');
      if (notificationEvent.type === 'principal.report') {
        // Must NOT contain the blocked content
        expect(notificationEvent.payload.summary).not.toContain(sensitiveBody);
        // Must NOT contain the detailed rule finding (could include key value)
        expect(notificationEvent.payload.summary).not.toContain('sk-ant-abcdefghijklmnopqrst1234567890AB');
        // MUST contain a block ID so the principal can cross-reference with logs
        expect(notificationEvent.payload.summary).toMatch(/block_/);
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
      expect(notificationEvent.type).toBe('principal.report');
      if (notificationEvent.type === 'principal.report' && blockedEvent.type === 'outbound.blocked') {
        // The judge's abstract reason IS surfaced (gives the principal something to act on).
        expect(notificationEvent.payload.summary).toContain(judgeReason);
        // The item's own audit row carries the time; it is threaded to the block event.
        expect(notificationEvent.parentEventId).toBe(blockedEvent.id);
        // The audit event ID ties the item to the full audit record.
        expect(notificationEvent.payload.summary).toContain(blockedEvent.id);
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
      expect(notificationEvent.type).toBe('principal.report');
      if (notificationEvent.type === 'principal.report') {
        // The matched secret must never reach the digest item...
        expect(notificationEvent.payload.summary).not.toContain(secretFragment);
        // ...but the rule name is fine and tells the principal which class of rule fired.
        expect(notificationEvent.payload.summary).toContain('secret-pattern');
      }
    });

    it('fails closed when filter crashes — blocks send and queues a digest item', async () => {
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
      // The block is queued for the principal's digest (#2159)
      const publishCalls = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const notificationCalls = publishCalls.filter(
        (call: unknown[]) => (call[1] as BusEvent).type === 'principal.report',
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
        recipientTierUnresolved: false,
        principalDirected: false,
        recipients: [{ email: baseRequest.to, isPrincipal: false }],
        principalIncluded: false,
        principalIsSoleRecipient: false,
        gating: 'tier',
      });
    });

    it('forwards principalDirected to the content filter (#1870)', async () => {
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({ passed: true, findings: [] });
      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger: mocks.logger,
      });

      await gateway.send(baseRequest, { principalDirected: true });

      expect(mocks.contentFilter.check).toHaveBeenCalledWith(
        expect.objectContaining({ principalDirected: true }),
      );
    });

    it('flags recipientTierUnresolved when contact resolution throws, and still filters (#1870)', async () => {
      // The gateway fails open on the lookup error (the send proceeds) but tells the
      // filter the 'unknown' tier came from an outage, not a genuinely unknown recipient.
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
      (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({ passed: true, findings: [] });
      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger: mocks.logger,
      });

      await gateway.send(baseRequest);

      expect(mocks.contentFilter.check).toHaveBeenCalledWith(
        expect.objectContaining({ recipientTier: 'unknown', recipientTierUnresolved: true }),
      );
    });

    it('forwards recipientTier=trusted to contentFilter when contact has tier=trusted', async () => {
      // Verify that a resolved contact with tier='trusted' propagates to the
      // content filter. This is the policy boundary that allows trusted recipients
      // (CEO's EA, CFO, board members) to receive third-party contact data.
      (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
        contactId: 'contact-ea',
        displayName: "CEO's EA",
        role: null,
        tier: 'trusted',
        kind: 'person',
        kgNodeId: null,
        verified: true,
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
        recipientTierUnresolved: false,
        principalDirected: false,
        recipients: [{ email: baseRequest.to, isPrincipal: false }],
        principalIncluded: false,
        principalIsSoleRecipient: false,
        gating: 'tier',
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

  it('requireKnownEmailAccount names a missing mailbox without fetching (#1832)', () => {
    const getMessage = vi.fn();
    const { gateway } = makeGateway({
      nylasClients: new Map([['curia', { getMessage } as unknown as NylasClient]]),
    });

    expect(() => gateway.requireKnownEmailAccount('typo')).toThrow(/unknown account 'typo'/);
    expect(() => gateway.requireKnownEmailAccount('typo')).toThrow(/curia/);
    expect(() => gateway.requireKnownEmailAccount('curia')).not.toThrow();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it('requireKnownEmailAccount does nothing when no clients are configured (#1832)', () => {
    const { gateway } = makeGateway({ nylasClients: new Map() });

    expect(() => gateway.requireKnownEmailAccount('typo')).not.toThrow();
  });

  it('names an unknown account from getEmailMessage (#1832)', async () => {
    const { gateway } = makeGateway({
      nylasClients: new Map([['curia', { getMessage: vi.fn() } as unknown as NylasClient]]),
    });

    await expect(gateway.getEmailMessage('msg-1', 'typo')).rejects.toThrow(/unknown account 'typo'/);
    await expect(gateway.getEmailMessage('msg-1', 'typo')).rejects.toThrow(/curia/);
  });

  it('keeps the unconfigured error when getEmailMessage has no clients', async () => {
    const { gateway } = makeGateway({ nylasClients: new Map() });

    await expect(gateway.getEmailMessage('msg-1')).rejects.toThrow(/no nylasClient is configured/);
  });

  it('names an unknown account from listEmailMessages (#1957)', async () => {
    const listMessages = vi.fn();
    const { gateway } = makeGateway({
      nylasClients: new Map([['curia', { listMessages } as unknown as NylasClient]]),
    });

    await expect(gateway.listEmailMessages({ threadId: 't-1' }, 'typo')).rejects.toThrow(UnknownEmailAccountError);
    await expect(gateway.listEmailMessages({ threadId: 't-1' }, 'typo')).rejects.toThrow(/curia/);
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('keeps the unconfigured error when listEmailMessages has no clients', async () => {
    const { gateway } = makeGateway({ nylasClients: new Map() });

    await expect(gateway.listEmailMessages()).rejects.toThrow(/no nylasClient is configured/);
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
          tier: 'blocked',
          kind: 'person',
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
    isConnected: vi.fn().mockReturnValue(true),
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
      nylasClients: new Map([['test-account', nylasClient]]),
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

  it('promotes an unknown-tier contact to known after a successful send', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-1' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn()
        // First call: blocked-contact check (returns tier='unknown')
        .mockResolvedValueOnce({ contactId: 'contact-donna', tier: 'unknown', kind: 'person' })
        // Second call: promotion lookup (returns tier='unknown' again)
        .mockResolvedValueOnce({ contactId: 'contact-donna', tier: 'unknown', kind: 'person' }),
      // Post-#955: promotion goes through elevateTierToKnown (unknown→known), not setStatus.
      elevateTierToKnown: vi.fn().mockResolvedValue(true),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(contactService.elevateTierToKnown).toHaveBeenCalledOnce();
    expect(contactService.elevateTierToKnown).toHaveBeenCalledWith('contact-donna', 'correspondence');
    // trustLevel band-aid removed — confidence pipeline handles scoring now
    // (pipeline is optional and not provided in this test, so no scoring call fires)
  });

  it('creates a known-tier outbound_recipient contact when no record exists for the recipient', async () => {
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
    // Tier stays 'known' explicitly so replies are not held, and must not regress
    // to 'unknown' if the service default changes (#955, #2040). Provenance is
    // outbound_recipient, not ceo_stated: nobody confirmed the address (#2033).
    expect(contactService.createContact).toHaveBeenCalledWith(expect.objectContaining({
      tier: 'known',
      source: 'outbound_recipient',
    }));
    expect(contactService.linkIdentity).toHaveBeenCalledOnce();
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'new-contact-id',
      channel: 'email',
      channelIdentifier: 'donna@example.com',
      source: 'outbound_recipient',
    }));
    // No explicit verified flag: outbound_recipient is not an auto-verified source.
    expect((contactService.linkIdentity as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('verified');
    // trustLevel band-aid removed — confidence pipeline handles scoring now
    // (pipeline is optional and not provided in this test, so no scoring call fires)
  });

  it('records an email-reply recipient as email_participant when the caller says so (#2071)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-reply' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn().mockResolvedValue({ id: 'reply-contact-id' }),
      linkIdentity: vi.fn().mockResolvedValue(undefined),
      findLikelyDuplicates: vi.fn().mockResolvedValue({ taken: [], candidates: [] }),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(
      { ...baseRequest, replyToMessageId: 'msg-1', recipientSource: 'email_participant' },
      { recipientSource: 'email_participant', recipientDisplayName: 'Donna Paulsen' },
    );

    expect(result.success).toBe(true);
    // The option is explicit. replyToMessageId alone must not select the source:
    // email-send sets that field too. A value already on the request is ignored;
    // send() copies the option, which is what this call passes.
    expect(contactService.findLikelyDuplicates).toHaveBeenCalledWith({
      displayName: 'Donna Paulsen',
      identities: [{ channel: 'email', identifier: 'donna@example.com' }],
    });
    expect(contactService.createContact).toHaveBeenCalledWith(expect.objectContaining({
      tier: 'known',
      source: 'email_participant',
    }));
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      contactId: 'reply-contact-id',
      channel: 'email',
      channelIdentifier: 'donna@example.com',
      source: 'email_participant',
    }));
    // Auto-verify comes from the source, not an explicit verified flag.
    expect((contactService.linkIdentity as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty('verified');
    const sent = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('recipientSource');
    expect(sent).not.toHaveProperty('recipientDisplayName');
  });

  it('ignores recipientSource placed on the request instead of send options (#2071)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-reply' }),
    } as unknown as NylasClient;
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn().mockResolvedValue({ id: 'reply-contact-id' }),
      linkIdentity: vi.fn().mockResolvedValue(undefined),
      findLikelyDuplicates: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send({ ...baseRequest, recipientSource: 'email_participant' });

    expect(result.success).toBe(true);
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      source: 'outbound_recipient',
    }));
    expect(contactService.findLikelyDuplicates).not.toHaveBeenCalled();
  });

  it('records outbound_recipient when the reply duplicate check finds a candidate (#2071)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-reply' }),
    } as unknown as NylasClient;
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn().mockResolvedValue({ id: 'reply-contact-id' }),
      linkIdentity: vi.fn().mockResolvedValue(undefined),
      findLikelyDuplicates: vi.fn().mockResolvedValue({ taken: [], candidates: [{ contactId: 'other' }] }),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest, {
      recipientSource: 'email_participant',
      recipientDisplayName: 'Donna Paulsen',
    });

    expect(result.success).toBe(true);
    expect(contactService.createContact).toHaveBeenCalledWith(expect.objectContaining({
      source: 'outbound_recipient',
    }));
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      source: 'outbound_recipient',
    }));
  });

  it('records outbound_recipient when the reply duplicate check throws (#2071)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-reply' }),
    } as unknown as NylasClient;
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn().mockResolvedValue({ id: 'reply-contact-id' }),
      linkIdentity: vi.fn().mockResolvedValue(undefined),
      findLikelyDuplicates: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest, { recipientSource: 'email_participant' });

    expect(result.success).toBe(true);
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      source: 'outbound_recipient',
    }));
  });

  it('verifies an existing unverified outbound_recipient when the reply opts in (#2071)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-reply' }),
    } as unknown as NylasClient;
    const identity = {
      id: 'ident-1',
      contactId: 'contact-1',
      channel: 'email',
      channelIdentifier: 'donna@example.com',
      source: 'outbound_recipient',
      verified: false,
      status: 'active',
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-1',
        tier: 'known',
        kind: 'person',
      }),
      getIdentitiesForContact: vi.fn().mockResolvedValue([identity]),
      findLikelyDuplicates: vi.fn().mockResolvedValue({ taken: [], candidates: [] }),
      verifyIdentity: vi.fn().mockResolvedValue({ ...identity, verified: true }),
      elevateTierToKnown: vi.fn(),
      createContact: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest, { recipientSource: 'email_participant' });

    expect(result.success).toBe(true);
    expect(contactService.verifyIdentity).toHaveBeenCalledWith('ident-1');
    expect(contactService.findLikelyDuplicates).toHaveBeenCalledWith(expect.objectContaining({
      excludeContactId: 'contact-1',
    }));
    expect(contactService.createContact).not.toHaveBeenCalled();
  });

  it('does not verify an existing identity when the duplicate check finds a candidate (#2071)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-reply' }),
    } as unknown as NylasClient;
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-1',
        tier: 'known',
        kind: 'person',
      }),
      getIdentitiesForContact: vi.fn().mockResolvedValue([{
        id: 'ident-1',
        channel: 'email',
        channelIdentifier: 'donna@example.com',
        source: 'outbound_recipient',
        verified: false,
        status: 'active',
      }]),
      findLikelyDuplicates: vi.fn().mockResolvedValue({ taken: [], candidates: [{ contactId: 'other' }] }),
      verifyIdentity: vi.fn(),
      createContact: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest, { recipientSource: 'email_participant' });

    expect(result.success).toBe(true);
    expect(contactService.verifyIdentity).not.toHaveBeenCalled();
  });

  it('does not verify a self_claimed identity on an authenticated reply (#2071)', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-reply' }),
    } as unknown as NylasClient;
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-1',
        tier: 'known',
        kind: 'person',
      }),
      getIdentitiesForContact: vi.fn().mockResolvedValue([{
        id: 'ident-1',
        channel: 'email',
        channelIdentifier: 'donna@example.com',
        source: 'self_claimed',
        verified: false,
        status: 'active',
      }]),
      findLikelyDuplicates: vi.fn(),
      verifyIdentity: vi.fn(),
      createContact: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    await gateway.send(baseRequest, { recipientSource: 'email_participant' });

    expect(contactService.verifyIdentity).not.toHaveBeenCalled();
    expect(contactService.findLikelyDuplicates).not.toHaveBeenCalled();
  });

  it('ignores recipientSource on a non-email send (#2071)', async () => {
    const signalClient = {
      send: vi.fn().mockResolvedValue('ts-1'),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      createContact: vi.fn().mockResolvedValue({ id: 'sms-contact' }),
      linkIdentity: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactService;
    const contentFilter = { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as unknown as OutboundContentFilter;
    const bus = { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as unknown as EventBus;
    const gateway = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService,
      contentFilter,
      bus,
      logger: createLogger('error'),
    });

    const result = await gateway.send(
      { channel: 'signal', recipient: '+15555550100', message: 'hi' },
      { recipientSource: 'email_participant' },
    );

    expect(result.success).toBe(true);
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      source: 'outbound_recipient',
      channel: 'signal',
    }));
  });

  it('does not promote a contact that is already at tier="known"', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-3' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-confirmed',
        tier: 'known',       // issue #945
        kind: 'person',
      }),
      elevateTierToKnown: vi.fn(),
      createContact: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(true);
    expect(contactService.elevateTierToKnown).not.toHaveBeenCalled();
    expect(contactService.createContact).not.toHaveBeenCalled();
  });

  it('fires confidencePipeline message_sent for an already-confirmed contact', async () => {
    const nylasClient = {
      sendMessage: vi.fn().mockResolvedValue({ id: 'sent-4' }),
    } as unknown as NylasClient;

    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: 'contact-donna',
        tier: 'known',
        kind: 'person',
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
      elevateTierToKnown: vi.fn(),
    } as unknown as ContactService;

    const gateway = makeGateway(contactService, nylasClient);
    const result = await gateway.send(baseRequest);

    expect(result.success).toBe(false);
    expect(contactService.createContact).not.toHaveBeenCalled();
    expect(contactService.elevateTierToKnown).not.toHaveBeenCalled();
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
    // The send options carry no generated IDs (#2548), so the plain prefix check is not flaky.
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
      tier: 'principal',
      kind: 'principal',
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

  describe('reports applied redactions on the send result (#2312)', () => {
    const phone = { patternLabel: 'phone_us', channelId: 'email', replacedWith: '[REDACTED: PHONE_US]' };

    it('reports the body label and the delivered body', async () => {
      const piiRedactor = makePiiRedactor(async (content) => (
        content === piiRequest.body
          ? { content: 'call [REDACTED: PHONE_US]', redactions: [phone] }
          : { content, redactions: [] }
      ));
      const { gateway } = makeGateway(piiRedactor);
      const result = await gateway.send(piiRequest);

      expect(result.success).toBe(true);
      expect(result.redactions).toEqual([{ label: 'phone_us', field: 'body' }]);
      expect(result.sentContent).toBe('call [REDACTED: PHONE_US]');
    });

    it('reports body and subject redactions separately', async () => {
      const piiRedactor = makePiiRedactor(async (content) => ({
        content: `${content} [REDACTED: PHONE_US]`,
        redactions: [phone],
      }));
      const { gateway } = makeGateway(piiRedactor);
      const result = await gateway.send(piiRequest);

      expect(result.redactions).toEqual([
        { label: 'phone_us', field: 'body' },
        { label: 'phone_us', field: 'subject' },
      ]);
      expect(result.sentSubject).toBe(`${piiRequest.subject} [REDACTED: PHONE_US]`);
    });

    it('leaves both fields undefined when nothing was redacted', async () => {
      const piiRedactor = makePiiRedactor(async (content) => ({ content, redactions: [] }));
      const { gateway } = makeGateway(piiRedactor);
      const result = await gateway.send(piiRequest);

      expect(result.success).toBe(true);
      expect(result.redactions).toBeUndefined();
      expect(result.sentContent).toBeUndefined();
      expect(result.sentSubject).toBeUndefined();
    });

    it('reports redactions on a queued send', async () => {
      const piiRedactor = makePiiRedactor(async (content) => ({
        content: 'call [REDACTED: PHONE_US]',
        redactions: content === piiRequest.body ? [phone] : [],
      }));
      const enqueue = vi.fn().mockResolvedValue({ id: 'q-1' });
      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', { sendMessage: vi.fn() } as unknown as NylasClient]]),
        contactService: { resolveByChannelIdentity: vi.fn().mockResolvedValue(null) } as unknown as ContactService,
        contentFilter: { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as unknown as OutboundContentFilter,
        bus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as unknown as EventBus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger: createLogger('error'),
        piiRedactor,
        outboundQueue: { enqueue } as unknown as OutboundQueueRepo,
        outboundQueueReadiness: new Map([['email', () => false]]),
      });
      const result = await gateway.send(piiRequest);

      expect(result.queued).toBe(true);
      expect(result.redactions).toEqual([{ label: 'phone_us', field: 'body' }]);
      expect(result.sentContent).toBe('call [REDACTED: PHONE_US]');
    });
  });

  describe('principal bypass keys on the sole-recipient set (#2312)', () => {
    const phoneBody = 'Call me on (415) 555-1234 tomorrow.';

    async function makeRealGateway(identities: ReturnType<typeof makePrincipalIdentity>[]) {
      const { PiiRedactor: RealPiiRedactor } = await import('../../../src/dispatch/pii-redactor.js');
      const logger = createLogger('error');
      const bus = {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
      } as unknown as EventBus;
      const nylasClient = {
        sendMessage: vi.fn().mockResolvedValue({ id: 'msg-pii-2' }),
      } as unknown as NylasClient;
      const signalClient = makeSignalClient();
      const contactService = {
        resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      } as unknown as ContactService;
      const contentFilter = {
        check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
      } as unknown as OutboundContentFilter;
      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', nylasClient]]),
        signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
        signalPhoneNumber: '+15555550000',
        contactService,
        contentFilter,
        bus,
        principalIdentities: identities,
        logger,
        piiRedactor: new RealPiiRedactor({
          config: {
            enabled: true,
            default: 'block',
            channel_policies: { email: { allow: ['email'] }, signal: { allow: [] } },
          },
          bus,
          logger,
          extraPatterns: [],
        }),
      });
      return { gateway, nylasClient, signalClient };
    }

    it('delivers the body intact when the email goes to the principal only', async () => {
      const { gateway, nylasClient } = await makeRealGateway([makePrincipalIdentity('ceo@example.com')]);
      const result = await gateway.send({ channel: 'email', to: 'ceo@example.com', subject: 's', body: phoneBody });
      expect(result.success).toBe(true);
      const sent = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
      expect(sent.body).toContain('(415) 555-1234');
    });

    it('redacts when a third party is CC\'d alongside the principal', async () => {
      const { gateway, nylasClient } = await makeRealGateway([makePrincipalIdentity('ceo@example.com')]);
      const result = await gateway.send({
        channel: 'email',
        to: 'ceo@example.com',
        cc: ['third@example.com'],
        subject: 's',
        body: phoneBody,
      });
      expect(result.success).toBe(true);
      const sent = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
      expect(sent.body).toContain('[REDACTED: PHONE_US]');
      expect(sent.body).not.toContain('555-1234');
    });

    it('delivers intact when every recipient is one of the principal\'s own addresses', async () => {
      const { gateway, nylasClient } = await makeRealGateway([
        makePrincipalIdentity('ceo@example.com'),
        makePrincipalIdentity('ceo@home.example'),
      ]);
      const result = await gateway.send({
        channel: 'email',
        to: 'ceo@example.com',
        cc: ['ceo@home.example'],
        subject: 's',
        body: phoneBody,
      });
      expect(result.success).toBe(true);
      const sent = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
      expect(sent.body).toContain('(415) 555-1234');
    });

    it('delivers a Signal 1:1 to the principal intact', async () => {
      const { gateway, signalClient } = await makeRealGateway([makePrincipalIdentity('+15555551111', 'signal')]);
      const result = await gateway.send({ channel: 'signal', recipient: '+15555551111', message: phoneBody });
      expect(result.success).toBe(true);
      expect(JSON.stringify(signalClient.send.mock.calls)).toContain('(415) 555-1234');
    });
  });

  describe('Curia\'s own addresses are not recipients (#2312)', () => {
    const phoneBody = 'Call me on (415) 555-1234 tomorrow.';

    async function makeOwnAddressGateway() {
      const { PiiRedactor: RealPiiRedactor } = await import('../../../src/dispatch/pii-redactor.js');
      const logger = createLogger('error');
      const bus = {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
      } as unknown as EventBus;
      const nylasClient = {
        sendMessage: vi.fn().mockResolvedValue({ id: 'msg-own-1' }),
      } as unknown as NylasClient;
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', nylasClient]]),
        emailAccountAddresses: new Map([['curia', 'curia@example.com']]),
        contactService: {
          resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
        } as unknown as ContactService,
        contentFilter: {
          check: vi.fn().mockResolvedValue({ passed: true, findings: [] }),
        } as unknown as OutboundContentFilter,
        bus,
        principalIdentities: [makePrincipalIdentity('ceo@example.com')],
        logger,
        autonomyService: makeAutonomyService(84),
        actionLogRepo: makeActionLogRepo(),
        gating: 'band',
        bandReview: { review: review as unknown as BandSendReview['review'] },
        piiRedactor: new RealPiiRedactor({
          config: {
            enabled: true,
            default: 'block',
            channel_policies: { email: { allow: ['email'] }, signal: { allow: [] } },
          },
          bus,
          logger,
          extraPatterns: [],
        }),
      });
      return { gateway, nylasClient, review };
    }

    it.each(['curia@example.com', 'Curia@Example.com'])(
      'treats a send to %s with the principal CC\'d as principal-only',
      async (to) => {
        const { gateway, nylasClient, review } = await makeOwnAddressGateway();
        const result = await gateway.send({
          channel: 'email', to, cc: ['ceo@example.com'], subject: 's', body: phoneBody,
        });
        expect(result.success).toBe(true);
        expect(review).not.toHaveBeenCalled();
        const sent = (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
        expect(sent.body).toContain('(415) 555-1234');
      },
    );

    it('keeps Curia\'s address out of the band review recipients', async () => {
      const { gateway, review } = await makeOwnAddressGateway();
      await gateway.send({
        channel: 'email', to: 'third@example.com', cc: ['curia@example.com'], subject: 's', body: 'Hello there.',
      });
      expect(review).toHaveBeenCalledTimes(1);
      const arg = review.mock.calls[0]![0] as { recipients: string[] };
      expect(arg.recipients).toEqual(['third@example.com']);
    });

    it('does not treat a send to Curia alone as principal-only', async () => {
      const { gateway, review } = await makeOwnAddressGateway();
      await gateway.send({
        channel: 'email', to: 'curia@example.com', subject: 's', body: 'Hello there.',
      });
      expect(review).toHaveBeenCalledTimes(1);
    });
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
      // principalIdentities enables the CEO email bypass check in isPrincipalIdentity()
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
          tier: 'blocked',
          kind: 'person',
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
    // #1158: the draft block path now mirrors send() — it returns the principal-safe
    // reason summary and the rule name(s) so the agent's tool loop can self-correct
    // and retry. For a Stage-1 deterministic rule, the summary is the rule name only.
    expect(reasonBeforeRecipientNote(result.blockedReason)).toBe('secret-pattern');
    expect(result.blockedRules).toEqual(['secret-pattern']);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it('queues a blocked draft for the digest instead of emailing the principal (#2159)', async () => {
    const { gateway, contentFilter, bus } = makeGateway();
    (contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'secret-pattern', detail: 'Key detected: sk-ant-secretsecret' }],
    });

    await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    const events = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as BusEvent);
    expect(events.map((e) => e.type)).not.toContain('outbound.notification');
    const report = events.find((e) => e.type === 'principal.report');
    expect(report).toBeDefined();
    if (report?.type === 'principal.report') {
      expect(report.payload.source).toBe('blocked_content');
      expect(report.payload.summary).toContain(DRAFT_ID);
      expect(report.payload.summary).toContain('secret-pattern');
      // A Stage-1 detail can embed the matched fragment; it never reaches the digest.
      expect(report.payload.summary).not.toContain('sk-ant-secretsecret');
    }
  });

  it('still blocks the draft when queueing the notice fails', async () => {
    const { gateway, contentFilter, bus } = makeGateway();
    (contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'secret-pattern', detail: 'Key detected' }],
    });
    (bus.publish as ReturnType<typeof vi.fn>).mockImplementation(async (_layer: string, event: BusEvent) => {
      if (event.type === 'principal.report') throw new Error('bus down');
    });

    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
  });

  it('returns the judge\'s abstract reason and rule name on a draft LLM-judge block (#1158)', async () => {
    // Mirror of the send() LLM-judge test: a Stage-2 judge block on the draft path
    // must surface the judge's abstract reason (safe — it never quotes the offending
    // value) plus the rule name, giving the agent enough signal to rewrite and retry.
    const judgeReason = 'internal fallback reasoning leaked into the reply body';
    const { gateway, nylasClient, contentFilter } = makeGateway();
    (contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'llm-judge-audience-leak', detail: judgeReason }],
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain(judgeReason);
    expect(result.blockedReason).toContain('llm-judge-audience-leak');
    expect(result.blockedRules).toEqual(['llm-judge-audience-leak']);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it('never leaks a Stage-1 deterministic finding\'s detail into the draft block result (#1158)', async () => {
    // #1158 safety contract: the draft block result is LLM-facing, so it must obey
    // the same per-rule policy as send() — a deterministic rule's detail can embed
    // the matched secret, so only its rule NAME may appear in the result.
    const secretFragment = 'sk-ant-zzzzzzzzzzzzzzzzzzzz0987654321ZZ';
    const { gateway, nylasClient, contentFilter } = makeGateway();
    (contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [{ rule: 'secret-pattern', detail: `API key: ${secretFragment}` }],
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
    // The matched secret must never reach the LLM-facing result...
    expect(result.blockedReason).not.toContain(secretFragment);
    // ...but the rule name is safe and tells the agent which class of rule fired.
    expect(reasonBeforeRecipientNote(result.blockedReason)).toBe('secret-pattern');
    expect(result.blockedRules).toEqual(['secret-pattern']);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it('with mixed findings on a draft block, surfaces only the judge detail but all rule names (#1158)', async () => {
    // When a draft trips both a Stage-1 deterministic rule (whose detail embeds a
    // secret) and a Stage-2 judge rule (abstract detail), the LLM-facing reason must
    // surface ONLY the judge's detail, while blockedRules lists every rule, in order.
    const secretFragment = 'sk-ant-yyyyyyyyyyyyyyyyyyyy1122334455YY';
    const judgeReason = 'reply mixes confidential and external content';
    const { gateway, nylasClient, contentFilter } = makeGateway();
    (contentFilter.check as ReturnType<typeof vi.fn>).mockResolvedValue({
      passed: false,
      findings: [
        { rule: 'secret-pattern', detail: `API key: ${secretFragment}` },
        { rule: 'llm-judge-audience-leak', detail: judgeReason },
      ],
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);

    expect(result.success).toBe(false);
    expect(result.blockedReason).not.toContain(secretFragment);
    expect(result.blockedReason).toContain(judgeReason);
    expect(result.blockedRules).toEqual(['secret-pattern', 'llm-judge-audience-leak']);
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

  it('keeps the autonomy gate when the draft goes to the CEO and anyone else (#2273)', async () => {
    const { gateway, nylasClient } = makeGateway({
      autonomyService: makeAutonomyService(65),
    });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', {
      recipientEmail: 'ceo@example.com',
      body: 'Hi all',
      subject: 'Update',
      allRecipients: ['ceo@example.com', 'armin@external.com'],
    });

    expect(result.success).toBe(false);
    expect(result.blockedReason).toMatch(/autonomy/i);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
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

  it('does not send a draft edited after it was checked (#2312)', async () => {
    const getDraft = vi.fn().mockResolvedValue(storedDraft({ ...DRAFT_META, body: '<p>Hello, my SIN is 130 692 544</p>' }));
    const { gateway, nylasClient } = makeGateway({ nylasClient: { getDraft } });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);
    expect(result).toMatchObject({ success: false, blockedReason: expect.stringContaining('The draft changed while it was being checked') });
    expect(getDraft).toHaveBeenCalledWith(DRAFT_ID);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['a new recipient', { allRecipients: ['partner@example.com', 'other@example.com'] }],
    ['a draft that is gone', null],
  ])('does not send a draft with %s since it was checked (#2312)', async (_label, change) => {
    const getDraft = vi.fn().mockResolvedValue(change === null ? null : storedDraft({ ...DRAFT_META, ...change }));
    const { gateway, nylasClient } = makeGateway({ nylasClient: { getDraft } });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);
    expect(result.success).toBe(false);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
  });

  it('does not send a draft when the re-read fails (fail-closed, #2312)', async () => {
    const getDraft = vi.fn().mockRejectedValue(new Error('Nylas down'));
    const { gateway, nylasClient } = makeGateway({ nylasClient: { getDraft } });
    const result = await gateway.sendEmailDraft(DRAFT_ID, 'joseph', DRAFT_META);
    expect(result.success).toBe(false);
    expect(nylasClient.sendDraft).not.toHaveBeenCalled();
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
        tier: 'known',
        kind: 'person',
        kgNodeId: null,
        verified: true,
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
    // The blocked result now surfaces the rule name as the reason (#1051).
    expect(reasonBeforeRecipientNote(result.blockedReason)).toBe('test-rule');
    expect(result.blockedRules).toEqual(['test-rule']);
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
    bindDeliveryMessage: vi.fn().mockResolvedValue(true),
    findPendingByDeliveryMessage: vi.fn().mockResolvedValue(null),
    findPendingByShortRef: vi.fn().mockResolvedValue(null),
    insertSampled: vi.fn().mockResolvedValue(1),
    findApprovalNumber: vi.fn().mockResolvedValue(null),
  } as unknown as ActionLogRepo;
}

/** An action log whose pending insert returns row 7, numbered `n` (#2159 Phase 3). */
function makeNumberedActionLogRepo(n: number) {
  const repo = makeActionLogRepo();
  vi.mocked(repo.insert).mockResolvedValue(7);
  vi.mocked(repo.findApprovalNumber).mockResolvedValue(n);
  return repo;
}

describe('gated draft-fallback (two-step pattern)', () => {
  // Standard re-execution recipe the email adapter would pass to gateway.send().
  // Tests that exercise the pending_approval write path must include this to opt in.
  const TEST_RECIPE = {
    toolName: 'send-draft',
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

  it('writes action_log row using recipe toolName, payload, and description', async () => {
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
      toolName: 'send-draft',
      partialPayload: { account: 'joseph' },
      description: 'Draft reply to partner@example.com — "Project update". Use send-draft to approve.',
    };

    await gateway.send(
      { channel: 'email', to: 'partner@example.com', subject: 'Project update', body: 'Content' },
      { taskEventId: 'task-789', reExecRecipe: recipe },
    );

    expect(actionLogRepo.insert).toHaveBeenCalledOnce();
    const insertArg = (actionLogRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertArg.toolName).toBe('send-draft');
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

  // #2159: the gate writes the row and notifies no one; the agent delivers it on one channel.
  it('queues one digest mention, sends no notification, and tells the agent to deliver it', async () => {
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

    const events = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as BusEvent);
    expect(events.map((e) => e.type)).not.toContain('outbound.notification');
    const reports = events.filter((e) => e.type === 'principal.report');
    expect(reports).toHaveLength(1);
    if (reports[0]?.type === 'principal.report') {
      expect(reports[0].payload).toMatchObject({ source: 'approval_pending', actionShortRef: result.actionRef, conversationId: 'conv-456' });
    }
    expect(result.blockedReason).toContain('deliver-approval');
    expect(result.blockedReason).toContain(`ref: ${result.actionRef}`);
    expect(actionLogRepo.setNotificationSentAt).not.toHaveBeenCalled();
  });

  it('wakes the coordinator to deliver an approval held after the turn ended (relayed reply)', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo: makeActionLogRepo(),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE, postTurn: true },
    );

    const events = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as BusEvent);
    const wakes = events.filter((e) => e.type === 'agent.task');
    expect(wakes).toHaveLength(1);
    if (wakes[0]?.type === 'agent.task') {
      expect(wakes[0].payload).toMatchObject({ agentId: 'coordinator', conversationId: `approval-delivery:${result.actionRef}` });
      expect(wakes[0].payload.syntheticTurn).toBe(true);
      expect(wakes[0].payload.content).toContain('deliver-approval');
      expect(wakes[0].parentEventId).toBe('task-123');
    }
  });

  it('does not wake anyone for a send made inside an agent turn', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo: makeActionLogRepo(),
    });

    await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    const events = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as BusEvent);
    expect(events.some((e) => e.type === 'agent.task')).toBe(false);
  });

  it('registers what the principal is shown with approval delivery', async () => {
    const mocks = createMocks();
    const registerDisplay = vi.fn();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo: makeActionLogRepo(),
    });
    gateway.setApprovalDelivery({ registerDisplay } as never);

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    expect(registerDisplay).toHaveBeenCalledWith(result.actionRef, expect.objectContaining({
      preamble: TEST_RECIPE.description,
      payload: expect.objectContaining({ to: 'recipient@example.com', subject: 'Hello' }),
    }));
  });

  // #2159 Phase 3: the principal answers by number. The gate reads it back by row id, shows
  // it, and tells the agent; the ref stays, since deliver-approval is keyed on it.
  it('registers and quotes the approval number read back after the insert', async () => {
    const mocks = createMocks();
    const registerDisplay = vi.fn();
    const actionLogRepo = makeNumberedActionLogRepo(3);
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
    gateway.setApprovalDelivery({ registerDisplay } as never);

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    expect(actionLogRepo.findApprovalNumber).toHaveBeenCalledWith(7);
    expect(registerDisplay).toHaveBeenCalledWith(result.actionRef, expect.objectContaining({ approvalNumber: 3 }));
    expect(result.actionRef).toMatch(/^[0-9a-f]{8}$/);
    expect(result.blockedReason).toContain('approval 3');
    expect(result.blockedReason).toContain(`ref: ${result.actionRef}`);
  });

  it('keeps the held send gated, unnumbered, when the number cannot be read back', async () => {
    const mocks = createMocks();
    const registerDisplay = vi.fn();
    const actionLogRepo = makeActionLogRepo();
    vi.mocked(actionLogRepo.findApprovalNumber).mockRejectedValue(new Error('db blip'));
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
    gateway.setApprovalDelivery({ registerDisplay } as never);

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(registerDisplay).toHaveBeenCalledWith(result.actionRef, expect.objectContaining({ approvalNumber: null }));
    expect(result.blockedReason).not.toMatch(/approval \d/);
  });

  it('numbers an export-gate approval the same way', async () => {
    const mocks = createMocks();
    const registerDisplay = vi.fn();
    const actionLogRepo = makeNumberedActionLogRepo(6);
    const exportControlService = {
      evaluateGatewayAttachments: vi.fn().mockResolvedValue({
        outcome: { action: 'approval_required', code: 'bulk_export', message: 'This export needs the principal\'s approval.' },
        items: [{ label: 'board.pdf', sensitivity: 'confidential' }],
      }),
    };
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      actionLogRepo,
      exportControlService: exportControlService as never,
    });
    gateway.setApprovalDelivery({ registerDisplay } as never);

    const result = await gateway.send(
      {
        channel: 'email', to: 'recipient@example.com', subject: 'Board pack', body: 'Attached.',
        attachments: [{ fileUrl: 'file:///tmp/board.pdf', filename: 'board.pdf', contentType: 'application/pdf' }],
      },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(actionLogRepo.findApprovalNumber).toHaveBeenCalledWith(7);
    expect(registerDisplay).toHaveBeenCalledWith(result.actionRef, expect.objectContaining({ approvalNumber: 6 }));
    expect(result.blockedReason).toContain('approval 6');
    expect(result.blockedReason).toContain(`ref: ${result.actionRef}`);
  });

  it('still returns the gated result when the digest mention fails to queue', async () => {
    const mocks = createMocks();
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Bus error'));

    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(65),
      actionLogRepo: makeActionLogRepo(),
    });

    const result = await gateway.send(
      { channel: 'email', to: 'recipient@example.com', subject: 'Hello', body: 'Hi!' },
      { taskEventId: 'task-123', reExecRecipe: TEST_RECIPE },
    );

    expect(result.success).toBe(false);
    expect(result.gated).toBe(true);
    expect(result.actionRef).toMatch(/^[0-9a-f]{8}$/);
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
    // The blocked result now surfaces the rule name as the reason (#1051).
    expect(reasonBeforeRecipientNote(result.blockedReason)).toBe('test-rule');
    expect(result.blockedRules).toEqual(['test-rule']);
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CEO recipient bypass on send() — agent-to-principal communication bypasses
// the autonomy gate. All other safety checks (blocked-contact, content filter)
// still run. See OutboundGateway.isPrincipalRecipient() for the carve-out, and
// docs/adr/035-channel-owned-outbound-recipient-projection.md for how recipients
// are projected per channel.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// outbound.delivered for Signal 1:1 sends — Task 4
// ---------------------------------------------------------------------------

describe('outbound.delivered on Signal send', () => {
  it('publishes outbound.delivered on a successful 1:1 Signal send', async () => {
    const mocks = createMocks();

    const signalClient = {
      send: vi.fn().mockResolvedValue('1700000000123'),
      listGroups: vi.fn().mockResolvedValue([]),
      isConnected: vi.fn().mockReturnValue(true),
    } as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient;

    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      contactId: 'contact-signal-1',
      displayName: 'Phone Friend',
      role: null,
      tier: 'known',
      kind: 'person',
      kgNodeId: null,
      verified: true,
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
    expect(result.messageId).toBe('1700000000123');

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
      messageId: '1700000000123',
    });
  });

  it('publishes outbound.delivered on a successful Signal group send', async () => {
    const mocks = createMocks();

    const signalClient = {
      send: vi.fn().mockResolvedValue('1700000000456'),
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
      isConnected: vi.fn().mockReturnValue(true),
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
    expect(result.messageId).toBe('1700000000456');

    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[1] as BusEvent)
      .find((evt) => evt.type === 'outbound.delivered');

    expect(delivered, 'expected outbound.delivered for Signal group send').toBeDefined();
    expect(delivered!.payload).toMatchObject({
      channel: 'signal',
      recipientId: 'group-base64==',
      content: 'group ping',
      conversationId: 'signal:group=group-base64==',
      messageId: '1700000000456',
    });
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
      .map(([, evt]) => (evt as BusEvent).type);
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
      isConnected: vi.fn().mockReturnValue(true),
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
    // The blocked result now surfaces the rule name as the reason (#1051).
    expect(reasonBeforeRecipientNote(result.blockedReason)).toBe('test-rule');
    expect(result.blockedRules).toEqual(['test-rule']);
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

describe('hasTransientErrorSignal (#1380)', () => {
  it('flags HTTP 408/429/5xx via statusCode or status', () => {
    expect(hasTransientErrorSignal({ statusCode: 429 })).toBe(true);
    expect(hasTransientErrorSignal({ statusCode: 408 })).toBe(true);
    expect(hasTransientErrorSignal({ statusCode: 503 })).toBe(true);
    expect(hasTransientErrorSignal({ status: 502 })).toBe(true);
  });

  it('flags Node network-error codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      expect(hasTransientErrorSignal(Object.assign(new Error('boom'), { code }))).toBe(true);
    }
  });

  it('does NOT flag auth/validation 4xx or unknown shapes', () => {
    expect(hasTransientErrorSignal({ statusCode: 401 })).toBe(false);
    expect(hasTransientErrorSignal({ statusCode: 403 })).toBe(false);
    expect(hasTransientErrorSignal({ statusCode: 422 })).toBe(false);
    expect(hasTransientErrorSignal(new Error('just a message'))).toBe(false);
    expect(hasTransientErrorSignal({ code: 40300 })).toBe(false); // Telnyx numeric code, not a Node code
    expect(hasTransientErrorSignal(null)).toBe(false);
    expect(hasTransientErrorSignal('a string')).toBe(false);
  });
});

// Prompt trim PR 6: the principal's mailbox is told apart from the assistant's own, and
// the configured signature is added to the emails the assistant writes.
describe('OutboundGateway — principal mailbox and email signature', () => {
  const PERSONA = { displayName: 'Alex Curia', title: 'Digital EA', emailSignature: '--\nAlex Curia\nDigital EA' };

  function makeGateway(opts: { persona?: typeof PERSONA; accounts?: Array<[string, string]> } = {}) {
    const mocks = createMocks();
    const nylasClient = {
      ...(mocks.nylasClient as unknown as Record<string, unknown>),
      createDraft: vi.fn().mockResolvedValue({ id: 'draft-1' }),
    } as unknown as NylasClient;
    const accounts = opts.accounts ?? [['curia', 'assistant@example.com'], ['joseph', 'ceo@example.com']];
    const gateway = new OutboundGateway({
      nylasClients: new Map(accounts.map(([name]) => [name, nylasClient])),
      emailAccountAddresses: new Map(accounts),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('CEO@example.com')],
      logger: mocks.logger,
      ...(opts.persona ? { agentPersona: opts.persona } : {}),
    });
    const sentHtml = () => (nylasClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0].body as string;
    const draftHtml = () => (nylasClient.createDraft as ReturnType<typeof vi.fn>).mock.calls[0]![0].body as string;
    return { gateway, mocks, sentHtml, draftHtml };
  }

  const email = (overrides: Record<string, unknown> = {}) => ({
    channel: 'email' as const, to: 'priya@example.com', subject: 'Call', body: 'Tuesday at 10 works.', ...overrides,
  });

  it('isPrincipalMailbox matches a mailbox whose address is a principal identity', () => {
    const { gateway } = makeGateway();
    expect(gateway.isPrincipalMailbox('joseph')).toBe(true);
    expect(gateway.isPrincipalMailbox('curia')).toBe(false);
    // Omitted: the primary (first) account.
    expect(gateway.isPrincipalMailbox()).toBe(false);
    expect(gateway.isPrincipalMailbox('unknown')).toBe(false);
  });

  it('isPrincipalMailbox reads a blank account as the primary, as sends do', () => {
    const { gateway } = makeGateway({ accounts: [['joseph', 'ceo@example.com'], ['curia', 'assistant@example.com']] });
    expect(gateway.isPrincipalMailbox('')).toBe(true);
    expect(gateway.isPrincipalMailbox(undefined)).toBe(true);
  });

  it('isPrincipalMailbox is false when no addresses are configured', () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['joseph', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('ceo@example.com')],
      logger: mocks.logger,
    });
    expect(gateway.isPrincipalMailbox('joseph')).toBe(false);
  });

  it('signs a sent email after the body, as plain escaped text, and before the quote', async () => {
    const { gateway, mocks, sentHtml } = makeGateway({
      persona: { ...PERSONA, emailSignature: 'Alex <Curia>\n*Digital EA*' },
    });
    const result = await gateway.send(email({ htmlQuote: '<blockquote>earlier</blockquote>' }));
    expect(result.success).toBe(true);
    const html = sentHtml();
    expect(html).toContain('Alex &lt;Curia&gt;<br>\n*Digital EA*');
    expect(html.indexOf('Tuesday at 10')).toBeLessThan(html.indexOf('Alex &lt;Curia&gt;'));
    expect(html.indexOf('Alex &lt;Curia&gt;')).toBeLessThan(html.indexOf('<blockquote>earlier'));
    // The filter checks only what the agent wrote.
    const checked = (mocks.contentFilter.check as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { content: string };
    expect(checked.content).toBe('Tuesday at 10 works.');
  });

  it('builds the signature from name and title when none is set', async () => {
    const { gateway, sentHtml } = makeGateway({ persona: { ...PERSONA, emailSignature: '' } });
    await gateway.send(email());
    expect(sentHtml()).toContain('<p>Alex Curia<br>\nDigital EA</p>');
  });

  it('signs a draft', async () => {
    const { gateway, draftHtml } = makeGateway({ persona: PERSONA });
    const result = await gateway.createEmailDraft(email({ accountId: 'curia' }));
    expect(result.success).toBe(true);
    expect(draftHtml()).toContain('Alex Curia<br>\nDigital EA');
  });

  // #2554: code owns the signature block. The model may write a closing and first name but
  // no signature block, and the gateway never edits the body it wrote: a sign-off the model
  // wrote goes out as written, with the configured signature below it.
  const SIGNATURE_HTML = '--<br>\nAlex Curia<br>\nDigital EA';
  const deliveredContent = (mocks: ReturnType<typeof createMocks>) => (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
    .map(call => call[1] as { type: string; payload: { content?: string } })
    .find(event => event.type === 'outbound.delivered')?.payload.content;

  it('sends a model-written name/title block intact, followed by the signature', async () => {
    const { gateway, mocks, sentHtml } = makeGateway({ persona: PERSONA });
    const body = 'Tuesday at 10 works.\n\nBest,\nAlex Curia\nDigital EA to Joseph';
    await gateway.send(email({ body }));
    const html = sentHtml();
    expect(html).toContain('Digital EA to Joseph');
    expect(html.indexOf('Digital EA to Joseph')).toBeLessThan(html.indexOf(SIGNATURE_HTML));
    expect(deliveredContent(mocks)).toBe(body);
  });

  // The closing is the model's choice; the gateway treats every one alike.
  it.each(['Cheers,', 'Thanks,', 'Warmly,'])('sends a %s + first-name sign-off intact above the signature', async (closing) => {
    const { gateway, mocks, sentHtml } = makeGateway({ persona: PERSONA });
    const body = `Tuesday at 10 works.\n\n${closing}\nAlex`;
    await gateway.send(email({ body }));
    expect(sentHtml().indexOf(closing)).toBeLessThan(sentHtml().indexOf(SIGNATURE_HTML));
    expect(deliveredContent(mocks)).toBe(body);
  });

  it('keeps a model-written sign-off in a draft, followed by the signature', async () => {
    const { gateway, draftHtml } = makeGateway({ persona: PERSONA });
    await gateway.createEmailDraft(email({ accountId: 'curia', body: 'Tuesday at 10 works.\n\nAlex\nDigital EA' }));
    expect(draftHtml()).toContain(SIGNATURE_HTML);
    // The model's "Alex" plus the signature's "Alex Curia": nothing was cut.
    expect(draftHtml().match(/Alex/g)).toHaveLength(2);
  });

  it('does not sign twice when the body already ends with the exact signature', async () => {
    const { gateway, mocks, sentHtml } = makeGateway({ persona: PERSONA });
    const body = 'Tuesday at 10 works.\n\n--\nAlex Curia\nDigital EA';
    await gateway.send(email({ body }));
    expect(sentHtml().match(/Alex Curia/g)).toHaveLength(1);
    expect(deliveredContent(mocks)).toBe(body);
  });

  it('keeps the model\'s sign-off where the gateway does not sign', async () => {
    const { gateway, draftHtml } = makeGateway({ persona: PERSONA });
    await gateway.createEmailDraft(email({ accountId: 'joseph', body: 'Tuesday at 10 works.\n\nAlex Curia' }));
    expect(draftHtml()).toContain('Alex Curia');
  });

  it('does not sign system notifications', async () => {
    const { gateway, sentHtml } = makeGateway({ persona: PERSONA });
    await gateway.send(email({ to: 'ceo@example.com' }), { isSystemNotification: true });
    expect(sentHtml()).not.toContain('Digital EA');
  });

  it('does not sign as the assistant from the principal\'s mailbox', async () => {
    const { gateway, draftHtml } = makeGateway({ persona: PERSONA });
    await gateway.createEmailDraft(email({ accountId: 'joseph' }));
    expect(draftHtml()).not.toContain('Digital EA');
  });

  // #2474: a send through the principal's own mailbox would be a second outbound surface
  // beside the ceo-inbox send path, so the gateway refuses it before any other check.
  it('send() refuses an email whose account is the principal\'s mailbox', async () => {
    const { gateway, mocks } = makeGateway({ persona: PERSONA });
    const result = await gateway.send(email({ accountId: 'joseph' }));
    expect(result).toEqual({ success: false, blockedReason: PRINCIPAL_MAILBOX_ACCOUNT_REFUSAL });
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    expect(mocks.bus.publish).not.toHaveBeenCalled();
  });

  it('Curia account bound to any mailbox address is refused', async () => {
    const mocks = createMocks();
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient], ['spare', mocks.nylasClient]]),
      emailAccountAddresses: new Map([['curia', 'assistant@example.com'], ['spare', 'personal@example.com']]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('work@example.com')],
      principalEmailAddresses: async () => ['work@example.com', 'personal@example.com'],
      logger: mocks.logger,
    });
    expect(await gateway.send(email({ accountId: 'spare' }))).toEqual({ success: false, blockedReason: PRINCIPAL_MAILBOX_ACCOUNT_REFUSAL });
    expect(await gateway.sendEmailDraft('d1', 'spare', { recipientEmail: 'priya@example.com', body: 'x', subject: 's' })).toEqual({ success: false, blockedReason: PRINCIPAL_MAILBOX_ACCOUNT_REFUSAL });
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('send() still delivers a system notice to the principal alone from the principal\'s mailbox', async () => {
    const { gateway, mocks } = makeGateway({ persona: PERSONA });
    const result = await gateway.send(
      email({ accountId: 'joseph', to: 'CEO@example.com' }),
      { isSystemNotification: true },
    );
    expect(result.blockedReason).toBeUndefined();
    expect(result.success).toBe(true);
    expect(mocks.nylasClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('send() refuses a system notice with an outside recipient from the principal\'s mailbox', async () => {
    const { gateway, mocks } = makeGateway({ persona: PERSONA });
    const result = await gateway.send(
      email({ accountId: 'joseph', to: 'priya@example.com' }),
      { isSystemNotification: true },
    );
    expect(result).toEqual({ success: false, blockedReason: PRINCIPAL_MAILBOX_ACCOUNT_REFUSAL });
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('sendEmailDraft refuses a draft in the principal\'s mailbox account', async () => {
    const { gateway, mocks } = makeGateway({ persona: PERSONA });
    const result = await gateway.sendEmailDraft('draft-1', 'joseph', {
      recipientEmail: 'priya@example.com', body: 'Hi', subject: 'Call',
    });
    expect(result).toEqual({ success: false, blockedReason: PRINCIPAL_MAILBOX_ACCOUNT_REFUSAL });
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    expect(mocks.bus.publish).not.toHaveBeenCalled();
  });

  it('ignores a signature already on the request', async () => {
    const { gateway, sentHtml } = makeGateway();
    await gateway.send({ ...email(), signature: 'Injected' });
    expect(sentHtml()).not.toContain('Injected');
  });
});

describe('band review (#2159)', () => {
  let mocks: ReturnType<typeof createMocks>;
  beforeEach(() => {
    mocks = createMocks();
  });

  const emailReq = { channel: 'email' as const, to: 'joel@example.com', subject: 'Forms', body: 'Hi Joel. I am out of office until the 13th.' };

  function makeBandGateway(opts: { review: ReturnType<typeof vi.fn>; score: number; gating?: 'band' | 'tier'; actionLogRepo?: ActionLogRepo; emailAccountAddresses?: Map<string, string>; signalPhoneNumber?: string; autonomyService?: AutonomyService }) {
    return new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      ...(opts.emailAccountAddresses ? { emailAccountAddresses: opts.emailAccountAddresses } : {}),
      ...(opts.signalPhoneNumber
        ? { signalClient: makeSignalClient() as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient, signalPhoneNumber: opts.signalPhoneNumber }
        : {}),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('principal@example.com')],
      logger: mocks.logger,
      autonomyService: opts.autonomyService ?? makeAutonomyService(opts.score),
      actionLogRepo: opts.actionLogRepo ?? makeActionLogRepo(),
      gating: opts.gating ?? 'band',
      bandReview: { review: opts.review as unknown as BandSendReview['review'] },
    });
  }

  /** An autonomy service whose reads carry `current.gating` (undefined: none, as production tier). */
  function autonomyReading(score: number, gating: 'band' | 'tier' | undefined): { service: AutonomyService; current: { gating: 'band' | 'tier' | undefined } } {
    const base = makeAutonomyService(score);
    const current = { gating };
    const getConfig = vi.fn(async (): Promise<AutonomyConfig | null> => {
      const read = await (base.getConfig as () => Promise<AutonomyConfig>)();
      return { ...read, ...(current.gating ? { gating: current.gating } : {}) };
    });
    return { service: { getConfig } as unknown as AutonomyService, current };
  }

  // The scenario suite pins gating per case on one stack (#2312): the gateway reads it per call.
  describe('reads the gating from the autonomy config on each call', () => {
    it('reviews a send when the config says band, though the gateway was built tier', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84, gating: 'tier', autonomyService: autonomyReading(84, 'band').service });
      expect((await gw.send(emailReq, { taskEventId: 't1' })).success).toBe(true);
      expect(review).toHaveBeenCalledOnce();
    });

    it('skips the review when the config says tier, though the gateway was built band', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84, gating: 'band', autonomyService: autonomyReading(84, 'tier').service });
      await gw.send(emailReq, { taskEventId: 't1' });
      expect(review).not.toHaveBeenCalled();
    });

    it('keeps the constructed gating when the config names none', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84, gating: 'band', autonomyService: autonomyReading(84, undefined).service });
      await gw.send(emailReq, { taskEventId: 't1' });
      expect(review).toHaveBeenCalledOnce();
    });

    it('keeps the constructed gating when the config read fails', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const failing = { getConfig: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as AutonomyService;
      const gw = makeBandGateway({ review, score: 84, gating: 'band', autonomyService: failing });
      await gw.send(emailReq, { taskEventId: 't1' });
      expect(review).toHaveBeenCalledOnce();
    });

    it('follows a change between two sends on the same gateway', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const autonomy = autonomyReading(84, 'band');
      const gw = makeBandGateway({ review, score: 84, gating: 'tier', autonomyService: autonomy.service });
      await gw.send(emailReq, { taskEventId: 't1' });
      expect(review).toHaveBeenCalledOnce();
      autonomy.current.gating = 'tier';
      await gw.send(emailReq, { taskEventId: 't2' });
      expect(review).toHaveBeenCalledOnce();
    });

    it('passes the config\'s gating to the content filter, on sends and draft sends', async () => {
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84, gating: 'tier', autonomyService: autonomyReading(84, 'band').service });
      await gw.send(emailReq, { taskEventId: 't1' });
      await gw.sendEmailDraft('d1', 'curia', { recipientEmail: 'joel@example.com', body: 'Hi Joel.', subject: 'Forms' }, { taskEventId: 't1' });
      const gatings = vi.mocked(mocks.contentFilter.check).mock.calls.map(([input]) => input.gating);
      expect(gatings).toEqual(['band', 'band']);
    });

    it('reads the autonomy config once per send, for the gate, the gating and the band score', async () => {
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const autonomy = autonomyReading(84, 'band');
      const gw = makeBandGateway({ review, score: 84, gating: 'tier', autonomyService: autonomy.service });
      await gw.send(emailReq, { taskEventId: 't1' });
      expect(autonomy.service.getConfig).toHaveBeenCalledOnce();
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ score: 84 }));
      await gw.sendEmailDraft('d1', 'curia', { recipientEmail: 'joel@example.com', body: 'Hi Joel.', subject: 'Forms' }, { taskEventId: 't1' });
      expect(autonomy.service.getConfig).toHaveBeenCalledTimes(2);
    });

    it('reviews at score 0 when the send\'s one read fails', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const failing = { getConfig: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as AutonomyService;
      const gw = makeBandGateway({ review, score: 84, gating: 'band', autonomyService: failing });
      await gw.send(emailReq, { taskEventId: 't1' });
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ score: 0 }));
    });

    it('reviews a draft send when the config says band, though the gateway was built tier', async () => {
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84, gating: 'tier', autonomyService: autonomyReading(84, 'band').service });
      await gw.sendEmailDraft('d1', 'curia', { recipientEmail: 'joel@example.com', body: 'Hi Joel.', subject: 'Forms' }, { taskEventId: 't1' });
      expect(review).toHaveBeenCalledOnce();
    });
  });

  function publishedOfType(bus: EventBus, type: string): Array<{ type: string; payload: Record<string, unknown> }> {
    return vi.mocked(bus.publish).mock.calls
      .map(([, event]) => event as unknown as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === type);
  }

  it('tells the drafter which personal details bounced, by label, and about a placeholder', async () => {
    const findings = [
      { rule: 'pii-not-authorized', detail: 'This message shares personal details nothing authorizes for this recipient: phone_us. Rewrite it without them.' },
      { rule: 'redaction-token', detail: 'The message has a redaction placeholder in it. Rewrite it without the placeholder.' },
    ];
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'bounce', findings }), score: 84 });
    const result = await gw.send(emailReq, { taskEventId: 't1' });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('pii-not-authorized: This message shares personal details nothing authorizes for this recipient: phone_us.');
    expect(result.blockedReason).toContain('redaction-token: The message has a redaction placeholder');
  });

  it('sends the message unchanged when the review passes it', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84 });
    const result = await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1' });
    expect(result.success).toBe(true);
    const sent = vi.mocked(mocks.nylasClient.sendMessage).mock.calls[0]![0] as { body: string };
    expect(sent.body).toContain('out of office until the 13th');
  });

  it('reviews an email addressed only to Curia\'s own mailbox with no outside audience', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84, emailAccountAddresses: new Map([['curia', 'curia@example.com']]) });
    const result = await gw.send({ ...emailReq, to: 'curia@example.com' }, { taskEventId: 't1', conversationId: 'c1' });
    expect(result.success).toBe(true);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ recipients: [], principalRecipients: [] }));
  });

  it('does not count Curia\'s own Signal number as an audience member', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84, signalPhoneNumber: '+15555550000' });
    const result = await gw.send({ channel: 'signal', recipient: '+15555550000', message: 'note to self' }, { taskEventId: 't1', conversationId: 'c1' });
    expect(result.success).toBe(true);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ recipients: [] }));
  });

  it('passes the review what it needs', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84 });
    await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', principalDirected: true, postTurn: true });
    expect(review).toHaveBeenCalledWith({
      content: emailReq.body, channel: 'email', recipients: ['joel@example.com'], principalRecipients: [], score: 84,
      conversationId: 'c1', taskEventId: 't1', principalDirected: true, postTurn: true,
      recipientTier: 'unknown', recipientTiers: {}, subject: 'Forms',
    });
  });

  it('passes the review every resolved recipient\'s tier, for an ask (#2312)', async () => {
    const tiers: Record<string, string> = { 'joel@example.com': 'known', 'ops@example.com': 'trusted' };
    vi.mocked(mocks.contactService.resolveByChannelIdentity).mockImplementation(async (_channel: string, id: string) => (
      tiers[id.toLowerCase()] ? { contactId: `c-${id}`, displayName: id, role: null, tier: tiers[id.toLowerCase()], kind: 'person', kgNodeId: null, verified: true } : null
    ) as never);
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84 });
    await gw.send({ ...emailReq, cc: ['Ops@Example.com', 'nobody@example.com'] }, { taskEventId: 't1', conversationId: 'c1' });
    // Normalized ids; a recipient with no contact is left out, so it is not askable.
    expect(review.mock.calls[0]![0].recipientTiers).toEqual({ 'joel@example.com': 'known', 'ops@example.com': 'trusted' });
    // Each resolved contact id too, so a link can cover a cc'd contact by id.
    expect(review.mock.calls[0]![0].recipientContactIds).toEqual({ 'joel@example.com': 'c-joel@example.com', 'ops@example.com': 'c-Ops@Example.com' });
  });

  it('passes the review a cc\'d contact\'s id even when their tier is unknown (#2312)', async () => {
    vi.mocked(mocks.contactService.resolveByChannelIdentity).mockImplementation(async (_channel: string, id: string) => (
      { contactId: `c-${id.toLowerCase()}`, displayName: id, role: null, tier: id.toLowerCase() === 'joel@example.com' ? 'known' : 'unknown', kind: 'person', kgNodeId: null, verified: true }
    ) as never);
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84 });
    await gw.send({ ...emailReq, cc: ['ops@other.example'] }, { taskEventId: 't1', conversationId: 'c1' });
    expect(review.mock.calls[0]![0].recipientContactIds).toEqual({ 'joel@example.com': 'c-joel@example.com', 'ops@other.example': 'c-ops@other.example' });
  });

  it('passes no contact id for an unverified address, primary or cc\'d (#2312)', async () => {
    // An unverified address on a linked contact must not count as that contact.
    vi.mocked(mocks.contactService.resolveByChannelIdentity).mockImplementation(async (_channel: string, id: string) => (
      { contactId: 'c-linked', displayName: id, role: null, tier: 'known', kind: 'person', kgNodeId: null, verified: id.toLowerCase() === 'joel@example.com' }
    ) as never);
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84 });
    await gw.send({ ...emailReq, cc: ['joel.alt@other.example'] }, { taskEventId: 't1', conversationId: 'c1' });
    expect(review.mock.calls[0]![0].recipientContactIds).toEqual({ 'joel@example.com': 'c-linked' });
    // An unverified primary carries none either.
    vi.mocked(mocks.contactService.resolveByChannelIdentity).mockImplementation(async (_channel: string, id: string) => (
      { contactId: 'c-linked', displayName: id, role: null, tier: 'known', kind: 'person', kgNodeId: null, verified: false }
    ) as never);
    const review2 = vi.fn().mockResolvedValue({ kind: 'send' });
    await makeBandGateway({ review: review2, score: 84 }).send(emailReq, { taskEventId: 't1', conversationId: 'c1' });
    expect(review2.mock.calls[0]![0]).not.toHaveProperty('recipientContactIds');
  });

  it('forwards the note reported to the principal to the review (#2312)', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84 });
    await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', postTurn: true, reportedToPrincipal: 'Provider asked for your number.' });
    expect(review.mock.calls[0]![0]).toMatchObject({ reportedToPrincipal: 'Provider asked for your number.' });
    await gw.send(emailReq, { taskEventId: 't2', conversationId: 'c2' });
    expect(review.mock.calls[1]![0]).not.toHaveProperty('reportedToPrincipal');
  });

  it('tells the review which recipients are the principal', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send' });
    const gw = makeBandGateway({ review, score: 84 });
    await gw.send({ ...emailReq, to: 'principal@example.com', cc: ['joel@example.com'] }, { taskEventId: 't1', conversationId: 'c1' });
    const arg = review.mock.calls[0]![0] as { recipients: string[]; principalRecipients: string[] };
    expect(arg.principalRecipients).toEqual(['principal@example.com']);
    expect(arg.recipients).toEqual(expect.arrayContaining(['principal@example.com', 'joel@example.com']));
  });

  it('bounces with the quoted claims and an outbound.blocked event, but no block report', async () => {
    const findings = [{ rule: 'ungrounded-claim', detail: 'These claims about the principal are not backed: "I am out of office until the 13th."' }];
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'bounce', findings }), score: 84 });
    const result = await gw.send(emailReq, { taskEventId: 't1' });
    expect(result).toMatchObject({ success: false, blockedRules: ['ungrounded-claim'] });
    expect(result.blockedReason).toContain('out of office until the 13th');
    expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(1);
    expect(publishedOfType(mocks.bus, 'principal.report')).toHaveLength(0);
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a blocked send with the block reason, publishes no outbound.blocked, and tells the digest', async () => {
    const findings = [{ rule: 'ungrounded-claim', detail: 'not backed: "I am out of office until the 13th."' }];
    const reason = BLOCK_REASON;
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'block', reason, findings }), score: 84 });
    const result = await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1' });
    expect(result).toMatchObject({ success: false, blockedRules: ['ungrounded-claim'] });
    expect(result.blockedReason!.startsWith(BLOCK_REASON)).toBe(true);
    expect(result.blockedReason).toContain('out of office until the 13th');
    expect(result.gated).toBeUndefined();
    // No outbound.blocked: on a relay it would start the #1355 rewrite loop again.
    expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    const reports = publishedOfType(mocks.bus, 'principal.report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.payload).toMatchObject({ source: 'blocked_content', urgency: 'digest', summary: expect.stringContaining('joel@example.com') });
    // Labels only: the digest names the rule, never the agent's quoted sentence.
    expect(String(reports[0]!.payload['summary'])).toContain('ungrounded-claim');
    expect(String(reports[0]!.payload['summary'])).not.toContain('out of office');
  });

  it('holds a relayed reply as gated with an approval, and never publishes outbound.blocked', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held: steered.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84, actionLogRepo });
    const result = await gw.send(emailReq, {
      taskEventId: 't1', postTurn: true,
      reExecRecipe: { toolName: 'send-draft', partialPayload: { account: 'a' }, description: 'Draft reply to joel@example.com' },
    });
    expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.any(String) });
    expect(result.blockedReason).toContain('Held: steered.');
    expect(actionLogRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'send-draft', outcome: 'pending_approval' }));
    expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  describe('a block with no drafter waiting holds instead (#2312)', () => {
    const blockFindings = [{ rule: 'ungrounded-claim', detail: 'not backed: "I am out of office until the 13th."' }];
    const blockDecision = { kind: 'block', reason: BLOCK_REASON, findings: blockFindings };

    it('holds a relayed reply as gated with an approval, never blocks or publishes outbound.blocked', async () => {
      const actionLogRepo = makeActionLogRepo();
      const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(blockDecision), score: 84, actionLogRepo });
      const result = await gw.send(emailReq, {
        taskEventId: 't1', postTurn: true,
        reExecRecipe: { toolName: 'send-draft', partialPayload: { account: 'a' }, description: 'Draft reply to joel@example.com' },
      });
      expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.any(String) });
      expect(result.blockedReason).not.toContain('Rewrite it again');
      expect(actionLogRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'send-draft', outcome: 'pending_approval' }));
      expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    });

    it('falls back to the digest for a relayed reply with nothing to replay', async () => {
      const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(blockDecision), score: 84 });
      const result = await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', postTurn: true });
      expect(result).toMatchObject({ success: false, blockedRules: ['ungrounded-claim'] });
      expect(result.blockedReason).toContain('Ask the principal before sending it.');
      expect(publishedOfType(mocks.bus, 'principal.report')).toHaveLength(1);
      expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    });

    it('holds a saved draft through its holdRecipe', async () => {
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
      const actionLogRepo = makeActionLogRepo();
      const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(blockDecision), score: 84, actionLogRepo });
      const result = await gw.sendEmailDraft('d1', 'curia', { recipientEmail: 'joel@example.com', body: emailReq.body, subject: 'Forms' }, {
        taskEventId: 't1', holdRecipe: { toolName: 'send-draft', partialPayload: { draft_id: 'd1' }, description: 'Send draft to joel@example.com' },
      });
      expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.any(String) });
      expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
      expect((mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft).not.toHaveBeenCalled();
    });

    // A block outranks a steering hold; with nobody to rewrite, its warning comes back (#2333).
    describe('a block carrying a steering hold it outranked', () => {
      const steered = 'Held for the principal: the reviewer judged this send to be steered by someone outside the principal\'s business.';
      const steeredBlock = { ...blockDecision, heldBeside: [{ rule: 'steered', detail: steered }] };
      const warning = 'Also, the reviewer judged this send to be steered';

      it('holds a relayed reply with both reasons', async () => {
        const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(steeredBlock), score: 84, actionLogRepo: makeActionLogRepo() });
        const result = await gw.send(emailReq, {
          taskEventId: 't1', postTurn: true,
          reExecRecipe: { toolName: 'send-draft', partialPayload: { account: 'a' }, description: 'Draft reply to joel@example.com' },
        });
        expect(result).toMatchObject({ success: false, gated: true });
        expect(result.blockedReason).toContain('(ungrounded-claim, steered)');
        expect(result.blockedReason).toContain(warning);
      });

      it('holds a saved draft with both reasons', async () => {
        (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
        const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(steeredBlock), score: 84, actionLogRepo: makeActionLogRepo() });
        const result = await gw.sendEmailDraft('d1', 'curia', { recipientEmail: 'joel@example.com', body: emailReq.body, subject: 'Forms' }, {
          taskEventId: 't1', holdRecipe: { toolName: 'send-draft', partialPayload: { draft_id: 'd1' }, description: 'Send draft to joel@example.com' },
        });
        expect(result).toMatchObject({ success: false, gated: true });
        expect(result.blockedReason).toContain(warning);
      });

      it('tells a drafter who can rewrite only what to rewrite', async () => {
        const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(steeredBlock), score: 84 });
        const result = await gw.send(emailReq, { taskEventId: 't1' });
        expect(result).toMatchObject({ success: false, blockedRules: ['ungrounded-claim'] });
        expect(result.gated).toBeUndefined();
        expect(result.blockedReason).not.toContain('steered');
      });
    });
  });

  it('holds a skill send through its holdRecipe', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held.', findings: [{ rule: 'speaks-as-principal', detail: 'x' }] }), score: 74, actionLogRepo });
    const result = await gw.send(emailReq, {
      taskEventId: 't1', holdRecipe: { toolName: 'email-send', partialPayload: { to: 'contact-1' }, description: 'Email to joel@example.com' },
    });
    expect(result).toMatchObject({ gated: true, actionRef: expect.any(String) });
    expect(actionLogRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'email-send', payload: { to: 'contact-1' } }));
  });

  it('quotes the approval number of a held send to the agent (#2159 Phase 3)', async () => {
    const actionLogRepo = makeNumberedActionLogRepo(4);
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84, actionLogRepo });
    const result = await gw.send(emailReq, {
      taskEventId: 't1', holdRecipe: { toolName: 'email-send', partialPayload: { to: 'contact-1' }, description: 'Email to joel@example.com' },
    });
    expect(result).toMatchObject({ gated: true, actionRef: expect.any(String) });
    expect(result.blockedReason).toContain('approval 4');
    expect(result.blockedReason).toContain(`ref: ${result.actionRef}`);
  });

  // PR 5 (#2312): a requester's ask reaches the principal as a question, now.
  describe('a held request for the principal\'s data asks the principal', () => {
    const askHold = (ask: Record<string, unknown>) => ({
      kind: 'hold',
      reason: 'Held for the principal: the recipient asked for personal details (phone_us) that nothing authorizes sharing yet.',
      findings: [{ rule: 'pii-not-authorized', detail: 'x' }],
      ask,
    });
    const holdRecipe = { toolName: 'email-send', partialPayload: { to: 'contact-1' }, description: 'Email to joel@example.com' };

    it('leads the approval with the question and tells the agent to deliver it now', async () => {
      const actionLogRepo = makeNumberedActionLogRepo(4);
      const registerDisplay = vi.fn();
      const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(askHold({ labels: ['phone_us', 'sin_ca'], requester: 'joel@example.com', counterparties: ['joel@example.com'], taskTitle: 'Book physio' })), score: 84, actionLogRepo });
      gw.setApprovalDelivery({ registerDisplay } as never);
      const result = await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', holdRecipe });
      expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.any(String) });
      expect(registerDisplay).toHaveBeenCalledWith(result.actionRef, expect.objectContaining({
        preamble: 'joel@example.com is asking for your phone number and SIN for "Book physio". Share it? Reply yes to send the message below as written, or no to keep it private.',
        extraLines: [],
      }));
      expect(result.blockedReason!.endsWith(
        'This is waiting on the principal. Deliver approval 4 to them now with deliver-approval on their urgent channel, then send joel@example.com a short holding reply that doesn\'t include the requested details.',
      )).toBe(true);
      // The action row and its digest mention keep the recipe's description.
      expect(actionLogRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ description: 'Email to joel@example.com' }));
    });

    it('omits the task when none is known, and names the ref when the approval has no number', async () => {
      const registerDisplay = vi.fn();
      const gw = makeBandGateway({ review: vi.fn().mockResolvedValue(askHold({ labels: ['phone_us'], requester: 'joel@example.com', counterparties: ['joel@example.com'] })), score: 84 });
      gw.setApprovalDelivery({ registerDisplay } as never);
      const result = await gw.send(emailReq, { taskEventId: 't1', holdRecipe });
      expect(registerDisplay).toHaveBeenCalledWith(result.actionRef, expect.objectContaining({
        preamble: 'joel@example.com is asking for your phone number. Share it? Reply yes to send the message below as written, or no to keep it private.',
      }));
      expect(result.blockedReason).toContain(`Deliver approval ${result.actionRef} to them now with deliver-approval on their urgent channel`);
    });

    // Task 2: the ask is stored beside the payload, so approve and deny can record the answer
    // while the replay re-invokes the skill with exactly the input it was held with.
    it('stores the ask on the approval row beside the payload, keyed by the thread', async () => {
      const actionLogRepo = makeActionLogRepo();
      const gw = makeBandGateway({
        review: vi.fn().mockResolvedValue(askHold({
          // A display-name requester: the stored key is the bare, lowercased address.
          labels: ['phone_us'], requester: 'Joel <Joel@Example.com>', counterparties: ['joel@example.com'], outreachId: 'o-1', taskTitle: 'Book physio',
        })),
        score: 84, actionLogRepo,
      });
      await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', holdRecipe });
      expect(actionLogRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
        payload: { to: 'contact-1' },
        disclosureAsk: { conversationId: 'c1', counterparties: ['joel@example.com'], labels: ['phone_us'], requester: 'joel@example.com', outreachId: 'o-1', taskTitle: 'Book physio' },
      }));
    });

    it('shows an ask\'s other hold reason beside the question (#2312)', async () => {
      const registerDisplay = vi.fn();
      const hold = askHold({ labels: ['email'], requester: 'joel@example.com', counterparties: ['joel@example.com'] });
      const gw = makeBandGateway({
        review: vi.fn().mockResolvedValue({
          ...hold,
          findings: [...hold.findings, { rule: 'speaks-as-principal', detail: 'Held for the principal: this message speaks for or commits the principal.' }],
        }),
        score: 74,
      });
      gw.setApprovalDelivery({ registerDisplay } as never);
      await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', holdRecipe });
      expect(registerDisplay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        preamble: expect.stringContaining('is asking for your email address'),
        extraLines: expect.arrayContaining([expect.stringContaining('Also held by the send review: Held for the principal: this message speaks for')]),
      }));
    });

    it('stores no ask without a conversation to key it, or on any other hold', async () => {
      const noThread = makeActionLogRepo();
      const gw1 = makeBandGateway({
        review: vi.fn().mockResolvedValue(askHold({ labels: ['phone_us'], requester: 'joel@example.com', counterparties: ['joel@example.com'] })),
        score: 84, actionLogRepo: noThread,
      });
      const r1 = await gw1.send(emailReq, { taskEventId: 't1', holdRecipe });
      expect(r1).toMatchObject({ gated: true });
      expect(vi.mocked(noThread.insert).mock.calls[0]![0]).not.toHaveProperty('disclosureAsk');
      const other = makeActionLogRepo();
      const gw2 = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84, actionLogRepo: other });
      await gw2.send(emailReq, { taskEventId: 't1', conversationId: 'c1', holdRecipe });
      expect(vi.mocked(other.insert).mock.calls[0]![0]).not.toHaveProperty('disclosureAsk');
    });

    it('names the requester bare, and every other recipient a yes covers, in the question', () => {
      const ask = { labels: ['sin_ca'], requester: 'Joel <Joel@Example.com>', counterparties: ['joel@example.com'] };
      const tail = 'Share it? Reply yes to send the message below as written, or no to keep it private.';
      expect(askPreamble(ask)).toBe(`joel@example.com is asking for your SIN. ${tail}`);
      expect(askPreamble({ ...ask, counterparties: ['joel@example.com', 'Ops@Example.com'] }))
        .toBe(`joel@example.com is asking for your SIN. The message also goes to ops@example.com, and a yes covers them too. ${tail}`);
      expect(askPreamble({ ...ask, counterparties: ['joel@example.com', 'ops@example.com', 'sam@example.com'], taskTitle: 'Book physio' }))
        .toBe(`joel@example.com is asking for your SIN for "Book physio". The message also goes to ops@example.com, sam@example.com, and a yes covers them too. ${tail}`);
      const many = ['joel@example.com', ...Array.from({ length: 7 }, (_, i) => `cc${i}@example.com`)];
      expect(askPreamble({ ...ask, counterparties: many })).toContain('cc0@example.com, cc1@example.com, cc2@example.com, cc3@example.com, cc4@example.com and 2 more');
      // The contact's name beside the address, so the principal knows who is asking (#2312).
      expect(askPreamble({ ...ask, requesterName: 'Joel Fry' })).toBe(`Joel Fry (joel@example.com) is asking for your SIN. ${tail}`);
    });

    it('names the requester by their contact record in the stored ask, unless the name is the address', async () => {
      const resolve = (name: string) => vi.mocked(mocks.contactService.resolveByChannelIdentity).mockResolvedValue(
        { contactId: 'c-joel', displayName: name, role: null, tier: 'known', kind: 'person', kgNodeId: null, verified: true } as never,
      );
      const hold = () => vi.fn().mockResolvedValue(askHold({ labels: ['phone_us'], requester: 'joel@example.com', counterparties: ['joel@example.com'] }));
      resolve('Joel "the" <Fry>\nSmith');
      const named = makeActionLogRepo();
      const registerDisplay = vi.fn();
      const namedGw = makeBandGateway({ review: hold(), score: 84, actionLogRepo: named });
      namedGw.setApprovalDelivery({ registerDisplay } as never);
      await namedGw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', holdRecipe });
      // One line, no quotes or angle brackets: display only, the address stays the key.
      expect(vi.mocked(named.insert).mock.calls[0]![0].disclosureAsk).toMatchObject({ requester: 'joel@example.com', requesterName: 'Joel the Fry Smith' });
      // The question raised with the hold names them too, not only a re-delivery of it.
      expect(registerDisplay).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        preamble: expect.stringContaining('Joel the Fry Smith (joel@example.com) is asking for your phone number'),
      }));
      resolve('Joel@Example.com');
      const bare = makeActionLogRepo();
      await makeBandGateway({ review: hold(), score: 84, actionLogRepo: bare }).send(emailReq, { taskEventId: 't1', conversationId: 'c1', holdRecipe });
      expect(vi.mocked(bare.insert).mock.calls[0]![0].disclosureAsk).not.toHaveProperty('requesterName');
    });

    // A relayed reply's agent is gone: the coordinator wake must say this is an ask.
    describe('on a relayed reply', () => {
      const relayRecipe = {
        toolName: 'send-draft', partialPayload: { account: 'curia' },
        description: 'Draft reply to joel@example.com — "Forms". Use send-draft to approve.',
        askDescription: 'Draft reply to joel@example.com — "Forms". Approve it with approve-action or send-draft; either records the principal\'s yes.',
      };
      const relayReq = { ...emailReq, accountId: 'curia', replyToMessageId: 'msg-7' };
      const wakeContent = (): string => {
        const wakes = publishedOfType(mocks.bus, 'agent.task');
        expect(wakes).toHaveLength(1);
        return String(wakes[0]!.payload['content']);
      };

      it('wakes the coordinator with the ask: urgent, one holding reply on the thread, no details', async () => {
        const actionLogRepo = makeActionLogRepo();
        const gw = makeBandGateway({
          review: vi.fn().mockResolvedValue(askHold({ labels: ['sin_ca', 'phone_us'], requester: 'joel@example.com', counterparties: ['joel@example.com'] })),
          score: 84, actionLogRepo,
        });
        const result = await gw.send(relayReq, { taskEventId: 't1', conversationId: 'c1', postTurn: true, reExecRecipe: relayRecipe });
        expect(result).toMatchObject({ gated: true, actionRef: expect.any(String) });
        const content = wakeContent();
        expect(content).toContain(relayRecipe.askDescription);
        expect(content).toContain('It is a personal-data request: joel@example.com asked for the principal\'s SIN and phone number');
        expect(content).toContain('This is urgent. Deliver it now with deliver-approval');
        expect(content).toContain('Then you may send joel@example.com one short holding reply on the thread (email-reply with reply_to_message_id msg-7, account curia). It must not include the requested details.');
        expect(content.endsWith('Do not do anything else.')).toBe(true);
        // Labels only, never raw label ids.
        expect(content).not.toContain('sin_ca');
        // The row says either tool approves it.
        expect(actionLogRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ description: relayRecipe.askDescription }));
      });

      it('keeps the plain wake and description for any other relayed hold', async () => {
        const actionLogRepo = makeActionLogRepo();
        const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84, actionLogRepo });
        await gw.send(relayReq, { taskEventId: 't1', conversationId: 'c1', postTurn: true, reExecRecipe: relayRecipe });
        const content = wakeContent();
        expect(content).toContain(relayRecipe.description);
        expect(content).not.toContain('personal-data');
        expect(content).not.toContain('holding reply');
        expect(actionLogRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ description: relayRecipe.description }));
      });
    });

    it('keeps the recipe\'s description as the preamble of any other hold', async () => {
      const registerDisplay = vi.fn();
      const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84 });
      gw.setApprovalDelivery({ registerDisplay } as never);
      const result = await gw.send(emailReq, { taskEventId: 't1', holdRecipe });
      expect(registerDisplay).toHaveBeenCalledWith(result.actionRef, expect.objectContaining({
        preamble: 'Email to joel@example.com', extraLines: ['Held by the send review: Held.'],
      }));
      expect(result.blockedReason).not.toContain('This is waiting on the principal.');
    });

    // #2473: the approval a stakes hold raises says what the send commits the principal to, and why.
    it('names the stakes rating and the judge\'s reason on the approval a stakes hold raises', async () => {
      const judgeReview = vi.fn().mockResolvedValue({
        ok: true, purpose: 'serving', speaksAsPrincipal: true, stakes: 'financial_or_legal',
        stakesReason: 'Confirms a purchase order.', unsupportedClaims: [], unnecessaryItems: [], reason: 'ok',
      });
      const review = new BandSendReview({
        judge: { review: judgeReview, isEnabled: () => true },
        evidence: { collect: vi.fn().mockResolvedValue({ unavailable: false, toolResults: [], principalBlock: null }) },
        limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createLogger('error'),
      });
      const registerDisplay = vi.fn();
      const gw = makeBandGateway({ review: vi.fn((input) => review.review(input)), score: 100 });
      gw.setApprovalDelivery({ registerDisplay } as never);
      const result = await gw.send(emailReq, { taskEventId: 't1', holdRecipe });
      expect(result).toMatchObject({ success: false, gated: true });
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
      const [line] = registerDisplay.mock.calls[0]![1].extraLines as string[];
      expect(line).toContain('Stakes: financial or legal.');
      expect(line).toContain('Why: Confirms a purchase order.');
    });

    it('bounces a cold stranger\'s request with one digest note and no approval', async () => {
      const actionLogRepo = makeActionLogRepo();
      const findings = [{ rule: 'pii-not-authorized', detail: 'This message shares personal details nothing authorizes for this recipient: sin_ca. Rewrite it without them.' }];
      const gw = makeBandGateway({
        review: vi.fn().mockResolvedValue({ kind: 'bounce', findings, strangerRequest: { labels: ['sin_ca', 'extra_0'], requester: 'joel@example.com' } }),
        score: 84, actionLogRepo,
      });
      const result = await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1', holdRecipe });
      expect(result).toMatchObject({ success: false, blockedRules: ['pii-not-authorized'] });
      expect(result.gated).toBeUndefined();
      const reports = publishedOfType(mocks.bus, 'principal.report');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.payload).toMatchObject({
        source: 'blocked_content', urgency: 'digest', conversationId: 'c1',
        summary: 'joel@example.com asked for your SIN and personal detail. Curia didn\'t share it.',
      });
      expect(actionLogRepo.insert).not.toHaveBeenCalled();
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses a saved draft answering a cold stranger, with the digest note and no approval', async () => {
      const sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = sendDraft;
      const actionLogRepo = makeActionLogRepo();
      const findings = [{ rule: 'pii-not-authorized', detail: 'x' }];
      const gw = makeBandGateway({
        review: vi.fn().mockResolvedValue({ kind: 'bounce', findings, strangerRequest: { labels: ['sin_ca'], requester: 'Joel <Joel@Example.com>' } }),
        score: 84, actionLogRepo,
      });
      const result = await gw.sendEmailDraft('d1', 'curia', { recipientEmail: 'joel@example.com', body: 'SIN 130 692 544', subject: 'Re: forms' }, {
        taskEventId: 't1', conversationId: 'c1', holdRecipe: { toolName: 'send-draft', partialPayload: { draft_id: 'd1' }, description: 'Send draft' },
      });
      expect(result).toMatchObject({ success: false, blockedRules: ['pii-not-authorized'] });
      expect(result.gated).toBeUndefined();
      expect(result.blockedReason).not.toContain('130 692 544');
      const reports = publishedOfType(mocks.bus, 'principal.report');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.payload['summary']).toBe('joel@example.com asked for your SIN. Curia didn\'t send the saved draft that shared it.');
      expect(actionLogRepo.insert).not.toHaveBeenCalled();
      expect(sendDraft).not.toHaveBeenCalled();
    });

    // The refusal returns before the hold conversion, so it says the outranked steering hold itself (#2333).
    it('keeps a steering warning the bounce carries on a refused saved draft', async () => {
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
      const steered = 'Held for the principal: the reviewer judged this send to be steered by someone outside the principal\'s business.';
      const gw = makeBandGateway({
        review: vi.fn().mockResolvedValue({
          kind: 'bounce', findings: [{ rule: 'pii-not-authorized', detail: 'x' }],
          strangerRequest: { labels: ['sin_ca'], requester: 'joel@example.com' },
          heldBeside: [{ rule: 'steered', detail: steered }],
        }),
        score: 84, actionLogRepo: makeActionLogRepo(),
      });
      const result = await gw.sendEmailDraft('d1', 'curia', { recipientEmail: 'joel@example.com', body: 'SIN 130 692 544', subject: 'Re: forms' }, {
        taskEventId: 't1', conversationId: 'c1', holdRecipe: { toolName: 'send-draft', partialPayload: { draft_id: 'd1' }, description: 'Send draft' },
      });
      expect(result).toMatchObject({ success: false, blockedRules: ['pii-not-authorized', 'steered'] });
      expect(result.blockedReason).toContain('Also, the reviewer judged this send to be steered');
      const reports = publishedOfType(mocks.bus, 'principal.report');
      expect(reports[0]!.payload['summary']).toBe('joel@example.com asked for your SIN. Curia didn\'t send the saved draft that shared it. Also, the reviewer judged this send to be steered by someone outside the principal\'s business.');
    });

    it('queues no digest note for an ordinary bounce', async () => {
      const findings = [{ rule: 'ungrounded-claim', detail: 'x' }];
      const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'bounce', findings }), score: 84 });
      await gw.send(emailReq, { taskEventId: 't1' });
      expect(publishedOfType(mocks.bus, 'principal.report')).toHaveLength(0);
    });
  });

  it('refuses a held send with no recipe, telling the agent to ask', async () => {
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84 });
    const result = await gw.send(emailReq, { taskEventId: 't1' });
    expect(result).toMatchObject({ success: false, blockedRules: ['steered'] });
    expect(result.gated).toBeUndefined();
    expect(result.blockedReason).toContain('Ask the principal before sending it.');
  });

  it('tells the principal\'s digest about a hold no approval could be raised for', async () => {
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held: steered.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84 });
    await gw.send(emailReq, { taskEventId: 't1', conversationId: 'c1' });
    expect(publishedOfType(mocks.bus, 'principal.report')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ source: 'blocked_content', summary: expect.stringContaining('Held: steered.') }) }),
    ]);
  });

  it('tells the digest when the approval row for a hold could not be written', async () => {
    const actionLogRepo = makeActionLogRepo();
    vi.mocked(actionLogRepo.insert).mockRejectedValue(new Error('db down'));
    const gw = makeBandGateway({ review: vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held: steered.', findings: [{ rule: 'steered', detail: 'x' }] }), score: 84, actionLogRepo });
    const result = await gw.send(emailReq, { taskEventId: 't1', holdRecipe: { toolName: 'email-send', description: 'Email to joel@example.com' } });
    expect(result).toMatchObject({ gated: true });
    expect(result.actionRef).toBeUndefined();
    expect(publishedOfType(mocks.bus, 'principal.report').map((e) => e.payload['source'])).toContain('blocked_content');
  });

  it('logs an error when built for band gating with no review to run', () => {
    const error = vi.fn();
    const logger = { ...mocks.logger, child: () => ({ ...mocks.logger, error }) } as unknown as typeof mocks.logger;
    new OutboundGateway({
      contactService: mocks.contactService, contentFilter: mocks.contentFilter, bus: mocks.bus, logger, gating: 'band',
    });
    expect(error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('band gating without a band review'));
  });

  it('holds when the review throws', async () => {
    const gw = makeBandGateway({ review: vi.fn().mockRejectedValue(new Error('boom')), score: 84 });
    const result = await gw.send(emailReq, { taskEventId: 't1' });
    expect(result.success).toBe(false);
    expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
  });

  it('skips the review for the principal alone, system notifications and approved sends', async () => {
    const review = vi.fn();
    const gw = makeBandGateway({ review, score: 84 });
    await gw.send({ ...emailReq, to: 'principal@example.com' }, {});
    await gw.send(emailReq, { isSystemNotification: true });
    await gw.send(emailReq, { humanApproved: true });
    expect(review).not.toHaveBeenCalled();
  });

  it('never reviews under tier gating, and ignores holdRecipe there', async () => {
    const review = vi.fn();
    const gw = makeBandGateway({ review, score: 84, gating: 'tier' });
    const result = await gw.send(emailReq, { taskEventId: 't1', holdRecipe: { toolName: 'email-send', description: 'x' } });
    expect(review).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('emails the principal when a sent-without-review report cannot be recorded', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send', report: { source: 'sent_without_review', summary: 'Sent unreviewed' } });
    const gw = makeBandGateway({ review, score: 84 });
    vi.mocked(mocks.bus.publish).mockImplementation(async (_layer, event) => {
      if ((event as { type: string }).type === 'principal.report') throw new Error('audit down');
    });
    await gw.send(emailReq, { taskEventId: 't1' });
    const recipients = vi.mocked(mocks.nylasClient.sendMessage).mock.calls.map((c) => (c[0] as { to: Array<{ email: string }> }).to[0]!.email);
    expect(recipients).toEqual(['joel@example.com', 'principal@example.com']);
  });

  describe('personal data is sent only when the review authorizes it (#2312)', () => {
    const phone = '(415) 555-1234';
    const phoneBody = `Call me on ${phone} tomorrow.`;
    const phoneReq = { channel: 'email' as const, to: 'joel@example.com', subject: 'Forms', body: phoneBody };

    async function makePiiGateway(opts: {
      review: ReturnType<typeof vi.fn>; gating?: 'band' | 'tier'; withSignal?: boolean;
      principalIdentities?: ReturnType<typeof makePrincipalIdentity>[];
      outboundQueue?: OutboundQueueRepo; emailReady?: () => boolean;
      piiRedactor?: PiiRedactor;
      /** Band gating with no review wired. */
      noReview?: boolean;
      actionLogRepo?: ReturnType<typeof makeActionLogRepo>;
    }) {
      const { PiiRedactor: RealPiiRedactor } = await import('../../../src/dispatch/pii-redactor.js');
      const signalClient = makeSignalClient();
      const gateway = new OutboundGateway({
        nylasClients: new Map([['curia', mocks.nylasClient]]),
        ...(opts.withSignal
          ? {
            signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
            signalPhoneNumber: '+15555550000',
          }
          : {}),
        contactService: mocks.contactService,
        contentFilter: mocks.contentFilter,
        bus: mocks.bus,
        principalIdentities: opts.principalIdentities ?? [makePrincipalIdentity('principal@example.com')],
        logger: mocks.logger,
        autonomyService: makeAutonomyService(84),
        actionLogRepo: opts.actionLogRepo ?? makeActionLogRepo(),
        gating: opts.gating ?? 'band',
        ...(opts.noReview ? {} : { bandReview: { review: opts.review as unknown as BandSendReview['review'] } }),
        ...(opts.outboundQueue
          ? { outboundQueue: opts.outboundQueue, outboundQueueReadiness: new Map([['email', opts.emailReady ?? (() => false)]]) }
          : {}),
        piiRedactor: opts.piiRedactor ?? new RealPiiRedactor({
          config: { enabled: true, default: 'block', channel_policies: { email: { allow: ['email'] }, signal: { allow: [] } } },
          bus: mocks.bus,
          logger: mocks.logger,
          extraPatterns: [],
        }),
      });
      return { gateway, signalClient };
    }

    function sentEmail(): { body: string; subject: string; cc?: Array<{ email: string }> } {
      return vi.mocked(mocks.nylasClient.sendMessage).mock.calls[0]![0] as { body: string; subject: string; cc?: Array<{ email: string }> };
    }

    it('delivers the raw value when the review sends it, with no redaction audit', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const { gateway } = await makePiiGateway({ review });
      const result = await gateway.send(phoneReq, { taskEventId: 't1', conversationId: 'c1' });

      expect(result.success).toBe(true);
      expect(sentEmail().body).toContain(phone);
      expect(publishedOfType(mocks.bus, 'outbound.pii_redacted')).toHaveLength(0);
      // Nothing was redacted on the wire.
      expect(result.redactions).toBeUndefined();
      expect(result.sentContent).toBeUndefined();
      // The audit event carries the redacted copy, never the authorized value.
      const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
      expect(delivered).toHaveLength(1);
      expect(String(delivered[0]!.payload['content'])).toContain('[REDACTED: PHONE_US]');
      expect(String(delivered[0]!.payload['content'])).not.toContain('555-1234');
      expect(delivered[0]!.payload['disclosed']).toEqual([{ label: 'phone_us', field: 'body' }]);
    });

    it('records a quoted detail the review let out, which the audit body cannot show', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const { gateway } = await makePiiGateway({ review });
      await gateway.send({ ...phoneReq, body: 'See below.', htmlQuote: '<blockquote>SIN 130 692 544</blockquote>' }, { taskEventId: 't1' });

      const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
      expect(delivered[0]!.payload['disclosed']).toEqual([{ label: 'sin_ca', field: 'quote' }]);
      expect(JSON.stringify(delivered[0]!.payload)).not.toContain('130 692 544');
    });

    it('gives the content filter a redacted copy', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const { gateway } = await makePiiGateway({ review });
      await gateway.send(phoneReq, { taskEventId: 't1' });

      expect(mocks.contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Call me on [REDACTED: PHONE_US] tomorrow.',
      }));
    });

    it('passes the review the detected items, the raw content, the recipient tier and the subject', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      vi.mocked(mocks.contactService.resolveByChannelIdentity).mockResolvedValue({
        contactId: 'joel-1', displayName: 'Joel', tier: 'trusted', kind: 'person', verified: true,
      } as unknown as Awaited<ReturnType<ContactService['resolveByChannelIdentity']>>);
      const { gateway } = await makePiiGateway({ review });
      await gateway.send(
        { ...phoneReq, subject: `Re: ${phone}`, htmlQuote: `<blockquote>Reach me at ${phone}</blockquote>` },
        { taskEventId: 't1' },
      );

      const arg = review.mock.calls[0]![0] as Record<string, unknown>;
      expect(arg['content']).toBe(phoneBody);
      expect(arg['recipientTier']).toBe('trusted');
      // The resolved contact, keyed by recipient, for a reply-to-task link's counterparty check.
      expect(arg['recipientContactIds']).toEqual({ [String(phoneReq.to).toLowerCase()]: 'joel-1' });
      expect(arg['subject']).toBe(`Re: ${phone}`);
      expect(arg['detectedItems']).toEqual([
        { id: 'P1', label: 'phone_us', text: phone, field: 'body' },
        { id: 'P2', label: 'phone_us', text: phone, field: 'subject' },
        { id: 'P3', label: 'phone_us', text: phone, field: 'quote' },
      ]);
      // The authorized subject goes out as written.
      expect(sentEmail().subject).toBe(`Re: ${phone}`);
    });

    // Quoted history is not a disclosure to people already on it (#2312).
    describe('the quoted message', () => {
      // The sender's own signature phone, quoted back.
      const QUOTED = phone;
      const quote = `<blockquote>Reach me at ${QUOTED}.</blockquote>`;
      const reply = { channel: 'email' as const, to: 'joel@example.com', subject: 'Re: Forms', body: 'Thanks, got it.', htmlQuote: quote, replyToMessageId: 'msg-orig' };
      const detected = (review: ReturnType<typeof vi.fn>) => (review.mock.calls[0]![0] as { detectedItems?: unknown }).detectedItems;
      // The gateway confirms the exemption from the message the reply answers, never the caller's list.
      const original = (to: string[] = ['curia@example.com'], cc: string[] = []) => {
        const getMessage = vi.fn().mockResolvedValue({ from: [{ email: 'joel@example.com' }], to: to.map((email) => ({ email })), cc: cc.map((email) => ({ email })) });
        (mocks.nylasClient as unknown as Record<string, unknown>).getMessage = getMessage;
        return getMessage;
      };
      beforeEach(() => { original(); });

      it('is reviewed when the caller claims participants the quoted message does not have', async () => {
        const getMessage = original();
        const review = vi.fn().mockResolvedValue({ kind: 'send' });
        const { gateway } = await makePiiGateway({ review });
        await gateway.send({ ...reply, cc: ['newcomer@example.com'], quoteParticipants: ['joel@example.com', 'newcomer@example.com'] }, { taskEventId: 't1' });
        expect(getMessage).toHaveBeenCalledWith('msg-orig');
        expect(detected(review)).toEqual([{ id: 'P1', label: 'phone_us', text: QUOTED, field: 'quote' }]);
      });

      it('is reviewed when the quoted message cannot be fetched, or the reply names none', async () => {
        for (const req of [reply, { ...reply, replyToMessageId: undefined }]) {
          (mocks.nylasClient as unknown as Record<string, unknown>).getMessage = vi.fn().mockRejectedValue(new Error('Nylas down'));
          const review = vi.fn().mockResolvedValue({ kind: 'send' });
          const { gateway } = await makePiiGateway({ review });
          await gateway.send({ ...req, quoteParticipants: ['joel@example.com'] }, { taskEventId: 't1' });
          expect(detected(review)).toEqual([{ id: 'P1', label: 'phone_us', text: QUOTED, field: 'quote' }]);
        }
      });

      it('is not reviewed when every recipient was on the quoted message, and is sent', async () => {
        const review = vi.fn().mockResolvedValue({ kind: 'send' });
        const { gateway } = await makePiiGateway({ review });
        const result = await gateway.send(
          { ...reply, cc: ['Principal@Example.com'], quoteParticipants: ['joel@example.com', 'curia@example.com'] },
          { taskEventId: 't1', postTurn: true },
        );
        expect(result.success).toBe(true);
        expect(detected(review)).toBeUndefined();
        expect(sentEmail().body).toContain(QUOTED);
      });

      it('is left out of a held reply\'s fallback draft that reaches a newcomer, so an approved draft cannot carry it', async () => {
        const createDraft = vi.fn().mockResolvedValue({ id: 'draft-1', subject: 'Re: Forms', body: 'x' });
        (mocks.nylasClient as unknown as Record<string, unknown>).createDraft = createDraft;
        const { gateway } = await makePiiGateway({ review: vi.fn() });
        await gateway.createEmailDraft({ ...reply, cc: ['newcomer@example.com'], quoteParticipants: ['joel@example.com'] });
        expect(JSON.stringify(createDraft.mock.calls[0]![0])).not.toContain(QUOTED);

        createDraft.mockClear();
        await gateway.createEmailDraft({ ...reply, quoteParticipants: ['joel@example.com'] });
        expect(JSON.stringify(createDraft.mock.calls[0]![0])).toContain(QUOTED);
      });

      it('stays on an approved replay when every recipient was on the quoted message, and goes otherwise', async () => {
        const { gateway } = await makePiiGateway({ review: vi.fn() });
        await gateway.send({ ...reply, quoteParticipants: ['joel@example.com'] }, { humanApproved: true });
        expect(sentEmail().body).toContain(QUOTED);

        vi.mocked(mocks.nylasClient.sendMessage).mockClear();
        await gateway.send({ ...reply, cc: ['newcomer@example.com'], quoteParticipants: ['joel@example.com'] }, { humanApproved: true });
        expect(sentEmail().body).not.toContain(QUOTED);
      });

      it('is reviewed when a recipient was not on it, or nobody recorded who was', async () => {
        for (const req of [
          { ...reply, cc: ['newcomer@example.com'], quoteParticipants: ['joel@example.com'] },
          reply,
        ]) {
          vi.mocked(mocks.nylasClient.sendMessage).mockClear();
          const review = vi.fn().mockResolvedValue({ kind: 'send' });
          const { gateway } = await makePiiGateway({ review });
          await gateway.send(req, { taskEventId: 't1' });
          expect(detected(review)).toEqual([{ id: 'P1', label: 'phone_us', text: QUOTED, field: 'quote' }]);
          expect(sentEmail().body).toContain(QUOTED);
        }
      });

      it('is dropped when the review says so, leaving the agent\'s text', async () => {
        const review = vi.fn().mockResolvedValue({ kind: 'send', dropQuote: { labels: ['phone_us'] } });
        const { gateway } = await makePiiGateway({ review });
        const result = await gateway.send({ ...reply, to: 'stranger@example.com', quoteParticipants: ['joel@example.com'] }, { taskEventId: 't1' });
        expect(result.success).toBe(true);
        expect(sentEmail().body).toContain('Thanks, got it.');
        expect(sentEmail().body).not.toContain(QUOTED);
        expect(sentEmail().body).not.toContain('<blockquote>');
      });
    });

    it('keeps raw values out of the outbound.blocked event on a bounce', async () => {
      const findings = [{ rule: 'pii-not-authorized', detail: 'P1 phone_us was not authorized.' }];
      const { gateway } = await makePiiGateway({ review: vi.fn().mockResolvedValue({ kind: 'bounce', findings }) });
      const result = await gateway.send(phoneReq, { taskEventId: 't1' });

      expect(result.success).toBe(false);
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
      const blocked = publishedOfType(mocks.bus, 'outbound.blocked');
      expect(blocked).toHaveLength(1);
      expect(String(blocked[0]!.payload['content'])).not.toContain('555-1234');
      expect(String(blocked[0]!.payload['content'])).toContain('[REDACTED: PHONE_US]');
    });

    it('redacts the flushed audit event of a band-queued row even after a switch to tier gating', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const enqueue = vi.fn().mockResolvedValue({ id: 'q-1' });
      const outboundQueue = {
        enqueue,
        listPending: vi.fn().mockImplementation(async () => [{
          id: 'q-1', channel: 'email', recipient: 'joel@example.com', payload: enqueue.mock.calls[0]![0],
          enqueuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
        }]),
        deleteByIds: vi.fn().mockResolvedValue(undefined),
      } as unknown as OutboundQueueRepo;
      const { gateway: band } = await makePiiGateway({ review, outboundQueue });
      expect((await band.send(phoneReq, { taskEventId: 't1' })).queued).toBe(true);
      expect((enqueue.mock.calls[0]![0] as { body: string }).body).toContain(phone);

      // Restarted with tier gating while the raw row is still queued.
      const { gateway: tier } = await makePiiGateway({ review, outboundQueue, gating: 'tier', emailReady: () => true });
      await tier.flushChannel('email');
      expect(sentEmail().body).toContain(phone);
      const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
      expect(delivered).toHaveLength(1);
      expect(String(delivered[0]!.payload['content'])).not.toContain('555-1234');
    });

    it('blocks with pii_redactor_error when detection throws', async () => {
      const review = vi.fn();
      const piiRedactor = {
        detect: vi.fn().mockImplementation(() => { throw new Error('pattern engine crashed'); }),
        apply: vi.fn(),
        redact: vi.fn(),
      } as unknown as PiiRedactor;
      const { gateway } = await makePiiGateway({ review, piiRedactor });
      const result = await gateway.send(phoneReq, { taskEventId: 't1' });

      expect(result).toMatchObject({ success: false, blockedReason: expect.stringContaining('pii_redactor_error') });
      expect(review).not.toHaveBeenCalled();
      expect(mocks.nylasClient.sendMessage).not.toHaveBeenCalled();
      const blocked = publishedOfType(mocks.bus, 'outbound.blocked');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]!.payload['reason']).toBe('pii_redactor_error');
      expect(String(blocked[0]!.payload['content'])).not.toContain('555-1234');
    });

    it('redacts a system notification as tier does', async () => {
      const review = vi.fn();
      const { gateway } = await makePiiGateway({ review });
      await gateway.send(phoneReq, { isSystemNotification: true });

      expect(review).not.toHaveBeenCalled();
      expect(sentEmail().body).toContain('[REDACTED: PHONE_US]');
      expect(sentEmail().body).not.toContain('555-1234');
    });

    it('sends an approved replay intact, without review', async () => {
      const review = vi.fn();
      const { gateway } = await makePiiGateway({ review });
      const result = await gateway.send({ ...phoneReq, subject: `Re: ${phone}` }, { humanApproved: true });

      expect(result.success).toBe(true);
      expect(review).not.toHaveBeenCalled();
      expect(sentEmail().body).toContain(phone);
      expect(sentEmail().subject).toBe(`Re: ${phone}`);
      expect(publishedOfType(mocks.bus, 'outbound.pii_redacted')).toHaveLength(0);
      // The audit event still never carries the value.
      const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
      expect(delivered).toHaveLength(1);
      expect(String(delivered[0]!.payload['content'])).toContain('[REDACTED: PHONE_US]');
      expect(String(delivered[0]!.payload['content'])).not.toContain('555-1234');
    });

    it('gives the content filter and its block event a redacted copy of an approved replay', async () => {
      const { gateway } = await makePiiGateway({ review: vi.fn() });
      vi.mocked(mocks.contentFilter.check).mockResolvedValueOnce({ passed: false, findings: [{ rule: 'llm-judge-audience-leak', detail: 'x' }] });
      const result = await gateway.send(phoneReq, { humanApproved: true });

      expect(result.success).toBe(false);
      expect(mocks.contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({ content: 'Call me on [REDACTED: PHONE_US] tomorrow.' }));
      const blocked = publishedOfType(mocks.bus, 'outbound.blocked');
      expect(blocked).toHaveLength(1);
      expect(String(blocked[0]!.payload['content'])).not.toContain('555-1234');
    });

    it('sends an approved reply without its quote when the quote has details the approval did not show', async () => {
      const { gateway } = await makePiiGateway({ review: vi.fn() });
      const result = await gateway.send({ ...phoneReq, body: 'See below.', htmlQuote: '<blockquote>My SIN is 130 692 544</blockquote>' }, { humanApproved: true });

      expect(result.success).toBe(true);
      expect(sentEmail().body).not.toContain('130 692 544');
      expect(sentEmail().body).not.toContain('blockquote');
    });

    it('keeps an approved reply\'s quote when it has no personal details', async () => {
      const { gateway } = await makePiiGateway({ review: vi.fn() });
      await gateway.send({ ...phoneReq, body: 'See below.', htmlQuote: '<blockquote>Thanks for the update.</blockquote>' }, { humanApproved: true });
      expect(sentEmail().body).toContain('Thanks for the update.');
    });

    it('sends an approved Signal replay intact, with a redacted audit event', async () => {
      const review = vi.fn();
      const { gateway, signalClient } = await makePiiGateway({ review, withSignal: true });
      const result = await gateway.send({ channel: 'signal', recipient: '+15555552222', message: phoneBody }, { humanApproved: true });

      expect(result.success).toBe(true);
      expect(review).not.toHaveBeenCalled();
      expect(JSON.stringify(signalClient.send.mock.calls)).toContain(phone);
      const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
      expect(delivered).toHaveLength(1);
      expect(String(delivered[0]!.payload['content'])).toBe('Call me on [REDACTED: PHONE_US] tomorrow.');
    });

    it('still redacts under tier gating', async () => {
      const review = vi.fn();
      const { gateway } = await makePiiGateway({ review, gating: 'tier' });
      const result = await gateway.send(phoneReq, { taskEventId: 't1' });

      expect(review).not.toHaveBeenCalled();
      expect(sentEmail().body).toContain('[REDACTED: PHONE_US]');
      expect(sentEmail().body).not.toContain('555-1234');
      expect(result.redactions).toEqual([{ label: 'phone_us', field: 'body' }]);
    });

    describe('saved drafts (#2312)', () => {
      const phoneDraft = { recipientEmail: 'joel@example.com', body: phoneBody, subject: 'Forms' };
      const holdRecipe = { toolName: 'send-draft', partialPayload: { draft_id: 'd1', subject: 'Forms', body: phoneBody }, description: 'Send draft to joel@example.com' };

      function draftSender(): ReturnType<typeof vi.fn> {
        const sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
        (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = sendDraft;
        return sendDraft;
      }

      it('sends a draft whose details the review authorizes, with a redacted filter copy and audit', async () => {
        const sendDraft = draftSender();
        const review = vi.fn().mockResolvedValue({ kind: 'send' });
        const { gateway } = await makePiiGateway({ review });
        const result = await gateway.sendEmailDraft('d1', 'curia', { ...phoneDraft, subject: `Re: ${phone}` }, { humanApproved: true, taskEventId: 't1' });

        expect(result.success).toBe(true);
        expect(sendDraft).toHaveBeenCalledWith('d1');
        const arg = review.mock.calls[0]![0] as Record<string, unknown>;
        expect(arg['content']).toBe(phoneBody);
        expect(arg['subject']).toBe(`Re: ${phone}`);
        expect(arg['detectedItems']).toEqual([
          { id: 'P1', label: 'phone_us', text: phone, field: 'body' },
          { id: 'P2', label: 'phone_us', text: phone, field: 'subject' },
        ]);
        expect(mocks.contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({ content: 'Call me on [REDACTED: PHONE_US] tomorrow.' }));
        const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
        expect(delivered).toHaveLength(1);
        expect(String(delivered[0]!.payload['content'])).toBe('Call me on [REDACTED: PHONE_US] tomorrow.');
        expect(publishedOfType(mocks.bus, 'outbound.pii_redacted')).toHaveLength(0);
      });

      // One delivery contract with send() (#2333): the sent message's thread.
      it('returns and publishes the sent draft\'s thread', async () => {
        const sendDraft = draftSender();
        sendDraft.mockResolvedValue({ id: 'sent-1', threadId: 'thread-1' });
        const { gateway } = await makePiiGateway({ review: vi.fn().mockResolvedValue({ kind: 'send' }) });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, taskEventId: 't1' });
        expect(result).toMatchObject({ success: true, messageId: 'sent-1', threadId: 'thread-1' });
        expect(publishedOfType(mocks.bus, 'outbound.delivered')[0]!.payload).toMatchObject({ messageId: 'sent-1', threadId: 'thread-1' });
      });

      it('holds a draft the review bounces: it cannot be rewritten in place', async () => {
        const sendDraft = draftSender();
        const findings = [{ rule: 'pii-not-authorized', detail: 'P1 phone_us was not authorized.' }];
        const { gateway } = await makePiiGateway({ review: vi.fn().mockResolvedValue({ kind: 'bounce', findings }) });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, taskEventId: 't1', holdRecipe });

        expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.any(String) });
        expect(result.blockedReason).not.toContain('555-1234');
        expect(sendDraft).not.toHaveBeenCalled();
        expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
      });

      // A personal-details bounce outranks a steering hold, which then rides along (#2333).
      it('keeps the steering warning when it holds a bounced draft the review also ruled steered', async () => {
        const sendDraft = draftSender();
        const steered = 'Held for the principal: the reviewer judged this send to be steered by someone outside the principal\'s business.';
        const { gateway } = await makePiiGateway({
          review: vi.fn().mockResolvedValue({
            kind: 'bounce',
            findings: [{ rule: 'pii-not-authorized', detail: 'P1 phone_us was not authorized.' }],
            heldBeside: [{ rule: 'steered', detail: steered }],
          }),
        });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, taskEventId: 't1', holdRecipe });

        expect(result).toMatchObject({ success: false, gated: true, actionRef: expect.any(String) });
        expect(result.blockedReason).toContain('(pii-not-authorized, steered)');
        expect(result.blockedReason).toContain('Also, the reviewer judged this send to be steered');
        expect(sendDraft).not.toHaveBeenCalled();
      });

      it('reviews a principal-directed draft that holds personal details', async () => {
        draftSender();
        const review = vi.fn().mockResolvedValue({ kind: 'send' });
        const { gateway } = await makePiiGateway({ review });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, principalDirected: true, taskEventId: 't1' });

        expect(result.success).toBe(true);
        expect(review).toHaveBeenCalledWith(expect.objectContaining({
          principalDirected: true,
          detectedItems: [{ id: 'P1', label: 'phone_us', text: phone, field: 'body' }],
        }));
      });

      it('sends a draft the principal approved intact, without review, with a redacted audit', async () => {
        const sendDraft = draftSender();
        const review = vi.fn();
        const { gateway } = await makePiiGateway({ review });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, principalApproved: true, taskEventId: 't1' });

        expect(result.success).toBe(true);
        expect(review).not.toHaveBeenCalled();
        expect(sendDraft).toHaveBeenCalledWith('d1');
        const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
        expect(String(delivered[0]!.payload['content'])).toBe('Call me on [REDACTED: PHONE_US] tomorrow.');
      });

      it('gives the content filter and its block event a redacted copy of an approved draft', async () => {
        const sendDraft = draftSender();
        const { gateway } = await makePiiGateway({ review: vi.fn() });
        vi.mocked(mocks.contentFilter.check).mockResolvedValueOnce({ passed: false, findings: [{ rule: 'llm-judge-audience-leak', detail: 'x' }] });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, principalApproved: true, taskEventId: 't1' });

        expect(result.success).toBe(false);
        expect(sendDraft).not.toHaveBeenCalled();
        expect(mocks.contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({ content: 'Call me on [REDACTED: PHONE_US] tomorrow.' }));
        const blocked = publishedOfType(mocks.bus, 'outbound.blocked');
        expect(String(blocked[0]!.payload['content'])).not.toContain('555-1234');
      });

      it('refuses a draft with details under tier gating: it cannot be redacted in place', async () => {
        const sendDraft = draftSender();
        const review = vi.fn();
        const { gateway } = await makePiiGateway({ review, gating: 'tier' });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, taskEventId: 't1' });

        expect(result).toEqual({
          success: false,
          blockedReason: 'Not sent: this draft contains phone_us, which can\'t be sent to this recipient. Edit the draft to remove them, or ask the principal.',
        });
        expect(sendDraft).not.toHaveBeenCalled();
        expect(review).not.toHaveBeenCalled();
      });

      it('sends a tier draft the principal approved, and one to the principal alone', async () => {
        const sendDraft = draftSender();
        const { gateway } = await makePiiGateway({ review: vi.fn(), gating: 'tier' });
        const approved = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, principalApproved: true, taskEventId: 't1' });
        const toPrincipal = await gateway.sendEmailDraft('d2', 'curia', { ...phoneDraft, recipientEmail: 'principal@example.com' }, { humanApproved: true, taskEventId: 't1' });

        expect(approved.success).toBe(true);
        expect(toPrincipal.success).toBe(true);
        expect(sendDraft.mock.calls).toEqual([['d1'], ['d2']]);
      });

      it('sends a principal-directed tier draft with details as written, and refuses a woken task\'s', async () => {
        const sendDraft = draftSender();
        const { gateway } = await makePiiGateway({ review: vi.fn(), gating: 'tier' });
        // A live principal turn (or an approval replay): the principal is in the loop.
        const directed = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, principalDirected: true, taskEventId: 't1' });
        expect(directed.success).toBe(true);
        expect(sendDraft.mock.calls).toEqual([['d1']]);
        const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
        expect(String(delivered[0]!.payload['content'])).toBe('Call me on [REDACTED: PHONE_US] tomorrow.');

        // A woken task: send-draft sets humanApproved, but not principalDirected.
        const woken = await gateway.sendEmailDraft('d2', 'curia', phoneDraft, { humanApproved: true, principalDirected: false, taskEventId: 't2' });
        expect(woken).toMatchObject({ success: false, blockedReason: expect.stringContaining('phone_us') });
        expect(sendDraft.mock.calls).toEqual([['d1']]);
      });

      it('refuses a draft with details under band gating with no review wired, even principal-directed', async () => {
        const sendDraft = draftSender();
        const { gateway } = await makePiiGateway({ review: vi.fn(), noReview: true });
        for (const principalDirected of [false, true]) {
          const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, principalDirected, taskEventId: 't1' });
          expect(result).toMatchObject({ success: false, blockedReason: expect.stringContaining('phone_us') });
          expect(result.blockedReason).not.toContain('555-1234');
        }
        expect(sendDraft).not.toHaveBeenCalled();
      });

      it('blocks a draft when detection throws: nothing sent, the blocked event scrubbed', async () => {
        const sendDraft = draftSender();
        const review = vi.fn();
        const piiRedactor = {
          detect: vi.fn().mockImplementation(() => { throw new Error('pattern engine crashed'); }),
          apply: vi.fn(),
          redact: vi.fn(),
        } as unknown as PiiRedactor;
        const { gateway } = await makePiiGateway({ review, piiRedactor });
        const result = await gateway.sendEmailDraft('d1', 'curia', phoneDraft, { humanApproved: true, taskEventId: 't1' });

        expect(result).toMatchObject({ success: false, blockedReason: expect.stringContaining('pii_redactor_error') });
        expect(sendDraft).not.toHaveBeenCalled();
        expect(review).not.toHaveBeenCalled();
        const blocked = publishedOfType(mocks.bus, 'outbound.blocked');
        expect(blocked).toHaveLength(1);
        expect(String(blocked[0]!.payload['content'])).not.toContain('555-1234');
      });

      it('sends a draft without details unchanged under tier and band', async () => {
        const plain = { recipientEmail: 'joel@example.com', body: 'See you at the meeting tomorrow.', subject: 'Forms' };
        for (const gating of ['tier', 'band'] as const) {
          const sendDraft = draftSender();
          const review = vi.fn().mockResolvedValue({ kind: 'send' });
          const { gateway } = await makePiiGateway({ review, gating });
          const result = await gateway.sendEmailDraft('d1', 'curia', plain, { humanApproved: true, taskEventId: 't1' });

          expect(result.success).toBe(true);
          expect(sendDraft).toHaveBeenCalledWith('d1');
          expect(mocks.contentFilter.check).toHaveBeenLastCalledWith(expect.objectContaining({ content: plain.body }));
          const delivered = publishedOfType(mocks.bus, 'outbound.delivered');
          expect(String(delivered[delivered.length - 1]!.payload['content'])).toBe(plain.body);
          // Band still reviews it as any autonomous send, with no items to rule on.
          if (gating === 'band') {
            expect(review).toHaveBeenCalledTimes(1);
            expect((review.mock.calls[0]![0] as Record<string, unknown>)['detectedItems']).toBeUndefined();
          } else {
            expect(review).not.toHaveBeenCalled();
          }
        }
      });

      it('records an approved draft for spot checks with a redacted preview', async () => {
        draftSender();
        const actionLogRepo = makeActionLogRepo();
        const { gateway } = await makePiiGateway({ review: vi.fn(), actionLogRepo });
        const result = await gateway.sendEmailDraft('d1', 'curia', { ...phoneDraft, subject: `Re: ${phone}` }, { humanApproved: true, principalApproved: true, taskEventId: 't1' });

        expect(result.success).toBe(true);
        expect(actionLogRepo.insertSampled).toHaveBeenCalledTimes(1);
        const summary = String((vi.mocked(actionLogRepo.insertSampled).mock.calls[0]![0] as { summary: string }).summary);
        expect(summary).toContain('[REDACTED: PHONE_US]');
        expect(summary).not.toContain('555-1234');
      });
    });
  });

  describe('sendEmailDraft', () => {
    const draftMeta = { recipientEmail: 'joel@example.com', body: 'Hi Joel. I am out of office until the 13th.', subject: 'Forms' };

    function withDraftClient() {
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
    }

    it('reviews an autonomous draft send and bounces it', async () => {
      withDraftClient();
      const findings = [{ rule: 'ungrounded-claim', detail: 'not backed: "I am out of office until the 13th."' }];
      const review = vi.fn().mockResolvedValue({ kind: 'bounce', findings });
      const gw = makeBandGateway({ review, score: 84 });
      const result = await gw.sendEmailDraft('d1', 'curia', draftMeta, { taskEventId: 't1', conversationId: 'c1' });
      expect(result).toMatchObject({ success: false, blockedRules: ['ungrounded-claim'] });
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ content: draftMeta.body, channel: 'email', score: 84 }));
      expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(1);
    });

    it('refuses a blocked draft send, with the digest told and nothing sent', async () => {
      withDraftClient();
      const findings = [{ rule: 'unneeded-disclosure', detail: 'shares details: "x"' }];
      const review = vi.fn().mockResolvedValue({ kind: 'block', reason: 'Not sent: x', findings });
      const gw = makeBandGateway({ review, score: 84 });
      const result = await gw.sendEmailDraft('d1', 'curia', draftMeta, { taskEventId: 't1' });
      expect(result).toMatchObject({ success: false, blockedRules: ['unneeded-disclosure'] });
      expect(publishedOfType(mocks.bus, 'principal.report')).toHaveLength(1);
      expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
      expect((mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft).not.toHaveBeenCalled();
    });

    it('holds a draft through its holdRecipe, as before', async () => {
      withDraftClient();
      const review = vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held.', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] });
      const gw = makeBandGateway({ review, score: 74 });
      const result = await gw.sendEmailDraft('d1', 'curia', draftMeta, {
        taskEventId: 't1', holdRecipe: { toolName: 'send-draft', partialPayload: { draft_id: 'd1' }, description: 'Send draft to joel@example.com' },
      });
      expect(result).toMatchObject({ success: false, gated: true });
      expect(publishedOfType(mocks.bus, 'outbound.blocked')).toHaveLength(0);
      expect((mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft).not.toHaveBeenCalled();
    });

    it('does not review a draft to Curia\'s own address with the principal CC\'d', async () => {
      withDraftClient();
      const review = vi.fn();
      const gw = makeBandGateway({ review, score: 84, emailAccountAddresses: new Map([['curia', 'curia@example.com']]) });
      const result = await gw.sendEmailDraft('d1', 'curia', {
        ...draftMeta, recipientEmail: 'curia@example.com', allRecipients: ['curia@example.com', 'principal@example.com'],
      }, { taskEventId: 't1' });
      expect(result.success).toBe(true);
      expect(review).not.toHaveBeenCalled();
    });

    it('reviews a draft addressed only to Curia\'s own address with no outside audience', async () => {
      withDraftClient();
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84, emailAccountAddresses: new Map([['curia', 'curia@example.com']]) });
      const result = await gw.sendEmailDraft('d1', 'curia', {
        ...draftMeta, recipientEmail: 'curia@example.com', allRecipients: ['curia@example.com'],
      }, { taskEventId: 't1' });
      expect(result.success).toBe(true);
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ recipients: [], principalRecipients: [] }));
    });

    it('sends a draft the review passes', async () => {
      withDraftClient();
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84 });
      const result = await gw.sendEmailDraft('d1', 'curia', draftMeta, { taskEventId: 't1' });
      expect(result.success).toBe(true);
    });

    it('skips the review when the principal directed this draft send', async () => {
      withDraftClient();
      const review = vi.fn();
      const gw = makeBandGateway({ review, score: 84 });
      await gw.sendEmailDraft('d1', 'curia', draftMeta, { humanApproved: true, principalDirected: true });
      expect(review).not.toHaveBeenCalled();
    });

    it('reviews a draft a woken task sends, though send-draft always marks it humanApproved', async () => {
      // send-draft passes humanApproved on every call (its own task-origin check is the
      // gate), so humanApproved does not mean the principal read this draft.
      withDraftClient();
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const gw = makeBandGateway({ review, score: 84 });
      await gw.sendEmailDraft('d1', 'curia', draftMeta, { humanApproved: true, principalDirected: false, taskEventId: 't1' });
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ principalDirected: false }));
    });
  });
});

describe('spot-check pool (#2159 Phase 3)', () => {
  let mocks: ReturnType<typeof createMocks>;
  beforeEach(() => {
    mocks = createMocks();
  });

  const danaReq = { channel: 'email' as const, to: 'dana@example.com', subject: 'Payment schedule', body: 'Hi Dana. The schedule is attached.' };

  function makePoolGateway(opts: {
    actionLogRepo?: ActionLogRepo;
    review?: ReturnType<typeof vi.fn>;
    outboundQueue?: OutboundQueueRepo;
  } = {}) {
    return new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [makePrincipalIdentity('principal@example.com')],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(85),
      actionLogRepo: opts.actionLogRepo ?? makeActionLogRepo(),
      ...(opts.review
        ? { gating: 'band' as const, bandReview: { review: opts.review as unknown as BandSendReview['review'] } }
        : {}),
      ...(opts.outboundQueue
        ? { outboundQueue: opts.outboundQueue, outboundQueueReadiness: new Map([['email', () => false]]) }
        : {}),
    });
  }

  function sampledRows(repo: ActionLogRepo): Array<Record<string, unknown>> {
    return vi.mocked(repo.insertSampled).mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);
  }

  it('records an autonomous email send to a first contact', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gw = makePoolGateway({ actionLogRepo });
    const result = await gw.send(danaReq, { taskEventId: 't1', conversationId: 'c1' });
    expect(result.success).toBe(true);
    expect(sampledRows(actionLogRepo)).toEqual([{
      taskId: 't1',
      conversationId: 'c1',
      toolName: 'email-send',
      actionRisk: 'medium',
      summary: 'Emailed dana@example.com: "Payment schedule"',
      signals: { firstContact: true },
    }]);
  });

  it('uses the calling skill as the tool name, and no firstContact for a known contact', async () => {
    vi.mocked(mocks.contactService.resolveByChannelIdentity).mockResolvedValue({
      contactId: 'contact-dana', displayName: 'Dana', role: null, tier: 'known', kind: 'person', kgNodeId: null, verified: true,
    } as unknown as Awaited<ReturnType<ContactService['resolveByChannelIdentity']>>);
    // A long-standing contact: created a month ago.
    (mocks.contactService as unknown as { getContact: ReturnType<typeof vi.fn> }).getContact = vi.fn().mockResolvedValue({
      id: 'contact-dana', createdAt: new Date(Date.now() - 30 * 86_400_000),
    });
    const actionLogRepo = makeActionLogRepo();
    const gw = makePoolGateway({ actionLogRepo });
    await gw.send(danaReq, { taskEventId: 't1', exportContext: { toolName: 'email-reply' } });
    expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({ toolName: 'email-reply', signals: {} })]);
  });

  // firstContact (#2159 Phase 3 review): send skills address recipients by contact UUID
  // (ADR-047), so a first-time recipient already HAS a contact, created moments before by
  // contact-create. The signal is "the contact is new", not "there is no contact".
  describe('firstContact', () => {
    const HOUR = 3_600_000;
    function withContactCreated(msAgo: number) {
      vi.mocked(mocks.contactService.resolveByChannelIdentity).mockResolvedValue({
        contactId: 'contact-dana', displayName: 'Dana', role: null, tier: 'known', kind: 'person', kgNodeId: null, verified: true,
      } as unknown as Awaited<ReturnType<ContactService['resolveByChannelIdentity']>>);
      (mocks.contactService as unknown as { getContact: ReturnType<typeof vi.fn> }).getContact = vi.fn().mockResolvedValue({
        id: 'contact-dana', createdAt: new Date(Date.now() - msAgo),
      });
    }

    it('is true for a contact created an hour ago', async () => {
      withContactCreated(HOUR);
      const actionLogRepo = makeActionLogRepo();
      await makePoolGateway({ actionLogRepo }).send(danaReq, { taskEventId: 't1' });
      expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({ signals: { firstContact: true } })]);
      expect((mocks.contactService as unknown as { getContact: ReturnType<typeof vi.fn> }).getContact).toHaveBeenCalledWith('contact-dana');
    });

    it('is false for a contact created ten days ago', async () => {
      withContactCreated(10 * 24 * HOUR);
      const actionLogRepo = makeActionLogRepo();
      await makePoolGateway({ actionLogRepo }).send(danaReq, { taskEventId: 't1' });
      expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({ signals: {} })]);
    });

    it('is false for a Signal group, which no contact stands for', async () => {
      const signalClient = { send: vi.fn().mockResolvedValue({ timestamp: 1 }), isConnected: () => true };
      const actionLogRepo = makeActionLogRepo();
      const gw = new OutboundGateway({
        signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
        signalPhoneNumber: '+15555550000',
        contactService: mocks.contactService, contentFilter: mocks.contentFilter, bus: mocks.bus, logger: mocks.logger,
        actionLogRepo,
      });
      const result = await gw.send({ channel: 'signal', groupId: 'group-abc', message: 'Agenda attached.' }, { taskEventId: 't1' });
      expect(result.success).toBe(true);
      expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({ signals: {} })]);
    });

    it('is false, with a warning, when the contact lookup throws', async () => {
      const warn = vi.fn();
      const child = { ...mocks.logger, warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
      mocks.logger = { ...mocks.logger, child: () => child } as unknown as typeof mocks.logger;
      withContactCreated(HOUR);
      (mocks.contactService as unknown as { getContact: ReturnType<typeof vi.fn> }).getContact = vi.fn().mockRejectedValue(new Error('db down'));
      const actionLogRepo = makeActionLogRepo();
      await makePoolGateway({ actionLogRepo }).send(danaReq, { taskEventId: 't1' });
      expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({ signals: {} })]);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'contact-dana' }), expect.stringContaining('first contact'));
    });

    it('is false when resolving the recipient failed outright', async () => {
      vi.mocked(mocks.contactService.resolveByChannelIdentity).mockRejectedValue(new Error('db down'));
      const actionLogRepo = makeActionLogRepo();
      await makePoolGateway({ actionLogRepo }).send(danaReq, { taskEventId: 't1' });
      expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({ signals: {} })]);
    });

    it('applies to a draft send too', async () => {
      withContactCreated(HOUR);
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
      const actionLogRepo = makeActionLogRepo();
      await makePoolGateway({ actionLogRepo }).sendEmailDraft(
        'd1', 'curia', { recipientEmail: 'dana@example.com', body: 'Hi Dana.', subject: 'Payment schedule' },
        { humanApproved: true, principalDirected: false, taskEventId: 't1' },
      );
      expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({ toolName: 'send-draft', signals: { firstContact: true } })]);
    });
  });

  it('records nothing for system notices, approved, principal-directed, principal-only or queued sends', async () => {
    const actionLogRepo = makeActionLogRepo();
    const gw = makePoolGateway({ actionLogRepo });
    await gw.send(danaReq, { taskEventId: 't1', isSystemNotification: true });
    await gw.send(danaReq, { taskEventId: 't1', humanApproved: true });
    await gw.send(danaReq, { taskEventId: 't1', principalDirected: true });
    await gw.send({ ...danaReq, to: 'principal@example.com' }, { taskEventId: 't1' });
    expect(actionLogRepo.insertSampled).not.toHaveBeenCalled();

    const outboundQueue = {
      enqueue: vi.fn().mockResolvedValue({ id: 'q-1' }),
      listPending: vi.fn(), deleteByIds: vi.fn(), deleteExpired: vi.fn(), countPending: vi.fn(),
    } as unknown as OutboundQueueRepo;
    const queuedRepo = makeActionLogRepo();
    const queuedGw = makePoolGateway({ actionLogRepo: queuedRepo, outboundQueue });
    const queued = await queuedGw.send(danaReq, { taskEventId: 't1' });
    expect(queued.queued).toBe(true);
    expect(queuedRepo.insertSampled).not.toHaveBeenCalled();
  });

  it('records the band review outcome: unreviewed, speaks as principal', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ kind: 'send', report: { source: 'sent_without_review', summary: 'Sent unreviewed' } }, { review: 'unreviewed' }],
      [{ kind: 'send', signals: { speaksAsPrincipal: true } }, { speaksAsPrincipal: true }],
      [{ kind: 'send', signals: { bounced: true } }, { review: 'bounced' }],
    ];
    for (const [decision, expected] of cases) {
      const actionLogRepo = makeActionLogRepo();
      const gw = makePoolGateway({ actionLogRepo, review: vi.fn().mockResolvedValue(decision) });
      await gw.send(danaReq, { taskEventId: 't1' });
      expect(sampledRows(actionLogRepo)).toEqual([
        expect.objectContaining({ signals: { firstContact: true, ...expected } }),
      ]);
    }
  });

  it('still reports success, and logs an error with context, when the pool row cannot be written', async () => {
    const error = vi.fn();
    const child = { ...mocks.logger, warn: vi.fn(), info: vi.fn(), error, debug: vi.fn() };
    mocks.logger = { ...mocks.logger, child: () => child } as unknown as typeof mocks.logger;
    const actionLogRepo = makeActionLogRepo();
    // A pg error carries a SQLSTATE code; it is what tells a full disk from a bad column.
    vi.mocked(actionLogRepo.insertSampled).mockRejectedValue(Object.assign(new Error('db down'), { code: '53100' }));
    const gw = makePoolGateway({ actionLogRepo });
    const result = await gw.send(danaReq, { taskEventId: 't1', exportContext: { toolName: 'email-reply' } });
    expect(result.success).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', toolName: 'email-reply', taskEventId: 't1', code: '53100' }),
      expect.stringContaining('spot checks'),
    );
  });

  it('warns once, at construction, when no actionLogRepo is wired', async () => {
    const warn = vi.fn();
    const child = { ...mocks.logger, warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const spyLogger = { ...mocks.logger, child: () => child } as unknown as typeof mocks.logger;
    const gw = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService, contentFilter: mocks.contentFilter, bus: mocks.bus, logger: spyLogger,
    });
    const poolWarnings = () => warn.mock.calls.filter((c) => String(c[1]).includes('spot-check pool disabled: no actionLogRepo'));
    expect(poolWarnings()).toHaveLength(1);
    // Not per send.
    await gw.send(danaReq, { taskEventId: 't1' });
    await gw.send(danaReq, { taskEventId: 't2' });
    expect(poolWarnings()).toHaveLength(1);

    warn.mockClear();
    mocks.logger = spyLogger;
    makePoolGateway({ actionLogRepo: makeActionLogRepo() });
    expect(poolWarnings()).toHaveLength(0);
  });

  it('labels chat sends by channel with the first line of the message', async () => {
    const signalClient = { send: vi.fn().mockResolvedValue({ timestamp: 1 }), isConnected: () => true };
    const actionLogRepo = makeActionLogRepo();
    const gw = new OutboundGateway({
      signalClient: signalClient as unknown as import('../../../src/channels/signal/signal-rpc-client.js').SignalRpcClient,
      signalPhoneNumber: '+15555550000',
      contactService: mocks.contactService, contentFilter: mocks.contentFilter, bus: mocks.bus, logger: mocks.logger,
      actionLogRepo,
    });
    await gw.send({ channel: 'signal', recipient: '+15555550100', message: '\nRunning ten minutes late.\nSee you soon.' }, { taskEventId: 't1' });
    expect(sampledRows(actionLogRepo)).toEqual([
      expect.objectContaining({ toolName: 'signal-send', summary: 'Sent a Signal message to +15555550100: "Running ten minutes late."' }),
    ]);
  });

  describe('sendEmailDraft', () => {
    const draftMeta = { recipientEmail: 'dana@example.com', body: 'Hi Dana. The schedule is attached.', subject: 'Payment schedule' };
    function withDraftClient() {
      (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-1' });
    }

    it('records an autonomous draft send as send-draft', async () => {
      withDraftClient();
      const actionLogRepo = makeActionLogRepo();
      const gw = makePoolGateway({ actionLogRepo });
      // send-draft passes humanApproved on every call; it does not mean the principal read it.
      const result = await gw.sendEmailDraft('d1', 'curia', draftMeta, { humanApproved: true, principalDirected: false, taskEventId: 't1' });
      expect(result.success).toBe(true);
      expect(sampledRows(actionLogRepo)).toEqual([expect.objectContaining({
        taskId: 't1', toolName: 'send-draft', summary: 'Emailed dana@example.com: "Payment schedule"', signals: { firstContact: true },
      })]);
    });

    it('records nothing for a principal-directed draft send', async () => {
      withDraftClient();
      const actionLogRepo = makeActionLogRepo();
      const gw = makePoolGateway({ actionLogRepo });
      await gw.sendEmailDraft('d1', 'curia', draftMeta, { humanApproved: true, principalDirected: true, taskEventId: 't1' });
      expect(actionLogRepo.insertSampled).not.toHaveBeenCalled();
    });
  });
});

describe('principal own-identity lists skip defunct identities (R33 hardening, #2475)', () => {
  it('only active verified identities count as the principal\'s own', () => {
    const mocks = createMocks();
    const gw = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [
        makePrincipalIdentity('avery@example.com'),
        { ...makePrincipalIdentity('old@example.com'), id: 'pi-email-2', status: 'defunct' as never },
        { ...makePrincipalIdentity('bounced@example.com'), id: 'pi-email-3', status: 'bounced' as never },
        { ...makePrincipalIdentity('+14165550100', 'signal'), id: 'pi-signal-1' },
        { ...makePrincipalIdentity('+14165550199', 'signal'), id: 'pi-signal-2', status: 'defunct' as never },
      ],
      logger: mocks.logger,
    });
    const priv = gw as unknown as { principalEmailAddresses(): string[]; principalOwnIdentifiers(): string[] };
    expect(priv.principalEmailAddresses()).toEqual(['avery@example.com']);
    expect(priv.principalOwnIdentifiers()).toEqual(['avery@example.com', '+14165550100']);
  });
});

describe('sendPrincipalDraft (#2474)', () => {
  let mocks: ReturnType<typeof createMocks>;
  beforeEach(() => {
    mocks = createMocks();
  });

  const PRINCIPAL = 'avery@example.com';
  const PRINCIPAL_PHONE = '+14165550100';
  const live = { liveTurn: true, taskMetadata: { originator: { contactId: 'ceo-contact-id', systemRole: 'principal', channel: 'signal', initiatedAt: '2026-11-07T10:00:00.000Z' } } };
  const opts = { authority: live, taskEventId: 't1', conversationId: 'c1' };

  function draft(over: Partial<NylasMessage> = {}): NylasMessage {
    return {
      id: 'd1', threadId: 'th1', subject: 'Re: Friday', from: [{ email: PRINCIPAL }],
      to: [{ email: 'dana@example.org' }], cc: [], bcc: [],
      // Modified an hour ago: inside the provenance lookback, so no sign of Curia reads as the principal's.
      body: '<p>Friday works. See you then.</p>', snippet: '', date: Math.floor(Date.now() / 1000) - 3600, unread: false, folders: ['DRAFTS'], attachments: [],
      ...over,
    } as NylasMessage;
  }

  function mailboxClient(d: NylasMessage | null = draft()) {
    return {
      getDraft: vi.fn().mockResolvedValue(d),
      sendDraft: vi.fn().mockResolvedValue({ id: 'sent-1', threadId: 'th1' }),
      listMessages: vi.fn().mockResolvedValue([]),
    };
  }

  function make(o: {
    client?: ReturnType<typeof mailboxClient> | null;
    level?: 'off' | 'on_request' | 'routine' | 'all';
    createdByCuria?: string[] | Error;
    editedByCuria?: string[] | Error;
    review?: ReturnType<typeof vi.fn>;
    score?: number;
    piiRedactor?: PiiRedactor;
    actionLogRepo?: ActionLogRepo;
    ledger?: {
      recordSending: ReturnType<typeof vi.fn>; recordSent: ReturnType<typeof vi.fn>;
      recordHeld?: ReturnType<typeof vi.fn>; recentForThread?: ReturnType<typeof vi.fn>; recentForConversation?: ReturnType<typeof vi.fn>;
      recentAutonomousSends?: ReturnType<typeof vi.fn>; sentForDraft?: ReturnType<typeof vi.fn>;
      recordLimitStop?: ReturnType<typeof vi.fn>; limitStopsSince?: ReturnType<typeof vi.fn>;
    };
    /** What curiaWritesInTask returns (PR 2), or an error it throws. */
    curiaWrites?: { created: boolean; lastWriteAt: Date | null; replyToMessageId: string | null } | Error;
    gating?: 'band' | 'tier';
    withoutBandReview?: true;
    withoutLedger?: true;
    conversationEntities?: import('../../../src/entity-context/conversation-entities.js').ConversationEntityState;
    withoutProvenance?: true;
    /** Several principal mailboxes (#2475 Task 17): a client per id (null: none connected). */
    mailboxes?: Record<string, ReturnType<typeof mailboxClient> | null>;
    /** Per-mailbox send levels; a mailbox not listed reads `level`. */
    levels?: Record<string, 'off' | 'on_request' | 'routine' | 'all'>;
    /** The live mailbox ids the gateway may probe; absent: just the default. */
    mailboxIds?: () => Promise<string[]>;
    defaultMailboxId?: () => Promise<string>;
    /** Every principal address (#2475 Task 18), or an error the lookup throws; absent: not wired. */
    principalAddrs?: string[] | Error;
    /** Each mailbox's own address. */
    mailboxAddresses?: Record<string, string>;
    /** Each mailbox's label (#2475 Task 19). */
    mailboxLabels?: Record<string, string>;
  } = {}) {
    const client = o.client === undefined ? mailboxClient() : o.client;
    const review = o.review ?? vi.fn().mockResolvedValue({ kind: 'send' });
    const createdByCuria = vi.fn(async () => {
      if (o.createdByCuria instanceof Error) throw o.createdByCuria;
      return new Set((o.createdByCuria ?? []).map((id) => `default:${id}`));
    });
    const editedByCuria = vi.fn(async () => {
      if (o.editedByCuria instanceof Error) throw o.editedByCuria;
      return new Set((o.editedByCuria ?? []).map((id) => `default:${id}`));
    });
    const curiaWritesInTask = vi.fn(async () => {
      if (o.curiaWrites instanceof Error) throw o.curiaWrites;
      // Replying to m1, the autonomous tests' default latest message (final fixes A5).
      return o.curiaWrites ?? { created: true, lastWriteAt: new Date(), replyToMessageId: 'm1' };
    });
    const ledger = {
      recordHeld: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      recentForThread: vi.fn().mockResolvedValue([]),
      recentForConversation: vi.fn().mockResolvedValue([]),
      recentAutonomousSends: vi.fn().mockResolvedValue([]),
      sentForDraft: vi.fn().mockResolvedValue(false),
      recordLimitStop: vi.fn().mockResolvedValue(undefined),
      limitStopsSince: vi.fn().mockResolvedValue([]),
      ...(o.ledger ?? { recordSending: vi.fn().mockResolvedValue(undefined), recordSent: vi.fn().mockResolvedValue(undefined) }),
    };
    const resolveMailbox = vi.fn(async (id: string) => (o.mailboxes ? (o.mailboxes[id] ?? null) : client) as unknown as NylasClient | null);
    const readSendLevel = vi.fn(async (id: string) => o.levels?.[id] ?? o.level ?? 'on_request');
    const actionLogRepo = o.actionLogRepo ?? makeActionLogRepo();
    (mocks.contactService as unknown as { createContact: ReturnType<typeof vi.fn> }).createContact = vi.fn().mockResolvedValue({ id: 'new' });
    const gw = new OutboundGateway({
      nylasClients: new Map([['curia', mocks.nylasClient]]),
      contactService: mocks.contactService,
      contentFilter: mocks.contentFilter,
      bus: mocks.bus,
      principalIdentities: [
        makePrincipalIdentity(PRINCIPAL),
        { ...makePrincipalIdentity(PRINCIPAL_PHONE, 'signal'), id: 'pi-signal-1' },
      ],
      logger: mocks.logger,
      autonomyService: makeAutonomyService(o.score ?? 84),
      actionLogRepo,
      gating: o.gating ?? 'band',
      ...(o.withoutBandReview ? {} : { bandReview: { review: review as unknown as BandSendReview['review'] } }),
      ...(o.piiRedactor ? { piiRedactor: o.piiRedactor } : {}),
      ...(o.conversationEntities ? { conversationEntities: o.conversationEntities } : {}),
      principalMailbox: resolveMailbox,
      ...(o.mailboxIds ? { principalMailboxIds: o.mailboxIds } : {}),
      ...(o.defaultMailboxId ? { defaultMailboxId: o.defaultMailboxId } : {}),
      ...(o.mailboxLabels ? { mailboxLabel: async (id: string) => o.mailboxLabels![id] } : {}),
      readSendLevel,
      ...(o.principalAddrs ? {
        principalEmailAddresses: async () => { if (o.principalAddrs instanceof Error) throw o.principalAddrs; return o.principalAddrs!; },
        mailboxAddress: async (id: string) => o.mailboxAddresses?.[id],
      } : {}),
      ...(o.withoutProvenance ? {} : { draftProvenance: { createdByCuria, editedByCuria, curiaWritesInTask } }),
      ...(o.withoutLedger ? {} : { sendLedger: ledger as unknown as Pick<import('../../../src/skills/principal-send/send-ledger.js').PrincipalSendLedger, 'recordSending' | 'recordSent' | 'recordHeld' | 'recentForThread' | 'recentForConversation' | 'recentAutonomousSends' | 'sentForDraft' | 'list' | 'recordLimitStop' | 'limitStopsSince'> }),
    });
    return { gw, client, review, createdByCuria, editedByCuria, curiaWritesInTask, ledger, readSendLevel, actionLogRepo, resolveMailbox };
  }

  function published(type: string): Array<{ type: string; payload: Record<string, unknown> }> {
    return vi.mocked(mocks.bus.publish).mock.calls
      .map(([, event]) => event as unknown as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === type);
  }

  /** A Gmail reply quote of a message from Dana, open at its <blockquote> (final review S2). */
  const GMAIL_QUOTE_FROM_DANA = '<div class="gmail_quote"><div class="gmail_attr">On Thu, Dana &lt;<a href="mailto:dana@example.org">dana@example.org</a>&gt; wrote:<br></div><blockquote class="gmail_quote">';

  /** A redactor that detects each listed text wherever it occurs in what it is given. */
  function redactorFor(found: Array<{ label: string; text: string }>): PiiRedactor & { detect: ReturnType<typeof vi.fn> } {
    const detect = vi.fn((content: string) => found
      .filter((f) => content.includes(f.text))
      .map((f) => ({ label: f.label, matched: f.text, start: content.indexOf(f.text), end: content.indexOf(f.text) + f.text.length })));
    return {
      detect,
      apply: vi.fn((content: string) => ({ content, redactions: [] })),
      redact: vi.fn(),
    } as unknown as PiiRedactor & { detect: ReturnType<typeof vi.fn> };
  }


  // ---- #2475 Task 17: the draft's own mailbox ----

  describe('several principal mailboxes (#2475 Task 17)', () => {
    const both = () => ({ work: mailboxClient(null), personal: mailboxClient(null) });

    it('sends from the mailbox holding the draft', async () => {
      const mailboxes = { ...both(), personal: mailboxClient(draft()) };
      const { gw } = make({ mailboxes, mailboxIds: async () => ['work', 'personal'] });
      const r = await gw.sendPrincipalDraft('d1', opts);
      expect(r.success).toBe(true);
      expect(mailboxes.personal.sendDraft).toHaveBeenCalledWith('d1');
      expect(mailboxes.work.sendDraft).not.toHaveBeenCalled();
    });

    it("reads the level of the draft's mailbox", async () => {
      const mailboxes = { ...both(), personal: mailboxClient(draft()) };
      const { gw, readSendLevel } = make({
        mailboxes, mailboxIds: async () => ['work', 'personal'],
        levels: { work: 'all', personal: 'on_request' },
      });
      // An autonomous send of a personal draft reads personal's on_request, not work's level.
      const system = { originator: { contactId: 'system', systemRole: 'system', channel: 'scheduler', initiatedAt: '2026-11-07T10:00:00.000Z' } };
      const r = await gw.sendPrincipalDraft('d1', { ...opts, authority: { taskMetadata: system } });
      expect(readSendLevel).toHaveBeenCalledWith('personal');
      expect(readSendLevel).not.toHaveBeenCalledWith('work');
      expect(r).toMatchObject({ success: false, refusal: 'not_requested' });
      // The same draft with the level off is refused setting_off.
      const off = make({ mailboxes: { ...both(), personal: mailboxClient(draft()) }, mailboxIds: async () => ['work', 'personal'], levels: { work: 'all', personal: 'off' } });
      expect(await off.gw.sendPrincipalDraft('d1', opts)).toMatchObject({ refusal: 'setting_off' });
    });

    it('refuses a draft id found in two mailboxes', async () => {
      const mailboxes = { work: mailboxClient(draft()), personal: mailboxClient(draft()) };
      const { gw } = make({ mailboxes, mailboxIds: async () => ['work', 'personal'] });
      const r = await gw.sendPrincipalDraft('d1', opts);
      expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'ambiguous_mailbox' });
      expect(r.blockedReason).toMatch(/more than one/i);
      expect(mailboxes.work.sendDraft).not.toHaveBeenCalled();
      expect(mailboxes.personal.sendDraft).not.toHaveBeenCalled();
    });

    it('an explicit mailbox that does not hold the draft is refused, trying no other mailbox', async () => {
      const mailboxes = { work: mailboxClient(null), personal: mailboxClient(draft()) };
      const { gw } = make({ mailboxes, mailboxIds: async () => ['work', 'personal'] });
      const r = await gw.sendPrincipalDraft('d1', { ...opts, mailbox: 'work' });
      expect(r).toMatchObject({ success: false, refusal: 'not_found' });
      expect(mailboxes.personal.getDraft).not.toHaveBeenCalled();
      expect(mailboxes.personal.sendDraft).not.toHaveBeenCalled();
    });

    it('an unknown or removed mailbox is an error, not the default', async () => {
      const mailboxes = { work: mailboxClient(draft()) };
      const { gw } = make({ mailboxes, mailboxIds: async () => ['work'] });
      const r = await gw.sendPrincipalDraft('d1', { ...opts, mailbox: 'gone' });
      expect(r).toMatchObject({ success: false, refusal: 'unknown_mailbox' });
      expect(mailboxes.work.getDraft).not.toHaveBeenCalled();
    });

    it('keys provenance on the mailbox that held the draft, even if the default moves mid-send (one resolution)', async () => {
      const mailboxes = { ...both(), personal: mailboxClient(draft()) };
      let defaultId = 'work';
      const listIds = vi.fn(async () => ['work', 'personal']);
      const { gw, createdByCuria, editedByCuria, resolveMailbox } = make({
        mailboxes, mailboxIds: listIds,
        defaultMailboxId: async () => defaultId,
      });
      // The default changes after the draft is located; the key must stay personal.
      mailboxes.personal.getDraft.mockImplementation(async () => { defaultId = 'personal2'; return draft(); });
      expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
      const refs = [...createdByCuria.mock.calls, ...editedByCuria.mock.calls].flatMap((c) => (c as unknown as Array<Array<{ mailbox: string; draftId: string }>>)[0]!);
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.every((r) => r.mailbox === 'personal' && r.draftId === 'd1')).toBe(true);
      // One resolution: the id list once, and each mailbox's client resolved once.
      expect(listIds).toHaveBeenCalledTimes(1);
      expect(resolveMailbox.mock.calls.map((c) => c[0]).sort()).toEqual(['personal', 'work']);
    });
  });

  // ---- one test per step ----

  it('1. refuses with mailbox_unavailable when resolving the mailbox throws', async () => {
    const { gw } = make();
    (gw as unknown as { principalMailbox: () => Promise<never> }).principalMailbox = async () => { throw new Error('vault down'); };
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'mailbox_unavailable' });
  });

  it('2. uses on_request when the send level cannot be read', async () => {
    const { gw, client, readSendLevel } = make();
    readSendLevel.mockRejectedValue(new Error('kg down'));
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(client!.sendDraft).toHaveBeenCalled();
    // on_request still refuses an autonomous call.
    const system = { originator: { contactId: 'system', systemRole: 'system', channel: 'scheduler', initiatedAt: '2026-11-07T10:00:00.000Z' } };
    expect(await gw.sendPrincipalDraft('d1', { ...opts, authority: { taskMetadata: system } })).toMatchObject({ refusal: 'not_requested' });
  });

  it('1. refuses with mailbox_unavailable when the principal mailbox is not connected', async () => {
    const { gw } = make({ client: null });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'mailbox_unavailable', blockedReason: PRINCIPAL_SEND_REFUSALS.mailbox_unavailable });
  });

  it('2. refuses with setting_off when sending is off for the mailbox', async () => {
    const { gw, client, readSendLevel } = make({ level: 'off' });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'setting_off' });
    expect(readSendLevel).toHaveBeenCalledWith('default');
    expect(client!.getDraft).not.toHaveBeenCalled();
  });

  it('2. always reads the default mailbox\'s level: there is one principal grant until #2475', async () => {
    const { gw, readSendLevel } = make();
    await gw.sendPrincipalDraft('d1', opts);
    expect(readSendLevel).toHaveBeenCalledWith('default');
  });

  it('3. refuses an approval replay with approval_replay', async () => {
    const { gw, client } = make();
    const r = await gw.sendPrincipalDraft('d1', { ...opts, authority: { ...live, humanApproved: true } });
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'approval_replay', blockedReason: PRINCIPAL_SEND_REFUSALS.approval_replay });
    expect(client!.getDraft).not.toHaveBeenCalled();
  });

  it('3. refuses an autonomous call with not_requested', async () => {
    // PR 2: not_requested is now the on_request level's answer; routine and all take the autonomous path.
    const { gw, client } = make({ level: 'on_request' });
    const system = { originator: { contactId: 'system', systemRole: 'system', channel: 'scheduler', initiatedAt: '2026-11-07T10:00:00.000Z' } };
    const r = await gw.sendPrincipalDraft('d1', { ...opts, authority: { taskMetadata: system } });
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'not_requested', blockedReason: PRINCIPAL_SEND_REFUSALS.not_requested });
    expect(client!.getDraft).not.toHaveBeenCalled();
  });

  it('4. refuses with not_found when the draft is gone, without retrying', async () => {
    const client = mailboxClient(null);
    const { gw } = make({ client });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'not_found', blockedReason: PRINCIPAL_SEND_REFUSALS.not_found });
    expect(client.getDraft).toHaveBeenCalledTimes(1);
    expect(client.sendDraft).not.toHaveBeenCalled();
  });

  it('4. refuses with lookup_failed when the draft read throws', async () => {
    const client = mailboxClient();
    client.getDraft.mockRejectedValue(new Error('503'));
    const { gw } = make({ client });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'lookup_failed' });
    expect(client.sendDraft).not.toHaveBeenCalled();
  });

  it('5. refuses a draft with no recipients', async () => {
    const { gw } = make({ client: mailboxClient(draft({ to: [], cc: [], bcc: [] })) });
    expect(await gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'no_recipients' });
  });

  it('5. refuses a draft addressed only to the principal', async () => {
    const { gw, client } = make({ client: mailboxClient(draft({ to: [{ email: 'Avery@Example.com' }], cc: [{ email: PRINCIPAL }] })) });
    expect(await gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'principal_only', blockedReason: PRINCIPAL_SEND_REFUSALS.principal_only });
    expect(client!.sendDraft).not.toHaveBeenCalled();
  });

  it('6. treats a draft as Curia\'s when provenance is absent or throws: more review', async () => {
    for (const setup of [{ withoutProvenance: true as const }, { createdByCuria: new Error('db down') }]) {
      const review = vi.fn().mockResolvedValue({ kind: 'send' });
      const { gw } = make({ ...setup, review });
      expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ draftAuthor: 'curia' }));
    }
  });

  it('6. treats a draft as Curia\'s when the edit lookup throws', async () => {
    const { gw, review } = make({ editedByCuria: new Error('db down') });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ draftAuthor: 'curia' }));
  });

  it('6. classes a draft Curia edited as curia-edited: reviewed, and the identity gate runs', async () => {
    const { gw, review, editedByCuria } = make({ editedByCuria: ['d1'] });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(editedByCuria).toHaveBeenCalledWith([{ mailbox: 'default', draftId: 'd1' }]);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ draftAuthor: 'curia-edited', principalDirected: true }));

    const { ConversationEntityState } = await import('../../../src/entity-context/conversation-entities.js');
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Avery Lee']);
    entities.turnIdentities.begin('t1');
    const body = '<p>He and Xiaopu (last name to be confirmed) would like to attend.</p>';
    const edited = make({ editedByCuria: ['d1'], conversationEntities: entities, client: mailboxClient(draft({ body })) });
    expect(await edited.gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, blockedRules: ['unresolved-identity'] });
  });

  it('6. classes a draft last modified before the lookback as curia-edited: who wrote it is unknown', async () => {
    const old = draft({ date: Math.floor(Date.now() / 1000) - 31 * 86_400 });
    const { gw, review } = make({ client: mailboxClient(old) });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ draftAuthor: 'curia-edited' }));
  });

  it('6. a Curia-created draft stays curia even when Curia also edited it', async () => {
    const { gw, review } = make({ createdByCuria: ['d1'], editedByCuria: ['d1'] });
    await gw.sendPrincipalDraft('d1', opts);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ draftAuthor: 'curia' }));
  });

  it('7. reviews through checkDraftSend with the principal-mailbox profile', async () => {
    const { gw, review, createdByCuria } = make({ createdByCuria: ['d1'] });
    await gw.sendPrincipalDraft('d1', opts);
    expect(createdByCuria).toHaveBeenCalledWith([{ mailbox: 'default', draftId: 'd1' }]);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      senderProfile: 'principal-mailbox', draftAuthor: 'curia', principalDirected: true, recipients: ['dana@example.org'], principalRecipients: [],
    }));
  });

  it('8. refuses with draft_changed when the draft changed during the checks', async () => {
    const client = mailboxClient();
    client.getDraft.mockResolvedValueOnce(draft()).mockResolvedValueOnce(draft({ body: '<p>Friday works. Bring the cheque.</p>' }));
    const { gw, ledger } = make({ client });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'draft_changed', blockedReason: PRINCIPAL_SEND_REFUSALS.draft_changed });
    expect(PRINCIPAL_SEND_REFUSALS.draft_changed).toBe('The draft changed while Curia was checking it. Nothing was sent; read the latest version and ask the principal again.');
    expect(client.sendDraft).not.toHaveBeenCalled();
    expect(ledger.recordSending).not.toHaveBeenCalled();
  });

  it('8. refuses with not_found when the draft vanished during the checks', async () => {
    const client = mailboxClient();
    client.getDraft.mockResolvedValueOnce(draft()).mockResolvedValueOnce(null);
    const { gw } = make({ client });
    expect(await gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, refusal: 'not_found' });
    expect(client.sendDraft).not.toHaveBeenCalled();
  });

  it('9. writes the ledger around the send, and a ledger failure does not stop it', async () => {
    const ledger = { recordSending: vi.fn().mockRejectedValue(new Error('db down')), recordSent: vi.fn().mockRejectedValue(new Error('db down')) };
    const { gw, client } = make({ ledger });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r.success).toBe(true);
    expect(ledger.recordSending).toHaveBeenCalledWith(expect.objectContaining({
      draftId: 'd1', threadId: 'th1', recipients: ['dana@example.org'], mode: 'principal-directed', at: expect.any(String),
    }));
    expect(client!.sendDraft).toHaveBeenCalledWith('d1');
    expect(ledger.recordSent).toHaveBeenCalledWith('d1', 'sent-1');
  });

  it('10. records the send and returns what went out, outside the spot-check pool', async () => {
    const { gw, actionLogRepo } = make({ createdByCuria: ['d1'] });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toEqual({ success: true, messageId: 'sent-1', threadId: 'th1', to: ['dana@example.org'], subject: 'Re: Friday' });
    expect(published('outbound.delivered')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ messageId: 'sent-1', recipientId: 'dana@example.org' }) })]);
    // Principal-directed, as sendEmailDraft: not sampled (PR 2's autonomous sends will be).
    expect(actionLogRepo.insertSampled).not.toHaveBeenCalled();
    expect(mocks.contactService.resolveByChannelIdentity).not.toHaveBeenCalledWith('email', PRINCIPAL);
  });

  it('10. publishes the band report item of a send the review let through unreviewed', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'send', report: { source: 'sent_without_review', summary: 'Sent unreviewed.' } });
    const { gw } = make({ review, createdByCuria: ['d1'] });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(published('principal.report')).toEqual([expect.objectContaining({ payload: expect.objectContaining({ source: 'sent_without_review' }) })]);
  });

  // ---- behavior ----

  it('never writes an approval row on a review hold', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held for the principal: it claims a meeting nobody set.', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] });
    const { gw, client, actionLogRepo, ledger } = make({ review, createdByCuria: ['d1'] });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({
      success: false, leftAsDraft: true, refusal: 'review_hold',
      blockedReason: 'Held for the principal: it claims a meeting nobody set. Nothing was sent; the draft is still in their Drafts folder.',
    });
    expect(r.gated).toBeUndefined();
    expect(actionLogRepo.insert).not.toHaveBeenCalled();
    expect(published('principal.report')).toHaveLength(0);
    expect(client!.sendDraft).not.toHaveBeenCalled();
    expect(ledger.recordSending).not.toHaveBeenCalled();
  });

  it('treats an ask hold the same way: no approval, no digest item', async () => {
    const review = vi.fn().mockResolvedValue({
      kind: 'hold', reason: 'Held: Dana asked for the principal\'s phone number.', findings: [{ rule: 'pii-not-authorized', detail: 'x' }],
      ask: { labels: ['PHONE_NUMBER'], requester: 'dana@example.org', counterparties: ['dana@example.org'] },
    });
    const { gw, actionLogRepo } = make({ review, createdByCuria: ['d1'] });
    expect(await gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, refusal: 'review_hold' });
    expect(actionLogRepo.insert).not.toHaveBeenCalled();
    expect(published('principal.report')).toHaveLength(0);
  });

  it('treats a review block as a hold that leaves the draft', async () => {
    const review = vi.fn().mockResolvedValue({ kind: 'block', reason: 'Not sent: x', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] });
    const { gw, client } = make({ review, createdByCuria: ['d1'] });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'review_hold' });
    expect(r.blockedReason).toContain('ungrounded-claim');
    expect(r.blockedReason).toMatch(/Nothing was sent; the draft is still in their Drafts folder\.$/);
    expect(published('principal.report')).toHaveLength(0);
    expect(published('outbound.blocked')).toHaveLength(0);
    expect(client!.sendDraft).not.toHaveBeenCalled();
  });

  it('returns a bounce\'s findings without leaving a ledger hold', async () => {
    const findings = [{ rule: 'ungrounded-claim', detail: 'not backed: "See you then."' }];
    const review = vi.fn().mockResolvedValue({ kind: 'bounce', findings });
    const { gw, client, ledger } = make({ review, createdByCuria: ['d1'] });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, blockedRules: ['ungrounded-claim'] });
    expect(r.blockedReason).toContain('See you then.');
    expect(r.refusal).toBeUndefined();
    expect(ledger.recordSending).not.toHaveBeenCalled();
    expect(client!.sendDraft).not.toHaveBeenCalled();
  });

  it('skips review for a principal-written draft with no detected items', async () => {
    const { gw, review, client } = make();
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(review).not.toHaveBeenCalled();
    expect(client!.sendDraft).toHaveBeenCalled();
  });

  it('asks purpose and grounding for a Curia-written draft', async () => {
    const { gw, review } = make({ createdByCuria: ['d1'] });
    await gw.sendPrincipalDraft('d1', opts);
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ draftAuthor: 'curia', senderProfile: 'principal-mailbox', principalDirected: true }));
  });

  it('does not flag the principal\'s own phone on a principal-directed send', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '+1 (416) 555-0100' }, { label: 'EMAIL', text: 'Avery@Example.com' }]);
    const body = '<p>Call me at +1 (416) 555-0100 or write to Avery@Example.com.</p>';
    const { gw, review } = make({ piiRedactor, client: mailboxClient(draft({ body })) });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(review).not.toHaveBeenCalled();
  });

  it('reviews a third party\'s detail in a principal-written draft', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    const { gw, review } = make({ piiRedactor, client: mailboxClient(draft({ body: '<p>Sam\'s cell is 416-555-0199.</p>' })) });
    await gw.sendPrincipalDraft('d1', opts);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      draftAuthor: 'principal', detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'body' })],
    }));
  });

  it('exempts the reply quote from review when every recipient was on the quoted message', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    const body = `<p>Got it, thanks.</p>${GMAIL_QUOTE_FROM_DANA}call me at 416-555-0199</blockquote></div>`;
    const { gw, review } = make({ piiRedactor, client: mailboxClient(draft({ body })) });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    // Detected (for the audit copy) but not ruled on: no review, nothing reported as disclosed.
    expect(review).not.toHaveBeenCalled();
    expect(published('outbound.delivered')[0]!.payload['disclosed']).toBeUndefined();
  });

  it('redacts a quoted phone in the audit copy without reviewing it (recipients were on the quote)', async () => {
    const found = [{ label: 'PHONE_NUMBER', text: '416-555-0199' }];
    const detect = vi.fn((content: string) => found
      .filter((f) => content.includes(f.text))
      .map((f) => ({ label: f.label, matched: f.text, start: content.indexOf(f.text), end: content.indexOf(f.text) + f.text.length })));
    const apply = vi.fn((content: string, items: Array<{ matched: string }>) => ({
      content: items.reduce((c, i) => c.split(i.matched).join('[REDACTED: PHONE_NUMBER]'), content), redactions: [],
    }));
    const piiRedactor = { detect, apply, redact: vi.fn() } as unknown as PiiRedactor;
    const body = `<p>Got it, thanks.</p>${GMAIL_QUOTE_FROM_DANA}call me at 416-555-0199</blockquote></div>`;
    const { gw, review } = make({ piiRedactor, client: mailboxClient(draft({ body })) });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(review).not.toHaveBeenCalled();
    const content = String(published('outbound.delivered')[0]!.payload['content']);
    expect(content).not.toContain('416-555-0199');
    expect(content).toContain('[REDACTED: PHONE_NUMBER]');
    expect(published('outbound.delivered')[0]!.payload['disclosed']).toBeUndefined();
  });

  it('reviews quoted details as field quote when a recipient was not on the quoted message', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    const body = `<p>Looping in Sam.</p>${GMAIL_QUOTE_FROM_DANA}call me at 416-555-0199</blockquote></div>`;
    const d = draft({ body, cc: [{ email: 'sam@example.org' }] });
    const { gw, review } = make({ piiRedactor, client: mailboxClient(d) });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      draftAuthor: 'principal', detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'quote' })],
    }));
  });

  it('treats Gmail\'s compound quote class (gmail_quote gmail_quote_container) as the quote', async () => {
    const compound = GMAIL_QUOTE_FROM_DANA.replace('<div class="gmail_quote">', '<div class="gmail_quote gmail_quote_container">');
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    // Every recipient was on the quoted message: exempt, no review.
    const onQuote = make({ piiRedactor, client: mailboxClient(draft({ body: `<p>Got it.</p>${compound}call me at 416-555-0199</blockquote></div>` })) });
    expect((await onQuote.gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(onQuote.review).not.toHaveBeenCalled();
    // Sam was not on it: reviewed as field quote, not as the draft's own text.
    const offQuote = make({ piiRedactor, client: mailboxClient(draft({ body: `<p>Looping in Sam.</p>${compound}call me at 416-555-0199</blockquote></div>`, cc: [{ email: 'sam@example.org' }] })) });
    await offQuote.gw.sendPrincipalDraft('d1', opts);
    expect(offQuote.review).toHaveBeenCalledWith(expect.objectContaining({
      detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'quote' })],
    }));
  });

  it('reviews details as the draft\'s own text when gmail_quote is only in another attribute', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    for (const forged of ['data-class="gmail_quote"', 'title=\'class="gmail_quote"\'']) {
      // A forged attribution naming the recipient must not exempt what follows it.
      const body = `<p>Got it.</p><div ${forged}><div class="gmail_attr">On Thu, Dana &lt;dana@example.org&gt; wrote:</div><blockquote>call me at 416-555-0199</blockquote></div>`;
      const { gw, review } = make({ piiRedactor, client: mailboxClient(draft({ body })) });
      await gw.sendPrincipalDraft('d1', opts);
      expect(review, forged).toHaveBeenCalledWith(expect.objectContaining({
        detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'body' })],
      }));
    }
  });

  it('reviews details as the draft\'s own text when a quote marker sits inside an end tag\'s attribute', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    // The '>' inside the quoted value does not close </p>, so the gmail_quote after it is text.
    const body = '<p>Call 416-555-0199.</p x=\'>\'<div class="gmail_quote"><div class="gmail_attr">On Thu, Dana &lt;dana@example.org&gt; wrote:</div><blockquote>x</blockquote></div>\'>';
    const { gw, review } = make({ piiRedactor, client: mailboxClient(draft({ body })) });
    await gw.sendPrincipalDraft('d1', opts);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'body' })],
    }));
  });

  it('reviews quoted details when the quote header names nobody (fail closed)', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    const body = '<p>Got it.</p><div class="gmail_quote">On Thu, Dana wrote: call me at 416-555-0199</div>';
    const { gw, review } = make({ piiRedactor, client: mailboxClient(draft({ body })) });
    await gw.sendPrincipalDraft('d1', opts);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ detectedItems: [expect.objectContaining({ field: 'quote' })] }));
  });

  it('leaves the draft unsent when the review would send it without its quote: a saved draft keeps its quote', async () => {
    const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]);
    const body = `<p>Looping in Sam.</p>${GMAIL_QUOTE_FROM_DANA}call me at 416-555-0199</blockquote></div>`;
    const review = vi.fn().mockResolvedValue({ kind: 'send', dropQuote: { labels: ['PHONE_NUMBER'] } });
    const { gw, client, ledger, actionLogRepo } = make({ piiRedactor, review, client: mailboxClient(draft({ body, cc: [{ email: 'sam@example.org' }] })) });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'review_hold' });
    expect(r.blockedReason).toMatch(/quoted message/);
    expect(r.blockedReason).toMatch(/Nothing was sent; the draft is still in their Drafts folder\.$/);
    expect(r.blockedReason).not.toContain('416-555-0199');
    expect(client!.sendDraft).not.toHaveBeenCalled();
    expect(ledger.recordSending).not.toHaveBeenCalled();
    expect(actionLogRepo.insert).not.toHaveBeenCalled();
  });

  it('files no digest item on a content-filter block (the curia path still does)', async () => {
    vi.mocked(mocks.contentFilter.check).mockResolvedValue({ passed: false, findings: [{ rule: 'secret-pattern', detail: 'x' }] });
    const { gw, client } = make();
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, leftAsDraft: true, blockedRules: ['secret-pattern'] });
    expect(published('principal.report')).toHaveLength(0);
    expect(client!.sendDraft).not.toHaveBeenCalled();

    (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-2' });
    await gw.sendEmailDraft('d2', 'curia', { recipientEmail: 'dana@example.org', body: 'Hi Dana.', subject: 'Hello' }, { humanApproved: true, taskEventId: 't1' });
    expect(published('principal.report')).toHaveLength(1);
  });

  it('files no digest item on a stranger-request bounce', async () => {
    const review = vi.fn().mockResolvedValue({
      kind: 'bounce', findings: [{ rule: 'pii-not-authorized', detail: 'x' }],
      strangerRequest: { labels: ['PHONE_NUMBER'], requester: 'dana@example.org' },
    });
    const { gw, client } = make({ review, createdByCuria: ['d1'] });
    expect(await gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, blockedRules: ['pii-not-authorized'] });
    expect(published('principal.report')).toHaveLength(0);
    expect(client!.sendDraft).not.toHaveBeenCalled();
  });

  it('still runs the content filter over the quote', async () => {
    const body = '<p>Got it.</p><div class="gmail_quote">On Thu, Dana wrote: SECRET-QUOTE</div>';
    const { gw } = make({ client: mailboxClient(draft({ body })) });
    await gw.sendPrincipalDraft('d1', opts);
    expect(mocks.contentFilter.check).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('SECRET-QUOTE') }));
  });

  it('does not block a principal-written draft naming people at the identity gate', async () => {
    const { ConversationEntityState } = await import('../../../src/entity-context/conversation-entities.js');
    const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Avery Lee']);
    entities.turnIdentities.begin('t1');
    const body = '<p>He and Xiaopu (last name to be confirmed) would like to attend.</p>';
    const principalWritten = make({ conversationEntities: entities, client: mailboxClient(draft({ body })) });
    expect((await principalWritten.gw.sendPrincipalDraft('d1', opts)).success).toBe(true);

    // A Curia-written draft is still checked.
    const curiaWritten = make({ conversationEntities: entities, createdByCuria: ['d1'], client: mailboxClient(draft({ body })) });
    expect(await curiaWritten.gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, blockedRules: ['unresolved-identity'] });
  });

  it('still refuses a draft to a blocked contact', async () => {
    vi.mocked(mocks.contactService.resolveByChannelIdentity).mockResolvedValue({
      contactId: 'c-dana', displayName: 'Dana', role: null, tier: 'blocked', kind: 'person', kgNodeId: null, verified: true,
    } as unknown as Awaited<ReturnType<ContactService['resolveByChannelIdentity']>>);
    const { gw, client } = make();
    expect(await gw.sendPrincipalDraft('d1', opts)).toMatchObject({ success: false, blockedReason: 'Recipient is blocked', leftAsDraft: true });
    expect(client!.sendDraft).not.toHaveBeenCalled();
  });

  it('leaves send-draft\'s pool recording unchanged on a gateway wired for the principal mailbox', async () => {
    (mocks.nylasClient as unknown as { sendDraft: ReturnType<typeof vi.fn> }).sendDraft = vi.fn().mockResolvedValue({ id: 'sent-2' });
    const { gw, actionLogRepo } = make();
    await gw.sendEmailDraft('d2', 'curia', { recipientEmail: 'dana@example.org', body: 'Hi Dana.', subject: 'Hello' }, { humanApproved: true, principalDirected: false, taskEventId: 't1' });
    expect(vi.mocked(actionLogRepo.insertSampled).mock.calls.map((c) => (c[0] as { toolName: string }).toolName)).toEqual(['send-draft']);
  });

  // ---- Review Focus ----

  it('keeps the principal\'s own address out of the reviewed audience', async () => {
    const d = draft({ to: [{ email: 'dana@example.org' }], cc: [{ email: PRINCIPAL }, { email: 'sam@example.org' }] });
    const { gw, review, client } = make({ client: mailboxClient(d), createdByCuria: ['d1'] });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r.success).toBe(true);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['dana@example.org', 'sam@example.org'], principalRecipients: [] }));
    expect(r.to).toEqual(['dana@example.org', 'sam@example.org']);
    expect(client!.sendDraft).toHaveBeenCalled();
  });

  it('falls back to cc for the primary recipient', async () => {
    const d = draft({ to: [{ email: PRINCIPAL }], cc: [{ email: 'sam@example.org' }], bcc: [{ email: 'lee@example.org' }] });
    const { gw } = make({ client: mailboxClient(d) });
    expect((await gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(published('outbound.delivered')[0]!.payload).toMatchObject({ recipientId: 'sam@example.org' });

    mocks = createMocks();
    const bccOnly = draft({ to: [], cc: [], bcc: [{ email: 'lee@example.org' }] });
    const second = make({ client: mailboxClient(bccOnly) });
    expect((await second.gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
    expect(published('outbound.delivered')[0]!.payload).toMatchObject({ recipientId: 'lee@example.org' });
  });

  it('does not retry a failed send, and says its outcome is unknown (final review C2)', async () => {
    const client = mailboxClient();
    client.sendDraft.mockRejectedValue(Object.assign(new Error('Nylas 503'), { statusCode: 503 }));
    const { gw, ledger } = make({ client });
    const r = await gw.sendPrincipalDraft('d1', opts);
    expect(r).toMatchObject({ success: false, refusal: 'send_unconfirmed' });
    expect(r.blockedReason).toBe("The send to the principal's mailbox didn't confirm, so it may or may not have gone out. Check the principal's Sent folder before sending again.");
    expect(PRINCIPAL_SEND_REFUSALS.send_unconfirmed).toBe(r.blockedReason);
    // It may have gone: never "still a draft".
    expect(r.leftAsDraft).toBeUndefined();
    expect(client.sendDraft).toHaveBeenCalledTimes(1);
    expect(ledger.recordSending).toHaveBeenCalledOnce();
    expect(ledger.recordSent).not.toHaveBeenCalled();
    expect(published('outbound.delivered')).toHaveLength(0);
  });

  it('matches addresses case-insensitively', async () => {
    const d = draft({ to: [{ email: 'Dana@Example.ORG' }], cc: [{ email: 'AVERY@example.com' }, { email: 'dana@example.org' }] });
    const client = mailboxClient(d);
    const { gw, review } = make({ client, createdByCuria: ['d1'] });
    const r = await gw.sendPrincipalDraft('d1', opts);
    // The re-read returns the same mixed-case draft: not a change.
    expect(r).toMatchObject({ success: true, to: ['dana@example.org'] });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['dana@example.org'] }));
  });

  // ---- PR 2: autonomous sends (levels routine / all) ----

  describe('autonomous', () => {
    const SYSTEM = { originator: { contactId: 'system', systemRole: 'system', channel: 'scheduler', initiatedAt: '2026-11-07T10:00:00.000Z' } };
    const auto = { authority: { taskMetadata: SYSTEM }, taskEventId: 't1', conversationId: 'c1' };
    const VERIFIED = [{ name: 'Authentication-Results', value: 'mx.google.com; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass header.from=x' }];
    const SUFFIX = ' Nothing was sent; the draft is still in their Drafts folder.';
    const LEAD = 'Left as a draft in your mailbox: "Re: Friday" to Dana Example.';
    /** The principal's digest item for a coded stop (final fixes A12): second person, ending "It's in your Drafts." */
    // An operational stop (kind other) leads "Not sent from your mailbox" (R44); a judgement one "Left as a draft".
    const NOT_SENT = 'Not sent from your mailbox: "Re: Friday" to Dana Example.';
    const DIGEST = (code: keyof typeof PRINCIPAL_SEND_DIGEST_REASONS) => `${refusalKindOf(code) === 'other' ? NOT_SENT : LEAD} ${PRINCIPAL_SEND_DIGEST_REASONS[code]}`;
    const IN_DRAFTS = " It's in your Drafts.";
    const nowSec = () => Math.floor(Date.now() / 1000);

    /** Dana's verified message the draft answers. */
    function inbound(over: Partial<NylasMessage> = {}): NylasMessage {
      return {
        id: 'm1', threadId: 'th1', subject: 'Friday', from: [{ name: 'Dana Example', email: 'dana@example.org' }],
        to: [{ email: PRINCIPAL }], cc: [], bcc: [], body: '<p>Does Friday at 10 work?</p>', snippet: '',
        date: nowSec() - 7200, unread: false, folders: ['INBOX'], attachments: [], headers: VERIFIED,
        ...over,
      } as NylasMessage;
    }
    const autoDraft = (over: Partial<NylasMessage> = {}) => draft({ to: [{ name: 'Dana Example', email: 'dana@example.org' }], ...over });
    function autoClient(d: NylasMessage | null = autoDraft(), thread: NylasMessage[] = [inbound()]) {
      const c = mailboxClient(d);
      c.listMessages.mockResolvedValue(thread);
      return c;
    }
    function makeAuto(o: Parameters<typeof make>[0] = {}) {
      return make({ level: 'routine', score: 85, client: autoClient(), ...o });
    }
    const reports = () => published('principal.report').map((e) => e.payload);

    it('1. on_request refuses an autonomous call with not_requested: no digest item, no ledger entry', async () => {
      const { gw, client, ledger } = makeAuto({ level: 'on_request' });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'not_requested' });
      expect(client!.getDraft).not.toHaveBeenCalled();
      expect(reports()).toHaveLength(0);
      expect(ledger.recordHeld).not.toHaveBeenCalled();
    });

    it('2. refuses outsider-originated work with outsider_originated, a held marker and a digest item', async () => {
      const outsider = { originator: { contactId: 'c-dana', systemRole: null, channel: 'email', initiatedAt: '2026-11-07T10:00:00.000Z' } };
      const { gw, client, ledger, review } = makeAuto();
      const r = await gw.sendPrincipalDraft('d1', { ...auto, authority: { taskMetadata: outsider } });
      const text = "This work started from someone outside, so Curia won't send from the principal's mailbox on its own." + SUFFIX;
      expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'outsider_originated', blockedReason: text });
      expect(PRINCIPAL_SEND_REFUSALS.outsider_originated).toBe(text);
      expect(review).not.toHaveBeenCalled();
      expect(client!.sendDraft).not.toHaveBeenCalled();
      // Addendum: an origin stop isn't a judgement on the thread, so no marker burns its cooldown.
      expect(ledger.recordHeld).not.toHaveBeenCalled();
      expect(reports()).toEqual([expect.objectContaining({ summary: DIGEST('outsider_originated'), urgency: 'digest', source: 'principal_mailbox', conversationId: 'c1' })]);
      expect(DIGEST('outsider_originated')).toBe(`${LEAD} This work started from someone outside, so Curia didn't send it on its own.${IN_DRAFTS}`);
    });

    it('3. refuses with no_band_review when band review is not running (fail closed)', async () => {
      const text = "The send review isn't running, so Curia won't send from the principal's mailbox on its own." + SUFFIX;
      for (const setup of [{ gating: 'tier' as const }, { withoutBandReview: true as const }]) {
        mocks = createMocks();
        const { gw, client, ledger } = makeAuto(setup);
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'no_band_review', blockedReason: text });
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(ledger.recordHeld).toHaveBeenCalledOnce();
        expect(reports()).toHaveLength(1);
      }
    });

    it('3. refuses with no_band_review when the autonomy config switches this send to tier gating', async () => {
      const { gw, client } = makeAuto();
      const service = (gw as unknown as { autonomyService: { getConfig: ReturnType<typeof vi.fn> } }).autonomyService;
      service.getConfig = vi.fn().mockResolvedValue({ score: 85, gating: 'tier' });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'no_band_review' });
      expect(client!.sendDraft).not.toHaveBeenCalled();
    });

    it('4. refuses with not_curia_draft with no task event id or no provenance (fail closed)', async () => {
      const text = 'Curia sends on its own only a reply it drafted in this same pass.' + SUFFIX;
      for (const [setup, options] of [[{}, { authority: auto.authority }], [{ withoutProvenance: true as const }, auto]] as const) {
        mocks = createMocks();
        const { gw, client } = makeAuto(setup);
        expect(await gw.sendPrincipalDraft('d1', options)).toMatchObject({ refusal: 'not_curia_draft', blockedReason: text });
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(reports()).toHaveLength(1);
      }
    });

    it('5. a draft that is gone is still reported: one digest item, no held marker without a thread', async () => {
      const { gw, ledger } = makeAuto({ client: autoClient(null) });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_found' });
      // No thread to cool down: no held marker, only the digest item.
      expect(ledger.recordHeld).not.toHaveBeenCalled();
      // Final fixes A12: not "Left as a draft" (it isn't one any more), and in the second person.
      expect(reports()).toEqual([expect.objectContaining({
        summary: "Not sent from your mailbox: a reply Curia drafted. It isn't in your Drafts any more (sent, deleted or replaced).",
      })]);
      expect(ledger.sentForDraft).toHaveBeenCalledWith('d1');
    });

    describe('a draft that could not be located across mailboxes (#2475 review)', () => {
      const two = (work: ReturnType<typeof mailboxClient> | null, personal: ReturnType<typeof mailboxClient> | null) =>
        ({ mailboxes: { work, personal }, mailboxIds: async () => ['work', 'personal'] });

      it('files a digest item when one mailbox fails and none holds the draft; a live principal gets a plain refusal', async () => {
        const { gw } = makeAuto(two(null, mailboxClient(null)));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'lookup_failed' });
        expect(reports()).toEqual([expect.objectContaining({
          summary: "Not sent from your mailbox: a reply Curia drafted. Curia couldn't read the draft just now; check your Drafts.",
          urgency: 'digest', source: 'principal_mailbox',
        })]);
        mocks = createMocks();
        const live = makeAuto(two(null, mailboxClient(null)));
        expect(await live.gw.sendPrincipalDraft('d1', opts)).toMatchObject({ refusal: 'lookup_failed' });
        expect(reports()).toHaveLength(0);
      });

      it('files a digest item for an ambiguous draft id', async () => {
        const { gw } = makeAuto(two(mailboxClient(draft()), mailboxClient(draft())));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'ambiguous_mailbox' });
        expect(reports()).toEqual([expect.objectContaining({ summary: expect.stringMatching(/^Not sent from your mailbox: a reply Curia drafted\. .*more than one/) })]);
      });

      it('files a digest item for a draft that is gone from every mailbox', async () => {
        const { gw } = makeAuto(two(mailboxClient(null), mailboxClient(null)));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_found' });
        expect(reports()).toEqual([expect.objectContaining({
          summary: "Not sent from your mailbox: a reply Curia drafted. It isn't in your Drafts any more (sent, deleted or replaced).",
        })]);
      });
    });

    // Final fixes A12 (final review M1): a second send call on a draft that already went out.
    it('5. files nothing for a gone draft the ledger shows as sent', async () => {
      const { gw, ledger } = makeAuto({ client: autoClient(null) });
      ledger.sentForDraft.mockResolvedValue(true);
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_found' });
      expect(reports()).toHaveLength(0);
      expect(ledger.recordHeld).not.toHaveBeenCalled();
    });

    it('5. files the item when the ledger cannot say whether the gone draft was sent (fail toward telling)', async () => {
      const { gw, ledger } = makeAuto({ client: autoClient(null) });
      ledger.sentForDraft.mockRejectedValue(new Error('db down'));
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_found' });
      expect(reports()).toHaveLength(1);
    });

    it('5. a draft that cannot be read is reported without the "Left as a draft" lead', async () => {
      const client = autoClient();
      client.getDraft.mockRejectedValue(new Error('503'));
      const { gw } = makeAuto({ client });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'lookup_failed' });
      expect(reports()).toEqual([expect.objectContaining({
        summary: "Not sent from your mailbox: a reply Curia drafted. Curia couldn't read the draft just now; check your Drafts.",
      })]);
    });

    it('6. refuses with thread_unreadable when the thread read throws', async () => {
      const client = autoClient();
      client.listMessages.mockRejectedValue(new Error('503'));
      const { gw, ledger } = makeAuto({ client });
      const text = "Couldn't read the thread to check who's on it, so Curia didn't send on its own." + SUFFIX;
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'thread_unreadable', blockedReason: text });
      expect(client.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordHeld).toHaveBeenCalledOnce();
      expect(reports()).toEqual([expect.objectContaining({ summary: DIGEST('thread_unreadable') })]);
    });

    it('requests up to 50 messages with headers', async () => {
      const { gw, client } = makeAuto();
      expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
      expect(client!.listMessages).toHaveBeenCalledWith({ threadId: 'th1', fields: 'include_headers', limit: 50 });

      // A full page may not hold every participant: refuse (fail closed).
      mocks = createMocks();
      const full = Array.from({ length: 50 }, (_, i) => inbound({ id: `m${i}` }));
      const second = makeAuto({ client: autoClient(autoDraft(), full) });
      expect(await second.gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'thread_unreadable' });
      expect(second.client!.sendDraft).not.toHaveBeenCalled();
    });

    it('7. refuses with not_curia_draft when the task\'s draft writes cannot be read', async () => {
      const { gw, curiaWritesInTask } = makeAuto({ curiaWrites: new Error('db down') });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_curia_draft' });
      expect(curiaWritesInTask).toHaveBeenCalledWith({ mailbox: 'default', draftId: 'd1' }, 't1');
    });

    it('7. refuses with not_curia_draft when Curia did not create the draft in this task', async () => {
      const { gw, client } = makeAuto({ curiaWrites: { created: false, lastWriteAt: null, replyToMessageId: null } });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_curia_draft' });
      expect(client!.sendDraft).not.toHaveBeenCalled();
    });

    it('7. refuses with draft_changed_since_curia when the draft changed after Curia wrote it', async () => {
      const { gw } = makeAuto({ curiaWrites: { created: true, lastWriteAt: new Date(Date.now() - 2 * 3600_000), replyToMessageId: 'm1' } });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({
        refusal: 'draft_changed_since_curia', blockedReason: 'The draft changed after Curia wrote it, so Curia left it for the principal.' + SUFFIX,
      });
    });

    it('7. refuses a recipient not genuinely on the thread, naming them', async () => {
      const { gw, client, ledger } = makeAuto({ client: autoClient(autoDraft({ cc: [{ email: 'sam@example.org' }] })) });
      const r = await gw.sendPrincipalDraft('d1', auto);
      expect(r).toMatchObject({
        refusal: 'recipient_not_on_thread',
        blockedReason: "The reply goes to someone who isn't genuinely on the thread (sam@example.org is not on the thread)." + SUFFIX,
      });
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordSending).not.toHaveBeenCalled();
    });

    // ---- #2475 Task 19: replies held only by a limit are reported as the limit ----
    describe('limit holds (#2475 Task 19)', () => {
      const FIRST = 'Reached the daily limit of 10 replies Curia sends on its own. Replies it would have sent wait in your Drafts until you send them or the limit resets.';
      const atCap = (ledger: { recentAutonomousSends: ReturnType<typeof vi.fn> }) => {
        const at = new Date().toISOString();
        ledger.recentAutonomousSends.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({
          draftId: `x${i}`, threadId: `t${i}`, recipients: [], mode: 'autonomous', at, outcome: 'sent',
        })));
      };
      const earlierStop = { draftId: 'x', threadId: '', recipients: [], conversationIds: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'limited', reasonCode: 'daily_cap' };

      it('first cap stop files the limit notice', async () => {
        const { gw, ledger, client } = makeAuto();
        atCap(ledger);
        const r = await gw.sendPrincipalDraft('d1', auto);
        expect(r).toMatchObject({ success: false, refusal: 'daily_cap', refusalKind: 'limit' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(reports()).toEqual([expect.objectContaining({ summary: FIRST, urgency: 'digest' })]);
        expect(ledger.limitStopsSince).toHaveBeenCalledWith(expect.any(Number), 'daily_cap');
        expect(ledger.recordLimitStop).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'd1', mailbox: 'default', reason: 'daily_cap' }));
      });

      it('later cap stops file waiting items, not Left as a draft', async () => {
        const { gw, ledger } = makeAuto();
        atCap(ledger);
        ledger.limitStopsSince.mockResolvedValue([earlierStop]);
        await gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: 'Waiting only because of the daily limit: "Re: Friday" to Dana Example.' })]);
        expect(reports()[0]!['summary']).not.toMatch(/Left as a draft/);
      });

      it('judgement holds still read Left as a draft', async () => {
        const { gw } = makeAuto({ curiaWrites: { created: false, lastWriteAt: null, replyToMessageId: null } });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_curia_draft', refusalKind: 'judgement' });
        expect(reports()).toEqual([expect.objectContaining({ summary: DIGEST('not_curia_draft') })]);
      });

      it('a limit stop never counts toward the cap or extends a cooldown', async () => {
        const { gw, ledger } = makeAuto();
        atCap(ledger);
        await gw.sendPrincipalDraft('d1', auto);
        expect(ledger.recordHeld).not.toHaveBeenCalled();
        expect(ledger.recordSending).not.toHaveBeenCalled();
      });

      it('a ledger-read failure during a cap stop files the waiting item, never Left as a draft', async () => {
        const { gw, ledger } = makeAuto();
        atCap(ledger);
        ledger.limitStopsSince.mockRejectedValue(new Error('db down'));
        await gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: 'Waiting only because of the daily limit: "Re: Friday" to Dana Example.' })]);
      });

      it('a thread cooldown files its own waiting text', async () => {
        const { gw, ledger } = makeAuto();
        ledger.recentForThread.mockResolvedValue([{ draftId: 'x', threadId: 'th1', mailbox: 'default', conversationIds: [], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'sent' }]);
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'thread_cooldown', refusalKind: 'limit' });
        expect(reports()).toEqual([expect.objectContaining({ summary: 'Waiting only because Curia already replied on this thread today: "Re: Friday" to Dana Example.' })]);
        expect(ledger.recordLimitStop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'thread_cooldown' }));
        expect(ledger.recordHeld).not.toHaveBeenCalled();
      });

      it('a cooldown caused by a judgement hold reads Waiting because Curia held an earlier reply; one caused by a send keeps already replied', async () => {
        const entry = (outcome: string) => [{ draftId: 'x', threadId: 'th1', mailbox: 'default', conversationIds: [], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome }];
        const held = makeAuto();
        held.ledger.recentForThread.mockResolvedValue(entry('held'));
        expect(await held.gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'thread_cooldown', refusalKind: 'limit' });
        expect(reports()).toEqual([expect.objectContaining({ summary: 'Waiting because Curia held an earlier reply on this thread today: "Re: Friday" to Dana Example.' })]);

        mocks = createMocks();
        const sent = makeAuto();
        sent.ledger.recentForThread.mockResolvedValue(entry('sent'));
        await sent.gw.sendPrincipalDraft('d1', auto);
        expect(reports()[0]!['summary']).toMatch(/^Waiting only because Curia already replied on this thread today/);
      });

      it('the notice marker is written only after the notice publishes; a failed publish retries it next time', async () => {
        const { gw, ledger } = makeAuto();
        atCap(ledger);
        vi.mocked(mocks.bus.publish).mockRejectedValueOnce(new Error('bus down'));
        await gw.sendPrincipalDraft('d1', auto);
        expect(ledger.recordLimitStop).not.toHaveBeenCalled();
        // Next stop: still the first, so the notice is filed again, then the marker is written.
        await gw.sendPrincipalDraft('d1', auto);
        // Both attempts (the failed one and the retry) carried the notice.
        expect(reports().map((r) => r['summary'])).toEqual([FIRST, FIRST]);
        expect(ledger.recordLimitStop).toHaveBeenCalledOnce();
      });

      it('every refusal code has its kind and digest heading', async () => {
        const kinds: Record<keyof typeof PRINCIPAL_SEND_REFUSALS, 'limit' | 'judgement' | 'other'> = {
          daily_cap: 'limit', thread_cooldown: 'limit',
          mailbox_unavailable: 'other', unknown_mailbox: 'other', ambiguous_mailbox: 'other', setting_off: 'other', not_requested: 'other',
          approval_replay: 'other', not_found: 'other', lookup_failed: 'other', send_unconfirmed: 'other', no_send_ledger: 'other',
          thread_unreadable: 'other', principal_addresses_unreadable: 'other', no_band_review: 'other',
          no_recipients: 'judgement', principal_only: 'judgement', review_hold: 'judgement', draft_changed: 'judgement',
          outsider_originated: 'judgement', origin_unknown: 'judgement', not_curia_draft: 'judgement', draft_changed_since_curia: 'judgement',
          not_a_reply: 'judgement', mailing_list: 'judgement', principal_address_recipient: 'judgement', reply_to_principal_address: 'judgement',
          recipient_not_on_thread: 'judgement', too_many_recipients: 'judgement', has_attachments: 'judgement', not_latest_message: 'judgement',
          financial_details: 'judgement',
        };
        const codes = Object.keys(PRINCIPAL_SEND_REFUSALS) as Array<keyof typeof PRINCIPAL_SEND_REFUSALS>;
        expect(Object.keys(kinds).sort()).toEqual([...codes].sort());
        for (const code of codes) {
          expect(refusalKindOf(code), code).toBe(kinds[code]);
          if (kinds[code] === 'limit' || !(code in PRINCIPAL_SEND_DIGEST_REASONS)) continue;
          mocks = createMocks();
          const { gw, client } = makeAuto();
          await (gw as unknown as { recordAutonomousStop(a: Record<string, unknown>): Promise<void> }).recordAutonomousStop({
            mailbox: client, mailboxId: 'default', conversationIds: [], draftId: 'd1', draft: autoDraft(), lookedUp: true,
            refusal: code, reason: PRINCIPAL_SEND_REFUSALS[code], reasonCode: code, kind: kinds[code], options: {},
          });
          const heading = kinds[code] === 'other' ? 'Not sent from your mailbox: ' : 'Left as a draft in your mailbox: ';
          expect(String(reports()[0]!['summary']), code).toMatch(new RegExp(`^${heading}`));
        }
      });

      it('appends the mailbox label only when there are two or more mailboxes', async () => {
        const mailboxLabels = { default: 'Work', personal: 'Personal' };
        const one = makeAuto({ mailboxLabels, mailboxIds: async () => ['default'] });
        one.ledger.recentForThread.mockResolvedValue([{ draftId: 'x', threadId: 'th1', conversationIds: [], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'sent' }]);
        await one.gw.sendPrincipalDraft('d1', auto);
        expect(reports()[0]!['summary']).toBe('Waiting only because Curia already replied on this thread today: "Re: Friday" to Dana Example.');

        mocks = createMocks();
        const two = makeAuto({ mailboxLabels, mailboxIds: async () => ['default', 'personal'], mailboxes: { default: autoClient(), personal: mailboxClient(null) } });
        two.ledger.recentForThread.mockResolvedValue([{ draftId: 'x', threadId: 'th1', conversationIds: [], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'sent' }]);
        await two.gw.sendPrincipalDraft('d1', { ...auto, mailbox: 'default' });
        expect(reports()[0]!['summary']).toBe('Waiting only because Curia already replied on this thread today: "Re: Friday" to Dana Example (Work).');
      });

      it('LIMIT_REFUSALS is exactly the cap and the thread cooldown', () => {
        expect([...LIMIT_REFUSALS].sort()).toEqual(['daily_cap', 'thread_cooldown']);
        expect(refusalKindOf('lookup_failed')).toBe('other');
        expect(refusalKindOf('mailing_list')).toBe('judgement');
      });
    });

    // ---- #2475 Task 18: limits across mailboxes ----
    describe('across mailboxes (#2475 Task 18)', () => {
      const addrs = { principalAddrs: [PRINCIPAL, 'personal@example.com'], mailboxAddresses: { default: PRINCIPAL } };
      const withIds = (over: Partial<NylasMessage> = {}) => inbound({
        headers: [...VERIFIED, { name: 'Message-ID', value: '<Root@Mail.Example>' }, { name: 'References', value: '<a@x> <Root@Mail.Example>' }], ...over,
      });

      it('refuses an autonomous send to another principal address', async () => {
        const { gw, client, ledger } = makeAuto({ ...addrs, client: autoClient(autoDraft({ cc: [{ email: 'Personal@Example.com' }] }), [withIds()]) });
        const r = await gw.sendPrincipalDraft('d1', auto);
        expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'principal_address_recipient' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(ledger.recordHeld).toHaveBeenCalledOnce();
        expect(ledger.recordHeld.mock.calls[0]![0]).toMatchObject({ mailbox: 'default', conversationIds: ['root@mail.example', 'a@x'] });
        expect(reports()).toEqual([expect.objectContaining({ summary: expect.stringContaining(PRINCIPAL_SEND_DIGEST_REASONS.principal_address_recipient) })]);
        expect(PRINCIPAL_SEND_DIGEST_REASONS.principal_address_recipient).toBe("Not sent on its own: it was addressed to your other email address. It's in your Drafts.");
      });

      it('refuses an autonomous reply to mail from a principal address', async () => {
        const fromOther = withIds({ from: [{ email: 'personal@example.com' }] });
        const { gw, client } = makeAuto({ ...addrs, client: autoClient(autoDraft(), [fromOther]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'reply_to_principal_address' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(PRINCIPAL_SEND_DIGEST_REASONS.reply_to_principal_address).toBe("Not sent on its own: it replies to mail from your other email address. It's in your Drafts.");
      });

      it('cooldown spans the same conversation in two mailboxes', async () => {
        const { gw, ledger, client } = makeAuto({ ...addrs, client: autoClient(autoDraft(), [withIds()]) });
        ledger.recentForConversation.mockResolvedValue([{ draftId: 'x', threadId: 'other', mailbox: 'personal', conversationIds: ['root@mail.example'], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'sent' }]);
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'thread_cooldown' });
        expect(ledger.recentForConversation).toHaveBeenCalledWith(['root@mail.example', 'a@x'], expect.any(Number), expect.any(Array));
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(ledger.recordHeld).not.toHaveBeenCalled();
      });

      it('a legacy ledger entry (no mailbox) still triggers the cooldown', async () => {
        const { gw, ledger } = makeAuto({ ...addrs });
        ledger.recentForThread.mockResolvedValue([{ draftId: 'x', threadId: 'th1', conversationIds: [], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'sent' }]);
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'thread_cooldown' });
      });

      it('a draft with no headers still gets the per-thread cooldown', async () => {
        // Authenticated, but with no Message-ID or References.
        const { gw, ledger } = makeAuto({ ...addrs, client: autoClient(autoDraft(), [inbound()]) });
        ledger.recentForThread.mockResolvedValue([{ draftId: 'x', threadId: 'th1', mailbox: 'default', conversationIds: [], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'held' }]);
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'thread_cooldown' });
        expect(ledger.recentForConversation).not.toHaveBeenCalled();
      });

      it('cap counts sends from every mailbox', async () => {
        const { gw, ledger } = makeAuto({ ...addrs });
        const at = new Date().toISOString();
        ledger.recentAutonomousSends.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({
          draftId: `x${i}`, threadId: `t${i}`, mailbox: i % 2 ? 'work' : 'personal', conversationIds: [], recipients: [], mode: 'autonomous', at, outcome: 'sent',
        })));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'daily_cap' });
      });

      it('the ledger entry carries the draft\'s mailbox and the conversation ids', async () => {
        const { gw, ledger } = makeAuto({ ...addrs, client: autoClient(autoDraft(), [withIds()]) });
        expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
        expect(ledger.recordSending.mock.calls[0]![0]).toMatchObject({ mailbox: 'default', conversationIds: ['root@mail.example', 'a@x'] });
      });

      it('R43: unknown own address and two principal addresses: a cc to either is refused', async () => {
        const two = { principalAddrs: [PRINCIPAL, 'personal@example.com'], mailboxAddresses: { default: '' } };
        const { gw, client } = makeAuto({ ...two, client: autoClient(autoDraft({ cc: [{ email: 'personal@example.com' }] }), [withIds()]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'principal_address_recipient' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('R43: a cc to the principal\'s primary address is refused too', async () => {
        const two = { principalAddrs: [PRINCIPAL, 'personal@example.com'], mailboxAddresses: { default: '' } };
        const { gw, client } = makeAuto({ ...two, client: autoClient(autoDraft({ cc: [{ email: PRINCIPAL }] }), [withIds()]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'principal_address_recipient' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('R43: reply_to_principal_address keeps its rule (no "other" addresses to answer)', async () => {
        const two = { principalAddrs: [PRINCIPAL, 'personal@example.com'], mailboxAddresses: { default: '' } };
        const fromOther = withIds({ from: [{ email: 'personal@example.com' }] });
        const { gw } = makeAuto({ ...two, client: autoClient(autoDraft(), [fromOther]) });
        expect((await gw.sendPrincipalDraft('d1', auto)).refusal).not.toBe('reply_to_principal_address');
      });

      it('refuses (no_send_ledger, fail closed) when the ledger cannot be listed, even with no thread', async () => {
        const { gw, ledger, client } = makeAuto({ client: autoClient(autoDraft({ threadId: '' }), []) });
        ledger.list.mockRejectedValue(new Error('db down'));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true });
        const lister = makeAuto();
        lister.ledger.list.mockRejectedValue(new Error('db down'));
        expect(await lister.gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'no_send_ledger' });
        expect(lister.client!.sendDraft).not.toHaveBeenCalled();
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('R43: unknown own address and one principal address: unchanged', async () => {
        const one = { principalAddrs: [PRINCIPAL], mailboxAddresses: { default: '' } };
        const { gw } = makeAuto({ ...one, client: autoClient(autoDraft({ cc: [{ email: PRINCIPAL }] }), [withIds()]) });
        expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
      });

      it('refuses and files a digest item when the principal addresses cannot be read (fail closed)', async () => {
        const { gw, client } = makeAuto({ principalAddrs: new Error('db down') });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'principal_addresses_unreadable' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(reports()).toHaveLength(1);
      });
    });

    it('7. refuses with no_send_ledger, kind other, when the ledger read fails (fail closed)', async () => {
      const { gw, ledger, client } = makeAuto();
      ledger.recentForThread.mockRejectedValue(new Error('db down'));
      const r = await gw.sendPrincipalDraft('d1', auto);
      expect(r).toMatchObject({ refusal: 'no_send_ledger', refusalKind: 'other', blockedReason: PRINCIPAL_SEND_REFUSALS.no_send_ledger });
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordLimitStop).not.toHaveBeenCalled();
      // Never says Curia already replied.
      expect(reports()).toEqual([expect.objectContaining({ summary: 'Not sent from your mailbox: "Re: Friday" to Dana Example. Curia couldn\'t check its send log. It\'s in your Drafts.' })]);
    });

    it('refuses a second autonomous send on the thread within 24h', async () => {
      const entries: Array<Record<string, unknown>> = [];
      const ledger = {
        recordSending: vi.fn(async (e: Record<string, unknown>) => { entries.push({ ...e, outcome: 'sending' }); }),
        recordSent: vi.fn().mockResolvedValue(undefined),
        recordHeld: vi.fn(async (e: Record<string, unknown>) => { entries.push({ ...e, outcome: 'held' }); }),
        list: vi.fn(async () => [...entries]),
        // Reads the shared scan (4th argument), as the real ledger does.
        recentForThread: vi.fn(async (threadId: string, _sinceEpochMs: number, _mailbox: string, scan?: readonly Record<string, unknown>[]) => (scan ?? entries).filter((e) => e['threadId'] === threadId)),
      };
      const { gw, client } = makeAuto({ ledger });
      const before = Date.now();
      expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
      expect(ledger.recentForThread).toHaveBeenCalledWith('th1', expect.any(Number), 'default', expect.any(Array));
      const since = ledger.recentForThread.mock.calls[0]![1] as number;
      expect(since).toBeGreaterThanOrEqual(before - 24 * 3600_000);
      expect(since).toBeLessThanOrEqual(Date.now() - 24 * 3600_000);

      const second = await gw.sendPrincipalDraft('d1', auto);
      expect(second).toMatchObject({ success: false, leftAsDraft: true, refusal: 'thread_cooldown' });
      expect(client!.sendDraft).toHaveBeenCalledOnce();
      // The cooldown refusal does not extend the cooldown.
      expect(ledger.recordHeld).not.toHaveBeenCalled();
    });

    it('8. reviews with the autonomous profile: all questions, the level\'s ceiling, the reply target as origin', async () => {
      const { gw, review } = makeAuto();
      await gw.sendPrincipalDraft('d1', auto);
      const target = inbound();
      expect(review).toHaveBeenCalledWith(expect.objectContaining({
        senderProfile: 'principal-mailbox', draftAuthor: 'curia', principalDirected: false, stakesCeiling: 'routine',
        origin: { content: expect.stringContaining('Does Friday at 10 work?'), at: new Date(target.date * 1000).toISOString(), senderVerified: true },
      }));
      expect(String((review.mock.calls[0]![0] as { origin: { content: string } }).origin.content)).not.toContain('<p>');

      mocks = createMocks();
      const all = makeAuto({ level: 'all' });
      await all.gw.sendPrincipalDraft('d1', auto);
      expect(all.review).toHaveBeenCalledWith(expect.objectContaining({ stakesCeiling: 'commitment' }));
    });

    it('8. takes senderVerified from the reply target\'s own headers, never defaulting to true', async () => {
      // Dana is on the thread through the principal's sent message; her reply carries no authentication.
      const sent = inbound({ id: 'm0', from: [{ email: PRINCIPAL }], to: [{ email: 'dana@example.org' }], folders: ['SENT'], date: nowSec() - 9000 });
      const unverified = inbound({ headers: [] });
      const { gw, review } = makeAuto({ client: autoClient(autoDraft(), [sent, unverified]) });
      expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
      expect(review).toHaveBeenCalledWith(expect.objectContaining({ origin: expect.objectContaining({ senderVerified: false }) }));
    });

    it('8. never sets stakesCeiling or origin on a principal-directed send', async () => {
      const { gw, review } = make({ createdByCuria: ['d1'], level: 'routine' });
      await gw.sendPrincipalDraft('d1', opts);
      const input = review.mock.calls[0]![0] as Record<string, unknown>;
      expect(input).not.toHaveProperty('stakesCeiling');
      expect(input).not.toHaveProperty('origin');
      expect(input).not.toHaveProperty('threadMessages');
    });

    it('passes the thread\'s non-draft messages to the review as text, with when each was sent', async () => {
      const sent = inbound({ id: 'm0', from: [{ email: PRINCIPAL }], to: [{ email: 'dana@example.org' }], folders: ['SENT'], body: '<p>Shall we meet this week?</p>', date: nowSec() - 9000 });
      const unsent = autoDraft({ id: 'd-old', folders: ['DRAFTS'], body: '<p>An unsent draft.</p>' });
      const { gw, review } = makeAuto({ client: autoClient(autoDraft(), [sent, inbound(), unsent]) });
      await gw.sendPrincipalDraft('d1', auto);
      // The review orders and bounds them (threadEvidence); the gateway passes what it read.
      const input = review.mock.calls[0]![0] as { threadMessages: Array<{ at?: string; text: string }> };
      expect(input.threadMessages).toEqual([
        { at: new Date(sent.date * 1000).toISOString(), text: 'Shall we meet this week?' },
        { at: new Date(inbound().date * 1000).toISOString(), text: 'Does Friday at 10 work?' },
      ]);
    });

    it('leaves out of the thread evidence a side reply the recipient never received', async () => {
      // The principal's reply-all on the same thread went to the CFO only.
      const side = inbound({
        id: 'm2', from: [{ email: PRINCIPAL }], to: [{ email: 'cfo@example.com' }], folders: ['SENT'],
        body: '<p>The multiple is 4.2x.</p>', date: nowSec() - 3600,
      });
      const { gw, review } = makeAuto({ level: 'all', score: 100, client: autoClient(autoDraft({ body: '<p>Bob said 4.2x.</p>' }), [inbound(), side]) });
      await gw.sendPrincipalDraft('d1', auto);
      const input = review.mock.calls[0]![0] as { threadMessages: Array<{ text: string }> };
      expect(input.threadMessages.map((m) => m.text)).toEqual(['Does Friday at 10 work?']);
      expect(JSON.stringify(input.threadMessages)).not.toContain('4.2x');
    });

    // Binding ruling (Task 7 review concern 3): under all at 100, a reply that passes on what the
    // thread does not show (memory, notes, another thread) is never sent.
    it('holds a reply the judge says shares information that isn\'t on the thread: held marker, digest item, not sent', async () => {
      const judgeReview = vi.fn().mockResolvedValue({
        ok: true, purpose: 'serving', stakes: 'commitment', stakesReason: 'Shares a deal term.',
        unsupportedClaims: [], unnecessaryItems: [], offThread: true, reason: 'The multiple is not on the thread.',
      });
      const real = new BandSendReview({
        judge: { review: judgeReview, isEnabled: () => true },
        evidence: { collect: vi.fn().mockResolvedValue({ unavailable: false, toolResults: [], principalBlock: null }) },
        limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createLogger('error'),
      });
      const body = '<p>Bob said the multiple is 4.2x.</p>';
      const { gw, client, ledger } = makeAuto({
        level: 'all', score: 100, review: vi.fn((input) => real.review(input)), client: autoClient(autoDraft({ body })),
      });
      const r = await gw.sendPrincipalDraft('d1', auto);
      const text = 'Held for the principal: it shares information that isn\'t on the thread, and Curia doesn\'t pass on new information without the principal.' + SUFFIX;
      expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'review_hold', blockedReason: text });
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordSending).not.toHaveBeenCalled();
      expect(ledger.recordHeld).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'th1', mode: 'autonomous', reasonCode: 'off-thread' }));
      expect(reports()).toEqual([expect.objectContaining({
        summary: `${LEAD} Held for you: it shares information that isn't on the thread, and Curia doesn't pass on new information without you.${IN_DRAFTS}`,
        urgency: 'digest',
      })]);
      // The judge was asked, with the thread's text beside the draft.
      const brief = judgeReview.mock.calls[0]![0] as { questions: string[]; evidence: { threadMessages: Array<{ text: string }> } };
      expect(brief.questions).toContain('off-thread');
      expect(brief.evidence.threadMessages.map((m) => m.text)).toEqual(['Does Friday at 10 work?']);
    });

    it('does not exclude the principal\'s phone from detection on an autonomous send', async () => {
      const piiRedactor = redactorFor([{ label: 'PHONE_NUMBER', text: '+1 (416) 555-0100' }, { label: 'EMAIL', text: 'Avery@Example.com' }]);
      const body = '<p>Call me at +1 (416) 555-0100 or write to Avery@Example.com.</p>';
      const { gw, review } = makeAuto({ piiRedactor, client: autoClient(autoDraft({ body })) });
      await gw.sendPrincipalDraft('d1', auto);
      // The phone is reviewed; the sending mailbox's own address is not a disclosure.
      expect(review).toHaveBeenCalledWith(expect.objectContaining({
        detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'body' })],
      }));
    });

    describe('the quoted message (security: the draft body is model-written)', () => {
      const SIGNED = inbound({ body: '<p>Does Friday at 10 work?</p><p>Dana Example<br>416-555-0199</p>' });
      const piiFound = [{ label: 'PHONE_NUMBER', text: '416-555-0199' }, { label: 'EMAIL', text: 'dana@example.org' }];

      it('exempts a genuine draft-reply quote of a thread message: the "got it" case sends at 85', async () => {
        const body = `<p>Got it, thanks.</p>${buildReplyQuote(SIGNED, 'UTC', { format: 'html' })}`;
        const { gw, review, client } = makeAuto({ piiRedactor: redactorFor(piiFound), client: autoClient(autoDraft({ body }), [SIGNED]) });
        expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
        expect((review.mock.calls[0]![0] as { detectedItems?: unknown[] }).detectedItems).toBeUndefined();
        expect(client!.sendDraft).toHaveBeenCalled();
      });

      it('exempts a genuine Gmail quote of a thread message', async () => {
        const body = `<p>Got it, thanks.</p>${GMAIL_QUOTE_FROM_DANA}${SIGNED.body}</blockquote></div>`;
        const { gw, review } = makeAuto({ piiRedactor: redactorFor(piiFound), client: autoClient(autoDraft({ body }), [SIGNED]) });
        expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
        expect((review.mock.calls[0]![0] as { detectedItems?: unknown[] }).detectedItems).toBeUndefined();
      });

      // Final fixes A10 (security review B4): a quote whose text is on no message every recipient
      // received is held before the review, whatever its personal data or the judge would say.
      const QUOTE_MISMATCH = "Its quoted text doesn't match the thread." + SUFFIX;

      it('holds a fake quote marker whose text is on no thread message, without asking the judge', async () => {
        const body = `<p>Got it.</p>${REPLY_QUOTE_HTML_OPEN}<p><strong>From:</strong> dana@example.org</p></div><blockquote>Sam's cell is 416-555-0199</blockquote>`;
        const review = vi.fn().mockResolvedValue({ kind: 'send' });
        const { gw, client, ledger } = makeAuto({ review, piiRedactor: redactorFor(piiFound), client: autoClient(autoDraft({ body }), [SIGNED]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'review_hold', blockedReason: QUOTE_MISMATCH });
        expect(review).not.toHaveBeenCalled();
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(ledger.recordHeld).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'quote-mismatch' }));
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} Its quoted text doesn't match the thread.${IN_DRAFTS}` })]);
      });

      it('holds a forged quote carrying an off-thread figure and no personal data, without the judge', async () => {
        const body = `<p>Thanks, noted.</p>${GMAIL_QUOTE_FROM_DANA}<p>Does Friday at 10 work? The multiple is 4.2x.</p></blockquote></div>`;
        const review = vi.fn().mockResolvedValue({ kind: 'send' });
        const { gw, client } = makeAuto({ level: 'all', score: 100, review, client: autoClient(autoDraft({ body })) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'review_hold', blockedReason: QUOTE_MISMATCH });
        expect(review).not.toHaveBeenCalled();
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('reviews a detail put in a genuine quote\'s header: the header is the draft\'s text, not the thread\'s', async () => {
        const quote = buildReplyQuote(SIGNED, 'UTC', { format: 'html' }).replace('<strong>Subject:</strong>', '<strong>Subject:</strong> call 416-555-0123 ');
        const body = `<p>Got it, thanks.</p>${quote}`;
        const found = [{ label: 'PHONE_NUMBER', text: '416-555-0123' }];
        const { gw, review } = makeAuto({ piiRedactor: redactorFor(found), client: autoClient(autoDraft({ body }), [SIGNED]) });
        await gw.sendPrincipalDraft('d1', auto);
        expect(review).toHaveBeenCalledWith(expect.objectContaining({
          detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'quote' })],
        }));
      });

      const HOLD_PII = { kind: 'hold', reason: 'Held for the principal: it shares a phone number.', findings: [{ rule: 'pii-not-authorized', detail: 'x' }] };

      it('reviews a phone number in an HTML comment inside a genuine quote: held, not sent', async () => {
        const quote = buildReplyQuote(SIGNED, 'UTC', { format: 'html' }).replace('</blockquote>', '<!-- 416-555-0123 --></blockquote>');
        const review = vi.fn().mockResolvedValue(HOLD_PII);
        const found = [{ label: 'PHONE_NUMBER', text: '416-555-0123' }];
        const { gw, client } = makeAuto({ review, piiRedactor: redactorFor(found), client: autoClient(autoDraft({ body: `<p>Got it.</p>${quote}` }), [SIGNED]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'review_hold' });
        expect(review).toHaveBeenCalledWith(expect.objectContaining({ detectedItems: [expect.objectContaining({ label: 'PHONE_NUMBER', field: 'quote' })] }));
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('reviews a phone number in an img src inside a genuine quote: held, not sent', async () => {
        const quote = buildReplyQuote(SIGNED, 'UTC', { format: 'html' }).replace('</blockquote>', '<img src="https://x.example/?n=416-555-0123"></blockquote>');
        const review = vi.fn().mockResolvedValue(HOLD_PII);
        const found = [{ label: 'PHONE_NUMBER', text: '416-555-0123' }];
        const { gw, client } = makeAuto({ review, piiRedactor: redactorFor(found), client: autoClient(autoDraft({ body: `<p>Got it.</p>${quote}` }), [SIGNED]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'review_hold' });
        expect(review).toHaveBeenCalledWith(expect.objectContaining({ detectedItems: [expect.objectContaining({ field: 'quote' })] }));
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('holds a quote of an earlier message that Bob, now a recipient, never received', async () => {
        const bob = inbound({ id: 'm2', from: [{ name: 'Bob', email: 'bob@example.org' }], body: '<p>Count me in.</p>', date: nowSec() - 3600 });
        const body = `<p>Got it, thanks.</p>${buildReplyQuote(SIGNED, 'UTC', { format: 'html' })}`;
        const { gw, review } = makeAuto({
          piiRedactor: redactorFor([{ label: 'PHONE_NUMBER', text: '416-555-0199' }]),
          client: autoClient(autoDraft({ body, cc: [{ email: 'bob@example.org' }] }), [SIGNED, bob]),
          curiaWrites: { created: true, lastWriteAt: new Date(), replyToMessageId: 'm2' },
        });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'review_hold', blockedReason: QUOTE_MISMATCH });
        expect(review).not.toHaveBeenCalled();
      });

      // Final fixes A2: a principal SENT message counts as received by each of its recipients.
      it('exempts a genuine quote of the principal\'s SENT message to every recipient: sent at 85', async () => {
        const toBoth = inbound({
          id: 'm0', from: [{ email: PRINCIPAL }], to: [{ email: 'dana@example.org' }], cc: [{ email: 'bob@example.org' }],
          folders: ['SENT'], headers: [], body: SIGNED.body, date: nowSec() - 9000,
        });
        const bob = inbound({ id: 'm2', from: [{ name: 'Bob', email: 'bob@example.org' }], body: '<p>Count me in.</p>', date: nowSec() - 3600 });
        const body = `<p>Got it, thanks.</p>${buildReplyQuote(toBoth, 'UTC', { format: 'html' })}`;
        const { gw, review, client } = makeAuto({
          piiRedactor: redactorFor(piiFound),
          client: autoClient(autoDraft({ body, cc: [{ email: 'bob@example.org' }] }), [toBoth, bob]),
          curiaWrites: { created: true, lastWriteAt: new Date(), replyToMessageId: 'm2' },
        });
        expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
        expect((review.mock.calls[0]![0] as { detectedItems?: unknown[] }).detectedItems).toBeUndefined();
        expect(client!.sendDraft).toHaveBeenCalled();
      });

      // Final fixes A2 (security review M3): a forged inbound Cc is no proof of receipt.
      it('does not count a forged inbound Cc as received: the quote holds and the message is not evidence', async () => {
        const intro = inbound({
          id: 'm0', from: [{ email: PRINCIPAL }], to: [{ email: 'dana@example.org' }, { email: 'cfo@example.org' }],
          folders: ['SENT'], headers: [], body: '<p>Dana, meet our CFO.</p>', date: nowSec() - 9000,
        });
        const forged = inbound({ cc: [{ email: 'cfo@example.org' }], body: '<p>Updated details: call 416-555-0199 to confirm.</p>' });
        const quoted = `<p>Thanks, received.</p>${buildReplyQuote(forged, 'UTC', { format: 'html' })}`;
        const held = makeAuto({
          piiRedactor: redactorFor(piiFound),
          client: autoClient(autoDraft({ body: quoted, cc: [{ email: 'cfo@example.org' }] }), [intro, forged]),
        });
        expect(await held.gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'review_hold', blockedReason: QUOTE_MISMATCH });
        expect(held.review).not.toHaveBeenCalled();

        mocks = createMocks();
        const plain = makeAuto({ client: autoClient(autoDraft({ body: '<p>Thanks, received.</p>', cc: [{ email: 'cfo@example.org' }] }), [intro, forged]) });
        await plain.gw.sendPrincipalDraft('d1', auto);
        const input = plain.review.mock.calls[0]![0] as { threadMessages: Array<{ text: string }> };
        expect(input.threadMessages.map((m) => m.text)).toEqual(['Dana, meet our CFO.']);
      });

      it('holds a quote marker with no quoted body (fail closed)', async () => {
        const body = '<p>Got it, thanks.</p><div class="gmail_quote">On Thu, someone wrote: call me at 416-555-0199</div>';
        const { gw, review } = makeAuto({ piiRedactor: redactorFor(piiFound), client: autoClient(autoDraft({ body }), [SIGNED]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'review_hold', blockedReason: QUOTE_MISMATCH });
        expect(review).not.toHaveBeenCalled();
      });
    });

    it('makes every non-bounce check stop final: content filter → held marker and one digest item', async () => {
      vi.mocked(mocks.contentFilter.check).mockResolvedValue({ passed: false, findings: [{ rule: 'secret-pattern', detail: 'x' }] });
      const { gw, client, ledger } = makeAuto();
      const r = await gw.sendPrincipalDraft('d1', auto);
      expect(r).toMatchObject({ success: false, leftAsDraft: true, blockedRules: ['secret-pattern'] });
      expect(r.blockedReason).toMatch(/Nothing was sent; the draft is still in their Drafts folder\.$/);
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordHeld).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'th1', mode: 'autonomous', reasonCode: 'secret-pattern' }));
      // Addendum R3: plain words, no rule name and none of the agent's notes.
      expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} Curia's content check stopped it.${IN_DRAFTS}` })]);
    });

    it('makes a blocked contact final: held marker and one digest item', async () => {
      vi.mocked(mocks.contactService.resolveByChannelIdentity).mockResolvedValue({
        contactId: 'c-dana', displayName: 'Dana', role: null, tier: 'blocked', kind: 'person', kgNodeId: null, verified: true,
      } as unknown as Awaited<ReturnType<ContactService['resolveByChannelIdentity']>>);
      const { gw, ledger } = makeAuto();
      const r = await gw.sendPrincipalDraft('d1', auto);
      expect(r).toMatchObject({ success: false, leftAsDraft: true, blockedReason: `Recipient is blocked.${SUFFIX}` });
      expect(ledger.recordHeld).toHaveBeenCalledOnce();
      expect(reports()).toHaveLength(1);
    });

    it('makes an identity-gate stop final', async () => {
      const { ConversationEntityState } = await import('../../../src/entity-context/conversation-entities.js');
      const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Avery Lee']);
      entities.turnIdentities.begin('t1');
      const body = '<p>He and Xiaopu (last name to be confirmed) would like to attend.</p>';
      const { gw, ledger } = makeAuto({ conversationEntities: entities, client: autoClient(autoDraft({ body })) });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, blockedRules: ['unresolved-identity'] });
      expect(ledger.recordHeld).toHaveBeenCalledOnce();
      expect(reports()).toHaveLength(1);
    });

    it('refuses with no_send_ledger when no send ledger is wired (fail closed)', async () => {
      const { gw, client } = makeAuto({ withoutLedger: true });
      const text = "The send record isn't available, so Curia won't send from the principal's mailbox on its own." + SUFFIX;
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'no_send_ledger', blockedReason: text });
      expect(PRINCIPAL_SEND_REFUSALS.no_send_ledger).toBe(text);
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(reports()).toEqual([expect.objectContaining({ summary: DIGEST('no_send_ledger') })]);
    });

    it('sends a routine ack at 85 and files one Sent-for-you digest item', async () => {
      const { gw, client, ledger, actionLogRepo } = makeAuto();
      const r = await gw.sendPrincipalDraft('d1', auto);
      expect(r).toEqual({ success: true, messageId: 'sent-1', threadId: 'th1', to: ['dana@example.org'], subject: 'Re: Friday' });
      expect(client!.sendDraft).toHaveBeenCalledWith('d1');
      expect(ledger.recordSending).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'd1', threadId: 'th1', recipients: ['dana@example.org'], mode: 'autonomous' }));
      expect(ledger.recordSent).toHaveBeenCalledWith('d1', 'sent-1');
      expect(ledger.recordHeld).not.toHaveBeenCalled();
      expect(reports()).toEqual([expect.objectContaining({
        summary: 'Sent for you from your mailbox: "Re: Friday" to Dana Example.', urgency: 'digest', source: 'principal_mailbox', conversationId: 'c1',
      })]);
      expect(published('principal.report')[0]).toMatchObject({ parentEventId: 't1', sourceLayer: 'dispatch' });
      // Autonomous sends join the spot-check pool under the tool's name.
      expect(vi.mocked(actionLogRepo.insertSampled).mock.calls.map((c) => (c[0] as { toolName: string }).toolName)).toEqual(['ceo-inbox-send-draft']);
    });

    it('names a recipient with no display name by address', async () => {
      const { gw } = makeAuto({ client: autoClient(autoDraft({ to: [{ email: 'dana@example.org' }], cc: [{ email: PRINCIPAL }] })) });
      await gw.sendPrincipalDraft('d1', auto);
      expect(reports()).toEqual([expect.objectContaining({ summary: 'Sent for you from your mailbox: "Re: Friday" to dana@example.org.' })]);
    });

    it('9. a review hold records a held marker and one Left-as-a-draft item', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'hold', reason: 'Held for the principal: it commits the principal.', findings: [{ rule: 'speaks-as-principal', detail: 'x' }] });
      const { gw, client, ledger } = makeAuto({ review });
      const r = await gw.sendPrincipalDraft('d1', auto);
      const text = `Held for the principal: it commits the principal.${SUFFIX}`;
      expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'review_hold', blockedReason: text });
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordSending).not.toHaveBeenCalled();
      expect(ledger.recordHeld).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'th1', mode: 'autonomous', reasonCode: 'speaks-as-principal' }));
      expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} Held for you: it commits you.${IN_DRAFTS}` })]);
    });

    it('files exactly one Left-as-a-draft item per held send', async () => {
      const holds = [
        { kind: 'hold', reason: 'Held for the principal: x.', findings: [{ rule: 'speaks-as-principal', detail: 'x' }] },
        { kind: 'block', reason: 'Not sent: x', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] },
        { kind: 'hold', reason: 'Held: Dana asked for a phone number.', findings: [{ rule: 'pii-not-authorized', detail: 'x' }], ask: { labels: ['PHONE_NUMBER'], requester: 'dana@example.org', counterparties: ['dana@example.org'] } },
      ];
      for (const decision of holds) {
        mocks = createMocks();
        const { gw } = makeAuto({ review: vi.fn().mockResolvedValue(decision) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'review_hold' });
        expect(published('principal.report')).toHaveLength(1);
        expect(String(reports()[0]!['summary'])).toMatch(/^Left as a draft in your mailbox: /);
      }
    });

    // Final fixes A1 (final review I1): triage never retries a refused send, so a bounce is final.
    it('9. a bounce is final: one held marker and one digest item with its findings, not sent', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'bounce', findings: [{ rule: 'ungrounded-claim', detail: 'not backed: "See you then."' }] });
      const { gw, client, ledger } = makeAuto({ review });
      const r = await gw.sendPrincipalDraft('d1', auto);
      expect(r).toMatchObject({ success: false, leftAsDraft: true, blockedRules: ['ungrounded-claim'] });
      expect(r.blockedReason).toBe(`The send review stopped this reply, and the stop is final: don't edit it or send it again. The principal will see why in their digest.${SUFFIX}`);
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordSending).not.toHaveBeenCalled();
      expect(ledger.recordHeld).toHaveBeenCalledOnce();
      expect(ledger.recordHeld).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'th1', mode: 'autonomous', reasonCode: 'ungrounded-claim' }));
      expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} It says things about you that Curia couldn't confirm.${IN_DRAFTS}` })]);
    });

    // Addendum R3: the real review's finding detail is drafter instructions; none of it reaches the digest.
    describe('a real bounce reaches the principal in plain words', () => {
      function realReview(answer: Record<string, unknown>) {
        const real = new BandSendReview({
          judge: {
            review: vi.fn().mockResolvedValue({ ok: true, purpose: 'serving', stakes: 'routine', stakesReason: 'Routine.', unsupportedClaims: [], unnecessaryItems: [], offThread: false, reason: 'x', ...answer }),
            isEnabled: () => true,
          },
          evidence: { collect: vi.fn().mockResolvedValue({ unavailable: false, toolResults: [], principalBlock: null }) },
          limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createLogger('error'),
        });
        return vi.fn((input) => real.review(input));
      }
      const body = '<p>The board approved it.</p>';

      it('a grounding bounce', async () => {
        const { gw } = makeAuto({ review: realReview({ unsupportedClaims: ['The board approved it.'] }), client: autoClient(autoDraft({ body })) });
        const r = await gw.sendPrincipalDraft('d1', auto);
        expect(r.blockedRules).toEqual(['ungrounded-claim']);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} It says things about you that Curia couldn't confirm.${IN_DRAFTS}` })]);
        // The agent is told the stop is final; nothing invites the rewrite the prompt forbids.
        expect(r.blockedReason).not.toMatch(/verify|remove them|rewrite/i);
        expect(r.blockedReason).toMatch(/final/);
      });

      it('an unneeded-detail bounce, and both reasons together with no rule names', async () => {
        const unneeded = makeAuto({ review: realReview({ unnecessaryItems: ['The board approved it.'] }), client: autoClient(autoDraft({ body })) });
        await unneeded.gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} It includes details the reply didn't need.${IN_DRAFTS}` })]);

        mocks = createMocks();
        const both = makeAuto({ review: realReview({ unsupportedClaims: ['The board approved it.'], unnecessaryItems: ['The board approved it.'] }), client: autoClient(autoDraft({ body })) });
        await both.gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} It says things about you that Curia couldn't confirm. It includes details the reply didn't need.${IN_DRAFTS}` })]);
      });

      it('any other bounced rule reads as a general reason', async () => {
        const { gw } = makeAuto({ review: vi.fn().mockResolvedValue({ kind: 'bounce', findings: [{ rule: 'redaction-token', detail: 'Rewrite it with the real content.' }] }) });
        await gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} Curia's review wasn't confident enough to send it.${IN_DRAFTS}` })]);
      });
    });

    // Addendum R3: every other way a check or review reaches the digest.
    describe('no rule names or drafter voice in any digest item', () => {
      it.each([
        ['a block after a rewrite', { kind: 'block', reason: 'Not sent: x', findings: [{ rule: 'ungrounded-claim', detail: 'Verify them with your tools.' }] }, "It says things about you that Curia couldn't confirm."],
        ['a personal-data hold', { kind: 'hold', reason: "Held for the principal: it shares personal details (phone number) for a task the principal set, not at their request in this conversation, and this band asks first.", findings: [{ rule: 'pii-not-authorized', detail: 'x' }] }, 'It shares personal details that need your OK first.'],
        ['a dropped quote', { kind: 'send', dropQuote: { labels: ['PHONE_NUMBER'] } }, 'It shares personal details that need your OK first.'],
      ])('%s', async (_name, decision, text) => {
        const { gw } = makeAuto({ review: vi.fn().mockResolvedValue(decision) });
        await gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} ${text}${IN_DRAFTS}` })]);
      });

      it('a blocked recipient, an unresolved name and a redactor error', async () => {
        vi.mocked(mocks.contactService.resolveByChannelIdentity).mockResolvedValue({
          contactId: 'c-dana', displayName: 'Dana', role: null, tier: 'blocked', kind: 'person', kgNodeId: null, verified: true,
        } as unknown as Awaited<ReturnType<ContactService['resolveByChannelIdentity']>>);
        const blocked = makeAuto();
        await blocked.gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} One of the recipients is blocked.${IN_DRAFTS}` })]);

        mocks = createMocks();
        const { ConversationEntityState } = await import('../../../src/entity-context/conversation-entities.js');
        const entities = ConversationEntityState.createInMemory({ get: () => undefined }, ['Avery Lee']);
        entities.turnIdentities.begin('t1');
        const named = makeAuto({ conversationEntities: entities, client: autoClient(autoDraft({ body: '<p>He and Xiaopu (last name to be confirmed) would like to attend.</p>' })) });
        await named.gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} It names someone Curia couldn't identify.${IN_DRAFTS}` })]);

        mocks = createMocks();
        const broken = redactorFor([]);
        broken.detect.mockImplementation(() => { throw new Error('boom'); });
        const failed = makeAuto({ piiRedactor: broken });
        await failed.gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} Curia couldn't check it for personal details.${IN_DRAFTS}` })]);
      });

      it('an off-thread hold beside a grounding finding names it in plain words', async () => {
        const real = new BandSendReview({
          judge: {
            review: vi.fn().mockResolvedValue({ ok: true, purpose: 'serving', stakes: 'routine', stakesReason: 'x', unsupportedClaims: ['Bob said 4.2x.'], unnecessaryItems: [], offThread: true, reason: 'x' }),
            isEnabled: () => true,
          },
          evidence: { collect: vi.fn().mockResolvedValue({ unavailable: false, toolResults: [], principalBlock: null }) },
          limiter: new FailOpenLimiter(), onLimiterTripped: vi.fn(), contactTier: vi.fn(), logger: createLogger('error'),
        });
        const { gw } = makeAuto({ level: 'all', score: 100, review: vi.fn((input) => real.review(input)), client: autoClient(autoDraft({ body: '<p>Bob said 4.2x.</p>' })) });
        await gw.sendPrincipalDraft('d1', auto);
        expect(reports()).toEqual([expect.objectContaining({
          summary: `${LEAD} Held for you: it shares information that isn't on the thread, and Curia doesn't pass on new information without you. It says things about you that Curia couldn't confirm.${IN_DRAFTS}`,
        })]);
      });
    });

    it('9. a principal-directed bounce is unchanged: no marker, no digest item', async () => {
      const review = vi.fn().mockResolvedValue({ kind: 'bounce', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] });
      const { gw, client, ledger } = make({ review, createdByCuria: ['d1'] });
      const r = await gw.sendPrincipalDraft('d1', opts);
      expect(r).toMatchObject({ success: false, leftAsDraft: true, blockedRules: ['ungrounded-claim'] });
      expect(client!.sendDraft).not.toHaveBeenCalled();
      expect(ledger.recordHeld).not.toHaveBeenCalled();
      expect(reports()).toHaveLength(0);
    });

    it('9. a failed digest publish is logged and does not change the outcome', async () => {
      vi.mocked(mocks.bus.publish).mockImplementation(async (_layer, event) => {
        if ((event as { type: string }).type === 'principal.report') throw new Error('bus down');
      });
      const sent = makeAuto();
      expect((await sent.gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
      const outsider = { originator: { contactId: 'c-dana', systemRole: null, channel: 'email', initiatedAt: '2026-11-07T10:00:00.000Z' } };
      const held = makeAuto();
      expect(await held.gw.sendPrincipalDraft('d1', { ...auto, authority: { taskMetadata: outsider } })).toMatchObject({ refusal: 'outsider_originated' });
    });

    it('9. a held-marker write failure does not change the refusal', async () => {
      const { gw, ledger } = makeAuto({ curiaWrites: { created: false, lastWriteAt: null, replyToMessageId: null } });
      ledger.recordHeld.mockRejectedValue(new Error('db down'));
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_curia_draft' });
      expect(reports()).toHaveLength(1);
    });

    it('writes no approval row for any autonomous outcome', async () => {
      const decisions = [
        { kind: 'send' },
        { kind: 'hold', reason: 'Held for the principal: x.', findings: [{ rule: 'speaks-as-principal', detail: 'x' }] },
        { kind: 'block', reason: 'Not sent: x', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] },
        { kind: 'bounce', findings: [{ rule: 'ungrounded-claim', detail: 'x' }] },
      ];
      for (const decision of decisions) {
        mocks = createMocks();
        const { gw, actionLogRepo } = makeAuto({ review: vi.fn().mockResolvedValue(decision) });
        await gw.sendPrincipalDraft('d1', auto);
        expect(actionLogRepo.insert).not.toHaveBeenCalled();
      }
    });

    it('does not promote contacts after an autonomous send', async () => {
      const { gw } = makeAuto();
      expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
      const { createContact } = mocks.contactService as unknown as { createContact: ReturnType<typeof vi.fn> };
      expect(createContact).not.toHaveBeenCalled();

      // A principal-directed send still does.
      mocks = createMocks();
      const pd = make();
      expect((await pd.gw.sendPrincipalDraft('d1', opts)).success).toBe(true);
      expect((mocks.contactService as unknown as { createContact: ReturnType<typeof vi.fn> }).createContact).toHaveBeenCalled();
    });

    it('a send whose outcome is unknown files one item saying so, not "left as a draft"', async () => {
      const client = autoClient();
      client.sendDraft.mockRejectedValue(new Error('Nylas 503'));
      const { gw, ledger } = makeAuto({ client });
      expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'send_unconfirmed' });
      expect(ledger.recordHeld).not.toHaveBeenCalled();
      expect(reports()).toEqual([expect.objectContaining({
        summary: `Tried to send for you from your mailbox: "Re: Friday" to Dana Example. The send didn't confirm, so it may or may not have gone out. Check your Sent folder before sending it again.`,
      })]);
    });

    // ---- Final fix wave (#2474 PR 2): code-enforced limits the reviews asked for ----

    describe('final fixes', () => {
      const IBAN = 'DE89 3704 0044 0532 0130 00';

      // A3 (security review M3 backstop): bank or card details never go out on Curia's own.
      it('A3. refuses a draft with an IBAN as financial_details: held marker, digest item, no review', async () => {
        const { gw, client, ledger, review } = makeAuto({ client: autoClient(autoDraft({ body: `<p>Noted: IBAN ${IBAN}.</p>` })) });
        const text = 'It contains bank or card details, which Curia never sends on its own.' + SUFFIX;
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'financial_details', blockedReason: text });
        expect(PRINCIPAL_SEND_REFUSALS.financial_details).toBe(text);
        expect(review).not.toHaveBeenCalled();
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(ledger.recordHeld).toHaveBeenCalledOnce();
        expect(reports()).toEqual([expect.objectContaining({ summary: `${LEAD} It contains bank or card details, which Curia never sends on its own.${IN_DRAFTS}` })]);
      });

      it('A3. refuses a card number the redactor detects, even inside a genuine, exempt quote', async () => {
        const signed = inbound({ body: '<p>Does Friday at 10 work?</p><p>Card on file 4111 1111 1111 1111</p>' });
        const body = `<p>Got it, thanks.</p>${buildReplyQuote(signed, 'UTC', { format: 'html' })}`;
        const piiRedactor = redactorFor([{ label: 'credit_card', text: '4111 1111 1111 1111' }]);
        const { gw, client, review } = makeAuto({ piiRedactor, client: autoClient(autoDraft({ body }), [signed]) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'financial_details' });
        expect(review).not.toHaveBeenCalled();
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      // Addendum: the backstop doesn't depend on outbound_redaction config.
      it.each([
        ['redaction disabled', { enabled: false, default: 'block' as const, channel_policies: {} }],
        ['credit_card allowed on email', { enabled: true, default: 'block' as const, channel_policies: { email: { allow: ['email', 'credit_card'] } } }],
      ])('A3. refuses a card number with %s', async (_name, config) => {
        const { PiiRedactor: RealRedactor } = await import('../../../src/dispatch/pii-redactor.js');
        const piiRedactor = new RealRedactor({ config: config as import('../../../src/dispatch/pii-redactor.js').OutboundRedactionConfig, bus: mocks.bus, logger: mocks.logger, extraPatterns: [] });
        const { gw, client } = makeAuto({ piiRedactor, client: autoClient(autoDraft({ body: '<p>Card on file 4111 1111 1111 1111.</p>' })) });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'financial_details' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('A3. leaves a principal-directed send with bank details to the review, as before', async () => {
        const { gw } = make({ createdByCuria: ['d1'], level: 'routine', client: mailboxClient(draft({ body: `<p>Our IBAN is ${IBAN}.</p>` })) });
        const r = await gw.sendPrincipalDraft('d1', opts);
        expect(r.refusal).not.toBe('financial_details');
      });

      // A4 (security review M2): at most 10 autonomous sends a day across every thread.
      it('A4. refuses past the daily cap: digest item, no held marker, not sent', async () => {
        const { gw, client, ledger, review } = makeAuto();
        const at = new Date().toISOString();
        ledger.recentAutonomousSends.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({
          draftId: `x${i}`, threadId: `t${i}`, recipients: [], mode: 'autonomous', at, outcome: 'sent',
        })));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'daily_cap' });
        expect(ledger.recentAutonomousSends).toHaveBeenCalledWith(expect.any(Number), expect.any(Array));
        // One ledger scan serves the cooldowns and the cap.
        expect(ledger.list).toHaveBeenCalledOnce();
        const since = ledger.recentAutonomousSends.mock.calls[0]![0] as number;
        expect(Date.now() - since).toBeGreaterThanOrEqual(24 * 3600_000 - 1000);
        expect(review).not.toHaveBeenCalled();
        expect(client!.sendDraft).not.toHaveBeenCalled();
        // A cap stop does not extend this thread's cooldown.
        expect(ledger.recordHeld).not.toHaveBeenCalled();
        // The first cap stop of the day files the limit notice (#2475 Task 19).
        expect(reports()).toEqual([expect.objectContaining({ summary: expect.stringMatching(/^Reached the daily limit of 10 replies/) })]);
      });

      it('A4. sends at nine earlier sends', async () => {
        const { gw, ledger } = makeAuto();
        const at = new Date().toISOString();
        ledger.recentAutonomousSends.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ({
          draftId: `x${i}`, threadId: `t${i}`, recipients: [], mode: 'autonomous', at, outcome: 'sent',
        })));
        expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
      });

      it('A4. refuses with no_send_ledger when the cap cannot be read (fail closed)', async () => {
        const { gw, client, ledger } = makeAuto();
        ledger.recentAutonomousSends.mockRejectedValue(new Error('db down'));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'no_send_ledger' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      // A5 (security review M2 + B6): bound to the message being triaged.
      it('A5. refuses a reply to an older message on the thread with not_latest_message', async () => {
        const later = inbound({ id: 'm2', body: '<p>Also, Saturday?</p>', date: nowSec() - 600 });
        const { gw, client, review, ledger } = makeAuto({ client: autoClient(autoDraft(), [inbound(), later]) });
        const text = "The reply doesn't answer the latest message on its thread, so Curia didn't send it on its own." + SUFFIX;
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'not_latest_message', blockedReason: text });
        expect(review).not.toHaveBeenCalled();
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(ledger.recordHeld).toHaveBeenCalledOnce();
        expect(reports()).toEqual([expect.objectContaining({ summary: DIGEST('not_latest_message') })]);
      });

      it('A5. refuses when the task recorded no answered message (fail closed)', async () => {
        const { gw, client } = makeAuto({ curiaWrites: { created: true, lastWriteAt: new Date(), replyToMessageId: null } });
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'not_latest_message' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
      });

      it('A5. reviews a reply to the latest message with that message as the origin', async () => {
        const later = inbound({ id: 'm2', body: '<p>Also, Saturday?</p>', date: nowSec() - 600 });
        const { gw, review } = makeAuto({
          client: autoClient(autoDraft(), [inbound(), later]),
          curiaWrites: { created: true, lastWriteAt: new Date(), replyToMessageId: 'm2' },
        });
        expect((await gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
        expect(review).toHaveBeenCalledWith(expect.objectContaining({
          origin: expect.objectContaining({ content: expect.stringContaining('Also, Saturday?') }),
        }));
      });

      // A7 (security review L1): the marker is the cooldown, so no marker means no autonomous send.
      it('A7. refuses with no_send_ledger before sending when the sending marker cannot be written', async () => {
        const { gw, client, ledger } = makeAuto();
        ledger.recordSending.mockRejectedValue(new Error('db down'));
        expect(await gw.sendPrincipalDraft('d1', auto)).toMatchObject({ success: false, leftAsDraft: true, refusal: 'no_send_ledger' });
        expect(client!.sendDraft).not.toHaveBeenCalled();
        expect(reports()).toEqual([expect.objectContaining({ summary: DIGEST('no_send_ledger') })]);
      });

      // A8 (security review B2): Spam and Trash are not the thread.
      it('A8. drops Spam and Trash messages from membership, evidence and the origin', async () => {
        const spam = inbound({ id: 'm-spam', from: [{ email: 'sam@example.org' }], folders: ['SPAM'], body: '<p>Spam text.</p>', date: nowSec() - 100 });
        const trash = inbound({ id: 'm-trash', folders: ['Trash'], body: '<p>Trashed text.</p>', date: nowSec() - 50 });
        // Sam wrote only in Spam: not a member.
        const stranger = makeAuto({ client: autoClient(autoDraft({ cc: [{ email: 'sam@example.org' }] }), [inbound(), spam, trash]) });
        expect(await stranger.gw.sendPrincipalDraft('d1', auto)).toMatchObject({ refusal: 'recipient_not_on_thread' });

        // The trashed message is newest but neither the latest message nor evidence.
        mocks = createMocks();
        const ok = makeAuto({ client: autoClient(autoDraft(), [inbound(), spam, trash]) });
        expect((await ok.gw.sendPrincipalDraft('d1', auto)).success).toBe(true);
        const input = ok.review.mock.calls[0]![0] as { threadMessages: Array<{ text: string }>; origin: { content: string } };
        expect(input.threadMessages.map((m) => m.text)).toEqual(['Does Friday at 10 work?']);
        expect(input.origin.content).toContain('Does Friday at 10 work?');
      });

      // A9 (security review B3): only the inbox check's own lineage may send on Curia's own.
      describe('A9. origin allowlist', () => {
        const at = '2026-11-07T10:00:00.000Z';
        const text = "Curia couldn't confirm this work came from its own inbox check, so it didn't send on its own." + SUFFIX;

        it.each([
          ['no task metadata', undefined],
          ['metadata with no originator', {}],
          ['a bullpen wake with no originator', { taskOrigin: 'bullpen', threadId: 'bp-1' }],
          ['principal lineage on a task that is not a live turn', { originator: { contactId: 'ceo', systemRole: 'principal', channel: 'scheduler', initiatedAt: at } }],
        ])('refuses %s with origin_unknown', async (_name, taskMetadata) => {
          const { gw, client, ledger } = makeAuto();
          const r = await gw.sendPrincipalDraft('d1', { ...auto, authority: { taskMetadata: taskMetadata as Record<string, unknown> | undefined } });
          expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'origin_unknown', blockedReason: text });
          expect(client!.sendDraft).not.toHaveBeenCalled();
          // Addendum: no marker, so a task of unknown origin can't burn the thread's cooldown.
          expect(ledger.recordHeld).not.toHaveBeenCalled();
          expect(reports()).toEqual([expect.objectContaining({ summary: DIGEST('origin_unknown') })]);
        });

        it('refuses a genuine agent lineage (an inbound from an agent-role contact) and a principal lineage the ladder demoted to agent', async () => {
          const { computeEffectiveTaskMetadata } = await import('../../../src/autonomy/effective-standing.js');
          const ladder = { sameTaskThreshold: 70, derivedChildThreshold: 90 };
          const principalWoken = computeEffectiveTaskMetadata(
            { originator: { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: at }, wakeContext: { derived: true } }, 85, ladder,
          );
          expect((principalWoken?.['originator'] as { systemRole: string }).systemRole).toBe('agent');
          const agentContact = { originator: { contactId: 'curia', systemRole: 'agent', channel: 'email', initiatedAt: at } };
          for (const taskMetadata of [principalWoken, agentContact]) {
            mocks = createMocks();
            const { gw, client } = makeAuto();
            const r = await gw.sendPrincipalDraft('d1', { ...auto, authority: { taskMetadata } });
            expect(r).toMatchObject({ success: false, leftAsDraft: true, refusal: 'origin_unknown' });
            expect(client!.sendDraft).not.toHaveBeenCalled();
          }
        });

        it('refuses a bullpen wake carrying an outsider\'s lineage with outsider_originated', async () => {
          const { gw, client } = makeAuto();
          const taskMetadata = { taskOrigin: 'bullpen', originator: { contactId: 'c-x', systemRole: null, channel: 'email', initiatedAt: at } };
          expect(await gw.sendPrincipalDraft('d1', { ...auto, authority: { taskMetadata } })).toMatchObject({ refusal: 'outsider_originated' });
          expect(client!.sendDraft).not.toHaveBeenCalled();
        });

        it('sends for the scheduled inbox check and for its woken drain task downgraded to agent lineage', async () => {
          const { computeEffectiveTaskMetadata } = await import('../../../src/autonomy/effective-standing.js');
          const woken = computeEffectiveTaskMetadata(
            { ...SYSTEM, wakeContext: { derived: true } }, 85, { sameTaskThreshold: 70, derivedChildThreshold: 90 },
          );
          expect((woken?.['originator'] as { systemRole: string }).systemRole).toBe('agent');
          for (const taskMetadata of [SYSTEM, woken]) {
            mocks = createMocks();
            const { gw } = makeAuto();
            expect((await gw.sendPrincipalDraft('d1', { ...auto, authority: { taskMetadata } })).success).toBe(true);
          }
        });
      });

      // A12 (final review M1): digest items are written for the principal.
      it('A12. no digest reason speaks of the principal in the third person', () => {
        for (const [code, text] of Object.entries(PRINCIPAL_SEND_DIGEST_REASONS)) {
          expect(text, code).not.toMatch(/the principal|their Drafts|ask the principal again/i);
          expect(text, code).toMatch(/It's in your Drafts\.$/);
        }
      });
    });
  });
});

describe('OutboundGateway.emailPrincipal (#2475)', () => {
  function build(
    getContact: ReturnType<typeof vi.fn>,
    // The work address is linked first; the primary email is the personal one.
    identities: ChannelIdentity[] = [makePrincipalIdentity('pat@work.example.com'), makePrincipalIdentity('pat@example.org')],
  ) {
    const m = createMocks();
    (m.contactService as unknown as { getContact: unknown }).getContact = getContact;
    const gateway = new OutboundGateway({
      nylasClients: new Map([['curia', m.nylasClient]]),
      contactService: m.contactService,
      contentFilter: m.contentFilter,
      bus: m.bus,
      principalIdentities: identities,
      logger: m.logger,
    });
    const send = vi.spyOn(gateway, 'send').mockResolvedValue({ success: true } as never);
    const call = () => (gateway as unknown as { emailPrincipal(s: string, b: string): Promise<void> }).emailPrincipal('Subject', 'Body');
    return { send, call };
  }

  it('sends to the primary email, not the first identity', async () => {
    const { send, call } = build(vi.fn().mockResolvedValue({ primaryEmail: 'pat@example.org' }));
    await call();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'pat@example.org' }), expect.anything());
  });

  it('falls back to the first verified identity when there is no primary email', async () => {
    const { send, call } = build(vi.fn().mockResolvedValue({ primaryEmail: null }));
    await call();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'pat@work.example.com' }), expect.anything());
  });

  it('falls back when the contact lookup fails', async () => {
    const { send, call } = build(vi.fn().mockRejectedValue(new Error('db down')));
    await call();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'pat@work.example.com' }), expect.anything());
  });

  it('skips a primary email whose identity is defunct, and one that is no identity at all', async () => {
    const defunct = { ...makePrincipalIdentity('pat@example.org'), status: 'defunct' as const };
    const first = build(vi.fn().mockResolvedValue({ primaryEmail: 'pat@example.org' }), [makePrincipalIdentity('pat@work.example.com'), defunct]);
    await first.call();
    expect(first.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'pat@work.example.com' }), expect.anything());

    const second = build(vi.fn().mockResolvedValue({ primaryEmail: 'old@example.net' }));
    await second.call();
    expect(second.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'pat@work.example.com' }), expect.anything());
  });
});
