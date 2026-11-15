// Cross-conversation hand-off (#2588). When a person's new turn judges their message to be a
// correction to their own turn still running in another conversation, the coordinator calls
// `turn-handoff` with that turn's id and the runtime runs performHandoff:
//
//   - the target's coordinator is running → the message is queued into that turn's lane and
//     drained at its next point, as a same-contact follow-up framed as handed over;
//   - only a detached specialist is still running → the message is held in the registry and
//     the root's late-delegation wake drains it at turn start;
//   - anything else → the model is told to do the work itself.
//
// The person's words come only from the handing root's trusted dispatcher stamp
// (requestText), never from the model's tool input, and only after a clean inbound scan.
// Both ends must pass the backstop's authenticated-root rule (isAuthenticatedRoot in
// turn-activity.ts: the channel authenticated the sender, or the root is on SMS, web or CLI):
// a forged email From must not ride into another turn, and a person's real words must not
// reach a turn a forged From started. The same rule picks the other-turns note's reader and
// the turns it lists, a held correction's wake and a recovery's handing turn. Fail-open: any
// error logs and tells the model to do the work itself.
//
// Once the person has been told a message was passed on or held, losing it in this process
// is never silent: the registry's recoverHandoff re-runs it as a fresh turn on the handing
// conversation (src/agents/handoff-recovery.ts). A restart still loses it (ADR-053 section 7).

import { createHash } from 'node:crypto';
import {
  isAuthenticatedRoot,
  isPersonTurn,
  type HandoffRecoveryReason,
  type HandoffRecoveryRequest,
  type HeldCorrection,
  type RootTurn,
  type TurnActivityRegistry,
} from '../dispatch/turn-activity.js';
import type { InjectableInput, TicketResult, TurnLanes } from '../dispatch/turn-lanes.js';
import type { Logger } from '../logger.js';

export const TURN_HANDOFF_TOOL_NAME = 'turn-handoff';

/** How long the handing turn waits for the target turn to take the message. */
export const HANDOFF_DRAIN_WAIT_MS = 30_000;

/**
 * A passed-on message still neither drained nor returned this long after it was queued is
 * treated as lost (a retained follow-up whose audit never flushed, a hung turn) and re-run on
 * the handing turn.
 */
export const HANDOFF_LOST_AFTER_MS = 10 * 60_000;

export type HandoffDeclineReason =
  | 'finished'
  | 'inactive'
  | 'unreachable'
  | 'not_same_person'
  | 'unauthenticated'
  | 'not_one_to_one'
  | 'cap'
  | 'closing'
  | 'ineligible'
  | 'tool_error'
  | 'internal_error';

export type HandoffOutcome =
  | { kind: 'delivered' }
  | { kind: 'queued' }
  | { kind: 'held_for_wake' }
  /** This turn already passed its message to that turn (registry.wasHandedOff). */
  | { kind: 'already_handed_over' }
  | { kind: 'do_it_yourself'; reason: HandoffDeclineReason };

/** A short human phrase per reason, filled into the do-it-yourself copy. */
const REASON_TEXT: Record<HandoffDeclineReason, string> = {
  finished: 'that turn has already finished',
  inactive: 'that turn is no longer active',
  unreachable: "that turn is busy and can't take messages right now",
  not_same_person: 'that turn is not with this person',
  unauthenticated: "that turn's sender wasn't verified by its channel",
  not_one_to_one: 'that conversation includes other people',
  cap: 'that turn has taken all the follow-ups it can',
  closing: 'that turn is just wrapping up',
  ineligible: "this message can't be passed on automatically",
  tool_error: 'the hand-off tool failed',
  internal_error: 'something went wrong passing it on',
};

/** A fixed label for the conversation the message came from, for the handed-over frame. */
const CONVERSATION_LABELS: Record<string, string> = {
  signal: 'Signal',
  slack: 'Slack DM',
  sms: 'SMS',
  email: 'email thread',
  web: 'web app',
  cli: 'CLI',
};

function conversationLabel(channelId: string): string {
  return CONVERSATION_LABELS[channelId] ?? channelId;
}

const PASSED_ON = "Passed on to the turn already doing that work. Tell them briefly you've passed it on; don't do the work here.";
const HELD = "That work is still finishing in the background; the change will be applied when it lands, or picked up here if it can't be. Tell them so briefly; don't do the work here.";
const ALREADY = "This message was already passed on to that turn; don't pass it again or do the work here. Tell them briefly it's in hand.";

export function handoffOutcomeText(outcome: HandoffOutcome): string {
  switch (outcome.kind) {
    case 'delivered':
    case 'queued':
      return PASSED_ON;
    case 'held_for_wake':
      return HELD;
    case 'already_handed_over':
      return ALREADY;
    case 'do_it_yourself':
      return `Couldn't hand this over (${REASON_TEXT[outcome.reason]}). Do the work here yourself; the other turn's actions are listed above, so adjust them rather than repeat them.`;
  }
}

/**
 * The tool's marker: `{ handoff_requested: true, turn_id }` (the caller parses a JSON string
 * result first). Null when the result is anything else.
 */
export function parseHandoffRequest(data: unknown): { turnId: string } | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record['handoff_requested'] !== true) return null;
  const turnId = record['turn_id'];
  return typeof turnId === 'string' && turnId.length > 0 ? { turnId } : null;
}

export interface PerformHandoffArgs {
  registry: TurnActivityRegistry;
  lanes: TurnLanes;
  logger: Logger;
  /** The task that called `turn-handoff` (the handing turn's coordinator task). */
  fromTaskEventId: string;
  /** The `turn_id` the model passed: a root id from the other-turns note. */
  targetRootId: string;
  /** The handing turn's sender display name, for the frame; it falls back to "the sender". */
  senderLabel?: string;
  /**
   * True once the handing task has drained a follow-up into itself: the person said more than
   * the root's request text, so that text is no longer what they are asking for.
   */
  drainedFollowUp?: boolean;
  /** The handing task's real `payload.liveTurn`; the handed input copies it. Absent: false. */
  handingLiveTurn?: boolean;
  /**
   * Replaces tracked sign-in codes (verification tracker scrubText). The text is run through
   * it before it is handed over, which catches a code registered after the dispatcher stamped
   * the text. Absent when the runtime has no verification runtime.
   */
  scrubText?: (text: string) => string;
}

const decline = (reason: HandoffDeclineReason): HandoffOutcome => ({ kind: 'do_it_yourself', reason });

/**
 * Why the task `taskEventId`, under root `mine`, may not hand its message to another turn,
 * or null when it may: a resolved, authenticated person's root inbound turn (not a wake or a
 * delegated task under it) whose own words are known in full and scanned clean.
 */
export function handingIneligibility(mine: RootTurn, taskEventId: string): string | null {
  if (!isPersonTurn(mine)) return 'not_person_turn';
  if (mine.rootId !== taskEventId) return 'not_root_task';
  if (!isAuthenticatedRoot(mine)) return 'unauthenticated';
  if (mine.requestText === null) return 'no_request_text';
  if (mine.requestTextClipped) return 'request_text_clipped';
  if (mine.inboundScanFindings !== 0) return 'scan_not_clean';
  return null;
}

/**
 * Whether the task may hand its message to another turn (handingIneligibility is null). The
 * other-turns note shows its hand-off line, and the runtime offers the tool, only when this
 * holds (and lanes are on, and the tool is in the turn's tools).
 */
export function handingRootEligible(mine: RootTurn, taskEventId: string): boolean {
  return handingIneligibility(mine, taskEventId) === null;
}

/**
 * A stable id per (handing root, target root), UUIDv5-shaped from a SHA-1 of the pair. A
 * repeated call is then the same inbound to the lane (deduped) and to the wake hold.
 */
export function handoffInboundEventId(fromRootId: string, targetRootId: string): string {
  const hex = createHash('sha1').update(`curia:turn-handoff:${fromRootId}\u0000${targetRootId}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function samePerson(mine: RootTurn, other: RootTurn): boolean {
  return isPersonTurn(other) && other.originatorContactId === mine.originatorContactId;
}

/**
 * Hand the handing turn's message to the same person's turn `targetRootId`. Never throws:
 * an error is logged and the model is told to do the work itself.
 */
export async function performHandoff(args: PerformHandoffArgs): Promise<HandoffOutcome> {
  const { logger, fromTaskEventId, targetRootId } = args;
  try {
    const outcome = await runHandoff(args);
    if (outcome.kind === 'delivered' || outcome.kind === 'queued' || outcome.kind === 'held_for_wake') {
      // Only the root task hands over (runHandoff), so its id is the handing root's.
      args.registry.markHandedOff(fromTaskEventId, targetRootId);
    }
    return outcome;
  } catch (err) {
    logger.error({ err, fromTaskEventId, targetRootId }, 'turn-handoff: hand-off failed; the turn does the work itself');
    return decline('internal_error');
  }
}

async function runHandoff(args: PerformHandoffArgs): Promise<HandoffOutcome> {
  const { registry, lanes, logger, fromTaskEventId, targetRootId } = args;
  const ids = { fromTaskEventId, targetRootId };

  // The handing turn must be a live, resolved person's turn with their own scanned words.
  const mine = registry.rootOf(fromTaskEventId);
  if (!mine || !isPersonTurn(mine)) {
    logger.info({ ...ids, known: mine !== undefined }, 'turn-handoff: the handing turn is not a resolved person turn');
    return decline('ineligible');
  }
  // Only the root's own task carries the person's message as requestText. A wake or a
  // delegated task under the root would pass on words it was not answering.
  if (mine.rootId !== fromTaskEventId) {
    logger.info(ids, 'turn-handoff: called from a task that is not the root inbound turn');
    return decline('ineligible');
  }
  if (targetRootId === mine.rootId) {
    logger.info(ids, 'turn-handoff: the model named its own turn');
    return decline('ineligible');
  }
  // A forged From can start an email turn resolved to the principal; its text must not reach
  // an authenticated turn as a live follow-up (#2588 SEC HIGH-1).
  if (!isAuthenticatedRoot(mine)) {
    logger.info({ ...ids, channelId: mine.channelId }, 'turn-handoff: the handing turn\'s sender was not authenticated');
    return decline('ineligible');
  }
  // The only handing-side condition that changes during the turn: once a follow-up has been
  // drained, the person said more than the request text, so it is not the whole request. Checked
  // before the dedupe below, so a new correction after a hand-off is done here, not dropped as
  // "already passed on".
  if (args.drainedFollowUp === true) {
    logger.info(ids, 'turn-handoff: the turn took a follow-up since its message; its text is not the whole request');
    return decline('ineligible');
  }
  // A repeated call for a message already passed on, whatever has become of the target since:
  // its coordinator may have released the lane (forgetting what it drained) and a wake or a
  // later coordinator would take the same message again; or the target may have finished,
  // and the model would be told to do the work a second time.
  if (registry.wasHandedOff(mine.rootId, targetRootId)) {
    logger.info(ids, 'turn-handoff: this message was already passed on to that turn; not passing it again');
    return { kind: 'already_handed_over' };
  }

  // Window, scope and staleness all come from the registry's own view of my other turns.
  const target = registry.otherRootsInWindow(mine.rootId).find((r) => r.rootId === targetRootId);
  if (!target) {
    const known = registry.rootOf(targetRootId);
    const sameRoot = known !== undefined && known.rootId === targetRootId;
    logger.info({ ...ids, known: sameRoot }, 'turn-handoff: the target is not among this turn\'s other turns');
    return decline(sameRoot && !samePerson(mine, known) ? 'not_same_person' : 'inactive');
  }
  if (!samePerson(mine, target)) return decline('not_same_person');
  // The reverse of the handing check: a forged From can start a turn resolved to this person,
  // and their real words must not reach it, live or held for its wake (#2588 SEC HIGH).
  if (!isAuthenticatedRoot(target)) {
    logger.info({ ...ids, targetChannelId: target.channelId }, "turn-handoff: the target turn's sender was not authenticated");
    return decline('unauthenticated');
  }
  // A turn in this same conversation already gets the message as an ordinary follow-up.
  if (target.conversationId === mine.conversationId) return decline('ineligible');
  if (!target.audienceOneToOne) return decline('not_one_to_one');

  if (mine.requestText === null || mine.requestTextClipped || mine.inboundScanFindings !== 0) {
    logger.info(
      {
        ...ids,
        hasRequestText: mine.requestText !== null,
        requestTextClipped: mine.requestTextClipped,
        inboundScanFindings: mine.inboundScanFindings,
      },
      'turn-handoff: the message has no full trusted text or a non-clean scan; not passed on',
    );
    return decline('ineligible');
  }
  if (!lanes.enabled) {
    logger.info(ids, 'turn-handoff: turn lanes are off; nothing can take a hand-off');
    return decline('ineligible');
  }

  // A code the tracker learned after the dispatcher stamped the text is scrubbed here.
  const text = args.scrubText ? args.scrubText(mine.requestText) : mine.requestText;
  const input: InjectableInput = {
    inboundEventId: handoffInboundEventId(mine.rootId, target.rootId),
    // isPersonTurn checked it is a UUID.
    senderContactId: mine.originatorContactId as string,
    senderResolved: true,
    autoGenerated: false,
    // Checked above: the handing root's inbound scan ran and found nothing.
    injectionFindingCount: 0,
    channelId: mine.channelId,
    // The handing task's own live signal (#1126), never more. A held one is set to false below.
    // Never into a target whose sender is not authenticated, even if a later path skips the
    // check above.
    liveTurn: args.handingLiveTurn === true && isAuthenticatedRoot(target),
    content: text,
    originalContent: text,
    // When the person sent it, not when it was handed over.
    receivedAt: new Date(mine.startedAt).toISOString(),
    ...(args.senderLabel !== undefined && args.senderLabel.length > 0 && { senderLabel: args.senderLabel }),
    handedOverFrom: { channelId: mine.channelId, conversationLabel: conversationLabel(mine.channelId) },
  };
  const logIds = { ...ids, inboundEventId: input.inboundEventId };

  if (target.runningCoordinatorTaskId !== null) {
    const hostTaskEventId = target.runningCoordinatorTaskId;
    // The target's conversation, so a lane held elsewhere by that task id is refused.
    const result = lanes.tryInjectIntoTask(hostTaskEventId, input, target.conversationId);
    if (result.kind === 'not_injected') {
      logger.info({ ...logIds, hostTaskEventId, reason: result.reason }, 'turn-handoff: the running turn did not take the message');
      switch (result.reason) {
        case 'cap':
          return decline('cap');
        case 'closing':
          return decline('closing');
        // Its coordinator is running but holds no lane: it waits for one, or has just
        // released it. Either way it cannot take a message now; it has not finished.
        case 'no_holder':
          return decline('unreachable');
        case 'disabled':
        case 'ineligible':
          return decline('ineligible');
      }
    }
    return awaitTicket(args, mine, result.ticket, input, { ...logIds, hostTaskEventId });
  }

  if (registry.hasDetachedWork(target.rootId)) {
    // Only a detached specialist is working; its wake drains the hold at turn start.
    if (!registry.holdForWake(target.rootId, forWake(input), mine)) return decline('cap');
    logger.info(logIds, 'turn-handoff: held the message for the running turn\'s wake');
    return { kind: 'held_for_wake' };
  }
  return decline('finished');
}

/**
 * A held input reaches a late-delegation wake, which never carries liveTurn (#1126): the
 * elevated self-approval signal must not come back minutes later through a hand-off.
 */
function forWake(input: InjectableInput): InjectableInput {
  return { ...input, liveTurn: false };
}

const TIMED_OUT = Symbol('timed out');

/**
 * Wait up to HANDOFF_DRAIN_WAIT_MS for the target turn to drain the message. A return (the
 * turn ended without draining it) holds it for the root's wake only while a detached
 * specialist still runs under the root: the returning coordinator itself is still listed as
 * running (its lane is released before its end is recorded) and will not wake anything.
 * After the wait the outcome is `queued`. A later return is still held when it can be, and
 * otherwise re-run on the handing turn (recoverHandoff 'returned'); so is a message neither
 * drained nor returned after HANDOFF_LOST_AFTER_MS ('unresolved').
 */
async function awaitTicket(
  args: PerformHandoffArgs,
  mine: RootTurn,
  ticket: Promise<TicketResult>,
  input: InjectableInput,
  logIds: Record<string, string>,
): Promise<HandoffOutcome> {
  const { registry, logger, targetRootId } = args;
  let waitOver = false;
  const watch = watchForLoss(registry, logger, { from: mine, targetRootId, input }, logIds);
  const recover = watch.recover;

  const settled = ticket.then((result): HandoffOutcome => {
    watch.settled();
    if (result.kind === 'drained') {
      if (watch.recovered) {
        logger.warn(logIds, 'turn-handoff: the running turn took the message after it was re-run on the handing turn');
      } else {
        logger.info(logIds, 'turn-handoff: the running turn took the message');
      }
      return { kind: 'delivered' };
    }
    if (watch.recovered) return decline('finished');
    const detached = registry.hasDetachedWork(targetRootId);
    if (detached && registry.holdForWake(targetRootId, forWake(input), mine)) {
      logger.info(logIds, 'turn-handoff: the turn ended without the message; held for its wake');
      return { kind: 'held_for_wake' };
    }
    if (waitOver) {
      // The handing turn already told the person it was passed on.
      logger.info(logIds, 'turn-handoff: a passed-on message came back with nothing to take it; re-running it on the handing turn');
      recover('returned');
    }
    // A specialist runs but the hold was full, or nothing under the root will wake.
    return decline(detached ? 'cap' : 'finished');
  }).catch((err: unknown): HandoffOutcome => {
    watch.settled();
    logger.error({ ...logIds, err }, 'turn-handoff: failed to settle a passed-on message');
    if (waitOver) recover('returned');
    return decline('internal_error');
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), HANDOFF_DRAIN_WAIT_MS);
  });
  try {
    const first = await Promise.race([settled, timeout]);
    if (first !== TIMED_OUT) return first;
    waitOver = true;
    logger.info(logIds, 'turn-handoff: the running turn has not drained the message yet; reporting it as passed on');
    return { kind: 'queued' };
  } finally {
    clearTimeout(timer);
  }
}

interface LossWatch {
  /** Re-run the correction on its handing turn with this reason; once, across every trigger. */
  recover(reason: HandoffRecoveryReason): void;
  /** Whether a recovery has been requested. */
  readonly recovered: boolean;
  /** The ticket settled: the lost-message timer stops. */
  settled(): void;
}

/**
 * The lost-message timer every queued correction gets (#2588): a ticket neither drained nor
 * returned HANDOFF_LOST_AFTER_MS after it was queued (a retained follow-up whose audit never
 * flushed, a hung turn) is re-run on the handing turn as 'unresolved'. One `recovered` flag
 * covers the timer and the caller's own triggers, so a late result never recovers twice.
 */
function watchForLoss(
  registry: TurnActivityRegistry,
  logger: Logger,
  request: Omit<HandoffRecoveryRequest, 'reason'>,
  logIds: Record<string, string>,
): LossWatch {
  let recovered = false;
  let settled = false;
  const recover = (reason: HandoffRecoveryReason): void => {
    if (recovered) return;
    recovered = true;
    registry.recoverHandoff({ ...request, reason });
  };
  const timer = setTimeout(() => {
    if (settled) return;
    logger.warn(logIds, 'turn-handoff: a passed-on message was not taken in time; re-running it on the handing turn');
    recover('unresolved');
  }, HANDOFF_LOST_AFTER_MS);
  // Never keeps the process alive on its own.
  timer.unref?.();
  return {
    recover,
    get recovered() {
      return recovered;
    },
    settled() {
      settled = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Watch a held correction's ticket once it is queued into its late-delegation wake (#2588).
 * The ticket only resolves; a wake that ends without draining it returns it, which re-runs
 * it on its handing turn ('wake_returned'). A ticket that stays pending (a retained follow-up
 * whose audit never flushes, a wake that never reaches a drain point) is re-run after
 * HANDOFF_LOST_AFTER_MS ('unresolved'), like a direct hand-off. A drain after that recovery is
 * logged and not undone: both turns act on it, and the backstop holds the second's repeat of
 * a target the first already touched (the owner's 10-minute trigger decision, ADR-053).
 */
export function watchHeldCorrectionTicket(args: {
  registry: TurnActivityRegistry;
  logger: Logger;
  ticket: Promise<TicketResult>;
  held: HeldCorrection;
  /** The root whose wake took it. */
  targetRootId: string;
  logIds: Record<string, string>;
}): void {
  const { registry, logger, ticket, held, targetRootId, logIds } = args;
  const watch = watchForLoss(registry, logger, { from: held.from, targetRootId, input: held.input }, logIds);
  void ticket.then((result) => {
    watch.settled();
    if (result.kind === 'drained') {
      if (watch.recovered) {
        logger.warn(logIds, 'A held hand-off correction was drained by its wake after it was re-run on its handing turn');
      }
      return;
    }
    if (watch.recovered) return;
    logger.warn(logIds, 'A held hand-off correction was not drained by its wake — re-running it on its handing turn');
    watch.recover('wake_returned');
  }).catch((err: unknown) => {
    watch.settled();
    logger.error({ ...logIds, err }, 'Failed to settle a held hand-off correction in its wake');
    watch.recover('wake_returned');
  });
}
