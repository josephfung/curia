// Turn activity registry (#2588). One in-process record of "which root turns are running or
// recently finished, and which risky actions (with targets) each has taken".
//
// A "root" is the turn a person started: the root task, plus every delegated specialist and
// late-delegation wake that continues it. Two roots that act on the same target (a contact, a
// site, an id, a tool) within the window are worth a pause: the second caller is held once and
// told what the first did, then may re-issue. The roots are usually in different
// conversations. In the same conversation, only a root still running counts (an earlier turn
// whose detached specialist is still working); an ended one is already in that history.
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
} from '../agents/delegated-task-context.js';
import type { Logger } from '../logger.js';
import { stripOutboundContextPreamble } from './outbound-context.js';

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
/** checkAndRecord prunes at most this often: every N calls, or after this long. */
const PRUNE_EVERY_CALLS = 50;
const PRUNE_INTERVAL_MS = 60_000;

const REQUEST_TEXT_MAX_CODE_POINTS = 500;
const COORDINATOR_AGENT_ID = 'coordinator';

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
  /** Filled in by a later task; false until then. */
  audienceOneToOne: boolean;
  /** The person's words, preamble stripped, clipped to 500 code points. */
  requestText: string | null;
  /** Injection-scan finding count of the root's inbound; null = unknown. */
  inboundScanFindings: number | null;
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
  metadata: Record<string, unknown> | undefined;
  content: string;
  startedAt: number;
  originatorContactId: string | null;
  originatorResolved: boolean;
  /** turn-lanes.ts originatorIsSystem of the task's copied originator. */
  originatorIsSystem: boolean;
  /** Finding count for a root's inbound. Defaults to null (unknown). */
  inboundScanFindings?: number | null;
}

export interface EnsureRootSeed {
  conversationId: string;
  channelId: string;
  agentId: string;
  originatorContactId: string | null;
  originatorResolved: boolean;
  originatorIsSystem: boolean;
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
  requestText: string | null;
  inboundScanFindings: number | null;
  startedAt: number;
  endedAt: number | null;
  runningTaskIds: Set<string>;
  /** Coordinator tasks now running under the root, in start order. */
  runningCoordinatorTaskIds: Set<string>;
  autoRegistered: boolean;
  /** Every task id mapped to this root, so eviction can drop them. */
  taskIds: Set<string>;
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

  private readonly scopeOf: ((conversationId: string) => string | undefined) | undefined;
  /** checkAndRecord calls since the last prune, and when that prune ran. */
  private callsSincePrune = 0;
  private lastPruneAt: number;

  constructor(opts: TurnActivityRegistryOptions) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.scopeOf = opts.scopeOf;
    this.lastPruneAt = this.now();
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
      requestText: null,
      inboundScanFindings: null,
      startedAt: now,
      endedAt: null,
      runningTaskIds: new Set(),
      runningCoordinatorTaskIds: new Set(),
      autoRegistered: true,
      taskIds: new Set([rootId]),
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
    existing.requestText ??= this.requestTextOf(input.content);
    existing.inboundScanFindings ??= input.inboundScanFindings ?? null;
    if (existing.originatorContactId === null && input.originatorContactId !== null) {
      // The entry had no originator, so it was classed as system; take the task's.
      existing.originatorContactId = input.originatorContactId;
      existing.originatorIsSystem = input.originatorIsSystem;
    }
    if (!existing.originatorResolved && input.originatorContactId === existing.originatorContactId) {
      existing.originatorResolved = input.originatorResolved;
    }
    return existing;
  }

  private requestTextOf(content: string): string {
    return Array.from(stripOutboundContextPreamble(content)).slice(0, REQUEST_TEXT_MAX_CODE_POINTS).join('');
  }

  private createRoot(input: TaskStartInput): RootState {
    const root: RootState = {
      rootId: input.taskEventId,
      conversationId: input.conversationId,
      channelId: input.channelId,
      agentId: input.agentId,
      originatorContactId: input.originatorContactId,
      originatorResolved: input.originatorResolved,
      originatorIsSystem: input.originatorIsSystem,
      audienceOneToOne: false,
      requestText: this.requestTextOf(input.content),
      inboundScanFindings: input.inboundScanFindings ?? null,
      startedAt: input.startedAt,
      endedAt: null,
      runningTaskIds: new Set(),
      runningCoordinatorTaskIds: new Set(),
      autoRegistered: false,
      taskIds: new Set(),
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
      this.logger.warn({ err }, 'turn activity: scope function threw; the root joins the shared scope');
      return undefined;
    }
  }

  /**
   * Other roots in my scope whose activity reaches into my window. An auto root never ends,
   * so it counts only while its last activity is inside the window; a running root past
   * MAX_RUNNING_ROOT_AGE_MS counts as ended at that age.
   *
   * An ended root in my own conversation does not count: its work is in this conversation's
   * history already, so a follow-up there is not held by it. One still running does count,
   * e.g. an earlier turn whose detached specialist is still booking. Auto roots never end
   * (no task marks them done), so they count by activity whatever their conversation.
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
      if (ended !== null && other.conversationId === mine.conversationId) continue;
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
      requestText: root.requestText,
      inboundScanFindings: root.inboundScanFindings,
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
  }

  /** checkAndRecord's cheap prune: every PRUNE_EVERY_CALLS calls or PRUNE_INTERVAL_MS. */
  private maybePrune(keep: RootState): void {
    this.callsSincePrune += 1;
    if (this.callsSincePrune < PRUNE_EVERY_CALLS && this.now() - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.prune(keep);
  }

  /**
   * Drop ended roots older than the window, with their actions and shown sets. `keep` (the
   * caller's own root) is never dropped, even when its last activity is old.
   */
  private prune(keep?: RootState): void {
    const now = this.now();
    this.lastPruneAt = now;
    this.callsSincePrune = 0;
    const autoCutoff = now - TURN_ACTIVITY_WINDOW_MS;
    // Stale auto-registered roots go first so they do not hold the cutoff back.
    for (const root of [...this.roots.values()]) {
      if (root === keep || !root.autoRegistered || root.lastActivityAt >= autoCutoff) continue;
      if (root.runningTaskIds.size === 0 || this.isStuck(root, now)) this.dropRoot(root);
    }
    // A live root (auto-registered or not) still looks back a window from its own start.
    let oldestRunningStart = now;
    for (const root of this.roots.values()) {
      const running = root.autoRegistered ? !this.isStuck(root, now) : this.effectiveEndedAt(root, now) === null;
      if (running && root.startedAt < oldestRunningStart) oldestRunningStart = root.startedAt;
    }
    const endedCutoff = oldestRunningStart - TURN_ACTIVITY_WINDOW_MS;
    for (const root of [...this.roots.values()]) {
      if (root === keep || root.autoRegistered) continue;
      const ended = this.effectiveEndedAt(root, now);
      if (ended !== null && ended < endedCutoff) this.dropRoot(root);
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
