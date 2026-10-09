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
import type { ToolContext, ToolHandler, ToolManifest } from '../../../src/skills/types.js';
import { sourceKeyFor, sourceKeysInText } from '../../../src/contacts/identifier-provenance.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { EscalationJudge } from '../../../src/autonomy/escalation-judge.js';
import { EmailSendHandler } from '../../../skills/email/tools/email-send/handler.js';
import { SignalSendHandler } from '../../../skills/signal-send/handler.js';
import { SmsSendHandler } from '../../../skills/sms-send/handler.js';
import { SlackSendHandler } from '../../../skills/slack-send/handler.js';
import { ContactCreateHandler } from '../../../skills/contacts/tools/contact-create/handler.js';
import { ContactLinkIdentityHandler } from '../../../skills/contacts/tools/contact-link-identity/handler.js';

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
      expect(result.data).toMatchObject({ to: 'pat@home.example', to_identity: 'primary' });
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
    if (!result.success) expect(result.error).toMatch(/contact-create/);
    const signal = await SKILLS.signal.handler.execute(ctx(h, SKILLS.signal.input('+15195550100')));
    expect(signal.success).toBe(false);
    if (!signal.success) expect(signal.error).toMatch(/contact-create/);
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

  // No send skill takes an address any more (#2041), but the gateway does: scheduled
  // and system sends still reach it with one, so the block error is tested there.
  it('a gateway send to an address one character off a known identity, blocked by the judge, names the recipient', async () => {
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);
    const result = await h.gateway.send({
      channel: 'email',
      to: 'pat@home.exampl',
      subject: 'Drafts',
      body: 'Here are the drafts.',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The judge's reason is still there; the recipient check is added to it.
      expect(result.blockedReason).toContain('Content is intended for the principal');
      expect(result.blockedReason).toContain('pat@home.exampl matches no known contact');
      expect(result.blockedReason).toMatch(/"principal"/);
    }
    expect(delivered(h)).toEqual([]);

    // The principal's FYI says the same thing about the recipient.
    const notification = h.busPublish.mock.calls
      // bus.publish(layer, event)
      .map(([, event]) => event as { type: string; payload: { body?: string } })
      .find((event) => event.type === 'outbound.notification');
    expect(notification?.payload.body).toContain('Intended recipient: pat@home.exampl (matches no known contact)');
  });

  it('names an unmatched cc recipient on a gateway block', async () => {
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);
    const result = await h.gateway.send({
      channel: 'email',
      to: 'pat@home.example',
      cc: ['sam@home.exampl'],
      subject: 'Drafts',
      body: 'Here are the drafts.',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.blockedReason).toContain('sam@home.exampl matches no known contact');
      expect(result.blockedReason).not.toContain('pat@home.example matches');
    }
  });

  it('flags a recipient that matches only an unverified identity, e.g. a typo delivered once before', async () => {
    // First send: the typo goes out and the gateway records an unverified outbound_recipient contact.
    await h.gateway.send({ channel: 'email', to: 'pat@home.exampl', subject: 'Hi', body: 'Hello.' });
    h.filterCheck.mockResolvedValue(AUDIENCE_LEAK);

    const result = await h.gateway.send({ channel: 'email', to: 'pat@home.exampl', subject: 'Drafts', body: 'Here.' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.blockedReason).toContain('pat@home.exampl matches only an unverified contact address');
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
    const result = await h.gateway.send({
      channel: 'email',
      to: 'new.person@cold.example',
      subject: 'Introduction',
      body: 'Hello.',
    });
    expect(result.success).toBe(true);

    const resolved = await h.contacts.resolveByChannelIdentity('email', 'new.person@cold.example');
    expect(resolved).not.toBeNull();
    // Tier stays known so the reply is not held; see ADR-047 and the follow-up.
    expect(resolved!.tier).toBe('known');
    const found = await h.contacts.getContactWithIdentities(resolved!.contactId);
    const identity = found!.identities.find((i) => i.channelIdentifier === 'new.person@cold.example');
    expect(identity).toMatchObject({ source: 'outbound_recipient', verified: false });
  });

  it('records an email-reply recipient as verified email_participant, so a later send by contact ID goes out (#2071)', async () => {
    const address = 'reply.person@cold.example';
    const created = await h.gateway.send(
      {
        channel: 'email',
        to: address,
        subject: 'Re: Venue',
        body: 'The 14th works.',
        replyToMessageId: 'msg-1',
      },
      { recipientSource: 'email_participant' },
    );
    expect(created.success).toBe(true);

    const resolved = await h.contacts.resolveByChannelIdentity('email', address);
    expect(resolved).not.toBeNull();
    expect(resolved!.tier).toBe('known');
    const found = await h.contacts.getContactWithIdentities(resolved!.contactId);
    const identity = found!.identities.find((i) => i.channelIdentifier === address);
    expect(identity).toMatchObject({ source: 'email_participant', verified: true });

    h.nylasSend.mockClear();
    const result = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(resolved!.contactId)));
    expect(result.success).toBe(true);
    expect(delivered(h)).toEqual([address]);
  });

  it('replyToMessageId alone does not verify the new contact (#2071)', async () => {
    const address = 'threaded.person@cold.example';
    const created = await h.gateway.send({
      channel: 'email',
      to: address,
      subject: 'Re: Venue',
      body: 'The 14th works.',
      replyToMessageId: 'msg-1',
    });
    expect(created.success).toBe(true);

    const resolved = await h.contacts.resolveByChannelIdentity('email', address);
    const found = await h.contacts.getContactWithIdentities(resolved!.contactId);
    const identity = found!.identities.find((i) => i.channelIdentifier === address);
    expect(identity).toMatchObject({ source: 'outbound_recipient', verified: false });
  });

  it('so a later send by reference to that contact fails closed until an address is verified', async () => {
    await h.gateway.send({ channel: 'email', to: 'new.person@cold.example', subject: 'Hi', body: 'Hello.' });
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

describe('label hint (#2047)', () => {
  const WORK = {
    email: 'vendor.work@hint.test',
    signal: '+15195551111',
    sms: '+15195551111',
    slack: 'UWORK0001',
  };
  const PERSONAL = {
    email: 'vendor.home@hint.test',
    signal: '+15195552222',
    sms: '+15195553333',
    slack: 'UHOME0001',
  };

  async function labelledPerson(h: Harness) {
    const person = await h.contacts.createContact({ displayName: 'Pat Vendor', source: 'ceo_stated', tier: 'known' });
    const link = (channel: string, channelIdentifier: string, label: string) =>
      h.contacts.linkIdentity({ contactId: person.id, channel, channelIdentifier, label, source: 'ceo_stated' });
    await link('email', WORK.email, 'work');
    await link('email', PERSONAL.email, 'personal');
    await link('signal', WORK.signal, 'work');
    await link('signal', PERSONAL.signal, 'personal');
    await link('sms', WORK.sms, 'work');
    await link('sms', PERSONAL.sms, 'personal');
    await link('slack', WORK.slack, 'work');
    await link('slack', PERSONAL.slack, 'personal');
    await h.contacts.updateContactFields(person.id, { primaryEmail: WORK.email, primaryPhone: WORK.signal });
    return person;
  }

  it.each(Object.keys(SKILLS) as Channel[])('%s: a label hint selects that identity and the result names it', async (channel) => {
    const h = await harness();
    const person = await labelledPerson(h);
    const skill = SKILLS[channel];
    const result = await skill.handler.execute(ctx(h, skill.input(`${person.id}#personal`)));
    expect(result.success).toBe(true);
    expect(delivered(h)).toEqual([PERSONAL[channel]]);
    if (result.success) {
      const identityKey = channel === 'email' ? 'to_identity' : 'recipient_identity';
      expect(result.data).toMatchObject({ [identityKey]: 'personal' });
    }
  });

  it('a hint on a single unlabelled address sends to it', async () => {
    const h = await harness();
    const sam = await h.contacts.createContact({ displayName: 'Sam Only', source: 'ceo_stated', tier: 'known' });
    await h.contacts.linkIdentity({
      contactId: sam.id, channel: 'email', channelIdentifier: 'sam.only@hint.test', source: 'ceo_stated',
    });
    const result = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(`${sam.id}#personal`)));
    expect(result.success).toBe(true);
    expect(delivered(h)).toEqual(['sam.only@hint.test']);
    if (result.success) expect(result.data).toMatchObject({ to_identity: 'unlabelled' });
  });

  it('email cc takes a label hint on each entry', async () => {
    const h = await harness();
    const pat = await labelledPerson(h);
    const other = await h.contacts.createContact({ displayName: 'Other Vendor', source: 'ceo_stated', tier: 'known' });
    await h.contacts.linkIdentity({
      contactId: other.id, channel: 'email', channelIdentifier: 'other.work@hint.test', label: 'work', source: 'ceo_stated',
    });
    await h.contacts.linkIdentity({
      contactId: other.id, channel: 'email', channelIdentifier: 'other.home@hint.test', label: 'personal', source: 'ceo_stated',
    });
    await h.contacts.updateContactFields(other.id, { primaryEmail: 'other.home@hint.test' });

    const result = await SKILLS.email.handler.execute(ctx(h, {
      to: h.spouseId,
      cc: `${pat.id}#personal, ${other.id}#work`,
      subject: 'Hi',
      body: 'Hello',
    }));
    expect(result.success).toBe(true);
    expect(delivered(h)).toEqual(['sam@home.example', PERSONAL.email, 'other.work@hint.test']);
    if (result.success) expect(result.data).toMatchObject({ cc_identities: ['personal', 'work'] });
  });

  it('the skill, Gate C and the approval display resolve the same hinted identity', async () => {
    const h = await harness();
    const pat = await labelledPerson(h);
    const reference = `${pat.id}#personal`;
    const input = { to: reference, subject: 'Hi', body: 'Hello' };

    const sent = await SKILLS.email.handler.execute(ctx(h, input));
    expect(sent.success).toBe(true);
    expect(delivered(h)).toEqual([PERSONAL.email]);
    if (sent.success) expect(sent.data).toMatchObject({ to: PERSONAL.email, to_identity: 'personal' });

    const manifest: ToolManifest = {
      name: 'email-send',
      description: 'email-send description',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'medium',
      inputs: {},
      outputs: {},
      permissions: [],
      secrets: [],
      timeout: 5000,
    };
    const origin = {
      senderId: PERSONAL.email,
      taskMetadata: {
        originator: {
          contactId: 'contact-abc',
          systemRole: null,
          channel: 'email',
          initiatedAt: new Date().toISOString(),
          tier: 'known' as const,
        },
      },
    };
    const classifyAction = vi.fn().mockResolvedValue({
      decision: 'escalate',
      actionClass: 'reversible-external',
      isThirdPartyFacing: true,
      reason: 'stub',
    });
    const gateRegistry = new ToolRegistry();
    const gateHandler = { execute: vi.fn().mockResolvedValue({ success: true, data: {} }) };
    gateRegistry.register(manifest, gateHandler);
    const gate = new ExecutionLayer(gateRegistry, logger, {
      autonomyService: { getConfig: vi.fn().mockResolvedValue({ score: 100 }) } as never,
      bus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as never,
      escalationJudge: { classifyAction, isEnabled: () => true } as unknown as EscalationJudge,
      contactService: h.contacts,
    });
    const gated = await gate.invoke('email-send', input, undefined, origin);
    expect(gated.success).toBe(true);
    expect(gateHandler.execute).toHaveBeenCalledOnce();
    const description = (classifyAction.mock.calls[0]![0] as { description: string }).description;
    expect(description).toContain(`Resolved recipients: ${JSON.stringify([PERSONAL.email])}`);
    expect(description).not.toContain(WORK.email);

    const request = vi.fn().mockResolvedValue({ created: true, shortRef: 'e-1', notificationSent: true });
    const approvalRegistry = new ToolRegistry();
    approvalRegistry.register(manifest, { execute: vi.fn().mockResolvedValue({ success: true, data: {} }) });
    const approval = new ExecutionLayer(approvalRegistry, logger, {
      autonomyService: { getConfig: vi.fn().mockResolvedValue({ score: 65 }) } as never,
      bus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as never,
      approvalTrigger: { request } as never,
      contactService: h.contacts,
    });
    const held = await approval.invoke('email-send', input, undefined, { ...origin, taskEventId: 'task-hint-1' });
    expect(held.success).toBe(false);
    const shown = (request.mock.calls[0]![0] as { displayInput: { to: string }; sendResolution?: Array<{ ref: string; identityName: string; identityId: string }> }).displayInput.to;
    expect(shown.startsWith(PERSONAL.email)).toBe(true);
    expect(shown).not.toContain(WORK.email);
    const filed = await h.contacts.getContactWithIdentities(pat.id);
    const personalId = filed?.identities.find((identity) => identity.channelIdentifier === PERSONAL.email)?.id;
    expect(request.mock.calls[0]![0]).toMatchObject({
      sendResolution: [{ ref: reference, identityId: personalId, identityName: 'personal' }],
    });
  });
});

/**
 * A contact-skill call in a task where the principal said `said` (#2061): the runtime would
 * offer exactly the identifiers in it as sources. With nothing said, nothing has a source.
 */
function contactCtx(h: Harness, input: Record<string, unknown>, said = ''): ToolContext {
  const keys = sourceKeysInText(said);
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: h.contacts,
    identifierSources: { has: async (channel: string, identifier: string) => keys.has(sourceKeyFor(channel, identifier)) },
  } as unknown as ToolContext;
}

describe('cold outreach creates a contact first (#2041)', () => {
  let h: Harness;
  beforeEach(async () => { h = await harness(); });

  it('contact-create, then email-send to the returned ID, reaches the address that was entered', async () => {
    const created = await new ContactCreateHandler().execute(contactCtx(h, {
      name: 'Dana Whitfield', email: 'Dana.Whitfield@NewCo.example',
    }, 'Email Dana Whitfield at Dana.Whitfield@NewCo.example'));
    expect(created.success).toBe(true);
    if (!created.success) return;
    const contactId = (created.data as { contact_id: string }).contact_id;

    const sent = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(contactId)));

    expect(sent.success).toBe(true);
    expect(delivered(h)).toEqual(['dana.whitfield@newco.example']);
    if (sent.success) expect(sent.data).toMatchObject({ contact_id: contactId });
  });

  it('a typo of the address the principal gave is refused, so no contact exists to send to (#2061)', async () => {
    const before = (await h.contacts.listContacts()).length;
    const created = await new ContactCreateHandler().execute(contactCtx(h, {
      name: 'Dana Whitfield', email: 'dana.whitfield@newco.exmaple',
    }, 'Email Dana Whitfield at dana.whitfield@newco.example'));
    expect(created.success).toBe(false);
    if (!created.success) expect(created.error).not.toContain('newco.exmaple');
    expect(await h.contacts.listContacts()).toHaveLength(before);
    expect(delivered(h)).toEqual([]);
  });

  it('a number entered in local form is stored as E.164 and reachable by sms-send', async () => {
    const created = await new ContactCreateHandler().execute(contactCtx(h, { name: 'Lee Park', sms: '(416) 555-0123' }, 'Text Lee at (416) 555-0123'));
    expect(created.success).toBe(true);
    if (!created.success) return;
    const contactId = (created.data as { contact_id: string }).contact_id;

    const sent = await SKILLS.sms.handler.execute(ctx(h, SKILLS.sms.input(contactId)));

    expect(sent.success).toBe(true);
    expect(delivered(h)).toEqual(['+14165550123']);
  });

  it('a near-miss of a known address is refused, naming that contact, and no contact is created', async () => {
    const before = (await h.contacts.listContacts()).length;
    const created = await new ContactCreateHandler().execute(contactCtx(h, { name: 'Sam P', email: 'sam@home.exampel' }));
    expect(created.success).toBe(false);
    if (!created.success) {
      expect(created.error).toContain(h.spouseId);
      expect(created.error).toContain('similar email address');
      expect(created.error).not.toContain('sam@home.example');
    }
    const after = await h.contacts.listContacts();
    expect(after).toHaveLength(before);
    expect(after.filter((contact) => contact.displayName === 'Sam P')).toEqual([]);
  });

  it('a second create with a near-miss of the address just created is refused, naming that contact', async () => {
    const first = await new ContactCreateHandler().execute(contactCtx(h, {
      name: 'Dana Whitfield', email: 'dana.whitfield@newco.example',
    }, 'Email Dana Whitfield at dana.whitfield@newco.example'));
    expect(first.success).toBe(true);
    if (!first.success) return;
    const danaId = (first.data as { contact_id: string }).contact_id;

    const second = await new ContactCreateHandler().execute(contactCtx(h, {
      name: 'D. Whitfield', email: 'dana.whitfeld@newco.example',
    }));
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toContain(`"Dana Whitfield" (${danaId}): similar email address`);
      expect(second.error).not.toContain('dana.whitfield@newco.example');
    }
  });

  it("a typo of the principal's address is caught as the principal, without the principal's contact ID", async () => {
    const principal = await h.contacts.getContact(h.principalId);
    await h.contacts.saveContact({ ...principal!, systemRole: 'principal' });

    const created = await new ContactCreateHandler().execute(contactCtx(h, { name: 'Pat', email: 'pat@home.exampel' }));

    expect(created.success).toBe(false);
    if (!created.success) {
      expect(created.error).toContain('the principal');
      expect(created.error).not.toContain(h.principalId);
      expect(created.error).not.toContain('pat@home.example');
      expect(created.error).not.toContain('pat@work.example');
    }
  });

  it('re-stating a first-time recipient makes it reachable by reference', async () => {
    await h.gateway.send({ channel: 'email', to: 'new.person@cold.example', subject: 'Hi', body: 'Hello.' });
    const resolved = await h.contacts.resolveByChannelIdentity('email', 'new.person@cold.example');
    h.nylasSend.mockClear();

    const before = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(resolved!.contactId)));
    expect(before.success).toBe(false);
    if (!before.success) {
      expect(before.error).toMatch(/has no verified, active email address/);
      // The gateway named the contact after its address; the error must not quote it.
      expect(before.error).not.toContain('cold.example');
    }

    const restated = await new ContactLinkIdentityHandler().execute(contactCtx(h, {
      contact_id: resolved!.contactId, channel: 'email', identifier: 'new.person@cold.example',
    }, 'Yes, new.person@cold.example is the right address'));
    expect(restated).toMatchObject({ success: true, data: { already_linked: true, verified: true } });

    const after = await SKILLS.email.handler.execute(ctx(h, SKILLS.email.input(resolved!.contactId)));
    expect(after.success).toBe(true);
    expect(delivered(h)).toEqual(['new.person@cold.example']);
  });
});
