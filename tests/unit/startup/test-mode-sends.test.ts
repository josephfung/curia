// The recording gateway's no-send guarantee (#2312, Review Focus 3). A through-gateway
// scenario send runs production's gateway review, then reaches recording fakes: no real
// client class is ever constructed, there is no outbound queue (so no flush path), and a
// send no run records fails instead of going anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const constructed = vi.hoisted(() => ({ clients: [] as string[] }));

// Every real transport, and the queue, record their construction. None may happen.
vi.mock('../../../src/channels/email/nylas-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/email/nylas-client.js')>();
  return { ...mod, NylasClient: vi.fn(function NylasClient() { constructed.clients.push('NylasClient'); }) };
});
vi.mock('../../../src/channels/signal/signal-rpc-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/signal/signal-rpc-client.js')>();
  return { ...mod, SignalRpcClient: vi.fn(function SignalRpcClient() { constructed.clients.push('SignalRpcClient'); }) };
});
vi.mock('../../../src/channels/slack/slack-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/slack/slack-client.js')>();
  return { ...mod, SlackClient: vi.fn(function SlackClient() { constructed.clients.push('SlackClient'); }) };
});
vi.mock('../../../src/channels/sms/sms-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/channels/sms/sms-client.js')>();
  return { ...mod, SmsClient: vi.fn(function SmsClient() { constructed.clients.push('SmsClient'); }) };
});
vi.mock('../../../src/skills/outbound-queue-repo.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/skills/outbound-queue-repo.js')>();
  return { ...mod, OutboundQueueRepo: vi.fn(function OutboundQueueRepo() { constructed.clients.push('OutboundQueueRepo'); }) };
});

import { EventBus } from '../../../src/bus/bus.js';
import { parseSenderVerified } from '../../../src/channels/email/message-converter.js';
import type { NylasMessage } from '../../../src/channels/email/nylas-client.js';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';
import type { PrincipalSendEntry } from '../../../src/skills/principal-send/send-ledger.js';
import { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import { createLogger } from '../../../src/logger.js';
import type { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import { buildReplyQuote } from '../../../src/skills/_shared/reply-quote.js';
import type { BandReviewInput } from '../../../src/dispatch/band-send-review.js';
import {
  createRecordingOutboundGateway,
  createRecordingPrincipalMailbox,
  createRecordingTransports,
  createTestModePrincipalMailboxes,
  emailText,
  TEST_MODE_PRINCIPAL_MAILBOX_ID,
  recordingBandReview,
  type RecordedReview,
  type RecordedSend,
  type SendRecorder,
  inMemorySendLedger,
} from '../../../src/startup/test-mode-sends.js';
import { scheduledJobTask } from '../../scenarios/harness.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import { DEFAULT_MAILBOX } from '../../../src/skills/principal-send/send-level.js';
import { MissingNylasApiKeyError, UnknownMailboxError } from '../../../src/principal-mailboxes/types.js';

const logger = createLogger('error');

/** A recorder for one run: what it took, and the inbound message its mailbox serves. */
function runRecorder(inbound?: NylasMessage): SendRecorder & { sends: RecordedSend[] } {
  const sends: RecordedSend[] = [];
  return {
    sends,
    record: (send) => { sends.push(send); },
    message: (id) => (inbound && inbound.id === id ? inbound : undefined),
  };
}

/** Outside every run: the harness's recorder refuses. */
const noRun: SendRecorder = {
  record: () => { throw new Error('a send outside every scenario run'); },
  message: () => undefined,
};

function gateway(recorder: SendRecorder, principalAddress?: string): OutboundGateway {
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    getContact: vi.fn().mockResolvedValue(null),
    createContact: vi.fn().mockResolvedValue({ id: 'contact-new' }),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContactService;
  return createRecordingOutboundGateway({
    recorder,
    emailAccounts: [{ name: 'curia', selfEmail: 'curia@example.test' }],
    contactService,
    bus: new EventBus(logger),
    logger,
    principalIdentities: [],
    ...(principalAddress ? { principalMailbox: createRecordingPrincipalMailbox(recorder, () => principalAddress) } : {}),
    review: { contentFilter: new OutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '' }) },
  });
}

/** A draft in the principal's own mailbox, as `seed.principal_mailbox` seeds one (#2474). */
function principalDraft(over: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'draft-30v-acme', threadId: 'thr-30v-acme', subject: 'Venue for the offsite', from: [],
    to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [], bcc: [],
    body: 'Shall we use the Harbour Room?', snippet: '', date: 0, unread: false, folders: ['DRAFT'], attachments: [],
    ...over,
  };
}

/** A message on the draft's thread, as `seed.principal_mailbox.threads` seeds one (#2474 PR 2): Jo, authenticated. */
function threadMessage(over: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'msg-1', threadId: 'thr-30v-acme', subject: 'Venue for the offsite', from: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }],
    to: [{ email: 'avery@example.test' }], cc: [], bcc: [], body: 'Which venue?', snippet: '', date: 0, unread: false, folders: ['INBOX'],
    headers: [{ name: 'Authentication-Results', value: 'mx.example.test; spf=pass smtp.mailfrom=acme.example.test; dkim=pass header.d=acme.example.test; dmarc=pass header.from=acme.example.test' }],
    attachments: [],
    ...over,
  };
}

/** The principal asking on a live turn: what makes a principal-mailbox send principal-directed. */
const LIVE_PRINCIPAL = {
  liveTurn: true,
  taskMetadata: { originator: { contactId: 'principal-1', systemRole: 'principal', channel: 'signal', initiatedAt: '2026-11-07T10:00:00.000Z' } },
};

describe('createRecordingOutboundGateway', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    constructed.clients.length = 0;
    // Any network call would go through fetch (Nylas SDK, Slack, Telnyx). Make it loud.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
  });
  afterEach(() => {
    // No real client and no queue, whatever the test did.
    expect(constructed.clients).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('has no outbound queue, so nothing can be deferred to a later flush', async () => {
    const gw = gateway(runRecorder());
    expect((gw as unknown as { outboundQueue?: unknown }).outboundQueue).toBeUndefined();
    // start() subscribes the flush only when a queue exists.
    const subscribe = vi.spyOn(EventBus.prototype, 'subscribe');
    gw.start();
    expect(subscribe).not.toHaveBeenCalled();
    subscribe.mockRestore();
    expect(await gw.flushChannel('email')).toEqual({ flushed: 0, skipped: true });
  });

  it('records an email send as text, to the run that made it', async () => {
    const recorder = runRecorder();
    const result = await gateway(recorder).send(
      { channel: 'email', to: 'pat@vendor.example.test', cc: ['lee@vendor.example.test'], subject: 'Hi', body: 'Hello **there** & welcome' },
      { humanApproved: true },
    );
    expect(result.success).toBe(true);
    expect(recorder.sends).toHaveLength(1);
    const [sent] = recorder.sends;
    expect(sent).toMatchObject({ channel: 'email', kind: 'send', to: ['pat@vendor.example.test'], cc: ['lee@vendor.example.test'], subject: 'Hi' });
    expect(sent!.body).toContain('Hello there & welcome');
    expect(result.messageId).toBe(sent!.id);
  });

  it('records a Signal send', async () => {
    const recorder = runRecorder();
    const result = await gateway(recorder).send(
      { channel: 'signal', recipient: '+15555550123', message: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(true);
    expect(recorder.sends).toEqual([expect.objectContaining({ channel: 'signal', kind: 'send', to: ['+15555550123'], body: 'Hello' })]);
  });

  it('fails a send no run records, without touching the network', async () => {
    const result = await gateway(noRun).send(
      { channel: 'email', to: 'pat@vendor.example.test', subject: 'Hi', body: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(false);
  });

  it('keeps a draft unsent until send-draft sends it', async () => {
    const recorder = runRecorder();
    const gw = gateway(recorder);
    const draft = await gw.createEmailDraft({ channel: 'email', to: 'pat@vendor.example.test', subject: 'Hi', body: 'Draft body' });
    expect(draft.success).toBe(true);
    expect(recorder.sends.map(s => s.kind)).toEqual(['draft']);
  });
});

describe('createRecordingTransports', () => {
  it('serves the run\'s inbound message, and a 404 for any other id', async () => {
    const inbound: NylasMessage = {
      id: 'scenario-msg-1', threadId: 't1', subject: 'Quote', from: [{ email: 'pat@vendor.example.test' }],
      to: [{ email: 'curia@example.test' }], cc: [], bcc: [], body: 'Hi', snippet: 'Hi', date: 0, unread: false,
      folders: [], attachments: [],
      headers: [{ name: 'Authentication-Results', value: 'mx.example.test; spf=pass smtp.mailfrom=vendor.example.test; dkim=pass header.d=vendor.example.test; dmarc=pass header.from=vendor.example.test' }],
    };
    const { nylasClients } = createRecordingTransports(runRecorder(inbound), ['curia']);
    const mailbox = nylasClients.get('curia')!;
    const read = await mailbox.getMessage('scenario-msg-1', { includeHeaders: true });
    expect(read.id).toBe('scenario-msg-1');
    expect(parseSenderVerified(read.headers)).toBe(true);
    await expect(mailbox.getMessage('other')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('sends a stored draft as written, once', async () => {
    const recorder = runRecorder();
    const mailbox = createRecordingTransports(recorder, ['curia']).nylasClients.get('curia')!;
    const draft = await mailbox.createDraft({ to: [{ email: 'pat@vendor.example.test' }], subject: 'S', body: '<p>Body</p>' });
    expect(await mailbox.getDraft(draft.id)).toMatchObject({ subject: 'S' });
    await mailbox.sendDraft(draft.id);
    expect(recorder.sends.map(s => [s.kind, s.body])).toEqual([['draft', 'Body'], ['send', 'Body']]);
    await expect(mailbox.sendDraft(draft.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps each run\'s drafts apart', async () => {
    const stores = { a: new Map<string, NylasMessage>(), b: new Map<string, NylasMessage>() };
    let current: 'a' | 'b' = 'a';
    const recorder = { ...runRecorder(), drafts: () => stores[current] };
    const mailbox = createRecordingTransports(recorder, ['curia']).nylasClients.get('curia')!;
    const draft = await mailbox.createDraft({ to: [{ email: 'pat@vendor.example.test' }], subject: 'S', body: 'B' });
    current = 'b';
    expect(await mailbox.getDraft(draft.id)).toBeNull();
    await expect(mailbox.sendDraft(draft.id)).rejects.toMatchObject({ statusCode: 404 });
    current = 'a';
    expect(await mailbox.getDraft(draft.id)).not.toBeNull();
  });

  it('records a reply\'s own text apart from the message it quotes', async () => {
    const recorder = runRecorder();
    const mailbox = createRecordingTransports(recorder, ['curia']).nylasClients.get('curia')!;
    const quote = buildReplyQuote(
      { from: [{ email: 'pat@vendor.example.test' }], to: [{ email: 'curia@example.test' }], subject: 'Records', date: 0, body: 'Our records list it as 130 692 544.' },
      'UTC',
      { format: 'html' },
    );
    await mailbox.sendMessage({ to: [{ email: 'pat@vendor.example.test' }], subject: 'Re: Records', body: `<p>I can't confirm that.</p>${quote}` });
    await mailbox.sendMessage({ to: [{ email: 'pat@vendor.example.test' }], subject: 'Hi', body: '<p>No quote here.</p>' });
    const [reply, plain] = recorder.sends;
    expect(reply!.body).toContain('130 692 544');
    expect(reply!.ownBody).toBe('I can\'t confirm that.');
    expect(plain!.ownBody).toBeUndefined();
  });

  it('keys one fake mailbox by every account name', () => {
    const { nylasClients } = createRecordingTransports(runRecorder(), ['curia', 'principal']);
    expect([...nylasClients.keys()]).toEqual(['curia', 'principal']);
  });
});

// #2474: the principal's own mailbox is a separate fake over the run's seeded drafts. Curia's
// accounts never see those drafts, and a send from it records the principal as the sender.
describe('the recording principal mailbox (#2474)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    constructed.clients.length = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
  });
  afterEach(() => {
    expect(constructed.clients).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('serves the run\'s drafts and records a send with the principal as sender, once', async () => {
    const drafts = new Map([['draft-30v-acme', principalDraft()]]);
    const recorder = { ...runRecorder(), principalDrafts: () => drafts };
    const mailbox = createRecordingPrincipalMailbox(recorder, () => 'avery@example.test')()!;
    expect(await mailbox.getDraft('draft-30v-acme')).toMatchObject({ subject: 'Venue for the offsite' });
    expect(await mailbox.getDraft('draft-other')).toBeNull();
    const sent = await mailbox.sendDraft('draft-30v-acme');
    expect(recorder.sends).toEqual([expect.objectContaining({
      channel: 'email', kind: 'send', from: 'avery@example.test', to: ['jo.park@acme.example.test'],
      subject: 'Venue for the offsite', body: 'Shall we use the Harbour Room?', id: sent.id,
    })]);
    // Sent, so no longer a draft.
    expect(drafts.has('draft-30v-acme')).toBe(false);
    await expect(mailbox.sendDraft('draft-30v-acme')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers for any mailbox id the gateway asks for, over the same run drafts (#2475)', async () => {
    const drafts = new Map([['draft-30v-acme', principalDraft()]]);
    const resolve = createRecordingPrincipalMailbox({ ...runRecorder(), principalDrafts: () => drafts }, () => 'avery@example.test');
    for (const id of ['work', 'personal']) {
      expect(await resolve(id)!.getDraft('draft-30v-acme'), id).toMatchObject({ subject: 'Venue for the offsite' });
    }
  });

  it('is no mailbox when the calling run has none (the gateway then refuses: mailbox_unavailable)', () => {
    expect(createRecordingPrincipalMailbox(runRecorder(), () => 'avery@example.test')()).toBeNull();
  });

  it('keeps the principal\'s drafts out of Curia\'s accounts', async () => {
    const drafts = new Map([['draft-30v-acme', principalDraft()]]);
    const recorder = { ...runRecorder(), principalDrafts: () => drafts };
    const curia = createRecordingTransports(recorder, ['curia']).nylasClients.get('curia')!;
    expect(await curia.getDraft('draft-30v-acme')).toBeNull();
  });

  it('sends a seeded draft through sendPrincipalDraft on the principal\'s live turn', async () => {
    const drafts = new Map([['draft-30v-acme', principalDraft()]]);
    const recorder = { ...runRecorder(), principalDrafts: () => drafts, curiaDraftIds: () => new Set<string>(), sendLevel: () => undefined };
    const result = await gateway(recorder, 'avery@example.test').sendPrincipalDraft('draft-30v-acme', { authority: LIVE_PRINCIPAL });
    expect(result).toMatchObject({ success: true, to: ['jo.park@acme.example.test'], subject: 'Venue for the offsite' });
    expect(recorder.sends.map(s => [s.kind, s.from, s.to])).toEqual([['send', 'avery@example.test', ['jo.park@acme.example.test']]]);
  });

  it('reads the run\'s edits: a draft Curia edited is reviewed as curia-edited (final review S1)', async () => {
    const recent = Math.floor(Date.now() / 1000) - 3600;
    const drafts = new Map([['draft-30v-acme', principalDraft({ date: recent })]]);
    const reviewed: string[] = [];
    const bandReview = { review: vi.fn(async (input: BandReviewInput) => { reviewed.push(String(input.draftAuthor)); return { kind: 'send' as const }; }) };
    const build = (curiaEdited: ReadonlySet<string>) => createRecordingOutboundGateway({
      recorder: { ...runRecorder(), principalDrafts: () => drafts, curiaDraftIds: () => new Set<string>(), curiaEditedDraftIds: () => curiaEdited },
      emailAccounts: [{ name: 'curia', selfEmail: 'curia@example.test' }],
      contactService: {
        resolveByChannelIdentity: vi.fn().mockResolvedValue(null), getContact: vi.fn().mockResolvedValue(null),
        createContact: vi.fn().mockResolvedValue({ id: 'contact-new' }), linkIdentity: vi.fn().mockResolvedValue(undefined),
      } as unknown as ContactService,
      bus: new EventBus(logger),
      logger,
      principalIdentities: [],
      principalMailbox: createRecordingPrincipalMailbox({ ...runRecorder(), principalDrafts: () => drafts }, () => 'avery@example.test'),
      review: { contentFilter: new OutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '' }), bandReview, gating: 'band' },
    });
    expect((await build(new Set(['draft-30v-acme'])).sendPrincipalDraft('draft-30v-acme', { authority: LIVE_PRINCIPAL })).success).toBe(true);
    expect(reviewed).toEqual(['curia-edited']);
  });

  it('reads the run\'s send level: off leaves the draft unsent', async () => {
    const drafts = new Map([['draft-30v-acme', principalDraft()]]);
    const recorder = { ...runRecorder(), principalDrafts: () => drafts, sendLevel: () => 'off' as const };
    const result = await gateway(recorder, 'avery@example.test').sendPrincipalDraft('draft-30v-acme', { authority: LIVE_PRINCIPAL });
    expect(result).toMatchObject({ success: false, leftAsDraft: true, refusal: 'setting_off' });
    expect(recorder.sends).toEqual([]);
    expect(drafts.has('draft-30v-acme')).toBe(true);
  });

  it('refuses an autonomous send it cannot review: this gateway runs no band review (PR 2)', async () => {
    const drafts = new Map([['draft-30v-acme', principalDraft()]]);
    const recorder = { ...runRecorder(), principalDrafts: () => drafts, sendLevel: () => 'all' as const };
    const system = { taskMetadata: { originator: { contactId: 'system', systemRole: 'system', channel: 'scheduler', initiatedAt: '2026-11-07T10:00:00.000Z' } } };
    const result = await gateway(recorder, 'avery@example.test').sendPrincipalDraft('draft-30v-acme', { authority: system });
    expect(result).toMatchObject({ success: false, leftAsDraft: true, refusal: 'no_band_review' });
    expect(recorder.sends).toEqual([]);
  });

  it('refuses outside every run: the stack has no principal mailbox then', async () => {
    const result = await gateway(noRun, 'avery@example.test').sendPrincipalDraft('draft-30v-acme', { authority: LIVE_PRINCIPAL });
    expect(result).toMatchObject({ success: false, refusal: 'mailbox_unavailable' });
  });

  it('lists a thread as Gmail does: the run\'s seeded messages and the drafts on it, newest first', async () => {
    const thread = [threadMessage({ id: 'msg-1', date: 100 }), threadMessage({ id: 'msg-2', date: 300 })];
    const drafts = new Map([
      ['draft-30v-acme', principalDraft({ date: 200 })],
      ['draft-elsewhere', principalDraft({ id: 'draft-elsewhere', threadId: 'thr-other' })],
    ]);
    const recorder = { ...runRecorder(), principalDrafts: () => drafts, principalThreadMessages: (id: string) => (id === 'thr-30v-acme' ? thread : []) };
    const mailbox = createRecordingPrincipalMailbox(recorder, () => 'avery@example.test')()!;
    const listed = await mailbox.listMessages({ threadId: 'thr-30v-acme', fields: 'include_headers', limit: 50 });
    expect(listed.map(m => [m.id, m.folders])).toEqual([['msg-2', ['INBOX']], ['draft-30v-acme', ['DRAFT']], ['msg-1', ['INBOX']]]);
    expect(await mailbox.listMessages({ threadId: 'thr-30v-acme', limit: 2 })).toHaveLength(2);
    // sendPrincipalDraft lists only a thread; anything else is a misuse of the fake, loudly.
    await expect(mailbox.listMessages({})).rejects.toThrow(/threadId/);
  });
});

// #2474 PR 2: an autonomous send reaches band review in a scenario run. The stack builds the
// gateway with the configured (tier) gating; the case's autonomy fixture says band on every read.
describe('an autonomous send through the recording gateway (#2474 PR 2)', () => {
  const NOW = Math.floor(Date.now() / 1000);
  // The metadata the scenario harness's `from: scheduler` task really carries (addendum R1), so
  // these runs prove that task passes the gateway's origin allowlist.
  const SCHEDULED = { taskMetadata: scheduledJobTask('ceo-inbox', 'c-1', 'triage').payload.metadata };
  const bandFixture = {
    getConfig: async () => ({ score: 85, band: 'act', updatedAt: new Date(0), updatedBy: 'scenario-fixture', gating: 'band' }),
  } as unknown as AutonomyService;

  function setup(over: { taskDrafts?: string[]; ledger?: PrincipalSendEntry[]; draft?: Partial<NylasMessage>; replyTo?: Map<string, string> } = {}) {
    const drafts = new Map([['draft-30v-acme', principalDraft({ date: NOW, ...over.draft })]]);
    const ledger = over.ledger ?? [];
    const recorder: SendRecorder & { sends: RecordedSend[] } = {
      ...runRecorder(),
      principalDrafts: () => drafts,
      curiaDraftIds: () => new Set(['draft-30v-acme']),
      curiaTaskDrafts: () => ({
        ids: new Set(over.taskDrafts ?? ['draft-30v-acme']), now: new Date(NOW * 1000),
        replyTo: over.replyTo ?? new Map([['draft-30v-acme', 'msg-1']]),
      }),
      principalThreadMessages: (id: string) => (id === 'thr-30v-acme' ? [threadMessage({ id: 'msg-1', date: NOW - 3600 })] : []),
      principalSends: () => ledger,
      sendLevel: () => 'routine' as const,
    };
    const reviews: string[] = [];
    const gw = createRecordingOutboundGateway({
      recorder,
      emailAccounts: [{ name: 'curia', selfEmail: 'curia@example.test' }],
      contactService: {
        resolveByChannelIdentity: vi.fn().mockResolvedValue(null), getContact: vi.fn().mockResolvedValue(null),
        createContact: vi.fn().mockResolvedValue({ id: 'contact-new' }), linkIdentity: vi.fn().mockResolvedValue(undefined),
      } as unknown as ContactService,
      bus: new EventBus(logger),
      logger,
      principalIdentities: [{ channel: 'email', channelIdentifier: 'avery@example.test', verified: true } as unknown as ChannelIdentity],
      autonomyService: bandFixture,
      principalMailbox: createRecordingPrincipalMailbox(recorder, () => 'avery@example.test'),
      review: {
        contentFilter: new OutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '' }),
        bandReview: { review: vi.fn(async () => { reviews.push('reviewed'); return { kind: 'send' as const }; }) },
        gating: 'tier',
      },
    });
    return { gw, recorder, drafts, ledger, reviews };
  }

  it('sends a reply Curia drafted in this task, past band review, from the principal', async () => {
    const { gw, recorder, ledger, reviews } = setup();
    const result = await gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-1' });
    expect(result).toMatchObject({ success: true, to: ['jo.park@acme.example.test'] });
    expect(reviews).toEqual(['reviewed']);
    expect(recorder.sends.map(s => [s.kind, s.from])).toEqual([['send', 'avery@example.test']]);
    // The run's own ledger: the send's marker, now sent, starts the thread's cooldown.
    expect(ledger).toEqual([expect.objectContaining({ draftId: 'draft-30v-acme', threadId: 'thr-30v-acme', mode: 'autonomous', outcome: 'sent' })]);
  });

  it('leaves a draft Curia wrote in an earlier task, and records why in the run\'s ledger', async () => {
    const { gw, recorder, drafts, ledger, reviews } = setup({ taskDrafts: [] });
    const result = await gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-1' });
    expect(result).toMatchObject({ success: false, leftAsDraft: true, refusal: 'not_curia_draft' });
    expect(reviews).toEqual([]);
    expect(recorder.sends).toEqual([]);
    expect(drafts.has('draft-30v-acme')).toBe(true);
    expect(ledger).toEqual([expect.objectContaining({ draftId: 'draft-30v-acme', outcome: 'held', reasonCode: 'not_curia_draft' })]);
  });

  it('keeps each run\'s ledger apart: one run\'s send starts no cooldown in another', async () => {
    const first = setup();
    expect((await first.gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-1' })).success).toBe(true);
    // Another attempt of the same case reuses the thread id, with a ledger of its own.
    const second = setup();
    expect((await second.gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-2' })).success).toBe(true);
    // Within one run the cooldown holds.
    const again = setup({ ledger: first.ledger });
    expect(await again.gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-3' })).toMatchObject({ refusal: 'thread_cooldown' });
  });

  // Final fixes A13 (final review M6): the fake counts as production does.
  it('counts a ledger entry with an unreadable time as recent, as production does (fail closed)', async () => {
    const broken: PrincipalSendEntry = { draftId: 'old', threadId: 'thr-30v-acme', conversationIds: [], recipients: [], mode: 'autonomous', at: 'not a date', outcome: 'held' };
    const { gw } = setup({ ledger: [broken] });
    expect(await gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-1' })).toMatchObject({ refusal: 'thread_cooldown' });
  });

  // Final fixes A4: the global cap reads the run's own ledger.
  it('refuses past the daily cap of autonomous sends across threads', async () => {
    const at = new Date().toISOString();
    const sent: PrincipalSendEntry[] = Array.from({ length: 10 }, (_, i) => ({
      draftId: `d${i}`, threadId: `other-${i}`, conversationIds: [], recipients: [], mode: 'autonomous' as const, at, outcome: 'sent' as const,
    }));
    const { gw, recorder } = setup({ ledger: sent });
    expect(await gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-1' })).toMatchObject({ refusal: 'daily_cap' });
    expect(recorder.sends).toEqual([]);
  });

  // Final fixes A5: the run records which message each stubbed reply answered.
  it('refuses a reply whose answered message the run did not record (fail closed)', async () => {
    const { gw, recorder } = setup({ replyTo: new Map() });
    expect(await gw.sendPrincipalDraft('draft-30v-acme', { authority: SCHEDULED, taskEventId: 'task-1' })).toMatchObject({ refusal: 'not_latest_message' });
    expect(recorder.sends).toEqual([]);
  });
});

describe('emailText', () => {
  it('reduces HTML to its text', () => {
    expect(emailText('<p>Hi &amp; bye</p><p>Line&nbsp;2<br>3</p>')).toBe('Hi & bye\nLine 2\n3');
  });
});

describe('recordingBandReview', () => {
  it('hands each review\'s labels (own and quoted) and outcome to the recorder, never the values', async () => {
    const reviews: RecordedReview[] = [];
    const recorder: SendRecorder = { ...runRecorder(), reviewed: (r) => { reviews.push(r); } };
    const inner = { review: vi.fn().mockResolvedValue({ kind: 'bounce', findings: [] }) };
    const input = {
      detectedItems: [
        { id: 'P1', label: 'phone_us', text: '(519) 555-0186', field: 'body' },
        { id: 'P2', label: 'phone_us', text: '519-555-0186', field: 'subject' },
        { id: 'P3', label: 'sin_ca', text: '130 692 544', field: 'quote' },
      ],
    } as unknown as BandReviewInput;
    const decision = await recordingBandReview(inner, recorder).review(input);
    expect(decision).toEqual({ kind: 'bounce', findings: [] });
    expect(inner.review).toHaveBeenCalledWith(input);
    expect(reviews).toEqual([{ labels: ['phone_us'], quoteLabels: ['sin_ca'], outcome: 'bounce' }]);
    expect(JSON.stringify(reviews)).not.toMatch(/555|692/);
  });

  it('records a review with no detected items as one with no labels', async () => {
    const reviews: RecordedReview[] = [];
    const recorder: SendRecorder = { ...runRecorder(), reviewed: (r) => { reviews.push(r); } };
    await recordingBandReview({ review: vi.fn().mockResolvedValue({ kind: 'send' }) }, recorder).review({} as BandReviewInput);
    expect(reviews).toEqual([{ labels: [], quoteLabels: [], outcome: 'send' }]);
  });
});

describe('inMemorySendLedger matches production (#2475 item 12)', () => {
  it('recentForConversation counts an entry whose conversation ids were unreadable, and nothing for no ids', async () => {
    const store: PrincipalSendEntry[] = [
      { draftId: 'a', threadId: 't1', mailbox: 'work', conversationIds: [], conversationIdsUnreadable: true, recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'held' },
      { draftId: 'b', threadId: 't2', mailbox: 'work', conversationIds: ['<x@example.com>'], recipients: [], mode: 'autonomous', at: new Date().toISOString(), outcome: 'sent' },
    ];
    const ledger = inMemorySendLedger(() => store);
    expect((await ledger.recentForConversation(['<y@example.com>'], 0)).map((e) => e.draftId)).toEqual(['a']);
    expect((await ledger.recentForConversation(['<x@example.com>'], 0)).map((e) => e.draftId)).toEqual(['a', 'b']);
    expect(await ledger.recentForConversation([], 0)).toEqual([]);
  });
});

// #2475: the test-mode ExecutionLayer had no principalMailboxes, so every real ceo-inbox-send-draft
// in a through_gateway case failed its capability check before the gateway saw it.
describe('createTestModePrincipalMailboxes', () => {
  beforeEach(() => { constructed.clients.length = 0; });

  it('lists one default mailbox, the id the recording gateway serves, at the principal\'s address read per call', async () => {
    let address = 'avery@example.test';
    const mailboxes = createTestModePrincipalMailboxes(() => address, logger);
    expect((await mailboxes.list()).map(m => [m.id, m.address, m.isDefault])).toEqual([[TEST_MODE_PRINCIPAL_MAILBOX_ID, 'avery@example.test', true]]);
    expect(TEST_MODE_PRINCIPAL_MAILBOX_ID).toBe(DEFAULT_MAILBOX);
    address = 'avery.new@example.test';
    expect((await mailboxes.forSkills().get(TEST_MODE_PRINCIPAL_MAILBOX_ID)).address).toBe('avery.new@example.test');
  });

  it('refuses any other mailbox id, as production refuses an unknown one', async () => {
    const mailboxes = createTestModePrincipalMailboxes(() => 'avery@example.test', logger);
    await expect(mailboxes.get('work')).rejects.toBeInstanceOf(UnknownMailboxError);
  });

  it('hands out no client: there is no API key or grant, and no Nylas client is constructed', async () => {
    const mailboxes = createTestModePrincipalMailboxes(() => 'avery@example.test', logger).forSkills();
    await expect(mailboxes.gatewayClient(TEST_MODE_PRINCIPAL_MAILBOX_ID)).rejects.toBeInstanceOf(MissingNylasApiKeyError);
    await expect(mailboxes.ceoClient(TEST_MODE_PRINCIPAL_MAILBOX_ID, logger)).rejects.toBeInstanceOf(MissingNylasApiKeyError);
    expect(constructed.clients).toEqual([]);
  });

  it('gives ceo-inbox-send-draft every capability it declares, with the gateway', () => {
    const manifest = JSON.parse(readFileSync(
      path.resolve(import.meta.dirname, '../../../skills/ceo-inbox/tools/ceo-inbox-send-draft/tool.json'), 'utf8',
    )) as ToolManifest;
    const registry = new ToolRegistry();
    registry.register(manifest, { execute: async () => ({ success: true, data: {} }) });
    // Presence is all the capability check reads.
    const gateway = {} as OutboundGateway;
    const without = new ExecutionLayer(registry, logger, { outboundGateway: gateway });
    expect(without.unavailableCapabilities('ceo-inbox-send-draft')).toEqual(['principalMailboxes']);
    const withMailboxes = new ExecutionLayer(registry, logger, {
      outboundGateway: gateway,
      principalMailboxes: createTestModePrincipalMailboxes(() => 'avery@example.test', logger),
    });
    expect(withMailboxes.unavailableCapabilities('ceo-inbox-send-draft')).toEqual([]);
  });
});
