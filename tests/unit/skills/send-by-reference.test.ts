// Send by reference, end to end (#2033): the real send-skill handlers, the real
// OutboundGateway, and an in-memory ContactService. Only the transports, the
// content filter and the bus are stubbed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { ContactService } from '../../../src/contacts/contact-service.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { SignalRpcClient } from '../../../src/channels/signal/signal-rpc-client.js';
import type { SmsClient } from '../../../src/channels/sms/sms-client.js';
import type { SlackClient } from '../../../src/channels/slack/slack-client.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { ToolContext, ToolHandler } from '../../../src/skills/types.js';
import { EmailSendHandler } from '../../../skills/email/tools/email-send/handler.js';
import { SignalSendHandler } from '../../../skills/signal-send/handler.js';
import { SmsSendHandler } from '../../../skills/sms-send/handler.js';
import { SlackSendHandler } from '../../../skills/slack-send/handler.js';

const logger = pino({ level: 'silent' });

// The principal's verified, active identities: what the alias may resolve to.
const PRINCIPAL_VERIFIED = {
  email: ['pat@work.example', 'pat@home.example'],
  signal: ['+15195550100'],
  sms: ['+15195550100'],
  slack: ['U0PRINCIPAL'],
};

interface Harness {
  contacts: ContactService;
  gateway: OutboundGateway;
  principalId: string;
  spouseId: string;
  nylasSend: ReturnType<typeof vi.fn>;
  signalSend: ReturnType<typeof vi.fn>;
  smsSend: ReturnType<typeof vi.fn>;
  slackPost: ReturnType<typeof vi.fn>;
  filterCheck: ReturnType<typeof vi.fn>;
  busPublish: ReturnType<typeof vi.fn>;
}

async function harness(extra?: Partial<ConstructorParameters<typeof OutboundGateway>[0]>): Promise<Harness> {
  const contacts = ContactService.createInMemory();

  const principal = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated', tier: 'known' });
  const link = (contactId: string, channel: string, channelIdentifier: string, extra?: Partial<{ verified: boolean; status: 'active' | 'defunct' | 'bounced' }>) =>
    contacts.linkIdentity({ contactId, channel, channelIdentifier, source: 'ceo_stated', ...extra });
  await link(principal.id, 'email', 'pat@work.example');
  await link(principal.id, 'email', 'pat@home.example');
  await link(principal.id, 'email', 'pat@old.example', { status: 'defunct' });
  await link(principal.id, 'email', 'pat@unverified.example', { verified: false });
  await link(principal.id, 'signal', '+15195550100');
  await link(principal.id, 'sms', '+15195550100');
  await link(principal.id, 'slack', 'U0PRINCIPAL');
  await contacts.updateContactFields(principal.id, { primaryEmail: 'pat@home.example' });

  // Same surname, adjacent number: the #727 shape. Never a valid target for "principal".
  const spouse = await contacts.createContact({ displayName: 'Sam Principal', source: 'ceo_stated', tier: 'known' });
  await link(spouse.id, 'email', 'sam@home.example');
  await link(spouse.id, 'signal', '+15195550199');

  // Same verified + active filter production uses for the principal snapshot.
  const principalIdentities: ChannelIdentity[] = ((await contacts.getContactWithIdentities(principal.id))?.identities ?? [])
    .filter((id) => id.verified && id.status === 'active');

  const nylasSend = vi.fn().mockResolvedValue({ id: 'msg-1' });
  const signalSend = vi.fn().mockResolvedValue('1700000000000');
  const smsSend = vi.fn().mockResolvedValue({ messageId: 'sms-1' });
  const slackPost = vi.fn().mockResolvedValue({ ok: true, ts: '1.1' });
  const filterCheck = vi.fn().mockResolvedValue({ passed: true, findings: [] });
  const busPublish = vi.fn().mockResolvedValue(undefined);

  const gateway = new OutboundGateway({
    nylasClients: new Map([['curia', { sendMessage: nylasSend } as unknown as NylasClient]]),
    signalClient: { send: signalSend, isConnected: () => true } as unknown as SignalRpcClient,
    signalPhoneNumber: '+15195550000',
    smsClient: { sendSms: smsSend } as unknown as SmsClient,
    slackClient: { postMessage: slackPost, isConnected: () => true } as unknown as SlackClient,
    contactService: contacts,
    contentFilter: { check: filterCheck } as unknown as OutboundContentFilter,
    bus: { publish: busPublish, subscribe: vi.fn() } as unknown as EventBus,
    principalIdentities,
    logger,
    ...extra,
  });

  return { contacts, gateway, principalId: principal.id, spouseId: spouse.id, nylasSend, signalSend, smsSend, slackPost, filterCheck, busPublish };
}

function ctx(h: Harness, input: Record<string, unknown>): ToolContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    outboundGateway: h.gateway,
    agentId: 'coordinator',
  } as unknown as ToolContext;
}

/** Every address any transport was asked to deliver to. */
function delivered(h: Harness): string[] {
  return [
    ...h.nylasSend.mock.calls.flatMap(([opts]) => [
      ...(opts as { to: Array<{ email: string }> }).to.map((r) => r.email),
      ...((opts as { cc?: Array<{ email: string }> }).cc ?? []).map((r) => r.email),
    ]),
    ...h.signalSend.mock.calls.flatMap(([opts]) => (opts as { recipient?: string[] }).recipient ?? []),
    ...h.smsSend.mock.calls.map(([opts]) => (opts as { to: string }).to),
    ...h.slackPost.mock.calls.map(([opts]) => (opts as { channel: string }).channel),
  ];
}

type Channel = keyof typeof PRINCIPAL_VERIFIED;

const SKILLS: Record<Channel, { handler: ToolHandler; input: (recipient: string) => Record<string, unknown> }> = {
  email: { handler: new EmailSendHandler(), input: (to) => ({ to, subject: 'Drafts', body: 'Here are the drafts.' }) },
  signal: { handler: new SignalSendHandler(), input: (recipient) => ({ recipient, message: 'Here are the drafts.' }) },
  sms: { handler: new SmsSendHandler(), input: (recipient) => ({ recipient, message: 'Here are the drafts.' }) },
  slack: { handler: new SlackSendHandler(), input: (recipient) => ({ recipient, message: 'Here are the drafts.' }) },
};

describe('send to the principal by reference (#2033 regression)', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it.each(Object.keys(SKILLS) as Channel[])('%s: "principal" is delivered only to a verified, active principal identity', async (channel) => {
    const skill = SKILLS[channel];
    const result = await skill.handler.execute(ctx(h, skill.input('principal')));
    expect(result.success).toBe(true);
    const sentTo = delivered(h);
    expect(sentTo).toHaveLength(1);
    expect(PRINCIPAL_VERIFIED[channel]).toContain(sentTo[0]);
  });

  it('email: "principal" goes to the designated primary address', async () => {
    const result = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input('principal')));
    expect(result.success).toBe(true);
    expect(delivered(h)).toEqual(['pat@home.example']);
    if (result.success) {
      expect(result.data).toMatchObject({ to: 'pat@home.example' });
      // The principal's contact ID stays out of the model's context (spec 09).
      expect(result.data).not.toHaveProperty('contact_id');
    }
  });

  it('email: cc by reference resolves too', async () => {
    const result = await SKILLS.email.handler.execute(ctx(h, { to: h.spouseId, cc: 'principal', subject: 'Hi', body: 'Hello' }));
    expect(result.success).toBe(true);
    expect(delivered(h)).toEqual(['sam@home.example', 'pat@home.example']);
  });

  it.each([
    ['a misspelled alias', 'principle'],
    ['an alias with trailing text', 'principal (Pat)'],
    ['a principal ID one character off', 'CORRUPT'],
    ['a copied template token', '${principal_contact_id}'],
  ])('fails closed and sends nothing for %s', async (_label, raw) => {
    const value = raw === 'CORRUPT' ? h.principalId.slice(0, -1) + (h.principalId.endsWith('0') ? '1' : '0') : raw;
    for (const channel of Object.keys(SKILLS) as Channel[]) {
      const skill = SKILLS[channel];
      const result = await skill.handler.execute(ctx(h, skill.input(value)));
      expect(result.success, `${channel} with ${value}`).toBe(false);
    }
    expect(delivered(h)).toEqual([]);
  });

  it('never resolves to an unverified or defunct principal address, even when it is the primary', async () => {
    await h.contacts.updateContactFields(h.principalId, { primaryEmail: 'pat@unverified.example' });
    const result = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input('principal')));
    expect(result.success).toBe(true);
    expect(delivered(h)).toEqual(['pat@work.example']);
  });

  it('an address in the reference field is rejected, not sent', async () => {
    const result = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input('pat@home.example')));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/to_address/);
    const signal = await SKILLS.signal.handler.execute(ctx(h, SKILLS.signal.input('+15195550100')));
    expect(signal.success).toBe(false);
    if (!signal.success) expect(signal.error).toMatch(/recipient_number/);
    expect(delivered(h)).toEqual([]);
  });
});

describe('recipient-aware block errors (#2033)', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  const AUDIENCE_LEAK = {
    passed: false,
    findings: [{ rule: 'llm-judge-audience-leak', detail: 'Content is intended for the principal' }],
  };

  it('a raw recipient one character off a known identity, blocked by the judge, names the recipient', async () => {
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);
    const result = await SKILLS.email.handler.execute(ctx(h, {
      to_address: 'pat@home.exampl',
      subject: 'Drafts',
      body: 'Here are the drafts.',
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      // The judge's reason is still there; the recipient check is added to it.
      expect(result.error).toContain('Content is intended for the principal');
      expect(result.error).toContain('pat@home.exampl matches no known contact');
      expect(result.error).toMatch(/"principal"/);
    }
    expect(delivered(h)).toEqual([]);

    // The principal's FYI says the same thing about the recipient.
    const notification = h.busPublish.mock.calls
      // bus.publish(layer, event)
      .map(([, event]) => event as { type: string; payload: { body?: string } })
      .find((event) => event.type === 'outbound.notification');
    expect(notification?.payload.body).toContain('Intended recipient: pat@home.exampl (matches no known contact)');
  });

  it('names an unmatched cc recipient on a raw-path block', async () => {
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);
    const result = await SKILLS.email.handler.execute(ctx(h, {
      to: 'principal',
      cc_addresses: 'sam@home.exampl',
      subject: 'Drafts',
      body: 'Here are the drafts.',
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('sam@home.exampl matches no known contact');
      expect(result.error).not.toContain('pat@home.example matches');
    }
  });

  it('flags a recipient that matches only an unverified identity, e.g. a typo delivered once before', async () => {
    // First send: the typo goes out and the gateway records an unverified outbound_recipient contact.
    await SKILLS.email.handler.execute(ctx(h, { to_address: 'pat@home.exampl', subject: 'Hi', body: 'Hello.' }));
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);

    const result = await SKILLS.email.handler.execute(ctx(h, { to_address: 'pat@home.exampl', subject: 'Drafts', body: 'Here.' }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('pat@home.exampl matches only an unverified contact address');
  });

  it('adds nothing when every recipient is a known contact', async () => {
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);
    const result = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(h.spouseId)));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toMatch(/matches no known contact/);
  });

  it('a blocked draft send names an unmatched recipient too', async () => {
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);
    const result = await h.gateway.sendEmailDraft('draft-1', undefined, {
      recipientEmail: 'pat@home.exampl',
      subject: 'Drafts',
      body: 'Here are the drafts.',
    });
    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('pat@home.exampl matches no known contact');
  });
});

describe('first-time outbound recipients get honest provenance (#2033)', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('records the new contact as outbound_recipient, unverified, tier known', async () => {
    const result = await SKILLS.email.handler.execute(ctx(h, {
      to_address: 'new.person@cold.example',
      subject: 'Introduction',
      body: 'Hello.',
    }));
    expect(result.success).toBe(true);

    const resolved = await h.contacts.resolveByChannelIdentity('email', 'new.person@cold.example');
    expect(resolved).not.toBeNull();
    // Tier stays known so the reply is not held; see ADR-047 and the follow-up.
    expect(resolved!.tier).toBe('known');
    const found = await h.contacts.getContactWithIdentities(resolved!.contactId);
    const identity = found!.identities.find((i) => i.channelIdentifier === 'new.person@cold.example');
    expect(identity).toMatchObject({ source: 'outbound_recipient', verified: false });
  });

  it('so a later send by reference to that contact fails closed until an address is verified', async () => {
    await SKILLS.email.handler.execute(ctx(h, { to_address: 'new.person@cold.example', subject: 'Hi', body: 'Hello.' }));
    const resolved = await h.contacts.resolveByChannelIdentity('email', 'new.person@cold.example');
    h.nylasSend.mockClear();

    const result = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(resolved!.contactId)));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/unverified, inactive/);
    expect(delivered(h)).toEqual([]);
  });
});

describe('approvals show the resolved recipient (#2033)', () => {
  it('the gateway autonomy gate shows the address of a send by reference, not the contact ID', async () => {
    const insert = vi.fn().mockResolvedValue(7);
    const h = await harness({
      autonomyService: { getConfig: vi.fn().mockResolvedValue({ score: 50 }) } as never,
      actionLogRepo: { insert, setNotificationSentAt: vi.fn().mockResolvedValue(undefined) } as never,
    });

    const result = await SKILLS.email.handler.execute({
      ...ctx(h, {
        to: h.spouseId,
        subject: 'Deck',
        body: 'Attached.',
        attachments: [{ file_url: 'file:///tmp/deck.pdf', filename: 'deck.pdf', content_type: 'application/pdf' }],
      }),
      taskEventId: 'task-approve-1',
    } as ToolContext);

    expect(result.success).toBe(false);
    // Nothing emailed. (The approval request itself is DM'd to the principal on Signal and Slack.)
    expect(h.nylasSend).not.toHaveBeenCalled();
    // The stored re-exec payload keeps the reference; approval re-resolves it.
    expect(insert.mock.calls[0]![0].payload).toMatchObject({ to: h.spouseId });
    const approval = h.busPublish.mock.calls
      .map(([, event]) => event as { type: string; payload: { notificationType?: string; body?: string } })
      .find((event) => event.type === 'outbound.notification' && event.payload.notificationType === 'approval_requested');
    expect(approval?.payload.body).toContain('sam@home.example');
    expect(approval?.payload.body).not.toContain(h.spouseId);
  });
});
