// Turn activity registry (#2588). One in-process record of "which root turns are running or
// recently finished, and which risky actions (with targets) each has taken".
//
// A "root" is the turn a person started: the root task, plus every delegated specialist and
// late-delegation wake that continues it. Two roots in different conversations that act on
// the same target (a contact, a site, an id, a tool) within the window are worth a pause: the
// second caller is held once and told what the first did, then may re-issue.
//
// Single process (ADR-053 section 7). The maps live in this process; a second Curia would not
// see this one's turns. The registry fails open: an unknown task id, a pruned parent, or an
// evicted root yields no hold rather than an error.
//
// taskStarted, taskEnded, ensureRoot and checkAndRecord are synchronous. There must be no
// await inside checkAndRecord: the check and the record have to be one atomic step, or two
// roots could each see an empty registry and both proceed.
//
// Public getters return copies, so a caller cannot mutate registry state.

import { delegationOriginTaskEventId, isDelegatedSpecialistTask } from '../agents/delegated-task-context.js';
import type { Logger } from '../logger.js';
import { stripOutboundContextPreamble } from './outbound-context.js';

export const TURN_ACTIVITY_WINDOW_MS = 15 * 60_000;
export const MAX_TRACKED_ROOTS = 1_000;
export const MAX_TRACKED_ACTIONS = 5_000;

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

export interface RecordedAction {
  rootId: string;
  taskEventId: string;
  toolName: string;
  targets: readonly ActionTarget[];
  at: number;
}

export type BackstopDecision =
  | { held: false }
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
  /** Finding count for a root's inbound. Defaults to null (unknown). */
  inboundScanFindings?: number | null;
}

export interface EnsureRootSeed {
  conversationId: string;
  channelId: string;
  agentId: string;
  originatorContactId: string | null;
  originatorResolved: boolean;
}

/** Mutable internal form of a root. Never handed out. */
interface RootState {
  rootId: string;
  conversationId: string;
  channelId: string;
  agentId: string;
  originatorContactId: string | null;
  originatorResolved: boolean;
  audienceOneToOne: boolean;
  requestText: string | null;
  inboundScanFindings: number | null;
  startedAt: number;
  endedAt: number | null;
  runningTaskIds: Set<string>;
  runningCoordinatorTaskId: string | null;
  autoRegistered: boolean;
  /** Every task id mapped to this root, so eviction can drop them. */
  taskIds: Set<string>;
  /** Last action time; an auto-registered root is pruned a window after it. */
  lastActivityAt: number;
}

function targetKey(target: ActionTarget): string {
  return `${target.kind}:${target.value}`;
}

export class TurnActivityRegistry {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly roots = new Map<string, RootState>();
  private readonly taskToRoot = new Map<string, string>();
  private actions: RecordedAction[] = [];
  /** rootId -> keys of `${otherRootId}|${kind}:${value}` already shown to that root. */
  private readonly shown = new Map<string, Set<string>>();

  constructor(opts: { logger: Logger; now?: () => number }) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  /** Register a task under its root and return that root. */
  taskStarted(input: TaskStartInput): RootTurn {
    this.prune();

    const root = this.resolveExistingRoot(input) ?? this.createRoot(input);
    root.runningTaskIds.add(input.taskEventId);
    root.taskIds.add(input.taskEventId);
    root.endedAt = null;
    this.taskToRoot.set(input.taskEventId, root.rootId);
    if (input.agentId === COORDINATOR_AGENT_ID && !isDelegatedSpecialistTask(input.metadata)) {
      root.runningCoordinatorTaskId = input.taskEventId;
    }

    this.enforceCaps();
    return this.snapshot(root);
  }

  taskEnded(taskEventId: string): void {
    const root = this.rootStateOf(taskEventId);
    if (!root) return;
    root.runningTaskIds.delete(taskEventId);
    if (root.runningCoordinatorTaskId === taskEventId) root.runningCoordinatorTaskId = null;
    if (root.runningTaskIds.size === 0 && !root.autoRegistered) root.endedAt = this.now();
  }

  rootOf(taskEventId: string): RootTurn | undefined {
    const root = this.rootStateOf(taskEventId);
    return root ? this.snapshot(root) : undefined;
  }

  /** Register a root for an id that never went through taskStarted (voice sessions, unknown ids). */
  ensureRoot(taskEventId: string, seed: EnsureRootSeed): RootTurn {
    const existing = this.rootStateOf(taskEventId);
    if (existing) return this.snapshot(existing);
    const now = this.now();
    const root: RootState = {
      rootId: taskEventId,
      conversationId: seed.conversationId,
      channelId: seed.channelId,
      agentId: seed.agentId,
      originatorContactId: seed.originatorContactId,
      originatorResolved: seed.originatorResolved,
      audienceOneToOne: false,
      requestText: null,
      inboundScanFindings: null,
      startedAt: now,
      endedAt: null,
      runningTaskIds: new Set(),
      runningCoordinatorTaskId: null,
      autoRegistered: true,
      taskIds: new Set([taskEventId]),
      lastActivityAt: now,
    };
    this.roots.set(taskEventId, root);
    this.taskToRoot.set(taskEventId, taskEventId);
    this.enforceCaps();
    return this.snapshot(root);
  }

  /**
   * Synchronous check-and-record. No await may be added inside.
   *
   * A target another qualifying root already acted on holds the caller once per (other root,
   * target) pair and records nothing; the re-issued call then proceeds and is recorded.
   */
  checkAndRecord(taskEventId: string, toolName: string, targets: readonly ActionTarget[]): BackstopDecision {
    const mine = this.rootStateOf(taskEventId);
    if (!mine) return { held: false };

    const qualifying = new Map<string, RootState>();
    for (const other of this.qualifyingOthers(mine)) qualifying.set(other.rootId, other);

    let shown = this.shown.get(mine.rootId);
    const newPairs = new Set<string>();
    const matches: { action: RecordedAction; other: RootTurn; target: ActionTarget }[] = [];
    for (const action of this.actions) {
      const other = qualifying.get(action.rootId);
      if (!other) continue;
      for (const target of targets) {
        const key = targetKey(target);
        if (!action.targets.some((t) => targetKey(t) === key)) continue;
        const pair = `${other.rootId}|${key}`;
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

    const at = this.now();
    this.actions.push({
      rootId: mine.rootId,
      taskEventId,
      toolName,
      targets: targets.map((t) => ({ ...t })),
      at,
    });
    mine.lastActivityAt = at;
    return { held: false };
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

  private rootStateOf(taskEventId: string): RootState | undefined {
    const rootId = this.taskToRoot.get(taskEventId);
    return rootId === undefined ? undefined : this.roots.get(rootId);
  }

  /** The root an existing task's delegation or wake points to, if that root is still known. */
  private resolveExistingRoot(input: TaskStartInput): RootState | undefined {
    const origin = delegationOriginTaskEventId(input.metadata);
    if (origin !== undefined) {
      const root = this.rootStateOf(origin);
      if (root) return root;
    }
    if (input.metadata?.['lateDelegation'] !== undefined && input.parentEventId !== undefined) {
      return this.rootStateOf(input.parentEventId);
    }
    return undefined;
  }

  private createRoot(input: TaskStartInput): RootState {
    const root: RootState = {
      rootId: input.taskEventId,
      conversationId: input.conversationId,
      channelId: input.channelId,
      agentId: input.agentId,
      originatorContactId: input.originatorContactId,
      originatorResolved: input.originatorResolved,
      audienceOneToOne: false,
      requestText: Array.from(stripOutboundContextPreamble(input.content))
        .slice(0, REQUEST_TEXT_MAX_CODE_POINTS)
        .join(''),
      inboundScanFindings: input.inboundScanFindings ?? null,
      startedAt: input.startedAt,
      endedAt: null,
      runningTaskIds: new Set(),
      runningCoordinatorTaskId: null,
      autoRegistered: false,
      taskIds: new Set(),
      lastActivityAt: input.startedAt,
    };
    this.roots.set(root.rootId, root);
    return root;
  }

  private qualifyingOthers(mine: RootState): RootState[] {
    const floor = mine.startedAt - TURN_ACTIVITY_WINDOW_MS;
    const result: RootState[] = [];
    for (const other of this.roots.values()) {
      if (other.rootId === mine.rootId) continue;
      if (other.endedAt === null || other.endedAt >= floor) result.push(other);
    }
    return result;
  }

  private snapshot(root: RootState): RootTurn {
    return Object.freeze({
      rootId: root.rootId,
      conversationId: root.conversationId,
      channelId: root.channelId,
      agentId: root.agentId,
      originatorContactId: root.originatorContactId,
      originatorResolved: root.originatorResolved,
      audienceOneToOne: root.audienceOneToOne,
      requestText: root.requestText,
      inboundScanFindings: root.inboundScanFindings,
      startedAt: root.startedAt,
      endedAt: root.endedAt,
      runningTaskIds: new Set(root.runningTaskIds),
      runningCoordinatorTaskId: root.runningCoordinatorTaskId,
      autoRegistered: root.autoRegistered,
    });
  }

  private copyAction(action: RecordedAction): RecordedAction {
    return Object.freeze({ ...action, targets: action.targets.map((t) => ({ ...t })) });
  }

  /** A root that can be dropped without losing a live turn. */
  private isEvictable(root: RootState): boolean {
    return root.endedAt !== null || (root.autoRegistered && root.runningTaskIds.size === 0);
  }

  private evictionAge(root: RootState): number {
    return root.endedAt ?? root.lastActivityAt;
  }

  private dropRoot(root: RootState): void {
    this.roots.delete(root.rootId);
    for (const id of root.taskIds) this.taskToRoot.delete(id);
    this.shown.delete(root.rootId);
  }

  /** Drop ended roots older than the window, with their actions and shown sets. */
  private prune(): void {
    const now = this.now();
    let oldestRunningStart = now;
    for (const root of this.roots.values()) {
      if (!root.autoRegistered && root.endedAt === null && root.startedAt < oldestRunningStart) {
        oldestRunningStart = root.startedAt;
      }
    }
    const endedCutoff = oldestRunningStart - TURN_ACTIVITY_WINDOW_MS;
    const autoCutoff = now - TURN_ACTIVITY_WINDOW_MS;
    for (const root of [...this.roots.values()]) {
      const stale = root.autoRegistered
        ? root.runningTaskIds.size === 0 && root.lastActivityAt < autoCutoff
        : root.endedAt !== null && root.endedAt < endedCutoff;
      if (stale) this.dropRoot(root);
    }
    this.dropOrphanActions();
  }

  private dropOrphanActions(): void {
    this.actions = this.actions.filter((a) => this.roots.has(a.rootId));
  }

  private enforceCaps(): void {
    let evicted = 0;
    if (this.roots.size > MAX_TRACKED_ROOTS) {
      const candidates = [...this.roots.values()]
        .filter((r) => this.isEvictable(r))
        .sort((a, b) => this.evictionAge(a) - this.evictionAge(b));
      for (const root of candidates) {
        if (this.roots.size <= MAX_TRACKED_ROOTS) break;
        this.dropRoot(root);
        evicted++;
      }
      this.dropOrphanActions();
    }
    if (evicted > 0) {
      this.logger.warn({ evicted, cap: MAX_TRACKED_ROOTS }, 'turn activity: evicted oldest ended roots over the cap');
    }

    if (this.actions.length > MAX_TRACKED_ACTIONS) {
      const excess = this.actions.length - MAX_TRACKED_ACTIONS;
      // Oldest first. Actions of ended roots go before those of running roots.
      const ended = this.actions.filter((a) => {
        const root = this.roots.get(a.rootId);
        return root !== undefined && this.isEvictable(root);
      });
      const drop = new Set<RecordedAction>(ended.slice(0, excess));
      if (drop.size < excess) {
        for (const a of this.actions) {
          if (drop.size >= excess) break;
          drop.add(a);
        }
      }
      this.actions = this.actions.filter((a) => !drop.has(a));
      this.logger.warn({ evicted: drop.size, cap: MAX_TRACKED_ACTIONS }, 'turn activity: evicted oldest actions over the cap');
    }
  }
}
