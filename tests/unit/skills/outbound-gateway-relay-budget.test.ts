// The relay budget in OutboundGateway.send() (#1320): an outside contact can cause only so many
// immediate messages to the principal; the rest go to the digest.
import { describe, it, expect, vi } from 'vitest';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { RelayBudget } from '../../../src/autonomy/relay-budget.js';
import { createLogger } from '../../../src/logger.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import type { SignalRpcClient } from '../../../src/channels/signal/signal-rpc-client.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';
import { readFile, realpath } from 'node:fs/promises';

// Attachment reads go through node:fs; stubbed so an email with an attachment can be sent.
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), realpath: vi.fn() }));

const PRINCIPAL_EMAIL = 'principal@example.com';
const DANA_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRINCIPAL_SIGNAL = '+15195550100';

function principalIdentity(channel: 'email' | 'signal', channelIdentifier: string) {
  return {
    id: `pi-${channel}`, contactId: 'principal-contact', channel, channelIdentifier, label: null,
    verified: true, verifiedAt: null, source: 'ceo_stated' as const, status: 'active' as const,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

function outsider(over: Partial<TaskOriginator> = {}): TaskOriginator {
  return { contactId: DANA_ID, systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known', ...over };
}

function makeGateway(opts: {
  perHour?: number;
  publish?: (layer: string, event: BusEvent) => Promise<void>;
  getContact?: ContactService['getContact'];
  filterPasses?: boolean;
} = {}) {
  const sendMessage = vi.fn().mockResolvedValue({ id: 'msg-1' });
  const signalSend = vi.fn().mockResolvedValue(undefined);
  const logger = createLogger('error');
  // child() returns the same logger, so warn calls from the gateway's child logger can be inspected.
  vi.spyOn(logger, 'child').mockReturnValue(logger as unknown as ReturnType<typeof logger.child>);
  const warn = vi.spyOn(logger, 'warn');
  const published: BusEvent[] = [];
  const publish = vi.fn(async (layer: string, event: BusEvent) => {
    if (opts.publish) await opts.publish(layer, event);
    published.push(event);
  });
  const contentFilter = {
    check: vi.fn().mockResolvedValue(opts.filterPasses === false
      ? { passed: false, findings: [{ rule: 'secret-pattern', detail: 'x' }] }
      : { passed: true, findings: [] }),
  };
  const budget = new RelayBudget({ perHour: opts.perHour ?? 1 });
  const gateway = new OutboundGateway({
    nylasClients: new Map([['curia', { sendMessage } as unknown as NylasClient]]),
    signalClient: { send: signalSend, isConnected: () => true } as unknown as SignalRpcClient,
    signalPhoneNumber: '+10000000000',
    contactService: {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
      getContact: opts.getContact ?? vi.fn().mockResolvedValue({ id: DANA_ID, displayName: 'Dana Example' }),
    } as unknown as ContactService,
    contentFilter: contentFilter as unknown as OutboundContentFilter,
    bus: { publish, subscribe: vi.fn() } as unknown as EventBus,
    principalIdentities: [principalIdentity('email', PRINCIPAL_EMAIL), principalIdentity('signal', PRINCIPAL_SIGNAL)],
    logger,
    relayBudget: budget,
  });
  const reports = () => published.filter((e) => e.type === 'principal.report');
  const deferredEvents = () => published.filter((e) => e.type === 'autonomy.relay_deferred');
  return { gateway, budget, warn, sendMessage, signalSend, published, reports, deferredEvents, publish };
}

const toPrincipalSignal = (message: string) => ({ channel: 'signal' as const, recipient: PRINCIPAL_SIGNAL, message });

describe('relay budget (#1320)', () => {
  it('delivers within budget, then holds the next relay for the digest', async () => {
    const g = makeGateway({ perHour: 1 });

    const first = await g.gateway.send(toPrincipalSignal('Dana says the contract is signed.'), { originator: outsider(), taskEventId: 'task-1' });
    expect(first).toMatchObject({ success: true });
    expect(first.deferredToDigest).toBeUndefined();
    expect(g.signalSend).toHaveBeenCalledTimes(1);

    const second = await g.gateway.send(toPrincipalSignal('Dana asks about Friday.'), { originator: outsider(), taskEventId: 'task-2', conversationId: 'email:t1' });
    expect(second).toEqual({ success: true, deferredToDigest: true });

    // The digest item carries who and the full redacted text.
    const [report] = g.reports();
    expect(report).toMatchObject({
      sourceLayer: 'dispatch',
      parentEventId: 'task-2',
      payload: { source: 'relay_deferred', urgency: 'digest', conversationId: 'email:t1' },
    });
    expect((report!.payload as { summary: string }).summary).toBe(
      'Held for your digest (relay limit reached for Dana Example):\nDana asks about Friday.',
    );

    // One notice instead of the relay, on the same channel, as a system notification.
    expect(g.signalSend).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(g.signalSend.mock.calls[1])).toContain("Dana Example has more updates. I'm holding them for your digest, or ask me for them anytime.");
    expect(JSON.stringify(g.signalSend.mock.calls[1])).not.toContain('Friday');

    // The audit event names the originator, not the content.
    const [ev] = g.deferredEvents();
    expect(ev).toMatchObject({
      parentEventId: 'task-2',
      payload: { originatorContactId: DANA_ID, tier: 'known', channel: 'signal', conversationId: 'email:t1', taskEventId: 'task-2', noticeSent: true },
    });
    expect(JSON.stringify(ev)).not.toContain('Friday');
  });

  it('sends the notice only once per window', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });
    await g.gateway.send(toPrincipalSignal('three'), { originator: outsider() });

    // one delivered + one notice; 'three' is deferred silently.
    expect(g.signalSend).toHaveBeenCalledTimes(2);
    expect(g.reports()).toHaveLength(2);
    expect(g.deferredEvents().map((e) => (e.payload as { noticeSent: boolean }).noticeSent)).toEqual([true, false]);
  });

  it('sends an email notice with its own subject and no threading or attachments', async () => {
    const g = makeGateway({ perHour: 1 });
    const relay = { channel: 'email' as const, to: PRINCIPAL_EMAIL, subject: 'Re: contract', body: 'first' };
    await g.gateway.send(relay, { originator: outsider() });
    const deferred = await g.gateway.send({ ...relay, body: 'second' }, { originator: outsider() });

    expect(deferred.deferredToDigest).toBe(true);
    expect((g.reports()[0]!.payload as { summary: string }).summary).toBe(
      'Held for your digest (relay limit reached for Dana Example):\nSubject: Re: contract\nsecond',
    );
    const notice = g.sendMessage.mock.calls[1]![0] as Record<string, unknown>;
    expect(notice).toMatchObject({ subject: 'Holding updates from Dana Example' });
    expect(JSON.stringify(notice)).not.toContain('second');
    expect(JSON.stringify(notice)).not.toContain('Re: contract');
  });

  it('counts a missing tier as unknown and reports it so', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider({ tier: null }) });
    await g.gateway.send(toPrincipalSignal('two'), { originator: outsider({ tier: null }) });
    expect(g.deferredEvents()[0]!.payload).toMatchObject({ tier: 'unknown' });
  });

  it.each([
    ['system notification', { originator: outsider(), isSystemNotification: true }],
    ['principal-approved', { originator: outsider(), humanApproved: true }],
    ['principal-directed', { originator: outsider(), principalDirected: true }],
    ['trusted originator', { originator: outsider({ tier: 'trusted' }) }],
    ['principal-originated', { originator: outsider({ systemRole: 'principal', tier: null }) }],
    ['system-originated', { originator: outsider({ systemRole: 'system', tier: null }) }],
    ['agent-originated', { originator: outsider({ systemRole: 'agent', tier: null }) }],
    ['no originator', {}],
  ])('never defers a %s send', async (_name, options) => {
    const g = makeGateway({ perHour: 1 });
    for (let i = 0; i < 3; i++) {
      const result = await g.gateway.send(toPrincipalSignal(`m${i}`), options);
      expect(result.deferredToDigest).toBeUndefined();
    }
    expect(g.signalSend).toHaveBeenCalledTimes(3);
    expect(g.deferredEvents()).toHaveLength(0);
  });

  it('never defers a send where the principal is not the sole recipient', async () => {
    const g = makeGateway({ perHour: 1 });
    const relay = { channel: 'email' as const, to: PRINCIPAL_EMAIL, cc: ['someone@example.org'], subject: 'S', body: 'b' };
    for (let i = 0; i < 3; i++) {
      expect((await g.gateway.send(relay, { originator: outsider() })).deferredToDigest).toBeUndefined();
    }
    expect(g.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('a filter-blocked relay is blocked, not deferred, and does not count', async () => {
    const blocked = makeGateway({ perHour: 1, filterPasses: false });
    const result = await blocked.gateway.send(toPrincipalSignal('secret'), { originator: outsider(), skipNotificationOnBlock: true });
    expect(result.success).toBe(false);
    expect(result.deferredToDigest).toBeUndefined();
    expect(blocked.deferredEvents()).toHaveLength(0);
    expect(blocked.budget.count(DANA_ID)).toBe(0);
  });

  it('delivers the relay after all when its digest item cannot be recorded', async () => {
    const g = makeGateway({
      perHour: 1,
      publish: async (_layer, event) => {
        if (event.type === 'principal.report') throw new Error('audit write failed');
      },
    });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    const second = await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });

    expect(second.success).toBe(true);
    expect(second.deferredToDigest).toBeUndefined();
    expect(JSON.stringify(g.signalSend.mock.calls[1])).toContain('two');
    expect(g.deferredEvents()).toHaveLength(0);
  });

  it('still defers when the notice fails to send', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    g.signalSend.mockRejectedValueOnce(new Error('signal down'));
    const second = await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });

    expect(second).toEqual({ success: true, deferredToDigest: true });
    expect(g.reports()).toHaveLength(1);
    expect(g.deferredEvents()[0]!.payload).toMatchObject({ noticeSent: false });

    // The failed notice did not use up the window: the next deferral tries it again.
    await g.gateway.send(toPrincipalSignal('three'), { originator: outsider() });
    expect(g.deferredEvents()[1]!.payload).toMatchObject({ noticeSent: true });
    expect(JSON.stringify(g.signalSend.mock.calls.at(-1))).toContain('has more updates');
  });

  it("falls back to 'a contact' when the lookup throws", async () => {
    const g = makeGateway({ perHour: 1, getContact: vi.fn().mockRejectedValue(new Error('db down')) });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    const second = await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });

    expect(second.deferredToDigest).toBe(true);
    expect((g.reports()[0]!.payload as { summary: string }).summary).toContain('relay limit reached for a contact');
    expect(JSON.stringify(g.signalSend.mock.calls[1])).toContain("A contact has more updates. I'm holding them for your digest, or ask me for them anytime.");
  });

  it('the notice is sent once and is not itself budgeted', async () => {
    // perHour 1: the notice would be over budget if it were counted against Dana.
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    await g.gateway.send(toPrincipalSignal('two'), { originator: outsider() });
    expect(g.signalSend).toHaveBeenCalledTimes(2);
    expect(g.reports()).toHaveLength(1);
  });

  it('does nothing without a relay budget configured', async () => {
    const g = makeGateway({ perHour: 1 });
    const bare = new OutboundGateway({
      signalClient: { send: g.signalSend, isConnected: () => true } as unknown as SignalRpcClient,
      signalPhoneNumber: '+10000000000',
      contactService: { resolveByChannelIdentity: vi.fn().mockResolvedValue(null) } as unknown as ContactService,
      contentFilter: { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as unknown as OutboundContentFilter,
      bus: { publish: g.publish, subscribe: vi.fn() } as unknown as EventBus,
      principalIdentities: [principalIdentity('signal', PRINCIPAL_SIGNAL)],
      logger: createLogger('error'),
    });
    for (let i = 0; i < 3; i++) await bare.send(toPrincipalSignal(`m${i}`), { originator: outsider() });
    expect(g.signalSend).toHaveBeenCalledTimes(3);
  });

  it('never defers an email that carries attachments: the digest cannot hold them', async () => {
    vi.stubEnv('CURIA_TEMPFILE_DIR', '/tmp');
    (realpath as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => p);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('signed pdf'));
    const g = makeGateway({ perHour: 1 });
    const relay = {
      channel: 'email' as const, to: PRINCIPAL_EMAIL, subject: 'Signed contract', body: 'Attached.',
      attachments: [{ fileUrl: 'file:///tmp/contract.pdf', filename: 'contract.pdf', contentType: 'application/pdf' }],
    };
    await g.gateway.send(relay, { originator: outsider() });
    const second = await g.gateway.send(relay, { originator: outsider() });
    vi.unstubAllEnvs();

    expect(second.deferredToDigest).toBeUndefined();
    expect(g.reports()).toHaveLength(0);
    expect(g.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('gives the slot back when the relay is not delivered', async () => {
    const g = makeGateway({ perHour: 1 });
    g.signalSend.mockRejectedValueOnce(new Error('signal down'));
    const failed = await g.gateway.send(toPrincipalSignal('one'), { originator: outsider() });
    expect(failed.success).toBe(false);

    const retry = await g.gateway.send(toPrincipalSignal('one, again'), { originator: outsider() });
    expect(retry.deferredToDigest).toBeUndefined();
    expect(retry.success).toBe(true);
    expect(g.budget.count(DANA_ID)).toBe(1);
  });

  it('names an unresolved sender by its address, without a contact lookup, and redacts it in logs', async () => {
    // stampOriginator uses the raw sender id as contactId when no contact matched.
    const getContact = vi.fn();
    const g = makeGateway({ perHour: 1, getContact });
    const raw = outsider({ contactId: 'dana@example.org', tier: 'unknown' });
    await g.gateway.send(toPrincipalSignal('one'), { originator: raw });
    await g.gateway.send(toPrincipalSignal('two'), { originator: raw });

    expect(getContact).not.toHaveBeenCalled();
    expect((g.reports()[0]!.payload as { summary: string }).summary).toContain('relay limit reached for dana@example.org');
    expect(JSON.stringify(g.signalSend.mock.calls[1])).toContain('dana@example.org has more updates');
    const budgetLog = g.warn.mock.calls.find((c) => String(c[1]).includes('relay budget reached'));
    expect(budgetLog).toBeDefined();
    expect(JSON.stringify(budgetLog![0])).not.toContain('dana@example.org');
  });

  it('warns when a skill send to the principal alone carries no originator, so a missing one is visible', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('one'), { taskEventId: 'task-9' });
    expect(g.warn.mock.calls.some((c) => String(c[1]).includes('no originator'))).toBe(true);
  });

  it('does not warn about a missing originator on adapter relays and system notices', async () => {
    const g = makeGateway({ perHour: 1 });
    await g.gateway.send(toPrincipalSignal('relay'), { parentEventId: 'evt-1', postTurn: true });
    await g.gateway.send(toPrincipalSignal('notice'), { isSystemNotification: true, taskEventId: 'task-9' });
    await g.gateway.send(toPrincipalSignal('approved'), { humanApproved: true, taskEventId: 'task-9' });
    expect(g.warn.mock.calls.some((c) => String(c[1]).includes('no originator'))).toBe(false);
  });
});
