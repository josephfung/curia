// mailbox-signin-resume-subscriber.ts — resume the agent that sent a mailbox sign-in link (#2361).
//
// The same shape as SecretCaptureResumeSubscriber: `mailbox_signin.finished` in, one synthetic
// `agent.task` out, back into the conversation the link was sent from. The agent reads the
// outcome line and either continues or offers a fresh link. A sign-in started from the console
// carries no origin and resumes nothing.
//
// `admin_blocked` also tells the operator, whatever started the sign-in: only a Google Workspace
// administrator can lift the block, by trusting the app's OAuth client id. That notice is
// operator-routed (NOTIFICATION_AUDIENCES, #2710), so the gateway addresses it — and sends it to
// the principal when no operator is set, where it used to go before #2710.
//
// The event carries no grant id and no address, so neither can reach the task or the notice.

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { BusEvent, MailboxSignInFinishedEvent } from '../bus/events.js';
import { createAgentTask } from '../bus/events.js';
import { decodeResumeToken } from '../agents/resume-token.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import {
  NON_DELIVERABLE_CHANNELS,
  parseOriginator,
  unresolvedExternalOriginator,
  type ResumeRoutingRegistrar,
} from '../secrets/secret-capture-resume-subscriber.js';
import type { MailboxSignInOutcome } from './signin-outcome.js';
import type { SignInTarget } from './mailbox-signin-service.js';

/** Bound on the dedup set; FIFO eviction, as in SecretCaptureResumeSubscriber. */
const MAX_DISPATCHED_IDS = 10_000;

const GENERIC_CLIENT_ID = 'the OAuth client ID from your Google Cloud project';
const FRESH_LINK = 'Call `mailbox-signin-link` for a fresh link';

function whose(target: SignInTarget): string {
  return target === 'curia' ? "Curia's own mailbox" : "the principal's mailbox";
}

function clientIdPhrase(clientId: string | undefined): string {
  return clientId !== undefined ? `the OAuth client ID ${clientId}` : GENERIC_CLIENT_ID;
}

/** The plain reason a sign-in did not connect, per outcome. */
function reason(outcome: MailboxSignInOutcome, clientId: string | undefined, operatorNotified: boolean): string {
  switch (outcome) {
    case 'expired':
      return 'the sign-in link expired before it was used.';
    case 'cancelled':
      return 'the sign-in was cancelled on the Google consent screen.';
    case 'admin_blocked':
      return operatorNotified
        // A published notice, not a confirmed email: the send can still fail at the provider.
        ? `the Google Workspace administrator's policy blocks this app. Curia asked for a notice to be sent to the operator; either way, an administrator must mark ${clientIdPhrase(clientId)} as Trusted in the Google Admin console (Security → API controls → App access control).`
        : `the Google Workspace administrator's policy blocks this app. I couldn't notify the operator; ask them to mark the app Trusted in the Google Workspace admin console (${clientIdPhrase(clientId)}, under Security → API controls → App access control).`;
    case 'org_internal':
      return "the Google Cloud project's consent screen is set to Internal, so accounts outside its organisation cannot sign in; the operator must set it to External.";
    case 'wrong_account':
      return 'a different Google account signed in than the one the link was for.';
    case 'missing_scopes':
      return 'not every permission was granted; on the Google consent screen, every Gmail and Calendar box must be ticked.';
    case 'not_google':
      return 'the account that signed in is not a Google account; only Google mailboxes are supported.';
    case 'account_limit':
      return "Nylas's account limit is reached (a Nylas sandbox allows 5 connected accounts); the operator must remove an unused mailbox, or move to a production Nylas application.";
    case 'refused':
      return 'Curia refused to store the account (it is already connected in another role, or the link was not valid for it).';
    case 'failed':
      return 'the sign-in failed on the way back from Google.';
    case 'connected':
    case 'reconnected':
      return '';
  }
}

export interface ResumeLineOptions {
  /** admin_blocked: the Google OAuth client id to trust, when known. */
  clientId?: string;
  /** admin_blocked: whether the operator notice was requested (published to the outbound
   *  gateway; delivery is not confirmed). Absent: not requested. */
  operatorNotified?: boolean;
  /** Whether Curia restarts after this sign-in. Absent: no restart. */
  restartScheduled?: boolean;
}

/**
 * The outcome line the resumed agent reads. Success: "… connected — continue". Otherwise the
 * plain reason and a pointer to a fresh link; admin_blocked also names the client id to trust,
 * and says a notice to the operator was requested only when it was published (not that it arrived).
 */
export function mailboxSignInResumeLine(outcome: MailboxSignInOutcome, target: SignInTarget, opts: ResumeLineOptions = {}): string {
  if (outcome === 'connected' || outcome === 'reconnected') {
    const restart = opts.restartScheduled === true ? ' Curia restarts to start using it.' : '';
    return `The mailbox sign-in finished: ${whose(target)} is connected — continue.${restart}`;
  }
  const after = outcome === 'admin_blocked' ? ' once the app is trusted'
    : outcome === 'account_limit' ? ' once an account is freed'
    : '';
  return `The mailbox sign-in for ${whose(target)} did not connect: ${reason(outcome, opts.clientId, opts.operatorNotified === true)} ${FRESH_LINK}${after}.`;
}

export interface MailboxSignInResumeSubscriberDeps {
  bus: EventBus;
  logger: Logger;
  /** Seeds dispatcher routing so the resumed reply reaches the user (Dispatcher.registerExternalTaskRouting). */
  registerRouting?: ResumeRoutingRegistrar;
  /** The Google OAuth client id on the Nylas Google connector, for admin_blocked; undefined when unknown. */
  googleClientId?: () => Promise<string | undefined>;
  /** How the admin_blocked notice is sent. Absent (no outbound gateway): only logged. The
   *  recipient is the gateway's to resolve from the notification type (#2710), and the gateway
   *  checks that an adapter can deliver it. */
  notifier?: {
    gateway: Pick<OutboundGateway, 'sendNotification'>;
  };
}

export class MailboxSignInResumeSubscriber {
  private readonly dispatched = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly deps: MailboxSignInResumeSubscriberDeps) {
    this.log = deps.logger.child({ component: 'mailbox-signin-resume' });
  }

  start(): void {
    this.deps.bus.subscribe('mailbox_signin.finished', 'system', (event: BusEvent) => this.handle(event as MailboxSignInFinishedEvent));
    this.log.info('MailboxSignInResumeSubscriber started — listening for mailbox_signin.finished');
  }

  private async handle(event: MailboxSignInFinishedEvent): Promise<void> {
    if (this.dispatched.has(event.id)) {
      this.log.info({ eventId: event.id }, 'mailbox_signin.finished already handled — skipping duplicate');
      return;
    }
    const { target, outcome, conversationId, agentId, channelId, taskEventId, resumeToken, originator, restartScheduled } = event.payload;

    // Marked before any await so a re-delivery during the notice cannot notify twice.
    this.markDispatched(event.id);

    let clientId: string | undefined;
    let operatorNotified = false;
    if (outcome === 'admin_blocked') {
      clientId = await this.lookupClientId();
      operatorNotified = await this.notifyAdminBlocked(target, clientId, event.id);
    }

    // R6: Curia exits a few seconds after connecting its own mailbox; a resumed turn would be cut
    // off mid-reply. The console's done page tells the operator instead.
    if (restartScheduled === true) {
      this.log.info({ eventId: event.id, outcome, agentId }, 'mailbox_signin.finished precedes a restart — not resuming an agent');
      return;
    }
    if (!agentId || !conversationId || !channelId) {
      this.log.info({ eventId: event.id, outcome, hasAgentId: !!agentId }, 'mailbox_signin.finished has no routable origin — not resuming an agent');
      return;
    }
    if (NON_DELIVERABLE_CHANNELS.has(channelId)) {
      this.log.warn({ eventId: event.id, agentId, channelId }, 'mailbox_signin.finished came from a non-user-facing channel — cannot deliver a resume there; skipping');
      return;
    }

    // A restart-bound event returned above (R6), so this line never promises a restart (J).
    const line = mailboxSignInResumeLine(outcome, target, {
      ...(clientId !== undefined ? { clientId } : {}),
      operatorNotified,
    });
    let content: string;
    if (resumeToken) {
      const decoded = decodeResumeToken(resumeToken);
      if (!decoded) {
        this.log.warn({ eventId: event.id, agentId, tokenLength: resumeToken.length }, 'mailbox_signin.finished carried a resume_token that could not be decoded — not resuming');
        return;
      }
      content =
        `${line}\n\nThe specialist '${decoded.agent}' sent the sign-in link and paused waiting for it. ` +
        `Re-delegate to '${decoded.agent}' to continue, passing this resume_token EXACTLY as given ` +
        `(do not alter, redact, or shorten it):\n\n${resumeToken}\n\nThen relay its reply to the user.`;
    } else {
      content = line;
    }

    const contactId = originator?.['contactId'];
    const senderId = typeof contactId === 'string' && contactId.length > 0 ? contactId : 'mailbox-signin';
    const parsedOriginator = parseOriginator(originator);
    const routingOriginator = parsedOriginator ?? unresolvedExternalOriginator(channelId);
    if (!parsedOriginator) {
      this.log.warn({ eventId: event.id, channelId, hadOriginatorBag: !!originator }, 'mailbox_signin.finished missing or malformed originator — using the fail-closed unresolved originator');
    }

    const task = createAgentTask({
      agentId,
      conversationId,
      channelId,
      senderId,
      content,
      // Curia telling itself how the sign-in ended; not something the originator said.
      syntheticTurn: true,
      metadata: { originator: routingOriginator },
      parentEventId: taskEventId ?? event.id,
    });

    try {
      this.deps.registerRouting?.(task.id, { channelId, conversationId, senderId, originator: routingOriginator });
      await this.deps.bus.publish('system', task);
      this.log.info({ eventId: event.id, agentId, conversationId, outcome }, 'Resumed agent after mailbox sign-in');
    } catch (err) {
      // Let a replay retry the resume (an admin_blocked replay repeats its notice, which is
      // harmless). Propagated per the catch policy; the bus isolates subscriber errors.
      this.dispatched.delete(event.id);
      this.log.error({ err, eventId: event.id, agentId, conversationId }, 'Failed to dispatch the resume agent.task after mailbox sign-in');
      throw err;
    }
  }

  private async lookupClientId(): Promise<string | undefined> {
    if (!this.deps.googleClientId) return undefined;
    try {
      return await this.deps.googleClientId();
    } catch (err) {
      this.log.warn({ errName: err instanceof Error ? err.name : typeof err }, 'Could not read the Google client id for the admin_blocked notice; using the generic wording');
      return undefined;
    }
  }

  /** Publish the admin_blocked notice. Named for what it does: it raises a notice about a
   *  blocked sign-in, and the notification type decides who reads it (#2710) — the operator
   *  when one is set, the principal otherwise. True when the notice was published (the gateway
   *  accepted it; delivery is not confirmed). Never throws: the notice is best effort and the
   *  resume still runs. */
  private async notifyAdminBlocked(target: SignInTarget, clientId: string | undefined, eventId: string): Promise<boolean> {
    const notifier = this.deps.notifier;
    if (!notifier) {
      this.log.warn({ eventId }, 'A Google admin policy blocked a mailbox sign-in, but no notice can be sent (no gateway)');
      return false;
    }
    let sent: boolean;
    try {
      sent = await notifier.gateway.sendNotification({
        notificationType: 'mailbox_signin_admin_blocked',
        subject: 'Google blocked a mailbox sign-in for Curia',
        body: [
          `A Google sign-in for ${whose(target)} was blocked by the Google Workspace administrator's policy.`,
          '',
          `To allow it, a Workspace administrator opens the Google Admin console → Security → Access and data control → API controls → App access control, adds the app by ${clientIdPhrase(clientId)}, and marks it Trusted.`,
          '',
          'Once the app is trusted, the sign-in can be tried again.',
        ].join('\n'),
      }, eventId);
    } catch (err) {
      this.log.warn({ eventId, errName: err instanceof Error ? err.name : typeof err }, 'The admin_blocked notice could not be sent');
      return false;
    }
    if (!sent) this.log.warn({ eventId }, 'The admin_blocked notice could not be published');
    return sent;
  }

  private markDispatched(eventId: string): void {
    if (this.dispatched.size >= MAX_DISPATCHED_IDS) {
      const oldest = this.dispatched.values().next().value;
      if (oldest !== undefined) this.dispatched.delete(oldest);
    }
    this.dispatched.add(eventId);
  }
}
