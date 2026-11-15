// Hand-off recovery (#2588). A person was told their correction was passed on to (or held for)
// their other turn, and then it did not reach that work: the turn ended without draining it,
// its wake could not take it, or its root was dropped. Rather than lose it silently, a fresh
// synthetic coordinator `agent.task` re-runs it on the HANDING turn's own conversation and
// channel, as that person, with a short preamble saying what happened.
//
// Modelled on the late-delegation wake (late-delegation.ts publishLateWake): a `system`-layer
// publish, routing registered first so the reply reaches the person, a deterministic event id
// (audit_log's primary key fences a duplicate), `liveTurn` absent and `wakeContext` derived (an
// async boundary, #1126). Unlike the wake it also carries the handing task's account (the reply
// leaves from the mailbox the message reached) and the metadata its audience was judged from
// (audienceMetadataOf), so the re-run turn's audience matches the handing turn's. The task goes
// through the turn lanes like every other synthetic turn (ADR-053 section 4), so it waits its
// turn on that conversation; the other-turns note and the backstop keep it from repeating what
// the other turn did.
//
// A failed publish is retried a bounded number of times (RECOVERY_RETRY_DELAYS_MS). bus.publish
// rejects only before any subscriber runs (authorisation or the audit write-ahead), so a retry
// never starts a second turn, and the deterministic id fences one whose write did land.
//
// Fail-open: an error is logged and never thrown. A restart still loses the correction: the
// registry is in-process (ADR-053 section 7). Logs carry ids and the reason only.

import { createHash } from 'node:crypto';
import type { EventBus } from '../bus/bus.js';
import { createAgentTask } from '../bus/events.js';
import { makeWakeContext } from '../autonomy/effective-standing.js';
import type { TaskOriginator } from '../contacts/types.js';
import { audienceMetadataOf } from '../dispatch/audience.js';
import {
  HANDOFF_RECOVERY_KEY,
  isAuthenticatedRoot,
  type HandoffRecoveryReason,
  type HandoffRecoveryRequest,
} from '../dispatch/turn-activity.js';
import type { Logger } from '../logger.js';
import type { LateWakeRoutingRegistrar } from './late-delegation.js';
import { isPgUniqueViolation } from './resumable-continuation.js';

const RECOVERY_EVENT_ID_NAMESPACE = 'curia:turn-handoff-recovery';
/** Recovered inbound ids remembered in-process, so two triggers for one correction publish once. */
const MAX_REMEMBERED = 1_000;
const COORDINATOR_AGENT_ID = 'coordinator';
/** Delays before each retry of a failed publish; then the correction is logged as lost. */
export const RECOVERY_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000];

/** Dispatcher.registerExternalTaskRouting's shape: the late wake's routing, plus the account. */
export type HandoffRecoveryRoutingRegistrar = (
  taskEventId: string,
  routing: Parameters<LateWakeRoutingRegistrar>[1] & { accountId?: string },
) => void;

/** A short phrase per reason for the preamble: what became of the passed-on message. */
const REASON_TEXT: Record<HandoffRecoveryReason, string> = {
  returned: 'that turn ended without taking it',
  unresolved: 'that turn did not take it in time',
  root_ended: 'that work finished before it could be applied',
  root_dropped: 'that work was cleared before it could be applied',
  wake_not_injected: 'its follow-up run could not take it',
  wake_returned: 'its follow-up run ended without taking it',
};

/** The recovery task's content: the framed preamble, then the person's own (scrubbed) text. */
export function handoffRecoveryContent(reason: HandoffRecoveryReason, text: string): string {
  return `Earlier you passed this message on to another turn, but it didn't reach that work (${REASON_TEXT[reason]}). `
    + "Handle it here now: check what the other turn did and adjust rather than repeat it.\n\n"
    + text;
}

/**
 * The recovery event id for a hand-off inbound id: stable, UUID-shaped, so a second publish of
 * the same correction's recovery is rejected by audit_log's primary key. Same construction as
 * deterministicWakeEventId (late-delegation.ts).
 */
export function deterministicRecoveryEventId(inboundEventId: string): string {
  const b = Buffer.from(
    createHash('sha256').update(`${RECOVERY_EVENT_ID_NAMESPACE}:${inboundEventId}`).digest().subarray(0, 16),
  );
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

export interface HandoffRecoveryPublisherOptions {
  bus: EventBus;
  logger: Logger;
  /** Verification tracker scrubText: a sign-in code is never re-sent. Absent: text unchanged. */
  scrubText?: (text: string) => string;
  /** Dispatcher.registerExternalTaskRouting; may also be set later with setRoutingRegistrar. */
  registerRouting?: HandoffRecoveryRoutingRegistrar;
  /** Retry delays for a failed publish; defaults to RECOVERY_RETRY_DELAYS_MS. Tests shorten them. */
  retryDelaysMs?: readonly number[];
}

export class HandoffRecoveryPublisher {
  private readonly bus: EventBus;
  private readonly logger: Logger;
  private readonly scrubText: ((text: string) => string) | undefined;
  private registerRouting: HandoffRecoveryRoutingRegistrar | undefined;
  private readonly retryDelaysMs: readonly number[];
  /** Inbound ids published or being published (retries included): one recovery per correction. */
  private readonly remembered = new Set<string>();

  constructor(opts: HandoffRecoveryPublisherOptions) {
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.scrubText = opts.scrubText;
    this.registerRouting = opts.registerRouting;
    this.retryDelaysMs = opts.retryDelaysMs ?? RECOVERY_RETRY_DELAYS_MS;
  }

  setRoutingRegistrar(registerRouting: HandoffRecoveryRoutingRegistrar): void {
    this.registerRouting = registerRouting;
  }

  /**
   * The registry's HandoffRecoverer. Synchronous and never throws; the publish runs detached,
   * after the caller's stack unwinds (it may be inside a registry call).
   */
  readonly recover = (request: HandoffRecoveryRequest): void => {
    const ids = {
      fromRootId: request.from.rootId,
      targetRootId: request.targetRootId,
      inboundEventId: request.input.inboundEventId,
      reason: request.reason,
    };
    if (this.remembered.has(request.input.inboundEventId)) {
      this.logger.debug(ids, 'turn-handoff recovery: already re-run; not publishing again');
      return;
    }
    this.remember(request.input.inboundEventId);
    this.attempt(request, 0);
  };

  /**
   * One detached publish attempt. A failure schedules the next retry, at most
   * retryDelaysMs.length of them; after the last the correction is logged as lost and its id
   * forgotten, so a later trigger for it may try again.
   */
  private attempt(request: HandoffRecoveryRequest, failures: number): void {
    const ids = {
      fromRootId: request.from.rootId,
      targetRootId: request.targetRootId,
      inboundEventId: request.input.inboundEventId,
      reason: request.reason,
    };
    void Promise.resolve()
      .then(() => this.publish(request))
      .catch((err: unknown) => {
        const delay = this.retryDelaysMs[failures];
        if (delay === undefined) {
          this.remembered.delete(request.input.inboundEventId);
          this.logger.error(
            { ...ids, err, attempts: failures + 1 },
            'turn-handoff recovery: failed to re-run a passed-on correction; it is lost',
          );
          return;
        }
        this.logger.warn(
          { ...ids, err, attempt: failures + 1, retryInMs: delay },
          'turn-handoff recovery: failed to re-run a passed-on correction; retrying',
        );
        const timer = setTimeout(() => this.attempt(request, failures + 1), delay);
        // Never keeps the process alive on its own; a shutdown loses it, like a restart.
        timer.unref?.();
      });
  }

  private remember(inboundEventId: string): void {
    this.remembered.add(inboundEventId);
    if (this.remembered.size <= MAX_REMEMBERED) return;
    const oldest = this.remembered.values().next().value;
    if (oldest !== undefined) this.remembered.delete(oldest);
  }

  private async publish(request: HandoffRecoveryRequest): Promise<void> {
    const { from, input, reason, targetRootId } = request;
    const ids = { fromRootId: from.rootId, targetRootId, inboundEventId: input.inboundEventId, reason };
    if (from.originator === null || from.senderId === null) {
      this.logger.error(
        { ...ids, hasOriginator: from.originator !== null, hasSenderId: from.senderId !== null },
        'turn-handoff recovery: the handing turn has no originator or sender to re-run it as; the correction is lost',
      );
      return;
    }
    // performHandoff hands over only from an authenticated root (isAuthenticatedRoot). A recovery
    // re-runs the text as that sender, so a root that fails the rule is never re-run (#2588).
    if (!isAuthenticatedRoot(from)) {
      this.logger.error(
        { ...ids, channelId: from.channelId },
        "turn-handoff recovery: the handing turn's sender was not authenticated; not re-running it",
      );
      return;
    }
    const originator: TaskOriginator = { ...from.originator };
    // The person's own words, as handed over; a code tracked since is scrubbed now.
    const text = this.scrubText ? this.scrubText(input.originalContent) : input.originalContent;
    const minted = createAgentTask({
      agentId: COORDINATOR_AGENT_ID,
      conversationId: from.conversationId,
      channelId: from.channelId,
      // The mailbox the handing message reached, so the reply leaves from it.
      ...(from.accountId !== null && { accountId: from.accountId }),
      senderId: from.senderId,
      content: handoffRecoveryContent(reason, text),
      // Curia re-running a message, not the person saying it now (#1892).
      syntheticTurn: true,
      metadata: {
        // What the handing root's audience was judged from: the registry and contact recall
        // judge this turn's the same way. First, so nothing below can be overwritten by it.
        ...audienceMetadataOf(from.audienceMetadata),
        originator,
        // An async boundary: the ladder may only downgrade this lineage's authority.
        wakeContext: makeWakeContext(true),
        [HANDOFF_RECOVERY_KEY]: { targetRootId, reason },
      },
      parentEventId: from.rootId,
    });
    const task = { ...minted, id: deterministicRecoveryEventId(input.inboundEventId) };

    // Routing before publish: the bus awaits subscribers, so the reply can come back inside it.
    if (this.registerRouting) {
      this.registerRouting(task.id, {
        channelId: from.channelId,
        conversationId: from.conversationId,
        senderId: from.senderId,
        originator,
        ...(from.accountId !== null && { accountId: from.accountId }),
      });
    } else {
      this.logger.warn(ids, 'turn-handoff recovery: no routing registrar; the re-run turn\'s reply will not be relayed');
    }

    this.logger.info({ ...ids, recoveryTaskEventId: task.id }, 'turn-handoff recovery: re-running a passed-on correction on its handing turn');
    try {
      await this.bus.publish('system', task);
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        this.logger.info({ ...ids, recoveryTaskEventId: task.id }, 'turn-handoff recovery: already published (audit id collision)');
        return;
      }
      throw err;
    }
  }
}
