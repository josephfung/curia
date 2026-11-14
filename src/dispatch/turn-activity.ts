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
/** One root cannot crowd out another's actions: past this, its own oldest action is dropped. */
export const MAX_ACTIONS_PER_ROOT = 200;

/**
 * Channels whose turns are Curia's own work (scheduled jobs, internal tasks, the bullpen).
 * Their actions hold others whatever the originator stamp says, and they see a hold's details.
 */
export const SYSTEM_TURN_CHANNELS: ReadonlySet<string> = new Set(['scheduler', 'internal', 'bullpen']);

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

export class TurnActivityRegistry {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly roots = new Map<string, RootState>();
  private readonly taskToRoot = new Map<string, string>();
  private actions: RecordedAction[] = [];
  /** rootId -> keys of `${otherRootId}|${kind}:${value}` already shown to that root. */
  private readonly shown = new Map<string, Set<string>>();

  private readonly scopeOf: ((conversationId: string) => string | undefined) | undefined;

  constructor(opts: TurnActivityRegistryOptions) {
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.scopeOf = opts.scopeOf;
  }

  /** Register a task under its root and return that root. */
  taskStarted(input: TaskStartInput): RootTurn {
    this.prune();

    const root = this.resolveExistingRoot(input) ?? this.mergeOrCreateRoot(input);
    root.runningTaskIds.add(input.taskEventId);
    root.taskIds.add(input.taskEventId);
    root.endedAt = null;
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
    if (!root) return;
    root.runningTaskIds.delete(taskEventId);
    root.runningCoordinatorTaskIds.delete(taskEventId);
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
      runningCoordinatorTaskIds: new Set(),
      autoRegistered: true,
      taskIds: new Set([taskEventId]),
      lastActivityAt: now,
      scope: this.scopeFor(seed.conversationId),
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
   *
   * An unresolved originator's actions hold no one, so a stranger cannot stall (or probe)
   * the principal's turns by touching a target first. A system-channel root
   * (SYSTEM_TURN_CHANNELS) still holds others: scheduled jobs carry no person originator
   * and must still be caught. Unresolved roots are themselves still checked.
   */
  checkAndRecord(taskEventId: string, toolName: string, targets: readonly ActionTarget[]): BackstopDecision {
    const mine = this.rootStateOf(taskEventId);
    if (!mine) return { held: false };

    const qualifying = new Map<string, RootState>();
    for (const other of this.qualifyingOthers(mine)) {
      if (!other.originatorResolved && !SYSTEM_TURN_CHANNELS.has(other.channelId)) continue;
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

    const at = this.now();
    this.actions.push({
      rootId: mine.rootId,
      taskEventId,
      toolName,
      targets: targets.map((t) => ({ ...t })),
      at,
    });
    mine.lastActivityAt = at;
    this.enforceRootActionCap(mine.rootId);
    this.enforceActionCap();
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
    existing.originatorContactId ??= input.originatorContactId;
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

  private qualifyingOthers(mine: RootState): RootState[] {
    const floor = mine.startedAt - TURN_ACTIVITY_WINDOW_MS;
    const result: RootState[] = [];
    for (const other of this.roots.values()) {
      if (other.rootId === mine.rootId) continue;
      if (other.scope !== mine.scope) continue;
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
      runningCoordinatorTaskId: [...root.runningCoordinatorTaskIds].pop() ?? null,
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
    const autoCutoff = now - TURN_ACTIVITY_WINDOW_MS;
    // Stale auto-registered roots go first so they do not hold the cutoff back.
    for (const root of [...this.roots.values()]) {
      if (root.autoRegistered && root.runningTaskIds.size === 0 && root.lastActivityAt < autoCutoff) {
        this.dropRoot(root);
      }
    }
    // A live root (auto-registered or not) still looks back a window from its own start.
    let oldestRunningStart = now;
    for (const root of this.roots.values()) {
      if (root.endedAt === null && root.startedAt < oldestRunningStart) oldestRunningStart = root.startedAt;
    }
    const endedCutoff = oldestRunningStart - TURN_ACTIVITY_WINDOW_MS;
    for (const root of [...this.roots.values()]) {
      if (!root.autoRegistered && root.endedAt !== null && root.endedAt < endedCutoff) this.dropRoot(root);
    }
    this.dropOrphanActions();
  }

  private dropOrphanActions(): void {
    this.actions = this.actions.filter((a) => this.roots.has(a.rootId));
  }

  private enforceCaps(): void {
    if (this.roots.size > MAX_TRACKED_ROOTS) {
      let evicted = 0;
      const candidates = [...this.roots.values()]
        .filter((r) => this.isEvictable(r))
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

  /** Past the per-root cap, a root drops its own oldest action. It never evicts another root's. */
  private enforceRootActionCap(rootId: string): void {
    let count = 0;
    let oldest = -1;
    for (let i = 0; i < this.actions.length; i++) {
      if (this.actions[i]!.rootId !== rootId) continue;
      if (oldest === -1) oldest = i;
      count++;
    }
    if (count > MAX_ACTIONS_PER_ROOT) this.actions.splice(oldest, 1);
  }

  /**
   * Global cap. Actions of ended roots go first, oldest first. Only if that is not enough do
   * live roots lose actions, and that is logged at error: the backstop is degraded.
   */
  private enforceActionCap(): void {
    const excess = this.actions.length - MAX_TRACKED_ACTIONS;
    if (excess <= 0) return;
    const drop = new Set<RecordedAction>();
    for (const a of this.actions) {
      if (drop.size >= excess) break;
      const root = this.roots.get(a.rootId);
      if (root && this.isEvictable(root)) drop.add(a);
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
