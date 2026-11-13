// test-mode-sends.ts — the recording transports and gateway a test-mode stack can opt into
// (#2312). The scenario suite's `through_gateway` cases run send tools through production's
// OutboundGateway review: PII detection, the content filter, band review, holds and asks,
// outreach records. Only the last step differs: the transports are recording fakes, so a
// message that passes the review is handed to the run that sent it instead of a network.
//
// No-send by construction, as createNoSendOutboundGateway is:
//   - No real client class (NylasClient, SignalRpcClient, SlackClient, SmsClient) is ever
//     constructed here. The fakes are plain objects shaped like the methods the gateway calls.
//   - No outbound queue. A queued row would be flushed later by any real instance sharing the
//     database. The gateway is never start()ed, so it does not subscribe to channel.reconnect.
//   - A send with no run to record it fails: SendRecorder.record throws, and the gateway
//     reports a failed dispatch.

import { randomUUID } from 'node:crypto';
import type { ListMessagesOptions, NylasClient, NylasMessage, SendEmailOptions } from '../channels/email/nylas-client.js';
import type { SignalRpcClient } from '../channels/signal/signal-rpc-client.js';
import type { SignalSendParams } from '../channels/signal/types.js';
import type { SlackClient } from '../channels/slack/slack-client.js';
import type { SlackPostMessageParams, SlackPostMessageResult } from '../channels/slack/types.js';
import type { SmsClient } from '../channels/sms/sms-client.js';
import type { ApprovalDisplay } from '../autonomy/approval-delivery.js';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { AutonomyService } from '../autonomy/autonomy-service.js';
import { FailOpenLimiter, type AutonomyGating } from '../autonomy/band-policy.js';
import type { RelayBudget } from '../autonomy/relay-budget.js';
import type { EventBus } from '../bus/bus.js';
import type { IdentityGateMode } from '../config.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { ChannelIdentity } from '../contacts/types.js';
import type { BandSendReview } from '../dispatch/band-send-review.js';
import type { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import type { PiiRedactor } from '../dispatch/pii-redactor.js';
import type { ConversationEntityState } from '../entity-context/conversation-entities.js';
import type { Logger } from '../logger.js';
import { OutboundGateway } from '../skills/outbound-gateway.js';
import { EmailAdapter } from '../channels/email/email-adapter.js';
import { SignalAdapter } from '../channels/signal/signal-adapter.js';
import type { BusEvent, EventType, Layer, OutboundMessageEvent } from '../bus/events.js';
import type { PrincipalEmailRef } from '../contacts/types.js';
import type { AgentPersona, ToolManifest } from '../skills/types.js';
import { REPLY_QUOTE_HTML_OPEN } from '../skills/_shared/reply-quote.js';
import { DEFAULT_MAILBOX, DEFAULT_SEND_LEVEL, type SendLevel } from '../skills/principal-send/send-level.js';
import { PrincipalMailboxes, type MailboxDirectory } from '../principal-mailboxes/service.js';
import type { PrincipalMailboxStore } from '../principal-mailboxes/store.js';
import type { PrincipalMailboxRecord } from '../principal-mailboxes/types.js';
import type { PrincipalSendEntry } from '../skills/principal-send/send-ledger.js';
import { draftKey, type DraftRef } from '../skills/principal-send/draft-provenance.js';

/** One message a recording transport took: what would have left the process. */
export interface RecordedSend {
  channel: 'email' | 'signal' | 'slack' | 'sms';
  /** `draft`: an email draft was created and nothing left. `send`: delivered, a sent draft included. */
  kind: 'send' | 'draft';
  /** Addresses, numbers or Slack ids, as the gateway handed them to the transport. */
  to: string[];
  cc: string[];
  subject?: string;
  /** The text delivered. An email's HTML is reduced to its text. */
  body: string;
  /**
   * An email reply's own text: the body above the quoted message (the reply quote's
   * attribution block), reduced to text. Absent when nothing was quoted (#2312).
   */
  ownBody?: string;
  /** The quoted message below that block, reduced to text. Absent when nothing was quoted. */
  quotedBody?: string;
  /** The synthetic message (or draft) id the transport returned. */
  id: string;
  /**
   * The sending mailbox's address when it was the principal's own (#2474: ceo-inbox-send-draft).
   * Absent: one of Curia's accounts sent it.
   */
  from?: string;
}

/**
 * One band review of a send (#2312): the labels of the personal data it ruled on, never the
 * values. `labels` are the message's own items (body and subject); `quoteLabels` the quoted
 * message's, which the gateway reviews only when someone on the send was not on the quote.
 */
export interface RecordedReview {
  labels: string[];
  quoteLabels: string[];
  /** What the review decided for the send: send, bounce, block or hold. */
  outcome: 'send' | 'bounce' | 'block' | 'hold';
}

/**
 * Where the recording transports put what they take. The scenario harness routes each call
 * to the run that made it, through the per-attempt case context.
 */
export interface SendRecorder {
  /** Take one message. Throw to refuse it (no run to record it): the gateway reports the send failed. */
  record(send: RecordedSend): void;
  /**
   * The message the fake mailbox returns for `messageId` (an email-reply's target, read by
   * Gate C and the handler), or undefined when the run has none: the fetch then fails as a
   * missing message does.
   */
  message(messageId: string): NylasMessage | undefined;
  /** What a held send will show the principal (ApprovalDelivery.registerDisplay). */
  display?(shortRef: string, display: ApprovalDisplay): void;
  /**
   * The band review's fail-open cap for the calling run. Production keeps one per process;
   * on a shared test stack one run's judge failures would hold another run's sends. Absent or
   * undefined: one cap for the stack.
   */
  limiter?(): FailOpenLimiter | undefined;
  /**
   * Where the fake mailbox keeps drafts for the calling run, so one run's send-draft never
   * finds another's. Absent or undefined: one store for the stack.
   */
  drafts?(): Map<string, NylasMessage> | undefined;
  /**
   * The messages of an email thread, most recent first, as the fake mailbox lists them: what a
   * relayed email reply threads onto (EmailAdapter.sendOutboundReply). Absent: none.
   */
  threadMessages?(threadId: string): NylasMessage[];
  /**
   * Whether the relay adapters should send this outbound.message (`conversationId`) or, with no
   * id, this outbound.notification. The scenario suite answers yes only inside a through_gateway
   * run, for its own conversations, so every other run's relays stay on the bus as before.
   * Absent: no relay adapter is subscribed.
   */
  relays?(conversationId?: string): boolean;
  /** Addresses that are Curia's own beyond email_accounts (the scenario office's): never a reply recipient. */
  ownAddresses?: readonly string[];
  /** Take one band review's labels and outcome (#2312). Absent: reviews are not recorded. */
  reviewed?(review: RecordedReview): void;
  /**
   * The drafts in the principal's own mailbox for the calling run (#2474), which the gateway's
   * principal-mailbox fake serves and sends from. Undefined (or absent): the run has no
   * principal mailbox, so sendPrincipalDraft refuses with mailbox_unavailable.
   */
  principalDrafts?(): Map<string, NylasMessage> | undefined;
  /** Which of those drafts Curia wrote (#2474). Undefined: every draft reads as Curia's. */
  curiaDraftIds?(): ReadonlySet<string> | undefined;
  /** Which of those drafts Curia edited (#2474 final review S1). Undefined: every draft reads as edited. */
  curiaEditedDraftIds?(): ReadonlySet<string> | undefined;
  /** The calling run's ceo_inbox/sending level (#2474). Undefined: the default, on_request. */
  sendLevel?(): SendLevel | undefined;
  /**
   * The drafts Curia created in the calling run's own task, and the run clock's now, which is
   * when Curia last wrote them (#2474 PR 2: the autonomous D4.1 check). `replyTo` maps each
   * stubbed reply to the message it answered, as the draft-reply result's audit row does (final
   * fixes A5); a draft with no entry has none, and an autonomous send of it refuses. Undefined: no
   * run record, so no draft reads as created in the task.
   */
  curiaTaskDrafts?(): { ids: ReadonlySet<string>; now: Date; replyTo?: ReadonlyMap<string, string> } | undefined;
  /**
   * The non-draft messages of a thread in the principal's mailbox for the calling run (#2474 PR 2),
   * with their headers: what the autonomous limits read. Absent: none.
   */
  principalThreadMessages?(threadId: string): NylasMessage[];
  /**
   * Where the principal-mailbox send ledger keeps the calling run's entries (#2474 PR 2), so a
   * case can read them and one run's thread cooldown never holds another's (attempts of one case
   * reuse its thread ids). Absent or undefined: one store for the stack.
   */
  principalSends?(): PrincipalSendEntry[] | undefined;
}

/**
 * The fail-open cap band review sees: the calling run's (SendRecorder.limiter), else one for
 * the whole stack. Each call goes to the cap of the run that made it.
 */
export class PerRunFailOpenLimiter extends FailOpenLimiter {
  private readonly fallback = new FailOpenLimiter();
  constructor(private readonly current: () => FailOpenLimiter | undefined) {
    super();
  }
  private target(): FailOpenLimiter {
    return this.current() ?? this.fallback;
  }
  override tryAcquire(): { allowed: boolean; justTripped: boolean } {
    return this.target().tryAcquire();
  }
  override recordJudgeSuccess(): void {
    this.target().recordJudgeSuccess();
  }
  override isTripped(): boolean {
    return this.target().isTripped();
  }
}

/** A fake mailbox's failure for an id it does not hold: the 404 Nylas returns. */
class ScenarioMailboxNotFound extends Error {
  readonly statusCode = 404;
  constructor(what: string) {
    super(`${what} not found in the test-mode mailbox`);
    this.name = 'ScenarioMailboxNotFound';
  }
}

/** An email body as text: tags dropped, the common entities decoded, whitespace collapsed. */
export function emailText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function addresses(list: SendEmailOptions['to'] | undefined): string[] {
  return (list ?? []).map(a => a.email);
}

/** Record an email the way every fake mailbox does: text, with a reply's own words apart from its quote. */
function recordEmail(recorder: SendRecorder, kind: RecordedSend['kind'], message: NylasMessage, from?: string): void {
  const quoteAt = message.body.indexOf(REPLY_QUOTE_HTML_OPEN);
  recorder.record({
    channel: 'email',
    kind,
    to: addresses(message.to),
    cc: addresses(message.cc),
    subject: message.subject,
    body: emailText(message.body),
    ...(quoteAt >= 0 ? { ownBody: emailText(message.body.slice(0, quoteAt)), quotedBody: emailText(message.body.slice(quoteAt)) } : {}),
    id: message.id,
    ...(from ? { from } : {}),
  });
}

export interface RecordingTransports {
  nylasClients: Map<string, NylasClient>;
  signalClient: SignalRpcClient;
  slackClient: SlackClient;
  smsClient: SmsClient;
}

/**
 * The fakes. Each is a plain object with the methods the gateway calls, cast to the client's
 * type at this one boundary: nothing here can open a socket or make a request. Draft contents
 * live in memory (the calling run's store, SendRecorder.drafts), so send-draft replays what
 * createDraft stored.
 */
export function createRecordingTransports(recorder: SendRecorder, accountNames: readonly string[]): RecordingTransports {
  const sharedDrafts = new Map<string, NylasMessage>();
  const drafts = (): Map<string, NylasMessage> => recorder.drafts?.() ?? sharedDrafts;
  const asMessage = (id: string, options: SendEmailOptions): NylasMessage => ({
    id,
    threadId: `scenario-thread-${id}`,
    subject: options.subject,
    from: [],
    to: options.to,
    cc: options.cc ?? [],
    bcc: [],
    body: options.body,
    snippet: emailText(options.body).slice(0, 120),
    date: Math.floor(Date.now() / 1000),
    unread: false,
    folders: [],
    attachments: [],
  });
  const emailSend = (kind: RecordedSend['kind'], message: NylasMessage): void => recordEmail(recorder, kind, message);

  const mailbox = {
    sendMessage: async (options: SendEmailOptions): Promise<NylasMessage> => {
      const message = asMessage(`scenario-sent-${randomUUID()}`, options);
      emailSend('send', message);
      return message;
    },
    createDraft: async (options: SendEmailOptions): Promise<NylasMessage> => {
      const draft = asMessage(`scenario-draft-${randomUUID()}`, options);
      emailSend('draft', draft);
      drafts().set(draft.id, draft);
      return draft;
    },
    getDraft: async (draftId: string): Promise<NylasMessage | null> => drafts().get(draftId) ?? null,
    sendDraft: async (draftId: string): Promise<NylasMessage> => {
      const draft = drafts().get(draftId);
      if (!draft) throw new ScenarioMailboxNotFound(`Draft ${draftId}`);
      drafts().delete(draftId);
      const sent = { ...draft, id: `scenario-sent-${randomUUID()}` };
      emailSend('send', sent);
      return sent;
    },
    listMessages: async (options?: ListMessagesOptions): Promise<NylasMessage[]> => {
      const thread = options?.threadId ? recorder.threadMessages?.(options.threadId) ?? [] : [];
      return thread.slice(0, options?.limit ?? 50);
    },
    getMessage: async (messageId: string): Promise<NylasMessage> => {
      const message = recorder.message(messageId);
      if (!message) throw new ScenarioMailboxNotFound(`Message ${messageId}`);
      return message;
    },
  };
  // Cast: the gateway calls only the methods above on a send path. Anything else (archive,
  // labels, attachments) is not a send and fails loudly instead of reaching a network.
  const nylasClient = mailbox as unknown as NylasClient;
  // `curia` too: a relayed reply with no account names it, as the email adapter defaults to.
  const names = [...new Set([...accountNames, 'curia'])];
  const nylasClients = new Map(names.map(name => [name, nylasClient] as const));

  const signalClient = {
    isConnected: (): boolean => true,
    send: async (params: SignalSendParams): Promise<string> => {
      const id = String(Date.now());
      recorder.record({
        channel: 'signal',
        kind: 'send',
        to: params.recipient ?? (params.groupId ? [params.groupId] : []),
        cc: [],
        body: params.message,
        id,
      });
      return id;
    },
    listGroups: async (): Promise<[]> => [],
  } as unknown as SignalRpcClient;

  const slackClient = {
    isConnected: (): boolean => true,
    postMessage: async (params: SlackPostMessageParams): Promise<SlackPostMessageResult> => {
      const ts = `${Math.floor(Date.now() / 1000)}.${randomUUID().slice(0, 6)}`;
      recorder.record({ channel: 'slack', kind: 'send', to: [params.channel], cc: [], body: params.text, id: ts });
      return { ok: true, ts, channel: params.channel };
    },
  } as unknown as SlackClient;

  const smsClient = {
    sendSms: async (params: { to: string; text: string }): Promise<{ messageId: string }> => {
      const messageId = `scenario-sms-${randomUUID()}`;
      recorder.record({ channel: 'sms', kind: 'send', to: [params.to], cc: [], body: params.text, id: messageId });
      return { messageId };
    },
  } as unknown as SmsClient;

  return { nylasClients, signalClient, slackClient, smsClient };
}

/**
 * The principal's own mailbox (the ceo-inbox grant) as the recording gateway resolves it (#2474):
 * a fake over the calling run's drafts (SendRecorder.principalDrafts), separate from Curia's
 * accounts as production's is, so Curia's send-draft never finds these drafts. A send records
 * `principalAddress()` as the sender. Null when the calling run has none: the gateway then
 * refuses (mailbox_unavailable), as production does with no grant. Like the other fakes it is
 * a plain object with only the methods sendPrincipalDraft calls (getDraft for the read and the
 * re-read, listMessages for an autonomous send's thread, sendDraft); nothing here can reach a
 * network.
 */
export function createRecordingPrincipalMailbox(recorder: SendRecorder, principalAddress: () => string): (mailboxId?: string) => NylasClient | null {
  // Asked by mailbox id since #2475, but a test run has one principal mailbox and its drafts are
  // one set (read per call, so each run sees its own): every id the run's gateway lists resolves
  // to a fake over that set. Not cached, since the calling run changes between calls.
  return () => {
    const drafts = recorder.principalDrafts?.();
    if (!drafts) return null;
    const mailbox = {
      getDraft: async (draftId: string): Promise<NylasMessage | null> => drafts.get(draftId) ?? null,
      // A thread as Gmail lists it (#2474 PR 2): its messages and the drafts on it (folder DRAFT,
      // which the gateway drops), newest first. The run's seeded messages carry their headers.
      listMessages: async (options?: ListMessagesOptions): Promise<NylasMessage[]> => {
        const threadId = options?.threadId;
        // sendPrincipalDraft lists only a thread; any other listing is a misuse of this fake.
        if (!threadId) throw new Error('the test-mode principal mailbox lists only a thread (threadId)');
        const onThread = [...drafts.values()].filter(d => d.threadId === threadId);
        return [...(recorder.principalThreadMessages?.(threadId) ?? []), ...onThread]
          .sort((a, b) => b.date - a.date)
          .slice(0, options?.limit ?? 50);
      },
      sendDraft: async (draftId: string): Promise<NylasMessage> => {
        const draft = drafts.get(draftId);
        if (!draft) throw new ScenarioMailboxNotFound(`Draft ${draftId}`);
        drafts.delete(draftId);
        const from = principalAddress();
        const sent: NylasMessage = { ...draft, id: `scenario-principal-sent-${randomUUID()}`, from: from ? [{ email: from }] : [], folders: ['SENT'] };
        recordEmail(recorder, 'send', sent, from || undefined);
        return sent;
      },
    };
    // Cast: sendPrincipalDraft calls only the methods above on this client.
    return mailbox as unknown as NylasClient;
  };
}

/** The one principal mailbox test mode has: the id the recording gateway asks for (DEFAULT_MAILBOX). */
export const TEST_MODE_PRINCIPAL_MAILBOX_ID = DEFAULT_MAILBOX;

/**
 * The test-mode PrincipalMailboxes: production's class, minus the list-only `mailboxDirectory`
 * view (#2475 review I3). With a directory, config-store would check and store mailbox-keyed
 * settings (ceo_inbox/sending, ceo_inbox/triage) through the real entity memory, and the
 * database is shared with a real instance, whose default mailbox would then send at whatever
 * level a test run wrote. Without it config-store refuses those writes, as it did before test
 * mode had mailboxes. The ExecutionLayer counts an undefined service as not configured, so the
 * optional capability is simply not injected.
 */
class TestModePrincipalMailboxes extends PrincipalMailboxes {
  override forDirectory(): MailboxDirectory {
    // Cast: undefined is how the ExecutionLayer's capability map reads "not configured".
    return undefined as unknown as MailboxDirectory;
  }
}

/**
 * The `principalMailboxes` capability for the test-mode ExecutionLayer (#2475). Production's
 * class over an in-memory registry of one mailbox, `default` (the id the recording gateway's
 * createRecordingPrincipalMailbox serves), at the principal's address. Without it every
 * ceo-inbox tool that runs for real, ceo-inbox-send-draft in a through_gateway case, fails its
 * capability check before the gateway sees the send. It has no Nylas API key and no grant, so
 * any client it is asked for fails (MissingNylasApiKeyError): the drafts and the send come from
 * the recording gateway, never from here. Nothing is read from or written to the database's
 * mailbox registry, which a real instance shares, and it offers no mailbox directory
 * (TestModePrincipalMailboxes). An empty principal address is logged once: the mailbox then
 * matches no recipient's domain, which production's would.
 */
export function createTestModePrincipalMailboxes(principalAddress: () => string, logger: Logger): PrincipalMailboxes {
  let warnedEmpty = false;
  const address = (): string => {
    const value = principalAddress();
    if (value === '' && !warnedEmpty) {
      warnedEmpty = true;
      logger.warn('test-mode principal mailbox: the principal has no primary email, so its address is empty (evidence never matches its domain)');
    }
    return value;
  };
  const record = (): PrincipalMailboxRecord => ({
    id: TEST_MODE_PRINCIPAL_MAILBOX_ID,
    label: 'Mailbox',
    address: address(),
    provider: 'google',
    isDefault: true,
    triageStartAt: null,
    removedAt: null,
    addedIdentityId: null,
  });
  const store = {
    listLive: async (): Promise<PrincipalMailboxRecord[]> => [record()],
    hasAnyRow: async (): Promise<boolean> => true,
    getAny: async (id: string): Promise<PrincipalMailboxRecord | null> => (id === TEST_MODE_PRINCIPAL_MAILBOX_ID ? record() : null),
  };
  return new TestModePrincipalMailboxes({
    // Cast: PrincipalMailboxes reads the store through these three methods only; the writes
    // (insert, relabel, tombstone...) belong to the admin routes, which test mode never builds.
    store: store as unknown as PrincipalMailboxStore,
    secrets: { get: async () => null },
    apiKey: () => undefined,
    logger,
  });
}

/** What a tool lacks in test mode when it reads the principal's mail through a client (needsMailClient). */
export const NO_MAIL_CLIENT = 'principalMailboxes (no mail client in test mode)';

/**
 * The tools that declare `principalMailboxes` but reach the principal's mail only through the
 * gateway, which a through_gateway run gives the recording mailbox. An explicit list (review M5):
 * a new declarer is counted as needing a client, so it is refused unstubbed rather than run
 * against a client test mode never has.
 */
export const GATEWAY_MEDIATED_MAIL_TOOLS: ReadonlySet<string> = new Set(['ceo-inbox-send-draft']);

/**
 * True for a tool that reaches the principal's mail through a client from `principalMailboxes`,
 * which createTestModePrincipalMailboxes never hands out: run unstubbed it would fail on the
 * missing key, an error production never shows. Only GATEWAY_MEDIATED_MAIL_TOOLS are exempt.
 */
export function needsMailClient(manifest: Pick<ToolManifest, 'name' | 'capabilities'>): boolean {
  return (manifest.capabilities ?? []).includes('principalMailboxes') && !GATEWAY_MEDIATED_MAIL_TOOLS.has(manifest.name);
}

/** Production's review, as the recording gateway takes it (built in createTestModeStack). */
export interface RecordingGatewayReview {
  contentFilter: OutboundContentFilter;
  piiRedactor?: PiiRedactor;
  bandReview?: Pick<BandSendReview, 'review'>;
  actionLogRepo?: ActionLogRepo;
  conversationEntities?: ConversationEntityState;
  identityGate?: IdentityGateMode;
  relayBudget?: RelayBudget;
  agentPersona?: AgentPersona;
  gating?: AutonomyGating;
}

/**
 * The OutboundGateway a recording stack builds: production's constructor and review, with the
 * recording transports in place of the network and no outbound queue. Exported so the no-send
 * guarantee can be unit-tested without a database.
 */
export function createRecordingOutboundGateway(deps: {
  recorder: SendRecorder;
  /** Each mailbox's name and own address (email_accounts), as production keys its clients. */
  emailAccounts: ReadonlyArray<{ name: string; selfEmail: string }>;
  /** Curia's Signal number, the `account` of a Signal send. */
  signalPhoneNumber?: string;
  contactService: ContactService;
  bus: EventBus;
  logger: Logger;
  principalIdentities: ChannelIdentity[];
  autonomyService?: AutonomyService;
  review: RecordingGatewayReview;
  /**
   * The principal's own mailbox (#2474; createRecordingPrincipalMailbox), never in the Curia
   * accounts' map. Absent: sendPrincipalDraft refuses, as production does with no grant.
   */
  principalMailbox?: (mailboxId?: string) => NylasClient | null;
}): OutboundGateway {
  const transports = createRecordingTransports(deps.recorder, deps.emailAccounts.map(a => a.name));
  const { review, recorder, principalMailbox } = deps;
  const bandReview = review.bandReview ? recordingBandReview(review.bandReview, deps.recorder) : undefined;
  return new OutboundGateway({
    nylasClients: transports.nylasClients,
    emailAccountAddresses: new Map(deps.emailAccounts.map(a => [a.name, a.selfEmail])),
    ...(review.agentPersona ? { agentPersona: review.agentPersona } : {}),
    signalClient: transports.signalClient,
    // A placeholder in the 555 range when the vault has no number: it is only the `account`
    // the fake Signal client is handed.
    signalPhoneNumber: deps.signalPhoneNumber ?? '+15555550100',
    slackClient: transports.slackClient,
    smsClient: transports.smsClient,
    contactService: deps.contactService,
    contentFilter: review.contentFilter,
    bus: deps.bus,
    principalIdentities: deps.principalIdentities,
    ...(review.conversationEntities ? { conversationEntities: review.conversationEntities } : {}),
    ...(review.identityGate ? { identityGate: review.identityGate } : {}),
    logger: deps.logger,
    autonomyService: deps.autonomyService,
    ...(review.piiRedactor ? { piiRedactor: review.piiRedactor } : {}),
    ...(review.actionLogRepo ? { actionLogRepo: review.actionLogRepo } : {}),
    // No outboundQueue and no readiness probes: nothing is ever deferred to a later flush,
    // which a real instance sharing the database would perform with real transports.
    gating: review.gating ?? 'tier',
    ...(bandReview ? { bandReview } : {}),
    ...(review.relayBudget ? { relayBudget: review.relayBudget } : {}),
    ...(principalMailbox
      ? {
          principalMailbox: async (mailboxId) => principalMailbox(mailboxId),
          // The calling run's level (seed.principal_mailbox.send_level), else production's default.
          readSendLevel: async () => recorder.sendLevel?.() ?? DEFAULT_SEND_LEVEL,
          draftProvenance: {
            // The run's records are by draft id alone (one mailbox in a test run); the result keeps
            // the gateway's (mailbox, id) keys.
            createdByCuria: async (drafts: readonly DraftRef[]) => {
              const curia = recorder.curiaDraftIds?.();
              // Fail toward more review, as the gateway does without provenance: no run's
              // record means every draft reads as Curia's.
              return new Set(drafts.filter(d => !curia || curia.has(d.draftId)).map(d => draftKey(d.mailbox, d.draftId)));
            },
            editedByCuria: async (drafts: readonly DraftRef[]) => {
              const edited = recorder.curiaEditedDraftIds?.();
              // Fail toward more review, as above.
              return new Set(drafts.filter(d => !edited || edited.has(d.draftId)).map(d => draftKey(d.mailbox, d.draftId)));
            },
            // An autonomous send's D4.1 check (#2474 PR 2): only a draft the run's own task created
            // (a `same_task` seed, or a stubbed compose or reply this run), last written at the run
            // clock's now, so only a draft dated after that reads as changed. A draft Curia wrote in
            // an earlier task is not one. No record proves nothing, so nothing reads as created in
            // the task (fail closed, unlike the review default above).
            curiaWritesInTask: async ({ draftId }: DraftRef) => {
              const task = recorder.curiaTaskDrafts?.();
              if (!task?.ids.has(draftId)) return { created: false, lastWriteAt: null, replyToMessageId: null };
              return { created: true, lastWriteAt: task.now, replyToMessageId: task.replyTo?.get(draftId) ?? null };
            },
          },
          // In memory, in the calling run's store: the real ledger writes working docs, which a real
          // instance's sent-observe shares, for a send that never left (the same reason there is no
          // outbound queue). The autonomous thread cooldown still holds within the run.
          sendLedger: inMemorySendLedger(() => recorder.principalSends?.()),
        }
      : {}),
  });
}

/**
 * The principal-mailbox send ledger for one recording gateway (#2474): markers in memory only, in
 * the calling run's store (`runStore`), else one for the stack.
 */
export function inMemorySendLedger(runStore: () => PrincipalSendEntry[] | undefined): NonNullable<ConstructorParameters<typeof OutboundGateway>[0]['sendLedger']> {
  const shared: PrincipalSendEntry[] = [];
  const entries = (): PrincipalSendEntry[] => runStore() ?? shared;
  return {
    recordSending: async (e) => { entries().push({ ...e, outcome: 'sending' }); },
    recordSent: async (draftId, messageId) => {
      const latest = [...entries()].reverse().find(e => e.draftId === draftId && e.outcome === 'sending');
      if (latest) Object.assign(latest, { outcome: 'sent', messageId });
    },
    recordHeld: async (e) => { entries().push({ ...e, outcome: 'held' }); },
    // As production counts (#2474 final fixes A13): an unreadable `at` is recent (fail closed).
    list: async () => [...entries()],
    recordLimitStop: async (e) => { entries().push({ draftId: e.draftId, threadId: '', mailbox: e.mailbox, conversationIds: [], recipients: [], mode: 'autonomous', at: e.at, outcome: 'limited', reasonCode: e.reason }); },
    // A `limited` entry is a report record: the cap and both cooldowns skip it, as in production (#2475 Task 19).
    limitStopsSince: async (sinceEpochMs, reason) => entries().filter(e => e.outcome === 'limited' && e.reasonCode === reason && Date.parse(e.at) >= sinceEpochMs),
    recentForThread: async (threadId, sinceEpochMs, mailbox, scan) => (scan ?? entries()).filter(e => e.mode === 'autonomous' && e.outcome !== 'limited' && (e.threadId === threadId || e.threadId === '') && (e.mailbox === undefined || e.mailbox === mailbox) && recent(e, sinceEpochMs)),
    // As production (item 12): no ids match nothing; an entry whose ids were unreadable matches any.
    recentForConversation: async (ids, sinceEpochMs, scan) => (ids.length === 0 ? [] : (scan ?? entries()).filter(e => e.mode === 'autonomous' && e.outcome !== 'limited'
      && (e.conversationIdsUnreadable === true || e.conversationIds.some(id => ids.includes(id))) && recent(e, sinceEpochMs))),
    recentAutonomousSends: async (sinceEpochMs, scan) => (scan ?? entries()).filter(e => e.mode === 'autonomous' && e.outcome !== 'held' && e.outcome !== 'limited' && recent(e, sinceEpochMs)),
    sentForDraft: async (draftId) => entries().some(e => e.draftId === draftId && e.outcome === 'sent'),
  };
}

/** PrincipalSendLedger's window test: at or after the cutoff, or an unreadable `at`. */
function recent(e: PrincipalSendEntry, sinceEpochMs: number): boolean {
  const at = Date.parse(e.at);
  return !Number.isFinite(at) || at >= sinceEpochMs;
}

/**
 * Band review as the recording gateway calls it: production's, with each review's detected
 * labels and outcome handed to the recorder (#2312), so a case can tell a run whose drafter
 * never wrote an item from one whose review ruled on it. Labels only, never the matched text.
 */
export function recordingBandReview(inner: Pick<BandSendReview, 'review'>, recorder: SendRecorder): Pick<BandSendReview, 'review'> {
  return {
    review: async (input) => {
      const decision = await inner.review(input);
      const items = input.detectedItems ?? [];
      recorder.reviewed?.({
        labels: [...new Set(items.filter(i => i.field !== 'quote').map(i => i.label))],
        quoteLabels: [...new Set(items.filter(i => i.field === 'quote').map(i => i.label))],
        outcome: decision.kind,
      });
      return decision;
    },
  };
}

/**
 * A view of the bus whose subscriptions see only the events `accept` passes. The relay adapters
 * subscribe through it, so they act for through-gateway runs alone and leave every other run's
 * outbound.message on the bus, unsent, as test mode always has. Publishing is the real bus.
 */
function relayBus(bus: EventBus, accept: (event: BusEvent) => boolean): EventBus {
  return Object.assign(Object.create(bus) as EventBus, {
    subscribe: (eventType: EventType, layer: Layer, handler: (event: BusEvent) => void | Promise<void>): void => {
      bus.subscribe(eventType, layer, (event) => (accept(event) ? handler(event) : undefined));
    },
  });
}

/**
 * Production's relay path for a recording stack (#2312): the real EmailAdapter (one per mailbox,
 * plus `curia`, the account a relay with none names) and SignalAdapter, with only their outbound
 * side subscribed (subscribeOutbound) against the recording gateway. A reply the dispatcher
 * relays to a third party then goes through sendOutboundReply / handleOutbound exactly as in
 * production: reply-all recipients, the quote, provenance, postTurn and the relay hold recipe,
 * the gated-draft fallback, the approval wake. No adapter is started: no poll, no socket, no
 * inbound, no queue flush. Only events SendRecorder.relays accepts reach them.
 */
export function subscribeRecordingRelays(deps: {
  recorder: SendRecorder;
  gateway: OutboundGateway;
  bus: EventBus;
  logger: Logger;
  contactService: ContactService;
  emailAccounts: ReadonlyArray<{ name: string; selfEmail: string }>;
  /** Further addresses that are Curia's own (the scenario office's), never a reply recipient. */
  ownAddresses: readonly string[];
  principalEmail: PrincipalEmailRef;
  signalPhoneNumber?: string;
  timezone: string;
}): void {
  const relays = deps.recorder.relays?.bind(deps.recorder);
  if (!relays) return;
  const bus = relayBus(deps.bus, (event) => {
    if (event.type === 'outbound.message') return relays((event as OutboundMessageEvent).payload.conversationId);
    if (event.type === 'outbound.notification') return relays();
    return false;
  });
  const owned = [...new Set([...deps.emailAccounts.map(a => a.selfEmail), ...deps.ownAddresses])];
  const accounts = [...new Set([...deps.emailAccounts.map(a => a.name), 'curia'])];
  for (const accountId of accounts) {
    const selfEmail = deps.emailAccounts.find(a => a.name === accountId)?.selfEmail ?? owned[0] ?? '';
    new EmailAdapter({
      accountId,
      bus,
      logger: deps.logger,
      outboundGateway: deps.gateway,
      contactService: deps.contactService,
      // Never polls: start() is not called.
      pollingIntervalMs: 60_000,
      selfEmail,
      suppressedSenderEmails: owned.filter(a => a !== selfEmail),
      ceoEmail: deps.principalEmail,
      contactCreationMaxPerMessage: 10,
      contactCreationMaxPerHour: 100,
      maxConcurrentTurns: 1,
      timezone: deps.timezone,
    }).subscribeOutbound();
  }
  new SignalAdapter({
    bus,
    logger: deps.logger,
    // Never connected: start() is not called, and the outbound side sends through the gateway.
    rpcClient: { isConnected: () => true } as unknown as SignalRpcClient,
    outboundGateway: deps.gateway,
    contactService: deps.contactService,
    phoneNumber: deps.signalPhoneNumber ?? '+15555550100',
  }).subscribeOutbound();
}
