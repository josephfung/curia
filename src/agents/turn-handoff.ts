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
// Fail-open: any error logs and tells the model to do the work itself.

import { randomUUID } from 'node:crypto';
import type { RootTurn, TurnActivityRegistry } from '../dispatch/turn-activity.js';
import type { InjectableInput, TicketResult, TurnLanes } from '../dispatch/turn-lanes.js';
import type { Logger } from '../logger.js';
import { isUuid } from '../util/uuid.js';

export const TURN_HANDOFF_TOOL_NAME = 'turn-handoff';

/** How long the handing turn waits for the target turn to take the message. */
export const HANDOFF_DRAIN_WAIT_MS = 30_000;

export type HandoffDeclineReason = 'finished' | 'not_same_person' | 'not_one_to_one' | 'cap' | 'closing' | 'ineligible';

export type HandoffOutcome =
  | { kind: 'delivered' }
  | { kind: 'queued' }
  | { kind: 'held_for_wake' }
  | { kind: 'do_it_yourself'; reason: HandoffDeclineReason };

/** A short human phrase per reason, filled into the do-it-yourself copy. */
const REASON_TEXT: Record<HandoffDeclineReason, string> = {
  finished: 'that turn has already finished',
  not_same_person: 'that turn is not with this person',
  not_one_to_one: 'that conversation includes other people',
  cap: 'that turn has taken all the follow-ups it can',
  closing: 'that turn is just wrapping up',
  ineligible: "this message can't be passed on automatically",
};

/** A fixed label for the conversation the message came from, for the handed-over frame. */
const CONVERSATION_LABELS: Record<string, string> = {
  signal: 'Signal',
  slack: 'Slack DM',
  sms: 'SMS',
  email: 'email thread',
};

function conversationLabel(channelId: string): string {
  return CONVERSATION_LABELS[channelId] ?? channelId;
}

const PASSED_ON = "Passed on to the turn already doing that work. Tell them briefly you've passed it on; don't do the work here.";
const HELD = "That work is still finishing in the background; the change will be applied when it lands. Tell them so briefly; don't do the work here.";

export function handoffOutcomeText(outcome: HandoffOutcome): string {
  switch (outcome.kind) {
    case 'delivered':
    case 'queued':
      return PASSED_ON;
    case 'held_for_wake':
      return HELD;
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
}

const decline = (reason: HandoffDeclineReason): HandoffOutcome => ({ kind: 'do_it_yourself', reason });

/** A resolved person's turn, not Curia's own work. */
function isPersonTurn(root: RootTurn): boolean {
  return root.originatorResolved && !root.originatorIsSystem && isUuid(root.originatorContactId);
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
    return await runHandoff(args);
  } catch (err) {
    logger.error({ err, fromTaskEventId, targetRootId }, 'turn-handoff: hand-off failed; the turn does the work itself');
    return decline('ineligible');
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

  // Window, scope and staleness all come from the registry's own view of my other turns.
  const target = registry.otherRootsInWindow(mine.rootId).find((r) => r.rootId === targetRootId);
  if (!target) {
    const known = registry.rootOf(targetRootId);
    const sameRoot = known !== undefined && known.rootId === targetRootId;
    logger.info({ ...ids, known: sameRoot }, 'turn-handoff: the target is not among this turn\'s other turns');
    return decline(sameRoot && !samePerson(mine, known) ? 'not_same_person' : 'finished');
  }
  if (!samePerson(mine, target)) return decline('not_same_person');
  // A turn in this same conversation already gets the message as an ordinary follow-up.
  if (target.conversationId === mine.conversationId) return decline('ineligible');
  if (!target.audienceOneToOne) return decline('not_one_to_one');

  if (mine.requestText === null || mine.inboundScanFindings !== 0) {
    logger.info(
      { ...ids, hasRequestText: mine.requestText !== null, inboundScanFindings: mine.inboundScanFindings },
      'turn-handoff: the message has no trusted text or a non-clean scan; not passed on',
    );
    return decline('ineligible');
  }
  if (!lanes.enabled) {
    logger.info(ids, 'turn-handoff: turn lanes are off; nothing can take a hand-off');
    return decline('ineligible');
  }

  const input: InjectableInput = {
    inboundEventId: randomUUID(),
    // isPersonTurn checked it is a UUID.
    senderContactId: mine.originatorContactId as string,
    senderResolved: true,
    autoGenerated: false,
    // Checked above: the handing root's inbound scan ran and found nothing.
    injectionFindingCount: 0,
    channelId: mine.channelId,
    liveTurn: true,
    content: mine.requestText,
    originalContent: mine.requestText,
    receivedAt: new Date().toISOString(),
    ...(args.senderLabel !== undefined && args.senderLabel.length > 0 && { senderLabel: args.senderLabel }),
    handedOverFrom: { channelId: mine.channelId, conversationLabel: conversationLabel(mine.channelId) },
  };
  const logIds = { ...ids, inboundEventId: input.inboundEventId };

  if (target.runningCoordinatorTaskId !== null) {
    const hostTaskEventId = target.runningCoordinatorTaskId;
    const result = lanes.tryInjectIntoTask(hostTaskEventId, input);
    if (result.kind === 'not_injected') {
      logger.info({ ...logIds, hostTaskEventId, reason: result.reason }, 'turn-handoff: the running turn did not take the message');
      switch (result.reason) {
        case 'cap':
          return decline('cap');
        case 'closing':
          return decline('closing');
        // Its lane was just released: the coordinator is finishing.
        case 'no_holder':
          return decline('finished');
        case 'disabled':
        case 'ineligible':
          return decline('ineligible');
      }
    }
    return awaitTicket(args, result.ticket, input, { ...logIds, hostTaskEventId });
  }

  if (registry.isRootRunning(target.rootId)) {
    // Only a detached specialist is working; its wake drains the hold at turn start.
    if (!registry.holdForWake(target.rootId, input)) return decline('cap');
    logger.info(logIds, 'turn-handoff: held the message for the running turn\'s wake');
    return { kind: 'held_for_wake' };
  }
  return decline('finished');
}

const TIMED_OUT = Symbol('timed out');

/**
 * Wait up to HANDOFF_DRAIN_WAIT_MS for the target turn to drain the message. A return (the
 * turn ended without draining it) holds it for the root's wake while the root still runs.
 * After the wait the outcome is `queued`, and a later return is still held, or logged at
 * error when nothing can take it: the correction is then lost.
 */
async function awaitTicket(
  args: PerformHandoffArgs,
  ticket: Promise<TicketResult>,
  input: InjectableInput,
  logIds: Record<string, string>,
): Promise<HandoffOutcome> {
  const { registry, logger, targetRootId } = args;
  let waitOver = false;
  const settled = ticket.then((result): HandoffOutcome => {
    if (result.kind === 'drained') {
      logger.info(logIds, 'turn-handoff: the running turn took the message');
      return { kind: 'delivered' };
    }
    const running = registry.isRootRunning(targetRootId);
    if (running && registry.holdForWake(targetRootId, input)) {
      logger.info(logIds, 'turn-handoff: the turn ended without the message; held for its wake');
      return { kind: 'held_for_wake' };
    }
    if (waitOver) {
      // The handing turn already told the person it was passed on.
      logger.error(logIds, 'turn-handoff: a passed-on message came back with nothing to take it; the correction is lost');
    }
    // Still running but the hold was full, or the whole turn has ended.
    return decline(running ? 'cap' : 'finished');
  }).catch((err: unknown): HandoffOutcome => {
    logger.error({ ...logIds, err }, 'turn-handoff: failed to settle a passed-on message');
    return decline('ineligible');
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
