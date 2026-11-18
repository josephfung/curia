// Turn activity registry (#2588). One in-process record of "which root turns are running or
// recently finished, and which risky actions (with targets) each has taken".
//
// A "root" is the turn a person started: the root task, plus every delegated specialist and
// late-delegation wake that continues it. Two roots that act on the same target (a contact, a
// site, an id, a tool) within the window are worth a pause: the second caller is held once and
// told what the first did, then may re-issue. The roots are usually in different
// conversations. In the same conversation, a root counts while still running (an earlier turn
// whose detached specialist is still working) or when it ended after the caller started; one
// that ended before then is already in the history the caller read.
//
// Single process (ADR-053 section 7). The maps live in this process; a second Curia would not
// see this one's turns. The registry fails open: an unknown task id, a pruned parent, or an
// evicted root yields no hold rather than an error.
//
// taskStarted, taskEnded, ensureRoot, checkAndRecord, recordOnly and settle are synchronous.
// There must be no await inside checkAndRecord: the check and the record have to be one atomic
// step, or two roots could each see an empty registry and both proceed.
//
// Public getters return copies, so a caller cannot mutate registry state.

import {
  delegationOriginAgentId,
  delegationOriginConversationId,
  delegationOriginTaskEventId,
  isDelegatedSpecialistTask,
  parseTaskOriginator,
} from '../agents/delegated-task-context.js';
import type { TaskOriginator } from '../contacts/types.js';
import type { Logger } from '../logger.js';
import { isUuid } from '../util/uuid.js';
import { frozenAudienceMetadataOf, isOneToOneAudience } from './audience.js';
import type { InjectableInput } from './turn-lanes.js';

export const TURN_ACTIVITY_WINDOW_MS = 15 * 60_000;
export const MAX_TRACKED_ROOTS = 1_000;
export const MAX_TRACKED_ACTIONS = 5_000;
/** One root cannot crowd out another's actions: past this, its own oldest action is dropped. */
export const MAX_ACTIONS_PER_ROOT = 200;
/**
 * A root still "running" this long after it started (an auto root: after its last activity)
 * has almost certainly lost its end event. It is treated as ended, for the window and for
 * pruning, so it cannot pin the registry's memory or hold others forever.
 */
export const MAX_RUNNING_ROOT_AGE_MS = 6 * 60 * 60_000;
/** Hand-off corrections held for one root's next wake (turn-handoff, #2588). */
export const MAX_HELD_PER_ROOT = 5;
/** checkAndRecord prunes at most this often: every N calls, or after this long. */
const PRUNE_EVERY_CALLS = 50;
const PRUNE_INTERVAL_MS = 60_000;

const REQUEST_TEXT_MAX_CODE_POINTS = 500;
const COORDINATOR_AGENT_ID = 'coordinator';

/**
 * Trusted task-metadata keys the dispatcher stamps on an inbound's coordinator task, and
 * strips from channel-supplied metadata (mergeTaskMetadata). The sender's own text, before
 * any dispatcher preamble (message id, thread participants, outbound context), clipped by
 * clipSenderText; and the inbound injection scan's finding count, absent when no scan ran.
 */
export const INBOUND_SENDER_TEXT_KEY = 'inboundSenderText';
export const INBOUND_SCAN_FINDING_COUNT_KEY = 'inboundScanFindingCount';
/** Trusted flag, stamped `true` when the dispatcher clipped the sender's text (it is partial). */
export const INBOUND_SENDER_TEXT_CLIPPED_KEY = 'inboundSenderTextClipped';
/**
 * Trusted task-metadata key on a hand-off recovery task (src/agents/handoff-recovery.ts):
 * `{ targetRootId, reason }`. Only that system publisher stamps it; mergeTaskMetadata strips it.
 */
export const HANDOFF_RECOVERY_KEY = 'handoffRecovery';

/** The sender's text clipped to the registry's limit, by code points. */
export function clipSenderText(text: string): string {
  return Array.from(text).slice(0, REQUEST_TEXT_MAX_CODE_POINTS).join('');
}

/** Whether clipSenderText would cut this text. */
export function senderTextExceedsClip(text: string): boolean {
  // Code points are at most two UTF-16 units: a short string cannot exceed the limit.
  if (text.length <= REQUEST_TEXT_MAX_CODE_POINTS) return false;
  return Array.from(text).length > REQUEST_TEXT_MAX_CODE_POINTS;
}

/** The trusted sender text of a task, clipped; null when absent or empty. */
function senderTextOf(metadata: Record<string, unknown> | undefined): string | null {
  const value = metadata?.[INBOUND_SENDER_TEXT_KEY];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return clipSenderText(value);
}

/**
 * Whether the task's sender text is partial: the dispatcher stamped it clipped, or the
 * stamped text is itself past the limit (clipped here). False when there is no text.
 */
function senderTextClippedOf(metadata: Record<string, unknown> | undefined): boolean {
  const value = metadata?.[INBOUND_SENDER_TEXT_KEY];
  if (typeof value !== 'string' || value.trim() === '') return false;
  return metadata?.[INBOUND_SENDER_TEXT_CLIPPED_KEY] === true || senderTextExceedsClip(value);
}

/** The trusted finding count of a task: a non-negative integer, else null (unknown). */
function scanFindingsOf(metadata: Record<string, unknown> | undefined): number | null {
  const value = metadata?.[INBOUND_SCAN_FINDING_COUNT_KEY];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A frozen copy of the task's stamped originator, or null when it has none. */
function originatorOf(metadata: Record<string, unknown> | undefined): Readonly<TaskOriginator> | null {
  const parsed = parseTaskOriginator(metadata?.['originator']);
  return parsed ? Object.freeze({ ...parsed }) : null;
}

/** A resolved person's turn: not a stranger's (unresolved) and not Curia's own work (#2588). */
export function isPersonTurn(root: RootTurn): boolean {
  return root.originatorResolved && !root.originatorIsSystem && isUuid(root.originatorContactId);
}

/**
 * A hand-off correction held for a root's next late-delegation wake, with the handing turn it
 * came from: a lost one is re-run there (recoverHandoff).
 */
export interface HeldCorrection {
  input: InjectableInput;
  /** The handing root, as it was when the correction was held. */
  from: RootTurn;
}

/** Why a passed-on or held correction did not reach the work it was handed to. */
export type HandoffRecoveryReason =
  /** The target turn ended without draining it, after the handing turn reported it passed on. */
  | 'returned'
  /** Still not drained HANDOFF_LOST_AFTER_MS after it was queued. */
  | 'unresolved'
  /** The target root ended with it still held for a wake. */
  | 'root_ended'
  /** The target root was pruned or evicted with it still held. */
  | 'root_dropped'
  /** The target's wake could not take it into its lane. */
  | 'wake_not_injected'
  /** The target's wake ended without draining it. */
  | 'wake_returned';

export interface HandoffRecoveryRequest {
  /** The handing root: the recovery turn runs on its conversation and channel. */
  from: RootTurn;
  targetRootId: string;
  input: InjectableInput;
  reason: HandoffRecoveryReason;
}

/** Publishes the recovery turn. Must not throw and must not re-enter the registry synchronously. */
export type HandoffRecoverer = (request: HandoffRecoveryRequest) => void;

export interface RootTurn {
  /** Root task event id (or voice session id). */
  rootId: string;
  conversationId: string;
  channelId: string;
  agentId: string;
  originatorContactId: string | null;
  /** Same rule as holderFromAgentTask (turn-lanes.ts): the originator is a resolved contact. */
  originatorResolved: boolean;
  /**
   * Curia's own work, judged by originator, not channel (turn-lanes.ts originatorIsSystem):
   * no originator, or a `system` / `agent` role. Such a root holds others even unresolved,
   * and sees a hold's details. An internal or scheduler task carrying a person's originator
   * is that person's turn.
   */
  originatorIsSystem: boolean;
  /** The root's conversation is one-to-one (audience.ts); false for an auto root or unknown audience. */
  audienceOneToOne: boolean;
  /**
   * The root task's metadata fields audienceOneToOne was judged from (audienceMetadataOf), so a
   * task re-run for this root judges its audience the same way; null when it had none (or auto).
   */
  audienceMetadata: Readonly<Record<string, unknown>> | null;
  /** The root task's `payload.accountId` (which mailbox received it); null when it had none. */
  accountId: string | null;
  /**
   * The sender's own words, from the dispatcher's trusted INBOUND_SENDER_TEXT_KEY, clipped to
   * 500 code points. Null for a root with no such stamp (scheduler, internal, voice): task
   * content can carry dispatcher preamble and other people's words, so it is never used.
   */
  requestText: string | null;
  /** True when requestText is only the start of the sender's message (clipped). */
  requestTextClipped: boolean;
  /** Injection-scan finding count of the root's inbound (trusted stamp); null = unknown. */
  inboundScanFindings: number | null;
  /**
   * The dispatcher-stamped `metadata.originator.authenticated === true` of the root's task:
   * the channel authenticated the sender (Signal, Slack, a verified email). Fails closed: a
   * missing stamp is false. An auto root takes its seed's (voice: false).
   */
  originatorAuthenticated: boolean;
  /** A frozen copy of the root task's stamped originator; null when it had none (or auto). */
  originator: Readonly<TaskOriginator> | null;
  /** The root task's channel sender id, for routing a reply; null when unknown (auto roots). */
  senderId: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Set when no task under the root is running. */
  endedAt: number | null;
  runningTaskIds: ReadonlySet<string>;
  /** The root's or a wake's coordinator task now running. */
  runningCoordinatorTaskId: string | null;
  /** True for voice sessions and unknown ids. */
  autoRegistered: boolean;
}

export interface ActionTarget {
  kind: 'contact' | 'site' | 'id' | 'tool';
  value: string;
}

/**
 * What became of a recorded call. `pending`: its handler is running. `succeeded`: it returned
 * success. `unknown`: it timed out or threw, so it may or may not have taken effect. A failed
 * call (one that returned success: false) is removed rather than kept: it did nothing another
 * turn should wait on.
 */
export type ActionOutcome = 'pending' | 'succeeded' | 'unknown';

export interface RecordedAction {
  /** Handle for settle(). */
  actionId: string;
  rootId: string;
  taskEventId: string;
  toolName: string;
  targets: readonly ActionTarget[];
  at: number;
  outcome: ActionOutcome;
}

export type BackstopDecision =
  /** `actionId` is the recorded call's handle for settle(); absent when nothing was recorded. */
  | { held: false; actionId?: string }
  | { held: true; matches: readonly { action: RecordedAction; other: RootTurn; target: ActionTarget }[] };

export interface TaskStartInput {
  taskEventId: string;
  agentId: string;
  conversationId: string;
  channelId: string;
  parentEventId: string | undefined;
  /** Also the source of a root's request text and scan count (INBOUND_* keys). */
  metadata: Record<string, unknown> | undefined;
  startedAt: number;
  originatorContactId: string | null;
  originatorResolved: boolean;
  /** turn-lanes.ts originatorIsSystem of the task's copied originator. */
  originatorIsSystem: boolean;
  /** The task's channel sender id (payload.senderId). */
  senderId?: string;
  /** The task's `payload.accountId`: the account that received it (email). */
  accountId?: string;
}

export interface EnsureRootSeed {
  conversationId: string;
  channelId: string;
  agentId: string;
  originatorContactId: string | null;
  originatorResolved: boolean;
  originatorIsSystem: boolean;
  /** The task's stamped `originator.authenticated === true`; false when unstamped. */
  originatorAuthenticated: boolean;
}

/** Mutable internal form of a root. Never handed out. */
interface RootState {
  rootId: string;
  conversationId: string;
  channelId: string;
  agentId: string;
  originatorContactId: string | null;
  originatorResolved: boolean;
  originatorIsSystem: boolean;
  audienceOneToOne: boolean;
  audienceMetadata: Readonly<Record<string, unknown>> | null;
  accountId: string | null;
  requestText: string | null;
  requestTextClipped: boolean;
  inboundScanFindings: number | null;
  originatorAuthenticated: boolean;
  originator: Readonly<TaskOriginator> | null;
  senderId: string | null;
  startedAt: number;
  endedAt: number | null;
  runningTaskIds: Set<string>;
  /** Coordinator tasks now running under the root, in start order. */
  runningCoordinatorTaskIds: Set<string>;
  autoRegistered: boolean;
  /** Every task id mapped to this root, so eviction can drop them. */
  taskIds: Set<string>;
  /**
   * Root ids this root has passed its message to (markHandedOff). Only tracked roots are
   * added and a dropped root is removed (dropRoot), so it is bounded by MAX_TRACKED_ROOTS.
   */
  handedTo: Set<string>;
  /** Last action time; an auto-registered root is pruned a window after it. */
  lastActivityAt: number;
  /**
   * Isolation scope (scopeOf at creation). Roots in different scopes never see each other.
   * Production passes no scopeOf, so every root's scope is undefined and all are comparable.
   */
  scope: string | undefined;
  /** Each logged once per root. */
  stuckWarned: boolean;
  rootCapWarned: boolean;
  invisibleLogged: boolean;
}

export interface TurnActivityRegistryOptions {
  logger: Logger;
  now?: () => number;
  /**
   * The isolation scope of a new root, from its conversation id. Roots whose scopes differ
   * never hold each other; undefined equals undefined. The behaviour suites pass one scope
   * per case attempt, so concurrent cases and a case's successive runs on the same fixtures
   * stay apart. Production passes none.
   */
  scopeOf?: (conversationId: string) => string | undefined;
  /** Curia's own mailboxes, excluded when judging whether an email thread is one-to-one. */
  selfEmails?: readonly string[];
  /** The hand-off recovery publisher; may also be set later with setHandoffRecoverer. */
  recoverHandoff?: HandoffRecoverer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The task's stamped `originator.authenticated === true`. Fails closed: absent or malformed is false. */
function originatorAuthenticatedOf(metadata: Record<string, unknown> | undefined): boolean {
  return parseTaskOriginator(metadata?.['originator'])?.authenticated === true;
}

/**
 * Whether the root's sender is known to be who the root says (#2588): the channel
 * authenticated the message (originatorAuthenticated), or it arrived on a surface counted as
 * authenticated by where it came from. Hold details and the "your other conversation" label
 * go only to authenticated roots, so a forged-From email resolved to the principal neither
 * sees the principal's actions nor has its own shown to the principal as theirs.
 *
 * - Not SMS: caller ids are spoofable (ADR-036), and a spoofed SMS from the principal's number
 *   has none of the principal's authority (GHSA-p49r-jqh2-v668). It once counted, mirroring an
 *   accepted risk the principal-mailbox send no longer takes either.
 * - web: every message needs the principal's bootstrap secret or session
 *   (channels/http/routes/chat.ts assertSecret).
 * - cli: a local shell's stdin.
 *
 * Web and CLI are principal-only surfaces (audience.ts); the dispatcher does not stamp them
 * authenticated, so they are named here.
 */
export function isAuthenticatedRoot(root: RootTurn): boolean {
  return root.originatorAuthenticated || root.channelId === 'web' || root.channelId === 'cli';
}

function targetKey(target: ActionTarget): string {
  return `${target.kind}:${target.value}`;
}

/** A non-empty string field of the task metadata. */
function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A non-empty string field of metadata.delegationOrigin. */
function delegationOriginField(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const origin = metadata?.['delegationOrigin'];
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) return undefined;
  return metadataString(origin as Record<string, unknown>, key);
}

export class TurnActivityRegistry {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly roots = new Map<string, RootState>();
  private readonly taskToRoot = new Map<string, string>();
  private actions: RecordedAction[] = [];
  private actionSeq = 0;
  /** rootId -> keys of `${otherRootId}|${kind}:${value}` already shown to that root. */
  private readonly shown = new Map<string, Set<string>>();
  /** rootId -> hand-off corrections waiting for that root's late-delegation wake, oldest first. */
  private readonly held = new Map<string, HeldCorrection[]>();
  /** Re-runs a lost correction on its handing turn's conversation (setHandoffRecoverer). */
  private recoverer: HandoffRecoverer | undefined;

  private readonly scopeOf: ((conversationId: string) => string | undefined) | undefined;
  private readonly selfEmails: readonly string[];
  /** checkAndRecord calls since the last prune, and when that prune ran. */
  private callsSincePrune = 0;
  private lastPruneAt: number;

  constructor(opts: TurnActivityRegistryOptions) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.scopeOf = opts.scopeOf;
    this.selfEmails = opts.selfEmails ?? [];
    this.lastPruneAt = this.now();
    this.recoverer = opts.recoverHandoff;
  }

  /**
   * Set the recovery publisher. Bootstrap builds it after the dispatcher (whose routing it
   * registers), which comes after this registry.
   */
  setHandoffRecoverer(recoverer: HandoffRecoverer): void {
    this.recoverer = recoverer;
  }

  /**
   * Re-run a correction the person was told was passed on or held, on its handing turn's
   * conversation, because it did not reach the work (#2588). Fail-open: with no publisher, or
   * a publisher that throws, it logs at error and returns.
   */
  recoverHandoff(request: HandoffRecoveryRequest): void {
    const ids = {
      fromRootId: request.from.rootId,
      targetRootId: request.targetRootId,
      inboundEventId: request.input.inboundEventId,
      reason: request.reason,
    };
    if (!this.recoverer) {
      this.logger.error(ids, 'turn activity: no hand-off recovery publisher; a passed-on correction is lost');
      return;
    }
    try {
      this.recoverer(request);
    } catch (err) {
      this.logger.error({ ...ids, err }, 'turn activity: hand-off recovery failed; a passed-on correction is lost');
    }
  }

  /** Register a task under its root and return that root. */
  taskStarted(input: TaskStartInput): RootTurn {
    this.prune();

    const root = this.resolveExistingRoot(input) ?? this.mergeOrCreateRoot(input);
    root.runningTaskIds.add(input.taskEventId);
    root.taskIds.add(input.taskEventId);
    root.endedAt = null;
    // An auto root never ends; a task starting under it is activity that keeps it in the window.
    if (root.autoRegistered) root.lastActivityAt = Math.max(root.lastActivityAt, this.now());
    this.taskToRoot.set(input.taskEventId, root.rootId);
    if (input.agentId === COORDINATOR_AGENT_ID && !isDelegatedSpecialistTask(input.metadata)) {
      // Delete first so a restarted id moves to the most-recent position.
      root.runningCoordinatorTaskIds.delete(input.taskEventId);
      root.runningCoordinatorTaskIds.add(input.taskEventId);
    }

    this.enforceCaps();
    return this.snapshot(root);
  }

  taskEnded(taskEventId: string): void {
    const root = this.rootStateOf(taskEventId);
    if (!root) {
      // Its root was pruned or evicted, or the start was never recorded.
      this.logger.debug({ taskEventId }, 'turn activity: end of a task with no known root');
      return;
    }
    root.runningTaskIds.delete(taskEventId);
    root.runningCoordinatorTaskIds.delete(taskEventId);
    if (root.autoRegistered) {
      root.lastActivityAt = Math.max(root.lastActivityAt, this.now());
    } else if (root.runningTaskIds.size === 0) {
      root.endedAt = this.now();
      const held = this.held.get(root.rootId);
      if (held && held.length > 0) {
        // The wake normally runs before its specialist's end is recorded, so a hold still here
        // has no detached work left to wake it: re-run each correction on its handing turn.
        this.held.delete(root.rootId);
        this.logger.info(
          { rootId: root.rootId, held: held.length, inboundEventIds: held.map((h) => h.input.inboundEventId) },
          'turn activity: a root ended with hand-off corrections still held; re-running them on their handing turns',
        );
        for (const h of held) {
          this.recoverHandoff({ from: h.from, targetRootId: root.rootId, input: h.input, reason: 'root_ended' });
        }
      }
    }
  }

  rootOf(taskEventId: string): RootTurn | undefined {
    const root = this.rootStateOf(taskEventId);
    return root ? this.snapshot(root) : undefined;
  }

  /** Register a root for an id that never went through taskStarted (voice sessions, unknown ids). */
  ensureRoot(taskEventId: string, seed: EnsureRootSeed): RootTurn {
    const existing = this.rootStateOf(taskEventId);
    if (existing) return this.snapshot(existing);
    const root = this.createAutoRoot(taskEventId, seed);
    this.enforceCaps();
    return this.snapshot(root);
  }

  /** A new auto-registered root keyed by `rootId`, which also maps to itself. */
  private createAutoRoot(rootId: string, seed: EnsureRootSeed): RootState {
    const now = this.now();
    const root: RootState = {
      rootId,
      conversationId: seed.conversationId,
      channelId: seed.channelId,
      agentId: seed.agentId,
      originatorContactId: seed.originatorContactId,
      originatorResolved: seed.originatorResolved,
      originatorIsSystem: seed.originatorIsSystem,
      audienceOneToOne: false,
      audienceMetadata: null,
      accountId: null,
      requestText: null,
      requestTextClipped: false,
      inboundScanFindings: null,
      originatorAuthenticated: seed.originatorAuthenticated,
      originator: null,
      senderId: null,
      startedAt: now,
      endedAt: null,
      runningTaskIds: new Set(),
      runningCoordinatorTaskIds: new Set(),
      autoRegistered: true,
      taskIds: new Set([rootId]),
      handedTo: new Set(),
      lastActivityAt: now,
      scope: this.scopeFor(seed.conversationId),
      stuckWarned: false,
      rootCapWarned: false,
      invisibleLogged: false,
    };
    this.roots.set(rootId, root);
    this.taskToRoot.set(rootId, rootId);
    return root;
  }

  /**
   * Synchronous check-and-record. No await may be added inside.
   *
   * A target another qualifying root already acted on holds the caller once per (other root,
   * target) pair and records nothing; the re-issued call then proceeds and is recorded.
   *
   * An unresolved originator's actions hold no one, so a stranger cannot stall (or probe)
   * the principal's turns by touching a target first. A system root (originatorIsSystem: no
   * originator, or a system or agent role) still holds others: scheduled jobs carry no person
   * originator and must still be caught. Unresolved roots are themselves still checked.
   */
  checkAndRecord(taskEventId: string, toolName: string, targets: readonly ActionTarget[]): BackstopDecision {
    const mine = this.rootStateOf(taskEventId);
    if (!mine) {
      this.logger.warn({ toolName, taskEventId }, 'turn activity: call from a task with no known root — not checked or recorded');
      return { held: false };
    }
    this.maybePrune(mine);

    const qualifying = new Map<string, RootState>();
    for (const other of this.qualifyingOthers(mine)) {
      if (!other.originatorResolved && !other.originatorIsSystem) continue;
      qualifying.set(other.rootId, other);
    }

    let shown = this.shown.get(mine.rootId);
    const newPairs = new Set<string>();
    const matches: { action: RecordedAction; other: RootTurn; target: ActionTarget }[] = [];
    // Newest first, so a held decision reports the most recent action per (root, target) pair.
    for (let i = this.actions.length - 1; i >= 0; i--) {
      const action = this.actions[i]!;
      const other = qualifying.get(action.rootId);
      if (!other) continue;
      for (const target of targets) {
        // Compare fields, not built keys: this loop runs over every recorded action.
        if (!action.targets.some((t) => t.kind === target.kind && t.value === target.value)) continue;
        const pair = `${other.rootId}|${targetKey(target)}`;
        if (shown?.has(pair) || newPairs.has(pair)) continue;
        newPairs.add(pair);
        matches.push({ action: this.copyAction(action), other: this.snapshot(other), target: { ...target } });
      }
    }

    if (matches.length > 0) {
      if (!shown) {
        shown = new Set();
        this.shown.set(mine.rootId, shown);
      }
      for (const pair of newPairs) shown.add(pair);
      return { held: true, matches };
    }

    return { held: false, actionId: this.recordAction(mine, taskEventId, toolName, targets) };
  }

  /**
   * Record a call without checking it: a human-approved replay, which a hold must not stop,
   * but which later turns must still see. Synchronous, like checkAndRecord.
   */
  recordOnly(taskEventId: string, toolName: string, targets: readonly ActionTarget[]): { held: false; actionId?: string } {
    const mine = this.rootStateOf(taskEventId);
    if (!mine) {
      this.logger.warn({ toolName, taskEventId }, 'turn activity: approved call from a task with no known root — not recorded');
      return { held: false };
    }
    this.maybePrune(mine);
    return { held: false, actionId: this.recordAction(mine, taskEventId, toolName, targets) };
  }

  /**
   * Record what became of a call checkAndRecord let through. A failed call is removed: it
   * did nothing, so it must not hold another turn that still needs to act. An id that is no
   * longer held (pruned or evicted meanwhile) is ignored.
   */
  settle(actionId: string, outcome: 'succeeded' | 'failed' | 'unknown'): void {
    const index = this.actions.findIndex((a) => a.actionId === actionId);
    if (index === -1) {
      this.logger.debug({ actionId, outcome }, 'turn activity: settled an action no longer tracked');
      return;
    }
    if (outcome === 'failed') {
      this.actions.splice(index, 1);
      return;
    }
    this.actions[index]!.outcome = outcome;
  }

  otherRootsInWindow(rootId: string): RootTurn[] {
    const mine = this.roots.get(rootId);
    if (!mine) return [];
    return this.qualifyingOthers(mine).map((r) => this.snapshot(r));
  }

  actionsOf(rootId: string): readonly RecordedAction[] {
    return this.actions.filter((a) => a.rootId === rootId).map((a) => this.copyAction(a));
  }

  /**
   * Whether the root has running work other than its coordinator tasks: a detached specialist
   * whose late result wakes the root. A coordinator task still listed (it releases its lane
   * before its end is recorded) does not count; nor does a root past MAX_RUNNING_ROOT_AGE_MS.
   * Unknown root: false.
   */
  hasDetachedWork(rootId: string): boolean {
    const root = this.roots.get(rootId);
    if (!root) return false;
    const now = this.now();
    const stillRunning = root.autoRegistered ? !this.isStuck(root, now) : this.effectiveEndedAt(root, now) === null;
    if (!stillRunning) return false;
    for (const id of root.runningTaskIds) {
      if (!root.runningCoordinatorTaskIds.has(id)) return true;
    }
    return false;
  }

  /**
   * Hold a hand-off correction for the root's next late-delegation wake, which drains it at
   * turn start (turn-handoff, #2588). At most MAX_HELD_PER_ROOT per root: past that, or for an
   * unknown root, the input is not held, a warning is logged, and false is returned. An input
   * already held (same inboundEventId) is not held twice; that returns true.
   */
  holdForWake(rootId: string, input: InjectableInput, from: RootTurn): boolean {
    if (!this.roots.has(rootId)) {
      this.logger.warn({ rootId, inboundEventId: input.inboundEventId }, 'turn activity: no such root to hold a correction for');
      return false;
    }
    const list = this.held.get(rootId) ?? [];
    if (list.some((held) => held.input.inboundEventId === input.inboundEventId)) return true;
    if (list.length >= MAX_HELD_PER_ROOT) {
      this.logger.warn(
        { rootId, inboundEventId: input.inboundEventId, cap: MAX_HELD_PER_ROOT },
        'turn activity: held corrections for this root are at the cap; this one is not held',
      );
      return false;
    }
    list.push({ input, from });
    this.held.set(rootId, list);
    return true;
  }

  /** Every correction held for the root, oldest first; the root's hold is then empty. */
  takeHeldForWake(rootId: string): HeldCorrection[] {
    const list = this.held.get(rootId);
    if (!list) return [];
    this.held.delete(rootId);
    return list;
  }

  /** How many corrections are held for the root's wake. */
  heldCount(rootId: string): number {
    return this.held.get(rootId)?.length ?? 0;
  }

  /**
   * Record that the root of `fromTaskEventId` passed its message to `targetRootId` (delivered,
   * queued or held). Kept for the handing root's life, across every coordinator and wake of
   * the target: a lane forgets what it drained when it is released, so a repeated hand-off
   * would otherwise reach the target's next coordinator or wake a second time. An unknown
   * handing task or target is ignored.
   */
  markHandedOff(fromTaskEventId: string, targetRootId: string): void {
    const from = this.rootStateOf(fromTaskEventId);
    if (!from || !this.roots.has(targetRootId)) return;
    from.handedTo.add(targetRootId);
  }

  /** Whether the root of `fromTaskEventId` already passed its message to `targetRootId`. */
  wasHandedOff(fromTaskEventId: string, targetRootId: string): boolean {
    return this.rootStateOf(fromTaskEventId)?.handedTo.has(targetRootId) ?? false;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private recordAction(
    mine: RootState,
    taskEventId: string,
    toolName: string,
    targets: readonly ActionTarget[],
  ): string {
    if (!mine.originatorResolved && !mine.originatorIsSystem && !mine.invisibleLogged) {
      mine.invisibleLogged = true;
      this.logger.info(
        { rootId: mine.rootId, taskEventId, toolName },
        "turn activity: recording an unresolved sender's action; actions not visible to other turns",
      );
    }
    const at = this.now();
    this.actionSeq += 1;
    const actionId = `action-${this.actionSeq}`;
    this.actions.push({
      actionId,
      rootId: mine.rootId,
      taskEventId,
      toolName,
      targets: targets.map((t) => ({ ...t })),
      at,
      outcome: 'pending',
    });
    mine.lastActivityAt = at;
    this.enforceRootActionCap(mine);
    this.enforceActionCap();
    return actionId;
  }

  private rootStateOf(taskEventId: string): RootState | undefined {
    const rootId = this.taskToRoot.get(taskEventId);
    return rootId === undefined ? undefined : this.roots.get(rootId);
  }

  /**
   * The root a task continues: its delegation origin, its voice session, the hand-off it
   * forwards, or the task a late-delegation wake resumes.
   *
   * Voice never starts a task of its own, so its session id is never a root until a tool call
   * registers one. A specialist delegated from a call, or an async-offramp task handed off
   * from one, would otherwise become its own `internal` root. When that origin is unknown, an
   * auto root is created for it here, seeded from the origin's channel and conversation and
   * the task's copied originator, so every task of one call shares one root.
   */
  private resolveExistingRoot(input: TaskStartInput): RootState | undefined {
    const metadata = input.metadata;
    const seedFrom = (conversationId: string, channelId: string, agentId: string): EnsureRootSeed => ({
      conversationId,
      channelId,
      agentId,
      originatorContactId: input.originatorContactId,
      originatorResolved: input.originatorResolved,
      originatorIsSystem: input.originatorIsSystem,
      originatorAuthenticated: originatorAuthenticatedOf(metadata),
    });

    const origin = delegationOriginTaskEventId(metadata);
    if (origin !== undefined) {
      return this.rootStateOf(origin) ?? this.createAutoRoot(origin, seedFrom(
        delegationOriginConversationId(metadata) ?? input.conversationId,
        delegationOriginField(metadata, 'channelId') ?? input.channelId,
        delegationOriginAgentId(metadata) ?? COORDINATOR_AGENT_ID,
      ));
    }

    const voiceSessionId = metadataString(metadata, 'sourceVoiceSessionId');
    if (voiceSessionId !== undefined) {
      return this.rootStateOf(voiceSessionId) ?? this.createAutoRoot(voiceSessionId, seedFrom(
        metadataString(metadata, 'sourceVoiceConversationId') ?? voiceSessionId,
        'voice',
        COORDINATOR_AGENT_ID,
      ));
    }

    // The coordinator task that sends a hand-off's unheard result continues the hand-off.
    const forwardOf = metadataString(metadata, 'offrampForwardOf');
    const forwarded = forwardOf === undefined ? undefined : this.rootStateOf(forwardOf);
    if (forwarded) return forwarded;

    if (metadata?.['lateDelegation'] !== undefined && input.parentEventId !== undefined) {
      const root = this.rootStateOf(input.parentEventId);
      if (root) return root;
    }
    if (isDelegatedSpecialistTask(metadata) || metadata?.['lateDelegation'] !== undefined) {
      // A delegation with no origin task id, or a wake whose parent was pruned: it becomes
      // its own root and is compared only from here on.
      this.logger.warn(
        { taskEventId: input.taskEventId },
        'turn activity: a delegated or woken task has no known root; it becomes its own',
      );
    }
    return undefined;
  }

  /**
   * A repeated start for an id that is already a root (or a start after ensureRoot) keeps the
   * existing entry: startedAt, the auto flag and the running set survive. Only fields the entry
   * lacks are filled in.
   */
  private mergeOrCreateRoot(input: TaskStartInput): RootState {
    const existing = this.roots.get(input.taskEventId);
    if (!existing) return this.createRoot(input);
    if (existing.requestText === null) {
      // The text and its clipped flag come from the same stamp.
      existing.requestText = senderTextOf(input.metadata);
      existing.requestTextClipped = senderTextClippedOf(input.metadata);
    }
    existing.inboundScanFindings ??= scanFindingsOf(input.metadata);
    if (existing.originatorContactId === null && input.originatorContactId !== null) {
      // The entry had no originator, so it was classed as system; take the task's.
      existing.originatorContactId = input.originatorContactId;
      existing.originatorIsSystem = input.originatorIsSystem;
      existing.originatorAuthenticated = originatorAuthenticatedOf(input.metadata);
    }
    existing.originator ??= originatorOf(input.metadata);
    existing.senderId ??= nonEmpty(input.senderId);
    existing.accountId ??= nonEmpty(input.accountId);
    if (!existing.originatorResolved && input.originatorContactId === existing.originatorContactId) {
      existing.originatorResolved = input.originatorResolved;
    }
    if (!existing.originatorAuthenticated && input.originatorContactId === existing.originatorContactId) {
      // The root task's own stamp: an entry seeded earlier (ensureRoot) may not have carried it.
      existing.originatorAuthenticated = originatorAuthenticatedOf(input.metadata);
    }
    return existing;
  }

  private createRoot(input: TaskStartInput): RootState {
    const originator = originatorOf(input.metadata);
    const root: RootState = {
      rootId: input.taskEventId,
      conversationId: input.conversationId,
      channelId: input.channelId,
      agentId: input.agentId,
      originatorContactId: input.originatorContactId,
      originatorResolved: input.originatorResolved,
      originatorIsSystem: input.originatorIsSystem,
      audienceOneToOne: isOneToOneAudience(input.channelId, input.conversationId, input.metadata, this.selfEmails),
      audienceMetadata: frozenAudienceMetadataOf(input.metadata),
      accountId: nonEmpty(input.accountId),
      requestText: senderTextOf(input.metadata),
      requestTextClipped: senderTextClippedOf(input.metadata),
      inboundScanFindings: scanFindingsOf(input.metadata),
      originatorAuthenticated: originatorAuthenticatedOf(input.metadata),
      originator,
      senderId: nonEmpty(input.senderId),
      startedAt: input.startedAt,
      endedAt: null,
      runningTaskIds: new Set(),
      runningCoordinatorTaskIds: new Set(),
      autoRegistered: false,
      taskIds: new Set(),
      handedTo: new Set(),
      lastActivityAt: input.startedAt,
      scope: this.scopeFor(input.conversationId),
      stuckWarned: false,
      rootCapWarned: false,
      invisibleLogged: false,
    };
    this.roots.set(root.rootId, root);
    return root;
  }

  /** The caller's scope function, fail-open: a throw logs and yields the shared (undefined) scope. */
  private scopeFor(conversationId: string): string | undefined {
    if (!this.scopeOf) return undefined;
    try {
      return this.scopeOf(conversationId);
    } catch (err) {
      // The class only: the message could quote the conversation id (a phone number on Signal).
      this.logger.warn(
        { errName: err instanceof Error ? err.name : typeof err },
        'turn activity: scope function threw; the root joins the shared scope',
      );
      return undefined;
    }
  }

  /**
   * Other roots in my scope whose activity reaches into my window. An auto root never ends,
   * so it counts only while its last activity is inside the window; a running root past
   * MAX_RUNNING_ROOT_AGE_MS counts as ended at that age.
   *
   * A root in my own conversation that ended before I started does not count: its work was
   * in this conversation's history when I read it, so a follow-up there is not held by it.
   * One still running counts (an earlier turn whose detached specialist is still booking), and
   * so does one that ended after I started: it may have finished while my model call was in
   * flight, so my model never saw it. Auto roots never end (no task marks them done), so they
   * count by activity whatever their conversation.
   */
  private qualifyingOthers(mine: RootState): RootState[] {
    const now = this.now();
    const floor = mine.startedAt - TURN_ACTIVITY_WINDOW_MS;
    const result: RootState[] = [];
    for (const other of this.roots.values()) {
      if (other.rootId === mine.rootId) continue;
      if (other.scope !== mine.scope) continue;
      if (other.autoRegistered) {
        if (other.lastActivityAt >= floor) result.push(other);
        continue;
      }
      const ended = this.effectiveEndedAt(other, now);
      if (ended !== null && ended < mine.startedAt && other.conversationId === mine.conversationId) continue;
      if (ended === null || ended >= floor) result.push(other);
    }
    return result;
  }

  /** Running past MAX_RUNNING_ROOT_AGE_MS: its end was almost certainly lost. Warned once. */
  private isStuck(root: RootState, now: number): boolean {
    const running = root.autoRegistered ? root.runningTaskIds.size > 0 : root.endedAt === null;
    const since = root.autoRegistered ? root.lastActivityAt : root.startedAt;
    if (!running || now - since <= MAX_RUNNING_ROOT_AGE_MS) return false;
    if (!root.stuckWarned) {
      root.stuckWarned = true;
      this.logger.warn(
        { rootId: root.rootId, runningTasks: root.runningTaskIds.size, ageMs: now - since },
        'turn activity: a root has been running past the maximum age; treating it as ended',
      );
    }
    return true;
  }

  /** When a non-auto root ended, counting a stuck one as ended at the maximum age. */
  private effectiveEndedAt(root: RootState, now: number): number | null {
    if (root.endedAt !== null) return root.endedAt;
    return this.isStuck(root, now) ? root.startedAt + MAX_RUNNING_ROOT_AGE_MS : null;
  }

  /**
   * A live turn: a non-auto root not (effectively) ended, or an auto root with a task running
   * or activity inside the window. Losing a live root's actions degrades the backstop.
   */
  private isLive(root: RootState, now: number): boolean {
    if (!root.autoRegistered) return this.effectiveEndedAt(root, now) === null;
    if (this.isStuck(root, now)) return false;
    return root.runningTaskIds.size > 0 || root.lastActivityAt >= now - TURN_ACTIVITY_WINDOW_MS;
  }

  private snapshot(root: RootState): RootTurn {
    return Object.freeze({
      rootId: root.rootId,
      conversationId: root.conversationId,
      channelId: root.channelId,
      agentId: root.agentId,
      originatorContactId: root.originatorContactId,
      originatorResolved: root.originatorResolved,
      originatorIsSystem: root.originatorIsSystem,
      audienceOneToOne: root.audienceOneToOne,
      audienceMetadata: root.audienceMetadata,
      accountId: root.accountId,
      requestText: root.requestText,
      requestTextClipped: root.requestTextClipped,
      inboundScanFindings: root.inboundScanFindings,
      originatorAuthenticated: root.originatorAuthenticated,
      originator: root.originator,
      senderId: root.senderId,
      startedAt: root.startedAt,
      endedAt: root.endedAt,
      runningTaskIds: new Set(root.runningTaskIds),
      runningCoordinatorTaskId: [...root.runningCoordinatorTaskIds].pop() ?? null,
      autoRegistered: root.autoRegistered,
    });
  }

  private copyAction(action: RecordedAction): RecordedAction {
    return Object.freeze({ ...action, targets: action.targets.map((t) => ({ ...t })) });
  }

  /** A root that can be dropped without losing a live turn. */
  private isEvictable(root: RootState, now: number): boolean {
    return !this.isLive(root, now);
  }

  private evictionAge(root: RootState): number {
    return root.endedAt ?? root.lastActivityAt;
  }

  private dropRoot(root: RootState): void {
    this.roots.delete(root.rootId);
    for (const id of root.taskIds) this.taskToRoot.delete(id);
    this.shown.delete(root.rootId);
    for (const other of this.roots.values()) other.handedTo.delete(root.rootId);
    const held = this.held.get(root.rootId);
    if (held) {
      this.held.delete(root.rootId);
      // No wake came for them: re-run each on its handing turn.
      this.logger.warn(
        { rootId: root.rootId, held: held.length, inboundEventIds: held.map((h) => h.input.inboundEventId) },
        'turn activity: dropped a root with hand-off corrections still held; re-running them on their handing turns',
      );
      for (const h of held) {
        this.recoverHandoff({ from: h.from, targetRootId: root.rootId, input: h.input, reason: 'root_dropped' });
      }
    }
  }

  /** checkAndRecord's cheap prune: every PRUNE_EVERY_CALLS calls or PRUNE_INTERVAL_MS. */
  private maybePrune(keep: RootState): void {
    this.callsSincePrune += 1;
    if (this.callsSincePrune < PRUNE_EVERY_CALLS && this.now() - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.prune(keep);
  }

  /**
   * Drop roots no live turn can still see, with their actions and shown sets. `keep` (the
   * caller's own root) is never dropped, even when its last activity is old.
   *
   * A live turn looks back a window from its own start (qualifyingOthers), so one cutoff
   * serves both kinds of root: the oldest live start, less a window. An ended root is kept
   * while it ended after that cutoff; an auto root (which never ends) while its last activity
   * is after it, or while it still has a task running and is not stuck. An expired auto root
   * (not live: idle a window, or stuck) does not hold the cutoff back.
   */
  private prune(keep?: RootState): void {
    const now = this.now();
    this.lastPruneAt = now;
    this.callsSincePrune = 0;
    let oldestLiveStart = now;
    for (const root of this.roots.values()) {
      if ((root === keep || this.isLive(root, now)) && root.startedAt < oldestLiveStart) oldestLiveStart = root.startedAt;
    }
    const cutoff = oldestLiveStart - TURN_ACTIVITY_WINDOW_MS;
    for (const root of [...this.roots.values()]) {
      if (root === keep) continue;
      if (root.autoRegistered) {
        if (root.lastActivityAt >= cutoff) continue;
        if (root.runningTaskIds.size === 0 || this.isStuck(root, now)) this.dropRoot(root);
        continue;
      }
      const ended = this.effectiveEndedAt(root, now);
      if (ended !== null && ended < cutoff) this.dropRoot(root);
    }
    this.dropOrphanActions();
  }

  private dropOrphanActions(): void {
    this.actions = this.actions.filter((a) => this.roots.has(a.rootId));
  }

  private enforceCaps(): void {
    if (this.roots.size > MAX_TRACKED_ROOTS) {
      let evicted = 0;
      const now = this.now();
      const candidates = [...this.roots.values()]
        .filter((r) => this.isEvictable(r, now))
        .sort((a, b) => this.evictionAge(a) - this.evictionAge(b));
      for (const root of candidates) {
        if (this.roots.size <= MAX_TRACKED_ROOTS) break;
        this.dropRoot(root);
        evicted++;
      }
      this.dropOrphanActions();
      if (evicted > 0) {
        this.logger.warn({ evicted, cap: MAX_TRACKED_ROOTS }, 'turn activity: evicted oldest ended roots over the cap');
      }
      if (this.roots.size > MAX_TRACKED_ROOTS) {
        // Every remaining root is live. Keep them (dropping one would lose a running turn), but say so.
        this.logger.warn(
          { size: this.roots.size, cap: MAX_TRACKED_ROOTS },
          'turn activity: more live roots than the cap and nothing evictable',
        );
      }
    }
    this.enforceActionCap();
  }

  /**
   * Past the per-root cap, a root drops its own oldest action. It never evicts another root's.
   * The first drop per root is logged: that root's earliest actions no longer hold anyone.
   */
  private enforceRootActionCap(root: RootState): void {
    let count = 0;
    let oldest = -1;
    for (let i = 0; i < this.actions.length; i++) {
      if (this.actions[i]!.rootId !== root.rootId) continue;
      if (oldest === -1) oldest = i;
      count++;
    }
    if (count <= MAX_ACTIONS_PER_ROOT) return;
    this.actions.splice(oldest, 1);
    if (!root.rootCapWarned) {
      root.rootCapWarned = true;
      this.logger.warn(
        { rootId: root.rootId, cap: MAX_ACTIONS_PER_ROOT },
        "turn activity: a root passed its action cap; its oldest actions are being dropped",
      );
    }
  }

  /**
   * Global cap. Actions of ended roots go first, oldest first. Only if that is not enough do
   * live roots lose actions, and that is logged at error: the backstop is degraded.
   */
  private enforceActionCap(): void {
    const excess = this.actions.length - MAX_TRACKED_ACTIONS;
    if (excess <= 0) return;
    const drop = new Set<RecordedAction>();
    const now = this.now();
    for (const a of this.actions) {
      if (drop.size >= excess) break;
      const root = this.roots.get(a.rootId);
      if (root && this.isEvictable(root, now)) drop.add(a);
    }
    const fromEnded = drop.size;
    for (const a of this.actions) {
      if (drop.size >= excess) break;
      drop.add(a);
    }
    this.actions = this.actions.filter((a) => !drop.has(a));
    if (drop.size > fromEnded) {
      this.logger.error(
        { evicted: drop.size, evictedFromEnded: fromEnded, evictedFromLive: drop.size - fromEnded, cap: MAX_TRACKED_ACTIONS },
        'turn activity: evicted actions of live roots over the cap; the backstop is degraded',
      );
    } else {
      this.logger.warn({ evicted: drop.size, cap: MAX_TRACKED_ACTIONS }, 'turn activity: evicted oldest actions over the cap');
    }
  }
}
