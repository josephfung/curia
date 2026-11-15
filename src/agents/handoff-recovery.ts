// Hand-off recovery (#2588). A person was told their correction was passed on to (or held for)
// their other turn, and then it did not reach that work: the turn ended without draining it,
// its wake could not take it, or its root was dropped. Rather than lose it silently, a fresh
// synthetic coordinator `agent.task` re-runs it on the HANDING turn's own conversation and
// channel, as that person, with a short preamble saying what happened.
//
// Modelled on the late-delegation wake (late-delegation.ts publishLateWake): a `system`-layer
// publish, routing registered first so the reply reaches the person, a deterministic event id
// (audit_log's primary key fences a duplicate), `liveTurn` absent and `wakeContext` derived (an
// async boundary, #1126). The task goes through the turn lanes like every other synthetic turn
// (ADR-053 section 4), so it waits its turn on that conversation; the other-turns note and the
// backstop keep it from repeating what the other turn did.
//
// Fail-open: an error is logged and never thrown. A restart still loses the correction: the
// registry is in-process (ADR-053 section 7). Logs carry ids and the reason only.

import { createHash } from 'node:crypto';
import type { EventBus } from '../bus/bus.js';
import { createAgentTask } from '../bus/events.js';
import { makeWakeContext } from '../autonomy/effective-standing.js';
import type { TaskOriginator } from '../contacts/types.js';
import { HANDOFF_RECOVERY_KEY, type HandoffRecoveryReason, type HandoffRecoveryRequest } from '../dispatch/turn-activity.js';
import type { Logger } from '../logger.js';
import type { LateWakeRoutingRegistrar } from './late-delegation.js';
import { isPgUniqueViolation } from './resumable-continuation.js';
import { handingRootAuthenticated } from './turn-handoff.js';

const RECOVERY_EVENT_ID_NAMESPACE = 'curia:turn-handoff-recovery';
/** Recovered inbound ids remembered in-process, so two triggers for one correction publish once. */
const MAX_REMEMBERED = 1_000;
const COORDINATOR_AGENT_ID = 'coordinator';

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
  registerRouting?: LateWakeRoutingRegistrar;
}

export class HandoffRecoveryPublisher {
  private readonly bus: EventBus;
  private readonly logger: Logger;
  private readonly scrubText: ((text: string) => string) | undefined;
  private registerRouting: LateWakeRoutingRegistrar | undefined;
  private readonly remembered = new Set<string>();

  constructor(opts: HandoffRecoveryPublisherOptions) {
    this.bus = opts.bus;
    this.logger = opts.logger;
    this.scrubText = opts.scrubText;
    this.registerRouting = opts.registerRouting;
  }

  setRoutingRegistrar(registerRouting: LateWakeRoutingRegistrar): void {
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
    void Promise.resolve()
      .then(() => this.publish(request))
      .catch((err: unknown) => {
        this.logger.error({ ...ids, err }, 'turn-handoff recovery: failed to re-run a passed-on correction; it is lost');
      });
  };

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
    // performHandoff hands over only from an authenticated sender (SMS excepted). A recovery
    // re-runs the text as that sender, so a root that fails the rule is never re-run (#2588).
    if (!handingRootAuthenticated(from)) {
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
      senderId: from.senderId,
      content: handoffRecoveryContent(reason, text),
      // Curia re-running a message, not the person saying it now (#1892).
      syntheticTurn: true,
      metadata: {
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
